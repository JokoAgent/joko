import { realpath } from "node:fs/promises";
import { readWorkerWorkspaceBinding, workerWorkspaceTarget, WORKER_WORKSPACE_PLAN_KEY, WORKER_WORKSPACE_BINDING_KEY,
  type WorkerWorkspaceBinding, type WorkerWorkspacePlan } from "./collaboration-worker-workspace.js";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { SessionWorktreeBinding, TargetDescriptor } from "@joko/core";
import { operationBodyHash, type OperationalStore, type StoredSession, type StoredTarget } from "@joko/store";
import type { RemoteGitCheckoutInspection, RemoteGitCheckoutLease, RemoteGitCheckoutPlan } from "@joko/remote-ssh";
import {
  EphemeralWorktreeService,
  type WorktreeCallOptions,
  type WorktreeErrorCode,
  type WorktreeLease,
  type WorktreeRecycleControl,
  type WorktreeRecycleRecord,
  type WorktreeSourceOption
} from "@joko/worktree";

import type { WorkspaceService } from "./workspace-service.js";
import {
  remoteBindingFromLease,
  remoteLeaseFromBinding,
  type RemoteClaudeWorktreeOwner
} from "./remote-claude-worktree-owner.js";

/** Service-scoped durable owner marker written before a scheduled Adapter
 * creation effect. Keeping the key here lets startup retain an otherwise
 * pre-Session lease until SessionHost can reconcile it safely. */
export const SCHEDULED_WORKTREE_OWNER_SETTING_KEY = "scheduler.ephemeral-worktree-owner";

export type TargetWorktreeEligibility =
  | "eligible"
  | "not_git_repository"
  | "already_linked"
  | "git_not_found"
  | "unsafe"
  | "unavailable";

export interface TargetWorktreeProbe {
  readonly targetId: string;
  readonly eligibility: TargetWorktreeEligibility;
  readonly repositoryRoot?: string;
  readonly currentBranch?: string;
  readonly headCommit?: string;
  readonly canRefreshRemote: boolean;
}

export interface AcquireSessionWorktreeInput {
  readonly sessionId: string;
  readonly target: TargetDescriptor;
  readonly sourceRef?: string;
  readonly refreshRemote?: boolean;
}

export interface DeriveSessionWorktreeInput {
  readonly sessionId: string;
  readonly sourceSessionId: string;
  readonly signal?: AbortSignal;
}

export interface SessionWorktreeRemovalPreview {
  readonly hasWorktree: boolean;
  readonly dirty: boolean;
}

export interface SessionWorktreeRecycleRecord extends Omit<WorktreeRecycleRecord, "lease" | "retainForRestore"> {
  readonly sessionId: string;
  readonly displayName: string;
  readonly pathDisplay: string;
}

export type SessionWorktreeRecycleSafetyCheck = (sessionId: string, binding: SessionWorktreeBinding) => Promise<boolean>;

type RemoteWorktreeOwnerPort = Pick<RemoteClaudeWorktreeOwner,
  "plan" | "derive" | "inspectExact" | "cleanupPending" | "assertExact" | "releaseExact">;

export class SessionWorktreeCoordinatorError extends Error {
  readonly code: WorktreeErrorCode;

  constructor(code: WorktreeErrorCode) {
    super("The isolated workspace operation could not be completed safely.");
    this.name = "SessionWorktreeCoordinatorError";
    this.code = code;
  }
}

/** Owns the cross-store lifecycle for Session-scoped isolated workspaces. */
export class SessionWorktreeCoordinator {
  readonly #store: OperationalStore;
  readonly #workspaces: WorkspaceService;
  readonly #service: EphemeralWorktreeService;
  readonly #remoteOwner: RemoteWorktreeOwnerPort | undefined;
  readonly #activeBindings = new Map<string, SessionWorktreeBinding>();
  #initialized = false;
  #recycleSafetyCheck: SessionWorktreeRecycleSafetyCheck | undefined;
  #recycleTimer: ReturnType<typeof setTimeout> | undefined;
  #recycleFlight: Promise<void> | undefined;
  #recycleStopped = false;
  readonly #recycleAbort = new AbortController();
  readonly #recycleWake = new Set<string>();

  constructor(options: {
    readonly store: OperationalStore;
    readonly workspaces: WorkspaceService;
    readonly storageRoot: string;
    readonly service?: EphemeralWorktreeService;
    readonly remoteOwner?: RemoteWorktreeOwnerPort;
  }) {
    this.#store = options.store;
    this.#workspaces = options.workspaces;
    this.#service = options.service ?? new EphemeralWorktreeService({ storageRoot: options.storageRoot, recycle: true });
    this.#remoteOwner = options.remoteOwner;
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    const sessions = this.#store.listSessions({ includeArchived: true, includeDeleted: false })
      .filter((session) => session.descriptor.worktree !== undefined);
    for (const session of this.#store.listSessions({ includeArchived: false, includeDeleted: false })) {
      const binding = readWorkerWorkspaceBinding(this.#store, session.descriptor.id);
      if (binding) await this.registerWorkerWorkspace(binding, session.descriptor.title,
        this.#store.getTarget(session.descriptor.targetId).descriptor.trusted);
    }
    const localSessions = sessions.filter((session) => session.descriptor.worktree?.remote === undefined);
    const remoteSessions = sessions.filter((session) => session.descriptor.worktree?.remote !== undefined);
    const scheduledOwnerSessionIds = this.#store.listSettings("service")
      .filter((setting) => setting.key === SCHEDULED_WORKTREE_OWNER_SETTING_KEY)
      .map((setting) => setting.scopeId);
    const pendingDerivationSessionIds = this.#store.listUnadoptedNativeSessionDerivations()
      .filter((record) => record.worktree?.remote === undefined && record.remoteWorktreePlan === undefined)
      .map((record) => record.sessionId);
    const pendingReplacementSessions = this.#store.listPendingPortableReplacementCleanups()
      .filter((record) => record.worktreeState === "pending")
      .map((record) => this.#store.getSession(record.replacedSessionId))
      .filter((session) => session.descriptor.worktree?.remote === undefined);
    const pendingReplacementActiveSessionIds = pendingReplacementSessions
      .filter((session) => session.descriptor.worktree?.state === "active")
      .map((session) => session.descriptor.id);
    const pendingReplacementPreservedSessionIds = pendingReplacementSessions
      .filter((session) => session.descriptor.worktree?.state === "preserved")
      .map((session) => session.descriptor.id);
    const liveSessionIds = localSessions
      .filter((session) => !session.descriptor.archived)
      .map((session) => session.descriptor.id);
    const archivedSessionIds = localSessions
      .filter((session) => session.descriptor.archived)
      .map((session) => session.descriptor.id);
    const archivedSessionIdSet = new Set(archivedSessionIds);
    const initialized = await this.#service.initialize({
      preserveUnclaimed: true,
      deferRecycle: true,
      retainSessionIds: [...new Set([
        ...liveSessionIds,
        ...scheduledOwnerSessionIds.filter((sessionId) => !archivedSessionIdSet.has(sessionId)),
        ...pendingDerivationSessionIds,
        ...pendingReplacementActiveSessionIds
      ])],
      preserveSessionIds: [...archivedSessionIds, ...pendingReplacementPreservedSessionIds]
    });
    if (!initialized.ok) throw new SessionWorktreeCoordinatorError(initialized.error.code);
    const active = new Map(this.#service.snapshot().active.map((lease) => [lease.sessionId, lease]));
    this.#activeBindings.clear();
    for (const lease of active.values()) {
      this.#activeBindings.set(lease.sessionId, worktreeBindingFor(lease.sessionId, lease));
    }
    for (const session of localSessions) {
      const binding = session.descriptor.worktree!;
      if (this.#store.findPendingSessionLifecycleCleanup(session.descriptor.id) !== undefined) {
        this.#activeBindings.delete(session.descriptor.id);
        this.#workspaces.unregister(binding.workspaceId);
        continue;
      }
      if (session.descriptor.archived) {
        this.#workspaces.unregister(binding.workspaceId);
        if (binding.state !== "preserved") {
          this.#store.updateSessionWorktreeState(session.descriptor.id, "preserved");
        }
        continue;
      }
      const lease = active.get(session.descriptor.id);
      if (lease === undefined || !sameLease(lease, { ...binding, state: "active" })) {
        if (binding.state !== "preserved") {
          this.#store.updateSessionWorktreeState(session.descriptor.id, "preserved");
        }
        continue;
      }
      if (binding.state !== "active") this.#store.updateSessionWorktreeState(session.descriptor.id, "active");
      const activeBinding = this.#store.getSession(session.descriptor.id).descriptor.worktree!;
      this.#activeBindings.set(session.descriptor.id, activeBinding);
      await this.#registerWorkspace(session, activeBinding);
    }
    for (const record of this.#store.listUnadoptedNativeSessionDerivations()) {
      if (record.worktree === undefined || record.worktree.remote !== undefined) continue;
      const lease = active.get(record.sessionId);
      if (lease !== undefined && sameLease(lease, record.worktree)) {
        this.#activeBindings.set(record.sessionId, record.worktree);
      }
    }
    if (this.#remoteOwner !== undefined) {
      for (const session of remoteSessions) {
        const binding = session.descriptor.worktree!;
        if (session.descriptor.archived || binding.state !== "active") {
          this.#workspaces.unregister(binding.workspaceId);
          continue;
        }
        try {
          await this.#remoteOwner.assertExact(session.descriptor.id, binding);
          await this.#registerWorkspace(session, binding);
          this.#activeBindings.set(session.descriptor.id, binding);
        } catch {
          // An unavailable remote inspection leaves the durable lease intact.
          // A later explicit authority check can recover the registration.
        }
      }
      for (const record of this.#store.listUnadoptedNativeSessionDerivations()) {
        if (record.worktree?.remote === undefined || record.worktree.state !== "active") continue;
        try {
          await this.#remoteOwner.assertExact(record.sessionId, record.worktree);
          this.#activeBindings.set(record.sessionId, record.worktree);
        } catch {
          // Keep the Store receipt for an exact retry; never infer preservation.
        }
      }
    }
    this.#initialized = true;
  }

  async probe(target: TargetDescriptor): Promise<TargetWorktreeProbe> {
    if (target.remoteWorkspace !== undefined) {
      return { targetId: target.id, eligibility: "unavailable", canRefreshRemote: false };
    }
    const result = await this.#service.detectCwd(target.workspaceRoot);
    if (!result.ok) {
      return {
        targetId: target.id,
        eligibility: probeEligibility(result.error.code),
        canRefreshRemote: false
      };
    }
    return {
      targetId: target.id,
      eligibility: result.value.isLinkedWorktree ? "already_linked" : "eligible",
      repositoryRoot: result.value.repositoryRoot,
      ...(result.value.currentBranch === undefined ? {} : { currentBranch: result.value.currentBranch }),
      headCommit: result.value.headCommit,
      canRefreshRemote: !result.value.isLinkedWorktree
    };
  }

  async listSources(target: TargetDescriptor): Promise<readonly WorktreeSourceOption[]> {
    const result = await this.#service.listSources(target.workspaceRoot);
    if (!result.ok) throw new SessionWorktreeCoordinatorError(result.error.code);
    return result.value;
  }

  async acquire(input: AcquireSessionWorktreeInput): Promise<SessionWorktreeBinding> {
    this.#requireInitialized();
    const result = await this.#service.acquire({
      sessionId: input.sessionId,
      cwd: input.target.workspaceRoot,
      ...(input.sourceRef === undefined ? {} : { sourceRef: input.sourceRef }),
      refreshRemote: input.refreshRemote === true
    });
    if (!result.ok) throw new SessionWorktreeCoordinatorError(result.error.code);
    const binding = worktreeBindingFor(input.sessionId, result.value.lease);
    try {
      await this.#workspaces.register({
        id: binding.workspaceId,
        root: binding.path,
        displayName: `${input.target.displayName} · ${binding.branch}`,
        trusted: input.target.trusted
      });
    } catch (error) {
      await this.#service.release(input.sessionId).catch(() => undefined);
      throw error;
    }
    this.#activeBindings.set(input.sessionId, binding);
    return binding;
  }

  async derive(input: DeriveSessionWorktreeInput): Promise<SessionWorktreeBinding> {
    this.#requireInitialized();
    const source = this.#store.getSession(input.sourceSessionId);
    const sourceBinding = source.descriptor.worktree;
    if (sourceBinding === undefined || sourceBinding.state !== "active") {
      throw new SessionWorktreeCoordinatorError("SESSION_CONFLICT");
    }
    const activeLease = this.#service.snapshot().active.find((lease) => lease.sessionId === input.sourceSessionId);
    if (activeLease === undefined || !sameLease(activeLease, sourceBinding)) {
      throw new SessionWorktreeCoordinatorError("SESSION_CONFLICT");
    }
    const result = await this.#service.derive({
      sessionId: input.sessionId,
      sourceSessionId: input.sourceSessionId,
      sourceLeaseId: sourceBinding.leaseId
    });
    if (!result.ok) throw new SessionWorktreeCoordinatorError(result.error.code);
    const binding = worktreeBindingFor(input.sessionId, result.value.lease);
    const target = this.#store.getTarget(source.descriptor.targetId).descriptor;
    try {
      await this.#workspaces.register({
        id: binding.workspaceId,
        root: binding.path,
        displayName: `${target.displayName} · ${binding.branch}`,
        trusted: target.trusted
      });
    } catch (error) {
      await this.#service.release(input.sessionId).catch(() => undefined);
      throw error;
    }
    this.#activeBindings.set(input.sessionId, binding);
    return binding;
  }

  async deriveFromCheckout(input: DeriveSessionWorktreeInput): Promise<SessionWorktreeBinding | undefined> {
    this.#requireInitialized();
    const source = this.#store.getSession(input.sourceSessionId);
    if (source.descriptor.worktree !== undefined) {
      throw new SessionWorktreeCoordinatorError("SESSION_CONFLICT");
    }
    const target = this.#store.getTarget(source.descriptor.targetId).descriptor;
    if (source.descriptor.remoteWorkspace !== undefined || target.remoteWorkspace !== undefined) return undefined;
    const detection = await this.#service.detectCwd(target.workspaceRoot);
    if (!detection.ok) {
      const eligibility = probeEligibility(detection.error.code);
      if (eligibility === "not_git_repository") return undefined;
      throw new SessionWorktreeCoordinatorError(detection.error.code);
    }
    if (detection.value.isLinkedWorktree) {
      throw new SessionWorktreeCoordinatorError("CWD_IS_WORKTREE");
    }
    const result = await this.#service.deriveFromCheckout({
      sessionId: input.sessionId,
      sourceSessionId: input.sourceSessionId,
      sourceCwd: target.workspaceRoot
    });
    if (!result.ok) throw new SessionWorktreeCoordinatorError(result.error.code);
    const binding = worktreeBindingFor(input.sessionId, result.value.lease);
    try {
      await this.#workspaces.register({
        id: binding.workspaceId,
        root: binding.path,
        displayName: `${target.displayName} · ${binding.branch}`,
        trusted: target.trusted
      });
    } catch (error) {
      await this.#service.release(input.sessionId).catch(() => undefined);
      throw error;
    }
    this.#activeBindings.set(input.sessionId, binding);
    return binding;
  }

  /** Read-only remote source probe. The returned full plan must be written to
   * the derivation receipt before acquirePlannedRemoteDerivation is called. */
  async planRemoteDerivation(input: DeriveSessionWorktreeInput): Promise<RemoteGitCheckoutPlan | undefined> {
    this.#requireInitialized();
    const owner = this.#requireRemoteOwner();
    const source = this.#store.getSession(input.sourceSessionId);
    const target = this.#store.getTarget(source.descriptor.targetId);
    const remote = target.descriptor.remoteWorkspace;
    const sourceRemote = source.descriptor.remoteWorkspace;
    if (remote === undefined || sourceRemote === undefined || !sameRemoteWorkspace(sourceRemote, remote)) {
      throw new SessionWorktreeCoordinatorError("SESSION_CONFLICT");
    }
    const sourceBinding = source.descriptor.worktree;
    const sourceLease = sourceBinding === undefined
      ? undefined
      : remoteLeaseFromBinding(input.sourceSessionId, sourceBinding);
    if (sourceBinding !== undefined) await this.assertActiveRemoteWorktree(input.sourceSessionId, sourceBinding);
    return owner.plan({
      target,
      sessionId: input.sessionId,
      sourceSessionId: input.sourceSessionId,
      workspaceId: workspaceIdFor(input.sessionId),
      sourceCwd: sourceBinding?.path ?? remote.workspaceRoot,
      ...(sourceLease === undefined ? {} : { sourceLease }),
      ...(input.signal === undefined ? {} : { signal: input.signal })
    });
  }

  async acquirePlannedRemoteDerivation(plan: RemoteGitCheckoutPlan): Promise<SessionWorktreeBinding> {
    this.#requireInitialized();
    this.#assertDurableRemotePlan(plan);
    const lease = await this.#requireRemoteOwner().derive(plan);
    const binding = remoteBindingFromLease(plan.workspaceId, lease);
    if (!remoteBindingMatchesPlan(binding, plan)) {
      throw new SessionWorktreeCoordinatorError("SESSION_CONFLICT");
    }
    const target = this.#store.getTarget(plan.authority.targetId);
    await this.#registerRemoteWorkspace(target, binding, `${target.descriptor.displayName} · ${binding.branch}`);
    this.#activeBindings.set(plan.sessionId, binding);
    return binding;
  }

  async inspectPlannedRemoteDerivation(plan: RemoteGitCheckoutPlan): Promise<RemoteGitCheckoutInspection> {
    this.#requireInitialized();
    this.#assertDurableRemotePlan(plan);
    return this.#requireRemoteOwner().inspectExact(plan);
  }

  async cleanupPendingRemoteDerivation(plan: RemoteGitCheckoutPlan): Promise<"absent" | "released" | "preserved"> {
    this.#requireInitialized();
    this.#assertDurableRemotePlan(plan);
    const outcome = await this.#requireRemoteOwner().cleanupPending(plan);
    if (outcome !== "preserved") {
      this.#activeBindings.delete(plan.sessionId);
      this.#workspaces.unregister(plan.workspaceId);
    }
    return outcome;
  }

  async releasePlannedRemoteDerivation(
    plan: RemoteGitCheckoutPlan,
    lease: RemoteGitCheckoutLease
  ): Promise<"released" | "preserved"> {
    this.#requireInitialized();
    this.#assertDurableRemotePlan(plan);
    const binding = remoteBindingFromLease(plan.workspaceId, lease);
    if (!remoteBindingMatchesPlan(binding, plan)) {
      throw new SessionWorktreeCoordinatorError("SESSION_CONFLICT");
    }
    const outcome = await this.#requireRemoteOwner().releaseExact(plan.sessionId, binding);
    if (outcome === "released") {
      this.#activeBindings.delete(plan.sessionId);
      this.#workspaces.unregister(plan.workspaceId);
    }
    return outcome;
  }

  /** Prove the remote manifest and checkout under current SSH authority. */
  async assertActiveRemoteWorktree(sessionId: string, expectedBinding: SessionWorktreeBinding): Promise<string> {
    this.#requireInitialized();
    if (expectedBinding.remote === undefined || expectedBinding.state !== "active"
      || expectedBinding.workspaceId !== workspaceIdFor(sessionId)
      || !this.#hasDurableRemoteBinding(sessionId, expectedBinding)) {
      throw new SessionWorktreeCoordinatorError("SESSION_CONFLICT");
    }
    await this.#requireRemoteOwner().assertExact(sessionId, expectedBinding);
    const target = this.#store.getTarget(expectedBinding.remote.targetId);
    if (!this.#workspaces.listRegistrations().some((registration) =>
      registration.id === expectedBinding.workspaceId)) {
      await this.#registerRemoteWorkspace(target, expectedBinding, `${target.descriptor.displayName} · ${expectedBinding.branch}`);
    }
    this.#activeBindings.set(sessionId, expectedBinding);
    return expectedBinding.path;
  }

  #assertDurableRemotePlan(plan: RemoteGitCheckoutPlan): void {
    const receipt = this.#store.listUnadoptedNativeSessionDerivations().find((record) =>
      record.sessionId === plan.sessionId && record.remoteWorktreePlan !== undefined
      && operationBodyHash(record.remoteWorktreePlan) === operationBodyHash(plan));
    if (receipt === undefined) throw new SessionWorktreeCoordinatorError("SESSION_CONFLICT");
  }

  #hasDurableRemoteBinding(sessionId: string, expectedBinding: SessionWorktreeBinding): boolean {
    const session = this.#store.listSessions({ includeArchived: true, includeDeleted: true })
      .find((candidate) => candidate.descriptor.id === sessionId);
    if (session?.descriptor.worktree !== undefined
      && samePersistedBinding(session.descriptor.worktree, expectedBinding)) return true;
    return this.#store.listUnadoptedNativeSessionDerivations().some((record) =>
      record.sessionId === sessionId && record.worktree !== undefined
      && samePersistedBinding(record.worktree, expectedBinding));
  }

  #requireRemoteOwner(): RemoteWorktreeOwnerPort {
    if (this.#remoteOwner === undefined) throw new SessionWorktreeCoordinatorError("SESSION_CONFLICT");
    return this.#remoteOwner;
  }

  effectiveTarget(session: StoredSession): TargetDescriptor {
    const target = this.#store.getTarget(session.descriptor.targetId).descriptor;
    const worktree = session.descriptor.worktree;
    if (worktree === undefined) return workerWorkspaceTarget(this.#store, session.descriptor, target);
    if (worktree.state !== "active") throw new SessionWorktreeCoordinatorError("SESSION_CONFLICT");
    if (worktree.remote !== undefined) {
      if (target.remoteWorkspace === undefined || worktree.remote.targetId !== target.id
        || !sameRemoteWorkspace(worktree.remote.binding, target.remoteWorkspace)) {
        throw new SessionWorktreeCoordinatorError("SESSION_CONFLICT");
      }
      return {
        ...target,
        workspaceRoot: worktree.path,
        remoteWorkspace: { ...target.remoteWorkspace, workspaceRoot: worktree.path }
      };
    }
    return workerWorkspaceTarget(this.#store, session.descriptor, { ...target, workspaceRoot: worktree.path });
  }

  async registerWorkerWorkspace(binding: WorkerWorkspaceBinding, displayName: string, trusted: boolean): Promise<void> {
    await this.#workspaces.register({ id: binding.workspaceId, root: binding.path, displayName, trusted });
  }

  unregisterWorkerWorkspace(sessionId: string): void {
    const binding = readWorkerWorkspaceBinding(this.#store, sessionId);
    if (binding) this.#workspaces.unregister(binding.workspaceId);
  }

  #workerReferencesLease(leaseId: string): boolean {
    return this.#store.listSettings("service").some(setting => {
      if (setting.key === WORKER_WORKSPACE_BINDING_KEY) {
        const session = this.#store.findSession(setting.scopeId)?.descriptor;
        if (session?.derivationOrigin?.sideChat !== true || session.deletedAt !== undefined) return false;
        const binding = readWorkerWorkspaceBinding(this.#store, session.id);
        return binding?.owner === "side_chat" && binding.inheritedWorktreeLeaseId === leaseId;
      }
      if (setting.key !== WORKER_WORKSPACE_PLAN_KEY) return false;
      const plan = setting.value as WorkerWorkspacePlan;
      if (plan.format !== 1 || plan.createWorktree || plan.inherited?.worktreeLeaseId !== leaseId) return false;
      const worker = this.#store.findCollaborationWorker(setting.scopeId);
      if (!worker) return false;
      if (worker.sessionId) { const session = this.#store.findSession(worker.sessionId); return session !== undefined && session.descriptor.deletedAt === undefined; }
      return worker.status === "provisioning" || worker.status === "dispatch_unknown";
    });
  }

  activeWorkspacePath(sessionId: string, expectedBinding: SessionWorktreeBinding): string | undefined {
    if (!this.#initialized) return undefined;
    if (expectedBinding.remote !== undefined) return undefined;
    const authoritativeBinding = this.#activeBindings.get(sessionId);
    if (authoritativeBinding === undefined || !samePersistedBinding(authoritativeBinding, expectedBinding)) {
      return undefined;
    }
    const lease = this.#service.snapshot().active.find((candidate) => candidate.sessionId === sessionId);
    if (lease === undefined || !sameLease(lease, expectedBinding)) return undefined;
    return lease.path;
  }

  /** Private exact source lease for an independently owned child checkout. */
  activeSourceLease(sessionId: string, expectedBinding: SessionWorktreeBinding) {
    if (this.activeWorkspacePath(sessionId, expectedBinding) === undefined) return undefined;
    return this.#service.snapshot().active.find(lease => lease.sessionId === sessionId && lease.id === expectedBinding.leaseId);
  }

  async previewRemoval(
    sessionId: string,
    options?: WorktreeCallOptions
  ): Promise<SessionWorktreeRemovalPreview> {
    this.#requireInitialized();
    const session = this.#store.getSession(sessionId);
    const binding = session.descriptor.worktree;
    if (binding === undefined) return Object.freeze({ hasWorktree: false, dirty: false });
    if (binding.remote !== undefined) {
      await this.assertActiveRemoteWorktree(sessionId, binding);
      // The remote checkout owner does not expose a read-only dirty preview.
      // Treat it as dirty so a removal never promises a clean discard.
      return Object.freeze({ hasWorktree: true, dirty: true });
    }
    const result = await this.#service.previewRemoval({ sessionId, leaseId: binding.leaseId }, options);
    if (!result.ok) throw new SessionWorktreeCoordinatorError(result.error.code);
    if (result.value.state !== binding.state) {
      throw new SessionWorktreeCoordinatorError("SESSION_CONFLICT");
    }
    return Object.freeze({ hasWorktree: true, dirty: result.value.dirty });
  }

  listRecycleStatus(): readonly SessionWorktreeRecycleRecord[] {
    this.#requireInitialized();
    return this.#service.listRecycleStatus().flatMap(record => {
      const session = this.#recycleSession(record);
      if (session === undefined) return [];
      return [{
        id: record.id, generation: record.generation, sessionId: session.descriptor.id,
        displayName: session.descriptor.title, pathDisplay: record.lease.path,
        state: record.state, reason: record.reason, failures: record.failures,
        nextAttemptAt: record.nextAttemptAt
      }];
    });
  }

  async controlRecycle(input: WorktreeRecycleControl, options?: WorktreeCallOptions): Promise<SessionWorktreeRecycleRecord | undefined> {
    this.#requireInitialized();
    const record = this.#service.listRecycleStatus().find(candidate => candidate.id === input.id);
    if (record === undefined || this.#recycleSession(record) === undefined) {
      throw new SessionWorktreeCoordinatorError("SOURCE_NOT_FOUND");
    }
    const controlled = await this.#service.controlRecycle(input, options);
    if (!controlled.ok) throw new SessionWorktreeCoordinatorError(controlled.error.code);
    if (input.action === "retry") {
      this.#recycleWake.add(record.lease.sessionId);
      await this.#runRecycleMaintenance();
    }
    this.#scheduleRecycleMaintenance();
    return this.listRecycleStatus().find(candidate => candidate.id === input.id);
  }

  /** Starts only after native owners and terminal cleanup are available. */
  startRecycleMaintenance(canRecycle: SessionWorktreeRecycleSafetyCheck): Promise<void> {
    this.#requireInitialized();
    this.#recycleSafetyCheck = canRecycle;
    for (const record of this.#service.listRecycleStatus()) this.#recycleWake.add(record.lease.sessionId);
    return this.#runRecycleMaintenance();
  }

  notifyRecycleOpportunity(sessionId?: string): void {
    if (this.#recycleStopped) return;
    if (sessionId === undefined) {
      for (const record of this.#service.listRecycleStatus()) this.#recycleWake.add(record.lease.sessionId);
    } else this.#recycleWake.add(sessionId);
    this.#scheduleRecycleMaintenance(100);
  }

  #recycleSession(record: WorktreeRecycleRecord): StoredSession | undefined {
    const session = this.#store.listSessions({ includeArchived: true, includeDeleted: true })
      .find(candidate => candidate.descriptor.id === record.lease.sessionId);
    const binding = session?.descriptor.worktree;
    if (session === undefined || binding === undefined || binding.remote !== undefined
      || !sameLease(record.lease, { ...binding, state: "active" })) return undefined;
    if (this.#store.findSetting("service", session.descriptor.id, SCHEDULED_WORKTREE_OWNER_SETTING_KEY) !== undefined) return undefined;
    const cleanup = this.#store.findPendingSessionLifecycleCleanup(session.descriptor.id);
    const ownsLifecycle = cleanup !== undefined && cleanup.releaseWorktree
      && !cleanup.worktreeCompleted && (cleanup.disposition === "archive") === record.retainForRestore;
    if (!session.descriptor.archived && session.descriptor.deletedAt === undefined && !ownsLifecycle) return undefined;
    return session;
  }

  async #canRecycle(lease: WorktreeLease, retainForRestore: boolean): Promise<boolean> {
    if (this.#recycleStopped) return false;
    const record = this.#service.listRecycleStatus().find(candidate => candidate.id === lease.id);
    if (record === undefined || record.retainForRestore !== retainForRestore) return false;
    const session = this.#recycleSession(record);
    if (session === undefined || this.#recycleSafetyCheck === undefined) return false;
    const safeReferences = (): boolean => {
      const current = this.#recycleSession(record);
      if (current === undefined) return false;
      if (this.#workerReferencesLease(lease.id)) return false;
      const cleanup = this.#store.findPendingSessionLifecycleCleanup(lease.sessionId);
      if (cleanup !== undefined && (!cleanup.closeCompleted || !cleanup.nativeCompleted)) return false;
      if (this.#store.listRuns({ sessionId: lease.sessionId, activeOnly: true, limit: 1 }).length > 0) return false;
      if (this.#store.listSettings("service").some(setting => setting.key === SCHEDULED_WORKTREE_OWNER_SETTING_KEY
        && setting.scopeId === lease.sessionId)) return false;
      if (this.#store.listUnadoptedNativeSessionDerivations().some(derivation =>
        derivation.sessionId === lease.sessionId || derivation.sourceSessionId === lease.sessionId)) return false;
      if (this.#store.listPendingPortableReplacementCleanups().some(replacement =>
        replacement.replacedSessionId === lease.sessionId && replacement.nativeState !== "completed")) return false;
      return !this.#store.listSessions({ includeArchived: true, includeDeleted: true }).some(other => {
        if (other.descriptor.id === lease.sessionId || other.descriptor.deletedAt !== undefined || other.descriptor.archived) return false;
        const otherBinding = other.descriptor.worktree;
        if (otherBinding?.remote !== undefined) return false;
        const target = this.#store.getTarget(other.descriptor.targetId).descriptor;
        if (target.remoteWorkspace !== undefined) return false;
        return localPathWithin(lease.path, readWorkerWorkspaceBinding(this.#store, other.descriptor.id)?.path ?? otherBinding?.path ?? target.workspaceRoot);
      });
    };
    if (!safeReferences() || await this.#hasPhysicalLiveReference(lease)) return false;
    let retired = false;
    try { retired = await this.#recycleSafetyCheck(lease.sessionId, session.descriptor.worktree!); }
    catch { return false; }
    return retired && !this.#recycleStopped && safeReferences() && !await this.#hasPhysicalLiveReference(lease);
  }

  async #hasPhysicalLiveReference(lease: WorktreeLease): Promise<boolean> {
    try {
      const root = await physicalPath(lease.path);
      for (const other of this.#store.listSessions({ includeArchived: false, includeDeleted: false })) {
        if (other.descriptor.id === lease.sessionId || other.descriptor.worktree?.remote !== undefined) continue;
        const target = this.#store.getTarget(other.descriptor.targetId).descriptor;
        if (target.remoteWorkspace !== undefined) continue;
        if (localPathWithin(root, await physicalPath(readWorkerWorkspaceBinding(this.#store, other.descriptor.id)?.path ?? other.descriptor.worktree?.path ?? target.workspaceRoot))) return true;
      }
      return false;
    } catch { return true; }
  }

  #runRecycleMaintenance(): Promise<void> {
    if (this.#recycleFlight !== undefined) return this.#recycleFlight;
    if (this.#recycleStopped || this.#recycleSafetyCheck === undefined) return Promise.resolve();
    if (this.#recycleTimer !== undefined) clearTimeout(this.#recycleTimer);
    this.#recycleTimer = undefined;
    const wake = new Set(this.#recycleWake);
    this.#recycleWake.clear();
    const task = (async () => {
      for (const record of this.#service.listRecycleStatus()) {
        if (this.#recycleStopped || record.state === "kept" || record.state === "paused"
          || record.state === "waiting" && !wake.has(record.lease.sessionId)
          || record.nextAttemptAt > Date.now() && !wake.has(record.lease.sessionId)
          || this.#recycleSession(record) === undefined) continue;
        const result = await this.#service.retryRecycle(record, (lease, retain) => this.#canRecycle(lease, retain), { signal: this.#recycleAbort.signal });
        if (!this.#recycleStopped && result.ok && result.value.pathRemoved === true && record.retainForRestore) {
          const session = this.#recycleSession(record);
          if (session !== undefined) {
            const binding = session.descriptor.worktree!;
            this.#activeBindings.delete(session.descriptor.id);
            this.#workspaces.unregister(binding.workspaceId);
            if (binding.state !== "preserved") this.#store.updateSessionWorktreeState(session.descriptor.id, "preserved");
          }
        }
      }
    })().finally(() => {
      this.#recycleFlight = undefined;
      this.#scheduleRecycleMaintenance();
    });
    this.#recycleFlight = task;
    return task;
  }

  #scheduleRecycleMaintenance(delayMs?: number): void {
    if (this.#recycleStopped || this.#recycleSafetyCheck === undefined) return;
    if (this.#recycleTimer !== undefined) {
      if (delayMs === undefined) return;
      clearTimeout(this.#recycleTimer);
      this.#recycleTimer = undefined;
    }
    const eligible = this.#service.listRecycleStatus().filter(record => record.state !== "kept" && record.state !== "paused"
      && this.#recycleSession(record) !== undefined);
    if (eligible.length === 0) return;
    // A bounded metadata opportunity observes writer releases in other processes.
    // Reference waits never consume the removal failure budget.
    const delay = delayMs ?? Math.max(100, Math.min(...eligible.map(record =>
      record.state === "waiting" ? 30_000 : Math.max(0, record.nextAttemptAt - Date.now()))));
    this.#recycleTimer = setTimeout(() => {
      this.#recycleTimer = undefined;
      for (const record of this.#service.listRecycleStatus()) {
        if (record.state === "waiting") this.#recycleWake.add(record.lease.sessionId);
      }
      void this.#runRecycleMaintenance().catch(() => undefined);
    }, delay);
    this.#recycleTimer.unref();
  }

  async release(sessionId: string, expectedBinding?: SessionWorktreeBinding, options?: { readonly retiredCleanupOperationId: string }): Promise<void> {
    this.#requireInitialized();
    const session = this.#store.listSessions({ includeArchived: true, includeDeleted: true })
      .find((candidate) => candidate.descriptor.id === sessionId);
    const persistedBinding = session?.descriptor.worktree;
    const binding = expectedBinding ?? persistedBinding ?? this.#activeBindings.get(sessionId);
    if (binding?.remote === undefined && binding && this.#workerReferencesLease(binding.leaseId)) {
      if (expectedBinding) throw new SessionWorktreeCoordinatorError("SESSION_CONFLICT");
      const retained = await this.#service.release(sessionId, { retainForRestore: true }, async lease =>
        lease.id === binding.leaseId && !this.#workerReferencesLease(lease.id));
      if (!retained.ok) throw new SessionWorktreeCoordinatorError(retained.error.code);
      if (retained.value.status !== "preserved"
        || retained.value.pathRemoved === true && this.#workerReferencesLease(binding.leaseId)) {
        throw new SessionWorktreeCoordinatorError("SESSION_CONFLICT");
      }
      this.#activeBindings.delete(sessionId);
      this.#workspaces.unregister(binding.workspaceId);
      if (persistedBinding && persistedBinding.state !== "preserved") this.#store.updateSessionWorktreeState(sessionId, "preserved");
      this.notifyRecycleOpportunity(sessionId);
      return;
    }
    if (binding?.remote !== undefined) {
      if (binding.state !== "active" || !this.#hasDurableRemoteBinding(sessionId, binding)
        || (persistedBinding !== undefined && !samePersistedBinding(persistedBinding, binding))) {
        throw new SessionWorktreeCoordinatorError("SESSION_CONFLICT");
      }
      const outcome = await this.#requireRemoteOwner().releaseExact(sessionId, binding);
      if (outcome === "preserved") throw new SessionWorktreeCoordinatorError("SESSION_CONFLICT");
      this.#activeBindings.delete(sessionId);
      this.#workspaces.unregister(binding.workspaceId);
      if (persistedBinding !== undefined && persistedBinding.state !== "preserved") {
        this.#store.updateSessionWorktreeState(sessionId, "preserved");
      }
      return;
    }
    let result: Awaited<ReturnType<EphemeralWorktreeService["release"]>>;
    if (binding !== undefined) {
      const authoritativeBinding = this.#activeBindings.get(sessionId);
      if (persistedBinding !== undefined && !samePersistedBinding(persistedBinding, binding)) {
        throw new SessionWorktreeCoordinatorError("SESSION_CONFLICT");
      }
      const pendingCleanup = this.#store.findPendingSessionLifecycleCleanup(sessionId);
      if (expectedBinding === undefined && pendingCleanup?.disposition === "delete"
        && pendingCleanup.closeCompleted && pendingCleanup.nativeCompleted
        && pendingCleanup.releaseWorktree && !pendingCleanup.worktreeCompleted) {
        result = await this.#service.releaseExact({
          sessionId, leaseId: binding.leaseId, path: binding.path, repositoryRoot: binding.repositoryRoot,
          branch: binding.branch,
          source: {
            ref: binding.sourceRef, commit: binding.sourceCommit, strategy: binding.sourceStrategy,
            refreshed: binding.sourceRefreshed,
            ...(binding.sourceRemote === undefined ? {} : { remote: binding.sourceRemote })
          }, acquiredAt: binding.acquiredAt
        });
      } else if (expectedBinding !== undefined) {
        const retiredCleanup = options === undefined ? undefined : this.#store.findSessionLifecycleCleanup(options.retiredCleanupOperationId);
        const canReconcileReleased = retiredCleanup?.sessionId === sessionId && retiredCleanup.state === "pending"
          && retiredCleanup.closeCompleted && retiredCleanup.nativeCompleted && retiredCleanup.releaseWorktree && !retiredCleanup.worktreeCompleted;
        if (binding.state !== "active" && !canReconcileReleased
          || (authoritativeBinding !== undefined && !samePersistedBinding(authoritativeBinding, binding))) {
          throw new SessionWorktreeCoordinatorError("SESSION_CONFLICT");
        }
        result = await this.#service.releaseExact({
          sessionId,
          leaseId: binding.leaseId,
          path: binding.path,
          repositoryRoot: binding.repositoryRoot,
          branch: binding.branch,
          source: {
            ref: binding.sourceRef,
            commit: binding.sourceCommit,
            strategy: binding.sourceStrategy,
            refreshed: binding.sourceRefreshed,
            ...(binding.sourceRemote === undefined ? {} : { remote: binding.sourceRemote })
          },
          acquiredAt: binding.acquiredAt
        });
      } else if (binding.state === "active") {
        const activeLease = this.#service.snapshot().active
          .find((candidate) => candidate.sessionId === sessionId);
        if (authoritativeBinding === undefined
          || !samePersistedBinding(authoritativeBinding, binding)
          || activeLease === undefined
          || !sameLease(activeLease, binding)) {
          throw new SessionWorktreeCoordinatorError("SESSION_CONFLICT");
        }
        result = await this.#service.release(sessionId);
      } else {
        if (persistedBinding === undefined) {
          throw new SessionWorktreeCoordinatorError("SESSION_CONFLICT");
        }
        const preview = await this.#service.previewRemoval({ sessionId, leaseId: binding.leaseId });
        if (!preview.ok) throw new SessionWorktreeCoordinatorError(preview.error.code);
        if (preview.value.state !== "preserved") {
          throw new SessionWorktreeCoordinatorError("SESSION_CONFLICT");
        }
        result = await this.#service.release(sessionId);
      }
    } else {
      result = await this.#service.release(sessionId);
    }
    this.notifyRecycleOpportunity(sessionId);
    if (!result.ok) throw new SessionWorktreeCoordinatorError(result.error.code);
    if (expectedBinding !== undefined && result.value.status === "preserved") {
      throw new SessionWorktreeCoordinatorError("SESSION_CONFLICT");
    }
    this.#activeBindings.delete(sessionId);
    this.#workspaces.unregister(binding?.workspaceId ?? workspaceIdFor(sessionId));
    this.unregisterWorkerWorkspace(sessionId);
    // Once a lease is released it must never remain projected as active.
    if (persistedBinding !== undefined && binding !== undefined
      && samePersistedBinding(persistedBinding, binding)
      && persistedBinding.state !== "preserved") {
      this.#store.updateSessionWorktreeState(sessionId, "preserved");
    }
  }

  /** A deleted portable source retains its exact lease until native deletion is confirmed. */
  async releasePortableReplacement(operationId: string): Promise<void> {
    this.#requireInitialized();
    const receipt = this.#store.getPortableReplacementCleanup(operationId);
    if (receipt.nativeState !== "completed" || receipt.worktreeState !== "pending") {
      throw new SessionWorktreeCoordinatorError("SESSION_CONFLICT");
    }
    const session = this.#store.getSession(receipt.replacedSessionId);
    const binding = session.descriptor.worktree;
    if (session.descriptor.deletedAt === undefined || binding === undefined || binding.remote !== undefined) {
      throw new SessionWorktreeCoordinatorError("SESSION_CONFLICT");
    }
    const result = await this.#service.releaseExact({
      sessionId: receipt.replacedSessionId,
      leaseId: binding.leaseId,
      path: binding.path,
      repositoryRoot: binding.repositoryRoot,
      branch: binding.branch,
      source: {
        ref: binding.sourceRef,
        commit: binding.sourceCommit,
        strategy: binding.sourceStrategy,
        refreshed: binding.sourceRefreshed,
        ...(binding.sourceRemote === undefined ? {} : { remote: binding.sourceRemote })
      },
      acquiredAt: binding.acquiredAt
    });
    if (!result.ok) throw new SessionWorktreeCoordinatorError(result.error.code);
    if (result.value.status === "preserved") throw new SessionWorktreeCoordinatorError("SESSION_CONFLICT");
    this.#activeBindings.delete(receipt.replacedSessionId);
    this.#workspaces.unregister(binding.workspaceId);
    if (binding.state !== "preserved") {
      this.#store.updateSessionWorktreeState(receipt.replacedSessionId, "preserved");
    }
  }

  async archive(sessionId: string): Promise<void> {
    this.#requireInitialized();
    const session = this.#store.getSession(sessionId);
    const binding = session.descriptor.worktree;
    if (binding === undefined) return;
    if (binding.remote !== undefined) throw new SessionWorktreeCoordinatorError("SESSION_CONFLICT");
    if (this.activeWorkspacePath(sessionId, binding) === undefined) {
      throw new SessionWorktreeCoordinatorError("SESSION_CONFLICT");
    }
    const result = await this.#service.release(sessionId, { retainForRestore: true });
    this.notifyRecycleOpportunity(sessionId);
    if (!result.ok) throw new SessionWorktreeCoordinatorError(result.error.code);
    if (result.value.status !== "preserved" || result.value.reason !== "restorable"
      || result.value.pathRemoved !== true) {
      throw new SessionWorktreeCoordinatorError("SESSION_CONFLICT");
    }
    this.#activeBindings.delete(sessionId);
    this.#workspaces.unregister(binding.workspaceId);
    if (binding.state !== "preserved") this.#store.updateSessionWorktreeState(sessionId, "preserved");
  }

  async restore(sessionId: string): Promise<void> {
    this.#requireInitialized();
    const session = this.#store.getSession(sessionId);
    const binding = session.descriptor.worktree;
    if (binding === undefined) return;
    if (binding.remote !== undefined) throw new SessionWorktreeCoordinatorError("SESSION_CONFLICT");
    const result = await this.#service.acquire({
      sessionId,
      cwd: binding.repositoryRoot
    });
    if (!result.ok) throw new SessionWorktreeCoordinatorError(result.error.code);
    const lease = result.value.lease;
    if (!sameLease(lease, { ...binding, state: "active" })) {
      await this.#service.release(sessionId, { retainForRestore: true }).catch(() => undefined);
      throw new SessionWorktreeCoordinatorError("SESSION_CONFLICT");
    }
    try {
      await this.#registerWorkspace(session, { ...binding, state: "active" });
      if (binding.state !== "active") this.#store.updateSessionWorktreeState(sessionId, "active");
      this.#activeBindings.set(sessionId, this.#store.getSession(sessionId).descriptor.worktree!);
    } catch (error) {
      this.#workspaces.unregister(binding.workspaceId);
      await this.#service.release(sessionId, { retainForRestore: true }).catch(() => undefined);
      this.#activeBindings.delete(sessionId);
      throw error;
    }
  }

  dispose(): void {
    this.#recycleStopped = true;
    this.#recycleAbort.abort();
    if (this.#recycleTimer !== undefined) clearTimeout(this.#recycleTimer);
    this.#service.dispose();
    this.#activeBindings.clear();
  }

  async #registerWorkspace(session: StoredSession, binding: SessionWorktreeBinding): Promise<void> {
    const target = this.#store.getTarget(session.descriptor.targetId);
    if (binding.remote !== undefined) {
      await this.#registerRemoteWorkspace(target, binding, `${session.descriptor.title} · ${binding.branch}`);
      return;
    }
    await this.#workspaces.register({
      id: binding.workspaceId,
      root: readWorkerWorkspaceBinding(this.#store, session.descriptor.id)?.path ?? binding.path,
      displayName: `${session.descriptor.title} · ${binding.branch}`,
      trusted: target.descriptor.trusted
    });
  }

  async #registerRemoteWorkspace(target: StoredTarget, binding: SessionWorktreeBinding, displayName: string): Promise<void> {
    const remote = target.descriptor.remoteWorkspace;
    if (remote === undefined || binding.remote === undefined || binding.remote.targetId !== target.descriptor.id
      || binding.remote.targetRevision !== target.revision.toString()
      || !sameRemoteWorkspace(binding.remote.binding, remote)
      || binding.state !== "active") {
      throw new SessionWorktreeCoordinatorError("SESSION_CONFLICT");
    }
    await this.#workspaces.register({
      id: binding.workspaceId,
      root: binding.path,
      displayName,
      trusted: target.descriptor.trusted,
      remote: {
        targetId: target.descriptor.id,
        binding: { ...remote, workspaceRoot: binding.path }
      }
    });
  }

  #requireInitialized(): void {
    if (!this.#initialized) throw new SessionWorktreeCoordinatorError("NOT_INITIALIZED");
  }
}

function localPathWithin(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === "" || path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

async function physicalPath(value: string): Promise<string> {
  let cursor = resolve(value);
  const suffix: string[] = [];
  for (;;) {
    try { return join(await realpath(cursor), ...suffix); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(cursor) === cursor) throw error;
      suffix.unshift(basename(cursor)); cursor = dirname(cursor);
    }
  }
}

function workspaceIdFor(sessionId: string): string {
  return `worktree-${sessionId}`;
}

function worktreeBindingFor(
  sessionId: string,
  lease: ReturnType<EphemeralWorktreeService["snapshot"]>["active"][number]
): SessionWorktreeBinding {
  const now = Date.now();
  return {
    leaseId: lease.id,
    workspaceId: workspaceIdFor(sessionId),
    path: lease.path,
    repositoryRoot: lease.repositoryRoot,
    branch: lease.branch,
    sourceRef: lease.source.ref,
    sourceCommit: lease.source.commit,
    sourceStrategy: lease.source.strategy,
    sourceRefreshed: lease.source.refreshed,
    ...(lease.source.remote === undefined ? {} : { sourceRemote: lease.source.remote }),
    state: "active",
    acquiredAt: lease.acquiredAt,
    updatedAt: now
  };
}

function sameLease(
  lease: ReturnType<EphemeralWorktreeService["snapshot"]>["active"][number],
  binding: SessionWorktreeBinding
): boolean {
  return binding.remote === undefined
    && binding.workspaceId === workspaceIdFor(lease.sessionId)
    && binding.state === "active"
    && lease.id === binding.leaseId
    && resolve(lease.path) === resolve(binding.path)
    && resolve(lease.repositoryRoot) === resolve(binding.repositoryRoot)
    && lease.branch === binding.branch
    && lease.source.ref === binding.sourceRef
    && lease.source.commit === binding.sourceCommit
    && lease.source.strategy === binding.sourceStrategy
    && lease.source.refreshed === binding.sourceRefreshed
    && lease.source.remote === binding.sourceRemote
    && lease.acquiredAt === binding.acquiredAt;
}

function samePersistedBinding(left: SessionWorktreeBinding, right: SessionWorktreeBinding): boolean {
  if ((left.remote === undefined) !== (right.remote === undefined)) return false;
  const remote = left.remote !== undefined;
  return left.leaseId === right.leaseId
    && left.workspaceId === right.workspaceId
    && (remote ? left.path === right.path : resolve(left.path) === resolve(right.path))
    && (remote ? left.repositoryRoot === right.repositoryRoot
      : resolve(left.repositoryRoot) === resolve(right.repositoryRoot))
    && left.branch === right.branch
    && left.sourceRef === right.sourceRef
    && left.sourceCommit === right.sourceCommit
    && left.sourceStrategy === right.sourceStrategy
    && left.sourceRefreshed === right.sourceRefreshed
    && left.sourceRemote === right.sourceRemote
    && (remote ? operationBodyHash(left.remote) === operationBodyHash(right.remote) : true)
    && left.state === right.state
    && left.acquiredAt === right.acquiredAt
    && left.updatedAt === right.updatedAt;
}

function remoteBindingMatchesPlan(binding: SessionWorktreeBinding, plan: RemoteGitCheckoutPlan): boolean {
  return binding.remote !== undefined && binding.state === "active"
    && binding.workspaceId === plan.workspaceId && binding.leaseId === plan.leaseId
    && binding.path === plan.path && binding.repositoryRoot === plan.repositoryRoot
    && binding.branch === plan.branch && binding.sourceRef === plan.sourceRef
    && binding.sourceCommit === plan.sourceCommit && binding.sourceStrategy === plan.sourceStrategy
    && binding.sourceRefreshed === plan.sourceRefreshed
    && operationBodyHash(binding.remote) === operationBodyHash(plan.remote);
}

function sameRemoteWorkspace(
  left: NonNullable<TargetDescriptor["remoteWorkspace"]>,
  right: NonNullable<TargetDescriptor["remoteWorkspace"]>
): boolean {
  if (left.kind !== right.kind || left.workspaceRoot !== right.workspaceRoot) return false;
  return left.kind === "ssh" && right.kind === "ssh"
    ? left.hostTargetId === right.hostTargetId && left.hostId === right.hostId
    : left.kind === "device_peer" && right.kind === "device_peer"
      && left.controllerDeviceId === right.controllerDeviceId
      && left.targetDeviceId === right.targetDeviceId;
}

function probeEligibility(code: WorktreeErrorCode): TargetWorktreeEligibility {
  if (code === "NOT_GIT_REPOSITORY") return "not_git_repository";
  if (code === "CWD_IS_WORKTREE") return "already_linked";
  if (code === "GIT_NOT_FOUND") return "git_not_found";
  if (code === "DISPOSED" || code === "NOT_INITIALIZED") return "unavailable";
  return "unsafe";
}
