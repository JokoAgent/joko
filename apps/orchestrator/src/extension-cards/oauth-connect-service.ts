import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { ConnectionAuthenticationError, type ConnectionManager } from "../connection-manager.js";
import type { ExtensionOAuthSettings } from "./oauth-settings.js";

export function createExtensionOAuthConnectService(manager: ExtensionOAuthSettings | undefined, connections: ConnectionManager, reconcile: () => void): ServiceImpl<typeof contract.ExtensionOAuthService> {
  const owner = (context: HandlerContext) => {
    const connection = connections.authenticate(context.requestHeader.get("authorization") ?? undefined);
    context.signal.throwIfAborted();
    if (!manager) throw new ConnectError("Plugin authorization is unavailable.", Code.Unavailable);
    // A started flow outlives its Start RPC. Its authority is the original
    // Connection, never that completed request's abort signal.
    const assertCurrent = () => { connections.fence(connection); reconcile(); };
    assertCurrent(); return { manager, connectionId: connection.id, assertCurrent, onRevoked: (listener: () => void) => connections.onRevoked(connection.id, listener) };
  };
  const revision = (value: contract.Revision | undefined) => {
    if (!value || value.value < 1n) throw new ConnectError("A plugin revision is required.", Code.InvalidArgument);
    return value.value;
  };
  const effect = async <T>(work: () => T | Promise<T>): Promise<T> => {
    try { return await work(); } catch (error) {
      if (error instanceof ConnectError || error instanceof ConnectionAuthenticationError) throw error;
      throw new ConnectError("Plugin authorization could not be completed. Refresh the settings and try again.", Code.FailedPrecondition);
    }
  };
  const ticket = (value: ReturnType<ExtensionOAuthSettings["beginClient"]>) => ({ ticketId: value.credentialUploadTicketId,
    relativeEndpoint: `/v1/credentials/upload/${encodeURIComponent(value.credentialUploadTicketId)}`, maximumBytes: BigInt(value.maximumBytes), expiresAt: timestampFromMs(value.expiresAt) });
  return {
    get: (request, context) => effect(() => { const owned = owner(context); return create(contract.ExtensionOAuthServiceGetResponseSchema, { state: owned.manager.get(request.extensionId) }); }),
    beginClient: (request, context) => effect(() => {
      const owned = owner(context);
      return create(contract.ExtensionOAuthServiceBeginClientResponseSchema, { ticket: ticket(owned.manager.beginClient(request.extensionId, request.slotKey, revision(request.expectedRevision), owned.connectionId)) });
    }),
    commitClient: (request, context) => effect(async () => {
      const owned = owner(context); return create(contract.ExtensionOAuthServiceCommitClientResponseSchema, { state: await owned.manager.commitClient(request.extensionId, request.credentialUploadTicketId, owned) });
    }),
    change: (request, context) => effect(async () => {
      const owned = owner(context), action = request.action;
      if (!action.case || !action.value || typeof action.value === "string" && action.value.length > 64) throw new ConnectError("An account action is required.", Code.InvalidArgument);
      const selected = action.case === "clearClient" ? { kind: "clear" as const } : { kind: action.case === "removeAccountId" ? "remove" as const : "default" as const, id: action.value };
      return create(contract.ExtensionOAuthServiceChangeResponseSchema, { state: await owned.manager.change(request.extensionId, request.slotKey, revision(request.expectedRevision), selected, owned) });
    }),
    start: (request, context) => effect(() => {
      const owned = owner(context); return create(contract.ExtensionOAuthServiceStartResponseSchema, { flow: owned.manager.start(request.extensionId, request.slotKey, revision(request.expectedRevision), request.scopes, owned) });
    }),
    getFlow: (request, context) => effect(() => { const owned = owner(context); return create(contract.ExtensionOAuthServiceGetFlowResponseSchema, { flow: owned.manager.getFlow(request.flowId, owned.connectionId) }); }),
    beginCallback: (request, context) => effect(() => { const owned = owner(context); return create(contract.ExtensionOAuthServiceBeginCallbackResponseSchema, { ticket: ticket(owned.manager.beginCallback(request.flowId, owned.connectionId)) }); }),
    completeCallback: (request, context) => effect(() => { const owned = owner(context); return create(contract.ExtensionOAuthServiceCompleteCallbackResponseSchema, { flow: owned.manager.completeCallback(request.flowId, request.credentialUploadTicketId, owned.connectionId) }); }),
    cancelFlow: (request, context) => effect(() => { const owned = owner(context); return create(contract.ExtensionOAuthServiceCancelFlowResponseSchema, { flow: owned.manager.cancelFlow(request.flowId, owned.connectionId) }); })
  };
}
