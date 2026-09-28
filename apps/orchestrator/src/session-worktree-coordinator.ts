import { resolve } from "node:path";

import type { SessionWorktreeBinding, TargetDescriptor } from "@joko/core";
import { operationBodyHash, type OperationalStore, type StoredSession, type StoredTarget } from "@joko/store";
import type { RemoteGitCheckoutInspection, RemoteGitCheckoutLease, RemoteGitCheckoutPlan } from "@joko/remote-ssh";
import {
  EphemeralWorktreeService,
  type WorktreeCallOptions,
  type WorktreeErrorCode,
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

  constructor(options: {
    readonly store: OperationalStore;
    readonly workspaces: WorkspaceService;
    readonly storageRoot: string;
    readonly service?: EphemeralWorktreeService;
    readonly remoteOwner?: RemoteWorktreeOwnerPort;
  }) {
    this.#store = options.store;
    this.#workspaces = options.workspaces;
    this.#service = options.service ?? new EphemeralWorktreeService({ storageRoot: options.storageRoot });
    this.#remoteOwner = options.remoteOwner;
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    const sessions = this.#store.listSessions({ includeArchived: true, includeDeleted: false })
      .filter((session) => session.descriptor.worktree !== undefined);
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
    if (worktree === undefined) return target;
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
    return { ...target, workspaceRoot: worktree.path };
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

  async release(sessionId: string, expectedBinding?: SessionWorktreeBinding): Promise<void> {
    this.#requireInitialized();
    const session = this.#store.listSessions({ includeArchived: true, includeDeleted: true })
      .find((candidate) => candidate.descriptor.id === sessionId);
    const persistedBinding = session?.descriptor.worktree;
    const binding = expectedBinding ?? persistedBinding ?? this.#activeBindings.get(sessionId);
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
      if (expectedBinding !== undefined) {
        if (binding.state !== "active"
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
    if (!result.ok) throw new SessionWorktreeCoordinatorError(result.error.code);
    if (expectedBinding !== undefined && result.value.status === "preserved") {
      throw new SessionWorktreeCoordinatorError("SESSION_CONFLICT");
    }
    this.#activeBindings.delete(sessionId);
    this.#workspaces.unregister(binding?.workspaceId ?? workspaceIdFor(sessionId));
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
      root: binding.path,
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
