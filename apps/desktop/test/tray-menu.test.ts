import { describe, expect, it, vi } from "vitest";

import {
  popUpDesktopTrayMenu,
  resolveDesktopTrayMenuLabels,
  usesJavaScriptTrayMenuPopup,
  type DesktopTrayPopupMenu
} from "../src/tray-menu.js";

function popupMenu() {
  let closeListener: (() => void) | undefined;
  return {
    once: vi.fn((_event: "menu-will-close", listener: () => void) => {
      closeListener = listener;
    }),
    removeListener: vi.fn((_event: "menu-will-close", listener: () => void) => {
      if (closeListener === listener) closeListener = undefined;
    }),
    close: () => {
      const listener = closeListener;
      closeListener = undefined;
      listener?.();
    }
  } satisfies DesktopTrayPopupMenu & { close(): void };
}

describe("Desktop tray menu", () => {
  it.each([
    ["en", false, "Open Joko", "Quit Joko"],
    ["en", true, "Open Joko", "Quit Joko and local Orchestrator"],
    ["zh-CN", false, "打开 Joko", "退出 Joko"],
    ["zh-CN", true, "打开 Joko", "退出 Joko 和本地 Orchestrator"],
    ["en-XA", false, "［Öpën Jõkõ··］", "［Qüït Jõkõ··］"],
    ["en-XA", true, "［Öpën Jõkõ··］", "［Qüït Jõkõ ànd lõcàl Örchëstràtõr··］"]
  ] as const)("localizes %s tray labels with managed runtime=%s", (locale, managesLocalOrchestrator, open, quit) => {
    expect(resolveDesktopTrayMenuLabels(locale, managesLocalOrchestrator)).toEqual({ open, quit });
  });

  it("uses the JavaScript popup path only on Windows", () => {
    expect(usesJavaScriptTrayMenuPopup("win32")).toBe(true);
    expect(usesJavaScriptTrayMenuPopup("darwin")).toBe(false);
    expect(usesJavaScriptTrayMenuPopup("linux")).toBe(false);
  });

  it("builds, caches, and retains an open menu until native dismissal", () => {
    const menu = popupMenu();
    const buildMenu = vi.fn(() => menu);
    let cached: typeof menu | undefined;
    const active = new Set<DesktopTrayPopupMenu>();
    const tray = {
      isDestroyed: () => false,
      popUpContextMenu: vi.fn(),
      focus: vi.fn()
    };

    expect(popUpDesktopTrayMenu({
      tray,
      menu: cached,
      buildMenu,
      retainMenu: (next) => { cached = next; },
      retainActiveMenu: (next) => { active.add(next); },
      releaseActiveMenu: (next) => { active.delete(next); },
      onUnavailable: vi.fn(),
      onError: vi.fn()
    })).toBe(true);

    expect(buildMenu).toHaveBeenCalledOnce();
    expect(cached).toBe(menu);
    expect(active.has(menu)).toBe(true);
    expect(tray.popUpContextMenu).toHaveBeenCalledWith(menu);
    expect(vi.mocked(tray.popUpContextMenu).mock.calls[0]).toHaveLength(1);
    expect(tray.focus).not.toHaveBeenCalled();
    menu.close();
    menu.close();
    expect(active.has(menu)).toBe(false);
    expect(tray.focus).toHaveBeenCalledOnce();

    expect(popUpDesktopTrayMenu({
      tray,
      menu: cached,
      buildMenu,
      retainMenu: (next) => { cached = next; },
      retainActiveMenu: (next) => { active.add(next); },
      releaseActiveMenu: (next) => { active.delete(next); },
      onUnavailable: vi.fn(),
      onError: vi.fn()
    })).toBe(true);
    expect(buildMenu).toHaveBeenCalledOnce();
    expect(tray.popUpContextMenu).toHaveBeenCalledTimes(2);
  });

  it.each([
    [undefined, "missing"],
    [{ isDestroyed: () => true, popUpContextMenu: vi.fn(), focus: vi.fn() }, "destroyed"]
  ] as const)("rejects an unavailable tray before building: %s", (tray, reason) => {
    const buildMenu = vi.fn(popupMenu);
    const onUnavailable = vi.fn();

    expect(popUpDesktopTrayMenu({
      tray,
      menu: undefined,
      buildMenu,
      retainMenu: vi.fn(),
      retainActiveMenu: vi.fn(),
      releaseActiveMenu: vi.fn(),
      onUnavailable,
      onError: vi.fn()
    })).toBe(false);
    expect(onUnavailable).toHaveBeenCalledWith(reason);
    expect(buildMenu).not.toHaveBeenCalled();
  });

  it("releases and reports a menu that fails to open", () => {
    const error = new Error("native popup rejected");
    const menu = popupMenu();
    const retainActiveMenu = vi.fn();
    const releaseActiveMenu = vi.fn();
    const onError = vi.fn();
    const tray = {
      isDestroyed: () => false,
      popUpContextMenu: vi.fn(() => { throw error; }),
      focus: vi.fn()
    };

    expect(popUpDesktopTrayMenu({
      tray,
      menu,
      buildMenu: vi.fn(),
      retainMenu: vi.fn(),
      retainActiveMenu,
      releaseActiveMenu,
      onUnavailable: vi.fn(),
      onError
    })).toBe(false);
    expect(retainActiveMenu).toHaveBeenCalledWith(menu);
    expect(releaseActiveMenu).toHaveBeenCalledWith(menu);
    expect(menu.removeListener).toHaveBeenCalledWith("menu-will-close", expect.any(Function));
    expect(tray.focus).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(error);
  });

  it("reports a notification-area focus failure after otherwise normal dismissal", () => {
    const error = new Error("native focus rejected");
    const menu = popupMenu();
    const onError = vi.fn();
    const tray = {
      isDestroyed: () => false,
      popUpContextMenu: vi.fn(),
      focus: vi.fn(() => { throw error; })
    };

    expect(popUpDesktopTrayMenu({
      tray,
      menu,
      buildMenu: vi.fn(),
      retainMenu: vi.fn(),
      retainActiveMenu: vi.fn(),
      releaseActiveMenu: vi.fn(),
      onUnavailable: vi.fn(),
      onError
    })).toBe(true);

    menu.close();
    expect(onError).toHaveBeenCalledWith(error);
  });
});
