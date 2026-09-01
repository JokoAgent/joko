import { MessageSquareQuote } from "lucide-react";
import type { JSX } from "react";
import { selectionQuoteSourceDisplayLabel, type SelectionQuoteContent } from "../selection-quote.js";

/** Compact summary used by both composer and sent user messages. */
export function SelectionQuoteChip({ quote, selected = false }: {
  readonly quote: SelectionQuoteContent;
  readonly selected?: boolean;
}): JSX.Element {
  const compactText = quote.text.replace(/\s+/gu, " ").trim();
  const sourceLabel = selectionQuoteSourceDisplayLabel(quote);
  const label = sourceLabel === undefined ? compactText : `${sourceLabel} · ${compactText}`;
  const accessibleLabel = sourceLabel === undefined ? quote.text : `${sourceLabel}: ${quote.text}`;
  const title = sourceLabel === undefined ? `“${quote.text}”` : `“${quote.text}”\n${sourceLabel}`;
  return (
    <span className={`selection-quote-chip${selected ? " is-selected" : ""}`} data-selection-quote-chip="" title={title} aria-label={accessibleLabel}>
      <MessageSquareQuote aria-hidden="true" /><span>{label}</span>
    </span>
  );
}
