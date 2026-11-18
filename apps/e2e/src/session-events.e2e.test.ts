import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { create, fromBinary } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import {
  CompactSessionOutcome,
  EntityKind,
  EventCursorSchema,
  InteractionState,
  NativeNavigationTargetSchema,
  OperationMutationSchema,
  OperationState,
  OwnerSnapshotScopeSchema,
  PermissionMode,
  QueueDeliveryMode,
  RunState,
  SearchSessionMessagesRequestSchema,
  SessionSnapshotScopeSchema,
  SnapshotInvalidationReason,
  SnapshotScopeSchema,
  SubmitOperationRequestSchema,
  SubmitOperationResponseSchema,
  type SubmitOperationRequest,
  nativeSessionTreeRoots
} from "@joko/contracts";
import { PI_LIKE_PROFILE, type FakeAdapterProfile } from "@joko/testkit";
import type { AdapterContext, NativeHistoryEventContext, NativeSessionBinding, PromptInput, SubagentRunDetail, UsageSnapshot } from "@joko/core";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InstrumentedFakeAdapter, OrchestratorE2eFixture, waitFor } from "./fixture.js";
import {
  abortRunMutation,
  archiveMutation,
  cloneMutation,
  compactMutation,
  createSessionMutation,
  deleteMutation,
  editQueuedInputMutation,
  exportMutation,
  forkMutation,
  navigateMutation,
  nextEvent,
  pauseQueueMutation,
  permissionMutation,
  pinMutation,
  planModeMutation,
  queueItemFrom,
  queueRunIdFrom,
  renameMutation,
  reorderQueuedInputBeforeMutation,
  resolvePermissionMutation,
  resumeQueueMutation,
  retryRunMutation,
  sendInputMutation,
  setQueueInteractionLockMutation,
  setQueueItemEditLockMutation,
  sessionIdFrom,
  submit
} from "./operations.js";

const mountedTimelineIt = process.env.JOKO_BROWSER_EXECUTABLE?.trim()
  && process.env.JOKO_MOUNTED_WEB_DIR?.trim() ? it : it.skip;

describe("session host, durable events, and reconnect semantics", () => {
  let fixture: OrchestratorE2eFixture | undefined;
  let browser: Browser | undefined;
  let releaseBrowserRequest: (() => void) | undefined;
  let releaseEventStreams: (() => void) | undefined;

  afterEach(async () => {
    releaseBrowserRequest?.();
    releaseBrowserRequest = undefined;
    releaseEventStreams?.();
    releaseEventStreams = undefined;
    try {
      await Promise.all(browser?.contexts().map((context) => context.setOffline(false)) ?? []);
    } finally {
      try {
        await browser?.close();
      } finally {
        browser = undefined;
        await fixture?.close({ removeRoot: true });
        fixture = undefined;
      }
    }
  });

  it("fences input at atomic admission and replays accepted input after runtime activation", async () => {
    fixture = await OrchestratorE2eFixture.start();
    const paired = await fixture.pair();
    const { store } = fixture.application;
    const adapter = fixture.adapter();
    const created = await submit(paired.clients.operation, paired.connectionId,
      createSessionMutation({ backendId: adapter.id, targetId: fixture.targetId() }));
    const sessionId = sessionIdFrom(created);
    if (created.result?.payload.case !== "session") throw new Error("The create result has no task binding.");
    const sourceGeneration = created.result.payload.value.nativeBinding!.runtimeGeneration;
    const source = sendInputMutation(sessionId, sourceGeneration, "prepared before reset");
    await submit(paired.clients.operation, paired.connectionId, create(OperationMutationSchema, {
      preconditions: source.preconditions,
      payload: { case: "resetSession", value: { sessionId } }
    }));
    const currentGeneration = BigInt(store.getSession(sessionId).descriptor.binding.generation);
    expect(currentGeneration).toBeGreaterThan(sourceGeneration);
    await expect(submit(paired.clients.operation, paired.connectionId, source)).rejects.toMatchObject({ code: Code.Aborted });
    for (const preconditions of [[], [{ entity: source.preconditions[0]!.entity, expectedGeneration: 0n }],
      [{ entity: { ...source.preconditions[0]!.entity!, id: "another-task" }, expectedGeneration: currentGeneration }]]) {
      await expect(submit(paired.clients.operation, paired.connectionId, create(OperationMutationSchema, {
        preconditions, payload: source.payload
      }))).rejects.toMatchObject({ code: Code.InvalidArgument });
    }
    expect(store.listRuns({ sessionId })).toEqual([]);
    expect(store.listQueueItems({ sessionId })).toEqual([]);
    expect(adapter.sendCalls).toEqual([]);

    const operationId = randomUUID();
    const input = sendInputMutation(sessionId, currentGeneration, "accepted before activation");
    // Pinning advances revision only; an unrelated edit cannot invalidate this input.
    await submit(paired.clients.operation, paired.connectionId, pinMutation(sessionId, true));
    const nativeSend = adapter.send.bind(adapter);
    let observedCommitted = false;
    vi.spyOn(adapter, "send").mockImplementation(async (prompt, context) => {
      expect(store.getOperation(operationId)).toMatchObject({ status: "completed", completionMode: "transactional" });
      const queue = store.listQueueItems({ sessionId });
      expect(queue).toHaveLength(1);
      expect(queue[0]?.operationId).toBe(operationId);
      const attemptId = queue[0]?.attemptId;
      if (attemptId === undefined) throw new Error("The admitted queue item has no attempt.");
      expect(store.getAttempt(attemptId).descriptor.generation).toBe(context.generation);
      observedCommitted = true;
      await nativeSend(prompt, context);
    });
    const accepted = await submit(paired.clients.operation, paired.connectionId, input, operationId);
    expect(accepted.state).toBe(OperationState.SUCCEEDED);
    const runId = queueRunIdFrom(accepted);
    await waitFor(() => paired.clients.run.getRun({ runId }), (value) => value.run?.state === RunState.SUCCEEDED, "admitted input to complete");
    expect(observedCommitted).toBe(true);
    expect(BigInt(store.getSession(sessionId).descriptor.binding.generation)).toBeGreaterThan(currentGeneration);
    const replay = await submit(paired.clients.operation, paired.connectionId, input, operationId);
    expect(replay.state).toBe(OperationState.SUCCEEDED);
    expect(queueRunIdFrom(replay)).toBe(runId);
    expect(store.listRuns({ sessionId })).toHaveLength(1);
    expect(store.listQueueItems({ sessionId })).toHaveLength(1);
    expect(adapter.sendCalls).toHaveLength(1);
  });

  it("projects owner/session snapshots and resumes a scoped durable event stream", async () => {
    fixture = await OrchestratorE2eFixture.start({ profiles: [{ ...PI_LIKE_PROFILE, streamDelayMs: 30 }] });
    const paired = await fixture.pair();
    const backendId = fixture.adapter().id;
    const sessionId = sessionIdFrom(await submit(
      paired.clients.operation,
      paired.connectionId,
      createSessionMutation({ backendId, targetId: fixture.targetId(), displayName: "Stream task" })
    ));
    const ownerScope = create(SnapshotScopeSchema, {
      kind: { case: "owner", value: create(OwnerSnapshotScopeSchema, {}) }
    });
    const owner = await paired.clients.event.getSnapshot({ scope: ownerScope });
    expect(owner.snapshot?.sessions.map((item) => item.sessionId)).toContain(sessionId);
    expect(owner.snapshot?.backends.map((item) => item.backendId)).toContain(backendId);

    const sessionScope = create(SnapshotScopeSchema, {
      kind: {
        case: "session",
        value: create(SessionSnapshotScopeSchema, { sessionId, recentTimelineItems: 200 })
      }
    });
    const before = await paired.clients.event.getSnapshot({ scope: sessionScope });
    expect(before.snapshot?.resumeCursor).toBeDefined();

    const streamed = nextEvent(paired.clients.event, {
      scope: sessionScope,
      afterCursor: before.snapshot!.resumeCursor
    });
    await submit(paired.clients.operation, paired.connectionId, sendInputMutation(sessionId, BigInt(fixture!.application.store.getSession(sessionId).descriptor.binding.generation), "streamed turn"));
    const first = await streamed;
    expect(first.identity?.sessionId).toBe(sessionId);
    expect(first.cursor?.sequence).toBeGreaterThan(before.snapshot!.resumeCursor!.sequence);

    const resumed = nextEvent(paired.clients.event, { scope: sessionScope, afterCursor: first.cursor });
    await submit(
      paired.clients.operation,
      paired.connectionId,
      sendInputMutation(sessionId, BigInt(fixture!.application.store.getSession(sessionId).descriptor.binding.generation), "native follow-up", QueueDeliveryMode.FOLLOW_UP)
    );
    const second = await resumed;
    expect(second.cursor!.sequence).toBeGreaterThan(first.cursor!.sequence);
    expect(second.identity?.sessionId).toBe(sessionId);

    const staleGeneration = first.cursor!.generation + 1n;
    const stale = create(EventCursorSchema, {
      sequence: first.cursor!.sequence,
      generation: staleGeneration,
      opaqueToken: Buffer.from(`joko-v1:${first.cursor!.sequence}:${staleGeneration}`, "utf8").toString("base64url")
    });
    const staleIterator = paired.clients.event.streamEvents({ scope: sessionScope, afterCursor: stale })[Symbol.asyncIterator]();
    await expect(staleIterator.next()).rejects.toMatchObject({ code: Code.FailedPrecondition });

    const malformed = create(EventCursorSchema, {
      ...first.cursor!,
      sequence: first.cursor!.sequence + 1n
    });
    const malformedIterator = paired.clients.event.streamEvents({ scope: sessionScope, afterCursor: malformed })[Symbol.asyncIterator]();
    await expect(malformedIterator.next()).rejects.toBeInstanceOf(ConnectError);
  });

  it("keeps service-owned turn totals and the exact final model fact through child replay, history, and restart", async () => {
    const profile: FakeAdapterProfile = { ...PI_LIKE_PROFILE, capabilities: [...PI_LIKE_PROFILE.capabilities,
      { key: "subagents.list", supported: true }, { key: "subagents.detail", supported: true }] };
    const createAdapter = (value: FakeAdapterProfile) => new ControlledTurnUsageAdapter(value);
    fixture = await OrchestratorE2eFixture.start({ profiles: [profile], createAdapter });
    const paired = await fixture.pair("Turn facts client");
    const adapter = fixture.adapter() as ControlledTurnUsageAdapter;
    const sessionId = sessionIdFrom(await submit(paired.clients.operation, paired.connectionId,
      createSessionMutation({ backendId: adapter.id, targetId: fixture.targetId(), providerId: "test", modelId: "text" })));
    const scope = create(SnapshotScopeSchema, { kind: { case: "session", value: { sessionId, recentTimelineItems: 200 } } });
    const before = (await paired.clients.event.getSnapshot({ scope })).snapshot!;
    const operationId = randomUUID();
    const input = sendInputMutation(sessionId, BigInt(fixture.application.store.getSession(sessionId).descriptor.binding.generation), "Observe turn facts");
    const runId = queueRunIdFrom(await submit(paired.clients.operation, paired.connectionId, input, operationId));
    const context = await waitFor(async () => adapter.contexts.get(sessionId), value => value !== undefined, "the controlled turn to dispatch");
    if (!context) throw new Error("The controlled turn has no owned Adapter context.");
    const parentUsage: UsageSnapshot = { inputTokens: 12, outputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0,
      totalTokens: 20, cost: 0.001 };
    await adapter.observeUsage(parentUsage, context);
    await context.emit({ type: "message_complete", role: "assistant", blocks: [{ kind: "text", text: "Intermediate answer" }],
      nativeHistory: { identity: { entryId: "turn-intermediate" } } });
    const intermediate = (await paired.clients.run.getRun({ runId })).run!.usage!;
    expect(intermediate).toMatchObject({ usage: { totalTokens: 20n, costMicros: 1000n }, messageId: "turn-intermediate" });

    const startedAt = Date.now();
    const child: SubagentRunDetail = { id: "independent-turn-child", sessionId, parentRunId: runId, logicalAgentId: "reader",
      identityAliases: [], providerRunIds: ["native-child"], state: "running", startedAt, updatedAt: startedAt,
      route: { providerId: "vision", modelId: "multimodal" },
      capabilities: { viewActivity: true, viewReturnedResult: true, viewFullTranscript: false,
        stop: false, steer: false, followUp: false, resume: false, parentContext: "snapshot" }, activity: [] };
    for (const [index, usage] of [{ inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.002 },
      { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.002 },
      { inputTokens: 20, outputTokens: 10, totalTokens: 30, costUsd: 0.005 }].entries()) {
      await context.emit({ type: "subagent_run", run: { ...child, updatedAt: startedAt + index,
        usage: { ...usage, cacheReadTokens: 0, cacheWriteTokens: 0, tokensComplete: true },
        ...(index === 2 ? { state: "completed", endedAt: startedAt + index } : {}) } });
    }
    await context.emit({ type: "subagent_run", run: { ...child, id: "included-native-task", logicalAgentId: "native-reader",
      providerRunIds: ["native-included-child"], state: "completed", endedAt: startedAt + 3, updatedAt: startedAt + 3,
      usage: { accountingIncludedInParent: true, inputTokens: 50, outputTokens: 10, totalTokens: 60, costUsd: 0.004 } } });
    await adapter.observeUsage(parentUsage, context);
    const modelSubstitution = { selectedModelId: "text", actualModelId: "native-actual" };
    await context.emit({ type: "message_complete", role: "assistant", blocks: [{ kind: "text", text: "Final answer" }],
      nativeHistory: { identity: { entryId: "turn-final" } }, modelSubstitution,
      usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 5, cost: 0.0001 } });
    await context.emit({ type: "done", outcome: "completed" });
    const completed = await waitFor(() => paired.clients.run.getRun({ runId }), value => value.run?.state === RunState.SUCCEEDED,
      "the controlled turn to complete");
    const summary = completed.run!.usage!;
    expect(summary).toMatchObject({ usage: { inputTokens: 32n, outputTokens: 18n, totalTokens: 50n,
      costMicros: 6000n, currencyCode: "USD" }, estimated: false, costComplete: true, tokensComplete: true, messageId: "turn-final" });
    expect(summary.completionEventId).not.toBe(intermediate.completionEventId);
    expect(fixture.application.store.getRun(runId).descriptor.usage).toMatchObject({ totalTokens: 50, costMicros: 6000,
      completionEventId: summary.completionEventId, messageId: "turn-final" });
    expect(fixture.application.store.summarizeUsageLedger({ ownerId: "orchestrator" }))
      .toMatchObject({ totalTokens: 50, costMicros: 6000 });

    const streamAbort = new AbortController();
    try {
      let observedFinal = false;
      for await (const response of paired.clients.event.streamEvents({ scope, afterCursor: before.resumeCursor }, { signal: streamAbort.signal })) {
        const event = response.event;
        if (!event) continue;
        if (event.payload?.kind.case !== "runChanged" || event.payload.kind.value.run?.usage?.messageId !== "turn-final") continue;
        expect(event.payload.kind.value.run.usage).toEqual(summary);
        expect(fixture.application.store.findEvent(event.eventId)?.payload).toMatchObject({ type: "run_state",
          usage: { completionEventId: summary.completionEventId, totalTokens: 50 } });
        observedFinal = true;
        break;
      }
      expect(observedFinal).toBe(true);
    } finally { streamAbort.abort(); }
    const history = await paired.clients.session.listSessionTimeline({ sessionId, limit: 200 });
    const final = history.events.find(event => event.eventId === summary.completionEventId);
    expect(final?.payload?.kind).toMatchObject({ case: "messageCompleted", value: { messageId: "turn-final",
      usage: { totalTokens: 5n }, turnUsage: summary, modelSubstitution } });
    const oldCompletion = history.events.find(event => event.eventId === intermediate.completionEventId)?.payload?.kind;
    expect(oldCompletion?.case === "messageCompleted" ? oldCompletion.value.turnUsage : "missing").toBeUndefined();
    const snapshot = (await paired.clients.event.getSnapshot({ scope })).snapshot!;
    expect(snapshot.runs.find(run => run.runId === runId)?.usage).toEqual(summary);
    expect(snapshot.timeline.find(event => event.eventId === summary.completionEventId)?.payload?.kind)
      .toMatchObject({ value: { turnUsage: summary, modelSubstitution } });
    expect(snapshot.sessions.find(session => session.sessionId === sessionId)?.model?.model?.modelId).toBe("text");
    expect(queueRunIdFrom(await submit(paired.clients.operation, paired.connectionId, input, operationId))).toBe(runId);
    expect(adapter.sendCalls).toHaveLength(1);

    const rootDirectory = fixture.rootDirectory;
    await fixture.close({ removeRoot: false });
    fixture = await OrchestratorE2eFixture.start({ rootDirectory, profiles: [profile], createAdapter });
    const reconnected = fixture.clients(paired.authKey);
    expect((await reconnected.run.getRun({ runId })).run?.usage).toEqual(summary);
    const restored = (await reconnected.event.getSnapshot({ scope })).snapshot!;
    expect(restored.runs.find(run => run.runId === runId)?.usage).toEqual(summary);
    expect(restored.timeline.find(event => event.eventId === summary.completionEventId)?.payload?.kind)
      .toMatchObject({ value: { turnUsage: summary, modelSubstitution } });
    expect((await reconnected.session.listSessionTimeline({ sessionId, limit: 200 })).events
      .find(event => event.eventId === summary.completionEventId)?.payload?.kind).toMatchObject({ value: { turnUsage: summary, modelSubstitution } });
    expect(queueRunIdFrom(await submit(reconnected.operation, paired.connectionId, input, operationId))).toBe(runId);
    expect(fixture.application.store.listRuns({ sessionId })).toHaveLength(1);
    expect(fixture.application.store.listQueueItems({ sessionId })).toHaveLength(1);
    expect(fixture.adapter().sendCalls).toHaveLength(0);
  });

  it("replays an adopted native clone after restart and keeps both task bindings independently usable", async () => {
    fixture = await OrchestratorE2eFixture.start();
    const paired = await fixture.pair();
    const sourceId = sessionIdFrom(await submit(
      paired.clients.operation, paired.connectionId,
      createSessionMutation({ backendId: fixture.adapter().id, targetId: fixture.targetId(), displayName: "Source" })
    ));
    const sourceBinding = fixture.application.store.getSession(sourceId).descriptor.binding;
    const operationId = randomUUID();
    const clone = cloneMutation(sourceId);
    const derivedId = sessionIdFrom(await submit(paired.clients.operation, paired.connectionId, clone, operationId));
    const derivedBinding = fixture.application.store.getSession(derivedId).descriptor.binding;
    expect(derivedBinding.opaqueRef).not.toBe(sourceBinding.opaqueRef);
    const nativeOperation = fixture.application.store.listOperations({ sessionId: derivedId })
      .find((operation) => operation.kind === "clone_session");
    if (nativeOperation === undefined) throw new Error("The completed clone has no native operation.");
    expect(fixture.application.store.findNativeSessionDerivation(nativeOperation.id)).toMatchObject({
      state: "adopted", sessionId: derivedId, binding: derivedBinding
    });
    const rootDirectory = fixture.rootDirectory;
    await fixture.close({ removeRoot: false });
    fixture = await OrchestratorE2eFixture.start({ rootDirectory });
    const clients = fixture.clients(paired.authKey);
    const cloneNative = vi.spyOn(fixture.adapter(), "clone");
    const deleteNative = vi.spyOn(fixture.adapter(), "deleteSession");
    expect(sessionIdFrom(await submit(clients.operation, paired.connectionId, clone, operationId))).toBe(derivedId);
    expect(cloneNative).not.toHaveBeenCalled();
    expect(deleteNative).not.toHaveBeenCalled();
    expect(fixture.application.store.findNativeSessionDerivation(nativeOperation.id)?.state).toBe("adopted");
    for (const sessionId of [sourceId, derivedId]) {
      const runId = queueRunIdFrom(await submit(clients.operation, paired.connectionId, sendInputMutation(sessionId, BigInt(fixture!.application.store.getSession(sessionId).descriptor.binding.generation), `Continue ${sessionId}`)));
      await waitFor(() => clients.run.getRun({ runId }), (value) => value.run?.state === RunState.SUCCEEDED, "independent task to settle");
    }
    expect(fixture.application.store.getSession(sourceId).descriptor.binding.opaqueRef).toBe(sourceBinding.opaqueRef);
    expect(fixture.application.store.getSession(derivedId).descriptor.binding.opaqueRef).toBe(derivedBinding.opaqueRef);
    expect(fixture.application.store.getSession(derivedId).descriptor.derivationOrigin?.sourceSessionId).toBe(sourceId);
  });

  it("fences an abort to the observed Run revision and replays the receipt after the abort advances it", async () => {
    fixture = await OrchestratorE2eFixture.start({
      createAdapter: profile => new class extends InstrumentedFakeAdapter {
        override async send(): Promise<void> {}
        override async abort(context: AdapterContext): Promise<void> {
          context.assertRunControlCurrent?.();
          this.abortCalls++;
          await context.emit({ type: "done", outcome: "aborted" });
        }
      }(profile)
    });
    const paired = await fixture.pair(), adapter = fixture.adapter(), operation = paired.clients.operation;
    const sessionId = sessionIdFrom(await submit(operation, paired.connectionId,
      createSessionMutation({ backendId: adapter.id, targetId: fixture.targetId() })));
    const generation = BigInt(fixture.application.store.getSession(sessionId).descriptor.binding.generation);
    const runId = queueRunIdFrom(await submit(operation, paired.connectionId, sendInputMutation(sessionId, generation, "Stop this turn")));
    const { run } = await waitFor(() => paired.clients.run.getRun({ runId }),
      value => value.run?.state === RunState.RUNNING && !!value.run.activeAttemptId, "the exact Run and Attempt to start");
    const revision = run!.version!.revision!;
    const stop = (expectedRevision: bigint) => create(OperationMutationSchema, {
      preconditions: [{ entity: { kind: EntityKind.RUN, id: runId }, expectedRevision: { value: expectedRevision } }],
      payload: abortRunMutation(runId).payload
    });
    const staleId = randomUUID();
    await expect(submit(operation, paired.connectionId, stop(revision.value - 1n), staleId)).rejects.toMatchObject({ code: Code.Aborted });
    const rejected = await operation.getOperation({ operationId: staleId });
    expect(rejected.operation).toMatchObject({ operationId: staleId, state: OperationState.FAILED });
    expect(adapter.abortCalls).toBe(0);

    const acceptedId = randomUUID(), mutation = stop(revision.value);
    const accepted = await submit(operation, paired.connectionId, mutation, acceptedId);
    expect(accepted).toMatchObject({ operationId: acceptedId, state: OperationState.SUCCEEDED,
      result: { payload: { case: "acknowledgement", value: { accepted: true } } } });
    const ended = await paired.clients.run.getRun({ runId });
    expect(ended.run?.state).toBe(RunState.ABORTED);
    expect(ended.run?.version?.revision?.value).toBeGreaterThan(revision.value);
    await expect(submit(operation, paired.connectionId, mutation, acceptedId)).resolves.toMatchObject({
      operationId: acceptedId, state: OperationState.SUCCEEDED
    });
    expect(adapter.abortCalls).toBe(1);
  });

  it("executes prompt, steer, follow-up, abort/retry, tree, derive, compact, export, and interactions through operations", async () => {
    fixture = await OrchestratorE2eFixture.start({ profiles: [{ ...PI_LIKE_PROFILE, streamDelayMs: 300 }] });
    const paired = await fixture.pair();
    const adapter = fixture.adapter();
    const sessionId = sessionIdFrom(await submit(
      paired.clients.operation,
      paired.connectionId,
      createSessionMutation({ backendId: adapter.id, targetId: fixture.targetId(), displayName: "Lifecycle task" })
    ));

    await submit(paired.clients.operation, paired.connectionId, permissionMutation(sessionId, PermissionMode.AUTO));
    await submit(paired.clients.operation, paired.connectionId, planModeMutation(sessionId, true));
    await submit(paired.clients.operation, paired.connectionId, renameMutation(sessionId, "Renamed task"));
    await submit(paired.clients.operation, paired.connectionId, pinMutation(sessionId, true));

    const prompt = await submit(paired.clients.operation, paired.connectionId, sendInputMutation(sessionId, BigInt(fixture!.application.store.getSession(sessionId).descriptor.binding.generation), "primary"));
    await waitFor(
      async () => adapter.sendCalls.length,
      (value) => value === 1,
      "primary input to reach the Backend"
    );
    const currentControl = (await paired.clients.queue.getQueueControl({ sessionId })).queueControl;
    if (currentControl === undefined) throw new Error("Session has no queue control.");
    expect((await submit(
      paired.clients.operation,
      paired.connectionId,
      pauseQueueMutation(currentControl, "exercise queued input controls")
    )).state).toBe(OperationState.SUCCEEDED);

    const correction = queueItemFrom(await submit(
      paired.clients.operation,
      paired.connectionId,
      sendInputMutation(sessionId, BigInt(fixture!.application.store.getSession(sessionId).descriptor.binding.generation), "correction", QueueDeliveryMode.FOLLOW_UP)
    ));
    const afterwards = queueItemFrom(await submit(
      paired.clients.operation,
      paired.connectionId,
      sendInputMutation(sessionId, BigInt(fixture!.application.store.getSession(sessionId).descriptor.binding.generation), "afterwards", QueueDeliveryMode.FOLLOW_UP)
    ));

    const pausedControl = (await paired.clients.queue.getQueueControl({ sessionId })).queueControl;
    if (pausedControl === undefined) throw new Error("Paused Session has no queue control.");
    const interactionLockToken = randomUUID();
    expect((await submit(
      paired.clients.operation,
      paired.connectionId,
      setQueueInteractionLockMutation(pausedControl, interactionLockToken, true)
    )).state).toBe(OperationState.SUCCEEDED);
    expect((await paired.clients.queue.getQueueControl({ sessionId })).queueControl?.interactionLocked).toBe(true);
    expect((await submit(
      paired.clients.operation,
      paired.connectionId,
      reorderQueuedInputBeforeMutation(afterwards, correction.queueItemId, interactionLockToken)
    )).state).toBe(OperationState.SUCCEEDED);
    expect((await submit(
      paired.clients.operation,
      paired.connectionId,
      setQueueInteractionLockMutation(pausedControl, interactionLockToken, false)
    )).state).toBe(OperationState.SUCCEEDED);
    expect((await paired.clients.queue.getQueueControl({ sessionId })).queueControl?.interactionLocked).toBe(false);

    const reordered = await paired.clients.queue.listQueueItems({ sessionId });
    const currentCorrection = reordered.queueItems.find((item) => item.queueItemId === correction.queueItemId);
    if (currentCorrection === undefined) throw new Error("Reordered correction is missing from the queue.");
    const editLockToken = randomUUID();
    expect((await submit(
      paired.clients.operation,
      paired.connectionId,
      setQueueItemEditLockMutation(currentCorrection, editLockToken, true)
    )).state).toBe(OperationState.SUCCEEDED);
    expect((await paired.clients.queue.listQueueItems({ sessionId })).queueItems
      .find((item) => item.queueItemId === correction.queueItemId)?.editLocked).toBe(true);
    expect((await submit(
      paired.clients.operation,
      paired.connectionId,
      editQueuedInputMutation(currentCorrection, "corrected", QueueDeliveryMode.STEER, editLockToken)
    )).state).toBe(OperationState.SUCCEEDED);
    expect((await submit(
      paired.clients.operation,
      paired.connectionId,
      setQueueItemEditLockMutation(currentCorrection, editLockToken, false)
    )).state).toBe(OperationState.SUCCEEDED);
    expect((await paired.clients.queue.listQueueItems({ sessionId })).queueItems
      .find((item) => item.queueItemId === correction.queueItemId)?.editLocked).toBe(false);

    const resumableControl = (await paired.clients.queue.getQueueControl({ sessionId })).queueControl;
    if (resumableControl === undefined) throw new Error("Paused Session lost its queue control.");
    expect((await submit(
      paired.clients.operation,
      paired.connectionId,
      resumeQueueMutation(resumableControl)
    )).state).toBe(OperationState.SUCCEEDED);
    await waitFor(
      () => paired.clients.run.listRuns({ sessionId }),
      (value) => value.runs.length === 3 && value.runs.every((run) => run.state === RunState.SUCCEEDED),
      "prompt/steer/follow-up to settle"
    );
    expect(adapter.sendCalls.slice(0, 3).map((item) => item.disposition)).toEqual(["prompt", "steer", "follow_up"]);
    expect(adapter.sendCalls.slice(0, 3).map((item) => item.text)).toEqual(["primary", "corrected", "afterwards"]);

    const abortable = await submit(paired.clients.operation, paired.connectionId, sendInputMutation(sessionId, BigInt(fixture!.application.store.getSession(sessionId).descriptor.binding.generation), "abort me"));
    const abortedRunId = queueRunIdFrom(abortable);
    await waitFor(
      async () => adapter.sendCalls.length,
      (value) => value >= 4,
      "abortable input to reach the Backend"
    );
    const abortOperation = await submit(paired.clients.operation, paired.connectionId, abortRunMutation(abortedRunId));
    expect(abortOperation.state).toBe(OperationState.SUCCEEDED);
    await waitFor(
      () => paired.clients.run.getRun({ runId: abortedRunId }),
      (value) => value.run?.state === RunState.ABORTED,
      "Run to abort"
    );
    const retry = await submit(paired.clients.operation, paired.connectionId, retryRunMutation(abortedRunId));
    expect(retry.state).toBe(OperationState.FAILED);
    expect(retry.error?.message).toContain("Only a retryable failed Run can be retried");

    const tree = await paired.clients.session.getNativeSessionTree({ sessionId });
    expect(tree.tree?.activeEntryId).toBe("root");
    expect(nativeSessionTreeRoots(tree.tree!)[0]?.entryId).toBe("root");
    const navigationSource = await paired.clients.session.getSession({ sessionId });
    const navigationGeneration = navigationSource.session?.version?.generation;
    if (navigationGeneration === undefined) throw new Error("The navigation source has no generation.");
    const navigation = await submit(paired.clients.operation, paired.connectionId, navigateMutation(
      sessionId,
      create(NativeNavigationTargetSchema, { kind: { case: "nativeEntryId", value: "root" } }),
      navigationGeneration
    ));
    expect(navigation.state).toBe(OperationState.SUCCEEDED);
    const forkSourceMessage = fixture.application.store.findVisibleSessionMessageOrigin({ sessionId });
    expect(forkSourceMessage).toBeDefined();
    if (forkSourceMessage === undefined) throw new Error("No visible durable message was available for the fork boundary.");
    const forkedId = sessionIdFrom(await submit(
      paired.clients.operation,
      paired.connectionId,
      forkMutation(sessionId, "root", forkSourceMessage)
    ));
    const clonedId = sessionIdFrom(await submit(
      paired.clients.operation,
      paired.connectionId,
      cloneMutation(sessionId)
    ));
    expect(new Set((await paired.clients.session.listSessions({ targetId: fixture.targetId() })).sessions.map((item) => item.sessionId)))
      .toEqual(new Set([sessionId, forkedId, clonedId]));
    expect(fixture.application.store.getSession(forkedId).descriptor.derivationOrigin).toEqual({
      kind: "fork",
      sourceSessionId: sessionId,
      sourceMessageId: forkSourceMessage.messageId,
      sourceEventId: forkSourceMessage.eventId
    });

    const compactOperationId = randomUUID();
    const compactOperation = await submit(
      paired.clients.operation,
      paired.connectionId,
      compactMutation(sessionId),
      compactOperationId
    );
    expect(compactOperation.result?.payload.case).toBe("compactSession");
    if (compactOperation.result?.payload.case === "compactSession") {
      expect(compactOperation.result.payload.value.outcome).toBe(CompactSessionOutcome.COMPACTED);
    }
    const replayedCompactOperation = await submit(
      paired.clients.operation,
      paired.connectionId,
      compactMutation(sessionId),
      compactOperationId
    );
    expect(replayedCompactOperation.result?.payload.case).toBe("compactSession");
    if (replayedCompactOperation.result?.payload.case === "compactSession") {
      expect(replayedCompactOperation.result.payload.value.outcome).toBe(CompactSessionOutcome.COMPACTED);
    }
    adapter.compactOutcome = "noop";
    const noopCompactOperation = await submit(
      paired.clients.operation,
      paired.connectionId,
      compactMutation(sessionId),
      randomUUID()
    );
    expect(noopCompactOperation.result?.payload.case).toBe("compactSession");
    if (noopCompactOperation.result?.payload.case === "compactSession") {
      expect(noopCompactOperation.result.payload.value.outcome).toBe(CompactSessionOutcome.NOOP);
    }
    const exportOperationId = randomUUID();
    const exported = await submit(
      paired.clients.operation,
      paired.connectionId,
      exportMutation(sessionId),
      exportOperationId
    );
    expect(exported.result?.payload.case).toBe("artifact");
    if (exported.result?.payload.case !== "artifact") throw new Error("Orchestrator returned no typed export Artifact.");
    const exportedArtifact = exported.result.payload.value;
    expect(exportedArtifact.blob).toMatchObject({
      blobId: exportedArtifact.artifactId,
      mediaType: "text/html",
      fileName: `session-${sessionId}.html`
    });
    expect(fixture.application.store.getOperation(exportOperationId).response).toEqual({
      accepted: true,
      resultCase: "artifact",
      entityId: exportedArtifact.artifactId
    });

    const replayedExport = await submit(
      paired.clients.operation,
      paired.connectionId,
      exportMutation(sessionId),
      exportOperationId
    );
    expect(replayedExport.result?.payload).toEqual(exported.result.payload);
    expect(adapter.exportCalls).toBe(1);

    const downloadTicket = await paired.clients.artifact.getBlobDownloadTicket({
      blobId: exportedArtifact.blob!.blobId
    });
    const downloaded = await fetch(`${fixture.baseUrl}${downloadTicket.ticket!.relativeEndpoint}`, {
      headers: { authorization: `Bearer ${paired.authKey}` }
    });
    expect(downloaded.status).toBe(200);
    expect(await downloaded.text()).toContain(`<main>${sessionId}</main>`);
    await waitFor(async () => ({ compact: adapter.compactCalls, export: adapter.exportCalls }),
      (value) => value.compact === 2 && value.export === 1,
      "compact and export adapter effects");

    const interactionOperation = await submit(
      paired.clients.operation,
      paired.connectionId,
      sendInputMutation(sessionId, BigInt(fixture!.application.store.getSession(sessionId).descriptor.binding.generation), "[permission]")
    );
    const interactionRunId = queueRunIdFrom(interactionOperation);
    const pending = await waitFor(
      () => paired.clients.interaction.listInteractions({ sessionId, runId: interactionRunId }),
      (value) => value.interactions.some((item) => item.state === InteractionState.PENDING),
      "permission interaction"
    );
    const interaction = pending.interactions.find((item) => item.state === InteractionState.PENDING)!;
    await submit(paired.clients.operation, paired.connectionId, resolvePermissionMutation({
      connectionId: paired.connectionId,
      interactionId: interaction.interactionId,
      generation: interaction.generation
    }));
    await waitFor(
      () => paired.clients.interaction.getInteraction({ interactionId: interaction.interactionId }),
      (value) => value.interaction?.state === InteractionState.RESOLVED,
      "interaction resolution"
    );
    await waitFor(
      () => paired.clients.run.getRun({ runId: interactionRunId }),
      (value) => value.run?.state === RunState.SUCCEEDED,
      "interaction-gated Run to settle"
    );
    expect(adapter.interactionDecisions).toEqual(["allow_once"]);

    await submit(paired.clients.operation, paired.connectionId, archiveMutation(sessionId, true));
    const archived = (await paired.clients.session.getSession({ sessionId })).session;
    expect(archived?.archived).toBe(true);
    expect(archived?.lastActivityAt).toBeDefined();
    const archivedActivity = fixture.application.store.getSession(sessionId).descriptor.updatedAt;
    await waitFor(async () => Date.now(), (now) => now > archivedActivity, "a later activity timestamp");
    const restore = await submit(paired.clients.operation, paired.connectionId, archiveMutation(sessionId, false));
    expect(restore.state).toBe(OperationState.SUCCEEDED);
    const restored = (await paired.clients.session.getSession({ sessionId })).session;
    expect(restored?.archived).toBe(false);
    expect(restored?.lastActivityAt).toEqual(archived?.lastActivityAt);
  });

  it("rejects the next restore from a stale batch after another Owner deletes that task", async () => {
    fixture = await OrchestratorE2eFixture.start({ profiles: [PI_LIKE_PROFILE] });
    const first = await fixture.pair("Restoring Owner");
    const second = await fixture.pair("Deleting Owner");
    const createTask = async (displayName: string) => sessionIdFrom(await submit(first.clients.operation, first.connectionId,
      createSessionMutation({ backendId: fixture!.adapter().id, targetId: fixture!.targetId(), displayName })));
    const earlier = await createTask("First archived task");
    const removed = await createTask("Next archived task");
    for (const sessionId of [earlier, removed]) {
      expect((await submit(first.clients.operation, first.connectionId, archiveMutation(sessionId, true))).state)
        .toBe(OperationState.SUCCEEDED);
    }
    expect((await submit(first.clients.operation, first.connectionId, archiveMutation(earlier, false))).state)
      .toBe(OperationState.SUCCEEDED);
    const beforeDeletion = (await first.clients.event.getSnapshot({})).snapshot!.resumeCursor!;
    const deletionEvent = nextEvent(first.clients.event, { afterCursor: beforeDeletion });
    expect((await submit(second.clients.operation, second.connectionId, deleteMutation(removed))).state)
      .toBe(OperationState.SUCCEEDED);
    const original = fixture.application.store.getSessionSnapshot(removed);
    expect(await deletionEvent).toMatchObject({ identity: { sessionId: removed }, payload: { kind: {
      case: "projectionInvalidated", value: { reason: SnapshotInvalidationReason.PROJECTION_REBUILT,
        scope: "owner", minimumRevision: { value: original.session.revision } }
    } } });
    expect(original.session.descriptor.deletedAt).toBeDefined();
    const staleRestoreId = randomUUID();
    await expect(submit(first.clients.operation, first.connectionId, archiveMutation(removed, false), staleRestoreId))
      .rejects.toMatchObject({ code: Code.NotFound });
    const receipt = (await first.clients.operation.getOperation({ operationId: staleRestoreId })).operation;
    expect(receipt?.state).toBe(OperationState.FAILED);
    expect(receipt?.result).toBeUndefined();
    const retained = fixture.application.store.getSessionSnapshot(removed);
    expect(retained.session).toEqual(original.session);
    expect(retained.eventSequence).toBe(original.eventSequence);
    const owner = (await first.clients.event.getSnapshot({})).snapshot;
    expect(owner?.sessions.find(task => task.sessionId === earlier)?.archived).toBe(false);
    expect(owner?.sessions.some(task => task.sessionId === removed)).toBe(false);
  });

  it("disconnecting the event client never aborts an owned Run", async () => {
    fixture = await OrchestratorE2eFixture.start({ profiles: [{ ...PI_LIKE_PROFILE, streamDelayMs: 150 }] });
    const paired = await fixture.pair("closing UI");
    const sessionId = sessionIdFrom(await submit(
      paired.clients.operation,
      paired.connectionId,
      createSessionMutation({ backendId: fixture.adapter().id, targetId: fixture.targetId() })
    ));
    const scope = create(SnapshotScopeSchema, {
      kind: { case: "session", value: create(SessionSnapshotScopeSchema, { sessionId, recentTimelineItems: 10 }) }
    });
    const snapshot = await paired.clients.event.getSnapshot({ scope });
    const abort = new AbortController();
    const iterator = paired.clients.event.streamEvents({ scope, afterCursor: snapshot.snapshot!.resumeCursor }, { signal: abort.signal })[Symbol.asyncIterator]();
    const pendingEvent = iterator.next();
    const runOperation = await submit(paired.clients.operation, paired.connectionId, sendInputMutation(sessionId, BigInt(fixture!.application.store.getSession(sessionId).descriptor.binding.generation), "continue without UI"));
    await pendingEvent;
    abort.abort();
    await iterator.return?.();

    // A reconnect creates a new Connect transport; the Run remains owned by
    // Orchestrator rather than by either the closed event stream or its UI process.
    const reconnected = fixture.clients(paired.authKey);
    expect((await reconnected.run.getRun({ runId: queueRunIdFrom(runOperation) })).run?.state)
      .not.toBe(RunState.ABORTED);
    await waitFor(
      () => reconnected.run.getRun({ runId: queueRunIdFrom(runOperation) }),
      (value) => value.run?.state === RunState.SUCCEEDED,
      "Run after client disconnect and reconnect"
    );
    const reconnectedSnapshot = await reconnected.event.getSnapshot({ scope });
    expect(reconnectedSnapshot.snapshot?.runs).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: queueRunIdFrom(runOperation), state: RunState.SUCCEEDED })
    ]));
    expect(fixture.adapter().abortCalls).toBe(0);
  });

  mountedTimelineIt.each(["moved", "pinned", "busy"] as const)("settles a project archive when another Owner changes the next task (%s)", { timeout: 90_000 }, async change => {
    const releaseTurn = browserGate();
    fixture = await OrchestratorE2eFixture.start({ webDirectory: process.env.JOKO_MOUNTED_WEB_DIR!,
      createAdapter: profile => new class extends InstrumentedFakeAdapter {
        override async send(input: PromptInput, context: AdapterContext): Promise<void> {
          if (input.text === "Hold the middle task active") await releaseTurn.promise;
          await super.send(input, context);
        }
      }(profile) });
    const manager = await fixture.pair("Other project Owner");
    const backendId = fixture.adapter().id;
    const projectId = "original-project";
    const destinationId = "destination-project";
    for (const [id, displayName] of [[projectId, "Original project"], [destinationId, "Destination project"]] as const) {
      const root = join(fixture.rootDirectory, id);
      await mkdir(root);
      await fixture.application.workspaces.register({ id, displayName, root, trusted: true });
      await fixture.application.sessionHost.registerTarget({ id, backendId, displayName, workspaceRoot: root,
        managed: false, trusted: true }, { workspaceId: id });
    }
    const tasks: string[] = [];
    for (const displayName of ["Batch one", "Batch two", "Batch three"]) {
      tasks.push(sessionIdFrom(await submit(manager.clients.operation, manager.connectionId,
        createSessionMutation({ backendId, targetId: projectId, displayName }))));
    }
    const survivor = change === "busy" ? sessionIdFrom(await submit(manager.clients.operation, manager.connectionId,
      createSessionMutation({ backendId, targetId: fixture.targetId(), displayName: "Unaffected split" }))) : undefined;

    const challenge = await fixture.anonymous.connection.beginPairing({ deviceDisplayName: "Archiving Web" });
    if (!challenge.challenge) throw new Error("Archive pairing returned no challenge.");
    browser = await chromium.launch({ executablePath: process.env.JOKO_BROWSER_EXECUTABLE!, headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: "en-US" });
    await page.goto(fixture.baseUrl, { waitUntil: "domcontentloaded" });
    await page.locator(".connection-tabs > button").nth(2).click();
    await page.locator('details.device-authorization__manual > summary').click();
    await page.getByLabel("Joko node address").fill(fixture.baseUrl);
    await page.getByLabel("Pairing code").fill(fixture.pairingCode(challenge.challenge.challengeId));
    await page.getByLabel("Device name").fill("Archiving Web");
    await page.locator("form.pair-form button[type=submit]").click();

    const firstClosing = browserGate();
    const releaseClose = browserGate();
    const firstCommitted = browserGate();
    const releaseAcknowledgement = browserGate();
    releaseBrowserRequest = () => { releaseClose.release(); releaseAcknowledgement.release(); releaseTurn.release(); };
    const host = fixture.application.sessionHost;
    const close = host.closeIfActive.bind(host);
    vi.spyOn(host, "closeIfActive").mockImplementationOnce(async sessionId => {
      firstClosing.release();
      await releaseClose.promise;
      await close(sessionId);
    });
    const archiveRequests: SubmitOperationRequest[] = [];
    let firstState: OperationState | undefined;
    await page.route("**/joko.v1.OperationService/SubmitOperation", async route => {
      const bytes = route.request().postDataBuffer();
      const request = bytes && fromBinary(SubmitOperationRequestSchema, bytes);
      if (!request || request.mutation?.payload.case !== "archiveSession") { await route.continue(); return; }
      archiveRequests.push(request);
      if (archiveRequests.length > 1) { await route.continue(); return; }
      const response = await route.fetch();
      if (response.ok()) firstState = fromBinary(SubmitOperationResponseSchema, new Uint8Array(await response.body())).operation?.state;
      firstCommitted.release();
      await releaseAcknowledgement.promise;
      await route.fulfill({ response });
    });
    const group = (title: string) => page.locator(".sidebar .project-group").filter({ has: page.getByText(title, { exact: true }) });
    const project = group("Original project");
    const taskRows = project.locator("[data-session-id]");
    await taskRows.first().waitFor({ state: "visible" });
    const order = await taskRows.evaluateAll(rows => rows.map(row => row.getAttribute("data-session-id")!));
    expect(order).toHaveLength(3);
    expect(new Set(order)).toEqual(new Set(tasks));
    const [expectedFirst, changed, remaining] = order as [string, string, string];
    if (survivor !== undefined) {
      const firstRow = project.locator(`[data-session-id="${expectedFirst}"]`);
      await firstRow.click();
      const outsideRow = page.locator(`.sidebar [data-session-id="${survivor}"]`).first();
      await outsideRow.click({ button: "right" });
      await page.getByRole("menuitem", { name: "Split right", exact: true }).click();
      await firstRow.click();
      await page.waitForURL(url => url.hash.includes(expectedFirst));
      await page.locator(`.timeline[data-timeline-session-id="${survivor}"]`).waitFor({ state: "visible" });
    }
    await project.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("menuitem", { name: "Archive all tasks", exact: true }).click();
    await firstClosing.promise;
    const first = archiveRequests[0]?.mutation?.payload;
    if (first?.case !== "archiveSession") throw new Error("The first project archive was not submitted.");
    expect(first.value.sessionId).toBe(expectedFirst);
    expect(archiveRequests[0]?.mutation?.preconditions[0]).toMatchObject({ entity: { kind: EntityKind.SESSION, id: first.value.sessionId } });
    const move = (sessionId: string) => submit(manager.clients.operation, manager.connectionId, create(OperationMutationSchema, {
      payload: { case: "moveSessionProject", value: { sessionId, projectId: destinationId } }
    }));
    if (change === "moved") await expect(move(expectedFirst)).rejects.toMatchObject({ code: Code.FailedPrecondition });
    releaseClose.release();
    await firstCommitted.promise;
    expect(firstState).toBe(OperationState.SUCCEEDED);
    const store = fixture.application.store;
    if (change === "moved") {
      const staleRevision = (await manager.clients.session.getSession({ sessionId: changed })).session!.version!.revision!;
      expect((await move(changed)).state).toBe(OperationState.SUCCEEDED);
      const staleArchive = create(OperationMutationSchema, { payload: archiveMutation(changed, true).payload, preconditions: [
        { entity: { kind: EntityKind.SESSION, id: changed }, expectedRevision: staleRevision }
      ] });
      await expect(submit(manager.clients.operation, manager.connectionId, staleArchive)).rejects.toMatchObject({ code: Code.Aborted });
      await group("Destination project").locator(`[data-session-id="${changed}"]`).first().waitFor({ state: "visible" });
    } else if (change === "pinned") {
      expect((await submit(manager.clients.operation, manager.connectionId, pinMutation(changed, true))).state).toBe(OperationState.SUCCEEDED);
      await page.locator(`.session-section--pinned [data-session-id="${changed}"]`).first().waitFor({ state: "visible" });
    } else {
      const generation = BigInt(store.getSession(changed).descriptor.binding.generation);
      const runId = queueRunIdFrom(await submit(manager.clients.operation, manager.connectionId, sendInputMutation(changed, generation, "Hold the middle task active")));
      await waitFor(() => manager.clients.run.getRun({ runId }), receipt => receipt.run?.state === RunState.RUNNING, "the middle task to stay busy");
    }
    releaseAcknowledgement.release();
    await waitFor(async () => store.getSession(remaining).descriptor.archived, Boolean, "the other original project task to archive");
    await page.getByText(change === "busy" ? /A running or queued task|Revision precondition failed/u : "The task changed since the project action started.")
      .first().waitFor({ state: "visible" });
    const submitted = archiveRequests.map(request => request.mutation!.payload).flatMap(payload =>
      payload.case === "archiveSession" ? [payload.value.sessionId] : []);
    expect(submitted).toEqual(change === "busy" ? [expectedFirst, changed, remaining] : [expectedFirst, remaining]);
    expect(store.getSession(changed).descriptor).toMatchObject({ projectId: change === "moved" ? destinationId : projectId,
      targetId: projectId, archived: false, pinned: change === "pinned" });
    if (survivor !== undefined) {
      await page.waitForURL(url => url.hash.includes(survivor));
      await page.locator(`.timeline[data-timeline-session-id="${expectedFirst}"]`).waitFor({ state: "detached" });
      expect(await page.locator(`.timeline[data-timeline-session-id="${survivor}"]`).isVisible()).toBe(true);
    }
    releaseTurn.release();
  });

  mountedTimelineIt("restores sidebar preview and scroll after search and keeps the rail preview reachable", { timeout: 90_000 }, async () => {
    fixture = await OrchestratorE2eFixture.start({ webDirectory: process.env.JOKO_MOUNTED_WEB_DIR! });
    const manager = await fixture.pair("Sidebar fixture Owner");
    const { store, sessionHost, workspaces } = fixture.application;
    const backendId = fixture.adapter().id;
    const projectId = "scroll-project";
    const displayName = "Scroll project";
    const workspaceRoot = join(fixture.rootDirectory, projectId);
    await mkdir(workspaceRoot);
    await workspaces.register({ id: projectId, displayName, root: workspaceRoot, trusted: true });
    await sessionHost.registerTarget({ id: projectId, backendId, displayName, workspaceRoot, managed: false, trusted: true }, { workspaceId: projectId });
    const oldActivity = Date.now() - 3 * 24 * 60 * 60 * 1000;
    const taskCount = 18;
    const sampleIds: string[] = [];
    for (let index = 1; index <= taskCount; index++) {
      const sessionId = sessionIdFrom(await submit(manager.clients.operation, manager.connectionId,
        createSessionMutation({ backendId, targetId: projectId, displayName: `Scroll sample ${index}` })));
      store.updateSession(sessionId, {}, undefined, oldActivity - index);
      sampleIds.push(sessionId);
    }
    const pinnedId = sessionIdFrom(await submit(manager.clients.operation, manager.connectionId,
      createSessionMutation({ backendId, targetId: fixture.targetId(), displayName: "Pinned sidebar anchor" })));
    expect((await submit(manager.clients.operation, manager.connectionId, pinMutation(pinnedId, true))).state).toBe(OperationState.SUCCEEDED);

    const challenge = await fixture.anonymous.connection.beginPairing({ deviceDisplayName: "Search Sidebar Web" });
    if (!challenge.challenge) throw new Error("Sidebar pairing returned no challenge.");
    browser = await chromium.launch({ executablePath: process.env.JOKO_BROWSER_EXECUTABLE!, headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 540 }, locale: "en-US" });
    await page.goto(fixture.baseUrl, { waitUntil: "domcontentloaded" });
    await page.locator(".connection-tabs > button").nth(2).click();
    await page.locator('details.device-authorization__manual > summary').click();
    await page.getByLabel("Joko node address").fill(fixture.baseUrl);
    await page.getByLabel("Pairing code").fill(fixture.pairingCode(challenge.challenge.challengeId));
    await page.getByLabel("Device name").fill("Search Sidebar Web");
    await page.locator("form.pair-form button[type=submit]").click();

    const list = page.locator(".sidebar__sessions");
    const project = list.locator(".sidebar-main-view .project-group").filter({ has: page.getByText(displayName, { exact: true }) });
    const rows = project.locator("button[data-session-id]");
    const pinned = list.locator(".session-section--pinned");
    const pinnedHeading = pinned.locator(".session-section__heading-label");
    const preview = project.getByRole("button", { name: `Show all ${taskCount} tasks`, exact: true });
    await preview.waitFor({ state: "visible" });
    expect(await rows.count()).toBe(5);
    await pinned.getByRole("button", { name: "Collapse pinned tasks", exact: true }).click();
    await preview.click();
    expect(await rows.count()).toBe(taskCount);
    const offset = await list.evaluate(node => {
      node.scrollTop = Math.floor((node.scrollHeight - node.clientHeight) / 2);
      return node.scrollTop;
    });
    expect(offset).toBeGreaterThan(0);
    const search = page.locator("#conversation-search-input");
    const results = page.locator("#conversation-search-results");
    for (const query of ["qxzvvqzxvt", "Scroll sample"]) {
      await search.fill(query);
      if (query === "Scroll sample") {
        await results.getByText(`Scroll sample ${taskCount}`, { exact: true }).waitFor({ state: "visible" });
        expect(await list.evaluate(node => node.scrollTop)).toBe(0);
        expect(await list.evaluate(node => {
          node.scrollTop = node.scrollHeight;
          return node.scrollTop;
        })).toBeGreaterThan(0);
      } else {
        await results.getByText("No matching tasks", { exact: true }).waitFor({ state: "visible" });
      }
      await project.waitFor({ state: "hidden" });
      await search.press("Escape");
      await results.waitFor({ state: "detached" });
      await project.waitFor({ state: "visible" });
      await browserFrames(page);
      expect(await pinnedHeading.getAttribute("aria-expanded")).toBe("false");
      expect(await pinned.locator(`button[data-session-id="${pinnedId}"]`).count()).toBe(0);
      expect(await rows.count()).toBe(taskCount);
      expect(await list.evaluate(node => node.scrollTop)).toBe(offset);
    }

    const header = project.locator("[data-project-header]");
    await header.press("Enter");
    await expect.poll(() => header.getAttribute("aria-expanded")).toBe("false");
    await header.press("Enter");
    await preview.waitFor({ state: "visible" });
    expect(await rows.count()).toBe(5);
    await search.fill("Pinned sidebar anchor");
    await results.getByText("Pinned sidebar anchor", { exact: true }).waitFor({ state: "visible" });
    await search.press("Enter");
    await page.waitForFunction(sessionId => decodeURIComponent(location.hash).includes(sessionId), pinnedId);

    await page.locator(".sidebar__collapse").click();
    const railTrigger = page.locator("[data-sidebar-rail-trigger='projects']");
    const railProjects = page.locator(".sidebar-rail-panel[data-sidebar-rail-panel-level='1']");
    const railProject = railProjects.locator("[data-project-header]").filter({ hasText: displayName });
    const railTasks = page.locator(".sidebar-rail-panel[data-sidebar-rail-panel-level='2']");
    const lastSessionId = sampleIds.at(-1)!;
    const lastTask = railTasks.locator(`button[data-session-id="${lastSessionId}"]`);
    for (const height of [960, 480]) {
      await page.setViewportSize({ width: 1440, height });
      await railTrigger.press("Enter");
      await railProject.press("Enter");
      const railPreview = railTasks.getByRole("button", { name: `Show all ${taskCount} tasks`, exact: true });
      await railPreview.waitFor({ state: "visible" });
      const original = (await railTasks.boundingBox())!;
      await railPreview.click();
      await expect.poll(async () => {
        const rect = (await railTasks.boundingBox())!;
        return rect.y + rect.height;
      }).toBeLessThanOrEqual(height - 7);
      const expanded = (await railTasks.boundingBox())!;
      expect(expanded.height).toBeGreaterThan(original.height);
      if (height === 480) expect(original.y + expanded.height).toBeGreaterThan(height + 24);
      else expect(expanded.y).toBe(original.y);
      const scroll = railTasks.locator(".sidebar-rail-panel__scroll");
      expect(await scroll.evaluate(node => { node.scrollTop = node.scrollHeight; return node.scrollTop; })).toBeGreaterThan(0);
      expect(await lastTask.evaluate(node => {
        const row = node.getBoundingClientRect();
        const hit = document.elementFromPoint(row.left + row.width / 2, row.top + row.height / 2);
        return node.contains(hit);
      })).toBe(true);
      if (height === 960) {
        await page.keyboard.press("Escape");
        await railTasks.waitFor({ state: "detached" });
      } else {
        await lastTask.click();
        await page.waitForURL(url => url.hash.includes(lastSessionId));
      }
    }
  });

  mountedTimelineIt("searches a selected remote project through its original node while Web keeps its current connection", { timeout: 100_000 }, async () => {
    fixture = await OrchestratorE2eFixture.start({ serverId: "remote-project-search-a", webDirectory: process.env.JOKO_MOUNTED_WEB_DIR! });
    const current = fixture;
    const remote = await OrchestratorE2eFixture.start({ serverId: "remote-project-search-b", corsOrigins: [current.baseUrl] });
    try {
      const primaryProject = "shared-project-id";
      const otherProject = "other-project-id";
      const phrase = "scopewitness";
      const remoteText = `${phrase} original remote project`;
      const register = async (host: OrchestratorE2eFixture, id: string, displayName: string) => {
        const root = join(host.rootDirectory, id);
        await mkdir(root);
        await host.application.workspaces.register({ id, displayName, root, trusted: true });
        await host.application.sessionHost.registerTarget({ id, backendId: host.adapter().id, displayName,
          workspaceRoot: root, managed: false, trusted: true }, { workspaceId: id });
      };
      const setUpTask = async (host: OrchestratorE2eFixture, manager: Awaited<ReturnType<OrchestratorE2eFixture["pair"]>>,
        projectId: string, displayName: string, text: string) => {
        const sessionId = sessionIdFrom(await submit(manager.clients.operation, manager.connectionId,
          createSessionMutation({ backendId: host.adapter().id, targetId: projectId, displayName })));
        const generation = BigInt(host.application.store.getSession(sessionId).descriptor.binding.generation);
        const runId = queueRunIdFrom(await submit(manager.clients.operation, manager.connectionId, sendInputMutation(sessionId, generation, text)));
        await waitFor(() => manager.clients.run.getRun({ runId }), receipt => receipt.run?.state === RunState.SUCCEEDED, `search source ${displayName}`);
        return sessionId;
      };
      await Promise.all([register(current, primaryProject, "Shared project"), register(remote, primaryProject, "Shared project"),
        register(remote, otherProject, "Other project")]);
      const [currentManager, remoteManager] = await Promise.all([current.pair("Current search manager"), remote.pair("Remote search manager")]);
      const [currentTask, remoteTask] = await Promise.all([
        setUpTask(current, currentManager, primaryProject, "Current project control", `${phrase} current project control`),
        setUpTask(remote, remoteManager, primaryProject, "Remote project task", remoteText)
      ]);
      await setUpTask(remote, remoteManager, otherProject, "Same-node control", `${phrase} other remote project`);

      browser = await chromium.launch({ executablePath: process.env.JOKO_BROWSER_EXECUTABLE!, headless: true });
      const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: "en-US" });
      await page.goto(current.baseUrl, { waitUntil: "domcontentloaded" });
      const pairOnPage = async (host: OrchestratorE2eFixture, deviceDisplayName: string) => {
        const challenge = (await host.anonymous.connection.beginPairing({ deviceDisplayName })).challenge;
        if (!challenge) throw new Error("The project search pairing challenge is missing.");
        await page.getByRole("button", { name: "Add Joko node", exact: true }).click();
        await page.locator("details.device-authorization__manual > summary").click();
        await page.getByLabel("Joko node address").fill(host.baseUrl);
        await page.getByLabel("Pairing code").fill(host.pairingCode(challenge.challengeId));
        await page.getByLabel("Device name").fill(deviceDisplayName);
        await page.locator("form.pair-form button[type=submit]").click();
      };
      await pairOnPage(current, "Project Search Current Web");
      const currentRow = page.locator(`.sidebar [data-session-id="${currentTask}"]`).first();
      await currentRow.waitFor({ state: "visible" });
      await page.getByRole("button", { name: "Disconnect", exact: true }).click();
      await pairOnPage(remote, "Project Search Remote Web");
      await page.locator(`.sidebar [data-session-id="${remoteTask}"]`).first().waitFor({ state: "visible" });
      const machine = page.locator(".machine-switcher");
      const machineSummary = machine.locator("summary");
      const machineA = machine.locator(".machine-switcher__profile-main").filter({ hasText: current.baseUrl });
      await machineSummary.click();
      await machineA.click();
      await currentRow.waitFor({ state: "visible" });
      await machineSummary.click();
      await machine.getByRole("checkbox", { name: /All machines/u }).click();
      await machineSummary.click();

      const filter = page.locator(".conversation-search-filter > summary");
      await filter.click();
      await page.locator(".conversation-search-filter__projects").getByText(/^Shared project · /u).click();
      await filter.click();
      const searchRequests: { origin: string; sessionIds?: readonly string[] }[] = [];
      page.on("request", request => {
        const url = new URL(request.url());
        const bytes = request.postDataBuffer();
        if (!url.pathname.endsWith("/SearchSessionMessages") || bytes === null || request.method() !== "POST") return;
        const search = fromBinary(SearchSessionMessagesRequestSchema, bytes);
        if (search.query === phrase) searchRequests.push({ origin: url.origin, sessionIds: search.filters?.sessionIds?.values });
      });
      await page.locator("#conversation-search-input").fill(phrase);
      const results = page.getByRole("listbox", { name: "Conversation search results" });
      await results.getByText(remoteText, { exact: true }).waitFor({ state: "visible" });
      expect(await results.innerText()).not.toContain("other remote project");
      expect(await results.innerText()).not.toContain("current project control");
      expect(searchRequests.length).toBeGreaterThan(0);
      expect(searchRequests.every(request => request.origin === remote.baseUrl && request.sessionIds?.length === 1
        && request.sessionIds[0] === remoteTask)).toBe(true);
      await machineSummary.click();
      expect((await machineA.locator("em").textContent())?.trim()).toBe("Current");
      expect(await machine.getByRole("checkbox", { name: /All machines/u }).getAttribute("aria-checked")).toBe("true");
    } finally {
      await remote.close({ removeRoot: true });
    }
  });

  mountedTimelineIt("retires a task rename form when a same-ID task opens on a different node", { timeout: 90_000 }, async () => {
    fixture = await OrchestratorE2eFixture.start({ serverId: "task-rename-a", webDirectory: process.env.JOKO_MOUNTED_WEB_DIR! });
    const a = fixture;
    const b = await OrchestratorE2eFixture.start({ serverId: "task-rename-b", corsOrigins: [a.baseUrl] });
    try {
      const [ownerA, ownerB] = await Promise.all([a.pair("Original rename owner A"), b.pair("Original rename owner B")]);
      const operationId = randomUUID();
      const nameA = "Original task on node A", nameB = "Original task on node B";
      const createTask = async (host: OrchestratorE2eFixture, owner: typeof ownerA, displayName: string) =>
        sessionIdFrom(await submit(owner.clients.operation, owner.connectionId,
          createSessionMutation({ backendId: host.adapter().id, targetId: host.targetId(), displayName }), operationId));
      const [id, idB] = await Promise.all([createTask(a, ownerA, nameA), createTask(b, ownerB, nameB)]);
      expect(idB).toBe(id);
      const scope = create(SnapshotScopeSchema, { kind: { case: "session", value: { sessionId: id } } });
      const readTitle = async (owner: typeof ownerA) =>
        (await owner.clients.event.getSnapshot({ scope })).snapshot?.sessions.find(session => session.sessionId === id)?.displayName;
      expect(await Promise.all([readTitle(ownerA), readTitle(ownerB)])).toEqual([nameA, nameB]);

      browser = await chromium.launch({ executablePath: process.env.JOKO_BROWSER_EXECUTABLE!, headless: true });
      const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: "en-US" });
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: a.baseUrl });
      await page.goto(a.baseUrl, { waitUntil: "domcontentloaded" });
      const pane = page.locator(`.session-pane[data-input-session-id="${id}"]`);
      const title = (name: string) => pane.getByRole("button", { name, exact: true });
      const pairAndCopyTask = async (host: OrchestratorE2eFixture, name: string) => {
        const device = `Rename Browser ${name}`;
        const challenge = (await host.anonymous.connection.beginPairing({ deviceDisplayName: device })).challenge;
        if (!challenge) throw new Error("The rename fixture did not issue a pairing challenge.");
        await page.getByRole("button", { name: "Add Joko node", exact: true }).click();
        await page.locator("details.device-authorization__manual > summary").click();
        await page.getByLabel("Joko node address").fill(host.baseUrl);
        await page.getByLabel("Pairing code").fill(host.pairingCode(challenge.challengeId));
        await page.getByLabel("Device name").fill(device);
        await page.locator("form.pair-form button[type=submit]").click();
        await page.locator(`.sidebar [data-session-id="${id}"]`).filter({ hasText: name }).first().click();
        await title(name).waitFor({ state: "visible" });
        await pane.locator("summary").and(pane.getByLabel(`Actions for ${name}`, { exact: true })).click();
        await pane.getByRole("menuitem", { name: "Copy task link", exact: true }).click();
        const copied = await waitFor(() => page.evaluate(() => navigator.clipboard.readText()),
          text => URL.canParse(text) && new URLSearchParams(new URL(text).hash.split("?")[1]).has("profile"),
          `the node-qualified task link for ${name}`);
        await page.evaluate(() => navigator.clipboard.writeText(""));
        return new URL(copied).hash;
      };
      const aHash = await pairAndCopyTask(a, nameA);
      await page.getByRole("button", { name: "Disconnect", exact: true }).click();
      const bHash = await pairAndCopyTask(b, nameB);
      expect(aHash).not.toBe(bHash);

      const operations: Array<{ origin: string; taskId: string; title: string }> = [];
      page.on("request", request => {
        const url = new URL(request.url());
        const bytes = request.postDataBuffer();
        if (url.pathname !== "/joko.v1.OperationService/SubmitOperation" || request.method() !== "POST" || bytes === null) return;
        const mutation = fromBinary(SubmitOperationRequestSchema, bytes).mutation?.payload;
        if (mutation?.case === "renameSession") operations.push({
          origin: url.origin, taskId: mutation.value.sessionId, title: mutation.value.displayName
        });
      });
      const openHash = (hash: string) => page.evaluate(value => { location.hash = value; }, hash);
      await openHash(aHash);
      const dialog = page.getByRole("dialog", { name: "Rename task", exact: true });
      await title(nameA).click();
      await dialog.getByLabel("Task name", { exact: true }).fill("Unsaved title from A");
      await openHash(bHash);
      await title(nameB).waitFor({ state: "visible" });
      await dialog.waitFor({ state: "hidden" });
      expect(operations).toEqual([]);
      expect(await Promise.all([readTitle(ownerA), readTitle(ownerB)])).toEqual([nameA, nameB]);

      await title(nameB).click();
      const nameInput = dialog.getByLabel("Task name", { exact: true });
      await expect.poll(() => nameInput.inputValue()).toBe(nameB);
      await nameInput.fill("Confirmed rename on B");
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      await title("Confirmed rename on B").waitFor({ state: "visible" });
      expect(operations).toEqual([{ origin: b.baseUrl, taskId: id, title: "Confirmed rename on B" }]);
      expect(await Promise.all([readTitle(ownerA), readTitle(ownerB)])).toEqual([nameA, "Confirmed rename on B"]);
    } finally {
      await browser?.close();
      browser = undefined;
      await b.close({ removeRoot: true });
    }
  });

  mountedTimelineIt("keeps new completion unread while the Workspace Files task panel is collapsed", { timeout: 90_000 }, async () => {
    const profile = { ...PI_LIKE_PROFILE, capabilities: [...PI_LIKE_PROFILE.capabilities,
      { key: "workspace.files", supported: true as const }, { key: "session.attention", supported: true as const }] } satisfies FakeAdapterProfile;
    fixture = await OrchestratorE2eFixture.start({ profiles: [profile], webDirectory: process.env.JOKO_MOUNTED_WEB_DIR! });
    const host = fixture;
    const manager = await host.pair("Other task Owner");
    const projectId = "files-viewed-project";
    const projectName = "Files attention project";
    const root = join(host.rootDirectory, projectId);
    await mkdir(root);
    await host.application.workspaces.register({ id: projectId, displayName: projectName, root, trusted: true });
    await host.application.sessionHost.registerTarget({ id: projectId, backendId: profile.id, displayName: projectName,
      workspaceRoot: root, managed: false, trusted: true }, { workspaceId: projectId });
    const task = sessionIdFrom(await submit(manager.clients.operation, manager.connectionId,
      createSessionMutation({ backendId: profile.id, targetId: projectId, displayName: "File task reader" })));
    const generation = BigInt(host.application.store.getSession(task).descriptor.binding.generation);
    const send = async (text: string) => {
      const runId = queueRunIdFrom(await submit(manager.clients.operation, manager.connectionId, sendInputMutation(task, generation, text)));
      await waitFor(() => manager.clients.run.getRun({ runId }), receipt => receipt.run?.state === RunState.SUCCEEDED, "the attention source turn");
    };
    const original = "Read this original task turn before opening Files.";
    await send(original);
    const challenge = (await host.anonymous.connection.beginPairing({ deviceDisplayName: "Files reader Web" })).challenge;
    if (!challenge) throw new Error("The Files reader pairing challenge is missing.");
    browser = await chromium.launch({ executablePath: process.env.JOKO_BROWSER_EXECUTABLE!, headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: "en-US" });
    await page.goto(host.baseUrl, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Add Joko node", exact: true }).click();
    await page.locator("details.device-authorization__manual > summary").click();
    await page.getByLabel("Joko node address").fill(host.baseUrl);
    await page.getByLabel("Pairing code").fill(host.pairingCode(challenge.challengeId));
    await page.getByLabel("Device name").fill("Files reader Web");
    await page.locator("form.pair-form button[type=submit]").click();
    await page.locator(`.sidebar [data-session-id="${task}"]`).first().click();
    const timeline = `.timeline[data-timeline-session-id="${task}"]`;
    await page.locator(timeline).getByText(original, { exact: true }).first().waitFor({ state: "visible" });
    const readAttention = async () => (await manager.clients.session.getSession({ sessionId: task })).session?.attention;
    await waitFor(readAttention, attention => attention?.unread === false, "the original task acknowledgement");

    const project = page.locator(".sidebar .project-group").filter({ has: page.getByText(projectName, { exact: true }) });
    await project.getByRole("button", { name: "More", exact: true }).click();
    await page.getByRole("menuitem", { name: `Browse files in ${projectName}`, exact: true }).click();
    await page.getByRole("button", { name: "Collapse task panel", exact: true }).click();
    const rail = page.locator(".workspace-files-route__chat");
    expect(await rail.getAttribute("aria-hidden")).toBe("true");
    expect(await rail.getAttribute("inert")).not.toBeNull();
    await page.bringToFront();
    const viewed: bigint[] = [];
    page.on("request", request => {
      if (!new URL(request.url()).pathname.endsWith("/SubmitOperation")) return;
      const body = request.postDataBuffer();
      if (body === null) return;
      const payload = fromBinary(SubmitOperationRequestSchema, body).mutation?.payload;
      if (payload?.case === "acknowledgeSessionAttention" && payload.value.sessionId === task && payload.value.throughCursor !== undefined) {
        viewed.push(payload.value.throughCursor.sequence);
      }
    });
    const completion = "The second Owner completed a turn while the task panel was hidden.";
    await send(completion);
    const unread = await waitFor(readAttention, attention => attention?.unread === true && attention.attentionCursor !== undefined,
      "the new unread completion");
    const cursor = unread!.attentionCursor!.sequence;
    await rail.locator(timeline).getByText(completion, { exact: true }).first().waitFor({ state: "attached" });
    expect((await readAttention())?.unread).toBe(true);
    expect(viewed).toEqual([]);
    await page.getByRole("button", { name: "Expand task panel", exact: true }).click();
    await rail.locator(timeline).getByText(completion, { exact: true }).first().waitFor({ state: "visible" });
    const after = await waitFor(readAttention, attention => attention?.unread === false && attention.readThroughCursor?.sequence === cursor,
      "the visible task panel to acknowledge the original completion cursor");
    expect(after?.attentionCursor?.sequence).toBe(cursor);
    expect(viewed).toContain(cursor);
  });

  mountedTimelineIt("keeps Stop and composer Escape available during a native Claude retry wait", { timeout: 75_000 }, async () => {
    let activeTurn: AdapterContext | undefined;
    fixture = await OrchestratorE2eFixture.start({
      webDirectory: process.env.JOKO_MOUNTED_WEB_DIR!,
      profiles: [{ ...PI_LIKE_PROFILE, capabilities: PI_LIKE_PROFILE.capabilities.filter(item => item.key !== "context.auto_retry") }],
      createAdapter: profile => new class extends InstrumentedFakeAdapter {
        override async send(_input: PromptInput, context: AdapterContext): Promise<void> { activeTurn = context; }
        override async abort(context: AdapterContext): Promise<void> {
          this.abortCalls += 1;
          await context.emit({ type: "done", outcome: "aborted" });
        }
        override async abortRetry(): Promise<void> { throw new Error("The native retry can only be stopped through its active turn."); }
      }(profile)
    });
    const { store } = fixture.application;
    const manager = await fixture.pair("Native retry manager");
    const sessionId = sessionIdFrom(await submit(manager.clients.operation, manager.connectionId,
      createSessionMutation({ backendId: fixture.adapter().id, targetId: fixture.targetId(), displayName: "Native retry task" })));
    const generation = BigInt(store.getSession(sessionId).descriptor.binding.generation);
    const send = async (text: string) => queueItemFrom(await submit(manager.clients.operation, manager.connectionId,
      sendInputMutation(sessionId, generation, text)));
    const first = await send("Wait inside the native request");
    await waitFor(async () => store.getQueueItem(first.queueItemId).state, state => state === "backend_accepted", "the native input to be accepted");
    if (activeTurn === undefined) throw new Error("No active native turn was captured.");
    await activeTurn.emit({ type: "retry", state: "waiting", attempt: 1, maxAttempts: 2, delayMs: 60_000,
      error: { code: "CLAUDE_CODE_API_RETRY", message: "Claude Code is retrying the native request.", phase: "turn",
        retryable: true, stateMayHaveChanged: false, recovery: "Wait for the native retry result." } });
    const waiting = await send("Keep this later input queued");
    expect(store.getRun(first.runId).descriptor.state).toBe("retrying");
    expect(store.getQueueItem(waiting.queueItemId).state).toBe("accepted");

    const challenge = await fixture.anonymous.connection.beginPairing({ deviceDisplayName: "Native retry Web" });
    if (challenge.challenge === undefined) throw new Error("Native retry pairing returned no challenge.");
    browser = await chromium.launch({ executablePath: process.env.JOKO_BROWSER_EXECUTABLE!, headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: "en-US" });
    await page.goto(`${fixture.baseUrl}/#/tasks/${encodeURIComponent(sessionId)}`, { waitUntil: "domcontentloaded" });
    await page.locator(".connection-tabs > button").nth(2).click();
    await page.locator('details.device-authorization__manual > summary').click();
    await page.getByLabel("Joko node address").fill(fixture.baseUrl);
    await page.getByLabel("Pairing code").fill(fixture.pairingCode(challenge.challenge.challengeId));
    await page.getByLabel("Device name").fill("Native retry Web");
    await page.locator("form.pair-form button[type=submit]").click();
    await page.locator(`.timeline[data-timeline-session-id="${sessionId}"]`).waitFor({ state: "visible" });
    await page.locator(".session-header__abort").waitFor({ state: "visible" });
    await page.locator(".send-button--stop").waitFor({ state: "visible" });
    await page.locator(".composer-rich-editor__content[contenteditable=true]").press("Escape");
    await waitFor(async () => store.getRun(first.runId).descriptor.state, state => state === "aborted", "the original native Run to stop");
    expect(fixture.adapter().abortCalls).toBe(1);
    expect(store.getQueueControl(sessionId).paused).toBe(true);
    expect(store.getQueueItem(waiting.queueItemId).state).toBe("accepted");
  });

  mountedTimelineIt("preserves real scrollbar ownership and durable unread through pre-ACK input and reconnect", { timeout: 120_000 }, async () => {
    fixture = await OrchestratorE2eFixture.start({
      webDirectory: process.env.JOKO_MOUNTED_WEB_DIR!,
      profiles: [{ ...PI_LIKE_PROFILE, streamDelayMs: 0 }],
      createAdapter: (profile) => new MountedTimelineAdapter(profile)
    });
    const manager = await fixture.pair("Mounted Timeline manager");
    const sessionId = sessionIdFrom(await submit(manager.clients.operation, manager.connectionId,
      createSessionMutation({ backendId: fixture.adapter().id, targetId: fixture.targetId(), displayName: "Mounted Timeline" })));
    const adapter = fixture.adapter() as MountedTimelineAdapter;
    const send = async (text: string) => submit(manager.clients.operation, manager.connectionId,
      sendInputMutation(sessionId, BigInt(fixture!.application.store.getSession(sessionId).descriptor.binding.generation), text));
    for (let index = 0; index < 18; index += 1) {
      const operation = await send(`Timeline layout ${index}\n\n${"A paragraph measured by the real browser. ".repeat(12)}`);
      await waitFor(() => manager.clients.run.getRun({ runId: queueRunIdFrom(operation) }),
        (value) => value.run?.state === RunState.SUCCEEDED, "the layout seed to settle");
    }
    const generation = fixture.application.store.getSession(sessionId).descriptor.binding.generation;
    const challenge = await fixture.anonymous.connection.beginPairing({ deviceDisplayName: "Mounted Timeline Web" });
    if (challenge.challenge === undefined) throw new Error("Mounted Timeline pairing returned no challenge.");
    browser = await chromium.launch({
      executablePath: process.env.JOKO_BROWSER_EXECUTABLE!, headless: true, ignoreDefaultArgs: ["--hide-scrollbars"]
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: "en-US" });
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.name));
    await page.goto(`${fixture.baseUrl}/#/tasks/${encodeURIComponent(sessionId)}`, { waitUntil: "domcontentloaded" });
    await page.locator(".connection-tabs > button").nth(2).click();
    await page.locator('details.device-authorization__manual > summary').click();
    await page.getByLabel("Joko node address").fill(fixture.baseUrl);
    await page.getByLabel("Pairing code").fill(fixture.pairingCode(challenge.challenge.challengeId));
    await page.getByLabel("Device name").fill("Mounted Timeline Web");
    await page.locator("form.pair-form button[type=submit]").click();
    const timeline = page.locator(`.timeline[data-timeline-session-id="${sessionId}"]`);
    await timeline.waitFor({ state: "visible", timeout: 20_000 });
    const beforeHold = await settledViewportGeometry(page);
    expect(beforeHold.height).toBeGreaterThan(300);
    expect(beforeHold.scrollHeight).toBeGreaterThan(beforeHold.height * 3);
    expect(beforeHold.gutter).toBeGreaterThan(0);
    const thumbHeight = Math.max(17, beforeHold.height * beforeHold.height / beforeHold.scrollHeight);
    const scrollbarX = beforeHold.left + beforeHold.width + beforeHold.gutter / 2;
    const scrollbarY = beforeHold.top + beforeHold.height - thumbHeight / 2 - 1;
    const overlayGeometry = await page.locator(".session-bottom-overlay").evaluate((overlay) =>
      [...overlay.querySelectorAll(".composer-region,.composer-stack,.session-running-status")].map((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return { className: element.className, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
          pointerEvents: style.pointerEvents, paddingLeft: style.paddingLeft, paddingRight: style.paddingRight };
      }));
    const scrollbarHits = await timeline.evaluate((node, { gutterStart, gutter, y }) =>
      [0.2, 0.5, 0.8].map((fraction) => {
        const hit = node.ownerDocument.elementFromPoint(gutterStart + gutter * fraction, y);
        const rect = hit?.getBoundingClientRect();
        return { isTimeline: hit === node, tag: hit?.tagName, className: hit?.getAttribute("class"),
          parentClass: hit?.parentElement?.getAttribute("class"), left: rect?.left, right: rect?.right };
      }),
    { gutterStart: beforeHold.left + beforeHold.width, gutter: beforeHold.gutter, y: scrollbarY });
    const scrollbarDiagnostics = JSON.stringify({ beforeHold, scrollbarX, scrollbarY, scrollbarHits, overlayGeometry });
    expect(scrollbarHits.slice(0, 2).map((hit) => hit.isTimeline), scrollbarDiagnostics).toEqual([true, true]);
    // The Inspector's resize grip owns the pane's outer edge.
    if (scrollbarHits[2]?.isTimeline !== true) expect(scrollbarHits[2]?.className, scrollbarDiagnostics).toBe("inspector-dock-resize");
    for (const surface of overlayGeometry) {
      expect(surface.right, scrollbarDiagnostics).toBeLessThanOrEqual(beforeHold.left + beforeHold.width);
    }
    await page.mouse.move(scrollbarX, scrollbarY);
    await page.mouse.down();
    await browserFrames(page);
    const afterPress = await viewportGeometry(page);
    const heldOperation = await send(MOUNTED_TIMELINE_HOLD);
    const heldContext = await waitFor(async () => adapter.contexts.get(MOUNTED_TIMELINE_HOLD),
      (value) => value !== undefined, "the controlled streaming Run");
    if (heldContext === undefined) throw new Error("The Timeline Run has no active context.");
    const heldMessage: NativeHistoryEventContext = { identity: { entryId: "mounted-held-answer" } };
    const growingText = "Browser streaming layout grows while the scrollbar is held.\n\n".repeat(24);
    await heldContext.emit({ type: "text_delta", blockId: heldMessage.identity!.entryId, delta: growingText, nativeHistory: heldMessage });
    await waitFor(() => viewportGeometry(page), (value) => value.scrollHeight > beforeHold.scrollHeight + 100,
      "streaming content to create real layout growth");
    await browserFrames(page);
    const holdDiagnostics = {
      beforeHold, afterPress, afterGrowth: await viewportGeometry(page), scrollbarX, scrollbarY, overlayGeometry
    };
    expect(Math.abs(holdDiagnostics.afterGrowth.scrollTop - beforeHold.scrollTop), JSON.stringify(holdDiagnostics)).toBeLessThanOrEqual(2);
    expect(await page.locator(".jump-latest").count()).toBe(0);
    await page.mouse.move(scrollbarX, scrollbarY - 75, { steps: 8 });
    await page.mouse.up();
    await waitFor(() => viewportGeometry(page), (value) => value.scrollTop < beforeHold.scrollTop - 50,
      "the actual native thumb drag to commit its upward movement");
    await page.locator(".jump-latest").waitFor({ state: "visible" });
    await heldContext.emit({ type: "message_complete", role: "assistant", blocks: [{ kind: "text", text: growingText }], nativeHistory: heldMessage });
    await heldContext.emit({ type: "done", outcome: "completed" });
    await waitFor(() => manager.clients.run.getRun({ runId: queueRunIdFrom(heldOperation) }),
      (value) => value.run?.state === RunState.SUCCEEDED, "the held scrollbar Run to settle");
    await page.locator(".jump-latest").click();
    await waitFor(() => viewportGeometry(page), (value) => value.distanceFromEnd <= 2, "the explicit latest jump");
    await page.getByRole("button", { name: "Close Context tab", exact: true }).click();
    await page.getByRole("button", { name: "Open details", exact: true }).waitFor({ state: "visible", timeout: 30_000 });
    expect(await page.locator(".inspector-dock-group[data-edge]").count()).toBe(0);
    await settledViewportGeometry(page);

    const requestEntered = browserGate();
    const forwardRequest = browserGate();
    const releaseAcknowledgement = browserGate();
    releaseBrowserRequest = () => { forwardRequest.release(); releaseAcknowledgement.release(); };
    let heldBrowserRequest = false;
    const localInputObservation: { inputMatches?: boolean; forwarded: boolean; responseStatus?: number;
      operationState?: OperationState; failed?: string } = { forwarded: false };
    await page.route("**/joko.v1.OperationService/SubmitOperation", async (route) => {
      const bytes = route.request().postDataBuffer();
      if (bytes === null) throw new Error("Mounted Web sent no binary Operation request.");
      const body = fromBinary(SubmitOperationRequestSchema, bytes);
      if (heldBrowserRequest || body.mutation?.payload.case !== "sendInput") {
        await route.continue();
        return;
      }
      heldBrowserRequest = true;
      localInputObservation.inputMatches = body.mutation.payload.value.input?.parts
        .map(part => part.content.case === "text" ? part.content.value : "").join("") === MOUNTED_TIMELINE_LOCAL;
      requestEntered.release();
      await forwardRequest.promise;
      localInputObservation.forwarded = true;
      const response = await route.fetch().catch((error: unknown) => {
        localInputObservation.failed = error instanceof Error ? error.name : "unknown"; throw error;
      });
      localInputObservation.responseStatus = response.status();
      if (response.status() === 200) {
        localInputObservation.operationState = fromBinary(SubmitOperationResponseSchema,
          new Uint8Array(await response.body())).operation?.state;
      }
      await releaseAcknowledgement.promise;
      await route.fulfill({ response });
    });
    const composer = page.locator(".composer-rich-editor__content[contenteditable=true]");
    await composer.click();
    await composer.pressSequentially(MOUNTED_TIMELINE_LOCAL);
    expect(await composer.getAttribute("data-empty")).toBe("false");
    await waitFor(() => page.getByRole("button", { name: "Send", exact: true }).isEnabled(), value => value,
      "the mounted Composer to accept its keyboard input", 2_000).catch(async () => {
      const diagnostics = await page.locator(".composer").evaluate(node => ({
        busy: node.getAttribute("aria-busy"),
        editors: [...node.querySelectorAll<HTMLElement>(".composer-rich-editor__content")].map(editor => ({
          editable: editor.getAttribute("contenteditable"), empty: editor.dataset.empty, textLength: editor.textContent?.length,
          disabled: editor.parentElement?.dataset.disabled
        })),
        controls: [...node.querySelectorAll<HTMLButtonElement>("button")].map(button => ({
          label: button.getAttribute("aria-label"), title: button.title, disabled: button.disabled, text: button.textContent?.slice(0, 100)
        }))
      }));
      throw new Error(`The mounted Composer cannot send: ${JSON.stringify({ heldBrowserRequest, diagnostics })}`);
    });
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await requestEntered.promise;
    await timeline.hover({ position: { x: 150, y: 200 } });
    await page.mouse.wheel(0, -850);
    await page.locator(".jump-latest").waitFor({ state: "visible" });
    expect(await unreadCount(page)).toBe(0);
    const acceptedLocalInput = timeline.getByText(MOUNTED_TIMELINE_LOCAL, { exact: true });
    expect(await acceptedLocalInput.count()).toBe(0);
    forwardRequest.release();
    const localContext = await waitFor(async () => adapter.contexts.get(MOUNTED_TIMELINE_LOCAL),
      (value) => value !== undefined, "the durable local input before its unary acknowledgement").catch(async (error: unknown) => {
      throw new Error(`${error instanceof Error ? error.message : "Local input did not start"}. ${JSON.stringify({
        request: localInputObservation,
        adapter: { calls: adapter.sendCalls.length, localInputSeen: adapter.sendCalls.some(input => input.text === MOUNTED_TIMELINE_LOCAL),
          contextCount: adapter.contexts.size },
        queue: fixture!.application.store.listQueueItems({ sessionId }).map(item => item.state),
        runs: fixture!.application.store.listRuns({ sessionId }).map(run => run.descriptor.state),
        viewport: await viewportGeometry(page), pageErrors
      })}`);
    });
    if (localContext === undefined) throw new Error("The local input has no active Run.");
    await acceptedLocalInput.waitFor({ state: "attached" });
    expect(await unreadCount(page)).toBe(0);
    const localMessage: NativeHistoryEventContext = { identity: { entryId: "mounted-local-answer" } };
    const localText = "One durable assistant answer with two content blocks.";
    await localContext.emit({ type: "text_delta", blockId: localMessage.identity!.entryId, contentIndex: 0, delta: localText, nativeHistory: localMessage });
    await waitFor(() => unreadCount(page), (value) => value === 1, "one unread assistant message before ACK");
    await localContext.emit({ type: "text_delta", blockId: localMessage.identity!.entryId, contentIndex: 1, delta: "\n\nSecond block.", nativeHistory: localMessage });
    await localContext.emit({ type: "message_complete", role: "assistant", blocks: [
      { kind: "text", text: localText }, { kind: "text", text: "\n\nSecond block." }
    ], nativeHistory: localMessage });
    await localContext.emit({ type: "done", outcome: "completed" });
    await browserFrames(page);
    expect(await unreadCount(page)).toBe(1);
    releaseAcknowledgement.release();
    await page.waitForFunction(() => document.querySelector(".composer-rich-editor__content")?.getAttribute("contenteditable") === "true");
    await browserFrames(page);
    expect(await unreadCount(page)).toBe(1);

    const anchor = await visibleTimelineAnchor(page);
    await page.context().setOffline(true);
    // The SharedWorker may outlive Page-level offline emulation. Suspend all
    // requests from this paired browser, including reconnect snapshots.
    const browserConnections = fixture.application.store.listConnections().filter(connection => connection.name === "Mounted Timeline Web" && connection.state === "active");
    expect(browserConnections.length).toBe(1);
    releaseEventStreams = fixture.suspendPublicClientConnection(browserConnections[0]!.id);
    await page.locator(".offline-banner:visible,.error-banner:visible").first().waitFor({ state: "visible", timeout: 20_000 });
    const remoteOperation = await send(MOUNTED_TIMELINE_REMOTE);
    const remoteContext = await waitFor(async () => adapter.contexts.get(MOUNTED_TIMELINE_REMOTE),
      (value) => value !== undefined, "a remote input while the Browser is offline");
    if (remoteContext === undefined) throw new Error("The remote input has no active Run.");
    await remoteContext.emit({ type: "message_complete", role: "assistant", blocks: [{ kind: "text", text: "Remote durable answer." }] });
    await remoteContext.emit({ type: "done", outcome: "completed" });
    await waitFor(() => manager.clients.run.getRun({ runId: queueRunIdFrom(remoteOperation) }),
      (value) => value.run?.state === RunState.SUCCEEDED, "the offline remote Run to settle");
    expect(fixture.application.store.getSession(sessionId).descriptor.binding.generation).toBe(generation);
    releaseEventStreams();
    releaseEventStreams = undefined;
    await page.context().setOffline(false);
    await waitFor(() => page.locator(".offline-banner,.error-banner").count(), (value) => value === 0,
      "the automatic connection recovery to clear its public error state", 20_000);
    await waitFor(() => unreadCount(page), (value) => value === 3, "retained unread plus the remote user and assistant after reconnect", 20_000);
    await browserFrames(page);
    const recoveredAnchor = await visibleTimelineAnchor(page);
    const recoveredHistory = await manager.clients.session.listSessionTimeline({ sessionId, limit: 500 });
    const authoritativeAnchorKinds = recoveredHistory.events.flatMap((event) => {
      const payload = event.payload?.kind;
      return payload?.case === "textDelta" || payload?.case === "messageStarted" || payload?.case === "messageCompleted"
        ? payload.value.messageId === anchor.id ? [payload.case] : []
        : [];
    });
    expect(recoveredAnchor.id, JSON.stringify({ anchor, recoveredAnchor, authoritativeAnchorKinds, geometry: await viewportGeometry(page) })).toBe(anchor.id);
    expect(Math.abs(recoveredAnchor.offset - anchor.offset)).toBeLessThanOrEqual(3);
    await page.locator(".jump-latest").click();
    await waitFor(() => viewportGeometry(page), (value) => value.distanceFromEnd <= 2, "the recovered Timeline latest edge");
    expect(await page.locator(".jump-latest").count()).toBe(0);
    await page.getByText("Remote durable answer.", { exact: true }).waitFor({ state: "visible" });
    expect(pageErrors).toEqual([]);
  });
});

const MOUNTED_TIMELINE_HOLD = "Timeline controlled scrollbar stream";
const MOUNTED_TIMELINE_LOCAL = "Timeline controlled local input";
const MOUNTED_TIMELINE_REMOTE = "Timeline controlled remote input";

class MountedTimelineAdapter extends InstrumentedFakeAdapter {
  readonly contexts = new Map<string, AdapterContext>();

  override async send(input: PromptInput, context: AdapterContext): Promise<void> {
    await context.emit({ type: "message_complete", role: "user", blocks: [{ kind: "text", text: input.text }] });
    if ([MOUNTED_TIMELINE_HOLD, MOUNTED_TIMELINE_LOCAL, MOUNTED_TIMELINE_REMOTE].includes(input.text)) {
      this.sendCalls.push(input);
      this.contexts.set(input.text, context);
      return;
    }
    await super.send(input, context);
  }
}

class ControlledTurnUsageAdapter extends InstrumentedFakeAdapter {
  readonly contexts = new Map<string, AdapterContext>();
  readonly observedUsage = new Map<string, UsageSnapshot>();

  override async inspectSession(binding: NativeSessionBinding, context: AdapterContext) {
    const { usage: _initialUsage, ...state } = await super.inspectSession(binding, context);
    const usage = this.observedUsage.get(context.sessionId);
    return usage === undefined ? state : { ...state, usage };
  }

  override async send(input: PromptInput, context: AdapterContext): Promise<void> {
    this.sendCalls.push(input);
    this.contexts.set(context.sessionId, context);
  }

  async observeUsage(usage: UsageSnapshot, context: AdapterContext): Promise<void> {
    this.observedUsage.set(context.sessionId, usage);
    await context.emit({ type: "usage", usage });
  }
}

function browserGate(): { readonly promise: Promise<void>; readonly release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function browserFrames(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function settledViewportGeometry(page: Page) {
  let previous: Awaited<ReturnType<typeof viewportGeometry>> | undefined;
  const changes: Array<{ frame: number; geometry: Awaited<ReturnType<typeof viewportGeometry>> }> = [];
  let stableFrames = 0;
  for (let frame = 0; frame < 120; frame += 1) {
    await browserFrames(page);
    const geometry = await viewportGeometry(page);
    if (previous === undefined || geometry.scrollHeight !== previous.scrollHeight || geometry.scrollTop !== previous.scrollTop
        || geometry.height !== previous.height || geometry.width !== previous.width) {
      changes.push({ frame, geometry });
      if (changes.length > 12) changes.shift();
    }
    stableFrames = geometry.distanceFromEnd <= 2 && geometry.scrollHeight === previous?.scrollHeight
      && geometry.scrollTop === previous.scrollTop ? stableFrames + 1 : 0;
    if (stableFrames >= 8) return geometry;
    previous = geometry;
  }
  const jumpLatestVisible = await page.locator(".jump-latest").isVisible().catch(() => undefined);
  throw new Error(`The mounted Timeline layout did not settle: ${JSON.stringify({ changes, jumpLatestVisible })}`);
}

async function unreadCount(page: Page): Promise<number> {
  const counter = page.locator(".jump-latest__count");
  return await counter.count() === 0 ? 0 : Number(await counter.textContent());
}

async function viewportGeometry(page: Page) {
  return page.locator(".timeline").evaluate((element) => {
    const node = element as HTMLElement;
    const rect = node.getBoundingClientRect();
    return {
      left: rect.left, top: rect.top, width: node.clientWidth, height: node.clientHeight,
      gutter: node.offsetWidth - node.clientWidth, scrollTop: node.scrollTop, scrollHeight: node.scrollHeight,
      distanceFromEnd: node.scrollHeight - node.scrollTop - node.clientHeight
    };
  });
}

async function visibleTimelineAnchor(page: Page) {
  return page.locator(".timeline").evaluate((element) => {
    const top = element.getBoundingClientRect().top;
    const row = [...element.querySelectorAll<HTMLElement>("[data-timeline-item-id]")]
      .find((entry) => entry.getBoundingClientRect().bottom > top + 0.5);
    if (row === undefined) throw new Error("The Browser has no visible Timeline anchor.");
    return { id: row.dataset.timelineItemId, offset: row.getBoundingClientRect().top - top };
  });
}
