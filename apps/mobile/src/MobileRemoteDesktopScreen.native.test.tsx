// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DeviceKind, DevicePeerCapabilityKind, DevicePeerDescriptorSchema, DevicePeerRouteIdentitySchema,
  DevicePresenceState, RemoteDesktopCapabilitiesSchema, RemoteDesktopClipboardContentResultSchema,
  RemoteDesktopClipboardSyncResultSchema, RemoteDesktopClipboardTextResultSchema, RemoteDesktopClipboardVersionResultSchema,
  RemoteDesktopControlStateSchema, RemoteDesktopDisplayModeResultSchema, RemoteDesktopDisplaySchema,
  RemoteDesktopFrameResultSchema, RemoteDesktopHostMuteResultSchema, RemoteDesktopIceExchangeResultSchema, RemoteDesktopIceServerSchema,
  RemoteDesktopFailureReason, RemoteDesktopFailureSchema,
  RemoteDesktopLeaseSchema, RemoteDesktopPermissionStatus, RemoteDesktopPermissionsSchema,
  RemoteDesktopOfferResultSchema, RemoteDesktopPrivacyScreenResultSchema, RemoteDesktopViewerDisplayResultSchema
} from "@joko/contracts";
import { MobileRemoteDesktopScreen, type MobileRemoteDesktopColors } from "./MobileRemoteDesktopScreen";
import { MobileRemoteDesktopController, type MobileRemoteDesktopTransport } from "./remote-desktop-controller";
import { mobileRemoteDesktopCopy } from "./remote-desktop-presentation";
import type { MobileRemoteDesktopLifecycleHandler } from "./MobileRemoteDesktopScreen";
import type { MobileRemoteDesktopNativeCommand, MobileRemoteDesktopNativeInputBatch } from "./remote-desktop-native-bridge";
import type { MobileLayoutRect, MobileWindowGeometry } from "./mobile-window-geometry";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const native = vi.hoisted(() => ({
  platform: "ios" as "ios" | "android",
  back: undefined as (() => boolean) | undefined,
  width: 390, height: 844,
  geometry: undefined as MobileWindowGeometry | undefined,
  measured: undefined as MobileLayoutRect | undefined,
  keyboard: { visible: false, height: 0 },
  viewProperties: new Map<string, Record<string, unknown>>(),
  values: new Map<string, string>(),
  getItem: vi.fn<(key: string) => Promise<string | null>>(),
  setItem: vi.fn<(key: string, value: string) => Promise<void>>(),
  receive: vi.fn<(command: MobileRemoteDesktopNativeCommand) => Promise<void>>(),
  sendInput: vi.fn<(batch: MobileRemoteDesktopNativeInputBatch) => Promise<boolean>>(),
  rotate: vi.fn<(landscape: boolean) => Promise<void>>(),
  playback: vi.fn<(enabled: boolean) => Promise<void>>(),
  viewProps: undefined as { inlineVisible: boolean; onMessage(event: { nativeEvent: { data: string } }): void } | undefined,
  webProps: undefined as { source: { html: string }; onMessage(event: { nativeEvent: { data: string } }): void } | undefined,
  mouseTouchEnds: new Map<string, (event: { nativeEvent: { identifier: number; pageY: number } }) => void>(),
  htmlCommands: [] as Readonly<Record<string, unknown>>[]
}));

vi.mock("react-native", async () => {
  const React = await import("react");
  const style = (value: unknown): Record<string, unknown> => Array.isArray(value)
    ? Object.assign({}, ...value.map(style)) : typeof value === "function" ? style(value({ pressed: false }))
      : typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  const element = (tag: string) => React.forwardRef((props: Record<string, unknown> & { children?: React.ReactNode }, ref: React.ForwardedRef<unknown>) => {
    React.useImperativeHandle(ref, () => ({ measureInWindow(callback: (x: number, y: number, width: number, height: number) => void) {
      const rect = native.measured ?? { x: 0, y: 62, width: native.width, height: native.height - 82 };
      callback(rect.x, rect.y, rect.width, rect.height);
    } }));
    const state = props.accessibilityState as { disabled?: boolean; checked?: boolean; selected?: boolean; busy?: boolean } | undefined;
    if (typeof props.testID === "string") native.viewProperties.set(props.testID, props);
    if (typeof props.testID === "string" && typeof props.onTouchEnd === "function") {
      native.mouseTouchEnds.set(props.testID, props.onTouchEnd as (event: { nativeEvent: { identifier: number; pageY: number } }) => void);
    }
    return React.createElement(tag, {
      "aria-label": props.accessibilityLabel,
      role: props.accessibilityRole,
      "aria-disabled": state?.disabled,
      "aria-checked": state?.checked,
      "aria-selected": state?.selected,
      "aria-busy": state?.busy,
      "data-testid": props.testID,
      style: style(props.style),
      disabled: props.disabled,
      onClick: props.onPress,
      onPointerDown: props.onPressIn,
      onPointerUp: props.onPressOut,
      onTouchStart: props.onTouchStart,
      onTouchMove: props.onTouchMove,
      onTouchEnd: props.onTouchEnd,
      onTouchCancel: props.onTouchCancel
    }, props.children);
  });
  return {
    ActivityIndicator: () => React.createElement("span", { "data-loading": true }),
    Alert: { alert: vi.fn() }, Appearance: { getColorScheme: () => "light" },
    BackHandler: { addEventListener: (_name: string, handler: () => boolean) => { native.back = handler; return { remove() { if (native.back === handler) native.back = undefined; } }; } },
    Platform: { get OS() { return native.platform; } }, Pressable: element("button"), ScrollView: element("div"),
    StyleSheet: { create: <T,>(value: T) => value, hairlineWidth: 1, absoluteFill: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 } },
    Text: element("span"), View: element("div"),
    useWindowDimensions: () => ({ width: native.width, height: native.height, scale: 1, fontScale: 1 })
  };
});
vi.mock("./MobileRemoteDesktopChrome", async () => {
  const React = await import("react"), ios = await import("./MobileRemoteDesktopChrome.ios");
  const ordinary = await vi.importActual<typeof import("./MobileRemoteDesktopChrome")>("./MobileRemoteDesktopChrome");
  return Object.fromEntries(["MobileRemoteDesktopToolbar", "MobileRemoteDesktopPanel", "MobileRemoteDesktopDisplaySelector"].map(name =>
    [name, (props: object) => React.createElement((native.platform === "ios" ? ios : ordinary)[name as keyof typeof ordinary] as React.ComponentType<object>, props)]));
});
vi.mock("./MobileRemoteDesktopPermissionGuide", async () => {
  const React = await import("react"), ios = await import("./MobileRemoteDesktopPermissionGuide.ios");
  const ordinary = await vi.importActual<typeof import("./MobileRemoteDesktopPermissionGuide")>("./MobileRemoteDesktopPermissionGuide");
  return { MobileRemoteDesktopPermissionGuide: (props: import("./MobileRemoteDesktopPermissionGuide").MobileRemoteDesktopPermissionGuideProps) =>
    React.createElement((native.platform === "ios" ? ios : ordinary).MobileRemoteDesktopPermissionGuide, props) };
});
vi.mock("expo-glass-effect", () => ({ isLiquidGlassAvailable: () => true }));
vi.mock("@expo/ui/swift-ui/modifiers", () => ({ ...Object.fromEntries([
  "accessibilityAddTraits", "accessibilityElement", "accessibilityLabel", "background", "buttonStyle", "contentShape",
  "disabled", "frame", "glassEffect", "presentationDetents", "presentationDragIndicator", "buttonBorderShape", "controlSize",
  "fixedSize", "font", "foregroundStyle", "multilineTextAlignment", "padding"
].map(name => [name, (value: unknown) => ({ name, value })])), shapes: { circle: () => "circle", capsule: () => "capsule", rectangle: () => "rectangle",
  roundedRectangle: (value: unknown) => ({ roundedRectangle: value }) } }));
vi.mock("@expo/ui", async () => {
  const React = await import("react");
  return { Host: (props: { children: React.ReactNode; style?: object; testID?: string; colorScheme?: string }) =>
    React.createElement("div", { "data-testid": props.testID, "data-native-theme": props.colorScheme, style: props.style }, props.children) };
});
vi.mock("@expo/ui/swift-ui", async () => {
  const React = await import("react");
  type NativeProps = { children?: React.ReactNode; modifiers?: { name: string; value: unknown }[]; isPresented?: boolean;
    onIsPresentedChange?: (value: boolean) => void; label?: React.ReactNode; isOn?: boolean;
    onIsOnChange?: (value: boolean) => void; onPress?: () => void; testID?: string };
  const group = (props: NativeProps) => React.createElement("div", { "data-native-modifiers": JSON.stringify(props.modifiers) }, props.children);
  const popover = Object.assign((props: NativeProps) => props.isPresented ? React.createElement("div", { "data-native-presentation": "popover",
    onDoubleClick: () => props.onIsPresentedChange?.(false) }, props.children) : null, { Trigger: group, Content: group });
  return { Group: group, HStack: group, VStack: group, RNHostView: group, Spacer: group, Popover: popover,
    Text: (props: NativeProps) => React.createElement("span", { "data-native-modifiers": JSON.stringify(props.modifiers),
      role: (props.modifiers?.find(modifier => modifier.name === "accessibilityAddTraits")?.value as string[])?.includes("isHeader") ? "heading" : undefined }, props.children),
    Divider: () => React.createElement("hr"),
    LabeledContent: (props: NativeProps) => React.createElement("div", { "data-native-labeled-content": true }, props.label, props.children),
    Menu: (props: NativeProps) => React.createElement("div", { "data-native-menu": true }, props.label, props.children),
    Toggle: (props: NativeProps) => React.createElement("button", { "aria-label": props.label, "aria-checked": props.isOn,
      role: "radio", onClick: () => props.onIsOnChange?.(!props.isOn) }, props.label),
    BottomSheet: (props: NativeProps) => props.isPresented ? React.createElement("div", { "data-native-presentation": "sheet",
      onDoubleClick: () => props.onIsPresentedChange?.(false) }, props.children) : null,
    Button: (props: NativeProps) => React.createElement("button", { "data-testid": props.testID,
      "data-native-modifiers": JSON.stringify(props.modifiers),
      "aria-label": props.modifiers?.find(modifier => modifier.name === "accessibilityLabel")?.value,
      "aria-selected": (props.modifiers?.find(modifier => modifier.name === "accessibilityAddTraits")?.value as string[])?.includes("isSelected"),
      disabled: props.modifiers?.find(modifier => modifier.name === "disabled")?.value, onClick: props.onPress }, props.children)
  };
});
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 20, left: 0 }) }));
vi.mock("./MobileAdaptiveWindow", () => ({ useMobileAdaptiveWindow: () => native.geometry ?? {
  width: native.width, height: native.height, insets: { top: 0, right: 0, bottom: 20, left: 0 },
  regularWidth: false, regularHeight: true, barEdge: "none", regions: [], reservedRegionsSupported: false
} }));
vi.mock("./MobileKeyboardAvoidingView", async () => {
  const React = await import("react");
  return { useMobileKeyboardState: () => native.keyboard,
    MobileKeyboardAvoidingView: ({ children, enabled }: { children: React.ReactNode; enabled: boolean }) =>
      React.createElement("div", { "data-keyboard-avoiding": String(enabled) }, children) };
});
vi.mock("expo-clipboard", () => ({ getStringAsync: async () => "", setStringAsync: async () => undefined }));
vi.mock("react-native-svg", async () => {
  const React = await import("react");
  return { default: ({ children }: { children: React.ReactNode }) => React.createElement("svg", {}, children),
    Path: () => React.createElement("path"), Rect: () => React.createElement("rect") };
});
vi.mock("@react-native-async-storage/async-storage", () => ({ default: { getItem: native.getItem, setItem: native.setItem } }));
vi.mock("expo-modules-core", async () => {
  const React = await import("react");
  return {
    requireOptionalNativeModule: (name: string) => name === "JokoRemotePresentation"
      ? { nativeVideo: true, playback: native.playback, rotate: native.rotate } : null,
    requireNativeViewManager: (name: string) => {
      if (name !== "JokoRemotePresentation") throw new Error("Unexpected native view.");
      return React.forwardRef((props: NonNullable<typeof native.viewProps>, ref: React.ForwardedRef<unknown>) => {
        native.viewProps = props;
        React.useImperativeHandle(ref, () => ({ receive: native.receive, sendInput: native.sendInput }));
        return React.createElement("div", { "data-native-visible": String(props.inlineVisible) });
      });
    }
  };
});
vi.mock("react-native-webview", async () => {
  const React = await import("react");
  return { WebView: React.forwardRef((props: NonNullable<typeof native.webProps>, ref: React.ForwardedRef<unknown>) => {
    native.webProps = props;
    React.useImperativeHandle(ref, () => ({ reload() {}, injectJavaScript(script: string) {
      new Function("window", script)({ __jokoRemoteDesktop: { receive: (command: Readonly<Record<string, unknown>>) => native.htmlCommands.push(command) } });
    } }));
    return React.createElement("div", { "data-viewer-overlay": true });
  }) };
});

const colors: MobileRemoteDesktopColors = {
  background: "#fafafa", surface: "#ffffff", ink: "#111111", muted: "#666666",
  border: "#dddddd", accent: "#ff9900", negative: "#bb0000"
};
const copy = mobileRemoteDesktopCopy("en");
const attemptId = "123e4567-e89b-42d3-a456-426614174000";
const pipKey = "joko.mobile.remote-desktop.picture-in-picture.v1";
const inputModeKey = "joko.mobile.remote-desktop.input-mode.v1";
const mouseButtonsKey = "joko.mobile.remote-desktop.show-mouse-buttons.v1";
let root: Root | undefined;
let container: HTMLDivElement;
let currentController: MobileRemoteDesktopController;
let lifecycle: MobileRemoteDesktopLifecycleHandler | undefined;

function transport(ownerKey = "owner-current", targetDeviceId = "desktop-current"): MobileRemoteDesktopTransport {
  const host = create(DevicePeerDescriptorSchema, {
    route: create(DevicePeerRouteIdentitySchema, { targetDeviceId, relationId: "relation-current",
      targetDeviceRevision: { value: 1n }, relationRevision: { value: 1n }, routeGeneration: 1n }),
    displayName: "Desk", kind: DeviceKind.DESKTOP, platform: "darwin", presence: DevicePresenceState.ONLINE,
    capabilities: [DevicePeerCapabilityKind.REMOTE_DESKTOP]
  });
  const display = create(RemoteDesktopDisplaySchema, { displayId: "display-current", name: "Main", width: 1920, height: 1080 });
  const permissions = create(RemoteDesktopPermissionsSchema, {
    screenRecording: RemoteDesktopPermissionStatus.GRANTED, accessibility: RemoteDesktopPermissionStatus.GRANTED
  });
  const capabilities = create(RemoteDesktopCapabilitiesSchema, {
    enabled: true, protocolVersion: 1, canControl: true, platform: "darwin", displays: [display], permissions,
    automaticReconnect: true, connectionTakeover: true, webrtcVideo: true, trickleIce: true, jpegFallback: true,
    systemAudio: true, backgroundViewing: true
  });
  return {
    ownerKey, preferenceOwner: { profileId: "profile-current", serverId: "server-current", controllerDeviceId: "phone-current" },
    isCurrent: () => true, canStop: () => true,
    beginBackgroundTransition: vi.fn(() => ({ isCurrent: () => true, close: vi.fn() })),
    listHosts: vi.fn(async () => [host]), capabilities: vi.fn(async () => capabilities),
    permissions: vi.fn(async () => permissions), showPermissionGuide: vi.fn(async () => permissions),
    start: vi.fn(async () => create(RemoteDesktopLeaseSchema, { leaseId: "lease-current", display, controlling: true, controlGeneration: 1n })),
    heartbeat: vi.fn(async () => create(RemoteDesktopControlStateSchema, { controlling: true, controlGeneration: 1n })),
    stop: vi.fn(async () => undefined), input: vi.fn(async () => undefined),
    control: vi.fn(async (_host, _lease, enabled) => create(RemoteDesktopControlStateSchema, { controlling: enabled, controlGeneration: 1n })),
    presentation: vi.fn(async () => create(RemoteDesktopControlStateSchema, { controlling: false, controlGeneration: 1n })),
    systemAction: vi.fn(async (_host, _lease, _generation, action) => action),
    setHostMute: vi.fn(async (_host, _lease, _generation, enabled) => create(RemoteDesktopHostMuteResultSchema, { enabled })),
    setPrivacyScreen: vi.fn(async (_host, _lease, _generation, enabled) => create(RemoteDesktopPrivacyScreenResultSchema, { enabled })),
    iceConfiguration: vi.fn(async () => [create(RemoteDesktopIceServerSchema, { urls: ["stun:example.test:3478"] })]),
    offer: vi.fn(async (_host, _lease, id) => create(RemoteDesktopOfferResultSchema, { attemptId: id, answerSdp: "answer" })),
    ice: vi.fn(async (_host, _lease, id, _candidates, after) => create(RemoteDesktopIceExchangeResultSchema, { attemptId: id,
      candidates: [], next: after, complete: true })),
    frame: vi.fn(async () => create(RemoteDesktopFrameResultSchema)),
    listDisplayModes: vi.fn(async () => []), setDisplayMode: vi.fn(async () => create(RemoteDesktopDisplayModeResultSchema)),
    clipboardText: vi.fn(async () => create(RemoteDesktopClipboardTextResultSchema)),
    clipboardContent: vi.fn(async () => create(RemoteDesktopClipboardContentResultSchema)),
    setClipboardSync: vi.fn(async () => create(RemoteDesktopClipboardSyncResultSchema)),
    clipboardVersion: vi.fn(async () => create(RemoteDesktopClipboardVersionResultSchema))
  };
}

const callbacks = { onClose: vi.fn(), onRestore: vi.fn(), onEnded: vi.fn() };
const registerLifecycle = (handler: MobileRemoteDesktopLifecycleHandler) => {
  lifecycle = handler; return () => { if (lifecycle === handler) lifecycle = undefined; };
};
async function flush(): Promise<void> { for (let i = 0; i < 20; i++) await Promise.resolve(); }
async function render(value: MobileRemoteDesktopTransport, patch: Partial<Parameters<typeof MobileRemoteDesktopScreen>[0]> = {}): Promise<void> {
  await act(async () => {
    root!.render(createElement(MobileRemoteDesktopScreen, { transport: value, preferredDeviceId: "desktop-current",
      colors, locale: "en", routeFocused: true, interactive: true, foreground: true, online: true,
      ...callbacks, registerLifecycle, ...patch }));
    await flush();
  });
}
function webMessage(value: object): void { native.webProps!.onMessage({ nativeEvent: { data: JSON.stringify(value) } }); }
function nativeMessage(epoch: string, type: string, extra: Record<string, unknown> = {}): void {
  native.viewProps!.onMessage({ nativeEvent: { data: JSON.stringify({ type, epoch, attemptId, ...extra }) } });
}
function button(label: string): HTMLButtonElement {
  const result = Array.from(container.querySelectorAll("button")).find(item => item.getAttribute("aria-label") === label);
  if (!result) throw new Error(`Missing button: ${label}`);
  return result;
}
async function ready(): Promise<string> {
  await act(async () => { webMessage({ type: "ready" }); await flush(); });
  const init = native.receive.mock.calls.map(call => call[0]).findLast(command => command.type === "init");
  if (!init || init.type !== "init") throw new Error("No actual native init.");
  await act(async () => { nativeMessage(init.epoch, "iceConfig"); nativeMessage(init.epoch, "pipCapability", { supported: true }); await flush(); });
  return init.epoch;
}
async function streaming(epoch: string): Promise<void> {
  await act(async () => { nativeMessage(epoch, "videoFrameReady"); nativeMessage(epoch, "streaming"); await flush(); });
}

beforeEach(() => {
  vi.clearAllMocks(); native.values.clear(); native.mouseTouchEnds.clear(); native.htmlCommands.length = 0; native.width = 390; native.height = 844;
  native.geometry = undefined; native.measured = undefined; native.keyboard = { visible: false, height: 0 }; native.viewProperties.clear();
  native.platform = "ios"; native.back = undefined;
  native.getItem.mockImplementation(async key => native.values.get(key) ?? null);
  native.setItem.mockImplementation(async (key, value) => { native.values.set(key, value); });
  native.receive.mockResolvedValue(undefined); native.sendInput.mockResolvedValue(true);
  native.rotate.mockResolvedValue(undefined); native.playback.mockResolvedValue(undefined);
  const originalOpen = MobileRemoteDesktopController.prototype.open;
  vi.spyOn(MobileRemoteDesktopController.prototype, "open").mockImplementation(function (this: MobileRemoteDesktopController) {
    currentController = this; return originalOpen.call(this);
  });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => { root?.unmount(); await flush(); });
  root = undefined; container.remove(); vi.restoreAllMocks();
});

describe("actual Mobile Remote Desktop Screen native composition", () => {
  it.each(["android", "ios"] as const)("reaches Mac Fit and Restore from the actual %s Display page using adjusted logical geometry", async platform => {
    native.platform = platform;
    const value = transport(), capabilities = await value.capabilities((await value.listHosts())[0]!);
    capabilities.viewerDisplay = true; capabilities.viewerDisplayRestore = true;
    const physical = capabilities.displays[0]!;
    value.fitViewerDisplay = vi.fn(async () => create(RemoteDesktopViewerDisplayResultSchema, { lease: {
      leaseId: "lease-current", controlling: false, controlGeneration: 2n,
      display: { ...physical, displayId: "mirror-current", width: 768, height: 1536 }
    } }));
    value.restoreViewerDisplay = vi.fn(async () => create(RemoteDesktopViewerDisplayResultSchema, { lease: {
      leaseId: "lease-current", controlling: false, controlGeneration: 4n, display: physical
    } }));
    vi.mocked(value.control).mockResolvedValueOnce(create(RemoteDesktopControlStateSchema, { controlling: true, controlGeneration: 3n }))
      .mockResolvedValueOnce(create(RemoteDesktopControlStateSchema, { controlling: true, controlGeneration: 5n }));
    await render(value); const epoch = await ready(); await streaming(epoch);
    const media = native.viewProperties.get("remoteDesktop.media")!;
    await act(async () => {
      (media.onLayout as (event: { nativeEvent: { layout: { width: number; height: number } } }) => void)(
        { nativeEvent: { layout: { width: 400, height: 800 } } });
      button(copy.settings).click(); await flush(); button(copy.displaySettings).click(); await flush();
    });
    expect(button(copy.fitDisplay).disabled).toBe(false); expect(button(copy.restoreDisplay).disabled).toBe(true);
    await act(async () => { button(copy.fitDisplay).click(); await flush(); });
    expect(value.fitViewerDisplay).toHaveBeenCalledWith((await value.listHosts())[0]!, "lease-current", 1n, 960, 1920, expect.any(AbortSignal));
    expect(currentController.snapshot).toMatchObject({ status: "live", controlling: true, selectedDisplayId: "display-current", viewerDisplayFitted: true });
    expect(native.receive.mock.calls.map(call => call[0]).findLast(command => command.type === "init"))
      .toMatchObject({ width: 768, height: 1536 });
    expect(button(copy.fitDisplay).getAttribute("aria-selected")).toBe("true"); expect(button(copy.restoreDisplay).disabled).toBe(false);
    await act(async () => { button(copy.restoreDisplay).click(); await flush(); });
    expect(value.restoreViewerDisplay).toHaveBeenCalledWith((await value.listHosts())[0]!, "lease-current", 3n, expect.any(AbortSignal));
    expect(currentController.snapshot).toMatchObject({ status: "live", controlling: true, selectedDisplayId: "display-current", viewerDisplayFitted: false });
    expect(native.receive.mock.calls.map(call => call[0]).findLast(command => command.type === "init"))
      .toMatchObject({ width: 1920, height: 1080 });
    expect(button(copy.restoreDisplay).disabled).toBe(true); expect(value.start).toHaveBeenCalledTimes(1); expect(value.stop).not.toHaveBeenCalled();
  });

  it.each(["android", "ios"] as const)("renders five-language %s permission recovery rows and guide receipts before explicit reconnect", async platform => {
    native.platform = platform;
    const value = transport(), capabilities = await value.capabilities((await value.listHosts())[0]!);
    const missing = create(RemoteDesktopPermissionsSchema, { screenRecording: RemoteDesktopPermissionStatus.MISSING,
      accessibility: RemoteDesktopPermissionStatus.UNKNOWN });
    capabilities.permissions = missing;
    value.permissions = vi.fn(async () => missing);
    await render(value, { colors: { ...colors, dark: true } });
    expect(currentController.snapshot.status).toBe("permission"); expect(value.start).not.toHaveBeenCalled();
    for (const locale of ["en", "zh-CN", "zh-TW", "ja", "ko"] as const) {
      const localized = mobileRemoteDesktopCopy(locale);
      await render(value, { locale, colors: { ...colors, dark: true } });
      const guide = container.querySelector('[data-testid="remoteDesktop.permissionGuide"]')!;
      for (const text of [localized.permissionsTitle, localized.permissionsIntro, localized.screenRecording, localized.accessibility,
        localized.permissionMissing, localized.permissionUnknown]) expect(guide.textContent).toContain(text);
      expect(button(localized.reconnectAfterPermissions).disabled).toBe(false);
      expect(button(localized.openGuideOnComputer).disabled).toBe(false);
      if (platform === "ios") {
        expect(guide.querySelectorAll("[data-native-labeled-content]")).toHaveLength(2);
        expect(guide.querySelector('[data-native-theme="dark"]')).not.toBeNull();
        expect(guide.querySelector('[data-native-modifiers*="glassProminent"]')).not.toBeNull();
      } else expect(button(localized.openGuideOnComputer).style.minHeight).toBe("44px");
    }
    await render(value, { colors: { ...colors, dark: true } });
    let opened!: (permissions: typeof missing) => void;
    value.showPermissionGuide = vi.fn(() => new Promise<typeof missing>(resolve => { opened = resolve; }));
    await act(async () => { button(copy.openGuideOnComputer).click(); await flush(); });
    expect(button(copy.permissionChecking).disabled).toBe(true); expect(button(copy.reconnectAfterPermissions).disabled).toBe(true);
    await act(async () => { button(copy.permissionChecking).click(); await flush(); });
    expect(value.showPermissionGuide).toHaveBeenCalledTimes(1); expect(value.start).not.toHaveBeenCalled();
    const granted = create(RemoteDesktopPermissionsSchema, { screenRecording: RemoteDesktopPermissionStatus.GRANTED,
      accessibility: RemoteDesktopPermissionStatus.NOT_REQUIRED });
    capabilities.permissions = granted; value.permissions = vi.fn(async () => granted);
    await act(async () => { opened(granted); await flush(); });
    const guide = container.querySelector('[data-testid="remoteDesktop.permissionGuide"]')!;
    expect(guide.textContent).toContain(copy.permissionGranted); expect(guide.textContent).toContain(copy.permissionNotRequired);
    expect(guide.textContent).toContain(copy.permissionsReady); expect(guide.textContent).toContain(copy.permissionGuideOpened);
    expect(container.querySelector(`[aria-label="${copy.openGuideOnComputer}"]`)).toBeNull(); expect(value.start).not.toHaveBeenCalled();
    await act(async () => { button(copy.reconnectAfterPermissions).click(); await flush(); });
    expect(value.start).toHaveBeenCalledTimes(1); expect(currentController.snapshot.status).not.toBe("permission");
  });

  it.each(["android", "ios"] as const)("opens local %s accessibility guidance without replacing the live view-only media", async platform => {
    native.platform = platform;
    const value = transport();
    vi.mocked(value.start).mockResolvedValueOnce(create(RemoteDesktopLeaseSchema, { leaseId: "lease-current", display: (await value.capabilities((await value.listHosts())[0]!)).displays[0], controlling: false, controlGeneration: 1n }));
    vi.mocked(value.control).mockRejectedValueOnce(new ConnectError("Private accessibility failure", Code.PermissionDenied, undefined,
      [{ desc: RemoteDesktopFailureSchema, value: create(RemoteDesktopFailureSchema, { reason: RemoteDesktopFailureReason.ACCESSIBILITY_PERMISSION_REQUIRED }) }]));
    await render(value); const epoch = await ready(); await streaming(epoch);
    await act(async () => { button(copy.settings).click(); await flush(); });
    expect(currentController.snapshot).toMatchObject({ status: "live", hasFrame: true, controlling: false, notice: "accessibility-permission" });
    const media = container.querySelector('[data-testid="remoteDesktop.media"]')!;
    const missing = create(RemoteDesktopPermissionsSchema, { screenRecording: RemoteDesktopPermissionStatus.GRANTED,
      accessibility: RemoteDesktopPermissionStatus.MISSING });
    value.permissions = vi.fn(async () => missing);
    await act(async () => { button(copy.permissionsTitle).click(); await flush(); });
    expect(container.querySelector('[data-testid="remoteDesktop.permissionGuide"]')!.textContent).toContain(copy.permissionMissing);
    expect(currentController.snapshot).toMatchObject({ status: "live", hasFrame: true, controlling: false });
    expect(currentController.snapshot.capabilities?.canControl).toBe(true); expect(value.start).toHaveBeenCalledTimes(1);
    const nativeInits = native.receive.mock.calls.filter(call => call[0].type === "init").length;
    vi.mocked(value.showPermissionGuide).mockRejectedValueOnce(new Error("Private guide failure"));
    await act(async () => { button(copy.openGuideOnComputer).click(); await flush(); });
    expect(container.querySelector('[role="alert"]')!.textContent).toBe(copy.permissionGuideUnknown);
    expect(container.textContent).not.toContain("Private guide failure");
    expect(native.receive.mock.calls.filter(call => call[0].type === "init")).toHaveLength(nativeInits);
    await act(async () => { button(copy.panelBack).click(); await flush(); });
    expect(container.querySelector('[data-testid="remoteDesktop.permissionGuide"]')).toBeNull();
    await act(async () => { button(copy.panelClose).click(); await flush(); });
    expect(container.querySelector('[data-testid="remoteDesktop.media"]')).toBe(media);
    expect(currentController.snapshot).toMatchObject({ status: "live", hasFrame: true, controlling: false });
    expect(value.stop).not.toHaveBeenCalled(); expect(value.start).toHaveBeenCalledTimes(1);
  });

  it("keeps terminal permission check and guide failures finite across offline recovery and retired receipts", async () => {
    const value = transport(), capabilities = await value.capabilities((await value.listHosts())[0]!);
    capabilities.permissions = create(RemoteDesktopPermissionsSchema, { screenRecording: RemoteDesktopPermissionStatus.MISSING,
      accessibility: RemoteDesktopPermissionStatus.UNSPECIFIED });
    value.permissions = vi.fn(async () => { throw new Error("Private check detail"); });
    await render(value);
    expect(container.querySelector('[role="alert"]')!.textContent).toBe(copy.permissionCheckFailed);
    expect(container.querySelector('[data-testid="remoteDesktop.permissionGuide"]')!.textContent).toContain(copy.permissionUnknown);
    vi.mocked(value.showPermissionGuide).mockRejectedValueOnce(new ConnectError("Private rejected guide", Code.PermissionDenied, undefined,
      [{ desc: RemoteDesktopFailureSchema, value: create(RemoteDesktopFailureSchema, { reason: RemoteDesktopFailureReason.ACCESSIBILITY_PERMISSION_REQUIRED }) }]));
    await act(async () => { button(copy.openGuideOnComputer).click(); await flush(); });
    expect(container.querySelector('[role="alert"]')!.textContent).toBe(copy.permissionActionFailed);
    let lateOpened!: (permissions: NonNullable<typeof capabilities.permissions>) => void;
    value.showPermissionGuide = vi.fn(() => new Promise<NonNullable<typeof capabilities.permissions>>(resolve => { lateOpened = resolve; }));
    await act(async () => { button(copy.openGuideOnComputer).click(); await flush(); });
    await render(value, { online: false });
    expect(button(copy.reconnectAfterPermissions).disabled).toBe(true);
    expect(container.textContent).toContain(copy.permissionGuideUnknown);
    await act(async () => { lateOpened(create(RemoteDesktopPermissionsSchema, { screenRecording: RemoteDesktopPermissionStatus.GRANTED,
      accessibility: RemoteDesktopPermissionStatus.GRANTED })); await flush(); });
    expect(container.textContent).not.toContain(copy.permissionsReady); expect(value.start).not.toHaveBeenCalled();
    value.permissions = vi.fn(async () => capabilities.permissions!);
    await render(value);
    expect(button(copy.reconnectAfterPermissions).disabled).toBe(false); expect(value.start).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Private");
  });

  it.each([
    { platform: "android" as const, landscape: false }, { platform: "android" as const, landscape: true },
    { platform: "ios" as const, landscape: false }, { platform: "ios" as const, landscape: true }
  ])("keeps the ordinary $platform toolbar and in-place pages reachable in landscape=$landscape, and returns before leaving", async ({ platform, landscape }) => {
    native.platform = platform;
    if (landscape) { native.width = 844; native.height = 390; }
    const value = transport(), capabilities = await value.capabilities((await value.listHosts())[0]!);
    capabilities.videoSettings = true; capabilities.hostMute = true; capabilities.lockOnExit = true;
    await render(value, { colors: { ...colors, dark: true } }); const epoch = await ready(); await streaming(epoch);
    const view = (id: string) => container.querySelector<HTMLDivElement>(`[data-testid="remoteDesktop.${id}"]`);
    const media = view("media")!;
    expect(view("operations")).toBeNull(); expect(view("toolbarPosition")).not.toBeNull();
    expect(media.style.position).toBe("");
    if (platform === "ios") {
      expect(view("toolbar")!.style.width).toBe(`${landscape ? 44 : 176}px`);
      expect(view("toolbar")!.style.height).toBe(`${landscape ? 176 : 44}px`);
    } else {
      expect(view("toolbar")!.style.flexDirection).toBe(landscape ? "column" : "row");
    }
    await act(async () => { button(copy.settings).click(); await flush(); });
    expect(container.textContent).toContain(copy.controls);
    expect(button(copy.audioOn)).toBeDefined();
    expect(container.querySelector(`[aria-label="${copy.hostMute}"]`)).toBeNull();
    if (platform === "ios") {
      expect(container.querySelector(`[data-native-presentation="${landscape ? "popover" : "sheet"}"]`)).not.toBeNull();
      expect(Array.from(container.querySelectorAll("[data-native-theme]")).every(item => item.getAttribute("data-native-theme") === "dark")).toBe(true);
      if (!landscape) expect(container.querySelector('[data-native-modifiers*="presentationDetents"]')?.getAttribute("data-native-modifiers"))
        .toContain('["medium","large"]');
    } else expect(view("operationsPanel")!.style[landscape ? "right" : "bottom"]).toBe("76px");
    await act(async () => { button(copy.displaySettings).click(); await flush(); });
    expect(container.textContent).toContain(copy.frameRate);
    expect(container.querySelector(`[aria-label="${copy.audioOn}"]`)).toBeNull();
    expect(button(copy.chooseDisplay).disabled).toBe(true);
    await act(async () => { expect(native.back!()).toBe(true); await flush(); });
    expect(button(copy.security)).toBeDefined();
    await act(async () => { button(copy.security).click(); await flush(); });
    expect(button(copy.hostMute)).toBeDefined(); expect(button(copy.lockOnExit)).toBeDefined();
    expect(container.querySelector(`[aria-label="${copy.chooseDisplay}"]`)).toBeNull();
    await act(async () => { button(copy.panelBack).click(); await flush(); });
    expect(button(copy.displaySettings)).toBeDefined();
    await act(async () => { expect(native.back!()).toBe(true); await flush(); });
    expect(view("operations")).toBeNull(); expect(view("media")).toBe(media); expect(callbacks.onClose).not.toHaveBeenCalled();
    await act(async () => { button(copy.keyboard).click(); await flush(); });
    expect(view("keyboard")).not.toBeNull(); expect(view("toolbarPosition")).toBeNull();
    await act(async () => { expect(native.back!()).toBe(true); await flush(); });
    expect(view("keyboard")).toBeNull(); expect(view("toolbarPosition")).not.toBeNull();
    await act(async () => { button(copy.settings).click(); await flush(); });
    if (platform === "ios") {
      await act(async () => { container.querySelector('[data-native-presentation]')!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); await flush(); });
    } else await act(async () => { button(copy.panelClose).click(); await flush(); });
    expect(view("operations")).toBeNull();
    await act(async () => { button(copy.settings).click(); await flush(); });
    await render(value, { routeFocused: false, interactive: false, colors: { ...colors, dark: true } });
    expect(view("operations")).toBeNull();
    await render(value, { colors: { ...colors, dark: true } });
    expect(view("operations")).toBeNull(); expect(value.start).toHaveBeenCalledTimes(1); expect(callbacks.onClose).not.toHaveBeenCalled();
  });

  it.each(["android", "ios"] as const)("switches a live display from the actual %s catalog selector after retiring the previous lease", async platform => {
    native.platform = platform;
    const value = transport(), capabilities = await value.capabilities((await value.listHosts())[0]!);
    const side = create(RemoteDesktopDisplaySchema, { displayId: "display-side", name: "Side", width: 1280, height: 720 });
    capabilities.displays.push(side);
    value.start = vi.fn(async (_host, id) => create(RemoteDesktopLeaseSchema, { leaseId: `lease-${id}`,
      display: capabilities.displays.find(display => display.displayId === id)!, controlling: true, controlGeneration: 1n }));
    await render(value);
    await act(async () => { button("Main").click(); await flush(); });
    const epoch = await ready(); await streaming(epoch);
    await act(async () => { button(copy.settings).click(); await flush(); button(copy.displaySettings).click(); await flush(); });
    if (platform === "android") await act(async () => { button(copy.chooseDisplay).click(); await flush(); });
    const currentLabel = platform === "ios" ? "Main · 1920 × 1080" : "Main";
    expect(button(currentLabel).getAttribute("aria-checked")).toBe("true");
    await act(async () => { button(currentLabel).click(); await flush(); });
    expect(value.start).toHaveBeenCalledTimes(1); expect(value.stop).not.toHaveBeenCalled();
    let stopped!: () => void;
    value.stop = vi.fn(() => new Promise<void>(resolve => { stopped = resolve; }));
    await act(async () => { button(platform === "ios" ? "Side · 1280 × 720" : "Side").click(); await flush(); });
    expect(value.stop).toHaveBeenCalledWith(expect.objectContaining({ displayName: "Desk" }), "lease-display-current",
      { controlGeneration: 0n, lockScreen: false }, expect.any(AbortSignal));
    expect(value.start).toHaveBeenCalledTimes(1); expect(currentController.snapshot.displaySwitchBusy).toBe(true);
    expect(container.textContent).toContain(copy.displaySwitching); expect(container.querySelector('[data-testid="remoteDesktop.operations"]')).toBeNull();
    expect(native.receive.mock.calls.some(call => call[0].type === "stop")).toBe(true);
    await act(async () => { stopped(); await flush(); });
    expect(value.start).toHaveBeenCalledTimes(2);
    expect(currentController.snapshot).toMatchObject({ selectedDisplayId: "display-side", displaySwitchBusy: false, hasFrame: false });
    expect(vi.mocked(value.capabilities).mock.invocationCallOrder.at(-1)).toBeGreaterThan(vi.mocked(value.stop).mock.invocationCallOrder[0]!);
    expect(native.receive.mock.calls.map(call => call[0]).findLast(command => command.type === "init")?.epoch).not.toBe(epoch);
  });

  it("shows unresolved display stop and missing catalog recovery without hiding the current picker", async () => {
    const value = transport(), capabilities = await value.capabilities((await value.listHosts())[0]!);
    const side = create(RemoteDesktopDisplaySchema, { displayId: "display-side", name: "Side", width: 1280, height: 720 });
    capabilities.displays.push(side);
    await render(value); await act(async () => { button("Main").click(); await flush(); });
    const epoch = await ready(); await streaming(epoch);
    await act(async () => { button(copy.settings).click(); await flush(); button(copy.displaySettings).click(); await flush(); });
    vi.mocked(value.stop).mockRejectedValueOnce(new Error("Private disconnect detail"));
    await act(async () => { button("Side · 1280 × 720").click(); await flush(); });
    expect(container.textContent).toContain(copy.displaySwitchFailed); expect(container.textContent).not.toContain("Private disconnect detail");
    expect(value.start).toHaveBeenCalledTimes(1);
    capabilities.displays = capabilities.displays.filter(display => display.displayId !== "display-side");
    await act(async () => { button(copy.retry).click(); await flush(); });
    expect(container.textContent).toContain(copy.displayUnavailable); expect(currentController.snapshot.status).toBe("select-display");
    expect(button("Main").disabled).toBe(false); expect(value.start).toHaveBeenCalledTimes(1);
    await act(async () => { button("Main").click(); await flush(); });
    expect(value.start).toHaveBeenCalledTimes(2); expect(currentController.snapshot.selectedDisplayId).toBe("display-current");
  });

  it("projects divided and reserved windows into the measured media canvas, moves keyboard controls, and retires original relative gestures", async () => {
    const value = transport();
    native.width = 800; native.height = 1000;
    native.geometry = { width: 800, height: 1000, insets: { top: 20, right: 10, bottom: 20, left: 10 },
      regularWidth: true, regularHeight: true, barEdge: "none", reservedRegionsSupported: true,
      regions: [{ kind: "division", x: 10, y: 480, width: 780, height: 40 }] };
    native.measured = { x: 10, y: 82, width: 780, height: 898 };
    native.values.set(mouseButtonsKey, JSON.stringify({ version: 1, enabled: true }));
    await render(value); const epoch = await ready(); await streaming(epoch);
    const view = (id: string) => container.querySelector<HTMLDivElement>(`[data-testid="remoteDesktop.${id}"]`)!;
    const viewport = () => native.htmlCommands.findLast(command => command.type === "viewport");
    const assertSharedMedia = (width: number, height: number) => {
      expect(view("media").style.width).toBe(`${width}px`); expect(view("media").style.height).toBe(`${height}px`);
      expect(container.querySelector("[data-native-visible]")!.parentElement).toBe(view("media"));
      expect(container.querySelector("[data-viewer-overlay]")!.parentElement).toBe(view("media"));
    };
    type Touch = { nativeEvent: { identifier: number; pageX: number; pageY: number } };
    type Pad = { onResponderGrant(event: Touch): void; onResponderMove(event: Touch): void; onResponderRelease(event: Touch): void };
    const pad = () => native.viewProperties.get("remoteDesktop.foldTouchpad") as unknown as Pad;
    const touch = (x: number, y: number): Touch => ({ nativeEvent: { identifier: 7, pageX: x, pageY: y } });
    assertSharedMedia(780, 898);
    expect(viewport()).toEqual({ type: "viewport", epoch, fitToInsets: true, topInset: 0, bottomInset: 500 });
    expect(view("foldControls").style.top).toBe("438px"); expect(view("foldControls").style.height).toBe("460px");
    expect(container.querySelector('[data-keyboard-avoiding="false"]')).not.toBeNull();
    expect(view("operations")).toBeNull();
    const toolbar = view("toolbarPosition");
    expect(toolbar.querySelector(`[aria-label="${copy.allWindows}"]`)).not.toBeNull();
    await act(async () => { (toolbar.querySelector(`[aria-label="${copy.showDesktop}"]`) as HTMLButtonElement).click(); await flush(); });
    expect(native.htmlCommands.findLast(command => command.type === "events")).toMatchObject({
      events: [{ kind: "key", code: "F11", down: true }, { kind: "key", code: "F11", down: false }] });
    const oldPad = pad();
    await act(async () => { oldPad.onResponderGrant(touch(100, 600)); oldPad.onResponderMove(touch(105, 607)); await flush(); });
    const firstStart = native.htmlCommands.findLast(command => command.type === "nativeTouchpad" && command.event === "start")!;
    expect(firstStart).toMatchObject({ epoch, event: "start" });
    expect(native.htmlCommands.findLast(command => command.type === "nativeTouchpad")).toEqual({ type: "nativeTouchpad", epoch,
      id: firstStart.id, event: "move", dx: 5, dy: 7 });
    native.keyboard = { visible: true, height: 350 };
    await act(async () => { button(copy.keyboard).click(); await flush(); });
    expect(view("foldTouchpad")).toBeNull(); expect(view("toolbarPosition")).toBeNull();
    expect(container.querySelector('[data-testid="remoteDesktop.mouse-left"]')).toBeNull();
    expect(native.htmlCommands.filter(command => command.type === "nativeTouchpad" && command.id === firstStart.id && command.event === "cancel")).toHaveLength(1);
    expect(view("keyboard").style.bottom).toBe("500px"); expect(view("keyboard").style.maxHeight).toBe("398px");
    await act(async () => {
      (native.viewProperties.get("remoteDesktop.controlsPanel")!.onLayout as (event: object) => void)({ nativeEvent: { layout: { height: 200 } } });
      await flush();
    });
    assertSharedMedia(780, 898);
    expect(viewport()).toEqual({ type: "viewport", epoch, fitToInsets: true, topInset: 0, bottomInset: 700 });
    expect(container.querySelector('[data-keyboard-avoiding="false"]')).not.toBeNull();
    await act(async () => { button(copy.computerKeyboard).click(); await flush(); });
    expect(view("keyboard").style.bottom).toBe("0px"); expect(view("keyboard").style.maxHeight).toBe("460px");
    expect(viewport()).toMatchObject({ fitToInsets: true, bottomInset: 500 });
    await act(async () => { button(copy.closeKeyboard).click(); await flush(); });
    expect(view("foldTouchpad")).not.toBeNull();
    const newPad = pad();
    await act(async () => { newPad.onResponderGrant(touch(100, 600)); await flush(); });
    const replacementStart = native.htmlCommands.findLast(command => command.type === "nativeTouchpad" && command.event === "start")!;
    expect(replacementStart.id).not.toBe(firstStart.id);
    const beforeLateRelease = native.htmlCommands.filter(command => command.type === "nativeTouchpad").length;
    await act(async () => { oldPad.onResponderRelease(touch(105, 607)); await flush(); });
    expect(native.htmlCommands.filter(command => command.type === "nativeTouchpad")).toHaveLength(beforeLateRelease);
    await act(async () => { newPad.onResponderRelease(touch(100, 600)); await flush(); });
    expect(native.htmlCommands.findLast(command => command.type === "nativeTouchpad")).toEqual({ type: "nativeTouchpad", epoch,
      id: replacementStart.id, event: "end", tap: true });
    await act(async () => { button(copy.settings).click(); await flush(); });
    expect(view("foldTouchpad")).toBeNull(); expect(view("operations")).not.toBeNull();
    expect(button(copy.disconnect)).toBeDefined(); expect(button(copy.backgroundViewing)).toBeDefined();
    await act(async () => { button(copy.closeSettings).click(); await flush(); });
    expect(view("foldTouchpad")).not.toBeNull();
    const horizontalPad = pad();
    await act(async () => { horizontalPad.onResponderGrant(touch(110, 610)); await flush(); });
    const horizontalStart = native.htmlCommands.findLast(command => command.type === "nativeTouchpad" && command.event === "start")!;
    native.width = 1000; native.height = 800;
    native.geometry = { ...native.geometry, width: 1000, height: 800,
      regions: [{ kind: "division", x: 480, y: 20, width: 40, height: 760 }] };
    native.measured = { x: 10, y: 82, width: 980, height: 698 };
    await render(value);
    assertSharedMedia(470, 698);
    expect(viewport()).toEqual({ type: "viewport", epoch, fitToInsets: false, topInset: 0, bottomInset: 0 });
    expect(view("foldControls").style.left).toBe("510px"); expect(view("foldControls").style.width).toBe("470px");
    expect(native.htmlCommands.filter(command => command.type === "nativeTouchpad" && command.id === horizontalStart.id && command.event === "cancel")).toHaveLength(1);
    const beforeOldMove = native.htmlCommands.filter(command => command.type === "nativeTouchpad").length;
    await act(async () => { horizontalPad.onResponderMove(touch(200, 630)); horizontalPad.onResponderRelease(touch(200, 630)); await flush(); });
    expect(native.htmlCommands.filter(command => command.type === "nativeTouchpad")).toHaveLength(beforeOldMove);
    native.width = 1200; native.height = 800;
    native.geometry = { ...native.geometry, width: 1200, height: 800, barEdge: "right",
      regions: [{ kind: "occlusion", x: 1100, y: 82, width: 90, height: 200 }] };
    native.measured = { x: 10, y: 82, width: 1180, height: 698 };
    await render(value);
    assertSharedMedia(1180, 698);
    expect(view("foldTouchpad")).toBeNull();
    expect(view("toolbarPosition").style).toMatchObject({ left: "1120px", top: "260px", width: "60px", height: "438px" });
    for (const compact of Array.from(view("toolbarPosition").querySelectorAll("button"))) {
      expect(compact.style.width).toBe("44px"); expect(compact.style.height).toBe("44px"); expect(compact.querySelector("svg")).not.toBeNull();
    }
    expect(native.htmlCommands.some(command => command.type === "init" && command.epoch !== epoch)).toBe(false);
    expect(value.start).toHaveBeenCalledTimes(1);
    await render(value, { online: false });
    expect(button(copy.showDesktop).disabled).toBe(true);
  });

  it("saves phone mouse settings before a live frame, preserves a new mode over late hydration and reuses durable choices on another target", async () => {
    const value = transport(), hosts = await value.listHosts();
    let loadedHosts!: (available: typeof hosts) => void, lateMode!: (value: string | null) => void;
    value.listHosts = vi.fn(() => new Promise<typeof hosts>(resolve => { loadedHosts = resolve; }));
    native.getItem.mockImplementation(key => key === inputModeKey
      ? new Promise(resolve => { lateMode = resolve; }) : Promise.resolve(native.values.get(key) ?? null));
    await render(value);
    expect(currentController.snapshot.status).toBe("loading");
    await act(async () => { button(copy.settings).click(); await flush(); });
    expect(button(copy.mouseButtons).disabled).toBe(false);
    await act(async () => { button(copy.mouseButtons).click(); await flush(); });
    expect(native.values.get(mouseButtonsKey)).toBe(JSON.stringify({ version: 1, enabled: true }));
    expect(container.querySelector('[data-testid="remoteDesktop.mouse-left"]')).toBeNull();
    await act(async () => { button(copy.panelClose).click(); await flush(); });
    await act(async () => { loadedHosts(hosts); await flush(); });
    const epoch = await ready();
    expect(currentController.snapshot.hasFrame).toBe(false);
    expect(native.htmlCommands.findLast(command => command.type === "mouseButtons")).toMatchObject({ epoch, enabled: false, nativeControls: true });
    await streaming(epoch);
    const mouse = () => container.querySelector('[data-testid="remoteDesktop.mouse-left"]');
    expect(mouse()?.getAttribute("aria-label")).toBe(copy.leftMouseButton);
    expect(native.htmlCommands.findLast(command => command.type === "mouseButtons")).toEqual({ type: "mouseButtons", epoch,
      enabled: true, nativeControls: true, labels: { left: copy.leftMouseButton, right: copy.rightMouseButton, wheel: copy.mouseWheel } });
    const touch = new Event("touchstart", { bubbles: true });
    Object.defineProperties(touch, { identifier: { value: 7 }, pageY: { value: 300 } });
    await act(async () => { mouse()!.dispatchEvent(touch); await flush(); });
    expect(native.htmlCommands.findLast(command => command.type === "nativeMouse"))
      .toEqual({ type: "nativeMouse", epoch, control: "left", event: "pointerdown", id: 0, y: 300 });
    const retiredMouse = mouse()!, oldTouchEnd = native.mouseTouchEnds.get("remoteDesktop.mouse-left")!;
    await act(async () => { webMessage({ type: "mouseControlsRetired", epoch }); await flush(); });
    expect(mouse()).not.toBe(retiredMouse);
    const newTouch = new Event("touchstart", { bubbles: true });
    Object.defineProperties(newTouch, { identifier: { value: 7 }, pageY: { value: 320 } });
    await act(async () => { mouse()!.dispatchEvent(newTouch); await flush(); });
    expect(native.htmlCommands.findLast(command => command.type === "nativeMouse"))
      .toEqual({ type: "nativeMouse", epoch, control: "left", event: "pointerdown", id: 0, y: 320 });
    const beforeOldUp = native.htmlCommands.filter(command => command.type === "nativeMouse").length;
    await act(async () => { oldTouchEnd({ nativeEvent: { identifier: 7, pageY: 300 } }); await flush(); });
    expect(native.htmlCommands.filter(command => command.type === "nativeMouse")).toHaveLength(beforeOldUp);
    const newTouchEnd = new Event("touchend", { bubbles: true });
    Object.defineProperties(newTouchEnd, { identifier: { value: 7 }, pageY: { value: 320 } });
    await act(async () => { mouse()!.dispatchEvent(newTouchEnd); await flush(); });
    expect(native.htmlCommands.findLast(command => command.type === "nativeMouse"))
      .toEqual({ type: "nativeMouse", epoch, control: "left", event: "pointerup", id: 0, y: 320 });
    await act(async () => { button(copy.settings).click(); await flush(); });
    await act(async () => { button(copy.trackpad).click(); await flush(); });
    expect(currentController.snapshot.inputMode).toBe("trackpad");
    expect(native.values.get(inputModeKey)).toBe(JSON.stringify({ version: 1, mode: "trackpad" }));
    await act(async () => { lateMode(JSON.stringify({ version: 1, mode: "touch" })); await flush(); });
    expect(currentController.snapshot.inputMode).toBe("trackpad");
    const savedModes = native.setItem.mock.calls.filter(call => call[0] === inputModeKey).length;
    await act(async () => { button(copy.pan).click(); await flush(); });
    expect(currentController.snapshot.inputMode).toBe("pan");
    expect(native.setItem.mock.calls.filter(call => call[0] === inputModeKey)).toHaveLength(savedModes);
    native.getItem.mockImplementation(async key => native.values.get(key) ?? null);
    const replacement = transport("owner-other-target", "desktop-other");
    await render(replacement, { preferredDeviceId: "desktop-other" });
    const nextEpoch = await ready(); await streaming(nextEpoch);
    expect(currentController.snapshot).toMatchObject({ inputMode: "trackpad", mouseButtons: true, controlling: true });
    expect(mouse()).not.toBeNull();
    await act(async () => { button(copy.keyboard).click(); await flush(); });
    expect(mouse()).toBeNull();
    expect(native.htmlCommands.findLast(command => command.type === "mouseButtons")).toMatchObject({ epoch: nextEpoch, enabled: false, nativeControls: true });
    await act(async () => { button(copy.closeKeyboard).click(); await flush(); });
    expect(mouse()).not.toBeNull();
    await act(async () => { button(copy.settings).click(); await flush(); });
    await act(async () => { button(copy.mouseButtons).click(); await flush(); });
    expect(mouse()).toBeNull();
    expect(native.values.get(mouseButtonsKey)).toBe(JSON.stringify({ version: 1, enabled: false }));
    await act(async () => { button(copy.mouseButtons).click(); await flush(); button(copy.view).click(); await flush(); });
    expect(currentController.snapshot).toMatchObject({ controlling: true, viewOnly: true, wantedControl: false }); expect(mouse()).toBeNull();
    await act(async () => { button(copy.control).click(); await flush(); });
    await act(async () => { button(copy.panelClose).click(); await flush(); });
    expect(mouse()).not.toBeNull();
    await render(replacement, { preferredDeviceId: "desktop-other", online: false });
    expect(mouse()).toBeNull();
    expect(native.htmlCommands.findLast(command => command.type === "mouseButtons")).toMatchObject({ enabled: false });
  });

  it("projects the original epoch through the captured native handle and keeps native proof separate from transparent HTML input", async () => {
    const value = transport(); await render(value); const epoch = await ready();
    const init = native.receive.mock.calls.map(call => call[0]).findLast(command => command.type === "init")!;
    expect(init).toMatchObject({ epoch, webrtc: true, audio: true });
    expect(init).not.toHaveProperty("nativeVideo");
    expect(native.htmlCommands.findLast(command => command.type === "init")).toMatchObject({ epoch, nativeVideo: true });
    const iframe = document.createElement("iframe"); container.append(iframe);
    iframe.contentDocument!.documentElement.innerHTML = native.webProps!.source.html;
    expect(iframe.contentWindow!.getComputedStyle(iframe.contentDocument!.body).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    iframe.remove();
    await act(async () => { webMessage({ type: "videoFrameReady", epoch, attemptId }); webMessage({ type: "streaming", epoch, attemptId }); await flush(); });
    expect(currentController.snapshot.hasFrame).toBe(false);
    await streaming(epoch);
    expect(currentController.snapshot).toMatchObject({ status: "live", hasFrame: true, pipAvailable: true });
    expect(native.htmlCommands.findLast(command => command.type === "nativeVideo")).toEqual({ type: "nativeVideo", epoch, attemptId });
    expect(native.receive.mock.calls.some(call => call[0].type === "init" && call[0].epoch !== epoch)).toBe(false);
    await act(async () => { webMessage({ type: "input", epoch, sequence: 1, events: [{ kind: "key", code: "KeyA", down: true }] }); await flush(); });
    expect(native.sendInput).toHaveBeenCalledWith(expect.objectContaining({ epoch, attemptId, controlGeneration: "1",
      sequenceBase: 0, sequence: 1, events: [{ kind: "key", code: "KeyA", down: true }] }));
    expect(value.input).not.toHaveBeenCalled();
    const existingNetwork = currentController.snapshot.network;
    await act(async () => { webMessage({ type: "network", epoch, attemptId, transport: "direct", bytesPerSecond: 600_000, latencyMs: 18 }); await flush(); });
    expect(currentController.snapshot.network).toBe(existingNetwork);
    await act(async () => { nativeMessage(epoch, "network", { transport: "direct", bytesPerSecond: 600_000, latencyMs: 18 }); await flush(); });
    expect(container.textContent).toContain("600 KB/s · 18 ms");
    await act(async () => { button(copy.keyboard).click(); await flush(); });
    expect(currentController.snapshot.keyboardOpen).toBe(true);
    expect(container.textContent).not.toContain("600 KB/s · 18 ms");
    expect(button(copy.closeKeyboard)).toBeDefined();
    await act(async () => { button(copy.closeKeyboard).click(); await flush(); });
    expect(container.textContent).toContain("600 KB/s · 18 ms");
  });

  it("adopts background intent after durable save, reserves Home before foreground loss, and restores through route focus", async () => {
    const value = transport(); await render(value); const epoch = await ready(); await streaming(epoch);
    await act(async () => { button(copy.settings).click(); await flush(); });
    let saved!: () => void;
    native.setItem.mockImplementationOnce(async (key, encoded) => { await new Promise<void>(resolve => { saved = resolve; }); native.values.set(key, encoded); });
    await act(async () => { button(copy.backgroundViewing).click(); await flush(); });
    expect(native.setItem).toHaveBeenCalledWith(pipKey, JSON.stringify({ version: 1, enabled: true }));
    expect(currentController.snapshot.backgroundViewing).toBe(false);
    await act(async () => { saved(); await flush(); });
    expect(currentController.snapshot.backgroundViewing).toBe(true);
    const interactive = vi.spyOn(currentController, "setInteractive"), foreground = vi.spyOn(currentController, "setForeground");
    await act(async () => { lifecycle!({ state: "background", interactive: false, transportForeground: false,
      enteredBackground: true, enteredForeground: false }); await flush(); });
    expect(interactive).toHaveBeenCalledWith(false); expect(foreground).toHaveBeenCalledWith(false);
    expect(interactive.mock.invocationCallOrder[0]).toBeLessThan(foreground.mock.invocationCallOrder[0]!);
    expect(value.beginBackgroundTransition).toHaveBeenCalledTimes(1);
    await act(async () => { nativeMessage(epoch, "presentation", { active: true }); await flush(); });
    expect(currentController.snapshot.presenting).toBe(true);
    await render(value, { routeFocused: false, interactive: false, foreground: false });
    expect(native.viewProps!.inlineVisible).toBe(false);
    await act(async () => { nativeMessage(epoch, "presentationRestore", { restoreId: 7, inlineVisible: false, sourceHidden: true }); await flush(); });
    expect(callbacks.onRestore).toHaveBeenCalledTimes(1);
    expect(native.receive.mock.calls.some(call => call[0].type === "restorePresentation")).toBe(false);
    await render(value);
    expect(native.viewProps!.inlineVisible).toBe(true);
    expect(native.receive.mock.calls.map(call => call[0]).findLast(command => command.type === "restorePresentation"))
      .toEqual({ type: "restorePresentation", epoch, attemptId, restoreId: 7 });
    await act(async () => { nativeMessage(epoch, "presentation", { active: false }); await flush(); });
    expect(currentController.snapshot).toMatchObject({ presenting: false, controlling: true, wantedControl: true });
    expect(currentController.snapshot.restoreRequest).toBeUndefined();
    expect(native.values.get(pipKey)).toBe(JSON.stringify({ version: 1, enabled: true }));
  });

  it("settles real rotation receipts and discards a late result after the Screen owner changes", async () => {
    const value = transport(); await render(value); const epoch = await ready(); await streaming(epoch);
    await act(async () => { button(copy.settings).click(); await flush(); });
    let rotated!: () => void;
    native.rotate.mockImplementationOnce(() => new Promise<void>(resolve => { rotated = resolve; }));
    await act(async () => { button(copy.rotate).click(); await flush(); });
    expect(native.rotate).toHaveBeenCalledWith(true); expect(button(copy.rotate).disabled).toBe(true);
    await act(async () => { rotated(); await flush(); });
    expect(button(copy.rotate).disabled).toBe(false);
    native.rotate.mockRejectedValueOnce(new Error("Private native detail"));
    await act(async () => { button(copy.rotate).click(); await flush(); });
    expect(container.textContent).toContain(copy.rotationFailed);
    expect(container.textContent).not.toContain("Private native detail");
    let lateFailure!: (reason: unknown) => void;
    native.rotate.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { lateFailure = reject; }));
    await act(async () => { button(copy.rotate).click(); await flush(); });
    const replacement = transport("owner-replacement"); await render(replacement); const replacementEpoch = await ready(); await streaming(replacementEpoch);
    await act(async () => { button(copy.settings).click(); await flush(); });
    await act(async () => { lateFailure(new Error("Retired owner failure")); await flush(); });
    expect(currentController.snapshot.status).toBe("live");
    expect(button(copy.rotate).disabled).toBe(false);
    expect(container.textContent).not.toContain(copy.rotationFailed);
  });
});
