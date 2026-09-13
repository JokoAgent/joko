import { describe, expect, it } from "vitest";
import {
  EMPTY_VOICE_INPUT_DICTIONARY,
  addManualVoiceDictionaryTerm,
  applyVoiceDictionaryAdvice,
  deleteVoiceDictionaryEntry,
  editVoiceDictionaryEntry,
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

  it("edits aliases without fabricating observations or losing entry identity", () => {
    let learned = applyVoiceDictionaryAdvice(EMPTY_VOICE_INPUT_DICTIONARY, [{
      action: "addEntry", term: "VoiceKit", aliases: ["voice kit", "old alias"], type: "productName", confidence: "high"
    }], 10, () => "entry-one");
    learned = applyVoiceDictionaryAdvice(learned, [{
      action: "updateEntry", term: "VoiceKit", aliases: ["voice kit"], type: "productName", confidence: "high"
    }], 20);
    const edited = editVoiceDictionaryEntry(learned, "entry-one", "VoiceKit", "\nVOICE KIT\r\nvoice kit\n VoiceKit \nnew, variant; name\n", 30)!;
    expect(edited.entries).toEqual([{
      ...learned.entries[0], source: "manual", updatedAt: 30,
      aliases: [{ text: "VOICE KIT", count: 2, lastSeenAt: 20 }, { text: "new, variant; name", count: 1, lastSeenAt: 30 }]
    }]);
    expect(voiceDictionaryAdviceDraft(edited, { beforeText: "old", afterText: "new" }).existingEntries[0]?.aliases)
      .toEqual([{ text: "VOICE KIT", count: 2 }, { text: "new, variant; name", count: 1 }]);
    expect(editVoiceDictionaryEntry(edited, "entry-one", "VoiceKit", " \n\r\n", 40)?.entries[0]?.aliases).toEqual([]);
    expect(editVoiceDictionaryEntry(edited, "entry-one", "VoiceKit", Array.from({ length: 10 }, (_, index) => `alias ${index}`).join("\n"), 40)?.entries[0]?.aliases).toHaveLength(8);
    expect(editVoiceDictionaryEntry(edited, "entry-one", "VoiceKit", "x".repeat(121), 40)).toBeUndefined();
    const withSecond = addManualVoiceDictionaryTerm(edited, "OtherTerm", 40, () => "entry-two")!;
    expect(editVoiceDictionaryEntry(withSecond, "entry-one", "OtherTerm", "alias", 50)?.entries)
      .toMatchObject([{ id: "entry-two", text: "OtherTerm", frequency: 3, source: "manual" }]);
    const deleted = editVoiceDictionaryEntry(edited, "entry-one", " ", "ignored", 50)!;
    expect(deleted.entries).toEqual([]);
    expect(deleted.suppressedAutomaticTexts).toEqual([]);
  });

  it("merges renamed entries and candidates without restoring edited-out aliases or counting twice", () => {
    const source = { id: "source", text: "Variant", source: "automatic" as const, frequency: 3, createdAt: 10, updatedAt: 20,
      aliases: [{ text: "shared", count: 2, lastSeenAt: 20 }, { text: "removed", count: 5, lastSeenAt: 15 }] };
    const target = { id: "target", text: "Canonical", source: "manual" as const, frequency: 4, createdAt: 5, updatedAt: 25,
      aliases: [{ text: "SHARED", count: 3, lastSeenAt: 25 }, { text: "destination", count: 1, lastSeenAt: 24 }, { text: "Canonical", count: 1, lastSeenAt: 25 }] };
    const state = { entries: [source, target], candidates: [], suppressedAutomaticTexts: ["canonical", "Unrelated"] };
    const merged = editVoiceDictionaryEntry(state, source.id, " canonical ", "shared\nnew alias\nCanonical", 30)!;
    expect(merged.entries).toEqual([{
      ...target, text: "canonical", frequency: 7, createdAt: 5, updatedAt: 30,
      aliases: [{ text: "SHARED", count: 5, lastSeenAt: 25 }, { text: "new alias", count: 1, lastSeenAt: 30 }, { text: "destination", count: 1, lastSeenAt: 24 }]
    }]);
    expect(merged.suppressedAutomaticTexts).toEqual(["Unrelated"]);
    expect(state.entries).toEqual([source, target]);
    expect(editVoiceDictionaryEntry(merged, source.id, "Canonical", "shared", 40)).toBe(merged);
    expect(editVoiceDictionaryEntry(merged, target.id, "Canonical", "shared\nnew alias\ndestination", 40)?.entries[0]?.frequency).toBe(7);
    const toCandidate = editVoiceDictionaryEntry({ ...state, entries: [source], candidates: [{ text: "Canonical", evidenceCount: 2,
      aliases: [{ text: "SHARED", count: 2, lastSeenAt: 22 }], createdAt: 8, updatedAt: 22 }] }, source.id, "Canonical", "shared", 30)!;
    expect(toCandidate.entries).toMatchObject([{ id: source.id, source: "manual", frequency: 5, createdAt: 8,
      aliases: [{ text: "SHARED", count: 4, lastSeenAt: 22 }] }]);
    expect(toCandidate.candidates).toEqual([]);
    const bounded = editVoiceDictionaryEntry({ ...state, entries: [source, { ...target, frequency: Number.MAX_SAFE_INTEGER,
      aliases: Array.from({ length: 8 }, (_, index) => ({ text: `target ${index}`, count: Number.MAX_SAFE_INTEGER, lastSeenAt: 25 })) }] }, source.id, "Canonical", "shared\nnew alias", 30)!;
    expect(bounded.entries[0]?.frequency).toBe(Number.MAX_SAFE_INTEGER);
    expect(bounded.entries[0]?.aliases).toHaveLength(8);
    expect(normalizeVoiceInputDictionaryState(bounded)).toEqual(bounded);
    const updated = applyVoiceDictionaryAdvice({ ...bounded, candidates: [{ text: "Candidate", evidenceCount: Number.MAX_SAFE_INTEGER,
      aliases: [{ text: "candidate alias", count: Number.MAX_SAFE_INTEGER, lastSeenAt: 20 }], createdAt: 10, updatedAt: 20 }] }, [
      { action: "addCandidate", term: "Candidate", aliases: ["candidate alias"], type: "productName", confidence: "medium" },
      { action: "addEntry", term: "Candidate", aliases: ["candidate alias"], type: "productName", confidence: "high" },
      { action: "updateEntry", term: "Canonical", aliases: ["target 0"], type: "productName", confidence: "high" }
    ], 40, () => "promoted");
    expect(updated.candidates).toEqual([]);
    expect(updated.entries.every((entry) => entry.frequency === Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(updated.entries.every((entry) => entry.aliases[0]?.count === Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(normalizeVoiceInputDictionaryState(updated)).toEqual(updated);
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
