import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopRemoteDesktopViewerPrewarmScheduler } from "../src/remote-desktop-viewer-prewarm.js";

function fixture() {
  const window = { destroyed: false, isDestroyed() { return this.destroyed; } };
  let current: typeof window | undefined = window;
  let quitting = false;
  const prewarm = vi.fn();
  const scheduler = new DesktopRemoteDesktopViewerPrewarmScheduler<typeof window>({
    isCurrent: (candidate) => candidate === current && !quitting,
    prewarm
  });
  return { window, scheduler, prewarm,
    replace() { current = { ...window }; return current; },
    quit() { quitting = true; }
  };
}

describe("primary window viewer prewarm", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it("waits 1500 ms after show and prepares once without a recurring loop", () => {
    vi.useFakeTimers();
    const value = fixture();
    value.scheduler.schedule(value.window);
    vi.advanceTimersByTime(1499); expect(value.prewarm).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(value.prewarm).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(10000); expect(value.prewarm).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a replaced primary window and gives the new window its own delay", () => {
    vi.useFakeTimers();
    const value = fixture();
    value.scheduler.schedule(value.window);
    const replacement = value.replace();
    vi.advanceTimersByTime(1500); expect(value.prewarm).not.toHaveBeenCalled();
    value.scheduler.schedule(replacement);
    value.scheduler.schedule(value.window);
    vi.advanceTimersByTime(1500); expect(value.prewarm).toHaveBeenCalledOnce();
  });

  it.each(["destroyed", "quitting"] as const)("does not prepare when the primary window is %s", (condition) => {
    vi.useFakeTimers();
    const value = fixture();
    value.scheduler.schedule(value.window);
    if (condition === "destroyed") value.window.destroyed = true; else value.quit();
    vi.advanceTimersByTime(1500); expect(value.prewarm).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels retirement and rejects a late canceled callback without clearing a new timer", () => {
    vi.useFakeTimers();
    const timers = vi.spyOn(globalThis, "setTimeout");
    const value = fixture();
    value.scheduler.schedule(value.window);
    const retiredCallback = timers.mock.calls[0]?.[0];
    value.scheduler.cancel(); expect(vi.getTimerCount()).toBe(0);
    value.scheduler.schedule(value.window);
    if (typeof retiredCallback !== "function") throw new Error("Missing scheduled callback.");
    retiredCallback();
    expect(value.prewarm).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1500); expect(value.prewarm).toHaveBeenCalledOnce();
  });
});
