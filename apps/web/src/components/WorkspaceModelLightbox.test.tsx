// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WorkspaceModelLightbox, type WorkspaceModelLightboxLabels } from "./WorkspaceModelLightbox.js";

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
