import { describe, expect, it } from "vitest";
import { findMobileConversationSearchHits, nextConversationSearchIndex } from "./mobile-conversation-search";
import type { TimelineRow } from "./timeline";
import type { MobileWorkGroup } from "./mobile-work-projection";

const row = (id: string, text: string, extra: Partial<TimelineRow> = {}): TimelineRow => ({ id, eventId: `event/${id}`, label: "Reply",
  sequence: 1n, kind: "assistant", text, completed: true, ...extra });

describe("loaded conversation search", () => {
  it("finds one hit per collapsed parent and excludes pending and hidden inputs", () => {
    const child = row("child", "Alpha\n   beta");
    const group: MobileWorkGroup<TimelineRow> = { id: "work", eventId: "event/work", sequence: 1n, kind: "work", text: "", label: "Work",
      completed: true, streaming: false, children: [child, row("second", "ALPHA BETA")] };
    expect(findMobileConversationSearchHits([group, row("pending", "alpha beta", { optimistic: true }),
      row("internal", "alpha beta", { internalInput: true }), row("visible", "Alpha beta")], " aLpHa\tBETA ")).toEqual([
      { itemKey: "work", sourceKey: "child" }, { itemKey: "visible", sourceKey: "visible" }
    ]);
    expect(findMobileConversationSearchHits([group], " \n ")).toEqual([]);
  });

  it("searches loaded tool results and image names and keeps detached task cards in display order", () => {
    const tool = row("tool", "", { kind: "tool", tool: { scopeKey: "tool", name: "file.read", state: "succeeded", input: "Document",
      output: "Finished the document", error: "", inputTruncated: false, inputRedacted: false, outputTruncated: false } });
    const image = row("image", "", { images: [{ pageId: "image", title: "Document.png", mediaType: "image/png", byteSize: 1, sha256Hex: "a".repeat(64) }] });
    expect(findMobileConversationSearchHits([tool, image], "document", [{ itemKey: "delegated/task", sourceKey: "task", text: "Document analysis" }])).toEqual([
      { itemKey: "tool", sourceKey: "tool" }, { itemKey: "image", sourceKey: "image" }, { itemKey: "delegated/task", sourceKey: "task" }
    ]);
  });

  it("wraps in both directions and keeps an empty result non-navigable", () => {
    expect(nextConversationSearchIndex(3, 2, "next")).toBe(0);
    expect(nextConversationSearchIndex(3, 0, "previous")).toBe(2);
    expect(nextConversationSearchIndex(0, 0, "next")).toBe(-1);
  });
});
