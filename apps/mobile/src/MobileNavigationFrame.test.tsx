// @vitest-environment jsdom
import { act, createElement, type ComponentProps, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { MobileNavigationFrame } from "./MobileNavigationFrame.ios";
import { MobileTaskHeader } from "./MobileTaskHeader";
import { useMobileTaskHeaderRole } from "./use-mobile-task-header-role";
import type { MobileTaskHeaderRole } from "./mobile-task-header-role";

const { environment } = vi.hoisted(() => ({ environment: {
  state: "active", edge: "none" as "none" | "left" | "right", listeners: new Set<(state: string) => void>()
} }));
let scene: ComponentProps<typeof import("react-native-screens").Screen>;
let chrome: ComponentProps<typeof import("react-native-screens").ScreenStackHeaderConfig>;
let nativeTarget = 0, nextNativeTarget = 0;
const nativeTargets = new Map<number, typeof chrome>();
/** The SDK addresses each button by position and dispatches to its current target's props. */
function dispatchNativeButton(target: number, buttonId: string): void {
  const props = nativeTargets.get(target);
  const [position, side] = buttonId.split("-");
  const item = (side === "right" ? props?.headerRightBarButtonItems : props?.headerLeftBarButtonItems)?.[Number(position)];
  if (item?.type === "button") item.onPress();
}
vi.mock("../assets/navigation/monitor.png", () => ({ default: 101 }));
vi.mock("../assets/navigation/folder.png", () => ({ default: 102 }));
vi.mock("react-native", async () => {
  const { createElement: element } = await import("react");
  const primitive = ({ children, testID, accessibilityRole, accessibilityLabel, style }: {
    children?: ReactNode; testID?: string; accessibilityRole?: string; accessibilityLabel?: string; style?: unknown;
  }) => element("div", { "data-testid": testID, role: accessibilityRole, "aria-label": accessibilityLabel, "data-style": JSON.stringify(style) }, children);
  return { Platform: { OS: "ios" }, View: primitive, Text: primitive, ActivityIndicator: primitive,
    AppState: { get currentState() { return environment.state; }, addEventListener: (_event: string, listener: (state: string) => void) => {
      environment.listeners.add(listener); return { remove: () => environment.listeners.delete(listener) };
    } },
    Pressable: ({ children, accessibilityRole, accessibilityLabel, disabled, onPress }: {
      children?: ReactNode; accessibilityRole?: string; accessibilityLabel?: string; disabled?: boolean; onPress?: () => void;
    }) => element("button", { role: accessibilityRole, "aria-label": accessibilityLabel, disabled, onClick: onPress }, children),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 }, useWindowDimensions: () => ({ width: 390, height: 844 }) };
});
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 24, right: 0, bottom: 20, left: 0 }) }));
vi.mock("react-native-screens", async () => {
  const { createElement: element, useLayoutEffect, useRef } = await import("react");
  const Surface = ({ children }: { children?: ReactNode }) => element("div", {}, children);
  return { ScreenStack: Surface, ScreenContentWrapper: Surface,
    ScreenStackHeaderLeftView: Surface, ScreenStackHeaderCenterView: Surface, ScreenStackHeaderRightView: Surface,
    Screen: (props: typeof scene) => { scene = props; return element("div", { "data-testid": "native-scene" }, props.children); },
    ScreenStackHeaderConfig: (props: typeof chrome) => {
      const target = useRef(++nextNativeTarget).current; nativeTarget = target; chrome = props; nativeTargets.set(target, props);
      useLayoutEffect(() => () => { nativeTargets.delete(target); }, [target]);
      return element("nav", { "data-native-target": target }, !props.hidden ? props.children : null);
    } };
});
vi.mock("./MobileAdaptiveWindow", () => ({ useMobileAdaptiveWindow: () => ({ width: 390, height: 844,
  insets: { top: 24, right: 0, bottom: 20, left: 0 }, barEdge: environment.edge }) }));
vi.mock("./MobileTaskHeaderIcon", () => ({ MobileTaskHeaderIcon: () => null }));
vi.mock("./MobileActionSheet", () => ({ MobileActionSheet: () => null }));

it("uses one UIKit scene across native, inline, rail and share headers while retiring stale native actions", () => {
  const host = document.createElement("div"), root = createRoot(host), files = vi.fn(), back = vi.fn(), toggle = vi.fn();
  environment.edge = "none";
  const props: ComponentProps<typeof MobileTaskHeader> = { title: "Current task", subtitle: "Idle", navigationLabel: "Back", onNavigate: back,
    quickSwitch: { label: "Open task list", onOpen: vi.fn() }, actions: [{ id: "files", label: "Files", disabled: false, onPress: files }],
    disabled: false, colors: { background: "#fff", surface: "#fff", ink: "#111", muted: "#777", border: "#ddd", negative: "#b00" },
    locale: "en", onMenuVisibilityChange: vi.fn(), pinned: true, notice: "Queue paused" };
  const render = (patch: Partial<typeof props> = {}, owner = "first", show = true, dark = false) => act(() => root.render(createElement(MobileNavigationFrame, { dark, children: [
    show ? createElement(MobileTaskHeader, { ...props, ...patch, key: owner }) : null,
    createElement("textarea", { key: "composer", defaultValue: "retained draft", "data-testid": "composer" })] })));
  try {
    render(); const composer = host.querySelector('[data-testid="composer"]'), nativeScene = host.querySelector('[data-testid="native-scene"]');
    expect(chrome).toMatchObject({ hidden: false, translucent: true, hideBackButton: true, disableTopInsetApplication: true,
      disableBottomInsetApplication: true, disableLeftInsetApplication: true, disableRightInsetApplication: true });
    expect(scene).toMatchObject({ activityState: 2, stackPresentation: "push", gestureEnabled: false, preventNativeDismiss: true });
    expect(host.querySelectorAll('[role="header"]')).toHaveLength(1); expect(host.querySelector('[data-testid="task.header.inline"]')).toBeNull();
    act(() => scene.onHeaderHeightChange!({ nativeEvent: { headerHeight: 68 } } as never));
    expect(JSON.parse(host.querySelector('[data-testid="task.header.system-spacer"]')!.getAttribute("data-style")!)).toEqual({ height: 44 });
    render({ persistentNavigation: true }); expect(chrome.hidden).toBe(true);
    expect(host.querySelector('[data-testid="task.header.inline"]')).not.toBeNull();
    environment.edge = "right"; render(); expect(chrome.hidden).toBe(false);
    const items = chrome.headerRightBarButtonItems!;
    expect(items.map(item => "identifier" in item && item.identifier)).toEqual(["remote-desktop", "files", "more"]);
    const fileItem = items[1]!; expect(fileItem.type).toBe("button");
    const backItem = chrome.headerLeftBarButtonItems!.find(item => "identifier" in item && item.identifier === "back");
    if (fileItem.type !== "button") throw new Error("Expected a native task action");
    const oldTarget = nativeTarget;
    act(() => dispatchNativeButton(oldTarget, "1-right")); expect(files).toHaveBeenCalledOnce();
    render({ detailsOnly: true }); expect(chrome.headerRightBarButtonItems).toHaveLength(1);
    expect(nativeTarget).not.toBe(oldTarget);
    act(() => dispatchNativeButton(oldTarget, "0-right")); expect(props.onMenuVisibilityChange).not.toHaveBeenCalledWith(true);
    act(() => fileItem.onPress()); expect(files).toHaveBeenCalledOnce();
    render({ selection: { allSelected: false, busy: false, onToggleAll: toggle } });
    expect(chrome.hidden).toBe(true); expect(host.querySelectorAll("button")).toHaveLength(1);
    act(() => host.querySelector<HTMLButtonElement>("button")!.click()); expect(toggle).toHaveBeenCalledOnce();
    render({}, "second"); act(() => dispatchNativeButton(oldTarget, "1-right")); act(() => fileItem.onPress()); expect(files).toHaveBeenCalledOnce();
    if (backItem?.type === "button") act(() => backItem.onPress());
    expect(back).not.toHaveBeenCalled();
    const beforeBackground = nativeTarget, beforeBackgroundItem = chrome.headerRightBarButtonItems![1]!;
    act(() => { environment.state = "background"; for (const listener of environment.listeners) listener("background"); });
    expect(chrome.hidden).toBe(true);
    act(() => { environment.state = "active"; for (const listener of environment.listeners) listener("active"); });
    expect(nativeTarget).not.toBe(beforeBackground);
    act(() => dispatchNativeButton(beforeBackground, "1-right"));
    if (beforeBackgroundItem.type === "button") act(() => beforeBackgroundItem.onPress());
    expect(files).toHaveBeenCalledOnce();
    render({}, "second", false); expect(chrome.hidden).toBe(true);
    expect(host.querySelector('[data-testid="native-scene"]')).toBe(nativeScene);
    expect(host.querySelector('[data-testid="composer"]')).toBe(composer); expect((composer as HTMLTextAreaElement).value).toBe("retained draft");
    render({}, "second", true, true); expect(scene.statusBarStyle).toBe("light");
    expect(chrome.experimental_userInterfaceStyle).toBe("dark");
    expect(host.querySelector('[data-testid="composer"]')).toBe(composer);
  } finally { act(() => root.unmount()); environment.edge = "none"; }
  expect(environment.listeners.size).toBe(0);
});

it("clears old header membership on source and foreground retirement and supports explicit retry", async () => {
  vi.useFakeTimers();
  const host = document.createElement("div"), root = createRoot(host);
  let finish!: (role: MobileTaskHeaderRole) => void, signal!: AbortSignal;
  const client = { readTaskHeaderRole: vi.fn((_key: string, active: AbortSignal) => { signal = active;
    return new Promise<MobileTaskHeaderRole>(resolve => { finish = resolve; }); }) };
  function Read({ source }: { source: string }) {
    const role = useMobileTaskHeaderRole(client, source);
    return createElement("div", {}, createElement("output", {}, role.failed ? "failed" : role.role ?? "loading"),
      createElement("button", { onClick: role.retry }, "Retry"));
  }
  try {
    await act(async () => root.render(createElement(Read, { source: "first" })));
    const stale = finish, oldSignal = signal;
    await act(async () => root.render(createElement(Read, { source: "second" }))); expect(oldSignal.aborted).toBe(true);
    await act(async () => stale("worker")); expect(host.querySelector("output")!.textContent).toBe("loading");
    await act(async () => { environment.state = "background"; for (const listener of environment.listeners) listener("background"); });
    expect(signal.aborted).toBe(true); await act(async () => finish("worker")); expect(host.querySelector("output")!.textContent).toBe("loading");
    client.readTaskHeaderRole.mockRejectedValueOnce(new Error("unavailable"));
    await act(async () => { environment.state = "active"; for (const listener of environment.listeners) listener("active"); });
    expect(host.querySelector("output")!.textContent).toBe("failed");
    await act(async () => host.querySelector<HTMLButtonElement>("button")!.click());
    await act(async () => finish("worker")); expect(host.querySelector("output")!.textContent).toBe("worker");
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(host.querySelector("output")!.textContent).toBe("worker");
    await act(async () => finish("lead")); expect(host.querySelector("output")!.textContent).toBe("lead");
  } finally { act(() => root.unmount()); environment.state = "active"; expect(vi.getTimerCount()).toBe(0); vi.useRealTimers(); }
  expect(environment.listeners.size).toBe(0);
});
