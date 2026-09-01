import { describe, expect, it } from "vitest";
import type { ScheduleRunHistoryView, ScheduleView } from "./model.js";
import { ScheduleNotificationTracker } from "./schedule-notifications.js";

describe("schedule notification tracker", () => {
  it("seeds without replay, owns the in-flight task edge, and emits one configured terminal notification", () => {
    const tracker = new ScheduleNotificationTracker();
    const running = schedule(run("run-one", "running"));
    const baseline = tracker.observe("owner", [running]);
    expect(baseline.notifications).toEqual([]);
    expect([...baseline.attentionOwnedSessionIds]).toEqual(["session-one"]);

    const completed = schedule(run("run-one", "completed", { finishedAt: 20 }));
    const terminal = tracker.observe("owner", [completed]);
    expect(terminal.notifications).toEqual([
      { title: "Daily check", kind: "done", sessionId: "session-one" }
    ]);
    expect([...terminal.attentionOwnedSessionIds]).toEqual(["session-one"]);
    expect(tracker.observe("owner", [completed]).notifications).toEqual([]);
  });

  it("honors per-schedule Desktop policy, treats silent success as born read, and never hides failures", () => {
    const tracker = new ScheduleNotificationTracker();
    const quiet = schedule(run("quiet", "running"), { notifyDesktop: true });
    const disabled = schedule(run("disabled", "running"), { id: "disabled", notifyDesktop: false });
    const failed = schedule(run("failed", "running"), { id: "failed", silentWhenIdle: true });
    tracker.observe("owner", [quiet, disabled, failed]);

    const observed = tracker.observe("owner", [
      schedule(run("quiet", "completed", { finishedAt: 30, readAt: 30 })),
      schedule(run("disabled", "failed", { finishedAt: 31 }), { id: "disabled", notifyDesktop: false }),
      schedule(run("failed", "failed", { finishedAt: 32 }), { id: "failed", silentWhenIdle: true })
    ]);
    expect(observed.notifications).toEqual([
      { title: "Daily check", kind: "error", sessionId: "session-one" }
    ]);
    expect([...observed.attentionOwnedSessionIds]).toEqual(["session-one"]);
  });

  it("keeps owner baselines isolated", () => {
    const tracker = new ScheduleNotificationTracker();
    tracker.observe("owner-a", [schedule(run("same", "running"))]);
    expect(tracker.observe("owner-a", [schedule(run("same", "failed", { finishedAt: 40 }))]).notifications)
      .toHaveLength(1);
    expect(tracker.observe("owner-b", [schedule(run("same", "failed", { finishedAt: 40 }))]).notifications)
      .toEqual([]);
  });
});

function run(
  id: string,
  state: ScheduleRunHistoryView["state"],
  extra: Partial<ScheduleRunHistoryView> = {}
): ScheduleRunHistoryView {
  return {
    id,
    runId: id,
    sessionId: "session-one",
    state,
    scheduledAt: 10,
    triggeredAt: 10,
    zeroCost: true,
    costAttribution: "zero",
    ...extra
  };
}

function schedule(
  history: ScheduleRunHistoryView,
  extra: Partial<ScheduleView> = {}
): ScheduleView {
  return {
    id: "schedule-one",
    name: "Daily check",
    source: "user",
    backendId: "backend",
    targetId: "target",
    sessionMode: "fresh",
    enabled: true,
    kind: "manual",
    expression: "",
    timezone: "UTC",
    inputText: "Inspect",
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
    history: [history],
    ...extra
  };
}
