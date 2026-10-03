/** Hidden removal markers fence stale alias counters without deleting independent evidence. */
import { compareHlc, hlcWallMs, type HlcTimestamp } from "./hlc.js";
import {
  createAliasRemovalMarkerKey,
  isAliasRemovalMarkerKey,
  parseAliasRemovalMarkerKey,
} from "./alias-removal-key.js";
import {
  createDictionaryMap,
  hasDictionaryKey,
  type GCounter,
  type SyncAliasState,
} from "./types.js";

export interface AliasRemovalMarker {
  aliasKey: string;
  counterNodeId: string;
  removedCount: number;
}

export interface AliasRemovalState {
  floor: GCounter;
  latestStamp: HlcTimestamp;
}

export type AliasRemovalIndex = Map<string, AliasRemovalState>;

export { isAliasRemovalMarkerKey } from "./alias-removal-key.js";

export function createAliasRemovalMarker(
  stamp: HlcTimestamp,
  marker: AliasRemovalMarker,
): { key: string; state: SyncAliasState } {
  return {
    key: createAliasRemovalMarkerKey(marker),
    state: {
      text: "",
      textStamp: stamp,
      counters: createDictionaryMap<number>(),
      lastSeenAt: marker.removedCount,
    },
  };
}

export function parseAliasRemovalMarker(
  aliasKey: string,
  alias: SyncAliasState,
): AliasRemovalMarker | null {
  if (!isAliasRemovalMarkerKey(aliasKey)) return null;
  try {
    const parsed = parseAliasRemovalMarkerKey(aliasKey);
    if (!parsed) return null;
    if (!Number.isSafeInteger(alias.lastSeenAt) || alias.lastSeenAt <= 0)
      return null;
    if (Object.keys(alias.counters).length > 0) return null;
    return {
      aliasKey: parsed.aliasKey,
      counterNodeId: parsed.counterNodeId,
      removedCount: alias.lastSeenAt,
    };
  } catch {
    return null;
  }
}

export function indexAliasRemovalMarkers(
  aliases: Readonly<Record<string, SyncAliasState>>,
): AliasRemovalIndex {
  const index: AliasRemovalIndex = new Map();
  for (const [aliasKey, alias] of Object.entries(aliases)) {
    const marker = parseAliasRemovalMarker(aliasKey, alias);
    if (!marker) continue;
    let removal = index.get(marker.aliasKey);
    if (!removal) {
      removal = {
        floor: createDictionaryMap<number>(),
        latestStamp: alias.textStamp,
      };
      index.set(marker.aliasKey, removal);
    }
    removal.floor[marker.counterNodeId] = Math.max(
      hasDictionaryKey(removal.floor, marker.counterNodeId)
        ? removal.floor[marker.counterNodeId]!
        : 0,
      marker.removedCount,
    );
    if (compareHlc(alias.textStamp, removal.latestStamp) > 0) {
      removal.latestStamp = alias.textStamp;
    }
  }
  return index;
}

export function readAliasVisibleCount(
  counters: GCounter,
  removalFloor?: GCounter,
): number {
  let total = 0;
  for (const [nodeId, value] of Object.entries(counters)) {
    if (!Number.isFinite(value) || value <= 0) continue;
    const floor = removalFloor && hasDictionaryKey(removalFloor, nodeId)
      ? removalFloor[nodeId]!
      : 0;
    total = Math.min(Number.MAX_SAFE_INTEGER, total + Math.max(0, Math.floor(value) - floor));
  }
  return total;
}

export function readAliasStateVisibleCount(
  alias: SyncAliasState,
  removal?: AliasRemovalState,
): number {
  const count = readAliasVisibleCount(alias.counters, removal?.floor);
  if (count > 0 || !removal) return count;
  return compareHlc(alias.textStamp, removal.latestStamp) > 0 ? 1 : 0;
}

export function gcExpiredRemovedAliases(
  aliases: Readonly<Record<string, SyncAliasState>>,
  thresholdMs: number,
): Record<string, SyncAliasState> {
  const floors = indexAliasRemovalMarkers(aliases);
  const latestRemovalMs = new Map<string, number>();
  for (const [aliasKey, alias] of Object.entries(aliases)) {
    const marker = parseAliasRemovalMarker(aliasKey, alias);
    if (!marker) continue;
    latestRemovalMs.set(
      marker.aliasKey,
      Math.max(latestRemovalMs.get(marker.aliasKey) ?? 0, hlcWallMs(alias.textStamp)),
    );
  }

  const expiredAliasKeys = new Set<string>();
  for (const [aliasKey, removalMs] of latestRemovalMs) {
    const alias = hasDictionaryKey(aliases, aliasKey) ? aliases[aliasKey] : undefined;
    if (alias && readAliasStateVisibleCount(alias, floors.get(aliasKey)) > 0) continue;
    if (removalMs < thresholdMs) expiredAliasKeys.add(aliasKey);
  }
  if (expiredAliasKeys.size === 0) return aliases as Record<string, SyncAliasState>;

  const collected = createDictionaryMap<SyncAliasState>();
  for (const [aliasKey, alias] of Object.entries(aliases)) {
    const marker = parseAliasRemovalMarker(aliasKey, alias);
    const removedAliasKey = marker?.aliasKey ?? aliasKey;
    if (!expiredAliasKeys.has(removedAliasKey)) collected[aliasKey] = alias;
  }
  return collected;
}
