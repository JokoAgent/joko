import { describe, expect, it } from "vitest";
import { catalogModelReferencePricing, knownModelTokenPrices, modelTokenPricesAt, selectModelReferenceTariff } from "./model-pricing.js";
import { providerRouteReferencePricing } from "./provider-route-pricing.js";
import type { ProviderModel } from "./types.js";

function model(id: string): ProviderModel {
  return { providerId: "official", modelId: id, displayName: id, api: "openai-responses", contextWindow: 1_000_000,
    maxOutputTokens: 128_000, supportsImages: true, thinkingLevels: [], cost: {}, pricing: catalogModelReferencePricing(id) };
}
const at = Date.UTC(2026, 9, 29);

describe("model reference pricing", () => {
  it("selects supplier-specific amounts at the published day and half-open token boundaries", () => {
    const route = { baseUrl: "https://open.bigmodel.cn/api/paas/v4", api: "openai-completions", modelId: "glm-4.6v", backend: "codex" as const };
    const model = { cost: {}, pricing: providerRouteReferencePricing(route) };
    const start = Date.UTC(2026, 10, 21);
    expect(model.pricing?.tariffs).toHaveLength(2);
    expect(model.pricing?.tariffs?.[0]).toMatchObject({ sourceUrl: "https://bigmodel.cn/pricing", verifiedAt: "2026-11-21" });
    expect(modelTokenPricesAt(model, { at: start - 1 })).toBeUndefined();
    expect(modelTokenPricesAt(model, { at: start, inputTokens: 31_999 })).toEqual({ currencyCode: "CNY", cost: { input: 1, output: 3 } });
    expect(modelTokenPricesAt(model, { at: start, inputTokens: 32_000 })?.cost).toEqual({ input: 2, output: 6 });
    expect(modelTokenPricesAt(model, { at: start, inputTokens: 128_000 })).toBeUndefined();
    expect(providerRouteReferencePricing({ ...route, baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4" })).toBeUndefined();
    expect(providerRouteReferencePricing({ ...route, api: "openai-responses" })).toBeUndefined();
  });

  it.each([
    ["https://open.bigmodel.cn/api/anthropic", "anthropic-messages", "claude-code", "zhipu-glm-cn", "CNY", false],
    ["https://api.z.ai/api/anthropic", "anthropic-messages", "claude-code", "zhipu-glm-global", "USD", false],
    ["https://open.bigmodel.cn/api/coding/paas/v4", "openai-completions", "pi", "zhipu-glm-cn", "CNY", true],
    ["https://api.z.ai/api/coding/paas/v4", "openai-completions", "pi", "zhipu-glm-global", "USD", true],
    ["https://api.z.ai/api/v1", "openai-responses", "codex", "zhipu-glm-global", "USD", true]
  ] as const)("qualifies the selected public product on a shared endpoint %s", (baseUrl, api, backend, catalogPresetId, currencyCode, selectedModelRoute) => {
    const route = { baseUrl, api, backend, modelId: "glm-5.3-flash", selectedModelRoute };
    expect(providerRouteReferencePricing({ ...route, catalogPresetId })).toMatchObject({ currencyCode });
    expect(providerRouteReferencePricing(route)).toBeUndefined();
    expect(providerRouteReferencePricing({ ...route, catalogPresetId: currencyCode === "CNY" ? "zhipu-coding-plan-cn" : "zai-coding-plan-global" })).toBeUndefined();
    expect(providerRouteReferencePricing({ ...route, catalogPresetId, requestPath: "/alternate" })).toBeUndefined();
    if (selectedModelRoute) expect(providerRouteReferencePricing({ ...route, catalogPresetId, selectedModelRoute: false })).toBeUndefined();
  });

  it("uses the supplier's direct price or its named regional group for the same upstream model", () => {
    const route = { api: "openai-completions", modelId: "kimi-k3", backend: "pi" as const };
    const quote = (baseUrl: string) => modelTokenPricesAt({ cost: {}, pricing: providerRouteReferencePricing({ ...route, baseUrl }) },
      { at: Date.UTC(2026, 10, 24) });
    expect(quote("https://tokenrhythm.studio/v1")).toEqual({ currencyCode: "CNY", cost: { input: 20, output: 100 } });
    expect(quote("https://api.moonshot.cn/v1")?.cost).toHaveProperty("cacheWrite1h");
    expect(quote("https://api.moonshot.ai/v1")?.currencyCode).toBe("USD");
    expect(quote("https://tokenrhythm.studio.example/v1")).toBeUndefined();
  });

  it.each([
    ["openai-api", "https://api.openai.com/v1", "openai-responses", "gpt-6.2-sol"],
    ["anthropic-api", "https://api.anthropic.com", "anthropic-messages", "claude-opus-5-5"],
    ["xai-api", "https://api.x.ai/v1", "openai-responses", "grok-4.7"]
  ])("resolves the direct API preset %s onto its published supplier", (catalogPresetId, baseUrl, api, modelId) => {
    const route = { baseUrl, api, modelId, backend: "pi" as const };
    expect(providerRouteReferencePricing({ ...route, catalogPresetId })).toMatchObject({ currencyCode: "USD", source: "providerReference" });
    expect(providerRouteReferencePricing({ ...route, catalogPresetId: "other-plan" })).toBeUndefined();
  });

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

  it("selects Gemini 4 Neon rates on their own effective days with their cache-read price", () => {
    const neon = model("google/gemini-4-neon"), tariffs = neon.pricing!.tariffs!;
    const launch = Date.UTC(2026, 10, 18), additional = Date.UTC(2026, 10, 20);
    expect(modelTokenPricesAt(neon, { at: launch - 1 })).toBeUndefined();
    expect(modelTokenPricesAt(neon, { at: launch })).toEqual({ currencyCode: "USD", cost: { input: 3, output: 15, cacheRead: 0.15 } });
    expect(modelTokenPricesAt(neon, { at: additional - 1, fastMode: true })).toBeUndefined();
    expect(modelTokenPricesAt(neon, { at: additional, fastMode: true })).toEqual({
      currencyCode: "USD", cost: { input: 5.4, output: 27, cacheRead: 0.27 }
    });
    for (const [variant, input, output, cacheRead] of [["batch", 1.5, 7.5, 0.075], ["priority", 5.4, 27, 0.27]] as const) {
      expect(selectModelReferenceTariff(tariffs, { at: additional - 1, variant })).toBeUndefined();
      expect(selectModelReferenceTariff(tariffs, { at: additional, variant })).toMatchObject({
        effectiveFrom: "2026-11-20", currencyCode: "USD", cost: { input, output, cacheRead }
      });
    }
    expect(catalogModelReferencePricing("google/gemini-4-neon", "cn")).toBeUndefined();
  });

  it("applies the GPT-6.2 Sol launch date and selects Standard, Fast and Batch independently", () => {
    const sol = model("openai/gpt-6.2-sol");
    const launch = Date.UTC(2026, 10, 17);
    expect(modelTokenPricesAt(sol, { at: launch - 1, inputTokens: 272_000 })).toBeUndefined();
    expect(modelTokenPricesAt(sol, { at: launch, inputTokens: 272_000 }))
      .toMatchObject({ currencyCode: "USD", cost: { input: 2, output: 10 } });
    expect(modelTokenPricesAt(sol, { at: launch, inputTokens: 272_001 }))
      .toMatchObject({ currencyCode: "USD", cost: { input: 4, output: 15 } });
    expect(modelTokenPricesAt(sol, { at: launch, inputTokens: 272_001, fastMode: true }))
      .toMatchObject({ currencyCode: "USD", cost: { input: 8, output: 30 } });
    expect(selectModelReferenceTariff(sol.pricing!.tariffs!, { at: launch, inputTokens: 272_001, variant: "batch" }))
      .toMatchObject({ currencyCode: "USD", cost: { input: 2, output: 7.5 } });
    expect(catalogModelReferencePricing("anthropic/gpt-6.2-sol")).toBeUndefined();
    expect(catalogModelReferencePricing("openai/unlisted-model")).toBeUndefined();
  });

  it.each([
    { group: "cn", currencyCode: "CNY", input: 20, cacheWrite1h: 40, batchInput: 12 },
    { group: "global", currencyCode: "USD", input: 3, cacheWrite1h: 6, batchInput: 1.8 }
  ])("closes the previous Kimi K3 window in $group before applying the new tariff", ({ group, currencyCode, input, cacheWrite1h, batchInput }) => {
    const pricing = catalogModelReferencePricing("moonshotai/kimi-k3", group)!;
    const kimi = { ...model("moonshotai/kimi-k3"), pricing };
    const change = Date.UTC(2026, 10, 5);
    const previous = selectModelReferenceTariff(pricing.tariffs!, { at: change - 1 });
    expect(previous).toMatchObject({ currencyCode, effectiveFrom: "2026-09-23", effectiveUntil: "2026-11-05", cost: { input } });
    expect(previous?.cost.cacheWrite1h).toBeUndefined();
    expect(modelTokenPricesAt(kimi, { at: change, cacheWriteTtl: "1h" }))
      .toMatchObject({ currencyCode, cost: { input, cacheWrite: cacheWrite1h } });
    const batch = Date.UTC(2026, 10, 7);
    expect(selectModelReferenceTariff(pricing.tariffs!, { at: batch - 1, variant: "batch" })).toBeUndefined();
    expect(selectModelReferenceTariff(pricing.tariffs!, { at: batch, variant: "batch" }))
      .toMatchObject({ currencyCode, cost: { input: batchInput } });
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
