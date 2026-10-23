import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import type { ConnectionManager } from "./connection-manager.js";
import type { TaskSharingHomeAuthority } from "./task-sharing-home.js";
import type { PartnerIdentityDirectory } from "./partner-identity-directory.js";

export function createPartnerIdentityService(directory: PartnerIdentityDirectory, connections: ConnectionManager): ServiceImpl<typeof contract.PartnerIdentityService> {
  const owner = async <T>(context: HandlerContext, work: (auth: TaskSharingHomeAuthority) => T | Promise<T>): Promise<T> => {
    let stop: (() => void) | undefined;
    try {
      const connection = connections.authenticate(context.requestHeader.get("authorization") ?? undefined), revoked = new AbortController();
      stop = connections.onRevoked(connection.id, () => revoked.abort());
      const signal = AbortSignal.any([context.signal, revoked.signal]);
      const auth: TaskSharingHomeAuthority = { deviceId: connection.deviceId, signal,
        assertCurrent: () => { signal.throwIfAborted(); connections.fence(connection); } };
      auth.assertCurrent(); const value = await work(auth); auth.assertCurrent(); return value;
    } catch (error) { return publicError(error, context.signal); }
    finally { stop?.(); }
  };
  return {
    listPartnerIdentities: (_request, context) => owner(context, () => directory.list()),
    issuePartnerIdentity: (request, context) => owner(context, () => directory.issue(request)),
    revokePartnerIdentity: (request, context) => owner(context, () => directory.revoke(request)),
    importPartnerIdentity: (request, context) => owner(context, async auth => create(contract.ImportPartnerIdentityResponseSchema, { link: await directory.import(request.invitation, request.alias, auth) })),
    renamePartnerIdentity: (request, context) => owner(context, () => create(contract.RenamePartnerIdentityResponseSchema, { link: directory.rename(request.linkId, request.alias) })),
    forgetPartnerIdentity: (request, context) => owner(context, async auth => { await directory.forget(request.operationId, request.linkId, auth); return create(contract.ForgetPartnerIdentityResponseSchema); }),
    openPartnerIdentity: (request, context) => owner(context, auth => directory.open(request, auth))
  };
}
export function createPartnerIdentityGuestService(directory: PartnerIdentityDirectory): ServiceImpl<typeof contract.PartnerIdentityGuestService> {
  const guest = <T>(context: HandlerContext, work: () => T): T => {
    try { context.signal.throwIfAborted(); const result = work(); context.signal.throwIfAborted(); return result; }
    catch (error) { return publicError(error, context.signal); }
  };
  return {
    inspectPartnerIdentity: (request, context) => guest(context, () => directory.inspect(request, context.requestHeader.get("authorization") ?? undefined)),
    resolvePartnerIdentity: (request, context) => guest(context, () => directory.resolve(request, context.requestHeader.get("authorization") ?? undefined))
  };
}
function publicError(error: unknown, signal: AbortSignal): never {
  if (signal.aborted) throw new ConnectError("The partner identity request was cancelled.", Code.Canceled);
  if (error instanceof ConnectError) throw error;
  throw new ConnectError("The partner identity request is unavailable.", Code.Unavailable);
}
