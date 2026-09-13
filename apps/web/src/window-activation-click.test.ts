// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createActivationClickState,
  installActivationClickGuard,
  readActivationClickPreference,
  subscribeActivationClickPreference,
  writeActivationClickPreference
} from "./window-activation-click.js";

afterEach(() => window.localStorage.clear());

describe("activation-click guard", () => {
  it("swallows the complete first primary-button gesture after mouse activation", () => {
    const state = createActivationClickState();
    expect(state.handle("blur", 0)).toBe(false);
    expect(state.handle("focus", 1)).toBe(false);
    expect(state.handle("pointerdown", 2)).toBe(true);
    expect(state.handle("mousedown", 2)).toBe(true);
    expect(state.handle("pointerup", 500)).toBe(true);
    expect(state.handle("mouseup", 501)).toBe(true);
    expect(state.handle("click", 502)).toBe(true);
    expect(state.handle("mousedown", 510)).toBe(false);
  });

  it("does not arm a delayed click after keyboard focus", () => {
    const state = createActivationClickState();
    state.handle("blur", 0);
    state.handle("focus", 1);
    expect(state.handle("mousedown", 122)).toBe(false);
  });

  it("uses capture-phase DOM cancellation only on Windows, while enabled, for the left button", () => {
    let now = 0;
    let enabled = true;
    const pageHandler = vi.fn();
    window.addEventListener("mousedown", pageHandler);
    const dispose = installActivationClickGuard({
      window,
      platform: "win32",
      now: () => now,
      isEnabled: () => enabled
    });
    window.dispatchEvent(new Event("blur"));
    now = 1;
    window.dispatchEvent(new Event("focus"));
    now = 2;
    const activation = new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true });
    expect(window.dispatchEvent(activation)).toBe(false);
    expect(activation.defaultPrevented).toBe(true);
    expect(pageHandler).not.toHaveBeenCalled();

    const rightClick = new MouseEvent("mousedown", { button: 2, bubbles: true, cancelable: true });
    window.dispatchEvent(rightClick);
    expect(pageHandler).toHaveBeenCalledTimes(1);

    enabled = false;
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true, cancelable: true }));
    expect(pageHandler).toHaveBeenCalledTimes(2);
    dispose();
    window.removeEventListener("mousedown", pageHandler);
  });

  it("defaults off and synchronously notifies renderer listeners", () => {
    expect(readActivationClickPreference()).toBe(false);
    const listener = vi.fn();
    const unsubscribe = subscribeActivationClickPreference(listener);
    writeActivationClickPreference(true);
    expect(readActivationClickPreference()).toBe(true);
    expect(listener).toHaveBeenLastCalledWith(true);
    unsubscribe();
  });
});
