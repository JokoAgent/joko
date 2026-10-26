import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LinkspanError } from '@jokoagent/linkspan-core';
import { operationBodyHash, type OperationRecord } from '@joko/store';
import type { CloudflareNamedResource } from '@jokoagent/linkspan-cloudflare';
import type { NetbirdPublicResource } from '@jokoagent/linkspan-connectors/netbird';
import type { DevTunnelResource } from '@jokoagent/linkspan-dev-tunnels';
import type { OrchestratorApplication } from './application.js';
import type { CredentialManager } from './credential-manager.js';
import { readIceToken } from './remote-desktop-ice-configuration.js';
import { linkspanMediaUdpEntryId } from './linkspan-deployment.js';

export type LinkspanResourceManagement =
  | { readonly provider: 'cloudflare'; readonly accountId: string; readonly tokenPath: string }
  | { readonly provider: 'netbird'; readonly managementUrl: string; readonly tokenPath: string; readonly mode: 'http' | 'tls' | 'tcp' | 'udp'; readonly domain: string; readonly peerId: string; readonly targetPort: number; readonly listenPort?: number }
  | { readonly provider: 'dev-tunnels'; readonly tokenPath: string; readonly tokenScheme?: 'Bearer' | 'github'; readonly clusterId: string; readonly port: number };

export interface LinkspanResourceAction {
  readonly action: 'create' | 'status' | 'delete' | 'adopt';
  readonly entryId: string;
  readonly configuration: LinkspanResourceManagement;
  readonly confirmResourceId?: string;
  readonly signal?: AbortSignal;
}
type Application = Pick<OrchestratorApplication, 'config' | 'store' | 'credentials'>;
type Resource = CloudflareNamedResource | NetbirdPublicResource | DevTunnelResource;
type Candidate = Omit<Resource, 'createdByHost'> & { readonly createdByHost: false };
type Phase = 'preparing' | 'creating' | 'active' | 'outcome_unknown' | 'deleting' | 'deleted' | 'rejected';
interface RecordState {
  readonly entryId: string;
  readonly provider: LinkspanResourceManagement['provider'];
  readonly requestId: string;
  readonly configurationHash: string;
  readonly reference: string;
  readonly state: Phase;
}
interface PrivateMaterial {
  readonly requestId: string;
  readonly entryId: string;
  readonly configuration: LinkspanResourceManagement;
  readonly resource?: Resource;
  readonly candidate?: unknown;
  readonly tunnelSecret?: string;
  readonly hostAccessToken?: string;
  readonly publicOrigin?: string;
}
export interface ManagedLinkspanResourceView {
  readonly entryId: string;
  readonly provider: LinkspanResourceManagement['provider'];
  readonly state: Phase | 'not_created';
  readonly requestId?: string;
  /** An exact ID is shown for an explicit adopt decision; handles stay private. */
  readonly resourceId?: string;
  readonly needsAdoption?: boolean;
  readonly publicOrigin?: string;
  readonly requiresDns?: boolean;
  readonly code?: string;
}
export interface LinkspanResourceManagerDependencies {
  readonly readToken?: (path: string, signal: AbortSignal) => Promise<string>;
  readonly cloudflare?: Pick<typeof import('@jokoagent/linkspan-cloudflare'), 'createNamedTunnelSecret' | 'createNamedTunnel' | 'findNamedTunnel' | 'deleteNamedTunnel'>;
  readonly netbird?: Pick<typeof import('@jokoagent/linkspan-connectors/netbird'), 'createNetbirdPublicResource' | 'findNetbirdPublicResource' | 'deleteNetbirdPublicResource'>;
  readonly devTunnels?: Pick<typeof import('@jokoagent/linkspan-dev-tunnels'), 'createDevTunnel' | 'findDevTunnel' | 'deleteDevTunnel' | 'getDevTunnelMaterial'>;
}

const PREFIX = 'runtime.linkspan.resource.';
const actions = new WeakMap<Application['store'], Map<string, Promise<unknown>>>();

/** Reserve service-only secrets before exposing credential management after restart. */
export function reserveManagedLinkspanResourceCredentials(app: Application): void {
  for (const setting of app.store.listSettingsByKeyPrefix('service', 'orchestrator', PREFIX)) {
    const record = setting.value as RecordState;
    validateJournalRecord(app, record);
    if (setting.key !== PREFIX + record.entryId) fail('The original managed Linkspan resource journal is invalid.');
    credentialManager(app, record);
  }
}
function serial<T>(app: Application, entryId: string, work: () => Promise<T>): Promise<T> {
  let entries = actions.get(app.store);
  if (entries === undefined) { entries = new Map(); actions.set(app.store, entries); }
  const result = (entries.get(entryId) ?? Promise.resolve()).then(work, work);
  entries.set(entryId, result);
  void result.finally(() => { if (entries!.get(entryId) === result) entries!.delete(entryId); }).catch(() => {});
  return result;
}
class ResourceManagerError extends Error {}
function fail(message: string): never { throw new ResourceManagerError(message); }
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function identity(configuration: LinkspanResourceManagement): object {
  switch (configuration.provider) {
    case 'cloudflare': return { provider: configuration.provider, accountId: configuration.accountId };
    case 'netbird': return { provider: configuration.provider, managementUrl: configuration.managementUrl, mode: configuration.mode, domain: configuration.domain, peerId: configuration.peerId, targetPort: configuration.targetPort, listenPort: configuration.listenPort };
    case 'dev-tunnels': return { provider: configuration.provider, clusterId: configuration.clusterId, port: configuration.port };
  }
}
function body(record: RecordState): object { return { entryId: record.entryId, provider: record.provider, configurationHash: record.configurationHash, reference: record.reference }; }
function validateJournalRecord(app: Application, record: RecordState): void {
  if (!record || !/^[a-z][a-z0-9-]{0,63}$/u.test(record.entryId) || !['cloudflare', 'netbird', 'dev-tunnels'].includes(record.provider)
    || !/^linkspan-resource:[a-f0-9-]{36}$/u.test(record.requestId) || !/^[a-f0-9]{64}$/u.test(record.configurationHash)
    || record.reference !== `linkspan.resource:${record.requestId}` || !['preparing', 'creating', 'active', 'outcome_unknown', 'deleting', 'deleted', 'rejected'].includes(record.state)) fail('The original managed Linkspan resource journal is invalid.');
  const operation = app.store.findOperation(record.requestId);
  if (operation?.kind !== 'connection.resource.create' || operation.connectionId !== undefined || operation.completionMode !== 'external_effect'
    || operation.bodyHash !== operationBodyHash(body(record))) fail('The original managed Linkspan resource operation does not match its journal.');
}
function claimResourceOperation(app: Application, input: { readonly id: string; readonly kind: string; readonly body: object }): OperationRecord {
  const existing = app.store.findOperation(input.id);
  if (existing === undefined) return app.store.claimDeferredEffectOperation(input).operation;
  if (existing.kind !== input.kind || existing.connectionId !== undefined || existing.completionMode !== 'external_effect'
    || existing.bodyHash !== operationBodyHash(input.body) || existing.status === 'failed') fail('The original resource operation conflicts with this recovery action.');
  return existing;
}
function credentialManager(app: Application, record: RecordState): CredentialManager {
  const credentials = app.credentials;
  if (credentials === undefined) return fail('Protected Linkspan resource storage is unavailable.');
  credentials.reserveManagedSecret({ credentialReferenceId: record.reference, kind: 'header_secret', providerId: `linkspan.resource.${record.provider}` });
  return credentials;
}
function material(app: Application, record: RecordState): PrivateMaterial | undefined {
  const credentials = credentialManager(app, record);
  if (credentials.find(record.reference) === undefined) return undefined;
  let value: PrivateMaterial;
  try { value = JSON.parse(credentials.resolve(record.reference)) as PrivateMaterial; } catch { return fail('The protected Linkspan resource record could not be read.'); }
  if (!value || value.entryId !== record.entryId || value.requestId !== record.requestId || hash(identity(value.configuration)) !== record.configurationHash) return fail('The protected Linkspan resource record does not match its original operation.');
  if (record.provider === 'cloudflare' && (typeof value.tunnelSecret !== 'string' || !/^[A-Za-z0-9+/]{43}=$/u.test(value.tunnelSecret))) return fail('Restore the original protected named-tunnel secret before continuing.');
  return value;
}
async function saveMaterial(app: Application, record: RecordState, value: PrivateMaterial): Promise<void> {
  const credentials = credentialManager(app, record);
  const previous = credentials.find(record.reference) === undefined ? undefined : credentials.resolve(record.reference);
  if (!await credentials.compareAndSetManagedSecret({ credentialReferenceId: record.reference, expectedSecret: previous, secret: JSON.stringify(value),
    displayName: 'Managed connection resource', kind: 'header_secret', providerId: `linkspan.resource.${record.provider}` })) fail('The protected Linkspan resource changed. Reconcile the original operation before retrying.');
}
function recordState(app: Application, record: RecordState, state: Phase): RecordState {
  const next = { ...record, state }; app.store.setSetting('service', 'orchestrator', PREFIX + record.entryId, next); return next;
}
function finishCreate(app: Application, record: RecordState): void {
  const operation = app.store.findOperation(record.requestId);
  if (operation?.status !== 'completed') {
    if (operation === undefined || operation.kind !== 'connection.resource.create') fail('The original Linkspan resource operation is unavailable.');
    app.store.completeDeferredEffectOperation(record.requestId, operation.bodyHash, () => {
      recordState(app, record, 'active'); return { state: 'active', reference: record.reference };
    });
  } else recordState(app, record, 'active');
}
function finishRetiredCreate(app: Application, record: RecordState): void {
  const operation = app.store.findOperation(record.requestId);
  if (operation?.status === 'started') app.store.completeDeferredEffectOperation(record.requestId, operation.bodyHash, () => ({ state: 'closed', reason: 'owned_resource_retired', reference: record.reference }));
}
function finishAdoption(app: Application, record: RecordState, resource: Resource): void {
  const id = `${record.requestId}:adopt`;
  if (app.store.findOperation(id) === undefined) return;
  const operation = claimResourceOperation(app, { id, kind: 'connection.resource.adopt', body: { createRequestId: record.requestId, resourceIdHash: hash(resourceId(resource)) } });
  if (operation.status === 'started') app.store.completeDeferredEffectOperation(id, operation.bodyHash, () => ({ state: 'adopted', reference: record.reference }));
}
function resourceId(resource: unknown): string {
  if (!resource || typeof resource !== 'object') return fail('The resource identity is invalid.');
  const value = resource as { tunnelId?: unknown; id?: unknown };
  const id = value.tunnelId ?? value.id;
  if (typeof id !== 'string' || id.length < 1 || id.length > 256 || /[\u0000-\u0020\u007f]/u.test(id)) return fail('The resource identity is invalid.');
  return id;
}
function assertOwned(record: RecordState, configuration: LinkspanResourceManagement, resource: Resource): void {
  if (resource.createdByHost !== true || resource.requestId !== record.requestId) fail('Only the exact original host-owned resource may be used.');
  resourceId(resource);
  const digest = createHash('sha256').update(record.requestId).digest('hex');
  if (configuration.provider === 'cloudflare') {
    const value = resource as CloudflareNamedResource;
    if (value.accountId !== configuration.accountId || value.name !== `linkspan-${digest.slice(0, 40)}`) fail('The named tunnel does not match its original owner.');
  } else if (configuration.provider === 'netbird') {
    const value = resource as NetbirdPublicResource;
    if (value.provider !== 'netbird' || value.managementUrl !== configuration.managementUrl || value.name !== `linkspan-${digest.slice(0, 32)}`) fail('The proxy does not match its original owner.');
  } else {
    const value = resource as DevTunnelResource;
    if (value.clusterId !== configuration.clusterId || value.port !== configuration.port || value.ownershipLabel !== `linkspan-${digest.slice(0, 32)}`) fail('The Dev Tunnel does not match its original owner.');
  }
}
function view(record: RecordState, value?: PrivateMaterial, code?: string): ManagedLinkspanResourceView {
  const resource = value?.resource ?? value?.candidate;
  return { entryId: record.entryId, provider: record.provider, state: record.state, requestId: record.requestId,
    ...(resource === undefined ? {} : { resourceId: resourceId(resource) }),
    ...(value?.resource === undefined && value?.candidate !== undefined ? { needsAdoption: true } : {}),
    ...(value?.publicOrigin === undefined ? {} : { publicOrigin: value.publicOrigin }),
    ...(record.provider === 'cloudflare' ? { requiresDns: true } : {}), ...(code === undefined ? {} : { code }) };
}

function assertDevMaterial(record: RecordState, value: PrivateMaterial, originalId?: string): void {
  if (value.configuration.provider !== 'dev-tunnels') return;
  if (value.resource === undefined) fail('The original Dev Tunnel material has no exact resource receipt.');
  assertOwned(record, value.configuration, value.resource);
  if (originalId !== undefined && resourceId(value.resource) !== originalId) fail('The refreshed Dev Tunnel material belongs to a different resource.');
  if (typeof value.hostAccessToken !== 'string' || value.hostAccessToken.length < 1 || value.hostAccessToken.length > 8192 || /[\u0000-\u0020\u007f]/u.test(value.hostAccessToken)
    || typeof value.publicOrigin !== 'string' || value.publicOrigin.length > 2048) fail('The private Dev Tunnel connection material is invalid.');
  const url = new URL(value.publicOrigin);
  if (url.protocol !== 'https:' || url.origin !== value.publicOrigin || url.username || url.password) fail('The managed Dev Tunnel public origin is invalid.');
}

async function validateConfiguration(app: Application, value: LinkspanResourceManagement, requireTokenFile = true): Promise<void> {
  if (!value || typeof value !== 'object' || !['cloudflare', 'netbird', 'dev-tunnels'].includes(value.provider) || !isAbsolute(value.tokenPath)) fail('Select a supported resource provider and an absolute private token file.');
  const fields = value.provider === 'cloudflare' ? ['provider', 'accountId', 'tokenPath'] : value.provider === 'netbird'
    ? ['provider', 'managementUrl', 'tokenPath', 'mode', 'domain', 'peerId', 'targetPort', 'listenPort'] : ['provider', 'tokenPath', 'tokenScheme', 'clusterId', 'port'];
  if (Object.keys(value).some(key => !fields.includes(key))) fail('The resource management configuration contains unsupported fields.');
  const port = (number: unknown) => Number.isSafeInteger(number) && Number(number) > 0 && Number(number) <= 65535;
  if (value.provider === 'cloudflare') {
    if (!/^[a-f0-9]{32}$/u.test(value.accountId)) fail('The publisher account is invalid.');
  } else if (value.provider === 'netbird') {
    const url = new URL(value.managementUrl);
    if (url.protocol !== 'https:' || url.origin !== value.managementUrl || !['http', 'tls', 'tcp', 'udp'].includes(value.mode)
      || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/u.test(value.domain) || !/^[A-Za-z0-9._:-]{1,128}$/u.test(value.peerId)
      || !port(value.targetPort) || value.listenPort !== undefined && value.listenPort !== 0 && !port(value.listenPort)) fail('The public proxy configuration is invalid.');
  } else if (!/^[A-Za-z0-9-]{1,64}$/u.test(value.clusterId) || !port(value.port) || value.tokenScheme !== undefined && !['Bearer', 'github'].includes(value.tokenScheme)) fail('The Dev Tunnel configuration is invalid.');
  if (!requireTokenFile) return;
  const token = await realpath(value.tokenPath);
  const roots = await Promise.all([app.config.workspace.root, fileURLToPath(new URL('../../../', import.meta.url))].map(root => realpath(root)));
  for (const start of [process.cwd(), dirname(fileURLToPath(import.meta.url))]) {
    let current = resolve(start);
    for (;;) {
      if (existsSync(join(current, 'pnpm-workspace.yaml')) && existsSync(join(current, 'apps/orchestrator/package.json'))) { roots.push(await realpath(current)); break; }
      const parent = dirname(current); if (parent === current) break; current = parent;
    }
  }
  if (roots.some(root => { const child = relative(root, token); return child === '' || child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child); })) fail('Resource tokens must stay outside Joko source and workspace roots.');
}

async function provider(record: RecordState, value: PrivateMaterial, signal: AbortSignal, dependencies: LinkspanResourceManagerDependencies) {
  const configuration = value.configuration;
  const token = await (dependencies.readToken ?? readIceToken)(configuration.tokenPath, signal);
  const common = { requestId: record.requestId, signal, deadline: Date.now() + 15_000 };
  if (configuration.provider === 'cloudflare') {
    const sdk = dependencies.cloudflare ?? await import('@jokoagent/linkspan-cloudflare');
    const options = { ...common, accountId: configuration.accountId, apiToken: token,
      ...(value.resource === undefined ? {} : { expectedResource: value.resource as CloudflareNamedResource }) };
    return { find: () => sdk.findNamedTunnel(options),
      create: async (): Promise<PrivateMaterial> => ({ ...value, ...await sdk.createNamedTunnel({ ...options, tunnelSecret: value.tunnelSecret! }) }),
      remove: () => sdk.deleteNamedTunnel({ ...options, resource: value.resource as CloudflareNamedResource }),
      open: async (): Promise<PrivateMaterial> => value };
  }
  if (configuration.provider === 'netbird') {
    const sdk = dependencies.netbird ?? await import('@jokoagent/linkspan-connectors/netbird');
    const { tokenPath: _tokenPath, provider: _provider, ...selected } = configuration;
    const options = { ...common, ...selected, apiToken: token, ...(value.resource === undefined ? {} : { expectedResource: value.resource as NetbirdPublicResource }) };
    return { find: () => sdk.findNetbirdPublicResource(options), create: async (): Promise<PrivateMaterial> => ({ ...value, resource: await sdk.createNetbirdPublicResource(options) }),
      remove: () => sdk.deleteNetbirdPublicResource({ ...options, resource: value.resource as NetbirdPublicResource }), open: async (): Promise<PrivateMaterial> => value };
  }
  const sdk = dependencies.devTunnels ?? await import('@jokoagent/linkspan-dev-tunnels');
  const options = { ...common, publisherAccessToken: `${configuration.tokenScheme ?? 'Bearer'} ${token}`, clusterId: configuration.clusterId, port: configuration.port,
    ...(value.resource === undefined ? {} : { expectedResource: value.resource as DevTunnelResource }) };
  return { find: () => sdk.findDevTunnel(options), create: async (): Promise<PrivateMaterial> => ({ ...value, ...await sdk.createDevTunnel(options) }),
    remove: () => sdk.deleteDevTunnel({ ...options, resource: value.resource as DevTunnelResource }),
    open: async (): Promise<PrivateMaterial> => ({ ...value, ...await sdk.getDevTunnelMaterial({ ...options, resource: value.resource as DevTunnelResource }) }) };
}

/** CLI actions operate only this host's original ledger and protected resource handles. */
export async function manageLinkspanResource(app: Application, input: LinkspanResourceAction, dependencies: LinkspanResourceManagerDependencies = {}): Promise<ManagedLinkspanResourceView> {
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(input.entryId) || !['create', 'status', 'delete', 'adopt'].includes(input.action)) fail('Select a valid managed connection entry and resource action.');
  return serial(app, input.entryId, async () => {
    const signal = input.signal ?? AbortSignal.timeout(60_000); signal.throwIfAborted();
    let record = app.store.findSetting<RecordState>('service', 'orchestrator', PREFIX + input.entryId)?.value;
    if (record !== undefined) validateJournalRecord(app, record);
    await validateConfiguration(app, input.configuration, input.action === 'create' || record !== undefined && ['creating', 'active', 'outcome_unknown', 'deleting'].includes(record.state));
    const configurationHash = hash(identity(input.configuration));
    if (record !== undefined && (record.entryId !== input.entryId || record.provider !== input.configuration.provider || record.configurationHash !== configurationHash)) fail('Restore the original resource configuration before reconciling this entry.');
    if (record === undefined || input.action === 'create' && ['deleted', 'rejected'].includes(record.state)) {
      if (input.action !== 'create') {
        if (input.action === 'adopt') fail('Adoption requires this host\'s original uncertain creation operation.');
        return { entryId: input.entryId, provider: input.configuration.provider, state: 'not_created' as const };
      }
      if (record !== undefined) await credentialManager(app, record).deleteManagedSecret(record.reference);
      const requestId = `linkspan-resource:${randomUUID()}`;
      record = { entryId: input.entryId, provider: input.configuration.provider, requestId, configurationHash, reference: `linkspan.resource:${requestId}`, state: 'preparing' };
      const created = record;
      app.store.claimDeferredEffectOperation({ id: requestId, kind: 'connection.resource.create', body: body(created) }, () => recordState(app, created, 'preparing'));
    }
    const original = app.store.findOperation(record.requestId);
    if (original === undefined || original.kind !== 'connection.resource.create') fail('The original Linkspan creation operation is unavailable.');
    claimResourceOperation(app, { id: record.requestId, kind: 'connection.resource.create', body: body(record) });
    let value = material(app, record);
    if (record.state === 'deleted') { finishRetiredCreate(app, record); await credentialManager(app, record).deleteManagedSecret(record.reference); return view(record); }
    if (['preparing', 'rejected'].includes(record.state) && input.action === 'delete') {
      record = recordState(app, record, 'deleted'); finishRetiredCreate(app, record);
      await credentialManager(app, record).deleteManagedSecret(record.reference); return view(record);
    }
    if (value === undefined) {
      if (record.state === 'preparing' && input.action === 'status') return view(record);
      if (record.state !== 'preparing' || input.action !== 'create') fail('Restore the original protected resource material before continuing.');
      value = { entryId: record.entryId, requestId: record.requestId, configuration: input.configuration };
      if (record.provider === 'cloudflare') {
        const sdk = dependencies.cloudflare ?? await import('@jokoagent/linkspan-cloudflare');
        value = { ...value, tunnelSecret: sdk.createNamedTunnelSecret() };
      }
      await saveMaterial(app, record, value);
    }
    if (value.configuration.tokenPath !== input.configuration.tokenPath || JSON.stringify(value.configuration) !== JSON.stringify(input.configuration)) {
      value = { ...value, configuration: input.configuration }; await saveMaterial(app, record, value);
    }
    if (value.resource !== undefined) assertOwned(record, input.configuration, value.resource);
    if (record.state === 'preparing') {
      if (input.action !== 'create') return view(record, value);
      const api = await provider(record, value, signal, dependencies);
      record = recordState(app, record, 'creating');
      try {
        value = await api.create();
        if (value.resource === undefined) fail('The resource creation did not return an exact handle.');
        assertOwned(record, input.configuration, value.resource);
        assertDevMaterial(record, value);
        await saveMaterial(app, record, value); finishCreate(app, record);
        return view({ ...record, state: 'active' }, value);
      } catch (error) {
        const rejected = error instanceof LinkspanError && (error.outcome === 'not_sent' || ['invalid_argument', 'authentication_failed'].includes(error.code));
        record = recordState(app, record, rejected ? 'rejected' : 'outcome_unknown');
        if (rejected) app.store.completeDeferredEffectOperation(record.requestId, original.bodyHash, () => ({ state: 'rejected', code: error.code }));
        return view(record, material(app, record), error instanceof LinkspanError ? error.code : 'outcome_unknown');
      }
    }
    if (record.state === 'rejected') return view(record, value);
    const api = await provider(record, value, signal, dependencies);
    let observed: Resource | Candidate | null;
    try { observed = await api.find() as Resource | Candidate | null; }
    catch (error) { return view(record, value, error instanceof LinkspanError ? error.code : 'transport_error'); }
    signal.throwIfAborted();
    if (value.resource === undefined) {
      if (input.action === 'adopt') {
        if (!['creating', 'outcome_unknown'].includes(record.state) || original.status === 'completed' || observed === null
          || typeof input.confirmResourceId !== 'string' || resourceId(observed) !== input.confirmResourceId || observed.requestId !== record.requestId) fail('Confirm the exact queried resource ID from this host\'s original uncertain creation before adopting it.');
        const resource = { ...observed, createdByHost: true } as Resource;
        assertOwned(record, input.configuration, resource);
        const adoption = claimResourceOperation(app, { id: `${record.requestId}:adopt`, kind: 'connection.resource.adopt', body: { createRequestId: record.requestId, resourceIdHash: hash(input.confirmResourceId) } });
        value = { ...value, resource }; await saveMaterial(app, record, value);
        app.store.completeDeferredEffectOperation(adoption.id, adoption.bodyHash, () => ({ state: 'adopted', reference: record!.reference }));
        finishCreate(app, record); record = { ...record, state: 'active' };
        if (record.provider === 'dev-tunnels') {
          try { value = await (await provider(record, value, signal, dependencies)).open(); assertDevMaterial(record, value, resourceId(resource)); await saveMaterial(app, record, value); }
          catch { return view(record, value, 'material_unavailable'); }
        }
        return view(record, value);
      }
      value = { ...value, ...(observed === null ? { candidate: undefined } : { candidate: observed }) };
      await saveMaterial(app, record, value); record = recordState(app, record, 'outcome_unknown');
      return view(record, value, observed === null ? 'original_outcome_unconfirmed' : 'explicit_adoption_required');
    }
    if (observed !== null && resourceId(observed) !== resourceId(value.resource)) fail('The resource identity changed. Cleanup was refused.');
    finishAdoption(app, record, value.resource);
    if (observed !== null && original.status === 'started') finishCreate(app, record);
    if (input.action === 'adopt') fail('This entry already has an exact owned resource receipt.');
    if (input.action === 'delete' || record.state === 'deleting' || app.store.findOperation(`${record.requestId}:delete`)?.status === 'started' || observed === null) {
      const deletionId = `${record.requestId}:delete`;
      const deletion = claimResourceOperation(app, { id: deletionId, kind: 'connection.resource.delete', body: { createRequestId: record.requestId, reference: record.reference } });
      if (input.action !== 'delete' && observed !== null) return view(recordState(app, record, 'deleting'), value, 'deletion_unconfirmed');
      record = recordState(app, record, 'deleting');
      try {
        if (observed !== null && deletion.status === 'completed') fail('The completed deletion does not match the current resource. Restore its exact original receipt before continuing.');
        if (observed !== null) await api.remove();
        app.store.completeDeferredEffectOperation(deletionId, deletion.bodyHash, () => { recordState(app, record!, 'deleted'); return { state: 'deleted' }; });
        finishRetiredCreate(app, record);
        await credentialManager(app, record).deleteManagedSecret(record.reference);
        return view({ ...record, state: 'deleted' });
      } catch (error) { return view(record, value, error instanceof LinkspanError ? error.code : 'cleanup_unconfirmed'); }
    }
    finishCreate(app, record); return view({ ...record, state: 'active' }, value);
  }).catch(error => {
    if (error instanceof ResourceManagerError) throw error;
    throw new Error('The managed Linkspan resource operation could not be confirmed. Restore its original configuration and protected records before retrying.');
  });
}

/** Supply only missing connector material from this host's exact known receipt. */
export async function resolveManagedLinkspanConnector<T extends { readonly provider: string }>(app: Application, input: { readonly entryId: string; readonly connector: T }, dependencies: LinkspanResourceManagerDependencies = {}): Promise<T> {
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(input.entryId)) fail('Select a valid managed connection entry.');
  const connector = input.connector as T & Record<string, unknown>;
  const missing = connector.provider === 'cloudflare' ? !connector['tunnelId'] || !connector['tunnelSecret'] : connector.provider === 'netbird' ? !connector['resourceId'] || !connector['listenPort'] || !connector['publicOrigin']
    : connector.provider === 'dev-tunnels' ? !connector['tunnelId'] || !connector['hostAccessToken'] || !connector['publicOrigin'] : false;
  if (!missing) return input.connector;
  return serial(app, input.entryId, async () => {
    const record = app.store.findSetting<RecordState>('service', 'orchestrator', PREFIX + input.entryId)?.value;
    if (record === undefined || record.provider !== connector.provider || record.state !== 'active') fail('Create or reconcile the exact managed resource before enabling this connector.');
    validateJournalRecord(app, record);
    let value = material(app, record);
    if (value?.resource === undefined) fail('Restore the protected owned-resource receipt before enabling this connector.');
    assertOwned(record, value.configuration, value.resource);
    const id = resourceId(value.resource);
    if (connector.provider === 'cloudflare') {
      const resource = value.resource as CloudflareNamedResource;
      if (connector['tunnelId'] && connector['tunnelId'] !== id || connector['accountId'] && connector['accountId'] !== resource.accountId || !value.tunnelSecret) fail('The connector does not match the exact managed named tunnel.');
      return { ...connector, accountId: resource.accountId, tunnelId: id, tunnelSecret: connector['tunnelSecret'] || value.tunnelSecret } as T;
    }
    if (connector.provider === 'netbird') {
      const configuration = value.configuration;
      const resource = value.resource as NetbirdPublicResource;
      if (configuration.provider !== 'netbird' || configuration.mode === 'udp') fail('Managed UDP resources use the Linkspan packet API; a Joko HTTP entrance requires HTTP, TLS or TCP.');
      const publicUrl = new URL(`https://${configuration.domain}`);
      if (configuration.mode !== 'http') {
        if (!Number.isSafeInteger(resource.listenPort) || resource.listenPort! < 1 || resource.listenPort! > 65535) fail('The original public proxy listen port is unavailable. Reconcile its exact resource first.');
        publicUrl.port = resource.listenPort === 443 ? '' : String(resource.listenPort);
      }
      if (connector['managementUrl'] && connector['managementUrl'] !== configuration.managementUrl
        || connector['resourceId'] && connector['resourceId'] !== id || connector['mode'] && connector['mode'] !== configuration.mode
        || connector['publicOrigin'] && new URL(String(connector['publicOrigin'])).origin !== publicUrl.origin
        || connector['listenPort'] && connector['listenPort'] !== configuration.targetPort) fail('The connector does not match the exact managed public proxy.');
      return { ...connector, resourceId: id, managementUrl: configuration.managementUrl, mode: configuration.mode, listenPort: configuration.targetPort, publicOrigin: connector['publicOrigin'] || publicUrl.origin } as T;
    }
    const resource = value.resource as DevTunnelResource;
    if (connector['tunnelId'] && connector['tunnelId'] !== id || connector['clusterId'] && connector['clusterId'] !== resource.clusterId || connector['port'] && connector['port'] !== resource.port) fail('The connector does not match the exact managed Dev Tunnel.');
    await validateConfiguration(app, value.configuration);
    value = await (await provider(record, value, AbortSignal.timeout(30_000), dependencies)).open();
    assertDevMaterial(record, value, id);
    if (connector['publicOrigin'] && connector['publicOrigin'] !== value.publicOrigin) fail('The connector address does not match the exact managed Dev Tunnel.');
    await saveMaterial(app, record, value);
    if (!value.hostAccessToken || !value.publicOrigin) fail('The managed Dev Tunnel connection material is unavailable.');
    return { ...connector, tunnelId: id, clusterId: resource.clusterId, port: resource.port, hostAccessToken: connector['hostAccessToken'] || value.hostAccessToken, publicOrigin: connector['publicOrigin'] || value.publicOrigin } as T;
  }).catch(error => { if (error instanceof ResourceManagerError) throw error; throw new Error('The original managed connector material could not be confirmed. Restore its exact configuration and protected records.'); });
}

/** UDP media uses its own exact receipt, separate from the entry's HTTP ingress. */
export async function resolveManagedLinkspanDatagram<T extends { readonly provider: string }>(app: Application, input: { readonly entryId: string; readonly datagram: T }): Promise<T> {
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(input.entryId)) fail('Select a valid managed media entry.');
  const datagram = input.datagram as T & Record<string, unknown>;
  if (datagram.provider !== 'netbird' || datagram['resourceId'] && datagram['publicHost'] && datagram['publicPort'] && datagram['listenPort']) return input.datagram;
  const entryId = linkspanMediaUdpEntryId(input.entryId);
  return serial(app, entryId, async () => {
    const record = app.store.findSetting<RecordState>('service', 'orchestrator', PREFIX + entryId)?.value;
    if (record === undefined || record.provider !== 'netbird' || record.state !== 'active') fail('Create or reconcile the exact managed UDP resource before enabling media forwarding.');
    validateJournalRecord(app, record);
    const value = material(app, record);
    if (value?.resource === undefined || value.configuration.provider !== 'netbird' || value.configuration.mode !== 'udp') fail('Restore the protected exact UDP resource receipt before enabling media forwarding.');
    const configuration = value.configuration, resource = value.resource as NetbirdPublicResource;
    assertOwned(record, configuration, resource);
    const id = resourceId(resource), publicPort = resource.listenPort;
    if (!Number.isSafeInteger(publicPort) || publicPort! < 1 || publicPort! > 65535) fail('The original public UDP listen port is unavailable. Reconcile its exact resource first.');
    if (datagram['managementUrl'] && datagram['managementUrl'] !== configuration.managementUrl
      || datagram['resourceId'] && datagram['resourceId'] !== id
      || datagram['publicHost'] && datagram['publicHost'] !== configuration.domain
      || datagram['publicPort'] && datagram['publicPort'] !== publicPort
      || datagram['listenPort'] && datagram['listenPort'] !== configuration.targetPort) fail('The media datagram does not match the exact managed UDP proxy.');
    return { ...datagram, managementUrl: configuration.managementUrl, resourceId: id, publicHost: configuration.domain,
      publicPort, listenPort: configuration.targetPort } as T;
  }).catch(error => { if (error instanceof ResourceManagerError) throw error; throw new Error('The original managed UDP media receipt could not be confirmed. Restore its exact configuration and protected records.'); });
}
