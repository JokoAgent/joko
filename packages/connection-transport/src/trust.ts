import { isPrivateLanDiscoveryHost } from '@joko/contracts';
import { assertHttpConnectOrigin, normalizeEndpointTransport, rememberEndpointTransport, selectEndpointTransport, type EndpointTransport, type EndpointTransportKind } from './endpoint-transport.js';
export * from './new-device.js';
export * from './endpoint-transport.js';

export interface EndpointTrust {
  readonly origin: string;
  readonly endpointPublicKey?: string;
  readonly serverId?: string;
  readonly transportKind?: EndpointTransportKind;
  /** Private locator supplied by a trusted invitation or protected storage. */
  readonly endpointTransport?: EndpointTransport;
}

// This cache contains public pins supplied by a trusted profile or explicit
// invitation import. Discovery responses must never populate it.
const pins = new Map<string, string>();
const nodeIds = new Map<string, string>();

export class EndpointTrustError extends Error {
  constructor(message = 'The node security check failed. Verify its public key through the local console or a trusted device before reconnecting. The saved credential was kept.', options?: ErrorOptions) {
    super(message, options);
    this.name = 'EndpointTrustError';
  }
}

export function isEndpointTrustError(error: unknown): boolean {
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 16 && error instanceof Error && !seen.has(error); depth += 1) {
    if (error instanceof EndpointTrustError || error.name === 'EndpointTrustError') return true;
    if (error.name === 'LinkspanError' && ['identity_mismatch', 'authentication_failed', 'protocol_error'].includes(String((error as Error & { code?: unknown }).code))) return true;
    seen.add(error);
    error = error.cause;
  }
  return false;
}

const trustObservers = new Set<{ readonly origin: string; readonly key: string; readonly failed: (error: EndpointTrustError) => void }>();

/** Bound to one current connection occurrence; callers release it on retirement. */
export function observeEndpointTrustFailure(input: EndpointTrust, failed: (error: EndpointTrustError) => void): () => void {
  const origin = endpointOrigin(input.origin), key = input.endpointPublicKey ?? pins.get(origin);
  if (key === undefined) return () => {};
  const observer = { origin, key: normalizeEndpointPublicKey(key), failed };
  trustObservers.add(observer);
  return () => { trustObservers.delete(observer); };
}

/** Captures current occurrences so a retired channel cannot suspend a successor. */
export function captureEndpointTrustFailure(input: EndpointTrust): (error: unknown) => void {
  const origin = endpointOrigin(input.origin);
  const observers = [...trustObservers].filter(observer => observer.origin === origin && observer.key === input.endpointPublicKey);
  return error => {
    if (!isEndpointTrustError(error)) return;
    for (const observer of observers) {
      if (!trustObservers.delete(observer)) continue;
      try { observer.failed(new EndpointTrustError(undefined, { cause: error })); } catch { /* Retired observers cannot change the transport result. */ }
    }
  };
}

export function reportEndpointTrustFailure(input: EndpointTrust, error: unknown): void {
  captureEndpointTrustFailure(input)(error);
}

export function normalizeEndpointPublicKey(value: string): string {
  const key = value.trim().toLowerCase();
  if (!/^ed25519:[a-f0-9]{64}$/u.test(key)) throw new Error("Enter the complete trusted endpoint public key (ed25519: followed by 64 hexadecimal characters).");
  return key;
}

export function endpointOrigin(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error("A Joko endpoint must be an HTTP(S) origin without credentials, path, query or fragment.");
  }
  return url.origin;
}

export function isLoopbackEndpoint(origin: string): boolean {
  // Unpinned local trust is narrower than a pinned carrier's allowed aliases:
  // arbitrary *.localhost names are not guaranteed loopback by Node's DNS API.
  const host = new URL(endpointOrigin(origin)).hostname.toLowerCase().replace(/^\[|\]$/gu, '').replace(/\.$/u, '');
  if (host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  const parts = host.split('.');
  return parts.length === 4 && parts[0] === '127' && parts.every(part => /^(0|[1-9][0-9]{0,2})$/u.test(part) && Number(part) <= 255);
}

/** The host's explicitly enabled, restricted HTTP mode remains unencrypted.
 * Supplying a pin always selects the authenticated channel instead. */
export function allowsUnpinnedEndpoint(origin: string): boolean {
  const url = new URL(endpointOrigin(origin));
  return isLoopbackEndpoint(origin) || url.protocol === 'http:' && isPrivateLanDiscoveryHost(url.hostname);
}

export function rememberEndpointTrust(input: EndpointTrust): string | undefined {
  const origin = endpointOrigin(input.origin);
  if (input.endpointPublicKey === undefined) return pins.get(origin);
  const key = normalizeEndpointPublicKey(input.endpointPublicKey);
  const previous = pins.get(origin);
  if (previous !== undefined && previous !== key) throw new EndpointTrustError("The endpoint public key conflicts with the trusted connection. Verify the node through its local console or a trusted device before replacing its identity.");
  if (input.serverId !== undefined) {
    if (!/^[a-z0-9][a-z0-9._:-]{0,255}$/iu.test(input.serverId)) throw new Error('The trusted node identity is invalid.');
    assertTrustedEndpointServerId(origin, input.serverId);
  }
  if (input.endpointTransport !== undefined) {
    const transport = normalizeEndpointTransport(input.endpointTransport);
    if (input.transportKind !== undefined && input.transportKind !== transport.kind) throw new Error('The selected backend does not match its private locator.');
    rememberEndpointTransport(origin, key, transport, true);
  }
  else if (input.transportKind !== undefined) selectEndpointTransport(origin, key, input.transportKind);
  if (input.serverId !== undefined) nodeIds.set(origin, input.serverId);
  pins.set(origin, key);
  return key;
}

export function trustedEndpointPublicKey(origin: string): string | undefined { return pins.get(endpointOrigin(origin)); }
export function assertTrustedEndpointServerId(origin: string, serverId: string): void {
  const expected = nodeIds.get(endpointOrigin(origin));
  if (expected !== undefined && expected !== serverId) throw new EndpointTrustError('This address returned a different node identity from the trusted invitation or saved connection. Verify it through explicit node recovery before pairing.');
}

/** Only call after an explicit, trusted recovery/import decision. */
export function replaceEndpointTrust(input: EndpointTrust & { readonly endpointPublicKey: string }): void {
  const origin = endpointOrigin(input.origin), key = normalizeEndpointPublicKey(input.endpointPublicKey);
  if (input.serverId !== undefined && !/^[a-z0-9][a-z0-9._:-]{0,255}$/iu.test(input.serverId)) throw new Error('The trusted node identity is invalid.');
  if (input.endpointTransport !== undefined) {
    const transport = normalizeEndpointTransport(input.endpointTransport);
    if (input.transportKind !== undefined && input.transportKind !== transport.kind) throw new Error('The selected backend does not match its private locator.');
    rememberEndpointTransport(origin, key, transport, true);
  }
  else if (input.transportKind !== undefined) selectEndpointTransport(origin, key, input.transportKind);
  pins.set(origin, key);
  if (input.serverId === undefined) nodeIds.delete(origin); else nodeIds.set(origin, input.serverId);
}

export function requireEndpointTrust(input: EndpointTrust): string | undefined {
  const key = rememberEndpointTrust(input);
  if (key === undefined && (input.endpointTransport !== undefined || input.transportKind !== undefined && input.transportKind !== 'https' || !allowsUnpinnedEndpoint(input.origin))) {
    throw new EndpointTrustError("This node requires its trusted endpoint public key. Obtain it from the node console or an already authorized device before connecting.");
  }
  return key;
}

export interface TrustedNodeInvitation { readonly version: 1; readonly origin: string; readonly endpointPublicKey: string; readonly serverId?: string; readonly endpointTransport?: EndpointTransport }
export interface NodePairingInvitation {
  readonly challengeId: string;
  readonly humanCode: string;
  readonly expiresAt: number;
  readonly origin: string;
  readonly serverId: string;
  readonly endpointPublicKey: string;
  readonly trustedInvitation: string;
  readonly endpointTransport?: EndpointTransport;
}

/** Issued inside the authenticated node channel; it changes location, never trust. */
export function pairingVerificationOrigin(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== '/pair' || url.search || url.hash) throw new Error('The pairing verification address is invalid.');
  return endpointOrigin(url.origin);
}

export function formatTrustedNodeInvitation(input: EndpointTrust & { readonly endpointPublicKey: string; readonly serverId?: string }): string {
  const origin = endpointOrigin(input.origin), transport = input.endpointTransport === undefined ? undefined : normalizeEndpointTransport(input.endpointTransport);
  if (transport?.kind === 'http-connect') assertHttpConnectOrigin(transport, origin);
  const value = JSON.stringify({ version: 1, origin, endpointPublicKey: normalizeEndpointPublicKey(input.endpointPublicKey), ...(input.serverId === undefined ? {} : { serverId: input.serverId }),
    ...(transport === undefined ? {} : { endpointTransport: transport }) });
  if (value.length > 32768) throw new Error('The trusted node invitation is too large.');
  return value;
}

export function parseTrustedNodeInvitation(value: string): TrustedNodeInvitation {
  if (value.length > 32768) throw new Error("The trusted node invitation is too large.");
  const input: unknown = JSON.parse(value);
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error("The trusted node invitation is invalid.");
  const record = input as Record<string, unknown>;
  if (record['version'] !== 1 || typeof record['origin'] !== 'string' || typeof record['endpointPublicKey'] !== 'string'
    || Object.keys(record).some(key => !['version', 'origin', 'endpointPublicKey', 'serverId', 'endpointTransport'].includes(key))
    || record['serverId'] !== undefined && (typeof record['serverId'] !== 'string' || !/^[a-z0-9][a-z0-9._:-]{0,255}$/iu.test(record['serverId']))) {
    throw new Error("The trusted node invitation is invalid.");
  }
  const origin = endpointOrigin(record['origin']), transport = record['endpointTransport'] === undefined ? undefined : normalizeEndpointTransport(record['endpointTransport']);
  if (transport?.kind === 'http-connect') assertHttpConnectOrigin(transport, origin);
  return { version: 1, origin, endpointPublicKey: normalizeEndpointPublicKey(record['endpointPublicKey']),
    ...(record['serverId'] === undefined ? {} : { serverId: record['serverId'] as string }),
    ...(transport === undefined ? {} : { endpointTransport: transport }) };
}
