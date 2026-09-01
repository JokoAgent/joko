import { Node, mergeAttributes } from "@tiptap/core";
import { COMPOSER_ROUTE_REFERENCE_NODE_TYPE } from "./composer-paste-pipeline.js";

export { COMPOSER_ROUTE_REFERENCE_NODE_TYPE } from "./composer-paste-pipeline.js";

export interface ComposerRouteReferenceAttrs {
  readonly kind: "session" | "project" | "path";
  readonly display: string;
  readonly serialized: string;
  readonly reference: string;
  readonly href?: string;
  readonly semanticText?: string;
  readonly semanticTextTruncated?: boolean;
}

export const ComposerRouteReferenceNode = Node.create({
  name: COMPOSER_ROUTE_REFERENCE_NODE_TYPE,
  inline: true,
  group: "inline",
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return {
      kind: {
        default: "path",
        parseHTML: (element: HTMLElement) => element.getAttribute("data-kind") ?? "path",
        renderHTML: (attrs: Record<string, unknown>) => ({ "data-kind": attrs["kind"] })
      },
      display: {
        default: "",
        parseHTML: (element: HTMLElement) => element.getAttribute("data-display") ?? "",
        renderHTML: (attrs: Record<string, unknown>) => ({ "data-display": attrs["display"] })
      },
      serialized: {
        default: "",
        parseHTML: (element: HTMLElement) => element.getAttribute("data-serialized") ?? "",
        renderHTML: (attrs: Record<string, unknown>) => ({ "data-serialized": attrs["serialized"] })
      },
      reference: {
        default: "",
        parseHTML: (element: HTMLElement) => element.getAttribute("data-reference") ?? "",
        renderHTML: (attrs: Record<string, unknown>) => ({ "data-reference": attrs["reference"] })
      },
      href: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-href"),
        renderHTML: (attrs: Record<string, unknown>) => typeof attrs["href"] === "string" ? { "data-href": attrs["href"] } : {}
      },
      semanticText: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-semantic-text"),
        renderHTML: (attrs: Record<string, unknown>) => typeof attrs["semanticText"] === "string" ? { "data-semantic-text": attrs["semanticText"] } : {}
      },
      semanticTextTruncated: {
        default: false,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-semantic-text-truncated") === "true",
        renderHTML: (attrs: Record<string, unknown>) => attrs["semanticTextTruncated"] === true ? { "data-semantic-text-truncated": "true" } : {}
      }
    };
  },
  parseHTML: () => [{ tag: "span[data-composer-mention]" }],
  renderHTML({ HTMLAttributes, node }) {
    const attrs = node.attrs as ComposerRouteReferenceAttrs;
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-composer-mention": "true",
        "aria-label": attrs.display,
        class: "composer-route-reference-chip",
        draggable: "true",
        contenteditable: "false"
      }),
      ["span", { class: "composer-route-reference-chip__icon", "aria-hidden": "true" }, attrs.kind === "path" ? "@" : attrs.kind === "project" ? "◇" : "↗"],
      ["span", { class: "composer-route-reference-chip__label" }, attrs.display]
    ];
  }
});
