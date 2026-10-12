import { useSyncExternalStore } from "react";
import { appDefaultModelRouteId, sameAppDefaultModelRoute, type AppDefaultModelRouteValue } from "@joko/contracts";

interface Preference {
  readonly version: 1;
  readonly current?: AppDefaultModelRouteValue;
  readonly tuning: readonly AppDefaultModelRouteValue[];
}
const listeners = new Set<() => void>();
let revision = 0;
const key = (ownerId: string) => `joko:app-default-model:v1:${encodeURIComponent(ownerId)}`;
export function validAppDefaultRoute(value: unknown): value is AppDefaultModelRouteValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const route = value as Record<string, unknown>;
  return Object.keys(route).sort().join(",") === "backendId,effort,fastMode,modelId,providerId"
    && [route["backendId"], route["providerId"], route["modelId"]].every(part => typeof part === "string" && part.length > 0 && part.length <= 512 && part === part.trim() && !/[\u0000-\u001f\u007f]/u.test(part))
    && typeof route["effort"] === "string" && route["effort"].length <= 64 && !/[\u0000-\u001f\u007f]/u.test(route["effort"])
    && typeof route["fastMode"] === "boolean";
}
export function readAppDefaultModelPreference(ownerId: string | undefined): Preference {
  const empty: Preference = { version: 1, tuning: [] };
  if (!ownerId || typeof window === "undefined") return empty;
  try {
    const stored = window.localStorage.getItem(key(ownerId)); if (!stored) return empty;
    const value: unknown = JSON.parse(stored);
    if (!value || typeof value !== "object" || Array.isArray(value)) return empty;
    const record = value as Record<string, unknown>;
    if (record["version"] !== 1 || Object.keys(record).some(field => !["version", "current", "tuning"].includes(field))
      || record["current"] !== undefined && !validAppDefaultRoute(record["current"])
      || !Array.isArray(record["tuning"]) || record["tuning"].length > 4_096 || !record["tuning"].every(validAppDefaultRoute)
      || new Set(record["tuning"].map(appDefaultModelRouteId)).size !== record["tuning"].length) return empty;
    return { version: 1, ...(record["current"] === undefined ? {} : { current: record["current"] }), tuning: record["tuning"] };
  } catch { return empty; }
}
// Both the actual picker and remote requests use this synchronous write. Failed
// persistence cannot produce a success receipt or a second in-memory preference.
export function setAppDefaultModelPreference(ownerId: string | undefined, current: AppDefaultModelRouteValue,
  expected?: { readonly route?: AppDefaultModelRouteValue; readonly assertCurrent: () => void }): boolean {
  if (!ownerId || typeof window === "undefined" || !validAppDefaultRoute(current)) return false;
  expected?.assertCurrent();
  const before = readAppDefaultModelPreference(ownerId);
  if (expected && !sameAppDefaultModelRoute(before.current, expected.route) && !sameAppDefaultModelRoute(before.current, current)) return false;
  const tuning = [...before.tuning.filter(route => appDefaultModelRouteId(route) !== appDefaultModelRouteId(current)), current].slice(-4_096);
  try {
    expected?.assertCurrent();
    window.localStorage.setItem(key(ownerId), JSON.stringify({ version: 1, current, tuning } satisfies Preference));
  } catch { return false; }
  notify(); return true;
}
export function subscribeAppDefaultModelPreference(listener: () => void): () => void {
  listeners.add(listener); return () => listeners.delete(listener);
}
export function useAppDefaultModelPreference(ownerId: string | undefined): Preference {
  useSyncExternalStore(subscribeAppDefaultModelPreference, () => revision, () => 0);
  return readAppDefaultModelPreference(ownerId);
}
function notify() { revision += 1; for (const listener of listeners) listener(); }
if (typeof window !== "undefined") window.addEventListener("storage", event => {
  if (event.key === null || event.key.startsWith("joko:app-default-model:v1:")) notify();
});
