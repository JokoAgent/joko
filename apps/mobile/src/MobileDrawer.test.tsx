// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { MobileDrawer } from "./MobileDrawer";

const { animations, dismissKeyboard } = vi.hoisted(() => ({
  animations: [] as { readonly finish: (finished?: boolean) => void; readonly closing: boolean }[],
  dismissKeyboard: vi.fn()
}));

vi.mock("react-native", async () => {
  const { createElement: element } = await import("react");
  const primitive = ({ children, testID }: { readonly children?: ReactNode; readonly testID?: string }) =>
    element("div", { "data-testid": testID }, children);
  class Value {
    generation = 0;
    setValue() {}
    stopAnimation() { this.generation += 1; }
  }
  return {
    AccessibilityInfo: { isReduceMotionEnabled: async () => false,
      addEventListener: () => ({ remove() {} }), setAccessibilityFocus: vi.fn() },
    Keyboard: { dismiss: dismissKeyboard }, findNodeHandle: () => null,
    Animated: { Value, View: primitive, timing: (value: Value, config: { toValue: number }) => ({
      start: (callback?: (result: { finished: boolean }) => void) => {
        const generation = value.generation;
        animations.push({ closing: config.toValue < 0, finish: (finished = generation === value.generation) => callback?.({ finished }) });
      }
    }) },
    Easing: { cubic: () => undefined, in: () => undefined, out: () => undefined },
    PanResponder: { create: () => ({ panHandlers: {} }) },
    Modal: ({ visible, children, onRequestClose }: { readonly visible: boolean; readonly children?: ReactNode; readonly onRequestClose: () => void }) =>
      visible ? element("div", { "data-modal": "true", onKeyDown: (event: KeyboardEvent) => { if (event.key === "Escape") onRequestClose(); } }, children) : null,
    Pressable: ({ children, accessibilityLabel, onPress }: { readonly children?: ReactNode; readonly accessibilityLabel?: string; readonly onPress: () => void }) =>
      element("button", { "aria-label": accessibilityLabel, onClick: onPress }, children),
    View: primitive, StyleSheet: { create: (styles: unknown) => styles, absoluteFill: {} }
  };
});

function setup() {
  const container = document.createElement("div");
  const root = createRoot(container);
  const close = vi.fn();
  const closed = vi.fn(() => expect(container.querySelector('[data-testid="drawer.content"]')).toBeNull());
  const mounted = vi.fn();
  const render = (visible: boolean) => act(() => root.render(createElement(MobileDrawer, {
    visible, width: 320, backgroundColor: "#fff", borderColor: "#ddd", locale: "en",
    onClose: close, onClosed: closed, onMountedChange: mounted,
    children: createElement("div", { "data-testid": "drawer.content" }, "Complete Home")
  })));
  const cleanup = () => { act(() => root.unmount()); animations.splice(0); dismissKeyboard.mockClear(); };
  const finish = () => act(() => { for (const animation of animations.splice(0)) animation.finish(); });
  return { container, root, close, closed, mounted, render, cleanup, finish };
}

it("hands navigation back only after the modal content actually unmounts", () => {
  const fixture = setup();
  try {
    fixture.render(true);
    fixture.finish();
    expect(fixture.container.querySelector('[data-testid="drawer.content"]')).not.toBeNull();
    fixture.render(false);
    expect(fixture.closed).not.toHaveBeenCalled();
    expect(fixture.container.querySelector('[data-testid="drawer.content"]')).not.toBeNull();
    fixture.finish();
    expect(fixture.closed).toHaveBeenCalledOnce();
    expect(fixture.container.querySelector('[data-modal="true"]')).toBeNull();
    expect(fixture.mounted.mock.calls).toEqual([[true], [false]]);
  } finally { fixture.cleanup(); }
});

it("retires an earlier closing callback if the drawer reopens before delivery", () => {
  const fixture = setup();
  try {
    fixture.render(true);
    fixture.finish();
    fixture.render(false);
    const oldClose = animations.splice(0).find(animation => animation.closing)!;
    fixture.render(true);
    act(() => oldClose.finish(true));
    expect(fixture.closed).not.toHaveBeenCalled();
    expect(fixture.container.querySelector('[data-testid="drawer.content"]')).not.toBeNull();
    fixture.finish();
    fixture.render(false);
    fixture.finish();
    expect(fixture.closed).toHaveBeenCalledOnce();
  } finally { fixture.cleanup(); }
});

it("retires a pending close when its drawer owner unmounts", () => {
  const fixture = setup();
  fixture.render(true);
  fixture.finish();
  fixture.render(false);
  const oldClose = animations.splice(0).find(animation => animation.closing)!;
  fixture.cleanup();
  act(() => oldClose.finish(true));
  expect(fixture.closed).not.toHaveBeenCalled();
  expect(fixture.mounted.mock.calls).toEqual([[true], [false]]);
});

it("routes native Back and the scrim through the original modal close owner", () => {
  const fixture = setup();
  try {
    fixture.render(true);
    fixture.finish();
    act(() => fixture.container.querySelector<HTMLButtonElement>('button[aria-label="Close drawer"]')!.click());
    act(() => fixture.container.querySelector('[data-modal="true"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(fixture.close).toHaveBeenCalledTimes(2);
    expect(fixture.closed).not.toHaveBeenCalled();
    fixture.render(false);
    fixture.finish();
    expect(fixture.closed).toHaveBeenCalledOnce();
  } finally { fixture.cleanup(); }
});
