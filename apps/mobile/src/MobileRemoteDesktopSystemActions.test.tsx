// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { create } from "@bufbuild/protobuf";
import { RemoteDesktopCapabilitiesSchema } from "@joko/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileRemoteDesktopSystemActions } from "./MobileRemoteDesktopSystemActions";
import { MOBILE_SUPPORTED_LOCALES, type MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileRemoteDesktopCopy } from "./remote-desktop-presentation";
import type { MobileRemoteDesktopSnapshot } from "./remote-desktop-controller";

vi.mock("react-native", async () => {
  const React = await import("react");
  const element = (tag: string) => ({ children, accessibilityLabel, accessibilityRole, accessibilityState, disabled,
    onPress, style: _style, accessibilityLiveRegion: _live, ..._props }: Record<string, unknown> & { children?: React.ReactNode,
      accessibilityState?: { disabled?: boolean }, onPress?: () => void }) => React.createElement(tag, {
      "aria-label": accessibilityLabel, role: accessibilityRole, disabled,
      "aria-disabled": accessibilityState?.disabled, onClick: onPress }, children);
  return { Pressable: element("button"), Text: element("span"), View: element("div"), ActivityIndicator: element("output"),
    StyleSheet: { hairlineWidth: 1, create: <T,>(value: T) => value } };
});

const colors = { background: "#fafafa", surface: "#fff", ink: "#111", muted: "#666", border: "#ddd", accent: "#f90", negative: "#b00" };
const roots: Root[] = [];
afterEach(() => { for (const root of roots.splice(0)) act(() => root.unmount()); });
type Snapshot = Pick<MobileRemoteDesktopSnapshot, "capabilities" | "status" | "controlling" | "wantedControl" | "exitStatus" | "displayModeBusy" | "systemActionPending" | "systemActionFailure">;
function mount(locale: MobileSupportedLocale) {
  const host = document.createElement("div"), root = createRoot(host); roots.push(root);
  const onAction = vi.fn(), onRetry = vi.fn();
  const snapshot: Snapshot = { capabilities: create(RemoteDesktopCapabilitiesSchema, { workspaceNavigation: true, systemMenu: true }),
    status: "live", controlling: true, wantedControl: true, exitStatus: "idle", displayModeBusy: false, systemActionPending: false };
  const render = (patch: Partial<Snapshot> = {}, active = true) => act(() => root.render(createElement(MobileRemoteDesktopSystemActions,
    { snapshot: { ...snapshot, ...patch }, locale, colors, interactive: active, foreground: active, routeFocused: active, online: active, onAction, onRetry })));
  render(); return { host, render, snapshot, onAction, onRetry };
}
function button(host: HTMLElement, label: string): HTMLButtonElement {
  const candidate = Array.from(host.querySelectorAll("button")).find(item => item.getAttribute("aria-label") === label);
  if (!candidate) throw new Error(`Missing action: ${label}`); return candidate;
}

describe("Mobile remote desktop system action controls", () => {
  it.each(MOBILE_SUPPORTED_LOCALES)("renders advertised actions, pending and explicit failure retry in %s", locale => {
    const view = mount(locale), copy = mobileRemoteDesktopCopy(locale);
    for (const action of ["workspaceLeft", "workspaceRight", "systemMenu"] as const) {
      act(() => button(view.host, copy[action]).click());
      expect(view.onAction).toHaveBeenLastCalledWith(action);
    }
    view.render({ systemActionPending: true });
    expect(view.host.textContent).toContain(copy.systemActionUpdating);
    expect(Array.from(view.host.querySelectorAll("button")).every(item => item.disabled)).toBe(true);
    view.render({ systemActionFailure: "workspaceRight" });
    expect(view.host.querySelector('[role="alert"]')?.textContent).toContain(copy.systemActionFailed);
    act(() => button(view.host, copy.retry).click()); expect(view.onRetry).toHaveBeenCalledOnce();
    view.render({ systemActionFailure: "workspaceRight" }, false);
    expect(button(view.host, copy.retry).disabled).toBe(true);
    if (locale !== "en") expect(copy.systemMenu).not.toBe(mobileRemoteDesktopCopy("en").systemMenu);
  });

  it("hides missing menu capability and disables effects outside live current control", () => {
    const view = mount("en"), copy = mobileRemoteDesktopCopy("en");
    view.render({ capabilities: create(RemoteDesktopCapabilitiesSchema, { workspaceNavigation: true }) });
    expect(view.host.textContent).not.toContain(copy.systemMenu);
    expect(view.host.querySelectorAll("button")).toHaveLength(2);
    for (const patch of [{ controlling: false }, { wantedControl: false }, { status: "reconnecting" as const },
      { displayModeBusy: true }, { exitStatus: "pending" as const }]) {
      view.render(patch);
      expect(Array.from(view.host.querySelectorAll("button")).every(item => item.disabled)).toBe(true);
    }
    view.render({ capabilities: create(RemoteDesktopCapabilitiesSchema, {}) }); expect(view.host.textContent).toBe("");
  });
});
