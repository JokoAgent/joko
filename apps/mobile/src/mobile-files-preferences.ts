import type { MobilePlainStorageDriver } from "./connection-storage";
import { DEFAULT_MOBILE_FILES_PREFERENCES, type MobileFilesPreferences } from "./mobile-files-presentation";

export interface MobileFilesPreferenceScope { readonly profileId: string; readonly serverId: string; readonly workspaceId: string }
type Override = { readonly scope: MobileFilesPreferenceScope; readonly preferences: MobileFilesPreferences };
const storageKey = "joko.mobile.filesPresentation.v1";

/** Explicit device-local display choices, independent of Session and permission revisions. */
export class MobileFilesPreferenceStore {
  #overrides = new Map<string, Override>();
  #changed = new Set<string>();
  #listeners = new Set<() => void>();
  #revision = 0;
  #hydrated = false;
  #loading?: Promise<void>;
  #writing: Promise<void> = Promise.resolve();
  constructor(private readonly storage: Pick<MobilePlainStorageDriver, "getItem" | "setItem">) {}
  get revision(): number { return this.#revision; }
  subscribe(listener: () => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  get(scope?: MobileFilesPreferenceScope): MobileFilesPreferences {
    return scope ? this.#overrides.get(scopeKey(scope))?.preferences ?? DEFAULT_MOBILE_FILES_PREFERENCES : DEFAULT_MOBILE_FILES_PREFERENCES;
  }
  hydrate(): Promise<void> {
    if (this.#hydrated) return Promise.resolve();
    if (this.#loading) return this.#loading;
    const loading = this.#read(); this.#loading = loading;
    void loading.finally(() => { if (this.#loading === loading) this.#loading = undefined; }).catch(() => undefined); return loading;
  }
  set(scope: MobileFilesPreferenceScope, preferences: MobileFilesPreferences): Promise<void> {
    const key = scopeKey(scope); if (!validPreferences(preferences)) return Promise.reject(new Error("Invalid Files display preference."));
    this.#overrides.delete(key); this.#overrides.set(key, { scope: { ...scope }, preferences: Object.freeze({ ...preferences }) });
    this.#changed.add(key); this.#trim(); this.#publish();
    const saving = this.#writing.catch(() => undefined).then(async () => {
      await this.hydrate();
      await this.storage.setItem(storageKey, JSON.stringify({ version: 1, overrides: [...this.#overrides.values()] }));
    });
    this.#writing = saving; return saving;
  }
  async #read(): Promise<void> {
    const raw = await this.storage.getItem(storageKey);
    const stored = parse(raw);
    const current = [...this.#overrides.values()];
    this.#overrides.clear();
    for (const value of stored) if (!this.#changed.has(scopeKey(value.scope))) this.#overrides.set(scopeKey(value.scope), value);
    for (const value of current) this.#overrides.set(scopeKey(value.scope), value);
    this.#trim(); this.#changed.clear(); this.#hydrated = true; this.#publish();
  }
  #trim(): void { while (this.#overrides.size > 32) { const key = this.#overrides.keys().next().value!; this.#overrides.delete(key); this.#changed.delete(key); } }
  #publish(): void { this.#revision++; this.#listeners.forEach((listener) => listener()); }
}
function scopeKey(scope: MobileFilesPreferenceScope): string {
  if (!exactKeys(scope, ["profileId", "serverId", "workspaceId"]) || ![scope.profileId, scope.serverId, scope.workspaceId]
    .every((value) => typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value))) throw new Error("Invalid Files preference owner.");
  return JSON.stringify([scope.profileId, scope.serverId, scope.workspaceId]);
}
function validPreferences(value: unknown): value is MobileFilesPreferences {
  return exactKeys(value, ["view", "sort"]) && (value.view === "grid" || value.view === "list") && ["name", "mtime", "size"].includes(String(value.sort));
}
function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function parse(raw: string | null): Override[] {
  if (!raw || raw.length > 65_536) return [];
  try {
    const value: unknown = JSON.parse(raw); if (!exactKeys(value, ["version", "overrides"]) || value.version !== 1 || !Array.isArray(value.overrides) || value.overrides.length > 32) return [];
    const seen = new Set<string>(); const overrides: Override[] = [];
    for (const item of value.overrides) {
      if (!exactKeys(item, ["scope", "preferences"]) || !validPreferences(item.preferences)) return [];
      const scope = item.scope as MobileFilesPreferenceScope; const key = scopeKey(scope); if (seen.has(key)) return []; seen.add(key);
      overrides.push({ scope: { ...scope }, preferences: Object.freeze({ ...item.preferences }) });
    }
    return overrides;
  } catch { return []; }
}
