import type { UsageTokensView } from "../model.js";

export interface SessionUsageDisplay {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly totalTokens: number;
  readonly totalTokensText: string;
  readonly costText?: string;
}

export function resolveSessionUsageDisplay(
  usage: UsageTokensView | undefined,
  supported: boolean,
  locale: string
): SessionUsageDisplay | undefined {
  if (!supported || usage === undefined) return undefined;
  const counters = [
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadTokens,
    usage.cacheWriteTokens,
    usage.totalTokens
  ];
  if (counters.some((value) => !Number.isSafeInteger(value) || value < 0) || usage.totalTokens === 0) return undefined;
  const costText = formatKnownUsageCost(usage.costMicros, usage.currencyCode, locale);
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    totalTokens: usage.totalTokens,
    totalTokensText: formatCompactUsageTokens(usage.totalTokens),
    ...(costText === undefined ? {} : { costText })
  };
}

export function formatCompactUsageTokens(value: number): string {
  const amount = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  if (amount < 1_000) return String(amount);
  if (amount < 1_000_000) return `${compactOneDecimal(amount / 1_000)}K`;
  if (amount < 1_000_000_000) return `${compactOneDecimal(amount / 1_000_000)}M`;
  return `${compactOneDecimal(amount / 1_000_000_000)}B`;
}

export function formatKnownUsageCost(
  costMicros: number,
  currencyCode: string,
  locale: string
): string | undefined {
  if (!Number.isSafeInteger(costMicros) || costMicros <= 0) return undefined;
  const currency = currencyCode.trim().toUpperCase();
  if (!/^[A-Z]{3}$/u.test(currency)) return undefined;
  const amount = costMicros / 1_000_000;
  try {
    return new Intl.NumberFormat(locale === "en-XA" ? "en" : locale, {
      style: "currency",
      currency,
      minimumFractionDigits: amount < 0.01 ? 4 : amount < 1 ? 3 : 2,
      maximumFractionDigits: amount < 0.01 ? 4 : amount < 1 ? 3 : 2
    }).format(amount);
  } catch {
    return undefined;
  }
}

function compactOneDecimal(value: number): string {
  return value >= 100 || Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1).replace(/\.0$/u, "");
}
