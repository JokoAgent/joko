import { create } from "@bufbuild/protobuf";
import {
  BackendModelAccessSettingsSchema,
  ModelKeySchema,
  type BackendModelAccessSettings,
  type BackendModelAccessUpdate
} from "@joko/contracts";
import type { OperationalStore } from "@joko/store";

const MAXIMUM_DISABLED_PROVIDERS = 256;
const MAXIMUM_DISABLED_MODELS = 4_096;

export function backendModelAccessSettingKey(backendId: string): string {
  return `settings.model_access.${backendId}`;
}

export function readBackendModelAccess(
  store: Pick<OperationalStore, "findSetting">,
  backendId: string
): BackendModelAccessSettings {
  const stored = store.findSetting<BackendModelAccessSettings>(
    "service",
    "orchestrator",
    backendModelAccessSettingKey(backendId)
  )?.value;
  if (stored === undefined) return create(BackendModelAccessSettingsSchema);
  return create(BackendModelAccessSettingsSchema, {
    disabledProviderIds: normalizedIds(stored.disabledProviderIds, MAXIMUM_DISABLED_PROVIDERS),
    disabledModels: normalizedModels(stored.disabledModels, MAXIMUM_DISABLED_MODELS)
  });
}

export function providerRoutingEnabled(
  store: Pick<OperationalStore, "findSetting">,
  backendId: string,
  providerId: string
): boolean {
  return !readBackendModelAccess(store, backendId).disabledProviderIds.includes(providerId);
}

export function backendModelAccessRestricted(
  store: Pick<OperationalStore, "findSetting">,
  backendId: string
): boolean {
  const access = readBackendModelAccess(store, backendId);
  return access.disabledProviderIds.length > 0 || access.disabledModels.length > 0;
}

export function modelRoutingEnabled(
  store: Pick<OperationalStore, "findSetting">,
  backendId: string,
  providerId: string,
  modelId: string
): boolean {
  const access = readBackendModelAccess(store, backendId);
  return !access.disabledProviderIds.includes(providerId)
    && !access.disabledModels.some((model) => model.providerId === providerId && model.modelId === modelId);
}

export function writeBackendModelAccess(
  store: Pick<OperationalStore, "findSetting" | "setSetting" | "deleteSetting">,
  backendId: string,
  update: BackendModelAccessUpdate
): BackendModelAccessSettings {
  const providerId = requiredId(update.providerId, "Provider ID");
  const modelId = update.modelId === undefined ? undefined : requiredId(update.modelId, "Model ID");
  const current = readBackendModelAccess(store, backendId);
  const disabledProviderIds = new Set(current.disabledProviderIds);
  const disabledModels = new Map(current.disabledModels.map((model) => [modelRouteKey(model.providerId, model.modelId), model] as const));
  if (modelId === undefined) {
    if (update.enabled) disabledProviderIds.delete(providerId);
    else disabledProviderIds.add(providerId);
  } else {
    const key = modelRouteKey(providerId, modelId);
    if (update.enabled) disabledModels.delete(key);
    else disabledModels.set(key, create(ModelKeySchema, { providerId, modelId }));
  }
  if (disabledProviderIds.size > MAXIMUM_DISABLED_PROVIDERS || disabledModels.size > MAXIMUM_DISABLED_MODELS) {
    throw new Error("The model access settings exceed their supported size.");
  }
  const next = create(BackendModelAccessSettingsSchema, {
    disabledProviderIds: [...disabledProviderIds].sort(),
    disabledModels: [...disabledModels.values()].sort((left, right) =>
      left.providerId.localeCompare(right.providerId) || left.modelId.localeCompare(right.modelId))
  });
  const key = backendModelAccessSettingKey(backendId);
  if (next.disabledProviderIds.length === 0 && next.disabledModels.length === 0) {
    store.deleteSetting("service", "orchestrator", key);
  } else {
    store.setSetting("service", "orchestrator", key, next);
  }
  return next;
}

function normalizedIds(values: readonly string[] | undefined, maximum: number): string[] {
  if (values === undefined || values.length === 0) return [];
  if (values.length > maximum) throw new Error("The model access settings exceed their supported size.");
  const normalized = values.map((value) => requiredId(value, "Provider ID"));
  if (new Set(normalized).size !== normalized.length) throw new Error("The model access settings contain duplicate Providers.");
  return normalized.sort();
}

function normalizedModels(
  values: BackendModelAccessSettings["disabledModels"] | undefined,
  maximum: number
): BackendModelAccessSettings["disabledModels"] {
  if (values === undefined || values.length === 0) return [];
  if (values.length > maximum) throw new Error("The model access settings exceed their supported size.");
  const keys = new Set<string>();
  return values.map((value) => {
    const providerId = requiredId(value.providerId, "Provider ID");
    const modelId = requiredId(value.modelId, "Model ID");
    const key = modelRouteKey(providerId, modelId);
    if (keys.has(key)) throw new Error("The model access settings contain duplicate models.");
    keys.add(key);
    return create(ModelKeySchema, { providerId, modelId });
  }).sort((left, right) => left.providerId.localeCompare(right.providerId) || left.modelId.localeCompare(right.modelId));
}

function requiredId(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 256 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error(`${label} is invalid.`);
  }
  return normalized;
}

function modelRouteKey(providerId: string, modelId: string): string {
  return `${providerId}\u0000${modelId}`;
}
