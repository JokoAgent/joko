/** Current-v1 state and strict ingress validation for peer dictionary exchange. */
import type { HlcTimestamp } from './hlc.js';
import { HLC_MAX_WALL_MS, hlcNodeId, isCanonicalHlc, isValidHlcNodeId } from './hlc.js';
import { isAliasRemovalMarkerKey, parseAliasRemovalMarkerKey } from './alias-removal-key.js';
import { dictionaryTermKey, normalizeDictionaryTermText } from './text.js';

export const VOICE_DICTIONARY_SYNC_VERSION = 1;
export const MAX_VOICE_DICTIONARY_SYNC_BYTES = 1_800_000;

export type GCounter = Record<string, number>;

export type DictionaryStage = 'candidate' | 'entry';

export type DictionaryTermSource = 'manual' | 'automatic';

export interface SyncAliasState {

  text: string;
  textStamp: HlcTimestamp;

  counters: GCounter;

  lastSeenAt: number;
}

export interface DictionaryIncarnation {

  tag: HlcTimestamp;

  text: string;
  textStamp: HlcTimestamp;

  source: DictionaryTermSource;

  stage: DictionaryStage;

  counters: GCounter;

  aliases: Record<string, SyncAliasState>;

  createdAt: number;
  updatedAt: number;
}

export interface DictionaryRecord {
  incarnations: Record<HlcTimestamp, DictionaryIncarnation>;
  tombstones: Record<HlcTimestamp, HlcTimestamp>;
}

export interface DictionarySuppression {
  text: string;
  stamp: HlcTimestamp;
}

export interface VoiceDictionarySyncState {
  version: typeof VOICE_DICTIONARY_SYNC_VERSION;

  mutationVector: Record<string, HlcTimestamp>;

  records: Record<string, DictionaryRecord>;

  suppressed: Record<string, DictionarySuppression>;
}

export function createDictionaryMap<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

export function copyDictionaryMap<T>(map: Record<string, T> | undefined | null): Record<string, T> {
  const next = createDictionaryMap<T>();
  if (!map) return next;
  for (const key of Object.keys(map)) next[key] = map[key]!;
  return next;
}

export function withDictionaryKey<T>(
  map: Record<string, T> | undefined | null,
  key: string,
  value: T,
): Record<string, T> {
  const next = copyDictionaryMap(map);
  next[key] = value;
  return next;
}

export function hasDictionaryKey(map: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(map, key);
}

export function createEmptySyncState(): VoiceDictionarySyncState {
  return {
    version: VOICE_DICTIONARY_SYNC_VERSION,
    mutationVector: createDictionaryMap(),
    records: createDictionaryMap(),
    suppressed: createDictionaryMap(),
  };
}

export function isValidSyncState(raw: unknown): raw is VoiceDictionarySyncState {
  if (!isPlainRecord(raw)) return false;
  try {
    const encoded = JSON.stringify(raw);
    if (encoded === undefined || new TextEncoder().encode(encoded).byteLength > MAX_VOICE_DICTIONARY_SYNC_BYTES) {
      return false;
    }
  } catch {
    return false;
  }
  const candidate = raw as Partial<VoiceDictionarySyncState>;
  if (candidate.version !== VOICE_DICTIONARY_SYNC_VERSION) return false;
  if (!hasExactKeys(candidate, ['version', 'mutationVector', 'records', 'suppressed'])) return false;
  if (!isPlainRecord(candidate.records) || !isPlainRecord(candidate.suppressed)
    || !isPlainRecord(candidate.mutationVector)) return false;
  for (const [nodeId, stamp] of Object.entries(candidate.mutationVector)) {
    if (!isValidHlcNodeId(nodeId) || !isCanonicalHlc(stamp) || hlcNodeId(stamp) !== nodeId) return false;
  }

  for (const [key, record] of Object.entries(candidate.records)) {
    if (key === '' || dictionaryTermKey(key) !== key || !isPlainRecord(record)
      || !hasExactKeys(record, ['incarnations', 'tombstones'])) return false;
    const { incarnations, tombstones } = record as Partial<DictionaryRecord>;
    if (!isPlainRecord(incarnations) || !isPlainRecord(tombstones)) return false;

    for (const [tag, value] of Object.entries(tombstones)) {
      if (!isCanonicalHlc(tag) || !isCanonicalHlc(value)) return false;
    }
    for (const [tag, incarnation] of Object.entries(incarnations)) {
      if (!isCanonicalHlc(tag)) return false;
      if (!isValidIncarnation(incarnation)) return false;

      if ((incarnation as Partial<DictionaryIncarnation>).tag !== tag) return false;
      if (dictionaryTermKey((incarnation as DictionaryIncarnation).text) !== key) return false;
    }
  }

  for (const [key, suppression] of Object.entries(candidate.suppressed)) {
    if (key === '' || dictionaryTermKey(key) !== key || !isPlainRecord(suppression)
      || !hasExactKeys(suppression, ['text', 'stamp'])) return false;
    const { text, stamp } = suppression as Partial<DictionarySuppression>;
    if (typeof text !== 'string' || normalizeDictionaryTermText(text) !== text
      || dictionaryTermKey(text) !== key || !isCanonicalHlc(stamp)) return false;
  }
  return true;
}

function isValidIncarnation(raw: unknown): boolean {
  if (!isPlainRecord(raw)) return false;
  if (!hasExactKeys(raw, ['tag', 'text', 'textStamp', 'source', 'stage', 'counters', 'aliases', 'createdAt', 'updatedAt'])) return false;
  const value = raw as Partial<DictionaryIncarnation>;
  if (!isCanonicalHlc(value.tag) || typeof value.text !== 'string'
    || normalizeDictionaryTermText(value.text) !== value.text) return false;
  if (!isCanonicalHlc(value.textStamp)) return false;
  if (value.source !== 'manual' && value.source !== 'automatic') return false;
  if (value.stage !== 'entry' && value.stage !== 'candidate') return false;

  const createdAt = value.createdAt;
  const updatedAt = value.updatedAt;
  if (!isValidTimestamp(createdAt) || !isValidTimestamp(updatedAt)
    || updatedAt < createdAt) return false;
  if (!isValidCounter(value.counters)) return false;
  if (!isPlainRecord(value.aliases)) return false;
  for (const [aliasKey, alias] of Object.entries(value.aliases)) {
    if (!isPlainRecord(alias) || !hasExactKeys(alias, ['text', 'textStamp', 'counters', 'lastSeenAt'])) return false;
    const aliasValue = alias as Partial<SyncAliasState>;
    if (typeof aliasValue.text !== 'string' || (aliasValue.text !== ''
      && normalizeDictionaryTermText(aliasValue.text) !== aliasValue.text)
      || !isCanonicalHlc(aliasValue.textStamp)) return false;
    const counters = aliasValue.counters;
    const lastSeenAt = aliasValue.lastSeenAt;
    if (!isValidCounter(counters)) return false;
    if (isAliasRemovalMarkerKey(aliasKey)) {
      const marker = parseAliasRemovalMarkerKey(aliasKey);
      if (!marker || aliasValue.text !== ''
        || Object.keys(counters).length !== 0
        || typeof lastSeenAt !== 'number' || !Number.isSafeInteger(lastSeenAt)
        || lastSeenAt <= 0) return false;
      const referenced = hasDictionaryKey(value.aliases, marker.aliasKey)
        ? value.aliases[marker.aliasKey]
        : undefined;
      const referencedCount = referenced && hasDictionaryKey(referenced.counters, marker.counterNodeId)
        ? referenced.counters[marker.counterNodeId]
        : undefined;
      if (!referenced || typeof referencedCount !== 'number' || referencedCount < lastSeenAt) return false;
    } else {
      if (!isValidTimestamp(lastSeenAt) || aliasValue.text === ''
        || dictionaryTermKey(aliasValue.text) !== aliasKey) return false;
    }
  }
  return true;
}

function isValidCounter(raw: unknown): raw is GCounter {
  if (!isPlainRecord(raw)) return false;
  for (const [nodeId, value] of Object.entries(raw)) {
    if (!isValidHlcNodeId(nodeId) || typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return false;
  }
  return true;
}

function isValidTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
    && value >= 0 && value <= HLC_MAX_WALL_MS;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

export function listLiveIncarnations(record: DictionaryRecord): DictionaryIncarnation[] {
  return Object.values(record.incarnations)
    .filter((incarnation) => !hasDictionaryKey(record.tombstones, incarnation.tag))
    .sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
}

export function readCounterTotal(counters: GCounter): number {
  let total = 0;
  for (const value of Object.values(counters)) {
    if (Number.isFinite(value) && value > 0) total = Math.min(Number.MAX_SAFE_INTEGER, total + Math.floor(value));
  }
  return total;
}
