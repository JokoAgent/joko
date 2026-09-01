import { describe, expect, it } from "vitest";

import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { AuthenticationState, BackgroundTaskState, CompactionState, ContextRebuildReason, EventSchema, InlineTextRangeSchema, InputContentSchema, InstallationState, InteractionState, MessageInputDelivery, ModelPriceSource, QueueSourceKind, ReviewFreshnessState, RetryState, RunState, ScheduleExecutionMode, ScheduleFireSource, ScheduleRunPhase, ScheduleSessionMode, ToolCallOutputMode } from "@joko/contracts";
import type { EventPayload, PiEventMetadata, ProviderModel, SubagentRunDetail, SubagentTranscriptEntry } from "@joko/core";
import { OperationConflictError, type InteractionRecord, type PersistedEvent, type QueueItemRecord, type ScheduleRecord, type ScheduleRunRecord, type StoredAttempt, type StoredBackend, type StoredRun, type StoredSession } from "@joko/store";

import {
  ProtoMappingError,
  decodeCursorToken,
  fromProtoAttempt,
  fromProtoEvent,
  fromProtoInputContent,
  fromProtoInteraction,
  fromProtoInteractionDecision,
  fromProtoSchedule,
  fromProtoSession,
  fromProtoSubagentRunDetail,
  fromProtoSubagentTranscriptEntry,
  fromProtoTimestamp,
  mapErrorToPublic,
  toProtoEvent,
  toProtoBackend,
  toProtoAttempt,
  toProtoEventCursor,
  toProtoInputContent,
  toProtoInteraction,
  toProtoModelDescriptor,
  toProtoQueueItem,
  toProtoSchedule,
  toProtoSchedulerRuntime,
  toProtoSession,
  toProtoSubagentRunDetail,
  toProtoSubagentTranscriptEntry,
  toProtoTimestamp
} from "./proto-mapper.js";

describe("proto mapper", () => {
  it("projects public Backend identity without exposing private Adapter kind", () => {
    const stored: StoredBackend = {
      descriptor: {
        id: "backend-primary",
        adapterKind: "thread-runtime",
        instanceGeneration: 9,
        displayName: "Primary",
        version: "1.2.3",
        health: "degraded",
        installationState: "update_available",
        authenticationState: "expired",
        error: {
          code: "AUTH_EXPIRED",
          message: "Authentication expired.",
          phase: "authentication",
          retryable: true,
          stateMayHaveChanged: false,
          recovery: "Authenticate again."
        },
        capabilities: new Map(),
        models: [],
        tools: [],
        diagnostics: []
      },
      createdAt: 1,
      updatedAt: 2,
      revision: 3n
    };

    const proto = toProtoBackend(stored);
    expect(proto).not.toHaveProperty("adapterKind");
    expect(proto.entityVersion?.generation).toBe(9n);
    expect(proto).toMatchObject({
      backendId: "backend-primary",
      installationState: InstallationState.UPDATE_AVAILABLE,
      authenticationState: AuthenticationState.EXPIRED,
      error: { code: "AUTH_EXPIRED" }
    });
  });

  it("keeps product and Backend instance generations independent on Attempt and Queue projections", () => {
    const run: StoredRun = {
      descriptor: {
        id: "run-generation",
        sessionId: "session-generation",
        source: "user",
        state: "running",
        activeAttemptId: "attempt-generation",
        createdAt: 1,
        startedAt: 2
      },
      revision: 4n
    };
    const attempt: StoredAttempt = {
      descriptor: {
        id: "attempt-generation",
        runId: "run-generation",
        ordinal: 1,
        generation: 7,
        backendInstanceGeneration: 13,
        startedAt: 2
      },
      revision: 5n
    };
    const protoAttempt = toProtoAttempt(attempt, run);
    expect(protoAttempt.generation).toBe(7n);
    expect(protoAttempt.backendInstanceGeneration).toBe(13n);
    expect(fromProtoAttempt(protoAttempt)).toMatchObject({
      generation: 7,
      backendInstanceGeneration: 13
    });
    expect(() => fromProtoAttempt({
      ...protoAttempt,
      backendInstanceGeneration: BigInt(Number.MAX_SAFE_INTEGER) + 1n
    })).toThrow(ProtoMappingError);

    const queue: QueueItemRecord = {
      id: "queue-generation",
      sessionId: "session-generation",
      runId: "run-generation",
      attemptId: "attempt-generation",
      operationId: "operation-generation",
      disposition: "prompt",
      state: "dispatching",
      backendInstanceGeneration: 13,
      bodyHash: "a".repeat(64),
      body: { text: "hello", images: [], files: [], mentions: [], disposition: "prompt" },
      position: 0,
      createdAt: 1,
      updatedAt: 2,
      dispatchedAt: 2,
      editLocked: true,
      revision: 6n
    };
    const protoQueue = toProtoQueueItem(queue, {
      backendId: "backend-generation",
      targetId: "target-generation",
      source: "user",
      generation: 7
    });
    expect(protoQueue.version?.generation).toBe(7n);
    expect(protoQueue.backendInstanceGeneration).toBe(13n);
    expect(protoQueue.editLocked).toBe(true);
    expect(toProtoQueueItem(queue, {
      backendId: "backend-generation",
      targetId: "target-generation",
      source: "user",
      parentRunId: "run-parent",
      generation: 7
    }).sourceKind).toBe(QueueSourceKind.RETRY);

    const unboundAttempt = toProtoAttempt({
      ...attempt,
      descriptor: { ...attempt.descriptor, backendInstanceGeneration: undefined }
    }, run);
    expect(unboundAttempt.backendInstanceGeneration).toBeUndefined();
  });

  it("preserves an explicit default-hidden catalog model", () => {
    const model = {
      providerId: "provider",
      modelId: "discovered-model",
      displayName: "Discovered model",
      api: "openai-chat",
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
      supportsImages: false,
      defaultVisible: false,
      thinkingLevels: [],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    } satisfies ProviderModel;

    expect(toProtoModelDescriptor("backend-models", model)).toMatchObject({
      backendId: "backend-models",
      defaultVisible: false,
      priceSource: ModelPriceSource.UNSPECIFIED
    });
    expect(toProtoModelDescriptor("backend-models", { ...model, defaultVisible: undefined }).defaultVisible).toBeUndefined();
    expect(toProtoModelDescriptor("backend-models", {
      ...model,
      cost: { ...model.cost, output: 3 }
    }).priceSource).toBe(ModelPriceSource.UPSTREAM);
    expect(toProtoModelDescriptor("backend-models", {
      ...model,
      pricing: { source: "providerReference", currencyCode: "USD" }
    }).priceSource).toBe(ModelPriceSource.PROVIDER_REFERENCE);
  });

  it("round-trips signed millisecond timestamps and validates opaque cursors", () => {
    for (const value of [-1_001, -1, 0, 1, 1_001, 9_007_199_254_740_000]) {
      expect(fromProtoTimestamp(toProtoTimestamp(value))).toBe(value);
    }

    const cursor = toProtoEventCursor(42n, 7, 1_000);
    expect(decodeCursorToken(cursor.opaqueToken)).toEqual({ sequence: 42n, generation: 7n });
    expect(() => decodeCursorToken("not-a-cursor")).toThrow(ProtoMappingError);
    expect(() => decodeCursorToken(`${cursor.opaqueToken}=`)).toThrow(ProtoMappingError);
  });

  it("keeps Pi's native identity behind the opaque product binding", () => {
    const stored: StoredSession = {
      revision: 11n,
      descriptor: {
        id: "session-1",
        backendId: "pi",
        targetId: "target-1",
        projectId: "project-navigation",
        automationOrigin: {
          kind: "scheduler",
          scheduleId: "schedule-1",
          scheduleName: "Nightly",
          runId: "run-1"
        },
        derivationOrigin: {
          kind: "fork",
          sourceSessionId: "source-session",
          sourceMessageId: "source-message",
          sourceEventId: "source-event"
        },
        title: "Opaque",
        binding: {
          opaqueRef: "opaque:pi:01JZZZ",
          nativeSessionId: "must-never-cross-the-contract",
          generation: 7
        },
        pinned: false,
        archived: false,
        permissionMode: "ask",
        planMode: false,
        fastMode: false,
        createdAt: 10,
        updatedAt: 20
      }
    };

    const proto = toProtoSession(stored, {
      runtimeAttached: true,
      derivationOriginAvailability: { sourceSessionAvailable: true, sourceMessageAvailable: true },
      contextState: { compacting: false, autoCompaction: true, autoRetry: false }
    });
    expect(proto.nativeBinding).toMatchObject({
      opaqueReference: "opaque:pi:01JZZZ",
      runtimeGeneration: 7n,
      runtimeAttached: true
    });
    expect(proto.nativeBinding).not.toHaveProperty("nativeSessionId");
    expect(proto).toMatchObject({
      targetId: "target-1",
      projectId: "project-navigation",
      automationOrigin: {
        scheduleId: "schedule-1",
        scheduleName: "Nightly",
        runId: "run-1"
      },
      derivationOrigin: {
        sourceSessionId: "source-session",
        sourceMessageId: "source-message",
        sourceEventId: "source-event",
        sourceSessionAvailable: true,
        sourceMessageAvailable: true
      },
      contextState: { compacting: false, autoCompaction: true, autoRetry: false }
    });
    expect(fromProtoSession(proto).binding).toEqual({
      opaqueRef: "opaque:pi:01JZZZ",
      generation: 7
    });
    expect(fromProtoSession(proto)).toMatchObject({
      targetId: "target-1",
      projectId: "project-navigation",
      automationOrigin: {
        kind: "scheduler",
        scheduleId: "schedule-1",
        scheduleName: "Nightly",
        runId: "run-1"
      },
      derivationOrigin: {
        kind: "fork",
        sourceSessionId: "source-session",
        sourceMessageId: "source-message",
        sourceEventId: "source-event"
      }
    });
    expect(proto.context).toBeUndefined();

    const cumulativeWithoutCurrentContext = toProtoSession(stored, {
      usage: {
        inputTokens: 20,
        outputTokens: 5,
        cacheReadTokens: 10,
        cacheWriteTokens: 0,
        totalTokens: 35,
        contextWindow: 200_000,
        cost: 0.01
      },
      usageMeasuredAt: 21
    });
    expect(cumulativeWithoutCurrentContext.context).toBeUndefined();

    const changed = toProtoEvent({
      id: "session-changed-origin",
      sequence: 1n,
      globalCursor: 1n,
      revision: 1n,
      emittedAt: 22,
      backendId: "pi",
      targetId: "target-1",
      sessionId: "session-1",
      generation: 7,
      traceId: "session-changed-origin",
      payload: { type: "session_changed" }
    }, { session: stored });
    expect(changed.payload?.kind.case).toBe("sessionChanged");
    if (changed.payload?.kind.case !== "sessionChanged") throw new Error("Expected Session change Event.");
    expect(changed.payload.kind.value.session?.automationOrigin).toMatchObject({
      scheduleId: "schedule-1",
      scheduleName: "Nightly",
      runId: "run-1"
    });
  });

  it("round-trips exact Session attention cursors and rejects cross-generation read receipts", () => {
    const stored: StoredSession = {
      revision: 12n,
      descriptor: {
        id: "session-attention",
        backendId: "pi",
        targetId: "target-1",
        title: "Attention",
        binding: { opaqueRef: "opaque:attention", generation: 7 },
        pinned: false,
        archived: false,
        permissionMode: "ask",
        planMode: false,
        fastMode: false,
        attention: {
          kind: "done",
          unread: false,
          subjectCursor: 42n,
          subjectGeneration: 7,
          attentionCursor: 42n,
          attentionGeneration: 7,
          readThroughCursor: 42n,
          readThroughGeneration: 7,
          updatedAt: 1_234
        },
        createdAt: 10,
        updatedAt: 20
      }
    };

    const proto = toProtoSession(stored);
    expect(fromProtoSession(proto).attention).toEqual(stored.descriptor.attention);

    if (proto.attention === undefined) throw new Error("Expected Session attention");
    proto.attention.readThroughCursor = toProtoEventCursor(42n, 6, 1_234);
    expect(() => fromProtoSession(proto)).toThrow(/read cursor is inconsistent/u);

    proto.attention.unread = true;
    proto.attention.readThroughCursor = toProtoEventCursor(0n, 1, 1_234);
    expect(() => fromProtoSession(proto)).toThrow(/read cursor is inconsistent/u);

    proto.attention.readThroughCursor = toProtoEventCursor(42n, 7, 1_234);
    expect(() => fromProtoSession(proto)).toThrow(/read cursor is inconsistent/u);

    proto.attention.readThroughCursor = toProtoEventCursor(41n, 8, 1_234);
    expect(() => fromProtoSession(proto)).toThrow(/read cursor is inconsistent/u);

    proto.attention.unread = false;
    proto.attention.attentionCursor = toProtoEventCursor(0n, 0, 1_234);
    proto.attention.readThroughCursor = toProtoEventCursor(0n, 0, 1_234);
    expect(() => fromProtoSession(proto)).toThrow(/must reference a durable Event/u);

    const subjectProto = toProtoSession(stored);
    if (subjectProto.attention === undefined) throw new Error("Expected Session attention");
    subjectProto.attention.subjectCursor = toProtoEventCursor(43n, 7, 1_234);
    expect(() => fromProtoSession(subjectProto)).toThrow(/subject cursor is inconsistent/u);
    subjectProto.attention.subjectCursor = toProtoEventCursor(42n, 6, 1_234);
    expect(() => fromProtoSession(subjectProto)).toThrow(/subject cursor is inconsistent/u);
    subjectProto.attention.subjectCursor = toProtoEventCursor(41n, 8, 1_234);
    expect(() => fromProtoSession(subjectProto)).toThrow(/subject cursor is inconsistent/u);
  });

  it("uses the attention Event timestamp as its replayed read-model timestamp", () => {
    const payload: EventPayload = {
      type: "session_attention",
      kind: "awaiting",
      unread: true,
      subjectCursor: "41",
      subjectGeneration: 3,
      attentionCursor: "41",
      attentionGeneration: 3,
      readThroughCursor: "0",
      readThroughGeneration: 0
    };
    const event: PersistedEvent = {
      id: "event-session-attention",
      sequence: 42n,
      globalCursor: 42n,
      revision: 42n,
      emittedAt: 12_345,
      backendId: "pi",
      targetId: "target-1",
      sessionId: "session-1",
      generation: 3,
      traceId: "trace-session-attention",
      payload
    };

    const proto = toProtoEvent(event);
    expect(proto.payload?.kind.case).toBe("sessionAttentionChanged");
    if (proto.payload?.kind.case !== "sessionAttentionChanged") throw new Error("Expected attention Event");
    expect(fromProtoTimestamp(proto.payload.kind.value.attention?.updatedAt)).toBe(event.emittedAt);
    expect(fromProtoEvent(proto)).toEqual({
      id: event.id,
      emittedAt: event.emittedAt,
      backendId: event.backendId,
      targetId: event.targetId,
      sessionId: event.sessionId,
      generation: event.generation,
      traceId: event.traceId,
      payload: event.payload
    });
  });

  it("round-trips present background-task metadata without inventing unknown progress", () => {
    const error = {
      code: "SUBAGENT_FAILED",
      message: "The delegated task failed safely.",
      phase: "background_task",
      retryable: true,
      stateMayHaveChanged: false,
      recovery: "Retry the delegated task."
    } as const;
    const payload: EventPayload = {
      type: "background_task",
      taskId: "child-1",
      parentTaskId: "batch-1",
      title: "scout subagent",
      state: "failed",
      detail: "Child process exited.",
      progressRatio: 0.625,
      startedAt: 10_000,
      endedAt: 12_000,
      error
    };
    const event: PersistedEvent = {
      id: "event-background-task",
      sequence: 43n,
      globalCursor: 43n,
      revision: 43n,
      emittedAt: 12_000,
      backendId: "pi",
      targetId: "target-1",
      sessionId: "session-1",
      runId: "run-1",
      generation: 3,
      traceId: "trace-background-task",
      payload
    };

    const proto = toProtoEvent(event);
    if (proto.payload?.kind.case !== "backgroundTaskChanged") throw new Error("Expected BackgroundTaskChangedEvent");
    expect(proto.payload.kind.value.backgroundTask).toMatchObject({
      backgroundTaskId: "child-1",
      parentTaskId: "batch-1",
      state: BackgroundTaskState.FAILED,
      progressRatio: 0.625,
      error: { code: "SUBAGENT_FAILED" }
    });
    expect(fromProtoTimestamp(proto.payload.kind.value.backgroundTask?.startedAt)).toBe(10_000);
    expect(fromProtoTimestamp(proto.payload.kind.value.backgroundTask?.endedAt)).toBe(12_000);
    expect(fromProtoTimestamp(proto.payload.kind.value.backgroundTask?.createdAt)).toBe(event.emittedAt);
    expect(fromProtoTimestamp(proto.payload.kind.value.backgroundTask?.updatedAt)).toBe(event.emittedAt);
    expect(fromProtoEvent(proto).payload).toEqual(payload);

    const withoutProgress = toProtoEvent({
      ...event,
      id: "event-background-task-unknown-progress",
      payload: { type: "background_task", taskId: "child-2", title: "planner subagent", state: "queued" }
    });
    if (withoutProgress.payload?.kind.case !== "backgroundTaskChanged") throw new Error("Expected BackgroundTaskChangedEvent");
    expect(withoutProgress.payload.kind.value.backgroundTask?.progressRatio).toBeUndefined();
    expect(fromProtoEvent(withoutProgress).payload).toEqual({
      type: "background_task",
      taskId: "child-2",
      title: "planner subagent",
      state: "queued"
    });
  });

  it("round-trips complete delegated-run detail and transcript lifecycle metadata", () => {
    const publicError = {
      code: "DELEGATED_FAILED",
      message: "The bounded assignment failed.",
      phase: "delegated_run",
      retryable: true,
      stateMayHaveChanged: false,
      recovery: "Resume with corrected instructions."
    } as const;
    const run = {
      id: "delegated-1",
      sessionId: "session-1",
      parentRunId: "run-1",
      parentSubagentRunId: "delegated-parent",
      parentTaskId: "task-parent",
      parentToolCallId: "tool-parent",
      logicalAgentId: "logical-1",
      identityAliases: ["alias-1"],
      providerRunIds: ["provider-run-1"],
      state: "failed",
      title: "Verifier",
      description: "Checks a bounded surface",
      assignment: "Inspect every contract field",
      summary: "Found an error",
      route: { providerId: "provider", modelId: "model", thinkingLevel: "high" },
      readOnly: false,
      usage: {
        inputTokens: 11,
        outputTokens: 7,
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
        totalTokens: 23,
        toolUses: 4,
        durationMs: 1_234,
        costUsd: 0.0123
      },
      capabilities: {
        viewActivity: true,
        viewReturnedResult: true,
        viewFullTranscript: true,
        stop: false,
        steer: false,
        followUp: false,
        resume: true,
        parentContext: "live"
      },
      startedAt: 1_000,
      updatedAt: 2_000,
      endedAt: 2_000,
      error: publicError,
      activity: [{
        sequence: 1,
        kind: "started",
        state: "running",
        summary: "Started",
        lastToolName: "read",
        occurredAt: 1_000
      }, {
        sequence: 2,
        kind: "failed",
        state: "failed",
        summary: "Failed",
        occurredAt: 2_000
      }],
      children: [{
        id: "child-1",
        parentChildId: "child-root",
        identityAliases: ["native-child-1"],
        role: "verifier",
        title: "Verifier child",
        assignment: "Inspect",
        state: "failed",
        readOnly: true,
        route: { providerId: "provider", modelId: "child-model", thinkingLevel: "medium" },
        usage: { totalTokens: 23, toolUses: 4, durationMs: 1_234, costUsd: 0.0123 },
        awaitingApproval: false,
        result: "partial result",
        resultTruncated: true,
        error: publicError,
        startedAt: 1_000,
        endedAt: 2_000
      }, {
        id: "child-root",
        identityAliases: [],
        role: "root",
        state: "completed",
        readOnly: false,
        awaitingApproval: true,
        resultTruncated: false
      }],
      returnedResult: "returned result",
      returnedResultTruncated: true
    } satisfies SubagentRunDetail;
    expect(fromProtoSubagentRunDetail(toProtoSubagentRunDetail(run, {
      revision: 9n,
      generation: 3,
      updatedAt: 2_000
    }))).toEqual(run);

    const transcript = {
      id: "entry-1",
      sequence: 8,
      role: "tool",
      content: "tool failed",
      occurredAt: 1_500,
      childId: "child-1",
      childTitle: "Verifier child",
      toolName: "read",
      toolCallId: "call-1",
      toolPhase: "end",
      toolInputJson: "{\"path\":\"safe.txt\"}",
      isError: true,
      controlAction: "follow_up",
      systemEvent: { kind: "tool_terminal", params: { outcome: "failed" } }
    } satisfies SubagentTranscriptEntry;
    expect(fromProtoSubagentTranscriptEntry(toProtoSubagentTranscriptEntry(transcript)))
      .toEqual(transcript);
    const eventBase = {
      sequence: 1n,
      globalCursor: 1n,
      revision: 1n,
      emittedAt: 2_000,
      backendId: "pi",
      targetId: "target-1",
      sessionId: "session-1",
      generation: 3,
      traceId: "delegated:event"
    } as const;
    const runEvent = {
      ...eventBase,
      id: "event-delegated-run",
      payload: { type: "subagent_run", run }
    } satisfies PersistedEvent;
    const transcriptEvent = {
      ...eventBase,
      id: "event-delegated-transcript",
      sequence: 2n,
      globalCursor: 2n,
      revision: 2n,
      payload: { type: "subagent_transcript", subagentRunId: run.id, entry: transcript }
    } satisfies PersistedEvent;
    expect(fromProtoEvent(toProtoEvent(runEvent)).payload).toEqual(runEvent.payload);
    expect(fromProtoEvent(toProtoEvent(transcriptEvent)).payload).toEqual(transcriptEvent.payload);
  });

  it("preserves unknown delegated child/result/error facts instead of materializing false values", () => {
    const run = {
      id: "delegated-sparse",
      sessionId: "session-1",
      logicalAgentId: "logical-sparse",
      identityAliases: [],
      providerRunIds: [],
      state: "running",
      capabilities: {
        viewActivity: false,
        viewReturnedResult: false,
        viewFullTranscript: false,
        stop: false,
        steer: false,
        followUp: false,
        resume: false,
        parentContext: "unknown"
      },
      startedAt: 1,
      updatedAt: 1,
      activity: []
    } satisfies SubagentRunDetail;
    const roundTrip = fromProtoSubagentRunDetail(toProtoSubagentRunDetail(run));
    expect(roundTrip).toEqual(run);
    expect(roundTrip).not.toHaveProperty("children");
    expect(roundTrip).not.toHaveProperty("returnedResultTruncated");

    const transcript = {
      id: "entry-sparse",
      sequence: 1,
      role: "system",
      content: "state changed",
      occurredAt: 2,
      systemEvent: { kind: "state_changed" }
    } satisfies SubagentTranscriptEntry;
    const transcriptRoundTrip = fromProtoSubagentTranscriptEntry(
      toProtoSubagentTranscriptEntry(transcript)
    );
    expect(transcriptRoundTrip).toEqual(transcript);
    expect(transcriptRoundTrip).not.toHaveProperty("isError");
    expect(transcriptRoundTrip.systemEvent).not.toHaveProperty("params");
  });

  it("round-trips text, images, files, and opaque mentions", () => {
    const input = {
      text: "Explain this",
      images: [{
        blob: {
          id: "image-1",
          sha256: `sha256:${"a".repeat(64)}`,
          byteLength: 12,
          mimeType: "image/png",
          fileName: "image.png"
        },
        alt: "diagram"
      }],
      files: [{
        blob: {
          id: "file-1",
          sha256: `sha256:${"b".repeat(64)}`,
          byteLength: 8,
          mimeType: "text/plain",
          fileName: "notes.txt"
        }
      }],
      mentions: [
        { kind: "workspace_file" as const, label: "README", reference: "README.md" },
        { kind: "resource" as const, label: "Docs", reference: "resource-1" }
      ],
      disposition: "steer" as const,
      quotesEncoded: true,
      pastedTextRanges: [{ start: 0, end: 7, display: "Pasted text (1 line)" }]
    };

    expect(fromProtoInputContent(toProtoInputContent(input), "steer")).toEqual(input);
  });

  it("rejects malformed pasted-text UTF-16 ranges instead of repairing them", () => {
    const base = {
      text: "A😀pasteZ",
      images: [],
      files: [],
      mentions: [],
      disposition: "prompt" as const
    };
    expect(fromProtoInputContent(toProtoInputContent({
      ...base,
      pastedTextRanges: [{ start: 3, end: 8, display: "Pasted text (1 line)" }]
    }))).toMatchObject({ pastedTextRanges: [{ start: 3, end: 8, display: "Pasted text (1 line)" }] });
    expect(() => toProtoInputContent({
      ...base,
      pastedTextRanges: [{ start: 1, end: 2, display: "split surrogate" }]
    })).toThrow(ProtoMappingError);
    expect(() => toProtoInputContent({
      ...base,
      pastedTextRanges: [
        { start: 3, end: 8, display: "later" },
        { start: 0, end: 1, display: "out of order" }
      ]
    })).toThrow(ProtoMappingError);
    expect(() => fromProtoInputContent(create(InputContentSchema, {
      parts: [{ content: { case: "text", value: "short" } }],
      pastedTextRanges: [create(InlineTextRangeSchema, { start: 0, end: 8, display: "outside" })]
    }))).toThrow(ProtoMappingError);
  });

  it("round-trips the durable quote gate on accepted user message events", () => {
    const payload: EventPayload = {
      type: "message_complete",
      role: "user",
      blocks: [{ kind: "text", text: "> <!-- joko-selection-quote -->\n> selected\n\nreply" }],
      quotesEncoded: true,
      pastedTextRanges: [{ start: 44, end: 49, display: "Pasted text (1 line)" }],
      automationOrigin: { kind: "scheduler", scheduleId: "schedule-1", scheduleName: "Nightly", runId: "run-1" },
      inputDelivery: "scheduler",
      nativeHistory: { identity: { entryId: "entry-user", parentEntryId: "entry-parent" } }
    };
    const event: PersistedEvent = {
      id: "event-user-quote",
      sequence: 1n,
      globalCursor: 1n,
      revision: 1n,
      emittedAt: 1_000,
      backendId: "pi",
      targetId: "target-1",
      sessionId: "session-1",
      runId: "run-1",
      generation: 1,
      traceId: "trace-user-quote",
      payload
    };

    const proto = toProtoEvent(event);
    expect(proto.payload?.kind).toMatchObject({
      case: "messageStarted",
      value: {
        quotesEncoded: true,
        userInput: { quotesEncoded: true },
        inputDelivery: MessageInputDelivery.SCHEDULER,
        automationOrigin: { scheduleId: "schedule-1", scheduleName: "Nightly", runId: "run-1" },
        nativeIdentity: { entryId: "entry-user", parentEntryId: "entry-parent" }
      }
    });
    expect(fromProtoEvent(proto).payload).toEqual(payload);
  });

  it("round-trips service-owned continuation identity and its recovery lifecycle", () => {
    const message: PersistedEvent = {
      id: "event-runtime-continuation",
      sequence: 1n,
      globalCursor: 1n,
      revision: 1n,
      emittedAt: 1_000,
      backendId: "pi",
      targetId: "target-1",
      sessionId: "session-1",
      runId: "run-continuation",
      generation: 1,
      traceId: "trace-runtime-continuation",
      payload: {
        type: "message_complete",
        role: "user",
        blocks: [{ kind: "text", text: "Continue" }],
        automaticContinuation: { recoveryId: "recovery-1" }
      }
    };
    const messageProto = toProtoEvent(message);
    expect(messageProto.payload?.kind).toMatchObject({
      case: "messageStarted",
      value: { automaticContinuation: true, runtimeRecoveryId: "recovery-1" }
    });
    expect(fromProtoEvent(messageProto).payload).toEqual(message.payload);

    const lifecycle: PersistedEvent = {
      ...message,
      id: "event-runtime-recovery",
      sequence: 2n,
      globalCursor: 2n,
      traceId: "trace-runtime-recovery",
      payload: {
        type: "runtime_recovery",
        recoveryId: "recovery-1",
        sourceRunId: "run-source",
        continuationRunId: "run-continuation",
        state: "running",
        attempt: 2,
        maximumAttempts: 5,
        sessionTotal: 4,
        delayMs: 6_000,
        routeChanged: true,
        error: {
          code: "UPSTREAM_OVERLOAD",
          message: "Stream disconnected.",
          phase: "stream",
          retryable: true,
          stateMayHaveChanged: true,
          recovery: "Wait for the bounded continuation."
        }
      }
    };
    expect(toProtoEvent(lifecycle).payload?.kind.case).toBe("runtimeRecoveryChanged");
    expect(fromProtoEvent(toProtoEvent(lifecycle)).payload).toEqual(lifecycle.payload);
  });

  it("round-trips authoritative per-message usage on assistant completion", () => {
    const payload: EventPayload = {
      type: "message_complete",
      role: "assistant",
      blocks: [
        { kind: "thinking", text: "Inspect the inputs", redacted: false },
        { kind: "text", text: "Final answer" },
        {
          kind: "image",
          blob: {
            id: "assistant-image",
            sha256: `sha256:${"a".repeat(64)}`,
            byteLength: 42,
            mimeType: "image/png",
            fileName: "answer.png"
          },
          alt: "Rendered answer"
        },
        {
          kind: "artifact",
          blob: {
            id: "assistant-file",
            sha256: `sha256:${"b".repeat(64)}`,
            byteLength: 64,
            mimeType: "text/plain",
            fileName: "answer.txt"
          },
          label: "Answer file"
        },
        { kind: "tool_call", callId: "call-1", name: "lookup", input: "query" },
        { kind: "tool_result", callId: "call-1", output: "result", isError: false }
      ],
      usage: {
        inputTokens: 11,
        outputTokens: 7,
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
        totalTokens: 23,
        cost: 0.012345
      },
      generationDurationMs: 1_200,
      generationReliable: true,
      nativeHistory: { identity: { entryId: "entry-assistant", parentEntryId: "entry-user" } }
    };
    const event: PersistedEvent = {
      id: "event-assistant-usage",
      sequence: 1n,
      globalCursor: 1n,
      revision: 1n,
      emittedAt: 1_000,
      backendId: "backend",
      targetId: "target-1",
      sessionId: "session-1",
      runId: "run-1",
      generation: 1,
      traceId: "trace-assistant-usage",
      payload
    };

    const proto = toProtoEvent(event);
    expect(proto.payload?.kind).toMatchObject({
      case: "messageCompleted",
      value: {
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
        generationReliable: true,
        nativeIdentity: { entryId: "entry-assistant", parentEntryId: "entry-user" },
        blocks: [
          { content: { case: "thinking", value: { text: "Inspect the inputs", redacted: false } } },
          { content: { case: "text", value: "Final answer" } },
          { content: { case: "image", value: { altText: "Rendered answer", blob: { blobId: "assistant-image" } } } },
          { content: { case: "artifact", value: { label: "Answer file", blob: { blobId: "assistant-file" } } } },
          { content: { case: "toolCall", value: { callId: "call-1", name: "lookup", input: "query" } } },
          { content: { case: "toolResult", value: { callId: "call-1", output: "result", isError: false } } }
        ]
      }
    });
    expect(fromProtoEvent(proto).payload).toEqual(payload);

    const missingDuration = toProtoEvent(event);
    if (missingDuration.payload?.kind.case !== "messageCompleted") throw new Error("Expected assistant completion.");
    missingDuration.payload.kind.value.generationDurationMs = undefined;
    expect(() => fromProtoEvent(missingDuration)).toThrow(ProtoMappingError);

    expect(() => toProtoEvent({
      ...event,
      payload: { ...payload, generationDurationMs: undefined, generationReliable: true }
    })).toThrow(ProtoMappingError);
    expect(() => toProtoEvent({
      ...event,
      payload: {
        type: "message_complete",
        role: "user",
        blocks: [],
        generationDurationMs: 1_200,
        generationReliable: true
      }
    })).toThrow(ProtoMappingError);
  });

  it("round-trips a Backend-neutral extension UI effect without requiring namespaced metadata", () => {
    const event: PersistedEvent = {
      id: "extension-notification",
      sequence: 1n,
      globalCursor: 1n,
      revision: 1n,
      emittedAt: 1_000,
      backendId: "backend",
      targetId: "target-1",
      sessionId: "session-1",
      generation: 1,
      traceId: "extension-notification",
      payload: {
        type: "extension_ui_effect",
        effect: "notification",
        text: "Done",
        notificationKind: "warning"
      }
    };

    expect(toProtoEvent(event).payload?.kind).toMatchObject({
      case: "extensionUiEffect",
      value: { text: "Done" }
    });
    expect(fromProtoEvent(toProtoEvent(event)).payload).toEqual(event.payload);
  });

  it("round-trips typed tool-result images without embedding binary data in text output", () => {
    const image = {
      id: "tool-image",
      sha256: `sha256:${"a".repeat(64)}`,
      byteLength: 12,
      mimeType: "image/png",
      fileName: "preview.png"
    };
    const payload: EventPayload = {
      type: "tool_result",
      callId: "read-image",
      name: "read",
      output: "Image Size: 16x16.",
      parts: [
        { kind: "text", text: "Image Size: 16x16." },
        { kind: "image", blob: image, alt: "tool preview" }
      ],
      isError: false
    };
    const event: PersistedEvent = {
      id: "event-tool-image",
      sequence: 1n,
      globalCursor: 1n,
      revision: 1n,
      emittedAt: 1_000,
      backendId: "pi",
      targetId: "target-1",
      sessionId: "session-1",
      runId: "run-1",
      generation: 1,
      traceId: "trace-tool-image",
      payload
    };

    const proto = toProtoEvent(event);
    expect(proto.payload?.kind).toMatchObject({
      case: "toolCallCompleted",
      value: {
        toolCall: {
          result: {
            parts: [
              { content: { case: "text", value: "Image Size: 16x16." } },
              { content: { case: "image", value: { blob: { blobId: "tool-image" }, altText: "tool preview" } } }
            ]
          }
        }
      }
    });
    expect(fromProtoEvent(proto).payload).toEqual(payload);
    expect(JSON.stringify(proto, (_key, value) => typeof value === "bigint" ? value.toString() : value)).not.toContain("base64");
  });

  it("round-trips append and replace semantics for live tool output", () => {
    const cases = [
      ["append", ToolCallOutputMode.APPEND],
      ["replace", ToolCallOutputMode.REPLACE],
      [undefined, ToolCallOutputMode.UNSPECIFIED]
    ] as const;

    for (const [outputMode, protoMode] of cases) {
      const payload: EventPayload = {
        type: "tool_update",
        callId: "streaming-tool",
        name: "shell",
        output: "chunk",
        parts: [{ kind: "text", text: "chunk" }],
        ...(outputMode === undefined ? {} : { outputMode })
      };
      const event: PersistedEvent = {
        id: `event-tool-update-${outputMode ?? "default"}`,
        sequence: 1n,
        globalCursor: 1n,
        revision: 1n,
        emittedAt: 1_000,
        backendId: "backend-1",
        targetId: "target-1",
        sessionId: "session-1",
        runId: "run-1",
        generation: 1,
        traceId: "trace-tool-update",
        payload
      };

      const proto = toProtoEvent(event);
      expect(proto.payload?.kind).toMatchObject({
        case: "toolCallUpdated",
        value: { outputMode: protoMode }
      });
      expect(fromProtoEvent(proto).payload).toEqual(payload);
    }
  });

  it("round-trips Session-scoped runtime command change events", () => {
    const payload: EventPayload = {
      type: "runtime_commands_changed",
      commands: [
        { name: "review", description: "Review changes", source: "extension", loaded: true },
        { name: "release", description: "Release notes", source: "prompt", loaded: false }
      ]
    };
    const event: PersistedEvent = {
      id: "event-runtime-commands",
      sequence: 2n,
      globalCursor: 2n,
      revision: 2n,
      emittedAt: 2_000,
      backendId: "pi",
      targetId: "target-1",
      sessionId: "session-1",
      generation: 3,
      traceId: "trace-runtime-commands",
      payload
    };

    const proto = toProtoEvent(event);
    expect(proto.payload?.kind).toMatchObject({
      case: "runtimeCommandsChanged",
      value: {
        commands: [
          expect.objectContaining({ sessionId: "session-1", name: "review", loaded: true }),
          expect.objectContaining({ sessionId: "session-1", name: "release", loaded: false })
        ]
      }
    });
    expect(fromProtoEvent(proto).payload).toEqual(payload);

    if (proto.payload?.kind.case === "runtimeCommandsChanged") {
      proto.payload.kind.value.commands[0]!.sessionId = "other-session";
    }
    expect(() => fromProtoEvent(proto)).toThrow(/does not match the event identity/u);
  });

  it("round-trips typed message deletion events and fences their Session identity", () => {
    const payload: EventPayload = {
      type: "message_deleted",
      requestedEventId: "event-assistant-selected",
      deletedEventIds: ["event-assistant-selected", "event-tool-output"]
    };
    const event: PersistedEvent = {
      id: "event-message-deleted",
      sequence: 3n,
      globalCursor: 3n,
      revision: 3n,
      emittedAt: 3_000,
      backendId: "pi",
      targetId: "target-1",
      sessionId: "session-1",
      operationId: "delete-operation",
      generation: 4,
      traceId: "trace-message-deleted",
      payload
    };
    const proto = toProtoEvent(event);
    expect(proto.payload?.kind).toMatchObject({
      case: "messageDeleted",
      value: {
        productSessionId: "session-1",
        requestedEventId: "event-assistant-selected",
        deletedEventIds: ["event-assistant-selected", "event-tool-output"]
      }
    });
    expect(fromProtoEvent(proto).payload).toEqual(payload);
    if (proto.payload?.kind.case === "messageDeleted") {
      proto.payload.kind.value.productSessionId = "other-session";
    }
    expect(() => fromProtoEvent(proto)).toThrow(/does not match the event identity/u);
  });

  it("round-trips a redacted native context boundary and rejects an unscoped reason", () => {
    const payload: EventPayload = {
      type: "context_rebuild",
      reason: "context_overflow",
      handoff: "[JOKO SAFE CONTEXT HANDOFF]\nSurviving conversation.",
      sourceRunId: "source-run",
      replayScheduled: true
    };
    const event: PersistedEvent = {
      id: "event-context-rebuilt",
      sequence: 4n,
      globalCursor: 4n,
      revision: 4n,
      emittedAt: 4_000,
      backendId: "pi",
      targetId: "target-1",
      sessionId: "session-1",
      runId: "source-run",
      operationId: "context-rebuild-operation",
      generation: 5,
      traceId: "trace-context-rebuilt",
      payload
    };
    const proto = toProtoEvent(event);
    expect(proto.payload?.kind).toMatchObject({
      case: "contextRebuilt",
      value: {
        productSessionId: "session-1",
        reason: ContextRebuildReason.CONTEXT_OVERFLOW,
        handoff: payload.handoff,
        sourceRunId: "source-run",
        replayScheduled: true
      }
    });
    expect(fromProtoEvent(proto).payload).toEqual(payload);
    if (proto.payload?.kind.case !== "contextRebuilt") throw new Error("Expected ContextRebuiltEvent");
    proto.payload.kind.value.productSessionId = "other-session";
    expect(() => fromProtoEvent(proto)).toThrow(/does not match the event identity/u);
    proto.payload.kind.value.productSessionId = "session-1";
    proto.payload.kind.value.reason = ContextRebuildReason.UNSPECIFIED;
    expect(() => fromProtoEvent(proto)).toThrow(/reason is required/u);
  });

  it("round-trips the typed Session reset boundary and fences its Product Session identity", () => {
    const payload: EventPayload = { type: "session_reset" };
    const event: PersistedEvent = {
      id: "event-session-reset",
      sequence: 4n,
      globalCursor: 4n,
      revision: 4n,
      emittedAt: 4_000,
      backendId: "pi",
      targetId: "target-1",
      sessionId: "session-1",
      operationId: "reset-operation",
      generation: 5,
      traceId: "trace-session-reset",
      payload
    };
    const proto = toProtoEvent(event);
    expect(proto.payload?.kind).toMatchObject({
      case: "sessionReset",
      value: { productSessionId: "session-1" }
    });
    expect(fromProtoEvent(proto).payload).toEqual(payload);
    if (proto.payload?.kind.case === "sessionReset") {
      proto.payload.kind.value.productSessionId = "other-session";
    }
    expect(() => fromProtoEvent(proto)).toThrow(/does not match the event identity/u);
  });

  it("round-trips a task history pruning boundary and preserves the active-context reset flag", () => {
    const payload: EventPayload = { type: "history_pruned", activeContextReset: true };
    const event: PersistedEvent = {
      id: "event-history-pruned",
      sequence: 5n,
      globalCursor: 5n,
      revision: 5n,
      emittedAt: 5_000,
      backendId: "pi",
      targetId: "target-1",
      sessionId: "session-1",
      generation: 6,
      traceId: "trace-history-pruned",
      payload
    };
    const proto = toProtoEvent(event);
    expect(proto.payload?.kind).toMatchObject({
      case: "historyPruned",
      value: { productSessionId: "session-1", activeContextReset: true }
    });
    expect(fromProtoEvent(proto).payload).toEqual(payload);
    if (proto.payload?.kind.case === "historyPruned") {
      proto.payload.kind.value.productSessionId = "other-session";
    }
    expect(() => fromProtoEvent(proto)).toThrow(/does not match the event identity/u);
  });

  it("carries Pi retry budgets and absolute countdown deadlines through RetryChangedEvent", () => {
    const overloadNotice = {
      code: "UPSTREAM_OVERLOAD",
      message: "redacted capacity detail",
      phase: "retry",
      retryable: true,
      stateMayHaveChanged: false,
      recovery: "Wait for the bounded retry policy."
    } as const;
    const payload: EventPayload = {
      type: "retry",
      state: "waiting",
      attempt: 2,
      maxAttempts: 5,
      delayMs: 2_500,
      error: overloadNotice
    };
    const event: PersistedEvent = {
      id: "event-retry-waiting",
      sequence: 3n,
      globalCursor: 3n,
      revision: 3n,
      emittedAt: 10_000,
      backendId: "pi",
      targetId: "target-1",
      sessionId: "session-1",
      runId: "run-1",
      attemptId: "attempt-2",
      generation: 1,
      traceId: "trace-retry-waiting",
      payload
    };

    const proto = toProtoEvent(event);
    expect(proto.payload?.kind).toMatchObject({
      case: "retryChanged",
      value: {
        runId: "run-1",
        attemptId: "attempt-2",
        attemptNumber: 2,
        maxAttempts: 5,
        error: { code: "UPSTREAM_OVERLOAD", retryable: true }
      }
    });
    if (proto.payload?.kind.case !== "retryChanged") throw new Error("Expected RetryChangedEvent");
    expect(proto.payload.kind.value.state).toBe(RetryState.WAITING);
    expect(fromProtoTimestamp(proto.payload.kind.value.retryAt)).toBe(12_500);
    expect(fromProtoEvent(proto).payload).toEqual(payload);

    proto.payload.kind.value.maxAttempts = undefined;
    expect(fromProtoEvent(proto).payload).toEqual({
      type: "retry",
      state: "waiting",
      attempt: 2,
      delayMs: 2_500,
      error: overloadNotice
    });

    const immediate = toProtoEvent({
      ...event,
      id: "event-retry-immediate",
      payload: { type: "retry", state: "waiting", attempt: 1 }
    });
    if (immediate.payload?.kind.case !== "retryChanged") throw new Error("Expected RetryChangedEvent");
    expect(fromProtoTimestamp(immediate.payload.kind.value.retryAt)).toBe(event.emittedAt);
    expect(immediate.payload.kind.value.error).toBeUndefined();
  });

  it("maps an explicit neutral retry state to UNSPECIFIED", () => {
    const event: PersistedEvent = {
      id: "event-retry-finished",
      sequence: 4n,
      globalCursor: 4n,
      revision: 4n,
      emittedAt: 20_000,
      backendId: "pi",
      targetId: "target-1",
      sessionId: "session-1",
      runId: "run-1",
      attemptId: "attempt-3",
      generation: 1,
      traceId: "trace-retry-finished",
      payload: { type: "retry", state: "unknown", attempt: 3 }
    };

    const neutral = toProtoEvent(event);
    if (neutral.payload?.kind.case !== "retryChanged") throw new Error("Expected RetryChangedEvent");
    expect(neutral.payload.kind.value.state).toBe(RetryState.UNSPECIFIED);
    expect(fromProtoEvent(neutral).payload).toEqual(event.payload);
  });

  it("publishes exact compaction lifecycles", () => {
    const terminalError = {
      code: "PI_COMPACTION_FAILED",
      message: "summary provider failed",
      phase: "compaction",
      retryable: false,
      stateMayHaveChanged: false,
      recovery: "Retry the operation."
    } as const;
    const cases = [
      { state: "started", reason: "manual", automatic: false, willRetry: undefined, protoState: CompactionState.STARTED, error: undefined },
      { state: "completed", reason: "threshold", automatic: true, willRetry: false, protoState: CompactionState.COMPLETED, error: undefined },
      { state: "no_op", reason: "threshold", automatic: true, willRetry: false, protoState: CompactionState.NO_OP, error: undefined },
      { state: "aborted", reason: "overflow", automatic: true, willRetry: false, protoState: CompactionState.ABORTED, error: undefined },
      { state: "failed", reason: "manual", automatic: false, willRetry: true, protoState: CompactionState.FAILED, error: terminalError }
    ] as const;

    for (const [index, item] of cases.entries()) {
      const payload: EventPayload = {
        type: "compaction",
        reason: item.reason,
        compactionId: `compaction-${index}`,
        state: item.state,
        boundaryEntryId: "boundary-7",
        tokensBefore: 12_345,
        tokensAfter: 2_345,
        automatic: item.automatic,
        ...(item.willRetry === undefined ? {} : { willRetry: item.willRetry }),
        ...(item.error === undefined ? {} : { error: item.error })
      };
      const event: PersistedEvent = {
        id: `event-compaction-${index}`,
        sequence: BigInt(index + 1),
        globalCursor: BigInt(index + 1),
        revision: BigInt(index + 1),
        emittedAt: 20_000 + index,
        backendId: "pi",
        targetId: "target-1",
        sessionId: "session-1",
        generation: 1,
        traceId: `trace-compaction-${index}`,
        payload
      };

      const proto = toProtoEvent(event);
      expect(proto.payload?.kind).toMatchObject({
        case: "compactionChanged",
        value: {
          compactionId: `compaction-${index}`,
          state: item.protoState,
          boundaryId: "boundary-7",
          tokensBefore: 12_345n,
          tokensAfter: 2_345n,
          automatic: item.automatic,
          reason: item.reason,
          willRetry: item.willRetry,
          ...(item.error === undefined ? {} : { error: expect.objectContaining({ code: "PI_COMPACTION_FAILED" }) })
        }
      });
      expect(fromProtoEvent(proto).payload).toEqual(payload);
    }

  });

  it("round-trips typed schedule and interaction requests", () => {
    const schedule: ScheduleRecord = {
      id: "schedule-1",
      backendId: "pi",
      targetId: "target-1",
      sessionMode: "bound",
      sessionId: "session-1",
      name: "Every minute",
      kind: "interval",
      expression: "60000",
      anchorAt: 12_345,
      timezone: "Asia/Shanghai",
      enabled: true,
      prompt: { text: "status", images: [], files: [], mentions: [], disposition: "prompt" },
      executionSnapshot: {
        providerId: "anthropic",
        modelId: "claude-test",
        effort: "high",
        fastMode: true,
        permissionMode: "auto",
        planMode: true,
        extraDirectoryIds: ["extra-1"],
        useWorktree: false,
        refreshWorktreeRemote: false,
        scheduler: {
          format: 1,
          silentWhenIdle: true,
          notify: { desktop: false },
          executionMode: "agent",
          expireAt: 90_000,
          preRunHook: {
            command: "node .joko/hooks/nightly.mjs",
            filePath: "D:\\workspace\\.joko\\hooks\\nightly.mjs",
            timeoutMs: 30_000
          }
        }
      },
      overlapPolicy: "queue",
      misfirePolicy: "run_once",
      nextRunAt: 70_000,
      createdAt: 10_000,
      updatedAt: 20_000,
      revision: 9n
    };
    const history: ScheduleRunRecord = {
      id: 12n,
      scheduleId: schedule.id,
      runId: "schedule-run-12",
      firedAt: 65_000,
      finishedAt: 66_000,
      status: "failed",
      detail: {
        script: {
          error: "Authorization: Bearer super-secret-schedule-history",
          resultText: "result Authorization: Bearer super-secret-schedule-history"
        },
        costAttribution: "zero"
      },
      revision: 1n
    };
    const protoSchedule = toProtoSchedule(schedule, [history]);
    expect(protoSchedule.execution).toMatchObject({
      executionMode: ScheduleExecutionMode.AGENT,
      silentWhenIdle: true,
      notify: { desktop: false },
      preRunHook: { command: "node .joko/hooks/nightly.mjs", timeout: { seconds: 30n } }
    });
    expect(protoSchedule.recentRuns[0]).toMatchObject({
      triggerId: "12",
      runId: "schedule-run-12",
      state: RunState.FAILED,
      zeroCost: true,
      error: { code: "SCHEDULE_EXECUTION_FAILED" }
    });
    expect(protoSchedule.recentRuns[0]?.finishedAt).toEqual(toProtoTimestamp(66_000));
    expect(protoSchedule.recentRuns[0]?.resultText).not.toContain("super-secret-schedule-history");
    expect(protoSchedule.recentRuns[0]?.error?.message).not.toContain("super-secret-schedule-history");

    const mappedSchedule = fromProtoSchedule(protoSchedule, 9n);
    expect(mappedSchedule).toMatchObject({
      id: "schedule-1",
      sessionMode: "bound",
      kind: "interval",
      expression: "60000",
      anchorAt: 12_345,
      expectedRevision: 9n,
      overlapPolicy: "queue",
      misfirePolicy: "run_once",
      executionSnapshot: {
        providerId: "anthropic",
        modelId: "claude-test",
        effort: "high",
        fastMode: true,
        permissionMode: "auto",
        planMode: true,
        extraDirectoryIds: ["extra-1"],
        useWorktree: false,
        refreshWorktreeRemote: false,
        scheduler: {
          format: 1,
          silentWhenIdle: true,
          notify: { desktop: false },
          executionMode: "agent",
          expireAt: 90_000,
          preRunHook: {
            command: "node .joko/hooks/nightly.mjs",
            filePath: "D:\\workspace\\.joko\\hooks\\nightly.mjs",
            timeoutMs: 30_000
          }
        }
      }
    });

    const interaction: InteractionRecord = {
      id: "interaction-1",
      sessionId: "session-1",
      runId: "run-1",
      generation: 7,
      kind: "permission",
      status: "open",
      payload: {
        id: "interaction-1",
        kind: "permission",
        title: "Run tool?",
        toolName: "bash",
        summary: "Writes a file",
        risk: "high",
        choices: ["allow_once", "deny_once"]
      },
      createdAt: 1_000,
      revision: 10n
    };
    const protoInteraction = toProtoInteraction(interaction, { backendId: "pi", targetId: "target-1" });
    expect(fromProtoInteraction(protoInteraction, "trace-1").payload).toEqual(interaction.payload);

    const resolved = toProtoInteraction({
      ...interaction,
      status: "resolved",
      decision: { kind: "selected", value: "allow_once" },
      resolvedAt: 2_000
    }, { backendId: "pi", targetId: "target-1" });
    expect(fromProtoInteractionDecision(resolved.resolution!)).toEqual({ kind: "decision", value: "allow_once" });
    expect(() => toProtoInteraction({
      ...interaction,
      status: "resolved",
      decision: { kind: "confirmed", confirmed: true },
      resolvedAt: 2_000
    }, { backendId: "pi", targetId: "target-1" })).toThrow(ProtoMappingError);
  });

  it("round-trips fresh Schedule isolation fields and rejects incompatible durable bindings", () => {
    const schedule: ScheduleRecord = {
      id: "schedule-isolated",
      backendId: "pi",
      targetId: "target-project",
      sessionMode: "fresh",
      name: "Isolated inspection",
      kind: "manual",
      timezone: "UTC",
      enabled: true,
      prompt: { text: "Inspect the project", images: [], files: [], mentions: [], disposition: "prompt" },
      executionSnapshot: {
        permissionMode: "ask",
        planMode: false,
        useWorktree: true,
        worktreeSourceRef: "refs/heads/feature/scheduler",
        refreshWorktreeRemote: true,
        scheduler: {
          format: 1,
          silentWhenIdle: false,
          notify: { desktop: true },
          executionMode: "agent"
        }
      },
      overlapPolicy: "queue",
      misfirePolicy: "run_once",
      createdAt: 10_000,
      updatedAt: 10_000,
      revision: 4n
    };

    const proto = toProtoSchedule(schedule);
    expect(proto.execution).toMatchObject({
      useWorktree: true,
      worktreeSourceRef: "refs/heads/feature/scheduler",
      refreshWorktreeRemote: true
    });
    expect(fromProtoSchedule(proto, 4n)).toMatchObject({
      sessionMode: "fresh",
      executionSnapshot: {
        useWorktree: true,
        worktreeSourceRef: "refs/heads/feature/scheduler",
        refreshWorktreeRemote: true,
        scheduler: {
          format: 1,
          silentWhenIdle: false,
          notify: { desktop: true },
          executionMode: "agent"
        }
      }
    });

    proto.sessionMode = ScheduleSessionMode.PERSISTENT;
    expect(() => fromProtoSchedule(proto, 4n)).toThrow(ProtoMappingError);
    proto.sessionMode = ScheduleSessionMode.FRESH;
    proto.execution!.useWorktree = false;
    expect(() => fromProtoSchedule(proto, 4n)).toThrow(ProtoMappingError);
  });

  it("projects the content-free Scheduler runtime snapshot exactly", () => {
    const snapshot = toProtoSchedulerRuntime({
      schedulerInstanceId: "scheduler-instance-1",
      processId: 42,
      inFlight: 2,
      slotsInUse: 1,
      maxConcurrentRuns: 8,
      inFlightRuns: [{
        scheduleId: "schedule-1",
        scheduleName: "Nightly",
        runId: "run-1",
        source: "automatic",
        executionMode: "agent",
        startedAt: 10_000,
        slotWaitMs: 3_000,
        phase: "running",
        lastProgressAt: 12_000
      }, {
        scheduleId: "schedule-2",
        runId: "run-2",
        source: "run-now",
        executionMode: "script",
        startedAt: 11_000,
        phase: "queued",
        lastProgressAt: 11_500
      }],
      waitingSchedules: [{ scheduleId: "schedule-3", scheduleName: "Waiting", waitingSince: 9_000 }]
    });
    expect(snapshot).toMatchObject({
      schedulerInstanceId: "scheduler-instance-1",
      processId: 42,
      inFlight: 2,
      slotsInUse: 1,
      maxConcurrentRuns: 8,
      inFlightRuns: [{
        source: ScheduleFireSource.AUTOMATIC,
        executionMode: ScheduleExecutionMode.AGENT,
        phase: ScheduleRunPhase.RUNNING,
        slotWait: { seconds: 3n }
      }, {
        source: ScheduleFireSource.RUN_NOW,
        executionMode: ScheduleExecutionMode.SCRIPT,
        phase: ScheduleRunPhase.QUEUED
      }],
      waitingTasks: [{ scheduleId: "schedule-3", scheduleName: "Waiting" }]
    });
  });

  it("projects explicit stalled and recovering Scheduler phases", () => {
    const snapshot = toProtoSchedulerRuntime({
      schedulerInstanceId: "scheduler-recovery",
      inFlight: 2,
      slotsInUse: 1,
      maxConcurrentRuns: 8,
      inFlightRuns: [{
        scheduleId: "schedule-stalled",
        runId: "run-stalled",
        source: "automatic",
        executionMode: "agent",
        startedAt: 8_000,
        phase: "stalled",
        lastProgressAt: 9_000
      }, {
        scheduleId: "schedule-recovering",
        runId: "run-recovering",
        source: "automatic",
        executionMode: "agent",
        startedAt: 8_000,
        phase: "recovering",
        lastProgressAt: 8_500
      }],
      waitingSchedules: []
    });

    expect(snapshot.inFlightRuns.map((run) => run.phase)).toEqual([
      ScheduleRunPhase.STALLED,
      ScheduleRunPhase.RECOVERING
    ]);
  });

  it("projects and round-trips the deadline of a timed extension interaction", () => {
    const interaction: InteractionRecord = {
      id: "timed-extension",
      sessionId: "session-1",
      generation: 7,
      kind: "extension_confirm",
      status: "dismissed",
      payload: {
        id: "timed-extension",
        kind: "extension_confirm",
        extensionId: "generic-extension",
        title: "Continue?",
        message: "Proceed",
        timeoutMs: 2_500
      },
      dismissalReason: "The Pi extension interaction expired.",
      createdAt: 1_000,
      resolvedAt: 3_500,
      revision: 11n
    };

    const proto = toProtoInteraction(interaction, { backendId: "pi", targetId: "target-1" });
    expect(proto.state).toBe(InteractionState.EXPIRED);
    expect(fromProtoTimestamp(proto.expiresAt)).toBe(3_500);
    expect(fromProtoInteraction(proto, "trace-timed").payload).toEqual(interaction.payload);
  });

  it("projects current typed Extension UI decision envelopes", () => {
    const base: Omit<InteractionRecord, "decision"> = {
      id: "extension-confirm",
      sessionId: "session-1",
      generation: 7,
      kind: "extension_confirm",
      status: "resolved",
      payload: {
        id: "extension-confirm",
        kind: "extension_confirm",
        extensionId: "generic-extension",
        title: "Continue?",
        message: "Proceed"
      },
      createdAt: 1_000,
      resolvedAt: 2_000,
      revision: 11n
    };
    const decisions = [
      [{ kind: "selected", value: "continue" }, "continue"],
      [{ kind: "confirmed", confirmed: true }, true],
      [{ kind: "cancelled" }, { cancelled: true }]
    ] as const;
    for (const [decision, expected] of decisions) {
      const proto = toProtoInteraction({ ...base, decision }, { backendId: "pi", targetId: "target-1" });
      expect(fromProtoInteractionDecision(proto.resolution!)).toEqual({ kind: "decision", value: expected });
    }
  });

  it("round-trips typed multi-field questions and all three Pi plan review decisions", () => {
    const question: InteractionRecord = {
      id: "question-1",
      sessionId: "session-1",
      generation: 7,
      kind: "question",
      status: "resolved",
      payload: {
        id: "question-1",
        kind: "question",
        title: "Input required",
        prompt: "Answer all fields",
        fields: [
          { id: "branch", label: "Branch", required: true, kind: "single", choices: [
            { id: "main", label: "main" },
            { id: "release", label: "release", description: "stable" }
          ] },
          { id: "checks", label: "Checks", required: true, kind: "multiple", choices: [
            { id: "unit", label: "unit" },
            { id: "e2e", label: "e2e" }
          ], defaultChoiceIds: [], minimumSelections: 1, maximumSelections: 2 },
          { id: "notes", label: "Notes", required: false, kind: "text", multiline: true, sensitive: false }
        ]
      },
      decision: { kind: "question", answers: { branch: "main", checks: ["unit", "e2e"], notes: "keep API" } },
      createdAt: 1_000,
      resolvedAt: 2_000,
      revision: 10n
    };
    const protoQuestion = toProtoInteraction(question, { backendId: "pi", targetId: "target-1" });
    expect(fromProtoInteraction(protoQuestion, "trace-question").payload).toEqual(question.payload);
    expect(fromProtoInteractionDecision(protoQuestion.resolution!)).toEqual({
      kind: "decision",
      value: { branch: "main", checks: ["unit", "e2e"], notes: "keep API" }
    });

    for (const decision of ["execute", "stay", "refine"] as const) {
      const plan: InteractionRecord = {
        id: `plan-${decision}`,
        sessionId: "session-1",
        generation: 7,
        kind: "plan_review",
        status: "resolved",
        payload: {
          id: `plan-${decision}`,
          kind: "plan_review",
          title: "Review Pi plan",
          markdown: "1. Inspect\n2. Change",
          choices: ["execute", "stay", "refine"]
        },
        decision: { kind: "plan_review", decision, feedback: `feedback:${decision}` },
        createdAt: 1_000,
        resolvedAt: 2_000,
        revision: 10n
      };
      const protoPlan = toProtoInteraction(plan, { backendId: "pi", targetId: "target-1" });
      expect(fromProtoInteraction(protoPlan, "trace-plan").payload).toEqual(plan.payload);
      expect(fromProtoInteractionDecision(protoPlan.resolution!)).toEqual({
        kind: "decision",
        value: { decision, feedback: `feedback:${decision}` }
      });
    }
  });

  it("round-trips durable event identity and typed payloads", () => {
    const event: PersistedEvent = {
      id: "event-1",
      sequence: 3n,
      revision: 12n,
      globalCursor: 22n,
      emittedAt: 1_234,
      backendId: "pi",
      targetId: "target-1",
      sessionId: "session-1",
      runId: "run-1",
      attemptId: "attempt-1",
      operationId: "operation-1",
      generation: 7,
      traceId: "trace-1",
      payload: { type: "text_delta", blockId: "message-1", delta: "hello" },
      pi: {
        rpcEventType: "message_update",
        entryId: "opaque-entry",
        parentEntryId: "opaque-parent",
        contentIndex: 2,
        payload: {
          case: "messageLifecycle",
          value: {
            kind: "message_update",
            nativeMessageId: "opaque-message",
            nativeEntryId: "opaque-entry",
            parentEntryId: "opaque-parent",
            role: "assistant",
            contentIndex: 2
          }
        }
      }
    };

    const mapped = fromProtoEvent(toProtoEvent(event));
    expect(mapped).toMatchObject({
      id: "event-1",
      emittedAt: 1_234,
      backendId: "pi",
      targetId: "target-1",
      sessionId: "session-1",
      runId: "run-1",
      attemptId: "attempt-1",
      operationId: "operation-1",
      generation: 7,
      traceId: "trace-1",
      payload: event.payload,
      pi: event.pi
    });
  });

  it("round-trips a zero-line extension widget separately from its explicit clear", () => {
    const base: Omit<PersistedEvent, "id" | "payload"> = {
      sequence: 1n,
      revision: 1n,
      globalCursor: 1n,
      emittedAt: 1_234,
      backendId: "pi",
      targetId: "target-1",
      sessionId: "session-1",
      generation: 1,
      traceId: "extension-widget"
    };
    const empty: PersistedEvent = {
      ...base,
      id: "extension-widget-empty",
      payload: {
        type: "extension_widget",
        key: "",
        lines: [],
        placement: "above_editor",
        removed: false
      }
    };
    const removed: PersistedEvent = {
      ...base,
      id: "extension-widget-removed",
      payload: {
        type: "extension_widget",
        key: "",
        lines: [],
        placement: "above_editor",
        removed: true
      }
    };

    expect(fromProtoEvent(toProtoEvent(empty)).payload).toEqual(empty.payload);
    expect(fromProtoEvent(toProtoEvent(removed)).payload).toEqual(removed.payload);
  });

  it("round-trips an explicit unknown current-context observation without fabricating cumulative tokens", () => {
    const event: PersistedEvent = {
      id: "context-cleared",
      sequence: 1n,
      globalCursor: 1n,
      revision: 1n,
      emittedAt: 1_234,
      backendId: "pi",
      targetId: "target-1",
      sessionId: "session-1",
      generation: 1,
      traceId: "context-cleared",
      payload: { type: "context_cleared" }
    };

    const proto = toProtoEvent(event);
    expect(proto.payload?.kind.case).toBe("contextUsageChanged");
    if (proto.payload?.kind.case !== "contextUsageChanged") throw new Error("Expected context usage event.");
    expect(proto.payload.kind.value.context).toBeUndefined();
    expect(fromProtoEvent(proto).payload).toEqual({ type: "context_cleared" });
  });

  it("round-trips every declared Pi metadata oneof without an opaque JSON tunnel", () => {
    const extensionEffects: readonly Extract<
      PiEventMetadata["payload"],
      { readonly case: "extensionUiEffect" }
    >["value"]["effect"][] = [
      { case: "notify", value: { message: "Done", kind: "info" } },
      { case: "status", value: { statusKey: "lint", statusText: "Running" } },
      { case: "widget", value: { widgetKey: "checks", lines: ["1/2"], placement: "below_editor", removed: false } },
      { case: "title", value: { title: "New title" } },
      { case: "editorText", value: { text: "prefill" } }
    ];
    const metadataCases: readonly PiEventMetadata[] = [
      {
        rpcEventType: "rpc_acknowledgement",
        payload: { case: "rpcAcknowledgement", value: { requestId: "rpc-1", command: "follow_up", accepted: true, cancelled: false } }
      },
      {
        rpcEventType: "native_state",
        leafId: "leaf-1",
        payload: {
          case: "nativeState",
          value: {
            nativeSessionId: "native-1",
            nativeSessionName: "Session",
            nativeSessionFileDisplay: "session.jsonl",
            model: { providerId: "provider", modelId: "model" },
            thinkingLevel: "high",
            streaming: true,
            compacting: false,
            steeringMode: "all",
            followUpMode: "one_at_a_time",
            autoCompaction: true,
            autoRetry: false,
            messageCount: 12,
            pendingMessageCount: 2,
            activeLeafId: "leaf-1"
          }
        }
      },
      {
        rpcEventType: "message_update",
        entryId: "entry-1",
        parentEntryId: "parent-1",
        contentIndex: 3,
        payload: {
          case: "messageLifecycle",
          value: {
            kind: "message_update",
            nativeMessageId: "message-1",
            nativeEntryId: "entry-1",
            parentEntryId: "parent-1",
            role: "assistant",
            contentIndex: 3
          }
        }
      },
      {
        rpcEventType: "tool_execution_update",
        contentIndex: 4,
        nativeToolName: "read",
        payload: {
          case: "toolLifecycle",
          value: { nativeToolCallId: "tool-1", toolName: "read", builtInKind: "read", phase: "update", contentIndex: 4 }
        }
      },
      {
        rpcEventType: "bash_execution_update",
        payload: {
          case: "bashUpdate",
          value: {
            nativeBashId: "bash-1",
            commandDisplay: "pnpm test",
            stdoutDelta: "ok",
            stderrDelta: "",
            completed: true,
            exitCode: 0,
            excludedFromContext: false
          }
        }
      },
      {
        rpcEventType: "queue_update",
        payload: {
          case: "queueUpdate",
          value: {
            steering: [{ nativeQueueId: "queued-1", textPreview: "Fix tests", imageCount: 1, queuedAt: 1_234 }],
            followUp: [],
            steeringMode: "one_at_a_time",
            followUpMode: "all"
          }
        }
      },
      {
        rpcEventType: "compaction_update",
        parentEntryId: "boundary-1",
        payload: {
          case: "compactionUpdate",
          value: {
            compactionId: "compaction-1",
            trigger: "manual",
            reason: "manual",
            willRetry: false,
            state: "completed",
            boundaryEntryId: "boundary-1",
            tokensBefore: 10_000,
            tokensAfter: 2_000,
            summaryPreview: "summary"
          }
        }
      },
      {
        rpcEventType: "retry_update",
        payload: {
          case: "retryUpdate",
          value: { state: "waiting", attemptNumber: 2, retryAt: 2_345, reason: "rate limit" }
        }
      },
      {
        rpcEventType: "session_identity_update",
        leafId: "leaf-2",
        payload: {
          case: "sessionIdentityUpdate",
          value: {
            previousNativeSessionId: "native-1",
            nativeSessionId: "native-2",
            nativeSessionName: "Fork",
            nativeSessionFileDisplay: "fork.jsonl",
            activeLeafId: "leaf-2",
            change: "forked"
          }
        }
      },
      {
        rpcEventType: "session_tree_update",
        leafId: "child-1",
        payload: {
          case: "sessionTreeUpdate",
          value: {
            nativeSessionId: "native-2",
            activeLeafId: "child-1",
            roots: [{
              entryId: "root-1",
              parentId: "",
              kind: "message",
              role: "user",
              textPreview: "hello",
              branchSummary: "",
              createdAt: 3_456,
              active: false,
              children: [{
                entryId: "child-1",
                parentId: "root-1",
                kind: "message",
                role: "assistant",
                textPreview: "hi",
                branchSummary: "",
                active: true,
                children: []
              }]
            }]
          }
        }
      },
      {
        rpcEventType: "command_catalog_update",
        payload: {
          case: "commandCatalogUpdate",
          value: {
            commands: [{
              name: "review",
              description: "Review changes",
              source: "skill",
              sourceInfo: {
                resourceId: "skill-1",
                scope: "project",
                sourceDisplay: ".pi/skills/review",
                packageName: "review-package"
              }
            }]
          }
        }
      },
      ...extensionEffects.map((effect): PiEventMetadata => ({
        rpcEventType: "extension_ui_effect",
        payload: {
          case: "extensionUiEffect",
          value: { requestId: `request-${effect.case}`, extensionId: "extension-1", effect } as Extract<
            PiEventMetadata["payload"],
            { readonly case: "extensionUiEffect" }
          >["value"]
        }
      })),
      {
        rpcEventType: "resource_update",
        payload: {
          case: "resourceUpdate",
          value: {
            updateKind: "loaded",
            resource: {
              resourceId: "resource-1",
              backendId: "pi",
              targetId: "target-1",
              kind: "extension",
              name: "review",
              version: "1.0.0",
              source: {
                scope: "managed",
                sourceDisplay: "managed/review",
                canonicalPathFingerprint: "sha256:fingerprint",
                symbolicLinkDetected: false,
                specialFileDetected: false
              },
              state: "loaded",
              enabled: true,
              approvedAt: 4_567,
              approvedByConnectionId: "connection-1",
              revision: 7,
              generation: 2,
              updatedAt: 5_678,
              discoveredRevision: "sha256:revision"
            }
          }
        }
      },
      {
        rpcEventType: "model_update",
        payload: {
          case: "modelUpdate",
          value: {
            previousModel: { providerId: "provider", modelId: "old" },
            model: { providerId: "provider", modelId: "new" },
            thinkingLevel: "medium",
            scopedModel: true,
            contextWindowTokens: 200_000
          }
        }
      },
      {
        rpcEventType: "extension_error",
        payload: {
          case: "diagnostic",
          value: {
            command: "get_state",
            nativeEventType: "extension_error",
            processExitCode: 9,
            sanitizedStderrExcerpt: "safe excerpt",
            jsonlLineNumber: 42,
            parseError: "safe parse error"
          }
        }
      }
    ];

    for (const [index, pi] of metadataCases.entries()) {
      const event: PersistedEvent = {
        id: `pi-metadata-${index}`,
        sequence: BigInt(index + 1),
        globalCursor: BigInt(index + 1),
        revision: BigInt(index + 1),
        emittedAt: 10_000 + index,
        backendId: "pi",
        targetId: "target-1",
        sessionId: "session-1",
        generation: 1,
        traceId: `trace-${index}`,
        payload: { type: "status", key: "round-trip" },
        pi
      };
      const proto = toProtoEvent(event);
      expect(proto.pi?.payload.case).toBe(pi.payload.case);
      expect(fromProtoEvent(proto).pi).toEqual(pi);
    }
  });

  it("round-trips a 10001-node Pi Session tree through binary protobuf and rejects cycles", { timeout: 20_000 }, () => {
    type TreeNode = Extract<PiEventMetadata["payload"], { readonly case: "sessionTreeUpdate" }>["value"]["roots"][number];
    let root: TreeNode | undefined;
    for (let index = 10_000; index >= 0; index -= 1) {
      root = {
        entryId: `entry-${index}`,
        parentId: index === 0 ? "" : `entry-${index - 1}`,
        kind: "message",
        role: index % 2 === 0 ? "user" : "assistant",
        textPreview: `entry ${index}`,
        branchSummary: "",
        active: index === 10_000,
        children: root === undefined ? [] : [root]
      };
    }
    const event: PersistedEvent = {
      id: "deep-pi-tree",
      sequence: 1n,
      globalCursor: 1n,
      revision: 1n,
      emittedAt: 1,
      backendId: "pi",
      targetId: "target-1",
      sessionId: "session-1",
      generation: 1,
      traceId: "deep-pi-tree",
      payload: { type: "status", key: "tree" },
      pi: {
        rpcEventType: "session_tree_update",
        payload: {
          case: "sessionTreeUpdate",
          value: { nativeSessionId: "native-1", activeLeafId: "entry-10000", roots: [root!] }
        }
      }
    };

    const proto = toProtoEvent(event);
    expect(proto.pi?.payload.case).toBe("sessionTreeUpdate");
    if (proto.pi?.payload.case !== "sessionTreeUpdate") throw new Error("Expected Pi Session tree update.");
    expect(proto.pi.payload.value.flatNodes).toHaveLength(10_001);
    expect(proto.pi.payload.value.rootCount).toBe(1);
    const binaryRoundTrip = fromBinary(EventSchema, toBinary(EventSchema, proto));
    const roundTrip = fromProtoEvent(binaryRoundTrip);
    expect(roundTrip.pi?.payload.case).toBe("sessionTreeUpdate");
    if (roundTrip.pi?.payload.case !== "sessionTreeUpdate") throw new Error("Expected round-tripped Pi Session tree update.");
    expect(piTreeDepth(roundTrip.pi.payload.value.roots[0])).toBe(10_001);

    const cycleChildren: TreeNode[] = [];
    const cycle: TreeNode = {
      entryId: "cycle",
      parentId: "",
      kind: "message",
      role: "user",
      textPreview: "cycle",
      branchSummary: "",
      active: false,
      children: cycleChildren
    };
    cycleChildren.push(cycle);
    const cyclicEvent = {
      ...event,
      pi: {
        rpcEventType: "session_tree_update",
        payload: {
          case: "sessionTreeUpdate",
          value: { nativeSessionId: "native-1", activeLeafId: "", roots: [cycle] }
        }
      }
    } as PersistedEvent;
    expect(() => toProtoEvent(cyclicEvent)).toThrow(/cycle or repeated/u);
  });

  it("rejects Pi metadata without a typed payload", () => {
    const untypedEvent: PersistedEvent = {
      id: "untyped-pi-metadata",
      sequence: 1n,
      globalCursor: 1n,
      revision: 1n,
      emittedAt: 1_000,
      backendId: "pi",
      targetId: "target-1",
      sessionId: "session-1",
      generation: 1,
      traceId: "untyped-trace",
      payload: { type: "status", key: "untyped" },
      pi: { rpcEventType: "untyped", entryId: "untyped-entry" } as unknown as PiEventMetadata
    };
    expect(() => toProtoEvent(untypedEvent)).toThrow(/typed payload/u);
  });

  it("round-trips Review execution, stale evidence, and the preserved result independently", () => {
    const payload: EventPayload = {
      type: "review_run_changed",
      reviewRun: {
        id: "review-1",
        sourceSessionId: "session-1",
        reviewerSessionId: "reviewer-1",
        targetKind: "mixed",
        state: "completed",
        freshness: "stale",
        freshnessCheckedAt: 2_000,
        evidence: {
          sealSha256: "a".repeat(64),
          sourceRevision: {
            version: 1,
            conversationSha256: "b".repeat(64),
            workspaceSha256: "c".repeat(64),
            filesSha256: "d".repeat(64),
            artifactsSha256: "e".repeat(64)
          },
          targetKind: "mixed",
          capturedAt: 1_000
        },
        result: "## Preserved conclusion",
        createdAt: 1_000,
        updatedAt: 2_000,
        endedAt: 1_500,
        revision: "3"
      }
    };
    const event: PersistedEvent = {
      id: "review-event",
      sequence: 3n,
      globalCursor: 3n,
      revision: 3n,
      emittedAt: 2_000,
      backendId: "fixture",
      targetId: "target-1",
      sessionId: "session-1",
      generation: 1,
      traceId: "review-trace",
      payload
    };

    const proto = toProtoEvent(event);
    expect(proto.payload?.kind.case).toBe("reviewRunChanged");
    if (proto.payload?.kind.case !== "reviewRunChanged") throw new Error("Expected Review run change.");
    expect(proto.payload.kind.value.reviewRun?.freshness?.state).toBe(ReviewFreshnessState.STALE);
    expect(proto.payload.kind.value.reviewRun?.resultMarkdown).toBe("## Preserved conclusion");
    const encoded = toBinary(EventSchema, proto);
    expect(fromProtoEvent(fromBinary(EventSchema, encoded)).payload).toEqual(payload);

    const withoutFreshness = fromBinary(EventSchema, encoded);
    if (withoutFreshness.payload?.kind.case !== "reviewRunChanged" || withoutFreshness.payload.kind.value.reviewRun === undefined) {
      throw new Error("Expected Review run change.");
    }
    withoutFreshness.payload.kind.value.reviewRun.freshness = undefined;
    expect(() => fromProtoEvent(withoutFreshness)).toThrow(/freshness is required/u);

    const unspecifiedFreshness = fromBinary(EventSchema, encoded);
    if (unspecifiedFreshness.payload?.kind.case !== "reviewRunChanged"
      || unspecifiedFreshness.payload.kind.value.reviewRun?.freshness === undefined) {
      throw new Error("Expected Review freshness.");
    }
    unspecifiedFreshness.payload.kind.value.reviewRun.freshness.state = ReviewFreshnessState.UNSPECIFIED;
    expect(() => fromProtoEvent(unspecifiedFreshness)).toThrow(/freshness state is required/u);

    const withoutEvidence = fromBinary(EventSchema, encoded);
    if (withoutEvidence.payload?.kind.case !== "reviewRunChanged" || withoutEvidence.payload.kind.value.reviewRun === undefined) {
      throw new Error("Expected Review run change.");
    }
    withoutEvidence.payload.kind.value.reviewRun.evidence = undefined;
    expect(() => fromProtoEvent(withoutEvidence)).toThrow(/evidence is required/u);
  });

  it("maps storage conflicts into stable public typed errors", () => {
    const error = mapErrorToPublic(new OperationConflictError("operation-1", "old", "new"));
    expect(error).toMatchObject({
      code: "operation_id_conflict",
      phase: "operation",
      retryable: false,
      stateMayHaveChanged: false
    });
  });
});

function piTreeDepth(root: { readonly children: readonly unknown[] } | undefined): number {
  let current: unknown = root;
  let depth = 0;
  while (current !== undefined) {
    if (typeof current !== "object" || current === null) throw new Error("Pi tree node is invalid.");
    const children = (current as { readonly children?: unknown }).children;
    if (!Array.isArray(children) || children.length > 1) throw new Error("Pi tree is not linear.");
    depth += 1;
    current = children[0];
  }
  return depth;
}
