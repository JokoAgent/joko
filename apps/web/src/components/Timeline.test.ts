import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { translate } from "../i18n.js";
import type { TimelineItemView } from "../model.js";
import { AutomationOriginBadge, CollapsibleUserMessageContent, compactionTimelineCopy, windowedTextRows } from "./Timeline.js";
import { TimelineViewportStore, countUnreadTimelineItems, maximumTimelineSequence, mergeTimelineWindows, repairStreamingMarkdown, resolveTimelineFollowingOnScroll, resolveTimelineResizeScrollTop, shouldLoadEarlierTimeline, streamingMarkdownRenderValue, streamingMarkdownThrottleDelay, timelineJumpBehavior } from "./timeline-behavior.js";

describe("timeline following", () => {
  it("unpins on upward intent and resumes only on a downward return to the end", () => {
    expect(resolveTimelineFollowingOnScroll({ wasFollowing: true, distanceFromEnd: 20, scrollDelta: -2 })).toBe(true);
    expect(resolveTimelineFollowingOnScroll({ wasFollowing: false, distanceFromEnd: 20, scrollDelta: -2 })).toBe(false);
    expect(resolveTimelineFollowingOnScroll({ wasFollowing: false, distanceFromEnd: 20, scrollDelta: 2 })).toBe(true);
    expect(resolveTimelineFollowingOnScroll({ wasFollowing: false, distanceFromEnd: 120, scrollDelta: 20 })).toBe(false);
    expect(resolveTimelineFollowingOnScroll({ wasFollowing: true, distanceFromEnd: 400, scrollDelta: 0 })).toBe(true);
    expect(resolveTimelineFollowingOnScroll({ wasFollowing: true, distanceFromEnd: 400, scrollDelta: -2 })).toBe(false);
  });

  it("pins followers after resize while preserving a reader's visible row anchor", () => {
    expect(resolveTimelineResizeScrollTop({ following: true, currentScrollTop: 400, scrollHeight: 1_500, clientHeight: 500, anchorOffsetDelta: 0 })).toBe(1_000);
    expect(resolveTimelineResizeScrollTop({ following: false, currentScrollTop: 400, scrollHeight: 1_500, clientHeight: 500, anchorOffsetDelta: 36 })).toBe(436);
    expect(resolveTimelineResizeScrollTop({ following: false, currentScrollTop: 400, scrollHeight: 1_500, clientHeight: 500, anchorOffsetDelta: 0.2 })).toBe(400);
  });

  it("loads earlier pages only at the top", () => {
    expect(shouldLoadEarlierTimeline({ scrollTop: 56, hasEarlier: true, loading: false })).toBe(true);
    expect(shouldLoadEarlierTimeline({ scrollTop: 57, hasEarlier: true, loading: false })).toBe(false);
    expect(shouldLoadEarlierTimeline({ scrollTop: 0, hasEarlier: false, loading: false })).toBe(false);
    expect(shouldLoadEarlierTimeline({ scrollTop: 0, hasEarlier: true, loading: true })).toBe(false);
  });

  it("counts only newly appended durable rows as unread while detached", () => {
    const previous = new Set(["one"]);
    const items = [timelineItem("one", 1n), timelineItem("two", 2n), timelineItem("historical", 0n)];
    expect(countUnreadTimelineItems(previous, 1n, items, false)).toBe(1);
    expect(countUnreadTimelineItems(previous, 1n, items, true)).toBe(0);
    expect(maximumTimelineSequence(items)).toBe(2n);
  });
  it("restores A after A→B→A with its stable anchor and background unread growth", () => {
    const store = new TimelineViewportStore();
    const firstA = [timelineItem("a-1", 1n), timelineItem("a-2", 2n)];
    store.restore("session-a", firstA);
    store.save("session-a", { anchorItemId: "a-1", anchorOffset: -18, following: false, unreadCount: 1 }, firstA);
    store.restore("session-b", [timelineItem("b-1", 1n)]);
    store.save("session-b", { anchorItemId: "b-1", anchorOffset: 0, following: true, unreadCount: 0 }, [timelineItem("b-1", 1n)]);

    const restoredA = store.restore("session-a", [...firstA, timelineItem("a-3", 3n), timelineItem("historical", 0n)]);
    expect(restoredA).toMatchObject({ anchorItemId: "a-1", anchorOffset: -18, following: false, unreadCount: 2 });
    expect(restoredA.knownItemIds).toEqual(new Set(["a-1", "a-2", "a-3", "historical"]));
    expect(store.restore("session-b", [timelineItem("b-1", 1n), timelineItem("b-2", 2n)])).toMatchObject({ following: true, unreadCount: 0 });
  });

  it("merges a historical search window with recent live rows by stable identity and sequence", () => {
    const historical = [timelineItem("old", 1n), timelineItem("shared", 2n)];
    const recent = [{ ...timelineItem("shared", 2n), text: "live" }, timelineItem("new", 3n)];
    expect(mergeTimelineWindows(recent, historical).map((item) => [item.id, item.text])).toEqual([
      ["old", "old"],
      ["shared", "live"],
      ["new", "new"]
    ]);
  });
});

describe("streaming markdown", () => {
  it("temporarily closes an unfinished fence without changing completed markdown", () => {
    expect(repairStreamingMarkdown("before\n```ts\nconst value = 1;")).toBe("before\n```ts\nconst value = 1;\n```");
    const complete = "**bold**\n\n```ts\nconst value = 1;\n```";
    expect(repairStreamingMarkdown(complete)).toBe(complete);
  });

  it("renders incomplete emphasis and destinations as safe temporary text", () => {
    expect(repairStreamingMarkdown("answer **part")).toBe("answer **part**");
    expect(repairStreamingMarkdown("see ![diagram](https://example.test/part")).toBe("see diagram");
    expect(repairStreamingMarkdown("see [docs](https://example.test/part")).toBe("see docs");
    expect(repairStreamingMarkdown("run `cmd **flag")).toBe("run `cmd **flag");
  });

  it("limits markdown parsing to a trailing 100ms cadence and flushes at the boundary", () => {
    expect(streamingMarkdownThrottleDelay(40, 0)).toBe(60);
    expect(streamingMarkdownThrottleDelay(100, 0)).toBe(0);
    expect(streamingMarkdownThrottleDelay(240, 200)).toBe(60);
    expect(streamingMarkdownRenderValue("latest", "throttled", true)).toBe("throttled");
    expect(streamingMarkdownRenderValue("latest", "throttled", false)).toBe("latest");
  });

  it("uses instant navigation for reduced motion", () => {
    expect(timelineJumpBehavior(true)).toBe("auto");
    expect(timelineJumpBehavior(false)).toBe("smooth");
  });
});

describe("long user messages", () => {
  it("renders a native keyboard button and a ten-line collapsed content region", () => {
    const text = Array.from({ length: 15 }, (_, index) => `line ${index + 1}`).join("\n");
    const markup = renderToStaticMarkup(createElement(CollapsibleUserMessageContent, {
      measureText: text,
      children: text,
      t: (key, values) => translate("en", key, values)
    }));

    expect(markup).toContain('<button type="button"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-controls=');
    expect(markup).toContain("Show full message");
  });

  it("leaves short user messages unwrapped by collapse affordances", () => {
    const markup = renderToStaticMarkup(createElement(CollapsibleUserMessageContent, {
      measureText: "short English 中文",
      children: "short English 中文",
      t: (key, values) => translate("en", key, values)
    }));

    expect(markup).toContain("short English 中文");
    expect(markup).not.toContain("<button");
  });

  it("uses a three-line automation clamp and renders a schedule focus badge", () => {
    const text = Array.from({ length: 5 }, (_, index) => `scheduled line ${index + 1}`).join("\n");
    const collapseMarkup = renderToStaticMarkup(createElement(CollapsibleUserMessageContent, {
      measureText: text,
      automation: true,
      children: text,
      t: (key, values) => translate("en", key, values)
    }));
    const badgeMarkup = renderToStaticMarkup(createElement(AutomationOriginBadge, {
      automationOrigin: { kind: "scheduler", scheduleId: "schedule/one", scheduleName: "Nightly" },
      t: (key, values) => translate("en", key, values)
    }));

    expect(collapseMarkup).toContain("Show full message");
    expect(badgeMarkup).toContain("Sent by automation &quot;Nightly&quot;");
    expect(badgeMarkup).toContain('title="View automation task"');
  });
});

describe("large tool output windowing", () => {
  it("bounds every virtual row even when the backend emits one enormous line", () => {
    const rows = windowedTextRows("x".repeat(641));
    expect(rows.map((row) => row.length)).toEqual([320, 320, 1]);
    expect(rows.every((row) => row.length <= 320)).toBe(true);
  });

  it("preserves empty lines as measurable virtual rows", () => {
    expect(windowedTextRows("first\n\nlast")).toEqual(["first", " ", "last"]);
    expect(windowedTextRows("")).toEqual([" "]);
  });
});

describe("typed compaction timeline copy", () => {
  it("localizes every durable terminal state without gateway-authored UI titles", () => {
    const english = (key: Parameters<typeof translate>[1], values?: Readonly<Record<string, string | number>>) => translate("en", key, values);
    const chinese = (key: Parameters<typeof translate>[1], values?: Readonly<Record<string, string | number>>) => translate("zh-CN", key, values);
    expect(compactionTimelineCopy(compactionItem("completed"), "en", english).title).toBe("Context compacted");
    expect(compactionTimelineCopy(compactionItem("noOp"), "zh-CN", chinese).title).toBe("无需压缩上下文");
    expect(compactionTimelineCopy(compactionItem("aborted"), "en", english).title).toBe("Compaction aborted");
    expect(compactionTimelineCopy(compactionItem("failed"), "zh-CN", chinese).title).toBe("上下文压缩失败");
  });

  it("formats typed token metadata at render time", () => {
    const t = (key: Parameters<typeof translate>[1], values?: Readonly<Record<string, string | number>>) => translate("en", key, values);
    expect(compactionTimelineCopy({
      ...compactionItem("completed"),
      compaction: { ...compactionItem("completed").compaction!, tokensBefore: 12_345, tokensAfter: 2_345 }
    }, "en", t).detail).toBe("12,345 → 2,345 tokens");
  });
});

function timelineItem(id: string, sequence: bigint): TimelineItemView {
  return { id, sequence, kind: "assistant", createdAt: Number(sequence), text: id };
}

function compactionItem(state: NonNullable<TimelineItemView["compaction"]>["state"]): TimelineItemView {
  return { id: `compact-${state}`, sequence: 1n, kind: "compaction", createdAt: 1, compaction: { id: "compact-1", state, reason: "manual", automatic: false } };
}
