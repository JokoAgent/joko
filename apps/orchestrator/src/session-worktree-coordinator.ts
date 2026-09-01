import { resolve } from "node:path";

import type { SessionWorktreeBinding, TargetDescriptor } from "@joko/core";
import type { OperationalStore, StoredSession } from "@joko/store";
import {
  EphemeralWorktreeService,
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
        ...scheduledOwnerSessionIds.filter((sessionId) => !archivedSessionIdSet.has(sessionId))
      ])],
      preserveSessionIds: archivedSessionIds
    });
    if (!initialized.ok) throw new SessionWorktreeCoordinatorError(initialized.error.code);
    const active = new Map(this.#service.snapshot().active.map((lease) => [lease.sessionId, lease]));
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
      if (lease === undefined || lease.id !== binding.leaseId
        || resolve(lease.path) !== resolve(binding.path)
        || resolve(lease.repositoryRoot) !== resolve(binding.repositoryRoot)
        || lease.branch !== binding.branch
        || lease.source.ref !== binding.sourceRef
        || lease.source.commit !== binding.sourceCommit
        || lease.source.strategy !== binding.sourceStrategy
        || lease.source.refreshed !== binding.sourceRefreshed
        || lease.source.remote !== binding.sourceRemote) {
        if (binding.state !== "preserved") {
          this.#store.updateSessionWorktreeState(session.descriptor.id, "preserved");
        }
        continue;
      }
      if (binding.state !== "active") this.#store.updateSessionWorktreeState(session.descriptor.id, "active");
      await this.#registerWorkspace(session, { ...binding, state: "active" });
    }
    this.#initialized = true;
  }

  async probe(target: TargetDescriptor): Promise<TargetWorktreeProbe> {
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
    const now = Date.now();
    const binding: SessionWorktreeBinding = {
      leaseId: result.value.lease.id,
      workspaceId: workspaceIdFor(input.sessionId),
      path: result.value.lease.path,
      repositoryRoot: result.value.lease.repositoryRoot,
      branch: result.value.lease.branch,
      sourceRef: result.value.lease.source.ref,
      sourceCommit: result.value.lease.source.commit,
      sourceStrategy: result.value.lease.source.strategy,
      sourceRefreshed: result.value.lease.source.refreshed,
      ...(result.value.lease.source.remote === undefined ? {} : { sourceRemote: result.value.lease.source.remote }),
      state: "active",
      acquiredAt: result.value.lease.acquiredAt,
      updatedAt: now
    };
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
    return binding;
  }

  effectiveTarget(session: StoredSession): TargetDescriptor {
    const target = this.#store.getTarget(session.descriptor.targetId).descriptor;
    const worktree = session.descriptor.worktree;
    if (worktree === undefined) return target;
    if (worktree.state !== "active") throw new SessionWorktreeCoordinatorError("SESSION_CONFLICT");
    return { ...target, workspaceRoot: worktree.path };
  }

  async release(sessionId: string): Promise<void> {
    this.#requireInitialized();
    const result = await this.#service.release(sessionId);
    if (!result.ok) throw new SessionWorktreeCoordinatorError(result.error.code);
    const session = this.#store.listSessions({ includeArchived: true, includeDeleted: true })
      .find((candidate) => candidate.descriptor.id === sessionId);
    const binding = session?.descriptor.worktree;
    this.#workspaces.unregister(binding?.workspaceId ?? workspaceIdFor(sessionId));
    // Once a lease is released it must never remain projected as active.
    if (binding !== undefined && binding.state !== "preserved") {
      this.#store.updateSessionWorktreeState(sessionId, "preserved");
    }
  }

  async archive(sessionId: string): Promise<void> {
    this.#requireInitialized();
    const session = this.#store.getSession(sessionId);
    const binding = session.descriptor.worktree;
    if (binding === undefined) return;
    const result = await this.#service.release(sessionId, { retainForRestore: true });
    if (!result.ok) throw new SessionWorktreeCoordinatorError(result.error.code);
    if (result.value.status !== "preserved" || result.value.reason !== "restorable"
      || result.value.pathRemoved !== true) {
      throw new SessionWorktreeCoordinatorError("SESSION_CONFLICT");
    }
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
    if (lease.id !== binding.leaseId
      || resolve(lease.path) !== resolve(binding.path)
      || resolve(lease.repositoryRoot) !== resolve(binding.repositoryRoot)
      || lease.branch !== binding.branch
      || lease.source.ref !== binding.sourceRef
      || lease.source.commit !== binding.sourceCommit
      || lease.source.strategy !== binding.sourceStrategy
      || lease.source.refreshed !== binding.sourceRefreshed
      || lease.source.remote !== binding.sourceRemote) {
      await this.#service.release(sessionId, { retainForRestore: true }).catch(() => undefined);
      throw new SessionWorktreeCoordinatorError("SESSION_CONFLICT");
    }
    try {
      await this.#registerWorkspace(session, { ...binding, state: "active" });
      if (binding.state !== "active") this.#store.updateSessionWorktreeState(sessionId, "active");
    } catch (error) {
      this.#workspaces.unregister(binding.workspaceId);
      await this.#service.release(sessionId, { retainForRestore: true }).catch(() => undefined);
      throw error;
    }
  }

  dispose(): void {
    this.#service.dispose();
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
    if (!this.#initialized) throw new Error("The isolated workspace coordinator is not initialized.");
  }
}

function workspaceIdFor(sessionId: string): string {
  return `worktree-${sessionId}`;
}

function probeEligibility(code: WorktreeErrorCode): TargetWorktreeEligibility {
  if (code === "NOT_GIT_REPOSITORY") return "not_git_repository";
  if (code === "CWD_IS_WORKTREE") return "already_linked";
  if (code === "GIT_NOT_FOUND" || code === "DISPOSED" || code === "NOT_INITIALIZED") return "unavailable";
  return "unsafe";
}
