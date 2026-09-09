import type { ArtifactDownloadContext } from "../model.js";
// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WorkspaceModelLightbox, type WorkspaceModelLightboxLabels } from "./WorkspaceModelLightbox.js";
import * as modelRuntime from "./workspace-model-runtime.js";

const labels: WorkspaceModelLightboxLabels = {
  loading: "Loading model",
  unavailable: "Model unavailable",
  close: "Close",
  download: "Download",
  downloadFailed: "Download failed",
  zoomIn: "Zoom in",
  zoomOut: "Zoom out",
  reset: "Reset view",
  interactionHint: "Drag to orbit"
};
const roots: Root[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0).reverse()) root.unmount(); });
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
  document.body.className = "";
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("WorkspaceModelLightbox", () => {
  it("fails closed without WebGL while retaining download and accessible close controls", async () => {
    const download = vi.fn(async () => { throw new Error("no"); });
    mount(download);
    await act(async () => undefined);
    expect(document.querySelector('[role="dialog"][aria-label="robot.glb"]')).not.toBeNull();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Model unavailable");
    expect(document.querySelector<HTMLButtonElement>('button[aria-label="Download"]')?.disabled).toBe(false);
    await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="Download"]')?.click(); });
    expect(download).toHaveBeenCalledTimes(1);
    expect([...document.querySelectorAll('[role="alert"]')].map((element) => element.textContent)).toContain("Download failed");
  });

  it("closes after the fade, restores focus, and owns Escape before the document", () => {
    const trigger = document.body.appendChild(document.createElement("button"));
    const focus = vi.spyOn(trigger, "focus");
    const onClose = vi.fn();
    const root = mount(async () => undefined, onClose, trigger);
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(onClose).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(200));
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => root.render(null));
    expect(focus).toHaveBeenCalled();
  });

  it("owns a detached document and retires old source actions, custom elements and close timers", async () => {
    class DetachedModel extends HTMLElement {}
    customElements.define("model-viewer", DetachedModel);
    vi.spyOn(modelRuntime, "ensureWorkspaceModelViewer").mockResolvedValue();
    const frame = document.body.appendChild(document.createElement("iframe"));
    const ownerDocument = frame.contentDocument!;
    const ownerWindow = frame.contentWindow!;
    const trigger = ownerDocument.body.appendChild(ownerDocument.createElement("button"));
    const focus = vi.spyOn(trigger, "focus");
    let rejectDownload!: (error: Error) => void;
    const pendingDownload = new Promise<void>((_resolve, reject) => { rejectDownload = reject; });
    const onClose = vi.fn();
    const root = mount(() => pendingDownload, onClose, trigger);
    await act(async () => undefined);
    await act(async () => vi.advanceTimersByTime(20));
    const first = ownerDocument.querySelector("model-viewer")!;
    expect(first).toBeInstanceOf(DetachedModel);
    expect(first.ownerDocument).toBe(ownerDocument);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.classList.contains("modal-open")).toBe(false);
    expect(ownerDocument.body.classList.contains("modal-open")).toBe(true);
    await act(async () => ownerDocument.querySelector<HTMLButtonElement>('button[aria-label="Download"]')!.click());
    act(() => ownerDocument.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await act(async () => root.render(<WorkspaceModelLightbox src="blob:next" name="next.glb" labels={labels} returnFocus={trigger} onDownload={async () => undefined} onClose={onClose} />));
    await act(async () => { rejectDownload(new Error("late")); vi.advanceTimersByTime(200); });
    expect(onClose).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expect(first.hasAttribute("src")).toBe(false);
    expect(first.isConnected).toBe(false);
    expect(ownerDocument.querySelector('[role="alert"]')).toBeNull();
    const current = ownerDocument.querySelector("model-viewer")!;
    await act(async () => current.dispatchEvent(new Event("error")));
    expect(ownerDocument.querySelector('[role="alert"]')?.textContent).toContain("Model unavailable");
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    act(() => ownerDocument.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true })));
    await act(async () => vi.advanceTimersByTime(200));
    expect(onClose).not.toHaveBeenCalled();
    const closeButton = ownerDocument.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!;
    closeButton.focus();
    act(() => ownerDocument.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
    expect(ownerDocument.activeElement).toBe(current);
    act(() => ownerDocument.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await act(async () => vi.advanceTimersByTime(200));
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => root.render(null));
    expect(ownerDocument.activeElement).toBe(trigger);
    expect(ownerDocument.body.classList.contains("modal-open")).toBe(false);
    expect(ownerWindow.document).toBe(ownerDocument);
  });

  it("retires pending download feedback across source ABA and document changes under the same model owner", async () => {
    const trigger = document.body.appendChild(document.createElement("button"));
    const frame = document.body.appendChild(document.createElement("iframe"));
    const nextTrigger = frame.contentDocument!.body.appendChild(frame.contentDocument!.createElement("button"));
    let rejectDownload!: (cause: Error) => void;
    const pending = new Promise<void>((_resolve, reject) => { rejectDownload = reject; });
    const download = vi.fn((_context: ArtifactDownloadContext) => pending);
    const render = (src: string, target: HTMLElement) => <WorkspaceModelLightbox ownerKey="artifact" src={src} name="scene.glb" labels={labels} returnFocus={target} onClose={() => undefined} onDownload={download} />;
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    roots.push(root);
    await act(async () => root.render(render("blob:one", trigger)));
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Download"]')!.click());
    const savingContext = download.mock.calls[0]![0];
    expect(savingContext.ownerDocument).toBe(document);
    expect(savingContext.signal.aborted).toBe(false);
    await act(async () => root.render(render("blob:two", trigger)));
    expect(savingContext.signal.aborted).toBe(true);
    await act(async () => root.render(render("blob:one", nextTrigger)));
    await act(async () => rejectDownload(new Error("late")));
    expect([...frame.contentDocument!.querySelectorAll('[role="alert"]')].map((element) => element.textContent)).not.toContain("Download failed");
    expect(download).toHaveBeenCalledTimes(1);
  });
});

function mount(
  onDownload: () => Promise<void>,
  onClose = vi.fn(),
  returnFocus?: HTMLElement
): Root {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(<WorkspaceModelLightbox
    src="blob:model"
    name="robot.glb"
    labels={labels}
    returnFocus={returnFocus}
    onDownload={onDownload}
    onClose={onClose}
  />));
  return root;
}
