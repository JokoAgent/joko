// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { WorkspaceImageLightbox, type WorkspaceImageLightboxLabels } from "./WorkspaceImageLightbox.js";

const labels: WorkspaceImageLightboxLabels = {
  close: "Close",
  copy: "Copy",
  copied: "Copied",
  copyFailed: "Copy failed",
  saveAs: "Save",
  saveFailed: "Save failed",
  annotate: "Annotate",
  discardAnnotation: "Discard",
  undoAnnotation: "Undo",
  sendToChat: "Send",
  sendFailed: "Send failed",
  previousImage: "Previous image",
  nextImage: "Next image",
  zoomIn: "Zoom in",
  zoomOut: "Zoom out",
  fitImage: "Fit",
  actualSize: "Actual size",
  loading: "Loading image",
  unavailable: "Image unavailable"
};

const roots: Root[] = [];

beforeAll(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  document.body.className = "";
});

describe("WorkspaceImageLightbox gallery surface", () => {
  it("keeps one modal mounted while loading and routes buttons and arrow keys through the gallery", () => {
    const previous = vi.fn();
    const next = vi.fn();
    mount(<WorkspaceImageLightbox
      src=""
      name="render.png"
      labels={labels}
      status="loading"
      gallery={{ index: 1, total: 3, onPrevious: previous, onNext: next }}
      showZoomControls
      onClose={() => undefined}
      onDownload={() => undefined}
    />);

    expect(document.querySelector('[role="dialog"][aria-label="render.png"]')).not.toBeNull();
    expect(document.querySelector(".workspace-image-lightbox__status")?.textContent).toBe("Loading image");
    expect(document.querySelector(".workspace-image-lightbox__counter")?.textContent).toBe("2 / 3");
    act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Previous image"]')?.click());
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(previous).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
    expect(document.querySelector<HTMLButtonElement>('button[aria-label="Copy"]')?.disabled).toBe(true);
  });

  it("announces a failed authenticated preview without exposing a broken image", () => {
    mount(<WorkspaceImageLightbox
      src=""
      name="render.png"
      labels={labels}
      status="error"
      onClose={() => undefined}
      onDownload={() => undefined}
    />);
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Image unavailable");
    expect(document.querySelector("img")).toBeNull();
  });
});

function mount(element: ReactNode): void {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(element));
}
