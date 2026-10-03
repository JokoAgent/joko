/** State joins must be associative, commutative, and idempotent. Counters join by per-node max. */
import { compareHlc, hlcNodeId, maxHlc, minHlc, type HlcTimestamp } from './hlc.js';
import {
  VOICE_DICTIONARY_SYNC_VERSION,
  createDictionaryMap,
  createEmptySyncState,
  hasDictionaryKey,
  type DictionaryIncarnation,
  type DictionaryRecord,
  type DictionaryStage,
  type DictionarySuppression,
  type DictionaryTermSource,
  type GCounter,
  type SyncAliasState,
  type VoiceDictionarySyncState,
} from './types.js';

export function mergeCounters(a: GCounter, b: GCounter): GCounter {
  const merged: GCounter = createDictionaryMap<number>();
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const left = normalizeCount(readDictionaryValue(a, key));
    const right = normalizeCount(readDictionaryValue(b, key));
    const value = Math.max(left, right);
    if (value > 0) merged[key] = value;
  }
  return merged;
}

function normalizeCount(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function mergeLww<T>(
  a: { value: T; stamp: HlcTimestamp },
  b: { value: T; stamp: HlcTimestamp },
): { value: T; stamp: HlcTimestamp } {
  const order = compareHlc(a.stamp, b.stamp);
  if (order > 0) return a;
  if (order < 0) return b;

  return String(a.value) >= String(b.value) ? a : b;
}

function mergeAliasState(a: SyncAliasState, b: SyncAliasState): SyncAliasState {
  const text = mergeLww({ value: a.text, stamp: a.textStamp }, { value: b.text, stamp: b.textStamp });
  return {
    text: text.value,
    textStamp: text.stamp,
    counters: mergeCounters(a.counters, b.counters),
    lastSeenAt: Math.max(a.lastSeenAt, b.lastSeenAt),
  };
}

function mergeAliases(
  a: Record<string, SyncAliasState>,
  b: Record<string, SyncAliasState>,
): Record<string, SyncAliasState> {
  const merged: Record<string, SyncAliasState> = createDictionaryMap<SyncAliasState>();
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const left = readDictionaryValue(a, key);
    const right = readDictionaryValue(b, key);
    if (left && right) merged[key] = mergeAliasState(left, right);
    else merged[key] = (left ?? right)!;
  }
  return merged;
}

function mergeSource(a: DictionaryTermSource, b: DictionaryTermSource): DictionaryTermSource {
  return a === 'manual' || b === 'manual' ? 'manual' : 'automatic';
}

function mergeStage(a: DictionaryStage, b: DictionaryStage): DictionaryStage {
  return a === 'entry' || b === 'entry' ? 'entry' : 'candidate';
}

function mergeIncarnation(a: DictionaryIncarnation, b: DictionaryIncarnation): DictionaryIncarnation {
  const text = mergeLww({ value: a.text, stamp: a.textStamp }, { value: b.text, stamp: b.textStamp });
  return {
    tag: a.tag,
    text: text.value,
    textStamp: text.stamp,
    source: mergeSource(a.source, b.source),
    stage: mergeStage(a.stage, b.stage),
    counters: mergeCounters(a.counters, b.counters),
    aliases: mergeAliases(a.aliases, b.aliases),
    createdAt: Math.min(a.createdAt, b.createdAt),
    updatedAt: Math.max(a.updatedAt, b.updatedAt),
  };
}

function mergeRecord(a: DictionaryRecord, b: DictionaryRecord): DictionaryRecord {
  const incarnations: Record<HlcTimestamp, DictionaryIncarnation> = createDictionaryMap<DictionaryIncarnation>();
  for (const tag of new Set([...Object.keys(a.incarnations), ...Object.keys(b.incarnations)])) {
    const left = readDictionaryValue(a.incarnations, tag);
    const right = readDictionaryValue(b.incarnations, tag);
    if (left && right) incarnations[tag] = mergeIncarnation(left, right);
    else incarnations[tag] = (left ?? right)!;
  }

  const tombstones: Record<HlcTimestamp, HlcTimestamp> = createDictionaryMap<HlcTimestamp>();
  for (const tag of new Set([...Object.keys(a.tombstones), ...Object.keys(b.tombstones)])) {
    const left = readDictionaryValue(a.tombstones, tag);
    const right = readDictionaryValue(b.tombstones, tag);
    tombstones[tag] = left && right ? maxHlc(left, right) : (left ?? right)!;
  }

  return { incarnations, tombstones };
}

function mergeSuppression(a: DictionarySuppression, b: DictionarySuppression): DictionarySuppression {
  const order = compareHlc(a.stamp, b.stamp);
  const stamp = minHlc(a.stamp, b.stamp);
  const text = order === 0 ? (a.text >= b.text ? a.text : b.text) : order < 0 ? a.text : b.text;
  return { text, stamp };
}

export function mergeSyncStates(
  a: VoiceDictionarySyncState,
  b: VoiceDictionarySyncState,
): VoiceDictionarySyncState {
  if (a.version !== VOICE_DICTIONARY_SYNC_VERSION || b.version !== VOICE_DICTIONARY_SYNC_VERSION) {
    throw new Error('Unsupported voice dictionary sync state version.');
  }

  const records: Record<string, DictionaryRecord> = createDictionaryMap<DictionaryRecord>();
  for (const key of new Set([...Object.keys(a.records), ...Object.keys(b.records)])) {
    const left = readDictionaryValue(a.records, key);
    const right = readDictionaryValue(b.records, key);
    if (left && right) records[key] = mergeRecord(left, right);
    else records[key] = (left ?? right)!;
  }

  const suppressed: Record<string, DictionarySuppression> = createDictionaryMap<DictionarySuppression>();
  for (const key of new Set([...Object.keys(a.suppressed), ...Object.keys(b.suppressed)])) {
    const left = readDictionaryValue(a.suppressed, key);
    const right = readDictionaryValue(b.suppressed, key);
    if (left && right) suppressed[key] = mergeSuppression(left, right);
    else suppressed[key] = (left ?? right)!;
  }

  const mutationVector = createDictionaryMap<HlcTimestamp>();
  for (const input of [a.mutationVector, b.mutationVector]) {
    for (const [nodeId, stamp] of Object.entries(input)) {
      const current = readDictionaryValue(mutationVector, nodeId);
      mutationVector[nodeId] = current === undefined ? stamp : maxHlc(current, stamp);
    }
  }
  return { version: VOICE_DICTIONARY_SYNC_VERSION, mutationVector, records, suppressed };
}

export function mergeAllSyncStates(
  states: ReadonlyArray<VoiceDictionarySyncState>,
): VoiceDictionarySyncState {
  return states.reduce<VoiceDictionarySyncState>(
    (acc, state) => mergeSyncStates(acc, state),
    createEmptySyncState(),
  );
}

export function buildStateVersionVector(state: VoiceDictionarySyncState): Record<string, string> {
  const vector: Record<string, string> = Object.create(null) as Record<string, string>;
  const observe = (stamp: HlcTimestamp | undefined): void => {
    if (!stamp) return;
    const nodeId = hlcNodeId(stamp);
    if (!nodeId) return;
    const current = vector[nodeId];
    if (current === undefined || compareHlc(stamp, current) > 0) vector[nodeId] = stamp;
  };
  for (const record of Object.values(state.records)) {
    for (const incarnation of Object.values(record.incarnations)) {
      observe(incarnation.tag);
      observe(incarnation.textStamp);
      for (const alias of Object.values(incarnation.aliases)) observe(alias.textStamp);
    }
    for (const stamp of Object.values(record.tombstones)) observe(stamp);
  }
  for (const suppression of Object.values(state.suppressed)) observe(suppression.stamp);
  for (const stamp of Object.values(state.mutationVector)) observe(stamp);

  return vector;
}

export function versionVectorDominates(
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>,
): boolean {
  for (const [nodeId, stamp] of Object.entries(b)) {
    const mine = readDictionaryValue(a, nodeId);
    if (mine === undefined || compareHlc(mine, stamp) < 0) return false;
  }
  return true;
}

export function findMaxHlc(state: VoiceDictionarySyncState): HlcTimestamp | null {
  let max: HlcTimestamp | null = null;
  const observe = (stamp: HlcTimestamp | undefined): void => {
    if (!stamp) return;
    max = max === null ? stamp : maxHlc(max, stamp);
  };
  for (const record of Object.values(state.records)) {
    for (const incarnation of Object.values(record.incarnations)) {
      observe(incarnation.tag);
      observe(incarnation.textStamp);
      for (const alias of Object.values(incarnation.aliases)) observe(alias.textStamp);
    }
    for (const stamp of Object.values(record.tombstones)) observe(stamp);
  }
  for (const suppression of Object.values(state.suppressed)) observe(suppression.stamp);
  for (const stamp of Object.values(state.mutationVector)) observe(stamp);
  return max;
}

function readDictionaryValue<T>(map: Readonly<Record<string, T>>, key: string): T | undefined {
  return hasDictionaryKey(map, key) ? map[key] : undefined;
}
