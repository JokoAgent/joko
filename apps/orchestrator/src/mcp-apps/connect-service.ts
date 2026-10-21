import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { McpUiHostContextSchema } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { ConnectionManager } from "../connection-manager.js";
import type { McpAppsManager } from "./manager.js";
import type { McpAppSurfaces } from "./surface.js";

export function createMcpAppConnectService(manager: McpAppsManager | undefined, surfaces: McpAppSurfaces | undefined,
  connections: ConnectionManager): ServiceImpl<typeof contract.McpAppService> {
  return {
    operate: async (request, context) => {
      const connection = connections.authenticate(context.requestHeader.get("authorization") ?? undefined);
      if (manager === undefined || surfaces === undefined) throw new ConnectError("Application cards are unavailable.", Code.Unavailable);
      if (!request.sessionId || request.sessionId.length > 256 || !/^[A-Za-z0-9_-]{8,128}$/u.test(request.uiOwnerId)
        || request.viewId.length > 256 || request.cardId.length > 256 || request.openId.length > 256
        || Buffer.byteLength(request.contextJson) > 64 * 1024) throw new ConnectError("Invalid application card request.", Code.InvalidArgument);
      const caller = manager.callerForDevice(connection.id, connection.deviceId, request.uiOwnerId);
      const assertCaller = () => { connections.fence(connection); };
      const host = manager.host;
      try {
        assertCaller();
        let hostContext = {};
        if (request.contextJson) hostContext = McpUiHostContextSchema.parse(JSON.parse(request.contextJson));
        switch (request.operation) {
          case contract.McpAppOperation.OPEN: {
            if (!request.cardId || !request.openId) throw new ConnectError("Application card identity is required.", Code.InvalidArgument);
            const close = () => { void host.releaseCaller(caller); };
            const stop = connections.onRevoked(connection.id, close);
            const cancel = () => { void host.cancelOpen(caller, request.sessionId, request.openId); };
            context.signal.addEventListener("abort", cancel, { once: true });
            let document;
            try {
              context.signal.throwIfAborted();
              document = await host.open(caller, request.sessionId, request.cardId, hostContext, request.openId);
              context.signal.throwIfAborted();
              assertCaller();
              const proxyUrl = surfaces.supply(document, caller, request.sessionId, assertCaller, stop);
              return create(contract.McpAppServiceOperateResponseSchema, { viewId: document.viewId, proxyUrl, prefersBorder: document.prefersBorder });
            } catch (error) {
              stop();
              if (document !== undefined) await host.teardown(caller, request.sessionId, document.viewId).catch(() => undefined);
              throw error;
            } finally { context.signal.removeEventListener("abort", cancel); }
          }
          case contract.McpAppOperation.CANCEL_OPEN:
            if (!request.openId) throw new ConnectError("Open identity is required.", Code.InvalidArgument);
            await host.cancelOpen(caller, request.sessionId, request.openId); break;
          case contract.McpAppOperation.CONTEXT:
            await host.assertViewAuthorized(caller, request.sessionId, request.viewId);
            host.context(caller, request.sessionId, request.viewId, hostContext); break;
          case contract.McpAppOperation.DISPLAY_MODE:
            await host.assertViewAuthorized(caller, request.sessionId, request.viewId);
            if (request.displayMode !== "inline" && request.displayMode !== "fullscreen") throw new ConnectError("Unsupported display mode.", Code.InvalidArgument);
            host.displayMode(caller, request.sessionId, request.viewId, request.displayMode); break;
          case contract.McpAppOperation.TEARDOWN:
            await host.teardown(caller, request.sessionId, request.viewId); break;
          default: throw new ConnectError("Unknown application card operation.", Code.InvalidArgument);
        }
        assertCaller();
        return create(contract.McpAppServiceOperateResponseSchema);
      } catch (error) {
        if (error instanceof ConnectError) throw error;
        if (context.signal.aborted) throw new ConnectError("Application card request cancelled.", Code.Canceled);
        throw new ConnectError("Application card is unavailable. Check the task and server connection, then retry.", Code.FailedPrecondition);
      }
    }
  };
}
