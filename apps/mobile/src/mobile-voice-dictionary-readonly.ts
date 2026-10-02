import { voiceDictionaryVectorDominates, type VoiceDictionaryReadOnlyApi, type VoiceDictionaryReadOnlyView } from "@joko/contracts";
import type { MobileConnectionProfile } from "./connection-storage";

export interface MobileReadOnlyDictionaryTransport extends VoiceDictionaryReadOnlyApi {
  readonly profile: MobileConnectionProfile;
  readonly ownerKey: string;
  isCurrent(): boolean;
}

export interface CachedMobileReadOnlyDictionary {
  readonly profile: MobileConnectionProfile;
  readonly snapshot: VoiceDictionaryReadOnlyView;
  readonly fetchedAt: number;
}

export function mobileReadOnlyDictionaryScope(profile: MobileConnectionProfile): string {
  return JSON.stringify([profile.profileId, profile.origin, profile.serverId, profile.connectionId, profile.deviceId]);
}

export function mobileReadOnlyDictionarySources(saved: readonly (MobileConnectionProfile & { readonly credentialState: string })[]): MobileConnectionProfile[] {
  return saved.filter((profile) => !["missing", "unreadable", "identity-conflict"].includes(profile.credentialState))
    .map((profile) => ({ profileId: profile.profileId, origin: profile.origin, serverId: profile.serverId,
      connectionId: profile.connectionId, deviceId: profile.deviceId, displayName: profile.displayName }));
}

/** Select one complete projection. A stale offline host must not resurrect deleted terms. */
export function selectMobileReadOnlyDictionary(values: readonly CachedMobileReadOnlyDictionary[]): CachedMobileReadOnlyDictionary | undefined {
  const maximal = values.filter((candidate) => !values.some((other) =>
    voiceDictionaryVectorDominates(other.snapshot.stateVector, candidate.snapshot.stateVector)
    && !voiceDictionaryVectorDominates(candidate.snapshot.stateVector, other.snapshot.stateVector)));
  return [...maximal].sort((a, b) => mobileReadOnlyDictionaryScope(a.profile).localeCompare(mobileReadOnlyDictionaryScope(b.profile), "en-US"))
    .reduce<CachedMobileReadOnlyDictionary | undefined>((best, candidate) => {
      if (!best) return candidate;
      return candidate.fetchedAt > best.fetchedAt ? candidate : best;
    }, undefined);
}

export function mobileReadOnlyDictionaryEntryViews(value: CachedMobileReadOnlyDictionary | undefined) {
  return [...(value?.snapshot.entries ?? [])].sort((a, b) => b.frequency - a.frequency || a.text.localeCompare(b.text))
    .map((entry) => ({ text: entry.text, key: entry.text.toLowerCase(), frequency: entry.frequency,
      aliases: [...entry.aliases].sort((a, b) => b.count - a.count || a.text.localeCompare(b.text)).slice(0, 3).map((alias) => alias.text) }));
}
