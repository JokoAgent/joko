import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "./test-paths.js";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { AdapterContext, PromptInput } from "@joko/core";
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

    await host.close(sessionId);
    await worktrees.archive(sessionId);
    store.updateSession(sessionId, { archived: true });
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
});

class TargetCaptureAdapter extends FakeBackendAdapter {
  readonly sendRoots: string[] = [];
  readonly observedTrackedContents: string[] = [];

  constructor() {
    super({ ...PI_LIKE_PROFILE, id: "worktree-lifecycle-adapter" });
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
