import {
  appendMobileSelectionQuote,
  mobileSelectionQuoteMaximumCharacters,
  type MobileComposerDraft,
  type MobileComposerEditResult,
  type MobileComposerSelection
} from "./mobile-composer-document";
import { parseMobileMarkdownIncremental } from "./mobile-markdown";
import type { TimelineRow } from "./timeline";

export interface MobileQuoteSelectionLease {
  readonly sessionId: string;
  readonly sourceMessageId: string;
  readonly sourceEventId: string;
  readonly sourceRole: "user" | "assistant";
  readonly text: string;
  readonly surface: "sheet" | "timeline";
}

export function captureMobileQuoteSelection(
  sessionId: string,
  row: TimelineRow,
  surface: MobileQuoteSelectionLease["surface"] = "sheet"
): MobileQuoteSelectionLease | undefined {
  if (!sessionId || !row.completed || row.optimistic || row.internalInput || row.partnerPrivateOrigin) return undefined;
  const source = row.quoteSource;
  const text = row.kind === "assistant" && source !== undefined && source.sourceMessageId === row.id && source.sourceEventId === row.eventId
    ? source.text : row.kind === "user" && surface === "timeline" ? row.sourceText ?? row.copySource?.body : undefined;
  if (text === undefined || !text.trim() || (row.kind !== "assistant" && row.kind !== "user")) return undefined;
  if (surface === "timeline") {
    if (row.automationOrigin || row.collaboration || row.images?.length || row.artifacts?.length
      || text !== row.text || text.length > 240 || /[\r\n\t]/u.test(text)) return undefined;
    if (row.messageParts && (row.messageParts.length !== 1 || row.messageParts[0]?.kind !== "text"
      || row.messageParts[0].text !== text)) return undefined;
    if (row.kind === "assistant") {
      const { blocks } = parseMobileMarkdownIncremental(text, null);
      const block = blocks[0];
      if (blocks.length !== 1 || block?.type !== "paragraph" || block.inlines.some(inline => inline.type !== "text" || inline.marks?.length)
        || block.inlines.map(inline => "text" in inline ? inline.text : "").join("") !== text) return undefined;
    }
  }
  return {
    sessionId,
    sourceMessageId: row.id,
    sourceEventId: row.eventId,
    sourceRole: row.kind,
    text,
    surface
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
  const latest = input.latestRow === undefined || input.currentSessionId === undefined ? undefined
    : captureMobileQuoteSelection(input.currentSessionId, input.latestRow, input.lease.surface);
  if (latest === undefined || latest.sessionId !== input.lease.sessionId || latest.sourceRole !== input.lease.sourceRole
    || latest.sourceMessageId !== input.lease.sourceMessageId || latest.sourceEventId !== input.lease.sourceEventId
    || latest.text !== input.lease.text) {
    throw new Error("The source message changed. Select the text again from the current task.");
  }
  const selection = normalizeSelection(input.selection, input.lease.text);
  if (selection.start === selection.end) throw new Error("Select message text before adding a quote.");
  const text = input.lease.text.slice(selection.start, selection.end);
  const canonical = text.replace(/\r\n?/gu, "\n").replace(/^\n+|\n+$/gu, "");
  if (!canonical.trim()) throw new Error("Select non-empty message text before adding a quote.");
  if (canonical.length > mobileSelectionQuoteMaximumCharacters) {
    throw new Error(`A selected quote can contain at most ${mobileSelectionQuoteMaximumCharacters.toLocaleString("en-US")} characters.`);
  }
  return appendMobileSelectionQuote(input.draft, {
    sourceSessionId: input.lease.sessionId,
    sourceMessageId: input.lease.sourceMessageId,
    sourceEventId: input.lease.sourceEventId,
    sourceRole: input.lease.sourceRole,
    text: canonical
  }, input.atomId);
}

function normalizeSelection(selection: MobileComposerSelection, text: string): MobileComposerSelection {
  if (!selection || !Number.isSafeInteger(selection.start) || !Number.isSafeInteger(selection.end)) {
    throw new Error("The message text selection is invalid.");
  }
  const start = Math.min(selection.start, selection.end);
  const end = Math.max(selection.start, selection.end);
  if (start < 0 || end > text.length || !isUtf16Boundary(text, start) || !isUtf16Boundary(text, end)) {
    throw new Error("The message text selection splits a Unicode character or is out of date.");
  }
  return { start, end };
}

export function readNativeMessageSelection(value: unknown, registration: string, body: string): MobileComposerSelection | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const { registration: source, start, end, text } = value as Record<string, unknown>;
  if (source !== registration || typeof start !== "number" || typeof end !== "number" || typeof text !== "string"
    || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > body.length
    || !isUtf16Boundary(body, start) || !isUtf16Boundary(body, end) || body.slice(start, end) !== text) return undefined;
  return { start, end };
}

function isUtf16Boundary(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return true;
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff);
}
