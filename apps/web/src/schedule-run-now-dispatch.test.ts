import { describe, expect, it, vi } from "vitest";

import type { SchedulerRuntimeView, ScheduleRuntimeRunView } from "./model.js";
import { createScheduleRunNowDispatchTracker } from "./schedule-run-now-dispatch.js";

describe("Schedule Run Now dispatch tracker", () => {
  it("opens a synchronous per-Schedule gate and releases only for a new authoritative Run Now identity", async () => {
    const changes = vi.fn<(busyIds: ReadonlySet<string>) => void>();
    const tracker = createScheduleRunNowDispatchTracker(changes);
    const existing = run("schedule-a", "run-existing", "runNow", "loading");
    const automatic = run("schedule-a", "run-automatic", "automatic", "running");
    const rpc = deferred<void>();

    const attempt = required(tracker.begin("schedule-a", runtime("owner-a", [existing, automatic])));
    expect(tracker.begin("schedule-a", runtime("owner-a", [existing, automatic]))).toBeUndefined();
    expect([...tracker.busyIds]).toEqual(["schedule-a"]);
    expect([...required(changes.mock.lastCall)[0]]).toEqual(["schedule-a"]);
    const presentation = tracker.attach(attempt, () => rpc.promise);

    tracker.observe(runtime("owner-a", [
      { ...existing, phase: "running", lastProgressAt: 2 },
      run("schedule-a", undefined, "runNow"),
      run("schedule-a", "run-automatic-new", "automatic"),
      run("schedule-b", "run-other", "runNow")
    ]));
    expect([...tracker.busyIds]).toEqual(["schedule-a"]);

    tracker.observe(runtime("owner-a", [
      { ...existing, phase: "running", lastProgressAt: 2 },
      run("schedule-a", "run-new", "runNow")
    ]));
    await expect(presentation).resolves.toBeUndefined();
    expect([...tracker.busyIds]).toEqual([]);

    // The first RPC can settle after a second user intent begins. Its token is
    // retired and therefore cannot clear the newer dispatch window.
    const nextRpc = deferred<void>();
    const next = required(tracker.begin("schedule-a", runtime("owner-a", [
      existing,
      run("schedule-a", "run-new", "runNow")
    ])));
    const nextPresentation = tracker.attach(next, () => nextRpc.promise);
    rpc.reject(new Error("late first response"));
    await Promise.resolve();
    await Promise.resolve();
    expect([...tracker.busyIds]).toEqual(["schedule-a"]);

    nextRpc.resolve();
    await expect(nextPresentation).resolves.toBeUndefined();
    expect([...tracker.busyIds]).toEqual([]);
  });

  it("does not use snapshots for an attempt without a click-time runtime baseline", async () => {
    const tracker = createScheduleRunNowDispatchTracker();
    const rpc = deferred<void>();
    const attempt = required(tracker.begin("schedule-a", undefined));
    const presentation = tracker.attach(attempt, () => rpc.promise);

    tracker.observe(runtime("owner-a", [run("schedule-a", "run-new", "runNow")]));
    expect([...tracker.busyIds]).toEqual(["schedule-a"]);

    rpc.resolve();
    await expect(presentation).resolves.toBeUndefined();
    expect([...tracker.busyIds]).toEqual([]);
  });

  it("does not observe a Run before dispatch and does not dispatch after retirement", async () => {
    const tracker = createScheduleRunNowDispatchTracker();
    const baseline = runtime("owner-a");
    const attempt = required(tracker.begin("schedule-a", baseline));

    tracker.observe(runtime("owner-a", [run("schedule-a", "unrelated-new-run", "runNow")]));
    expect([...tracker.busyIds]).toEqual(["schedule-a"]);

    tracker.retire();
    await expect(attempt.presentation).resolves.toBeUndefined();
    const dispatch = vi.fn(async () => undefined);
    await expect(tracker.attach(attempt, dispatch)).resolves.toBeUndefined();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("uses an earlier RPC settlement as fallback and preserves an early rejection", async () => {
    const tracker = createScheduleRunNowDispatchTracker();
    const resolved = required(tracker.begin("schedule-a", runtime("owner-a")));
    await expect(tracker.attach(resolved, async () => undefined)).resolves.toBeUndefined();
    expect([...tracker.busyIds]).toEqual([]);

    const rejected = required(tracker.begin("schedule-a", runtime("owner-a")));
    const failure = new Error("dispatch failed before fire");
    await expect(tracker.attach(rejected, async () => { throw failure; })).rejects.toBe(failure);
    expect([...tracker.busyIds]).toEqual([]);

    const rejectedWithoutValue = required(tracker.begin("schedule-a", runtime("owner-a")));
    await expect(tracker.attach(rejectedWithoutValue, () => Promise.reject(undefined))).rejects.toBeUndefined();
    expect([...tracker.busyIds]).toEqual([]);
  });

  it("retires guards on scheduler owner change or explicit owner retirement", async () => {
    const tracker = createScheduleRunNowDispatchTracker();
    const oldRpc = deferred<void>();
    const oldAttempt = required(tracker.begin("schedule-a", runtime("owner-a")));
    const oldPresentation = tracker.attach(oldAttempt, () => oldRpc.promise);

    tracker.observe(runtime("owner-b"));
    await expect(oldPresentation).resolves.toBeUndefined();
    expect([...tracker.busyIds]).toEqual([]);

    const currentRpc = deferred<void>();
    const currentAttempt = required(tracker.begin("schedule-a", runtime("owner-b")));
    const currentPresentation = tracker.attach(currentAttempt, () => currentRpc.promise);
    oldRpc.reject(new Error("late retired owner response"));
    await Promise.resolve();
    await Promise.resolve();
    expect([...tracker.busyIds]).toEqual(["schedule-a"]);

    tracker.retire();
    await expect(currentPresentation).resolves.toBeUndefined();
    expect([...tracker.busyIds]).toEqual([]);
    currentRpc.reject(new Error("late unmounted response"));
    await Promise.resolve();
  });
});

function runtime(instanceId: string, runs: readonly ScheduleRuntimeRunView[] = []): SchedulerRuntimeView {
  return {
    instanceId,
    inFlight: runs.length,
    slotsInUse: runs.length,
    maxConcurrentRuns: 4,
    runs,
    waiting: []
  };
}

function run(
  scheduleId: string,
  runId: string | undefined,
  source: ScheduleRuntimeRunView["source"],
  phase: ScheduleRuntimeRunView["phase"] = "running"
): ScheduleRuntimeRunView {
  return {
    scheduleId,
    ...(runId === undefined ? {} : { runId }),
    source,
    executionMode: "script",
    startedAt: 1,
    phase,
    lastProgressAt: 1
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected value.");
  return value;
}
