// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppController, AppRoute, ControllerState } from "./controller.js";
import type { GamepadAction } from "./gamepad-input.js";
import { DEFAULT_UI_PREFERENCES } from "./local-state.js";
import { emptySnapshot } from "./model.js";

const gamepad = vi.hoisted(() => ({
  action: undefined as ((action: GamepadAction) => void) | undefined,
  requestLeave: vi.fn()
}));

vi.mock("./gamepad-client.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./gamepad-client.js")>(),
  useGamepadInput: (_ownerKey: string, action: (value: GamepadAction) => void) => { gamepad.action = action; }
}));

vi.mock("./workspace-document-lifecycle.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./workspace-document-lifecycle.js")>(),
  requestWorkspaceDocumentLeave: gamepad.requestLeave
}));

import { AppWithController } from "./App.js";

let root: Root | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  document.body.replaceChildren();
  document.body.className = "";
  gamepad.action = undefined;
  gamepad.requestLeave.mockReset();
});
afterEach(async () => {
  if (root !== undefined) await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  document.body.className = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("guards Files navigation and opens the new-task project picker exactly once per admitted folder action", async () => {
  const view = controller({ kind: "files", sessionId: "draft-session" });
  const host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement(AppWithController, { controller: view.value }));
    await Promise.resolve();
  });
  expect(gamepad.action).toBeTypeOf("function");

  gamepad.requestLeave.mockResolvedValueOnce(false);
  await act(async () => {
    gamepad.action?.("open-folder");
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(gamepad.requestLeave).toHaveBeenCalledOnce();
  expect(view.navigate).not.toHaveBeenCalled();

  await act(async () => {
    view.replaceRoute({ kind: "newSession" });
    root?.render(createElement(AppWithController, { controller: view.value }));
  });
  expect(document.querySelector("[role='listbox']")).toBeNull();
  await act(async () => {
    view.replaceRoute({ kind: "files", sessionId: "draft-session" });
    root?.render(createElement(AppWithController, { controller: view.value }));
  });

  gamepad.requestLeave.mockResolvedValueOnce(true);
  await act(async () => {
    gamepad.action?.("open-folder");
    await Promise.resolve();
    await Promise.resolve();
  });
  await vi.waitFor(() => expect(document.querySelector("[role='listbox']")?.textContent).toContain("Add project"));
  expect(view.navigate).toHaveBeenCalledExactlyOnceWith({ kind: "newSession" });
  await act(async () => { gamepad.action?.("open-folder"); await Promise.resolve(); });
  expect(view.navigate).toHaveBeenCalledTimes(1);

  await act(async () => {
    const addProject = [...document.querySelectorAll<HTMLElement>("[role='option']")].find((option) => option.textContent?.includes("Add project"));
    if (addProject === undefined) throw new Error("Missing add-project option.");
    addProject.click();
  });
  expect(document.querySelector("[role='listbox']")).toBeNull();
  expect(document.querySelector("[role='dialog']")?.textContent).toContain("New project");
  await act(async () => button(document.body, "Cancel").click());
  expect(document.querySelector("[role='dialog']")).toBeNull();
  await act(async () => root?.render(createElement(AppWithController, { controller: view.value })));
  expect(document.querySelector("[role='listbox']")).toBeNull();

  await act(async () => {
    gamepad.action?.("open-folder");
    await Promise.resolve();
    await Promise.resolve();
  });
  await vi.waitFor(() => expect(document.querySelector("[role='listbox']")?.textContent).toContain("Add project"));
  expect(view.navigate).toHaveBeenCalledTimes(2);
  expect(gamepad.requestLeave).toHaveBeenCalledTimes(2);
});

it("drops a pending folder action when navigation changes before the Files leave decision", async () => {
  const view = controller({ kind: "files", sessionId: "draft-session" });
  const host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
  let acceptLeave!: (allowed: boolean) => void;
  gamepad.requestLeave.mockReturnValue(new Promise<boolean>((resolve) => { acceptLeave = resolve; }));
  await act(async () => root?.render(createElement(AppWithController, { controller: view.value })));
  await act(async () => { gamepad.action?.("open-folder"); });
  expect(gamepad.requestLeave).toHaveBeenCalledOnce();

  await act(async () => {
    view.replaceRoute({ kind: "session" });
    root?.render(createElement(AppWithController, { controller: view.value }));
  });
  await act(async () => { acceptLeave(true); await Promise.resolve(); });
  expect(view.navigate).not.toHaveBeenCalled();

  await act(async () => {
    view.replaceRoute({ kind: "newSession" });
    root?.render(createElement(AppWithController, { controller: view.value }));
  });
  expect(document.querySelector("[role='listbox']")).toBeNull();
});

function controller(route: AppRoute): {
  readonly value: AppController;
  readonly navigate: ReturnType<typeof vi.fn>;
  readonly replaceRoute: (route: AppRoute) => void;
} {
  const profile = { id: "profile", deviceId: "device", serverId: "server", name: "Local", origin: "http://127.0.0.1" };
  let state = {
    ready: true,
    connectionState: "connected",
    profiles: [profile],
    machineCaches: [],
    machinePresenceByProfile: {},
    activeProfile: profile,
    discoveredNodes: [],
    discoveryState: "idle",
    managedOrchestratorStatus: undefined,
    automaticConnectionAvailable: true,
    snapshot: { ...emptySnapshot(), generation: 11n },
    route,
    navigationRevision: 0,
    preferences: DEFAULT_UI_PREFERENCES,
    extensionNotifications: []
  } as ControllerState;
  const navigate = vi.fn((next: AppRoute) => {
    state = { ...state, route: next, navigationRevision: (state.navigationRevision ?? 0) + 1 };
  });
  const value = {
    get state() { return state; },
    navigate,
    refreshDiscoveredNodes: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    retryManagedOrchestrator: vi.fn(async () => undefined),
    getTaskHistoryMaintenanceSupport: vi.fn(async () => ({ supported: false })),
    setNavigationOpen: vi.fn(async () => undefined),
    setNavigationLayout: vi.fn(async () => undefined),
    setWindowZoom: vi.fn(async () => undefined),
    probeRuntimeActivity: vi.fn(async () => false),
    readNewSessionDraft: vi.fn(async () => undefined),
    saveNewSessionDraft: vi.fn(async () => undefined),
    readPendingExtensionUse: vi.fn(async () => undefined),
    prepareTargetWorkspace: vi.fn(async () => undefined),
    probeTargetWorktree: vi.fn(async (targetId: string) => ({ targetId, eligibility: "unavailable", canRefreshRemote: false })),
    listTargetWorktreeSources: vi.fn(async () => []),
    setNewSessionWorktreeEnabled: vi.fn(async () => undefined)
  } as unknown as AppController;
  return {
    value,
    navigate,
    replaceRoute: (next) => { state = { ...state, route: next, navigationRevision: (state.navigationRevision ?? 0) + 1 }; }
  };
}

function button(host: HTMLElement, label: string): HTMLButtonElement {
  const result = [...host.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === label);
  if (result === undefined) throw new Error(`Missing ${label} action.`);
  return result;
}
