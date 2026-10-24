// @vitest-environment jsdom
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({ listeners: [] as Array<() => boolean>, keyboard: false, dismiss: vi.fn() }));
vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  Keyboard: { isVisible: () => native.keyboard, dismiss: () => native.dismiss() },
  BackHandler: { addEventListener: (_name: string, listener: () => boolean) => {
    native.listeners.push(listener);
    return { remove: () => { native.listeners = native.listeners.filter(value => value !== listener); } };
  } }
}));
import { MobileNavigationFrame } from "./MobileNavigationFrame";

it("routes Android Back to the current page while giving nested screens and the keyboard priority", () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  native.listeners = []; native.keyboard = false; native.dismiss.mockClear();
  const host = document.createElement("div"), root = createRoot(host), first = vi.fn(() => true), second = vi.fn(() => true);
  let nested = false;
  function Child() {
    useEffect(() => {
      const listener = () => nested;
      native.listeners.push(listener);
      return () => { native.listeners = native.listeners.filter(value => value !== listener); };
    }, []);
    return null;
  }
  const press = () => [...native.listeners].reverse().some(listener => listener());
  try {
    act(() => root.render(createElement(MobileNavigationFrame, { onBack: first, children: createElement(Child) })));
    expect(press()).toBe(true); expect(first).toHaveBeenCalledOnce();
    act(() => root.render(createElement(MobileNavigationFrame, { onBack: second, children: createElement(Child) })));
    nested = true; expect(press()).toBe(true); expect(second).not.toHaveBeenCalled();
    nested = false; native.keyboard = true; press(); expect(native.dismiss).toHaveBeenCalledOnce(); expect(second).not.toHaveBeenCalled();
    native.keyboard = false; press(); expect(second).toHaveBeenCalledOnce();
  } finally { act(() => root.unmount()); }
  expect(native.listeners).toHaveLength(0);
});
