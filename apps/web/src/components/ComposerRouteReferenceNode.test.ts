// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { afterEach, describe, expect, it } from "vitest";
import { composerDocumentIsEmpty, composerDocumentPlainText, normalizeComposerDocument } from "../composer-quote-document.js";
import { ComposerRouteReferenceNode } from "./ComposerRouteReferenceNode.js";

const editors: Editor[] = [];

function makeEditor(): Editor {
  const instance = new Editor({
    element: document.createElement("div"),
    extensions: [Document, Paragraph, Text, ComposerRouteReferenceNode],
    content: { type: "doc", content: [{ type: "paragraph" }] }
  });
  editors.push(instance);
  return instance;
}

afterEach(() => {
  for (const instance of editors.splice(0)) instance.destroy();
});

describe("composer route reference atom", () => {
  it.each([
    { kind: "session", display: "Task", serialized: "[Task](#/tasks/s-1)", reference: "s-1", href: "#/tasks/s-1" },
    { kind: "project", display: "Project", serialized: "#/projects/p-1", reference: "p-1", href: "#/projects/p-1" },
    { kind: "path", display: "src/main.ts", serialized: "@src/main.ts", reference: "src/main.ts" }
  ])("round-trips and serializes a $kind atom", (attrs) => {
    const source = makeEditor();
    source.commands.insertContent({ type: "composerRouteReference", attrs });
    const restored = makeEditor();
    restored.commands.setContent(source.getHTML());
    const document = restored.getJSON();
    expect(composerDocumentIsEmpty(document)).toBe(false);
    expect(composerDocumentPlainText(document)).toBe(attrs.serialized);
    const normalized = normalizeComposerDocument(document);
    expect(normalizeComposerDocument(normalized)).toEqual(normalized);
  });

  it("fails closed for malformed durable attrs", () => {
    expect(normalizeComposerDocument({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "composerRouteReference", attrs: { kind: "unknown", display: "bad", serialized: "bad", reference: "bad" } }] }]
    })).toEqual({ type: "doc", content: [{ type: "paragraph" }] });
  });
});
