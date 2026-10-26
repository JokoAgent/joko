import { createConnectionFetch } from '@joko/connection-transport';
import { installWebRtcClientBinding, replaceEndpointTrust } from '@joko/connection-transport/trust';
import { connectWebRtcBridge, createWebRtcBridgeHost } from '@joko/connection-transport/webrtc';
import { expect, it } from 'vitest';
import { createE2eClients } from './connect-clients.js';
import { OrchestratorE2eFixture, sha256 } from './fixture.js';

it('carries real pinned RPC and Blob records through the Mobile JSON WebRTC bridge without turning graceful close into cancellation', async () => {
  const fixture = await OrchestratorE2eFixture.start({ webRtc: true });
  const host = createWebRtcBridgeHost();
  let dropCompletion = false, dropped = false;
  const methods: string[] = [];
  const bridge = { async request(message: Parameters<typeof host.request>[0]): Promise<unknown> {
    methods.push(message.method);
    // The trusted RN/WebView boundary carries JSON, including arrays of bytes.
    const result = await host.request(JSON.parse(JSON.stringify(message)));
    if (dropCompletion && message.method === 'read' && Array.isArray(result) && result[0] === 2) {
      dropCompletion = false; dropped = true;
      await host.request({ method: 'abort', streamId: message.streamId });
      return null;
    }
    return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
  } };
  const uninstall = installWebRtcClientBinding({ connect: (origin, expectedPublicKey, options) => connectWebRtcBridge(bridge, origin, expectedPublicKey, options) });
  const endpointPublicKey = fixture.application.linkspanIdentity!.publicKey;
  replaceEndpointTrust({ origin: fixture.baseUrl, endpointPublicKey, serverId: fixture.application.serverId,
    transportKind: 'webrtc', endpointTransport: { kind: 'webrtc' } });
  try {
    const anonymous = createE2eClients(fixture.baseUrl, undefined, 20_000, endpointPublicKey);
    expect((await anonymous.connection.getServerInfo({})).server?.endpointPublicKey).toBe(endpointPublicKey);
    expect(methods).toContain('close');
    const invitation = fixture.application.connections.issuePairing('Mobile bridge device');
    const paired = (await anonymous.connection.completePairing({ challengeId: invitation.id, humanCode: invitation.code,
      deviceDisplayName: 'Mobile bridge', platform: 'test' })).result!;
    const clients = createE2eClients(fixture.baseUrl, paired.authKey, 20_000, endpointPublicKey);
    expect((await clients.connection.listConnections({})).connections.some(connection => connection.connectionId === paired.connection!.connectionId)).toBe(true);

    const bytes = new Uint8Array(2 * 1024 * 1024).fill(163);
    const upload = (await clients.artifact.beginBlobUpload({ fileName: 'bridge.bin', mediaType: 'application/octet-stream',
      byteSize: BigInt(bytes.byteLength), sha256Hex: sha256(bytes) })).upload!;
    const fetcher = createConnectionFetch({ origin: fixture.baseUrl, endpointPublicKey, transportKind: 'webrtc', endpointTransport: { kind: 'webrtc' } });
    const uploaded = await fetcher(`${fixture.baseUrl}${upload.ticket!.relativeEndpoint}`, { method: 'PUT', body: bytes,
      headers: { authorization: `Bearer ${paired.authKey}`, 'content-type': 'application/octet-stream' } });
    expect(uploaded.status).toBe(201); await uploaded.arrayBuffer();
    const blob = (await clients.artifact.completeBlobUpload({ uploadId: upload.uploadId })).blob!;
    const ticket = await clients.artifact.getBlobDownloadTicket({ blobId: blob.blobId });
    const downloaded = await fetcher(`${fixture.baseUrl}${ticket.ticket!.relativeEndpoint}`, { headers: { authorization: `Bearer ${paired.authKey}` } });
    expect(sha256(new Uint8Array(await downloaded.arrayBuffer()))).toBe(sha256(bytes));

    const before = fixture.webRtcSignalingRequests;
    const wrong = createConnectionFetch({ origin: fixture.baseUrl, endpointPublicKey: `ed25519:${'b'.repeat(64)}`,
      transportKind: 'webrtc', endpointTransport: { kind: 'webrtc' } });
    await expect(wrong(`${fixture.baseUrl}/joko.v1.ConnectionService/GetServerInfo`, { method: 'POST', body: '{}',
      headers: { 'content-type': 'application/json' } })).rejects.toBeDefined();
    expect(fixture.webRtcSignalingRequests).toBe(before);

    const channel = await connectWebRtcBridge(bridge, fixture.baseUrl, endpointPublicKey, {});
    const cancel = new AbortController(), receiving = channel.receive({ signal: cancel.signal });
    cancel.abort();
    await expect(receiving).rejects.toMatchObject({ code: 'cancelled' });
    await expect(channel.closed).resolves.toMatchObject({ error: { code: 'cancelled' } });
    expect(methods).toContain('abort');

    // An HTTP END record is mandatory even when the peer later closes normally.
    dropCompletion = true;
    await expect(anonymous.connection.getServerInfo({})).rejects.toBeDefined();
    expect(dropped).toBe(true);
    fixture.application.connections.revoke(paired.connection!.connectionId);
    await expect(clients.connection.listConnections({})).rejects.toBeDefined();
  } finally {
    uninstall(); host.dispose();
    replaceEndpointTrust({ origin: fixture.baseUrl, endpointPublicKey, transportKind: 'https' });
    await fixture.close();
  }
}, 60_000);
