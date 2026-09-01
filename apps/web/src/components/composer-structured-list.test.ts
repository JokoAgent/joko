// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import HardBreak from "@tiptap/extension-hard-break";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { TextSelection } from "@tiptap/pm/state";
import { afterEach, describe, expect, it } from "vitest";
import {
  composerDocumentIsEmpty,
  composerDocumentPlainText,
  normalizeComposerDocument,
  plainTextToComposerDocument
} from "../composer-quote-document.js";
import {
  ComposerBulletList,
  ComposerListItem,
  ComposerOrderedList,
  handleStructuredListBackspace,
  handleStructuredListBreak,
  promoteTrailingPlainListParagraph
} from "./composer-list-nodes.js";

const editors: Editor[] = [];

function editor(content?: Record<string, unknown>): Editor {
  const instance = new Editor({
    element: document.createElement("div"),
    extensions: [Document, Paragraph, Text, ComposerListItem, ComposerBulletList, ComposerOrderedList, HardBreak],
    content: content ?? { type: "doc", content: [{ type: "paragraph" }] }
  });
  editors.push(instance);
  return instance;
}

function selectEnd(instance: Editor): void {
  instance.view.dispatch(instance.state.tr.setSelection(TextSelection.atEnd(instance.state.doc)));
}

function typeWithInputRules(instance: Editor, text: string): void {
  for (const character of text) {
    const { from, to } = instance.state.selection;
    const handled = instance.view.someProp("handleTextInput", (handler) =>
      handler(instance.view, from, to, character, () => instance.state.tr.insertText(character, from, to))) === true;
    if (!handled) instance.view.dispatch(instance.state.tr.insertText(character, from, to));
  }
}

afterEach(() => {
  for (const instance of editors.splice(0)) instance.destroy();
});

describe("composer structured lists", () => {
  it.each([
    ["- ", "bulletList", { marker: "-", separator: " " }],
    ["• ", "bulletList", { marker: "•", separator: " " }],
    ["1. ", "orderedList", { start: 1, marker: ".", separator: " " }],
    ["3) ", "orderedList", { start: 3, marker: ")", separator: " " }],
    ["2、", "orderedList", { start: 2, marker: "、", separator: "" }]
  ])("turns %s into a %s", (typed, listType, attrs) => {
    const instance = editor();
    typeWithInputRules(instance, typed);
    expect(instance.state.doc.firstChild?.type.name).toBe(listType);
    expect(instance.state.doc.firstChild?.attrs).toMatchObject(attrs);
  });

  it("keeps fenced and indented marker text literal", () => {
    expect(plainTextToComposerDocument("```\n1. literal\n```\n  - nested").content).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "```" }] },
      { type: "paragraph", content: [{ type: "text", text: "1. literal" }] },
      { type: "paragraph", content: [{ type: "text", text: "```" }] },
      { type: "paragraph", content: [{ type: "text", text: "  - nested" }] }
    ]);
  });

  it("restores contiguous rows and serializes their original marker forms", () => {
    const document = plainTextToComposerDocument("intro\n9) nine\n10) ten\n• [x] done\n• [ ] next");
    expect(document.content?.map((node) => node.type)).toEqual(["paragraph", "orderedList", "bulletList"]);
    expect(composerDocumentPlainText(document)).toBe("intro\n9) nine\n10) ten\n• [x] done\n• [ ] next");
    expect(normalizeComposerDocument(document)).toEqual(document);
  });

  it("splits an item, continues task syntax, and exits the empty task", () => {
    const instance = editor({
      type: "doc",
      content: [{
        type: "bulletList",
        attrs: { marker: "-", separator: " " },
        content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "[x] done" }] }] }]
      }]
    });
    selectEnd(instance);
    expect(handleStructuredListBreak(instance.view)).toBe(true);
    expect(instance.state.doc.firstChild?.lastChild?.textContent).toBe("[ ] ");
    expect(handleStructuredListBreak(instance.view)).toBe(true);
    expect(instance.getJSON().content?.map((node) => node.type)).toEqual(["bulletList", "paragraph"]);
  });

  it("lifts an empty item with Backspace", () => {
    const instance = editor({
      type: "doc",
      content: [{ type: "orderedList", attrs: { start: 1, marker: "." }, content: [{ type: "listItem", content: [{ type: "paragraph" }] }] }]
    });
    selectEnd(instance);
    expect(handleStructuredListBackspace(instance.view)).toBe(true);
    expect(instance.getJSON().content).toEqual([{ type: "paragraph" }]);
  });

  it("treats an empty structured item as intentional draft content", () => {
    expect(composerDocumentIsEmpty({
      type: "doc",
      content: [{ type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph" }] }] }]
    })).toBe(false);
  });

  it("promotes a direct transaction used by paste or composition", () => {
    const instance = editor({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "123456. item" }] }] });
    selectEnd(instance);
    expect(promoteTrailingPlainListParagraph(instance.view)).toBe(true);
    expect(instance.getJSON().content?.[0]).toMatchObject({ type: "orderedList", attrs: { start: 123456, marker: "." } });
    expect(instance.view.dom.querySelector("ol")?.getAttribute("data-marker-digits")).toBe("6");
  });
});
