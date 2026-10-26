import { createClient, Code, ConnectError } from '@connectrpc/connect';
import { ConnectionService, type NodeConnectionEntry, type ListConnectionEntriesResponse, type PrepareConnectionEntryResponse } from '@joko/contracts';
import { createConnectTransport } from './index.js';
import { EndpointTrustError, isEndpointTrustError, endpointOrigin, normalizeEndpointPublicKey, normalizeEndpointTransport,
  trustedEndpointTransport, rememberEndpointTrust, prepareEndpointTransportRuntime,
  localIrohClientBinding, localTailcatClientBinding, type EndpointTransport, type EndpointTransportKind } from './trust.js';

export interface ConnectionEntryOwner {
  readonly profileId: string; readonly serverId: string; readonly deviceId: string; readonly endpointPublicKey: string;
}
export interface SavedConnectionEntry {
  readonly id: string; readonly name: string; readonly provider: string; readonly origin: string;
  readonly sourceId?: string;
  readonly invited?: boolean;
  readonly requiresServerSetup?: boolean;
  readonly kind: EndpointTransportKind; readonly published: boolean; readonly prepared: boolean;
  readonly verification?: 'verified' | 'unreachable' | 'identity-conflict';
  readonly transport?: EndpointTransport;
  readonly requestId?: string; readonly clientPublicKey?: string; readonly clientPrivateKey?: string;
  readonly irohMode?: 'native' | 'relay';
}
export interface SavedConnectionEntries {
  readonly version: 1; readonly owner: string; readonly revision: string;
  readonly entries: readonly SavedConnectionEntry[];
  readonly preferredId: string; readonly backupIds: readonly string[]; readonly returnToPreferred: boolean;
}
export interface ConnectionEntryView {
  readonly id: string; readonly name: string; readonly provider: string; readonly kind: EndpointTransportKind;
  readonly preferred: boolean; readonly backup: boolean; readonly current: boolean;
  readonly backupOrder?: number;
  readonly state: 'ready' | 'unprepared' | 'expired' | 'unsupported' | 'withdrawn' | 'identity-conflict' | 'requires-setup';
  readonly verification?: 'verified' | 'unreachable' | 'identity-conflict';
}
const kinds: readonly string[] = ['https', 'iroh', 'tailcat', 'webrtc', 'http-connect'];
export function connectionEntryOwnerKey(owner: ConnectionEntryOwner): string {
  for (const value of [owner.profileId, owner.serverId, owner.deviceId]) if (typeof value !== 'string' || !value || value.length > 256 || /[\u0000-\u001f]/u.test(value)) throw new Error('Invalid saved node owner.');
  return JSON.stringify(['node-entries-v1', owner.profileId, owner.serverId, owner.deviceId, normalizeEndpointPublicKey(owner.endpointPublicKey)]);
}
export function parseSavedConnectionEntries(value: unknown, owner: ConnectionEntryOwner): SavedConnectionEntries {
  if (!value || typeof value !== 'object') throw new Error('The protected entry directory is invalid.');
  const data = value as SavedConnectionEntries;
  if (data.version !== 1 || data.owner !== connectionEntryOwnerKey(owner) || !Array.isArray(data.entries) || data.entries.length > 80
    || !Array.isArray(data.backupIds) || data.backupIds.length > 8 || typeof data.returnToPreferred !== 'boolean'
    || typeof data.revision !== 'string' || data.revision.length > 128) throw new Error('The protected entry directory belongs to another node or device.');
  const seen = new Set<string>();
  const entries = data.entries.map(entry => {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !/^[a-z0-9][a-z0-9._:-]{0,127}$/iu.test(entry.id)
      || entry.sourceId !== undefined && (typeof entry.sourceId !== 'string' || !/^[a-z0-9][a-z0-9._:-]{0,127}$/iu.test(entry.sourceId))
      || entry.invited !== undefined && typeof entry.invited !== 'boolean'
      || entry.requiresServerSetup !== undefined && typeof entry.requiresServerSetup !== 'boolean'
      || entry.irohMode !== undefined && (entry.kind !== 'iroh' || !['native', 'relay'].includes(entry.irohMode))
      || entry.verification !== undefined && !['verified', 'unreachable', 'identity-conflict'].includes(entry.verification)
      || seen.has(entry.id) || !kinds.includes(entry.kind) || typeof entry.name !== 'string' || entry.name.length > 256
      || typeof entry.provider !== 'string' || entry.provider.length > 64 || typeof entry.prepared !== 'boolean' || typeof entry.published !== 'boolean') throw new Error('Invalid saved entrance.');
    seen.add(entry.id);
    const origin = endpointOrigin(entry.origin), transport = entry.transport === undefined ? undefined : normalizeEndpointTransport(entry.transport);
    if (transport && transport.kind !== entry.kind || entry.prepared && !['https', 'webrtc'].includes(entry.kind) && !transport) throw new Error('The saved entrance locator does not match its carrier.');
    if (entry.requestId !== undefined && !/^[a-f0-9-]{36}$/u.test(entry.requestId)) throw new Error('Invalid preparation request.');
    if (entry.clientPublicKey !== undefined && !/^(?:nodekey:)?[a-f0-9]{64}$/u.test(entry.clientPublicKey)
      || entry.clientPrivateKey !== undefined && !/^(?:privkey:)?[a-f0-9]{64}$/u.test(entry.clientPrivateKey)) throw new Error('Invalid device transport identity.');
    return { id: entry.id, name: entry.name, provider: entry.provider, origin, kind: entry.kind, prepared: entry.prepared, published: entry.published,
      ...(entry.sourceId ? { sourceId: entry.sourceId } : {}), ...(entry.invited ? { invited: true } : {}),
      ...(entry.requiresServerSetup ? { requiresServerSetup: true } : {}),
      ...(entry.verification ? { verification: entry.verification } : {}), ...(transport ? { transport } : {}),
      ...(entry.irohMode ? { irohMode: entry.irohMode } : {}),
      ...(entry.requestId ? { requestId: entry.requestId } : {}), ...(entry.clientPublicKey ? { clientPublicKey: entry.clientPublicKey } : {}),
      ...(entry.clientPrivateKey ? { clientPrivateKey: entry.clientPrivateKey } : {}) };
  });
  if (!seen.has(data.preferredId) || data.backupIds.some(id => !seen.has(id) || id === data.preferredId)
    || new Set(data.backupIds).size !== data.backupIds.length) throw new Error('Invalid connection preferences.');
  return { version: 1, owner: data.owner, revision: data.revision, entries, preferredId: data.preferredId,
    backupIds: [...data.backupIds], returnToPreferred: data.returnToPreferred };
}
export function initialConnectionEntries(owner: ConnectionEntryOwner, route: { readonly origin: string; readonly transportKind?: EndpointTransportKind }): SavedConnectionEntries {
  const kind = route.transportKind ?? 'https';
  const transport = kind === 'https' ? undefined : kind === 'webrtc' ? { kind: 'webrtc' as const }
    : trustedEndpointTransport(route.origin, owner.endpointPublicKey, kind);
  return parseSavedConnectionEntries({ version: 1, owner: connectionEntryOwnerKey(owner), revision: '', preferredId: 'saved',
    backupIds: [], returnToPreferred: true, entries: [{ id: 'saved', name: 'Saved entrance', provider: 'direct',
      origin: route.origin, kind, published: true, prepared: true, ...(transport ? { transport } : {}) }] }, owner);
}
export function mergeConnectionEntryDirectory(saved: SavedConnectionEntries, owner: ConnectionEntryOwner, directory: ListConnectionEntriesResponse): SavedConnectionEntries {
  assertNode(owner, directory.serverId, directory.endpointPublicKey);
  if (directory.entries.length > 64) throw new Error('The node returned too many entrances.');
  const entries: SavedConnectionEntry[] = saved.entries.filter(e => e.id === 'saved' || e.invited);
  const alias = entries.find(e => e.id === 'saved');
  for (const item of directory.entries) {
    if (alias && alias.origin === item.origin && alias.kind === item.transportKind && (alias.sourceId === item.entryId || alias.sourceId === undefined && alias.kind === 'https')) {
      entries[entries.findIndex(e => e.id === alias.id)] = { ...alias, sourceId: item.entryId, name: item.displayName || item.provider, provider: item.provider }; continue;
    }
    const previous = saved.entries.find(e => e.id === item.entryId);
    const next = previous && previous.origin === item.origin && previous.kind === item.transportKind
      ? { ...previous, name: item.displayName || item.provider, published: true, requiresServerSetup: item.requiresServerSetup }
      : fromDirectory(item);
    const index = entries.findIndex(e => e.id === next.id);
    if (index < 0) entries.push(next); else entries[index] = next;
  }
  for (const old of saved.entries) if ((old.id === saved.preferredId || saved.backupIds.includes(old.id)) && !entries.some(e => e.id === old.id)) entries.push({ ...old, published: false });
  return parseSavedConnectionEntries({ ...saved, revision: directory.revision, entries }, owner);
}
/** Explicit invitation acceptance adds a route, never an authorization or a new pin. */
export function acceptInvitedConnectionEntry(owner: ConnectionEntryOwner, saved: SavedConnectionEntries,
  invitation: { readonly origin: string; readonly serverId: string; readonly endpointPublicKey: string; readonly transportKind?: EndpointTransportKind; readonly endpointTransport?: EndpointTransport }, id: string) {
  assertNode(owner, invitation.serverId, invitation.endpointPublicKey);
  const origin = endpointOrigin(invitation.origin);
  if (!origin.startsWith('https://')) throw new Error('A trusted invitation requires a secure entrance.');
  const kind = invitation.transportKind ?? 'https', transport = invitation.endpointTransport;
  const existing = saved.entries.find(e => e.origin === origin && e.kind === kind && (kind === 'https' || kind === 'webrtc' || JSON.stringify(e.transport) === JSON.stringify(transport)));
  const entry: SavedConnectionEntry = { ...existing, id: existing?.id ?? `invitation:${id}`, name: existing?.name ?? new URL(origin).host,
    provider: existing?.provider ?? 'invitation', origin, kind, published: true, prepared: true, invited: true, ...(transport ? { transport } : {}) };
  const retained = saved.entries.filter(e => e.id !== entry.id && (!e.invited || e.id === saved.preferredId || saved.backupIds.includes(e.id)));
  return { entryId: entry.id, saved: parseSavedConnectionEntries({ ...saved, entries: [...retained, entry] }, owner) };
}
function fromDirectory(item: NodeConnectionEntry): SavedConnectionEntry {
  if (!kinds.includes(item.transportKind)) throw new Error('Unsupported entrance carrier in the node directory.');
  return { id: item.entryId, name: item.displayName || item.provider, provider: item.provider, origin: endpointOrigin(item.origin),
    kind: item.transportKind as EndpointTransportKind, published: true, prepared: false, requiresServerSetup: item.requiresServerSetup };
}
export function entryReadiness(entry: SavedConnectionEntry, supported: (kind: EndpointTransportKind) => boolean, now = Date.now()): ConnectionEntryView['state'] {
  if (!supported(entry.kind)) return 'unsupported';
  if (!entry.published) return 'withdrawn';
  if (entry.verification === 'identity-conflict') return 'identity-conflict';
  if (!entry.prepared && entry.requiresServerSetup) return 'requires-setup';
  if (!entry.prepared) return 'unprepared';
  if (entry.transport?.kind === 'iroh' && entry.transport.relayTokenExpiresAt !== undefined && entry.transport.relayTokenExpiresAt <= now + 30_000) return 'expired';
  return 'ready';
}
export function activeConnectionEntry(saved: SavedConnectionEntries, current: { readonly entryId?: string; readonly origin: string; readonly transportKind?: EndpointTransportKind }): SavedConnectionEntry | undefined {
  return saved.entries.find(entry => (current.entryId === undefined || entry.id === current.entryId)
    && entry.origin === current.origin && entry.kind === (current.transportKind ?? 'https'));
}
export function connectionEntryViews(saved: SavedConnectionEntries, current: { readonly entryId?: string; readonly origin: string; readonly transportKind?: EndpointTransportKind }, supported: (kind: EndpointTransportKind) => boolean): readonly ConnectionEntryView[] {
  const active = activeConnectionEntry(saved, current);
  return saved.entries.map(entry => ({ id: entry.id, name: entry.name, provider: entry.provider, kind: entry.kind,
    preferred: entry.id === saved.preferredId, backup: saved.backupIds.includes(entry.id),
    ...(saved.backupIds.includes(entry.id) ? { backupOrder: saved.backupIds.indexOf(entry.id) } : {}),
    current: entry.id === active?.id, state: entryReadiness(entry, supported), verification: entry.verification }));
}
export function connectionEntryCandidates(saved: SavedConnectionEntries, supported: (kind: EndpointTransportKind) => boolean, selectedId?: string): readonly SavedConnectionEntry[] {
  return (selectedId ? [selectedId] : [saved.preferredId, ...saved.backupIds]).flatMap(id => {
    const entry = saved.entries.find(e => e.id === id);
    return entry && entryReadiness(entry, supported) === 'ready' ? [entry] : [];
  });
}
export function entryRoute(owner: ConnectionEntryOwner, entry: SavedConnectionEntry) {
  return { origin: entry.origin, endpointPublicKey: owner.endpointPublicKey, serverId: owner.serverId,
    transportKind: entry.kind, ...(entry.transport ? { endpointTransport: entry.transport } : {}) };
}
function clientFor(owner: ConnectionEntryOwner, entry: SavedConnectionEntry) {
  const route = entryRoute(owner, entry);
  return createClient(ConnectionService, createConnectTransport({ baseUrl: entry.origin, ...route, isolateFailures: true }));
}
function assertNode(owner: ConnectionEntryOwner, serverId: string, key?: string) {
  if (serverId !== owner.serverId || key !== undefined && key !== owner.endpointPublicKey) throw new EndpointTrustError('This entrance did not prove the saved server identity. Its credentials were not sent.');
}
export async function verifyConnectionEntry(owner: ConnectionEntryOwner, entry: SavedConnectionEntry, signal: AbortSignal): Promise<void> {
  const response = await clientFor(owner, entry).getServerInfo({}, { signal });
  assertNode(owner, response.server?.serverId ?? '');
}
export async function verifyEntryAuthorization(owner: ConnectionEntryOwner, entry: SavedConnectionEntry, authKey: string, signal: AbortSignal): Promise<void> {
  const response = await clientFor(owner, entry).getDevice({ deviceId: owner.deviceId }, { signal, headers: { authorization: `Bearer ${authKey}` } });
  if (response.device?.deviceId !== owner.deviceId) throw new ConnectError('The saved device authorization changed.', Code.PermissionDenied);
}
export function activateConnectionEntry(owner: ConnectionEntryOwner, entry: SavedConnectionEntry): void {
  rememberEndpointTrust(entryRoute(owner, entry));
}
export async function readConnectionEntryDirectory(owner: ConnectionEntryOwner, entry: SavedConnectionEntry, authKey: string, signal: AbortSignal) {
  const response = await clientFor(owner, entry).listConnectionEntries({}, { signal, headers: { authorization: `Bearer ${authKey}` } });
  assertNode(owner, response.serverId, response.endpointPublicKey); return response;
}
/** Persist the returned device identity/request BEFORE calling prepareConnectionEntry. */
export async function beginConnectionEntryPreparation(entry: SavedConnectionEntry, options: { readonly uuid?: () => string; readonly irohMode?: 'native' | 'relay' } = {}): Promise<SavedConnectionEntry> {
  const irohMode = entry.irohMode ?? (entry.transport?.kind === 'iroh' ? entry.transport.mobileMode : undefined) ?? options.irohMode ?? 'relay';
  if (entry.kind === 'iroh') entry = { ...entry, irohMode };
  if (entry.requestId && (entry.kind !== 'iroh' && entry.kind !== 'tailcat' || entry.clientPrivateKey)) return entry;
  const uuid = options.uuid ?? (() => crypto.randomUUID());
  if (entry.clientPrivateKey && entry.clientPublicKey) return { ...entry, requestId: uuid() };
  if (entry.kind !== 'iroh' && entry.kind !== 'tailcat') return { ...entry, requestId: uuid() };
  await prepareEndpointTransportRuntime(entry.kind);
  const identity = entry.kind === 'iroh'
    ? await (localIrohClientBinding()?.createIdentity(irohMode) ?? (await import('@jokoagent/linkspan-iroh')).createIrohIdentity())
    : await (localTailcatClientBinding()?.createIdentity() ?? (await import('@jokoagent/linkspan-tailcat')).createTailcatIdentity());
  return { ...entry, requestId: uuid(), clientPublicKey: identity.publicKey, clientPrivateKey: identity.privateKey };
}
export async function prepareSavedConnectionEntry(owner: ConnectionEntryOwner, active: SavedConnectionEntry, authKey: string,
  candidate: SavedConnectionEntry, signal: AbortSignal): Promise<SavedConnectionEntry> {
  if (!candidate.requestId) throw new Error('Save the preparation request before dispatch.');
  const result = await clientFor(owner, active).prepareConnectionEntry({ entryId: candidate.sourceId ?? candidate.id, requestId: candidate.requestId,
    clientPublicKey: candidate.clientPublicKey ?? '' }, { signal, headers: { authorization: `Bearer ${authKey}` } });
  return preparedEntry(owner, candidate, result);
}
function preparedEntry(owner: ConnectionEntryOwner, candidate: SavedConnectionEntry, result: PrepareConnectionEntryResponse): SavedConnectionEntry {
  assertNode(owner, result.serverId, result.endpointPublicKey);
  if (result.entry?.entryId !== (candidate.sourceId ?? candidate.id) || result.entry.origin !== candidate.origin || result.entry.transportKind !== candidate.kind) throw new EndpointTrustError('The entrance changed during preparation. Refresh its directory.');
  let transport: EndpointTransport | undefined;
  const locator = result.locator;
  if (locator.case === 'iroh') transport = normalizeEndpointTransport({ kind: 'iroh', endpointId: locator.value.endpointId, ticket: locator.value.ticket,
    clientKey: candidate.clientPrivateKey, clientEndpointId: candidate.clientPublicKey,
    ...(candidate.irohMode ? { mobileMode: candidate.irohMode } : candidate.transport?.kind === 'iroh' && candidate.transport.mobileMode ? { mobileMode: candidate.transport.mobileMode } : {}),
    ...(locator.value.relayUrls.length ? { relayUrls: locator.value.relayUrls } : {}),
    ...(locator.value.relayToken ? { relayToken: locator.value.relayToken,
      relayTokenExpiresAt: locator.value.relayTokenExpiresAt ? Number(locator.value.relayTokenExpiresAt.seconds) * 1000 + locator.value.relayTokenExpiresAt.nanos / 1_000_000 : 0 } : {}) });
  if (locator.case === 'tailcat') transport = normalizeEndpointTransport({ kind: 'tailcat', endpointId: locator.value.endpointId,
    address: locator.value.address, port: locator.value.port, clientKey: candidate.clientPrivateKey,
    ...(locator.value.derpMapUrl ? { derpMapUrl: locator.value.derpMapUrl } : {}) });
  if (locator.case === 'httpConnect') transport = normalizeEndpointTransport({ kind: 'http-connect', proxyOrigin: locator.value.proxyOrigin, authority: locator.value.authority });
  if (candidate.kind === 'webrtc') transport = { kind: 'webrtc' };
  if (candidate.kind !== 'https' && transport?.kind !== candidate.kind || candidate.kind === 'https' && transport) throw new Error('Missing or mismatched prepared carrier.');
  return { ...candidate, prepared: true, ...(transport ? { transport } : {}) };
}

export interface ConnectionEntryStorage {
  read(): Promise<SavedConnectionEntries | undefined>;
  write(value: SavedConnectionEntries): Promise<void>;
}
export async function resolvePreparedConnection(owner: ConnectionEntryOwner, saved: SavedConnectionEntries,
  readAuthKey: () => Promise<string | undefined>, supported: (kind: EndpointTransportKind) => boolean,
  signal: AbortSignal, selectedId?: string, save?: (next: SavedConnectionEntries) => Promise<void>) {
  const failures: unknown[] = [];
  let next = saved;
  for (const entry of connectionEntryCandidates(saved, supported, selectedId)) {
    signal.throwIfAborted();
    try {
      await verifyConnectionEntry(owner, entry, AbortSignal.any([signal, AbortSignal.timeout(entry.kind === 'webrtc' ? 20_000 : 6_000)]));
    } catch (error) {
      signal.throwIfAborted(); failures.push(error);
      next = { ...next, entries: next.entries.map(item => item.id === entry.id ? { ...item,
        verification: isEndpointTrustError(error) ? 'identity-conflict' as const : 'unreachable' as const } : item) };
      await save?.(next); continue;
    }
    const authKey = await readAuthKey();
    signal.throwIfAborted();
    if (!authKey) throw new Error('The saved device credential is unavailable.');
    // Authorization failures are node-wide: never rotate the device identity or
    // try another entrance to evade revocation. This call is read-only.
    const authorizationDeadline = AbortSignal.timeout(10_000);
    try {
      await verifyEntryAuthorization(owner, entry, authKey, AbortSignal.any([signal, authorizationDeadline]));
    } catch (error) {
      signal.throwIfAborted();
      const code = ConnectError.from(error).code;
      const timedOut = authorizationDeadline.aborted && code === Code.Canceled;
      // Only a transport outage is eligible for fallback. Revocation, malformed
      // replies and trust failures must never be disguised as unavailable routes.
      if (isEndpointTrustError(error) || code === Code.Unauthenticated || code === Code.PermissionDenied
        || !timedOut && !entryTransportUnavailable(error)) throw error;
      failures.push(error);
      next = { ...next, entries: next.entries.map(item => item.id === entry.id ? { ...item, verification: 'unreachable' as const } : item) };
      await save?.(next); continue;
    }
    signal.throwIfAborted();
    next = { ...next, entries: next.entries.map(item => item.id === entry.id ? { ...item, verification: 'verified' as const } : item) };
    await save?.(next);
    return { entry, authKey, failures, saved: next };
  }
  if (failures.length) throw failures[0];
  throw new Error('No prepared, permitted entrance is available on this client.');
}
function entryTransportUnavailable(error: unknown): boolean {
  if ([Code.Unavailable, Code.DeadlineExceeded].includes(ConnectError.from(error).code)) return true;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 16 && error instanceof Error && !seen.has(error); depth++) {
    const code = String((error as Error & { code?: unknown }).code);
    if (error.name === 'TimeoutError') return true;
    if (error.name === 'LinkspanError' && ['transport_error', 'unavailable', 'closed', 'deadline_exceeded'].includes(code)) return true;
    if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE'].includes(code)) return true;
    seen.add(error); error = error.cause;
  }
  return false;
}
export async function prepareEntryAndSave(owner: ConnectionEntryOwner, saved: SavedConnectionEntries, candidateId: string,
  active: SavedConnectionEntry, authKey: string, storage: ConnectionEntryStorage, signal: AbortSignal,
  options: { readonly uuid?: () => string; readonly irohMode?: 'native' | 'relay'; readonly renew?: boolean } = {}): Promise<SavedConnectionEntries> {
  let entry = saved.entries.find(candidate => candidate.id === candidateId);
  if (!entry || !entry.published) throw new Error('This entrance is no longer offered by the node.');
  if (entry.verification === 'identity-conflict') {
    await verifyConnectionEntry(owner, entry, signal);
    const next = { ...saved, entries: saved.entries.map(item => item.id === entry!.id ? { ...item, verification: 'verified' as const } : item) };
    await storage.write(next); return next;
  }
  if (entry.prepared && entryReadiness(entry, () => true) === 'ready' && !options.renew) return saved;
  if (entry.prepared && (options.renew || entryReadiness(entry, () => true) === 'expired')) entry = { ...entry, prepared: false, requestId: undefined };
  entry = await beginConnectionEntryPreparation(entry, options);
  signal.throwIfAborted();
  let next = { ...saved, entries: saved.entries.map(item => item.id === entry!.id ? entry! : item) };
  await storage.write(next);
  signal.throwIfAborted();
  let prepared = await prepareSavedConnectionEntry(owner, active, authKey, entry, signal);
  try { await verifyConnectionEntry(owner, prepared, AbortSignal.any([signal, AbortSignal.timeout(6_000)])); prepared = { ...prepared, verification: 'verified' }; }
  catch (error) { signal.throwIfAborted(); prepared = { ...prepared, verification: isEndpointTrustError(error) ? 'identity-conflict' : 'unreachable' }; }
  signal.throwIfAborted();
  next = { ...next, entries: next.entries.map(item => item.id === prepared.id ? prepared : item) };
  await storage.write(next); return next;
}
export function entriesNeedingRenewal(saved: SavedConnectionEntries, supported: (kind: EndpointTransportKind) => boolean, now = Date.now()): readonly string[] {
  return [saved.preferredId, ...saved.backupIds].filter(id => {
    const entry = saved.entries.find(e => e.id === id);
    return entry?.published && supported(entry.kind) && entry.transport?.kind === 'iroh'
      && entry.transport.relayTokenExpiresAt !== undefined && entry.transport.relayTokenExpiresAt <= now + 120_000;
  });
}
/** After approval, prepare the chosen carrier using this device's new authorization. */
export async function prepareSelectedConnectionEntry(owner: ConnectionEntryOwner, saved: SavedConnectionEntries, serverEntryId: string,
  active: SavedConnectionEntry, authKey: string, storage: ConnectionEntryStorage, supported: (kind: EndpointTransportKind) => boolean,
  signal: AbortSignal, options: { readonly uuid?: () => string; readonly irohMode?: 'native' | 'relay' } = {}) {
  let next = mergeConnectionEntryDirectory(saved, owner, await readConnectionEntryDirectory(owner, active, authKey, signal));
  const selected = next.entries.find(entry => entry.id === serverEntryId || entry.sourceId === serverEntryId);
  if (!selected || !supported(selected.kind)) throw new Error('The chosen connection method is unavailable on this device.');
  await storage.write(next);
  next = await prepareEntryAndSave(owner, next, selected.id, active, authKey, storage, signal, options);
  return { entryId: selected.id, saved: next };
}
