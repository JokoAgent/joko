import { describe, expect, it } from "vitest";
import type { BackgroundTaskHistoryView, TimelineItemView } from "../model.js";
import { backgroundTaskDuration, isActiveBackgroundTask, projectBackgroundTaskGroups } from "./background-task-panel.js";

describe("background task panel projection", () => {
  it("groups current state, keeps running start order, and sorts terminal tasks by completion", () => {
    const groups = projectBackgroundTaskGroups([
      item("alpha-old", 1n, 10, { id: "alpha", title: "Alpha", state: "queued", startedAt: 10 }),
      item("done", 4n, 40, { id: "done", title: "Done", state: "completed", startedAt: 5, endedAt: 35 }),
      item("alpha-new", 3n, 60, { id: "alpha", title: "Alpha", state: "running", detail: "Working", startedAt: 10, updatedAt: 60 }),
      item("waiting", 5n, 50, { id: "waiting", title: "Waiting", state: "waiting", startedAt: 20 }),
      item("failed", 2n, 20, { id: "failed", title: "Failed", state: "failed", startedAt: 1, endedAt: 45 })
    ]);

    expect(groups.running.map((task) => [task.id, task.state])).toEqual([
      ["alpha", "running"],
      ["waiting", "waiting"]
    ]);
    expect(groups.finished.map((task) => task.id)).toEqual(["failed", "done"]);
    expect(groups.running.find((task) => task.id === "alpha")?.detail).toBe("Working");
  });

  it("uses authoritative task timestamps for terminal and active durations", () => {
    const [active] = projectBackgroundTaskGroups([item("active", 1n, 1_000, {
      id: "active",
      title: "Active",
      state: "running",
      startedAt: 2_000
    })]).running;
    const [terminal] = projectBackgroundTaskGroups([item("terminal", 1n, 1_000, {
      id: "terminal",
      title: "Terminal",
      state: "completed",
      startedAt: 2_000,
      endedAt: 5_500
    })]).finished;

    expect(active === undefined ? undefined : backgroundTaskDuration(active, 8_000)).toBe(6_000);
    expect(terminal === undefined ? undefined : backgroundTaskDuration(terminal, 99_000)).toBe(3_500);
  });

  it("merges complete durable history with newer live observations without dropping unseen tasks", () => {
    const history: BackgroundTaskHistoryView[] = [historyTask("durable-only", "completed", 10, 20, 2n), historyTask("shared", "running", 10, 50, 5n)];
    const groups = projectBackgroundTaskGroups([
      item("shared-old", 4n, 10, { id: "shared", title: "Shared", state: "queued", updatedAt: 40 }),
      item("shared-new", 6n, 10, { id: "shared", title: "Shared", state: "completed", endedAt: 60, updatedAt: 60 })
    ], history);

    expect(groups.running).toEqual([]);
    expect(groups.finished.map((task) => task.id)).toEqual(["shared", "durable-only"]);
    expect(groups.finished[0]).toMatchObject({ state: "completed", endedAt: 60 });
  });

  it("exposes cancellation only for the three non-terminal states", () => {
    expect(["queued", "running", "waiting"].map((state) => isActiveBackgroundTask({ state: state as "queued" | "running" | "waiting" }))).toEqual([true, true, true]);
    expect(["completed", "failed", "aborted", "unknown"].map((state) => isActiveBackgroundTask({ state: state as "completed" | "failed" | "aborted" | "unknown" }))).toEqual([false, false, false, false]);
  });
});

function item(id: string, sequence: bigint, createdAt: number, background: NonNullable<TimelineItemView["background"]>): TimelineItemView {
  return { id, sequence, createdAt, kind: "background", background };
}

function historyTask(id: string, state: BackgroundTaskHistoryView["state"], createdAt: number, updatedAt: number, revision: bigint): BackgroundTaskHistoryView {
  return {
    id,
    backendId: "backend",
    targetId: "target",
    sessionId: "session",
    title: id,
    state,
    createdAt,
    updatedAt,
    revision
  };
}
