import type { GetHostedAgentCatalogResponse, HostedAgentSettings, UpdateHostedAgentSettingsRequest } from "@joko/contracts";

export interface HostedAgentSettingsView {
  readonly revision: bigint;
  readonly remoteControlEnabled: boolean;
  readonly providers: readonly { readonly backendId: string; readonly providerId: string; readonly enabled: boolean }[];
  readonly limits: { readonly perDevice: number; readonly total: number };
  readonly limitsOverridden: boolean;
  readonly usage?: { readonly total: number; readonly devices: number; readonly maximumDevice: number };
}
export interface HostedAgentCatalogView {
  readonly backends: readonly { readonly backendId: string; readonly displayName: string;
    readonly providers: readonly { readonly providerId: string; readonly displayName: string; readonly connected: boolean; readonly modelCount: number }[] }[];
}
export type HostedAgentSettingsUpdate =
  | { readonly kind: "remoteControl"; readonly enabled: boolean }
  | { readonly kind: "provider"; readonly backendId: string; readonly providerId: string; readonly enabled: boolean }
  | { readonly kind: "limits"; readonly perDevice: number; readonly total: number }
  | { readonly kind: "resetLimits" };
export interface HostedAgentSettingsApi {
  getHostedAgentSettings(signal?: AbortSignal): Promise<HostedAgentSettingsView>;
  getHostedAgentCatalog(signal?: AbortSignal): Promise<HostedAgentCatalogView>;
  updateHostedAgentSettings(update: HostedAgentSettingsUpdate, expectedRevision: bigint, signal?: AbortSignal): Promise<HostedAgentSettingsView>;
}
export function projectHostedAgentSettings(value: HostedAgentSettings | undefined): HostedAgentSettingsView {
  if (!value || value.revision < 0n || !value.limits || !validLimit(value.limits.perDevice) || !validLimit(value.limits.total)) throw new Error("Invalid hosted Agent settings.");
  const providers = value.providers.map(provider => {
    identity(provider.backendId); identity(provider.providerId);
    return { backendId: provider.backendId, providerId: provider.providerId, enabled: provider.enabled };
  });
  if (new Set(providers.map(provider => JSON.stringify([provider.backendId, provider.providerId]))).size !== providers.length) throw new Error("Invalid hosted Agent Providers.");
  if (value.usage && ![value.usage.total, value.usage.devices, value.usage.maximumDevice].every(number => Number.isSafeInteger(number) && number >= 0)) throw new Error("Invalid hosted Agent usage.");
  return { revision: value.revision, remoteControlEnabled: value.remoteControlEnabled, providers, limits: { perDevice: value.limits.perDevice, total: value.limits.total },
    limitsOverridden: value.limitsOverridden, ...(value.usage ? { usage: { total: value.usage.total, devices: value.usage.devices, maximumDevice: value.usage.maximumDevice } } : {}) };
}
export function projectHostedAgentCatalog(value: GetHostedAgentCatalogResponse): HostedAgentCatalogView {
  if (value.format !== 1) throw new Error("Invalid hosted Agent catalog format.");
  const backendIds = new Set<string>();
  return { backends: value.backends.map(backend => {
    identity(backend.backendId); if (backendIds.has(backend.backendId)) throw new Error("Invalid hosted Agent catalog."); backendIds.add(backend.backendId);
    const providerIds = new Set<string>();
    return { backendId: backend.backendId, displayName: backend.displayName || backend.backendId, providers: backend.providers.map(provider => {
      identity(provider.providerId); if (providerIds.has(provider.providerId)) throw new Error("Invalid hosted Agent catalog."); providerIds.add(provider.providerId);
      const models = new Set<string>();
      for (const model of provider.models) {
        if (model.backendId !== backend.backendId || model.key?.providerId !== provider.providerId) throw new Error("Hosted Agent model ownership changed.");
        identity(model.key.modelId); if (models.has(model.key.modelId)) throw new Error("Invalid hosted Agent catalog."); models.add(model.key.modelId);
      }
      return { providerId: provider.providerId, displayName: provider.displayName || provider.providerId, connected: provider.connected, modelCount: models.size };
    }) };
  }) };
}
export function hostedAgentSettingsMutation(update: HostedAgentSettingsUpdate): UpdateHostedAgentSettingsRequest["update"] {
  switch (update.kind) {
    case "remoteControl": return { case: "remoteControl", value: { $typeName: "joko.v1.HostedAgentRemoteControlPermission", enabled: update.enabled } };
    case "provider": identity(update.backendId); identity(update.providerId); return { case: "provider", value: {
      $typeName: "joko.v1.HostedAgentProviderPermission", backendId: update.backendId, providerId: update.providerId, enabled: update.enabled } };
    case "limits": if (!validLimit(update.perDevice) || !validLimit(update.total)) throw new Error("Hosted Agent limits must be integers from 1 to 1000.");
      return { case: "limits", value: { $typeName: "joko.v1.HostedAgentLimits", perDevice: update.perDevice, total: update.total } };
    case "resetLimits": return { case: "resetLimits", value: { $typeName: "joko.v1.HostedAgentResetLimits" } };
  }
}
function validLimit(value: number): boolean { return Number.isSafeInteger(value) && value >= 1 && value <= 1_000; }
function identity(value: string): void { if (!value || value.length > 512 || /[\0\r\n]/u.test(value)) throw new Error("Invalid hosted Agent identity."); }
