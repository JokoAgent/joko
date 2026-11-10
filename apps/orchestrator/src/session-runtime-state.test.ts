import { describe, expect, it } from "vitest";

import {
  materializedSessionRuntimeState,
  mergeMaterializedSessionRuntimeState
} from "./session-runtime-state.js";

describe("materialized session runtime state", () => {
  it("restores the bounded native model partition and rejects duplicate or excessive portions before using a saved counter", () => {
    const model = { modelId: "actual-model", inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0,
      totalTokens: 15, cost: 0.02, tokensComplete: true, costComplete: true };
    const usage = { inputTokens: 12, outputTokens: 6, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 18, cost: 0.03,
      nativeAccounting: { sourceId: "native-query", tokensComplete: false, costComplete: false, costEstimated: true, models: [model] } };
    const saved = JSON.parse(JSON.stringify({ updatedAt: 10, usage }));
    expect(materializedSessionRuntimeState(saved)).toEqual({ updatedAt: 10, usage });
    for (const models of [[model, model], [{ ...model, inputTokens: 13, totalTokens: 18 }], [{ ...model, cost: 0.04 }],
      [{ ...model, modelId: "bad\nmodel" }], [{ ...model, privateCredential: "discard" }]]) {
      expect(materializedSessionRuntimeState({ ...saved, usage: { ...usage, nativeAccounting: { ...usage.nativeAccounting, models } } })).toEqual({ updatedAt: 10 });
    }
  });

  it("round-trips bounded cumulative usage and supports explicit leaf clearing", () => {
    const usage = {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      totalTokens: 18,
      contextTokens: 12,
      contextWindow: 32_000,
      pricingContext: { inputTokens: 13, requestedAt: 1_793_000_000_000, cacheWriteTtl: "1h" as const, cacheWrite1hTokens: 1 },
      nativeAccounting: { sourceId: "query-one", tokensComplete: false, costComplete: false, costEstimated: true },
      cost: 0.02
    };
    const withLeaf = mergeMaterializedSessionRuntimeState(undefined, {
      usage,
      activeNativeEntryId: "leaf-a"
    }, 10);
    expect(materializedSessionRuntimeState(withLeaf)).toEqual({ usage, activeNativeEntryId: "leaf-a", updatedAt: 10 });
    expect(mergeMaterializedSessionRuntimeState(withLeaf, { activeNativeEntryId: null }, 20)).toEqual({ usage, updatedAt: 20 });
    for (const pricingContext of [{ ...usage.pricingContext, cacheWrite1hTokens: 2 }, { ...usage.pricingContext, requestedAt: -1 },
      { ...usage.pricingContext, cacheWriteTtl: "one hour" }]) {
      expect(materializedSessionRuntimeState({ ...withLeaf, usage: { ...usage, pricingContext } })).toEqual({ activeNativeEntryId: "leaf-a", updatedAt: 10 });
    }
  });

  it("restores closed native request portions and rejects duplicate, foreign, excessive or private request facts", () => {
    const model = { modelId: "actual", inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 3,
      totalTokens: 15, cost: 0, tokensComplete: true, costComplete: true };
    const request = { requestId: "closed-request", modelId: "actual", inputTokens: 10, outputTokens: 5, cacheReadTokens: 0,
      cacheWriteTokens: 3, totalTokens: 15, fastMode: false, requestedAt: 100, cacheWrite1hTokens: 1 };
    const usage = { ...model, nativeAccounting: { sourceId: "query", tokensComplete: true, costComplete: true, costEstimated: true,
      models: [model], requests: [request] } };
    const { modelId: _model, tokensComplete: _tokens, costComplete: _cost, ...snapshot } = usage;
    const saved = JSON.parse(JSON.stringify({ updatedAt: 10, usage: snapshot }));
    expect(materializedSessionRuntimeState(saved)).toEqual({ updatedAt: 10, usage: snapshot });
    for (const requests of [[request, request], [{ ...request, modelId: "foreign" }], [{ ...request, inputTokens: 11, totalTokens: 16 }],
      [{ ...request, cacheWrite1hTokens: 4 }], [{ ...request, fastMode: "unknown" }], [{ ...request, requestedAt: -1 }],
      [{ ...request, credential: "discard" }], Array.from({ length: 4097 }, () => request)]) {
      expect(materializedSessionRuntimeState({ ...saved, usage: { ...snapshot, nativeAccounting: { ...usage.nativeAccounting, requests } } }))
        .toEqual({ updatedAt: 10 });
    }
  });

  it("rejects malformed, negative, and unbounded durable values", () => {
    expect(materializedSessionRuntimeState({ updatedAt: 1, usage: { inputTokens: -1 } })).toEqual({ updatedAt: 1 });
    expect(materializedSessionRuntimeState({ updatedAt: Number.NaN })).toBeUndefined();
    expect(materializedSessionRuntimeState({ updatedAt: 1, activeNativeEntryId: "x".repeat(513) })).toEqual({ updatedAt: 1 });
  });
});
