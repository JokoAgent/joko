import { describe, expect, it } from "vitest";

import type { ScheduleView, SessionView } from "./model.js";
import {
  groupSidebarScheduleSessions,
  sidebarScheduleEntryActivityAt
} from "./sidebar-schedule-groups.js";

describe("sidebar schedule task groups", () => {
  it("groups repeated fresh-task runs at their first visible position", () => {
    const sessions = [scheduledSession("new", 30, "daily"), session("ordinary", 20), scheduledSession("old", 10, "daily")];
    const entries = groupSidebarScheduleSessions(sessions, [schedule("daily", [])]);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      kind: "scheduleGroup",
      group: { schedule: { id: "daily" }, sessions: [{ id: "new" }, { id: "old" }] }
    });
    expect(entries[1]).toMatchObject({ kind: "session", session: { id: "ordinary" } });
    expect(sidebarScheduleEntryActivityAt(entries[0]!)).toBe(30);
  });

  it("keeps a single generated task ungrouped", () => {
    const entries = groupSidebarScheduleSessions(
      [scheduledSession("one", 1, "single"), session("two", 2)],
      [schedule("single", [])]
    );

    expect(entries.map((entry) => entry.kind)).toEqual(["session", "session"]);
  });

  it("keeps historical runs together after the schedule changes execution or task mode", () => {
    const sessions = [scheduledSession("new", 2, "daily"), scheduledSession("old", 1, "daily")];
    const variants: ScheduleView[] = [
      { ...schedule("daily", []), sessionMode: "bound", sessionId: "new" },
      { ...schedule("daily", []), sessionMode: "persistent", sessionId: "new" },
      { ...schedule("daily", []), executionMode: "script" }
    ];

    for (const variant of variants) {
      expect(groupSidebarScheduleSessions(sessions, [variant])).toMatchObject([
        { kind: "scheduleGroup", group: { schedule: { id: "daily" }, sessions: [{ id: "new" }, { id: "old" }] } }
      ]);
    }
  });

  it("keeps runs together when their navigation project changes", () => {
    const first = { ...scheduledSession("one", 1, "daily"), projectId: "project-a" };
    const second = { ...scheduledSession("two", 2, "daily"), projectId: "project-b" };
    const entries = groupSidebarScheduleSessions([first, second], [schedule("daily", [])]);

    expect(entries).toMatchObject([
      { kind: "scheduleGroup", group: { sessions: [{ id: "one" }, { id: "two" }] } }
    ]);
  });

});

function session(id: string, updatedAt: number): SessionView {
  return {
    id,
    backendId: "backend",
    targetId: "target",
    name: id,
    state: "idle",
    pinned: false,
    archived: false,
    generation: 0n,
    fastMode: false,
    permissionMode: "ask",
    planMode: false,
    updatedAt
  };
}

function scheduledSession(id: string, updatedAt: number, scheduleId: string): SessionView {
  return { ...session(id, updatedAt), automationOrigin: { kind: "scheduler", scheduleId } };
}

function schedule(id: string, history: ScheduleView["history"]): ScheduleView {
  return {
    id,
    name: id,
    backendId: "backend",
    targetId: "target",
    source: "user",
    sessionMode: "fresh",
    enabled: true,
    kind: "cron",
    expression: "0 0 * * *",
    timezone: "UTC",
    inputText: "Run",
    executionMode: "agent",
    permissionMode: "ask",
    planMode: false,
    useWorktree: false,
    refreshWorktreeRemote: false,
    extraDirectoryIds: [],
    silentWhenIdle: false,
    notifyDesktop: true,
    overlapPolicy: "queue",
    misfirePolicy: "runOnce",
    unreadRunCount: 0,
    history
  };
}
