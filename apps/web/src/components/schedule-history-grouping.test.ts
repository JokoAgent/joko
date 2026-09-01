import { describe, expect, it } from "vitest";

import type { ScheduleRunHistoryView } from "../model.js";
import { groupScheduleHistoryRuns } from "./schedule-history-grouping.js";

describe("Schedule history grouping", () => {
  it("names standalone and Session groups in disjoint key namespaces", () => {
    const standalone = run("session:shared", "");
    const grouped = run("grouped", "shared");

    expect(groupScheduleHistoryRuns([standalone, grouped], true).map((entry) => entry.key)).toEqual([
      "run:session:shared",
      "session:shared"
    ]);
    expect(groupScheduleHistoryRuns([standalone], false)[0]?.key).toBe("run:session:shared");
  });
});

function run(id: string, sessionId: string): ScheduleRunHistoryView {
  return {
    id,
    runId: `run-${id}`,
    sessionId,
    state: "completed",
    scheduledAt: 1,
    triggeredAt: 1,
    finishedAt: 2,
    durationMs: 1,
    zeroCost: true,
    costAttribution: "zero",
    readAt: 2
  };
}
