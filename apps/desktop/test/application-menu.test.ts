import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";

import {
  ApplicationMenuShortcutRecordingLeases,
  buildMacApplicationMenuTemplate,
  createMacApplicationMenuConfigurationState,
  installMacApplicationMenu,
  isSafeMacApplicationMenuAccelerator,
  parseMacApplicationMenuConfigurationPatch,
  resolveMacToggleSidebarLabel,
  resolveMacViewMenuLabel
} from "../src/application-menu.js";

describe("macOS application menu", () => {
  it("dispatches persistent zoom and display-only sidebar commands", () => {
    const onCommand = vi.fn();
    const template = buildMacApplicationMenuTemplate("darwin", "zh-CN", true, {
      toggleSidebarAccelerator: "Command+J",
      onCommand,
      roleLabel: (role) => `native:${role}`
    });
    const viewMenu = template?.find((item) => item.label === "显示");
    const submenu = viewMenu?.submenu as MenuItemConstructorOptions[] | undefined;

    expect(template?.map((item) => item.role ?? item.label)).toEqual([
      "Joko",
      "文件",
      "editMenu",
      "显示",
      "window"
    ]);
    expect(submenu?.map((item) => item.role ?? item.label ?? item.type)).toEqual([
      "切换侧边栏",
      "separator",
      "native:resetZoom",
      "native:zoomIn",
      "native:zoomIn",
      "native:zoomOut",
      "separator",
      "togglefullscreen"
    ]);

    const [sidebar, , reset, zoomIn, hiddenZoomIn, zoomOut] = submenu ?? [];
    expect(sidebar).toMatchObject({ accelerator: "Command+J", registerAccelerator: false });
    expect(reset).toMatchObject({ accelerator: "CommandOrControl+0", registerAccelerator: true });
    expect(zoomIn).toMatchObject({ accelerator: "CommandOrControl+Plus", registerAccelerator: true });
    expect(hiddenZoomIn).toMatchObject({
      id: "persisted-page-zoom-in-unshifted",
      accelerator: "CommandOrControl+=",
      visible: false,
      acceleratorWorksWhenHidden: true,
      registerAccelerator: true
    });
    expect(zoomOut).toMatchObject({ accelerator: "CommandOrControl+-", registerAccelerator: true });

    click(sidebar);
    click(reset);
    click(zoomIn);
    click(zoomOut);
    expect(onCommand.mock.calls.map(([command]) => command)).toEqual([
      "toggle-sidebar",
      "zoom-reset",
      "zoom-in",
      "zoom-out"
    ]);
  });

  it("keeps reload tools dev-only and unregisters native accelerators while recording", () => {
    const packagedTemplate = buildMacApplicationMenuTemplate("darwin", "en", true);
    const developmentTemplate = buildMacApplicationMenuTemplate("darwin", "en", false);
    const recordingTemplate = buildMacApplicationMenuTemplate("darwin", "en", false, {
      shortcutRecording: true
    });
    const packaged = submenuFor(packagedTemplate);
    const development = submenuFor(developmentTemplate);
    const recording = submenuFor(recordingTemplate);

    expect(packaged.some((item) => item.role === "reload" || item.role === "toggleDevTools")).toBe(false);
    expect(development.slice(0, 6).map((item) => item.role ?? item.label ?? item.type)).toEqual([
      "Toggle Sidebar",
      "separator",
      "reload",
      "forceReload",
      "toggleDevTools",
      "separator"
    ]);
    expect(recording.find((item) => item.role === "reload")?.registerAccelerator).toBe(false);
    expect(recording.find((item) => item.role === "forceReload")?.registerAccelerator).toBe(false);
    expect(recording.find((item) => item.role === "toggleDevTools")?.registerAccelerator).toBe(false);
    expect(recording.find((item) => item.role === "togglefullscreen")?.registerAccelerator).toBe(false);
    expect(recording.filter((item) => item.label?.startsWith("reset") || item.label?.startsWith("zoom"))
      .every((item) => item.registerAccelerator === false)).toBe(true);

    const appItems = topSubmenu(recordingTemplate, "Joko");
    const fileItems = topSubmenu(recordingTemplate, "File");
    const windowItems = topSubmenu(recordingTemplate, "Window");
    expect(appItems.find((item) => item.role === "hide")?.registerAccelerator).toBe(false);
    expect(appItems.find((item) => item.role === "hideOthers")?.registerAccelerator).toBe(false);
    expect(appItems.find((item) => item.role === "quit")?.registerAccelerator).toBe(false);
    expect(appItems.find((item) => item.label === "Settings…")?.registerAccelerator).toBe(false);
    expect(fileItems[0]).toMatchObject({ label: "New Session", registerAccelerator: false });
    expect(windowItems.find((item) => item.role === "minimize")?.registerAccelerator).toBe(false);
    expect(windowItems.find((item) => item.role === "close")?.registerAccelerator).toBe(false);
  });

  it("keeps App/File accelerators hot and routes their applicable commands", () => {
    const onCommand = vi.fn();
    const template = buildMacApplicationMenuTemplate("darwin", "en", true, {
      newSessionAccelerator: "Shift+Command+N",
      openSettingsAccelerator: null,
      onCommand
    });
    const appItems = topSubmenu(template, "Joko");
    const fileItems = topSubmenu(template, "File");
    const about = appItems.find((item) => item.label === "About Joko");
    const settings = appItems.find((item) => item.label === "Settings…");
    const check = appItems.find((item) => item.label === "Check for Updates…");
    expect(settings?.accelerator).toBeUndefined();
    expect(fileItems[0]).toMatchObject({ accelerator: "Shift+Command+N", registerAccelerator: true });
    click(about);
    click(settings);
    click(check);
    click(fileItems[0]);
    expect(onCommand.mock.calls.map(([command]) => command)).toEqual([
      "open-about", "open-settings", "check-for-updates", "new-session"
    ]);
  });

  it("removes a disabled sidebar accelerator without removing its clickable item", () => {
    const sidebar = submenuFor(buildMacApplicationMenuTemplate("darwin", "en", true, {
      toggleSidebarAccelerator: null
    }))[0];
    expect(sidebar?.accelerator).toBeUndefined();
    expect(sidebar?.registerAccelerator).toBe(false);
    expect(sidebar?.click).toBeTypeOf("function");
  });

  it("uses localized View and Toggle Sidebar labels for supported locale families", () => {
    expect(resolveMacViewMenuLabel("en-US")).toBe("View");
    expect(resolveMacViewMenuLabel("zh_CN")).toBe("显示");
    expect(resolveMacViewMenuLabel("zh-TW")).toBe("顯示方式");
    expect(resolveMacViewMenuLabel("ja-JP")).toBe("表示");
    expect(resolveMacViewMenuLabel("ko-KR")).toBe("보기");
    expect(resolveMacToggleSidebarLabel("en-US")).toBe("Toggle Sidebar");
    expect(resolveMacToggleSidebarLabel("zh-CN")).toBe("切换侧边栏");
  });

  it("accepts only canonical, bindable Darwin accelerator strings", () => {
    for (const accepted of ["Command+B", "Ctrl+Alt+Shift+Command+F12", "Shift+Tab", "F5", "Command+,", "Alt+Left"]) {
      expect(isSafeMacApplicationMenuAccelerator(accepted), accepted).toBe(true);
    }
    for (const rejected of ["", "A", "Shift+A", "Super+B", "Command+Shift+N", "Command++", "Command+N\n", "Command+N+M"]) {
      expect(isSafeMacApplicationMenuAccelerator(rejected), rejected).toBe(false);
    }
  });

  it("strictly parses independent menu configuration patches", () => {
    expect(parseMacApplicationMenuConfigurationPatch({ shortcutRecording: true })).toEqual({
      shortcutRecording: true
    });
    expect(parseMacApplicationMenuConfigurationPatch({
      newSessionAccelerator: "Shift+Command+N",
      openSettingsAccelerator: null,
      toggleSidebarAccelerator: "Command+B"
    })).toEqual({
      newSessionAccelerator: "Shift+Command+N",
      openSettingsAccelerator: null,
      toggleSidebarAccelerator: "Command+B"
    });
    for (const rejected of [
      {},
      { shortcutRecording: "true" },
      { shortcutRecording: false, surprise: true },
      { toggleSidebarAccelerator: "A" },
      { openSettingsAccelerator: undefined },
      null
    ]) {
      expect(() => parseMacApplicationMenuConfigurationPatch(rejected)).toThrow(TypeError);
    }
  });

  it("gates cold-start commands, bounds them to 32, flushes FIFO, and regates on reload", () => {
    const state = createMacApplicationMenuConfigurationState({
      shortcutRecording: false,
      newSessionAccelerator: "Command+N",
      openSettingsAccelerator: "Command+,",
      toggleSidebarAccelerator: "Command+B"
    });
    const commands = ["new-session", "open-settings", "toggle-sidebar"] as const;
    const queued = Array.from({ length: 35 }, (_, index) => commands[index % commands.length]!);
    for (const command of queued) expect(state.acceptCommand(command)).toEqual([]);

    expect(state.apply({ shortcutRecording: true })).toEqual({ menuChanged: true, commands: [] });
    expect(state.snapshot()).toMatchObject({ ready: false, configuration: { shortcutRecording: true } });
    const ready = state.apply({
      newSessionAccelerator: "Shift+Command+N",
      openSettingsAccelerator: null,
      toggleSidebarAccelerator: "Command+B"
    });
    expect(ready).toEqual({ menuChanged: true, commands: queued.slice(-32) });
    expect(state.snapshot().ready).toBe(true);
    expect(state.acceptCommand("zoom-in")).toEqual(["zoom-in"]);
    expect(state.apply({
      newSessionAccelerator: "Shift+Command+N",
      openSettingsAccelerator: null,
      toggleSidebarAccelerator: "Command+B"
    })).toEqual({ menuChanged: false, commands: [] });

    expect(state.resetForRendererLoad()).toBe(true);
    expect(state.snapshot()).toMatchObject({ ready: false, configuration: { shortcutRecording: false } });
    expect(state.resetForRendererLoad()).toBe(false);
    expect(state.acceptCommand("open-settings")).toEqual([]);
    expect(state.apply({
      newSessionAccelerator: "Command+N",
      openSettingsAccelerator: "Command+,",
      toggleSidebarAccelerator: "Command+B"
    }).commands).toEqual(["open-settings"]);
  });

  it("keeps recording active until the last renderer lease is released", () => {
    const leases = new ApplicationMenuShortcutRecordingLeases<number>();
    expect(leases.set(11, true)).toEqual({ wasActive: false, active: true });
    expect(leases.set(12, true)).toEqual({ wasActive: true, active: true });
    expect(leases.set(11, false)).toEqual({ wasActive: true, active: true });
    expect(leases.active()).toBe(true);
    expect(leases.set(12, false)).toEqual({ wasActive: true, active: false });
    expect(leases.active()).toBe(false);
    expect(leases.set(12, false)).toEqual({ wasActive: false, active: false });
  });

  it("preserves menu readiness when a secondary renderer releases its recording lease", () => {
    const state = createMacApplicationMenuConfigurationState({
      shortcutRecording: false,
      newSessionAccelerator: "Command+N",
      openSettingsAccelerator: "Command+,",
      toggleSidebarAccelerator: "Command+B"
    });
    const leases = new ApplicationMenuShortcutRecordingLeases<number>();
    state.apply({
      newSessionAccelerator: "Command+N",
      openSettingsAccelerator: "Command+,",
      toggleSidebarAccelerator: "Command+B"
    });
    const started = leases.set(12, true);
    state.apply({ shortcutRecording: started.active });
    const released = leases.set(12, false);
    state.apply({ shortcutRecording: released.active });

    expect(state.snapshot()).toMatchObject({
      ready: true,
      configuration: { shortcutRecording: false }
    });
    expect(state.acceptCommand("open-settings")).toEqual(["open-settings"]);
  });

  it("explicitly removes Electron's application menu on non-macOS hosts", () => {
    const buildFromTemplate = vi.fn(() => ({ native: true }));
    const setApplicationMenu = vi.fn();

    expect(installMacApplicationMenu("win32", { buildFromTemplate, setApplicationMenu })).toBe(false);
    expect(buildMacApplicationMenuTemplate("linux")).toBeUndefined();
    expect(buildFromTemplate).not.toHaveBeenCalled();
    expect(setApplicationMenu).toHaveBeenCalledOnce();
    expect(setApplicationMenu).toHaveBeenCalledWith(null);
  });

  it("installs, reconfigures, validates, and safely dispatches the native menu", () => {
    const menu = { native: true };
    const buildFromTemplate = vi.fn(() => menu);
    const setApplicationMenu = vi.fn();

    expect(installMacApplicationMenu("darwin", { buildFromTemplate, setApplicationMenu })).toBe(true);
    expect(buildFromTemplate).toHaveBeenCalledOnce();
    expect(setApplicationMenu).toHaveBeenCalledWith(menu);
  });
});

function submenuFor(template: MenuItemConstructorOptions[] | undefined): MenuItemConstructorOptions[] {
  return template?.find((item) => item.label === "View")?.submenu as MenuItemConstructorOptions[] ?? [];
}

function topSubmenu(template: MenuItemConstructorOptions[] | undefined, label: string): MenuItemConstructorOptions[] {
  return template?.find((item) => item.label === label)?.submenu as MenuItemConstructorOptions[] ?? [];
}

function click(item: MenuItemConstructorOptions | undefined): void {
  expect(item?.click).toBeTypeOf("function");
  (item?.click as (() => void) | undefined)?.();
}
