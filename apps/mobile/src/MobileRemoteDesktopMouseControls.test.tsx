// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileRemoteDesktopMouseControls, type MobileRemoteDesktopMouseController } from "./MobileRemoteDesktopMouseControls";
import { MOBILE_SUPPORTED_LOCALES, type MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileRemoteDesktopCopy } from "./remote-desktop-presentation";
import type { MobileRemoteDesktopMouseControl } from "./remote-desktop-controller";

const platform = vi.hoisted(() => ({ OS: "ios" }));
vi.mock("react-native", async () => {
  const React = await import("react");
  const View = ({ children, accessibilityLabel, accessibilityRole, accessibilityState, testID, style,
    onTouchStart, onTouchMove, onTouchEnd, onTouchCancel, onAccessibilityAction }: Record<string, unknown> & {
      children?: React.ReactNode; accessibilityState?: { selected: boolean }; style?: object | object[];
    }) => {
    const event = (handler: unknown) => handler ? (e: React.MouseEvent) =>
      (handler as (value: object) => void)({ nativeEvent: { pageY: e.clientY,
        identifier: (e.nativeEvent as MouseEvent & { touchIdentifier?: string }).touchIdentifier ?? "touch-1" } }) : undefined;
    const flat = Array.isArray(style) ? Object.assign({}, ...style) : style;
    return React.createElement("div", { role: accessibilityRole, "aria-label": accessibilityLabel,
      "aria-selected": accessibilityState?.selected, "data-testid": testID, "data-height": flat?.height,
      "data-bottom": flat?.bottom, onMouseDown: event(onTouchStart), onMouseMove: event(onTouchMove),
      onMouseUp: event(onTouchEnd), onMouseOut: event(onTouchCancel), onClick: () => {
        (onAccessibilityAction as ((value: object) => void) | undefined)?.({ nativeEvent: { actionName: "activate" } });
      } }, children);
  };
  return { View, Platform: platform, StyleSheet: { absoluteFill: {}, hairlineWidth: 1, create: <T,>(value: T) => value } };
});
vi.mock("react-native-svg", async () => {
  const React = await import("react");
  const element = (tag: string) => ({ children, ...props }: Record<string, unknown> & { children?: React.ReactNode }) =>
    React.createElement(tag, props, children);
  return { default: element("svg"), Path: element("path"), Rect: element("rect") };
});
const colors = { background: "#fafafa", surface: "#fff", ink: "#111", muted: "#666", border: "#ddd", accent: "#f90", negative: "#b00" };
const roots: Root[] = [];
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); });
afterEach(() => { for (const root of roots.splice(0)) act(() => root.unmount()); platform.OS = "ios"; vi.unstubAllGlobals(); });
function controller(): MobileRemoteDesktopMouseController {
  let id = 0;
  return { beginMouseControl: vi.fn(() => ({ id: ++id, occurrence: 1 })), moveMouseControl: vi.fn(),
    endMouseControl: vi.fn(), clickMouseControl: vi.fn() };
}
function mount(locale: MobileSupportedLocale = "en", owner = controller()) {
  const host = document.createElement("div"), root = createRoot(host); roots.push(root);
  const render = (current = owner, visible = true, compact = false) => act(() => root.render(visible && MobileRemoteDesktopMouseControls
    ? createElement(MobileRemoteDesktopMouseControls, { controller: current, colors, locale, bottom: 16, right: 12, compact }) : null));
  render(); return { host, owner, render };
}
function control(host: HTMLElement, name: MobileRemoteDesktopMouseControl): HTMLElement {
  const value = host.querySelector<HTMLElement>(`[data-testid="remoteDesktop.mouse-${name}"]`);
  if (!value) throw new Error(`Missing mouse control ${name}`); return value;
}
function touch(host: HTMLElement, name: MobileRemoteDesktopMouseControl,
  event: "mousedown" | "mousemove" | "mouseup" | "mouseleave", y = 0, identifier = "touch-1") {
  const value = new MouseEvent(event === "mouseleave" ? "mouseout" : event, { bubbles: true, clientY: y });
  Object.defineProperty(value, "touchIdentifier", { value: identifier });
  act(() => control(host, name).dispatchEvent(value));
}

describe("Mobile actual iOS mouse controls", () => {
  it.each(MOBILE_SUPPORTED_LOCALES)("renders three accessible palette controls in %s", locale => {
    const view = mount(locale), copy = mobileRemoteDesktopCopy(locale);
    expect(control(view.host, "left").getAttribute("aria-label")).toBe(copy.leftMouseButton);
    expect(control(view.host, "right").getAttribute("aria-label")).toBe(copy.rightMouseButton);
    expect(control(view.host, "wheel").getAttribute("aria-label")).toBe(copy.mouseWheel);
    expect(control(view.host, "wheel").getAttribute("data-height")).toBe("120");
    view.render(view.owner, true, true); expect(control(view.host, "wheel").getAttribute("data-bottom")).toBe("12");
  });
  it("keeps each held button paired with its original grant and does not click again on touch up", () => {
    const view = mount(); touch(view.host, "left", "mousedown", 110); touch(view.host, "right", "mousedown", 120);
    expect(view.owner.beginMouseControl).toHaveBeenNthCalledWith(1, "left", 110);
    expect(view.owner.beginMouseControl).toHaveBeenNthCalledWith(2, "right", 120);
    touch(view.host, "left", "mousemove", 140); touch(view.host, "left", "mouseup");
    expect(view.owner.moveMouseControl).toHaveBeenCalledWith({ id: 1, occurrence: 1 }, 140);
    expect(view.owner.endMouseControl).toHaveBeenCalledWith({ id: 1, occurrence: 1 }, false);
    touch(view.host, "right", "mouseleave");
    expect(view.owner.endMouseControl).toHaveBeenCalledWith({ id: 2, occurrence: 1 }, true);
    expect(view.owner.clickMouseControl).not.toHaveBeenCalled();
    touch(view.host, "left", "mouseup"); expect(view.owner.endMouseControl).toHaveBeenCalledTimes(2);
  });
  it("captures wheel down coordinates, forwards displacement and cancels a hidden original grant", () => {
    const view = mount(); touch(view.host, "wheel", "mousedown", 100); touch(view.host, "wheel", "mousemove", 124);
    expect(control(view.host, "wheel").getAttribute("aria-selected")).toBe("true");
    expect(view.owner.moveMouseControl).toHaveBeenCalledWith({ id: 1, occurrence: 1 }, 124);
    view.render(view.owner, false);
    expect(view.owner.endMouseControl).toHaveBeenCalledExactlyOnceWith({ id: 1, occurrence: 1 }, true);
  });
  it("retires a captured owner before replacement and never sends a late end to the new controller", () => {
    const original = controller(), replacement = controller(), view = mount("en", original);
    touch(view.host, "left", "mousedown", 10); view.render(replacement);
    expect(original.endMouseControl).toHaveBeenCalledExactlyOnceWith({ id: 1, occurrence: 1 }, true);
    touch(view.host, "left", "mouseup"); touch(view.host, "left", "mousemove", 30);
    expect(replacement.endMouseControl).not.toHaveBeenCalled(); expect(replacement.moveMouseControl).not.toHaveBeenCalled();
    touch(view.host, "left", "mousedown", 40); touch(view.host, "left", "mouseup");
    expect(replacement.endMouseControl).toHaveBeenCalledExactlyOnceWith({ id: 1, occurrence: 1 }, false);
  });
  it("does not let a late touch identifier move or release a newer press on the same control", () => {
    const view = mount(); touch(view.host, "left", "mousedown", 10, "old"); touch(view.host, "left", "mouseup", 10, "old");
    touch(view.host, "left", "mousedown", 20, "current");
    touch(view.host, "left", "mousemove", 30, "old"); touch(view.host, "left", "mouseup", 30, "old");
    touch(view.host, "left", "mouseleave", 30, "old");
    expect(view.owner.moveMouseControl).not.toHaveBeenCalled(); expect(view.owner.endMouseControl).toHaveBeenCalledTimes(1);
    expect(control(view.host, "left").getAttribute("aria-selected")).toBe("true");
    touch(view.host, "left", "mouseup", 20, "current");
    expect(view.owner.endMouseControl).toHaveBeenLastCalledWith({ id: 2, occurrence: 1 }, false);
  });
  it("uses one accessibility click per activation and shows no pressed state for a denied grant", () => {
    const owner = controller(); vi.mocked(owner.beginMouseControl).mockReturnValue(undefined);
    const view = mount("en", owner); touch(view.host, "left", "mousedown"); touch(view.host, "left", "mouseup");
    expect(control(view.host, "left").getAttribute("aria-selected")).toBe("false");
    expect(owner.endMouseControl).not.toHaveBeenCalled();
    act(() => control(view.host, "wheel").click()); expect(owner.clickMouseControl).toHaveBeenCalledExactlyOnceWith("wheel");
  });
  it("exports no native mouse component on Android so the actual HTML rail stays enabled", async () => {
    platform.OS = "android"; vi.resetModules();
    expect((await import("./MobileRemoteDesktopMouseControls")).MobileRemoteDesktopMouseControls).toBeNull();
  });
});
