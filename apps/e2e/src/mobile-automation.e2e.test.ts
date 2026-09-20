import { randomUUID } from "node:crypto";

import { create } from "@bufbuild/protobuf";
import {
  EntityKind,
  OperationMutationSchema,
  OperationState,
  ScheduleRunOutcome,
  ScheduleState,
  SetScheduleEnabledMutationSchema,
  TriggerScheduleMutationSchema,
  type OperationMutation,
  type Schedule
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

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Orchestrator returned no ${label}.`);
  return value;
}
