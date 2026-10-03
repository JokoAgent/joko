import { describe, expect, it } from "vitest";
import type { VoiceInputDictionarySnapshotView } from "./model.js";
import {
  normalizeVoiceDictionaryTerm,
  parseVoiceDictionaryAliasDraft,
  voiceDictionaryAdviceDraft,
  voiceDictionaryTermKey
} from "./voice-input-dictionary.js";

describe("voice input dictionary Web projection", () => {
  it("builds a bounded advice draft from the service-owned snapshot", () => {
    const dictionary: VoiceInputDictionarySnapshotView = {
      revision: 7n,
      syncEnabled: true,
      entries: Array.from({ length: 90 }, (_value, index) => ({
        id: `entry-${index}`,
        text: `Term ${index}`,
        source: index % 2 === 0 ? "manual" : "automatic",
        frequency: index + 1,
        aliases: [{ text: `heard ${index}`, count: index + 1, lastSeenAt: index }],
        createdAt: index,
        updatedAt: index
      })),
      candidates: Array.from({ length: 90 }, (_value, index) => ({
        text: `Candidate ${index}`,
        evidenceCount: index + 1,
        aliases: [{ text: `candidate heard ${index}`, count: 1, lastSeenAt: index }],
        createdAt: index,
        updatedAt: index
      })),
      suppressedAutomaticTerms: [],
      refinementTerms: ["Term 89"]
    };

    const draft = voiceDictionaryAdviceDraft(dictionary, {
      beforeText: "voice kit",
      afterText: "VoiceKit",
      locale: "en-US"
    });
    expect(draft.existingEntries).toHaveLength(80);
    expect(draft.existingEntries[0]).toMatchObject({ term: "Term 89", frequency: 90 });
    expect(draft.existingCandidates).toHaveLength(80);
    expect(draft.existingCandidates[0]).toMatchObject({ term: "Candidate 89", evidenceCount: 90 });
  });

  it("normalizes terms and a bounded, deduplicated alias draft", () => {
    expect(normalizeVoiceDictionaryTerm("  Voice   Kit  ")).toBe("Voice Kit");
    expect(normalizeVoiceDictionaryTerm("bad\0term")).toBeUndefined();
    expect(voiceDictionaryTermKey(" VOICE   KIT ")).toBe("voice kit");
    expect(parseVoiceDictionaryAliasDraft("voice kit\nVoice Kit\nspoken name\n"))
      .toEqual(["voice kit", "spoken name"]);
    expect(parseVoiceDictionaryAliasDraft(`valid\n${"x".repeat(121)}`)).toBeUndefined();
  });
});
