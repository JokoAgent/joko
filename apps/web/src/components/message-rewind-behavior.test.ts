import { describe, expect, it } from "vitest";
import type { CapabilityView, TargetView, TimelineItemView, WorkspaceChangeSetView } from "../model.js";
import { canEditVisibleUserMessage, changeSetForMessageRound, isPersistedStopEditSource, lastVisibleUserMessage, messageDialogueRewindTarget, messageRoundRunId, sessionCapabilitySupportsTarget } from "./message-rewind-behavior.js";

describe("message rewind boundaries", () => {
  it("applies only the advertised start scope and rejects unknown or incomplete scope authority", () => {
    const local: TargetView = { id: "target", revision: 1n, backendId: "backend", name: "Project", workspaceId: "workspace", workspaceName: "Workspace", trusted: true, pinned: false, archived: false };
    const remote: TargetView = { ...local, remoteWorkspace: { kind: "ssh", hostTargetId: "host-target", hostId: "host", workspaceRoot: "/workspace" } };
    const capability = (options: readonly string[], supported = true): CapabilityView => ({ name: "session.rewind_to_start", supported, options });
    expect(sessionCapabilitySupportsTarget(capability([]), undefined)).toBe(true);
    expect(sessionCapabilitySupportsTarget(capability([]), remote)).toBe(true);
    expect(sessionCapabilitySupportsTarget(capability(["service_node_only"]), local)).toBe(true);
    for (const target of [remote, undefined]) expect(sessionCapabilitySupportsTarget(capability(["service_node_only"]), target)).toBe(false);
    for (const options of [["unknown"], ["service_node_only", "service_node_only"], ["service_node_only", "unknown"]]) {
      expect(sessionCapabilitySupportsTarget(capability(options), local)).toBe(false);
    }
    expect(sessionCapabilitySupportsTarget(capability([], false), local)).toBe(false);
    expect(sessionCapabilitySupportsTarget(undefined, local)).toBe(false);
    expect(messageDialogueRewindTarget(message("entry", "user", "parent"), false)).toEqual({ kind: "native_entry", entryId: "parent" });
  });

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
    expect(canEditVisibleUserMessage({ ...last!, attachments: [{ id: "a", blobId: "b", sourceRevealAvailable: false, title: "x", kind: "file", fileName: "x", mediaType: "text/plain", byteSize: 1 }] })).toBe(true);
    expect(canEditVisibleUserMessage({ ...last!, text: "", attachments: [{ id: "a", blobId: "b", sourceRevealAvailable: false, title: "x", kind: "file", fileName: "x", mediaType: "text/plain", byteSize: 1 }] })).toBe(false);
  });

  it("retains a stop edit only for the newer native projection of its exact accepted input", () => {
    const live: TimelineItemView = { ...message("entry", "user", "parent"), nativeEntryId: "entry", sourceEventId: "live-event",
      userInputAccepted: true, runId: "stopped-run", inputOperationId: "stopped-input", completionCursor: 17n };
    const persisted = { ...live, sourceEventId: `native-event-${"a".repeat(64)}`, completionCursor: 24n };
    expect(isPersistedStopEditSource(live, persisted)).toBe(true);
    for (const change of [
      { sourceEventId: "other-live-event" }, { completionCursor: 16n }, { userInputAccepted: undefined },
      { nativeEntryId: "other-entry" }, { runId: "other-run" }, { inputOperationId: "other-input" }, { text: "Different text" },
      { nativeParentEntryId: "other-parent" }, { nativeRewindBefore: { kind: "native_entry" as const, entryId: "other-boundary" } }
    ]) expect(isPersistedStopEditSource(live, { ...persisted, ...change })).toBe(false);
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
