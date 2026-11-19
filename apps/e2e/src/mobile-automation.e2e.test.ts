import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { create } from "@bufbuild/protobuf";
import { TimestampSchema } from "@bufbuild/protobuf/wkt";
import { Code } from "@connectrpc/connect";
import {
  CloneProjectScheduleToUserMutationSchema,
  CreateScheduleMutationSchema,
  DeleteScheduleMutationSchema,
  EntityRefSchema,
  EntityKind,
  MarkAllScheduleRunsReadMutationSchema,
  OneShotRecurrenceSchema,
  OperationMutationSchema,
  OperationPreconditionSchema,
  OperationState,
  PermissionMode,
  PromoteScheduleToProjectMutationSchema,
  ReconcileProjectAutomationsMutationSchema,
  RemoveProjectScheduleMutationSchema,
  ScheduleExecutionSnapshotSchema,
  ScheduleGeneratedSessionDisposition,
  ScheduleInputSchema,
  ScheduleMisfirePolicy,
  ScheduleOverlapPolicy,
  ScheduleRecurrenceSchema,
  ScheduleRunOutcome,
  ScheduleSessionMode,
  ScheduleSource,
  ScheduleState,
  SetScheduleEnabledMutationSchema,
  TriggerScheduleMutationSchema,
  UpdateScheduleMutationSchema,
  type OperationMutation,
  type Schedule,
  type Target
} from "@joko/contracts";
import { PI_LIKE_PROFILE } from "@joko/testkit";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OrchestratorE2eFixture, waitFor } from "./fixture.js";
import {
  createManualScheduleMutation,
  createSessionMutation,
  scheduleIdFrom,
  sessionIdFrom,
  submit,
  textInput
} from "./operations.js";

describe("Mobile Automation product chain", () => {
  let fixture: OrchestratorE2eFixture | undefined;

  afterEach(async () => {
    await fixture?.close({ removeRoot: true });
    fixture = undefined;
  });

  it("serves complete catalog/detail/history and recovers a tracked Schedule mutation by Operation identity", async () => {
    fixture = await OrchestratorE2eFixture.start({
      profiles: [{ ...PI_LIKE_PROFILE, streamDelayMs: 20 }]
    });
    const mobile = await fixture.pair("mobile Automation client");
    const backendId = fixture.adapter().id;
    const targetId = fixture.targetId();
    const sessionId = sessionIdFrom(await submit(
      mobile.clients.operation,
      mobile.connectionId,
      createSessionMutation({ backendId, targetId, displayName: "Automation source task" })
    ));
    const scheduleIds = await Promise.all(["first mobile run", "second mobile run"].map(async (text) =>
      scheduleIdFrom(await submit(
        mobile.clients.operation,
        mobile.connectionId,
        createManualScheduleMutation({ backendId, targetId, sessionId, text })
      ))
    ));

    const firstPage = await mobile.clients.scheduler.listSchedules({
      page: { pageSize: 1, pageToken: "" }
    });
    expect(firstPage.page?.totalSize).toBe(2n);
    expect(firstPage.schedules).toHaveLength(1);
    expect(firstPage.page?.nextPageToken).not.toBe("");
    const secondPage = await mobile.clients.scheduler.listSchedules({
      page: { pageSize: 1, pageToken: firstPage.page?.nextPageToken }
    });
    expect(secondPage.page?.totalSize).toBe(2n);
    expect(secondPage.page?.nextPageToken).toBe("");
    expect(new Set([...firstPage.schedules, ...secondPage.schedules].map((item) => item.scheduleId)))
      .toEqual(new Set(scheduleIds));

    const scheduleId = scheduleIds[0]!;
    const detail = required(
      (await mobile.clients.scheduler.getSchedule({ scheduleId })).schedule,
      "Schedule detail"
    );
    expect(detail).toMatchObject({
      scheduleId,
      backendId,
      targetId,
      sessionId,
      state: ScheduleState.ENABLED
    });
    expect(required(detail.version?.revision, "Schedule revision").value).toBeGreaterThan(0n);
    const runtime = required(
      (await mobile.clients.scheduler.getSchedulerRuntime({})).runtime,
      "Scheduler runtime"
    );
    expect(runtime.schedulerInstanceId).not.toBe("");
    expect(runtime.maxConcurrentRuns).toBeGreaterThan(0);

    const operationId = randomUUID();
    const trigger = scheduleMutation(detail, {
      case: "triggerSchedule",
      value: create(TriggerScheduleMutationSchema, { scheduleId })
    });

    // Model a client that durably stored its receipt, dispatched once, and then
    // lost the response before updating local state. Recovery polls only the
    // original Operation identity; it never submits the Schedule effect again.
    await mobile.clients.operation.submitOperation({
      operationId,
      connectionId: mobile.connectionId,
      mutation: trigger
    });
    const recovered = await waitFor(
      async () => required(
        (await mobile.clients.operation.getOperation({ operationId })).operation,
        "recovered Schedule Operation"
      ),
      (operation) => operation.state === OperationState.SUCCEEDED,
      "tracked Schedule Operation recovery"
    );
    expect(recovered.operationId).toBe(operationId);
    expect(recovered.mutation?.payload).toMatchObject({
      case: "triggerSchedule",
      value: { scheduleId }
    });
    expect(recovered.mutation?.preconditions).toEqual([
      expect.objectContaining({
        entity: expect.objectContaining({ kind: EntityKind.SCHEDULE, id: scheduleId }),
        expectedRevision: expect.objectContaining({ value: detail.version!.revision!.value })
      })
    ]);

    const historyResponse = await waitFor(
      () => mobile.clients.scheduler.listScheduleRunHistory({
        scheduleId,
        page: { pageSize: 1, pageToken: "" }
      }),
      (response) => response.history.length === 1
        && response.history[0]?.outcome === ScheduleRunOutcome.SUCCEEDED,
      "mobile Automation run history"
    );
    expect(historyResponse.page).toMatchObject({ totalSize: 1n, nextPageToken: "" });
    const run = required(historyResponse.history[0], "Schedule run history item");
    expect(run).toMatchObject({ outcome: ScheduleRunOutcome.SUCCEEDED });
    expect(run.triggerId).not.toBe("");
    expect(run.runId).not.toBe("");
    expect(run.sessionId).not.toBe("");
    expect((await mobile.clients.session.getSession({ sessionId: run.sessionId })).session?.sessionId)
      .toBe(run.sessionId);
    expect(fixture.adapter().sendCalls.filter((call) => call.text === "first mobile run")).toHaveLength(1);

    const current = required(
      (await mobile.clients.scheduler.getSchedule({ scheduleId })).schedule,
      "current Schedule detail"
    );
    const disabled = await submit(
      mobile.clients.operation,
      mobile.connectionId,
      scheduleMutation(current, {
        case: "setScheduleEnabled",
        value: create(SetScheduleEnabledMutationSchema, { scheduleId, enabled: false })
      })
    );
    expect(disabled.state).toBe(OperationState.SUCCEEDED);
    const reread = required(
      (await mobile.clients.scheduler.getSchedule({ scheduleId })).schedule,
      "disabled Schedule detail"
    );
    expect(reread.state).toBe(ScheduleState.DISABLED);
    expect(reread.version?.revision?.value).toBeGreaterThan(current.version!.revision!.value);
  });

  it("clears a recurring Automation at its cutoff before its first due occurrence", async () => {
    const realNow = Date.now;
    const cutoff = Date.UTC(2027, 0, 1);
    const next = Date.UTC(2027, 0, 2);
    let offset = Date.UTC(2026, 11, 31, 12) - realNow();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
    try {
      const host = fixture = await OrchestratorE2eFixture.start();
      const owner = await host.pair("Automation cutoff owner");
      const at = (milliseconds: number) => create(TimestampSchema, { seconds: BigInt(milliseconds / 1000) });
      const recurrence = create(ScheduleRecurrenceSchema, { kind: { case: "cron", value: { expression: "0 0 2 1 *" } } });
      const createSchedule = async (name: string, expires: boolean) => resultSchedule(await submit(
        owner.clients.operation, owner.connectionId, create(OperationMutationSchema, {
          payload: { case: "createSchedule", value: create(CreateScheduleMutationSchema, {
            schedule: create(ScheduleInputSchema, {
              displayName: name, backendId: host.adapter().id, targetId: host.targetId(), sessionMode: ScheduleSessionMode.FRESH,
              recurrence, timeZone: "UTC", input: textInput(name), enabled: true,
              overlapPolicy: ScheduleOverlapPolicy.QUEUE, misfirePolicy: ScheduleMisfirePolicy.RUN_ONCE,
              execution: create(ScheduleExecutionSnapshotSchema, {
                permissionMode: PermissionMode.ASK,
                ...(expires ? { expireAt: at(cutoff) } : {})
              })
            })
          }) }
        })
      ));
      const original = await createSchedule("Expired Automation must not run", true);
      const other = await createSchedule("Unexpired Automation runs normally", false);
      const read = async (scheduleId: string) => required((await owner.clients.scheduler.getSchedule({ scheduleId })).schedule, "Automation detail");
      expect(await read(original.scheduleId)).toMatchObject({ state: ScheduleState.ENABLED, nextTriggerAt: at(next) });

      offset = cutoff - realNow();
      await host.application.scheduler.tick();
      const expired = await read(original.scheduleId);
      expect(expired.state).toBe(ScheduleState.DISABLED);
      expect(expired.nextTriggerAt).toBeUndefined();
      expect(expired.execution?.expireAt).toMatchObject(at(cutoff));
      expect(host.application.store.getSchedule(original.scheduleId)).toMatchObject({ enabled: false });
      expect(host.application.store.getSchedule(original.scheduleId).nextRunAt).toBeUndefined();
      const catalog = await owner.clients.scheduler.listSchedules({});
      const listed = required(catalog.schedules.find((entry) => entry.scheduleId === original.scheduleId), "expired Automation in catalog");
      expect(listed.state).toBe(ScheduleState.DISABLED);
      expect(listed.nextTriggerAt).toBeUndefined();
      expect(await read(other.scheduleId)).toMatchObject({ state: ScheduleState.ENABLED, nextTriggerAt: at(next) });

      offset = next - realNow();
      await host.application.scheduler.tick();
      await waitFor(() => owner.clients.scheduler.listScheduleRunHistory({ scheduleId: other.scheduleId }),
        (response) => response.history[0]?.outcome === ScheduleRunOutcome.SUCCEEDED, "unexpired Automation to trigger");
      expect((await owner.clients.scheduler.listScheduleRunHistory({ scheduleId: original.scheduleId })).history).toEqual([]);
      expect(host.adapter().sendCalls.map((call) => call.text)).toEqual(["Unexpired Automation runs normally"]);
    } finally { clock.mockRestore(); }
  });

  it("consumes a future one-shot when the Owner uses Run Now", async () => {
    fixture = await OrchestratorE2eFixture.start();
    const owner = await fixture.pair("One-shot schedule owner");
    const backendId = fixture.adapter().id;
    const targetId = fixture.targetId();
    const mutate = (mutation: OperationMutation) => submit(owner.clients.operation, owner.connectionId, mutation);
    const sessionId = sessionIdFrom(await mutate(createSessionMutation({ backendId, targetId, displayName: "One-shot task" })));
    const triggerAt = create(TimestampSchema, { seconds: BigInt(Math.floor(Date.now() / 1000) + 3_600) });
    const oneShot = (at: typeof triggerAt) => create(ScheduleRecurrenceSchema, {
      kind: { case: "oneShot", value: create(OneShotRecurrenceSchema, { triggerAt: at }) }
    });
    const input = create(ScheduleInputSchema, {
      displayName: "Run the plan early", backendId, targetId, sessionId, sessionMode: ScheduleSessionMode.BOUND,
      recurrence: oneShot(triggerAt), timeZone: "UTC",
      input: textInput("Execute the one-shot once"), overlapPolicy: ScheduleOverlapPolicy.QUEUE,
      misfirePolicy: ScheduleMisfirePolicy.RUN_ONCE, enabled: true
    });
    const created = resultSchedule(await mutate(create(OperationMutationSchema, {
      payload: { case: "createSchedule", value: create(CreateScheduleMutationSchema, { schedule: input }) }
    })));
    const scheduleId = created.scheduleId;
    const detail = async () => required((await owner.clients.scheduler.getSchedule({ scheduleId })).schedule, "one-shot Schedule");
    const enable = (schedule: Schedule, enabled: boolean) => mutate(scheduleMutation(schedule, {
      case: "setScheduleEnabled", value: create(SetScheduleEnabledMutationSchema, { scheduleId, enabled })
    }));

    const paused = resultSchedule(await enable(created, false));
    expect(paused.state).toBe(ScheduleState.DISABLED);
    expect(paused.nextTriggerAt).toMatchObject(triggerAt);
    const resumed = resultSchedule(await enable(paused, true));
    expect(resumed.state).toBe(ScheduleState.ENABLED);
    expect(resumed.nextTriggerAt).toMatchObject(triggerAt);

    expect((await mutate(scheduleMutation(resumed, {
      case: "triggerSchedule", value: create(TriggerScheduleMutationSchema, { scheduleId })
    }))).state).toBe(OperationState.SUCCEEDED);
    const consumed = await waitFor(detail, schedule => schedule.recentRuns[0]?.outcome === ScheduleRunOutcome.SUCCEEDED,
      "original one-shot run to finish");
    expect(consumed.state).toBe(ScheduleState.DISABLED);
    expect(consumed.recurrence?.kind.case).toBe("oneShot");
    expect(consumed.nextTriggerAt).toBeUndefined();
    expect(consumed.lastTriggeredAt).toBeDefined();
    expect(consumed.recentRuns).toHaveLength(1);
    expect(consumed.recentRuns[0]?.sessionId).toBe(sessionId);
    const listed = required((await owner.clients.scheduler.listSchedules({})).schedules.find(item => item.scheduleId === scheduleId), "listed Schedule");
    expect(listed.nextTriggerAt).toBeUndefined();
    await expect(enable(consumed, true)).rejects.toMatchObject({ code: Code.InvalidArgument });
    expect((await detail()).recentRuns.map(run => run.runId)).toEqual([consumed.recentRuns[0]?.runId]);
    expect(fixture.adapter().sendCalls.filter(call => call.text === "Execute the one-shot once")).toHaveLength(1);

    const rearmedAt = create(TimestampSchema, { seconds: triggerAt.seconds + 3_600n });
    const rearmed = resultSchedule(await mutate(scheduleMutation(consumed, {
      case: "updateSchedule", value: create(UpdateScheduleMutationSchema, {
        scheduleId, schedule: { ...input, recurrence: oneShot(rearmedAt) }
      })
    })));
    expect(rearmed.state).toBe(ScheduleState.ENABLED);
    expect(rearmed.nextTriggerAt).toMatchObject(rearmedAt);
  });

  it("reports unread history beyond the bounded owner snapshot and acknowledges it without deleting history", async () => {
    fixture = await OrchestratorE2eFixture.start();
    const mobile = await fixture.pair("mobile Automation history client");
    const scheduleId = scheduleIdFrom(await submit(mobile.clients.operation, mobile.connectionId, createManualScheduleMutation({
      backendId: fixture.adapter().id,
      targetId: fixture.targetId(),
      sessionId: "",
      sessionMode: ScheduleSessionMode.PERSISTENT,
      text: "Read automation history"
    })));
    const store = fixture.application.store;
    const firstFiredAt = Date.now() - 102_000;
    for (let index = 0; index <= 100; index += 1) {
      const firedAt = firstFiredAt + index * 1_000;
      const occurrence = store.recordScheduleOccurrence({
        scheduleId, runId: `history-${index}`, status: "success", firedAt, finishedAt: firedAt + 500
      });
      if (index > 0) store.markScheduleRunRead(scheduleId, occurrence.id);
    }
    const readOwnerSchedule = async () => required((await mobile.clients.event.getSnapshot({
      scope: { kind: { case: "owner", value: {} } }
    })).snapshot?.schedules.find((schedule) => schedule.scheduleId === scheduleId), "Owner Schedule");

    const owner = await readOwnerSchedule();
    expect(owner.recentRuns).toHaveLength(100);
    expect(owner.recentRuns.every((run) => run.readAt !== undefined)).toBe(true);
    expect(owner.recentRuns.some((run) => run.runId === "history-0")).toBe(false);
    expect(owner.unreadRunCount).toBe(1);
    expect((await mobile.clients.scheduler.getSchedule({ scheduleId })).schedule?.unreadRunCount).toBe(1);

    const receipt = await submit(mobile.clients.operation, mobile.connectionId, create(OperationMutationSchema, {
      payload: { case: "markAllScheduleRunsRead", value: create(MarkAllScheduleRunsReadMutationSchema) }
    }));
    expect(receipt.state).toBe(OperationState.SUCCEEDED);
    expect((await readOwnerSchedule()).unreadRunCount).toBe(0);
    expect(store.countScheduleRuns(scheduleId)).toBe(101);
    expect(store.findScheduleRunByRunId("history-0")?.readAt).toBeDefined();
  });

  it("persists mobile authoring, project ownership actions and typed deletion outcomes end to end", async () => {
    fixture = await OrchestratorE2eFixture.start({
      profiles: [{ ...PI_LIKE_PROFILE, streamDelayMs: 20 }]
    });
    const backendId = fixture.adapter().id;
    const targetId = fixture.targetId();
    const initialTarget = fixture.application.store.getTarget(targetId).descriptor;
    await fixture.application.sessionHost.registerTarget({
      ...initialTarget,
      managed: false
    }, { workspaceId: "workspace-main" });
    const mobile = await fixture.pair("mobile Automation authoring client");
    const owner = required((await mobile.clients.event.getSnapshot({
      scope: { kind: { case: "owner", value: {} } }
    })).snapshot, "owner snapshot");
    const target = required(owner.targets.find((candidate) => candidate.targetId === targetId), "Automation Target");
    const createBase = createManualScheduleMutation({
      backendId,
      targetId,
      sessionId: "",
      sessionMode: ScheduleSessionMode.PERSISTENT,
      text: "Inspect the mobile authoring chain"
    });
    const created = resultSchedule(await submit(
      mobile.clients.operation,
      mobile.connectionId,
      create(OperationMutationSchema, {
        ...createBase,
        preconditions: [targetPrecondition(target)]
      })
    ));
    expect(created).toMatchObject({ source: ScheduleSource.USER, targetId, displayName: "E2E unattended schedule" });

    const updated = resultSchedule(await submit(
      mobile.clients.operation,
      mobile.connectionId,
      create(OperationMutationSchema, {
        preconditions: [targetPrecondition(target), schedulePrecondition(created)],
        payload: { case: "updateSchedule", value: create(UpdateScheduleMutationSchema, {
          scheduleId: created.scheduleId,
          schedule: scheduleInput(created, "E2E mobile edited schedule")
        }) }
      })
    ));
    expect(updated.displayName).toBe("E2E mobile edited schedule");
    expect(updated.version?.revision?.value).toBeGreaterThan(created.version!.revision!.value);

    const promoted = resultSchedule(await submit(
      mobile.clients.operation,
      mobile.connectionId,
      create(OperationMutationSchema, {
        preconditions: [schedulePrecondition(updated), targetPrecondition(target)],
        payload: { case: "promoteScheduleToProject", value: create(PromoteScheduleToProjectMutationSchema, {
          scheduleId: updated.scheduleId
        }) }
      })
    ));
    expect(promoted).toMatchObject({ source: ScheduleSource.PROJECT, targetId });
    expect(promoted.projectConfigId).not.toBe("");
    expect(promoted.projectConfigPath).not.toBe("");

    const cloned = resultSchedule(await submit(
      mobile.clients.operation,
      mobile.connectionId,
      create(OperationMutationSchema, {
        preconditions: [schedulePrecondition(promoted), targetPrecondition(target)],
        payload: { case: "cloneProjectScheduleToUser", value: create(CloneProjectScheduleToUserMutationSchema, {
          scheduleId: promoted.scheduleId,
          displayName: "E2E mobile personal copy"
        }) }
      })
    ));
    expect(cloned).toMatchObject({ source: ScheduleSource.USER, displayName: "E2E mobile personal copy", targetId });

    const scheduleId = promoted.scheduleId;
    const readProject = async () => required((await mobile.clients.scheduler.getSchedule({ scheduleId })).schedule, "project Schedule");
    const triggerProject = async (schedule: Schedule, expectedCount: number) => {
      const trigger = await submit(mobile.clients.operation, mobile.connectionId, scheduleMutation(schedule, {
        case: "triggerSchedule", value: create(TriggerScheduleMutationSchema, { scheduleId })
      }));
      expect(trigger.state).toBe(OperationState.SUCCEEDED);
      return (await waitFor(
        () => mobile.clients.scheduler.listScheduleRunHistory({ scheduleId }),
        response => response.history.length === expectedCount && response.history.every(run => run.outcome === ScheduleRunOutcome.SUCCEEDED),
        "persistent project Schedule runs"
      )).history;
    };
    const [first] = await triggerProject(promoted, 1);
    const bound = await readProject();
    expect(bound.sessionId).not.toBe("");
    expect(bound.sessionId).toBe(first!.sessionId);

    const reconciled = await submit(
      mobile.clients.operation,
      mobile.connectionId,
      create(OperationMutationSchema, {
        preconditions: [targetPrecondition(target)],
        payload: { case: "reconcileProjectAutomations", value: create(ReconcileProjectAutomationsMutationSchema, { targetId }) }
      })
    );
    expect(reconciled.result?.payload).toMatchObject({ case: "acknowledgement", value: { accepted: true } });

    const afterReconcile = await readProject();
    expect(afterReconcile.sessionId).toBe(bound.sessionId);
    expect(afterReconcile.version?.revision?.value).toBe(bound.version!.revision!.value);
    const editedProject = resultSchedule(await submit(mobile.clients.operation, mobile.connectionId,
      scheduleMutation(afterReconcile, { case: "updateSchedule", value: create(UpdateScheduleMutationSchema, {
        scheduleId, schedule: scheduleInput(afterReconcile, "Edited persistent project automation")
      }) })
    ));
    expect(editedProject).toMatchObject({ sessionId: bound.sessionId, displayName: "Edited persistent project automation" });
    const config = await readFile(join(initialTarget.workspaceRoot, promoted.projectConfigPath), "utf8");
    expect(config).toContain("Edited persistent project automation");
    expect(config).not.toContain(bound.sessionId);
    expect((await triggerProject(editedProject, 2)).map(run => run.sessionId)).toEqual([bound.sessionId, bound.sessionId]);

    const currentProject = await readProject();
    const personalCopy = resultSchedule(await submit(
      mobile.clients.operation,
      mobile.connectionId,
      create(OperationMutationSchema, {
        preconditions: [schedulePrecondition(currentProject), targetPrecondition(target)],
        payload: { case: "removeProjectSchedule", value: create(RemoveProjectScheduleMutationSchema, {
          scheduleId: currentProject.scheduleId,
          keepPersonalCopy: true
        }) }
      })
    ));
    expect(personalCopy).toMatchObject({ source: ScheduleSource.USER, targetId });

    const deletionSubmitted = await submit(
      mobile.clients.operation,
      mobile.connectionId,
      create(OperationMutationSchema, {
        preconditions: [schedulePrecondition(cloned)],
        payload: { case: "deleteSchedule", value: create(DeleteScheduleMutationSchema, {
          scheduleId: cloned.scheduleId,
          generatedSessionDisposition: ScheduleGeneratedSessionDisposition.KEEP
        }) }
      })
    );
    const deleted = deletionSubmitted.state === OperationState.SUCCEEDED
      ? deletionSubmitted
      : await waitFor(
        async () => required(
          (await mobile.clients.operation.getOperation({ operationId: deletionSubmitted.operationId })).operation,
          "Automation deletion Operation"
        ),
        (operation) => operation.state === OperationState.SUCCEEDED,
        "mobile Automation deletion"
      );
    expect(deleted.result?.payload).toMatchObject({
      case: "scheduleDeletion",
      value: {
        scheduleId: cloned.scheduleId,
        generatedSessionDisposition: ScheduleGeneratedSessionDisposition.KEEP,
        generatedSessionIds: [],
        completedSessionIds: [],
        failures: []
      }
    });
    await expect(mobile.clients.scheduler.getSchedule({ scheduleId: cloned.scheduleId })).rejects.toBeDefined();
  });
});

function scheduleMutation(
  schedule: Schedule,
  payload: OperationMutation["payload"]
): OperationMutation {
  const revision = required(schedule.version?.revision, "Schedule revision");
  return create(OperationMutationSchema, {
    preconditions: [{
      entity: { kind: EntityKind.SCHEDULE, id: schedule.scheduleId },
      expectedRevision: revision,
      expectedGeneration: schedule.version?.generation ?? 0n
    }],
    payload
  });
}

function targetPrecondition(target: Target) {
  return create(OperationPreconditionSchema, {
    entity: create(EntityRefSchema, { kind: EntityKind.TARGET, id: target.targetId }),
    expectedRevision: required(target.version?.revision, "Target revision")
  });
}

function schedulePrecondition(schedule: Schedule) {
  return create(OperationPreconditionSchema, {
    entity: create(EntityRefSchema, { kind: EntityKind.SCHEDULE, id: schedule.scheduleId }),
    expectedRevision: required(schedule.version?.revision, "Schedule revision")
  });
}

function scheduleInput(schedule: Schedule, displayName: string) {
  return create(ScheduleInputSchema, {
    displayName,
    backendId: schedule.backendId,
    targetId: schedule.targetId,
    sessionId: schedule.sessionId,
    sessionMode: schedule.sessionMode,
    recurrence: required(schedule.recurrence, "Schedule recurrence"),
    timeZone: schedule.timeZone,
    input: schedule.input,
    execution: schedule.execution,
    overlapPolicy: schedule.overlapPolicy,
    misfirePolicy: schedule.misfirePolicy,
    enabled: schedule.state === ScheduleState.ENABLED || schedule.state === ScheduleState.RUNNING
  });
}

function resultSchedule(operation: Awaited<ReturnType<typeof submit>>): Schedule {
  const payload = operation.result?.payload;
  if (payload?.case !== "schedule") {
    throw new Error(`Expected typed Schedule result, received ${String(payload?.case)}.`);
  }
  return payload.value;
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Orchestrator returned no ${label}.`);
  return value;
}
