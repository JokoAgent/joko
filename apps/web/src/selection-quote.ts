import type { ComposerSelectionQuoteDraft } from "./model.js";

export const SELECTION_QUOTE_MAX_CHARS = 4_000;
export const SELECTION_QUOTE_BLOCK_MARKER = "<!-- joko-selection-quote -->";
export const SELECTION_QUOTE_BLOCK_MARKER_LINE = `> ${SELECTION_QUOTE_BLOCK_MARKER}`;
export const SELECTION_QUOTE_SOURCE_PATH_MAX_CHARS = 2_048;
const SELECTION_QUOTE_SOURCE_LINE_PREFIX = "— source: ";
const SELECTION_QUOTE_MAX_ID_CHARS = 1_024;
const SELECTION_QUOTE_MAX_ITEMS = 32;

export type { ComposerSelectionQuoteDraft } from "./model.js";

export type SelectionQuoteContent =
  | { readonly kind: "message"; readonly text: string }
  | {
      readonly kind: "file";
      readonly text: string;
      readonly sourcePath: string;
      readonly startLine?: number;
      readonly endLine?: number;
    };

export type SelectionQuoteMessageSegment =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "quote"; readonly quote: SelectionQuoteContent };

export function normalizeSelectionQuoteDrafts(value: unknown): readonly ComposerSelectionQuoteDraft[] {
  if (!Array.isArray(value)) return [];
  const result: ComposerSelectionQuoteDraft[] = [];
  const seen = new Set<string>();
  for (const candidate of value.slice(0, SELECTION_QUOTE_MAX_ITEMS)) {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const record = candidate as Record<string, unknown>;
    const id = boundedIdentity(record["id"]);
    const sessionId = boundedIdentity(record["sessionId"]);
    const text = boundedSelectionQuoteText(record["text"]);
    if (id === undefined || sessionId === undefined || text === undefined || seen.has(id)) continue;

    const kind = record["kind"];
    if (kind === "file") {
      if (
        hasOptionalValue(record["messageId"])
        || hasOptionalValue(record["sourceEventId"])
        || hasOptionalValue(record["role"])
      ) continue;
      const sourcePath = canonicalSelectionQuoteSourcePath(record["sourcePath"]);
      const lines = normalizeFileLineMetadata(record["startLine"], record["endLine"]);
      if (sourcePath === undefined || lines === undefined) continue;
      result.push({ id, kind: "file", text, sessionId, sourcePath, ...lines });
      seen.add(id);
      continue;
    }
    if (kind !== "message") continue;
    if (
      hasOptionalValue(record["sourcePath"])
      || hasOptionalValue(record["startLine"])
      || hasOptionalValue(record["endLine"])
    ) continue;
    const messageId = boundedIdentity(record["messageId"]);
    const rawSourceEventId = record["sourceEventId"];
    const sourceEventId = hasOptionalValue(rawSourceEventId) ? boundedIdentity(rawSourceEventId) : undefined;
    if (
      messageId === undefined
      || (record["role"] !== "assistant" && record["role"] !== "user")
      || (hasOptionalValue(rawSourceEventId) && sourceEventId === undefined)
    ) continue;
    result.push({
      id,
      kind: "message",
      text,
      sessionId,
      messageId,
      role: record["role"],
      ...(sourceEventId === undefined ? {} : { sourceEventId })
    });
    seen.add(id);
  }
  return result;
}

export function boundedSelectionQuoteText(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const withoutOuterNewlines = stripOuterNewlines(value.replace(/\r\n?/gu, "\n"));
  if (withoutOuterNewlines.length <= SELECTION_QUOTE_MAX_CHARS) return withoutOuterNewlines;
  return `${withoutOuterNewlines.slice(0, SELECTION_QUOTE_MAX_CHARS)}…`;
}

/** Validate, but never rewrite, a canonical workspace-relative slash path. */
export function canonicalSelectionQuoteSourcePath(value: unknown): string | undefined {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > SELECTION_QUOTE_SOURCE_PATH_MAX_CHARS
    || value.startsWith("/")
    || value.includes("\\")
    || /^[A-Za-z]:/u.test(value)
    || /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(value)
  ) return undefined;
  const segments = value.split("/");
  if (segments.some((segment) => segment.trim() === "" || segment === "." || segment === "..")) return undefined;
  return value;
}

/** Private-marker plus readable Markdown blockquote wire form. */
export function selectionQuoteModelText(quote: ComposerSelectionQuoteDraft): string {
  const normalized = normalizeSelectionQuoteDrafts([quote])[0];
  if (normalized === undefined) throw new Error("The selected-text quote is invalid.");
  const lines = normalized.text.split("\n");
  if (normalized.kind === "file") lines.push(`${SELECTION_QUOTE_SOURCE_LINE_PREFIX}${formatFileSource(normalized)}`);
  return [
    SELECTION_QUOTE_BLOCK_MARKER_LINE,
    ...lines.map((line) => line === "" ? ">" : `> ${line}`)
  ].join("\n");
}

export interface ParsedSelectionQuoteMessage {
  readonly segments: readonly SelectionQuoteMessageSegment[];
  readonly quotes: readonly SelectionQuoteContent[];
  readonly body: string;
}

export interface SelectionQuoteTextSourceSegment {
  readonly text: string;
  /** UTF-16 offsets into the unmodified durable message text. */
  readonly sourceStart: number;
  readonly sourceEnd: number;
}

/** Parse only behind durable product truth; raw text is never the authority. */
export function parseSelectionQuoteMessage(content: string, quotesEncoded = false): ParsedSelectionQuoteMessage {
  if (!quotesEncoded) {
    return {
      segments: content === "" ? [] : [{ kind: "text", text: content }],
      quotes: [],
      body: content
    };
  }
  const segments = parseEncodedSelectionQuoteSegments(content);
  return {
    segments,
    quotes: segments.flatMap((segment) => segment.kind === "quote" ? [segment.quote] : []),
    body: joinSelectionQuoteTextSegments(segments)
  };
}

/** Strip private marker lines only behind the durable quotesEncoded gate. */
export function stripSelectionQuoteMarkerLines(content: string, quotesEncoded = false): string {
  if (!quotesEncoded) return content;
  return content
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .filter((line) => line.trimStart() !== SELECTION_QUOTE_BLOCK_MARKER_LINE)
    .join("\n");
}

export function visibleSelectionQuoteMessageText(content: string, quotesEncoded = false): string {
  return stripSelectionQuoteMarkerLines(content, quotesEncoded);
}

/** Parse all marked quote blocks while retaining text/quote document order. */
export function parseEncodedSelectionQuoteSegments(content: string): readonly SelectionQuoteMessageSegment[] {
  return parseLocatedSelectionQuoteSegments(normalizeSelectionQuoteSource(content).text)
    .map((segment): SelectionQuoteMessageSegment => segment.kind === "quote"
      ? { kind: "quote", quote: segment.quote }
      : { kind: "text", text: segment.text });
}

/** Locate visible text islands without guessing from repeated quote/body text. */
export function selectionQuoteTextSourceSegments(
  content: string,
  quotesEncoded = false
): readonly SelectionQuoteTextSourceSegment[] {
  if (!quotesEncoded) return content === "" ? [] : [{ text: content, sourceStart: 0, sourceEnd: content.length }];
  const normalized = normalizeSelectionQuoteSource(content);
  return parseLocatedSelectionQuoteSegments(normalized.text).flatMap((segment): SelectionQuoteTextSourceSegment[] => {
    if (segment.kind !== "text") return [];
    return [{
      text: segment.text,
      sourceStart: normalized.originalOffsets[segment.sourceStart] ?? content.length,
      sourceEnd: normalized.originalOffsets[segment.sourceEnd] ?? content.length
    }];
  });
}

type LocatedSelectionQuoteMessageSegment =
  | { readonly kind: "text"; readonly text: string; readonly sourceStart: number; readonly sourceEnd: number }
  | { readonly kind: "quote"; readonly quote: SelectionQuoteContent };

interface LocatedSourceLine {
  readonly text: string;
  readonly sourceStart: number;
  readonly sourceEnd: number;
}

function parseLocatedSelectionQuoteSegments(normalizedContent: string): readonly LocatedSelectionQuoteMessageSegment[] {
  if (!normalizedContent.includes(SELECTION_QUOTE_BLOCK_MARKER_LINE)) return normalizedContent
    ? [{ kind: "text", text: normalizedContent, sourceStart: 0, sourceEnd: normalizedContent.length }]
    : [];
  const lines = locatedSourceLines(normalizedContent);
  const segments: LocatedSelectionQuoteMessageSegment[] = [];
  let textLines: LocatedSourceLine[] = [];

  const flushText = (beforeQuote: boolean): void => {
    const followsQuote = segments.at(-1)?.kind === "quote";
    const pending = textLines;
    textLines = [];
    if (pending.length === 0) return;
    if (pending.every((line) => line.text === "")) {
      const structural = followsQuote || beforeQuote ? 1 : 0;
      const preserved = Math.max(0, pending.length - structural);
      if (preserved > 0) {
        const sourceStart = pending[0]?.sourceStart ?? 0;
        segments.push({ kind: "text", text: "\n".repeat(preserved), sourceStart, sourceEnd: sourceStart + preserved });
      }
      return;
    }
    let start = 0;
    let end = pending.length;
    if (followsQuote && pending[start]?.text === "") start += 1;
    if (beforeQuote && end > start && pending[end - 1]?.text === "") end -= 1;
    const selected = pending.slice(start, end);
    const text = selected.map((line) => line.text).join("\n");
    const first = selected[0];
    const last = selected.at(-1);
    if (text !== "" && first !== undefined && last !== undefined) {
      segments.push({ kind: "text", text, sourceStart: first.sourceStart, sourceEnd: last.sourceEnd });
    }
  };

  let index = 0;
  while (index < lines.length) {
    const sourceLine = lines[index]!;
    const line = sourceLine.text;
    const markerIndent = line.trimStart() === SELECTION_QUOTE_BLOCK_MARKER_LINE
      ? line.slice(0, line.length - line.trimStart().length)
      : undefined;
    if (markerIndent === undefined) {
      textLines.push(sourceLine);
      index += 1;
      continue;
    }
    flushText(true);
    index += 1;
    const quoteLines: string[] = [];
    while (index < lines.length) {
      const quoteLine = lines[index]!.text;
      const prefix = `${markerIndent ?? ""}>`;
      if (quoteLine.startsWith(`${prefix} `)) {
        quoteLines.push(quoteLine.slice(prefix.length + 1));
        index += 1;
      } else if (quoteLine === prefix) {
        quoteLines.push("");
        index += 1;
      } else break;
    }
    segments.push({ kind: "quote", quote: quoteContentFromLines(quoteLines) });
  }
  flushText(false);
  return segments;
}

function locatedSourceLines(content: string): readonly LocatedSourceLine[] {
  const lines: LocatedSourceLine[] = [];
  let sourceStart = 0;
  for (let index = 0; index <= content.length; index += 1) {
    if (index !== content.length && content[index] !== "\n") continue;
    lines.push({ text: content.slice(sourceStart, index), sourceStart, sourceEnd: index });
    sourceStart = index + 1;
  }
  return lines;
}

function normalizeSelectionQuoteSource(content: string): {
  readonly text: string;
  readonly originalOffsets: readonly number[];
} {
  let text = "";
  const originalOffsets: number[] = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === "\r") {
      if (content[index + 1] === "\n") index += 1;
      text += "\n";
    } else {
      text += content[index] ?? "";
    }
    originalOffsets.push(index + 1);
  }
  return { text, originalOffsets };
}

export function joinSelectionQuoteTextSegments(segments: readonly SelectionQuoteMessageSegment[]): string {
  let body = "";
  let hasText = false;
  for (const segment of segments) {
    if (segment.kind !== "text") continue;
    if (!hasText) {
      body = segment.text;
      hasText = true;
      continue;
    }
    const trailing = boundaryNewlineCount(body, false);
    const leading = boundaryNewlineCount(segment.text, true);
    body += "\n".repeat(Math.max(0, 2 - trailing - leading));
    body += segment.text;
  }
  return body;
}

export function selectionQuoteSourceBasename(sourcePath: string): string {
  return sourcePath.split("/").at(-1) ?? sourcePath;
}

export function selectionQuoteSourceDisplayLabel(quote: SelectionQuoteContent): string | undefined {
  if (quote.kind !== "file") return undefined;
  const basename = selectionQuoteSourceBasename(quote.sourcePath);
  if (quote.startLine === undefined) return basename;
  return quote.endLine === undefined || quote.endLine === quote.startLine
    ? `${basename}:L${quote.startLine}`
    : `${basename}:L${quote.startLine}-L${quote.endLine}`;
}

function quoteContentFromLines(lines: readonly string[]): SelectionQuoteContent {
  const last = lines.at(-1);
  if (last?.startsWith(SELECTION_QUOTE_SOURCE_LINE_PREFIX) === true && lines.length > 1) {
    const source = parseFileSource(last.slice(SELECTION_QUOTE_SOURCE_LINE_PREFIX.length));
    if (source !== undefined) return { kind: "file", text: lines.slice(0, -1).join("\n"), ...source };
  }
  return { kind: "message", text: lines.join("\n") };
}

function parseFileSource(value: string): { readonly sourcePath: string; readonly startLine?: number; readonly endLine?: number } | undefined {
  const lineMarker = value.lastIndexOf("#L");
  if (lineMarker < 0) {
    const sourcePath = canonicalSelectionQuoteSourcePath(value);
    return sourcePath === undefined ? undefined : { sourcePath };
  }
  const sourcePath = canonicalSelectionQuoteSourcePath(value.slice(0, lineMarker));
  if (sourcePath === undefined) return undefined;
  const linePart = value.slice(lineMarker + 2);
  const rangeMarker = linePart.indexOf("-L");
  const startText = rangeMarker < 0 ? linePart : linePart.slice(0, rangeMarker);
  const endText = rangeMarker < 0 ? startText : linePart.slice(rangeMarker + 2);
  if (!isAsciiDigits(startText) || !isAsciiDigits(endText)) return undefined;
  const startLine = Number(startText);
  const endLine = Number(endText);
  if (!isSafePositiveLine(startLine) || !isSafePositiveLine(endLine) || endLine < startLine) return undefined;
  return { sourcePath, startLine, endLine };
}

function formatFileSource(quote: Extract<ComposerSelectionQuoteDraft, { readonly kind: "file" }>): string {
  if (quote.startLine === undefined) return quote.sourcePath;
  return quote.endLine === undefined || quote.endLine === quote.startLine
    ? `${quote.sourcePath}#L${quote.startLine}`
    : `${quote.sourcePath}#L${quote.startLine}-L${quote.endLine}`;
}

function normalizeFileLineMetadata(
  rawStartLine: unknown,
  rawEndLine: unknown
): { readonly startLine?: number; readonly endLine?: number } | undefined {
  const hasStart = hasOptionalValue(rawStartLine);
  const hasEnd = hasOptionalValue(rawEndLine);
  if (!hasStart && !hasEnd) return {};
  if (!hasStart || !isSafePositiveLine(rawStartLine)) return undefined;
  const endLine = hasEnd ? rawEndLine : rawStartLine;
  if (!isSafePositiveLine(endLine) || endLine < rawStartLine) return undefined;
  return { startLine: rawStartLine, endLine };
}

function isSafePositiveLine(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isAsciiDigits(value: string): boolean {
  if (value.length === 0) return false;
  for (const character of value) {
    if (character < "0" || character > "9") return false;
  }
  return true;
}

function hasOptionalValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

function boundaryNewlineCount(value: string, fromStart: boolean): number {
  let count = 0;
  if (fromStart) {
    for (let index = 0; index < value.length && count < 2 && value[index] === "\n"; index += 1) count += 1;
  } else {
    for (let index = value.length - 1; index >= 0 && count < 2 && value[index] === "\n"; index -= 1) count += 1;
  }
  return count;
}

function stripOuterNewlines(text: string): string {
  let start = 0;
  while (start < text.length && text[start] === "\n") start += 1;
  let end = text.length;
  while (end > start && text[end - 1] === "\n") end -= 1;
  return text.slice(start, end);
}

function boundedIdentity(value: unknown): string | undefined {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > SELECTION_QUOTE_MAX_ID_CHARS
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) return undefined;
  return value;
}
