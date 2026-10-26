import { createClient, type Client, type Transport } from '@connectrpc/connect';
import { ConnectionService, DeviceAuthorizationState, DeviceKind, type DeviceAuthorization } from '@joko/contracts';
import { endpointOrigin, normalizeEndpointPublicKey, normalizeEndpointTransport, rememberEndpointTrust, type EndpointTransport, type EndpointTransportKind } from './trust.js';
import { createDeviceTransportRequest, formatDeviceTransportRequest, invitationTransport, parseDeviceTransportRequest, type DeviceTransportRequestDraft } from './device-transport-request.js';
export { formatDeviceTransportRequest, parseDeviceTransportRequest, parseDeviceTransportRequestDraft, type DeviceTransportRequestDraft } from './device-transport-request.js';

export interface DeviceTarget {
  readonly origin: string; readonly serverId: string; readonly endpointPublicKey: string;
  readonly endpointTransport?: EndpointTransport;
  readonly transportRequestId?: string;
}
export interface DeviceInvitation extends DeviceTarget {
  readonly invitationId: string; readonly invitationSecret: string; readonly expiresAt: number;
  readonly invitationCode?: string; readonly knock?: boolean;
}
export function bindDeviceInvitationTransport(invitation: DeviceTarget, request?: DeviceTransportRequestDraft): EndpointTransport | undefined {
  const transport = invitation.endpointTransport;
  if (!transport || transport.kind === 'webrtc' || transport.kind === 'http-connect') return transport;
  if (!request || request.expiresAt <= Date.now() || request.requestId !== invitation.transportRequestId || request.kind !== transport.kind
    || transport.kind === 'iroh' && transport.clientEndpointId !== request.publicKey) throw new Error('Open this invitation on the device that created its original request.');
  return normalizeEndpointTransport({ ...transport, clientKey: request.privateKey,
    ...(transport.kind === 'iroh' && request.mobileMode ? { mobileMode: request.mobileMode } : {}) });
}
export interface DeviceAuthorizationDraft {
  readonly invitation: DeviceInvitation; readonly requestId: string; readonly requesterSecret: string;
  readonly authKey: string; readonly deviceName: string; readonly deviceKind: DeviceKind; readonly platform: string;
  readonly entryId?: string;
  readonly endpointTransport?: EndpointTransport;
}
export interface DeviceInvitationEntry { readonly id: string; readonly name: string; readonly provider: string; readonly origin: string; readonly kind: EndpointTransportKind }
export interface DeviceAuthorizationView {
  readonly invitationId: string; readonly requestId: string; readonly userCode: string;
  readonly state: 'invited' | 'pending' | 'approved' | 'claimed' | 'denied' | 'cancelled' | 'expired';
  readonly deviceName: string; readonly platform: string; readonly expiresAt: number;
  readonly connectionId?: string;
}
export interface DeviceAuthorizationProgress extends DeviceAuthorizationView { readonly origin: string; readonly serverId: string; readonly reviewLink?: string }
export interface DeviceAuthorizationReview {
  readonly serverId: string; readonly endpointPublicKey: string; readonly invitationId: string; readonly requestId: string;
}
/** Public routing information only. Opening it never authorizes a request. */
export function formatDeviceAuthorizationReview(value: DeviceAuthorizationReview): string {
  if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/iu.test(value.serverId) || !validId(value.invitationId) || !validId(value.requestId)) throw new Error('Invalid device review link.');
  return `joko://review-device#${new URLSearchParams({ v: '1', s: value.serverId, k: normalizeEndpointPublicKey(value.endpointPublicKey).slice(8), i: value.invitationId, r: value.requestId })}`;
}
export function parseDeviceAuthorizationReview(raw: string): DeviceAuthorizationReview {
  raw = unwrapDeviceLink(raw);
  if (!raw.startsWith('joko://review-device#') || raw.length > 1024) throw new Error('Use a device review link.');
  const url = new URL(raw), params = new URLSearchParams(url.hash.slice(1));
  if (url.pathname || url.search || url.username || url.password || [...params.keys()].sort().join(',') !== 'i,k,r,s,v' || params.get('v') !== '1') throw new Error('Invalid device review link.');
  const value = { serverId: params.get('s')!, endpointPublicKey: `ed25519:${params.get('k')}`, invitationId: params.get('i')!, requestId: params.get('r')! };
  if (formatDeviceAuthorizationReview(value) !== raw) throw new Error('Invalid device review link.'); return value;
}
export function parseDeviceLink(raw: string): { readonly kind: 'review'; readonly review: DeviceAuthorizationReview } | { readonly kind: 'invitation'; readonly target: DeviceTarget } {
  const link = unwrapDeviceLink(raw);
  return link.startsWith('joko://review-device#') ? { kind: 'review', review: parseDeviceAuthorizationReview(link) } : { kind: 'invitation', target: parseDeviceTarget(link) };
}
export interface DeviceAuthorizationStorage {
  read(): Promise<DeviceAuthorizationDraft | undefined>;
  write(value: DeviceAuthorizationDraft | undefined): Promise<void>;
  exclusive?<T>(action: () => Promise<T>): Promise<T>;
  readTransportRequest?(): Promise<DeviceTransportRequestDraft | undefined>;
  writeTransportRequest?(draft: DeviceTransportRequestDraft | undefined): Promise<void>;
}
export interface DeviceAuthorizationPort {
  transportRequest?(kind: 'iroh' | 'tailcat', signal?: AbortSignal): Promise<string>;
  pendingTransportRequest?(signal?: AbortSignal): Promise<string | undefined>;
  cancelTransportRequest?(requestId: string, signal?: AbortSignal): Promise<void>;
  resolveTarget?(target: string, code?: string, signal?: AbortSignal): Promise<string>;
  entries?(link: string, signal?: AbortSignal): Promise<readonly DeviceInvitationEntry[]>;
  start(link: string, name: string, signal?: AbortSignal, entryId?: string): Promise<DeviceAuthorizationProgress>;
  refresh(signal?: AbortSignal): Promise<DeviceAuthorizationProgress | undefined>;
  cancel(signal?: AbortSignal): Promise<DeviceAuthorizationProgress | undefined>;
  finish(signal?: AbortSignal, automatic?: boolean): Promise<void>;
  discard(allowUnconfirmed?: boolean): Promise<void>;
}
export interface DeviceAuthorizationCrypto {
  uuid(): string; secret(): string; digest(value: string): Promise<string>;
}
export interface DeviceAuthorizationOwner {
  entries?(): Promise<import('@joko/contracts').NodeConnectionEntry[]>;
  invitationEntry?(invitation: DeviceInvitation, entryId: string, requestLink?: string): Promise<DeviceInvitation>;
  create(input: { invitationId: string; invitationSecretDigest: string; entryIds?: string[]; invitationCodeDigest?: string; allowKnock?: boolean }): Promise<{ authorization?: DeviceAuthorization;
    origin: string; serverId: string; endpointPublicKey: string; entries?: import('@joko/contracts').NodeConnectionEntry[] }>;
  list(): Promise<readonly DeviceAuthorizationView[]>;
  resolve(invitationId: string, requestId: string, decision: 'approved' | 'denied' | 'cancelled'): Promise<DeviceAuthorizationView>;
}

export function deviceAuthorizationOwner(client: Client<typeof ConnectionService>, assertCurrent: () => void): DeviceAuthorizationOwner {
  return {
    async entries() { assertCurrent(); const result = await client.listConnectionEntries({}); assertCurrent(); return result.entries; },
    async invitationEntry(invitation, entryId, requestLink) {
      assertCurrent();
      const request = requestLink ? parseDeviceTransportRequest(requestLink) : undefined;
      if (request && request.expiresAt <= Date.now()) throw new Error('The new device request expired. Create another on that device.');
      const result = await client.prepareConnectionEntry({ entryId, requestId: request?.requestId ?? invitation.invitationId, clientPublicKey: request?.publicKey ?? '' });
      assertCurrent();
      if (result.serverId !== invitation.serverId || result.endpointPublicKey !== invitation.endpointPublicKey || result.entry?.entryId !== entryId
        || request && result.entry.transportKind !== request.kind) throw new Error('The invitation entrance changed identity or carrier.');
      return { ...invitation, origin: result.entry.origin, endpointTransport: invitationTransport(result, request), transportRequestId: request?.requestId };
    },
    async create(input) { assertCurrent(); const result = await client.createDeviceAuthorizationInvitation(input); assertCurrent(); return result; },
    async list() { assertCurrent(); const result = await client.listDeviceAuthorizations({}); assertCurrent(); return result.authorizations.map(authorizationView); },
    async resolve(invitationId, requestId, decision) {
      assertCurrent(); const result = await client.resolveDeviceAuthorization({ invitationId, requestId,
        decision: decision === 'approved' ? DeviceAuthorizationState.APPROVED : decision === 'denied' ? DeviceAuthorizationState.DENIED : DeviceAuthorizationState.CANCELLED });
      assertCurrent(); return authorizationView(result.authorization);
    }
  };
}

/** Contains invitation admission only; no new/old device bearer or private locator. */
export function formatDeviceInvitation(input: DeviceInvitation): string {
  const origin = endpointOrigin(input.origin), key = normalizeEndpointPublicKey(input.endpointPublicKey);
  const transport = input.endpointTransport === undefined ? undefined : normalizeEndpointTransport(input.endpointTransport);
  const proofs = Number(validSecret(input.invitationSecret)) + Number(input.invitationSecret === '' && /^[A-HJ-NP-Z2-9]{8}$/u.test(input.invitationCode ?? '')) + Number(input.invitationSecret === '' && input.knock === true);
  if (!secureInvitationOrigin(origin, transport) || !validId(input.invitationId) || proofs !== 1 || input.invitationSecret && (input.invitationCode !== undefined || input.knock)
    || !input.serverId || input.serverId.length > 128 || /[\u0000-\u001f\u007f]/u.test(input.serverId)
    || !Number.isSafeInteger(input.expiresAt) || input.expiresAt < 1) throw new Error('A device invitation requires a secure carrier and its complete trusted identity.');
  const params = new URLSearchParams({ v: '1', o: origin, s: input.serverId, k: key.slice(8), i: input.invitationId, e: String(input.expiresAt) });
  if (input.invitationSecret) params.set('t', input.invitationSecret);
  else if (input.invitationCode) params.set('c', input.invitationCode);
  else params.set('n', '1');
  if (input.endpointTransport) {
    const transport = normalizeEndpointTransport(input.endpointTransport);
    if ('clientKey' in transport && transport.clientKey) throw new Error('A device private key cannot be shared in an invitation.');
    params.set('p', JSON.stringify(transport));
  }
  if (input.transportRequestId) { if (!validId(input.transportRequestId)) throw new Error('Invalid original device request.'); params.set('r', input.transportRequestId); }
  const link = `joko://pair#${params}`;
  if (link.length > 32768) throw new Error('The node invitation is too large.');
  return link;
}
export function parseDeviceInvitation(raw: string): DeviceInvitation {
  raw = unwrapDeviceLink(raw);
  if (typeof raw !== 'string' || raw.length > 32768 || !raw.startsWith('joko://pair#') || /[\u0000-\u0020\u007f]/u.test(raw)) throw new Error('Enter a Joko device invitation link.');
  const url = new URL(raw), params = new URLSearchParams(url.hash.slice(1));
  if (url.host !== 'pair' || url.pathname || url.search || url.username || url.password
    || new Set(params.keys()).size !== [...params.keys()].length
    || !['e,i,k,o,s,t,v', 'c,e,i,k,o,s,v', 'e,i,k,n,o,s,v'].includes([...params.keys()].filter(key => !['p', 'r'].includes(key)).sort().join(',')) || params.get('v') !== '1') throw new Error('Invalid device invitation.');
  const result = { origin: params.get('o')!, serverId: params.get('s')!, endpointPublicKey: `ed25519:${params.get('k')}`,
    invitationId: params.get('i')!, invitationSecret: params.get('t') ?? '', expiresAt: Number(params.get('e')),
    ...(params.has('c') ? { invitationCode: params.get('c')! } : {}), ...(params.has('n') ? { knock: params.get('n') === '1' } : {}),
    ...(params.has('p') ? { endpointTransport: normalizeEndpointTransport(JSON.parse(params.get('p')!)) } : {}), ...(params.has('r') ? { transportRequestId: params.get('r')! } : {}) };
  formatDeviceInvitation(result);
  return result;
}
export function formatDeviceTarget(target: DeviceTarget): string {
  const origin = endpointOrigin(target.origin), key = normalizeEndpointPublicKey(target.endpointPublicKey);
  const transport = target.endpointTransport === undefined ? undefined : normalizeEndpointTransport(target.endpointTransport);
  if (!secureInvitationOrigin(origin, transport) || !target.serverId || target.serverId.length > 128 || /[\u0000-\u001f\u007f]/u.test(target.serverId)) throw new Error('A trusted secure node is required.');
  const params = new URLSearchParams({ v: '1', o: origin, s: target.serverId, k: key.slice(8) });
  if (target.endpointTransport) {
    const transport = normalizeEndpointTransport(target.endpointTransport);
    if ('clientKey' in transport && transport.clientKey) throw new Error('A device private key cannot be shared.');
    params.set('p', JSON.stringify(transport));
  }
  if (target.transportRequestId) { if (!validId(target.transportRequestId)) throw new Error('Invalid device request.'); params.set('r', target.transportRequestId); }
  const link = `joko://pair#${params}`;
  if (link.length > 32768) throw new Error('The node context is too large.'); return link;
}
export function parseDeviceTarget(raw: string): DeviceTarget {
  raw = unwrapDeviceLink(raw);
  if (typeof raw !== 'string' || raw.length > 32768 || !raw.startsWith('joko://pair#') || /[\u0000-\u0020\u007f]/u.test(raw)) throw new Error('Enter a trusted Joko connection link.');
  const url = new URL(raw), params = new URLSearchParams(url.hash.slice(1));
  if (new Set(params.keys()).size !== [...params.keys()].length) throw new Error('Invalid node context.');
  if ([...params.keys()].filter(key => !['p', 'r'].includes(key)).sort().join(',') !== 'k,o,s,v') return parseDeviceInvitation(raw);
  if (url.host !== 'pair' || url.pathname || url.search || url.username || url.password || params.get('v') !== '1') throw new Error('Invalid node context.');
  const target = { origin: params.get('o')!, serverId: params.get('s')!, endpointPublicKey: `ed25519:${params.get('k')}`,
    ...(params.has('p') ? { endpointTransport: normalizeEndpointTransport(JSON.parse(params.get('p')!)) } : {}), ...(params.has('r') ? { transportRequestId: params.get('r')! } : {}) };
  formatDeviceTarget(target); return target;
}
function unwrapDeviceLink(raw: string): string {
  if (typeof raw !== 'string' || raw.length > 65536) throw new Error('Invalid device link.');
  if (raw.startsWith('https://')) {
    const url = new URL(raw), params = new URLSearchParams(url.hash.slice(1));
    if (url.username || url.password || [...params.keys()].join(',') !== 'joko') throw new Error('Invalid Web invitation.');
    return params.get('joko')!;
  }
  return raw;
}
export function formatWebDeviceLink(link: string, distributionOrigin: string): string {
  parseDeviceLink(link);
  if (!distributionOrigin.startsWith('https://')) return link;
  const origin = endpointOrigin(distributionOrigin);
  if (!origin.startsWith('https://')) return link;
  const wrapped = `${origin}/#${new URLSearchParams({ joko: link })}`;
  return wrapped.length <= 65536 ? wrapped : link;
}
export function parseDeviceAuthorizationDraft(value: unknown): DeviceAuthorizationDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The saved device request is unreadable.');
  const draft = value as DeviceAuthorizationDraft;
  formatDeviceInvitation(draft.invitation);
  if (draft.endpointTransport && normalizeEndpointTransport(draft.endpointTransport).kind !== draft.invitation.endpointTransport?.kind) throw new Error('The local transport identity does not match this invitation.');
  if (draft.entryId !== undefined && !/^[a-z0-9][a-z0-9._:-]{0,127}$/iu.test(draft.entryId)) throw new Error('Invalid selected entrance.');
  if (!validId(draft.requestId) || !validSecret(draft.requesterSecret) || !validSecret(draft.authKey) || draft.requesterSecret === draft.authKey
    || typeof draft.deviceName !== 'string' || !draft.deviceName.trim() || draft.deviceName.length > 128
    || ![DeviceKind.WEB, DeviceKind.DESKTOP, DeviceKind.MOBILE].includes(draft.deviceKind)
    || typeof draft.platform !== 'string' || draft.platform.length > 64) throw new Error('The saved device request is unreadable.');
  return draft;
}
export function authorizationView(value: DeviceAuthorization | undefined): DeviceAuthorizationView {
  const states = { [DeviceAuthorizationState.INVITED]: 'invited', [DeviceAuthorizationState.PENDING]: 'pending',
    [DeviceAuthorizationState.APPROVED]: 'approved', [DeviceAuthorizationState.CLAIMED]: 'claimed', [DeviceAuthorizationState.DENIED]: 'denied',
    [DeviceAuthorizationState.CANCELLED]: 'cancelled', [DeviceAuthorizationState.EXPIRED]: 'expired' } as const;
  const state = value && states[value.state as keyof typeof states];
  if (!value || !state || !value.expiresAt || !validId(value.invitationId)) throw new Error('The node returned an invalid device request.');
  return parseDeviceAuthorizationView({ invitationId: value.invitationId, requestId: value.requestId, userCode: value.userCode, state,
    deviceName: value.deviceName, platform: value.platform, expiresAt: Number(value.expiresAt.seconds) * 1000 + Math.floor(value.expiresAt.nanos / 1_000_000),
    ...(value.connection?.connectionId ? { connectionId: value.connection.connectionId } : {}) });
}
function parseDeviceAuthorizationView(input: unknown): DeviceAuthorizationView {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid device request progress.');
  const value = input as DeviceAuthorizationView;
  if (!validId(value.invitationId) || !['invited', 'pending', 'approved', 'claimed', 'denied', 'cancelled', 'expired'].includes(value.state)
    || !Number.isSafeInteger(value.expiresAt) || value.expiresAt < 1 || value.expiresAt > 8.64e15
    || typeof value.deviceName !== 'string' || value.deviceName.length > 128 || typeof value.platform !== 'string' || value.platform.length > 64
    || !(validId(value.requestId) && /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/u.test(value.userCode)
      || value.requestId === '' && value.userCode === '' && ['invited', 'cancelled', 'expired'].includes(value.state))
    || value.connectionId !== undefined && (typeof value.connectionId !== 'string' || value.connectionId.length > 256)
    || value.state === 'claimed' && !value.connectionId) throw new Error('Invalid device request progress.');
  return { invitationId: value.invitationId, requestId: value.requestId, userCode: value.userCode, state: value.state,
    deviceName: value.deviceName, platform: value.platform, expiresAt: value.expiresAt,
    ...(value.connectionId ? { connectionId: value.connectionId } : {}) };
}
export function parseDeviceAuthorizationProgress(input: unknown): DeviceAuthorizationProgress | undefined {
  if (input === undefined || input === null) return undefined;
  const value = input as DeviceAuthorizationProgress, view = parseDeviceAuthorizationView(input);
  if (typeof value.serverId !== 'string' || !value.serverId || value.serverId.length > 128) throw new Error('Invalid device request progress.');
  const origin = endpointOrigin(value.origin);
  if (value.reviewLink !== undefined) {
    const review = parseDeviceAuthorizationReview(value.reviewLink);
    if (review.serverId !== value.serverId || review.requestId !== view.requestId || review.invitationId !== view.invitationId) throw new Error('The review link belongs to another request.');
  }
  // Origin here is display data from the protected host, not a trust decision.
  return { ...view, origin, serverId: value.serverId, ...(value.reviewLink ? { reviewLink: value.reviewLink } : {}) };
}
export function parseDeviceInvitationEntries(input: unknown): readonly DeviceInvitationEntry[] {
  if (!Array.isArray(input) || input.length > 64) throw new Error('Invalid invitation entrances.');
  const seen = new Set<string>();
  return input.map((entry: DeviceInvitationEntry) => {
    if (!entry || !/^[a-z0-9][a-z0-9._:-]{0,127}$/iu.test(entry.id) || seen.has(entry.id)
      || typeof entry.name !== 'string' || entry.name.length > 256 || typeof entry.provider !== 'string' || entry.provider.length > 64
      || !['https', 'webrtc', 'iroh', 'tailcat', 'http-connect'].includes(entry.kind)) throw new Error('Invalid invitation entrance.');
    seen.add(entry.id);
    return { id: entry.id, name: entry.name, provider: entry.provider, origin: endpointOrigin(entry.origin), kind: entry.kind };
  });
}

/** The native/Web host retains secrets; the shared page receives only progress. */
export class DeviceAuthorizationReceiver {
  private mutationTail: Promise<unknown> = Promise.resolve();
  constructor(readonly storage: DeviceAuthorizationStorage, readonly crypto: DeviceAuthorizationCrypto,
    readonly transport: (invitation: DeviceTarget) => Transport) {}
  async pendingTransportRequest(signal?: AbortSignal): Promise<string | undefined> {
    const request = await this.storage.readTransportRequest?.(); signal?.throwIfAborted();
    return request ? formatDeviceTransportRequest(request) : undefined;
  }
  async cancelTransportRequest(requestId: string, signal?: AbortSignal): Promise<void> {
    if (!validId(requestId)) throw new Error('Invalid original device request.');
    await this.exclusive(async () => {
      const request = await this.storage.readTransportRequest?.(), draft = await this.storage.read(); signal?.throwIfAborted();
      if (!request) return;
      if (request.requestId !== requestId) throw new Error('The original device request changed. Reopen its current state.');
      if (draft?.invitation.transportRequestId === requestId) throw new Error('Finish or cancel the device authorization before replacing its connection request.');
      await this.storage.writeTransportRequest!(undefined); signal?.throwIfAborted();
    });
  }
  async transportRequest(kind: 'iroh' | 'tailcat', signal?: AbortSignal, mode: 'native' | 'relay' = 'relay'): Promise<string> {
    if (!this.storage.readTransportRequest || !this.storage.writeTransportRequest) throw new Error('Protected device request storage is unavailable.');
    return this.exclusive(async () => {
      const existing = await this.storage.readTransportRequest!(), authorization = await this.storage.read(); signal?.throwIfAborted();
      if (authorization) throw new Error('Finish or cancel the original device authorization first.');
      if (existing && existing.expiresAt > Date.now()) {
        if (existing.kind !== kind) throw new Error('Finish the original device request or wait for it to expire.');
        return formatDeviceTransportRequest(existing);
      }
      const draft = await createDeviceTransportRequest(kind, this.crypto.uuid, mode); signal?.throwIfAborted();
      await this.storage.writeTransportRequest!(draft); signal?.throwIfAborted(); return formatDeviceTransportRequest(draft);
    });
  }
  private async invitationTransport(invitation: DeviceTarget): Promise<EndpointTransport | undefined> {
    return bindDeviceInvitationTransport(invitation, invitation.transportRequestId ? await this.storage.readTransportRequest?.() : undefined);
  }
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    if (this.storage.exclusive) return this.storage.exclusive(action);
    const result = this.mutationTail.then(action, action);
    this.mutationTail = result.catch(() => undefined);
    return result;
  }
  async clear(requestId: string): Promise<void> {
    await this.exclusive(async () => {
      const current = await this.storage.read();
      if (current?.requestId === requestId) {
        const transport = await this.storage.readTransportRequest?.();
        if (transport && transport.requestId === current.invitation.transportRequestId) await this.storage.writeTransportRequest?.(undefined);
        await this.storage.write(undefined);
      }
    });
  }
  async discard(allowUnconfirmed = false): Promise<void> {
    const current = await this.storage.read();
    if (!current) return;
    if (!allowUnconfirmed) {
      const progress = await this.refresh();
      if (progress && !['denied', 'cancelled', 'expired'].includes(progress.state)) throw new Error('Cancel or finish this device request first.');
    }
    await this.clear(current.requestId);
  }
  private async assertDraft(draft: DeviceAuthorizationDraft): Promise<void> {
    const current = await this.storage.read();
    if (!current || JSON.stringify(current) !== JSON.stringify(draft)) throw new Error('The saved device request changed. Resume its current state.');
  }
  async entries(link: string, signal?: AbortSignal): Promise<readonly DeviceInvitationEntry[]> {
    const invitation = parseDeviceInvitation(link), client = await this.client({ invitation }, signal);
    const response = await client.getDeviceAuthorizationEntries({ invitationId: invitation.invitationId, invitationSecret: invitation.invitationSecret,
      invitationCode: invitation.invitationCode, knock: invitation.knock }, { signal });
    if (response.serverId !== invitation.serverId || response.endpointPublicKey !== invitation.endpointPublicKey) throw new Error('The invitation entrance directory changed identity.');
    return parseDeviceInvitationEntries(response.entries.filter(entry => !entry.requiresServerSetup).map(entry => ({ id: entry.entryId, name: entry.displayName, provider: entry.provider,
      origin: entry.origin, kind: entry.transportKind })));
  }
  async resolveTarget(link: string, code: string | undefined, signal?: AbortSignal): Promise<string> {
    const target = parseDeviceTarget(link), normalized = code?.toUpperCase().replace(/[\s-]/gu, '') ?? '';
    if (code !== undefined && !/^[A-HJ-NP-Z2-9]{8}$/u.test(normalized)) throw new Error('Enter the eight-character invitation code.');
    const client = await this.client({ invitation: target }, signal);
    const result = await client.findDeviceAuthorizationInvitation({ invitationCode: normalized }, { signal });
    if (result.serverId !== target.serverId || result.endpointPublicKey !== target.endpointPublicKey || !result.expiresAt) throw new Error('The original node identity changed.');
    return formatDeviceInvitation({ ...target, invitationId: result.invitationId, invitationSecret: '',
      expiresAt: Number(result.expiresAt.seconds) * 1000 + result.expiresAt.nanos / 1_000_000,
      ...(normalized ? { invitationCode: normalized } : { knock: true }) });
  }
  async start(link: string, deviceName: string, deviceKind: DeviceKind, platform: string, signal?: AbortSignal, entryId?: string): Promise<DeviceAuthorizationProgress> {
    const invitation = parseDeviceInvitation(link);
    if (invitation.expiresAt <= Date.now()) throw new Error('This device invitation expired. Ask for a new invitation.');
    await this.exclusive(async () => {
      const previous = await this.storage.read(); signal?.throwIfAborted();
      if (previous && (formatDeviceInvitation(previous.invitation) !== formatDeviceInvitation(invitation) || previous.deviceName !== deviceName.trim() || previous.entryId !== entryId)) {
        throw new Error('Finish or cancel the saved device request before opening another invitation.');
      }
      if (!previous) {
        const draft = parseDeviceAuthorizationDraft({ invitation, requestId: this.crypto.uuid(), requesterSecret: this.crypto.secret(),
          authKey: this.crypto.secret(), deviceName: deviceName.trim(), deviceKind, platform, endpointTransport: await this.invitationTransport(invitation), ...(entryId ? { entryId } : {}) });
        await this.client(draft, signal);
        await this.storage.write(draft); signal?.throwIfAborted();
      }
    });
    return (await this.refresh(signal))!;
  }
  async client(draft: { readonly invitation: DeviceTarget; readonly endpointTransport?: EndpointTransport }, signal?: AbortSignal): Promise<Client<typeof ConnectionService>> {
    const target = { ...draft.invitation, endpointTransport: draft.endpointTransport ?? await this.invitationTransport(draft.invitation) };
    rememberEndpointTrust({ ...target, transportKind: target.endpointTransport?.kind ?? 'https' });
    const client = createClient(ConnectionService, this.transport(target));
    const identity = (await client.getServerInfo({}, { signal })).server;
    signal?.throwIfAborted();
    if (identity?.serverId !== draft.invitation.serverId || identity.endpointPublicKey !== draft.invitation.endpointPublicKey) throw new Error('The invited node identity changed. Verify it on the original device.');
    return client;
  }
  async refresh(signal?: AbortSignal): Promise<DeviceAuthorizationProgress | undefined> {
    const draft = await this.storage.read(); signal?.throwIfAborted(); if (!draft) return undefined;
    const client = await this.client(draft, signal);
    const response = await client.requestDeviceAuthorization({ invitationId: draft.invitation.invitationId,
      invitationSecret: draft.invitation.invitationSecret, requestId: draft.requestId, requesterSecret: draft.requesterSecret,
      authKeyDigest: await this.crypto.digest(draft.authKey), deviceName: draft.deviceName, deviceKind: draft.deviceKind, platform: draft.platform, entryId: draft.entryId,
      invitationCode: draft.invitation.invitationCode, knock: draft.invitation.knock }, { signal });
    signal?.throwIfAborted(); await this.assertDraft(draft);
    const value = authorizationView(response.authorization);
    if (value.invitationId !== draft.invitation.invitationId || value.requestId !== draft.requestId && !(value.requestId === '' && ['expired', 'cancelled'].includes(value.state))) throw new Error('The original device request changed.');
    return requestProgress(draft, value);
  }
  async claim(signal?: AbortSignal): Promise<{ draft: DeviceAuthorizationDraft; authorization: DeviceAuthorization }> {
    const draft = await this.storage.read(); signal?.throwIfAborted(); if (!draft) throw new Error('The original device request is unavailable.');
    const client = await this.client(draft, signal);
    const result = await client.claimDeviceAuthorization({ invitationId: draft.invitation.invitationId, requestId: draft.requestId, requesterSecret: draft.requesterSecret }, { signal });
    signal?.throwIfAborted(); await this.assertDraft(draft);
    if (result.authorization?.state !== DeviceAuthorizationState.CLAIMED || !result.authorization.connection?.connectionProfileId
      || !result.authorization.connection.deviceId || !result.authorization.connection.connectionId
      || result.authorization.invitationId !== draft.invitation.invitationId || result.authorization.requestId !== draft.requestId) throw new Error('This device request has not been approved or is no longer available.');
    return { draft, authorization: result.authorization };
  }
  async cancel(signal?: AbortSignal): Promise<DeviceAuthorizationProgress | undefined> {
    const progress = await this.refresh(signal);
    if (!progress || ['expired', 'cancelled', 'denied', 'claimed'].includes(progress.state)) return progress;
    const draft = await this.storage.read(); if (!draft) return undefined;
    const client = await this.client(draft, signal);
    const response = await client.cancelDeviceAuthorization({ invitationId: draft.invitation.invitationId, requestId: draft.requestId, requesterSecret: draft.requesterSecret }, { signal });
    signal?.throwIfAborted(); const value = authorizationView(response.authorization);
    return requestProgress(draft, value);
  }
}
function validId(value: string): boolean { return /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value); }
function requestProgress(draft: DeviceAuthorizationDraft, value: DeviceAuthorizationView): DeviceAuthorizationProgress {
  return { ...value, origin: draft.invitation.origin, serverId: draft.invitation.serverId,
    ...(value.requestId ? { reviewLink: formatDeviceAuthorizationReview({ ...draft.invitation, requestId: value.requestId }) } : {}) };
}
// SDK origins are logical identifiers: only the typed SDK stream is dialled.
// Plain HTTP and WebRTC signaling still require the HTTPS invitation boundary.
function secureInvitationOrigin(origin: string, transport?: EndpointTransport): boolean {
  return origin.startsWith('https://') || transport?.kind === 'iroh' || transport?.kind === 'tailcat';
}
function validSecret(value: string): boolean { return /^[a-f0-9]{64}$/u.test(value); }
