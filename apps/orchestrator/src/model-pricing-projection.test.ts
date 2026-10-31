import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { ModelDescriptorSchema, UsageSchema } from "@joko/contracts";
import { catalogModelReferencePricing, modelTokenPricesAt, type ProviderModel } from "@joko/core";
import { describe, expect, it } from "vitest";
import { toProtoModelDescriptor, toProtoUsage } from "./proto-mapper.js";
import { fromProtoModelReferenceTariff, fromProtoModelTokenPrices } from "./model-pricing-projection.js";

const model: ProviderModel = { providerId: "official", modelId: "claude-opus-5-5", displayName: "Opus", api: "anthropic-messages",
  contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsImages: true, thinkingLevels: [], cost: {} };

describe("reference price contract", () => {
  it("retains request-time pricing facts in the usage wire contract", () => {
    const value = toProtoUsage({ inputTokens: 10, outputTokens: 1, cacheReadTokens: 4, cacheWriteTokens: 6, totalTokens: 21, cost: 0,
      pricingContext: { inputTokens: 20, requestedAt: Date.UTC(2026, 9, 29), fastMode: true, cacheWrite1hTokens: 3 } });
    expect(fromBinary(UsageSchema, toBinary(UsageSchema, value)).pricingContext).toMatchObject({
      inputTokens: 20n, speed: "fast", cacheWrite1hTokens: 3n, requestedAt: { seconds: BigInt(Date.UTC(2026, 9, 29) / 1000), nanos: 0 }
    });
  });
  it("round trips unknown and free fields independently", () => {
    const wire = create(ModelDescriptorSchema, toProtoModelDescriptor("backend", { ...model, cost: { cacheRead: 0 }, pricing: { source: "upstream", currencyCode: "USD" } }));
    const decoded = fromBinary(ModelDescriptorSchema, toBinary(ModelDescriptorSchema, wire));
    expect(decoded.inputCostMicrosPerMillion).toBeUndefined();
    expect(decoded.outputCostMicrosPerMillion).toBeUndefined();
    expect(decoded.cacheReadCostMicrosPerMillion).toBe(0n);
    expect(fromProtoModelTokenPrices(decoded)).toMatchObject({ input: undefined, output: undefined, cacheRead: 0, cacheWrite: undefined });
  });

  it("keeps complete tariffs through the same projection used by remote and shared sources", () => {
    const original = { ...model, pricing: catalogModelReferencePricing(model.modelId) };
    const wire = create(ModelDescriptorSchema, toProtoModelDescriptor("backend", original));
    const decoded = fromBinary(ModelDescriptorSchema, toBinary(ModelDescriptorSchema, wire));
    const tariffs = decoded.referenceTariffs!.values.map(fromProtoModelReferenceTariff);
    expect(tariffs).toEqual(original.pricing!.tariffs);
    const remote = { ...model, cost: fromProtoModelTokenPrices(decoded), pricing: { ...original.pricing!, tariffs } };
    expect(modelTokenPricesAt(remote, { at: Date.UTC(2026, 9, 29), fastMode: true, cacheWriteTtl: "1h" })?.cost.cacheWrite).toBe(16);
  });

  it("preserves an explicit tariff withdrawal separately from absent metadata", () => {
    const absent = fromBinary(ModelDescriptorSchema, toBinary(ModelDescriptorSchema, toProtoModelDescriptor("backend", model)));
    const withdrawn = fromBinary(ModelDescriptorSchema, toBinary(ModelDescriptorSchema, toProtoModelDescriptor("backend", {
      ...model, cost: { input: 4, output: 20 }, pricing: { source: "providerReference", currencyCode: "USD", tariffs: [] }
    })));
    expect(absent.referenceTariffs).toBeUndefined();
    expect(withdrawn.referenceTariffs?.values).toEqual([]);
    expect(withdrawn.inputCostMicrosPerMillion).toBeUndefined();
  });
});
