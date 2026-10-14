import type { MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileMessage } from "./mobile-messages";
import type { TimelineRow } from "./timeline";

export function mobileMessageRunFacts(row: TimelineRow, locale: MobileSupportedLocale): {
  readonly modelNotice?: string; readonly usageLabel?: string; readonly usageDescription?: string;
} {
  if (row.kind !== "assistant" || !row.completed || row.optimistic) return {};
  const substitution = row.modelSubstitution;
  const modelNotice = substitution === undefined || substitution.selectedModelId === substitution.actualModelId ? undefined : mobileMessage(locale, "task.modelSubstitution", {
    selected: substitution.selectedModelId, actual: substitution.actualModelId
  });
  const usage = row.usage;
  if (!usage || [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.totalTokens]
    .some(value => typeof value !== "bigint" || value < 0n || value > 0xffffffffffffffffn)
    || typeof usage.costMicros !== "bigint" || usage.costMicros < 0n || usage.costMicros > 0x7fffffffffffffffn) return { modelNotice };
  const incomplete = row.usageCostComplete === false;
  const tokensIncomplete = row.usageTokensComplete === false;
  const tokens = new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(usage.totalTokens);
  const tokensLabel = mobileMessage(locale, tokensIncomplete ? "task.messageTokensPartial" : "task.messageTokens", { tokens });
  const tokensDescription = tokensIncomplete ? mobileMessage(locale, "task.messageTokensPartialDescription", { tokens }) : undefined;
  if (usage.costMicros > 0n && usage.costMicros <= BigInt(Number.MAX_SAFE_INTEGER) && /^[A-Z]{3}$/u.test(usage.currencyCode)) {
    const amount = Number(usage.costMicros) / 1_000_000;
    const formatter = new Intl.NumberFormat(locale, { style: "currency", currency: usage.currencyCode, maximumFractionDigits: 2 });
    const cost = amount < 0.01 ? `<${formatter.format(0.01)}` : formatter.format(amount);
    const usageDescription = mobileMessage(locale, row.usageIsEstimate
        ? incomplete ? "task.messageValueEstimatePartial" : "task.messageValueEstimate"
        : incomplete ? "task.messageCostPartial" : "task.messageCost", { cost });
    return { modelNotice, usageLabel: `${row.usageIsEstimate ? "≈" : ""}${cost}${incomplete ? "+" : ""}${tokensIncomplete ? ` · ${tokensLabel}` : ""}`,
      usageDescription: `${usageDescription}${tokensDescription ? ` · ${tokensDescription}` : ""}` };
  }
  if (usage.totalTokens <= 0n && !tokensIncomplete) return { modelNotice };
  return { modelNotice, usageLabel: tokensLabel, usageDescription: mobileMessage(locale,
    tokensIncomplete ? incomplete ? "task.messageTokensPartialPriceUnavailable" : "task.messageTokensPartialDescription"
      : incomplete ? "task.messageTokensPriceUnavailable" : "task.messageTokens", { tokens }) };
}
