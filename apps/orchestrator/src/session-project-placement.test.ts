import { describe, expect, it, vi } from "vitest";

import {
  SessionProjectPlacementCoordinator,
  type ProjectPlacementSessionSnapshot,
  type ProjectPlacementTargetSnapshot,
  type SessionProjectPlacementCommit
} from "./session-project-placement.js";

const baseSession: ProjectPlacementSessionSnapshot = {
  id: "session-a",
  revision: 7n,
  backendId: "backend-a",
  targetId: "runtime-target",
  projectId: "project-a",
  archived: false,
  deleted: false,
  remoteWorkspace: false,
  runtimeAttached: false,
  activity: "idle"
};

const baseProject: ProjectPlacementTargetSnapshot = {
  id: "project-b",
  active: true,
  remoteWorkspace: false
};

describe("SessionProjectPlacementCoordinator", () => {
  it("commits only the project placement and the optimistic revision fence", async () => {
    const commit = vi.fn(async (_input: SessionProjectPlacementCommit) => ({ revision: 8n, projectId: "project-b" }));
    const coordinator = fixture({ commit });
    await expect(coordinator.move("session-a", { kind: "project", projectId: "project-b" }))
      .resolves.toEqual({
        kind: "moved",
        revision: 8n,
        placement: { kind: "project", projectId: "project-b" }
      });
    expect(commit).toHaveBeenCalledWith({
      sessionId: "session-a",
      expectedRevision: 7n,
      projectId: "project-b"
    });
    const commitInput = commit.mock.calls[0]?.[0];
    expect(commitInput).toBeDefined();
    expect(Object.keys(commitInput!).sort()).toEqual([
      "expectedRevision",
      "projectId",
      "sessionId"
    ]);
  });

  it("supports an explicit projectless dialogue placement without a runtime rebind", async () => {
    const commit = vi.fn(async () => ({ revision: 8n }));
    const coordinator = fixture({ commit });
    await expect(coordinator.move("session-a", { kind: "dialogue" })).resolves.toEqual({
      kind: "moved",
      revision: 8n,
      placement: { kind: "dialogue" }
    });
    expect(commit).toHaveBeenCalledWith({ sessionId: "session-a", expectedRevision: 7n });
  });

  it("returns unchanged without writing the current placement", async () => {
    const commit = vi.fn();
    const coordinator = fixture({ commit });
    await expect(coordinator.move("session-a", { kind: "project", projectId: "project-a" }))
      .resolves.toMatchObject({ kind: "unchanged", revision: 7n });
    expect(commit).not.toHaveBeenCalled();
  });

  it.each([
    ["archived", { archived: true }, "session_unavailable"],
    ["deleted", { deleted: true }, "session_unavailable"],
    ["running", { activity: "running" as const }, "runtime_busy"],
    ["waiting", { activity: "waiting" as const }, "runtime_busy"],
    ["attached", { runtimeAttached: true }, "runtime_attached"],
    ["remote", { remoteWorkspace: true }, "remote_unsupported"]
  ])("blocks %s tasks before any placement write", async (_name, patch, code) => {
    const commit = vi.fn();
    const coordinator = fixture({ session: { ...baseSession, ...patch }, commit });
    await expect(coordinator.move("session-a", { kind: "project", projectId: "project-b" }))
      .rejects.toMatchObject({ code });
    expect(commit).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", undefined, "project_not_found"],
    ["archived", { ...baseProject, active: false }, "project_unavailable"],
    ["remote", { ...baseProject, remoteWorkspace: true }, "remote_unsupported"]
  ])("rejects a %s destination", async (_name, project, code) => {
    const commit = vi.fn();
    const coordinator = fixture({ project, commit });
    await expect(coordinator.move("session-a", { kind: "project", projectId: "project-b" }))
      .rejects.toMatchObject({ code });
    expect(commit).not.toHaveBeenCalled();
  });

  it("validates public identities and rejects mismatched commit projections", async () => {
    const coordinator = fixture({
      commit: vi.fn(async () => ({ revision: 8n, projectId: "project-other" }))
    });
    await expect(coordinator.move(" session-a", { kind: "dialogue" }))
      .rejects.toMatchObject({ code: "invalid_identity" });
    await expect(coordinator.move("session-a", { kind: "project", projectId: "project-b" }))
      .rejects.toThrow("mismatched projection");
  });
});

function fixture(overrides: {
  readonly session?: ProjectPlacementSessionSnapshot;
  readonly project?: ProjectPlacementTargetSnapshot;
  readonly commit?: (input: { readonly sessionId: string; readonly expectedRevision: bigint; readonly projectId?: string }) => Promise<{ readonly revision: bigint; readonly projectId?: string }>;
} = {}): SessionProjectPlacementCoordinator {
  const session = Object.prototype.hasOwnProperty.call(overrides, "session") ? overrides.session : baseSession;
  const project = Object.prototype.hasOwnProperty.call(overrides, "project") ? overrides.project : baseProject;
  return new SessionProjectPlacementCoordinator({
    readSession: async () => session,
    readProject: async () => project,
    commit: overrides.commit ?? (async (input) => ({ revision: 8n, ...(input.projectId === undefined ? {} : { projectId: input.projectId }) }))
  });
}
