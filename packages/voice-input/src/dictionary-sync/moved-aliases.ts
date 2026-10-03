import { compareHlc, HLC_PREFIX_LENGTH, type HlcTimestamp } from "./hlc.js";
import { deriveMoveTag } from "./move-tag.js";
import {
  createDictionaryMap,
  hasDictionaryKey,
  type DictionaryIncarnation,
  type GCounter,
  type SyncAliasState,
  type VoiceDictionarySyncState,
} from "./types.js";

export type ResolveMovedAliases = (
  recordKey: string,
  incarnation: DictionaryIncarnation,
) => Record<string, SyncAliasState>;

interface AliasAncestor {
  recordKey: string;
  tag: HlcTimestamp;
  incarnation: DictionaryIncarnation;
}

export function createMovedAliasResolver(
  state: VoiceDictionarySyncState,
): ResolveMovedAliases {
  const ancestorsByPrefix = new Map<string, AliasAncestor[]>();
  for (const [recordKey, record] of Object.entries(state.records)) {
    for (const [tag, incarnation] of Object.entries(record.incarnations)) {
      if (!hasDictionaryKey(record.tombstones, tag)) continue;
      const prefix = tag.slice(0, HLC_PREFIX_LENGTH);
      const ancestors = ancestorsByPrefix.get(prefix) ?? [];
      ancestors.push({ recordKey, tag, incarnation });
      ancestorsByPrefix.set(prefix, ancestors);
    }
  }

  const memo = new Map<
    string,
    Map<HlcTimestamp, Record<string, SyncAliasState>>
  >();
  const visiting = new Set<DictionaryIncarnation>();

  const resolve: ResolveMovedAliases = (recordKey, incarnation) => {
    const cached = memo.get(recordKey)?.get(incarnation.tag);
    if (cached) return cached;

    if (visiting.has(incarnation)) return incarnation.aliases;
    visiting.add(incarnation);

    let aliases = incarnation.aliases;
    const prefix = incarnation.tag.slice(0, HLC_PREFIX_LENGTH);
    for (const ancestor of ancestorsByPrefix.get(prefix) ?? []) {
      if (ancestor.incarnation === incarnation) continue;
      if (deriveMoveTag(ancestor.tag, recordKey) !== incarnation.tag) continue;
      aliases = mergeAliasMaps(
        aliases,
        resolve(ancestor.recordKey, ancestor.incarnation),
      );
    }

    visiting.delete(incarnation);
    let byTag = memo.get(recordKey);
    if (!byTag) {
      byTag = new Map();
      memo.set(recordKey, byTag);
    }
    byTag.set(incarnation.tag, aliases);
    return aliases;
  };

  return resolve;
}

function mergeAliasMaps(
  a: Readonly<Record<string, SyncAliasState>>,
  b: Readonly<Record<string, SyncAliasState>>,
): Record<string, SyncAliasState> {
  const merged = createDictionaryMap<SyncAliasState>();
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const left = hasDictionaryKey(a, key) ? a[key] : undefined;
    const right = hasDictionaryKey(b, key) ? b[key] : undefined;
    if (!left || !right) {
      merged[key] = (left ?? right)!;
      continue;
    }
    const textOrder = compareHlc(left.textStamp, right.textStamp);
    const textFromLeft =
      textOrder > 0 || (textOrder === 0 && left.text >= right.text);
    merged[key] = {
      text: textFromLeft ? left.text : right.text,
      textStamp: textFromLeft ? left.textStamp : right.textStamp,
      counters: mergeCounters(left.counters, right.counters),
      lastSeenAt: Math.max(left.lastSeenAt, right.lastSeenAt),
    };
  }
  return merged;
}

function mergeCounters(a: GCounter, b: GCounter): GCounter {
  const merged = createDictionaryMap<number>();
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const value = Math.max(
      normalizeCount(hasDictionaryKey(a, key) ? a[key] : undefined),
      normalizeCount(hasDictionaryKey(b, key) ? b[key] : undefined),
    );
    if (value > 0) merged[key] = value;
  }
  return merged;
}

function normalizeCount(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    return 0;
  return Math.floor(value);
}
