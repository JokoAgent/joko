import { randomUUID } from "node:crypto";

import { create } from "@bufbuild/protobuf";
import {
  CapabilitySupport, ConnectionState, DeviceKind, EntityKind, EntityRefSchema, EventCursorSchema, OperationMutationSchema,
  LogoutConnectionMutationSchema, OperationPreconditionSchema, OperationState, QueueItemState, RevokeDeviceMutationSchema,
  MessageRole, QueueDeliveryMode, RunState, SessionMessageSearchSemanticMode, SessionMessageSearchSessionStatus, SessionState,
  capabilityNames, type OperationMutation
} from "@joko/contracts";
import { PI_LIKE_PROFILE } from "@joko/testkit";
import type { AdapterContext, PromptInput } from "@joko/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InstrumentedFakeAdapter, OrchestratorE2eFixture, waitFor } from "./fixture.js";
import {
  archiveMutation, cancelQueuedInputMutation, createSessionMutation, deleteMutation, deleteSessionMessageMutation,
  editQueuedInputMutation, pauseQueueMutation, pinMutation, queueItemFrom, renameMutation,
  reorderQueuedInputBeforeMutation, resumeQueueMutation, sendInputMutation, sessionIdFrom,
  setQueueInteractionLockMutation, setQueueItemEditLockMutation, submit
} from "./operations.js";

class MobileMessageFixtureAdapter extends InstrumentedFakeAdapter {
  override async send(input: PromptInput, context: AdapterContext): Promise<void> {
    await context.emit({
      type: "message_complete",
      role: "user",
      blocks: [{ kind: "text", text: input.text }]
    });
    await super.send(input, context);
  }
}

describe("native mobile device through the durable product chain", () => {
  let fixture: OrchestratorE2eFixture | undefined;
  afterEach(async () => { await fixture?.close(); fixture = undefined; });

  it("pairs a mobile device, creates a task, queues text once, resyncs history and revokes access", async () => {
    fixture = await OrchestratorE2eFixture.start();
    const server = (await fixture.anonymous.connection.getServerInfo({})).server;
    expect(server?.serverId).toBeTruthy();
    const begun = await fixture.anonymous.connection.beginPairing({
      deviceDisplayName: "Joko phone", deviceKind: DeviceKind.MOBILE, platform: "android", appVersion: "0.1.0"
    });
    const challengeId = begun.challenge?.challengeId;
    expect(challengeId).toBeTruthy();
    const result = (await fixture.anonymous.connection.completePairing({
      challengeId, humanCode: fixture.pairingCode(challengeId!), deviceDisplayName: "Joko phone",
      deviceKind: DeviceKind.MOBILE, platform: "android", appVersion: "0.1.0"
    })).result;
    expect(result?.connection?.deviceId).toBe(result?.device?.deviceId);
    expect(result?.device?.kind).toBe(DeviceKind.MOBILE);
    expect(result?.authKey).toBeTruthy();
    const connectionId = result!.connection!.connectionId;
    const deviceId = result!.device!.deviceId;
    const clients = fixture.clients(result!.authKey);
    const owner = (await clients.event.getSnapshot({ scope: { kind: { case: "owner", value: {} } } })).snapshot;
    expect(owner?.server?.serverId).toBe(server?.serverId);
    expect(owner?.devices.find((device) => device.deviceId === deviceId)?.kind).toBe(DeviceKind.MOBILE);

    const target = owner?.targets.find((item) => item.targetId === fixture!.targetId());
    expect(target?.version?.revision).toBeDefined();
    const prepared = await clients.target.prepareTargetWorkspace({
      targetId: target!.targetId, expectedTargetRevision: target!.version!.revision
    });
    expect(prepared.workspace?.targetId).toBe(target?.targetId);
    const base = createSessionMutation({ backendId: target!.backendId, targetId: target!.targetId, displayName: "On the move" });
    const created = await submit(clients.operation, connectionId, create(OperationMutationSchema, {
      ...base,
      preconditions: [create(OperationPreconditionSchema, {
        entity: create(EntityRefSchema, { kind: EntityKind.TARGET, id: target!.targetId }),
        expectedRevision: target!.version!.revision
      })]
    }));
    const sessionId = sessionIdFrom(created);
    const session = (await clients.event.getSnapshot({
      scope: { kind: { case: "session", value: { sessionId, recentTimelineItems: 120 } } }
    })).snapshot;
    expect(session?.sessions[0]).toMatchObject({ sessionId, state: SessionState.IDLE });
    const generation = session!.sessions[0]!.nativeBinding!.runtimeGeneration;
    expect(generation).toBeGreaterThan(0n);

    const resume = (await clients.event.getSnapshot({ scope: { kind: { case: "owner", value: {} } } })).snapshot!.resumeCursor!;

    const sent = await submit(clients.operation, connectionId, sendInputMutation(sessionId, generation, "from the phone"));
    const queueId = sent.result?.payload.case === "queueItem" ? sent.result.payload.value.queueItemId : undefined;
    expect(queueId).toBeTruthy();
    await waitFor(async () => (await clients.session.listSessionTimeline({ sessionId, limit: 120 })).events,
      (events) => events.some((event) => event.payload?.kind.case === "messageCompleted"), "mobile task timeline");
    const recovered = (await clients.event.getSnapshot({
      scope: { kind: { case: "session", value: { sessionId, recentTimelineItems: 120 } } }
    })).snapshot;
    expect(recovered?.timeline.some((event) => event.payload?.kind.case === "messageCompleted")).toBe(true);
    expect(recovered?.queueItems.find((item) => item.queueItemId === queueId)?.state).not.toBe(QueueItemState.UNSPECIFIED);
    expect(fixture.adapter().sendCalls).toHaveLength(1);

    const completed = recovered!.timeline.find((event) => event.payload?.kind.case === "messageCompleted")!;
    const around = await clients.session.listSessionTimeline({ sessionId, aroundEventId: completed.eventId, limit: 9 });
    expect(around.events.some((event) => event.eventId === completed.eventId)).toBe(true);
    expect(around.events.every((event) => event.identity?.sessionId === sessionId)).toBe(true);
    const firstPage = await clients.session.listSessionTimeline({ sessionId, limit: 2 });
    expect(firstPage.events).toHaveLength(2);
    if (firstPage.nextBeforeCursor) {
      const older = await clients.session.listSessionTimeline({ sessionId, limit: 2, beforeCursor: firstPage.nextBeforeCursor });
      expect(older.events.every((event) => event.cursor!.sequence < firstPage.events[0]!.cursor!.sequence)).toBe(true);
    }
    const streamController = new AbortController();
    const replay = clients.event.streamEvents({ scope: { kind: { case: "owner", value: {} } }, afterCursor: resume },
      { signal: streamController.signal })[Symbol.asyncIterator]();
    try {
      const first = await replay.next();
      expect(first.done).toBe(false);
      expect(first.value?.event?.cursor?.sequence).toBeGreaterThan(resume.sequence);
      expect(first.value?.event?.cursor?.generation).toBe(resume.generation);
    } finally { streamController.abort(); }
    const badCursor = create(EventCursorSchema, { ...resume, generation: resume.generation + 1n });
    await expect(clients.event.streamEvents({ scope: { kind: { case: "owner", value: {} } }, afterCursor: badCursor })
      [Symbol.asyncIterator]().next()).rejects.toBeDefined();

    const search = async (status: SessionMessageSearchSessionStatus) => clients.session.searchSessionMessages({
      scope: { case: "owner", value: {} },
      query: "from the phone",
      filters: { sessionStatus: status },
      semanticMode: SessionMessageSearchSemanticMode.KEYWORD,
      page: { pageSize: 100, pageToken: "" }
    });
    expect((await search(SessionMessageSearchSessionStatus.ACTIVE)).matches.some((match) => match.sessionId === sessionId)).toBe(true);

    const mutateSession = async (mutation: OperationMutation) => {
      const before = (await clients.event.getSnapshot({ scope: { kind: { case: "owner", value: {} } } })).snapshot!;
      const current = before.sessions.find((item) => item.sessionId === sessionId);
      expect(current?.version?.revision?.value).toBeGreaterThan(0n);
      const operation = await submit(clients.operation, connectionId, create(OperationMutationSchema, {
        ...mutation,
        preconditions: [create(OperationPreconditionSchema, {
          entity: create(EntityRefSchema, { kind: EntityKind.SESSION, id: sessionId }),
          expectedRevision: current!.version!.revision
        })]
      }));
      expect(operation.state).toBe(OperationState.SUCCEEDED);
      return (await clients.event.getSnapshot({ scope: { kind: { case: "owner", value: {} } } })).snapshot!;
    };

    let changed = await mutateSession(renameMutation(sessionId, "Renamed on mobile"));
    expect(changed.sessions.find((item) => item.sessionId === sessionId)?.displayName).toBe("Renamed on mobile");
    changed = await mutateSession(pinMutation(sessionId, true));
    expect(changed.sessions.find((item) => item.sessionId === sessionId)?.pinned).toBe(true);
    changed = await mutateSession(archiveMutation(sessionId, true));
    expect(changed.sessions.find((item) => item.sessionId === sessionId)?.archived).toBe(true);
    expect((await search(SessionMessageSearchSessionStatus.ACTIVE)).matches.some((match) => match.sessionId === sessionId)).toBe(false);
    expect((await search(SessionMessageSearchSessionStatus.ARCHIVED)).matches.some((match) => match.sessionId === sessionId)).toBe(true);
    changed = await mutateSession(archiveMutation(sessionId, false));
    expect(changed.sessions.find((item) => item.sessionId === sessionId)?.archived).toBe(false);

    const deleteNative = vi.spyOn(fixture.adapter(), "deleteSession");
    changed = await mutateSession(deleteMutation(sessionId));
    expect(changed.sessions.some((item) => item.sessionId === sessionId)).toBe(false);
    expect(deleteNative).not.toHaveBeenCalled();

    const ownerClient = await fixture.pair("Device owner");
    const ownerBeforeRevoke = (await ownerClient.clients.event.getSnapshot({
      scope: { kind: { case: "owner", value: {} } }
    })).snapshot;
    const deviceRevision = ownerBeforeRevoke?.devices.find((device) => device.deviceId === deviceId)?.version?.revision;
    expect(deviceRevision?.value).toBeGreaterThan(0n);
    await submit(ownerClient.clients.operation, ownerClient.connectionId, create(OperationMutationSchema, {
      preconditions: [create(OperationPreconditionSchema, {
        entity: create(EntityRefSchema, { kind: EntityKind.DEVICE, id: deviceId }),
        expectedRevision: deviceRevision
      })],
      payload: { case: "revokeDevice", value: create(RevokeDeviceMutationSchema, { deviceId, reason: "Retired from mobile" }) }
    }));
    expect(fixture.application.store.getDevice(deviceId).state).toBe("revoked");
    await expect(clients.event.getSnapshot({ scope: { kind: { case: "owner", value: {} } } })).rejects.toBeDefined();
    expect((await ownerClient.clients.connection.getConnection({ connectionId })).connection?.state).toBe(ConnectionState.REVOKED);

    const logoutMobile = await fixture.anonymous.connection.beginPairing({
      deviceDisplayName: "Joko tablet", deviceKind: DeviceKind.MOBILE, platform: "ios", appVersion: "0.1.0"
    });
    const logoutChallengeId = logoutMobile.challenge!.challengeId;
    const logoutResult = (await fixture.anonymous.connection.completePairing({
      challengeId: logoutChallengeId,
      humanCode: fixture.pairingCode(logoutChallengeId),
      deviceDisplayName: "Joko tablet",
      deviceKind: DeviceKind.MOBILE,
      platform: "ios",
      appVersion: "0.1.0"
    })).result!;
    const logoutConnectionId = logoutResult.connection!.connectionId;
    const logoutClients = fixture.clients(logoutResult.authKey);
    const logoutOwner = (await logoutClients.event.getSnapshot({ scope: { kind: { case: "owner", value: {} } } })).snapshot!;
    const connectionRevision = logoutOwner.connections.find((item) => item.connectionId === logoutConnectionId)?.version?.revision;
    expect(connectionRevision?.value).toBeGreaterThan(0n);
    const loggedOut = await submit(logoutClients.operation, logoutConnectionId, create(OperationMutationSchema, {
      preconditions: [create(OperationPreconditionSchema, {
        entity: create(EntityRefSchema, { kind: EntityKind.CONNECTION, id: logoutConnectionId }),
        expectedRevision: connectionRevision
      })],
      payload: { case: "logoutConnection", value: create(LogoutConnectionMutationSchema, { connectionId: logoutConnectionId }) }
    }));
    expect(loggedOut.state).toBe(OperationState.SUCCEEDED);
    await expect(logoutClients.event.getSnapshot({ scope: { kind: { case: "owner", value: {} } } })).rejects.toBeDefined();
  });

  it("executes mobile message deletion and touch Queue controls through HTTP, SQLite, and the Session Host", async () => {
    fixture = await OrchestratorE2eFixture.start({
      profiles: [{ ...PI_LIKE_PROFILE, streamDelayMs: 300 }],
      createAdapter: (profile) => new MobileMessageFixtureAdapter(profile)
    });
    const paired = await fixture.pair("Joko mobile controls");
    const adapter = fixture.adapter();
    const owner = (await paired.clients.event.getSnapshot({ scope: { kind: { case: "owner", value: {} } } })).snapshot;
    const publicCapabilities = owner?.backends.find((backend) => backend.backendId === adapter.id)
      ?.capabilities?.capabilities;
    for (const name of [capabilityNames.queueCancel, capabilityNames.queueEdit, capabilityNames.queueReorder]) {
      expect(publicCapabilities).toContainEqual(expect.objectContaining({ name, support: CapabilitySupport.SUPPORTED }));
    }
    const sessionId = sessionIdFrom(await submit(
      paired.clients.operation,
      paired.connectionId,
      createSessionMutation({ backendId: adapter.id, targetId: fixture.targetId(), displayName: "Mobile controls" })
    ));
    const generation = () => BigInt(fixture!.application.store.getSession(sessionId).descriptor.binding.generation);

    const primary = queueItemFrom(await submit(paired.clients.operation, paired.connectionId,
      sendInputMutation(sessionId, generation(), "Primary mobile turn")));
    await waitFor(async () => adapter.sendCalls.length, (count) => count === 1, "primary mobile input to reach the Backend");
    const activeControl = (await paired.clients.queue.getQueueControl({ sessionId })).queueControl;
    if (!activeControl) throw new Error("The mobile task has no QueueControl.");
    expect((await submit(
      paired.clients.operation,
      paired.connectionId,
      pauseQueueMutation(activeControl, "Exercise touch Queue controls")
    )).state).toBe(OperationState.SUCCEEDED);

    const editable = queueItemFrom(await submit(
      paired.clients.operation,
      paired.connectionId,
      sendInputMutation(sessionId, generation(), "Edit this queued input", QueueDeliveryMode.FOLLOW_UP)
    ));
    const afterwards = queueItemFrom(await submit(
      paired.clients.operation,
      paired.connectionId,
      sendInputMutation(sessionId, generation(), "Keep this after the edit", QueueDeliveryMode.FOLLOW_UP)
    ));
    const removable = queueItemFrom(await submit(
      paired.clients.operation,
      paired.connectionId,
      sendInputMutation(sessionId, generation(), "Remove this queued input", QueueDeliveryMode.FOLLOW_UP)
    ));
    expect((await submit(
      paired.clients.operation,
      paired.connectionId,
      cancelQueuedInputMutation(removable)
    )).state).toBe(OperationState.SUCCEEDED);
    expect((await paired.clients.queue.listQueueItems({ sessionId })).queueItems
      .find((item) => item.queueItemId === removable.queueItemId)?.state).toBe(QueueItemState.CANCELLED);

    const pausedControl = (await paired.clients.queue.getQueueControl({ sessionId })).queueControl;
    if (!pausedControl) throw new Error("The paused mobile task lost its QueueControl.");
    const interactionLockToken = randomUUID();
    expect((await submit(
      paired.clients.operation,
      paired.connectionId,
      setQueueInteractionLockMutation(pausedControl, interactionLockToken, true)
    )).state).toBe(OperationState.SUCCEEDED);
    expect((await submit(
      paired.clients.operation,
      paired.connectionId,
      reorderQueuedInputBeforeMutation(afterwards, editable.queueItemId, interactionLockToken)
    )).state).toBe(OperationState.SUCCEEDED);
    expect((await submit(
      paired.clients.operation,
      paired.connectionId,
      setQueueInteractionLockMutation(pausedControl, interactionLockToken, false)
    )).state).toBe(OperationState.SUCCEEDED);

    const reordered = await paired.clients.queue.listQueueItems({ sessionId });
    const currentEditable = reordered.queueItems.find((item) => item.queueItemId === editable.queueItemId);
    if (!currentEditable) throw new Error("The editable Queue item disappeared.");
    expect(reordered.queueItems.filter((item) => item.state === QueueItemState.ACCEPTED)
      .map((item) => item.queueItemId)).toEqual([afterwards.queueItemId, editable.queueItemId]);
    const editLockToken = randomUUID();
    expect((await submit(
      paired.clients.operation,
      paired.connectionId,
      setQueueItemEditLockMutation(currentEditable, editLockToken, true)
    )).state).toBe(OperationState.SUCCEEDED);
    expect((await submit(
      paired.clients.operation,
      paired.connectionId,
      editQueuedInputMutation(currentEditable, "Edited from mobile", QueueDeliveryMode.FOLLOW_UP, editLockToken)
    )).state).toBe(OperationState.SUCCEEDED);
    expect((await submit(
      paired.clients.operation,
      paired.connectionId,
      setQueueItemEditLockMutation(currentEditable, editLockToken, false)
    )).state).toBe(OperationState.SUCCEEDED);

    const resumable = (await paired.clients.queue.getQueueControl({ sessionId })).queueControl;
    if (!resumable) throw new Error("The mobile task lost its resumable QueueControl.");
    expect((await submit(
      paired.clients.operation,
      paired.connectionId,
      resumeQueueMutation(resumable)
    )).state).toBe(OperationState.SUCCEEDED);
    await waitFor(
      () => paired.clients.run.listRuns({ sessionId }),
      (value) => value.runs.length === 4
        && value.runs.filter((run) => run.state === RunState.SUCCEEDED).length === 3
        && value.runs.filter((run) => run.state === RunState.ABORTED).length === 1,
      "mobile Queue to drain"
    );
    expect(adapter.sendCalls.slice(0, 3).map((call) => call.text)).toEqual([
      "Primary mobile turn",
      "Keep this after the edit",
      "Edited from mobile"
    ]);
    // Run rows become terminal just before the serialized Queue drain releases
    // its in-memory fence. Yield once so the next destructive operation observes
    // the same idle boundary that a mobile refresh does.
    await new Promise((resolve) => setTimeout(resolve, 25));

    const history = await waitFor(
      () => paired.clients.session.listSessionTimeline({ sessionId, limit: 120 }),
      (value) => value.events.some((event) => event.payload?.kind.case === "messageCompleted"
        && event.payload.kind.value.role === MessageRole.ASSISTANT
        && event.identity?.runId === primary.runId),
      "a durable mobile assistant message"
    );
    const selected = [...history.events].reverse().find((event) => event.payload?.kind.case === "messageCompleted"
      && event.payload.kind.value.role === MessageRole.ASSISTANT
      && event.identity?.runId === primary.runId);
    if (!selected) throw new Error("The mobile task has no completed assistant message.");
    const snapshot = (await paired.clients.event.getSnapshot({
      scope: { kind: { case: "session", value: { sessionId, recentTimelineItems: 120 } } }
    })).snapshot;
    const currentSession = snapshot?.sessions.find((session) => session.sessionId === sessionId);
    expect(currentSession?.state).toBe(SessionState.IDLE);
    const currentGeneration = currentSession?.nativeBinding?.runtimeGeneration;
    if (!currentGeneration) throw new Error("The mobile task has no current runtime generation.");
    expect(currentSession?.version?.generation).toBe(currentGeneration);
    const deleted = await submit(
      paired.clients.operation,
      paired.connectionId,
      deleteSessionMessageMutation(sessionId, selected.eventId, currentGeneration)
    );
    expect(deleted.state).toBe(OperationState.SUCCEEDED);

    const afterDelete = await paired.clients.session.listSessionTimeline({ sessionId, limit: 120 });
    expect(afterDelete.events.some((event) => event.eventId === selected.eventId)).toBe(false);
    expect(afterDelete.events.some((event) => event.payload?.kind.case === "messageDeleted"
      && event.payload.kind.value.requestedEventId === selected.eventId)).toBe(true);
  });
});
