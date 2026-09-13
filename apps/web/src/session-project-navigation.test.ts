import { describe, expect, it } from "vitest";

import {
  applySessionProjectOverrides,
  reconcileSessionProjectOverrides,
  rollbackSessionProjectOverride,
  sessionProjectMoveBlock,
  sessionProjectPlacement,
  sessionsInProject,
  type ProjectMoveSession,
  type SessionProjectNavigationPlacement
} from "./session-project-navigation.js";

const base: ProjectMoveSession = {
  id: "session-a",
  projectId: "project-a",
  archived: false,
  state: "idle"
};

describe("Session project navigation", () => {
  it("groups by navigation project independently from runtime identity", () => {
    const sessions = [
      { id: "a", targetId: "runtime-a", projectId: "project-b" },
      { id: "b", targetId: "runtime-b", projectId: "project-b" },
      { id: "c", targetId: "runtime-c" }
    ];
    expect(sessionsInProject(sessions, "project-b").map((session) => session.id)).toEqual(["a", "b"]);
    expect(sessionProjectPlacement(sessions[2]!)).toEqual({ kind: "dialogue" });
  });

  it.each([
    [{ archived: true }, "archived"],
    [{ remoteWorkspace: true }, "remote"],
    [{ runtimeAttached: true }, "attached"],
    [{ state: "running" as const }, "busy"],
    [{ state: "waiting" as const }, "busy"],
    [{ state: "retrying" as const }, "busy"],
    [{ state: "closed" as const }, "closed"]
  ])("blocks unavailable move state %#", (patch, expected) => {
    expect(sessionProjectMoveBlock({ ...base, ...patch })).toBe(expected);
  });

  it("overlays project and Dialogue moves without mutating runtime fields", () => {
    const sessions = [{ ...base, targetId: "runtime-a", backendId: "backend-a" }];
    const project = applySessionProjectOverrides(sessions, new Map([
      [base.id, { kind: "project", projectId: "project-b" } as const]
    ]));
    expect(project[0]).toMatchObject({
      projectId: "project-b",
      targetId: "runtime-a",
      backendId: "backend-a"
    });
    const dialogue = applySessionProjectOverrides(project, new Map([
      [base.id, { kind: "dialogue" } as const]
    ]));
    expect(dialogue[0]).toMatchObject({ targetId: "runtime-a", backendId: "backend-a" });
    expect(dialogue[0]?.projectId).toBeUndefined();
  });

  it("retains optimistic state until authority agrees and drops missing Sessions", () => {
    const overrides = new Map<string, SessionProjectNavigationPlacement>([
      ["session-a", { kind: "project", projectId: "project-b" } as const],
      ["session-missing", { kind: "dialogue" } as const]
    ]);
    const pending = reconcileSessionProjectOverrides(overrides, [base]);
    expect([...pending.keys()]).toEqual(["session-a"]);
    const settled = reconcileSessionProjectOverrides(pending, [{ ...base, projectId: "project-b" }]);
    expect(settled.size).toBe(0);
  });

  it("rolls back only the matching failed optimistic attempt", () => {
    const attempted = { kind: "project", projectId: "project-b" } as const;
    const overrides = new Map<string, SessionProjectNavigationPlacement>([
      ["session-a", attempted],
      ["session-b", { kind: "dialogue" } as const]
    ]);
    const rolledBack = rollbackSessionProjectOverride(overrides, "session-a", {
      kind: "project",
      projectId: "project-b"
    });
    expect([...rolledBack.entries()]).toEqual([["session-b", { kind: "dialogue" }]]);
    expect(rollbackSessionProjectOverride(overrides, "session-a", { kind: "dialogue" })).toBe(overrides);
  });
});
