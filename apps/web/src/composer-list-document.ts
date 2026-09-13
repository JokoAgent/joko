import type { JSONContent } from "@tiptap/core";

type ListKind = "bullet" | "ordered";
type OrderedMarker = "." | ")" | "、";

interface ListMarker {
  readonly kind: ListKind;
  readonly prefixLength: number;
  readonly marker: string;
  readonly separator: string;
  readonly start?: number;
}

interface ComposerLine {
  readonly content: JSONContent[];
  readonly text: string;
}

interface FenceState {
  readonly character: "`" | "~";
  readonly length: number;
}

const BULLET_RE = /^([-+*•])([ \t]+)/u;
const ORDERED_RE = /^([1-9]\d{0,8})([.)、])([ \t]*)/u;

function inlineNodeText(node: JSONContent): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  return "\uFFFC";
}

function pushLine(lines: ComposerLine[], content: JSONContent[]): void {
  lines.push({ content, text: content.map(inlineNodeText).join("") });
}

function splitParagraphLines(paragraph: JSONContent): ComposerLine[] {
  const lines: ComposerLine[] = [];
  let current: JSONContent[] = [];
  for (const node of paragraph.content ?? []) {
    if (node.type === "hardBreak") {
      pushLine(lines, current);
      current = [];
      continue;
    }
    if (node.type === "text" && (node.text ?? "").includes("\n")) {
      const parts = (node.text ?? "").split("\n");
      parts.forEach((part, index) => {
        if (part !== "") current.push({ ...node, text: part });
        if (index < parts.length - 1) {
          pushLine(lines, current);
          current = [];
        }
      });
      continue;
    }
    current.push(node);
  }
  pushLine(lines, current);
  return lines;
}

function parseListMarker(text: string): ListMarker | undefined {
  if (/^[ \t]/u.test(text)) return undefined;
  const bullet = text.match(BULLET_RE);
  if (bullet !== null) return {
    kind: "bullet",
    prefixLength: bullet[0].length,
    marker: bullet[1] ?? "-",
    separator: bullet[2] ?? " "
  };
  const ordered = text.match(ORDERED_RE);
  if (ordered === null) return undefined;
  const marker = ordered[2] as OrderedMarker;
  if (marker !== "、" && (ordered[3]?.length ?? 0) === 0) return undefined;
  return {
    kind: "ordered",
    prefixLength: marker === "、" ? (ordered[1]?.length ?? 0) + 1 : ordered[0].length,
    marker,
    separator: marker === "、" ? "" : (ordered[3] ?? " "),
    start: Number(ordered[1])
  };
}

function stripPrefix(content: readonly JSONContent[], prefixLength: number): JSONContent[] | undefined {
  const first = content[0];
  if (first?.type !== "text" || (first.text?.length ?? 0) < prefixLength) return undefined;
  const remaining = (first.text ?? "").slice(prefixLength);
  return remaining === "" ? [...content.slice(1)] : [{ ...first, text: remaining }, ...content.slice(1)];
}

function paragraphFromLine(line: ComposerLine, attrs?: JSONContent["attrs"]): JSONContent {
  return {
    type: "paragraph",
    ...(attrs === undefined ? {} : { attrs }),
    ...(line.content.length === 0 ? {} : { content: line.content })
  };
}

function listFromLines(lines: readonly ComposerLine[], marker: ListMarker, paragraphAttrs?: JSONContent["attrs"]): JSONContent {
  const content = lines.map((line) => {
    const lineMarker = parseListMarker(line.text);
    const inline = stripPrefix(line.content, lineMarker?.prefixLength ?? marker.prefixLength) ?? line.content;
    return { type: "listItem", content: [paragraphFromLine({ content: [...inline], text: "" }, paragraphAttrs)] };
  });
  const attrs = marker.kind === "ordered"
    ? { start: marker.start ?? 1, marker: marker.marker, separator: marker.separator }
    : { marker: marker.marker, separator: marker.separator };
  return { type: marker.kind === "ordered" ? "orderedList" : "bulletList", attrs, content };
}

function sameListMarker(left: ListMarker, right: ListMarker): boolean {
  return left.kind === right.kind && left.marker === right.marker && left.separator === right.separator;
}

function canAppendListLine(current: ListMarker, count: number, next: ListMarker): boolean {
  if (!sameListMarker(current, next)) return false;
  return current.kind === "bullet" || next.start === (current.start ?? 1) + count;
}

function fenceOpening(text: string): FenceState | undefined {
  const match = text.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
  if (match === null || match[1] === undefined || match[2] === undefined) return undefined;
  const character = match[1][0] as FenceState["character"];
  if (character === "`" && match[2].includes("`")) return undefined;
  return { character, length: match[1].length };
}

function isFenceClosing(text: string, state: FenceState): boolean {
  return new RegExp(`^ {0,3}${state.character}{${state.length},}[ \\t]*$`, "u").test(text);
}

function paragraphToBlocks(paragraph: JSONContent, initialFence: FenceState | undefined): { readonly blocks: JSONContent[]; readonly fence: FenceState | undefined } {
  const lines = splitParagraphLines(paragraph);
  const blocks: JSONContent[] = [];
  let plainLines: ComposerLine[] = [];
  let listLines: ComposerLine[] = [];
  let listMarker: ListMarker | undefined;
  let fence = initialFence;
  const flushPlain = (): void => {
    for (const line of plainLines) blocks.push(paragraphFromLine(line, paragraph.attrs));
    plainLines = [];
  };
  const flushList = (): void => {
    if (listLines.length > 0 && listMarker !== undefined) blocks.push(listFromLines(listLines, listMarker, paragraph.attrs));
    listLines = [];
    listMarker = undefined;
  };
  for (const line of lines) {
    if (fence !== undefined) {
      flushList();
      plainLines.push(line);
      if (isFenceClosing(line.text, fence)) fence = undefined;
      continue;
    }
    const opening = fenceOpening(line.text);
    if (opening !== undefined) {
      flushList();
      plainLines.push(line);
      fence = opening;
      continue;
    }
    const marker = parseListMarker(line.text);
    if (marker === undefined || stripPrefix(line.content, marker.prefixLength) === undefined) {
      flushList();
      plainLines.push(line);
      continue;
    }
    if (listMarker !== undefined && !canAppendListLine(listMarker, listLines.length, marker)) flushList();
    flushPlain();
    listMarker ??= marker;
    listLines.push(line);
  }
  flushList();
  flushPlain();
  return { blocks, fence };
}

function canMergeLists(left: JSONContent, right: JSONContent): boolean {
  if (left.type !== right.type || (left.type !== "bulletList" && left.type !== "orderedList")) return false;
  const leftMarker = left.attrs?.["marker"] ?? (left.type === "bulletList" ? "-" : ".");
  const rightMarker = right.attrs?.["marker"] ?? (right.type === "bulletList" ? "-" : ".");
  const leftSeparator = left.attrs?.["separator"] ?? (leftMarker === "、" ? "" : " ");
  const rightSeparator = right.attrs?.["separator"] ?? (rightMarker === "、" ? "" : " ");
  if (leftMarker !== rightMarker || leftSeparator !== rightSeparator) return false;
  if (left.type === "bulletList") return true;
  const leftStart = Number(left.attrs?.["start"] ?? 1);
  const rightStart = Number(right.attrs?.["start"] ?? 1);
  return Number.isInteger(leftStart) && Number.isInteger(rightStart) && leftStart + (left.content?.length ?? 0) === rightStart;
}

export function promoteComposerMarkdownLists(document: JSONContent): JSONContent {
  if (document.type !== "doc" || !Array.isArray(document.content)) return document;
  const content: JSONContent[] = [];
  let fence: FenceState | undefined;
  for (const node of document.content) {
    const result = node.type === "paragraph" ? paragraphToBlocks(node, fence) : { blocks: [node], fence };
    fence = result.fence;
    for (const block of result.blocks) {
      const previous = content.at(-1);
      if (previous !== undefined && canMergeLists(previous, block)) {
        content[content.length - 1] = { ...previous, content: [...(previous.content ?? []), ...(block.content ?? [])] };
      } else content.push(block);
    }
  }
  return { ...document, content };
}

export function normalizedListAttrs(node: JSONContent): JSONContent["attrs"] | undefined {
  if (node.type === "bulletList") {
    const marker = ["-", "+", "*", "•"].includes(String(node.attrs?.["marker"])) ? String(node.attrs?.["marker"]) : "-";
    const separator = typeof node.attrs?.["separator"] === "string" && node.attrs["separator"].length > 0 ? node.attrs["separator"] : " ";
    return { marker, separator };
  }
  if (node.type === "orderedList") {
    const candidate = Number(node.attrs?.["start"] ?? 1);
    const start = Number.isInteger(candidate) && candidate > 0 && candidate <= 999_999_999 ? candidate : 1;
    const marker = [".", ")", "、"].includes(String(node.attrs?.["marker"])) ? String(node.attrs?.["marker"]) : ".";
    const separator = marker === "、" ? "" : (typeof node.attrs?.["separator"] === "string" && node.attrs["separator"].length > 0 ? node.attrs["separator"] : " ");
    return { start, marker, separator };
  }
  return undefined;
}

export function listItemMarkdownLines(
  list: JSONContent,
  inlineText: (nodes: readonly JSONContent[]) => string,
  depth = 0
): string[] {
  const attrs = normalizedListAttrs(list) ?? {};
  const start = Number(attrs["start"] ?? 1);
  const marker = String(attrs["marker"] ?? (list.type === "bulletList" ? "-" : "."));
  const separator = String(attrs["separator"] ?? (marker === "、" ? "" : " "));
  const indent = "  ".repeat(depth);
  const lines: string[] = [];
  (list.content ?? []).forEach((item, itemIndex) => {
    const blocks = item.type === "listItem" ? item.content ?? [] : [];
    const paragraph = blocks.find((block) => block.type === "paragraph");
    const ordinal = list.type === "orderedList" ? String(start + itemIndex) : "";
    const prefix = list.type === "orderedList" ? `${ordinal}${marker}${separator}` : `${marker}${separator}`;
    const body = inlineText(paragraph?.content ?? []);
    lines.push(`${indent}${prefix}${body}`);
    for (const child of blocks) {
      if (child.type === "bulletList" || child.type === "orderedList") lines.push(...listItemMarkdownLines(child, inlineText, depth + 1));
      else if (child.type === "paragraph" && child !== paragraph) lines.push(`${indent}  ${inlineText(child.content ?? [])}`);
    }
  });
  return lines;
}

export function composerDocumentContainsList(document: JSONContent): boolean {
  return document.type === "doc" && (document.content ?? []).some((node) => node.type === "bulletList" || node.type === "orderedList");
}
