import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { McpUiHostContextSchema } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { ConnectionManager } from "../connection-manager.js";
import type { McpAppsManager } from "./manager.js";
import { MCP_APPS_MAX_BYTES } from "./protocol.js";

/** Browser-owned fetch metadata excludes the public Renderer; native owners use their revocable Connection. */
export function createMcpAppNativeService(manager: McpAppsManager | undefined, connections: ConnectionManager): ServiceImpl<typeof contract.McpAppNativeService> {
  return { operate: async (request, context) => {
    const connection = connections.authenticate(context.requestHeader.get("authorization") ?? undefined);
    if (manager === undefined) throw new ConnectError("Application cards are unavailable.", Code.Unavailable);
    if (["sec-fetch-mode", "sec-fetch-dest", "sec-fetch-site", "origin"].some(name => context.requestHeader.has(name))
      || !manager.nativeDevice(connection.deviceId)) throw new ConnectError("A native application host is required.", Code.PermissionDenied);
    const view = request.view;
    if (!view || !view.sessionId || view.sessionId.length > 256 || !/^[A-Za-z0-9_-]{8,128}$/u.test(view.uiOwnerId)
      || [view.viewId, view.cardId, view.openId, request.linkId].some(value => value.length > 256)
      || Buffer.byteLength(view.contextJson) > 64 * 1024 || Buffer.byteLength(request.messageJson) > MCP_APPS_MAX_BYTES
      || request.after > BigInt(Number.MAX_SAFE_INTEGER)) throw new ConnectError("Invalid native application request.", Code.InvalidArgument);
    const caller = manager.callerForDevice(connection.id, connection.deviceId, view.uiOwnerId), host = manager.host;
    const check = () => { connections.fence(connection); };
    try {
      check();
      switch (request.operation) {
        case contract.McpAppNativeOperation.OPEN: {
          if (!view.cardId || !view.openId) throw new Error("MCP_APP_CARD_REQUIRED");
          const stop = connections.onRevoked(connection.id, () => { void host.releaseCaller(caller); });
          const cancel = () => { void host.cancelOpen(caller, view.sessionId, view.openId); };
          context.signal.addEventListener("abort", cancel, { once: true });
          let document;
          try {
            context.signal.throwIfAborted();
            document = await host.open(caller, view.sessionId, view.cardId,
              view.contextJson ? McpUiHostContextSchema.parse(JSON.parse(view.contextJson)) : {}, view.openId);
            context.signal.throwIfAborted(); check();
            manager.retainNativeView(document.viewId, stop);
            return create(contract.McpAppNativeServiceOperateResponseSchema, { document: {
              viewId: document.viewId, html: document.html, csp: document.csp, prefersBorder: document.prefersBorder,
              connectDomains: document.policy?.connectDomains, resourceDomains: document.policy?.resourceDomains,
              frameDomains: document.policy?.frameDomains, baseUriDomains: document.policy?.baseUriDomains
            } });
          } catch (error) {
            stop(); if (document) await host.teardown(caller, view.sessionId, document.viewId).catch(() => undefined);
            throw error;
          } finally { context.signal.removeEventListener("abort", cancel); }
        }
        case contract.McpAppNativeOperation.MESSAGE:
          await host.dispatch(caller, view.sessionId, view.viewId, JSON.parse(request.messageJson)); break;
        case contract.McpAppNativeOperation.POLL: {
          const events = await host.poll(caller, view.sessionId, view.viewId, Number(request.after)); check();
          return create(contract.McpAppNativeServiceOperateResponseSchema, { eventsJson: JSON.stringify(events) });
        }
        case contract.McpAppNativeOperation.AUTHORIZE_LINK: {
          const grant = await host.authorizeLink(caller, view.sessionId, view.viewId, request.linkId, request.url); check();
          return create(contract.McpAppNativeServiceOperateResponseSchema, { linkValidForMs: grant.validForMs });
        }
        case contract.McpAppNativeOperation.LINK_RESULT:
          await host.assertViewAuthorized(caller, view.sessionId, view.viewId);
          host.linkResult(caller, view.sessionId, view.viewId, request.linkId, request.success); break;
        default: throw new ConnectError("Unknown native application operation.", Code.InvalidArgument);
      }
      check(); return create(contract.McpAppNativeServiceOperateResponseSchema);
    } catch (error) {
      if (error instanceof ConnectError) throw error;
      throw new ConnectError("The application View is unavailable.", context.signal.aborted ? Code.Canceled : Code.FailedPrecondition);
    }
  } };
}
