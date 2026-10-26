import { endpointOrigin, normalizeEndpointPublicKey } from './trust.js';
import type { ByteChannel, OperationOptions } from '@jokoagent/linkspan-core';

export type EndpointTransportKind = 'https' | 'iroh' | 'tailcat' | 'webrtc' | 'http-connect';
/** Private connection material. A tailcat address contains a pre-shared secret. */
export type EndpointTransport =
  | { readonly kind: 'iroh'; readonly ticket: string; readonly endpointId: string; readonly clientKey?: string; readonly clientEndpointId?: string; readonly relayUrls?: readonly string[]; readonly relayToken?: string; readonly relayTokenExpiresAt?: number; readonly mobileMode?: 'native' | 'relay' }
  | { readonly kind: 'tailcat'; readonly address: string; readonly endpointId: string; readonly port: number; readonly clientKey?: string; readonly derpMapUrl?: string }
  | { readonly kind: 'webrtc' }
  | { readonly kind: 'http-connect'; readonly proxyOrigin: string; readonly authority: string };

const transports = new Map<string, EndpointTransport>();
const selected = new Map<string, EndpointTransportKind>();
const irohClientKeys = new Map<string, string>();
const unboundIrohClientKeys = new Map<string, string>();
const generatedIrohClients = new Map<string, { readonly privateKey: string; readonly publicKey: string }>();
const generatedTailcatClients = new Map<string, { readonly location: Extract<EndpointTransport, { kind: 'tailcat' }>; readonly privateKey: string }>();
let prepareRuntime: ((kind: 'iroh' | 'tailcat') => Promise<void>) | undefined;
export interface WebRtcClientBinding {
  connect(origin: string, expectedPublicKey: string, options: OperationOptions): Promise<ByteChannel>;
}
let webRtcBinding: WebRtcClientBinding | undefined;
export function installWebRtcClientBinding(binding: WebRtcClientBinding): () => void {
  if (webRtcBinding !== undefined) throw new Error('The local WebRTC client binding is already installed.');
  webRtcBinding = binding;
  return () => { if (webRtcBinding === binding) webRtcBinding = undefined; };
}
export function localWebRtcClientBinding(): WebRtcClientBinding | undefined { return webRtcBinding; }
export interface HttpConnectClientBinding {
  connect(transport: Extract<EndpointTransport, { kind: 'http-connect' }>, options: OperationOptions & { readonly expectedPublicKey: string }): Promise<ByteChannel>;
}
let httpConnectBinding: HttpConnectClientBinding | undefined;
export function installHttpConnectClientBinding(binding: HttpConnectClientBinding): () => void {
  if (httpConnectBinding !== undefined) throw new Error('The local HTTP CONNECT client binding is already installed.');
  httpConnectBinding = binding;
  return () => { if (httpConnectBinding === binding) httpConnectBinding = undefined; };
}
export function localHttpConnectClientBinding(): HttpConnectClientBinding | undefined { return httpConnectBinding; }

export function endpointHttpConnectAuthority(origin: string): string {
  const url = new URL(endpointOrigin(origin));
  return `${url.hostname}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`;
}
export function assertHttpConnectOrigin(transport: Extract<EndpointTransport, { kind: 'http-connect' }>, origin: string): void {
  if (transport.authority !== endpointHttpConnectAuthority(origin)) throw new Error('The HTTP CONNECT authority does not match the trusted node origin.');
}
export interface IrohClientBinding {
  connect(transport: Extract<EndpointTransport, { kind: 'iroh' }>, options: OperationOptions & { readonly expectedPublicKey: string }): Promise<ByteChannel>;
  createIdentity(mode: 'native' | 'relay'): Promise<{ readonly privateKey: string; readonly publicKey: string }>;
}
export interface TailcatClientBinding {
  connect(transport: Extract<EndpointTransport, { kind: 'tailcat' }>, options: OperationOptions & { readonly expectedPublicKey: string }): Promise<ByteChannel>;
  createIdentity(): Promise<{ readonly privateKey: string; readonly publicKey: string; readonly presharedKey?: string }>;
}
let irohBinding: IrohClientBinding | undefined;
let tailcatBinding: TailcatClientBinding | undefined;
/** Mobile chooses its own local carrier for each profile; existing streams retain theirs. */
export function installIrohClientBinding(binding: IrohClientBinding): () => void {
  if (irohBinding !== undefined) throw new Error('The local iroh client binding is already installed.');
  irohBinding = binding;
  return () => { if (irohBinding === binding) irohBinding = undefined; };
}
export function localIrohClientBinding(): IrohClientBinding | undefined { return irohBinding; }
export function installTailcatClientBinding(binding: TailcatClientBinding): () => void {
  if (tailcatBinding !== undefined) throw new Error('The local tailcat client binding is already installed.');
  tailcatBinding = binding;
  return () => { if (tailcatBinding === binding) tailcatBinding = undefined; };
}
export function localTailcatClientBinding(): TailcatClientBinding | undefined { return tailcatBinding; }

/** Native shells supply the selected backend's local runtime host. No backend starts here. */
export function installEndpointTransportPreparation(prepare: (kind: 'iroh' | 'tailcat') => Promise<void>): () => void {
  if (prepareRuntime !== undefined) throw new Error('The native connection runtime is already installed.');
  prepareRuntime = prepare;
  return () => { if (prepareRuntime === prepare) prepareRuntime = undefined; };
}

export async function prepareEndpointTransportRuntime(kind: 'iroh' | 'tailcat'): Promise<void> {
  await prepareRuntime?.(kind);
}

export function normalizeEndpointTransport(value: unknown): EndpointTransport {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('The private connection transport is invalid.');
  const input = value as Record<string, unknown>;
  if (input['kind'] === 'webrtc' && Object.keys(input).length === 1) return Object.freeze({ kind: 'webrtc' });
  const text = (item: unknown, maximum: number): item is string => typeof item === 'string' && item.length > 0 && item.length <= maximum && item === item.trim() && !/[\u0000-\u001f\u007f]/u.test(item);
  if (input['kind'] === 'http-connect') {
    if (Object.keys(input).sort().join(',') !== 'authority,kind,proxyOrigin' || !text(input['proxyOrigin'], 2048) || !text(input['authority'], 260)) throw new Error('The HTTP CONNECT locator is invalid.');
    const proxy = new URL(input['proxyOrigin']);
    if (!['http:', 'https:'].includes(proxy.protocol) || proxy.origin !== input['proxyOrigin'] || proxy.username || proxy.password || proxy.pathname !== '/' || proxy.search || proxy.hash) throw new Error('The HTTP CONNECT proxy must be an HTTP(S) origin without credentials or a path.');
    const separator = input['authority'].lastIndexOf(':');
    const host = input['authority'].slice(0, separator), port = input['authority'].slice(separator + 1);
    if (separator < 1 || !/^[1-9][0-9]{0,4}$/u.test(port) || Number(port) > 65535) throw new Error('The HTTP CONNECT authority requires an explicit valid port.');
    const target = new URL(`http://${host}`);
    if (target.hostname !== host || target.username || target.password || target.port || target.pathname !== '/' || target.search || target.hash
      || !host.startsWith('[') && !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))) throw new Error('The HTTP CONNECT authority hostname is invalid.');
    return Object.freeze({ kind: 'http-connect', proxyOrigin: proxy.origin, authority: `${host}:${port}` });
  }
  if (!text(input['endpointId'], 512)) throw new Error('The transport endpoint identity is invalid.');
  const https = (item: unknown): item is string => {
    if (!text(item, 2048)) return false;
    try { const url = new URL(item); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash; } catch { return false; }
  };
  if (input['kind'] === 'iroh' && /^[0-9a-f]{64}$/u.test(input['endpointId']) && text(input['ticket'], 8192) && input['ticket'].length >= 16) {
    if (Object.keys(input).some(name => !['kind', 'endpointId', 'ticket', 'clientKey', 'clientEndpointId', 'relayUrls', 'relayToken', 'relayTokenExpiresAt', 'mobileMode'].includes(name))
      || input['mobileMode'] !== undefined && input['mobileMode'] !== 'native' && input['mobileMode'] !== 'relay'
      || input['clientKey'] !== undefined && (typeof input['clientKey'] !== 'string' || !/^[a-f0-9]{64}$/u.test(input['clientKey']))
      || input['clientEndpointId'] !== undefined && (typeof input['clientEndpointId'] !== 'string' || !/^[a-f0-9]{64}$/u.test(input['clientEndpointId']))
      || input['relayUrls'] !== undefined && (!Array.isArray(input['relayUrls']) || input['relayUrls'].length > 8 || !input['relayUrls'].every(https))
      || input['relayToken'] !== undefined && (!text(input['relayToken'], 16384) || input['clientEndpointId'] === undefined || input['relayUrls'] === undefined || Array.isArray(input['relayUrls']) && input['relayUrls'].length === 0
        || !Number.isSafeInteger(input['relayTokenExpiresAt']) || Number(input['relayTokenExpiresAt']) <= 0 || Number(input['relayTokenExpiresAt']) > Date.now() + 86_400_000)
      || input['relayToken'] === undefined && input['relayTokenExpiresAt'] !== undefined) throw new Error('The private iroh client identity or relay lease is invalid.');
    return Object.freeze({ kind: 'iroh', endpointId: input['endpointId'], ticket: input['ticket'],
      ...(input['mobileMode'] === undefined ? {} : { mobileMode: input['mobileMode'] as 'native' | 'relay' }),
      ...(input['clientKey'] === undefined ? {} : { clientKey: input['clientKey'] as string }),
      ...(input['clientEndpointId'] === undefined ? {} : { clientEndpointId: input['clientEndpointId'] as string }),
      ...(input['relayUrls'] === undefined ? {} : { relayUrls: Object.freeze([...(input['relayUrls'] as string[])]) }),
      ...(input['relayToken'] === undefined ? {} : { relayToken: input['relayToken'] as string, relayTokenExpiresAt: Number(input['relayTokenExpiresAt']) }) });
  }
  const tailcatFields = ['address', 'endpointId', 'kind', 'port', ...(input['clientKey'] === undefined ? [] : ['clientKey']), ...(input['derpMapUrl'] === undefined ? [] : ['derpMapUrl'])];
  if (input['kind'] === 'tailcat' && Object.keys(input).length === tailcatFields.length && Object.keys(input).every(name => tailcatFields.includes(name))
    && /^nodekey:[0-9a-f]{64}$/u.test(input['endpointId'])
    && (input['clientKey'] === undefined || typeof input['clientKey'] === 'string' && /^privkey:[0-9a-f]{64}$/u.test(input['clientKey']))
    && (input['derpMapUrl'] === undefined || https(input['derpMapUrl']))
    && text(input['address'], 8192) && /^tc[A-Za-z0-9_-]+$/u.test(input['address']) && Number.isSafeInteger(input['port']) && Number(input['port']) > 0 && Number(input['port']) <= 65535) {
    return Object.freeze({ kind: 'tailcat', endpointId: input['endpointId'], address: input['address'], port: Number(input['port']), ...(input['clientKey'] === undefined ? {} : { clientKey: input['clientKey'] as string }), ...(input['derpMapUrl'] === undefined ? {} : { derpMapUrl: input['derpMapUrl'] as string }) });
  }
  throw new Error('The private connection transport is invalid.');
}

/** A new device supplies its own allowlisted key; never clone this device's key. */
export function endpointTransportForNewDevice(transport: EndpointTransport | undefined): EndpointTransport | undefined {
  if (transport?.kind === 'iroh') return Object.freeze({ kind: 'iroh', endpointId: transport.endpointId, ticket: transport.ticket, ...(transport.relayUrls === undefined ? {} : { relayUrls: transport.relayUrls }) });
  if (transport?.kind !== 'tailcat') return transport;
  return Object.freeze({ kind: 'tailcat', endpointId: transport.endpointId, address: transport.address, port: transport.port, ...(transport.derpMapUrl === undefined ? {} : { derpMapUrl: transport.derpMapUrl }) });
}

function ownerKey(origin: string, publicKey: string): string { return JSON.stringify([endpointOrigin(origin), normalizeEndpointPublicKey(publicKey)]); }
function irohClientKey(publicKey: string, clientEndpointId: string): string { return `${normalizeEndpointPublicKey(publicKey)}:${clientEndpointId}`; }
function rememberIrohClientKey(publicKey: string, clientEndpointId: string, privateKey: string): void {
  const key = irohClientKey(publicKey, clientEndpointId), previous = irohClientKeys.get(key);
  if (previous !== undefined && previous !== privateKey) throw new Error('The imported iroh private key conflicts with this device\'s retained identity. Restore its original key instead of replacing it.');
  irohClientKeys.set(key, privateKey);
}

/** Called only after a private invitation import or a protected storage read. */
export function rememberEndpointTransport(origin: string, publicKey: string, value: EndpointTransport, useGeneratedIdentity = false): void {
  let transport = normalizeEndpointTransport(value);
  if (transport.kind === 'http-connect') assertHttpConnectOrigin(transport, origin);
  const owner = ownerKey(origin, publicKey);
  const previous = transports.get(`${owner}:${transport.kind}`);
  if (transport.kind === 'iroh') {
    const generated = useGeneratedIdentity ? generatedIrohClients.get(owner) : undefined;
    if (transport.clientKey === undefined && transport.clientEndpointId === undefined && generated !== undefined) transport = Object.freeze({ ...transport, clientKey: generated.privateKey, clientEndpointId: generated.publicKey });
    if (transport.clientKey !== undefined && transport.clientEndpointId !== undefined) rememberIrohClientKey(publicKey, transport.clientEndpointId, transport.clientKey);
    if (transport.clientKey === undefined && transport.clientEndpointId !== undefined) {
      const clientKey = irohClientKeys.get(irohClientKey(publicKey, transport.clientEndpointId))
        ?? (useGeneratedIdentity ? unboundIrohClientKeys.get(transport.clientEndpointId) : undefined);
      if (clientKey !== undefined) {
        rememberIrohClientKey(publicKey, transport.clientEndpointId, clientKey);
        if (useGeneratedIdentity) unboundIrohClientKeys.delete(transport.clientEndpointId);
        transport = Object.freeze({ ...transport, clientKey });
      }
    } else if (transport.clientKey === undefined && transport.relayToken === undefined && previous?.kind === 'iroh' && previous.clientKey !== undefined && transport.endpointId === previous.endpointId) {
      transport = Object.freeze({ ...transport, clientKey: previous.clientKey, ...(previous.clientEndpointId === undefined ? {} : { clientEndpointId: previous.clientEndpointId }) });
    }
  }
  const generated = useGeneratedIdentity && transport.kind === 'tailcat' ? generatedTailcatClients.get(owner) : undefined;
  if (generated !== undefined && transport.kind === 'tailcat' && transport.clientKey === undefined && transport.address === generated.location.address
    && transport.endpointId === generated.location.endpointId && transport.port === generated.location.port) transport = Object.freeze({ ...transport, clientKey: generated.privateKey });
  if (transport.kind === 'tailcat' && transport.clientKey === undefined && previous?.kind === 'tailcat' && previous.clientKey !== undefined
    && transport.address === previous.address && transport.endpointId === previous.endpointId && transport.port === previous.port) {
    transport = Object.freeze({ ...transport, clientKey: previous.clientKey });
  }
  transports.set(`${owner}:${transport.kind}`, transport);
  selected.set(owner, transport.kind);
}

export async function createIrohClientIdentity(origin?: string, publicKey?: string, value?: EndpointTransport, mobileMode?: 'native' | 'relay'): Promise<{ readonly publicKey: string }> {
  let owner: string | undefined;
  if (origin !== undefined || publicKey !== undefined || value !== undefined) {
    if (origin === undefined || publicKey === undefined || value === undefined || normalizeEndpointTransport(value).kind !== 'iroh') throw new Error('Supply the complete trusted node invitation or generate a local key before importing one.');
    owner = ownerKey(origin, publicKey);
  }
  await prepareEndpointTransportRuntime('iroh');
  const binding = localIrohClientBinding();
  const mode = mobileMode ?? (value?.kind === 'iroh' ? value.mobileMode : undefined) ?? 'relay';
  const identity = binding === undefined ? await (await import('@jokoagent/linkspan-iroh')).createIrohIdentity() : await binding.createIdentity(mode);
  if (!/^[a-f0-9]{64}$/u.test(identity.privateKey) || !/^[a-f0-9]{64}$/u.test(identity.publicKey)) throw new Error('The local iroh identity could not be confirmed.');
  if (owner === undefined) unboundIrohClientKeys.set(identity.publicKey, identity.privateKey);
  else { rememberIrohClientKey(publicKey!, identity.publicKey, identity.privateKey); generatedIrohClients.set(owner, identity); }
  return Object.freeze({ publicKey: identity.publicKey });
}

/** User-triggered local key generation. Only the public allowlist key leaves the host. */
export async function createTailcatClientIdentity(origin: string, publicKey: string, value: EndpointTransport): Promise<{ readonly publicKey: string }> {
  const transport = normalizeEndpointTransport(value);
  if (transport.kind !== 'tailcat') throw new Error('Select a trusted tailcat invitation before creating its client identity.');
  const owner = ownerKey(origin, publicKey);
  await prepareEndpointTransportRuntime('tailcat');
  const binding = localTailcatClientBinding();
  const identity = binding === undefined ? await (await import('@jokoagent/linkspan-tailcat')).createTailcatIdentity() : await binding.createIdentity();
  if (!/^privkey:[a-f0-9]{64}$/u.test(identity.privateKey) || !/^nodekey:[a-f0-9]{64}$/u.test(identity.publicKey)) throw new Error('The native client identity could not be confirmed.');
  generatedTailcatClients.set(owner, { location: transport, privateKey: identity.privateKey });
  return Object.freeze({ publicKey: identity.publicKey });
}

export function selectEndpointTransport(origin: string, publicKey: string, kind: EndpointTransportKind): void {
  const owner = ownerKey(origin, publicKey);
  if (kind !== 'https' && kind !== 'webrtc' && !transports.has(`${owner}:${kind}`)) throw new Error('The private transport locator is unavailable. Import its trusted invitation again.');
  selected.set(owner, kind);
}

export function trustedEndpointTransportKind(origin: string, publicKey: string): EndpointTransportKind {
  return selected.get(ownerKey(origin, publicKey)) ?? 'https';
}

/** Check private lease prerequisites before loading or dialing any SDK. */
export function assertEndpointTransportReady(transport: EndpointTransport): void {
  if (transport.kind === 'iroh' && transport.relayToken !== undefined) {
    if (transport.relayTokenExpiresAt! <= Date.now()) throw new Error('The iroh relay lease expired. Ask the node owner for a new lease for this device\'s existing public key.');
    if (transport.clientKey === undefined) throw new Error('This relay lease requires this device\'s original local iroh key. Restore it or request a new lease; a replacement key cannot use this lease.');
  }
}

/** Capture once per connection occurrence; later selections cannot reroute it. */
export function trustedEndpointTransport(origin: string, publicKey: string, kind?: EndpointTransportKind): EndpointTransport | undefined {
  const owner = ownerKey(origin, publicKey), selectedKind = kind ?? selected.get(owner) ?? 'https';
  if (selectedKind === 'https') return undefined;
  if (selectedKind === 'webrtc') return Object.freeze({ kind: 'webrtc' });
  const transport = transports.get(`${owner}:${selectedKind}`);
  if (transport === undefined) throw new Error('The private transport locator is unavailable. Import its trusted invitation again.');
  assertEndpointTransportReady(transport);
  return transport;
}
