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
import { afterEach, describe, expect, it, vi } from "vitest";

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
  it("restores an archived ordinary task without creating another native context", async () => {
    const fixture = await createFixture(), scheduler = new ScheduleCoordinator(fixture.store, fixture.host), id = "restore-plain";
    const executionSnapshot = withoutNewWorktree(worktreeSchedule(id).executionSnapshot);
    fixture.store.upsertSchedule(worktreeSchedule(id, { sessionMode: "persistent", executionSnapshot }));
    const first = await scheduler.runNowWithResult(id, "initial-plain");
    expect(first.status).toBe("queued");
    await eventually(() => fixture.store.getRun(first.runId).descriptor.state === "completed");
    await fixture.host.closeIfActive(first.sessionId!);
    const stored = fixture.store.getSession(first.sessionId!);
    fixture.store.updateSession(first.sessionId!, { archived: true }, stored.revision);
    const second = await scheduler.runNowWithResult(id, "restored-plain");
    expect(second.status).toBe("queued");
    expect(second.sessionId).toBe(first.sessionId);
    await eventually(() => fixture.store.getRun(second.runId).descriptor.state === "completed");
    expect(fixture.store.getSession(first.sessionId!).descriptor.archived).toBe(false);
    expect(fixture.adapter.creationRoots).toHaveLength(1);
    expect(fixture.worktrees.restores).toEqual([]);
  });
  it.each(["bound", "persistent"] as const)("restores the original archived %s task and worktree before dispatch and leaves it restored", async sessionMode => {
    const fixture = await createFixture(), scheduler = new ScheduleCoordinator(fixture.store, fixture.host);
    const id = `restore-${sessionMode}`;
    fixture.store.upsertSchedule(worktreeSchedule(id));
    const first = await scheduler.runNowWithResult(id, `initial-${sessionMode}`);
    await eventually(() => fixture.store.getRun(first.runId).descriptor.state === "completed");
    await fixture.host.reconcileScheduledWorktrees();
    expect(fixture.store.getSession(first.sessionId!).descriptor).toMatchObject({ archived: true, worktree: { state: "preserved" } });
    const current = fixture.store.getSchedule(id);
    fixture.store.upsertSchedule(worktreeSchedule(id, { sessionMode, sessionId: first.sessionId, expectedRevision: current.revision,
      executionSnapshot: withoutNewWorktree(current.executionSnapshot) }));
    const second = await scheduler.runNowWithResult(id, `restored-${sessionMode}`);
    expect(second.status).toBe("queued");
    expect(second.sessionId).toBe(first.sessionId);
    expect(fixture.worktrees.restores).toEqual([first.sessionId]);
    await eventually(() => fixture.store.getRun(second.runId).descriptor.state === "completed");
    await fixture.host.reconcileScheduledWorktrees();
    expect(fixture.store.getSession(first.sessionId!).descriptor).toMatchObject({ archived: false, worktree: { state: "active" } });
    expect(fixture.adapter.creationRoots).toHaveLength(1);
    expect(fixture.store.getSchedule(id).sessionId).toBe(first.sessionId);
  });

  it("keeps an unconfirmed worktree restore on its original operation and does not repeat it", async () => {
    const fixture = await createFixture(), scheduler = new ScheduleCoordinator(fixture.store, fixture.host);
    const id = "restore-unknown";
    fixture.store.upsertSchedule(worktreeSchedule(id));
    const first = await scheduler.runNowWithResult(id, "initial-unknown");
    await eventually(() => fixture.store.getRun(first.runId).descriptor.state === "completed");
    await fixture.host.reconcileScheduledWorktrees();
    const current = fixture.store.getSchedule(id);
    fixture.store.upsertSchedule(worktreeSchedule(id, { sessionMode: "bound", sessionId: first.sessionId, expectedRevision: current.revision,
      executionSnapshot: withoutNewWorktree(current.executionSnapshot) }));
    const restore = vi.spyOn(fixture.worktrees, "restore").mockRejectedValueOnce(new Error("restore result unknown"));
    await expect(scheduler.runNowWithResult(id, "same-restore")).rejects.toThrow("restore result unknown");
    await expect(scheduler.runNowWithResult(id, "same-restore")).rejects.toThrow();
    expect(restore).toHaveBeenCalledOnce();
    expect(fixture.store.getSession(first.sessionId!).descriptor.archived).toBe(true);
    expect(fixture.store.getOperation("manual-schedule-same-restore-restore").status).toBe("started");
    expect(fixture.adapter.creationRoots).toHaveLength(1);
  });

  it("does not unarchive or dispatch when the Schedule changes during worktree recovery", async () => {
    const fixture = await createFixture(), scheduler = new ScheduleCoordinator(fixture.store, fixture.host), id = "restore-revoked";
    fixture.store.upsertSchedule(worktreeSchedule(id));
    const first = await scheduler.runNowWithResult(id, "initial-revoked");
    await eventually(() => fixture.store.getRun(first.runId).descriptor.state === "completed");
    await fixture.host.reconcileScheduledWorktrees();
    const current = fixture.store.getSchedule(id), executionSnapshot = withoutNewWorktree(current.executionSnapshot);
    fixture.store.upsertSchedule(worktreeSchedule(id, { sessionMode: "bound", sessionId: first.sessionId, expectedRevision: current.revision, executionSnapshot }));
    const restore = fixture.worktrees.restore.bind(fixture.worktrees);
    vi.spyOn(fixture.worktrees, "restore").mockImplementationOnce(async sessionId => {
      await restore(sessionId);
      fixture.store.upsertSchedule(worktreeSchedule(id, { sessionMode: "bound", sessionId, enabled: false,
        expectedRevision: fixture.store.getSchedule(id).revision, executionSnapshot }));
    });
    await expect(scheduler.runNowWithResult(id, "revoked-restore")).rejects.toThrow(/changed|cancelled/u);
    expect(fixture.store.getSession(first.sessionId!).descriptor.archived).toBe(true);
    expect(fixture.adapter.creationRoots).toHaveLength(1);
    expect(fixture.store.listRuns({ sessionId: first.sessionId! })).toHaveLength(1);
  });
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

  it("confirms interactive terminal cleanup before releasing a completed run worktree", async () => {
    const closeSessionTerminals = vi.fn(async (_sessionId: string) => undefined);
    const fixture = await createFixture(new CaptureCreateAdapter(), closeSessionTerminals);
    const releaseWorktree = vi.spyOn(fixture.worktrees, "release");
    const scheduler = new ScheduleCoordinator(fixture.store, fixture.host);
    fixture.store.upsertSchedule(worktreeSchedule("schedule-terminal-cleanup"));

    const dispatched = await scheduler.runNowWithResult("schedule-terminal-cleanup", "terminal-cleanup");
    await eventually(() => fixture.store.getRun(dispatched.runId).descriptor.state === "completed");
    await fixture.host.reconcileScheduledWorktrees();

    expect(closeSessionTerminals).toHaveBeenCalledExactlyOnceWith(dispatched.sessionId);
    expect(releaseWorktree).toHaveBeenCalledExactlyOnceWith(dispatched.sessionId);
    expect(closeSessionTerminals.mock.invocationCallOrder[0]).toBeLessThan(releaseWorktree.mock.invocationCallOrder[0]!);
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

async function createFixture(
  adapter: CaptureCreateAdapter = new CaptureCreateAdapter(),
  closeSessionTerminals?: (sessionId: string) => Promise<void>
) {
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
    worktrees: worktrees as unknown as SessionWorktreeCoordinator,
    ...(closeSessionTerminals === undefined ? {} : { closeSessionTerminals })
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
  readonly restores: string[] = [];
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

  async restore(sessionId: string): Promise<void> {
    this.restores.push(sessionId);
    this.#store.updateSessionWorktreeState(sessionId, "active");
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

function withoutNewWorktree(value: unknown): Record<string, unknown> {
  const execution: Record<string, unknown> = { ...(value as Record<string, unknown>), useWorktree: false, refreshWorktreeRemote: false };
  delete execution["worktreeSourceRef"];
  return execution;
}

async function eventually(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(predicate()).toBe(true);
}
