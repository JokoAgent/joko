import { rmSync } from "node:fs";
import { mkdtempSync } from "./test-paths.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AdapterContext,
  CreateNativeSessionInput,
  PromptInput,
  SessionWorktreeBinding,
  TargetDescriptor
} from "@joko/core";
import { FakeBackendAdapter, PI_LIKE_PROFILE } from "@joko/testkit";
import { OperationalStore, type StoredSession } from "@joko/store";
import { afterEach, describe, expect, it } from "vitest";

import { OperationalArtifactRepository } from "./artifact-repository.js";
import { ArtifactStore } from "./artifact-store.js";
import { ScheduleCoordinator } from "./schedule-coordinator.js";
import {
  SCHEDULED_WORKTREE_OWNER_SETTING_KEY,
  type AcquireSessionWorktreeInput,
  type SessionWorktreeCoordinator
} from "./session-worktree-coordinator.js";
import { SessionHost } from "./session-host.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("scheduled isolated workspaces", () => {
  it("acquires a distinct checkout for every fresh fire and preserves the binding after safe release", async () => {
    const fixture = await createFixture();
    const scheduler = new ScheduleCoordinator(fixture.store, fixture.host);
    fixture.store.upsertSchedule(worktreeSchedule("schedule-unique"));

    const first = await scheduler.runNowWithResult("schedule-unique", "unique-one");
    await eventually(() => fixture.store.getRun(first.runId).descriptor.state === "completed");
    await fixture.host.reconcileScheduledWorktrees();
    const second = await scheduler.runNowWithResult("schedule-unique", "unique-two");
    await eventually(() => fixture.store.getRun(second.runId).descriptor.state === "completed");
    await fixture.host.reconcileScheduledWorktrees();

    expect(new Set(fixture.worktrees.acquisitions.map((entry) => entry.sessionId)).size).toBe(2);
    expect(new Set(fixture.adapter.creationRoots).size).toBe(2);
    expect(fixture.worktrees.acquisitions).toEqual([
      expect.objectContaining({ sourceRef: "refs/heads/main", refreshRemote: true }),
      expect.objectContaining({ sourceRef: "refs/heads/main", refreshRemote: true })
    ]);
    expect(new Set(fixture.worktrees.releases)).toEqual(
      new Set(fixture.worktrees.acquisitions.map((entry) => entry.sessionId))
    );
    const history = fixture.store.listScheduleRuns("schedule-unique");
    expect(new Set(history.map((entry) => entry.sessionId)).size).toBe(2);
    for (const entry of history) {
      expect(fixture.store.getSession(entry.sessionId!).descriptor).toMatchObject({
        archived: true,
        worktree: { state: "preserved" }
      });
    }
    expect(ownerSettings(fixture.store)).toEqual([]);
  });

  it("retains ownership while durable queue or Run work is active, then releases at terminal", async () => {
    const adapter = new GatedSendAdapter();
    const fixture = await createFixture(adapter);
    const scheduler = new ScheduleCoordinator(fixture.store, fixture.host);
    fixture.store.upsertSchedule(worktreeSchedule("schedule-active-owner"));

    const dispatched = await scheduler.runNowWithResult("schedule-active-owner", "active-owner");
    await adapter.entered;
    await fixture.host.reconcileScheduledWorktrees();

    expect(fixture.worktrees.releases).toEqual([]);
    expect(ownerSettings(fixture.store)).toEqual([
      expect.objectContaining({ scopeId: dispatched.sessionId })
    ]);
    expect(fixture.store.getSession(dispatched.sessionId!).descriptor.archived).toBe(false);

    adapter.release();
    await eventually(() => fixture.store.getRun(dispatched.runId).descriptor.state === "completed");
    await fixture.host.reconcileScheduledWorktrees();
    expect(fixture.worktrees.releases).toEqual([dispatched.sessionId]);
    expect(fixture.store.getSession(dispatched.sessionId!).descriptor).toMatchObject({
      archived: true,
      worktree: { state: "preserved" }
    });
  });

  it("compensates a failed native creation without leaving an owner marker or Session", async () => {
    const fixture = await createFixture(new FailingCreateAdapter());
    const scheduler = new ScheduleCoordinator(fixture.store, fixture.host);
    fixture.store.upsertSchedule(worktreeSchedule("schedule-create-failure"));

    await expect(scheduler.runNowWithResult("schedule-create-failure", "create-failure"))
      .rejects.toThrow("previously failed");

    expect(fixture.worktrees.acquisitions).toHaveLength(1);
    expect(fixture.worktrees.releases).toEqual([fixture.worktrees.acquisitions[0]!.sessionId]);
    expect(fixture.store.listSessions({ includeArchived: true, includeDeleted: true })).toEqual([]);
    expect(ownerSettings(fixture.store)).toEqual([]);
    expect(fixture.store.listDiagnostics({ component: "create_scheduled_session" })).toEqual([
      expect.objectContaining({ message: "native creation failed" })
    ]);
  });

  it("reconciles a pre-admission owner after restart without clearing its preserved Session binding", async () => {
    const fixture = await createFixture();
    fixture.store.upsertSchedule(worktreeSchedule("schedule-restart"));
    const session = await fixture.host.createScheduledSession({
      operationId: "restart-owned-session",
      targetId: "target-one",
      title: "Restart owned",
      automationOrigin: {
        scheduleId: "schedule-restart",
        scheduleName: "Restart",
        runId: "run-restart",
        scheduleRevision: fixture.store.getSchedule("schedule-restart").revision
      },
      fastMode: false,
      permissionMode: "ask",
      planMode: false,
      worktree: { sourceRef: "refs/heads/main", refreshRemote: false },
      worktreeOwner: { scheduleId: "schedule-restart", runId: "run-restart" }
    });
    const sessionId = session.value.sessionId;
    expect(fixture.store.getSession(sessionId).descriptor.automationOrigin).toEqual({
      kind: "scheduler",
      scheduleId: "schedule-restart",
      scheduleName: "Restart",
      runId: "run-restart"
    });
    expect(ownerSettings(fixture.store)).toHaveLength(1);

    await fixture.host.dispose();
    const restartedAdapter = new CaptureCreateAdapter();
    const restarted = new SessionHost(fixture.store, fixture.artifacts, [restartedAdapter], {
      worktrees: fixture.worktrees as unknown as SessionWorktreeCoordinator
    });
    cleanups.push(() => restarted.dispose());
    await restarted.initialize();

    expect(fixture.worktrees.releases).toEqual([sessionId]);
    expect(ownerSettings(fixture.store)).toEqual([]);
    expect(fixture.store.getSession(sessionId).descriptor).toMatchObject({
      archived: true,
      worktree: { state: "preserved" }
    });
  });

  it("fails closed before checkout for script, persistent, and bound configurations", async () => {
    const fixture = await createFixture();
    const scheduler = new ScheduleCoordinator(fixture.store, fixture.host);
    fixture.store.upsertSchedule(worktreeSchedule("schedule-bound", {
      executionSnapshot: { useWorktree: false, refreshWorktreeRemote: false }
    }));
    const boundSessionId = (await fixture.host.createScheduledSession({
      operationId: "bound-compatibility-session",
      targetId: "target-one",
      title: "Bound compatibility",
      automationOrigin: {
        scheduleId: "schedule-bound",
        scheduleName: "Bound",
        runId: "run-bound",
        scheduleRevision: fixture.store.getSchedule("schedule-bound").revision
      },
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    const variants = [
      worktreeSchedule("schedule-script", {
        sessionMode: "fresh",
        executionSnapshot: {
          useWorktree: true,
          refreshWorktreeRemote: false,
          scheduler: {
            format: 1,
            silentWhenIdle: false,
            notify: { desktop: true },
            executionMode: "script",
            scriptConfig: { command: "node check.mjs", capabilities: [] }
          }
        }
      }),
      worktreeSchedule("schedule-persistent", { sessionMode: "persistent" }),
      worktreeSchedule("schedule-bound", { sessionMode: "bound", sessionId: boundSessionId })
    ] as const;
    for (const schedule of variants) fixture.store.upsertSchedule(schedule);

    for (const schedule of variants) {
      await expect(scheduler.runNowWithResult(schedule.id, schedule.id)).resolves.toMatchObject({ status: "failed" });
      expect(fixture.store.listScheduleRuns(schedule.id)).toEqual([
        expect.objectContaining({
          status: "failed",
          detail: { reason: "Isolated workspace Schedules require agent execution with a fresh task for every run." }
        })
      ]);
    }
    expect(fixture.worktrees.acquisitions).toEqual([]);
  });
});

async function createFixture(adapter: CaptureCreateAdapter = new CaptureCreateAdapter()) {
  const directory = mkdtempSync(join(tmpdir(), "joko-scheduler-worktree-"));
  const store = new OperationalStore(join(directory, "store.db"));
  const repository = new OperationalArtifactRepository(store);
  const artifacts = new ArtifactStore({
    rootDirectory: join(directory, "artifacts"),
    repository,
    ingestRoots: [directory]
  });
  await artifacts.initialize();
  const worktrees = new FakeSessionWorktrees(store, join(directory, "isolated"));
  const host = new SessionHost(store, artifacts, [adapter], {
    worktrees: worktrees as unknown as SessionWorktreeCoordinator
  });
  await host.initialize();
  await host.registerTarget({
    id: "target-one",
    backendId: adapter.id,
    displayName: "Project",
    workspaceRoot: directory,
    managed: false,
    trusted: true
  });
  cleanups.push(async () => {
    await host.dispose();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, store, artifacts, adapter, worktrees, host };
}

class FakeSessionWorktrees {
  readonly acquisitions: AcquireSessionWorktreeInput[] = [];
  readonly releases: string[] = [];
  readonly #store: OperationalStore;
  readonly #root: string;
  #sequence = 0;

  constructor(store: OperationalStore, root: string) {
    this.#store = store;
    this.#root = root;
  }

  async acquire(input: AcquireSessionWorktreeInput): Promise<SessionWorktreeBinding> {
    this.acquisitions.push(input);
    this.#sequence += 1;
    const now = Date.now();
    return {
      leaseId: `lease-${this.#sequence}`,
      workspaceId: `isolated-${input.sessionId}`,
      path: join(this.#root, `${this.#sequence}-${input.sessionId}`),
      repositoryRoot: input.target.workspaceRoot,
      branch: `joko/scheduled-${this.#sequence}`,
      sourceRef: input.sourceRef ?? "HEAD",
      sourceCommit: `${this.#sequence}`.padStart(40, "0"),
      sourceStrategy: "explicit",
      sourceRefreshed: input.refreshRemote === true,
      state: "active",
      acquiredAt: now,
      updatedAt: now
    };
  }

  effectiveTarget(session: StoredSession): TargetDescriptor {
    const target = this.#store.getTarget(session.descriptor.targetId).descriptor;
    const binding = session.descriptor.worktree;
    if (binding === undefined) return target;
    if (binding.state !== "active") throw new Error("Preserved isolated workspace cannot be resumed.");
    return { ...target, workspaceRoot: binding.path };
  }

  async release(sessionId: string): Promise<void> {
    this.releases.push(sessionId);
    const binding = this.#store.findSessionWorktree(sessionId);
    if (binding?.state === "active") this.#store.updateSessionWorktreeState(sessionId, "preserved");
  }
}

class CaptureCreateAdapter extends FakeBackendAdapter {
  readonly creationRoots: string[] = [];

  constructor() {
    super(PI_LIKE_PROFILE);
  }

  override async createSession(input: CreateNativeSessionInput, context: AdapterContext) {
    this.creationRoots.push(input.target.workspaceRoot);
    return super.createSession(input, context);
  }
}

class FailingCreateAdapter extends CaptureCreateAdapter {
  override async createSession(_input: CreateNativeSessionInput, _context: AdapterContext): Promise<never> {
    throw new Error("native creation failed");
  }
}

class GatedSendAdapter extends CaptureCreateAdapter {
  readonly entered: Promise<void>;
  readonly #markEntered: () => void;
  readonly #gate: Promise<void>;
  readonly #releaseGate: () => void;

  constructor() {
    super();
    let markEntered!: () => void;
    let releaseGate!: () => void;
    this.entered = new Promise<void>((resolve) => { markEntered = resolve; });
    this.#gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    this.#markEntered = markEntered;
    this.#releaseGate = releaseGate;
  }

  release(): void {
    this.#releaseGate();
  }

  override async send(input: PromptInput, context: AdapterContext): Promise<void> {
    this.#markEntered();
    await this.#gate;
    await super.send(input, context);
  }
}

function worktreeSchedule(
  id: string,
  patch: Partial<Parameters<OperationalStore["upsertSchedule"]>[0]> = {}
): Parameters<OperationalStore["upsertSchedule"]>[0] {
  return {
    id,
    backendId: PI_LIKE_PROFILE.id,
    targetId: "target-one",
    sessionMode: "fresh",
    name: id,
    kind: "manual",
    timezone: "UTC",
    enabled: true,
    prompt: { text: "Inspect this checkout", images: [], files: [], mentions: [], disposition: "prompt" },
    executionSnapshot: {
      permissionMode: "ask",
      planMode: false,
      useWorktree: true,
      worktreeSourceRef: "refs/heads/main",
      refreshWorktreeRemote: true,
      scheduler: {
        format: 1,
        silentWhenIdle: false,
        notify: { desktop: true },
        executionMode: "agent"
      }
    },
    overlapPolicy: "queue",
    misfirePolicy: "run_once",
    ...patch
  };
}

function ownerSettings(store: OperationalStore) {
  return store.listSettings("service")
    .filter((setting) => setting.key === SCHEDULED_WORKTREE_OWNER_SETTING_KEY);
}

async function eventually(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(predicate()).toBe(true);
}
