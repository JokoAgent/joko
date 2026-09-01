import { describe, expect, it } from "vitest";
import {
  EMPTY_VOICE_INPUT_DICTIONARY,
  addManualVoiceDictionaryTerm,
  applyVoiceDictionaryAdvice,
  deleteVoiceDictionaryEntry,
  normalizeVoiceInputDictionaryState,
  voiceDictionaryAdviceDraft,
  voiceDictionaryTermsForRefinement
} from "./voice-input-dictionary.js";

describe("voice input dictionary", () => {
  it("rejects omitted or flat dictionary state as unsupported", () => {
    expect(normalizeVoiceInputDictionaryState(undefined)).toBeUndefined();
    expect(normalizeVoiceInputDictionaryState(["VoiceKit", "Orchestrator"])).toBeUndefined();
  });

  it("collects candidates, promotes terms, and retains alias evidence", () => {
    const candidate = applyVoiceDictionaryAdvice(EMPTY_VOICE_INPUT_DICTIONARY, [{
      action: "addCandidate",
      term: "VoiceKit",
      aliases: ["voice kit"],
      type: "productName",
      confidence: "medium"
    }], 10, () => "entry-one");
    expect(candidate.candidates).toMatchObject([{ text: "VoiceKit", evidenceCount: 1 }]);

    const promoted = applyVoiceDictionaryAdvice(candidate, [{
      action: "addEntry",
      term: "VoiceKit",
      aliases: ["voice kit"],
      type: "productName",
      confidence: "high"
    }], 20, () => "entry-one");
    expect(promoted.candidates).toEqual([]);
    expect(promoted.entries).toMatchObject([{
      id: "entry-one",
      text: "VoiceKit",
      source: "automatic",
      frequency: 2,
      aliases: [{ text: "voice kit", count: 2 }]
    }]);
  });

  it("suppresses a deleted automatic term but permits a deliberate manual add", () => {
    const learned = applyVoiceDictionaryAdvice(EMPTY_VOICE_INPUT_DICTIONARY, [{
      action: "addEntry",
      term: "VoiceKit",
      aliases: ["voice kit"],
      type: "productName",
      confidence: "high"
    }], 10, () => "entry-one");
    const deleted = deleteVoiceDictionaryEntry(learned, "entry-one");
    expect(deleted.suppressedAutomaticTexts).toEqual(["VoiceKit"]);
    expect(applyVoiceDictionaryAdvice(deleted, [{
      action: "addEntry",
      term: "VoiceKit",
      aliases: ["voice kit"],
      type: "productName",
      confidence: "high"
    }], 20).entries).toEqual([]);
    expect(addManualVoiceDictionaryTerm(deleted, "VoiceKit", 30, () => "manual-one")?.entries)
      .toMatchObject([{ id: "manual-one", source: "manual" }]);
  });

  it("builds bounded model evidence and refinement terms", () => {
    let state = EMPTY_VOICE_INPUT_DICTIONARY;
    for (let index = 0; index < 210; index += 1) {
      state = addManualVoiceDictionaryTerm(state, `Term ${index}`, index, () => `entry-${index}`)!;
    }
    expect(voiceDictionaryTermsForRefinement(state)).toHaveLength(200);
    const draft = voiceDictionaryAdviceDraft(state, { beforeText: "term old", afterText: "Term New" });
    expect(draft.existingEntries).toHaveLength(80);
  });
});
