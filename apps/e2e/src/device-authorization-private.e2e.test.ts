import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createClient } from '@connectrpc/connect';
import { createConnectTransport } from '@joko/connection-transport/node';
import { DeviceKind, OperationService } from '@joko/contracts';
import { DeviceAuthorizationReceiver, authorizationView, deviceAuthorizationOwner, formatDeviceInvitation, type DeviceAuthorizationDraft } from '@joko/connection-transport/device-authorization';
import { publishConnectionEntry } from '@joko/orchestrator';
import { expect, it } from 'vitest';
import { OrchestratorE2eFixture } from './fixture.js';
import { createSessionMutation, sessionIdFrom, submit } from './operations.js';

it('invites an independent device entirely over private CONNECT and recovers a lost operation receipt through that entrance', async () => {
  const fixture = await OrchestratorE2eFixture.start({ httpConnect: true });
  const origin = fixture.baseUrl.replace('http:', 'https:');
  const retire = publishConnectionEntry(fixture.application.store, { id: 'private-connect', provider: 'frp', origin, transport: fixture.httpConnectTransport });
  let draft: DeviceAuthorizationDraft | undefined;
  try {
    const existing = await fixture.pair(), owner = deviceAuthorizationOwner(existing.clients.connection, () => {});
    const invitationId = randomUUID(), secret = randomBytes(32).toString('hex');
    const result = await owner.create({ invitationId, invitationSecretDigest: createHash('sha256').update(secret).digest('hex') });
    const invitation = await owner.invitationEntry!({ invitationId, invitationSecret: secret, origin: result.origin,
      serverId: result.serverId, endpointPublicKey: result.endpointPublicKey, expiresAt: authorizationView(result.authorization).expiresAt }, 'private-connect');
    expect(invitation.endpointTransport?.kind).toBe('http-connect');
    // There is no TLS listener at this logical HTTPS origin. A successful request must use CONNECT.
    const receiver = new DeviceAuthorizationReceiver({ read: async () => draft, write: async value => { draft = value; } },
      { uuid: randomUUID, secret: () => randomBytes(32).toString('hex'), digest: async value => createHash('sha256').update(value).digest('hex') },
      target => createConnectTransport({ baseUrl: target.origin, endpointPublicKey: target.endpointPublicKey, endpointTransport: target.endpointTransport,
        transportKind: target.endpointTransport?.kind, httpVersion: '1.1' }));
    const progress = await receiver.start(formatDeviceInvitation(invitation), 'Private device', DeviceKind.DESKTOP, 'test', undefined, 'private-connect');
    expect(progress.state).toBe('pending'); expect(fixture.application.store.listConnections()).toHaveLength(1);
    await owner.resolve(progress.invitationId, progress.requestId, 'approved');
    const claimed = await receiver.claim(); expect(fixture.application.store.listConnections()).toHaveLength(2);
    expect((await receiver.claim()).authorization.connection?.connectionId).toBe(claimed.authorization.connection?.connectionId);
    const operationId = randomUUID(); let dispatched = 0;
    const lostReply = createClient(OperationService, createConnectTransport({ baseUrl: fixture.baseUrl, httpVersion: '1.1',
      endpointPublicKey: result.endpointPublicKey, interceptors: [next => async request => {
        request.header.set('authorization', `Bearer ${existing.authKey}`);
        const response = await next(request); if (request.method.name === 'SubmitOperation') { dispatched++; throw new Error('Receipt lost after commit'); } return response;
      }] }));
    await expect(submit(lostReply, existing.connectionId, createSessionMutation({ backendId: fixture.adapter().id, targetId: fixture.targetId() }), operationId)).rejects.toThrow(/Receipt lost/u);
    const recovery = createClient(OperationService, createConnectTransport({ baseUrl: origin, httpVersion: '1.1', endpointPublicKey: result.endpointPublicKey,
      transportKind: 'http-connect', endpointTransport: fixture.httpConnectTransport, interceptors: [next => request => {
        request.header.set('authorization', `Bearer ${existing.authKey}`); return next(request);
      }] }));
    const operation = (await recovery.getOperation({ operationId })).operation!;
    expect(sessionIdFrom(operation)).toBeTruthy(); expect(dispatched).toBe(1);
    expect(fixture.application.store.listSessions()).toHaveLength(1);
    expect(fixture.httpConnectRequests).toBeGreaterThan(5);
    fixture.application.connections.revoke(claimed.authorization.connection!.connectionId);
    await expect(receiver.claim()).rejects.toBeDefined();
  } finally { retire(); await fixture.close(); }
}, 30_000);
