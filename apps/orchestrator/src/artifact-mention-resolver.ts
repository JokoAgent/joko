import type { AdapterContext, ArtifactMentionResolver, TargetDescriptor } from "@joko/core";
import { operationBodyHash, type OperationalStore, type StoredSession } from "@joko/store";
import type { ArtifactStore } from "./artifact-store.js";

/** Resolves canonical task artifacts without treating a client string as a path. */
export function createArtifactMentionResolver(options: {
  readonly store: OperationalStore;
  readonly artifacts: Pick<ArtifactStore, "resolveBlobPath">;
  readonly resolveTarget: (session: StoredSession) => TargetDescriptor;
  readonly assertBackendCurrent: (context: AdapterContext) => void;
  readonly now?: () => number;
}): ArtifactMentionResolver {
  const now = options.now ?? Date.now;
  return async (artifactId, context, signal) => {
    if (artifactId.length === 0 || artifactId.length > 1_024 || /[\u0000-\u001f\u007f]/u.test(artifactId)) throw unavailable();
    const originalTarget = options.store.getTarget(context.target.id);
    const originalArtifact = options.store.getArtifact(artifactId);
    const originalWorktree = operationBodyHash(options.store.getSession(context.sessionId).descriptor.worktree ?? null);
    const assertCurrent = (): void => {
      signal.throwIfAborted();
      context.signal.throwIfAborted();
      options.assertBackendCurrent(context);
      const session = options.store.getSession(context.sessionId);
      const target = options.store.getTarget(context.target.id);
      const effectiveTarget = options.resolveTarget(session);
      if (context.runtimePolicy === "review_read_only" || session.descriptor.deletedAt !== undefined || session.descriptor.archived
        || session.descriptor.id !== context.sessionId || session.descriptor.binding.generation !== context.generation
        || context.binding === undefined || session.descriptor.binding.opaqueRef !== context.binding.opaqueRef
        || operationBodyHash(session.descriptor.worktree ?? null) !== originalWorktree
        || (session.descriptor.worktree !== undefined && session.descriptor.worktree.state !== "active")
        || session.descriptor.backendId !== context.target.backendId || session.descriptor.targetId !== context.target.id
        || target.revision !== originalTarget.revision || effectiveTarget.id !== context.target.id
        || effectiveTarget.backendId !== context.target.backendId || effectiveTarget.workspaceRoot !== context.target.workspaceRoot
        || effectiveTarget.trusted !== context.target.trusted || context.target.remoteWorkspace !== undefined
        || session.descriptor.remoteWorkspace !== undefined) throw unavailable();
      const artifact = options.store.getArtifact(artifactId);
      const metadata = artifact.metadata as { readonly expiresAt?: unknown } | null;
      const expiresAt = metadata !== null && typeof metadata === "object" ? metadata.expiresAt : undefined;
      if (artifact.sessionId !== context.sessionId || artifact.revision !== originalArtifact.revision
        || artifact.storageKey !== originalArtifact.storageKey || artifact.deletedAt !== undefined
        || (expiresAt !== undefined && (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || expiresAt <= now()))) {
        throw unavailable();
      }
    };
    assertCurrent();
    const path = await options.artifacts.resolveBlobPath(originalArtifact.blob);
    assertCurrent();
    return { blob: originalArtifact.blob, path, assertCurrent };
  };
}

function unavailable(): Error {
  return new Error("The canonical Artifact is unavailable in the original task authority.");
}
