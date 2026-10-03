import { diffChars } from "diff";
import { assertBrowserActionCurrent, type BrowserActionContext } from "../browser-action.js";
import {
  MAXIMUM_SHARE_IMAGE_PIXELS,
  MAXIMUM_SHARE_MESSAGE_CHARACTERS,
  ShareMessageImageEmptyError,
  ShareMessageImageEncodingError,
  ShareMessageImageTooLargeError,
  assertPngBlob,
  redactShareMessageText
} from "./share-message-image.js";
import { TIMELINE_FROZEN_IMAGE_ATTRIBUTE, rewriteTimelineSnapshotIds, timelineDomToPng, timelineExportScale } from "./timeline-image-export.js";

export const RENDERED_SHARE_MESSAGE_ATTRIBUTE = "data-rendered-share-message-id";
export const RENDERED_SHARE_EXCLUDE_ATTRIBUTE = "data-rendered-share-exclude";
export const MAXIMUM_RENDERED_SHARE_MESSAGES = 80;
export const MAXIMUM_RENDERED_SHARE_ATTACHMENTS = 64;
export const MAXIMUM_RENDERED_SHARE_IMAGE_EDGE_PIXELS = 16_384;

const MAXIMUM_RENDERED_SHARE_IMAGES = 64;
const MAXIMUM_RENDERED_SHARE_SOURCE_IMAGE_PIXELS = MAXIMUM_SHARE_IMAGE_PIXELS * 4;
const MAXIMUM_RENDERED_SHARE_DOM_NODES = 20_000;
const MAXIMUM_RENDERED_SHARE_DOM_CHARACTERS = MAXIMUM_SHARE_MESSAGE_CHARACTERS * 4;
const MAXIMUM_SHARE_CONTENT_CSS_WIDTH = 914;
let renderedShareSnapshotSequence = 0;

const CLONE_STRIPPED_ATTRIBUTES = [
  "data-user-msg-id",
  "data-message-client-id",
  "data-message-client-ids",
  "data-timeline-item-id",
  "data-timeline-item-ids",
  "data-gallery-image-id",
  "data-selection-quote-message-id",
  "data-selection-quote-source-event-id",
  "data-selection-quote-role",
  RENDERED_SHARE_MESSAGE_ATTRIBUTE
] as const;

const REDACTION_SCOPE_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DIV", "DL", "FIELDSET", "FIGURE", "FOOTER", "FORM",
  "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION",
  "TABLE", "TD", "TH", "TR", "UL"
]);

export interface RenderedShareImageMessage {
  readonly id: string;
  readonly text: string;
  readonly attachmentNames: readonly string[];
}

export interface RenderedShareImageContent {
  readonly sessionName: string;
  readonly messages: readonly RenderedShareImageMessage[];
}

export class ShareRenderedMessageNotMountedError extends Error {
  constructor() {
    super("One or more selected messages are no longer rendered.");
    this.name = "ShareRenderedMessageNotMountedError";
  }
}

export class ShareRenderedMessageImageUnavailableError extends Error {
  constructor() {
    super("A rendered image is not ready for export.");
    this.name = "ShareRenderedMessageImageUnavailableError";
  }
}

export function queryRenderedShareMessageIds(root: HTMLElement): readonly string[] {
  return renderedShareMessageNodes(root).map((node) => node.getAttribute(RENDERED_SHARE_MESSAGE_ATTRIBUTE) ?? "");
}

export function stripRenderedShareInteractiveElements(root: HTMLElement): void {
  root.querySelectorAll(`[${RENDERED_SHARE_EXCLUDE_ATTRIBUTE}]`).forEach((element) => element.remove());
  root.querySelectorAll([
    ".message-share-choice",
    ".message-actions",
    ".message-user__collapse-toggle",
    ".message-user__collapse-mirror",
    ".timeline-code-block__copy",
    ".timeline-copy-block__button",
    ".timeline-mermaid__toolbar"
  ].join(",")).forEach((element) => element.remove());
}

export function stripRenderedShareCloneAnchors(root: HTMLElement): void {
  for (const attribute of CLONE_STRIPPED_ATTRIBUTES) {
    root.removeAttribute(attribute);
    root.querySelectorAll(`[${attribute}]`).forEach((element) => element.removeAttribute(attribute));
  }
}

export function expandRenderedShareCollapsedContent(root: HTMLElement): void {
  root.classList.remove("is-share-selecting");
  root.querySelectorAll<HTMLElement>(".is-share-selecting").forEach((element) => element.classList.remove("is-share-selecting"));
  root.querySelectorAll<HTMLElement>(".message-user__content.is-collapsed").forEach((element) => element.classList.remove("is-collapsed"));
  for (const wrapper of root.querySelectorAll<HTMLElement>(".message-assistant__selection-stack")) wrapper.replaceWith(...wrapper.childNodes);
}

export function expandRenderedShareScrollableBlocks(root: HTMLElement): void {
  const ownerWindow = root.ownerDocument.defaultView;
  if (ownerWindow === null) throw new ShareRenderedMessageNotMountedError();
  for (const element of root.querySelectorAll<HTMLElement>("*")) {
    const overflowsX = element.scrollWidth > element.clientWidth;
    const overflowsY = element.scrollHeight > element.clientHeight;
    if (!overflowsX && !overflowsY) continue;
    const style = ownerWindow.getComputedStyle(element);
    if (overflowsX && (style.overflowX === "auto" || style.overflowX === "scroll")) {
      element.style.overflowX = "visible";
      element.style.width = "max-content";
      element.style.maxWidth = "none";
    }
    if (overflowsY && (style.overflowY === "auto" || style.overflowY === "scroll")) {
      element.style.overflowY = "visible";
      element.style.maxHeight = "none";
    }
  }
}

interface TextNodeRange {
  readonly node: Text;
  readonly start: number;
  readonly end: number;
}

function redactionScopeFor(node: Text, root: HTMLElement): Element {
  let current = node.parentElement;
  while (current !== null && current !== root) {
    if (REDACTION_SCOPE_TAGS.has(current.tagName)) return current;
    current = current.parentElement;
  }
  return root;
}

function textNodeRanges(nodes: readonly Text[]): readonly TextNodeRange[] {
  let offset = 0;
  return nodes.map((node) => {
    const text = node.nodeValue ?? "";
    const range = { node, start: offset, end: offset + text.length };
    offset = range.end;
    return range;
  });
}

function textNodeIndexAtOffset(ranges: readonly TextNodeRange[], offset: number): number {
  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index]!;
    if (offset < range.end || offset === range.end && index === ranges.length - 1) return index;
  }
  return Math.max(0, ranges.length - 1);
}

function projectRedactedText(nodes: readonly Text[], redactedText: string): void {
  const ranges = textNodeRanges(nodes);
  const projected = nodes.map(() => "");
  const originalText = ranges.map((range) => range.node.nodeValue ?? "").join("");
  let originalOffset = 0;
  for (const change of diffChars(originalText, redactedText)) {
    if (change.added) {
      projected[textNodeIndexAtOffset(ranges, originalOffset)] += change.value;
      continue;
    }
    if (change.removed) {
      originalOffset += change.value.length;
      continue;
    }
    let valueOffset = 0;
    while (valueOffset < change.value.length) {
      const index = textNodeIndexAtOffset(ranges, originalOffset + valueOffset);
      const range = ranges[index]!;
      const available = range.end - (originalOffset + valueOffset);
      const chunkLength = Math.min(available, change.value.length - valueOffset);
      projected[index] += change.value.slice(valueOffset, valueOffset + chunkLength);
      valueOffset += chunkLength;
    }
    originalOffset += change.value.length;
  }
  nodes.forEach((node, index) => { node.nodeValue = projected[index]!; });
}

export function redactRenderedShareTextNodes(root: HTMLElement): void {
  const ownerWindow = root.ownerDocument.defaultView;
  if (ownerWindow === null) throw new ShareRenderedMessageNotMountedError();
  const walker = root.ownerDocument.createTreeWalker(root, ownerWindow.NodeFilter.SHOW_TEXT);
  const runs = new Map<Element, Text[]>();
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node as Text;
    if ((text.nodeValue ?? "").length === 0) continue;
    const scope = redactionScopeFor(text, root);
    const run = runs.get(scope);
    if (run === undefined) runs.set(scope, [text]);
    else run.push(text);
  }
  for (const run of runs.values()) {
    const original = run.map((node) => node.nodeValue ?? "").join("");
    const redacted = redactShareMessageText(original);
    if (redacted !== original) projectRedactedText(run, redacted);
  }
}

export function assertRenderedShareReadableSize(root: HTMLElement): void {
  const width = root.scrollWidth;
  const height = root.scrollHeight;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || timelineExportScale(
    width,
    height,
    2,
    MAXIMUM_RENDERED_SHARE_IMAGE_EDGE_PIXELS,
    MAXIMUM_SHARE_IMAGE_PIXELS
  ) < 1) throw new ShareMessageImageTooLargeError();
}

export async function buildRenderedShareMessageImagePng({
  timelineRoot,
  sessionId,
  orderedTimelineMessageIds,
  content,
  action
}: {
  readonly timelineRoot: HTMLElement;
  readonly sessionId: string;
  readonly orderedTimelineMessageIds: readonly string[];
  readonly content: RenderedShareImageContent;
  readonly action: BrowserActionContext;
}): Promise<Blob> {
  assertBrowserActionCurrent(action);
  assertRenderedShareContentBudget(content);
  const gaps = renderedShareSelectionGaps(orderedTimelineMessageIds, content.messages.map((message) => message.id));
  assertTimelineSourceCurrent(timelineRoot, sessionId, action);
  const sourceNodes = exactRenderedShareMessageNodes(timelineRoot, content.messages.map((message) => message.id));
  const ownerDocument = action.ownerDocument;
  const frozenImages = { count: 0, pixels: 0 };
  const clones = sourceNodes.map((source) => {
    const clone = source.cloneNode(true) as HTMLElement;
    freezeRenderedImages(source, clone, action, frozenImages);
    stripRenderedShareInteractiveElements(clone);
    expandRenderedShareCollapsedContent(clone);
    stripRenderedShareCloneAnchors(clone);
    redactRenderedShareTextNodes(clone);
    return clone;
  });
  assertRenderedShareDomBudget(clones);

  const host = ownerDocument.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.inert = true;
  host.style.cssText = "position:fixed;left:-100000px;top:0;z-index:-1;pointer-events:none;contain:layout paint;";
  const stage = ownerDocument.createElement("section");
  stage.setAttribute("data-rendered-share-export", "");
  const rootStyle = ownerDocument.defaultView!.getComputedStyle(timelineRoot);
  const background = rootStyle.getPropertyValue("--bg").trim() || rootStyle.backgroundColor || "#ffffff";
  const contentWidth = renderedShareContentWidth(timelineRoot, sourceNodes);
  stage.style.cssText = [
    "position:static",
    "box-sizing:content-box",
    `width:${contentWidth}px`,
    `padding:40px`,
    `background:${background}`,
    "display:flex",
    "flex-direction:column",
    "gap:24px",
    "overflow:visible",
    "isolation:isolate"
  ].join(";");
  stage.append(buildRenderedShareHeader(ownerDocument, content.sessionName));
  clones.forEach((clone, index) => {
    if (gaps[index] === true) stage.append(buildRenderedShareGap(ownerDocument));
    stage.append(clone);
  });
  stage.append(buildRenderedShareFooter(ownerDocument));
  // The first clone is connected while fonts and SVG serialization await. Give
  // it its own ids before attachment so Mermaid/KaTeX/useId references cannot
  // resolve against the live Timeline. The rasterizer remaps its second clone.
  rewriteTimelineSnapshotIds(stage, nextRenderedShareSnapshotPrefix(ownerDocument));
  host.append(stage);
  ownerDocument.body.append(host);
  try {
    assertBrowserActionCurrent(action);
    assertTimelineSourceCurrent(timelineRoot, sessionId, action);
    expandRenderedShareScrollableBlocks(stage);
    assertRenderedShareReadableSize(stage);
    const blob = await timelineDomToPng(stage, action, {
      desiredScale: 2,
      maximumEdgePixels: MAXIMUM_RENDERED_SHARE_IMAGE_EDGE_PIXELS,
      maximumPixels: MAXIMUM_SHARE_IMAGE_PIXELS
    });
    assertTimelineSourceCurrent(timelineRoot, sessionId, action);
    await assertPngBlob(blob, action);
    assertTimelineSourceCurrent(timelineRoot, sessionId, action);
    return blob;
  } finally {
    host.remove();
  }
}

function renderedShareMessageNodes(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(`[${RENDERED_SHARE_MESSAGE_ATTRIBUTE}]`)]
    .filter((node) => node.closest<HTMLElement>("[data-timeline-session-id]") === root);
}

function exactRenderedShareMessageNodes(root: HTMLElement, orderedIds: readonly string[]): readonly HTMLElement[] {
  const all = renderedShareMessageNodes(root);
  const byId = new Map<string, HTMLElement>();
  for (const node of all) {
    const id = node.getAttribute(RENDERED_SHARE_MESSAGE_ATTRIBUTE);
    if (id === null || id === "" || byId.has(id)) throw new ShareRenderedMessageNotMountedError();
    byId.set(id, node);
  }
  const indexes = new Map(all.map((node, index) => [node.getAttribute(RENDERED_SHARE_MESSAGE_ATTRIBUTE)!, index]));
  const sourceNodes = orderedIds.map((id) => byId.get(id));
  if (sourceNodes.some((node) => node === undefined)) throw new ShareRenderedMessageNotMountedError();
  let previous = -1;
  for (const id of orderedIds) {
    const index = indexes.get(id);
    if (index === undefined || index <= previous) throw new ShareRenderedMessageNotMountedError();
    previous = index;
  }
  return sourceNodes as readonly HTMLElement[];
}

function assertRenderedShareContentBudget(content: RenderedShareImageContent): void {
  if (content.messages.length === 0) throw new ShareMessageImageEmptyError();
  if (content.messages.length > MAXIMUM_RENDERED_SHARE_MESSAGES) throw new ShareMessageImageTooLargeError();
  const ids = new Set<string>();
  let characters = 0;
  let attachments = 0;
  for (const message of content.messages) {
    if (message.id === "" || ids.has(message.id)) throw new ShareRenderedMessageNotMountedError();
    ids.add(message.id);
    characters += [...message.text].length;
    attachments += message.attachmentNames.length;
    for (const name of message.attachmentNames) characters += [...name].length;
  }
  if (characters > MAXIMUM_SHARE_MESSAGE_CHARACTERS || attachments > MAXIMUM_RENDERED_SHARE_ATTACHMENTS) {
    throw new ShareMessageImageTooLargeError();
  }
}

function renderedShareSelectionGaps(
  orderedTimelineMessageIds: readonly string[],
  selectedIds: readonly string[]
): readonly boolean[] {
  const order = new Map<string, number>();
  orderedTimelineMessageIds.forEach((id, index) => {
    if (id === "" || order.has(id)) throw new ShareRenderedMessageNotMountedError();
    order.set(id, index);
  });
  let previous = -1;
  return selectedIds.map((id, index) => {
    const current = order.get(id);
    if (current === undefined || current <= previous) throw new ShareRenderedMessageNotMountedError();
    const gap = index > 0 && current - previous > 1;
    previous = current;
    return gap;
  });
}

function assertRenderedShareDomBudget(clones: readonly HTMLElement[]): void {
  let nodes = 0;
  let characters = 0;
  for (const clone of clones) {
    nodes += 1 + clone.querySelectorAll("*").length;
    characters += clone.textContent?.length ?? 0;
  }
  if (nodes > MAXIMUM_RENDERED_SHARE_DOM_NODES || characters > MAXIMUM_RENDERED_SHARE_DOM_CHARACTERS) {
    throw new ShareMessageImageTooLargeError();
  }
}

function assertTimelineSourceCurrent(root: HTMLElement, sessionId: string, action: BrowserActionContext): void {
  assertBrowserActionCurrent(action);
  if (
    !root.isConnected || root.ownerDocument !== action.ownerDocument
    || root.dataset.timelineSessionId !== sessionId
    || root.closest<HTMLElement>("[data-timeline-session-id]") !== root
  ) throw new ShareRenderedMessageNotMountedError();
}

function freezeRenderedImages(
  source: HTMLElement,
  clone: HTMLElement,
  action: BrowserActionContext,
  budget: { count: number; pixels: number }
): void {
  const originals = [...source.querySelectorAll<HTMLImageElement>("img")];
  const copies = [...clone.querySelectorAll<HTMLImageElement>("img")];
  if (originals.length !== copies.length) throw new ShareMessageImageEncodingError();
  originals.forEach((image, index) => {
    assertBrowserActionCurrent(action);
    if (!image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) throw new ShareRenderedMessageImageUnavailableError();
    budget.count += 1;
    const scale = timelineExportScale(image.naturalWidth, image.naturalHeight, 1);
    const width = Math.max(1, Math.floor(image.naturalWidth * scale));
    const height = Math.max(1, Math.floor(image.naturalHeight * scale));
    budget.pixels += width * height;
    if (budget.count > MAXIMUM_RENDERED_SHARE_IMAGES || budget.pixels > MAXIMUM_RENDERED_SHARE_SOURCE_IMAGE_PIXELS) {
      throw new ShareMessageImageTooLargeError();
    }
    const canvas = action.ownerDocument.createElement("canvas");
    try {
      canvas.width = width;
      canvas.height = height;
      const drawing = canvas.getContext("2d");
      if (drawing === null) throw new ShareMessageImageEncodingError();
      drawing.drawImage(image, 0, 0, width, height);
      const copy = copies[index]!;
      copy.setAttribute("src", canvas.toDataURL("image/png"));
      copy.removeAttribute("srcset");
      copy.closest("picture")?.querySelectorAll("source").forEach((source) => source.remove());
      copy.setAttribute("loading", "eager");
      copy.setAttribute(TIMELINE_FROZEN_IMAGE_ATTRIBUTE, "");
    } catch (error) {
      if (error instanceof ShareMessageImageTooLargeError || error instanceof ShareMessageImageEncodingError) throw error;
      throw new ShareMessageImageEncodingError();
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  });
}

function renderedShareContentWidth(root: HTMLElement, nodes: readonly HTMLElement[]): number {
  const widths = nodes.map((node) => node.getBoundingClientRect().width).filter((width) => Number.isFinite(width) && width > 0);
  const virtualWidth = root.querySelector<HTMLElement>(".timeline__virtual")?.getBoundingClientRect().width ?? 0;
  const measured = Math.max(virtualWidth, root.clientWidth, ...widths, 320);
  return Math.round(Math.min(MAXIMUM_SHARE_CONTENT_CSS_WIDTH, measured));
}

function buildRenderedShareHeader(ownerDocument: Document, sessionName: string): HTMLElement {
  const header = ownerDocument.createElement("header");
  header.style.cssText = "display:flex;flex-direction:column;gap:8px;padding-bottom:16px;border-bottom:1px solid var(--line);";
  const brand = ownerDocument.createElement("span");
  brand.textContent = "Joko";
  brand.style.cssText = "color:var(--accent);font-size:13px;font-weight:700;letter-spacing:.04em;";
  const title = ownerDocument.createElement("h1");
  title.textContent = boundedTitle(redactShareMessageText(sessionName)) || "Untitled task";
  title.style.cssText = "margin:0;color:var(--text);font-size:25px;font-weight:650;line-height:1.25;overflow-wrap:anywhere;";
  header.append(brand, title);
  return header;
}

function buildRenderedShareGap(ownerDocument: Document): HTMLElement {
  const gap = ownerDocument.createElement("div");
  gap.setAttribute("data-rendered-share-gap", "");
  gap.textContent = "•••";
  gap.style.cssText = "color:var(--text-faint);font-size:18px;font-weight:600;line-height:1;text-align:center;letter-spacing:4px;";
  return gap;
}

function buildRenderedShareFooter(ownerDocument: Document): HTMLElement {
  const footer = ownerDocument.createElement("footer");
  footer.textContent = "Joko";
  footer.style.cssText = "margin-top:16px;padding-top:18px;border-top:1px solid var(--line);color:var(--accent);font-size:18px;font-weight:700;";
  return footer;
}

function nextRenderedShareSnapshotPrefix(ownerDocument: Document): string {
  let prefix: string;
  do prefix = `rendered-share-${++renderedShareSnapshotSequence}`;
  while (ownerDocument.querySelector(`[id^="${prefix}-id-"]`) !== null);
  return prefix;
}

function boundedTitle(value: string): string {
  const singleLine = value.replace(/\r\n?/gu, "\n").replace(/\s+/gu, " ").trim();
  return [...singleLine].slice(0, 120).join("");
}
