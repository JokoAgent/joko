import type {
  AttemptId,
  BackendId,
  BlobRef,
  EventId,
  InteractionId,
  InlineTextRange,
  OperationId,
  PublicError,
  QueueItemId,
  RunId,
  RunState,
  SessionAttentionKind,
  SessionId,
  TargetId,
  UnixMillis,
  UsageSnapshot
} from "./types.js";
import type { SubagentRunDetail, SubagentTranscriptEntry } from "./subagents.js";
import type { RuntimeCommand } from "./adapter.js";

export interface EventEnvelope {
  readonly id: EventId;
  readonly sequence: bigint;
  readonly revision: bigint;
  readonly emittedAt: UnixMillis;
  readonly backendId: BackendId;
  readonly targetId: TargetId;
  readonly sessionId: SessionId;
  readonly runId?: RunId;
  readonly attemptId?: AttemptId;
  readonly operationId?: OperationId;
  readonly generation: number;
  readonly traceId: string;
  readonly payload: EventPayload;
  readonly pi?: PiEventMetadata;
}

export type EventPayload =
  | { readonly type: "run_state"; readonly state: RunState; readonly error?: PublicError }
  /** Content-free signal that the durable Session projection changed. */
  | { readonly type: "session_changed" }
  | { readonly type: "text_delta"; readonly blockId: string; readonly delta: string; readonly contentIndex?: number; readonly nativeHistory?: NativeHistoryEventContext }
  | { readonly type: "thinking_delta"; readonly blockId: string; readonly delta: string; readonly contentIndex?: number; readonly nativeHistory?: NativeHistoryEventContext }
  | {
      readonly type: "message_complete";
      readonly role: "user" | "assistant";
      readonly blocks: readonly MessageBlock[];
      /** Durable product truth copied from the accepted user input. */
      readonly quotesEncoded?: boolean;
      /** Durable UTF-16 spans copied from the accepted user input. */
      readonly pastedTextRanges?: readonly InlineTextRange[];
      /** Per-message provider accounting when authoritatively reported. */
      readonly usage?: UsageSnapshot;
      /** Generation-only time for this assistant message, never turn wall-clock time. */
      readonly generationDurationMs?: number;
      /** True only when generationDurationMs came from an authoritative native duration. */
      readonly generationReliable?: boolean;
      /** Durable host-authored source identity for scheduler-injected prompts. */
      readonly automationOrigin?: MessageAutomationOrigin;
      /** Accepted-input delivery semantics; absent only on untyped imported native history. */
      readonly inputDelivery?: MessageInputDelivery;
      /** Service-owned prompt continuation; rendered as recovery activity, never as a user message. */
      readonly automaticContinuation?: {
        readonly recoveryId: string;
      };
      /** Opaque Backend-owned history semantics used only for branch navigation/reconciliation. */
      readonly nativeHistory?: NativeHistoryEventContext;
    }
  | {
      readonly type: "runtime_recovery";
      readonly recoveryId: string;
      readonly sourceRunId: string;
      readonly continuationRunId?: string;
      readonly state: "waiting" | "running" | "succeeded" | "failed" | "exhausted" | "cancelled";
      readonly attempt: number;
      readonly maximumAttempts: number;
      readonly sessionTotal: number;
      readonly delayMs?: number;
      readonly routeChanged?: boolean;
      readonly error: PublicError;
    }
  | { readonly type: "status"; readonly key: string; readonly text?: string; readonly nativeHistory?: NativeHistoryEventContext }
  | {
      /** Already-redacted one-shot UI effect emitted by any capable Backend. */
      readonly type: "extension_ui_effect";
      readonly effect: "notification" | "title" | "editor_text";
      readonly text: string;
      readonly notificationKind?: "unknown" | "info" | "warning" | "error";
    }
  | { readonly type: "tool_start"; readonly callId: string; readonly name: string; readonly input: string; readonly nativeHistory?: NativeHistoryEventContext }
  | {
      readonly type: "tool_update";
      readonly callId: string;
      /** Backend-neutral display identity retained across update-only projections. */
      readonly name: string;
      /** Whether output is a delta or an authoritative replacement. */
      readonly outputMode?: "append" | "replace";
      readonly output: string;
      readonly parts?: readonly ToolResultContentPart[];
      readonly artifact?: BlobRef;
      readonly nativeHistory?: NativeHistoryEventContext;
    }
  | {
      readonly type: "tool_result";
      readonly callId: string;
      /** Backend-neutral display identity retained across reconnect/history projections. */
      readonly name: string;
      readonly output: string;
      readonly parts?: readonly ToolResultContentPart[];
      readonly isError: boolean;
      readonly artifact?: BlobRef;
      readonly nativeHistory?: NativeHistoryEventContext;
    }
  | { readonly type: "artifact"; readonly artifact: BlobRef; readonly purpose: string }
  | WorkspaceDiffEventPayload
  | { readonly type: "interaction_opened"; readonly interaction: InteractionPayload }
  | { readonly type: "interaction_resolved"; readonly interactionId: InteractionId; readonly decision: string }
  | { readonly type: "interaction_dismissed"; readonly interactionId: InteractionId; readonly reason: string }
  | { readonly type: "queue_update"; readonly itemId?: QueueItemId; readonly steering: readonly string[]; readonly followUps: readonly string[] }
  | {
      readonly type: "queue_control";
      readonly paused: boolean;
      readonly reason?: string;
      readonly pausedAt?: UnixMillis;
      readonly connectionId?: string;
    }
  | {
      readonly type: "compaction";
      readonly reason: string;
      readonly summary?: string;
      /** Stable across the start and terminal events for one compaction operation. */
      readonly compactionId: string;
      readonly state: "started" | "completed" | "no_op" | "aborted" | "failed";
      readonly boundaryEntryId?: string;
      readonly tokensBefore?: number;
      readonly tokensAfter?: number;
      readonly automatic?: boolean;
      /** Whether Pi will resume the interrupted agent lifecycle after compaction. */
      readonly willRetry?: boolean;
      readonly error?: PublicError;
      readonly nativeHistory?: NativeHistoryEventContext;
    }
  | {
      readonly type: "retry";
      readonly state: RetryEventState;
      readonly attempt: number;
      readonly maxAttempts?: number;
      readonly delayMs?: number;
      readonly error?: PublicError;
    }
  | { readonly type: "usage"; readonly usage: UsageSnapshot }
  | { readonly type: "context_cleared" }
  | {
      /** Internal same-Backend native boundary, projected only as a system card. */
      readonly type: "context_rebuild";
      readonly reason: "context_overflow" | "prompt_timeout";
      /** Redacted text actually handed to the replacement native context. */
      readonly handoff: string;
      readonly sourceRunId?: RunId;
      readonly replayScheduled: boolean;
    }
  | {
      readonly type: "message_deleted";
      readonly requestedEventId: EventId;
      readonly deletedEventIds: readonly EventId[];
    }
  | { readonly type: "session_reset" }
  | { readonly type: "history_pruned"; readonly activeContextReset: boolean }
  | { readonly type: "native_session_changed"; readonly opaqueRef: string; readonly nativeSessionId?: string; readonly leafId?: string }
  | {
      readonly type: "background_task";
      readonly taskId: string;
      readonly parentTaskId?: string;
      readonly title: string;
      readonly state: string;
      readonly detail?: string;
      /** Present only when the producer has a measured completion ratio. */
      readonly progressRatio?: number;
      readonly startedAt?: UnixMillis;
      readonly endedAt?: UnixMillis;
      readonly error?: PublicError;
    }
  | { readonly type: "subagent_run"; readonly run: SubagentRunDetail }
  | {
      readonly type: "subagent_transcript";
      readonly subagentRunId: string;
      readonly entry: SubagentTranscriptEntry;
    }
  | {
      readonly type: "extension_widget";
      readonly key: string;
      readonly lines: readonly string[];
      readonly placement: "above_editor" | "below_editor";
      readonly removed: boolean;
    }
  | { readonly type: "extension_status"; readonly key: string; readonly text?: string }
  | { readonly type: "runtime_commands_changed"; readonly commands: readonly RuntimeCommand[] }
  | { readonly type: "review_run_changed"; readonly reviewRun: ReviewRunProjection }
  | {
      readonly type: "session_attention";
      readonly kind: SessionAttentionKind;
      readonly unread: boolean;
      /** Decimal uint64; source Event that established the attention kind. */
      readonly subjectCursor: string;
      readonly subjectGeneration: number;
      /** Decimal uint64; Event payloads are JSON durable. */
      readonly attentionCursor: string;
      readonly attentionGeneration: number;
      /** Decimal uint64; Event payloads are JSON durable. */
      readonly readThroughCursor: string;
      readonly readThroughGeneration: number;
    }
  | { readonly type: "error"; readonly error: PublicError; readonly terminal: boolean }
  | { readonly type: "done"; readonly outcome: "completed" | "aborted" | "failed" };

export interface MessageAutomationOrigin {
  readonly kind: "scheduler";
  readonly scheduleId: string;
  readonly scheduleName?: string;
  readonly runId?: RunId;
}

export type MessageInputDelivery = "prompt" | "steer" | "follow_up" | "scheduler";

export interface ReviewRunProjection {
  readonly id: string;
  readonly sourceSessionId: SessionId;
  readonly reviewerSessionId?: SessionId;
  readonly targetKind: "changes" | "artifacts" | "task" | "mixed";
  /** Reviewer execution and evidence freshness are independent axes. */
  readonly state: "running" | "completed" | "failed";
  readonly freshness: "current" | "stale" | "unavailable";
  /** Last service-side comparison against the immutable evidence seal. */
  readonly freshnessCheckedAt: UnixMillis;
  readonly evidence: ReviewEvidenceProjection;
  readonly result?: string;
  readonly failureCode?:
    | "no-visible-result"
    | "reviewer-closed"
    | "cancelled-before-start"
    | "interrupted"
    | "source-workspace-changed"
    | "source-conversation-changed"
    | "source-files-changed"
    | "artifact-changed"
    | "artifact-unavailable"
    | "provider-failed";
  readonly createdAt: UnixMillis;
  readonly updatedAt: UnixMillis;
  readonly endedAt?: UnixMillis;
  /** Decimal uint64; Event payloads are JSON durable. */
  readonly revision: string;
}

export interface ReviewEvidenceProjection {
  readonly sealSha256: string;
  readonly sourceRevision: {
    readonly version: 1;
    readonly conversationSha256: string;
    readonly workspaceSha256: string;
    readonly filesSha256: string;
    readonly artifactsSha256: string;
  };
  readonly targetKind: ReviewRunProjection["targetKind"];
  readonly capturedAt: UnixMillis;
}

export type MessageBlock =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "thinking"; readonly text: string; readonly redacted: boolean }
  | { readonly kind: "image"; readonly blob: BlobRef; readonly alt?: string }
  | { readonly kind: "artifact"; readonly blob: BlobRef; readonly label: string }
  | { readonly kind: "tool_call"; readonly callId: string; readonly name: string; readonly input: string }
  | { readonly kind: "tool_result"; readonly callId: string; readonly output: string; readonly isError: boolean };

/** Durable, binary-safe projection of a backend tool result. */
export type ToolResultContentPart =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "image"; readonly blob: BlobRef; readonly alt?: string }
  | { readonly kind: "artifact"; readonly blob: BlobRef; readonly label: string };

/** A redacted, durable workspace projection captured with a run. */
export interface WorkspaceDiffEventPayload {
  readonly type: "workspace_diff";
  readonly changeSetId: string;
  readonly summary: string;
  readonly changeSet: WorkspaceChangeSetProjection;
  readonly diff: WorkspaceDiffProjection;
  readonly workspace: WorkspaceDescriptorProjection;
  /** Decimal uint64. Kept as text because event payloads are JSON persisted. */
  readonly entriesRevision: string;
  readonly upsertedEntries: readonly WorkspaceEntryProjection[];
  readonly removedRelativePaths: readonly string[];
}

export interface WorkspaceFileRevisionProjection {
  readonly sha256Hex: string;
  readonly byteSize: number;
  readonly modifiedAt: UnixMillis;
  readonly opaqueRevision: string;
}

export interface WorkspaceFileChangeProjection {
  readonly relativePath: string;
  readonly kind: "created" | "updated" | "deleted";
  readonly beforeRevision?: WorkspaceFileRevisionProjection;
  readonly afterRevision?: WorkspaceFileRevisionProjection;
}

export interface WorkspaceChangeSetProjection {
  readonly changeSetId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly baselineId: string;
  readonly changes: readonly WorkspaceFileChangeProjection[];
  readonly completeBaseline: boolean;
  readonly gaps: readonly string[];
  readonly capturedAt: UnixMillis;
}

export type WorkspaceGitFileStatusProjection =
  | "unspecified"
  | "unmodified"
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "ignored"
  | "conflicted";

export interface WorkspaceFileDiffProjection {
  readonly relativePath: string;
  readonly oldRelativePath?: string;
  readonly status: WorkspaceGitFileStatusProjection;
  readonly binary: boolean;
}

export interface WorkspaceDiffProjection {
  readonly workspaceId: string;
  readonly files: readonly WorkspaceFileDiffProjection[];
  /** True when textual hunks were intentionally omitted from the event. */
  readonly truncated: boolean;
}

export interface WorkspaceGitFileChangeProjection {
  readonly relativePath: string;
  readonly oldRelativePath?: string;
  readonly indexStatus: WorkspaceGitFileStatusProjection;
  readonly workingTreeStatus: WorkspaceGitFileStatusProjection;
  readonly binary: boolean;
}

export interface WorkspaceGitProjection {
  readonly repository: boolean;
  readonly branchName?: string;
  readonly headCommit?: string;
  readonly detachedHead: boolean;
  readonly dirty: boolean;
  readonly operationInProgress: boolean;
  readonly changes: readonly WorkspaceGitFileChangeProjection[];
}

export interface WorkspaceDescriptorProjection {
  readonly workspaceId: string;
  readonly targetId: string;
  readonly displayName: string;
  readonly kind: "user_project" | "managed_dialogue";
  /** Deliberately empty for run events so absolute server paths are not persisted. */
  readonly serverPathDisplay: string;
  readonly trusted: boolean;
  readonly git?: WorkspaceGitProjection;
  /** Decimal uint64 values, represented as text for JSON durability. */
  readonly revision: string;
  readonly generation: string;
  readonly updatedAt: UnixMillis;
}

export interface WorkspaceEntryProjection {
  readonly workspaceId: string;
  readonly relativePath: string;
  readonly displayName: string;
  readonly kind: "regular" | "directory";
  readonly revision?: WorkspaceFileRevisionProjection;
  readonly generated: boolean;
  readonly ignored: boolean;
  readonly hidden: boolean;
  readonly mediaType: string;
}

export type PlanReviewDecision = "execute" | "stay" | "refine";

export interface InteractionQuestionChoice {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

export type InteractionQuestionField = {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly required: boolean;
} & (
  | {
      readonly kind: "text";
      readonly placeholder?: string;
      readonly defaultValue?: string;
      readonly multiline: boolean;
      readonly sensitive: boolean;
    }
  | { readonly kind: "single"; readonly choices: readonly InteractionQuestionChoice[]; readonly defaultChoiceId?: string }
  | {
      readonly kind: "multiple";
      readonly choices: readonly InteractionQuestionChoice[];
      readonly defaultChoiceIds: readonly string[];
      readonly minimumSelections: number;
      readonly maximumSelections?: number;
    }
  | { readonly kind: "boolean"; readonly defaultValue: boolean }
);

export type InteractionPayload =
  | {
      readonly id: InteractionId;
      readonly kind: "permission";
      readonly title: string;
      readonly toolName: string;
      readonly summary: string;
      readonly risk: "low" | "medium" | "high";
      readonly choices: readonly string[];
    }
  | {
      readonly id: InteractionId;
      readonly kind: "question";
      readonly title: string;
      readonly prompt: string;
      readonly fields: readonly InteractionQuestionField[];
    }
  | {
      readonly id: InteractionId;
      readonly kind: "plan_review";
      readonly title: string;
      readonly markdown: string;
      readonly choices: readonly PlanReviewDecision[];
    }
  | {
      readonly id: InteractionId;
      readonly kind: "extension_select" | "extension_confirm" | "extension_input" | "extension_editor";
      /** Backend-owned extension identity; shared layers preserve but never interpret it. */
      readonly extensionId: string;
      readonly title: string;
      readonly message?: string;
      readonly options?: readonly string[];
      readonly prefill?: string;
      readonly placeholder?: string;
      readonly timeoutMs?: number;
    };

export interface NativeMessageIdentity {
  readonly entryId: string;
  readonly parentEntryId?: string;
}

export interface NativeHistoryEventContext {
  readonly identity?: NativeMessageIdentity;
}

export const NATIVE_HISTORY_REPLACES_TRANSIENT_FIELD = "nativeHistoryReplacesTransient";
export const NATIVE_HISTORY_BINDING_FINGERPRINT_FIELD = "nativeBindingFingerprint";

export function nativeHistoryEventContext(payload: EventPayload): NativeHistoryEventContext | undefined {
  switch (payload.type) {
    case "text_delta":
    case "thinking_delta":
    case "message_complete":
    case "status":
    case "tool_start":
    case "tool_update":
    case "tool_result":
    case "compaction":
      return payload.nativeHistory;
    default:
      return undefined;
  }
}

export function withNativeHistoryEventContext(
  payload: EventPayload,
  nativeHistory: NativeHistoryEventContext
): EventPayload {
  switch (payload.type) {
    case "text_delta":
    case "thinking_delta":
    case "message_complete":
    case "status":
    case "tool_start":
    case "tool_update":
    case "tool_result":
    case "compaction":
      return { ...payload, nativeHistory };
    default:
      return payload;
  }
}


export interface PiEventMetadata {
  readonly rpcEventType: string;
  readonly entryId?: string;
  readonly parentEntryId?: string;
  readonly leafId?: string;
  readonly contentIndex?: number;
  readonly nativeToolName?: string;
  readonly payload: PiEventMetadataPayload;
}

export type PiEventMetadataPayload =
  | { readonly case: "rpcAcknowledgement"; readonly value: PiRpcAcknowledgementMetadata }
  | { readonly case: "nativeState"; readonly value: PiNativeStateMetadata }
  | { readonly case: "messageLifecycle"; readonly value: PiMessageLifecycleMetadata }
  | { readonly case: "toolLifecycle"; readonly value: PiToolLifecycleMetadata }
  | { readonly case: "bashUpdate"; readonly value: PiBashUpdateMetadata }
  | { readonly case: "queueUpdate"; readonly value: PiQueueUpdateMetadata }
  | { readonly case: "compactionUpdate"; readonly value: PiCompactionUpdateMetadata }
  | { readonly case: "retryUpdate"; readonly value: PiRetryUpdateMetadata }
  | { readonly case: "sessionIdentityUpdate"; readonly value: PiSessionIdentityMetadata }
  | { readonly case: "sessionTreeUpdate"; readonly value: PiSessionTreeMetadata }
  | { readonly case: "commandCatalogUpdate"; readonly value: PiCommandCatalogMetadata }
  | { readonly case: "extensionUiEffect"; readonly value: PiExtensionUiMetadata }
  | { readonly case: "resourceUpdate"; readonly value: PiResourceUpdateMetadata }
  | { readonly case: "modelUpdate"; readonly value: PiModelUpdateMetadata }
  | { readonly case: "diagnostic"; readonly value: PiDiagnosticEventMetadata };

export type PiRpcCommand =
  | "unknown"
  | "prompt"
  | "steer"
  | "follow_up"
  | "abort"
  | "new_session"
  | "get_state"
  | "set_model"
  | "cycle_model"
  | "get_available_models"
  | "set_thinking_level"
  | "cycle_thinking_level"
  | "get_available_thinking_levels"
  | "set_steering_mode"
  | "set_follow_up_mode"
  | "compact"
  | "set_auto_compaction"
  | "set_auto_retry"
  | "abort_retry"
  | "bash"
  | "abort_bash"
  | "get_session_stats"
  | "export_html"
  | "switch_session"
  | "fork"
  | "clone"
  | "get_fork_messages"
  | "get_entries"
  | "get_tree"
  | "get_last_assistant_text"
  | "set_session_name"
  | "get_messages"
  | "get_commands";

export interface PiRpcAcknowledgementMetadata {
  readonly requestId: string;
  readonly command: PiRpcCommand;
  readonly accepted: boolean;
  readonly cancelled: boolean;
  readonly error?: PublicError;
}

export type PiQueueModeMetadata = "unknown" | "all" | "one_at_a_time";

export interface PiModelKeyMetadata {
  readonly providerId: string;
  readonly modelId: string;
}

export interface PiNativeStateMetadata {
  readonly nativeSessionId: string;
  readonly nativeSessionName: string;
  readonly nativeSessionFileDisplay: string;
  readonly model?: PiModelKeyMetadata;
  readonly thinkingLevel: string;
  readonly streaming: boolean;
  readonly compacting: boolean;
  readonly steeringMode: PiQueueModeMetadata;
  readonly followUpMode: PiQueueModeMetadata;
  readonly autoCompaction: boolean;
  readonly autoRetry: boolean;
  readonly messageCount: number;
  readonly pendingMessageCount: number;
  readonly activeLeafId: string;
}

export type PiMessageLifecycleKindMetadata =
  | "unknown"
  | "agent_start"
  | "turn_start"
  | "message_start"
  | "message_update"
  | "message_end"
  | "turn_end"
  | "agent_end";

export interface PiMessageLifecycleMetadata {
  readonly kind: PiMessageLifecycleKindMetadata;
  readonly nativeMessageId: string;
  readonly nativeEntryId: string;
  readonly parentEntryId: string;
  readonly role: string;
  readonly contentIndex: number;
}

export type PiBuiltInToolKindMetadata = "unknown" | "read" | "write" | "edit" | "bash" | "custom" | "mcp_bridge";
export type PiToolPhaseMetadata = "unknown" | "start" | "update" | "end";

export interface PiToolLifecycleMetadata {
  readonly nativeToolCallId: string;
  readonly toolName: string;
  readonly builtInKind: PiBuiltInToolKindMetadata;
  readonly phase: PiToolPhaseMetadata;
  readonly contentIndex: number;
}

export interface PiBashUpdateMetadata {
  readonly nativeBashId: string;
  readonly commandDisplay: string;
  readonly stdoutDelta: string;
  readonly stderrDelta: string;
  readonly completed: boolean;
  readonly exitCode: number;
  readonly excludedFromContext: boolean;
}

export interface PiQueuedMessageMetadata {
  readonly nativeQueueId: string;
  readonly textPreview: string;
  readonly imageCount: number;
  readonly queuedAt?: UnixMillis;
}

export interface PiQueueUpdateMetadata {
  readonly steering: readonly PiQueuedMessageMetadata[];
  readonly followUp: readonly PiQueuedMessageMetadata[];
  readonly steeringMode: PiQueueModeMetadata;
  readonly followUpMode: PiQueueModeMetadata;
}

export type PiCompactionTriggerMetadata = "unknown" | "automatic" | "manual" | "branch";
export type PiCompactionStateMetadata = "unknown" | "started" | "retrying" | "completed" | "no_op" | "aborted" | "failed";

export interface PiCompactionUpdateMetadata {
  readonly compactionId: string;
  readonly trigger: PiCompactionTriggerMetadata;
  /** Native Pi reason (`manual`, `threshold`, or `overflow`) when available. */
  readonly reason?: string;
  readonly state: PiCompactionStateMetadata;
  readonly boundaryEntryId: string;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly summaryPreview: string;
  readonly willRetry?: boolean;
  readonly error?: PublicError;
}

export type RetryEventState = "unknown" | "waiting" | "started" | "succeeded" | "aborted" | "exhausted";

export type PiRetryStateMetadata = RetryEventState;

export interface PiRetryUpdateMetadata {
  readonly state: PiRetryStateMetadata;
  readonly attemptNumber: number;
  readonly retryAt?: UnixMillis;
  readonly reason: string;
  readonly error?: PublicError;
}

export type PiSessionIdentityChangeMetadata =
  | "unknown"
  | "created"
  | "resumed"
  | "switched"
  | "renamed"
  | "forked"
  | "cloned"
  | "branch_navigated"
  | "deleted";

export interface PiSessionIdentityMetadata {
  readonly previousNativeSessionId: string;
  readonly nativeSessionId: string;
  readonly nativeSessionName: string;
  readonly nativeSessionFileDisplay: string;
  readonly activeLeafId: string;
  readonly change: PiSessionIdentityChangeMetadata;
}

export type PiSessionEntryKindMetadata =
  | "unknown"
  | "session"
  | "message"
  | "model_change"
  | "thinking_level_change"
  | "compaction"
  | "branch_summary"
  | "custom_message"
  | "label";

export interface PiSessionTreeNodeMetadata {
  readonly entryId: string;
  readonly parentId: string;
  readonly kind: PiSessionEntryKindMetadata;
  readonly role: string;
  readonly textPreview: string;
  readonly branchSummary: string;
  readonly createdAt?: UnixMillis;
  readonly active: boolean;
  readonly children: readonly PiSessionTreeNodeMetadata[];
}

export interface PiSessionTreeMetadata {
  readonly nativeSessionId: string;
  readonly activeLeafId: string;
  readonly roots: readonly PiSessionTreeNodeMetadata[];
}

export type PiCommandSourceMetadata = "unknown" | "extension" | "prompt" | "skill";
export type PiResourceScopeMetadata = "unknown" | "user" | "global" | "project" | "managed";

export interface PiSlashCommandMetadata {
  readonly name: string;
  readonly description: string;
  readonly source: PiCommandSourceMetadata;
  readonly sourceInfo: {
    readonly resourceId: string;
    readonly scope: PiResourceScopeMetadata;
    readonly sourceDisplay: string;
    readonly packageName: string;
  };
}

export interface PiCommandCatalogMetadata {
  readonly commands: readonly PiSlashCommandMetadata[];
}

export type PiExtensionUiMetadata = {
  readonly requestId: string;
  readonly extensionId: string;
} & (
  | { readonly effect: { readonly case: "notify"; readonly value: { readonly message: string; readonly kind: "unknown" | "info" | "warning" | "error" } } }
  | { readonly effect: { readonly case: "status"; readonly value: { readonly statusKey: string; readonly statusText?: string } } }
  | { readonly effect: { readonly case: "widget"; readonly value: { readonly widgetKey: string; readonly lines: readonly string[]; readonly placement: "unknown" | "above_editor" | "below_editor"; readonly removed: boolean } } }
  | { readonly effect: { readonly case: "title"; readonly value: { readonly title: string } } }
  | { readonly effect: { readonly case: "editorText"; readonly value: { readonly text: string } } }
);

export type PiResourceKindMetadata = "unknown" | "extension" | "skill" | "prompt_template" | "package";
export type PiResourceStateMetadata = "unknown" | "discovered" | "awaiting_approval" | "approved" | "installing" | "installed" | "loaded" | "disabled" | "update_available" | "error" | "removed";
export type PiResourceUpdateKindMetadata = "unknown" | "discovered" | "approved" | "installed" | "updated" | "enabled" | "disabled" | "loaded" | "removed" | "failed";

export interface PiManagedResourceMetadata {
  readonly resourceId: string;
  readonly backendId: string;
  readonly targetId: string;
  readonly kind: PiResourceKindMetadata;
  readonly name: string;
  readonly version: string;
  readonly source: {
    readonly scope: PiResourceScopeMetadata;
    readonly sourceDisplay: string;
    readonly canonicalPathFingerprint: string;
    readonly symbolicLinkDetected: boolean;
    readonly specialFileDetected: boolean;
  };
  readonly state: PiResourceStateMetadata;
  readonly enabled: boolean;
  readonly approvedAt?: UnixMillis;
  readonly approvedByConnectionId: string;
  readonly revision: number;
  readonly generation: number;
  readonly updatedAt: UnixMillis;
  readonly discoveredRevision: string;
  readonly error?: PublicError;
}

export interface PiResourceUpdateMetadata {
  readonly resource: PiManagedResourceMetadata;
  readonly updateKind: PiResourceUpdateKindMetadata;
}

export interface PiModelUpdateMetadata {
  readonly previousModel?: PiModelKeyMetadata;
  readonly model?: PiModelKeyMetadata;
  readonly thinkingLevel: string;
  readonly scopedModel: boolean;
  readonly contextWindowTokens: number;
}

/** Bounded, already-sanitized metadata for a Pi event without a richer typed projection. */
export interface PiDiagnosticEventMetadata {
  readonly command: PiRpcCommand;
  readonly nativeEventType: string;
  readonly processExitCode?: number;
  readonly sanitizedStderrExcerpt?: string;
  readonly jsonlLineNumber?: number;
  readonly parseError?: string;
}
