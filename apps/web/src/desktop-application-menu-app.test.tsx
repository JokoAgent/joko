// @vitest-environment jsdom

import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { AppWithController } from "./App.js";
import type { AppController, ControllerState } from "./controller.js";
import { DEFAULT_UI_PREFERENCES } from "./local-state.js";
import { emptySnapshot } from "./model.js";
import { acquireStartupUpdateInteractionBarrier } from "./startup-update-interaction.js";

describe("Desktop application-menu App lifecycle", () => {
  it("can construct the command queue during the first App render before effects subscribe", () => {
    const state: ControllerState = {
      ready: false,
      connectionState: "disconnected",
      profiles: [],
      machineCaches: [],
      machinePresenceByProfile: {},
      discoveredNodes: [],
      discoveryState: "idle",
      managedOrchestratorStatus: undefined,
      automaticConnectionAvailable: true,
      snapshot: emptySnapshot(),
      route: { kind: "session" },
      navigationRevision: 0,
      preferences: DEFAULT_UI_PREFERENCES,
      extensionNotifications: []
    };
    const controller = {
      state,
      navigate: vi.fn(),
      setNavigationOpen: vi.fn(async () => undefined),
      setWindowZoom: vi.fn(async () => undefined)
    } as unknown as AppController;

    expect(() => renderToStaticMarkup(createElement(AppWithController, { controller }))).not.toThrow();
  });

  it("subscribes cold but sends no defaults until persisted preferences are ready", async () => {
    const configure = vi.fn(async () => undefined);
    const unsubscribe = vi.fn();
    const onCommand = vi.fn(() => unsubscribe);
    Object.defineProperty(window, "jokoDesktop", {
      configurable: true,
      value: {
        platform: "darwin",
        capabilities: ["app.info", "appearance.zoom", "application.menu", "inspector.detach", "selection.quote.contextMenu"],
        appInfo: { get: vi.fn() },
        applicationMenu: { configure, onCommand },
        selectionContextMenu: { setLocale: vi.fn(async () => undefined), onAddToChat: vi.fn() }
      } as unknown as JokoDesktopApi
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const cold = controllerWithState(false, DEFAULT_UI_PREFERENCES);

    await act(async () => { root.render(createElement(AppWithController, { controller: cold })); });
    expect(onCommand).toHaveBeenCalledOnce();
    expect(configure).not.toHaveBeenCalled();

    const loadedPreferences = {
      ...DEFAULT_UI_PREFERENCES,
      appShortcutOverrides: {
        "new-maker": { code: "KeyJ", meta: true, ctrl: false, alt: false, shift: false },
        "open-settings": null,
        "toggle-sidebar": null
      }
    };
    await act(async () => {
      root.render(createElement(AppWithController, {
        controller: controllerWithState(true, loadedPreferences)
      }));
    });
    expect(configure).toHaveBeenCalledOnce();
    expect(configure).toHaveBeenCalledWith({
      newSessionAccelerator: "Command+J",
      openSettingsAccelerator: null,
      toggleSidebarAccelerator: null
    });

    await act(async () => { root.unmount(); });
    expect(unsubscribe).toHaveBeenCalledOnce();
    container.remove();
    Reflect.deleteProperty(window, "jokoDesktop");
  });

  it("shows explicit feedback for a manual native-menu update check", async () => {
    let menuListener: ((command: "open-about" | "check-for-updates") => void) | undefined;
    const checkForUpdates = vi.fn(async () => ({ status: "up-to-date" as const }));
    Object.defineProperty(window, "jokoDesktop", {
      configurable: true,
      value: {
        platform: "darwin",
        capabilities: ["app.info", "appearance.zoom", "application.menu", "inspector.detach", "selection.quote.contextMenu"],
        appInfo: { get: vi.fn() },
        applicationMenu: {
          configure: vi.fn(async () => undefined),
          onCommand: vi.fn((listener: (command: "open-about" | "check-for-updates") => void) => {
            menuListener = listener;
            return vi.fn();
          })
        },
        checkForUpdates,
        selectionContextMenu: { setLocale: vi.fn(async () => undefined), onAddToChat: vi.fn() }
      } as unknown as JokoDesktopApi
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const disconnected = controllerWithState(true, DEFAULT_UI_PREFERENCES);

    await act(async () => { root.render(createElement(AppWithController, { controller: disconnected })); });
    await act(async () => {
      menuListener?.("check-for-updates");
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(checkForUpdates).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("You're on the latest version.");
    expect(container.textContent).toContain("Nearby Joko nodes");

    await act(async () => {
      menuListener?.("open-about");
      await Promise.resolve();
    });
    expect(disconnected.navigate).toHaveBeenCalledWith({ kind: "settings" });
    expect(window.location.hash).toBe("#/settings/about");

    await act(async () => { root.unmount(); });
    container.remove();
    window.location.hash = "";
    Reflect.deleteProperty(window, "jokoDesktop");
  });

  it("drops Settings and Check for Updates menu commands while startup update owns interaction", async () => {
    let menuListener: ((command: "new-session" | "open-settings" | "check-for-updates") => void) | undefined;
    const checkForUpdates = vi.fn(async () => ({ status: "up-to-date" as const }));
    Object.defineProperty(window, "jokoDesktop", {
      configurable: true,
      value: {
        platform: "darwin",
        capabilities: ["app.info", "appearance.zoom", "application.menu", "inspector.detach", "selection.quote.contextMenu"],
        appInfo: { get: vi.fn() },
        applicationMenu: {
          configure: vi.fn(async () => undefined),
          onCommand: vi.fn((listener: typeof menuListener) => {
            menuListener = listener;
            return vi.fn();
          })
        },
        checkForUpdates,
        selectionContextMenu: { setLocale: vi.fn(async () => undefined), onAddToChat: vi.fn() }
      } as unknown as JokoDesktopApi
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const disconnected = controllerWithState(true, DEFAULT_UI_PREFERENCES);

    await act(async () => { root.render(createElement(AppWithController, { controller: disconnected })); });
    const release = acquireStartupUpdateInteractionBarrier();
    try {
      await act(async () => {
        menuListener?.("new-session");
        menuListener?.("open-settings");
        menuListener?.("check-for-updates");
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(disconnected.navigate).not.toHaveBeenCalled();
      expect(checkForUpdates).not.toHaveBeenCalled();
      expect(container.textContent).not.toContain("You're on the latest version.");
    } finally {
      release();
    }

    await act(async () => {
      menuListener?.("open-settings");
      menuListener?.("check-for-updates");
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(disconnected.navigate).toHaveBeenCalledWith({ kind: "settings" });
    expect(checkForUpdates).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("You're on the latest version.");

    await act(async () => { root.unmount(); });
    container.remove();
    Reflect.deleteProperty(window, "jokoDesktop");
  });

  it("renders native About independently of the Orchestrator connection state", async () => {
    window.location.hash = "#/settings/about";
    Object.defineProperty(window, "jokoDesktop", {
      configurable: true,
      value: {
        platform: "darwin",
        capabilities: ["app.info", "appearance.zoom", "application.menu", "inspector.detach", "selection.quote.contextMenu"],
        appInfo: {
          get: vi.fn(async () => ({
            name: "Joko",
            version: "9.8.7",
            platform: "darwin" as const,
            electronVersion: "39.2.7"
          }))
        },
        applicationMenu: {
          configure: vi.fn(async () => undefined),
          onCommand: vi.fn(() => vi.fn())
        },
        selectionContextMenu: { setLocale: vi.fn(async () => undefined), onAddToChat: vi.fn() }
      } as unknown as JokoDesktopApi
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await import("./components/SettingsPage.js");
    await act(async () => {
      root.render(createElement(AppWithController, {
        controller: controllerWithState(true, DEFAULT_UI_PREFERENCES)
      }));
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    });

    expect(container.textContent).toContain("About");
    expect(container.textContent).toContain("9.8.7");
    expect(container.textContent).not.toContain("Nearby Joko nodes");

    await act(async () => { root.unmount(); });
    container.remove();
    window.location.hash = "";
    Reflect.deleteProperty(window, "jokoDesktop");
  });

  it("keeps connected About inside the full settings shell", async () => {
    window.location.hash = "#/settings/about";
    Object.defineProperty(window, "jokoDesktop", {
      configurable: true,
      value: {
        platform: "darwin",
        capabilities: ["app.info", "appearance.zoom", "application.menu", "inspector.detach", "selection.quote.contextMenu"],
        appInfo: {
          get: vi.fn(async () => ({
            name: "Joko",
            version: "9.8.7",
            platform: "darwin" as const,
            electronVersion: "39.2.7"
          }))
        },
        applicationMenu: {
          configure: vi.fn(async () => undefined),
          onCommand: vi.fn(() => vi.fn())
        },
        selectionContextMenu: { setLocale: vi.fn(async () => undefined), onAddToChat: vi.fn() }
      } as unknown as JokoDesktopApi
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await import("./components/SettingsPage.js");
    await act(async () => {
      root.render(createElement(AppWithController, {
        controller: controllerWithState(true, DEFAULT_UI_PREFERENCES, true, { kind: "settings" })
      }));
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    });

    expect(container.querySelector(".settings-nav")).not.toBeNull();
    expect(container.textContent).toContain("9.8.7");

    await act(async () => { root.unmount(); });
    container.remove();
    window.location.hash = "";
    Reflect.deleteProperty(window, "jokoDesktop");
  });
});

function controllerWithState(
  ready: boolean,
  preferences: ControllerState["preferences"],
  connected = false,
  route: ControllerState["route"] = { kind: "session" }
): AppController {
  return {
    state: {
      ready,
      connectionState: connected ? "connected" : "disconnected",
      profiles: [],
      ...(connected ? { activeProfile: { id: "profile", serverId: "server", name: "Local", origin: "http://127.0.0.1" } } : {}),
      discoveredNodes: [],
      discoveryState: "idle",
      managedOrchestratorStatus: undefined,
      snapshot: connected ? { ...emptySnapshot(), revision: 1n } : emptySnapshot(),
      route,
      navigationRevision: 0,
      preferences,
      extensionNotifications: []
    },
    navigate: vi.fn(),
    refreshDiscoveredNodes: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    retryManagedOrchestrator: vi.fn(async () => undefined),
    getTaskHistoryMaintenanceSupport: vi.fn(async () => ({ supported: false })),
    setNavigationOpen: vi.fn(async () => undefined),
    setNavigationLayout: vi.fn(async () => undefined),
    setWindowZoom: vi.fn(async () => undefined)
  } as unknown as AppController;
}
