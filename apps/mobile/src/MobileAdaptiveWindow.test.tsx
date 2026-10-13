// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileWindowGeometry } from "./mobile-window-geometry";

const observed = vi.hoisted(() => ({ platform: { OS: "ios" }, module: { windowLayoutAvailable: true as boolean | undefined },
  dimensions: { width: 800, height: 1000 }, insets: { top: 20, right: 10, bottom: 20, left: 10 },
  receive: undefined as ((event: { nativeEvent: unknown }) => void) | undefined, requireView: vi.fn() }));
vi.mock("react-native", async () => {
  const React = await import("react");
  return { Platform: observed.platform, useWindowDimensions: () => observed.dimensions,
    View: ({ children }: { children?: React.ReactNode }) => React.createElement("div", null, children),
    StyleSheet: { absoluteFill: {}, create: <T,>(value: T) => value } };
});
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => observed.insets }));
vi.mock("../modules/joko-remote-presentation/src/index", () => ({ remotePresentation: observed.module }));
vi.mock("expo-modules-core", async () => {
  const React = await import("react");
  return { requireNativeViewManager: (module: string, view: string) => {
    observed.requireView(module, view);
    return ({ onGeometryChange, pointerEvents }: { onGeometryChange(event: { nativeEvent: unknown }): void; pointerEvents: string }) => {
      observed.receive = onGeometryChange;
      return React.createElement("div", { "data-probe": view, "data-pointer-events": pointerEvents });
    };
  } };
});
const roots: Root[] = [];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); vi.resetModules(); observed.requireView.mockClear();
  observed.platform.OS = "ios"; observed.module.windowLayoutAvailable = true;
  observed.dimensions = { width: 800, height: 1000 }; observed.receive = undefined;
});
afterEach(() => { for (const root of roots.splice(0)) act(() => root.unmount()); vi.unstubAllGlobals(); });
const geometry: MobileWindowGeometry = { width: 800, height: 1000, insets: { top: 20, right: 10, bottom: 20, left: 10 },
  regularWidth: true, regularHeight: true, barEdge: "right", reservedRegionsSupported: true,
  regions: [{ kind: "division", x: 0, y: 490, width: 800, height: 20 }] };
async function mount(withProvider = true) {
  const { MobileAdaptiveWindowProvider, useMobileAdaptiveWindow } = await import("./MobileAdaptiveWindow");
  const host = document.createElement("div"), root = createRoot(host); roots.push(root);
  function Consumer() { return createElement("output", null, JSON.stringify(useMobileAdaptiveWindow())); }
  const render = () => act(() => root.render(withProvider
    ? createElement(MobileAdaptiveWindowProvider, { children: createElement(Consumer) }) : createElement(Consumer)));
  render(); return { host, render, value: () => JSON.parse(host.querySelector("output")!.textContent!) as MobileWindowGeometry };
}
describe("actual adaptive window provider", () => {
  it("loads only the named layout probe and adopts a current finite window observation", async () => {
    const view = await mount(); expect(observed.requireView).toHaveBeenCalledExactlyOnceWith("JokoRemotePresentation", "WindowLayout");
    expect(view.host.querySelector('[data-pointer-events="none"]')).not.toBeNull();
    expect(view.value()).toMatchObject({ regions: [], reservedRegionsSupported: false, barEdge: "none" });
    act(() => observed.receive!({ nativeEvent: geometry })); expect(view.value()).toEqual(geometry);
  });
  it("falls back when observed dimensions differ by at least one point from the current window", async () => {
    const view = await mount(); act(() => observed.receive!({ nativeEvent: { ...geometry, width: 800.9, height: 1000.9 } }));
    expect(view.value().reservedRegionsSupported).toBe(true);
    act(() => observed.receive!({ nativeEvent: { ...geometry, width: 801 } }));
    expect(view.value()).toMatchObject({ width: 800, regions: [], reservedRegionsSupported: false });
    act(() => observed.receive!({ nativeEvent: geometry }));
    observed.dimensions = { width: 1000, height: 800 }; view.render();
    expect(view.value()).toMatchObject({ width: 1000, height: 800, regions: [], reservedRegionsSupported: false });
  });
  it("invalidates malformed observations instead of retaining previous reservations", async () => {
    const view = await mount(); act(() => observed.receive!({ nativeEvent: geometry }));
    act(() => observed.receive!({ nativeEvent: { ...geometry, height: NaN } }));
    expect(view.value()).toMatchObject({ regions: [], reservedRegionsSupported: false });
  });
  it.each(["android", "unavailable"])("uses normal responsive safe-area geometry without a probe on %s", async platform => {
    if (platform === "android") observed.platform.OS = "android";
    else observed.module.windowLayoutAvailable = undefined;
    const view = await mount();
    expect(observed.requireView).not.toHaveBeenCalled(); expect(view.host.querySelector("[data-probe]")).toBeNull();
    expect(view.value()).toEqual({ width: 800, height: 1000, insets: observed.insets, regularWidth: true,
      regularHeight: true, barEdge: "none", regions: [], reservedRegionsSupported: false });
  });
  it("retains the normal fallback for a consumer without a provider", async () => {
    observed.dimensions = { width: 390, height: 844 }; const view = await mount(false);
    expect(view.value()).toMatchObject({ width: 390, height: 844, regularWidth: false, regularHeight: true, regions: [] });
  });
});
