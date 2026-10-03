export type MobileVoiceDictionaryEntrySource = "manual" | "automatic";

export interface MobileVoiceDictionaryAlias {
  readonly text: string;
  readonly count: number;
  readonly lastSeenAt: number;
}

export interface MobileVoiceDictionaryEntry {
  readonly id: string;
  readonly text: string;
  readonly source: MobileVoiceDictionaryEntrySource;
  readonly frequency: number;
  readonly aliases: readonly MobileVoiceDictionaryAlias[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface MobileVoiceDictionaryCandidate {
  readonly text: string;
  readonly evidenceCount: number;
  readonly aliases: readonly MobileVoiceDictionaryAlias[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface MobileVoiceDictionary {
  readonly entries: readonly MobileVoiceDictionaryEntry[];
  readonly candidates: readonly MobileVoiceDictionaryCandidate[];
  readonly suppressedAutomaticTexts: readonly string[];
}

export interface MobileVoiceDictionaryAliasState {
  readonly text: string;
  readonly count: number;
}

export interface MobileVoiceDictionaryAdviceDraft {
  readonly beforeText: string;
  readonly afterText: string;
  readonly rawTranscriptText?: string;
  readonly locale?: string;
  readonly existingEntries: readonly {
    readonly term: string;
    readonly source: MobileVoiceDictionaryEntrySource;
    readonly frequency: number;
    readonly aliases: readonly MobileVoiceDictionaryAliasState[];
  }[];
  readonly existingCandidates: readonly {
    readonly term: string;
    readonly evidenceCount: number;
    readonly aliases: readonly MobileVoiceDictionaryAliasState[];
  }[];
}

export interface MobileVoiceDictionaryLearningAction {
  readonly action: "addCandidate" | "addEntry" | "updateEntry";
  readonly term: string;
  readonly aliases: readonly string[];
  readonly type: "productName" | "projectName" | "technicalTerm" | "personName" | "teamName"
    | "codeName" | "phrase" | "other";
  readonly confidence: "medium" | "high";
}

export type MobileVoiceDictionaryEditPreview =
  | { readonly kind: "update" }
  | { readonly kind: "mergeEntry"; readonly targetId: string; readonly targetText: string }
  | { readonly kind: "mergeCandidate"; readonly targetText: string; readonly evidenceCount: number };

export const MAXIMUM_MOBILE_VOICE_DICTIONARY_ENTRIES = 1_000;
export const MAXIMUM_MOBILE_VOICE_DICTIONARY_CANDIDATES = 200;
export const MAXIMUM_MOBILE_VOICE_DICTIONARY_ALIASES = 8;
export const MAXIMUM_MOBILE_VOICE_DICTIONARY_TERM_CHARACTERS = 120;
export const MAXIMUM_MOBILE_VOICE_REFINEMENT_TERMS = 200;
export const MAXIMUM_MOBILE_VOICE_REFINEMENT_CHARACTERS = 8_000;
export const MAXIMUM_MOBILE_VOICE_ADVICE_TEXT_CHARACTERS = 2_000;

const MAXIMUM_STORED_TIMESTAMP = 8_640_000_000_000_000;

export const EMPTY_MOBILE_VOICE_DICTIONARY: MobileVoiceDictionary = Object.freeze({
  entries: Object.freeze([]),
  candidates: Object.freeze([]),
  suppressedAutomaticTexts: Object.freeze([])
});

export function normalizeMobileVoiceDictionary(value: unknown): MobileVoiceDictionary | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["candidates", "entries", "suppressedAutomaticTexts"])
    || !Array.isArray(value.entries) || !Array.isArray(value.candidates)
    || !Array.isArray(value.suppressedAutomaticTexts)
    || value.entries.length > MAXIMUM_MOBILE_VOICE_DICTIONARY_ENTRIES
    || value.candidates.length > MAXIMUM_MOBILE_VOICE_DICTIONARY_CANDIDATES
    || value.suppressedAutomaticTexts.length > MAXIMUM_MOBILE_VOICE_DICTIONARY_ENTRIES) return undefined;

  const entries: MobileVoiceDictionaryEntry[] = [];
  const entryKeys = new Set<string>();
  const entryIds = new Set<string>();
  for (const raw of value.entries) {
    const entry = normalizeEntry(raw);
    if (!entry) return undefined;
    const key = mobileVoiceDictionaryTermKey(entry.text);
    if (entryKeys.has(key) || entryIds.has(entry.id)) return undefined;
    entryKeys.add(key);
    entryIds.add(entry.id);
    entries.push(entry);
  }
  const candidates: MobileVoiceDictionaryCandidate[] = [];
  const candidateKeys = new Set<string>();
  for (const raw of value.candidates) {
    const candidate = normalizeCandidate(raw);
    if (!candidate) return undefined;
    const key = mobileVoiceDictionaryTermKey(candidate.text);
    if (entryKeys.has(key) || candidateKeys.has(key)) return undefined;
    candidateKeys.add(key);
    candidates.push(candidate);
  }
  const suppressedAutomaticTexts = normalizeTermList(
    value.suppressedAutomaticTexts,
    MAXIMUM_MOBILE_VOICE_DICTIONARY_ENTRIES
  );
  if (!suppressedAutomaticTexts || suppressedAutomaticTexts.some((text) => {
    const key = mobileVoiceDictionaryTermKey(text);
    return entries.some((entry) => entry.source === "automatic" && mobileVoiceDictionaryTermKey(entry.text) === key) || candidateKeys.has(key);
  })) return undefined;
  return freezeDictionary({ entries, candidates, suppressedAutomaticTexts });
}

export function previewMobileVoiceDictionaryEdit(
  current: MobileVoiceDictionary,
  id: string,
  text: string
): MobileVoiceDictionaryEditPreview | undefined {
  const normalized = normalizeMobileVoiceDictionaryTerm(text);
  const source = current.entries.find((entry) => entry.id === id);
  if (!normalized || !source) return undefined;
  const key = mobileVoiceDictionaryTermKey(normalized);
  const target = current.entries.find((entry) => entry.id !== id
    && mobileVoiceDictionaryTermKey(entry.text) === key);
  if (target) return { kind: "mergeEntry", targetId: target.id, targetText: target.text };
  const candidate = current.candidates.find((entry) => mobileVoiceDictionaryTermKey(entry.text) === key);
  return candidate
    ? { kind: "mergeCandidate", targetText: candidate.text, evidenceCount: candidate.evidenceCount }
    : { kind: "update" };
}

export function mobileVoiceDictionaryAdviceDraft(
  dictionary: MobileVoiceDictionary,
  edit: Pick<MobileVoiceDictionaryAdviceDraft, "beforeText" | "afterText" | "rawTranscriptText" | "locale">
): MobileVoiceDictionaryAdviceDraft {
  return Object.freeze({
    beforeText: edit.beforeText.slice(0, MAXIMUM_MOBILE_VOICE_ADVICE_TEXT_CHARACTERS),
    afterText: edit.afterText.slice(0, MAXIMUM_MOBILE_VOICE_ADVICE_TEXT_CHARACTERS),
    ...(edit.rawTranscriptText === undefined ? {} : {
      rawTranscriptText: edit.rawTranscriptText.slice(0, MAXIMUM_MOBILE_VOICE_ADVICE_TEXT_CHARACTERS)
    }),
    ...(edit.locale === undefined ? {} : { locale: edit.locale }),
    existingEntries: Object.freeze(dictionary.entries.slice()
      .sort((left, right) => right.frequency - left.frequency || right.updatedAt - left.updatedAt)
      .slice(0, 80)
      .map((entry) => Object.freeze({
        term: entry.text,
        source: entry.source,
        frequency: entry.frequency,
        aliases: Object.freeze(entry.aliases.map((alias) => Object.freeze({ text: alias.text, count: alias.count })))
      }))),
    existingCandidates: Object.freeze(dictionary.candidates.slice()
      .sort((left, right) => right.evidenceCount - left.evidenceCount || right.updatedAt - left.updatedAt)
      .slice(0, 80)
      .map((candidate) => Object.freeze({
        term: candidate.text,
        evidenceCount: candidate.evidenceCount,
        aliases: Object.freeze(candidate.aliases.map((alias) => Object.freeze({ text: alias.text, count: alias.count })))
      })))
  });
}

export function normalizeMobileVoiceDictionaryTerm(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const term = value.replace(/\s+/gu, " ").trim();
  return term !== "" && term.length <= MAXIMUM_MOBILE_VOICE_DICTIONARY_TERM_CHARACTERS
    && !/[\u0000-\u001f\u007f]/u.test(term) ? term : undefined;
}

export function mobileVoiceDictionaryTermKey(value: string): string {
  return value.replace(/\s+/gu, " ").trim().toLocaleLowerCase();
}

function normalizeEntry(value: unknown): MobileVoiceDictionaryEntry | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["aliases", "createdAt", "frequency", "id", "source", "text", "updatedAt"])) {
    return undefined;
  }
  const id = typeof value.id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value.id)
    ? value.id : undefined;
  const text = normalizeMobileVoiceDictionaryTerm(value.text);
  const source = value.source === "manual" || value.source === "automatic" ? value.source : undefined;
  const frequency = positiveInteger(value.frequency);
  const aliases = normalizeAliases(value.aliases);
  const createdAt = timestamp(value.createdAt);
  const updatedAt = timestamp(value.updatedAt);
  if (!id || !text || !source || !frequency || !aliases
    || aliases.some((alias) => mobileVoiceDictionaryTermKey(alias.text) === mobileVoiceDictionaryTermKey(text))
    || createdAt === undefined || updatedAt === undefined
    || updatedAt < createdAt) return undefined;
  return Object.freeze({ id, text, source, frequency, aliases, createdAt, updatedAt });
}

function normalizeCandidate(value: unknown): MobileVoiceDictionaryCandidate | undefined {
  if (!isRecord(value) || !hasExactKeys(value, ["aliases", "createdAt", "evidenceCount", "text", "updatedAt"])) {
    return undefined;
  }
  const text = normalizeMobileVoiceDictionaryTerm(value.text);
  const evidenceCount = positiveInteger(value.evidenceCount);
  const aliases = normalizeAliases(value.aliases);
  const createdAt = timestamp(value.createdAt);
  const updatedAt = timestamp(value.updatedAt);
  if (!text || !evidenceCount || !aliases
    || aliases.some((alias) => mobileVoiceDictionaryTermKey(alias.text) === mobileVoiceDictionaryTermKey(text))
    || createdAt === undefined || updatedAt === undefined || updatedAt < createdAt) {
    return undefined;
  }
  return Object.freeze({ text, evidenceCount, aliases, createdAt, updatedAt });
}

function normalizeAliases(value: unknown): readonly MobileVoiceDictionaryAlias[] | undefined {
  if (!Array.isArray(value) || value.length > MAXIMUM_MOBILE_VOICE_DICTIONARY_ALIASES) return undefined;
  const aliases: MobileVoiceDictionaryAlias[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!isRecord(raw) || !hasExactKeys(raw, ["count", "lastSeenAt", "text"])) return undefined;
    const text = normalizeMobileVoiceDictionaryTerm(raw.text);
    const count = positiveInteger(raw.count);
    const lastSeenAt = timestamp(raw.lastSeenAt);
    if (!text || !count || lastSeenAt === undefined) return undefined;
    const key = mobileVoiceDictionaryTermKey(text);
    if (seen.has(key)) return undefined;
    seen.add(key);
    aliases.push(Object.freeze({ text, count, lastSeenAt }));
  }
  return Object.freeze(aliases);
}

function normalizeTermList(value: unknown, maximum: number): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > maximum) return undefined;
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const term = normalizeMobileVoiceDictionaryTerm(raw);
    if (!term) return undefined;
    const key = mobileVoiceDictionaryTermKey(term);
    if (seen.has(key)) return undefined;
    seen.add(key);
    terms.push(term);
  }
  return Object.freeze(terms);
}

function freezeDictionary(value: MobileVoiceDictionary): MobileVoiceDictionary {
  return Object.freeze({
    entries: Object.freeze([...value.entries]),
    candidates: Object.freeze([...value.candidates]),
    suppressedAutomaticTexts: Object.freeze([...value.suppressedAutomaticTexts])
  });
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}

function timestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAXIMUM_STORED_TIMESTAMP
    ? value : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}
