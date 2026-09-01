import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_SCHEDULE_MAX_CONCURRENT_RUNS,
  SchedulerRuntimeState
} from "./scheduler-runtime-state.js";

describe("SchedulerRuntimeState", () => {
  it("uses the eight-slot default and records automatic slot wait", () => {
    let now = 10_000;
    const state = new SchedulerRuntimeState({ instanceId: "scheduler-a", processId: 42, now: () => now });
    state.begin({ scheduleId: "schedule-a", scheduleName: "A", runId: "run-a", source: "automatic", scheduledAt: 7_000 });
    expect(state.snapshot()).toMatchObject({
      schedulerInstanceId: "scheduler-a",
      processId: 42,
      inFlight: 1,
      slotsInUse: 1,
      maxConcurrentRuns: DEFAULT_SCHEDULE_MAX_CONCURRENT_RUNS,
      inFlightRuns: [{ scheduleId: "schedule-a", runId: "run-a", slotWaitMs: 3_000, phase: "loading" }]
    });
    now += 1;
  });

  it("does not count pure queue waiting or cancellation finalization as occupied slots", () => {
    const state = new SchedulerRuntimeState({ instanceId: "scheduler-a", maxConcurrentRuns: 1 });
    state.begin({ scheduleId: "schedule-a", runId: "run-a", source: "automatic", phase: "queued" });
    state.begin({ scheduleId: "schedule-b", runId: "run-b", source: "run-now", phase: "cancelling" });
    expect(state.snapshot()).toMatchObject({ inFlight: 2, slotsInUse: 0 });
    expect(state.hasCapacity()).toBe(true);
    state.transition("run-a", "running");
    expect(state.snapshot().slotsInUse).toBe(1);
    expect(state.hasCapacity()).toBe(false);
  });

  it("projects stalled and recovering phases with only recovery occupying a slot", () => {
    const state = new SchedulerRuntimeState({ instanceId: "scheduler-a", maxConcurrentRuns: 1 });
    state.begin({ scheduleId: "schedule-a", runId: "run-a", source: "automatic", phase: "stalled" });
    expect(state.snapshot()).toMatchObject({ inFlight: 1, slotsInUse: 0 });
    state.begin({ scheduleId: "schedule-b", runId: "run-b", source: "automatic", phase: "recovering" });
    expect(state.snapshot()).toMatchObject({ inFlight: 2, slotsInUse: 1 });
  });

  it("keeps manual runs visible and lets them exceed the automatic gate", () => {
    const state = new SchedulerRuntimeState({ instanceId: "scheduler-a", maxConcurrentRuns: 1 });
    state.begin({ scheduleId: "schedule-a", runId: "run-a", source: "automatic", phase: "running" });
    expect(state.hasCapacity()).toBe(false);
    state.begin({ scheduleId: "schedule-b", runId: "run-b", source: "run-now", phase: "running" });
    expect(state.snapshot()).toMatchObject({ inFlight: 2, slotsInUse: 2, maxConcurrentRuns: 1 });
  });

  it("tracks progress without broadcasting the hot path", () => {
    let now = 1;
    const onChange = vi.fn();
    const state = new SchedulerRuntimeState({ instanceId: "scheduler-a", now: () => now, onChange });
    state.begin({ scheduleId: "schedule-a", runId: "run-a", source: "automatic" });
    now = 8;
    state.progress("run-a");
    expect(state.snapshot().inFlightRuns[0]?.lastProgressAt).toBe(8);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("updates phase metadata and emits immutable snapshots", () => {
    let now = 5;
    const snapshots: unknown[] = [];
    const state = new SchedulerRuntimeState({ instanceId: "scheduler-a", now: () => now, onChange: (value) => snapshots.push(value) });
    state.begin({ scheduleId: "schedule-a", runId: "run-a", source: "automatic" });
    now = 7;
    state.transition("run-a", "running", { scheduleName: "Named", executionMode: "script" });
    expect(state.snapshot().inFlightRuns[0]).toMatchObject({
      scheduleName: "Named",
      executionMode: "script",
      phase: "running",
      lastProgressAt: 7
    });
    expect(snapshots).toHaveLength(2);
  });

  it("orders gated schedules by oldest due time and suppresses unchanged broadcasts", () => {
    const onChange = vi.fn();
    const state = new SchedulerRuntimeState({ instanceId: "scheduler-a", onChange });
    const schedules = [
      { scheduleId: "b", scheduleName: "B", waitingSince: 20 },
      { scheduleId: "a", scheduleName: "A", waitingSince: 10 }
    ];
    state.syncWaiting(schedules);
    state.syncWaiting([...schedules].reverse());
    expect(state.snapshot().waitingSchedules).toEqual([
      { scheduleId: "a", scheduleName: "A", waitingSince: 10 },
      { scheduleId: "b", scheduleName: "B", waitingSince: 20 }
    ]);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("pairs finish and clear idempotently", () => {
    const onChange = vi.fn();
    const state = new SchedulerRuntimeState({ instanceId: "scheduler-a", onChange });
    state.begin({ scheduleId: "schedule-a", runId: "run-a", source: "automatic" });
    state.finish("run-a");
    state.finish("run-a");
    state.clear();
    expect(state.snapshot()).toMatchObject({ inFlight: 0, slotsInUse: 0, waitingSchedules: [] });
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid limits, identifiers, timestamps, and unbounded names", () => {
    expect(() => new SchedulerRuntimeState({ maxConcurrentRuns: 0 })).toThrow(/concurrency/);
    expect(() => new SchedulerRuntimeState({ maxConcurrentRuns: 257 })).toThrow(/concurrency/);
    const state = new SchedulerRuntimeState({ instanceId: "scheduler-a" });
    expect(() => state.begin({ scheduleId: "", runId: "run", source: "automatic" })).toThrow(/ID/);
    expect(() => state.syncWaiting([{ scheduleId: "schedule-a", scheduleName: "A", waitingSince: -1 }])).toThrow(/timestamp/);
    expect(() => state.syncWaiting([{ scheduleId: "schedule-a", scheduleName: "x".repeat(513), waitingSince: 1 }])).toThrow(/name/);
  });
});
