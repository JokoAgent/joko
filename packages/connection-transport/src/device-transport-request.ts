import { beginConnectionEntryPreparation } from './entries.js';
import { normalizeEndpointTransport, type EndpointTransport } from './trust.js';
import type { PrepareConnectionEntryResponse } from '@joko/contracts';

export interface DeviceTransportRequest {
  readonly requestId: string; readonly kind: 'iroh' | 'tailcat'; readonly publicKey: string; readonly expiresAt: number;
}
export interface DeviceTransportRequestDraft extends DeviceTransportRequest { readonly privateKey: string; readonly mobileMode?: 'native' | 'relay' }
export function formatDeviceTransportRequest(value: DeviceTransportRequest): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value.requestId)
    || !['iroh', 'tailcat'].includes(value.kind) || !(value.kind === 'iroh' ? /^[a-f0-9]{64}$/u : /^nodekey:[a-f0-9]{64}$/u).test(value.publicKey)
    || !Number.isSafeInteger(value.expiresAt) || value.expiresAt < 1 || value.expiresAt > 8.64e15) throw new Error('Invalid device transport request.');
  return `joko://device-request#${new URLSearchParams({ v: '1', i: value.requestId, k: value.kind, p: value.publicKey, e: String(value.expiresAt) })}`;
}
export function parseDeviceTransportRequest(link: string): DeviceTransportRequest {
  if (typeof link !== 'string' || link.length > 512 || !link.startsWith('joko://device-request#')) throw new Error('Use the request link shown on the new device.');
  const url = new URL(link), p = new URLSearchParams(url.hash.slice(1));
  if (url.pathname || url.search || url.username || url.password || [...p.keys()].sort().join(',') !== 'e,i,k,p,v' || p.get('v') !== '1') throw new Error('Invalid device transport request.');
  const value = { requestId: p.get('i')!, kind: p.get('k') as DeviceTransportRequest['kind'], publicKey: p.get('p')!, expiresAt: Number(p.get('e')) };
  formatDeviceTransportRequest(value); return value;
}
export function parseDeviceTransportRequestDraft(value: unknown): DeviceTransportRequestDraft {
  if (!value || typeof value !== 'object') throw new Error('The local device request is unreadable.');
  const draft = value as DeviceTransportRequestDraft, request = parseDeviceTransportRequest(formatDeviceTransportRequest(draft));
  if (typeof draft.privateKey !== 'string' || !(draft.kind === 'iroh' ? /^[a-f0-9]{64}$/u : /^privkey:[a-f0-9]{64}$/u).test(draft.privateKey)) throw new Error('The original local device identity is unavailable.');
  if (draft.mobileMode !== undefined && (draft.kind !== 'iroh' || !['native', 'relay'].includes(draft.mobileMode))) throw new Error('Invalid local transport mode.');
  return { ...request, privateKey: draft.privateKey, ...(draft.mobileMode ? { mobileMode: draft.mobileMode } : {}) };
}
export async function createDeviceTransportRequest(kind: DeviceTransportRequest['kind'], uuid: () => string, mode: 'native' | 'relay' = 'relay'): Promise<DeviceTransportRequestDraft> {
  const prepared = await beginConnectionEntryPreparation({ id: 'request', name: '', provider: kind, origin: 'https://device.invalid', kind, published: true, prepared: false }, { uuid, irohMode: mode });
  return parseDeviceTransportRequestDraft({ requestId: prepared.requestId, kind, publicKey: prepared.clientPublicKey, privateKey: prepared.clientPrivateKey, expiresAt: Date.now() + 600_000,
    ...(kind === 'iroh' ? { mobileMode: mode } : {}) });
}
/** Private locator and a lease for the requesting device, never the inviter's key. */
export function invitationTransport(result: PrepareConnectionEntryResponse, request?: DeviceTransportRequest): EndpointTransport | undefined {
  const locator = result.locator;
  if (locator.case === 'iroh') return normalizeEndpointTransport({ kind: 'iroh', endpointId: locator.value.endpointId, ticket: locator.value.ticket,
    ...(request ? { clientEndpointId: request.publicKey } : {}), ...(locator.value.relayUrls.length ? { relayUrls: locator.value.relayUrls } : {}),
    ...(locator.value.relayToken ? { relayToken: locator.value.relayToken, relayTokenExpiresAt: Number(locator.value.relayTokenExpiresAt!.seconds) * 1000 + locator.value.relayTokenExpiresAt!.nanos / 1_000_000 } : {}) });
  if (locator.case === 'tailcat') return normalizeEndpointTransport({ kind: 'tailcat', endpointId: locator.value.endpointId, address: locator.value.address, port: locator.value.port,
    ...(locator.value.derpMapUrl ? { derpMapUrl: locator.value.derpMapUrl } : {}) });
  if (locator.case === 'httpConnect') return normalizeEndpointTransport({ kind: 'http-connect', proxyOrigin: locator.value.proxyOrigin, authority: locator.value.authority });
  if (result.entry?.transportKind === 'webrtc') return { kind: 'webrtc' };
  if (result.entry?.transportKind !== 'https') throw new Error('The node did not return the selected connection material.');
  return undefined;
}
