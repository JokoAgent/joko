// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { AppWithController } from "./App.js";
import type { AppController, ControllerState } from "./controller.js";
import { DEFAULT_UI_PREFERENCES } from "./local-state.js";
import { emptySnapshot } from "./model.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("desktop layout reset broadcast", () => {
  it("synchronizes the receiving renderer without persisting preferences again", async () => {
    let listener: (() => void) | undefined;
    const unsubscribe = vi.fn();
    Object.defineProperty(window, "jokoDesktop", {
      configurable: true,
      value: {
        platform: "win32",
        capabilities: ["layout.reset"],
        layout: {
          reset: vi.fn(async () => undefined),
          onReset: vi.fn((next: () => void) => {
            listener = next;
            return unsubscribe;
          })
        },
        applicationMenu: {
          configure: vi.fn(async () => undefined),
          onCommand: vi.fn(() => vi.fn())
        }
      } as unknown as JokoDesktopApi
    });
    const synchronizeLayoutReset = vi.fn();
    const resetLayoutPreferences = vi.fn(async () => undefined);
    const state: ControllerState = {
      ready: false,
      connectionState: "disconnected",
      profiles: [],
      machineCaches: [],
      machinePresenceByProfile: {},
      discoveredNodes: [],
      discoveryState: "idle",
      managedOrchestratorStatus: undefined,
      automaticConnectionAvailable: false,
      snapshot: emptySnapshot(),
      route: { kind: "session" },
      navigationRevision: 0,
      preferences: DEFAULT_UI_PREFERENCES,
      extensionNotifications: []
    };
    const controller = {
      state,
      synchronizeLayoutReset,
      resetLayoutPreferences,
      navigate: vi.fn(),
      setNavigationOpen: vi.fn(async () => undefined),
      setWindowZoom: vi.fn(async () => undefined)
    } as unknown as AppController;
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => { root.render(createElement(AppWithController, { controller })); });
    act(() => listener?.());

    expect(synchronizeLayoutReset).toHaveBeenCalledOnce();
    expect(resetLayoutPreferences).not.toHaveBeenCalled();

    await act(async () => { root.unmount(); });
    expect(unsubscribe).toHaveBeenCalledOnce();
    container.remove();
    Reflect.deleteProperty(window, "jokoDesktop");
  });
});
