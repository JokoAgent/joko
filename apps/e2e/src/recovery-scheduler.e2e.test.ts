import { randomUUID } from "node:crypto";

import { QueueDispatchState, QueueItemState, RunState, type QueueControl } from "@joko/contracts";
import { PI_LIKE_PROFILE } from "@joko/testkit";
import { afterEach, describe, expect, it } from "vitest";

import { OrchestratorE2eFixture, waitFor } from "./fixture.js";
import {
  createManualScheduleMutation,
  createSessionMutation,
  pauseQueueMutation,
  queueItemIdFrom,
  queueRunIdFrom,
  resumeQueueMutation,
  scheduleIdFrom,
  sendInputMutation,
  sessionIdFrom,
  submit
} from "./operations.js";

describe("Orchestrator restart recovery and unattended schedules", () => {
  let fixture: OrchestratorE2eFixture | undefined;

  afterEach(async () => {
    await fixture?.close({ removeRoot: true });
    fixture = undefined;
  });

  it("fences an in-flight dispatch as dispatch_unknown after server/store restart without replay", async () => {
    fixture = await OrchestratorE2eFixture.start({ profiles: [{ ...PI_LIKE_PROFILE, streamDelayMs: 20 }] });
    const rootDirectory = fixture.rootDirectory;
    const paired = await fixture.pair("restart client");
    const adapterId = fixture.adapter().id;
    const sessionId = sessionIdFrom(await submit(
      paired.clients.operation,
      paired.connectionId,
      createSessionMutation({ backendId: adapterId, targetId: fixture.targetId() })
    ));
    fixture.adapter().injectFault(sessionId, "hang");
    const operationId = randomUUID();
    const queued = await submit(
      paired.clients.operation,
      paired.connectionId,
      sendInputMutation(sessionId, "may already have external effects"),
      operationId
    );
    const queueItemId = queueItemIdFrom(queued);
    await waitFor(
      async () => fixture!.adapter().sendCalls.length,
      (value) => value === 1,
      "Backend send to enter the possibly-accepted crash window"
    );
    expect((await paired.clients.queue.listQueueItems({ sessionId })).queueItems)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ queueItemId, state: QueueItemState.DISPATCHING })
      ]));

    await fixture.close({ removeRoot: false });
    fixture = await OrchestratorE2eFixture.start({
      rootDirectory,
      profiles: [{ ...PI_LIKE_PROFILE, streamDelayMs: 20 }]
    });
    const restartedClients = fixture.clients(paired.authKey);
    const recoveredQueue = await waitFor(
      () => restartedClients.queue.listQueueItems({ sessionId }),
      (value) => value.queueItems.some((item) => item.queueItemId === queueItemId && item.state === QueueItemState.DISPATCH_UNKNOWN),
      "dispatch_unknown recovery"
    );
    const item = recoveredQueue.queueItems.find((candidate) => candidate.queueItemId === queueItemId)!;
    expect(item.state).toBe(QueueItemState.DISPATCH_UNKNOWN);
    const recoveredRun = await restartedClients.run.getRun({ runId: item.runId });
    expect(recoveredRun.run?.state).toBe(RunState.DISPATCH_UNKNOWN);
    expect(fixture.adapter().sendCalls).toHaveLength(0);

    const persistedOperation = await restartedClients.operation.getOperation({ operationId });
    const payload = persistedOperation.operation?.mutation?.payload;
    expect(payload?.case).toBe("sendInput");
    if (payload?.case !== "sendInput") throw new Error("Persisted Operation lost its SendInput mutation.");
    expect(payload.value.input?.parts[0]?.content).toEqual({
      case: "text",
      value: "may already have external effects"
    });
  });

  it("keeps pre-dispatch accepted work paused across server/store restart and dispatches it once after resume", async () => {
    fixture = await OrchestratorE2eFixture.start({ profiles: [{ ...PI_LIKE_PROFILE, streamDelayMs: 20 }] });
    const rootDirectory = fixture.rootDirectory;
    const paired = await fixture.pair("pre-dispatch restart client");
    const sessionId = sessionIdFrom(await submit(
      paired.clients.operation,
      paired.connectionId,
      createSessionMutation({ backendId: fixture.adapter().id, targetId: fixture.targetId() })
    ));
    await submit(
      paired.clients.operation,
      paired.connectionId,
      pauseQueueMutation(
        requiredQueueControl(await paired.clients.queue.getQueueControl({ sessionId })),
        "hold before restart"
      )
    );
    const queued = await submit(
      paired.clients.operation,
      paired.connectionId,
      sendInputMutation(sessionId, "durable before dispatch")
    );
    const queueItemId = queueItemIdFrom(queued);
    const runId = queueRunIdFrom(queued);
    expect((await paired.clients.queue.getQueueControl({ sessionId })).queueControl?.dispatchState)
      .toBe(QueueDispatchState.PAUSED);
    expect((await paired.clients.queue.listQueueItems({ sessionId })).queueItems)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ queueItemId, state: QueueItemState.ACCEPTED })
      ]));
    expect((await paired.clients.run.getRun({ runId })).run?.state).toBe(RunState.QUEUED);
    expect(fixture.adapter().sendCalls).toHaveLength(0);

    await fixture.close({ removeRoot: false });
    fixture = await OrchestratorE2eFixture.start({
      rootDirectory,
      profiles: [{ ...PI_LIKE_PROFILE, streamDelayMs: 20 }]
    });
    const restarted = fixture.clients(paired.authKey);
    const restartedControl = requiredQueueControl(await restarted.queue.getQueueControl({ sessionId }));
    expect(restartedControl.dispatchState).toBe(QueueDispatchState.PAUSED);
    expect((await restarted.queue.listQueueItems({ sessionId })).queueItems)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ queueItemId, state: QueueItemState.ACCEPTED })
      ]));
    expect((await restarted.run.getRun({ runId })).run?.state).toBe(RunState.QUEUED);
    expect(fixture.adapter().sendCalls).toHaveLength(0);

    await submit(
      restarted.operation,
      paired.connectionId,
      resumeQueueMutation(restartedControl)
    );
    const settled = await waitFor(
      () => restarted.run.getRun({ runId }),
      (value) => value.run?.state === RunState.SUCCEEDED,
      "pre-dispatch recovered Run"
    );
    expect(settled.run?.attempts.map((attempt) => attempt.generation)).toEqual([1n, 2n]);
    expect(settled.run?.attempts.every((attempt) => attempt.endedAt !== undefined)).toBe(true);
    expect((await restarted.queue.listQueueItems({ sessionId })).queueItems)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ queueItemId, state: QueueItemState.COMPLETED })
      ]));
    expect(fixture.adapter().sendCalls).toHaveLength(1);
    expect(fixture.adapter().sendCalls[0]?.text).toBe("durable before dispatch");
  });

  it("dispatches a durable manual schedule through SessionHost without a live UI caller", async () => {
    fixture = await OrchestratorE2eFixture.start({ profiles: [{ ...PI_LIKE_PROFILE, streamDelayMs: 20 }] });
    const creator = await fixture.pair("schedule creator");
    const observer = await fixture.pair("schedule observer");
    const backendId = fixture.adapter().id;
    const targetId = fixture.targetId();
    const sessionId = sessionIdFrom(await submit(
      creator.clients.operation,
      creator.connectionId,
      createSessionMutation({ backendId, targetId, displayName: "Unattended task" })
    ));
    const scheduleId = scheduleIdFrom(await submit(
      creator.clients.operation,
      creator.connectionId,
      createManualScheduleMutation({ backendId, targetId, sessionId, text: "scheduled while UI is absent" })
    ));

    // This is the same coordinator path used by its timer/supervisor, not an RPC
    // owned by either connected client.
    await fixture.application.scheduler.runNow(scheduleId, randomUUID());
    const history = await waitFor(
      () => observer.clients.scheduler.listScheduleRunHistory({ scheduleId }),
      (value) => value.history.length === 1 && value.history[0]?.state === RunState.SUCCEEDED,
      "unattended scheduled Run"
    );
    expect(history.history[0]?.runId).not.toBe("");
    expect(fixture.adapter().sendCalls.some((item) => item.text === "scheduled while UI is absent")).toBe(true);
    const schedules = await observer.clients.scheduler.listSchedules({ sessionId });
    expect(schedules.schedules[0]?.scheduleId).toBe(scheduleId);
  });
});

function requiredQueueControl(response: { readonly queueControl?: QueueControl }): QueueControl {
  if (response.queueControl === undefined) throw new Error("Orchestrator returned no queue control.");
  return response.queueControl;
}
