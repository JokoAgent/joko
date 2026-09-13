import { Node, mergeAttributes } from "@tiptap/core";
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import type { JSX } from "react";
import { COMPOSER_QUOTE_NODE_TYPE, type ComposerQuoteAttrs } from "../composer-quote-document.js";
import { boundedSelectionQuoteText, normalizeSelectionQuoteDrafts, type SelectionQuoteContent } from "../selection-quote.js";
import { SelectionQuoteChip } from "./SelectionQuoteChip.js";
import "./selection-quote.css";

function ComposerQuoteNodeView({ node, selected }: NodeViewProps): JSX.Element {
  const attrs = node.attrs as ComposerQuoteAttrs;
  const normalized = normalizeSelectionQuoteDrafts([attrs])[0];
  const quote: SelectionQuoteContent = normalized ?? {
    kind: "message",
    text: boundedSelectionQuoteText(node.attrs["text"]) ?? ""
  };
  return (
    <NodeViewWrapper
      as="span"
      data-composer-quote=""
      data-drag-handle=""
      draggable={true}
      contentEditable={false}
      className="composer-quote-node"
    >
      <SelectionQuoteChip quote={quote} selected={selected} />
    </NodeViewWrapper>
  );
}

export const ComposerQuoteNode = Node.create({
  name: COMPOSER_QUOTE_NODE_TYPE,
  inline: true,
  group: "inline",
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      id: {
        default: "",
        parseHTML: (element: HTMLElement) => element.getAttribute("data-quote-id") ?? "",
        renderHTML: (attrs: Record<string, unknown>) => dataAttribute("data-quote-id", attrs["id"])
      },
      kind: {
        default: "message",
        parseHTML: (element: HTMLElement) => element.getAttribute("data-quote-kind")
          ?? (element.hasAttribute("data-source-path") ? "file" : "message"),
        renderHTML: (attrs: Record<string, unknown>) => dataAttribute("data-quote-kind", attrs["kind"])
      },
      text: {
        default: "",
        parseHTML: (element: HTMLElement) => element.getAttribute("data-quote-text") ?? element.textContent ?? "",
        renderHTML: (attrs: Record<string, unknown>) => dataAttribute("data-quote-text", attrs["text"])
      },
      sessionId: {
        default: "",
        parseHTML: (element: HTMLElement) => element.getAttribute("data-session-id") ?? "",
        renderHTML: (attrs: Record<string, unknown>) => dataAttribute("data-session-id", attrs["sessionId"])
      },
      messageId: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-message-id"),
        renderHTML: (attrs: Record<string, unknown>) => dataAttribute("data-message-id", attrs["messageId"])
      },
      sourceEventId: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-source-event-id"),
        renderHTML: (attrs: Record<string, unknown>) => dataAttribute("data-source-event-id", attrs["sourceEventId"])
      },
      role: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-message-role"),
        renderHTML: (attrs: Record<string, unknown>) => dataAttribute("data-message-role", attrs["role"])
      },
      sourcePath: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-source-path"),
        renderHTML: (attrs: Record<string, unknown>) => dataAttribute("data-source-path", attrs["sourcePath"])
      },
      startLine: {
        default: null,
        parseHTML: (element: HTMLElement) => parsePositiveLineAttribute(element, "data-start-line"),
        renderHTML: (attrs: Record<string, unknown>) => dataAttribute("data-start-line", attrs["startLine"])
      },
      endLine: {
        default: null,
        parseHTML: (element: HTMLElement) => parsePositiveLineAttribute(element, "data-end-line"),
        renderHTML: (attrs: Record<string, unknown>) => dataAttribute("data-end-line", attrs["endLine"])
      }
    };
  },

  parseHTML() {
    return [{ tag: "span[data-composer-quote]" }, { tag: "div[data-composer-quote]" }];
  },

  renderHTML({ HTMLAttributes, node }) {
    const text = typeof node.attrs["text"] === "string" ? node.attrs["text"] : "";
    return [
      "span",
      mergeAttributes(HTMLAttributes, { "data-composer-quote": "", contenteditable: "false" }),
      text
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ComposerQuoteNodeView);
  }
});

function dataAttribute(name: string, value: unknown): Record<string, string> {
  return (typeof value === "string" && value !== "")
    || (typeof value === "number" && Number.isSafeInteger(value) && value > 0)
    ? { [name]: String(value) }
    : {};
}

function parsePositiveLineAttribute(element: HTMLElement, name: string): number | null {
  const raw = element.getAttribute(name);
  if (raw === null || raw === "") return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}
