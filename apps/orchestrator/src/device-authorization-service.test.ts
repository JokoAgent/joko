import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createClient, createRouterTransport, ConnectError, Code, type ConnectRouter } from '@connectrpc/connect';
import { ConnectionService, DeviceAuthorizationState as State, DeviceKind } from '@joko/contracts';
import { OperationalStore } from '@joko/store';
import { describe, expect, it } from 'vitest';
import { deviceAuthorizationService } from './device-authorization-service.js';
import { connectionEntryDirectory, prepareConnectionEntry, publishConnectionEntry } from './connection-entries.js';
import type { OrchestratorApplication } from './application.js';
import { DeviceAuthorizationReceiver, deviceAuthorizationOwner, authorizationView, formatDeviceInvitation, type DeviceAuthorizationDraft, type DeviceTransportRequestDraft } from '@joko/connection-transport/device-authorization';
import { installIrohClientBinding, installTailcatClientBinding, type EndpointTransport } from '@joko/connection-transport/trust';

const digest = (text: string) => createHash('sha256').update(text).digest('hex');
describe('device approval RPC boundary', () => {
  it.each(['iroh', 'tailcat'] as const)('completes the %s private invitation RPC flow with a logical HTTP origin, scoped admission and saved recovery', async kind => {
    // Exercise the real authorization/entry/store chain. Native carrier execution
    // remains covered by the fixed SDK's separate runtime checks.
    const store = new OperationalStore(':memory:');
    const identity = { origin: `http://127.0.0.1:${kind === 'iroh' ? 4318 : 4319}`, serverId: `private-${kind}`, endpointPublicKey: `ed25519:${'c'.repeat(64)}` };
    const app = { store, serverId: identity.serverId, config: { publicOrigin: identity.origin }, linkspanIdentity: { publicKey: identity.endpointPublicKey } } as OrchestratorApplication;
    const endpointTransport: EndpointTransport = kind === 'iroh'
      ? { kind, endpointId: 'e'.repeat(64), ticket: 'private-iroh-ticket' }
      : { kind, endpointId: `nodekey:${'e'.repeat(64)}`, address: 'tcPrivate-address', port: 4318 };
    const retire = publishConnectionEntry(store, { id: 'private', provider: kind, origin: identity.origin, transport: endpointTransport, allowPrivateAddressPairing: true });
    const noCarrier = async () => { throw new Error('This RPC test does not dial a native carrier.'); };
    const restore = kind === 'iroh' ? installIrohClientBinding({ connect: noCarrier, createIdentity: async () => ({ publicKey: 'a'.repeat(64), privateKey: 'b'.repeat(64) }) })
      : installTailcatClientBinding({ connect: noCarrier, createIdentity: async () => ({ publicKey: `nodekey:${'a'.repeat(64)}`, privateKey: `privkey:${'b'.repeat(64)}` }) });
    try {
      const ownerKey = randomBytes(32).toString('hex'), existing = store.createConnection({ id: randomUUID(), name: 'Original device', authKeyDigest: digest(ownerKey) });
      const authenticate = (context: { requestHeader: Headers }) => {
        if (context.requestHeader.get('authorization') !== `Bearer ${ownerKey}`) throw new ConnectError('Owner required', Code.Unauthenticated);
        return store.authorizeConnection(existing.id, digest(ownerKey));
      };
      const routes = (router: ConnectRouter) => router.service(ConnectionService, {
        ...deviceAuthorizationService(store, authenticate, () => ({ ...identity, ...connectionEntryDirectory(app) }), Date.now),
        getServerInfo: () => ({ server: identity }),
        prepareConnectionEntry: (request, context) => prepareConnectionEntry(app, { ...request, connectionId: authenticate(context).id, signal: context.signal, assertCurrent: () => { authenticate(context); } })
      });
      const transport = createRouterTransport(routes);
      const owner = deviceAuthorizationOwner(createClient(ConnectionService, createRouterTransport(routes, { transport: { interceptors: [next => request => {
        request.header.set('authorization', `Bearer ${ownerKey}`); return next(request);
      }] } })), () => {});
      let draft: DeviceAuthorizationDraft | undefined, request: DeviceTransportRequestDraft | undefined;
      const storage = { read: async () => draft, write: async (value: DeviceAuthorizationDraft | undefined) => { draft = value; },
        readTransportRequest: async () => request, writeTransportRequest: async (value: DeviceTransportRequestDraft | undefined) => { request = value; } };
      const crypto = { uuid: randomUUID, secret: () => randomBytes(32).toString('hex'), digest: async (value: string) => digest(value) };
      const receiver = () => new DeviceAuthorizationReceiver(storage, crypto, target => {
        expect(target.origin).toBe(identity.origin); expect(target.endpointTransport).toMatchObject({ kind, clientKey: request!.privateKey }); return transport;
      });
      const first = receiver(), requestLink = await first.transportRequest(kind);
      const invitationId = randomUUID(), invitationSecret = randomBytes(32).toString('hex');
      const created = await owner.create({ invitationId, invitationSecretDigest: digest(invitationSecret), entryIds: ['private'] });
      const invitation = await owner.invitationEntry!({ ...identity, invitationId, invitationSecret, expiresAt: authorizationView(created.authorization).expiresAt }, 'private', requestLink);
      const link = formatDeviceInvitation(invitation);
      expect(link).not.toContain(request!.privateKey);
      expect((await first.entries(link)).map(entry => entry.id)).toEqual(['private']);
      await expect(first.start(formatDeviceInvitation({ ...invitation, endpointPublicKey: `ed25519:${'d'.repeat(64)}` }), 'New device', DeviceKind.MOBILE, 'mobile', undefined, 'private')).rejects.toThrow(/identity/u);
      expect(draft).toBeUndefined(); expect((await owner.list()).map(row => row.state)).toEqual(['invited']);
      await expect(createClient(ConnectionService, transport).requestDeviceAuthorization({ invitationId, invitationSecret, requestId: randomUUID(), requesterSecret: randomBytes(32).toString('hex'),
        authKeyDigest: digest(randomBytes(32).toString('hex')), deviceName: 'Not allowed', deviceKind: DeviceKind.MOBILE, platform: 'mobile', entryId: 'direct' })).rejects.toThrow();
      const pending = await first.start(link, 'New device', DeviceKind.MOBILE, 'mobile', undefined, 'private');
      expect(pending.state).toBe('pending'); expect(store.listConnections()).toHaveLength(1);
      await owner.resolve(invitationId, pending.requestId, 'approved');
      const reopened = receiver(), claimed = await reopened.claim();
      expect((await reopened.claim()).authorization.connection).toEqual(claimed.authorization.connection);
      expect(store.listConnections()).toHaveLength(2);
      expect(store.authorizeConnection(claimed.authorization.connection!.connectionId, digest(claimed.draft.authKey)).deviceId).not.toBe(existing.deviceId);
      await reopened.clear(pending.requestId); expect(draft).toBeUndefined(); expect(request).toBeUndefined();
    } finally { restore(); retire(); store.close(); }
  });
  it('requires a normal owner for approval, exposes no proofs, and returns the same claim after retry', async () => {
    const store = new OperationalStore(':memory:');
    try {
      const ownerKey = randomBytes(32).toString('hex');
      const owner = store.createConnection({ id: randomUUID(), name: 'Phone', authKeyDigest: digest(ownerKey) });
      const authenticate = (context: { requestHeader: Headers }) => {
        if (context.requestHeader.get('authorization') !== `Bearer ${ownerKey}`) throw new ConnectError('Normal node connection required', Code.Unauthenticated);
        return store.authorizeConnection(owner.id, digest(ownerKey));
      };
      const identity = { origin: 'https://rpc-approval.example', serverId: 'approval-rpc', endpointPublicKey: `ed25519:${'c'.repeat(64)}` };
      const client = createClient(ConnectionService, createRouterTransport(router => router.service(ConnectionService, deviceAuthorizationService(store, authenticate, () => identity, Date.now))));
      const options = { headers: { authorization: `Bearer ${ownerKey}` } };
      const invitationId = randomUUID(), invitationSecret = randomBytes(32).toString('hex'), requesterSecret = randomBytes(32).toString('hex'), authKey = randomBytes(32).toString('hex');
      const input = { invitationId, invitationSecretDigest: digest(invitationSecret) };
      await expect(client.createDeviceAuthorizationInvitation(input)).rejects.toMatchObject({ code: Code.Unauthenticated });
      await client.createDeviceAuthorizationInvitation(input, options);
      const request = { invitationId, invitationSecret, requesterSecret, requestId: randomUUID(), authKeyDigest: digest(authKey), deviceName: 'Browser', deviceKind: DeviceKind.WEB, platform: 'web' };
      const pending = await client.requestDeviceAuthorization(request);
      expect(pending.authorization?.state).toBe(State.PENDING);
      const decision = { invitationId, requestId: request.requestId, decision: State.APPROVED };
      await expect(client.resolveDeviceAuthorization(decision)).rejects.toMatchObject({ code: Code.Unauthenticated });
      await expect(client.listDeviceAuthorizations({})).rejects.toMatchObject({ code: Code.Unauthenticated });
      const list = await client.listDeviceAuthorizations({}, options);
      for (const key of [authKey, requesterSecret, invitationSecret, digest(authKey), digest(requesterSecret)]) expect(JSON.stringify(list, (_key, value) => typeof value === 'bigint' ? String(value) : value)).not.toContain(key);
      await client.resolveDeviceAuthorization(decision, options);
      const proof = { invitationId, requestId: request.requestId, requesterSecret };
      const first = await client.claimDeviceAuthorization(proof), again = await client.claimDeviceAuthorization(proof);
      expect(first.authorization?.connection).toEqual(again.authorization?.connection);
      expect(store.authorizeConnection(first.authorization!.connection!.connectionId, digest(authKey)).deviceId).not.toBe(owner.deviceId);
    } finally { store.close(); }
  });
});
