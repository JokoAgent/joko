import { randomUUID } from "node:crypto";

import { createConnectTransport } from "@connectrpc/connect-node";
import { OperationState, QueueDispatchState, QueueItemState, RunState, ScheduleSessionMode, ScheduleState, type QueueControl } from "@joko/contracts";
import { PI_LIKE_PROFILE } from "@joko/testkit";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OrchestratorE2eFixture, waitFor } from "./fixture.js";
import {
  createManualScheduleMutation,
  createSessionMutation,
  deleteMutation,
  pauseQueueMutation,
  queueItemIdFrom,
  queueRunIdFrom,
  resumeQueueMutation,
  scheduleIdFrom,
  sendInputMutation,
  sessionIdFrom,
  submit,
  triggerScheduleMutation
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
      sendInputMutation(sessionId, BigInt(fixture!.application.store.getSession(sessionId).descriptor.binding.generation), "may already have external effects"),
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
      sendInputMutation(sessionId, BigInt(fixture!.application.store.getSession(sessionId).descriptor.binding.generation), "durable before dispatch")
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

  it("keeps a bound manual Automation and its original successful history visible after task deletion", async () => {
    const host = fixture = await OrchestratorE2eFixture.start();
    const { clients, connectionId } = await host.pair("Automation owner");
    const backendId = host.adapter().id;
    const targetId = host.targetId();
    const sessionId = sessionIdFrom(await submit(clients.operation, connectionId, createSessionMutation({ backendId, targetId })));
    const scheduleId = scheduleIdFrom(await submit(clients.operation, connectionId, createManualScheduleMutation({
      backendId, targetId, sessionId, sessionMode: ScheduleSessionMode.BOUND, text: "Keep this completed occurrence"
    })));
    expect((await submit(clients.operation, connectionId, triggerScheduleMutation(scheduleId))).state).toBe(OperationState.SUCCEEDED);
    const completed = await waitFor(
      () => clients.scheduler.listScheduleRunHistory({ scheduleId }),
      ({ history }) => history.length === 1 && history[0]?.state === RunState.SUCCEEDED,
      "the original bound manual occurrence"
    );
    const [original] = completed.history;
    expect(original?.sessionId).toBe(sessionId);
    expect(original?.runId).toBeTruthy();

    expect((await submit(clients.operation, connectionId, deleteMutation(sessionId))).state).toBe(OperationState.SUCCEEDED);
    expect(host.application.store.getSession(sessionId).descriptor.deletedAt).toBeDefined();
    const snapshot = (await clients.event.getSnapshot({})).snapshot;
    expect(snapshot?.sessions.some((task) => task.sessionId === sessionId)).toBe(false);
    expect(snapshot?.runs.some((run) => run.runId === original?.runId)).toBe(false);
    expect(snapshot?.schedules).toEqual([expect.objectContaining({
      scheduleId, sessionId, recentRuns: [expect.objectContaining({
        triggerId: original?.triggerId, runId: original?.runId, sessionId, state: RunState.SUCCEEDED
      })]
    })]);
    expect((await clients.scheduler.listSchedules({})).schedules.map((schedule) => schedule.scheduleId)).toEqual([scheduleId]);
    expect((await clients.scheduler.listScheduleRunHistory({ scheduleId })).history).toEqual(completed.history);
    expect(host.adapter().sendCalls).toHaveLength(1);
  });

  it("saves and dispatches each exact one-shot quota recovery instant in a repeated hour", async () => {
    // Advance the service wall clock while leaving real RPC and test timers running.
    const realNow = Date.now;
    let clockOffset = Date.parse("2027-11-07T04:00:00Z") - realNow();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + clockOffset);
    let disconnect: (() => void) | undefined;
    try {
      const serverId = "one-shot-repeated-hour";
      const host = fixture = await OrchestratorE2eFixture.start({ serverId });
      const owner = await host.pair("Quota recovery schedule owner");
      const sessionId = sessionIdFrom(await submit(owner.clients.operation, owner.connectionId, createSessionMutation({
        backendId: host.adapter().id, targetId: host.targetId(), displayName: "Quota recovery task"
      })));
      const { createOrchestratorGateway, mapSnapshot } = await import(new URL("../../web/src/gateway.ts", import.meta.url).href);
      const { scheduleDraft } = await import(new URL("../../web/src/components/SchedulesPage.tsx", import.meta.url).href);
      const { buildUsageLimitScheduleDraft, usageLimitRecoveryHint } = await import(new URL("../../web/src/usage-limit-recovery.ts", import.meta.url).href);
      const gateway = createOrchestratorGateway({ id: owner.connectionId, deviceId: owner.deviceId, serverId,
        name: "Quota recovery Web", origin: host.baseUrl }, owner.authKey, {}, () => createConnectTransport({
        baseUrl: host.baseUrl, httpVersion: "1.1", useBinaryFormat: true,
        interceptors: [next => async request => { request.header.set("authorization", `Bearer ${owner.authKey}`); return next(request); }]
      }));
      disconnect = () => gateway.disconnect();
      await gateway.connect({ snapshotOnly: true });
      const readOwner = async () => {
        const { snapshot } = await owner.clients.event.getSnapshot({ scope: { kind: { case: "owner", value: {} } } });
        if (snapshot === undefined) throw new Error("The paired node returned no Owner snapshot.");
        return mapSnapshot(snapshot);
      };
      const { targets, sessions, models, backends } = await readOwner();
      const session = sessions.find((item: { readonly id: string }) => item.id === sessionId);
      expect(session).toBeDefined();
      const timezone = "America/New_York";
      const base = { ...scheduleDraft(undefined, targets, sessions, models, backends), timezone };
      const schedules = [];
      for (const hour of [5, 6]) {
        const triggerAt = Date.UTC(2027, 10, 7, hour, 31);
        const hint = usageLimitRecoveryHint({ code: "PROVIDER_REQUEST_FAILED",
          message: `Rate limit exceeded; resets at ${(triggerAt - 60_000) / 1_000}`,
          phase: "stream", severity: "blocked", retryable: false, recovery: [] }, Date.now());
        expect(hint?.resetAtMs).toBe(triggerAt - 60_000);
        const name = `Original quota recovery ${hour}`, prompt = `Resume original task at ${hour} UTC`;
        const draft = buildUsageLimitScheduleDraft(base, { ...hint, requestId: `quota-recovery-${hour}`, sessionId }, session, { name, prompt });
        expect(draft.expression).toBe("2027-11-07T01:31");
        await gateway.saveSchedule(undefined, draft);
        const listed = (await owner.clients.scheduler.listSchedules({ sessionId })).schedules.find(item => item.displayName === name);
        if (!listed) throw new Error("The new one-shot Schedule is absent from the paired node.");
        const receipt = { seconds: BigInt(triggerAt / 1000), nanos: 0 };
        expect(listed.nextTriggerAt).toMatchObject(receipt);
        const current = (await readOwner()).schedules.find((item: { readonly id: string }) => item.id === listed.scheduleId);
        expect(current?.expression).toBe(new Date(triggerAt).toISOString());
        const reopened = scheduleDraft(current, targets, sessions, models, backends);
        expect(reopened.expression).toBe(draft.expression);
        await gateway.saveSchedule(listed.scheduleId, { ...reopened, name: `${name} edited` });
        const saved = (await owner.clients.scheduler.getSchedule({ scheduleId: listed.scheduleId })).schedule;
        expect(saved?.nextTriggerAt).toMatchObject(receipt);
        schedules.push({ scheduleId: listed.scheduleId, triggerAt, receipt, prompt });
      }

      const [first, second] = schedules;
      if (first === undefined || second === undefined) throw new Error("Both one-shot Schedules must be saved before dispatch.");
      const history = (scheduleId: string) => owner.clients.scheduler.listScheduleRunHistory({ scheduleId });
      for (const entry of [first, second]) {
        clockOffset = entry.triggerAt - realNow();
        const result = await waitFor(() => history(entry.scheduleId), response => response.history[0]?.state === RunState.SUCCEEDED,
          "the one-shot occurrence at its saved instant");
        expect(result.history).toHaveLength(1);
        expect(result.history[0]).toMatchObject({ sessionId, scheduledFor: entry.receipt });
        const saved = (await owner.clients.scheduler.getSchedule({ scheduleId: entry.scheduleId })).schedule;
        expect(saved?.state).toBe(ScheduleState.DISABLED);
        if (entry === first) {
          expect((await history(second.scheduleId)).history).toEqual([]);
          expect(host.adapter().sendCalls.map(input => input.text)).toEqual([first.prompt]);
        }
      }
      expect((await history(first.scheduleId)).history).toHaveLength(1);
      expect(host.adapter().sendCalls.map(input => input.text)).toEqual([first.prompt, second.prompt]);
    } finally {
      disconnect?.();
      clock.mockRestore();
    }
  });
});

function requiredQueueControl(response: { readonly queueControl?: QueueControl }): QueueControl {
  if (response.queueControl === undefined) throw new Error("Orchestrator returned no queue control.");
  return response.queueControl;
}
