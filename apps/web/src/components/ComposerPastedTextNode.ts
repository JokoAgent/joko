import { Node, mergeAttributes, type Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import { Fragment, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { COMPOSER_PASTED_TEXT_NODE_TYPE } from "./composer-paste-pipeline.js";

export { COMPOSER_PASTED_TEXT_NODE_TYPE } from "./composer-paste-pipeline.js";

export interface ComposerPastedTextAttrs {
  readonly text: string;
  readonly display: string;
}

export function applyComposerPastedTextEdit(
  editor: Editor,
  nodePosition: number,
  expectedText: string,
  next: ComposerPastedTextAttrs | null
): boolean {
  const current = validPastedTextNode(editor, nodePosition, expectedText);
  if (current === undefined) return false;
  const transaction = next === null
    ? editor.state.tr.delete(nodePosition, nodePosition + current.nodeSize)
    : editor.state.tr.setNodeMarkup(nodePosition, undefined, { ...current.attrs, ...next });
  editor.view.dispatch(closeHistory(transaction));
  return true;
}

export function replaceComposerPastedTextWithPlainText(
  editor: Editor,
  nodePosition: number,
  expectedText: string,
  nextText: string
): boolean {
  const current = validPastedTextNode(editor, nodePosition, expectedText);
  const hardBreak = editor.state.schema.nodes["hardBreak"];
  if (current === undefined || hardBreak === undefined) return false;
  const nodes: ProseMirrorNode[] = [];
  nextText.replace(/\r\n?/gu, "\n").split("\n").forEach((line, index) => {
    if (index > 0) nodes.push(hardBreak.create());
    if (line !== "") nodes.push(editor.state.schema.text(line));
  });
  const transaction = editor.state.tr.replaceWith(
    nodePosition,
    nodePosition + current.nodeSize,
    Fragment.from(nodes)
  );
  editor.view.dispatch(closeHistory(transaction));
  return true;
}

function validPastedTextNode(editor: Editor, nodePosition: number, expectedText: string): ProseMirrorNode | undefined {
  if (!Number.isInteger(nodePosition) || nodePosition < 0 || nodePosition >= editor.state.doc.content.size) return undefined;
  const current = editor.state.doc.nodeAt(nodePosition);
  return current?.type.name === COMPOSER_PASTED_TEXT_NODE_TYPE
    && (current.attrs as ComposerPastedTextAttrs).text === expectedText
    ? current
    : undefined;
}

export const ComposerPastedTextNode = Node.create({
  name: COMPOSER_PASTED_TEXT_NODE_TYPE,
  inline: true,
  group: "inline",
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return {
      text: {
        default: "",
        parseHTML: (element: HTMLElement) => element.getAttribute("data-composer-pasted-text") ?? "",
        renderHTML: (attrs: Record<string, unknown>) => ({ "data-composer-pasted-text": attrs["text"] })
      },
      display: {
        default: "",
        parseHTML: (element: HTMLElement) => element.getAttribute("data-display") ?? "",
        renderHTML: (attrs: Record<string, unknown>) => ({ "data-display": attrs["display"] })
      }
    };
  },
  parseHTML: () => [{ tag: "span[data-composer-pasted-text]" }],
  renderHTML({ HTMLAttributes, node }) {
    const attrs = node.attrs as ComposerPastedTextAttrs;
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-composer-pasted-text-chip": "true",
        "aria-label": attrs.display,
        class: "composer-pasted-text-chip",
        draggable: "true",
        contenteditable: "false"
      }),
      ["span", { class: "composer-pasted-text-chip__icon", "aria-hidden": "true" }, "≡"],
      ["span", { class: "composer-pasted-text-chip__label" }, attrs.display]
    ];
  }
});
