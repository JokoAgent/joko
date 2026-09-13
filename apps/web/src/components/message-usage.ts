import type { TimelineMessageUsageView } from "../model.js";
import type { Translator } from "./types.js";

const COMPACT_TOKEN_UNITS: ReadonlyArray<{ readonly divisor: number; readonly suffix: string }> = [
  { divisor: 1_000, suffix: "k" },
  { divisor: 1_000_000, suffix: "M" },
  { divisor: 1_000_000_000, suffix: "B" }
];
const UNIT_CARRY_THRESHOLD = 999.95;
const LOW_CACHE_MIN_INPUT_TOKENS = 50_000;
const LOW_CACHE_MAX_HIT_RATE = 0.2;

export interface MessageUsagePresentation {
  readonly label: string;
  readonly tooltipLines: readonly string[];
}

export function formatCompactUsageTokens(value: number): string {
  const normalized = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
  if (normalized < COMPACT_TOKEN_UNITS[0]!.divisor) return String(normalized);
  for (const unit of COMPACT_TOKEN_UNITS) {
    const scaled = normalized / unit.divisor;
    if (scaled < UNIT_CARRY_THRESHOLD) return `${scaled.toFixed(1)}${unit.suffix}`;
  }
  const largest = COMPACT_TOKEN_UNITS.at(-1)!;
  return `${(normalized / largest.divisor).toFixed(1)}${largest.suffix}`;
}

export function formatMessageTurnCost(cost: number, currency: string): string {
  const normalized = Number.isFinite(cost) ? Math.max(0, cost) : 0;
  const code = currency.trim().toUpperCase() || "USD";
  const prefix = code === "USD" ? "$" : code === "CNY" ? "¥" : `${code} `;
  if (normalized > 0 && normalized < 0.01) return `<${prefix}0.01`;
  return `${prefix}${normalized.toFixed(2)}`;
}

export function messageUsagePresentation(
  usage: TimelineMessageUsageView | undefined,
  t: Translator
): MessageUsagePresentation | undefined {
  if (usage === undefined) return undefined;
  const input = usageToken(usage.inputTokens);
  const output = usageToken(usage.outputTokens);
  const cacheRead = usageToken(usage.cacheReadTokens);
  const cacheWrite = usageToken(usage.cacheWriteTokens);
  const total = usageToken(usage.totalTokens);
  const cost = Number.isFinite(usage.cost) ? Math.max(0, usage.cost) : 0;
  if (total === 0 && cost === 0) return undefined;

  const formattedCost = cost > 0 ? formatMessageTurnCost(cost, usage.currency) : undefined;
  const tooltipLines: string[] = [];
  if (formattedCost !== undefined) tooltipLines.push(t("timeline.usageCostLine", { cost: formattedCost }));
  tooltipLines.push(t("timeline.usageTokenLine", {
    total: formatCompactUsageTokens(total),
    input: formatCompactUsageTokens(input),
    output: formatCompactUsageTokens(output)
  }));

  const cacheDenominator = input + cacheRead + cacheWrite;
  const cacheHitRate = cacheDenominator > 0 ? cacheRead / cacheDenominator : undefined;
  tooltipLines.push(cacheHitRate === undefined
    ? t("timeline.usageCacheLineNoRate", {
      read: formatCompactUsageTokens(cacheRead),
      write: formatCompactUsageTokens(cacheWrite)
    })
    : t("timeline.usageCacheLine", {
      read: formatCompactUsageTokens(cacheRead),
      write: formatCompactUsageTokens(cacheWrite),
      rate: formatUsagePercent(cacheHitRate)
    }));
  if (cacheDenominator >= LOW_CACHE_MIN_INPUT_TOKENS && cacheHitRate !== undefined && cacheHitRate < LOW_CACHE_MAX_HIT_RATE) {
    tooltipLines.push(t("timeline.usageSuggestionLine", { suggestion: t("timeline.usageLowCacheSuggestion") }));
  }
  if (formattedCost === undefined) tooltipLines.push(t("timeline.usageNoBilledCost"));
  return {
    label: formattedCost ?? t("timeline.usageTokens", { tokens: formatCompactUsageTokens(total) }),
    tooltipLines
  };
}

function usageToken(value: number): number {
  return Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
}

function formatUsagePercent(value: number): string {
  const percentage = Math.min(100, Math.max(0, value * 100));
  return Math.abs(percentage - Math.round(percentage)) < 0.05
    ? `${Math.round(percentage)}%`
    : `${percentage.toFixed(1).replace(/\.0$/u, "")}%`;
}
