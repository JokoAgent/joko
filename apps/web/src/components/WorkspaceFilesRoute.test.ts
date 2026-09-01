import { describe, expect, it, vi } from "vitest";

import type { BackendView, SessionView, TargetView, WorkspaceFileChangeView, WorkspaceView } from "../model.js";
import { workspaceOpenTabsStore } from "../workspace-open-tabs.js";
import {
  abortableWorkspaceWatchDelay,
  applyWorkspaceFileChangeToRoute,
  workspaceFilesProjectOptions,
  workspaceSessions
} from "./WorkspaceFilesRoute.js";

describe("workspaceSessions", () => {
  const session = (id: string, overrides: Partial<SessionView> = {}): SessionView => ({
    id,
    backendId: "backend-a",
    targetId: "target-a",
    name: id,
    state: "idle",
    pinned: false,
    archived: false,
    fastMode: false,
    permissionMode: "ask",
    planMode: false,
    updatedAt: 1,
    ...overrides,
    generation: overrides.generation ?? 0n
  });

  it("keeps only active sessions from the exact workspace and uses pinned/status ordering", () => {
    const result = workspaceSessions([
      session("idle-new", { updatedAt: 30 }),
      session("running", { state: "running", updatedAt: 10 }),
      session("pinned-idle", { pinned: true, updatedAt: 2 }),
      session("pinned-running", { pinned: true, state: "running", updatedAt: 1 }),
      session("archived", { archived: true }),
      session("closed", { state: "closed" }),
      session("other-workspace", { targetId: "target-b" })
    ], "workspace-a", [
      { id: "target-a", workspaceId: "workspace-a" },
      { id: "target-b", workspaceId: "workspace-b" }
    ]);
    expect(result.map((value) => value.id)).toEqual([
      "pinned-running",
      "pinned-idle",
      "running",
      "idle-new"
    ]);
  });
});

describe("workspaceFilesProjectOptions", () => {
  const backend = (id: string, files: boolean): BackendView => ({
    id,
    name: id,
    version: "1",
    health: "healthy",
    capabilities: new Map([["workspace.files", { name: "workspace.files", supported: files, options: [] }]])
  });
  const target = (id: string, backendId: string): TargetView => ({
    id,
    backendId,
    name: `Project ${id}`,
    workspaceId: `workspace-${id}`,
    workspaceName: `Workspace ${id}`,
    trusted: true,
    pinned: false,
    archived: false
  });
  const workspace = (targetId: string): WorkspaceView => ({
    id: `workspace-${targetId}`,
    targetId,
    name: `Workspace ${targetId}`,
    kind: "userProject",
    serverPath: `/projects/${targetId}`,
    trusted: true,
    dirty: false,
    entries: []
  });
  const session = (id: string, targetId: string, backendId: string, updatedAt: number, overrides: Partial<SessionView> = {}): SessionView => ({
    id,
    targetId,
    backendId,
    name: id,
    state: "idle",
    archived: false,
    pinned: false,
    fastMode: false,
    permissionMode: "ask",
    planMode: false,
    updatedAt,
    ...overrides,
    generation: overrides.generation ?? 0n
  });

  it("groups target/workspace/session snapshots, gates capability, and chooses latest active task", () => {
    const projects = workspaceFilesProjectOptions({
      backends: [backend("files", true), backend("no-files", false)],
      targets: [target("a", "files"), target("b", "no-files")],
      workspaces: [workspace("a"), workspace("b")],
      sessions: [
        session("older", "a", "files", 10),
        session("latest", "a", "files", 30),
        session("archived", "a", "files", 50, { archived: true }),
        session("closed", "a", "files", 40, { state: "closed" }),
        session("unsupported", "b", "no-files", 60)
      ]
    });
    expect(projects).toEqual([{
      targetId: "a",
      workspaceId: "workspace-a",
      sessionId: "latest",
      displayName: "Project a",
      activeSessionCount: 2
    }]);
  });
});

describe("workspace file watcher route invalidation", () => {
  const change = (overrides: Partial<WorkspaceFileChangeView>): WorkspaceFileChangeView => ({
    workspaceId: "workspace-watch-route",
    kind: "modified",
    path: "src/current.ts",
    sequence: 1n,
    streamRevision: "stream-1",
    observedAt: 1,
    ...overrides
  });

  it("refreshes a selected modification so a dirty editor can surface its revision conflict", () => {
    const refreshPreview = vi.fn();
    const navigateFile = vi.fn();
    applyWorkspaceFileChangeToRoute({
      change: change({}),
      workspaceId: "workspace-watch-route",
      selectedPath: "src/current.ts",
      isSelectedDirty: () => true,
      refreshPreview,
      navigateFile
    });
    expect(refreshPreview).toHaveBeenCalledOnce();
    expect(navigateFile).not.toHaveBeenCalled();
  });

  it("rewrites a clean renamed selection but preserves a dirty source identity", () => {
    const cleanWorkspace = "workspace-watch-rename-clean";
    workspaceOpenTabsStore.addTab(cleanWorkspace, "src/old.ts");
    const cleanNavigate = vi.fn();
    applyWorkspaceFileChangeToRoute({
      change: change({ workspaceId: cleanWorkspace, kind: "renamed", path: "src/new.ts", previousPath: "src/old.ts" }),
      workspaceId: cleanWorkspace,
      selectedPath: "src/old.ts",
      isSelectedDirty: () => false,
      refreshPreview: vi.fn(),
      navigateFile: cleanNavigate
    });
    expect(workspaceOpenTabsStore.getTabs(cleanWorkspace)).toEqual(["src/new.ts"]);
    expect(cleanNavigate).toHaveBeenCalledWith("src/new.ts");

    const dirtyWorkspace = "workspace-watch-rename-dirty";
    workspaceOpenTabsStore.addTab(dirtyWorkspace, "src/old.ts");
    const dirtyNavigate = vi.fn();
    applyWorkspaceFileChangeToRoute({
      change: change({ workspaceId: dirtyWorkspace, kind: "renamed", path: "src/new.ts", previousPath: "src/old.ts" }),
      workspaceId: dirtyWorkspace,
      selectedPath: "src/old.ts",
      isSelectedDirty: () => true,
      refreshPreview: vi.fn(),
      navigateFile: dirtyNavigate
    });
    expect(workspaceOpenTabsStore.getTabs(dirtyWorkspace)).toEqual(["src/old.ts"]);
    expect(dirtyNavigate).not.toHaveBeenCalled();

    workspaceOpenTabsStore.closeTabs(cleanWorkspace, ["src/new.ts"]);
    workspaceOpenTabsStore.closeTabs(dirtyWorkspace, ["src/old.ts"]);
  });

  it("closes deleted descendants and chooses a successor without dropping a dirty selected draft", () => {
    const cleanWorkspace = "workspace-watch-delete-clean";
    for (const path of ["left.ts", "src/a.ts", "src/b.ts", "right.ts"]) workspaceOpenTabsStore.addTab(cleanWorkspace, path);
    const cleanNavigate = vi.fn();
    applyWorkspaceFileChangeToRoute({
      change: change({ workspaceId: cleanWorkspace, kind: "deleted", path: "src" }),
      workspaceId: cleanWorkspace,
      selectedPath: "src/a.ts",
      isSelectedDirty: () => false,
      refreshPreview: vi.fn(),
      navigateFile: cleanNavigate
    });
    expect(workspaceOpenTabsStore.getTabs(cleanWorkspace)).toEqual(["left.ts", "right.ts"]);
    expect(cleanNavigate).toHaveBeenCalledWith("right.ts");

    const dirtyWorkspace = "workspace-watch-delete-dirty";
    for (const path of ["src/a.ts", "src/b.ts", "right.ts"]) workspaceOpenTabsStore.addTab(dirtyWorkspace, path);
    const dirtyNavigate = vi.fn();
    applyWorkspaceFileChangeToRoute({
      change: change({ workspaceId: dirtyWorkspace, kind: "deleted", path: "src" }),
      workspaceId: dirtyWorkspace,
      selectedPath: "src/a.ts",
      isSelectedDirty: () => true,
      refreshPreview: vi.fn(),
      navigateFile: dirtyNavigate
    });
    expect(workspaceOpenTabsStore.getTabs(dirtyWorkspace)).toEqual(["src/a.ts", "right.ts"]);
    expect(dirtyNavigate).not.toHaveBeenCalled();

    workspaceOpenTabsStore.closeTabs(cleanWorkspace, ["left.ts", "right.ts"]);
    workspaceOpenTabsStore.closeTabs(dirtyWorkspace, ["src/a.ts", "right.ts"]);
  });

  it("removes retry abort listeners after both timer completion and cancellation", async () => {
    vi.useFakeTimers();
    try {
      const elapsed = new AbortController();
      const elapsedRemove = vi.spyOn(elapsed.signal, "removeEventListener");
      const elapsedWait = abortableWorkspaceWatchDelay(250, elapsed.signal);
      await vi.advanceTimersByTimeAsync(250);
      await elapsedWait;
      expect(elapsedRemove).toHaveBeenCalledWith("abort", expect.any(Function));

      const cancelled = new AbortController();
      const cancelledRemove = vi.spyOn(cancelled.signal, "removeEventListener");
      const cancelledWait = abortableWorkspaceWatchDelay(250, cancelled.signal);
      cancelled.abort();
      await cancelledWait;
      expect(cancelledRemove).toHaveBeenCalledWith("abort", expect.any(Function));
    } finally {
      vi.useRealTimers();
    }
  });
});
