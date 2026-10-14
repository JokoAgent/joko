// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { MobileTaskHeader, type MobileTaskHeaderAction } from "./MobileTaskHeader";
beforeAll(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterAll(() => vi.unstubAllGlobals());

const { appState, listeners, animations } = vi.hoisted(() => ({
  appState: { currentState: "active" },
  listeners: new Set<(state: string) => void>(),
  animations: [] as (() => void)[]
}));

vi.mock("react-native", async () => {
  const { createElement: element } = await import("react");
  const primitive = (tag: "div" | "span") => ({ children, accessibilityLabel, accessibilityRole }: {
    readonly children?: ReactNode; readonly accessibilityLabel?: string; readonly accessibilityRole?: string;
  }) => element(tag, { "aria-label": accessibilityLabel, role: accessibilityRole }, children);
  class Value {
    generation = 0;
    setValue() {}
    stopAnimation() { this.generation += 1; }
  }
  return {
    Platform: { OS: "android" }, ActivityIndicator: primitive("span"),
    AppState: { ...appState, get currentState() { return appState.currentState; },
      addEventListener: (_event: string, listener: (state: string) => void) => {
        listeners.add(listener); return { remove: () => listeners.delete(listener) };
      } },
    Animated: { Value, View: primitive("div"), timing: (value: Value, config: { toValue: number }) => ({
      start: (callback?: (result: { finished: boolean }) => void) => {
        const generation = value.generation;
        if (config.toValue === 0) callback?.({ finished: true });
        else animations.push(() => callback?.({ finished: generation === value.generation }));
      }
    }) },
    Easing: { cubic: () => undefined, in: () => undefined, out: () => undefined },
    Modal: ({ visible, children }: { readonly visible: boolean; readonly children?: ReactNode }) => visible
      ? element("div", { "data-modal": "true" }, children) : null,
    Pressable: ({ children, accessibilityLabel, disabled, onPress, accessibilityState }: {
      readonly children?: ReactNode; readonly accessibilityLabel?: string;
      readonly disabled?: boolean; readonly onPress?: () => void;
      readonly accessibilityState?: { readonly expanded?: boolean };
    }) => element("button", { "aria-label": accessibilityLabel, disabled, onClick: onPress, "aria-expanded": accessibilityState?.expanded }, children),
    ScrollView: primitive("div"), Text: primitive("span"), View: primitive("div"),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1, absoluteFill: {} },
    useWindowDimensions: () => ({ width: 360, height: 640 })
  };
});
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 16, left: 0, right: 0 }) }));
vi.mock("./MobileDrawer", () => ({ useReducedMotion: () => false }));
vi.mock("./MobileAdaptiveWindow", () => ({ useMobileAdaptiveWindow: () => ({ width: 360, height: 640,
  insets: { top: 24, bottom: 16, left: 0, right: 0 }, barEdge: "none" }) }));
vi.mock("./MobileTaskHeaderIcon", () => ({ MobileTaskHeaderIcon: ({ id }: { id: string }) => createElement("span", { "data-icon": id }) }));

it("opens the same Partner profile from its identity and settings button", () => {
  const container = document.createElement("div"); const root = createRoot(container); const open = vi.fn();
  try {
    act(() => root.render(createElement(MobileTaskHeader, {
      title: "Ada", subtitle: "Joko node", navigationLabel: "Back", onNavigate: vi.fn(),
      actions: [], disabled: false, locale: "en", onMenuVisibilityChange: vi.fn(),
      identity: { mark: createElement("span", {}, "avatar"), label: "Ada", settingsLabel: "Open Ada settings", disabled: false, onOpen: open },
      colors: { background: "#fff", surface: "#fff", ink: "#111", muted: "#666", border: "#ddd", negative: "#b00" }
    })));
    expect(container.querySelector('[role="header"]')?.textContent).toBe("Ada");
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Ada"]')!.click());
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Open Ada settings"]')!.click());
    expect(open).toHaveBeenCalledTimes(2);
  } finally { act(() => root.unmount()); }
});

it("keeps navigation and title in the header while task actions cancel, revalidate, and retire with their owner", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const navigate = vi.fn();
  const run = vi.fn();
  const visibility = vi.fn();
  const actions: MobileTaskHeaderAction[] = [
    { id: "clone", label: "Clone task", disabled: false, onPress: run },
    { id: "branches", label: "Branches", disabled: true, onPress: run },
    { id: "context", label: "Context", disabled: false, onPress: run },
    { id: "controls", label: "Controls", disabled: false, onPress: run },
    { id: "copy-link", label: "Copy task link", disabled: false, onPress: run },
    { id: "files", label: "Files", disabled: false, onPress: run },
    { id: "refresh", label: "Refresh", disabled: false, onPress: run }
  ];
  const render = (owner = "task-one", items = actions) => act(() => root.render(createElement(MobileTaskHeader, {
    key: owner, title: owner, subtitle: "Idle", navigationLabel: "Back to Tasks",
    onNavigate: navigate, actions: items, disabled: false, locale: "en", onMenuVisibilityChange: visibility,
    colors: { background: "#fafafa", surface: "#fff", ink: "#222", muted: "#666", border: "#ddd", negative: "#b00" }
  })));
  const click = (label: string) => {
    const button = (container.querySelector('[data-modal="true"]') ?? container).querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    expect(button, label).not.toBeNull();
    act(() => button!.click());
  };
  const finishClosing = () => act(() => { for (const finish of animations.splice(0)) finish(); });
  try {
    render();
    expect(container.querySelector('[role="header"]')?.textContent).toBe("task-one");
    expect(container.querySelectorAll("button")).toHaveLength(4);
    click("Back to Tasks");
    expect(navigate).toHaveBeenCalledOnce();

    click("Task actions");
    expect(container.querySelector('button[aria-label="Task actions"]')?.getAttribute("aria-expanded")).toBe("true");
    render("task-one", actions.map((action) => ({ ...action, disabled: true })));
    expect(container.querySelector('[data-modal="true"]')).not.toBeNull();
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Context"]')?.disabled).toBe(true);
    render();
    for (const action of actions) expect(container.querySelector(`button[aria-label="${action.label}"]`)).not.toBeNull();
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Branches"]')?.disabled).toBe(true);
    click("Context");
    expect(run).not.toHaveBeenCalled();
    finishClosing();
    expect(run).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-modal="true"]')).toBeNull();

    click("Task actions");
    click("Cancel");
    finishClosing();
    expect(run).toHaveBeenCalledOnce();

    click("Task actions");
    click("Files");
    render("task-one", actions.map((action) => ({ ...action, disabled: action.id === "files" })));
    finishClosing();
    expect(run).toHaveBeenCalledOnce();

    click("Task actions");
    click("Context");
    render("task-two");
    finishClosing();
    expect(run).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="header"]')?.textContent).toBe("task-two");

    click("Task actions");
    click("Files");
    act(() => { appState.currentState = "background"; for (const listener of listeners) listener("background"); });
    finishClosing();
    expect(run).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-modal="true"]')).toBeNull();
  } finally {
    act(() => root.unmount());
    appState.currentState = "active";
    animations.splice(0);
  }
  expect(listeners.size).toBe(0);
  expect(visibility).toHaveBeenLastCalledWith(false);
});

it("keeps Back independent from quick switching and removes quick switching in the persistent layout", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const navigate = vi.fn();
  const openList = vi.fn();
  const render = (persistentNavigation: boolean, quick = true) => act(() => root.render(createElement(MobileTaskHeader, {
    title: "Current task", subtitle: "Idle", navigationLabel: "Back to Home", onNavigate: navigate,
    quickSwitch: quick ? { label: "Switch task", onOpen: openList } : undefined,
    persistentNavigation, actions: [], disabled: true, locale: "en", onMenuVisibilityChange: vi.fn(),
    colors: { background: "#fff", surface: "#fff", ink: "#111", muted: "#666", border: "#ddd", negative: "#b00" }
  })));
  const back = () => container.querySelector<HTMLButtonElement>('button[aria-label="Back to Home"]')!;
  try {
    render(false);
    expect(back().querySelector('[data-icon="back"]')).not.toBeNull();
    expect(back().disabled).toBe(false);
    act(() => back().click());
    act(() => container.querySelector<HTMLButtonElement>('button[aria-label="Switch task"]')!.click());
    expect(navigate).toHaveBeenCalledOnce();
    expect(openList).toHaveBeenCalledOnce();
    render(true);
    expect(container.querySelector('button[aria-label="Switch task"]')).toBeNull();
    act(() => back().click());
    expect(navigate).toHaveBeenCalledTimes(2);
    render(false, false);
    expect(container.querySelector('button[aria-label="Switch task"]')).toBeNull();
    expect(back().querySelector('[data-icon="back"]')).not.toBeNull();
  } finally { act(() => root.unmount()); }
});

it("dispatches direct task actions through current capability state and restricts worker and selection chrome", () => {
  const container = document.createElement("div"), root = createRoot(container);
  const files = vi.fn(), desktop = vi.fn(), tags = vi.fn(), toggleAll = vi.fn();
  const props = { title: "Pinned task", subtitle: "Idle", navigationLabel: "Back", onNavigate: vi.fn(),
    actions: [
      { id: "files" as const, label: "Files", disabled: false, onPress: files },
      { id: "remote-desktop" as const, label: "Desktop", disabled: false, onPress: desktop },
      { id: "tags" as const, label: "Tags", disabled: false, onPress: tags }
    ], disabled: false, locale: "en" as const, onMenuVisibilityChange: vi.fn(), pinned: true, syncing: true,
    notice: "Queue paused", titleAccessory: createElement("span", {}, "tag dots"),
    colors: { background: "#fff", surface: "#fff", ink: "#111", muted: "#666", border: "#ddd", negative: "#b00" }
  };
  const click = (label: string) => act(() => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click());
  try {
    act(() => root.render(createElement(MobileTaskHeader, props)));
    click("Files"); click("Remote Desktop"); click("Manage tags");
    expect(files).toHaveBeenCalledOnce(); expect(desktop).toHaveBeenCalledOnce(); expect(tags).toHaveBeenCalledOnce();
    expect(container.querySelector('[aria-label="Pinned"]')).not.toBeNull(); expect(container.textContent).toContain("Queue paused");
    act(() => root.render(createElement(MobileTaskHeader, { ...props, primaryActionsReady: false })));
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Files"]')?.disabled).toBe(true); click("Files");
    expect(files).toHaveBeenCalledOnce();
    act(() => root.render(createElement(MobileTaskHeader, { ...props, detailsOnly: true })));
    expect(container.querySelector('button[aria-label="Files"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Remote Desktop"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Manage tags"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Task actions"]')).not.toBeNull();
    act(() => root.render(createElement(MobileTaskHeader, { ...props, selection: { allSelected: false, busy: false, onToggleAll: toggleAll } })));
    expect(container.querySelectorAll("button")).toHaveLength(1); expect(container.querySelector('[role="header"]')).toBeNull();
    click("Select all"); expect(toggleAll).toHaveBeenCalledOnce();
    act(() => root.render(createElement(MobileTaskHeader, { ...props, selection: { allSelected: true, busy: true, onToggleAll: toggleAll } })));
    expect(container.querySelector<HTMLButtonElement>("button")?.disabled).toBe(true);
  } finally { act(() => root.unmount()); }
});
