import type {
  ArtifactId,
  AttemptDescriptor,
  AttemptId,
  BackendDescriptor,
  BackendId,
  BlobRef,
  ConnectionId,
  EventEnvelope,
  EventId,
  EventPayload,
  InputDisposition,
  InteractionId,
  InteractionPayload,
  OperationId,
  PiEventMetadata,
  PromptInput,
  PublicError,
  QueueItemDescriptor,
  QueueItemId,
  QueueState,
  RunDescriptor,
  RunId,
  RunState,
  ScheduleId,
  SessionDescriptor,
  SessionAttention,
  SessionId,
  SubagentRunDetail,
  SubagentRunState,
  SubagentTranscriptEntry,
  TargetDescriptor,
  TargetId,
  TurnExecutionOverrides,
  ToolLeaseId,
  UnixMillis
} from "@joko/core";

export interface OperationalStoreOptions {
  readonly now?: () => number;
  readonly idFactory?: () => string;
}

export interface OperationalHistoryMaintenanceCandidate {
  readonly sessionId: string;
  readonly status: "active" | "archived" | "deleted";
  readonly updatedAt: number;
  readonly binding: SessionDescriptor["binding"];
}

export interface OperationalHistoryMaintenanceInspection {
  readonly candidates: readonly OperationalHistoryMaintenanceCandidate[];
  readonly messageCount: number;
  readonly estimatedHistoryBytes: number;
}

export interface ConnectionRecord {
  readonly id: ConnectionId;
  readonly deviceId: string;
  readonly name: string;
  readonly authKeyDigest: string;
  readonly state: "active" | "revoked";
  readonly pairedAt: UnixMillis;
  readonly lastSeenAt?: UnixMillis;
  readonly revokedAt?: UnixMillis;
  readonly revision: bigint;
}

export type DeviceKind = "unspecified" | "web" | "desktop" | "service";

export interface DeviceRecord {
  readonly id: string;
  readonly name: string;
  readonly kind: DeviceKind;
  readonly platform: string;
  readonly appVersion: string;
  readonly state: "active" | "revoked";
  /** Owner opt-in for this Device to accept control from another paired Device. */
  readonly remoteControlEnabled: boolean;
  readonly pairedAt: UnixMillis;
  readonly lastSeenAt?: UnixMillis;
  readonly revokedAt?: UnixMillis;
  readonly revision: bigint;
}

export interface CreateDeviceInput {
  readonly id: string;
  readonly name: string;
  readonly kind?: DeviceKind;
  readonly platform?: string;
  readonly appVersion?: string;
  readonly pairedAt?: UnixMillis;
}

export interface RevokedDeviceResult {
  readonly device: DeviceRecord;
  readonly connections: readonly ConnectionRecord[];
}

export interface PairingRecord {
  readonly id: string;
  readonly codeDigest: string;
  readonly label?: string;
  readonly device?: CreateDeviceInput;
  readonly expiresAt: UnixMillis;
  readonly consumedAt?: UnixMillis;
  readonly consumedConnectionId?: ConnectionId;
  readonly createdAt: UnixMillis;
  readonly revision: bigint;
}

export interface CreatePairingInput {
  readonly id: string;
  readonly codeDigest: string;
  readonly label?: string;
  readonly device?: CreateDeviceInput;
  readonly expiresAt: UnixMillis;
  readonly createdAt?: UnixMillis;
}

export interface ConsumePairingInput {
  readonly pairingId: string;
  readonly codeDigest: string;
  readonly connectionId: ConnectionId;
  readonly connectionName: string;
  readonly device?: CreateDeviceInput;
  readonly authKeyDigest: string;
  readonly consumedAt?: UnixMillis;
}

export interface PrunePairingsOptions {
  /** Delete unused challenges whose expiry is at or before this cutoff. */
  readonly expiredBefore: UnixMillis;
  /** Delete consumed challenges consumed at or before this audit-retention cutoff. */
  readonly consumedBefore: UnixMillis;
}

export interface StoredBackend {
  readonly descriptor: BackendDescriptor;
  readonly createdAt: UnixMillis;
  readonly updatedAt: UnixMillis;
  readonly revision: bigint;
}

/** Durable process-instance generation authority for one stable Backend ID. */
export interface BackendInstanceGenerationAuthority {
  readonly backendId: BackendId;
  readonly adapterKind: string;
  /** Highest generation ever handed to a candidate, including failed candidates. */
  readonly highWaterGeneration: number;
  /** Descriptor generation currently published to readers, if one has been published. */
  readonly currentGeneration?: number;
  readonly createdAt: UnixMillis;
  readonly updatedAt: UnixMillis;
  readonly revision: bigint;
}

export interface BackendInstanceGenerationReservation extends BackendInstanceGenerationAuthority {
  /** Newly reserved candidate generation. It is never returned by a later reservation. */
  readonly generation: number;
  /** Current descriptor generation observed atomically with this reservation. */
  readonly expectedCurrentGeneration?: number;
}

export type BackendDescriptorPublication =
  | {
      readonly status: "published";
      readonly backend: StoredBackend;
      readonly authority: BackendInstanceGenerationAuthority;
    }
  | {
      readonly status: "stale";
      readonly current?: StoredBackend;
      readonly authority: BackendInstanceGenerationAuthority;
    };

export interface StoredTarget {
  readonly descriptor: TargetDescriptor;
  readonly metadata: unknown;
  readonly createdAt: UnixMillis;
  readonly updatedAt: UnixMillis;
  readonly revision: bigint;
}

export interface DeviceControlRelationRecord {
  readonly controllerDeviceId: string;
  readonly targetDeviceId: string;
  readonly outboundEnabled: boolean;
  readonly inboundAllowed: boolean;
  readonly updatedAt: UnixMillis;
  readonly revision: bigint;
}

export const REMOTE_HOST_FAILURE_CODES = [
  "aborted",
  "authentication_failed",
  "connection_failed",
  "connection_timeout",
  "connector_protocol",
  "connector_unavailable",
  "host_key_changed",
  "host_key_conflict",
  "host_key_invalid",
  "host_key_missing",
  "host_key_store_corrupt",
  "host_key_store_missing",
  "host_key_store_unreadable",
  "host_key_store_write_failed"
] as const;

export type RemoteHostFailureCode = (typeof REMOTE_HOST_FAILURE_CODES)[number];
export type RemoteHostSource = "manual" | "ssh_config";
export type RemoteHostStatus = "disconnected" | "connecting" | "authenticating" | "ready" | "failed";
export type RemoteHostAuthenticationMode = "system_agent" | "private_key";

export interface RemoteHostScope {
  readonly ownerId: string;
  readonly targetId: TargetId;
}

export interface RemoteHostTrustPin {
  readonly algorithm: string;
  readonly fingerprint: string;
  readonly pinnedAt: UnixMillis;
}

export interface RemoteHostStatusSnapshot {
  readonly state: RemoteHostStatus;
  readonly changedAt: UnixMillis;
  readonly failure?: {
    readonly code: RemoteHostFailureCode;
    readonly retryable: boolean;
  };
}

export interface RemoteHostRecord extends RemoteHostScope {
  readonly id: string;
  readonly hostname: string;
  readonly port: number;
  readonly user: string;
  readonly source: RemoteHostSource;
  readonly authenticationMode: RemoteHostAuthenticationMode;
  /** Opaque identifier only; credential material belongs in the credential channel. */
  readonly credentialReferenceId?: string;
  readonly trust?: RemoteHostTrustPin;
  readonly status: RemoteHostStatusSnapshot;
  readonly createdAt: UnixMillis;
  readonly updatedAt: UnixMillis;
  readonly revision: bigint;
}

export interface CreateRemoteHostInput extends RemoteHostScope {
  readonly id: string;
  readonly hostname: string;
  readonly port?: number;
  readonly user: string;
  readonly source: RemoteHostSource;
  /** Defaults to private_key when a reference is supplied, otherwise system_agent. */
  readonly authenticationMode?: RemoteHostAuthenticationMode;
  readonly credentialReferenceId?: string;
  readonly createdAt?: UnixMillis;
}

export interface UpdateRemoteHostInput extends RemoteHostScope {
  readonly id: string;
  readonly expectedRevision: bigint;
  readonly hostname?: string;
  readonly port?: number;
  readonly user?: string;
  readonly source?: RemoteHostSource;
  readonly authenticationMode?: RemoteHostAuthenticationMode;
  /** Null explicitly clears the reference; undefined keeps it unchanged. */
  readonly credentialReferenceId?: string | null;
  readonly updatedAt?: UnixMillis;
}

export type UpdateRemoteHostStatusInput = RemoteHostScope & {
  readonly id: string;
  readonly expectedRevision: bigint;
  readonly changedAt?: UnixMillis;
} & (
  | { readonly state: "failed"; readonly failureCode: RemoteHostFailureCode }
  | {
      readonly state: Exclude<RemoteHostStatus, "failed">;
      readonly failureCode?: never;
    }
);

export interface PinRemoteHostTrustInput extends RemoteHostScope {
  readonly id: string;
  readonly expectedRevision: bigint;
  readonly algorithm: string;
  readonly fingerprint: string;
  readonly pinnedAt?: UnixMillis;
}

export interface ClearRemoteHostTrustInput extends RemoteHostScope {
  readonly id: string;
  readonly expectedRevision: bigint;
  readonly clearedAt?: UnixMillis;
}

export interface DeleteRemoteHostInput extends RemoteHostScope {
  readonly id: string;
  readonly expectedRevision: bigint;
}

export function remoteHostFailureIsRetryable(code: RemoteHostFailureCode): boolean {
  return code === "aborted" || code === "connection_failed" ||
    code === "connection_timeout" || code === "connector_unavailable";
}

export interface StoredSession {
  readonly descriptor: SessionDescriptor;
  readonly revision: bigint;
}

export type ObjectiveStatus =
  | "active"
  | "paused"
  | "blocked"
  | "complete"
  | "budget_limited"
  | "usage_limited"
  | "dispatch_unknown";

export interface ObjectiveLimits {
  readonly tokenBudget?: number;
  readonly maximumTurns?: number;
  readonly noProgressTurnLimit?: number;
}

/** Durable autonomous-continuation authority for one product Session. */
export interface ObjectiveRecord extends ObjectiveLimits {
  readonly sessionId: SessionId;
  readonly text: string;
  readonly status: ObjectiveStatus;
  readonly turnsUsed: number;
  readonly tokensUsed: number;
  readonly noProgressTurns: number;
  readonly dispatchRejections: number;
  readonly lastReason?: string;
  /** Semantic lifecycle fence. Every replace/edit/pause/resume advances it. */
  readonly ownerGeneration: number;
  /** Current product Session/native binding epoch. */
  readonly sessionGeneration: number;
  readonly pendingOwnerGeneration?: number;
  readonly pendingOperationId?: OperationId;
  readonly pendingRunId?: RunId;
  readonly pendingAttemptId?: AttemptId;
  readonly pendingQueueItemId?: QueueItemId;
  readonly startedAt: UnixMillis;
  readonly updatedAt: UnixMillis;
  readonly revision: bigint;
}

export interface PutObjectiveInput extends ObjectiveLimits {
  readonly sessionId: SessionId;
  readonly text: string;
  readonly status?: ObjectiveStatus;
  readonly expectedSessionGeneration?: number;
  readonly updatedAt?: UnixMillis;
}

export interface UpdateObjectiveInput {
  readonly sessionId: SessionId;
  readonly expectedRevision: bigint;
  readonly expectedOwnerGeneration: number;
  readonly expectedSessionGeneration?: number;
  readonly text?: string;
  readonly status?: ObjectiveStatus;
  readonly tokenBudget?: number | null;
  readonly maximumTurns?: number | null;
  readonly noProgressTurnLimit?: number | null;
  readonly turnsUsed?: number;
  readonly tokensUsed?: number;
  readonly noProgressTurns?: number;
  readonly dispatchRejections?: number;
  readonly lastReason?: string | null;
  readonly advanceOwnerGeneration?: boolean;
  readonly clearPending?: boolean;
  readonly pending?: {
    readonly ownerGeneration: number;
    readonly operationId: OperationId;
    readonly runId: RunId;
    readonly attemptId: AttemptId;
    readonly queueItemId: QueueItemId;
  };
  readonly updatedAt?: UnixMillis;
}

export type MakerMemoryKind = "user" | "feedback" | "project" | "reference" | "digest";

/** Owner-private memory content. Callers must never copy these fields into Events or diagnostics. */
export interface MakerMemoryEntry {
  readonly id: string;
  readonly targetId: TargetId;
  readonly kind: MakerMemoryKind;
  /** Present only for backend-owned compression digests. */
  readonly backendId?: BackendId;
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly body: string;
  readonly createdAt: UnixMillis;
  readonly updatedAt: UnixMillis;
  readonly revision: bigint;
}

export interface PutMakerMemoryEntryInput {
  readonly id?: string;
  readonly targetId: TargetId;
  readonly kind: MakerMemoryKind;
  /** Required for digest and forbidden for curated memory. */
  readonly backendId?: BackendId;
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly body: string;
  readonly mode?: "create" | "update" | "append";
  readonly updatedAt?: UnixMillis;
}

export interface MakerMemorySearchHit {
  readonly id: string;
  readonly targetId: TargetId;
  readonly kind: MakerMemoryKind;
  readonly title: string;
  readonly description: string;
  readonly snippet: string;
  readonly score: number;
}

export interface SessionAttentionRecord extends SessionAttention {
  readonly sessionId: SessionId;
  readonly revision: bigint;
}

export interface StoredRun {
  readonly descriptor: RunDescriptor;
  readonly revision: bigint;
}

export interface StoredAttempt {
  readonly descriptor: AttemptDescriptor;
  readonly revision: bigint;
}

export interface QueueItemRecord extends QueueItemDescriptor {
  readonly position: number;
  readonly attemptId?: AttemptId;
  readonly body: PromptInput;
  readonly executionOverrides?: TurnExecutionOverrides;
  readonly updatedAt: UnixMillis;
  readonly completedAt?: UnixMillis;
  readonly error?: PublicError;
  readonly editLocked: boolean;
  readonly revision: bigint;
}

export interface QueueControlRecord {
  readonly sessionId: SessionId;
  readonly paused: boolean;
  readonly pauseReason?: string;
  readonly pausedAt?: UnixMillis;
  readonly pausedByConnectionId?: ConnectionId;
  readonly interactionLocked: boolean;
  readonly updatedAt: UnixMillis;
  readonly revision: bigint;
}

export type QueuePlacement =
  | { readonly edge: "first" | "last" }
  | { readonly beforeQueueItemId: QueueItemId }
  | { readonly afterQueueItemId: QueueItemId };

export interface EnqueueInput {
  readonly id: QueueItemId;
  readonly sessionId: SessionId;
  readonly runId: RunId;
  /** Durable execution lineage that the dispatch claim will bind atomically. */
  readonly attemptId: AttemptId;
  readonly operationId: OperationId;
  readonly disposition: InputDisposition;
  readonly body: PromptInput;
  readonly executionOverrides?: TurnExecutionOverrides;
  readonly bodyHash?: string;
  readonly createdAt?: UnixMillis;
}

export interface OperationRecord<T = unknown> {
  readonly id: OperationId;
  readonly connectionId?: ConnectionId;
  readonly kind: string;
  /** Sanitized canonical request body retained so reconnecting clients can inspect the mutation. */
  readonly body: unknown;
  readonly bodyHash: string;
  /**
   * Transactional operations finish in the same SQLite transaction as their
   * mutation. External-effect operations deliberately remain `started` after
   * the durable commit claim until their effect is acknowledged.
   */
  readonly completionMode: "transactional" | "external_effect";
  readonly status: "started" | "completed" | "failed";
  readonly response?: T;
  readonly error?: unknown;
  readonly createdAt: UnixMillis;
  readonly updatedAt: UnixMillis;
  readonly revision: bigint;
}

export interface OperationInput {
  readonly id: OperationId;
  readonly connectionId?: ConnectionId;
  readonly kind: string;
  readonly body: unknown;
  readonly createdAt?: UnixMillis;
}

export interface OperationQuery {
  readonly connectionId?: ConnectionId;
  readonly status?: OperationRecord["status"];
  /** Matches a canonical request/response field whose key ends in `sessionId`. */
  readonly sessionId?: SessionId;
  /** Matches a canonical request/response field whose key ends in `targetId`. */
  readonly targetId?: TargetId;
  readonly limit?: number;
  readonly offset?: number;
}

export interface OperationExecution<T> {
  readonly replayed: boolean;
  readonly value: T;
  readonly operation: OperationRecord<T>;
}

export interface EffectOperationClaim<T> extends OperationExecution<T> {
  /** True only for the caller that durably claimed and must execute the effect. */
  readonly claimed: boolean;
}

/**
 * Result of an external-effect claim whose product mutation is intentionally
 * deferred until the effect has been acknowledged. A fresh claim has no
 * response yet; a completed operation replays its durable response.
 */
export type DeferredEffectOperationClaim<T> =
  | {
      readonly claimed: true;
      readonly replayed: false;
      readonly operation: OperationRecord<T>;
    }
  | {
      readonly claimed: false;
      readonly replayed: true;
      readonly value: T;
      readonly operation: OperationRecord<T>;
    };

export interface AppendEventInput {
  readonly id?: EventId;
  readonly emittedAt?: UnixMillis;
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
  readonly metadata?: {
    readonly namespace: string;
    readonly fields: Readonly<Record<string, string | number | boolean>>;
  };
}

export interface PersistedEvent extends EventEnvelope {
  readonly globalCursor: bigint;
  readonly metadata?: {
    readonly namespace: string;
    readonly fields: Readonly<Record<string, string | number | boolean>>;
  };
}

export interface EventQuery {
  readonly afterCursor?: bigint;
  /** Exclusive upper cursor used by descending history pagination. */
  readonly beforeCursor?: bigint;
  readonly sessionId?: SessionId;
  /** Bounded multi-Session history scope; mutually exclusive with sessionId. */
  readonly sessionIds?: readonly SessionId[];
  readonly targetId?: TargetId;
  readonly emittedFrom?: UnixMillis;
  readonly emittedBefore?: UnixMillis;
  readonly order?: "asc" | "desc";
  readonly limit?: number;
  /** Internal audit/deletion planning only. Public timelines omit tombstones. */
  readonly includeTombstoned?: boolean;
}

export interface StoredSubagentRunProjection {
  readonly run: SubagentRunDetail;
  readonly event: PersistedEvent;
}

export interface ListSubagentRunsInput {
  readonly sessionId: SessionId;
  readonly state?: SubagentRunState;
  readonly pageToken?: string;
  readonly limit?: number;
}

export interface SubagentRunPage {
  readonly runs: readonly SubagentRunDetail[];
  readonly nextPageToken?: string;
  readonly totalSize: number;
  /** Durable high-water cursor that pins every page in this listing. */
  readonly snapshotCursor: bigint;
}

export interface ListSubagentTranscriptInput {
  readonly sessionId: SessionId;
  readonly subagentRunId: string;
  readonly childId?: string;
  readonly pageToken?: string;
  readonly limit?: number;
}

export interface SubagentTranscriptPage {
  readonly entries: readonly SubagentTranscriptEntry[];
  readonly nextPageToken?: string;
  /** Reuse this token after EOF to read entries appended later. */
  readonly tailPageToken: string;
  readonly totalSize: number;
  readonly snapshotCursor: bigint;
}

export interface PendingContextRebuild {
  readonly sessionId: SessionId;
  readonly reason: "message_deletion" | "context_overflow" | "prompt_timeout";
  /** Operation whose deletion or failed dispatch established this boundary. */
  readonly latestDeletionOperationId: OperationId;
  readonly sourceNativeOpaqueRef: string;
  readonly sourceRunId?: RunId;
  readonly sourceQueueItemId?: QueueItemId;
  /** The failed source input is not part of the surviving handoff. */
  readonly sourceInputPending: boolean;
  /** Safe, user-owned source input may be replayed exactly once by the Host. */
  readonly replaySafe: boolean;
  readonly state: "pending" | "running";
  readonly claimToken?: string;
  readonly claimedAt?: UnixMillis;
  readonly createdAt: UnixMillis;
  readonly updatedAt: UnixMillis;
  readonly revision: bigint;
}

export interface ContextRebuildClaim extends PendingContextRebuild {
  readonly state: "running";
  readonly claimToken: string;
  readonly claimedAt: UnixMillis;
}

export type SessionMessageSearchScope =
  | { readonly sessionId: SessionId; readonly targetId?: never }
  | { readonly targetId: TargetId; readonly sessionId?: never }
  | { readonly owner: true; readonly sessionId?: never; readonly targetId?: never };

export interface SessionMessageSearchFilters {
  readonly targetIds?: readonly TargetId[];
  readonly sessionIds?: readonly SessionId[];
  readonly backendIds?: readonly BackendId[];
  readonly sessionStatus?: "active" | "archived";
  readonly sessionActivityFrom?: UnixMillis;
  readonly messageCreatedFrom?: UnixMillis;
  readonly messageCreatedBefore?: UnixMillis;
}

export interface SearchSessionMessagesInput {
  readonly scope: SessionMessageSearchScope;
  readonly query: string;
  readonly filters?: SessionMessageSearchFilters;
  readonly limit?: number;
  readonly pageToken?: string;
  /**
   * Optional real query embedding for hybrid retrieval.
   * Omit it for keyword-only search or when the Provider/vector arm is
   * unavailable; `semanticSkipReason` then makes that fallback explicit.
   */
  readonly semantic?: {
    readonly providerId: string;
    readonly providerGenerationId: string;
    readonly modelId: string;
    readonly queryEmbedding: readonly number[];
    readonly poolLimit?: number;
  };
  /**
   * Pins pagination to the requested semantic generation even when the
   * Provider is temporarily unavailable and this page falls back to FTS.
   */
  readonly retrievalProviderId?: string;
  readonly retrievalProviderGenerationId?: string;
  readonly retrievalModelId?: string;
  readonly semanticSkipReason?: string;
}

export type ValidateSessionMessageSearchInput = Pick<
  SearchSessionMessagesInput,
  "scope" | "query" | "filters" | "limit" | "pageToken" | "retrievalProviderId" |
    "retrievalProviderGenerationId" | "retrievalModelId"
> & { readonly semanticRequested?: boolean };

export interface ValidatedSessionMessageSearch {
  readonly query: string;
  /** False when an existing page token pinned this search to FTS fallback. */
  readonly useSemantic: boolean;
}

export interface SessionMessageSearchRecord {
  readonly sessionId: SessionId;
  readonly targetId: TargetId;
  readonly eventId: EventId;
  readonly timelineItemId: string;
  readonly role: "user" | "assistant";
  readonly kind: "text_message";
  readonly snippet: string;
  readonly createdAt: UnixMillis;
  /** Deterministic query-density score in the inclusive range [0, 1]. */
  readonly score: number;
  /** One-based rank in the FTS arm, absent for vector-only matches. */
  readonly ftsRank?: number;
  /** One-based rank in the vector arm, absent for keyword-only matches. */
  readonly vectorRank?: number;
}

export interface SessionMessageSearchPage {
  readonly matches: readonly SessionMessageSearchRecord[];
  readonly nextPageToken?: string;
  readonly totalSize: number;
  readonly revision: bigint;
  readonly vectorUsed: boolean;
  readonly vectorSkipReason?: string;
  readonly poolCapped: boolean;
}

export interface MessageEmbeddingJob {
  readonly eventCursor: bigint;
  readonly eventId: EventId;
  readonly text: string;
  readonly attempts: number;
  readonly claimToken: string;
}

export interface MessageEmbeddingStatus {
  readonly enabled: boolean;
  readonly vectorAvailable: boolean;
  readonly providerId?: string;
  readonly providerGenerationId?: string;
  readonly modelId: string;
  readonly dimensions: number;
  readonly pendingCount: number;
  readonly runningCount: number;
  readonly doneCount: number;
  readonly failedCount: number;
}

export type EventSubscriber = (event: PersistedEvent) => void | Promise<void>;

export interface InteractionRecord {
  readonly id: InteractionId;
  readonly sessionId: SessionId;
  readonly runId?: RunId;
  readonly attemptId?: AttemptId;
  readonly operationId?: OperationId;
  readonly generation: number;
  readonly kind: InteractionPayload["kind"];
  readonly status: "open" | "resolved" | "dismissed";
  readonly payload: InteractionPayload;
  readonly decision?: unknown;
  readonly dismissalReason?: string;
  readonly createdAt: UnixMillis;
  readonly resolvedAt?: UnixMillis;
  readonly revision: bigint;
}

export interface OpenInteractionInput {
  readonly sessionId: SessionId;
  readonly runId?: RunId;
  readonly attemptId?: AttemptId;
  readonly operationId?: OperationId;
  readonly generation: number;
  readonly payload: InteractionPayload;
  readonly traceId: string;
  readonly createdAt?: UnixMillis;
}

export type ScheduleKind = "one_shot" | "cron" | "interval" | "manual";
export type ScheduleSessionMode = "fresh" | "persistent" | "bound";

export interface ScheduleRecord {
  readonly id: ScheduleId;
  readonly backendId: BackendId;
  readonly targetId: TargetId;
  readonly sessionMode: ScheduleSessionMode;
  /** Bound Session, or the current durable Session for persistent mode. */
  readonly sessionId?: SessionId;
  readonly name: string;
  readonly kind: ScheduleKind;
  readonly expression?: string;
  /** Durable phase origin for interval recurrences. Required when kind is interval. */
  readonly anchorAt?: UnixMillis;
  readonly timezone: string;
  readonly enabled: boolean;
  readonly prompt: PromptInput;
  readonly executionSnapshot: unknown;
  readonly overlapPolicy: "queue" | "skip";
  readonly misfirePolicy: "run_once" | "skip";
  readonly nextRunAt?: UnixMillis;
  readonly lastRunAt?: UnixMillis;
  readonly createdAt: UnixMillis;
  readonly updatedAt: UnixMillis;
  readonly revision: bigint;
}

export interface UpsertScheduleInput extends Omit<ScheduleRecord, "createdAt" | "updatedAt" | "revision" | "lastRunAt"> {
  readonly lastRunAt?: UnixMillis;
  readonly expectedRevision?: bigint;
  readonly now?: UnixMillis;
}

export interface ScheduleRunRecord {
  readonly id: bigint;
  readonly scheduleId: ScheduleId;
  readonly runId: RunId;
  /** Concrete product Session used for this occurrence, absent when a pre-run gate stopped before task creation. */
  readonly sessionId?: SessionId;
  readonly firedAt: UnixMillis;
  readonly finishedAt?: UnixMillis;
  readonly status: string;
  readonly detail?: unknown;
  /** User acknowledgement time for a terminal occurrence. */
  readonly readAt?: UnixMillis;
  readonly revision: bigint;
}

export type ScheduleDeletionDisposition = "keep" | "archive" | "delete";

export interface ScheduleDeletionCleanupFailure {
  readonly sessionId: SessionId;
  readonly message: string;
}

/** Durable cleanup manifest captured before a Schedule and its history are removed. */
export interface ScheduleDeletionCleanupRecord {
  readonly operationId: string;
  readonly scheduleId: ScheduleId;
  readonly disposition: ScheduleDeletionDisposition;
  readonly state: "pending" | "completed";
  readonly generatedSessionIds: readonly SessionId[];
  readonly occurrenceRunIds: readonly RunId[];
  readonly inflightCount: number;
  readonly completedSessionIds: readonly SessionId[];
  readonly failures: readonly ScheduleDeletionCleanupFailure[];
  readonly projectTargetId?: TargetId;
  readonly projectConfigId?: string;
  readonly createdAt: UnixMillis;
  readonly updatedAt: UnixMillis;
  readonly revision: bigint;
}

export type SessionLifecycleCleanupPhase = "close" | "native" | "worktree" | "git_safety";

/** Durable, replayable external-effect ledger for an ordinary task archive/delete. */
export interface SessionLifecycleCleanupRecord {
  readonly operationId: string;
  readonly sessionId: SessionId;
  readonly disposition: "archive" | "delete";
  readonly state: "pending" | "completed";
  readonly deleteNativeSession: boolean;
  readonly deleteArtifacts: boolean;
  readonly releaseWorktree: boolean;
  readonly cleanupGitSafety: boolean;
  readonly closeCompleted: boolean;
  readonly nativeCompleted: boolean;
  readonly worktreeCompleted: boolean;
  readonly gitSafetyCompleted: boolean;
  readonly failure?: string;
  readonly createdAt: UnixMillis;
  readonly updatedAt: UnixMillis;
  readonly revision: bigint;
}

export interface ToolLeaseRecord {
  readonly id: ToolLeaseId;
  readonly toolId: string;
  readonly sessionId: SessionId;
  readonly runId?: RunId;
  readonly generation: number;
  readonly fencingToken: bigint;
  readonly state: "active" | "released" | "revoked" | "expired";
  readonly expiresAt: UnixMillis;
  readonly metadata: unknown;
  readonly createdAt: UnixMillis;
  readonly updatedAt: UnixMillis;
  readonly releasedAt?: UnixMillis;
  readonly revision: bigint;
}

export interface AcquireToolLeaseInput {
  readonly id: ToolLeaseId;
  readonly toolId: string;
  readonly sessionId: SessionId;
  readonly runId?: RunId;
  readonly generation: number;
  readonly expiresAt: UnixMillis;
  readonly metadata?: unknown;
  readonly now?: UnixMillis;
}

export interface ArtifactRecord {
  readonly blob: BlobRef;
  readonly storageKey: string;
  readonly sessionId?: SessionId;
  readonly runId?: RunId;
  readonly metadata: unknown;
  readonly createdAt: UnixMillis;
  readonly deletedAt?: UnixMillis;
  readonly revision: bigint;
}

export interface PutArtifactInput {
  readonly id: ArtifactId;
  readonly sha256: string;
  readonly byteLength: number;
  readonly mimeType: string;
  readonly fileName?: string;
  readonly storageKey: string;
  readonly sessionId?: SessionId;
  readonly runId?: RunId;
  readonly metadata?: unknown;
  readonly createdAt?: UnixMillis;
  readonly purpose?: string;
  readonly traceId?: string;
}

export type SettingScope = "service" | "connection" | "backend" | "target" | "session";

export interface SettingRecord<T = unknown> {
  readonly scopeType: SettingScope;
  readonly scopeId: string;
  readonly key: string;
  readonly value: T;
  readonly updatedAt: UnixMillis;
  readonly revision: bigint;
}

export interface DiagnosticRecord {
  readonly id: string;
  readonly severity: "debug" | "info" | "warning" | "error";
  readonly component: string;
  readonly code: string;
  readonly message: string;
  readonly details: unknown;
  readonly createdAt: UnixMillis;
  readonly revision: bigint;
}

export interface SessionSnapshot {
  readonly revision: bigint;
  readonly globalCursor: bigint;
  readonly eventSequence: bigint;
  readonly backend: StoredBackend;
  readonly target: StoredTarget;
  readonly session: StoredSession;
  readonly runs: readonly StoredRun[];
  readonly attempts: readonly StoredAttempt[];
  readonly queueItems: readonly QueueItemRecord[];
  readonly interactions: readonly InteractionRecord[];
  readonly schedules: readonly ScheduleRecord[];
  readonly artifacts: readonly ArtifactRecord[];
}

export interface OperationalSnapshot {
  readonly revision: bigint;
  readonly globalCursor: bigint;
  readonly devices: readonly DeviceRecord[];
  readonly connections: readonly ConnectionRecord[];
  readonly backends: readonly StoredBackend[];
  readonly targets: readonly StoredTarget[];
  readonly sessions: readonly StoredSession[];
  readonly activeRuns: readonly StoredRun[];
  readonly dueSchedules: readonly ScheduleRecord[];
  readonly openInteractions: readonly InteractionRecord[];
}

/**
 * Content-free durable activity authority used at process-shutdown
 * boundaries. Queued-only input is deliberately excluded because it remains
 * recoverable after restart; dispatch and native work are not.
 */
export interface DurableRuntimeActivitySnapshot {
  readonly run: boolean;
  readonly queueDispatch: boolean;
  readonly interaction: boolean;
  readonly toolLease: boolean;
  readonly backgroundTask: boolean;
  readonly review: boolean;
  readonly operation: boolean;
}

export interface StartupRecoveryResult {
  readonly recoveredQueueItemIds: readonly QueueItemId[];
  readonly affectedRunIds: readonly RunId[];
  readonly recoveredEffectOperationIds: readonly OperationId[];
  readonly recoveredReviewRuns: readonly ReviewRunRecord[];
  readonly revision: bigint;
  readonly events: readonly PersistedEvent[];
}

export const REVIEW_FAILURE_CODES = [
  "no-visible-result",
  "reviewer-closed",
  "cancelled-before-start",
  "interrupted",
  "source-workspace-changed",
  "source-conversation-changed",
  "source-files-changed",
  "artifact-changed",
  "artifact-unavailable",
  "provider-failed"
] as const;
export type ReviewFailureCode = (typeof REVIEW_FAILURE_CODES)[number];
export type ReviewTargetKind = "changes" | "artifacts" | "task" | "mixed";
export type ReviewRunState = "running" | "completed" | "failed";
export type ReviewFreshness = "current" | "stale" | "unavailable";

export interface ReviewEvidenceSealRecord {
  readonly version: 1;
  readonly conversationSha256: string;
  readonly workspaceSha256: string;
  readonly filesSha256: string;
  readonly artifactsSha256: string;
  readonly sealSha256: string;
  readonly createdAt: UnixMillis;
  readonly revision: bigint;
}

export type ScheduleRuntimeOccurrencePhase =
  | "loading"
  | "claiming"
  | "persisting"
  | "running"
  | "queued"
  | "cancelling"
  | "finalizing"
  | "stalled"
  | "recovering";

/** Content-free durable ownership epoch for the active scheduler runtime. */
export interface SchedulerRuntimeOwnerRecord {
  readonly ownerId: string;
  readonly generation: number;
  readonly startedAt: UnixMillis;
  readonly heartbeatAt: UnixMillis;
  readonly leaseExpiresAt: UnixMillis;
  readonly updatedAt: UnixMillis;
  readonly revision: bigint;
}

/** Content-free durable lease for one scheduler dispatch occurrence. */
export interface ScheduleRuntimeOccurrenceRecord {
  readonly runId: RunId;
  readonly scheduleId: ScheduleId;
  readonly source: "automatic" | "run-now";
  readonly executionMode?: "agent" | "script";
  readonly phase: ScheduleRuntimeOccurrencePhase;
  readonly ownerId: string;
  readonly ownerGeneration: number;
  readonly scheduledAt: UnixMillis;
  readonly startedAt: UnixMillis;
  readonly heartbeatAt: UnixMillis;
  readonly lastProgressAt: UnixMillis;
  readonly leaseExpiresAt: UnixMillis;
  readonly stallDetectedAt?: UnixMillis;
  readonly abortRequestedAt?: UnixMillis;
  readonly createdAt: UnixMillis;
  readonly updatedAt: UnixMillis;
  readonly revision: bigint;
}

export interface ReviewAttachmentRecord {
  readonly ordinal: number;
  readonly kind: "file" | "image";
  readonly displayName: string;
  readonly blob: BlobRef;
  readonly revision: bigint;
}

export interface ReviewSourceLeaseRecord {
  readonly reviewRunId: string;
  readonly sourceSessionId: SessionId;
  readonly fencingToken: bigint;
  readonly state: "active" | "released";
  readonly createdAt: UnixMillis;
  readonly releasedAt?: UnixMillis;
  readonly revision: bigint;
}

export interface ReviewRunRecord {
  readonly id: string;
  readonly sourceSessionId: SessionId;
  readonly reviewerSessionId?: SessionId;
  readonly targetKind: ReviewTargetKind;
  readonly state: ReviewRunState;
  readonly freshness: ReviewFreshness;
  readonly freshnessCheckedAt: UnixMillis;
  readonly result?: string;
  readonly failureCode?: ReviewFailureCode;
  readonly createdAt: UnixMillis;
  readonly updatedAt: UnixMillis;
  readonly endedAt?: UnixMillis;
  readonly revision: bigint;
}

export interface ReviewRunBundle {
  readonly run: ReviewRunRecord;
  readonly sourceLease: ReviewSourceLeaseRecord;
  readonly evidenceSeal: ReviewEvidenceSealRecord;
  readonly attachments: readonly ReviewAttachmentRecord[];
}

export interface CreateReviewRunInput {
  readonly id: string;
  readonly sourceSessionId: SessionId;
  readonly targetKind: ReviewTargetKind;
  readonly evidenceSeal: Omit<ReviewEvidenceSealRecord, "createdAt" | "revision">;
  readonly attachments: readonly Omit<ReviewAttachmentRecord, "ordinal" | "revision">[];
  readonly createdAt?: UnixMillis;
  readonly operationId?: OperationId;
  readonly traceId?: string;
}

export interface ListReviewRunsInput {
  readonly sourceSessionId?: SessionId;
  readonly reviewerSessionId?: SessionId;
  readonly state?: ReviewRunState;
  readonly limit?: number;
  readonly offset?: number;
}

export interface AttachReviewSessionInput {
  readonly reviewRunId: string;
  readonly reviewerSessionId: SessionId;
  readonly sourceLeaseFencingToken: bigint;
  readonly expectedRunRevision: bigint;
  readonly at?: UnixMillis;
  readonly operationId?: OperationId;
  readonly traceId?: string;
}

export interface SessionRuntimePolicyRecord {
  readonly sessionId: SessionId;
  readonly reviewRunId: string;
  readonly policy: "review_read_only";
  readonly sourceLeaseFencingToken: bigint;
  readonly createdAt: UnixMillis;
  readonly updatedAt: UnixMillis;
  readonly revision: bigint;
}

export type FinishReviewRunInput = {
  readonly reviewRunId: string;
  readonly sourceLeaseFencingToken: bigint;
  readonly expectedRunRevision: bigint;
  /** Terminal execution and the final evidence observation commit atomically. */
  readonly freshness: ReviewFreshness;
  readonly freshnessCheckedAt?: UnixMillis;
  readonly at?: UnixMillis;
  readonly operationId?: OperationId;
  readonly traceId?: string;
} & (
  | { readonly state: "completed"; readonly result: string }
  | { readonly state: "failed"; readonly failureCode: ReviewFailureCode }
);

export interface ReobserveReviewInput {
  readonly reviewRunId: string;
  readonly expectedRunRevision: bigint;
  readonly freshness: ReviewFreshness;
  readonly checkedAt?: UnixMillis;
  readonly operationId?: OperationId;
  readonly traceId?: string;
}

export interface UpdateRunStateInput {
  readonly runId: RunId;
  readonly state: RunState;
  readonly error?: PublicError;
  readonly startedAt?: UnixMillis;
  readonly endedAt?: UnixMillis;
  readonly activeAttemptId?: AttemptId;
  readonly traceId: string;
  readonly operationId?: OperationId;
  /** A host policy may suppress only a successful terminal attention edge. */
  readonly suppressTerminalAttention?: boolean;
  /** A successful Scheduler run declared no user-visible result and is born read. */
  readonly markScheduleRunRead?: boolean;
}

export interface UpdateQueueStateInput {
  readonly queueItemId: QueueItemId;
  readonly state: QueueState;
  /**
   * Optional current product-generation Attempt used only by the emitted
   * Queue projection. The durable Queue owner remains `attemptId`; this is
   * required when startup recovery observes the exact old dispatch from a new
   * product Session generation.
   */
  readonly projectionAttemptId?: AttemptId;
  readonly attemptId?: AttemptId;
  readonly error?: PublicError;
  readonly at?: UnixMillis;
  readonly traceId: string;
}

export interface StoreHealth {
  readonly schemaVersion: number;
  readonly journalMode: string;
  readonly foreignKeys: boolean;
  readonly revision: bigint;
  readonly globalCursor: bigint;
}

export interface UsageTokenTotals {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly totalTokens: number;
}

export interface UsageCostRates {
  /** USD micros charged for one million tokens in the corresponding class. */
  readonly inputMicrosPerMillion: number;
  readonly outputMicrosPerMillion: number;
  readonly cacheReadMicrosPerMillion?: number;
  readonly cacheWriteMicrosPerMillion?: number;
}

export interface RecordUsageObservationInput extends UsageTokenTotals {
  readonly ownerId: string;
  readonly sessionId: SessionId;
  /** Stable capability-neutral identity for one cumulative usage stream. */
  readonly sourceId: string;
  readonly generation: number;
  readonly backendId: BackendId;
  readonly providerId: string;
  readonly modelId: string;
  readonly measuredAt: UnixMillis;
  /** Cumulative upstream charge when the runtime reports one authoritatively. */
  readonly reportedCostMicros?: number;
  /** True when the reported amount is a subscription/catalog value projection, not billed spend. */
  readonly reportedCostEstimated?: boolean;
  /** Catalog pricing used only for the newly observed token delta. */
  readonly costRates?: UsageCostRates;
  readonly currencyCode?: string;
}

export interface UsageObservationResult extends UsageTokenTotals {
  readonly changed: boolean;
  readonly costMicros: number;
  readonly costComplete: boolean;
  readonly estimated: boolean;
  readonly day: string;
}

export interface UsageLedgerQuery {
  readonly ownerId: string;
  readonly fromDay?: string;
  readonly throughDay?: string;
  readonly backendId?: BackendId;
  readonly providerId?: string;
}

export interface UsageLedgerDailyRecord extends UsageTokenTotals {
  readonly ownerId: string;
  readonly sessionId: SessionId;
  readonly generation: number;
  readonly backendId: BackendId;
  readonly providerId: string;
  readonly modelId: string;
  readonly day: string;
  readonly costMicros: number;
  readonly currencyCode: string;
  readonly costComplete: boolean;
  readonly estimated: boolean;
  readonly firstMeasuredAt: UnixMillis;
  readonly lastMeasuredAt: UnixMillis;
  readonly revision: bigint;
}

export interface UsageLedgerSummary extends UsageTokenTotals {
  readonly costMicros: number;
  readonly currencyCode: string;
  readonly costComplete: boolean;
  readonly estimated: boolean;
  readonly periodStartedAt?: UnixMillis;
  readonly periodEndedAt?: UnixMillis;
  readonly measuredAt?: UnixMillis;
}

export type ModelPriceCurrency = "USD" | "CNY";

export interface ModelPriceOverrideRecord {
  readonly ownerId: string;
  readonly backendId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly currencyCode: ModelPriceCurrency;
  readonly inputCostMicrosPerMillion: number;
  readonly outputCostMicrosPerMillion: number;
  readonly cacheReadCostMicrosPerMillion?: number;
  readonly cacheWriteCostMicrosPerMillion?: number;
  readonly updatedAt: UnixMillis;
  readonly revision: bigint;
}

export interface UpsertModelPriceOverrideInput {
  readonly ownerId: string;
  readonly backendId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly currencyCode: ModelPriceCurrency;
  readonly inputCostMicrosPerMillion: number;
  readonly outputCostMicrosPerMillion: number;
  readonly cacheReadCostMicrosPerMillion?: number;
  readonly cacheWriteCostMicrosPerMillion?: number;
  readonly updatedAt?: UnixMillis;
}

export interface LocalRuntimeOwnerScope {
  readonly ownerId: string;
  readonly runtimeId: string;
  readonly ownerGeneration: number;
}

/** Content-free active-owner epoch for a service-node local runtime. */
export interface LocalRuntimeOwnerRecord extends LocalRuntimeOwnerScope {
  readonly activatedAt: UnixMillis;
  readonly updatedAt: UnixMillis;
  readonly revision: bigint;
}

export interface ActivateLocalRuntimeOwnerInput extends LocalRuntimeOwnerScope {
  readonly activatedAt?: UnixMillis;
}

export type LocalRuntimeInstallationState = "installing" | "installed" | "failed" | "cancelled";

/** Durable install lease. It contains neither the install path nor a download URL. */
export interface LocalRuntimeInstallationRecord extends LocalRuntimeOwnerScope {
  readonly operationId: string;
  readonly state: LocalRuntimeInstallationState;
  readonly version?: string;
  readonly archiveSha256?: string;
  readonly publicErrorCode?: string;
  readonly startedAt: UnixMillis;
  readonly heartbeatAt: UnixMillis;
  readonly leaseExpiresAt: UnixMillis;
  readonly updatedAt: UnixMillis;
  readonly revision: bigint;
}

export interface ClaimLocalRuntimeInstallationInput extends LocalRuntimeOwnerScope {
  readonly operationId: string;
  readonly at?: UnixMillis;
  readonly leaseDurationMs: number;
}

export interface LocalRuntimeInstallationClaim {
  readonly claimed: boolean;
  readonly recovered: boolean;
  readonly record: LocalRuntimeInstallationRecord;
}

export interface HeartbeatLocalRuntimeInstallationInput extends LocalRuntimeOwnerScope {
  readonly operationId: string;
  readonly at?: UnixMillis;
  readonly leaseDurationMs: number;
}

export interface CompleteLocalRuntimeInstallationInput extends LocalRuntimeOwnerScope {
  readonly operationId: string;
  readonly version: string;
  readonly archiveSha256: string;
  readonly at?: UnixMillis;
}

export interface FailLocalRuntimeInstallationInput extends LocalRuntimeOwnerScope {
  readonly operationId: string;
  readonly state: "failed" | "cancelled";
  readonly publicErrorCode: string;
  readonly at?: UnixMillis;
}

/** Resumable pull checkpoint. Digests are content identities, never paths. */
export interface LocalModelPullCheckpointRecord extends LocalRuntimeOwnerScope {
  readonly modelKey: string;
  readonly modelName: string;
  readonly completedBytes?: number;
  readonly totalBytes?: number;
  readonly percent?: number;
  readonly digests: readonly string[];
  readonly updatedAt: UnixMillis;
  readonly revision: bigint;
}

export interface PutLocalModelPullCheckpointInput extends LocalRuntimeOwnerScope {
  readonly modelKey: string;
  readonly modelName: string;
  readonly completedBytes?: number;
  readonly totalBytes?: number;
  readonly percent?: number;
  readonly digests: readonly string[];
  readonly updatedAt?: UnixMillis;
}

/** Non-secret proof that one Provider catalog row is owned by this runtime. */
export interface LocalRuntimeProviderBindingRecord extends LocalRuntimeOwnerScope {
  readonly providerId: string;
  readonly providerVersion: bigint;
  readonly modelIds: readonly string[];
  readonly updatedAt: UnixMillis;
  readonly revision: bigint;
}

export interface PutLocalRuntimeProviderBindingInput extends LocalRuntimeOwnerScope {
  readonly providerId: string;
  readonly providerVersion: bigint;
  readonly modelIds: readonly string[];
  readonly updatedAt?: UnixMillis;
}
