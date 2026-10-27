import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { create } from '@bufbuild/protobuf';
import { Code, createClient, createRouterTransport } from '@connectrpc/connect';
import { ChangeServerAccessEntryRequestSchema, SaveServerAccessEntryRequestSchema, ServerAccessService } from '@joko/contracts';
import { SERVER_ACCESS_PROVIDERS, serverAccessModes } from '@joko/contracts/server-access';
import { OperationalStore } from '@joko/store';
import { afterEach, expect, it, vi } from 'vitest';
import { CredentialManager } from './credential-manager.js';
import { CredentialVault } from './credential-vault.js';
import { ConnectionManager } from './connection-manager.js';
import { ServerAccessManager, type ServerAccessRuntime } from './server-access-manager.js';
import { createServerAccessConnectService } from './server-access-connect-service.js';
import * as configuration from './server-access-configuration.js';
import * as deployment from './linkspan-deployment.js';
import type { OrchestratorConfig } from './config.js';
import type { OrchestratorApplication } from './application.js';
import { createServerAccessRuntime } from './server-access-runtime.js';
import * as ingress from './linkspan-server.js';
import * as providerConnector from './linkspan-provider-connector.js';
import { publishConnectionEntry } from './connection-entries.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
async function fixture(deployment = false) {
  vi.spyOn(configuration, 'accessCapabilities').mockResolvedValue(SERVER_ACCESS_PROVIDERS.flatMap(provider => serverAccessModes(provider.id).map(mode => ({ provider: provider.id, mode: mode.id, state: 'ready', issue: '' }))));
  const root = await mkdtemp(join(tmpdir(), 'joko-server-access-')), database = join(root, 'state.sqlite');
  if (deployment && process.platform === 'win32') await windowsPrivateFixture(root, true);
  await mkdir(join(root, 'workspace'));
  let store = new OperationalStore(database), connections = new ConnectionManager(store);
  const token = 'private-owner-key', connection = store.createConnection({ id: randomUUID(), name: 'Owner', authKeyDigest: createHash('sha256').update(token).digest('hex') });
  const vault = await CredentialVault.open(join(root, 'master.key'));
  let credentials = new CredentialManager({ vault, storagePath: join(root, 'records.json') }); await credentials.initialize();
  const config = { dataDirectory: root, publicOrigin: 'http://127.0.0.1:4318', workspace: { root: join(root, 'workspace') },
    ...(deployment ? { linkspan: { port: 0, deploymentPath: join(root, 'deployment.json') } } : {}) } as OrchestratorConfig;
  let manager = new ServerAccessManager({ config, serverId: 'server', store, credentials, connections });
  const starts: configuration.AccessMaterial[] = [], closes: string[] = [];
  const runtime: ServerAccessRuntime = { start: vi.fn(async (record, material) => { starts.push(material); let live = true;
    return { publicOrigin: 'https://published.example', publishedEntryId: `linkspan:${record.entryId}`, isActive: () => live, close: async () => { live = false; closes.push(record.entryId); } }; }),
    resource: vi.fn<ServerAccessRuntime['resource']>(async record => ({ entryId: record.entryId, provider: 'cloudflare', state: 'not_created' })), reconcile: vi.fn(async () => {}) };
  const settle = async (id: string) => { await vi.waitFor(() => expect(store.getOperation(id).status).toBe('completed')); return manager.read(connection, id); };
  const save = (fields: Record<string, string> = {}, provider = 'iroh', mode = 'relay', expectedRevision = '', entryId = 'entrance') => {
    const input = create(SaveServerAccessEntryRequestSchema, { requestId: randomUUID(), entryId, name: 'My entrance', provider, mode, fields, expectedRevision });
    return { input, result: manager.save(connection, input, new AbortController().signal) };
  };
  const change = async (action: string, confirmDisconnection = false, entryId = 'entrance') => {
    const entry = (await manager.read(connection)).entries.find(value => value.entryId === entryId)!;
    const input = create(ChangeServerAccessEntryRequestSchema, { requestId: randomUUID(), entryId, expectedRevision: entry.revision, action, confirmDisconnection });
    await manager.change(connection, input); return { input, result: await settle(input.requestId) };
  };
  cleanups.push(async () => { await manager.close(); store.close(); if (!root.startsWith(join(tmpdir(), 'joko-server-access-'))) throw new Error('Unsafe fixture path'); await rm(root, { recursive: true, force: true }); });
  return { root, config, connection, token, runtime, starts, closes, save, change, settle,
    get store() { return store; }, get credentials() { return credentials; }, get manager() { return manager; }, get connections() { return connections; },
    async restart() { await manager.close(); store.close(); store = new OperationalStore(database); connections = new ConnectionManager(store);
      credentials = new CredentialManager({ vault, storagePath: join(root, 'records.json') }); await credentials.initialize();
      manager = new ServerAccessManager({ config, serverId: 'server', store, credentials, connections }); await manager.attach(runtime); }
  };
}

it('keeps secrets out of public state and receipts, retains omitted secrets, rejects conflicts and preserves a stable SDK identity after restart', async () => {
  const f = await fixture(); await f.manager.attach(f.runtime);
  const first = f.save({ relayUrls: 'https://relay.example', servicesApiSecret: 'publisher-secret-do-not-project' });
  const saved = (await first.result).entry!;
  expect(saved.configuredSecrets).toEqual(['servicesApiSecret']); expect(saved.fields).not.toHaveProperty('servicesApiSecret');
  expect(await f.manager.save(f.connection, first.input, new AbortController().signal)).toEqual({ entry: saved });
  await expect(f.manager.save(f.connection, { ...first.input, name: 'Changed content' }, new AbortController().signal)).rejects.toThrow('request_conflict');
  await f.change('start'); const identity = f.starts[0]!.identity;
  const active = (await f.manager.read(f.connection)).entries[0]!;
  await f.save({ relayUrls: 'https://other-relay.example' }, 'iroh', 'relay', active.revision).result;
  expect(f.closes).toEqual([]); expect((await f.manager.read(f.connection)).entries[0]!.pendingChanges).toBe(true);
  await expect(f.change('start')).rejects.toThrow('stop_before_apply'); await expect(f.change('stop')).rejects.toThrow('confirm_disconnection');
  await f.change('stop', true); await f.change('start');
  expect(f.starts[1]!.fields['servicesApiSecret']).toBe('publisher-secret-do-not-project'); expect(f.starts[1]!.identity).toEqual(identity);
  await f.restart(); await vi.waitFor(() => expect(f.starts).toHaveLength(3)); expect(f.starts[2]!.identity).toEqual(identity);
  expect(f.credentials.list()).toEqual([]);
  const publicData = JSON.stringify({ settings: f.store.listSettings(), operations: f.store.listOperations(), response: await f.manager.read(f.connection) }, (_key, value) => typeof value === 'bigint' ? String(value) : value);
  expect(publicData).not.toContain('publisher-secret-do-not-project'); expect(publicData).not.toContain(identity!.secretKeyHex);
  expect(await readFile(join(f.root, 'records.json'), 'utf8')).not.toContain('publisher-secret-do-not-project');
});

it('reserves the Vault revision before writing and fences revoked saves', async () => {
  const f = await fixture(); await f.manager.attach(f.runtime);
  const actualWrite = f.credentials.compareAndSetManagedSecret.bind(f.credentials);
  vi.spyOn(f.credentials, 'compareAndSetManagedSecret').mockImplementation(async input => {
    expect(f.store.listSettingsByKeyPrefix('service', 'orchestrator', 'runtime.server-access.vault-ref.')).toHaveLength(1);
    const result = await actualWrite(input); f.connections.revoke(f.connection.id); return result;
  });
  await expect(f.save().result).rejects.toBeDefined(); expect(f.store.listSettingsByKeyPrefix('service', 'orchestrator', 'runtime.server-access.entry.')).toHaveLength(0);
  expect(f.runtime.start).not.toHaveBeenCalled(); expect(f.credentials.list()).toEqual([]);
});

it('closes a late enable after revocation without adopting its result', async () => {
  const f = await fixture(); await f.manager.attach(f.runtime); await f.save().result;
  const close = vi.fn(async () => {});
  vi.mocked(f.runtime.start).mockImplementationOnce(async () => { f.connections.revoke(f.connection.id); return { close }; });
  const entry = (await f.manager.read(f.connection)).entries[0]!;
  await f.manager.change(f.connection, create(ChangeServerAccessEntryRequestSchema, { requestId: randomUUID(), entryId: entry.entryId, expectedRevision: entry.revision, action: 'start' }));
  await vi.waitFor(() => {
    expect(close).toHaveBeenCalledOnce();
    const persisted = f.store.findSetting<{ state: string; enabled: boolean }>('service', 'orchestrator', `runtime.server-access.entry.${entry.entryId}`)!.value;
    expect(persisted).toMatchObject({ enabled: false, state: 'failed' });
  });
});

it('restores the last applied configuration while an edit is pending, and erases all private revisions on deletion', async () => {
  const f = await fixture(); await f.manager.attach(f.runtime);
  await f.save({ relayUrls: 'https://original.example', servicesApiSecret: 'original-private' }).result; await f.change('start');
  const active = (await f.manager.read(f.connection)).entries[0]!;
  await f.save({ relayUrls: 'https://pending.example', servicesApiSecret: 'pending-private' }, 'iroh', 'relay', active.revision).result;
  await f.restart(); await vi.waitFor(() => expect(f.starts).toHaveLength(2));
  expect(f.starts[1]!.fields['relayUrls']).toBe('https://original.example');
  expect((await f.manager.read(f.connection)).entries[0]!.pendingChanges).toBe(true);
  await f.change('stop', true); await f.change('start'); expect(f.starts[2]!.fields['relayUrls']).toBe('https://pending.example');
  const refs = f.store.listSettingsByKeyPrefix('service', 'orchestrator', 'runtime.server-access.vault-ref.').map(row => (row.value as { reference: string }).reference);
  await f.change('stop', true); await f.change('delete');
  await vi.waitFor(() => expect(refs.every(reference => f.credentials.find(reference) === undefined)).toBe(true));
});

it('uses the applied Dev Tunnel publisher revision on restart and the saved revision on explicit stop/start', async () => {
  const f = await fixture();
  const certificatePath = join(f.root, 'cert.pem'), privateKeyPath = join(f.root, 'key.pem');
  await writeFile(certificatePath, 'fixture certificate'); await writeFile(privateKeyPath, 'fixture key', { mode: 0o600 });
  Object.assign(f.config, { tls: { certificatePath, privateKeyPath } });
  const app = { config: f.config, serverId: 'server', get store() { return f.store; }, get credentials() { return f.credentials; } } as OrchestratorApplication;
  vi.spyOn(ingress, 'createLinkspanIngress').mockReturnValue({ server: createServer(), listen: async () => 'https://127.0.0.1:4329', close: async () => {} });
  const publish = vi.spyOn(providerConnector, 'startManagedProviderConnector').mockImplementation(async (_app, entry) => {
    const retire = publishConnectionEntry(f.store, { id: `linkspan:${entry.id}`, provider: 'dev-tunnels', origin: 'https://dev.example' });
    return { publicOrigin: 'https://dev.example', close: async () => { retire(); } } as Awaited<ReturnType<typeof providerConnector.startManagedProviderConnector>>;
  });
  const runtime = createServerAccessRuntime(app, 'http://127.0.0.1:4328');
  vi.mocked(f.runtime.start).mockImplementation(runtime.start);
  vi.mocked(f.runtime.resource).mockImplementation(runtime.resource);
  vi.mocked(f.runtime.reconcile).mockImplementation(runtime.reconcile);
  let remote: Record<string, unknown> | undefined, missing = false, revokedA = false;
  const reads: string[] = [], writes: string[] = [];
  const json = (value: unknown, status = 200) => Response.json(value, { status });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => {
    const token = new Headers(options?.headers).get('authorization')!;
    if (options?.method === 'GET') { reads.push(token); return revokedA && token === 'Bearer publisher-A' ? json({}, 403) : remote && !missing ? json(remote) : json({}, 404); }
    writes.push(options!.method!); expect(options!.method).toBe('PUT'); expect(token).toBe('Bearer publisher-A');
    const body = JSON.parse(String(options!.body)) as { ports: object[] };
    remote = { ...body, clusterId: 'use', accessTokens: { host: 'private-host-token' }, ports: body.ports.map(port => ({ ...port, portForwardingUris: ['https://dev.example'] })) };
    return json(remote);
  });
  await f.manager.attach(f.runtime);
  const first = await f.save({ resourceMode: 'managed', clusterId: 'use', port: '4318', apiToken: 'publisher-A' }, 'dev-tunnels', 'http').result;
  await f.change('resource_create'); await f.change('start');
  const resourceJournal = () => f.store.findSetting<{ reference: string; requestId: string }>('service', 'orchestrator', 'runtime.linkspan.resource.entrance')!.value;
  const original = resourceJournal(), owned = JSON.parse(f.credentials.resolve(original.reference)).resource;
  const active = (await f.manager.read(f.connection)).entries[0]!;
  const second = await f.save({ ...active.fields, apiToken: 'publisher-B' }, 'dev-tunnels', 'http', active.revision).result;
  expect((await f.manager.read(f.connection)).entries[0]!.pendingChanges).toBe(true);
  reads.length = 0; await f.restart();
  await vi.waitFor(() => expect(publish).toHaveBeenCalledTimes(2));
  await vi.waitFor(async () => expect((await f.manager.read(f.connection)).entries[0]!.state).toBe('active'));
  expect(reads).toEqual(['Bearer publisher-A']);
  expect(vi.mocked(f.runtime.start).mock.calls.at(-1)![0].reference).toBe(`server.access:${first.entry!.requestId}`);
  expect((await f.manager.read(f.connection)).entries[0]!.pendingChanges).toBe(true);
  await f.change('stop', true); reads.length = 0; revokedA = true;
  // The original publisher credential can now be revoked; no status action is
  // needed to refresh the resource's stored management reference first.
  await f.change('start');
  expect(reads).toEqual(['Bearer publisher-B']);
  expect(vi.mocked(f.runtime.start).mock.calls.at(-1)![0].reference).toBe(`server.access:${second.entry!.requestId}`);
  expect(resourceJournal()).toEqual(original);
  expect(JSON.parse(f.credentials.resolve(original.reference)).resource).toEqual(owned);
  expect(writes).toEqual(['PUT']);
  await f.change('stop', true); missing = true; reads.length = 0;
  await f.change('start');
  expect(reads).toEqual(['Bearer publisher-B']); expect(writes).toEqual(['PUT']); expect(publish).toHaveBeenCalledTimes(3);
  expect(resourceJournal()).toEqual(original); expect(JSON.parse(f.credentials.resolve(original.reference)).resource).toEqual(owned);
  expect((await f.manager.read(f.connection)).entries[0]!.state).not.toBe('active');
  const publicState = JSON.stringify({ settings: f.store.listSettings(), operations: f.store.listOperations(), response: await f.manager.read(f.connection) }, (_key, value) => typeof value === 'bigint' ? String(value) : value);
  for (const secret of ['publisher-A', 'publisher-B', 'private-host-token']) expect(publicState).not.toContain(secret);
}, 15_000);

it('rejects invalid coturn URLs before saving and preserves an enabled valid configuration after a rejected edit', async () => {
  const f = await fixture(); await f.manager.attach(f.runtime);
  const fields = { keyId: 'relay', apiToken: 'private-turn-secret', urls: 'turn:relay.example:3478?transport=udp' };
  const invalidUrls = ['https://relay.example', 'turn:relay.example:99999', 'turns:relay.example:443?transport=udp', 'TURNS:relay.example:443?transport=UDP'];
  for (const urls of invalidUrls) await expect(f.save({ ...fields, urls }, 'coturn', 'turn').result).rejects.toMatchObject({ code: Code.InvalidArgument, rawMessage: 'invalid:urls' });
  expect((await f.manager.read(f.connection)).entries).toEqual([]);
  expect(f.store.listSettingsByKeyPrefix('service', 'orchestrator', 'runtime.server-access.vault-ref.')).toEqual([]);
  expect(f.runtime.start).not.toHaveBeenCalled();
  await f.save({ ...fields, urls: `${fields.urls}\nturns:relay.example:443?transport=tcp` }, 'coturn', 'turn').result;
  await f.change('start'); const active = (await f.manager.read(f.connection)).entries[0]!;
  for (const urls of invalidUrls) await expect(f.save({ ...active.fields, urls }, 'coturn', 'turn', active.revision).result).rejects.toMatchObject({ code: Code.InvalidArgument, rawMessage: 'invalid:urls' });
  expect((await f.manager.read(f.connection)).entries[0]).toEqual(active);
  expect(f.runtime.start).toHaveBeenCalledOnce(); expect(f.closes).toEqual([]);
});

it('keeps interrupted effects unknown after restart and allows explicitly re-adding a deleted Quick configuration', async () => {
  const f = await fixture(); await f.manager.attach(f.runtime); await f.save({}, 'cloudflare', 'quick', '', 'cloudflare-quick').result;
  await f.change('delete', false, 'cloudflare-quick');
  await f.save({}, 'cloudflare', 'quick', '', 'cloudflare-quick').result;
  const entry = (await f.manager.read(f.connection)).entries[0]!, requestId = randomUUID();
  f.store.claimAuthorizedDeferredEffectOperation(f.connection.id, f.connection.authKeyDigest, { id: requestId, kind: 'server.access.change', body: { entryId: entry.entryId, action: 'start' } }, () => {
    const row = f.store.findSetting<Record<string, unknown>>('service', 'orchestrator', `runtime.server-access.entry.${entry.entryId}`)!.value;
    f.store.setSetting('service', 'orchestrator', `runtime.server-access.entry.${entry.entryId}`, { ...row, requestId, state: 'starting', enabled: true });
  });
  await f.restart(); expect(f.runtime.start).not.toHaveBeenCalled();
  expect((await f.manager.read(f.connection, requestId)).operationState).toBe('outcome_unknown');
  expect((await f.manager.read(f.connection)).entries[0]!.state).toBe('outcome_unknown');
});

it('treats any failed close as unknown and retains the exact handle for an explicit cleanup retry', async () => {
  const f = await fixture(); await f.manager.attach(f.runtime); await f.save().result;
  const close = vi.fn().mockRejectedValueOnce(new Error('private-file-or-provider-detail')).mockResolvedValue(undefined);
  vi.mocked(f.runtime.start).mockResolvedValueOnce({ close });
  await f.change('start'); await f.change('stop', true);
  const failed = (await f.manager.read(f.connection)).entries[0]!;
  expect(failed.state).toBe('outcome_unknown'); expect(failed.issue).toBe('query_original_operation');
  await expect(f.change('start')).rejects.toThrow('query_original_operation');
  await f.change('reconcile'); expect(close).toHaveBeenCalledTimes(2);
  expect((await f.manager.read(f.connection)).entries[0]!.state).toBe('stopped');
});

it('serves authenticated generated RPCs, rejects unapproved callers and retains an uncertain original request without repeating the effect', async () => {
  const f = await fixture(); await f.manager.attach(f.runtime);
  const app = { serverAccess: f.manager, connections: f.connections } as OrchestratorApplication;
  const routes = (router: import('@connectrpc/connect').ConnectRouter) => router.service(ServerAccessService, createServerAccessConnectService(app));
  const anonymous = createClient(ServerAccessService, createRouterTransport(routes));
  await expect(anonymous.getServerAccessSettings({})).rejects.toThrow('authorized');
  const owner = createClient(ServerAccessService, createRouterTransport(routes, { transport: { interceptors: [next => request => { request.header.set('authorization', `Bearer ${f.token}`); return next(request); }] } }));
  const requestId = randomUUID(); await owner.saveServerAccessEntry({ requestId, entryId: 'entrance', name: 'Private node', provider: 'tailcat', mode: 'relay', fields: { allowPrivateAddressPairing: 'true' } });
  const read = await owner.getServerAccessSettings({ requestId }); expect(read.operationState).toBe('completed');
  vi.mocked(f.runtime.start).mockRejectedValueOnce(Object.assign(new Error('publisher-private-error'), { code: 'outcome_unknown' }));
  const result = await f.change('start'); expect(result.result.operationEntry?.state).toBe('outcome_unknown');
  expect(JSON.stringify(result.result)).not.toContain('publisher-private-error');
  await f.manager.change(f.connection, result.input); expect(f.runtime.start).toHaveBeenCalledOnce();
  await expect(f.change('start')).rejects.toThrow('query_original_operation');
  await f.change('reconcile'); expect(f.runtime.reconcile).toHaveBeenCalledOnce();
  await f.change('start'); expect(f.runtime.start).toHaveBeenCalledTimes(2);
});

it('adopts a deployment source once, reports changed input, and never resurrects a deleted source on restart', async () => {
  const f = await fixture(true);
  const deployment = (token: string) => [{ id: 'entrance', connector: { provider: 'ngrok', mode: 'http', authtoken: token, budget: { paidEnabled: false, maximumSessionMs: 60000, maximumBytes: 1024 } } }];
  await writePrivateFixture(f.config.linkspan!.deploymentPath!, JSON.stringify(deployment('first-private-token')));
  await f.manager.attach(f.runtime); await vi.waitFor(() => expect(f.starts).toHaveLength(1));
  await expect(f.change('stop', true)).rejects.toThrow('adoption_required'); await f.change('adopt');
  await writeFile(f.config.linkspan!.deploymentPath!, JSON.stringify(deployment('changed-private-token')), { mode: 0o600 });
  expect((await f.manager.read(f.connection)).entries[0]!.state).toBe('source_conflict');
  await f.change('accept_source'); expect(f.starts).toHaveLength(1);
  await f.change('stop', true); await f.change('delete'); await f.restart();
  expect((await f.manager.read(f.connection)).entries).toEqual([]); expect(f.starts).toHaveLength(1);
}, process.platform === 'win32' ? 60_000 : 10_000); // Repeated real DACL/owner checks invoke Windows security APIs.

it('keeps a healthy live entry through failed edits, and cancels only the original pending enable', async () => {
  const f = await fixture(); await f.manager.attach(f.runtime); await f.save().result; await f.change('start');
  const active = (await f.manager.read(f.connection)).entries[0]!;
  await expect(f.save({ arbitraryExecutable: 'run-me' }, 'iroh', 'relay', active.revision).result).rejects.toThrow('invalid_configuration');
  expect(f.closes).toHaveLength(0); await f.change('stop', true);
  vi.mocked(f.runtime.start).mockImplementationOnce(async (_record, _material, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
  const row = (await f.manager.read(f.connection)).entries[0]!;
  await f.manager.change(f.connection, create(ChangeServerAccessEntryRequestSchema, { requestId: randomUUID(), entryId: row.entryId, expectedRevision: row.revision, action: 'start' }));
  await f.change('stop', true); expect((await f.manager.read(f.connection)).entries[0]).toMatchObject({ enabled: false, state: 'stopped' });
});

it('detects changed credentials in an adopted deployment file reference without replacing the live entry', async () => {
  const f = await fixture(true), secretPath = join(f.root, 'relay-issuer');
  await writePrivateFixture(secretPath, 'original-issuer');
  await writePrivateFixture(f.config.linkspan!.deploymentPath!, JSON.stringify([{ id: 'entrance', connector: { provider: 'iroh', secretKeyHex: 'a'.repeat(64),
    relayUrls: ['https://relay.example'], servicesApiSecretPath: secretPath, invitationDirectory: join(f.root, 'invitations') } }]));
  await f.manager.attach(f.runtime); await vi.waitFor(() => expect(f.starts).toHaveLength(1)); await f.change('adopt');
  await writeFile(secretPath, 'rotated-issuer', { mode: 0o600 });
  expect((await f.manager.read(f.connection)).entries[0]!.state).toBe('source_conflict');
  await f.change('accept_source'); await f.change('stop', true); await f.change('start');
  expect(f.starts[1]!.fields['servicesApiSecret']).toBe('original-issuer');
}, process.platform === 'win32' ? 60_000 : 10_000);

it.each(['funnel', 'netbird'] as const)('retains the private %s state directory through takeover, edits, application and restart', async provider => {
  const f = await fixture(true), stateDirectory = join(f.root, 'original-provider-state');
  const prepare = deployment.prepareLinkspanDeployment;
  vi.spyOn(deployment, 'prepareLinkspanDeployment').mockImplementation((value, options) => prepare(value, { ...options, resolveRuntime: false }));
  const connector = provider === 'funnel' ? { provider, mode: 'http', hostname: 'node.example', authKey: 'publisher-secret', port: 443 }
    : { provider, mode: 'http', managementUrl: 'https://management.example', setupKey: 'publisher-secret', resourceId: 'owned-proxy', listenPort: 4318, publicOrigin: 'https://node.example' };
  await writePrivateFixture(f.config.linkspan!.deploymentPath!, JSON.stringify([{ id: 'entrance', connector: { ...connector, stateDirectory,
    budget: { paidEnabled: false, maximumSessionMs: 60000, maximumBytes: 1_048_576 } } }]));
  await f.manager.attach(f.runtime); await vi.waitFor(() => expect(f.starts).toHaveLength(1));
  await f.change('adopt');
  let row = (await f.manager.read(f.connection)).entries[0]!;
  await f.save({ ...row.fields, maximumSessionMinutes: '2' }, provider, 'http', row.revision).result;
  await f.restart(); await vi.waitFor(() => expect(f.starts).toHaveLength(2));
  expect((await configuration.accessDeployment(f.config, 'entrance', provider, 'http', f.starts[1]!)).connector).toMatchObject({ stateDirectory });
  await f.change('stop', true); await f.change('start');
  expect(f.starts[2]).toMatchObject({ providerStateDirectory: stateDirectory });
  expect((await configuration.accessDeployment(f.config, 'entrance', provider, 'http', f.starts[2]!)).connector).toMatchObject({ stateDirectory, budget: { maximumSessionMs: 120000 } });
  row = (await f.manager.read(f.connection)).entries[0]!;
  await expect(f.save({ ...row.fields, stateDirectory: join(f.root, 'other') }, provider, 'http', row.revision).result).rejects.toThrow('invalid_configuration');
  await f.save({ ...row.fields, maximumSessionMinutes: '3' }, provider, 'http', row.revision).result;
  await f.change('stop', true); await f.change('start');
  expect((await configuration.accessDeployment(f.config, 'entrance', provider, 'http', f.starts[3]!)).connector).toMatchObject({ stateDirectory, budget: { maximumSessionMs: 180000 } });
  const publicState = JSON.stringify(await f.manager.read(f.connection));
  expect(publicState).not.toContain(stateDirectory); expect(publicState).not.toContain('publisher-secret');
}, process.platform === 'win32' ? 60_000 : 10_000);

it.each([
  ['authentication_failed', 'authentication_failed'], ['identity_mismatch', 'identity_mismatch'],
  ['transport_error', 'provider_failed'], ['outcome_unknown', 'query_original_operation'],
  ['explicit_adoption_required', 'resource_adoption_required']
])('reports a resource check %s in the current entry and original operation receipt', async (code, issue) => {
  const f = await fixture(); await f.manager.attach(f.runtime);
  await f.save({ resourceMode: 'managed', accountId: 'a'.repeat(32), publicOrigin: 'https://node.example', apiToken: 'publisher-private' }, 'cloudflare', 'named').result;
  vi.mocked(f.runtime.resource).mockResolvedValueOnce({ entryId: 'entrance', provider: 'cloudflare', state: 'active', resourceId: 'original', code });
  const result = await f.change('resource_status');
  expect(result.result).toMatchObject({ operationState: 'completed', operationIssue: issue, operationEntry: { issue, resourceState: 'active' } });
  expect(result.result.entries[0]).toMatchObject({ issue, resourceState: 'active' });
  vi.mocked(f.runtime.resource).mockResolvedValueOnce({ entryId: 'entrance', provider: 'cloudflare', state: 'active', resourceId: 'original' });
  const recovered = await f.change('resource_status');
  expect(recovered.result).toMatchObject({ operationIssue: '', operationEntry: { issue: '' } });
  expect((await f.manager.read(f.connection, result.input.requestId)).operationIssue).toBe(issue);
});

it('retains an adopted fixed iroh relay lease privately through editing and restart without renewing its expiry', async () => {
  const f = await fixture(true), relayToken = 'original-private-lease', relayTokenExpiresAt = Date.now() + 60_000;
  await writePrivateFixture(f.config.linkspan!.deploymentPath!, JSON.stringify([{ id: 'entrance', connector: { provider: 'iroh', secretKeyHex: 'a'.repeat(64),
    relayUrls: ['https://relay.example'], relayToken, relayTokenExpiresAt, invitationDirectory: join(f.root, 'invitations') } }]));
  await f.manager.attach(f.runtime); await vi.waitFor(() => expect(f.starts).toHaveLength(1)); await f.change('adopt');
  const row = (await f.manager.read(f.connection)).entries[0]!;
  await f.save({ ...row.fields, relayLeaseTtlSeconds: '7200' }, 'iroh', 'relay', row.revision).result;
  await f.restart(); await vi.waitFor(() => expect(f.starts).toHaveLength(2));
  await f.change('stop', true); await f.change('start');
  const entry = await configuration.accessDeployment(f.config, 'entrance', 'iroh', 'relay', f.starts[2]!);
  expect(entry.connector).toMatchObject({ relayToken, relayTokenExpiresAt, secretKeyHex: 'a'.repeat(64) });
  expect(JSON.stringify(await f.manager.read(f.connection))).not.toContain(relayToken);
  expect(await readFile(join(f.root, 'records.json'), 'utf8')).not.toContain(relayToken);
}, process.platform === 'win32' ? 60_000 : 10_000);

async function writePrivateFixture(path: string, content: string): Promise<void> {
  if (process.platform === 'win32') {
    await windowsPrivateFixture(path, false);
    await writeFile(path, content, { flag: 'r+' });
  } else await writeFile(path, content, { mode: 0o600, flag: 'wx' });
}

// Match the existing service-device-peer fixture: elevated Windows runners
// require explicit owner selection as well as an owner-only protected DACL.
async function windowsPrivateFixture(path: string, directory: boolean): Promise<void> {
  await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference = 'Stop'; $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User; " +
    (directory
      ? "$acl = New-Object System.Security.AccessControl.DirectorySecurity; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true, $false); " +
        "$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))); " +
        "[System.IO.Directory]::SetAccessControl($env:JOKO_ACCESS_FIXTURE, $acl)"
      : "$acl = New-Object System.Security.AccessControl.FileSecurity; $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true, $false); " +
        "$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow'))); " +
        "$file = [System.IO.FileStream]::new($env:JOKO_ACCESS_FIXTURE, [System.IO.FileMode]::CreateNew, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.IO.FileShare]::ReadWrite, 4096, [System.IO.FileOptions]::None, $acl); $file.Dispose()")
  ], { windowsHide: true, env: { ...process.env, JOKO_ACCESS_FIXTURE: path } });
}
