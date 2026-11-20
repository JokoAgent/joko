import type { SessionWorktreeBinding } from "@joko/core";
import { operationBodyHash, type OperationalStore, type StoredTarget } from "@joko/store";

const DISPLAY_RENAME_SETTING = "ssh_worktree_display_rename.v1";

type WorktreeRenameStore = Pick<OperationalStore, "findSession" | "findSetting">;

interface WorktreeRenameReceipt {
  readonly format: 1;
  readonly targetRevision: string;
  readonly authorityDigest: string;
  readonly leases: Readonly<Record<string, string>>;
}

/** A display rename carries forward only already adopted SSH leases. Another
 * Target update retires that receipt, even if later changes restore its fields. */
export function recordSshWorktreeDisplayRename(store: OperationalStore, previous: StoredTarget, current: StoredTarget): void {
  if (previous.descriptor.displayName === current.descriptor.displayName
    || current.descriptor.remoteWorkspace?.kind !== "ssh" || !current.descriptor.managed || !current.descriptor.trusted
    || previous.revision === current.revision || targetAuthorityDigest(previous) !== targetAuthorityDigest(current)) return;
  const targetId = current.descriptor.id;
  const leases = store.listSessions({ targetId, includeArchived: true }).flatMap(({ descriptor }) => {
    const binding = descriptor.worktree;
    return binding?.remote?.binding.kind === "ssh" && binding.remote.targetId === targetId
      && (binding.state === "active" || binding.state === "preserved")
      && matchesRemoteWorktreeTargetRevision(store, previous, descriptor.id, binding)
      ? [[descriptor.id, leaseDigest(binding)] as const] : [];
  });
  store.setSetting<WorktreeRenameReceipt>("target", targetId, DISPLAY_RENAME_SETTING, {
    format: 1, targetRevision: current.revision.toString(), authorityDigest: targetAuthorityDigest(current),
    leases: Object.fromEntries(leases)
  });
}

export function matchesRemoteWorktreeTargetRevision(store: WorktreeRenameStore, target: StoredTarget,
  sessionId: string, binding: SessionWorktreeBinding): boolean {
  const remote = binding.remote;
  if (remote === undefined || remote.targetId !== target.descriptor.id) return false;
  if (remote.targetRevision === target.revision.toString()) return true;
  if (remote.binding.kind !== "ssh" || target.descriptor.remoteWorkspace?.kind !== "ssh"
    || !target.descriptor.managed || !target.descriptor.trusted) return false;

  const receipt = store.findSetting<WorktreeRenameReceipt>("target", target.descriptor.id, DISPLAY_RENAME_SETTING)?.value;
  if (receipt?.format !== 1 || receipt.targetRevision !== target.revision.toString()
    || receipt.authorityDigest !== targetAuthorityDigest(target) || receipt.leases?.[sessionId] !== leaseDigest(binding)) return false;
  const session = store.findSession(sessionId)?.descriptor;
  const adopted = session?.worktree;
  return session?.targetId === target.descriptor.id && session.backendId === target.descriptor.backendId
    && session.deletedAt === undefined && adopted !== undefined && (adopted.state === "active" || adopted.state === "preserved")
    && leaseDigest(adopted) === receipt.leases[sessionId];
}

function targetAuthorityDigest(target: StoredTarget): string {
  const { displayName: _name, ...descriptor } = target.descriptor;
  return operationBodyHash({ descriptor, metadata: target.metadata });
}

function leaseDigest(binding: SessionWorktreeBinding): string {
  const { state: _state, updatedAt: _updatedAt, ...identity } = binding;
  return operationBodyHash(identity);
}
