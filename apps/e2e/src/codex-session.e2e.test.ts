import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { create } from "@bufbuild/protobuf";
import { createCodexAdapter, AppServerHost } from "@joko/adapter-codex";
import { FakeCodexAppServer } from "@joko/adapter-codex/testing";
import { ObjectiveStatus, OperationMutationSchema, OperationState, RunState, ToolCallState } from "@joko/contracts";
import { chromium, type Browser } from "playwright-core";
import { expect, it } from "vitest";

import { OrchestratorE2eFixture, waitFor } from "./fixture.js";
import {
  abortRunMutation, createManualScheduleMutation, createSessionMutation, pauseQueueMutation, queueRunIdFrom, resumeQueueMutation,
  scheduleIdFrom, sendInputMutation, sessionIdFrom, submit, triggerScheduleMutation
} from "./operations.js";

const mountedIt = process.env.JOKO_BROWSER_EXECUTABLE?.trim() && process.env.JOKO_MOUNTED_WEB_DIR?.trim()
  ? it : it.skip;

it("stops the original Codex Run before the first native turn write and leaves the queue paused", async () => {
  const backendId = "codex-pre-dispatch-stop";
  const native = new FakeCodexAppServer();
  let enteredPreparation = false;
  let releasePreparation!: () => void;
  const holdPreparation = new Promise<void>(resolveHold => { releasePreparation = resolveHold; });
  const host = new AppServerHost({ transportFactory: () => {
    const transport = native.createTransport();
    const request = transport.request.bind(transport);
    transport.request = async (method, params, options) => {
      if (method !== "turn/start" || enteredPreparation) return request(method, params, options);
      const prepare = options?.beforeDispatchAsync;
      if (prepare === undefined) throw new Error("Expected a durable write fence for the first Codex turn.");
      return request(method, params, {
        ...options,
        beforeDispatchAsync: async (signal) => {
          await prepare(signal);
          enteredPreparation = true;
          await holdPreparation;
        }
      });
    };
    return transport;
  } });
  let fixture: OrchestratorE2eFixture | undefined;
  try {
    fixture = await OrchestratorE2eFixture.start({ backendFactories: [{
      instanceId: backendId, adapterKind: "codex", displayName: "Codex Stop fixture",
      create: ({ generation }) => createCodexAdapter({ id: backendId, instanceGeneration: generation, host })
    }] });
    const { clients, connectionId } = await fixture.pair("Codex Stop owner");
    const mutate = (mutation: Parameters<typeof submit>[2], operationId?: string) =>
      submit(clients.operation, connectionId, mutation, operationId);
    const sessionId = sessionIdFrom(await mutate(createSessionMutation({ backendId, targetId: fixture.targetId(backendId) })));
    const { store, sessionHost } = fixture.application;
    const binding = store.getSession(sessionId).descriptor.binding;
    const generation = BigInt(binding.generation);
    const originalText = "Stop this original input before its native write.";
    const laterText = "Only this queued input may reach Codex.";
    const firstRunId = queueRunIdFrom(await mutate(sendInputMutation(sessionId, generation, originalText)));
    await waitFor(async () => enteredPreparation, Boolean, "the original Codex native write preparation");
    const firstQueue = store.findQueueItemByRunId(sessionId, firstRunId);
    if (firstQueue?.attemptId === undefined) throw new Error("The original Codex input has no claimed Attempt.");
    expect(firstQueue.state).toBe("dispatching");
    expect(store.findSetting("session", sessionId, "native.dispatch.recovery")?.value).toMatchObject({
      entries: [expect.objectContaining({ runId: firstRunId, queueItemId: firstQueue.id, attemptId: firstQueue.attemptId })]
    });
    const controls = async () => (await clients.queue.getQueueControl({ sessionId })).queueControl!;
    const nextRunId = queueRunIdFrom(await mutate(sendInputMutation(sessionId, generation, laterText)));
    expect((await mutate(pauseQueueMutation(await controls()))).state).toBe(OperationState.SUCCEEDED);
    expect((await clients.run.getRun({ runId: firstRunId })).run?.state).toBe(RunState.QUEUED);
    const abort = abortRunMutation(firstRunId);
    const stopId = randomUUID();
    const stopped = await mutate(abort, stopId);
    expect(stopped.state).toBe(OperationState.SUCCEEDED);
    expect((await clients.operation.getOperation({ operationId: stopId })).operation).toEqual(stopped);
    expect((await clients.run.getRun({ runId: firstRunId })).run?.state).toBe(RunState.ABORTED);
    expect(store.getQueueItem(firstQueue.id).state).toBe("cancelled");
    expect(store.getAttempt(firstQueue.attemptId).descriptor.endedAt).toEqual(expect.any(Number));
    expect(store.findSetting("session", sessionId, "native.dispatch.recovery")).toBeUndefined();
    expect(store.getQueueControl(sessionId).paused).toBe(true);
    expect((await clients.run.getRun({ runId: nextRunId })).run?.state).toBe(RunState.QUEUED);
    const turnWrites = () => native.transport?.requests.filter(request =>
      request.method === "turn/start" || request.method === "turn/interrupt") ?? [];
    expect(turnWrites()).toHaveLength(0);
    releasePreparation();
    await waitFor(async () => sessionHost.observeQueueDispatch(firstQueue),
      preparation => preparation === undefined, "the original Codex preparation to retire");
    expect(turnWrites()).toHaveLength(0);
    expect(await mutate(abort, stopId)).toEqual(stopped);
    expect((await mutate(resumeQueueMutation(await controls()))).state).toBe(OperationState.SUCCEEDED);
    const writes = await waitFor(async () => turnWrites(), requests => requests.length > 0, "the next Codex turn write");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.method).toBe("turn/start");
    expect(JSON.stringify(writes[0]?.params)).toContain(laterText);
    expect(JSON.stringify(writes[0]?.params)).not.toContain(originalText);
    await native.completeTurn(binding.nativeSessionId!, "The next Codex turn completed.");
    await waitFor(() => clients.run.getRun({ runId: nextRunId }), value => value.run?.state === RunState.SUCCEEDED,
      "the resumed Codex Run to complete");
    expect(store.getSession(sessionId).descriptor.binding).toEqual(binding);
    expect(turnWrites()).toHaveLength(1);
  } finally {
    releasePreparation();
    await fixture?.close();
    await host.shutdown();
  }
});

it("holds the same Codex Objective when its interrupted native turn completes naturally", async () => {
  const backendId = "codex-objective-stop";
  const native = new FakeCodexAppServer();
  let atInterrupt = false;
  let releaseInterrupt!: () => void;
  const holdInterrupt = new Promise<void>(resolveHold => { releaseInterrupt = resolveHold; });
  const host = new AppServerHost({ transportFactory: () => {
    const transport = native.createTransport();
    const request = transport.request.bind(transport);
    transport.request = async (method, params, options) => {
      const result = await request(method, params, options);
      if (method === "turn/interrupt") {
        atInterrupt = true;
        await holdInterrupt;
      }
      return result;
    };
    return transport;
  } });
  let fixture: OrchestratorE2eFixture | undefined;
  try {
    fixture = await OrchestratorE2eFixture.start({ backendFactories: [{
      instanceId: backendId, adapterKind: "codex", displayName: "Codex Objective fixture",
      create: ({ generation }) => createCodexAdapter({ id: backendId, instanceGeneration: generation, host })
    }] });
    const { clients, connectionId } = await fixture.pair("Objective Stop owner");
    const mutate = (mutation: Parameters<typeof submit>[2], operationId?: string) =>
      submit(clients.operation, connectionId, mutation, operationId);
    const sessionId = sessionIdFrom(await mutate(createSessionMutation({ backendId, targetId: fixture.targetId(backendId) })));
    const { store } = fixture.application;
    const binding = store.getSession(sessionId).descriptor.binding;
    const { objective } = await clients.objective.setObjective({
      requestId: randomUUID(), sessionId, expectedSessionGeneration: BigInt(binding.generation),
      text: "Continue until the fixture is complete.", limits: { maximumTurns: 4 }
    });
    const runId = objective?.pendingRunId;
    if (runId === undefined) throw new Error("No Objective Run was admitted.");
    await waitFor(() => clients.run.getRun({ runId }), value => value.run?.state === RunState.RUNNING, "the original Objective Run");
    const nativeThread = native.threads.get(binding.nativeSessionId!);
    const nativeTurnId = nativeThread?.turns[0]?.["id"];
    expect(nativeTurnId).toEqual(expect.any(String));
    const stopId = randomUUID();
    const stop = mutate(abortRunMutation(runId), stopId);
    void stop.catch(() => undefined);
    await waitFor(async () => atInterrupt, Boolean, "Codex to receive the original interrupt");
    expect(native.transport?.requests.find(request => request.method === "turn/interrupt")?.params)
      .toMatchObject({ threadId: binding.nativeSessionId, turnId: nativeTurnId });
    expect((await clients.objective.getObjective({ sessionId })).objective?.status).toBe(ObjectiveStatus.PAUSED);
    await native.completeTurn(binding.nativeSessionId!, "The original turn finished before the interrupt took effect.");
    const settled = await waitFor(() => clients.run.getRun({ runId }), value => value.run?.state === RunState.SUCCEEDED,
      "the original native completion");
    expect(settled.run?.attempts).toMatchObject([{ endedAt: expect.any(Object) }]);
    const paused = (await waitFor(() => clients.objective.getObjective({ sessionId }),
      value => value.objective?.status === ObjectiveStatus.PAUSED && value.objective.pendingRunId === undefined,
      "the settled Objective to stay paused")).objective!;
    expect(paused.turnsUsed).toBe(1);
    expect(nativeThread?.turns).toHaveLength(1);
    releaseInterrupt();
    const receipt = await stop;
    expect(receipt.state).toBe(OperationState.SUCCEEDED);
    expect(await mutate(abortRunMutation(runId), stopId)).toEqual(receipt);
    expect(native.transport?.requests.filter(request => request.method === "turn/interrupt")).toHaveLength(1);
    expect(store.getSession(sessionId).descriptor.binding).toEqual(binding);
    expect(nativeThread?.turns).toHaveLength(1);
    await clients.objective.resumeObjective({ requestId: randomUUID(), sessionId,
      expectedRevision: paused.version!.revision!, expectedOwnerGeneration: paused.ownerGeneration });
    await waitFor(async () => nativeThread?.turns.length ?? 0, turns => turns === 2, "an explicit Objective resume");
  } finally {
    releaseInterrupt();
    await fixture?.close();
    await host.shutdown();
  }
});

it("honors a Codex schedule admitted before model disablement and rejects later runs on the same route", async () => {
  const backendId = "codex-scheduled-model";
  const model = { providerId: "openai", modelId: "gpt-test" };
  const effortId = "medium";
  const native = new FakeCodexAppServer();
  const host = new AppServerHost({ transportFactory: () => native.createTransport() });
  let fixture: OrchestratorE2eFixture | undefined;
  try {
    fixture = await OrchestratorE2eFixture.start({ backendFactories: [{
      instanceId: backendId, adapterKind: "codex", displayName: "Codex Schedule fixture",
      create: ({ generation }) => createCodexAdapter({ id: backendId, instanceGeneration: generation, host })
    }] });
    const { clients, connectionId } = await fixture.pair("Schedule owner");
    const mutate = (mutation: Parameters<typeof submit>[2]) => submit(clients.operation, connectionId, mutation);
    const targetId = fixture.targetId(backendId);
    const sessionId = sessionIdFrom(await mutate(createSessionMutation({ backendId, targetId, ...model, effortId })));
    const { binding } = fixture.application.store.getSession(sessionId).descriptor;
    const explicitId = scheduleIdFrom(await mutate(createManualScheduleMutation({
      backendId, targetId, sessionId, text: "Run the saved route", execution: { model: { model, effortId } }
    })));
    const inheritedId = scheduleIdFrom(await mutate(createManualScheduleMutation({
      backendId, targetId, sessionId, text: "Run the task's current route"
    })));
    const queueControl = async () => (await clients.queue.getQueueControl({ sessionId })).queueControl!;
    expect((await mutate(pauseQueueMutation(await queueControl()))).state).toBe(OperationState.SUCCEEDED);
    expect((await mutate(triggerScheduleMutation(explicitId))).state).toBe(OperationState.SUCCEEDED);
    const [admitted] = (await clients.scheduler.listScheduleRunHistory({ scheduleId: explicitId })).history;
    expect(admitted?.state).toBe(RunState.QUEUED);
    const turnStarts = () => native.transport?.requests.filter(request => request.method === "turn/start") ?? [];
    expect(turnStarts()).toHaveLength(0);

    const setAccess = (enabled: boolean, modelId?: string) => mutate(create(OperationMutationSchema, {
      payload: { case: "updateBackendSettings", value: { patch: {
        backendId, modelAccessUpdate: { providerId: model.providerId, modelId, enabled }
      } } }
    }));
    expect((await setAccess(false, model.modelId)).state).toBe(OperationState.SUCCEEDED);
    expect((await mutate(resumeQueueMutation(await queueControl()))).state).toBe(OperationState.SUCCEEDED);
    await waitFor(async () => turnStarts(), requests => requests.length === 1, "admitted Codex turn");
    expect(turnStarts()[0]?.params).toMatchObject({ threadId: binding.nativeSessionId, model: model.modelId });
    await native.completeTurn(binding.nativeSessionId!, "The accepted run finished.");
    await waitFor(() => clients.run.getRun({ runId: admitted!.runId }),
      value => value.run?.state === RunState.SUCCEEDED, "admitted Schedule completion");

    for (const scheduleId of [explicitId, inheritedId]) {
      const prior = (await clients.scheduler.listScheduleRunHistory({ scheduleId })).history.map(run => run.runId);
      expect((await mutate(triggerScheduleMutation(scheduleId))).state).toBe(OperationState.SUCCEEDED);
      const { history } = await waitFor(() => clients.scheduler.listScheduleRunHistory({ scheduleId }),
        value => value.history.some(run => !prior.includes(run.runId) && run.finishedAt !== undefined),
        "disabled model Schedule conclusion");
      expect(history.find(run => !prior.includes(run.runId))).toMatchObject({
        sessionId, state: RunState.FAILED, error: { code: "TURN_OVERRIDE_MODEL_UNAVAILABLE" }
      });
    }
    expect((await setAccess(true, model.modelId)).state).toBe(OperationState.SUCCEEDED);
    expect((await setAccess(false)).state).toBe(OperationState.SUCCEEDED);
    expect((await mutate(triggerScheduleMutation(inheritedId))).state).toBe(OperationState.SUCCEEDED);
    const { history } = await waitFor(() => clients.scheduler.listScheduleRunHistory({ scheduleId: inheritedId }),
      value => value.history.length === 2 && value.history.every(run => run.finishedAt !== undefined),
      "disabled Provider Schedule conclusion");
    expect(history).toHaveLength(2);
    for (const run of history) expect(run).toMatchObject({ state: RunState.FAILED, error: { code: "TURN_OVERRIDE_MODEL_UNAVAILABLE" } });
    expect(turnStarts()).toHaveLength(1);
    expect(fixture.application.store.getSession(sessionId).descriptor.binding).toEqual(binding);
  } finally {
    await fixture?.close();
    await host.shutdown();
  }
});

it("keeps a Codex thread and durable Queue on the production HTTP/SQLite/Connect path while another Backend remains isolated", async () => {
  const backendId = "codex-product";
  const native = new FakeCodexAppServer();
  let fixture: OrchestratorE2eFixture | undefined;
  let committedBeforeNativeDispatch = false;
  const host = new AppServerHost({ transportFactory: () => {
    const transport = native.createTransport();
    const request = transport.request.bind(transport);
    transport.request = async (method, params, options) => {
      if (method === "turn/start") {
        const store = fixture?.application.store;
        const operation = store?.findOperation(inputOperationId);
        const queue = store?.listQueueItems({ sessionId: codexSessionId });
        expect(operation?.status).toBe("completed");
        expect(queue).toHaveLength(1);
        expect(queue?.[0]?.operationId).toBe(inputOperationId);
        expect(queue?.[0]?.attemptId).toBeDefined();
        committedBeforeNativeDispatch = true;
      }
      return request(method, params, options);
    };
    return transport;
  } });
  const inputOperationId = randomUUID();
  let codexSessionId = "";
  try {
    fixture = await OrchestratorE2eFixture.start({ backendFactories: [{
      instanceId: backendId,
      adapterKind: "codex",
      displayName: "Codex product fixture",
      create: ({ generation }) => createCodexAdapter({ id: backendId, instanceGeneration: generation, host })
    }] });
    const paired = await fixture.pair("Codex product client");
    const piBackendId = fixture.adapter().id;
    const piSessionId = sessionIdFrom(await submit(paired.clients.operation, paired.connectionId,
      createSessionMutation({ backendId: piBackendId, targetId: fixture.targetId(piBackendId) })));
    codexSessionId = sessionIdFrom(await submit(paired.clients.operation, paired.connectionId,
      createSessionMutation({ backendId, targetId: fixture.targetId(backendId) })));
    const binding = fixture.application.store.getSession(codexSessionId).descriptor.binding;
    const threadId = binding.nativeSessionId;
    expect(threadId).toBeDefined();
    expect(native.threads.has(threadId!)).toBe(true);
    expect((await paired.clients.session.getSession({ sessionId: codexSessionId })).session?.sessionId).toBe(codexSessionId);

    const accepted = await submit(paired.clients.operation, paired.connectionId,
      sendInputMutation(codexSessionId, BigInt(binding.generation), "Keep this task bound to its native thread."), inputOperationId);
    expect(accepted.state).toBe(OperationState.SUCCEEDED);
    const runId = queueRunIdFrom(accepted);
    await waitFor(async () => native.transport?.requests.some((request) => request.method === "turn/start") ?? false,
      (dispatched) => dispatched, "Codex native turn dispatch");
    expect(committedBeforeNativeDispatch).toBe(true);
    expect(native.threads.size).toBe(1);
    await native.completeTurn(threadId!, "One native response");
    await waitFor(() => paired.clients.run.getRun({ runId }), (value) => value.run?.state === RunState.SUCCEEDED,
      "Codex terminal projection");
    expect(fixture.application.store.findQueueItemByRunId(codexSessionId, runId)?.state).toBe("completed");
    expect(fixture.application.store.listEvents({ sessionId: codexSessionId }).some((event) =>
      event.payload.type === "message_complete" && event.payload.role === "assistant")).toBe(true);
    expect(fixture.application.store.listEvents({ sessionId: piSessionId }).some((event) =>
      event.payload.type === "message_complete" && event.payload.role === "assistant")).toBe(false);

    native.threads.delete(threadId!);
    const missing = await submit(paired.clients.operation, paired.connectionId,
      sendInputMutation(codexSessionId, BigInt(fixture.application.store.getSession(codexSessionId).descriptor.binding.generation),
        "Do not silently create a replacement thread."));
    const missingRunId = queueRunIdFrom(missing);
    await waitFor(async () => fixture!.application.store.getRun(missingRunId).descriptor.state,
      (state) => state === "failed", "missing native thread failure");
    expect(native.threads.size).toBe(0);
    expect(fixture.application.store.getSession(piSessionId).descriptor.deletedAt).toBeUndefined();
    expect((await paired.clients.session.getSession({ sessionId: piSessionId })).session?.sessionId).toBe(piSessionId);
    const piGeneration = BigInt(fixture.application.store.getSession(piSessionId).descriptor.binding.generation);
    const piAccepted = await submit(paired.clients.operation, paired.connectionId,
      sendInputMutation(piSessionId, piGeneration, "Independent Backend remains usable."));
    const piRunId = queueRunIdFrom(piAccepted);
    await waitFor(() => paired.clients.run.getRun({ runId: piRunId }),
      (value) => value.run?.state === RunState.SUCCEEDED, "independent Backend completion");
    expect(fixture.application.store.listEvents({ sessionId: piSessionId }).some((event) =>
      event.payload.type === "message_complete" && event.payload.role === "assistant")).toBe(true);
  } finally {
    await fixture?.close();
    await host.shutdown();
  }
});

it("persists current Codex step plans consistently through generated timeline, Snapshot and tool details", async () => {
  const backendId = "codex-step-plan";
  const native = new FakeCodexAppServer();
  const host = new AppServerHost({ transportFactory: () => native.createTransport() });
  let fixture: OrchestratorE2eFixture | undefined;
  try {
    fixture = await OrchestratorE2eFixture.start({ backendFactories: [{ instanceId: backendId, adapterKind: "codex",
      displayName: "Step plan fixture", create: ({ generation }) => createCodexAdapter({ id: backendId, instanceGeneration: generation, host }) }] });
    const paired = await fixture.pair("Step plan client");
    const sessionId = sessionIdFrom(await submit(paired.clients.operation, paired.connectionId,
      createSessionMutation({ backendId, targetId: fixture.targetId(backendId) })));
    const binding = fixture.application.store.getSession(sessionId).descriptor.binding;
    const threadId = binding.nativeSessionId!;
    const accepted = await submit(paired.clients.operation, paired.connectionId,
      sendInputMutation(sessionId, BigInt(binding.generation), "Inspect then implement"));
    const runId = queueRunIdFrom(accepted);
    await waitFor(async () => native.transport?.requests.some((request) => request.method === "turn/start") ?? false,
      (value) => value, "step plan native dispatch");
    const turnId = String(native.threads.get(threadId)?.turns.at(-1)?.["id"]);
    const toolCallId = `plan:${turnId}`;
    await native.transport!.emitNotification("turn/plan/updated", { threadId, turnId, explanation: "Initial plan",
      plan: [{ step: "Inspect", status: "inProgress" }, { step: "Implement", status: "pending" }] });
    await native.transport!.emitNotification("turn/plan/updated", { threadId, turnId, explanation: "token=hidden-plan-token",
      plan: [{ step: "Inspect", status: "completed" }, { step: "Implement", status: "pending" }] });
    const expectedInput = JSON.stringify({ explanation: "token=[REDACTED]",
      plan: [{ step: "Inspect", status: "completed" }, { step: "Implement", status: "pending" }] });
    const live = await paired.clients.tool.getToolCall({ toolCallId });
    expect(live.toolCall).toMatchObject({ toolCallId, runId, state: ToolCallState.RUNNING,
      arguments: [{ value: { case: "text", value: expectedInput } }] });
    const scope = { kind: { case: "session" as const, value: { sessionId, recentTimelineItems: 200 } } };
    const liveSnapshot = (await paired.clients.event.getSnapshot({ scope })).snapshot!;
    const liveUpdate = liveSnapshot.timeline.find((event) => event.payload?.kind.case === "toolCallUpdated"
      && event.payload.kind.value.toolCall?.toolCallId === toolCallId);
    expect(liveUpdate?.payload?.kind).toMatchObject({ case: "toolCallUpdated", value: {
      toolCall: { arguments: [{ value: { case: "text", value: expectedInput } }] }
    } });
    await native.completeTurn(threadId, "Inspected; implementation remains pending.");
    await waitFor(() => paired.clients.run.getRun({ runId }), (value) => value.run?.state === RunState.SUCCEEDED,
      "step plan native terminal");
    const final = (await paired.clients.tool.getToolCall({ toolCallId })).toolCall!;
    expect(final).toMatchObject({ state: ToolCallState.SUCCEEDED,
      arguments: [{ value: { case: "text", value: expectedInput } }] });
    const tools = await paired.clients.tool.listToolCalls({ sessionId, runId });
    expect(tools.toolCalls.filter((call) => call.toolCallId === toolCallId)).toEqual([final]);
    const timeline = await paired.clients.session.listSessionTimeline({ sessionId, limit: 200 });
    const restoredUpdate = timeline.events.find((event) => event.payload?.kind.case === "toolCallUpdated"
      && event.payload.kind.value.toolCall?.toolCallId === toolCallId);
    expect(restoredUpdate?.payload?.kind).toMatchObject({ case: "toolCallUpdated", value: {
      toolCall: { arguments: [{ value: { case: "text", value: expectedInput } }] }
    } });
    expect(timeline.events.filter((event) => event.payload?.kind.case === "toolCallStarted"
      && event.payload.kind.value.toolCall?.toolCallId === toolCallId)).toHaveLength(1);
    const durable = fixture.application.store.listEvents({ sessionId });
    expect(durable.filter((event) => event.payload.type === "tool_result" && event.payload.callId === toolCallId)).toHaveLength(1);
    expect(JSON.stringify(durable, (_key, value) => typeof value === "bigint" ? value.toString() : value)).not.toContain("hidden-plan-token");
  } finally {
    await fixture?.close();
    await host.shutdown();
  }
});

mountedIt("shows a Codex turn, restores it after reload, and isolates another task in mounted Web", { timeout: 90_000 }, async () => {
  const backendId = "codex-mounted";
  const native = new FakeCodexAppServer();
  const host = new AppServerHost({ transportFactory: () => native.createTransport() });
  let fixture: OrchestratorE2eFixture | undefined;
  let browser: Browser | undefined;
  try {
    fixture = await OrchestratorE2eFixture.start({
      webDirectory: resolve(process.env.JOKO_MOUNTED_WEB_DIR!),
      backendFactories: [{ instanceId: backendId, adapterKind: "codex", displayName: "Codex mounted fixture",
        create: ({ generation }) => createCodexAdapter({ id: backendId, instanceGeneration: generation, host }) }]
    });
    const service = await fixture.pair("Codex mounted setup");
    const piBackendId = fixture.adapter().id;
    const otherSessionId = sessionIdFrom(await submit(service.clients.operation, service.connectionId,
      createSessionMutation({ backendId: piBackendId, targetId: fixture.targetId(piBackendId), displayName: "Other runtime task" })));
    const sessionId = sessionIdFrom(await submit(service.clients.operation, service.connectionId,
      createSessionMutation({ backendId, targetId: fixture.targetId(backendId), displayName: "Codex visible task" })));
    const threadId = fixture.application.store.getSession(sessionId).descriptor.binding.nativeSessionId;
    if (threadId === undefined) throw new Error("Codex task has no native thread identity.");
    const challenge = await fixture.anonymous.connection.beginPairing({ deviceDisplayName: "Codex mounted Web" });
    if (challenge.challenge === undefined) throw new Error("Web pairing returned no challenge.");

    browser = await chromium.launch({ executablePath: process.env.JOKO_BROWSER_EXECUTABLE!, headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${fixture.baseUrl}/#/tasks/${encodeURIComponent(sessionId)}`, { waitUntil: "domcontentloaded" });
    await page.locator(".connection-tabs > button").nth(2).click();
    await page.locator('details.device-authorization__manual > summary').click();
    await page.getByLabel("Joko node address").fill(fixture.baseUrl);
    await page.getByLabel("Pairing code").fill(fixture.pairingCode(challenge.challenge.challengeId));
    await page.getByLabel("Device name").fill("Codex mounted Web");
    await page.locator("form.pair-form button[type=submit]").click();
    const composer = page.locator(".composer-rich-editor__content");
    await composer.waitFor({ state: "visible", timeout: 30_000 });
    await composer.fill("Codex mounted input");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await waitFor(async () => native.transport?.requests.some((request) => request.method === "turn/start") ?? false,
      (dispatched) => dispatched, "mounted Codex dispatch");
    await native.completeTurn(threadId, "Codex mounted answer");
    await page.locator(".timeline").getByText("Codex mounted answer", { exact: true }).waitFor({ state: "visible", timeout: 20_000 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await composer.waitFor({ state: "visible", timeout: 20_000 });
    await page.locator(".timeline").getByText("Codex mounted answer", { exact: true }).waitFor({ state: "visible", timeout: 20_000 });

    await page.evaluate((id) => { window.location.hash = `/tasks/${encodeURIComponent(id)}`; }, otherSessionId);
    await page.getByText("Other runtime task", { exact: true }).first().waitFor({ state: "visible", timeout: 20_000 });
    expect(await page.locator(".timeline").getByText("Codex mounted answer", { exact: true }).count()).toBe(0);
    await page.evaluate((id) => { window.location.hash = `/tasks/${encodeURIComponent(id)}`; }, sessionId);
    await page.locator(".timeline").getByText("Codex mounted answer", { exact: true }).waitFor({ state: "visible", timeout: 20_000 });

    native.threads.delete(threadId);
    await composer.fill("Native identity is missing");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await waitFor(async () => fixture!.application.store.listRuns({ sessionId }).map((run) => run.descriptor.state),
      (states) => states.length === 2 && states.includes("failed"), "missing native identity visible run");
    expect(native.threads.size).toBe(0);
    await page.locator(".compact-list > li").filter({ hasText: "Native identity is missing" })
      .getByText("failed", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    expect(errors).toEqual([]);
  } finally {
    await browser?.close();
    await fixture?.close();
    await host.shutdown();
  }
});
