// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppController, AppRoute, ControllerState } from "./controller.js";
import type { GamepadAction } from "./gamepad-input.js";
import type { DedicatedHardwareRendererHandlers } from "./dedicated-hardware-app.js";
import type { DedicatedHardwareBridge } from "./dedicated-hardware.js";
import { DEFAULT_UI_PREFERENCES } from "./local-state.js";
import { emptySnapshot, type SessionView } from "./model.js";

const gamepad = vi.hoisted(() => ({
  action: undefined as ((action: GamepadAction) => void) | undefined,
  dedicated: undefined as DedicatedHardwareRendererHandlers | undefined,
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

vi.mock("./dedicated-hardware-app.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./dedicated-hardware-app.js")>(),
  useDedicatedHardwareInput: (_bridge: unknown, handlers: DedicatedHardwareRendererHandlers) => { gamepad.dedicated = handlers; }
}));

import { AppWithController } from "./App.js";

let root: Root | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  document.body.replaceChildren();
  document.body.className = "";
  gamepad.action = undefined;
  gamepad.dedicated = undefined;
  gamepad.requestLeave.mockReset();
});
afterEach(async () => {
  if (root !== undefined) await act(async () => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  document.body.className = "";
  Reflect.deleteProperty(window, "jokoDesktop");
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
  expect(projectPicker()).toBeNull();
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
  await vi.waitFor(() => expect(projectPicker()?.textContent).toContain("Add project"));
  expect(view.navigate).toHaveBeenCalledExactlyOnceWith({ kind: "newSession" });
  await act(async () => { gamepad.action?.("open-folder"); await Promise.resolve(); });
  expect(view.navigate).toHaveBeenCalledTimes(1);

  await act(async () => {
    const addProject = [...document.querySelectorAll<HTMLElement>("[data-new-task-project-picker][data-state='open'] [data-project-picker-choice]")].find((option) => option.textContent?.includes("Add project"));
    if (addProject === undefined) throw new Error("Missing add-project option.");
    addProject.click();
  });
  expect(projectPicker()).toBeNull();
  expect(document.querySelector("[role='dialog']")?.textContent).toContain("New project");
  await act(async () => button(document.body, "Cancel").click());
  expect(document.querySelector("[role='dialog'] form")).toBeNull();
  await act(async () => root?.render(createElement(AppWithController, { controller: view.value })));
  expect(projectPicker()).toBeNull();

  await act(async () => {
    gamepad.action?.("open-folder");
    await Promise.resolve();
    await Promise.resolve();
  });
  await vi.waitFor(() => expect(projectPicker()?.textContent).toContain("Add project"));
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
  expect(projectPicker()).toBeNull();
});

it("opens the fixed product feedback destination without a task or connection and reports failures", async () => {
  const view = controller({ kind: "settings" }, "disconnected");
  const host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(createElement(AppWithController, { controller: view.value })));
  await act(async () => { gamepad.action?.("feedback"); await Promise.resolve(); });
  expect(view.openHttpLink).toHaveBeenCalledExactlyOnceWith("https://github.com/JokoAgent/joko/issues/new", { forceExternal: true });
  expect(view.navigate).not.toHaveBeenCalled();

  view.openHttpLink.mockRejectedValueOnce(new Error("Default browser unavailable."));
  await act(async () => { gamepad.action?.("feedback"); await Promise.resolve(); await Promise.resolve(); });
  await vi.waitFor(() => expect(document.querySelector("[role='alert']")?.textContent).toContain("Default browser unavailable."));
  expect(view.openHttpLink).toHaveBeenCalledTimes(2);
  expect(document.querySelector("[role='alert'] button")?.getAttribute("aria-label")).toBe("Dismiss");
});

it("revalidates every dedicated task fence and opens only frozen product links", async () => {
  const task: SessionView = {
    id: "task-two", backendId: "backend", targetId: "target-two", name: "Task two", state: "idle",
    pinned: false, archived: false, generation: 3n, fastMode: false, permissionMode: "ask", planMode: false, updatedAt: 1
  };
  const view = controller({ kind: "settings" }, "connected", task);
  const acknowledgeTaskFocus = vi.fn(async () => true);
  const hardwareBridge: DedicatedHardwareBridge = {
    getDedicatedHardwareState: vi.fn(async () => undefined),
    setDedicatedHardwareSettings: vi.fn(async () => undefined),
    resetDedicatedHardwareSettings: vi.fn(async () => undefined),
    probeDedicatedHardware: vi.fn(async () => undefined),
    recoverDedicatedHardwareKeymap: vi.fn(async () => undefined),
    setDedicatedHardwarePreview: vi.fn(async () => undefined),
    publishDedicatedHardwareTasks: vi.fn(async () => undefined),
    acknowledgeDedicatedHardwareTaskFocus: acknowledgeTaskFocus
  };
  Object.defineProperty(window, "jokoDesktop", {
    configurable: true,
    value: {
      capabilities: ["hardware.dedicatedInput"],
      platform: "win32",
      dedicatedHardware: hardwareBridge,
      applicationMenu: {
        configure: vi.fn(async () => undefined),
        onCommand: vi.fn(() => () => undefined)
      }
    }
  });
  const host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
  await act(async () => root?.render(createElement(AppWithController, { controller: view.value })));
  const action = {
    kind: "task", profileId: "profile", serverId: "server", connectionGeneration: "11", snapshotRevision: "7",
    sessionId: task.id, sessionGeneration: "3", targetId: task.targetId, focusWindow: false
  } as const;
  expect(gamepad.dedicated).toBeDefined();
  expect(gamepad.dedicated!.task({ task: { ...action, connectionGeneration: "10" }, focusRequestId: null })).toBe(false);
  expect(gamepad.dedicated!.task({ task: { ...action, snapshotRevision: "6" }, focusRequestId: null })).toBe(false);
  expect(gamepad.dedicated!.task({ task: { ...action, sessionGeneration: "2" }, focusRequestId: null })).toBe(false);
  expect(gamepad.dedicated!.task({ task: { ...action, targetId: "target-stale" }, focusRequestId: null })).toBe(false);
  expect(gamepad.dedicated!.task({ task: { ...action, serverId: "server-stale" }, focusRequestId: null })).toBe(false);
  expect(view.navigate).not.toHaveBeenCalled();
  expect(acknowledgeTaskFocus).not.toHaveBeenCalled();

  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  expect(gamepad.dedicated!.task({ task: action, focusRequestId: null })).toBe(true);
  await act(async () => { await Promise.resolve(); });
  expect(view.navigate).toHaveBeenCalledExactlyOnceWith({ kind: "session", sessionId: task.id });
  expect(acknowledgeTaskFocus).not.toHaveBeenCalled();
  const focusTask = { ...action, focusWindow: true } as const;
  expect(gamepad.dedicated!.task({ task: focusTask, focusRequestId: "1" })).toBe(true);
  await act(async () => { await Promise.resolve(); });
  expect(acknowledgeTaskFocus).toHaveBeenCalledExactlyOnceWith({
    version: 1,
    focusRequestId: "1",
    task: focusTask
  });

  await act(async () => {
    view.replaceRoute({ kind: "files", sessionId: task.id });
    root?.render(createElement(AppWithController, { controller: view.value }));
  });
  gamepad.requestLeave.mockResolvedValueOnce(false);
  expect(gamepad.dedicated!.task({ task: focusTask, focusRequestId: "2" })).toBe(true);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(acknowledgeTaskFocus).toHaveBeenCalledTimes(1);
  expect(gamepad.dedicated!.fixedLink("documentation")).toBe(true);
  await act(async () => { await Promise.resolve(); });
  expect(view.openHttpLink).toHaveBeenCalledWith("https://github.com/JokoAgent/joko", { forceExternal: true });
});

function controller(route: AppRoute, connectionState: ControllerState["connectionState"] = "connected", task?: SessionView): {
  readonly value: AppController;
  readonly navigate: ReturnType<typeof vi.fn>;
  readonly openHttpLink: ReturnType<typeof vi.fn>;
  readonly replaceRoute: (route: AppRoute) => void;
} {
  const profile = { id: "profile", deviceId: "device", serverId: "server", name: "Local", origin: "http://127.0.0.1" };
  let state = {
    ready: true,
    connectionState,
    profiles: [profile],
    machineCaches: [],
    machinePresenceByProfile: {},
    activeProfile: profile,
    discoveredNodes: [],
    discoveryState: "idle",
    managedOrchestratorStatus: undefined,
    automaticConnectionAvailable: true,
    snapshot: { ...emptySnapshot(), generation: 11n, revision: task === undefined ? 0n : 7n, sessions: task === undefined ? [] : [task] },
    route,
    navigationRevision: 0,
    preferences: DEFAULT_UI_PREFERENCES,
    extensionNotifications: []
  } as ControllerState;
  const navigate = vi.fn((next: AppRoute) => {
    state = { ...state, route: next, navigationRevision: (state.navigationRevision ?? 0) + 1 };
  });
  const openHttpLink = vi.fn(async () => undefined);
  const value = {
    get state() { return state; },
    navigate,
    openHttpLink,
    refreshDiscoveredNodes: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    retryManagedOrchestrator: vi.fn(async () => undefined),
    getTaskHistoryMaintenanceSupport: vi.fn(async () => ({ supported: false })),
    setNavigationOpen: vi.fn(async () => undefined),
    setNavigationLayout: vi.fn(async () => undefined),
    changeWindowZoom: vi.fn(async () => 1),
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
    openHttpLink,
    replaceRoute: (next) => { state = { ...state, route: next, navigationRevision: (state.navigationRevision ?? 0) + 1 }; }
  };
}

function button(host: HTMLElement, label: string): HTMLButtonElement {
  const result = [...host.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === label);
  if (result === undefined) throw new Error(`Missing ${label} action.`);
  return result;
}

function projectPicker(): HTMLElement | null {
  return document.querySelector<HTMLElement>("[data-new-task-project-picker][data-state='open']");
}
