// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MORPH_CONTENT_RESIZE_EVENT,
  MORPH_POPOVER_DURATION_MS,
  MorphPopover
} from "./MorphPopover.js";

const roots: Root[] = [];
let naturalHeight = 240;
let nextFrame = 0;
let frames = new Map<number, FrameRequestCallback>();
let resizeCallback: ResizeObserverCallback | undefined;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  naturalHeight = 240;
  nextFrame = 0;
  frames = new Map();
  resizeCallback = undefined;
  vi.spyOn(window, "innerWidth", "get").mockReturnValue(1_024);
  vi.spyOn(window, "innerHeight", "get").mockReturnValue(768);
  vi.stubGlobal("matchMedia", vi.fn(() => mediaQuery(false)));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = ++nextFrame;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
  vi.stubGlobal("ResizeObserver", class implements ResizeObserver {
    constructor(callback: ResizeObserverCallback) { resizeCallback = callback; }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function getOffsetHeight(this: HTMLElement) {
    return this.classList.contains("morph-popover__panel") ? naturalHeight : 0;
  });
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function getScrollHeight(this: HTMLElement) {
    return this.classList.contains("morph-popover__content") ? naturalHeight : 0;
  });
});

afterEach(async () => {
  for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("MorphPopover", () => {
  it("morphs from measured trigger geometry, reverses on close, and restores keyboard focus", async () => {
    const clipping = await renderHarness();
    const trigger = required(clipping.querySelector<HTMLButtonElement>("button"));
    const root = required(clipping.querySelector<HTMLElement>(".morph-popover"));
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue(triggerRect());

    await act(async () => { trigger.focus(); trigger.click(); });
    const panel = required(document.body.querySelector<HTMLElement>(".morph-popover__panel"));
    expect(clipping.contains(panel)).toBe(false);
    expect(panel.dataset.state).toBe("closed");

    await act(async () => flushFrames());
    expect(panel.dataset.state).toBe("open");
    expect(trigger.isConnected).toBe(true);

    await act(async () => { vi.advanceTimersByTime(MORPH_POPOVER_DURATION_MS); });
    const firstAction = required(panel.querySelector<HTMLButtonElement>("[data-morph-autofocus]"));
    expect(document.activeElement).toBe(firstAction);

    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(panel.dataset.state).toBe("closed");

    await act(async () => { vi.advanceTimersByTime(MORPH_POPOVER_DURATION_MS + 20); });
    expect(document.body.querySelector(".morph-popover__panel")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("does not unmount a closing panel that is reopened before reverse motion finishes", async () => {
    const clipping = await renderHarness();
    const trigger = required(clipping.querySelector<HTMLButtonElement>("button"));
    const root = required(clipping.querySelector<HTMLElement>(".morph-popover"));
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue(triggerRect());

    await act(async () => trigger.click());
    await act(async () => flushFrames());
    const panel = required(document.body.querySelector<HTMLElement>(".morph-popover__panel"));
    await act(async () => trigger.click());

    await act(async () => trigger.click());
    await act(async () => flushFrames());
    expect(panel.dataset.state).toBe("open");
    await act(async () => { vi.advanceTimersByTime(MORPH_POPOVER_DURATION_MS + 20); });
    expect(document.body.querySelector(".morph-popover__panel")).toBe(panel);
  });

  it("resizes settled content and leaves pointer-driven focus where the pointer put it", async () => {
    const clipping = await renderHarness();
    const trigger = required(clipping.querySelector<HTMLButtonElement>("button"));
    const outside = document.createElement("button");
    outside.textContent = "Outside";
    document.body.append(outside);
    const root = required(clipping.querySelector<HTMLElement>(".morph-popover"));
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue(triggerRect());

    await act(async () => trigger.click());
    await act(async () => flushFrames());
    await act(async () => { vi.advanceTimersByTime(MORPH_POPOVER_DURATION_MS); });
    const panel = required(document.body.querySelector<HTMLElement>(".morph-popover__panel"));
    naturalHeight = 320;
    await act(async () => {
      required(panel.querySelector<HTMLElement>(".morph-popover__content"))
        .dispatchEvent(new Event(MORPH_CONTENT_RESIZE_EVENT));
      resizeCallback?.([], {} as ResizeObserver);
      flushFrames();
    });
    expect(panel.style.height).toBe("320px");

    await act(async () => {
      outside.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      outside.focus();
    });
    await act(async () => { vi.advanceTimersByTime(MORPH_POPOVER_DURATION_MS + 20); });
    expect(document.activeElement).toBe(outside);
  });

  it("switches geometry directly when reduced motion is requested", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => mediaQuery(true)));
    const clipping = await renderHarness();
    const trigger = required(clipping.querySelector<HTMLButtonElement>("button"));
    const root = required(clipping.querySelector<HTMLElement>(".morph-popover"));
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue(triggerRect());

    await act(async () => trigger.click());
    const panel = required(document.body.querySelector<HTMLElement>(".morph-popover__panel"));
    expect(panel.dataset.state).toBe("open");
    await act(async () => { vi.advanceTimersByTime(0); });
    expect(document.activeElement).toBe(panel.querySelector("[data-morph-autofocus]"));

    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await act(async () => { vi.advanceTimersByTime(0); });
    expect(document.body.querySelector(".morph-popover__panel")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("clamps an end-aligned wide panel across both sides of a trigger on a 390px viewport", async () => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(390);
    const clipping = await renderHarness({ align: "end" });
    const trigger = required(clipping.querySelector<HTMLButtonElement>("button"));
    const root = required(clipping.querySelector<HTMLElement>(".morph-popover"));
    vi.spyOn(root, "getBoundingClientRect").mockReturnValue({
      ...triggerRect(),
      x: 100,
      left: 100,
      right: 180
    } as DOMRect);

    await act(async () => trigger.click());
    await act(async () => flushFrames());
    const panel = required(document.body.querySelector<HTMLElement>(".morph-popover__panel"));
    expect(panel.style.width).toBe("300px");
    expect(panel.style.left).toBe("auto");
    expect(panel.style.right).toBe("82px");
    const resolvedLeft = 390 - Number.parseFloat(panel.style.right) - Number.parseFloat(panel.style.width);
    expect(resolvedLeft).toBe(8);
    expect(resolvedLeft + Number.parseFloat(panel.style.width)).toBeLessThanOrEqual(382);
  });
});

async function renderHarness(options: { readonly align?: "start" | "end" } = {}): Promise<HTMLDivElement> {
  const clipping = document.createElement("div");
  clipping.style.overflow = "hidden";
  document.body.append(clipping);
  const root = createRoot(clipping);
  roots.push(root);
  await act(async () => root.render(<Harness align={options.align} />));
  return clipping;
}

function Harness({ align = "start" }: { readonly align?: "start" | "end" }): React.ReactNode {
  const [open, setOpen] = useState(false);
  return <MorphPopover
    open={open}
    onOpenChange={setOpen}
    label="Actions"
    panelWidth={300}
    align={align}
    trigger={<button type="button" onClick={() => setOpen((current) => !current)}>Actions</button>}
  >
    <button type="button" data-morph-autofocus>First action</button>
    <button type="button">Second action</button>
  </MorphPopover>;
}

function flushFrames(): void {
  while (frames.size > 0) {
    const current = [...frames.entries()];
    frames.clear();
    for (const [id, callback] of current) callback(id);
  }
}

function triggerRect(): DOMRect {
  return {
    x: 20,
    y: 500,
    left: 20,
    top: 500,
    right: 100,
    bottom: 532,
    width: 80,
    height: 32,
    toJSON: () => ({})
  } as DOMRect;
}

function mediaQuery(matches: boolean): MediaQueryList {
  return {
    matches,
    media: "(prefers-reduced-motion: reduce)",
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true
  };
}

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected test value");
  return value;
}
