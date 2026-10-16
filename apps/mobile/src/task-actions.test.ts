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
  buildMobileMessageCopyText,
  captureMobileMessageReference,
  commitMobileMessageReference,
  editQueueItemText,
  mobileQueueCapabilities,
  queueItemHasStructuredInput,
  queueItemText,
  queueMove
} from "./task-actions";
import type { TimelineRow } from "./timeline";
import { mobileComposerInput, plainTextMobileComposerDraft } from "./mobile-composer-document";

describe("mobile message action sheet", () => {
  const row: TimelineRow = {
    id: "message-1", eventId: "event-complete", label: "You", text: "Keep this exact message",
    sequence: 4n, kind: "user", completed: true
  };

  it("offers only actions backed by the current durable message and capability", () => {
    expect(buildMobileMessageActions(row, { canDelete: true, locale: "en" })).toEqual([
      { id: "copy-text", label: "Copy message" },
      { id: "add-to-composer", label: "Add to composer" },
      { id: "copy-link", label: "Copy message link" },
      { id: "share-image", label: "Share as image" },
      { id: "delete", label: "Delete message", destructive: true, separatorBefore: true }
    ]);
    expect(buildMobileMessageActions({ ...row, completed: false }, { canDelete: true, locale: "en" })).toEqual([]);
    expect(buildMobileMessageActions({ ...row, kind: "status" }, { canDelete: true, locale: "en" })).toEqual([]);
    expect(buildMobileMessageActions({
      ...row,
      kind: "assistant",
      label: "Assistant",
      quoteSource: { sourceMessageId: row.id, sourceEventId: row.eventId, text: row.text }
    }, { canDelete: true, locale: "en", copyDisabled: true })).toEqual([
      { id: "copy-text", label: "Copying message…", disabled: true },
      { id: "add-to-composer", label: "Add to composer" },
      { id: "quote-selection", label: "Quote selection" },
      { id: "copy-link", label: "Copying link…", disabled: true },
      { id: "share-image", label: "Share as image" },
      { id: "delete", label: "Delete message", destructive: true, separatorBefore: true }
    ]);
    expect(buildMobileMessageActions({ ...row, text: "" }, { canDelete: false, locale: "zh-CN" })).toEqual([
      { id: "add-to-composer", label: "添加到编辑器" },
      { id: "copy-link", label: "复制消息链接" },
      { id: "share-image", label: "分享为图片" }
    ]);
    expect(buildMobileMessageActions(row, { canDelete: false, canFork: true, locale: "en" }).at(-1))
      .toEqual({ id: "fork", label: "Fork at message" });
    expect(buildMobileMessageActions(row, { canDelete: false, canRewind: true, locale: "en" }).at(-1))
      .toEqual({ id: "rewind", label: "Rewind before message" });
    expect(buildMobileMessageActions({ ...row, kind: "assistant" }, { canDelete: false, canRewind: true, locale: "en" })
      .some((item) => item.id === "rewind")).toBe(false);
  });

  it("copies body, secondary body and localized attachment names without losing attachment-only actions", () => {
    const attachmentOnly = { ...row, text: "[File]", sourceText: "", copySource: {
      body: "", attachmentNames: ["photo.png", "notes.txt"] } };
    expect(buildMobileMessageCopyText(attachmentOnly, "en")).toBe("Attachments: photo.png, notes.txt");
    expect(buildMobileMessageCopyText({ ...attachmentOnly, copySource: {
      body: "**Exact body**\nsecond line", secondaryBody: "Secondary result", attachmentNames: ["photo.png", "notes.txt"] } }, "zh-CN"))
      .toBe("**Exact body**\nsecond line\n\nSecondary result\n\n附件：photo.png, notes.txt");
    expect(buildMobileMessageActions(attachmentOnly, { canDelete: false, locale: "en" }).slice(0, 2))
      .toEqual([{ id: "copy-text", label: "Copy message" }, { id: "add-to-composer", label: "Add to composer" }]);
    expect(buildMobileMessageActions(attachmentOnly, { canDelete: false, canAddToComposer: false, locale: "en" })
      .some(action => action.id === "add-to-composer")).toBe(false);
  });

  it("inserts an anchored message reference into the captured draft and rejects retired owner/message/draft inputs", () => {
    const draft = plainTextMobileComposerDraft("Before after");
    const message = { ...row, text: "A [message] @mention\n" + "summary ".repeat(500) };
    const lease = captureMobileMessageReference({ ownerKey: "node/task/occurrence", draftOwnerKey: "profile/task",
      sessionId: "task", row: message, draft, selection: { start: 7, end: 7 }, locale: "en" })!;
    const input = { lease, ownerKey: lease.ownerKey, draftOwnerKey: lease.draftOwnerKey, sessionId: lease.sessionId,
      row: message, draft, locale: "en" as const, atomId: "message-reference" };
    const result = commitMobileMessageReference(input);
    expect(result.draft.text).toBe("Before #/tasks/task?message=message-1&event=event-completeafter");
    expect(result.draft.atoms[0]).toMatchObject({ kind: "route-reference", routeKind: "session", sessionId: "task",
      messageId: row.id, eventId: row.eventId, displayText: expect.stringContaining("A message ＠mention") });
    expect(result.draft.atoms[0]!.kind === "route-reference" && result.draft.atoms[0]!.displayText.length).toBeLessThanOrEqual(240);
    expect(mobileComposerInput(result.draft).parts).toMatchObject([{ content: { case: "text", value: result.draft.text } }]);
    for (const changed of [{ ownerKey: "other-node/task/occurrence" }, { ownerKey: "node/task/new-occurrence" },
      { draftOwnerKey: "other-profile/task" }, { sessionId: "other-task" }, { draft: plainTextMobileComposerDraft(draft.text) },
      { row: { ...message, eventId: "new-event" } }, { row: { ...message, text: "changed message" } }, { row: { ...message, completed: false } }]) {
      expect(() => commitMobileMessageReference({ ...input, ...changed })).toThrow("source message or composer changed");
    }
    const attachmentOnly = { ...row, text: "", sourceText: "", copySource: { body: "", attachmentNames: ["notes.txt"] } };
    expect(captureMobileMessageReference({ ownerKey: lease.ownerKey, draftOwnerKey: lease.draftOwnerKey,
      sessionId: "task", row: attachmentOnly, draft, selection: { start: 0, end: 0 }, locale: "en" })).toBeDefined();
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
