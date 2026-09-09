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
    ownerKey="task"
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

  it("owns its portal and clipboard window, ignores retired text feedback, and restores focus only on explicit close", async () => {
    const frame = document.body.appendChild(document.createElement("iframe"));
    const detached = frame.contentDocument!;
    const trigger = document.body.appendChild(document.createElement("button"));
    const nextTrigger = detached.body.appendChild(detached.createElement("button"));
    const originalFocus = vi.spyOn(trigger, "focus");
    const nextFocus = vi.spyOn(nextTrigger, "focus");
    let rejectOld!: (error: unknown) => void;
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(() => new Promise<void>((_resolve, reject) => { rejectOld = reject; })) } });
    const nextWrite = vi.fn(async () => undefined);
    Object.defineProperty(detached.defaultView!.navigator, "clipboard", { configurable: true, value: { writeText: nextWrite } });
    const root = createRoot(document.body.appendChild(document.createElement("div")));
    roots.push(root);
    const onClose = vi.fn();
    const render = (text: string, returnFocus: HTMLElement) => act(async () => root.render(<SentPastedTextLightbox ownerKey="task" text={text} display="Pasted text" labels={{ title: "Pasted text", lines: (count) => `${count} lines`, copy: "Copy", copied: "Copied", copyFailed: "Copy failed", close: "Close" }} returnFocus={returnFocus} onClose={onClose} />));
    await render("first", trigger);
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Copy"]')!.click());
    await render("second", nextTrigger);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(detached.querySelector("pre")?.textContent).toBe("second");
    expect(originalFocus).not.toHaveBeenCalled();
    await act(async () => rejectOld(new Error("old clipboard failure")));
    expect(detached.querySelector('[role="alert"]')).toBeNull();
    await act(async () => detached.querySelector<HTMLButtonElement>('button[aria-label="Copy"]')!.click());
    expect(nextWrite).toHaveBeenCalledExactlyOnceWith("second");
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    act(() => detached.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true })));
    expect(onClose).not.toHaveBeenCalled();
    act(() => detached.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(onClose).toHaveBeenCalledOnce();
    expect(nextFocus).toHaveBeenCalledOnce();
    expect(detached.activeElement).toBe(nextTrigger);
    await act(async () => root.render(null));
    expect(nextFocus).toHaveBeenCalledOnce();
  });
});
