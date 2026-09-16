import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

interface ComposerInternalDropCaretState {
  readonly position?: number;
  readonly decorations: DecorationSet;
}

type ComposerInternalDropCaretAction =
  | { readonly kind: "set"; readonly position: number }
  | { readonly kind: "clear" };

const composerInternalDropCaretKey = new PluginKey<ComposerInternalDropCaretState>("composerInternalDropCaret");

function createCaretState(document: ProseMirrorNode, position?: number): ComposerInternalDropCaretState {
  if (position === undefined) return { decorations: DecorationSet.empty };
  const boundedPosition = Math.max(0, Math.min(Math.trunc(position), document.content.size));
  return {
    position: boundedPosition,
    decorations: DecorationSet.create(document, [Decoration.widget(
      boundedPosition,
      (view) => {
        const caret = view.dom.ownerDocument.createElement("span");
        caret.className = "composer-internal-drop-caret";
        caret.dataset["composerInternalDropCaret"] = "true";
        caret.setAttribute("aria-hidden", "true");
        caret.setAttribute("contenteditable", "false");
        return caret;
      },
      { key: "composer-internal-drop-caret", side: -1 }
    )])
  };
}

export const ComposerInternalDropCaret = Extension.create({
  name: "composerInternalDropCaret",

  addProseMirrorPlugins() {
    return [new Plugin<ComposerInternalDropCaretState>({
      key: composerInternalDropCaretKey,
      state: {
        init: (_config, state: EditorState) => createCaretState(state.doc),
        apply: (transaction: Transaction, previous: ComposerInternalDropCaretState) => {
          const action = transaction.getMeta(composerInternalDropCaretKey) as ComposerInternalDropCaretAction | undefined;
          if (action?.kind === "clear") return createCaretState(transaction.doc);
          if (action?.kind === "set") return createCaretState(transaction.doc, action.position);
          if (previous.position === undefined || !transaction.docChanged) return previous;
          return createCaretState(transaction.doc, transaction.mapping.map(previous.position, -1));
        }
      },
      props: {
        decorations(state) {
          return composerInternalDropCaretKey.getState(state)?.decorations ?? DecorationSet.empty;
        }
      }
    })];
  }
});

export function composerInternalDropCaretPosition(state: EditorState): number | undefined {
  return composerInternalDropCaretKey.getState(state)?.position;
}

export function setComposerInternalDropCaret(view: EditorView, position: number): void {
  view.dispatch(view.state.tr
    .setMeta(composerInternalDropCaretKey, { kind: "set", position } satisfies ComposerInternalDropCaretAction)
    .setMeta("addToHistory", false));
}

export function clearComposerInternalDropCaret(view: EditorView): void {
  if (composerInternalDropCaretPosition(view.state) === undefined) return;
  view.dispatch(view.state.tr
    .setMeta(composerInternalDropCaretKey, { kind: "clear" } satisfies ComposerInternalDropCaretAction)
    .setMeta("addToHistory", false));
}

export function clearComposerInternalDropCaretOn(transaction: Transaction): Transaction {
  return transaction.setMeta(composerInternalDropCaretKey, { kind: "clear" } satisfies ComposerInternalDropCaretAction);
}
