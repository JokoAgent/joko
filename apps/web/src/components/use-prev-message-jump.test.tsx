// @vitest-environment jsdom

import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePreviousUserMessageJump } from "./use-prev-message-jump.js";

const roots: Root[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 1));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
});

afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount(); });
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

describe("previous user message jump", () => {
  it("selects the nearest fully-scrolled prompt, hides while scrolling down, and suppresses its own jump", () => {
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    roots.push(root);
    act(() => root.render(<Harness />));
    const scroller = host.querySelector<HTMLElement>("[data-scroll-root]")!;
    Object.defineProperty(scroller, "getBoundingClientRect", { value: () => rect(0, 200) });
    const messages = [...scroller.querySelectorAll<HTMLElement>("[data-user-msg-id]")];
    Object.defineProperty(messages[0], "getBoundingClientRect", { value: () => rect(-50, -20) });
    Object.defineProperty(messages[1], "getBoundingClientRect", { value: () => rect(20, 60) });
    act(() => {
      window.dispatchEvent(new Event("resize"));
      vi.advanceTimersByTime(2);
    });
    expect(host.querySelector("output")?.textContent).toBe("one");

    act(() => {
      scroller.scrollTop = 20;
      scroller.dispatchEvent(new Event("scroll"));
      vi.advanceTimersByTime(2);
    });
    expect(host.querySelector("output")?.textContent).toBe("");

    act(() => {
      scroller.scrollTop = 10;
      scroller.dispatchEvent(new Event("scroll"));
      vi.advanceTimersByTime(2);
    });
    expect(host.querySelector("output")?.textContent).toBe("one");
    act(() => host.querySelector("button")?.click());
    expect(host.querySelector("output")?.textContent).toBe("");
  });
});

function Harness() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const jump = usePreviousUserMessageJump({ scrollRef, userMessageIds: ["one", "two"], resetKey: "task" });
  return <div ref={scrollRef} data-scroll-root><article data-user-msg-id="one" /><article data-user-msg-id="two" /><output>{jump.displayId ?? ""}</output><button type="button" onClick={jump.suppressAfterClick}>suppress</button></div>;
}

function rect(top: number, bottom: number): DOMRect {
  return { top, bottom, left: 0, right: 100, width: 100, height: bottom - top, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
}
