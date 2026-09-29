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
      await act(async () => {
        root.render(<WorkspaceFilesRoute
          controller={controller()}
          route={{ kind: "files", sessionId: "leave-task" }}
          session={session()}
          target={target()}
          backend={backend()}
          workspace={workspace()}
          sessions={[session()]}
          chatPane={null}
          t={(key) => key}
          onError={vi.fn()}
          onArchiveSession={vi.fn()}
          navigation={{
            open: true,
            mode: "expanded",
            width: 320,
            onCloseDrawer: vi.fn(),
            onHide: vi.fn(),
            onCollapse: vi.fn(),
            onExpand: vi.fn(),
            onResizePointerDown: vi.fn(),
            onResizePointerMove: vi.fn(),
            onResizePointerUp: vi.fn(),
            onResizePointerCancel: vi.fn(),
            onResizeKeyDown: vi.fn(),
            onResetWidth: vi.fn(),
            onDisconnect: vi.fn()
          }}
        />);
      });

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
});

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
