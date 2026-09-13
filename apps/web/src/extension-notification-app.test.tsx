// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { AppWithController } from "./App.js";
import { clearTransientExtensionUiState, type AppController, type ControllerState } from "./controller.js";
import { DEFAULT_UI_PREFERENCES } from "./local-state.js";
import { emptySnapshot } from "./model.js";

describe("extension notification application surface", () => {
  it("renders typed live-region semantics and drops the previous generation", async () => {
    const navigate = vi.fn();
    const dismiss = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const firstState: ControllerState = {
      ...connectedState(),
      extensionNotifications: [
        { eventId: "info", sessionId: "session-info", text: "Information body", kind: "info" },
        { eventId: "warning", sessionId: "session-warning", text: "Warning body", kind: "warning" },
        { eventId: "error", sessionId: "session-error", text: "Error body", kind: "error" },
        { eventId: "unknown", sessionId: "session-unknown", text: "Neutral body", kind: "unknown" }
      ]
    };

    await act(async () => {
      root.render(createElement(AppWithController, { controller: controller(firstState, navigate, dismiss) }));
    });

    const info = required(container.querySelector('[data-notification-kind="info"]'));
    const warning = required(container.querySelector('[data-notification-kind="warning"]'));
    const error = required(container.querySelector('[data-notification-kind="error"]'));
    const unknown = required(container.querySelector('[data-notification-kind="unknown"]'));
    expect(info.getAttribute("role")).toBe("status");
    expect(warning.getAttribute("role")).toBe("status");
    expect(error.getAttribute("role")).toBe("alert");
    expect(unknown.getAttribute("role")).toBe("status");
    expect(warning.textContent).toContain("Warning: Warning body");
    expect(error.textContent).toContain("Error: Error body");

    await act(async () => {
      warning.querySelector<HTMLButtonElement>(".extension-notification__body")?.click();
      error.querySelector<HTMLButtonElement>(".icon-button")?.click();
    });
    expect(navigate).toHaveBeenCalledWith({ kind: "session", sessionId: "session-warning" });
    expect(dismiss).toHaveBeenCalledWith("error");

    await act(async () => {
      root.render(createElement(AppWithController, {
        controller: controller(clearTransientExtensionUiState(firstState), navigate, dismiss)
      }));
    });
    expect(container.querySelector(".extension-notification")).toBeNull();
    expect(container.textContent).not.toContain("Warning body");

    await act(async () => { root.unmount(); });
    container.remove();
  });
});

function connectedState(): ControllerState {
  return {
    ready: true,
    connectionState: "connected",
    profiles: [],
    machineCaches: [],
    machinePresenceByProfile: {},
    activeProfile: { id: "profile-a", deviceId: "device-test", serverId: "server-a", name: "Local", origin: "http://127.0.0.1"  },
    discoveredNodes: [],
    discoveryState: "idle",
    managedOrchestratorStatus: undefined,
    automaticConnectionAvailable: true,
    snapshot: { ...emptySnapshot(), revision: 1n },
    route: { kind: "session", sessionId: "session-current" },
    navigationRevision: 0,
    preferences: DEFAULT_UI_PREFERENCES,
    extensionNotifications: []
  };
}

function controller(
  state: ControllerState,
  navigate: ReturnType<typeof vi.fn>,
  dismissExtensionNotification: ReturnType<typeof vi.fn>
): AppController {
  return {
    state,
    navigate,
    dismissExtensionNotification,
    refreshMachines: vi.fn(async () => undefined),
    setNavigationOpen: vi.fn(async () => undefined),
    setNavigationLayout: vi.fn(async () => undefined),
    resetLayoutPreferences: vi.fn(async () => undefined),
    refreshProviderModels: vi.fn(async () => undefined)
  } as unknown as AppController;
}

function required(value: Element | null): Element {
  if (value === null) throw new Error("Expected notification element.");
  return value;
}
