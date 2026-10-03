import type { VoiceInputDictionaryReadOnlySnapshot } from "./gen/joko/v1/voice_pb.js";

export const MAXIMUM_VOICE_DICTIONARY_READONLY_BYTES = 3_600_000;

export interface VoiceDictionaryReadOnlyView {
  readonly revision: bigint;
  readonly syncEnabled: boolean;
  readonly entries: readonly {
    readonly text: string;
    readonly frequency: number;
    readonly aliases: readonly { readonly text: string; readonly count: number }[];
  }[];
  readonly stateVector: Readonly<Record<string, string>>;
}

export interface VoiceDictionaryReadOnlyApi {
  getVoiceInputDictionaryReadOnly(signal?: AbortSignal): Promise<VoiceDictionaryReadOnlyView>;
  watchVoiceInputDictionaryReadOnly(signal: AbortSignal): AsyncIterable<VoiceDictionaryReadOnlyView>;
}

/** Required causal observations, not a writable replica or a maximum-clock shortcut. */
export function projectVoiceDictionaryReadOnly(value: VoiceInputDictionaryReadOnlySnapshot | undefined): VoiceDictionaryReadOnlyView {
  if (!value || !value.stateVector || value.entries.length > 1_000 || value.stateVector.versions.length > 100_000
    || value.entries.some((entry) => entry.aliases.length > 8)) throw invalid();
  const stateVector: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const version of value.stateVector.versions) {
    if (Object.prototype.hasOwnProperty.call(stateVector, version.nodeId)) throw invalid();
    stateVector[version.nodeId] = version.stamp;
  }
  return readVoiceDictionaryReadOnlyView({
    revision: value.revision, syncEnabled: value.syncEnabled, stateVector,
    entries: value.entries.map((entry) => ({ text: entry.text, frequency: count(entry.frequency),
      aliases: entry.aliases.map((alias) => ({ text: alias.text, count: count(alias.count) })) }))
  });
}

/** The same current-v1 validation owns network and disk projections. */
export function readVoiceDictionaryReadOnlyView(raw: unknown): VoiceDictionaryReadOnlyView {
  const value = record(raw, ["revision", "syncEnabled", "entries", "stateVector"]);
  if (typeof value.revision !== "bigint" || value.revision < 1n || value.revision > BigInt(Number.MAX_SAFE_INTEGER)
    || typeof value.syncEnabled !== "boolean" || !Array.isArray(value.entries) || value.entries.length > 1_000
    || (!value.syncEnabled && value.entries.length !== 0)) throw invalid();
  const keys = new Set<string>();
  const entries = value.entries.map((rawEntry) => {
    const entry = record(rawEntry, ["text", "frequency", "aliases"]);
    const text = term(entry.text);
    const key = text.toLowerCase();
    if (keys.has(key) || !Array.isArray(entry.aliases) || entry.aliases.length > 8) throw invalid();
    keys.add(key);
    const aliasKeys = new Set<string>([key]);
    const aliases = entry.aliases.map((rawAlias) => {
      const alias = record(rawAlias, ["text", "count"]);
      const aliasText = term(alias.text);
      const aliasKey = aliasText.toLowerCase();
      if (aliasKeys.has(aliasKey)) throw invalid();
      aliasKeys.add(aliasKey);
      return Object.freeze({ text: aliasText, count: positive(alias.count) });
    });
    return Object.freeze({ text, frequency: positive(entry.frequency), aliases: Object.freeze(aliases) });
  });
  const rawVector = record(value.stateVector);
  const stateVector: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [nodeId, stamp] of Object.entries(rawVector)) {
    if (!nodeId || nodeId.length > 128 || nodeId.includes(".") || /[\u0000-\u001f\u007f]/u.test(nodeId)
      || typeof stamp !== "string" || !/^[a-z0-9]{10}\.[a-z0-9]{4}\./u.test(stamp) || stamp.slice(16) !== nodeId) throw invalid();
    stateVector[nodeId] = stamp;
  }
  const result = { revision: value.revision, syncEnabled: value.syncEnabled,
    entries: Object.freeze(entries), stateVector: Object.freeze(stateVector) };
  if (new TextEncoder().encode(JSON.stringify({ ...result, revision: result.revision.toString(10) })).byteLength
    > MAXIMUM_VOICE_DICTIONARY_READONLY_BYTES) throw invalid();
  return Object.freeze(result);
}

export function voiceDictionaryVectorDominates(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  return Object.entries(b).every(([nodeId, stamp]) => Object.prototype.hasOwnProperty.call(a, nodeId) && a[nodeId]! >= stamp);
}

/** Revision is durable and host-local; cross-host freshness must use vectors instead. */
export function isNewerSameHostVoiceDictionary(candidate: VoiceDictionaryReadOnlyView, current: VoiceDictionaryReadOnlyView): boolean {
  return candidate.revision > current.revision && voiceDictionaryVectorDominates(candidate.stateVector, current.stateVector);
}

function record(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw invalid();
  const own = Object.keys(value);
  if (keys && (own.length !== keys.length || keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key)))) throw invalid();
  return value as Record<string, unknown>;
}
function term(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 120 || /[\u0000-\u001f\u007f]/u.test(value)
    || value.replace(/\s+/gu, " ").trim() !== value) throw invalid();
  return value;
}
function positive(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw invalid();
  return value;
}
function count(value: bigint): number {
  if (value < 1n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid();
  return Number(value);
}
function invalid(): Error { return new Error("The read-only dictionary projection is invalid."); }
