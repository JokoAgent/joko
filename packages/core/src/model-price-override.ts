import { knownModelTokenPrices, modelTokenPricesAt } from "./model-pricing.js";
import type { ModelTokenPrices, ProviderModel } from "./types.js";

type PriceModel = Pick<ProviderModel, "cost" | "pricing">;
type PriceInput = Parameters<typeof modelTokenPricesAt>[1];
const fields = ["input", "output", "cacheRead", "cacheWrite"] as const;

/** Missing fields inherit; null explicitly removes a cache quote. */
export interface ModelPriceOverrideValues {
  readonly currencyCode?: "USD" | "CNY";
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number | null;
  readonly cacheWrite?: number | null;
}

/** Only price facts, never a route, membership grant or live accounting state. */
export interface ModelPriceReferenceSnapshot {
  readonly at: number;
  readonly model: PriceModel;
}

export interface ModelPriceOverride {
  readonly values: ModelPriceOverrideValues;
  readonly baseReference?: ModelPriceReferenceSnapshot;
}

export function captureModelPriceReference(model: PriceModel | undefined, at: number): ModelPriceReferenceSnapshot | undefined {
  if (!Number.isSafeInteger(at) || at < 0 || at > 8_640_000_000_000_000) throw new Error("Invalid model price reference time.");
  if (model === undefined) return undefined;
  const quote = priceAt(model, { at });
  if (quote === undefined || !Object.values(quote.cost).some(value => value !== undefined)) return undefined;
  return { at, model: { cost: knownModelTokenPrices(model.cost),
    ...(model.pricing === undefined ? {} : { pricing: structuredClone(model.pricing) }) } };
}

export function validateModelPriceOverrideValues(values: ModelPriceOverrideValues): ModelPriceOverrideValues {
  if (values === null || typeof values !== "object" || Array.isArray(values)
    || Object.keys(values).some(key => !["currencyCode", ...fields].includes(key))
    || values.currencyCode !== undefined && values.currencyCode !== "USD" && values.currencyCode !== "CNY") {
    throw new Error("Invalid model price override.");
  }
  const result: { currencyCode?: "USD" | "CNY"; input?: number; output?: number; cacheRead?: number | null; cacheWrite?: number | null } = {};
  if (values.currencyCode !== undefined) result.currencyCode = values.currencyCode;
  for (const field of fields) {
    const value = values[field];
    if (value === undefined) continue;
    if (value === null && (field === "cacheRead" || field === "cacheWrite")) { result[field] = null; continue; }
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value * 1_000_000 > Number.MAX_SAFE_INTEGER) {
      throw new Error("Invalid model price override value.");
    }
    result[field] = value;
  }
  if (result.currencyCode !== undefined && (result.input === undefined || result.output === undefined
    || result.cacheRead === undefined || result.cacheWrite === undefined)) throw new Error("A currency override requires a complete quote.");
  return result;
}

export function createModelPriceOverrideValues(
  desired: { readonly currencyCode: "USD" | "CNY"; readonly cost: ModelTokenPrices },
  reference: ModelPriceReferenceSnapshot | undefined
): ModelPriceOverrideValues {
  if (desired.cost.input === undefined || desired.cost.output === undefined) throw new Error("Input and output prices are required.");
  const base = reference === undefined ? undefined : priceAt(reference.model, { at: reference.at });
  const complete = base === undefined || desired.currencyCode !== base.currencyCode;
  return validateModelPriceOverrideValues({
    ...(complete ? { currencyCode: desired.currencyCode } : {}),
    ...Object.fromEntries(fields.flatMap(field => {
      const value = desired.cost[field] ?? null;
      return complete || value !== (base?.cost[field] ?? null) ? [[field, value]] : [];
    }))
  });
}

export function modelPriceOverrideConflict(model: PriceModel | undefined, override: ModelPriceOverride, at: number): boolean {
  return JSON.stringify(comparable(model, at)) !== JSON.stringify(comparable(override.baseReference?.model, override.baseReference?.at ?? at));
}

/** Resolve at the observation's date. Historical ledger rows are never rewritten. */
export function modelPricesWithOverride(model: PriceModel | undefined, override: ModelPriceOverride | undefined, input: PriceInput) {
  if (override === undefined) return model === undefined ? undefined : priceAt(model, input);
  if (input.fastMode === "ultrafast") return undefined;
  const currentBase = model === undefined ? undefined : priceAt(model, { at: input.at });
  const saved = override.baseReference;
  const savedBase = saved === undefined ? undefined : priceAt(saved.model, { at: saved.at });
  const useSaved = savedBase !== undefined && (currentBase === undefined
    || override.values.currencyCode === undefined && currentBase.currencyCode !== savedBase.currencyCode);
  const source = useSaved ? saved?.model : model;
  const at = useSaved ? saved!.at : input.at;
  const base = useSaved ? savedBase : currentBase;
  const currencyCode = override.values.currencyCode ?? base?.currencyCode;
  if (currencyCode === undefined) return undefined;
  if (input.fastMode === true) {
    // The saved Standard reference never revives a withdrawn independent Fast quote.
    const fast = model === undefined || currentBase?.currencyCode !== currencyCode ? undefined : priceAt(model, input);
    return fast?.currencyCode === currencyCode ? fast : undefined;
  }
  let selected = source === undefined ? undefined : priceAt(source, { ...input, at, cacheWriteTtl: "5m" });
  // A lower-fidelity same-currency catalog may omit its former context bands.
  // Keep their ratios while unedited baselines continue to follow the new quote.
  if (!useSaved && override.values.currencyCode === undefined && saved !== undefined && savedBase !== undefined
    && currentBase?.currencyCode === savedBase.currencyCode && hasBands(saved.model, saved.at) && !hasBands(model, input.at)) {
    const prior = priceAt(saved.model, { ...input, at: saved.at, cacheWriteTtl: "5m" });
    if (prior !== undefined) selected = { currencyCode, cost: Object.fromEntries(
      Object.entries(prior.cost).map(([key, value]) => {
        const oldBase = savedBase.cost[key as keyof ModelTokenPrices];
        const nextBase = currentBase.cost[key as keyof ModelTokenPrices];
        return [key, oldBase !== undefined && oldBase > 0 && nextBase !== undefined ? value / oldBase * nextBase : value];
      })
    ) };
  }
  const cost: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cacheWrite1h?: number } = { ...selected?.cost };
  for (const field of fields) {
    const value = override.values[field];
    if (value === undefined) continue;
    if (value === null) delete cost[field];
    else cost[field] = project(selected?.cost[field], base?.cost[field], value) ?? value;
  }
  if (override.values.cacheWrite === null) delete cost.cacheWrite1h;
  else if (override.values.cacheWrite !== undefined) {
    // Editing the short TTL price preserves a known long-TTL ratio, not a 1:1 guess.
    cost.cacheWrite1h = selected?.cost.cacheWrite1h === undefined ? undefined
      : project(selected.cost.cacheWrite1h, base?.cost.cacheWrite, override.values.cacheWrite);
  }
  if (input.cacheWriteTtl === "1h") cost.cacheWrite = cost.cacheWrite1h;
  return { currencyCode, cost };
}

function priceAt(model: PriceModel, input: PriceInput) {
  const quote = modelTokenPricesAt(model, input);
  if (quote === undefined) return undefined;
  const oneHour = modelTokenPricesAt(model, { ...input, cacheWriteTtl: "1h" })?.cost.cacheWrite;
  const cost = knownModelTokenPrices({ ...quote.cost, cacheWrite1h: oneHour });
  return Object.keys(cost).length === 0 ? undefined : { currencyCode: quote.currencyCode, cost };
}

function project(selected: number | undefined, base: number | undefined, desired: number | undefined): number | undefined {
  if (selected === undefined || desired === undefined) return undefined;
  return base !== undefined && base > 0 ? selected / base * desired : desired;
}

function currentBands(model: PriceModel | undefined, at: number) {
  const day = new Date(at).toISOString().slice(0, 10);
  return model?.pricing?.tariffs?.filter(tariff => tariff.variant === "standard"
    && tariff.currencyCode === model.pricing?.currencyCode && tariff.effectiveFrom <= day
    && (tariff.effectiveUntil === undefined || day < tariff.effectiveUntil))
    .map(tariff => ({ minInputTokens: tariff.minInputTokens ?? 0, maxInputTokens: tariff.maxInputTokens, cost: knownModelTokenPrices(tariff.cost) }));
}

function hasBands(model: PriceModel | undefined, at: number): boolean {
  return model?.pricing?.tariffs === undefined ? model?.pricing?.longContext !== undefined
    : currentBands(model, at)?.some(band => band.minInputTokens > 0 || band.maxInputTokens !== undefined) === true;
}

function comparable(model: PriceModel | undefined, at: number) {
  const base = model === undefined ? undefined : priceAt(model, { at });
  if (base === undefined) return null;
  const bands = currentBands(model, at);
  const long = model?.pricing?.longContext;
  return { ...base, ...(bands === undefined ? { longContext: long === undefined ? undefined : {
    inputTokenThreshold: long.inputTokenThreshold, inputMultiplier: long.inputMultiplier, outputMultiplier: long.outputMultiplier,
    cacheReadMultiplier: long.cacheReadMultiplier, cacheWriteMultiplier: long.cacheWriteMultiplier
  } } : { bands }) };
}
