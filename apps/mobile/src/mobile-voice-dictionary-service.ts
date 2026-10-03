import type { VoiceDictionaryPeerApi } from "@joko/contracts";
import {
  VoiceInputDictionaryEntrySource,
  VoiceInputDictionaryLearningActionType,
  VoiceInputDictionaryLearningConfidence,
  VoiceInputDictionaryTermType,
  type VoiceInputDictionarySnapshot as WireDictionarySnapshot
} from "@joko/contracts";
import {
  mobileVoiceDictionaryTermKey,
  normalizeMobileVoiceDictionary,
  normalizeMobileVoiceDictionaryTerm,
  type MobileVoiceDictionary,
  type MobileVoiceDictionaryLearningAction
} from "./mobile-voice-dictionary";

export interface MobileVoiceDictionarySnapshot {
  readonly revision: bigint;
  readonly syncEnabled: boolean;
  readonly dictionary: MobileVoiceDictionary;
  readonly refinementTerms: readonly string[];
}

export interface MobileVoiceDictionaryApi extends VoiceDictionaryPeerApi {
  getVoiceInputDictionary(signal?: AbortSignal): Promise<MobileVoiceDictionarySnapshot>;
  watchVoiceInputDictionary(signal: AbortSignal): AsyncIterable<MobileVoiceDictionarySnapshot>;
  setVoiceInputDictionarySyncEnabled(expectedRevision: bigint, enabled: boolean, signal?: AbortSignal): Promise<MobileVoiceDictionarySnapshot>;
  addVoiceInputDictionaryTerms(expectedRevision: bigint, terms: readonly string[], signal?: AbortSignal): Promise<MobileVoiceDictionarySnapshot>;
  editVoiceInputDictionaryEntry(expectedRevision: bigint, entryId: string, text: string, aliases: readonly string[], signal?: AbortSignal): Promise<MobileVoiceDictionarySnapshot>;
  deleteVoiceInputDictionaryEntry(expectedRevision: bigint, entryId: string, signal?: AbortSignal): Promise<MobileVoiceDictionarySnapshot>;
  applyVoiceInputDictionaryLearning(expectedRevision: bigint, actions: readonly MobileVoiceDictionaryLearningAction[], signal?: AbortSignal): Promise<MobileVoiceDictionarySnapshot>;
}

export interface MobileVoiceDictionaryTransport extends MobileVoiceDictionaryApi {
  readonly ownerKey: string;
  isCurrent(): boolean;
}

/** Only a bounded service projection crosses the mobile boundary, never replica state. */
export function projectMobileVoiceDictionarySnapshot(value: WireDictionarySnapshot | undefined): MobileVoiceDictionarySnapshot {
  if (!value || value.revision < 1n || value.revision > BigInt(Number.MAX_SAFE_INTEGER)
    || value.entries.length > 1_000 || value.candidates.length > 200
    || value.suppressedAutomaticTerms.length > 1_000 || value.refinementTerms.length > 200) {
    throw invalid("snapshot bounds");
  }
  const entries = value.entries.map((entry) => ({
    id: entry.entryId,
    text: term(entry.text),
    source: entry.source === VoiceInputDictionaryEntrySource.MANUAL ? "manual"
      : entry.source === VoiceInputDictionaryEntrySource.AUTOMATIC ? "automatic"
        : (() => { throw invalid("entry source"); })(),
    frequency: positiveCount(entry.frequency),
    aliases: aliases(entry.aliases),
    createdAt: timestamp(entry.createdAt),
    updatedAt: timestamp(entry.updatedAt)
  }));
  const candidates = value.candidates.map((candidate) => ({
    text: term(candidate.text),
    evidenceCount: positiveCount(candidate.evidenceCount),
    aliases: aliases(candidate.aliases),
    createdAt: timestamp(candidate.createdAt),
    updatedAt: timestamp(candidate.updatedAt)
  }));
  const projected = normalizeMobileVoiceDictionary({ entries, candidates, suppressedAutomaticTexts: [] });
  if (!projected) throw invalid("entry or candidate");
  const suppressedAutomaticTexts = termList(value.suppressedAutomaticTerms);
  const suppressedKeys = new Set(suppressedAutomaticTexts.map(mobileVoiceDictionaryTermKey));
  if (projected.entries.some((entry) => entry.source === "automatic" && suppressedKeys.has(mobileVoiceDictionaryTermKey(entry.text)))
    || projected.candidates.some((candidate) => suppressedKeys.has(mobileVoiceDictionaryTermKey(candidate.text)))) {
    throw invalid("automatic suppression");
  }
  const refinementTerms = termList(value.refinementTerms);
  const entryKeys = new Set(projected.entries.map((entry) => mobileVoiceDictionaryTermKey(entry.text)));
  if (refinementTerms.reduce((total, text) => total + text.length, 0) > 8_000
    || refinementTerms.some((text) => !entryKeys.has(mobileVoiceDictionaryTermKey(text)))) {
    throw invalid("refinement terms");
  }
  return Object.freeze({
    revision: value.revision,
    syncEnabled: value.syncEnabled,
    dictionary: Object.freeze({ ...projected, suppressedAutomaticTexts }),
    refinementTerms
  });
}

export function mobileVoiceDictionaryLearningRequest(actions: readonly MobileVoiceDictionaryLearningAction[]) {
  if (actions.length < 1 || actions.length > 3) throw invalid("learning action count");
  return actions.map((action) => {
    const actionType = {
      addCandidate: VoiceInputDictionaryLearningActionType.ADD_CANDIDATE,
      addEntry: VoiceInputDictionaryLearningActionType.ADD_ENTRY,
      updateEntry: VoiceInputDictionaryLearningActionType.UPDATE_ENTRY
    }[action.action];
    const termType = {
      productName: VoiceInputDictionaryTermType.PRODUCT_NAME,
      projectName: VoiceInputDictionaryTermType.PROJECT_NAME,
      technicalTerm: VoiceInputDictionaryTermType.TECHNICAL_TERM,
      personName: VoiceInputDictionaryTermType.PERSON_NAME,
      teamName: VoiceInputDictionaryTermType.TEAM_NAME,
      codeName: VoiceInputDictionaryTermType.CODE_NAME,
      phrase: VoiceInputDictionaryTermType.PHRASE,
      other: VoiceInputDictionaryTermType.OTHER
    }[action.type];
    const confidence = {
      high: VoiceInputDictionaryLearningConfidence.HIGH,
      medium: VoiceInputDictionaryLearningConfidence.MEDIUM
    }[action.confidence];
    if (typeof actionType !== "number" || typeof termType !== "number" || typeof confidence !== "number" || action.aliases.length > 8) {
      throw invalid("learning action");
    }
    return { action: actionType, term: term(action.term), aliases: [...termList(action.aliases)], termType, confidence };
  });
}

function term(value: string): string {
  if (normalizeMobileVoiceDictionaryTerm(value) !== value) throw invalid("term");
  return value;
}

function termList(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  return Object.freeze(values.map((value) => {
    const text = term(value);
    const key = mobileVoiceDictionaryTermKey(text);
    if (seen.has(key)) throw invalid("duplicate term");
    seen.add(key);
    return text;
  }));
}

function aliases(values: WireDictionarySnapshot["entries"][number]["aliases"]) {
  if (values.length > 8) throw invalid("alias count");
  return values.map((alias) => ({ text: term(alias.text), count: positiveCount(alias.count), lastSeenAt: timestamp(alias.lastSeenAt) }));
}

function positiveCount(value: bigint): number {
  if (value < 1n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid("count");
  return Number(value);
}

function timestamp(value: { readonly seconds: bigint; readonly nanos: number } | undefined): number {
  if (!value || value.seconds < 0n || value.seconds > 8_640_000_000_000n
    || !Number.isInteger(value.nanos) || value.nanos < 0 || value.nanos > 999_999_999) throw invalid("timestamp");
  const result = Number(value.seconds) * 1_000 + Math.floor(value.nanos / 1_000_000);
  if (!Number.isSafeInteger(result) || result > 8_640_000_000_000_000) throw invalid("timestamp");
  return result;
}

function invalid(field: string): Error {
  return new Error(`The Joko node returned invalid voice dictionary ${field}.`);
}
