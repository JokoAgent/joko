import type { SessionWorktreeBinding } from "@joko/core";
import type { OperationalStore } from "@joko/store";
import type { SessionWorktreeRecycleSafetyCheck } from "./session-worktree-coordinator.js";

/** A durable native close receipt, rather than process absence, grants cleanup. */
export function createWorktreeRecycleSafetyCheck(options: {
  readonly store: OperationalStore;
  readonly sessionHost: { isSessionActive(sessionId: string): boolean };
  readonly terminals: { closeSession(sessionId: string): Promise<void> };
}): SessionWorktreeRecycleSafetyCheck {
  return async (sessionId, binding) => {
    const inspect = () => {
      const session = options.store.getSession(sessionId);
      const cleanup = options.store.findLatestSessionLifecycleCleanup(sessionId);
      if (cleanup === undefined || !cleanup.releaseWorktree || !cleanup.closeCompleted || !cleanup.nativeCompleted
        || options.sessionHost.isSessionActive(sessionId) || !sameBinding(session.descriptor.worktree, binding)) return undefined;
      if (cleanup.state === "pending") return cleanup.worktreeCompleted ? undefined : { session, cleanup };
      // A restored task cannot reuse its former retirement receipt. Metadata
      // edits do not grant a new writer and do not block retained-tree recovery.
      if ((!session.descriptor.archived && session.descriptor.deletedAt === undefined)
        || cleanup.createdAt < binding.acquiredAt) return undefined;
      return { session, cleanup };
    };
    const before = inspect();
    if (before === undefined) return false;
    await options.terminals.closeSession(sessionId);
    const after = inspect();
    return after !== undefined && after.session.revision === before.session.revision
      && after.cleanup.operationId === before.cleanup.operationId && after.cleanup.revision === before.cleanup.revision;
  };
}

function sameBinding(actual: SessionWorktreeBinding | undefined, expected: SessionWorktreeBinding): boolean {
  return actual !== undefined && actual.remote === undefined && expected.remote === undefined
    && actual.leaseId === expected.leaseId && actual.workspaceId === expected.workspaceId && actual.path === expected.path
    && actual.repositoryRoot === expected.repositoryRoot && actual.branch === expected.branch && actual.acquiredAt === expected.acquiredAt;
}
