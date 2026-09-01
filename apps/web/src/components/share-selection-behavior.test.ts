import { describe, expect, it } from "vitest";
import type { TimelineItemView } from "../model.js";
import { orderedSelectedShareMessages, reconcileShareSelection, shareableTimelineMessages, toggleShareMessageSelection } from "./share-selection-behavior.js";

describe("share message selection", () => {
  const items: readonly TimelineItemView[] = [
    item("user-1", "user", "one"),
    item("tool", "tool", "hidden"),
    item("assistant-1", "assistant", "two"),
    { ...item("assistant-stream", "assistant", "partial"), streaming: true },
    item("user-2", "user", "three"),
    item("empty", "assistant", "")
  ];

  it("selects only completed user/assistant content and keeps timeline order", () => {
    expect(shareableTimelineMessages(items).map((candidate) => candidate.id)).toEqual(["user-1", "assistant-1", "user-2"]);
    expect(orderedSelectedShareMessages(items, new Set(["user-2", "user-1"])).map((candidate) => candidate.id)).toEqual(["user-1", "user-2"]);
  });

  it("extends an inclusive range and removes an already-complete range", () => {
    const ids = ["user-1", "assistant-1", "user-2"];
    const first = toggleShareMessageSelection(ids, new Set(), "user-1", false);
    const extended = toggleShareMessageSelection(ids, first.selectedIds, "user-2", true, first.anchorId);
    expect([...extended.selectedIds]).toEqual(ids);
    expect([...toggleShareMessageSelection(ids, extended.selectedIds, "user-2", true, extended.anchorId).selectedIds]).toEqual([]);
  });

  it("drops unavailable rows without retaining a stale range anchor", () => {
    expect(reconcileShareSelection(["user-2"], new Set(["user-1", "user-2"]), "user-1")).toEqual({ selectedIds: new Set(["user-2"]) });
  });
});

function item(id: string, kind: TimelineItemView["kind"], text: string): TimelineItemView {
  return { id, kind, text, sequence: BigInt(id.length), createdAt: id.length };
}
