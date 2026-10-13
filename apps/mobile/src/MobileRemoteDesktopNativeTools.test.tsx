// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileRemoteDesktopNativeTools, MobileRemoteDesktopNetworkStatus, mobileRemoteDesktopNetworkLabel } from "./MobileRemoteDesktopNativeTools";
import { MOBILE_SUPPORTED_LOCALES, type MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileRemoteDesktopCopy } from "./remote-desktop-presentation";
import type { MobileRemoteDesktopPipPreferenceState } from "./mobile-remote-desktop-pip-preference";

vi.mock("react-native", async () => {
  const React = await import("react");
  const element = (tag: string) => ({ children, accessibilityLabel, accessibilityRole, accessibilityState, disabled,
    onPress }: Record<string, unknown> & { children?: React.ReactNode; accessibilityState?: Record<string, unknown> }) =>
    React.createElement(tag, { "aria-label": accessibilityLabel, role: accessibilityRole, disabled,
      "aria-disabled": accessibilityState?.disabled, "aria-checked": accessibilityState?.checked,
      "aria-busy": accessibilityState?.busy, onClick: onPress }, children);
  return { Pressable: element("button"), Text: element("span"), View: element("div"), ActivityIndicator: element("i"),
    StyleSheet: { hairlineWidth: 1, create: <T,>(value: T) => value } };
});
const colors = { background: "#fafafa", surface: "#fff", ink: "#111", muted: "#666", border: "#ddd", accent: "#f90", negative: "#b00" };
const roots: Root[] = [];
afterEach(() => { for (const root of roots.splice(0)) act(() => root.unmount()); });
function mount(locale: MobileSupportedLocale = "en") {
  const host = document.createElement("div"), root = createRoot(host); roots.push(root);
  const onBackgroundChange = vi.fn(), onPreferenceRetry = vi.fn(), onRotate = vi.fn();
  const render = (preference: MobileRemoteDesktopPipPreferenceState = { status: "ready", enabled: false, saving: false },
    disabled = false, rotation: "idle" | "pending" | "failed" = "idle", backgroundAvailable = true) => {
    act(() => root.render(createElement(MobileRemoteDesktopNativeTools, { colors, locale, preference, disabled, rotation,
      backgroundAvailable, onBackgroundChange, onPreferenceRetry, onRotate })));
  };
  render(); return { host, root, render, onBackgroundChange, onPreferenceRetry, onRotate };
}
function button(host: HTMLElement, label: string): HTMLButtonElement {
  const value = Array.from(host.querySelectorAll("button")).find(item => item.getAttribute("aria-label") === label);
  if (!value) throw new Error(`Missing control ${label}`); return value;
}
describe("Mobile native presentation controls", () => {
  it.each(MOBILE_SUPPORTED_LOCALES)("renders saved background intent and explicit rotation in %s", locale => {
    const view = mount(locale), copy = mobileRemoteDesktopCopy(locale);
    const toggle = button(view.host, copy.backgroundViewing);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    act(() => toggle.click()); expect(view.onBackgroundChange).toHaveBeenCalledWith(true);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    view.render({ status: "ready", enabled: true, saving: false });
    act(() => button(view.host, copy.backgroundViewing).click()); expect(view.onBackgroundChange).toHaveBeenLastCalledWith(false);
    act(() => button(view.host, copy.rotate).click()); expect(view.onRotate).toHaveBeenCalledOnce();
    if (locale !== "en") expect(copy.backgroundViewing).not.toBe(mobileRemoteDesktopCopy("en").backgroundViewing);
  });
  it("fences loading, pending writes, inactive controls and in-flight rotation", () => {
    const view = mount(), copy = mobileRemoteDesktopCopy("en");
    view.render({ status: "loading", enabled: false, saving: false });
    expect(button(view.host, copy.backgroundViewing).disabled).toBe(true);
    view.render({ status: "ready", enabled: true, saving: true }, false, "pending");
    expect(button(view.host, copy.backgroundViewing).disabled).toBe(true);
    expect(button(view.host, copy.rotate).disabled).toBe(true); expect(view.host.textContent).toContain(copy.rotating);
    view.render(undefined, true); expect(button(view.host, copy.rotate).disabled).toBe(true);
    view.render(undefined, false, "idle", false); expect(view.host.querySelector('[role="switch"]')).toBeNull();
    view.render({ status: "ready", enabled: true, saving: false }, false, "idle", false);
    expect(button(view.host, copy.backgroundViewing)).toBeDefined();
  });
  it("exposes finite load retry, save failure and rotation failure", () => {
    const view = mount(), copy = mobileRemoteDesktopCopy("en");
    view.render({ status: "error", enabled: false, saving: false, notice: "load-failed" });
    expect(view.host.textContent).toContain(copy.backgroundLoadFailed);
    act(() => button(view.host, copy.retry).click()); expect(view.onPreferenceRetry).toHaveBeenCalledOnce();
    view.render({ status: "error", enabled: true, saving: false, notice: "save-failed" }, false, "failed");
    expect(view.host.textContent).toContain(copy.backgroundSaveFailed); expect(view.host.textContent).toContain(copy.rotationFailed);
    expect(button(view.host, copy.backgroundViewing).getAttribute("aria-checked")).toBe("true");
  });
  it("renders transport, finite receive rate and latency including unknown statistics", () => {
    expect(mobileRemoteDesktopNetworkLabel({ transport: "relay", bytesPerSecond: 1_234_000, latencyMs: 12.5 }, "en"))
      .toBe(`${mobileRemoteDesktopCopy("en").networkRelay} · 1.2 MB/s · 13 ms`);
    expect(mobileRemoteDesktopNetworkLabel({ transport: "direct", bytesPerSecond: 1_234, latencyMs: null }, "en"))
      .toBe(`${mobileRemoteDesktopCopy("en").networkDirect} · 1 KB/s`);
    const view = mount();
    act(() => view.root.render(createElement(MobileRemoteDesktopNetworkStatus, { colors, locale: "zh-TW",
      network: { transport: "screenshot", bytesPerSecond: null, latencyMs: null } })));
    expect(view.host.textContent).toBe(mobileRemoteDesktopCopy("zh-TW").networkScreenshot);
    expect(view.host.textContent).not.toContain("NaN"); expect(view.host.textContent).not.toContain("null");
  });
});
