// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import HardBreak from "@tiptap/extension-hard-break";
import History from "@tiptap/extension-history";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { afterEach, describe, expect, it } from "vitest";
import { composerDocumentIsEmpty, composerDocumentPlainText, normalizeComposerDocument } from "../composer-quote-document.js";
import {
  applyComposerPastedTextEdit,
  ComposerPastedTextNode,
  replaceComposerPastedTextWithPlainText
} from "./ComposerPastedTextNode.js";

const editors: Editor[] = [];

function makeEditor(): Editor {
  const instance = new Editor({
    element: document.createElement("div"),
    extensions: [Document, Paragraph, Text, HardBreak, History, ComposerPastedTextNode],
    content: { type: "doc", content: [{ type: "paragraph" }] }
  });
  editors.push(instance);
  return instance;
}

afterEach(() => {
  for (const instance of editors.splice(0)) instance.destroy();
});

describe("composer pasted-text atom", () => {
  it("round-trips the bounded payload through editor HTML", () => {
    const source = makeEditor();
    const text = "first\nsecond \"quoted\" <tag>";
    source.commands.insertContent({ type: "composerPastedText", attrs: { text, display: "Pasted text (2 lines)" } });
    expect(source.getHTML()).toContain("data-composer-pasted-text");
    const restored = makeEditor();
    restored.commands.setContent(source.getHTML());
    expect(((restored.getJSON().content?.[0]?.content?.[0] as { attrs?: Record<string, unknown> } | undefined)?.attrs)?.["text"]).toBe(text);
  });

  it("edits and deletes only the captured atom with stale-position fencing", () => {
    const instance = makeEditor();
    instance.commands.insertContent({ type: "composerPastedText", attrs: { text: "old", display: "old label" } });
    expect(applyComposerPastedTextEdit(instance, 1, "stale", { text: "wrong", display: "wrong" })).toBe(false);
    expect(applyComposerPastedTextEdit(instance, 1, "old", { text: "new", display: "new label" })).toBe(true);
    expect(((instance.getJSON().content?.[0]?.content?.[0] as { attrs?: Record<string, unknown> } | undefined)?.attrs)?.["text"]).toBe("new");
    expect(applyComposerPastedTextEdit(instance, 1, "new", null)).toBe(true);
    expect(instance.getJSON().content?.[0]?.content).toBeUndefined();
    expect(instance.commands.undo()).toBe(true);
    expect(instance.getJSON().content?.[0]?.content?.[0]?.type).toBe("composerPastedText");
  });

  it("downgrades an oversized edit to ordinary line-preserving text", () => {
    const instance = makeEditor();
    instance.commands.insertContent({ type: "composerPastedText", attrs: { text: "old", display: "old label" } });
    expect(replaceComposerPastedTextWithPlainText(instance, 1, "old", "first\nsecond\n\nlast")).toBe(true);
    expect(instance.getJSON().content?.[0]?.content?.map((node) => node.type)).toEqual([
      "text", "hardBreak", "text", "hardBreak", "hardBreak", "text"
    ]);
  });

  it("is non-empty and serializes the full payload rather than its label", () => {
    const rich = {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "composerPastedText", attrs: { text: "full\npayload", display: "compact label" } }] }]
    };
    expect(composerDocumentIsEmpty(rich)).toBe(false);
    expect(composerDocumentPlainText(rich)).toBe("full\npayload");
    expect(normalizeComposerDocument(rich)).toEqual(rich);
  });
});
