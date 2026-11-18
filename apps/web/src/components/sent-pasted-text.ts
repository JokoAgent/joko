import { joinSelectionQuoteTextSegments, selectionQuoteTextSourceSegments } from "../selection-quote.js";
import type { TaskMessageReferenceRange } from "@joko/contracts";

export interface SentPastedTextRange {
  readonly start: number;
  readonly end: number;
  readonly display: string;
}

export type SentPastedTextToken =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "pasted"; readonly text: string; readonly display: string }
  | { readonly kind: "message-reference"; readonly text: string; readonly reference: TaskMessageReferenceRange };

export interface SentPastedTextMessageSegment {
  readonly text: string;
  readonly projectedText: string;
  readonly tokens: readonly SentPastedTextToken[];
}

/** Split persisted UTF-16 offsets without guessing from repeated source text. */
export function buildSentPastedTextTokens(
  content: string,
  ranges: readonly SentPastedTextRange[] = [],
  messageReferences: readonly TaskMessageReferenceRange[] = []
): readonly SentPastedTextToken[] {
  const sorted = [
    ...ranges.map((range) => ({ ...range, kind: "pasted" as const })),
    ...messageReferences.map((range) => ({ ...range, kind: "message-reference" as const }))
  ].sort((left, right) => left.start - right.start || left.end - right.end);
  const tokens: SentPastedTextToken[] = [];
  let cursor = 0;
  for (const range of sorted) {
    if (!Number.isInteger(range.start)
      || !Number.isInteger(range.end)
      || range.start < cursor
      || range.start < 0
      || range.end <= range.start
      || range.end > content.length
      || (range.kind === "pasted" && range.display.trim() === "")) continue;
    if (range.start > cursor) tokens.push({ kind: "text", text: content.slice(cursor, range.start) });
    const text = content.slice(range.start, range.end);
    tokens.push(range.kind === "pasted" ? { kind: "pasted", text, display: range.display }
      : { kind: "message-reference", text, reference: range });
    cursor = range.end;
  }
  if (cursor < content.length) tokens.push({ kind: "text", text: content.slice(cursor) });
  return tokens;
}

/** Collapse measurement must use the same compact labels that the user sees. */
export function projectSentPastedText(
  content: string,
  ranges: readonly SentPastedTextRange[] = []
): string {
  if (ranges.length === 0) return content;
  return buildSentPastedTextTokens(content, ranges)
    .map((token) => token.kind === "pasted" ? token.display : token.text)
    .join("");
}

export function projectSentPastedTextRanges<T extends { readonly start: number; readonly end: number }>(
  ranges: readonly T[],
  sourceStart: number | null,
  textLength: number
): readonly T[] {
  if (sourceStart === null || !Number.isInteger(sourceStart) || sourceStart < 0 || !Number.isInteger(textLength) || textLength < 0) return [];
  const sourceEnd = sourceStart + textLength;
  return ranges
    .filter((range) => range.start >= sourceStart && range.end <= sourceEnd)
    .map((range) => ({ ...range, start: range.start - sourceStart, end: range.end - sourceStart }));
}

/**
 * Preserve quote chips while mapping durable source offsets onto only the
 * visible user-text islands. Repeated text inside a quote cannot steal a body
 * range because the quote parser supplies exact source spans.
 */
export function buildSentPastedTextMessageSegments(
  content: string,
  quotesEncoded: boolean,
  ranges: readonly SentPastedTextRange[] = [],
  messageReferences: readonly TaskMessageReferenceRange[] = []
): readonly SentPastedTextMessageSegment[] {
  return selectionQuoteTextSourceSegments(content, quotesEncoded).map((segment) => {
    const sourceText = content.slice(segment.sourceStart, segment.sourceEnd);
    if (normalizeNewlines(sourceText) !== segment.text) {
      return { text: segment.text, projectedText: segment.text, tokens: [{ kind: "text", text: segment.text }] };
    }
    const localRanges = projectSentPastedTextRanges(ranges, segment.sourceStart, sourceText.length);
    const localReferences = projectSentPastedTextRanges(messageReferences, segment.sourceStart, sourceText.length);
    const tokens = buildSentPastedTextTokens(sourceText, localRanges, localReferences);
    return {
      text: segment.text,
      projectedText: normalizeNewlines(tokens.map((token) => token.kind === "pasted" ? token.display : token.text).join("")),
      tokens
    };
  });
}

export function projectSentPastedTextMessageBody(
  content: string,
  quotesEncoded: boolean,
  ranges: readonly SentPastedTextRange[] = []
): string {
  return joinSelectionQuoteTextSegments(buildSentPastedTextMessageSegments(content, quotesEncoded, ranges)
    .map((segment) => ({ kind: "text" as const, text: segment.projectedText })));
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/gu, "\n");
}
