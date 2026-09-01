import { MessageSquarePlus } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type JSX, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { ComposerMessageSelectionQuoteDraft, ComposerSelectionQuoteDraft } from "../model.js";
import {
  boundedSelectionQuoteText,
  normalizeSelectionQuoteDrafts,
  SELECTION_QUOTE_MAX_CHARS
} from "../selection-quote.js";
import { randomUuid } from "../web-crypto.js";
import "./selection-quote.css";

export const TIMELINE_SELECTION_QUOTE_MAX_CHARS = SELECTION_QUOTE_MAX_CHARS;

export type TimelineSelectionQuote = ComposerMessageSelectionQuoteDraft;

export interface SelectionQuoteFileMetadata {
  readonly startLine?: number;
  readonly endLine?: number;
}

export interface SelectionQuoteReadOptions {
  /** Canonical workspace-relative path. Its presence enables file mode. */
  readonly sourcePath?: string;
  /** File/editor hosts can return the exact source slice instead of DOM text. */
  readonly getQuoteText?: () => string | null;
  /** File/editor hosts can attach the closed 1-based source line range. */
  readonly getQuoteMetadata?: () => SelectionQuoteFileMetadata | null;
}

export interface SelectionAnchor {
  readonly quote: ComposerSelectionQuoteDraft;
  readonly x: number;
  readonly y: number;
  readonly placement: "above" | "below";
}

interface RectBounds {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

const BUTTON_GAP_PX = 8;
const BUTTON_HEIGHT_ESTIMATE_PX = 28;
const BUTTON_MIN_TOP_PX = 44;
const BUTTON_MIN_X_PX = 100;
const BUTTON_RIGHT_MARGIN_PX = 100;

export const boundedTimelineSelectionText = boundedSelectionQuoteText;

/**
 * Read the current selection from this component's own document and container.
 * Message floating discovery stays assistant-only; force=true additionally
 * admits user messages for the trusted Desktop context menu. File mode admits
 * a contained selection without pretending that it came from a chat message.
 */
export function readSelectionInStream(
  sessionId: string,
  container: HTMLElement | null,
  force = false,
  options: SelectionQuoteReadOptions = {}
): SelectionAnchor | undefined {
  if (container === null) return undefined;
  const ownerDocument = container.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  if (ownerWindow === null) return undefined;
  const selection = ownerWindow.getSelection() ?? ownerDocument.getSelection();
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return undefined;
  const range = selection.getRangeAt(0);
  if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) return undefined;

  const rawText = options.getQuoteText === undefined
    ? selection.toString()
    : safeQuoteText(options.getQuoteText);
  if (typeof rawText !== "string") return undefined;
  const text = boundedTimelineSelectionText(rawText);
  if (text === undefined) return undefined;
  const floatingAnchor = getFloatingAnchor(selection, range, ownerWindow.innerHeight);
  if (floatingAnchor === undefined) return undefined;

  let quote: ComposerSelectionQuoteDraft | undefined;
  if (options.sourcePath !== undefined) {
    const metadata = safeQuoteMetadata(options.getQuoteMetadata);
    quote = normalizeSelectionQuoteDrafts([{
      id: randomUuid(),
      kind: "file",
      text,
      sessionId,
      sourcePath: options.sourcePath,
      ...(metadata ?? {})
    }])[0];
  } else {
    const start = selectionSourceElement(range.startContainer);
    const end = selectionSourceElement(range.endContainer);
    if (start === null || end !== start) return undefined;
    const role = start.dataset.selectionQuoteRole;
    if (role !== "assistant" && (force !== true || role !== "user")) return undefined;
    const messageId = start.dataset.selectionQuoteMessageId;
    if (messageId === undefined || messageId === "") return undefined;
    quote = normalizeSelectionQuoteDrafts([{
      id: randomUuid(),
      kind: "message",
      text,
      sessionId,
      messageId,
      role,
      ...(start.dataset.selectionQuoteSourceEventId === undefined
        ? {}
        : { sourceEventId: start.dataset.selectionQuoteSourceEventId })
    }])[0];
  }
  return quote === undefined ? undefined : { quote, ...floatingAnchor };
}

export function SelectionQuoteButton({
  sessionId,
  containerRef,
  sourcePath,
  getQuoteText,
  getQuoteMetadata,
  label,
  onCommit
}: {
  readonly sessionId: string;
  readonly containerRef: RefObject<HTMLElement | null>;
  readonly sourcePath?: string;
  readonly getQuoteText?: () => string | null;
  readonly getQuoteMetadata?: () => SelectionQuoteFileMetadata | null;
  readonly label: string;
  readonly onCommit: (quote: ComposerSelectionQuoteDraft) => void;
}): JSX.Element | null {
  const [anchor, setAnchor] = useState<SelectionAnchor>();
  const visibleAnchor = anchor?.quote.sessionId === sessionId ? anchor : undefined;
  const anchorRef = useRef(visibleAnchor);
  anchorRef.current = visibleAnchor;

  // A selection belongs to the file/session that produced it. Never leave a
  // floating action live after a route or preview switch, even if the browser
  // keeps a stale native range around while CodeMirror is being replaced.
  useEffect(() => setAnchor(undefined), [sessionId, sourcePath]);

  const commit = useCallback((selectionAnchor: SelectionAnchor): void => {
    onCommit(selectionAnchor.quote);
    const document = containerRef.current?.ownerDocument;
    document?.defaultView?.getSelection()?.removeAllRanges();
    setAnchor(undefined);
  }, [containerRef, onCommit]);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const ownerDocument = container.ownerDocument;
    const ownerWindow = ownerDocument.defaultView;
    if (ownerWindow === null) return;
    const options = { sourcePath, getQuoteText, getQuoteMetadata };
    const read = (force = false): SelectionAnchor | undefined => readSelectionInStream(sessionId, container, force, options);
    const onMouseUp = (): void => {
      ownerWindow.requestAnimationFrame(() => setAnchor(read()));
    };
    const onSelectionChange = (): void => {
      const selection = ownerWindow.getSelection() ?? ownerDocument.getSelection();
      if ((selection === null || selection.isCollapsed) && anchorRef.current !== undefined) setAnchor(undefined);
    };
    const hide = (): void => { if (anchorRef.current !== undefined) setAnchor(undefined); };
    const suppliedContextAttribute = container.hasAttribute("data-selection-quote-context");
    const suppliedJokoContextAttribute = container.hasAttribute("data-joko-selection-quote-context");
    if (!suppliedContextAttribute) container.setAttribute("data-selection-quote-context", "");
    if (!suppliedJokoContextAttribute) container.setAttribute("data-joko-selection-quote-context", "");
    ownerDocument.addEventListener("mouseup", onMouseUp);
    ownerDocument.addEventListener("selectionchange", onSelectionChange);
    ownerDocument.addEventListener("scroll", hide, true);
    ownerWindow.addEventListener("resize", hide);
    const nativeSelectionContextMenu = ownerWindow.jokoDesktop?.selectionContextMenu
      ?? ownerWindow.jokoInspectorDesktop?.selectionContextMenu;
    const unsubscribeContextMenu = nativeSelectionContextMenu?.onAddToChat(() => {
      const current = read(true);
      if (current !== undefined) commit(current);
    });
    return () => {
      ownerDocument.removeEventListener("mouseup", onMouseUp);
      ownerDocument.removeEventListener("selectionchange", onSelectionChange);
      ownerDocument.removeEventListener("scroll", hide, true);
      ownerWindow.removeEventListener("resize", hide);
      unsubscribeContextMenu?.();
      if (!suppliedContextAttribute) container.removeAttribute("data-selection-quote-context");
      if (!suppliedJokoContextAttribute) container.removeAttribute("data-joko-selection-quote-context");
    };
  }, [commit, containerRef, getQuoteMetadata, getQuoteText, sessionId, sourcePath]);

  const ownerDocument = containerRef.current?.ownerDocument;
  const ownerWindow = ownerDocument?.defaultView;
  if (visibleAnchor === undefined || ownerDocument === undefined || ownerWindow === null || ownerWindow === undefined) return null;
  return createPortal(
    <button
      type="button"
      className="selection-quote-button"
      style={{
        left: `${clamp(visibleAnchor.x, BUTTON_MIN_X_PX, ownerWindow.innerWidth - BUTTON_RIGHT_MARGIN_PX)}px`,
        top: visibleAnchor.placement === "above"
          ? `${Math.max(visibleAnchor.y - BUTTON_GAP_PX, BUTTON_MIN_TOP_PX)}px`
          : `${Math.min(
            visibleAnchor.y + BUTTON_GAP_PX,
            Math.max(BUTTON_MIN_TOP_PX, ownerWindow.innerHeight - BUTTON_HEIGHT_ESTIMATE_PX - BUTTON_GAP_PX)
          )}px`,
        transform: visibleAnchor.placement === "above" ? "translate(-50%, -100%)" : "translate(-50%, 0)"
      }}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => commit(visibleAnchor)}
    >
      <MessageSquarePlus aria-hidden="true" />
      <span>{label}</span>
    </button>,
    ownerDocument.body
  );
}

function selectionSourceElement(node: Node): HTMLElement | null {
  const element = node.nodeType === 1 ? node as Element : node.parentElement;
  return element?.closest("[data-selection-quote-message-id]") as HTMLElement | null;
}

function getFloatingAnchor(
  selection: Selection,
  range: Range,
  viewportHeight: number
): Pick<SelectionAnchor, "x" | "y" | "placement"> | undefined {
  const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
  if (rects.length === 0) return undefined;
  const bounds = rectBounds(rects);
  if (bounds === undefined) return undefined;
  const direction = selectionDirection(selection);
  const edgeRect = direction === "forward" ? rects.at(-1) : rects[0];
  if (edgeRect === undefined) return undefined;
  const canPlaceAbove = edgeRect.top - BUTTON_GAP_PX - BUTTON_HEIGHT_ESTIMATE_PX >= BUTTON_MIN_TOP_PX;
  const canPlaceBelow = edgeRect.bottom + BUTTON_GAP_PX + BUTTON_HEIGHT_ESTIMATE_PX <= viewportHeight;
  const placement = edgeRect.top + edgeRect.height / 2 > bounds.top + bounds.height / 2 && canPlaceBelow
    ? "below" as const
    : canPlaceAbove ? "above" as const : "below" as const;
  return {
    x: direction === "forward" ? edgeRect.right : edgeRect.left,
    y: placement === "above" ? edgeRect.top : edgeRect.bottom,
    placement
  };
}

function selectionDirection(selection: Selection): "forward" | "backward" {
  if (selection.anchorNode === null || selection.focusNode === null) return "forward";
  if (selection.anchorNode === selection.focusNode) {
    return selection.focusOffset >= selection.anchorOffset ? "forward" : "backward";
  }
  const position = selection.anchorNode.compareDocumentPosition(selection.focusNode);
  if ((position & 4) !== 0) return "forward"; // Node.DOCUMENT_POSITION_FOLLOWING, cross-realm safe.
  if ((position & 2) !== 0) return "backward"; // Node.DOCUMENT_POSITION_PRECEDING.
  return "forward";
}

function rectBounds(rects: readonly DOMRect[]): RectBounds | undefined {
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const rect of rects) {
    if (rect.width <= 0 || rect.height <= 0) continue;
    left = Math.min(left, rect.left);
    top = Math.min(top, rect.top);
    right = Math.max(right, rect.right);
    bottom = Math.max(bottom, rect.bottom);
  }
  if (![left, top, right, bottom].every(Number.isFinite)) return undefined;
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function safeQuoteText(getQuoteText: SelectionQuoteReadOptions["getQuoteText"]): string | null | undefined {
  try {
    return getQuoteText?.();
  } catch {
    return undefined;
  }
}

function safeQuoteMetadata(getQuoteMetadata: SelectionQuoteReadOptions["getQuoteMetadata"]): SelectionQuoteFileMetadata | null | undefined {
  try {
    return getQuoteMetadata?.();
  } catch {
    return undefined;
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
