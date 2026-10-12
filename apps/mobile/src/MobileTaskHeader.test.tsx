// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { MobileTaskHeader, type MobileTaskHeaderAction } from "./MobileTaskHeader";

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
    Pressable: ({ children, accessibilityLabel, disabled, onPress }: {
      readonly children?: ReactNode; readonly accessibilityLabel?: string;
      readonly disabled?: boolean; readonly onPress?: () => void;
    }) => element("button", { "aria-label": accessibilityLabel, disabled, onClick: onPress }, children),
    ScrollView: primitive("div"), Text: primitive("span"), View: primitive("div"),
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1, absoluteFill: {} },
    useWindowDimensions: () => ({ width: 360, height: 640 })
  };
});
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 16, left: 0, right: 0 }) }));
vi.mock("./MobileDrawer", () => ({ useReducedMotion: () => false }));

it("opens the same Partner profile from its identity and settings button", () => {
  const container = document.createElement("div"); const root = createRoot(container); const open = vi.fn();
  try {
    act(() => root.render(createElement(MobileTaskHeader, {
      title: "Ada", subtitle: "Joko node", navigationLabel: "Back", drawerNavigation: false, onNavigate: vi.fn(),
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
    key: owner, title: owner, subtitle: "Idle", navigationLabel: "Back to Tasks", drawerNavigation: false,
    onNavigate: navigate, actions: items, disabled: false, locale: "en", onMenuVisibilityChange: visibility,
    colors: { background: "#fafafa", surface: "#fff", ink: "#222", muted: "#666", border: "#ddd", negative: "#b00" }
  })));
  const click = (label: string) => {
    const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    expect(button, label).not.toBeNull();
    act(() => button!.click());
  };
  const finishClosing = () => act(() => { for (const finish of animations.splice(0)) finish(); });
  try {
    render();
    expect(container.querySelector('[role="header"]')?.textContent).toBe("task-one");
    expect(container.querySelectorAll("button")).toHaveLength(2);
    click("Back to Tasks");
    expect(navigate).toHaveBeenCalledOnce();

    click("Task actions");
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
