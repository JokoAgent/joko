import { describe, expect, it } from "vitest";
import {
  EMPTY_MOBILE_VOICE_DICTIONARY,
  addManualMobileVoiceDictionaryTerm,
  applyMobileVoiceDictionaryAdvice,
  deleteMobileVoiceDictionaryEntry,
  editMobileVoiceDictionaryEntry,
  mobileVoiceDictionaryAdviceDraft,
  mobileVoiceDictionaryTermsForRefinement,
  normalizeMobileVoiceDictionary,
  previewMobileVoiceDictionaryEdit
} from "./mobile-voice-dictionary";

describe("mobile voice dictionary", () => {
  it("accepts only the strict current dictionary shape", () => {
    expect(normalizeMobileVoiceDictionary(undefined)).toBeUndefined();
    expect(normalizeMobileVoiceDictionary([])).toBeUndefined();
    expect(normalizeMobileVoiceDictionary({ ...EMPTY_MOBILE_VOICE_DICTIONARY, legacyTerms: [] })).toBeUndefined();
    expect(normalizeMobileVoiceDictionary(EMPTY_MOBILE_VOICE_DICTIONARY)).toEqual(EMPTY_MOBILE_VOICE_DICTIONARY);
    const entry = { id: "same", text: "One", source: "manual", frequency: 1, aliases: [], createdAt: 1, updatedAt: 1 };
    expect(normalizeMobileVoiceDictionary({
      entries: [entry, { ...entry, text: "Two" }], candidates: [], suppressedAutomaticTexts: []
    })).toBeUndefined();
    expect(normalizeMobileVoiceDictionary({
      entries: [entry], candidates: [], suppressedAutomaticTexts: ["one"]
    })).toBeUndefined();
  });

  it("collects candidates, promotes terms, and preserves bounded alias evidence", () => {
    const candidate = applyMobileVoiceDictionaryAdvice(EMPTY_MOBILE_VOICE_DICTIONARY, [{
      action: "addCandidate", term: "VoiceKit", aliases: ["voice kit"], type: "productName", confidence: "medium"
    }], 10, () => "entry-one");
    expect(candidate.candidates).toMatchObject([{ text: "VoiceKit", evidenceCount: 1 }]);
    const promoted = applyMobileVoiceDictionaryAdvice(candidate, [{
      action: "addEntry", term: "VoiceKit", aliases: ["voice kit"], type: "productName", confidence: "high"
    }], 20, () => "entry-one");
    expect(promoted.candidates).toEqual([]);
    expect(promoted.entries).toMatchObject([{
      id: "entry-one", text: "VoiceKit", source: "automatic", frequency: 2,
      aliases: [{ text: "voice kit", count: 2 }]
    }]);
  });

  it("suppresses deleted automatic terms until an explicit manual add", () => {
    const learned = applyMobileVoiceDictionaryAdvice(EMPTY_MOBILE_VOICE_DICTIONARY, [{
      action: "addEntry", term: "VoiceKit", aliases: ["voice kit"], type: "productName", confidence: "high"
    }], 10, () => "entry-one");
    const deleted = deleteMobileVoiceDictionaryEntry(learned, "entry-one");
    expect(deleted.suppressedAutomaticTexts).toEqual(["VoiceKit"]);
    expect(applyMobileVoiceDictionaryAdvice(deleted, [{
      action: "addEntry", term: "VoiceKit", aliases: ["voice kit"], type: "productName", confidence: "high"
    }], 20, () => "ignored").entries).toEqual([]);
    expect(addManualMobileVoiceDictionaryTerm(deleted, "VoiceKit", 30, () => "manual-one")?.entries)
      .toMatchObject([{ id: "manual-one", source: "manual" }]);
  });

  it("previews and merges entry or candidate evidence without reviving removed source aliases", () => {
    const source = { id: "source", text: "Variant", source: "automatic" as const, frequency: 3,
      aliases: [{ text: "shared", count: 2, lastSeenAt: 20 }, { text: "removed", count: 5, lastSeenAt: 15 }],
      createdAt: 10, updatedAt: 20 };
    const target = { id: "target", text: "Canonical", source: "manual" as const, frequency: 4,
      aliases: [{ text: "SHARED", count: 3, lastSeenAt: 25 }, { text: "destination", count: 1, lastSeenAt: 24 }],
      createdAt: 5, updatedAt: 25 };
    const state = { entries: [source, target], candidates: [], suppressedAutomaticTexts: ["canonical", "Unrelated"] };
    expect(previewMobileVoiceDictionaryEdit(state, source.id, "canonical"))
      .toEqual({ kind: "mergeEntry", targetId: "target", targetText: "Canonical" });
    const merged = editMobileVoiceDictionaryEntry(state, source.id, "canonical", "shared\nnew alias", 30)!;
    expect(merged.entries).toEqual([{
      ...target,
      text: "canonical",
      frequency: 7,
      updatedAt: 30,
      aliases: [
        { text: "SHARED", count: 5, lastSeenAt: 25 },
        { text: "new alias", count: 1, lastSeenAt: 30 },
        { text: "destination", count: 1, lastSeenAt: 24 }
      ]
    }]);
    expect(merged.suppressedAutomaticTexts).toEqual(["Unrelated"]);

    const candidateState = {
      ...state,
      entries: [source],
      candidates: [{ text: "Canonical", evidenceCount: 2,
        aliases: [{ text: "SHARED", count: 2, lastSeenAt: 22 }], createdAt: 8, updatedAt: 22 }]
    };
    expect(previewMobileVoiceDictionaryEdit(candidateState, source.id, "Canonical"))
      .toEqual({ kind: "mergeCandidate", targetText: "Canonical", evidenceCount: 2 });
    expect(editMobileVoiceDictionaryEntry(candidateState, source.id, "Canonical", "shared", 30)?.entries)
      .toMatchObject([{ id: source.id, source: "manual", frequency: 5, createdAt: 8,
        aliases: [{ text: "SHARED", count: 4, lastSeenAt: 22 }] }]);
  });

  it("builds bounded ephemeral advice evidence and refinement terms", () => {
    let state = EMPTY_MOBILE_VOICE_DICTIONARY;
    for (let index = 0; index < 210; index += 1) {
      state = addManualMobileVoiceDictionaryTerm(state, `Term ${index}`, index, () => `entry-${index}`)!;
    }
    expect(mobileVoiceDictionaryTermsForRefinement(state)).toHaveLength(200);
    const draft = mobileVoiceDictionaryAdviceDraft(state, {
      beforeText: "b".repeat(2_100), afterText: "a".repeat(2_100), rawTranscriptText: "r".repeat(2_100)
    });
    expect(draft.existingEntries).toHaveLength(80);
    expect([draft.beforeText.length, draft.afterText.length, draft.rawTranscriptText?.length]).toEqual([2_000, 2_000, 2_000]);
  });
});
