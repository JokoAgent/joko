import type { JSONContent } from "@tiptap/core";
import { normalizeComposerDocument } from "../composer-quote-document.js";
import {
  COMPOSER_PASTED_TEXT_NODE_TYPE,
  COMPOSER_ROUTE_REFERENCE_NODE_TYPE
} from "./composer-paste-pipeline.js";
import type {
  ComposerMentionDraft,
  ComposerTokenMentionDraft,
  ResourceView,
  WorkspaceEntryView
} from "../model.js";

export const COMPOSER_MENTION_RESULT_LIMIT = 8;

export interface ComposerInlineMentionActivation {
  readonly from: number;
  readonly to: number;
  readonly query: string;
  readonly quoted: boolean;
}

export interface ComposerInlineMentionRange {
  readonly mentionId: string;
  readonly from: number;
  readonly to: number;
}

export interface ComposerMentionCatalogItem {
  readonly id: string;
  readonly kind: "file" | "directory" | "resource";
  readonly name: string;
  readonly path: string;
  readonly meta: string;
  readonly mention?: ComposerTokenMentionDraft;
  readonly disabled?: boolean;
  readonly disabledReason?: string;
}

export type ComposerMentionProviderState =
  | { readonly kind: "loading"; readonly items?: readonly ComposerMentionCatalogItem[]; readonly truncated?: boolean }
  | { readonly kind: "ready"; readonly items: readonly ComposerMentionCatalogItem[]; readonly truncated: boolean; readonly searching?: boolean }
  | { readonly kind: "error"; readonly message: string; readonly items?: readonly ComposerMentionCatalogItem[]; readonly truncated?: boolean };

export interface ComposerMentionResults {
  readonly items: readonly ComposerMentionCatalogItem[];
  readonly truncated: boolean;
}

export type ComposerInlineMentionKeyIntent =
  | { readonly kind: "move"; readonly index: number }
  | { readonly kind: "select"; readonly index: number }
  | { readonly kind: "close" }
  | null;

/** Detect the complete inline query run that owns the caret. */
export function detectComposerInlineMention(text: string, caret: number): ComposerInlineMentionActivation | null {
  if (!Number.isInteger(caret) || caret < 0 || caret > text.length) return null;
  let candidate = text.lastIndexOf("@", Math.max(0, caret - 1));
  while (candidate >= 0) {
    if (candidate === 0 || /\s/u.test(text[candidate - 1] ?? "")) {
      const parsed = parseMentionRun(text, candidate, caret);
      if (parsed !== null) return parsed;
    }
    candidate = text.lastIndexOf("@", candidate - 1);
  }
  return null;
}

/** Serialize one selected path without treating backslashes as escape syntax. */
export function serializeComposerMentionPath(path: string, directory = false): string {
  const value = directory ? withDirectorySlash(path) : path;
  return needsMentionQuotes(value)
    ? `@"${value.replace(/"/gu, '\\"')}"`
    : `@${value}`;
}

/** Directory selection stays an open query so the next level can be selected. */
export function composerDirectoryQueryToken(path: string): string {
  const value = withDirectorySlash(path);
  return needsMentionQuotes(value)
    ? `@"${value.replace(/"/gu, '\\"')}`
    : `@${value}`;
}

export function composerMentionCatalog(
  entries: readonly WorkspaceEntryView[],
  workspaceId: string | undefined,
  resources: readonly ResourceView[],
  indexedPaths: readonly string[] = []
): readonly ComposerMentionCatalogItem[] {
  const result = flattenWorkspaceCatalog(entries, workspaceId);
  result.push(...workspaceFileIndexCatalog(indexedPaths, workspaceId));
  for (const resource of resources) {
    const token = serializeComposerMentionPath(resource.name);
    const disabled = !resource.enabled || resource.state !== "loaded";
    result.push({
      id: `resource:${resource.id}`,
      kind: "resource",
      name: resource.name,
      path: resource.name,
      meta: resource.kind,
      ...(disabled ? { disabled: true, disabledReason: resource.state } : {}),
      mention: {
        id: `resource:${resource.id}`,
        kind: "resource",
        reference: resource.id,
        label: resource.name,
        token
      }
    });
  }
  return uniqueCatalog(result);
}

/** Expand the generated, bounded filename index into the same navigable
 * directory/file grammar as visible workspace entries. */
export function workspaceFileIndexCatalog(
  paths: readonly string[],
  workspaceId: string | undefined
): readonly ComposerMentionCatalogItem[] {
  const result: ComposerMentionCatalogItem[] = [];
  const directories = new Set<string>();
  for (const rawPath of paths) {
    const path = normalizedPath(rawPath).replace(/^\.\//u, "").replace(/^\/+|\/+$/gu, "");
    if (path === "") continue;
    const parts = path.split("/").filter(Boolean);
    for (let index = 1; index < parts.length; index += 1) directories.add(parts.slice(0, index).join("/"));
    const name = parts.at(-1);
    if (name === undefined) continue;
    const token = serializeComposerMentionPath(path);
    result.push({
      id: `file:${workspaceId ?? ""}:${path}`,
      kind: "file",
      name,
      path,
      meta: path,
      mention: {
        id: `workspace:${workspaceId ?? ""}:${path}`,
        kind: "workspace",
        reference: path,
        label: name,
        token,
        ...(workspaceId === undefined ? {} : { workspaceId })
      }
    });
  }
  for (const path of directories) {
    const parts = path.split("/");
    result.push({
      id: `directory:${workspaceId ?? ""}:${path}`,
      kind: "directory",
      name: parts.at(-1) ?? path,
      path: withDirectorySlash(path),
      meta: withDirectorySlash(path)
    });
  }
  return uniqueCatalog(result);
}

export function resolveComposerMentionResults(
  state: ComposerMentionProviderState,
  query: string,
  limit = COMPOSER_MENTION_RESULT_LIMIT
): ComposerMentionResults {
  const boundedLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : COMPOSER_MENTION_RESULT_LIMIT;
  const candidates = state.items ?? [];
  const scoped = scopedMentionCandidates(candidates, query);
  const scored = scoped.map((item, ordinal) => ({
    item,
    ordinal,
    score: scoreComposerMentionItem(item, scopedQueryLeaf(query))
  })).filter((candidate) => candidate.score >= 0);
  scored.sort((left, right) => {
    if (left.score !== right.score) return right.score - left.score;
    if (scopedQueryLeaf(query) === "" && left.item.kind !== right.item.kind) {
      if (left.item.kind === "directory") return -1;
      if (right.item.kind === "directory") return 1;
    }
    return left.item.name.localeCompare(right.item.name)
      || left.item.path.localeCompare(right.item.path)
      || left.ordinal - right.ordinal;
  });
  return {
    items: scored.slice(0, boundedLimit).map((candidate) => candidate.item),
    truncated: state.truncated === true || scored.length > boundedLimit
  };
}

export function scoreComposerMentionItem(item: ComposerMentionCatalogItem, rawQuery: string): number {
  const query = normalizedPath(rawQuery.trim()).toLocaleLowerCase();
  if (query === "") return 1;
  const name = item.name.toLocaleLowerCase();
  const path = normalizedPath(item.path).toLocaleLowerCase();
  if (name.startsWith(query)) return 1000 - name.length;
  if (name.includes(query)) return 500 - name.length;
  if (fuzzyInOrder(name, query)) return 100 - name.length;
  if (fuzzyInOrder(path, query)) return 50 - path.length / 10;
  return -1;
}

export function firstEnabledComposerMentionIndex(items: readonly ComposerMentionCatalogItem[]): number {
  const index = items.findIndex((item) => item.disabled !== true);
  return index < 0 ? 0 : index;
}

export function nextEnabledComposerMentionIndex(
  items: readonly ComposerMentionCatalogItem[],
  current: number,
  delta: 1 | -1
): number {
  if (items.length === 0) return current;
  let index = Math.min(Math.max(current, 0), items.length - 1);
  for (let step = 0; step < items.length; step += 1) {
    index = (index + delta + items.length) % items.length;
    if (items[index]?.disabled !== true) return index;
  }
  return current;
}

export function resolveComposerInlineMentionKey(
  key: string,
  activeIndex: number,
  items: readonly ComposerMentionCatalogItem[]
): ComposerInlineMentionKeyIntent {
  if (key === "Escape") return { kind: "close" };
  if (key === "ArrowDown" || key === "ArrowUp") {
    return {
      kind: "move",
      index: items.length === 0
        ? activeIndex
        : nextEnabledComposerMentionIndex(items, activeIndex, key === "ArrowDown" ? 1 : -1)
    };
  }
  if (key !== "Enter" && key !== "Tab") return null;
  if (items.length === 0) return { kind: "select", index: activeIndex };
  const index = Math.min(Math.max(activeIndex, 0), items.length - 1);
  return { kind: "select", index };
}

/** Map structured mention ranges through one editor text transaction. */
export function remapComposerInlineMentionRanges(
  previousText: string,
  nextText: string,
  ranges: readonly ComposerInlineMentionRange[]
): readonly ComposerInlineMentionRange[] {
  if (previousText === nextText) return ranges;
  let prefix = 0;
  const shared = Math.min(previousText.length, nextText.length);
  while (prefix < shared && previousText[prefix] === nextText[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < shared - prefix
    && previousText[previousText.length - 1 - suffix] === nextText[nextText.length - 1 - suffix]
  ) suffix += 1;
  const previousEnd = previousText.length - suffix;
  const delta = nextText.length - previousText.length;
  return ranges.flatMap((range): readonly ComposerInlineMentionRange[] => {
    if (previousEnd <= range.from) return [{ ...range, from: range.from + delta, to: range.to + delta }];
    if (prefix >= range.to) return [range];
    return [];
  });
}

/** Rebuild range metadata from persisted structured mentions. */
export function restoreComposerInlineMentionRanges(
  text: string,
  mentions: readonly ComposerMentionDraft[]
): readonly ComposerInlineMentionRange[] {
  const result: ComposerInlineMentionRange[] = [];
  const byToken = new Map<string, ComposerTokenMentionDraft[]>();
  for (const mention of mentions) {
    if (mention.kind === "message" || mention.token === "") continue;
    byToken.set(mention.token, [...(byToken.get(mention.token) ?? []), mention]);
  }
  for (const [token, tokenMentions] of byToken) {
    const occurrences: number[] = [];
    for (let offset = 0; offset <= text.length - token.length;) {
      const from = text.indexOf(token, offset);
      if (from < 0) break;
      if (from === 0 || /\s/u.test(text[from - 1] ?? "")) occurrences.push(from);
      offset = from + Math.max(1, token.length);
    }
    if (tokenMentions.length === 1) {
      for (const from of occurrences) result.push({ mentionId: tokenMentions[0]!.id, from, to: from + token.length });
    } else {
      tokenMentions.forEach((mention, index) => {
        const from = occurrences[index];
        if (from !== undefined) result.push({ mentionId: mention.id, from, to: from + token.length });
      });
    }
  }
  return result.sort((left, right) => left.from - right.from || left.to - right.to);
}

export function composerMentionsFromRanges(
  mentions: readonly ComposerMentionDraft[],
  ranges: readonly ComposerInlineMentionRange[]
): readonly ComposerMentionDraft[] {
  const active = new Set(ranges.map((range) => range.mentionId));
  return mentions.filter((mention) => mention.kind === "message" || active.has(mention.id));
}

/** Replace a query contained by one prose text node while preserving quote atoms. */
export function replaceComposerDocumentTextRange(
  document: JSONContent,
  from: number,
  to: number,
  replacement: string
): JSONContent | undefined {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) return undefined;
  const normalized = normalizeComposerDocument(document);
  const projection = projectComposerDocumentText(normalized);
  if (to > projection.text.length) return undefined;
  if (from === to) return insertComposerDocumentText(normalized, projection.references, from, replacement);
  const references = projection.references.slice(from, to).filter((reference): reference is TextReference => reference !== null);
  if (references.length !== to - from || references.length === 0) return undefined;
  const first = references[0]!;
  const last = references.at(-1)!;
  if (!sameNodePath(first.path, last.path) || last.offset - first.offset + 1 !== references.length) return undefined;
  const clone = cloneDocument(normalized);
  const node = composerNodeAtPath(clone, first.path);
  if (node?.type !== "text" || typeof node.text !== "string") return undefined;
  node.text = `${node.text.slice(0, first.offset)}${replacement}${node.text.slice(last.offset + 1)}`;
  if (node.text === "") {
    const nodeIndex = first.path.at(-1);
    const parent = composerNodeAtPath(clone, first.path.slice(0, -1));
    if (nodeIndex === undefined || parent?.content === undefined) return undefined;
    parent.content.splice(nodeIndex, 1);
  }
  return normalizeComposerDocument(clone);
}

function insertComposerDocumentText(
  document: JSONContent,
  references: readonly (TextReference | null)[],
  at: number,
  replacement: string
): JSONContent | undefined {
  const clone = cloneDocument(document);
  const after = references[at];
  const before = at > 0 ? references[at - 1] : undefined;
  const reference = after ?? before;
  if (reference !== null && reference !== undefined) {
    const node = composerNodeAtPath(clone, reference.path);
    if (node?.type !== "text" || typeof node.text !== "string") return undefined;
    const offset = after === reference ? reference.offset : reference.offset + 1;
    node.text = `${node.text.slice(0, offset)}${replacement}${node.text.slice(offset)}`;
    return normalizeComposerDocument(clone);
  }
  const paragraph = firstComposerParagraph(clone);
  if (paragraph === undefined) return undefined;
  paragraph.content = [{ type: "text", text: replacement }, ...(paragraph.content ?? [])];
  return normalizeComposerDocument(clone);
}

function sameNodePath(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function composerNodeAtPath(document: JSONContent, path: readonly number[]): JSONContent | undefined {
  let node: JSONContent | undefined = document;
  for (const index of path) node = node?.content?.[index];
  return node;
}

function firstComposerParagraph(node: JSONContent): JSONContent | undefined {
  if (node.type === "paragraph") return node;
  for (const child of node.content ?? []) {
    const paragraph = firstComposerParagraph(child);
    if (paragraph !== undefined) return paragraph;
  }
  return undefined;
}

/** Resolve the browser caret to the same trimmed prose coordinate used by drafts. */
export function composerCaretTextOffset(root: HTMLElement | null, selection: Selection | null): number | undefined {
  if (root === null || selection === null || !selection.isCollapsed || selection.anchorNode === null) return undefined;
  if (selection.anchorNode !== root && !root.contains(selection.anchorNode)) return undefined;
  let prefix: DocumentFragment;
  try {
    const range = root.ownerDocument.createRange();
    range.selectNodeContents(root);
    range.setEnd(selection.anchorNode, selection.anchorOffset);
    prefix = range.cloneContents();
  } catch {
    return undefined;
  }
  const complete = composerDomText(root);
  const before = composerDomText(prefix);
  const leading = complete.length - complete.trimStart().length;
  return Math.min(complete.trim().length, Math.max(0, before.length - leading));
}

/** Resolve a collapsed caret or text selection to the draft's prose offsets. */
export function composerSelectionTextRange(
  root: HTMLElement | null,
  selection: Selection | null
): { readonly from: number; readonly to: number } | undefined {
  if (root === null || selection === null || selection.rangeCount !== 1) return undefined;
  const active = selection.getRangeAt(0);
  if (
    (active.startContainer !== root && !root.contains(active.startContainer))
    || (active.endContainer !== root && !root.contains(active.endContainer))
  ) return undefined;
  const complete = composerDomText(root);
  const leading = complete.length - complete.trimStart().length;
  const projected = (container: Node, offset: number): number | undefined => {
    try {
      const prefix = root.ownerDocument.createRange();
      prefix.selectNodeContents(root);
      prefix.setEnd(container, offset);
      return Math.min(complete.trim().length, Math.max(0, composerDomText(prefix.cloneContents()).length - leading));
    } catch {
      return undefined;
    }
  };
  const from = projected(active.startContainer, active.startOffset);
  const to = projected(active.endContainer, active.endOffset);
  return from === undefined || to === undefined ? undefined : { from: Math.min(from, to), to: Math.max(from, to) };
}

/** Restore the editor caret after a range replacement without reaching into editor internals. */
export function setComposerCaretTextOffset(root: HTMLElement | null, selection: Selection | null, offset: number): boolean {
  if (root === null || selection === null || !Number.isInteger(offset) || offset < 0) return false;
  const complete = composerDomText(root);
  const leading = complete.length - complete.trimStart().length;
  const target = Math.min(offset, complete.trim().length);
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let selected: { readonly node: Text; readonly offset: number } | undefined;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (!(node instanceof Text) || node.parentElement?.closest("[data-composer-quote]") !== null) continue;
    for (let local = 0; local <= node.data.length; local += 1) {
      let before: string;
      try {
        const range = root.ownerDocument.createRange();
        range.selectNodeContents(root);
        range.setEnd(node, local);
        before = composerDomText(range.cloneContents());
      } catch {
        continue;
      }
      const projected = Math.min(complete.trim().length, Math.max(0, before.length - leading));
      if (projected === target) selected = { node, offset: local };
      if (projected > target && selected !== undefined) break;
    }
  }
  if (selected === undefined) return false;
  const range = root.ownerDocument.createRange();
  range.setStart(selected.node, selected.offset);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

function parseMentionRun(text: string, from: number, caret: number): ComposerInlineMentionActivation | null {
  const afterAt = text.slice(from + 1, caret);
  if (afterAt.startsWith('"')) {
    const query = afterAt.slice(1);
    if (hasUnescapedQuote(query)) return null;
    let to = caret;
    while (to < text.length) {
      if (text[to] === '"' && text[to - 1] !== "\\") {
        to += 1;
        break;
      }
      to += 1;
    }
    return { from, to, query: query.replace(/\\"/gu, '"'), quoted: true };
  }
  if (/\s/u.test(afterAt)) return null;
  let to = caret;
  while (to < text.length && !/\s/u.test(text[to] ?? "")) to += 1;
  return { from, to, query: afterAt, quoted: false };
}

function flattenWorkspaceCatalog(
  entries: readonly WorkspaceEntryView[],
  workspaceId: string | undefined,
  parent = ""
): ComposerMentionCatalogItem[] {
  const result: ComposerMentionCatalogItem[] = [];
  for (const entry of entries) {
    const path = entry.path || `${parent}/${entry.name}`.replace(/^\//u, "");
    if (entry.kind === "directory") {
      result.push({
        id: `directory:${workspaceId ?? ""}:${path}`,
        kind: "directory",
        name: entry.name.replace(/[\\/]+$/u, ""),
        path: withDirectorySlash(path),
        meta: withDirectorySlash(path)
      });
      result.push(...flattenWorkspaceCatalog(entry.children ?? [], workspaceId, path));
      continue;
    }
    const token = serializeComposerMentionPath(path);
    result.push({
      id: `file:${workspaceId ?? ""}:${path}`,
      kind: "file",
      name: entry.name,
      path,
      meta: path,
      mention: {
        id: `workspace:${workspaceId ?? ""}:${path}`,
        kind: "workspace",
        reference: path,
        label: entry.name,
        token,
        ...(workspaceId === undefined ? {} : { workspaceId })
      }
    });
  }
  return result;
}

function scopedMentionCandidates(
  items: readonly ComposerMentionCatalogItem[],
  query: string
): readonly ComposerMentionCatalogItem[] {
  const normalized = normalizedPath(query.replace(/^"/u, ""));
  const separator = normalized.lastIndexOf("/");
  if (separator < 0) return items;
  const scope = normalized.slice(0, separator + 1).toLocaleLowerCase();
  return items.filter((item) => {
    const path = normalizedPath(item.path).replace(/\/+$/u, "");
    if (!path.toLocaleLowerCase().startsWith(scope)) return false;
    const remainder = path.slice(scope.length);
    return remainder !== "" && !remainder.includes("/");
  });
}

function scopedQueryLeaf(query: string): string {
  const normalized = normalizedPath(query.replace(/^"/u, ""));
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function uniqueCatalog(items: readonly ComposerMentionCatalogItem[]): ComposerMentionCatalogItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.kind}:${normalizedPath(item.path).toLocaleLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function needsMentionQuotes(path: string): boolean {
  return /\s/u.test(path) || path.includes('"');
}

function withDirectorySlash(path: string): string {
  return path.replace(/[\\/]+$/u, "") + "/";
}

function normalizedPath(path: string): string {
  return path.replace(/\\/gu, "/");
}

function fuzzyInOrder(haystack: string, needle: string): boolean {
  let index = 0;
  for (const character of haystack) {
    if (character === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return index === needle.length;
}

function hasUnescapedQuote(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '"' && value[index - 1] !== "\\") return true;
  }
  return false;
}

interface TextReference {
  readonly path: readonly number[];
  readonly offset: number;
}

function projectComposerDocumentText(document: JSONContent): { readonly text: string; readonly references: readonly (TextReference | null)[] } {
  const blocks = (document.content ?? []).flatMap((node, index) => projectComposerBlock(node, [index]));
  const rawText = blocks.map((block) => block.text).join("\n");
  const rawReferences = blocks.flatMap((block, index) => [
    ...(index === 0 ? [] : [null]),
    ...block.references
  ]);
  const leading = rawText.length - rawText.trimStart().length;
  const trailing = rawText.length - rawText.trimEnd().length;
  const end = Math.max(leading, rawText.length - trailing);
  return { text: rawText.slice(leading, end), references: rawReferences.slice(leading, end) };
}

interface ComposerTextProjection {
  readonly text: string;
  readonly references: readonly (TextReference | null)[];
}

function projectComposerBlock(node: JSONContent, path: readonly number[], indent = ""): readonly ComposerTextProjection[] {
  if (node.type === "paragraph") return [projectComposerInline(node.content ?? [], path)];
  if (node.type !== "bulletList" && node.type !== "orderedList") return [];
  const marker = String(node.attrs?.["marker"] ?? (node.type === "bulletList" ? "-" : "."));
  const separator = String(node.attrs?.["separator"] ?? (marker === "、" ? "" : " "));
  const start = Number(node.attrs?.["start"] ?? 1);
  const result: ComposerTextProjection[] = [];
  (node.content ?? []).forEach((item, itemIndex) => {
    const itemPath = [...path, itemIndex];
    const blocks = item.type === "listItem" ? item.content ?? [] : [];
    const paragraphIndex = blocks.findIndex((block) => block.type === "paragraph");
    const paragraph = paragraphIndex >= 0 ? blocks[paragraphIndex] : undefined;
    const prefix = node.type === "orderedList" ? `${indent}${start + itemIndex}${marker}${separator}` : `${indent}${marker}${separator}`;
    const inline = projectComposerInline(paragraph?.content ?? [], [...itemPath, paragraphIndex]);
    result.push({ text: prefix + inline.text, references: [...Array.from({ length: prefix.length }, () => null), ...inline.references] });
    blocks.forEach((block, blockIndex) => {
      if (block.type === "bulletList" || block.type === "orderedList") result.push(...projectComposerBlock(block, [...itemPath, blockIndex], `${indent}  `));
      else if (block.type === "paragraph" && blockIndex !== paragraphIndex) {
        const continuation = projectComposerInline(block.content ?? [], [...itemPath, blockIndex]);
        result.push({ text: `${indent}  ${continuation.text}`, references: [...Array.from({ length: indent.length + 2 }, () => null), ...continuation.references] });
      }
    });
  });
  return result;
}

function projectComposerInline(nodes: readonly JSONContent[], parentPath: readonly number[]): ComposerTextProjection {
  let text = "";
  const references: Array<TextReference | null> = [];
  nodes.forEach((node, index) => {
    if (node.type === "text" && typeof node.text === "string") {
      for (let offset = 0; offset < node.text.length; offset += 1) {
        text += node.text[offset];
        references.push({ path: [...parentPath, index], offset });
      }
    } else if (node.type === "hardBreak") {
      text += "\n";
      references.push(null);
    } else if (node.type === COMPOSER_PASTED_TEXT_NODE_TYPE) {
      const value = typeof node.attrs?.["text"] === "string" ? node.attrs["text"] : "";
      text += value;
      references.push(...Array.from({ length: value.length }, () => null));
    } else if (node.type === COMPOSER_ROUTE_REFERENCE_NODE_TYPE) {
      const value = typeof node.attrs?.["serialized"] === "string" ? node.attrs["serialized"] : "";
      text += value;
      references.push(...Array.from({ length: value.length }, () => null));
    }
  });
  return { text, references };
}

function cloneDocument(document: JSONContent): JSONContent {
  return {
    ...document,
    ...(document.attrs === undefined ? {} : { attrs: { ...document.attrs } }),
    ...(document.content === undefined ? {} : { content: document.content.map(cloneDocument) })
  };
}

function composerDomText(root: Node): string {
  const ownerDocument = root.ownerDocument ?? (root.nodeType === Node.DOCUMENT_NODE ? root as Document : undefined);
  const elementConstructor = ownerDocument?.defaultView?.Element ?? Element;
  const block = (node: Node): readonly string[] => {
    if (node instanceof elementConstructor) {
      const element = node as Element;
      if (element.matches("p")) return [inline(element)];
      if (element.matches("ul,ol")) return list(element);
    }
    const children = [...node.childNodes];
    const blockChildren = children.flatMap((child) => {
      if (child instanceof elementConstructor && (child as Element).matches("p,ul,ol")) return block(child);
      return [];
    });
    return blockChildren.length > 0 ? blockChildren : [inline(node)];
  };
  const inline = (node: Node): string => {
    let value = "";
    const visit = (candidate: Node): void => {
      if (candidate instanceof elementConstructor) {
        const element = candidate as Element;
        if (element.hasAttribute("data-composer-quote")) {
          if (value !== "" && !value.endsWith("\n")) value += "\n";
          return;
        }
        if (element.hasAttribute("data-composer-pasted-text")) {
          value += element.getAttribute("data-composer-pasted-text") ?? "";
          return;
        }
        if (element.hasAttribute("data-composer-mention")) {
          value += element.getAttribute("data-serialized") ?? "";
          return;
        }
        if (element.tagName === "BR") {
          value += "\n";
          return;
        }
      }
      if (candidate.nodeType === candidate.TEXT_NODE) {
        value += candidate.textContent ?? "";
        return;
      }
      candidate.childNodes.forEach(visit);
    };
    node.childNodes.forEach(visit);
    return value;
  };
  const list = (element: Element, indent = ""): readonly string[] => {
    const ordered = element.tagName === "OL";
    const marker = element.getAttribute("data-marker") ?? (ordered ? "." : "-");
    const separator = element.getAttribute("data-separator") ?? (marker === "、" ? "" : " ");
    const start = ordered ? Number(element.getAttribute("start") ?? 1) : 1;
    const lines: string[] = [];
    [...element.children].filter((child) => child.tagName === "LI").forEach((item, index) => {
      const paragraph = [...item.children].find((child) => child.tagName === "P");
      const prefix = ordered ? `${indent}${start + index}${marker}${separator}` : `${indent}${marker}${separator}`;
      lines.push(prefix + (paragraph === undefined ? "" : inline(paragraph)));
      for (const child of item.children) if (child.matches("ul,ol")) lines.push(...list(child, `${indent}  `));
    });
    return lines;
  };
  return block(root).join("\n");
}
