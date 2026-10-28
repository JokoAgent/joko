import { describe, expect, it } from "vitest";
import { catalogModelReferencePricing, knownModelTokenPrices, modelTokenPricesAt, selectModelReferenceTariff } from "./model-pricing.js";
import type { ProviderModel } from "./types.js";

function model(id: string): ProviderModel {
  return { providerId: "official", modelId: id, displayName: id, api: "openai-responses", contextWindow: 1_000_000,
    maxOutputTokens: 128_000, supportsImages: true, thinkingLevels: [], cost: {}, pricing: catalogModelReferencePricing(id) };
}
const at = Date.UTC(2026, 9, 29);

describe("model reference pricing", () => {
  it("keeps unknown fields distinct from explicitly free prices", () => {
    expect(knownModelTokenPrices({ input: -1, output: undefined, cacheRead: 0, cacheWrite: Number.NaN })).toEqual({ cacheRead: 0 });
    const unpriced = { ...model("private/model"), cost: {} };
    expect(modelTokenPricesAt(unpriced, { at })).toBeUndefined();
    expect(modelTokenPricesAt({ ...unpriced, cost: { input: 0 }, pricing: { source: "upstream", currencyCode: "USD" } }, { at })?.cost).toEqual({ input: 0 });
  });

  it("selects the request date at the exclusive end of a published price", () => {
    const flash = model("google/gemini-3.8-flash");
    expect(modelTokenPricesAt(flash, { at: Date.UTC(2026, 11, 31, 23, 59, 59) })?.cost.input).toBe(0.75);
    expect(modelTokenPricesAt(flash, { at: Date.UTC(2027, 0, 1) })?.cost.input).toBe(1.5);
    expect(modelTokenPricesAt(model("google/gemini-4-argon"), { at: Date.UTC(2026, 10, 30) })?.cost.input).toBe(2);
    expect(modelTokenPricesAt(model("google/gemini-4-argon"), { at: Date.UTC(2026, 11, 1) })?.cost.input).toBe(4);
    expect(modelTokenPricesAt(flash, { at: Date.UTC(2026, 8, 1) })).toBeUndefined();
  });

  it("uses different exact input boundaries for Standard and Fast and never multiplies twice", () => {
    const grok = model("xai/grok-4.7");
    expect(modelTokenPricesAt(grok, { at, inputTokens: 199_999 })?.cost.input).toBe(2);
    expect(modelTokenPricesAt(grok, { at, inputTokens: 200_000 })?.cost.input).toBe(4);
    expect(modelTokenPricesAt(grok, { at, inputTokens: 200_000, fastMode: true })?.cost.input).toBe(4);
    expect(modelTokenPricesAt(grok, { at, inputTokens: 200_001, fastMode: true })?.cost.input).toBe(6);
    const astra = model("openai/gpt-6-astra");
    expect(modelTokenPricesAt(astra, { at, inputTokens: 272_000 })?.cost.output).toBe(50);
    expect(modelTokenPricesAt(astra, { at, inputTokens: 272_001, fastMode: true })?.cost.output).toBe(150);
    expect(modelTokenPricesAt(grok, { at, fastMode: "ultrafast" })).toBeUndefined();
  });

  it("retains one-hour cache tariffs, market currencies and absent Fast prices", () => {
    const opus = model("claude-opus-5-5");
    expect(modelTokenPricesAt(opus, { at })?.cost.cacheWrite).toBe(5);
    expect(modelTokenPricesAt(opus, { at, cacheWriteTtl: "1h" })?.cost.cacheWrite).toBe(8);
    expect(modelTokenPricesAt(opus, { at, cacheWriteTtl: "1h", fastMode: true })?.cost.cacheWrite).toBe(16);
    const cn = { ...model("kimi-k3"), pricing: catalogModelReferencePricing("kimi-k3", "cn") };
    expect(modelTokenPricesAt(cn, { at })).toMatchObject({ currencyCode: "CNY", cost: { input: 20 } });
    expect(modelTokenPricesAt(model("google/gemini-3.8-flash"), { at, fastMode: true })).toBeUndefined();
  });

  it("does not resolve private namespaces, ambiguous prices or withdrawn tariffs", () => {
    expect(catalogModelReferencePricing("private/gpt-6-astra")).toBeUndefined();
    expect(catalogModelReferencePricing("openai/claude-opus-5-5")).toBeUndefined();
    expect(catalogModelReferencePricing("anthropic/claude-opus-5-5")).toEqual(catalogModelReferencePricing("claude-opus-5-5"));
    const original = model("claude-opus-5-5"), tariff = original.pricing!.tariffs![0]!;
    expect(selectModelReferenceTariff([tariff, tariff], { at })).toBeUndefined();
    expect(modelTokenPricesAt({ ...original, cost: { input: 4, output: 20 }, pricing: { ...original.pricing!, tariffs: [] } }, { at })).toBeUndefined();
  });
});
