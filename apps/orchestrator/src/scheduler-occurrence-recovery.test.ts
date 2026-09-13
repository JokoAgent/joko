import { OperationalStore } from "@joko/store";
import { describe, expect, it, vi } from "vitest";

import { ScheduleCoordinator } from "./schedule-coordinator.js";
import { SchedulerOccurrenceRecovery } from "./scheduler-occurrence-recovery.js";
import { SchedulerRuntimeState } from "./scheduler-runtime-state.js";

describe("SchedulerOccurrenceRecovery", () => {
  it("renews heartbeat leases without treating a progressing long run as stalled", () => {
    let now = 100;
    const store = scheduleStore();
    const runtime = new SchedulerRuntimeState({ instanceId: "owner-progress", now: () => now });
    const abort = vi.fn();
    const forceRelease = vi.fn();
    const recovery = new SchedulerOccurrenceRecovery(store, runtime, {
      now: () => now,
      heartbeatIntervalMs: 10,
      heartbeatLeaseMs: 40,
      runStallMs: 30,
      stallAbortGraceMs: 20,
      onForceRelease: forceRelease
    });

    recovery.begin({
      scheduleId: "schedule-one",
      runId: "run-progress",
      source: "automatic",
      executionMode: "agent",
      scheduledAt: 90,
      phase: "running",
      abort
    });
    now = 125;
    recovery.progress("run-progress");
    now = 150;
    recovery.pulse();

    expect(abort).not.toHaveBeenCalled();
    expect(forceRelease).not.toHaveBeenCalled();
    expect(store.getScheduleRuntimeOccurrence("run-progress")).toMatchObject({
      phase: "running",
      heartbeatAt: 150,
      lastProgressAt: 125,
      leaseExpiresAt: 190
    });
    recovery.finish("run-progress");
    store.close();
  });

  it("bounds an ignored stall abort and force-releases only after taking a newer generation", async () => {
    let now = 100;
    const store = scheduleStore();
    const runtime = new SchedulerRuntimeState({ instanceId: "owner-stall", now: () => now });
    const abort = vi.fn(() => new Promise<void>(() => undefined));
    const releases: Array<{ readonly generation: number; readonly reason: string }> = [];
    const recovery = new SchedulerOccurrenceRecovery(store, runtime, {
      now: () => now,
      heartbeatIntervalMs: 10,
      heartbeatLeaseMs: 40,
      runStallMs: 30,
      stallAbortGraceMs: 20,
      onForceRelease: (occurrence, reason) => {
        releases.push({ generation: occurrence.ownerGeneration, reason });
      }
    });

    recovery.begin({
      scheduleId: "schedule-one",
      runId: "run-stall",
      source: "run-now",
      executionMode: "agent",
      scheduledAt: 100,
      phase: "running",
      abort
    });
    const original = store.getScheduleRuntimeOccurrence("run-stall");
    const work = new Promise<never>(() => undefined);
    const raced = recovery.race("run-stall", work);

    now = 131;
    recovery.pulse();
    expect(abort).toHaveBeenCalledTimes(1);
    expect(runtime.find("run-stall")?.phase).toBe("stalled");
    expect(store.getScheduleRuntimeOccurrence("run-stall").phase).toBe("stalled");

    now = 150;
    recovery.pulse();
    expect(releases).toEqual([]);
    now = 151;
    recovery.pulse();

    await expect(raced).resolves.toEqual({ forceReleased: true });
    expect(releases).toEqual([{ generation: original.ownerGeneration + 1, reason: "stalled" }]);
    expect(runtime.snapshot()).toMatchObject({ inFlight: 0, slotsInUse: 0 });
    expect(store.findScheduleRuntimeOccurrence("run-stall")).toBeUndefined();
    expect(store.touchScheduleRuntimeOccurrence({
      runId: original.runId,
      ownerId: original.ownerId,
      ownerGeneration: original.ownerGeneration,
      heartbeatAt: 152,
      leaseExpiresAt: 192,
      progressAt: 152,
      phase: "running"
    })).toBeUndefined();
    store.close();
  });

  it("cancels a pending force release when progress resumes during abort grace", () => {
    let now = 100;
    const store = scheduleStore();
    const runtime = new SchedulerRuntimeState({ instanceId: "owner-resumed", now: () => now });
    const abort = vi.fn();
    const forceRelease = vi.fn();
    const recovery = new SchedulerOccurrenceRecovery(store, runtime, {
      now: () => now,
      heartbeatIntervalMs: 10,
      heartbeatLeaseMs: 40,
      runStallMs: 30,
      stallAbortGraceMs: 20,
      onForceRelease: forceRelease
    });
    recovery.begin({
      scheduleId: "schedule-one",
      runId: "run-resumed",
      source: "automatic",
      executionMode: "agent",
      scheduledAt: 90,
      phase: "running",
      abort
    });

    now = 131;
    recovery.pulse();
    expect(runtime.find("run-resumed")?.phase).toBe("stalled");
    now = 140;
    expect(recovery.progress("run-resumed")).toBe(true);
    expect(runtime.find("run-resumed")).toMatchObject({ phase: "running", lastProgressAt: 140 });
    // Crossing the old abort deadline cannot release the resumed generation.
    now = 152;
    recovery.pulse();

    expect(abort).toHaveBeenCalledTimes(1);
    expect(forceRelease).not.toHaveBeenCalled();
    expect(runtime.find("run-resumed")?.phase).toBe("running");
    expect(store.getScheduleRuntimeOccurrence("run-resumed")).toMatchObject({
      phase: "running",
      lastProgressAt: 140
    });
    recovery.finish("run-resumed");
    store.close();
  });

  it("excludes a host suspension gap from no-progress and abort-grace accounting", () => {
    let now = 100;
    const store = scheduleStore();
    const runtime = new SchedulerRuntimeState({ instanceId: "owner-suspended", now: () => now });
    const abort = vi.fn();
    const recovery = new SchedulerOccurrenceRecovery(store, runtime, {
      now: () => now,
      heartbeatIntervalMs: 10,
      heartbeatLeaseMs: 40,
      runStallMs: 30,
      stallAbortGraceMs: 20,
      suspendGapMs: 15
    });
    recovery.begin({
      scheduleId: "schedule-one",
      runId: "run-suspended",
      source: "automatic",
      executionMode: "agent",
      scheduledAt: 90,
      phase: "running",
      abort
    });

    now = 200;
    recovery.pulse();

    expect(abort).not.toHaveBeenCalled();
    expect(runtime.find("run-suspended")).toMatchObject({
      phase: "running",
      startedAt: 190,
      lastProgressAt: 190
    });
    expect(store.getScheduleRuntimeOccurrence("run-suspended")).toMatchObject({
      startedAt: 190,
      lastProgressAt: 190,
      heartbeatAt: 200,
      leaseExpiresAt: 240
    });
    recovery.finish("run-suspended");
    store.close();
  });

  it("reconciles an expired owner after restart, accepts a pre-claim late heartbeat, and bounds hanging abort", () => {
    let now = 100;
    const store = scheduleStore();
    const oldRuntime = new SchedulerRuntimeState({ instanceId: "owner-before-restart", now: () => now });
    const oldRecovery = new SchedulerOccurrenceRecovery(store, oldRuntime, {
      now: () => now,
      heartbeatIntervalMs: 10,
      heartbeatLeaseMs: 40,
      runStallMs: 300,
      stallAbortGraceMs: 20
    });
    oldRecovery.begin({
      scheduleId: "schedule-one",
      runId: "run-restart",
      source: "automatic",
      executionMode: "agent",
      scheduledAt: 90,
      phase: "running",
      abort: () => undefined
    });
    const oldFence = store.getScheduleRuntimeOccurrence("run-restart");

    now = 120;
    const abortStale = vi.fn(() => new Promise<void>(() => undefined));
    const forceRelease = vi.fn();
    const newRuntime = new SchedulerRuntimeState({ instanceId: "owner-after-restart", now: () => now });
    const newRecovery = new SchedulerOccurrenceRecovery(store, newRuntime, {
      now: () => now,
      heartbeatIntervalMs: 10,
      heartbeatLeaseMs: 40,
      runStallMs: 300,
      stallAbortGraceMs: 20,
      staleAbortGraceMs: 20,
      onAbortStale: abortStale,
      onForceRelease: forceRelease
    });
    newRecovery.pulse();
    expect(store.getSchedulerRuntimeOwner()).toMatchObject({ ownerId: "owner-after-restart", generation: 2 });
    expect(abortStale).not.toHaveBeenCalled();

    // The old lease has expired by wall time, but a heartbeat that commits
    // before the recovery claim is progress/liveness truth and renews it.
    now = 141;
    expect(store.touchScheduleRuntimeOccurrence({
      runId: oldFence.runId,
      ownerId: oldFence.ownerId,
      ownerGeneration: oldFence.ownerGeneration,
      heartbeatAt: now,
      leaseExpiresAt: 181,
      progressAt: now,
      phase: "running"
    })).toMatchObject({ heartbeatAt: 141, lastProgressAt: 141 });
    newRecovery.pulse();
    expect(abortStale).not.toHaveBeenCalled();

    now = 182;
    newRecovery.pulse();
    expect(abortStale).toHaveBeenCalledTimes(1);
    const claimed = store.getScheduleRuntimeOccurrence("run-restart");
    expect(claimed).toMatchObject({
      ownerId: "owner-after-restart",
      ownerGeneration: 2,
      phase: "recovering"
    });
    expect(store.touchScheduleRuntimeOccurrence({
      runId: oldFence.runId,
      ownerId: oldFence.ownerId,
      ownerGeneration: oldFence.ownerGeneration,
      heartbeatAt: 183,
      leaseExpiresAt: 223,
      progressAt: 183,
      phase: "running"
    })).toBeUndefined();

    now = 201;
    newRecovery.pulse();
    expect(forceRelease).not.toHaveBeenCalled();
    now = 202;
    newRecovery.pulse();
    expect(forceRelease).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-restart", ownerGeneration: 2 }),
      "stale-owner",
      61
    );
    expect(store.findScheduleRuntimeOccurrence("run-restart")).toBeUndefined();
    expect(newRuntime.snapshot().inFlight).toBe(0);
    store.close();
  });

  it("releases a stale dispatch lease without aborting an already durably queued product run", async () => {
    let now = 100;
    const store = scheduleStore();
    const owner = store.claimSchedulerRuntimeOwner({
      ownerId: "owner-before-queue-restart",
      startedAt: now,
      leaseExpiresAt: 140
    });
    store.beginScheduleRuntimeOccurrence({
      runId: "run-already-queued",
      scheduleId: "schedule-one",
      source: "automatic",
      executionMode: "agent",
      phase: "running",
      ownerId: owner.ownerId,
      ownerGeneration: owner.generation,
      scheduledAt: 90,
      startedAt: 100,
      leaseExpiresAt: 140
    });
    store.recordScheduleOccurrence({
      scheduleId: "schedule-one",
      runId: "run-already-queued",
      firedAt: 90,
      status: "queued"
    });
    now = 141;
    const abort = vi.fn();
    const coordinator = new ScheduleCoordinator(store, { abort } as never, {
      now: () => now,
      schedulerInstanceId: "owner-after-queue-restart",
      heartbeatIntervalMs: 10,
      heartbeatLeaseMs: 40,
      runStallMs: 300,
      stallAbortGraceMs: 20,
      tickMs: 1_000_000
    });

    coordinator.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(abort).not.toHaveBeenCalled();
    expect(store.findScheduleRuntimeOccurrence("run-already-queued")).toBeUndefined();
    expect(store.findScheduleRunByRunId("run-already-queued")).toMatchObject({ status: "queued" });
    coordinator.stop();
    store.close();
  });
});

function scheduleStore(): OperationalStore {
  const store = new OperationalStore(":memory:");
  store.upsertBackend({
    id: "pi",
    displayName: "Pi",
    version: "test",
    health: "healthy",
    adapterKind: "fixture",
    instanceGeneration: 0,
    installationState: "installed",
    authenticationState: "authenticated",
    capabilities: new Map(),
    models: [],
    tools: [],
    diagnostics: []
  });
  store.upsertTarget({
    id: "target-one",
    backendId: "pi",
    displayName: "Target",
    workspaceRoot: "D:/workspace",
    managed: false,
    trusted: true
  });
  store.upsertSchedule({
    id: "schedule-one",
    backendId: "pi",
    targetId: "target-one",
    sessionMode: "fresh",
    name: "Schedule",
    kind: "manual",
    timezone: "UTC",
    enabled: true,
    prompt: { text: "run", images: [], files: [], mentions: [], disposition: "prompt" },
    executionSnapshot: { permissionMode: "ask", planMode: false },
    overlapPolicy: "queue",
    misfirePolicy: "run_once"
  });
  return store;
}
