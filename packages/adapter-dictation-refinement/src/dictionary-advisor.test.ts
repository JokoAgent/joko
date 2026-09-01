import { describe, expect, it } from "vitest";
import {
  ManagedDictationDictionaryAdvisor,
  getDictationDictionaryAdviceSkipReason
} from "./dictionary-advisor.js";

describe("managed dictation dictionary advisor", () => {
  it("keeps only grounded, bounded vocabulary corrections", async () => {
    const requests: unknown[] = [];
    const advisor = new ManagedDictationDictionaryAdvisor({
      request: async (request) => {
        requests.push(request);
        return JSON.stringify({ actions: [
          {
            action: "add_entry",
            term: "Vibe Coding",
            aliases: ["web coding"],
            type: "technical_term",
            confidence: "high"
          },
          {
            action: "add_entry",
            term: "Invented Name",
            aliases: ["web coding"],
            type: "product_name",
            confidence: "high"
          }
        ] });
      }
    });
    const result = await advisor.advise({
      beforeText: "Please use web coding for this change.",
      afterText: "Please use Vibe Coding for this change."
    }, new AbortController().signal);

    expect(result.actions).toEqual([{
      action: "add_entry",
      term: "Vibe Coding",
      aliases: ["web coding"],
      type: "technical_term",
      confidence: "high"
    }]);
    expect(requests).toHaveLength(1);
  });

  it("accepts an alias grounded in the raw pre-refinement transcript", async () => {
    const advisor = new ManagedDictationDictionaryAdvisor({
      request: async () => JSON.stringify({ actions: [{
        action: "add_candidate",
        term: "VoiceKit",
        aliases: ["voice kit"],
        type: "product_name",
        confidence: "medium"
      }] })
    });
    const result = await advisor.advise({
      rawTranscriptText: "Try voice kit today.",
      beforeText: "Try the voice toolkit today.",
      afterText: "Try VoiceKit today."
    }, new AbortController().signal);
    expect(result.actions[0]).toMatchObject({ term: "VoiceKit", aliases: ["voice kit"] });
  });

  it("skips unchanged, punctuation-only, and broad rewrites before dispatch", () => {
    expect(getDictationDictionaryAdviceSkipReason({ beforeText: "Same", afterText: "Same" })).toBe("same_text");
    expect(getDictationDictionaryAdviceSkipReason({ beforeText: "Test VoiceKit", afterText: "Test VoiceKit." })).toBe("formatting_only");
    expect(getDictationDictionaryAdviceSkipReason({
      beforeText: "This is a fairly long sentence whose original wording is being considered for a small correction.",
      afterText: "A completely unrelated replacement now discusses tomorrow's schedule, budget, and several other topics."
    })).toBe("large_rewrite");
  });

  it("fails closed on invalid model output", async () => {
    const advisor = new ManagedDictationDictionaryAdvisor({ request: async () => "not json" });
    await expect(advisor.advise({ beforeText: "voice kit", afterText: "VoiceKit" }, new AbortController().signal))
      .resolves.toEqual({ actions: [] });
  });
});
