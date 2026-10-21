import { expect, it } from "vitest";
import { NativeRemoteTaskTracker, remoteEntryToken, type NativeRemoteTaskObservation } from "./native-task-status.js";
function task(phase: NativeRemoteTaskObservation["phase"], notification: "none" | "pending" | "teammate" = "none", sourceId = "node:epoch1"): NativeRemoteTaskObservation {
  return { sessionId: "node/task", phase, updatedAt: 1, remote: { sourceId, runId: "run", silent: false, completionNotification: notification } };
}
it("seeds first waiting and terminal entries silently and only alerts on observed transitions", () => {
  for (const phase of ["interaction", "completed", "error"] as const) {
    const tracker = new NativeRemoteTaskTracker();
    expect(tracker.observe([task(phase)]).events).toEqual([]);
    expect(tracker.observe([task(phase)]).passive.has("node/task")).toBe(true);
  }
  const tracker = new NativeRemoteTaskTracker(); tracker.observe([task("running")]);
  expect(tracker.observe([task("interaction")]).events).toEqual([{ sessionId: "node/task", phase: "interaction" }]);
  expect(tracker.observe([task("completed")]).events).toEqual([{ sessionId: "node/task", phase: "completed" }]);
  expect(tracker.observe([{ ...task("completed"), updatedAt: 2 }]).events).toEqual([]);
});
it("waits for actual completion ownership and never revives an initial pending baseline", () => {
  const tracker = new NativeRemoteTaskTracker(); tracker.observe([task("running")]);
  expect(tracker.observe([task("completed", "pending")]).events).toEqual([]);
  expect(tracker.observe([task("completed")]).events).toHaveLength(1);
  expect(tracker.observe([task("completed")]).events).toEqual([]);
  const teammate = new NativeRemoteTaskTracker(); teammate.observe([task("running")]); teammate.observe([task("completed", "pending")]);
  expect(teammate.observe([task("completed", "teammate")]).events).toEqual([]);
  const baseline = new NativeRemoteTaskTracker(); baseline.observe([task("completed", "pending")]);
  expect(baseline.observe([task("completed")]).events).toEqual([]);
});
it("keeps errors timely while delivery is pending and preserves independent automation silence", () => {
  const tracker = new NativeRemoteTaskTracker(); tracker.observe([task("running", "pending")]);
  expect(tracker.observe([task("error", "pending")]).events).toHaveLength(1);
  tracker.observe([task("running")]); const completed = task("completed");
  expect(tracker.observe([{ ...completed, remote: { ...completed.remote!, silent: true } }]).events).toEqual([]);
});
it("baselines a new source incarnation and a removed then reappearing task", () => {
  const tracker = new NativeRemoteTaskTracker(); tracker.observe([task("running")]);
  expect(tracker.observe([task("completed", "none", "node:epoch2")]).events).toEqual([]);
  tracker.observe([]); expect(tracker.observe([task("interaction")]).events).toEqual([]);
});
it("dismisses only an unchanged clicked terminal and keeps its observation through summary updates", () => {
  const tracker = new NativeRemoteTaskTracker(); tracker.observe([task("running")]);
  const first = task("error"), other = { ...task("error"), sessionId: "node/other" };
  tracker.observe([first, other]); expect(tracker.dismiss(first, "stale")).toBe(false);
  expect(tracker.dismiss(first, remoteEntryToken(first))).toBe(true);
  const next = tracker.observe([{ ...first, updatedAt: 2 }, other]);
  expect([...next.dismissed]).toEqual(["node/task"]); expect(next.events).toEqual([]);
  tracker.observe([task("running"), other]); expect(tracker.observe([task("error"), other]).events).toHaveLength(1);
});
it("retains a live observed silent completion without inventing an unread task from an idle baseline", () => {
  const completed = task("completed");
  const silent = { ...completed, remote: { ...completed.remote!, silent: true, observedCompletionOnly: true } };
  const baseline = new NativeRemoteTaskTracker(); expect(baseline.observe([silent]).dismissed.has(silent.sessionId)).toBe(true);
  const live = new NativeRemoteTaskTracker(); live.observe([task("running")]);
  const receipt = live.observe([silent]); expect(receipt.dismissed.size).toBe(0); expect(receipt.events).toEqual([]); expect(receipt.passive.has(silent.sessionId)).toBe(true);
});
