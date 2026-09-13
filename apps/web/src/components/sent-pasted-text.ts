import { joinSelectionQuoteTextSegments, selectionQuoteTextSourceSegments } from "../selection-quote.js";

export interface SentPastedTextRange {
  readonly start: number;
  readonly end: number;
  readonly display: string;
}

export type SentPastedTextToken =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "pasted"; readonly text: string; readonly display: string };

export interface SentPastedTextMessageSegment {
  readonly text: string;
  readonly projectedText: string;
  readonly tokens: readonly SentPastedTextToken[];
}

/** Split persisted UTF-16 offsets without guessing from repeated source text. */
export function buildSentPastedTextTokens(
  content: string,
  ranges: readonly SentPastedTextRange[] = []
): readonly SentPastedTextToken[] {
  const sorted = [...ranges].sort((left, right) => left.start - right.start || left.end - right.end);
  const tokens: SentPastedTextToken[] = [];
  let cursor = 0;
  for (const range of sorted) {
    if (!Number.isInteger(range.start)
      || !Number.isInteger(range.end)
      || range.start < cursor
      || range.start < 0
      || range.end <= range.start
      || range.end > content.length
      || range.display.trim() === "") continue;
    if (range.start > cursor) tokens.push({ kind: "text", text: content.slice(cursor, range.start) });
    tokens.push({ kind: "pasted", text: content.slice(range.start, range.end), display: range.display });
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

export function projectSentPastedTextRanges(
  ranges: readonly SentPastedTextRange[],
  sourceStart: number | null,
  textLength: number
): readonly SentPastedTextRange[] {
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
  ranges: readonly SentPastedTextRange[] = []
): readonly SentPastedTextMessageSegment[] {
  return selectionQuoteTextSourceSegments(content, quotesEncoded).map((segment) => {
    const sourceText = content.slice(segment.sourceStart, segment.sourceEnd);
    if (normalizeNewlines(sourceText) !== segment.text) {
      return { text: segment.text, projectedText: segment.text, tokens: [{ kind: "text", text: segment.text }] };
    }
    const localRanges = projectSentPastedTextRanges(ranges, segment.sourceStart, sourceText.length);
    const tokens = buildSentPastedTextTokens(sourceText, localRanges);
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
