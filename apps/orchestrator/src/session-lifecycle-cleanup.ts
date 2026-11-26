import { Code, ConnectError } from "@connectrpc/connect";
import { redactSecrets } from "@joko/core";
import type { SessionLifecycleCleanupRecord } from "@joko/store";
import type { ConnectServiceDependencies } from "./connect-services.js";
import { readPersonalDevelopmentPurpose } from "./personal-development-purpose.js";

type CleanupDependencies = Pick<ConnectServiceDependencies, "store" | "sessionHost" | "sessionWorktrees" | "gitSafety" | "now" | "personalDevelopment"> & {
  readonly terminals?: Pick<NonNullable<ConnectServiceDependencies["terminals"]>, "closeSession">;
};

export async function advanceSessionLifecycleCleanup(
  dependencies: CleanupDependencies,
  initial: SessionLifecycleCleanupRecord
): Promise<SessionLifecycleCleanupRecord> {
  let cleanup = initial;
  const advance = (phase: "close" | "native" | "worktree" | "git_safety") => {
    cleanup = dependencies.store.advanceSessionLifecycleCleanup({
      operationId: cleanup.operationId,
      phase,
      at: (dependencies.now ?? Date.now)()
    });
  };
  try {
    for (const child of dependencies.store.prepareDependentSideChatCleanups(cleanup, (dependencies.now ?? Date.now)())) {
      await advanceSessionLifecycleCleanup(dependencies, child);
    }
    if (!cleanup.closeCompleted) {
      await dependencies.sessionHost.prepareSessionLifecycleClose(
        cleanup.sessionId,
        cleanup.disposition
      );
      await dependencies.sessionHost.closeIfActive(cleanup.sessionId);
      await dependencies.terminals?.closeSession(cleanup.sessionId);
      advance("close");
    }
    if (!cleanup.nativeCompleted) {
      await dependencies.sessionHost.deleteNativeSession(cleanup.sessionId, cleanup.operationId);
      advance("native");
    }
    if (readPersonalDevelopmentPurpose(dependencies.store, cleanup.sessionId) !== undefined) {
      const personal = dependencies.personalDevelopment?.();
      if (personal === undefined) throw new ConnectError("Personal task cleanup is unavailable.", Code.FailedPrecondition);
      cleanup = await personal.settleSessionLifecycle(cleanup);
    }
    if (!cleanup.worktreeCompleted) {
      const session = dependencies.store.getSession(cleanup.sessionId);
      const worktree = session.descriptor.worktree;
      if (worktree !== undefined) {
        if (dependencies.sessionWorktrees === undefined) {
          throw new ConnectError("Isolated workspace cleanup is unavailable.", Code.FailedPrecondition);
        }
        if (cleanup.disposition === "archive") {
          if (worktree.state === "active") await dependencies.sessionWorktrees.archive(cleanup.sessionId);
        } else {
          await dependencies.sessionWorktrees.release(cleanup.sessionId);
        }
      }
      advance("worktree");
    }
    if (!cleanup.gitSafetyCompleted) {
      await dependencies.gitSafety?.closeSession(cleanup.sessionId);
      advance("git_safety");
    }
    return cleanup;
  } catch (error) {
    dependencies.store.recordSessionLifecycleCleanupFailure({
      operationId: cleanup.operationId,
      message: redactSecrets(error instanceof Error ? error.message : "Task lifecycle cleanup failed."),
      at: (dependencies.now ?? Date.now)()
    });
    throw error;
  }
}
