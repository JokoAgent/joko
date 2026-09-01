import { describe, expect, it, vi } from "vitest";
import {
  canShowDesktopWindow,
  hideWindowToAvailableTray,
  onDesktopWindowClosed,
  showWindowFromTray,
  type DesktopWindowLifecycleTarget
} from "../src/window-lifecycle.js";

function fakeWindow(options: { destroyed?: boolean; fullScreen?: boolean; minimized?: boolean } = {}) {
  let destroyed = options.destroyed ?? false;
  let fullScreen = options.fullScreen ?? false;
  let minimized = options.minimized ?? false;
  let leaveFullScreen: (() => void) | undefined;
  const target: DesktopWindowLifecycleTarget = {
    isDestroyed: () => destroyed,
    isFullScreen: () => fullScreen,
    isMinimized: () => minimized,
    hide: vi.fn(),
    restore: vi.fn(() => { minimized = false; }),
    show: vi.fn(),
    focus: vi.fn(),
    once: vi.fn((_event, listener) => { leaveFullScreen = listener; }),
    setFullScreen: vi.fn((next) => { fullScreen = next; })
  };
  return {
    target,
    destroy: () => { destroyed = true; },
    leaveFullScreen: () => leaveFullScreen?.()
  };
}

describe("Desktop tray window lifecycle", () => {
  it("captures renderer ownership before a destroyed BrowserWindow emits closed", () => {
    const contents = { id: 7 };
    const cleanup = vi.fn();
    let destroyed = false;
    let closed: (() => void) | undefined;
    let getterReads = 0;
    const window = {
      get webContents() {
        getterReads += 1;
        if (destroyed) throw new TypeError("Object has been destroyed");
        return contents;
      },
      once: (_event: "closed", listener: () => void) => { closed = listener; }
    };

    expect(onDesktopWindowClosed(window, cleanup)).toBe(contents);
    destroyed = true;
    expect(() => closed?.()).not.toThrow();
    expect(cleanup).toHaveBeenCalledWith(contents);
    expect(getterReads).toBe(1);
  });

  it("refuses activation and second-instance window recreation during every quit handoff", () => {
    const active = {
      quitting: false,
      channelQuitHandoffPending: false,
      nativeInstallQuitHandoffPending: false,
      completeExitQuitHandoffPending: false
    };
    expect(canShowDesktopWindow(active)).toBe(true);
    for (const key of Object.keys(active) as (keyof typeof active)[]) {
      expect(canShowDesktopWindow({ ...active, [key]: true })).toBe(false);
    }
    // The first macOS preflight will-quit destroys accepted windows while the
    // native updater is still fetching through its local Squirrel proxy.
    expect(canShowDesktopWindow({
      ...active,
      quitting: true,
      nativeInstallQuitHandoffPending: true
    })).toBe(false);
    expect(canShowDesktopWindow(active)).toBe(true);
  });

  it("hides a normal window only after the tray is confirmed available", async () => {
    const fixture = fakeWindow();
    await expect(hideWindowToAvailableTray(fixture.target, async () => true)).resolves.toBe("hidden");
    expect(fixture.target.hide).toHaveBeenCalledOnce();
  });

  it("keeps the window reachable when tray initialization fails", async () => {
    const fixture = fakeWindow();
    await expect(hideWindowToAvailableTray(fixture.target, async () => false)).resolves.toBe("unavailable");
    expect(fixture.target.hide).not.toHaveBeenCalled();
  });

  it("leaves full screen before hiding and fences a destroyed window", async () => {
    const fixture = fakeWindow({ fullScreen: true });
    await expect(hideWindowToAvailableTray(fixture.target, async () => true)).resolves.toBe("hidden");
    expect(fixture.target.hide).not.toHaveBeenCalled();
    fixture.leaveFullScreen();
    expect(fixture.target.hide).toHaveBeenCalledOnce();

    const destroyed = fakeWindow({ destroyed: true });
    await expect(hideWindowToAvailableTray(destroyed.target, async () => true)).resolves.toBe("destroyed");
    expect(destroyed.target.hide).not.toHaveBeenCalled();
  });

  it("restores a minimized window before showing and focusing it", () => {
    const fixture = fakeWindow({ minimized: true });
    showWindowFromTray(fixture.target);
    expect(fixture.target.restore).toHaveBeenCalledOnce();
    expect(fixture.target.show).toHaveBeenCalledOnce();
    expect(fixture.target.focus).toHaveBeenCalledOnce();
  });
});
