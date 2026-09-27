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

  it("does not replay terminal runs that remain in an authoritative snapshot larger than the legacy cap", () => {
    const tracker = new ScheduleNotificationTracker();
    const schedules = Array.from({ length: 4_097 }, (_, index) => schedule(
      run(`run-${index}`, "failed", { finishedAt: 50 + index }),
      { id: `schedule-${index}` }
    ));

    expect(tracker.observe("owner", schedules).notifications).toEqual([]);
    expect(tracker.observe("owner", schedules).notifications).toEqual([]);
  });

  it("does not replay a terminal run that temporarily left the authoritative snapshot", () => {
    const tracker = new ScheduleNotificationTracker();
    const terminal = schedule(run("returning", "failed", { finishedAt: 60 }));

    expect(tracker.observe("owner", [terminal]).notifications).toEqual([]);
    expect(tracker.observe("owner", []).notifications).toEqual([]);
    expect(tracker.observe("owner", [terminal]).notifications).toEqual([]);
    expect(tracker.observe("owner", [terminal]).notifications).toEqual([]);
  });

  it("does not notify when an older terminal run first enters a bounded history window", () => {
    const tracker = new ScheduleNotificationTracker();
    const newest = run("200", "failed", { triggeredAt: 200, finishedAt: 210 });
    const older = run("100", "failed", { triggeredAt: 100, finishedAt: 110 });

    expect(tracker.observe("owner", [schedule(newest)]).notifications).toEqual([]);
    expect(tracker.observe("owner", [schedule(newest, { history: [newest, older] })]).notifications).toEqual([]);
  });

  it("notifies a genuinely newer coalesced terminal run once", () => {
    const tracker = new ScheduleNotificationTracker();
    const baseline = run("9007199254740992", "failed", { triggeredAt: 100, finishedAt: 110 });
    const newer = run("9007199254740993", "completed", { triggeredAt: 100, finishedAt: 120 });

    expect(tracker.observe("owner", [schedule(baseline)]).notifications).toEqual([]);
    expect(tracker.observe("owner", [schedule(newer, { history: [newer, baseline] })]).notifications).toEqual([
      { title: "Daily check", kind: "done", sessionId: "session-one" }
    ]);
    expect(tracker.observe("owner", [schedule(newer, { history: [newer, baseline] })]).notifications).toEqual([]);
  });

  it("seeds a schedule first observed after global hydration without replaying its terminal history", () => {
    const tracker = new ScheduleNotificationTracker();
    tracker.observe("owner", [schedule(run("run-a", "running"))]);
    const historical = run("run-z", "failed", { triggeredAt: 50, finishedAt: 60 });

    expect(tracker.observe("owner", [
      schedule(run("run-a", "running")),
      schedule(historical, { id: "schedule-later" })
    ]).notifications).toEqual([]);
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
