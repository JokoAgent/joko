import { describe, expect, it } from "vitest";

import { claudeModelEstimate } from "./model-estimates.js";
import { providerModel, SafeProjection } from "./projection.js";

describe("Claude model estimates", () => {
  it("projects Opus 5.5 only when the native catalog returns its exact model", () => {
    const estimate = claudeModelEstimate(" CLAUDE-OPUS-5-5 ");
    expect(estimate).toEqual({
      contextWindow: 1_000_000,
      maximumOutputTokens: 128_000,
      supportsImages: true,
      thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
      fastModeMultiplier: 2,
      updatedAt: Date.UTC(2026, 8, 23),
      price: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }
    });
    expect(claudeModelEstimate("claude-opus-5-5-20260922")).toBeUndefined();
  });

  it("combines fixed Opus 5.5 metadata with runtime-owned membership", () => {
    expect(providerModel({
      value: "claude-opus-5-5",
      displayName: "Opus 5.5",
      description: "",
      supportsEffort: false,
      supportsFastMode: false
    }, new SafeProjection([]))).toEqual({
      providerId: "claude-code",
      modelId: "claude-opus-5-5",
      displayName: "Opus 5.5",
      api: "anthropic-messages",
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      supportsImages: true,
      supportsFastMode: true,
      thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
      cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
      pricing: {
        source: "providerReference",
        currencyCode: "USD",
        updatedAt: Date.UTC(2026, 8, 23),
        cacheReadAvailable: true,
        cacheWriteAvailable: true,
        fastModeMultiplier: 2
      }
    });
  });

  it.each(["claude-fable-5", "claude-opus-5", "claude-opus-4-8"])(
    "keeps superseded native model %s available but default-hidden",
    (modelId) => expect(claudeModelEstimate(modelId)).toEqual({ defaultVisible: false })
  );
});
