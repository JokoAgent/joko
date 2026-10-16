// @vitest-environment jsdom

import { Virtualizer, observeElementOffset, observeElementRect, elementScroll } from "@tanstack/react-virtual";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeActiveElementOffset } from "./subagent-virtual-scroll.js";

afterEach(() => vi.useRealTimers());

describe("subagent virtual scroll observation", () => {
  it("retires a queued scroll reset when its viewport is detached", async () => {
    vi.useFakeTimers();
    const element = document.createElement("div");
    const instance = virtualizer(element);
    const changed = vi.fn();
    const detach = observeActiveElementOffset(instance, changed)!;
    element.scrollTop = 120;
    element.dispatchEvent(new Event("scroll"));
    expect(changed).toHaveBeenLastCalledWith(120, true);
    const callsBeforeDetach = changed.mock.calls.length;

    detach();
    await vi.advanceTimersByTimeAsync(150);
    element.scrollTop = 240;
    element.dispatchEvent(new Event("scroll"));
    expect(changed).toHaveBeenCalledTimes(callsBeforeDetach);
  });

  it("keeps the live observer's offset, RTL handling and original reset delay", async () => {
    vi.useFakeTimers();
    const element = document.createElement("div");
    const instance = virtualizer(element, true);
    const changed = vi.fn();
    const detach = observeActiveElementOffset(instance, changed)!;
    element.scrollLeft = -75;
    element.dispatchEvent(new Event("scroll"));
    expect(changed).toHaveBeenLastCalledWith(75, true);
    await vi.advanceTimersByTimeAsync(149);
    expect(changed).toHaveBeenLastCalledWith(75, true);
    await vi.advanceTimersByTimeAsync(1);
    expect(changed).toHaveBeenLastCalledWith(75, false);
    detach();
  });
});

function virtualizer(element: HTMLDivElement, horizontal = false): Virtualizer<HTMLDivElement, Element> {
  const instance = new Virtualizer<HTMLDivElement, Element>({
    count: 1, getScrollElement: () => element, estimateSize: () => 50,
    observeElementRect, observeElementOffset, scrollToFn: elementScroll,
    horizontal, isRtl: horizontal, isScrollingResetDelay: 150
  });
  instance.scrollElement = element;
  instance.targetWindow = window;
  return instance;
}
