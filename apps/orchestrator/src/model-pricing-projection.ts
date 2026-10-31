import { create } from "@bufbuild/protobuf";
import * as contract from "@joko/contracts";
import type { ModelReferenceTariff, ModelTokenPrices } from "@joko/core";

export function priceMicros(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0 || value * 1_000_000 > Number.MAX_SAFE_INTEGER) throw new Error("Model reference price is outside the supported range.");
  return Math.round(value * 1_000_000);
}

export function protoModelPrice(value: number | undefined): bigint | undefined {
  const micros = priceMicros(value);
  return micros === undefined ? undefined : BigInt(micros);
}

export function fromProtoModelPrice(value: bigint | undefined): number | undefined {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error("Model price is outside the supported range.");
  return number / 1_000_000;
}

export function toProtoModelReferenceTariff(price: ModelReferenceTariff): contract.ModelReferenceTariff {
  return create(contract.ModelReferenceTariffSchema, {
    currencyCode: price.currencyCode, variant: price.variant,
    inputCostMicrosPerMillion: protoModelPrice(price.cost.input), outputCostMicrosPerMillion: protoModelPrice(price.cost.output),
    cacheReadCostMicrosPerMillion: protoModelPrice(price.cost.cacheRead), cacheWriteCostMicrosPerMillion: protoModelPrice(price.cost.cacheWrite),
    cacheWrite1hCostMicrosPerMillion: protoModelPrice(price.cost.cacheWrite1h),
    minInputTokens: price.minInputTokens === undefined ? undefined : BigInt(price.minInputTokens),
    maxInputTokens: price.maxInputTokens === undefined ? undefined : BigInt(price.maxInputTokens),
    effectiveFrom: price.effectiveFrom, effectiveUntil: price.effectiveUntil, sourceUrl: price.sourceUrl, verifiedAt: price.verifiedAt
  });
}

export function fromProtoModelReferenceTariff(price: contract.ModelReferenceTariff): ModelReferenceTariff {
  if (!["standard", "priority", "batch", "fast"].includes(price.variant)
    || !/^[A-Z]{3}$/u.test(price.currencyCode) || !validDay(price.effectiveFrom) || !validDay(price.verifiedAt)
    || price.effectiveUntil !== undefined && (!validDay(price.effectiveUntil) || price.effectiveUntil <= price.effectiveFrom)) throw new Error("Invalid reference tariff.");
  const source = new URL(price.sourceUrl);
  if (source.protocol !== "https:" || source.username || source.password || price.sourceUrl.length > 2048) throw new Error("Invalid reference price source.");
  const bound = (value: bigint | undefined): number | undefined => {
    if (value === undefined) return undefined;
    const result = Number(value);
    if (!Number.isSafeInteger(result) || result < 0) throw new Error("Invalid reference price boundary.");
    return result;
  };
  const min = bound(price.minInputTokens), max = bound(price.maxInputTokens);
  if (min !== undefined && max !== undefined && min >= max) throw new Error("Invalid reference price interval.");
  return { currencyCode: price.currencyCode, variant: price.variant as ModelReferenceTariff["variant"],
    cost: fromProtoModelTokenPrices(price), minInputTokens: min, maxInputTokens: max,
    effectiveFrom: price.effectiveFrom, effectiveUntil: price.effectiveUntil, sourceUrl: price.sourceUrl, verifiedAt: price.verifiedAt };
}

export function fromProtoModelTokenPrices(price: {
  readonly inputCostMicrosPerMillion?: bigint; readonly outputCostMicrosPerMillion?: bigint;
  readonly cacheReadCostMicrosPerMillion?: bigint; readonly cacheWriteCostMicrosPerMillion?: bigint; readonly cacheWrite1hCostMicrosPerMillion?: bigint;
}): ModelTokenPrices {
  return { input: fromProtoModelPrice(price.inputCostMicrosPerMillion), output: fromProtoModelPrice(price.outputCostMicrosPerMillion),
    cacheRead: fromProtoModelPrice(price.cacheReadCostMicrosPerMillion), cacheWrite: fromProtoModelPrice(price.cacheWriteCostMicrosPerMillion),
    cacheWrite1h: fromProtoModelPrice(price.cacheWrite1hCostMicrosPerMillion) };
}

function validDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/u.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
