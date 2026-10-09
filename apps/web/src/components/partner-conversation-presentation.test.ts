import { describe, expect, it } from "vitest";
import type { TimelineItemView } from "../model.js";
import { firstUnreadPartnerReply, formatPartnerTimeGroup, latestVisiblePartnerReplyCursor, partnerTimeGroupStarts, simplifyPartnerRenderItems } from "./partner-conversation-presentation.js";
import { projectTimelineRenderItems } from "./timeline-render-items.js";

const origin = { messageId: "private-message", threadId: "private-thread", senderPartnerId: "sender", recipientPartnerId: "recipient", senderDisplayName: "Sender" };
const item = (id: string, kind: TimelineItemView["kind"], extra: Partial<TimelineItemView> = {}): TimelineItemView => ({ id, kind, sequence: 1n, createdAt: 1_000, runId: "run", ...extra });
const simplify = (items: readonly TimelineItemView[], active = false) => simplifyPartnerRenderItems(projectTimelineRenderItems(items, { sessionActive: active }), active);
const ids = (rows: ReturnType<typeof simplify>) => rows.map((row) => row.key);

describe("Partner conversation presentation", () => {
  it("does not mistake completed streaming segments for a sealed turn and keeps contiguous final prose", () => {
    const prompt = item("prompt", "user", { inputDelivery: "prompt" });
    const progress = item("progress", "assistant", { text: "Let me check.", streaming: false, completionCursor: 11n });
    const tool = item("tool", "tool", { tool: { id: "tool", name: "read", state: "succeeded", input: "", isError: false } });
    const first = item("answer-one", "assistant", { text: "Answer part one.", streaming: false, completionCursor: 13n });
    const second = item("answer-two", "assistant", { text: "Answer part two.", streaming: false, completionCursor: 14n });
    const source = [prompt, progress, tool, first, second];
    expect(ids(simplify(source, true))).toEqual(["prompt"]);
    expect(ids(simplify([...source, item("seal", "status", { runTerminal: "completed" })], true))).toEqual(["prompt", "answer-one", "answer-two", "seal"]);
    expect(source[1]).toBe(progress);
    expect(progress.text).toBe("Let me check.");
  });

  it("keeps the last useful answer after stop/error without resurrecting delivery preambles", () => {
    const prose = item("preamble", "assistant", { text: "Here is the output." });
    const file = item("file", "artifact", { artifact: artifact() });
    const stopped = item("stopped", "status", { runTerminal: "aborted" });
    expect(ids(simplify([prose, file, stopped]))).toEqual(["file", "stopped"]);
    expect(ids(simplify([prose, file, item("later", "assistant", { text: "This part remains incomplete." }), item("error", "error")]))).toEqual(["file", "later", "error"]);
  });

  it("preserves separate history-window answers and carries gaps through hidden work", () => {
    const earlier = item("earlier", "assistant", { text: "Previous answer." });
    const thinking = item("thinking", "thinking", { createdAt: 31 * 60_000 });
    const recent = item("recent", "assistant", { text: "Still working.", createdAt: 31 * 60_000 + 1 });
    const question = item("question", "interaction", { createdAt: 31 * 60_000 + 2 });
    const rows = simplify([earlier, thinking, recent, question], true);
    expect(ids(rows)).toEqual(["earlier", "question"]);
    expect(rows[1]?.historyGapBefore?.previousItemId).toBe("earlier");
  });

  it("keeps verified media, artifacts, questions, private origins and terminal notices while dropping raw activity", () => {
    const media = item("media", "toolResult", { attachments: [artifact()], tool: { id: "media", name: "produce", state: "succeeded", input: "Internal tool input", output: "Tool output", isError: false } });
    const source = [item("continuation", "user", { automaticContinuation: { recoveryId: "recovery" } }),
      item("private", "user", { partnerPrivateOrigin: origin, text: "Internal instruction" }), media,
      item("image", "assistant", { text: "![result](https://example.test/result.png)", streaming: false }),
      item("question", "interaction"), item("terminal", "status", { runTerminal: "failed" })];
    const rows = simplify(source, true);
    expect(ids(rows)).toEqual(["private", "media", "image", "question", "terminal"]);
    expect(rows[1]).toMatchObject({ type: "item", item: { kind: "assistant", text: "", attachments: [artifact()] } });
    if (rows[1]?.type === "item") expect(rows[1].item.tool).toBeUndefined();
    expect(media.tool?.input).toBe("Internal tool input");
  });

  it("does not count code, math, unsupported HTML or unsafe image URLs as delivery", () => {
    for (const text of ["`![fake](image.png)`", "```md\n![fake](image.png)\n```", "$x + \\text{![fake](image.png)}$", "<img src='image.png'>", "![fake](javascript:alert)"]) {
      expect(ids(simplify([item("fake", "assistant", { text, streaming: false })], true))).toEqual([]);
    }
    expect(ids(simplify([item("ref", "assistant", { text: "![output][image]\n\n[image]: https://example.test/image.png", streaming: false })], true))).toEqual(["ref"]);
  });

  it("uses completed global cursors for the frozen public unread boundary and excludes private replies", () => {
    const rows = simplify([item("private", "assistant", { text: "Private reply", partnerPrivateOrigin: origin, completionCursor: 90n }),
      item("prompt", "user"), item("final", "assistant", { text: "Public answer", sequence: 2n, completionCursor: 100n }),
      item("terminal", "status", { runTerminal: "completed" })]);
    expect(firstUnreadPartnerReply(rows, 99n)).toBe("final");
    expect(firstUnreadPartnerReply(rows, 100n)).toBeUndefined();
    expect(firstUnreadPartnerReply(rows, undefined)).toBeUndefined();
    expect(latestVisiblePartnerReplyCursor(rows)).toBe(100n);
    expect(latestVisiblePartnerReplyCursor(simplify([item("private", "assistant", { text: "Private", partnerPrivateOrigin: origin, completionCursor: 90n })]))).toBeUndefined();
  });

  it("groups only rendered messages into five-minute windows and formats dates in the selected locale", () => {
    const time = new Date(2026, 9, 9, 10, 0).getTime();
    const rows = simplify([item("one", "user", { createdAt: time }), item("private", "user", { createdAt: time + 1, partnerPrivateOrigin: origin }),
      item("two", "user", { createdAt: time + 299_999 }), item("three", "user", { createdAt: time + 300_000 }), item("invalid", "user", { createdAt: 0 })]);
    expect([...partnerTimeGroupStarts(rows)]).toEqual([["one", time], ["three", time + 300_000]]);
    expect(formatPartnerTimeGroup(time, "en", time)).not.toMatch(/2026|Oct/);
    expect(formatPartnerTimeGroup(time, "en", new Date(2027, 1, 1).getTime())).toContain("2026");
  });
});

function artifact(): NonNullable<TimelineItemView["artifact"]> { return { id: "artifact", blobId: "blob", title: "Output", fileName: "output.png", kind: "image", sourceRevealAvailable: false, mediaType: "image/png", byteSize: 4 }; }
