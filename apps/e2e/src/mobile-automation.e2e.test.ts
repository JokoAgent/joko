import { randomUUID } from "node:crypto";

import { create } from "@bufbuild/protobuf";
import {
  CloneProjectScheduleToUserMutationSchema,
  DeleteScheduleMutationSchema,
  EntityRefSchema,
  EntityKind,
  OperationMutationSchema,
  OperationPreconditionSchema,
  OperationState,
  PromoteScheduleToProjectMutationSchema,
  ReconcileProjectAutomationsMutationSchema,
  RemoveProjectScheduleMutationSchema,
  ScheduleGeneratedSessionDisposition,
  ScheduleInputSchema,
  ScheduleRunOutcome,
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
import { afterEach, describe, expect, it } from "vitest";

import { OrchestratorE2eFixture, waitFor } from "./fixture.js";
import {
  createManualScheduleMutation,
  createSessionMutation,
  scheduleIdFrom,
  sessionIdFrom,
  submit
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

    const reconciled = await submit(
      mobile.clients.operation,
      mobile.connectionId,
      create(OperationMutationSchema, {
        preconditions: [targetPrecondition(target)],
        payload: { case: "reconcileProjectAutomations", value: create(ReconcileProjectAutomationsMutationSchema, { targetId }) }
      })
    );
    expect(reconciled.result?.payload).toMatchObject({ case: "acknowledgement", value: { accepted: true } });

    const currentProject = required(
      (await mobile.clients.scheduler.getSchedule({ scheduleId: promoted.scheduleId })).schedule,
      "reconciled project Schedule"
    );
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
