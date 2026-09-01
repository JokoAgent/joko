import { describe, expect, it } from "vitest";
import type { TimelineItemView } from "../model.js";
import { assistantForkBlockedMessageIds, createMessageComposerMention, finalAssistantMessageIds, messageForkBlocked, resolveMessageDeleteTarget, resolveMessageForkTarget } from "./message-actions.js";

describe("message action capability inputs", () => {
  it("forks an assistant through its exact native entry", () => {
    expect(resolveMessageForkTarget(message("assistant", {
      nativeEntryId: "assistant-entry"
    }))).toEqual({ entryId: "assistant-entry" });
  });

  it("forks before a user prompt and restores its text", () => {
    expect(resolveMessageForkTarget(message("user", {
      nativeEntryId: "user-entry",
      nativeParentEntryId: "parent-entry",
      text: "Try the safer path"
    }))).toEqual({ entryId: "parent-entry", composerText: "Try the safer path" });
  });

  it("does not invent a boundary and keeps attachment forks text-only", () => {
    expect(resolveMessageForkTarget(message("assistant"))).toBeUndefined();
    expect(resolveMessageForkTarget(message("user", { nativeEntryId: "user-entry", text: "Question" }))).toBeUndefined();
    expect(resolveMessageForkTarget(message("user", {
      nativeParentEntryId: "parent-entry",
      text: "Question",
      attachments: [{ id: "file", blobId: "blob", title: "file", kind: "file", fileName: "file.txt", mediaType: "text/plain", byteSize: 1 }]
    }))).toEqual({ entryId: "parent-entry", composerText: "Question" });
    expect(resolveMessageForkTarget(message("user", {
      nativeParentEntryId: "parent-entry",
      text: "",
      attachments: [{ id: "file", blobId: "blob", title: "file", kind: "file", fileName: "file.txt", mediaType: "text/plain", byteSize: 1 }]
    }))).toEqual({ entryId: "parent-entry" });
  });

  it("creates a bounded structured message mention without copying message content", () => {
    expect(createMessageComposerMention("session-1", " Review task ", message("assistant", {
      id: "message-2",
      sourceEventId: "event-2",
      text: "do not duplicate this potentially sensitive body"
    }))).toEqual({
      id: "message:session-1:event-2",
      kind: "message",
      reference: "message-2",
      label: "Review task",
      sessionId: "session-1",
      role: "assistant",
      sourceEventId: "event-2"
    });
  });

  it("exposes assistant actions only on the final message of each turn", () => {
    const ids = finalAssistantMessageIds([
      message("user", { id: "user-1" }),
      message("assistant", { id: "assistant-1a", runId: "run-1" }),
      message("assistant", { id: "assistant-1b", runId: "run-1" }),
      message("user", { id: "user-2" }),
      message("assistant", { id: "assistant-2a" }),
      message("assistant", { id: "assistant-2b" })
    ]);
    expect([...ids]).toEqual(["assistant-2b", "assistant-1b"]);
  });

  it("keeps same-turn steer rows inside the current assistant turn", () => {
    const ids = finalAssistantMessageIds([
      message("user", { id: "user-1" }),
      message("assistant", { id: "assistant-before-steer" }),
      message("user", { id: "steer", inputDelivery: "steer" }),
      message("assistant", { id: "assistant-after-steer" })
    ]);
    expect([...ids]).toEqual(["assistant-after-steer"]);
  });

  it("blocks only the active assistant tail while stable history remains forkable", () => {
    const items = [
      message("user", { id: "user-1" }),
      message("assistant", { id: "assistant-history" }),
      message("user", { id: "steer", inputDelivery: "steer" }),
      message("assistant", { id: "assistant-after-steer" }),
      message("user", { id: "user-2", inputDelivery: "prompt" }),
      message("assistant", { id: "assistant-active-tail" })
    ];

    expect([...assistantForkBlockedMessageIds(items, true)]).toEqual(["assistant-active-tail"]);
    expect(messageForkBlocked(items, items[1]!, true)).toBe(false);
    expect(messageForkBlocked(items, items[3]!, true)).toBe(false);
    expect(messageForkBlocked(items, items[5]!, true)).toBe(true);
    expect(assistantForkBlockedMessageIds(items, false).size).toBe(0);
  });

  it("blocks a same-turn steer user fork only while the task is active", () => {
    const steer = message("user", { id: "steer", inputDelivery: "steer" });
    const prompt = message("user", { id: "prompt", inputDelivery: "prompt" });
    expect(messageForkBlocked([steer], steer, true)).toBe(true);
    expect(messageForkBlocked([steer], steer, false)).toBe(false);
    expect(messageForkBlocked([prompt], prompt, true)).toBe(false);
  });

  it("deletes only a completed visible message through its durable Event identity", () => {
    expect(resolveMessageDeleteTarget(message("user", {
      id: "message-user",
      sourceEventId: "event-user"
    }))).toEqual({ messageId: "message-user", eventId: "event-user" });
    expect(resolveMessageDeleteTarget(message("assistant", {
      id: "message-assistant",
      sourceEventId: "event-assistant"
    }))).toEqual({ messageId: "message-assistant", eventId: "event-assistant" });
    expect(resolveMessageDeleteTarget(message("assistant", {
      sourceEventId: "event-streaming",
      streaming: true
    }))).toBeUndefined();
    expect(resolveMessageDeleteTarget(message("user"))).toBeUndefined();
  });
});

function message(kind: "user" | "assistant", overrides: Partial<TimelineItemView> = {}): TimelineItemView {
  return {
    id: `${kind}-message`,
    sequence: 1n,
    kind,
    createdAt: 1,
    text: "",
    ...overrides
  };
}
