import { create } from "@bufbuild/protobuf";
import {
  ArtifactKind,
  AuthenticationState,
  BackendHealth,
  BackgroundTaskState,
  BrowserProviderState,
  BrowserTakeoverState,
  CapabilitySupport,
  CompactionState,
  ContextRebuildReason,
  EventPayloadSchema,
  EventSchema,
  ExtensionStatusChangedEventSchema,
  ExtensionStatusSchema,
  ExtensionWidgetChangedEventSchema,
  ExtensionWidgetSchema,
  ExtensionWidgetPlacement,
  DiffLineKind,
  FileChangeKind,
  ErrorSeverity,
  GitFileStatus,
  InteractionKind,
  InteractionState,
  InstallationState,
  MessageInputDelivery,
  MessageRole,
  ModelInputModality,
  ModelOutputModality,
  ProviderApiCompatibility,
  ProviderKind,
  ProviderLoginMethod,
  QuestionAnswerHandling,
  QueueDeliveryMode,
  QueueDispatchState,
  QueueItemState,
  QueueSourceKind,
  RetryState,
  ReviewFailureCode,
  ReviewFreshnessState,
  ReviewRunState,
  ReviewTargetKind,
  RunState,
  RuntimeRecoveryState,
  RuntimeCommandSource,
  SessionAttentionKind,
  SessionState,
  SnapshotInvalidationReason,
  SnapshotSchema,
  ToolCallOutputMode,
  ToolCallState,
  type Event
} from "@joko/contracts";
import { describe, expect, it } from "vitest";
import {
  classifyEventContinuity,
  mapSnapshot,
  projectSnapshotEvent,
  requiresEventSnapshotResync
} from "./gateway.js";
import {
  createSidebarDoneAttentionVisibilityState,
  reconcileSidebarDoneAttentionVisibility,
  sidebarSessionIndicatorState,
  visibleSidebarAttention
} from "./sidebar-layout.js";
import { Code, ConnectError } from "@connectrpc/connect";

describe("event continuity", () => {
  const eventAt = (sequence: bigint, generation = 7n): Event => create(EventSchema, {
    eventId: `event-${sequence}`,
    cursor: { generation, sequence },
    payload: { kind: { case: "statusStream", value: { statusId: "status", label: "Working" } } }
  });

  it("detects duplicate, gap, generation, and missing-cursor fallbacks", () => {
    expect(classifyEventContinuity(7n, 4n, eventAt(5n))).toBe("contiguous");
    expect(classifyEventContinuity(7n, 4n, eventAt(4n))).toBe("duplicate");
    expect(classifyEventContinuity(7n, 4n, eventAt(6n))).toBe("gap");
    expect(classifyEventContinuity(7n, 4n, eventAt(5n, 8n))).toBe("generationChanged");
    expect(classifyEventContinuity(7n, 4n, create(EventSchema, { eventId: "missing" }))).toBe("missingCursor");
  });

  it("requests a fresh snapshot when the stream rejects a stale generation or cursor", () => {
    expect(requiresEventSnapshotResync(new ConnectError("stale cursor", Code.FailedPrecondition))).toBe(true);
    expect(requiresEventSnapshotResync(new Error("wrapped", { cause: new ConnectError("old generation", Code.FailedPrecondition) }))).toBe(true);
    expect(requiresEventSnapshotResync(new ConnectError("temporarily offline", Code.Unavailable))).toBe(false);
  });
});

describe("Backend instance projection", () => {
  it("preserves typed installation, authentication, generation, and public failure state", () => {
    const snapshot = mapSnapshot(create(SnapshotSchema, {
      backends: [{
        backendId: "backend-runtime",
        displayName: "Runtime",
        version: "1.2.3",
        health: BackendHealth.UNAVAILABLE,
        installationState: InstallationState.NOT_INSTALLED,
        authenticationState: AuthenticationState.SIGNED_OUT,
        entityVersion: { revision: { value: 4n }, generation: 9n },
        error: { code: "BACKEND_NOT_INSTALLED", message: "Install the runtime before use." }
      }]
    }));

    expect(snapshot.backends).toEqual([expect.objectContaining({
      id: "backend-runtime",
      health: "unavailable",
      instanceGeneration: 9,
      installationState: "notInstalled",
      authenticationState: "signedOut",
      error: "Install the runtime before use."
    })]);
  });
});

describe("durable extension graphical state", () => {
  it("uses server timestamps for stable widget order after a reconnect snapshot", () => {
    const raw = create(SnapshotSchema, {
      extensionWidgets: [
        widget("latest", "above", 40n),
        widget("same-b", "above", 20n),
        widget("earliest", "below", 10n),
        widget("same-a", "above", 20n),
        { ...widget("cleared", "above", 30n), removed: true },
        { ...widget("empty", "above", 30n), lines: [] }
      ]
    });

    expect(mapSnapshot(raw).extensionWidgetsBySession.get("session-extension")?.map((value) => value.key)).toEqual([
      "earliest",
      "same-a",
      "same-b",
      "empty",
      "latest"
    ]);
    expect(mapSnapshot(raw).extensionWidgetsBySession.get("session-extension")?.map((value) => value.key)).toEqual([
      "earliest",
      "same-a",
      "same-b",
      "empty",
      "latest"
    ]);
  });

  it("moves one widget across placements, fences its clear, then allows a newer re-add", () => {
    let raw = create(SnapshotSchema, {});
    let snapshot = mapSnapshot(raw);
    let sequence = 0n;
    const applyWidget = (value: ReturnType<typeof widget> & { readonly removed?: boolean }): void => {
      sequence += 1n;
      const result = projectSnapshotEvent(raw, snapshot, create(EventSchema, {
        eventId: `extension-widget-${sequence}`,
        cursor: { generation: 1n, sequence },
        payload: { kind: { case: "extensionWidgetChanged", value: { widget: value } } }
      }));
      raw = result.rawSnapshot;
      snapshot = result.snapshot;
    };

    applyWidget(widget("moving", "above", 10n));
    applyWidget(widget("moving", "below", 20n));
    expect(snapshot.extensionWidgetsBySession.get("session-extension")).toEqual([
      expect.objectContaining({ key: "moving", placement: "belowEditor", lines: ["below"] })
    ]);

    applyWidget({ ...widget("moving", "below", 30n), removed: true });
    expect(snapshot.extensionWidgetsBySession.get("session-extension")).toBeUndefined();
    expect(raw.extensionWidgets).toEqual([expect.objectContaining({ widgetKey: "moving", removed: true })]);

    applyWidget(widget("moving", "above", 40n));
    expect(snapshot.extensionWidgetsBySession.get("session-extension")).toEqual([
      expect.objectContaining({ key: "moving", placement: "aboveEditor", lines: ["above"] })
    ]);
    expect(raw.extensionWidgets).toHaveLength(1);
  });

  it("ignores late older widget and status events, including resurrection after a clear", () => {
    let raw = create(SnapshotSchema, {});
    let snapshot = mapSnapshot(raw);
    let sequence = 0n;
    const apply = (kind: NonNullable<NonNullable<Event["payload"]>["kind"]>): void => {
      sequence += 1n;
      const result = projectSnapshotEvent(raw, snapshot, create(EventSchema, {
        eventId: `extension-state-${sequence}`,
        cursor: { generation: 1n, sequence },
        payload: { kind }
      }));
      raw = result.rawSnapshot;
      snapshot = result.snapshot;
    };

    apply({ case: "extensionWidgetChanged", value: create(ExtensionWidgetChangedEventSchema, { widget: widget("stable", "below", 50n) }) });
    apply({ case: "extensionWidgetChanged", value: create(ExtensionWidgetChangedEventSchema, { widget: widget("stable", "above", 40n) }) });
    expect(snapshot.extensionWidgetsBySession.get("session-extension")).toEqual([
      expect.objectContaining({ key: "stable", placement: "belowEditor", lines: ["below"] })
    ]);

    apply({ case: "extensionWidgetChanged", value: create(ExtensionWidgetChangedEventSchema, { widget: { ...widget("stable", "below", 60n), removed: true } }) });
    apply({ case: "extensionWidgetChanged", value: create(ExtensionWidgetChangedEventSchema, { widget: widget("stable", "above", 55n) }) });
    expect(snapshot.extensionWidgetsBySession.get("session-extension")).toBeUndefined();

    apply({ case: "extensionStatusChanged", value: create(ExtensionStatusChangedEventSchema, { status: status("mode", "new", 50n) }) });
    apply({ case: "extensionStatusChanged", value: create(ExtensionStatusChangedEventSchema, { status: status("mode", "old", 40n) }) });
    expect(snapshot.extensionStatusesBySession.get("session-extension")).toEqual([
      expect.objectContaining({ key: "mode", text: "new" })
    ]);
    apply({ case: "extensionStatusChanged", value: create(ExtensionStatusChangedEventSchema, { status: status("mode", undefined, 60n) }) });
    apply({ case: "extensionStatusChanged", value: create(ExtensionStatusChangedEventSchema, { status: status("mode", "late", 55n) }) });
    expect(snapshot.extensionStatusesBySession.get("session-extension")).toBeUndefined();
  });
});

function widget(key: string, placement: "above" | "below", seconds: bigint) {
  return create(ExtensionWidgetSchema, {
    sessionId: "session-extension",
    widgetKey: key,
    lines: [placement],
    placement: placement === "below" ? ExtensionWidgetPlacement.BELOW_EDITOR : ExtensionWidgetPlacement.ABOVE_EDITOR,
    updatedAt: { seconds, nanos: 0 }
  });
}

function status(key: string, text: string | undefined, seconds: bigint) {
  return create(ExtensionStatusSchema, {
    sessionId: "session-extension",
    statusKey: key,
    ...(text === undefined ? {} : { statusText: text }),
    updatedAt: { seconds, nanos: 0 }
  });
}

describe("browser takeover projection", () => {
  it("retains the complete remote-control fence and owner", () => {
    const snapshot = mapSnapshot(create(SnapshotSchema, {
      browsers: [{
        browserProviderId: "browser-1",
        displayName: "Managed browser",
        state: BrowserProviderState.READY,
        generation: 9n,
        pages: [{ pageId: "page-1", title: "Example", url: "https://example.test" }],
        takeover: {
          takeoverId: "takeover-1",
          pageId: "page-1",
          connectionId: "connection-1",
          state: BrowserTakeoverState.ACTIVE,
          generation: 9n,
          startedAt: { seconds: 100n },
          expiresAt: { seconds: 200n }
        }
      }]
    }));

    expect(snapshot.browsers[0]?.takeover).toEqual({
      id: "takeover-1",
      pageId: "page-1",
      connectionId: "connection-1",
      state: "active",
      generation: 9n,
      startedAt: 100_000,
      expiresAt: 200_000
    });
  });
});

describe("incremental event projection", () => {
  it("projects owner-snapshot background activity and its terminal stream edge", () => {
    const raw = create(SnapshotSchema, {
      generation: 8n,
      resumeCursor: { generation: 8n, sequence: 0n },
      sessions: [{
        sessionId: "session-background",
        backendId: "pi",
        targetId: "target",
        state: SessionState.IDLE
      }, {
        sessionId: "session-other",
        backendId: "pi",
        targetId: "target",
        state: SessionState.IDLE
      }],
      backgroundTasks: [{
        backgroundTaskId: "subagent-a",
        sessionId: "session-background",
        backendId: "pi",
        targetId: "target",
        displayName: "Research",
        state: BackgroundTaskState.RUNNING
      }, {
        backgroundTaskId: "subagent-a",
        sessionId: "session-other",
        backendId: "pi",
        targetId: "target",
        displayName: "Same native id, other Session",
        state: BackgroundTaskState.WAITING
      }]
    });
    const snapshot = mapSnapshot(raw);
    expect(snapshot.backgroundTasks).toEqual([
      { id: "subagent-a", sessionId: "session-background", state: "running" },
      { id: "subagent-a", sessionId: "session-other", state: "waiting" }
    ]);

    const completed = create(EventSchema, {
      eventId: "background-completed",
      cursor: { generation: 8n, sequence: 1n },
      identity: { sessionId: "session-background" },
      payload: { kind: { case: "backgroundTaskChanged", value: { backgroundTask: {
        backgroundTaskId: "subagent-a",
        parentTaskId: "parent-task",
        sessionId: "session-background",
        backendId: "pi",
        targetId: "target",
        runId: "run-background",
        displayName: "Research",
        state: BackgroundTaskState.SUCCEEDED,
        statusText: "Research complete",
        progressRatio: 1,
        startedAt: { seconds: 100n },
        endedAt: { seconds: 105n }
      } } } }
    });
    const projected = projectSnapshotEvent(raw, snapshot, completed);
    expect(projected.refresh).toBe("none");
    expect(projected.snapshot.backgroundTasks).toEqual([
      { id: "subagent-a", sessionId: "session-background", state: "completed" },
      { id: "subagent-a", sessionId: "session-other", state: "waiting" }
    ]);
    expect(projected.snapshot.backgroundTasks).not.toBe(snapshot.backgroundTasks);
    expect(projected.snapshot.timelineBySession.get("session-background")).toEqual([
      expect.objectContaining({
        background: expect.objectContaining({
          id: "subagent-a",
          parentTaskId: "parent-task",
          runId: "run-background",
          state: "completed",
          detail: "Research complete",
          progressRatio: 1,
          startedAt: 100_000,
          endedAt: 105_000
        })
      })
    ]);
  });

  it("keeps dual-cursor Session attention typed and outside the timeline", () => {
    const raw = create(SnapshotSchema, {
      generation: 8n,
      resumeCursor: { generation: 8n, sequence: 0n },
      sessions: [{
        sessionId: "session-attention",
        backendId: "pi",
        targetId: "target",
        state: SessionState.IDLE,
        attention: {
          kind: SessionAttentionKind.ERROR,
          unread: true,
          subjectCursor: { opaqueToken: "subject-40", sequence: 40n, generation: 3n },
          attentionCursor: { opaqueToken: "fence-44", sequence: 44n, generation: 3n },
          readThroughCursor: { opaqueToken: "read-0", sequence: 0n, generation: 0n },
          updatedAt: { seconds: 4n }
        }
      }]
    });
    const snapshot = mapSnapshot(raw);
    expect(snapshot.sessions[0]?.attention).toMatchObject({
      kind: "error",
      unread: true,
      subjectCursor: { sequence: 40n, generation: 3n },
      attentionCursor: { sequence: 44n, generation: 3n }
    });

    const event = create(EventSchema, {
      eventId: "attention-read",
      cursor: { generation: 8n, sequence: 1n },
      identity: { sessionId: "session-attention" },
      payload: { kind: { case: "sessionAttentionChanged", value: { attention: {
        kind: SessionAttentionKind.ERROR,
        unread: false,
        subjectCursor: { opaqueToken: "subject-40", sequence: 40n, generation: 3n },
        attentionCursor: { opaqueToken: "fence-46", sequence: 46n, generation: 3n },
        readThroughCursor: { opaqueToken: "fence-46", sequence: 46n, generation: 3n },
        updatedAt: { seconds: 5n }
      } } } }
    });
    const projected = projectSnapshotEvent(raw, snapshot, event);
    expect(projected.refresh).toBe("none");
    expect(projected.snapshot.sessions[0]?.attention).toMatchObject({
      kind: "error",
      unread: false,
      subjectCursor: { sequence: 40n },
      attentionCursor: { sequence: 46n },
      readThroughCursor: { sequence: 46n }
    });
    expect(projected.snapshot.timelineBySession.get("session-attention")).toBeUndefined();
  });

  it("never exposes queued-turn done attention between terminal and next-running stream events", () => {
    let raw = create(SnapshotSchema, {
      generation: 8n,
      resumeCursor: { generation: 8n, sequence: 0n },
      sessions: [{
        sessionId: "session-queue-attention",
        backendId: "pi",
        targetId: "target",
        state: SessionState.IDLE,
        attention: {
          kind: SessionAttentionKind.DONE,
          unread: true,
          subjectCursor: { opaqueToken: "done-a", sequence: 40n, generation: 3n },
          attentionCursor: { opaqueToken: "done-a", sequence: 40n, generation: 3n },
          readThroughCursor: { sequence: 0n, generation: 0n }
        }
      }]
    });
    let snapshot = mapSnapshot(raw);
    const visibility = createSidebarDoneAttentionVisibilityState();
    expect(reconcileSidebarDoneAttentionVisibility(visibility, snapshot.sessions, 0).nextRevealDelayMs).toBe(500);

    const apply = (sequence: bigint, payload: Event["payload"], runId = "run-b"): void => {
      const event = create(EventSchema, {
        eventId: `queue-attention-${sequence}`,
        cursor: { generation: 8n, sequence },
        identity: { sessionId: "session-queue-attention", runId },
        payload
      });
      const projected = projectSnapshotEvent(raw, snapshot, event);
      expect(projected.refresh).toBe("none");
      raw = projected.rawSnapshot;
      snapshot = projected.snapshot;
    };

    apply(1n, create(EventPayloadSchema, { kind: { case: "runChanged", value: { run: {
      runId: "run-b",
      sessionId: "session-queue-attention",
      backendId: "pi",
      targetId: "target",
      state: RunState.RUNNING
    } } } }));
    expect(snapshot.sessions[0]).toMatchObject({ state: "running", attention: { kind: "done", unread: true } });
    const cancelled = reconcileSidebarDoneAttentionVisibility(visibility, snapshot.sessions, 100);
    expect(cancelled.nextRevealDelayMs).toBeUndefined();
    expect(visibility.observations.size).toBe(0);

    apply(2n, create(EventPayloadSchema, { kind: { case: "sessionAttentionChanged", value: { attention: {
      kind: SessionAttentionKind.DONE,
      unread: false,
      subjectCursor: { opaqueToken: "done-a", sequence: 40n, generation: 3n },
      attentionCursor: { opaqueToken: "running-b", sequence: 42n, generation: 3n },
      readThroughCursor: { opaqueToken: "running-b", sequence: 42n, generation: 3n }
    } } } }));
    apply(3n, create(EventPayloadSchema, { kind: { case: "runChanged", value: { run: {
      runId: "run-b",
      sessionId: "session-queue-attention",
      backendId: "pi",
      targetId: "target",
      state: RunState.SUCCEEDED
    } } } }));
    apply(4n, create(EventPayloadSchema, { kind: { case: "sessionAttentionChanged", value: { attention: {
      kind: SessionAttentionKind.DONE,
      unread: true,
      subjectCursor: { opaqueToken: "done-b", sequence: 44n, generation: 3n },
      attentionCursor: { opaqueToken: "done-b", sequence: 44n, generation: 3n },
      readThroughCursor: { opaqueToken: "running-b", sequence: 42n, generation: 3n }
    } } } }));

    const finalStart = reconcileSidebarDoneAttentionVisibility(visibility, snapshot.sessions, 200);
    const finalBefore = reconcileSidebarDoneAttentionVisibility(visibility, snapshot.sessions, 699);
    const finalVisible = reconcileSidebarDoneAttentionVisibility(visibility, snapshot.sessions, 700);
    expect(finalStart.nextRevealDelayMs).toBe(500);
    expect(visibleSidebarAttention(snapshot.sessions[0]!, { visibleDoneAttentionKeys: finalBefore.visibleAttentionKeys })).toBeUndefined();
    expect(visibleSidebarAttention(snapshot.sessions[0]!, { visibleDoneAttentionKeys: finalVisible.visibleAttentionKeys })).toEqual(snapshot.sessions[0]?.attention);

    // Orchestrator publishes runChanged(waiting) before the matching authoritative
    // attention event. A previously revealed completion must disappear in
    // that intermediate stream frame rather than flashing as done.
    apply(5n, create(EventPayloadSchema, { kind: { case: "runChanged", value: { run: {
      runId: "run-c",
      sessionId: "session-queue-attention",
      backendId: "pi",
      targetId: "target",
      state: RunState.WAITING
    } } } }));
    const waitingFrame = reconcileSidebarDoneAttentionVisibility(visibility, snapshot.sessions, 701);
    expect(visibleSidebarAttention(snapshot.sessions[0]!, { visibleDoneAttentionKeys: waitingFrame.visibleAttentionKeys })).toBeUndefined();
    expect(sidebarSessionIndicatorState(snapshot.sessions[0]!, { visibleDoneAttentionKeys: waitingFrame.visibleAttentionKeys })).toBeUndefined();

    apply(6n, create(EventPayloadSchema, { kind: { case: "sessionAttentionChanged", value: { attention: {
      kind: SessionAttentionKind.AWAITING,
      unread: true,
      subjectCursor: { opaqueToken: "awaiting-c", sequence: 46n, generation: 3n },
      attentionCursor: { opaqueToken: "awaiting-c", sequence: 46n, generation: 3n },
      readThroughCursor: { opaqueToken: "running-b", sequence: 42n, generation: 3n }
    } } } }));
    expect(sidebarSessionIndicatorState(snapshot.sessions[0]!, { visibleDoneAttentionKeys: waitingFrame.visibleAttentionKeys })).toBe("awaiting");
  });

  it("manufactures only a missing running Review card in the source task", () => {
    const run = {
      reviewRunId: "review-fallback",
      sourceSessionId: "source-task",
      reviewerSessionId: "reviewer-task",
      state: ReviewRunState.RUNNING,
      targetKind: ReviewTargetKind.MIXED,
      freshness: { state: ReviewFreshnessState.CURRENT, checkedAt: { seconds: 100n } },
      evidence: {
        sealSha256Hex: "a".repeat(64),
        sourceRevision: {
          sealVersion: 1,
          conversationSha256Hex: "b".repeat(64),
          workspaceSha256Hex: "c".repeat(64),
          filesSha256Hex: "d".repeat(64),
          artifactsSha256Hex: "e".repeat(64)
        },
        targetKind: ReviewTargetKind.MIXED,
        capturedAt: { seconds: 100n }
      },
      createdAt: { seconds: 100n },
      updatedAt: { seconds: 101n },
      revision: { value: 1n }
    };
    const running = mapSnapshot(create(SnapshotSchema, {
      resumeCursor: { generation: 1n, sequence: 8n },
      reviewRuns: [run]
    }));
    expect(running.timelineBySession.get("source-task")).toEqual([
      expect.objectContaining({ id: "review:review-fallback", sequence: 9n, kind: "review" })
    ]);
    expect(running.timelineBySession.get("reviewer-task")).toBeUndefined();

    const terminal = mapSnapshot(create(SnapshotSchema, {
      resumeCursor: { generation: 1n, sequence: 8n },
      reviewRuns: [{ ...run, state: ReviewRunState.COMPLETED, resultMarkdown: "Done" }]
    }));
    expect(terminal.timelineBySession.get("source-task")).toBeUndefined();
  });

  it("projects one durable Review card only into the source task and updates it in place", () => {
    let raw = create(SnapshotSchema, { generation: 8n, resumeCursor: { generation: 8n, sequence: 0n } });
    let snapshot = mapSnapshot(raw);
    const apply = (
      sequence: bigint,
      state: ReviewRunState,
      resultMarkdown = "",
      failureCode = ReviewFailureCode.UNSPECIFIED,
      freshness = ReviewFreshnessState.CURRENT
    ): void => {
      const event = create(EventSchema, {
        eventId: `review-${sequence}`,
        cursor: { generation: 8n, sequence },
        identity: { sessionId: "source-task" },
        occurredAt: { seconds: 100n + sequence },
        payload: { kind: { case: "reviewRunChanged", value: { reviewRun: {
          reviewRunId: "review-1",
          sourceSessionId: "source-task",
          reviewerSessionId: "reviewer-task",
          state,
          targetKind: ReviewTargetKind.MIXED,
          resultMarkdown,
          freshness: { state: freshness, checkedAt: { seconds: 100n + sequence } },
          evidence: {
            sealSha256Hex: "a".repeat(64),
            sourceRevision: {
              sealVersion: 1,
              conversationSha256Hex: "b".repeat(64),
              workspaceSha256Hex: "c".repeat(64),
              filesSha256Hex: "d".repeat(64),
              artifactsSha256Hex: "e".repeat(64)
            },
            targetKind: ReviewTargetKind.MIXED,
            capturedAt: { seconds: 100n }
          },
          failureCode,
          createdAt: { seconds: 100n },
          updatedAt: { seconds: 100n + sequence },
          revision: { value: sequence }
        } } } }
      });
      const projected = projectSnapshotEvent(raw, snapshot, event);
      expect(projected.refresh).toBe("none");
      raw = projected.rawSnapshot;
      snapshot = projected.snapshot;
    };

    apply(1n, ReviewRunState.RUNNING);
    apply(2n, ReviewRunState.COMPLETED, "## Findings\n\nNo blockers.");
    apply(3n, ReviewRunState.COMPLETED, "## Findings\n\nNo blockers.", ReviewFailureCode.UNSPECIFIED, ReviewFreshnessState.STALE);

    expect(snapshot.reviewRuns).toEqual([expect.objectContaining({
      id: "review-1",
      sourceSessionId: "source-task",
      reviewerSessionId: "reviewer-task",
      state: "completed",
      freshness: "stale",
      result: "## Findings\n\nNo blockers.",
      revision: 3n
    })]);
    expect(snapshot.timelineBySession.get("source-task")).toEqual([expect.objectContaining({
      id: "review:review-1",
      sequence: 1n,
      kind: "review",
      review: expect.objectContaining({ state: "completed", freshness: "stale" })
    })]);
    expect(snapshot.timelineBySession.get("reviewer-task")).toBeUndefined();
  });

  it("rejects Review records missing first-version freshness or evidence fields", () => {
    const reviewWithoutFreshness = {
      reviewRunId: "review-strict-v1",
      sourceSessionId: "source-task",
      state: ReviewRunState.RUNNING,
      targetKind: ReviewTargetKind.MIXED,
      createdAt: { seconds: 100n },
      updatedAt: { seconds: 100n },
      revision: { value: 1n }
    };
    expect(() => mapSnapshot(create(SnapshotSchema, { reviewRuns: [reviewWithoutFreshness] }))).toThrow(/without freshness/u);
    expect(() => mapSnapshot(create(SnapshotSchema, { reviewRuns: [{
      ...reviewWithoutFreshness,
      freshness: { state: ReviewFreshnessState.CURRENT, checkedAt: { seconds: 100n } }
    }] }))).toThrow(/without evidence identity/u);
  });

  it("requests an authoritative transcript after a durable message deletion event", () => {
    const raw = create(SnapshotSchema, {
      generation: 4n,
      resumeCursor: { generation: 4n, sequence: 1n }
    });
    const deleted = create(EventSchema, {
      eventId: "message-delete-boundary",
      cursor: { generation: 4n, sequence: 2n },
      identity: { sessionId: "session-delete" },
      payload: { kind: { case: "messageDeleted", value: {
        productSessionId: "session-delete",
        requestedEventId: "event-assistant-complete",
        deletedEventIds: ["event-assistant-complete", "event-tool-result"]
      } } }
    });

    const projected = projectSnapshotEvent(raw, mapSnapshot(raw), deleted);
    expect(projected.refresh).toBe("authoritative");
    expect(projected.snapshot.timelineHistoryRevisionBySession.get("session-delete")).toBe(2n);
  });

  it("projects a native context replacement as a typed system boundary", () => {
    const raw = create(SnapshotSchema, {
      generation: 4n,
      resumeCursor: { generation: 4n, sequence: 1n }
    });
    const rebuilt = create(EventSchema, {
      eventId: "context-rebuild-boundary",
      cursor: { generation: 4n, sequence: 2n },
      identity: { sessionId: "session-rebuild" },
      occurredAt: { seconds: 123n },
      payload: { kind: { case: "contextRebuilt", value: {
        productSessionId: "session-rebuild",
        reason: ContextRebuildReason.CONTEXT_OVERFLOW,
        handoff: "[JOKO SAFE CONTEXT HANDOFF]\nSurviving context.",
        sourceRunId: "run-failed",
        replayScheduled: true
      } } }
    });

    const projected = projectSnapshotEvent(raw, mapSnapshot(raw), rebuilt);
    expect(projected.refresh).toBe("none");
    expect(projected.rawSnapshot.timeline).toEqual([rebuilt]);
    expect(projected.snapshot.timelineBySession.get("session-rebuild")).toEqual([{
      id: "context-rebuild-boundary",
      sequence: 2n,
      kind: "contextRebuild",
      createdAt: 123_000,
      contextRebuild: {
        reason: "contextOverflow",
        handoff: "[JOKO SAFE CONTEXT HANDOFF]\nSurviving context.",
        sourceRunId: "run-failed",
        replayScheduled: true
      }
    }]);
  });

  it("eagerly hides only the cleared task and requests its authoritative empty generation", () => {
    const timelineEvent = (sessionId: string, sequence: bigint): Event => create(EventSchema, {
      eventId: `status-${sessionId}`,
      cursor: { generation: 4n, sequence },
      identity: { sessionId },
      payload: { kind: { case: "statusStream", value: { statusId: `status-${sessionId}`, label: "Old work" } } }
    });
    const raw = create(SnapshotSchema, {
      generation: 4n,
      resumeCursor: { generation: 4n, sequence: 2n },
      sessions: [
        { sessionId: "session-clear", backendId: "pi", targetId: "target", state: SessionState.IDLE },
        { sessionId: "session-keep", backendId: "pi", targetId: "target", state: SessionState.IDLE }
      ],
      runtimeCommands: [
        { commandId: "clear-old", sessionId: "session-clear", name: "old", source: RuntimeCommandSource.EXTENSION, loaded: true },
        { commandId: "keep-command", sessionId: "session-keep", name: "keep", source: RuntimeCommandSource.EXTENSION, loaded: true }
      ],
      timeline: [timelineEvent("session-clear", 1n), timelineEvent("session-keep", 2n)]
    });
    const reset = create(EventSchema, {
      eventId: "reset-boundary",
      cursor: { generation: 4n, sequence: 3n },
      identity: { sessionId: "session-clear" },
      payload: { kind: { case: "sessionReset", value: { productSessionId: "session-clear" } } }
    });

    const projected = projectSnapshotEvent(raw, mapSnapshot(raw), reset);
    expect(projected.refresh).toBe("authoritative");
    expect(projected.rawSnapshot.sessions.map((session) => session.sessionId)).toEqual(["session-clear", "session-keep"]);
    expect(projected.rawSnapshot.timeline.map((event) => event.identity?.sessionId)).toEqual(["session-keep"]);
    expect(projected.snapshot.timelineBySession.get("session-clear")).toBeUndefined();
    expect(projected.snapshot.timelineBySession.get("session-keep")).toHaveLength(1);
    expect(projected.snapshot.commands.map((command) => command.id)).toEqual(["keep-command"]);
  });

  it("eagerly removes only the pruned task history while retaining the task shell", () => {
    const timelineEvent = (sessionId: string, sequence: bigint): Event => create(EventSchema, {
      eventId: `history-${sessionId}`,
      cursor: { generation: 4n, sequence },
      identity: { sessionId },
      payload: { kind: { case: "statusStream", value: { statusId: `history-${sessionId}`, label: "Old work" } } }
    });
    const raw = create(SnapshotSchema, {
      generation: 4n,
      resumeCursor: { generation: 4n, sequence: 2n },
      sessions: [
        { sessionId: "session-pruned", backendId: "pi", targetId: "target", state: SessionState.IDLE },
        { sessionId: "session-retained", backendId: "pi", targetId: "target", state: SessionState.IDLE }
      ],
      runtimeCommands: [
        { commandId: "pruned-command", sessionId: "session-pruned", name: "old", source: RuntimeCommandSource.EXTENSION, loaded: true },
        { commandId: "retained-command", sessionId: "session-retained", name: "keep", source: RuntimeCommandSource.EXTENSION, loaded: true }
      ],
      timeline: [timelineEvent("session-pruned", 1n), timelineEvent("session-retained", 2n)]
    });
    const pruned = create(EventSchema, {
      eventId: "history-pruned-boundary",
      cursor: { generation: 4n, sequence: 3n },
      identity: { sessionId: "session-pruned" },
      payload: { kind: { case: "historyPruned", value: {
        productSessionId: "session-pruned",
        activeContextReset: true
      } } }
    });

    const projected = projectSnapshotEvent(raw, mapSnapshot(raw), pruned);
    expect(projected.refresh).toBe("authoritative");
    expect(projected.rawSnapshot.sessions.map((session) => session.sessionId))
      .toEqual(["session-pruned", "session-retained"]);
    expect(projected.rawSnapshot.timeline.map((event) => event.identity?.sessionId))
      .toEqual(["session-retained"]);
    expect(projected.snapshot.timelineBySession.get("session-pruned")).toBeUndefined();
    expect(projected.snapshot.timelineBySession.get("session-retained")).toHaveLength(1);
    expect(projected.snapshot.commands.map((command) => command.id)).toEqual(["retained-command"]);
  });

  it("coalesces an answered question into a stable Q/A item without exposing sensitive references", () => {
    let raw = create(SnapshotSchema, { generation: 2n, resumeCursor: { generation: 2n, sequence: 0n } });
    let snapshot = mapSnapshot(raw);
    const apply = (sequence: bigint, state: InteractionState, resolution?: any): void => {
      const event = create(EventSchema, {
        eventId: "interaction-event-" + sequence,
        cursor: { generation: 2n, sequence },
        identity: { sessionId: "session-1" },
        payload: { kind: { case: "interactionChanged", value: { interaction: {
          interactionId: "question-1",
          kind: InteractionKind.QUESTION,
          state,
          sessionId: "session-1",
          createdAt: { seconds: 100n },
          request: { case: "question", value: {
            title: "Choose release mode",
            prompt: "Two details",
            fields: [
              { fieldId: "mode", label: "Mode", input: { case: "singleChoice", value: { choices: [{ choiceId: "fast", label: "Fast" }] } } },
              { fieldId: "token", label: "Token", input: { case: "text", value: { answerHandling: QuestionAnswerHandling.CREDENTIAL_CHANNEL } } }
            ]
          } },
          ...(resolution === undefined ? {} : { resolution })
        } } } }
      });
      const projected = projectSnapshotEvent(raw, snapshot, event);
      raw = projected.rawSnapshot;
      snapshot = projected.snapshot;
    };

    apply(1n, InteractionState.PENDING);
    apply(2n, InteractionState.RESOLVED, { decision: { case: "question", value: { answers: [
      { fieldId: "mode", value: { case: "choiceId", value: "fast" } },
      { fieldId: "token", value: { case: "sensitive", value: { credentialUploadTicketId: "secret-ticket" } } }
    ] } } });

    const timeline = snapshot.timelineBySession.get("session-1") ?? [];
    expect(timeline).toHaveLength(1);
    expect(timeline[0]).toMatchObject({
      id: "interaction:question-1",
      sequence: 1n,
      interaction: {
        state: "resolved",
        questions: [
          { question: "Mode", answer: { kind: "text", values: ["Fast"] } },
          { question: "Token", answer: { kind: "sensitive" } }
        ]
      }
    });
    expect(JSON.stringify(timeline.map((item) => item.interaction))).not.toContain("secret-ticket");
  });

  it("clears stale context usage when Pi reports that the post-compaction window is unknown", () => {
    const raw = create(SnapshotSchema, {
      generation: 3n,
      resumeCursor: { generation: 3n, sequence: 0n },
      sessions: [{
        sessionId: "session-context",
        backendId: "pi",
        targetId: "target",
        state: SessionState.IDLE,
        context: {
          usedTokens: 90n,
          contextWindowTokens: 100n,
          cumulativeUsage: { inputTokens: 70n, outputTokens: 20n, totalTokens: 90n }
        }
      }]
    });
    const event = create(EventSchema, {
      eventId: "context-unknown",
      cursor: { generation: 3n, sequence: 1n },
      identity: { sessionId: "session-context" },
      payload: { kind: { case: "contextUsageChanged", value: { context: undefined } } }
    });

    const projected = projectSnapshotEvent(raw, mapSnapshot(raw), event);
    expect(projected.rawSnapshot.sessions[0]?.context).toBeUndefined();
    expect(projected.snapshot.sessions[0]?.context).toBeUndefined();
  });

  it("retains Pi retry countdown data as transient run-owned timeline state", () => {
    const raw = create(SnapshotSchema, {
      generation: 3n,
      resumeCursor: { generation: 3n, sequence: 0n },
      sessions: [{
        sessionId: "session-retry",
        backendId: "pi",
        targetId: "target",
        displayName: "Retry task",
        state: SessionState.RUNNING
      }],
      runs: [{
        runId: "run-retry",
        sessionId: "session-retry",
        backendId: "pi",
        targetId: "target",
        state: RunState.RUNNING
      }]
    });
    const silentEvent = create(EventSchema, {
      eventId: "retry-silent",
      cursor: { generation: 3n, sequence: 1n },
      identity: { sessionId: "session-retry", runId: "run-retry" },
      payload: { kind: { case: "retryChanged", value: {
        runId: "run-retry",
        state: RetryState.WAITING,
        attemptNumber: 1,
        maxAttempts: 5,
        retryAt: { seconds: 101n }
      } } }
    });
    const silent = projectSnapshotEvent(raw, mapSnapshot(raw), silentEvent);
    expect(silent.rawSnapshot.runs[0]?.state).toBe(RunState.RETRYING);
    expect(silent.snapshot.sessions[0]?.state).toBe("retrying");
    expect(silent.snapshot.timelineBySession.get("session-retry")?.[0]?.retry).not.toHaveProperty("error");

    const event = create(EventSchema, {
      eventId: "retry-waiting",
      cursor: { generation: 3n, sequence: 2n },
      identity: { sessionId: "session-retry", runId: "run-retry" },
      payload: { kind: { case: "retryChanged", value: {
        runId: "run-retry",
        state: RetryState.WAITING,
        attemptNumber: 2,
        maxAttempts: 5,
        retryAt: { seconds: 105n },
        error: {
          code: "UPSTREAM_OVERLOAD",
          message: "redacted capacity detail",
          phase: "retry",
          severity: ErrorSeverity.RETRYABLE,
          retryable: true
        }
      } } }
    });

    const item = projectSnapshotEvent(silent.rawSnapshot, silent.snapshot, event).snapshot.timelineBySession.get("session-retry")?.at(-1);
    expect(item).toMatchObject({
      id: "retry-waiting",
      runId: "run-retry",
      kind: "status",
      retry: {
        state: "waiting",
        source: "auto",
        attemptNumber: 2,
        maxAttempts: 5,
        retryAt: 105_000,
        error: {
          code: "UPSTREAM_OVERLOAD",
          message: "redacted capacity detail",
          phase: "retry",
          severity: "retryable",
          retryable: true
        }
      }
    });
  });

  it("replaces only the Session-scoped runtime catalog named by event identity", () => {
    const raw = create(SnapshotSchema, {
      snapshotId: "commands-snapshot",
      generation: 7n,
      revision: { value: 1n },
      resumeCursor: { generation: 7n, sequence: 0n },
      runtimeCommands: [
        {
          commandId: "session-1-review",
          sessionId: "session-1",
          name: "review",
          description: "Review",
          source: RuntimeCommandSource.EXTENSION,
          loaded: true
        },
        {
          commandId: "session-2-old",
          sessionId: "session-2",
          name: "old",
          description: "Old",
          source: RuntimeCommandSource.PROMPT,
          loaded: true
        }
      ]
    });
    const snapshot = mapSnapshot(raw);
    const event = create(EventSchema, {
      eventId: "commands-event",
      cursor: { generation: 7n, sequence: 1n },
      identity: { sessionId: "session-2" },
      payload: {
        kind: {
          case: "runtimeCommandsChanged",
          value: {
            commands: [{
              commandId: "session-2-new",
              // The identity is authoritative even if a malformed payload
              // attempts to claim another Session.
              sessionId: "session-1",
              name: "new",
              description: "New",
              source: RuntimeCommandSource.SKILL,
              loaded: true
            }]
          }
        }
      }
    });

    const projected = projectSnapshotEvent(raw, snapshot, event);
    expect(projected.snapshot.commands).toEqual([
      expect.objectContaining({ id: "session-1-review", sessionId: "session-1", name: "review" }),
      expect.objectContaining({ id: "session-2-new", sessionId: "session-2", name: "new" })
    ]);
    expect(projected.snapshot.commands.some((command) => command.name === "old")).toBe(false);
    expect(projected.rawSnapshot.runtimeCommands.map((command) => command.sessionId)).toEqual([
      "session-1",
      "session-2"
    ]);
  });

  it("applies live tool output modes and keeps the terminal result authoritative", () => {
    let raw = create(SnapshotSchema, {
      generation: 3n,
      resumeCursor: { generation: 3n, sequence: 0n },
      sessions: [{
        sessionId: "session-tool-stream",
        backendId: "backend-1",
        targetId: "target-1",
        state: SessionState.RUNNING
      }]
    });
    let snapshot = mapSnapshot(raw);
    let sequence = 0n;
    const apply = (payload: Event["payload"]): void => {
      sequence += 1n;
      const projected = projectSnapshotEvent(raw, snapshot, create(EventSchema, {
        eventId: `tool-stream-${sequence}`,
        cursor: { generation: 3n, sequence },
        identity: { sessionId: "session-tool-stream", runId: "run-1" },
        payload
      }));
      expect(projected.refresh).toBe("none");
      raw = projected.rawSnapshot;
      snapshot = projected.snapshot;
    };
    const output = (): string | undefined => snapshot.timelineBySession
      .get("session-tool-stream")
      ?.find((item) => item.id === "tool-stream")
      ?.tool?.output;

    apply(create(EventPayloadSchema, { kind: { case: "toolCallStarted", value: { toolCall: {
      toolCallId: "tool-stream",
      toolId: "shell",
      sessionId: "session-tool-stream",
      runId: "run-1",
      state: ToolCallState.RUNNING
    } } } }));
    apply(create(EventPayloadSchema, { kind: { case: "toolCallUpdated", value: {
      toolCall: { toolCallId: "tool-stream", toolId: "shell", state: ToolCallState.RUNNING },
      incrementalResult: { parts: [
        { content: { case: "text", value: "A" } },
        { content: { case: "image", value: { altText: "first", blob: {
          blobId: "image-a",
          fileName: "a.png",
          mediaType: "image/png",
          byteSize: 10n
        } } } }
      ] },
      outputMode: ToolCallOutputMode.APPEND
    } } }));
    expect(output()).toBe("A");

    apply(create(EventPayloadSchema, { kind: { case: "toolCallUpdated", value: {
      toolCall: { toolCallId: "tool-stream", toolId: "shell", state: ToolCallState.RUNNING },
      incrementalResult: { parts: [
        { content: { case: "text", value: "B" } },
        { content: { case: "image", value: { altText: "second", blob: {
          blobId: "image-b",
          fileName: "b.png",
          mediaType: "image/png",
          byteSize: 20n
        } } } }
      ] },
      outputMode: ToolCallOutputMode.APPEND
    } } }));
    expect(output()).toBe("AB");
    expect(snapshot.timelineBySession.get("session-tool-stream")?.find((item) => item.id === "tool-stream")?.attachments)
      .toEqual([
        expect.objectContaining({ blobId: "image-a", title: "first" }),
        expect.objectContaining({ blobId: "image-b", title: "second" })
      ]);

    apply(create(EventPayloadSchema, { kind: { case: "toolCallUpdated", value: {
      toolCall: { toolCallId: "tool-stream", toolId: "shell", state: ToolCallState.RUNNING },
      incrementalResult: { parts: [{ content: { case: "text", value: "replacement" } }] },
      outputMode: ToolCallOutputMode.REPLACE
    } } }));
    expect(output()).toBe("replacement");
    expect(snapshot.timelineBySession.get("session-tool-stream")?.find((item) => item.id === "tool-stream")?.attachments)
      .toBeUndefined();

    apply(create(EventPayloadSchema, { kind: { case: "toolCallCompleted", value: { toolCall: {
      toolCallId: "tool-stream",
      toolId: "shell",
      sessionId: "session-tool-stream",
      runId: "run-1",
      state: ToolCallState.SUCCEEDED,
      result: { parts: [{ content: { case: "text", value: "terminal" } }] }
    } } } }));
    expect(snapshot.timelineBySession.get("session-tool-stream")?.find((item) => item.id === "tool-stream")).toMatchObject({
      kind: "toolResult",
      tool: { state: "succeeded", output: "terminal" }
    });
  });

  it("creates a generic assistant message with text and image from completion alone", () => {
    const raw = create(SnapshotSchema, {
      generation: 1n,
      resumeCursor: { generation: 1n, sequence: 0n }
    });
    const event = create(EventSchema, {
      eventId: "generic-complete-event",
      cursor: { generation: 1n, sequence: 1n },
      identity: { sessionId: "generic-session", runId: "generic-run" },
      payload: { kind: { case: "messageCompleted", value: {
        messageId: "generic-message",
        role: MessageRole.ASSISTANT,
        blocks: [
          { content: { case: "text", value: "Final without deltas" } },
          { content: { case: "image", value: {
            altText: "Final preview",
            blob: {
              blobId: "generic-image",
              fileName: "preview.png",
              mediaType: "image/png",
              byteSize: 17n,
              sha256Hex: "c".repeat(64)
            }
          } } }
        ]
      } } }
    });

    const timeline = projectSnapshotEvent(raw, mapSnapshot(raw), event).snapshot.timelineBySession.get("generic-session");
    expect(timeline).toEqual([expect.objectContaining({
      id: "generic-message",
      messageId: "generic-message",
      contentIndex: 0,
      sourceEventId: "generic-complete-event",
      runId: "generic-run",
      kind: "assistant",
      text: "Final without deltas",
      streaming: false,
      attachments: [expect.objectContaining({
        blobId: "generic-image",
        kind: "image",
        title: "Final preview"
      })]
    })]);
  });

  it("creates a native-identified assistant message from completion alone", () => {
    const raw = create(SnapshotSchema, {
      generation: 1n,
      resumeCursor: { generation: 1n, sequence: 0n }
    });
    const event = create(EventSchema, {
      eventId: "native-complete-event",
      cursor: { generation: 1n, sequence: 1n },
      identity: { sessionId: "native-session", runId: "native-run" },
      payload: { kind: { case: "messageCompleted", value: {
        messageId: "native-message",
        role: MessageRole.ASSISTANT,
        nativeIdentity: { entryId: "native-entry", parentEntryId: "native-parent" },
        blocks: [
          { content: { case: "text", value: "Recovered native answer" } },
          { content: { case: "image", value: {
            blob: {
              blobId: "native-image",
              fileName: "native.png",
              mediaType: "image/png",
              byteSize: 23n,
              sha256Hex: "d".repeat(64)
            }
          } } }
        ]
      } } }
    });

    expect(projectSnapshotEvent(raw, mapSnapshot(raw), event).snapshot.timelineBySession.get("native-session"))
      .toEqual([expect.objectContaining({
        id: "native-message",
        nativeEntryId: "native-entry",
        nativeParentEntryId: "native-parent",
        text: "Recovered native answer",
        attachments: [expect.objectContaining({ blobId: "native-image", kind: "image" })],
        streaming: false
      })]);
  });

  it("reconciles indexed deltas against authoritative completion blocks without duplicates", () => {
    let raw = create(SnapshotSchema, {
      generation: 1n,
      resumeCursor: { generation: 1n, sequence: 0n }
    });
    let snapshot = mapSnapshot(raw);
    let sequence = 0n;
    const apply = (kind: any): void => {
      sequence += 1n;
      const result = projectSnapshotEvent(raw, snapshot, create(EventSchema, {
        eventId: `indexed-event-${sequence}`,
        cursor: { generation: 1n, sequence },
        identity: { sessionId: "indexed-session", runId: "indexed-run" },
        payload: { kind }
      }));
      raw = result.rawSnapshot;
      snapshot = result.snapshot;
    };

    apply({ case: "thinkingDelta", value: { messageId: "indexed-message", contentIndex: 0, delta: "draft reasoning" } });
    apply({ case: "textDelta", value: { messageId: "indexed-message", contentIndex: 3, delta: "draft tail" } });
    apply({ case: "textDelta", value: { messageId: "indexed-message", contentIndex: 1, delta: "draft answer" } });
    apply({ case: "textDelta", value: { messageId: "indexed-message", contentIndex: 4, delta: "stale block" } });
    expect(snapshot.timelineBySession.get("indexed-session")?.find((item) => item.kind === "assistant")?.text)
      .toBe("draft answerdraft tailstale block");
    apply({ case: "messageCompleted", value: {
      messageId: "indexed-message",
      role: MessageRole.ASSISTANT,
      blocks: [
        { content: { case: "thinking", value: { text: "final reasoning" } } },
        { content: { case: "text", value: "Final answer" } },
        { content: { case: "image", value: {
          altText: "Answer diagram",
          blob: {
            blobId: "indexed-image",
            fileName: "diagram.png",
            mediaType: "image/png",
            byteSize: 31n,
            sha256Hex: "e".repeat(64)
          }
        } } },
        { content: { case: "text", value: "Final tail" } }
      ]
    } });

    const timeline = snapshot.timelineBySession.get("indexed-session") ?? [];
    expect(timeline.map((item) => [item.kind, item.contentIndex, item.text])).toEqual([
      ["thinking", 0, "final reasoning"],
      ["assistant", 1, "Final answerFinal tail"]
    ]);
    expect(timeline.filter((item) => item.id === "indexed-message")).toHaveLength(1);
    expect(timeline.filter((item) => item.messageId === "indexed-message")).toHaveLength(2);
    expect(timeline.find((item) => item.id === "indexed-message")?.attachments)
      .toEqual([expect.objectContaining({ blobId: "indexed-image", title: "Answer diagram" })]);
    expect(timeline.every((item) => item.streaming === false)).toBe(true);
  });

  it("reduces streaming, tool, run, queue, and session events without requesting a snapshot", () => {
    let raw = create(SnapshotSchema, {
      snapshotId: "snapshot-1",
      generation: 7n,
      revision: { value: 1n },
      resumeCursor: { generation: 7n, sequence: 0n },
      sessions: [{
        sessionId: "session-1",
        backendId: "backend-1",
        targetId: "target-1",
        displayName: "Initial",
        state: SessionState.IDLE,
        permissionMode: 1,
        lastActivityAt: { seconds: 999n }
      }]
    });
    let snapshot = mapSnapshot(raw);
    expect(snapshot.sessions[0]).not.toHaveProperty("activeRunStartedAt");
    let sequence = 0n;

    const apply = (payload: any, identity: { sessionId?: string; runId?: string } = { sessionId: "session-1" }): string => {
      sequence += 1n;
      const event = create(EventSchema, {
        eventId: `event-${sequence}`,
        cursor: { generation: 7n, sequence },
        identity,
        payload: { kind: payload }
      });
      const result = projectSnapshotEvent(raw, snapshot, event);
      expect(result.refresh).toBe("none");
      raw = result.rawSnapshot;
      snapshot = result.snapshot;
      return event.eventId;
    };

    apply({ case: "runChanged", value: {
      run: {
        runId: "run-1",
        sessionId: "session-1",
        targetId: "target-1",
        backendId: "backend-1",
        state: RunState.RUNNING,
        startedAt: { seconds: 123n, nanos: 456_000_000 }
      }
    } });
    expect(snapshot.sessions.find((candidate) => candidate.id === "session-1")).toMatchObject({
      activeRunId: "run-1",
      activeRunStartedAt: 123_456
    });
    apply({ case: "queueItemChanged", value: {
      queueItem: {
        queueItemId: "queue-1",
        sessionId: "session-1",
        targetId: "target-1",
        backendId: "backend-1",
        runId: "run-1",
        sourceKind: QueueSourceKind.UI,
        state: QueueItemState.BACKEND_ACCEPTED,
        editLocked: true,
        deliveryMode: QueueDeliveryMode.PROMPT,
        version: { revision: { value: 1n }, generation: 1n },
        input: { parts: [{ content: { case: "text", value: "Explain this" } }] }
      }
    } });
    apply({ case: "queueControlChanged", value: {
      queueControl: { sessionId: "session-1", backendId: "backend-1", targetId: "target-1", dispatchState: QueueDispatchState.PAUSED, pauseReason: "Review first", queuedItemCount: 1n, interactionLocked: true, version: { revision: { value: 1n }, generation: 1n } }
    } });
    apply({ case: "messageStarted", value: { messageId: "message-1", role: MessageRole.ASSISTANT } });
    apply({ case: "textDelta", value: { messageId: "message-1", contentIndex: 1, delta: "Hello" } });
    apply({ case: "thinkingDelta", value: { messageId: "message-1", contentIndex: 0, delta: "Reasoning" } });
    apply(
      { case: "statusStream", value: { statusId: "working", label: "Working", detail: "Half way" } },
      { sessionId: "session-1", runId: "run-1" }
    );
    apply(
      { case: "statusStream", value: { statusId: "working", label: "Working", detail: "Done", terminal: true } },
      { sessionId: "session-1", runId: "run-1" }
    );
    apply({ case: "toolCallStarted", value: {
      toolCall: {
        toolCallId: "tool-1",
        sessionId: "session-1",
        runId: "run-1",
        toolId: "read",
        state: ToolCallState.RUNNING,
        arguments: [{ fieldPath: "$", value: { case: "text", value: "{\"path\":\"README.md\"}" } }]
      }
    } });
    apply({ case: "artifactProduced", value: {
      artifact: {
        artifactId: "image-1",
        title: "tool preview",
        kind: ArtifactKind.IMAGE,
        blob: {
          blobId: "image-1",
          fileName: "preview.png",
          mediaType: "image/png",
          byteSize: 12n,
          sha256Hex: "a".repeat(64)
        }
      }
    } });
    apply({ case: "toolCallCompleted", value: {
      toolCall: {
        toolCallId: "tool-1",
        sessionId: "session-1",
        runId: "run-1",
        toolId: "read",
        state: ToolCallState.SUCCEEDED,
        result: { parts: [
          { content: { case: "text", value: "file contents" } },
          { content: { case: "image", value: {
            altText: "tool preview",
            blob: {
              blobId: "image-1",
              fileName: "preview.png",
              mediaType: "image/png",
              byteSize: 12n,
              sha256Hex: "a".repeat(64)
            }
          } } }
        ] }
      }
    } });
    const completionEventId = apply({ case: "messageCompleted", value: {
      messageId: "message-1",
      role: MessageRole.ASSISTANT,
      blocks: [
        { content: { case: "thinking", value: { text: "Reasoning" } } },
        { content: { case: "text", value: "Hello" } }
      ],
      usage: {
        inputTokens: 11n,
        outputTokens: 7n,
        cacheReadTokens: 3n,
        cacheWriteTokens: 2n,
        totalTokens: 23n,
        costMicros: 12_345n,
        currencyCode: "USD"
      },
      generationDurationMs: 1_200n,
      generationReliable: true
    } });
    apply({ case: "extensionWidgetChanged", value: {
      widget: {
        sessionId: "session-1",
        widgetKey: "checks",
        lines: ["Unit: passed"],
        placement: ExtensionWidgetPlacement.BELOW_EDITOR
      }
    } });
    apply({ case: "extensionWidgetChanged", value: {
      widget: {
        sessionId: "session-1",
        widgetKey: "checks",
        lines: [],
        placement: ExtensionWidgetPlacement.BELOW_EDITOR,
        removed: false
      }
    } });
    apply({ case: "extensionStatusChanged", value: {
      status: { sessionId: "session-1", statusKey: "lint", statusText: "Checking" }
    } });
    apply({ case: "runDone", value: { runId: "run-1" } }, { sessionId: "session-1", runId: "run-1" });
    apply({ case: "sessionChanged", value: {
      session: {
        sessionId: "session-1",
        backendId: "backend-1",
        targetId: "target-1",
        displayName: "Renamed",
        automationOrigin: {
          scheduleId: "schedule-1",
          scheduleName: "Nightly",
          runId: "run-1"
        },
        state: SessionState.IDLE,
        permissionMode: 1
      }
    } });

    const session = snapshot.sessions.find((candidate) => candidate.id === "session-1");
    expect(session).toMatchObject({
      name: "Renamed",
      state: "idle",
      automationOrigin: {
        kind: "scheduler",
        scheduleId: "schedule-1",
        scheduleName: "Nightly",
        runId: "run-1"
      }
    });
    expect(session?.activeRunId).toBeUndefined();
    expect(session?.activeRunStartedAt).toBeUndefined();
    expect(snapshot.queue).toEqual([expect.objectContaining({ id: "queue-1", text: "Explain this", state: "acceptedByBackend", editLocked: true })]);
    expect(snapshot.queueControls).toEqual([expect.objectContaining({ sessionId: "session-1", state: "paused", pauseReason: "Review first", queuedItemCount: 1, interactionLocked: true })]);
    expect(snapshot.extensionWidgetsBySession.get("session-1")).toEqual([
      expect.objectContaining({ key: "checks", lines: [], placement: "belowEditor" })
    ]);
    expect(snapshot.extensionStatusesBySession.get("session-1")).toEqual([
      expect.objectContaining({ key: "lint", text: "Checking" })
    ]);
    apply({ case: "extensionWidgetChanged", value: {
      widget: {
        sessionId: "session-1",
        widgetKey: "checks",
        lines: [],
        placement: ExtensionWidgetPlacement.BELOW_EDITOR,
        removed: true
      }
    } });
    expect(snapshot.extensionWidgetsBySession.get("session-1")).toBeUndefined();

    const timeline = snapshot.timelineBySession.get("session-1") ?? [];
    expect(timeline.find((item) => item.id === "message-1")).toMatchObject({
      kind: "assistant",
      text: "Hello",
      streaming: false,
      sourceEventId: completionEventId,
      usage: {
        inputTokens: 11,
        outputTokens: 7,
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
        totalTokens: 23,
        cost: 0.012345,
        currency: "USD",
        generationDurationMs: 1_200,
        generationReliable: true
      }
    });
    expect(timeline.find((item) => item.id === "message-1:thinking:0")).toMatchObject({ kind: "thinking", text: "Reasoning", streaming: false });
    expect(timeline.find((item) => item.id === "message-1:thinking:0")).not.toHaveProperty("usage");
    expect(timeline.filter((item) => item.id === "working")).toEqual([expect.objectContaining({
      text: "Done",
      streaming: false,
      runId: "run-1"
    })]);
    expect(timeline.find((item) => item.id === "tool-1")).toMatchObject({
      kind: "toolResult",
      runId: "run-1",
      tool: { name: "read", state: "succeeded", input: "$: {\"path\":\"README.md\"}", output: "file contents" },
      attachments: [{ blobId: "image-1", kind: "image", fileName: "preview.png", title: "tool preview" }]
    });
    expect(timeline.filter((item) => item.kind === "artifact" && item.artifact?.blobId === "image-1")).toEqual([]);
    expect(timeline.at(-1)).toMatchObject({ title: "Task complete", runId: "run-1", runTerminal: "completed" });
    expect(snapshot.cursor).toBe(sequence);
    expect(raw.resumeCursor?.sequence).toBe(sequence);
  });

  it("rejects reliable generation timing without an authoritative positive duration", () => {
    const raw = create(SnapshotSchema, { resumeCursor: { generation: 1n, sequence: 0n } });
    const snapshot = mapSnapshot(raw);
    const event = create(EventSchema, {
      eventId: "message-complete-invalid-timing",
      cursor: { generation: 1n, sequence: 1n },
      identity: { sessionId: "session-1", runId: "run-1" },
      payload: {
        kind: {
          case: "messageCompleted",
          value: {
            messageId: "message-1",
            role: MessageRole.ASSISTANT,
            usage: {
              inputTokens: 1n,
              outputTokens: 1n,
              totalTokens: 2n,
              currencyCode: "USD"
            },
            generationReliable: true
          }
        }
      }
    });
    expect(() => projectSnapshotEvent(raw, snapshot, event)).toThrow(/without a duration/u);
  });

  it("coalesces unsafe entity refreshes and marks invalidations authoritative", () => {
    const raw = create(SnapshotSchema, {
      snapshotId: "snapshot-1",
      generation: 3n,
      revision: { value: 1n },
      resumeCursor: { generation: 3n, sequence: 0n }
    });
    const snapshot = mapSnapshot(raw);
    const workspaceDiff = create(EventSchema, {
      eventId: "diff-1",
      cursor: { generation: 3n, sequence: 1n },
      identity: { sessionId: "session-1" },
      payload: { kind: { case: "workspaceDiffProduced", value: { turnId: "turn-1", changeSet: { changeSetId: "changes-1", workspaceId: "workspace-1", completeBaseline: true }, diff: { workspaceId: "workspace-1", truncated: true, files: [{ relativePath: "src/app.ts", status: GitFileStatus.MODIFIED, hunks: [{ oldStart: 2, oldCount: 1, newStart: 2, newCount: 1, heading: "handler", lines: [{ kind: DiffLineKind.REMOVED, oldLine: 2, text: "old" }, { kind: DiffLineKind.ADDED, newLine: 2, text: "new" }] }] }] } } } }
    });
    const projected = projectSnapshotEvent(raw, snapshot, workspaceDiff);
    expect(projected.refresh).toBe("batched");
    expect(projected.snapshot.timelineBySession.get("session-1")).toEqual([
      expect.objectContaining({ kind: "diff", title: "Workspace changes", workspaceDiff: expect.objectContaining({ workspaceId: "workspace-1", changeSetId: "changes-1", truncated: true, completeBaseline: true, files: [expect.objectContaining({ path: "src/app.ts", hunks: [expect.objectContaining({ heading: "handler", lines: [expect.objectContaining({ kind: "removed" }), expect.objectContaining({ kind: "added" })] })] })] }) })
    ]);

    const invalidated = create(EventSchema, {
      eventId: "invalidate-1",
      cursor: { generation: 3n, sequence: 2n },
      payload: { kind: { case: "projectionInvalidated", value: { reason: SnapshotInvalidationReason.EVENT_GAP } } }
    });
    expect(projectSnapshotEvent(projected.rawSnapshot, projected.snapshot, invalidated).refresh).toBe("authoritative");
  });

  it("projects authoritative created files alongside the existing workspace diff", () => {
    const raw = create(SnapshotSchema, { resumeCursor: { generation: 3n, sequence: 0n } });
    const event = create(EventSchema, {
      eventId: "generated-files-one",
      cursor: { generation: 3n, sequence: 1n },
      identity: { sessionId: "session-one" },
      payload: {
        kind: {
          case: "workspaceDiffProduced",
          value: {
            turnId: "turn-one",
            changeSet: {
              changeSetId: "change-set-one",
              workspaceId: "workspace-one",
              completeBaseline: true,
              changes: [
                { relativePath: "reports/output.pdf", kind: FileChangeKind.CREATED, afterRevision: { opaqueRevision: "created-one" } },
                { relativePath: "src/existing.ts", kind: FileChangeKind.UPDATED, afterRevision: { opaqueRevision: "updated-one" } }
              ]
            },
            diff: {
              workspaceId: "workspace-one",
              files: [{ relativePath: "reports/output.pdf", status: GitFileStatus.ADDED }]
            }
          }
        }
      }
    });

    const projected = projectSnapshotEvent(raw, mapSnapshot(raw), event);
    expect(projected.snapshot.timelineBySession.get("session-one")?.[0]?.workspaceDiff).toMatchObject({
      files: [expect.objectContaining({ path: "reports/output.pdf" })],
      generatedFiles: [{ relativePath: "reports/output.pdf", displayName: "output.pdf" }]
    });
  });

  it("binds a timeline error to the run that emitted it", () => {
    const raw = create(SnapshotSchema, { resumeCursor: { generation: 4n, sequence: 0n } });
    const snapshot = mapSnapshot(raw);
    const event = create(EventSchema, {
      eventId: "error-1",
      cursor: { generation: 4n, sequence: 1n },
      identity: { sessionId: "session-1", runId: "run-old" },
      payload: { kind: { case: "recoverableError", value: { error: { code: "RATE_LIMIT", message: "Try later", phase: "stream", severity: ErrorSeverity.RETRYABLE, retryable: true } } } }
    });
    const projected = projectSnapshotEvent(raw, snapshot, event);
    expect(projected.snapshot.timelineBySession.get("session-1")?.[0]?.error).toMatchObject({ runId: "run-old", code: "RATE_LIMIT", retryable: true });
  });

  it("projects failed and aborted run terminals as durable plan-lifetime metadata", () => {
    const raw = create(SnapshotSchema, { resumeCursor: { generation: 4n, sequence: 0n } });
    const failed = create(EventSchema, {
      eventId: "failed-1",
      cursor: { generation: 4n, sequence: 1n },
      identity: { sessionId: "session-1", runId: "run-failed" },
      payload: { kind: { case: "terminalError", value: { error: { code: "FAILED", message: "Stopped", phase: "stream", severity: ErrorSeverity.FATAL } } } }
    });
    const failedProjection = projectSnapshotEvent(raw, mapSnapshot(raw), failed);
    expect(failedProjection.snapshot.timelineBySession.get("session-1")?.[0]).toMatchObject({
      runId: "run-failed",
      runTerminal: "failed",
      kind: "error"
    });

    const aborted = create(EventSchema, {
      eventId: "aborted-1",
      cursor: { generation: 4n, sequence: 2n },
      identity: { sessionId: "session-1", runId: "run-aborted" },
      payload: { kind: { case: "runAborted", value: { runId: "run-aborted", reason: "User stopped" } } }
    });
    const abortedProjection = projectSnapshotEvent(failedProjection.rawSnapshot, failedProjection.snapshot, aborted);
    expect(abortedProjection.snapshot.timelineBySession.get("session-1")?.at(-1)).toMatchObject({
      runId: "run-aborted",
      runTerminal: "aborted",
      kind: "status"
    });
  });

  it("coalesces each typed compaction lifecycle without merging later compactions", () => {
    let raw = create(SnapshotSchema, { generation: 4n, resumeCursor: { generation: 4n, sequence: 0n } });
    let snapshot = mapSnapshot(raw);
    const apply = (eventId: string, sequence: bigint, value: {
      readonly compactionId: string;
      readonly state: CompactionState;
      readonly reason: string;
      readonly automatic: boolean;
      readonly boundaryId?: string;
      readonly tokensBefore?: bigint;
      readonly tokensAfter?: bigint;
      readonly willRetry?: boolean;
    }): void => {
      const event = create(EventSchema, {
        eventId,
        cursor: { generation: 4n, sequence },
        identity: { sessionId: "session-1" },
        payload: { kind: { case: "compactionChanged", value } }
      });
      const projected = projectSnapshotEvent(raw, snapshot, event);
      raw = projected.rawSnapshot;
      snapshot = projected.snapshot;
    };

    apply("compact-1:start", 1n, { compactionId: "compact-1", state: CompactionState.STARTED, reason: "threshold", automatic: true, tokensBefore: 12_345n });
    expect(snapshot.timelineBySession.get("session-1")).toEqual([
      expect.objectContaining({
        id: "compact-1:start",
        sequence: 1n,
        compaction: expect.objectContaining({ id: "compact-1", state: "started", reason: "threshold", automatic: true })
      })
    ]);
    expect(snapshot.timelineBySession.get("session-1")?.[0]?.title).toBeUndefined();

    apply("compact-1:end", 2n, { compactionId: "compact-1", state: CompactionState.COMPLETED, reason: "threshold", automatic: true, boundaryId: "entry-7", tokensBefore: 12_345n, tokensAfter: 2_345n, willRetry: false });
    expect(snapshot.timelineBySession.get("session-1")).toEqual([
      expect.objectContaining({
        id: "compact-1:start",
        sequence: 1n,
        compaction: { id: "compact-1", state: "completed", reason: "threshold", automatic: true, boundaryId: "entry-7", tokensBefore: 12_345, tokensAfter: 2_345, willRetry: false }
      })
    ]);
    expect(snapshot.timelineBySession.get("session-1")?.[0]?.text).toBeUndefined();

    apply("compact-2:start", 3n, { compactionId: "compact-2", state: CompactionState.STARTED, reason: "manual", automatic: false });
    apply("compact-2:end", 4n, { compactionId: "compact-2", state: CompactionState.ABORTED, reason: "manual", automatic: false, willRetry: false });
    const timeline = snapshot.timelineBySession.get("session-1") ?? [];
    expect(timeline).toHaveLength(2);
    expect(timeline[1]).toMatchObject({
      id: "compact-2:start",
      sequence: 3n,
      compaction: { id: "compact-2", state: "aborted", reason: "manual", automatic: false, willRetry: false }
    });
    expect(timeline[1]?.title).toBeUndefined();
    expect(timeline[1]?.text).toBeUndefined();

    apply("compact-3:start", 5n, { compactionId: "compact-3", state: CompactionState.STARTED, reason: "overflow", automatic: true, tokensBefore: 40_000n });
    apply("compact-3:end", 6n, { compactionId: "compact-3", state: CompactionState.COMPLETED, reason: "", automatic: false, tokensAfter: 8_000n });
    expect(snapshot.timelineBySession.get("session-1")?.[2]?.compaction).toEqual({
      id: "compact-3",
      state: "completed",
      reason: "overflow",
      automatic: true,
      tokensBefore: 40_000,
      tokensAfter: 8_000
    });
  });

  it("projects compacting only from the Backend-neutral Session context state", () => {
    const project = (compacting: boolean | undefined) => mapSnapshot(create(SnapshotSchema, {
      sessions: [{
        sessionId: "session-1",
        backendId: "backend-1",
        targetId: "target-1",
        state: SessionState.IDLE,
        ...(compacting === undefined ? {} : { contextState: { compacting } })
      }],
      // Namespaced detail cannot affect the shared Session projection.
      pi: { sessions: [{
        backendId: "backend-1",
        targetId: "target-1",
        productSessionId: "session-1",
        sessionState: { compacting: true }
      }] }
    })).sessions[0]?.compacting;

    expect(project(false)).toBe(false);
    expect(project(true)).toBe(true);
    expect(project(undefined)).toBeUndefined();
  });

  it("overlays typed lifecycle events without rewriting namespaced Backend detail", () => {
    const raw = create(SnapshotSchema, {
      generation: 4n,
      resumeCursor: { generation: 4n, sequence: 0n },
      sessions: [{ sessionId: "session-1", backendId: "backend-1", targetId: "target-1", state: SessionState.IDLE, contextState: { compacting: false } }],
      pi: { sessions: [{
        backendId: "backend-1",
        targetId: "target-1",
        productSessionId: "session-1",
        sessionState: { compacting: false }
      }] }
    });
    const started = create(EventSchema, {
      eventId: "compact:start",
      cursor: { generation: 4n, sequence: 1n },
      identity: { sessionId: "session-1" },
      payload: { kind: { case: "compactionChanged", value: { compactionId: "compact-1", state: CompactionState.STARTED, reason: "manual" } } }
    });
    const projection = projectSnapshotEvent(raw, mapSnapshot(raw), started);
    expect(projection.snapshot.sessions[0]?.compacting).toBe(true);
    expect(projection.rawSnapshot.pi?.sessions[0]?.sessionState?.compacting).toBe(false);

    const completed = create(EventSchema, {
      eventId: "compact:end",
      cursor: { generation: 4n, sequence: 2n },
      identity: { sessionId: "session-1" },
      payload: { kind: { case: "compactionChanged", value: { compactionId: "compact-1", state: CompactionState.COMPLETED } } }
    });
    const terminal = projectSnapshotEvent(projection.rawSnapshot, projection.snapshot, completed);
    expect(terminal.snapshot.sessions[0]?.compacting).toBe(false);
    expect(terminal.rawSnapshot.pi?.sessions[0]?.sessionState?.compacting).toBe(false);
  });

  it("projects typed historical image and file input as authenticated blob attachments", () => {
    const raw = create(SnapshotSchema, { generation: 1n, resumeCursor: { generation: 1n, sequence: 0n } });
    const event = create(EventSchema, {
      eventId: "message-event",
      cursor: { generation: 1n, sequence: 1n },
      identity: { sessionId: "session-1", runId: "run-1" },
      payload: { kind: { case: "messageStarted", value: { messageId: "message-1", role: MessageRole.USER, userInput: { parts: [
        { content: { case: "text", value: "Inspect these" } },
        { content: { case: "image", value: { altText: "diagram", blob: { blobId: "blob-image", fileName: "diagram.png", mediaType: "image/png", byteSize: 120n } } } },
        { content: { case: "file", value: { blobId: "blob-file", fileName: "notes.txt", mediaType: "text/plain", byteSize: 42n } } }
      ] } } } }
    });
    const projected = projectSnapshotEvent(raw, mapSnapshot(raw), event).snapshot.timelineBySession.get("session-1")?.[0];
    expect(projected).toMatchObject({ kind: "user", runId: "run-1", text: "Inspect these", attachments: [
      { blobId: "blob-image", kind: "image", title: "diagram", byteSize: 120 },
      { blobId: "blob-file", kind: "file", fileName: "notes.txt", byteSize: 42 }
    ] });
  });

  it("projects only the durable quotesEncoded event gate onto user timeline rows", () => {
    const raw = create(SnapshotSchema, { generation: 1n, resumeCursor: { generation: 1n, sequence: 0n } });
    const markedText = "> <!-- joko-selection-quote -->\n> selected\n\nreply";
    const encoded = create(EventSchema, {
      eventId: "encoded-quote-event",
      cursor: { generation: 1n, sequence: 1n },
      identity: { sessionId: "session-1", runId: "run-1" },
      payload: { kind: { case: "messageStarted", value: {
        messageId: "encoded-user-message",
        role: MessageRole.USER,
        userInput: {
          parts: [{ content: { case: "text", value: markedText } }],
          quotesEncoded: true,
          pastedTextRanges: [{ start: 44, end: 49, display: "Pasted text (1 line)" }]
        },
        quotesEncoded: true
      } } }
    });
    const encodedProjection = projectSnapshotEvent(raw, mapSnapshot(raw), encoded).snapshot;
    expect(encodedProjection.timelineBySession.get("session-1")?.[0]).toMatchObject({
      kind: "user",
      text: markedText,
      quotesEncoded: true,
      pastedTextRanges: [{ start: 44, end: 49, display: "Pasted text (1 line)" }]
    });

    const typed = create(EventSchema, {
      eventId: "typed-marker-event",
      cursor: { generation: 1n, sequence: 2n },
      identity: { sessionId: "session-2", runId: "run-2" },
      payload: { kind: { case: "messageStarted", value: {
        messageId: "typed-user-message",
        role: MessageRole.USER,
        userInput: { parts: [{ content: { case: "text", value: markedText } }] }
      } } }
    });
    const typedProjection = projectSnapshotEvent(raw, mapSnapshot(raw), typed).snapshot;
    expect(typedProjection.timelineBySession.get("session-2")?.[0]).toMatchObject({ kind: "user", text: markedText });
    expect(typedProjection.timelineBySession.get("session-2")?.[0]).not.toHaveProperty("quotesEncoded");

    const malformed = create(EventSchema, {
      eventId: "malformed-paste-event",
      cursor: { generation: 1n, sequence: 3n },
      identity: { sessionId: "session-3", runId: "run-3" },
      payload: { kind: { case: "messageStarted", value: {
        messageId: "malformed-user-message",
        role: MessageRole.USER,
        userInput: {
          parts: [{ content: { case: "text", value: "short" } }],
          pastedTextRanges: [{ start: 0, end: 8, display: "outside" }]
        }
      } } }
    });
    expect(() => projectSnapshotEvent(raw, mapSnapshot(raw), malformed)).toThrow("invalid pasted-text metadata");
  });

  it("projects a continuation marker and folds recovery lifecycle updates into one activity row", () => {
    const raw = create(SnapshotSchema, { generation: 1n, resumeCursor: { generation: 1n, sequence: 0n } });
    const waiting = create(EventSchema, {
      eventId: "runtime-recovery-waiting",
      cursor: { generation: 1n, sequence: 1n },
      identity: { sessionId: "session-1", runId: "run-source" },
      payload: { kind: { case: "runtimeRecoveryChanged", value: {
        recoveryId: "recovery-1",
        sourceRunId: "run-source",
        state: RuntimeRecoveryState.WAITING,
        attempt: 2,
        maximumAttempts: 5,
        sessionTotal: 4,
        delayMs: 6_000,
        error: {
          code: "UPSTREAM_OVERLOAD",
          message: "Stream disconnected.",
          phase: "stream",
          severity: ErrorSeverity.RETRYABLE,
          retryable: true
        }
      } } }
    });
    const projectedWaiting = projectSnapshotEvent(raw, mapSnapshot(raw), waiting);
    expect(projectedWaiting.snapshot.timelineBySession.get("session-1")?.[0]).toMatchObject({
      kind: "runtimeRecovery",
      runtimeRecovery: {
        id: "recovery-1",
        sourceRunId: "run-source",
        state: "waiting",
        attempt: 2,
        maximumAttempts: 5,
        sessionTotal: 4,
        delayMs: 6_000
      }
    });

    const prompt = create(EventSchema, {
      eventId: "runtime-recovery-prompt",
      cursor: { generation: 1n, sequence: 2n },
      identity: { sessionId: "session-1", runId: "run-continuation" },
      payload: { kind: { case: "messageStarted", value: {
        messageId: "message-continuation",
        role: MessageRole.USER,
        userInput: { parts: [{ content: { case: "text", value: "Continue" } }] },
        automaticContinuation: true,
        runtimeRecoveryId: "recovery-1"
      } } }
    });
    const projectedPrompt = projectSnapshotEvent(projectedWaiting.rawSnapshot, projectedWaiting.snapshot, prompt);
    expect(projectedPrompt.snapshot.timelineBySession.get("session-1")?.find((item) => item.id === "message-continuation"))
      .toMatchObject({ automaticContinuation: { recoveryId: "recovery-1" } });

    const succeeded = create(EventSchema, {
      eventId: "runtime-recovery-succeeded",
      cursor: { generation: 1n, sequence: 3n },
      identity: { sessionId: "session-1", runId: "run-continuation" },
      payload: { kind: { case: "runtimeRecoveryChanged", value: {
        recoveryId: "recovery-1",
        sourceRunId: "run-source",
        continuationRunId: "run-continuation",
        state: RuntimeRecoveryState.SUCCEEDED,
        attempt: 2,
        maximumAttempts: 5,
        sessionTotal: 4,
        error: {
          code: "UPSTREAM_OVERLOAD",
          message: "Stream disconnected.",
          phase: "stream",
          severity: ErrorSeverity.RETRYABLE,
          retryable: true
        }
      } } }
    });
    const projectedSucceeded = projectSnapshotEvent(projectedPrompt.rawSnapshot, projectedPrompt.snapshot, succeeded).snapshot;
    const recoveryRows = projectedSucceeded.timelineBySession.get("session-1")
      ?.filter((item) => item.runtimeRecovery?.id === "recovery-1");
    expect(recoveryRows).toHaveLength(1);
    expect(recoveryRows?.[0]?.runtimeRecovery).toMatchObject({
      state: "succeeded",
      continuationRunId: "run-continuation"
    });
  });

  it("projects only typed scheduler origin metadata onto user timeline rows", () => {
    const raw = create(SnapshotSchema, { generation: 1n, resumeCursor: { generation: 1n, sequence: 0n } });
    const event = create(EventSchema, {
      eventId: "scheduled-message-event",
      cursor: { generation: 1n, sequence: 1n },
      identity: { sessionId: "session-1", runId: "run-1" },
      payload: { kind: { case: "messageStarted", value: {
        messageId: "scheduled-message",
        role: MessageRole.USER,
        userInput: { parts: [{ content: { case: "text", value: "Inspect nightly" } }] },
        inputDelivery: MessageInputDelivery.SCHEDULER,
        automationOrigin: { scheduleId: "schedule-1", scheduleName: "Nightly", runId: "run-1" }
      } } }
    });

    expect(projectSnapshotEvent(raw, mapSnapshot(raw), event).snapshot.timelineBySession.get("session-1")?.[0]).toMatchObject({
      kind: "user",
      inputDelivery: "scheduler",
      automationOrigin: { kind: "scheduler", scheduleId: "schedule-1", scheduleName: "Nightly", runId: "run-1" }
    });
  });

  it("maps explicit continuation delivery while leaving untyped imported history unspecified", () => {
    const raw = create(SnapshotSchema, { generation: 1n, resumeCursor: { generation: 1n, sequence: 0n } });
    const steer = create(EventSchema, {
      eventId: "steer-message-event",
      cursor: { generation: 1n, sequence: 1n },
      identity: { sessionId: "session-1", runId: "run-steer" },
      payload: { kind: { case: "messageStarted", value: {
        messageId: "steer-message",
        role: MessageRole.USER,
        inputDelivery: MessageInputDelivery.STEER,
        userInput: { parts: [{ content: { case: "text", value: "redirect" } }] }
      } } }
    });
    const imported = create(EventSchema, {
      eventId: "imported-message-event",
      cursor: { generation: 1n, sequence: 2n },
      identity: { sessionId: "session-2", runId: "run-imported" },
      payload: { kind: { case: "messageStarted", value: {
        messageId: "imported-message",
        role: MessageRole.USER,
        userInput: { parts: [{ content: { case: "text", value: "imported" } }] }
      } } }
    });

    expect(projectSnapshotEvent(raw, mapSnapshot(raw), steer).snapshot.timelineBySession.get("session-1")?.[0])
      .toMatchObject({ kind: "user", inputDelivery: "steer" });
    expect(projectSnapshotEvent(raw, mapSnapshot(raw), imported).snapshot.timelineBySession.get("session-2")?.[0])
      .not.toHaveProperty("inputDelivery");
  });

  it("retains exact opaque message entry boundaries from the Backend-neutral event payload", () => {
    const raw = create(SnapshotSchema, { generation: 1n, resumeCursor: { generation: 1n, sequence: 0n } });
    const started = create(EventSchema, {
      eventId: "message-started",
      cursor: { generation: 1n, sequence: 1n },
      identity: { sessionId: "session-1" },
      payload: { kind: { case: "messageStarted", value: {
        messageId: "message-1",
        role: MessageRole.USER,
        userInput: { parts: [{ content: { case: "text", value: "Question" } }] },
        nativeIdentity: { entryId: "user-entry", parentEntryId: "parent-entry" }
      } } }
    });
    const projected = projectSnapshotEvent(raw, mapSnapshot(raw), started);
    expect(projected.snapshot.timelineBySession.get("session-1")?.[0]).toMatchObject({
      nativeEntryId: "user-entry",
      nativeParentEntryId: "parent-entry"
    });

    const completed = create(EventSchema, {
      eventId: "message-completed",
      cursor: { generation: 1n, sequence: 2n },
      identity: { sessionId: "session-1" },
      payload: { kind: { case: "messageCompleted", value: {
        messageId: "message-1",
        role: MessageRole.USER,
        nativeIdentity: { entryId: "user-entry", parentEntryId: "parent-entry" }
      } } }
    });
    expect(projectSnapshotEvent(projected.rawSnapshot, projected.snapshot, completed).snapshot.timelineBySession.get("session-1")?.[0]).toMatchObject({
      sourceEventId: "message-completed",
      nativeEntryId: "user-entry",
      nativeParentEntryId: "parent-entry",
      streaming: false
    });
  });
});

describe("provider and model projection", () => {
  it("preserves provider auth/rate state and complete BYOM model configuration", () => {
    const snapshot = mapSnapshot(create(SnapshotSchema, {
      providers: [{ backendId: "backend-custom", providerId: "custom", displayName: "Custom", kind: ProviderKind.CUSTOM_ENDPOINT, apiCompatibility: ProviderApiCompatibility.OPENAI_RESPONSES, authenticationState: AuthenticationState.AUTHENTICATED, endpointDisplay: "https://example.test/v1", supportsLogin: true, loginMethods: [ProviderLoginMethod.API_KEY], supportsLogout: true, supportsRefresh: true, capabilities: { schemaVersion: "joko.provider.v1", capabilities: [{ name: "provider.account_usage", support: CapabilitySupport.SUPPORTED }] }, accountUsage: { providerId: "custom", primaryWindow: { usedPercent: 42, windowMinutes: 300, resetAt: { seconds: 1_800_003_600n } }, secondaryWindow: { usedPercent: 75, windowMinutes: 10_080 }, limitReached: false, planType: "pro", credits: { hasCredits: true, unlimited: false, balance: "4.50", observedAt: { seconds: 1_800_000_000n } }, observedAt: { seconds: 1_800_000_000n } }, rateLimit: { limited: false, requestLimit: 100n, requestsRemaining: 77n, tokenLimit: 1_000n, tokensRemaining: 800n }, usage: { providerId: "custom", usage: { inputTokens: 12n, outputTokens: 8n, costMicros: 25_000n, currencyCode: "USD" }, estimated: true } }],
      models: [{ backendId: "backend-custom", key: { providerId: "custom", modelId: "model-a" }, displayName: "Model A", contextWindowTokens: 128_000n, maximumOutputTokens: 16_000n, inputModalities: [ModelInputModality.TEXT, ModelInputModality.IMAGE, ModelInputModality.FILE], outputModalities: [ModelOutputModality.TEXT], supportsFastMode: true, available: true, inputCostMicrosPerMillion: 10n, outputCostMicrosPerMillion: 20n, currencyCode: "USD", effortLevels: [{ effortId: "high", order: 1 }] }],
      settings: { agentResource: {}, collaboration: {}, gitSafety: {}, providers: [{ providerId: "custom", displayName: "Custom", kind: ProviderKind.CUSTOM_ENDPOINT, apiCompatibility: ProviderApiCompatibility.OPENAI_RESPONSES, endpoint: "https://example.test/v1", enabled: true, authHeader: true, headers: [{ headerName: "X-Key", environmentName: "CUSTOM_KEY" }], models: [{ modelId: "model-a", displayName: "Model A", reasoning: true, inputModalities: [ModelInputModality.TEXT, ModelInputModality.IMAGE], contextWindowTokens: 128_000n, maximumOutputTokens: 16_000n, inputCostMicrosPerMillion: 10n, outputCostMicrosPerMillion: 20n, cacheReadCostMicrosPerMillion: 2n, cacheWriteCostMicrosPerMillion: 3n, thinkingLevels: [{ effortId: "high", nativeLevel: "xhigh" }], sampling: { temperature: 0.2, topP: 0.9, seed: 4n }, compatibility: { supportsDeveloperRole: true, supportsStrictTools: false, thinkingFormat: "openai" }, supportsFastMode: true }] }] }
    }));
    expect(snapshot.providers[0]).toMatchObject({ backendId: "backend-custom", authenticationState: "authenticated", supportsLogin: true, loginMethods: ["apiKey"], supportsLogout: true, supportsRefresh: true, capabilities: new Set(["provider.account_usage"]), accountUsage: { planType: "pro", limitReached: false, primaryWindow: { usedPercent: 42, windowMinutes: 300, resetAt: 1_800_003_600_000 }, secondaryWindow: { usedPercent: 75, windowMinutes: 10_080 }, credits: { hasCredits: true, unlimited: false, balance: "4.50", observedAt: 1_800_000_000_000 } }, rateLimit: { requestLimit: 100, requestsRemaining: 77 }, usage: { inputTokens: 12, outputTokens: 8, cost: 0.025, currency: "USD", estimated: true } });
    expect(snapshot.models[0]).toMatchObject({ backendId: "backend-custom", inputModalities: ["text", "image", "file"], outputModalities: ["text"], maximumOutputTokens: 16_000, inputCostMicrosPerMillion: 10, supportsFast: true });
    expect(snapshot.settings.providers[0]).toMatchObject({ headers: [{ headerName: "X-Key", environmentName: "CUSTOM_KEY" }], models: [{ modelId: "model-a", reasoning: true, inputModalities: ["text", "image"], contextWindowTokens: 128_000, maximumOutputTokens: 16_000, thinkingLevels: [{ effortId: "high", nativeLevel: "xhigh" }], sampling: { temperature: 0.2, topP: 0.9, seed: 4 }, compatibilityOptions: { supportsDeveloperRole: true, supportsStrictTools: false, thinkingFormat: "openai" }, supportsFastMode: true }] });
  });

  it("projects subscription access and missing upstream pricing onto model rows", () => {
    const snapshot = mapSnapshot(create(SnapshotSchema, {
      providers: [{
        backendId: "backend-subscription",
        providerId: "provider-subscription",
        displayName: "Subscription provider",
        kind: ProviderKind.SUBSCRIPTION,
        capabilities: {
          schemaVersion: "joko.provider.v1",
          capabilities: [{ name: "model.pricing", support: CapabilitySupport.UPSTREAM_MISSING }]
        }
      }],
      models: [{
        backendId: "backend-subscription",
        key: { providerId: "provider-subscription", modelId: "model-one" },
        displayName: "Model one",
        available: true
      }]
    }));

    expect(snapshot.models[0]).toMatchObject({
      providerAccessKind: "subscription",
      pricingKnown: false
    });
  });

  it("projects Backend model access settings onto Provider and model routes", () => {
    const snapshot = mapSnapshot(create(SnapshotSchema, {
      providers: [
        { backendId: "backend-access", providerId: "provider-disabled", displayName: "Disabled Provider" },
        { backendId: "backend-access", providerId: "provider-enabled", displayName: "Enabled Provider" }
      ],
      models: [
        { backendId: "backend-access", key: { providerId: "provider-disabled", modelId: "model-a" }, displayName: "Model A", available: true },
        { backendId: "backend-access", key: { providerId: "provider-enabled", modelId: "model-b" }, displayName: "Model B", available: true }
      ],
      settings: {
        agentResource: {},
        collaboration: {},
        gitSafety: {},
        backends: [{
          backendId: "backend-access",
          enabled: true,
          modelAccess: {
            disabledProviderIds: ["provider-disabled"],
            disabledModels: [{ providerId: "provider-enabled", modelId: "model-b" }]
          }
        }]
      }
    }));

    expect(snapshot.providers.map((provider) => [provider.id, provider.routingEnabled])).toEqual([
      ["provider-disabled", false],
      ["provider-enabled", true]
    ]);
    expect(snapshot.models.map((model) => [model.modelId, model.routingEnabled])).toEqual([
      ["model-a", false],
      ["model-b", false]
    ]);
  });

  it("keeps a disabled Provider configuration out of projected routing", () => {
    const snapshot = mapSnapshot(create(SnapshotSchema, {
      providers: [{ backendId: "backend-access", providerId: "provider-disabled", displayName: "Disabled Provider", ownerManaged: true }],
      models: [{ backendId: "backend-access", key: { providerId: "provider-disabled", modelId: "model-a" }, displayName: "Model A", available: true }],
      settings: {
        agentResource: {},
        collaboration: {},
        gitSafety: {},
        providers: [{
          providerId: "provider-disabled",
          displayName: "Disabled Provider",
          kind: ProviderKind.CUSTOM_ENDPOINT,
          apiCompatibility: ProviderApiCompatibility.OPENAI_RESPONSES,
          enabled: false
        }]
      }
    }));

    expect(snapshot.providers[0]?.routingEnabled).toBe(false);
    expect(snapshot.models[0]?.routingEnabled).toBe(false);
  });

  it("keeps a disabled Provider configuration out of routing after a settings event", () => {
    const provider = {
      providerId: "provider-event",
      displayName: "Event Provider",
      kind: ProviderKind.CUSTOM_ENDPOINT,
      apiCompatibility: ProviderApiCompatibility.OPENAI_RESPONSES,
      enabled: true
    };
    const raw = create(SnapshotSchema, {
      generation: 1n,
      resumeCursor: { generation: 1n, sequence: 0n },
      providers: [{ backendId: "backend-event", providerId: provider.providerId, displayName: provider.displayName, ownerManaged: true }],
      models: [{ backendId: "backend-event", key: { providerId: provider.providerId, modelId: "model-event" }, displayName: "Event Model", available: true }],
      settings: { agentResource: {}, collaboration: {}, gitSafety: {}, providers: [provider] }
    });
    const event = create(EventSchema, {
      eventId: "settings-provider-disabled",
      cursor: { generation: 1n, sequence: 1n },
      payload: { kind: { case: "settingsChanged", value: { settings: {
        agentResource: {},
        collaboration: {},
        gitSafety: {},
        providers: [{ ...provider, enabled: false }]
      } } } }
    });

    const snapshot = projectSnapshotEvent(raw, mapSnapshot(raw), event).snapshot;

    expect(snapshot.providers[0]?.routingEnabled).toBe(false);
    expect(snapshot.models[0]?.routingEnabled).toBe(false);
  });

  it("keeps native routing enabled when a managed Provider with the same ID is disabled", () => {
    const snapshot = mapSnapshot(create(SnapshotSchema, {
      providers: [
        { backendId: "backend-managed", providerId: "provider-shared", displayName: "Managed Provider", ownerManaged: true },
        { backendId: "backend-native", providerId: "provider-shared", displayName: "Native Provider", ownerManaged: false }
      ],
      models: [
        { backendId: "backend-managed", key: { providerId: "provider-shared", modelId: "managed-model" }, displayName: "Managed Model", available: true },
        { backendId: "backend-native", key: { providerId: "provider-shared", modelId: "native-model" }, displayName: "Native Model", available: true }
      ],
      settings: {
        agentResource: {},
        collaboration: {},
        gitSafety: {},
        providers: [{
          providerId: "provider-shared",
          displayName: "Managed Provider",
          kind: ProviderKind.CUSTOM_ENDPOINT,
          apiCompatibility: ProviderApiCompatibility.OPENAI_RESPONSES,
          enabled: false
        }]
      }
    }));

    expect(snapshot.providers.map((provider) => [provider.backendId, provider.routingEnabled])).toEqual([
      ["backend-managed", false],
      ["backend-native", true]
    ]);
    expect(snapshot.models.map((model) => [model.backendId, model.routingEnabled])).toEqual([
      ["backend-managed", false],
      ["backend-native", true]
    ]);
  });

  it("preserves native routing when a settings event disables a managed Provider with the same ID", () => {
    const configuredProvider = {
      providerId: "provider-shared-event",
      displayName: "Managed Provider",
      kind: ProviderKind.CUSTOM_ENDPOINT,
      apiCompatibility: ProviderApiCompatibility.OPENAI_RESPONSES,
      enabled: true
    };
    const raw = create(SnapshotSchema, {
      generation: 1n,
      resumeCursor: { generation: 1n, sequence: 0n },
      providers: [
        { backendId: "backend-managed", providerId: configuredProvider.providerId, displayName: configuredProvider.displayName, ownerManaged: true },
        { backendId: "backend-native", providerId: configuredProvider.providerId, displayName: "Native Provider", ownerManaged: false }
      ],
      models: [
        { backendId: "backend-managed", key: { providerId: configuredProvider.providerId, modelId: "managed-model" }, displayName: "Managed Model", available: true },
        { backendId: "backend-native", key: { providerId: configuredProvider.providerId, modelId: "native-model" }, displayName: "Native Model", available: true }
      ],
      settings: { agentResource: {}, collaboration: {}, gitSafety: {}, providers: [configuredProvider] }
    });
    const event = create(EventSchema, {
      eventId: "settings-shared-provider-disabled",
      cursor: { generation: 1n, sequence: 1n },
      payload: { kind: { case: "settingsChanged", value: { settings: {
        agentResource: {},
        collaboration: {},
        gitSafety: {},
        providers: [{ ...configuredProvider, enabled: false }]
      } } } }
    });

    const snapshot = projectSnapshotEvent(raw, mapSnapshot(raw), event).snapshot;

    expect(snapshot.providers.map((provider) => [provider.backendId, provider.routingEnabled])).toEqual([
      ["backend-managed", false],
      ["backend-native", true]
    ]);
    expect(snapshot.models.map((model) => [model.backendId, model.routingEnabled])).toEqual([
      ["backend-managed", false],
      ["backend-native", true]
    ]);
  });

  it("resolves a Session model with its Backend, Provider, and model identity", () => {
    const snapshot = mapSnapshot(create(SnapshotSchema, {
      providers: [
        { backendId: "backend-a", providerId: "shared", displayName: "Provider A" },
        { backendId: "backend-b", providerId: "shared", displayName: "Provider B" }
      ],
      models: [
        { backendId: "backend-a", key: { providerId: "shared", modelId: "same" }, displayName: "Model A", available: true },
        { backendId: "backend-b", key: { providerId: "shared", modelId: "same" }, displayName: "Model B", available: true }
      ],
      sessions: [{
        sessionId: "session-b",
        backendId: "backend-b",
        model: { model: { providerId: "shared", modelId: "same" } }
      }]
    }));

    expect(snapshot.sessions[0]?.model).toMatchObject({
      backendId: "backend-b",
      providerName: "Provider B",
      name: "Model B"
    });
  });

  it("retains a disconnected Session model identity after its catalog route disappears", () => {
    const snapshot = mapSnapshot(create(SnapshotSchema, {
      providers: [{
        backendId: "backend-a",
        providerId: "provider-a",
        displayName: "Provider A",
        authenticationState: AuthenticationState.SIGNED_OUT
      }],
      sessions: [{
        sessionId: "session-a",
        backendId: "backend-a",
        model: { model: { providerId: "provider-a", modelId: "model-a" } }
      }]
    }));

    expect(snapshot.sessions[0]?.model).toMatchObject({
      backendId: "backend-a",
      providerId: "provider-a",
      providerName: "Provider A",
      modelId: "model-a",
      name: "model-a",
      available: false,
      routingEnabled: false
    });
  });
});
