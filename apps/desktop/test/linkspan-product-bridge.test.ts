import { EventEmitter } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { WebContents } from 'electron';
import { createClient } from '@connectrpc/connect';
import { createConnectTransport, createConnectionFetch } from '@joko/connection-transport';
import { installIrohClientBinding } from '@joko/connection-transport/trust';
import { ConnectionService } from '@joko/contracts';
import { LinkspanError, type ByteChannel } from '@jokoagent/linkspan-core';
import type { StreamBridge } from '@jokoagent/linkspan-core/stream';
import { createIrohBridgeClient } from '@jokoagent/linkspan-iroh/bridge';
import { createIrohBridgeHost, listenIroh } from '@jokoagent/linkspan-iroh/node';
import { configureIrohRuntime } from '@jokoagent/linkspan-iroh-node';
import { expect, it, vi } from 'vitest';
import { DesktopLinkspanHost } from '../src/linkspan-host.js';

// This test exercises the actual Desktop host and SDK. Electron's IPC source
// boundary is represented by a trusted document event, rather than a GUI app.
vi.mock('electron', () => ({ ipcMain: { on: vi.fn(), handle: vi.fn() } }));
const source = (path: string) => import(/* @vite-ignore */ new URL(path, import.meta.url).href);
function runtimeDirectory(): string {
  const directory = process.env.LINKSPAN_IROH_RUNTIME_DIR ?? fileURLToPath(new URL('../../orchestrator/dist/linkspan-runtime/iroh', import.meta.url));
  if (!existsSync(join(directory, 'iroh-runtime.json'))) throw new Error('Build the selected orchestrator iroh runtime before the Desktop product bridge test, or set LINKSPAN_IROH_RUNTIME_DIR.');
  return directory;
}

it('runs generated Joko RPC, pairing, a 2 MiB blob and revocation through the real Desktop iroh carrier', async () => {
  configureIrohRuntime(runtimeDirectory());
  const [{ openLinkspanIdentity }, { CredentialVault }, { OperationalStore }, { ConnectionManager }, { ArtifactStore }, { BlobTransferCoordinator }, { OperationalArtifactRepository }, { createPublicServer }, { serveLinkspanChannel }] = await Promise.all([
    source('../../orchestrator/src/linkspan-identity.ts'), source('../../orchestrator/src/credential-vault.ts'),
    source('../../../packages/store/src/index.ts'), source('../../orchestrator/src/connection-manager.ts'),
    source('../../orchestrator/src/artifact-store.ts'), source('../../orchestrator/src/blob-transfers.ts'),
    source('../../orchestrator/src/artifact-repository.ts'), source('../../orchestrator/src/server.ts'), source('../../orchestrator/src/linkspan-server.ts')
  ]);
  const root = await mkdtemp(join(tmpdir(), 'joko-desktop-iroh-product-'));
  const store = new OperationalStore(join(root, 'state.db')), connections = new ConnectionManager(store);
  const vault = await CredentialVault.open(join(root, 'master.key'));
  const identity = await openLinkspanIdentity({ dataDirectory: root, serverId: 'desktop-iroh-node', store, vault }), shutdown = new AbortController();
  const artifactRepository = new OperationalArtifactRepository(store);
  const artifacts = new ArtifactStore({ rootDirectory: join(root, 'artifacts'), repository: artifactRepository, ingestRoots: [root] });
  await artifacts.initialize();
  const blobTransfers = new BlobTransferCoordinator(artifacts), origin = 'https://desktop-iroh.invalid';
  const application = { config: { publicOrigin: origin, webDirectory: join(root, 'web'), corsOrigins: [] },
    serverId: 'desktop-iroh-node', linkspanIdentity: identity, store, connections, artifacts, blobTransfers, artifactRepository,
    workspaces: {}, workspaceChanges: {}, scheduler: {}, adapters: [], browserActivity: [], sessionHost: {} };
  const backend = await createPublicServer(application, { secureBridge: true }); backend.log.level = 'silent';
  backend.get('/v1/desktop-revocation-test', async (_request: unknown, reply: { type(value: string): unknown; send(value: unknown): unknown }) => {
    const { PassThrough } = await import('node:stream'); const body = new PassThrough(); body.write('ready'); reply.type('application/octet-stream'); return reply.send(body);
  });
  const backendOrigin = await backend.listen({ host: '127.0.0.1', port: 0 });
  const listener = await listenIroh({ identity, relayUrls: [] });
  const active = new Set<ByteChannel>(), serving = new Set<Promise<void>>();
  const accepting = (async () => {
    while (!shutdown.signal.aborted) {
      const channel = await listener.accept({ signal: shutdown.signal }); if (channel === null) break;
      active.add(channel);
      const pending: Promise<void> = serveLinkspanChannel(application, channel, backendOrigin, shutdown.signal).catch(() => channel.abort())
        .finally(() => { active.delete(channel); serving.delete(pending); });
      serving.add(pending);
    }
  })().catch(error => { if (!shutdown.signal.aborted) throw error; });
  const contents = Object.assign(new EventEmitter(), { mainFrame: { url: 'joko://app' }, isDestroyed: () => false }) as unknown as WebContents;
  const event = { sender: contents, senderFrame: contents.mainFrame }, kinds: string[] = [];
  const host = new DesktopLinkspanHost({ assertSource: input => {
    if (input.sender !== contents || input.senderFrame !== contents.mainFrame) throw new Error('Unexpected Desktop source.');
  }, quitting: () => false, prepare: async kind => { kinds.push(kind); if (kind !== 'iroh') throw new Error('An unselected runtime was loaded.'); configureIrohRuntime(runtimeDirectory()); },
  createHost: async kind => { if (kind !== 'iroh') throw new Error('An unselected runtime was loaded.'); return createIrohBridgeHost(); } });
  const occurrence = host.capture(event, randomUUID());
  const bridgeStarted = performance.now();
  const bridgeTrace: { method: string; phase: string; elapsedMs: number; code?: string }[] = [];
  const trace = (method: string, phase: string, code?: string) => {
    bridgeTrace.push({ method, phase, elapsedMs: Math.round(performance.now() - bridgeStarted), ...(code === undefined ? {} : { code }) });
    if (bridgeTrace.length > 64) bridgeTrace.shift();
  };
  const bridge: StreamBridge = { async request(message) {
    trace(message.method, 'started');
    const response = await host.request(event, occurrence, 'iroh', message);
    trace(message.method, response.success ? 'completed' : 'failed', response.success ? undefined : response.code);
    if (!response.success) throw new LinkspanError(response.code, 'The original Desktop carrier request failed.');
    return response.value;
  } };
  const renderer = createIrohBridgeClient(bridge);
  const stop = installIrohClientBinding({ createIdentity: () => renderer.createIrohIdentity(), connect: (transport, options) => renderer.connectIroh({ ...options,
    expectedEndpointId: transport.endpointId, ticket: transport.ticket, clientKey: transport.clientKey, relayUrls: transport.relayUrls }) });
  try {
    const device = await renderer.createIrohIdentity();
    const endpoint = { origin, endpointPublicKey: identity.publicKey, transportKind: 'iroh' as const,
      endpointTransport: { kind: 'iroh' as const, endpointId: listener.endpointId, ticket: listener.ticket, clientKey: device.privateKey, clientEndpointId: device.publicKey, relayUrls: [] } };
    const fetcher = createConnectionFetch(endpoint);
    const client = createClient(ConnectionService, createConnectTransport({ ...endpoint, baseUrl: origin }));
    expect((await client.getServerInfo({}, { timeoutMs: 15_000 })).server?.endpointPublicKey).toBe(identity.publicKey);
    const wrongPin = createClient(ConnectionService, createConnectTransport({ ...endpoint, endpointPublicKey: `ed25519:${'0'.repeat(64)}`, baseUrl: origin }));
    await expect(wrongPin.getServerInfo({}, { timeoutMs: 15_000 })).rejects.toThrow(/identity|authenticated|key/iu);
    const wrongNode = createClient(ConnectionService, createConnectTransport({ ...endpoint, baseUrl: origin,
      endpointTransport: { ...endpoint.endpointTransport, endpointId: '0'.repeat(64) } }));
    await expect(wrongNode.getServerInfo({}, { timeoutMs: 15_000 })).rejects.toBeDefined();
    // A failed SDK identity/Noise handshake must not close the shared listener.
    expect((await client.getServerInfo({}, { timeoutMs: 15_000 })).server?.serverId).toBe(application.serverId);
    connections.openPairingWindow();
    const cancelled = await client.beginPairing({ deviceDisplayName: 'Cancel', platform: 'desktop' });
    expect((await client.cancelPairing({ challengeId: cancelled.challenge!.challengeId })).cancelled).toBe(true);
    const invitation = connections.issuePairing('Trusted Desktop owner');
    const paired = (await client.completePairing({ challengeId: invitation.id, humanCode: invitation.code, deviceDisplayName: 'Desktop SDK client' })).result!;
    const data = new Uint8Array(2 * 1024 * 1024).fill(137);
    const ticket = await blobTransfers.beginUpload({ expectedSize: data.length, expectedSha256: createHash('sha256').update(data).digest('hex') });
    const uploaded = await fetcher(new URL(ticket.relativeEndpoint, origin), { method: 'PUT', body: data,
      headers: { authorization: `Bearer ${paired.authKey}`, 'content-type': 'application/octet-stream' }, signal: AbortSignal.timeout(15_000) });
    expect(uploaded.ok).toBe(true); await uploaded.arrayBuffer();
    expect(blobTransfers.completeUpload(ticket.uploadId).byteLength).toBe(data.length);
    const live = await fetcher(`${origin}/v1/desktop-revocation-test`, { headers: { authorization: `Bearer ${paired.authKey}` }, signal: AbortSignal.timeout(15_000) });
    const reader = live.body!.getReader(); expect(new TextDecoder().decode((await reader.read()).value)).toBe('ready');
    // A concurrent request reuses this device's backend identity without
    // retiring its original, still open authenticated stream.
    expect((await client.getServerInfo({})).server?.serverId).toBe(application.serverId);
    connections.revoke(paired.connection!.connectionId); await expect(reader.read()).rejects.toBeDefined();
    host.capture(event, randomUUID());
    await expect(client.getServerInfo({}, { timeoutMs: 15_000 })).rejects.toBeDefined();
    expect(kinds.length).toBeGreaterThan(5); expect(new Set(kinds)).toEqual(new Set(['iroh']));
  } catch (error) {
    console.info('Desktop iroh bridge failure phases:', JSON.stringify(bridgeTrace));
    throw error;
  } finally {
    stop(); host.dispose(); shutdown.abort(); for (const channel of active) channel.abort();
    await listener.close(); await accepting; await Promise.all(serving); await backend.close(); store.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

it('uses the real Electron Node runtime for a direct iroh bridge and authenticated byte exchange', async () => {
  const directory = runtimeDirectory();
  const electron = createRequire(import.meta.url)('electron') as unknown;
  if (typeof electron !== 'string' || !existsSync(electron)) throw new Error('Prepare the fixed Electron executable before its native SDK smoke.');
  const root = await mkdtemp(join(tmpdir(), 'joko-electron-iroh-'));
  const script = join(root, 'bridge-smoke.mjs');
  await writeFile(script, `import { generateKeyPairSync } from 'node:crypto';
const runtime=await import(process.argv[3]),sdk=await import(process.argv[4]),binding=await import(process.argv[5]);
runtime.configureIrohRuntime(process.argv[2]);
const key=generateKeyPairSync('ed25519'),seed=key.privateKey.export({format:'der',type:'pkcs8'}).subarray(-32),publicKey=key.publicKey.export({format:'der',type:'spki'}).subarray(-32);
const identity={privateKey:new Uint8Array([8,1,18,64,...seed,...publicKey]),publicKey:'ed25519:'+publicKey.toString('hex')};
let listener,host,client,server;
try {
  listener=await sdk.listenIroh({identity,relayUrls:[]});
  host=sdk.createIrohBridgeHost();const api=binding.createIrohBridgeClient(host),device=await api.createIrohIdentity();
  const accepted=listener.accept({deadline:Date.now()+15000});
  client=await api.connectIroh({ticket:listener.ticket,expectedEndpointId:listener.endpointId,expectedPublicKey:identity.publicKey,clientKey:device.privateKey,relayUrls:[],deadline:Date.now()+15000});
  server=await accepted;if(!server)throw new Error('closed');
  await client.send(new Uint8Array([1,17,255]));const bytes=await server.receive({deadline:Date.now()+10000});
  if(!bytes||Buffer.from(bytes).toString('hex')!=='0111ff')throw new Error('protocol_error');
  await server.send(new Uint8Array([255,17,1]));const reply=await client.receive({deadline:Date.now()+10000});
  if(!reply||Buffer.from(reply).toString('hex')!=='ff1101')throw new Error('protocol_error');
  await Promise.all([client.close(),server.close()]);client=server=undefined;
  console.log(JSON.stringify({ok:true,backend:'iroh',electronVersion:process.versions.electron}));
} finally {client?.abort();server?.abort();host?.dispose();await listener?.close();}
`, { flag: 'wx', mode: 0o600 });
  try {
    const environment: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }; delete environment.NODE_OPTIONS; delete environment.NODE_PATH;
    let output: string;
    try {
      const result = await promisify(execFile)(electron, [script, directory, import.meta.resolve('@jokoagent/linkspan-iroh-node'),
        import.meta.resolve('@jokoagent/linkspan-iroh/node'), import.meta.resolve('@jokoagent/linkspan-iroh/bridge')],
      { env: environment, timeout: 30_000, maxBuffer: 128 * 1024, windowsHide: true });
      output = result.stdout;
    } catch (error) {
      const failure = error as { code?: unknown; signal?: unknown };
      throw new Error(`The Electron native iroh smoke did not complete (code=${typeof failure.code === 'number' ? failure.code : 'unavailable'}, signal=${typeof failure.signal === 'string' && /^[A-Z0-9]+$/u.test(failure.signal) ? failure.signal : 'none'}).`);
    }
    expect(JSON.parse(output)).toMatchObject({ ok: true, backend: 'iroh', electronVersion: expect.stringMatching(/^\d+\.\d+\.\d+/u) });
  } finally { await rm(root, { recursive: true, force: true }); }
}, 45_000);
