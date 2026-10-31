import type { ModelReferenceTariff, ModelTokenPrices, ProviderModel } from "./types.js";
import referencePrices from "./model-reference-prices.json" with { type: "json" };

const fields = ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h"] as const;

/** Exact public identity only; callers must establish the supplier and market. */
export function catalogModelReferencePricing(modelId: string, groupId = "global"): ProviderModel["pricing"] {
  const separator = modelId.indexOf("/");
  const family = separator < 0 ? undefined : modelId.slice(0, separator + 1);
  const alias = separator < 0 ? modelId : modelId.slice(separator + 1);
  const matches = referencePrices.models.filter(model => model.id === modelId
    || (family === undefined || model.id.startsWith(family))
      && (model.aliases.includes(modelId) || model.aliases.includes(alias)));
  if (matches.length !== 1) return undefined;
  const tariffs = matches[0]!.groups.find(group => group.id === groupId)?.tariffs as readonly ModelReferenceTariff[] | undefined;
  if (tariffs === undefined || tariffs.length === 0) return undefined;
  const currencies = new Set(tariffs.map(price => price.currencyCode));
  if (currencies.size !== 1) return undefined;
  return { source: "providerReference", currencyCode: tariffs[0]!.currencyCode,
    updatedAt: Date.parse(referencePrices.updatedAt), tariffs };
}

/** Normalize native unknown-price sentinels without turning them into free quotes. */
export function knownModelTokenPrices(value: Partial<Record<keyof ModelTokenPrices, unknown>> | undefined): ModelTokenPrices {
  return Object.fromEntries(fields.flatMap(field => {
    const price = value?.[field];
    return typeof price === "number" && Number.isFinite(price) && price >= 0 ? [[field, price]] : [];
  }));
}

export function selectModelReferenceTariff(
  tariffs: readonly ModelReferenceTariff[],
  input: { readonly at: number; readonly inputTokens?: number; readonly variant?: ModelReferenceTariff["variant"]; readonly currencyCode?: string }
): ModelReferenceTariff | undefined {
  if (!Number.isFinite(input.at) || Math.abs(input.at) > 8_640_000_000_000_000
    || input.inputTokens !== undefined && (!Number.isSafeInteger(input.inputTokens) || input.inputTokens < 0)) return undefined;
  const day = new Date(input.at).toISOString().slice(0, 10);
  const matches = tariffs.filter(price => price.variant === (input.variant ?? "standard")
    && (input.currencyCode === undefined || price.currencyCode === input.currencyCode)
    && price.effectiveFrom <= day && (price.effectiveUntil === undefined || day < price.effectiveUntil)
    && (input.inputTokens === undefined
      ? price.minInputTokens === undefined || price.minInputTokens === 0
      : (price.minInputTokens === undefined || input.inputTokens >= price.minInputTokens)
        && (price.maxInputTokens === undefined || input.inputTokens < price.maxInputTokens)));
  return matches.length === 1 ? matches[0] : undefined;
}

/** Returns one complete tariff selection. Never blend bands, currencies or variants. */
export function modelTokenPricesAt(model: ProviderModel, input: {
  readonly at: number;
  readonly inputTokens?: number;
  readonly fastMode?: boolean | "ultrafast";
  readonly cacheWriteTtl?: "5m" | "1h";
}): { readonly cost: ModelTokenPrices; readonly currencyCode: string } | undefined {
  if (input.fastMode === "ultrafast") return undefined;
  const pricing = model.pricing;
  if (pricing?.tariffs !== undefined) {
    const tariff = selectModelReferenceTariff(pricing.tariffs, { at: input.at, inputTokens: input.inputTokens,
      variant: input.fastMode === true ? "fast" : "standard", currencyCode: pricing.currencyCode });
    if (tariff === undefined) return undefined;
    return { currencyCode: tariff.currencyCode, cost: { ...tariff.cost,
      ...(input.cacheWriteTtl === "1h" ? { cacheWrite: tariff.cost.cacheWrite1h } : {}) } };
  }
  // A legacy all-zero placeholder without provenance is not a free quote.
  if (pricing === undefined && !Object.values(model.cost).some(value => value !== undefined && value > 0)) return undefined;
  const band = pricing?.longContext;
  const threshold = input.fastMode === true ? band?.fastInputTokenThreshold ?? band?.inputTokenThreshold : band?.inputTokenThreshold;
  const tier = input.inputTokens !== undefined && threshold !== undefined && input.inputTokens > threshold ? band : undefined;
  const fast = input.fastMode === true ? tier?.fastModeMultiplier ?? pricing?.fastModeMultiplier ?? 1 : 1;
  const cost = knownModelTokenPrices(model.cost);
  return { currencyCode: pricing?.currencyCode ?? "USD", cost: {
    ...(cost.input === undefined ? {} : { input: cost.input * fast * (tier?.inputMultiplier ?? 1) }),
    ...(cost.output === undefined ? {} : { output: cost.output * fast * (tier?.outputMultiplier ?? 1) }),
    ...(cost.cacheRead === undefined || pricing?.cacheReadAvailable === false ? {} : { cacheRead: cost.cacheRead * fast * (tier?.cacheReadMultiplier ?? 1) }),
    ...((input.cacheWriteTtl === "1h" ? cost.cacheWrite1h : cost.cacheWrite) === undefined || pricing?.cacheWriteAvailable === false ? {} : {
      cacheWrite: (input.cacheWriteTtl === "1h" ? cost.cacheWrite1h! : cost.cacheWrite!) * fast * (tier?.cacheWriteMultiplier ?? 1)
    })
  } };
}
