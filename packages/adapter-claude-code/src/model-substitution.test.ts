import { describe, expect, it } from "vitest";
import { NativeModelUsageObserver } from "./model-substitution.js";

const usage = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
const assistant = (model: string, input = 10, output = 5) => ({ model, usage: { input_tokens: input, output_tokens: output } });

describe("native model substitutions", () => {
  it("uses current observed models on resume, then exact cumulative deltas without inheriting historical models", () => {
    const observer = new NativeModelUsageObserver();
    observer.observeAssistant(assistant("claude-opus-4-8-20260901"));
    const first = { "claude-fable-5": usage(100, 100), "claude-opus-4-8-20260901": usage(10, 5) };
    expect(observer.observe(first, "claude-fable-5")).toEqual({ selectedModelId: "claude-fable-5", actualModelId: "claude-opus-4-8-20260901" });
    expect(observer.observe(first, "claude-fable-5")).toBeUndefined();
    expect(observer.observe({ ...first, "claude-opus-4-8-20260901": usage(20, 10) }, "claude-fable-5"))
      .toMatchObject({ actualModelId: "claude-opus-4-8-20260901" });
  });
  it("does not confuse aliases, children, foreign model families, missing usage or counter resets with substitution", () => {
    const observer = new NativeModelUsageObserver();
    observer.observeAssistant(assistant("us.anthropic.claude-sonnet-4-5-20260901"));
    observer.observeAssistant(assistant("claude-haiku-4-5", 1, 1));
    expect(observer.observe({ "us.anthropic.claude-sonnet-4-5-20260901": usage(10, 5), "claude-haiku-4-5": usage(1, 1) }, "claude-sonnet-4.5[1m]"))
      .toBeUndefined();
    expect(observer.observe({ "claude-haiku-4-5": usage(0, 0) }, "claude-sonnet-4-5")).toBeUndefined();
    observer.observeAssistant(assistant("claude-haiku-4-5"));
    expect(observer.observe(undefined, "claude-sonnet-4-5")).toBeUndefined();
    expect(observer.observe({ "claude-haiku-4-5": usage(1, 1) }, "claude-sonnet-4-5")).toBeUndefined();
    observer.observeAssistant(assistant("claude-haiku-4-5"));
    expect(observer.observe({ "claude-haiku-4-5": usage(10, 5) }, "gateway-model")).toBeUndefined();
  });
});
