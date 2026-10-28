import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type ServiceImpl } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import type { AppDefaultModelCoordinator } from "./app-default-model.js";
import type { ConnectionManager } from "./connection-manager.js";

function route(value: contract.AppDefaultModelRoute | undefined): contract.AppDefaultModelRouteValue | undefined {
  if (value === undefined) return undefined;
  if ([value.backendId, value.providerId, value.modelId].some(part => !part.trim() || part !== part.trim() || part.length > 512 || /[\u0000-\u001f\u007f]/u.test(part))
    || value.effort.length > 64 || /[\u0000-\u001f\u007f]/u.test(value.effort)) throw new ConnectError("Invalid UI model route.", Code.InvalidArgument);
  return { backendId: value.backendId, providerId: value.providerId, modelId: value.modelId, effort: value.effort, fastMode: contract.decodeModelSpeed(value) };
}
export function createAppDefaultModelConnectService(defaults: AppDefaultModelCoordinator | undefined, connections: ConnectionManager): ServiceImpl<typeof contract.AppDefaultModelService> {
  const owner = () => { if (!defaults) throw new ConnectError("The application default-model bridge is unavailable.", Code.Unavailable); return defaults; };
  return {
    watchAppDefaultModel: async function* (request, context) {
      const connection = connections.authenticate(context.requestHeader.get("authorization") ?? undefined);
      const messages: { ready: boolean; requestId: string }[] = [];
      let wake: (() => void) | undefined, closed = context.signal.aborted;
      const close = () => { closed = true; wake?.(); };
      const stopRevocation = connections.onRevoked(connection.id, close);
      context.signal.addEventListener("abort", close, { once: true });
      let stop = () => {};
      try {
        stop = owner().watch(connection.id, request.uiOwnerId, message => { messages.push(message); wake?.(); }, () => connections.fence(connection), () => context.signal.throwIfAborted());
        while (!closed) {
          if (!messages.length) await new Promise<void>(resolve => { wake = resolve; });
          wake = undefined;
          while (messages.length && !closed) { connections.fence(connection); yield create(contract.WatchAppDefaultModelResponseSchema, messages.shift()!); }
        }
      } finally { stop(); stopRevocation(); context.signal.removeEventListener("abort", close); }
    },
    syncAppDefaultModel: (request, context) => {
      const connection = connections.authenticate(context.requestHeader.get("authorization") ?? undefined);
      context.signal.throwIfAborted();
      return create(contract.SyncAppDefaultModelResponseSchema, { accepted: owner().sync(connection.id, request.uiOwnerId, route(request.current),
        request.hiddenRouteIds, request.tuning.map(value => route(value)!), request.confirmedRequestId, request.visibleRouteIds) });
    },
    claimAppDefaultModel: (request, context) => {
      const connection = connections.authenticate(context.requestHeader.get("authorization") ?? undefined);
      context.signal.throwIfAborted(); const result = owner().claim(connection.id, request.uiOwnerId, request.requestId);
      return create(contract.ClaimAppDefaultModelResponseSchema, { remainingMs: result.remainingMs,
        ...(result.expected === undefined ? {} : { expected: { ...result.expected, ...contract.encodeModelSpeed(result.expected.fastMode) } }),
        requested: { ...result.requested, ...contract.encodeModelSpeed(result.requested.fastMode) } });
    }
  };
}
