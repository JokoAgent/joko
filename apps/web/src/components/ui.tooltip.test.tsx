// @vitest-environment jsdom

import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IconButton, TOOLTIP_DELAY_MS, TipSummary, resolveTooltipPlacement } from "./ui.js";

const roots: Root[] = [];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.useRealTimers();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("shared visible tooltips", () => {
  it("labels icon controls without native title and opens from keyboard focus", async () => {
    await render(<IconButton label="Archive"><span aria-hidden="true">A</span></IconButton>);
    const button = required(document.querySelector<HTMLButtonElement>('button[aria-label="Archive"]'));
    expect(button.hasAttribute("title")).toBe(false);

    await act(async () => {
      button.focus();
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS - 1);
    });
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    await act(async () => { vi.advanceTimersByTime(1); });
    const tooltip = required(document.querySelector<HTMLElement>('[role="tooltip"]'));
    expect(tooltip.textContent).toBe("Archive");
    expect(button.getAttribute("aria-describedby")).toBe(tooltip.id);

    await act(async () => button.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });

  it("keeps a disabled reason hoverable and keyboard-reachable", async () => {
    await render(<IconButton label="Send" disabled disabledReason="Wait for the current run"><span aria-hidden="true">S</span></IconButton>);
    const anchor = required(document.querySelector<HTMLElement>(".tip-anchor--disabled"));
    const button = required(anchor.querySelector<HTMLButtonElement>("button"));
    expect(button.disabled).toBe(true);
    expect(anchor.tabIndex).toBe(0);

    await act(async () => {
      anchor.focus();
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    });
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("Wait for the current run");
  });

  it("forwards the trigger element without giving up the shared tooltip", async () => {
    const buttonRef = createRef<HTMLButtonElement>();
    await render(<IconButton buttonRef={buttonRef} label="More"><span aria-hidden="true">M</span></IconButton>);
    const button = required(document.querySelector<HTMLButtonElement>('button[aria-label="More"]'));
    expect(buttonRef.current).toBe(button);
    await act(async () => { button.focus(); vi.advanceTimersByTime(TOOLTIP_DELAY_MS); });
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("More");
  });

  it("keeps a tooltip-enabled summary as the direct details trigger", async () => {
    await render(<details><TipSummary label="More actions"><span aria-hidden="true">…</span></TipSummary><div>Menu</div></details>);
    const details = required(document.querySelector("details"));
    const summary = required(details.querySelector("summary"));
    expect(details.firstElementChild).toBe(summary);
    expect(summary.hasAttribute("title")).toBe(false);
    await act(async () => { summary.focus(); vi.advanceTimersByTime(TOOLTIP_DELAY_MS); });
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("More actions");
  });

  it("flips and clamps portal bubbles at every viewport edge", () => {
    const bubble = { width: 100, height: 40 };
    const cases = [
      { requested: "top" as const, expected: "bottom" as const, anchor: rect(0, 2, 20, 20) },
      { requested: "right" as const, expected: "left" as const, anchor: rect(340, 100, 20, 20) },
      { requested: "bottom" as const, expected: "top" as const, anchor: rect(170, 220, 20, 20) },
      { requested: "left" as const, expected: "right" as const, anchor: rect(0, 100, 20, 20) }
    ];
    for (const entry of cases) {
      const placement = resolveTooltipPlacement(entry.anchor, bubble, entry.requested, 360, 240);
      expect(placement.side).toBe(entry.expected);
      const bounds = tooltipBounds(placement, bubble);
      expect(bounds.left).toBeGreaterThanOrEqual(8);
      expect(bounds.top).toBeGreaterThanOrEqual(8);
      expect(bounds.right).toBeLessThanOrEqual(352);
      expect(bounds.bottom).toBeLessThanOrEqual(232);
    }
  });
});

async function render(element: React.ReactNode): Promise<void> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected test element");
  return value;
}

function rect(left: number, top: number, width: number, height: number): Pick<DOMRect, "left" | "right" | "top" | "bottom" | "width" | "height"> {
  return { left, right: left + width, top, bottom: top + height, width, height };
}

function tooltipBounds(
  placement: ReturnType<typeof resolveTooltipPlacement>,
  bubble: { readonly width: number; readonly height: number }
): { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number } {
  const left = placement.side === "top" || placement.side === "bottom"
    ? placement.left - bubble.width / 2
    : placement.side === "left"
      ? placement.left - bubble.width
      : placement.left;
  const top = placement.side === "left" || placement.side === "right"
    ? placement.top - bubble.height / 2
    : placement.side === "top"
      ? placement.top - bubble.height
      : placement.top;
  return { left, right: left + bubble.width, top, bottom: top + bubble.height };
}
