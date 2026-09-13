import type { JSX } from "react";
import type { UsageTokensView } from "../model.js";
import type { Translator } from "./types.js";
import { formatCompactUsageTokens, resolveSessionUsageDisplay } from "./session-usage.js";

export function SessionUsageChip({ usage, supported, locale, t }: {
  readonly usage?: UsageTokensView;
  readonly supported: boolean;
  readonly locale: string;
  readonly t: Translator;
}): JSX.Element | null {
  const display = resolveSessionUsageDisplay(usage, supported, locale);
  if (display === undefined) return null;
  const tooltip = [
    t("sessionUsage.total", { tokens: display.totalTokensText }),
    t("sessionUsage.breakdown", {
      input: formatCompactUsageTokens(display.inputTokens),
      output: formatCompactUsageTokens(display.outputTokens),
      cacheRead: formatCompactUsageTokens(display.cacheReadTokens),
      cacheWrite: formatCompactUsageTokens(display.cacheWriteTokens)
    }),
    display.costText === undefined
      ? t("sessionUsage.costUnavailable")
      : t("sessionUsage.cost", { cost: display.costText })
  ].join("\n");
  return (
    <span className="session-usage-chip" title={tooltip} aria-label={tooltip}>
      <span>{t("sessionUsage.tokensShort", { tokens: display.totalTokensText })}</span>
      {display.costText !== undefined && <><span className="session-usage-chip__separator" aria-hidden="true" /><span>{display.costText}</span></>}
    </span>
  );
}
