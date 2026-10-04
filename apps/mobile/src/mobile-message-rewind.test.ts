import { clone, create } from "@bufbuild/protobuf";
import { BackendDescriptorSchema, BackgroundTaskState, CapabilitySupport, EventSchema, InteractionState, MessageRole, NativeNavigationTargetSchema,
  QueueItemState, RewindSafety, RunState, SessionSchema, SessionState, SnapshotSchema, TargetSchema,
  WorkspaceChangeSetSchema, WorkspaceRewindPreviewSchema } from "@joko/contracts";
import { describe, expect, it } from "vitest";
import { assertMobileWorkspaceRewindPreview, mobileMessageChangeSet, mobileMessageRewindIdle,
  mobileRewindToStartSupported, resolveMobileMessageRewindSource } from "./mobile-message-rewind";

const event = create(EventSchema, { eventId: "complete", cursor: { generation: 1n, sequence: 2n },
  identity: { sessionId: "task", runId: "run" }, payload: { kind: { case: "messageCompleted", value: {
    messageId: "message", role: MessageRole.USER, nativeIdentity: { entryId: "entry", parentEntryId: "parent" },
    blocks: [{ content: { case: "text", value: "Original input" } }]
  } } } });

describe("native message rewind boundaries and checkpoints", () => {
  it("uses only advertised public rewind boundaries, preserving accepted input and an exact Run for files-only restore", () => {
    const before = resolveMobileMessageRewindSource([event], "task", event.eventId, 1n, false)!;
    expect(before.target).toBeUndefined(); expect(before.runId).toBe("run");
    const completed = clone(EventSchema, event);
    if (completed.payload?.kind.case === "messageCompleted") completed.payload.kind.value.nativeIdentity!.rewindBefore =
      create(NativeNavigationTargetSchema, { kind: { case: "nativeEntryId", value: "actual-boundary" } });
    const started = create(EventSchema, { eventId: "start", cursor: { generation: 1n, sequence: 1n },
      identity: { sessionId: "task", runId: "run" }, payload: { kind: { case: "messageStarted", value: {
        messageId: "message", role: MessageRole.USER, userInputAccepted: true,
        nativeIdentity: { entryId: "entry", parentEntryId: "parent", rewindBefore: completed.payload!.kind.case === "messageCompleted"
          ? completed.payload!.kind.value.nativeIdentity!.rewindBefore : undefined },
        userInput: { parts: [{ content: { case: "text", value: "Accepted 😀 input" } }, { content: { case: "file", value: { blobId: "old-lease" } } }] }
      } } } });
    const source = resolveMobileMessageRewindSource([started, completed], "task", completed.eventId, 1n, false)!;
    expect(source.target?.kind).toEqual({ case: "nativeEntryId", value: "actual-boundary" });
    expect(source.draft).toMatchObject({ text: "Accepted 😀 input", attachments: [] });
    if (started.payload?.kind.case === "messageStarted") started.payload.kind.value.nativeIdentity!.rewindBefore =
      create(NativeNavigationTargetSchema, { kind: { case: "nativeEntryId", value: "different" } });
    expect(resolveMobileMessageRewindSource([started, completed], "task", completed.eventId, 1n, true)).toBeUndefined();
    expect(resolveMobileMessageRewindSource([completed, completed], "task", completed.eventId, 1n, true)).toBeUndefined();
    expect(resolveMobileMessageRewindSource([completed], "task", completed.eventId, 2n, true)).toBeUndefined();
    if (completed.payload?.kind.case === "messageCompleted") completed.payload.kind.value.nativeIdentity!.rewindBefore =
      create(NativeNavigationTargetSchema, { kind: { case: "sessionStart", value: {} } });
    expect(resolveMobileMessageRewindSource([completed], "task", completed.eventId, 1n, false)?.target).toBeUndefined();
    expect(resolveMobileMessageRewindSource([completed], "task", completed.eventId, 1n, true)?.target?.kind.case).toBe("sessionStart");
  });

  it("respects typed service-node-only support and idle work, then rejects ambiguous, foreign or malformed previews", () => {
    const backend = create(BackendDescriptorSchema, { capabilities: { capabilities: [{ name: "session.rewind_to_start",
      support: CapabilitySupport.SUPPORTED, options: { kind: { case: "session", value: { serviceNodeOnly: true } } } }] } });
    expect(mobileRewindToStartSupported(backend, create(TargetSchema, { location: { kind: { case: "serviceNode", value: {} } } }))).toBe(true);
    expect(mobileRewindToStartSupported(backend, create(TargetSchema, { location: { kind: { case: "sshHost", value: { hostId: "host" } } } }))).toBe(false);
    backend.capabilities!.capabilities.push(backend.capabilities!.capabilities[0]!);
    expect(mobileRewindToStartSupported(backend, create(TargetSchema))).toBe(false);
    const session = create(SessionSchema, { sessionId: "task", state: SessionState.IDLE });
    const detail = create(SnapshotSchema);
    expect(mobileMessageRewindIdle(session, detail)).toBe(true);
    detail.runs = [create(SnapshotSchema, { runs: [{ sessionId: "task", state: RunState.WAITING }] }).runs[0]!];
    expect(mobileMessageRewindIdle(session, detail)).toBe(false);
    detail.runs = []; detail.queueItems = [create(SnapshotSchema, { queueItems: [{ sessionId: "task", state: QueueItemState.DISPATCH_UNKNOWN }] }).queueItems[0]!];
    expect(mobileMessageRewindIdle(session, detail)).toBe(false);
    for (const blocked of [
      create(SnapshotSchema, { interactions: [{ sessionId: "task", state: InteractionState.PENDING }] }),
      create(SnapshotSchema, { backgroundTasks: [{ sessionId: "task", state: BackgroundTaskState.WAITING }] }),
      create(SnapshotSchema, { reviewRuns: [{ reviewerSessionId: "task" }] })
    ]) expect(mobileMessageRewindIdle(session, blocked)).toBe(false);
    session.state = SessionState.RUNNING;
    expect(mobileMessageRewindIdle(session, create(SnapshotSchema))).toBe(false);
    const checkpoints = [create(WorkspaceChangeSetSchema, { changeSetId: "old", workspaceId: "ws", sessionId: "task", runId: "run", capturedAt: { seconds: 1n } }),
      create(WorkspaceChangeSetSchema, { changeSetId: "new", workspaceId: "ws", sessionId: "task", runId: "run", capturedAt: { seconds: 2n } }),
      create(WorkspaceChangeSetSchema, { changeSetId: "other", workspaceId: "ws", sessionId: "task", runId: "other", capturedAt: { seconds: 9n } })];
    expect(mobileMessageChangeSet(checkpoints, "ws", "task", "run")?.changeSetId).toBe("new");
    checkpoints.push(create(WorkspaceChangeSetSchema, { changeSetId: "ambiguous", workspaceId: "ws", sessionId: "task", runId: "run", capturedAt: { seconds: 2n } }));
    expect(() => mobileMessageChangeSet(checkpoints, "ws", "task", "run")).toThrow(/ambiguous/u);
    const preview = create(WorkspaceRewindPreviewSchema, { previewId: "preview", workspaceId: "ws", changeSetId: "new", safety: RewindSafety.SAFE, expiresAt: { seconds: 10n } });
    expect(() => assertMobileWorkspaceRewindPreview(preview, "ws", "new")).not.toThrow();
    expect(() => assertMobileWorkspaceRewindPreview(preview, "foreign", "new")).toThrow();
    preview.expiresAt!.seconds = 999_999_999_999_999_999n;
    expect(() => assertMobileWorkspaceRewindPreview(preview, "ws", "new")).toThrow();
  });
});
