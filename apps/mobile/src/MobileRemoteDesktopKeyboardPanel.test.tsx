// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { create } from "@bufbuild/protobuf";
import { RemoteDesktopCapabilitiesSchema } from "@joko/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileRemoteDesktopKeyboardPanel, MobileRemoteDesktopShortcutTools, type MobileRemoteDesktopKeyboardController } from "./MobileRemoteDesktopKeyboardPanel";
import { MobileKeyboardAvoidingView } from "./MobileKeyboardAvoidingView";
import { MOBILE_SUPPORTED_LOCALES, type MobileSupportedLocale } from "./mobile-locale-preference";
import { mobileRemoteDesktopCopy } from "./remote-desktop-presentation";
import type { MobileRemoteDesktopSnapshot } from "./remote-desktop-controller";

const viewport = vi.hoisted(() => ({ width: 390, height: 844 }));
vi.mock("react-native", async () => {
  const React = await import("react");
  const element = (tag: string) => ({ children, accessibilityLabel, accessibilityRole, accessibilityState, disabled,
    onPress, onPressIn, onPressOut, style, contentContainerStyle: _content, ..._props }: Record<string, unknown> & {
    children?: React.ReactNode; accessibilityState?: { disabled?: boolean; selected?: boolean }; style?: object | object[];
  }) => {
    const flat = Array.isArray(style) ? Object.assign({}, ...style) : style;
    return React.createElement(tag, { "aria-label": accessibilityLabel, role: accessibilityRole, disabled,
      "aria-disabled": accessibilityState?.disabled, "aria-selected": accessibilityState?.selected,
      "data-max-height": flat?.maxHeight, "data-padding-bottom": flat?.paddingBottom,
      onClick: onPress, onMouseDown: onPressIn, onMouseUp: onPressOut }, children);
  };
  return { Pressable: element("button"), Text: element("span"), View: element("div"), ScrollView: element("div"),
    KeyboardAvoidingView: element("div"), Platform: { OS: "ios" }, useWindowDimensions: () => viewport,
    StyleSheet: { hairlineWidth: 1, create: <T,>(value: T) => value } };
});
const colors = { background: "#fafafa", surface: "#fff", ink: "#111", muted: "#666", border: "#ddd", accent: "#f90", negative: "#b00" };
const roots: Root[] = [];
afterEach(() => { for (const root of roots.splice(0)) act(() => root.unmount()); viewport.width = 390; viewport.height = 844; });
function mount(locale: MobileSupportedLocale = "en") {
  const host = document.createElement("div"), root = createRoot(host); roots.push(root);
  const grant = Object.freeze({ id: 1, occurrence: 1 });
  const controller: MobileRemoteDesktopKeyboardController = { selectKeyboardMode: vi.fn(), selectKeyboardPage: vi.fn(), toggleKeyboardCombo: vi.fn(),
    toggleKeyboardModifier: vi.fn(), pressKeyboardKey: vi.fn(() => grant), releaseKeyboardKey: vi.fn(), closeKeyboard: vi.fn(), performKeyboardShortcut: vi.fn() };
  const snapshot: MobileRemoteDesktopSnapshot = { capabilities: create(RemoteDesktopCapabilitiesSchema, { platform: "darwin", canControl: true }),
    status: "live", controlling: true, wantedControl: true, exitStatus: "idle", displayModeBusy: false,
    keyboardOpen: true, keyboardMode: "computer", keyboardPage: "abc", keyboardCombo: true, keyboardModifiers: [], keyboardOccurrence: 1 } as unknown as MobileRemoteDesktopSnapshot;
  const render = (patch: Partial<MobileRemoteDesktopSnapshot> = {}, active = true, keyboardHeight = 0) => act(() => root.render(createElement(MobileKeyboardAvoidingView,
    { keyboard: { height: keyboardHeight, visible: keyboardHeight > 0 }, consumedBottomInset: 34 }, createElement(MobileRemoteDesktopKeyboardPanel,
      { snapshot: { ...snapshot, ...patch }, controller, colors, locale, interactive: active, foreground: active, routeFocused: active, online: active }))));
  render(); return { host, root, render, snapshot, controller, grant };
}
function button(host: HTMLElement, label: string): HTMLButtonElement {
  const candidate = Array.from(host.querySelectorAll("button")).find(item => item.getAttribute("aria-label") === label);
  if (!candidate) throw new Error(`Missing key: ${label}`); return candidate;
}
function mouse(host: HTMLElement, label: string, event: "mousedown" | "mouseup") {
  act(() => button(host, label).dispatchEvent(new MouseEvent(event, { bubbles: true })));
}
describe("Mobile actual computer keyboard panel", () => {
  it.each(MOBILE_SUPPORTED_LOCALES)("renders both modes/pages, modifier combo and platform shortcuts in %s", locale => {
    const view = mount(locale), copy = mobileRemoteDesktopCopy(locale);
    act(() => button(view.host, copy.inputMethod).click()); expect(view.controller.selectKeyboardMode).toHaveBeenCalledWith("inputMethod");
    act(() => button(view.host, copy.computerKeyboard).click()); expect(view.controller.selectKeyboardMode).toHaveBeenCalledWith("computer");
    act(() => button(view.host, copy.comboMode).click()); expect(view.controller.toggleKeyboardCombo).toHaveBeenCalledOnce();
    act(() => button(view.host, "Control").click()); expect(view.controller.toggleKeyboardModifier).toHaveBeenCalledWith("ControlLeft");
    act(() => button(view.host, copy.functionKeys).click()); expect(view.controller.selectKeyboardPage).toHaveBeenCalledWith("function");
    view.render({ keyboardPage: "function" }); expect(button(view.host, "F11")).toBeDefined(); expect(button(view.host, "↑")).toBeDefined();
    act(() => button(view.host, "ABC").click()); expect(view.controller.selectKeyboardPage).toHaveBeenCalledWith("abc");
    act(() => button(view.host, copy.allWindows).click()); expect(view.controller.performKeyboardShortcut).toHaveBeenCalledWith("allWindows");
    act(() => button(view.host, copy.showDesktop).click()); expect(view.controller.performKeyboardShortcut).toHaveBeenCalledWith("showDesktop");
    act(() => button(view.host, copy.closeKeyboard).click()); expect(view.controller.closeKeyboard).toHaveBeenCalledOnce();
    if (locale !== "en") expect(copy.computerKeyboard).not.toBe(mobileRemoteDesktopCopy("en").computerKeyboard);
  });
  it("pairs press callbacks with their captured grant and uses held modifiers outside combo mode", () => {
    const view = mount(); mouse(view.host, "A", "mousedown"); mouse(view.host, "A", "mouseup");
    expect(view.controller.pressKeyboardKey).toHaveBeenCalledWith("KeyA"); expect(view.controller.releaseKeyboardKey).toHaveBeenCalledWith(view.grant);
    view.render({ keyboardCombo: false, keyboardOccurrence: 2 }); mouse(view.host, "Control", "mousedown"); mouse(view.host, "Control", "mouseup");
    expect(view.controller.pressKeyboardKey).toHaveBeenCalledWith("ControlLeft");
  });
  it("keeps mode/close controls visible with controlled iOS keyboard height and bounds the landscape panel", () => {
    const view = mount(); view.render({ keyboardMode: "inputMethod" }, true, 300);
    expect(view.host.querySelector('[data-padding-bottom="266"]')).not.toBeNull();
    expect(button(view.host, mobileRemoteDesktopCopy("en").computerKeyboard)).toBeDefined(); expect(button(view.host, mobileRemoteDesktopCopy("en").closeKeyboard)).toBeDefined();
    viewport.width = 844; viewport.height = 390; view.render();
    expect(view.host.querySelector('[data-max-height="234"]')).not.toBeNull();
    expect(view.host.querySelector('[data-max-height="156"]')).not.toBeNull();
  });
  it("disables injection outside current control and omits Linux/unsupported shortcuts", () => {
    const view = mount(), copy = mobileRemoteDesktopCopy("en"); view.render({}, false);
    expect(button(view.host, "A").disabled).toBe(true); expect(button(view.host, copy.allWindows).disabled).toBe(true);
    expect(button(view.host, copy.closeKeyboard).disabled).toBe(false);
    view.render({ keyboardOpen: false }); expect(view.host.querySelector("button")).toBeNull();
    act(() => view.root.render(createElement(MobileRemoteDesktopShortcutTools, { snapshot: { ...view.snapshot,
      capabilities: create(RemoteDesktopCapabilitiesSchema, { platform: "linux", canControl: true, workspaceNavigation: true }) },
      controller: view.controller, colors, locale: "en", interactive: true, foreground: true, routeFocused: true, online: true })));
    expect(view.host.textContent).toBe("");
  });
});
