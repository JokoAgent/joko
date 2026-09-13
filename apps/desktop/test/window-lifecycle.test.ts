import { describe, expect, it, vi } from "vitest";
import {
  canShowDesktopWindow,
  applyDesktopMainWindowCloseBehavior,
  createDesktopMainWindowCloseController,
  hideWindowToAvailableTray,
  onDesktopWindowClosed,
  showWindowFromTray,
  type DesktopWindowLifecycleTarget
} from "../src/window-lifecycle.js";
import type { DesktopMainWindowCloseBehavior, DesktopMainWindowCloseSettings } from "../src/channels.js";

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

  it("keeps an explicitly reopened window visible after a late fullscreen transition or tray initialization", async () => {
    for (const behavior of ["tray", "minimize"] as const) {
      const fixture = fakeWindow({ fullScreen: true, minimized: true });
      const target = { ...fixture.target, minimize: vi.fn() };
      const apply = () => applyDesktopMainWindowCloseBehavior(target, behavior, {
        isCurrent: () => true,
        quit: vi.fn(),
        hideToTray: async (isCurrent) => { await hideWindowToAvailableTray(target, async () => true, isCurrent); }
      });
      await apply();
      showWindowFromTray(target);
      fixture.leaveFullScreen();
      expect(target.hide, behavior).not.toHaveBeenCalled();
      expect(target.minimize, behavior).not.toHaveBeenCalled();
      expect(target.restore, behavior).toHaveBeenCalledOnce();
      expect(target.show, behavior).toHaveBeenCalledOnce();
      expect(target.focus, behavior).toHaveBeenCalledOnce();

      await apply();
      expect(behavior === "tray" ? target.hide : target.minimize, behavior).toHaveBeenCalledOnce();
    }

    for (const available of [true, false]) {
      const fixture = fakeWindow();
      const tray = deferred<boolean>();
      const hiding = hideWindowToAvailableTray(fixture.target, () => tray.promise);
      showWindowFromTray(fixture.target);
      tray.resolve(available);
      await expect(hiding).resolves.toBe("cancelled");
      expect(fixture.target.hide).not.toHaveBeenCalled();
    }
  });

  it("does not hide after a close intent is cancelled while awaiting the tray or leaving fullscreen", async () => {
    const fixture = fakeWindow();
    let current = true;
    const tray = deferred<boolean>();
    const hiding = hideWindowToAvailableTray(fixture.target, () => tray.promise, () => current);
    current = false;
    tray.resolve(true);
    await expect(hiding).resolves.toBe("cancelled");
    expect(fixture.target.hide).not.toHaveBeenCalled();
    const fullscreen = fakeWindow({ fullScreen: true });
    current = true;
    await hideWindowToAvailableTray(fullscreen.target, async () => true, () => current);
    current = false;
    fullscreen.leaveFullScreen();
    expect(fullscreen.target.hide).not.toHaveBeenCalled();
  });
});

describe("main-window close decision ownership", () => {
  it("routes quit through its owner, tray through its availability check, and minimize through a fenced native transition", async () => {
    const fixture = fakeWindow();
    const target = { ...fixture.target, minimize: vi.fn() };
    const options = { isCurrent: () => true, quit: vi.fn(), hideToTray: vi.fn(async () => undefined) };
    await applyDesktopMainWindowCloseBehavior(target, "quit", options);
    expect(options.quit).toHaveBeenCalledOnce();
    expect(target.minimize).not.toHaveBeenCalled();
    await applyDesktopMainWindowCloseBehavior(target, "tray", options);
    expect(options.hideToTray).toHaveBeenCalledOnce();
    await applyDesktopMainWindowCloseBehavior(target, "minimize", options);
    expect(target.minimize).toHaveBeenCalledOnce();
    const fullscreen = fakeWindow({ fullScreen: true });
    const fullTarget = { ...fullscreen.target, minimize: vi.fn() };
    let current = true;
    await applyDesktopMainWindowCloseBehavior(fullTarget, "minimize", { ...options, isCurrent: () => current });
    expect(fullTarget.minimize).not.toHaveBeenCalled();
    current = false;
    fullscreen.leaveFullScreen();
    expect(fullTarget.minimize).not.toHaveBeenCalled();
  });
  it("shows one prompt and waits for persistence before applying the selected action", async () => {
    const fixture = closeFixture();
    const write = deferred<DesktopMainWindowCloseSettings>();
    fixture.save.mockImplementationOnce(async () => {
      const next = await write.promise;
      fixture.replace(next);
      return next;
    });
    const first = fixture.controller.request();
    expect(fixture.controller.request()).toBe(first);
    await vi.waitFor(() => expect(fixture.prompt).toHaveBeenCalledOnce());
    fixture.choice.resolve("quit");
    await vi.waitFor(() => expect(fixture.save).toHaveBeenCalledOnce());
    expect(fixture.apply).not.toHaveBeenCalled();
    write.resolve({ behavior: "quit", revision: 1 });
    await first;
    expect(fixture.apply).toHaveBeenCalledWith("quit", expect.any(Function));
    await fixture.controller.request();
    expect(fixture.prompt).toHaveBeenCalledOnce();
    expect(fixture.apply).toHaveBeenCalledTimes(2);
  });

  it("cancels without saving, and rejects late prompt results after owner teardown or a quit attempt", async () => {
    for (const outcome of ["cancel", "destroy", "quit"] as const) {
      const fixture = closeFixture();
      const request = fixture.controller.request();
      await vi.waitFor(() => expect(fixture.prompt).toHaveBeenCalledOnce());
      const signal = fixture.prompt.mock.calls[0]![0];
      if (outcome === "destroy") fixture.setCurrent(false);
      if (outcome === "quit") fixture.controller.cancelPending();
      fixture.choice.resolve(outcome === "cancel" ? null : "quit");
      await request;
      expect(fixture.save, outcome).not.toHaveBeenCalled();
      expect(fixture.apply, outcome).not.toHaveBeenCalled();
      expect(fixture.onError, outcome).not.toHaveBeenCalled();
      expect(signal.aborted).toBe(outcome === "quit");
    }
  });

  it("keeps a newer setting and does not save the obsolete prompt choice", async () => {
    const fixture = closeFixture();
    const request = fixture.controller.request();
    await vi.waitFor(() => expect(fixture.prompt).toHaveBeenCalledOnce());
    fixture.replace({ behavior: "tray", revision: 1 });
    fixture.choice.resolve("quit");
    await request;
    expect(fixture.save).not.toHaveBeenCalled();
    expect(fixture.apply).not.toHaveBeenCalled();
    await fixture.controller.request();
    expect(fixture.apply).toHaveBeenCalledWith("tray", expect.any(Function));
  });

  it("keeps the window reachable after a failed save and allows a new close attempt", async () => {
    const fixture = closeFixture();
    fixture.save.mockRejectedValueOnce(new Error("write failed"));
    fixture.choice.resolve("minimize");
    await fixture.controller.request();
    expect(fixture.onError).toHaveBeenCalledOnce();
    expect(fixture.apply).not.toHaveBeenCalled();
    await fixture.controller.request();
    expect(fixture.save).toHaveBeenCalledTimes(2);
    expect(fixture.apply).toHaveBeenCalledWith("minimize", expect.any(Function));
  });

  it("does not act when a previously authorized write finishes after close ownership was cancelled", async () => {
    const fixture = closeFixture();
    const write = deferred<DesktopMainWindowCloseSettings>();
    fixture.save.mockImplementationOnce(() => write.promise);
    fixture.choice.resolve("quit");
    const request = fixture.controller.request();
    await vi.waitFor(() => expect(fixture.save).toHaveBeenCalledOnce());
    fixture.controller.cancelPending();
    fixture.replace({ behavior: "quit", revision: 1 });
    write.resolve({ behavior: "quit", revision: 1 });
    await request;
    expect(fixture.apply).not.toHaveBeenCalled();
  });
});

function closeFixture() {
  let state: DesktopMainWindowCloseSettings = { behavior: null, revision: 0 };
  let current = true;
  const choice = deferred<DesktopMainWindowCloseBehavior | null>();
  const prompt = vi.fn((_signal: AbortSignal) => choice.promise);
  const save = vi.fn(async (behavior: DesktopMainWindowCloseBehavior, expectedRevision: number, isCurrent: () => boolean) => {
    if (!isCurrent() || state.revision !== expectedRevision) throw new Error("stale close");
    state = { behavior, revision: state.revision + 1 };
    return state;
  });
  const apply = vi.fn(async (_behavior: DesktopMainWindowCloseBehavior, _isCurrent: () => boolean) => undefined);
  const onError = vi.fn(async (_signal: AbortSignal) => undefined);
  const controller = createDesktopMainWindowCloseController({
    isCurrent: () => current, read: async () => state, currentSettings: () => state, prompt, save, apply, onError
  });
  return { controller, choice, prompt, save, apply, onError, replace: (next: DesktopMainWindowCloseSettings) => { state = next; }, setCurrent: (next: boolean) => { current = next; } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
