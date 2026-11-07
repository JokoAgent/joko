// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { AppWithController } from "./App.js";
import { clearTransientExtensionUiState, type AppController, type ControllerState } from "./controller.js";
import { DEFAULT_UI_PREFERENCES } from "./local-state.js";
import { emptySnapshot, type SessionView, type TimelineItemView } from "./model.js";

vi.mock("./components/SessionPane.js", () => ({ SessionPane: ({ session, timeline }: { session: SessionView; timeline: readonly TimelineItemView[] }) =>
  <section data-background-task-pane>{session.name}{timeline.map(item => item.text).join(" ")}</section> }));

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

it("opens a scoped hidden task and reads its ordinary timeline without adding a sidebar row", async () => {
  const initial = connectedState();
  const route = { kind: "session" as const, sessionId: "background", profileId: initial.activeProfile!.id, backgroundExtensionId: `extension_${"1".repeat(32)}` };
  const session: SessionView = { id: route.sessionId, backendId: "pi", targetId: "project", name: "Private extension review", hidden: true,
    archived: false, pinned: false, state: "idle", generation: 3n, updatedAt: 1, permissionMode: "ask", planMode: false, fastMode: false };
  const state: ControllerState = { ...initial, route, connectionGeneration: 1, extensionBackgroundTask: {
    route, navigationRevision: initial.navigationRevision, connectionGeneration: 1, ownerGeneration: initial.snapshot.generation,
    view: { session, cursor: 1n }
  } };
  const navigate = vi.fn();
  const loadSessionTimelinePage = vi.fn<AppController["loadSessionTimelinePage"]>(async () => ({
    items: [{ id: "answer", sequence: 1n, createdAt: 1, kind: "assistant", text: "Retained review result." }]
  }));
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const render = (value: ControllerState) => root.render(createElement(AppWithController, {
    controller: { ...controller(value, navigate, vi.fn()), loadSessionTimelinePage }
  }));
  try {
    await act(async () => render(state));
    await vi.waitFor(() => expect(host.querySelector("[data-background-task-pane]")?.textContent).toContain("Retained review result."));
    expect(host.querySelector("[data-background-task-pane]")?.textContent).toContain(session.name);
    expect(host.querySelector(".sidebar__sessions")?.textContent ?? "").not.toContain(session.name);
    expect(loadSessionTimelinePage).toHaveBeenCalledWith(route.sessionId, undefined, 240);
    expect(navigate).not.toHaveBeenCalled();

    await act(async () => render({ ...state, connectionGeneration: 2 }));
    expect(host.querySelector("[data-background-task-pane]")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
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
    systemLocale: "en",
    effectiveLocale: "en",
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
    partnerGroupApi: () => undefined,
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
