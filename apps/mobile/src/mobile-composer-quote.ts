import {
  appendMobileSelectionQuote,
  mobileSelectionQuoteMaximumCharacters,
  type MobileComposerDraft,
  type MobileComposerEditResult,
  type MobileComposerSelection
} from "./mobile-composer-document";
import type { TimelineRow } from "./timeline";

export interface MobileQuoteSelectionLease {
  readonly sessionId: string;
  readonly sourceMessageId: string;
  readonly sourceEventId: string;
  readonly text: string;
}

export function captureMobileQuoteSelection(
  sessionId: string,
  row: TimelineRow
): MobileQuoteSelectionLease | undefined {
  const source = row.quoteSource;
  if (!sessionId || !row.completed || row.kind !== "assistant" || source === undefined
    || source.sourceMessageId !== row.id || source.sourceEventId !== row.eventId || !source.text.trim()) {
    return undefined;
  }
  return {
    sessionId,
    sourceMessageId: source.sourceMessageId,
    sourceEventId: source.sourceEventId,
    text: source.text
  };
}

export function commitMobileQuoteSelection(input: {
  readonly lease: MobileQuoteSelectionLease;
  readonly currentSessionId: string | undefined;
  readonly latestRow: TimelineRow | undefined;
  readonly selection: MobileComposerSelection;
  readonly draft: MobileComposerDraft;
  readonly atomId: string;
}): MobileComposerEditResult {
  const latest = input.latestRow;
  const latestSource = latest?.quoteSource;
  if (input.currentSessionId !== input.lease.sessionId || latest === undefined || !latest.completed
    || latest.kind !== "assistant" || latest.id !== input.lease.sourceMessageId
    || latest.eventId !== input.lease.sourceEventId || latestSource === undefined
    || latestSource.sourceMessageId !== input.lease.sourceMessageId
    || latestSource.sourceEventId !== input.lease.sourceEventId
    || latestSource.text !== input.lease.text) {
    throw new Error("The source assistant message changed. Select the text again from the current task.");
  }
  const selection = normalizeSelection(input.selection, input.lease.text);
  if (selection.start === selection.end) throw new Error("Select assistant text before adding a quote.");
  const text = input.lease.text.slice(selection.start, selection.end);
  const canonical = text.replace(/\r\n?/gu, "\n").replace(/^\n+|\n+$/gu, "");
  if (!canonical.trim()) throw new Error("Select non-empty assistant text before adding a quote.");
  if (canonical.length > mobileSelectionQuoteMaximumCharacters) {
    throw new Error(`A selected quote can contain at most ${mobileSelectionQuoteMaximumCharacters.toLocaleString("en-US")} characters.`);
  }
  return appendMobileSelectionQuote(input.draft, {
    sourceSessionId: input.lease.sessionId,
    sourceMessageId: input.lease.sourceMessageId,
    sourceEventId: input.lease.sourceEventId,
    sourceRole: "assistant",
    text: canonical
  }, input.atomId);
}

function normalizeSelection(selection: MobileComposerSelection, text: string): MobileComposerSelection {
  if (!selection || !Number.isSafeInteger(selection.start) || !Number.isSafeInteger(selection.end)) {
    throw new Error("The assistant text selection is invalid.");
  }
  const start = Math.min(selection.start, selection.end);
  const end = Math.max(selection.start, selection.end);
  if (start < 0 || end > text.length || !isUtf16Boundary(text, start) || !isUtf16Boundary(text, end)) {
    throw new Error("The assistant text selection splits a Unicode character or is out of date.");
  }
  return { start, end };
}

function isUtf16Boundary(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return true;
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff);
}
