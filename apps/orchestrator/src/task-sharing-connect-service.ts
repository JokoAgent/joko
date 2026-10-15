import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import type { ConnectionManager } from "./connection-manager.js";
import type { TaskSharingHost, TaskShareLease } from "./task-sharing-host.js";
import type { TaskSharingHome, TaskSharingHomeAuthority } from "./task-sharing-home.js";

/** Ordinary paired-node ownership never becomes a foreign guest credential. */
export function createTaskSharingConnectService(options: { readonly host: TaskSharingHost; readonly home: TaskSharingHome;
  readonly connections: ConnectionManager }): ServiceImpl<typeof contract.TaskSharingService> {
  const authenticated = async <T>(context: HandlerContext, work: (authority: TaskSharingHomeAuthority) => Promise<T> | T): Promise<T> => {
    const connection = options.connections.authenticate(context.requestHeader.get("authorization") ?? undefined);
    const revoked = new AbortController(), stop = options.connections.onRevoked(connection.id, () => revoked.abort());
    const signal = AbortSignal.any([context.signal, revoked.signal]);
    const auth: TaskSharingHomeAuthority = { deviceId: connection.deviceId, signal,
      assertCurrent: () => { signal.throwIfAborted(); options.connections.fence(connection); } };
    try { auth.assertCurrent(); const result = await work(auth); auth.assertCurrent(); return result; }
    catch (error) { throw publicError(error, signal); } finally { stop(); }
  };
  const { host, home } = options;
  return {
    listTaskShares: (_request, context) => authenticated(context, async auth => {
      await home.refreshDirectory(auth);
      return create(contract.ListTaskSharesResponseSchema, { owned: [...host.list()], ...home.list() });
    }),
    getTaskShare: (request, context) => authenticated(context, () => create(contract.GetTaskShareResponseSchema, { share: host.get(identity(request.shareId)) })),
    createTaskShare: (request, context) => authenticated(context, () => create(contract.CreateTaskShareResponseSchema,
      { operationId: identity(request.operationId), share: host.create({ operationId: request.operationId, sessionId: identity(request.sessionId) }) })),
    createTaskShareInvitation: (request, context) => authenticated(context, () => create(contract.CreateTaskShareInvitationResponseSchema,
      { operationId: identity(request.operationId), ...host.invite({ operationId: request.operationId, shareId: identity(request.shareId) }) })),
    removeTaskShareMember: (request, context) => authenticated(context, () => create(contract.RemoveTaskShareMemberResponseSchema,
      { operationId: identity(request.operationId), share: host.remove({ operationId: request.operationId, shareId: identity(request.shareId),
        memberId: identity(request.memberId), memberGeneration: request.memberGeneration }) })),
    endTaskShare: (request, context) => authenticated(context, () => create(contract.EndTaskShareResponseSchema,
      { operationId: identity(request.operationId), share: host.end({ operationId: request.operationId, shareId: identity(request.shareId) }) })),
    endAllTaskShares: (request, context) => authenticated(context, async auth => create(contract.EndAllTaskSharesResponseSchema,
      { operationId: identity(request.operationId), ...await host.endAll({ operationId: request.operationId, shareIds: request.shareIds.map(identity) }, auth.assertCurrent) })),
    previewTaskShareInvitation: (request, context) => authenticated(context, async auth => create(contract.PreviewTaskShareInvitationResponseSchema,
      { share: await home.preview(request.invitation, auth) })),
    joinTaskShare: (request, context) => authenticated(context, async auth => create(contract.JoinTaskShareResponseSchema,
      { intent: await home.join(identity(request.operationId), request.invitation, request.displayName, auth) })),
    getTaskShareJoinIntent: (request, context) => authenticated(context, async auth => create(contract.GetTaskShareJoinIntentResponseSchema,
      { intent: await home.lookup(identity(request.operationId), auth) })),
    getTaskSharingActionReceipt: (request, context) => authenticated(context, async auth => {
      const operationId = identity(request.operationId), receipt = await home.lookupAction(operationId, auth) ?? host.lookupAction(operationId);
      if (!receipt) throw new ConnectError("The shared task action receipt was not found.", Code.NotFound);
      return create(contract.GetTaskSharingActionReceiptResponseSchema, { receipt });
    }),
    leaveTaskShare: (request, context) => authenticated(context, async auth => create(contract.LeaveTaskShareResponseSchema,
      { operationId: identity(request.operationId), joined: await home.leave(request.operationId, identity(request.joinId), auth) })),
    getJoinedTaskSnapshot: (request, context) => authenticated(context, async auth => create(contract.GetJoinedTaskSnapshotResponseSchema,
      { state: await home.snapshot(identity(request.joinId), auth) })),
    readJoinedTaskEvents: (request, context) => authenticated(context, async auth => create(contract.ReadJoinedTaskEventsResponseSchema,
      { batch: await home.events(identity(request.joinId), request.after, request.limit || 200, auth) })),
    invokeJoinedTask: (request, context) => authenticated(context, async auth => create(contract.InvokeJoinedTaskResponseSchema,
      { responseBytes: await home.invoke(identity(request.joinId), request.method, request.requestBytes, auth) })),
    transferJoinedTaskAttachment: (request, context) => authenticated(context, async auth => create(contract.TransferJoinedTaskAttachmentResponseSchema,
      { result: await home.transfer(identity(request.joinId), request.transfer, auth) }))
  };
}

/** This generated surface is the only consumer of the TaskShareGuest scheme. */
export function createTaskSharingGuestConnectService(host: TaskSharingHost): ServiceImpl<typeof contract.TaskSharingGuestService> {
  const guest = async <T>(context: HandlerContext, expected: contract.TaskShareScope | undefined,
    work: (lease: TaskShareLease, signal: AbortSignal) => Promise<T> | T, terminal = false): Promise<T> => {
    const lease = host.authenticate(context.requestHeader.get("authorization") ?? undefined, expected);
    const signal = AbortSignal.any([context.signal, lease.signal]);
    try {
      lease.assertCurrent(); signal.throwIfAborted(); const result = await work(lease, signal);
      if (!terminal) { lease.assertCurrent(); signal.throwIfAborted(); } else context.signal.throwIfAborted();
      return result;
    } catch (error) { throw publicError(error, context.signal); } finally { host.release(lease); }
  };
  const scope = (value: contract.TaskShareScope | undefined) => {
    if (!value) throw new ConnectError("The shared task owner is required.", Code.InvalidArgument); return value;
  };
  return {
    inspectTaskShareInvitation: (request, context) => {
      context.signal.throwIfAborted(); return create(contract.InspectTaskShareInvitationResponseSchema, { share: host.previewInvitation(request.invitation) });
    },
    acceptTaskShareJoin: (request, context) => {
      context.signal.throwIfAborted(); identity(request.intentId);
      if (!/^[a-f0-9]{64}$/u.test(request.credentialSha256Hex) || !request.displayName.trim() || request.displayName.trim().length > 128) throw new ConnectError("The task join is invalid.", Code.InvalidArgument);
      identity(request.homeServerId); identity(request.homeDeviceId);
      return create(contract.AcceptTaskShareJoinResponseSchema, host.acceptJoin(request));
    },
    getTaskShareJoinReceipt: (request, context) => guest(context, undefined, lease => create(contract.GetTaskShareJoinReceiptResponseSchema,
      host.getJoinReceipt({ intentId: identity(request.intentId), credentialSha256Hex: request.credentialSha256Hex }, lease))),
    getSharedTaskSnapshot: (request, context) => guest(context, scope(request.scope), async (lease, signal) =>
      create(contract.GetSharedTaskSnapshotResponseSchema, { state: await host.readSnapshot(lease, signal) })),
    readSharedTaskEvents: (request, context) => guest(context, scope(request.scope), (lease, signal) =>
      create(contract.ReadSharedTaskEventsResponseSchema, { batch: host.readEvents(lease, request.after, request.limit || 200, signal) })),
    invokeSharedTask: (request, context) => guest(context, scope(request.scope), async (lease, signal) =>
      create(contract.InvokeSharedTaskResponseSchema, { responseBytes: await host.invoke(lease, request.method, request.requestBytes, signal) })),
    leaveSharedTask: (request, context) => guest(context, scope(request.scope), lease =>
      create(contract.LeaveSharedTaskResponseSchema, host.leave(lease, identity(request.operationId))), true),
    getSharedTaskLeaveReceipt: (request, context) => {
      context.signal.throwIfAborted();
      try {
        const applied = host.lookupLeave(context.requestHeader.get("authorization") ?? undefined,
          { scope: scope(request.scope), operationId: identity(request.operationId) });
        context.signal.throwIfAborted(); return create(contract.GetSharedTaskLeaveReceiptResponseSchema, { applied });
      } catch (error) { throw publicError(error, context.signal); }
    },
    transferSharedTaskAttachment: (request, context) => guest(context, scope(request.scope), async (lease, signal) => {
      if (!request.transfer) throw new ConnectError("The task attachment request is missing.", Code.InvalidArgument);
      return create(contract.TransferSharedTaskAttachmentResponseSchema, { result: await host.transfer(lease, request.transfer, signal) });
    })
  };
}
function identity(value: string): string {
  try { return contract.taskShareIdentity(value); } catch { throw new ConnectError("The shared task identifier is invalid.", Code.InvalidArgument); }
}
function publicError(error: unknown, signal: AbortSignal): ConnectError {
  if (signal.aborted) return new ConnectError("The shared task request was cancelled.", Code.Canceled);
  if (error instanceof ConnectError) return error;
  if (error instanceof RangeError || error instanceof SyntaxError) return new ConnectError("The shared task request is invalid.", Code.InvalidArgument);
  return new ConnectError("The shared task request could not be completed.", Code.Unavailable);
}
