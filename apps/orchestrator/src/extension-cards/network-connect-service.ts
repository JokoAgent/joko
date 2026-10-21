import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { ConnectionAuthenticationError, type ConnectionManager } from "../connection-manager.js";
import type { ExtensionNetworkSettings } from "./network-settings.js";

export function createExtensionNetworkConnectService(manager: ExtensionNetworkSettings | undefined, connections: ConnectionManager, reconcile: () => void): ServiceImpl<typeof contract.ExtensionNetworkService> {
  const owner = (context: HandlerContext, extensionId: string) => {
    const connection = connections.authenticate(context.requestHeader.get("authorization") ?? undefined);
    if (!extensionId || extensionId.length > 256) throw new ConnectError("Invalid extension identity.", Code.InvalidArgument);
    if (!manager) throw new ConnectError("Extension connections are unavailable.", Code.Unavailable);
    const assertCurrent = () => { context.signal.throwIfAborted(); connections.fence(connection); reconcile(); };
    assertCurrent(); return { manager, connection, assertCurrent };
  };
  const revision = (value: contract.Revision | undefined) => {
    if (!value || value.value < 1n) throw new ConnectError("An extension revision is required.", Code.InvalidArgument);
    return value.value;
  };
  const effect = async <T>(work: () => T | Promise<T>): Promise<T> => {
    try { return await work(); }
    catch (error) {
      if (error instanceof ConnectError || error instanceof ConnectionAuthenticationError) throw error;
      throw new ConnectError("The connection could not be changed. Refresh the plugin settings and check the address and token.", Code.FailedPrecondition);
    }
  };
  return {
    get: (request, context) => effect(() => {
      const owned = owner(context, request.extensionId);
      return create(contract.ExtensionNetworkServiceGetResponseSchema, { state: owned.manager.get(request.extensionId) });
    }),
    beginCredential: (request, context) => effect(() => {
      const owned = owner(context, request.extensionId);
      const ticket = owned.manager.begin({ extensionId: request.extensionId, revision: revision(request.expectedRevision), slotKey: request.slotKey,
        host: request.host, ...(request.label === undefined ? {} : { label: request.label }), connectionId: owned.connection.id });
      return create(contract.ExtensionNetworkServiceBeginCredentialResponseSchema, { ticket: { ticketId: ticket.credentialUploadTicketId,
        relativeEndpoint: `/v1/credentials/upload/${encodeURIComponent(ticket.credentialUploadTicketId)}`, expiresAt: timestampFromMs(ticket.expiresAt), maximumBytes: BigInt(ticket.maximumBytes) } });
    }),
    commitCredential: (request, context) => effect(async () => {
      const owned = owner(context, request.extensionId);
      const state = await owned.manager.commit(request.extensionId, request.credentialUploadTicketId, owned.connection.id, owned.assertCurrent);
      return create(contract.ExtensionNetworkServiceCommitCredentialResponseSchema, { state });
    }),
    change: (request, context) => effect(async () => {
      const owned = owner(context, request.extensionId), action = request.action;
      if (!action.case || !action.value || action.value.length > 128) throw new ConnectError("A connection action is required.", Code.InvalidArgument);
      const state = await owned.manager.change({ extensionId: request.extensionId, revision: revision(request.expectedRevision), slotKey: request.slotKey,
        id: action.value, action: action.case === "removeConnectionId" ? "remove" : "default" }, owned.assertCurrent);
      return create(contract.ExtensionNetworkServiceChangeResponseSchema, { state });
    })
  };
}
