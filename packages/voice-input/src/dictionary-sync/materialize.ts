/** Deterministic display limits never create deletion tombstones for hidden terms. */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { compareHlc } from './hlc.js';
import { createMovedAliasResolver, type ResolveMovedAliases } from './moved-aliases.js';
import {
  indexAliasRemovalMarkers,
  isAliasRemovalMarkerKey,
  readAliasStateVisibleCount,
} from './alias-removal.js';
import {
  hasDictionaryKey,
  listLiveIncarnations,
  readCounterTotal,
  type DictionaryIncarnation,
  type DictionaryTermSource,
  type VoiceDictionarySyncState,
} from './types.js';

export const DEFAULT_MATERIALIZE_LIMITS = {
  maxEntries: 1_000,
  maxCandidates: 200,
  maxAliases: 8,
} as const;

export interface MaterializeLimits {
  maxEntries: number;
  maxCandidates: number;
  maxAliases: number;
}

export interface MaterializedAlias {
  text: string;
  count: number;
  lastSeenAt: number;
}

export interface MaterializedEntry {
  id: string;
  text: string;
  source: DictionaryTermSource;
  frequency: number;
  aliases: MaterializedAlias[];
  createdAt: number;
  updatedAt: number;
}

export interface MaterializedCandidate {
  text: string;
  evidenceCount: number;
  aliases: MaterializedAlias[];
  createdAt: number;
  updatedAt: number;
}

export interface MaterializedDictionary {
  entries: MaterializedEntry[];
  candidates: MaterializedCandidate[];
  suppressedAutomaticTexts: string[];
}

export const MATERIALIZED_ID_PREFIX = 'dict-sync-';

export function materializedEntryId(termKey: string): string {
  return `${MATERIALIZED_ID_PREFIX}${bytesToHex(sha256(new TextEncoder().encode(termKey)))}`;
}

export function pickDisplayText(live: ReadonlyArray<DictionaryIncarnation>): string {
  const first = live[0];
  if (first === undefined) throw new Error('Cannot display a dictionary term without an incarnation.');
  return live.reduce((best, item) => {
    const order = compareHlc(item.textStamp, best.textStamp);
    if (order > 0) return item;
    if (order < 0) return best;
    return item.tag > best.tag ? item : best;
  }, first).text;
}

export function materializeDictionary(
  state: VoiceDictionarySyncState,
  limits: MaterializeLimits = DEFAULT_MATERIALIZE_LIMITS,
): MaterializedDictionary {
  assertMaterializeLimits(limits);
  const entries: Array<MaterializedEntry & { key: string }> = [];
  const candidates: Array<MaterializedCandidate & { key: string }> = [];
  const resolveMovedAliases = createMovedAliasResolver(state);

  for (const [key, record] of Object.entries(state.records)) {
    const live = listLiveIncarnations(record);
    if (live.length === 0) continue;
    const first = live[0]!;

    const source: DictionaryTermSource = live.some((item) => item.source === 'manual')
      ? 'manual'
      : 'automatic';
    if (source === 'automatic' && hasDictionaryKey(state.suppressed, key)) continue;

    const stage = live.some((item) => item.stage === 'entry') ? 'entry' : 'candidate';
    const total = Math.max(
      1,
      live.reduce(
        (sum, item) => addBoundedCounts(sum, readCounterTotal(item.counters)),
        0,
      ),
    );
    const text = pickDisplayText(live);
    const aliases = mergeLiveAliases(key, live, limits.maxAliases, resolveMovedAliases);
    const createdAt = live.reduce((min, item) => Math.min(min, item.createdAt), first.createdAt);
    const updatedAt = live.reduce((max, item) => Math.max(max, item.updatedAt), first.updatedAt);

    if (stage === 'entry') {
      entries.push({
        key,
        id: materializedEntryId(key),
        text,
        source,
        frequency: total,
        aliases,
        createdAt,
        updatedAt,
      });
    } else {
      candidates.push({ key, text, evidenceCount: total, aliases, createdAt, updatedAt });
    }
  }

  return {
    entries: sortAndCap(
      entries,
      (item) => item.frequency,
      limits.maxEntries,
      (item) => (item.source === 'manual' ? 1 : 0),
    ).map(stripKey),
    candidates: sortAndCap(candidates, (item) => item.evidenceCount, limits.maxCandidates).map(stripKey),
    suppressedAutomaticTexts: materializeSuppressions(state, limits.maxEntries),
  };
}

function mergeLiveAliases(
  recordKey: string,
  live: ReadonlyArray<DictionaryIncarnation>,
  maxAliases: number,
  resolveMovedAliases: ResolveMovedAliases,
): MaterializedAlias[] {
  const totals = new Map<string, { text: string; textStamp: string; count: number; lastSeenAt: number }>();
  for (const incarnation of live) {
    const aliases = resolveMovedAliases(recordKey, incarnation);
    const removalIndex = indexAliasRemovalMarkers(aliases);
    for (const [aliasKey, alias] of Object.entries(aliases)) {
      if (isAliasRemovalMarkerKey(aliasKey)) continue;
      const count = readAliasStateVisibleCount(alias, removalIndex.get(aliasKey));
      if (count === 0) continue;
      const existing = totals.get(aliasKey);
      if (!existing) {
        totals.set(aliasKey, {
          text: alias.text,
          textStamp: alias.textStamp,
          count,
          lastSeenAt: alias.lastSeenAt,
        });
        continue;
      }
      const newerText = compareHlc(alias.textStamp, existing.textStamp) > 0;
      totals.set(aliasKey, {
        text: newerText ? alias.text : existing.text,
        textStamp: newerText ? alias.textStamp : existing.textStamp,
        count: addBoundedCounts(existing.count, count),
        lastSeenAt: Math.max(existing.lastSeenAt, alias.lastSeenAt),
      });
    }
  }

  return [...totals.entries()]
    .filter(([, alias]) => alias.count > 0)
    .sort(([keyA, a], [keyB, b]) => b.count - a.count || b.lastSeenAt - a.lastSeenAt || (keyA < keyB ? -1 : 1))
    .slice(0, maxAliases)
    .map(([, alias]) => ({ text: alias.text, count: alias.count, lastSeenAt: alias.lastSeenAt }));
}

function sortAndCap<T extends { key: string; updatedAt: number }>(
  items: T[],
  readWeight: (item: T) => number,
  limit: number,
  readRank: (item: T) => number = () => 0,
): T[] {
  const byWeight = (a: T, b: T): number =>
    readWeight(b) - readWeight(a) || b.updatedAt - a.updatedAt || (a.key < b.key ? -1 : 1);
  const capped = Math.max(0, limit);
  const ordered = [...items].sort(byWeight);
  if (ordered.length <= capped) return ordered;
  const survivors = new Set(
    [...ordered]
      .sort((a, b) => readRank(b) - readRank(a) || byWeight(a, b))
      .slice(0, capped)
      .map((item) => item.key),
  );
  return ordered.filter((item) => survivors.has(item.key));
}

function stripKey<T extends { key: string }>(item: T): Omit<T, 'key'> {
  const rest = { ...item } as Partial<T>;
  delete rest.key;
  return rest as Omit<T, 'key'>;
}

function addBoundedCounts(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

function assertMaterializeLimits(limits: MaterializeLimits): void {
  for (const value of [limits.maxEntries, limits.maxCandidates, limits.maxAliases]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('dictionary materialization limit is invalid');
    }
  }
}

function materializeSuppressions(state: VoiceDictionarySyncState, limit: number): string[] {
  return Object.entries(state.suppressed)
    .sort(([keyA, a], [keyB, b]) => compareHlc(b.stamp, a.stamp) || (keyA < keyB ? -1 : 1))
    .slice(0, limit)
    .sort(([keyA], [keyB]) => (keyA < keyB ? -1 : keyA > keyB ? 1 : 0))
    .map(([, suppression]) => suppression.text);
}
