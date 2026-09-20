import { create } from "@bufbuild/protobuf";
import { TimestampSchema, type Timestamp } from "@bufbuild/protobuf/wkt";
import {
  RunState,
  ScheduleExecutionMode,
  ScheduleFireSource,
  ScheduleMisfirePolicy,
  ScheduleOverlapPolicy,
  ScheduleRunCostAttribution,
  ScheduleRunHistorySchema,
  ScheduleRunOutcome,
  ScheduleRunPhase,
  ScheduleSchema,
  ScheduleSessionMode,
  ScheduleSource,
  ScheduleState,
  SchedulerRuntimeSnapshotSchema,
  type Schedule,
  type ScheduleRunHistory
} from "@joko/contracts";
import { describe, expect, it } from "vitest";
import {
  canRestartMobileAutomationRun,
  groupMobileAutomationSchedules,
  isMobileAutomationRunTerminal,
  isMobileAutomationRunUnread,
  projectMobileAutomationCatalog,
  projectMobileAutomationHistory,
  projectMobileAutomationRun,
  projectMobileAutomationSchedule,
  projectMobileSchedulerRuntime
} from "./mobile-automation";

function timestamp(milliseconds: number): Timestamp {
  return create(TimestampSchema, {
    seconds: BigInt(Math.floor(milliseconds / 1_000)),
    nanos: milliseconds % 1_000 * 1_000_000
  });
}

function run(
  triggerId: string,
  patch: Partial<ScheduleRunHistory> = {}
): ScheduleRunHistory {
  return Object.assign(create(ScheduleRunHistorySchema, {
    triggerId,
    runId: `run-${triggerId}`,
    scheduledFor: timestamp(1_000),
    triggeredAt: timestamp(2_000),
    finishedAt: timestamp(3_000),
    state: RunState.SUCCEEDED,
    outcome: ScheduleRunOutcome.SUCCEEDED,
    costAttribution: ScheduleRunCostAttribution.UNAVAILABLE,
    duration: { seconds: 1n }
  }), patch);
}

function schedule(
  scheduleId: string,
  patch: Partial<Schedule> = {}
): Schedule {
  return Object.assign(create(ScheduleSchema, {
    scheduleId,
    displayName: `Schedule ${scheduleId}`,
    state: ScheduleState.ENABLED,
    backendId: "backend",
    targetId: "target",
    recurrence: { kind: { case: "manual", value: {} } },
    timeZone: "UTC",
    execution: { executionMode: ScheduleExecutionMode.AGENT },
    overlapPolicy: ScheduleOverlapPolicy.QUEUE,
    misfirePolicy: ScheduleMisfirePolicy.RUN_ONCE,
    sessionMode: ScheduleSessionMode.FRESH,
    source: ScheduleSource.USER,
    version: { revision: { value: 1n, etag: `etag-${scheduleId}` }, generation: 1n, updatedAt: timestamp(4_000) }
  }), patch);
}

describe("mobile Automation projection", () => {
  it("projects, sorts, filters and groups exact dialogue and project Schedules", () => {
    const dialogue = schedule("dialogue", { state: ScheduleState.DISABLED, lastTriggeredAt: timestamp(5_000) });
    const project = schedule("project", {
      state: ScheduleState.RUNNING,
      source: ScheduleSource.PROJECT,
      projectConfigId: "config",
      projectConfigPath: ".joko/automations/project.json",
      recentRuns: [run("one")],
      unreadRunCount: 1
    });

    const projected = projectMobileAutomationCatalog([dialogue, project]);

    expect(projected.map((item) => item.scheduleId)).toEqual(["project", "dialogue"]);
    expect(groupMobileAutomationSchedules(projected, "all").map((group) => ({
      kind: group.kind,
      ids: group.schedules.map((item) => item.scheduleId)
    }))).toEqual([
      { kind: "project", ids: ["project"] },
      { kind: "dialogue", ids: ["dialogue"] }
    ]);
    expect(groupMobileAutomationSchedules(projected, "active")[0]?.schedules[0]?.scheduleId).toBe("project");
    expect(groupMobileAutomationSchedules(projected, "paused")[0]?.schedules[0]?.scheduleId).toBe("dialogue");
  });

  it("rejects duplicate, unfenced and unknown Schedule authority", () => {
    const value = schedule("same");
    expect(() => projectMobileAutomationCatalog([value, value])).toThrow(/duplicate Automation Schedule/);
    expect(() => projectMobileAutomationSchedule(schedule("missing", { version: undefined }))).toThrow(/unfenced/);
    expect(() => projectMobileAutomationSchedule(schedule("unknown", { state: 99 as ScheduleState }))).toThrow(/unknown Automation Schedule state/);
    expect(() => projectMobileAutomationSchedule(schedule("wrong"), "other")).toThrow(/different Automation Schedule/);
  });

  it("requires exact project, recurrence and bound-task metadata", () => {
    expect(() => projectMobileAutomationSchedule(schedule("project", { source: ScheduleSource.PROJECT }))).toThrow(/configuration identity/);
    expect(() => projectMobileAutomationSchedule(schedule("bound", { sessionMode: ScheduleSessionMode.BOUND }))).toThrow(/without a task/);
    expect(() => projectMobileAutomationSchedule(schedule("recurrence", { recurrence: undefined }))).toThrow(/unknown Automation recurrence/);
  });
});

describe("mobile Automation history", () => {
  it("projects read, terminal, open-task and restart eligibility without guessing a task", () => {
    const completed = projectMobileAutomationRun(run("completed", { sessionId: "session" }));
    const interrupted = projectMobileAutomationRun(run("interrupted", {
      state: RunState.ABORTED,
      outcome: ScheduleRunOutcome.INTERRUPTED,
      readAt: timestamp(4_000)
    }));
    const skipped = projectMobileAutomationRun(run("skipped", { outcome: ScheduleRunOutcome.SKIPPED }));

    expect(isMobileAutomationRunTerminal(completed)).toBe(true);
    expect(isMobileAutomationRunUnread(completed)).toBe(true);
    expect(canRestartMobileAutomationRun(completed)).toBe(false);
    expect(isMobileAutomationRunUnread(interrupted)).toBe(false);
    expect(canRestartMobileAutomationRun(interrupted)).toBe(true);
    expect(isMobileAutomationRunUnread(skipped)).toBe(false);
  });

  it("rejects duplicate triggers, unknown outcomes and inconsistent terminal timestamps", () => {
    const value = run("same");
    expect(() => projectMobileAutomationHistory("schedule", [value, value])).toThrow(/duplicate Automation run trigger/);
    expect(() => projectMobileAutomationRun(run("unknown", { outcome: 99 as ScheduleRunOutcome }))).toThrow(/unknown Automation run outcome/);
    expect(() => projectMobileAutomationRun(run("unfinished", { finishedAt: undefined }))).toThrow(/without a finish time/);
    expect(() => projectMobileAutomationRun(run("running", {
      state: RunState.RUNNING,
      outcome: ScheduleRunOutcome.RUNNING
    }))).toThrow(/with a finish time/);
  });
});

describe("mobile Scheduler runtime", () => {
  it("counts exact in-flight and waiting work for pause confirmation", () => {
    const runtime = create(SchedulerRuntimeSnapshotSchema, {
      schedulerInstanceId: "scheduler",
      inFlight: 1,
      slotsInUse: 1,
      maxConcurrentRuns: 4,
      inFlightRuns: [{
        scheduleId: "schedule",
        runId: "run",
        source: ScheduleFireSource.RUN_NOW,
        executionMode: ScheduleExecutionMode.AGENT,
        startedAt: timestamp(1_000),
        phase: ScheduleRunPhase.RUNNING,
        lastProgressAt: timestamp(2_000)
      }],
      waitingTasks: [{ scheduleId: "schedule", waitingSince: timestamp(2_500) }]
    });

    expect(projectMobileSchedulerRuntime(runtime, new Set(["schedule"]))).toMatchObject({
      instanceId: "scheduler",
      inFlightBySchedule: { schedule: 1 },
      waitingBySchedule: { schedule: 1 }
    });
  });

  it("rejects cross-catalog references, duplicate runs and unknown runtime enums", () => {
    const base = create(SchedulerRuntimeSnapshotSchema, {
      schedulerInstanceId: "scheduler",
      inFlight: 1,
      slotsInUse: 1,
      maxConcurrentRuns: 1,
      inFlightRuns: [{
        scheduleId: "other",
        runId: "run",
        source: ScheduleFireSource.AUTOMATIC,
        executionMode: ScheduleExecutionMode.AGENT,
        startedAt: timestamp(1_000),
        phase: ScheduleRunPhase.RUNNING,
        lastProgressAt: timestamp(2_000)
      }]
    });
    expect(() => projectMobileSchedulerRuntime(base, new Set(["schedule"]))).toThrow(/unknown Schedule/);
    expect(() => projectMobileSchedulerRuntime(create(SchedulerRuntimeSnapshotSchema, {
      ...base,
      inFlight: 2,
      slotsInUse: 2,
      inFlightRuns: [base.inFlightRuns[0]!, { ...base.inFlightRuns[0]! }]
    }), new Set(["other"]))).toThrow(/duplicate run/);
    expect(() => projectMobileSchedulerRuntime(create(SchedulerRuntimeSnapshotSchema, {
      ...base,
      inFlightRuns: [{ ...base.inFlightRuns[0]!, phase: 99 as ScheduleRunPhase }]
    }), new Set(["other"]))).toThrow(/unknown Scheduler run phase/);
  });
});
