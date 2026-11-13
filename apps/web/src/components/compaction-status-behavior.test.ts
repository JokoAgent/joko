import { describe, expect, it } from "vitest";
import type { TimelineItemView } from "../model.js";
import { hasContextToCompact, resolveActiveCompaction } from "./compaction-status-behavior.js";

describe("Pi compaction status projection", () => {
  it("permits another confirmed compaction of a surviving compacted context while its usage is unknown", () => {
    const completed = compaction("completed", 1n, "completed", "manual");
    const piBoundary = { ...completed, compaction: { ...completed.compaction!, piContextBoundary: true as const } };
    const noop = compaction("noop", 2n, "noOp", "manual");
    expect(hasContextToCompact(undefined, [completed, noop])).toBe(false);
    expect(hasContextToCompact(undefined, [piBoundary, noop])).toBe(true);
    expect(hasContextToCompact({ usedTokens: 0, contextWindow: 100, reservedTokens: 100, utilizationRatio: 0 }, [piBoundary])).toBe(false);
  });

  it("selects the latest open compaction lifecycle", () => {
    expect(resolveActiveCompaction([
      compaction("old", 1n, "completed", "manual"),
      compaction("current", 3n, "started", "overflow"),
      compaction("older", 2n, "started", "threshold")
    ])).toEqual({ itemId: "current", compactionId: "compact-current", reason: "overflow", automatic: true });
  });

  it.each(["completed", "noOp", "aborted", "failed"] as const)("clears when the latest lifecycle is %s", (state) => {
    expect(resolveActiveCompaction([
      compaction("start", 1n, "started", "manual"),
      compaction("end", 2n, state, "manual")
    ])).toBeUndefined();
  });

  it("lets authoritative Pi state clear a stale STARTED row after resnapshot", () => {
    expect(resolveActiveCompaction([
      compaction("stale", 1n, "started", "threshold")
    ], false)).toBeUndefined();
  });

  it("shows authoritative Pi compaction while its lifecycle event is still in flight", () => {
    expect(resolveActiveCompaction([], true)).toEqual({
      itemId: "authoritative-compaction",
      compactionId: "authoritative-compaction",
      reason: "unknown",
      automatic: false
    });
  });
});

function compaction(
  id: string,
  sequence: bigint,
  state: NonNullable<TimelineItemView["compaction"]>["state"],
  reason: NonNullable<TimelineItemView["compaction"]>["reason"]
): TimelineItemView {
  return {
    id,
    sequence,
    kind: "compaction",
    createdAt: Number(sequence),
    compaction: { id: `compact-${id}`, state, reason, automatic: reason !== "manual" }
  };
}
