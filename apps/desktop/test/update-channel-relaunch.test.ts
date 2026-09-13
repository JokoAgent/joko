import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import {
  requestDesktopQuitHandoff,
  requestDesktopUpdateChannelRelaunchHandoff,
  type DesktopUpdateChannelQuitEvent,
  type DesktopUpdateChannelRelaunchApp
} from "../src/update-channel-relaunch.js";

describe("Desktop update channel relaunch handoff", () => {
  it("waits for will-quit before scheduling the replacement process", async () => {
    vi.useFakeTimers();
    try {
      const app = new FakeRelaunchApp();
      const event = quitEvent();

      const result = requestDesktopUpdateChannelRelaunchHandoff({ app, handoffTimeoutMs: 500 });

      expect(app.quit).toHaveBeenCalledOnce();
      expect(app.relaunch).not.toHaveBeenCalled();
      app.emit("will-quit", event);
      await expect(result).resolves.toBe(true);
      expect(app.relaunch).toHaveBeenCalledOnce();
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(app.listenerCount("will-quit")).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shares the bounded handoff without scheduling a relaunch for complete exit", async () => {
    vi.useFakeTimers();
    try {
      const app = new FakeRelaunchApp();
      const result = requestDesktopQuitHandoff({ app, handoffTimeoutMs: 500 });

      app.emit("will-quit", quitEvent());
      await expect(result).resolves.toBe(true);
      expect(app.quit).toHaveBeenCalledOnce();
      expect(app.relaunch).not.toHaveBeenCalled();
      expect(app.listenerCount("will-quit")).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles a renderer-cancelled quit and revokes the late relaunch listener", async () => {
    vi.useFakeTimers();
    try {
      const app = new FakeRelaunchApp();
      const result = requestDesktopUpdateChannelRelaunchHandoff({ app, handoffTimeoutMs: 500 });

      await vi.advanceTimersByTimeAsync(499);
      expect(app.listenerCount("will-quit")).toBe(1);
      expect(app.relaunch).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toBe(false);
      expect(app.listenerCount("will-quit")).toBe(0);
      expect(vi.getTimerCount()).toBe(0);

      app.emit("will-quit", quitEvent());
      expect(app.relaunch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles immediately when webContents reports will-prevent-unload", async () => {
    const app = new FakeRelaunchApp();
    const blockers = new Set<() => void>();
    const result = requestDesktopUpdateChannelRelaunchHandoff({
      app,
      handoffTimeoutMs: 30_000,
      onQuitBlocked: (listener) => {
        blockers.add(listener);
        return () => blockers.delete(listener);
      }
    });

    for (const listener of [...blockers]) listener();

    await expect(result).resolves.toBe(false);
    expect(blockers.size).toBe(0);
    expect(app.listenerCount("will-quit")).toBe(0);
    expect(app.relaunch).not.toHaveBeenCalled();
    app.emit("will-quit", quitEvent());
    expect(app.relaunch).not.toHaveBeenCalled();
  });

  it("cancels will-quit when relaunch cannot be scheduled", async () => {
    const app = new FakeRelaunchApp();
    const event = quitEvent();
    app.relaunch.mockImplementationOnce(() => {
      throw new Error("relaunch rejected");
    });
    app.quit.mockImplementationOnce(() => {
      app.emit("will-quit", event);
    });

    await expect(requestDesktopUpdateChannelRelaunchHandoff({ app, handoffTimeoutMs: 500 }))
      .resolves.toBe(false);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(app.listenerCount("will-quit")).toBe(0);
  });

  it("settles and cleans the listener when app.quit throws synchronously", async () => {
    const app = new FakeRelaunchApp();
    app.quit.mockImplementationOnce(() => {
      throw new Error("quit rejected");
    });

    await expect(requestDesktopUpdateChannelRelaunchHandoff({ app, handoffTimeoutMs: 500 }))
      .resolves.toBe(false);
    expect(app.relaunch).not.toHaveBeenCalled();
    expect(app.listenerCount("will-quit")).toBe(0);
  });
});

class FakeRelaunchApp extends EventEmitter implements DesktopUpdateChannelRelaunchApp {
  readonly quit = vi.fn<() => void>();
  readonly relaunch = vi.fn<() => void>();
}

function quitEvent(): DesktopUpdateChannelQuitEvent {
  return { preventDefault: vi.fn() };
}
