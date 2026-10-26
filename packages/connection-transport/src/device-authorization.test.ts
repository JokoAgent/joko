import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Code, ConnectError, createRouterTransport } from '@connectrpc/connect';
import { ConnectionService, DeviceAuthorizationState, DeviceKind } from '@joko/contracts';
import { describe, expect, it, vi } from 'vitest';
import { DeviceAuthorizationReceiver, formatDeviceInvitation, parseDeviceInvitation, formatDeviceTarget, parseDeviceTarget, formatWebDeviceLink, formatDeviceAuthorizationReview, parseDeviceAuthorizationReview, parseDeviceLink, parseDeviceAuthorizationProgress, type DeviceAuthorizationDraft, type DeviceTarget } from './device-authorization.js';
import { installIrohClientBinding } from './trust.js';
import { parseDeviceTransportRequest, type DeviceTransportRequestDraft } from './device-transport-request.js';

const identity = { origin: 'https://approval.example', serverId: 'node-approval', endpointPublicKey: `ed25519:${'a'.repeat(64)}` };
const invitation = () => ({ ...identity, invitationId: randomUUID(), invitationSecret: randomBytes(32).toString('hex'), expiresAt: Date.now() + 600_000 });
const crypto = { uuid: randomUUID, secret: () => randomBytes(32).toString('hex'), digest: async (value: string) => createHash('sha256').update(value).digest('hex') };
describe('device invitation and requester recovery', () => {
  it('accepts logical HTTP origins only for typed private SDK invitations, including host progress', () => {
    const value = { ...invitation(), origin: 'http://127.0.0.1:4318' };
    for (const endpointTransport of [{ kind: 'iroh' as const, endpointId: 'e'.repeat(64), ticket: 'private-iroh-ticket' },
      { kind: 'tailcat' as const, endpointId: `nodekey:${'c'.repeat(64)}`, address: 'tcPrivate-address', port: 4318 }]) {
      const privateInvitation = { ...value, endpointTransport };
      expect(parseDeviceInvitation(formatDeviceInvitation(privateInvitation))).toEqual(privateInvitation);
      expect(parseDeviceTarget(formatDeviceTarget(privateInvitation)).endpointTransport?.kind).toBe(endpointTransport.kind);
    }
    expect(() => formatDeviceTarget(value)).toThrow();
    expect(() => formatDeviceInvitation({ ...value, endpointTransport: { kind: 'webrtc' } })).toThrow();
    expect(parseDeviceAuthorizationProgress({ ...value, requestId: randomUUID(), userCode: 'ABCD-EFGH', state: 'pending', deviceName: 'Phone', platform: 'mobile' })?.origin).toBe(value.origin);
  });
  it('routes review links using public identity and exact request IDs, never invitation secrets or endpoints', () => {
    const value = { ...identity, invitationId: randomUUID(), requestId: randomUUID() }, link = formatDeviceAuthorizationReview(value);
    expect(parseDeviceAuthorizationReview(link)).toEqual({ serverId: value.serverId, endpointPublicKey: value.endpointPublicKey, invitationId: value.invitationId, requestId: value.requestId });
    expect(parseDeviceLink(formatWebDeviceLink(link, 'https://app.example')).kind).toBe('review');
    expect(link).not.toContain(identity.origin);
    for (const bad of [link + '&approve=true', link + '&i=other', link.replace('review-device#', 'review-device/path#'), link + '&authKey=secret']) {
      expect(() => parseDeviceAuthorizationReview(bad)).toThrow();
    }
  });
  it('cancels only the original unbound private request and rejects its stale reply after regeneration', async () => {
    let request: DeviceTransportRequestDraft | undefined, saved: DeviceAuthorizationDraft | undefined;
    const restore = installIrohClientBinding({ createIdentity: async () => ({ publicKey: 'c'.repeat(64), privateKey: 'd'.repeat(64) }), connect: async () => { throw new Error('Not dialled'); } });
    const transport = createRouterTransport(router => router.service(ConnectionService, { getServerInfo: () => ({ server: identity }) }));
    const receiver = new DeviceAuthorizationReceiver({ read: async () => saved, write: async value => { saved = value; }, readTransportRequest: async () => request, writeTransportRequest: async value => { request = value; } }, crypto, () => transport);
    try {
      const first = parseDeviceTransportRequest(await receiver.transportRequest('iroh', undefined, 'native'));
      expect(request?.mobileMode).toBe('native'); expect(await receiver.pendingTransportRequest()).toBeTruthy();
      await expect(receiver.cancelTransportRequest(randomUUID())).rejects.toThrow(/changed/u);
      await receiver.cancelTransportRequest(first.requestId); expect(request).toBeUndefined();
      const replacement = parseDeviceTransportRequest(await receiver.transportRequest('iroh'));
      expect(replacement.requestId).not.toBe(first.requestId);
      await expect(receiver.client({ invitation: { ...invitation(), transportRequestId: first.requestId, endpointTransport: { kind: 'iroh', endpointId: 'e'.repeat(64), ticket: 'ticket', clientEndpointId: first.publicKey } } })).rejects.toThrow(/original request/u);
      request = { ...request!, expiresAt: Date.now() - 1 };
      expect(parseDeviceTransportRequest(await receiver.transportRequest('iroh')).requestId).not.toBe(replacement.requestId);
      saved = { invitation: { ...invitation(), transportRequestId: request!.requestId }, requestId: randomUUID(), requesterSecret: 'b'.repeat(64), authKey: 'c'.repeat(64), deviceName: 'Phone', deviceKind: DeviceKind.MOBILE, platform: 'mobile' };
      await expect(receiver.cancelTransportRequest(request!.requestId)).rejects.toThrow(/authorization/u);
      expect(request).toBeDefined();
    } finally { restore(); }
  });
  it('retains a private transport request across restart and binds the reply to this device without exporting its key', async () => {
    let request: DeviceTransportRequestDraft | undefined;
    let saved: DeviceAuthorizationDraft | undefined;
    const identityCount = vi.fn(async () => ({ publicKey: 'c'.repeat(64), privateKey: 'd'.repeat(64) }));
    const restore = installIrohClientBinding({ createIdentity: identityCount, connect: async () => { throw new Error('No carrier is needed by this parser test.'); } });
    try {
      const transport = createRouterTransport(router => router.service(ConnectionService, { getServerInfo: () => ({ server: identity }),
        requestDeviceAuthorization: () => { throw new ConnectError('Reply lost', Code.Unavailable); } }));
      const opened = vi.fn((_target: DeviceTarget) => transport);
      const storage = { read: async () => saved, write: async (value: DeviceAuthorizationDraft | undefined) => { saved = value; }, readTransportRequest: async () => request,
        writeTransportRequest: async (value: DeviceTransportRequestDraft | undefined) => { request = value; } };
      const first = new DeviceAuthorizationReceiver(storage, crypto, opened);
      const link = await first.transportRequest('iroh'), publicRequest = parseDeviceTransportRequest(link);
      expect(link).not.toContain('d'.repeat(64)); expect(request?.privateKey).toBe('d'.repeat(64));
      const restarted = new DeviceAuthorizationReceiver(storage, crypto, opened);
      expect(await restarted.transportRequest('iroh')).toBe(link); expect(identityCount).toHaveBeenCalledOnce();
      const reply = { ...invitation(), transportRequestId: publicRequest.requestId,
        endpointTransport: { kind: 'iroh' as const, endpointId: 'e'.repeat(64), ticket: 'ticket-for-the-original-device', clientEndpointId: publicRequest.publicKey } };
      const parsed = parseDeviceInvitation(formatDeviceInvitation(reply));
      expect(JSON.stringify(parsed)).not.toContain(request!.privateKey);
      await restarted.client({ invitation: parsed });
      expect(opened.mock.calls[0]?.[0].endpointTransport).toMatchObject({ kind: 'iroh', clientKey: 'd'.repeat(64), clientEndpointId: publicRequest.publicKey });
      await expect(restarted.client({ invitation: { ...parsed, transportRequestId: randomUUID() } })).rejects.toThrow(/original request/u);
      expect(opened).toHaveBeenCalledOnce();
      await expect(restarted.start(formatDeviceInvitation(parsed), 'Private laptop', DeviceKind.DESKTOP, 'desktop')).rejects.toThrow(/Reply lost/u);
      expect(request).toBeDefined(); expect(saved).toBeDefined();
      await restarted.clear(randomUUID()); expect(request).toBeDefined(); expect(saved).toBeDefined();
      await restarted.clear(saved!.requestId); expect(request).toBeUndefined(); expect(saved).toBeUndefined();
    } finally { restore(); }
  });
  it('keeps Web links in the fragment and rejects mixed admission proofs or unbound short codes', () => {
    const value = invitation(), link = formatDeviceInvitation(value);
    const web = formatWebDeviceLink(link, 'https://app.example');
    expect(new URL(web).search).toBe(''); expect(parseDeviceInvitation(web)).toEqual(value);
    expect(parseDeviceTarget(formatWebDeviceLink(formatDeviceTarget(identity), 'https://app.example'))).toEqual(identity);
    expect(() => parseDeviceTarget('ABCD2345')).toThrow();
    expect(() => parseDeviceInvitation(web + '&joko=another')).toThrow();
    expect(() => formatDeviceInvitation({ ...value, invitationCode: 'ABCD2345' })).toThrow();
    expect(() => formatDeviceInvitation({ ...value, invitationSecret: '', invitationCode: 'ABCD2345', knock: true })).toThrow();
  });
  it('verifies the trusted node before resolving a code or knock and does not create a request during lookup', async () => {
    const value = invitation(), find = vi.fn(() => ({ ...identity, invitationId: value.invitationId,
      expiresAt: { seconds: BigInt(Math.floor(value.expiresAt / 1000)), nanos: 0 } })), request = vi.fn(), write = vi.fn();
    let server = identity;
    const transport = createRouterTransport(router => router.service(ConnectionService, {
      getServerInfo: () => ({ server }), findDeviceAuthorizationInvitation: find, requestDeviceAuthorization: request
    }));
    const receiver = new DeviceAuthorizationReceiver({ read: async () => undefined, write }, crypto, () => transport);
    const target = formatDeviceTarget(identity);
    expect(parseDeviceInvitation(await receiver.resolveTarget(target, 'abcd-2345')).invitationCode).toBe('ABCD2345');
    expect(parseDeviceInvitation(await receiver.resolveTarget(target, undefined)).knock).toBe(true);
    expect(request).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
    server = { ...identity, endpointPublicKey: `ed25519:${'b'.repeat(64)}` };
    await expect(receiver.resolveTarget(target, 'ABCD2345')).rejects.toThrow(/identity/u);
    expect(find).toHaveBeenCalledTimes(2);
  });
  it('round trips only the bounded safe invitation and rejects injected URL fields', () => {
    const value = invitation(), link = formatDeviceInvitation(value);
    expect(parseDeviceInvitation(link)).toEqual(value);
    expect(() => parseDeviceInvitation(link + '&t=another')).toThrow();
    expect(() => parseDeviceInvitation(link.replace('pair#', 'pair/path#'))).toThrow();
    expect(() => formatDeviceInvitation({ ...value, origin: 'http://public.example' })).toThrow();
    expect(() => formatDeviceInvitation({ ...value, origin: 'https://user:secret@approval.example' })).toThrow();
    expect(() => formatDeviceInvitation({ ...value, origin: `${identity.origin}/token` })).toThrow();
  });
  it('persists both independent secrets before dispatch and reuses the original request after a lost reply', async () => {
    let saved: DeviceAuthorizationDraft | undefined;
    const requests: unknown[] = [], value = invitation();
    const transport = createRouterTransport(router => router.service(ConnectionService, {
      getServerInfo: () => ({ server: identity }),
      requestDeviceAuthorization: request => {
        expect(saved).toBeDefined(); requests.push(request);
        if (requests.length === 1) throw new Error('Lost response');
        return { authorization: { invitationId: value.invitationId, requestId: request.requestId, state: DeviceAuthorizationState.PENDING,
          deviceName: request.deviceName, userCode: 'ABCD-EFGH', expiresAt: { seconds: BigInt(Math.floor(value.expiresAt / 1000)), nanos: 0 } } };
      }
    }));
    const storage = { read: async () => saved, write: async (draft: DeviceAuthorizationDraft | undefined) => { saved = draft; } };
    await expect(new DeviceAuthorizationReceiver(storage, crypto, () => transport).start(formatDeviceInvitation(value), 'My laptop', DeviceKind.DESKTOP, 'windows')).rejects.toThrow();
    const first = saved!; expect(first.authKey).not.toBe(first.requesterSecret);
    const resumed = await new DeviceAuthorizationReceiver(storage, crypto, () => transport).refresh();
    expect(resumed?.requestId).toBe(first.requestId); expect(requests[1]).toEqual(requests[0]);
    expect(JSON.stringify(resumed)).not.toContain(first.authKey); expect(JSON.stringify(resumed)).not.toContain(first.requesterSecret);
  });
  it('does not dispatch when secure storage fails, or when the pinned node reports a different identity', async () => {
    const request = vi.fn(), value = invitation(); let saved: DeviceAuthorizationDraft | undefined;
    const transport = createRouterTransport(router => router.service(ConnectionService, {
      getServerInfo: () => ({ server: { ...identity, serverId: 'another-node' } }), requestDeviceAuthorization: request
    }));
    const knownNode = createRouterTransport(router => router.service(ConnectionService, { getServerInfo: () => ({ server: identity }), requestDeviceAuthorization: request }));
    const unavailable = new DeviceAuthorizationReceiver({ read: async () => undefined, write: async () => { throw new Error('Secure storage unavailable'); } }, crypto, () => knownNode);
    await expect(unavailable.start(formatDeviceInvitation(value), 'Laptop', DeviceKind.WEB, 'web')).rejects.toThrow(/storage/u);
    const receiver = new DeviceAuthorizationReceiver({ read: async () => saved, write: async draft => { saved = draft; } }, crypto, () => transport);
    await expect(receiver.start(formatDeviceInvitation(value), 'Laptop', DeviceKind.WEB, 'web')).rejects.toThrow(/identity/u);
    expect(request).not.toHaveBeenCalled();
    expect(saved).toBeUndefined();
  });
  it('serializes competing starts, never clears a newer draft, and requires explicit abandonment when the result is unknown', async () => {
    let saved: DeviceAuthorizationDraft | undefined;
    const value = invitation(), other = invitation();
    const transport = createRouterTransport(router => router.service(ConnectionService, {
      getServerInfo: () => ({ server: identity }), requestDeviceAuthorization: () => { throw new ConnectError('Reply lost', Code.Unavailable); }
    }));
    const receiver = new DeviceAuthorizationReceiver({ read: async () => saved, write: async draft => { saved = draft; } }, crypto, () => transport);
    const results = await Promise.allSettled([
      receiver.start(formatDeviceInvitation(value), 'Original laptop', DeviceKind.WEB, 'web'),
      receiver.start(formatDeviceInvitation(other), 'Other laptop', DeviceKind.WEB, 'web')
    ]);
    expect(results.every(result => result.status === 'rejected')).toBe(true);
    expect(saved?.invitation.invitationId).toBe(value.invitationId);
    const original = saved!;
    await expect(receiver.discard()).rejects.toThrow(/Reply lost/u);
    expect(saved).toEqual(original);
    saved = { ...original, requestId: randomUUID(), invitation: other };
    await receiver.clear(original.requestId); expect(saved.invitation.invitationId).toBe(other.invitationId);
    await receiver.discard(true); expect(saved).toBeUndefined();
  });
});
