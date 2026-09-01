// @vitest-environment jsdom

import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserChrome, type BrowserChromeHandle, type BrowserChromeProps } from "./BrowserChrome.js";
import type { Translator } from "./types.js";
import { TOOLTIP_DELAY_MS } from "./ui.js";

const roots: Root[] = [];
const t: Translator = (key) => key;

async function renderChrome(overrides: Partial<BrowserChromeProps> = {}) {
  const onNavigate = vi.fn();
  const onCommand = vi.fn();
  const onCopyLink = vi.fn();
  const onOverlayOpenChange = vi.fn();
  const ref = createRef<BrowserChromeHandle>();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(<BrowserChrome
    ref={ref}
    url="https://example.test/docs"
    enabled
    loading={false}
    canGoBack={false}
    canGoForward={false}
    externalUrl="https://example.test/docs"
    copied={false}
    t={t}
    onNavigate={onNavigate}
    onCommand={onCommand}
    onCapture={vi.fn()}
    onCopyLink={onCopyLink}
    onOverlayOpenChange={onOverlayOpenChange}
    {...overrides}
  />));
  return { container, onNavigate, onCommand, onCopyLink, onOverlayOpenChange, ref };
}

describe("BrowserChrome", () => {
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(window, "requestAnimationFrame", {
      configurable: true,
      writable: true,
      value: (callback: FrameRequestCallback) => {
        window.setTimeout(() => callback(0), 0);
        return 1;
      }
    });
  });

  afterEach(async () => {
    for (const root of roots.splice(0).reverse()) await act(async () => root.unmount());
    document.body.replaceChildren();
    vi.useRealTimers();
    Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    vi.restoreAllMocks();
  });

  it("exposes a busy stop action while loading", async () => {
    const { container, onCommand } = await renderChrome({ loading: true });
    const stop = required(container.querySelector<HTMLButtonElement>('[aria-label="browser.stop"]'));

    expect(stop.getAttribute("aria-busy")).toBe("true");
    await act(async () => stop.click());
    expect(onCommand).toHaveBeenCalledWith("stop");
  });

  it("exposes unavailable navigation as focusable explained disabled controls", async () => {
    vi.useFakeTimers();
    const { container } = await renderChrome();
    const back = required(container.querySelector<HTMLElement>('.tip-anchor--disabled[aria-label="browser.goBackUnavailable: browser.goBackUnavailable"]'));
    const forward = required(container.querySelector<HTMLElement>('.tip-anchor--disabled[aria-label="browser.goForwardUnavailable: browser.goForwardUnavailable"]'));
    expect(back.tabIndex).toBe(0);
    expect(forward.tabIndex).toBe(0);
    expect(back.querySelector("button")?.hasAttribute("title")).toBe(false);
    await act(async () => { back.focus(); vi.advanceTimersByTime(TOOLTIP_DELAY_MS); });
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe("browser.goBackUnavailable");
    vi.useRealTimers();
  });

  it("submits Ctrl+Enter once, suppresses the following blur, and describes active comment mode", async () => {
    const { container, onNavigate } = await renderChrome({ onComment: vi.fn(), commentActive: true });
    expect(container.querySelector('[aria-label="browser.exitCommentMode"]')).not.toBeNull();
    await act(async () => required(container.querySelector<HTMLButtonElement>('.browser-chrome__omnibox > button')).click());
    const input = required(container.querySelector<HTMLInputElement>('[aria-label="browser.address"]'));
    await act(async () => {
      input.value = "openai";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
      input.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    });

    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith("https://www.openai.com");
  });

  it("supports reference menu keyboard navigation and restores trigger focus on Escape", async () => {
    const { container, onOverlayOpenChange } = await renderChrome();
    const trigger = required(container.querySelector<HTMLButtonElement>('[aria-label="browser.moreTools"]'));
    expect(trigger.hasAttribute("title")).toBe(false);

    await act(async () => {
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
    const items = [...container.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(document.activeElement).toBe(items[0]);

    await act(async () => items[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(document.activeElement).toBe(items[1]);
    await act(async () => items[1]?.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
    expect(document.activeElement).toBe(items[0]);
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(onOverlayOpenChange.mock.calls).toEqual([[true], [false]]);
  });
});

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Expected test element");
  return value;
}
