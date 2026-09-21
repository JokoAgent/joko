import { describe, expect, it } from "vitest";
import {
  MobileAppLifecycleCoordinator,
  mobileNetworkPathChanged,
  normalizeMobileAppLifecycleState
} from "./mobile-app-lifecycle";

describe("MobileAppLifecycleCoordinator", () => {
  it("freezes interaction without retiring transport for inactive jitter", () => {
    const lifecycle = new MobileAppLifecycleCoordinator("active");
    expect(lifecycle.transition("inactive")).toEqual({
      state: "inactive",
      interactive: false,
      enteredBackground: false,
      enteredForeground: false
    });
    expect(lifecycle.transition("active")).toEqual({
      state: "active",
      interactive: true,
      enteredBackground: false,
      enteredForeground: false
    });
    expect(lifecycle.transportForeground).toBe(true);
  });

  it("retires exactly once for a real background and resumes exactly once", () => {
    const lifecycle = new MobileAppLifecycleCoordinator("active");
    expect(lifecycle.transition("background")).toMatchObject({
      transportForeground: false,
      enteredBackground: true
    });
    expect(lifecycle.transition("background")).not.toHaveProperty("transportForeground");
    expect(lifecycle.transition("inactive")).toMatchObject({ enteredBackground: false });
    expect(lifecycle.transition("background")).toMatchObject({ enteredBackground: false });
    expect(lifecycle.transition("inactive")).not.toHaveProperty("transportForeground");
    expect(lifecycle.transition("active")).toMatchObject({
      transportForeground: true,
      enteredForeground: true
    });
    expect(lifecycle.transition("active")).not.toHaveProperty("transportForeground");
  });

  it("keeps a cold inactive or background start suspended until active", () => {
    for (const initial of ["inactive", "background", "extension"] as const) {
      const lifecycle = new MobileAppLifecycleCoordinator(initial);
      expect(lifecycle.transportForeground).toBe(false);
      expect(lifecycle.transition("active").transportForeground).toBe(true);
    }
    expect(normalizeMobileAppLifecycleState("extension")).toBe("unknown");
  });
});

describe("mobileNetworkPathChanged", () => {
  it("ignores the initial snapshot and repeats but detects material path changes", () => {
    const wifi = { type: "WIFI", isConnected: true, isInternetReachable: true };
    expect(mobileNetworkPathChanged(undefined, wifi)).toBe(false);
    expect(mobileNetworkPathChanged(wifi, { ...wifi })).toBe(false);
    expect(mobileNetworkPathChanged(wifi, { ...wifi, type: "CELLULAR" })).toBe(true);
    expect(mobileNetworkPathChanged(wifi, { ...wifi, isInternetReachable: false })).toBe(true);
  });
});
