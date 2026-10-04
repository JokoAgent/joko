// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import { DEFAULT_UI_PREFERENCES } from "../local-state.js";
import {
  emptySnapshot,
  type BackendView,
  type SchedulerRuntimeView,
  type ScheduleRuntimePhaseView,
  type ScheduleRuntimeRunView,
  type ScheduleView,
  type TargetView
} from "../model.js";
import { SchedulesPage } from "./SchedulesPage.js";
import type { RunAction, Translator } from "./types.js";

const POLL_MS = 1_500;
const roots = new Set<Root>();

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => vi.useFakeTimers());

afterEach(async () => {
  for (const root of [...roots].reverse()) await act(async () => root.unmount());
  roots.clear();
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("SchedulesPage Run now dispatch window", () => {
  it("shares a synchronous row/detail gate and releases only for a new authoritative run-now identity", async () => {
    const owner = controllerFixture("owner-a");
    const view = await renderSchedules(owner);
    await resolveRuntime(owner, runtime([
      runtimeRun("primary", "run-existing", "runNow", "loading"),
      runtimeRun("primary", "automatic-existing", "automatic", "running"),
      runtimeRun("other", "other-existing", "runNow", "running")
    ]));

    await act(async () => {
      view.rowRun("primary").click();
      view.detailRun().click();
    });

    expect(owner.runSchedule).toHaveBeenCalledTimes(1);
    expect(view.rowRun("primary").disabled).toBe(true);
    expect(view.detailRun().disabled).toBe(true);
    expect(view.actions).toHaveLength(1);
    expect(view.actions[0]?.outcome).toBe("pending");

    await pollRuntime(owner, runtime([
      runtimeRun("primary", "run-existing", "runNow", "finalizing"),
      runtimeRun("primary", "automatic-existing", "automatic", "recovering"),
      runtimeRun("other", "other-existing", "runNow", "finalizing")
    ]));
    expect(view.actions[0]?.outcome).toBe("pending");
    expect(view.detailRun().disabled).toBe(true);

    await pollRuntime(owner, runtime([
      runtimeRun("primary", "run-existing", "runNow", "finalizing"),
      runtimeRun("primary", "automatic-new", "automatic", "loading"),
      runtimeRun("other", "other-new", "runNow", "loading")
    ]));
    expect(view.actions[0]?.outcome).toBe("pending");
    expect(view.rowRun("primary").disabled).toBe(true);

    await pollRuntime(owner, runtime([
      runtimeRun("primary", "run-existing", "runNow", "finalizing"),
      runtimeRun("primary", "run-confirmed", "runNow", "loading")
    ]));
    expect(view.actions[0]?.outcome).toBe("resolved");
    expect(view.rowRun("primary").disabled).toBe(false);
    expect(view.detailRun().disabled).toBe(false);

    await act(async () => view.detailRun().click());
    expect(owner.runSchedule).toHaveBeenCalledTimes(2);
    expect(view.actions[1]?.outcome).toBe("pending");
    expect(view.rowRun("primary").disabled).toBe(true);

    await pollRuntime(owner, runtime([
      runtimeRun("primary", "run-confirmed", "runNow", "running")
    ]));
    expect(view.actions[1]?.outcome).toBe("pending");

    await pollRuntime(owner, runtime([
      runtimeRun("primary", "run-confirmed", "runNow", "running"),
      runtimeRun("primary", "run-confirmed-again", "runNow", "loading")
    ]));
    expect(view.actions[1]?.outcome).toBe("resolved");
    expect(view.detailRun().disabled).toBe(false);
    expect(owner.runRequests.every((request) => request.state === "pending")).toBe(true);
  });

  it("uses an earlier RPC resolve or rejection as the fallback and keeps rejection observable", async () => {
    const owner = controllerFixture("owner-fallback");
    const view = await renderSchedules(owner);
    await resolveRuntime(owner, runtime([]));

    await act(async () => view.detailRun().click());
    expect(view.actions[0]?.outcome).toBe("pending");
    await settleDeferred(owner.runRequests[0], "resolve");
    expect(view.actions[0]?.outcome).toBe("resolved");
    expect(view.detailRun().disabled).toBe(false);

    await act(async () => view.rowRun("primary").click());
    const failure = new Error("Run now was rejected before dispatch.");
    await settleDeferred(owner.runRequests[1], "reject", failure);
    expect(view.actions[1]?.outcome).toBe("rejected");
    expect(view.actions[1]?.error).toBe(failure);
    expect(view.rowRun("primary").disabled).toBe(false);
  });

  it("does not guess dispatch success after a runtime poll failure or an unchanged snapshot", async () => {
    const owner = controllerFixture("owner-unknown");
    const view = await renderSchedules(owner);
    await resolveRuntime(owner, runtime([]));

    await act(async () => view.detailRun().click());
    await rejectNextRuntime(owner, new Error("runtime unavailable"));
    expect(view.actions[0]?.outcome).toBe("pending");
    expect(view.detailRun().disabled).toBe(true);

    await pollRuntime(owner, runtime([]));
    expect(view.actions[0]?.outcome).toBe("pending");
    expect(view.rowRun("primary").disabled).toBe(true);

    await settleDeferred(owner.runRequests[0], "resolve");
    expect(view.actions[0]?.outcome).toBe("resolved");
    expect(view.detailRun().disabled).toBe(false);
  });

  it("retires controller and unmount owners without allowing late snapshots or RPCs to affect the successor", async () => {
    const first = controllerFixture("owner-first");
    const view = await renderSchedules(first);
    await resolveRuntime(first, runtime([]));

    await act(async () => view.detailRun().click());
    const lateFirstPoll = await beginNextRuntimePoll(first);
    expect(view.actions[0]?.outcome).toBe("pending");

    const second = controllerFixture("owner-second");
    await view.rerender(second);
    expect(view.actions[0]?.outcome).toBe("resolved");
    expect(view.detailRun().disabled).toBe(false);
    await resolveRuntime(second, runtime([]));

    await act(async () => view.detailRun().click());
    expect(second.runSchedule).toHaveBeenCalledTimes(1);
    expect(view.actions[1]?.outcome).toBe("pending");
    const secondPoll = await beginNextRuntimePoll(second);

    await act(async () => {
      lateFirstPoll.resolve(runtime([runtimeRun("primary", "late-old-owner", "runNow", "loading")]));
      first.runRequests[0]?.reject(new Error("late old owner rejection"));
      await flushPromises();
    });
    expect(view.actions[1]?.outcome).toBe("pending");
    expect(view.detailRun().disabled).toBe(true);

    await act(async () => {
      secondPoll.resolve(runtime([runtimeRun("primary", "new-owner-run", "runNow", "loading")]));
      await flushPromises();
    });
    expect(view.actions[1]?.outcome).toBe("resolved");
    expect(view.detailRun().disabled).toBe(false);

    await act(async () => view.detailRun().click());
    expect(view.actions[2]?.outcome).toBe("pending");
    await view.unmount();
    expect(view.actions[2]?.outcome).toBe("resolved");

    await act(async () => {
      second.runRequests[1]?.reject(new Error("late unmounted owner rejection"));
      await flushPromises();
    });
    expect(view.actions[2]?.outcome).toBe("resolved");
  });
});

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
  state: "pending" | "resolved" | "rejected";
}

interface ActionRecord {
  readonly key: string;
  readonly promise: Promise<void>;
  outcome: "pending" | "resolved" | "rejected";
  error?: unknown;
}

interface ControllerFixture {
  readonly controller: AppController;
  readonly runtimeRequests: Deferred<SchedulerRuntimeView>[];
  readonly runRequests: Deferred<void>[];
  readonly getSchedulerRuntime: ReturnType<typeof vi.fn>;
  readonly runSchedule: ReturnType<typeof vi.fn>;
}

async function renderSchedules(initial: ControllerFixture): Promise<{
  readonly actions: ActionRecord[];
  readonly rowRun: (scheduleId: string) => HTMLButtonElement;
  readonly detailRun: () => HTMLButtonElement;
  readonly rerender: (owner: ControllerFixture) => Promise<void>;
  readonly unmount: () => Promise<void>;
}> {
  const actions: ActionRecord[] = [];
  const runAction: RunAction = (key, action) => {
    const promise = action();
    const record: ActionRecord = { key, promise, outcome: "pending" };
    actions.push(record);
    void promise.then(
      () => { record.outcome = "resolved"; },
      (error: unknown) => { record.outcome = "rejected"; record.error = error; }
    );
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.add(root);
  const render = async (owner: ControllerFixture): Promise<void> => {
    await act(async () => root.render(<SchedulesPage
      controller={owner.controller}
      schedules={schedules}
      sessions={[]}
      targets={[target]}
      models={[]}
      backends={[backend]}
      extraDirectories={[]}
      locale="en"
      t={t}
      runAction={runAction}
      onOpenNavigation={vi.fn()}
      prepareSessionRemoval={async (sessionsToRemove) => ({ clean: sessionsToRemove.length, dirty: 0, unknown: 0 })}
    />));
  };
  await render(initial);
  const rowRun = (scheduleId: string): HTMLButtonElement => required(container.querySelector<HTMLButtonElement>(
    `#schedule-row-${scheduleId} [aria-label="scheduler.runNow · ${scheduleName(scheduleId)}"]`
  ));
  const detailRun = (): HTMLButtonElement => required([...container.querySelectorAll<HTMLButtonElement>("button")]
    .find((button) => button.textContent?.trim() === "scheduler.runNow"));
  return {
    actions,
    rowRun,
    detailRun,
    rerender: render,
    unmount: async () => {
      if (!roots.delete(root)) return;
      await act(async () => {
        root.unmount();
        await flushPromises();
      });
    }
  };
}

function controllerFixture(ownerId: string): ControllerFixture {
  const runtimeRequests: Deferred<SchedulerRuntimeView>[] = [];
  const runRequests: Deferred<void>[] = [];
  const snapshot = {
    ...emptySnapshot(),
    revision: 1n,
    targets: [target],
    schedules,
    backends: [backend]
  };
  const getSchedulerRuntime = vi.fn((_signal?: AbortSignal) => {
    const request = deferred<SchedulerRuntimeView>();
    runtimeRequests.push(request);
    return request.promise;
  });
  const runSchedule = vi.fn((_scheduleId: string) => {
    const request = deferred<void>();
    runRequests.push(request);
    return request.promise;
  });
  const controller = {
    state: {
      snapshot,
      preferences: { ...DEFAULT_UI_PREFERENCES, navigationOpen: true },
      route: { kind: "schedules" },
      activeProfile: { id: ownerId }
    },
    navigate: vi.fn(),
    getSchedulerRuntime,
    listScheduleRunHistory: vi.fn().mockResolvedValue({ history: [], totalSize: 0 }),
    runSchedule,
    setScheduleEnabled: vi.fn().mockResolvedValue(undefined),
    deleteSchedule: vi.fn().mockResolvedValue(undefined),
    saveSchedule: vi.fn().mockResolvedValue(undefined),
    probeTargetWorktree: vi.fn().mockResolvedValue({ targetId: target.id, eligibility: "unavailable", canRefreshRemote: false }),
    listTargetWorktreeSources: vi.fn().mockResolvedValue([]),
    refreshProviderModels: vi.fn().mockResolvedValue(undefined)
  } as unknown as AppController;
  return { controller, runtimeRequests, runRequests, getSchedulerRuntime, runSchedule };
}

async function resolveRuntime(owner: ControllerFixture, value: SchedulerRuntimeView): Promise<void> {
  const request = required(owner.runtimeRequests.at(-1));
  await act(async () => {
    request.resolve(value);
    await flushPromises();
  });
}

async function beginNextRuntimePoll(owner: ControllerFixture): Promise<Deferred<SchedulerRuntimeView>> {
  const before = owner.runtimeRequests.length;
  await act(async () => {
    vi.advanceTimersByTime(POLL_MS);
    await flushPromises();
  });
  expect(owner.runtimeRequests).toHaveLength(before + 1);
  return required(owner.runtimeRequests.at(-1));
}

async function pollRuntime(owner: ControllerFixture, value: SchedulerRuntimeView): Promise<void> {
  const request = await beginNextRuntimePoll(owner);
  await act(async () => {
    request.resolve(value);
    await flushPromises();
  });
}

async function rejectNextRuntime(owner: ControllerFixture, error: Error): Promise<void> {
  const request = await beginNextRuntimePoll(owner);
  await act(async () => {
    request.reject(error);
    await flushPromises();
  });
}

async function settleDeferred<T>(
  request: Deferred<T> | undefined,
  outcome: "resolve" | "reject",
  error?: Error
): Promise<void> {
  const current = required(request);
  await act(async () => {
    if (outcome === "resolve") current.resolve(undefined as T);
    else current.reject(error ?? new Error("rejected"));
    await flushPromises();
  });
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (reason: unknown) => void;
  const result: Deferred<T> = {
    promise: new Promise<T>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    }),
    resolve: (value) => {
      if (result.state !== "pending") return;
      result.state = "resolved";
      resolvePromise(value);
    },
    reject: (reason) => {
      if (result.state !== "pending") return;
      result.state = "rejected";
      rejectPromise(reason);
    },
    state: "pending"
  };
  return result;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function runtime(runs: readonly ScheduleRuntimeRunView[], instanceId = "scheduler-one"): SchedulerRuntimeView {
  return {
    instanceId,
    inFlight: runs.length,
    slotsInUse: runs.filter((run) => !["queued", "cancelling", "stalled"].includes(run.phase)).length,
    maxConcurrentRuns: 8,
    runs,
    waiting: []
  };
}

function runtimeRun(
  scheduleId: string,
  runId: string,
  source: ScheduleRuntimeRunView["source"],
  phase: ScheduleRuntimePhaseView
): ScheduleRuntimeRunView {
  return {
    scheduleId,
    runId,
    source,
    executionMode: "script",
    startedAt: 1,
    phase,
    lastProgressAt: 1
  };
}

const schedules: readonly ScheduleView[] = [
  schedule("primary", "Primary schedule"),
  schedule("other", "Other schedule")
];

function schedule(id: string, name: string): ScheduleView {
  return {
    id,
    name,
    source: "user",
    backendId: "backend",
    targetId: "target",
    sessionMode: "fresh",
    enabled: true,
    kind: "manual",
    expression: "",
    timezone: "UTC",
    inputText: "",
    executionMode: "script",
    script: { command: "node automation.mjs", capabilities: [] },
    useWorktree: false,
    refreshWorktreeRemote: false,
    permissionMode: "ask",
    planMode: false,
    extraDirectoryIds: [],
    silentWhenIdle: false,
    notifyDesktop: true,
    overlapPolicy: "queue",
    misfirePolicy: "runOnce",
    unreadRunCount: 0,
    history: []
  };
}

function scheduleName(id: string): string {
  return required(schedules.find((candidate) => candidate.id === id)).name;
}

const target: TargetView = {
  id: "target",
  backendId: "backend",
  name: "Project",
  workspaceId: "workspace",
  revision: 1n,
  workspaceName: "Project",
  trusted: true,
  pinned: false,
  archived: false
};

const backend: BackendView = {
  id: "backend",
  name: "Backend",
  version: "1",
  health: "healthy",
  capabilities: new Map([
    ["input.text", { name: "input.text", supported: true, options: [] }],
    ["permission.modes", { name: "permission.modes", supported: true, options: ["ask"] }]
  ])
};

const t: Translator = (key) => String(key);

function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error("Expected value to be present.");
  return value;
}
