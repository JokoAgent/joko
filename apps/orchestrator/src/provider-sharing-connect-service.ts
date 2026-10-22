import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import type { ConnectionManager } from "./connection-manager.js";
import { providerSharingPublicError, type ProviderSharingHost } from "./provider-sharing-host.js";
import type { ProviderSharingHome, ProviderSharingHomeAuthority } from "./provider-sharing-home.js";

export interface ProviderSharingConnectOptions {
  readonly host: ProviderSharingHost; readonly home: ProviderSharingHome; readonly connections: ConnectionManager;
}
/** Management is owned by this Home. Foreign Provider bearers cannot become
 * Connections, task guests, Device peers, or management authorities. */
export function createProviderSharingConnectService(options: ProviderSharingConnectOptions): ServiceImpl<typeof contract.ProviderSharingService> {
  const owner = async <T>(context: HandlerContext, work: (authority: ProviderSharingHomeAuthority) => Promise<T> | T): Promise<T> => {
    let stop: (() => void) | undefined;
    try {
      const connection = options.connections.authenticate(context.requestHeader.get("authorization") ?? undefined);
      const revoked = new AbortController(); stop = options.connections.onRevoked(connection.id, () => revoked.abort());
      const signal = AbortSignal.any([context.signal, revoked.signal]);
      const authority: ProviderSharingHomeAuthority = { deviceId: connection.deviceId, signal,
        assertCurrent: () => { signal.throwIfAborted(); options.connections.fence(connection); } };
      authority.assertCurrent(); const result = await work(authority); authority.assertCurrent(); return result;
    } catch (error) { if (context.signal.aborted) throw new ConnectError("Provider sharing request was cancelled.", Code.Canceled); return providerSharingPublicError(error); }
    finally { stop?.(); }
  };
  const list = () => ({ owned: [...options.host.list()], received: [...options.home.received()], intents: [...options.home.intents()] });
  return {
    listProviderShares: (_request, context) => owner(context, list),
    createProviderShareLink: (request, context) => owner(context, () => options.host.issue(request)),
    decideProviderShareRequest: (request, context) => owner(context, () => create(contract.DecideProviderShareRequestResponseSchema, { share: options.host.decide(request) })),
    setProviderShareMember: (request, context) => owner(context, () => create(contract.SetProviderShareMemberResponseSchema, { share: options.host.member(request) })),
    decideProviderReshare: (request, context) => owner(context, () => create(contract.DecideProviderReshareResponseSchema, { share: options.host.decideReshare(request) })),
    previewProviderShare: (request, context) => owner(context, async authority => create(contract.PreviewProviderShareResponseSchema, { preview: await options.home.preview(request.link, authority) })),
    applyProviderShare: (request, context) => owner(context, async authority => create(contract.ApplyProviderShareResponseSchema, { intent: await options.home.apply(request, authority) })),
    refreshProviderSharing: (_request, context) => owner(context, async authority => { await options.home.refresh(authority); await options.host.reconcile(); return list(); }),
    withdrawProviderShare: (request, context) => owner(context, async authority => create(contract.WithdrawProviderShareResponseSchema, { intent: await options.home.withdraw(request.operationId, request.applicationId, authority) })),
    leaveReceivedProviderShare: (request, context) => owner(context, async authority => create(contract.LeaveReceivedProviderShareResponseSchema, { received: await options.home.leave(request.operationId, request.joinId, authority) }))
  };
}
/** The sole public control surface for foreign Provider credentials. The
 * terminal cleanup RPC is deliberately separate from live native authority. */
export function createProviderSharingGuestConnectService(host: ProviderSharingHost): ServiceImpl<typeof contract.ProviderSharingGuestService> {
  const invoke = async <T>(context: HandlerContext, work: () => T | Promise<T>): Promise<T> => {
    try { context.signal.throwIfAborted(); const result = await work(); context.signal.throwIfAborted(); return result; }
    catch (error) { if (context.signal.aborted) throw new ConnectError("Provider sharing request was cancelled.", Code.Canceled); return providerSharingPublicError(error); }
  };
  const authorization = (context: HandlerContext) => context.requestHeader.get("authorization") ?? undefined;
  return {
    inspectProviderShare: (request, context) => invoke(context, () => create(contract.InspectProviderShareResponseSchema, { preview: host.inspect(request.invitation) })),
    submitProviderShareRequest: (request, context) => invoke(context, () => host.submit(request)),
    getProviderShareRequest: (request, context) => invoke(context, () => host.request(request.requestId, authorization(context))),
    withdrawProviderShareRequest: (request, context) => invoke(context, () => host.withdraw(request.operationId, request.requestId, authorization(context))),
    readProviderShare: (request, context) => invoke(context, () => host.read(request.shareId, authorization(context))),
    leaveProviderShare: (request, context) => invoke(context, () => host.leave(request.operationId, request.shareId, authorization(context))),
    getProviderShareLeaveReceipt: (request, context) => invoke(context, () => host.leaveReceipt(request.operationId, request.shareId, authorization(context))),
    syncProviderReshares: (request, context) => invoke(context, () => host.sync(request, context)),
    closeProviderShareRun: (request, context) => invoke(context, async () => { await host.closeRun(request.runId, authorization(context)); return create(contract.CloseProviderShareRunResponseSchema); })
  };
}
