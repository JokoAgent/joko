import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "./test-paths.js";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type {
  AdapterContext,
  NativeSessionBinding,
  NativeSessionDerivation,
  NativeSessionState,
  PromptInput
} from "@joko/core";
import { OperationalStore } from "@joko/store";
import { FakeBackendAdapter, PI_LIKE_PROFILE } from "@joko/testkit";
import { afterEach, describe, expect, test } from "vitest";

import { OperationalArtifactRepository } from "./artifact-repository.js";
import { ArtifactStore } from "./artifact-store.js";
import { SessionHost } from "./session-host.js";
import { SessionWorktreeCoordinator } from "./session-worktree-coordinator.js";
import { WorkspaceService } from "./workspace-service.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("SessionWorktreeCoordinator lifecycle", () => {
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

  test("derives an independent checkout and resumes the detached native binding from its copied cwd", { timeout: 60_000 }, async () => {
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
    expect(worktrees.activeWorkspacePath(failedReceipt!.sessionId, failedReceipt!.effectiveWorkspaceRoot)).toBeUndefined();
    expect(workspaces.listRegistrations().some((entry) => entry.id === `worktree-${failedReceipt!.sessionId}`)).toBe(false);

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
    expect(restartedWorktrees.activeWorkspacePath(recorded.sessionId, recorded.effectiveWorkspaceRoot))
      .toBe(resolve(pendingWorktree.path));
    await restartedHost.initialize();
    expect(store.findNativeSessionDerivation(recorded.operationId)?.state).toBe("cleaned");
    expect(restartedAdapter.deleteRoots).toEqual([resolve(pendingWorktree.path)]);
    expect(restartedWorktrees.activeWorkspacePath(recorded.sessionId, recorded.effectiveWorkspaceRoot)).toBeUndefined();
  });
});

class TargetCaptureAdapter extends FakeBackendAdapter {
  readonly sendRoots: string[] = [];
  readonly observedTrackedContents: string[] = [];
  readonly deriveRoots: string[] = [];
  readonly resumeRoots: string[] = [];
  readonly deleteRoots: string[] = [];
  failAfterClone = false;

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
