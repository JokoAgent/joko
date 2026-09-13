// @vitest-environment jsdom

import { act, createRef, StrictMode } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IconButton, TOOLTIP_DELAY_MS, Tip, TipSummary, TooltipProvider, resolveTooltipPlacement } from "./ui.js";

const roots: Root[] = [];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("shared visible tooltips", () => {
  it("labels icon controls without native title and opens from keyboard focus", async () => {
    await render(<IconButton label="Archive"><span aria-hidden="true">A</span></IconButton>);
    const button = required(document.querySelector<HTMLButtonElement>('button[aria-label="Archive"]'));
    expect(button.hasAttribute("title")).toBe(false);

    await act(async () => button.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
    await act(async () => button.focus());
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    await act(async () => document.dispatchEvent(new MouseEvent("pointerup", { bubbles: true })));
    await act(async () => button.blur());
    await hover(button, true);
    await act(async () => { vi.advanceTimersByTime(TOOLTIP_DELAY_MS - 1); });
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    await act(async () => button.focus());
    const tooltip = required(document.querySelector<HTMLElement>('[role="tooltip"]'));
    expect(tooltip.textContent).toBe("Archive");
    expect(button.getAttribute("aria-describedby")).toBe(tooltip.id);
    await act(async () => button.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true })));
    expect(document.querySelector('[role="tooltip"]')).toBe(tooltip);

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

  it("shares the short hover window only within an explicit group and closes on activation", async () => {
    const activated = vi.fn();
    await render(<TooltipProvider><IconButton label="First" /><IconButton label="Second" onClick={activated} /></TooltipProvider>);
    const first = required(document.querySelector<HTMLButtonElement>('[aria-label="First"]'));
    const second = required(document.querySelector<HTMLButtonElement>('[aria-label="Second"]'));
    await hover(first, true);
    await act(async () => { vi.advanceTimersByTime(499); });
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("First");
    await hover(first, false);
    await hover(second, true);
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("Second");
    await act(async () => second.click());
    expect(activated).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    await render(<IconButton label="Independent" />);
    const independent = required(document.querySelector<HTMLButtonElement>('[aria-label="Independent"]'));
    await hover(independent, true);
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    await hover(independent, false);
    await act(async () => { vi.advanceTimersByTime(201); });
    await hover(first, true);
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("First");
    await hover(first, false);
    await hover(second, true, "touch");
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });

  it("handles controlled visibility and retires old content and anchor delays", async () => {
    const scheduled: (() => void)[] = [];
    const setTimeout = window.setTimeout.bind(window);
    vi.spyOn(window, "setTimeout").mockImplementation((handler, timeout, ...args) => {
      if (timeout === 500 && typeof handler === "function") scheduled.push(handler as () => void);
      return Reflect.apply(setTimeout, window, [handler, timeout, ...args]);
    });
    const root = await render(<StrictMode><IconButton label="Start" /></StrictMode>);
    const update = (label: string, tooltipOpen?: boolean, disabled = false) => act(async () => root.render(<StrictMode><IconButton label={label} tooltipOpen={tooltipOpen} disabled={disabled} disabledReason={disabled ? label : undefined} /></StrictMode>));
    let anchor = required(document.querySelector<HTMLButtonElement>("button"));
    await hover(anchor, true);
    await act(async () => { vi.advanceTimersByTime(400); });
    const retired = required(scheduled.at(-1));
    await update("Start", false);
    await update("Start", undefined);
    await act(async () => retired());
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    await act(async () => { vi.advanceTimersByTime(499); });
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("Start");
    await update("Finishing", true);
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("Finishing");
    await update("Finishing", false);
    await hover(anchor, true);
    await act(async () => { vi.advanceTimersByTime(600); });
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    await update("Finishing", undefined);
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("Finishing");
    await hover(anchor, false);
    await update("Start");
    await hover(anchor, true);
    await act(async () => { vi.advanceTimersByTime(400); });
    await update("Other source");
    await update("Start");
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    await update("Start", undefined, true);
    const wrapper = required(document.querySelector<HTMLElement>(".tip-anchor--disabled"));
    await act(async () => { wrapper.focus(); vi.advanceTimersByTime(400); });
    await update("Start");
    anchor = required(document.querySelector<HTMLButtonElement>("button"));
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    await act(async () => { anchor.focus(); vi.advanceTimersByTime(500); });
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("Start");
    await act(async () => window.dispatchEvent(new Event("pagehide")));
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    await act(async () => window.dispatchEvent(new Event("pageshow")));
    await hover(anchor, true);
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("Start");
    await update("Finishing", true);
    await act(async () => window.dispatchEvent(new Event("pagehide")));
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    await update("Finishing", false);
    await update("Finishing", true);
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("Finishing");
  });

  it("positions and observes foreign-document bubbles without sharing its timing or late callbacks with another document", async () => {
    const frame = document.body.appendChild(document.createElement("iframe"));
    const child = required(frame.contentDocument);
    const ownerWindow = required(child.defaultView);
    const viewport = Object.assign(new ownerWindow.EventTarget(), { offsetLeft: 30, offsetTop: 40, width: 180, height: 120 });
    Object.defineProperty(ownerWindow, "visualViewport", { configurable: true, value: viewport });
    const observed: Element[] = [];
    const disconnect = vi.fn();
    let resized: (() => void) | undefined;
    Object.defineProperty(ownerWindow, "ResizeObserver", { configurable: true, value: class {
      constructor(callback: () => void) { resized = callback; }
      observe(element: Element) { observed.push(element); }
      disconnect = disconnect;
    } });
    ownerWindow.requestAnimationFrame = (callback) => ownerWindow.setTimeout(() => callback(0), 16);
    ownerWindow.cancelAnimationFrame = (id) => ownerWindow.clearTimeout(id);
    const root = await render(<TooltipProvider><IconButton label="Main" />{createPortal(<Tip text="Owned hint" focusable mono preformatted><span>Child</span></Tip>, child.body)}</TooltipProvider>);
    const main = required(document.querySelector<HTMLButtonElement>('[aria-label="Main"]'));
    const anchor = required(child.querySelector<HTMLElement>(".tip-anchor"));
    anchor.getBoundingClientRect = () => ({ ...rect(50, 55, 20, 20), x: 50, y: 55, toJSON: () => ({}) });
    await hover(main, true);
    await act(async () => { vi.advanceTimersByTime(500); });
    await hover(main, false);
    await hover(anchor, true);
    expect(child.querySelector('[role="tooltip"]')).toBeNull();
    await act(async () => { vi.advanceTimersByTime(500); });
    const bubble = required(child.querySelector<HTMLElement>('[role="tooltip"]'));
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    expect(observed.includes(anchor)).toBe(true);
    expect(observed.includes(bubble)).toBe(true);
    expect(bubble.classList.contains("shared-tooltip--mono")).toBe(true);
    expect(bubble.classList.contains("shared-tooltip--preformatted")).toBe(true);
    bubble.getBoundingClientRect = () => ({ ...rect(0, 0, 100, 40), x: 0, y: 0, toJSON: () => ({}) });
    await act(async () => { resized?.(); vi.advanceTimersByTime(16); });
    expect(bubble.classList.contains("shared-tooltip--bottom")).toBe(true);
    expect(Number.parseFloat(bubble.style.left)).toBeGreaterThanOrEqual(88);
    viewport.width = 110;
    await act(async () => { viewport.dispatchEvent(new ownerWindow.Event("resize")); vi.advanceTimersByTime(16); });
    expect(bubble.style.maxWidth).toBe("86px");
    await act(async () => root.render(<TooltipProvider><Tip text="Owned hint" focusable><span>Main now</span></Tip></TooltipProvider>));
    expect(bubble.isConnected).toBe(false);
    expect(child.querySelector('[role="tooltip"]')).toBeNull();
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    await act(async () => { resized?.(); vi.advanceTimersByTime(500); });
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    expect(disconnect).toHaveBeenCalled();
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

async function render(element: React.ReactNode): Promise<Root> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(element));
  return root;
}

async function hover(element: HTMLElement, enter: boolean, pointerType = "mouse"): Promise<void> {
  const ownerWindow = required(element.ownerDocument.defaultView);
  const event = new ownerWindow.MouseEvent(enter ? "pointerover" : "pointerout", { bubbles: true, relatedTarget: enter ? null : element.ownerDocument.body });
  Object.defineProperty(event, "pointerType", { value: pointerType });
  await act(async () => element.dispatchEvent(event));
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
