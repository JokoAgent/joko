import { clone, create } from "@bufbuild/protobuf";
import { EventCursorSchema, EventSchema, InputPartSchema, MessageInputDelivery, MessageRole } from "@joko/contracts";
import { describe, expect, it } from "vitest";
import { resolveMobileMessageForkSource } from "./mobile-message-fork";
import { appendMobileSelectionQuote, insertMobilePastedText, insertMobileSessionMention,
  mobileComposerInput, plainTextMobileComposerDraft, restoreMobileComposerInput } from "./mobile-composer-document";

const started = create(EventSchema, { eventId: "user-start", identity: { sessionId: "session" },
  cursor: { generation: 1n, sequence: 1n }, payload: { kind: { case: "messageStarted", value: {
    messageId: "user", role: MessageRole.USER, userInputAccepted: true, inputDelivery: MessageInputDelivery.PROMPT,
    nativeIdentity: { entryId: "user-entry", parentEntryId: "parent-entry" },
    userInput: { parts: [{ content: { case: "text", value: "Exact input" } }] }
  } } } });
const completed = create(EventSchema, { eventId: "user-complete", identity: { sessionId: "session" },
  cursor: { generation: 1n, sequence: 2n }, payload: { kind: { case: "messageCompleted", value: {
    messageId: "user", role: MessageRole.USER, nativeIdentity: { entryId: "user-entry", parentEntryId: "parent-entry" },
    blocks: [{ content: { case: "text", value: "Display text must not replace accepted input" } }]
  } } } });
const assistant = create(EventSchema, { eventId: "assistant-complete", identity: { sessionId: "session" },
  cursor: { generation: 1n, sequence: 3n }, payload: { kind: { case: "messageCompleted", value: {
    messageId: "assistant", role: MessageRole.ASSISTANT, nativeIdentity: { entryId: "assistant-entry", parentEntryId: "user-entry" },
    blocks: [{ content: { case: "text", value: "Answer" } }]
  } } } });

describe("native message fork projection and input restoration", () => {
  it("uses the public user parent and assistant entry, and keeps stable history forkable during active work", () => {
    expect(resolveMobileMessageForkSource([started, completed], "session", completed.eventId, 1n, true))
      .toMatchObject({ nativeEntryId: "parent-entry", messageId: "user", draft: { text: "Exact input" } });
    expect(resolveMobileMessageForkSource([assistant], "session", assistant.eventId, 1n, false))
      .toMatchObject({ nativeEntryId: "assistant-entry", restoreInput: false });
    expect(resolveMobileMessageForkSource([assistant], "session", assistant.eventId, 1n, true)).toBeUndefined();
    const next = clone(EventSchema, started);
    next.eventId = "later-input"; next.cursor = create(EventCursorSchema, { generation: 1n, sequence: 4n });
    if (next.payload?.kind.case === "messageStarted") next.payload.kind.value.messageId = "next";
    expect(resolveMobileMessageForkSource([assistant, next], "session", assistant.eventId, 1n, true)).toBeDefined();
    if (next.payload?.kind.case === "messageStarted") next.payload.kind.value.inputDelivery = MessageInputDelivery.STEER;
    expect(resolveMobileMessageForkSource([assistant, next], "session", assistant.eventId, 1n, true)).toBeUndefined();
    const steer = clone(EventSchema, started);
    if (steer.payload?.kind.case === "messageStarted") steer.payload.kind.value.inputDelivery = MessageInputDelivery.STEER;
    expect(resolveMobileMessageForkSource([steer, completed], "session", completed.eventId, 1n, true)).toBeUndefined();
  });

  it("fails closed on missing, conflicting, duplicate or foreign identities and changes its source fence with accepted input", () => {
    const missing = clone(EventSchema, completed);
    if (missing.payload?.kind.case === "messageCompleted") missing.payload.kind.value.nativeIdentity = undefined;
    expect(resolveMobileMessageForkSource([missing], "session", missing.eventId, 1n, false)).toBeUndefined();
    const conflicting = clone(EventSchema, completed);
    if (conflicting.payload?.kind.case === "messageCompleted") conflicting.payload.kind.value.nativeIdentity!.parentEntryId = "wrong-parent";
    expect(resolveMobileMessageForkSource([started, conflicting], "session", conflicting.eventId, 1n, false)).toBeUndefined();
    expect(resolveMobileMessageForkSource([started, completed, completed], "session", completed.eventId, 1n, false)).toBeUndefined();
    expect(resolveMobileMessageForkSource([started, completed], "foreign", completed.eventId, 1n, false)).toBeUndefined();
    expect(resolveMobileMessageForkSource([started, completed], "session", completed.eventId, 2n, false)).toBeUndefined();
    const changed = clone(EventSchema, started);
    if (changed.payload?.kind.case === "messageStarted") changed.payload.kind.value.userInput!.parts[0]!.content = { case: "text", value: "Changed input" };
    expect(resolveMobileMessageForkSource([changed, completed], "session", completed.eventId, 1n, false)?.sourceKey)
      .not.toBe(resolveMobileMessageForkSource([started, completed], "session", completed.eventId, 1n, false)?.sourceKey);
  });

  it("restores accepted quote, full pasted Unicode text and typed reference occurrences without copying historical media", () => {
    let draft = insertMobileSessionMention(plainTextMobileComposerDraft("Discuss 😀 "), { start: 11, end: 11 },
      { sessionId: "related", displayText: "Related" }, "mention").draft;
    draft = appendMobileSelectionQuote(draft, { sourceSessionId: "source", sourceMessageId: "answer",
      sourceEventId: "answer-event", sourceRole: "assistant", text: "Evidence\nsecond line" }, "quote").draft;
    draft = insertMobilePastedText(draft, { start: draft.text.length, end: draft.text.length },
      "> <!-- joko-selection-quote -->\n> literal paste\n" + "😀 evidence\n".repeat(30), "paste").draft;
    const input = mobileComposerInput(draft);
    const expectedText = input.parts.filter((part) => part.content.case === "text").map((part) => part.content.value).join("");
    input.parts.push(create(InputPartSchema, { content: { case: "file", value: { blobId: "historical-blob" } } }));
    const restored = restoreMobileComposerInput(input, { sessionId: "session", messageId: "user", eventId: "user-start" });
    expect(restored.attachments).toEqual([]);
    expect(restored.atoms.map((atom) => atom.kind)).toEqual(["quote", "pasted-text"]);
    expect(restored.atoms[0]).toMatchObject({ sourceRole: "user", sourceMessageId: "user", text: "Evidence\nsecond line" });
    expect(restored.mentions[0]).toMatchObject({ kind: "session", sessionId: "related" });
    expect(mobileComposerInput(restored).parts.filter((part) => part.content.case === "text").map((part) => part.content.value).join(""))
      .toBe(expectedText);
    input.mentionRanges[0]!.start = 9;
    expect(() => restoreMobileComposerInput(input, { sessionId: "session", messageId: "user", eventId: "user-start" })).toThrow(/ranges/u);
    const mentionsOnly = mobileComposerInput(appendMobileSelectionQuote(plainTextMobileComposerDraft(""), {
      sourceSessionId: "source", sourceMessageId: "answer", sourceEventId: "answer-event", sourceRole: "assistant", text: "Quoted evidence"
    }, "quote-only").draft);
    mentionsOnly.parts.push(
      create(InputPartSchema, { content: { case: "workspaceMention", value: { workspaceId: "workspace", relativePath: "src/a.ts",
        displayText: "a.ts", lineRange: { startLine: 2, endLine: 4 } } } }),
      create(InputPartSchema, { content: { case: "resourceMention", value: { resourceId: "resource", displayText: "Resource",
        discoveredRevision: "resource-r1", resourceVersion: 1n, runtimeGeneration: 8n } } }),
      create(InputPartSchema, { content: { case: "artifactMention", value: { artifactId: "artifact", sourceSessionId: "source", displayText: "Artifact" } } })
    );
    const withReferences = restoreMobileComposerInput(mentionsOnly, { sessionId: "session", messageId: "user", eventId: "user-start" });
    expect(withReferences.mentions.map((mention) => mention.kind)).toEqual(["workspace", "resource", "artifact"]);
    expect(withReferences.mentions[0]).toMatchObject({ lineRange: { startLine: 2, endLine: 4 } });
    expect(mobileComposerInput(withReferences).parts.slice(1)).toEqual(mentionsOnly.parts.slice(1));
  });
});
