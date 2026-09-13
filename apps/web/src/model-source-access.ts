import type { BackendView, ModelView, ProviderRuntimeView } from "./model.js";
import { isRoutableConversationModel } from "./model-capabilities.js";

export type ModelSourceSelection = Pick<ModelView, "backendId" | "providerId" | "modelId">;

export interface ModelSourceAccess {
  readonly available: boolean;
  readonly reason?: "modelMissing" | "sourceDisconnected" | "nativeUnavailable" | "authentication";
  readonly authentication?: ProviderRuntimeView;
  readonly authenticationState?: ProviderRuntimeView["authenticationState"];
}

/** A native default uses the Backend's own authority; other providers cannot stand in for it. */
export function modelSourceAccess(
  backend: BackendView | undefined,
  selection: ModelSourceSelection | undefined,
  model: ModelView | undefined,
  providers: readonly ProviderRuntimeView[]
): ModelSourceAccess {
  if (selection !== undefined) {
    const authentication = modelSourceAuthentication(selection, providers);
    const reason = model === undefined ? "modelMissing"
      : !isRoutableConversationModel(model) ? "sourceDisconnected"
      : authentication !== undefined ? "authentication" : undefined;
    return { available: reason === undefined, ...(reason === undefined ? {} : { reason }),
      ...(authentication === undefined ? {} : { authentication, authenticationState: authentication.authenticationState }) };
  }
  if (backend === undefined || backend.health === "unavailable") return { available: false, reason: "nativeUnavailable" };
  const authenticationState = backend.authenticationState;
  return authenticationState === undefined || authenticationState === "authenticated" || authenticationState === "notRequired"
    ? { available: true }
    : { available: false, reason: "authentication", authenticationState };
}

/** Only the exact advertised route can describe a model's authorization. */
export function modelSourceAuthentication(
  model: Pick<ModelView, "backendId" | "providerId"> | undefined,
  providers: readonly ProviderRuntimeView[]
): ProviderRuntimeView | undefined {
  if (model === undefined) return undefined;
  const provider = providers.find((candidate) => candidate.backendId === model.backendId && candidate.id === model.providerId);
  return provider?.authenticationState === "authenticated" || provider?.authenticationState === "notRequired"
    ? undefined
    : provider;
}
