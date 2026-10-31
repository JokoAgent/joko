import { describe, expect, it } from "vitest";

import { projectMessageGenerationTiming, projectMessageUsage } from "./message-usage.js";

describe("message usage projection", () => {
  it("keeps authoritative zero values, derives omitted totals, and rejects malformed accounting", () => {
    expect(projectMessageUsage({
      input: 2,
      output: 3,
      cacheRead: 4,
      cacheWrite: 1,
      cost: { total: 0 }
    })).toEqual({
      inputTokens: 2,
      outputTokens: 3,
      cacheReadTokens: 4,
      cacheWriteTokens: 1,
      totalTokens: 10,
      pricingContext: { inputTokens: 7 },
      cost: 0
    });
    expect(projectMessageUsage({ input: 2, output: 3, cacheRead: 4, cacheWrite: 1 }, true))
      .toMatchObject({ pricingContext: { inputTokens: 7, fastMode: true } });
    expect(projectMessageUsage({ input: -1, output: 1, cost: { total: 0 } })).toBeUndefined();
    expect(projectMessageUsage({ input: 1, output: 1, cost: { total: Number.NaN } })).toBeUndefined();
  });

  it("accepts only explicit finite positive generation durations", () => {
    expect(projectMessageGenerationTiming(1_200.4)).toEqual({
      generationDurationMs: 1_200,
      generationReliable: true
    });
    expect(projectMessageGenerationTiming(undefined)).toEqual({ generationReliable: false });
    expect(projectMessageGenerationTiming(0)).toEqual({ generationReliable: false });
    expect(projectMessageGenerationTiming(-1)).toEqual({ generationReliable: false });
    expect(projectMessageGenerationTiming(Number.NaN)).toEqual({ generationReliable: false });
    expect(projectMessageGenerationTiming(Number.POSITIVE_INFINITY)).toEqual({ generationReliable: false });
  });

  it("preserves native request time and the one-hour subset without inferring absent facts", () => {
    const usage = { input: 2, output: 3, cacheRead: 4, cacheWrite: 10, cacheWrite1h: 6 };
    expect(projectMessageUsage(usage, false, 1_793_000_000_000)?.pricingContext)
      .toEqual({ inputTokens: 16, fastMode: false, requestedAt: 1_793_000_000_000, cacheWrite1hTokens: 6 });
    expect(projectMessageUsage({ ...usage, cacheWrite1h: 11 })).toBeUndefined();
    expect(projectMessageUsage({ ...usage, cacheWrite1h: -1 })).toBeUndefined();
    expect(projectMessageUsage({ ...usage, cacheWrite1h: undefined }, undefined, "yesterday")?.pricingContext)
      .toEqual({ inputTokens: 16 });
  });
});
