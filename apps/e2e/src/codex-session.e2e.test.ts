import { randomUUID } from "node:crypto";

import { createCodexAdapter, AppServerHost } from "@joko/adapter-codex";
import { FakeCodexAppServer } from "@joko/adapter-codex/testing";
import { OperationState, RunState } from "@joko/contracts";
import { expect, it } from "vitest";

import { OrchestratorE2eFixture, waitFor } from "./fixture.js";
import { createSessionMutation, queueRunIdFrom, sendInputMutation, sessionIdFrom, submit } from "./operations.js";

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
