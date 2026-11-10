import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, type Transport } from "@connectrpc/connect";
import { BackendService, OperationService, OperationMutationSchema, OperationState, parseProviderAccountResetSettings, providerAccountResetOperationId,
  type ProviderAccountResetApi, type ProviderAccountResetState, type Operation, type OperationMutation } from "@joko/contracts";

export function createProviderAccountResetApi(options: { readonly ownerKey: string; readonly connectionId: string;
  readonly transport: Transport; readonly newId: () => string; readonly assertCurrent: (backendId: string, providerId: string) => void }): ProviderAccountResetApi {
  const current = (backendId: string, providerId: string, signal: AbortSignal) => { signal.throwIfAborted(); options.assertCurrent(backendId, providerId); };
  const submit = async (state: ProviderAccountResetState, mutation: OperationMutation, operationId: string, signal: AbortSignal) => {
    current(state.backendId, state.providerId, signal);
    const client = createClient(OperationService, options.transport); let operation: Operation | undefined;
    try { operation = (await client.submitOperation({ operationId, connectionId: options.connectionId, mutation }, { signal })).operation; }
    catch (error) {
      current(state.backendId, state.providerId, signal);
      if (![Code.Unknown, Code.Unavailable, Code.DeadlineExceeded, Code.Internal].includes(ConnectError.from(error).code)) throw error;
      // Resolve the accepted operation by its original identity. Only a later
      // explicit retry can resubmit this purpose-specific idempotent attempt.
      try { operation = (await client.getOperation({ operationId }, { signal })).operation; } catch { throw error; }
    }
    current(state.backendId, state.providerId, signal);
    if (!operation || operation.operationId !== operationId || operation.connectionId !== options.connectionId || operation.state !== OperationState.SUCCEEDED) {
      throw new Error("The original account reset operation could not be confirmed.");
    }
    return operation;
  };
  return { ownerKey: options.ownerKey,
    read: async (backendId, providerId, signal) => {
      current(backendId, providerId, signal);
      const response = await createClient(BackendService, options.transport).getProviderAccountResetState({ backendId, providerId }, { signal });
      current(backendId, providerId, signal);
      if (!response.state || response.state.backendId !== backendId || response.state.providerId !== providerId) throw new Error("The original account reset Provider changed.");
      return response.state;
    },
    consume: async (state, offer, signal) => {
      const operation = await submit(state, create(OperationMutationSchema, { payload: { case: "consumeProviderAccountReset", value: {
        backendId: state.backendId, providerId: state.providerId, accountKey: state.accountKey, offerId: offer.offerId
      } } }), providerAccountResetOperationId(offer.offerId, options.connectionId), signal);
      const result = operation.result?.payload;
      if (result?.case !== "providerAccountReset" || result.value.backendId !== state.backendId || result.value.providerId !== state.providerId
        || result.value.accountKey !== state.accountKey || result.value.offerId !== offer.offerId) throw new Error("The original account reset receipt changed.");
      return result.value;
    },
    save: async (state, settings, signal) => {
      await submit(state, create(OperationMutationSchema, { payload: { case: "updateProviderAccountResetSettings", value: {
        backendId: state.backendId, providerId: state.providerId, accountKey: state.accountKey, expectedSettingsRevision: state.settingsRevision,
        update: settings === null ? { case: "restoreDefaults", value: true } : { case: "settings", value: parseProviderAccountResetSettings(settings) }
      } } }), options.newId(), signal);
    }
  };
}
