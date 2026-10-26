import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { createConnectionFetch } from "@joko/connection-transport";
import { DeviceKind, DevicePeerDirectoryKind, OperationMutationSchema, OperationState, SessionSnapshotScopeSchema, SnapshotScopeSchema } from "@joko/contracts";
import { replaceEndpointTrust, type NodePairingInvitation } from "@joko/connection-transport/trust";
import { NodeDevicePeerAgentExecutor, runNodeDevicePeerAgentRoute } from "@joko/device-peer";
import { expect, it, vi } from "vitest";
import { createE2eClients } from "./connect-clients.js";
import { OrchestratorE2eFixture, sha256 } from "./fixture.js";
import { createSessionMutation, nextEvent, sendInputMutation, sessionIdFrom, submit } from "./operations.js";

it.each(["https", "http-connect"] as const)("pairs through pinned %s, streams the canonical task, transfers a Blob and retires revoked authority", async transportKind => {
  const fixture = await OrchestratorE2eFixture.start({ httpConnect: transportKind === "http-connect" });
  try {
    const endpointPublicKey = fixture.application.linkspanIdentity!.publicKey;
    const anonymous = createE2eClients(fixture.baseUrl, undefined, 10_000, endpointPublicKey);
    expect((await anonymous.connection.getServerInfo({})).server?.endpointPublicKey).toBe(endpointPublicKey);
    const invitation = fixture.application.connections.issuePairing("Trusted encrypted device");
    const paired = (await anonymous.connection.completePairing({ challengeId: invitation.id, humanCode: invitation.code,
      deviceDisplayName: "Encrypted E2E", platform: "test" })).result!;
    const clients = createE2eClients(fixture.baseUrl, paired.authKey, 10_000, endpointPublicKey);
    const sessionId = sessionIdFrom(await submit(clients.operation, paired.connection!.connectionId,
      createSessionMutation({ backendId: fixture.adapter().id, targetId: fixture.targetId() })));
    const scope = create(SnapshotScopeSchema, { kind: { case: "session", value: create(SessionSnapshotScopeSchema, { sessionId }) } });
    const before = (await clients.event.getSnapshot({ scope })).snapshot!;
    const firstEvent = nextEvent(clients.event, { scope, afterCursor: before.resumeCursor });
    const operationId = randomUUID();
    const input = sendInputMutation(sessionId, BigInt(fixture.application.store.getSession(sessionId).descriptor.binding.generation), "encrypted task");
    const accepted = await submit(clients.operation, paired.connection!.connectionId, input, operationId);
    const event = await firstEvent;
    expect(event.cursor!.sequence).toBeGreaterThan(before.resumeCursor!.sequence);
    const reconnected = createE2eClients(fixture.baseUrl, paired.authKey, 10_000, endpointPublicKey);
    expect((await submit(reconnected.operation, paired.connection!.connectionId, input, operationId)).operationId).toBe(accepted.operationId);
    expect(fixture.application.store.listQueueItems({ sessionId })).toHaveLength(1);
    expect((await nextEvent(reconnected.event, { scope, afterCursor: event.cursor })).cursor!.sequence).toBeGreaterThan(event.cursor!.sequence);

    const bytes = new Uint8Array(2 * 1024 * 1024).fill(137);
    const upload = (await clients.artifact.beginBlobUpload({ fileName: "encrypted.bin", mediaType: "application/octet-stream",
      byteSize: BigInt(bytes.byteLength), sha256Hex: sha256(bytes) })).upload!;
    const fetcher = createConnectionFetch({ origin: fixture.baseUrl, endpointPublicKey });
    const uploaded = await fetcher(`${fixture.baseUrl}${upload.ticket!.relativeEndpoint}`, { method: "PUT", body: bytes,
      headers: { authorization: `Bearer ${paired.authKey}`, "content-type": "application/octet-stream" } });
    expect(uploaded.status).toBe(201); await uploaded.arrayBuffer();
    const blob = (await clients.artifact.completeBlobUpload({ uploadId: upload.uploadId })).blob!;
    const download = await clients.artifact.getBlobDownloadTicket({ blobId: blob.blobId });
    const downloaded = await fetcher(`${fixture.baseUrl}${download.ticket!.relativeEndpoint}`, { headers: { authorization: `Bearer ${paired.authKey}` } });
    expect(sha256(new Uint8Array(await downloaded.arrayBuffer()))).toBe(sha256(bytes));
    fixture.application.connections.revoke(paired.connection!.connectionId);
    await expect(reconnected.session.getSession({ sessionId })).rejects.toBeDefined();
    expect(fixture.application.store.getSession(sessionId).descriptor.id).toBe(sessionId);
    if (transportKind === "http-connect") expect(fixture.httpConnectRequests).toBeGreaterThanOrEqual(12);
  } finally { await fixture.close(); }
}, 30_000);

it.each(["webrtc", "http-connect"] as const)("carries a real Service DevicePeer route and authorized directory operation over selected %s, then retires revocation", async transportKind => {
  const fixture = await OrchestratorE2eFixture.start({ webRtc: transportKind === "webrtc", httpConnect: transportKind === "http-connect" });
  const abort = new AbortController(); let route: Promise<unknown> | undefined; let ended = false;
  try {
    const endpointPublicKey = fixture.application.linkspanIdentity!.publicKey;
    const endpointTransport = transportKind === "webrtc" ? { kind: "webrtc" as const } : fixture.httpConnectTransport!;
    replaceEndpointTrust({ origin: fixture.baseUrl, endpointPublicKey, serverId: fixture.application.serverId,
      transportKind, endpointTransport });
    const pair = (kind: "web" | "service") => {
      const code = fixture.application.connections.issuePairing("Trusted local fixture owner");
      return fixture.application.connections.completePairing({ challengeId: code.id, code: code.code, connectionName: kind,
        device: { defaultName: kind, kind, platform: process.platform, appVersion: "0.1.0" } });
    };
    const controller = pair("web"), target = pair("service");
    const clients = createE2eClients(fixture.baseUrl, controller.authKey, 20_000, endpointPublicKey);
    const targetClients = createE2eClients(fixture.baseUrl, target.authKey, 20_000, endpointPublicKey);
    const privateDirectory = join(fixture.rootDirectory, "service-peer-client"); await mkdir(privateDirectory);
    const executor = new NodeDevicePeerAgentExecutor({ recentDirectoriesPath: join(privateDirectory, "recent-directories.json") });
    route = runNodeDevicePeerAgentRoute({ connection: { credentialId: target.connection.id, deviceId: target.connection.deviceId,
      serverId: fixture.application.serverId, origin: fixture.baseUrl, endpointPublicKey, transportKind, endpointTransport, expectedDeviceKind: DeviceKind.SERVICE },
      executor, signal: abort.signal, readDefaultDeviceName: () => "Service peer", readAuthKey: async id => id === target.connection.id ? target.authKey : undefined,
      isAuthorityCurrent: candidate => !abort.signal.aborted && candidate.credentialId === target.connection.id && candidate.deviceId === target.connection.deviceId
        && candidate.serverId === fixture.application.serverId && candidate.origin === fixture.baseUrl && candidate.expectedDeviceKind === DeviceKind.SERVICE
        && candidate.transportKind === transportKind && JSON.stringify(candidate.endpointTransport) === JSON.stringify(endpointTransport) && candidate.endpointPublicKey === endpointPublicKey
    }).catch(error => error).finally(() => { ended = true; });
    expect((await clients.devicePeer.listDevicePeers({})).peers).toEqual([]);
    expect((await submit(clients.operation, controller.connection.id, create(OperationMutationSchema,
      { payload: { case: "setDeviceControlTargetEnabled", value: { targetDeviceId: target.connection.deviceId, enabled: true } } }))).state).toBe(OperationState.SUCCEEDED);
    expect((await submit(targetClients.operation, target.connection.id, create(OperationMutationSchema,
      { payload: { case: "setDeviceRemoteControlEnabled", value: { enabled: true } } }))).state).toBe(OperationState.SUCCEEDED);
    expect((await submit(targetClients.operation, target.connection.id, create(OperationMutationSchema,
      { payload: { case: "setDeviceControllerAllowed", value: { controllerDeviceId: controller.connection.deviceId, allowed: true } } }))).state).toBe(OperationState.SUCCEEDED);
    let peer: Awaited<ReturnType<typeof clients.devicePeer.listDevicePeers>>["peers"][number] | undefined;
    for (let attempt = 0; attempt < 5 && peer === undefined; attempt++) peer = (await clients.devicePeer.listDevicePeers({})).peers.find(value => value.route?.targetDeviceId === target.connection.deviceId);
    expect(peer?.route).toBeDefined();
    expect((await clients.devicePeer.inspectDevicePeerDirectory({ peer: peer!.route, path: fixture.workspaceDirectory })).kind).toBe(DevicePeerDirectoryKind.DIRECTORY);
    if (transportKind === "webrtc") expect(fixture.webRtcSignalingRequests).toBeGreaterThanOrEqual(8);
    else expect(fixture.httpConnectRequests).toBeGreaterThanOrEqual(8);
    fixture.application.connections.revoke(target.connection.id);
    await vi.waitFor(() => expect(ended).toBe(true), { timeout: 20_000 });
    await expect(clients.devicePeer.inspectDevicePeerDirectory({ peer: peer!.route, path: fixture.workspaceDirectory })).rejects.toBeDefined();
    expect(fixture.application.store.getConnection(target.connection.id).state).toBe("revoked");
  } finally { abort.abort(); await route; await fixture.close(); }
}, 180_000);

it("lets a locally paired Mobile client issue and cancel a trusted invitation, then restores the recipient's pinned connection", async () => {
  interface Client {
    readonly state: { readonly status: string; readonly activeProfileId?: string };
    start(): Promise<void>;
    requestPairing(origin: string, deviceName: string): Promise<string>;
    pair(origin: string, code: string, deviceName: string, automatic?: boolean): Promise<void>;
    trustEndpoint(origin: string, key: string, replace?: boolean, serverId?: string): Promise<void>;
    authorizeNewDevice(): Promise<NodePairingInvitation>;
    cancelDevicePairing(invitation: NodePairingInvitation): Promise<void>;
    refresh(): Promise<void>;
    dispose(): void;
  }
  interface Driver { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void>; removeItem(key: string): Promise<void> }
  interface Profile { readonly profileId: string; readonly endpointPublicKey?: string; readonly connectionId: string }
  interface Storage { loadConnectionIndex(): Promise<{ readonly profiles: readonly Profile[] }> }
  const { mobileNetwork } = await vi.importActual<{ mobileNetwork: unknown }>("../../mobile/src/network.js");
  const { MobileClient } = await vi.importActual<{ MobileClient: new (network: unknown, storage: unknown, discovery: unknown, id: () => string, platform: string) => Client }>("../../mobile/src/mobile-client.js");
  const { createMobileStorage } = await vi.importActual<{ createMobileStorage(plain: Driver, secure: Driver & { isAvailable(): Promise<boolean> }): Storage }>("../../mobile/src/connection-storage.js");
  const driver = (): Driver => {
    const values = new Map<string, string>();
    return { getItem: async key => values.get(key) ?? null, setItem: async (key, value) => { values.set(key, value); }, removeItem: async key => { values.delete(key); } };
  };
  const storage = () => createMobileStorage(driver(), { ...driver(), isAvailable: async () => true });
  const fixture = await OrchestratorE2eFixture.start();
  // The fixture bootstraps the literal origin's pin. This local alias has no
  // saved pin and exercises the same trusted-local issuer used in development.
  const localOrigin = fixture.baseUrl.replace("127.0.0.1", "localhost");
  const issuerStorage = storage(), recipientStorage = storage();
  const issuer = new MobileClient(mobileNetwork, issuerStorage, { scan: async () => [] }, randomUUID, "android");
  const recipient = new MobileClient(mobileNetwork, recipientStorage, { scan: async () => [] }, randomUUID, "ios");
  let restored: Client | undefined;
  try {
    await issuer.start();
    const initial = await issuer.requestPairing(localOrigin, "Local issuing device");
    await issuer.pair(localOrigin, fixture.pairingCode(initial), "Local issuing device");
    expect(issuer.state.status).toBe("connected");
    expect((await issuerStorage.loadConnectionIndex()).profiles[0]!.endpointPublicKey).toBeUndefined();
    const canceled = await issuer.authorizeNewDevice();
    expect(canceled.endpointPublicKey).toBe(fixture.application.linkspanIdentity!.publicKey);
    await issuer.cancelDevicePairing(canceled);

    await recipient.start();
    await recipient.trustEndpoint(fixture.baseUrl, canceled.endpointPublicKey, false, canceled.serverId);
    await recipient.requestPairing(fixture.baseUrl, "Invited device");
    await expect(recipient.pair(fixture.baseUrl, canceled.humanCode, "Invited device")).rejects.toBeDefined();
    const invitation = await issuer.authorizeNewDevice();
    await recipient.pair(fixture.baseUrl, invitation.humanCode, "Invited device", true);
    const profile = (await recipientStorage.loadConnectionIndex()).profiles[0]!;
    expect(profile.endpointPublicKey).toBe(invitation.endpointPublicKey);
    expect(issuer.state.status).toBe("connected");
    recipient.dispose();
    restored = new MobileClient(mobileNetwork, recipientStorage, { scan: async () => [] }, randomUUID, "ios");
    await restored.start();
    expect(restored.state.status).toBe("connected");
    expect(restored.state.activeProfileId).toBe(profile.profileId);
    fixture.application.connections.revoke(profile.connectionId);
    await restored.refresh();
    expect(restored.state.status).not.toBe("connected");
    expect(fixture.application.store.listConnections().find(item => item.id === profile.connectionId)?.state).toBe("revoked");
  } finally { restored?.dispose(); recipient.dispose(); issuer.dispose(); await fixture.close(); }
}, 30_000);
