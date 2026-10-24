import { expect, it } from "vitest";
import { SafeProjection } from "./projection.js";

it("preserves an SDK invalid request as a deterministic failure for route selection", () => {
  expect(new SafeProjection([]).result({ subtype: "error_during_execution", is_error: true }, undefined, "invalid_request").error)
    .toMatchObject({ code: "INVALID_REQUEST", retryable: false });
});

it("keeps generation usage separate from normalized inclusive accounting and absent current observations", () => {
  const projection = new SafeProjection([]);
  const native = { inputTokens: 12, outputTokens: 6, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 18, cost: 0,
    nativeAccounting: { sourceId: "query", tokensComplete: false, costComplete: false, costEstimated: true } };
  const envelope = { subtype: "success", usage: { input_tokens: 10, output_tokens: 5 }, duration_api_ms: 100,
    total_cost_usd: 2, modelUsage: { root: { inputTokens: 1000, outputTokens: 500, contextWindow: 200_000 } } };
  expect(projection.result(envelope, native)).toMatchObject({ usage: { totalTokens: 18, cost: 0, contextWindow: 200_000 },
    messageUsage: { totalTokens: 15, cost: 0 }, durationMs: 100 });
  expect(projection.result(envelope, undefined).usage).toBeUndefined();
});
