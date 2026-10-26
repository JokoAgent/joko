import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import type { WebContents } from 'electron';
import { createClient } from '@connectrpc/connect';
import { createConnectTransport, createConnectionFetch } from '@joko/connection-transport';
import { ConnectionService } from '@joko/contracts';
import { expect, it, vi } from 'vitest';
import { DesktopLinkspanHost } from '../src/linkspan-host.js';
import { createDesktopHttpConnectBridgeHost } from '../src/http-connect-bridge-host.js';

vi.mock('electron', () => ({ ipcMain: { on: vi.fn(), handle: vi.fn() } }));
const source = (path: string) => import(/* @vite-ignore */ new URL(path, import.meta.url).href);

it('carries real pairing/RPC and a 2 MiB file across the Desktop CONNECT IPC boundary, then retires revocation, cancellation and its original document', async () => {
  const [{ openLinkspanIdentity }, { CredentialVault }, { OperationalStore }, { ConnectionManager }, { ArtifactStore },
    { BlobTransferCoordinator }, { OperationalArtifactRepository }, { createPublicServer }, { createLinkspanTcpIngress }, { installDesktopLinkspanBindings }] = await Promise.all([
    source('../../orchestrator/src/linkspan-identity.ts'), source('../../orchestrator/src/credential-vault.ts'), source('../../../packages/store/src/index.ts'),
    source('../../orchestrator/src/connection-manager.ts'), source('../../orchestrator/src/artifact-store.ts'), source('../../orchestrator/src/blob-transfers.ts'),
    source('../../orchestrator/src/artifact-repository.ts'), source('../../orchestrator/src/server.ts'), source('../../orchestrator/src/linkspan-tcp-server.ts'),
    source('../../web/src/desktop-linkspan-binding.ts')
  ]);
  const root = await mkdtemp(join(tmpdir(), 'joko-desktop-connect-'));
  const store = new OperationalStore(join(root, 'state.db')), connections = new ConnectionManager(store);
  const vault = await CredentialVault.open(join(root, 'master.key'));
  const identity = await openLinkspanIdentity({ dataDirectory: root, serverId: 'desktop-connect-node', store, vault });
  const repository = new OperationalArtifactRepository(store);
  const artifacts = new ArtifactStore({ rootDirectory: join(root, 'artifacts'), repository, ingestRoots: [root] }); await artifacts.initialize();
  const blobTransfers = new BlobTransferCoordinator(artifacts), origin = 'https://desktop-connect.invalid';
  const application = { config: { publicOrigin: origin, webDirectory: join(root, 'web'), corsOrigins: [] },
    serverId: 'desktop-connect-node', linkspanIdentity: identity, store, connections, artifacts, blobTransfers, artifactRepository: repository,
    workspaces: {}, workspaceChanges: {}, scheduler: {}, adapters: [], browserActivity: [], sessionHost: {} };
  const backend = await createPublicServer(application, { secureBridge: true }); backend.log.level = 'silent';
  let backendRequests = 0;
  backend.addHook('onRequest', async () => { backendRequests++; });
  backend.get('/v1/desktop-connect-live', async (_request: unknown, reply: { send(value: unknown): unknown }) => {
    const { PassThrough } = await import('node:stream'); const body = new PassThrough(); body.write('ready'); return reply.send(body);
  });
  const ingress = createLinkspanTcpIngress(application, { backendOrigin: await backend.listen({ host: '127.0.0.1', port: 0 }) });
  const target = await ingress.listen();
  const sockets = new Set<Duplex>(); let proxyRequests = 0;
  const track = (socket: Duplex): void => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); };
  const proxy = createServer({ maxHeaderSize: 4096 }); proxy.on('connection', track);
  proxy.on('connect', (request, socket, head) => {
    if (request.url !== 'desktop-connect.invalid:443' || request.headers.authorization !== undefined || request.headers['proxy-authorization'] !== undefined) {
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); return;
    }
    proxyRequests++;
    const upstream = createConnection({ host: target.address, port: target.port }); track(upstream);
    socket.on('error', () => upstream.destroy()); upstream.on('error', () => socket.destroy());
    socket.once('close', () => upstream.destroy()); upstream.once('close', () => { if (!upstream.readableEnded) socket.destroy(); });
    upstream.once('connect', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head); socket.pipe(upstream); upstream.pipe(socket);
    });
  });
  await new Promise<void>((resolve, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', () => { proxy.removeListener('error', reject); resolve(); }); });
  const proxyAddress = proxy.address(); if (proxyAddress === null || typeof proxyAddress === 'string') throw new Error('Missing CONNECT fixture port.');
  const contents = Object.assign(new EventEmitter(), { mainFrame: { url: 'joko://app' }, isDestroyed: () => false }) as unknown as WebContents;
  const event = { sender: contents, senderFrame: contents.mainFrame }, prepared: string[] = [], methods: string[] = [];
  const host = new DesktopLinkspanHost({ assertSource: input => {
    if (input.sender !== contents || input.senderFrame !== contents.mainFrame) throw new Error('Unexpected Desktop source.');
  }, quitting: () => false, prepare: async kind => { prepared.push(kind); if (kind !== 'http-connect') throw new Error('An unselected SDK was prepared.'); },
  createHost: async kind => { if (kind !== 'http-connect') throw new Error('An unselected SDK was loaded.'); return createDesktopHttpConnectBridgeHost(); } });
  const occurrence = host.capture(event, randomUUID());
  // Exercise the production renderer binding and structured IPC shape. Noise
  // authenticates in that renderer binding after Main returns CONNECT bytes.
  const stop = installDesktopLinkspanBindings({ async request(kind: string, message: { method: string }) {
    methods.push(message.method);
    return JSON.parse(JSON.stringify(await host.request(event, occurrence, kind, JSON.parse(JSON.stringify(message)))));
  } });
  try {
    const endpoint = { origin, endpointPublicKey: identity.publicKey, transportKind: 'http-connect' as const,
      endpointTransport: { kind: 'http-connect' as const, proxyOrigin: `http://127.0.0.1:${proxyAddress.port}`, authority: 'desktop-connect.invalid:443' } };
    const fetcher = createConnectionFetch(endpoint);
    const client = createClient(ConnectionService, createConnectTransport({ ...endpoint, baseUrl: origin }));
    const wrong = createClient(ConnectionService, createConnectTransport({ ...endpoint, endpointPublicKey: `ed25519:${'0'.repeat(64)}`, baseUrl: origin }));
    await expect(wrong.getServerInfo({}, { timeoutMs: 10_000 })).rejects.toBeDefined(); expect(backendRequests).toBe(0);
    expect((await client.getServerInfo({})).server?.serverId).toBe(application.serverId);
    connections.openPairingWindow();
    const cancelled = await client.beginPairing({ deviceDisplayName: 'Cancelled', platform: 'desktop' });
    expect((await client.cancelPairing({ challengeId: cancelled.challenge!.challengeId })).cancelled).toBe(true);
    const invitation = connections.issuePairing('Desktop CONNECT owner');
    const paired = (await client.completePairing({ challengeId: invitation.id, humanCode: invitation.code, deviceDisplayName: 'Desktop CONNECT' })).result!;
    const data = new Uint8Array(2 * 1024 * 1024).fill(137), digest = createHash('sha256').update(data).digest('hex');
    const upload = await blobTransfers.beginUpload({ expectedSize: data.length, expectedSha256: digest });
    const uploaded = await fetcher(origin + upload.relativeEndpoint, { method: 'PUT', body: data, headers: { authorization: `Bearer ${paired.authKey}`, 'content-type': 'application/octet-stream' } });
    expect(uploaded.ok).toBe(true); await uploaded.arrayBuffer();
    const blob = blobTransfers.completeUpload(upload.uploadId); expect(blob.byteLength).toBe(data.length);
    const download = await blobTransfers.beginDownload(blob.id);
    const downloaded = await fetcher(origin + download.relativeEndpoint, { headers: { authorization: `Bearer ${paired.authKey}` } });
    expect(createHash('sha256').update(new Uint8Array(await downloaded.arrayBuffer())).digest('hex')).toBe(digest);
    const live = await fetcher(origin + '/v1/desktop-connect-live', { headers: { authorization: `Bearer ${paired.authKey}` } });
    const reader = live.body!.getReader(); expect(new TextDecoder().decode((await reader.read()).value)).toBe('ready');
    connections.revoke(paired.connection!.connectionId); await expect(reader.read()).rejects.toBeDefined();
    const second = connections.issuePairing('Document owner');
    const documentOwner = (await client.completePairing({ challengeId: second.id, humanCode: second.code, deviceDisplayName: 'Document owner' })).result!;
    const abort = new AbortController();
    const cancellable = await fetcher(origin + '/v1/desktop-connect-live', { headers: { authorization: `Bearer ${documentOwner.authKey}` }, signal: abort.signal });
    const cancelledReader = cancellable.body!.getReader(); expect(new TextDecoder().decode((await cancelledReader.read()).value)).toBe('ready');
    abort.abort(); await expect(cancelledReader.read()).rejects.toBeDefined();
    expect((await client.getServerInfo({})).server?.serverId).toBe(application.serverId);
    const documentLive = await fetcher(origin + '/v1/desktop-connect-live', { headers: { authorization: `Bearer ${documentOwner.authKey}` } });
    const documentReader = documentLive.body!.getReader(); expect(new TextDecoder().decode((await documentReader.read()).value)).toBe('ready');
    host.capture(event, randomUUID());
    await expect(documentReader.read()).rejects.toBeDefined();
    await expect(client.getServerInfo({}, { timeoutMs: 10_000 })).rejects.toBeDefined();
    expect(new Set(prepared)).toEqual(new Set(['http-connect'])); expect(proxyRequests).toBeGreaterThanOrEqual(10);
    expect(methods).toContain('connect'); expect(methods).toContain('read'); expect(methods).toContain('write'); expect(methods).toContain('close');
  } finally {
    stop(); host.dispose(); for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => proxy.close(error => error === undefined ? resolve() : reject(error)));
    await ingress.close(); await backend.close(); store.close(); await rm(root, { recursive: true, force: true });
  }
}, 60_000);
