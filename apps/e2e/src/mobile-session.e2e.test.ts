import { create } from "@bufbuild/protobuf";
import {
  ConnectionState, DeviceKind, EntityKind, EntityRefSchema, EventCursorSchema, OperationMutationSchema,
  LogoutConnectionMutationSchema, OperationPreconditionSchema, OperationState, QueueItemState, RevokeDeviceMutationSchema, SessionState
} from "@joko/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { OrchestratorE2eFixture, waitFor } from "./fixture.js";
import { createSessionMutation, sendInputMutation, sessionIdFrom, submit } from "./operations.js";

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
});
