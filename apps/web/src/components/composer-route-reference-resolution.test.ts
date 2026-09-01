// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import Document from "@tiptap/extension-document";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerRouteReferenceNode, type ComposerRouteReferenceAttrs } from "./ComposerRouteReferenceNode.js";
import {
  COMPOSER_MESSAGE_REFERENCE_LABEL_LIMIT,
  COMPOSER_MESSAGE_REFERENCE_TEXT_LIMIT,
  resolveComposerRouteReferences,
  seedComposerRouteReference,
  shortComposerReferenceId
} from "./composer-route-reference-resolution.js";

const editors: Editor[] = [];

function editor(attrs: ComposerRouteReferenceAttrs): Editor {
  const instance = new Editor({
    element: document.createElement("div"),
    extensions: [Document, Paragraph, Text, ComposerRouteReferenceNode],
    content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "composerRouteReference", attrs }] }] }
  });
  editors.push(instance);
  return instance;
}

function firstAttrs(instance: Editor): ComposerRouteReferenceAttrs {
  return (instance.getJSON().content?.[0]?.content?.[0] as { readonly attrs?: ComposerRouteReferenceAttrs } | undefined)?.attrs as ComposerRouteReferenceAttrs;
}

afterEach(() => {
  for (const instance of editors.splice(0)) instance.destroy();
});

describe("composer route reference resolution", () => {
  it("uses a two-sided compact id and preserves an explicit task label", () => {
    expect(shortComposerReferenceId("ee59672a-5591-48a7-a44d-aa97e3808c64")).toBe("ee59672a…8c64");
    expect(seedComposerRouteReference({
      kind: "session",
      href: "#/tasks/task-1",
      label: "[WIP] owner@example.test",
      sessionId: "task-1"
    })).toEqual({
      attrs: {
        kind: "session",
        display: "WIP owner＠example.test",
        serialized: "[WIP owner＠example.test](#/tasks/task-1)",
        reference: "task-1",
        href: "#/tasks/task-1"
      }
    });
  });

  it("ignores a task label for a message anchor and keeps its wire link bare", () => {
    const seeded = seedComposerRouteReference({
      kind: "session",
      href: "#/tasks/task-1?message=message-123456789",
      label: "Task title",
      sessionId: "task-1",
      messageId: "message-123456789"
    });
    expect(seeded.attrs).toMatchObject({
      display: "message-…6789",
      serialized: "#/tasks/task-1?message=message-123456789"
    });
    expect(seeded.pending?.target.kind).toBe("message");
  });

  it("patches a resolved task title without adding it to a user's explicit label", async () => {
    const seeded = seedComposerRouteReference({ kind: "session", href: "#/tasks/task-123456789", label: null, sessionId: "task-123456789" });
    const instance = editor(seeded.attrs);
    resolveComposerRouteReferences(instance.view, [seeded.pending!], async () => "[Resolved] owner@example.test");
    await vi.waitFor(() => expect(firstAttrs(instance).display).toBe("Resolved owner＠example.test"));
    expect(firstAttrs(instance).serialized).toBe("[Resolved owner＠example.test](#/tasks/task-123456789)");
  });

  it("keeps a bounded message body as semantics while showing a compact label", async () => {
    const href = "#/tasks/task-1?event=event-123456789";
    const seeded = seedComposerRouteReference({ kind: "session", href, label: null, sessionId: "task-1", eventId: "event-123456789" });
    const instance = editor(seeded.attrs);
    const body = `first\n\n${"x".repeat(COMPOSER_MESSAGE_REFERENCE_TEXT_LIMIT + 500)}`;
    resolveComposerRouteReferences(instance.view, [seeded.pending!], async () => body);
    await vi.waitFor(() => expect(firstAttrs(instance).semanticTextTruncated).toBe(true));
    const attrs = firstAttrs(instance);
    expect(attrs.display).toHaveLength(COMPOSER_MESSAGE_REFERENCE_LABEL_LIMIT);
    expect(attrs.semanticText).toHaveLength(COMPOSER_MESSAGE_REFERENCE_TEXT_LIMIT);
    expect(attrs.serialized).toBe(href);
  });

  it("uses a resolved project name for display but preserves the bare project wire", async () => {
    const href = "#/projects/project-123456789";
    const seeded = seedComposerRouteReference({ kind: "project", href, label: null, projectId: "project-123456789" });
    const instance = editor(seeded.attrs);
    resolveComposerRouteReferences(instance.view, [seeded.pending!], async () => "Project Alpha");
    await vi.waitFor(() => expect(firstAttrs(instance).display).toBe("Project Alpha"));
    expect(firstAttrs(instance).serialized).toBe(href);
  });
});
