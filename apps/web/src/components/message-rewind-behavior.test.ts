import { describe, expect, it } from "vitest";
import type { TimelineItemView, WorkspaceChangeSetView } from "../model.js";
import { canEditVisibleUserMessage, changeSetForMessageRound, lastVisibleUserMessage, messageDialogueRewindTarget, messageRoundRunId } from "./message-rewind-behavior.js";

describe("message rewind boundaries", () => {
  it("requires explicit first-turn authority and the start capability, independently of parent and pagination", () => {
    const root = { ...message("first", "user"), nativeRewindBefore: { kind: "session_start" as const } };
    expect(messageDialogueRewindTarget(root)).toBeUndefined();
    expect(canEditVisibleUserMessage(root)).toBe(false);
    expect(messageDialogueRewindTarget(root, true)).toEqual({ kind: "session_start" });
    expect(canEditVisibleUserMessage(root, true)).toBe(true);
    expect(messageDialogueRewindTarget(message("unknown", "user"), true)).toBeUndefined();
    expect(messageDialogueRewindTarget({ ...message("partial", "user"), nativeParentEntryId: "parent" }, true)).toBeUndefined();
  });

  const items: readonly TimelineItemView[] = [
    message("user-1", "user", "parent-1"),
    { ...message("assistant-1", "assistant"), runId: "run-1" },
    message("user-2", "user", "parent-2"),
    { ...message("thinking-2", "thinking"), runId: "run-2" },
    { ...message("assistant-2", "assistant"), runId: "run-2" }
  ];

  it("edits the last non-empty visible user boundary, including attachments", () => {
    const last = lastVisibleUserMessage(items);
    expect(last?.id).toBe("user-2");
    expect(canEditVisibleUserMessage(last)).toBe(true);
    expect(messageDialogueRewindTarget(last!)).toEqual({ kind: "native_entry", entryId: "parent-2" });
    expect(canEditVisibleUserMessage({ ...last!, attachments: [{ id: "a", blobId: "b", title: "x", kind: "file", fileName: "x", mediaType: "text/plain", byteSize: 1 }] })).toBe(true);
    expect(canEditVisibleUserMessage({ ...last!, text: "", attachments: [{ id: "a", blobId: "b", title: "x", kind: "file", fileName: "x", mediaType: "text/plain", byteSize: 1 }] })).toBe(false);
  });

  it("maps the following round to its captured change set without crossing the next user", () => {
    expect(messageRoundRunId(items, "user-1")).toBe("run-1");
    expect(messageRoundRunId(items, "user-2")).toBe("run-2");
    const changes = [changeSet("old", "run-2", 1), changeSet("new", "run-2", 2), changeSet("other", "run-1", 3)];
    expect(changeSetForMessageRound(changes, "run-2")?.id).toBe("new");
  });
});

function message(id: string, kind: TimelineItemView["kind"], nativeParentEntryId?: string): TimelineItemView {
  return { id, kind, sequence: BigInt(id.length), createdAt: id.length, text: id, ...(nativeParentEntryId === undefined ? {} : { nativeParentEntryId, nativeRewindBefore: { kind: "native_entry", entryId: nativeParentEntryId } }) };
}

function changeSet(id: string, runId: string, capturedAt: number): WorkspaceChangeSetView {
  return { id, runId, turnId: runId, changeCount: 1, completeBaseline: true, gaps: [], capturedAt };
}
