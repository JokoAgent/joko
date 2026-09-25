import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { createCodexAdapter, AppServerHost } from "@joko/adapter-codex";
import { FakeCodexAppServer } from "@joko/adapter-codex/testing";
import { OperationState, RunState } from "@joko/contracts";
import { chromium, type Browser } from "playwright-core";
import { expect, it } from "vitest";

import { OrchestratorE2eFixture, waitFor } from "./fixture.js";
import { createSessionMutation, queueRunIdFrom, sendInputMutation, sessionIdFrom, submit } from "./operations.js";

const mountedIt = process.env.JOKO_BROWSER_EXECUTABLE?.trim() && process.env.JOKO_MOUNTED_WEB_DIR?.trim()
  ? it : it.skip;

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
