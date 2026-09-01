// @vitest-environment jsdom

import { Editor } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { TextSelection } from "@tiptap/pm/state";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerPastedTextNode } from "./ComposerPastedTextNode.js";
import {
  ComposerBulletList,
  ComposerListItem,
  ComposerOrderedList
} from "./composer-list-nodes.js";
import {
  ComposerCjkPunctuationDecoration,
  composerCjkContextPunctuationIndexes
} from "./composer-cjk-punctuation.js";

let editor: Editor | undefined;

afterEach(() => {
  editor?.destroy();
  editor = undefined;
  document.body.replaceChildren();
  vi.useRealTimers();
});

function decoratedText(): string {
  return Array.from(
    editor?.view.dom.querySelectorAll(".composer-cjk-punctuation") ?? [],
    (element) => element.textContent ?? ""
  ).join("");
}

describe("Composer CJK punctuation rendering", () => {
  it("selects full-width punctuation and ASCII punctuation only in CJK context", () => {
    const selected = (text: string): string => composerCjkContextPunctuationIndexes(text)
      .map((index) => text[index])
      .join("");

    expect(selected("中文, () 内容")).toBe(",()");
    expect(selected("《Latin》")).toBe("《》");
    expect(selected("Latin, () text")).toBe("");
    expect(composerCjkContextPunctuationIndexes(`${"(".repeat(16 * 1024)}中`)).toHaveLength(16 * 1024);
  });

  it("keeps list and atom rendering stable while composition defers new decorations", () => {
    vi.useFakeTimers();
    const element = document.body.appendChild(document.createElement("div"));
    editor = new Editor({
      element,
      extensions: [
        Document,
        Paragraph,
        Text,
        ComposerListItem,
        ComposerBulletList,
        ComposerOrderedList,
        ComposerPastedTextNode,
        ComposerCjkPunctuationDecoration
      ],
      content: {
        type: "doc",
        content: [{
          type: "bulletList",
          attrs: { marker: "-", separator: " " },
          content: [{
            type: "listItem",
            content: [{
              type: "paragraph",
              content: [
                { type: "text", text: "中文," },
                { type: "composerPastedText", attrs: { text: "payload", display: "Pasted text" } },
                { type: "text", text: "《旧》" }
              ]
            }]
          }]
        }]
      }
    });

    expect(decoratedText()).toBe(",《》");
    expect(editor.view.dom.querySelector("ul")).not.toBeNull();
    expect(editor.view.dom.querySelector("[data-composer-pasted-text-chip]")).not.toBeNull();
    expect(JSON.stringify(editor.getJSON())).not.toContain("composer-cjk-punctuation");

    editor.view.dom.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    expect(editor.view.composing).toBe(true);
    const insertion = TextSelection.atEnd(editor.state.doc).from;
    editor.view.dispatch(editor.state.tr.insertText(",中", insertion).setMeta("composition", 1));

    expect(decoratedText()).toBe(",《》");
    expect(editor.getJSON().content?.[0]?.type).toBe("bulletList");
    expect(JSON.stringify(editor.getJSON())).toContain("composerPastedText");

    editor.view.dom.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    expect(editor.view.composing).toBe(false);
    vi.runOnlyPendingTimers();

    expect(decoratedText()).toBe(",《》,");
    expect(JSON.stringify(editor.getJSON())).not.toContain("composer-cjk-punctuation");
    expect(editor.view.dom.querySelector("[data-composer-pasted-text-chip]")).not.toBeNull();
  });
});
