import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OperationalStore } from '@joko/store';
import { LinkspanError } from '@jokoagent/linkspan-core';
import { afterEach, expect, it, vi } from 'vitest';
import type { CloudflareNamedResource } from '@jokoagent/linkspan-cloudflare';
import type { DevTunnelResource } from '@jokoagent/linkspan-dev-tunnels';
import type { NetbirdPublicResource } from '@jokoagent/linkspan-connectors/netbird';
import { CredentialManager } from './credential-manager.js';
import { CredentialVault } from './credential-vault.js';
import { linkspanMediaUdpEntryId } from './linkspan-deployment.js';
import type { OrchestratorConfig } from './config.js';
import { manageLinkspanResource, reserveManagedLinkspanResourceCredentials, resolveManagedLinkspanConnector, resolveManagedLinkspanDatagram, type LinkspanResourceManagerDependencies, type LinkspanResourceManagement } from './linkspan-resource-manager.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const secret = Buffer.alloc(32, 7).toString('base64');
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'joko-linkspan-resources-'));
  const workspace = join(root, 'workspace'); await mkdir(workspace); await writeFile(join(root, 'token'), 'publisher-private-token', { mode: 0o600 });
  const store = new OperationalStore(':memory:');
  const credentials = new CredentialManager({ vault: await CredentialVault.open(join(root, 'master.key')), storagePath: join(root, 'records.json') });
  await credentials.initialize();
  const app = { store, credentials, config: { workspace: { root: workspace } } as OrchestratorConfig };
  cleanups.push(async () => { store.close(); if (join(tmpdir(), 'joko-linkspan-resources-') === root || !root.startsWith(join(tmpdir(), 'joko-linkspan-resources-'))) throw new Error('Unsafe fixture path'); await rm(root, { recursive: true, force: true }); });
  const configuration: LinkspanResourceManagement = { provider: 'cloudflare', accountId: 'a'.repeat(32), tokenPath: join(root, 'token') };
  let remote: CloudflareNamedResource | undefined;
  const cloudflare: NonNullable<LinkspanResourceManagerDependencies['cloudflare']> = {
    createNamedTunnelSecret: () => secret,
    findNamedTunnel: vi.fn(async options => {
      if (!remote) return null;
      if (options.expectedResource && options.expectedResource.tunnelId !== remote.tunnelId) throw new LinkspanError('identity_mismatch', 'changed');
      return options.expectedResource ? remote : { ...remote, createdByHost: false as const };
    }),
    createNamedTunnel: vi.fn(async options => {
      const record = store.listSettingsByKeyPrefix('service', 'orchestrator', 'runtime.linkspan.resource.')[0]!.value as { requestId: string; reference: string; state: string };
      expect(record.state).toBe('creating'); expect(store.getOperation(record.requestId).status).toBe('started');
      expect(credentials.resolve(record.reference)).toContain(secret);
      remote = { requestId: options.requestId, accountId: options.accountId, tunnelId: '00000000-0000-4000-8000-000000000001', name: `linkspan-${createHash('sha256').update(options.requestId).digest('hex').slice(0, 40)}`, createdByHost: true };
      return { resource: remote, tunnelSecret: options.tunnelSecret };
    }),
    deleteNamedTunnel: vi.fn(async options => { expect(options.resource).toEqual(remote); remote = undefined; })
  };
  const dependencies = { cloudflare, readToken: vi.fn(async () => 'publisher-private-token') };
  return { root, workspace, app, configuration, dependencies, cloudflare, get remote() { return remote; }, set remote(value: CloudflareNamedResource | undefined) { remote = value; } };
}

it('uses a reserved GUI Vault revision for the original managed resource without creating a plaintext token file', async () => {
  const f = await fixture(), reference = `server.access:${randomUUID()}`;
  f.app.credentials.reserveManagedSecret({ credentialReferenceId: reference, kind: 'header_secret', providerId: 'server.access' });
  await f.app.credentials.compareAndSetManagedSecret({ credentialReferenceId: reference, expectedSecret: undefined,
    secret: JSON.stringify({ fields: { apiToken: 'gui-private-token' } }), displayName: 'Server access', kind: 'header_secret', providerId: 'server.access' });
  const configuration = { provider: 'cloudflare' as const, accountId: 'a'.repeat(32), credentialReferenceId: reference };
  const created = await manageLinkspanResource(f.app, { action: 'create', entryId: 'from-gui', configuration }, f.dependencies);
  expect(created.state).toBe('active'); expect(f.dependencies.readToken).not.toHaveBeenCalled();
  expect(f.cloudflare.createNamedTunnel).toHaveBeenCalledWith(expect.objectContaining({ apiToken: 'gui-private-token' }));
  await manageLinkspanResource(f.app, { action: 'status', entryId: 'from-gui', configuration }, f.dependencies);
  await manageLinkspanResource(f.app, { action: 'delete', entryId: 'from-gui', configuration, confirmResourceId: created.resourceId! }, f.dependencies);
  expect(f.cloudflare.createNamedTunnel).toHaveBeenCalledOnce(); expect(f.cloudflare.deleteNamedTunnel).toHaveBeenCalledOnce();
  expect(f.app.credentials.list()).toEqual([]);
});

it('journals a stable operation and saves the named-tunnel secret before creating, then opens only private owned material', async () => {
  const f = await fixture();
  const created = await manageLinkspanResource(f.app, { action: 'create', entryId: 'named', configuration: f.configuration }, f.dependencies);
  expect(created).toMatchObject({ state: 'active', resourceId: f.remote?.tunnelId, requiresDns: true });
  expect(JSON.stringify(created)).not.toContain(secret);
  const publicFacts = JSON.stringify(f.app.store.listSettings(), (_key, value) => typeof value === 'bigint' ? value.toString() : value);
  expect(publicFacts).not.toContain(secret); expect(publicFacts).not.toContain('publisher-private-token'); expect(publicFacts).not.toContain(f.remote!.tunnelId);
  expect(await readFile(join(f.root, 'records.json'), 'utf8')).not.toContain(secret);
  const connector = await resolveManagedLinkspanConnector(f.app, { entryId: 'named', connector: { provider: 'cloudflare', mode: 'named', publicOrigin: 'https://named.example' } }, f.dependencies);
  expect(connector).toMatchObject({ tunnelId: f.remote!.tunnelId, tunnelSecret: secret });
  await manageLinkspanResource(f.app, { action: 'create', entryId: 'named', configuration: f.configuration }, f.dependencies);
  expect(f.cloudflare.createNamedTunnel).toHaveBeenCalledOnce();
  const external = { provider: 'cloudflare', tunnelId: 'user-owned-external', tunnelSecret: 'external-secret' };
  await expect(resolveManagedLinkspanConnector(f.app, { entryId: 'outside', connector: external }, f.dependencies)).resolves.toBe(external);
});

it('queries an uncertain creation without recreating or deleting a candidate until its exact ID is explicitly adopted', async () => {
  const f = await fixture(), create = f.cloudflare.createNamedTunnel;
  f.cloudflare.createNamedTunnel = vi.fn(async options => { await create(options); throw new LinkspanError('outcome_unknown', 'must not display private upstream text', { outcome: 'unknown' }); });
  const first = await manageLinkspanResource(f.app, { action: 'create', entryId: 'uncertain', configuration: f.configuration }, f.dependencies);
  expect(first.state).toBe('outcome_unknown');
  const candidate = await manageLinkspanResource(f.app, { action: 'create', entryId: 'uncertain', configuration: f.configuration }, f.dependencies);
  expect(candidate).toMatchObject({ state: 'outcome_unknown', needsAdoption: true, resourceId: f.remote!.tunnelId });
  await manageLinkspanResource(f.app, { action: 'delete', entryId: 'uncertain', configuration: f.configuration }, f.dependencies);
  expect(f.cloudflare.createNamedTunnel).toHaveBeenCalledOnce(); expect(f.cloudflare.deleteNamedTunnel).not.toHaveBeenCalled();
  await expect(manageLinkspanResource(f.app, { action: 'adopt', entryId: 'uncertain', configuration: f.configuration, confirmResourceId: 'different-resource' }, f.dependencies)).rejects.toThrow(/exact/u);
  const adopted = await manageLinkspanResource(f.app, { action: 'adopt', entryId: 'uncertain', configuration: f.configuration, confirmResourceId: candidate.resourceId }, f.dependencies);
  expect(adopted.state).toBe('active');
  expect(f.app.store.getOperation(first.requestId!).status).toBe('completed');
  const deleted = await manageLinkspanResource(f.app, { action: 'delete', entryId: 'uncertain', configuration: f.configuration }, f.dependencies);
  expect(deleted.state).toBe('deleted'); expect(f.cloudflare.deleteNamedTunnel).toHaveBeenCalledOnce();
  expect(f.app.credentials.list({ providerId: 'linkspan.resource.cloudflare' })).toEqual([]);
});

it('reconciles an unconfirmed deletion by querying the original exact handle rather than repeating a mutation', async () => {
  const f = await fixture();
  await manageLinkspanResource(f.app, { action: 'create', entryId: 'retire', configuration: f.configuration }, f.dependencies);
  f.cloudflare.deleteNamedTunnel = vi.fn(async () => { f.remote = undefined; throw new LinkspanError('outcome_unknown', 'connection lost', { outcome: 'unknown' }); });
  expect((await manageLinkspanResource(f.app, { action: 'delete', entryId: 'retire', configuration: f.configuration }, f.dependencies)).state).toBe('deleting');
  reserveManagedLinkspanResourceCredentials(f.app);
  const reconciled = await manageLinkspanResource(f.app, { action: 'status', entryId: 'retire', configuration: f.configuration }, f.dependencies);
  expect(reconciled.state).toBe('deleted'); expect(f.cloudflare.deleteNamedTunnel).toHaveBeenCalledOnce();
});

it('rejects changed resource inputs, unowned adoption and token paths inside a workspace without provider effects', async () => {
  const f = await fixture();
  await expect(manageLinkspanResource(f.app, { action: 'adopt', entryId: 'new', configuration: f.configuration, confirmResourceId: 'remote' }, f.dependencies)).rejects.toThrow(/original/u);
  await writeFile(join(f.workspace, 'token'), 'private');
  await expect(manageLinkspanResource(f.app, { action: 'create', entryId: 'inside', configuration: { ...f.configuration, tokenPath: join(f.workspace, 'token') } }, f.dependencies)).rejects.toThrow(/outside/u);
  expect(f.cloudflare.createNamedTunnel).not.toHaveBeenCalled();
  await manageLinkspanResource(f.app, { action: 'create', entryId: 'fixed', configuration: f.configuration }, f.dependencies);
  await expect(manageLinkspanResource(f.app, { action: 'delete', entryId: 'fixed', configuration: { ...f.configuration, accountId: 'b'.repeat(32) } }, f.dependencies)).rejects.toThrow(/original/u);
  expect(f.cloudflare.deleteNamedTunnel).not.toHaveBeenCalled();
});

it.each(['deleted', 'rejected'] as const)('creates a new exact operation for changed resource ownership only after %s', async phase => {
  const f = await fixture();
  if (phase === 'rejected') vi.mocked(f.cloudflare.createNamedTunnel).mockRejectedValueOnce(new LinkspanError('authentication_failed', 'private provider response'));
  const original = await manageLinkspanResource(f.app, { action: 'create', entryId: 'replace', configuration: f.configuration }, f.dependencies);
  const oldJournal = f.app.store.listSettingsByKeyPrefix('service', 'orchestrator', 'runtime.linkspan.resource.')[0]!.value as { reference: string };
  if (phase === 'deleted') await manageLinkspanResource(f.app, { action: 'delete', entryId: 'replace', configuration: f.configuration }, f.dependencies);
  const changed = { ...f.configuration, accountId: 'b'.repeat(32) };
  await expect(manageLinkspanResource(f.app, { action: 'status', entryId: 'replace', configuration: changed }, f.dependencies)).rejects.toThrow(/original/u);
  const created = await manageLinkspanResource(f.app, { action: 'create', entryId: 'replace', configuration: changed }, f.dependencies);
  expect(created.state).toBe('active'); expect(created.requestId).not.toBe(original.requestId);
  expect(f.app.store.getOperation(original.requestId!).status).toBe('completed');
  expect(f.app.credentials.find(oldJournal.reference)).toBeUndefined();
  expect(f.cloudflare.createNamedTunnel).toHaveBeenLastCalledWith(expect.objectContaining({ accountId: changed.accountId, requestId: created.requestId }));
  expect(f.cloudflare.createNamedTunnel).toHaveBeenCalledTimes(2);
  await expect(manageLinkspanResource(f.app, { action: 'create', entryId: 'replace', configuration: f.configuration }, f.dependencies)).rejects.toThrow(/original/u);
  expect(f.cloudflare.createNamedTunnel).toHaveBeenCalledTimes(2);
});

it('opens the known Dev Tunnel material through an exact-ID read and never copies its host token to public facts', async () => {
  const f = await fixture();
  const configuration: LinkspanResourceManagement = { provider: 'dev-tunnels', clusterId: 'use', port: 4318, tokenPath: join(f.root, 'token'), tokenScheme: 'github' };
  let resource: DevTunnelResource;
  const devTunnels: NonNullable<LinkspanResourceManagerDependencies['devTunnels']> = {
    createDevTunnel: vi.fn(async options => {
      expect(options.publisherAccessToken).toBe('github publisher-private-token');
      resource = { tunnelId: 'owned-dev-tunnel', clusterId: options.clusterId, port: options.port, requestId: options.requestId,
        ownershipLabel: `linkspan-${createHash('sha256').update(options.requestId).digest('hex').slice(0, 32)}`, createdByHost: true };
      return { resource, hostAccessToken: 'private-host-token', publicOrigin: 'https://dev.example' };
    }),
    findDevTunnel: vi.fn(async () => resource), deleteDevTunnel: vi.fn(async () => {}),
    getDevTunnelMaterial: vi.fn(async options => { expect(options.resource).toEqual(resource); return { resource, hostAccessToken: 'rotated-private-host-token', publicOrigin: 'https://dev.example' }; })
  };
  const dependencies = { ...f.dependencies, devTunnels };
  const result = await manageLinkspanResource(f.app, { action: 'create', entryId: 'dev', configuration }, dependencies);
  expect(JSON.stringify(result)).not.toContain('private-host-token');
  const connector = await resolveManagedLinkspanConnector(f.app, { entryId: 'dev', connector: { provider: 'dev-tunnels' } }, dependencies);
  expect(connector).toMatchObject({ tunnelId: 'owned-dev-tunnel', clusterId: 'use', port: 4318, hostAccessToken: 'rotated-private-host-token' });
  expect(devTunnels.createDevTunnel).toHaveBeenCalledOnce(); expect(devTunnels.getDevTunnelMaterial).toHaveBeenCalledOnce();
  for (const changed of [{ ...configuration, port: 4320 }, { ...configuration, clusterId: 'euw' }]) {
    await expect(resolveManagedLinkspanConnector(f.app, { entryId: 'dev', connector: { provider: 'dev-tunnels' }, configuration: changed }, dependencies)).rejects.toThrow('original resource configuration');
  }
  expect(devTunnels.getDevTunnelMaterial).toHaveBeenCalledOnce();
  expect(JSON.stringify(f.app.store.listSettings(), (_key, value) => typeof value === 'bigint' ? value.toString() : value)).not.toContain('host-token');
  await expect(resolveManagedLinkspanConnector(f.app, { entryId: 'dev', connector: { provider: 'dev-tunnels', publicOrigin: 'https://other-tunnel.example' } }, dependencies)).rejects.toThrow(/does not match/u);
});

it('keeps the NetBird peer target port separate from an allocated public L4 port', async () => {
  const f = await fixture();
  const configuration: LinkspanResourceManagement = { provider: 'netbird', managementUrl: 'https://management.example', mode: 'tcp', domain: 'proxy.example', peerId: 'connector-peer', targetPort: 4318, listenPort: 0, tokenPath: join(f.root, 'token') };
  let resource: NetbirdPublicResource;
  const netbird: NonNullable<LinkspanResourceManagerDependencies['netbird']> = {
    createNetbirdPublicResource: vi.fn(async options => {
      expect(options.listenPort).toBe(0); expect(options.targetPort).toBe(4318);
      resource = { provider: 'netbird', requestId: options.requestId, managementUrl: options.managementUrl, id: 'owned-proxy', name: `linkspan-${createHash('sha256').update(options.requestId).digest('hex').slice(0, 32)}`, listenPort: 18443, createdByHost: true };
      return resource;
    }),
    findNetbirdPublicResource: vi.fn(async () => resource), deleteNetbirdPublicResource: vi.fn(async () => {})
  };
  const dependencies = { ...f.dependencies, netbird };
  expect((await manageLinkspanResource(f.app, { action: 'create', entryId: 'proxy', configuration }, dependencies)).state).toBe('active');
  const connector = await resolveManagedLinkspanConnector(f.app, { entryId: 'proxy', connector: { provider: 'netbird' } }, dependencies);
  expect(connector).toMatchObject({ resourceId: resource!.id, listenPort: 4318, publicOrigin: 'https://proxy.example:18443', mode: 'tcp' });
  await expect(resolveManagedLinkspanConnector(f.app, { entryId: 'proxy', connector: { provider: 'netbird', listenPort: 18443 } }, dependencies)).rejects.toThrow(/does not match/u);
});

it('resolves UDP media only from its separate exact owned UDP receipt without creating another resource', async () => {
  const f = await fixture();
  const configuration: LinkspanResourceManagement = { provider: 'netbird', managementUrl: 'https://management.example', mode: 'udp', domain: 'media.example', peerId: 'media-peer', targetPort: 54321, listenPort: 0, tokenPath: join(f.root, 'token') };
  let resource: NetbirdPublicResource;
  const netbird: NonNullable<LinkspanResourceManagerDependencies['netbird']> = {
    createNetbirdPublicResource: vi.fn(async options => resource = { provider: 'netbird', requestId: options.requestId, managementUrl: options.managementUrl, id: 'owned-udp-proxy', name: `linkspan-${createHash('sha256').update(options.requestId).digest('hex').slice(0, 32)}`, listenPort: 23456, createdByHost: true }),
    findNetbirdPublicResource: vi.fn(async () => resource), deleteNetbirdPublicResource: vi.fn(async () => {})
  };
  const dependencies = { ...f.dependencies, netbird };
  await expect(resolveManagedLinkspanDatagram(f.app, { entryId: 'media', datagram: { provider: 'netbird' } })).rejects.toThrow(/exact managed UDP/u);
  expect(netbird.createNetbirdPublicResource).not.toHaveBeenCalled();
  const entryId = linkspanMediaUdpEntryId('media');
  await manageLinkspanResource(f.app, { action: 'create', entryId, configuration }, dependencies);
  const datagram = await resolveManagedLinkspanDatagram(f.app, { entryId: 'media', datagram: { provider: 'netbird', setupKey: 'existing-private-setup-key' } });
  expect(datagram).toMatchObject({ resourceId: 'owned-udp-proxy', managementUrl: configuration.managementUrl, publicHost: 'media.example', publicPort: 23456, listenPort: 54321, setupKey: 'existing-private-setup-key' });
  expect(datagram).not.toHaveProperty('publicOrigin');
  await expect(resolveManagedLinkspanDatagram(f.app, { entryId: 'media', datagram: { provider: 'netbird', listenPort: 23456 } })).rejects.toThrow(/does not match/u);
  await expect(resolveManagedLinkspanDatagram(f.app, { entryId: 'media', datagram: { provider: 'netbird', resourceId: 'other-proxy' } })).rejects.toThrow(/does not match/u);
  await expect(resolveManagedLinkspanConnector(f.app, { entryId, connector: { provider: 'netbird' } }, dependencies)).rejects.toThrow(/packet API/u);
  const external = { provider: 'netbird', resourceId: 'user-owned', publicHost: 'external.example', publicPort: 30000, listenPort: 40000 };
  await expect(resolveManagedLinkspanDatagram(f.app, { entryId: 'external', datagram: external })).resolves.toBe(external);
  expect(netbird.createNetbirdPublicResource).toHaveBeenCalledOnce();
});
