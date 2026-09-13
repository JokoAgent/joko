import { randomUUID } from "node:crypto";

import { create } from "@bufbuild/protobuf";
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
  nativeSessionTreeRoots
} from "@joko/contracts";
import { PI_LIKE_PROFILE } from "@joko/testkit";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OrchestratorE2eFixture, waitFor } from "./fixture.js";
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

describe("session host, durable events, and reconnect semantics", () => {
  let fixture: OrchestratorE2eFixture | undefined;

  afterEach(async () => {
    await fixture?.close({ removeRoot: true });
    fixture = undefined;
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
});
