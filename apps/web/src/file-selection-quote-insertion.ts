import type { ComposerFileSelectionQuoteDraft } from "./model.js";
import { normalizeSelectionQuoteDrafts } from "./selection-quote.js";

export interface FileSelectionQuoteInsertion {
  readonly id: number;
  readonly sessionId: string;
  readonly quote: ComposerFileSelectionQuoteDraft;
}

/**
 * Final UI-boundary validation for Inspector quotes. Detached portals can emit
 * during a route transition, so both the producer session and the structured
 * quote must still match the active SessionPane before an insertion is formed.
 */
export function fileSelectionQuoteInsertionFor(
  id: number,
  activeSessionId: string | undefined,
  producerSessionId: string,
  quote: ComposerFileSelectionQuoteDraft
): FileSelectionQuoteInsertion | undefined {
  if (!Number.isSafeInteger(id) || id < 1 || activeSessionId !== producerSessionId) return undefined;
  const normalized = normalizeSelectionQuoteDrafts([quote])[0];
  if (normalized?.kind !== "file" || normalized.sessionId !== producerSessionId) return undefined;
  return { id, sessionId: producerSessionId, quote: normalized };
}
