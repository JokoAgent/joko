import { describe, expect, it } from "vitest";

import { CODEX_MODEL_ESTIMATES_UPDATED_AT, codexModelEstimate } from "./model-estimates.js";

describe("Codex model estimates", () => {
  it("provides current context and per-million reference rates for catalog models", () => {
    expect(codexModelEstimate("gpt-5.6-sol")).toEqual({
      contextWindow: 272_000,
      maximumOutputTokens: 128_000,
      price: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 }
    });
    expect(codexModelEstimate("gpt-5.5")).toEqual({
      contextWindow: 272_000,
      maximumOutputTokens: 128_000,
      price: { input: 5, output: 30, cacheRead: 0.5 }
    });
    expect(new Date(CODEX_MODEL_ESTIMATES_UPDATED_AT).toISOString()).toBe("2026-08-29T01:20:00.000Z");
  });

  it("keeps catalog-only models priced as unknown instead of free", () => {
    expect(codexModelEstimate("gpt-5.3-codex-spark")).toEqual({
      contextWindow: 272_000,
      maximumOutputTokens: 128_000
    });
    expect(codexModelEstimate("unknown-model")).toBeUndefined();
  });
});
