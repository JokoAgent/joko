import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { PersonalDevelopmentError, type DevelopmentWorktreeAuthority, type DevelopmentWorktreeLease } from "@joko/personal-development";
import type { OperationalStore } from "@joko/store";
import { acquireWorktreeSourceUse, releaseRetiredWorktreeSourceUse, type WorktreeSourceUse, type WorktreeSourceUseReceipt } from "@joko/worktree";

import { PERSONAL_DEVELOPMENT_SCOPE, readPersonalDevelopmentPurpose, samePersonalWorktree } from "./personal-development-purpose.js";
import type { SessionWorktreeCoordinator } from "./session-worktree-coordinator.js";

interface PersonalSourceUse {
  readonly format: 1; readonly ownerId: string; readonly operationId: string; readonly lease: DevelopmentWorktreeLease;
  readonly receipt: WorktreeSourceUseReceipt; readonly status: "prepared" | "active" | "unknown";
}
const useKey = (ownerId: string, id: string) => `source-use:${ownerId}:${id}`;
const samePath = (left: string, right: string) => process.platform === "win32"
  ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right);

/** Adopts only the checkout already created by the durable visible Session.
 * Neither model arguments nor the package's managed source path grant access. */
export function createPersonalDevelopmentWorktreeAuthority(options: {
  readonly store: OperationalStore;
  readonly worktrees: SessionWorktreeCoordinator;
  readonly ownerId: string;
  readonly sourceRoot: string;
}): DevelopmentWorktreeAuthority {
  const current = (lease: Pick<DevelopmentWorktreeLease, "taskId" | "sessionId" | "leaseId">, requireActive = true) => {
    const purpose = readPersonalDevelopmentPurpose(options.store, lease.sessionId);
    const session = options.store.getSession(lease.sessionId);
    const binding = session.descriptor.worktree;
    const target = options.store.getTarget(session.descriptor.targetId);
    if (purpose?.ownerId !== options.ownerId || purpose.phase !== "adopted" || purpose.taskId !== lease.taskId
      || purpose.binding === undefined || purpose.worktree === undefined || binding === undefined
      || binding.leaseId !== lease.leaseId || !samePersonalWorktree(purpose.worktree, binding)
      || session.descriptor.deletedAt !== undefined || session.descriptor.archived
      || session.descriptor.remoteWorkspace !== undefined || purpose.targetId !== target.descriptor.id
      || purpose.targetRevision !== target.revision.toString() || !target.descriptor.trusted
      || target.descriptor.remoteWorkspace !== undefined || resolve(target.descriptor.workspaceRoot) !== resolve(options.sourceRoot)
      || purpose.backendId !== session.descriptor.backendId
      || options.store.getBackend(purpose.backendId).descriptor.instanceGeneration !== purpose.backendGeneration
      || purpose.binding.opaqueRef !== session.descriptor.binding.opaqueRef
      || purpose.binding.nativeSessionId !== session.descriptor.binding.nativeSessionId
      || session.descriptor.binding.generation < purpose.binding.generation
      || requireActive && options.worktrees.activeWorkspacePath(lease.sessionId, binding) === undefined) {
      throw new PersonalDevelopmentError("OWNER_CHANGED");
    }
    return { purpose, session, binding };
  };
  const assertCurrent = async (lease: DevelopmentWorktreeLease): Promise<void> => {
    const { binding } = current(lease);
    if (binding.path !== lease.path || binding.branch !== lease.branch || binding.sourceCommit !== lease.baseCommit) {
      throw new PersonalDevelopmentError("OWNER_CHANGED");
    }
  };
  const saveUse = (value: PersonalSourceUse): void => {
    options.store.setSetting("service", PERSONAL_DEVELOPMENT_SCOPE, useKey(options.ownerId, value.receipt.id), value);
  };
  const sourceUses = (): readonly PersonalSourceUse[] => options.store.listSettings("service", PERSONAL_DEVELOPMENT_SCOPE)
    .filter(setting => setting.key.startsWith(`source-use:${options.ownerId}:`)).map(setting => {
      const value = setting.value as PersonalSourceUse;
      if (value?.format !== 1 || value.ownerId !== options.ownerId || typeof value.operationId !== "string"
        || value.lease === undefined || value.receipt === undefined || value.receipt.format !== 1
        || value.receipt.entryId !== value.lease.leaseId || !samePath(value.receipt.projectRoot, value.lease.path)
        || useKey(options.ownerId, value.receipt.id) !== setting.key || !["prepared", "active", "unknown"].includes(value.status)) {
        throw new PersonalDevelopmentError("STATE_INVALID");
      }
      return value;
    });
  return {
    acquire: async input => {
      input.signal.throwIfAborted();
      if (resolve(input.repositoryRoot) !== resolve(options.sourceRoot) || input.sourceRef !== "joko-personal") {
        throw new PersonalDevelopmentError("OWNER_CHANGED");
      }
      const purpose = readPersonalDevelopmentPurpose(options.store, input.sessionId);
      if (purpose?.worktree === undefined) throw new PersonalDevelopmentError("OWNER_CHANGED");
      const { binding } = current({ taskId: input.taskId, sessionId: input.sessionId, leaseId: purpose.worktree.leaseId });
      return { taskId: input.taskId, sessionId: input.sessionId, leaseId: binding.leaseId,
        path: binding.path, branch: binding.branch, baseCommit: binding.sourceCommit };
    },
    assertCurrent,
    withUse: async (lease, signal, run, context) => {
      signal.throwIfAborted(); await assertCurrent(lease);
      if (typeof context?.operationId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u.test(context.operationId)) throw new PersonalDevelopmentError("STATE_INVALID");
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      const id = randomUUID(), ownerId = `personal-${lease.taskId}-${id}`;
      let record: PersonalSourceUse = { format: 1, ownerId: options.ownerId, operationId: context.operationId, lease,
        receipt: { format: 1, id, entryId: lease.leaseId, ownerId, projectRoot: resolve(lease.path) }, status: "prepared" };
      saveUse(record);
      let use: WorktreeSourceUse | undefined;
      let writerRetired = true;
      try {
        use = await acquireWorktreeSourceUse(lease.path, ownerId, controller, { id });
        if (use.receipt === undefined || use.receipt.id !== id || use.receipt.entryId !== lease.leaseId
          || use.receipt.ownerId !== ownerId || !samePath(use.receipt.projectRoot, lease.path)) throw new PersonalDevelopmentError("OWNER_CHANGED");
        record = { ...record, receipt: use.receipt, status: "active" }; saveUse(record);
        await use.verify(); await assertCurrent(lease);
        const value = await run();
        await use.verify(); await assertCurrent(lease); return value;
      } catch (error) {
        if (error instanceof PersonalDevelopmentError && error.code === "PROCESS_UNKNOWN") writerRetired = false;
        throw error;
      } finally {
        signal.removeEventListener("abort", abort);
        try {
          if (use !== undefined) await use.release({ writerRetired });
          else if (writerRetired) await releaseRetiredWorktreeSourceUse(record.receipt);
          if (writerRetired) options.store.deleteSetting("service", PERSONAL_DEVELOPMENT_SCOPE, useKey(options.ownerId, id));
          else saveUse({ ...record, status: "unknown" });
        } catch {
          saveUse({ ...record, status: "unknown" }); throw new PersonalDevelopmentError("PROCESS_UNKNOWN");
        }
      }
    },
    reconcileRetiredUses: async input => {
      let unknown = false;
      for (const record of sourceUses().filter(value => value.operationId === input.operationId)) {
        try {
          const { binding } = current(record.lease, false);
          if (!samePath(binding.path, record.lease.path) || binding.branch !== record.lease.branch || binding.sourceCommit !== record.lease.baseCommit) {
            throw new PersonalDevelopmentError("OWNER_CHANGED");
          }
          await releaseRetiredWorktreeSourceUse(record.receipt);
          options.store.deleteSetting("service", PERSONAL_DEVELOPMENT_SCOPE, useKey(options.ownerId, record.receipt.id));
        } catch { unknown = true; }
      }
      return unknown ? "unknown" : "retired";
    },
    release: async (lease, signal) => {
      signal.throwIfAborted();
      const { binding, purpose } = current(lease, false);
      if (purpose.editing !== "ending") throw new PersonalDevelopmentError("BUSY");
      try { await options.worktrees.release(lease.sessionId, binding,
        purpose.endingOperationId === undefined ? undefined : { retiredCleanupOperationId: purpose.endingOperationId }); return "released"; }
      catch { return "preserved"; }
    }
  };
}
