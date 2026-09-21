import type { MobilePlainStorageDriver } from "./connection-storage";
import {
  EMPTY_MOBILE_VOICE_DICTIONARY,
  addManualMobileVoiceDictionaryTerm,
  applyMobileVoiceDictionaryAdvice,
  deleteMobileVoiceDictionaryEntry,
  editMobileVoiceDictionaryEntry,
  normalizeMobileVoiceDictionary,
  normalizeMobileVoiceDictionaryTerm,
  previewMobileVoiceDictionaryEdit,
  type MobileVoiceDictionary,
  type MobileVoiceDictionaryEditPreview,
  type MobileVoiceDictionaryLearningAction
} from "./mobile-voice-dictionary";

export const MAXIMUM_MOBILE_VOICE_REFINEMENT_INSTRUCTION_CHARACTERS = 1_000;
export const MAXIMUM_MOBILE_VOICE_DICTIONARY_HISTORY = 100;

export type MobileVoiceDictionaryHistoryKind = "manualAdd" | "manualEdit" | "manualMerge"
  | "manualDelete" | "automaticLearning";

export interface MobileVoiceDictionaryHistoryEntry {
  readonly id: string;
  readonly kind: MobileVoiceDictionaryHistoryKind;
  readonly terms: readonly string[];
  readonly occurredAt: number;
}

export interface MobileVoiceDictionaryUsage {
  readonly voiceStarts: number;
  readonly correctionObservations: number;
  readonly lastVoiceStartedAt: number | null;
  readonly lastCorrectionAt: number | null;
}

export interface MobileVoiceDictionaryDocument {
  readonly version: 1;
  readonly revision: number;
  readonly dictionaryRevision: number;
  readonly refinementInstructions: string;
  readonly autoLearningEnabled: boolean;
  readonly dictionary: MobileVoiceDictionary;
  readonly usage: MobileVoiceDictionaryUsage;
  readonly history: readonly MobileVoiceDictionaryHistoryEntry[];
}

export interface MobileVoiceDictionaryStoreState {
  readonly status: "loading" | "ready" | "error";
  readonly document: MobileVoiceDictionaryDocument;
  readonly saving: boolean;
  readonly error?: string;
}

export type MobileVoiceDictionaryEditOutcome = "updated" | "mergedEntry" | "mergedCandidate" | "deleted" | "unchanged";

const STORAGE_KEY = "joko.mobile.voiceDictionary.v1";
const MAXIMUM_STORED_TIMESTAMP = 8_640_000_000_000_000;

export class MobileVoiceDictionaryStore {
  #state: MobileVoiceDictionaryStoreState = {
    status: "loading",
    document: emptyDocument(),
    saving: false
  };
  #listeners = new Set<() => void>();
  #hydrate?: Promise<void>;
  #queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly storage: Pick<MobilePlainStorageDriver, "getItem" | "setItem">,
    private readonly now: () => number,
    private readonly createId: () => string
  ) {}

  get snapshot(): MobileVoiceDictionaryStoreState { return this.#state; }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  hydrate(): Promise<void> {
    if (this.#state.status !== "loading") return Promise.resolve();
    this.#hydrate ??= this.#read();
    return this.#hydrate;
  }

  retryHydrate(): Promise<void> {
    if (this.#state.status !== "error" || this.#state.saving) return Promise.resolve();
    this.#hydrate = undefined;
    this.#publish({ status: "loading", document: emptyDocument(), saving: false });
    return this.hydrate();
  }

  async reset(): Promise<void> {
    await this.#enqueue(async () => {
      const document = emptyDocument(boundedIncrement(this.#state.document.revision));
      this.#publish({ ...this.#state, saving: true, error: undefined });
      try {
        await this.storage.setItem(STORAGE_KEY, JSON.stringify(document));
        this.#publish({ status: "ready", document, saving: false });
      } catch (cause) {
        const error = storageError("The device-local voice dictionary could not be reset", cause);
        this.#publish({ ...this.#state, saving: false, error });
        throw new Error(error);
      }
    });
  }

  setRefinementInstructions(value: string): Promise<void> {
    const instructions = normalizeInstructions(value);
    if (instructions === undefined) return Promise.reject(new Error("The refinement instruction is invalid."));
    return this.#mutate((current) => current.refinementInstructions === instructions ? current : Object.freeze({
      ...current,
      revision: current.revision + 1,
      dictionaryRevision: current.dictionaryRevision + 1,
      refinementInstructions: instructions
    }));
  }

  setAutoLearningEnabled(enabled: boolean): Promise<void> {
    if (typeof enabled !== "boolean") return Promise.reject(new Error("The automatic-learning preference is invalid."));
    return this.#mutate((current) => current.autoLearningEnabled === enabled ? current : Object.freeze({
      ...current,
      revision: current.revision + 1,
      dictionaryRevision: current.dictionaryRevision + 1,
      autoLearningEnabled: enabled
    }));
  }

  addManualTerm(text: string): Promise<void> {
    return this.#mutate((current) => {
      const now = this.#now();
      const next = addManualMobileVoiceDictionaryTerm(current.dictionary, text, now, this.createId);
      if (!next) throw new Error("The dictionary term is invalid or the dictionary is full.");
      if (next === current.dictionary) return current;
      return this.#withDictionary(current, next, "manualAdd", [normalizeMobileVoiceDictionaryTerm(text)!], now);
    });
  }

  editEntry(id: string, text: string, aliasDraft: string): Promise<MobileVoiceDictionaryEditOutcome> {
    let outcome: MobileVoiceDictionaryEditOutcome = "unchanged";
    return this.#mutate((current) => {
      const source = current.dictionary.entries.find((entry) => entry.id === id);
      if (!source) return current;
      const preview = previewMobileVoiceDictionaryEdit(current.dictionary, id, text);
      const now = this.#now();
      const next = editMobileVoiceDictionaryEntry(current.dictionary, id, text, aliasDraft, now);
      if (!next) throw new Error("The dictionary edit is invalid.");
      if (next === current.dictionary) return current;
      outcome = text.trim() === "" ? "deleted"
        : preview?.kind === "mergeEntry" ? "mergedEntry"
          : preview?.kind === "mergeCandidate" ? "mergedCandidate" : "updated";
      const term = normalizeMobileVoiceDictionaryTerm(text) ?? source.text;
      return this.#withDictionary(current, next,
        outcome === "deleted" ? "manualDelete"
          : outcome === "mergedEntry" || outcome === "mergedCandidate" ? "manualMerge" : "manualEdit",
        [term], now);
    }).then(() => outcome);
  }

  deleteEntry(id: string): Promise<void> {
    return this.#mutate((current) => {
      const source = current.dictionary.entries.find((entry) => entry.id === id);
      if (!source) return current;
      const now = this.#now();
      return this.#withDictionary(
        current,
        deleteMobileVoiceDictionaryEntry(current.dictionary, id),
        "manualDelete",
        [source.text],
        now
      );
    });
  }

  recordVoiceStart(): Promise<void> {
    return this.#mutate((current) => {
      const now = this.#now();
      return Object.freeze({
        ...current,
        revision: current.revision + 1,
        usage: Object.freeze({
          ...current.usage,
          voiceStarts: boundedIncrement(current.usage.voiceStarts),
          lastVoiceStartedAt: now
        })
      });
    });
  }

  applyAdvice(
    actions: readonly MobileVoiceDictionaryLearningAction[],
    expectedDictionaryRevision: number,
    guard: () => boolean
  ): Promise<boolean> {
    let accepted = false;
    let changed = false;
    return this.#mutate((current) => {
      if (!guard() || !current.autoLearningEnabled || current.dictionaryRevision !== expectedDictionaryRevision) {
        return current;
      }
      accepted = true;
      if (actions.length === 0) return current;
      const now = this.#now();
      const dictionary = applyMobileVoiceDictionaryAdvice(current.dictionary, actions, now, this.createId);
      if (dictionary === current.dictionary) return current;
      const terms = actions.slice(0, 3)
        .map((action) => normalizeMobileVoiceDictionaryTerm(action.term))
        .filter((term): term is string => term !== undefined);
      const history = appendHistory(current.history, {
        id: this.#id(),
        kind: "automaticLearning",
        terms,
        occurredAt: now
      });
      changed = true;
      return Object.freeze({
        ...current,
        revision: current.revision + 1,
        dictionaryRevision: current.dictionaryRevision + 1,
        dictionary,
        usage: Object.freeze({
          ...current.usage,
          correctionObservations: boundedIncrement(current.usage.correctionObservations),
          lastCorrectionAt: now
        }),
        history
      });
    }, guard).then(() => accepted && (!changed || this.#state.status === "ready"
      && this.#state.document.dictionaryRevision === expectedDictionaryRevision + 1));
  }

  previewEdit(id: string, text: string): MobileVoiceDictionaryEditPreview | undefined {
    return previewMobileVoiceDictionaryEdit(this.#state.document.dictionary, id, text);
  }

  async #read(): Promise<void> {
    try {
      const raw = await this.storage.getItem(STORAGE_KEY);
      const document = raw === null ? emptyDocument() : parseDocument(raw);
      this.#publish({ status: "ready", document, saving: false });
    } catch (cause) {
      this.#publish({
        status: "error",
        document: emptyDocument(),
        saving: false,
        error: storageError("The saved device-local voice dictionary is unavailable", cause)
      });
    }
  }

  #mutate(
    update: (current: MobileVoiceDictionaryDocument) => MobileVoiceDictionaryDocument,
    guard?: () => boolean
  ): Promise<void> {
    return this.#enqueue(async () => {
      if (this.#state.status === "loading") await this.hydrate();
      if (this.#state.status !== "ready") throw new Error("The device-local voice dictionary is unavailable.");
      const previous = this.#state.document;
      if (guard && !guard()) return;
      const next = update(previous);
      if (next === previous) return;
      this.#publish({ status: "ready", document: previous, saving: true });
      try {
        await this.storage.setItem(STORAGE_KEY, JSON.stringify(next));
        if (guard && !guard()) {
          await this.storage.setItem(STORAGE_KEY, JSON.stringify(previous));
          this.#publish({ status: "ready", document: previous, saving: false });
          return;
        }
        this.#publish({ status: "ready", document: next, saving: false });
      } catch (cause) {
        const error = storageError("The device-local voice dictionary could not be saved", cause);
        this.#publish({ status: "ready", document: previous, saving: false, error });
        throw new Error(error);
      }
    });
  }

  #withDictionary(
    current: MobileVoiceDictionaryDocument,
    dictionary: MobileVoiceDictionary,
    kind: MobileVoiceDictionaryHistoryKind,
    terms: readonly string[],
    now: number
  ): MobileVoiceDictionaryDocument {
    return Object.freeze({
      ...current,
      revision: current.revision + 1,
      dictionaryRevision: current.dictionaryRevision + 1,
      dictionary,
      history: appendHistory(current.history, { id: this.#id(), kind, terms, occurredAt: now })
    });
  }

  #id(): string {
    const candidate = this.createId();
    return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(candidate)
      ? candidate : `voice-history-${this.#now().toString(36)}`;
  }

  #now(): number {
    const value = this.now();
    return Number.isSafeInteger(value) && value >= 0 && value <= MAXIMUM_STORED_TIMESTAMP ? value : 0;
  }

  #enqueue(action: () => Promise<void>): Promise<void> {
    const result = this.#queue.catch(() => undefined).then(action);
    this.#queue = result.catch(() => undefined);
    return result;
  }

  #publish(state: MobileVoiceDictionaryStoreState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
}

function emptyDocument(revision = 0): MobileVoiceDictionaryDocument {
  return Object.freeze({
    version: 1,
    revision,
    dictionaryRevision: revision,
    refinementInstructions: "",
    autoLearningEnabled: true,
    dictionary: EMPTY_MOBILE_VOICE_DICTIONARY,
    usage: Object.freeze({
      voiceStarts: 0,
      correctionObservations: 0,
      lastVoiceStartedAt: null,
      lastCorrectionAt: null
    }),
    history: Object.freeze([])
  });
}

function parseDocument(raw: string): MobileVoiceDictionaryDocument {
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value) || !hasExactKeys(value, [
    "autoLearningEnabled", "dictionary", "dictionaryRevision", "history", "refinementInstructions",
    "revision", "usage", "version"
  ]) || value.version !== 1 || typeof value.autoLearningEnabled !== "boolean") throw new Error("invalid current-v1 record");
  const revision = nonNegativeInteger(value.revision);
  const dictionaryRevision = nonNegativeInteger(value.dictionaryRevision);
  const refinementInstructions = normalizeInstructions(value.refinementInstructions);
  const dictionary = normalizeMobileVoiceDictionary(value.dictionary);
  const usage = normalizeUsage(value.usage);
  const history = normalizeHistory(value.history);
  if (revision === undefined || dictionaryRevision === undefined || dictionaryRevision > revision
    || refinementInstructions === undefined || !dictionary || !usage || !history) throw new Error("invalid current-v1 record");
  return Object.freeze({
    version: 1,
    revision,
    dictionaryRevision,
    refinementInstructions,
    autoLearningEnabled: value.autoLearningEnabled,
    dictionary,
    usage,
    history
  });
}

function normalizeInstructions(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\r\n?/gu, "\n").trim();
  return normalized.length <= MAXIMUM_MOBILE_VOICE_REFINEMENT_INSTRUCTION_CHARACTERS && !/\u0000/u.test(normalized)
    ? normalized : undefined;
}

function normalizeUsage(value: unknown): MobileVoiceDictionaryUsage | undefined {
  if (!isRecord(value) || !hasExactKeys(value, [
    "correctionObservations", "lastCorrectionAt", "lastVoiceStartedAt", "voiceStarts"
  ])) return undefined;
  const voiceStarts = nonNegativeInteger(value.voiceStarts);
  const correctionObservations = nonNegativeInteger(value.correctionObservations);
  const lastVoiceStartedAt = nullableTimestamp(value.lastVoiceStartedAt);
  const lastCorrectionAt = nullableTimestamp(value.lastCorrectionAt);
  if (voiceStarts === undefined || correctionObservations === undefined || lastVoiceStartedAt === undefined
    || lastCorrectionAt === undefined) return undefined;
  return Object.freeze({ voiceStarts, correctionObservations, lastVoiceStartedAt, lastCorrectionAt });
}

function normalizeHistory(value: unknown): readonly MobileVoiceDictionaryHistoryEntry[] | undefined {
  if (!Array.isArray(value) || value.length > MAXIMUM_MOBILE_VOICE_DICTIONARY_HISTORY) return undefined;
  const result: MobileVoiceDictionaryHistoryEntry[] = [];
  for (const raw of value) {
    if (!isRecord(raw) || !hasExactKeys(raw, ["id", "kind", "occurredAt", "terms"])
      || typeof raw.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(raw.id)
      || !isHistoryKind(raw.kind) || !Array.isArray(raw.terms) || raw.terms.length > 3) return undefined;
    const occurredAt = timestamp(raw.occurredAt);
    const terms = raw.terms.map(normalizeMobileVoiceDictionaryTerm);
    if (occurredAt === undefined || terms.some((term) => term === undefined)) return undefined;
    result.push(Object.freeze({ id: raw.id, kind: raw.kind, occurredAt, terms: Object.freeze(terms as string[]) }));
  }
  return Object.freeze(result);
}

function appendHistory(
  history: readonly MobileVoiceDictionaryHistoryEntry[],
  entry: MobileVoiceDictionaryHistoryEntry
): readonly MobileVoiceDictionaryHistoryEntry[] {
  return Object.freeze([...history, Object.freeze({ ...entry, terms: Object.freeze([...entry.terms]) })]
    .slice(-MAXIMUM_MOBILE_VOICE_DICTIONARY_HISTORY));
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function nullableTimestamp(value: unknown): number | null | undefined {
  return value === null ? null : timestamp(value);
}

function timestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAXIMUM_STORED_TIMESTAMP
    ? value : undefined;
}

function boundedIncrement(value: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, value + 1);
}

function isHistoryKind(value: unknown): value is MobileVoiceDictionaryHistoryKind {
  return value === "manualAdd" || value === "manualEdit" || value === "manualMerge"
    || value === "manualDelete" || value === "automaticLearning";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function storageError(prefix: string, cause: unknown): string {
  return `${prefix}: ${cause instanceof Error && cause.message ? cause.message : "storage failed"}`;
}

export const mobileVoiceDictionaryStoreTesting = { storageKey: STORAGE_KEY, parseDocument };
