import { describe, expect, it } from "vitest";
import { NativeQueryUsage } from "./native-query-usage.js";

const model = (inputTokens: number, outputTokens: number, costUSD: number) =>
  ({ inputTokens, outputTokens, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD });
const assistant = (id: string, name: string, input: number, output: number) => ({ message: {
  id, model: name, usage: { input_tokens: input, output_tokens: output }
} });

describe("native Query accounting", () => {
  it("joins closed root and child requests to actual models, uses final streamed output, and deduplicates cumulative replays", () => {
    const query = new NativeQueryUsage(true);
    const close = (id: string, name: string, input: number, output: number, parent: string | null, fastMode: boolean, cache = false) => {
      const usage = { input_tokens: input, output_tokens: 0, cache_read_input_tokens: cache ? 2 : 0,
        cache_creation_input_tokens: cache ? 3 : 0,
        ...(cache ? { cache_creation: { ephemeral_1h_input_tokens: 1, ephemeral_5m_input_tokens: 2 } } : {}) };
      const emit = (event: unknown) => query.observeStream({ type: "stream_event", parent_tool_use_id: parent, event }, { fastMode, requestedAt: 100 });
      emit({ type: "message_start", message: { id, model: name, usage } });
      query.observeAssistant({ message: { id, model: name, usage: { ...usage, output_tokens: 1 } } });
      emit({ type: "message_delta", usage: { output_tokens: output } }); emit({ type: "message_stop" });
    };
    close("root-request", "root", 10, 5, null, false, true);
    close("child-request", "child", 2, 1, "owned-tool", true);
    const native = { modelUsage: { "root[1m]": { ...model(10, 5, 0), cacheReadInputTokens: 2, cacheCreationInputTokens: 3 }, child: model(2, 1, 0) }, total_cost_usd: 0 };
    const first = query.observeResult(native)!;
    expect(first).toMatchObject({ inputTokens: 12, outputTokens: 6, cacheReadTokens: 2, cacheWriteTokens: 3, totalTokens: 18 });
    expect(first.nativeAccounting?.requests).toEqual([
      { requestId: "root-request", modelId: "root[1m]", inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 3,
        totalTokens: 15, fastMode: false, requestedAt: 100, cacheWrite1hTokens: 1 },
      { requestId: "child-request", modelId: "child", inputTokens: 2, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
        totalTokens: 3, fastMode: true, requestedAt: 100, cacheWrite1hTokens: 0 }
    ]);
    close("root-request", "root", 10, 5, null, false, true);
    expect(query.observeResult(native)).toEqual(first);
    close("later-request", "root", 10, 7, null, true, true);
    const later = query.observeResult({ modelUsage: { "root[1m]": { ...model(20, 12, 0), cacheReadInputTokens: 4, cacheCreationInputTokens: 6 }, child: model(2, 1, 0) }, total_cost_usd: 0 })!;
    expect(later).toMatchObject({ inputTokens: 22, outputTokens: 13, totalTokens: 35, nativeAccounting: { tokensComplete: true } });
    expect(later.nativeAccounting?.requests).toHaveLength(3);
  });

  it("keeps unclosed, cross-result, ambiguous and unobserved Fast requests out of reference pricing", () => {
    for (const kind of ["unclosed", "cross-result", "ambiguous", "unknown-fast"] as const) {
      const query = new NativeQueryUsage(false);
      const emit = (event: unknown) => query.observeStream({ event, parent_tool_use_id: null }, { requestedAt: 0,
        ...(kind === "unknown-fast" ? {} : { fastMode: false }) });
      emit({ type: "message_start", message: { id: "current", model: "root", usage: {
        input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0
      } } });
      if (kind === "cross-result") query.observeResult({ modelUsage: { root: model(1000, 500, 0) }, total_cost_usd: 0 });
      emit({ type: "message_delta", usage: { output_tokens: 5 } });
      if (kind !== "unclosed") emit({ type: "message_stop" });
      const models = kind === "ambiguous" ? { "root[1m]": model(10, 5, 0), "root[2m]": model(10, 5, 0) } : { root: model(1010, 505, 0) };
      expect(query.observeResult({ modelUsage: models, total_cost_usd: 0 })?.nativeAccounting?.requests).toBeUndefined();
    }
  });

  it.each([
    { speed: "standard", requestedFast: true, observedFast: false },
    { speed: "fast", requestedFast: false, observedFast: true },
    { speed: "unknown", requestedFast: false, observedFast: undefined },
    { speed: "standard", requestedFast: false, tier: "priority", observedFast: undefined }
  ])("uses the request's observed $speed speed and keeps unsupported tiers unpriced", ({ speed, requestedFast, tier, observedFast }) => {
    const query = new NativeQueryUsage(true), context = { fastMode: requestedFast, requestedAt: 0 };
    const emit = (event: unknown) => query.observeStream({ event }, context);
    emit({ type: "message_start", message: { id: "request", model: "root", usage: { input_tokens: 10, output_tokens: 0,
      cache_read_input_tokens: 0, cache_creation_input_tokens: 0, speed, service_tier: tier } } });
    emit({ type: "message_delta", usage: { output_tokens: 5 } }); emit({ type: "message_stop" });
    const usage = query.observeResult({ modelUsage: { root: model(10, 5, 0) }, total_cost_usd: 0 })!;
    expect(usage).toMatchObject({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    if (observedFast === undefined) expect(usage.nativeAccounting?.requests).toBeUndefined();
    else expect(usage.nativeAccounting?.requests).toEqual([expect.objectContaining({ fastMode: observedFast, requestedAt: 0 })]);
  });

  it("keeps missing native model cost in an unattributed remainder instead of charging a later model baseline twice", () => {
    const query = new NativeQueryUsage(true);
    const first = query.observeResult({ modelUsage: { root: model(10, 5, 0.02), child: { ...model(2, 1, 0), costUSD: undefined } }, total_cost_usd: 0.03 })!;
    expect(first.nativeAccounting?.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ modelId: "root", cost: 0.02, costComplete: true }),
      expect.objectContaining({ modelId: "child", cost: 0, costComplete: false })
    ]));
    query.observeResult({ modelUsage: { root: model(20, 10, 0.03), child: model(2, 1, 0.01) }, total_cost_usd: 0.04 });
    const last = query.observeResult({ modelUsage: { root: model(20, 10, 0.03), child: model(4, 2, 0.02) }, total_cost_usd: 0.05 })!;
    expect(last.cost).toBe(0.05);
    expect(last.nativeAccounting?.models).toEqual(expect.arrayContaining([
      expect.objectContaining({ modelId: "root", inputTokens: 20, outputTokens: 10, cost: 0.03 }),
      expect.objectContaining({ modelId: "child", inputTokens: 4, outputTokens: 2, cost: 0.01 })
    ]));
  });

  it("keeps fresh inclusive counters monotonic and duplicate results independent of request replays", () => {
    const query = new NativeQueryUsage(true);
    const first = { modelUsage: { root: model(10, 5, 0.02), child: model(2, 1, 0.01) }, total_cost_usd: 0.03 };
    const observed = query.observeResult(first)!;
    expect(observed).toMatchObject({ inputTokens: 12, outputTokens: 6, totalTokens: 18, cost: 0.03,
      nativeAccounting: { tokensComplete: true, costComplete: true, costEstimated: true } });
    expect(observed.nativeAccounting?.models).toEqual([
      { modelId: "root", inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 15, cost: 0.02, tokensComplete: true, costComplete: true },
      { modelId: "child", inputTokens: 2, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 3, cost: 0.01, tokensComplete: true, costComplete: true }
    ]);
    expect(query.observeResult(first)).toEqual(observed);
    expect(query.observeResult({ modelUsage: { root: model(20, 10, 0.04), child: model(2, 1, 0.01) }, total_cost_usd: 0.05 }))
      .toMatchObject({ totalTokens: 33, cost: 0.05 });
  });

  it("uses only current root and child requests on resume and gives reopened Queries independent identities", () => {
    const query = new NativeQueryUsage(false);
    const root = assistant("root-reply", "root", 10, 5), child = assistant("child-reply", "child", 2, 1);
    for (const frame of [root, root, child, child]) query.observeAssistant(frame);
    expect(query.observeResult({ modelUsage: { root: model(1010, 505, 2.02), child: model(1002, 501, 1.01) }, total_cost_usd: 3.03 }))
      .toMatchObject({ inputTokens: 12, outputTokens: 6, totalTokens: 18, cost: 0,
        nativeAccounting: { tokensComplete: false, costComplete: false, costEstimated: true } });
    query.observeAssistant(assistant("later-reply", "root", 10, 5));
    expect(query.observeResult({ modelUsage: { root: model(1020, 510, 2.04), child: model(1002, 501, 1.01) }, total_cost_usd: 3.05 }))
      .toMatchObject({ totalTokens: 33, cost: 0, nativeAccounting: { tokensComplete: true, costComplete: false } });
    const reopened = new NativeQueryUsage(false);
    expect(reopened.sourceId).not.toBe(query.sourceId);
    reopened.observeAssistant(root);
    expect(reopened.observeResult({ modelUsage: { root: model(1030, 515, 2.06) }, total_cost_usd: 3.07 }))
      .toMatchObject({ totalTokens: 15, cost: 0, nativeAccounting: { sourceId: reopened.sourceId } });
  });

  it("does not swallow saved counters when no inclusive current contribution is proved", () => {
    const query = new NativeQueryUsage(false);
    expect(query.observeResult({ modelUsage: { root: model(1000, 500, 2) }, total_cost_usd: 2 })).toBeUndefined();
    const other = new NativeQueryUsage(false);
    expect(other.observeResult({ usage: { input_tokens: 10, output_tokens: 5 },
      modelUsage: { root: model(1010, 505, 2.02) }, total_cost_usd: 2.02 }))
      .toMatchObject({ totalTokens: 15, cost: 0, nativeAccounting: { tokensComplete: false, costComplete: false } });
  });

  it("accepts first resumed native money only when independent requests prove the entire cumulative snapshot", () => {
    const query = new NativeQueryUsage(false);
    query.observeAssistant(assistant("reply", "root", 10, 5));
    expect(query.observeResult({ modelUsage: { root: model(10, 5, 0.02) }, total_cost_usd: 0.02 }))
      .toMatchObject({ totalTokens: 15, cost: 0.02, nativeAccounting: { tokensComplete: true, costComplete: true } });
  });

  it("does not count already observed first-turn output again when native settlement lags", () => {
    const fresh = new NativeQueryUsage(true);
    fresh.observeAssistant(assistant("fresh-first", "root", 10, 5));
    expect(fresh.observeResult({ modelUsage: { root: model(10, 0, 0.01) }, total_cost_usd: 0.01 }))
      .toMatchObject({ totalTokens: 15, outputTokens: 5, cost: 0, nativeAccounting: { tokensComplete: false, costComplete: false } });
    fresh.observeAssistant(assistant("fresh-second", "root", 10, 5));
    expect(fresh.observeResult({ modelUsage: { root: model(20, 10, 0.04) }, total_cost_usd: 0.04 }))
      .toMatchObject({ totalTokens: 30, outputTokens: 10, cost: 0, nativeAccounting: { tokensComplete: false, costComplete: false } });

    const query = new NativeQueryUsage(false);
    query.observeAssistant(assistant("first", "root", 10, 5));
    expect(query.observeResult({ modelUsage: { root: model(1010, 500, 2.01) }, total_cost_usd: 2.01 }))
      .toMatchObject({ totalTokens: 15, cost: 0 });
    query.observeAssistant(assistant("second", "root", 10, 5));
    expect(query.observeResult({ modelUsage: { root: model(1020, 510, 2.04) }, total_cost_usd: 2.04 }))
      .toMatchObject({ totalTokens: 30, outputTokens: 10, cost: 0, nativeAccounting: { tokensComplete: false, costComplete: false } });
    query.observeAssistant(assistant("third", "root", 10, 5));
    expect(query.observeResult({ modelUsage: { root: model(1030, 515, 2.06) }, total_cost_usd: 2.06 }))
      .toMatchObject({ totalTokens: 45, cost: 0, nativeAccounting: { costComplete: false } });
    query.observeAssistant(assistant("fourth", "root", 10, 5));
    expect(query.observeResult({ modelUsage: { root: model(1040, 520, 2.08) }, total_cost_usd: 2.08 }))
      .toMatchObject({ totalTokens: 60, cost: 0.02, nativeAccounting: { tokensComplete: true, costComplete: true } });
  });

  it("rebases rollback and missing result metadata without charging an unproven prefix", () => {
    const query = new NativeQueryUsage(false);
    query.observeAssistant(assistant("first", "root", 10, 5));
    query.observeResult({ modelUsage: { root: model(1000, 500, 2) }, total_cost_usd: 2 });
    query.observeAssistant(assistant("reset", "root", 20, 10));
    expect(query.observeResult({ modelUsage: { root: model(20, 10, 0.04) }, total_cost_usd: 0.04 }))
      .toMatchObject({ totalTokens: 45, cost: 0, nativeAccounting: { costComplete: false } });
    query.observeAssistant(assistant("missing", "root", 10, 5));
    expect(query.observeResult({ usage: { input_tokens: 10, output_tokens: 5 } }))
      .toMatchObject({ totalTokens: 60, nativeAccounting: { tokensComplete: false, costComplete: false } });
    query.observeAssistant(assistant("after-missing", "root", 10, 5));
    expect(query.observeResult({ modelUsage: { root: model(40, 20, 0.08) }, total_cost_usd: 0.08 }))
      .toMatchObject({ totalTokens: 75, cost: 0, nativeAccounting: { tokensComplete: false, costComplete: false } });
  });

  it("owns an observed native model key once across exact and context variant buckets", () => {
    for (const modelUsage of [
      { "root[1m]": model(1010, 505, 2.02) },
      { root: model(1010, 505, 2.02), "root[1m]": model(2000, 1000, 4) },
      { "root[1m]": model(1010, 505, 2.02), "root[2m]": model(2000, 1000, 4) }
    ]) {
      const query = new NativeQueryUsage(false);
      query.observeAssistant(assistant("current-root", "root", 10, 5));
      expect(query.observeResult({ modelUsage, total_cost_usd: 6.02 })).toMatchObject({ totalTokens: 15, cost: 0,
        nativeAccounting: { tokensComplete: false, costComplete: false } });
    }
  });

  it("treats an empty model snapshot as partial when the current main-loop usage is known", () => {
    const query = new NativeQueryUsage(false);
    expect(query.observeResult({ modelUsage: {}, usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 2 }))
      .toMatchObject({ totalTokens: 15, cost: 0, nativeAccounting: { tokensComplete: false, costComplete: false } });
  });
});
