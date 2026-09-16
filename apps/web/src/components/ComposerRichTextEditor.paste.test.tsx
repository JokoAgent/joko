// @vitest-environment jsdom
import type { Editor, JSONContent } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { act, createRef, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerRichTextEditor, type ComposerRichTextEditorHandle } from "./ComposerRichTextEditor.js";
import type { ComposerInlineMentionRange } from "../model.js";
import { composerInternalDropCaretPosition } from "./composer-internal-drop-caret.js";
import { skipComposerListNormalization } from "./composer-list-normalization.js";
import { promoteTrailingPlainListParagraph } from "./composer-list-nodes.js";

const roots: Root[] = [];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  document.body.replaceChildren();
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

async function mount(overrides: Partial<Parameters<typeof ComposerRichTextEditor>[0]> = {}, ownerDocument: Document = document): Promise<{
  readonly editor: HTMLElement;
  readonly changes: JSONContent[];
  readonly files: File[][];
  readonly handle: RefObject<ComposerRichTextEditorHandle | null>;
  readonly render: (next?: Partial<Parameters<typeof ComposerRichTextEditor>[0]>) => Promise<void>;
}> {
  const host = ownerDocument.body.appendChild(ownerDocument.createElement("div"));
  const root = createRoot(host);
  roots.push(root);
  const changes: JSONContent[] = [];
  const files: File[][] = [];
  const handle = createRef<ComposerRichTextEditorHandle>();
  const render = async (next: Partial<Parameters<typeof ComposerRichTextEditor>[0]> = {}): Promise<void> => {
    await act(async () => {
      root.render(<ComposerRichTextEditor
        ref={handle}
        document={{ type: "doc", content: [{ type: "paragraph" }] }}
        editable
        disabled={false}
        placeholder="Prompt"
        onDocumentChange={(document) => changes.push(document)}
        onKeyDown={() => false}
        onClipboardFiles={(value) => files.push([...value])}
        pastedTextLabel={(lines) => `Pasted text (${lines} lines)`}
        onPastedTextOpen={() => undefined}
        {...overrides}
        {...next}
      />);
    });
  };
  await render();
  const editor = await vi.waitFor(() => {
    const element = host.querySelector<HTMLElement>(".ProseMirror");
    expect(element).not.toBeNull();
    return element!;
  });
  return { editor, changes, files, handle, render };
}

function paste(editor: HTMLElement, text: string, options: { readonly html?: string; readonly files?: readonly File[] } = {}): void {
  const files = options.files ?? [];
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      files,
      items: files.map((file) => ({ kind: "file", getAsFile: () => file })),
      getData: (kind: string) => kind === "text/plain" ? text : kind === "text/html" ? options.html ?? "" : ""
    }
  });
  editor.dispatchEvent(event);
}

function installLiteralListMarker(editor: Editor): void {
  const paragraph = required(editor.state.schema.nodes["paragraph"]).create(
    null,
    editor.state.schema.text("- ")
  );
  const transaction = skipComposerListNormalization(
    editor.state.tr.replaceWith(0, editor.state.doc.content.size, paragraph)
  ).setMeta("addToHistory", false);
  transaction.setSelection(TextSelection.atEnd(transaction.doc));
  editor.view.dispatch(transaction);
}

function scheduleCompositionRepair(editor: Editor, ownerWindow: Window): void {
  const event = new (ownerWindow as Window & typeof globalThis).CompositionEvent("compositionend", { bubbles: true });
  const scheduled = editor.view.someProp("handleDOMEvents", (handlers) => {
    const handler = handlers.compositionend;
    if (handler === undefined) return undefined;
    handler(editor.view, event);
    return true;
  });
  expect(scheduled).toBe(true);
}

describe("rich composer paste integration", () => {
  it("keeps an existing occurrence through nested automatic list promotion and observes identical text replacement", async () => {
    let ranges: readonly ComposerInlineMentionRange[] = [{ mentionId: "artifact", from: 0, to: 7 }];
    const changes: JSONContent[] = [];
    const mounted = await mount({
      document: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "@Export" }] }] },
      onDocumentChange: (document, _composing, mapRanges) => {
        ranges = mapRanges(ranges);
        changes.push(document);
      }
    });
    const editor = (mounted.editor as HTMLElement & { editor: Editor }).editor;
    act(() => {
      const transaction = editor.state.tr.insertText("- ", 1);
      transaction.setSelection(TextSelection.atEnd(transaction.doc));
      editor.view.dispatch(transaction);
    });
    expect(changes).toHaveLength(1);
    expect(changes[0]?.content?.[0]?.type).toBe("bulletList");
    expect(ranges).toEqual([{ mentionId: "artifact", from: 2, to: 9 }]);
    act(() => editor.view.dispatch(editor.state.tr.insertText("@Export", 3, 10)));
    expect(changes).toHaveLength(2);
    expect(ranges).toEqual([]);
  });

  it("gives clipboard files priority over a long text payload", async () => {
    const mounted = await mount();
    const file = new File(["image"], "capture.png", { type: "image/png" });
    const initialChanges = mounted.changes.length;
    act(() => paste(mounted.editor, Array.from({ length: 30 }, () => "line").join("\n"), { files: [file] }));
    expect(mounted.files).toEqual([[file]]);
    expect(mounted.changes).toHaveLength(initialChanges);
    expect(mounted.editor.querySelector("[data-composer-pasted-text]")).toBeNull();
  });

  it("turns a 24-line paste into one full-payload atom", async () => {
    const mounted = await mount();
    const text = Array.from({ length: 24 }, (_, index) => `line ${index + 1}`).join("\n");
    act(() => paste(mounted.editor, text));
    await vi.waitFor(() => expect(mounted.changes.at(-1)?.content?.[0]?.content?.[0]?.type).toBe("composerPastedText"));
    expect((mounted.changes.at(-1)?.content?.[0]?.content?.[0] as { readonly attrs?: Record<string, unknown> }).attrs).toMatchObject({ text, display: "Pasted text (24 lines)" });
  });

  it("keeps long-paste replacement as one exact undoable action across a controlled rerender", async () => {
    const original = "keep remove tail";
    const mounted = await mount({
      document: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: original }] }] }
    });
    const editor = (mounted.editor as HTMLElement & { editor: Editor }).editor;
    const payload = Array.from({ length: 24 }, (_, index) => `line ${index + 1}`).join("\n");
    act(() => editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 6, 12))));
    act(() => paste(mounted.editor, payload));
    const pasted = required(mounted.changes.at(-1));
    expect(pasted.content?.[0]?.content?.map((node) => node.type)).toEqual(["text", "composerPastedText", "text"]);
    expect(pasted.content?.[0]?.content?.[1]?.attrs?.["text"]).toBe(payload);

    await mounted.render({ document: pasted });
    act(() => expect(editor.commands.undo()).toBe(true));
    expect(editor.state.doc.textContent).toBe(original);
    expect((editor.state.doc.toJSON() as JSONContent).content?.[0]?.content?.some(
      (node) => node.type === "composerPastedText"
    )).toBe(false);
    act(() => expect(editor.commands.redo()).toBe(true));
    expect((editor.state.doc.toJSON().content?.[0]?.content?.[1] as { readonly attrs?: Record<string, unknown> } | undefined)?.attrs?.["text"]).toBe(payload);
  });

  it("does not treat long-paste atom insertion or atom edits as newly typed list text", async () => {
    const mounted = await mount();
    const editor = (mounted.editor as HTMLElement & { editor: Editor }).editor;
    act(() => installLiteralListMarker(editor));
    const payload = Array.from({ length: 24 }, (_, index) => `line ${index + 1}`).join("\n");
    act(() => paste(mounted.editor, payload));
    expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(editor.state.doc.firstChild?.content.content.map(
      (node: import("@tiptap/pm/model").Node) => node.type.name
    )).toEqual(["text", "composerPastedText"]);
    const edited = `${payload}\nedited`;
    act(() => expect(mounted.handle.current?.editPastedText(3, payload, edited, "Pasted text (25 lines)")).toBe(true));
    expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
    act(() => expect(mounted.handle.current?.editPastedText(3, edited, "", "Pasted text (0 lines)")).toBe(true));
    expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(editor.state.doc.textContent).toBe("- ");
  });

  it("does not reinterpret a route-segment paste that starts with a list marker", async () => {
    const resolveRouteReference = vi.fn(async () => "Resolved task title");
    const mounted = await mount({ resolveRouteReference });
    const editor = (mounted.editor as HTMLElement & { editor: Editor }).editor;
    act(() => paste(mounted.editor, "- #/tasks/task-1"));
    await vi.waitFor(() => {
      expect(resolveRouteReference).toHaveBeenCalledTimes(1);
      expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
      expect((editor.state.doc.firstChild?.lastChild?.attrs as Record<string, unknown>)?.["display"]).toBe("Resolved task title");
    });
    expect(editor.state.doc.firstChild?.content.content.map(
      (node: import("@tiptap/pm/model").Node) => node.type.name
    )).toEqual(["text", "composerRouteReference"]);
  });

  it("lets native history undo a list conversion without immediately promoting the restored marker", async () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const ownerDocument = required(frame.contentDocument);
    const ownerWindow = required(frame.contentWindow);
    const ownerMicrotask = vi.spyOn(ownerWindow, "queueMicrotask");
    const mounted = await mount({}, ownerDocument);
    const editor = (mounted.editor as HTMLElement & { editor: Editor }).editor;
    act(() => installLiteralListMarker(editor));
    act(() => expect(promoteTrailingPlainListParagraph(editor.view)).toBe(true));
    expect(editor.state.doc.firstChild?.type.name).toBe("bulletList");

    const historyKey = async (shiftKey = false): Promise<void> => {
      await act(async () => {
        expect(mounted.editor.dispatchEvent(new (ownerWindow as Window & typeof globalThis).KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "z",
          ctrlKey: true,
          shiftKey
        }))).toBe(false);
        await Promise.resolve();
      });
    };
    await act(async () => {
      expect(mounted.editor.dispatchEvent(new (ownerWindow as Window & typeof globalThis).KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "z",
        ctrlKey: true
      }))).toBe(false);
      scheduleCompositionRepair(editor, ownerWindow);
      await new Promise<void>((resolve) => ownerWindow.setTimeout(resolve, 0));
    });
    expect(ownerMicrotask).toHaveBeenCalled();
    expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(editor.state.doc.textContent).toBe("- ");

    await historyKey(true);
    expect(editor.state.doc.firstChild?.type.name).toBe("bulletList");
    await historyKey();
    expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");

    act(() => editor.view.dispatch(editor.state.tr.insertText("x")));
    expect(editor.state.doc.firstChild?.type.name).toBe("bulletList");
    expect(editor.state.doc.textContent).toBe("x");
  });

  it("inserts structured lists instead of flattening their markers", async () => {
    const mounted = await mount();
    act(() => paste(mounted.editor, "3) third\n4) fourth"));
    await vi.waitFor(() => expect(mounted.changes.at(-1)?.content?.[0]?.type).toBe("orderedList"));
    expect(mounted.changes.at(-1)?.content?.[0]?.attrs).toMatchObject({ start: 3, marker: ")" });
  });

  it("resolves a message deep link to bounded semantic text while keeping its wire link", async () => {
    const href = "#/tasks/task-1?message=message-123456789";
    const mounted = await mount({ resolveRouteReference: async () => "Referenced\nmessage body" });
    act(() => paste(mounted.editor, `[Task title](${href})`));
    await vi.waitFor(() => expect((mounted.changes.at(-1)?.content?.[0]?.content?.[0] as { readonly attrs?: Record<string, unknown> })?.attrs?.["semanticText"]).toBe("Referenced\nmessage body"));
    const attrs = (mounted.changes.at(-1)?.content?.[0]?.content?.[0] as { readonly attrs?: Record<string, unknown> }).attrs;
    expect(attrs).toMatchObject({ display: "Referenced message body", serialized: href, semanticText: "Referenced\nmessage body" });
  });

  it("upgrades only known workspace paths and leaves unknown candidates verbatim", async () => {
    const mounted = await mount({ workingDirectory: "D:\\repo", knownWorkspacePaths: ["src/known.ts"] });
    act(() => paste(mounted.editor, "D:\\repo\\src\\known.ts D:\\repo\\src\\missing.ts"));
    await vi.waitFor(() => expect(mounted.changes.length).toBeGreaterThan(0));
    const content = mounted.changes.at(-1)?.content?.[0]?.content ?? [];
    expect(content.some((node) => node.type === "composerRouteReference" && node.attrs?.["serialized"] === "@src/known.ts")).toBe(true);
    expect(content.some((node) => node.type === "text" && node.text?.includes("D:\\repo\\src\\missing.ts"))).toBe(true);
  });

  it("inserts a private drag reference as one route atom", async () => {
    const mounted = await mount();
    act(() => {
      expect(mounted.handle.current?.insertRouteReference({
        source: "workspace",
        attrs: { kind: "path", display: "src/main.ts", serialized: "@src/main.ts", reference: "src/main.ts" }
      })).toBe(true);
    });
    await vi.waitFor(() => expect(mounted.changes.at(-1)?.content?.[0]?.content?.[0]).toMatchObject({
      type: "composerRouteReference",
      attrs: { kind: "path", serialized: "@src/main.ts", reference: "src/main.ts" }
    }));
    expect(mounted.editor.textContent).not.toContain("application/x-");
  });

  it("maps a private drop caret in the editor owner document and inserts at the last verified coordinate", async () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const ownerDocument = required(frame.contentDocument);
    const resolveRouteReference = vi.fn(async () => "Resolved task title");
    const mounted = await mount({
      document: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "left right" }] }] },
      resolveRouteReference
    }, ownerDocument);
    const editor = (mounted.editor as HTMLElement & { editor: Editor }).editor;
    const positionAtCoordinates = vi.spyOn(editor.view, "posAtCoords").mockReturnValue({ pos: 6, inside: 0 });

    act(() => {
      editor.view.dispatch(editor.state.tr.setSelection(TextSelection.atEnd(editor.state.doc)));
      expect(mounted.handle.current?.routeReferenceDrop({ kind: "start" })).toBe(true);
      expect(mounted.handle.current?.routeReferenceDrop({ kind: "move", clientX: 42, clientY: 19 })).toBe(true);
    });
    const caret = await vi.waitFor(() => required(ownerDocument.querySelector<HTMLElement>("[data-composer-internal-drop-caret='true']")));
    expect(caret.ownerDocument).toBe(ownerDocument);
    expect(document.querySelector("[data-composer-internal-drop-caret='true']")).toBeNull();
    expect(composerInternalDropCaretPosition(editor.state)).toBe(6);

    act(() => editor.view.dispatch(editor.state.tr.insertText("++", 1)));
    expect(composerInternalDropCaretPosition(editor.state)).toBe(8);
    positionAtCoordinates.mockReturnValue(null);
    const href = "#/tasks/task-1";
    act(() => {
      expect(mounted.handle.current?.routeReferenceDrop({
        kind: "commit",
        clientX: 44,
        clientY: 20,
        insertion: {
          source: "session",
          attrs: { kind: "session", display: "task-1", serialized: href, reference: "task-1", href },
          pending: { target: { kind: "session", href, sessionId: "task-1" }, expectedDisplay: "task-1" }
        }
      })).toBe(true);
    });

    await vi.waitFor(() => {
      expect(resolveRouteReference).toHaveBeenCalledTimes(1);
      expect(mounted.changes.at(-1)?.content?.[0]?.content?.[1]?.attrs?.["display"]).toBe("Resolved task title");
    });
    const content = mounted.changes.at(-1)?.content?.[0]?.content ?? [];
    expect(content.map((node) => node.type)).toEqual(["text", "composerRouteReference", "text"]);
    expect(content[0]?.text).toBe("++left ");
    expect(content[1]?.attrs).toMatchObject({
      reference: "task-1",
      display: "Resolved task title",
      serialized: "[Resolved task title](#/tasks/task-1)"
    });
    expect(content[2]?.text).toBe("right");
    expect(composerInternalDropCaretPosition(editor.state)).toBeUndefined();
    expect(ownerDocument.querySelector("[data-composer-internal-drop-caret='true']")).toBeNull();
  });

  it("uses the pre-drag selection when coordinates cannot be resolved", async () => {
    const mounted = await mount({
      document: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "abcd" }] }] }
    });
    const editor = (mounted.editor as HTMLElement & { editor: Editor }).editor;
    vi.spyOn(editor.view, "posAtCoords").mockReturnValue(null);
    act(() => {
      editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 3)));
      expect(mounted.handle.current?.routeReferenceDrop({ kind: "start" })).toBe(true);
      editor.view.dispatch(editor.state.tr.setSelection(TextSelection.atEnd(editor.state.doc)));
      expect(mounted.handle.current?.routeReferenceDrop({ kind: "move", clientX: 1, clientY: 2 })).toBe(true);
    });
    expect(composerInternalDropCaretPosition(editor.state)).toBe(3);
    act(() => expect(mounted.handle.current?.routeReferenceDrop({
      kind: "commit",
      clientX: 1,
      clientY: 2,
      insertion: {
        source: "workspace",
        attrs: { kind: "path", display: "fallback.ts", serialized: "@fallback.ts", reference: "fallback.ts" }
      }
    })).toBe(true));
    await vi.waitFor(() => expect(mounted.changes.at(-1)?.content?.[0]?.content?.map((node) => node.type)).toEqual([
      "text",
      "composerRouteReference",
      "text"
    ]));
    const content = mounted.changes.at(-1)?.content?.[0]?.content ?? [];
    expect(content[0]?.text).toBe("ab");
    expect(content[1]?.attrs?.["reference"]).toBe("fallback.ts");
    expect(content[2]?.text).toBe("cd");
    expect(composerInternalDropCaretPosition(editor.state)).toBeUndefined();
  });

  it("defers composition repair on the owner window and retires it after structural change", async () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const ownerDocument = required(frame.contentDocument);
    const ownerWindow = required(frame.contentWindow);
    const mounted = await mount({}, ownerDocument);
    const editor = (mounted.editor as HTMLElement & { editor: Editor }).editor;
    act(() => installLiteralListMarker(editor));
    const ownerTimer = vi.spyOn(ownerWindow, "setTimeout");

    act(() => scheduleCompositionRepair(editor, ownerWindow));
    expect(ownerTimer).toHaveBeenCalledWith(expect.any(Function), 0);
    await act(async () => { await new Promise<void>((resolve) => ownerWindow.setTimeout(resolve, 0)); });
    expect(editor.state.doc.firstChild?.type.name).toBe("bulletList");

    act(() => installLiteralListMarker(editor));
    act(() => scheduleCompositionRepair(editor, ownerWindow));
    act(() => expect(mounted.handle.current?.insertRouteReference({
      source: "workspace",
      attrs: { kind: "path", display: "src/main.ts", serialized: "@src/main.ts", reference: "src/main.ts" }
    })).toBe(true));
    await act(async () => { await new Promise<void>((resolve) => ownerWindow.setTimeout(resolve, 0)); });
    expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(editor.state.doc.firstChild?.content.content.map(
      (node: import("@tiptap/pm/model").Node) => node.type.name
    )).toEqual(["text", "composerRouteReference"]);
  });
});

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected test value");
  return value;
}
