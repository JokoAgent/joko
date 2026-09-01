import { describe, expect, it, vi } from "vitest";
import type { VoiceRefiner } from "@joko/voice-input";
import { FallbackDictationRefiner } from "./fallback-refiner.js";

describe("FallbackDictationRefiner", () => {
  it("uses one backup after transport or output failure", async () => {
    const primary = refiner({ accepted: false, reason: "unavailable" });
    const backup = refiner({ accepted: true, basedOnText: "raw", refinedText: "Raw." });
    const fallback = new FallbackDictationRefiner([primary.value, backup.value]);
    const input = request();

    await expect(fallback.refine(input)).resolves.toEqual({ accepted: true, basedOnText: "raw", refinedText: "Raw." });
    expect(primary.refine).toHaveBeenCalledOnce();
    expect(backup.refine).toHaveBeenCalledOnce();
  });

  it("does not retry unchanged or unsafe quality decisions", async () => {
    const primary = refiner({ accepted: false, reason: "unchanged" });
    const backup = refiner({ accepted: true, basedOnText: "raw", refinedText: "Raw." });
    const fallback = new FallbackDictationRefiner([primary.value, backup.value]);

    await expect(fallback.refine(request())).resolves.toEqual({ accepted: false, reason: "unchanged" });
    expect(backup.refine).not.toHaveBeenCalled();
  });
});

function refiner(result: Awaited<ReturnType<VoiceRefiner["refine"]>>): {
  readonly value: VoiceRefiner;
  readonly refine: ReturnType<typeof vi.fn>;
} {
  const refine = vi.fn(async () => result);
  return { value: { refine }, refine };
}

function request(): Parameters<VoiceRefiner["refine"]>[0] {
  return {
    runId: "voice-one",
    text: "raw",
    signal: new AbortController().signal,
    onPreview: () => undefined
  };
}
