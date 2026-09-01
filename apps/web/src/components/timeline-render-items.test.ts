import { describe, expect, it } from "vitest";
import type { TimelineItemView } from "../model.js";
import {
  MAX_RUNNING_WORK_CHILDREN,
  TIMELINE_WORK_HISTORY_GAP_MS,
  findTimelineRenderItemIndex,
  isTimelineWorkActivity,
  projectTimelineRenderItems,
  timelineRenderChildIndex,
  type TimelineWorkRenderItem
} from "./timeline-render-items.js";

describe("projectTimelineRenderItems", () => {
  it("uses the first durable child id as a deterministic work key", () => {
    const source = [
      timelineItem("user-1", "user", 1),
      timelineItem("thinking-1", "thinking", 2),
      timelineItem("tool-1", "tool", 3),
      timelineItem("answer-1", "assistant", 4)
    ] as const;

    const first = projectTimelineRenderItems(source);
    const second = projectTimelineRenderItems(source);

    expect(first).toEqual(second);
    expect(first.map((item) => item.key)).toEqual(["user-1", "thinking-1", "answer-1"]);
    expect(workAt(first, 1)).toMatchObject({
      firstChildId: "thinking-1",
      lastChildId: "tool-1",
      childIds: ["thinking-1", "tool-1"]
    });
    expect(source.map((item) => item.id)).toEqual(["user-1", "thinking-1", "tool-1", "answer-1"]);
  });

  it.each([
    "assistant",
    "user",
    "image",
    "artifact",
    "diff",
    "error",
    "interaction",
    "background",
    "compaction"
  ] as const)("flushes work on a %s boundary", (boundaryKind) => {
    const projected = projectTimelineRenderItems([
      timelineItem("before", "tool", 1),
      timelineItem("boundary", boundaryKind, 2),
      timelineItem("after", "thinking", 3)
    ]);

    expect(projected.map((item) => [item.type, item.key])).toEqual([
      ["work", "before"],
      ["item", "boundary"],
      ["work", "after"]
    ]);
  });

  it("groups only streamed statuses and leaves lifecycle statuses visible", () => {
    const streamingStatus = timelineItem("stream-status", "status", 1, { streaming: false });
    const lifecycleStatus = timelineItem("run-done", "status", 2);

    expect(isTimelineWorkActivity(streamingStatus)).toBe(true);
    expect(isTimelineWorkActivity(lifecycleStatus)).toBe(false);
    expect(projectTimelineRenderItems([
      timelineItem("thinking", "thinking", 0),
      streamingStatus,
      lifecycleStatus
    ]).map((item) => item.type)).toEqual(["work", "item"]);
  });

  it("keeps an inline plan out of the collapsed work group and preserves all covered anchors", () => {
    const plan = timelineItem("plan-latest", "toolResult", 2, {
      inlinePlan: {
        identity: "inline-plan:plan-first",
        source: "updatePlan",
        sourceItemIds: ["plan-first", "plan-latest"],
        steps: [{ id: "step-1", content: "Inspect", state: "inProgress" }]
      }
    });
    const projected = projectTimelineRenderItems([
      timelineItem("thinking", "thinking", 1),
      plan,
      timelineItem("tool-after", "tool", 3)
    ]);

    expect(isTimelineWorkActivity(plan)).toBe(false);
    expect(projected.map((item) => [item.type, item.key])).toEqual([
      ["work", "thinking"],
      ["item", "plan-latest"],
      ["work", "tool-after"]
    ]);
    expect(projected[1]?.childIds).toEqual(["plan-first", "plan-latest"]);
    expect(findTimelineRenderItemIndex(projected, "plan-first")).toBe(1);
  });

  it("marks only an active tail group running and exposes its latest five children", () => {
    const activities = Array.from({ length: 8 }, (_, index) =>
      timelineItem(`activity-${index + 1}`, index % 2 === 0 ? "thinking" : "tool", index + 2)
    );
    const projected = projectTimelineRenderItems(
      [timelineItem("user", "user", 1), ...activities],
      { sessionActive: true }
    );
    const work = workAt(projected, 1);

    expect(work.running).toBe(true);
    expect(work.defaultCollapsed).toBe(false);
    expect(work.visibleChildren.map((item) => item.id)).toEqual([
      "activity-4",
      "activity-5",
      "activity-6",
      "activity-7",
      "activity-8"
    ]);
    expect(work.visibleChildren).toHaveLength(MAX_RUNNING_WORK_CHILDREN);
    expect(work.hiddenChildCount).toBe(3);
    expect(work.children).toHaveLength(8);
  });

  it("keeps completed groups collapsed, including groups before an active tail boundary", () => {
    const completed = projectTimelineRenderItems([
      timelineItem("tool", "toolResult", 1),
      timelineItem("answer", "assistant", 2)
    ], { sessionActive: true });
    const work = workAt(completed, 0);

    expect(work).toMatchObject({
      running: false,
      defaultCollapsed: true,
      hiddenChildCount: 1,
      visibleChildren: []
    });
  });

  it("splits work across a missing-history interval and records the gap", () => {
    const projected = projectTimelineRenderItems([
      timelineItem("old-tool", "toolResult", 1),
      timelineItem("new-thinking", "thinking", TIMELINE_WORK_HISTORY_GAP_MS + 2)
    ]);

    expect(projected.map((item) => item.key)).toEqual(["old-tool", "new-thinking"]);
    expect(workAt(projected, 1).historyGapBefore).toEqual({
      previousItemId: "old-tool",
      nextItemId: "new-thinking",
      durationMs: TIMELINE_WORK_HISTORY_GAP_MS + 1
    });

    const contiguous = projectTimelineRenderItems([
      timelineItem("left", "tool", 1),
      timelineItem("right", "thinking", TIMELINE_WORK_HISTORY_GAP_MS + 1)
    ]);
    expect(contiguous).toHaveLength(1);
  });

  it("recovers child anchors after prepended history changes the group key", () => {
    const beforePrepend = projectTimelineRenderItems([
      timelineItem("old-anchor", "thinking", 2),
      timelineItem("tool", "tool", 3)
    ]);
    expect(beforePrepend[0]?.key).toBe("old-anchor");

    const afterPrepend = projectTimelineRenderItems([
      timelineItem("prepended", "toolResult", 1),
      timelineItem("old-anchor", "thinking", 2),
      timelineItem("tool", "tool", 3)
    ]);
    expect(afterPrepend[0]?.key).toBe("prepended");
    expect(findTimelineRenderItemIndex(afterPrepend, "old-anchor")).toBe(0);
    expect(findTimelineRenderItemIndex(afterPrepend, "missing")).toBe(-1);
    expect(timelineRenderChildIndex(afterPrepend).get("tool")).toBe(0);
  });
});

function timelineItem(
  id: string,
  kind: TimelineItemView["kind"],
  createdAt: number,
  overrides: Partial<TimelineItemView> = {}
): TimelineItemView {
  return {
    id,
    sequence: BigInt(createdAt),
    kind,
    createdAt,
    ...overrides
  };
}

function workAt(
  items: readonly ReturnType<typeof projectTimelineRenderItems>[number][],
  index: number
): TimelineWorkRenderItem {
  const item = items[index];
  expect(item?.type).toBe("work");
  return item as TimelineWorkRenderItem;
}
