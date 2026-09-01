// @vitest-environment jsdom
import type { JSONContent } from "@tiptap/core";
import { act, createRef, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerRichTextEditor, type ComposerRichTextEditorHandle } from "./ComposerRichTextEditor.js";

const roots: Root[] = [];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  document.body.replaceChildren();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

async function mount(overrides: Partial<Parameters<typeof ComposerRichTextEditor>[0]> = {}): Promise<{
  readonly editor: HTMLElement;
  readonly changes: JSONContent[];
  readonly files: File[][];
  readonly handle: RefObject<ComposerRichTextEditorHandle | null>;
}> {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  roots.push(root);
  const changes: JSONContent[] = [];
  const files: File[][] = [];
  const handle = createRef<ComposerRichTextEditorHandle>();
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
    />);
  });
  const editor = await vi.waitFor(() => {
    const element = host.querySelector<HTMLElement>(".ProseMirror");
    expect(element).not.toBeNull();
    return element!;
  });
  return { editor, changes, files, handle };
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

describe("rich composer paste integration", () => {
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
});
