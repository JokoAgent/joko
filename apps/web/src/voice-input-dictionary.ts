import type {
  VoiceInputDictionaryAdviceDraft,
  VoiceInputDictionaryLearningActionView
} from "./model.js";

export type VoiceInputDictionaryEntrySource = "manual" | "automatic";

export interface VoiceInputDictionaryAlias {
  readonly text: string;
  readonly count: number;
  readonly lastSeenAt: number;
}

export interface VoiceInputDictionaryEntry {
  readonly id: string;
  readonly text: string;
  readonly source: VoiceInputDictionaryEntrySource;
  readonly frequency: number;
  readonly aliases: readonly VoiceInputDictionaryAlias[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface VoiceInputDictionaryCandidate {
  readonly text: string;
  readonly evidenceCount: number;
  readonly aliases: readonly VoiceInputDictionaryAlias[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface VoiceInputDictionaryState {
  readonly entries: readonly VoiceInputDictionaryEntry[];
  readonly candidates: readonly VoiceInputDictionaryCandidate[];
  readonly suppressedAutomaticTexts: readonly string[];
}

export const MAXIMUM_VOICE_DICTIONARY_ENTRIES = 1_000;
export const MAXIMUM_VOICE_DICTIONARY_CANDIDATES = 200;
export const MAXIMUM_VOICE_DICTIONARY_ALIASES = 8;
export const MAXIMUM_VOICE_DICTIONARY_TERM_CHARACTERS = 120;
export const MAXIMUM_REFINEMENT_DICTIONARY_TERMS = 200;
export const MAXIMUM_REFINEMENT_DICTIONARY_CHARACTERS = 8_000;

const MAXIMUM_STORED_TIMESTAMP = 8_640_000_000_000_000;
let generatedIdSequence = 0;

export const EMPTY_VOICE_INPUT_DICTIONARY: VoiceInputDictionaryState = Object.freeze({
  entries: Object.freeze([]),
  candidates: Object.freeze([]),
  suppressedAutomaticTexts: Object.freeze([])
});

export function normalizeVoiceInputDictionaryState(
  value: unknown
): VoiceInputDictionaryState | undefined {
  if (!isRecord(value) || !Array.isArray(value["entries"]) || !Array.isArray(value["candidates"])
    || !Array.isArray(value["suppressedAutomaticTexts"])) return undefined;
  if (value["entries"].length > MAXIMUM_VOICE_DICTIONARY_ENTRIES
    || value["candidates"].length > MAXIMUM_VOICE_DICTIONARY_CANDIDATES
    || value["suppressedAutomaticTexts"].length > MAXIMUM_VOICE_DICTIONARY_ENTRIES) return undefined;

  const entries: VoiceInputDictionaryEntry[] = [];
  const entryKeys = new Set<string>();
  for (const item of value["entries"]) {
    const entry = normalizeEntry(item);
    if (entry === undefined) return undefined;
    const key = voiceDictionaryTermKey(entry.text);
    if (entryKeys.has(key)) continue;
    entryKeys.add(key);
    entries.push(entry);
  }
  const candidates: VoiceInputDictionaryCandidate[] = [];
  const candidateKeys = new Set<string>();
  for (const item of value["candidates"]) {
    const candidate = normalizeCandidate(item);
    if (candidate === undefined) return undefined;
    const key = voiceDictionaryTermKey(candidate.text);
    if (entryKeys.has(key) || candidateKeys.has(key)) continue;
    candidateKeys.add(key);
    candidates.push(candidate);
  }
  const suppressedAutomaticTexts = normalizeTermList(value["suppressedAutomaticTexts"], MAXIMUM_VOICE_DICTIONARY_ENTRIES);
  if (suppressedAutomaticTexts === undefined) return undefined;
  return freezeState({ entries, candidates, suppressedAutomaticTexts });
}

export function mergeManualVoiceDictionaryTerms(
  current: VoiceInputDictionaryState,
  terms: readonly string[],
  now = Date.now(),
  createId: () => string = () => createVoiceDictionaryId(now)
): VoiceInputDictionaryState | undefined {
  const normalized = normalizeTermList(terms, MAXIMUM_VOICE_DICTIONARY_ENTRIES);
  if (normalized === undefined) return undefined;
  const entries = [...current.entries];
  const candidateKeys = new Set(normalized.map(voiceDictionaryTermKey));
  for (const text of normalized) {
    const key = voiceDictionaryTermKey(text);
    const index = entries.findIndex((entry) => voiceDictionaryTermKey(entry.text) === key);
    if (index >= 0) {
      const entry = entries[index]!;
      if (entry.text !== text || entry.source !== "manual") {
        entries[index] = Object.freeze({ ...entry, text, source: "manual", updatedAt: now });
      }
      continue;
    }
    if (entries.length >= MAXIMUM_VOICE_DICTIONARY_ENTRIES) return undefined;
    entries.push(createEntry(text, "manual", now, createId));
  }
  const filtered = entries.filter((entry) => entry.source === "automatic" || candidateKeys.has(voiceDictionaryTermKey(entry.text)));
  return freezeState({
    entries: filtered,
    candidates: current.candidates.filter((candidate) => !candidateKeys.has(voiceDictionaryTermKey(candidate.text))),
    suppressedAutomaticTexts: current.suppressedAutomaticTexts.filter((text) => !candidateKeys.has(voiceDictionaryTermKey(text)))
  });
}

export function addManualVoiceDictionaryTerm(
  current: VoiceInputDictionaryState,
  text: string,
  now = Date.now(),
  createId?: () => string
): VoiceInputDictionaryState | undefined {
  const manual = current.entries.filter((entry) => entry.source === "manual").map((entry) => entry.text);
  return mergeManualVoiceDictionaryTerms(current, [...manual, text], now, createId);
}

export function renameVoiceDictionaryEntry(
  current: VoiceInputDictionaryState,
  id: string,
  text: string,
  now = Date.now()
): VoiceInputDictionaryState | undefined {
  const normalized = normalizeVoiceDictionaryTerm(text);
  if (normalized === undefined) return undefined;
  const index = current.entries.findIndex((entry) => entry.id === id);
  if (index < 0) return current;
  const duplicate = current.entries.some((entry, candidateIndex) => candidateIndex !== index
    && voiceDictionaryTermKey(entry.text) === voiceDictionaryTermKey(normalized));
  if (duplicate) return undefined;
  const entries = [...current.entries];
  entries[index] = Object.freeze({ ...entries[index]!, text: normalized, updatedAt: now });
  return freezeState({ ...current, entries });
}

export function deleteVoiceDictionaryEntry(
  current: VoiceInputDictionaryState,
  id: string
): VoiceInputDictionaryState {
  const entry = current.entries.find((candidate) => candidate.id === id);
  if (entry === undefined) return current;
  const key = voiceDictionaryTermKey(entry.text);
  const suppressed = new Set(current.suppressedAutomaticTexts.map(voiceDictionaryTermKey));
  const suppressedAutomaticTexts = [...current.suppressedAutomaticTexts];
  if (entry.source === "automatic" && !suppressed.has(key)) suppressedAutomaticTexts.push(entry.text);
  return freezeState({
    entries: current.entries.filter((candidate) => candidate.id !== id),
    candidates: current.candidates.filter((candidate) => voiceDictionaryTermKey(candidate.text) !== key),
    suppressedAutomaticTexts
  });
}

export function applyVoiceDictionaryAdvice(
  current: VoiceInputDictionaryState,
  actions: readonly VoiceInputDictionaryLearningActionView[],
  now = Date.now(),
  createId: () => string = () => createVoiceDictionaryId(now)
): VoiceInputDictionaryState {
  if (actions.length === 0) return current;
  let entries = [...current.entries];
  let candidates = [...current.candidates];
  const suppressed = new Set(current.suppressedAutomaticTexts.map(voiceDictionaryTermKey));
  let changed = false;

  for (const action of actions.slice(0, 3)) {
    const text = normalizeVoiceDictionaryTerm(action.term);
    const aliases = normalizeTermList(action.aliases, MAXIMUM_VOICE_DICTIONARY_ALIASES);
    if (text === undefined || aliases === undefined || aliases.length === 0) continue;
    const key = voiceDictionaryTermKey(text);
    const entryIndex = entries.findIndex((entry) => voiceDictionaryTermKey(entry.text) === key);
    const candidateIndex = candidates.findIndex((candidate) => voiceDictionaryTermKey(candidate.text) === key);
    const candidate = candidateIndex < 0 ? undefined : candidates[candidateIndex];

    if (entryIndex >= 0 || action.action === "addEntry" || action.action === "updateEntry") {
      if (entryIndex >= 0) {
        const entry = entries[entryIndex]!;
        entries[entryIndex] = Object.freeze({
          ...entry,
          frequency: entry.frequency + 1,
          aliases: mergeAliases(entry.aliases, aliases, now),
          updatedAt: now
        });
      } else {
        if (suppressed.has(key) || entries.length >= MAXIMUM_VOICE_DICTIONARY_ENTRIES) continue;
        entries.push(Object.freeze({
          ...createEntry(text, "automatic", now, createId),
          frequency: (candidate?.evidenceCount ?? 0) + 1,
          aliases: mergeAliases(candidate?.aliases ?? [], aliases, now)
        }));
      }
      if (candidateIndex >= 0) candidates.splice(candidateIndex, 1);
      changed = true;
      continue;
    }

    if (suppressed.has(key)) continue;
    if (candidateIndex >= 0) {
      const existing = candidates[candidateIndex]!;
      candidates[candidateIndex] = Object.freeze({
        ...existing,
        evidenceCount: existing.evidenceCount + 1,
        aliases: mergeAliases(existing.aliases, aliases, now),
        updatedAt: now
      });
      changed = true;
      continue;
    }
    if (candidates.length >= MAXIMUM_VOICE_DICTIONARY_CANDIDATES) {
      candidates.sort((left, right) => right.evidenceCount - left.evidenceCount || right.updatedAt - left.updatedAt);
      candidates.length = MAXIMUM_VOICE_DICTIONARY_CANDIDATES - 1;
    }
    candidates.push(Object.freeze({
      text,
      evidenceCount: 1,
      aliases: mergeAliases([], aliases, now),
      createdAt: now,
      updatedAt: now
    }));
    changed = true;
  }
  return changed ? freezeState({ entries, candidates, suppressedAutomaticTexts: current.suppressedAutomaticTexts }) : current;
}

export function voiceDictionaryAdviceDraft(
  state: VoiceInputDictionaryState,
  edit: Pick<VoiceInputDictionaryAdviceDraft, "beforeText" | "afterText" | "rawTranscriptText" | "locale">
): VoiceInputDictionaryAdviceDraft {
  return Object.freeze({
    ...edit,
    existingEntries: Object.freeze(state.entries
      .slice()
      .sort((left, right) => right.frequency - left.frequency || right.updatedAt - left.updatedAt)
      .slice(0, 80)
      .map((entry) => Object.freeze({
        term: entry.text,
        source: entry.source,
        frequency: entry.frequency,
        aliases: Object.freeze(entry.aliases.map((alias) => Object.freeze({ text: alias.text, count: alias.count })))
      }))),
    existingCandidates: Object.freeze(state.candidates
      .slice()
      .sort((left, right) => right.evidenceCount - left.evidenceCount || right.updatedAt - left.updatedAt)
      .slice(0, 80)
      .map((candidate) => Object.freeze({
        term: candidate.text,
        evidenceCount: candidate.evidenceCount,
        aliases: Object.freeze(candidate.aliases.map((alias) => Object.freeze({ text: alias.text, count: alias.count })))
      })))
  });
}

export function voiceDictionaryTermsForRefinement(
  state: VoiceInputDictionaryState
): readonly string[] {
  const entries = state.entries.slice().sort((left, right) => {
    if (left.source !== right.source) return left.source === "manual" ? -1 : 1;
    return right.frequency - left.frequency || right.updatedAt - left.updatedAt;
  });
  const terms: string[] = [];
  let characters = 0;
  for (const entry of entries) {
    if (terms.length >= MAXIMUM_REFINEMENT_DICTIONARY_TERMS
      || characters + entry.text.length > MAXIMUM_REFINEMENT_DICTIONARY_CHARACTERS) break;
    terms.push(entry.text);
    characters += entry.text.length;
  }
  return Object.freeze(terms);
}

export function voiceDictionaryTermKey(value: string): string {
  return value.replace(/\s+/gu, " ").trim().toLocaleLowerCase();
}

export function normalizeVoiceDictionaryTerm(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const term = value.replace(/\s+/gu, " ").trim();
  if (term === "" || term.length > MAXIMUM_VOICE_DICTIONARY_TERM_CHARACTERS
    || /[\u0000-\u001f\u007f]/u.test(term)) return undefined;
  return term;
}

function normalizeEntry(value: unknown): VoiceInputDictionaryEntry | undefined {
  if (!isRecord(value)) return undefined;
  const id = normalizeId(value["id"]);
  const text = normalizeVoiceDictionaryTerm(value["text"]);
  const source = value["source"] === "manual" || value["source"] === "automatic" ? value["source"] : undefined;
  const frequency = normalizePositiveInteger(value["frequency"]);
  const aliases = normalizeAliases(value["aliases"]);
  const createdAt = normalizeTimestamp(value["createdAt"]);
  const updatedAt = normalizeTimestamp(value["updatedAt"]);
  if (id === undefined || text === undefined || source === undefined || frequency === undefined
    || aliases === undefined || createdAt === undefined || updatedAt === undefined || updatedAt < createdAt) return undefined;
  return Object.freeze({ id, text, source, frequency, aliases, createdAt, updatedAt });
}

function normalizeCandidate(value: unknown): VoiceInputDictionaryCandidate | undefined {
  if (!isRecord(value)) return undefined;
  const text = normalizeVoiceDictionaryTerm(value["text"]);
  const evidenceCount = normalizePositiveInteger(value["evidenceCount"]);
  const aliases = normalizeAliases(value["aliases"]);
  const createdAt = normalizeTimestamp(value["createdAt"]);
  const updatedAt = normalizeTimestamp(value["updatedAt"]);
  if (text === undefined || evidenceCount === undefined || aliases === undefined
    || createdAt === undefined || updatedAt === undefined || updatedAt < createdAt) return undefined;
  return Object.freeze({ text, evidenceCount, aliases, createdAt, updatedAt });
}

function normalizeAliases(value: unknown): readonly VoiceInputDictionaryAlias[] | undefined {
  if (!Array.isArray(value) || value.length > MAXIMUM_VOICE_DICTIONARY_ALIASES) return undefined;
  const aliases: VoiceInputDictionaryAlias[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) return undefined;
    const text = normalizeVoiceDictionaryTerm(item["text"]);
    const count = normalizePositiveInteger(item["count"]);
    const lastSeenAt = normalizeTimestamp(item["lastSeenAt"]);
    if (text === undefined || count === undefined || lastSeenAt === undefined) return undefined;
    const key = voiceDictionaryTermKey(text);
    if (seen.has(key)) continue;
    seen.add(key);
    aliases.push(Object.freeze({ text, count, lastSeenAt }));
  }
  return Object.freeze(aliases);
}

function normalizeTermList(value: unknown, maximum: number): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > maximum) return undefined;
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const term = normalizeVoiceDictionaryTerm(item);
    if (term === undefined) return undefined;
    const key = voiceDictionaryTermKey(term);
    if (seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
  }
  return Object.freeze(terms);
}

function mergeAliases(
  current: readonly VoiceInputDictionaryAlias[],
  aliases: readonly string[],
  now: number
): readonly VoiceInputDictionaryAlias[] {
  const next = [...current];
  for (const text of aliases) {
    const key = voiceDictionaryTermKey(text);
    const index = next.findIndex((alias) => voiceDictionaryTermKey(alias.text) === key);
    if (index >= 0) {
      const alias = next[index]!;
      next[index] = Object.freeze({ ...alias, count: alias.count + 1, lastSeenAt: now });
    } else {
      next.push(Object.freeze({ text, count: 1, lastSeenAt: now }));
    }
  }
  return Object.freeze(next
    .sort((left, right) => right.count - left.count || right.lastSeenAt - left.lastSeenAt)
    .slice(0, MAXIMUM_VOICE_DICTIONARY_ALIASES));
}

function createEntry(
  text: string,
  source: VoiceInputDictionaryEntrySource,
  now: number,
  createId: () => string
): VoiceInputDictionaryEntry {
  return Object.freeze({
    id: normalizeId(createId()) ?? createVoiceDictionaryId(now),
    text,
    source,
    frequency: 1,
    aliases: Object.freeze([]),
    createdAt: now,
    updatedAt: now
  });
}

function freezeState(value: {
  readonly entries: readonly VoiceInputDictionaryEntry[];
  readonly candidates: readonly VoiceInputDictionaryCandidate[];
  readonly suppressedAutomaticTexts: readonly string[];
}): VoiceInputDictionaryState {
  return Object.freeze({
    entries: Object.freeze([...value.entries]),
    candidates: Object.freeze([...value.candidates]),
    suppressedAutomaticTexts: Object.freeze([...value.suppressedAutomaticTexts])
  });
}

function createVoiceDictionaryId(now: number): string {
  generatedIdSequence = (generatedIdSequence + 1) % 1_000_000;
  const random = globalThis.crypto?.randomUUID?.();
  return random ?? `dictionary-${Math.max(0, Math.floor(now)).toString(36)}-${generatedIdSequence.toString(36)}`;
}

function normalizeId(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value) ? value : undefined;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}

function normalizeTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAXIMUM_STORED_TIMESTAMP
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
