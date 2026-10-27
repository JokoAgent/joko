import { createHash } from 'node:crypto';
import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import { Code, ConnectError } from '@connectrpc/connect';
import { NodeConnectionEntrySchema, PrepareConnectionEntryResponseSchema } from '@joko/contracts';
import type { OperationalStore } from '@joko/store';
import type { EndpointTransport } from '@joko/connection-transport/trust';
import type { OrchestratorApplication } from './application.js';
import { issueAuthorizedIrohRelayInvitation } from './linkspan-iroh-lease.js';

export interface PublishedConnectionEntry {
  readonly id: string;
  readonly provider: string;
  readonly displayName?: string;
  readonly origin: string;
  readonly transport?: EndpointTransport;
  readonly managedIrohLease?: boolean;
  readonly allowedClients?: readonly string[];
  readonly allowPrivateAddressPairing?: boolean;
}
// Live handles only. A persisted connector journal cannot publish an entrance.
const published = new WeakMap<OperationalStore, Map<string, PublishedConnectionEntry>>();
const webRtcBridges = new WeakMap<OperationalStore, number>();
export function publishWebRtcConnectionEntry(store: OperationalStore): () => void {
  webRtcBridges.set(store, (webRtcBridges.get(store) ?? 0) + 1);
  let closed = false;
  return () => { if (!closed) { closed = true; webRtcBridges.set(store, Math.max(0, (webRtcBridges.get(store) ?? 1) - 1)); } };
}
export function publishConnectionEntry(store: OperationalStore, entry: PublishedConnectionEntry): () => void {
  let entries = published.get(store);
  if (!entries) { entries = new Map(); published.set(store, entries); }
  if (entries.has(entry.id) || entries.size >= 62) throw new Error('The connection entrance is already published or the directory is full.');
  entries.set(entry.id, entry);
  return () => { if (entries!.get(entry.id) === entry) entries!.delete(entry.id); };
}
function entriesFor(application: OrchestratorApplication): PublishedConnectionEntry[] {
  return entriesForStore(application.store, application.config.publicOrigin);
}
function entriesForStore(store: OperationalStore, origin: string): PublishedConnectionEntry[] {
  return [{ id: 'direct', provider: 'direct', origin },
    ...(webRtcBridges.get(store) ? [{ id: 'webrtc', provider: 'webrtc', origin, transport: { kind: 'webrtc' as const } }] : []),
    ...published.get(store)?.values() ?? []];
}
function summary(entry: PublishedConnectionEntry) {
  return create(NodeConnectionEntrySchema, { entryId: entry.id, displayName: entry.displayName ?? (entry.id === 'direct' ? 'Direct' : `${entry.provider} · ${entry.id.replace(/^linkspan:/u, '')}`),
    provider: entry.provider, origin: entry.origin, transportKind: entry.transport?.kind ?? 'https',
    requiresClientIdentity: entry.transport?.kind === 'iroh' || entry.transport?.kind === 'tailcat',
    requiresServerSetup: entry.transport?.kind === 'tailcat' && !entry.allowPrivateAddressPairing });
}
export function connectionEntryDirectory(application: OrchestratorApplication) {
  const entries = entriesFor(application).map(summary);
  return { serverId: application.serverId, endpointPublicKey: application.linkspanIdentity?.publicKey ?? '',
    revision: createHash('sha256').update(JSON.stringify(entries)).digest('hex'), entries };
}
export function publicConnectionCapabilities(store: OperationalStore, origin: string) {
  const entries = entriesForStore(store, origin).map(summary);
  return { connectionKinds: [...new Set(entries.map(entry => entry.transportKind))],
    connectionDirectoryRevision: createHash('sha256').update(JSON.stringify(entries)).digest('hex') };
}
export async function prepareConnectionEntry(application: OrchestratorApplication, input: {
  readonly entryId: string; readonly requestId: string; readonly clientPublicKey: string;
  readonly connectionId: string; readonly signal: AbortSignal; readonly assertCurrent: () => void;
}) {
  input.assertCurrent();
  const entry = entriesFor(application).find(item => item.id === input.entryId);
  if (!entry || !application.linkspanIdentity) throw new ConnectError('This entrance is no longer published.', Code.FailedPrecondition);
  const response = create(PrepareConnectionEntryResponseSchema, { entry: summary(entry), serverId: application.serverId,
    endpointPublicKey: application.linkspanIdentity.publicKey });
  const transport = entry.transport;
  if (transport?.kind === 'http-connect') response.locator = { case: 'httpConnect', value: { $typeName: 'joko.v1.ConnectionEntryHttpConnect', proxyOrigin: transport.proxyOrigin, authority: transport.authority } };
  if (transport?.kind === 'iroh') {
    if (!/^[a-f0-9]{64}$/u.test(input.clientPublicKey)) throw new ConnectError('A device-owned iroh identity is required.', Code.InvalidArgument);
    const lease = entry.managedIrohLease ? await issueAuthorizedIrohRelayInvitation(application, { requestId: input.requestId,
      nodeEndpointId: transport.endpointId, recipientEndpointId: input.clientPublicKey, ownerConnectionId: input.connectionId,
      signal: input.signal, assertCurrent: input.assertCurrent }) : undefined;
    response.locator = { case: 'iroh', value: { $typeName: 'joko.v1.ConnectionEntryIroh', endpointId: transport.endpointId, ticket: transport.ticket,
      relayUrls: [...transport.relayUrls ?? []], relayToken: lease?.relayToken ?? '',
      ...(lease ? { relayTokenExpiresAt: timestampFromDate(new Date(lease.expiresAt)) } : {}) } };
  }
  if (transport?.kind === 'tailcat') {
    if (!/^nodekey:[a-f0-9]{64}$/u.test(input.clientPublicKey)) throw new ConnectError('A device-owned tailcat identity is required.', Code.InvalidArgument);
    if (!entry.allowPrivateAddressPairing && !entry.allowedClients?.includes(input.clientPublicKey)) {
      throw new ConnectError('This entrance requires the node to authorize this device transport identity.', Code.PermissionDenied);
    }
    response.locator = { case: 'tailcat', value: { $typeName: 'joko.v1.ConnectionEntryTailcat', endpointId: transport.endpointId,
      address: transport.address, port: transport.port, derpMapUrl: transport.derpMapUrl ?? '' } };
  }
  input.assertCurrent(); input.signal.throwIfAborted();
  if (!entriesFor(application).some(current => current === entry || ['direct', 'webrtc'].includes(entry.id) && current.id === entry.id && current.origin === entry.origin)) throw new ConnectError('The publishing entrance was retired.', Code.FailedPrecondition);
  return response;
}
