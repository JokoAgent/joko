import type { AppSnapshot, ConnectionProfile, ModelView, NewSessionModelRequest } from "./model.js";
import { dialogueBackends, resolveNewSessionExecutionOptions } from "./components/new-session-options.js";
import { modelSourceAccess } from "./model-source-access.js";

/** Only routes already admitted by the formal New Task picker can seed its model. */
export function newSessionProviderModel(snapshot: AppSnapshot, backendId: string, providerId: string, modelId?: string): ModelView | undefined {
  const backend = dialogueBackends(snapshot.backends, snapshot.settings.backendSettings).find(row => row.id === backendId);
  const provider = snapshot.providers.find(row => row.backendId === backendId && row.id === providerId);
  if (!backend || !provider || provider.routingEnabled === false || !["authenticated", "notRequired"].includes(provider.authenticationState)) return undefined;
  const options = resolveNewSessionExecutionOptions(backend, snapshot.models, "");
  if (!options.modelSwitchSupported) return undefined;
  return options.availableModels.find(model => model.providerId === providerId && (modelId === undefined || model.modelId === modelId)
    && modelSourceAccess(backend, model, model, snapshot.providers).available);
}

export function resolveNewSessionModelRequest(request: NewSessionModelRequest, owner: {
  readonly activeProfile?: ConnectionProfile;
  readonly connectionGeneration?: number;
  readonly connectionState: string;
  readonly snapshot: AppSnapshot;
}): ModelView | undefined {
  const profile = owner.activeProfile;
  if (!profile || owner.connectionState !== "connected" || owner.connectionGeneration !== request.connectionGeneration
    || owner.snapshot.generation.toString() !== request.snapshotGeneration || profile.id !== request.profile.id
    || profile.serverId !== request.profile.serverId || profile.deviceId !== request.profile.deviceId || profile.origin !== request.profile.origin) return undefined;
  return newSessionProviderModel(owner.snapshot, request.backendId, request.providerId, request.modelId);
}
