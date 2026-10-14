import { describe, expect, it } from "vitest";
import { NativeQueryUsage } from "./native-query-usage.js";

const model = (inputTokens: number, outputTokens: number, costUSD: number) =>
  ({ inputTokens, outputTokens, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD });
const assistant = (id: string, name: string, input: number, output: number) => ({ message: {
  id, model: name, usage: { input_tokens: input, output_tokens: output }
} });

describe("native Query accounting", () => {
  it("keeps fresh inclusive counters monotonic and duplicate results independent of request replays", () => {
    const query = new NativeQueryUsage(true);
    const first = { modelUsage: { root: model(10, 5, 0.02), child: model(2, 1, 0.01) }, total_cost_usd: 0.03 };
    const observed = query.observeResult(first)!;
    expect(observed).toMatchObject({ inputTokens: 12, outputTokens: 6, totalTokens: 18, cost: 0.03,
      nativeAccounting: { tokensComplete: true, costComplete: true, costEstimated: true } });
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
