// @vitest-environment jsdom

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { WorkspaceImageLightbox } from "./WorkspaceImageLightbox.js";
import { WorkspaceMarkdownImageHost } from "./WorkspaceMarkdownImageHost.js";
import { workspaceMarkdownImageExtensions, type WorkspaceMarkdownImageResolver, type WorkspaceMarkdownResolvedImage } from "./workspace-markdown-images.js";

vi.mock("./WorkspaceImageLightbox.js", async () => {
  const { createPortal } = await import("react-dom");
  return {
    WorkspaceImageLightbox: (props: ComponentProps<typeof WorkspaceImageLightbox>) => createPortal(<div role="dialog" aria-label={props.name}>
      <button onClick={(event) => { void props.onDownload({ ownerDocument: event.currentTarget.ownerDocument, signal: new AbortController().signal }); }}>Save</button>
      <button onClick={props.onClose}>Close</button>
    </div>, props.returnFocus!.ownerDocument.body)
  };
});

const labels = {
  close: "Close", copy: "Copy", copied: "Copied", copyFailed: "Copy failed", saveAs: "Save", saveFailed: "Save failed",
  annotate: "Annotate", discardAnnotation: "Discard", undoAnnotation: "Undo", sendToChat: "Send", sendFailed: "Send failed"
};
const panes: { readonly element: HTMLElement; readonly view: EditorView; readonly root: Root }[] = [];

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const pane of panes.splice(0).reverse()) {
    pane.view.destroy();
    await act(async () => pane.root.unmount());
    pane.element.remove();
  }
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("WorkspaceMarkdownImageHost", () => {
  it("opens only the pane whose image was activated even when two editors have the same owner", async () => {
    const first = await mountPane(document, async () => ({ url: "data:image/png;base64,AA==", name: "first.png" }));
    const second = await mountPane(document, async () => ({ url: "data:image/png;base64,AQ==", name: "second.png" }));
    const firstImage = loadedImage(first.element);
    loadedImage(second.element);

    act(() => firstImage.parentElement!.click());
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("first.png");
    act(() => document.querySelector<HTMLButtonElement>('[role="dialog"] button:last-child')!.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    act(() => second.element.querySelector<HTMLElement>(".cm-md-image-item")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("second.png");
  });

  it("creates image and download elements in the editor document and never opens another document", async () => {
    await mountPane(document, async () => ({ url: "data:image/png;base64,AA==", name: "main.png" }));
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const ownerDocument = frame.contentDocument!;
    const globalCreate = vi.spyOn(document, "createElement");
    const localCreate = vi.spyOn(ownerDocument, "createElement");
    const pane = await mountPane(ownerDocument, async () => ({ url: "data:image/png;base64,AQ==", name: "local.png" }));
    const image = loadedImage(pane.element);
    expect(localCreate.mock.calls.some(([name]) => name === "img")).toBe(true);
    expect(globalCreate.mock.calls.some(([name]) => name === "img")).toBe(false);
    act(() => image.parentElement!.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(ownerDocument.querySelectorAll('[role="dialog"]')).toHaveLength(1);

    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(ownerDocument.defaultView!.HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { clicked.push(this); });
    act(() => ownerDocument.querySelector<HTMLButtonElement>('[role="dialog"] button')!.click());
    expect(clicked).toHaveLength(1);
    expect(clicked[0]?.ownerDocument).toBe(ownerDocument);
    expect(clicked[0]?.download).toBe("local.png");
    expect(globalCreate.mock.calls.some(([name]) => name === "a")).toBe(false);
  });

  it("does not reopen a destroyed widget and releases a resolution that arrives after editor destruction", async () => {
    const releaseReady = vi.fn();
    const ready = await mountPane(document, async () => ({ url: "data:image/png;base64,AA==", name: "retired.png", release: releaseReady }));
    const oldHolder = loadedImage(ready.element).parentElement!;
    ready.view.destroy();
    act(() => oldHolder.click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(releaseReady).toHaveBeenCalledTimes(1);

    let resolve!: (value: WorkspaceMarkdownResolvedImage) => void;
    const pending = new Promise<WorkspaceMarkdownResolvedImage>((done) => { resolve = done; });
    const releaseLate = vi.fn();
    const late = await mountPane(document, () => pending);
    late.view.destroy();
    await act(async () => resolve({ url: "data:image/png;base64,AQ==", name: "late.png", release: releaseLate }));
    expect(releaseLate).toHaveBeenCalledTimes(1);
    expect(late.element.querySelector("img")).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});

async function mountPane(ownerDocument: Document, resolver: WorkspaceMarkdownImageResolver) {
  const element = ownerDocument.createElement("section");
  const host = ownerDocument.createElement("div");
  element.append(host);
  ownerDocument.body.append(element);
  const root = createRoot(host);
  const rootRef = { current: element };
  await act(async () => root.render(<WorkspaceMarkdownImageHost ownerKey="same-file-owner" rootRef={rootRef} labels={labels} />));
  const view = new EditorView({
    parent: element,
    state: EditorState.create({ doc: "![image](image.png)", extensions: [...workspaceMarkdownImageExtensions(resolver), EditorView.editable.of(false)] })
  });
  const pane = { element, root, view };
  panes.push(pane);
  await act(async () => { await Promise.resolve(); });
  return pane;
}

function loadedImage(pane: HTMLElement): HTMLImageElement {
  const image = pane.querySelector("img")!;
  act(() => image.dispatchEvent(new pane.ownerDocument.defaultView!.Event("load")));
  return image;
}
