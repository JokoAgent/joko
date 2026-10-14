import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { lstat } from "node:fs/promises";
import type { ClaudeManagedChildWorkspace, ClaudeManagedChildWorkspaceInput } from "@joko/adapter-claude-code";
import { operationBodyHash, type OperationalStore } from "@joko/store";
import { EphemeralWorktreeService, type WorktreeLease } from "@joko/worktree";
import type { SessionWorktreeCoordinator } from "./session-worktree-coordinator.js";

const SCOPE = "native.managed-child-workspaces";
interface ChildWorkspaceRecord {
  readonly version: 1;
  readonly ownerId: string;
  readonly backendId: string;
  readonly backendGeneration: number;
  readonly sessionId: string;
  readonly sessionGeneration: number;
  readonly targetId: string;
  readonly targetRevision: string;
  readonly operationId: string;
  readonly queueItemId: string;
  readonly childTaskId: string;
  readonly childSessionId: string;
  readonly parentTaskId?: string;
  readonly parentWorkspaceTaskId?: string;
  readonly sourceWorkspaceRoot: string;
  readonly state: "reserved" | "active" | "releasing" | "released" | "preserved";
  readonly writerRetired: boolean;
  readonly lease?: WorktreeLease;
}
export class ManagedChildWorktreeOwner {
  readonly #store: OperationalStore;
  readonly #worktrees: () => SessionWorktreeCoordinator;
  readonly #service: EphemeralWorktreeService;
  readonly #currentBackend: (id: string) => { readonly generation: number; readonly available: boolean };
  #initialized = false;
  #closed = false;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: {
    readonly store: OperationalStore;
    readonly worktrees: () => SessionWorktreeCoordinator;
    readonly storageRoot: string;
    readonly currentBackend: (id: string) => { readonly generation: number; readonly available: boolean };
  }) {
    this.#store = options.store;
    this.#worktrees = options.worktrees;
    this.#service = new EphemeralWorktreeService({ storageRoot: options.storageRoot });
    this.#currentBackend = options.currentBackend;
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    // A service restart does not prove any old native writer has exited. The
    // private child registry never adopts Product Session sweep semantics.
    const initialized = await this.#service.initialize({ preserveUnclaimed: true });
    if (!initialized.ok) throw new Error("The managed child workspace registry could not be opened.");
    this.#initialized = true;
    for (const setting of this.#store.listSettings("service", SCOPE)) {
      const record = this.#read(setting.key);
      if (record.state === "releasing" && record.writerRetired && record.lease !== undefined) {
        await this.#release(record).catch(() => undefined);
      }
    }
  }

  prepare(input: ClaudeManagedChildWorkspaceInput): Promise<ClaudeManagedChildWorkspace> {
    const result = this.#tail.catch(() => undefined).then(() => this.#prepare(input));
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async #prepare(input: ClaudeManagedChildWorkspaceInput): Promise<ClaudeManagedChildWorkspace> {
    if (!this.#initialized || this.#closed) throw new Error("The managed child workspace owner is unavailable.");
    input.signal.throwIfAborted();
    const context = input.context;
    if (context.operationId === undefined || context.backendInstanceGeneration === undefined || context.runtimePolicy !== undefined
      || context.target.remoteWorkspace !== undefined || !context.target.trusted) throw new Error("This invocation has no local child worktree authority.");
    if (!/^[A-Za-z0-9_-]{1,256}$/u.test(input.childTaskId) || !/^[A-Za-z0-9_-]{1,256}$/u.test(input.childSessionId)) throw new Error("The native child identity is invalid.");
    const target = this.#store.getTarget(context.target.id);
    const session = this.#store.getSession(context.sessionId).descriptor;
    const queue = this.#findQueue(context.sessionId, context.operationId);
    if (queue === undefined || queue.backendInstanceGeneration !== context.backendInstanceGeneration) throw new Error("The child workspace has no exact dispatch owner.");
    const ownerId = `child-${createHash("sha256").update(JSON.stringify([context.target.backendId, context.backendInstanceGeneration,
      context.sessionId, context.generation, context.operationId, input.childTaskId, input.childSessionId])).digest("hex")}`;
    const existing = this.#store.findSetting("service", SCOPE, ownerId);
    if (existing !== undefined) throw new Error("The native child already has a durable workspace reservation.");
    const record: ChildWorkspaceRecord = { version: 1, ownerId, backendId: context.target.backendId,
      backendGeneration: context.backendInstanceGeneration, sessionId: context.sessionId, sessionGeneration: context.generation,
      targetId: target.descriptor.id, targetRevision: target.revision.toString(), operationId: context.operationId, queueItemId: queue.id,
      childTaskId: input.childTaskId, childSessionId: input.childSessionId,
      ...(input.parentTaskId === undefined ? {} : { parentTaskId: input.parentTaskId }),
      ...(input.parentWorkspaceTaskId === undefined ? {} : { parentWorkspaceTaskId: input.parentWorkspaceTaskId }),
      sourceWorkspaceRoot: resolve(input.sourceWorkspaceRoot), state: "reserved", writerRetired: false };
    const assertParent = () => {
      input.signal.throwIfAborted();
      this.#assertAuthority(record);
      if (session.binding.opaqueRef !== context.binding?.opaqueRef || session.binding.nativeSessionId !== context.binding?.nativeSessionId) throw new Error("The native parent binding changed.");
    };
    assertParent();
    let parentLease: WorktreeLease | undefined;
    if (input.parentWorkspaceTaskId !== undefined) {
      const parent = this.#store.listSettings("service", SCOPE).map(setting => this.#read(setting.key)).find(candidate =>
        candidate.sessionId === record.sessionId && candidate.operationId === record.operationId && candidate.childTaskId === input.parentWorkspaceTaskId);
      if (parent === undefined || parent.state !== "active" || parent.writerRetired || parent.lease?.path !== record.sourceWorkspaceRoot) throw new Error("The nested native child source is not owned.");
      parentLease = parent.lease;
      this.#assertAuthority(parent);
      this.#assertLease(parent);
    } else {
      const effective = this.#worktrees().effectiveTarget(this.#store.getSession(record.sessionId));
      if (resolve(effective.workspaceRoot) !== record.sourceWorkspaceRoot || resolve(context.target.workspaceRoot) !== record.sourceWorkspaceRoot) throw new Error("The root child source does not match the current workspace.");
      if (session.worktree !== undefined) {
        parentLease = this.#worktrees().activeSourceLease(record.sessionId, session.worktree);
        if (parentLease === undefined) throw new Error("The Product worktree source lease is unavailable.");
      }
    }
    const assertSource = () => {
      assertParent();
      if (input.parentWorkspaceTaskId !== undefined) {
        const parent = this.#store.listSettings("service", SCOPE).map(setting => this.#read(setting.key)).find(candidate => candidate.childTaskId === input.parentWorkspaceTaskId && candidate.sessionId === record.sessionId && candidate.operationId === record.operationId);
        if (parent === undefined || parent.state !== "active" || parent.writerRetired || parent.lease?.id !== parentLease?.id) throw new Error("The nested child source lease changed.");
        this.#assertAuthority(parent);
        this.#assertLease(parent);
      } else if (session.worktree !== undefined && this.#worktrees().activeSourceLease(record.sessionId, session.worktree)?.id !== parentLease?.id) {
        throw new Error("The Product source checkout authority changed.");
      }
    };
    // This reservation is committed before the worktree package's own durable
    // creating record and before the first Git mutation.
    this.#save(record);
    const acquisition = parentLease === undefined
      ? await this.#service.deriveFromCheckout({ sessionId: ownerId, sourceSessionId: record.sessionId, sourceCwd: record.sourceWorkspaceRoot }, { signal: input.signal })
      : await this.#service.deriveFromOwnedCheckout(ownerId, parentLease, assertSource, { signal: input.signal });
    if (!acquisition.ok) throw new Error("The isolated native child checkout could not be created.");
    const active: ChildWorkspaceRecord = { ...record, state: "active", lease: acquisition.value.lease };
    this.#save(active);
    assertSource();
    const assertCurrent = () => {
      input.signal.throwIfAborted();
      this.#assertAuthority(active);
      this.#assertLease(active);
      if (this.#read(ownerId).state !== "active") throw new Error("The native child workspace is no longer active.");
    };
    const verify = async (signal: AbortSignal) => {
      signal.throwIfAborted();
      assertCurrent();
      const inspection = await this.#service.previewRemoval({ sessionId: ownerId, leaseId: active.lease!.id }, { signal });
      if (!inspection.ok || inspection.value.state !== "active") throw new Error("The native child checkout identity could not be verified.");
      assertCurrent();
    };
    return { workspaceRoot: active.lease!.path, branch: active.lease!.branch, assertCurrent, verify,
      release: async retirement => {
        if (retirement.writerRetired !== true) throw new Error("The native writer retirement is unconfirmed.");
        const current = this.#read(ownerId);
        if (current.childSessionId !== active.childSessionId || current.lease?.id !== active.lease?.id) throw new Error("The retiring native child workspace owner changed.");
        const releasing = { ...current, state: "releasing" as const, writerRetired: true };
        this.#save(releasing);
        return this.#release(releasing);
      } };
  }

  async #release(record: ChildWorkspaceRecord): Promise<"released" | "preserved"> {
    if (!record.writerRetired || record.lease === undefined) return "preserved";
    const lease = record.lease;
    const inspection = await this.#service.previewRemoval({ sessionId: record.ownerId, leaseId: lease.id });
    if (!inspection.ok && await lstat(lease.path).then(() => false, error => (error as NodeJS.ErrnoException).code === "ENOENT")) {
      const absent = await this.#service.releaseExact({ sessionId: record.ownerId, leaseId: lease.id, path: lease.path,
        repositoryRoot: lease.repositoryRoot, branch: lease.branch, source: lease.source, acquiredAt: lease.acquiredAt });
      if (absent.ok && absent.value.status !== "preserved") { this.#save({ ...record, state: "released" }); return "released"; }
    }
    const detection = await this.#service.detectCwd(lease.path);
    if (!inspection.ok || inspection.value.dirty || !detection.ok || detection.value.headCommit !== lease.source.commit) {
      this.#save({ ...record, state: "preserved" });
      return "preserved";
    }
    const released = await this.#service.releaseExact({ sessionId: record.ownerId, leaseId: lease.id, path: lease.path,
      repositoryRoot: lease.repositoryRoot, branch: lease.branch, source: lease.source, acquiredAt: lease.acquiredAt });
    if (!released.ok || released.value.status === "preserved") {
      this.#save({ ...record, state: "preserved" });
      return "preserved";
    }
    this.#save({ ...record, state: "released" });
    return "released";
  }

  #assertAuthority(record: ChildWorkspaceRecord): void {
    if (this.#closed) throw new Error("The managed child workspace owner is closed.");
    const session = this.#store.getSession(record.sessionId).descriptor;
    const target = this.#store.getTarget(record.targetId);
    const backend = this.#currentBackend(record.backendId);
    const queue = this.#store.getQueueItem(record.queueItemId);
    this.#store.getOperation(record.operationId);
    if (session.deletedAt !== undefined || session.archived || session.backendId !== record.backendId || session.targetId !== record.targetId
      || session.binding.generation !== record.sessionGeneration || session.remoteWorkspace !== undefined
      || target.descriptor.remoteWorkspace !== undefined || !target.descriptor.trusted || target.revision.toString() !== record.targetRevision
      || target.descriptor.backendId !== record.backendId || !backend.available || backend.generation !== record.backendGeneration
      || queue.sessionId !== record.sessionId || queue.operationId !== record.operationId || queue.backendInstanceGeneration !== record.backendGeneration) throw new Error("The native child workspace authority changed.");
  }
  #assertLease(record: ChildWorkspaceRecord): void {
    const lease = this.#service.snapshot().active.find(candidate => candidate.sessionId === record.ownerId);
    if (lease === undefined || operationBodyHash(lease) !== operationBodyHash(record.lease)) throw new Error("The exact native child checkout lease changed.");
  }
  #findQueue(sessionId: string, operationId: string) {
    for (let offset = 0; offset < 256_000; offset += 1_000) {
      const items = this.#store.listQueueItems({ sessionId, offset, limit: 1_000 });
      const queue = items.find(item => item.operationId === operationId);
      if (queue !== undefined) return queue;
      if (items.length < 1_000) return undefined;
    }
    return undefined;
  }
  #save(record: ChildWorkspaceRecord): void { this.#store.setSetting("service", SCOPE, record.ownerId, record); }
  #read(key: string): ChildWorkspaceRecord {
    const value = this.#store.getSetting<ChildWorkspaceRecord>("service", SCOPE, key).value;
    if (value?.version !== 1 || value.ownerId !== key || !/^child-[a-f0-9]{64}$/u.test(key)
      || typeof value.childSessionId !== "string" || typeof value.writerRetired !== "boolean") throw new Error("The native child workspace receipt is invalid.");
    return value;
  }
  close(): void { this.#closed = true; this.#service.dispose(); }
}
