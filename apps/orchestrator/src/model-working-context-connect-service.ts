import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import type { ConnectionRecord } from "@joko/store";
import { ModelWorkingContextError, type ModelWorkingContextCoordinator, type ModelWorkingContextQuery, type ModelWorkingContextView } from "./model-working-context.js";

type ContextMethods = Pick<ServiceImpl<typeof contract.BackendService>, "getModelWorkingContext" | "setModelWorkingContext" | "resetModelWorkingContext">;
export function createModelWorkingContextConnectMethods(
  coordinator: ModelWorkingContextCoordinator | undefined,
  authenticate: (context: HandlerContext) => ConnectionRecord,
  fence: (connection: ConnectionRecord) => void,
  onRevoked: (connectionId: string, listener: () => void) => () => void
): ContextMethods {
  const invoke = async (context: HandlerContext, action: (owner: ModelWorkingContextCoordinator, signal: AbortSignal) => Promise<ModelWorkingContextView>) => {
    const authenticated = authenticate(context);
    const revoked = new AbortController();
    const stop = onRevoked(authenticated.id, () => revoked.abort());
    const signal = AbortSignal.any([context.signal, revoked.signal]);
    const check = (): void => { if (signal.aborted) throw new ConnectError("The model settings request was cancelled.", Code.Canceled); authenticate(context); fence(authenticated); };
    try {
      check(); if (!coordinator) throw new ConnectError("Model working context settings are unavailable.", Code.Unimplemented);
      const value = await action(coordinator, signal); check(); return { context: mapView(value) };
    } catch (error) {
      if (signal.aborted) throw new ConnectError("The model settings request was cancelled.", Code.Canceled);
      if (error instanceof ModelWorkingContextError) throw new ConnectError(error.message,
        error.reason === "invalid" ? Code.InvalidArgument : error.reason === "conflict" ? Code.Aborted
          : error.reason === "owner_changed" ? Code.FailedPrecondition : error.reason === "unsupported" ? Code.Unimplemented
            : error.reason === "cancelled" ? Code.Canceled : Code.FailedPrecondition);
      if (error instanceof ConnectError) throw error;
      throw new ConnectError("The model working context request could not be completed.", Code.FailedPrecondition);
    } finally { stop(); }
  };
  return {
    getModelWorkingContext: (request, context) => invoke(context, (owner, signal) => owner.read(query(request), signal)),
    setModelWorkingContext: (request, context) => invoke(context, (owner, signal) => {
      if (request.expectedRevision === undefined) throw invalid();
      const limit = request.contextWindowTokens === undefined ? undefined : Number(request.contextWindowTokens);
      if (limit !== undefined && (!Number.isSafeInteger(limit) || BigInt(limit) !== request.contextWindowTokens)) throw invalid();
      return owner.set({ ...query(request), operationId: request.operationId, expectedRevision: request.expectedRevision.value,
        expectedSourceRevision: request.expectedSourceRevision, ...(limit === undefined ? {} : { limit }) }, signal);
    }),
    resetModelWorkingContext: (request, context) => invoke(context, (owner, signal) => {
      if (request.expectedRevision === undefined) throw invalid();
      return owner.set({ ...query(request), operationId: request.operationId, expectedRevision: request.expectedRevision.value,
        expectedSourceRevision: request.expectedSourceRevision }, signal);
    })
  };
}
function query(request: { readonly target?: contract.ModelWorkingContextTarget; readonly relatedTargets: readonly contract.ModelWorkingContextTarget[]; readonly sessionId?: string }): ModelWorkingContextQuery {
  if (request.target === undefined) throw invalid();
  return { target: request.target, relatedTargets: request.relatedTargets, ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }) };
}
function mapView(value: ModelWorkingContextView): contract.ModelWorkingContextView {
  return create(contract.ModelWorkingContextViewSchema, {
    target: value.target, limitTokens: value.limitTokens === undefined ? undefined : BigInt(value.limitTokens),
    defaultContextWindowTokens: value.defaultContextWindowTokens === undefined ? undefined : BigInt(value.defaultContextWindowTokens),
    effectiveContextWindowTokens: value.effectiveContextWindowTokens === undefined ? undefined : BigInt(value.effectiveContextWindowTokens),
    customized: value.customized, mixed: value.mixed, revision: { value: value.revision }, sourceRevision: value.sourceRevision,
    canConfigure: value.canConfigure, blockedReason: value.blockedReason,
    nativeContext: value.nativeContext === undefined ? undefined : {
      contextWindowTokens: value.nativeContext.contextWindowTokens === undefined ? undefined : BigInt(value.nativeContext.contextWindowTokens),
      autoCompactLimitTokens: value.nativeContext.autoCompactLimitTokens === undefined ? undefined : BigInt(value.nativeContext.autoCompactLimitTokens),
      source: value.nativeContext.source, pendingApply: value.nativeContext.pendingApply
    }
  });
}
function invalid(): ConnectError { return new ConnectError("The model working context request is invalid.", Code.InvalidArgument); }
