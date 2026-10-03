import { describe, expect, it } from "vitest";
import {
  EMPTY_MOBILE_VOICE_DICTIONARY, mobileVoiceDictionaryAdviceDraft,
  normalizeMobileVoiceDictionary, previewMobileVoiceDictionaryEdit
} from "./mobile-voice-dictionary";

const source = { id: "source", text: "Variant", source: "automatic" as const, frequency: 3,
  aliases: [{ text: "variant old", count: 2, lastSeenAt: 20 }], createdAt: 10, updatedAt: 20 };
const target = { ...source, id: "target", text: "Canonical", source: "manual" as const };

describe("mobile voice dictionary projection", () => {
  it("rejects malformed projections while allowing manual intent under automatic suppression", () => {
    expect(normalizeMobileVoiceDictionary(undefined)).toBeUndefined();
    expect(normalizeMobileVoiceDictionary({ ...EMPTY_MOBILE_VOICE_DICTIONARY, extra: [] })).toBeUndefined();
    expect(normalizeMobileVoiceDictionary(EMPTY_MOBILE_VOICE_DICTIONARY)).toEqual(EMPTY_MOBILE_VOICE_DICTIONARY);
    expect(normalizeMobileVoiceDictionary({ entries: [source, { ...source, text: "Other" }], candidates: [], suppressedAutomaticTexts: [] })).toBeUndefined();
    expect(normalizeMobileVoiceDictionary({ entries: [source], candidates: [], suppressedAutomaticTexts: ["Variant"] })).toBeUndefined();
    expect(normalizeMobileVoiceDictionary({ entries: [target], candidates: [], suppressedAutomaticTexts: ["Canonical"] })).toBeDefined();
  });

  it("previews entry and candidate merges without implementing a second mutation authority", () => {
    expect(previewMobileVoiceDictionaryEdit({ entries: [source, target], candidates: [], suppressedAutomaticTexts: [] }, source.id, "canonical"))
      .toEqual({ kind: "mergeEntry", targetId: target.id, targetText: target.text });
    expect(previewMobileVoiceDictionaryEdit({ entries: [source], candidates: [{ text: "Canonical", evidenceCount: 2, aliases: [], createdAt: 5, updatedAt: 10 }], suppressedAutomaticTexts: [] }, source.id, "Canonical"))
      .toEqual({ kind: "mergeCandidate", targetText: "Canonical", evidenceCount: 2 });
  });

  it("builds bounded ephemeral advice from the service projection", () => {
    const entries = Array.from({ length: 210 }, (_value, index) => ({ ...target, id: `entry-${index}`, text: `Term ${index}` }));
    const draft = mobileVoiceDictionaryAdviceDraft({ entries, candidates: [], suppressedAutomaticTexts: [] }, {
      beforeText: "b".repeat(2_100), afterText: "a".repeat(2_100), rawTranscriptText: "r".repeat(2_100)
    });
    expect(draft.existingEntries).toHaveLength(80);
    expect([draft.beforeText.length, draft.afterText.length, draft.rawTranscriptText?.length]).toEqual([2_000, 2_000, 2_000]);
  });
});
