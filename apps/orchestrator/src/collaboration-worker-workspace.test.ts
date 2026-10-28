import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AdapterContext, CreateNativeSessionInput } from "@joko/core";
import { OperationalStore } from "@joko/store";
import { DEFAULT_COLLABORATION_SETTINGS } from "@joko/runtime-governance";
import { FakeBackendAdapter, PI_LIKE_PROFILE } from "@joko/testkit";
import { afterEach, expect, it } from "vitest";
import { ArtifactStore } from "./artifact-store.js";
import { OperationalArtifactRepository } from "./artifact-repository.js";
import { CollaborationGoalManager } from "./collaboration-goal-manager.js";
import { SessionHost } from "./session-host.js";
import { SessionWorktreeCoordinator } from "./session-worktree-coordinator.js";
import { WorkspaceService } from "./workspace-service.js";
import { mkdtemp } from "./test-paths.js";
import { planWorkerWorkspace, prepareWorkerRuntimeWorkspace, readWorkerWorkspaceBinding, WORKER_WORKSPACE_PLAN_KEY } from "./collaboration-worker-workspace.js";

const execute = promisify(execFile), cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execute("git", ["-c", "commit.gpgSign=false", ...args], { cwd, windowsHide: true, encoding: "utf8" })).stdout.trim();
}
class WorkspaceAdapter extends FakeBackendAdapter {
  readonly directories: string[] = [];
  beforeCreate?: (context: AdapterContext) => void;
  override async createSession(input: CreateNativeSessionInput, context: AdapterContext) {
    this.directories.push(context.target.workspaceRoot); this.beforeCreate?.(context);
    return super.createSession(input, context);
  }
}
async function fixture(isolateLead = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "joko-worker-project-"))), project = join(root, "project"), subproject = join(project, "packages", "app");
  await mkdir(subproject, { recursive: true });
  await git(project, "init", "-b", "main");
  await git(project, "config", "user.email", "worker@example.test"); await git(project, "config", "user.name", "Worker test");
  await writeFile(join(project, "root.txt"), "committed root\n"); await writeFile(join(subproject, "app.txt"), "committed app\n");
  await git(project, "add", "."); await git(project, "commit", "-m", "Initial project");
  const sourceCommit = await git(project, "rev-parse", "HEAD");
  const store = new OperationalStore(join(root, "store.db")), artifacts = new ArtifactStore({ rootDirectory: join(root, "artifacts"),
    repository: new OperationalArtifactRepository(store), ingestRoots: [root] });
  await artifacts.initialize();
  const workspaces = new WorkspaceService(), worktrees = new SessionWorktreeCoordinator({ store, workspaces, storageRoot: join(root, "worktrees") });
  const adapter = new WorkspaceAdapter(PI_LIKE_PROFILE), host = new SessionHost(store, artifacts, [adapter], { worktrees });
  await worktrees.initialize(); await host.initialize();
  await host.registerTarget({ id: "project", backendId: adapter.id, displayName: "Project", workspaceRoot: project, managed: false, trusted: true });
  await workspaces.register({ id: "project", root: project, displayName: "Project", trusted: true });
  const connection = store.createConnection({ id: "owner", name: "Owner", authKeyDigest: createHash("sha256").update("owner").digest("hex") });
  const leadId = (await host.createSession({ operationId: "lead", connection, targetId: "project", title: "Lead", permissionMode: "ask", planMode: false, fastMode: false,
    ...(isolateLead ? { worktree: { sourceRef: "refs/heads/main", refreshRemote: false } } : {}) })).value.sessionId;
  const manager = new CollaborationGoalManager({ store, sessionHost: host, readSettings: () => DEFAULT_COLLABORATION_SETTINGS });
  await manager.initialize();
  const goal = manager.createGoal({ operationId: "goal", leadSessionId: leadId, expectedSessionGeneration: store.getSession(leadId).descriptor.binding.generation,
    title: "Project workers", objective: "Use the exact selected project." }).goal;
  const input = (operationId: string) => ({ operationId, goalId: goal.id, callerLeadSessionId: leadId,
    expectedGoalRevision: manager.getTree(goal.id).goal.revision, label: operationId, role: "developer", assignment: "",
    route: { targetId: "project", permissionMode: "ask" as const, planMode: false, fastMode: false } });
  cleanups.push(async () => { await manager.close(); await host.dispose().catch(() => {}); worktrees.dispose(); await workspaces.close();
    store.close(); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  return { root, project, subproject, sourceCommit, store, adapter, host, manager, workspaces, worktrees, leadId, input };
}

it("creates a worker in its approved subproject and replays only the original directory operation", async () => {
  const f = await fixture(), request = { ...f.input("subproject-worker"), workspace: { workingDirectory: f.subproject, createWorktree: false } };
  const result = await f.manager.createWorker(request), sessionId = result.worker.sessionId!;
  expect(f.adapter.directories.at(-1)).toBe(await realpath(f.subproject));
  const binding = readWorkerWorkspaceBinding(f.store, sessionId)!;
  expect(f.host.captureToolWorkspace({ sessionId, targetId: "project", generation: result.worker.sessionGeneration! }).root).toBe(binding.path);
  expect(result.tree.workers[0]?.workspace?.workingDirectory).toBe(binding.path);
  expect(f.workspaces.listRegistrations().find(row => row.id === binding.workspaceId)?.root).toBe(binding.path);
  expect((await f.manager.createWorker(request)).worker.sessionId).toBe(sessionId);
  expect(f.adapter.directories).toHaveLength(2);
  await expect(f.manager.createWorker({ ...request, workspace: { workingDirectory: f.project, createWorktree: false } })).rejects.toThrow("different collaboration input");
  const outside = join(f.root, "outside"); await mkdir(outside);
  await expect(f.manager.createWorker({ ...f.input("outside-worker"), workspace: { workingDirectory: outside, createWorktree: false } })).rejects.toThrow("trust this directory");
  expect(f.store.findOperation("outside-worker")).toBeUndefined();
});

it("pins an isolated worker's chosen revision, preserves the subproject and leaves dirty source files behind", { timeout: 30_000 }, async () => {
  const f = await fixture(); await writeFile(join(f.subproject, "uncommitted.txt"), "local changes");
  const result = await f.manager.createWorker({ ...f.input("isolated-worker"), workspace: { workingDirectory: f.subproject, createWorktree: true, sourceRef: "main" } });
  const worker = result.tree.workers[0]!, session = f.store.getSession(worker.sessionId!).descriptor;
  expect(session.worktree?.sourceCommit).toBe(f.sourceCommit);
  expect(worker.workspace?.workingDirectory).toBe(join(session.worktree!.path, "packages", "app"));
  expect(await readFile(join(worker.workspace!.workingDirectory, "app.txt"), "utf8")).toBe("committed app\n");
  await expect(stat(join(worker.workspace!.workingDirectory, "uncommitted.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(join(f.subproject, "uncommitted.txt"), "utf8")).toBe("local changes");
  const plan = f.store.findSetting("service", worker.id, WORKER_WORKSPACE_PLAN_KEY)?.value;
  expect(plan).toMatchObject({ sourceRef: "main", sourceCommit: f.sourceCommit, createWorktree: true });
  expect(f.host.captureToolWorkspace({ sessionId: session.id, targetId: "project", generation: session.binding.generation }).root).toBe(worker.workspace?.workingDirectory);
  await expect(f.manager.createWorker({ ...f.input("invalid-source"), workspace: { createWorktree: true, sourceRef: "missing-branch" } })).rejects.toThrow("source revision");
  expect(f.store.findOperation("invalid-source")).toBeUndefined();
});

it("inherits the lead's real checkout and retains its lease while a worker still owns that directory", { timeout: 30_000 }, async () => {
  const f = await fixture(true), source = f.store.getSession(f.leadId).descriptor.worktree!;
  const result = await f.manager.createWorker(f.input("inherited-worker")), worker = result.tree.workers[0]!;
  expect(worker.workspace?.workingDirectory).toBe(source.path);
  expect(f.store.getSession(worker.sessionId!).descriptor.worktree).toBeUndefined();
  await f.host.closeIfActive(f.leadId); await f.worktrees.release(f.leadId);
  expect(f.store.getSession(f.leadId).descriptor.worktree?.state).toBe("preserved");
  expect((await stat(source.path)).isDirectory()).toBe(true);
  expect(f.host.captureToolWorkspace({ sessionId: worker.sessionId!, targetId: "project", generation: worker.sessionGeneration! }).root).toBe(source.path);
});

it("keeps native creation with an unknown outcome fenced to the same worker and original project", async () => {
  const f = await fixture(); f.adapter.beforeCreate = () => { throw new Error("Native create reply lost."); };
  const request = { ...f.input("unknown-worker"), workspace: { workingDirectory: f.subproject, createWorktree: false } };
  await expect(f.manager.createWorker(request)).rejects.toBeDefined();
  const worker = f.store.listCollaborationWorkers()[0]!;
  expect(worker.status).toBe("dispatch_unknown");
  expect(f.store.getOperation(`session:${createHash("sha256").update(request.operationId).digest("hex")}`).status).toBe("started");
  expect((await f.manager.createWorker(request)).worker.id).toBe(worker.id);
  expect(f.adapter.directories).toHaveLength(2);
});

it("does not widen a trusted subproject to its repository root when the chosen revision lacks that directory", async () => {
  const f = await fixture(), lead = f.store.getSession(f.leadId).descriptor;
  const target = f.store.upsertTarget({ ...f.store.getTarget("project").descriptor, id: "subproject", workspaceRoot: f.subproject }).descriptor;
  const plan = (await planWorkerWorkspace({ store: f.store, lead, target, request: { createWorktree: true } }))!;
  expect(plan.allowRootFallback).toBe(false);
  const emptyCheckout = join(f.root, "empty-checkout"); await mkdir(emptyCheckout);
  await expect(prepareWorkerRuntimeWorkspace(f.store, plan, "unadmitted", { path: emptyCheckout, workspaceId: "worker" })).rejects.toThrow("approved worker subproject");
});

it("rejects stale project authority and resolves a linked checkout's own HEAD before worktree allocation", { timeout: 30_000 }, async () => {
  const f = await fixture(), linked = join(f.root, "linked");
  await git(f.project, "worktree", "add", "-b", "linked-branch", linked, "main");
  await writeFile(join(linked, "branch.txt"), "linked checkout"); await git(linked, "add", "."); await git(linked, "commit", "-m", "Linked branch");
  const lead = f.store.getSession(f.leadId).descriptor, target = f.store.getTarget("project").descriptor;
  const plan = (await planWorkerWorkspace({ store: f.store, lead, target, request: { createWorktree: true },
    captureLead: () => ({ root: linked, remote: false, assertCurrent: () => {} }) }))!;
  expect(plan).toMatchObject({ directory: linked, worktreeRoot: await realpath(f.project), sourceCommit: await git(linked, "rev-parse", "HEAD") });
  f.store.upsertTarget({ ...target, trusted: false });
  await expect(prepareWorkerRuntimeWorkspace(f.store, plan, "not-admitted", { path: linked, workspaceId: "workspace" })).rejects.toThrow("project changed");
});
