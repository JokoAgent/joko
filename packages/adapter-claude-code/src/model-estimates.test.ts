import { describe, expect, it } from "vitest";
import { catalogModelReferencePricing } from "@joko/core";

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
      defaultEffort: "medium",
      fastModeMultiplier: 2,
      updatedAt: Date.UTC(2026, 8, 23),
      price: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }
    });
    expect(claudeModelEstimate("claude-opus-5-5-20260922")).toBeUndefined();
  });

  it("combines fixed Opus 5.5 metadata with runtime-owned membership", () => {
    const pricing = catalogModelReferencePricing("anthropic/claude-opus-5-5");
    expect(pricing?.tariffs).toEqual(expect.arrayContaining([
      expect.objectContaining({ variant: "standard", currencyCode: "USD",
        cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8 } }),
      expect.objectContaining({ variant: "fast", currencyCode: "USD",
        cost: { input: 8, output: 40, cacheRead: 0.4, cacheWrite: 10, cacheWrite1h: 16 } })
    ]));
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
      referenceApi: "anthropic-messages",
      protocolMode: "matching",
      description: "",
      declaredSupportsFastMode: false,
      contextWindow: 1_000_000,
      contextWindowSource: "estimated",
      maxOutputTokens: 128_000,
      maxOutputTokensSource: "estimated",
      supportsImages: true,
      supportsFastMode: true,
      thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "medium",
      cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
      pricing
    });
  });

  it.each(["claude-fable-5", "claude-opus-5", "claude-opus-4-8"])(
    "keeps superseded native model %s available but default-hidden",
    (modelId) => expect(claudeModelEstimate(modelId)).toEqual({ defaultVisible: false })
  );

  it.each(["claude-sonnet-5-5", "claude-haiku-5-5"])("enriches a runtime-discovered %s without inventing reference prices", modelId => {
    const projected = providerModel({ value: modelId, displayName: modelId, description: "", supportsEffort: true }, new SafeProjection([]));
    expect(projected).toMatchObject({ modelId, contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsImages: true,
      thinkingLevels: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium" });
    expect(projected.pricing).toBeUndefined();
    expect(claudeModelEstimate('private/' + modelId)).toBeUndefined();
  });
});
