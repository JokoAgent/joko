import { describe, expect, it } from "vitest";
import { createMobilePreviewResourceLifecycle } from "./mobile-preview-resource-lifecycle";

describe("mobile preview resource lifecycle", () => {
  it("releases outside the foreground and restores the same owner without spending the failure budget", () => {
    const lifecycle = createMobilePreviewResourceLifecycle(true, 1);
    lifecycle.onNotForeground();
    expect(lifecycle.onForeground()).toBe("remount");
    lifecycle.onRendererReady();
    lifecycle.onNotForeground();
    expect(lifecycle.onForeground()).toBe("remount");
  });

  it("shares a bounded consecutive recovery budget across pressure and process loss", () => {
    const lifecycle = createMobilePreviewResourceLifecycle(true, 1);
    expect(lifecycle.onResourcePressure(true)).toBe("remount");
    expect(lifecycle.onProcessLost(true)).toBe("failed");
    expect(lifecycle.onForeground()).toBe("failed");
  });

  it("resets the consecutive recovery budget only after the replacement renderer is ready", () => {
    const lifecycle = createMobilePreviewResourceLifecycle(true, 1);
    expect(lifecycle.onProcessLost(true)).toBe("remount");
    lifecycle.onRendererReady();
    expect(lifecycle.onResourcePressure(true)).toBe("remount");
  });

  it("waits while not foregrounded and fails closed when the native pressure source is unavailable", () => {
    const lifecycle = createMobilePreviewResourceLifecycle(false, 1);
    expect(lifecycle.onResourcePressure(false)).toBe("wait");
    expect(lifecycle.onForeground()).toBe("remount");
    lifecycle.onUnavailable();
    expect(lifecycle.onProcessLost(true)).toBe("failed");
    lifecycle.reset(true);
    expect(lifecycle.onProcessLost(true)).toBe("remount");
  });
});
