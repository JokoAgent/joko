import type { SessionWorktreeBinding, TargetDescriptor } from "@joko/core";
import { operationBodyHash, type OperationalStore, type StoredTarget } from "@joko/store";

import type { RemoteClaudeDerivedWorkspaceAuthority } from "./remote-claude-runtime.js";
import type { SessionWorktreeCoordinator } from "./session-worktree-coordinator.js";

type RemoteWorktreeAuthorityStore = Pick<OperationalStore,
  "getTarget" | "getOperation" | "listSessions" | "listUnadoptedNativeSessionDerivations">;

/** Admit only a durable, exact remote checkout. The same lease survives the
 * receipt-to-Session transition without granting authority to another path. */
export function createRemoteClaudeDerivedWorkspaceAuthorizer(options: {
  readonly store: RemoteWorktreeAuthorityStore;
  readonly worktrees: () => Pick<SessionWorktreeCoordinator, "assertActiveRemoteWorktree"> | undefined;
}): (
  target: TargetDescriptor,
  storedTarget: StoredTarget,
  signal?: AbortSignal
) => Promise<RemoteClaudeDerivedWorkspaceAuthority> {
  const { store } = options;
  return async (target, storedTarget) => {
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
    const initial = findExactBinding(store, target.id, targetRevision, target.workspaceRoot);
    const sessionId = initial.sessionId;
    const bindingDigest = operationBodyHash(initial.binding);
    const currentBinding = (): SessionWorktreeBinding => {
      const currentTarget = store.getTarget(target.id);
      if (currentTarget.revision !== targetRevision
        || operationBodyHash(currentTarget.descriptor) !== targetDigest) {
        throw new Error("The derived remote workspace Target authority changed.");
      }
      const current = findExactBinding(store, target.id, targetRevision, target.workspaceRoot);
      if (current.sessionId !== sessionId || operationBodyHash(current.binding) !== bindingDigest) {
        throw new Error("The derived remote workspace lease authority changed.");
      }
      return current.binding;
    };
    const authority: RemoteClaudeDerivedWorkspaceAuthority = {
      assertCurrent: () => { currentBinding(); },
      verifyExact: async (verifySignal) => {
        verifySignal?.throwIfAborted();
        const binding = currentBinding();
        const worktrees = options.worktrees();
        if (worktrees === undefined
          || await worktrees.assertActiveRemoteWorktree(sessionId, binding) !== target.workspaceRoot) {
          throw new Error("The derived remote workspace checkout is not active.");
        }
        currentBinding();
        verifySignal?.throwIfAborted();
      }
    };
    return authority;
  };
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
  targetId: string,
  targetRevision: bigint,
  workspaceRoot: string
): { readonly sessionId: string; readonly binding: SessionWorktreeBinding } {
  const candidates = new Map<string, SessionWorktreeBinding>();
  for (const session of store.listSessions({ includeArchived: true, includeDeleted: true })) {
    const binding = session.descriptor.worktree;
    if (session.descriptor.targetId === targetId && !session.descriptor.archived
      && session.descriptor.deletedAt === undefined
      && matches(binding, targetId, targetRevision, workspaceRoot)) {
      candidates.set(session.descriptor.id, binding!);
    }
  }
  for (const receipt of store.listUnadoptedNativeSessionDerivations()) {
    const binding = receipt.worktree;
    if (receipt.targetId !== targetId || receipt.targetRevision !== targetRevision
      || (receipt.state !== "prepared" && receipt.state !== "recorded")
      || store.getOperation(receipt.operationId).status !== "started"
      || !matches(binding, targetId, targetRevision, workspaceRoot)) continue;
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
  return binding !== undefined && binding.state === "active" && binding.remote !== undefined
    && binding.workspaceId.length > 0
    && binding.path === workspaceRoot
    && binding.remote.targetId === targetId
    && binding.remote.targetRevision === targetRevision.toString();
}
