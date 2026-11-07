import { describe, expect, it, vi } from "vitest";
import type { ScheduleHistoryPageView, SchedulePreRunResultView, ScheduleRunHistoryView, ScheduleView } from "./model.js";
import { hasUnrecoveredScheduleFailure, ScheduleNotificationTracker } from "./schedule-notifications.js";

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

  it("honors per-schedule Desktop policy, treats silent success as born read, and notifies a first failure", () => {
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

  it("suppresses the same silent failure until recovery and still owns its task notification", () => {
    const tracker = new ScheduleNotificationTracker();
    const failure = (id: string, error = "Missing credentials") => run(id, "failed", { triggeredAt: Number(id), error });
    const observe = (first: ScheduleRunHistoryView, ...older: ScheduleRunHistoryView[]) =>
      tracker.observe("owner", [schedule(first, { silentWhenIdle: true, history: [first, ...older] })]);
    observe(run("0", "running", { triggeredAt: 0 }));
    const initial = failure("1");
    expect(observe(initial).notifications).toHaveLength(1);
    const repeated = failure("2");
    expect(observe(repeated, initial)).toEqual({ notifications: [], attentionOwnedSessionIds: new Set(["session-one"]) });
    const distinct = failure("3", "Model disabled");
    expect(observe(distinct, repeated, initial).notifications).toHaveLength(1);
    const recovered = run("4", "completed", { triggeredAt: 4, readAt: 5 });
    expect(observe(recovered, distinct, repeated, initial).notifications).toEqual([]);
    expect(observe(failure("5"), recovered, distinct, repeated, initial).notifications).toHaveLength(1);
  });

  it("treats a completed pre-run gate as recovery for an earlier pre-run failure", () => {
    const tracker = new ScheduleNotificationTracker();
    const blocked: SchedulePreRunResultView = { status: "failed", decision: "block", stderr: "Missing script",
      durationMs: 10, stdoutTruncated: false, stderrTruncated: false, timedOut: false, aborted: false };
    const first = run("1", "failed", { triggeredAt: 1, error: "Pre-run hook failed", preRun: blocked });
    const next = run("2", "failed", { triggeredAt: 2, error: first.error!, preRun: blocked });
    tracker.observe("owner", [schedule(first, { silentWhenIdle: true })]);
    expect(tracker.observe("owner", [schedule(next, { silentWhenIdle: true, history: [next, first] })]).notifications).toEqual([]);
    const skipped = run("3", "skipped", { triggeredAt: 3, preRun: { ...blocked, status: "skipped", decision: "skip", exitCode: 2 } });
    const failedAgain = run("4", "failed", { triggeredAt: 4, error: first.error!, preRun: blocked });
    expect(tracker.observe("owner", [schedule(failedAgain, { silentWhenIdle: true, history: [failedAgain, skipped, next, first] })])
      .notifications).toHaveLength(1);
  });

  it("checks older durable history when the owner snapshot has reached its limit", async () => {
    const tracker = new ScheduleNotificationTracker();
    const history = Array.from({ length: 100 }, (_, index) =>
      run(String(200 - index), "failed", { triggeredAt: 200 - index, error: "Other failure" }));
    tracker.observe("owner", [schedule(history[0]!, { silentWhenIdle: true, history })]);
    const latest = run("201", "failed", { triggeredAt: 201, error: "Missing credentials" });
    const recent = [latest, ...history.slice(0, 99)];
    const [candidate] = tracker.observe("owner", [schedule(latest, { silentWhenIdle: true, history: recent })]).notifications;
    expect(candidate?.failureHistory).toEqual({ scheduleId: "schedule-one", run: latest });
    const older = run("100", "failed", { triggeredAt: 100, error: "Missing credentials" });
    const readPage = vi.fn(async (token: string): Promise<ScheduleHistoryPageView> => token === ""
      ? { history: recent, nextPageToken: "older", totalSize: 101 }
      : { history: [older], totalSize: 101 });
    await expect(hasUnrecoveredScheduleFailure(latest, readPage, new AbortController().signal)).resolves.toBe(true);
    expect(readPage.mock.calls).toEqual([[""], ["older"]]);

    const retired = new AbortController();
    const firstPage = vi.fn(async () => {
      retired.abort();
      return { history: recent, nextPageToken: "older", totalSize: 101 };
    });
    await expect(hasUnrecoveredScheduleFailure(latest, firstPage, retired.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(firstPage).toHaveBeenCalledOnce();
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
