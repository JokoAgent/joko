import type {
  VoiceInputDictionaryAdviceDraft,
  VoiceInputDictionarySnapshotView
} from "./model.js";

export const MAXIMUM_VOICE_DICTIONARY_ALIASES = 8;
export const MAXIMUM_VOICE_DICTIONARY_TERM_CHARACTERS = 120;

export function voiceDictionaryAdviceDraft(
  state: VoiceInputDictionarySnapshotView,
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

export function parseVoiceDictionaryAliasDraft(value: string): readonly string[] | undefined {
  const aliases: string[] = [];
  const seen = new Set<string>();
  for (const line of value.replace(/\r\n?/gu, "\n").split("\n")) {
    if (line.trim() === "") continue;
    const text = normalizeVoiceDictionaryTerm(line);
    if (text === undefined) return undefined;
    const key = voiceDictionaryTermKey(text);
    if (seen.has(key)) continue;
    seen.add(key);
    aliases.push(text);
    if (aliases.length === MAXIMUM_VOICE_DICTIONARY_ALIASES) break;
  }
  return Object.freeze(aliases);
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
