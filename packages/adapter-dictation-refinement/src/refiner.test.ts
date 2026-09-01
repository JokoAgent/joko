import { describe, expect, it, vi } from "vitest";
import { ManagedDictationRefiner, type DictationRefinementRequest } from "./refiner.js";

describe("ManagedDictationRefiner", () => {
  it("accepts a bounded conservative cleanup and sends dictation as data", async () => {
    const request = vi.fn(async (_input: DictationRefinementRequest) => JSON.stringify({ text: "Please inspect src/app.ts." }));
    const refiner = new ManagedDictationRefiner({
      request,
      instructions: "Keep command names verbatim.",
      dictionaryTerms: ["Joko", "Orchestrator", "joko"]
    });
    const result = await refiner.refine({
      runId: "voice-one",
      text: "please inspect src/app.ts",
      locale: "en-US",
      signal: new AbortController().signal,
      onPreview: () => undefined
    });

    expect(result).toEqual({
      accepted: true,
      basedOnText: "please inspect src/app.ts",
      refinedText: "Please inspect src/app.ts."
    });
    const requested = request.mock.calls[0]?.[0];
    expect(requested).toBeDefined();
    expect(JSON.parse(requested?.user ?? "{}")).toMatchObject({
      sourceLanguage: "en-US",
      dictationText: "please inspect src/app.ts",
      dictionaryTerms: ["Joko", "Orchestrator"]
    });
    expect(JSON.parse(requested?.user ?? "{}").instructions).toContain("Keep command names verbatim.");
  });

  it("keeps the raw transcript on malformed, unavailable, or divergent output", async () => {
    const input = {
      runId: "voice-two",
      text: "check the build logs",
      signal: new AbortController().signal,
      onPreview: () => undefined
    };
    await expect(new ManagedDictationRefiner({ request: async () => "not-json" }).refine(input))
      .resolves.toEqual({ accepted: false, reason: "invalid_output" });
    await expect(new ManagedDictationRefiner({ request: async () => { throw new Error("secret upstream detail"); } }).refine(input))
      .resolves.toEqual({ accepted: false, reason: "unavailable" });
    await expect(new ManagedDictationRefiner({ request: async () => JSON.stringify({ text: "completely unrelated answer ".repeat(12) }) }).refine(input))
      .resolves.toEqual({ accepted: false, reason: "unsafe" });
  });
});
