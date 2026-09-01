import { describe, expect, it } from "vitest";

import type { ScheduleView, TargetView } from "../model.js";
import { clampScheduleListWidth, countActiveSchedules, filterSchedules, groupSchedulesByProject, normalizeScheduleStatusFilter, reconcileScheduleHistory, scheduleDisplayStatus, scheduleRuntimeStatus, selectVisibleScheduleId } from "./scheduler-list.js";

const target = (id: string, workspaceId: string, workspaceName: string): TargetView => ({
  id,
  backendId: "backend",
  name: workspaceName,
  workspaceId,
  workspaceName,
  trusted: true,
  pinned: false,
  archived: false
});

const schedule = (id: string, targetId: string, enabled: boolean, name = id): ScheduleView => ({
  id,
  name,
  backendId: "backend",
  targetId,
  source: "user",
  sessionMode: "bound",
  sessionId: `session-${id}`,
  enabled,
  kind: "manual",
  expression: "",
  timezone: "UTC",
  inputText: "Inspect the project",
  executionMode: "agent",
  useWorktree: false,
  refreshWorktreeRemote: false,
  permissionMode: "ask",
  planMode: false,
  extraDirectoryIds: [],
  silentWhenIdle: false,
  notifyDesktop: true,
  overlapPolicy: "queue",
  misfirePolicy: "runOnce",
  unreadRunCount: 0,
  history: []
});

describe("scheduler master list", () => {
  it("projects an active run ahead of a capacity wait and leaves unrelated tasks idle", () => {
    const runtime = {
      instanceId: "scheduler-a",
      inFlight: 1,
      slotsInUse: 1,
      maxConcurrentRuns: 1,
      runs: [{
        scheduleId: "active",
        source: "automatic" as const,
        executionMode: "agent" as const,
        startedAt: 1,
        phase: "queued" as const,
        lastProgressAt: 2
      }],
      waiting: [
        { scheduleId: "active", waitingSince: 3 },
        { scheduleId: "waiting", waitingSince: 4 }
      ]
    };

    expect(scheduleRuntimeStatus(runtime, "active")).toMatchObject({ kind: "run", run: { phase: "queued" } });
    expect(scheduleRuntimeStatus(runtime, "waiting")).toMatchObject({ kind: "capacity", waiting: { waitingSince: 4 } });
    expect(scheduleRuntimeStatus(runtime, "idle")).toBeUndefined();
  });

  it("filters enabled and paused schedules without changing the source order", () => {
    const schedules = [schedule("active", "one", true), schedule("paused", "one", false)];
    expect(filterSchedules(schedules, "active").map((item) => item.id)).toEqual(["active"]);
    expect(filterSchedules(schedules, "paused").map((item) => item.id)).toEqual(["paused"]);
    expect(filterSchedules(schedules, "all")).toBe(schedules);
  });

  it("groups targets that share a workspace and keeps latest-fired order", () => {
    const older = { ...schedule("older", "target-b", true, "Z"), lastRun: { state: "completed" as const, at: 10 } };
    const newer = { ...schedule("newer", "target-a", false, "A"), lastRun: { state: "completed" as const, at: 20 } };
    const groups = groupSchedulesByProject(
      [older, newer],
      [target("target-a", "workspace", "Project"), target("target-b", "workspace", "Project")],
      "Other"
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.schedules.map((item) => item.id)).toEqual(["newer", "older"]);
  });

  it("keeps project-owned schedules ahead of personal schedules within a project", () => {
    const personal = { ...schedule("personal", "target-a", true), lastRun: { state: "completed" as const, at: 20 } };
    const project = { ...schedule("project", "target-a", true), source: "project" as const, lastRun: { state: "completed" as const, at: 10 } };
    const groups = groupSchedulesByProject(
      [personal, project],
      [target("target-a", "workspace", "Project")],
      "Other"
    );

    expect(groups[0]?.schedules.map((item) => item.id)).toEqual(["project", "personal"]);
  });

  it("keeps consumed one-shot tasks in the active/expired bucket", () => {
    const expired = {
      ...schedule("once", "one", false),
      kind: "once" as const,
      history: [{ id: "trigger", runId: "run", sessionId: "session", state: "completed" as const, scheduledAt: 1, triggeredAt: 2, zeroCost: false, costAttribution: "unavailable" as const }]
    };
    const paused = schedule("paused", "one", false);

    expect(scheduleDisplayStatus(expired)).toBe("expired");
    expect(filterSchedules([expired, paused], "active")).toEqual([expired]);
    expect(filterSchedules([expired, paused], "paused")).toEqual([paused]);
    expect(countActiveSchedules([expired, paused])).toBe(1);
  });

  it("reconciles live run transitions without discarding loaded history pages", () => {
    const old = { id: "old", runId: "run-old", sessionId: "session", state: "completed" as const, scheduledAt: 1, triggeredAt: 1, zeroCost: false, costAttribution: "unavailable" as const };
    const running = { id: "new", runId: "run-new", sessionId: "session", state: "running" as const, scheduledAt: 2, triggeredAt: 2, zeroCost: false, costAttribution: "unavailable" as const };
    const completed = { ...running, state: "completed" as const };

    expect(reconcileScheduleHistory([running, old], [completed])).toEqual([completed, old]);
    expect(reconcileScheduleHistory([old], [])).toEqual([old]);
  });

  it("bounds the persisted resizable pane width", () => {
    expect(clampScheduleListWidth(10)).toBe(240);
    expect(clampScheduleListWidth(333.4)).toBe(333);
    expect(clampScheduleListWidth(999)).toBe(480);
  });

  it("defaults an absent or corrupt persisted filter to the all view", () => {
    expect(normalizeScheduleStatusFilter(undefined)).toBe("all");
    expect(normalizeScheduleStatusFilter("expired")).toBe("all");
    expect(normalizeScheduleStatusFilter("active")).toBe("active");
  });

  it("keeps a visible selection and otherwise selects the first filtered row", () => {
    const schedules = [schedule("first", "one", true), schedule("second", "one", true)];
    expect(selectVisibleScheduleId(schedules, "second")).toBe("second");
    expect(selectVisibleScheduleId(schedules, "hidden")).toBe("first");
    expect(selectVisibleScheduleId([], "second")).toBeUndefined();
  });
});
