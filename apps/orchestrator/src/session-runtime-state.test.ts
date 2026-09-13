import { describe, expect, it } from "vitest";

import {
  materializedSessionRuntimeState,
  mergeMaterializedSessionRuntimeState
} from "./session-runtime-state.js";

describe("materialized session runtime state", () => {
  it("round-trips bounded cumulative usage and supports explicit leaf clearing", () => {
    const usage = {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      totalTokens: 18,
      contextTokens: 12,
      contextWindow: 32_000,
      cost: 0.02
    };
    const withLeaf = mergeMaterializedSessionRuntimeState(undefined, {
      usage,
      activeNativeEntryId: "leaf-a"
    }, 10);
    expect(materializedSessionRuntimeState(withLeaf)).toEqual({ usage, activeNativeEntryId: "leaf-a", updatedAt: 10 });
    expect(mergeMaterializedSessionRuntimeState(withLeaf, { activeNativeEntryId: null }, 20)).toEqual({ usage, updatedAt: 20 });
  });

  it("rejects malformed, negative, and unbounded durable values", () => {
    expect(materializedSessionRuntimeState({ updatedAt: 1, usage: { inputTokens: -1 } })).toEqual({ updatedAt: 1 });
    expect(materializedSessionRuntimeState({ updatedAt: Number.NaN })).toBeUndefined();
    expect(materializedSessionRuntimeState({ updatedAt: 1, activeNativeEntryId: "x".repeat(513) })).toEqual({ updatedAt: 1 });
  });
});
