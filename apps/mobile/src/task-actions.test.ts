import { create } from "@bufbuild/protobuf";
import {
  BackendDescriptorSchema,
  CapabilitySupport,
  InputContentSchema,
  InputPartSchema,
  QueueItemSchema,
  QueueItemState,
  capabilityNames
} from "@joko/contracts";
import { describe, expect, it } from "vitest";
import {
  DeferredSheetAction,
  acceptedQueueItems,
  buildMobileMessageActions,
  editQueueItemText,
  mobileQueueCapabilities,
  queueItemHasStructuredInput,
  queueItemText,
  queueMove
} from "./task-actions";
import type { TimelineRow } from "./timeline";

describe("mobile message action sheet", () => {
  const row: TimelineRow = {
    id: "message-1", eventId: "event-complete", label: "You", text: "Keep this exact message",
    sequence: 4n, kind: "user", completed: true
  };

  it("offers only actions backed by the current durable message and capability", () => {
    expect(buildMobileMessageActions(row, { canDelete: true })).toEqual([
      { id: "add-to-composer", label: "Add to composer" },
      { id: "delete", label: "Delete message", destructive: true, separatorBefore: true }
    ]);
    expect(buildMobileMessageActions({ ...row, completed: false }, { canDelete: true })).toEqual([]);
    expect(buildMobileMessageActions({ ...row, kind: "status" }, { canDelete: true })).toEqual([]);
    expect(buildMobileMessageActions({
      ...row,
      kind: "assistant",
      label: "Assistant",
      quoteSource: { sourceMessageId: row.id, sourceEventId: row.eventId, text: row.text }
    }, { canDelete: true })).toEqual([
      { id: "add-to-composer", label: "Add to composer" },
      { id: "quote-selection", label: "Quote selection" },
      { id: "delete", label: "Delete message", destructive: true, separatorBefore: true }
    ]);
  });

  it("runs a choice only after its matching close and cancels an old choice on reopen", () => {
    const lifecycle = new DeferredSheetAction<string>();
    lifecycle.open();
    const firstClose = lifecycle.select("delete");
    lifecycle.open();
    expect(lifecycle.closed(firstClose)).toBeUndefined();
    const secondClose = lifecycle.select("add");
    expect(lifecycle.closed(secondClose)).toBe("add");
    expect(lifecycle.closed(secondClose)).toBeUndefined();
    lifecycle.open();
    const cancelled = lifecycle.cancel();
    expect(lifecycle.closed(cancelled)).toBeUndefined();
  });
});

describe("mobile accepted Queue actions", () => {
  const item = (id: string, ordinal: bigint, state = QueueItemState.ACCEPTED) => create(QueueItemSchema, {
    queueItemId: id,
    sessionId: "session-1",
    ordinal,
    state,
    version: { revision: { value: ordinal + 1n, etag: `queue-${id}` } },
    input: create(InputContentSchema, {
      parts: [
        create(InputPartSchema, { content: { case: "text", value: `text-${id}` } }),
        create(InputPartSchema, { content: { case: "sessionMention", value: { sessionId: "other", displayText: "Other task" } } })
      ]
    })
  });

  it("sorts the current accepted queue stably and resolves edge-safe touch moves", () => {
    const items = acceptedQueueItems([
      item("b", 2n), item("done", 0n, QueueItemState.COMPLETED), item("a", 1n),
      create(QueueItemSchema, { ...item("other", 0n), sessionId: "session-2" })
    ], "session-1");
    expect(items.map((value) => value.queueItemId)).toEqual(["a", "b"]);
    expect(queueMove(items, "a", "up")).toBeUndefined();
    expect(queueMove(items, "a", "down")).toEqual({ placement: "after", anchorQueueItemId: "b" });
    expect(queueMove(items, "b", "up")).toEqual({ placement: "before", anchorQueueItemId: "a" });
    expect(queueMove(items, "b", "down")).toBeUndefined();
  });

  it("treats full-body replacement as authority revocation and emits UTF-16 coordinates", () => {
    const original = item("a", 1n).input;
    expect(queueItemText(original)).toBe("text-a");
    expect(queueItemHasStructuredInput(original)).toBe(true);
    const edited = editQueueItemText(original, "Hello 👋");
    expect(edited?.input.parts[0]?.content).toEqual({ case: "text", value: "Hello 👋" });
    expect(edited?.input.parts).toHaveLength(1);
    expect(edited?.input.mentionRanges).toEqual([]);
    expect(edited?.textSplices).toMatchObject([{ start: 0, end: 6, replacementText: "Hello 👋" }]);
    expect(editQueueItemText(original, "   ")).toBeUndefined();
    expect(queueItemHasStructuredInput(create(InputContentSchema, {
      parts: [create(InputPartSchema, { content: { case: "text", value: "plain" } })]
    }))).toBe(false);
  });

  it("opens quote-bearing Queue input markerless and replaces the exact raw body only after a real edit", () => {
    const raw = "> <!-- joko-selection-quote -->\n> quoted\n\nKeep this";
    const structured = create(InputContentSchema, {
      parts: [create(InputPartSchema, { content: { case: "text", value: raw } })],
      quotesEncoded: true
    });
    expect(queueItemText(structured)).toBe("> quoted\n\nKeep this");
    expect(editQueueItemText(structured, "> quoted\n\nKeep this")).toBeUndefined();
    const edited = editQueueItemText(structured, "> quoted\n\nKeep that");
    expect(edited?.input).toMatchObject({
      quotesEncoded: false,
      pastedTextRanges: [],
      mentionRanges: [],
      parts: [{ content: { case: "text", value: "> quoted\n\nKeep that" } }]
    });
    expect(edited?.textSplices).toMatchObject([{
      start: 0,
      end: raw.length,
      replacementText: "> quoted\n\nKeep that"
    }]);
  });

  it("branches only on public capabilities", () => {
    const backend = create(BackendDescriptorSchema, {
      capabilities: {
        capabilities: [
          { name: capabilityNames.queueEdit, support: CapabilitySupport.SUPPORTED },
          { name: capabilityNames.queueCancel, support: CapabilitySupport.NOT_IMPLEMENTED }
        ]
      }
    });
    expect(mobileQueueCapabilities(backend)).toEqual({ cancel: false, edit: true, reorder: false });
  });
});
