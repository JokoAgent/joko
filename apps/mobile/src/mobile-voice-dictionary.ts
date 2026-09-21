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
    return entryKeys.has(key) || candidateKeys.has(key);
  })) return undefined;
  return freezeDictionary({ entries, candidates, suppressedAutomaticTexts });
}

export function addManualMobileVoiceDictionaryTerm(
  current: MobileVoiceDictionary,
  text: string,
  now: number,
  createId: () => string
): MobileVoiceDictionary | undefined {
  const normalized = normalizeMobileVoiceDictionaryTerm(text);
  if (!normalized) return undefined;
  const key = mobileVoiceDictionaryTermKey(normalized);
  const existing = current.entries.find((entry) => mobileVoiceDictionaryTermKey(entry.text) === key);
  const candidate = current.candidates.find((item) => mobileVoiceDictionaryTermKey(item.text) === key);
  const suppressed = current.suppressedAutomaticTexts.some((item) => mobileVoiceDictionaryTermKey(item) === key);
  if (existing?.source === "manual" && existing.text === normalized && !candidate && !suppressed) return current;
  let entries: readonly MobileVoiceDictionaryEntry[];
  if (existing) {
    entries = current.entries.map((entry) => entry.id !== existing.id ? entry : Object.freeze({
      ...entry,
      text: normalized,
      source: "manual" as const,
      updatedAt: now
    }));
  } else {
    if (current.entries.length >= MAXIMUM_MOBILE_VOICE_DICTIONARY_ENTRIES) return undefined;
    entries = [...current.entries, Object.freeze({
      ...createEntry(normalized, "manual", now, createId, new Set(current.entries.map((entry) => entry.id))),
      frequency: candidate?.evidenceCount ?? 1,
      aliases: candidate?.aliases ?? Object.freeze([]),
      createdAt: Math.min(now, candidate?.createdAt ?? now)
    })];
  }
  return freezeDictionary({
    entries,
    candidates: current.candidates.filter((item) => mobileVoiceDictionaryTermKey(item.text) !== key),
    suppressedAutomaticTexts: current.suppressedAutomaticTexts.filter(
      (item) => mobileVoiceDictionaryTermKey(item) !== key
    )
  });
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

export function editMobileVoiceDictionaryEntry(
  current: MobileVoiceDictionary,
  id: string,
  text: string,
  aliasDraft: string,
  now: number
): MobileVoiceDictionary | undefined {
  if (text.trim() === "") return deleteMobileVoiceDictionaryEntry(current, id);
  const normalized = normalizeMobileVoiceDictionaryTerm(text);
  if (!normalized) return undefined;
  const index = current.entries.findIndex((entry) => entry.id === id);
  if (index < 0) return current;
  const entry = current.entries[index]!;
  const targetKey = mobileVoiceDictionaryTermKey(normalized);
  const target = current.entries.find((item, candidateIndex) => candidateIndex !== index
    && mobileVoiceDictionaryTermKey(item.text) === targetKey);
  const candidate = current.candidates.find((item) => mobileVoiceDictionaryTermKey(item.text) === targetKey);
  const aliases: MobileVoiceDictionaryAlias[] = [];
  const seen = new Set([targetKey]);
  for (const line of aliasDraft.replace(/\r\n?/gu, "\n").split("\n")) {
    if (line.trim() === "") continue;
    const aliasText = normalizeMobileVoiceDictionaryTerm(line);
    if (!aliasText) return undefined;
    const key = mobileVoiceDictionaryTermKey(aliasText);
    if (seen.has(key)) continue;
    seen.add(key);
    const existing = entry.aliases.find((alias) => mobileVoiceDictionaryTermKey(alias.text) === key);
    aliases.push(Object.freeze(existing ? { ...existing, text: aliasText }
      : { text: aliasText, count: 1, lastSeenAt: now }));
    if (aliases.length === MAXIMUM_MOBILE_VOICE_DICTIONARY_ALIASES) break;
  }
  const targetAliases = target?.aliases ?? candidate?.aliases;
  const merged = Object.freeze({
    ...entry,
    id: target?.id ?? entry.id,
    text: normalized,
    source: "manual" as const,
    frequency: boundedAdd(entry.frequency, target?.frequency ?? candidate?.evidenceCount ?? 0),
    aliases: targetAliases ? combineAliasEvidence(aliases, targetAliases, targetKey) : Object.freeze(aliases),
    createdAt: Math.min(entry.createdAt, target?.createdAt ?? candidate?.createdAt ?? entry.createdAt),
    updatedAt: Math.max(now, entry.updatedAt, target?.updatedAt ?? candidate?.updatedAt ?? 0)
  });
  return freezeDictionary({
    entries: current.entries.flatMap((item) => item.id === merged.id ? [merged] : item.id === id ? [] : [item]),
    candidates: current.candidates.filter((item) => mobileVoiceDictionaryTermKey(item.text) !== targetKey),
    suppressedAutomaticTexts: current.suppressedAutomaticTexts.filter(
      (item) => mobileVoiceDictionaryTermKey(item) !== targetKey
    )
  });
}

export function deleteMobileVoiceDictionaryEntry(
  current: MobileVoiceDictionary,
  id: string
): MobileVoiceDictionary {
  const entry = current.entries.find((item) => item.id === id);
  if (!entry) return current;
  const key = mobileVoiceDictionaryTermKey(entry.text);
  const suppressed = new Set(current.suppressedAutomaticTexts.map(mobileVoiceDictionaryTermKey));
  const suppressedAutomaticTexts = [...current.suppressedAutomaticTexts];
  if (entry.source === "automatic" && !suppressed.has(key)) suppressedAutomaticTexts.push(entry.text);
  return freezeDictionary({
    entries: current.entries.filter((item) => item.id !== id),
    candidates: current.candidates.filter((item) => mobileVoiceDictionaryTermKey(item.text) !== key),
    suppressedAutomaticTexts
  });
}

export function applyMobileVoiceDictionaryAdvice(
  current: MobileVoiceDictionary,
  actions: readonly MobileVoiceDictionaryLearningAction[],
  now: number,
  createId: () => string
): MobileVoiceDictionary {
  let entries = [...current.entries];
  let candidates = [...current.candidates];
  const suppressed = new Set(current.suppressedAutomaticTexts.map(mobileVoiceDictionaryTermKey));
  let changed = false;
  for (const action of actions.slice(0, 3)) {
    const text = normalizeMobileVoiceDictionaryTerm(action.term);
    const rawAliases = normalizeTermList(action.aliases, MAXIMUM_MOBILE_VOICE_DICTIONARY_ALIASES);
    if (!text || !rawAliases?.length) continue;
    const key = mobileVoiceDictionaryTermKey(text);
    const aliases = rawAliases.filter((alias) => mobileVoiceDictionaryTermKey(alias) !== key);
    if (aliases.length === 0) continue;
    const entryIndex = entries.findIndex((entry) => mobileVoiceDictionaryTermKey(entry.text) === key);
    const candidateIndex = candidates.findIndex((candidate) => mobileVoiceDictionaryTermKey(candidate.text) === key);
    const candidate = candidateIndex < 0 ? undefined : candidates[candidateIndex];
    if (entryIndex >= 0 || action.action === "addEntry" || action.action === "updateEntry") {
      if (entryIndex >= 0) {
        const entry = entries[entryIndex]!;
        entries[entryIndex] = Object.freeze({
          ...entry,
          frequency: boundedAdd(entry.frequency, 1),
          aliases: mergeAliases(entry.aliases, aliases, now),
          updatedAt: now
        });
      } else {
        if (suppressed.has(key) || entries.length >= MAXIMUM_MOBILE_VOICE_DICTIONARY_ENTRIES) continue;
        entries.push(Object.freeze({
          ...createEntry(text, "automatic", now, createId, new Set(entries.map((entry) => entry.id))),
          frequency: boundedAdd(candidate?.evidenceCount ?? 0, 1),
          aliases: mergeAliases(candidate?.aliases ?? [], aliases, now)
        }));
      }
      if (candidateIndex >= 0) candidates.splice(candidateIndex, 1);
      changed = true;
    } else if (!suppressed.has(key)) {
      if (candidateIndex >= 0) {
        const existing = candidates[candidateIndex]!;
        candidates[candidateIndex] = Object.freeze({
          ...existing,
          evidenceCount: boundedAdd(existing.evidenceCount, 1),
          aliases: mergeAliases(existing.aliases, aliases, now),
          updatedAt: now
        });
      } else {
        if (candidates.length >= MAXIMUM_MOBILE_VOICE_DICTIONARY_CANDIDATES) {
          candidates.sort((left, right) => right.evidenceCount - left.evidenceCount || right.updatedAt - left.updatedAt);
          candidates.length = MAXIMUM_MOBILE_VOICE_DICTIONARY_CANDIDATES - 1;
        }
        candidates.push(Object.freeze({
          text,
          evidenceCount: 1,
          aliases: mergeAliases([], aliases, now),
          createdAt: now,
          updatedAt: now
        }));
      }
      changed = true;
    }
  }
  return changed ? freezeDictionary({
    entries,
    candidates,
    suppressedAutomaticTexts: current.suppressedAutomaticTexts
  }) : current;
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

export function mobileVoiceDictionaryTermsForRefinement(
  dictionary: MobileVoiceDictionary
): readonly string[] {
  const entries = dictionary.entries.slice().sort((left, right) => {
    if (left.source !== right.source) return left.source === "manual" ? -1 : 1;
    return right.frequency - left.frequency || right.updatedAt - left.updatedAt;
  });
  const terms: string[] = [];
  let characters = 0;
  for (const entry of entries) {
    if (terms.length >= MAXIMUM_MOBILE_VOICE_REFINEMENT_TERMS
      || characters + entry.text.length > MAXIMUM_MOBILE_VOICE_REFINEMENT_CHARACTERS) break;
    terms.push(entry.text);
    characters += entry.text.length;
  }
  return Object.freeze(terms);
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

function combineAliasEvidence(
  edited: readonly MobileVoiceDictionaryAlias[],
  target: readonly MobileVoiceDictionaryAlias[],
  primaryKey: string
): readonly MobileVoiceDictionaryAlias[] {
  const combined = new Map<string, MobileVoiceDictionaryAlias>();
  for (const alias of [...target, ...edited]) {
    const key = mobileVoiceDictionaryTermKey(alias.text);
    if (key === primaryKey) continue;
    const existing = combined.get(key);
    combined.set(key, existing ? Object.freeze({
      text: alias.lastSeenAt >= existing.lastSeenAt ? alias.text : existing.text,
      count: boundedAdd(existing.count, alias.count),
      lastSeenAt: Math.max(existing.lastSeenAt, alias.lastSeenAt)
    }) : alias);
  }
  return Object.freeze([...combined.values()]
    .sort((left, right) => right.count - left.count || right.lastSeenAt - left.lastSeenAt)
    .slice(0, MAXIMUM_MOBILE_VOICE_DICTIONARY_ALIASES));
}

function mergeAliases(
  current: readonly MobileVoiceDictionaryAlias[],
  aliases: readonly string[],
  now: number
): readonly MobileVoiceDictionaryAlias[] {
  const next = [...current];
  for (const text of aliases) {
    const key = mobileVoiceDictionaryTermKey(text);
    const index = next.findIndex((alias) => mobileVoiceDictionaryTermKey(alias.text) === key);
    if (index >= 0) {
      const alias = next[index]!;
      next[index] = Object.freeze({ ...alias, count: boundedAdd(alias.count, 1), lastSeenAt: now });
    } else {
      next.push(Object.freeze({ text, count: 1, lastSeenAt: now }));
    }
  }
  return Object.freeze(next.sort((left, right) => right.count - left.count || right.lastSeenAt - left.lastSeenAt)
    .slice(0, MAXIMUM_MOBILE_VOICE_DICTIONARY_ALIASES));
}

function createEntry(
  text: string,
  source: MobileVoiceDictionaryEntrySource,
  now: number,
  createId: () => string,
  occupiedIds: ReadonlySet<string>
): MobileVoiceDictionaryEntry {
  const candidateId = createId();
  const base = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(candidateId) && !occupiedIds.has(candidateId)
    ? candidateId : `dictionary-${Math.max(0, Math.floor(now)).toString(36)}`;
  let id = base;
  for (let suffix = 1; occupiedIds.has(id); suffix += 1) id = `${base}-${suffix}`;
  return Object.freeze({ id, text, source, frequency: 1, aliases: Object.freeze([]), createdAt: now, updatedAt: now });
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

function boundedAdd(left: number, right: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}
