// @vitest-environment jsdom
import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerRichTextEditor, type ComposerRichTextEditorHandle } from "./ComposerRichTextEditor.js";

const roots: Root[] = [];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});

afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount(onKeyDown: (event: KeyboardEvent) => boolean) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host); roots.push(root);
  const handle = createRef<ComposerRichTextEditorHandle>();
  await act(async () => root.render(<ComposerRichTextEditor
    ref={handle}
    document={{ type: "doc", content: [
      { type: "paragraph", content: [{ type: "text", text: "first" }] },
      { type: "paragraph", content: [{ type: "text", text: "second" }] }
    ] }}
    editable disabled={false} placeholder="Prompt"
    onDocumentChange={() => undefined} onKeyDown={onKeyDown}
    onClipboardFiles={() => undefined} pastedTextLabel={() => "Paste"} onPastedTextOpen={() => undefined}
  />));
  const element = await vi.waitFor(() => {
    const value = host.querySelector<HTMLElement & { editor: Editor }>(".ProseMirror");
    expect(value).not.toBeNull();
    return value!;
  });
  element.editor.view.setProps({ handleScrollToSelection: () => true });
  element.focus();
  return { handle, element, editor: element.editor };
}

describe("rich composer fixed input keys", () => {
  it("uses existing key handlers first and otherwise moves the actual ProseMirror caret", async () => {
    let handled = true;
    const onKeyDown = vi.fn((event: KeyboardEvent) => { if (handled) event.preventDefault(); return handled; });
    const { handle, editor } = await mount(onKeyDown);
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 3)));
    const original = editor.getJSON();
    expect(handle.current?.inputKey("ArrowUp")).toBe(true);
    expect(editor.state.selection.head).toBe(3);
    expect(onKeyDown).toHaveBeenCalledOnce();

    handled = false;
    vi.spyOn(editor.view, "endOfTextblock").mockReturnValue(false);
    vi.spyOn(editor.view, "coordsAtPos").mockReturnValue({ left: 12, right: 12, top: 20, bottom: 36 });
    const destination = vi.spyOn(editor.view, "posAtCoords").mockReturnValue({ pos: 9, inside: -1 });
    expect(handle.current?.inputKey("ArrowDown")).toBe(true);
    expect(destination).toHaveBeenCalledWith({ left: 12, top: 44 });
    expect(editor.state.selection.head).toBe(9);
    expect(editor.getJSON()).toEqual(original);

    handled = true;
    expect(handle.current?.inputKey("Enter")).toBe(true);
    expect(onKeyDown.mock.calls.at(-1)?.[0].key).toBe("Enter");
    expect(editor.getJSON()).toEqual(original);
  });

  it("rejects other keys, other focused controls, composition, and read-only editors before key dispatch", async () => {
    const onKeyDown = vi.fn(() => true);
    const { handle, element, editor } = await mount(onKeyDown);
    const unsafe = handle.current!.inputKey as (key: string) => boolean;
    expect(unsafe("A")).toBe(false);
    const button = document.body.appendChild(document.createElement("button"));
    button.focus();
    expect(handle.current?.inputKey("Enter")).toBe(false);
    element.focus();
    Object.defineProperty(editor.view, "composing", { configurable: true, value: true });
    expect(handle.current?.inputKey("ArrowUp")).toBe(false);
    Object.defineProperty(editor.view, "composing", { configurable: true, value: false });
    editor.setEditable(false);
    expect(handle.current?.inputKey("ArrowDown")).toBe(false);
    expect(onKeyDown).not.toHaveBeenCalled();
  });
});
