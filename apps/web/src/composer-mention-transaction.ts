import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { normalizedListAttrs } from "./composer-list-document.js";
import { COMPOSER_QUOTE_NODE_TYPE, composerDocumentPlainText, normalizeComposerDocument } from "./composer-quote-document.js";
import type { ComposerInlineMentionRange, ComposerSelectionQuoteDraft } from "./model.js";
import { selectionQuoteModelText } from "./selection-quote.js";
import { COMPOSER_PASTED_TEXT_NODE_TYPE, COMPOSER_ROUTE_REFERENCE_NODE_TYPE } from "./components/composer-paste-pipeline.js";

export type ComposerMentionRangeMapper = (ranges: readonly ComposerInlineMentionRange[]) => readonly ComposerInlineMentionRange[];

interface TextProjection {
  readonly text: string;
  /** Only editable text characters have a document position. */
  readonly positions: readonly (number | undefined)[];
}

/** Preserve occurrence identity through the editor's actual edits, including repeated tokens. */
export function createComposerMentionTransactionMapper(transactions: readonly Transaction[]): ComposerMentionRangeMapper {
  const edits = transactions.filter((transaction) => transaction.docChanged).map((transaction) => ({
    before: projectDocument(transaction.before),
    after: projectDocument(transaction.doc),
    maps: [...transaction.mapping.maps]
  }));
  return (ranges) => edits.reduce<readonly ComposerInlineMentionRange[]>((current, edit) => {
    const { before, after } = edit;
    if (before === undefined || after === undefined) return [];
    const afterOffsets = new Map(after.positions.flatMap((position, offset) => position === undefined ? [] : [[position, offset] as const]));
    return current.flatMap((range) => {
      const length = range.to - range.from;
      let start = before.positions[range.from];
      if (start === undefined || length <= 0 || range.from < 0 || range.to > before.text.length
        || !Number.isSafeInteger(range.from) || !Number.isSafeInteger(range.to)) return [];
      if (!before.positions.slice(range.from, range.to).every((position, index) => position === start! + index)) return [];
      let end = start + length;
      for (const map of edit.maps) {
        let touched = false;
        map.forEach((from, to) => {
          if (from === to ? start! < from && from < end : from < end && to > start!) touched = true;
        });
        if (touched) return [];
        start = map.map(start, 1);
        end = map.map(end, -1);
      }
      const from = afterOffsets.get(start);
      if (from === undefined || end - start !== length
        || !after.positions.slice(from, from + length).every((position, index) => position === start! + index)
        || after.text.slice(from, from + length) !== before.text.slice(range.from, range.to)) return [];
      return [{ ...range, from, to: from + length }];
    });
  }, ranges);
}

function literal(text: string): TextProjection {
  return { text, positions: Array.from({ length: text.length }) };
}

function join(parts: readonly TextProjection[], separator = ""): TextProjection {
  return {
    text: parts.map((part) => part.text).join(separator),
    positions: parts.flatMap((part, index) => [...(index === 0 ? [] : literal(separator).positions), ...part.positions])
  };
}

function children(node: ProseMirrorNode, position: number): readonly { node: ProseMirrorNode; position: number }[] {
  const result: { node: ProseMirrorNode; position: number }[] = [];
  node.forEach((child, offset) => result.push({ node: child, position: position + 1 + offset }));
  return result;
}

function normalizedAtom(node: ProseMirrorNode): { readonly type?: string; readonly attrs?: Record<string, unknown> } | undefined {
  return normalizeComposerDocument({ type: "doc", content: [{ type: "paragraph", content: [node.toJSON()] }] }).content?.[0]?.content?.[0];
}

function inline(node: ProseMirrorNode, position: number, indent = ""): TextProjection {
  if (node.isText) return { text: node.text!, positions: Array.from({ length: node.text!.length }, (_, index) => position + index) };
  if (node.type.name === "hardBreak") return literal(`\n${indent}`);
  const atom = normalizedAtom(node);
  if (atom?.type === COMPOSER_PASTED_TEXT_NODE_TYPE) return literal(String(atom.attrs?.["text"] ?? "").replace(/\n/gu, `\n${indent}`));
  if (atom?.type === COMPOSER_ROUTE_REFERENCE_NODE_TYPE) return literal(String(atom.attrs?.["serialized"] ?? ""));
  if (atom?.type === COMPOSER_QUOTE_NODE_TYPE) return literal(selectionQuoteModelText(atom.attrs as unknown as ComposerSelectionQuoteDraft));
  return literal("");
}

function listProjection(list: ProseMirrorNode, position: number, indent = ""): TextProjection {
  const attrs = normalizedListAttrs(list.toJSON()) ?? {};
  const start = Number(attrs["start"] ?? 1);
  const marker = String(attrs["marker"] ?? (list.type.name === "bulletList" ? "-" : "."));
  const separator = String(attrs["separator"] ?? (marker === "、" ? "" : " "));
  const lines: TextProjection[] = [];
  children(list, position).forEach((item, index) => {
    const blocks = children(item.node, item.position);
    const first = blocks.find((block) => block.node.type.name === "paragraph");
    const prefix = `${indent}${list.type.name === "orderedList" ? start + index : ""}${marker}${separator}`;
    const continuation = " ".repeat(prefix.length);
    const paragraph = (block: { node: ProseMirrorNode; position: number }): TextProjection => join(children(block.node, block.position).map((child) => inline(child.node, child.position, continuation)));
    lines.push(join([literal(prefix), first === undefined ? literal("") : paragraph(first)]));
    for (const block of blocks) {
      if (block === first) continue;
      if (block.node.type.name === "bulletList" || block.node.type.name === "orderedList") lines.push(listProjection(block.node, block.position, continuation));
      else if (block.node.type.name === "paragraph") lines.push(join([literal(continuation), paragraph(block)]));
    }
  });
  return join(lines, "\n");
}

/** Match the public plain-text projection while retaining each editable character's origin. */
function projectDocument(document: ProseMirrorNode): TextProjection | undefined {
  const blocks: TextProjection[] = [];
  for (const top of children(document, -1)) {
    if (top.node.type.name === "bulletList" || top.node.type.name === "orderedList") {
      blocks.push(listProjection(top.node, top.position));
      continue;
    }
    const nodes = top.node.type.name === "paragraph" ? children(top.node, top.position) : [top];
    let buffer: TextProjection[] = [];
    let emitted = false;
    const flush = (force = false): void => {
      const projection = join(buffer);
      if (!force && projection.text === "") return;
      blocks.push(projection);
      buffer = [];
      emitted = true;
    };
    for (const child of nodes) {
      if (child.node.type.name === COMPOSER_QUOTE_NODE_TYPE) {
        if (normalizedAtom(child.node)?.type !== COMPOSER_QUOTE_NODE_TYPE) continue;
        flush();
        emitted = true;
      } else buffer.push(inline(child.node, child.position));
    }
    flush(!emitted);
  }
  const projection = join(blocks, "\n");
  const text = projection.text.trim();
  // A new serializer shape must supply a position projection before it can own tokens.
  if (text !== composerDocumentPlainText(document.toJSON())) return undefined;
  const leading = projection.text.length - projection.text.trimStart().length;
  return { text, positions: projection.positions.slice(leading, leading + text.length) };
}
