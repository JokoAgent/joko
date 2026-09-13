import type { OperationalStore } from "@joko/store";

export const SESSION_RUNTIME_FALLBACK_SETTING_KEY = "settings.personalization.session_runtime_fallback";
export const SESSION_RUNTIME_FALLBACK_DEFAULT_ENABLED = false;

export function configuredSessionRuntimeFallback(store: OperationalStore): boolean {
  const value = store.findSetting<{ readonly enabled?: boolean }>(
    "service",
    "orchestrator",
    SESSION_RUNTIME_FALLBACK_SETTING_KEY
  )?.value;
  return typeof value?.enabled === "boolean" ? value.enabled : SESSION_RUNTIME_FALLBACK_DEFAULT_ENABLED;
}

export function sessionRuntimeFallbackCustomized(store: OperationalStore): boolean {
  return typeof store.findSetting<{ readonly enabled?: boolean }>(
    "service",
    "orchestrator",
    SESSION_RUNTIME_FALLBACK_SETTING_KEY
  )?.value.enabled === "boolean";
}
