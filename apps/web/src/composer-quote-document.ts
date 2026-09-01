import type { JSONContent } from "@tiptap/core";
import type { ComposerSelectionQuoteDraft } from "./model.js";
import { normalizedListAttrs, promoteComposerMarkdownLists } from "./composer-list-document.js";
import {
  COMPOSER_LONG_PASTE_ATTRIBUTE_LIMIT,
  COMPOSER_PASTED_TEXT_NODE_TYPE,
  COMPOSER_ROUTE_REFERENCE_NODE_TYPE
} from "./components/composer-paste-pipeline.js";
import { COMPOSER_MESSAGE_REFERENCE_TEXT_LIMIT } from "./components/composer-route-reference-resolution.js";
import {
  normalizeSelectionQuoteDrafts,
  parseEncodedSelectionQuoteSegments,
  parseSelectionQuoteMessage,
  selectionQuoteModelText,
  type SelectionQuoteMessageSegment
} from "./selection-quote.js";
import { buildSentPastedTextMessageSegments, type SentPastedTextMessageSegment } from "./components/sent-pasted-text.js";

export const COMPOSER_QUOTE_NODE_TYPE = "composerQuote";

export type ComposerQuoteAttrs = ComposerSelectionQuoteDraft;

export interface SerializedComposerDocument {
  readonly text: string;
  readonly quotesEncoded: boolean;
  readonly pastedTextRanges?: readonly ComposerPastedTextRange[];
}

export interface ComposerPastedTextRange {
  readonly start: number;
  readonly end: number;
  readonly display: string;
}

interface SerializedBlock {
  readonly kind: "text" | "quote";
  readonly text: string;
  readonly pastedTextRanges?: readonly ComposerPastedTextRange[];
}

export function emptyComposerDocument(): JSONContent {
  return { type: "doc", content: [{ type: "paragraph" }] };
}

export function plainTextToComposerDocument(text: string): JSONContent {
  const normalized = text.replace(/\r\n?/gu, "\n");
  return promoteComposerMarkdownLists({
    type: "doc",
    content: normalized.split("\n").map((line) => paragraph(line === "" ? [] : [{ type: "text", text: line }]))
  });
}

/** Fail-closed draft normalization: only installed editor schema nodes survive. */
export function normalizeComposerDocument(value: unknown, fallbackText = ""): JSONContent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return plainTextToComposerDocument(fallbackText);
  const record = value as Record<string, unknown>;
  if (record["type"] !== "doc" || !Array.isArray(record["content"])) return plainTextToComposerDocument(fallbackText);
  const content = record["content"].flatMap((candidate): JSONContent[] => {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const node = candidate as Record<string, unknown>;
    if (node["type"] === COMPOSER_QUOTE_NODE_TYPE) {
      const quote = quoteAttrs(node["attrs"]);
      return quote === undefined ? [] : [quoteNode(quote)];
    }
    if (node["type"] === "bulletList" || node["type"] === "orderedList") {
      const list = normalizeListNode(node);
      return list === undefined ? [] : [list];
    }
    if (node["type"] !== "paragraph") return [];
    const children = Array.isArray(node["content"])
      ? node["content"].flatMap((child): JSONContent[] => normalizeInlineNode(child))
      : [];
    return [paragraph(children)];
  });
  const normalizedTopLevel = normalizeTopLevelQuoteNodes(content);
  return promoteComposerMarkdownLists({
    type: "doc",
    content: normalizedTopLevel.length > 0 ? normalizedTopLevel : [{ type: "paragraph" }]
  });
}

export function appendQuoteToComposerDocument(
  document: JSONContent | null | undefined,
  quote: ComposerSelectionQuoteDraft
): JSONContent {
  const normalizedQuote = normalizeSelectionQuoteDrafts([quote])[0];
  if (normalizedQuote === undefined) return normalizeComposerDocument(document);
  const normalized = normalizeComposerDocument(document);
  const content = [...(normalized.content ?? [])];
  const last = content.at(-1);
  if (last?.type === "paragraph") {
    content[content.length - 1] = paragraph([...(last.content ?? []), quoteNode(normalizedQuote)]);
  } else content.push(paragraph([quoteNode(normalizedQuote)]));
  return { type: "doc", content };
}

export function composerDocumentFromEncodedMessage(
  content: string,
  source: { readonly sessionId: string; readonly messageId: string; readonly sourceEventId?: string; readonly role?: "user" | "assistant" },
  purpose: "edit" | "history",
  pastedTextRanges: readonly ComposerPastedTextRange[] = []
): JSONContent {
  return composerDocumentFromMessage(content, true, source, purpose, pastedTextRanges);
}

/** Restore only durable structured truth; marker-looking plain text stays plain. */
export function composerDocumentFromMessage(
  content: string,
  quotesEncoded: boolean,
  source: { readonly sessionId: string; readonly messageId: string; readonly sourceEventId?: string; readonly role?: "user" | "assistant" },
  purpose: "edit" | "history",
  pastedTextRanges: readonly ComposerPastedTextRange[] = []
): JSONContent {
  const segments = parseSelectionQuoteMessage(content, quotesEncoded).segments;
  const pastedSegments = pastedTextRanges.length === 0
    ? undefined
    : buildSentPastedTextMessageSegments(content, quotesEncoded, pastedTextRanges);
  return quoteSegmentsToComposerDocument(segments, source, purpose, pastedSegments);
}

/** Preserve quote atom positions while applying text edited on the plain-body surface. */
export function composerDocumentFromEditedEncodedMessage(
  encodedContent: string,
  editedBody: string,
  source: { readonly sessionId: string; readonly messageId: string; readonly sourceEventId?: string; readonly role?: "user" | "assistant" },
  purpose: "edit" | "history",
  pastedTextRanges: readonly ComposerPastedTextRange[] = []
): JSONContent {
  if (pastedTextRanges.length > 0 && parseSelectionQuoteMessage(encodedContent, true).body === editedBody) {
    return composerDocumentFromMessage(encodedContent, true, source, purpose, pastedTextRanges);
  }
  const original = parseEncodedSelectionQuoteSegments(encodedContent);
  const textCount = original.filter((segment) => segment.kind === "text").length;
  if (textCount === 0) {
    const appended = editedBody === "" ? original : [...original, { kind: "text" as const, text: editedBody }];
    return quoteSegmentsToComposerDocument(appended, source, purpose);
  }
  const pieces = textCount === 1 ? [editedBody] : splitEditedTextIslands(editedBody, textCount);
  let textIndex = 0;
  return quoteSegmentsToComposerDocument(original.flatMap((segment): SelectionQuoteMessageSegment[] => {
    if (segment.kind === "quote") return [segment];
    const text = pieces[textIndex++] ?? "";
    return text === "" ? [] : [{ kind: "text", text }];
  }), source, purpose);
}

export function quoteSegmentsToComposerDocument(
  segments: readonly SelectionQuoteMessageSegment[],
  source: { readonly sessionId: string; readonly messageId: string; readonly sourceEventId?: string; readonly role?: "user" | "assistant" },
  purpose: "edit" | "history",
  pastedTextSegments?: readonly SentPastedTextMessageSegment[]
): JSONContent {
  const content: JSONContent[] = [];
  let inline: JSONContent[] = [];
  let quoteIndex = 0;
  let textSegmentIndex = 0;
  let quoteJustEnded = false;
  const finishParagraph = (): void => {
    content.push(paragraph(inline));
    inline = [];
  };
  for (const segment of segments) {
    if (segment.kind === "quote") {
      const id = restoredQuoteId(purpose, source.messageId, quoteIndex);
      inline.push(quoteNode(segment.quote.kind === "file"
        ? { id, sessionId: source.sessionId, ...segment.quote }
        : {
            id,
            kind: "message",
            text: segment.quote.text,
            sessionId: source.sessionId,
            messageId: source.messageId,
            role: source.role ?? "user",
            ...(source.sourceEventId === undefined ? {} : { sourceEventId: source.sourceEventId })
          }));
      quoteIndex += 1;
      quoteJustEnded = true;
      continue;
    }
    const restored = pastedTextSegments?.[textSegmentIndex];
    textSegmentIndex += 1;
    const tokens = restored?.text === segment.text
      ? restored.tokens
      : [{ kind: "text" as const, text: segment.text }];
    for (const token of tokens) {
      if (token.kind === "pasted") {
        inline.push({ type: COMPOSER_PASTED_TEXT_NODE_TYPE, attrs: { text: token.text, display: token.display } });
        quoteJustEnded = false;
        continue;
      }
      if (token.text === "") continue;
      const normalizedText = token.text.replace(/\r\n?/gu, "\n");
      if (isPureLineBreakText(normalizedText)) {
        inline.push(...Array.from({ length: normalizedText.length }, () => ({ type: "hardBreak" })));
        continue;
      }
      const lines = normalizedText.split("\n");
      lines.forEach((line, index) => {
        if (quoteJustEnded && line !== "" && LIST_ROW_MARKER_RE.test(line) && inline.length > 0) finishParagraph();
        if (line !== "") inline.push({ type: "text", text: line });
        if (index < lines.length - 1) finishParagraph();
        if (line !== "") quoteJustEnded = false;
      });
    }
  }
  if (content.length === 0 && inline.length === 0) return emptyComposerDocument();
  finishParagraph();
  return normalizeComposerDocument({ type: "doc", content });
}

export function serializeComposerDocument(document: unknown): SerializedComposerDocument {
  const blocks = composerDocumentBlocks(normalizeComposerDocument(document));
  let serialized = "";
  const pastedTextRanges: ComposerPastedTextRange[] = [];
  let previousKind: SerializedBlock["kind"] | undefined;
  let suppressNextSeparator = false;
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]!;
    const previous = blocks[index - 1];
    const next = blocks[index + 1];
    const pureLineBreakIsland = block.kind === "text"
      && isPureLineBreakText(block.text)
      && previous?.kind === "quote"
      && next?.kind === "quote";
    if (pureLineBreakIsland) {
      serialized += `\n\n${block.text}`;
      suppressNextSeparator = true;
      previousKind = block.kind;
      continue;
    }
    const separator = previousKind === undefined || suppressNextSeparator
      ? ""
      : previousKind === "quote" || block.kind === "quote" ? "\n\n" : "\n";
    serialized += separator;
    const blockStart = serialized.length;
    serialized += block.text;
    for (const range of block.pastedTextRanges ?? []) {
      pastedTextRanges.push({
        start: blockStart + range.start,
        end: blockStart + range.end,
        display: range.display
      });
    }
    suppressNextSeparator = false;
    previousKind = block.kind;
  }
  const leadingTrim = serialized.length - serialized.trimStart().length;
  const text = serialized.trim();
  const projectedRanges = pastedTextRanges.flatMap((range): ComposerPastedTextRange[] => {
    const start = Math.max(0, range.start - leadingTrim);
    const end = Math.min(text.length, range.end - leadingTrim);
    return start < end ? [{ start, end, display: range.display }] : [];
  });
  return {
    text,
    quotesEncoded: blocks.some((block) => block.kind === "quote"),
    ...(projectedRanges.length === 0 ? {} : { pastedTextRanges: projectedRanges })
  };
}

export function composerDocumentPlainText(document: unknown): string {
  return composerDocumentBlocks(normalizeComposerDocument(document))
    .filter((block) => block.kind === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

export function composerDocumentQuotes(document: unknown): readonly ComposerSelectionQuoteDraft[] {
  const result: ComposerSelectionQuoteDraft[] = [];
  walkComposerNodes(normalizeComposerDocument(document).content ?? [], (node) => {
    if (node.type !== COMPOSER_QUOTE_NODE_TYPE) return;
    const attrs = quoteAttrs(node.attrs);
    if (attrs !== undefined) result.push(attrs);
  });
  return result;
}

export function composerDocumentIsEmpty(document: unknown): boolean {
  const normalized = normalizeComposerDocument(document);
  let empty = true;
  walkComposerNodes(normalized.content ?? [], (node) => {
    if (node.type === "bulletList" || node.type === "orderedList") empty = false;
    if (node.type === COMPOSER_QUOTE_NODE_TYPE || node.type === COMPOSER_PASTED_TEXT_NODE_TYPE || node.type === COMPOSER_ROUTE_REFERENCE_NODE_TYPE || node.type === "hardBreak") empty = false;
    if (node.type === "text" && typeof node.text === "string" && node.text.length > 0) empty = false;
  });
  return empty;
}

/** Clear prose while retaining structured quote atoms. */
export function composerDocumentKeepingQuotes(document: unknown): JSONContent {
  const quotes = composerDocumentQuotes(document);
  return quotes.length === 0
    ? emptyComposerDocument()
    : { type: "doc", content: [paragraph(quotes.map(quoteNode))] };
}

export function appendTextToComposerDocument(document: unknown, text: string): JSONContent {
  const normalized = normalizeComposerDocument(document);
  const content = [...(normalized.content ?? [])];
  const additions = text.split("\n").flatMap((part, index): JSONContent[] => [
    ...(index === 0 ? [] : [{ type: "hardBreak" }]),
    ...(part === "" ? [] : [{ type: "text", text: part }])
  ]);
  if (content.at(-1)?.type === "paragraph") {
    const last = content.at(-1)!;
    content[content.length - 1] = paragraph([...(last.content ?? []), ...additions]);
  } else content.push(paragraph(additions));
  return { type: "doc", content };
}

/** Join two independent drafts without flattening quote, paste, reference, or list nodes. */
export function joinComposerDocuments(first: unknown, second: unknown): JSONContent {
  const left = normalizeComposerDocument(first);
  const right = normalizeComposerDocument(second);
  if (composerDocumentIsEmpty(left)) return right;
  if (composerDocumentIsEmpty(right)) return left;
  return normalizeComposerDocument({
    type: "doc",
    content: [
      ...(left.content ?? []),
      { type: "paragraph" },
      ...(right.content ?? [])
    ]
  });
}

function composerDocumentBlocks(document: JSONContent): readonly SerializedBlock[] {
  const blocks: SerializedBlock[] = [];
  for (const top of document.content ?? []) {
    if (top.type === "bulletList" || top.type === "orderedList") {
      const list = listSerializedProjection(top);
      blocks.push({ kind: "text", text: list.text, ...(list.pastedTextRanges.length === 0 ? {} : { pastedTextRanges: list.pastedTextRanges }) });
      continue;
    }
    const children = top.type === "paragraph" ? top.content ?? [] : [top];
    let buffer = "";
    let bufferPastedTextRanges: ComposerPastedTextRange[] = [];
    let emittedInline = false;
    const flushText = (force = false): void => {
      if (!force && buffer === "") return;
      blocks.push({
        kind: "text",
        text: buffer,
        ...(bufferPastedTextRanges.length === 0 ? {} : { pastedTextRanges: bufferPastedTextRanges })
      });
      buffer = "";
      bufferPastedTextRanges = [];
      emittedInline = true;
    };
    for (const child of children) {
      if (child.type === COMPOSER_QUOTE_NODE_TYPE) {
        const quote = quoteAttrs(child.attrs);
        if (quote === undefined) continue;
        flushText();
        blocks.push({ kind: "quote", text: selectionQuoteModelText(quote) });
        emittedInline = true;
      } else if (child.type === "hardBreak") buffer += "\n";
      else if (child.type === "text") buffer += child.text ?? "";
      else if (child.type === COMPOSER_PASTED_TEXT_NODE_TYPE) {
        const attrs = pastedTextAttrs(child.attrs);
        if (attrs !== undefined) {
          const start = buffer.length;
          buffer += attrs.text;
          bufferPastedTextRanges.push({ start, end: buffer.length, display: attrs.display });
        }
      }
      else if (child.type === COMPOSER_ROUTE_REFERENCE_NODE_TYPE) buffer += routeReferenceAttrs(child.attrs)?.serialized ?? "";
    }
    flushText(!emittedInline);
  }
  return blocks;
}

interface InlineSerializedProjection {
  readonly text: string;
  readonly pastedTextRanges: readonly ComposerPastedTextRange[];
}

function inlineNodesSerializedProjection(nodes: readonly JSONContent[], continuationIndent = ""): InlineSerializedProjection {
  let text = "";
  const pastedTextRanges: ComposerPastedTextRange[] = [];
  for (const node of nodes) {
    if (node.type === "text") text += node.text ?? "";
    else if (node.type === "hardBreak") text += `\n${continuationIndent}`;
    else if (node.type === COMPOSER_PASTED_TEXT_NODE_TYPE) {
      const attrs = pastedTextAttrs(node.attrs);
      if (attrs !== undefined) {
        const start = text.length;
        text += continuationIndent === "" ? attrs.text : attrs.text.replace(/\n/gu, `\n${continuationIndent}`);
        pastedTextRanges.push({ start, end: text.length, display: attrs.display });
      }
    }
    else if (node.type === COMPOSER_ROUTE_REFERENCE_NODE_TYPE) text += routeReferenceAttrs(node.attrs)?.serialized ?? "";
    else if (node.type === COMPOSER_QUOTE_NODE_TYPE) {
      const quote = quoteAttrs(node.attrs);
      if (quote !== undefined) text += selectionQuoteModelText(quote);
    }
  }
  return { text, pastedTextRanges };
}

function listSerializedProjection(list: JSONContent, indent = ""): InlineSerializedProjection {
  const attrs = normalizedListAttrs(list) ?? {};
  const start = Number(attrs["start"] ?? 1);
  const marker = String(attrs["marker"] ?? (list.type === "bulletList" ? "-" : "."));
  const separator = String(attrs["separator"] ?? (marker === "、" ? "" : " "));
  const lines: InlineSerializedProjection[] = [];
  (list.content ?? []).forEach((item, itemIndex) => {
    const blocks = item.type === "listItem" ? item.content ?? [] : [];
    const firstParagraph = blocks.find((block) => block.type === "paragraph");
    const prefix = list.type === "orderedList"
      ? `${indent}${start + itemIndex}${marker}${separator}`
      : `${indent}${marker}${separator}`;
    const continuationIndent = " ".repeat(prefix.length);
    const first = inlineNodesSerializedProjection(firstParagraph?.content ?? [], continuationIndent);
    lines.push({
      text: `${prefix}${first.text}`,
      pastedTextRanges: first.pastedTextRanges.map((range) => ({
        ...range,
        start: prefix.length + range.start,
        end: prefix.length + range.end
      }))
    });
    for (const child of blocks) {
      if (child === firstParagraph) continue;
      if (child.type === "bulletList" || child.type === "orderedList") {
        lines.push(listSerializedProjection(child, continuationIndent));
      } else if (child.type === "paragraph") {
        const continuation = inlineNodesSerializedProjection(child.content ?? [], continuationIndent);
        lines.push({
          text: `${continuationIndent}${continuation.text}`,
          pastedTextRanges: continuation.pastedTextRanges.map((range) => ({
            ...range,
            start: continuationIndent.length + range.start,
            end: continuationIndent.length + range.end
          }))
        });
      }
    }
  });
  return joinSerializedLines(lines);
}

function joinSerializedLines(lines: readonly InlineSerializedProjection[]): InlineSerializedProjection {
  let text = "";
  const pastedTextRanges: ComposerPastedTextRange[] = [];
  lines.forEach((line, index) => {
    if (index > 0) text += "\n";
    const lineStart = text.length;
    text += line.text;
    for (const range of line.pastedTextRanges) {
      pastedTextRanges.push({ ...range, start: lineStart + range.start, end: lineStart + range.end });
    }
  });
  return { text, pastedTextRanges };
}

function normalizeListNode(node: Record<string, unknown>): JSONContent | undefined {
  const type = node["type"];
  if (type !== "bulletList" && type !== "orderedList") return undefined;
  const candidate: JSONContent = {
    type,
    ...(node["attrs"] !== undefined ? { attrs: node["attrs"] as JSONContent["attrs"] } : {})
  };
  const attrs = normalizedListAttrs(candidate);
  const items = Array.isArray(node["content"])
    ? node["content"].flatMap((item): JSONContent[] => {
        if (item === null || typeof item !== "object" || Array.isArray(item)) return [];
        const record = item as Record<string, unknown>;
        if (record["type"] !== "listItem" || !Array.isArray(record["content"])) return [];
        const blocks = record["content"].flatMap((block): JSONContent[] => {
          if (block === null || typeof block !== "object" || Array.isArray(block)) return [];
          const blockRecord = block as Record<string, unknown>;
          if (blockRecord["type"] === "paragraph") {
            const inline = Array.isArray(blockRecord["content"])
              ? blockRecord["content"].flatMap((child): JSONContent[] => normalizeInlineNode(child))
              : [];
            return [paragraph(inline)];
          }
          if (blockRecord["type"] === "bulletList" || blockRecord["type"] === "orderedList") {
            const nested = normalizeListNode(blockRecord);
            return nested === undefined ? [] : [nested];
          }
          return [];
        });
        const safeBlocks = blocks.length > 0 && blocks[0]?.type === "paragraph" ? blocks : [paragraph(), ...blocks];
        return [{ type: "listItem", content: safeBlocks }];
      })
    : [];
  if (items.length === 0) return undefined;
  return { type, ...(attrs === undefined ? {} : { attrs }), content: items };
}

function walkComposerNodes(nodes: readonly JSONContent[], visit: (node: JSONContent) => void): void {
  for (const node of nodes) {
    visit(node);
    if (node.content !== undefined) walkComposerNodes(node.content, visit);
  }
}

function normalizeInlineNode(value: unknown): JSONContent[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  const node = value as Record<string, unknown>;
  if (node["type"] === "text" && typeof node["text"] === "string" && node["text"] !== "") {
    return [{ type: "text", text: node["text"] }];
  }
  if (node["type"] === "hardBreak") return [{ type: "hardBreak" }];
  if (node["type"] === COMPOSER_QUOTE_NODE_TYPE) {
    const quote = quoteAttrs(node["attrs"]);
    return quote === undefined ? [] : [quoteNode(quote)];
  }
  if (node["type"] === COMPOSER_PASTED_TEXT_NODE_TYPE) {
    const attrs = pastedTextAttrs(node["attrs"]);
    return attrs === undefined ? [] : [{ type: COMPOSER_PASTED_TEXT_NODE_TYPE, attrs }];
  }
  if (node["type"] === COMPOSER_ROUTE_REFERENCE_NODE_TYPE) {
    const attrs = routeReferenceAttrs(node["attrs"]);
    return attrs === undefined ? [] : [{ type: COMPOSER_ROUTE_REFERENCE_NODE_TYPE, attrs }];
  }
  return [];
}

function pastedTextAttrs(value: unknown): { readonly text: string; readonly display: string } | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const attrs = value as Record<string, unknown>;
  return typeof attrs["text"] === "string"
    && attrs["text"].length > 0
    && attrs["text"].length <= COMPOSER_LONG_PASTE_ATTRIBUTE_LIMIT
    && typeof attrs["display"] === "string"
    && attrs["display"].length > 0
    && attrs["display"].length <= 500
    ? { text: attrs["text"], display: attrs["display"] }
    : undefined;
}

function routeReferenceAttrs(value: unknown): { readonly kind: "session" | "project" | "path"; readonly display: string; readonly serialized: string; readonly reference: string; readonly href?: string; readonly semanticText?: string; readonly semanticTextTruncated?: boolean } | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const attrs = value as Record<string, unknown>;
  const kind = attrs["kind"];
  const display = attrs["display"];
  const serialized = attrs["serialized"];
  const reference = attrs["reference"];
  const href = attrs["href"];
  const semanticText = attrs["semanticText"];
  const semanticTextTruncated = attrs["semanticTextTruncated"];
  if ((kind !== "session" && kind !== "project" && kind !== "path")
    || typeof display !== "string" || display.length === 0 || display.length > 500
    || typeof serialized !== "string" || serialized.length === 0 || serialized.length > 4_096
    || typeof reference !== "string" || reference.length === 0 || reference.length > 1_024
    || /[\u0000-\u001f\u007f]/u.test(reference)
    || (href !== undefined && href !== null && (typeof href !== "string" || href.length === 0 || href.length > 4_096))
    || (semanticText !== undefined && semanticText !== null && (typeof semanticText !== "string" || semanticText.length === 0 || semanticText.length > COMPOSER_MESSAGE_REFERENCE_TEXT_LIMIT))
    || (semanticTextTruncated !== undefined && semanticTextTruncated !== null && typeof semanticTextTruncated !== "boolean")) return undefined;
  return {
    kind,
    display,
    serialized,
    reference,
    ...(typeof href === "string" ? { href } : {}),
    ...(typeof semanticText === "string" ? { semanticText } : {}),
    ...(semanticTextTruncated === true ? { semanticTextTruncated: true } : {})
  };
}

function normalizeTopLevelQuoteNodes(source: readonly JSONContent[]): JSONContent[] {
  const result: JSONContent[] = [];
  let pending: JSONContent[] = [];
  const flush = (): void => {
    if (pending.length > 0) result.push(paragraph(pending));
    pending = [];
  };
  for (const node of source) {
    if (node.type === COMPOSER_QUOTE_NODE_TYPE) {
      pending.push(node);
    } else if (node.type === "paragraph" && pending.length > 0) {
      result.push(paragraph([...pending, ...(node.content ?? [])]));
      pending = [];
    } else {
      flush();
      result.push(node);
    }
  }
  flush();
  return result;
}

function quoteAttrs(value: unknown): ComposerSelectionQuoteDraft | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return normalizeSelectionQuoteDrafts([value])[0];
}

function quoteNode(quote: ComposerSelectionQuoteDraft): JSONContent {
  return { type: COMPOSER_QUOTE_NODE_TYPE, attrs: { ...quote } };
}

function paragraph(content: JSONContent[] = []): JSONContent {
  return content.length === 0 ? { type: "paragraph" } : { type: "paragraph", content };
}

function isPureLineBreakText(text: string): boolean {
  return text.length > 0 && [...text].every((character) => character === "\n");
}

function restoredQuoteId(purpose: "edit" | "history", messageId: string, index: number): string {
  return `${purpose}:quote:${messageId.slice(0, 960)}:${index}`;
}

function splitEditedTextIslands(text: string, count: number): string[] {
  const pieces = text.split("\n\n");
  if (pieces.length <= count) return [...pieces, ...Array.from({ length: count - pieces.length }, () => "")];
  return [...pieces.slice(0, count - 1), pieces.slice(count - 1).join("\n\n")];
}

const LIST_ROW_MARKER_RE = /^(?:[-+*•][ \t]+|[1-9]\d{0,8}[.)][ \t]+|[1-9]\d{0,8}、[ \t]*)/u;
