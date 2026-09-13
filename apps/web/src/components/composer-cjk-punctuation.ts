import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

const CJK_PUNCTUATION_RE = /[\u3000-\u303f\uff00-\uffef]/u;
const HAN_CHARACTER_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
const ASCII_PUNCTUATION = new Set([
  "!", "\"", "'", "(", ")", ",", ".", ":", ";", "?", "[", "]", "{", "}"
]);

function isCjkContextCharacter(character: string | undefined): boolean {
  return character !== undefined && (HAN_CHARACTER_RE.test(character) || CJK_PUNCTUATION_RE.test(character));
}

function isContextSeparator(character: string | undefined): boolean {
  return character !== undefined && (/\s/u.test(character) || ASCII_PUNCTUATION.has(character));
}

export function composerCjkContextPunctuationIndexes(text: string): readonly number[] {
  const selected = new Uint8Array(text.length);
  let adjacentToCjk = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (CJK_PUNCTUATION_RE.test(character!)) {
      selected[index] = 1;
      adjacentToCjk = true;
    } else if (isContextSeparator(character)) {
      if (adjacentToCjk && ASCII_PUNCTUATION.has(character!)) selected[index] = 1;
    } else {
      adjacentToCjk = isCjkContextCharacter(character);
    }
  }

  adjacentToCjk = false;
  for (let index = text.length - 1; index >= 0; index -= 1) {
    const character = text[index];
    if (CJK_PUNCTUATION_RE.test(character!)) {
      selected[index] = 1;
      adjacentToCjk = true;
    } else if (isContextSeparator(character)) {
      if (adjacentToCjk && ASCII_PUNCTUATION.has(character!)) selected[index] = 1;
    } else {
      adjacentToCjk = isCjkContextCharacter(character);
    }
  }

  const indexes: number[] = [];
  for (let index = 0; index < selected.length; index += 1) {
    if (selected[index] === 1) indexes.push(index);
  }
  return indexes;
}

interface PunctuationDecorationState {
  readonly decorations: DecorationSet;
  readonly suspendedForComposition: boolean;
}

type CompositionAction = "suspend" | "resume";

const punctuationDecorationKey = new PluginKey<PunctuationDecorationState>("composerCjkPunctuationDecoration");

function buildPunctuationDecorations(document: ProseMirrorNode): DecorationSet {
  const decorations: Decoration[] = [];
  document.descendants((node, position) => {
    if (node.isText && node.text !== undefined) {
      for (const index of composerCjkContextPunctuationIndexes(node.text)) {
        decorations.push(Decoration.inline(
          position + index,
          position + index + 1,
          { class: "composer-cjk-punctuation" },
          { inclusiveStart: false, inclusiveEnd: false }
        ));
      }
      return false;
    }
    return !node.isAtom;
  });
  return DecorationSet.create(document, decorations);
}

export const ComposerCjkPunctuationDecoration = Extension.create({
  name: "composerCjkPunctuationDecoration",

  addProseMirrorPlugins() {
    let resumeTimer: ReturnType<typeof setTimeout> | undefined;
    return [new Plugin<PunctuationDecorationState>({
      key: punctuationDecorationKey,
      state: {
        init: (_config, state: EditorState) => ({
          decorations: buildPunctuationDecorations(state.doc),
          suspendedForComposition: false
        }),
        apply: (transaction: Transaction, previous: PunctuationDecorationState) => {
          const action = transaction.getMeta(punctuationDecorationKey) as CompositionAction | undefined;
          if (action === "suspend") {
            return previous.suspendedForComposition
              ? previous
              : { decorations: previous.decorations, suspendedForComposition: true };
          }
          if (previous.suspendedForComposition && action !== "resume") {
            return {
              decorations: transaction.docChanged
                ? previous.decorations.map(transaction.mapping, transaction.doc)
                : previous.decorations,
              suspendedForComposition: true
            };
          }
          if (action !== "resume" && !transaction.docChanged) return previous;
          return {
            decorations: buildPunctuationDecorations(transaction.doc),
            suspendedForComposition: false
          };
        }
      },
      props: {
        decorations(state) {
          return punctuationDecorationKey.getState(state)?.decorations ?? DecorationSet.empty;
        },
        handleDOMEvents: {
          compositionstart(view) {
            if (resumeTimer !== undefined) {
              clearTimeout(resumeTimer);
              resumeTimer = undefined;
            }
            if (!punctuationDecorationKey.getState(view.state)?.suspendedForComposition) {
              view.dispatch(view.state.tr
                .setMeta(punctuationDecorationKey, "suspend" satisfies CompositionAction)
                .setMeta("addToHistory", false));
            }
            return false;
          },
          compositionend(view) {
            if (resumeTimer !== undefined) clearTimeout(resumeTimer);
            resumeTimer = setTimeout(() => {
              resumeTimer = undefined;
              if (view.isDestroyed || view.composing) return;
              if (!punctuationDecorationKey.getState(view.state)?.suspendedForComposition) return;
              view.dispatch(view.state.tr
                .setMeta(punctuationDecorationKey, "resume" satisfies CompositionAction)
                .setMeta("addToHistory", false));
            }, 0);
            return false;
          }
        }
      },
      view: () => ({
        destroy() {
          if (resumeTimer !== undefined) clearTimeout(resumeTimer);
          resumeTimer = undefined;
        }
      })
    })];
  }
});
