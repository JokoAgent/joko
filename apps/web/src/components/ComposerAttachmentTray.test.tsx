// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { translate } from "../i18n.js";
import type { AttachmentDraft } from "../model.js";
import { ComposerAttachmentTray } from "./ComposerAttachmentTray.js";

const roots: Root[] = [];
const t = (key: Parameters<typeof translate>[1], values?: Parameters<typeof translate>[2]): string => translate("en", key, values);

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:attachment-preview") });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
});

afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0).reverse()) root.unmount(); });
  document.body.replaceChildren();
  document.body.className = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("composer attachment tray", () => {
  it("shows a viewport-aware image preview, opens the image viewer, and does not reopen on restored focus", async () => {
    mount([{ id: "image", kind: "image", file: new File(["image"], "preview.png", { type: "image/png" }), previewUrl: "blob:image" }]);
    const trigger = document.querySelector<HTMLButtonElement>("button.attachment-chip__content");
    expect(trigger?.getAttribute("aria-label")).toContain("preview.png");
    if (trigger === null) throw new Error("Image preview trigger was not rendered.");
    trigger.getBoundingClientRect = () => ({
      top: 8, bottom: 48, left: 20, right: 80, width: 60, height: 40, x: 20, y: 8,
      toJSON: () => ({})
    }) as DOMRect;

    act(() => trigger.focus());
    const hover = document.querySelector<HTMLElement>(".composer-image-hover-preview");
    expect(hover?.style.transform).toBe("translate(-50%, 0)");
    expect(Number.parseFloat(hover?.style.maxWidth ?? "0")).toBeLessThanOrEqual(224);

    act(() => trigger.click());
    expect(document.querySelector(".composer-image-hover-preview")).toBeNull();
    expect(document.querySelector('[role="dialog"][aria-label="preview.png"]')).not.toBeNull();

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      // The viewer owns a 160 ms exit transition before returning focus.
      await new Promise((resolve) => window.setTimeout(resolve, 180));
    });
    expect(document.activeElement).toBe(trigger);
    expect(document.querySelector(".composer-image-hover-preview")).toBeNull();
  });

  it("opens recognized text and code files in the bounded read-only text viewer", async () => {
    const text = "alpha\nbeta";
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      blob: async () => ({ size: text.length, text: async () => text })
    })));
    mount([{ id: "text", kind: "file", file: new File(["alpha\nbeta"], "notes.md", { type: "text/markdown" }) }]);
    const trigger = document.querySelector<HTMLButtonElement>("button.attachment-chip__content");
    await act(async () => {
      trigger?.click();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });

    expect(document.querySelector(".text-attachment-lightbox [role=dialog]")?.textContent).toContain("notes.md");
    expect(document.querySelector(".text-attachment-lightbox pre")?.textContent).toBe("alpha\nbeta");
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("does not offer an unsafe generic opener while keeping removal available", () => {
    const remove = vi.fn();
    mount([{ id: "binary", kind: "file", file: new File(["binary"], "bundle.zip", { type: "application/zip" }) }], remove);

    expect(document.querySelector("button.attachment-chip__content")).toBeNull();
    expect(document.querySelector(".attachment-chip__content")?.getAttribute("title")).toBe("This file cannot be previewed in Joko.");
    act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Remove attachment: bundle.zip"]')?.click());
    expect(remove).toHaveBeenCalledWith(expect.objectContaining({ id: "binary" }));
  });
});

function mount(attachments: readonly AttachmentDraft[], onRemove = vi.fn()): void {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(<ComposerAttachmentTray attachments={attachments} t={t} onRemove={onRemove} />));
}
