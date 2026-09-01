import { describe, expect, it, vi } from "vitest";
import {
  broadcastWindowLayoutReset,
  resetDormantManagedWindowState,
  resetManagedWindowGeometry
} from "../src/window-layout-reset.js";

describe("desktop window layout reset", () => {
  it("validates first, then resets and persists every live window before state management resumes", async () => {
    const calls: string[] = [];
    const target = (name: string) => ({
      defaults: { width: 800, height: 600 },
      window: {
        isDestroyed: () => false,
        isFullScreen: () => true,
        isMaximized: () => true,
        once: (event: string, listener: () => void) => { if (event !== "closed") queueMicrotask(listener); },
        removeListener: vi.fn(),
        setFullScreen: (value: boolean) => calls.push(`${name}:fullscreen:${value}`),
        unmaximize: () => calls.push(`${name}:unmaximize`),
        setSize: (width: number, height: number) => calls.push(`${name}:size:${width}x${height}`),
        center: () => calls.push(`${name}:center`)
      },
      state: {
        unmanage: () => calls.push(`${name}:unmanage`),
        manage: () => calls.push(`${name}:manage`),
        saveState: () => calls.push(`${name}:save`)
      }
    });
    await resetManagedWindowGeometry([target("main"), target("task")]);
    for (const name of ["main", "task"]) {
      expect(calls.filter((call) => call.startsWith(`${name}:`))).toEqual([
        `${name}:unmanage`, `${name}:fullscreen:false`, `${name}:unmaximize`, `${name}:size:800x600`,
        `${name}:center`, `${name}:save`, `${name}:manage`
      ]);
    }
  });

  it("does not mutate earlier targets when a later default is invalid", async () => {
    const unmanage = vi.fn();
    await expect(resetManagedWindowGeometry([
      { defaults: { width: 800, height: 600 }, window: windowMock(), state: { unmanage, manage: vi.fn(), saveState: vi.fn() } },
      { defaults: { width: 1, height: 1 }, window: windowMock(), state: { unmanage: vi.fn(), manage: vi.fn(), saveState: vi.fn() } }
    ])).rejects.toThrow(RangeError);
    expect(unmanage).not.toHaveBeenCalled();
  });

  it("resets a dormant getter-only state through its validated runtime capability", () => {
    let width = 1_420;
    let height = 930;
    let maximized = true;
    const resetStateToDefault = vi.fn(() => {
      width = 520;
      height = 860;
      maximized = false;
    });
    const state = {
      get width() { return width; },
      get height() { return height; },
      get isMaximized() { return maximized; },
      unmanage: vi.fn(),
      manage: vi.fn(),
      saveState: vi.fn(),
      resetStateToDefault
    };

    expect(Object.getOwnPropertyDescriptor(state, "width")?.set).toBeUndefined();
    expect(() => resetDormantManagedWindowState(state)).not.toThrow();
    expect(resetStateToDefault).toHaveBeenCalledOnce();
    expect(state.width).toBe(520);
    expect(state.height).toBe(860);
    expect(state.isMaximized).toBe(false);
  });

  it("waits for asynchronous full-screen and maximize exits before applying geometry", async () => {
    let fullScreen = true;
    let maximized = true;
    const listeners = new Map<string, () => void>();
    const setSize = vi.fn();
    const saveState = vi.fn();
    const manage = vi.fn();
    const window = {
      isDestroyed: () => false,
      isFullScreen: () => fullScreen,
      isMaximized: () => maximized,
      once: (event: string, listener: () => void) => { listeners.set(event, listener); },
      removeListener: (event: string, listener: () => void) => { if (listeners.get(event) === listener) listeners.delete(event); },
      setFullScreen: vi.fn(),
      unmaximize: vi.fn(),
      setSize,
      center: vi.fn()
    };
    const reset = resetManagedWindowGeometry([{
      defaults: { width: 800, height: 600 },
      window,
      state: { unmanage: vi.fn(), manage, saveState }
    }]);

    expect(window.setFullScreen).toHaveBeenCalledWith(false);
    expect(window.unmaximize).not.toHaveBeenCalled();
    expect(setSize).not.toHaveBeenCalled();
    fullScreen = false;
    listeners.get("leave-full-screen")?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(window.unmaximize).toHaveBeenCalledOnce();
    expect(setSize).not.toHaveBeenCalled();
    maximized = false;
    listeners.get("unmaximize")?.();
    await reset;

    expect(setSize).toHaveBeenCalledWith(800, 600);
    expect(saveState).toHaveBeenCalledBefore(manage);
  });

  it("stops mutating a window that closes during a native state transition", async () => {
    let destroyed = false;
    const listeners = new Map<string, () => void>();
    const setSize = vi.fn();
    const saveState = vi.fn();
    const manage = vi.fn();
    const reset = resetManagedWindowGeometry([{
      defaults: { width: 800, height: 600 },
      window: {
        isDestroyed: () => destroyed,
        isFullScreen: () => true,
        isMaximized: () => false,
        once: (event: string, listener: () => void) => { listeners.set(event, listener); },
        removeListener: (event: string, listener: () => void) => { if (listeners.get(event) === listener) listeners.delete(event); },
        setFullScreen: vi.fn(),
        unmaximize: vi.fn(),
        setSize,
        center: vi.fn()
      },
      state: { unmanage: vi.fn(), manage, saveState }
    }]);
    destroyed = true;
    listeners.get("closed")?.();
    await reset;
    expect(setSize).not.toHaveBeenCalled();
    expect(saveState).not.toHaveBeenCalled();
    expect(manage).not.toHaveBeenCalled();
  });

  it("broadcasts once per live renderer, excludes the initiator, and tolerates teardown races", () => {
    const initiator = contents();
    const healthy = contents();
    const destroyedContents = contents(true);
    const sendFailure = contents(false, true);
    let destroyedWindow = false;
    const destroyedGetter = {
      isDestroyed: () => destroyedWindow,
      get webContents() {
        if (destroyedWindow) throw new TypeError("Object has been destroyed");
        return healthy;
      }
    };
    destroyedWindow = true;

    expect(() => broadcastWindowLayoutReset([
      windowFor(initiator),
      windowFor(healthy),
      windowFor(healthy),
      windowFor(destroyedContents),
      windowFor(sendFailure),
      destroyedGetter
    ], initiator)).not.toThrow();
    expect(initiator.send).not.toHaveBeenCalled();
    expect(healthy.send).toHaveBeenCalledOnce();
    expect(healthy.send).toHaveBeenCalledWith("joko:layout:reset-broadcast");
    expect(destroyedContents.send).not.toHaveBeenCalled();
    expect(sendFailure.send).toHaveBeenCalledOnce();
  });
});

function windowMock() {
  return {
    isDestroyed: () => false,
    isFullScreen: () => false,
    isMaximized: () => false,
    once: vi.fn(),
    removeListener: vi.fn(),
    setFullScreen: vi.fn(),
    unmaximize: vi.fn(),
    setSize: vi.fn(),
    center: vi.fn()
  };
}

function contents(destroyed = false, throws = false) {
  return {
    isDestroyed: () => destroyed,
    send: vi.fn(() => { if (throws) throw new Error("renderer closed"); })
  };
}

function windowFor(webContents: ReturnType<typeof contents>) {
  return { isDestroyed: () => false, webContents };
}
