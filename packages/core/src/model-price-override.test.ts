import { describe, expect, it } from "vitest";
import { captureModelPriceReference, createModelPriceOverrideValues, modelPriceOverrideConflict, modelPricesWithOverride, validateModelPriceOverrideValues } from "./model-price-override.js";
import { catalogModelReferencePricing } from "./model-pricing.js";
import type { ProviderModel } from "./types.js";

const at = Date.UTC(2026, 9, 29);
const model: Pick<ProviderModel, "cost" | "pricing"> = {
  cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  pricing: { source: "providerReference", currencyCode: "USD", fastModeMultiplier: 2,
    longContext: { inputTokenThreshold: 100, inputMultiplier: 2, outputMultiplier: 1.5, cacheReadMultiplier: 2, cacheWriteMultiplier: 2 } }
};

describe("sparse model price overrides", () => {
  it("follows refreshed fields while retaining an edited input and an explicit cache removal", () => {
    const baseReference = captureModelPriceReference(model, at);
    const values = createModelPriceOverrideValues({ currencyCode: "USD", cost: { input: 3, output: 10, cacheWrite: 2.5 } }, baseReference);
    expect(values).toEqual({ input: 3, cacheRead: null });
    const override = { values, baseReference };
    const refreshed = { ...model, cost: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 } };
    expect(modelPricesWithOverride(refreshed, override, { at })?.cost).toMatchObject({ input: 3, output: 20, cacheWrite: 5 });
    expect(modelPricesWithOverride(refreshed, override, { at })?.cost.cacheRead).toBeUndefined();
    expect(modelPriceOverrideConflict(model, override, at)).toBe(false);
    expect(modelPriceOverrideConflict(refreshed, override, at)).toBe(true);
    expect(createModelPriceOverrideValues({ currencyCode: "USD", cost: refreshed.cost }, captureModelPriceReference(refreshed, at))).toEqual({});
  });

  it("keeps context multipliers when the current reference omits its previous bands", () => {
    const override = { values: { input: 3 }, baseReference: captureModelPriceReference(model, at) };
    const fallback = { cost: { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 }, pricing: { source: "upstream" as const, currencyCode: "USD" } };
    expect(modelPricesWithOverride(fallback, override, { at, inputTokens: 100 })?.cost).toEqual({ input: 3, output: 20, cacheRead: 0.4, cacheWrite: 5 });
    expect(modelPricesWithOverride(fallback, override, { at, inputTokens: 101 })?.cost).toEqual({ input: 6, output: 30, cacheRead: 0.8, cacheWrite: 10 });
  });

  it("keeps user numbers in their saved currency after a reference withdrawal or currency change", () => {
    const override = { values: { input: 3 }, baseReference: captureModelPriceReference(model, at) };
    const withdrawn = { ...model, pricing: { ...model.pricing!, tariffs: [] } };
    const otherCurrency = { ...model, pricing: { ...model.pricing!, currencyCode: "CNY" } };
    for (const current of [withdrawn, otherCurrency]) {
      expect(modelPricesWithOverride(current, override, { at, inputTokens: 101 })).toMatchObject({ currencyCode: "USD", cost: { input: 6, output: 15 } });
      expect(modelPriceOverrideConflict(current, override, at)).toBe(true);
    }
    expect(modelPricesWithOverride(withdrawn, undefined, { at })).toBeUndefined();
  });

  it("treats a currency edit as a complete quote and never relabels an independent Fast price", () => {
    const baseReference = captureModelPriceReference(model, at);
    const values = createModelPriceOverrideValues({ currencyCode: "CNY", cost: { input: 7, output: 21 } }, baseReference);
    expect(values).toEqual({ currencyCode: "CNY", input: 7, output: 21, cacheRead: null, cacheWrite: null });
    expect(modelPricesWithOverride(model, { values, baseReference }, { at, inputTokens: 101 }))
      .toMatchObject({ currencyCode: "CNY", cost: { input: 14, output: 31.5 } });
    expect(modelPricesWithOverride(model, { values, baseReference }, { at, fastMode: true })).toBeUndefined();
    expect(() => validateModelPriceOverrideValues({ currencyCode: "CNY", input: 7 })).toThrow("complete quote");
  });

  it("preserves the separate Fast and one-hour cache tariffs", () => {
    const opus = { cost: {}, pricing: catalogModelReferencePricing("claude-opus-5-5") };
    const baseReference = captureModelPriceReference(opus, at);
    const values = createModelPriceOverrideValues({ currencyCode: "USD", cost: { input: 6, output: 20, cacheRead: 0.4, cacheWrite: 10 } }, baseReference);
    expect(modelPricesWithOverride(opus, { values, baseReference }, { at, cacheWriteTtl: "1h" })?.cost.cacheWrite).toBe(16);
    expect(modelPricesWithOverride(opus, { values, baseReference }, { at, fastMode: true, cacheWriteTtl: "1h" })?.cost)
      .toMatchObject({ input: 8, output: 40, cacheWrite: 16 });
    const withdrawn = { ...opus, pricing: { ...opus.pricing!, tariffs: [] } };
    expect(modelPricesWithOverride(withdrawn, { values, baseReference }, { at, fastMode: true })).toBeUndefined();
    expect(modelPricesWithOverride(withdrawn, { values, baseReference }, { at })?.cost.input).toBe(6);
    expect(modelPricesWithOverride(opus, { values: { cacheWrite: null }, baseReference }, { at, cacheWriteTtl: "1h" })?.cost.cacheWrite).toBeUndefined();
  });

  it("selects unedited fields at the request date and owns its saved price snapshot", () => {
    const flash = { cost: {}, pricing: catalogModelReferencePricing("google/gemini-3.8-flash") };
    const baseReference = captureModelPriceReference(flash, at)!;
    const values = createModelPriceOverrideValues({ currencyCode: "USD", cost: { input: 1, output: 3.75, cacheRead: 0.075 } }, baseReference);
    const before = modelPricesWithOverride(flash, { values, baseReference }, { at: Date.UTC(2026, 11, 31) });
    const after = modelPricesWithOverride(flash, { values, baseReference }, { at: Date.UTC(2027, 0, 1) });
    expect(before?.cost.input).toBe(1);
    expect(after?.cost.input).toBe(1);
    expect(after?.cost.output).toBe(7.5);
    expect(baseReference.model.pricing?.tariffs).not.toBe(flash.pricing?.tariffs);
    expect(() => validateModelPriceOverrideValues({ input: Number.NaN })).toThrow();
  });
});
