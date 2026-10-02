import { isNewerSameHostVoiceDictionary, MAXIMUM_VOICE_DICTIONARY_READONLY_BYTES,
  readVoiceDictionaryReadOnlyView, type VoiceDictionaryReadOnlyView } from "@joko/contracts";
import type { MobileConnectionProfile } from "./connection-storage";
import type { MobileOfflineCacheStorage } from "./mobile-offline-cache";
import { mobileReadOnlyDictionaryScope, type CachedMobileReadOnlyDictionary } from "./mobile-voice-dictionary-readonly";

const prefix = "joko.mobile.voice-dictionary-readonly.v1.";
export interface MobileReadOnlyDictionaryCacheLease { readonly scope: string; readonly profileId: string; readonly epoch: number }

/** Non-secret, strictly read-only per-pair cache. Clear fences memory before any disk await. */
export class MobileVoiceDictionaryReadOnlyCache {
  readonly #memory = new Map<string, CachedMobileReadOnlyDictionary>();
  readonly #epochs = new Map<string, number>();
  readonly #hydrating = new Map<string, Promise<void>>();
  readonly #hydrated = new Set<string>();
  readonly #damaged = new Set<string>();
  readonly #knownProfiles = new Map<string, string>();
  readonly #blocked = new Set<string>();
  readonly #listeners = new Set<() => void>();
  #tail = Promise.resolve();
  #lastFetchedAt = 0;

  constructor(private readonly storage: Pick<MobileOfflineCacheStorage, "getItem" | "setItem" | "removeItem" | "getAllKeys">,
    private readonly now: () => number = Date.now) {}

  subscribe(listener: () => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  read(profile: MobileConnectionProfile): CachedMobileReadOnlyDictionary | undefined { return this.#memory.get(mobileReadOnlyDictionaryScope(profile)); }
  lease(profile: MobileConnectionProfile): MobileReadOnlyDictionaryCacheLease {
    const scope = mobileReadOnlyDictionaryScope(profile);
    this.#knownProfiles.set(scope, profile.profileId);
    return { scope, profileId: profile.profileId, epoch: this.#epochs.get(profile.profileId) ?? 0 };
  }
  isCurrent(lease: MobileReadOnlyDictionaryCacheLease): boolean { return (this.#epochs.get(lease.profileId) ?? 0) === lease.epoch; }

  hydrate(profile: MobileConnectionProfile): Promise<void> {
    const lease = this.lease(profile);
    if (this.#hydrated.has(lease.scope)) return this.#damaged.has(lease.scope) ? Promise.reject(damaged()) : Promise.resolve();
    const inFlight = this.#hydrating.get(lease.scope);
    if (inFlight) return inFlight;
    const action = this.#serialized(async () => {
      if (!this.isCurrent(lease) || this.#blocked.has(profile.profileId)) return;
      if (await this.storage.getItem(guardKey(profile.profileId)) !== null || !this.isCurrent(lease)) {
        if (this.isCurrent(lease)) this.#hydrated.add(lease.scope);
        return;
      }
      const raw = await this.storage.getItem(cacheKey(profile));
      if (!this.isCurrent(lease) || this.#blocked.has(profile.profileId)) return;
      this.#hydrated.add(lease.scope);
      if (raw === null) return;
      const current = this.#memory.get(lease.scope);
      // A validated push may have arrived while disk was being read.
      let saved: CachedMobileReadOnlyDictionary;
      try { saved = decode(raw, profile); }
      catch (error) { this.#damaged.add(lease.scope); if (current) return; throw error; }
      if (current && !isNewerSameHostVoiceDictionary(saved.snapshot, current.snapshot)) return;
      this.#lastFetchedAt = Math.max(this.#lastFetchedAt, saved.fetchedAt);
      this.#memory.set(lease.scope, saved);
      this.#emit();
    });
    this.#hydrating.set(lease.scope, action);
    void action.finally(() => { if (this.#hydrating.get(lease.scope) === action) this.#hydrating.delete(lease.scope); }).catch(() => undefined);
    return action;
  }

  async apply(profile: MobileConnectionProfile, value: VoiceDictionaryReadOnlyView, lease: MobileReadOnlyDictionaryCacheLease): Promise<boolean> {
    if (lease.scope !== mobileReadOnlyDictionaryScope(profile) || !this.isCurrent(lease)) return false;
    const snapshot = readVoiceDictionaryReadOnlyView(value);
    // Hydration owns the first freshness baseline; a push and GET share it.
    await this.hydrate(profile).catch(() => undefined);
    if (!this.isCurrent(lease)) return false;
    const current = this.#memory.get(lease.scope);
    if (current && !isNewerSameHostVoiceDictionary(snapshot, current.snapshot)) {
      if (snapshot.revision !== current.snapshot.revision || encodeSnapshot(snapshot) !== encodeSnapshot(current.snapshot)) return false;
    }
    const wall = this.now();
    if (!Number.isSafeInteger(wall) || wall < 0 || this.#lastFetchedAt >= Number.MAX_SAFE_INTEGER) throw damaged();
    const fetchedAt = Math.max(wall, this.#lastFetchedAt + 1);
    this.#lastFetchedAt = fetchedAt;
    const saved: CachedMobileReadOnlyDictionary = Object.freeze({ profile: publicProfile(profile), snapshot, fetchedAt });
    this.#memory.set(lease.scope, saved);
    this.#blocked.delete(profile.profileId);
    this.#emit();
    // Keep a valid live projection, but never silently overwrite incompatible disk data.
    if (this.#damaged.has(lease.scope)) throw damaged();
    await this.#serialized(async () => {
      if (!this.isCurrent(lease)) return;
      // Capture this immutable frame, not a mutable global projection.
      const encoded = JSON.stringify({ version: 1, profile: saved.profile, fetchedAt, snapshot: JSON.parse(encodeSnapshot(snapshot)) as unknown });
      await this.storage.setItem(cacheKey(profile), encoded);
      if (!this.isCurrent(lease)) return;
      if (await this.storage.getItem(cacheKey(profile)) !== encoded) throw damaged();
      await this.storage.removeItem(guardKey(profile.profileId));
    });
    return this.isCurrent(lease);
  }

  clear(profileId: string): Promise<void> {
    this.#epochs.set(profileId, (this.#epochs.get(profileId) ?? 0) + 1);
    this.#blocked.add(profileId);
    for (const [scope, saved] of this.#memory) if (saved.profile.profileId === profileId) this.#memory.delete(scope);
    for (const [scope, owner] of this.#knownProfiles) if (owner === profileId) { this.#hydrated.delete(scope); this.#damaged.delete(scope); }
    this.#hydrating.clear();
    this.#emit();
    return this.#serialized(async () => {
      let failed = false;
      try { await this.storage.setItem(guardKey(profileId), "1"); } catch { failed = true; }
      try {
        const keys = (await this.storage.getAllKeys()).filter((key) => key.startsWith(profilePrefix(profileId)) && key !== guardKey(profileId));
        for (const key of keys) await this.storage.removeItem(key);
      } catch { failed = true; }
      if (failed) throw new Error("The read-only dictionary cache could not be cleared.");
    });
  }

  #emit(): void { for (const listener of this.#listeners) listener(); }
  #serialized<T>(effect: () => Promise<T>): Promise<T> {
    const action = this.#tail.then(effect, effect);
    this.#tail = action.then(() => undefined, () => undefined);
    return action;
  }
}

function publicProfile(profile: MobileConnectionProfile): MobileConnectionProfile {
  return Object.freeze({ profileId: profile.profileId, origin: profile.origin, serverId: profile.serverId,
    connectionId: profile.connectionId, deviceId: profile.deviceId, displayName: profile.displayName });
}
function profilePrefix(profileId: string): string { return `${prefix}${encodeURIComponent(profileId)}.`; }
function guardKey(profileId: string): string { return `${profilePrefix(profileId)}retired`; }
function cacheKey(profile: MobileConnectionProfile): string { return `${profilePrefix(profile.profileId)}${encodeURIComponent(mobileReadOnlyDictionaryScope(profile))}`; }
function encodeSnapshot(value: VoiceDictionaryReadOnlyView): string {
  return JSON.stringify({ ...value, revision: value.revision.toString(10),
    stateVector: Object.fromEntries(Object.entries(value.stateVector).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) });
}
function decode(raw: string, profile: MobileConnectionProfile): CachedMobileReadOnlyDictionary {
  if (new TextEncoder().encode(raw).byteLength > MAXIMUM_VOICE_DICTIONARY_READONLY_BYTES + 8_192) throw damaged();
  const value: unknown = JSON.parse(raw);
  if (!plain(value) || Object.keys(value).sort().join(",") !== "fetchedAt,profile,snapshot,version" || value.version !== 1
    || !plain(value.profile) || Object.keys(value.profile).sort().join(",") !== "connectionId,deviceId,displayName,origin,profileId,serverId"
    || mobileReadOnlyDictionaryScope(value.profile as unknown as MobileConnectionProfile) !== mobileReadOnlyDictionaryScope(profile)
    || typeof value.profile.displayName !== "string" || typeof value.fetchedAt !== "number" || !Number.isSafeInteger(value.fetchedAt)
    || value.fetchedAt <= 0 || !plain(value.snapshot) || typeof value.snapshot.revision !== "string"
    || !/^[1-9][0-9]{0,15}$/u.test(value.snapshot.revision)) throw damaged();
  const snapshot = readVoiceDictionaryReadOnlyView({ ...value.snapshot, revision: BigInt(value.snapshot.revision) });
  return Object.freeze({ profile: publicProfile(profile), fetchedAt: value.fetchedAt, snapshot });
}
function plain(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function damaged(): Error { return new Error("The saved read-only dictionary cache is unavailable or invalid."); }
