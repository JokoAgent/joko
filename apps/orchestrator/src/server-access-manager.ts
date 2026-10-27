import { createHash, randomUUID } from 'node:crypto';
import { Code, ConnectError } from '@connectrpc/connect';
import { create } from '@bufbuild/protobuf';
import { ServerAccessEntrySchema, type ServerAccessEntry, type SaveServerAccessEntryRequest, type ChangeServerAccessEntryRequest } from '@joko/contracts';
import { serverAccessMode } from '@joko/contracts/server-access';
import { operationBodyHash, type ConnectionRecord, type OperationalStore } from '@joko/store';
import type { CredentialManager } from './credential-manager.js';
import type { ConnectionManager } from './connection-manager.js';
import type { OrchestratorConfig } from './config.js';
import type { ManagedLinkspanResourceView } from './linkspan-resource-manager.js';
import { readLinkspanDeployment, linkspanMediaUdpEntryId } from './linkspan-deployment.js';
import { accessCapabilities, accessError, describeDeployment, normalizeAccessConfiguration, publicAccessFields, type AccessMaterial } from './server-access-configuration.js';
import { readIceToken } from './remote-desktop-ice-configuration.js';

const PREFIX = 'runtime.server-access.entry.', SECRETS = 'runtime.server-access.vault-ref.';
const hash = (value: unknown) => createHash('sha256').update(operationBodyHash(value)).digest('hex');
function resourceIssue(code: string | undefined): string {
  if (!code) return '';
  if (['outcome_unknown', 'original_outcome_unconfirmed', 'deletion_unconfirmed', 'cleanup_unconfirmed'].includes(code)) return 'query_original_operation';
  if (code === 'explicit_adoption_required') return 'resource_adoption_required';
  return ['authentication_failed', 'identity_mismatch'].includes(code) ? code : 'provider_failed';
}
export interface AccessRecord {
  readonly entryId: string; readonly name: string; readonly provider: string; readonly mode: string;
  readonly revision: string; readonly fields: Record<string, string>; readonly configuredSecrets: string[];
  readonly reference?: string; readonly sourceHash?: string; readonly deleted?: boolean;
  readonly enabled: boolean; readonly state: string; readonly issue?: string; readonly requestId?: string;
  readonly appliedRevision?: string; readonly appliedReference?: string; readonly resource?: ManagedLinkspanResourceView;
}
export interface AccessHandle { readonly publicOrigin?: string; readonly publishedEntryId?: string; readonly isActive?: () => boolean; close(): Promise<void> }
export interface ServerAccessRuntime {
  start(record: AccessRecord, material: AccessMaterial, signal: AbortSignal): Promise<AccessHandle>;
  resource(record: AccessRecord, material: AccessMaterial, action: 'create' | 'status' | 'delete' | 'adopt', confirmResourceId: string, signal: AbortSignal): Promise<ManagedLinkspanResourceView>;
  reconcile(record: AccessRecord, material: AccessMaterial, signal: AbortSignal): Promise<void>;
}
interface Options { readonly config: OrchestratorConfig; readonly serverId: string; readonly store: OperationalStore; readonly credentials: CredentialManager; readonly connections: ConnectionManager }
interface Result { readonly entry?: ServerAccessEntry; readonly deleted?: boolean }
async function closeOwnedHandle(handle: AccessHandle): Promise<void> {
  try { await handle.close(); }
  catch { throw Object.assign(new Error('Original runtime cleanup is unconfirmed.'), { code: 'cleanup_failed' }); }
}

export function reserveServerAccessSecrets(store: OperationalStore, credentials: CredentialManager): void {
  for (const { key, value } of store.listSettingsByKeyPrefix('service', 'orchestrator', SECRETS)) {
    const reference = (value as { reference: string }).reference;
    if (!/^server\.access:[a-f0-9-]{36}$/u.test(reference) || key !== SECRETS + reference) throw new Error('Invalid server access credential ownership.');
    credentials.reserveManagedSecret({ credentialReferenceId: reference, kind: 'header_secret', providerId: 'server.access' });
  }
}

/** The Store owns selection; immutable Vault revisions own private material. Live handles alone publish entries. */
export class ServerAccessManager {
  readonly #external = new Map<string, { record: AccessRecord; material: AccessMaterial }>();
  readonly #handles = new Map<string, AccessHandle>();
  readonly #pending = new Map<string, Promise<void>>();
  readonly #actionAborts = new Map<string, AbortController>();
  readonly #shutdown = new AbortController();
  #runtime?: ServerAccessRuntime;
  #sourceFailure = false;
  constructor(readonly options: Options) { reserveServerAccessSecrets(options.store, options.credentials); }
  #rows(): AccessRecord[] { return this.options.store.listSettingsByKeyPrefix('service', 'orchestrator', PREFIX).map(setting => setting.value as AccessRecord); }
  #saved(id: string): AccessRecord | undefined { return this.options.store.findSetting<AccessRecord>('service', 'orchestrator', PREFIX + id)?.value; }
  #row(id: string): AccessRecord | undefined { return this.#saved(id) ?? this.#external.get(id)?.record; }
  #put(record: AccessRecord): void { this.options.store.setSetting('service', 'orchestrator', PREFIX + record.entryId, record); }
  async #retireSecrets(entryId: string): Promise<void> {
    for (const { key, value } of this.options.store.listSettingsByKeyPrefix('service', 'orchestrator', SECRETS)) {
      const owned = value as { reference: string; entryId: string };
      if (owned.entryId !== entryId) continue;
      await this.options.credentials.deleteManagedSecret(owned.reference);
      this.options.store.deleteSetting('service', 'orchestrator', key);
    }
  }
  async #recoverInterrupted(): Promise<void> {
    // These saves have no external effects; the pointer and completed receipt commit
    // together. An interrupted enable/resource action must be queried, never replayed.
    const interrupted = [];
    for (let offset = 0; offset < this.options.store.countOperations({ status: 'started' }); offset += 500) interrupted.push(...this.options.store.listOperations({ status: 'started', offset, limit: 500 }));
    for (const operation of interrupted) {
      if (operation.kind === 'server.access.save' || operation.kind === 'server.access.change' && (operation.body as { action?: string }).action === 'adopt') {
        this.options.store.failEffectOperation(operation.id, operation.bodyHash, { code: 'save_failed', message: 'The configuration was not committed.' });
      } else if (operation.kind === 'server.access.change') {
        const row = this.#saved((operation.body as { entryId: string }).entryId);
        if (row?.requestId === operation.id && !row.deleted) this.#put({ ...row, enabled: false, state: 'outcome_unknown', issue: 'query_original_operation' });
      }
    }
    for (const row of this.#rows()) if (row.deleted) await this.#retireSecrets(row.entryId);
    for (const { key, value } of this.options.store.listSettingsByKeyPrefix('service', 'orchestrator', SECRETS)) {
      const { reference } = value as { reference: string };
      if (this.options.store.findOperation(reference.slice('server.access:'.length))?.status !== 'failed'
        || this.#rows().some(row => row.reference === reference || row.appliedReference === reference)) continue;
      await this.options.credentials.deleteManagedSecret(reference);
      this.options.store.deleteSetting('service', 'orchestrator', key);
    }
  }
  #material(record: AccessRecord): AccessMaterial {
    if (!record.reference) return this.#external.get(record.entryId)?.material ?? accessError('source_unavailable');
    return JSON.parse(this.options.credentials.resolve(record.reference)) as AccessMaterial;
  }
  #conflict(record: AccessRecord): boolean {
    if (!record.reference || !record.sourceHash) return this.#sourceFailure && !record.reference;
    const external = this.#external.get(record.entryId);
    return this.#sourceFailure || !!external && record.sourceHash !== external.record.sourceHash;
  }
  #view(record: AccessRecord) {
    const handle = this.#handles.get(record.entryId), active = handle && (handle.isActive?.() ?? true);
    return create(ServerAccessEntrySchema, { entryId: record.entryId, name: record.name, provider: record.provider, mode: record.mode,
      revision: record.revision, source: record.reference ? 'gui' : 'deployment', enabled: record.enabled,
      state: this.#conflict(record) ? 'source_conflict' : record.state === 'active' && !active ? 'failed' : record.state,
      publicOrigin: active ? handle.publicOrigin ?? '' : '', publishedEntryId: active ? handle.publishedEntryId ?? '' : '',
      fields: record.fields, configuredSecrets: record.configuredSecrets, requestId: record.requestId ?? '',
      issue: this.#conflict(record) ? 'source_changed' : record.state === 'active' && !active ? 'runtime_stopped' : record.issue ?? '',
      pendingChanges: !!active && record.appliedRevision !== record.revision,
      resourceState: record.resource?.state ?? '', resourceId: record.resource?.resourceId ?? '',
      resourceNeedsAdoption: record.resource?.needsAdoption ?? false, resourceRequiresDns: record.resource?.requiresDns ?? false });
  }
  async #sources(): Promise<void> {
    const entries = new Map<string, { record: AccessRecord; material: AccessMaterial }>();
    try {
      if (this.options.config.linkspan?.deploymentPath) for (const entry of await readLinkspanDeployment(this.options.config.linkspan.deploymentPath, this.#shutdown.signal, { resolveRuntime: false })) {
        for (const value of [entry.connector ? { ...entry, mediaUdp: undefined, mediaUdpManagement: undefined } : undefined,
          entry.mediaUdp ? { id: entry.id, mediaUdp: entry.mediaUdp, ...(entry.mediaUdpManagement ? { mediaUdpManagement: entry.mediaUdpManagement } : {}) } : undefined]) {
          if (!value) continue;
          const id = 'connector' in value ? entry.id : linkspanMediaUdpEntryId(entry.id);
          const description = await describeDeployment(value), sourceHash = hash(description.material);
          entries.set(id, { record: { entryId: id, name: entry.id, provider: description.provider, mode: description.mode, revision: sourceHash,
            fields: description.fields, configuredSecrets: description.configuredSecrets, sourceHash, enabled: 'connector' in value || this.options.config.remoteDesktopUdp?.entryId === entry.id,
            state: this.#handles.has(id) ? 'active' : this.#external.get(id)?.record.state ?? 'stopped', appliedRevision: sourceHash }, material: description.material });
        }
      }
      if (this.options.config.linkspan?.cloudflaredExecutable) {
        const sourceHash = hash({ provider: 'cloudflare', executable: this.options.config.linkspan.cloudflaredExecutable });
        entries.set('cloudflare-quick', { record: { entryId: 'cloudflare-quick', name: 'Cloudflare Quick', provider: 'cloudflare', mode: 'quick', revision: sourceHash, sourceHash,
          fields: {}, configuredSecrets: [], enabled: true, state: this.#handles.has('cloudflare-quick') ? 'active' : 'stopped', appliedRevision: sourceHash }, material: { fields: {} } });
      }
      const turn = this.options.config.remoteDesktopTurn;
      if (turn) {
        const fields = { keyId: turn.keyId, ttlSeconds: String(turn.ttlSeconds), apiToken: await readIceToken(turn.tokenPath, this.#shutdown.signal), ...(turn.urls ? { urls: turn.urls.join('\n') } : {}) };
        const sourceHash = hash(fields), provider = turn.provider ?? 'cloudflare', id = 'deployment-turn';
        entries.set(id, { record: { entryId: id, name: `${provider} TURN`, provider, mode: 'turn', revision: sourceHash, sourceHash,
          fields: publicAccessFields(provider, 'turn', fields), configuredSecrets: ['apiToken'], enabled: true,
          state: this.#handles.has(id) ? 'active' : 'stopped', appliedRevision: sourceHash }, material: { fields } });
      }
      this.#external.clear(); for (const [key, value] of entries) this.#external.set(key, value); this.#sourceFailure = false;
    } catch { this.#sourceFailure = true; }
  }
  async attach(runtime: ServerAccessRuntime): Promise<void> {
    if (this.#runtime) throw new Error('Server access runtime already attached.');
    await this.#recoverInterrupted(); await this.#sources(); this.#runtime = runtime;
    const rows = new Map([...this.#external].map(([id, value]) => [id, value.record]));
    for (const record of this.#rows()) rows.set(record.entryId, record);
    for (const record of rows.values()) {
      if (record.deleted || !record.enabled || this.#conflict(record) || record.state === 'outcome_unknown') continue;
      // Explicitly enabled configuration survives process exit. Underlying runtime journals
      // reconcile the exact previous effect before another publication can start.
      const starting = { ...record, state: 'starting' };
      if (record.reference) this.#put(starting);
      else { const external = this.#external.get(record.entryId); if (external) this.#external.set(record.entryId, { ...external, record: starting }); }
      const abort = new AbortController(), signal = AbortSignal.any([abort.signal, this.#shutdown.signal]);
      this.#actionAborts.set(record.entryId, abort);
      const work = this.#start(starting, () => signal.throwIfAborted(), signal, true)
        .catch(error => this.#runtimeFailure(record, error)).then(() => undefined);
      this.#pending.set(record.entryId, work);
      void work.finally(() => { if (this.#pending.get(record.entryId) === work) this.#pending.delete(record.entryId); if (this.#actionAborts.get(record.entryId) === abort) this.#actionAborts.delete(record.entryId); }).catch(() => undefined);
    }
  }
  async read(connection: ConnectionRecord, requestId = '') {
    this.options.connections.fence(connection); await this.#sources();
    const rows = new Map([...this.#external].map(([id, value]) => [id, value.record]));
    for (const record of this.#rows()) rows.set(record.entryId, record);
    const capabilities = await accessCapabilities(this.options.config); this.options.connections.fence(connection);
    let operationState = '', operationEntry: Result['entry'], operationDeleted = false, operationIssue = '';
    if (requestId) {
      const operation = this.options.store.findOperation<Result>(requestId);
      if (!operation) operationState = 'missing';
      else {
        if (operation.connectionId !== connection.id || !operation.kind.startsWith('server.access.')) return accessError('operation_owner_changed', Code.PermissionDenied);
        operationState = operation.status === 'started' ? [...this.#pending.keys()].some(id => this.#row(id)?.requestId === requestId) ? 'pending' : 'outcome_unknown' : operation.status;
        operationEntry = operation.response?.entry; operationDeleted = operation.response?.deleted ?? false;
        operationIssue = operationEntry?.issue ?? (operationState === 'failed' ? 'operation_failed' : '');
      }
    }
    return { serverId: this.options.serverId, entries: [...rows.values()].filter(record => !record.deleted).map(record => this.#view(record)), capabilities,
      operationState, ...(operationEntry ? { operationEntry } : {}), operationDeleted, operationIssue };
  }
  #assertId(id: string): void { if (!/^[a-z][a-z0-9-]{0,63}$/u.test(id)) accessError('invalid_entry', Code.InvalidArgument); }
  #assertRequest(id: string): void { if (!/^[a-f0-9-]{36}$/u.test(id)) accessError('invalid_request', Code.InvalidArgument); }
  #validateRevision(record: AccessRecord | undefined, expected: string, allowRecreate = false): void {
    if (allowRecreate && record?.deleted && expected === '') return;
    if ((record?.revision ?? '') !== expected || record?.deleted) accessError('revision_conflict', Code.Aborted);
  }
  #replay(connection: ConnectionRecord, requestId: string, kind: string, body: object): Result | undefined {
    const operation = this.options.store.findOperation<Result>(requestId);
    if (!operation) return;
    if (operation.connectionId !== connection.id || operation.kind !== kind || operation.bodyHash !== operationBodyHash(body)) return accessError('request_conflict', Code.AlreadyExists);
    if (operation.status !== 'completed') return accessError('query_original_operation', Code.FailedPrecondition);
    return operation.response ?? {};
  }
  async save(connection: ConnectionRecord, request: SaveServerAccessEntryRequest, signal: AbortSignal): Promise<Result> {
    this.#assertId(request.entryId); this.#assertRequest(request.requestId); signal.throwIfAborted(); this.options.connections.fence(connection);
    const body = { entryId: request.entryId, expectedRevision: request.expectedRevision, digest: hash({ name: request.name, provider: request.provider, mode: request.mode, fields: request.fields }) };
    const replay = this.#replay(connection, request.requestId, 'server.access.save', body); if (replay) return replay;
    const found = this.#row(request.entryId); this.#validateRevision(found, request.expectedRevision, true);
    const previous = found?.deleted ? undefined : found;
    if (this.#pending.has(request.entryId)) return accessError('operation_pending');
    if (previous && !previous.reference) return accessError('adoption_required');
    if (previous && (previous.provider !== request.provider || previous.mode !== request.mode)) return accessError('mode_immutable');
    if (!request.name.trim() || request.name.length > 80 || /[\u0000-\u001f\u007f]/u.test(request.name)) return accessError('invalid_name', Code.InvalidArgument);
    if (!previous && new Set([...this.#rows().filter(row => !row.deleted).map(row => row.entryId), ...[...this.#external.keys()].filter(id => !this.#saved(id)?.deleted)]).size >= 16) return accessError('entry_limit', Code.ResourceExhausted);
    if (request.provider === 'cloudflare' && request.mode === 'quick' && request.entryId !== 'cloudflare-quick') return accessError('quick_singleton');
    const material = normalizeAccessConfiguration(request.provider, request.mode, request.fields, previous ? this.#material(previous) : undefined);
    if (previous && this.#material(previous).fields['resourceMode'] === 'managed' && !['deleted', 'not_created', 'rejected'].includes(previous.resource?.state ?? '')) {
      const original = this.#material(previous).fields;
      if (['resourceMode', 'accountId', 'managementUrl', 'domain', 'peerId', 'listenPort', 'clusterId', 'port'].some(key => original[key] !== material.fields[key])) return accessError('resource_cleanup_required');
    }
    const reference = `server.access:${request.requestId}`, revision = randomUUID();
    const record: AccessRecord = { ...previous, entryId: request.entryId, name: request.name.trim(), provider: request.provider, mode: request.mode, revision,
      fields: publicAccessFields(request.provider, request.mode, material.fields), configuredSecrets: material.configuredSecrets, reference,
      enabled: previous?.enabled ?? false, state: previous?.state ?? 'saved', issue: '', requestId: request.requestId };
    const operation = this.options.store.claimAuthorizedDeferredEffectOperation(connection.id, connection.authKeyDigest,
      { id: request.requestId, kind: 'server.access.save', body }, () => {
        this.#validateRevision(this.#row(request.entryId), request.expectedRevision, true);
        this.options.store.setSetting('service', 'orchestrator', SECRETS + reference, { reference, entryId: request.entryId });
      }).operation;
    this.options.credentials.reserveManagedSecret({ credentialReferenceId: reference, kind: 'header_secret', providerId: 'server.access' });
    try {
      const written = await this.options.credentials.compareAndSetManagedSecret({ credentialReferenceId: reference, expectedSecret: undefined,
        secret: JSON.stringify({ fields: material.fields, ...(material.identity ? { identity: material.identity } : {}), ...(material.deploymentId ? { deploymentId: material.deploymentId } : {}),
          ...(material.providerStateDirectory ? { providerStateDirectory: material.providerStateDirectory } : {}), ...(material.irohRelayLease ? { irohRelayLease: material.irohRelayLease } : {}) }), displayName: 'Server access configuration', kind: 'header_secret', providerId: 'server.access' });
      if (!written) return accessError('request_conflict', Code.AlreadyExists);
      signal.throwIfAborted(); this.options.connections.fence(connection);
      return this.options.store.completeAuthorizedDeferredEffectOperation(connection.id, connection.authKeyDigest, request.requestId, operation.bodyHash, () => {
        this.#validateRevision(this.#row(request.entryId), request.expectedRevision, true); this.#put(record); return { entry: this.#view(record) };
      }).value;
    } catch (error) {
      // No external effect was dispatched. A failed save can be retried explicitly.
      this.options.store.failEffectOperation(request.requestId, operation.bodyHash, { code: 'save_failed', message: 'The configuration was not committed.' });
      throw error instanceof ConnectError ? error : new ConnectError('save_failed', Code.Internal);
    }
  }
  async change(connection: ConnectionRecord, request: ChangeServerAccessEntryRequest): Promise<Result> {
    this.#assertId(request.entryId); this.#assertRequest(request.requestId); this.options.connections.fence(connection);
    const actions = ['start', 'stop', 'delete', 'adopt', 'accept_source', 'reconcile', 'resource_create', 'resource_status', 'resource_delete', 'resource_adopt'];
    if (!actions.includes(request.action)) return accessError('invalid_action', Code.InvalidArgument);
    const body = { entryId: request.entryId, expectedRevision: request.expectedRevision, action: request.action, confirmDisconnection: request.confirmDisconnection, confirmResourceId: request.confirmResourceId };
    const replay = this.#replay(connection, request.requestId, 'server.access.change', body); if (replay) return replay;
    await this.#sources(); this.options.connections.fence(connection);
    let record = this.#row(request.entryId); this.#validateRevision(record, request.expectedRevision);
    if (!record) return accessError('entry_missing', Code.NotFound);
    if (this.#pending.has(record.entryId)) {
      if (request.action !== 'stop' || !request.confirmDisconnection) return accessError('operation_pending');
      this.#actionAborts.get(record.entryId)?.abort(); await this.#pending.get(record.entryId);
      this.options.connections.fence(connection); record = this.#row(request.entryId)!;
    }
    if (!record.reference && request.action !== 'adopt') return accessError('adoption_required');
    if (record.state === 'outcome_unknown' && !['reconcile', 'resource_status', 'stop'].includes(request.action)) return accessError('query_original_operation');
    if (this.#conflict(record) && !['accept_source', 'stop', 'delete', 'resource_status', 'resource_delete'].includes(request.action)) return accessError('source_changed');
    if (['stop', 'delete'].includes(request.action) && (record.enabled || this.#handles.has(record.entryId)) && !request.confirmDisconnection) return accessError('confirm_disconnection');
    if (request.action === 'delete' && record.resource && !['deleted', 'not_created', 'rejected'].includes(record.resource.state)) return accessError('resource_cleanup_required');
    if (request.action === 'delete' && !record.resource && this.#material(record).fields['resourceMode'] === 'managed') return accessError('resource_cleanup_required');
    if (request.action === 'resource_delete' && (!request.confirmResourceId || request.confirmResourceId !== record.resource?.resourceId || this.#handles.has(record.entryId))) return accessError('confirm_resource_deletion');
    if (request.action === 'start') {
      if (!this.#runtime) return accessError('runtime_unavailable');
      if (this.#handles.has(record.entryId) && this.#handles.get(record.entryId)?.isActive?.() !== false) return accessError(record.appliedRevision === record.revision ? 'already_active' : 'stop_before_apply');
      const capability = (await accessCapabilities(this.options.config)).find(value => value.provider === record!.provider && value.mode === record!.mode);
      if (capability?.state !== 'ready') return accessError(capability?.issue ?? 'runtime_unavailable');
      const purpose = serverAccessMode(record.provider, record.mode)?.purpose;
      if (purpose === 'media' && [...this.#rows(), ...[...this.#external.values()].filter(value => !this.#saved(value.record.entryId)).map(value => value.record)].some(row => row.entryId !== record!.entryId && (row.enabled || row.state === 'outcome_unknown') && (row.mode === 'turn') === (record!.mode === 'turn') && serverAccessMode(row.provider, row.mode)?.purpose === 'media')) return accessError('media_singleton');
    }
    const original = record, revision = randomUUID();
    const operation = this.options.store.claimAuthorizedDeferredEffectOperation(connection.id, connection.authKeyDigest, { id: request.requestId, kind: 'server.access.change', body }, () => {
      this.#validateRevision(this.#row(request.entryId), request.expectedRevision);
      if (request.action === 'adopt') this.options.store.setSetting('service', 'orchestrator', SECRETS + `server.access:${request.requestId}`, { reference: `server.access:${request.requestId}`, entryId: request.entryId });
    }).operation;
    record = { ...record, revision, requestId: request.requestId, state: request.action === 'start' ? 'starting' : request.action === 'stop' || request.action === 'delete' ? 'stopping' : record.state, issue: '' };
    // Once admitted, the service owns the action; disconnecting the RPC does not revoke it.
    const abort = new AbortController(), unregister = this.options.connections.onRevoked(connection.id, () => abort.abort());
    this.#actionAborts.set(record.entryId, abort);
    const signal = AbortSignal.any([abort.signal, this.#shutdown.signal]);
    const assertCurrent = () => { signal.throwIfAborted(); this.options.connections.fence(connection); };
    const selected = record; if (original.reference) this.#put(selected);
    const pending = (async () => {
      let next = selected;
      try {
        assertCurrent();
        if (request.action === 'adopt') {
          const reference = `server.access:${request.requestId}`;
          this.options.credentials.reserveManagedSecret({ credentialReferenceId: reference, kind: 'header_secret', providerId: 'server.access' });
          const written = await this.options.credentials.compareAndSetManagedSecret({ credentialReferenceId: reference, expectedSecret: undefined, secret: JSON.stringify(this.#material(original)), displayName: 'Server access configuration', kind: 'header_secret', providerId: 'server.access' });
          if (!written) return accessError('request_conflict', Code.AlreadyExists);
          assertCurrent(); next = { ...next, reference, appliedReference: reference, appliedRevision: this.#handles.has(next.entryId) ? revision : '' };
        } else if (request.action === 'accept_source') next = { ...next, sourceHash: this.#external.get(next.entryId)?.record.sourceHash ?? '', state: this.#handles.has(next.entryId) ? 'active' : 'stopped' };
        else if (request.action === 'start') {
          const stale = this.#handles.get(next.entryId); if (stale) { await closeOwnedHandle(stale); this.#handles.delete(next.entryId); }
          next = await this.#start({ ...next, enabled: true }, assertCurrent, signal);
        }
        else if (request.action === 'stop' || request.action === 'delete' || request.action === 'reconcile') {
          // Persist stop intent before closing; restart must not resurrect it.
          next = { ...next, enabled: false }; this.#put(next);
          const handle = this.#handles.get(next.entryId);
          if (handle) await closeOwnedHandle(handle);
          else if (original.state === 'outcome_unknown' || ['starting', 'stopping', 'active'].includes(original.state)) {
            if (!this.#runtime) return accessError('runtime_unavailable');
            await this.#runtime.reconcile(original, this.#material({ ...original, ...(original.appliedReference ? { reference: original.appliedReference } : {}) }), signal);
          }
          this.#handles.delete(next.entryId);
          next = { ...next, state: 'stopped', appliedRevision: '', ...(request.action === 'delete' ? { deleted: true } : {}) };
        } else {
          if (!this.#runtime) return accessError('runtime_unavailable');
          const resource = await this.#runtime.resource(next, this.#material(original), request.action.slice(9) as 'create' | 'status' | 'delete' | 'adopt', request.confirmResourceId, signal);
          next = { ...next, resource, issue: resourceIssue(resource.code) };
        }
        assertCurrent();
        if (next.state === 'active' && original.appliedRevision === original.revision) next = { ...next, appliedRevision: revision };
        if (next.deleted) { this.#put(next); await this.#retireSecrets(next.entryId); assertCurrent(); }
        this.options.store.completeAuthorizedDeferredEffectOperation(connection.id, connection.authKeyDigest, request.requestId, operation.bodyHash, () => {
          this.#put(next); return next.deleted ? { deleted: true } : { entry: this.#view(next) };
        });
      } catch (error) {
        if (signal.aborted && request.action === 'start') {
          try { await this.#handles.get(next.entryId)?.close(); this.#handles.delete(next.entryId); }
          catch { error = Object.assign(new Error('cleanup unconfirmed'), { code: 'cleanup_failed' }); }
        }
        next = this.#runtimeFailure({ ...next, enabled: request.action === 'start' ? false : next.enabled }, error);
        // Receipt is public and sanitized; raw SDK errors may contain publisher secrets.
        try { this.options.store.completeAuthorizedDeferredEffectOperation(connection.id, connection.authKeyDigest, request.requestId, operation.bodyHash, () => ({ entry: this.#view(next) })); } catch { /* Revocation leaves the original operation queryable as unknown. */ }
      } finally { unregister(); if (this.#actionAborts.get(request.entryId) === abort) this.#actionAborts.delete(request.entryId); }
    })();
    this.#pending.set(request.entryId, pending);
    void pending.finally(() => { if (this.#pending.get(request.entryId) === pending) this.#pending.delete(request.entryId); }).catch(() => undefined);
    return { entry: this.#view(selected) };
  }
  async #start(record: AccessRecord, assertCurrent: () => void, signal: AbortSignal, restoreApplied = false): Promise<AccessRecord> {
    assertCurrent();
    const reference = restoreApplied && record.appliedReference ? record.appliedReference : record.reference;
    const selected = { ...record, ...(reference ? { reference } : {}) };
    const handle = await this.#runtime!.start(selected, this.#material(selected), signal);
    try { assertCurrent(); } catch (error) {
      try { await handle.close(); } catch { this.#handles.set(record.entryId, handle); throw Object.assign(new Error('cleanup unconfirmed'), { code: 'cleanup_failed' }); }
      throw error;
    }
    this.#handles.set(record.entryId, handle);
    const next = { ...record, state: 'active', issue: '', appliedRevision: restoreApplied && record.appliedReference ? record.appliedRevision ?? record.revision : record.revision,
      ...(reference ? { appliedReference: reference } : {}) };
    if (record.reference) this.#put(next); else { const external = this.#external.get(record.entryId); if (external) this.#external.set(record.entryId, { ...external, record: next }); }
    return next;
  }
  #runtimeFailure(record: AccessRecord, error: unknown): AccessRecord {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    const unknown = ['outcome_unknown', 'cleanup_failed'].includes(code) || error && typeof error === 'object' && 'outcome' in error && error.outcome === 'unknown'
      || /unconfirmed|original.*operation|cleanup/iu.test(error instanceof Error ? error.message : '');
    const next = { ...record, state: unknown ? 'outcome_unknown' : this.#handles.has(record.entryId) ? 'active' : 'failed', issue: unknown ? 'query_original_operation' : 'provider_failed' };
    if (record.reference) this.#put(next);
    else { const external = this.#external.get(record.entryId); if (external) this.#external.set(record.entryId, { ...external, record: next }); }
    return next;
  }
  async close(): Promise<void> {
    this.#shutdown.abort(); await Promise.allSettled(this.#pending.values());
    const results = await Promise.allSettled([...this.#handles.values()].map(handle => handle.close())); this.#handles.clear();
    if (results.some(result => result.status === 'rejected')) throw new Error('Server access cleanup is unconfirmed.');
  }
}
