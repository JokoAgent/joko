import { Schema, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { EditorState } from "@tiptap/pm/state";
import { describe, expect, it } from "vitest";
import { createComposerMentionTransactionMapper } from "./composer-mention-transaction.js";
import { composerDocumentPlainText } from "./composer-quote-document.js";
import type { ComposerInlineMentionRange } from "./model.js";

const schema = new Schema({ nodes: {
  doc: { content: "block+" },
  paragraph: { group: "block", content: "inline*" },
  text: { group: "inline" },
  hardBreak: { group: "inline", inline: true },
  composerQuote: { group: "inline", inline: true, atom: true, attrs: { id: {}, kind: {}, text: {}, sessionId: {}, messageId: {}, role: {} } },
  composerPastedText: { group: "inline", inline: true, atom: true, attrs: { text: {}, display: {} } },
  composerRouteReference: { group: "inline", inline: true, atom: true, attrs: { kind: {}, display: {}, serialized: {}, reference: {} } },
  bulletList: { group: "block", content: "listItem+", attrs: { marker: { default: "-" }, separator: { default: " " } } },
  orderedList: { group: "block", content: "listItem+", attrs: { start: { default: 1 }, marker: { default: "." }, separator: { default: " " } } },
  listItem: { content: "paragraph block*" }
} });

const paragraph = (text: string): ProseMirrorNode => schema.node("paragraph", null, text === "" ? [] : schema.text(text));
const stateFor = (...blocks: ProseMirrorNode[]): EditorState => EditorState.create({ schema, doc: schema.node("doc", null, blocks) });
const repeated: readonly ComposerInlineMentionRange[] = [
  { mentionId: "a", from: 0, to: 2 },
  { mentionId: "b", from: 3, to: 5 },
  { mentionId: "a", from: 6, to: 8 }
];

describe("composer mention transaction mapping", () => {
  it.each([
    { from: 1, to: 4, ids: ["b", "a"] },
    { from: 4, to: 7, ids: ["a", "a"] },
    { from: 6, to: 9, ids: ["a", "b"] }
  ])("removes the selected occurrence from A/B/A at $from without rebinding its neighbors", ({ from, to, ids }) => {
    const transaction = stateFor(paragraph("@X @X @X")).tr.delete(from, to);
    expect(createComposerMentionTransactionMapper([transaction])(repeated)).toEqual(ids.map((mentionId, index) => ({ mentionId, from: index * 3, to: index * 3 + 2 })));
  });

  it("maps several steps and appended transactions from their own before documents", () => {
    const state = stateFor(paragraph("@X @X @X"));
    const first = state.tr.delete(1, 4).insertText("See ", 1).insertText("!", 7);
    const appended = state.apply(first).tr.insertText("Now ", 1);
    expect(composerDocumentPlainText(appended.doc.toJSON())).toBe("Now See @X! @X");
    expect(createComposerMentionTransactionMapper([first, appended])(repeated)).toEqual([
      { mentionId: "b", from: 8, to: 10 }, { mentionId: "a", from: 12, to: 14 }
    ]);
  });

  it("removes a replaced token even when the replacement has identical spelling", () => {
    const transaction = stateFor(paragraph("@X @X @X")).tr.insertText("@X", 4, 6);
    expect(transaction.doc.eq(transaction.before)).toBe(true);
    expect(createComposerMentionTransactionMapper([transaction])(repeated)).toEqual([repeated[0], repeated[2]]);
  });

  it("retains boundary insertions and drops insertions inside the token", () => {
    const state = stateFor(paragraph("@X @X @X"));
    const transaction = state.tr.insertText("pre", 1).insertText("!", 6).insertText("?", 9);
    expect(createComposerMentionTransactionMapper([transaction])(repeated)).toEqual([
      { mentionId: "a", from: 3, to: 5 }, { mentionId: "a", from: 11, to: 13 }
    ]);
  });

  it("projects trimmed paragraphs, hard breaks, quote atoms, and paste atoms with the same offsets as the draft", () => {
    const quote = schema.node("composerQuote", { id: "q", kind: "message", text: "quoted", sessionId: "s", messageId: "m", role: "assistant" });
    const paste = schema.node("composerPastedText", { text: "pasted\ntext", display: "Pasted" });
    const state = stateFor(schema.node("paragraph", null, [schema.text("  @X"), quote, schema.text("@X"), schema.node("hardBreak"), paste]), paragraph("@X  "));
    const text = composerDocumentPlainText(state.doc.toJSON());
    expect(text).toBe("@X\n@X\npasted\ntext\n@X");
    const offsets = [text.indexOf("@X"), text.indexOf("@X", 2), text.lastIndexOf("@X")];
    const ranges = offsets.map((from, index) => ({ mentionId: index === 1 ? "b" : "a", from, to: from + 2 }));
    const transaction = state.tr.delete(3, 5);
    expect(createComposerMentionTransactionMapper([transaction])(ranges)).toEqual([
      { mentionId: "b", from: 0, to: 2 }, { mentionId: "a", from: 15, to: 17 }
    ]);
  });

  it("maps tokens after ordered-list renumbering and nested list continuation prefixes", () => {
    const nested = schema.node("bulletList", null, schema.node("listItem", null, paragraph("@X")));
    const first = schema.node("listItem", null, paragraph("@X"));
    const second = schema.node("listItem", null, [paragraph("@X"), nested]);
    const state = stateFor(schema.node("orderedList", { start: 9 }, [first, second]));
    const text = composerDocumentPlainText(state.doc.toJSON());
    expect(text).toBe("9. @X\n10. @X\n    - @X");
    const ranges = [3, 10, 19].map((from, index) => ({ mentionId: index === 1 ? "b" : "a", from, to: from + 2 }));
    const transaction = state.tr.delete(1, 1 + first.nodeSize);
    expect(composerDocumentPlainText(transaction.doc.toJSON())).toBe("9. @X\n   - @X");
    expect(createComposerMentionTransactionMapper([transaction])(ranges)).toEqual([
      { mentionId: "b", from: 3, to: 5 }, { mentionId: "a", from: 11, to: 13 }
    ]);
  });

  it("never creates a reference identity for literal text inside atoms", () => {
    const atom = schema.node("composerPastedText", { text: "@X", display: "Pasted" });
    const state = stateFor(schema.node("paragraph", null, [atom, schema.text(" @X")]));
    const transaction = state.tr.insertText("!", 5);
    expect(createComposerMentionTransactionMapper([transaction])([{ mentionId: "atom", from: 0, to: 2 }, { mentionId: "text", from: 3, to: 5 }])).toEqual([{ mentionId: "text", from: 3, to: 5 }]);
  });
});
