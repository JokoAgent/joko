import { create } from '@bufbuild/protobuf';
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from '@connectrpc/connect';
import { DeviceAuthorizationSchema, DeviceAuthorizationState as State, DeviceKind, type ConnectionService, type NodeConnectionEntry } from '@joko/contracts';
import { DeviceAuthorizationStore, DeviceAuthorizationConflictError, type DeviceAuthorizationRecord, type ConnectionRecord, type OperationalStore } from '@joko/store';
import { toProtoConnection } from './proto-mapper.js';

type Methods = 'createDeviceAuthorizationInvitation' | 'requestDeviceAuthorization' | 'getDeviceAuthorization'
  | 'listDeviceAuthorizations' | 'resolveDeviceAuthorization' | 'claimDeviceAuthorization' | 'cancelDeviceAuthorization' | 'getDeviceAuthorizationEntries' | 'findDeviceAuthorizationInvitation';

export function deviceAuthorizationService(store: OperationalStore, authenticate: (context: HandlerContext) => ConnectionRecord,
  identity: () => { origin: string; serverId: string; endpointPublicKey: string; entries?: NodeConnectionEntry[] }, now: () => number): Pick<ServiceImpl<typeof ConnectionService>, Methods> {
  const sessions = new DeviceAuthorizationStore(store, now);
  const states = { invited: State.INVITED, pending: State.PENDING, approved: State.APPROVED, claimed: State.CLAIMED,
    denied: State.DENIED, cancelled: State.CANCELLED, expired: State.EXPIRED };
  const view = (row: DeviceAuthorizationRecord) => create(DeviceAuthorizationSchema, {
    invitationId: row.id, requestId: row.request?.id, userCode: row.request?.code.replace(/^(.{4})/u, '$1-'),
    state: states[row.state], deviceName: row.request?.name, platform: row.request?.platform,
    deviceKind: row.request?.kind === 'web' ? DeviceKind.WEB : row.request?.kind === 'mobile' ? DeviceKind.MOBILE : row.request?.kind === 'desktop' ? DeviceKind.DESKTOP : DeviceKind.UNSPECIFIED,
    expiresAt: { seconds: BigInt(Math.floor(row.expiresAt / 1000)), nanos: (row.expiresAt % 1000) * 1_000_000 },
    ...(row.connectionId === undefined ? {} : { connection: toProtoConnection(store.getConnection(row.connectionId)) })
  });
  const run = (fn: () => DeviceAuthorizationRecord) => {
    try { return { authorization: view(fn()) }; }
    catch (error) { if (error instanceof DeviceAuthorizationConflictError) throw new ConnectError(error.message, Code.FailedPrecondition); throw error; }
  };
  return {
    createDeviceAuthorizationInvitation: (request, context) => {
      const issuer = authenticate(context), node = identity();
      if (request.entryIds.some(id => !node.entries?.some(entry => entry.entryId === id))) throw new ConnectError('Choose a currently published entrance.', Code.InvalidArgument);
      const entries = node.entries?.filter(entry => !request.entryIds.length || request.entryIds.includes(entry.entryId));
      return { ...run(() => sessions.create(request.invitationId, request.invitationSecretDigest, issuer, request.entryIds,
        { codeDigest: request.invitationCodeDigest || undefined, allowKnock: request.allowKnock })), ...node, entries };
    },
    getDeviceAuthorizationEntries: request => {
      const invitation = sessions.invitation(request.invitationId, request.invitationSecret, request), node = identity();
      return { ...node, entries: node.entries?.filter(entry => !invitation.entryIds?.length || invitation.entryIds.includes(entry.entryId)) };
    },
    findDeviceAuthorizationInvitation: request => {
      const row = sessions.findInvitation(request.invitationCode);
      return { ...identity(), invitationId: row.id, expiresAt: { seconds: BigInt(Math.floor(row.expiresAt / 1000)), nanos: row.expiresAt % 1000 * 1_000_000 } };
    },
    requestDeviceAuthorization: request => run(() => sessions.request({ ...request, name: request.deviceName,
      kind: request.deviceKind === DeviceKind.WEB ? 'web' : request.deviceKind === DeviceKind.MOBILE ? 'mobile' : request.deviceKind === DeviceKind.DESKTOP ? 'desktop' : 'unspecified' })),
    getDeviceAuthorization: request => run(() => sessions.read(request)),
    listDeviceAuthorizations: (_request, context) => { authenticate(context); return { authorizations: sessions.list().map(view) }; },
    resolveDeviceAuthorization: (request, context) => {
      const owner = authenticate(context);
      const decision = request.decision === State.APPROVED ? 'approved' : request.decision === State.DENIED ? 'denied' : request.decision === State.CANCELLED ? 'cancelled' : undefined;
      if (!decision) throw new ConnectError('Invalid device authorization decision.', Code.InvalidArgument);
      return run(() => sessions.resolve(request.invitationId, request.requestId, decision, owner));
    },
    claimDeviceAuthorization: request => run(() => sessions.claim(request)),
    cancelDeviceAuthorization: request => run(() => sessions.cancel(request))
  };
}
