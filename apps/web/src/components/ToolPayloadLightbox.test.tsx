// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolPayloadLightbox } from "./ToolPayloadLightbox.js";

const roots: Root[] = [];
const labels = {
  close: "Close",
  copy: "Copy displayed payload",
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
  });

  it("switches input/output and restores focus after the close transition", () => {
    const trigger = document.body.appendChild(document.createElement("button"));
    const focus = vi.spyOn(trigger, "focus");
    const onClose = vi.fn();
    mount(onClose, trigger);
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
});
