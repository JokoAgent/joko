// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolPayloadLightbox } from "./ToolPayloadLightbox.js";

const roots: Root[] = [];
const labels = {
  close: "Close",
  copy: "Copy displayed payload",
  copyTitle: "Copy title",
  copied: "Payload copied",
  copyFailed: "Could not copy payload",
  selectAll: "Select all",
  allFiles: "All files",
  chooseFile: "View file"
};

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(async () => undefined) } });
});

afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  document.body.replaceChildren();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

function mount(onClose = vi.fn(), returnFocus?: HTMLElement): void {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(<ToolPayloadLightbox
    ownerKey="task"
    title="change_files"
    sections={[
      { id: "input", label: "Input", text: "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n-old\n+new\ndiff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n-before\n+after" },
      { id: "output", label: "Output", text: "completed" }
    ]}
    initialSectionId="input"
    labels={labels}
    returnFocus={returnFocus}
    onClose={onClose}
  />));
}

describe("tool payload lightbox", () => {
  it("uses a native read-only text surface and switches multi-file diffs", () => {
    mount();
    const text = document.querySelector<HTMLTextAreaElement>(".tool-payload-lightbox__body textarea")!;
    const select = document.querySelector<HTMLButtonElement>('button[role="combobox"][aria-label="View file"]')!;
    expect(text.readOnly).toBe(true);
    act(() => select.click());
    const options = document.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]');
    expect(options).toHaveLength(3);
    act(() => options[2]?.click());
    expect(text.value).toContain("diff --git a/b.ts b/b.ts");
    expect(text.value).not.toContain("diff --git a/a.ts b/a.ts");
  });

  it("selects and copies the exact displayed payload", async () => {
    mount();
    const text = document.querySelector<HTMLTextAreaElement>(".tool-payload-lightbox__body textarea")!;
    act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Select all"]')?.click());
    expect(text.selectionStart).toBe(0);
    expect(text.selectionEnd).toBe(text.value.length);
    await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="Copy displayed payload"]')?.click(); });
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(text.value);
    expect(document.querySelector('[role="status"]')?.textContent).toContain("Payload copied");
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Copy title"]')!.click());
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith("change_files");
  });

  it("switches input/output and restores focus after the close transition", () => {
    const trigger = document.body.appendChild(document.createElement("button"));
    const focus = vi.spyOn(trigger, "focus");
    const onClose = vi.fn();
    mount(onClose, trigger);
    const select = document.querySelector<HTMLButtonElement>('[role="combobox"]')!;
    act(() => { select.focus(); select.click(); });
    act(() => select.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true, cancelable: true })));
    expect(select.getAttribute("aria-expanded")).toBe("true");
    act(() => select.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(select.getAttribute("aria-expanded")).toBe("false");
    act(() => vi.advanceTimersByTime(200));
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(select);
    const output = [...document.querySelectorAll<HTMLButtonElement>(".tool-payload-lightbox__tabs button")].find((button) => button.textContent === "Output")!;
    act(() => output.click());
    expect(document.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe("completed");
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(onClose).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(200));
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => roots[0]?.render(null));
    expect(focus).toHaveBeenCalled();
  });

  it("keeps payload copies and closing transitions within their source and triggering Document", async () => {
    const frame = document.body.appendChild(document.createElement("iframe"));
    const detached = frame.contentDocument!;
    const trigger = document.body.appendChild(document.createElement("button"));
    const nextTrigger = detached.body.appendChild(detached.createElement("button"));
    const triggerFocus = vi.spyOn(trigger, "focus");
    const nextFocus = vi.spyOn(nextTrigger, "focus");
    const writes: { resolve: () => void }[] = [];
    const writeText = vi.fn(() => new Promise<void>((resolve) => { writes.push({ resolve }); }));
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const detachedWrite = vi.fn(async () => undefined);
    Object.defineProperty(detached.defaultView!.navigator, "clipboard", { configurable: true, value: { writeText: detachedWrite } });
    const root = createRoot(document.body.appendChild(document.createElement("div")));
    roots.push(root);
    const oldClose = vi.fn();
    const newClose = vi.fn();
    const render = (ownerKey: string, title: string, returnFocus: HTMLElement, onClose: () => void) => act(async () => root.render(<ToolPayloadLightbox ownerKey={ownerKey} title={title} sections={[{ id: "input", label: "Input", text: "input text" }, { id: "output", label: "Output", text: "output text" }]} initialSectionId="input" labels={labels} returnFocus={returnFocus} onClose={onClose} />));
    await render("task", "first tool", trigger, oldClose);
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Copy displayed payload"]')!.click());
    act(() => [...document.querySelectorAll<HTMLButtonElement>(".tool-payload-lightbox__tabs button")].find((node) => node.textContent === "Output")!.click());
    await act(async () => writes[0]!.resolve());
    expect(document.querySelector('[role="status"]')).toBeNull();
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Copy displayed payload"]')!.click());
    expect(writeText).toHaveBeenLastCalledWith("output text");
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true })));
    expect(oldClose).not.toHaveBeenCalled();
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    await render("next task", "second tool", nextTrigger, newClose);
    await act(async () => { writes[1]!.resolve(); vi.advanceTimersByTime(220); });
    expect(oldClose).not.toHaveBeenCalled();
    expect(newClose).not.toHaveBeenCalled();
    expect(triggerFocus).not.toHaveBeenCalled();
    expect(detached.querySelector('[role="status"]')).toBeNull();
    expect(detached.activeElement).toBe(detached.querySelector("textarea"));
    await act(async () => detached.querySelector<HTMLButtonElement>('button[aria-label="Copy title"]')!.click());
    expect(detachedWrite).toHaveBeenCalledExactlyOnceWith("second tool");
    act(() => detached.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    act(() => vi.advanceTimersByTime(200));
    expect(newClose).toHaveBeenCalledOnce();
    expect(nextFocus).toHaveBeenCalledOnce();
    await act(async () => root.render(null));
    expect(nextFocus).toHaveBeenCalledOnce();
  });
});
