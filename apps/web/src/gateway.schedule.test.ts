import { create } from "@bufbuild/protobuf";
import type { Transport } from "@connectrpc/connect";
import {
  GetSchedulerRuntimeResponseSchema,
  GetSnapshotResponseSchema,
  ManualRecurrenceSchema,
  OperationState,
  PermissionMode,
  ScheduleExecutionSnapshotSchema,
  ScheduleExecutionMode,
  ScheduleFireSource,
  ScheduleMisfirePolicy,
  ScheduleOverlapPolicy,
  ScheduleRecurrenceSchema,
  ScheduleRunPhase,
  ScheduleSchema,
  ScheduleSessionMode,
  ScheduleSource,
  ScheduleState,
  SchedulerRuntimeSnapshotSchema,
  SnapshotSchema,
  SubmitOperationResponseSchema
} from "@joko/contracts";
import { describe, expect, it, vi } from "vitest";

import { createOrchestratorGateway, mapSnapshot } from "./gateway.js";

describe("schedule gateway snapshots", () => {
  it("serializes a one-shot wall clock in its IANA timezone and retains scoped directories", async () => {
    const payloads: any[] = [];
    const transport = {
      unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
        if (method.localName === "getSnapshot") {
          return response(method, create(GetSnapshotResponseSchema, {
            snapshot: create(SnapshotSchema, { generation: 1n, resumeCursor: { generation: 1n, sequence: 0n } })
          }));
        }
        if (method.localName === "submitOperation") {
          payloads.push(input.mutation?.payload);
          return response(method, create(SubmitOperationResponseSchema, {
            operation: { operationId: input.operationId, connectionId: input.connectionId, state: OperationState.SUCCEEDED }
          }));
        }
        throw new Error(`Unexpected method: ${method.localName}`);
      }),
      stream: vi.fn(async (method: any) => response(method, idleStream(), true))
    } as unknown as Transport;
    const gateway = createOrchestratorGateway({ id: "connection-schedule", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example" , serverId: "server-test" }, "secret", {}, () => transport);
    await gateway.connect();

    await gateway.saveSchedule(undefined, {
      name: "Shanghai morning",
      backendId: "backend-one",
      targetId: "target-one",
      sessionMode: "fresh",
      sessionId: "",
      enabled: true,
      kind: "once",
      expression: "2026-08-24T09:30",
      timezone: "Asia/Shanghai",
      inputText: "Continue",
      executionMode: "agent",
      useWorktree: true,
      worktreeSourceRef: "refs/heads/feature/schedule",
      refreshWorktreeRemote: true,
      scriptCommand: "",
      scriptDispatchSessions: false,
      providerId: "provider-one",
      modelId: "model-one",
      effort: "high",
      fastMode: true,
      permissionMode: "auto",
      planMode: true,
      extraDirectoryIds: ["extra-worktree"],
      silentWhenIdle: true,
      notifyDesktop: false,
      expireAtExpression: "2026-08-25T09:30",
      overlapPolicy: "queue",
      misfirePolicy: "runOnce"
    });

    const schedule = payloads[0]?.value.schedule;
    expect(schedule.execution.extraDirectoryIds).toEqual(["extra-worktree"]);
    expect(schedule.execution).toMatchObject({
      executionMode: 1,
      useWorktree: true,
      worktreeSourceRef: "refs/heads/feature/schedule",
      refreshWorktreeRemote: true,
      silentWhenIdle: true,
      notify: { desktop: false }
    });
    expect(schedule.recurrence.kind.case).toBe("oneShot");
    expect(schedule.recurrence.kind.value.triggerAt.seconds).toBe(BigInt(Date.UTC(2026, 7, 24, 1, 30) / 1_000));

    await gateway.saveSchedule(undefined, {
      name: "Local script",
      backendId: "backend-one",
      targetId: "target-one",
      sessionMode: "persistent",
      sessionId: "session-must-not-bind",
      enabled: true,
      kind: "manual",
      expression: "",
      timezone: "UTC",
      inputText: "",
      executionMode: "script",
      useWorktree: false,
      refreshWorktreeRemote: false,
      scriptCommand: "node scripts/report.mjs",
      scriptTimeoutMs: 45_000,
      scriptDispatchSessions: true,
      providerId: "provider-must-not-dispatch",
      modelId: "model-must-not-dispatch",
      fastMode: true,
      permissionMode: "ask",
      planMode: true,
      extraDirectoryIds: ["extra-must-not-dispatch"],
      silentWhenIdle: true,
      notifyDesktop: true,
      expireAtExpression: "",
      overlapPolicy: "skip",
      misfirePolicy: "skip"
    });
    const scriptSchedule = payloads[1]?.value.schedule;
    expect(scriptSchedule).toMatchObject({ sessionId: "", sessionMode: 1 });
    expect(scriptSchedule.execution).toMatchObject({
      executionMode: 2,
      planMode: false,
      extraDirectoryIds: [],
      silentWhenIdle: false,
      script: {
        command: "node scripts/report.mjs",
        timeout: { seconds: 45n },
        capabilities: [1]
      }
    });
    expect(scriptSchedule.execution.model).toBeUndefined();
    gateway.disconnect();
  });

  it("maps the bounded scheduler process snapshot without exposing task content", async () => {
    const transport = {
      unary: vi.fn(async (method: any) => {
        if (method.localName === "getSnapshot") {
          return response(method, create(GetSnapshotResponseSchema, {
            snapshot: create(SnapshotSchema, { generation: 1n, resumeCursor: { generation: 1n, sequence: 0n } })
          }));
        }
        if (method.localName === "getSchedulerRuntime") {
          return response(method, create(GetSchedulerRuntimeResponseSchema, {
            runtime: create(SchedulerRuntimeSnapshotSchema, {
              schedulerInstanceId: "scheduler-a",
              processId: 4_242,
              inFlight: 4,
              slotsInUse: 2,
              maxConcurrentRuns: 8,
              inFlightRuns: [
                {
                  scheduleId: "schedule-running",
                  scheduleName: "Nightly checks",
                  runId: "run-one",
                  source: ScheduleFireSource.AUTOMATIC,
                  executionMode: ScheduleExecutionMode.SCRIPT,
                  startedAt: { seconds: 1_000n, nanos: 500_000_000 },
                  slotWait: { seconds: 2n, nanos: 250_000_000 },
                  phase: ScheduleRunPhase.RUNNING,
                  lastProgressAt: { seconds: 1_003n, nanos: 0 }
                },
                {
                  scheduleId: "schedule-queued",
                  source: ScheduleFireSource.RUN_NOW,
                  executionMode: ScheduleExecutionMode.AGENT,
                  startedAt: { seconds: 1_004n, nanos: 0 },
                  phase: ScheduleRunPhase.QUEUED,
                  lastProgressAt: { seconds: 1_005n, nanos: 0 }
                },
                {
                  scheduleId: "schedule-stalled",
                  source: ScheduleFireSource.AUTOMATIC,
                  executionMode: ScheduleExecutionMode.AGENT,
                  startedAt: { seconds: 1_006n, nanos: 0 },
                  phase: ScheduleRunPhase.STALLED,
                  lastProgressAt: { seconds: 1_007n, nanos: 0 }
                },
                {
                  scheduleId: "schedule-recovering",
                  source: ScheduleFireSource.AUTOMATIC,
                  executionMode: ScheduleExecutionMode.AGENT,
                  startedAt: { seconds: 1_008n, nanos: 0 },
                  phase: ScheduleRunPhase.RECOVERING,
                  lastProgressAt: { seconds: 1_009n, nanos: 0 }
                }
              ],
              waitingTasks: [{
                scheduleId: "schedule-waiting",
                scheduleName: "Capacity wait",
                waitingSince: { seconds: 1_006n, nanos: 0 }
              }]
            })
          }));
        }
        throw new Error(`Unexpected method: ${method.localName}`);
      }),
      stream: vi.fn(async (method: any) => response(method, idleStream(), true))
    } as unknown as Transport;
    const gateway = createOrchestratorGateway({ id: "connection-runtime", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example" , serverId: "server-test" }, "secret", {}, () => transport);
    await gateway.connect();

    await expect(gateway.getSchedulerRuntime()).resolves.toEqual({
      instanceId: "scheduler-a",
      processId: 4_242,
      inFlight: 4,
      slotsInUse: 2,
      maxConcurrentRuns: 8,
      runs: [
        {
          scheduleId: "schedule-running",
          scheduleName: "Nightly checks",
          runId: "run-one",
          source: "automatic",
          executionMode: "script",
          startedAt: 1_000_500,
          slotWaitMs: 2_250,
          phase: "running",
          lastProgressAt: 1_003_000
        },
        {
          scheduleId: "schedule-queued",
          source: "runNow",
          executionMode: "agent",
          startedAt: 1_004_000,
          phase: "queued",
          lastProgressAt: 1_005_000
        },
        {
          scheduleId: "schedule-stalled",
          source: "automatic",
          executionMode: "agent",
          startedAt: 1_006_000,
          phase: "stalled",
          lastProgressAt: 1_007_000
        },
        {
          scheduleId: "schedule-recovering",
          source: "automatic",
          executionMode: "agent",
          startedAt: 1_008_000,
          phase: "recovering",
          lastProgressAt: 1_009_000
        }
      ],
      waiting: [{ scheduleId: "schedule-waiting", scheduleName: "Capacity wait", waitingSince: 1_006_000 }]
    });
    gateway.disconnect();
  });

  it("maps isolated workspace fields from the authoritative Schedule snapshot", () => {
    const snapshot = mapSnapshot(create(SnapshotSchema, {
      schedules: [create(ScheduleSchema, {
        scheduleId: "schedule-isolated",
        displayName: "Isolated review",
        source: ScheduleSource.PROJECT,
        projectConfigId: "release-review",
        projectConfigPath: ".joko/automations/schedules.json",
        state: ScheduleState.ENABLED,
        backendId: "backend-one",
        targetId: "target-one",
        sessionMode: ScheduleSessionMode.FRESH,
        recurrence: create(ScheduleRecurrenceSchema, {
          kind: { case: "manual", value: create(ManualRecurrenceSchema, {}) }
        }),
        timeZone: "UTC",
        execution: create(ScheduleExecutionSnapshotSchema, {
          executionMode: ScheduleExecutionMode.AGENT,
          permissionMode: PermissionMode.ASK,
          useWorktree: true,
          worktreeSourceRef: "refs/heads/release",
          refreshWorktreeRemote: true
        }),
        overlapPolicy: ScheduleOverlapPolicy.QUEUE,
        misfirePolicy: ScheduleMisfirePolicy.RUN_ONCE
      })]
    }));

    expect(snapshot.schedules).toEqual([
      expect.objectContaining({
        id: "schedule-isolated",
        source: "project",
        projectConfigId: "release-review",
        projectConfigPath: ".joko/automations/schedules.json",
        sessionMode: "fresh",
        executionMode: "agent",
        useWorktree: true,
        worktreeSourceRef: "refs/heads/release",
        refreshWorktreeRemote: true
      })
    ]);
  });

  it("submits project automation reconcile, promote, clone, and demote mutations", async () => {
    const payloads: any[] = [];
    const transport = {
      unary: vi.fn(async (method: any, _signal: unknown, _timeout: unknown, _headers: unknown, input: any) => {
        if (method.localName === "getSnapshot") {
          return response(method, create(GetSnapshotResponseSchema, {
            snapshot: create(SnapshotSchema, { generation: 1n, resumeCursor: { generation: 1n, sequence: 0n } })
          }));
        }
        if (method.localName === "submitOperation") {
          payloads.push(input.mutation?.payload);
          return response(method, create(SubmitOperationResponseSchema, {
            operation: { operationId: input.operationId, connectionId: input.connectionId, state: OperationState.SUCCEEDED }
          }));
        }
        throw new Error(`Unexpected method: ${method.localName}`);
      }),
      stream: vi.fn(async (method: any) => response(method, idleStream(), true))
    } as unknown as Transport;
    const gateway = createOrchestratorGateway({ id: "connection-project-schedule", deviceId: "device-test", name: "Browser", origin: "https://orchestrator.example", serverId: "server-test" }, "secret", {}, () => transport);
    await gateway.connect();

    await gateway.reconcileProjectAutomations("target-one");
    await gateway.promoteScheduleToProject("schedule-user");
    await gateway.cloneProjectScheduleToUser("schedule-project", "Copy of Nightly");
    await gateway.removeProjectSchedule("schedule-project", true);

    expect(payloads).toEqual([
      { case: "reconcileProjectAutomations", value: expect.objectContaining({ targetId: "target-one" }) },
      { case: "promoteScheduleToProject", value: expect.objectContaining({ scheduleId: "schedule-user" }) },
      { case: "cloneProjectScheduleToUser", value: expect.objectContaining({ scheduleId: "schedule-project", displayName: "Copy of Nightly" }) },
      { case: "removeProjectSchedule", value: expect.objectContaining({ scheduleId: "schedule-project", keepPersonalCopy: true }) }
    ]);
    gateway.disconnect();
  });
});

function response(method: any, message: unknown, stream = false): any {
  return { stream, service: method.parent, method, header: new Headers(), trailer: new Headers(), message };
}

async function* idleStream(): AsyncIterable<never> {
  await new Promise<never>(() => undefined);
}
