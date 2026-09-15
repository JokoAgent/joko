import type { TargetDescriptor } from "@joko/core";
import type { OperationalStore } from "@joko/store";
import type { EphemeralWorktreeService, WorktreeErrorCode } from "@joko/worktree";
import { describe, expect, it } from "vitest";

import { SessionWorktreeCoordinator, type TargetWorktreeEligibility } from "./session-worktree-coordinator.js";
import type { WorkspaceService } from "./workspace-service.js";

describe("SessionWorktreeCoordinator probe classification", () => {
  it("does not inspect a Remote workspace through the local filesystem service", async () => {
    let inspected = false;
    const service = {
      detectCwd: async () => {
        inspected = true;
        throw new Error("must not inspect Remote paths locally");
      }
    } as unknown as EphemeralWorktreeService;
    const coordinator = new SessionWorktreeCoordinator({
      store: {} as OperationalStore,
      workspaces: {} as WorkspaceService,
      storageRoot: "unused",
      service
    });

    await expect(coordinator.probe({
      ...target,
      remoteWorkspace: { hostId: "remote-1", workspaceRoot: "/srv/project" }
    })).resolves.toEqual({ targetId: "target-1", eligibility: "unavailable", canRefreshRemote: false });
    expect(inspected).toBe(false);
  });

  it.each([
    ["GIT_NOT_FOUND", "git_not_found"],
    ["NOT_GIT_REPOSITORY", "not_git_repository"],
    ["CWD_IS_WORKTREE", "already_linked"],
    ["NOT_INITIALIZED", "unavailable"],
    ["CWD_UNSAFE", "unsafe"]
  ] as const)("maps %s without conflating it with %s", async (code, eligibility) => {
    const coordinator = coordinatorReturning(code);

    await expect(coordinator.probe(target)).resolves.toEqual({
      targetId: "target-1",
      eligibility: eligibility satisfies TargetWorktreeEligibility,
      canRefreshRemote: false
    });
  });
});

function coordinatorReturning(code: WorktreeErrorCode): SessionWorktreeCoordinator {
  const service = {
    detectCwd: async () => ({ ok: false as const, error: { code, message: code } })
  } as unknown as EphemeralWorktreeService;
  return new SessionWorktreeCoordinator({
    store: {} as OperationalStore,
    workspaces: {} as WorkspaceService,
    storageRoot: "unused",
    service
  });
}

const target: TargetDescriptor = {
  id: "target-1",
  backendId: "backend-1",
  displayName: "Project",
  workspaceRoot: "/project",
  managed: false,
  trusted: true
};
