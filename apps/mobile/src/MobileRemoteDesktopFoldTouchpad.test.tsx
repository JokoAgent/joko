// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileRemoteDesktopFoldTouchpad, type MobileRemoteDesktopTouchpadController } from "./MobileRemoteDesktopFoldTouchpad";
import { MOBILE_SUPPORTED_LOCALES } from "./mobile-locale-preference";
import { mobileRemoteDesktopCopy } from "./remote-desktop-presentation";

type Touch = { nativeEvent: { identifier: number; pageX: number; pageY: number } };
type Handlers = { onStartShouldSetResponder(): boolean; onResponderGrant(event: Touch): void;
  onResponderMove(event: Touch): void; onResponderRelease(event: Touch): void; onResponderTerminate(event: Touch): void };
const native = vi.hoisted(() => ({ handlers: undefined as Handlers | undefined }));
vi.mock("react-native", async () => {
  const React = await import("react");
  return {
    View: ({ children, testID, accessibilityLabel, accessibilityHint, accessibilityState, ...props }:
    Record<string, unknown> & { children?: React.ReactNode; accessibilityState?: { disabled: boolean } }) => {
      native.handlers = props as unknown as Handlers;
      return React.createElement("div", { "data-testid": testID, "aria-label": accessibilityLabel,
        "data-hint": accessibilityHint, "aria-disabled": accessibilityState?.disabled }, children);
    },
    Text: ({ children }: { children: React.ReactNode }) => React.createElement("span", {}, children),
    StyleSheet: { hairlineWidth: 1, create: <T,>(value: T) => value }
  };
});
const colors = { background: "#fafafa", surface: "#fff", ink: "#111", muted: "#666", border: "#ddd", accent: "#f90", negative: "#b00" };
let root: Root, host: HTMLDivElement;
function controller(): MobileRemoteDesktopTouchpadController {
  let id = 0;
  return { beginTouchpad: vi.fn(() => ({ id: ++id, occurrence: 1 })), moveTouchpad: vi.fn(), endTouchpad: vi.fn() };
}
function event(x = 100, y = 200, identifier = 7): Touch { return { nativeEvent: { identifier, pageX: x, pageY: y } }; }
function render(owner: MobileRemoteDesktopTouchpadController, enabled = true,
  locale: (typeof MOBILE_SUPPORTED_LOCALES)[number] = "en"): void {
  act(() => root.render(createElement(MobileRemoteDesktopFoldTouchpad, { controller: owner, enabled, locale, colors })));
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.useFakeTimers();
  host = document.createElement("div"); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("actual divided-window relative touchpad", () => {
  it.each(MOBILE_SUPPORTED_LOCALES)("uses the localized pointer label, hint and disabled state in %s", locale => {
    const owner = controller(); render(owner, false, locale);
    const pad = host.querySelector('[data-testid="remoteDesktop.foldTouchpad"]')!, copy = mobileRemoteDesktopCopy(locale);
    expect(pad.getAttribute("aria-label")).toBe(copy.pointer); expect(pad.getAttribute("data-hint")).toBe(copy.pointerHint);
    expect(pad.getAttribute("aria-disabled")).toBe("true"); expect(native.handlers!.onStartShouldSetResponder()).toBe(false);
    native.handlers!.onResponderGrant(event()); expect(owner.beginTouchpad).not.toHaveBeenCalled();
  });

  it("forwards only relative deltas through the original captured grant", () => {
    const owner = controller(); render(owner); const handlers = native.handlers!;
    act(() => { handlers.onResponderGrant(event()); handlers.onResponderGrant(event(200, 300, 8));
      handlers.onResponderMove(event(110, 195)); handlers.onResponderMove(event(106, 203)); handlers.onResponderRelease(event(106, 203)); });
    expect(owner.beginTouchpad).toHaveBeenCalledTimes(1);
    expect(owner.moveTouchpad).toHaveBeenNthCalledWith(1, { id: 1, occurrence: 1 }, 10, -5);
    expect(owner.moveTouchpad).toHaveBeenNthCalledWith(2, { id: 1, occurrence: 1 }, -4, 8);
    expect(owner.endTouchpad).toHaveBeenCalledExactlyOnceWith({ id: 1, occurrence: 1 }, false, false);
  });

  it.each([
    { distance: 7, elapsed: 399, tap: true }, { distance: 8, elapsed: 1, tap: false },
    { distance: 0, elapsed: 400, tap: false }
  ])("requires travel <8 and duration <400 for a tap: $distance/$elapsed", ({ distance, elapsed, tap }) => {
    const owner = controller(); render(owner); const handlers = native.handlers!;
    act(() => { handlers.onResponderGrant(event()); handlers.onResponderMove(event(100 + distance, 200));
      vi.advanceTimersByTime(elapsed); handlers.onResponderRelease(event(100 + distance, 200)); });
    expect(owner.endTouchpad).toHaveBeenCalledExactlyOnceWith({ id: 1, occurrence: 1 }, tap, false);
  });

  it("counts total absolute travel, so returning to the starting point cannot turn movement into a tap", () => {
    const owner = controller(); render(owner); const handlers = native.handlers!;
    act(() => { handlers.onResponderGrant(event()); handlers.onResponderMove(event(106));
      handlers.onResponderMove(event()); handlers.onResponderRelease(event()); });
    expect(owner.endTouchpad).toHaveBeenCalledExactlyOnceWith({ id: 1, occurrence: 1 }, false, false);
  });

  it.each(["terminate", "disable", "unmount"] as const)("releases the captured grant on %s without adding a click", action => {
    const owner = controller(); render(owner); const handlers = native.handlers!;
    act(() => handlers.onResponderGrant(event()));
    if (action === "terminate") act(() => handlers.onResponderTerminate(event()));
    else if (action === "disable") render(owner, false);
    else act(() => root.render(null));
    act(() => { handlers.onResponderRelease(event()); handlers.onResponderMove(event(110)); });
    expect(owner.endTouchpad).toHaveBeenCalledExactlyOnceWith({ id: 1, occurrence: 1 }, false, true);
    expect(owner.moveTouchpad).not.toHaveBeenCalled();
  });

  it("ignores another finger and retired owner callbacks after a replacement gesture begins", () => {
    const original = controller(), replacement = controller(); render(original); const old = native.handlers!;
    act(() => { old.onResponderGrant(event()); old.onResponderMove(event(120, 200, 8)); old.onResponderRelease(event(120, 200, 8)); });
    expect(original.moveTouchpad).not.toHaveBeenCalled(); expect(original.endTouchpad).not.toHaveBeenCalled();
    render(replacement); const current = native.handlers!;
    expect(original.endTouchpad).toHaveBeenCalledExactlyOnceWith({ id: 1, occurrence: 1 }, false, true);
    act(() => { current.onResponderGrant(event()); old.onResponderMove(event(140)); old.onResponderRelease(event()); old.onResponderTerminate(event()); });
    expect(replacement.moveTouchpad).not.toHaveBeenCalled(); expect(replacement.endTouchpad).not.toHaveBeenCalled();
    act(() => current.onResponderRelease(event()));
    expect(replacement.endTouchpad).toHaveBeenCalledExactlyOnceWith({ id: 1, occurrence: 1 }, true, false);
  });

  it("rejects late callbacks across disabling and rejects unavailable grants or nonfinite motion", () => {
    const owner = controller(); render(owner); const old = native.handlers!;
    act(() => old.onResponderGrant(event())); render(owner, false); render(owner, true); const current = native.handlers!;
    act(() => { current.onResponderGrant(event()); old.onResponderRelease(event()); current.onResponderMove(event(Number.NaN)); });
    expect(owner.endTouchpad).toHaveBeenCalledTimes(1); expect(owner.moveTouchpad).not.toHaveBeenCalled();
    act(() => current.onResponderTerminate(event()));
    vi.mocked(owner.beginTouchpad).mockReturnValue(undefined);
    act(() => { current.onResponderGrant(event(Number.NaN)); current.onResponderGrant(event()); current.onResponderRelease(event()); });
    expect(owner.endTouchpad).toHaveBeenCalledTimes(2);
  });
});
