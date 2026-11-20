import type { ClaudeRemoteDerivationCleanup } from "@joko/adapter-claude-code";
import type { SessionWorktreeBinding, TargetDescriptor } from "@joko/core";
import { operationBodyHash, type OperationalStore, type StoredTarget } from "@joko/store";

import type { RemoteClaudeDerivedWorkspaceAuthority } from "./remote-claude-runtime.js";
import type { SessionWorktreeCoordinator } from "./session-worktree-coordinator.js";
import { matchesRemoteWorktreeTargetRevision } from "./ssh-worktree-rename-authority.js";

type RemoteWorktreeAuthorityStore = Pick<OperationalStore,
  "getTarget" | "getOperation" | "getBackend" | "findNativeSessionDerivation" | "listSessions" | "listUnadoptedNativeSessionDerivations"
  | "findSession" | "findSetting">;

/** Admit only a durable, exact remote checkout. The same lease survives the
 * receipt-to-Session transition without granting authority to another path. */
export function createRemoteClaudeDerivedWorkspaceAuthorizer(options: {
  readonly store: RemoteWorktreeAuthorityStore;
  readonly worktrees: () => Pick<SessionWorktreeCoordinator, "assertActiveRemoteWorktree"> | undefined;
}): (
  target: TargetDescriptor,
  storedTarget: StoredTarget,
  signal?: AbortSignal,
  cleanup?: ClaudeRemoteDerivationCleanup
) => Promise<RemoteClaudeDerivedWorkspaceAuthority> {
  const { store } = options;
  return async (target, storedTarget, signal, cleanup) => {
    signal?.throwIfAborted();
    const source = storedTarget.descriptor.remoteWorkspace;
    const requested = target.remoteWorkspace;
    if (source === undefined || requested === undefined
      || target.id !== storedTarget.descriptor.id
      || target.backendId !== storedTarget.descriptor.backendId
      || target.workspaceRoot === storedTarget.descriptor.workspaceRoot
      || (requested.workspaceRoot !== source.workspaceRoot
        && requested.workspaceRoot !== target.workspaceRoot)
      || !sameRemoteExecutionBinding(requested, source)) {
      throw new Error("The derived remote workspace Target authority is invalid.");
    }
    const targetRevision = storedTarget.revision;
    const targetDigest = operationBodyHash(storedTarget.descriptor);
    const findBinding = cleanup === undefined
      ? () => findExactBinding(store, storedTarget, target.workspaceRoot)
      : () => findExactCleanupBinding(store, target, targetRevision, cleanup);
    const initial = findBinding();
    const sessionId = initial.sessionId;
    const bindingDigest = operationBodyHash(initial.binding);
    const currentBinding = (): SessionWorktreeBinding => {
      if (cleanup !== undefined) signal?.throwIfAborted();
      const currentTarget = store.getTarget(target.id);
      if (currentTarget.revision !== targetRevision
        || operationBodyHash(currentTarget.descriptor) !== targetDigest) {
        throw new Error("The derived remote workspace Target authority changed.");
      }
      const current = findBinding();
      if (current.sessionId !== sessionId || operationBodyHash(current.binding) !== bindingDigest) {
        throw new Error("The derived remote workspace lease authority changed.");
      }
      return current.binding;
    };
    const authority: RemoteClaudeDerivedWorkspaceAuthority = {
      assertCurrent: () => { currentBinding(); },
      ...(cleanup === undefined ? {} : { expectedExecutionIdentity: initial.binding.remote!.executionIdentity }),
      verifyExact: async (verifySignal) => {
        verifySignal?.throwIfAborted();
        const binding = currentBinding();
        const worktrees = options.worktrees();
        const path = cleanup === undefined
          ? await worktrees?.assertActiveRemoteWorktree(sessionId, binding)
          : await worktrees?.assertActiveRemoteWorktree(sessionId, binding, { register: false });
        if (path !== target.workspaceRoot) {
          throw new Error("The derived remote workspace checkout is not active.");
        }
        currentBinding();
        verifySignal?.throwIfAborted();
      }
    };
    return authority;
  };
}

function findExactCleanupBinding(
  store: RemoteWorktreeAuthorityStore,
  target: TargetDescriptor,
  targetRevision: bigint,
  cleanup: ClaudeRemoteDerivationCleanup
): { readonly sessionId: string; readonly binding: SessionWorktreeBinding } {
  const receipt = store.findNativeSessionDerivation(cleanup.operationId);
  const binding = receipt?.worktree;
  const plan = receipt?.remoteWorktreePlan;
  if (target.remoteWorkspace?.kind !== "ssh" || !target.managed || !target.trusted
    || receipt === undefined || !receipt.externalLifecycle || receipt.state !== "cleanup_claimed"
    || receipt.cleanupToken !== cleanup.token || receipt.sessionId !== cleanup.sessionId
    || receipt.backendId !== target.backendId || receipt.targetId !== target.id || receipt.targetRevision !== targetRevision
    || receipt.remoteWorkspace?.kind !== "ssh" || !sameRemoteExecutionBinding(receipt.remoteWorkspace, target.remoteWorkspace)
    || receipt.lifecycleOwnerGeneration !== store.getBackend(target.backendId).descriptor.instanceGeneration
    || receipt.effectiveWorkspaceRoot !== target.workspaceRoot
    || !matches(binding, target.id, targetRevision, target.workspaceRoot) || binding?.remote?.binding.kind !== "ssh"
    || plan === undefined || plan.leaseId !== binding.leaseId || plan.path !== binding.path
    || plan.workspaceId !== binding.workspaceId || plan.repositoryRoot !== binding.repositoryRoot
    || plan.branch !== binding.branch || plan.sourceRef !== binding.sourceRef || plan.sourceCommit !== binding.sourceCommit
    || plan.sessionId !== cleanup.sessionId || plan.sourceSessionId !== receipt.sourceSessionId || plan.manifestId !== binding.remote.manifestId
    || operationBodyHash(plan.remote) !== operationBodyHash(binding.remote)
    || store.listSessions({ includeArchived: true, includeDeleted: true }).some((session) =>
      session.descriptor.id === cleanup.sessionId || session.descriptor.worktree?.remote?.manifestId === plan.manifestId)) {
    throw new Error("The derived remote workspace cleanup claim is invalid.");
  }
  const operation = store.getOperation(cleanup.operationId);
  if (operation.status !== "failed" || operation.bodyHash !== receipt.expectedBodyHash
    || (operation.kind !== "clone_session" && operation.kind !== "fork_session")) {
    throw new Error("The derived remote workspace cleanup operation is invalid.");
  }
  return { sessionId: receipt.sessionId, binding };
}

function sameRemoteExecutionBinding(
  left: import("@joko/core").RemoteWorkspaceBinding,
  right: import("@joko/core").RemoteWorkspaceBinding
): boolean {
  if (left.kind !== right.kind) return false;
  return left.kind === "ssh" && right.kind === "ssh"
    ? left.hostTargetId === right.hostTargetId && left.hostId === right.hostId
    : left.kind === "device_peer" && right.kind === "device_peer"
      && left.controllerDeviceId === right.controllerDeviceId
      && left.targetDeviceId === right.targetDeviceId;
}

function findExactBinding(
  store: RemoteWorktreeAuthorityStore,
  target: StoredTarget,
  workspaceRoot: string
): { readonly sessionId: string; readonly binding: SessionWorktreeBinding } {
  const targetId = target.descriptor.id;
  const candidates = new Map<string, SessionWorktreeBinding>();
  for (const session of store.listSessions({ includeArchived: true, includeDeleted: true })) {
    const binding = session.descriptor.worktree;
    if (session.descriptor.targetId === targetId && !session.descriptor.archived
      && session.descriptor.deletedAt === undefined
      && matchesWorkspace(binding, targetId, workspaceRoot)
      && matchesRemoteWorktreeTargetRevision(store, target, session.descriptor.id, binding)) {
      candidates.set(session.descriptor.id, binding);
    }
  }
  for (const receipt of store.listUnadoptedNativeSessionDerivations()) {
    const binding = receipt.worktree;
    if (receipt.targetId !== targetId || receipt.targetRevision !== target.revision
      || (receipt.state !== "prepared" && receipt.state !== "recorded")
      || store.getOperation(receipt.operationId).status !== "started"
      || !matches(binding, targetId, target.revision, workspaceRoot)) continue;
    const existing = candidates.get(receipt.sessionId);
    if (existing !== undefined && operationBodyHash(existing) !== operationBodyHash(binding)) {
      throw new Error("The derived remote workspace lease is ambiguous.");
    }
    candidates.set(receipt.sessionId, binding!);
  }
  if (candidates.size !== 1) throw new Error("The derived remote workspace is not uniquely owned.");
  const [sessionId, binding] = candidates.entries().next().value!;
  return { sessionId, binding };
}

function matches(
  binding: SessionWorktreeBinding | undefined,
  targetId: string,
  targetRevision: bigint,
  workspaceRoot: string
): boolean {
  return matchesWorkspace(binding, targetId, workspaceRoot) && binding.remote.targetRevision === targetRevision.toString();
}

function matchesWorkspace(binding: SessionWorktreeBinding | undefined, targetId: string, workspaceRoot: string
): binding is SessionWorktreeBinding & { readonly remote: NonNullable<SessionWorktreeBinding["remote"]> } {
  return binding !== undefined && binding.state === "active" && binding.remote !== undefined
    && binding.workspaceId.length > 0
    && binding.path === workspaceRoot
    && binding.remote.targetId === targetId;
}
