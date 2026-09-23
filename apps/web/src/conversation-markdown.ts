import type { TimelineHistoryCursorView, TimelineHistoryPageView, TimelineItemView } from "./model.js";
import { projectRuntimeRecoveryTimeline } from "./runtime-recovery.js";
import { visibleSelectionQuoteMessageText } from "./selection-quote.js";

const PAGE_SIZE = 500;
const MAX_PAGES = 1_000;
const MAX_MARKDOWN_LENGTH = 8 * 1024 * 1024;

export class ConversationMarkdownError extends Error {
  constructor(readonly reason: "pagination" | "too-large" | "stale") {
    super(`Cannot copy the conversation: ${reason}.`);
  }
}

/** Read the complete durable timeline before constructing anything for the clipboard. */
export async function collectConversationMarkdown(
  sessionId: string,
  loadPage: (sessionId: string, beforeCursor?: TimelineHistoryCursorView, limit?: number) => Promise<TimelineHistoryPageView>,
  isCurrent: () => boolean,
  labels: { readonly user: string; readonly assistant: string }
): Promise<string | undefined> {
  const pages: Array<readonly TimelineItemView[]> = [];
  const seenCursors = new Set<string>();
  let beforeCursor: TimelineHistoryCursorView | undefined;
  let projectedLength = 0;
  for (;;) {
    if (!isCurrent()) throw new ConversationMarkdownError("stale");
    const page = await loadPage(sessionId, beforeCursor, PAGE_SIZE);
    if (!isCurrent()) throw new ConversationMarkdownError("stale");
    pages.push(page.items);
    for (const item of page.items) {
      if (item.kind === "user" || item.kind === "assistant") projectedLength += item.text?.length ?? 0;
    }
    if (projectedLength > MAX_MARKDOWN_LENGTH * 2) throw new ConversationMarkdownError("too-large");
    const next = page.nextBeforeCursor;
    if (next === undefined) break;
    const cursorKey = `${next.generation}:${next.sequence}:${next.opaqueToken}`;
    if (seenCursors.has(cursorKey) || (beforeCursor !== undefined && (next.generation !== beforeCursor.generation || next.sequence >= beforeCursor.sequence))) {
      throw new ConversationMarkdownError("pagination");
    }
    if (pages.length >= MAX_PAGES) throw new ConversationMarkdownError("too-large");
    seenCursors.add(cursorKey);
    beforeCursor = next;
  }

  const messages = new Map<string, TimelineItemView>();
  for (const page of pages.reverse()) for (const item of page) {
    if (item.kind !== "user" && item.kind !== "assistant") continue;
    const previous = messages.get(item.id);
    if (previous === undefined) { messages.set(item.id, item); continue; }
    const sequence = previous.sequence < item.sequence ? previous.sequence : item.sequence;
    if (item.kind === "assistant" && previous.kind === "assistant") {
      messages.set(item.id, {
        ...item,
        sequence,
        text: item.streaming === false ? item.text : previous.streaming === false
          ? previous.text : `${previous.text ?? ""}${item.text ?? ""}`,
        streaming: previous.streaming === false ? false : item.streaming
      });
    } else {
      messages.set(item.id, { ...item, sequence, text: item.text || previous.text });
    }
  }
  const ordered = [...messages.values()].sort((left, right) => left.sequence === right.sequence
    ? left.id.localeCompare(right.id) : left.sequence < right.sequence ? -1 : 1);
  const lines: string[] = [];
  let markdownLength = 0;
  for (const item of projectRuntimeRecoveryTimeline(ordered)) {
    const text = item.kind === "user"
      ? visibleSelectionQuoteMessageText(item.text ?? "", item.quotesEncoded === true).trim()
      : (item.text ?? "").trim();
    if (text.length === 0) continue;
    const heading = `## ${item.kind === "user" ? labels.user : labels.assistant}`;
    markdownLength += heading.length + text.length + 4;
    if (markdownLength > MAX_MARKDOWN_LENGTH) throw new ConversationMarkdownError("too-large");
    lines.push(heading, "", text, "");
  }
  if (!isCurrent()) throw new ConversationMarkdownError("stale");
  return lines.length === 0 ? undefined : lines.join("\n").trimEnd();
}
