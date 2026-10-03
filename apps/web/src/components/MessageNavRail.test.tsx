// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { translate } from "../i18n.js";
import type { Translator } from "./types.js";
import { MessageNavRail } from "./MessageNavRail.js";
import type { MessageNavEntry } from "./message-nav-rail.js";

const t: Translator = (key, values) => translate("en", key, values);

interface MountedRail {
  readonly content: HTMLDivElement;
  readonly entries: readonly MessageNavEntry[];
  readonly host: HTMLDivElement;
  readonly reactRoot: Root;
  readonly render: (resetKey: string) => void;
  readonly scroll: HTMLDivElement;
}

describe("MessageNavRail mounted behavior", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 1));
    vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
    vi.stubGlobal("ResizeObserver", class {
      observe(): void {}
      disconnect(): void {}
    });
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("renders the active prompt with accessible labels and the shared tooltip delay", () => {
    const mounted = mountRail({ tops: [-100, 20, 300, 650, 900], mountedIndexes: [1, 2, 3] });
    flushMeasure();

    const ticks = tickButtons(mounted.host);
    expect(ticks).toHaveLength(5);
    expect(ticks[1]!.getAttribute("aria-current")).toBe("true");
    expect(ticks[2]!.getAttribute("aria-label")).toBe("Jump to prompt 3: prompt 3");

    act(() => ticks[2]!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    act(() => vi.advanceTimersByTime(149));
    expect(mounted.host.querySelector("[role=tooltip]")).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(mounted.host.querySelector("[role=tooltip]")?.textContent).toContain("prompt 3");

    act(() => {
      ticks[2]!.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: ticks[3] }));
      ticks[3]!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: ticks[2] }));
    });
    expect(mounted.host.querySelector("[role=tooltip]")?.textContent).toContain("prompt 4");

    unmountRail(mounted);
  });

  it("releases pointer capture on cancellation without swallowing the next click", () => {
    const onJump = vi.fn();
    const mounted = mountRail({ tops: [0, 100, 200, 300, 400], onJump });
    flushMeasure();
    const ticks = tickButtons(mounted.host);
    ticks.forEach((tick, index) => setRect(tick, { top: index * 9, height: 9, bottom: index * 9 + 9 }));
    const release = vi.fn();
    Object.assign(ticks[1]!, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: () => true,
      releasePointerCapture: release
    });

    act(() => ticks[1]!.dispatchEvent(pointerEvent("pointerdown", { pointerId: 7, clientY: 13 })));
    act(() => ticks[1]!.dispatchEvent(pointerEvent("pointermove", { pointerId: 7, clientY: 31 })));
    act(() => ticks[1]!.dispatchEvent(pointerEvent("pointercancel", { pointerId: 7, clientY: 31 })));
    expect(release).toHaveBeenCalledWith(7);
    const jumpsBeforeClick = onJump.mock.calls.length;
    act(() => ticks[1]!.click());
    expect(onJump).toHaveBeenCalledTimes(jumpsBeforeClick + 1);
    expect(onJump).toHaveBeenLastCalledWith("u2");

    unmountRail(mounted);
  });

  it("forwards wheel intent to the timeline root and scrolls it", () => {
    const onWheelIntent = vi.fn();
    const mounted = mountRail({ tops: [0, 100, 200, 300, 400], onWheelIntent });
    flushMeasure();
    const received: WheelEvent[] = [];
    mounted.scroll.addEventListener("wheel", (event) => received.push(event));
    const scrollBy = vi.fn();
    mounted.scroll.scrollBy = scrollBy;

    const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaX: 3, deltaY: 48 });
    act(() => tickButtons(mounted.host)[2]!.dispatchEvent(wheel));
    expect(wheel.defaultPrevented).toBe(false);
    expect(received.some((event) => event.deltaX === 3 && event.deltaY === 48)).toBe(true);
    expect(onWheelIntent).toHaveBeenCalledWith(48, 3);
    expect(scrollBy).toHaveBeenCalledWith({ top: 48, left: 3, behavior: "auto" });

    unmountRail(mounted);
  });

  it("uses a non-clickable ellipsis placeholder when older ticks do not fit", () => {
    const mounted = mountRail({
      height: 94,
      entries: Array.from({ length: 20 }, (_, index) => ({ id: `u${index + 1}`, preview: `prompt ${index + 1}` })),
      tops: Array.from({ length: 20 }, (_, index) => index * 20)
    });
    flushMeasure();
    const hidden = mounted.host.querySelector<HTMLElement>(".message-nav-rail__hidden");
    expect(hidden?.tagName).toBe("DIV");
    expect(hidden?.querySelector("button")).toBeNull();
    expect(hidden?.textContent).toBe("⋯");
    expect(tickButtons(mounted.host)).toHaveLength(9);

    act(() => hidden!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
    act(() => vi.advanceTimersByTime(150));
    expect(hidden?.querySelector("[role=tooltip]")?.textContent).toBe("11 earlier questions");

    unmountRail(mounted);
  });

  it("reports coverage only while every eligible tick is visible", () => {
    const truncatedCoverage = vi.fn();
    const truncated = mountRail({
      height: 94,
      entries: Array.from({ length: 20 }, (_, index) => ({ id: `u${index + 1}`, preview: `prompt ${index + 1}` })),
      tops: Array.from({ length: 20 }, (_, index) => index * 20),
      onCoverageChange: truncatedCoverage
    });
    flushMeasure();
    expect(truncated.host.querySelector(".message-nav-rail__hidden")).not.toBeNull();
    expect(truncatedCoverage).toHaveBeenLastCalledWith(false);
    unmountRail(truncated);

    const completeCoverage = vi.fn();
    const complete = mountRail({
      tops: [0, 100, 200, 300, 400],
      onCoverageChange: completeCoverage
    });
    flushMeasure();
    expect(complete.host.querySelector(".message-nav-rail__hidden")).toBeNull();
    expect(tickButtons(complete.host)).toHaveLength(complete.entries.length);
    expect(completeCoverage).toHaveBeenLastCalledWith(true);
    unmountRail(complete);
  });

  it("retires captured gestures and callbacks on owner reset, pagehide and unmount, then admits fresh page interactions", () => {
    const timerSpy = vi.spyOn(window, "setTimeout");
    const onJump = vi.fn();
    const mounted = mountRail({ tops: [0, 100, 200, 300, 400], onJump });
    flushMeasure();
    let ticks = tickButtons(mounted.host);
    act(() => {
      window.dispatchEvent(new Event("pageshow"));
      ticks[4]!.click();
      mounted.scroll.dispatchEvent(new Event("touchstart"));
    });
    expect(ticks[0]!.getAttribute("aria-current")).toBe("true");
    const release = vi.fn();
    let captured = false;
    Object.assign(ticks[1]!, {
      setPointerCapture: () => { captured = true; },
      hasPointerCapture: () => captured,
      releasePointerCapture: (id: number) => { captured = false; release(id); }
    });
    act(() => {
      ticks[4]!.click();
      ticks[2]!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      ticks[1]!.dispatchEvent(pointerEvent("pointerdown", { pointerId: 7, clientY: 13 }));
    });
    const oldOwnerCallbacks = timerSpy.mock.calls.map(([callback]) => callback);
    mounted.render("session-2");
    flushMeasure();
    expect(release).toHaveBeenLastCalledWith(7);
    expect(mounted.host.querySelector("[role=tooltip]")).toBeNull();
    ticks = tickButtons(mounted.host);
    expect(ticks[0]!.getAttribute("aria-current")).toBe("true");
    act(() => {
      ticks[3]!.click();
      ticks[3]!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      for (const callback of oldOwnerCallbacks) if (typeof callback === "function") callback();
    });
    expect(ticks[3]!.getAttribute("aria-current")).toBe("true");
    act(() => vi.advanceTimersByTime(149));
    expect(mounted.host.querySelector("[role=tooltip]")).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(mounted.host.querySelector("[role=tooltip]")?.textContent).toContain("prompt 4");

    act(() => ticks[1]!.dispatchEvent(pointerEvent("pointerdown", { pointerId: 8, clientY: 13 })));
    const hiddenPageCallbacks = timerSpy.mock.calls.map(([callback]) => callback);
    act(() => window.dispatchEvent(new Event("pagehide")));
    expect(release).toHaveBeenLastCalledWith(8);
    expect(mounted.host.querySelector("[role=tooltip]")).toBeNull();
    expect(mounted.host.querySelector("[aria-current]")).toBeNull();
    const jumpsBeforeHiddenClick = onJump.mock.calls.length;
    act(() => ticks[4]!.click());
    expect(onJump).toHaveBeenCalledTimes(jumpsBeforeHiddenClick);

    act(() => window.dispatchEvent(new Event("pageshow")));
    flushMeasure();
    act(() => {
      ticks[2]!.click();
      ticks[2]!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      for (const callback of hiddenPageCallbacks) if (typeof callback === "function") callback();
    });
    expect(ticks[2]!.getAttribute("aria-current")).toBe("true");
    act(() => vi.advanceTimersByTime(149));
    expect(mounted.host.querySelector("[role=tooltip]")).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(mounted.host.querySelector("[role=tooltip]")?.textContent).toContain("prompt 3");
    act(() => {
      ticks[2]!.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
      vi.advanceTimersByTime(2_000);
    });
    expect(mounted.host.querySelector(".message-nav-rail.is-awake")).toBeNull();
    act(() => vi.advanceTimersByTime(1_000));
    expect(mounted.host.querySelector("[aria-current]")?.getAttribute("aria-label")).toContain("prompt 1");

    act(() => ticks[1]!.dispatchEvent(pointerEvent("pointerdown", { pointerId: 9, clientY: 13 })));
    unmountRail(mounted);
    expect(release).toHaveBeenLastCalledWith(9);
    expect(vi.getTimerCount()).toBe(0);
    timerSpy.mockRestore();
  });
});

function mountRail({
  entries = Array.from({ length: 5 }, (_, index) => ({ id: `u${index + 1}`, preview: `prompt ${index + 1}` })),
  height = 700,
  mountedIndexes,
  onCoverageChange,
  onJump = vi.fn(),
  onWheelIntent,
  tops
}: {
  readonly entries?: readonly MessageNavEntry[];
  readonly height?: number;
  readonly mountedIndexes?: readonly number[];
  readonly onCoverageChange?: (covered: boolean) => void;
  readonly onJump?: (id: string) => void;
  readonly onWheelIntent?: (deltaY: number, deltaX: number) => void;
  readonly tops: readonly number[];
}): MountedRail {
  const scroll = document.createElement("div");
  const content = document.createElement("div");
  const host = document.createElement("div");
  setRect(scroll, { left: 0, top: 0, right: 1_000, bottom: height, width: 1_000, height });
  setRect(content, { left: 50, top: 0, right: 950, bottom: height, width: 900, height });
  entries.forEach((entry, index) => {
    if (mountedIndexes !== undefined && !mountedIndexes.includes(index)) return;
    const anchor = document.createElement("article");
    anchor.dataset.messageClientId = entry.id;
    const top = tops[index] ?? index * 100;
    setRect(anchor, { top, bottom: top + 40, height: 40 });
    content.append(anchor);
  });
  scroll.append(content, host);
  document.body.append(scroll);
  const reactRoot = createRoot(host);
  const render = (resetKey: string): void => act(() => reactRoot.render(<MessageNavRail
    entries={entries}
    scrollRef={{ current: scroll }}
    contentRef={{ current: content }}
    bottomOffset={0}
    resetKey={resetKey}
    estimateEntryTop={(id) => tops[entries.findIndex((entry) => entry.id === id)] ?? null}
    onCoverageChange={onCoverageChange}
    onWheelIntent={onWheelIntent}
    onJump={onJump}
    t={t}
  />));
  render("session-1");
  return { content, entries, host, reactRoot, render, scroll };
}

function flushMeasure(): void {
  act(() => vi.advanceTimersByTime(2));
}

function unmountRail(mounted: MountedRail): void {
  act(() => mounted.reactRoot.unmount());
}

function tickButtons(host: HTMLElement): HTMLButtonElement[] {
  return Array.from(host.querySelectorAll<HTMLButtonElement>("[data-message-nav-index]"));
}

function pointerEvent(type: string, init: { readonly pointerId: number; readonly clientY: number }): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientY: init.clientY });
  Object.defineProperty(event, "pointerId", { value: init.pointerId });
  return event;
}

function setRect(element: Element, partial: Partial<DOMRect>): void {
  const rect = {
    x: partial.left ?? 0,
    y: partial.top ?? 0,
    left: partial.left ?? 0,
    top: partial.top ?? 0,
    right: partial.right ?? partial.left ?? 0,
    bottom: partial.bottom ?? partial.top ?? 0,
    width: partial.width ?? 0,
    height: partial.height ?? 0,
    toJSON: () => ({})
  } satisfies DOMRect;
  element.getBoundingClientRect = () => rect;
}
