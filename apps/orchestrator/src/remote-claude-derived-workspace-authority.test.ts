import type { SessionWorktreeBinding, TargetDescriptor } from "@joko/core";
import type { NativeSessionDerivationRecord, OperationalStore, StoredSession, StoredTarget } from "@joko/store";
import { describe, expect, it, vi } from "vitest";

import { createRemoteClaudeDerivedWorkspaceAuthorizer } from "./remote-claude-derived-workspace-authority.js";
import type { SessionWorktreeCoordinator } from "./session-worktree-coordinator.js";

const sourceRemote = {
  kind: "ssh" as const,
  hostTargetId: "host-target",
  hostId: "host-one",
  workspaceRoot: "/srv/project"
};
const sourceTarget: TargetDescriptor = {
  id: "target-one",
  backendId: "backend-one",
  displayName: "Project",
  workspaceRoot: "/srv/project",
  remoteWorkspace: sourceRemote,
  managed: true,
  trusted: true
};
const derivedTarget: TargetDescriptor = { ...sourceTarget, workspaceRoot: "/srv/runtime/worktrees/child" };
const binding: SessionWorktreeBinding = {
  leaseId: "lease-child",
  workspaceId: "worktree-child",
  path: derivedTarget.workspaceRoot,
  repositoryRoot: "/srv/project",
  branch: "joko/child",
  sourceRef: "refs/heads/main",
  sourceCommit: "a".repeat(40),
  sourceStrategy: "explicit",
  sourceRefreshed: false,
  remote: {
    targetId: sourceTarget.id,
    binding: sourceRemote,
    executionIdentity: "ssh-owner-one",
    targetRevision: "7",
    manifestId: "manifest-child"
  },
  state: "active",
  acquiredAt: 10,
  updatedAt: 11
};

function fixture() {
  let targetRevision = 7n;
  let sessions: StoredSession[] = [];
  let receipts: NativeSessionDerivationRecord[] = [{
    sessionId: "child",
    targetId: sourceTarget.id,
    targetRevision,
    operationId: "derive-child",
    state: "prepared",
    worktree: binding
  } as NativeSessionDerivationRecord];
  let operationStatus: "started" | "failed" = "started";
  const storedTarget = { descriptor: sourceTarget, revision: targetRevision } as StoredTarget;
  const store = {
    getTarget: () => ({ descriptor: sourceTarget, revision: targetRevision }),
    getOperation: () => ({ status: operationStatus }),
    listSessions: () => sessions,
    listUnadoptedNativeSessionDerivations: () => receipts
  } as unknown as OperationalStore;
  const assertActiveRemoteWorktree = vi.fn(async (_sessionId: string, worktree: SessionWorktreeBinding) => worktree.path);
  const worktrees = { assertActiveRemoteWorktree } as unknown as SessionWorktreeCoordinator;
  const authorize = createRemoteClaudeDerivedWorkspaceAuthorizer({ store, worktrees: () => worktrees });
  return {
    authorize, storedTarget, assertActiveRemoteWorktree,
    adopt: () => {
      sessions = [{ descriptor: {
        id: "child", targetId: sourceTarget.id, archived: false, worktree: binding
      } } as StoredSession];
      receipts = [];
    },
    failOperation: () => { operationStatus = "failed"; },
    addConflictingSession: () => {
      sessions = [{ descriptor: {
        id: "other-child", targetId: sourceTarget.id, archived: false, worktree: binding
      } } as StoredSession];
    },
    changeTargetRevision: () => { targetRevision = 8n; }
  };
}

describe("remote Claude derived workspace authority", () => {
  it("requires an exact durable lease and retains authority across receipt adoption", async () => {
    const f = fixture();
    const authority = await f.authorize(derivedTarget, f.storedTarget);
    await authority.verifyExact();
    expect(f.assertActiveRemoteWorktree).toHaveBeenCalledWith("child", binding);
    f.adopt();
    authority.assertCurrent();
    await authority.verifyExact();
    expect(f.assertActiveRemoteWorktree).toHaveBeenCalledTimes(2);
    f.changeTargetRevision();
    expect(() => authority.assertCurrent()).toThrow(/Target authority changed/u);
  });

  it("accepts only the primary or exact derived root on the same remote execution binding", async () => {
    const effectiveTarget = {
      ...derivedTarget,
      remoteWorkspace: { ...sourceRemote, workspaceRoot: derivedTarget.workspaceRoot }
    };
    const effective = fixture();
    await expect(effective.authorize(effectiveTarget, effective.storedTarget)).resolves.toBeDefined();
    const unrelated = fixture();
    await expect(unrelated.authorize({
      ...derivedTarget,
      remoteWorkspace: { ...sourceRemote, workspaceRoot: "/srv/runtime/worktrees/other" }
    }, unrelated.storedTarget)).rejects.toThrow(/Target authority is invalid/u);
  });

  it("rejects failed or ambiguous receipts before granting an SDK runtime", async () => {
    const failed = fixture();
    failed.failOperation();
    await expect(failed.authorize(derivedTarget, failed.storedTarget)).rejects.toThrow(/not uniquely owned/u);
    expect(failed.assertActiveRemoteWorktree).not.toHaveBeenCalled();

    const ambiguous = fixture();
    ambiguous.addConflictingSession();
    await expect(ambiguous.authorize(derivedTarget, ambiguous.storedTarget)).rejects.toThrow(/not uniquely owned/u);
    expect(ambiguous.assertActiveRemoteWorktree).not.toHaveBeenCalled();
  });

  it("does not accept a substituted primary Host binding", async () => {
    const f = fixture();
    await expect(f.authorize({
      ...derivedTarget,
      remoteWorkspace: { ...sourceRemote, hostId: "other-host" }
    }, f.storedTarget)).rejects.toThrow(/Target authority is invalid/u);
    expect(f.assertActiveRemoteWorktree).not.toHaveBeenCalled();
  });
});
