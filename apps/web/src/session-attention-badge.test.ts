import { describe, expect, it } from "vitest";

import type { SessionView, TimelineHistoryCursorView } from "./model.js";
import {
  MAXIMUM_SESSION_ATTENTION_BADGE_KEYS,
  reconcileSessionAttentionBadgeProjection
} from "./session-attention-badge.js";

describe("desktop session-attention badge projection", () => {
  it("marks only durable unread task keys and clears the exact key when it becomes read", () => {
    const unread = session("task-a", true);
    const read = session("task-b", false);
    const first = reconcileSessionAttentionBadgeProjection(new Map(), "owner-a", [unread, read]);
    expect(first.marks).toEqual([{ ownerId: "owner-a", sessionId: "task-a" }]);
    expect(first.clears).toEqual([]);

    const second = reconcileSessionAttentionBadgeProjection(first.next, "owner-a", [session("task-a", false), read]);
    expect(second.marks).toEqual([]);
    expect(second.clears).toEqual([{ ownerId: "owner-a", sessionId: "task-a" }]);
    expect(unread.attention?.unread).toBe(true);
  });

  it("fences identical task ids by exact owner and clears the old owner on a switch", () => {
    const first = reconcileSessionAttentionBadgeProjection(new Map(), "owner-a", [session("same", true)]);
    const second = reconcileSessionAttentionBadgeProjection(first.next, "owner-b", [session("same", true)]);
    expect(second.clears).toEqual([{ ownerId: "owner-a", sessionId: "same" }]);
    expect(second.marks).toEqual([{ ownerId: "owner-b", sessionId: "same" }]);
  });

  it("bounds the renderer projection before invoking the native bridge", () => {
    const sessions = Array.from(
      { length: MAXIMUM_SESSION_ATTENTION_BADGE_KEYS + 1 },
      (_, index) => session(`task-${index}`, true)
    );
    const projection = reconcileSessionAttentionBadgeProjection(new Map(), "owner", sessions);
    expect(projection.marks).toHaveLength(MAXIMUM_SESSION_ATTENTION_BADGE_KEYS);
    expect(projection.marks.at(-1)?.sessionId).toBe(`task-${MAXIMUM_SESSION_ATTENTION_BADGE_KEYS - 1}`);
  });
});

function session(id: string, unread: boolean): SessionView {
  const cursor: TimelineHistoryCursorView = { opaqueToken: `cursor-${id}`, sequence: 1n, generation: 0n };
  return {
    id,
    targetId: "target",
    backendId: "backend",
    name: id,
    state: "idle",
    updatedAt: 1,
    archived: false,
    pinned: false,
    generation: 0n,
    fastMode: false,
    permissionMode: "ask",
    planMode: false,
    attention: {
      kind: "done",
      unread,
      subjectCursor: cursor,
      attentionCursor: cursor,
      readThroughCursor: { opaqueToken: "read", sequence: 0n, generation: 0n },
      updatedAt: 1
    }
  };
}
