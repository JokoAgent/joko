/** Local edits are pure mutations; callers persist state and clock together before publishing. */
import {
  HLC_MAX_WALL_MS,
  compareHlc,
  formatHlc,
  hlcWallMs,
  tickHlc,
  type HlcClock,
  type HlcTimestamp,
} from './hlc.js';
import { MATERIALIZED_ID_PREFIX, materializeDictionary, materializedEntryId, pickDisplayText } from './materialize.js';
import { deriveMoveTag } from './move-tag.js';
import { createMovedAliasResolver } from './moved-aliases.js';
import { dictionaryTermKey, normalizeDictionaryTermText } from './text.js';
import {
  createAliasRemovalMarker,
  gcExpiredRemovedAliases,
  indexAliasRemovalMarkers,
  isAliasRemovalMarkerKey,
  readAliasStateVisibleCount,
  readAliasVisibleCount,
} from './alias-removal.js';
import {
  copyDictionaryMap,
  createDictionaryMap,
  hasDictionaryKey,
  listLiveIncarnations,
  readCounterTotal,
  withDictionaryKey,
  type DictionaryIncarnation,
  type DictionaryRecord,
  type DictionaryStage,
  type DictionaryTermSource,
  type SyncAliasState,
  type VoiceDictionarySyncState,
} from './types.js';

const DICTIONARY_CANDIDATE_PROMOTION_COUNT = 2;

export interface MutationResult {
  state: VoiceDictionarySyncState;
  clock: HlcClock;

  changed: boolean;
}

export interface LearningEventInput {

  text: string;

  aliases?: string[];

  stage: DictionaryStage;
  nowMs: number;
}

export function recordLearningEvent(
  state: VoiceDictionarySyncState,
  clock: HlcClock,
  input: LearningEventInput,
): MutationResult {
  assertMutationTimestamp(input.nowMs);
  const text = normalizeDictionaryTermText(input.text);
  const key = dictionaryTermKey(text);
  if (!key) return { state, clock, changed: false };

  const record = readDictionaryValue(state.records, key);
  const live = record ? listLiveIncarnations(record) : [];

  if (hasDictionaryKey(state.suppressed, key) && !live.some((item) => item.source === 'manual')) {
    return { state, clock, changed: false };
  }

  const aliasTexts = normalizeAliasTexts(input.aliases, key);
  const ticked = tickHlc(clock, input.nowMs);

  if (live.length === 0) {
    return {
      state: putRecord(state, key, {
        incarnations: {
          [ticked.stamp]: createIncarnation({
            tag: ticked.stamp,
            text,
            source: 'automatic',
            stage: input.stage,
            nodeId: clock.nodeId,
            aliasTexts,
            nowMs: input.nowMs,
          }),
        },
        tombstones: record?.tombstones ?? {},
      }),
      clock: ticked.clock,
      changed: true,
    };
  }

  const target = live[0]!;
  const targetAliases = createMovedAliasResolver(state)(key, target);
  const nextCount = addBoundedCounts(
    live.reduce((sum, item) => addBoundedCounts(sum, readCounterTotal(item.counters)), 0),
    1,
  );
  return {
    state: putRecord(state, key, {
      ...record!,
      incarnations: {
        ...copyDictionaryMap(record!.incarnations),
        [target.tag]: bumpIncarnation({ ...target, aliases: targetAliases }, {
          nodeId: clock.nodeId,
          stage: nextCount >= DICTIONARY_CANDIDATE_PROMOTION_COUNT ? 'entry' : input.stage,
          aliasTexts,
          stamp: ticked.stamp,
          nowMs: input.nowMs,
        }),
      },
    }, ticked.clock),
    clock: ticked.clock,
    changed: true,
  };
}

export function promoteTermToEntry(
  state: VoiceDictionarySyncState,
  clock: HlcClock,
  input: { termKey: string; nowMs: number },
): MutationResult {
  assertMutationTimestamp(input.nowMs);
  const record = readDictionaryValue(state.records, input.termKey);
  if (!record) return { state, clock, changed: false };
  const live = listLiveIncarnations(record);
  if (live.length === 0 || live.every((item) => item.stage === 'entry')) {
    return { state, clock, changed: false };
  }

  const ticked = tickHlc(clock, input.nowMs);
  const incarnations = copyDictionaryMap(record.incarnations);
  for (const incarnation of live) {
    if (incarnation.stage === 'entry') continue;
    incarnations[incarnation.tag] = {
      ...incarnation,
      stage: 'entry',
      updatedAt: Math.max(incarnation.updatedAt, input.nowMs),
    };
  }
  return {
    state: putRecord(state, input.termKey, { ...record, incarnations }, ticked.clock),
    clock: ticked.clock,
    changed: true,
  };
}

export function promoteEligibleDictionaryCandidates(
  state: VoiceDictionarySyncState,
  clock: HlcClock,
  nowMs: number,
): MutationResult {
  assertMutationTimestamp(nowMs);
  let next = state;
  let nextClock = clock;
  for (const [key, record] of Object.entries(state.records)) {
    const live = listLiveIncarnations(record);
    if (hasDictionaryKey(state.suppressed, key) || live.some((item) => item.stage === 'entry')) continue;
    const count = live.reduce((sum, item) => sum + readCounterTotal(item.counters), 0);
    if (count < DICTIONARY_CANDIDATE_PROMOTION_COUNT) continue;
    const promoted = promoteTermToEntry(next, nextClock, {
      termKey: key,
      nowMs: Math.max(nowMs, ...live.map((item) => item.updatedAt)),
    });
    next = promoted.state;
    nextClock = promoted.clock;
  }
  return { state: next, clock: nextClock, changed: next !== state };
}

export interface ManualEntryInput {
  text: string;
  nowMs: number;
}

export function addManualEntry(
  state: VoiceDictionarySyncState,
  clock: HlcClock,
  input: ManualEntryInput,
): MutationResult {
  assertMutationTimestamp(input.nowMs);
  const text = normalizeDictionaryTermText(input.text);
  const key = dictionaryTermKey(text);
  if (!key) return { state, clock, changed: false };

  const record = readDictionaryValue(state.records, key);
  const live = record ? listLiveIncarnations(record) : [];
  const noop = live.some((item) => item.source === 'manual' && item.stage === 'entry');
  if (noop) return { state, clock, changed: false };

  const ticked = tickHlc(clock, input.nowMs);
  return {
    state: putRecord(state, key, {
      incarnations: {
        ...copyDictionaryMap(record?.incarnations),
        [ticked.stamp]: createIncarnation({
          tag: ticked.stamp,
          text,
          source: 'manual',
          stage: 'entry',
          nodeId: clock.nodeId,
          aliasTexts: [],
          nowMs: input.nowMs,
        }),
      },
      tombstones: record?.tombstones ?? {},
    }),
    clock: ticked.clock,
    changed: true,
  };
}

export interface DeleteTermsInput {

  termKeys: ReadonlyArray<string>;
  nowMs: number;

  suppressAutomatic?: boolean;
}

export function deleteTerms(
  state: VoiceDictionarySyncState,
  clock: HlcClock,
  input: DeleteTermsInput,
): MutationResult {
  assertMutationTimestamp(input.nowMs);
  let nextState = state;
  let nextClock = clock;
  let changed = false;

  for (const rawKey of input.termKeys) {
    const key = dictionaryTermKey(rawKey);
    const record = key ? readDictionaryValue(nextState.records, key) : undefined;
    if (!record) continue;
    const live = listLiveIncarnations(record);
    if (live.length === 0) continue;

    const ticked = tickHlc(nextClock, input.nowMs);
    nextClock = ticked.clock;

    const tombstones: Record<HlcTimestamp, HlcTimestamp> = copyDictionaryMap(record.tombstones);
    for (const incarnation of live) tombstones[incarnation.tag] = ticked.stamp;

    const isAutomatic = !live.some((item) => item.source === 'manual');
    nextState = putRecord(nextState, key, { ...record, tombstones });
    if (input.suppressAutomatic !== false && isAutomatic && !hasDictionaryKey(nextState.suppressed, key)) {
      nextState = {
        ...nextState,
        suppressed: withDictionaryKey(nextState.suppressed, key, {

          text: pickDisplayText(live),
          stamp: ticked.stamp,
        }),
      };
    }
    changed = true;
  }

  return { state: nextState, clock: nextClock, changed };
}

export interface RenameTermInput {

  termKey: string;

  nextText: string;
  nowMs: number;
}

export function renameTerm(
  state: VoiceDictionarySyncState,
  clock: HlcClock,
  input: RenameTermInput,
): MutationResult {
  assertMutationTimestamp(input.nowMs);
  const fromKey = dictionaryTermKey(input.termKey);
  const nextText = normalizeDictionaryTermText(input.nextText);
  const toKey = dictionaryTermKey(nextText);
  if (!fromKey || !toKey) return { state, clock, changed: false };

  const record = readDictionaryValue(state.records, fromKey);
  const resolveMovedAliases = createMovedAliasResolver(state);
  const live = record
    ? listLiveIncarnations(record).map((incarnation) => ({
        ...incarnation,
        aliases: resolveMovedAliases(fromKey, incarnation),
      }))
    : [];
  if (live.length === 0) return { state, clock, changed: false };

  if (fromKey !== toKey) {

    const ticked = tickHlc(clock, input.nowMs);
    const moved = createDictionaryMap<DictionaryIncarnation>();
    for (const incarnation of live) {
      const movedTag = deriveMoveTag(incarnation.tag, toKey);
      moved[movedTag] = {
        ...incarnation,
        tag: movedTag,
        text: nextText,
        textStamp: ticked.stamp,
        source: 'manual',
        stage: 'entry',
        updatedAt: Math.max(incarnation.updatedAt, input.nowMs),
      };
    }

    const removed = deleteTerms(state, ticked.clock, {
      termKeys: [fromKey],
      nowMs: input.nowMs,
      suppressAutomatic: false,
    });

    const target = readDictionaryValue(removed.state.records, toKey);
    return {
      state: putRecord(removed.state, toKey, {
        incarnations: { ...copyDictionaryMap(target?.incarnations), ...moved },
        tombstones: copyDictionaryMap(target?.tombstones),
      }),
      clock: removed.clock,
      changed: true,
    };
  }

  if (live.every((item) => item.text === nextText && item.source === 'manual')) {
    return { state, clock, changed: false };
  }

  const ticked = tickHlc(clock, input.nowMs);
  const incarnations: Record<HlcTimestamp, DictionaryIncarnation> = copyDictionaryMap(record!.incarnations);
  for (const incarnation of live) {
    incarnations[incarnation.tag] = {
      ...incarnation,
      text: nextText,
      textStamp: ticked.stamp,
      source: 'manual',
      updatedAt: Math.max(incarnation.updatedAt, input.nowMs),
    };
  }
  return {
    state: putRecord(state, fromKey, { ...record!, incarnations }),
    clock: ticked.clock,
    changed: true,
  };
}

export interface ReplaceTermAliasesInput {

  termKey: string;

  primaryText?: string;

  aliases: ReadonlyArray<string>;
  nowMs: number;
}

export function replaceTermAliases(
  state: VoiceDictionarySyncState,
  clock: HlcClock,
  input: ReplaceTermAliasesInput,
): MutationResult {
  assertMutationTimestamp(input.nowMs);
  const key = dictionaryTermKey(input.termKey);
  const record = key ? readDictionaryValue(state.records, key) : undefined;
  const resolveMovedAliases = createMovedAliasResolver(state);
  const live = record
    ? listLiveIncarnations(record).map((incarnation) => ({
        ...incarnation,
        aliases: resolveMovedAliases(key, incarnation),
      }))
    : [];
  if (!key || !record || live.length === 0) return { state, clock, changed: false };

  const primaryKey = dictionaryTermKey(input.primaryText ?? input.termKey);
  const aliasTexts = normalizeAliasTexts(input.aliases, primaryKey);
  const desired = new Map(aliasTexts.map((text) => [dictionaryTermKey(text), text]));
  const current = new Map<string, { text: string; stamp: HlcTimestamp }>();
  for (const incarnation of live) {
    const removalIndex = indexAliasRemovalMarkers(incarnation.aliases);
    for (const [aliasKey, alias] of Object.entries(incarnation.aliases)) {
      if (isAliasRemovalMarkerKey(aliasKey)) continue;
      const removal = removalIndex.get(aliasKey);
      if (readAliasStateVisibleCount(alias, removal) === 0) continue;
      const existing = current.get(aliasKey);
      if (!existing || compareHlc(alias.textStamp, existing.stamp) > 0) {
        current.set(aliasKey, { text: alias.text, stamp: alias.textStamp });
      }
    }
  }
  const unchanged =
    current.size === desired.size &&
    [...desired].every(([aliasKey, text]) => current.get(aliasKey)?.text === text) &&
    live.every((incarnation) => incarnation.source === 'manual' && incarnation.stage === 'entry');
  if (unchanged) return { state, clock, changed: false };

  const ticked = tickHlc(clock, input.nowMs);
  const primaryTag = [...live].sort((a, b) => a.tag.localeCompare(b.tag))[0]!.tag;
  const incarnations = copyDictionaryMap(record.incarnations);

  for (const incarnation of live) {
    const aliases = copyDictionaryMap(incarnation.aliases);
    const floors = indexAliasRemovalMarkers(incarnation.aliases);

    for (const [aliasKey, existing] of Object.entries(incarnation.aliases)) {
      if (isAliasRemovalMarkerKey(aliasKey)) continue;
      const desiredText = desired.get(aliasKey);
      if (desiredText !== undefined) {
        if (existing.text !== desiredText) {
          aliases[aliasKey] = {
            ...existing,
            text: desiredText,
            textStamp: ticked.stamp,
          };
        }
        continue;
      }

      const removal = floors?.get(aliasKey);
      const visibleCount = readAliasStateVisibleCount(existing, removal);
      if (visibleCount === 0) continue;
      const counterVisibleCount = readAliasVisibleCount(existing.counters, removal?.floor);
      for (const [counterNodeId, rawCount] of Object.entries(existing.counters)) {
        const removedCount = Math.floor(rawCount);
        if (removedCount <= (removal?.floor[counterNodeId] ?? 0)) continue;
        const marker = createAliasRemovalMarker(ticked.stamp, {
          aliasKey,
          counterNodeId,
          removedCount,
        });
        aliases[marker.key] = marker.state;
      }

      if (counterVisibleCount === 0) {
        const fallbackCounter = Object.entries(existing.counters)
          .filter(([, rawCount]) => Math.floor(rawCount) > 0)
          .sort(([nodeA], [nodeB]) => nodeA.localeCompare(nodeB))[0];
        if (fallbackCounter) {
          const [counterNodeId, rawCount] = fallbackCounter;
          const marker = createAliasRemovalMarker(ticked.stamp, {
            aliasKey,
            counterNodeId,
            removedCount: Math.floor(rawCount),
          });
          aliases[marker.key] = marker.state;
        }
      }
    }

    if (incarnation.tag === primaryTag) {
      for (const [aliasKey, text] of desired) {
        if (current.has(aliasKey)) continue;
        const existing = aliases[aliasKey];
        const removal = floors?.get(aliasKey);
        const counters = copyDictionaryMap(existing?.counters);
        counters[clock.nodeId] = addBoundedCounts(
          Math.max(
            readDictionaryValue(counters, clock.nodeId) ?? 0,
            removal ? readDictionaryValue(removal.floor, clock.nodeId) ?? 0 : 0,
          ),
          1,
        );
        aliases[aliasKey] = {
          ...(existing ?? {
            counters,
            lastSeenAt: input.nowMs,
          }),
          text,
          textStamp: ticked.stamp,
          counters,
          lastSeenAt: Math.max(existing?.lastSeenAt ?? 0, input.nowMs),
        };
      }
    }

    incarnations[incarnation.tag] = {
      ...incarnation,
      source: 'manual',
      stage: 'entry',
      aliases,
      updatedAt: Math.max(incarnation.updatedAt, input.nowMs),
    };
  }

  return {
    state: putRecord(state, key, { ...record, incarnations }, ticked.clock),
    clock: ticked.clock,
    changed: true,
  };
}

export function termKeyFromMaterializedId(
  state: VoiceDictionarySyncState,
  entryId: string,
): string | null {
  const trimmed = entryId.trim();
  if (!trimmed.startsWith(MATERIALIZED_ID_PREFIX)) return null;
  return Object.keys(state.records).find((key) => materializedEntryId(key) === trimmed) ?? null;
}

export interface GcOptions {
  nowMs: number;

  ttlMs: number;
}

export const DEFAULT_TOMBSTONE_TTL_MS = 180 * 24 * 60 * 60 * 1000;

export const MAX_AUTOMATIC_CANDIDATE_RECORDS = 2_000;

export function pruneWeakAutomaticCandidates(
  state: VoiceDictionarySyncState,
  clock: HlcClock,
  options: { maxRecords?: number; nowMs: number },
): MutationResult {
  assertMutationTimestamp(options.nowMs);
  const requestedLimit = options.maxRecords ?? MAX_AUTOMATIC_CANDIDATE_RECORDS;
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 0) {
    throw new Error('dictionary candidate limit is invalid');
  }
  const limit = requestedLimit;
  const candidates: Array<{ key: string; weight: number }> = [];
  for (const [key, record] of Object.entries(state.records)) {
    const live = listLiveIncarnations(record);
    if (live.length === 0) continue;

    if (live.some((item) => item.stage === 'entry' || item.source === 'manual')) continue;
    candidates.push({
      key,
      weight: live.reduce((sum, item) => addBoundedCounts(sum, readCounterTotal(item.counters)), 0),
    });
  }
  if (candidates.length <= limit) return { state, clock, changed: false };

  const doomed = candidates
    .sort((a, b) => a.weight - b.weight || (a.key < b.key ? -1 : 1))
    .slice(0, candidates.length - limit)
    .map((item) => item.key);

  return deleteTerms(state, clock, {
    termKeys: doomed,
    nowMs: options.nowMs,
    suppressAutomatic: false,
  });
}

export function gcTombstones(
  state: VoiceDictionarySyncState,
  options: GcOptions,
): VoiceDictionarySyncState {
  assertMutationTimestamp(options.nowMs);
  if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs < 0 || options.ttlMs > HLC_MAX_WALL_MS) {
    throw new Error('dictionary tombstone ttl is invalid');
  }
  const threshold = options.nowMs - options.ttlMs;
  const hasExpiredState = Object.values(state.records).some(
    (record) =>
      Object.values(record.tombstones).some((stamp) => hlcWallMs(stamp) < threshold) ||
      Object.values(record.incarnations).some((incarnation) =>
        Object.entries(incarnation.aliases).some(
          ([aliasKey, alias]) =>
            isAliasRemovalMarkerKey(aliasKey) && hlcWallMs(alias.textStamp) < threshold,
        ),
      ),
  );
  if (!hasExpiredState) return state;

  const resolveMovedAliases = createMovedAliasResolver(state);

  const records: Record<string, DictionaryRecord> = createDictionaryMap<DictionaryRecord>();
  let changed = false;

  for (const [key, record] of Object.entries(state.records)) {
    const tombstones: Record<HlcTimestamp, HlcTimestamp> = createDictionaryMap<HlcTimestamp>();
    const expired = new Set<HlcTimestamp>();
    for (const [tag, stamp] of Object.entries(record.tombstones)) {
      if (hlcWallMs(stamp) < threshold) {
        expired.add(tag);
        changed = true;
      }
      else tombstones[tag] = stamp;
    }
    const incarnations: Record<HlcTimestamp, DictionaryIncarnation> = createDictionaryMap<DictionaryIncarnation>();
    for (const [tag, incarnation] of Object.entries(record.incarnations)) {
      if (!expired.has(tag)) {
        const resolvedAliases = resolveMovedAliases(key, incarnation);
        const aliases = gcExpiredRemovedAliases(resolvedAliases, threshold);
        changed = changed || aliases !== resolvedAliases;
        incarnations[tag] = {
          ...incarnation,
          aliases,
        };
      }
    }
    if (Object.keys(incarnations).length > 0 || Object.keys(tombstones).length > 0) {
      records[key] = { incarnations, tombstones };
    }
  }

  return changed ? { ...state, records } : state;
}

function putRecord(
  state: VoiceDictionarySyncState,
  key: string,
  record: DictionaryRecord,
  mutationClock?: HlcClock,
): VoiceDictionarySyncState {
  const next = { ...state, records: withDictionaryKey(state.records, key, record) };
  if (mutationClock) {
    next.mutationVector = withDictionaryKey(state.mutationVector, mutationClock.nodeId, formatHlc(mutationClock));
  }
  return next;
}

function createIncarnation(input: {
  tag: HlcTimestamp;
  text: string;
  source: DictionaryTermSource;
  stage: DictionaryStage;
  nodeId: string;
  aliasTexts: ReadonlyArray<string>;
  nowMs: number;
}): DictionaryIncarnation {
  const counters = createDictionaryMap<number>();
  counters[input.nodeId] = 1;
  return {
    tag: input.tag,
    text: input.text,
    textStamp: input.tag,
    source: input.source,
    stage: input.stage,
    counters,
    aliases: buildAliases(createDictionaryMap(), input.aliasTexts, input.nodeId, input.tag, input.nowMs),
    createdAt: input.nowMs,
    updatedAt: input.nowMs,
  };
}

function bumpIncarnation(
  incarnation: DictionaryIncarnation,
  input: {
    nodeId: string;
    stage: DictionaryStage;
    aliasTexts: ReadonlyArray<string>;
    stamp: HlcTimestamp;
    nowMs: number;
  },
): DictionaryIncarnation {
  return {
    ...incarnation,
    stage: incarnation.stage === 'entry' || input.stage === 'entry' ? 'entry' : 'candidate',
    counters: withDictionaryKey(
      incarnation.counters,
      input.nodeId,
      addBoundedCounts(readDictionaryValue(incarnation.counters, input.nodeId) ?? 0, 1),
    ),
    aliases: buildAliases(incarnation.aliases, input.aliasTexts, input.nodeId, input.stamp, input.nowMs),
    updatedAt: Math.max(incarnation.updatedAt, input.nowMs),
  };
}

function buildAliases(
  current: Record<string, SyncAliasState>,
  aliasTexts: ReadonlyArray<string>,
  nodeId: string,
  stamp: HlcTimestamp,
  nowMs: number,
): Record<string, SyncAliasState> {
  if (aliasTexts.length === 0) return current;
  const next: Record<string, SyncAliasState> = copyDictionaryMap(current);
  for (const aliasText of aliasTexts) {
    const aliasKey = dictionaryTermKey(aliasText);
    if (!aliasKey) continue;
    const existing = next[aliasKey];
    next[aliasKey] = existing
      ? {
          text: aliasText,
          textStamp: stamp,
          counters: withDictionaryKey(
            existing.counters,
            nodeId,
            addBoundedCounts(readDictionaryValue(existing.counters, nodeId) ?? 0, 1),
          ),
          lastSeenAt: Math.max(existing.lastSeenAt, nowMs),
        }
      : {
          text: aliasText,
          textStamp: stamp,
          counters: withDictionaryKey(createDictionaryMap(), nodeId, 1),
          lastSeenAt: nowMs,
        };
  }
  return next;
}

function normalizeAliasTexts(aliases: ReadonlyArray<string> | undefined, termKey: string): string[] {
  if (!aliases || aliases.length === 0) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of aliases) {
    const text = normalizeDictionaryTermText(raw);
    const key = dictionaryTermKey(text);

    if (!key || key === termKey || isAliasRemovalMarkerKey(key) || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

function addBoundedCounts(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

function assertMutationTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > HLC_MAX_WALL_MS) {
    throw new Error('dictionary mutation time is invalid');
  }
}

function readDictionaryValue<T>(map: Readonly<Record<string, T>>, key: string): T | undefined {
  return hasDictionaryKey(map, key) ? map[key] : undefined;
}
