import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { SessionDescriptor, TargetDescriptor } from "@joko/core";
import { AuthorizationError, StoreError, type OperationalStore } from "@joko/store";

const execute = promisify(execFile);
export const WORKER_WORKSPACE_PLAN_KEY = "collaboration.worker-workspace-plan";
export const WORKER_WORKSPACE_BINDING_KEY = "collaboration.worker-workspace";

export interface WorkerWorkspaceRequest {
  readonly workingDirectory?: string;
  readonly createWorktree: boolean;
  readonly sourceRef?: string;
}
export interface WorkerWorkspacePlan {
  readonly format: 1;
  readonly targetId: string;
  readonly targetRevision: string;
  readonly projectRoot: string;
  readonly directory: string;
  readonly realDirectory: string;
  readonly createWorktree: boolean;
  readonly worktreeRoot?: string;
  readonly relativeDirectory?: string;
  readonly allowRootFallback?: boolean;
  readonly sourceRef?: string;
  readonly sourceCommit?: string;
  readonly inherited?: { readonly sessionId: string; readonly generation: number; readonly worktreeLeaseId?: string };
}
export interface WorkerWorkspaceBinding {
  readonly format: 1;
  readonly targetId: string;
  readonly workspaceId: string;
  readonly path: string;
  readonly projectRoot: string;
  readonly targetRoot: string;
  readonly inheritedSessionId?: string;
  readonly inheritedWorktreeLeaseId?: string;
}
export interface WorkerWorkspaceView {
  readonly workingDirectory: string;
  readonly worktreePath?: string;
  readonly sourceRef?: string;
}

/** A project choice never grants execution outside an already trusted root.
 * Resolve the actual lead checkout before choosing the default Git revision. */
export async function planWorkerWorkspace(options: {
  readonly store: OperationalStore;
  readonly lead: SessionDescriptor;
  readonly target: TargetDescriptor;
  readonly request?: WorkerWorkspaceRequest;
  readonly captureLead?: () => { readonly root: string; readonly remote: boolean; readonly assertCurrent: () => void };
  readonly signal?: AbortSignal;
}): Promise<WorkerWorkspacePlan | undefined> {
  const { store, lead, target, request } = options;
  options.signal?.throwIfAborted();
  if (lead.remoteWorkspace !== undefined && request !== undefined) throw new StoreError("Worker project options require a local lead.");
  if (request === undefined && options.captureLead === undefined) return undefined;
  if (target.remoteWorkspace !== undefined) {
    if (request !== undefined) throw new StoreError("Worker project options require a local project.");
    return undefined;
  }
  if (!target.trusted) throw new AuthorizationError("The worker project must be trusted.");
  const revision = store.getTarget(target.id).revision.toString();
  const inherited = target.id === lead.targetId ? options.captureLead?.() : undefined;
  if (inherited?.remote) throw new StoreError("A remote lead cannot select a local worker directory.");
  inherited?.assertCurrent();
  const projectRoot = await realpath(target.workspaceRoot);
  const directory = request?.workingDirectory ?? inherited?.root ?? target.workspaceRoot;
  if (!isAbsolute(directory) || directory.length > 32768 || /[\0\r\n]/u.test(directory)) {
    throw new StoreError("An absolute worker project directory is required.");
  }
  const realDirectory = await realpath(directory);
  if (!(await stat(realDirectory)).isDirectory()) throw new StoreError("The worker project is not a directory.");
  const inheritedRoot = inherited ? await realpath(inherited.root) : undefined;
  if (!workerPathWithin(projectRoot, realDirectory) && !(inheritedRoot && workerPathWithin(inheritedRoot, realDirectory))) {
    throw new AuthorizationError("Select and trust this directory as a project before creating a worker there.");
  }
  if (request?.sourceRef !== undefined && !request.createWorktree) throw new StoreError("A source revision requires a new worker worktree.");
  let worktree: Pick<WorkerWorkspacePlan, "worktreeRoot" | "relativeDirectory" | "allowRootFallback" | "sourceRef" | "sourceCommit"> = {};
  if (request?.createWorktree) {
    const sourceRef = request.sourceRef ?? "HEAD";
    if (!sourceRef || sourceRef.length > 1024 || sourceRef.startsWith("-") || /[\0-\x1f\x7f]/u.test(sourceRef)) {
      throw new StoreError("The worker worktree source must name an existing branch or commit.");
    }
    // Pin the exact commit before reserving a worker or creating a checkout.
    const sourceCommit = await git(realDirectory, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${sourceRef}^{commit}`], true, options.signal);
    if (!/^[a-f0-9]{40,64}$/u.test(sourceCommit)) throw new StoreError("The worker worktree source is unavailable.");
    const checkoutRoot = await realpath(await git(realDirectory, ["rev-parse", "--show-toplevel"], true, options.signal));
    const listed = await git(realDirectory, ["worktree", "list", "--porcelain", "-z"], false, options.signal);
    const mainRoot = listed.split("\0").find(line => line.startsWith("worktree "))?.slice(9);
    if (!mainRoot || !workerPathWithin(checkoutRoot, realDirectory)) throw new StoreError("The worker checkout is unavailable.");
    const worktreeRoot = await realpath(mainRoot);
    worktree = { worktreeRoot, relativeDirectory: relative(checkoutRoot, realDirectory), allowRootFallback: workerPathWithin(projectRoot, worktreeRoot), sourceRef, sourceCommit };
  }
  inherited?.assertCurrent();
  options.signal?.throwIfAborted();
  const plan: WorkerWorkspacePlan = { format: 1, targetId: target.id, targetRevision: revision, projectRoot,
    directory, realDirectory, createWorktree: request?.createWorktree === true, ...worktree,
    ...(inherited === undefined ? {} : { inherited: { sessionId: lead.id, generation: lead.binding.generation,
      ...(lead.worktree === undefined ? {} : { worktreeLeaseId: lead.worktree.leaseId }) } }) };
  assertWorkerWorkspacePlan(store, plan);
  return plan;
}

export function assertWorkerWorkspacePlan(store: OperationalStore, plan: WorkerWorkspacePlan): void {
  const target = store.getTarget(plan.targetId);
  if (plan.format !== 1 || !target.descriptor.trusted || target.descriptor.remoteWorkspace !== undefined
    || target.revision.toString() !== plan.targetRevision || !isAbsolute(plan.projectRoot) || !isAbsolute(plan.realDirectory)) {
    throw new AuthorizationError("The selected worker project changed.");
  }
  if (plan.inherited) {
    const source = store.getSession(plan.inherited.sessionId).descriptor;
    if (source.targetId !== plan.targetId || source.binding.generation !== plan.inherited.generation || source.archived || source.deletedAt !== undefined
      || source.worktree?.leaseId !== plan.inherited.worktreeLeaseId) throw new AuthorizationError("The lead workspace changed.");
  }
}

export async function prepareWorkerRuntimeWorkspace(store: OperationalStore, plan: WorkerWorkspacePlan, sessionId: string, worktree?: { readonly path: string; readonly workspaceId: string }): Promise<WorkerWorkspaceBinding> {
  assertWorkerWorkspacePlan(store, plan);
  if (await realpath(plan.directory) !== plan.realDirectory || await realpath(store.getTarget(plan.targetId).descriptor.workspaceRoot) !== plan.projectRoot) {
    throw new AuthorizationError("The worker project directory changed.");
  }
  let path = plan.realDirectory;
  if (plan.createWorktree) {
    if (!worktree) throw new StoreError("The worker worktree was not created.");
    const root = await realpath(worktree.path);
    path = root;
    if (plan.relativeDirectory) {
      let selected = false;
      try {
        const subproject = await realpath(join(root, plan.relativeDirectory));
        if (workerPathWithin(root, subproject) && (await stat(subproject)).isDirectory()) { path = subproject; selected = true; }
      } catch { /* The selected revision may not contain this subproject. */ }
      if (!selected && !plan.allowRootFallback) throw new AuthorizationError("This source revision does not contain the approved worker subproject.");
    }
  }
  assertWorkerWorkspacePlan(store, plan);
  return { format: 1, targetId: plan.targetId, workspaceId: worktree?.workspaceId ?? `workspace-worker-${sessionId}`, path, projectRoot: plan.projectRoot,
    targetRoot: store.getTarget(plan.targetId).descriptor.workspaceRoot,
    ...(!plan.createWorktree && plan.inherited ? { inheritedSessionId: plan.inherited.sessionId,
      ...(plan.inherited.worktreeLeaseId === undefined ? {} : { inheritedWorktreeLeaseId: plan.inherited.worktreeLeaseId }) } : {}) };
}

export function readWorkerWorkspaceBinding(store: OperationalStore, sessionId: string): WorkerWorkspaceBinding | undefined {
  const row = store.findSetting<WorkerWorkspaceBinding>("service", sessionId, WORKER_WORKSPACE_BINDING_KEY)?.value;
  if (row === undefined) return undefined;
  if (row.format !== 1 || !row.targetId || !row.workspaceId || !isAbsolute(row.path) || !isAbsolute(row.projectRoot) || !isAbsolute(row.targetRoot)) throw new StoreError("The worker workspace binding is invalid.");
  return row;
}

export function workerWorkspaceTarget(store: OperationalStore, session: SessionDescriptor, target: TargetDescriptor): TargetDescriptor {
  const binding = readWorkerWorkspaceBinding(store, session.id);
  if (!binding) return target;
  if (binding.targetId !== session.targetId || !target.trusted || target.remoteWorkspace !== undefined || target.workspaceRoot !== binding.targetRoot && session.worktree === undefined) throw new AuthorizationError("The worker project is unavailable.");
  if (binding.inheritedWorktreeLeaseId) {
    const source = binding.inheritedSessionId ? store.findSession(binding.inheritedSessionId)?.descriptor : undefined;
    if (!source || source.worktree?.leaseId !== binding.inheritedWorktreeLeaseId) throw new AuthorizationError("The inherited worker checkout is unavailable.");
  }
  return { ...target, workspaceRoot: binding.path };
}

export function workerPathWithin(root: string, path: string): boolean {
  const key = (value: string) => process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
  const offset = relative(key(root), key(path));
  return offset === "" || offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset);
}

async function git(cwd: string, args: readonly string[], trim = true, signal?: AbortSignal): Promise<string> {
  try {
    const { stdout } = await execute("git", [...args], { cwd, timeout: 5_000, maxBuffer: 1024 * 1024, windowsHide: true, encoding: "utf8", ...(signal ? { signal } : {}) });
    return trim ? stdout.replace(/[\r\n]+$/u, "") : stdout;
  } catch { throw new StoreError("The worker Git project or source revision is unavailable."); }
}
