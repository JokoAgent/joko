import { randomUUID } from "node:crypto";

import { create, fromBinary } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import {
  CompactSessionOutcome,
  EventCursorSchema,
  InteractionState,
  NativeNavigationTargetSchema,
  OperationMutationSchema,
  OperationState,
  OwnerSnapshotScopeSchema,
  PermissionMode,
  QueueDeliveryMode,
  RunState,
  SessionSnapshotScopeSchema,
  SnapshotScopeSchema,
  SubmitOperationRequestSchema,
  nativeSessionTreeRoots
} from "@joko/contracts";
import { PI_LIKE_PROFILE } from "@joko/testkit";
import type { AdapterContext, NativeHistoryEventContext, PromptInput } from "@joko/core";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InstrumentedFakeAdapter, OrchestratorE2eFixture, waitFor } from "./fixture.js";
import {
  abortRunMutation,
  archiveMutation,
  cloneMutation,
  compactMutation,
  createSessionMutation,
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

  afterEach(async () => {
    releaseBrowserRequest?.();
    releaseBrowserRequest = undefined;
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
    expect((await paired.clients.session.getSession({ sessionId })).session?.archived).toBe(true);
    await submit(paired.clients.operation, paired.connectionId, archiveMutation(sessionId, false));
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
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.name));
    let failedEventStreams = 0;
    page.on("requestfailed", (request) => {
      if (new URL(request.url()).pathname === "/joko.v1.EventService/StreamEvents") failedEventStreams += 1;
    });
    await page.goto(`${fixture.baseUrl}/#/tasks/${encodeURIComponent(sessionId)}`, { waitUntil: "domcontentloaded" });
    await page.locator(".connection-tabs > button").nth(2).click();
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
    if (scrollbarHits[2]?.isTimeline !== true) expect(scrollbarHits[2]?.className, scrollbarDiagnostics).toBe("inspector__resize");
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
    await page.getByRole("button", { name: "Close details", exact: true }).click();
    await settledViewportGeometry(page);

    const requestEntered = browserGate();
    const forwardRequest = browserGate();
    const releaseAcknowledgement = browserGate();
    releaseBrowserRequest = () => { forwardRequest.release(); releaseAcknowledgement.release(); };
    let heldBrowserRequest = false;
    await page.route("**/joko.v1.OperationService/SubmitOperation", async (route) => {
      const bytes = route.request().postDataBuffer();
      if (bytes === null) throw new Error("Mounted Web sent no binary Operation request.");
      const body = fromBinary(SubmitOperationRequestSchema, bytes);
      if (heldBrowserRequest || body.mutation?.payload.case !== "sendInput") {
        await route.continue();
        return;
      }
      heldBrowserRequest = true;
      requestEntered.release();
      await forwardRequest.promise;
      const response = await route.fetch();
      await releaseAcknowledgement.promise;
      await route.fulfill({ response });
    });
    const composer = page.locator(".composer-rich-editor__content[contenteditable=true]");
    await composer.fill(MOUNTED_TIMELINE_LOCAL);
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
      (value) => value !== undefined, "the durable local input before its unary acknowledgement");
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
    const failuresBeforeFault = failedEventStreams;
    await page.context().setOffline(true);
    fixture.dropPublicConnections();
    await waitFor(async () => failedEventStreams, (value) => value > failuresBeforeFault, "the actual Connect stream network failure");
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
  let stableFrames = 0;
  for (let frame = 0; frame < 120; frame += 1) {
    await browserFrames(page);
    const geometry = await viewportGeometry(page);
    stableFrames = geometry.distanceFromEnd <= 2 && geometry.scrollHeight === previous?.scrollHeight
      && geometry.scrollTop === previous.scrollTop ? stableFrames + 1 : 0;
    if (stableFrames >= 8) return geometry;
    previous = geometry;
  }
  throw new Error(`The mounted Timeline layout did not settle: ${JSON.stringify(previous)}`);
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
