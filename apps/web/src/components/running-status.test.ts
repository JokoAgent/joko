import { describe, expect, it } from "vitest";
import type { BackgroundTaskActivityView, TimelineItemView } from "../model.js";
import { activeBackgroundTaskIds, activeRunUsageSummary, formatRunningElapsed, latestRunningActivityLabel, resolveRunningUsageMeta } from "./running-status.js";

describe("session running status projection", () => {
  it("aggregates completed assistant segments in only the active run", () => {
    const items: TimelineItemView[] = [
      usageItem("a", "run-1", 400, 200, 2_000, true),
      usageItem("b", "run-1", 600, 300, 3_000, true),
      usageItem("c", "run-old", 9_000, 8_000, 1_000, true)
    ];
    expect(activeRunUsageSummary(items, "run-1")).toEqual({
      totalTokens: 1_000,
      outputTokens: 500,
      generationDurationMs: 5_000,
      generationReliable: true
    });
    expect(resolveRunningUsageMeta(activeRunUsageSummary(items, "run-1"))).toEqual({ kind: "rate", rate: "100" });
  });

  it("fails closed to token count if any output segment lacks proven timing", () => {
    const items = [usageItem("a", "run-1", 400, 200, 2_000, true), usageItem("b", "run-1", 600, 300, 0, false)];
    expect(resolveRunningUsageMeta(activeRunUsageSummary(items, "run-1"))).toEqual({ kind: "tokens" });
  });

  it("lets background work take over only after the foreground run is idle", () => {
    const tasks: BackgroundTaskActivityView[] = [
      { id: "one", sessionId: "session-1", state: "running" },
      { id: "two", sessionId: "session-1", state: "waiting" },
      { id: "done", sessionId: "session-1", state: "completed" },
      { id: "other", sessionId: "session-2", state: "running" }
    ];
    expect(activeBackgroundTaskIds(tasks, "session-1", false)).toEqual(["one", "two"]);
    expect(activeBackgroundTaskIds(tasks, "session-1", true)).toEqual([]);
  });

  it("selects the latest active status and formats elapsed time", () => {
    const items: TimelineItemView[] = [
      { id: "old", sequence: 1n, kind: "status", runId: "run-1", createdAt: 1, title: "Thinking", streaming: true },
      { id: "new", sequence: 2n, kind: "status", runId: "run-1", createdAt: 2, title: "Reading files", streaming: true }
    ];
    expect(latestRunningActivityLabel(items, "run-1")).toBe("Reading files");
    expect(formatRunningElapsed(65)).toBe("1m 5s");
  });
});

function usageItem(id: string, runId: string, totalTokens: number, outputTokens: number, generationDurationMs: number, generationReliable: boolean): TimelineItemView {
  return {
    id,
    runId,
    sequence: BigInt(id.charCodeAt(0)),
    kind: "assistant",
    createdAt: 1,
    text: id,
    usage: {
      inputTokens: totalTokens - outputTokens,
      outputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens,
      cost: 0,
      currency: "USD",
      generationDurationMs,
      generationReliable
    } as NonNullable<TimelineItemView["usage"]>
  };
}
