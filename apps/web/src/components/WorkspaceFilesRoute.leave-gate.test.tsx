// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppController } from "../controller.js";
import { DEFAULT_UI_PREFERENCES } from "../local-state.js";
import { emptySnapshot, type BackendView, type SessionView, type TargetView, type WorkspaceView } from "../model.js";
import { workspaceDocumentController } from "../workspace-document-controller.js";
import { requestWorkspaceDocumentLeave } from "../workspace-document-lifecycle.js";
import { WorkspaceFilesRoute } from "./WorkspaceFilesRoute.js";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("WorkspaceFilesRoute leave gate", () => {
  it("reruns an already settled Files search against the rebound workspace", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    vi.useFakeTimers();
    const streamWorkspaceSearch = vi.fn<AppController["streamWorkspaceSearch"]>(async function* () {
      yield { kind: "end" as const, truncated: false, totalMatches: 0, totalFiles: 0, revision: "new" };
    }).mockImplementationOnce(async function* () {
      yield { kind: "match" as const, match: { path: "report.txt", line: 1, preview: "needle_A from the old root", submatches: [], revision: "old",
        range: { startByte: 0, endByte: 8, startLine: 1, endLine: 1, startColumn: 1, endColumn: 9 } } };
      yield { kind: "end" as const, truncated: false, totalMatches: 1, totalFiles: 1, revision: "old" };
    });
    const connected = Object.assign(controller(), { listWorkspaceEntries: vi.fn(async () => []), streamWorkspaceSearch });
    const original = workspace();
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    try {
      await act(async () => root.render(routeView(connected)));
      await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="workspace.search"]')!.click());
      const search = host.querySelector<HTMLInputElement>('input[aria-label="workspace.searchPlaceholder"]')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "needle_A");
        search.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await act(async () => { await vi.advanceTimersByTimeAsync(250); });
      expect(host.textContent).toContain("needle_A from the old root");
      await act(async () => root.render(routeView(connected, backend(), { ...original,
        remoteWorkspace: { kind: "ssh", hostId: "ssh-host", hostTargetId: "ssh-target", workspaceRoot: "/project" }
      })));
      expect(search.value).toBe("needle_A");
      expect(host.textContent).not.toContain("needle_A from the old root");
      await act(async () => { await vi.advanceTimersByTimeAsync(250); });
      expect(streamWorkspaceSearch).toHaveBeenCalledTimes(2);
      expect(streamWorkspaceSearch).toHaveBeenLastCalledWith(original.id, "needle_A", false, expect.any(AbortSignal));
      expect(host.textContent).toContain("workspace.noMatches");
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.useRealTimers();
    }
  });

  it("closes an aborted dirty-document prompt without saving or discarding", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const save = vi.fn(async () => true);
    const discard = vi.fn();
    const focus = vi.fn();
    const dirty = { current: true };
    const registration = workspaceDocumentController.register({
      identity: { sessionId: "leave-task", workspaceId: "leave-workspace", path: "src/dirty.ts" },
      isDirty: () => dirty.current,
      save,
      discard,
      focus
    });
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    const owner = new AbortController();
    let leave!: Promise<boolean>;
    try {
      await act(async () => root.render(routeView(controller())));

      await act(async () => {
        leave = requestWorkspaceDocumentLeave({ reason: "route-change", signal: owner.signal });
        await Promise.resolve();
      });
      expect(document.body.querySelector('[role="dialog"][aria-modal="true"]')).not.toBeNull();
      await act(async () => owner.abort());

      await expect(leave).resolves.toBe(false);
      await vi.waitFor(() => expect(document.body.querySelector('[role="dialog"][aria-modal="true"]')).toBeNull());
      expect(save).not.toHaveBeenCalled();
      expect(discard).not.toHaveBeenCalled();
      expect(focus).not.toHaveBeenCalled();
      expect(dirty.current).toBe(true);
    } finally {
      registration.unregister();
      await act(async () => root.unmount());
      host.remove();
    }
  });

  it("submits the confirmed file revision even when the same path now lists a different file", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const path = "report.txt";
    const file = { path, name: path, kind: "file" as const, revision: "original-revision" };
    const listWorkspaceEntries = vi.fn(async () => [file]);
    const deleteWorkspaceEntry = vi.fn(async () => { throw new Error("The file revision changed."); });
    const connected = Object.assign(controller(), { listWorkspaceEntries, deleteWorkspaceEntry });
    const writable = backend();
    const capabilities = new Map(writable.capabilities);
    capabilities.set("workspace.files.write", { name: "workspace.files.write", supported: true, options: [] });
    const host = document.body.appendChild(document.createElement("div"));
    const root = createRoot(host);
    try {
      await act(async () => root.render(routeView(connected, { ...writable, capabilities })));
      const row = host.querySelector(`[data-relative-path="${path}"]`);
      expect(row).not.toBeNull();
      await act(async () => row!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
      const remove = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
        .find((button) => button.textContent === "common.delete");
      expect(remove).toBeDefined();
      await act(async () => remove!.click());
      const confirm = document.querySelector<HTMLButtonElement>('[role="dialog"] button[data-confirm]');
      expect(confirm).not.toBeNull();
      listWorkspaceEntries.mockResolvedValue([{ ...file, revision: "replacement-revision" }]);

      await act(async () => confirm!.click());
      expect(deleteWorkspaceEntry).toHaveBeenCalledExactlyOnceWith({ workspaceId: "leave-workspace", path,
        expectedRevision: "original-revision", confirmRecursive: false });
      expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe("workspace.actionFailed");
      expect(host.querySelector(`[data-relative-path="${path}"]`)).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
      host.remove();
    }
  });
});

function routeView(controller: AppController, backendView = backend(), selectedWorkspace = workspace()) {
  return <WorkspaceFilesRoute controller={controller} route={{ kind: "files", sessionId: "leave-task" }}
    session={session()} target={target()} backend={backendView} workspace={selectedWorkspace} sessions={[session()]}
    chatPane={null} t={(key) => key} onError={vi.fn()} onArchiveSession={vi.fn()}
    navigation={{
      open: true, mode: "expanded", width: 320,
      onCloseDrawer: vi.fn(), onHide: vi.fn(), onCollapse: vi.fn(), onExpand: vi.fn(), onResizePointerDown: vi.fn(),
      onResizePointerMove: vi.fn(), onResizePointerUp: vi.fn(), onResizePointerCancel: vi.fn(),
      onResizeKeyDown: vi.fn(), onResetWidth: vi.fn(), onDisconnect: vi.fn()
    }} />;
}

function controller(): AppController {
  return {
    state: {
      ready: true,
      connectionState: "connected",
      profiles: [],
      machineCaches: [],
      machinePresenceByProfile: {},
      discoveredNodes: [],
      discoveryState: "idle",
      managedOrchestratorStatus: undefined,
      automaticConnectionAvailable: false,
      snapshot: emptySnapshot(),
      route: { kind: "files", sessionId: "leave-task" },
      preferences: DEFAULT_UI_PREFERENCES,
      extensionNotifications: []
    },
    navigate: vi.fn(),
    probeRuntimeActivity: vi.fn(async () => false)
  } as unknown as AppController;
}

function session(): SessionView {
  return {
    id: "leave-task",
    backendId: "leave-backend",
    targetId: "leave-target",
    name: "Leave task",
    state: "idle",
    pinned: false,
    archived: false,
    generation: 1n,
    fastMode: false,
    permissionMode: "ask",
    planMode: false,
    updatedAt: 1
  };
}

function target(): TargetView {
  return {
    id: "leave-target",
    backendId: "leave-backend",
    name: "Leave project",
    workspaceId: "leave-workspace",
    revision: 1n,
    workspaceName: "Leave workspace",
    trusted: true,
    pinned: false,
    archived: false
  };
}

function backend(): BackendView {
  return {
    id: "leave-backend",
    name: "Leave backend",
    version: "1",
    health: "healthy",
    capabilities: new Map([
      ["workspace.files", { name: "workspace.files", supported: true, options: [] }]
    ])
  };
}

function workspace(): WorkspaceView {
  return {
    id: "leave-workspace",
    targetId: "leave-target",
    name: "Leave workspace",
    kind: "userProject",
    serverPath: "C:/leave",
    trusted: true,
    dirty: false,
    entries: []
  };
}
