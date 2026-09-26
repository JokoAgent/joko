import { resolve } from "node:path";

import type { SessionWorktreeBinding, TargetDescriptor } from "@joko/core";
import type { OperationalStore, StoredSession } from "@joko/store";
import {
  EphemeralWorktreeService,
  type WorktreeCallOptions,
  type WorktreeErrorCode,
  type WorktreeSourceOption
} from "@joko/worktree";

import type { WorkspaceService } from "./workspace-service.js";

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
}

export interface SessionWorktreeRemovalPreview {
  readonly hasWorktree: boolean;
  readonly dirty: boolean;
}

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
  readonly #activeBindings = new Map<string, SessionWorktreeBinding>();
  #initialized = false;

  constructor(options: {
    readonly store: OperationalStore;
    readonly workspaces: WorkspaceService;
    readonly storageRoot: string;
    readonly service?: EphemeralWorktreeService;
  }) {
    this.#store = options.store;
    this.#workspaces = options.workspaces;
    this.#service = options.service ?? new EphemeralWorktreeService({ storageRoot: options.storageRoot });
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    const sessions = this.#store.listSessions({ includeArchived: true, includeDeleted: false })
      .filter((session) => session.descriptor.worktree !== undefined);
    const scheduledOwnerSessionIds = this.#store.listSettings("service")
      .filter((setting) => setting.key === SCHEDULED_WORKTREE_OWNER_SETTING_KEY)
      .map((setting) => setting.scopeId);
    const pendingDerivationSessionIds = this.#store.listUnadoptedNativeSessionDerivations()
      .map((record) => record.sessionId);
    const liveSessionIds = sessions
      .filter((session) => !session.descriptor.archived)
      .map((session) => session.descriptor.id);
    const archivedSessionIds = sessions
      .filter((session) => session.descriptor.archived)
      .map((session) => session.descriptor.id);
    const archivedSessionIdSet = new Set(archivedSessionIds);
    const initialized = await this.#service.initialize({
      retainSessionIds: [...new Set([
        ...liveSessionIds,
        ...scheduledOwnerSessionIds.filter((sessionId) => !archivedSessionIdSet.has(sessionId)),
        ...pendingDerivationSessionIds
      ])],
      preserveSessionIds: archivedSessionIds
    });
    if (!initialized.ok) throw new SessionWorktreeCoordinatorError(initialized.error.code);
    const active = new Map(this.#service.snapshot().active.map((lease) => [lease.sessionId, lease]));
    this.#activeBindings.clear();
    for (const lease of active.values()) {
      this.#activeBindings.set(lease.sessionId, worktreeBindingFor(lease.sessionId, lease));
    }
    for (const session of sessions) {
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
      if (record.worktree === undefined) continue;
      const lease = active.get(record.sessionId);
      if (lease !== undefined && sameLease(lease, record.worktree)) {
        this.#activeBindings.set(record.sessionId, record.worktree);
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

  effectiveTarget(session: StoredSession): TargetDescriptor {
    const target = this.#store.getTarget(session.descriptor.targetId).descriptor;
    const worktree = session.descriptor.worktree;
    if (worktree === undefined) return target;
    if (worktree.state !== "active") throw new SessionWorktreeCoordinatorError("SESSION_CONFLICT");
    return { ...target, workspaceRoot: worktree.path };
  }

  activeWorkspacePath(sessionId: string, expectedBinding: SessionWorktreeBinding): string | undefined {
    if (!this.#initialized) return undefined;
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

  async archive(sessionId: string): Promise<void> {
    this.#requireInitialized();
    const session = this.#store.getSession(sessionId);
    const binding = session.descriptor.worktree;
    if (binding === undefined) return;
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
    const target = this.#store.getTarget(session.descriptor.targetId).descriptor;
    await this.#workspaces.register({
      id: binding.workspaceId,
      root: binding.path,
      displayName: `${session.descriptor.title} · ${binding.branch}`,
      trusted: target.trusted
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
  return binding.workspaceId === workspaceIdFor(lease.sessionId)
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
  return left.leaseId === right.leaseId
    && left.workspaceId === right.workspaceId
    && resolve(left.path) === resolve(right.path)
    && resolve(left.repositoryRoot) === resolve(right.repositoryRoot)
    && left.branch === right.branch
    && left.sourceRef === right.sourceRef
    && left.sourceCommit === right.sourceCommit
    && left.sourceStrategy === right.sourceStrategy
    && left.sourceRefreshed === right.sourceRefreshed
    && left.sourceRemote === right.sourceRemote
    && left.state === right.state
    && left.acquiredAt === right.acquiredAt
    && left.updatedAt === right.updatedAt;
}

function probeEligibility(code: WorktreeErrorCode): TargetWorktreeEligibility {
  if (code === "NOT_GIT_REPOSITORY") return "not_git_repository";
  if (code === "CWD_IS_WORKTREE") return "already_linked";
  if (code === "GIT_NOT_FOUND") return "git_not_found";
  if (code === "DISPOSED" || code === "NOT_INITIALIZED") return "unavailable";
  return "unsafe";
}
