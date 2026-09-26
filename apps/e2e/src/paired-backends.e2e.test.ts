import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";

import { create } from "@bufbuild/protobuf";
import { ClaudeCodeAdapter } from "@joko/adapter-claude-code";
import { createCodexAdapter, AppServerHost } from "@joko/adapter-codex";
import { FakeCodexAppServer, ScriptedRpcTransport } from "@joko/adapter-codex/testing";
import {
  createDefaultPiManagedProcessSupervisor,
  createPiAdapter,
  type PiManagedProvider
} from "@joko/adapter-pi";
import {
  InteractionState,
  OperationMutationSchema,
  OperationState,
  QueueItemState,
  RunState,
  StartReviewMutationSchema
} from "@joko/contracts";
import type { BackendAdapter } from "@joko/core";
import { chromium, type Browser } from "playwright-core";
import { expect, it } from "vitest";

import { ControlledClaudeRuntime } from "./controlled-claude-runtime.js";
import { ControlledPiProcessFactory } from "./controlled-pi-process.js";
import { OrchestratorE2eFixture, waitFor } from "./fixture.js";
import {
  createSessionMutation,
  queueRunIdFrom,
  resolvePermissionMutation,
  restartBackendMutation,
  sendInputMutation,
  sessionIdFrom,
  submit
} from "./operations.js";
import {
  REAL_PI_MODEL_ID,
  REAL_PI_PROVIDER_ID,
  REAL_PI_RESPONSE_TEXT,
  startLocalProvider
} from "./real-pi-fixture.js";

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

it("replaces three native Backend instances independently and rejects a busy replacement atomically", { timeout: 120_000 }, async () => {
  const setup = await startPairedFixture();
  try {
    const fixture = setup.fixture;
    const paired = await fixture.pair("Paired Backend replacement client");
    const backendIds = ["pi", "codex-paired", "claude-paired"] as const;
    const sessions = new Map<(typeof backendIds)[number], string>();
    for (const backendId of backendIds) {
      const created = await submit(paired.clients.operation, paired.connectionId,
        createSessionMutation({ backendId, targetId: fixture.targetId(backendId), displayName: `${backendId} replacement task`,
          ...(backendId === "pi" ? { providerId: REAL_PI_PROVIDER_ID, modelId: REAL_PI_MODEL_ID, effortId: "off" } : {}) }));
      expect(created.state).toBe(OperationState.SUCCEEDED);
      sessions.set(backendId, sessionIdFrom(created));
    }
    const send = async (backendId: (typeof backendIds)[number], text: string) => {
      const sessionId = sessions.get(backendId)!;
      const projected = (await paired.clients.session.getSession({ sessionId })).session;
      const generation = projected?.version?.generation;
      if (generation === undefined) throw new Error(`${backendId} replacement task has no public generation.`);
      expect(projected?.nativeBinding?.runtimeGeneration).toBe(generation);
      const accepted = await submit(paired.clients.operation, paired.connectionId,
        sendInputMutation(sessionId, generation, text));
      expect(accepted.state).toBe(OperationState.SUCCEEDED);
      return queueRunIdFrom(accepted);
    };
    const waitForRun = (runId: string) => waitFor(
      () => paired.clients.run.getRun({ runId }),
      (value) => value.run?.state === RunState.SUCCEEDED,
      `${runId} to complete`
    );
    const codexSessionId = sessions.get("codex-paired")!;
    const codexThreadId = fixture.application.store.getSession(codexSessionId).descriptor.binding.nativeSessionId;
    if (codexThreadId === undefined) throw new Error("Replacement fixture Codex task has no native thread.");

    const initialRuns = new Map<(typeof backendIds)[number], string>();
    for (const backendId of backendIds) initialRuns.set(backendId, await send(backendId, `${backendId} before replacement`));
    await waitFor(async () => setup.codex.transport?.requests.filter((request) => request.method === "turn/start").length ?? 0,
      (count) => count === 1, "Codex dispatch before Backend replacement");
    await waitFor(async () => setup.claude.queries.filter((query) => query.receivedInputs.length > 0).length,
      (count) => count === 1, "Claude dispatch before Backend replacement");
    setup.claude.queries.find((query) => query.receivedInputs.length > 0)!.complete("Claude before replacement answer");
    await setup.codex.completeTurn(codexThreadId, "Codex before replacement answer");
    for (const runId of initialRuns.values()) await waitForRun(runId);

    const nativeBindings = new Map(backendIds.map((backendId) => {
      const binding = fixture.application.store.getSession(sessions.get(backendId)!).descriptor.binding;
      if (binding.nativeSessionId === undefined) throw new Error(`${backendId} replacement task has no native identity.`);
      return [backendId, { nativeSessionId: binding.nativeSessionId, opaqueRef: binding.opaqueRef }] as const;
    }));

    const busyRuns = new Map<(typeof backendIds)[number], string>();
    for (const backendId of backendIds) busyRuns.set(backendId, await send(backendId, `${backendId} while Codex replacement is blocked`));
    await waitFor(async () => setup.codex.transport?.requests.filter((request) => request.method === "turn/start").length ?? 0,
      (count) => count === 2, "active Codex turn before rejected replacement");
    await waitFor(async () => setup.claude.queries.reduce((count, query) => count + query.receivedInputs.length, 0),
      (count) => count === 2, "independent Claude turn before rejected Codex replacement");
    const busyCodexRunId = busyRuns.get("codex-paired")!;
    const busyCodexQueue = fixture.application.store.findQueueItemByRunId(codexSessionId, busyCodexRunId);
    expect(fixture.application.store.getRun(busyCodexRunId).descriptor.state).toBe("running");
    expect(busyCodexQueue?.state).toBe("backend_accepted");
    const backendBeforeBusyRestart = structuredClone(
      fixture.application.store.getBackend("codex-paired").descriptor
    );
    const generationAuthorityBeforeBusyRestart = structuredClone(
      fixture.application.store.getBackendInstanceGenerationAuthority("codex-paired")
    );
    const bindingsBeforeBusyRestart = new Map(backendIds.map((backendId) => [backendId, structuredClone(
      fixture.application.store.getSession(sessions.get(backendId)!).descriptor.binding
    )] as const));
    const providerRequestsBeforeBusyRestart = setup.requests.length;
    const codexRequestsBeforeBusyRestart = setup.codex.transport?.requests.length ?? 0;
    const claudeQueriesBeforeBusyRestart = setup.claude.queries.length;
    const lifecycleBeforeBusyRestart = setup.lifecycle.length;
    const failedRestartOperationId = randomUUID();
    const failedRestartMutation = restartBackendMutation("codex-paired");
    const failedRestart = await submit(
      paired.clients.operation,
      paired.connectionId,
      failedRestartMutation,
      failedRestartOperationId
    );
    expect(failedRestart.state).toBe(OperationState.FAILED);
    expect(failedRestart.error?.message)
      .toBe("A Backend can be replaced only after every native side effect has settled.");
    expect(fixture.application.store.getBackend("codex-paired").descriptor)
      .toEqual(backendBeforeBusyRestart);
    expect(fixture.application.store.getBackendInstanceGenerationAuthority("codex-paired"))
      .toEqual(generationAuthorityBeforeBusyRestart);
    expect(setup.requests).toHaveLength(providerRequestsBeforeBusyRestart);
    expect(setup.codex.transport?.requests).toHaveLength(codexRequestsBeforeBusyRestart);
    expect(setup.claude.queries).toHaveLength(claudeQueriesBeforeBusyRestart);
    expect(setup.lifecycle).toHaveLength(lifecycleBeforeBusyRestart);
    for (const backendId of backendIds) {
      expect(fixture.application.store.getSession(sessions.get(backendId)!).descriptor.binding)
        .toEqual(bindingsBeforeBusyRestart.get(backendId));
    }
    setup.claude.queries.findLast((query) => query.receivedInputs.length > 0)!
      .complete("Claude completed while Codex replacement stayed blocked");
    await setup.codex.completeTurn(codexThreadId, "Codex completed after blocked replacement");
    for (const runId of busyRuns.values()) await waitForRun(runId);

    const backendBeforeFailedReplay = structuredClone(
      fixture.application.store.getBackend("codex-paired").descriptor
    );
    const authorityBeforeFailedReplay = structuredClone(
      fixture.application.store.getBackendInstanceGenerationAuthority("codex-paired")
    );
    const sessionsBeforeFailedReplay = new Map(backendIds.map((backendId) => [backendId, structuredClone(
      fixture.application.store.getSession(sessions.get(backendId)!).descriptor
    )] as const));
    const tracesBeforeFailedReplay = {
      providerRequests: setup.requests.length,
      codexRequests: setup.codex.transport?.requests.length ?? 0,
      claudeQueries: setup.claude.queries.length,
      lifecycle: setup.lifecycle.length
    };
    const replayedFailedRestart = await submit(
      paired.clients.operation,
      paired.connectionId,
      failedRestartMutation,
      failedRestartOperationId
    );
    expect(replayedFailedRestart.operationId).toBe(failedRestart.operationId);
    expect(replayedFailedRestart.state).toBe(failedRestart.state);
    expect(replayedFailedRestart.requestSha256Hex).toBe(failedRestart.requestSha256Hex);
    expect(replayedFailedRestart.error).toEqual(failedRestart.error);
    expect(fixture.application.store.getBackend("codex-paired").descriptor)
      .toEqual(backendBeforeFailedReplay);
    expect(fixture.application.store.getBackendInstanceGenerationAuthority("codex-paired"))
      .toEqual(authorityBeforeFailedReplay);
    for (const backendId of backendIds) {
      expect(fixture.application.store.getSession(sessions.get(backendId)!).descriptor)
        .toEqual(sessionsBeforeFailedReplay.get(backendId));
    }
    expect(setup.requests).toHaveLength(tracesBeforeFailedReplay.providerRequests);
    expect(setup.codex.transport?.requests).toHaveLength(tracesBeforeFailedReplay.codexRequests);
    expect(setup.claude.queries).toHaveLength(tracesBeforeFailedReplay.claudeQueries);
    expect(setup.lifecycle).toHaveLength(tracesBeforeFailedReplay.lifecycle);

    for (const backendId of backendIds) {
      const backendsBefore = new Map(backendIds.map((id) => [id, structuredClone(
        fixture.application.store.getBackend(id).descriptor
      )] as const));
      const generationAuthorityBefore = structuredClone(
        fixture.application.store.getBackendInstanceGenerationAuthority(backendId)
      );
      const sessionsBefore = new Map(backendIds.map((id) => [id, structuredClone(
        fixture.application.store.getSession(sessions.get(id)!).descriptor
      )] as const));
      const publicSessionsBefore = new Map(await Promise.all(backendIds.map(async (id) => [
        id,
        (await paired.clients.session.getSession({ sessionId: sessions.get(id)! })).session
      ] as const)));
      const adapterBefore = fixture.application.adapters.find((adapter) => adapter.id === backendId);
      if (adapterBefore === undefined) throw new Error(`No current ${backendId} Adapter exists before replacement.`);
      const providerRequestsBefore = setup.requests.length;
      const codexRequestsBefore = setup.codex.transport?.requests.length ?? 0;
      const codexThreadsBefore = setup.codex.transport?.requests
        .filter((request) => request.method === "thread/start").length ?? 0;
      const codexStartsBefore = setup.codex.transport?.requests.filter((request) => request.method === "turn/start").length ?? 0;
      const claudeQueriesBefore = setup.claude.queries.length;
      const claudeInputsBefore = setup.claude.queries.reduce((count, query) => count + query.receivedInputs.length, 0);
      const lifecycleBefore = setup.lifecycle.length;
      const operationId = randomUUID();
      const mutation = restartBackendMutation(backendId);
      const restarted = await submit(paired.clients.operation, paired.connectionId, mutation, operationId);
      expect(restarted.state).toBe(OperationState.SUCCEEDED);

      const selectedSession = fixture.application.store.getSession(sessions.get(backendId)!).descriptor;
      const previousInstanceGeneration = backendsBefore.get(backendId)!.instanceGeneration;
      const nextInstanceGeneration = previousInstanceGeneration + 1;
      expect(fixture.application.store.getBackend(backendId).descriptor.instanceGeneration)
        .toBe(nextInstanceGeneration);
      expect({
        ...fixture.application.store.getBackend(backendId).descriptor,
        instanceGeneration: previousInstanceGeneration
      }).toEqual(backendsBefore.get(backendId));
      const generationAuthorityAfter = fixture.application.store.getBackendInstanceGenerationAuthority(backendId);
      expect(generationAuthorityAfter.currentGeneration).toBe(nextInstanceGeneration);
      expect(generationAuthorityAfter.highWaterGeneration)
        .toBe(generationAuthorityBefore.highWaterGeneration + 1);
      expect(selectedSession.binding.generation)
        .toBe(sessionsBefore.get(backendId)!.binding.generation + 1);
      expect(selectedSession.binding).toMatchObject(nativeBindings.get(backendId)!);
      const publicSessionAfter = (await paired.clients.session.getSession({
        sessionId: sessions.get(backendId)!
      })).session;
      expect(publicSessionAfter?.version?.generation)
        .toBe((publicSessionsBefore.get(backendId)?.version?.generation ?? 0n) + 1n);
      expect(publicSessionAfter?.version?.generation)
        .toBe(BigInt(selectedSession.binding.generation));
      expect(publicSessionAfter?.nativeBinding?.runtimeGeneration)
        .toBe(BigInt(selectedSession.binding.generation));
      expect({
        ...publicSessionAfter?.nativeBinding,
        runtimeGeneration: publicSessionsBefore.get(backendId)?.nativeBinding?.runtimeGeneration
      }).toEqual(publicSessionsBefore.get(backendId)?.nativeBinding);
      expect(selectedSession.attention).toMatchObject({
        kind: sessionsBefore.get(backendId)!.attention?.kind,
        unread: sessionsBefore.get(backendId)!.attention?.unread,
        subjectCursor: sessionsBefore.get(backendId)!.attention?.subjectCursor,
        subjectGeneration: sessionsBefore.get(backendId)!.attention?.subjectGeneration
      });
      expect(publicSessionAfter?.attention).toMatchObject({
        kind: publicSessionsBefore.get(backendId)?.attention?.kind,
        unread: publicSessionsBefore.get(backendId)?.attention?.unread
      });
      expect(publicSessionAfter?.attention?.subjectCursor).toMatchObject({
        sequence: publicSessionsBefore.get(backendId)?.attention?.subjectCursor?.sequence,
        generation: publicSessionsBefore.get(backendId)?.attention?.subjectCursor?.generation,
        opaqueToken: publicSessionsBefore.get(backendId)?.attention?.subjectCursor?.opaqueToken
      });
      expect({
        ...selectedSession,
        binding: sessionsBefore.get(backendId)!.binding,
        updatedAt: sessionsBefore.get(backendId)!.updatedAt,
        attention: sessionsBefore.get(backendId)!.attention
      }).toEqual(sessionsBefore.get(backendId));
      const publicContextAfter = publicSessionAfter?.context === undefined ? undefined : {
        ...publicSessionAfter.context,
        measuredAt: publicSessionsBefore.get(backendId)?.context?.measuredAt
      };
      expect(publicContextAfter).toEqual(publicSessionsBefore.get(backendId)?.context);
      expect({
        ...publicSessionAfter,
        activeNativeEntryId: publicSessionsBefore.get(backendId)?.activeNativeEntryId,
        nativeBinding: {
          ...publicSessionAfter?.nativeBinding,
          runtimeGeneration: publicSessionsBefore.get(backendId)?.nativeBinding?.runtimeGeneration
        },
        context: publicSessionsBefore.get(backendId)?.context,
        version: publicSessionsBefore.get(backendId)?.version,
        lastActivityAt: publicSessionsBefore.get(backendId)?.lastActivityAt,
        attention: publicSessionsBefore.get(backendId)?.attention
      })
        .toEqual(publicSessionsBefore.get(backendId));
      expect(fixture.application.adapters.find((adapter) => adapter.id === backendId))
        .not.toBe(adapterBefore);
      expect(setup.lifecycle.slice(lifecycleBefore)).toEqual([
        { backendId, generation: nextInstanceGeneration, phase: "created" },
        {
          backendId,
          generation: previousInstanceGeneration,
          phase: "close_completed",
          nativeSessionId: nativeBindings.get(backendId)!.nativeSessionId
        },
        { backendId, generation: previousInstanceGeneration, phase: "dispose_completed" },
        {
          backendId,
          generation: nextInstanceGeneration,
          phase: "resume_started",
          nativeSessionId: nativeBindings.get(backendId)!.nativeSessionId
        },
        {
          backendId,
          generation: nextInstanceGeneration,
          phase: "resume_completed",
          nativeSessionId: nativeBindings.get(backendId)!.nativeSessionId
        }
      ]);
      for (const otherBackendId of backendIds) {
        if (otherBackendId === backendId) continue;
        expect(fixture.application.store.getBackend(otherBackendId).descriptor)
          .toEqual(backendsBefore.get(otherBackendId));
        expect(fixture.application.store.getSession(sessions.get(otherBackendId)!).descriptor)
          .toEqual(sessionsBefore.get(otherBackendId));
        expect((await paired.clients.session.getSession({ sessionId: sessions.get(otherBackendId)! })).session)
          .toEqual(publicSessionsBefore.get(otherBackendId));
      }
      expect(setup.requests).toHaveLength(providerRequestsBefore);
      expect(setup.codex.transport?.requests.filter((request) => request.method === "turn/start"))
        .toHaveLength(codexStartsBefore);
      expect(setup.codex.transport?.requests.filter((request) => request.method === "thread/start"))
        .toHaveLength(codexThreadsBefore);
      expect(setup.claude.queries.reduce((count, query) => count + query.receivedInputs.length, 0))
        .toBe(claudeInputsBefore);
      if (backendId !== "codex-paired") {
        expect(setup.codex.transport?.requests).toHaveLength(codexRequestsBefore);
      }
      if (backendId !== "claude-paired") {
        expect(setup.claude.queries).toHaveLength(claudeQueriesBefore);
      }
      if (backendId === "codex-paired") {
        const replacementRequests = (setup.codex.transport?.requests ?? []).slice(codexRequestsBefore);
        const resumeRequests = replacementRequests.filter((request) => request.method === "thread/resume");
        expect(resumeRequests.length).toBeGreaterThan(0);
        expect(replacementRequests.some((request) =>
          request.method === "thread/start" || request.method === "turn/start"
        )).toBe(false);
        expect(resumeRequests.every((request) =>
          typeof request.params === "object"
          && request.params !== null
          && "threadId" in request.params
          && request.params.threadId === nativeBindings.get(backendId)!.nativeSessionId
        )).toBe(true);
        expect(replacementRequests.every((request) =>
          typeof request.params !== "object"
          || request.params === null
          || !("threadId" in request.params)
          || request.params.threadId === nativeBindings.get(backendId)!.nativeSessionId
        )).toBe(true);
      }
      if (backendId === "claude-paired") {
        expect(setup.claude.queries).toHaveLength(claudeQueriesBefore + 1);
        expect(setup.claude.queries.at(-1)?.params.options.resume)
          .toBe(nativeBindings.get(backendId)!.nativeSessionId);
        expect(setup.claude.queries.at(-1)?.receivedInputs).toEqual([]);
      }

      const generationAfterRestart = fixture.application.store.getBackend(backendId).descriptor.instanceGeneration;
      const authorityAfterRestart = structuredClone(
        fixture.application.store.getBackendInstanceGenerationAuthority(backendId)
      );
      const bindingAfterRestart = structuredClone(selectedSession.binding);
      const publicGenerationAfterRestart = publicSessionAfter?.version?.generation;
      const lifecycleAfterRestart = structuredClone(setup.lifecycle);
      const codexRequestsAfterRestart = setup.codex.transport?.requests.length ?? 0;
      const claudeQueriesAfterRestart = setup.claude.queries.length;
      const replayed = await submit(paired.clients.operation, paired.connectionId, mutation, operationId);
      expect(replayed.operationId).toBe(restarted.operationId);
      expect(replayed.state).toBe(restarted.state);
      expect(replayed.requestSha256Hex).toBe(restarted.requestSha256Hex);
      expect(fixture.application.store.getBackend(backendId).descriptor.instanceGeneration)
        .toBe(generationAfterRestart);
      expect(fixture.application.store.getBackendInstanceGenerationAuthority(backendId))
        .toEqual(authorityAfterRestart);
      expect(fixture.application.store.getSession(sessions.get(backendId)!).descriptor.binding)
        .toEqual(bindingAfterRestart);
      expect((await paired.clients.session.getSession({ sessionId: sessions.get(backendId)! })).session?.version?.generation)
        .toBe(publicGenerationAfterRestart);
      expect(setup.requests).toHaveLength(providerRequestsBefore);
      expect(setup.codex.transport?.requests).toHaveLength(codexRequestsAfterRestart);
      expect(setup.claude.queries).toHaveLength(claudeQueriesAfterRestart);
      expect(setup.claude.queries.reduce((count, query) => count + query.receivedInputs.length, 0))
        .toBe(claudeInputsBefore);
      expect(setup.lifecycle).toEqual(lifecycleAfterRestart);
    }

    const usageCountsBeforeFinal = new Map(backendIds.map((backendId) => [backendId,
      fixture.application.store.listEvents({ sessionId: sessions.get(backendId)! })
        .filter((event) => event.payload.type === "usage").length
    ] as const));
    const assistantCountsBeforeFinal = new Map(backendIds.map((backendId) => [backendId,
      fixture.application.store.listEvents({ sessionId: sessions.get(backendId)! })
        .filter((event) => event.payload.type === "message_complete" && event.payload.role === "assistant").length
    ] as const));
    const providerRequestsBeforeFinal = setup.requests.length;
    const codexStartsBeforeFinal = setup.codex.transport?.requests.filter((request) => request.method === "turn/start").length ?? 0;
    const claudeInputsBeforeFinal = setup.claude.queries.reduce((count, query) => count + query.receivedInputs.length, 0);
    const finalRuns = new Map<(typeof backendIds)[number], string>();
    for (const backendId of backendIds) finalRuns.set(backendId, await send(backendId, `${backendId} after replacement`));
    await waitFor(async () => setup.requests.length, (count) => count === providerRequestsBeforeFinal + 1,
      "Pi dispatch after Backend replacement");
    await waitFor(async () => setup.codex.transport?.requests.filter((request) => request.method === "turn/start").length ?? 0,
      (count) => count === codexStartsBeforeFinal + 1, "Codex dispatch after Backend replacement");
    await waitFor(async () => setup.claude.queries.reduce((count, query) => count + query.receivedInputs.length, 0),
      (count) => count === claudeInputsBeforeFinal + 1, "Claude dispatch after Backend replacement");
    setup.claude.queries.at(-1)!.complete("Claude after replacement answer");
    await setup.codex.completeTurn(codexThreadId, "Codex after replacement answer");
    const finalAnswers = new Map<(typeof backendIds)[number], string>([
      ["pi", "real npm Pi reached Orchestrator over binary Connect"],
      ["codex-paired", "Codex after replacement answer"],
      ["claude-paired", "Claude after replacement answer"]
    ]);
    for (const [backendId, runId] of finalRuns) {
      await waitForRun(runId);
      const sessionId = sessions.get(backendId)!;
      const instanceGeneration = fixture.application.store.getBackend(backendId).descriptor.instanceGeneration;
      const queue = fixture.application.store.findQueueItemByRunId(sessionId, runId);
      expect(queue).toMatchObject({ backendInstanceGeneration: instanceGeneration, state: "completed" });
      expect(queue?.attemptId).toBeDefined();
      const binding = fixture.application.store.getSession(sessionId).descriptor.binding;
      const attempt = fixture.application.store.getAttempt(queue!.attemptId!).descriptor;
      expect(attempt).toMatchObject({
        runId,
        backendInstanceGeneration: instanceGeneration,
        generation: binding.generation,
        endedAt: expect.any(Number)
      });
      expect(attempt.error).toBeUndefined();
      expect(binding).toMatchObject(nativeBindings.get(backendId)!);
      const sessionEvents = fixture.application.store.listEvents({ sessionId });
      const allAssistantEvents = sessionEvents.filter((event) =>
        event.payload.type === "message_complete" && event.payload.role === "assistant");
      const assistantEvents = allAssistantEvents.filter((event) => event.runId === runId);
      const assistantDelta = allAssistantEvents.slice(assistantCountsBeforeFinal.get(backendId));
      const allUsageEvents = sessionEvents.filter((event) => event.payload.type === "usage");
      const usageEvents = allUsageEvents.slice(usageCountsBeforeFinal.get(backendId));
      const doneEvents = sessionEvents.filter((event) => event.payload.type === "done" && event.runId === runId);
      expect(assistantEvents, `${backendId} run-bound final assistant`).toHaveLength(1);
      expect(assistantDelta.length).toBeGreaterThan(0);
      expect(assistantDelta.every((event) =>
        event.backendId === backendId
        && event.sessionId === sessionId
        && event.generation === binding.generation
        && jsonWithBigints(event).includes(finalAnswers.get(backendId)!)
      )).toBe(true);
      expect(usageEvents.length, `${backendId} final usage delta`).toBeGreaterThan(0);
      for (const event of assistantEvents) {
        expect(event).toMatchObject({
          backendId,
          sessionId,
          runId,
          attemptId: queue!.attemptId,
          generation: binding.generation
        });
      }
      expect(
        usageEvents.some((event) => event.runId === runId && event.attemptId === queue!.attemptId)
        || assistantEvents.some((event) => event.payload.type === "message_complete" && event.payload.usage !== undefined),
        `${backendId} run-bound final usage evidence`
      ).toBe(true);
      for (const event of usageEvents) {
        expect(event).toMatchObject({ backendId, sessionId, generation: binding.generation });
        expect(
          (event.runId === runId && event.attemptId === queue!.attemptId)
          || (
            event.runId === undefined
            && event.attemptId === undefined
            && event.metadata?.namespace === "joko.runtime_usage"
            && event.metadata.fields.cumulative === true
          )
        ).toBe(true);
      }
      expect(doneEvents, `${backendId} run-bound final terminal`).toHaveLength(1);
      expect(doneEvents[0]).toMatchObject({
        backendId,
        sessionId,
        runId,
        attemptId: queue!.attemptId,
        generation: binding.generation,
        payload: { type: "done", outcome: "completed" }
      });
      expect(jsonWithBigints(assistantEvents))
        .toContain(finalAnswers.get(backendId));
      for (const [otherBackendId, otherSessionId] of sessions) {
        if (otherBackendId === backendId) continue;
        const otherEvents = fixture.application.store.listEvents({ sessionId: otherSessionId });
        expect(otherEvents.some((event) => event.runId === runId || event.attemptId === queue!.attemptId)).toBe(false);
        expect(jsonWithBigints(otherEvents)).not.toContain(`${backendId} after replacement`);
        expect(jsonWithBigints(otherEvents)).not.toContain(finalAnswers.get(backendId));
      }
    }
    expect(jsonWithBigints(setup.requests.at(-1)?.body)).toContain("pi before replacement");
    expect(jsonWithBigints(setup.requests.at(-1)?.body)).toContain("pi after replacement");
    expect(jsonWithBigints(fixture.application.store.listEvents({ sessionId: sessions.get("codex-paired")! })))
      .toContain("Codex after replacement answer");
    expect(jsonWithBigints(fixture.application.store.listEvents({ sessionId: sessions.get("claude-paired")! })))
      .toContain("Claude after replacement answer");
  } finally {
    await setup.close();
  }
});

it("isolates failed replacement probes while retaining all three native Backend instances", { timeout: 180_000 }, async () => {
  const setup = await startPairedFixture();
  try {
    const fixture = setup.fixture;
    const paired = await fixture.pair("Paired candidate probe failure client");
    const backendIds = ["pi", "codex-paired", "claude-paired"] as const;
    type BackendId = (typeof backendIds)[number];
    const sessions = new Map<BackendId, string>();
    for (const backendId of backendIds) {
      const created = await submit(paired.clients.operation, paired.connectionId,
        createSessionMutation({
          backendId,
          targetId: fixture.targetId(backendId),
          displayName: `${backendId} candidate probe task`,
          ...(backendId === "pi"
            ? { providerId: REAL_PI_PROVIDER_ID, modelId: REAL_PI_MODEL_ID, effortId: "off" }
            : {})
        }));
      expect(created.state).toBe(OperationState.SUCCEEDED);
      sessions.set(backendId, sessionIdFrom(created));
    }

    const send = async (backendId: BackendId, text: string): Promise<string> => {
      const sessionId = sessions.get(backendId)!;
      const projected = (await paired.clients.session.getSession({ sessionId })).session;
      const generation = projected?.version?.generation;
      if (generation === undefined) throw new Error(`${backendId} candidate probe task has no public generation.`);
      const accepted = await submit(paired.clients.operation, paired.connectionId,
        sendInputMutation(sessionId, generation, text));
      expect(accepted.state).toBe(OperationState.SUCCEEDED);
      return queueRunIdFrom(accepted);
    };
    const waitForRun = (runId: string) => waitFor(
      () => paired.clients.run.getRun({ runId }),
      (value) => value.run?.state === RunState.SUCCEEDED,
      `${runId} to complete`
    );

    const baselineRuns = new Map<BackendId, string>();
    for (const backendId of backendIds) {
      baselineRuns.set(backendId, await send(backendId, `${backendId} before candidate probe failure`));
    }
    await waitFor(
      async () => setup.codex.transport?.requests.filter((request) => request.method === "turn/start").length ?? 0,
      (count) => count === 1,
      "Codex baseline dispatch before candidate probe failure"
    );
    await waitFor(
      async () => setup.claude.queries.reduce((count, query) => count + query.receivedInputs.length, 0),
      (count) => count === 1,
      "Claude baseline dispatch before candidate probe failure"
    );
    const codexSessionId = sessions.get("codex-paired")!;
    const codexThreadId = fixture.application.store.getSession(codexSessionId).descriptor.binding.nativeSessionId;
    if (codexThreadId === undefined) throw new Error("Candidate probe fixture Codex task has no native thread.");
    setup.claude.queries.at(-1)!.complete("Claude baseline before candidate probe failure");
    await setup.codex.completeTurn(codexThreadId, "Codex baseline before candidate probe failure");
    for (const runId of baselineRuns.values()) await waitForRun(runId);
    await waitForStableNumber(
      () => setup.codex.transport?.requests.length ?? 0,
      "settled Codex baseline before candidate probe failure"
    );
    await waitForStableNumber(
      () => setup.claude.queries.reduce((count, query) => count + query.receivedInputs.length, 0),
      "settled Claude baseline before candidate probe failure"
    );

    const retainedBindings = new Map(backendIds.map((backendId) => {
      const binding = structuredClone(
        fixture.application.store.getSession(sessions.get(backendId)!).descriptor.binding
      );
      if (binding.nativeSessionId === undefined) {
        throw new Error(`${backendId} candidate probe task has no native identity.`);
      }
      return [backendId, binding] as const;
    }));
    const retainedAdapters = new Map(backendIds.map((backendId) => {
      const adapter = fixture.application.adapters.find((candidate) => candidate.id === backendId);
      if (adapter === undefined) throw new Error(`No retained ${backendId} Adapter exists.`);
      return [backendId, adapter] as const;
    }));

    for (const backendId of backendIds) {
      const descriptorsBefore = new Map(backendIds.map((id) => [id, structuredClone(
        fixture.application.store.getBackend(id).descriptor
      )] as const));
      const sessionsBefore = new Map(backendIds.map((id) => [id, structuredClone(
        fixture.application.store.getSession(sessions.get(id)!).descriptor
      )] as const));
      const publicSessionsBefore = new Map(await Promise.all(backendIds.map(async (id) => [
        id,
        (await paired.clients.session.getSession({ sessionId: sessions.get(id)! })).session
      ] as const)));
      const authoritiesBefore = new Map(backendIds.map((id) => [id, structuredClone(
        fixture.application.store.getBackendInstanceGenerationAuthority(id)
      )] as const));
      const authorityBefore = authoritiesBefore.get(backendId)!;
      const tracesBefore = {
        providerRequests: setup.requests.length,
        codexRequests: setup.codex.transport?.requests.length ?? 0,
        claudeQueries: setup.claude.queries.length,
        claudeInputs: setup.claude.queries.reduce((count, query) => count + query.receivedInputs.length, 0),
        claudeProbes: setup.claude.probeCount,
        lifecycle: setup.lifecycle.length
      };
      const sentinel = `candidate-probe-secret-${backendId}-${randomUUID()}`;
      const probeFailure = setup.probeFailures.arm(backendId, sentinel);
      const operationId = randomUUID();
      const mutation = restartBackendMutation(backendId);
      const failed = await submit(paired.clients.operation, paired.connectionId, mutation, operationId);

      expect(failed.state).toBe(OperationState.FAILED);
      expect(failed.error).toMatchObject({
        code: "EFFECT_FAILED",
        message: `Backend replacement candidate failed validation: ${backendId}`,
        retryable: false
      });
      expect(probeFailure).toMatchObject({
        backendId,
        generation: descriptorsBefore.get(backendId)!.instanceGeneration + 1,
        factoryCalls: 1,
        probeCalls: 1
      });
      const authorityAfter = fixture.application.store.getBackendInstanceGenerationAuthority(backendId);
      expect(authorityAfter).toMatchObject({
        adapterKind: authorityBefore.adapterKind,
        currentGeneration: authorityBefore.currentGeneration,
        highWaterGeneration: authorityBefore.highWaterGeneration + 1
      });
      for (const siblingId of backendIds) {
        if (siblingId === backendId) continue;
        expect(fixture.application.store.getBackendInstanceGenerationAuthority(siblingId))
          .toEqual(authoritiesBefore.get(siblingId));
      }
      expect(setup.lifecycle.slice(tracesBefore.lifecycle)).toEqual([
        {
          backendId,
          generation: descriptorsBefore.get(backendId)!.instanceGeneration + 1,
          phase: "created"
        },
        {
          backendId,
          generation: descriptorsBefore.get(backendId)!.instanceGeneration + 1,
          phase: "dispose_completed"
        }
      ]);
      for (const id of backendIds) {
        expect(fixture.application.store.getBackend(id).descriptor).toEqual(descriptorsBefore.get(id));
        expect(fixture.application.store.getSession(sessions.get(id)!).descriptor).toEqual(sessionsBefore.get(id));
        expect((await paired.clients.session.getSession({ sessionId: sessions.get(id)! })).session)
          .toEqual(publicSessionsBefore.get(id));
        expect(fixture.application.adapters.find((candidate) => candidate.id === id))
          .toBe(retainedAdapters.get(id));
      }
      expect(setup.requests).toHaveLength(tracesBefore.providerRequests);
      expect(setup.codex.transport?.requests).toHaveLength(tracesBefore.codexRequests);
      expect(setup.claude.queries).toHaveLength(tracesBefore.claudeQueries);
      expect(setup.claude.queries.reduce((count, query) => count + query.receivedInputs.length, 0))
        .toBe(tracesBefore.claudeInputs);
      expect(setup.claude.probeCount).toBe(
        tracesBefore.claudeProbes + (backendId === "claude-paired" ? 1 : 0)
      );
      expect(jsonWithBigints({
        operation: failed,
        durableOperation: fixture.application.store.getOperation(operationId),
        backends: fixture.application.store.listBackends(),
        diagnostics: fixture.application.store.listDiagnostics()
      })).not.toContain(sentinel);

      const tracesBeforeReplay = {
        providerRequests: setup.requests.length,
        codexRequests: setup.codex.transport?.requests.length ?? 0,
        claudeQueries: setup.claude.queries.length,
        claudeInputs: setup.claude.queries.reduce((count, query) => count + query.receivedInputs.length, 0),
        claudeProbes: setup.claude.probeCount,
        lifecycle: setup.lifecycle.length
      };
      const replayed = await submit(paired.clients.operation, paired.connectionId, mutation, operationId);
      expect(replayed.operationId).toBe(failed.operationId);
      expect(replayed.state).toBe(failed.state);
      expect(replayed.requestSha256Hex).toBe(failed.requestSha256Hex);
      expect(replayed.error).toEqual(failed.error);
      expect(probeFailure).toMatchObject({ factoryCalls: 1, probeCalls: 1 });
      expect(fixture.application.store.getBackendInstanceGenerationAuthority(backendId))
        .toEqual(authorityAfter);
      expect(setup.requests).toHaveLength(tracesBeforeReplay.providerRequests);
      expect(setup.codex.transport?.requests).toHaveLength(tracesBeforeReplay.codexRequests);
      expect(setup.claude.queries).toHaveLength(tracesBeforeReplay.claudeQueries);
      expect(setup.claude.queries.reduce((count, query) => count + query.receivedInputs.length, 0))
        .toBe(tracesBeforeReplay.claudeInputs);
      expect(setup.claude.probeCount).toBe(tracesBeforeReplay.claudeProbes);
      expect(setup.lifecycle).toHaveLength(tracesBeforeReplay.lifecycle);
    }

    const assistantCountsBeforeFinal = new Map(backendIds.map((backendId) => [backendId,
      fixture.application.store.listEvents({ sessionId: sessions.get(backendId)! })
        .filter((event) => event.payload.type === "message_complete" && event.payload.role === "assistant").length
    ] as const));
    const usageCountsBeforeFinal = new Map(backendIds.map((backendId) => [backendId,
      fixture.application.store.listEvents({ sessionId: sessions.get(backendId)! })
        .filter((event) => event.payload.type === "usage").length
    ] as const));
    const providerRequestsBeforeFinal = setup.requests.length;
    const codexStartsBeforeFinal = setup.codex.transport?.requests
      .filter((request) => request.method === "turn/start").length ?? 0;
    const claudeInputsBeforeFinal = setup.claude.queries
      .reduce((count, query) => count + query.receivedInputs.length, 0);
    const finalRuns = new Map<BackendId, string>();
    for (const backendId of backendIds) {
      finalRuns.set(backendId, await send(backendId, `${backendId} after candidate probe failures`));
    }
    await waitFor(
      async () => setup.requests.length,
      (count) => count === providerRequestsBeforeFinal + 1,
      "Pi dispatch after candidate probe failures"
    );
    await waitFor(
      async () => setup.codex.transport?.requests.filter((request) => request.method === "turn/start").length ?? 0,
      (count) => count === codexStartsBeforeFinal + 1,
      "Codex dispatch after candidate probe failures"
    );
    await waitFor(
      async () => setup.claude.queries.reduce((count, query) => count + query.receivedInputs.length, 0),
      (count) => count === claudeInputsBeforeFinal + 1,
      "Claude dispatch after candidate probe failures"
    );
    setup.claude.queries.at(-1)!.complete("Claude after candidate probe failures");
    await setup.codex.completeTurn(codexThreadId, "Codex after candidate probe failures");
    const finalAnswers = new Map<BackendId, string>([
      ["pi", REAL_PI_RESPONSE_TEXT],
      ["codex-paired", "Codex after candidate probe failures"],
      ["claude-paired", "Claude after candidate probe failures"]
    ]);
    for (const [backendId, runId] of finalRuns) {
      await waitForRun(runId);
      const sessionId = sessions.get(backendId)!;
      const backendGeneration = fixture.application.store.getBackend(backendId).descriptor.instanceGeneration;
      const binding = fixture.application.store.getSession(sessionId).descriptor.binding;
      expect(binding).toEqual(retainedBindings.get(backendId));
      const queue = fixture.application.store.findQueueItemByRunId(sessionId, runId);
      expect(queue).toMatchObject({
        backendInstanceGeneration: backendGeneration,
        state: "completed",
        attemptId: expect.any(String)
      });
      expect(fixture.application.store.listAttempts(runId)).toHaveLength(1);
      const attempt = fixture.application.store.getAttempt(queue!.attemptId!).descriptor;
      expect(attempt).toMatchObject({
        runId,
        generation: binding.generation,
        backendInstanceGeneration: backendGeneration,
        endedAt: expect.any(Number)
      });
      expect(attempt.error).toBeUndefined();

      const events = fixture.application.store.listEvents({ sessionId });
      const assistantEvents = events.filter((event) =>
        event.runId === runId
        && event.payload.type === "message_complete"
        && event.payload.role === "assistant");
      const assistantDelta = events.filter((event) =>
        event.payload.type === "message_complete" && event.payload.role === "assistant")
        .slice(assistantCountsBeforeFinal.get(backendId));
      const usageDelta = events.filter((event) => event.payload.type === "usage")
        .slice(usageCountsBeforeFinal.get(backendId));
      const doneEvents = events.filter((event) => event.runId === runId && event.payload.type === "done");
      expect(assistantEvents).toHaveLength(1);
      expect(assistantDelta.length).toBeGreaterThan(0);
      expect(jsonWithBigints(assistantEvents)).toContain(finalAnswers.get(backendId));
      for (const event of assistantEvents) {
        expect(event).toMatchObject({
          backendId,
          sessionId,
          runId,
          attemptId: queue!.attemptId,
          generation: binding.generation
        });
      }
      expect(doneEvents).toHaveLength(1);
      expect(doneEvents[0]).toMatchObject({
        backendId,
        sessionId,
        runId,
        attemptId: queue!.attemptId,
        generation: binding.generation,
        payload: { type: "done", outcome: "completed" }
      });
      expect(
        usageDelta.some((event) => event.runId === runId && event.attemptId === queue!.attemptId)
        || assistantEvents.some((event) => event.payload.type === "message_complete" && event.payload.usage !== undefined)
      ).toBe(true);
      for (const event of usageDelta) {
        expect(event).toMatchObject({ backendId, sessionId, generation: binding.generation });
        expect(
          (event.runId === runId && event.attemptId === queue!.attemptId)
          || (
            event.runId === undefined
            && event.attemptId === undefined
            && event.metadata?.namespace === "joko.runtime_usage"
            && event.metadata.fields.cumulative === true
          )
        ).toBe(true);
      }
      for (const [otherBackendId, otherSessionId] of sessions) {
        if (otherBackendId === backendId) continue;
        const otherEvents = fixture.application.store.listEvents({ sessionId: otherSessionId });
        expect(otherEvents.some((event) => event.runId === runId || event.attemptId === queue!.attemptId)).toBe(false);
        expect(jsonWithBigints(otherEvents)).not.toContain(`${backendId} after candidate probe failures`);
        expect(jsonWithBigints(otherEvents)).not.toContain(finalAnswers.get(backendId));
      }
    }
  } finally {
    await setup.close();
  }
});

it("fences consumed native inputs with lost receipts without blocking sibling Backends", { timeout: 180_000 }, async () => {
  const setup = await startPairedFixture(undefined, { controlPiFault: true });
  try {
    const fixture = setup.fixture;
    const paired = await fixture.pair("Paired lost receipt client");
    const backendIds = ["pi", "codex-paired", "claude-paired"] as const;
    type BackendId = (typeof backendIds)[number];
    type SessionPair = { readonly fault: string; readonly control: string };
    const sessions = new Map<BackendId, SessionPair>();

    for (const backendId of backendIds) {
      const created: Partial<Record<keyof SessionPair, string>> = {};
      for (const kind of ["fault", "control"] as const) {
        const operation = await submit(
          paired.clients.operation,
          paired.connectionId,
          createSessionMutation({
            backendId,
            targetId: fixture.targetId(backendId),
            displayName: `${backendId} lost receipt ${kind}`,
            ...(backendId === "pi"
              ? { providerId: REAL_PI_PROVIDER_ID, modelId: REAL_PI_MODEL_ID, effortId: "off" }
              : {})
          })
        );
        expect(operation.state).toBe(OperationState.SUCCEEDED);
        created[kind] = sessionIdFrom(operation);
      }
      sessions.set(backendId, created as SessionPair);
    }

    const nativeSessionId = (backendId: BackendId, kind: keyof SessionPair): string => {
      const sessionId = sessions.get(backendId)![kind];
      const nativeId = fixture.application.store.getSession(sessionId).descriptor.binding.nativeSessionId;
      if (nativeId === undefined) throw new Error(`${backendId} ${kind} task has no native identity.`);
      return nativeId;
    };
    const publicGeneration = async (sessionId: string): Promise<bigint> => {
      const session = (await paired.clients.session.getSession({ sessionId })).session;
      if (session?.version?.generation === undefined) {
        throw new Error(`${sessionId} has no public generation.`);
      }
      expect(session.nativeBinding?.runtimeGeneration).toBe(session.version.generation);
      return session.version.generation;
    };
    const allSessionIds = backendIds.flatMap((backendId) => {
      const pair = sessions.get(backendId)!;
      return [pair.fault, pair.control];
    });
    const baselineTexts = new Map<string, string>();
    const baselineRuns = new Map<string, string>();
    for (const backendId of backendIds) {
      for (const kind of ["fault", "control"] as const) {
        const sessionId = sessions.get(backendId)![kind];
        const text = `${backendId} ${kind} baseline before lost receipt`;
        baselineTexts.set(sessionId, text);
        const accepted = await submit(
          paired.clients.operation,
          paired.connectionId,
          sendInputMutation(sessionId, await publicGeneration(sessionId), text)
        );
        expect(accepted.state).toBe(OperationState.SUCCEEDED);
        baselineRuns.set(sessionId, queueRunIdFrom(accepted));
      }
    }
    for (const kind of ["fault", "control"] as const) {
      const sessionId = sessions.get("codex-paired")![kind];
      const text = baselineTexts.get(sessionId)!;
      await waitFor(
        async () => (setup.codex.transport?.requests ?? []).some((request) =>
          request.method === "turn/start" && jsonWithBigints(request.params).includes(text)),
        (dispatched) => dispatched,
        `Codex ${kind} baseline dispatch`
      );
      await setup.codex.completeTurn(
        nativeSessionId("codex-paired", kind),
        `Codex ${kind} baseline answer`
      );
    }
    for (const kind of ["fault", "control"] as const) {
      const sessionId = sessions.get("claude-paired")![kind];
      const text = baselineTexts.get(sessionId)!;
      const nativeId = nativeSessionId("claude-paired", kind);
      const query = await waitFor(
        async () => setup.claude.queries.find((candidate) =>
          (candidate.params.options.resume ?? candidate.params.options.sessionId) === nativeId
          && jsonWithBigints(candidate.receivedInputs).includes(text)),
        (candidate) => candidate !== undefined,
        `Claude ${kind} baseline dispatch`
      );
      query!.complete(`Claude ${kind} baseline answer`);
    }
    for (const [sessionId, runId] of baselineRuns) {
      await waitFor(
        () => paired.clients.run.getRun({ runId }),
        (value) => value.run?.state === RunState.SUCCEEDED,
        `${sessionId} baseline completion`
      );
      expect(fixture.application.store.findQueueItemByRunId(sessionId, runId)?.state).toBe("completed");
    }
    await waitForStableNumber(
      () => setup.codex.transport?.requests.length ?? 0,
      "Codex baseline read quiescence"
    );
    const frozenBindings = new Map(allSessionIds.map((sessionId) => [sessionId, structuredClone(
      fixture.application.store.getSession(sessionId).descriptor.binding
    )] as const));
    const frozenBackendGenerations = new Map(backendIds.map((backendId) => [
      backendId,
      fixture.application.store.getBackend(backendId).descriptor.instanceGeneration
    ] as const));
    const nativeFootprintAfterBaseline = {
      piProcesses: setup.piProcesses.processes.length,
      codexThreads: setup.codex.threads.size,
      claudeQueries: setup.claude.queries.length,
      claudeSessions: setup.claude.sessions.size
    };
    expect(nativeFootprintAfterBaseline).toEqual({
      piProcesses: 2,
      codexThreads: 2,
      claudeQueries: 2,
      claudeSessions: 2
    });
    for (const backendId of backendIds) {
      expect(fixture.application.store.getBackend(backendId).descriptor.instanceGeneration)
        .toBe(frozenBackendGenerations.get(backendId));
      for (const kind of ["fault", "control"] as const) {
        const sessionId = sessions.get(backendId)![kind];
        expect(fixture.application.store.getSession(sessionId).descriptor.binding)
          .toEqual(frozenBindings.get(sessionId));
        expect(nativeSessionId(backendId, kind)).toBe(frozenBindings.get(sessionId)!.nativeSessionId);
      }
    }
    const faultTexts = new Map<BackendId, string>([
      ["pi", "Pi consumed this input but its receipt vanished"],
      ["codex-paired", "Codex consumed this input but its receipt vanished"],
      ["claude-paired", "Claude consumed this input but its receipt vanished"]
    ]);
    const expectedErrors = new Map<BackendId, {
      readonly code: string;
      readonly phase: string;
      readonly retryable: boolean;
    }>([
      ["pi", { code: "PI_PROCESS_EXITED", phase: "stream", retryable: true }],
      ["codex-paired", { code: "CODEX_DISPATCH_UNKNOWN", phase: "dispatch", retryable: false }],
      ["claude-paired", { code: "NATIVE_DISPATCH_UNKNOWN", phase: "dispatch", retryable: true }]
    ]);
    type FaultDispatch = {
      readonly mutation: ReturnType<typeof sendInputMutation>;
      readonly operationId: string;
      readonly operation: Awaited<ReturnType<typeof submit>>;
      readonly runId: string;
    };
    const faultDispatches = new Map<BackendId, FaultDispatch>();
    const bindingsBeforeFault = new Map(backendIds.map((backendId) => [backendId,
      frozenBindings.get(sessions.get(backendId)!.fault)!
    ] as const));

    const codexFaultNativeId = nativeSessionId("codex-paired", "fault");
    let codexFaultRequestsBefore = -1;
    const claudeFaultNativeId = nativeSessionId("claude-paired", "fault");
    setup.claude.failNextInputBeforeAdmission(claudeFaultNativeId);

    for (const backendId of backendIds) {
      const sessionId = sessions.get(backendId)!.fault;
      const text = faultTexts.get(backendId)!;
      if (backendId === "pi") setup.piProcesses.loseNextPromptAcknowledgement(text);
      if (backendId === "codex-paired") {
        codexFaultRequestsBefore = setup.codex.transport?.requests.length ?? 0;
        setup.codex.dropNextTurnClientId = true;
        setup.codex.timeoutNextTurnStart = true;
      }
      const mutation = sendInputMutation(sessionId, await publicGeneration(sessionId), text);
      const operationId = randomUUID();
      const operation = await submit(
        paired.clients.operation,
        paired.connectionId,
        mutation,
        operationId
      );
      expect(operation.state).toBe(OperationState.SUCCEEDED);
      const runId = queueRunIdFrom(operation);
      faultDispatches.set(backendId, { mutation, operationId, operation, runId });
      await waitFor(
        () => paired.clients.run.getRun({ runId }),
        (value) => value.run?.state === RunState.DISPATCH_UNKNOWN,
        `${backendId} public dispatch_unknown Run`
      );
      const queueItems = await waitFor(
        () => paired.clients.queue.listQueueItems({ sessionId }),
        (value) => value.queueItems.some((item) =>
          item.runId === runId && item.state === QueueItemState.DISPATCH_UNKNOWN),
        `${backendId} public dispatch_unknown QueueItem`
      );
      expect(queueItems.queueItems.find((item) => item.runId === runId)?.state)
        .toBe(QueueItemState.DISPATCH_UNKNOWN);
    }

    const piFaultSessionId = sessions.get("pi")!.fault;
    await waitFor(
      async () => setup.unexpectedPiRuntimeExits.filter((exit) => exit.sessionId === piFaultSessionId).length,
      (count) => count === 1,
      "Pi unexpected runtime invalidation callback"
    );
    expect(fixture.application.sessionHost.isSessionActive(piFaultSessionId)).toBe(false);
    expect(fixture.application.sessionHost.isSessionActive(sessions.get("pi")!.control)).toBe(true);
    const claudeFaultQuery = await waitFor(
      async () => setup.claude.queries.findLast((query) =>
        (query.params.options.resume ?? query.params.options.sessionId) === claudeFaultNativeId
        && jsonWithBigints(query.receivedInputs).includes(faultTexts.get("claude-paired")!)),
      (query) => query !== undefined,
      "Claude consumed input before its continuation stream failed"
    );

    const faultAttempts = new Map<BackendId, string>();
    for (const backendId of backendIds) {
      const sessionId = sessions.get(backendId)!.fault;
      const runId = faultDispatches.get(backendId)!.runId;
      const expectedError = expectedErrors.get(backendId)!;
      const queue = fixture.application.store.findQueueItemByRunId(sessionId, runId);
      expect(queue).toMatchObject({
        state: "dispatch_unknown",
        backendInstanceGeneration: fixture.application.store.getBackend(backendId).descriptor.instanceGeneration,
        error: { ...expectedError, stateMayHaveChanged: true }
      });
      if (queue?.attemptId === undefined) throw new Error(`${backendId} unknown dispatch has no Attempt.`);
      faultAttempts.set(backendId, queue.attemptId);
      const run = fixture.application.store.getRun(runId).descriptor;
      expect(run).toMatchObject({
        sessionId,
        state: "dispatch_unknown",
        activeAttemptId: queue.attemptId,
        error: { ...expectedError, stateMayHaveChanged: true }
      });
      expect(fixture.application.store.getAttempt(queue.attemptId).descriptor).toMatchObject({
        runId,
        generation: bindingsBeforeFault.get(backendId)!.generation,
        backendInstanceGeneration: queue.backendInstanceGeneration,
        endedAt: expect.any(Number),
        error: { ...expectedError, stateMayHaveChanged: true }
      });
      expect(fixture.application.store.listAttempts(runId)).toHaveLength(1);
      expect(fixture.application.store.getSession(sessionId).descriptor.binding)
        .toEqual(bindingsBeforeFault.get(backendId));
      const ownEvents = fixture.application.store.listEvents({ sessionId });
      expect(ownEvents.some((event) => event.runId === runId && (
        event.payload.type === "usage"
        || (event.payload.type === "message_complete" && event.payload.role === "assistant")
      ))).toBe(false);
      expect(ownEvents.some((event) =>
        (event.runId === runId || event.attemptId === queue.attemptId)
        && event.payload.type === "done"
        && event.payload.outcome === "completed"
      )).toBe(false);
    }

    const piFaultText = faultTexts.get("pi")!;
    expect(setup.piProcesses.promptDispatches.filter((dispatch) => dispatch.message === piFaultText))
      .toHaveLength(1);
    expect(setup.piProcesses.lostAcknowledgements.filter((receipt) => receipt.message === piFaultText))
      .toEqual([expect.objectContaining({ providerObserved: true, killAccepted: true })]);
    expect(setup.requests.filter((request) => jsonWithBigints(request.body).includes(piFaultText)))
      .toHaveLength(1);
    expect(setup.unexpectedPiRuntimeExits).toContainEqual({
      sessionId: piFaultSessionId,
      generation: bindingsBeforeFault.get("pi")!.generation,
      backendInstanceGeneration: fixture.application.store.getBackend("pi").descriptor.instanceGeneration
    });
    const codexFaultText = faultTexts.get("codex-paired")!;
    expect((setup.codex.transport?.requests ?? []).filter((request) =>
      request.method === "turn/start" && jsonWithBigints(request.params).includes(codexFaultText)))
      .toHaveLength(1);
    expect(jsonWithBigints(setup.codex.threads.get(codexFaultNativeId))).toContain(codexFaultText);
    const codexFaultReadOnlyRequests = (setup.codex.transport?.requests ?? [])
      .slice(codexFaultRequestsBefore)
      .filter((request) =>
        (request.method === "thread/read" || request.method === "thread/turns/list")
        && typeof request.params === "object"
        && request.params !== null
        && "threadId" in request.params
        && request.params.threadId === codexFaultNativeId);
    const codexReconciliationReads = codexFaultReadOnlyRequests.filter((request) => request.method === "thread/read");
    const codexReconciliationTurnPages = codexFaultReadOnlyRequests.filter((request) =>
      request.method === "thread/turns/list");
    expect(codexReconciliationReads.length).toBeGreaterThanOrEqual(2);
    expect(codexReconciliationReads.every((request) =>
      typeof request.params === "object"
      && request.params !== null
      && "includeTurns" in request.params
      && request.params.includeTurns === false
    )).toBe(true);
    const ascendingPage = codexReconciliationTurnPages.find((request) =>
      typeof request.params === "object"
      && request.params !== null
      && "sortDirection" in request.params
      && request.params.sortDirection === "asc"
      && "itemsView" in request.params
      && request.params.itemsView === "full"
      && "limit" in request.params
      && request.params.limit === 100);
    if (ascendingPage === undefined) throw new Error("Codex reconciliation issued no ascending history page.");
    const ascendingPageIndex = codexFaultReadOnlyRequests.indexOf(ascendingPage);
    const descendingPage = codexFaultReadOnlyRequests[ascendingPageIndex + 1];
    expect(descendingPage).toMatchObject({
      method: "thread/turns/list",
      params: {
        threadId: codexFaultNativeId,
        sortDirection: "desc",
        itemsView: "full",
        limit: 1
      }
    });
    const descendingPageIndex = ascendingPageIndex + 1;
    expect(ascendingPageIndex).toBeGreaterThan(0);
    expect(descendingPageIndex).toBe(ascendingPageIndex + 1);
    expect(codexFaultReadOnlyRequests.slice(0, ascendingPageIndex).some((request) =>
      request.method === "thread/read")).toBe(true);
    expect(codexFaultReadOnlyRequests.slice(descendingPageIndex + 1).some((request) =>
      request.method === "thread/read")).toBe(true);
    const claudeFaultText = faultTexts.get("claude-paired")!;
    expect(claudeFaultQuery!.receivedInputs.filter((input) =>
      jsonWithBigints(input).includes(claudeFaultText))).toHaveLength(1);
    expect(jsonWithBigints(claudeFaultQuery!.receivedInputs)).toContain(claudeFaultText);
    expect(setup.claude.queries.filter((query) =>
      (query.params.options.resume ?? query.params.options.sessionId) === claudeFaultNativeId))
      .toHaveLength(1);
    expect({
      piProcesses: setup.piProcesses.processes.length,
      codexThreads: setup.codex.threads.size,
      claudeQueries: setup.claude.queries.length,
      claudeSessions: setup.claude.sessions.size
    }).toEqual(nativeFootprintAfterBaseline);
    for (const sessionId of allSessionIds) {
      expect(fixture.application.store.getSession(sessionId).descriptor.binding)
        .toEqual(frozenBindings.get(sessionId));
    }

    const tracesBeforeReplay = {
      providerRequests: setup.requests.length,
      piProcesses: setup.piProcesses.processes.length,
      piPrompts: setup.piProcesses.promptDispatches.length,
      piLostAcknowledgements: setup.piProcesses.lostAcknowledgements.length,
      piUnexpectedExits: setup.unexpectedPiRuntimeExits.length,
      codexRequests: setup.codex.transport?.requests.length ?? 0,
      claudeQueries: setup.claude.queries.length,
      claudeInputs: setup.claude.queries.reduce((count, query) => count + query.receivedInputs.length, 0),
      lifecycle: setup.lifecycle.length
    };
    for (const backendId of backendIds) {
      const dispatch = faultDispatches.get(backendId)!;
      const replayed = await submit(
        paired.clients.operation,
        paired.connectionId,
        dispatch.mutation,
        dispatch.operationId
      );
      expect(replayed.operationId).toBe(dispatch.operation.operationId);
      expect(replayed.state).toBe(dispatch.operation.state);
      expect(replayed.requestSha256Hex).toBe(dispatch.operation.requestSha256Hex);
      expect(queueRunIdFrom(replayed)).toBe(dispatch.runId);
      const sessionId = sessions.get(backendId)!.fault;
      expect(fixture.application.store.listQueueItems({ sessionId })).toHaveLength(2);
      expect(fixture.application.store.listAttempts(dispatch.runId)).toHaveLength(1);
      expect(fixture.application.store.findQueueItemByRunId(sessionId, dispatch.runId)).toMatchObject({
        attemptId: faultAttempts.get(backendId),
        state: "dispatch_unknown"
      });
    }
    expect({
      providerRequests: setup.requests.length,
      piProcesses: setup.piProcesses.processes.length,
      piPrompts: setup.piProcesses.promptDispatches.length,
      piLostAcknowledgements: setup.piProcesses.lostAcknowledgements.length,
      piUnexpectedExits: setup.unexpectedPiRuntimeExits.length,
      codexRequests: setup.codex.transport?.requests.length ?? 0,
      claudeQueries: setup.claude.queries.length,
      claudeInputs: setup.claude.queries.reduce((count, query) => count + query.receivedInputs.length, 0),
      lifecycle: setup.lifecycle.length
    }).toEqual(tracesBeforeReplay);

    for (const backendId of backendIds) {
      const backendDescriptorsBefore = new Map(backendIds.map((id) => [id, structuredClone(
        fixture.application.store.getBackend(id).descriptor
      )] as const));
      const authoritiesBefore = new Map(backendIds.map((id) => [id, structuredClone(
        fixture.application.store.getBackendInstanceGenerationAuthority(id)
      )] as const));
      const sessionsBefore = new Map(allSessionIds.map((sessionId) => [sessionId, structuredClone(
        fixture.application.store.getSession(sessionId).descriptor
      )] as const));
      const adaptersBefore = new Map(backendIds.map((id) => [id,
        fixture.application.adapters.find((adapter) => adapter.id === id)
      ] as const));
      const tracesBeforeRestart = {
        providerRequests: setup.requests.length,
        piProcesses: setup.piProcesses.processes.length,
        piPrompts: setup.piProcesses.promptDispatches.length,
        codexRequests: setup.codex.transport?.requests.length ?? 0,
        claudeQueries: setup.claude.queries.length,
        claudeInputs: setup.claude.queries.reduce((count, query) => count + query.receivedInputs.length, 0),
        lifecycle: setup.lifecycle.length
      };
      const failedRestart = await submit(
        paired.clients.operation,
        paired.connectionId,
        restartBackendMutation(backendId),
        randomUUID()
      );
      expect(failedRestart.state).toBe(OperationState.FAILED);
      expect(failedRestart.error?.message)
        .toBe("A Backend can be restarted only after every affected task has no active or queued work.");
      for (const id of backendIds) {
        expect(fixture.application.store.getBackend(id).descriptor).toEqual(backendDescriptorsBefore.get(id));
        expect(fixture.application.store.getBackendInstanceGenerationAuthority(id)).toEqual(authoritiesBefore.get(id));
        expect(fixture.application.adapters.find((adapter) => adapter.id === id)).toBe(adaptersBefore.get(id));
      }
      for (const sessionId of allSessionIds) {
        expect(fixture.application.store.getSession(sessionId).descriptor).toEqual(sessionsBefore.get(sessionId));
      }
      expect({
        providerRequests: setup.requests.length,
        piProcesses: setup.piProcesses.processes.length,
        piPrompts: setup.piProcesses.promptDispatches.length,
        codexRequests: setup.codex.transport?.requests.length ?? 0,
        claudeQueries: setup.claude.queries.length,
        claudeInputs: setup.claude.queries.reduce((count, query) => count + query.receivedInputs.length, 0),
        lifecycle: setup.lifecycle.length
      }).toEqual(tracesBeforeRestart);
    }

    const controlTexts = new Map<BackendId, string>([
      ["pi", "Pi sibling continues after lost receipt"],
      ["codex-paired", "Codex sibling continues after lost receipt"],
      ["claude-paired", "Claude sibling continues after lost receipt"]
    ]);
    const controlAnswers = new Map<BackendId, string>([
      ["pi", REAL_PI_RESPONSE_TEXT],
      ["codex-paired", "Codex sibling answer after lost receipt"],
      ["claude-paired", "Claude sibling answer after lost receipt"]
    ]);
    const controlRuns = new Map<BackendId, string>();
    for (const backendId of backendIds) {
      const sessionId = sessions.get(backendId)!.control;
      const accepted = await submit(
        paired.clients.operation,
        paired.connectionId,
        sendInputMutation(sessionId, await publicGeneration(sessionId), controlTexts.get(backendId)!)
      );
      expect(accepted.state).toBe(OperationState.SUCCEEDED);
      controlRuns.set(backendId, queueRunIdFrom(accepted));
    }
    await waitFor(
      async () => setup.requests.filter((request) =>
        jsonWithBigints(request.body).includes(controlTexts.get("pi")!)).length,
      (count) => count === 1,
      "Pi sibling Provider dispatch"
    );
    const codexControlNativeId = nativeSessionId("codex-paired", "control");
    await waitFor(
      async () => (setup.codex.transport?.requests ?? []).filter((request) =>
        request.method === "turn/start"
        && jsonWithBigints(request.params).includes(controlTexts.get("codex-paired")!)).length,
      (count) => count === 1,
      "Codex sibling dispatch"
    );
    const claudeControlNativeId = nativeSessionId("claude-paired", "control");
    const claudeControlQuery = await waitFor(
      async () => setup.claude.queries.findLast((query) =>
        (query.params.options.resume ?? query.params.options.sessionId) === claudeControlNativeId
        && jsonWithBigints(query.receivedInputs).includes(controlTexts.get("claude-paired")!)),
      (query) => query !== undefined && query.receivedInputs.filter((input) =>
        jsonWithBigints(input).includes(controlTexts.get("claude-paired")!)).length === 1,
      "Claude sibling dispatch"
    );
    claudeControlQuery!.complete(controlAnswers.get("claude-paired")!);
    await setup.codex.completeTurn(codexControlNativeId, controlAnswers.get("codex-paired")!);

    for (const [backendId, runId] of controlRuns) {
      await waitFor(
        () => paired.clients.run.getRun({ runId }),
        (value) => value.run?.state === RunState.SUCCEEDED,
        `${backendId} sibling completion`
      );
      const sessionId = sessions.get(backendId)!.control;
      const queue = fixture.application.store.findQueueItemByRunId(sessionId, runId);
      expect(queue).toMatchObject({
        state: "completed",
        backendInstanceGeneration: fixture.application.store.getBackend(backendId).descriptor.instanceGeneration
      });
      if (queue?.attemptId === undefined) throw new Error(`${backendId} control Run has no Attempt.`);
      expect(fixture.application.store.getAttempt(queue.attemptId).descriptor).toMatchObject({
        runId,
        generation: fixture.application.store.getSession(sessionId).descriptor.binding.generation,
        backendInstanceGeneration: queue.backendInstanceGeneration,
        endedAt: expect.any(Number)
      });
      const events = fixture.application.store.listEvents({ sessionId });
      const assistantEvents = events.filter((event) =>
        event.runId === runId
        && event.attemptId === queue.attemptId
        && event.payload.type === "message_complete"
        && event.payload.role === "assistant");
      const doneEvents = events.filter((event) =>
        event.runId === runId && event.attemptId === queue.attemptId && event.payload.type === "done");
      const runUsageEvents = events.filter((event) =>
        event.runId === runId && event.attemptId === queue.attemptId && event.payload.type === "usage");
      expect(assistantEvents).toHaveLength(1);
      expect(jsonWithBigints(assistantEvents)).toContain(controlAnswers.get(backendId));
      expect(
        runUsageEvents.length > 0
        || assistantEvents.some((event) => event.payload.type === "message_complete" && event.payload.usage !== undefined),
        `${backendId} sibling Run must own usage evidence`
      ).toBe(true);
      expect(doneEvents).toEqual([expect.objectContaining({
        backendId,
        sessionId,
        generation: fixture.application.store.getSession(sessionId).descriptor.binding.generation,
        payload: { type: "done", outcome: "completed" }
      })]);
    }

    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
    for (const backendId of backendIds) {
      expect(fixture.application.store.getBackend(backendId).descriptor.instanceGeneration)
        .toBe(frozenBackendGenerations.get(backendId));
      for (const kind of ["fault", "control"] as const) {
        const sessionId = sessions.get(backendId)![kind];
        expect(fixture.application.store.getSession(sessionId).descriptor.binding)
          .toEqual(frozenBindings.get(sessionId));
        expect(nativeSessionId(backendId, kind)).toBe(frozenBindings.get(sessionId)!.nativeSessionId);
      }
    }
    expect({
      piProcesses: setup.piProcesses.processes.length,
      codexThreads: setup.codex.threads.size,
      claudeQueries: setup.claude.queries.length,
      claudeSessions: setup.claude.sessions.size
    }).toEqual(nativeFootprintAfterBaseline);
    for (const kind of ["fault", "control"] as const) {
      const nativeId = nativeSessionId("claude-paired", kind);
      expect(setup.claude.queries.filter((query) =>
        (query.params.options.resume ?? query.params.options.sessionId) === nativeId))
        .toHaveLength(1);
    }

    const allRuns = [
      ...backendIds.map((backendId) => ({
        backendId,
        kind: "fault" as const,
        sessionId: sessions.get(backendId)!.fault,
        runId: faultDispatches.get(backendId)!.runId,
        attemptId: faultAttempts.get(backendId)!,
        text: faultTexts.get(backendId)!
      })),
      ...backendIds.map((backendId) => {
        const sessionId = sessions.get(backendId)!.control;
        const runId = controlRuns.get(backendId)!;
        const queue = fixture.application.store.findQueueItemByRunId(sessionId, runId)!;
        return {
          backendId,
          kind: "control" as const,
          sessionId,
          runId,
          attemptId: queue.attemptId!,
          text: controlTexts.get(backendId)!
        };
      })
    ];
    for (const owner of allRuns) {
      const events = fixture.application.store.listEvents({ sessionId: owner.sessionId });
      for (const other of allRuns) {
        if (other.sessionId === owner.sessionId) continue;
        expect(events.some((event) => event.runId === other.runId || event.attemptId === other.attemptId),
          `${owner.backendId} ${owner.kind} task must not receive ${other.backendId} ${other.kind} authority`)
          .toBe(false);
        expect(jsonWithBigints(events)).not.toContain(other.text);
        if (other.kind === "control" && other.backendId !== "pi") {
          expect(jsonWithBigints(events)).not.toContain(controlAnswers.get(other.backendId));
        }
      }
    }
    for (const backendId of backendIds) {
      const dispatch = faultDispatches.get(backendId)!;
      const sessionId = sessions.get(backendId)!.fault;
      expect(fixture.application.store.findQueueItemByRunId(sessionId, dispatch.runId)).toMatchObject({
        state: "dispatch_unknown",
        attemptId: faultAttempts.get(backendId),
        error: { code: expectedErrors.get(backendId)!.code, stateMayHaveChanged: true }
      });
      expect(fixture.application.store.getRun(dispatch.runId).descriptor.state).toBe("dispatch_unknown");
      expect(fixture.application.store.listAttempts(dispatch.runId)).toHaveLength(1);
    }
    expect(setup.piProcesses.promptDispatches.filter((dispatch) => dispatch.message === piFaultText))
      .toHaveLength(1);
    expect((setup.codex.transport?.requests ?? []).filter((request) =>
      request.method === "turn/start" && jsonWithBigints(request.params).includes(codexFaultText)))
      .toHaveLength(1);
    expect(claudeFaultQuery!.receivedInputs.filter((input) =>
      jsonWithBigints(input).includes(claudeFaultText))).toHaveLength(1);
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

async function startPairedFixture(
  webDirectory?: string,
  options: { readonly controlPiFault?: boolean } = {}
) {
  const root = await mkdtemp(join(tmpdir(), "joko-paired-backends-"));
  const requests: Parameters<typeof startLocalProvider>[0] = [];
  const piProcesses = new ControlledPiProcessFactory();
  const providerServer = await startLocalProvider(
    requests,
    undefined,
    undefined,
    [],
    async ({ request }) => {
      await piProcesses.gateProviderRequest(request.body);
      return { kind: "text", text: REAL_PI_RESPONSE_TEXT };
    }
  );
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
  const lifecycle: AdapterLifecycleEvent[] = [];
  const probeFailures = new CandidateProbeFailureController();
  const unexpectedPiRuntimeExits: Array<{
    readonly sessionId: string;
    readonly generation: number;
    readonly backendInstanceGeneration: number;
  }> = [];
  let fixture: OrchestratorE2eFixture | undefined;
  let closed = false;
  const closeProvider = () => new Promise<void>((resolvePromise, reject) => {
    providerServer.close((error) => error === undefined ? resolvePromise() : reject(error));
  });
  const startFixture = () => OrchestratorE2eFixture.start({ rootDirectory: root, profiles: [],
    ...(webDirectory === undefined ? {} : { webDirectory }), backendFactories: [
    { instanceId: "pi", adapterKind: "pi", displayName: "Published Pi",
      create: ({ generation }) => {
        const fault = probeFailures.take("pi", generation);
        const adapter = createPiAdapter({
          agentHome: join(root, "pi-agent-home"), sessionRoot: join(root, "pi-sessions"),
          externalSessionRoots: [], providers: [provider], versionProbe: async () => "pi 0.84.4",
          ...(fault === undefined ? {} : {
            command: join(root, `missing-pi-candidate-${generation}`),
            environment: { JOKO_PAIRED_CANDIDATE_SECRET: fault.sentinel },
            secretEnvironmentNames: ["JOKO_PAIRED_CANDIDATE_SECRET"]
          }),
          ...(options.controlPiFault === true ? {
            processFactory: piProcesses.create,
            processSupervisor: createDefaultPiManagedProcessSupervisor(),
            onUnexpectedRuntimeExit: (sessionId: string, runtimeGeneration: number) => {
              unexpectedPiRuntimeExits.push({
                sessionId,
                generation: runtimeGeneration,
                backendInstanceGeneration: generation
              });
              fixture?.application.sessionHost.invalidateRuntime({
                backendId: "pi",
                backendInstanceGeneration: generation,
                sessionId,
                generation: runtimeGeneration
              });
            }
          } : {})
        });
        if (fault !== undefined) probeFailures.observeProbe(adapter, fault);
        return observeAdapterLifecycle(adapter, generation, lifecycle);
      } },
    { instanceId: "codex-paired", adapterKind: "codex", displayName: "Codex",
      create: ({ generation }) => {
        const fault = probeFailures.take("codex-paired", generation);
        const adapter = createCodexAdapter({
          id: "codex-paired",
          instanceGeneration: generation,
          ...(fault === undefined ? { host: codexHost } : {
            appServer: {
              transportFactory: () => new ScriptedRpcTransport(async () => {
                throw new Error(`Controlled Codex handshake failure: ${fault.sentinel}`);
              })
            }
          })
        });
        if (fault !== undefined) {
          probeFailures.observeProbe(adapter, fault);
        }
        return observeAdapterLifecycle(adapter, generation, lifecycle);
      } },
    { instanceId: "claude-paired", adapterKind: "claude-agent-sdk-stdio", displayName: "Claude",
      create: ({ generation }) => {
        const fault = probeFailures.take("claude-paired", generation);
        if (fault !== undefined) claude.failNextProbe(fault.sentinel);
        const adapter = new ClaudeCodeAdapter({
          id: "claude-paired", instanceGeneration: generation,
          runtime: claude, environment: {}, initializationTimeoutMs: 500, admissionTimeoutMs: 500,
          teardownTimeoutMs: 100
        });
        if (fault !== undefined) probeFailures.observeProbe(adapter, fault);
        return observeAdapterLifecycle(adapter, generation, lifecycle);
      } }
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
      piProcesses,
      unexpectedPiRuntimeExits,
      lifecycle,
      probeFailures,
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
        piProcesses.releaseProviderGates();
        await attemptCleanup(cleanupErrors, async () => current?.close({ removeRoot: false }));
        await attemptCleanup(cleanupErrors, () => shutdownCodexHost(codexHost));
        await attemptCleanup(cleanupErrors, closeProvider);
        await attemptCleanup(cleanupErrors, () => rm(root, { recursive: true, force: true }));
        throwCleanupErrors(cleanupErrors, "Paired fixture cleanup failed.");
      }
    };
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    piProcesses.releaseProviderGates();
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

async function waitForStableNumber(
  read: () => number,
  label: string,
  quietMs = 100,
  timeoutMs = 5_000
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let value = read();
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
    const next = read();
    if (next !== value) {
      value = next;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= quietMs) {
      return value;
    }
  }
  throw new Error(`Timed out waiting for ${label}; last value: ${value}.`);
}

interface AdapterLifecycleEvent {
  readonly backendId: string;
  readonly generation: number;
  readonly phase: "created" | "close_completed" | "resume_started" | "resume_completed" | "dispose_completed";
  readonly nativeSessionId?: string;
}

function observeAdapterLifecycle<T extends BackendAdapter>(
  adapter: T,
  generation: number,
  events: AdapterLifecycleEvent[]
): T {
  events.push({ backendId: adapter.id, generation, phase: "created" });
  const closeSession = adapter.closeSession.bind(adapter);
  adapter.closeSession = async (...args: Parameters<BackendAdapter["closeSession"]>) => {
    await closeSession(...args);
    events.push({
      backendId: adapter.id,
      generation,
      phase: "close_completed",
      ...(args[0].nativeSessionId === undefined ? {} : { nativeSessionId: args[0].nativeSessionId })
    });
  };
  const resumeSession = adapter.resumeSession.bind(adapter);
  adapter.resumeSession = async (...args: Parameters<BackendAdapter["resumeSession"]>) => {
    const event = {
      backendId: adapter.id,
      generation,
      ...(args[0].nativeSessionId === undefined ? {} : { nativeSessionId: args[0].nativeSessionId })
    };
    events.push({ ...event, phase: "resume_started" });
    const state = await resumeSession(...args);
    events.push({ ...event, phase: "resume_completed" });
    return state;
  };
  const dispose = adapter.dispose.bind(adapter);
  adapter.dispose = async () => {
    await dispose();
    events.push({ backendId: adapter.id, generation, phase: "dispose_completed" });
  };
  return adapter;
}

interface CandidateProbeFailureRecord {
  readonly backendId: string;
  readonly sentinel: string;
  generation?: number;
  factoryCalls: number;
  probeCalls: number;
}

class CandidateProbeFailureController {
  #armed: CandidateProbeFailureRecord | undefined;
  readonly #records: CandidateProbeFailureRecord[] = [];

  arm(backendId: string, sentinel: string): CandidateProbeFailureRecord {
    if (this.#armed !== undefined) throw new Error("A paired candidate probe failure is already armed.");
    const record = { backendId, sentinel, factoryCalls: 0, probeCalls: 0 };
    this.#armed = record;
    this.#records.push(record);
    return record;
  }

  take(backendId: string, generation: number): CandidateProbeFailureRecord | undefined {
    const record = this.#armed;
    if (record === undefined || record.backendId !== backendId) {
      const consumed = this.#records.find((candidate) =>
        candidate.backendId === backendId && candidate.generation === generation
      );
      if (consumed !== undefined) consumed.factoryCalls++;
      return undefined;
    }
    this.#armed = undefined;
    record.factoryCalls++;
    record.generation = generation;
    return record;
  }

  observeProbe<T extends BackendAdapter>(adapter: T, record: CandidateProbeFailureRecord): void {
    const describe = adapter.describe.bind(adapter);
    adapter.describe = async () => {
      record.probeCalls++;
      return describe();
    };
  }
}
