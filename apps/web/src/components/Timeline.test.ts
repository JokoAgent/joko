import { unicodeCorpus } from "../i18n/test-corpus.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { translate } from "../i18n.js";
import type { TimelineItemView } from "../model.js";
import { AutomationOriginBadge, CollapsibleUserMessageContent, compactionTimelineCopy, windowedTextRows } from "./Timeline.js";
import { TimelineViewportStore, countUnreadTimelineItems, maximumTimelineSequence, mergeTimelineWindows, repairStreamingMarkdown, resolveTimelineFollowingOnScroll, resolveTimelineResizeScrollTop, shouldLoadEarlierTimeline, streamingMarkdownRenderValue, streamingMarkdownThrottleDelay, timelineJumpBehavior, timelineUnreadItemIds } from "./timeline-behavior.js";
import { projectTimelineRenderItems } from "./timeline-render-items.js";

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

  it("counts only newly appended durable messages as unread while detached", () => {
    const previous = timelineUnreadItemIds([timelineItem("one", 1n)]);
    const items = [timelineItem("one", 1n), timelineItem("two", 2n), timelineItem("historical", 0n)];
    expect(countUnreadTimelineItems(previous, 1n, items, false)).toBe(1);
    expect(countUnreadTimelineItems(previous, 1n, items, true)).toBe(0);
    expect(maximumTimelineSequence(items)).toBe(2n);
  });

  it("counts logical messages once without treating activity, local input or replacement history as arrivals", () => {
    const baseline: readonly TimelineItemView[] = [
      { ...timelineItem("one-text", 1n), messageId: "one" },
      { ...timelineItem("activity", 2n), kind: "status" }
    ];
    const arrivals: readonly TimelineItemView[] = [
      { ...timelineItem("one-final", 3n), messageId: "one" },
      { ...timelineItem("two-text", 4n), messageId: "two", streaming: true },
      { ...timelineItem("two-second-text", 5n), messageId: "two", contentIndex: 2 },
      { ...timelineItem("question-row", 6n), kind: "interaction", interaction: { id: "question", kind: "question", state: "pending", title: "Question", prompt: "Choose", questions: [] } },
      { ...timelineItem("question-resolution", 7n), kind: "interaction", interaction: { id: "question", kind: "question", state: "resolved", title: "Question", prompt: "Choose", questions: [] } },
      { ...timelineItem("plan", 8n), kind: "interaction", interaction: { id: "plan", kind: "plan", state: "pending", title: "Plan", prompt: "Review", questions: [] } },
      { ...timelineItem("permission", 9n), kind: "interaction", interaction: { id: "permission", kind: "permission", state: "pending", title: "Permission", prompt: "Approve", questions: [] } },
      { ...timelineItem("local", 10n), kind: "user", localUserInput: true },
      { ...timelineItem("external", 11n), kind: "user" },
      { ...timelineItem("automatic", 12n), kind: "user", automaticContinuation: { recoveryId: "recovery" } },
      ...(["thinking", "tool", "toolResult", "status", "background", "review"] as const).map((kind, index) => ({ ...timelineItem(kind, BigInt(13 + index)), kind }))
    ];
    const previous = timelineUnreadItemIds(baseline);
    expect(countUnreadTimelineItems(previous, 2n, [...baseline, ...arrivals], false)).toBe(4);
    expect(countUnreadTimelineItems(previous, 2n, [...baseline, ...arrivals], true)).toBe(0);
    expect(countUnreadTimelineItems(new Set(), undefined, [...baseline, ...arrivals], false)).toBe(0);
    expect(countUnreadTimelineItems(previous, 2n, [timelineItem("replacement", 20n)], false)).toBe(0);
    expect(countUnreadTimelineItems(previous, 2n, [timelineItem("history", 0n), baseline[1]!, timelineItem("tail", 20n)], false)).toBe(1);
    expect(countUnreadTimelineItems(timelineUnreadItemIds([...baseline, ...arrivals]), 18n, [...baseline, ...arrivals, { ...timelineItem("two-complete", 19n), messageId: "two" }], false)).toBe(0);
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

describe("activity history windows", () => {
  it("recovers older activity anchors without replacing current content or inventing gaps", () => {
    const minute = 60_000;
    const recent: readonly TimelineItemView[] = [
      { ...timelineItem("long", 4n), kind: "toolResult", createdAt: 40 * minute, endedAt: 40 * minute + 125,
        tool: { id: "long", name: "read", state: "succeeded", input: "", output: "Current result", isError: false } },
      { ...timelineItem("thinking", 10n), kind: "thinking", messageId: "message", contentIndex: 0,
        createdAt: 82 * minute + 125, text: "Complete thinking", streaming: false },
      { ...timelineItem("after-thinking", 11n), kind: "tool", createdAt: 83 * minute, endedAt: 83 * minute + 125 },
      { ...timelineItem("gap", 12n), kind: "tool", createdAt: 114 * minute + 125 }
    ];
    const historical: readonly TimelineItemView[] = [
      { ...timelineItem("user", 1n), kind: "user", createdAt: 0 },
      { ...timelineItem("long", 2n), kind: "tool", createdAt: 0,
        tool: { id: "long", name: "read", state: "running", input: "Original input", output: "Old output", isError: false } },
      { ...timelineItem("thinking", 8n), kind: "thinking", messageId: "message", contentIndex: 0,
        createdAt: 42 * minute, lastActivityAt: 82 * minute, text: "An earlier delta", streaming: true }
    ];
    const merged = mergeTimelineWindows(recent, historical);
    expect(merged.find((item) => item.id === "long")).toMatchObject({
      sequence: 2n, createdAt: 0, endedAt: 40 * minute + 125, kind: "toolResult",
      tool: { state: "succeeded", output: "Current result" }
    });
    expect(merged.find((item) => item.id === "thinking")).toMatchObject({
      sequence: 8n, createdAt: 42 * minute, lastActivityAt: 82 * minute, text: "Complete thinking", streaming: false
    });
    const latePage = mergeTimelineWindows(merged, [{ ...historical[2]!, sequence: 9n,
      createdAt: 81 * minute, lastActivityAt: 81 * minute }]);
    expect(latePage).toEqual(merged);
    const rows = projectTimelineRenderItems(latePage);
    expect(rows.map((row) => row.childIds)).toEqual([["user"], ["long", "thinking", "after-thinking"], ["gap"]]);
    expect(rows.filter((row) => row.historyGapBefore)).toHaveLength(1);
    const unrelated = { ...recent[1]!, messageId: "another-message", lastActivityAt: undefined };
    expect(mergeTimelineWindows([unrelated], [historical[2]!])[0]).toBe(unrelated);
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
      measureText: unicodeCorpus.shortMixedScriptText,
      children: unicodeCorpus.shortMixedScriptText,
      t: (key, values) => translate("en", key, values)
    }));

    expect(markup).toContain(unicodeCorpus.shortMixedScriptText);
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
    expect(compactionTimelineCopy(compactionItem("noOp"), "zh-CN", chinese).title).toBe(chinese("timeline.compactionNoOp"));
    expect(compactionTimelineCopy(compactionItem("aborted"), "en", english).title).toBe("Compaction aborted");
    expect(compactionTimelineCopy(compactionItem("failed"), "zh-CN", chinese).title).toBe(chinese("timeline.compactionFailed"));
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
