import { create } from "@bufbuild/protobuf";
import { Code, type HandlerContext } from "@connectrpc/connect";
import * as contract from "@joko/contracts";
import { OperationalStore } from "@joko/store";
import type { WorktreeBranchStatus, WorktreeBranchSyncResult } from "@joko/worktree";
import type { TargetDescriptor } from "@joko/core";
import { afterEach, expect, it, vi } from "vitest";
import type { SessionWorktreeCoordinator } from "./session-worktree-coordinator.js";
import { createWorktreeBranchSyncService } from "./worktree-branch-sync-service.js";

const stores: OperationalStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function fixture() {
  const store = new OperationalStore(":memory:"); stores.push(store);
  store.upsertBackend({ id: "backend", displayName: "Backend", version: "test", health: "healthy", adapterKind: "fixture", instanceGeneration: 0,
    installationState: "installed", authenticationState: "authenticated", capabilities: new Map(), models: [], tools: [], diagnostics: [] });
  const target = { id: "target", backendId: "backend", displayName: "Repository", workspaceRoot: process.cwd(), trusted: true, managed: false };
  store.upsertTarget(target); store.upsertTarget({ ...target, id: "second" });
  const owner = store.createConnection({ id: "connection", name: "Owner", authKeyDigest: "digest" });
  const other = store.createConnection({ id: "other", name: "Other", authKeyDigest: "other-digest" });
  const status: WorktreeBranchStatus = { branch: "main", remoteOnly: false, remote: "origin", remoteBranch: "main", ahead: 0, behind: 1, dirtyFiles: 0, revision: "a".repeat(64) };
  let settle!: (result: WorktreeBranchSyncResult) => void;
  const gate = new Promise<WorktreeBranchSyncResult>(resolve => { settle = resolve; });
  const branchStatus = vi.fn(async () => ({ ...status }));
  const syncBranch = vi.fn(async (_target: TargetDescriptor, _ref: string, _revision: string, assertCurrent: () => void) => { const result = await gate; assertCurrent(); return result; });
  const coordinator = { branchStatus, syncBranch } as unknown as SessionWorktreeCoordinator;
  const context = (foreign = false) => ({ signal: new AbortController().signal, foreign }) as unknown as HandlerContext;
  const api = () => createWorktreeBranchSyncService(coordinator, store, ctx => {
    const connection = (ctx as unknown as { foreign?: boolean }).foreign ? other : owner;
    return { connectionId: connection.id, authKeyDigest: connection.authKeyDigest };
  });
  return { store, target, owner, other, status, branchStatus, syncBranch, settle, api, context };
}
async function request(f: ReturnType<typeof fixture>, api: ReturnType<ReturnType<typeof fixture>["api"]>, operationId = "branch-operation-one") {
  const value = await api.getTargetWorktreeBranchStatus(create(contract.GetTargetWorktreeBranchStatusRequestSchema,
    { targetId: "target", sourceRef: "refs/heads/main" }), f.context());
  return create(contract.SyncTargetWorktreeBranchRequestSchema, { targetId: "target", sourceRef: "refs/heads/main", operationId, expectedRevision: value.status!.revision });
}
it("journals admission, permits observation after request disconnect, and replays the exact owner receipt once", async () => {
  const f = fixture(), api = f.api(), input = await request(f, api), abort = new AbortController();
  expect((await api.syncTargetWorktreeBranch(input, { signal: abort.signal } as HandlerContext)).operation).toMatchObject({ pending: true, operationId: input.operationId });
  abort.abort();
  expect((await api.syncTargetWorktreeBranch(input, f.context())).operation?.pending).toBe(true);
  await expect(api.syncTargetWorktreeBranch(create(contract.SyncTargetWorktreeBranchRequestSchema, { ...input, sourceRef: "refs/heads/other" }), f.context()))
    .rejects.toMatchObject({ code: Code.AlreadyExists });
  await expect(api.getWorktreeBranchSyncOperation(create(contract.GetWorktreeBranchSyncOperationRequestSchema, { operationId: input.operationId }), f.context(true)))
    .rejects.toMatchObject({ code: Code.NotFound });
  f.settle({ status: { ...f.status, behind: 0, revision: "b".repeat(64) }, updated: 1 });
  await vi.waitFor(() => expect(f.store.getOperation(`worktree-branch:${input.operationId}`).status).toBe("completed"));
  const result = await api.getWorktreeBranchSyncOperation(create(contract.GetWorktreeBranchSyncOperationRequestSchema, { operationId: input.operationId }), f.context());
  expect(result.operation).toMatchObject({ operationId: input.operationId, pending: false, unknown: false, updated: 1, status: { behind: 0 } });
  expect(f.store.getOperation(`worktree-branch:${input.operationId}`)).toMatchObject({ connectionId: f.owner.id, completionMode: "external_effect" });
  expect((await f.api().syncTargetWorktreeBranch(input, f.context())).operation).toEqual(result.operation);
  expect(f.syncBranch).toHaveBeenCalledOnce();
  expect(JSON.stringify(result)).not.toContain(process.cwd()); expect(JSON.stringify(result)).not.toContain(f.owner.authKeyDigest);
});
it("binds the observed repository Target and retains unknown effects through service recreation", async () => {
  const f = fixture(), api = f.api(), input = await request(f, api);
  await expect(api.syncTargetWorktreeBranch(create(contract.SyncTargetWorktreeBranchRequestSchema, { ...input, targetId: "second" }), f.context()))
    .rejects.toMatchObject({ code: Code.Aborted });
  expect(f.syncBranch).not.toHaveBeenCalled();
  await api.syncTargetWorktreeBranch(input, f.context());
  storeChange(f.store, f.target);
  f.settle({ status: { ...f.status, behind: 0 }, updated: 1 });
  await vi.waitFor(async () => expect((await api.getWorktreeBranchSyncOperation(create(contract.GetWorktreeBranchSyncOperationRequestSchema,
    { operationId: input.operationId }), f.context())).operation?.unknown).toBe(true));
  const restored = f.api();
  expect((await restored.syncTargetWorktreeBranch(input, f.context())).operation).toMatchObject({ unknown: true, pending: false, errorCode: "outcome_unknown" });
  expect(f.store.getOperation(`worktree-branch:${input.operationId}`).status).toBe("started"); expect(f.syncBranch).toHaveBeenCalledOnce();
});
it("rejects stale status before admission and prevents concurrent identical requests from repeating the effect", async () => {
  const f = fixture(), api = f.api(), input = await request(f, api);
  f.branchStatus.mockResolvedValue({ ...f.status, revision: "c".repeat(64) });
  await expect(api.syncTargetWorktreeBranch(input, f.context())).rejects.toMatchObject({ code: Code.Aborted });
  expect(f.store.findOperation(`worktree-branch:${input.operationId}`)).toBeUndefined();
  const fresh = await request(f, api);
  const values = await Promise.all([api.syncTargetWorktreeBranch(fresh, f.context()), api.syncTargetWorktreeBranch(fresh, f.context())]);
  expect(values.every(value => value.operation?.pending)).toBe(true); expect(f.syncBranch).toHaveBeenCalledOnce();
  f.settle({ status: f.status, updated: 0 });
  await vi.waitFor(() => expect(f.store.getOperation(`worktree-branch:${input.operationId}`).status).toBe("completed"));
});
function storeChange(store: OperationalStore, target: Parameters<OperationalStore["upsertTarget"]>[0]) {
  store.upsertTarget({ ...target, trusted: false });
}
it("rechecks the original connection after admission and keeps revoked completion unconfirmed", async () => {
  const f = fixture(), api = f.api(), input = await request(f, api);
  await api.syncTargetWorktreeBranch(input, f.context());
  f.store.revokeConnection(f.owner.id);
  f.settle({ status: f.status, updated: 1 });
  await vi.waitFor(() => expect(f.syncBranch).toHaveBeenCalledOnce());
  await expect(api.getWorktreeBranchSyncOperation(create(contract.GetWorktreeBranchSyncOperationRequestSchema,
    { operationId: input.operationId }), f.context())).rejects.toBeDefined();
  expect(f.store.getOperation(`worktree-branch:${input.operationId}`).status).toBe("started");
});
