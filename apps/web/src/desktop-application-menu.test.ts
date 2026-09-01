import { describe, expect, it, vi } from "vitest";

import {
  createDesktopApplicationMenuCommandQueue,
  desktopApplicationMenuAccelerators,
  desktopUpdateCheckNotice
} from "./desktop-application-menu.js";

describe("Desktop application-menu bridge", () => {
  it("maps every manual update outcome to explicit feedback", () => {
    expect(desktopUpdateCheckNotice({ status: "available", version: "2.4.0" })).toEqual({
      key: "desktop.updateAvailableVersion",
      values: { version: "2.4.0" }
    });
    expect(desktopUpdateCheckNotice({ status: "up-to-date" })).toEqual({ key: "desktop.updateCurrent" });
    expect(desktopUpdateCheckNotice({ status: "failed", errorKind: "check" })).toEqual({ key: "desktop.updateFailed" });
    expect(desktopUpdateCheckNotice({ status: "unavailable", reason: "development" })).toEqual({ key: "desktop.updateUnavailable" });
    expect(desktopUpdateCheckNotice({ status: "unavailable", reason: "versionless-build" })).toEqual({
      key: "desktop.updateUnavailableVersionless"
    });
    expect(desktopUpdateCheckNotice({ status: "manual-download", reason: "linux-manual-only" })).toEqual({ key: "desktop.updateManualLinux" });
    expect(desktopUpdateCheckNotice({ status: "manual-download", reason: "unsupported-platform" })).toEqual({ key: "desktop.updateManualUnsupported" });
  });

  it("constructs before the App target ref exists and accepts the first render sync", async () => {
    const getPreferences = vi.fn(() => ({ navigationOpen: true, windowZoom: 1 }));
    const setWindowZoom = vi.fn();
    const queue = createDesktopApplicationMenuCommandQueue({
      getPreferences,
      openAbout: vi.fn(),
      openNewSession: vi.fn(),
      openSettings: vi.fn(),
      openTaskStatusSettings: vi.fn(),
      checkForUpdates: vi.fn(),
      setNavigationOpen: vi.fn(),
      setWindowZoom
    });
    expect(getPreferences).not.toHaveBeenCalled();
    queue.sync({ navigationOpen: false, windowZoom: 1.4 });
    queue.handle("zoom-in");
    await queue.whenIdle();
    expect(setWindowZoom).toHaveBeenCalledWith(1.5);
  });

  it("routes the native About item through the guarded renderer action", async () => {
    const openAbout = vi.fn();
    const queue = createDesktopApplicationMenuCommandQueue({
      getPreferences: () => ({ navigationOpen: true, windowZoom: 1 }),
      openAbout,
      openNewSession: vi.fn(),
      openSettings: vi.fn(),
      openTaskStatusSettings: vi.fn(),
      checkForUpdates: vi.fn(),
      setNavigationOpen: vi.fn(),
      setWindowZoom: vi.fn()
    });
    queue.handle("open-about");
    await queue.whenIdle();
    expect(openAbout).toHaveBeenCalledOnce();
  });

  it("routes the native task-status gear directly to its settings action", async () => {
    const openTaskStatusSettings = vi.fn();
    const queue = createDesktopApplicationMenuCommandQueue({
      getPreferences: () => ({ navigationOpen: true, windowZoom: 1 }),
      openAbout: vi.fn(),
      openNewSession: vi.fn(),
      openSettings: vi.fn(),
      openTaskStatusSettings,
      checkForUpdates: vi.fn(),
      setNavigationOpen: vi.fn(),
      setWindowZoom: vi.fn()
    });
    queue.handle("open-task-status-settings");
    await queue.whenIdle();
    expect(openTaskStatusSettings).toHaveBeenCalledOnce();
  });

  it("serializes consecutive preference commands against an optimistic current value", async () => {
    const zooms: number[] = [];
    const navigation: boolean[] = [];
    const queue = createDesktopApplicationMenuCommandQueue({
      getPreferences: () => ({ navigationOpen: true, windowZoom: 1 }),
      openAbout: vi.fn(),
      openNewSession: vi.fn(),
      openSettings: vi.fn(),
      openTaskStatusSettings: vi.fn(),
      checkForUpdates: vi.fn(),
      setNavigationOpen: async (open) => { navigation.push(open); },
      setWindowZoom: async (zoom) => { zooms.push(zoom); }
    });

    queue.handle("zoom-in");
    queue.handle("zoom-in");
    queue.handle("toggle-sidebar");
    queue.handle("toggle-sidebar");
    await queue.whenIdle();

    expect(zooms).toEqual([1.1, 1.2]);
    expect(navigation).toEqual([false, true]);
  });

  it("keeps later native commands live after one action rejects", async () => {
    const errors: unknown[] = [];
    const openSettings = vi.fn();
    const queue = createDesktopApplicationMenuCommandQueue({
      getPreferences: () => ({ navigationOpen: true, windowZoom: 1 }),
      openAbout: vi.fn(),
      openNewSession: () => Promise.reject(new Error("blocked")),
      openSettings,
      openTaskStatusSettings: vi.fn(),
      checkForUpdates: vi.fn(),
      setNavigationOpen: vi.fn(),
      setWindowZoom: vi.fn(),
      onError: (error) => { errors.push(error); }
    });

    queue.handle("new-session");
    queue.handle("open-settings");
    await queue.whenIdle();

    expect(errors).toHaveLength(1);
    expect(openSettings).toHaveBeenCalledOnce();
  });

  it("awaits a guarded navigation before starting the next menu navigation", async () => {
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const openNewSession = vi.fn(() => first);
    const openSettings = vi.fn();
    const queue = createDesktopApplicationMenuCommandQueue({
      getPreferences: () => ({ navigationOpen: true, windowZoom: 1 }),
      openAbout: vi.fn(),
      openNewSession,
      openSettings,
      openTaskStatusSettings: vi.fn(),
      checkForUpdates: vi.fn(),
      setNavigationOpen: vi.fn(),
      setWindowZoom: vi.fn()
    });
    queue.sync({ navigationOpen: true, windowZoom: 1 });
    queue.handle("new-session");
    queue.handle("open-settings");
    await Promise.resolve();
    expect(openNewSession).toHaveBeenCalledOnce();
    expect(openSettings).not.toHaveBeenCalled();
    releaseFirst();
    await queue.whenIdle();
    expect(openSettings).toHaveBeenCalledOnce();
  });

  it("projects Darwin defaults, remaps, disables, and unmappable keys", () => {
    expect(desktopApplicationMenuAccelerators({})).toEqual({
      newSessionAccelerator: "Command+N",
      openSettingsAccelerator: "Command+,",
      toggleSidebarAccelerator: "Command+B"
    });
    expect(desktopApplicationMenuAccelerators({
      "new-maker": { code: "KeyJ", meta: true, ctrl: false, alt: false, shift: true },
      "open-settings": null,
      "toggle-sidebar": { code: "NumpadAdd", meta: true, ctrl: false, alt: false, shift: false }
    })).toEqual({
      newSessionAccelerator: "Shift+Command+J",
      openSettingsAccelerator: null,
      toggleSidebarAccelerator: null
    });
    expect(desktopApplicationMenuAccelerators({
      "new-maker": { code: "KeyJ", meta: false, ctrl: false, alt: false, shift: false },
      "open-settings": { code: "KeyK", meta: false, ctrl: false, alt: false, shift: true },
      "toggle-sidebar": { code: "KeyL", meta: false, ctrl: false, alt: false, shift: false }
    })).toEqual({
      newSessionAccelerator: null,
      openSettingsAccelerator: null,
      toggleSidebarAccelerator: null
    });
  });
});
