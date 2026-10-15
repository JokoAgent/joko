import type { SessionWorktreeBinding } from "@joko/core";
import { OperationalStore } from "@joko/store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorktreeRecycleSafetyCheck } from "./worktree-recycle-safety.js";

const stores: OperationalStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

describe("native worktree recycle safety", () => {
  it("requires durable native retirement and rechecks the exact owner after terminal cleanup", async () => {
    const { store, binding } = fixture();
    let active = false;
    const closeSession = vi.fn(async () => {});
    const check = createWorktreeRecycleSafetyCheck({ store, sessionHost: { isSessionActive: () => active }, terminals: { closeSession } });
    expect(await check("task", binding)).toBe(false);
    expect(closeSession).not.toHaveBeenCalled();
    store.prepareSessionLifecycleCleanup({ operationId: "cleanup", sessionId: "task", disposition: "delete", releaseWorktree: true, deleteNativeSession: true, at: 20 });
    store.advanceSessionLifecycleCleanup({ operationId: "cleanup", phase: "close", at: 21 });
    expect(await check("task", binding)).toBe(false);
    store.advanceSessionLifecycleCleanup({ operationId: "cleanup", phase: "native", at: 22 });
    active = true; expect(await check("task", binding)).toBe(false);
    active = false; expect(await check("task", binding)).toBe(true);
    closeSession.mockImplementationOnce(async () => { active = true; });
    expect(await check("task", binding)).toBe(false);
    active = false;
    expect(await check("task", { ...binding, leaseId: "replacement" })).toBe(false);
  });

  it("recovers retained checkouts using completed receipts and cannot reuse them for a restored task", async () => {
    const { store, binding } = fixture();
    store.prepareSessionLifecycleCleanup({ operationId: "cleanup", sessionId: "task", disposition: "delete", releaseWorktree: true, deleteNativeSession: true, at: 20 });
    for (const phase of ["close", "native", "worktree", "git_safety"] as const) store.advanceSessionLifecycleCleanup({ operationId: "cleanup", phase, at: 21 });
    store.finalizeSessionLifecycleCleanup({ operationId: "cleanup", at: 22 });
    const check = createWorktreeRecycleSafetyCheck({ store, sessionHost: { isSessionActive: () => false }, terminals: { closeSession: async () => {} } });
    expect(store.findPendingSessionLifecycleCleanup("task")).toBeUndefined();
    expect(await check("task", binding)).toBe(true);
    const session = store.getSession("task");
    store.updateSession("task", { title: "Changed since retirement" }, session.revision, 23);
    expect(await check("task", binding)).toBe(true);
    const archived = fixture();
    archived.store.prepareSessionLifecycleCleanup({ operationId: "archive", sessionId: "task", disposition: "archive", releaseWorktree: true, at: 20 });
    archived.store.advanceSessionLifecycleCleanup({ operationId: "archive", phase: "close", at: 21 });
    archived.store.advanceSessionLifecycleCleanup({ operationId: "archive", phase: "worktree", at: 21 });
    archived.store.finalizeSessionLifecycleCleanup({ operationId: "archive", at: 22 });
    const archivedCheck = createWorktreeRecycleSafetyCheck({ store: archived.store, sessionHost: { isSessionActive: () => false }, terminals: { closeSession: async () => {} } });
    expect(await archivedCheck("task", archived.binding)).toBe(true);
    const latest = archived.store.getSession("task");
    archived.store.updateSession("task", { archived: false }, latest.revision, 23);
    expect(await archivedCheck("task", archived.binding)).toBe(false);
  });
});

function fixture() {
  const store = new OperationalStore(":memory:"); stores.push(store);
  store.upsertBackend({ id: "backend", adapterKind: "fixture", displayName: "Local", version: "1", instanceGeneration: 0,
    health: "healthy", installationState: "installed", authenticationState: "not_required", capabilities: new Map(), models: [], tools: [], diagnostics: [] });
  store.upsertTarget({ id: "target", backendId: "backend", displayName: "Project", workspaceRoot: "D:/project", managed: false, trusted: true });
  const binding: SessionWorktreeBinding = { leaseId: "lease", workspaceId: "workspace", path: "D:/managed/tree", repositoryRoot: "D:/project", branch: "joko/task", sourceRef: "main", sourceCommit: "a".repeat(40), sourceStrategy: "explicit", sourceRefreshed: false, acquiredAt: 10, updatedAt: 10, state: "active" };
  store.createSession({ id: "task", backendId: "backend", targetId: "target", title: "Task", binding: { opaqueRef: "native/task", generation: 0 },
    worktree: binding, pinned: false, archived: false, permissionMode: "ask", planMode: false, fastMode: false, createdAt: 10, updatedAt: 10 });
  return { store, binding };
}
