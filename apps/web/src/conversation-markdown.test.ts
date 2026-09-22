import { describe, expect, it, vi } from "vitest";
import type { TimelineHistoryCursorView, TimelineHistoryPageView, TimelineItemView } from "./model.js";
import { collectConversationMarkdown, ConversationMarkdownError } from "./conversation-markdown.js";

const labels = { user: "You", assistant: "Agent" };
const cursor = (sequence: bigint): TimelineHistoryCursorView => ({ opaqueToken: `cursor-${sequence}`, sequence, generation: 1n });
const item = (id: string, kind: "user" | "assistant", sequence: bigint, text: string, streaming = false): TimelineItemView => ({
  id, kind, sequence, text, streaming, createdAt: 1
});

describe("complete conversation Markdown", () => {
  it("reads every page and preserves message order and complete text across event boundaries", async () => {
    const load = vi.fn(async (_sessionId: string, before?: TimelineHistoryCursorView): Promise<TimelineHistoryPageView> => before === undefined
      ? { items: [item("answer", "assistant", 6n, "The complete answer"), item("second", "user", 7n, "Second question")], nextBeforeCursor: cursor(5n) }
      : { items: [item("first", "user", 1n, "First question"), item("answer", "assistant", 2n, "Partial ", true)] });
    await expect(collectConversationMarkdown("task", load, () => true, labels)).resolves.toBe(
      "## You\n\nFirst question\n\n## Agent\n\nThe complete answer\n\n## You\n\nSecond question"
    );
    expect(load).toHaveBeenNthCalledWith(1, "task", undefined, 500);
    expect(load).toHaveBeenNthCalledWith(2, "task", cursor(5n), 500);
  });

  it("joins streaming text fragments and excludes internal continuation prompts", async () => {
    const continuation = { ...item("internal", "user", 1n, "Private retry prompt"), automaticContinuation: { recoveryId: "recovery" } };
    const load = vi.fn(async (_sessionId: string, before?: TimelineHistoryCursorView): Promise<TimelineHistoryPageView> => before === undefined
      ? { items: [item("answer", "assistant", 5n, " world", true)], nextBeforeCursor: cursor(4n) }
      : { items: [continuation, item("answer", "assistant", 2n, "Hello", true)] });
    await expect(collectConversationMarkdown("task", load, () => true, labels)).resolves.toBe("## Agent\n\nHello world");
  });

  it("returns no text for empty history and refuses a repeated cursor or an oversized result", async () => {
    await expect(collectConversationMarkdown("task", async () => ({ items: [] }), () => true, labels)).resolves.toBeUndefined();
    const repeated = vi.fn(async () => ({ items: [], nextBeforeCursor: cursor(5n) }));
    await expect(collectConversationMarkdown("task", repeated, () => true, labels)).rejects.toMatchObject({ reason: "pagination" });
    expect(repeated).toHaveBeenCalledTimes(2);
    await expect(collectConversationMarkdown("task", async () => ({ items: [item("huge", "user", 1n, "x".repeat(17 * 1024 * 1024))] }), () => true, labels))
      .rejects.toMatchObject({ reason: "too-large" });
  });

  it("discards a response after its owner retires", async () => {
    let current = true;
    let resolvePage!: (page: TimelineHistoryPageView) => void;
    const load = () => new Promise<TimelineHistoryPageView>((resolve) => { resolvePage = resolve; });
    const result = collectConversationMarkdown("task", load, () => current, labels);
    current = false;
    resolvePage({ items: [item("one", "user", 1n, "Do not copy")] });
    await expect(result).rejects.toBeInstanceOf(ConversationMarkdownError);
  });
});
