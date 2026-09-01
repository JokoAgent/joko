// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SentPastedTextLightbox } from "./SentPastedTextLightbox.js";

const roots: Root[] = [];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(async () => undefined) } });
});

afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  document.body.replaceChildren();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

function mount(onClose = vi.fn()): { readonly root: Root; readonly onClose: ReturnType<typeof vi.fn> } {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(<SentPastedTextLightbox
    text={"first\nsecond"}
    display="Pasted text (2 lines)"
    labels={{ title: "Pasted text", lines: (count) => `${count} lines`, copy: "Copy", copied: "Copied", copyFailed: "Copy failed", close: "Close" }}
    onClose={onClose}
  />));
  return { root, onClose };
}

describe("sent pasted-text lightbox", () => {
  it("shows the full read-only text and copies it", async () => {
    mount();
    expect(document.querySelector("[role=dialog]")?.textContent).toContain("Pasted text (2 lines) · 2 lines");
    expect(document.querySelector("pre")?.textContent).toBe("first\nsecond");
    await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="Copy"]')?.click(); });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("first\nsecond");
    expect(document.querySelector("[role=status]")?.textContent).toContain("Copied");
  });

  it("closes from Escape and the independent backdrop", () => {
    const first = mount();
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(first.onClose).toHaveBeenCalledTimes(1);
    act(() => first.root.render(null));
    const second = mount();
    act(() => document.querySelector<HTMLButtonElement>(".text-attachment-lightbox__backdrop")?.click());
    expect(second.onClose).toHaveBeenCalledTimes(1);
  });
});
