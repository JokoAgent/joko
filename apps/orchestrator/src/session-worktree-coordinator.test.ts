import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "./test-paths.js";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type {
  AdapterContext,
  NativeSessionBinding,
  NativeSessionDerivation,
  NativeSessionState,
  PromptInput,
  SessionDescriptor
} from "@joko/core";
import { OperationalStore } from "@joko/store";
import { acquireWorktreeSourceUse, EphemeralWorktreeService } from "@joko/worktree";
import type { RemoteGitCheckoutLease, RemoteGitCheckoutPlan } from "@joko/remote-ssh";
import { FakeBackendAdapter, PI_LIKE_PROFILE } from "@joko/testkit";
import { afterEach, describe, expect, test, vi } from "vitest";

import { OperationalArtifactRepository } from "./artifact-repository.js";
import { ArtifactStore } from "./artifact-store.js";
import { remoteBindingFromLease } from "./remote-claude-worktree-owner.js";
import { ReviewCoordinator } from "./review-coordinator.js";
import { DurableReviewEvidenceProvider } from "./review-evidence-provider.js";
import { SessionHost } from "./session-host.js";
import { SessionWorktreeCoordinator } from "./session-worktree-coordinator.js";
import type { WorkspaceChangeSetService } from "./workspace-change-set.js";
import { WorkspaceService, type RemoteWorkspaceDelegate, type WorkspaceRegistration } from "./workspace-service.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("SessionWorktreeCoordinator lifecycle", () => {
  test("reviews a source task's actual checkout and retains its original worktree ownership", { timeout: 40_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-review-worktree-"));
    const repositoryRoot = await createRepository(join(root, "project"));
    const store = new OperationalStore(join(root, "store.db"));
    const artifacts = new ArtifactStore({ rootDirectory: join(root, "artifacts"), repository: new OperationalArtifactRepository(store), ingestRoots: [root] });
    const workspaces = new WorkspaceService();
    const worktrees = new SessionWorktreeCoordinator({ store, workspaces, storageRoot: join(root, "isolated") });
    const adapter = new TargetCaptureAdapter();
    const host = new SessionHost(store, artifacts, [adapter], { worktrees });
    cleanups.push(async () => {
      await host.dispose().catch(() => undefined);
      worktrees.dispose();
      await workspaces.close();
      store.close();
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    });
    await artifacts.initialize();
    await worktrees.initialize();
    await host.initialize();
    await host.registerTarget({ id: "target", backendId: adapter.id, displayName: "Project", workspaceRoot: repositoryRoot, managed: false, trusted: true });
    await workspaces.register({ id: "target", root: repositoryRoot, displayName: "Project", trusted: true });
    const connection = store.createConnection({ id: "owner", name: "Owner", authKeyDigest: "digest" });
    const createNative = vi.spyOn(adapter, "createSession"), closeNative = vi.spyOn(adapter, "closeSession");
    const sourceSessionId = (await host.createSession({ operationId: "create-review-worktree-source", connection, targetId: "target", title: "Checkout task",
      fastMode: false, permissionMode: "ask", planMode: false, worktree: { sourceRef: "refs/heads/main", refreshRemote: false } })).value.sessionId;
    const checkout = store.getSession(sourceSessionId).descriptor.worktree!;
    await writeFile(join(repositoryRoot, "tracked.txt"), "Parent-only change\n");
    await writeFile(join(checkout.path, "tracked.txt"), "Checkout-only change\n");

    const evidence = new DurableReviewEvidenceProvider({ store, workspaces, artifacts,
      workspaceChanges: { listChangeSets: async () => [] } as unknown as WorkspaceChangeSetService });
    const coordinator = new ReviewCoordinator({ store, runtime: host, evidence });
    const sendNative = adapter.send.bind(adapter);
    let allowCompletion!: () => void;
    const completionGate = new Promise<void>(resolve => { allowCompletion = resolve; });
    const send = vi.spyOn(adapter, "send").mockImplementation(async (input, context) => {
      await completionGate;
      await sendNative(input, context);
    });
    const started = coordinator.start({ operationId: "review-worktree-source", connection, request: { sourceSessionId, attachments: [] } });
    void started.catch(() => undefined);
    try {
      await vi.waitFor(() => expect(send).toHaveBeenCalledOnce(), { timeout: 15_000 });
      const [prompt, context] = send.mock.calls[0]!;
      expect(prompt.text).toContain("+Checkout-only change\n");
      expect(prompt.text).not.toContain("Parent-only change");
      expect(context).toMatchObject({ target: { workspaceRoot: checkout.path }, runtimePolicy: "review_read_only" });
      expect(createNative).toHaveBeenLastCalledWith(expect.objectContaining({ target: expect.objectContaining({ workspaceRoot: checkout.path }) }),
        expect.objectContaining({ target: expect.objectContaining({ workspaceRoot: checkout.path }) }));
      await expect(worktrees.archive(sourceSessionId)).rejects.toMatchObject({ code: "SESSION_CONFLICT" });
    } finally {
      allowCompletion();
    }
    const result = await started;
    await coordinator.waitForFinalizations();
    expect(store.getReviewRun(result.reviewRunId)).toMatchObject({ state: "completed", freshness: "current" });
    expect(store.getSession(result.reviewerSessionId!).descriptor.worktree).toBeUndefined();
    expect(adapter.observedTrackedContents).toEqual(["Checkout-only change\n"]);
    expect(closeNative).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sessionId: result.reviewerSessionId,
      target: expect.objectContaining({ workspaceRoot: checkout.path }) }));
    expect(store.getSession(sourceSessionId).descriptor.worktree).toEqual(checkout);
  });

  test("adopts a removed checkout when the original archive resumes after restart", { timeout: 40_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-worktree-archive-restart-"));
    const repositoryRoot = await createRepository(join(root, "project"));
    const databasePath = join(root, "store.db");
    let store = new OperationalStore(databasePath);
    let workspaces = new WorkspaceService();
    const storageRoot = join(root, "worktrees");
    const service = new EphemeralWorktreeService({ storageRoot, recycle: true });
    let worktrees = new SessionWorktreeCoordinator({ store, workspaces, storageRoot, service });
    cleanups.push(async () => {
      worktrees.dispose(); await workspaces.close(); store.close();
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    });
    store.upsertBackend({ id: "archive-restart-backend", adapterKind: "fixture", displayName: "Local", version: "1",
      instanceGeneration: 0, health: "healthy", installationState: "installed", authenticationState: "not_required",
      capabilities: new Map(), models: [], tools: [], diagnostics: [] });
    const target = store.upsertTarget({ id: "archive-restart-target", backendId: "archive-restart-backend", displayName: "Project",
      workspaceRoot: repositoryRoot, managed: false, trusted: true }).descriptor;
    await worktrees.initialize();
    const sessionId = "archive-restart-task";
    const binding = await worktrees.acquire({ sessionId, target });
    store.createSession({ id: sessionId, backendId: target.backendId, targetId: target.id, title: "Archive after restart",
      binding: { opaqueRef: "native/archive-restart", generation: 0 }, worktree: binding,
      pinned: false, archived: false, permissionMode: "ask", planMode: false, fastMode: false, createdAt: 1, updatedAt: 1 });
    await writeFile(join(binding.path, "tracked.txt"), "Archived bytes survive restart\n", "utf8");
    await git(binding.path, ["add", "tracked.txt"]);
    const operationId = "archive-restart-lifecycle";
    store.prepareSessionLifecycleCleanup({ operationId, sessionId, disposition: "archive", releaseWorktree: true });
    store.advanceSessionLifecycleCleanup({ operationId, phase: "close" });

    expect(await service.release(sessionId, { retainForRestore: true })).toMatchObject({
      ok: true, value: { status: "preserved", reason: "restorable", pathRemoved: true }
    });
    expect(service.listRecycleStatus()).toEqual([]);
    expect(store.getSession(sessionId).descriptor).toMatchObject({ archived: false, worktree: { state: "active" } });
    expect(store.getSessionLifecycleCleanup(operationId)).toMatchObject({ closeCompleted: true, worktreeCompleted: false });
    await expect(lstat(binding.path)).rejects.toMatchObject({ code: "ENOENT" });
    worktrees.dispose();
    await workspaces.close();
    store.close();
    store = new OperationalStore(databasePath);
    workspaces = new WorkspaceService();
    worktrees = new SessionWorktreeCoordinator({ store, workspaces, storageRoot });

    await worktrees.initialize();
    await expect(lstat(binding.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(workspaces.listRegistrations().some(entry => entry.id === binding.workspaceId)).toBe(false);
    await worktrees.archive(sessionId);
    store.advanceSessionLifecycleCleanup({ operationId, phase: "worktree" });
    store.finalizeSessionLifecycleCleanup({ operationId });
    expect(store.getSession(sessionId).descriptor).toMatchObject({ archived: true, worktree: { state: "preserved", leaseId: binding.leaseId } });
    await expect(lstat(binding.path)).rejects.toMatchObject({ code: "ENOENT" });

    await worktrees.restore(sessionId);
    expect((await readFile(join(binding.path, "tracked.txt"), "utf8")).replaceAll("\r\n", "\n"))
      .toBe("Archived bytes survive restart\n");
    expect((await git(binding.path, ["diff", "--cached", "--name-only"])).trim()).toBe("tracked.txt");
  });

  test.each(["archive", "delete"] as const)("retries only the exact %s lifecycle after native and source writers retire", { timeout: 40_000 }, async disposition => {
    const root = await mkdtemp(join(tmpdir(), "joko-worktree-recycle-"));
    const repositoryRoot = await createRepository(join(root, "project"));
    const store = new OperationalStore(join(root, "store.db"));
    store.upsertBackend({ id: "local-backend", adapterKind: "fixture", displayName: "Local", version: "1",
      instanceGeneration: 0, health: "healthy", installationState: "installed", authenticationState: "not_required",
      capabilities: new Map(), models: [], tools: [], diagnostics: [] });
    const target = store.upsertTarget({ id: "local-target", backendId: "local-backend", displayName: "Project",
      workspaceRoot: repositoryRoot, managed: false, trusted: true }).descriptor;
    const workspaces = new WorkspaceService();
    const storageRoot = join(root, "worktrees");
    const worktrees = new SessionWorktreeCoordinator({ store, workspaces, storageRoot });
    cleanups.push(async () => {
      worktrees.dispose(); await workspaces.close(); store.close();
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    });
    await worktrees.initialize();
    const binding = await worktrees.acquire({ sessionId: "recycle-task", target });
    store.createSession({ id: "recycle-task", backendId: target.backendId, targetId: target.id, title: "Retained task",
      binding: { opaqueRef: "native/recycle-task", generation: 0 }, worktree: binding,
      pinned: false, archived: false, permissionMode: "ask", planMode: false, fastMode: false, createdAt: 1, updatedAt: 1 });
    store.prepareSessionLifecycleCleanup({ operationId: "recycle-lifecycle", sessionId: "recycle-task", disposition, releaseWorktree: true });
    const source = await acquireWorktreeSourceUse(binding.path, "build-owner", new AbortController());
    if (disposition === "archive") await expect(worktrees.archive("recycle-task")).rejects.toMatchObject({ code: "SESSION_CONFLICT" });
    else await worktrees.release("recycle-task");
    const pending = worktrees.listRecycleStatus()[0]!;
    expect(pending).toMatchObject({ sessionId: "recycle-task", displayName: "Retained task", state: "waiting", reason: "in_use", failures: 0 });
    const canRecycle = vi.fn(async () => false);
    await worktrees.startRecycleMaintenance(canRecycle);
    expect(canRecycle).not.toHaveBeenCalled();
    store.advanceSessionLifecycleCleanup({ operationId: "recycle-lifecycle", phase: "close" });
    await worktrees.startRecycleMaintenance(canRecycle);
    expect(canRecycle).toHaveBeenCalled();
    expect(worktrees.listRecycleStatus()[0]).toMatchObject({ state: "waiting", failures: 0 });
    const borrowerTarget = store.upsertTarget({ ...target, id: "borrower-target", workspaceRoot: binding.path }).descriptor;
    store.createSession({ id: "borrower-task", backendId: target.backendId, targetId: borrowerTarget.id, title: "Live borrower",
      binding: { opaqueRef: "native/borrower-task", generation: 0 }, pinned: false, archived: false,
      permissionMode: "ask", planMode: false, fastMode: false, createdAt: 1, updatedAt: 1 });
    canRecycle.mockResolvedValue(true);
    const checksBeforeReference = canRecycle.mock.calls.length;
    await worktrees.startRecycleMaintenance(canRecycle);
    expect(canRecycle).toHaveBeenCalledTimes(checksBeforeReference);
    expect(worktrees.listRecycleStatus()[0]).toMatchObject({ state: "waiting", failures: 0 });
    store.updateSession("borrower-task", { archived: true });
    await worktrees.controlRecycle({ id: pending.id, generation: pending.generation, action: "keep" });
    await source.release({ writerRetired: true });
    canRecycle.mockResolvedValue(true);
    await worktrees.startRecycleMaintenance(canRecycle);
    expect(worktrees.listRecycleStatus()[0]).toMatchObject({ state: "kept", failures: 0 });
    await expect(lstat(binding.path)).resolves.toBeDefined();
    await worktrees.controlRecycle({ id: pending.id, generation: pending.generation, action: "retry" });
    expect(worktrees.listRecycleStatus()).toEqual([]);
    await expect(lstat(binding.path)).rejects.toMatchObject({ code: "ENOENT" });
    if (disposition === "archive") expect(store.getSession("recycle-task").descriptor.worktree?.state).toBe("preserved");
    else await expect(worktrees.release("recycle-task")).resolves.toBeUndefined();
    expect(store.getSessionLifecycleCleanup("recycle-lifecycle").worktreeCompleted).toBe(false);
    await expect(worktrees.controlRecycle({ id: pending.id, generation: pending.generation, action: "keep" }))
      .rejects.toMatchObject({ code: "SOURCE_NOT_FOUND" });
  });

  test("retains a deleted portable source until native cleanup and replays its exact worktree release", { timeout: 30_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-portable-worktree-cleanup-"));
    const repositoryRoot = await createRepository(join(root, "project"));
    const store = new OperationalStore(join(root, "store.db"));
    const artifacts = new ArtifactStore({
      rootDirectory: join(root, "artifacts"),
      repository: new OperationalArtifactRepository(store),
      ingestRoots: [root]
    });
    await artifacts.initialize();
    const workspaces = new WorkspaceService();
    const storageRoot = join(root, "isolated");
    const originalWorktrees = new SessionWorktreeCoordinator({ store, workspaces, storageRoot });
    const adapter = new TargetCaptureAdapter();
    const host = new SessionHost(store, artifacts, [adapter], { worktrees: originalWorktrees });
    await originalWorktrees.initialize();
    await host.initialize();
    await host.registerTarget({
      id: "target-one", backendId: adapter.id, displayName: "Project",
      workspaceRoot: repositoryRoot, managed: false, trusted: true
    });
    const connection = store.createConnection({ id: "connection-one", name: "Test device", authKeyDigest: "digest" });
    cleanups.push(async () => {
      await host.dispose().catch(() => undefined);
      originalWorktrees.dispose();
      await workspaces.close().catch(() => undefined);
      store.close();
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    });
    const oldSessionId = (await host.createSession({
      operationId: "create-portable-old-worktree", connection, targetId: "target-one",
      title: "Old task", fastMode: false, permissionMode: "ask", planMode: false,
      worktree: { sourceRef: "refs/heads/main", refreshRemote: false }
    })).value.sessionId;
    await host.close(oldSessionId);
    const old = store.getSession(oldSessionId);
    const oldWorktree = old.descriptor.worktree;
    if (oldWorktree === undefined) throw new Error("Expected an isolated old task.");
    const claim = store.claimAuthorizedDeferredEffectOperation(
      connection.id, connection.authKeyDigest,
      { id: "portable-worktree-replacement", kind: "import_portable_session", body: { targetId: "target-one" } }
    );
    if (!claim.claimed) throw new Error("Expected a new import operation.");
    const now = Date.now();
    store.completeAuthorizedDeferredEffectOperation(
      connection.id, connection.authKeyDigest, claim.operation.id, claim.operation.bodyHash,
      (transaction) => {
        const { worktree: _oldWorktree, ...descriptor } = old.descriptor;
        transaction.updateSession(oldSessionId, { archived: true, deletedAt: now }, old.revision, now);
        transaction.createSession({
          ...descriptor, id: "portable-new-session", title: "New task",
          binding: { opaqueRef: "native/new-portable-session", generation: 1 },
          archived: false, deletedAt: undefined, createdAt: now, updatedAt: now
        });
        transaction.preparePortableReplacementCleanup({
          operationId: claim.operation.id,
          importedSessionId: "portable-new-session",
          replacedSessionId: oldSessionId,
          at: now
        });
        return { sessionId: "portable-new-session" };
      }
    );
    originalWorktrees.dispose();
    const restartedWorkspaces = new WorkspaceService();
    const restartedWorktrees = new SessionWorktreeCoordinator({ store, workspaces: restartedWorkspaces, storageRoot });
    cleanups.push(async () => {
      restartedWorktrees.dispose();
      await restartedWorkspaces.close().catch(() => undefined);
    });
    await restartedWorktrees.initialize();
    expect((await lstat(oldWorktree.path)).isDirectory()).toBe(true);
    expect(store.getPortableReplacementCleanup(claim.operation.id))
      .toMatchObject({ nativeState: "pending", worktreeState: "pending" });
    store.claimPortableReplacementNativeCleanup(claim.operation.id);
    store.confirmPortableReplacementNativeCleanup(claim.operation.id);
    await host.dispose();
    const receipt = vi.spyOn(store, "confirmPortableReplacementWorktreeCleanup")
      .mockImplementationOnce(() => { throw new Error("worktree release acknowledgement was lost"); });
    const recoveryHost = new SessionHost(store, artifacts, [new TargetCaptureAdapter()], { worktrees: restartedWorktrees });
    cleanups.push(() => recoveryHost.dispose());
    await recoveryHost.initialize();
    receipt.mockRestore();
    await expect(lstat(oldWorktree.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(store.getPortableReplacementCleanup(claim.operation.id))
      .toMatchObject({ worktreeState: "pending", failureCode: "worktree_release_pending" });
    await recoveryHost.dispose();
    restartedWorktrees.dispose();
    const finalWorkspaces = new WorkspaceService();
    const finalWorktrees = new SessionWorktreeCoordinator({ store, workspaces: finalWorkspaces, storageRoot });
    cleanups.push(async () => {
      finalWorktrees.dispose();
      await finalWorkspaces.close().catch(() => undefined);
    });
    await finalWorktrees.initialize();
    const finalHost = new SessionHost(store, artifacts, [new TargetCaptureAdapter()], { worktrees: finalWorktrees });
    cleanups.push(() => finalHost.dispose());
    await finalHost.initialize();
    expect(store.listPendingPortableReplacementCleanups()).toEqual([]);
    expect(store.getSession("portable-new-session").descriptor.deletedAt).toBeUndefined();
  });

  test("archives, restores, and dispatches the next prompt from the same isolated checkout", { timeout: 30_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-session-worktree-"));
    const repositoryRoot = await createRepository(join(root, "project"));
    const store = new OperationalStore(join(root, "store.db"));
    const artifactRepository = new OperationalArtifactRepository(store);
    const artifacts = new ArtifactStore({
      rootDirectory: join(root, "artifacts"),
      repository: artifactRepository,
      ingestRoots: [root]
    });
    await artifacts.initialize();
    const workspaces = new WorkspaceService();
    const worktrees = new SessionWorktreeCoordinator({
      store,
      workspaces,
      storageRoot: join(root, "isolated")
    });
    const adapter = new TargetCaptureAdapter();
    const host = new SessionHost(store, artifacts, [adapter], { worktrees });
    await host.initialize();
    await worktrees.initialize();
    await host.registerTarget({
      id: "target-one",
      backendId: adapter.id,
      displayName: "Project",
      workspaceRoot: repositoryRoot,
      managed: false,
      trusted: true
    });
    const connection = store.createConnection({
      id: "connection-one",
      name: "Test device",
      authKeyDigest: "digest"
    });
    cleanups.push(async () => {
      await host.dispose().catch(() => undefined);
      worktrees.dispose();
      await workspaces.close().catch(() => undefined);
      store.close();
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    });

    const sessionId = (await host.createSession({
      operationId: "create-isolated-session",
      connection,
      targetId: "target-one",
      title: "Isolated task",
      fastMode: false,
      permissionMode: "ask",
      planMode: false,
      worktree: { sourceRef: "refs/heads/main", refreshRemote: false }
    })).value.sessionId;
    const binding = store.getSession(sessionId).descriptor.worktree;
    if (binding === undefined) throw new Error("Expected an isolated workspace binding.");
    await writeFile(join(binding.path, "tracked.txt"), "preserved across archive\n", "utf8");
    await writeFile(join(binding.path, "new-file.txt"), "new content\n", "utf8");
    expect(await worktrees.previewRemoval(sessionId)).toEqual({ hasWorktree: true, dirty: true });

    await host.close(sessionId);
    await worktrees.archive(sessionId);
    store.updateSession(sessionId, { archived: true });
    expect(await worktrees.previewRemoval(sessionId)).toEqual({ hasWorktree: true, dirty: true });
    expect(store.getSession(sessionId).descriptor.worktree?.state).toBe("preserved");
    expect(workspaces.listRegistrations().some((entry) => entry.id === binding.workspaceId)).toBe(false);

    const retired = store.createConnection({ id: "retiring-restore", name: "Retiring device", authKeyDigest: "retiring-digest" });
    let checks = 0;
    await expect(worktrees.restore(sessionId, { assertCurrent: () => {
      if (++checks === 2) store.revokeConnection(retired.id);
      store.authorizeConnection(retired.id, retired.authKeyDigest);
    } })).rejects.toMatchObject({ name: "AuthorizationError" });
    await expect(lstat(binding.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(store.getSession(sessionId).descriptor).toMatchObject({ archived: true, worktree: { state: "preserved" } });
    expect(workspaces.listRegistrations().some(entry => entry.id === binding.workspaceId)).toBe(false);

    await worktrees.restore(sessionId);
    store.updateSession(sessionId, { archived: false });
    const restored = store.getSession(sessionId);
    expect(restored.descriptor.worktree).toMatchObject({
      leaseId: binding.leaseId,
      path: binding.path,
      branch: binding.branch,
      state: "active"
    });
    expect(worktrees.effectiveTarget(restored).workspaceRoot).toBe(resolve(binding.path));
    expect(await worktrees.previewRemoval(sessionId)).toEqual({ hasWorktree: true, dirty: true });
    expect(workspaces.listRegistrations()).toContainEqual(expect.objectContaining({
      id: binding.workspaceId,
      root: resolve(binding.path)
    }));

    const dispatched = host.enqueueInput({
      operationId: "send-after-unarchive",
      connection,
      sessionId,
      prompt: { text: "continue", images: [], files: [], mentions: [], disposition: "prompt" }
    });
    await eventually(() => adapter.sendRoots.length === 1);
    await eventually(() => ["backend_accepted", "completed"].includes(
      store.getQueueItem(dispatched.value.queueItemId).state
    ));
    expect(adapter.sendRoots).toEqual([resolve(binding.path)]);
    expect(adapter.observedTrackedContents.map((content) => content.replaceAll("\r\n", "\n")))
      .toEqual(["preserved across archive\n"]);
    expect((await readFile(join(binding.path, "new-file.txt"), "utf8")).replaceAll("\r\n", "\n"))
      .toBe("new content\n");
  });

  test("isolates an ordinary primary checkout and retains unknown detached cleanup across restart", { timeout: 60_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-primary-derived-worktree-"));
    const repositoryRoot = await createRepository(join(root, "project"));
    const store = new OperationalStore(join(root, "store.db"));
    const artifactRepository = new OperationalArtifactRepository(store);
    const artifacts = new ArtifactStore({
      rootDirectory: join(root, "artifacts"),
      repository: artifactRepository,
      ingestRoots: [root]
    });
    await artifacts.initialize();
    const workspaces = new WorkspaceService();
    const worktrees = new SessionWorktreeCoordinator({
      store,
      workspaces,
      storageRoot: join(root, "isolated")
    });
    const adapter = new TargetCaptureAdapter();
    const host = new SessionHost(store, artifacts, [adapter], { worktrees });
    await worktrees.initialize();
    await host.initialize();
    await host.registerTarget({
      id: "ordinary-target",
      backendId: adapter.id,
      displayName: "Ordinary project",
      workspaceRoot: repositoryRoot,
      managed: false,
      trusted: true
    });
    const connection = store.createConnection({
      id: "ordinary-connection",
      name: "Test device",
      authKeyDigest: "ordinary-digest"
    });
    cleanups.push(async () => {
      await host.dispose().catch(() => undefined);
      worktrees.dispose();
      await workspaces.close().catch(() => undefined);
      store.close();
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    });

    const sourceId = (await host.createSession({
      operationId: "create-ordinary-derivation-source",
      connection,
      targetId: "ordinary-target",
      title: "Ordinary source task",
      fastMode: false,
      permissionMode: "ask",
      planMode: false
    })).value.sessionId;
    expect(store.getSession(sourceId).descriptor.worktree).toBeUndefined();
    await writeFile(join(repositoryRoot, "tracked.txt"), "staged ordinary state\n", "utf8");
    await git(repositoryRoot, ["add", "tracked.txt"]);
    await writeFile(join(repositoryRoot, "tracked.txt"), "final ordinary state\n", "utf8");
    await writeFile(join(repositoryRoot, "ordinary-untracked.txt"), "ordinary untracked\n", "utf8");
    const sourceHead = (await git(repositoryRoot, ["rev-parse", "HEAD"])).trim();
    const sourceStatus = await git(repositoryRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const sourceIndex = await git(repositoryRoot, ["diff", "--cached", "--binary"]);
    const sourceWorktree = await git(repositoryRoot, ["diff", "--binary"]);

    const derivedId = (await host.deriveSession({
      operationId: "clone-ordinary-source",
      connection,
      sourceSessionId: sourceId,
      title: "Ordinary derived task",
      kind: "clone"
    })).value.sessionId;
    const derived = store.getSession(derivedId).descriptor;
    if (derived.worktree === undefined) throw new Error("Expected an independently derived workspace binding.");

    expect(resolve(derived.worktree.path)).not.toBe(resolve(repositoryRoot));
    expect(derived.worktree.sourceCommit).toBe(sourceHead);
    expect(await git(derived.worktree.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]))
      .toBe(sourceStatus);
    expect(await git(derived.worktree.path, ["diff", "--cached", "--binary"])).toBe(sourceIndex);
    expect(await git(derived.worktree.path, ["diff", "--binary"])).toBe(sourceWorktree);
    expect((await git(repositoryRoot, ["rev-parse", "HEAD"])).trim()).toBe(sourceHead);
    expect(await git(repositoryRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]))
      .toBe(sourceStatus);
    expect(adapter.deriveRoots).toEqual([resolve(derived.worktree.path)]);
    expect(workspaces.listRegistrations()).toContainEqual(expect.objectContaining({
      id: derived.worktree.workspaceId,
      root: resolve(derived.worktree.path)
    }));

    await host.resume(derivedId);
    expect(adapter.resumeRoots.at(-1)).toBe(resolve(derived.worktree.path));
    const sent = host.enqueueInput({
      operationId: "send-ordinary-derived-worktree",
      connection,
      sessionId: derivedId,
      prompt: { text: "continue ordinary derived task", images: [], files: [], mentions: [], disposition: "prompt" }
    });
    await eventually(() => adapter.sendRoots.includes(resolve(derived.worktree!.path)));
    await eventually(() => ["backend_accepted", "completed"].includes(store.getQueueItem(sent.value.queueItemId).state));
    expect(adapter.observedTrackedContents.at(-1)?.replaceAll("\r\n", "\n")).toBe("final ordinary state\n");

    adapter.failAfterClone = true;
    adapter.failDelete = true;
    await expect(host.deriveSession({
      operationId: "clone-ordinary-source-unknown-cleanup",
      connection,
      sourceSessionId: sourceId,
      title: "Unknown cleanup task",
      kind: "clone"
    })).rejects.toThrow();
    const unknown = store.findNativeSessionDerivation("clone-ordinary-source-unknown-cleanup");
    expect(unknown).toMatchObject({ state: "cleanup_unknown" });
    expect(worktrees.activeWorkspacePath(unknown!.sessionId, unknown!.worktree!))
      .toBe(resolve(unknown!.effectiveWorkspaceRoot));
    expect(adapter.deleteRoots.at(-1)).toBe(resolve(unknown!.effectiveWorkspaceRoot));

    await host.dispose();
    worktrees.dispose();
    await workspaces.close();

    const restartedWorkspaces = new WorkspaceService();
    const restartedWorktrees = new SessionWorktreeCoordinator({
      store,
      workspaces: restartedWorkspaces,
      storageRoot: join(root, "isolated")
    });
    const restartedAdapter = new TargetCaptureAdapter();
    const restartedHost = new SessionHost(store, artifacts, [restartedAdapter], { worktrees: restartedWorktrees });
    cleanups.push(async () => {
      await restartedHost.dispose().catch(() => undefined);
      restartedWorktrees.dispose();
      await restartedWorkspaces.close().catch(() => undefined);
    });
    await restartedWorktrees.initialize();
    expect(restartedWorktrees.activeWorkspacePath(unknown!.sessionId, unknown!.worktree!))
      .toBe(resolve(unknown!.effectiveWorkspaceRoot));
    await restartedHost.initialize();
    expect(store.findNativeSessionDerivation(unknown!.operationId)?.state).toBe("cleanup_unknown");
    expect(restartedAdapter.deleteRoots).toEqual([]);
    expect(restartedWorktrees.activeWorkspacePath(unknown!.sessionId, unknown!.worktree!))
      .toBe(resolve(unknown!.effectiveWorkspaceRoot));
    await restartedHost.resume(derivedId);
    expect(restartedAdapter.resumeRoots.at(-1)).toBe(resolve(derived.worktree.path));
  });

  test("derives an independent checkout and resumes the detached native binding from its copied cwd", { timeout: 120_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "joko-derived-worktree-"));
    const repositoryRoot = await createRepository(join(root, "project"));
    const store = new OperationalStore(join(root, "store.db"));
    const artifactRepository = new OperationalArtifactRepository(store);
    const artifacts = new ArtifactStore({
      rootDirectory: join(root, "artifacts"),
      repository: artifactRepository,
      ingestRoots: [root]
    });
    await artifacts.initialize();
    const workspaces = new WorkspaceService();
    const worktrees = new SessionWorktreeCoordinator({
      store,
      workspaces,
      storageRoot: join(root, "isolated")
    });
    const adapter = new TargetCaptureAdapter();
    const host = new SessionHost(store, artifacts, [adapter], { worktrees });
    await worktrees.initialize();
    await host.initialize();
    await host.registerTarget({
      id: "target-one",
      backendId: adapter.id,
      displayName: "Project",
      workspaceRoot: repositoryRoot,
      managed: false,
      trusted: true
    });
    const connection = store.createConnection({
      id: "connection-one",
      name: "Test device",
      authKeyDigest: "digest"
    });
    cleanups.push(async () => {
      await host.dispose().catch(() => undefined);
      worktrees.dispose();
      await workspaces.close().catch(() => undefined);
      store.close();
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    });

    const sourceId = (await host.createSession({
      operationId: "create-derivation-source",
      connection,
      targetId: "target-one",
      title: "Source task",
      fastMode: false,
      permissionMode: "ask",
      planMode: false,
      worktree: { sourceRef: "refs/heads/main", refreshRemote: false }
    })).value.sessionId;
    const source = store.getSession(sourceId).descriptor;
    if (source.worktree === undefined) throw new Error("Expected the source worktree binding.");
    await writeFile(join(source.worktree.path, "tracked.txt"), "staged source state\n", "utf8");
    await git(source.worktree.path, ["add", "tracked.txt"]);
    await writeFile(join(source.worktree.path, "tracked.txt"), "final source state\n", "utf8");
    await writeFile(join(source.worktree.path, "untracked.txt"), "new source file\n", "utf8");

    const derivedId = (await host.deriveSession({
      operationId: "clone-isolated-source",
      connection,
      sourceSessionId: sourceId,
      title: "Derived task",
      kind: "clone"
    })).value.sessionId;
    const derived = store.getSession(derivedId).descriptor;
    if (derived.worktree === undefined) throw new Error("Expected the derived worktree binding.");

    expect(derived.worktree.leaseId).not.toBe(source.worktree.leaseId);
    expect(derived.worktree.path).not.toBe(source.worktree.path);
    expect(derived.worktree.sourceCommit).toBe((await git(source.worktree.path, ["rev-parse", "HEAD"])).trim());
    expect(await git(derived.worktree.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]))
      .toBe(await git(source.worktree.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
    expect(await git(derived.worktree.path, ["diff", "--cached", "--binary"]))
      .toBe(await git(source.worktree.path, ["diff", "--cached", "--binary"]));
    expect(await git(derived.worktree.path, ["diff", "--binary"]))
      .toBe(await git(source.worktree.path, ["diff", "--binary"]));
    expect(adapter.deriveRoots).toEqual([resolve(derived.worktree.path)]);
    expect(workspaces.listRegistrations()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: source.worktree.workspaceId, root: resolve(source.worktree.path) }),
      expect.objectContaining({ id: derived.worktree.workspaceId, root: resolve(derived.worktree.path) })
    ]));

    for (const staleBinding of [
      { ...derived.worktree, workspaceId: `${derived.worktree.workspaceId}-stale` },
      { ...derived.worktree, acquiredAt: derived.worktree.acquiredAt - 1 },
      { ...derived.worktree, path: `${derived.worktree.path}-stale` },
      { ...derived.worktree, state: "preserved" as const }
    ]) {
      expect(worktrees.activeWorkspacePath(derivedId, staleBinding)).toBeUndefined();
      await expect(worktrees.release(derivedId, staleBinding)).rejects.toMatchObject({
        code: "SESSION_CONFLICT"
      });
      expect(worktrees.activeWorkspacePath(derivedId, derived.worktree)).toBe(resolve(derived.worktree.path));
    }

    await writeFile(join(derived.worktree.path, ".worktree-keep"), "retain exact checkout\n", "utf8");
    await expect(worktrees.release(derivedId, derived.worktree)).rejects.toMatchObject({
      code: "SESSION_CONFLICT"
    });
    expect(worktrees.activeWorkspacePath(derivedId, derived.worktree)).toBe(resolve(derived.worktree.path));
    expect(await readFile(join(derived.worktree.path, ".worktree-keep"), "utf8")).toContain("retain exact checkout");
    expect(store.getSession(derivedId).descriptor.worktree?.state).toBe("active");
    await rm(join(derived.worktree.path, ".worktree-keep"), { force: true });

    await host.resume(derivedId);
    expect(adapter.resumeRoots.at(-1)).toBe(resolve(derived.worktree.path));
    const sent = host.enqueueInput({
      operationId: "send-derived-worktree",
      connection,
      sessionId: derivedId,
      prompt: { text: "continue derived task", images: [], files: [], mentions: [], disposition: "prompt" }
    });
    await eventually(() => adapter.sendRoots.includes(resolve(derived.worktree!.path)));
    await eventually(() => ["backend_accepted", "completed"].includes(store.getQueueItem(sent.value.queueItemId).state));
    expect(adapter.observedTrackedContents.at(-1)?.replaceAll("\r\n", "\n")).toBe("final source state\n");

    adapter.failAfterClone = true;
    await expect(host.deriveSession({
      operationId: "clone-isolated-source-failure",
      connection,
      sourceSessionId: sourceId,
      title: "Failed derived task",
      kind: "clone"
    })).rejects.toThrow();
    const failedReceipt = store.findNativeSessionDerivation("clone-isolated-source-failure");
    expect(failedReceipt).toMatchObject({ state: "cleaned" });
    expect(adapter.deleteRoots.at(-1)).toBe(resolve(failedReceipt!.effectiveWorkspaceRoot));
    expect(worktrees.activeWorkspacePath(failedReceipt!.sessionId, failedReceipt!.worktree!)).toBeUndefined();
    expect(workspaces.listRegistrations().some((entry) => entry.id === `worktree-${failedReceipt!.sessionId}`)).toBe(false);

    const releaseFailure = vi.spyOn(worktrees, "release").mockRejectedValueOnce(
      new Error("The worktree release result was unavailable.")
    );
    await expect(host.deriveSession({
      operationId: "clone-isolated-worktree-release-failure",
      connection,
      sourceSessionId: sourceId,
      title: "Release retry task",
      kind: "clone"
    })).rejects.toThrow();
    releaseFailure.mockRestore();
    const releasePending = store.findNativeSessionDerivation("clone-isolated-worktree-release-failure")!;
    expect(releasePending.state).toBe("workspace_cleanup_pending");
    expect(worktrees.activeWorkspacePath(releasePending.sessionId, releasePending.worktree!))
      .toBe(resolve(releasePending.effectiveWorkspaceRoot));

    const finalStoreWrite = vi.spyOn(store, "finishNativeSessionDerivationCleanup")
      .mockImplementationOnce(() => { throw new Error("The final cleanup receipt write was unavailable."); });
    await expect(host.deriveSession({
      operationId: "clone-isolated-final-store-failure",
      connection,
      sourceSessionId: sourceId,
      title: "Final receipt retry task",
      kind: "clone"
    })).rejects.toThrow();
    finalStoreWrite.mockRestore();
    const finalizePending = store.findNativeSessionDerivation("clone-isolated-final-store-failure")!;
    expect(finalizePending.state).toBe("workspace_cleanup_pending");
    expect(worktrees.activeWorkspacePath(finalizePending.sessionId, finalizePending.worktree!)).toBeUndefined();
    await expect(lstat(finalizePending.effectiveWorkspaceRoot)).rejects.toMatchObject({ code: "ENOENT" });
    const nativeDeletesBeforeRestart = adapter.deleteRoots.length;

    const pendingProductSessionId = "pending-derived-product";
    const pendingWorktree = await worktrees.derive({
      sessionId: pendingProductSessionId,
      sourceSessionId: sourceId
    });
    const pendingOperation = store.claimAuthorizedDeferredEffectOperation(
      connection.id,
      connection.authKeyDigest,
      {
        id: "pending-derived-restart",
        kind: "clone_session",
        body: { sourceSessionId: sourceId, title: "Pending derived task", kind: "clone" }
      }
    );
    if (!pendingOperation.claimed) throw new Error("Expected a fresh pending derivation operation.");
    const pendingNativeBinding: NativeSessionBinding = {
      opaqueRef: `fake://${adapter.id}/${pendingProductSessionId}/clone/pending-native`,
      nativeSessionId: "pending-native",
      generation: source.binding.generation
    };
    const recorded = store.recordNativeSessionDerivation({
      operationId: pendingOperation.operation.id,
      expectedBodyHash: pendingOperation.operation.bodyHash,
      sourceSessionId: sourceId,
      sourceBinding: source.binding,
      sessionId: pendingProductSessionId,
      backendId: source.backendId,
      backendInstanceGeneration: store.getBackend(source.backendId).descriptor.instanceGeneration,
      targetId: source.targetId,
      effectiveWorkspaceRoot: pendingWorktree.path,
      worktree: pendingWorktree,
      binding: pendingNativeBinding
    });
    await host.dispose();
    worktrees.dispose();
    await workspaces.close();

    const restartedWorkspaces = new WorkspaceService();
    const restartedWorktrees = new SessionWorktreeCoordinator({
      store,
      workspaces: restartedWorkspaces,
      storageRoot: join(root, "isolated")
    });
    const restartedAdapter = new TargetCaptureAdapter();
    const restartedHost = new SessionHost(store, artifacts, [restartedAdapter], { worktrees: restartedWorktrees });
    cleanups.push(async () => {
      await restartedHost.dispose().catch(() => undefined);
      restartedWorktrees.dispose();
      await restartedWorkspaces.close().catch(() => undefined);
    });
    await restartedWorktrees.initialize();
    expect(restartedWorktrees.activeWorkspacePath(recorded.sessionId, recorded.worktree!))
      .toBe(resolve(pendingWorktree.path));
    expect(restartedWorktrees.activeWorkspacePath(releasePending.sessionId, releasePending.worktree!))
      .toBe(resolve(releasePending.effectiveWorkspaceRoot));
    expect(restartedWorktrees.activeWorkspacePath(finalizePending.sessionId, finalizePending.worktree!))
      .toBeUndefined();
    await restartedHost.initialize();
    expect(store.findNativeSessionDerivation(recorded.operationId)?.state).toBe("cleaned");
    expect(store.findNativeSessionDerivation(releasePending.operationId)?.state).toBe("cleaned");
    expect(store.findNativeSessionDerivation(finalizePending.operationId)?.state).toBe("cleaned");
    expect(restartedAdapter.deleteRoots).toEqual([resolve(pendingWorktree.path)]);
    expect(adapter.deleteRoots).toHaveLength(nativeDeletesBeforeRestart);
    expect(restartedWorktrees.activeWorkspacePath(recorded.sessionId, recorded.worktree!)).toBeUndefined();
    expect(restartedWorktrees.activeWorkspacePath(releasePending.sessionId, releasePending.worktree!)).toBeUndefined();
  });
});

describe("remote checkout coordination", () => {
  test("keeps a remote lease active in Store when startup inspection is unavailable and releases only exact ownership", async () => {
    const f = await remoteFixture();
    const binding = remoteBindingFromLease(f.plan.workspaceId, f.lease);
    f.store.createSession({ ...f.session("child", "native://child"), worktree: binding });
    f.owner.assertExact.mockRejectedValueOnce(new Error("Remote inspection is temporarily unavailable."));
    await f.worktrees.initialize();

    expect(f.store.getSession("child").descriptor.worktree?.state).toBe("active");
    expect(f.workspaces.listRegistrations()).toEqual([]);
    expect(f.worktrees.activeWorkspacePath("child", binding)).toBeUndefined();
    expect(await f.worktrees.assertActiveRemoteWorktree("child", binding)).toBe(f.plan.path);
    expect(f.workspaces.listRegistrations()).toContainEqual(expect.objectContaining({
      id: f.plan.workspaceId,
      root: f.plan.path,
      remote: {
        targetId: "remote-target",
        binding: { ...f.plan.remote.binding, workspaceRoot: f.plan.path }
      }
    }));
    expect(f.worktrees.effectiveTarget(f.store.getSession("child")).remoteWorkspace?.workspaceRoot)
      .toBe(f.plan.path);
    expect(await f.worktrees.previewRemoval("child")).toEqual({ hasWorktree: true, dirty: true });

    f.owner.releaseExact.mockResolvedValueOnce("preserved");
    await expect(f.worktrees.release("child", binding)).rejects.toMatchObject({ code: "SESSION_CONFLICT" });
    expect(f.store.getSession("child").descriptor.worktree?.state).toBe("active");
    expect(f.workspaces.listRegistrations()).toHaveLength(1);
    await f.worktrees.release("child", binding);
    expect(f.store.getSession("child").descriptor.worktree?.state).toBe("preserved");
    expect(f.workspaces.listRegistrations()).toEqual([]);
  });

  test("requires a durable plan before remote checkout mutation and retains an exact unadopted lease", async () => {
    const f = await remoteFixture();
    await f.worktrees.initialize();
    expect(await f.worktrees.planRemoteDerivation({ sessionId: "child", sourceSessionId: "source" }))
      .toEqual(f.plan);
    await expect(f.worktrees.acquirePlannedRemoteDerivation(f.plan))
      .rejects.toMatchObject({ code: "SESSION_CONFLICT" });
    expect(f.owner.derive).not.toHaveBeenCalled();

    const connection = f.store.createConnection({ id: "remote-device", name: "Remote device",
      authKeyDigest: "remote-digest" });
    const claim = f.store.claimAuthorizedDeferredEffectOperation(connection.id, connection.authKeyDigest, {
      id: "remote-derive", kind: "clone_session", body: { sourceSessionId: "source" }
    });
    if (!claim.claimed) throw new Error("Expected a fresh remote derivation claim.");
    f.store.prepareNativeSessionDerivation({
      operationId: claim.operation.id,
      expectedBodyHash: claim.operation.bodyHash,
      sourceSessionId: "source",
      sourceBinding: f.store.getSession("source").descriptor.binding,
      sourceSessionRevision: f.store.getSession("source").revision,
      sessionId: "child",
      backendId: "remote-backend",
      backendInstanceGeneration: 0,
      targetId: "remote-target",
      targetRevision: f.store.getTarget("remote-target").revision,
      effectiveWorkspaceRoot: f.plan.path,
      remoteWorkspace: f.store.getTarget("remote-target").descriptor.remoteWorkspace,
      remoteWorktreePlan: f.plan
    });

    const binding = await f.worktrees.acquirePlannedRemoteDerivation(f.plan);
    expect(binding).toEqual({
      ...remoteBindingFromLease(f.plan.workspaceId, f.lease),
      updatedAt: binding.updatedAt
    });
    expect(binding.updatedAt).toEqual(expect.any(Number));
    expect(f.workspaces.listRegistrations()).toContainEqual(expect.objectContaining({
      id: f.plan.workspaceId, root: f.plan.path,
      remote: {
        targetId: "remote-target",
        binding: { ...f.plan.remote.binding, workspaceRoot: f.plan.path }
      }
    }));
    expect(await f.worktrees.inspectPlannedRemoteDerivation(f.plan)).toEqual({ status: "active", lease: f.lease });
    f.owner.releaseExact.mockResolvedValueOnce("preserved");
    expect(await f.worktrees.releasePlannedRemoteDerivation(f.plan, f.lease)).toBe("preserved");
    expect(f.workspaces.listRegistrations()).toHaveLength(1);
    expect(await f.worktrees.releasePlannedRemoteDerivation(f.plan, f.lease)).toBe("released");
    expect(f.workspaces.listRegistrations()).toEqual([]);
    expect(f.store.findNativeSessionDerivation("remote-derive")?.remoteWorktreePlan).toEqual(f.plan);
  });
});

async function remoteFixture() {
  const root = await mkdtemp(join(tmpdir(), "joko-remote-worktree-coordinator-"));
  const store = new OperationalStore(join(root, "store.db"));
  store.upsertBackend({ id: "remote-backend", adapterKind: "fixture", displayName: "Remote",
    version: "1", instanceGeneration: 0, health: "healthy", installationState: "installed",
    authenticationState: "not_required", capabilities: new Map(), models: [], tools: [], diagnostics: [] });
  const remoteWorkspace = { kind: "ssh" as const, hostTargetId: "remote-target", hostId: "ssh", workspaceRoot: "/srv/project" };
  store.upsertTarget({ id: "remote-target", backendId: "remote-backend", displayName: "Remote project",
    workspaceRoot: join(root, "placeholder"), managed: true, trusted: true, remoteWorkspace });
  let host = store.createRemoteHost({ ownerId: "owner", targetId: "remote-target", id: "ssh",
    hostname: "host.example.test", user: "builder", source: "manual" });
  host = store.pinRemoteHostTrust({ ownerId: host.ownerId, targetId: host.targetId, id: host.id,
    expectedRevision: host.revision, algorithm: "ssh-ed25519", fingerprint: `SHA256:${"A".repeat(43)}` });
  for (const state of ["connecting", "authenticating", "ready"] as const) {
    host = store.updateRemoteHostStatus({ ownerId: host.ownerId, targetId: host.targetId,
      id: host.id, expectedRevision: host.revision, state });
  }
  const session = (id: string, opaqueRef: string): SessionDescriptor => ({
    id, backendId: "remote-backend", targetId: "remote-target", title: id,
    binding: { opaqueRef, nativeSessionId: id, generation: 0 },
    pinned: false, archived: false, permissionMode: "ask", planMode: false,
    fastMode: false, remoteWorkspace, createdAt: 1, updatedAt: 1
  });
  store.createSession(session("source", "native://source"));
  const leaseId = "99999999-9999-4999-8999-999999999999";
  const manifestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const sourceCommit = "c".repeat(40);
  const authority = {
    targetId: "remote-target",
    binding: remoteWorkspace,
    executionIdentity: JSON.stringify({
      kind: "ssh", hostTargetId: remoteWorkspace.hostTargetId, hostId: remoteWorkspace.hostId,
      ownerId: host.ownerId, hostname: host.hostname, port: host.port, user: host.user,
      algorithm: host.trust!.algorithm, fingerprint: host.trust!.fingerprint
    }),
    targetRevision: store.getTarget("remote-target").revision.toString(),
  };
  const plan: RemoteGitCheckoutPlan = {
    format: 1, leaseId, manifestId, sessionId: "child", sourceSessionId: "source",
    workspaceId: "worktree-child", sourceCwd: remoteWorkspace.workspaceRoot,
    sourceSnapshot: `sha256:${"f".repeat(64)}`,
    path: `/srv/joko/checkouts/${leaseId}`, repositoryRoot: "/srv/repository",
    branch: `joko/remote-${createHash("sha256").update("child").digest("hex").slice(0, 12)}-${leaseId.slice(0, 8)}`,
    sourceRef: sourceCommit, sourceCommit, sourceStrategy: "explicit", sourceRefreshed: false,
    storageRoot: "/srv/joko", authority, remote: { ...authority, manifestId }
  };
  const lease: RemoteGitCheckoutLease = {
    id: leaseId, sessionId: "child", path: plan.path, repositoryRoot: plan.repositoryRoot,
    branch: plan.branch, source: { ref: sourceCommit, commit: sourceCommit,
      strategy: "explicit", refreshed: false }, acquiredAt: 10, remote: plan.remote
  };
  const owner = {
    plan: vi.fn(async () => plan),
    derive: vi.fn(async () => lease),
    inspectExact: vi.fn(async () => ({ status: "active" as const, lease })),
    cleanupPending: vi.fn(async () => "released" as const),
    assertExact: vi.fn(async () => undefined),
    releaseExact: vi.fn(async (): Promise<"released" | "preserved"> => "released")
  };
  const delegate = {
    register: async (registration: WorkspaceRegistration) => registration,
    unregister: vi.fn(),
    close: async () => undefined
  } as unknown as RemoteWorkspaceDelegate;
  const workspaces = new WorkspaceService({ remoteDelegate: delegate });
  const worktrees = new SessionWorktreeCoordinator({ store, workspaces, remoteOwner: owner,
    storageRoot: join(root, "local-checkouts") });
  cleanups.push(async () => {
    worktrees.dispose();
    await workspaces.close();
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  return { store, workspaces, worktrees, owner, plan, lease, session };
}

class TargetCaptureAdapter extends FakeBackendAdapter {
  readonly sendRoots: string[] = [];
  readonly observedTrackedContents: string[] = [];
  readonly deriveRoots: string[] = [];
  readonly resumeRoots: string[] = [];
  readonly deleteRoots: string[] = [];
  failAfterClone = false;
  failDelete = false;

  constructor() {
    super({
      ...PI_LIKE_PROFILE,
      id: "worktree-lifecycle-adapter",
      capabilities: [
        ...PI_LIKE_PROFILE.capabilities,
        { key: "session.clone", supported: true },
        { key: "workspace.derive", supported: true }
      ]
    });
  }

  override async clone(context: AdapterContext, derivation: NativeSessionDerivation): Promise<NativeSessionBinding> {
    this.deriveRoots.push(resolve(derivation.target.workspaceRoot));
    const binding = await super.clone(context, derivation);
    if (this.failAfterClone) throw new Error("The derived native binding failed validation.");
    return binding;
  }

  override async deleteSession(binding: NativeSessionBinding, context: AdapterContext): Promise<void> {
    this.deleteRoots.push(resolve(context.target.workspaceRoot));
    await super.deleteSession(binding, context);
    if (this.failDelete) throw new Error("The detached native deletion outcome is unknown.");
  }

  override async resumeSession(binding: NativeSessionBinding, context: AdapterContext): Promise<NativeSessionState> {
    this.resumeRoots.push(resolve(context.target.workspaceRoot));
    return super.resumeSession(binding, context);
  }

  override async send(input: PromptInput, context: AdapterContext): Promise<void> {
    this.sendRoots.push(resolve(context.target.workspaceRoot));
    this.observedTrackedContents.push(await readFile(join(context.target.workspaceRoot, "tracked.txt"), "utf8"));
    await super.send(input, context);
  }
}

async function createRepository(repositoryRoot: string): Promise<string> {
  await mkdir(repositoryRoot, { recursive: true });
  await git(repositoryRoot, ["init", "--initial-branch=main"]);
  await git(repositoryRoot, ["config", "user.name", "Joko Test"]);
  await git(repositoryRoot, ["config", "user.email", "test@invalid.example"]);
  await writeFile(join(repositoryRoot, "tracked.txt"), "initial\n", "utf8");
  await git(repositoryRoot, ["add", "."]);
  await git(repositoryRoot, ["commit", "-m", "initial"]);
  return resolve(repositoryRoot);
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const environment: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "C" };
  for (const key of ["GIT_COMMON_DIR", "GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE"]) delete environment[key];
  return new Promise<string>((resolveResult, reject) => {
    execFile("git", [...args], {
      cwd,
      encoding: "utf8",
      env: environment,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true
    }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(`Git fixture command failed: ${stderr.trim()}`, { cause: error }));
        return;
      }
      resolveResult(stdout);
    });
  });
}

async function eventually(assertion: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!assertion()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for the lifecycle assertion.");
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}
