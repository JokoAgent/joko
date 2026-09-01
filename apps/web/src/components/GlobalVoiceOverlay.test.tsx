// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GlobalVoiceOverlay } from "./GlobalVoiceOverlay.js";
import { TOOLTIP_DELAY_MS } from "./ui.js";

let root: Root | undefined;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
});

afterEach(async () => {
  if (root !== undefined) await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.useRealTimers();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("global voice overlay actions", () => {
  it("uses the shared delayed tooltip on hover and keyboard focus and dismisses it with Escape", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<GlobalVoiceOverlay initialStatus={{ state: "error", errorKind: "service" }} />));

    const retry = required(document.querySelector<HTMLButtonElement>('button[aria-label="Try again"]'));
    const cancel = required(document.querySelector<HTMLButtonElement>('button[aria-label="Cancel"]'));
    expect(retry.hasAttribute("title")).toBe(false);
    expect(cancel.hasAttribute("title")).toBe(false);

    await act(async () => {
      retry.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    });
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("Try again");

    await act(async () => retry.dispatchEvent(new MouseEvent("pointerout", { bubbles: true })));
    expect(document.querySelector('[role="tooltip"]')).toBeNull();

    await act(async () => {
      cancel.focus();
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    });
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("Cancel");
    await act(async () => cancel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });
});

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected test element");
  return value;
}
