import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";

import { create } from "@bufbuild/protobuf";
import { ClaudeCodeAdapter } from "@joko/adapter-claude-code";
import { createCodexAdapter, AppServerHost } from "@joko/adapter-codex";
import { FakeCodexAppServer } from "@joko/adapter-codex/testing";
import { createPiAdapter, type PiManagedProvider } from "@joko/adapter-pi";
import { InteractionState, OperationMutationSchema, OperationState, RunState, StartReviewMutationSchema } from "@joko/contracts";
import { chromium, type Browser } from "playwright-core";
import { expect, it } from "vitest";

import { ControlledClaudeRuntime } from "./controlled-claude-runtime.js";
import { OrchestratorE2eFixture, waitFor } from "./fixture.js";
import { createSessionMutation, queueRunIdFrom, resolvePermissionMutation, sendInputMutation, sessionIdFrom, submit } from "./operations.js";
import { REAL_PI_MODEL_ID, REAL_PI_PROVIDER_ID, startLocalProvider } from "./real-pi-fixture.js";

const mountedIt = process.env.JOKO_BROWSER_EXECUTABLE?.trim() && process.env.JOKO_MOUNTED_WEB_DIR?.trim()
  ? it : it.skip;

it("runs Pi, Codex and Claude through one durable service without crossing Session or failure authority", { timeout: 90_000 }, async () => {
  const setup = await startPairedFixture();
  const { fixture, requests, codex, claude } = setup;
  try {
    const paired = await fixture.pair("Paired Backend client");
    const sessions = new Map<string, string>();
    for (const backendId of ["pi", "codex-paired", "claude-paired"]) {
      const operation = await submit(paired.clients.operation, paired.connectionId,
        createSessionMutation({ backendId, targetId: fixture.targetId(backendId), displayName: `${backendId} task`,
          ...(backendId === "pi" ? { providerId: REAL_PI_PROVIDER_ID, modelId: REAL_PI_MODEL_ID, effortId: "off" } : {}) }));
      expect(operation.state).toBe(OperationState.SUCCEEDED);
      sessions.set(backendId, sessionIdFrom(operation));
    }
    const send = async (backendId: string, text: string) => {
      const sessionId = sessions.get(backendId)!;
      const generation = BigInt(fixture.application.store.getSession(sessionId).descriptor.binding.generation);
      const accepted = await submit(paired.clients.operation, paired.connectionId,
        sendInputMutation(sessionId, generation, text));
      expect(accepted.state).toBe(OperationState.SUCCEEDED);
      return queueRunIdFrom(accepted);
    };
    const [piRunId, codexRunId, claudeRunId] = await Promise.all([
      send("pi", "Pi first"), send("codex-paired", "Codex first"), send("claude-paired", "Claude first")
    ]);
    for (const [backendId, runId] of [["pi", piRunId], ["codex-paired", codexRunId], ["claude-paired", claudeRunId]] as const) {
      const sessionId = sessions.get(backendId)!;
      const queue = fixture.application.store.findQueueItemByRunId(sessionId, runId);
      expect(queue?.attemptId).toBeDefined();
      expect(fixture.application.store.getAttempt(queue!.attemptId!).descriptor.runId).toBe(runId);
      expect(fixture.application.store.getRun(runId).descriptor.sessionId).toBe(sessionId);
      expect(fixture.application.store.getSession(sessionId).descriptor.binding.nativeSessionId).toBeTruthy();
    }
    const codexSessionId = sessions.get("codex-paired")!;
    const codexThreadId = fixture.application.store.getSession(codexSessionId).descriptor.binding.nativeSessionId;
    if (codexThreadId === undefined) throw new Error("Codex task has no native thread.");
    await waitFor(async () => codex.transport?.requests.some((request) => request.method === "turn/start") ?? false,
      (dispatched) => dispatched, "paired Codex dispatch");
    await waitFor(async () => claude.queries.some((query) => query.receivedInputs.length > 0),
      (dispatched) => dispatched, "paired Claude dispatch");
    const approval = codex.requestCommandApproval(codexThreadId, "turn-1");
    const pending = await waitFor(() => paired.clients.interaction.listInteractions({ sessionId: codexSessionId, runId: codexRunId }),
      (value) => value.interactions.some((interaction) => interaction.state === InteractionState.PENDING),
      "Codex permission interaction");
    const interaction = pending.interactions.find((item) => item.state === InteractionState.PENDING)!;
    for (const backendId of ["pi", "claude-paired"]) {
      expect((await paired.clients.interaction.listInteractions({ sessionId: sessions.get(backendId)! })).interactions).toEqual([]);
    }
    await submit(paired.clients.operation, paired.connectionId, resolvePermissionMutation({
      connectionId: paired.connectionId,
      interactionId: interaction.interactionId,
      generation: interaction.generation
    }));
    await expect(approval).resolves.toMatchObject({ decision: "accept" });
    await waitFor(() => paired.clients.interaction.getInteraction({ interactionId: interaction.interactionId }),
      (value) => value.interaction?.state === InteractionState.RESOLVED, "Codex approval resolution");
    await waitFor(() => paired.clients.run.getRun({ runId: piRunId }),
      (value) => value.run?.state === RunState.SUCCEEDED, "published Pi completion");
    expect(requests.length).toBeGreaterThan(0);
    claude.queries.at(-1)!.complete("Claude paired answer");
    await codex.completeTurn(codexThreadId, "Codex paired answer");
    for (const runId of [codexRunId, claudeRunId]) {
      await waitFor(() => paired.clients.run.getRun({ runId }),
        (value) => value.run?.state === RunState.SUCCEEDED, "paired native completion");
    }
    for (const [backendId, sessionId] of sessions) {
      const events = fixture.application.store.listEvents({ sessionId });
      expect(events.some((event) => event.payload.type === "message_complete" && event.payload.role === "assistant")).toBe(true);
      expect(events.some((event) => event.payload.type === "usage")).toBe(true);
      expect((await paired.clients.session.getSession({ sessionId })).session?.backendId).toBe(backendId);
      const snapshot = (await paired.clients.event.getSnapshot({ scope: {
        kind: { case: "session", value: { sessionId, recentTimelineItems: 200 } }
      } })).snapshot;
      expect(snapshot?.timeline.some((event) => event.payload?.kind.case === "messageCompleted")).toBe(true);
      expect(snapshot?.timeline.every((event) => event.identity?.sessionId === sessionId)).toBe(true);
      expect(fixture.application.store.listQueueItems({ sessionId })).toHaveLength(1);
    }

    codex.threads.delete(codexThreadId);
    const missingRunId = await send("codex-paired", "Missing Codex thread");
    await waitFor(async () => fixture.application.store.getRun(missingRunId).descriptor.state,
      (state) => state === "failed", "retired Codex identity");
    expect(codex.threads.size).toBe(0);
    const [piSecondRunId, claudeSecondRunId] = await Promise.all([
      send("pi", "Pi after Codex failure"), send("claude-paired", "Claude after Codex failure")
    ]);
    await waitFor(async () => claude.queries.reduce((count, query) => count + query.receivedInputs.length, 0),
      (count) => count === 2, "Claude second input");
    claude.queries.at(-1)!.complete("Claude still isolated");
    for (const runId of [piSecondRunId, claudeSecondRunId]) {
      await waitFor(() => paired.clients.run.getRun({ runId }),
        (value) => value.run?.state === RunState.SUCCEEDED, "independent Backend after Codex failure");
    }
    expect(fixture.application.store.listEvents({ sessionId: codexSessionId }).some((event) =>
      event.payload.type === "message_complete" && event.payload.role === "assistant" &&
      JSON.stringify(event.payload).includes("Claude still isolated"))).toBe(false);

    const reviewSourceId = sessions.get("claude-paired")!;
    const review = await submit(paired.clients.operation, paired.connectionId, create(OperationMutationSchema, {
      payload: { case: "startReview", value: create(StartReviewMutationSchema, {
        sourceSessionId: reviewSourceId,
        focus: "Check the first Claude turn",
        attachments: []
      }) }
    }));
    if (review.state !== OperationState.SUCCEEDED) {
      throw new Error(`Paired Review failed: ${review.error?.code ?? "unknown"}: ${review.error?.message ?? "no detail"}`);
    }
    if (review.result?.payload.case !== "reviewRun") throw new Error("Paired Review did not return a ReviewRun.");
    const reviewRunId = review.result.payload.value.reviewRunId;
    await waitFor(async () => claude.queries.some((query) => query.params.options.persistSession === false
      && query.receivedInputs.length === 1), (ready) => ready, "isolated Claude reviewer dispatch");
    claude.queries.find((query) => query.params.options.persistSession === false)!.complete("Claude review stayed with its source");
    await waitFor(async () => fixture.application.store.getReviewRun(reviewRunId),
      (value) => value.state === "completed", "isolated Claude Review completion");
    expect(fixture.application.store.getReviewRun(reviewRunId).sourceSessionId).toBe(reviewSourceId);
    for (const backendId of ["pi", "codex-paired"]) {
      expect(fixture.application.store.listReviewRunsBySource(sessions.get(backendId)!)).toEqual([]);
    }
  } finally {
    await setup.close();
  }
});

it("resumes three native tasks through service restart and isolates one missing identity", { timeout: 120_000 }, async () => {
  const setup = await startPairedFixture();
  try {
    let fixture = setup.fixture;
    const paired = await fixture.pair("Paired restart client");
    const sessions = new Map<string, string>();
    for (const backendId of ["pi", "codex-paired", "claude-paired"]) {
      const created = await submit(paired.clients.operation, paired.connectionId,
        createSessionMutation({ backendId, targetId: fixture.targetId(backendId), displayName: `${backendId} restart task`,
          ...(backendId === "pi" ? { providerId: REAL_PI_PROVIDER_ID, modelId: REAL_PI_MODEL_ID, effortId: "off" } : {}) }));
      expect(created.state).toBe(OperationState.SUCCEEDED);
      sessions.set(backendId, sessionIdFrom(created));
    }
    const send = async (
      activeFixture: OrchestratorE2eFixture,
      clients: typeof paired.clients,
      backendId: string,
      text: string,
      operationId?: string
    ) => {
      const sessionId = sessions.get(backendId)!;
      const generation = BigInt(activeFixture.application.store.getSession(sessionId).descriptor.binding.generation);
      const accepted = await submit(clients.operation, paired.connectionId,
        sendInputMutation(sessionId, generation, text), operationId);
      expect(accepted.state).toBe(OperationState.SUCCEEDED);
      return queueRunIdFrom(accepted);
    };
    const waitForRun = (clients: typeof paired.clients, runId: string, state: RunState) =>
      waitFor(() => clients.run.getRun({ runId }), (value) => value.run?.state === state, `${runId} to reach ${state}`);

    const firstRuns = new Map<string, string>();
    for (const backendId of ["pi", "codex-paired", "claude-paired"]) {
      firstRuns.set(backendId, await send(fixture, paired.clients, backendId, `${backendId} before restart`));
    }
    const codexSessionId = sessions.get("codex-paired")!;
    const firstCodexThreadId = fixture.application.store.getSession(codexSessionId).descriptor.binding.nativeSessionId;
    if (firstCodexThreadId === undefined) throw new Error("Restart fixture Codex task has no native thread.");
    await waitFor(async () => setup.codex.transport?.requests.some((request) => request.method === "turn/start") ?? false,
      (dispatched) => dispatched, "Codex dispatch before service restart");
    await waitFor(async () => setup.claude.queries.some((query) => query.receivedInputs.length === 1),
      (dispatched) => dispatched, "Claude dispatch before service restart");
    setup.claude.queries.at(-1)!.complete("Claude before restart answer");
    await setup.codex.completeTurn(firstCodexThreadId, "Codex before restart answer");
    for (const runId of firstRuns.values()) await waitForRun(paired.clients, runId, RunState.SUCCEEDED);

    const nativeBindings = new Map<string, { readonly nativeSessionId: string; readonly opaqueRef: string }>();
    const instanceGenerations = new Map<string, number>();
    for (const [backendId, sessionId] of sessions) {
      const binding = fixture.application.store.getSession(sessionId).descriptor.binding;
      const nativeSessionId = binding.nativeSessionId;
      if (nativeSessionId === undefined) throw new Error(`${backendId} restart task has no native identity.`);
      nativeBindings.set(backendId, { nativeSessionId, opaqueRef: binding.opaqueRef });
      instanceGenerations.set(backendId,
        fixture.application.store.getBackend(backendId).descriptor.instanceGeneration);
    }

    fixture = await setup.restart();
    const restartedClients = fixture.clients(paired.authKey);
    const firstAnswers = new Map([
      ["pi", "real npm Pi reached Orchestrator over binary Connect"],
      ["codex-paired", "Codex before restart answer"],
      ["claude-paired", "Claude before restart answer"]
    ]);
    const restartedInstanceGenerations = new Map<string, number>();
    for (const [backendId, sessionId] of sessions) {
      expect((await restartedClients.session.getSession({ sessionId })).session?.backendId).toBe(backendId);
      expect(fixture.application.store.getSession(sessionId).descriptor.binding).toMatchObject(nativeBindings.get(backendId)!);
      const restartedInstanceGeneration = fixture.application.store.getBackend(backendId).descriptor.instanceGeneration;
      expect(restartedInstanceGeneration).toBeGreaterThan(instanceGenerations.get(backendId)!);
      restartedInstanceGenerations.set(backendId, restartedInstanceGeneration);
      const snapshot = (await restartedClients.event.getSnapshot({ scope: {
        kind: { case: "session", value: { sessionId, recentTimelineItems: 200 } }
      } })).snapshot;
      expect(jsonWithBigints(snapshot?.timeline)).toContain(firstAnswers.get(backendId));
      expect(snapshot?.timeline.every((event) => event.identity?.sessionId === sessionId)).toBe(true);
      for (const [otherBackendId, otherAnswer] of firstAnswers) {
        if (otherBackendId === backendId) continue;
        expect(jsonWithBigints(snapshot?.timeline)).not.toContain(otherAnswer);
      }
    }
    const usageCountsBeforeResume = new Map([...sessions].map(([backendId, sessionId]) => [
      backendId,
      fixture.application.store.listEvents({ sessionId }).filter((event) => event.payload.type === "usage").length
    ]));
    const assistantCountsBeforeResume = new Map([...sessions].map(([backendId, sessionId]) => [
      backendId,
      fixture.application.store.listEvents({ sessionId }).filter((event) =>
        event.payload.type === "message_complete" && event.payload.role === "assistant").length
    ]));

    const requestsBeforeResume = setup.requests.length;
    const queriesBeforeResume = setup.claude.queries.length;
    const secondRuns = new Map<string, string>();
    for (const backendId of ["pi", "codex-paired", "claude-paired"]) {
      secondRuns.set(backendId, await send(fixture, restartedClients, backendId, `${backendId} after service restart`));
    }
    await waitFor(async () => setup.requests.length, (count) => count > requestsBeforeResume, "Pi dispatch after service restart");
    await waitFor(async () => setup.codex.transport?.requests.some((request) => request.method === "thread/resume") ?? false,
      (resumed) => resumed, "Codex native resume after service restart");
    await waitFor(async () => setup.codex.transport?.requests.some((request) => request.method === "turn/start") ?? false,
      (dispatched) => dispatched, "Codex dispatch after service restart");
    await waitFor(async () => setup.claude.queries.length,
      (count) => count === queriesBeforeResume + 1, "Claude native resume after service restart");
    expect(jsonWithBigints(setup.requests.slice(requestsBeforeResume).map((request) => request.body)))
      .toContain("pi after service restart");
    const resumedCodexRequests = setup.codex.transport?.requests ?? [];
    expect(jsonWithBigints(resumedCodexRequests.filter((request) => request.method === "thread/resume")))
      .toContain(nativeBindings.get("codex-paired")!.nativeSessionId);
    expect(jsonWithBigints(resumedCodexRequests.filter((request) => request.method === "turn/start")))
      .toContain("codex-paired after service restart");
    expect(setup.claude.queries.at(-1)?.params.options.resume).toBe(nativeBindings.get("claude-paired")?.nativeSessionId);
    expect(jsonWithBigints(setup.claude.queries.at(-1)?.receivedInputs))
      .toContain("claude-paired after service restart");
    setup.claude.queries.at(-1)!.complete("Claude after restart answer");
    await setup.codex.completeTurn(nativeBindings.get("codex-paired")!.nativeSessionId, "Codex after restart answer");
    const secondAnswers = new Map([
      ["pi", "real npm Pi reached Orchestrator over binary Connect"],
      ["codex-paired", "Codex after restart answer"],
      ["claude-paired", "Claude after restart answer"]
    ]);
    for (const [backendId, runId] of secondRuns) {
      await waitForRun(restartedClients, runId, RunState.SUCCEEDED);
      const sessionId = sessions.get(backendId)!;
      const queue = fixture.application.store.findQueueItemByRunId(sessionId, runId);
      expect(queue?.attemptId).toBeDefined();
      expect(queue?.backendInstanceGeneration).toBe(restartedInstanceGenerations.get(backendId));
      expect(fixture.application.store.getAttempt(queue!.attemptId!).descriptor).toMatchObject({
        runId,
        backendInstanceGeneration: restartedInstanceGenerations.get(backendId)
      });
      expect(fixture.application.store.getRun(runId).descriptor.sessionId).toBe(sessionId);
      const sessionEvents = fixture.application.store.listEvents({ sessionId });
      expect(sessionEvents.some((event) => event.payload.type === "message_complete"
        && event.payload.role === "assistant" && jsonWithBigints(event.payload).includes(secondAnswers.get(backendId)!)),
      `${backendId} resumed Session should publish its assistant result`).toBe(true);
      expect(sessionEvents.filter((event) =>
        event.payload.type === "message_complete" && event.payload.role === "assistant").length,
      `${backendId} resumed Session should append an assistant result`)
        .toBeGreaterThan(assistantCountsBeforeResume.get(backendId)!);
      expect(fixture.application.store.listEvents({ sessionId })
        .filter((event) => event.payload.type === "usage").length,
      `${backendId} resumed Session should publish usage under its own authority`)
        .toBeGreaterThan(usageCountsBeforeResume.get(backendId)!);
      expect(fixture.application.store.getSession(sessionId).descriptor.binding).toMatchObject(nativeBindings.get(backendId)!);
      for (const [otherBackendId, otherSessionId] of sessions) {
        if (otherBackendId === backendId) continue;
        expect(jsonWithBigints(fixture.application.store.listEvents({ sessionId: otherSessionId })))
          .not.toContain(secondAnswers.get(backendId));
      }
    }

    const missingClaudeId = nativeBindings.get("claude-paired")!.nativeSessionId;
    fixture = await setup.restart(() => {
      setup.claude.sessions.delete(missingClaudeId);
    });
    const recoveryClients = fixture.clients(paired.authKey);
    const recoveryInstanceGenerations = new Map<string, number>();
    for (const backendId of sessions.keys()) {
      const generation = fixture.application.store.getBackend(backendId).descriptor.instanceGeneration;
      expect(generation).toBeGreaterThan(restartedInstanceGenerations.get(backendId)!);
      recoveryInstanceGenerations.set(backendId, generation);
    }
    const queryCountBeforeGap = setup.claude.queries.length;
    const failureOperationId = randomUUID();
    const missingSessionId = sessions.get("claude-paired")!;
    const failureMutation = sendInputMutation(
      missingSessionId,
      BigInt(fixture.application.store.getSession(missingSessionId).descriptor.binding.generation),
      "Claude identity missing after service restart"
    );
    const failedAdmission = await submit(
      recoveryClients.operation,
      paired.connectionId,
      failureMutation,
      failureOperationId
    );
    expect(failedAdmission.state).toBe(OperationState.SUCCEEDED);
    const missingRunId = queueRunIdFrom(failedAdmission);
    const failed = await waitForRun(recoveryClients, missingRunId, RunState.FAILED);
    expect(failed.run?.error?.code).toBe("NATIVE_SESSION_CONTINUITY_GAP");
    const missingQueue = fixture.application.store.findQueueItemByRunId(missingSessionId, missingRunId);
    expect(missingQueue).toMatchObject({
      state: "failed",
      backendInstanceGeneration: recoveryInstanceGenerations.get("claude-paired"),
      error: { code: "NATIVE_SESSION_CONTINUITY_GAP" }
    });
    expect(missingQueue?.attemptId).toBeDefined();
    expect(fixture.application.store.getAttempt(missingQueue!.attemptId!).descriptor).toMatchObject({
      runId: missingRunId,
      backendInstanceGeneration: recoveryInstanceGenerations.get("claude-paired"),
      error: { code: "NATIVE_SESSION_CONTINUITY_GAP" }
    });
    const missingQueueId = missingQueue!.id;
    const missingAttemptId = missingQueue!.attemptId!;
    const missingAttemptCount = fixture.application.store.listAttempts(missingRunId).length;
    const missingBindingAfterFailure = structuredClone(
      fixture.application.store.getSession(missingSessionId).descriptor.binding
    );
    expect(setup.claude.sessions.has(missingClaudeId)).toBe(false);
    expect(setup.claude.queries).toHaveLength(queryCountBeforeGap);
    const queueCountBeforeReplay = fixture.application.store.listQueueItems({ sessionId: missingSessionId }).length;
    const replayedAdmission = await submit(
      recoveryClients.operation,
      paired.connectionId,
      failureMutation,
      failureOperationId
    );
    expect(replayedAdmission.operationId).toBe(failedAdmission.operationId);
    expect(replayedAdmission.state).toBe(failedAdmission.state);
    expect(replayedAdmission.requestSha256Hex).toBe(failedAdmission.requestSha256Hex);
    expect(replayedAdmission.result?.payload.case).toBe(failedAdmission.result?.payload.case);
    expect(queueRunIdFrom(replayedAdmission)).toBe(missingRunId);
    expect(fixture.application.store.listQueueItems({ sessionId: missingSessionId }))
      .toHaveLength(queueCountBeforeReplay);
    expect(setup.claude.queries).toHaveLength(queryCountBeforeGap);

    const finalPiRunId = await send(fixture, recoveryClients, "pi", "Pi after Claude continuity gap");
    const finalCodexRunId = await send(fixture, recoveryClients, "codex-paired", "Codex after Claude continuity gap");
    await waitFor(async () => setup.codex.transport?.requests.some((request) => request.method === "turn/start") ?? false,
      (dispatched) => dispatched, "Codex dispatch after isolated Claude continuity gap");
    await setup.codex.completeTurn(nativeBindings.get("codex-paired")!.nativeSessionId, "Codex stayed isolated from Claude gap");
    await waitForRun(recoveryClients, finalPiRunId, RunState.SUCCEEDED);
    await waitForRun(recoveryClients, finalCodexRunId, RunState.SUCCEEDED);
    for (const [backendId, runId] of [["pi", finalPiRunId], ["codex-paired", finalCodexRunId]] as const) {
      const sessionId = sessions.get(backendId)!;
      const queue = fixture.application.store.findQueueItemByRunId(sessionId, runId);
      expect(queue?.backendInstanceGeneration).toBe(recoveryInstanceGenerations.get(backendId));
      expect(fixture.application.store.getAttempt(queue!.attemptId!).descriptor.backendInstanceGeneration)
        .toBe(recoveryInstanceGenerations.get(backendId));
      expect(fixture.application.store.getSession(sessionId).descriptor.binding).toMatchObject(nativeBindings.get(backendId)!);
      expect(jsonWithBigints(fixture.application.store.listEvents({ sessionId })))
        .not.toContain("Claude identity missing after service restart");
    }
    expect(fixture.application.store.findQueueItemByRunId(missingSessionId, missingRunId)).toMatchObject({
      id: missingQueueId,
      attemptId: missingAttemptId,
      state: "failed",
      error: { code: "NATIVE_SESSION_CONTINUITY_GAP" }
    });
    expect(fixture.application.store.listAttempts(missingRunId)).toHaveLength(missingAttemptCount);
    expect(fixture.application.store.getSession(missingSessionId).descriptor.binding)
      .toEqual(missingBindingAfterFailure);
    expect(setup.claude.queries).toHaveLength(queryCountBeforeGap);
  } finally {
    await setup.close();
  }
});

mountedIt("keeps three native tasks distinct through mounted Web, approval and one native identity failure", { timeout: 120_000 }, async () => {
  const setup = await startPairedFixture(resolve(process.env.JOKO_MOUNTED_WEB_DIR!));
  const { fixture, codex, claude } = setup;
  let browser: Browser | undefined;
  try {
    const paired = await fixture.pair("Paired mounted setup");
    const sessions = new Map<string, string>();
    for (const backendId of ["pi", "codex-paired", "claude-paired"]) {
      const created = await submit(paired.clients.operation, paired.connectionId,
        createSessionMutation({ backendId, targetId: fixture.targetId(backendId), displayName: `${backendId} mounted task`,
          ...(backendId === "pi" ? { providerId: REAL_PI_PROVIDER_ID, modelId: REAL_PI_MODEL_ID, effortId: "off" } : {}) }));
      expect(created.state).toBe(OperationState.SUCCEEDED);
      sessions.set(backendId, sessionIdFrom(created));
    }
    const piSessionId = sessions.get("pi")!;
    const codexSessionId = sessions.get("codex-paired")!;
    const claudeSessionId = sessions.get("claude-paired")!;
    const codexThreadId = fixture.application.store.getSession(codexSessionId).descriptor.binding.nativeSessionId;
    if (codexThreadId === undefined) throw new Error("Mounted Codex task has no native thread.");
    const challenge = await fixture.anonymous.connection.beginPairing({ deviceDisplayName: "Paired mounted Web" });
    if (challenge.challenge === undefined) throw new Error("Mounted pairing returned no challenge.");

    browser = await chromium.launch({ executablePath: process.env.JOKO_BROWSER_EXECUTABLE!, headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${fixture.baseUrl}/#/tasks/${encodeURIComponent(piSessionId)}`, { waitUntil: "domcontentloaded" });
    await page.locator(".connection-tabs > button").nth(2).click();
    await page.getByLabel("Joko node address").fill(fixture.baseUrl);
    await page.getByLabel("Pairing code").fill(fixture.pairingCode(challenge.challenge.challengeId));
    await page.getByLabel("Device name").fill("Paired mounted Web");
    await page.locator("form.pair-form button[type=submit]").click();
    const composer = page.locator(".composer-rich-editor__content");
    await composer.waitFor({ state: "visible", timeout: 30_000 });
    const openTask = async (backendId: string) => {
      const sessionId = sessions.get(backendId)!;
      await page.evaluate((id) => { window.location.hash = `/tasks/${encodeURIComponent(id)}`; }, sessionId);
      await page.getByText(`${backendId} mounted task`, { exact: true }).first().waitFor({ state: "visible", timeout: 20_000 });
      await composer.waitFor({ state: "visible", timeout: 20_000 });
    };
    const sendFromWeb = async (text: string) => {
      await composer.fill(text);
      await page.getByRole("button", { name: "Send", exact: true }).click();
    };

    await sendFromWeb("Pi mounted first");
    await page.locator(".timeline").getByText("real npm Pi reached Orchestrator over binary Connect", { exact: true })
      .first().waitFor({ state: "visible", timeout: 20_000 });
    await openTask("claude-paired");
    expect(await page.locator(".timeline").getByText("real npm Pi reached Orchestrator over binary Connect", { exact: true }).count()).toBe(0);
    await sendFromWeb("Claude mounted first");
    await waitFor(async () => claude.queries.some((query) => query.receivedInputs.length === 1),
      (dispatched) => dispatched, "mounted Claude dispatch");
    claude.queries.at(-1)!.complete("Claude mounted answer");
    await page.locator(".timeline").getByText("Claude mounted answer", { exact: true })
      .waitFor({ state: "visible", timeout: 20_000 });

    await openTask("codex-paired");
    expect(await page.locator(".timeline").getByText("Claude mounted answer", { exact: true }).count()).toBe(0);
    await sendFromWeb("Codex mounted first");
    await waitFor(async () => codex.transport?.requests.some((request) => request.method === "turn/start") ?? false,
      (dispatched) => dispatched, "mounted Codex dispatch");
    const approval = codex.requestCommandApproval(codexThreadId, "turn-1");
    await page.locator(".decision-options .decision-option").filter({ hasText: "Allow once" })
      .click({ timeout: 20_000 });
    await expect(approval).resolves.toMatchObject({ decision: "accept" });
    for (const sessionId of [piSessionId, claudeSessionId]) {
      expect((await paired.clients.interaction.listInteractions({ sessionId })).interactions).toEqual([]);
    }
    await codex.completeTurn(codexThreadId, "Codex mounted answer");
    await page.locator(".timeline").getByText("Codex mounted answer", { exact: true })
      .waitFor({ state: "visible", timeout: 20_000 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await composer.waitFor({ state: "visible", timeout: 20_000 });
    await page.locator(".timeline").getByText("Codex mounted answer", { exact: true })
      .waitFor({ state: "visible", timeout: 20_000 });

    codex.threads.delete(codexThreadId);
    await sendFromWeb("Codex native identity missing");
    await waitFor(async () => fixture.application.store.listRuns({ sessionId: codexSessionId }).map((run) => run.descriptor.state),
      (states) => states.length === 2 && states.includes("failed"), "mounted Codex continuity failure");
    expect(codex.threads.size).toBe(0);
    await page.locator(".compact-list > li").filter({ hasText: "Codex native identity missing" })
      .getByText("failed", { exact: true }).waitFor({ state: "visible", timeout: 10_000 });
    await openTask("pi");
    expect(await page.locator(".compact-list > li").filter({ hasText: "Codex native identity missing" }).count()).toBe(0);
    await sendFromWeb("Pi mounted after failure");
    await waitFor(async () => fixture.application.store.listRuns({ sessionId: piSessionId }).map((run) => run.descriptor.state),
      (states) => states.length === 2 && states.every((state) => state === "completed"), "mounted Pi continues");
    await openTask("claude-paired");
    await sendFromWeb("Claude mounted after failure");
    await waitFor(async () => claude.queries.some((query) => query.receivedInputs.length === 2),
      (dispatched) => dispatched, "mounted Claude continues");
    claude.queries.at(-1)!.complete("Claude mounted after failure answer");
    await page.locator(".timeline").getByText("Claude mounted after failure answer", { exact: true })
      .waitFor({ state: "visible", timeout: 20_000 });
    expect(errors).toEqual([]);
  } finally {
    const cleanupErrors: unknown[] = [];
    await attemptCleanup(cleanupErrors, async () => browser?.close());
    await attemptCleanup(cleanupErrors, () => setup.close());
    throwCleanupErrors(cleanupErrors, "Mounted paired fixture cleanup failed.");
  }
});

async function startPairedFixture(webDirectory?: string) {
  const root = await mkdtemp(join(tmpdir(), "joko-paired-backends-"));
  const requests: Parameters<typeof startLocalProvider>[0] = [];
  const providerServer = await startLocalProvider(requests);
  const providerPort = (providerServer.address() as AddressInfo).port;
  const provider: PiManagedProvider = {
    id: REAL_PI_PROVIDER_ID,
    baseUrl: `http://127.0.0.1:${providerPort}/v1`,
    api: "openai-completions",
    keyless: true,
    models: [{ id: REAL_PI_MODEL_ID, name: "Paired local model", contextWindow: 16_384, maxTokens: 1_024 }]
  };
  const codex = new FakeCodexAppServer();
  let codexHost = new AppServerHost({ transportFactory: () => codex.createTransport() });
  const claude = new ControlledClaudeRuntime();
  let fixture: OrchestratorE2eFixture | undefined;
  let closed = false;
  const closeProvider = () => new Promise<void>((resolvePromise, reject) => {
    providerServer.close((error) => error === undefined ? resolvePromise() : reject(error));
  });
  const startFixture = () => OrchestratorE2eFixture.start({ rootDirectory: root, profiles: [],
    ...(webDirectory === undefined ? {} : { webDirectory }), backendFactories: [
    { instanceId: "pi", adapterKind: "pi", displayName: "Published Pi",
      create: () => createPiAdapter({ agentHome: join(root, "pi-agent-home"), sessionRoot: join(root, "pi-sessions"),
        externalSessionRoots: [], providers: [provider], versionProbe: async () => "pi 0.84.4" }) },
    { instanceId: "codex-paired", adapterKind: "codex", displayName: "Codex",
      create: ({ generation }) => createCodexAdapter({ id: "codex-paired", instanceGeneration: generation, host: codexHost }) },
    { instanceId: "claude-paired", adapterKind: "claude-agent-sdk-stdio", displayName: "Claude",
      create: ({ generation }) => new ClaudeCodeAdapter({ id: "claude-paired", instanceGeneration: generation,
        runtime: claude, environment: {}, initializationTimeoutMs: 500, admissionTimeoutMs: 500,
        teardownTimeoutMs: 100 }) }
  ] });
  try {
    fixture = await startFixture();
    return {
      get fixture() {
        if (fixture === undefined) throw new Error("The paired fixture is not running.");
        return fixture;
      },
      requests,
      codex,
      claude,
      async restart(beforeStart?: () => void | Promise<void>) {
        if (closed || fixture === undefined) throw new Error("The paired fixture is not running.");
        const current = fixture;
        fixture = undefined;
        const stopErrors: unknown[] = [];
        await attemptCleanup(stopErrors, () => current.close({ removeRoot: false }));
        await attemptCleanup(stopErrors, () => shutdownCodexHost(codexHost));
        throwCleanupErrors(stopErrors, "The paired service did not stop cleanly for restart.");
        await beforeStart?.();
        codexHost = new AppServerHost({ transportFactory: () => codex.createTransport() });
        try {
          fixture = await startFixture();
          return fixture;
        } catch (error) {
          const cleanupErrors: unknown[] = [];
          await attemptCleanup(cleanupErrors, () => shutdownCodexHost(codexHost));
          if (cleanupErrors.length > 0) {
            throw new AggregateError([error, ...cleanupErrors], "The restarted paired service and its cleanup both failed.");
          }
          throw error;
        }
      },
      close: async () => {
        if (closed) return;
        closed = true;
        const current = fixture;
        fixture = undefined;
        const cleanupErrors: unknown[] = [];
        await attemptCleanup(cleanupErrors, async () => current?.close({ removeRoot: false }));
        await attemptCleanup(cleanupErrors, () => shutdownCodexHost(codexHost));
        await attemptCleanup(cleanupErrors, closeProvider);
        await attemptCleanup(cleanupErrors, () => rm(root, { recursive: true, force: true }));
        throwCleanupErrors(cleanupErrors, "Paired fixture cleanup failed.");
      }
    };
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    await attemptCleanup(cleanupErrors, () => shutdownCodexHost(codexHost));
    await attemptCleanup(cleanupErrors, closeProvider);
    await attemptCleanup(cleanupErrors, () => rm(root, { recursive: true, force: true }));
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], "Paired fixture startup and cleanup both failed.");
    }
    throw error;
  }
}

async function shutdownCodexHost(host: AppServerHost): Promise<void> {
  try {
    await host.shutdown();
  } catch (error) {
    try {
      await host.forceShutdown();
    } catch (forceError) {
      throw new AggregateError([error, forceError], "Codex host graceful and forced shutdown both failed.");
    }
    throw error;
  }
}

async function attemptCleanup(errors: unknown[], action: () => void | Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    errors.push(error);
  }
}

function throwCleanupErrors(errors: readonly unknown[], message: string): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, message);
}

function jsonWithBigints(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) => typeof entry === "bigint" ? entry.toString() : entry);
}
