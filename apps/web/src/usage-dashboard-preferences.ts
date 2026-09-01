export interface UsageDashboardPreference {
  readonly enabled: boolean;
  readonly collapsed: boolean;
}

const STORAGE_PREFIX = "joko:usage-dashboard:v1:";
const memory = new Map<string, UsageDashboardPreference>();

export function readUsageDashboardPreference(ownerId: string | undefined): UsageDashboardPreference {
  const key = preferenceKey(ownerId);
  if (key === undefined) return { enabled: true, collapsed: false };
  const fallback = memory.get(key) ?? { enabled: true, collapsed: false };
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed === null
      || typeof parsed !== "object"
      || Array.isArray(parsed)
      || Object.keys(parsed).sort().join(",") !== "collapsed,enabled"
    ) return fallback;
    const record = parsed as Record<string, unknown>;
    if (typeof record["enabled"] !== "boolean" || typeof record["collapsed"] !== "boolean") return fallback;
    const value = {
      enabled: record["enabled"],
      collapsed: record["collapsed"]
    };
    memory.set(key, value);
    return value;
  } catch {
    return fallback;
  }
}

export function setUsageDashboardEnabled(ownerId: string | undefined, enabled: boolean): void {
  writePreference(ownerId, { ...readUsageDashboardPreference(ownerId), enabled });
}

export function setUsageDashboardCollapsed(ownerId: string | undefined, collapsed: boolean): void {
  writePreference(ownerId, { ...readUsageDashboardPreference(ownerId), collapsed });
}

export function resetUsageDashboardPreferencesForTests(): void {
  memory.clear();
  if (typeof window === "undefined") return;
  try {
    const keys: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(STORAGE_PREFIX) === true) keys.push(key);
    }
    for (const key of keys) window.localStorage.removeItem(key);
  } catch {
    // A blocked local store is represented by the in-memory fallback.
  }
}

function writePreference(ownerId: string | undefined, value: UsageDashboardPreference): void {
  const key = preferenceKey(ownerId);
  if (key === undefined) return;
  memory.set(key, value);
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // A blocked local store still permits the current interaction to finish.
  }
}

function preferenceKey(ownerId: string | undefined): string | undefined {
  const value = ownerId?.trim();
  return value === undefined || value === "" || value.length > 256
    ? undefined
    : `${STORAGE_PREFIX}${encodeURIComponent(value)}`;
}
