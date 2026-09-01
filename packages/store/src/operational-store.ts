import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import * as sqliteVec from "sqlite-vec";

import type {
  AttemptDescriptor,
  BackendDescriptor,
  Capability,
  EventPayload,
  PromptInput,
  PublicError,
  QueueState,
  RunDescriptor,
  RunState,
  NativeSessionBinding,
  SessionAttentionKind,
  SessionDescriptor,
  SessionWorktreeBinding,
  SubagentRunDetail,
  SubagentRunState,
  SubagentTranscriptEntry,
  TargetDescriptor
} from "@joko/core";
import {
  JokoError,
  NATIVE_HISTORY_BINDING_FINGERPRINT_FIELD,
  NATIVE_HISTORY_REPLACES_TRANSIENT_FIELD,
  nativeHistoryEventContext,
  redactSecrets
} from "@joko/core";

import {
  AsyncTransactionError,
  AuthorizationError,
  InvalidStateTransitionError,
  NotFoundError,
  OperationConflictError,
  OperationInProgressError,
  OperationPreviouslyFailedError,
  PairingError,
  RevisionConflictError,
  StaleGenerationError,
  StoreClosedError,
  StoreError
} from "./errors.js";
import { configureDatabase, initializeDatabase, SCHEMA_VERSION } from "./schema.js";
import {
  assertSafeSettingKey,
  operationBodyHash,
  parseJson,
  serializeJson
} from "./serialization.js";
import {
  remoteHostFailureIsRetryable,
  REMOTE_HOST_FAILURE_CODES,
  REVIEW_FAILURE_CODES
} from "./types.js";
import type {
  AcquireToolLeaseInput,
  AppendEventInput,
  ArtifactRecord,
  ClearRemoteHostTrustInput,
  ConnectionRecord,
  ContextRebuildClaim,
  ConsumePairingInput,
  CreateRemoteHostInput,
  CreateDeviceInput,
  CreatePairingInput,
  DeviceControlRelationRecord,
  DeviceRecord,
  DeleteRemoteHostInput,
  DiagnosticRecord,
  DeferredEffectOperationClaim,
  DurableRuntimeActivitySnapshot,
  EffectOperationClaim,
  EnqueueInput,
  EventQuery,
  EventSubscriber,
  InteractionRecord,
  ListSubagentRunsInput,
  ListSubagentTranscriptInput,
  ActivateLocalRuntimeOwnerInput,
  BackendDescriptorPublication,
  BackendInstanceGenerationAuthority,
  BackendInstanceGenerationReservation,
  ClaimLocalRuntimeInstallationInput,
  CompleteLocalRuntimeInstallationInput,
  FailLocalRuntimeInstallationInput,
  HeartbeatLocalRuntimeInstallationInput,
  LocalModelPullCheckpointRecord,
  LocalRuntimeInstallationClaim,
  LocalRuntimeInstallationRecord,
  LocalRuntimeOwnerRecord,
  LocalRuntimeOwnerScope,
  LocalRuntimeProviderBindingRecord,
  MakerMemoryEntry,
  MakerMemoryKind,
  MakerMemorySearchHit,
  MessageEmbeddingJob,
  MessageEmbeddingStatus,
  ModelPriceOverrideRecord,
  OpenInteractionInput,
  OperationExecution,
  OperationInput,
  OperationQuery,
  OperationRecord,
  ObjectiveRecord,
  ObjectiveStatus,
  OperationalSnapshot,
  OperationalHistoryMaintenanceInspection,
  OperationalStoreOptions,
  PairingRecord,
  PendingContextRebuild,
  PersistedEvent,
  PrunePairingsOptions,
  PutArtifactInput,
  PutObjectiveInput,
  PutMakerMemoryEntryInput,
  PutLocalModelPullCheckpointInput,
  PutLocalRuntimeProviderBindingInput,
  PinRemoteHostTrustInput,
  QueueControlRecord,
  QueueItemRecord,
  QueuePlacement,
  RevokedDeviceResult,
  RemoteHostFailureCode,
  RemoteHostAuthenticationMode,
  RemoteHostRecord,
  RemoteHostSource,
  RemoteHostStatus,
  AttachReviewSessionInput,
  CreateReviewRunInput,
  FinishReviewRunInput,
  ReobserveReviewInput,
  ReviewAttachmentRecord,
  ReviewEvidenceSealRecord,
  ReviewRunBundle,
  ReviewRunRecord,
  ReviewSourceLeaseRecord,
  ScheduleRecord,
  ScheduleDeletionCleanupFailure,
  ScheduleDeletionCleanupRecord,
  ScheduleDeletionDisposition,
  ScheduleRuntimeOccurrencePhase,
  ScheduleRuntimeOccurrenceRecord,
  ScheduleRunRecord,
  SchedulerRuntimeOwnerRecord,
  SearchSessionMessagesInput,
  SessionLifecycleCleanupPhase,
  SessionLifecycleCleanupRecord,
  SessionSnapshot,
  SessionAttentionRecord,
  SessionRuntimePolicyRecord,
  SessionMessageSearchPage,
  SessionMessageSearchRecord,
  SettingRecord,
  SettingScope,
  StartupRecoveryResult,
  StoredAttempt,
  StoredBackend,
  StoredRun,
  StoredSession,
  StoredSubagentRunProjection,
  StoredTarget,
  StoreHealth,
  SubagentRunPage,
  SubagentTranscriptPage,
  ToolLeaseRecord,
  RecordUsageObservationInput,
  UsageLedgerDailyRecord,
  UsageLedgerQuery,
  UsageLedgerSummary,
  UsageObservationResult,
  UpsertModelPriceOverrideInput,
  UpdateRemoteHostInput,
  UpdateRemoteHostStatusInput,
  UpdateQueueStateInput,
  UpdateObjectiveInput,
  UpdateRunStateInput,
  UpsertScheduleInput,
  ValidatedSessionMessageSearch,
  ValidateSessionMessageSearchInput
} from "./types.js";

type Row = Record<string, unknown>;

type TransactionFrame = {
  readonly savepoint?: string;
  readonly events: PersistedEvent[];
  readonly operationChanges: string[];
};

type RunListOptions = {
  readonly sessionId?: string;
  readonly targetId?: string;
  readonly states?: readonly RunState[];
  readonly activeOnly?: boolean;
  readonly includeCleared?: boolean;
  readonly limit?: number;
  readonly offset?: number;
};

type QueueItemListOptions = {
  readonly sessionId?: string;
  readonly targetId?: string;
  readonly states?: readonly QueueState[];
  readonly includeCleared?: boolean;
  readonly limit?: number;
  readonly offset?: number;
};

type InteractionListOptions = {
  readonly sessionId?: string;
  readonly runId?: string;
  readonly kinds?: readonly InteractionRecord["kind"][];
  readonly statuses?: readonly InteractionRecord["status"][];
  readonly status?: InteractionRecord["status"];
  readonly dismissalReason?: string;
  readonly excludeDismissalReason?: string;
  readonly includeCleared?: boolean;
  readonly limit?: number;
  readonly offset?: number;
};

type ArtifactKindFilter = "file" | "image" | "export" | "tool_result" | "diagnostics" | "diff";

type ArtifactListOptions = {
  readonly sessionId?: string;
  readonly runId?: string;
  readonly kind?: ArtifactKindFilter;
  readonly includeDeleted?: boolean;
  readonly includeCleared?: boolean;
  readonly limit?: number;
  readonly offset?: number;
};

const RUN_TRANSITIONS: Readonly<Record<RunState, ReadonlySet<RunState>>> = {
  queued: new Set(["running", "aborted", "failed", "dispatch_unknown"]),
  running: new Set(["waiting", "retrying", "completed", "aborted", "failed", "dispatch_unknown"]),
  waiting: new Set(["running", "retrying", "completed", "aborted", "failed", "dispatch_unknown"]),
  retrying: new Set(["running", "completed", "aborted", "failed", "dispatch_unknown"]),
  dispatch_unknown: new Set(["completed", "aborted", "failed"]),
  completed: new Set(),
  aborted: new Set(),
  failed: new Set()
};

const QUEUE_TRANSITIONS: Readonly<Record<QueueState, ReadonlySet<QueueState>>> = {
  accepted: new Set(["dispatching", "cancelled", "failed"]),
  dispatching: new Set(["backend_accepted", "dispatch_unknown", "cancelled", "failed"]),
  backend_accepted: new Set(["dispatch_unknown", "completed", "cancelled", "failed"]),
  dispatch_unknown: new Set(["completed", "cancelled", "failed"]),
  completed: new Set(),
  cancelled: new Set(),
  failed: new Set()
};

const REMOTE_HOST_STATUS_TRANSITIONS: Readonly<Record<RemoteHostStatus, ReadonlySet<RemoteHostStatus>>> = {
  disconnected: new Set(["connecting"]),
  connecting: new Set(["authenticating", "failed", "disconnected"]),
  authenticating: new Set(["ready", "failed", "disconnected"]),
  ready: new Set(["failed", "disconnected"]),
  failed: new Set(["connecting", "disconnected"])
};

const DEFAULT_MESSAGE_SEARCH_LIMIT = 25;
const MAX_MESSAGE_SEARCH_LIMIT = 100;
const MAX_MESSAGE_SEARCH_QUERY_LENGTH = 256;
const MAX_MESSAGE_SEARCH_PAGE_TOKEN_LENGTH = 2_048;
const DEFAULT_QUEUE_LOCK_TTL_MS = 90_000;
const MIN_QUEUE_LOCK_TTL_MS = 5_000;
const MAX_QUEUE_LOCK_TTL_MS = 300_000;
const MAX_MESSAGE_SEARCH_OFFSET = Number.MAX_SAFE_INTEGER;
const MAX_MESSAGE_SEARCH_TOKENS = 32;
const MESSAGE_SEARCH_SNIPPET_LENGTH = 240;
const MESSAGE_SEARCH_VECTOR_TABLE = "message_search_vectors";
export const MESSAGE_SEARCH_EMBEDDING_MODEL_ID = "voyage/voyage-4";
const MESSAGE_SEARCH_VECTOR_MODEL = MESSAGE_SEARCH_EMBEDDING_MODEL_ID;
const MESSAGE_SEARCH_VECTOR_DIMENSIONS = 1024;
const MESSAGE_SEARCH_VECTOR_POOL = 150;
const MESSAGE_SEARCH_VECTOR_POOL_MAX = 1_000;
const MAX_MESSAGE_SEARCH_FILTER_VALUES = 1_000;
const MESSAGE_SEARCH_RRF_K = 60;
const STORE_SCAN_PAGE_SIZE = 100_000;
const NATIVE_BLANK_RECOVERY_SETTING_KEY = "runtime.native_blank_recovery";

type SqlFilter = {
  readonly where: string;
  readonly params: readonly (string | number)[];
};

function operationSqlFilter(options: OperationQuery): SqlFilter {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (options.connectionId !== undefined) {
    clauses.push("operation.connection_id = ?");
    params.push(options.connectionId);
  }
  if (options.status !== undefined) {
    clauses.push("operation.status = ?");
    params.push(options.status);
  }
  for (const [key, value] of [["sessionId", options.sessionId], ["targetId", options.targetId]] as const) {
    if (value === undefined) continue;
    clauses.push(`(
      EXISTS (
        SELECT 1 FROM json_tree(operation.body_json) AS field
        WHERE CAST(field.key AS TEXT) GLOB '*${key}' AND field.value = ?
      ) OR EXISTS (
        SELECT 1 FROM json_tree(operation.response_json) AS field
        WHERE CAST(field.key AS TEXT) GLOB '*${key}' AND field.value = ?
      )
    )`);
    params.push(value, value);
  }
  return { where: clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`, params };
}

function runSqlFilter(options: RunListOptions): SqlFilter {
  const clauses: string[] = options.includeCleared === true ? [] : [`NOT EXISTS (
    SELECT 1 FROM session_reset_boundaries AS reset
    WHERE reset.session_id = run.session_id
      AND run.rowid <= reset.cleared_through_run_rowid
  )`];
  const params: Array<string | number> = [];
  if (options.sessionId !== undefined) {
    clauses.push("run.session_id = ?");
    params.push(options.sessionId);
  }
  if (options.targetId !== undefined) {
    clauses.push(`EXISTS (
      SELECT 1 FROM product_sessions AS session
      WHERE session.id = run.session_id AND session.target_id = ?
    )`);
    params.push(options.targetId);
  }
  if (options.states !== undefined && options.states.length > 0) {
    clauses.push(`run.state IN (${options.states.map(() => "?").join(", ")})`);
    params.push(...options.states);
  }
  if (options.activeOnly === true) {
    clauses.push("run.state IN ('queued', 'running', 'waiting', 'retrying', 'dispatch_unknown')");
  }
  return { where: clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`, params };
}

function queueItemSqlFilter(options: QueueItemListOptions): SqlFilter {
  const clauses: string[] = options.includeCleared === true ? [] : [`NOT EXISTS (
    SELECT 1 FROM session_reset_boundaries AS reset
    WHERE reset.session_id = item.session_id
      AND item.rowid <= reset.cleared_through_queue_rowid
  )`];
  const params: Array<string | number> = [];
  if (options.sessionId !== undefined) {
    clauses.push("item.session_id = ?");
    params.push(options.sessionId);
  }
  if (options.targetId !== undefined) {
    clauses.push(`EXISTS (
      SELECT 1 FROM product_sessions AS session
      WHERE session.id = item.session_id AND session.target_id = ?
    )`);
    params.push(options.targetId);
  }
  if (options.states !== undefined && options.states.length > 0) {
    clauses.push(`item.state IN (${options.states.map(() => "?").join(", ")})`);
    params.push(...options.states);
  }
  return { where: clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`, params };
}

function interactionSqlFilter(options: InteractionListOptions): SqlFilter {
  const clauses: string[] = [`NOT EXISTS (
    SELECT 1
    FROM events AS opening_event
    JOIN message_event_tombstones AS opening_tombstone
      ON opening_tombstone.event_id = opening_event.id
    WHERE opening_event.session_id = interaction.session_id
      AND json_extract(opening_event.payload_json, '$.payload.type') = 'interaction_opened'
      AND json_extract(opening_event.payload_json, '$.payload.interaction.id') = interaction.id
  )`];
  if (options.includeCleared !== true) clauses.push(`NOT EXISTS (
    SELECT 1 FROM session_reset_boundaries AS reset
    WHERE reset.session_id = interaction.session_id
      AND interaction.rowid <= reset.cleared_through_interaction_rowid
  )`);
  const params: Array<string | number> = [];
  if (options.sessionId !== undefined) {
    clauses.push("interaction.session_id = ?");
    params.push(options.sessionId);
  }
  if (options.runId !== undefined) {
    clauses.push("interaction.run_id = ?");
    params.push(options.runId);
  }
  if (options.kinds !== undefined && options.kinds.length > 0) {
    clauses.push(`interaction.kind IN (${options.kinds.map(() => "?").join(", ")})`);
    params.push(...options.kinds);
  }
  const statuses = options.statuses ?? (options.status === undefined ? undefined : [options.status]);
  if (statuses !== undefined && statuses.length > 0) {
    clauses.push(`interaction.status IN (${statuses.map(() => "?").join(", ")})`);
    params.push(...statuses);
  }
  if (options.dismissalReason !== undefined) {
    clauses.push("interaction.dismissal_reason = ?");
    params.push(options.dismissalReason);
  }
  if (options.excludeDismissalReason !== undefined) {
    clauses.push("(interaction.dismissal_reason IS NULL OR interaction.dismissal_reason <> ?)");
    params.push(options.excludeDismissalReason);
  }
  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

const ARTIFACT_KIND_SQL = `CASE lower(json_extract(artifact.metadata_json, '$.kind'))
  WHEN 'image' THEN 'image'
  WHEN 'export' THEN 'export'
  WHEN 'tool_result' THEN 'tool_result'
  WHEN 'diagnostics' THEN 'diagnostics'
  WHEN 'diff' THEN 'diff'
  WHEN 'file' THEN 'file'
  ELSE CASE WHEN artifact.mime_type LIKE 'image/%' THEN 'image' ELSE 'file' END
END`;

function artifactSqlFilter(options: ArtifactListOptions): SqlFilter {
  const clauses: string[] = options.includeCleared === true ? [] : [`NOT EXISTS (
    SELECT 1 FROM session_reset_boundaries AS reset
    WHERE reset.session_id = artifact.session_id
      AND artifact.rowid <= reset.cleared_through_artifact_rowid
  )`];
  const params: Array<string | number> = [];
  if (options.sessionId !== undefined) {
    clauses.push("artifact.session_id = ?");
    params.push(options.sessionId);
  }
  if (options.runId !== undefined) {
    clauses.push("artifact.run_id = ?");
    params.push(options.runId);
  }
  if (options.kind !== undefined) {
    clauses.push(`${ARTIFACT_KIND_SQL} = ?`);
    params.push(options.kind);
  }
  if (options.includeDeleted !== true) clauses.push("artifact.deleted_at IS NULL");
  return { where: clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`, params };
}

function collectStorePages<T>(read: (offset: number, limit: number) => readonly T[]): T[] {
  const values: T[] = [];
  for (;;) {
    const page = read(values.length, STORE_SCAN_PAGE_SIZE);
    values.push(...page);
    if (page.length < STORE_SCAN_PAGE_SIZE) return values;
  }
}
const MESSAGE_EMBEDDING_MAX_ATTEMPTS = 5;
const MESSAGE_EMBEDDING_LEASE_MS = 60_000;
const DEFAULT_SUBAGENT_PAGE_SIZE = 50;
const MAX_SUBAGENT_RUN_PAGE_SIZE = 100;
const MAX_SUBAGENT_TRANSCRIPT_PAGE_SIZE = 200;
const MAX_SUBAGENT_PAGE_TOKEN_LENGTH = 2_048;

interface MessageSearchCursor {
  readonly v: 1;
  readonly scopeKind: "owner" | "session" | "target";
  readonly scopeId: string;
  readonly queryHash: string;
  /** Empty means the first page used a stable keyword fallback. */
  readonly vectorFingerprint: string;
  readonly highWater: string;
  readonly revision: string;
  readonly offset: number;
}

interface NormalizedMessageSearchScope {
  readonly kind: "owner" | "session" | "target";
  readonly id: string;
}

interface NormalizedMessageSearchFilters {
  readonly targetIds?: readonly string[];
  readonly sessionIds?: readonly string[];
  readonly backendIds?: readonly string[];
  readonly sessionStatus?: "active" | "archived";
  readonly sessionActivityFrom?: number;
  readonly messageCreatedFrom?: number;
  readonly messageCreatedBefore?: number;
}

interface NormalizedMessageSearchSemantic {
  readonly providerId: string;
  readonly providerGenerationId: string;
  readonly modelId: string;
  readonly queryEmbedding: readonly number[];
  readonly poolLimit: number;
}

interface FusedMessageSearchRank {
  readonly identityKey: string;
  readonly eventCursor: bigint;
  readonly score: number;
  readonly ftsRank?: number;
  readonly vectorRank?: number;
}

interface MessageSearchRankCandidate {
  readonly eventCursor: bigint;
  readonly sessionId: string;
  readonly timelineItemId: string;
}

interface NativeMessageSearchVisibility {
  readonly ctes: string;
  readonly params: readonly (string | number | bigint | null)[];
  readonly clause: (eventAlias: string) => string;
}

export class OperationalStore {
  private database: DatabaseSync;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly subscribers = new Set<EventSubscriber>();
  private readonly operationSubscribers = new Set<(operationId: string) => void>();
  private readonly pendingPublications: PersistedEvent[] = [];
  private readonly transactionFrames: TransactionFrame[] = [];
  private activeRevision: bigint | undefined;
  private nextSavepoint = 0;
  private publishing = false;
  private closed = false;
  private messageVectorAvailable: boolean;

  constructor(readonly filePath: string, options: OperationalStoreOptions = {}) {
    if (filePath !== ":memory:" && !filePath.startsWith("file:")) {
      mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
      recoverInterruptedHistoryMaintenance(path.resolve(filePath));
    }
    this.database = new DatabaseSync(filePath, { allowExtension: true });
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;
    let messageVectorAvailable = false;
    try {
      try {
        sqliteVec.load(this.database);
        messageVectorAvailable = true;
      } catch {
        // Vector retrieval is an optional augmentation. Orchestrator must remain
        // available with its redacted FTS index if the native extension cannot
        // be loaded on a host platform.
      } finally {
        this.database.enableLoadExtension(false);
      }
      configureDatabase(this.database);
      initializeDatabase(this.database, this.now());
      if (messageVectorAvailable) {
        const vectorTableExisted = this.database.prepare(
          "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?"
        ).get(MESSAGE_SEARCH_VECTOR_TABLE) !== undefined;
        this.database.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${MESSAGE_SEARCH_VECTOR_TABLE}
          USING vec0(
            event_cursor INTEGER,
            session_id TEXT,
            target_id TEXT,
            provider_id TEXT,
            provider_generation_id TEXT,
            model_id TEXT,
            live INTEGER,
            embedding float[${MESSAGE_SEARCH_VECTOR_DIMENSIONS}] distance_metric=cosine
          )`);
        if (!vectorTableExisted) {
          // The vector index is derived. When the optional extension becomes
          // available, requeue opted-in messages against the current table.
          this.database.exec(`
            UPDATE message_embedding_jobs
            SET status = 'pending', attempts = 0, claimed_at = NULL,
                scheduled_at = 0, error_code = 'VECTOR_INDEX_RECREATED'
            WHERE status = 'done';
            DELETE FROM message_embedding_records;
          `);
        }
      }
    } catch (error) {
      this.database.close();
      this.closed = true;
      throw error;
    }
    this.messageVectorAvailable = messageVectorAvailable;
  }

  close(): void {
    if (this.closed) return;
    if (this.transactionFrames.length !== 0) {
      throw new StoreError("Cannot close the operational store during a transaction.");
    }
    this.closed = true;
    this.subscribers.clear();
    this.operationSubscribers.clear();
    this.database.close();
  }

  inspectHistoryMaintenance(input: {
    readonly olderThan: number;
    readonly includeActiveTasks: boolean;
  }): OperationalHistoryMaintenanceInspection {
    this.assertOpen();
    if (!Number.isSafeInteger(input.olderThan) || input.olderThan < 0) {
      throw new StoreError("History maintenance cutoff is invalid.");
    }
    const rows = this.database.prepare(`
      SELECT session.id,
             CASE WHEN session.deleted_at IS NOT NULL THEN 'deleted'
                  WHEN session.archived = 1 THEN 'archived' ELSE 'active' END AS status,
             session.updated_at, session.native_opaque_ref, session.native_session_id, session.generation,
             (SELECT COUNT(*) FROM events AS event
               WHERE event.session_id = session.id
                 AND json_extract(event.payload_json, '$.payload.type') = 'message_complete') AS message_count,
             (SELECT COALESCE(SUM(
                 length(CAST(event.payload_json AS BLOB))
                 + length(CAST(COALESCE(event.metadata_json, '') AS BLOB))
                 + length(CAST(event.trace_id AS BLOB))
               ), 0) FROM events AS event WHERE event.session_id = session.id) AS event_bytes,
             (SELECT COALESCE(SUM(
                 length(CAST(queue.body_json AS BLOB))
                 + length(CAST(COALESCE(queue.error_json, '') AS BLOB))
               ), 0) FROM queue_items AS queue WHERE queue.session_id = session.id) AS queue_bytes,
             (SELECT COALESCE(SUM(
                 length(CAST(interaction.payload_json AS BLOB))
                 + length(CAST(COALESCE(interaction.decision_json, '') AS BLOB))
               ), 0) FROM interactions AS interaction WHERE interaction.session_id = session.id) AS interaction_bytes
        FROM product_sessions AS session
       WHERE session.updated_at <= ?
         AND (
           session.deleted_at IS NOT NULL
           OR session.archived = 1
           OR (? = 1 AND session.deleted_at IS NULL AND session.archived = 0)
         )
         AND EXISTS (
           SELECT 1 FROM events AS event
            WHERE event.session_id = session.id
              AND json_extract(event.payload_json, '$.payload.type') = 'message_complete'
         )
       ORDER BY session.id
    `).all(input.olderThan, input.includeActiveTasks ? 1 : 0) as Row[];
    const candidates = rows.map((row) => ({
      sessionId: stringValue(row["id"]),
      status: enumValue(row["status"], ["active", "archived", "deleted"] as const),
      updatedAt: numberValue(row["updated_at"]),
      binding: {
        opaqueRef: stringValue(row["native_opaque_ref"]),
        ...optionalString("nativeSessionId", row["native_session_id"]),
        generation: numberValue(row["generation"])
      }
    }));
    const sum = (key: "message_count" | "event_bytes" | "queue_bytes" | "interaction_bytes"): number => {
      const result = rows.reduce((total, row) => total + numberValue(row[key] ?? 0), 0);
      if (!Number.isSafeInteger(result) || result < 0) throw new StoreError("History maintenance size exceeds the safe integer range.");
      return result;
    };
    const estimatedHistoryBytes = sum("event_bytes") + sum("queue_bytes") + sum("interaction_bytes");
    if (!Number.isSafeInteger(estimatedHistoryBytes) || estimatedHistoryBytes < 0) {
      throw new StoreError("History maintenance size exceeds the safe integer range.");
    }
    return {
      candidates,
      messageCount: sum("message_count"),
      estimatedHistoryBytes
    };
  }

  async createHistoryMaintenanceCopy(input: {
    readonly workingPath: string;
    readonly expectedRevision: bigint;
  }): Promise<boolean> {
    this.assertOpen();
    if (this.filePath === ":memory:" || this.filePath.startsWith("file:")) {
      throw new StoreError("History maintenance requires a file-backed operational store.");
    }
    if (this.transactionFrames.length !== 0) {
      throw new StoreError("History maintenance cannot copy the database during a transaction.");
    }
    const paths = historyMaintenancePaths(path.resolve(this.filePath));
    if (path.resolve(input.workingPath) !== paths.work) {
      throw new StoreError("History maintenance working copy is outside the managed database boundary.");
    }
    if (this.readRevision() !== input.expectedRevision) return false;
    rmSync(paths.work, { force: true });
    await backup(this.database, paths.work, { rate: 4_096 });
    if (this.readRevision() === input.expectedRevision) return true;
    rmSync(paths.work, { force: true });
    return false;
  }

  /**
   * Installs a verified maintenance copy without replacing this Store object.
   * The caller must build the copy from the same database and provide the
   * revision observed before that copy began. A revision change rejects the
   * replacement, so no write that raced an online backup can be lost.
   */
  installHistoryMaintenanceCopy(input: {
    readonly workingPath: string;
    readonly expectedRevision: bigint;
    readonly backupEnabled: boolean;
  }): { readonly backupCreated: boolean; readonly backupPath?: string } {
    this.assertOpen();
    if (this.filePath === ":memory:" || this.filePath.startsWith("file:")) {
      throw new StoreError("History maintenance requires a file-backed operational store.");
    }
    if (this.transactionFrames.length !== 0) {
      throw new StoreError("History maintenance cannot replace the database during a transaction.");
    }
    const databasePath = path.resolve(this.filePath);
    const paths = historyMaintenancePaths(databasePath);
    if (path.resolve(input.workingPath) !== paths.work) {
      throw new StoreError("History maintenance working copy is outside the managed database boundary.");
    }
    if (!existsSync(paths.work) || !verifyOperationalDatabaseFile(paths.work)) {
      throw new StoreError("History maintenance working copy failed integrity validation.");
    }
    if (this.readRevision() !== input.expectedRevision) {
      throw new StoreError("Operational data changed while the history maintenance copy was being prepared.");
    }

    this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    if (this.readRevision() !== input.expectedRevision) {
      throw new StoreError("Operational data changed before history maintenance replacement.");
    }

    const marker = {
      version: 1,
      backupEnabled: input.backupEnabled,
      preparedAt: Date.now()
    } as const;
    writeMaintenanceMarker(paths.marker, marker);
    if (input.backupEnabled && existsSync(paths.backup)) {
      rmSync(paths.previousBackup, { force: true });
      renameSync(paths.backup, paths.previousBackup);
    }

    this.database.close();
    let replacementInstalled = false;
    try {
      rmSync(paths.rollback, { force: true });
      renameSync(databasePath, paths.rollback);
      removeSqliteSidecars(databasePath);
      renameSync(paths.work, databasePath);
      replacementInstalled = true;
      this.reopenDatabase();
      verifyOpenOperationalDatabase(this.database);

      if (input.backupEnabled) {
        renameSync(paths.rollback, paths.backup);
        restrictMaintenanceFile(paths.backup);
        rmSync(paths.previousBackup, { force: true });
      } else {
        rmSync(paths.rollback, { force: true });
      }
      rmSync(paths.marker, { force: true });
      restrictMaintenanceFile(databasePath);
      return {
        backupCreated: input.backupEnabled,
        ...(input.backupEnabled ? { backupPath: paths.backup } : {})
      };
    } catch (error) {
      try {
        if (replacementInstalled) {
          try { this.database.close(); } catch { /* The replacement may not have opened. */ }
          removeDatabaseFamily(databasePath);
        }
        if (existsSync(paths.rollback)) renameSync(paths.rollback, databasePath);
        else if (input.backupEnabled && existsSync(paths.backup)) renameSync(paths.backup, databasePath);
        if (input.backupEnabled && existsSync(paths.previousBackup)) {
          rmSync(paths.backup, { force: true });
          renameSync(paths.previousBackup, paths.backup);
        }
        this.reopenDatabase();
        verifyOpenOperationalDatabase(this.database);
        rmSync(paths.marker, { force: true });
      } catch (recoveryError) {
        this.closed = true;
        throw new StoreError("History maintenance replacement failed and the original database could not be restored.", {
          cause: new AggregateError([error, recoveryError], "Database replacement and recovery failed")
        });
      }
      throw new StoreError("History maintenance replacement failed; the original database was restored.", { cause: error });
    }
  }

  health(): StoreHealth {
    this.assertOpen();
    const journal = this.database.prepare("PRAGMA journal_mode").get() as Row;
    const foreignKeys = this.database.prepare("PRAGMA foreign_keys").get() as Row;
    return {
      schemaVersion: SCHEMA_VERSION,
      journalMode: String(journal["journal_mode"] ?? "unknown"),
      foreignKeys: Number(foreignKeys["foreign_keys"] ?? 0) === 1,
      revision: this.readRevision(),
      globalCursor: this.latestEventCursor()
    };
  }

  /**
   * Enabling the semantic index never backfills older messages. The activation
   * trigger enqueues
   * only messages committed after this durable switch becomes active.
   */
  setMessageEmbeddingEnabled(enabled: boolean): MessageEmbeddingStatus {
    this.assertOpen();
    const current = this.database.prepare(
      "SELECT enabled, cutoff_initialized FROM message_embedding_state WHERE singleton = 1"
    ).get() as Row | undefined;
    if (current === undefined) throw new StoreError("Message embedding state is missing.");
    const initializeCutoff = enabled && Number(current["cutoff_initialized"]) !== 1;
    if ((Number(current["enabled"]) === 1) !== enabled || initializeCutoff) {
      this.transaction(() => {
        this.database.prepare(`
          UPDATE message_embedding_state
          SET enabled = ?,
              cutoff_cursor = CASE WHEN ? = 1 AND cutoff_initialized = 0 THEN ? ELSE cutoff_cursor END,
              cutoff_initialized = CASE WHEN ? = 1 THEN 1 ELSE cutoff_initialized END
          WHERE singleton = 1
        `).run(
          enabled ? 1 : 0,
          enabled ? 1 : 0,
          asSqlInteger(this.latestEventCursor()),
          enabled ? 1 : 0
        );
      });
    }
    return this.messageEmbeddingStatus();
  }

  messageEmbeddingStatus(): MessageEmbeddingStatus {
    this.assertOpen();
    const state = this.database.prepare(
      `SELECT enabled, provider_id, provider_generation_id, model_id, dimensions
       FROM message_embedding_state WHERE singleton = 1`
    ).get() as Row | undefined;
    if (state === undefined) throw new StoreError("Message embedding state is missing.");
    const counts = this.database.prepare(`
      SELECT status, COUNT(*) AS count
      FROM message_embedding_jobs
      GROUP BY status
    `).all() as Row[];
    const byStatus = new Map(counts.map((row) => [String(row["status"]), Number(row["count"])]));
    return {
      enabled: Number(state["enabled"]) === 1,
      vectorAvailable: this.messageVectorAvailable,
      ...(typeof state["provider_id"] === "string" && state["provider_id"] !== ""
        ? { providerId: String(state["provider_id"]) }
        : {}),
      ...(typeof state["provider_generation_id"] === "string" && state["provider_generation_id"] !== ""
        ? { providerGenerationId: String(state["provider_generation_id"]) }
        : {}),
      modelId: String(state["model_id"]),
      dimensions: Number(state["dimensions"]),
      pendingCount: byStatus.get("pending") ?? 0,
      runningCount: byStatus.get("running") ?? 0,
      doneCount: byStatus.get("done") ?? 0,
      failedCount: byStatus.get("failed") ?? 0
    };
  }

  bindMessageEmbeddingProvider(providerId: string, providerGenerationId: string): MessageEmbeddingStatus {
    this.assertOpen();
    this.assertDerivedIndexWorkerBoundary();
    const normalizedProviderId = nonBlank(providerId, "Message embedding Provider ID");
    const normalizedGenerationId = nonBlank(
      providerGenerationId,
      "Message embedding Provider generation ID"
    );
    const state = this.database.prepare(
      `SELECT provider_id, provider_generation_id
       FROM message_embedding_state WHERE singleton = 1`
    ).get() as Row | undefined;
    if (state === undefined) throw new StoreError("Message embedding state is missing.");
    const current = typeof state["provider_id"] === "string" && state["provider_id"] !== ""
      ? String(state["provider_id"])
      : undefined;
    if (current !== undefined && current !== normalizedProviderId) {
      throw new StoreError("Message embedding Provider does not match the durable vector generation.");
    }
    const currentGeneration = typeof state["provider_generation_id"] === "string" &&
      state["provider_generation_id"] !== ""
      ? String(state["provider_generation_id"])
      : undefined;
    if (current === undefined || currentGeneration !== normalizedGenerationId) {
      this.transaction(() => {
        if (this.messageVectorAvailable) {
          this.database.prepare(
            `UPDATE ${MESSAGE_SEARCH_VECTOR_TABLE} SET live = 0 WHERE live = 1`
          ).run();
        }
        this.database.prepare("DELETE FROM message_embedding_records").run();
        this.database.prepare(`
          UPDATE message_embedding_jobs
          SET status = 'pending', attempts = 0, scheduled_at = 0,
              claimed_at = NULL, claim_token = NULL,
              error_code = 'PROVIDER_GENERATION_CHANGED'
        `).run();
        this.database.prepare(`
          UPDATE message_embedding_state
          SET provider_id = ?, provider_generation_id = ?, model_id = ?
          WHERE singleton = 1
        `).run(normalizedProviderId, normalizedGenerationId, MESSAGE_SEARCH_VECTOR_MODEL);
      });
    }
    return this.messageEmbeddingStatus();
  }

  /**
   * Pins the upstream model identity actually reported for an embedding batch.
   * Gateways may resolve a stable request alias to a dated model generation;
   * a change invalidates every prior vector even when dimensions are equal.
   */
  reconcileMessageEmbeddingModel(
    providerId: string,
    providerGenerationId: string,
    modelId: string
  ): MessageEmbeddingStatus & { readonly modelChanged: boolean } {
    this.assertOpen();
    this.assertDerivedIndexWorkerBoundary();
    const normalizedProviderId = nonBlank(providerId, "Message embedding Provider ID");
    const normalizedGenerationId = nonBlank(
      providerGenerationId,
      "Message embedding Provider generation ID"
    );
    const normalizedModelId = normalizedEmbeddingModelIdentity(modelId);
    const state = this.database.prepare(`
      SELECT provider_id, provider_generation_id, model_id
      FROM message_embedding_state WHERE singleton = 1
    `).get() as Row | undefined;
    if (state === undefined) throw new StoreError("Message embedding state is missing.");
    if (
      state["provider_id"] !== normalizedProviderId ||
      state["provider_generation_id"] !== normalizedGenerationId
    ) {
      throw new StoreError("Message embedding Provider does not match the durable vector generation.");
    }
    const modelChanged = state["model_id"] !== normalizedModelId;
    if (modelChanged) {
      this.transaction(() => {
        if (this.messageVectorAvailable) {
          this.database.prepare(
            `UPDATE ${MESSAGE_SEARCH_VECTOR_TABLE} SET live = 0 WHERE live = 1`
          ).run();
        }
        this.database.prepare("DELETE FROM message_embedding_records").run();
        this.database.prepare(`
          UPDATE message_embedding_jobs
          SET status = 'pending', attempts = 0, scheduled_at = 0,
              claimed_at = NULL, claim_token = NULL,
              error_code = 'EMBEDDING_MODEL_GENERATION_CHANGED'
        `).run();
        this.database.prepare(`
          UPDATE message_embedding_state SET model_id = ? WHERE singleton = 1
        `).run(normalizedModelId);
      });
    }
    return { ...this.messageEmbeddingStatus(), modelChanged };
  }

  hasMessageEmbeddings(providerId: string, providerGenerationId: string, modelId: string): boolean {
    this.assertOpen();
    if (!this.messageVectorAvailable) return false;
    const normalizedProviderId = nonBlank(providerId, "Message embedding Provider ID");
    const normalizedGenerationId = nonBlank(
      providerGenerationId,
      "Message embedding Provider generation ID"
    );
    const normalizedModelId = normalizedEmbeddingModelIdentity(modelId);
    const row = this.database.prepare(`
      SELECT 1 AS present
      FROM message_embedding_records
      WHERE provider_id = ? AND provider_generation_id = ?
        AND model_id = ? AND dimensions = ?
      LIMIT 1
    `).get(
      normalizedProviderId,
      normalizedGenerationId,
      normalizedModelId,
      MESSAGE_SEARCH_VECTOR_DIMENSIONS
    ) as Row | undefined;
    return row !== undefined;
  }

  recoverMessageEmbeddingJobs(now = this.now()): number {
    this.assertOpen();
    this.assertDerivedIndexWorkerBoundary();
    const result = this.database.prepare(`
      UPDATE message_embedding_jobs
      SET status = 'pending', claimed_at = NULL,
          claim_token = NULL,
          scheduled_at = MIN(scheduled_at, ?), error_code = 'LEASE_EXPIRED'
      WHERE status = 'running' AND (claimed_at IS NULL OR claimed_at <= ?)
    `).run(now, now - MESSAGE_EMBEDDING_LEASE_MS);
    return Number(result.changes);
  }

  pruneUnembeddableMessageEmbeddingJobs(): number {
    this.assertOpen();
    this.assertDerivedIndexWorkerBoundary();
    const result = this.database.prepare(`
      DELETE FROM message_embedding_jobs
      WHERE status IN ('pending', 'running')
        AND NOT EXISTS (
          SELECT 1
          FROM events AS event
          JOIN product_sessions AS session
            ON session.id = event.session_id AND session.deleted_at IS NULL
          JOIN message_search_fts ON message_search_fts.rowid = event.global_cursor
          WHERE event.global_cursor = message_embedding_jobs.event_cursor
            AND length(CAST(message_search_fts.visible_text AS BLOB)) <= ?
        )
    `).run(30 * 1024);
    return Number(result.changes);
  }

  claimMessageEmbeddingJobs(limit = 16, now = this.now()): readonly MessageEmbeddingJob[] {
    this.assertOpen();
    this.assertDerivedIndexWorkerBoundary();
    if (!this.messageVectorAvailable) return [];
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) {
      throw new StoreError("Message embedding claim limit must be between 1 and 64.");
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      // A trigger cannot apply the exact redaction/text projection used by
      // the FTS index. Remove jobs that can never be embedded (blank/non-text,
      // oversized, missing, or soft-deleted) before selecting dispatchable
      // work so the worker cannot spin forever on an unclaimable pending row.
      this.pruneUnembeddableMessageEmbeddingJobs();
      const rows = this.database.prepare(`
        SELECT job.event_cursor, job.attempts, event.id AS event_id,
               message_search_fts.visible_text
        FROM message_embedding_jobs AS job
        JOIN events AS event ON event.global_cursor = job.event_cursor
        JOIN product_sessions AS session
          ON session.id = event.session_id AND session.deleted_at IS NULL
        JOIN message_search_fts ON message_search_fts.rowid = job.event_cursor
        WHERE job.status = 'pending' AND job.scheduled_at <= ?
          AND length(CAST(message_search_fts.visible_text AS BLOB)) <= ?
        ORDER BY job.scheduled_at, job.event_cursor
        LIMIT ?
      `).all(now, 30 * 1024, limit) as Row[];
      const claim = this.database.prepare(`
        UPDATE message_embedding_jobs
        SET status = 'running', attempts = attempts + 1,
            claimed_at = ?, claim_token = ?, error_code = NULL
        WHERE event_cursor = ? AND status = 'pending'
      `);
      const jobs: MessageEmbeddingJob[] = [];
      for (const row of rows) {
        const eventCursor = toBigInt(row["event_cursor"]);
        const claimToken = nonBlank(this.idFactory(), "Message embedding claim token");
        const result = claim.run(now, claimToken, asSqlInteger(eventCursor));
        if (Number(result.changes) !== 1) continue;
        jobs.push({
          eventCursor,
          eventId: String(row["event_id"]),
          text: String(row["visible_text"]),
          attempts: Number(row["attempts"]) + 1,
          claimToken
        });
      }
      this.database.exec("COMMIT");
      return jobs;
    } catch (error) {
      try { this.database.exec("ROLLBACK"); } catch { /* Preserve the claim failure. */ }
      throw error;
    }
  }

  completeMessageEmbeddingJob(
    eventCursor: bigint,
    claimToken: string,
    providerId: string,
    providerGenerationId: string,
    modelId: string,
    embedding: readonly number[],
    embeddedAt = this.now()
  ): void {
    this.assertOpen();
    if (!this.messageVectorAvailable) throw new StoreError("Message vector search is unavailable.");
    const normalizedProviderId = nonBlank(providerId, "Message embedding Provider ID");
    const normalizedGenerationId = nonBlank(
      providerGenerationId,
      "Message embedding Provider generation ID"
    );
    const normalizedClaimToken = nonBlank(claimToken, "Message embedding claim token");
    const normalizedModelId = normalizedEmbeddingModelIdentity(modelId);
    if (embedding.length !== MESSAGE_SEARCH_VECTOR_DIMENSIONS || embedding.some((value) =>
      typeof value !== "number" || !Number.isFinite(value) || !Number.isFinite(Math.fround(value))
    )) {
      throw new StoreError(`Message embedding must contain ${MESSAGE_SEARCH_VECTOR_DIMENSIONS} finite values.`);
    }
    const bytes = new Uint8Array(Float32Array.from(embedding).buffer);
    this.transaction(() => {
      const job = this.database.prepare(
        "SELECT status, claim_token FROM message_embedding_jobs WHERE event_cursor = ?"
      ).get(asSqlInteger(eventCursor)) as Row | undefined;
      if (
        job === undefined || job["status"] !== "running" ||
        job["claim_token"] !== normalizedClaimToken
      ) {
        throw new StoreError("Message embedding job is not running.");
      }
      const source = this.database.prepare(`
        SELECT event.session_id, event.target_id
        FROM events AS event
        JOIN product_sessions AS session
          ON session.id = event.session_id AND session.deleted_at IS NULL
        WHERE event.global_cursor = ?
      `).get(asSqlInteger(eventCursor)) as Row | undefined;
      if (source === undefined) {
        this.database.prepare("DELETE FROM message_embedding_jobs WHERE event_cursor = ?")
          .run(asSqlInteger(eventCursor));
        return;
      }
      const generation = this.database.prepare(
        `SELECT provider_id, provider_generation_id, model_id
         FROM message_embedding_state WHERE singleton = 1`
      ).get() as Row | undefined;
      if (
        generation?.["provider_id"] !== normalizedProviderId ||
        generation["provider_generation_id"] !== normalizedGenerationId ||
        generation["model_id"] !== normalizedModelId
      ) {
        throw new StoreError("Message embedding Provider does not match the durable vector generation.");
      }
      const existingVector = this.database.prepare(
        `SELECT rowid FROM ${MESSAGE_SEARCH_VECTOR_TABLE} WHERE rowid = ?`
      ).get(eventCursor) as Row | undefined;
      if (existingVector === undefined) {
        this.database.prepare(`
          INSERT INTO ${MESSAGE_SEARCH_VECTOR_TABLE}(
            rowid, event_cursor, session_id, target_id, provider_id,
            provider_generation_id, model_id, live, embedding
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          eventCursor,
          eventCursor,
          String(source["session_id"]),
          String(source["target_id"]),
          normalizedProviderId,
          normalizedGenerationId,
          normalizedModelId,
          1n,
          bytes
        );
      } else {
        this.database.prepare(`
          UPDATE ${MESSAGE_SEARCH_VECTOR_TABLE}
          SET event_cursor = ?, session_id = ?, target_id = ?, provider_id = ?,
              provider_generation_id = ?, model_id = ?, live = 1, embedding = ?
          WHERE rowid = ?
        `).run(
          eventCursor,
          String(source["session_id"]),
          String(source["target_id"]),
          normalizedProviderId,
          normalizedGenerationId,
          normalizedModelId,
          bytes,
          eventCursor
        );
      }
      this.database.prepare(`
        INSERT INTO message_embedding_records(
          event_cursor, provider_id, provider_generation_id, model_id, dimensions, embedded_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(event_cursor) DO UPDATE SET
          provider_id = excluded.provider_id,
          provider_generation_id = excluded.provider_generation_id,
          model_id = excluded.model_id,
          dimensions = excluded.dimensions,
          embedded_at = excluded.embedded_at
      `).run(
        asSqlInteger(eventCursor),
        normalizedProviderId,
        normalizedGenerationId,
        normalizedModelId,
        embedding.length,
        embeddedAt
      );
      this.database.prepare(`
        UPDATE message_embedding_jobs
        SET status = 'done', claimed_at = NULL, claim_token = NULL, error_code = NULL
        WHERE event_cursor = ? AND claim_token = ?
      `).run(asSqlInteger(eventCursor), normalizedClaimToken);
    });
  }

  failMessageEmbeddingJob(eventCursor: bigint, claimToken: string, errorCode: string, now = this.now()): void {
    this.assertOpen();
    this.assertDerivedIndexWorkerBoundary();
    const code = normalizeDerivedIndexErrorCode(errorCode);
    const row = this.database.prepare(
      "SELECT status, attempts, claim_token FROM message_embedding_jobs WHERE event_cursor = ?"
    ).get(asSqlInteger(eventCursor)) as Row | undefined;
    if (row === undefined || row["status"] !== "running" || row["claim_token"] !== claimToken) return;
    const attempts = Number(row["attempts"]);
    const terminal = attempts >= MESSAGE_EMBEDDING_MAX_ATTEMPTS;
    const retryAt = now + Math.min(60_000, 1_000 * (2 ** Math.max(0, attempts - 1)));
    this.database.prepare(`
      UPDATE message_embedding_jobs
      SET status = ?, scheduled_at = ?, claimed_at = NULL, claim_token = NULL, error_code = ?
      WHERE event_cursor = ? AND status = 'running' AND claim_token = ?
    `).run(terminal ? "failed" : "pending", retryAt, code, asSqlInteger(eventCursor), claimToken);
  }

  subscribe(subscriber: EventSubscriber): () => void {
    this.assertOpen();
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  /** Commit-ordered wakeups for durable Operation row changes that do not
   * naturally own a product Event (for example recovered cleanup effects). */
  subscribeOperationChanges(subscriber: (operationId: string) => void): () => void {
    this.assertOpen();
    this.operationSubscribers.add(subscriber);
    return () => this.operationSubscribers.delete(subscriber);
  }

  transaction<T>(callback: (store: this) => T): T {
    this.assertOpen();
    const outer = this.transactionFrames.length === 0;
    const savepoint = outer ? undefined : `joko_nested_${++this.nextSavepoint}`;
    try {
      if (outer) {
        this.database.exec("BEGIN IMMEDIATE");
        const revisionRow = this.database.prepare(
          "UPDATE store_meta SET revision = revision + 1 WHERE singleton = 1 RETURNING revision"
        ).get() as Row | undefined;
        if (revisionRow === undefined) {
          throw new StoreError("Operational store revision row is missing.");
        }
        this.activeRevision = toBigInt(revisionRow["revision"]);
      } else {
        this.database.exec(`SAVEPOINT ${savepoint}`);
      }
    } catch (error) {
      if (outer) {
        try {
          this.database.exec("ROLLBACK");
        } catch {
          // Preserve the failure that prevented the transaction from starting.
        }
        this.activeRevision = undefined;
      }
      throw error;
    }

    const frame: TransactionFrame = {
      ...(savepoint === undefined ? {} : { savepoint }),
      events: [],
      operationChanges: []
    };
    this.transactionFrames.push(frame);
    try {
      const result = callback(this);
      if (isPromiseLike(result)) throw new AsyncTransactionError();
      if (savepoint === undefined) {
        this.database.exec("COMMIT");
        this.transactionFrames.pop();
        this.activeRevision = undefined;
        this.publishCommitted(frame.events);
        this.publishCommittedOperationChanges(frame.operationChanges);
      } else {
        this.database.exec(`RELEASE SAVEPOINT ${savepoint}`);
        this.transactionFrames.pop();
        this.currentFrame().events.push(...frame.events);
        this.currentFrame().operationChanges.push(...frame.operationChanges);
      }
      return result;
    } catch (error) {
      if (this.transactionFrames.at(-1) === frame) this.transactionFrames.pop();
      if (savepoint === undefined) {
        try {
          this.database.exec("ROLLBACK");
        } catch {
          // Preserve the callback or commit failure.
        }
        this.activeRevision = undefined;
      } else {
        try {
          this.database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          this.database.exec(`RELEASE SAVEPOINT ${savepoint}`);
        } catch {
          // Preserve the callback or release failure.
        }
      }
      throw error;
    }
  }

  authorizedTransaction<T>(
    connectionId: string,
    authKeyDigest: string,
    callback: (store: this, connection: ConnectionRecord) => T
  ): T {
    return this.transaction((store) => {
      const connection = store.authorizeConnection(connectionId, authKeyDigest);
      return callback(store, connection);
    });
  }

  createConnection(input: {
    readonly id: string;
    readonly deviceId?: string;
    readonly device?: Omit<CreateDeviceInput, "id">;
    readonly name: string;
    readonly authKeyDigest: string;
    readonly pairedAt?: number;
  }): ConnectionRecord {
    return this.write(() => {
      const pairedAt = input.pairedAt ?? this.now();
      const deviceId = input.deviceId ?? input.id;
      const device = this.findDevice(deviceId);
      if (device === undefined) {
        this.createDevice({
          id: deviceId,
          name: input.device?.name ?? input.name,
          ...(input.device?.kind === undefined ? {} : { kind: input.device.kind }),
          ...(input.device?.platform === undefined ? {} : { platform: input.device.platform }),
          ...(input.device?.appVersion === undefined ? {} : { appVersion: input.device.appVersion }),
          pairedAt: input.device?.pairedAt ?? pairedAt
        });
      } else if (device.state !== "active") {
        throw new AuthorizationError("The device has been revoked.");
      }
      this.database.prepare(`
        INSERT INTO connections(id, device_id, name, auth_key_digest, state, paired_at, revision)
        VALUES (?, ?, ?, ?, 'active', ?, ?)
      `).run(input.id, deviceId, nonBlank(input.name, "Connection name"), nonBlank(input.authKeyDigest, "Auth key digest"), pairedAt,
        asSqlInteger(this.requireActiveRevision()));
      return this.getConnection(input.id);
    });
  }

  createDevice(input: CreateDeviceInput): DeviceRecord {
    return this.write(() => {
      const pairedAt = input.pairedAt ?? this.now();
      this.database.prepare(`
        INSERT INTO devices(
          id, name, kind, platform, app_version, state, remote_control_enabled, paired_at, revision
        ) VALUES (?, ?, ?, ?, ?, 'active', 0, ?, ?)
      `).run(
        nonBlank(input.id, "Device id"),
        nonBlank(input.name, "Device name"),
        input.kind ?? "unspecified",
        input.platform ?? "",
        input.appVersion ?? "",
        pairedAt,
        asSqlInteger(this.requireActiveRevision())
      );
      return this.getDevice(input.id);
    });
  }

  getDevice(id: string): DeviceRecord {
    this.assertOpen();
    const row = this.database.prepare("SELECT * FROM devices WHERE id = ?").get(id) as Row | undefined;
    if (row === undefined) throw new NotFoundError("Device", id);
    return deviceFromRow(row);
  }

  findDevice(id: string): DeviceRecord | undefined {
    this.assertOpen();
    const row = this.database.prepare("SELECT * FROM devices WHERE id = ?").get(id) as Row | undefined;
    return row === undefined ? undefined : deviceFromRow(row);
  }

  listDevices(): DeviceRecord[] {
    this.assertOpen();
    return (this.database.prepare("SELECT * FROM devices ORDER BY paired_at, id").all() as Row[]).map(deviceFromRow);
  }

  getConnection(id: string): ConnectionRecord {
    this.assertOpen();
    const row = this.database.prepare("SELECT * FROM connections WHERE id = ?").get(id) as Row | undefined;
    if (row === undefined) throw new NotFoundError("Connection", id);
    return connectionFromRow(row);
  }

  listConnections(): ConnectionRecord[] {
    this.assertOpen();
    return (this.database.prepare("SELECT * FROM connections ORDER BY paired_at, id").all() as Row[])
      .map(connectionFromRow);
  }

  listDeviceConnections(deviceId: string): ConnectionRecord[] {
    this.assertOpen();
    return (this.database.prepare(`
      SELECT * FROM connections WHERE device_id = ? ORDER BY paired_at, id
    `).all(deviceId) as Row[]).map(connectionFromRow);
  }

  findConnectionByAuthKeyDigest(authKeyDigest: string): ConnectionRecord | undefined {
    this.assertOpen();
    const row = this.database.prepare("SELECT * FROM connections WHERE auth_key_digest = ?")
      .get(nonBlank(authKeyDigest, "Auth key digest")) as Row | undefined;
    return row === undefined ? undefined : connectionFromRow(row);
  }

  /**
   * Revalidates the complete connection/device authorization tuple. When
   * `touch` is false this is a pure read suitable for the final fence before a
   * streaming yield.
   */
  authorizeConnection(
    id: string,
    authKeyDigest: string,
    options: { readonly touch?: boolean; readonly seenAt?: number } = {}
  ): ConnectionRecord {
    const verify = (): ConnectionRecord => {
      const row = this.database.prepare(`
        SELECT c.*, d.state AS device_state
        FROM connections c
        JOIN devices d ON d.id = c.device_id
        WHERE c.id = ?
      `).get(id) as Row | undefined;
      if (row === undefined || row["state"] !== "active" || row["device_state"] !== "active" ||
        !constantTimeEqual(stringValue(row["auth_key_digest"]), authKeyDigest)) {
        throw new AuthorizationError("The connection credential is invalid or revoked.");
      }
      return connectionFromRow(row);
    };
    if (options.touch !== true) {
      this.assertOpen();
      return verify();
    }
    return this.transaction(() => {
      const connection = verify();
      const seenAt = options.seenAt ?? this.now();
      const revision = asSqlInteger(this.requireActiveRevision());
      const connectionUpdate = this.database.prepare(`
        UPDATE connections SET last_seen_at = ?, revision = ?
        WHERE id = ? AND state = 'active' AND auth_key_digest = ?
      `).run(seenAt, revision, connection.id, authKeyDigest);
      const deviceUpdate = this.database.prepare(`
        UPDATE devices SET last_seen_at = ?, revision = ?
        WHERE id = ? AND state = 'active'
      `).run(seenAt, revision, connection.deviceId);
      if (connectionUpdate.changes !== 1 || deviceUpdate.changes !== 1) {
        throw new AuthorizationError("The connection credential is invalid or revoked.");
      }
      return this.getConnection(connection.id);
    });
  }

  touchConnection(id: string, seenAt = this.now()): ConnectionRecord {
    return this.write(() => {
      const current = this.getConnection(id);
      const result = this.database.prepare(`
        UPDATE connections SET last_seen_at = ?, revision = ?
        WHERE id = ? AND state = 'active'
      `).run(seenAt, asSqlInteger(this.requireActiveRevision()), id);
      if (result.changes !== 1) {
        const connection = this.getConnection(id);
        if (connection.state !== "active") throw new AuthorizationError("The connection has been revoked.");
      }
      const deviceResult = this.database.prepare(`
        UPDATE devices SET last_seen_at = ?, revision = ?
        WHERE id = ? AND state = 'active'
      `).run(seenAt, asSqlInteger(this.requireActiveRevision()), current.deviceId);
      if (deviceResult.changes !== 1) throw new AuthorizationError("The device has been revoked.");
      return this.getConnection(id);
    });
  }

  revokeConnection(id: string, expectedRevision?: bigint, revokedAt = this.now()): ConnectionRecord {
    return this.write(() => {
      const current = this.getConnection(id);
      if (expectedRevision !== undefined && current.revision !== expectedRevision) {
        throw new RevisionConflictError("Connection", id, expectedRevision, current.revision);
      }
      if (current.state === "revoked") return current;
      this.database.prepare(`
        UPDATE connections
        SET state = 'revoked', revoked_at = ?, revision = ?
        WHERE id = ? AND state = 'active' AND revision = ?
      `).run(
        revokedAt,
        asSqlInteger(this.requireActiveRevision()),
        id,
        asSqlInteger(current.revision)
      );
      const updated = this.getConnection(id);
      if (updated.state !== "revoked") {
        throw new RevisionConflictError("Connection", id, current.revision, updated.revision);
      }
      return updated;
    });
  }

  revokeDevice(id: string, expectedRevision?: bigint, revokedAt = this.now()): RevokedDeviceResult {
    return this.transaction(() => {
      const current = this.getDevice(id);
      if (expectedRevision !== undefined && current.revision !== expectedRevision) {
        throw new RevisionConflictError("Device", id, expectedRevision, current.revision);
      }
      if (current.state === "active") {
        const revision = asSqlInteger(this.requireActiveRevision());
        const result = this.database.prepare(`
          UPDATE devices SET state = 'revoked', revoked_at = ?, revision = ?
          WHERE id = ? AND state = 'active' AND revision = ?
        `).run(revokedAt, revision, id, asSqlInteger(current.revision));
        if (result.changes !== 1) {
          const changed = this.getDevice(id);
          throw new RevisionConflictError("Device", id, current.revision, changed.revision);
        }
        this.database.prepare(`
          UPDATE connections
          SET state = 'revoked', revoked_at = ?, revision = ?
          WHERE device_id = ? AND state = 'active'
        `).run(revokedAt, revision, id);
      }
      return { device: this.getDevice(id), connections: this.listDeviceConnections(id) };
    });
  }

  createPairing(input: CreatePairingInput): PairingRecord {
    return this.write(() => {
      const createdAt = input.createdAt ?? this.now();
      if (input.expiresAt <= createdAt) throw new PairingError("Pairing expiry must be in the future.");
      this.database.prepare(`
        INSERT INTO pairings(
          id, code_digest, label, device_id, device_name, device_kind,
          device_platform, device_app_version, expires_at, created_at, revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id,
        nonBlank(input.codeDigest, "Pairing code digest"),
        input.label ?? null,
        input.device?.id ?? null,
        input.device?.name ?? null,
        input.device === undefined ? null : input.device.kind ?? "unspecified",
        input.device === undefined ? null : input.device.platform ?? "",
        input.device === undefined ? null : input.device.appVersion ?? "",
        input.expiresAt,
        createdAt,
        asSqlInteger(this.requireActiveRevision())
      );
      return this.getPairing(input.id);
    });
  }

  getPairing(id: string): PairingRecord {
    this.assertOpen();
    const row = this.database.prepare("SELECT * FROM pairings WHERE id = ?").get(id) as Row | undefined;
    if (row === undefined) throw new NotFoundError("Pairing", id);
    return pairingFromRow(row);
  }

  listPairings(activeOnly = false): PairingRecord[] {
    this.assertOpen();
    const rows = activeOnly
      ? this.database.prepare(`
          SELECT * FROM pairings
          WHERE consumed_at IS NULL AND expires_at > ? ORDER BY expires_at, id
        `).all(this.now())
      : this.database.prepare("SELECT * FROM pairings ORDER BY created_at DESC, id").all();
    return (rows as Row[]).map(pairingFromRow);
  }

  prunePairings(options: PrunePairingsOptions): number {
    if (!Number.isSafeInteger(options.expiredBefore) || !Number.isSafeInteger(options.consumedBefore)) {
      throw new RangeError("Pairing prune cutoffs must be integer timestamps.");
    }
    return this.write(() => {
      const expired = this.database.prepare(`
        DELETE FROM pairings
        WHERE consumed_at IS NULL AND expires_at <= ?
      `).run(options.expiredBefore);
      const consumed = this.database.prepare(`
        DELETE FROM pairings
        WHERE consumed_at IS NOT NULL
          AND consumed_at <= ?
      `).run(options.consumedBefore);
      return Number(expired.changes) + Number(consumed.changes);
    });
  }

  consumePairing(input: ConsumePairingInput): ConnectionRecord {
    return this.transaction(() => {
      const pairing = this.getPairing(input.pairingId);
      const consumedAt = input.consumedAt ?? this.now();
      if (!constantTimeEqual(pairing.codeDigest, input.codeDigest)) {
        throw new PairingError("Pairing code is invalid.");
      }
      if (pairing.consumedAt !== undefined) throw new PairingError("Pairing was already consumed.");
      if (pairing.expiresAt <= consumedAt) throw new PairingError("Pairing has expired.");

      const connection = this.createConnection({
        id: input.connectionId,
        deviceId: input.device?.id ?? pairing.device?.id,
        ...((input.device ?? pairing.device) === undefined ? {} : { device: input.device ?? pairing.device! }),
        name: input.connectionName,
        authKeyDigest: input.authKeyDigest,
        pairedAt: consumedAt
      });
      const result = this.database.prepare(`
        UPDATE pairings
        SET consumed_at = ?, consumed_connection_id = ?, revision = ?
        WHERE id = ? AND consumed_at IS NULL AND expires_at > ?
      `).run(
        consumedAt,
        input.connectionId,
        asSqlInteger(this.requireActiveRevision()),
        input.pairingId,
        consumedAt
      );
      if (result.changes !== 1) throw new PairingError("Pairing was consumed concurrently.");
      return connection;
    });
  }

  reserveBackendInstanceGeneration(input: {
    readonly backendId: string;
    readonly adapterKind: string;
  }, now = this.now()): BackendInstanceGenerationReservation {
    return this.write(() => {
      const backendId = nonBlank(input.backendId, "Backend ID");
      const adapterKind = normalizedBackendAdapterKind(input.adapterKind);
      let row = this.database.prepare(`
        SELECT * FROM backend_instance_generations WHERE backend_id = ?
      `).get(backendId) as Row | undefined;
      if (row === undefined) {
        this.database.prepare(`
          INSERT INTO backend_instance_generations(
            backend_id, adapter_kind, high_water_generation, current_generation,
            created_at, updated_at, revision
          ) VALUES (?, ?, 0, NULL, ?, ?, ?)
        `).run(
          backendId,
          adapterKind,
          now,
          now,
          asSqlInteger(this.requireActiveRevision())
        );
        row = this.database.prepare(`
          SELECT * FROM backend_instance_generations WHERE backend_id = ?
        `).get(backendId) as Row;
      } else if (stringValue(row["adapter_kind"]) !== adapterKind) {
        throw new StoreError("Backend Adapter kind is immutable for an existing instance identity.");
      }

      const highWaterGeneration = numberValue(row["high_water_generation"]);
      if (!Number.isSafeInteger(highWaterGeneration) || highWaterGeneration >= Number.MAX_SAFE_INTEGER) {
        throw new StoreError(`Backend instance generation is exhausted: ${backendId}`);
      }
      const generation = highWaterGeneration + 1;
      const result = this.database.prepare(`
        UPDATE backend_instance_generations
        SET high_water_generation = ?, updated_at = ?, revision = ?
        WHERE backend_id = ? AND adapter_kind = ? AND high_water_generation = ?
      `).run(
        generation,
        now,
        asSqlInteger(this.requireActiveRevision()),
        backendId,
        adapterKind,
        highWaterGeneration
      );
      if (result.changes !== 1) {
        throw new StoreError("Backend instance generation reservation lost its authority fence.");
      }
      const authority = this.getBackendInstanceGenerationAuthority(backendId);
      const expectedCurrentGeneration = optionalNumber(
        "expectedCurrentGeneration",
        row["current_generation"]
      ).expectedCurrentGeneration;
      return {
        ...authority,
        generation,
        ...(expectedCurrentGeneration === undefined ? {} : { expectedCurrentGeneration })
      };
    });
  }

  getBackendInstanceGenerationAuthority(backendId: string): BackendInstanceGenerationAuthority {
    this.assertOpen();
    const normalizedId = nonBlank(backendId, "Backend ID");
    const row = this.database.prepare(`
      SELECT * FROM backend_instance_generations WHERE backend_id = ?
    `).get(normalizedId) as Row | undefined;
    if (row === undefined) throw new NotFoundError("Backend instance generation authority", normalizedId);
    return backendInstanceGenerationAuthorityFromRow(row);
  }

  /**
   * Publishes a reserved candidate, or refreshes the descriptor already owned
   * by the exact current generation. A stale expected-current fence is a
   * read-only result; callers must dispose the losing candidate.
   */
  publishBackendInstanceDescriptor(input: {
    readonly descriptor: BackendDescriptor;
    readonly expectedCurrentGeneration?: number;
  }, now = this.now()): BackendDescriptorPublication {
    validateBackendDescriptorAuthority(input.descriptor);
    validateOptionalBackendGeneration(input.expectedCurrentGeneration, "expected current Backend generation");
    const observedAuthority = this.getBackendInstanceGenerationAuthority(input.descriptor.id);
    if (observedAuthority.adapterKind !== input.descriptor.adapterKind) {
      throw new StoreError("Backend Adapter kind is immutable for an existing instance identity.");
    }
    const observedCurrent = observedAuthority.currentGeneration === undefined
      ? undefined
      : this.getBackend(input.descriptor.id);
    const refreshingObservedCurrent =
      observedAuthority.currentGeneration === input.descriptor.instanceGeneration;
    const publishingObservedLatestReservation =
      input.descriptor.instanceGeneration === observedAuthority.highWaterGeneration &&
      (observedAuthority.currentGeneration === undefined ||
        input.descriptor.instanceGeneration > observedAuthority.currentGeneration);
    if (
      observedAuthority.currentGeneration !== input.expectedCurrentGeneration ||
      (!refreshingObservedCurrent && !publishingObservedLatestReservation)
    ) {
      return staleBackendDescriptorPublication(observedAuthority, observedCurrent);
    }
    return this.write(() => {
      const descriptor = input.descriptor;
      const authority = this.getBackendInstanceGenerationAuthority(descriptor.id);
      if (authority.adapterKind !== descriptor.adapterKind) {
        throw new StoreError("Backend Adapter kind is immutable for an existing instance identity.");
      }
      const current = authority.currentGeneration === undefined
        ? undefined
        : this.getBackend(descriptor.id);
      if (authority.currentGeneration !== input.expectedCurrentGeneration) {
        return staleBackendDescriptorPublication(authority, current);
      }

      const refreshingCurrent = authority.currentGeneration === descriptor.instanceGeneration;
      const publishingLatestReservation =
        descriptor.instanceGeneration === authority.highWaterGeneration &&
        (authority.currentGeneration === undefined || descriptor.instanceGeneration > authority.currentGeneration);
      if (!refreshingCurrent && !publishingLatestReservation) {
        return staleBackendDescriptorPublication(authority, current);
      }

      const result = this.database.prepare(`
        UPDATE backend_instance_generations
        SET current_generation = ?, updated_at = ?, revision = ?
        WHERE backend_id = ? AND adapter_kind = ? AND current_generation IS ?
      `).run(
        descriptor.instanceGeneration,
        now,
        asSqlInteger(this.requireActiveRevision()),
        descriptor.id,
        descriptor.adapterKind,
        input.expectedCurrentGeneration ?? null
      );
      if (result.changes !== 1) {
        const refreshedAuthority = this.getBackendInstanceGenerationAuthority(descriptor.id);
        const refreshedCurrent = refreshedAuthority.currentGeneration === undefined
          ? undefined
          : this.getBackend(descriptor.id);
        return staleBackendDescriptorPublication(refreshedAuthority, refreshedCurrent);
      }
      writeBackendDescriptorRow(
        this.database,
        descriptor,
        now,
        asSqlInteger(this.requireActiveRevision())
      );
      return {
        status: "published",
        backend: this.getBackend(descriptor.id),
        authority: this.getBackendInstanceGenerationAuthority(descriptor.id)
      };
    });
  }

  refreshBackendInstanceDescriptor(
    descriptor: BackendDescriptor,
    expectedCurrentGeneration: number,
    now = this.now()
  ): BackendDescriptorPublication {
    if (descriptor.instanceGeneration !== expectedCurrentGeneration) {
      throw new StoreError("Backend descriptor refresh must preserve the expected current generation.");
    }
    return this.publishBackendInstanceDescriptor({ descriptor, expectedCurrentGeneration }, now);
  }

  upsertBackend(descriptor: BackendDescriptor, now = this.now()): StoredBackend {
    validateBackendDescriptorAuthority(descriptor);
    return this.write(() => {
      const existing = this.database.prepare(`
        SELECT * FROM backend_instance_generations WHERE backend_id = ?
      `).get(descriptor.id) as Row | undefined;
      if (existing === undefined) {
        this.database.prepare(`
          INSERT INTO backend_instance_generations(
            backend_id, adapter_kind, high_water_generation, current_generation,
            created_at, updated_at, revision
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          descriptor.id,
          descriptor.adapterKind,
          descriptor.instanceGeneration,
          descriptor.instanceGeneration,
          now,
          now,
          asSqlInteger(this.requireActiveRevision())
        );
      } else {
        const existingKind = stringValue(existing["adapter_kind"]);
        const existingCurrent = optionalNumber("currentGeneration", existing["current_generation"]).currentGeneration;
        const highWaterGeneration = numberValue(existing["high_water_generation"]);
        if (existingKind !== descriptor.adapterKind) {
          throw new StoreError("Backend Adapter kind is immutable for an existing instance identity.");
        }
        if (existingCurrent !== undefined && descriptor.instanceGeneration < existingCurrent) {
          throw new StoreError("Backend instance generation cannot move backwards.");
        }
        if (existingCurrent === undefined || descriptor.instanceGeneration !== existingCurrent) {
          throw new StoreError(
            "Backend instance generation changes require a reserved expected-current publication."
          );
        }
        this.database.prepare(`
          UPDATE backend_instance_generations
          SET high_water_generation = ?, current_generation = ?, updated_at = ?, revision = ?
          WHERE backend_id = ? AND adapter_kind = ?
        `).run(
          highWaterGeneration,
          descriptor.instanceGeneration,
          now,
          asSqlInteger(this.requireActiveRevision()),
          descriptor.id,
          descriptor.adapterKind
        );
      }
      writeBackendDescriptorRow(
        this.database,
        descriptor,
        now,
        asSqlInteger(this.requireActiveRevision())
      );
      return this.getBackend(descriptor.id);
    });
  }

  getBackend(id: string): StoredBackend {
    this.assertOpen();
    const row = this.database.prepare("SELECT * FROM backends WHERE id = ?").get(id) as Row | undefined;
    if (row === undefined) throw new NotFoundError("Backend", id);
    return backendFromRow(row);
  }

  listBackends(): StoredBackend[] {
    this.assertOpen();
    return (this.database.prepare("SELECT * FROM backends ORDER BY id").all() as Row[]).map(backendFromRow);
  }

  upsertTarget(descriptor: TargetDescriptor, metadata: unknown = {}, now = this.now()): StoredTarget {
    return this.write(() => {
      this.getBackend(descriptor.backendId);
      const remoteWorkspace = descriptor.remoteWorkspace === undefined
        ? undefined
        : {
            hostId: remoteHostAlias(descriptor.remoteWorkspace.hostId),
            workspaceRoot: remoteWorkspaceRoot(descriptor.remoteWorkspace.workspaceRoot)
          };
      this.database.prepare(`
        INSERT INTO targets(
          id, backend_id, display_name, workspace_root, managed, trusted,
          metadata_json, remote_host_id, remote_workspace_root,
          created_at, updated_at, revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          backend_id = excluded.backend_id,
          display_name = excluded.display_name,
          workspace_root = excluded.workspace_root,
          managed = excluded.managed,
          trusted = excluded.trusted,
          metadata_json = excluded.metadata_json,
          remote_host_id = excluded.remote_host_id,
          remote_workspace_root = excluded.remote_workspace_root,
          updated_at = excluded.updated_at,
          revision = excluded.revision
      `).run(
        descriptor.id,
        descriptor.backendId,
        descriptor.displayName,
        descriptor.workspaceRoot,
        boolInt(descriptor.managed),
        boolInt(descriptor.trusted),
        serializeJson(metadata),
        remoteWorkspace?.hostId ?? null,
        remoteWorkspace?.workspaceRoot ?? null,
        now,
        now,
        asSqlInteger(this.requireActiveRevision())
      );
      return this.getTarget(descriptor.id);
    });
  }

  getTarget(id: string): StoredTarget {
    this.assertOpen();
    const row = this.database.prepare("SELECT * FROM targets WHERE id = ?").get(id) as Row | undefined;
    if (row === undefined) throw new NotFoundError("Target", id);
    return targetFromRow(row);
  }

  listTargets(backendId?: string): StoredTarget[] {
    this.assertOpen();
    const rows = backendId === undefined
      ? this.database.prepare("SELECT * FROM targets ORDER BY display_name, id").all()
      : this.database.prepare("SELECT * FROM targets WHERE backend_id = ? ORDER BY display_name, id").all(backendId);
    return (rows as Row[]).map(targetFromRow);
  }

  renameDevice(id: string, name: string, expectedRevision?: bigint): DeviceRecord {
    return this.write(() => {
      const current = this.getDevice(id);
      if (expectedRevision !== undefined && current.revision !== expectedRevision) {
        throw new RevisionConflictError("Device", id, expectedRevision, current.revision);
      }
      const normalized = nonBlank(name, "Device name");
      if (current.name === normalized) return current;
      const result = this.database.prepare(`
        UPDATE devices SET name = ?, revision = ?
        WHERE id = ? AND revision = ?
      `).run(normalized, asSqlInteger(this.requireActiveRevision()), id, asSqlInteger(current.revision));
      if (result.changes !== 1) {
        const changed = this.getDevice(id);
        throw new RevisionConflictError("Device", id, current.revision, changed.revision);
      }
      return this.getDevice(id);
    });
  }

  setDeviceRemoteControlEnabled(id: string, enabled: boolean, expectedRevision?: bigint): DeviceRecord {
    return this.write(() => {
      const current = this.getDevice(id);
      if (expectedRevision !== undefined && current.revision !== expectedRevision) {
        throw new RevisionConflictError("Device", id, expectedRevision, current.revision);
      }
      if (current.state !== "active") throw new AuthorizationError("The device has been revoked.");
      if (current.remoteControlEnabled === enabled) return current;
      const result = this.database.prepare(`
        UPDATE devices SET remote_control_enabled = ?, revision = ?
        WHERE id = ? AND state = 'active' AND revision = ?
      `).run(enabled ? 1 : 0, asSqlInteger(this.requireActiveRevision()), id, asSqlInteger(current.revision));
      if (result.changes !== 1) {
        const changed = this.getDevice(id);
        throw new RevisionConflictError("Device", id, current.revision, changed.revision);
      }
      return this.getDevice(id);
    });
  }

  getDeviceControlRelation(controllerDeviceId: string, targetDeviceId: string): DeviceControlRelationRecord {
    this.assertOpen();
    if (controllerDeviceId === targetDeviceId) throw new StoreError("A Device cannot control itself through a relation.");
    this.getDevice(controllerDeviceId);
    this.getDevice(targetDeviceId);
    const row = this.database.prepare(`
      SELECT * FROM device_control_relations
      WHERE controller_device_id = ? AND target_device_id = ?
    `).get(controllerDeviceId, targetDeviceId) as Row | undefined;
    return row === undefined ? {
      controllerDeviceId,
      targetDeviceId,
      outboundEnabled: true,
      inboundAllowed: true,
      updatedAt: 0,
      revision: 0n
    } : deviceControlRelationFromRow(row);
  }

  listDeviceControlRelations(deviceId?: string): DeviceControlRelationRecord[] {
    this.assertOpen();
    const rows = deviceId === undefined
      ? this.database.prepare(`
          SELECT * FROM device_control_relations
          ORDER BY controller_device_id, target_device_id
        `).all()
      : this.database.prepare(`
          SELECT * FROM device_control_relations
          WHERE controller_device_id = ? OR target_device_id = ?
          ORDER BY controller_device_id, target_device_id
        `).all(deviceId, deviceId);
    return (rows as Row[]).map(deviceControlRelationFromRow);
  }

  setDeviceControlRelation(input: {
    readonly controllerDeviceId: string;
    readonly targetDeviceId: string;
    readonly outboundEnabled?: boolean;
    readonly inboundAllowed?: boolean;
    readonly expectedRevision?: bigint;
    readonly updatedAt?: number;
  }): DeviceControlRelationRecord {
    return this.write(() => {
      if (input.controllerDeviceId === input.targetDeviceId) {
        throw new StoreError("A Device cannot control itself through a relation.");
      }
      const controller = this.getDevice(input.controllerDeviceId);
      const target = this.getDevice(input.targetDeviceId);
      if (controller.state !== "active" || target.state !== "active") {
        throw new AuthorizationError("Both Devices must remain active.");
      }
      const current = this.getDeviceControlRelation(input.controllerDeviceId, input.targetDeviceId);
      if (input.expectedRevision !== undefined && current.revision !== input.expectedRevision) {
        throw new RevisionConflictError(
          "Device control relation",
          `${input.controllerDeviceId}:${input.targetDeviceId}`,
          input.expectedRevision,
          current.revision
        );
      }
      const outboundEnabled = input.outboundEnabled ?? current.outboundEnabled;
      const inboundAllowed = input.inboundAllowed ?? current.inboundAllowed;
      if (current.revision !== 0n && current.outboundEnabled === outboundEnabled && current.inboundAllowed === inboundAllowed) {
        return current;
      }
      const updatedAt = input.updatedAt ?? this.now();
      const revision = asSqlInteger(this.requireActiveRevision());
      this.database.prepare(`
        INSERT INTO device_control_relations(
          controller_device_id, target_device_id, outbound_enabled, inbound_allowed, updated_at, revision
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(controller_device_id, target_device_id) DO UPDATE SET
          outbound_enabled = excluded.outbound_enabled,
          inbound_allowed = excluded.inbound_allowed,
          updated_at = excluded.updated_at,
          revision = excluded.revision
      `).run(
        input.controllerDeviceId,
        input.targetDeviceId,
        outboundEnabled ? 1 : 0,
        inboundAllowed ? 1 : 0,
        updatedAt,
        revision
      );
      return this.getDeviceControlRelation(input.controllerDeviceId, input.targetDeviceId);
    });
  }

  createRemoteHost(input: CreateRemoteHostInput): RemoteHostRecord {
    return this.write(() => {
      const ownerId = remoteHostIdentity(input.ownerId, "owner id", 256);
      const targetId = remoteHostIdentity(input.targetId, "target id", 256);
      const id = remoteHostAlias(input.id);
      this.getTarget(targetId);
      if (this.findRemoteHost(ownerId, targetId, id) !== undefined) {
        throw new StoreError("Remote Host already exists in this owner and target scope.");
      }
      const hostname = remoteHostHostname(input.hostname);
      const port = remoteHostPort(input.port ?? 22);
      const user = remoteHostUser(input.user);
      const source = remoteHostSource(input.source);
      const credentialReferenceId = input.credentialReferenceId === undefined
        ? undefined
        : remoteHostCredentialReference(input.credentialReferenceId);
      const authenticationMode = input.authenticationMode === undefined
        ? credentialReferenceId === undefined ? "system_agent" : "private_key"
        : remoteHostAuthenticationMode(input.authenticationMode);
      assertRemoteHostAuthentication(authenticationMode, credentialReferenceId);
      const createdAt = remoteHostTimestamp(input.createdAt ?? this.now(), "creation time");
      this.database.prepare(`
        INSERT INTO remote_hosts(
          owner_id, target_id, host_id, hostname, port, username, source,
          authentication_mode, credential_reference_id,
          trust_algorithm, trust_fingerprint, trust_pinned_at,
          status, status_changed_at, failure_code, failure_retryable,
          created_at, updated_at, revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 'disconnected', ?, NULL, NULL, ?, ?, ?)
      `).run(
        ownerId,
        targetId,
        id,
        hostname,
        port,
        user,
        source,
        authenticationMode,
        credentialReferenceId ?? null,
        createdAt,
        createdAt,
        createdAt,
        asSqlInteger(this.requireActiveRevision())
      );
      return this.getRemoteHost(ownerId, targetId, id);
    });
  }

  getRemoteHost(ownerId: string, targetId: string, id: string): RemoteHostRecord {
    const record = this.findRemoteHost(ownerId, targetId, id);
    if (record === undefined) throw new NotFoundError("Remote Host", id);
    return record;
  }

  findRemoteHost(ownerId: string, targetId: string, id: string): RemoteHostRecord | undefined {
    this.assertOpen();
    const owner = remoteHostIdentity(ownerId, "owner id", 256);
    const target = remoteHostIdentity(targetId, "target id", 256);
    const host = remoteHostAlias(id);
    const row = this.database.prepare(`
      SELECT * FROM remote_hosts WHERE owner_id = ? AND target_id = ? AND host_id = ?
    `).get(owner, target, host) as Row | undefined;
    return row === undefined ? undefined : remoteHostFromRow(row);
  }

  listRemoteHosts(ownerId: string, targetId?: string): RemoteHostRecord[] {
    this.assertOpen();
    const owner = remoteHostIdentity(ownerId, "owner id", 256);
    if (targetId === undefined) {
      return (this.database.prepare(`
        SELECT * FROM remote_hosts WHERE owner_id = ? ORDER BY target_id, host_id
      `).all(owner) as Row[]).map(remoteHostFromRow);
    }
    const target = remoteHostIdentity(targetId, "target id", 256);
    return (this.database.prepare(`
      SELECT * FROM remote_hosts WHERE owner_id = ? AND target_id = ? ORDER BY host_id
    `).all(owner, target) as Row[]).map(remoteHostFromRow);
  }

  /** Hydrates only one authenticated owner/target scope after process restart. */
  hydrateRemoteHosts(ownerId: string, targetId: string): RemoteHostRecord[] {
    return this.listRemoteHosts(ownerId, targetId);
  }

  updateRemoteHost(input: UpdateRemoteHostInput): RemoteHostRecord {
    return this.write(() => {
      const current = this.getRemoteHost(input.ownerId, input.targetId, input.id);
      assertRemoteHostRevision(current, input.expectedRevision);
      if (isRemoteHostActive(current.status.state)) {
        throw new StoreError("An active Remote Host cannot change routing or credential metadata.");
      }
      const hostname = input.hostname === undefined ? current.hostname : remoteHostHostname(input.hostname);
      const port = input.port === undefined ? current.port : remoteHostPort(input.port);
      const user = input.user === undefined ? current.user : remoteHostUser(input.user);
      const source = input.source === undefined ? current.source : remoteHostSource(input.source);
      const credentialReferenceId = input.credentialReferenceId === undefined
        ? current.credentialReferenceId
        : input.credentialReferenceId === null
          ? undefined
          : remoteHostCredentialReference(input.credentialReferenceId);
      const authenticationMode = input.authenticationMode === undefined
        ? input.credentialReferenceId === undefined
          ? current.authenticationMode
          : credentialReferenceId === undefined ? "system_agent" : "private_key"
        : remoteHostAuthenticationMode(input.authenticationMode);
      assertRemoteHostAuthentication(authenticationMode, credentialReferenceId);
      if (current.trust !== undefined && (hostname !== current.hostname || port !== current.port)) {
        throw new StoreError("Clear the Remote Host trust pin before changing its endpoint.");
      }
      const updatedAt = remoteHostTimestamp(input.updatedAt ?? this.now(), "update time");
      if (updatedAt < current.updatedAt) throw new StoreError("Remote Host update time cannot move backwards.");
      const result = this.database.prepare(`
        UPDATE remote_hosts SET
          hostname = ?, port = ?, username = ?, source = ?, authentication_mode = ?, credential_reference_id = ?,
          updated_at = ?, revision = ?
        WHERE owner_id = ? AND target_id = ? AND host_id = ? AND revision = ?
      `).run(
        hostname,
        port,
        user,
        source,
        authenticationMode,
        credentialReferenceId ?? null,
        updatedAt,
        asSqlInteger(this.requireActiveRevision()),
        current.ownerId,
        current.targetId,
        current.id,
        asSqlInteger(current.revision)
      );
      if (result.changes !== 1) {
        throw new RevisionConflictError(
          "Remote Host",
          current.id,
          current.revision,
          this.findRemoteHost(current.ownerId, current.targetId, current.id)?.revision ?? 0n
        );
      }
      return this.getRemoteHost(current.ownerId, current.targetId, current.id);
    });
  }

  updateRemoteHostStatus(input: UpdateRemoteHostStatusInput): RemoteHostRecord {
    return this.write(() => {
      const current = this.getRemoteHost(input.ownerId, input.targetId, input.id);
      assertRemoteHostRevision(current, input.expectedRevision);
      const state = remoteHostStatus(input.state);
      if (
        state !== current.status.state &&
        !REMOTE_HOST_STATUS_TRANSITIONS[current.status.state].has(state)
      ) {
        throw new InvalidStateTransitionError("Remote Host", current.status.state, state);
      }
      const changedAt = remoteHostTimestamp(input.changedAt ?? this.now(), "status time");
      if (changedAt < current.status.changedAt) {
        throw new StoreError("Remote Host status time cannot move backwards.");
      }
      let failureCode: RemoteHostFailureCode | undefined;
      if (state === "failed") {
        if (input.failureCode === undefined) {
          throw new StoreError("A failed Remote Host requires a bounded failure code.");
        }
        failureCode = remoteHostFailureCode(input.failureCode);
      }
      const retryable = failureCode === undefined ? undefined : remoteHostFailureIsRetryable(failureCode);
      const updatedAt = Math.max(current.updatedAt, changedAt);
      const result = this.database.prepare(`
        UPDATE remote_hosts SET
          status = ?, status_changed_at = ?, failure_code = ?, failure_retryable = ?,
          updated_at = ?, revision = ?
        WHERE owner_id = ? AND target_id = ? AND host_id = ? AND revision = ?
      `).run(
        state,
        changedAt,
        failureCode ?? null,
        retryable === undefined ? null : boolInt(retryable),
        updatedAt,
        asSqlInteger(this.requireActiveRevision()),
        current.ownerId,
        current.targetId,
        current.id,
        asSqlInteger(current.revision)
      );
      if (result.changes !== 1) {
        throw new RevisionConflictError(
          "Remote Host",
          current.id,
          current.revision,
          this.findRemoteHost(current.ownerId, current.targetId, current.id)?.revision ?? 0n
        );
      }
      return this.getRemoteHost(current.ownerId, current.targetId, current.id);
    });
  }

  pinRemoteHostTrust(input: PinRemoteHostTrustInput): RemoteHostRecord {
    this.assertOpen();
    const algorithm = remoteHostTrustAlgorithm(input.algorithm);
    const fingerprint = remoteHostTrustFingerprint(input.fingerprint);
    const current = this.getRemoteHost(input.ownerId, input.targetId, input.id);
    assertRemoteHostRevision(current, input.expectedRevision);
    if (current.trust !== undefined) {
      if (current.trust.algorithm === algorithm && current.trust.fingerprint === fingerprint) return current;
      throw new StoreError("The Remote Host presented a different trust pin.");
    }
    const pinnedAt = remoteHostTimestamp(input.pinnedAt ?? this.now(), "trust time");
    if (pinnedAt < current.createdAt) {
      throw new StoreError("Remote Host trust time cannot precede its creation time.");
    }
    return this.write(() => {
      const fresh = this.getRemoteHost(input.ownerId, input.targetId, input.id);
      assertRemoteHostRevision(fresh, input.expectedRevision);
      if (fresh.trust !== undefined) throw new RevisionConflictError("Remote Host", fresh.id, input.expectedRevision, fresh.revision);
      const updatedAt = Math.max(fresh.updatedAt, pinnedAt);
      const result = this.database.prepare(`
        UPDATE remote_hosts SET
          trust_algorithm = ?, trust_fingerprint = ?, trust_pinned_at = ?,
          updated_at = ?, revision = ?
        WHERE owner_id = ? AND target_id = ? AND host_id = ?
          AND revision = ? AND trust_algorithm IS NULL
      `).run(
        algorithm,
        fingerprint,
        pinnedAt,
        updatedAt,
        asSqlInteger(this.requireActiveRevision()),
        fresh.ownerId,
        fresh.targetId,
        fresh.id,
        asSqlInteger(fresh.revision)
      );
      if (result.changes !== 1) {
        throw new RevisionConflictError(
          "Remote Host",
          fresh.id,
          fresh.revision,
          this.findRemoteHost(fresh.ownerId, fresh.targetId, fresh.id)?.revision ?? 0n
        );
      }
      return this.getRemoteHost(fresh.ownerId, fresh.targetId, fresh.id);
    });
  }

  clearRemoteHostTrust(input: ClearRemoteHostTrustInput): RemoteHostRecord {
    this.assertOpen();
    const current = this.getRemoteHost(input.ownerId, input.targetId, input.id);
    assertRemoteHostRevision(current, input.expectedRevision);
    if (current.trust === undefined) return current;
    if (isRemoteHostActive(current.status.state)) {
      throw new StoreError("An active Remote Host trust pin cannot be cleared.");
    }
    const clearedAt = remoteHostTimestamp(input.clearedAt ?? this.now(), "trust reset time");
    return this.write(() => {
      const fresh = this.getRemoteHost(input.ownerId, input.targetId, input.id);
      assertRemoteHostRevision(fresh, input.expectedRevision);
      if (fresh.trust === undefined) return fresh;
      if (isRemoteHostActive(fresh.status.state)) {
        throw new StoreError("An active Remote Host trust pin cannot be cleared.");
      }
      const result = this.database.prepare(`
        UPDATE remote_hosts SET
          trust_algorithm = NULL, trust_fingerprint = NULL, trust_pinned_at = NULL,
          updated_at = ?, revision = ?
        WHERE owner_id = ? AND target_id = ? AND host_id = ? AND revision = ?
      `).run(
        Math.max(fresh.updatedAt, clearedAt),
        asSqlInteger(this.requireActiveRevision()),
        fresh.ownerId,
        fresh.targetId,
        fresh.id,
        asSqlInteger(fresh.revision)
      );
      if (result.changes !== 1) {
        throw new RevisionConflictError(
          "Remote Host",
          fresh.id,
          fresh.revision,
          this.findRemoteHost(fresh.ownerId, fresh.targetId, fresh.id)?.revision ?? 0n
        );
      }
      return this.getRemoteHost(fresh.ownerId, fresh.targetId, fresh.id);
    });
  }

  deleteRemoteHost(input: DeleteRemoteHostInput): RemoteHostRecord {
    return this.write(() => {
      const current = this.getRemoteHost(input.ownerId, input.targetId, input.id);
      assertRemoteHostRevision(current, input.expectedRevision);
      if (isRemoteHostActive(current.status.state)) {
        throw new StoreError("An active Remote Host cannot be deleted.");
      }
      const result = this.database.prepare(`
        DELETE FROM remote_hosts
        WHERE owner_id = ? AND target_id = ? AND host_id = ? AND revision = ?
      `).run(current.ownerId, current.targetId, current.id, asSqlInteger(current.revision));
      if (result.changes !== 1) {
        throw new RevisionConflictError(
          "Remote Host",
          current.id,
          current.revision,
          this.findRemoteHost(current.ownerId, current.targetId, current.id)?.revision ?? 0n
        );
      }
      return current;
    });
  }

  createSession(
    descriptor: SessionDescriptor,
    options: { readonly nativeSessionBlank?: boolean } = {}
  ): StoredSession {
    return this.write(() => {
      const target = this.getTarget(descriptor.targetId);
      if (target.descriptor.backendId !== descriptor.backendId) {
        throw new StoreError("Session backend does not match its target backend.");
      }
      const projectId = descriptor.projectId ?? descriptor.targetId;
      this.getTarget(projectId);
      const remoteWorkspace = descriptor.remoteWorkspace === undefined
        ? undefined
        : {
            hostId: remoteHostAlias(descriptor.remoteWorkspace.hostId),
            workspaceRoot: remoteWorkspaceRoot(descriptor.remoteWorkspace.workspaceRoot)
          };
      if (!sameRemoteWorkspace(remoteWorkspace, target.descriptor.remoteWorkspace)) {
        throw new StoreError("Session Remote workspace must match its target at creation time.");
      }
      if ((descriptor.appendSystemPrompt?.length ?? 0) > 8_000) {
        throw new StoreError("Session append system prompt cannot exceed 8,000 characters.");
      }
      if (descriptor.appendSystemPrompt?.includes("\0") === true) {
        throw new StoreError("Session append system prompt cannot contain NUL characters.");
      }
      const automationOrigin = descriptor.automationOrigin === undefined
        ? undefined
        : {
            scheduleId: sessionAutomationIdentity(descriptor.automationOrigin.scheduleId, "Session automation Schedule ID"),
            ...(descriptor.automationOrigin.scheduleName === undefined
              ? {}
              : { scheduleName: sessionAutomationName(descriptor.automationOrigin.scheduleName) }),
            runId: sessionAutomationIdentity(descriptor.automationOrigin.runId, "Session automation Run ID")
          };
      const derivationOrigin = normalizeSessionDerivationOrigin(descriptor.derivationOrigin);
      if (automationOrigin !== undefined) {
        const schedule = this.getSchedule(automationOrigin.scheduleId);
        if (schedule.backendId !== descriptor.backendId || schedule.targetId !== descriptor.targetId) {
          throw new StoreError("Session automation owner does not match its backend and target.");
        }
      }
      if (derivationOrigin !== undefined) {
        if (derivationOrigin.sourceSessionId === descriptor.id) {
          throw new StoreError("A derived Session cannot reference itself as its source.");
        }
        const source = this.getSession(derivationOrigin.sourceSessionId);
        if (
          source.descriptor.backendId !== descriptor.backendId ||
          source.descriptor.targetId !== descriptor.targetId
        ) {
          throw new StoreError("Session derivation source does not match its backend and target.");
        }
        if (derivationOrigin.sourceEventId !== undefined) {
          const sourceMessage = this.findVisibleSessionMessageOrigin({
            sessionId: derivationOrigin.sourceSessionId,
            eventId: derivationOrigin.sourceEventId
          });
          if (sourceMessage?.messageId !== derivationOrigin.sourceMessageId) {
            throw new StoreError("Session derivation message identity is not visible in its source task.");
          }
        }
      }
      this.database.prepare(`
        INSERT INTO product_sessions(
          id, backend_id, target_id, project_id, title, title_source, task_summary,
          summary_source_cursor, summary_updated_at, native_opaque_ref, native_binding_fingerprint, native_session_id,
          generation, pinned, archived, deleted_at, permission_mode, plan_mode,
          provider_id, model_id, effort, fast_mode, append_system_prompt,
          remote_host_id, remote_workspace_root, automation_schedule_id, automation_schedule_name,
          automation_run_id, derivation_kind, derivation_source_session_id,
          derivation_source_message_id, derivation_source_event_id, created_at, updated_at, revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        descriptor.id,
        descriptor.backendId,
        descriptor.targetId,
        projectId,
        descriptor.title,
        descriptor.titleSource ?? (descriptor.title === "New task" ? "draft" : "manual"),
        descriptor.summary ?? null,
        descriptor.summarySourceCursor === undefined ? null : asSqlInteger(descriptor.summarySourceCursor),
        descriptor.summaryUpdatedAt ?? null,
        descriptor.binding.opaqueRef,
        nativeBindingFingerprint(descriptor.binding.opaqueRef),
        descriptor.binding.nativeSessionId ?? null,
        descriptor.binding.generation,
        boolInt(descriptor.pinned),
        boolInt(descriptor.archived),
        descriptor.deletedAt ?? null,
        descriptor.permissionMode,
        boolInt(descriptor.planMode),
        descriptor.providerId ?? null,
        descriptor.modelId ?? null,
        descriptor.effort ?? null,
        boolInt(descriptor.fastMode),
        descriptor.appendSystemPrompt ?? null,
        remoteWorkspace?.hostId ?? null,
        remoteWorkspace?.workspaceRoot ?? null,
        automationOrigin?.scheduleId ?? null,
        automationOrigin?.scheduleName ?? null,
        automationOrigin?.runId ?? null,
        derivationOrigin?.kind ?? null,
        derivationOrigin?.sourceSessionId ?? null,
        derivationOrigin?.sourceMessageId ?? null,
        derivationOrigin?.sourceEventId ?? null,
        descriptor.createdAt,
        descriptor.updatedAt,
        asSqlInteger(this.requireActiveRevision())
      );
      this.database.prepare("INSERT INTO session_event_counters(session_id, last_sequence) VALUES (?, 0)")
        .run(descriptor.id);
      this.database.prepare(`
        INSERT INTO queue_controls(session_id, paused, updated_at, revision)
        VALUES (?, 0, ?, ?)
      `).run(descriptor.id, descriptor.updatedAt, asSqlInteger(this.requireActiveRevision()));
      if (descriptor.worktree !== undefined) {
        const worktree = descriptor.worktree;
        this.database.prepare(`
          INSERT INTO session_worktrees(
            session_id, lease_id, workspace_id, working_path, repository_root,
            branch, source_ref, source_commit, source_strategy, source_refreshed,
            source_remote, state, acquired_at, updated_at, revision
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          descriptor.id,
          worktree.leaseId,
          worktree.workspaceId,
          worktree.path,
          worktree.repositoryRoot,
          worktree.branch,
          worktree.sourceRef,
          worktree.sourceCommit,
          worktree.sourceStrategy,
          boolInt(worktree.sourceRefreshed),
          worktree.sourceRemote ?? null,
          worktree.state,
          worktree.acquiredAt,
          worktree.updatedAt,
          asSqlInteger(this.requireActiveRevision())
        );
      }
      if (options.nativeSessionBlank === true) {
        this.setSetting("session", descriptor.id, NATIVE_BLANK_RECOVERY_SETTING_KEY, true, descriptor.createdAt);
      }
      return this.getSession(descriptor.id);
    });
  }

  /**
   * Fail-closed authority for recreating a fresh native runtime that never
   * reached its first durable input. The private marker is necessary but not
   * sufficient: every retained or cleared Run or Queue item, plus any durable
   * conversation/native-lifecycle evidence, disqualifies recovery. Harmless
   * creation-time observations such as runtime commands remain admissible.
   */
  nativeBlankRecoveryEligible(sessionId: string): boolean {
    this.assertOpen();
    this.getSession(sessionId);
    if (this.findSetting<unknown>("session", sessionId, NATIVE_BLANK_RECOVERY_SETTING_KEY)?.value !== true) {
      return false;
    }
    if (
      this.countRuns({ sessionId, includeCleared: true }) !== 0
      || this.countQueueItems({ sessionId, includeCleared: true }) !== 0
    ) return false;
    const disqualifyingTypes = [
      "text_delta",
      "thinking_delta",
      "message_complete",
      "tool_start",
      "tool_update",
      "tool_result",
      "artifact",
      "workspace_diff",
      "interaction_opened",
      "interaction_resolved",
      "interaction_dismissed",
      "compaction",
      "retry",
      "context_cleared",
      "context_rebuild",
      "message_deleted",
      "session_reset",
      "history_pruned",
      "native_session_changed",
      "background_task",
      "subagent_run",
      "subagent_transcript",
      "error",
      "done"
    ] as const;
    const bindingFingerprintPath = `$.${NATIVE_HISTORY_BINDING_FINGERPRINT_FIELD}`;
    const evidence = this.database.prepare(`
      SELECT 1 AS present
      FROM events
      WHERE session_id = ?
        AND (
          json_extract(payload_json, '$.payload.type') IN (${disqualifyingTypes.map(() => "?").join(", ")})
          OR json_type(payload_json, '$.payload.nativeHistory') IS NOT NULL
          OR json_type(metadata_json, ?) IS NOT NULL
        )
      LIMIT 1
    `).get(sessionId, ...disqualifyingTypes, bindingFingerprintPath) as Row | undefined;
    return evidence === undefined;
  }

  /** Atomically replaces only an exact still-blank native binding. */
  rebindNativeBlankSession(input: {
    readonly sessionId: string;
    readonly expectedRevision: bigint;
    readonly expectedBinding: NativeSessionBinding;
    readonly binding: NativeSessionBinding;
    readonly updatedAt?: number;
  }): StoredSession {
    return this.write(() => {
      const current = this.getSession(input.sessionId);
      if (current.revision !== input.expectedRevision) {
        throw new RevisionConflictError("Session", input.sessionId, input.expectedRevision, current.revision);
      }
      if (
        current.descriptor.binding.opaqueRef !== input.expectedBinding.opaqueRef
        || current.descriptor.binding.nativeSessionId !== input.expectedBinding.nativeSessionId
        || current.descriptor.binding.generation !== input.expectedBinding.generation
      ) {
        throw new StoreError("The blank native Session binding changed before recovery could commit.");
      }
      if (!this.nativeBlankRecoveryEligible(input.sessionId)) {
        throw new StoreError("The native Session is no longer eligible for blank-runtime recovery.");
      }
      return this.updateSession(
        input.sessionId,
        { binding: input.binding },
        input.expectedRevision,
        input.updatedAt ?? this.now()
      );
    });
  }

  findSessionWorktree(sessionId: string): SessionWorktreeBinding | undefined {
    this.assertOpen();
    const row = this.database.prepare(
      "SELECT * FROM session_worktrees WHERE session_id = ?"
    ).get(sessionId) as Row | undefined;
    return row === undefined ? undefined : sessionWorktreeFromRow(row);
  }

  updateSessionWorktreeState(
    sessionId: string,
    state: SessionWorktreeBinding["state"],
    updatedAt = this.now()
  ): SessionWorktreeBinding {
    return this.write(() => {
      this.getSession(sessionId);
      const current = this.findSessionWorktree(sessionId);
      if (current === undefined) throw new NotFoundError("Session worktree", sessionId);
      if (state !== "active" && state !== "preserved") {
        throw new StoreError("Session worktree state is invalid.");
      }
      if (!Number.isSafeInteger(updatedAt) || updatedAt < current.acquiredAt) {
        throw new StoreError("Session worktree update time is invalid.");
      }
      const result = this.database.prepare(`
        UPDATE session_worktrees
        SET state = ?, updated_at = ?, revision = ?
        WHERE session_id = ?
      `).run(state, updatedAt, asSqlInteger(this.requireActiveRevision()), sessionId);
      if (result.changes !== 1) throw new NotFoundError("Session worktree", sessionId);
      return this.findSessionWorktree(sessionId)!;
    });
  }

  getSession(id: string): StoredSession {
    this.assertOpen();
    const row = this.database.prepare("SELECT * FROM product_sessions WHERE id = ?").get(id) as Row | undefined;
    if (row === undefined) throw new NotFoundError("Session", id);
    return withSessionPresentation(
      sessionFromRow(row),
      this.findSessionAttention(id),
      this.findSessionWorktree(id)
    );
  }

  findObjective(sessionId: string): ObjectiveRecord | undefined {
    this.assertOpen();
    const row = this.database.prepare(
      "SELECT * FROM session_objectives WHERE session_id = ?"
    ).get(sessionId) as Row | undefined;
    return row === undefined ? undefined : objectiveFromRow(row);
  }

  getObjective(sessionId: string): ObjectiveRecord {
    const record = this.findObjective(sessionId);
    if (record === undefined) throw new NotFoundError("Objective", sessionId);
    return record;
  }

  listObjectives(statuses?: readonly ObjectiveStatus[]): ObjectiveRecord[] {
    this.assertOpen();
    if (statuses === undefined || statuses.length === 0) {
      return (this.database.prepare(
        "SELECT * FROM session_objectives ORDER BY updated_at, session_id"
      ).all() as Row[]).map(objectiveFromRow);
    }
    const normalized = [...new Set(statuses.map(objectiveStatus))];
    return (this.database.prepare(`
      SELECT * FROM session_objectives
      WHERE status IN (${normalized.map(() => "?").join(", ")})
      ORDER BY updated_at, session_id
    `).all(...normalized) as Row[]).map(objectiveFromRow);
  }

  /** Replace the semantic Objective while retaining any old in-flight Run as
   * a stale owner fence. The controller will never overlap it with new work. */
  putObjective(input: PutObjectiveInput): ObjectiveRecord {
    return this.write(() => {
      const session = this.getSession(input.sessionId);
      if (session.descriptor.deletedAt !== undefined || session.descriptor.archived) {
        throw new StoreError("An Objective requires an active, non-archived Session.");
      }
      if (this.findSessionRuntimePolicy(input.sessionId) !== undefined) {
        throw new StoreError("An isolated service Session cannot own an Objective.");
      }
      const sessionGeneration = session.descriptor.binding.generation;
      if (
        input.expectedSessionGeneration !== undefined &&
        input.expectedSessionGeneration !== sessionGeneration
      ) {
        throw new StaleGenerationError(input.expectedSessionGeneration, sessionGeneration);
      }
      const text = objectiveText(input.text);
      const tokenBudget = optionalObjectiveLimit(input.tokenBudget, "token budget", Number.MAX_SAFE_INTEGER);
      const maximumTurns = optionalObjectiveLimit(input.maximumTurns, "maximum turns", 10_000);
      const noProgressTurnLimit = optionalObjectiveLimit(
        input.noProgressTurnLimit,
        "no-progress turn limit",
        1_000
      );
      const status = objectiveStatus(input.status ?? "active");
      const current = this.findObjective(input.sessionId);
      const at = objectiveTimestamp(input.updatedAt ?? this.now(), "update time");
      if (current === undefined) {
        this.database.prepare(`
          INSERT INTO session_objectives(
            session_id, objective_text, status, token_budget, maximum_turns,
            no_progress_turn_limit, turns_used, tokens_used,
            no_progress_turns, dispatch_rejections, last_reason,
            owner_generation, session_generation, started_at, updated_at, revision
          ) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, 0, NULL, 1, ?, ?, ?, ?)
        `).run(
          input.sessionId,
          text,
          status,
          tokenBudget ?? null,
          maximumTurns ?? null,
          noProgressTurnLimit ?? null,
          sessionGeneration,
          at,
          at,
          asSqlInteger(this.requireActiveRevision())
        );
      } else {
        const ownerGeneration = nextObjectiveOwnerGeneration(current.ownerGeneration);
        this.database.prepare(`
          UPDATE session_objectives SET
            objective_text = ?, status = ?, token_budget = ?, maximum_turns = ?,
            no_progress_turn_limit = ?, turns_used = 0, tokens_used = 0,
            no_progress_turns = 0, dispatch_rejections = 0, last_reason = NULL,
            owner_generation = ?, session_generation = ?, started_at = ?,
            updated_at = ?, revision = ?
          WHERE session_id = ? AND revision = ?
        `).run(
          text,
          status,
          tokenBudget ?? null,
          maximumTurns ?? null,
          noProgressTurnLimit ?? null,
          ownerGeneration,
          sessionGeneration,
          at,
          at,
          asSqlInteger(this.requireActiveRevision()),
          input.sessionId,
          asSqlInteger(current.revision)
        );
      }
      return this.getObjective(input.sessionId);
    });
  }

  updateObjective(input: UpdateObjectiveInput): ObjectiveRecord {
    return this.write(() => {
      const current = this.getObjective(input.sessionId);
      assertObjectiveFence(current, input.expectedRevision, input.expectedOwnerGeneration);
      const session = this.getSession(input.sessionId);
      const sessionGeneration = session.descriptor.binding.generation;
      if (
        input.expectedSessionGeneration !== undefined &&
        input.expectedSessionGeneration !== sessionGeneration
      ) {
        throw new StaleGenerationError(input.expectedSessionGeneration, sessionGeneration);
      }
      if (input.clearPending === true && input.pending !== undefined) {
        throw new StoreError("Objective pending work cannot be cleared and replaced together.");
      }
      const ownerGeneration = input.advanceOwnerGeneration === true
        ? nextObjectiveOwnerGeneration(current.ownerGeneration)
        : current.ownerGeneration;
      if (input.pending !== undefined) {
        if (input.pending.ownerGeneration !== ownerGeneration) {
          throw new StaleGenerationError(ownerGeneration, input.pending.ownerGeneration);
        }
        assertObjectivePendingWork(this, current.sessionId, input.pending);
      }
      const columns: string[] = ["session_generation = ?"];
      const values: Array<string | number | bigint | null> = [sessionGeneration];
      const set = (column: string, value: string | number | bigint | null): void => {
        columns.push(`${column} = ?`);
        values.push(value);
      };
      if (input.text !== undefined) set("objective_text", objectiveText(input.text));
      if (input.status !== undefined) set("status", objectiveStatus(input.status));
      if (input.tokenBudget !== undefined) {
        set("token_budget", input.tokenBudget === null
          ? null
          : objectiveLimit(input.tokenBudget, "token budget", Number.MAX_SAFE_INTEGER));
      }
      if (input.maximumTurns !== undefined) {
        set("maximum_turns", input.maximumTurns === null
          ? null
          : objectiveLimit(input.maximumTurns, "maximum turns", 10_000));
      }
      if (input.noProgressTurnLimit !== undefined) {
        set("no_progress_turn_limit", input.noProgressTurnLimit === null
          ? null
          : objectiveLimit(input.noProgressTurnLimit, "no-progress turn limit", 1_000));
      }
      if (input.turnsUsed !== undefined) set("turns_used", objectiveCounter(input.turnsUsed, "turn count", 10_000));
      if (input.tokensUsed !== undefined) set("tokens_used", objectiveCounter(input.tokensUsed, "token count", Number.MAX_SAFE_INTEGER));
      if (input.noProgressTurns !== undefined) {
        set("no_progress_turns", objectiveCounter(input.noProgressTurns, "no-progress count", 1_000));
      }
      if (input.dispatchRejections !== undefined) {
        set("dispatch_rejections", objectiveCounter(input.dispatchRejections, "dispatch rejection count", 4));
      }
      if (input.lastReason !== undefined) {
        set("last_reason", input.lastReason === null ? null : objectiveReason(input.lastReason));
      }
      if (input.advanceOwnerGeneration === true) set("owner_generation", ownerGeneration);
      if (input.clearPending === true) {
        set("pending_owner_generation", null);
        set("pending_operation_id", null);
        set("pending_run_id", null);
        set("pending_attempt_id", null);
        set("pending_queue_item_id", null);
      } else if (input.pending !== undefined) {
        set("pending_owner_generation", input.pending.ownerGeneration);
        set("pending_operation_id", input.pending.operationId);
        set("pending_run_id", input.pending.runId);
        set("pending_attempt_id", input.pending.attemptId);
        set("pending_queue_item_id", input.pending.queueItemId);
      }
      const updatedAt = Math.max(
        current.startedAt,
        objectiveTimestamp(input.updatedAt ?? this.now(), "update time")
      );
      set("updated_at", updatedAt);
      set("revision", asSqlInteger(this.requireActiveRevision()));
      values.push(input.sessionId, asSqlInteger(current.revision), current.ownerGeneration);
      const result = this.database.prepare(`
        UPDATE session_objectives SET ${columns.join(", ")}
        WHERE session_id = ? AND revision = ? AND owner_generation = ?
      `).run(...values);
      if (result.changes !== 1) {
        const changed = this.getObjective(input.sessionId);
        if (changed.ownerGeneration !== current.ownerGeneration) {
          throw new StaleGenerationError(current.ownerGeneration, changed.ownerGeneration);
        }
        throw new RevisionConflictError("Objective", input.sessionId, current.revision, changed.revision);
      }
      return this.getObjective(input.sessionId);
    });
  }

  clearObjective(input: {
    readonly sessionId: string;
    readonly expectedRevision: bigint;
    readonly expectedOwnerGeneration: number;
  }): ObjectiveRecord {
    return this.write(() => {
      const current = this.getObjective(input.sessionId);
      assertObjectiveFence(current, input.expectedRevision, input.expectedOwnerGeneration);
      const result = this.database.prepare(`
        DELETE FROM session_objectives
        WHERE session_id = ? AND revision = ? AND owner_generation = ?
      `).run(input.sessionId, asSqlInteger(current.revision), current.ownerGeneration);
      if (result.changes !== 1) throw new RevisionConflictError(
        "Objective",
        input.sessionId,
        current.revision,
        this.getObjective(input.sessionId).revision
      );
      return current;
    });
  }

  listSessions(options: { readonly targetId?: string; readonly includeArchived?: boolean; readonly includeDeleted?: boolean } = {}): StoredSession[] {
    this.assertOpen();
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (options.targetId !== undefined) {
      clauses.push("target_id = ?");
      params.push(options.targetId);
    }
    if (options.includeArchived !== true) clauses.push("archived = 0");
    if (options.includeDeleted !== true) clauses.push("deleted_at IS NULL");
    const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
    return (this.database.prepare(
      `SELECT * FROM product_sessions ${where} ORDER BY pinned DESC, updated_at DESC, id`
    ).all(...params) as Row[]).map((row) => {
      const session = sessionFromRow(row);
      return withSessionPresentation(
        session,
        this.findSessionAttention(session.descriptor.id),
        this.findSessionWorktree(session.descriptor.id)
      );
    });
  }

  findLiveSessionByNativeBinding(backendId: string, opaqueRef: string): StoredSession | undefined {
    this.assertOpen();
    const row = this.database.prepare(`
      SELECT * FROM product_sessions
      WHERE backend_id = ? AND native_opaque_ref = ? COLLATE NOCASE AND deleted_at IS NULL
      ORDER BY created_at, id
      LIMIT 1
    `).get(backendId, opaqueRef) as Row | undefined;
    if (row === undefined) return undefined;
    const session = sessionFromRow(row);
    return withSessionPresentation(
      session,
      this.findSessionAttention(session.descriptor.id),
      this.findSessionWorktree(session.descriptor.id)
    );
  }

  getSessionAttention(sessionId: string): SessionAttentionRecord {
    const attention = this.findSessionAttention(sessionId);
    if (attention === undefined) throw new NotFoundError("Session attention", sessionId);
    return attention;
  }

  findSessionAttention(sessionId: string): SessionAttentionRecord | undefined {
    this.assertOpen();
    const row = this.database.prepare(
      "SELECT * FROM session_attention WHERE session_id = ?"
    ).get(sessionId) as Row | undefined;
    return row === undefined ? undefined : sessionAttentionFromRow(row);
  }

  /**
   * Advances authoritative attention from an already-persisted Session Event.
   * Older sources are ignored so delayed lifecycle work cannot regress state.
   */
  recordSessionAttention(input: {
    readonly sessionId: string;
    readonly kind: SessionAttentionKind;
    readonly sourceCursor: bigint;
    readonly traceId: string;
    readonly operationId?: string;
    readonly at?: number;
  }): SessionAttentionRecord {
    return this.write(() => {
      const session = this.getSession(input.sessionId);
      const sourceRow = this.database.prepare(`
        SELECT * FROM events WHERE global_cursor = ? AND session_id = ?
      `).get(asSqlInteger(input.sourceCursor), input.sessionId) as Row | undefined;
      if (sourceRow === undefined) {
        throw new StoreError("Session attention must reference a durable Event from the same Session.");
      }
      const source = eventFromRow(sourceRow);
      if (source.generation !== session.descriptor.binding.generation) {
        throw new StaleGenerationError(session.descriptor.binding.generation, source.generation);
      }
      const current = this.findSessionAttention(input.sessionId);
      const effectiveKind = current?.unread === true && current.kind === "error" && input.kind !== "error"
        ? "error"
        : input.kind;
      if (current !== undefined && input.sourceCursor <= current.attentionCursor) {
        if (input.sourceCursor === current.attentionCursor && effectiveKind !== current.kind) {
          throw new StoreError("A Session attention cursor cannot identify two attention kinds.");
        }
        return current;
      }
      const subjectCursor = effectiveKind === input.kind || current === undefined
        ? input.sourceCursor
        : current.subjectCursor;
      const subjectGeneration = effectiveKind === input.kind || current === undefined
        ? source.generation
        : current.subjectGeneration;
      const at = input.at ?? this.now();
      this.database.prepare(`
        INSERT INTO session_attention(
          session_id, kind, unread, subject_cursor, subject_generation,
          attention_cursor, attention_generation,
          read_through_cursor, read_through_generation, updated_at, revision
        ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          kind = excluded.kind,
          unread = 1,
          subject_cursor = excluded.subject_cursor,
          subject_generation = excluded.subject_generation,
          attention_cursor = excluded.attention_cursor,
          attention_generation = excluded.attention_generation,
          updated_at = excluded.updated_at,
          revision = excluded.revision
      `).run(
        input.sessionId,
        effectiveKind,
        asSqlInteger(subjectCursor),
        subjectGeneration,
        asSqlInteger(input.sourceCursor),
        source.generation,
        current === undefined ? 0 : asSqlInteger(current.readThroughCursor),
        current?.readThroughGeneration ?? 0,
        at,
        asSqlInteger(this.requireActiveRevision())
      );
      const updated = this.getSessionAttention(input.sessionId);
      this.appendSessionAttentionEvent(
        session,
        updated,
        input.traceId,
        input.operationId
      );
      return updated;
    });
  }

  /** Exact cursor CAS: an acknowledgement for old attention never clears new attention. */
  acknowledgeSessionAttention(input: {
    readonly sessionId: string;
    readonly throughCursor: bigint;
    readonly generation: number;
    readonly intent: "viewed" | "explicit";
    readonly traceId: string;
    readonly operationId?: string;
    readonly at?: number;
  }): SessionAttentionRecord {
    return this.write(() => {
      const session = this.getSession(input.sessionId);
      const current = this.getSessionAttention(input.sessionId);
      if (
        (input.intent === "viewed" && current.kind === "error") ||
        (input.intent === "explicit" && current.kind !== "error")
      ) {
        throw new InvalidStateTransitionError("Session attention acknowledgement", current.kind, "read");
      }
      if (input.generation !== current.attentionGeneration) {
        throw new StaleGenerationError(current.attentionGeneration, input.generation);
      }
      if (input.throughCursor !== current.attentionCursor) {
        throw new RevisionConflictError(
          "Session attention cursor",
          input.sessionId,
          input.throughCursor,
          current.attentionCursor
        );
      }
      if (!current.unread) return current;
      const at = input.at ?? this.now();
      const result = this.database.prepare(`
        UPDATE session_attention
        SET unread = 0, read_through_cursor = ?, read_through_generation = ?,
            updated_at = ?, revision = ?
        WHERE session_id = ? AND unread = 1
          AND attention_cursor = ? AND attention_generation = ?
      `).run(
        asSqlInteger(input.throughCursor),
        input.generation,
        at,
        asSqlInteger(this.requireActiveRevision()),
        input.sessionId,
        asSqlInteger(input.throughCursor),
        input.generation
      );
      if (Number(result.changes) !== 1) {
        const changed = this.getSessionAttention(input.sessionId);
        throw new RevisionConflictError(
          "Session attention cursor",
          input.sessionId,
          input.throughCursor,
          changed.attentionCursor
        );
      }
      const updated = this.getSessionAttention(input.sessionId);
      const receiptEvent = this.appendSessionAttentionEvent(session, updated, input.traceId, input.operationId);
      if (input.intent === "explicit") {
        const openInteractionSource = this.latestOpenInteractionSourceEvent(input.sessionId);
        if (openInteractionSource !== undefined) {
          return this.advanceSessionAttentionState(
            session,
            receiptEvent,
            `${input.traceId}:awaiting`,
            input.operationId,
            { kind: "awaiting", unread: true, subjectEvent: openInteractionSource }
          );
        }
      }
      return updated;
    });
  }

  updateSession(
    id: string,
    patch: Omit<Partial<Pick<SessionDescriptor,
      "title" | "pinned" | "archived" | "deletedAt" | "permissionMode" | "planMode" |
      "providerId" | "modelId" | "effort" | "fastMode" | "binding">>, "effort"> & {
        /** `null` explicitly clears a stale effort when the selected model exposes none. */
        readonly effort?: string | null;
      },
    expectedRevision?: bigint,
    now = this.now()
  ): StoredSession {
    return this.write(() => {
      const current = this.getSession(id);
      if (expectedRevision !== undefined && current.revision !== expectedRevision) {
        throw new RevisionConflictError("Session", id, expectedRevision, current.revision);
      }
      const descriptor = current.descriptor;
      const binding = patch.binding ?? descriptor.binding;
      if (binding.generation < descriptor.binding.generation) {
        throw new StaleGenerationError(descriptor.binding.generation, binding.generation);
      }
      const nativeBindingChanged =
        binding.opaqueRef !== descriptor.binding.opaqueRef ||
        binding.nativeSessionId !== descriptor.binding.nativeSessionId;
      if (nativeBindingChanged && binding.generation <= descriptor.binding.generation) {
        throw new StoreError("Changing a native session binding requires a higher generation.");
      }
      const clearSummary = patch.pinned === false || patch.archived === true || patch.deletedAt !== undefined;
      this.database.prepare(`
        UPDATE product_sessions SET
          title = ?, title_source = ?, native_opaque_ref = ?, native_binding_fingerprint = ?, native_session_id = ?, generation = ?,
          pinned = ?, archived = ?, deleted_at = ?, permission_mode = ?, plan_mode = ?,
          provider_id = ?, model_id = ?, effort = ?, fast_mode = ?,
          task_summary = ?, summary_source_cursor = ?, summary_updated_at = ?,
          updated_at = ?, revision = ?
        WHERE id = ? AND revision = ?
      `).run(
        patch.title ?? descriptor.title,
        patch.title === undefined ? descriptor.titleSource ?? "manual" : "manual",
        binding.opaqueRef,
        nativeBindingFingerprint(binding.opaqueRef),
        binding.nativeSessionId ?? null,
        binding.generation,
        boolInt(patch.pinned ?? descriptor.pinned),
        boolInt(patch.archived ?? descriptor.archived),
        patch.deletedAt ?? descriptor.deletedAt ?? null,
        patch.permissionMode ?? descriptor.permissionMode,
        boolInt(patch.planMode ?? descriptor.planMode),
        patch.providerId ?? descriptor.providerId ?? null,
        patch.modelId ?? descriptor.modelId ?? null,
        patch.effort === null ? null : patch.effort ?? descriptor.effort ?? null,
        boolInt(patch.fastMode ?? descriptor.fastMode),
        clearSummary ? null : descriptor.summary ?? null,
        clearSummary || descriptor.summarySourceCursor === undefined
          ? null
          : asSqlInteger(descriptor.summarySourceCursor),
        clearSummary ? null : descriptor.summaryUpdatedAt ?? null,
        now,
        asSqlInteger(this.requireActiveRevision()),
        id,
        asSqlInteger(current.revision)
      );
      if (descriptor.deletedAt === undefined && patch.deletedAt !== undefined) {
        const vectorRows = this.database.prepare(`
          SELECT record.event_cursor
          FROM message_embedding_records AS record
          JOIN events AS event ON event.global_cursor = record.event_cursor
          WHERE event.session_id = ?
        `).all(id) as Row[];
        if (this.messageVectorAvailable) {
          for (const row of vectorRows) {
            this.database.prepare(
              `UPDATE ${MESSAGE_SEARCH_VECTOR_TABLE} SET live = 0 WHERE rowid = ?`
            ).run(toBigInt(row["event_cursor"]));
          }
        }
        this.database.prepare(`
          DELETE FROM message_embedding_records
          WHERE event_cursor IN (SELECT global_cursor FROM events WHERE session_id = ?)
        `).run(id);
        this.database.prepare(`
          DELETE FROM message_embedding_jobs
          WHERE event_cursor IN (SELECT global_cursor FROM events WHERE session_id = ?)
        `).run(id);
      }
      if (binding.generation !== descriptor.binding.generation) {
        this.database.prepare(`
          UPDATE tool_leases
          SET state = 'revoked', released_at = ?, updated_at = ?, revision = ?
          WHERE session_id = ? AND state = 'active' AND generation <> ?
        `).run(
          now,
          now,
          asSqlInteger(this.requireActiveRevision()),
          id,
          binding.generation
        );
      }
      const updated = this.getSession(id);
      if (updated.revision === current.revision) {
        throw new RevisionConflictError("Session", id, current.revision, updated.revision);
      }
      if (
        patch.title !== undefined || patch.pinned !== undefined || patch.archived !== undefined ||
        patch.deletedAt !== undefined
      ) this.appendSessionProjectionEvent(updated, `session-update:${id}:${updated.revision.toString(10)}`);
      return updated;
    });
  }

  /**
   * Changes only the Session's sidebar/navigation placement. Its Target,
   * Backend, native binding, worktree, and runtime identity stay immutable.
   */
  moveSessionProject(input: {
    readonly sessionId: string;
    readonly expectedRevision: bigint;
    /** Undefined explicitly moves the Session to the Dialogue group. */
    readonly projectId?: string;
    readonly movedAt?: number;
  }): StoredSession {
    return this.write(() => {
      const current = this.getSession(input.sessionId);
      if (current.revision !== input.expectedRevision) {
        throw new RevisionConflictError("Session", input.sessionId, input.expectedRevision, current.revision);
      }
      if (current.descriptor.projectId === input.projectId) return current;
      if (input.projectId !== undefined) this.getTarget(input.projectId);
      const movedAt = input.movedAt ?? this.now();
      const result = this.database.prepare(`
        UPDATE product_sessions
        SET project_id = ?, updated_at = ?, revision = ?
        WHERE id = ? AND revision = ?
      `).run(
        input.projectId ?? null,
        movedAt,
        asSqlInteger(this.requireActiveRevision()),
        input.sessionId,
        asSqlInteger(current.revision)
      );
      if (result.changes !== 1) {
        throw new RevisionConflictError(
          "Session",
          input.sessionId,
          input.expectedRevision,
          this.getSession(input.sessionId).revision
        );
      }
      const updated = this.getSession(input.sessionId);
      this.appendSessionProjectionEvent(
        updated,
        `session-project:${input.sessionId}:${updated.revision.toString(10)}`
      );
      return updated;
    });
  }

  /**
   * Advances automatic naming only while its exact durable ownership fence is
   * eligible. Manual writes change title_source even when the text is equal.
   */
  updateAutomaticSessionTitle(input: {
    readonly sessionId: string;
    readonly title: string;
    readonly source: "attachment" | "placeholder" | "automatic";
    readonly expectedRevision: bigint;
  }): StoredSession | undefined {
    return this.write(() => {
      const current = this.getSession(input.sessionId);
      const source = current.descriptor.titleSource ?? "manual";
      const eligible = input.source === "attachment"
        ? source === "draft"
        : input.source === "placeholder"
          ? source === "draft" || source === "attachment"
          : source === "draft" || source === "attachment" || source === "placeholder";
      if (current.revision !== input.expectedRevision || !eligible) return undefined;
      const title = boundedSessionNavigationText(input.title, input.source === "automatic" ? 20 : 40, "Session title");
      const result = this.database.prepare(`
        UPDATE product_sessions
        SET title = ?, title_source = ?, revision = ?
        WHERE id = ? AND revision = ? AND title_source = ?
      `).run(
        title,
        input.source,
        asSqlInteger(this.requireActiveRevision()),
        input.sessionId,
        asSqlInteger(current.revision),
        source
      );
      if (result.changes !== 1) return undefined;
      const updated = this.getSession(input.sessionId);
      this.appendSessionProjectionEvent(updated, `session-title:${input.sessionId}:${updated.revision.toString(10)}`);
      return updated;
    });
  }

  /** Marks a successfully installed placeholder as the final automatic name. */
  finalizeAutomaticSessionTitle(sessionId: string, expectedRevision: bigint): StoredSession | undefined {
    return this.write(() => {
      const current = this.getSession(sessionId);
      if (current.revision !== expectedRevision || current.descriptor.titleSource !== "placeholder") return undefined;
      const result = this.database.prepare(`
        UPDATE product_sessions
        SET title_source = 'automatic', revision = ?
        WHERE id = ? AND revision = ? AND title_source = 'placeholder'
      `).run(
        asSqlInteger(this.requireActiveRevision()),
        sessionId,
        asSqlInteger(current.revision)
      );
      if (result.changes !== 1) return undefined;
      const updated = this.getSession(sessionId);
      this.appendSessionProjectionEvent(updated, `session-title-final:${sessionId}:${updated.revision.toString(10)}`);
      return updated;
    });
  }

  /** Writes a fenced generated summary without changing navigation ordering. */
  updateGeneratedSessionSummary(input: {
    readonly sessionId: string;
    readonly summary: string;
    readonly sourceCursor: bigint;
    readonly expectedRevision: bigint;
    readonly generatedAt?: number;
  }): StoredSession | undefined {
    return this.write(() => {
      const current = this.getSession(input.sessionId);
      if (
        current.revision !== input.expectedRevision || !current.descriptor.pinned ||
        current.descriptor.archived || current.descriptor.deletedAt !== undefined
      ) return undefined;
      const summary = boundedSessionNavigationText(input.summary, 26, "Session summary");
      const generatedAt = input.generatedAt ?? this.now();
      const result = this.database.prepare(`
        UPDATE product_sessions
        SET task_summary = ?, summary_source_cursor = ?, summary_updated_at = ?, revision = ?
        WHERE id = ? AND revision = ? AND pinned = 1 AND archived = 0 AND deleted_at IS NULL
      `).run(
        summary,
        asSqlInteger(input.sourceCursor),
        generatedAt,
        asSqlInteger(this.requireActiveRevision()),
        input.sessionId,
        asSqlInteger(current.revision)
      );
      if (result.changes !== 1) return undefined;
      const updated = this.getSession(input.sessionId);
      this.appendSessionProjectionEvent(updated, `session-summary:${input.sessionId}:${updated.revision.toString(10)}`);
      return updated;
    });
  }

  clearSessionSummary(sessionId: string): StoredSession {
    return this.write(() => {
      const current = this.getSession(sessionId);
      if (current.descriptor.summary === undefined) return current;
      const result = this.database.prepare(`
        UPDATE product_sessions
        SET task_summary = NULL, summary_source_cursor = NULL, summary_updated_at = NULL, revision = ?
        WHERE id = ? AND revision = ?
      `).run(
        asSqlInteger(this.requireActiveRevision()),
        sessionId,
        asSqlInteger(current.revision)
      );
      if (result.changes !== 1) {
        throw new RevisionConflictError("Session", sessionId, current.revision, this.getSession(sessionId).revision);
      }
      const updated = this.getSession(sessionId);
      this.appendSessionProjectionEvent(updated, `session-summary-clear:${sessionId}:${updated.revision.toString(10)}`);
      return updated;
    });
  }

  private appendSessionProjectionEvent(session: StoredSession, traceId: string): PersistedEvent {
    return this.appendEvent({
      backendId: session.descriptor.backendId,
      targetId: session.descriptor.targetId,
      sessionId: session.descriptor.id,
      generation: session.descriptor.binding.generation,
      traceId,
      payload: { type: "session_changed" }
    });
  }

  runOperation<T>(input: OperationInput, callback: (store: this) => T): OperationExecution<T> {
    const bodyHash = operationBodyHash(input.body);
    const existing = this.findOperation<T>(input.id);
    if (existing !== undefined) return replayOperation(existing, bodyHash);

    try {
      return this.transaction(() => {
        const raced = this.findOperation<T>(input.id);
        if (raced !== undefined) return replayOperation(raced, bodyHash);
        const createdAt = input.createdAt ?? this.now();
        this.database.prepare(`
          INSERT INTO operations(
            id, connection_id, kind, body_json, body_hash, completion_mode,
            status, created_at, updated_at, revision
          ) VALUES (?, ?, ?, ?, ?, 'transactional', 'started', ?, ?, ?)
        `).run(
          input.id,
          input.connectionId ?? null,
          nonBlank(input.kind, "Operation kind"),
          serializeJson(input.body),
          bodyHash,
          createdAt,
          createdAt,
          asSqlInteger(this.requireActiveRevision())
        );
        const value = callback(this);
        if (isPromiseLike(value)) throw new AsyncTransactionError();
        const responseJson = serializeJson(value);
        this.database.prepare(`
          UPDATE operations
          SET status = 'completed', response_json = ?, updated_at = ?, revision = ?
          WHERE id = ? AND status = 'started'
        `).run(responseJson, this.now(), asSqlInteger(this.requireActiveRevision()), input.id);
        return {
          replayed: false,
          value,
          operation: this.getOperation<T>(input.id)
        };
      });
    } catch (error) {
      if (
        error instanceof OperationConflictError ||
        error instanceof OperationInProgressError ||
        error instanceof OperationPreviouslyFailedError ||
        error instanceof AsyncTransactionError
      ) throw error;
      this.persistOperationFailure(input, bodyHash, error);
      throw error;
    }
  }

  /**
   * Atomically authenticates the caller, records the complete request, and
   * commits the local mutation while leaving the operation in `started`.
   * The winning caller must then execute the external effect and acknowledge
   * it with completeEffectOperation or failEffectOperation.
   */
  claimAuthorizedEffectOperation<T>(
    connectionId: string,
    authKeyDigest: string,
    input: Omit<OperationInput, "connectionId">,
    callback: (store: this, connection: ConnectionRecord) => T
  ): EffectOperationClaim<T> {
    const operationInput: OperationInput = { ...input, connectionId };
    const bodyHash = operationBodyHash(input.body);
    let authorized = false;
    try {
      return this.transaction(() => {
        const connection = this.authorizeConnection(connectionId, authKeyDigest);
        authorized = true;
        const existing = this.findOperation<T>(input.id);
        if (existing !== undefined) {
          if (existing.connectionId !== connectionId) {
            throw new AuthorizationError("The operation belongs to a different connection.");
          }
          const replay = replayOperation(existing, bodyHash);
          return { ...replay, claimed: false };
        }
        const createdAt = input.createdAt ?? this.now();
        this.database.prepare(`
          INSERT INTO operations(
            id, connection_id, kind, body_json, body_hash, completion_mode,
            status, created_at, updated_at, revision
          ) VALUES (?, ?, ?, ?, ?, 'external_effect', 'started', ?, ?, ?)
        `).run(
          input.id,
          connectionId,
          nonBlank(input.kind, "Operation kind"),
          serializeJson(input.body),
          bodyHash,
          createdAt,
          createdAt,
          asSqlInteger(this.requireActiveRevision())
        );
        const value = callback(this, connection);
        if (isPromiseLike(value)) throw new AsyncTransactionError();
        this.database.prepare(`
          UPDATE operations
          SET response_json = ?, updated_at = ?, revision = ?
          WHERE id = ? AND status = 'started' AND completion_mode = 'external_effect'
        `).run(
          serializeJson(value),
          this.now(),
          asSqlInteger(this.requireActiveRevision()),
          input.id
        );
        return {
          replayed: false,
          claimed: true,
          value,
          operation: this.getOperation<T>(input.id)
        };
      });
    } catch (error) {
      if (
        !authorized ||
        error instanceof AuthorizationError ||
        error instanceof OperationConflictError ||
        error instanceof OperationInProgressError ||
        error instanceof OperationPreviouslyFailedError ||
        error instanceof AsyncTransactionError
      ) throw error;
      this.persistOperationFailure(operationInput, bodyHash, error, "external_effect");
      throw error;
    }
  }

  /**
   * Atomically authenticates and durably claims an external effect without
   * committing its product mutation or response. `validate` is synchronous and
   * runs inside the claim transaction. A startup that finds the claim still in
   * `started` state tombstones it as outcome-unknown; callers must never replay
   * the effect automatically.
   */
  claimAuthorizedDeferredEffectOperation<T>(
    connectionId: string,
    authKeyDigest: string,
    input: Omit<OperationInput, "connectionId">,
    validate?: (store: this, connection: ConnectionRecord) => void
  ): DeferredEffectOperationClaim<T> {
    const operationInput: OperationInput = { ...input, connectionId };
    const bodyHash = operationBodyHash(input.body);
    let authorized = false;
    try {
      return this.transaction(() => {
        const connection = this.authorizeConnection(connectionId, authKeyDigest);
        authorized = true;
        const existing = this.findOperation<T>(input.id);
        if (existing !== undefined) {
          if (existing.connectionId !== connectionId) {
            throw new AuthorizationError("The operation belongs to a different connection.");
          }
          const replay = replayOperation(existing, bodyHash);
          return {
            claimed: false,
            replayed: true,
            value: replay.value,
            operation: replay.operation
          };
        }
        const createdAt = input.createdAt ?? this.now();
        this.database.prepare(`
          INSERT INTO operations(
            id, connection_id, kind, body_json, body_hash, completion_mode,
            status, created_at, updated_at, revision
          ) VALUES (?, ?, ?, ?, ?, 'external_effect', 'started', ?, ?, ?)
        `).run(
          input.id,
          connectionId,
          nonBlank(input.kind, "Operation kind"),
          serializeJson(input.body),
          bodyHash,
          createdAt,
          createdAt,
          asSqlInteger(this.requireActiveRevision())
        );
        validate?.(this, connection);
        return {
          claimed: true,
          replayed: false,
          operation: this.getOperation<T>(input.id)
        };
      });
    } catch (error) {
      if (
        !authorized ||
        error instanceof AuthorizationError ||
        error instanceof OperationConflictError ||
        error instanceof OperationInProgressError ||
        error instanceof OperationPreviouslyFailedError ||
        error instanceof AsyncTransactionError
      ) throw error;
      this.persistOperationFailure(operationInput, bodyHash, error, "external_effect");
      throw error;
    }
  }

  /**
   * Re-authenticates, rechecks the claimed operation, runs the final product
   * mutation, stores its response, and marks the effect completed in one SQLite
   * transaction. The callback is the final precondition/fencing boundary after
   * an awaited external effect.
   */
  completeAuthorizedDeferredEffectOperation<T>(
    connectionId: string,
    authKeyDigest: string,
    operationId: string,
    expectedBodyHash: string,
    callback: (store: this, connection: ConnectionRecord) => T
  ): OperationExecution<T> {
    return this.transaction(() => {
      const connection = this.authorizeConnection(connectionId, authKeyDigest);
      const operation = this.getOperation<T>(operationId);
      if (operation.connectionId !== connectionId) {
        throw new AuthorizationError("The operation belongs to a different connection.");
      }
      assertEffectOperation(operation, expectedBodyHash);
      if (operation.status === "failed") {
        throw new OperationPreviouslyFailedError(operation.id, operation.error);
      }
      if (operation.status === "completed") {
        if (!("response" in operation)) throw new StoreError(`Operation ${operation.id} has no response.`);
        return { replayed: true, value: operation.response as T, operation };
      }

      const value = callback(this, connection);
      if (isPromiseLike(value)) throw new AsyncTransactionError();
      const result = this.database.prepare(`
        UPDATE operations
        SET status = 'completed', response_json = ?, error_json = NULL,
            updated_at = ?, revision = ?
        WHERE id = ? AND status = 'started' AND completion_mode = 'external_effect'
      `).run(
        serializeJson(value),
        this.now(),
        asSqlInteger(this.requireActiveRevision()),
        operationId
      );
      if (result.changes !== 1) throw new OperationInProgressError(operationId);
      return {
        replayed: false,
        value,
        operation: this.getOperation<T>(operationId)
      };
    });
  }

  completeEffectOperation<T>(operationId: string, expectedBodyHash: string): OperationExecution<T> {
    return this.transaction(() => {
      const operation = this.getOperation<T>(operationId);
      assertEffectOperation(operation, expectedBodyHash);
      if (operation.status === "failed") {
        throw new OperationPreviouslyFailedError(operation.id, operation.error);
      }
      if (operation.status === "completed") {
        if (!("response" in operation)) throw new StoreError(`Operation ${operation.id} has no response.`);
        return { replayed: true, value: operation.response as T, operation };
      }
      if (!("response" in operation)) throw new StoreError(`Operation ${operation.id} has no claimed response.`);
      this.database.prepare(`
        UPDATE operations
        SET status = 'completed', updated_at = ?, revision = ?
        WHERE id = ? AND status = 'started' AND completion_mode = 'external_effect'
      `).run(this.now(), asSqlInteger(this.requireActiveRevision()), operationId);
      const completed = this.getOperation<T>(operationId);
      return { replayed: false, value: completed.response as T, operation: completed };
    });
  }

  failEffectOperation(
    operationId: string,
    expectedBodyHash: string,
    error: unknown
  ): OperationRecord {
    return this.transaction(() => {
      const operation = this.getOperation(operationId);
      assertEffectOperation(operation, expectedBodyHash);
      if (operation.status === "completed") {
        throw new StoreError(`Operation ${operation.id} already completed.`);
      }
      if (operation.status === "failed") return operation;
      this.database.prepare(`
        UPDATE operations
        SET status = 'failed', error_json = ?, updated_at = ?, revision = ?
        WHERE id = ? AND status = 'started' AND completion_mode = 'external_effect'
      `).run(
        serializeJson(effectFailureError(error)),
        this.now(),
        asSqlInteger(this.requireActiveRevision()),
        operationId
      );
      return this.getOperation(operationId);
    });
  }

  getOperation<T = unknown>(id: string): OperationRecord<T> {
    const operation = this.findOperation<T>(id);
    if (operation === undefined) throw new NotFoundError("Operation", id);
    return operation;
  }

  findOperation<T = unknown>(id: string): OperationRecord<T> | undefined {
    this.assertOpen();
    const row = this.database.prepare("SELECT * FROM operations WHERE id = ?").get(id) as Row | undefined;
    return row === undefined ? undefined : operationFromRow<T>(row);
  }

  listOperations<T = unknown>(options: OperationQuery = {}): OperationRecord<T>[] {
    this.assertOpen();
    const filter = operationSqlFilter(options);
    return (this.database.prepare(
      `SELECT operation.* FROM operations AS operation ${filter.where}
       ORDER BY operation.created_at DESC, operation.id LIMIT ? OFFSET ?`
    ).all(...filter.params, normalizeLimit(options.limit, 500), normalizeOffset(options.offset)) as Row[])
      .map(operationFromRow<T>);
  }

  countOperations(options: Omit<OperationQuery, "limit" | "offset"> = {}): number {
    this.assertOpen();
    const filter = operationSqlFilter(options);
    const row = this.database.prepare(
      `SELECT COUNT(*) AS count FROM operations AS operation ${filter.where}`
    ).get(...filter.params) as Row;
    return numberValue(row["count"]);
  }

  private persistOperationFailure(
    input: OperationInput,
    bodyHash: string,
    error: unknown,
    completionMode: OperationRecord["completionMode"] = "transactional"
  ): void {
    const storedError = errorForStorage(error);
    this.transaction(() => {
      const existing = this.findOperation(input.id);
      if (existing !== undefined) {
        if (existing.bodyHash !== bodyHash) {
          throw new OperationConflictError(input.id, existing.bodyHash, bodyHash);
        }
        return;
      }
      const timestamp = input.createdAt ?? this.now();
      this.database.prepare(`
        INSERT INTO operations(
          id, connection_id, kind, body_json, body_hash, completion_mode, status, error_json,
          created_at, updated_at, revision
        ) VALUES (?, ?, ?, ?, ?, ?, 'failed', ?, ?, ?, ?)
      `).run(
        input.id,
        input.connectionId ?? null,
        input.kind,
        serializeJson(input.body),
        bodyHash,
        completionMode,
        serializeJson(storedError),
        timestamp,
        this.now(),
        asSqlInteger(this.requireActiveRevision())
      );
    });
  }

  createRun(
    descriptor: RunDescriptor,
    options: { readonly traceId?: string; readonly operationId?: string } = {}
  ): StoredRun {
    return this.write(() => {
      const session = this.getSession(descriptor.sessionId);
      this.assertSessionNotPendingScheduleDeletion(descriptor.sessionId);
      if (descriptor.parentRunId !== undefined) {
        const parent = this.getRun(descriptor.parentRunId);
        if (parent.descriptor.sessionId !== descriptor.sessionId) {
          throw new StoreError("A parent run must belong to the same session.");
        }
        const existing = this.database.prepare(`
          SELECT id FROM runs WHERE parent_run_id = ? LIMIT 1
        `).get(descriptor.parentRunId) as Row | undefined;
        if (existing !== undefined) {
          throw new StoreError("This run already has a durable continuation.");
        }
      }
      this.database.prepare(`
        INSERT INTO runs(
          id, session_id, source, state, parent_run_id, active_attempt_id,
          created_at, started_at, ended_at, error_json, revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        descriptor.id,
        descriptor.sessionId,
        descriptor.source,
        descriptor.state,
        descriptor.parentRunId ?? null,
        descriptor.activeAttemptId ?? null,
        descriptor.createdAt,
        descriptor.startedAt ?? null,
        descriptor.endedAt ?? null,
        descriptor.error === undefined ? null : serializeJson(descriptor.error),
        asSqlInteger(this.requireActiveRevision())
      );
      const sourceEvent = this.appendEvent({
        backendId: session.descriptor.backendId,
        targetId: session.descriptor.targetId,
        sessionId: descriptor.sessionId,
        runId: descriptor.id,
        ...(options.operationId === undefined ? {} : { operationId: options.operationId }),
        generation: session.descriptor.binding.generation,
        traceId: options.traceId ?? `run:${descriptor.id}:created`,
        payload: {
          type: "run_state",
          state: descriptor.state,
          ...(descriptor.error === undefined ? {} : { error: descriptor.error })
        }
      });
      if (descriptor.state === "waiting" || isTerminalRunState(descriptor.state)) {
        if (descriptor.state === "waiting") {
          this.recordSessionAttention({
            sessionId: session.descriptor.id,
            kind: "awaiting",
            sourceCursor: sourceEvent.globalCursor,
            traceId: `${options.traceId ?? `run:${descriptor.id}:created`}:attention`,
            ...(options.operationId === undefined ? {} : { operationId: options.operationId }),
            at: sourceEvent.emittedAt
          });
        } else {
          this.recordTerminalSessionAttention(
            session,
            sourceEvent,
            descriptor.state === "failed",
            `${options.traceId ?? `run:${descriptor.id}:created`}:attention`,
            options.operationId
          );
        }
      } else if (descriptor.state === "running" || descriptor.state === "retrying") {
        this.clearSessionAttentionFromLifecycle(
          session,
          sourceEvent,
          `${options.traceId ?? `run:${descriptor.id}:created`}:attention-progressed`,
          options.operationId
        );
      }
      return this.getRun(descriptor.id);
    });
  }

  getRun(id: string): StoredRun {
    const run = this.findRun(id);
    if (run === undefined) throw new NotFoundError("Run", id);
    return run;
  }

  findRun(id: string): StoredRun | undefined {
    this.assertOpen();
    const row = this.database.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Row | undefined;
    return row === undefined ? undefined : runFromRow(row);
  }

  findRunByParentId(parentRunId: string): StoredRun | undefined {
    this.assertOpen();
    const row = this.database.prepare(`
      SELECT * FROM runs WHERE parent_run_id = ? LIMIT 1
    `).get(nonBlank(parentRunId, "Parent Run ID")) as Row | undefined;
    return row === undefined ? undefined : runFromRow(row);
  }

  listRuns(options: RunListOptions = {}): StoredRun[] {
    this.assertOpen();
    const filter = runSqlFilter(options);
    return (this.database.prepare(
      `SELECT run.* FROM runs AS run ${filter.where}
       ORDER BY run.created_at DESC, run.id LIMIT ? OFFSET ?`
    ).all(...filter.params, normalizeLimit(options.limit, 500), normalizeOffset(options.offset)) as Row[])
      .map(runFromRow);
  }

  countRuns(options: Omit<RunListOptions, "limit" | "offset"> = {}): number {
    this.assertOpen();
    const filter = runSqlFilter(options);
    const row = this.database.prepare(
      `SELECT COUNT(*) AS count FROM runs AS run ${filter.where}`
    ).get(...filter.params) as Row;
    return numberValue(row["count"]);
  }

  sumRunActiveDuration(options: Omit<RunListOptions, "limit" | "offset"> = {}): number {
    this.assertOpen();
    const filter = runSqlFilter(options);
    const row = this.database.prepare(`
      SELECT COALESCE(SUM(
        CASE
          WHEN run.started_at IS NULL THEN 0
          WHEN COALESCE(run.ended_at, run.started_at) < run.started_at THEN 0
          ELSE COALESCE(run.ended_at, run.started_at) - run.started_at
        END
      ), 0) AS duration
      FROM runs AS run ${filter.where}
    `).get(...filter.params) as Row;
    return numberValue(row["duration"]);
  }

  createAttempt(descriptor: AttemptDescriptor): StoredAttempt {
    return this.write(() => {
      const run = this.getRun(descriptor.runId);
      const session = this.getSession(run.descriptor.sessionId);
      if (descriptor.generation !== session.descriptor.binding.generation) {
        throw new StaleGenerationError(session.descriptor.binding.generation, descriptor.generation);
      }
      if (
        descriptor.backendInstanceGeneration !== undefined &&
        (!Number.isSafeInteger(descriptor.backendInstanceGeneration) || descriptor.backendInstanceGeneration < 0)
      ) {
        throw new StoreError("Attempt Backend instance generation must be a non-negative safe integer.");
      }
      this.database.prepare(`
        INSERT INTO attempts(
          id, run_id, ordinal, generation, backend_instance_generation,
          started_at, ended_at, error_json, revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        descriptor.id,
        descriptor.runId,
        descriptor.ordinal,
        descriptor.generation,
        descriptor.backendInstanceGeneration ?? null,
        descriptor.startedAt,
        descriptor.endedAt ?? null,
        descriptor.error === undefined ? null : serializeJson(descriptor.error),
        asSqlInteger(this.requireActiveRevision())
      );
      this.database.prepare(`
        UPDATE runs SET active_attempt_id = ?, revision = ? WHERE id = ?
      `).run(descriptor.id, asSqlInteger(this.requireActiveRevision()), descriptor.runId);
      return this.getAttempt(descriptor.id);
    });
  }

  getAttempt(id: string): StoredAttempt {
    this.assertOpen();
    const row = this.database.prepare("SELECT * FROM attempts WHERE id = ?").get(id) as Row | undefined;
    if (row === undefined) throw new NotFoundError("Attempt", id);
    return attemptFromRow(row);
  }

  listAttempts(runId: string): StoredAttempt[] {
    this.assertOpen();
    return (this.database.prepare(
      "SELECT * FROM attempts WHERE run_id = ? ORDER BY ordinal, id"
    ).all(runId) as Row[]).map(attemptFromRow);
  }

  renewQueueAttemptGeneration(input: {
    readonly queueItemId: string;
    readonly attemptId: string;
    readonly generation: number;
    readonly at?: number;
  }): QueueItemRecord {
    return this.write(() => {
      const item = this.getQueueItem(input.queueItemId);
      if (item.state !== "accepted" && item.state !== "dispatching") {
        throw new InvalidStateTransitionError("queue attempt", item.state, "dispatching");
      }
      const session = this.getSession(item.sessionId);
      if (session.descriptor.binding.generation !== input.generation) {
        throw new StaleGenerationError(session.descriptor.binding.generation, input.generation);
      }
      const currentAttempt = item.attemptId === undefined ? undefined : this.getAttempt(item.attemptId);
      if (currentAttempt !== undefined && currentAttempt.descriptor.runId !== item.runId) {
        throw new StoreError("Queue item attempt does not belong to its run.");
      }
      if (
        currentAttempt?.descriptor.generation === input.generation &&
        currentAttempt.descriptor.backendInstanceGeneration === item.backendInstanceGeneration
      ) return item;

      if (item.state !== "accepted" && item.backendInstanceGeneration === undefined) {
        throw new StoreError("A dispatching queue item must own a Backend instance generation.");
      }

      const at = input.at ?? this.now();
      if (currentAttempt !== undefined && currentAttempt.descriptor.endedAt === undefined) {
        this.finishAttempt(currentAttempt.descriptor.id, undefined, at);
      }
      const ordinal = this.listAttempts(item.runId)
        .reduce((highest, attempt) => Math.max(highest, attempt.descriptor.ordinal), 0) + 1;
      this.createAttempt({
        id: input.attemptId,
        runId: item.runId,
        ordinal,
        generation: input.generation,
        ...(item.backendInstanceGeneration === undefined
          ? {}
          : { backendInstanceGeneration: item.backendInstanceGeneration }),
        startedAt: at
      });
      this.database.prepare(`
        UPDATE queue_items
        SET attempt_id = ?, updated_at = ?, revision = ?
        WHERE id = ?
      `).run(
        input.attemptId,
        at,
        asSqlInteger(this.requireActiveRevision()),
        item.id
      );
      return this.getQueueItem(item.id);
    });
  }

  updateRunState(input: UpdateRunStateInput): StoredRun {
    return this.write(() => {
      const current = this.getRun(input.runId);
      if (current.descriptor.state === input.state) return current;
      if (input.suppressTerminalAttention === true && input.state !== "completed") {
        throw new StoreError("Only successful terminal Run attention can be suppressed.");
      }
      if (
        input.markScheduleRunRead === true
        && (current.descriptor.source !== "schedule" || input.state !== "completed")
      ) {
        throw new StoreError("Only a successful Scheduler Run can be born read.");
      }
      if (!RUN_TRANSITIONS[current.descriptor.state].has(input.state)) {
        throw new InvalidStateTransitionError("run", current.descriptor.state, input.state);
      }
      if (input.activeAttemptId !== undefined) {
        const attempt = this.getAttempt(input.activeAttemptId);
        if (attempt.descriptor.runId !== input.runId) {
          throw new StoreError("The active attempt does not belong to the run.");
        }
      }
      const now = this.now();
      const startedAt = input.startedAt ?? current.descriptor.startedAt ??
        (input.state === "running" ? now : undefined);
      const endedAt = input.endedAt ?? current.descriptor.endedAt ??
        (isTerminalRunState(input.state) ? now : undefined);
      this.database.prepare(`
        UPDATE runs SET
          state = ?, active_attempt_id = ?, started_at = ?, ended_at = ?, error_json = ?, revision = ?
        WHERE id = ?
      `).run(
        input.state,
        input.activeAttemptId ?? current.descriptor.activeAttemptId ?? null,
        startedAt ?? null,
        endedAt ?? null,
        input.error === undefined ? null : serializeJson(input.error),
        asSqlInteger(this.requireActiveRevision()),
        input.runId
      );
      if (current.descriptor.source === "schedule") {
        const terminal = isTerminalRunState(input.state);
        const existingDetail = (this.database.prepare(`
          SELECT detail_json FROM schedule_run_history WHERE run_id = ?
        `).get(input.runId) as Row | undefined)?.["detail_json"];
        const errorDetail = input.error === undefined
          ? undefined
          : scheduleHistoryDetailWithError(existingDetail, input.error);
        const terminalDetail = input.markScheduleRunRead === true
          ? scheduleRunDetailWithReadAt(
              errorDetail ?? (existingDetail === null || existingDetail === undefined
                ? undefined
                : parseJson<unknown>(stringValue(existingDetail))),
              endedAt ?? now
            )
          : errorDetail;
        this.database.prepare(`
          UPDATE schedule_run_history
          SET status = ?,
              finished_at = CASE WHEN ? IS NULL THEN NULL ELSE MAX(?, fired_at) END,
              detail_json = CASE WHEN ? IS NULL THEN detail_json ELSE ? END,
              revision = ?
          WHERE run_id = ?
        `).run(
          scheduleHistoryStatus(input.state),
          terminal ? 1 : null,
          terminal ? endedAt ?? now : null,
          terminalDetail === undefined ? null : 1,
          terminalDetail === undefined ? null : serializeJson(terminalDetail),
          asSqlInteger(this.requireActiveRevision()),
          input.runId
        );
      }
      const session = this.getSession(current.descriptor.sessionId);
      const sourceEvent = this.appendEvent({
        backendId: session.descriptor.backendId,
        targetId: session.descriptor.targetId,
        sessionId: session.descriptor.id,
        runId: input.runId,
        ...(input.activeAttemptId === undefined ? {} : { attemptId: input.activeAttemptId }),
        ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
        generation: session.descriptor.binding.generation,
        traceId: input.traceId,
        payload: {
          type: "run_state",
          state: input.state,
          ...(input.error === undefined ? {} : { error: input.error })
        }
      });
      if (input.state === "waiting") {
        this.recordSessionAttention({
          sessionId: session.descriptor.id,
          kind: "awaiting",
          sourceCursor: sourceEvent.globalCursor,
          traceId: `${input.traceId}:attention`,
          ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
          at: sourceEvent.emittedAt
        });
      } else if (isTerminalRunState(input.state)) {
        if (input.suppressTerminalAttention === true) {
          this.clearSessionAttentionFromLifecycle(
            session,
            sourceEvent,
            `${input.traceId}:attention-suppressed`,
            input.operationId
          );
        } else {
          this.recordTerminalSessionAttention(
            session,
            sourceEvent,
            input.state === "failed",
            `${input.traceId}:attention`,
            input.operationId
          );
        }
      } else if (input.state === "running" || input.state === "retrying") {
        this.clearSessionAttentionFromLifecycle(
          session,
          sourceEvent,
          `${input.traceId}:attention-progressed`,
          input.operationId
        );
      }
      return this.getRun(input.runId);
    });
  }

  finishAttempt(id: string, error?: PublicError, endedAt = this.now()): StoredAttempt {
    return this.write(() => {
      this.getAttempt(id);
      this.database.prepare(`
        UPDATE attempts SET ended_at = ?, error_json = ?, revision = ? WHERE id = ?
      `).run(
        endedAt,
        error === undefined ? null : serializeJson(error),
        asSqlInteger(this.requireActiveRevision()),
        id
      );
      return this.getAttempt(id);
    });
  }

  enqueueQueueItem(input: EnqueueInput): QueueItemRecord {
    return this.write(() => {
      const session = this.getSession(input.sessionId);
      this.assertSessionNotPendingScheduleDeletion(input.sessionId);
      const run = this.getRun(input.runId);
      if (run.descriptor.sessionId !== input.sessionId) {
        throw new StoreError("Queue item run does not belong to its session.");
      }
      const attempt = this.getAttempt(input.attemptId);
      if (attempt.descriptor.runId !== input.runId) {
        throw new StoreError("Queue item attempt does not belong to its run.");
      }
      this.getOperation(input.operationId);
      if (input.body.disposition !== input.disposition) {
        throw new StoreError("Queue disposition does not match the prompt body disposition.");
      }
      const createdAt = input.createdAt ?? this.now();
      const computedBodyHash = operationBodyHash(input.body);
      if (input.bodyHash !== undefined && input.bodyHash !== computedBodyHash) {
        throw new StoreError("Queue body hash does not match the canonical prompt body.");
      }
      const bodyHash = computedBodyHash;
      const positionRow = this.database.prepare(`
        SELECT COALESCE(MAX(position), -1) + 1 AS next_position
        FROM queue_items WHERE session_id = ?
      `).get(input.sessionId) as Row;
      const position = numberValue(positionRow["next_position"]);
      this.database.prepare(`
        INSERT INTO queue_items(
          id, session_id, run_id, attempt_id, operation_id, disposition, state,
          body_hash, body_json, execution_overrides_json, position, created_at, updated_at, revision
        ) VALUES (?, ?, ?, ?, ?, ?, 'accepted', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id,
        input.sessionId,
        input.runId,
        input.attemptId,
        input.operationId,
        input.disposition,
        bodyHash,
        serializeJson(input.body),
        input.executionOverrides === undefined ? null : serializeJson(input.executionOverrides),
        position,
        createdAt,
        createdAt,
        asSqlInteger(this.requireActiveRevision())
      );
      // Queue admission is the irreversible first-input boundary. Clear the
      // private blank-runtime recovery grant in this same transaction before
      // any Backend dispatch can observe the item.
      this.database.prepare(`
        DELETE FROM settings
        WHERE scope_type = 'session' AND scope_id = ? AND key = ?
      `).run(input.sessionId, NATIVE_BLANK_RECOVERY_SETTING_KEY);
      this.appendQueueEvent(
        this.getQueueItem(input.id),
        session,
        `queue:${input.id}:accepted`
      );
      return this.getQueueItem(input.id);
    });
  }

  getQueueItem(id: string): QueueItemRecord {
    this.assertOpen();
    const row = this.database.prepare("SELECT * FROM queue_items WHERE id = ?").get(id) as Row | undefined;
    if (row === undefined) throw new NotFoundError("Queue item", id);
    return queueItemFromRow(row, this.now());
  }

  findQueueItemByRunId(
    sessionId: string,
    runId: string,
    options: { readonly includeCleared?: boolean } = {}
  ): QueueItemRecord | undefined {
    this.assertOpen();
    const clearedFilter = options.includeCleared === true ? "" : `AND NOT EXISTS (
      SELECT 1 FROM session_reset_boundaries AS reset
      WHERE reset.session_id = item.session_id
        AND item.rowid <= reset.cleared_through_queue_rowid
    )`;
    const row = this.database.prepare(`
      SELECT item.* FROM queue_items AS item
      WHERE item.session_id = ? AND item.run_id = ? ${clearedFilter}
      ORDER BY item.created_at, item.id LIMIT 1
    `).get(nonBlank(sessionId, "Session ID"), nonBlank(runId, "Run ID")) as Row | undefined;
    return row === undefined ? undefined : queueItemFromRow(row, this.now());
  }

  listQueueItems(options: QueueItemListOptions = {}): QueueItemRecord[] {
    this.assertOpen();
    const filter = queueItemSqlFilter(options);
    const at = this.now();
    return (this.database.prepare(
      `SELECT item.* FROM queue_items AS item ${filter.where}
       ORDER BY item.position, item.created_at, item.id LIMIT ? OFFSET ?`
    ).all(...filter.params, normalizeLimit(options.limit, 1000), normalizeOffset(options.offset)) as Row[])
      .map((row) => queueItemFromRow(row, at));
  }

  countQueueItems(options: Omit<QueueItemListOptions, "limit" | "offset"> = {}): number {
    this.assertOpen();
    const filter = queueItemSqlFilter(options);
    const row = this.database.prepare(
      `SELECT COUNT(*) AS count FROM queue_items AS item ${filter.where}`
    ).get(...filter.params) as Row;
    return numberValue(row["count"]);
  }

  private assertQueueItemEditAuthority(
    queueItemId: string,
    connectionId: string | undefined,
    lockToken: string | undefined,
    at: number
  ): void {
    const row = this.database.prepare(`
      SELECT edit_lock_token, edit_lock_connection_id, edit_lock_expires_at
      FROM queue_items WHERE id = ?
    `).get(queueItemId) as Row;
    const expiresAt = optionalNumber("expiresAt", row["edit_lock_expires_at"]).expiresAt;
    const supplied = connectionId !== undefined || lockToken !== undefined;
    if (supplied && (connectionId === undefined || lockToken === undefined || expiresAt === undefined || expiresAt <= at)) {
      throw new StoreError("The queued input edit lock is missing or expired.");
    }
    if (!supplied && (expiresAt === undefined || expiresAt <= at)) return;
    if (
      connectionId === undefined || lockToken === undefined
      || row["edit_lock_connection_id"] !== connectionId
      || row["edit_lock_token"] !== queueLockToken(lockToken)
    ) {
      throw new StoreError("This queued input is being edited by another interaction.");
    }
  }

  private assertQueueInteractionAuthority(
    sessionId: string,
    connectionId: string | undefined,
    lockToken: string | undefined,
    at: number
  ): void {
    const row = this.database.prepare(`
      SELECT interaction_lock_token, interaction_lock_connection_id, interaction_lock_expires_at
      FROM queue_controls WHERE session_id = ?
    `).get(sessionId) as Row;
    const expiresAt = optionalNumber("expiresAt", row["interaction_lock_expires_at"]).expiresAt;
    const supplied = connectionId !== undefined || lockToken !== undefined;
    if (supplied && (connectionId === undefined || lockToken === undefined || expiresAt === undefined || expiresAt <= at)) {
      throw new StoreError("The queue interaction lock is missing or expired.");
    }
    if (!supplied && (expiresAt === undefined || expiresAt <= at)) return;
    if (
      connectionId === undefined || lockToken === undefined
      || row["interaction_lock_connection_id"] !== connectionId
      || row["interaction_lock_token"] !== queueLockToken(lockToken)
    ) {
      throw new StoreError("This queue is being reordered by another interaction.");
    }
  }

  setQueueItemEditLock(input: {
    readonly queueItemId: string;
    readonly connectionId: string;
    readonly lockToken: string;
    readonly locked: boolean;
    readonly ttlMs?: number;
    readonly traceId?: string;
    readonly at?: number;
  }): QueueItemRecord {
    return this.write(() => {
      const current = this.getQueueItem(input.queueItemId);
      if (input.locked && current.state !== "accepted") {
        throw new InvalidStateTransitionError("queue item edit lock", current.state, "accepted");
      }
      this.getConnection(input.connectionId);
      const token = queueLockToken(input.lockToken);
      const at = input.at ?? this.now();
      if (input.locked) {
        this.assertQueueInteractionAuthority(current.sessionId, undefined, undefined, at);
        const expiresAt = at + queueLockTtl(input.ttlMs);
        const result = this.database.prepare(`
          UPDATE queue_items
          SET edit_lock_token = ?, edit_lock_connection_id = ?, edit_lock_expires_at = ?
          WHERE id = ? AND state = 'accepted'
            AND (
              edit_lock_expires_at IS NULL OR edit_lock_expires_at <= ?
              OR (edit_lock_token = ? AND edit_lock_connection_id = ?)
            )
        `).run(token, input.connectionId, expiresAt, current.id, at, token, input.connectionId);
        if (result.changes !== 1) throw new StoreError("This queued input is already being edited.");
      } else {
        const result = this.database.prepare(`
          UPDATE queue_items
          SET edit_lock_token = NULL, edit_lock_connection_id = NULL, edit_lock_expires_at = NULL
          WHERE id = ? AND edit_lock_token = ? AND edit_lock_connection_id = ?
        `).run(current.id, token, input.connectionId);
        if (result.changes !== 1) {
          const row = this.database.prepare(`
            SELECT edit_lock_token, edit_lock_expires_at FROM queue_items WHERE id = ?
          `).get(current.id) as Row;
          const expiresAt = optionalNumber("expiresAt", row["edit_lock_expires_at"]).expiresAt;
          if (row["edit_lock_token"] !== null && (expiresAt === undefined || expiresAt > at)) {
            throw new StoreError("This queued input edit lock belongs to another interaction.");
          }
        }
      }
      const updated = this.getQueueItem(current.id);
      this.appendQueueEvent(
        updated,
        this.getSession(updated.sessionId),
        input.traceId ?? `queue:${updated.id}:edit-lock`
      );
      return updated;
    });
  }

  setQueueInteractionLock(input: {
    readonly sessionId: string;
    readonly connectionId: string;
    readonly lockToken: string;
    readonly locked: boolean;
    readonly ttlMs?: number;
    readonly traceId?: string;
    readonly at?: number;
  }): QueueControlRecord {
    return this.write(() => {
      const control = this.getQueueControl(input.sessionId);
      this.getConnection(input.connectionId);
      const token = queueLockToken(input.lockToken);
      const at = input.at ?? this.now();
      if (input.locked) {
        const expiresAt = at + queueLockTtl(input.ttlMs);
        const result = this.database.prepare(`
          UPDATE queue_controls
          SET interaction_lock_token = ?, interaction_lock_connection_id = ?, interaction_lock_expires_at = ?
          WHERE session_id = ?
            AND (
              interaction_lock_expires_at IS NULL OR interaction_lock_expires_at <= ?
              OR (interaction_lock_token = ? AND interaction_lock_connection_id = ?)
            )
        `).run(token, input.connectionId, expiresAt, control.sessionId, at, token, input.connectionId);
        if (result.changes !== 1) throw new StoreError("This queue is already being reordered.");
      } else {
        const result = this.database.prepare(`
          UPDATE queue_controls
          SET interaction_lock_token = NULL, interaction_lock_connection_id = NULL, interaction_lock_expires_at = NULL
          WHERE session_id = ? AND interaction_lock_token = ? AND interaction_lock_connection_id = ?
        `).run(control.sessionId, token, input.connectionId);
        if (result.changes !== 1) {
          const row = this.database.prepare(`
            SELECT interaction_lock_token, interaction_lock_expires_at
            FROM queue_controls WHERE session_id = ?
          `).get(control.sessionId) as Row;
          const expiresAt = optionalNumber("expiresAt", row["interaction_lock_expires_at"]).expiresAt;
          if (row["interaction_lock_token"] !== null && (expiresAt === undefined || expiresAt > at)) {
            throw new StoreError("This queue interaction lock belongs to another interaction.");
          }
        }
      }
      const updated = this.getQueueControl(control.sessionId);
      this.appendQueueControlEvent(
        updated,
        this.getSession(updated.sessionId),
        input.traceId ?? `queue:${updated.sessionId}:interaction-lock`
      );
      return updated;
    });
  }

  expireQueueLocks(input: {
    readonly sessionId: string;
    readonly traceId?: string;
    readonly at?: number;
  }): { readonly interactionLockExpired: boolean; readonly queueItemIds: readonly string[] } {
    return this.write(() => {
      const session = this.getSession(input.sessionId);
      const at = input.at ?? this.now();
      const controlResult = this.database.prepare(`
        UPDATE queue_controls
        SET interaction_lock_token = NULL, interaction_lock_connection_id = NULL,
            interaction_lock_expires_at = NULL
        WHERE session_id = ? AND interaction_lock_expires_at IS NOT NULL
          AND interaction_lock_expires_at <= ?
      `).run(session.descriptor.id, at);
      if (controlResult.changes === 1) {
        this.appendQueueControlEvent(
          this.getQueueControl(session.descriptor.id),
          session,
          input.traceId ?? `queue:${session.descriptor.id}:interaction-lock-expired`
        );
      }

      const rows = this.database.prepare(`
        SELECT id FROM queue_items
        WHERE session_id = ? AND edit_lock_expires_at IS NOT NULL
          AND edit_lock_expires_at <= ?
        ORDER BY position, created_at, id
      `).all(session.descriptor.id, at) as Row[];
      const queueItemIds = rows.map((row) => stringValue(row["id"]));
      for (const queueItemId of queueItemIds) {
        this.database.prepare(`
          UPDATE queue_items
          SET edit_lock_token = NULL, edit_lock_connection_id = NULL,
              edit_lock_expires_at = NULL
          WHERE id = ? AND edit_lock_expires_at IS NOT NULL
            AND edit_lock_expires_at <= ?
        `).run(queueItemId, at);
        this.appendQueueEvent(
          this.getQueueItem(queueItemId),
          session,
          input.traceId ?? `queue:${queueItemId}:edit-lock-expired`
        );
      }
      return { interactionLockExpired: controlResult.changes === 1, queueItemIds };
    });
  }

  editQueueItem(input: {
    readonly queueItemId: string;
    readonly body: PromptInput;
    readonly connectionId?: string;
    readonly lockToken?: string;
    readonly expectedRevision?: bigint;
    readonly traceId: string;
    readonly at?: number;
  }): QueueItemRecord {
    return this.write(() => {
      const current = this.getQueueItem(input.queueItemId);
      if (input.expectedRevision !== undefined && input.expectedRevision !== current.revision) {
        throw new RevisionConflictError("Queue item", current.id, input.expectedRevision, current.revision);
      }
      if (current.state !== "accepted") {
        throw new InvalidStateTransitionError("queue item edit", current.state, "accepted");
      }
      const at = input.at ?? this.now();
      this.assertQueueInteractionAuthority(current.sessionId, undefined, undefined, at);
      this.assertQueueItemEditAuthority(current.id, input.connectionId, input.lockToken, at);
      const result = this.database.prepare(`
        UPDATE queue_items
        SET disposition = ?, body_hash = ?, body_json = ?, updated_at = ?, revision = ?
        WHERE id = ? AND state = 'accepted' AND revision = ?
      `).run(
        input.body.disposition,
        operationBodyHash(input.body),
        serializeJson(input.body),
        at,
        asSqlInteger(this.requireActiveRevision()),
        current.id,
        asSqlInteger(current.revision)
      );
      if (result.changes !== 1) {
        const changed = this.getQueueItem(current.id);
        throw new RevisionConflictError("Queue item", current.id, current.revision, changed.revision);
      }
      const updated = this.getQueueItem(current.id);
      this.appendQueueEvent(updated, this.getSession(updated.sessionId), input.traceId);
      return updated;
    });
  }

  reorderQueueItem(input: {
    readonly queueItemId: string;
    readonly placement: QueuePlacement;
    readonly connectionId?: string;
    readonly lockToken?: string;
    readonly editLockToken?: string;
    readonly expectedRevision?: bigint;
    readonly traceId: string;
    readonly at?: number;
  }): QueueItemRecord {
    return this.transaction(() => {
      const current = this.getQueueItem(input.queueItemId);
      if (input.expectedRevision !== undefined && input.expectedRevision !== current.revision) {
        throw new RevisionConflictError("Queue item", current.id, input.expectedRevision, current.revision);
      }
      if (current.state !== "accepted") {
        throw new InvalidStateTransitionError("queue item reorder", current.state, "accepted");
      }
      const at = input.at ?? this.now();
      this.assertQueueInteractionAuthority(
        current.sessionId,
        input.lockToken === undefined ? undefined : input.connectionId,
        input.lockToken,
        at
      );
      this.assertQueueItemEditAuthority(
        current.id,
        input.editLockToken === undefined ? undefined : input.connectionId,
        input.editLockToken,
        at
      );
      const ordered = collectStorePages((offset, limit) => this.listQueueItems({
        sessionId: current.sessionId,
        states: ["accepted"],
        limit,
        offset
      })).filter((item) => item.id !== current.id);
      let index: number;
      if ("edge" in input.placement) {
        index = input.placement.edge === "first" ? 0 : ordered.length;
      } else {
        const anchorId = "beforeQueueItemId" in input.placement
          ? input.placement.beforeQueueItemId
          : input.placement.afterQueueItemId;
        const anchor = ordered.findIndex((item) => item.id === anchorId);
        if (anchor < 0) throw new NotFoundError("Queue placement anchor", anchorId);
        const anchorItem = ordered[anchor]!;
        if (anchorItem.sessionId !== current.sessionId || anchorItem.state !== "accepted") {
          throw new StoreError("Queue placement anchor must be pending in the same Session.");
        }
        index = "beforeQueueItemId" in input.placement ? anchor : anchor + 1;
      }
      ordered.splice(index, 0, current);
      const revision = asSqlInteger(this.requireActiveRevision());
      for (const [position, item] of ordered.entries()) {
        if (item.position === position && item.id !== current.id) continue;
        this.database.prepare(`
          UPDATE queue_items SET position = ?, updated_at = ?, revision = ?
          WHERE id = ? AND state = 'accepted'
        `).run(position, at, revision, item.id);
      }
      const updated = this.getQueueItem(current.id);
      this.appendQueueEvent(updated, this.getSession(updated.sessionId), input.traceId);
      return updated;
    });
  }

  getQueueControl(sessionId: string): QueueControlRecord {
    this.assertOpen();
    const row = this.database.prepare("SELECT * FROM queue_controls WHERE session_id = ?").get(sessionId) as Row | undefined;
    if (row === undefined) throw new NotFoundError("Queue control", sessionId);
    return queueControlFromRow(row, this.now());
  }

  listQueueControls(): QueueControlRecord[] {
    this.assertOpen();
    const at = this.now();
    return (this.database.prepare("SELECT * FROM queue_controls ORDER BY session_id").all() as Row[])
      .map((row) => queueControlFromRow(row, at));
  }

  setQueuePaused(input: {
    readonly sessionId: string;
    readonly paused: boolean;
    readonly reason?: string;
    readonly connectionId?: string;
    readonly expectedRevision?: bigint;
    readonly traceId: string;
    readonly at?: number;
  }): QueueControlRecord {
    return this.write(() => {
      const session = this.getSession(input.sessionId);
      const current = this.getQueueControl(input.sessionId);
      if (input.expectedRevision !== undefined && input.expectedRevision !== current.revision) {
        throw new RevisionConflictError("Queue control", input.sessionId, input.expectedRevision, current.revision);
      }
      if (current.paused === input.paused && (!input.paused || current.pauseReason === (input.reason ?? ""))) return current;
      if (input.connectionId !== undefined) this.getConnection(input.connectionId);
      const at = input.at ?? this.now();
      const result = this.database.prepare(`
        UPDATE queue_controls
        SET paused = ?, pause_reason = ?, paused_at = ?, paused_by_connection_id = ?,
            updated_at = ?, revision = ?
        WHERE session_id = ? AND revision = ?
      `).run(
        boolInt(input.paused),
        input.paused ? input.reason?.trim() || null : null,
        input.paused ? at : null,
        input.paused ? input.connectionId ?? null : null,
        at,
        asSqlInteger(this.requireActiveRevision()),
        input.sessionId,
        asSqlInteger(current.revision)
      );
      if (result.changes !== 1) {
        const changed = this.getQueueControl(input.sessionId);
        throw new RevisionConflictError("Queue control", input.sessionId, current.revision, changed.revision);
      }
      const updated = this.getQueueControl(input.sessionId);
      this.appendQueueControlEvent(updated, session, input.traceId);
      return updated;
    });
  }

  cancelQueueItem(input: {
    readonly queueItemId: string;
    readonly connectionId?: string;
    readonly expectedRevision?: bigint;
    readonly traceId: string;
    readonly at?: number;
  }): QueueItemRecord {
    return this.transaction(() => {
      const current = this.getQueueItem(input.queueItemId);
      if (input.expectedRevision !== undefined && input.expectedRevision !== current.revision) {
        throw new RevisionConflictError("Queue item", current.id, input.expectedRevision, current.revision);
      }
      if (current.state === "cancelled") return current;
      if (!QUEUE_TRANSITIONS[current.state].has("cancelled")) {
        throw new InvalidStateTransitionError("queue item", current.state, "cancelled");
      }
      const at = input.at ?? this.now();
      if (input.connectionId !== undefined) {
        this.getConnection(input.connectionId);
        this.assertQueueInteractionAuthority(current.sessionId, undefined, undefined, at);
        this.assertQueueItemEditAuthority(current.id, undefined, undefined, at);
      }
      const updated = this.updateQueueState({
        queueItemId: current.id,
        state: "cancelled",
        ...(current.attemptId === undefined ? {} : { attemptId: current.attemptId }),
        at,
        traceId: input.traceId
      });
      const run = this.getRun(current.runId);
      if (!isTerminalRunState(run.descriptor.state)) {
        this.updateRunState({
          runId: run.descriptor.id,
          state: "aborted",
          endedAt: at,
          ...(run.descriptor.activeAttemptId === undefined ? {} : { activeAttemptId: run.descriptor.activeAttemptId }),
          traceId: input.traceId,
          operationId: current.operationId
        });
      }
      return updated;
    });
  }

  claimNextQueueItem(options: {
    readonly sessionId: string;
    /** Candidate authority owned by the exact Adapter instance selected for dispatch. */
    readonly backendInstanceGeneration: number;
    readonly traceId?: string;
    readonly at?: number;
  }): QueueItemRecord | undefined {
    return this.write(() => {
      const sessionId = nonBlank(options.sessionId, "Session ID");
      if (!Number.isSafeInteger(options.backendInstanceGeneration) || options.backendInstanceGeneration < 0) {
        throw new StoreError("Queue claim Backend instance generation must be a non-negative safe integer.");
      }
      const at = options.at ?? this.now();
      const row = this.database.prepare(`
        SELECT q.id, q.attempt_id FROM queue_items q
        JOIN queue_controls control ON control.session_id = q.session_id
        JOIN product_sessions session ON session.id = q.session_id
        JOIN backends backend ON backend.id = session.backend_id
        JOIN attempts attempt ON attempt.id = q.attempt_id AND attempt.run_id = q.run_id
        WHERE q.state = 'accepted' AND q.backend_instance_generation IS NULL
          AND attempt.backend_instance_generation IS NULL
          AND q.session_id = ? AND control.paused = 0
          AND NOT EXISTS (
            SELECT 1 FROM queue_items preceding
            WHERE preceding.session_id = q.session_id
              AND preceding.state = 'accepted'
              AND preceding.backend_instance_generation IS NULL
              AND (
                preceding.position < q.position
                OR (
                  preceding.position = q.position
                  AND (
                    preceding.created_at < q.created_at
                    OR (preceding.created_at = q.created_at AND preceding.id < q.id)
                  )
                )
              )
          )
          AND (control.interaction_lock_expires_at IS NULL OR control.interaction_lock_expires_at <= ?)
          AND (q.edit_lock_expires_at IS NULL OR q.edit_lock_expires_at <= ?)
          AND backend.instance_generation = ?
          AND NOT EXISTS (
            SELECT 1
            FROM schedule_deletion_cleanups cleanup,
                 json_each(cleanup.generated_session_ids_json) owned
            WHERE cleanup.state = 'pending' AND cleanup.disposition <> 'keep'
              AND owned.value = q.session_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM session_lifecycle_cleanups cleanup
            WHERE cleanup.state = 'pending' AND cleanup.session_id = q.session_id
          )
        ORDER BY q.position, q.created_at, q.id LIMIT 1
      `).get(sessionId, at, at, options.backendInstanceGeneration) as Row | undefined;
      if (row === undefined) return undefined;
      const id = stringValue(row["id"]);
      const attemptId = stringValue(row["attempt_id"]);
      const attemptResult = this.database.prepare(`
        UPDATE attempts
        SET backend_instance_generation = ?, revision = ?
        WHERE id = ? AND backend_instance_generation IS NULL
          AND EXISTS (
            SELECT 1
            FROM queue_items queue
            JOIN product_sessions session ON session.id = queue.session_id
            JOIN backends backend ON backend.id = session.backend_id
            WHERE queue.id = ? AND queue.state = 'accepted'
              AND queue.attempt_id = attempts.id
              AND queue.run_id = attempts.run_id
              AND queue.backend_instance_generation IS NULL
              AND backend.instance_generation = ?
          )
      `).run(
        options.backendInstanceGeneration,
        asSqlInteger(this.requireActiveRevision()),
        attemptId,
        id,
        options.backendInstanceGeneration
      );
      if (attemptResult.changes !== 1) {
        throw new StoreError("The queue Attempt Backend instance claim lost its authority fence.");
      }
      const result = this.database.prepare(`
        UPDATE queue_items
        SET state = 'dispatching', backend_instance_generation = ?,
            dispatched_at = ?, updated_at = ?, revision = ?
        WHERE id = ? AND state = 'accepted' AND backend_instance_generation IS NULL
          AND EXISTS (
            SELECT 1
            FROM product_sessions session
            JOIN backends backend ON backend.id = session.backend_id
            WHERE session.id = queue_items.session_id
              AND backend.instance_generation = ?
          )
          AND EXISTS (
            SELECT 1 FROM attempts attempt
            WHERE attempt.id = queue_items.attempt_id
              AND attempt.run_id = queue_items.run_id
              AND attempt.backend_instance_generation = ?
          )
      `).run(
        options.backendInstanceGeneration,
        at,
        at,
        asSqlInteger(this.requireActiveRevision()),
        id,
        options.backendInstanceGeneration,
        options.backendInstanceGeneration
      );
      if (result.changes !== 1) {
        throw new StoreError("The queue Backend instance claim lost its authority fence.");
      }
      const item = this.getQueueItem(id);
      this.appendQueueEvent(
        item,
        this.getSession(item.sessionId),
        options.traceId ?? `queue:${id}:dispatching`
      );
      return item;
    });
  }

  updateQueueState(input: UpdateQueueStateInput): QueueItemRecord {
    return this.write(() => {
      const current = this.getQueueItem(input.queueItemId);
      if (current.state === input.state) return current;
      if (!QUEUE_TRANSITIONS[current.state].has(input.state)) {
        throw new InvalidStateTransitionError("queue item", current.state, input.state);
      }
      if (
        current.backendInstanceGeneration !== undefined &&
        input.attemptId !== undefined &&
        input.attemptId !== current.attemptId
      ) {
        throw new StoreError("A dispatched queue transition cannot replace its exact Attempt owner.");
      }
      const effectiveAttemptId = input.attemptId ?? current.attemptId;
      if (["backend_accepted", "dispatch_unknown", "completed"].includes(input.state)) {
        if (effectiveAttemptId === undefined) {
          throw new StoreError("A dispatched queue state requires an Attempt owner.");
        }
        const attempt = this.getAttempt(effectiveAttemptId);
        if (attempt.descriptor.runId !== current.runId) {
          throw new StoreError("Queue item attempt does not belong to its run.");
        }
        if (attempt.descriptor.backendInstanceGeneration !== current.backendInstanceGeneration) {
          throw new StoreError("Queue item and Attempt Backend instance generations do not match.");
        }
      }
      if (input.projectionAttemptId !== undefined) {
        const projectionAttempt = this.getAttempt(input.projectionAttemptId);
        const session = this.getSession(current.sessionId);
        if (
          projectionAttempt.descriptor.runId !== current.runId
          || projectionAttempt.descriptor.generation !== session.descriptor.binding.generation
          || projectionAttempt.descriptor.backendInstanceGeneration !== current.backendInstanceGeneration
        ) throw new StoreError("Queue projection Attempt does not match its Run, product generation, or Backend instance owner.");
      }
      const at = input.at ?? this.now();
      this.database.prepare(`
        UPDATE queue_items SET
          state = ?, attempt_id = ?, updated_at = ?,
          backend_accepted_at = CASE WHEN ? = 'backend_accepted' THEN ? ELSE backend_accepted_at END,
          completed_at = CASE WHEN ? IN ('completed', 'cancelled', 'failed') THEN ? ELSE completed_at END,
          error_json = ?, revision = ?
        WHERE id = ?
      `).run(
        input.state,
        effectiveAttemptId ?? null,
        at,
        input.state,
        at,
        input.state,
        at,
        input.error === undefined ? null : serializeJson(input.error),
        asSqlInteger(this.requireActiveRevision()),
        input.queueItemId
      );
      const updated = this.getQueueItem(input.queueItemId);
      this.appendQueueEvent(
        updated,
        this.getSession(updated.sessionId),
        input.traceId,
        input.projectionAttemptId
      );
      return updated;
    });
  }

  appendEvent(input: AppendEventInput): PersistedEvent {
    return this.write(() => {
      const session = this.getSession(input.sessionId);
      if (
        session.descriptor.backendId !== input.backendId ||
        session.descriptor.targetId !== input.targetId
      ) {
        throw new StoreError("Event routing does not match the product session.");
      }
      if (session.descriptor.binding.generation !== input.generation) {
        throw new StaleGenerationError(session.descriptor.binding.generation, input.generation);
      }
      if (input.runId !== undefined) {
        const run = this.getRun(input.runId);
        if (run.descriptor.sessionId !== input.sessionId) {
          throw new StoreError("Event run does not belong to the product session.");
        }
      }
      if (input.attemptId !== undefined) {
        const attempt = this.getAttempt(input.attemptId);
        if (input.runId === undefined || attempt.descriptor.runId !== input.runId) {
          throw new StoreError("Event attempt does not belong to its run.");
        }
        if (attempt.descriptor.generation !== input.generation) {
          throw new StaleGenerationError(attempt.descriptor.generation, input.generation);
        }
      }
      if (input.operationId !== undefined) this.getOperation(input.operationId);
      const payload = redactSubagentEventPayload(input.payload);
      this.validateSubagentEventInput({ ...input, payload });
      const counter = this.database.prepare(`
        UPDATE session_event_counters
        SET last_sequence = last_sequence + 1
        WHERE session_id = ?
        RETURNING last_sequence
      `).get(input.sessionId) as Row | undefined;
      if (counter === undefined) throw new StoreError(`Event counter is missing for session ${input.sessionId}.`);
      const sequence = toBigInt(counter["last_sequence"]);
      const revision = this.requireActiveRevision();
      const emittedAt = input.emittedAt ?? this.now();
      const id = input.id ?? this.idFactory();
      const traceId = nonBlank(redactSecrets(input.traceId), "Event trace ID");
      const namespace = input.metadata === undefined
        ? undefined
        : nonBlank(redactSecrets(input.metadata.namespace), "Event metadata namespace");
      const insert = this.database.prepare(`
        INSERT INTO events(
          id, revision, session_sequence, emitted_at, backend_id, target_id, session_id,
          run_id, attempt_id, operation_id, generation, trace_id, payload_json,
          namespace, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        asSqlInteger(revision),
        asSqlInteger(sequence),
        emittedAt,
        input.backendId,
        input.targetId,
        input.sessionId,
        input.runId ?? null,
        input.attemptId ?? null,
        input.operationId ?? null,
        input.generation,
        traceId,
        serializeJson({ payload, pi: input.pi }),
        namespace ?? null,
        input.metadata === undefined ? null : serializeJson(input.metadata.fields)
      );
      const event: PersistedEvent = {
        id,
        globalCursor: toBigInt(insert.lastInsertRowid),
        sequence,
        revision,
        emittedAt,
        backendId: input.backendId,
        targetId: input.targetId,
        sessionId: input.sessionId,
        ...(input.runId === undefined ? {} : { runId: input.runId }),
        ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
        ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
        generation: input.generation,
        traceId,
        payload: parseJson<{ payload: EventPayload }>(serializeJson({ payload })).payload,
        ...(input.pi === undefined
          ? {}
          : { pi: parseJson<{ pi: NonNullable<AppendEventInput["pi"]> }>(serializeJson({ pi: input.pi })).pi }),
        ...(input.metadata === undefined
          ? {}
          : {
            metadata: {
              namespace: namespace as string,
              fields: parseJson<Readonly<Record<string, string | number | boolean>>>(
                serializeJson(input.metadata.fields)
              )
            }
          })
      };
      this.indexNativeHistory(event);
      this.indexVisibleMessage(event);
      this.currentFrame().events.push(event);
      if (event.payload.type === "error" && event.payload.terminal) {
        this.recordSessionAttention({
          sessionId: event.sessionId,
          kind: "error",
          sourceCursor: event.globalCursor,
          traceId: `${event.traceId}:attention`,
          ...(event.operationId === undefined ? {} : { operationId: event.operationId }),
          at: event.emittedAt
        });
      } else if (event.payload.type === "done") {
        const scheduleOwnedSuccess = event.payload.outcome === "completed" && event.runId !== undefined &&
          this.findRun(event.runId)?.descriptor.source === "schedule";
        if (!scheduleOwnedSuccess) {
          this.recordTerminalSessionAttention(
            session,
            event,
            event.payload.outcome === "failed",
            `${event.traceId}:attention`,
            event.operationId
          );
        }
      } else if (event.payload.type === "native_session_changed" || event.payload.type === "session_reset") {
        this.clearSessionAttentionFromLifecycle(
          session,
          event,
          `${event.traceId}:attention-generation`,
          event.operationId
        );
      }
      return event;
    });
  }

  /**
   * Idempotently append a deterministically identified projection event. An
   * existing ID is accepted only when its immutable native projection matches;
   * a hash collision or changed native entry fails closed.
   */
  appendEventIfAbsent(input: AppendEventInput & { readonly id: string }): PersistedEvent {
    return this.write(() => {
      const row = this.database.prepare("SELECT * FROM events WHERE id = ?").get(input.id) as Row | undefined;
      if (row === undefined) return this.appendEvent(input);
      const existing = eventFromRow(row);
      const sameProjection =
        existing.backendId === input.backendId &&
        existing.targetId === input.targetId &&
        existing.sessionId === input.sessionId &&
        serializeJson(existing.payload) === serializeJson(input.payload) &&
        serializeJson(existing.pi ?? null) === serializeJson(input.pi ?? null) &&
        serializeJson(existing.metadata ?? null) === serializeJson(input.metadata ?? null);
      if (!sameProjection) {
        throw new StoreError(`Deterministic event ID collision for ${input.id}.`);
      }
      return existing;
    });
  }

  findLatestNativeSessionChange(sessionId: string): PersistedEvent | undefined {
    this.assertOpen();
    const row = this.database.prepare(`
      SELECT * FROM events
      WHERE session_id = ?
        AND json_extract(payload_json, '$.payload.type') = 'native_session_changed'
      ORDER BY global_cursor DESC
      LIMIT 1
    `).get(sessionId) as Row | undefined;
    return row === undefined ? undefined : eventFromRow(row);
  }

  hasVisibleWorkspaceDiff(sessionId: string, changeSetId: string): boolean {
    this.assertOpen();
    const row = this.database.prepare(`
      SELECT 1
      FROM events AS event
      LEFT JOIN message_event_tombstones AS tombstone ON tombstone.event_id = event.id
      WHERE event.session_id = ?
        AND tombstone.event_id IS NULL
        AND json_extract(event.payload_json, '$.payload.type') = 'workspace_diff'
        AND json_extract(event.payload_json, '$.payload.changeSetId') = ?
      LIMIT 1
    `).get(
      nonBlank(sessionId, "Session ID"),
      nonBlank(changeSetId, "Workspace change-set ID")
    ) as Row | undefined;
    return row !== undefined;
  }

  findEvent(eventId: string, options: { readonly includeTombstoned?: boolean } = {}): PersistedEvent | undefined {
    this.assertOpen();
    const normalizedEventId = nonBlank(eventId, "Event ID");
    const row = this.database.prepare(`
      SELECT event.*
      FROM events AS event
      LEFT JOIN message_event_tombstones AS tombstone ON tombstone.event_id = event.id
      WHERE event.id = ? ${options.includeTombstoned === true ? "" : "AND tombstone.event_id IS NULL"}
      LIMIT 1
    `).get(normalizedEventId) as Row | undefined;
    return row === undefined ? undefined : eventFromRow(row);
  }

  /** Resolves a product message anchor only when it is still visible in the
   * source task's current durable timeline branch. */
  findVisibleSessionMessageOrigin(input: {
    readonly sessionId: string;
    readonly eventId?: string;
    readonly nativeBoundaryId?: string;
  }): { readonly messageId: string; readonly eventId: string } | undefined {
    this.assertOpen();
    const sessionId = nonBlank(input.sessionId, "Session message origin Session ID");
    this.getSession(sessionId);
    const nativeVisibility = this.nativeMessageSearchVisibility(
      { kind: "session", id: sessionId },
      this.latestEventCursor()
    );
    const clauses = [
      "event.session_id = ?",
      "tombstone.event_id IS NULL",
      "json_extract(event.payload_json, '$.payload.type') = 'message_complete'",
      "json_extract(event.payload_json, '$.payload.automaticContinuation') IS NULL"
    ];
    const params: Array<string | number | bigint | null> = [...(nativeVisibility?.params ?? []), sessionId];
    if (input.eventId !== undefined) {
      clauses.push("event.id = ?");
      params.push(nonBlank(input.eventId, "Session message origin Event ID"));
    }
    if (input.nativeBoundaryId !== undefined) {
      const boundaryId = nonBlank(input.nativeBoundaryId, "Session message origin native boundary ID");
      clauses.push(`(
        json_extract(event.payload_json, '$.payload.nativeHistory.identity.entryId') = ?
        OR (
          json_extract(event.payload_json, '$.payload.role') = 'user'
          AND json_extract(event.payload_json, '$.payload.nativeHistory.identity.parentEntryId') = ?
        )
      )`);
      params.push(boundaryId, boundaryId);
    }
    const ctePrefix = nativeVisibility === undefined ? "" : `WITH RECURSIVE ${nativeVisibility.ctes}`;
    const row = this.database.prepare(`
      ${ctePrefix}
      SELECT event.*
      FROM events AS event
      LEFT JOIN message_event_tombstones AS tombstone ON tombstone.event_id = event.id
      WHERE ${clauses.join(" AND ")}
        ${nativeVisibility?.clause("event") ?? ""}
      ORDER BY event.global_cursor DESC
      LIMIT 1
    `).get(...params) as Row | undefined;
    if (row === undefined) return undefined;
    const event = eventFromRow(row);
    return { messageId: sessionTimelineMessageId(event), eventId: event.id };
  }

  /**
   * Durably claims a service-owned external effect. Unlike the authorized
   * variant this is for internal peers such as Scheduler, so no UI connection
   * is attached to the operation. Product state is committed only by
   * completeDeferredEffectOperation after the effect succeeds.
   */
  claimDeferredEffectOperation<T>(
    input: OperationInput,
    validate?: (store: this) => void
  ): DeferredEffectOperationClaim<T> {
    const bodyHash = operationBodyHash(input.body);
    try {
      return this.transaction(() => {
        const existing = this.findOperation<T>(input.id);
        if (existing !== undefined) {
          if (existing.connectionId !== undefined) {
            throw new AuthorizationError("The operation belongs to a client connection.");
          }
          if (existing.kind !== input.kind) {
            throw new OperationConflictError(
              input.id,
              `${existing.kind}:${existing.bodyHash}`,
              `${input.kind}:${bodyHash}`
            );
          }
          const replay = replayOperation(existing, bodyHash);
          return {
            claimed: false,
            replayed: true,
            value: replay.value,
            operation: replay.operation
          };
        }
        const createdAt = input.createdAt ?? this.now();
        this.database.prepare(`
          INSERT INTO operations(
            id, connection_id, kind, body_json, body_hash, completion_mode,
            status, created_at, updated_at, revision
          ) VALUES (?, NULL, ?, ?, ?, 'external_effect', 'started', ?, ?, ?)
        `).run(
          input.id,
          nonBlank(input.kind, "Operation kind"),
          serializeJson(input.body),
          bodyHash,
          createdAt,
          createdAt,
          asSqlInteger(this.requireActiveRevision())
        );
        validate?.(this);
        return {
          claimed: true,
          replayed: false,
          operation: this.getOperation<T>(input.id)
        };
      });
    } catch (error) {
      if (
        error instanceof AuthorizationError ||
        error instanceof OperationConflictError ||
        error instanceof OperationInProgressError ||
        error instanceof OperationPreviouslyFailedError ||
        error instanceof AsyncTransactionError
      ) throw error;
      this.persistOperationFailure(input, bodyHash, error, "external_effect");
      throw error;
    }
  }

  completeDeferredEffectOperation<T>(
    operationId: string,
    expectedBodyHash: string,
    callback: (store: this) => T
  ): OperationExecution<T> {
    return this.transaction(() => {
      const operation = this.getOperation<T>(operationId);
      if (operation.connectionId !== undefined) {
        throw new AuthorizationError("The operation belongs to a client connection.");
      }
      assertEffectOperation(operation, expectedBodyHash);
      if (operation.status === "failed") {
        throw new OperationPreviouslyFailedError(operation.id, operation.error);
      }
      if (operation.status === "completed") {
        if (!("response" in operation)) throw new StoreError(`Operation ${operation.id} has no response.`);
        return { replayed: true, value: operation.response as T, operation };
      }
      const value = callback(this);
      if (isPromiseLike(value)) throw new AsyncTransactionError();
      const result = this.database.prepare(`
        UPDATE operations
        SET status = 'completed', response_json = ?, error_json = NULL,
            updated_at = ?, revision = ?
        WHERE id = ? AND connection_id IS NULL
          AND status = 'started' AND completion_mode = 'external_effect'
      `).run(
        serializeJson(value),
        this.now(),
        asSqlInteger(this.requireActiveRevision()),
        operationId
      );
      if (result.changes !== 1) throw new OperationInProgressError(operationId);
      return {
        replayed: false,
        value,
        operation: this.getOperation<T>(operationId)
      };
    });
  }

  /**
   * Atomically hides the selected durable events, removes every derived search
   * representation, arms a non-content native rebuild marker, and only then
   * publishes the typed deletion event.
   */
  commitMessageDeletion(input: {
    readonly sessionId: string;
    readonly requestedEventId: string;
    readonly deletedEventIds: readonly string[];
    readonly operationId: string;
    readonly traceId: string;
    readonly at?: number;
  }): { readonly event: PersistedEvent; readonly deletedEventIds: readonly string[] } {
    return this.write(() => {
      const sessionId = nonBlank(input.sessionId, "Message deletion Session ID");
      const requestedEventId = nonBlank(input.requestedEventId, "Requested message Event ID");
      const operationId = nonBlank(input.operationId, "Message deletion Operation ID");
      const session = this.getSession(sessionId);
      this.getOperation(operationId);
      const deletedEventIds = [...new Set(input.deletedEventIds.map((eventId) =>
        nonBlank(eventId, "Deleted message Event ID")))];
      if (deletedEventIds.length === 0 || deletedEventIds.length > 10_000) {
        throw new StoreError("Message deletion must contain between 1 and 10000 durable Events.");
      }
      if (!deletedEventIds.includes(requestedEventId)) {
        throw new StoreError("Message deletion does not contain the requested Event.");
      }
      const lookup = this.database.prepare(`
        SELECT event.global_cursor, event.session_id, tombstone.event_id AS tombstoned
        FROM events AS event
        LEFT JOIN message_event_tombstones AS tombstone ON tombstone.event_id = event.id
        WHERE event.id = ?
      `);
      const rows = deletedEventIds.map((eventId) => ({
        eventId,
        row: lookup.get(eventId) as Row | undefined
      }));
      for (const candidate of rows) {
        if (candidate.row === undefined || candidate.row["session_id"] !== sessionId || candidate.row["tombstoned"] !== null) {
          throw new NotFoundError("Visible Session event", candidate.eventId);
        }
      }
      const existingRebuild = this.findPendingContextRebuild(sessionId);
      if (existingRebuild?.state === "running") {
        throw new StoreError("Native context rebuild is already running for this Session.");
      }
      if (existingRebuild !== undefined && existingRebuild.reason !== "message_deletion") {
        throw new StoreError("An unhealthy native context must be replaced before messages can be deleted.");
      }
      if (
        existingRebuild !== undefined &&
        existingRebuild.sourceNativeOpaqueRef !== session.descriptor.binding.opaqueRef
      ) {
        throw new StoreError("Pending context rebuild belongs to a different native binding.");
      }

      const at = input.at ?? this.now();
      const revision = asSqlInteger(this.requireActiveRevision());
      const insertTombstone = this.database.prepare(`
        INSERT INTO message_event_tombstones(
          event_id, session_id, deletion_operation_id, deleted_at, revision
        ) VALUES (?, ?, ?, ?, ?)
      `);
      for (const candidate of rows) {
        const cursor = toBigInt(candidate.row!["global_cursor"]);
        insertTombstone.run(candidate.eventId, sessionId, operationId, at, revision);
        this.database.prepare("DELETE FROM message_search_fts WHERE rowid = ?")
          .run(asSqlInteger(cursor));
        if (this.messageVectorAvailable) {
          this.database.prepare(`UPDATE ${MESSAGE_SEARCH_VECTOR_TABLE} SET live = 0 WHERE rowid = ?`)
            .run(asSqlInteger(cursor));
        }
        this.database.prepare("DELETE FROM message_embedding_records WHERE event_cursor = ?")
          .run(asSqlInteger(cursor));
        this.database.prepare("DELETE FROM message_embedding_jobs WHERE event_cursor = ?")
          .run(asSqlInteger(cursor));
      }
      this.refreshNativeHistoryCanonicalIdentities(sessionId);
      this.refreshNativeHistoryActiveEntries(sessionId);
      this.database.prepare(`
        INSERT INTO session_context_rebuilds(
          session_id, latest_deletion_operation_id, source_native_opaque_ref,
          state, claim_token, claimed_at, created_at, updated_at, revision,
          reason, source_run_id, source_queue_item_id, source_input_pending, replay_safe
        ) VALUES (?, ?, ?, 'pending', NULL, NULL, ?, ?, ?, 'message_deletion', NULL, NULL, 0, 0)
        ON CONFLICT(session_id) DO UPDATE SET
          latest_deletion_operation_id = excluded.latest_deletion_operation_id,
          source_native_opaque_ref = excluded.source_native_opaque_ref,
          state = 'pending', claim_token = NULL, claimed_at = NULL,
          reason = 'message_deletion', source_run_id = NULL,
          source_queue_item_id = NULL, source_input_pending = 0, replay_safe = 0,
          updated_at = excluded.updated_at, revision = excluded.revision
      `).run(
        sessionId,
        operationId,
        session.descriptor.binding.opaqueRef,
        at,
        at,
        revision
      );
      const event = this.appendEvent({
        backendId: session.descriptor.backendId,
        targetId: session.descriptor.targetId,
        sessionId,
        operationId,
        generation: session.descriptor.binding.generation,
        emittedAt: at,
        traceId: input.traceId,
        payload: { type: "message_deleted", requestedEventId, deletedEventIds }
      });
      return { event, deletedEventIds };
    });
  }

  findPendingContextRebuild(sessionId: string): PendingContextRebuild | undefined {
    this.assertOpen();
    const row = this.database.prepare(
      "SELECT * FROM session_context_rebuilds WHERE session_id = ?"
    ).get(nonBlank(sessionId, "Context rebuild Session ID")) as Row | undefined;
    return row === undefined ? undefined : contextRebuildFromRow(row);
  }

  /**
   * Arm a content-free native recovery fence after the typed terminal error is
   * durable. Repeated terminal frames are idempotent and never displace an
   * earlier boundary for the same native binding.
   */
  armPendingContextRebuild(input: {
    readonly sessionId: string;
    readonly reason: "context_overflow" | "prompt_timeout";
    readonly operationId: string;
    readonly sourceRunId: string;
    readonly sourceQueueItemId: string;
    readonly sourceInputPending: boolean;
    readonly replaySafe: boolean;
    readonly at?: number;
  }): PendingContextRebuild {
    return this.write(() => {
      const session = this.getSession(nonBlank(input.sessionId, "Context rebuild Session ID"));
      const operation = this.getOperation(nonBlank(input.operationId, "Context rebuild Operation ID"));
      const run = this.getRun(nonBlank(input.sourceRunId, "Context rebuild source Run ID"));
      const queueItem = this.getQueueItem(nonBlank(input.sourceQueueItemId, "Context rebuild source Queue Item ID"));
      if (
        run.descriptor.sessionId !== session.descriptor.id ||
        queueItem.sessionId !== session.descriptor.id ||
        queueItem.runId !== run.descriptor.id ||
        queueItem.operationId !== operation.id
      ) {
        throw new StoreError("Context rebuild source identities do not share one durable input.");
      }
      if (input.replaySafe && (input.reason !== "context_overflow" || !input.sourceInputPending)) {
        throw new StoreError("Only a pending context-overflow input can be replay-safe.");
      }
      const existing = this.findPendingContextRebuild(session.descriptor.id);
      if (existing !== undefined) return existing;
      const at = input.at ?? this.now();
      this.database.prepare(`
        INSERT INTO session_context_rebuilds(
          session_id, latest_deletion_operation_id, source_native_opaque_ref,
          state, claim_token, claimed_at, created_at, updated_at, revision,
          reason, source_run_id, source_queue_item_id, source_input_pending, replay_safe
        ) VALUES (?, ?, ?, 'pending', NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        session.descriptor.id,
        operation.id,
        session.descriptor.binding.opaqueRef,
        at,
        at,
        asSqlInteger(this.requireActiveRevision()),
        input.reason,
        run.descriptor.id,
        queueItem.id,
        boolInt(input.sourceInputPending),
        boolInt(input.replaySafe)
      );
      return this.findPendingContextRebuild(session.descriptor.id)!;
    });
  }

  recoverPendingContextRebuilds(at = this.now()): number {
    this.assertOpen();
    return this.transaction(() => Number(this.database.prepare(`
      UPDATE session_context_rebuilds
      SET state = 'pending', claim_token = NULL, claimed_at = NULL,
          updated_at = ?, revision = ?
      WHERE state = 'running'
    `).run(at, asSqlInteger(this.requireActiveRevision())).changes));
  }

  claimPendingContextRebuild(sessionId: string, at = this.now()): ContextRebuildClaim | undefined {
    return this.write(() => {
      const current = this.findPendingContextRebuild(sessionId);
      if (current === undefined || current.state !== "pending") return undefined;
      const claimToken = nonBlank(this.idFactory(), "Context rebuild claim token");
      const result = this.database.prepare(`
        UPDATE session_context_rebuilds
        SET state = 'running', claim_token = ?, claimed_at = ?, updated_at = ?, revision = ?
        WHERE session_id = ? AND state = 'pending' AND revision = ?
      `).run(
        claimToken,
        at,
        at,
        asSqlInteger(this.requireActiveRevision()),
        current.sessionId,
        asSqlInteger(current.revision)
      );
      if (Number(result.changes) !== 1) return undefined;
      const claimed = this.findPendingContextRebuild(current.sessionId);
      if (claimed?.state !== "running" || claimed.claimToken !== claimToken || claimed.claimedAt === undefined) {
        throw new StoreError("Context rebuild claim was not durably fenced.");
      }
      return claimed as ContextRebuildClaim;
    });
  }

  releasePendingContextRebuild(sessionId: string, claimToken: string, at = this.now()): boolean {
    return this.write(() => Number(this.database.prepare(`
      UPDATE session_context_rebuilds
      SET state = 'pending', claim_token = NULL, claimed_at = NULL,
          updated_at = ?, revision = ?
      WHERE session_id = ? AND state = 'running' AND claim_token = ?
    `).run(
      at,
      asSqlInteger(this.requireActiveRevision()),
      nonBlank(sessionId, "Context rebuild Session ID"),
      nonBlank(claimToken, "Context rebuild claim token")
    ).changes) === 1);
  }

  completePendingContextRebuild(input: {
    readonly sessionId: string;
    readonly claimToken: string;
    readonly binding: SessionDescriptor["binding"];
    readonly operationId?: string;
    readonly handoff?: string;
    readonly replayScheduled?: boolean;
    readonly traceId: string;
    readonly at?: number;
  }): StoredSession {
    return this.write(() => {
      const pending = this.findPendingContextRebuild(input.sessionId);
      if (pending?.state !== "running" || pending.claimToken !== input.claimToken) {
        throw new StoreError("Context rebuild completion does not own the durable claim.");
      }
      const current = this.getSession(input.sessionId);
      if (current.descriptor.binding.opaqueRef !== pending.sourceNativeOpaqueRef) {
        throw new StoreError("Session native binding changed while context rebuild was pending.");
      }
      if (input.binding.generation <= current.descriptor.binding.generation) {
        throw new StaleGenerationError(current.descriptor.binding.generation + 1, input.binding.generation);
      }
      const at = input.at ?? this.now();
      const handoff = input.handoff === undefined ? undefined : redactSecrets(input.handoff).trim();
      if (pending.reason !== "message_deletion" && (!handoff || Buffer.byteLength(handoff, "utf8") > 512 * 1024)) {
        throw new StoreError("Unhealthy native context rebuild requires a bounded redacted handoff.");
      }
      if (pending.sourceRunId !== undefined && pending.sourceQueueItemId !== undefined) {
        const recoveryError: PublicError = {
          code: "NATIVE_CONTEXT_REPLACED",
          message: pending.reason === "prompt_timeout"
            ? "The native prompt acknowledgement timed out, so its context was replaced before another dispatch."
            : "The native context reached its context window limit and was replaced before another dispatch.",
          phase: "context_rebuild",
          retryable: false,
          stateMayHaveChanged: pending.reason === "prompt_timeout" || !pending.sourceInputPending,
          recovery: pending.replaySafe
            ? "The Host admitted one fenced replay of the unchanged user input."
            : "Retry explicitly only if the owning workflow determines that it is safe."
        };
        const sourceItem = this.getQueueItem(pending.sourceQueueItemId);
        if (sourceItem.state !== "completed" && sourceItem.state !== "cancelled" && sourceItem.state !== "failed") {
          this.updateQueueState({
            queueItemId: sourceItem.id,
            state: "failed",
            ...(sourceItem.attemptId === undefined ? {} : { attemptId: sourceItem.attemptId }),
            error: recoveryError,
            at,
            traceId: `${input.traceId}:source-queue`
          });
        }
        const sourceRun = this.getRun(pending.sourceRunId);
        if (!isTerminalRunState(sourceRun.descriptor.state)) {
          this.updateRunState({
            runId: sourceRun.descriptor.id,
            state: "failed",
            ...(sourceRun.descriptor.activeAttemptId === undefined
              ? {}
              : { activeAttemptId: sourceRun.descriptor.activeAttemptId }),
            error: recoveryError,
            endedAt: at,
            traceId: `${input.traceId}:source-run`,
            operationId: pending.latestDeletionOperationId
          });
        }
        if (sourceRun.descriptor.activeAttemptId !== undefined) {
          const attempt = this.getAttempt(sourceRun.descriptor.activeAttemptId);
          if (attempt.descriptor.endedAt === undefined) {
            this.finishAttempt(attempt.descriptor.id, recoveryError, at);
          }
        }
      }
      const refreshed = this.getSession(input.sessionId);
      if (refreshed.descriptor.binding.opaqueRef !== pending.sourceNativeOpaqueRef) {
        throw new StoreError("Session native binding changed while its source dispatch was reconciled.");
      }
      const updated = this.updateSession(input.sessionId, { binding: input.binding }, refreshed.revision, at);
      const deleted = this.database.prepare(`
        DELETE FROM session_context_rebuilds
        WHERE session_id = ? AND state = 'running' AND claim_token = ?
      `).run(input.sessionId, input.claimToken);
      if (Number(deleted.changes) !== 1) {
        throw new StoreError("Context rebuild claim changed before completion.");
      }
      if (pending.reason !== "message_deletion") {
        this.appendEvent({
          backendId: updated.descriptor.backendId,
          targetId: updated.descriptor.targetId,
          sessionId: updated.descriptor.id,
          ...(pending.sourceRunId === undefined ? {} : { runId: pending.sourceRunId }),
          ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
          generation: updated.descriptor.binding.generation,
          emittedAt: at,
          traceId: `${input.traceId}:boundary`,
          payload: {
            type: "context_rebuild",
            reason: pending.reason,
            handoff: handoff!,
            ...(pending.sourceRunId === undefined ? {} : { sourceRunId: pending.sourceRunId }),
            replayScheduled: input.replayScheduled === true
          }
        });
      }
      this.appendEvent({
        backendId: updated.descriptor.backendId,
        targetId: updated.descriptor.targetId,
        sessionId: updated.descriptor.id,
        ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
        generation: updated.descriptor.binding.generation,
        emittedAt: at,
        traceId: input.traceId,
        payload: {
          type: "native_session_changed",
          opaqueRef: updated.descriptor.binding.opaqueRef,
          ...(updated.descriptor.binding.nativeSessionId === undefined
            ? {}
            : { nativeSessionId: updated.descriptor.binding.nativeSessionId })
        }
      });
      return updated;
    });
  }

  /**
   * Publish a successful native context reset as one atomic Product-state
   * boundary. Native I/O has already completed, so this transaction either
   * advances the binding and hides every old projection together or exposes
   * none of those effects.
   */
  commitSessionReset(input: {
    readonly sessionId: string;
    readonly sourceBinding: SessionDescriptor["binding"];
    readonly binding: SessionDescriptor["binding"];
    readonly operationId: string;
    readonly traceId: string;
    readonly at?: number;
  }): { readonly event: PersistedEvent; readonly session: StoredSession } {
    return this.write(() => {
      const sessionId = nonBlank(input.sessionId, "Session reset Session ID");
      const operationId = nonBlank(input.operationId, "Session reset Operation ID");
      const current = this.getSession(sessionId);
      this.getOperation(operationId);
      if (
        current.descriptor.binding.opaqueRef !== input.sourceBinding.opaqueRef ||
        current.descriptor.binding.nativeSessionId !== input.sourceBinding.nativeSessionId ||
        current.descriptor.binding.generation !== input.sourceBinding.generation
      ) {
        throw new StoreError("Session native binding changed while context reset was in progress.");
      }
      if (
        input.binding.opaqueRef === current.descriptor.binding.opaqueRef ||
        input.binding.generation <= current.descriptor.binding.generation
      ) {
        throw new StoreError("Session reset requires a fresh, newer native binding.");
      }

      const at = input.at ?? this.now();
      const revision = asSqlInteger(this.requireActiveRevision());
      const rowBoundary = (table: "runs" | "queue_items" | "interactions" | "artifacts" | "tool_leases"): bigint => {
        const row = this.database.prepare(
          `SELECT COALESCE(MAX(rowid), 0) AS boundary FROM ${table} WHERE session_id = ?`
        ).get(sessionId) as Row | undefined;
        return toBigInt(row?.["boundary"] ?? 0);
      };
      const eventRow = this.database.prepare(
        "SELECT COALESCE(MAX(global_cursor), 0) AS boundary FROM events WHERE session_id = ?"
      ).get(sessionId) as Row | undefined;
      const eventBoundary = toBigInt(eventRow?.["boundary"] ?? 0);
      const runBoundary = rowBoundary("runs");
      const queueBoundary = rowBoundary("queue_items");
      const interactionBoundary = rowBoundary("interactions");
      const artifactBoundary = rowBoundary("artifacts");
      const leaseBoundary = rowBoundary("tool_leases");

      this.database.prepare(`
        INSERT OR IGNORE INTO message_event_tombstones(
          event_id, session_id, deletion_operation_id, deleted_at, revision
        )
        SELECT event.id, event.session_id, ?, ?, ?
        FROM events AS event
        WHERE event.session_id = ? AND event.global_cursor <= ?
      `).run(operationId, at, revision, sessionId, asSqlInteger(eventBoundary));
      this.database.prepare("DELETE FROM native_history_current_markers WHERE session_id = ?")
        .run(sessionId);
      this.database.prepare("DELETE FROM native_history_canonical_identities WHERE session_id = ?")
        .run(sessionId);
      this.database.prepare(`
        DELETE FROM message_search_fts
        WHERE rowid IN (
          SELECT global_cursor FROM events
          WHERE session_id = ? AND global_cursor <= ?
        )
      `).run(sessionId, asSqlInteger(eventBoundary));
      if (this.messageVectorAvailable) {
        this.database.prepare(`
          UPDATE ${MESSAGE_SEARCH_VECTOR_TABLE} SET live = 0
          WHERE rowid IN (
            SELECT global_cursor FROM events
            WHERE session_id = ? AND global_cursor <= ?
          )
        `).run(sessionId, asSqlInteger(eventBoundary));
      }
      this.database.prepare(`
        DELETE FROM message_embedding_records
        WHERE event_cursor IN (
          SELECT global_cursor FROM events
          WHERE session_id = ? AND global_cursor <= ?
        )
      `).run(sessionId, asSqlInteger(eventBoundary));
      this.database.prepare(`
        DELETE FROM message_embedding_jobs
        WHERE event_cursor IN (
          SELECT global_cursor FROM events
          WHERE session_id = ? AND global_cursor <= ?
        )
      `).run(sessionId, asSqlInteger(eventBoundary));

      // Runtime observations/widgets are context state, while user choices
      // such as model, permission mode, and approved directories remain Session
      // configuration and intentionally survive clear.
      this.database.prepare(`
        DELETE FROM settings
        WHERE scope_type = 'session' AND scope_id = ? AND key LIKE 'runtime.%'
      `).run(sessionId);
      this.database.prepare("DELETE FROM session_context_rebuilds WHERE session_id = ?").run(sessionId);
      this.database.prepare(`
        UPDATE queue_controls
        SET paused = 0, pause_reason = NULL, paused_at = NULL,
            paused_by_connection_id = NULL, updated_at = ?, revision = ?
        WHERE session_id = ?
      `).run(at, revision, sessionId);

      const updated = this.updateSession(sessionId, { binding: input.binding }, current.revision, at);
      this.database.prepare(`
        INSERT INTO session_reset_boundaries(
          session_id, reset_operation_id, cleared_through_event_cursor,
          cleared_through_run_rowid, cleared_through_queue_rowid,
          cleared_through_interaction_rowid, cleared_through_artifact_rowid,
          cleared_through_tool_lease_rowid, generation, reset_at, revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          reset_operation_id = excluded.reset_operation_id,
          cleared_through_event_cursor = excluded.cleared_through_event_cursor,
          cleared_through_run_rowid = excluded.cleared_through_run_rowid,
          cleared_through_queue_rowid = excluded.cleared_through_queue_rowid,
          cleared_through_interaction_rowid = excluded.cleared_through_interaction_rowid,
          cleared_through_artifact_rowid = excluded.cleared_through_artifact_rowid,
          cleared_through_tool_lease_rowid = excluded.cleared_through_tool_lease_rowid,
          generation = excluded.generation,
          reset_at = excluded.reset_at,
          revision = excluded.revision
      `).run(
        sessionId,
        operationId,
        asSqlInteger(eventBoundary),
        asSqlInteger(runBoundary),
        asSqlInteger(queueBoundary),
        asSqlInteger(interactionBoundary),
        asSqlInteger(artifactBoundary),
        asSqlInteger(leaseBoundary),
        input.binding.generation,
        at,
        revision
      );
      const event = this.appendEvent({
        backendId: updated.descriptor.backendId,
        targetId: updated.descriptor.targetId,
        sessionId,
        operationId,
        generation: updated.descriptor.binding.generation,
        emittedAt: at,
        traceId: input.traceId,
        payload: { type: "session_reset" }
      });
      return { event, session: updated };
    });
  }

  /** Durable invalidation emitted after an offline-safe history replacement.
   * It is intentionally content-free and becomes the first surviving event so
   * every connected client discards its pre-maintenance Timeline projection. */
  publishHistoryPruned(input: {
    readonly sessionId: string;
    readonly activeContextReset: boolean;
    readonly prunedAt?: number;
  }): PersistedEvent {
    return this.write(() => {
      const session = this.getSession(nonBlank(input.sessionId, "History maintenance Session ID"));
      const prunedAt = input.prunedAt ?? this.now();
      return this.appendEvent({
        backendId: session.descriptor.backendId,
        targetId: session.descriptor.targetId,
        sessionId: session.descriptor.id,
        generation: session.descriptor.binding.generation,
        emittedAt: prunedAt,
        traceId: `history-pruned:${session.descriptor.id}:${prunedAt}`,
        payload: { type: "history_pruned", activeContextReset: input.activeContextReset }
      });
    });
  }

  listEvents(query: EventQuery = {}): PersistedEvent[] {
    this.assertOpen();
    const clauses: string[] = [];
    const params: Array<string | number | bigint> = [];
    if (query.afterCursor !== undefined && query.beforeCursor !== undefined) {
      throw new StoreError("Event history cannot page after and before a cursor at the same time.");
    }
    if (query.afterCursor !== undefined) {
      clauses.push("event.global_cursor > ?");
      params.push(asSqlInteger(query.afterCursor));
    }
    if (query.beforeCursor !== undefined) {
      clauses.push("event.global_cursor < ?");
      params.push(asSqlInteger(query.beforeCursor));
    }
    if (query.sessionId !== undefined && query.sessionIds !== undefined) {
      throw new StoreError("Event history cannot combine one Session ID with a Session ID list.");
    }
    if (query.sessionId !== undefined) {
      clauses.push("event.session_id = ?");
      params.push(query.sessionId);
    }
    if (query.sessionIds !== undefined) {
      if (query.sessionIds.length === 0) return [];
      if (query.sessionIds.length > 500) throw new StoreError("Event history cannot query more than 500 Sessions at once.");
      const sessionIds = query.sessionIds.map((sessionId) => nonBlank(sessionId, "Event history Session ID"));
      clauses.push(`event.session_id IN (${sessionIds.map(() => "?").join(", ")})`);
      params.push(...sessionIds);
    }
    if (query.targetId !== undefined) {
      clauses.push("event.target_id = ?");
      params.push(nonBlank(query.targetId, "Event history Target ID"));
    }
    if (query.emittedFrom !== undefined) {
      if (!Number.isSafeInteger(query.emittedFrom) || query.emittedFrom < 0) {
        throw new StoreError("Event history start time is invalid.");
      }
      clauses.push("event.emitted_at >= ?");
      params.push(query.emittedFrom);
    }
    if (query.emittedBefore !== undefined) {
      if (!Number.isSafeInteger(query.emittedBefore) || query.emittedBefore < 0) {
        throw new StoreError("Event history end time is invalid.");
      }
      clauses.push("event.emitted_at < ?");
      params.push(query.emittedBefore);
    }
    if (query.includeTombstoned !== true) clauses.push("tombstone.event_id IS NULL");
    const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
    const limit = normalizeLimit(query.limit, 1000);
    const order = query.order === "desc" ? "DESC" : "ASC";
    return (this.database.prepare(
      `SELECT event.* FROM events AS event
       LEFT JOIN message_event_tombstones AS tombstone ON tombstone.event_id = event.id
       ${where} ORDER BY event.global_cursor ${order} LIMIT ?`
    ).all(...params, limit) as Row[]).map(eventFromRow);
  }

  /**
   * Returns whether the latest visible observation for any native background
   * task is non-terminal. This deliberately reads durable events instead of
   * relying on SessionHost's live map, so reset admission remains fail-closed
   * after a Orchestrator restart.
   */
  hasActiveSessionBackgroundTasks(sessionId: string): boolean {
    this.assertOpen();
    const normalizedSessionId = nonBlank(sessionId, "Background task Session ID");
    this.getSession(normalizedSessionId);
    const row = this.database.prepare(`
      SELECT 1 AS active
      FROM events AS candidate
      LEFT JOIN message_event_tombstones AS candidate_tombstone
        ON candidate_tombstone.event_id = candidate.id
      WHERE candidate.session_id = ?
        AND candidate_tombstone.event_id IS NULL
        AND json_extract(candidate.payload_json, '$.payload.type') = 'background_task'
        AND json_extract(candidate.payload_json, '$.payload.state') NOT IN (
          'completed', 'failed', 'aborted', 'cancelled'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM events AS later
          LEFT JOIN message_event_tombstones AS later_tombstone
            ON later_tombstone.event_id = later.id
          WHERE later.session_id = candidate.session_id
            AND later.global_cursor > candidate.global_cursor
            AND later_tombstone.event_id IS NULL
            AND json_extract(later.payload_json, '$.payload.type') = 'background_task'
            AND json_extract(later.payload_json, '$.payload.taskId') =
                json_extract(candidate.payload_json, '$.payload.taskId')
        )
      LIMIT 1
    `).get(normalizedSessionId) as Row | undefined;
    return row !== undefined;
  }

  /** Latest visible non-terminal observation for each native background task.
   * This durable query is the reconnect authority used by Snapshot projection;
   * callers never need to replay or bound-scan the conversation timeline. */
  listActiveSessionBackgroundTaskEvents(sessionId: string): PersistedEvent[] {
    this.assertOpen();
    const normalizedSessionId = nonBlank(sessionId, "Background task Session ID");
    this.getSession(normalizedSessionId);
    return (this.database.prepare(`
      SELECT candidate.*
      FROM events AS candidate
      LEFT JOIN message_event_tombstones AS candidate_tombstone
        ON candidate_tombstone.event_id = candidate.id
      WHERE candidate.session_id = ?
        AND candidate_tombstone.event_id IS NULL
        AND json_extract(candidate.payload_json, '$.payload.type') = 'background_task'
        AND json_extract(candidate.payload_json, '$.payload.state') NOT IN (
          'completed', 'failed', 'aborted', 'cancelled'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM events AS later
          LEFT JOIN message_event_tombstones AS later_tombstone
            ON later_tombstone.event_id = later.id
          WHERE later.session_id = candidate.session_id
            AND later.global_cursor > candidate.global_cursor
            AND later_tombstone.event_id IS NULL
            AND json_extract(later.payload_json, '$.payload.type') = 'background_task'
            AND json_extract(later.payload_json, '$.payload.taskId') =
                json_extract(candidate.payload_json, '$.payload.taskId')
        )
      ORDER BY candidate.global_cursor
    `).all(normalizedSessionId) as Row[]).map(eventFromRow);
  }

  /**
   * Every visible durable observation for the Session's native background
   * tasks, in event order. History projection deliberately starts here rather
   * than from SessionHost's live map or a bounded conversation-timeline read.
   */
  listSessionBackgroundTaskEvents(sessionId: string): PersistedEvent[] {
    this.assertOpen();
    const normalizedSessionId = nonBlank(sessionId, "Background task Session ID");
    this.getSession(normalizedSessionId);
    return (this.database.prepare(`
      SELECT event.*
      FROM events AS event
      LEFT JOIN message_event_tombstones AS tombstone
        ON tombstone.event_id = event.id
      WHERE event.session_id = ?
        AND tombstone.event_id IS NULL
        AND json_extract(event.payload_json, '$.payload.type') = 'background_task'
      ORDER BY event.global_cursor
    `).all(normalizedSessionId) as Row[]).map(eventFromRow);
  }

  /**
   * Stable paging over the latest durable snapshot of each delegated run.
   * The token pins an Event high-water mark, so later observations never
   * reorder or duplicate entries while an older listing is being consumed.
   */
  listSubagentRuns(input: ListSubagentRunsInput): SubagentRunPage {
    this.assertOpen();
    const sessionId = nonBlank(input.sessionId, "Subagent Session ID");
    this.getSession(sessionId);
    const resetCursor = this.subagentResetCursor(sessionId);
    const cursor = decodeSubagentRunPageToken(input.pageToken);
    if (
      cursor !== undefined &&
      (cursor.sessionId !== sessionId || cursor.state !== (input.state ?? "") ||
        cursor.resetCursor !== resetCursor)
    ) throw new StoreError("Subagent run page token does not match the requested scope.");
    const currentHighWater = this.latestSubagentEventCursor(
      sessionId,
      "subagent_run"
    );
    const snapshotCursor = cursor?.snapshotCursor ?? currentHighWater;
    if (snapshotCursor > currentHighWater) {
      throw new StoreError("Subagent run page token is ahead of durable history.");
    }
    const rows = this.database.prepare(`
      WITH latest AS (
        SELECT
          json_extract(candidate.payload_json, '$.payload.run.id') AS subagent_run_id,
          MAX(candidate.global_cursor) AS global_cursor
        FROM events AS candidate
        LEFT JOIN message_event_tombstones AS tombstone
          ON tombstone.event_id = candidate.id
        WHERE candidate.session_id = ?
          AND candidate.global_cursor > ?
          AND candidate.global_cursor <= ?
          AND tombstone.event_id IS NULL
          AND json_extract(candidate.payload_json, '$.payload.type') = 'subagent_run'
        GROUP BY subagent_run_id
      )
      SELECT event.*
      FROM latest
      INNER JOIN events AS event ON event.global_cursor = latest.global_cursor
    `).all(sessionId, asSqlInteger(resetCursor), asSqlInteger(snapshotCursor)) as Row[];
    const runs = rows
      .map(eventFromRow)
      .map((event) => event.payload.type === "subagent_run" ? event.payload.run : undefined)
      .filter((run): run is SubagentRunDetail => run !== undefined)
      .filter((run) => input.state === undefined || run.state === input.state)
      .sort(compareSubagentRuns);
    const offset = cursor?.offset ?? 0;
    if (offset > runs.length) throw new StoreError("Subagent run page token is outside the result set.");
    const limit = boundedSubagentPageSize(input.limit, MAX_SUBAGENT_RUN_PAGE_SIZE);
    const page = runs.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    return {
      runs: page,
      ...(nextOffset < runs.length
        ? {
            nextPageToken: encodeSubagentRunPageToken({
              sessionId,
              state: input.state ?? "",
              resetCursor,
              snapshotCursor,
              offset: nextOffset
            })
          }
        : {}),
      totalSize: runs.length,
      snapshotCursor
    };
  }

  /** Resolve an exact public id first, then a durable identity alias. */
  getSessionSubagentRun(
    sessionId: string,
    runIdOrAlias: string
  ): StoredSubagentRunProjection | undefined {
    this.assertOpen();
    const normalizedSessionId = nonBlank(sessionId, "Subagent Session ID");
    const identifier = nonBlank(runIdOrAlias, "Subagent run ID");
    this.getSession(normalizedSessionId);
    const resetCursor = this.subagentResetCursor(normalizedSessionId);
    const snapshotCursor = this.latestSubagentEventCursor(normalizedSessionId, "subagent_run");
    if (snapshotCursor === 0n) return undefined;
    const events = this.latestSubagentRunEvents(normalizedSessionId, resetCursor, snapshotCursor);
    const exact = events.find((event) =>
      event.payload.type === "subagent_run" && event.payload.run.id === identifier
    );
    if (exact !== undefined && exact.payload.type === "subagent_run") {
      return { run: exact.payload.run, event: exact };
    }
    const aliases = events.filter((event) => event.payload.type === "subagent_run" && (
      event.payload.run.identityAliases.includes(identifier) ||
      event.payload.run.providerRunIds.includes(identifier)
    ));
    if (aliases.length > 1) throw new StoreError("Subagent run alias is ambiguous in this Session.");
    const event = aliases[0];
    return event === undefined || event.payload.type !== "subagent_run"
      ? undefined
      : { run: event.payload.run, event };
  }

  /** Append-order transcript paging plus a tail token for later observations. */
  listSubagentTranscript(input: ListSubagentTranscriptInput): SubagentTranscriptPage {
    this.assertOpen();
    const sessionId = nonBlank(input.sessionId, "Subagent Session ID");
    const projection = this.getSessionSubagentRun(sessionId, input.subagentRunId);
    if (projection === undefined) throw new NotFoundError("Subagent run", input.subagentRunId);
    const resetCursor = this.subagentResetCursor(sessionId);
    const runId = projection.run.id;
    const childId = resolveSubagentChildId(projection.run, input.childId);
    const cursor = decodeSubagentTranscriptPageToken(input.pageToken);
    if (
      cursor !== undefined &&
      (cursor.sessionId !== sessionId || cursor.runId !== runId || cursor.childId !== childId ||
        cursor.resetCursor !== resetCursor)
    ) throw new StoreError("Subagent transcript page token does not match the requested scope.");
    if (cursor?.tail === true && cursor.afterCursor !== cursor.snapshotCursor) {
      throw new StoreError("Subagent transcript tail token is malformed.");
    }
    const currentHighWater = this.latestSubagentEventCursor(sessionId, "subagent_transcript", runId);
    const snapshotCursor = cursor === undefined || cursor.tail
      ? currentHighWater
      : cursor.snapshotCursor;
    if (snapshotCursor > currentHighWater) {
      throw new StoreError("Subagent transcript page token is ahead of durable history.");
    }
    const afterCursor = cursor?.afterCursor ?? 0n;
    if (afterCursor > snapshotCursor) {
      throw new StoreError("Subagent transcript page token is outside the durable history.");
    }
    const limit = boundedSubagentPageSize(input.limit, MAX_SUBAGENT_TRANSCRIPT_PAGE_SIZE);
    const rows = this.database.prepare(`
      SELECT event.*
      FROM events AS event
      LEFT JOIN message_event_tombstones AS tombstone ON tombstone.event_id = event.id
      WHERE event.session_id = ?
        AND event.global_cursor > ?
        AND event.global_cursor > ?
        AND event.global_cursor <= ?
        AND tombstone.event_id IS NULL
        AND json_extract(event.payload_json, '$.payload.type') = 'subagent_transcript'
        AND json_extract(event.payload_json, '$.payload.subagentRunId') = ?
        AND (? = '' OR json_extract(event.payload_json, '$.payload.entry.childId') = ?)
      ORDER BY event.global_cursor
      LIMIT ?
    `).all(
      sessionId,
      asSqlInteger(afterCursor),
      asSqlInteger(resetCursor),
      asSqlInteger(snapshotCursor),
      runId,
      childId,
      childId,
      limit + 1
    ) as Row[];
    const selected = rows.slice(0, limit).map(eventFromRow);
    const entries = selected
      .map((event) => event.payload.type === "subagent_transcript" ? event.payload.entry : undefined)
      .filter((entry): entry is SubagentTranscriptEntry => entry !== undefined);
    const lastCursor = selected.at(-1)?.globalCursor ?? afterCursor;
    const nextPageToken = rows.length > limit
      ? encodeSubagentTranscriptPageToken({
          sessionId,
          runId,
          childId,
          afterCursor: lastCursor,
          resetCursor,
          snapshotCursor,
          tail: false
        })
      : undefined;
    const count = this.database.prepare(`
      SELECT COUNT(*) AS count
      FROM events AS event
      LEFT JOIN message_event_tombstones AS tombstone ON tombstone.event_id = event.id
      WHERE event.session_id = ?
        AND event.global_cursor > ?
        AND event.global_cursor <= ?
        AND tombstone.event_id IS NULL
        AND json_extract(event.payload_json, '$.payload.type') = 'subagent_transcript'
        AND json_extract(event.payload_json, '$.payload.subagentRunId') = ?
        AND (? = '' OR json_extract(event.payload_json, '$.payload.entry.childId') = ?)
    `).get(
      sessionId,
      asSqlInteger(resetCursor),
      asSqlInteger(snapshotCursor),
      runId,
      childId,
      childId
    ) as Row;
    return {
      entries,
      ...(nextPageToken === undefined ? {} : { nextPageToken }),
      tailPageToken: encodeSubagentTranscriptPageToken({
        sessionId,
        runId,
        childId,
        afterCursor: snapshotCursor,
        resetCursor,
        snapshotCursor,
        tail: true
      }),
      totalSize: Number(count["count"] ?? 0),
      snapshotCursor
    };
  }

  private latestSubagentEventCursor(
    sessionId: string,
    type: "subagent_run" | "subagent_transcript",
    runId?: string
  ): bigint {
    const resetCursor = this.subagentResetCursor(sessionId);
    const row = this.database.prepare(`
      SELECT COALESCE(MAX(event.global_cursor), 0) AS global_cursor
      FROM events AS event
      LEFT JOIN message_event_tombstones AS tombstone ON tombstone.event_id = event.id
      WHERE event.session_id = ?
        AND event.global_cursor > ?
        AND tombstone.event_id IS NULL
        AND json_extract(event.payload_json, '$.payload.type') = ?
        AND (? IS NULL OR json_extract(event.payload_json, '$.payload.subagentRunId') = ?)
    `).get(sessionId, asSqlInteger(resetCursor), type, runId ?? null, runId ?? null) as Row;
    return toBigInt(row["global_cursor"]);
  }

  private latestSubagentRunEvents(
    sessionId: string,
    resetCursor: bigint,
    snapshotCursor: bigint
  ): PersistedEvent[] {
    return (this.database.prepare(`
      WITH latest AS (
        SELECT
          json_extract(candidate.payload_json, '$.payload.run.id') AS subagent_run_id,
          MAX(candidate.global_cursor) AS global_cursor
        FROM events AS candidate
        LEFT JOIN message_event_tombstones AS tombstone
          ON tombstone.event_id = candidate.id
        WHERE candidate.session_id = ?
          AND candidate.global_cursor > ?
          AND candidate.global_cursor <= ?
          AND tombstone.event_id IS NULL
          AND json_extract(candidate.payload_json, '$.payload.type') = 'subagent_run'
        GROUP BY subagent_run_id
      )
      SELECT event.*
      FROM latest
      INNER JOIN events AS event ON event.global_cursor = latest.global_cursor
    `).all(
      sessionId,
      asSqlInteger(resetCursor),
      asSqlInteger(snapshotCursor)
    ) as Row[]).map(eventFromRow);
  }

  private subagentResetCursor(sessionId: string): bigint {
    const row = this.database.prepare(`
      SELECT cleared_through_event_cursor
      FROM session_reset_boundaries
      WHERE session_id = ?
    `).get(sessionId) as Row | undefined;
    return row === undefined ? 0n : toBigInt(row["cleared_through_event_cursor"]);
  }

  private validateSubagentEventInput(input: AppendEventInput): void {
    if (input.payload.type === "subagent_run") {
      const run = input.payload.run;
      boundedSubagentIdentity(run.id, "run ID");
      boundedSubagentIdentity(run.logicalAgentId, "logical agent ID");
      for (const [value, label] of [
        [run.parentRunId, "parent run ID"],
        [run.parentSubagentRunId, "parent Subagent run ID"],
        [run.parentTaskId, "parent task ID"],
        [run.parentToolCallId, "parent tool call ID"]
      ] as const) {
        if (value !== undefined) boundedSubagentIdentity(value, label);
      }
      if (run.sessionId !== input.sessionId) {
        throw new StoreError("Subagent run Session scope does not match its Event.");
      }
      if (!Number.isSafeInteger(run.startedAt) || !Number.isSafeInteger(run.updatedAt) ||
        run.startedAt < 0 || run.updatedAt < run.startedAt ||
        (run.endedAt !== undefined && (!Number.isSafeInteger(run.endedAt) || run.endedAt < run.startedAt))) {
        throw new StoreError("Subagent run timestamps are invalid.");
      }
      boundedSubagentText(run.assignment, 64 * 1024, "assignment");
      boundedSubagentText(run.title, 4 * 1024, "title");
      boundedSubagentText(run.description, 64 * 1024, "description");
      boundedSubagentText(run.summary, 64 * 1024, "summary");
      boundedSubagentText(run.returnedResult, 256 * 1024, "returned result");
      validateSubagentRoute(run.route);
      validateSubagentUsage(run.usage);
      validateSubagentPublicError(run.error);
      const children = run.children ?? [];
      if (!run.capabilities.viewActivity && run.activity.length !== 0) {
        throw new StoreError("Subagent activity was emitted without the corresponding run capability.");
      }
      if (!run.capabilities.viewReturnedResult && (
        run.returnedResult !== undefined || children.some((child) => child.result !== undefined)
      )) {
        throw new StoreError("Subagent result was emitted without the corresponding run capability.");
      }
      for (const value of [...run.identityAliases, ...run.providerRunIds]) {
        boundedSubagentIdentity(value, "alias");
      }
      const childIds = new Set<string>();
      const childAliases = new Map<string, string>();
      for (const child of children) {
        const childId = boundedSubagentIdentity(child.id, "child ID");
        if (childIds.has(childId)) throw new StoreError("Subagent child IDs must be unique in one run.");
        childIds.add(childId);
        boundedSubagentIdentity(child.role, "child role");
        boundedSubagentText(child.title, 4 * 1024, "child title");
        boundedSubagentText(child.assignment, 64 * 1024, "child assignment");
        boundedSubagentText(child.result, 256 * 1024, "child result");
        validateSubagentRoute(child.route);
        validateSubagentUsage(child.usage);
        validateSubagentPublicError(child.error);
        if ((child.startedAt !== undefined && (!Number.isSafeInteger(child.startedAt) || child.startedAt < 0)) ||
          (child.endedAt !== undefined && (!Number.isSafeInteger(child.endedAt) || child.endedAt < 0)) ||
          (child.startedAt !== undefined && child.endedAt !== undefined && child.endedAt < child.startedAt)) {
          throw new StoreError("Subagent child timestamps are invalid.");
        }
        for (const value of child.identityAliases) {
          const alias = boundedSubagentIdentity(value, "child alias");
          const owner = childAliases.get(alias);
          if (owner !== undefined && owner !== childId) {
            throw new StoreError("Subagent child aliases must identify exactly one child.");
          }
          childAliases.set(alias, childId);
        }
      }
      for (const child of children) {
        if (child.parentChildId !== undefined && !childIds.has(child.parentChildId)) {
          throw new StoreError("Subagent child parent identity is outside the run.");
        }
      }
      assertAcyclicSubagentChildren(children);
      let activitySequence = -1;
      for (const activity of run.activity) {
        if (!Number.isSafeInteger(activity.sequence) || activity.sequence < 0 || activity.sequence <= activitySequence ||
          !Number.isSafeInteger(activity.occurredAt) || activity.occurredAt < 0) {
          throw new StoreError("Subagent activity sequences must be strictly increasing.");
        }
        activitySequence = activity.sequence;
        boundedSubagentText(activity.summary, 64 * 1024, "activity summary");
        if (activity.lastToolName !== undefined) {
          boundedSubagentIdentity(activity.lastToolName, "activity tool name");
        }
      }
      const current = this.getSessionSubagentRun(input.sessionId, run.id);
      if (current !== undefined && current.run.updatedAt > run.updatedAt) {
        throw new StoreError("Subagent run observation is older than the durable projection.");
      }
      return;
    }
    if (input.payload.type !== "subagent_transcript") return;
    const runId = boundedSubagentIdentity(input.payload.subagentRunId, "transcript run ID");
    const projection = this.getSessionSubagentRun(input.sessionId, runId);
    if (projection === undefined || projection.run.id !== runId) {
      throw new StoreError("Subagent transcript does not belong to a durable run in this Session.");
    }
    if (!projection.run.capabilities.viewFullTranscript) {
      throw new StoreError("Subagent transcript was emitted without the corresponding run capability.");
    }
    const entry = input.payload.entry;
    boundedSubagentIdentity(entry.id, "transcript entry ID");
    if (!Number.isSafeInteger(entry.sequence) || entry.sequence < 0 ||
      !Number.isSafeInteger(entry.occurredAt) || entry.occurredAt < 0) {
      throw new StoreError("Subagent transcript entry sequence or timestamp is invalid.");
    }
    boundedSubagentText(entry.content, 256 * 1024, "transcript content");
    boundedSubagentText(entry.toolInputJson, 64 * 1024, "transcript tool input");
    boundedSubagentText(entry.childTitle, 4 * 1024, "transcript child title");
    if (entry.toolName !== undefined) boundedSubagentIdentity(entry.toolName, "transcript tool name");
    if (entry.toolCallId !== undefined) boundedSubagentIdentity(entry.toolCallId, "transcript tool call ID");
    if (entry.childId !== undefined && !(projection.run.children ?? []).some((child) => child.id === entry.childId)) {
      throw new StoreError("Subagent transcript child does not belong to its durable run.");
    }
    if (entry.toolPhase !== undefined && entry.role !== "tool") {
      throw new StoreError("Subagent transcript tool lifecycle requires the tool role.");
    }
    if (entry.toolPhase !== undefined && entry.toolName === undefined && entry.toolCallId === undefined) {
      throw new StoreError("Subagent transcript tool lifecycle is missing tool identity.");
    }
    if (entry.systemEvent !== undefined) {
      boundedSubagentIdentity(entry.systemEvent.kind, "system event kind");
      for (const [key, value] of Object.entries(entry.systemEvent.params ?? {})) {
        boundedSubagentIdentity(key, "system event parameter");
        boundedSubagentText(value, 16 * 1024, "system event parameter value");
      }
    }
    const resetCursor = this.subagentResetCursor(input.sessionId);
    const duplicate = this.database.prepare(`
      SELECT 1 AS present
      FROM events
      WHERE session_id = ?
        AND global_cursor > ?
        AND json_extract(payload_json, '$.payload.type') = 'subagent_transcript'
        AND json_extract(payload_json, '$.payload.subagentRunId') = ?
        AND json_extract(payload_json, '$.payload.entry.id') = ?
      LIMIT 1
    `).get(input.sessionId, asSqlInteger(resetCursor), runId, entry.id) as Row | undefined;
    if (duplicate !== undefined) throw new StoreError("Subagent transcript entry ID already exists.");
    const latest = this.database.prepare(`
      SELECT MAX(CAST(json_extract(payload_json, '$.payload.entry.sequence') AS INTEGER)) AS sequence
      FROM events
      WHERE session_id = ?
        AND global_cursor > ?
        AND json_extract(payload_json, '$.payload.type') = 'subagent_transcript'
        AND json_extract(payload_json, '$.payload.subagentRunId') = ?
    `).get(input.sessionId, asSqlInteger(resetCursor), runId) as Row;
    if (latest["sequence"] !== null && latest["sequence"] !== undefined &&
      entry.sequence <= Number(latest["sequence"])) {
      throw new StoreError("Subagent transcript sequences must be strictly increasing.");
    }
  }

  /**
   * Reads every durable source that would lose an in-flight effect if the
   * Orchestrator process stopped now. This is a point-in-time authority for a
   * destructive-action probe, not a presentation projection: accepted/queued
   * input is recoverable and therefore intentionally does not count.
   */
  inspectDurableRuntimeActivity(at = this.now()): DurableRuntimeActivitySnapshot {
    this.assertOpen();
    const exists = (sql: string, ...params: Array<string | number>): boolean =>
      this.database.prepare(sql).get(...params) !== undefined;

    const run = exists(`
      SELECT 1
      FROM runs AS run
      WHERE run.state IN ('running', 'waiting', 'retrying', 'dispatch_unknown')
        AND NOT EXISTS (
          SELECT 1 FROM session_reset_boundaries AS reset
          WHERE reset.session_id = run.session_id
            AND run.rowid <= reset.cleared_through_run_rowid
        )
      LIMIT 1
    `);
    const queueDispatch = exists(`
      SELECT 1
      FROM queue_items AS item
      WHERE item.state IN ('dispatching', 'backend_accepted', 'dispatch_unknown')
        AND NOT EXISTS (
          SELECT 1 FROM session_reset_boundaries AS reset
          WHERE reset.session_id = item.session_id
            AND item.rowid <= reset.cleared_through_queue_rowid
        )
      LIMIT 1
    `);
    const interaction = exists(`
      SELECT 1
      FROM interactions AS interaction
      WHERE interaction.status = 'open'
        AND NOT EXISTS (
          SELECT 1 FROM session_reset_boundaries AS reset
          WHERE reset.session_id = interaction.session_id
            AND interaction.rowid <= reset.cleared_through_interaction_rowid
        )
      LIMIT 1
    `);
    const toolLease = exists(`
      SELECT 1
      FROM tool_leases AS lease
      WHERE lease.state = 'active'
        AND lease.expires_at > ?
        AND NOT EXISTS (
          SELECT 1 FROM session_reset_boundaries AS reset
          WHERE reset.session_id = lease.session_id
            AND lease.rowid <= reset.cleared_through_tool_lease_rowid
        )
      LIMIT 1
    `, at);
    const backgroundTask = exists(`
      SELECT 1
      FROM events AS candidate
      LEFT JOIN message_event_tombstones AS candidate_tombstone
        ON candidate_tombstone.event_id = candidate.id
      WHERE candidate_tombstone.event_id IS NULL
        AND json_extract(candidate.payload_json, '$.payload.type') = 'background_task'
        AND json_extract(candidate.payload_json, '$.payload.state') NOT IN (
          'completed', 'failed', 'aborted', 'cancelled'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM events AS later
          LEFT JOIN message_event_tombstones AS later_tombstone
            ON later_tombstone.event_id = later.id
          WHERE later.session_id = candidate.session_id
            AND later.global_cursor > candidate.global_cursor
            AND later_tombstone.event_id IS NULL
            AND json_extract(later.payload_json, '$.payload.type') = 'background_task'
            AND json_extract(later.payload_json, '$.payload.taskId') =
                json_extract(candidate.payload_json, '$.payload.taskId')
        )
      LIMIT 1
    `);
    const review = exists("SELECT 1 FROM review_runs WHERE state = 'running' LIMIT 1");
    const operation = exists("SELECT 1 FROM operations WHERE status = 'started' LIMIT 1");

    return { run, queueDispatch, interaction, toolLease, backgroundTask, review, operation };
  }

  listEventsAround(sessionId: string, eventId: string, limit = 100): PersistedEvent[] {
    this.assertOpen();
    const normalizedSessionId = nonBlank(sessionId, "Timeline Session ID");
    const normalizedEventId = nonBlank(eventId, "Timeline Event ID");
    const normalizedLimit = normalizeLimit(limit, 100);
    this.getSession(normalizedSessionId);
    const nativeVisibility = this.nativeMessageSearchVisibility(
      { kind: "session", id: normalizedSessionId },
      this.latestEventCursor()
    );
    const ctePrefix = nativeVisibility === undefined ? "" : `WITH RECURSIVE ${nativeVisibility.ctes}`;
    const centerRow = this.database.prepare(`
      ${ctePrefix}
      SELECT event.global_cursor FROM events AS event
      LEFT JOIN message_event_tombstones AS tombstone ON tombstone.event_id = event.id
      WHERE event.session_id = ? AND event.id = ? AND tombstone.event_id IS NULL
        ${nativeVisibility?.clause("event") ?? ""}
      LIMIT 1
    `).get(
      ...(nativeVisibility?.params ?? []),
      normalizedSessionId,
      normalizedEventId
    ) as Row | undefined;
    if (centerRow === undefined) throw new NotFoundError("Event", normalizedEventId);
    const centerCursor = toBigInt(centerRow["global_cursor"]);
    const precedingRows = (this.database.prepare(`
      ${ctePrefix}
      SELECT event.* FROM events AS event
      LEFT JOIN message_event_tombstones AS tombstone ON tombstone.event_id = event.id
      WHERE event.session_id = ? AND event.global_cursor <= ? AND tombstone.event_id IS NULL
        ${nativeVisibility?.clause("event") ?? ""}
      ORDER BY event.global_cursor DESC
      LIMIT ?
    `).all(
      ...(nativeVisibility?.params ?? []),
      normalizedSessionId,
      asSqlInteger(centerCursor),
      normalizedLimit
    ) as Row[]).reverse();
    const followingRows = this.database.prepare(`
      ${ctePrefix}
      SELECT event.* FROM events AS event
      LEFT JOIN message_event_tombstones AS tombstone ON tombstone.event_id = event.id
      WHERE event.session_id = ? AND event.global_cursor > ? AND tombstone.event_id IS NULL
        ${nativeVisibility?.clause("event") ?? ""}
      ORDER BY event.global_cursor
      LIMIT ?
    `).all(
      ...(nativeVisibility?.params ?? []),
      normalizedSessionId,
      asSqlInteger(centerCursor),
      normalizedLimit
    ) as Row[];
    const window = precedingRows.concat(followingRows);
    const center = precedingRows.length - 1;
    const preceding = Math.floor((normalizedLimit - 1) / 2);
    let start = Math.max(0, center - preceding);
    const end = Math.min(window.length, start + normalizedLimit);
    start = Math.max(0, end - normalizedLimit);
    return window.slice(start, end).map(eventFromRow);
  }

  private nativeMessageSearchVisibility(
    scope: NormalizedMessageSearchScope,
    highWater: bigint
  ): NativeMessageSearchVisibility {
    const scopeClause = scope.kind === "owner"
      ? ""
      : scope.kind === "session" ? " AND native_session.id = ?" : " AND native_session.target_id = ?";
    const scopeParams = scope.kind === "owner" ? [] : [scope.id];
    const bindingPath = `$.${NATIVE_HISTORY_BINDING_FINGERPRINT_FIELD}`;
    const replacesPath = `$.${NATIVE_HISTORY_REPLACES_TRANSIENT_FIELD}`;
    return {
      ctes: `
        current_native_marker AS (
          SELECT
            marker.session_id,
            marker.event_cursor AS marker_cursor,
            marker.binding_fingerprint,
            marker.leaf_id,
            native_session.generation AS current_generation,
            CASE WHEN marker.native_opaque_ref = native_session.native_opaque_ref THEN 1 ELSE 0 END AS binding_current
          FROM native_history_current_markers AS marker
          JOIN product_sessions AS native_session
            ON native_session.id = marker.session_id AND native_session.deleted_at IS NULL
          JOIN events AS marker_event ON marker_event.global_cursor = marker.event_cursor
          LEFT JOIN message_event_tombstones AS marker_tombstone
            ON marker_tombstone.event_id = marker_event.id
          WHERE marker_tombstone.event_id IS NULL
            AND marker.event_cursor <= ?${scopeClause}
        )`,
      params: [asSqlInteger(highWater), ...scopeParams],
      clause: (eventAlias) => ` AND (
        (
          NULLIF(json_extract(${eventAlias}.payload_json, '$.payload.nativeHistory.identity.entryId'), '') IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM product_sessions AS current_session
            WHERE current_session.id = ${eventAlias}.session_id
              AND current_session.deleted_at IS NULL
              AND json_extract(${eventAlias}.metadata_json, '${bindingPath}') =
                current_session.native_binding_fingerprint
          )
          AND (
            NOT EXISTS (
              SELECT 1 FROM current_native_marker AS marker
              WHERE marker.session_id = ${eventAlias}.session_id
            )
            OR EXISTS (
              SELECT 1
              FROM current_native_marker AS marker
              WHERE marker.session_id = ${eventAlias}.session_id
                AND marker.binding_current = 1
                AND (
                  marker.leaf_id IS NULL
                  OR EXISTS (
                    SELECT 1
                    FROM native_history_active_entries AS active
                    WHERE active.session_id = marker.session_id
                      AND active.marker_cursor = marker.marker_cursor
                      AND active.binding_fingerprint = marker.binding_fingerprint
                      AND active.entry_id = NULLIF(
                        json_extract(${eventAlias}.payload_json, '$.payload.nativeHistory.identity.entryId'),
                        ''
                      )
                  )
                )
            )
          )
        )
        OR (
          NULLIF(json_extract(${eventAlias}.payload_json, '$.payload.nativeHistory.identity.entryId'), '') IS NULL
          AND (
            (
              NOT EXISTS (
                SELECT 1 FROM current_native_marker AS marker
                WHERE marker.session_id = ${eventAlias}.session_id
              )
              AND EXISTS (
                SELECT 1 FROM product_sessions AS current_session
                WHERE current_session.id = ${eventAlias}.session_id
                  AND current_session.deleted_at IS NULL
                  AND ${eventAlias}.generation = current_session.generation
              )
            )
            OR EXISTS (
              SELECT 1
              FROM current_native_marker AS marker
              WHERE marker.session_id = ${eventAlias}.session_id
                AND (
                  (
                    marker.binding_current = 1
                    AND NOT (
                      ${eventAlias}.global_cursor <= marker.marker_cursor
                      AND COALESCE(json_extract(${eventAlias}.metadata_json, '${replacesPath}'), 0) = 1
                    )
                  )
                  OR (
                    marker.binding_current = 0
                    AND ${eventAlias}.generation = marker.current_generation
                  )
                )
            )
          )
        )
      )`
    };
  }

  /**
   * Validates and redacts every request field that can fail before Orchestrator is
   * allowed to send query text to an external embedding Provider.
   */
  validateSessionMessageSearch(input: ValidateSessionMessageSearchInput): ValidatedSessionMessageSearch {
    this.assertOpen();
    const query = normalizeMessageSearchQuery(input.query);
    normalizeMessageSearchLimit(input.limit);
    const scope = this.messageSearchScope(input.scope);
    const filters = normalizeMessageSearchFilters(input.filters);
    const retrieval = normalizeMessageSearchRetrieval(
      input.retrievalProviderId,
      input.retrievalProviderGenerationId,
      input.retrievalModelId
    );
    const queryHash = messageSearchQueryHash(scope.kind, scope.id, query, retrieval, filters);
    const cursor = input.pageToken === undefined || input.pageToken === ""
      ? undefined
      : decodeMessageSearchCursor(input.pageToken);
    if (cursor !== undefined && (
      cursor.scopeKind !== scope.kind ||
      cursor.scopeId !== scope.id ||
      cursor.queryHash !== queryHash
    )) {
      throw new StoreError("Message search page token does not match the query scope.");
    }
    const currentHighWater = this.latestEventCursor();
    const currentRevision = this.readRevision();
    if (cursor !== undefined && BigInt(cursor.highWater) > currentHighWater) {
      throw new StoreError("Message search page token is ahead of the durable event cursor.");
    }
    if (cursor !== undefined && BigInt(cursor.revision) !== currentRevision) {
      throw new StoreError("Message search page token is stale because durable state changed.");
    }
    return {
      query,
      useSemantic: input.semanticRequested === true && cursor?.vectorFingerprint !== ""
    };
  }

  searchSessionMessages(input: SearchSessionMessagesInput): SessionMessageSearchPage {
    this.assertOpen();
    const query = normalizeMessageSearchQuery(input.query);
    const limit = normalizeMessageSearchLimit(input.limit);
    const scope = this.messageSearchScope(input.scope);
    const filters = normalizeMessageSearchFilters(input.filters);
    const semantic = normalizeMessageSearchSemantic(input.semantic, this.messageVectorAvailable);
    const retrievalProviderId = input.retrievalProviderId ?? semantic?.providerId;
    const retrievalProviderGenerationId = input.retrievalProviderGenerationId ?? semantic?.providerGenerationId;
    const retrievalModelId = input.retrievalModelId ?? semantic?.modelId;
    const retrieval = normalizeMessageSearchRetrieval(
      retrievalProviderId,
      retrievalProviderGenerationId,
      retrievalModelId
    );
    if (semantic !== undefined && (
      retrievalProviderId !== semantic.providerId ||
      retrievalProviderGenerationId !== semantic.providerGenerationId ||
      retrievalModelId !== semantic.modelId
    )) {
      throw new StoreError("Message-search embedding does not match the requested retrieval generation.");
    }
    const requestedSemantic = semantic;
    const queryHash = messageSearchQueryHash(
      scope.kind,
      scope.id,
      query,
      retrieval,
      filters
    );
    const currentHighWater = this.latestEventCursor();
    const currentRevision = this.readRevision();
    const cursor = input.pageToken === undefined || input.pageToken === ""
      ? undefined
      : decodeMessageSearchCursor(input.pageToken);
    if (cursor !== undefined && (
      cursor.scopeKind !== scope.kind ||
      cursor.scopeId !== scope.id ||
      cursor.queryHash !== queryHash
    )) {
      throw new StoreError("Message search page token does not match the query scope.");
    }
    const highWater = cursor === undefined ? currentHighWater : BigInt(cursor.highWater);
    const revision = cursor === undefined ? currentRevision : BigInt(cursor.revision);
    if (highWater > currentHighWater) {
      throw new StoreError("Message search page token is ahead of the durable event cursor.");
    }
    if (revision !== currentRevision) {
      throw new StoreError("Message search page token is stale because durable state changed.");
    }
    const offset = cursor?.offset ?? 0;
    const tokens = messageSearchTokens(query);
    const effectiveSemantic = cursor?.vectorFingerprint === "" ? undefined : requestedSemantic;
    if (cursor !== undefined && cursor.vectorFingerprint !== "") {
      if (effectiveSemantic === undefined || messageSearchVectorFingerprint(effectiveSemantic) !== cursor.vectorFingerprint) {
        throw new StoreError("Message search page token is stale because the semantic query generation changed.");
      }
    }
    const nativeVisibility = this.nativeMessageSearchVisibility(scope, highWater);
    if (effectiveSemantic !== undefined) {
      return this.searchHybridSessionMessages({
        query,
        tokens,
        semantic: effectiveSemantic,
        scope,
        filters,
        queryHash,
        highWater,
        revision,
        offset,
        limit,
        nativeVisibility
      });
    }
    const vectorSkipReason = normalizeMessageSearchSkipReason(input.semanticSkipReason)
      ?? (cursor?.vectorFingerprint === ""
        ? "This result set is pinned to the keyword fallback selected on its first page."
        : undefined);
    if (tokens.length === 0) {
      return {
        matches: [],
        totalSize: 0,
        revision: this.readRevision(),
        vectorUsed: false,
        ...(vectorSkipReason === undefined ? {} : { vectorSkipReason }),
        poolCapped: false
      };
    }
    const shortTokens = tokens.filter((token) => [...token].length < 3);
    const candidateClause = `message_search_fts.rowid IN (
      SELECT rowid FROM message_search_fts WHERE message_search_fts MATCH ?
      ${shortTokens.map(() => `UNION
      SELECT rowid FROM message_search_fts WHERE visible_text LIKE ? ESCAPE '\\'`).join("\n      ")}
    )`;
    const candidateParams = [
      messageSearchFtsMatch(tokens),
      ...shortTokens.map((token) => `%${escapeLikePattern(token)}%`)
    ];
    const scopeClause = scope.kind === "owner"
      ? ""
      : scope.kind === "session" ? " AND event.session_id = ?" : " AND event.target_id = ?";
    const scopeParams = scope.kind === "owner" ? [] : [scope.id];
    const structured = messageSearchStructuredFilterSql(filters, "event", "session");
    const timelineItemSql = `CASE
      WHEN json_extract(event.payload_json, '$.payload.type') = 'interaction_opened'
        THEN 'interaction:' || COALESCE(
          NULLIF(json_extract(event.payload_json, '$.payload.interaction.id'), ''),
          event.id
        )
      ELSE COALESCE(
        NULLIF(json_extract(event.payload_json, '$.payload.nativeHistory.identity.entryId'), ''),
        event.id
      )
    END`;
    const count = this.database.prepare(`
      ${nativeVisibility === undefined ? "" : `WITH RECURSIVE ${nativeVisibility.ctes}`}
      SELECT COUNT(*) AS total_size
      FROM (
        SELECT event.session_id, ${timelineItemSql} AS timeline_item_id
        FROM message_search_fts
        JOIN events AS event ON event.global_cursor = message_search_fts.rowid
        JOIN product_sessions AS session ON session.id = event.session_id AND session.deleted_at IS NULL
        WHERE ${candidateClause}
          AND event.global_cursor <= ?${scopeClause}${structured.clause}
          ${nativeVisibility?.clause("event") ?? ""}
        GROUP BY event.session_id, timeline_item_id
      ) AS visible_message
    `).get(
      ...(nativeVisibility?.params ?? []),
      ...candidateParams,
      asSqlInteger(highWater),
      ...scopeParams,
      ...structured.params
    ) as Row;
    const totalSize = Number(count["total_size"] ?? 0);
    const rows = this.database.prepare(`
      WITH${nativeVisibility === undefined ? "" : ` RECURSIVE ${nativeVisibility.ctes},`}
      matching_messages AS (
        SELECT
          event.session_id,
          event.target_id,
          event.id AS event_id,
          event.global_cursor,
          ${timelineItemSql} AS timeline_item_id,
          json_extract(event.payload_json, '$.payload.role') AS role,
          event.emitted_at AS created_at,
          message_search_fts.visible_text,
          ROUND(
            MIN(1.0, CAST(length(?) AS REAL) / MAX(length(message_search_fts.visible_text), 1)),
            12
          ) AS score
        FROM message_search_fts
        JOIN events AS event ON event.global_cursor = message_search_fts.rowid
        JOIN product_sessions AS session ON session.id = event.session_id AND session.deleted_at IS NULL
        WHERE ${candidateClause}
          AND event.global_cursor <= ?${scopeClause}${structured.clause}
          ${nativeVisibility?.clause("event") ?? ""}
      ),
      deduplicated_messages AS (
        SELECT *
        FROM (
          SELECT
            matching_messages.*,
            ROW_NUMBER() OVER (
              PARTITION BY session_id, timeline_item_id
              ORDER BY global_cursor DESC, score DESC, event_id
            ) AS duplicate_rank
          FROM matching_messages
        )
        WHERE duplicate_rank = 1
      ),
      ranked_messages AS (
        SELECT
          *,
          ROW_NUMBER() OVER (
            ORDER BY score DESC, global_cursor DESC, event_id
          ) AS fts_rank,
          ROW_NUMBER() OVER (
            PARTITION BY session_id
            ORDER BY score DESC, global_cursor DESC, event_id
          ) AS hit_rank
        FROM deduplicated_messages
      ),
      ranked_sessions AS (
        SELECT
          session_id,
          ROW_NUMBER() OVER (
            ORDER BY score DESC, global_cursor DESC, event_id, session_id
          ) AS session_rank
        FROM ranked_messages
        WHERE hit_rank = 1
      )
      SELECT message.*
      FROM ranked_messages AS message
      JOIN ranked_sessions AS session_rank ON session_rank.session_id = message.session_id
      -- Take the best hit from every matching Session before its second-best
      -- hit, then repeat. A long transcript therefore cannot consume the
      -- global page before other matching Sessions become visible.
      ORDER BY message.hit_rank, session_rank.session_rank, message.global_cursor DESC, message.event_id
      LIMIT ? OFFSET ?
    `).all(
      ...(nativeVisibility?.params ?? []),
      query,
      ...candidateParams,
      asSqlInteger(highWater),
      ...scopeParams,
      ...structured.params,
      limit,
      offset
    ) as Row[];
    const matches: SessionMessageSearchRecord[] = rows.map((row) => ({
      sessionId: String(row["session_id"]),
      targetId: String(row["target_id"]),
      eventId: String(row["event_id"]),
      timelineItemId: String(row["timeline_item_id"]),
      role: row["role"] === "user" ? "user" : "assistant",
      kind: "text_message",
      snippet: visibleMessageSnippet(String(row["visible_text"]), tokens),
      createdAt: Number(row["created_at"]),
      score: Number(row["score"]),
      ftsRank: Number(row["fts_rank"])
    }));
    const nextOffset = offset + matches.length;
    return {
      matches,
      ...(nextOffset >= totalSize
        ? {}
        : {
          nextPageToken: encodeMessageSearchCursor({
            v: 1,
            scopeKind: scope.kind,
            scopeId: scope.id,
            queryHash,
            vectorFingerprint: "",
            highWater: highWater.toString(10),
            revision: revision.toString(10),
            offset: nextOffset
          })
        }),
      totalSize,
      revision: this.readRevision(),
      vectorUsed: false,
      ...(vectorSkipReason === undefined ? {} : { vectorSkipReason }),
      poolCapped: false
    };
  }

  private searchHybridSessionMessages(input: {
    readonly query: string;
    readonly tokens: readonly string[];
    readonly semantic: NormalizedMessageSearchSemantic;
    readonly scope: NormalizedMessageSearchScope;
    readonly filters: NormalizedMessageSearchFilters;
    readonly queryHash: string;
    readonly highWater: bigint;
    readonly revision: bigint;
    readonly offset: number;
    readonly limit: number;
    readonly nativeVisibility: NativeMessageSearchVisibility;
  }): SessionMessageSearchPage {
    const poolLimit = input.semantic.poolLimit;
    const scopeClause = input.scope.kind === "owner"
      ? ""
      : input.scope.kind === "session" ? " AND event.session_id = ?" : " AND event.target_id = ?";
    const scopeParams = input.scope.kind === "owner" ? [] : [input.scope.id];
    const structured = messageSearchStructuredFilterSql(input.filters, "event", "session");
    const shortTokens = input.tokens.filter((token) => [...token].length < 3);
    const candidateClause = input.tokens.length === 0
      ? undefined
      : `message_search_fts.rowid IN (
          SELECT rowid FROM message_search_fts WHERE message_search_fts MATCH ?
          ${shortTokens.map(() => `UNION
          SELECT rowid FROM message_search_fts WHERE visible_text LIKE ? ESCAPE '\\'`).join("\n          ")}
        )`;
    const candidateParams = candidateClause === undefined ? [] : [
      messageSearchFtsMatch(input.tokens),
      ...shortTokens.map((token) => `%${escapeLikePattern(token)}%`)
    ];
    const timelineItemSql = `CASE
      WHEN json_extract(event.payload_json, '$.payload.type') = 'interaction_opened'
        THEN 'interaction:' || COALESCE(
          NULLIF(json_extract(event.payload_json, '$.payload.interaction.id'), ''),
          event.id
        )
      ELSE COALESCE(
        NULLIF(json_extract(event.payload_json, '$.payload.nativeHistory.identity.entryId'), ''),
        event.id
      )
    END`;
    const ftsRows = candidateClause === undefined ? [] : this.database.prepare(`
      WITH ${input.nativeVisibility.ctes},
      candidate_fts AS (
        SELECT
          event.global_cursor,
          event.session_id,
          ${timelineItemSql} AS timeline_item_id,
          bm25(message_search_fts) AS lexical_distance
        FROM message_search_fts
        JOIN events AS event ON event.global_cursor = message_search_fts.rowid
        JOIN product_sessions AS session
          ON session.id = event.session_id AND session.deleted_at IS NULL
        WHERE ${candidateClause}
          AND event.global_cursor <= ?${scopeClause}${structured.clause}
          ${input.nativeVisibility.clause("event")}
      ),
      ranked_fts AS (
        SELECT
          *,
          ROW_NUMBER() OVER (
            PARTITION BY session_id, timeline_item_id
            ORDER BY lexical_distance, global_cursor DESC
          ) AS duplicate_rank
        FROM candidate_fts
      )
      SELECT global_cursor, session_id, timeline_item_id, lexical_distance
      FROM ranked_fts
      WHERE duplicate_rank = 1
      ORDER BY lexical_distance, global_cursor DESC
      LIMIT ?
    `).all(
      ...input.nativeVisibility.params,
      ...candidateParams,
      input.highWater,
      ...scopeParams,
      ...structured.params,
      poolLimit + 1
    ) as Row[];

    const queryBytes = new Uint8Array(Float32Array.from(input.semantic.queryEmbedding).buffer);
    const vectorRows = hasMessageSearchStructuredFilters(input.filters)
      ? this.database.prepare(`
          WITH ${input.nativeVisibility.ctes},
          candidate_vectors AS (
            SELECT
              event.global_cursor,
              event.session_id,
              ${timelineItemSql} AS timeline_item_id,
              vec_distance_cosine(${MESSAGE_SEARCH_VECTOR_TABLE}.embedding, ?) AS distance
            FROM ${MESSAGE_SEARCH_VECTOR_TABLE}
            JOIN message_embedding_records AS embedding
              ON embedding.event_cursor = ${MESSAGE_SEARCH_VECTOR_TABLE}.rowid
            JOIN events AS event ON event.global_cursor = ${MESSAGE_SEARCH_VECTOR_TABLE}.rowid
            JOIN product_sessions AS session
              ON session.id = event.session_id AND session.deleted_at IS NULL
            WHERE ${MESSAGE_SEARCH_VECTOR_TABLE}.provider_id = ?
              AND ${MESSAGE_SEARCH_VECTOR_TABLE}.provider_generation_id = ?
              AND ${MESSAGE_SEARCH_VECTOR_TABLE}.model_id = ?
              AND ${MESSAGE_SEARCH_VECTOR_TABLE}.live = 1
              AND ${MESSAGE_SEARCH_VECTOR_TABLE}.event_cursor <= ?
              AND embedding.provider_id = ?
              AND embedding.provider_generation_id = ?
              AND embedding.model_id = ? AND embedding.dimensions = ?
              AND event.global_cursor <= ?${scopeClause}${structured.clause}
              ${input.nativeVisibility.clause("event")}
          ),
          ranked_vectors AS (
            SELECT
              *,
              ROW_NUMBER() OVER (
                PARTITION BY session_id, timeline_item_id
                ORDER BY distance, global_cursor DESC
              ) AS duplicate_rank
            FROM candidate_vectors
          )
          SELECT global_cursor, session_id, timeline_item_id, distance
          FROM ranked_vectors
          WHERE duplicate_rank = 1
          ORDER BY distance, global_cursor DESC
          LIMIT ?
        `).all(
          ...input.nativeVisibility.params,
          queryBytes,
          input.semantic.providerId,
          input.semantic.providerGenerationId,
          input.semantic.modelId,
          input.highWater,
          input.semantic.providerId,
          input.semantic.providerGenerationId,
          input.semantic.modelId,
          MESSAGE_SEARCH_VECTOR_DIMENSIONS,
          asSqlInteger(input.highWater),
          ...scopeParams,
          ...structured.params,
          poolLimit + 1
        ) as Row[]
      : this.searchKnnMessageRows({
          queryBytes,
          semantic: input.semantic,
          scope: input.scope,
          highWater: input.highWater,
          poolLimit,
          nativeVisibility: input.nativeVisibility,
          timelineItemSql
        });

    const poolCapped = ftsRows.length > poolLimit || vectorRows.length > poolLimit;
    const fused = fuseMessageSearchRanks(
      ftsRows.slice(0, poolLimit).map(messageSearchRankCandidateFromRow),
      vectorRows.slice(0, poolLimit).map(messageSearchRankCandidateFromRow)
    );
    if (fused.length === 0) {
      return {
        matches: [],
        totalSize: 0,
        revision: this.readRevision(),
        vectorUsed: true,
        poolCapped
      };
    }
    const byIdentity = new Map(fused.map((entry) => [entry.identityKey, entry]));
    const placeholders = fused.map(() => "?").join(",");
    const materialized = this.database.prepare(`
      SELECT
        event.session_id,
        event.target_id,
        event.id AS event_id,
        event.global_cursor,
        CASE
          WHEN json_extract(event.payload_json, '$.payload.type') = 'interaction_opened'
            THEN 'interaction:' || COALESCE(
              NULLIF(json_extract(event.payload_json, '$.payload.interaction.id'), ''),
              event.id
            )
          ELSE COALESCE(
            NULLIF(json_extract(event.payload_json, '$.payload.nativeHistory.identity.entryId'), ''),
            event.id
          )
        END AS timeline_item_id,
        json_extract(event.payload_json, '$.payload.role') AS role,
        event.emitted_at AS created_at,
        message_search_fts.visible_text
      FROM events AS event
      JOIN message_search_fts ON message_search_fts.rowid = event.global_cursor
      JOIN product_sessions AS session
        ON session.id = event.session_id AND session.deleted_at IS NULL
      WHERE event.global_cursor IN (${placeholders})
    `).all(...fused.map((entry) => asSqlInteger(entry.eventCursor))) as Row[];
    const ranked = fairMessageSearchRows(materialized.map((row) => {
      const rank = byIdentity.get(messageSearchIdentityKey(
        String(row["session_id"]),
        String(row["timeline_item_id"])
      ));
      if (rank === undefined) throw new StoreError("Hybrid message-search rank materialization drifted.");
      return { row, rank };
    }));
    const page = ranked.slice(input.offset, input.offset + input.limit);
    const matches: SessionMessageSearchRecord[] = page.map(({ row, rank }) => ({
      sessionId: String(row["session_id"]),
      targetId: String(row["target_id"]),
      eventId: String(row["event_id"]),
      timelineItemId: String(row["timeline_item_id"]),
      role: row["role"] === "user" ? "user" : "assistant",
      kind: "text_message",
      snippet: visibleMessageSnippet(String(row["visible_text"]), input.tokens),
      createdAt: Number(row["created_at"]),
      score: rank.score,
      ...(rank.ftsRank === undefined ? {} : { ftsRank: rank.ftsRank }),
      ...(rank.vectorRank === undefined ? {} : { vectorRank: rank.vectorRank })
    }));
    const nextOffset = input.offset + matches.length;
    return {
      matches,
      ...(nextOffset >= ranked.length
        ? {}
        : {
            nextPageToken: encodeMessageSearchCursor({
              v: 1,
              scopeKind: input.scope.kind,
              scopeId: input.scope.id,
              queryHash: input.queryHash,
              vectorFingerprint: messageSearchVectorFingerprint(input.semantic),
              highWater: input.highWater.toString(10),
              revision: input.revision.toString(10),
              offset: nextOffset
            })
          }),
      totalSize: ranked.length,
      revision: this.readRevision(),
      vectorUsed: true,
      poolCapped
    };
  }

  private searchKnnMessageRows(input: {
    readonly queryBytes: Uint8Array;
    readonly semantic: NormalizedMessageSearchSemantic;
    readonly scope: NormalizedMessageSearchScope;
    readonly highWater: bigint;
    readonly poolLimit: number;
    readonly nativeVisibility: NativeMessageSearchVisibility;
    readonly timelineItemSql: string;
  }): Row[] {
    const vectorScopeClause = input.scope.kind === "owner"
      ? ""
      : input.scope.kind === "session" ? " AND session_id = ?" : " AND target_id = ?";
    const eventScopeClause = input.scope.kind === "owner"
      ? ""
      : input.scope.kind === "session" ? " AND event.session_id = ?" : " AND event.target_id = ?";
    const scopeParams = input.scope.kind === "owner" ? [] : [input.scope.id];
    const count = this.database.prepare(`
      SELECT COUNT(*) AS total_size
      FROM ${MESSAGE_SEARCH_VECTOR_TABLE}
      WHERE provider_id = ?
        AND provider_generation_id = ?
        AND model_id = ?
        AND live = 1
        AND event_cursor <= ?${vectorScopeClause}
    `).get(
      input.semantic.providerId,
      input.semantic.providerGenerationId,
      input.semantic.modelId,
      asSqlInteger(input.highWater),
      ...scopeParams
    ) as Row;
    const totalSize = Number(count["total_size"] ?? 0);
    if (!Number.isSafeInteger(totalSize) || totalSize <= 0) return [];

    const statement = this.database.prepare(`
      WITH ${input.nativeVisibility.ctes},
      knn AS (
        SELECT rowid, distance
        FROM ${MESSAGE_SEARCH_VECTOR_TABLE}
        WHERE embedding MATCH ?
          AND k = ?
          AND provider_id = ?
          AND provider_generation_id = ?
          AND model_id = ?
          AND live = 1
          AND event_cursor <= ?${vectorScopeClause}
      ),
      candidate_vectors AS (
        SELECT
          event.global_cursor,
          event.session_id,
          ${input.timelineItemSql} AS timeline_item_id,
          knn.distance
        FROM knn
        JOIN message_embedding_records AS embedding ON embedding.event_cursor = knn.rowid
        JOIN events AS event ON event.global_cursor = knn.rowid
        JOIN product_sessions AS session
          ON session.id = event.session_id AND session.deleted_at IS NULL
        WHERE embedding.provider_id = ?
          AND embedding.provider_generation_id = ?
          AND embedding.model_id = ? AND embedding.dimensions = ?
          AND event.global_cursor <= ?${eventScopeClause}
          ${input.nativeVisibility.clause("event")}
      ),
      ranked_vectors AS (
        SELECT
          *,
          ROW_NUMBER() OVER (
            PARTITION BY session_id, timeline_item_id
            ORDER BY distance, global_cursor DESC
          ) AS duplicate_rank
        FROM candidate_vectors
      )
      SELECT global_cursor, session_id, timeline_item_id, distance
      FROM ranked_vectors
      WHERE duplicate_rank = 1
      ORDER BY distance, global_cursor DESC
      LIMIT ?
    `);
    let candidateCount = Math.min(totalSize, input.poolLimit + 1);
    for (;;) {
      const rows = statement.all(
        ...input.nativeVisibility.params,
        input.queryBytes,
        candidateCount,
        input.semantic.providerId,
        input.semantic.providerGenerationId,
        input.semantic.modelId,
        asSqlInteger(input.highWater),
        ...scopeParams,
        input.semantic.providerId,
        input.semantic.providerGenerationId,
        input.semantic.modelId,
        MESSAGE_SEARCH_VECTOR_DIMENSIONS,
        asSqlInteger(input.highWater),
        ...scopeParams,
        input.poolLimit + 1
      ) as Row[];
      if (rows.length > input.poolLimit || candidateCount >= totalSize) return rows;
      candidateCount = Math.min(totalSize, Math.max(candidateCount + 1, candidateCount * 2));
    }
  }

  private messageSearchScope(scope: SearchSessionMessagesInput["scope"]): NormalizedMessageSearchScope {
    if ("owner" in scope && scope.owner === true) return { kind: "owner", id: "" };
    if ("sessionId" in scope && typeof scope.sessionId === "string") {
      const sessionId = nonBlank(scope.sessionId, "Message search Session ID");
      this.getSession(sessionId);
      return { kind: "session", id: sessionId };
    }
    if ("targetId" in scope && typeof scope.targetId === "string") {
      const targetId = nonBlank(scope.targetId, "Message search Target ID");
      this.getTarget(targetId);
      return { kind: "target", id: targetId };
    }
    throw new StoreError("Message search requires an owner, Session, or Target scope.");
  }

  private indexNativeHistory(event: PersistedEvent): void {
    const identity = nativeHistoryEventContext(event.payload)?.identity;
    const fingerprintValue = event.metadata?.fields[NATIVE_HISTORY_BINDING_FINGERPRINT_FIELD];
    if (identity !== undefined && typeof fingerprintValue === "string" && nativeBindingFingerprintIsValid(fingerprintValue)) {
      const entryId = nativeHistoryIdentityText(identity.entryId, "entry ID");
      const parentEntryId = identity.parentEntryId === undefined
        ? undefined
        : nativeHistoryIdentityText(identity.parentEntryId, "parent entry ID");
      this.database.prepare(`
        INSERT INTO native_history_event_identities(
          event_cursor, session_id, binding_fingerprint, entry_id, parent_entry_id
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        asSqlInteger(event.globalCursor),
        event.sessionId,
        fingerprintValue,
        entryId,
        parentEntryId ?? null
      );
      const canonicalInsert = this.database.prepare(`
        INSERT OR IGNORE INTO native_history_canonical_identities(
          session_id, binding_fingerprint, entry_id, event_cursor, parent_entry_id
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        event.sessionId,
        fingerprintValue,
        entryId,
        asSqlInteger(event.globalCursor),
        parentEntryId ?? null
      );
      if (Number(canonicalInsert.changes) === 1 && parentEntryId !== undefined) {
        const missingActiveParent = this.database.prepare(`
          SELECT 1
          FROM native_history_current_markers AS marker
          JOIN native_history_active_entries AS active
            ON active.session_id = marker.session_id
            AND active.marker_cursor = marker.event_cursor
            AND active.entry_id = ?
          LEFT JOIN native_history_active_entries AS parent
            ON parent.session_id = marker.session_id
            AND parent.marker_cursor = marker.event_cursor
            AND parent.entry_id = ?
          WHERE marker.session_id = ?
            AND marker.binding_fingerprint = ?
            AND parent.entry_id IS NULL
          LIMIT 1
        `).get(entryId, parentEntryId, event.sessionId, fingerprintValue) as Row | undefined;
        if (missingActiveParent !== undefined) this.refreshNativeHistoryActiveEntries(event.sessionId);
      }
    }

    if (event.payload.type !== "native_session_changed") return;
    const nativeReference = nativeBindingReference(event.payload.opaqueRef);
    const leafId = event.payload.leafId === undefined
      ? undefined
      : nativeHistoryIdentityText(event.payload.leafId, "leaf ID");
    this.database.prepare(`
      INSERT INTO native_history_current_markers(
        session_id, event_cursor, native_opaque_ref, binding_fingerprint, leaf_id
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        event_cursor = excluded.event_cursor,
        native_opaque_ref = excluded.native_opaque_ref,
        binding_fingerprint = excluded.binding_fingerprint,
        leaf_id = excluded.leaf_id
    `).run(
      event.sessionId,
      asSqlInteger(event.globalCursor),
      nativeReference,
      nativeBindingFingerprint(nativeReference),
      leafId ?? null
    );
    this.refreshNativeHistoryActiveEntries(event.sessionId);
  }

  private refreshNativeHistoryActiveEntries(sessionId: string): void {
    this.database.prepare("DELETE FROM native_history_active_entries WHERE session_id = ?")
      .run(sessionId);
    const marker = this.database.prepare(`
      SELECT event_cursor, binding_fingerprint, leaf_id
      FROM native_history_current_markers
      WHERE session_id = ?
    `).get(sessionId) as Row | undefined;
    if (marker === undefined || marker["leaf_id"] === null) return;
    const markerCursor = toBigInt(marker["event_cursor"]);
    const bindingFingerprint = String(marker["binding_fingerprint"]);
    const leafId = String(marker["leaf_id"]);
    this.database.prepare(`
      WITH RECURSIVE
      ancestors(entry_id) AS (
        VALUES (?)
        UNION
        SELECT canonical.parent_entry_id
        FROM ancestors AS active
        JOIN native_history_canonical_identities AS canonical
          ON canonical.session_id = ?
          AND canonical.binding_fingerprint = ?
          AND canonical.entry_id = active.entry_id
        WHERE canonical.parent_entry_id IS NOT NULL
      )
      INSERT INTO native_history_active_entries(
        session_id, marker_cursor, binding_fingerprint, entry_id
      )
      SELECT ?, ?, ?, entry_id
      FROM ancestors
    `).run(
      leafId,
      sessionId,
      bindingFingerprint,
      sessionId,
      asSqlInteger(markerCursor),
      bindingFingerprint
    );
  }

  private refreshNativeHistoryCanonicalIdentities(sessionId: string): void {
    this.database.prepare(`
      DELETE FROM native_history_canonical_identities
      WHERE session_id = ?
        AND event_cursor IN (
          SELECT event.global_cursor
          FROM events AS event
          JOIN message_event_tombstones AS tombstone ON tombstone.event_id = event.id
          WHERE event.session_id = ?
        )
    `).run(sessionId, sessionId);
    this.database.prepare(`
      WITH first_visible_identity(binding_fingerprint, entry_id, event_cursor) AS (
        SELECT
          identity.binding_fingerprint,
          identity.entry_id,
          MIN(identity.event_cursor)
        FROM native_history_event_identities AS identity
        JOIN events AS identity_event ON identity_event.global_cursor = identity.event_cursor
        LEFT JOIN message_event_tombstones AS tombstone
          ON tombstone.event_id = identity_event.id
        LEFT JOIN native_history_canonical_identities AS canonical
          ON canonical.session_id = identity.session_id
          AND canonical.binding_fingerprint = identity.binding_fingerprint
          AND canonical.entry_id = identity.entry_id
        WHERE identity.session_id = ?
          AND tombstone.event_id IS NULL
          AND canonical.entry_id IS NULL
        GROUP BY identity.binding_fingerprint, identity.entry_id
      )
      INSERT OR IGNORE INTO native_history_canonical_identities(
        session_id, binding_fingerprint, entry_id, event_cursor, parent_entry_id
      )
      SELECT
        identity.session_id,
        identity.binding_fingerprint,
        identity.entry_id,
        identity.event_cursor,
        identity.parent_entry_id
      FROM first_visible_identity AS first
      JOIN native_history_event_identities AS identity
        ON identity.event_cursor = first.event_cursor
    `).run(sessionId);
  }

  private indexVisibleMessage(event: PersistedEvent): void {
    const visibleText = visibleMessageText(event.payload);
    if (visibleText === undefined) return;
    this.database.prepare(`
      INSERT INTO message_search_fts(rowid, event_id, visible_text)
      VALUES (?, ?, ?)
    `).run(asSqlInteger(event.globalCursor), event.id, visibleText);
  }

  createReviewRun(input: CreateReviewRunInput): ReviewRunBundle {
    this.assertOpen();
    durableOpaqueId(input.id, "Review run id");
    validateReviewSeal(input.evidenceSeal);
    validateReviewAttachments(input.attachments);
    const existing = this.findReviewRun(input.id);
    if (existing !== undefined) {
      const bundle = this.getReviewRunBundle(input.id);
      if (!sameReviewCreateRequest(bundle, input)) throw new StoreError(`Review run ${input.id} already exists with different durable inputs.`);
      return bundle;
    }
    return this.write(() => {
      this.getSession(input.sourceSessionId);
      const active = this.database.prepare(`
        SELECT review_run_id FROM review_source_leases
        WHERE source_session_id = ? AND state = 'active'
      `).get(input.sourceSessionId) as Row | undefined;
      if (active !== undefined) throw new StoreError(`Source Session ${input.sourceSessionId} already has an active review.`);
      const at = input.createdAt ?? this.now();
      const revision = asSqlInteger(this.requireActiveRevision());
      const tokenRow = this.database.prepare(`
        SELECT COALESCE(MAX(fencing_token), 0) + 1 AS next_token
        FROM review_source_leases WHERE source_session_id = ?
      `).get(input.sourceSessionId) as Row;
      const fencingToken = toBigInt(tokenRow["next_token"]);
      this.database.prepare(`
        INSERT INTO review_runs(
          id, source_session_id, target_kind, state, freshness,
          freshness_checked_at, created_at, updated_at, revision
        ) VALUES (?, ?, ?, 'running', 'current', ?, ?, ?, ?)
      `).run(durableOpaqueId(input.id, "Review run id"), input.sourceSessionId, input.targetKind, at, at, at, revision);
      this.database.prepare(`
        INSERT INTO review_source_leases(
          review_run_id, source_session_id, fencing_token, state, created_at, revision
        ) VALUES (?, ?, ?, 'active', ?, ?)
      `).run(input.id, input.sourceSessionId, asSqlInteger(fencingToken), at, revision);
      this.database.prepare(`
        INSERT INTO review_evidence_snapshots(
          review_run_id, seal_version, conversation_sha256, workspace_sha256,
          files_sha256, artifacts_sha256, seal_sha256, created_at, revision
        ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id,
        input.evidenceSeal.conversationSha256,
        input.evidenceSeal.workspaceSha256,
        input.evidenceSeal.filesSha256,
        input.evidenceSeal.artifactsSha256,
        input.evidenceSeal.sealSha256,
        at,
        revision
      );
      const insertAttachment = this.database.prepare(`
        INSERT INTO review_attachments(
          review_run_id, ordinal, kind, display_name, blob_id, sha256,
          byte_length, mime_type, file_name, revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      input.attachments.forEach((attachment, index) => insertAttachment.run(
        input.id,
        index + 1,
        attachment.kind,
        attachment.displayName,
        attachment.blob.id,
        normalizeSha256(attachment.blob.sha256),
        attachment.blob.byteLength,
        attachment.blob.mimeType.toLowerCase(),
        attachment.blob.fileName ?? null,
        revision
      ));
      const bundle = this.getReviewRunBundle(input.id);
      this.appendReviewRunChangedEvent(bundle.run, input.operationId, input.traceId ?? `review:${input.id}:running`);
      return bundle;
    });
  }

  getReviewRun(id: string): ReviewRunRecord {
    const value = this.findReviewRun(id);
    if (value === undefined) throw new NotFoundError("Review run", id);
    return value;
  }

  findReviewRun(id: string): ReviewRunRecord | undefined {
    this.assertOpen();
    const row = this.database.prepare("SELECT * FROM review_runs WHERE id = ?").get(id) as Row | undefined;
    return row === undefined ? undefined : reviewRunFromRow(row);
  }

  getReviewRunBundle(id: string): ReviewRunBundle {
    const run = this.getReviewRun(id);
    const leaseRow = this.database.prepare("SELECT * FROM review_source_leases WHERE review_run_id = ?")
      .get(id) as Row | undefined;
    const sealRow = this.database.prepare("SELECT * FROM review_evidence_snapshots WHERE review_run_id = ?")
      .get(id) as Row | undefined;
    if (leaseRow === undefined || sealRow === undefined) throw new StoreError(`Review run ${id} is missing durable source state.`);
    const attachments = this.database.prepare(`
      SELECT * FROM review_attachments WHERE review_run_id = ? ORDER BY ordinal
    `).all(id) as Row[];
    return {
      run,
      sourceLease: reviewSourceLeaseFromRow(leaseRow),
      evidenceSeal: reviewEvidenceSealFromRow(sealRow),
      attachments: attachments.map(reviewAttachmentFromRow)
    };
  }

  listReviewRunsBySource(sourceSessionId: string): readonly ReviewRunRecord[] {
    this.assertOpen();
    return (this.database.prepare(`
      SELECT * FROM review_runs WHERE source_session_id = ? ORDER BY created_at DESC, id
    `).all(sourceSessionId) as Row[]).map(reviewRunFromRow);
  }

  listReviewRunsByReviewer(reviewerSessionId: string): readonly ReviewRunRecord[] {
    this.assertOpen();
    return (this.database.prepare(`
      SELECT * FROM review_runs WHERE reviewer_session_id = ? ORDER BY created_at DESC, id
    `).all(reviewerSessionId) as Row[]).map(reviewRunFromRow);
  }

  listReviewRuns(options: import("./types.js").ListReviewRunsInput = {}): readonly ReviewRunRecord[] {
    this.assertOpen();
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    if (options.sourceSessionId !== undefined) {
      clauses.push("source_session_id = ?");
      values.push(options.sourceSessionId);
    }
    if (options.reviewerSessionId !== undefined) {
      clauses.push("reviewer_session_id = ?");
      values.push(options.reviewerSessionId);
    }
    if (options.state !== undefined) {
      if (!["running", "completed", "failed"].includes(options.state)) throw new StoreError("Review run state is invalid.");
      clauses.push("state = ?");
      values.push(options.state);
    }
    const limit = normalizeLimit(options.limit, 100);
    values.push(limit, normalizeOffset(options.offset));
    return (this.database.prepare(`
      SELECT * FROM review_runs
      ${clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`}
      ORDER BY created_at DESC, id
      LIMIT ? OFFSET ?
    `).all(...values) as Row[]).map(reviewRunFromRow);
  }

  countReviewRuns(options: Omit<import("./types.js").ListReviewRunsInput, "limit" | "offset"> = {}): number {
    this.assertOpen();
    const clauses: string[] = [];
    const values: string[] = [];
    if (options.sourceSessionId !== undefined) {
      clauses.push("source_session_id = ?");
      values.push(options.sourceSessionId);
    }
    if (options.reviewerSessionId !== undefined) {
      clauses.push("reviewer_session_id = ?");
      values.push(options.reviewerSessionId);
    }
    if (options.state !== undefined) {
      if (!["running", "completed", "failed"].includes(options.state)) throw new StoreError("Review run state is invalid.");
      clauses.push("state = ?");
      values.push(options.state);
    }
    const row = this.database.prepare(`
      SELECT COUNT(*) AS count FROM review_runs
      ${clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`}
    `).get(...values) as Row;
    return numberValue(row["count"]);
  }

  attachReviewSession(input: AttachReviewSessionInput): ReviewRunRecord {
    return this.write(() => {
      const current = this.getReviewRun(input.reviewRunId);
      const existingPolicy = this.findSessionRuntimePolicy(input.reviewerSessionId);
      if (current.reviewerSessionId === input.reviewerSessionId) {
        if (existingPolicy?.reviewRunId !== input.reviewRunId
          || existingPolicy.sourceLeaseFencingToken !== input.sourceLeaseFencingToken) {
          throw new StoreError(`Review run ${input.reviewRunId} has inconsistent runtime policy state.`);
        }
        return current;
      }
      if (current.state !== "running") throw new InvalidStateTransitionError("review run", current.state, "attached");
      if (current.reviewerSessionId !== undefined) throw new StoreError(`Review run ${input.reviewRunId} already has a Reviewer Session.`);
      if (current.revision !== input.expectedRunRevision) {
        throw new RevisionConflictError("Review run", current.id, input.expectedRunRevision, current.revision);
      }
      if (current.sourceSessionId === input.reviewerSessionId) throw new StoreError("A review must use a fresh dedicated Reviewer Session.");
      this.getSession(input.reviewerSessionId);
      const lease = this.requireActiveReviewLease(input.reviewRunId, input.sourceLeaseFencingToken);
      const at = input.at ?? this.now();
      const revision = asSqlInteger(this.requireActiveRevision());
      const updated = this.database.prepare(`
        UPDATE review_runs SET reviewer_session_id = ?, updated_at = ?, revision = ?
        WHERE id = ? AND state = 'running' AND reviewer_session_id IS NULL AND revision = ?
      `).run(input.reviewerSessionId, at, revision, input.reviewRunId, asSqlInteger(current.revision));
      if (updated.changes !== 1) throw new RevisionConflictError("Review run", current.id, current.revision, this.getReviewRun(current.id).revision);
      this.insertReviewReadOnlyPolicy(input.reviewerSessionId, input.reviewRunId, lease.fencingToken, at);
      const attached = this.getReviewRun(input.reviewRunId);
      this.appendReviewRunChangedEvent(attached, input.operationId, input.traceId ?? `review:${input.reviewRunId}:attached`);
      return attached;
    });
  }

  getSessionRuntimePolicy(sessionId: string): SessionRuntimePolicyRecord {
    const value = this.findSessionRuntimePolicy(sessionId);
    if (value === undefined) throw new NotFoundError("Session runtime policy", sessionId);
    return value;
  }

  findSessionRuntimePolicy(sessionId: string): SessionRuntimePolicyRecord | undefined {
    this.assertOpen();
    const row = this.database.prepare("SELECT * FROM session_runtime_policies WHERE session_id = ?")
      .get(sessionId) as Row | undefined;
    return row === undefined ? undefined : sessionRuntimePolicyFromRow(row);
  }

  finishReviewRun(input: FinishReviewRunInput): ReviewRunRecord {
    const result = input.state === "completed" ? boundedReviewResult(input.result) : null;
    const failureCode = input.state === "failed" ? input.failureCode : undefined;
    if (failureCode !== undefined && !REVIEW_FAILURE_CODES.includes(failureCode)) throw new StoreError("Review failure code is invalid.");
    if (!["current", "stale", "unavailable"].includes(input.freshness)) {
      throw new StoreError("Review freshness state is invalid.");
    }
    return this.write(() => {
      const current = this.getReviewRun(input.reviewRunId);
      if (current.state !== "running") {
        const replay = input.state === "completed"
          ? current.state === "completed" && current.result === result
          : current.state === "failed" && current.failureCode === input.failureCode;
        if (replay && current.freshness === input.freshness) return current;
        throw new InvalidStateTransitionError("review run", current.state, input.state);
      }
      if (current.revision !== input.expectedRunRevision) {
        throw new RevisionConflictError("Review run", current.id, input.expectedRunRevision, current.revision);
      }
      if (input.state === "completed" && (current.reviewerSessionId === undefined
        || this.findSessionRuntimePolicy(current.reviewerSessionId)?.reviewRunId !== current.id)) {
        throw new StoreError("A completed review requires an attached Reviewer Session with a durable read-only policy.");
      }
      this.requireActiveReviewLease(input.reviewRunId, input.sourceLeaseFencingToken);
      const at = input.at ?? this.now();
      const freshnessCheckedAt = reviewFreshnessTimestamp(input.freshnessCheckedAt ?? at);
      const revision = asSqlInteger(this.requireActiveRevision());
      const update = input.state === "completed"
        ? this.database.prepare(`
            UPDATE review_runs SET state = 'completed', result_text = ?, freshness = ?,
              freshness_checked_at = ?, ended_at = ?, updated_at = ?, revision = ?
            WHERE id = ? AND state = 'running' AND revision = ?
          `).run(result, input.freshness, freshnessCheckedAt, at, at, revision, input.reviewRunId, asSqlInteger(current.revision))
        : this.database.prepare(`
            UPDATE review_runs SET state = 'failed', failure_code = ?, freshness = ?,
              freshness_checked_at = ?, ended_at = ?, updated_at = ?, revision = ?
            WHERE id = ? AND state = 'running' AND revision = ?
          `).run(failureCode ?? null, input.freshness, freshnessCheckedAt, at, at, revision, input.reviewRunId, asSqlInteger(current.revision));
      if (update.changes !== 1) throw new RevisionConflictError("Review run", current.id, current.revision, this.getReviewRun(current.id).revision);
      const terminal = this.getReviewRun(input.reviewRunId);
      // Public terminal state is durably appended before releasing the source
      // lease. Subscribers can never observe a free source with a stale card.
      this.appendReviewRunChangedEvent(terminal, input.operationId, input.traceId ?? `review:${input.reviewRunId}:terminal`);
      const released = this.database.prepare(`
        UPDATE review_source_leases SET state = 'released', released_at = ?, revision = ?
        WHERE review_run_id = ? AND state = 'active' AND fencing_token = ?
      `).run(at, revision, input.reviewRunId, asSqlInteger(input.sourceLeaseFencingToken));
      if (released.changes !== 1) throw new StoreError(`Review source lease for ${input.reviewRunId} changed concurrently.`);
      return terminal;
    });
  }

  reobserveReview(input: ReobserveReviewInput): ReviewRunRecord {
    if (!(["current", "stale", "unavailable"] as const).includes(input.freshness)) {
      throw new StoreError("Review freshness observation is invalid.");
    }
    return this.write(() => {
      const current = this.getReviewRun(input.reviewRunId);
      if (current.state === "running") {
        throw new InvalidStateTransitionError("review run freshness", current.state, input.freshness);
      }
      if (current.revision !== input.expectedRunRevision) {
        throw new RevisionConflictError("Review run", current.id, input.expectedRunRevision, current.revision);
      }
      const freshness = current.freshness === "stale" ? "stale" : input.freshness;
      const checkedAt = Math.max(
        current.freshnessCheckedAt,
        reviewFreshnessTimestamp(input.checkedAt ?? this.now())
      );
      const revision = asSqlInteger(this.requireActiveRevision());
      const updated = this.database.prepare(`
        UPDATE review_runs
        SET freshness = ?, freshness_checked_at = ?, updated_at = ?, revision = ?
        WHERE id = ? AND state IN ('completed', 'failed') AND revision = ?
      `).run(freshness, checkedAt, Math.max(current.updatedAt, checkedAt), revision, current.id, asSqlInteger(current.revision));
      if (updated.changes !== 1) {
        throw new RevisionConflictError("Review run", current.id, current.revision, this.getReviewRun(current.id).revision);
      }
      const refreshed = this.getReviewRun(current.id);
      this.appendReviewRunChangedEvent(refreshed, input.operationId, input.traceId ?? `review:${current.id}:reobserve`);
      return refreshed;
    });
  }

  private insertReviewReadOnlyPolicy(sessionId: string, reviewRunId: string, fencingToken: bigint, at: number): SessionRuntimePolicyRecord {
    const existing = this.findSessionRuntimePolicy(sessionId);
    if (existing !== undefined) {
      if (existing.reviewRunId === reviewRunId && existing.sourceLeaseFencingToken === fencingToken) return existing;
      throw new StoreError(`Session ${sessionId} already has a different runtime policy.`);
    }
    this.database.prepare(`
      INSERT INTO session_runtime_policies(
        session_id, review_run_id, policy, source_lease_fencing_token,
        created_at, updated_at, revision
      ) VALUES (?, ?, 'review_read_only', ?, ?, ?, ?)
    `).run(sessionId, reviewRunId, asSqlInteger(fencingToken), at, at, asSqlInteger(this.requireActiveRevision()));
    return this.getSessionRuntimePolicy(sessionId);
  }

  private requireActiveReviewLease(reviewRunId: string, fencingToken: bigint): ReviewSourceLeaseRecord {
    const row = this.database.prepare("SELECT * FROM review_source_leases WHERE review_run_id = ?")
      .get(reviewRunId) as Row | undefined;
    if (row === undefined) throw new NotFoundError("Review source lease", reviewRunId);
    const lease = reviewSourceLeaseFromRow(row);
    if (lease.state !== "active" || lease.fencingToken !== fencingToken) throw new StoreError(`Review source lease for ${reviewRunId} is stale or inactive.`);
    return lease;
  }

  recoverStartup(traceId = `startup-recovery:${this.idFactory()}`): StartupRecoveryResult {
    this.assertOpen();
    const pending = this.database.prepare(`
      SELECT id FROM queue_items
      WHERE state IN ('dispatching', 'backend_accepted')
      ORDER BY created_at, id
    `).all() as Row[];
    const pendingRuns = this.database.prepare(`
      SELECT r.id
      FROM runs r
      LEFT JOIN attempts a ON a.id = r.active_attempt_id
      WHERE r.state IN ('running', 'waiting', 'retrying')
         OR (r.state = 'dispatch_unknown' AND a.ended_at IS NULL)
      ORDER BY r.created_at, r.id
    `).all() as Row[];
    const pendingEffects = this.database.prepare(`
      SELECT operation.id FROM operations AS operation
      WHERE operation.status = 'started' AND operation.completion_mode = 'external_effect'
        AND NOT EXISTS (
          SELECT 1 FROM schedule_deletion_cleanups AS cleanup
          WHERE cleanup.operation_id = operation.id AND cleanup.state = 'pending'
        )
        AND NOT EXISTS (
          SELECT 1 FROM session_lifecycle_cleanups AS cleanup
          WHERE cleanup.operation_id = operation.id AND cleanup.state = 'pending'
        )
      ORDER BY created_at, id
    `).all() as Row[];
    const pendingReviews = this.database.prepare(`
      SELECT id FROM review_runs WHERE state = 'running' ORDER BY created_at, id
    `).all() as Row[];
    if (pending.length === 0 && pendingRuns.length === 0 && pendingEffects.length === 0 && pendingReviews.length === 0) {
      return {
        recoveredQueueItemIds: [],
        affectedRunIds: [],
        recoveredEffectOperationIds: [],
        recoveredReviewRuns: [],
        revision: this.readRevision(),
        events: []
      };
    }
    return this.transaction(() => {
      const rows = this.database.prepare(`
        SELECT id FROM queue_items
        WHERE state IN ('dispatching', 'backend_accepted')
        ORDER BY created_at, id
      `).all() as Row[];
      const queueIds: string[] = [];
      const runIds = new Set<string>();
      const effectOperationIds: string[] = [];
      const recoveredReviewRuns: ReviewRunRecord[] = [];
      const error = dispatchUnknownError();
      const at = this.now();
      for (const row of rows) {
        const id = stringValue(row["id"]);
        const item = this.getQueueItem(id);
        this.updateQueueState({
          queueItemId: id,
          state: "dispatch_unknown",
          ...(item.attemptId === undefined ? {} : { attemptId: item.attemptId }),
          error,
          at,
          traceId
        });
        queueIds.push(id);
        runIds.add(item.runId);
      }
      const runRows = this.database.prepare(`
        SELECT r.id
        FROM runs r
        LEFT JOIN attempts a ON a.id = r.active_attempt_id
        WHERE r.state IN ('running', 'waiting', 'retrying')
           OR (r.state = 'dispatch_unknown' AND a.ended_at IS NULL)
        ORDER BY r.created_at, r.id
      `).all() as Row[];
      for (const row of runRows) runIds.add(stringValue(row["id"]));
      for (const runId of runIds) {
        const run = this.getRun(runId);
        if (!isTerminalRunState(run.descriptor.state) && run.descriptor.state !== "dispatch_unknown") {
          this.updateRunState({
            runId,
            state: "dispatch_unknown",
            error,
            ...(run.descriptor.activeAttemptId === undefined
              ? {}
              : { activeAttemptId: run.descriptor.activeAttemptId }),
            traceId
          });
        }
        if (run.descriptor.activeAttemptId !== undefined) {
          const attempt = this.getAttempt(run.descriptor.activeAttemptId);
          if (attempt.descriptor.endedAt === undefined) this.finishAttempt(attempt.descriptor.id, error, at);
        }
      }
      const effectRows = this.database.prepare(`
        SELECT operation.id FROM operations AS operation
        WHERE operation.status = 'started' AND operation.completion_mode = 'external_effect'
          AND NOT EXISTS (
            SELECT 1 FROM schedule_deletion_cleanups AS cleanup
            WHERE cleanup.operation_id = operation.id AND cleanup.state = 'pending'
          )
          AND NOT EXISTS (
            SELECT 1 FROM session_lifecycle_cleanups AS cleanup
            WHERE cleanup.operation_id = operation.id AND cleanup.state = 'pending'
          )
        ORDER BY created_at, id
      `).all() as Row[];
      const effectError = effectOutcomeUnknownError();
      for (const row of effectRows) {
        const operationId = stringValue(row["id"]);
        this.database.prepare(`
          UPDATE operations
          SET status = 'failed', error_json = ?, updated_at = ?, revision = ?
          WHERE id = ? AND status = 'started' AND completion_mode = 'external_effect'
        `).run(
          serializeJson(effectError),
          at,
          asSqlInteger(this.requireActiveRevision()),
          operationId
        );
        effectOperationIds.push(operationId);
      }
      const reviewRows = this.database.prepare(`
        SELECT id FROM review_runs WHERE state = 'running' ORDER BY created_at, id
      `).all() as Row[];
      for (const row of reviewRows) {
        const reviewRunId = stringValue(row["id"]);
        this.database.prepare(`
          UPDATE review_runs
          SET state = 'failed', failure_code = 'interrupted', ended_at = ?, updated_at = ?, revision = ?
          WHERE id = ? AND state = 'running'
        `).run(at, at, asSqlInteger(this.requireActiveRevision()), reviewRunId);
        const recoveredRun = this.getReviewRun(reviewRunId);
        this.appendReviewRunChangedEvent(recoveredRun, undefined, traceId);
        this.database.prepare(`
          UPDATE review_source_leases
          SET state = 'released', released_at = ?, revision = ?
          WHERE review_run_id = ? AND state = 'active'
        `).run(at, asSqlInteger(this.requireActiveRevision()), reviewRunId);
        recoveredReviewRuns.push(recoveredRun);
      }
      return {
        recoveredQueueItemIds: queueIds,
        affectedRunIds: [...runIds],
        recoveredEffectOperationIds: effectOperationIds,
        recoveredReviewRuns,
        revision: this.requireActiveRevision(),
        events: [...this.currentFrame().events]
      };
    });
  }

  private appendQueueControlEvent(
    control: QueueControlRecord,
    session: StoredSession,
    traceId: string
  ): PersistedEvent {
    return this.appendEvent({
      backendId: session.descriptor.backendId,
      targetId: session.descriptor.targetId,
      sessionId: session.descriptor.id,
      generation: session.descriptor.binding.generation,
      traceId,
      payload: {
        type: "queue_control",
        paused: control.paused,
        ...(control.pauseReason === undefined ? {} : { reason: control.pauseReason }),
        ...(control.pausedAt === undefined ? {} : { pausedAt: control.pausedAt }),
        ...(control.pausedByConnectionId === undefined ? {} : { connectionId: control.pausedByConnectionId })
      }
    });
  }

  private appendQueueEvent(
    item: QueueItemRecord,
    session: StoredSession,
    traceId: string,
    projectionAttemptId?: string
  ): PersistedEvent {
    return this.appendEvent({
      backendId: session.descriptor.backendId,
      targetId: session.descriptor.targetId,
      sessionId: session.descriptor.id,
      runId: item.runId,
      ...(projectionAttemptId === undefined && item.attemptId === undefined
        ? {}
        : { attemptId: projectionAttemptId ?? item.attemptId }),
      operationId: item.operationId,
      generation: session.descriptor.binding.generation,
      traceId,
      payload: {
        type: "queue_update",
        itemId: item.id,
        steering: [],
        followUps: []
      }
    });
  }

  private appendSessionAttentionEvent(
    session: StoredSession,
    attention: SessionAttentionRecord,
    traceId: string,
    operationId?: string
  ): PersistedEvent {
    return this.appendEvent({
      backendId: session.descriptor.backendId,
      targetId: session.descriptor.targetId,
      sessionId: session.descriptor.id,
      ...(operationId === undefined ? {} : { operationId }),
      generation: session.descriptor.binding.generation,
      emittedAt: attention.updatedAt,
      traceId,
      payload: {
        type: "session_attention",
        kind: attention.kind,
        unread: attention.unread,
        subjectCursor: attention.subjectCursor.toString(),
        subjectGeneration: attention.subjectGeneration,
        attentionCursor: attention.attentionCursor.toString(),
        attentionGeneration: attention.attentionGeneration,
        readThroughCursor: attention.readThroughCursor.toString(),
        readThroughGeneration: attention.readThroughGeneration
      }
    });
  }

  /** Normal terminals never downgrade or resurrect an unresolved interaction;
   * failures and pre-existing unread errors remain the higher-priority truth. */
  private recordTerminalSessionAttention(
    session: StoredSession,
    sourceEvent: PersistedEvent,
    failed: boolean,
    traceId: string,
    operationId?: string
  ): SessionAttentionRecord {
    if (sourceEvent.runId !== undefined) {
      const current = this.findSessionAttention(session.descriptor.id);
      const incomingKind: SessionAttentionKind = failed ? "error" : "done";
      if (current?.kind === incomingKind) {
        const subjectRow = this.database.prepare(
          "SELECT * FROM events WHERE global_cursor = ? AND session_id = ?"
        ).get(asSqlInteger(current.subjectCursor), session.descriptor.id) as Row | undefined;
        const subjectEvent = subjectRow === undefined ? undefined : eventFromRow(subjectRow);
        // A Backend can report one terminal through multiple durable lifecycle facts
        // (done plus a later run_state, and for failures the terminal error
        // payload plus run_state=failed plus done(outcome=failed)). Only the
        // first same-kind fact owns the subject. Later facts for that same run
        // advance the CAS fence without replacing or resurrecting a receipt. A
        // different run remains a new attention source.
        if (subjectEvent?.runId === sourceEvent.runId) {
          return this.advanceSessionAttentionState(session, sourceEvent, traceId, operationId);
        }
      }
    }
    if (!failed && this.listInteractions({ sessionId: session.descriptor.id, status: "open", limit: 1 }).length > 0) {
      const current = this.findSessionAttention(session.descriptor.id);
      if (current?.kind === "awaiting") {
        return this.advanceSessionAttentionState(session, sourceEvent, traceId, operationId);
      }
      return this.recordSessionAttention({
        sessionId: session.descriptor.id,
        kind: "awaiting",
        sourceCursor: sourceEvent.globalCursor,
        traceId,
        ...(operationId === undefined ? {} : { operationId }),
        at: sourceEvent.emittedAt
      });
    }
    return this.recordSessionAttention({
      sessionId: session.descriptor.id,
      kind: failed ? "error" : "done",
      sourceCursor: sourceEvent.globalCursor,
      traceId,
      ...(operationId === undefined ? {} : { operationId }),
      at: sourceEvent.emittedAt
    });
  }

  private latestOpenInteractionSourceEvent(sessionId: string): PersistedEvent | undefined {
    const row = this.database.prepare(`
      SELECT opening_event.*
      FROM interactions AS interaction
      JOIN events AS opening_event
        ON opening_event.session_id = interaction.session_id
       AND json_extract(opening_event.payload_json, '$.payload.type') = 'interaction_opened'
       AND json_extract(opening_event.payload_json, '$.payload.interaction.id') = interaction.id
      WHERE interaction.session_id = ?
        AND interaction.status = 'open'
        AND NOT EXISTS (
          SELECT 1 FROM message_event_tombstones AS tombstone
          WHERE tombstone.event_id = opening_event.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM session_reset_boundaries AS reset
          WHERE reset.session_id = interaction.session_id
            AND interaction.rowid <= reset.cleared_through_interaction_rowid
        )
      ORDER BY opening_event.global_cursor DESC
      LIMIT 1
    `).get(sessionId) as Row | undefined;
    return row === undefined ? undefined : eventFromRow(row);
  }

  private advanceSessionAttentionState(
    session: StoredSession,
    sourceEvent: PersistedEvent,
    traceId: string,
    operationId?: string,
    options: {
      readonly kind?: SessionAttentionKind;
      readonly unread?: boolean;
      readonly subjectEvent?: PersistedEvent;
    } = {}
  ): SessionAttentionRecord {
    const current = this.getSessionAttention(session.descriptor.id);
    if (sourceEvent.generation !== session.descriptor.binding.generation) {
      throw new StaleGenerationError(session.descriptor.binding.generation, sourceEvent.generation);
    }
    if (
      options.subjectEvent !== undefined &&
      options.subjectEvent.generation !== session.descriptor.binding.generation
    ) {
      throw new StaleGenerationError(session.descriptor.binding.generation, options.subjectEvent.generation);
    }
    if (sourceEvent.globalCursor <= current.attentionCursor) return current;
    const kind = options.kind ?? current.kind;
    const unread = options.unread ?? current.unread;
    const subjectCursor = options.subjectEvent?.globalCursor ?? current.subjectCursor;
    const subjectGeneration = options.subjectEvent?.generation ?? current.subjectGeneration;
    const readThroughCursor = unread ? current.readThroughCursor : sourceEvent.globalCursor;
    const readThroughGeneration = unread ? current.readThroughGeneration : sourceEvent.generation;
    const result = this.database.prepare(`
      UPDATE session_attention
      SET kind = ?, unread = ?, subject_cursor = ?, subject_generation = ?,
          attention_cursor = ?, attention_generation = ?,
          read_through_cursor = ?, read_through_generation = ?,
          updated_at = ?, revision = ?
      WHERE session_id = ? AND attention_cursor = ? AND attention_generation = ?
    `).run(
      kind,
      boolInt(unread),
      asSqlInteger(subjectCursor),
      subjectGeneration,
      asSqlInteger(sourceEvent.globalCursor),
      sourceEvent.generation,
      asSqlInteger(readThroughCursor),
      readThroughGeneration,
      sourceEvent.emittedAt,
      asSqlInteger(this.requireActiveRevision()),
      session.descriptor.id,
      asSqlInteger(current.attentionCursor),
      current.attentionGeneration
    );
    if (Number(result.changes) !== 1) return this.getSessionAttention(session.descriptor.id);
    const updated = this.getSessionAttention(session.descriptor.id);
    this.appendSessionAttentionEvent(session, updated, traceId, operationId);
    return updated;
  }

  private clearSessionAttentionFromLifecycle(
    session: StoredSession,
    sourceEvent: PersistedEvent,
    traceId: string,
    operationId?: string
  ): SessionAttentionRecord | undefined {
    const current = this.findSessionAttention(session.descriptor.id);
    if (current === undefined || sourceEvent.globalCursor <= current.attentionCursor) return current;
    const result = this.database.prepare(`
      UPDATE session_attention
      SET unread = 0, attention_cursor = ?, attention_generation = ?,
          read_through_cursor = ?, read_through_generation = ?,
          updated_at = ?, revision = ?
      WHERE session_id = ? AND attention_cursor = ? AND attention_generation = ?
    `).run(
      asSqlInteger(sourceEvent.globalCursor),
      sourceEvent.generation,
      asSqlInteger(sourceEvent.globalCursor),
      sourceEvent.generation,
      sourceEvent.emittedAt,
      asSqlInteger(this.requireActiveRevision()),
      session.descriptor.id,
      asSqlInteger(current.attentionCursor),
      current.attentionGeneration
    );
    if (Number(result.changes) !== 1) return this.findSessionAttention(session.descriptor.id);
    const updated = this.getSessionAttention(session.descriptor.id);
    this.appendSessionAttentionEvent(session, updated, traceId, operationId);
    return updated;
  }

  openInteraction(input: OpenInteractionInput): InteractionRecord {
    return this.write(() => {
      const session = this.getSession(input.sessionId);
      if (input.generation !== session.descriptor.binding.generation) {
        throw new StaleGenerationError(session.descriptor.binding.generation, input.generation);
      }
      if (input.runId !== undefined) {
        const run = this.getRun(input.runId);
        if (run.descriptor.sessionId !== input.sessionId) {
          throw new StoreError("Interaction run does not belong to its session.");
        }
      }
      if (input.attemptId !== undefined) {
        const attempt = this.getAttempt(input.attemptId);
        if (input.runId === undefined || attempt.descriptor.runId !== input.runId) {
          throw new StoreError("Interaction attempt does not belong to its run.");
        }
      }
      if (input.operationId !== undefined) this.getOperation(input.operationId);
      const hadOpenInteraction = this.listInteractions({
        sessionId: input.sessionId,
        status: "open",
        limit: 1
      }).length > 0;
      const createdAt = input.createdAt ?? this.now();
      this.database.prepare(`
        INSERT INTO interactions(
          id, session_id, run_id, attempt_id, operation_id, generation, kind,
          status, payload_json, created_at, revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)
      `).run(
        input.payload.id,
        input.sessionId,
        input.runId ?? null,
        input.attemptId ?? null,
        input.operationId ?? null,
        input.generation,
        input.payload.kind,
        serializeJson(input.payload),
        createdAt,
        asSqlInteger(this.requireActiveRevision())
      );
      const sourceEvent = this.appendEvent({
        backendId: session.descriptor.backendId,
        targetId: session.descriptor.targetId,
        sessionId: input.sessionId,
        ...(input.runId === undefined ? {} : { runId: input.runId }),
        ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
        ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
        generation: input.generation,
        traceId: input.traceId,
        payload: { type: "interaction_opened", interaction: input.payload }
      });
      const attention = this.findSessionAttention(session.descriptor.id);
      if (hadOpenInteraction && attention?.kind === "awaiting") {
        // Pending attention is a rising-edge signal. Adding another request
        // while one is already open rebases the aggregate subject/fence but
        // preserves whether the viewer already consumed that pending state.
        this.advanceSessionAttentionState(
          session,
          sourceEvent,
          `${input.traceId}:attention`,
          input.operationId,
          { subjectEvent: sourceEvent }
        );
      } else {
        this.recordSessionAttention({
          sessionId: session.descriptor.id,
          kind: "awaiting",
          sourceCursor: sourceEvent.globalCursor,
          traceId: `${input.traceId}:attention`,
          ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
          at: sourceEvent.emittedAt
        });
      }
      return this.getInteraction(input.payload.id);
    });
  }

  getInteraction(id: string): InteractionRecord {
    this.assertOpen();
    const row = this.database.prepare("SELECT * FROM interactions WHERE id = ?").get(id) as Row | undefined;
    if (row === undefined) throw new NotFoundError("Interaction", id);
    return interactionFromRow(row);
  }

  listInteractions(options: InteractionListOptions = {}): InteractionRecord[] {
    this.assertOpen();
    const filter = interactionSqlFilter(options);
    return (this.database.prepare(
      `SELECT interaction.* FROM interactions AS interaction ${filter.where}
       ORDER BY interaction.created_at DESC, interaction.id LIMIT ? OFFSET ?`
    ).all(...filter.params, normalizeLimit(options.limit, 500), normalizeOffset(options.offset)) as Row[])
      .map(interactionFromRow);
  }

  countInteractions(options: Omit<InteractionListOptions, "limit" | "offset"> = {}): number {
    this.assertOpen();
    const filter = interactionSqlFilter(options);
    const row = this.database.prepare(
      `SELECT COUNT(*) AS count FROM interactions AS interaction ${filter.where}`
    ).get(...filter.params) as Row;
    return numberValue(row["count"]);
  }

  private appendReviewRunChangedEvent(run: ReviewRunRecord, operationId: string | undefined, traceId: string): PersistedEvent {
    const source = this.getSession(run.sourceSessionId);
    const evidence = this.getReviewRunBundle(run.id).evidenceSeal;
    return this.appendEvent({
      backendId: source.descriptor.backendId,
      targetId: source.descriptor.targetId,
      sessionId: source.descriptor.id,
      ...(operationId === undefined ? {} : { operationId }),
      generation: source.descriptor.binding.generation,
      traceId,
      payload: {
        type: "review_run_changed",
        reviewRun: {
          id: run.id,
          sourceSessionId: run.sourceSessionId,
          ...(run.reviewerSessionId === undefined ? {} : { reviewerSessionId: run.reviewerSessionId }),
          targetKind: run.targetKind,
          state: run.state,
          freshness: run.freshness,
          freshnessCheckedAt: run.freshnessCheckedAt,
          evidence: {
            sealSha256: evidence.sealSha256,
            sourceRevision: {
              version: evidence.version,
              conversationSha256: evidence.conversationSha256,
              workspaceSha256: evidence.workspaceSha256,
              filesSha256: evidence.filesSha256,
              artifactsSha256: evidence.artifactsSha256
            },
            targetKind: run.targetKind,
            capturedAt: evidence.createdAt
          },
          ...(run.result === undefined ? {} : { result: run.result }),
          ...(run.failureCode === undefined ? {} : { failureCode: run.failureCode }),
          createdAt: run.createdAt,
          updatedAt: run.updatedAt,
          ...(run.endedAt === undefined ? {} : { endedAt: run.endedAt }),
          revision: run.revision.toString()
        }
      }
    });
  }

  resolveInteraction(
    id: string,
    generation: number,
    decision: unknown,
    traceId: string,
    operationId?: string,
    resolvedAt = this.now()
  ): InteractionRecord {
    return this.settleInteraction(id, generation, {
      status: "resolved",
      decision,
      traceId,
      ...(operationId === undefined ? {} : { operationId }),
      resolvedAt
    });
  }

  dismissInteraction(
    id: string,
    generation: number,
    reason: string,
    traceId: string,
    operationId?: string,
    resolvedAt = this.now()
  ): InteractionRecord {
    return this.settleInteraction(id, generation, {
      status: "dismissed",
      reason: nonBlank(redactSecrets(reason), "Interaction dismissal reason"),
      traceId,
      ...(operationId === undefined ? {} : { operationId }),
      resolvedAt
    });
  }

  private settleInteraction(
    id: string,
    generation: number,
    outcome:
      | {
        readonly status: "resolved";
        readonly decision: unknown;
        readonly traceId: string;
        readonly operationId?: string;
        readonly resolvedAt: number;
      }
      | {
        readonly status: "dismissed";
        readonly reason: string;
        readonly traceId: string;
        readonly operationId?: string;
        readonly resolvedAt: number;
      }
  ): InteractionRecord {
    return this.write(() => {
      const current = this.getInteraction(id);
      const session = this.getSession(current.sessionId);
      if (
        current.generation !== generation ||
        session.descriptor.binding.generation !== generation
      ) {
        throw new StaleGenerationError(session.descriptor.binding.generation, generation);
      }
      if (current.status !== "open") return current;
      if (outcome.operationId !== undefined) this.getOperation(outcome.operationId);
      const result = this.database.prepare(`
        UPDATE interactions SET
          status = ?, decision_json = ?, dismissal_reason = ?, resolved_at = ?, revision = ?
        WHERE id = ? AND status = 'open' AND generation = ?
      `).run(
        outcome.status,
        outcome.status === "resolved" ? serializeJson(outcome.decision) : null,
        outcome.status === "dismissed" ? outcome.reason : null,
        outcome.resolvedAt,
        asSqlInteger(this.requireActiveRevision()),
        id,
        generation
      );
      if (result.changes !== 1) throw new StoreError(`Interaction ${id} changed concurrently.`);
      const sourceEvent = this.appendEvent({
        backendId: session.descriptor.backendId,
        targetId: session.descriptor.targetId,
        sessionId: session.descriptor.id,
        ...(current.runId === undefined ? {} : { runId: current.runId }),
        ...(current.attemptId === undefined ? {} : { attemptId: current.attemptId }),
        ...(outcome.operationId ?? current.operationId) === undefined
          ? {}
          : { operationId: outcome.operationId ?? current.operationId },
        generation,
        traceId: outcome.traceId,
        payload: outcome.status === "resolved"
          ? {
            type: "interaction_resolved",
            interactionId: id,
            decision: decisionText(outcome.decision)
          }
          : {
            type: "interaction_dismissed",
            interactionId: id,
            reason: outcome.reason
          }
      });
      const attention = this.findSessionAttention(session.descriptor.id);
      const remainingOpenSource = this.latestOpenInteractionSourceEvent(session.descriptor.id);
      if (remainingOpenSource === undefined) {
        if (attention?.kind === "awaiting") {
          this.clearSessionAttentionFromLifecycle(
            session,
            sourceEvent,
            `${outcome.traceId}:attention-settled`,
            outcome.operationId
          );
        } else if (attention?.kind === "error") {
          this.advanceSessionAttentionState(
            session,
            sourceEvent,
            `${outcome.traceId}:attention-error-fence`,
            outcome.operationId
          );
        }
      } else if (attention?.kind === "awaiting") {
        this.advanceSessionAttentionState(
          session,
          sourceEvent,
          `${outcome.traceId}:attention-rebased`,
          outcome.operationId,
          { subjectEvent: remainingOpenSource }
        );
      } else if (attention?.kind === "error") {
        this.advanceSessionAttentionState(
          session,
          sourceEvent,
          `${outcome.traceId}:attention-error-fence`,
          outcome.operationId
        );
      }
      return this.getInteraction(id);
    });
  }

  upsertSchedule(input: UpsertScheduleInput): ScheduleRecord {
    return this.write(() => {
      if (this.findPendingScheduleDeletionCleanupForSchedule(input.id) !== undefined) {
        throw new StoreError("Schedule deletion is in progress.");
      }
      const target = this.getTarget(input.targetId);
      if (target.descriptor.backendId !== input.backendId) {
        throw new StoreError("Schedule target does not belong to its backend.");
      }
      if (input.sessionId !== undefined) {
        const session = this.getSession(input.sessionId);
        if (
          session.descriptor.backendId !== input.backendId ||
          session.descriptor.targetId !== input.targetId
        ) {
          throw new StoreError("Schedule session does not match its backend and target.");
        }
      }
      if (input.sessionMode === "fresh" && input.sessionId !== undefined) {
        throw new StoreError("Fresh Schedules cannot retain a Session binding.");
      }
      if (input.sessionMode === "bound" && input.sessionId === undefined) {
        throw new StoreError("Bound Schedules require a Session binding.");
      }
      const existing = this.findSchedule(input.id);
      const anchorAt = input.kind === "interval"
        ? input.anchorAt ?? (existing?.kind === "interval" ? existing.anchorAt : undefined)
        : undefined;
      if (input.kind === "interval" && anchorAt === undefined) {
        throw new StoreError("Interval Schedule anchor is required.");
      }
      if (input.expectedRevision !== undefined) {
        const actual = existing?.revision ?? 0n;
        if (actual !== input.expectedRevision) {
          throw new RevisionConflictError("Schedule", input.id, input.expectedRevision, actual);
        }
      }
      const now = input.now ?? this.now();
      if (existing === undefined) {
        this.database.prepare(`
          INSERT INTO schedules(
            id, backend_id, target_id, session_mode, session_id, name, kind, expression, anchor_at, timezone,
            enabled, prompt_json, execution_snapshot_json, overlap_policy, misfire_policy,
            next_run_at, last_run_at, created_at, updated_at, revision
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          input.id,
          input.backendId,
          input.targetId,
          input.sessionMode,
          input.sessionId ?? null,
          nonBlank(input.name, "Schedule name"),
          input.kind,
          input.expression ?? null,
          anchorAt ?? null,
          nonBlank(input.timezone, "Schedule timezone"),
          boolInt(input.enabled),
          serializeJson(input.prompt),
          serializeJson(input.executionSnapshot),
          input.overlapPolicy,
          input.misfirePolicy,
          input.nextRunAt ?? null,
          input.lastRunAt ?? null,
          now,
          now,
          asSqlInteger(this.requireActiveRevision())
        );
      } else {
        this.database.prepare(`
          UPDATE schedules SET
            backend_id = ?, target_id = ?, session_mode = ?, session_id = ?, name = ?, kind = ?, expression = ?,
            anchor_at = ?, timezone = ?, enabled = ?, prompt_json = ?, execution_snapshot_json = ?,
            overlap_policy = ?, misfire_policy = ?, next_run_at = ?, last_run_at = ?, updated_at = ?, revision = ?
          WHERE id = ? AND revision = ?
        `).run(
          input.backendId,
          input.targetId,
          input.sessionMode,
          input.sessionId ?? null,
          nonBlank(input.name, "Schedule name"),
          input.kind,
          input.expression ?? null,
          anchorAt ?? null,
          nonBlank(input.timezone, "Schedule timezone"),
          boolInt(input.enabled),
          serializeJson(input.prompt),
          serializeJson(input.executionSnapshot),
          input.overlapPolicy,
          input.misfirePolicy,
          input.nextRunAt ?? null,
          input.lastRunAt ?? existing.lastRunAt ?? null,
          now,
          asSqlInteger(this.requireActiveRevision()),
          input.id,
          asSqlInteger(existing.revision)
        );
      }
      return this.getSchedule(input.id);
    });
  }

  bindPersistentScheduleSession(
    id: string,
    sessionId: string,
    expectedRevision: bigint,
    now = this.now()
  ): ScheduleRecord {
    return this.write(() => {
      const schedule = this.getSchedule(id);
      if (schedule.revision !== expectedRevision) {
        throw new RevisionConflictError("Schedule", id, expectedRevision, schedule.revision);
      }
      if (schedule.sessionMode !== "persistent") {
        throw new StoreError("Only a persistent Schedule can durably bind its generated Session.");
      }
      const session = this.getSession(sessionId);
      if (
        session.descriptor.deletedAt !== undefined ||
        session.descriptor.backendId !== schedule.backendId ||
        session.descriptor.targetId !== schedule.targetId
      ) {
        throw new StoreError("Persistent Schedule Session does not match its live routing.");
      }
      const result = this.database.prepare(`
        UPDATE schedules
        SET session_id = ?, updated_at = ?, revision = ?
        WHERE id = ? AND revision = ? AND session_mode = 'persistent'
      `).run(
        sessionId,
        now,
        asSqlInteger(this.requireActiveRevision()),
        id,
        asSqlInteger(expectedRevision)
      );
      if (result.changes !== 1) {
        throw new RevisionConflictError("Schedule", id, expectedRevision, this.getSchedule(id).revision);
      }
      return this.getSchedule(id);
    });
  }

  getSchedule(id: string): ScheduleRecord {
    const schedule = this.findSchedule(id);
    if (schedule === undefined) throw new NotFoundError("Schedule", id);
    return schedule;
  }

  findSchedule(id: string): ScheduleRecord | undefined {
    this.assertOpen();
    const row = this.database.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as Row | undefined;
    return row === undefined ? undefined : scheduleFromRow(row);
  }

  listSchedules(options: {
    readonly targetId?: string;
    readonly sessionId?: string;
    readonly enabledOnly?: boolean;
  } = {}): ScheduleRecord[] {
    this.assertOpen();
    const clauses: string[] = [];
    const params: string[] = [];
    if (options.targetId !== undefined) {
      clauses.push("target_id = ?");
      params.push(options.targetId);
    }
    if (options.sessionId !== undefined) {
      clauses.push("session_id = ?");
      params.push(options.sessionId);
    }
    if (options.enabledOnly === true) clauses.push("enabled = 1");
    const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
    return (this.database.prepare(
      `SELECT * FROM schedules ${where} ORDER BY name, id`
    ).all(...params) as Row[]).map(scheduleFromRow);
  }

  listDueSchedules(at = this.now(), limit = 100, offset = 0): ScheduleRecord[] {
    this.assertOpen();
    return (this.database.prepare(`
      SELECT * FROM schedules
      WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
      ORDER BY next_run_at, id LIMIT ? OFFSET ?
    `).all(at, normalizeLimit(limit, 100), normalizeOffset(offset)) as Row[]).map(scheduleFromRow);
  }

  deleteSchedule(id: string, expectedRevision?: bigint, deletionOperationId?: string): ScheduleRecord {
    return this.write(() => {
      const pendingDeletion = this.findPendingScheduleDeletionCleanupForSchedule(id);
      if (pendingDeletion !== undefined && pendingDeletion.operationId !== deletionOperationId) {
        throw new StoreError("Schedule deletion is in progress.");
      }
      const current = this.getSchedule(id);
      if (expectedRevision !== undefined && current.revision !== expectedRevision) {
        throw new RevisionConflictError("Schedule", id, expectedRevision, current.revision);
      }
      const result = this.database.prepare("DELETE FROM schedules WHERE id = ? AND revision = ?")
        .run(id, asSqlInteger(current.revision));
      if (result.changes !== 1) {
        throw new RevisionConflictError("Schedule", id, current.revision, this.findSchedule(id)?.revision ?? 0n);
      }
      const linkedSessions = (this.database.prepare(`
        SELECT id FROM product_sessions WHERE automation_schedule_id = ? ORDER BY id
      `).all(id) as Row[]).map((row) => stringValue(row["id"]));
      if (linkedSessions.length > 0) {
        this.database.prepare(`
          UPDATE product_sessions
          SET automation_schedule_id = NULL, automation_schedule_name = NULL,
              automation_run_id = NULL, revision = ?
          WHERE automation_schedule_id = ?
        `).run(asSqlInteger(this.requireActiveRevision()), id);
        for (const sessionId of linkedSessions) {
          const session = this.getSession(sessionId);
          this.appendSessionProjectionEvent(
            session,
            `session-automation-owner-removed:${sessionId}:${session.revision.toString(10)}`
          );
        }
      }
      return current;
    });
  }

  recordScheduleRun(
    scheduleId: string,
    runId: string,
    status: string,
    detail?: unknown,
    firedAt = this.now()
  ): ScheduleRunRecord {
    return this.write(() => {
      const schedule = this.getSchedule(scheduleId);
      const run = this.getRun(runId);
      const session = this.getSession(run.descriptor.sessionId);
      if (
        (schedule.sessionId !== undefined && schedule.sessionId !== session.descriptor.id) ||
        schedule.targetId !== session.descriptor.targetId ||
        schedule.backendId !== session.descriptor.backendId
      ) {
        throw new StoreError("Schedule run does not match the schedule routing.");
      }
      return this.upsertScheduleRunHistory({
        schedule,
        runId,
        sessionId: session.descriptor.id,
        firedAt,
        status,
        ...(detail === undefined ? {} : { detail })
      });
    });
  }

  /** Persist an occurrence before a product Session/core Run exists. Later
   * admission joins the same globally stable run ID and fills sessionId. */
  recordScheduleOccurrence(input: {
    readonly scheduleId: string;
    readonly runId: string;
    readonly sessionId?: string;
    readonly firedAt?: number;
    readonly finishedAt?: number;
    readonly status: string;
    readonly detail?: unknown;
  }): ScheduleRunRecord {
    return this.write(() => {
      const schedule = this.getSchedule(input.scheduleId);
      if (input.sessionId !== undefined) {
        const session = this.getSession(input.sessionId);
        if (
          schedule.targetId !== session.descriptor.targetId ||
          schedule.backendId !== session.descriptor.backendId
        ) throw new StoreError("Schedule occurrence Session does not match the schedule routing.");
      }
      const firedAt = input.firedAt ?? this.now();
      if (input.finishedAt !== undefined && input.finishedAt < firedAt) {
        throw new StoreError("Schedule occurrence cannot finish before it fired.");
      }
      return this.upsertScheduleRunHistory({
        schedule,
        runId: nonBlank(input.runId, "Schedule occurrence run ID"),
        ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
        firedAt,
        ...(input.finishedAt === undefined ? {} : { finishedAt: input.finishedAt }),
        status: input.status,
        ...(input.detail === undefined ? {} : { detail: input.detail })
      });
    });
  }

  private upsertScheduleRunHistory(input: {
    readonly schedule: ScheduleRecord;
    readonly runId: string;
    readonly sessionId?: string;
    readonly firedAt: number;
    readonly finishedAt?: number;
    readonly status: string;
    readonly detail?: unknown;
  }): ScheduleRunRecord {
    const status = nonBlank(input.status, "Schedule run status");
    const existingRow = this.database.prepare(`
      SELECT * FROM schedule_run_history WHERE schedule_id = ? AND run_id = ?
    `).get(input.schedule.id, input.runId) as Row | undefined;
    let id: bigint;
    if (existingRow === undefined) {
      const detail = scheduleRunDetailWithReadAt(
        input.detail,
        status.toLowerCase() === "skipped" ? input.finishedAt ?? input.firedAt : undefined
      );
      const insert = this.database.prepare(`
        INSERT INTO schedule_run_history(
          schedule_id, run_id, session_id, fired_at, finished_at,
          status, detail_json, revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.schedule.id,
        input.runId,
        input.sessionId ?? null,
        input.firedAt,
        input.finishedAt ?? null,
        status,
        detail === undefined ? null : serializeJson(detail),
        asSqlInteger(this.requireActiveRevision())
      );
      id = toBigInt(insert.lastInsertRowid);
    } else {
      const existing = scheduleRunFromRow(existingRow);
      if (existing.firedAt !== input.firedAt) {
        throw new StoreError("Schedule occurrence identity was reused with a different fire time.");
      }
      const detail = scheduleRunDetailWithReadAt(
        input.detail === undefined ? existing.detail : input.detail,
        existing.readAt ?? (status.toLowerCase() === "skipped" ? input.finishedAt ?? input.firedAt : undefined)
      );
      this.database.prepare(`
        UPDATE schedule_run_history
        SET session_id = ?, finished_at = ?, status = ?, detail_json = ?, revision = ?
        WHERE id = ?
      `).run(
        input.sessionId ?? existing.sessionId ?? null,
        input.finishedAt ?? existing.finishedAt ?? null,
        status,
        detail === undefined ? null : serializeJson(detail),
        asSqlInteger(this.requireActiveRevision()),
        asSqlInteger(existing.id)
      );
      id = existing.id;
    }
    this.database.prepare(`
      UPDATE schedules SET last_run_at = ?, updated_at = ?, revision = ? WHERE id = ?
    `).run(input.firedAt, input.firedAt, asSqlInteger(this.requireActiveRevision()), input.schedule.id);
    return this.getScheduleRun(id);
  }

  getScheduleRun(id: bigint): ScheduleRunRecord {
    this.assertOpen();
    const row = this.database.prepare("SELECT * FROM schedule_run_history WHERE id = ?")
      .get(asSqlInteger(id)) as Row | undefined;
    if (row === undefined) throw new NotFoundError("Schedule run", id.toString());
    return scheduleRunFromRow(row);
  }

  prepareSessionLifecycleCleanup(input: {
    readonly operationId: string;
    readonly sessionId: string;
    readonly disposition: "archive" | "delete";
    readonly deleteNativeSession?: boolean;
    readonly deleteArtifacts?: boolean;
    readonly releaseWorktree?: boolean;
    readonly cleanupGitSafety?: boolean;
    readonly at?: number;
  }): SessionLifecycleCleanupRecord {
    const operationId = nonBlank(input.operationId, "Session lifecycle operation ID");
    const sessionId = nonBlank(input.sessionId, "Session ID");
    const at = input.at ?? this.now();
    if (!Number.isSafeInteger(at) || at < 0) throw new StoreError("Session lifecycle time is invalid.");
    return this.write(() => {
      const existing = this.findSessionLifecycleCleanup(operationId);
      if (existing !== undefined) {
        if (
          existing.sessionId !== sessionId
          || existing.disposition !== input.disposition
          || existing.deleteNativeSession !== (input.deleteNativeSession ?? false)
          || existing.deleteArtifacts !== (input.deleteArtifacts ?? false)
          || existing.releaseWorktree !== (input.releaseWorktree ?? false)
          || existing.cleanupGitSafety !== (input.cleanupGitSafety ?? false)
        ) throw new StoreError("Session lifecycle cleanup does not match its operation request.");
        return existing;
      }
      this.getSession(sessionId);
      const pending = this.findPendingSessionLifecycleCleanup(sessionId);
      if (pending !== undefined) throw new OperationInProgressError(pending.operationId);
      const scheduleDeletion = this.findPendingScheduleDeletionCleanupForSession(sessionId);
      if (scheduleDeletion !== undefined) throw new OperationInProgressError(scheduleDeletion.operationId);
      const deleteNativeSession = input.disposition === "delete" && (input.deleteNativeSession ?? false);
      const deleteArtifacts = input.disposition === "delete" && (input.deleteArtifacts ?? false);
      const releaseWorktree = input.releaseWorktree ?? false;
      const cleanupGitSafety = input.disposition === "delete" && (input.cleanupGitSafety ?? false);
      this.database.prepare(`
        INSERT INTO session_lifecycle_cleanups(
          operation_id, session_id, disposition, state,
          delete_native, delete_artifacts, release_worktree, cleanup_git_safety,
          close_completed, native_completed, worktree_completed, git_safety_completed,
          failure_json, created_at, updated_at, revision
        ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, 0, ?, ?, ?, NULL, ?, ?, ?)
      `).run(
        operationId,
        sessionId,
        input.disposition,
        deleteNativeSession ? 1 : 0,
        deleteArtifacts ? 1 : 0,
        releaseWorktree ? 1 : 0,
        cleanupGitSafety ? 1 : 0,
        deleteNativeSession ? 0 : 1,
        releaseWorktree ? 0 : 1,
        cleanupGitSafety ? 0 : 1,
        at,
        at,
        asSqlInteger(this.requireActiveRevision())
      );
      this.terminalizeSessionWork(sessionId, `session-lifecycle:${operationId}`, at);
      return this.getSessionLifecycleCleanup(operationId);
    });
  }

  findSessionLifecycleCleanup(operationId: string): SessionLifecycleCleanupRecord | undefined {
    this.assertOpen();
    const row = this.database.prepare("SELECT * FROM session_lifecycle_cleanups WHERE operation_id = ?")
      .get(nonBlank(operationId, "Session lifecycle operation ID")) as Row | undefined;
    return row === undefined ? undefined : sessionLifecycleCleanupFromRow(row);
  }

  getSessionLifecycleCleanup(operationId: string): SessionLifecycleCleanupRecord {
    const record = this.findSessionLifecycleCleanup(operationId);
    if (record === undefined) throw new NotFoundError("Session lifecycle cleanup", operationId);
    return record;
  }

  findPendingSessionLifecycleCleanup(sessionId: string): SessionLifecycleCleanupRecord | undefined {
    this.assertOpen();
    const row = this.database.prepare(`
      SELECT * FROM session_lifecycle_cleanups
      WHERE session_id = ? AND state = 'pending'
    `).get(nonBlank(sessionId, "Session ID")) as Row | undefined;
    return row === undefined ? undefined : sessionLifecycleCleanupFromRow(row);
  }

  listPendingSessionLifecycleCleanups(): SessionLifecycleCleanupRecord[] {
    this.assertOpen();
    return (this.database.prepare(`
      SELECT * FROM session_lifecycle_cleanups
      WHERE state = 'pending' ORDER BY created_at, operation_id
    `).all() as Row[]).map(sessionLifecycleCleanupFromRow);
  }

  advanceSessionLifecycleCleanup(input: {
    readonly operationId: string;
    readonly phase: SessionLifecycleCleanupPhase;
    readonly at?: number;
  }): SessionLifecycleCleanupRecord {
    const operationId = nonBlank(input.operationId, "Session lifecycle operation ID");
    const at = input.at ?? this.now();
    if (!Number.isSafeInteger(at) || at < 0) throw new StoreError("Session lifecycle time is invalid.");
    const column = input.phase === "close"
      ? "close_completed"
      : input.phase === "native"
        ? "native_completed"
        : input.phase === "worktree"
          ? "worktree_completed"
          : "git_safety_completed";
    return this.write(() => {
      const current = this.getSessionLifecycleCleanup(operationId);
      if (current.state === "completed") return current;
      this.database.prepare(`
        UPDATE session_lifecycle_cleanups
        SET ${column} = 1, failure_json = NULL, updated_at = ?, revision = ?
        WHERE operation_id = ? AND state = 'pending'
      `).run(at, asSqlInteger(this.requireActiveRevision()), operationId);
      return this.getSessionLifecycleCleanup(operationId);
    });
  }

  recordSessionLifecycleCleanupFailure(input: {
    readonly operationId: string;
    readonly message: string;
    readonly at?: number;
  }): SessionLifecycleCleanupRecord {
    const operationId = nonBlank(input.operationId, "Session lifecycle operation ID");
    const message = nonBlank(input.message, "Session lifecycle cleanup failure").slice(0, 512);
    const at = input.at ?? this.now();
    if (!Number.isSafeInteger(at) || at < 0) throw new StoreError("Session lifecycle time is invalid.");
    return this.write(() => {
      const current = this.getSessionLifecycleCleanup(operationId);
      if (current.state === "completed") return current;
      this.database.prepare(`
        UPDATE session_lifecycle_cleanups
        SET failure_json = ?, updated_at = ?, revision = ?
        WHERE operation_id = ? AND state = 'pending'
      `).run(serializeJson({ message }), at, asSqlInteger(this.requireActiveRevision()), operationId);
      return this.getSessionLifecycleCleanup(operationId);
    });
  }

  finalizeSessionLifecycleCleanup(input: {
    readonly operationId: string;
    readonly recoveredOperationResponse?: unknown;
    readonly at?: number;
  }): SessionLifecycleCleanupRecord {
    const operationId = nonBlank(input.operationId, "Session lifecycle operation ID");
    const at = input.at ?? this.now();
    if (!Number.isSafeInteger(at) || at < 0) throw new StoreError("Session lifecycle time is invalid.");
    return this.write(() => {
      const cleanup = this.getSessionLifecycleCleanup(operationId);
      if (cleanup.state === "completed") return cleanup;
      if (
        !cleanup.closeCompleted
        || !cleanup.nativeCompleted
        || !cleanup.worktreeCompleted
        || !cleanup.gitSafetyCompleted
      ) throw new StoreError("Session lifecycle cleanup still has pending external effects.");
      const session = this.getSession(cleanup.sessionId);
      if (cleanup.disposition === "archive") {
        if (!session.descriptor.archived) {
          this.updateSession(cleanup.sessionId, { archived: true }, session.revision, at);
        }
      } else if (session.descriptor.deletedAt === undefined) {
        this.updateSession(cleanup.sessionId, { archived: true, deletedAt: at }, session.revision, at);
        if (cleanup.deleteArtifacts) {
          for (;;) {
            const artifacts = this.listArtifacts({ sessionId: cleanup.sessionId, limit: 100 });
            for (const artifact of artifacts) this.deleteArtifact(artifact.blob.id);
            if (artifacts.length < 100) break;
          }
        }
      }
      this.database.prepare(`
        UPDATE session_lifecycle_cleanups
        SET state = 'completed', failure_json = NULL, updated_at = ?, revision = ?
        WHERE operation_id = ? AND state = 'pending'
      `).run(at, asSqlInteger(this.requireActiveRevision()), operationId);
      if (input.recoveredOperationResponse !== undefined) {
        const operation = this.getOperation(operationId);
        if (
          operation.connectionId === undefined
          || operation.completionMode !== "external_effect"
          || operation.kind !== (cleanup.disposition === "archive" ? "archiveSession" : "deleteSession")
        ) throw new StoreError("Recovered Session lifecycle cleanup does not own a compatible client operation.");
        if (operation.status === "started" || operation.status === "failed") {
          const completed = this.database.prepare(`
            UPDATE operations
            SET status = 'completed', response_json = ?, error_json = NULL,
                updated_at = ?, revision = ?
            WHERE id = ? AND status IN ('started', 'failed') AND completion_mode = 'external_effect'
          `).run(
            serializeJson(input.recoveredOperationResponse),
            at,
            asSqlInteger(this.requireActiveRevision()),
            operationId
          );
          if (completed.changes !== 1) throw new OperationInProgressError(operationId);
          this.currentFrame().operationChanges.push(operationId);
        }
      }
      return this.getSessionLifecycleCleanup(operationId);
    });
  }

  prepareScheduleDeletionCleanup(input: {
    readonly operationId: string;
    readonly scheduleId: string;
    readonly disposition: ScheduleDeletionDisposition;
    readonly projectTargetId?: string;
    readonly projectConfigId?: string;
    readonly occurrenceRunIds?: readonly string[];
    readonly at?: number;
  }): ScheduleDeletionCleanupRecord {
    const operationId = nonBlank(input.operationId, "Schedule deletion operation ID");
    const scheduleId = nonBlank(input.scheduleId, "Schedule ID");
    if (!(["keep", "archive", "delete"] as const).includes(input.disposition)) {
      throw new StoreError("Schedule deletion disposition is invalid.");
    }
    if ((input.projectTargetId === undefined) !== (input.projectConfigId === undefined)) {
      throw new StoreError("Schedule deletion project origin is incomplete.");
    }
    const existing = this.findScheduleDeletionCleanup(operationId);
    if (existing !== undefined) {
      if (
        existing.scheduleId !== scheduleId
        || existing.disposition !== input.disposition
        || existing.projectTargetId !== input.projectTargetId
        || existing.projectConfigId !== input.projectConfigId
      ) throw new StoreError("Schedule deletion cleanup already exists with different durable inputs.");
      return existing;
    }
    return this.write(() => {
      const currentExisting = this.findScheduleDeletionCleanup(operationId);
      if (currentExisting !== undefined) return currentExisting;
      const conflicting = this.database.prepare(`
        SELECT operation_id FROM schedule_deletion_cleanups
        WHERE schedule_id = ? AND state = 'pending' LIMIT 1
      `).get(scheduleId) as Row | undefined;
      if (conflicting !== undefined) {
        throw new StoreError(`Schedule deletion ${stringValue(conflicting["operation_id"])} is already in progress.`);
      }
      const schedule = this.getSchedule(scheduleId);
      const generatedSessionIds = (this.database.prepare(`
        SELECT session.id AS id
        FROM product_sessions AS session
        WHERE session.deleted_at IS NULL
          AND session.automation_schedule_id = ?
        ORDER BY session.id
      `).all(scheduleId) as Row[])
        .map((row) => stringValue(row["id"]));
      if (input.disposition !== "keep") {
        for (const sessionId of generatedSessionIds) {
          const lifecycle = this.findPendingSessionLifecycleCleanup(sessionId);
          if (lifecycle !== undefined) throw new OperationInProgressError(lifecycle.operationId);
        }
      }
      const activeOccurrenceRunIds = this.listScheduleRuntimeOccurrences({ scheduleId, limit: 10_000 })
        .map((occurrence) => occurrence.runId);
      const occurrenceRunIds = [...new Set([
        ...(input.occurrenceRunIds ?? []),
        ...activeOccurrenceRunIds
      ].map((runId) => nonBlank(runId, "Schedule deletion occurrence run ID")))].sort();
      const at = input.at ?? this.now();
      if (!Number.isSafeInteger(at) || at < 0) throw new StoreError("Schedule deletion time is invalid.");
      this.database.prepare(`
        INSERT INTO schedule_deletion_cleanups(
          operation_id, schedule_id, disposition, state,
          generated_session_ids_json, occurrence_run_ids_json, inflight_count,
          completed_session_ids_json, failures_json, project_target_id, project_config_id,
          created_at, updated_at, revision
        ) VALUES (?, ?, ?, 'pending', ?, ?, ?, '[]', '[]', ?, ?, ?, ?, ?)
      `).run(
        operationId,
        scheduleId,
        input.disposition,
        serializeJson(generatedSessionIds),
        serializeJson(occurrenceRunIds),
        occurrenceRunIds.length,
        input.projectTargetId ?? null,
        input.projectConfigId ?? null,
        at,
        at,
        asSqlInteger(this.requireActiveRevision())
      );
      if (input.disposition !== "keep") {
        for (const sessionId of generatedSessionIds) {
          this.terminalizeSessionWork(sessionId, `schedule-deletion:${operationId}`, at);
        }
      }
      if (schedule.enabled) {
        this.database.prepare(`
          UPDATE schedules SET enabled = 0, updated_at = ?, revision = ? WHERE id = ?
        `).run(at, asSqlInteger(this.requireActiveRevision()), scheduleId);
      }
      return this.getScheduleDeletionCleanup(operationId);
    });
  }

  /** Re-snapshots authoritative generated-task ownership only after the
   * scheduler deletion fence has drained every pre-existing occurrence. */
  refreshScheduleDeletionCleanup(input: {
    readonly operationId: string;
    readonly occurrenceRunIds?: readonly string[];
    readonly at?: number;
  }): ScheduleDeletionCleanupRecord {
    const operationId = nonBlank(input.operationId, "Schedule deletion operation ID");
    return this.write(() => {
      const manifest = this.getScheduleDeletionCleanup(operationId);
      if (manifest.state === "completed") return manifest;
      const generatedSessionIds = [...new Set([
        ...manifest.generatedSessionIds,
        ...(this.database.prepare(`
          SELECT session.id AS id
          FROM product_sessions AS session
          WHERE session.deleted_at IS NULL
            AND session.automation_schedule_id = ?
          ORDER BY session.id
        `).all(manifest.scheduleId) as Row[]).map((row) => stringValue(row["id"]))
      ])].sort();
      if (manifest.disposition !== "keep") {
        for (const sessionId of generatedSessionIds) {
          const lifecycle = this.findPendingSessionLifecycleCleanup(sessionId);
          if (lifecycle !== undefined) throw new OperationInProgressError(lifecycle.operationId);
        }
      }
      const activeOccurrenceRunIds = this.listScheduleRuntimeOccurrences({
        scheduleId: manifest.scheduleId,
        limit: 10_000
      }).map((occurrence) => occurrence.runId);
      const occurrenceRunIds = [...new Set([
        ...manifest.occurrenceRunIds,
        ...(input.occurrenceRunIds ?? []),
        ...activeOccurrenceRunIds
      ].map((runId) => nonBlank(runId, "Schedule deletion occurrence run ID")))].sort();
      const at = input.at ?? this.now();
      if (!Number.isSafeInteger(at) || at < 0) throw new StoreError("Schedule deletion time is invalid.");
      if (manifest.disposition !== "keep") {
        for (const sessionId of generatedSessionIds) {
          this.terminalizeSessionWork(sessionId, `schedule-deletion:${operationId}`, at);
        }
      }
      this.database.prepare(`
        UPDATE schedule_deletion_cleanups
        SET generated_session_ids_json = ?, occurrence_run_ids_json = ?,
            inflight_count = ?, updated_at = ?, revision = ?
        WHERE operation_id = ? AND state = 'pending'
      `).run(
        serializeJson(generatedSessionIds),
        serializeJson(occurrenceRunIds),
        occurrenceRunIds.length,
        at,
        asSqlInteger(this.requireActiveRevision()),
        operationId
      );
      return this.getScheduleDeletionCleanup(operationId);
    });
  }

  findScheduleDeletionCleanup(operationId: string): ScheduleDeletionCleanupRecord | undefined {
    this.assertOpen();
    const row = this.database.prepare(
      "SELECT * FROM schedule_deletion_cleanups WHERE operation_id = ?"
    ).get(nonBlank(operationId, "Schedule deletion operation ID")) as Row | undefined;
    return row === undefined ? undefined : scheduleDeletionCleanupFromRow(row);
  }

  getScheduleDeletionCleanup(operationId: string): ScheduleDeletionCleanupRecord {
    const record = this.findScheduleDeletionCleanup(operationId);
    if (record === undefined) throw new NotFoundError("Schedule deletion cleanup", operationId);
    return record;
  }

  listPendingScheduleDeletionCleanups(): ScheduleDeletionCleanupRecord[] {
    this.assertOpen();
    return (this.database.prepare(`
      SELECT * FROM schedule_deletion_cleanups WHERE state = 'pending' ORDER BY created_at, operation_id
    `).all() as Row[]).map(scheduleDeletionCleanupFromRow);
  }

  findPendingScheduleDeletionCleanupForSchedule(scheduleId: string): ScheduleDeletionCleanupRecord | undefined {
    this.assertOpen();
    const row = this.database.prepare(`
      SELECT * FROM schedule_deletion_cleanups
      WHERE schedule_id = ? AND state = 'pending'
      ORDER BY created_at, operation_id LIMIT 1
    `).get(nonBlank(scheduleId, "Schedule ID")) as Row | undefined;
    return row === undefined ? undefined : scheduleDeletionCleanupFromRow(row);
  }

  findPendingScheduleDeletionCleanupForSession(sessionId: string): ScheduleDeletionCleanupRecord | undefined {
    this.assertOpen();
    const row = this.database.prepare(`
      SELECT cleanup.*
      FROM schedule_deletion_cleanups cleanup,
           json_each(cleanup.generated_session_ids_json) owned
      WHERE cleanup.state = 'pending' AND cleanup.disposition <> 'keep' AND owned.value = ?
      ORDER BY cleanup.created_at, cleanup.operation_id LIMIT 1
    `).get(nonBlank(sessionId, "Session ID")) as Row | undefined;
    return row === undefined ? undefined : scheduleDeletionCleanupFromRow(row);
  }

  finalizeScheduleDeletionCleanup(input: {
    readonly operationId: string;
    readonly completedSessionIds: readonly string[];
    readonly failures: readonly ScheduleDeletionCleanupFailure[];
    /** Typed response for a claimed deletion effect recovered from its manifest. */
    readonly recoveredOperationResponse?: unknown;
    readonly at?: number;
  }): ScheduleDeletionCleanupRecord {
    const operationId = nonBlank(input.operationId, "Schedule deletion operation ID");
    const at = input.at ?? this.now();
    if (!Number.isSafeInteger(at) || at < 0) throw new StoreError("Schedule deletion time is invalid.");
    return this.write(() => {
      const manifest = this.getScheduleDeletionCleanup(operationId);
      if (manifest.state === "completed") return manifest;
      const generated = new Set(manifest.generatedSessionIds);
      const completed = new Set(manifest.completedSessionIds);
      for (const sessionId of input.completedSessionIds) {
        if (!generated.has(sessionId)) throw new StoreError("Schedule deletion cleanup Session is not in its manifest.");
        const session = this.listSessions({ includeArchived: true, includeDeleted: true })
          .find((candidate) => candidate.descriptor.id === sessionId);
        if (session !== undefined) {
          this.terminalizeSessionWork(sessionId, `schedule-deletion:${operationId}`, at);
          if (manifest.disposition === "archive" && !session.descriptor.archived) {
            this.updateSession(sessionId, { archived: true }, session.revision, at);
          } else if (manifest.disposition === "delete" && session.descriptor.deletedAt === undefined) {
            this.updateSession(sessionId, { archived: true, deletedAt: at }, session.revision, at);
            for (;;) {
              const artifacts = this.listArtifacts({ sessionId, limit: 100 });
              for (const artifact of artifacts) this.deleteArtifact(artifact.blob.id);
              if (artifacts.length < 100) break;
            }
          }
        }
        completed.add(sessionId);
      }
      const failures = input.failures.map((failure) => ({
        sessionId: nonBlank(failure.sessionId, "Schedule deletion failure Session ID"),
        message: nonBlank(failure.message, "Schedule deletion failure message").slice(0, 512)
      }));
      for (const failure of failures) {
        if (!generated.has(failure.sessionId)) throw new StoreError("Schedule deletion failure Session is not in its manifest.");
      }
      const complete = manifest.disposition === "keep" || completed.size === generated.size;
      if (complete) {
        const schedule = this.findSchedule(manifest.scheduleId);
        if (schedule !== undefined) this.deleteSchedule(schedule.id, schedule.revision, operationId);
      }
      this.database.prepare(`
        UPDATE schedule_deletion_cleanups
        SET state = ?, completed_session_ids_json = ?, failures_json = ?, updated_at = ?, revision = ?
        WHERE operation_id = ?
      `).run(
        complete ? "completed" : "pending",
        serializeJson([...completed].sort()),
        serializeJson(failures),
        at,
        asSqlInteger(this.requireActiveRevision()),
        operationId
      );
      if (input.recoveredOperationResponse !== undefined) {
        if (!complete) {
          throw new StoreError("A pending Schedule deletion cannot complete its client operation.");
        }
        const operation = this.getOperation(operationId);
        if (
          operation.kind !== "deleteSchedule"
          || operation.connectionId === undefined
          || operation.completionMode !== "external_effect"
        ) {
          throw new StoreError("Recovered Schedule deletion does not own a compatible client operation.");
        }
        if (operation.status === "started" || operation.status === "failed") {
          const completedOperation = this.database.prepare(`
            UPDATE operations
            SET status = 'completed', response_json = ?, error_json = NULL,
                updated_at = ?, revision = ?
            WHERE id = ? AND status IN ('started', 'failed') AND completion_mode = 'external_effect'
          `).run(
            serializeJson(input.recoveredOperationResponse),
            at,
            asSqlInteger(this.requireActiveRevision()),
            operationId
          );
          if (completedOperation.changes !== 1) throw new OperationInProgressError(operationId);
          this.currentFrame().operationChanges.push(operationId);
        }
      }
      return this.getScheduleDeletionCleanup(operationId);
    });
  }

  private assertSessionNotPendingScheduleDeletion(sessionId: string): void {
    const session = this.getSession(sessionId);
    if (session.descriptor.deletedAt !== undefined || session.descriptor.archived) {
      throw new StoreError("Archived or deleted tasks cannot accept new runs.");
    }
    const pending = this.findPendingScheduleDeletionCleanupForSession(sessionId);
    if (pending !== undefined) {
      throw new StoreError("The task is fenced while its Schedule deletion is in progress.");
    }
    if (this.findPendingSessionLifecycleCleanup(sessionId) !== undefined) {
      throw new StoreError("The task is fenced while its lifecycle transition is in progress.");
    }
  }

  /**
   * Fail-closed durable quiescence for an ordinary task deletion. The caller
   * must already own the SessionHost admission fence so no new work can land
   * between this transaction and native runtime close.
   */
  terminalizeSessionLifecycleWork(input: {
    readonly sessionId: string;
    readonly operationId: string;
    readonly at?: number;
  }): void {
    const sessionId = nonBlank(input.sessionId, "Session ID");
    const operationId = nonBlank(input.operationId, "Session lifecycle operation ID");
    const at = input.at ?? this.now();
    if (!Number.isSafeInteger(at) || at < 0) throw new StoreError("Session lifecycle time is invalid.");
    this.write(() => {
      this.getSession(sessionId);
      this.terminalizeSessionWork(sessionId, `session-lifecycle:${operationId}`, at);
    });
  }

  private terminalizeSessionWork(sessionId: string, traceScope: string, at: number): void {
    for (;;) {
      const pending = this.listQueueItems({
        sessionId,
        states: ["accepted", "dispatching", "backend_accepted", "dispatch_unknown"],
        limit: 100
      });
      if (pending.length === 0) break;
      for (const item of pending) {
        this.cancelQueueItem({
          queueItemId: item.id,
          traceId: `${traceScope}:cancelled`,
          at
        });
      }
    }
    const activeRunRows = this.database.prepare(`
      SELECT id FROM runs
      WHERE session_id = ? AND state IN ('queued', 'running', 'waiting', 'retrying', 'dispatch_unknown')
      ORDER BY created_at, id
    `).all(sessionId) as Row[];
    for (const row of activeRunRows) {
      const runId = stringValue(row["id"]);
      this.updateRunState({
        runId,
        state: "aborted",
        endedAt: at,
        traceId: `${traceScope}:aborted`
      });
    }
  }

  markScheduleRunRead(scheduleId: string, id: bigint, readAt = this.now()): ScheduleRunRecord {
    const expectedScheduleId = nonBlank(scheduleId, "Schedule ID");
    const current = this.getScheduleRun(id);
    if (current.scheduleId !== expectedScheduleId) throw new NotFoundError("Schedule run", id.toString());
    if (!unreadScheduleHistoryStatus(current.status)) {
      throw new StoreError("This Schedule run is not an unread terminal history item.");
    }
    if (current.readAt !== undefined) return current;
    if (!Number.isSafeInteger(readAt) || readAt < 0) throw new StoreError("Schedule run read time is invalid.");
    return this.write(() => {
      const latest = this.getScheduleRun(id);
      if (latest.scheduleId !== expectedScheduleId) throw new NotFoundError("Schedule run", id.toString());
      if (latest.readAt !== undefined) return latest;
      this.database.prepare(`
        UPDATE schedule_run_history SET detail_json = ?, revision = ? WHERE id = ?
      `).run(
        serializeJson(scheduleRunDetailWithReadAt(latest.detail, readAt)),
        asSqlInteger(this.requireActiveRevision()),
        asSqlInteger(id)
      );
      return this.getScheduleRun(id);
    });
  }

  markScheduleRunsRead(scheduleId: string, readAt = this.now()): number {
    const expectedScheduleId = nonBlank(scheduleId, "Schedule ID");
    if (!Number.isSafeInteger(readAt) || readAt < 0) throw new StoreError("Schedule run read time is invalid.");
    return this.write(() => {
      const records = (this.database.prepare(`
        SELECT * FROM schedule_run_history
        WHERE schedule_id = ? AND lower(status) IN ('success', 'succeeded', 'completed', 'aborted', 'interrupted', 'cancelled', 'failed')
        ORDER BY id ASC
      `).all(expectedScheduleId) as Row[]).map(scheduleRunFromRow).filter((record) => record.readAt === undefined);
      const update = this.database.prepare(`
        UPDATE schedule_run_history SET detail_json = ?, revision = ? WHERE id = ?
      `);
      for (const record of records) {
        update.run(
          serializeJson(scheduleRunDetailWithReadAt(record.detail, readAt)),
          asSqlInteger(this.requireActiveRevision()),
          asSqlInteger(record.id)
        );
      }
      return records.length;
    });
  }

  markAllScheduleRunsRead(readAt = this.now()): number {
    if (!Number.isSafeInteger(readAt) || readAt < 0) throw new StoreError("Schedule run read time is invalid.");
    return this.write(() => {
      const records = (this.database.prepare(`
        SELECT * FROM schedule_run_history
        WHERE lower(status) IN ('success', 'succeeded', 'completed', 'aborted', 'interrupted', 'cancelled', 'failed')
        ORDER BY id ASC
      `).all() as Row[]).map(scheduleRunFromRow).filter((record) => record.readAt === undefined);
      const update = this.database.prepare(`
        UPDATE schedule_run_history SET detail_json = ?, revision = ? WHERE id = ?
      `);
      for (const record of records) {
        update.run(
          serializeJson(scheduleRunDetailWithReadAt(record.detail, readAt)),
          asSqlInteger(this.requireActiveRevision()),
          asSqlInteger(record.id)
        );
      }
      return records.length;
    });
  }

  deleteScheduleRun(scheduleId: string, id: bigint): ScheduleRunRecord {
    const expectedScheduleId = nonBlank(scheduleId, "Schedule ID");
    return this.write(() => {
      const current = this.getScheduleRun(id);
      if (current.scheduleId !== expectedScheduleId) throw new NotFoundError("Schedule run", id.toString());
      if (!terminalScheduleHistoryStatus(current.status)) {
        throw new StoreError("Only a terminal Schedule run can be deleted.");
      }
      this.database.prepare("DELETE FROM schedule_run_history WHERE id = ?").run(asSqlInteger(id));
      return current;
    });
  }

  listScheduleRuns(scheduleId: string, limit = 100, offset = 0): ScheduleRunRecord[] {
    this.assertOpen();
    return (this.database.prepare(`
      SELECT * FROM schedule_run_history
      WHERE schedule_id = ? ORDER BY fired_at DESC, id DESC LIMIT ? OFFSET ?
    `).all(scheduleId, normalizeLimit(limit, 100), normalizeOffset(offset)) as Row[]).map(scheduleRunFromRow);
  }

  countScheduleRuns(scheduleId: string): number {
    this.assertOpen();
    const row = this.database.prepare(
      "SELECT COUNT(*) AS count FROM schedule_run_history WHERE schedule_id = ?"
    ).get(nonBlank(scheduleId, "Schedule ID")) as Row;
    return numberValue(row["count"]);
  }

  countUnreadScheduleRuns(scheduleId: string): number {
    this.assertOpen();
    const row = this.database.prepare(`
      SELECT COUNT(*) AS count FROM schedule_run_history
      WHERE schedule_id = ?
        AND lower(status) IN ('success', 'succeeded', 'completed', 'aborted', 'interrupted', 'cancelled', 'failed')
        AND json_extract(detail_json, '$.readAt') IS NULL
    `).get(nonBlank(scheduleId, "Schedule ID")) as Row;
    return numberValue(row["count"]);
  }

  findScheduleRunByRunId(runId: string): ScheduleRunRecord | undefined {
    this.assertOpen();
    const row = this.database.prepare(
      "SELECT * FROM schedule_run_history WHERE run_id = ?"
    ).get(nonBlank(runId, "Schedule occurrence run ID")) as Row | undefined;
    return row === undefined ? undefined : scheduleRunFromRow(row);
  }

  /**
   * Adds one already de-duplicated usage-ledger delta to a Schedule occurrence.
   * The caller must use the delta returned by recordUsageObservation rather
   * than a cumulative Session total. That keeps persistent tasks, retries, and
   * replayed Backend usage events from charging an occurrence more than once.
   */
  recordScheduleRunUsage(input: {
    readonly runId: string;
    readonly actualCostMicros: number;
    readonly estimatedValueMicros: number;
    readonly currencyCode: string;
    readonly approximate: boolean;
    readonly attribution: "exact" | "direct";
    readonly costComplete: boolean;
    readonly estimateReasons?: readonly string[];
  }): ScheduleRunRecord | undefined {
    const runId = nonBlank(input.runId, "Schedule occurrence run ID");
    const actualCostMicros = scheduleRunMoneyMicros(input.actualCostMicros, "Schedule actual cost");
    const estimatedValueMicros = scheduleRunMoneyMicros(input.estimatedValueMicros, "Schedule estimated value");
    const currencyCode = scheduleRunMoneyCurrency(input.currencyCode);
    const estimateReasons = [...new Set((input.estimateReasons ?? []).map((reason) =>
      nonBlank(reason, "Schedule value estimate reason").slice(0, 128)
    ))].slice(0, 32);
    const current = this.findScheduleRunByRunId(runId);
    if (current === undefined) return undefined;
    return this.write(() => {
      const latest = this.findScheduleRunByRunId(runId);
      if (latest === undefined) return undefined;
      const detail = isRecord(latest.detail) ? { ...latest.detail } : {};
      const currentCost = scheduleRunMoneyDetail(detail["costMoney"], "actual-cost");
      const currentValue = scheduleRunMoneyDetail(detail["estimatedValueMoney"], "value-estimate");
      const existingCurrency = currentCost?.currency ?? currentValue?.currency;
      const hasMoneyDelta = actualCostMicros > 0 || estimatedValueMicros > 0;
      // A history row is deliberately a single-currency snapshot. A conflicting
      // segment is ignored atomically instead of relabelling an existing amount.
      if (hasMoneyDelta && existingCurrency !== undefined && existingCurrency !== currencyCode) return latest;

      if (actualCostMicros > 0) {
        const total = scheduleRunMoneyMicros((currentCost?.amountMicros ?? 0) + actualCostMicros, "Schedule actual cost total");
        detail["costMoney"] = {
          amount: total / 1_000_000,
          currency: currencyCode,
          approximate: (currentCost?.approximate ?? false) || input.approximate,
          kind: "actual-cost",
          estimateReasons: [...new Set([...(currentCost?.estimateReasons ?? []), ...estimateReasons])].slice(0, 32)
        };
      }
      if (estimatedValueMicros > 0) {
        const total = scheduleRunMoneyMicros((currentValue?.amountMicros ?? 0) + estimatedValueMicros, "Schedule estimated value total");
        detail["estimatedValueMoney"] = {
          amount: total / 1_000_000,
          currency: currencyCode,
          approximate: true,
          kind: "value-estimate",
          estimateReasons: [...new Set([...(currentValue?.estimateReasons ?? []), ...estimateReasons])].slice(0, 32)
        };
      }

      const existingAttribution = scheduleRunCostAttributionDetail(detail["costAttribution"]);
      if (hasMoneyDelta) {
        detail["costAttribution"] = mergeScheduleRunCostAttribution(existingAttribution, input.attribution);
      } else if (currentCost === undefined && currentValue === undefined) {
        detail["costAttribution"] = input.costComplete ? "zero" : "unavailable";
      }
      this.database.prepare(`
        UPDATE schedule_run_history SET detail_json = ?, revision = ? WHERE id = ?
      `).run(
        serializeJson(detail),
        asSqlInteger(this.requireActiveRevision()),
        asSqlInteger(latest.id)
      );
      return this.getScheduleRun(latest.id);
    });
  }

  /** Records whether the terminal direct observation itself was available. */
  finalizeScheduleRunUsage(runId: string, observed: boolean): ScheduleRunRecord | undefined {
    const current = this.findScheduleRunByRunId(runId);
    if (current === undefined) return undefined;
    const detail = isRecord(current.detail) ? current.detail : {};
    if (
      scheduleRunMoneyDetail(detail["costMoney"], "actual-cost") !== undefined
      || scheduleRunMoneyDetail(detail["estimatedValueMoney"], "value-estimate") !== undefined
      || scheduleRunCostAttributionDetail(detail["costAttribution"]) !== undefined
    ) return current;
    return this.recordScheduleRunUsage({
      runId,
      actualCostMicros: 0,
      estimatedValueMicros: 0,
      currencyCode: "USD",
      approximate: false,
      attribution: "direct",
      costComplete: observed
    });
  }

  claimSchedulerRuntimeOwner(input: {
    readonly ownerId: string;
    readonly startedAt?: number;
    readonly leaseExpiresAt: number;
  }): SchedulerRuntimeOwnerRecord {
    const ownerId = boundedSchedulerRuntimeId(input.ownerId, "Scheduler runtime owner ID");
    const startedAt = schedulerRuntimeTimestamp(input.startedAt ?? this.now(), "Scheduler runtime start");
    const leaseExpiresAt = schedulerRuntimeTimestamp(input.leaseExpiresAt, "Scheduler runtime lease expiry");
    if (leaseExpiresAt <= startedAt) throw new StoreError("Scheduler runtime lease must expire in the future.");
    return this.schedulerRuntimeWrite(() => {
      const currentRow = this.database.prepare(
        "SELECT * FROM scheduler_runtime_owner WHERE singleton = 1"
      ).get() as Row | undefined;
      const generation = currentRow === undefined
        ? 1
        : checkedSchedulerGeneration(numberValue(currentRow["generation"]) + 1);
      const revision = currentRow === undefined ? 1n : toBigInt(currentRow["revision"]) + 1n;
      this.database.prepare(`
        INSERT INTO scheduler_runtime_owner(
          singleton, owner_id, generation, started_at, heartbeat_at,
          lease_expires_at, updated_at, revision
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET
          owner_id = excluded.owner_id,
          generation = excluded.generation,
          started_at = excluded.started_at,
          heartbeat_at = excluded.heartbeat_at,
          lease_expires_at = excluded.lease_expires_at,
          updated_at = excluded.updated_at,
          revision = excluded.revision
      `).run(
        ownerId,
        generation,
        startedAt,
        startedAt,
        leaseExpiresAt,
        startedAt,
        asSqlInteger(revision)
      );
      return this.getSchedulerRuntimeOwner()!;
    });
  }

  getSchedulerRuntimeOwner(): SchedulerRuntimeOwnerRecord | undefined {
    this.assertOpen();
    const row = this.database.prepare(
      "SELECT * FROM scheduler_runtime_owner WHERE singleton = 1"
    ).get() as Row | undefined;
    return row === undefined ? undefined : schedulerRuntimeOwnerFromRow(row);
  }

  touchSchedulerRuntimeOwner(input: {
    readonly ownerId: string;
    readonly generation: number;
    readonly heartbeatAt?: number;
    readonly leaseExpiresAt: number;
  }): boolean {
    const ownerId = boundedSchedulerRuntimeId(input.ownerId, "Scheduler runtime owner ID");
    const generation = checkedSchedulerGeneration(input.generation);
    const heartbeatAt = schedulerRuntimeTimestamp(input.heartbeatAt ?? this.now(), "Scheduler runtime heartbeat");
    const leaseExpiresAt = schedulerRuntimeTimestamp(input.leaseExpiresAt, "Scheduler runtime lease expiry");
    if (leaseExpiresAt <= heartbeatAt) throw new StoreError("Scheduler runtime lease must expire after its heartbeat.");
    return this.schedulerRuntimeWrite(() => {
      const result = this.database.prepare(`
        UPDATE scheduler_runtime_owner
        SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?, revision = revision + 1
        WHERE singleton = 1 AND owner_id = ? AND generation = ? AND heartbeat_at <= ?
      `).run(heartbeatAt, leaseExpiresAt, heartbeatAt, ownerId, generation, heartbeatAt);
      return Number(result.changes) === 1;
    });
  }

  beginScheduleRuntimeOccurrence(input: {
    readonly runId: string;
    readonly scheduleId: string;
    readonly source: "automatic" | "run-now";
    readonly executionMode?: "agent" | "script";
    readonly phase?: ScheduleRuntimeOccurrencePhase;
    readonly ownerId: string;
    readonly ownerGeneration: number;
    readonly scheduledAt: number;
    readonly startedAt?: number;
    readonly leaseExpiresAt: number;
  }): ScheduleRuntimeOccurrenceRecord {
    const runId = boundedSchedulerRuntimeId(input.runId, "Schedule runtime run ID");
    const scheduleId = nonBlank(input.scheduleId, "Schedule runtime Schedule ID");
    const ownerId = boundedSchedulerRuntimeId(input.ownerId, "Schedule runtime owner ID");
    const ownerGeneration = checkedSchedulerGeneration(input.ownerGeneration);
    const scheduledAt = schedulerRuntimeTimestamp(input.scheduledAt, "Schedule runtime fire time");
    const startedAt = schedulerRuntimeTimestamp(input.startedAt ?? this.now(), "Schedule runtime start");
    const leaseExpiresAt = schedulerRuntimeTimestamp(input.leaseExpiresAt, "Schedule runtime lease expiry");
    if (leaseExpiresAt <= startedAt) throw new StoreError("Schedule runtime lease must expire in the future.");
    const phase = schedulerRuntimePhase(input.phase ?? "loading");
    return this.schedulerRuntimeWrite(() => {
      this.getSchedule(scheduleId);
      const owner = this.getSchedulerRuntimeOwner();
      if (owner?.ownerId !== ownerId || owner.generation !== ownerGeneration) {
        throw new StoreError("Schedule runtime owner was fenced by a newer generation.");
      }
      if (this.findScheduleRuntimeOccurrence(runId) !== undefined) {
        throw new StoreError(`Schedule runtime occurrence ${runId} is already leased.`);
      }
      this.database.prepare(`
        INSERT INTO schedule_runtime_occurrences(
          run_id, schedule_id, source, execution_mode, phase, owner_id,
          owner_generation, scheduled_at, started_at, heartbeat_at,
          last_progress_at, lease_expires_at, created_at, updated_at, revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `).run(
        runId,
        scheduleId,
        input.source,
        input.executionMode ?? null,
        phase,
        ownerId,
        ownerGeneration,
        scheduledAt,
        startedAt,
        startedAt,
        startedAt,
        leaseExpiresAt,
        startedAt,
        startedAt
      );
      return this.getScheduleRuntimeOccurrence(runId);
    });
  }

  findScheduleRuntimeOccurrence(runId: string): ScheduleRuntimeOccurrenceRecord | undefined {
    this.assertOpen();
    const row = this.database.prepare(
      "SELECT * FROM schedule_runtime_occurrences WHERE run_id = ?"
    ).get(nonBlank(runId, "Schedule runtime run ID")) as Row | undefined;
    return row === undefined ? undefined : scheduleRuntimeOccurrenceFromRow(row);
  }

  getScheduleRuntimeOccurrence(runId: string): ScheduleRuntimeOccurrenceRecord {
    const occurrence = this.findScheduleRuntimeOccurrence(runId);
    if (occurrence === undefined) throw new NotFoundError("Schedule runtime occurrence", runId);
    return occurrence;
  }

  listScheduleRuntimeOccurrences(options: {
    readonly scheduleId?: string;
    readonly staleAt?: number;
    readonly limit?: number;
  } = {}): ScheduleRuntimeOccurrenceRecord[] {
    this.assertOpen();
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (options.scheduleId !== undefined) {
      clauses.push("schedule_id = ?");
      params.push(nonBlank(options.scheduleId, "Schedule runtime Schedule ID"));
    }
    if (options.staleAt !== undefined) {
      clauses.push("lease_expires_at <= ?");
      params.push(schedulerRuntimeTimestamp(options.staleAt, "Schedule runtime stale cutoff"));
    }
    const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
    params.push(normalizeLimit(options.limit, 100));
    return (this.database.prepare(`
      SELECT * FROM schedule_runtime_occurrences ${where}
      ORDER BY lease_expires_at, run_id LIMIT ?
    `).all(...params) as Row[]).map(scheduleRuntimeOccurrenceFromRow);
  }

  touchScheduleRuntimeOccurrence(input: {
    readonly runId: string;
    readonly ownerId: string;
    readonly ownerGeneration: number;
    readonly heartbeatAt?: number;
    readonly leaseExpiresAt: number;
    readonly progressAt?: number;
    readonly phase?: Exclude<ScheduleRuntimeOccurrencePhase, "stalled" | "recovering">;
    readonly executionMode?: "agent" | "script";
  }): ScheduleRuntimeOccurrenceRecord | undefined {
    const heartbeatAt = schedulerRuntimeTimestamp(input.heartbeatAt ?? this.now(), "Schedule runtime heartbeat");
    const leaseExpiresAt = schedulerRuntimeTimestamp(input.leaseExpiresAt, "Schedule runtime lease expiry");
    if (leaseExpiresAt <= heartbeatAt) throw new StoreError("Schedule runtime lease must expire after its heartbeat.");
    const progressAt = input.progressAt === undefined
      ? undefined
      : schedulerRuntimeTimestamp(input.progressAt, "Schedule runtime progress");
    const requestedPhase = input.phase === undefined ? undefined : schedulerRuntimePhase(input.phase);
    return this.schedulerRuntimeWrite(() => {
      const current = this.findScheduleRuntimeOccurrence(input.runId);
      if (
        current === undefined ||
        current.ownerId !== input.ownerId ||
        current.ownerGeneration !== input.ownerGeneration ||
        heartbeatAt < current.heartbeatAt
      ) return undefined;
      const effectiveProgressAt = progressAt === undefined
        ? current.lastProgressAt
        : Math.max(current.lastProgressAt, progressAt);
      const effectiveHeartbeatAt = Math.max(heartbeatAt, effectiveProgressAt);
      if (leaseExpiresAt <= effectiveHeartbeatAt) {
        throw new StoreError("Schedule runtime lease must cover the reported progress.");
      }
      const progressed = effectiveProgressAt > current.lastProgressAt;
      const phase = current.phase === "recovering"
        ? "recovering"
        : current.phase === "stalled" && !progressed
          ? "stalled"
          : requestedPhase ?? (current.phase === "stalled" ? "running" : current.phase);
      const result = this.database.prepare(`
        UPDATE schedule_runtime_occurrences
        SET phase = ?, execution_mode = ?, heartbeat_at = ?, last_progress_at = ?, lease_expires_at = ?,
            stall_detected_at = ?, abort_requested_at = ?, updated_at = ?, revision = revision + 1
        WHERE run_id = ? AND owner_id = ? AND owner_generation = ? AND revision = ?
      `).run(
        phase,
        input.executionMode ?? current.executionMode ?? null,
        effectiveHeartbeatAt,
        effectiveProgressAt,
        leaseExpiresAt,
        progressed ? null : current.stallDetectedAt ?? null,
        progressed ? null : current.abortRequestedAt ?? null,
        effectiveHeartbeatAt,
        current.runId,
        current.ownerId,
        current.ownerGeneration,
        asSqlInteger(current.revision)
      );
      return Number(result.changes) === 1 ? this.getScheduleRuntimeOccurrence(current.runId) : undefined;
    });
  }

  shiftScheduleRuntimeOccurrenceClock(input: {
    readonly runId: string;
    readonly ownerId: string;
    readonly ownerGeneration: number;
    readonly gapMs: number;
    readonly heartbeatAt?: number;
    readonly leaseExpiresAt: number;
  }): ScheduleRuntimeOccurrenceRecord | undefined {
    const gapMs = schedulerRuntimeTimestamp(input.gapMs, "Schedule runtime suspension gap");
    if (gapMs === 0) return this.findScheduleRuntimeOccurrence(input.runId);
    const heartbeatAt = schedulerRuntimeTimestamp(input.heartbeatAt ?? this.now(), "Schedule runtime heartbeat");
    const leaseExpiresAt = schedulerRuntimeTimestamp(input.leaseExpiresAt, "Schedule runtime lease expiry");
    if (leaseExpiresAt <= heartbeatAt) throw new StoreError("Schedule runtime lease must expire after its heartbeat.");
    return this.schedulerRuntimeWrite(() => {
      const current = this.findScheduleRuntimeOccurrence(input.runId);
      if (
        current === undefined ||
        current.ownerId !== input.ownerId ||
        current.ownerGeneration !== input.ownerGeneration ||
        heartbeatAt < current.heartbeatAt
      ) return undefined;
      const startedAt = current.startedAt + gapMs;
      const lastProgressAt = current.lastProgressAt + gapMs;
      const stallDetectedAt = current.stallDetectedAt === undefined
        ? undefined
        : current.stallDetectedAt + gapMs;
      const abortRequestedAt = current.abortRequestedAt === undefined
        ? undefined
        : current.abortRequestedAt + gapMs;
      for (const [value, label] of [
        [startedAt, "Schedule runtime shifted start"],
        [lastProgressAt, "Schedule runtime shifted progress"],
        [stallDetectedAt, "Schedule runtime shifted stall"],
        [abortRequestedAt, "Schedule runtime shifted abort"]
      ] as const) {
        if (value !== undefined) schedulerRuntimeTimestamp(value, label);
      }
      if (lastProgressAt > heartbeatAt || startedAt > heartbeatAt) {
        throw new StoreError("Schedule runtime suspension shift exceeds the current heartbeat.");
      }
      const result = this.database.prepare(`
        UPDATE schedule_runtime_occurrences
        SET started_at = ?, heartbeat_at = ?, last_progress_at = ?, lease_expires_at = ?,
            stall_detected_at = ?, abort_requested_at = ?, updated_at = ?, revision = revision + 1
        WHERE run_id = ? AND owner_id = ? AND owner_generation = ? AND revision = ?
      `).run(
        startedAt,
        heartbeatAt,
        lastProgressAt,
        leaseExpiresAt,
        stallDetectedAt ?? null,
        abortRequestedAt ?? null,
        heartbeatAt,
        current.runId,
        current.ownerId,
        current.ownerGeneration,
        asSqlInteger(current.revision)
      );
      return Number(result.changes) === 1 ? this.getScheduleRuntimeOccurrence(current.runId) : undefined;
    });
  }

  markScheduleRuntimeOccurrenceStalled(input: {
    readonly runId: string;
    readonly ownerId: string;
    readonly ownerGeneration: number;
    readonly expectedLastProgressAt: number;
    readonly stalledAt?: number;
    readonly leaseExpiresAt: number;
  }): ScheduleRuntimeOccurrenceRecord | undefined {
    const stalledAt = schedulerRuntimeTimestamp(input.stalledAt ?? this.now(), "Schedule runtime stall time");
    const leaseExpiresAt = schedulerRuntimeTimestamp(input.leaseExpiresAt, "Schedule runtime lease expiry");
    if (leaseExpiresAt <= stalledAt) throw new StoreError("Stalled Schedule runtime lease must remain active during abort.");
    return this.schedulerRuntimeWrite(() => {
      const current = this.findScheduleRuntimeOccurrence(input.runId);
      if (
        current === undefined ||
        current.ownerId !== input.ownerId ||
        current.ownerGeneration !== input.ownerGeneration ||
        current.lastProgressAt !== input.expectedLastProgressAt ||
        current.phase === "queued" ||
        current.phase === "recovering" ||
        current.phase === "finalizing"
      ) return undefined;
      const heartbeatAt = Math.max(stalledAt, current.heartbeatAt);
      if (leaseExpiresAt <= heartbeatAt) throw new StoreError("Stalled Schedule runtime lease is too short.");
      const result = this.database.prepare(`
        UPDATE schedule_runtime_occurrences
        SET phase = 'stalled', heartbeat_at = ?, lease_expires_at = ?,
            stall_detected_at = ?, abort_requested_at = ?, updated_at = ?, revision = revision + 1
        WHERE run_id = ? AND owner_id = ? AND owner_generation = ?
          AND last_progress_at = ? AND revision = ?
      `).run(
        heartbeatAt,
        leaseExpiresAt,
        stalledAt,
        stalledAt,
        heartbeatAt,
        current.runId,
        current.ownerId,
        current.ownerGeneration,
        current.lastProgressAt,
        asSqlInteger(current.revision)
      );
      return Number(result.changes) === 1 ? this.getScheduleRuntimeOccurrence(current.runId) : undefined;
    });
  }

  claimStalledScheduleRuntimeOccurrence(input: {
    readonly runId: string;
    readonly expectedOwnerId: string;
    readonly expectedOwnerGeneration: number;
    readonly expectedLastProgressAt: number;
    readonly recoveryOwnerId: string;
    readonly recoveryGenerationFloor: number;
    readonly claimedAt?: number;
    readonly leaseExpiresAt: number;
  }): ScheduleRuntimeOccurrenceRecord | undefined {
    const claimedAt = schedulerRuntimeTimestamp(input.claimedAt ?? this.now(), "Schedule recovery claim time");
    const leaseExpiresAt = schedulerRuntimeTimestamp(input.leaseExpiresAt, "Schedule recovery lease expiry");
    if (leaseExpiresAt <= claimedAt) throw new StoreError("Schedule recovery lease must expire in the future.");
    return this.schedulerRuntimeWrite(() => {
      const current = this.findScheduleRuntimeOccurrence(input.runId);
      if (
        current === undefined ||
        current.phase !== "stalled" ||
        current.ownerId !== input.expectedOwnerId ||
        current.ownerGeneration !== input.expectedOwnerGeneration ||
        current.lastProgressAt !== input.expectedLastProgressAt
      ) return undefined;
      const ownerGeneration = checkedSchedulerGeneration(Math.max(
        current.ownerGeneration + 1,
        input.recoveryGenerationFloor
      ));
      const result = this.database.prepare(`
        UPDATE schedule_runtime_occurrences
        SET owner_id = ?, owner_generation = ?, phase = 'recovering',
            heartbeat_at = ?, lease_expires_at = ?, updated_at = ?, revision = revision + 1
        WHERE run_id = ? AND owner_id = ? AND owner_generation = ?
          AND phase = 'stalled' AND last_progress_at = ? AND revision = ?
      `).run(
        boundedSchedulerRuntimeId(input.recoveryOwnerId, "Schedule recovery owner ID"),
        ownerGeneration,
        claimedAt,
        leaseExpiresAt,
        claimedAt,
        current.runId,
        current.ownerId,
        current.ownerGeneration,
        current.lastProgressAt,
        asSqlInteger(current.revision)
      );
      return Number(result.changes) === 1 ? this.getScheduleRuntimeOccurrence(current.runId) : undefined;
    });
  }

  claimStaleScheduleRuntimeOccurrences(input: {
    readonly recoveryOwnerId: string;
    readonly recoveryGenerationFloor: number;
    readonly claimedAt?: number;
    readonly leaseExpiresAt: number;
    readonly limit?: number;
  }): ScheduleRuntimeOccurrenceRecord[] {
    const recoveryOwnerId = boundedSchedulerRuntimeId(input.recoveryOwnerId, "Schedule recovery owner ID");
    const generationFloor = checkedSchedulerGeneration(input.recoveryGenerationFloor);
    const claimedAt = schedulerRuntimeTimestamp(input.claimedAt ?? this.now(), "Schedule recovery claim time");
    const leaseExpiresAt = schedulerRuntimeTimestamp(input.leaseExpiresAt, "Schedule recovery lease expiry");
    if (leaseExpiresAt <= claimedAt) throw new StoreError("Schedule recovery lease must expire in the future.");
    const limit = normalizeLimit(input.limit, 100);
    return this.schedulerRuntimeWrite(() => {
      const candidates = (this.database.prepare(`
        SELECT * FROM schedule_runtime_occurrences
        WHERE lease_expires_at <= ?
        ORDER BY lease_expires_at, run_id LIMIT ?
      `).all(claimedAt, limit) as Row[]).map(scheduleRuntimeOccurrenceFromRow);
      const claimed: ScheduleRuntimeOccurrenceRecord[] = [];
      for (const current of candidates) {
        const ownerGeneration = checkedSchedulerGeneration(Math.max(
          current.ownerGeneration + 1,
          generationFloor
        ));
        const result = this.database.prepare(`
          UPDATE schedule_runtime_occurrences
          SET owner_id = ?, owner_generation = ?, phase = 'recovering',
              heartbeat_at = ?, lease_expires_at = ?, updated_at = ?, revision = revision + 1
          WHERE run_id = ? AND owner_id = ? AND owner_generation = ?
            AND heartbeat_at = ? AND last_progress_at = ?
            AND lease_expires_at <= ? AND revision = ?
        `).run(
          recoveryOwnerId,
          ownerGeneration,
          claimedAt,
          leaseExpiresAt,
          claimedAt,
          current.runId,
          current.ownerId,
          current.ownerGeneration,
          current.heartbeatAt,
          current.lastProgressAt,
          claimedAt,
          asSqlInteger(current.revision)
        );
        if (Number(result.changes) === 1) claimed.push(this.getScheduleRuntimeOccurrence(current.runId));
      }
      return claimed;
    });
  }

  releaseScheduleRuntimeOccurrence(input: {
    readonly runId: string;
    readonly ownerId: string;
    readonly ownerGeneration: number;
  }): boolean {
    return this.schedulerRuntimeWrite(() => {
      const result = this.database.prepare(`
        DELETE FROM schedule_runtime_occurrences
        WHERE run_id = ? AND owner_id = ? AND owner_generation = ?
      `).run(
        nonBlank(input.runId, "Schedule runtime run ID"),
        boundedSchedulerRuntimeId(input.ownerId, "Schedule runtime owner ID"),
        checkedSchedulerGeneration(input.ownerGeneration)
      );
      return Number(result.changes) === 1;
    });
  }

  acquireToolLease(input: AcquireToolLeaseInput): ToolLeaseRecord {
    return this.write(() => {
      const now = input.now ?? this.now();
      if (input.expiresAt <= now) throw new StoreError("A tool lease must expire in the future.");
      const session = this.getSession(input.sessionId);
      if (session.descriptor.binding.generation !== input.generation) {
        throw new StaleGenerationError(session.descriptor.binding.generation, input.generation);
      }
      if (input.runId !== undefined) {
        const run = this.getRun(input.runId);
        if (run.descriptor.sessionId !== input.sessionId) {
          throw new StoreError("Tool lease run does not belong to its session.");
        }
      }
      const toolId = nonBlank(input.toolId, "Tool ID");
      this.database.prepare(`
        UPDATE tool_leases
        SET state = CASE WHEN expires_at <= ? THEN 'expired' ELSE 'revoked' END,
            released_at = ?, updated_at = ?, revision = ?
        WHERE tool_id = ? AND state = 'active'
      `).run(now, now, now, asSqlInteger(this.requireActiveRevision()), toolId);
      const fence = this.database.prepare(`
        INSERT INTO tool_fence_counters(tool_id, last_token) VALUES (?, 1)
        ON CONFLICT(tool_id) DO UPDATE SET last_token = last_token + 1
        RETURNING last_token
      `).get(toolId) as Row | undefined;
      if (fence === undefined) throw new StoreError(`Unable to allocate a fencing token for ${toolId}.`);
      this.database.prepare(`
        INSERT INTO tool_leases(
          id, tool_id, session_id, run_id, generation, fencing_token, state,
          expires_at, metadata_json, created_at, updated_at, revision
        ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
      `).run(
        input.id,
        toolId,
        input.sessionId,
        input.runId ?? null,
        input.generation,
        asSqlInteger(toBigInt(fence["last_token"])),
        input.expiresAt,
        serializeJson(input.metadata ?? {}),
        now,
        now,
        asSqlInteger(this.requireActiveRevision())
      );
      return this.getToolLease(input.id);
    });
  }

  getToolLease(id: string): ToolLeaseRecord {
    this.assertOpen();
    const row = this.database.prepare("SELECT * FROM tool_leases WHERE id = ?").get(id) as Row | undefined;
    if (row === undefined) throw new NotFoundError("Tool lease", id);
    return toolLeaseFromRow(row);
  }

  listToolLeases(options: {
    readonly toolId?: string;
    readonly sessionId?: string;
    readonly activeOnly?: boolean;
    readonly includeCleared?: boolean;
  } = {}): ToolLeaseRecord[] {
    this.assertOpen();
    const clauses: string[] = options.includeCleared === true ? [] : [`NOT EXISTS (
      SELECT 1 FROM session_reset_boundaries AS reset
      WHERE reset.session_id = lease.session_id
        AND lease.rowid <= reset.cleared_through_tool_lease_rowid
    )`];
    const params: string[] = [];
    if (options.toolId !== undefined) {
      clauses.push("lease.tool_id = ?");
      params.push(options.toolId);
    }
    if (options.sessionId !== undefined) {
      clauses.push("lease.session_id = ?");
      params.push(options.sessionId);
    }
    if (options.activeOnly === true) clauses.push("lease.state = 'active'");
    const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
    return (this.database.prepare(
      `SELECT lease.* FROM tool_leases AS lease ${where} ORDER BY lease.created_at DESC, lease.id`
    ).all(...params) as Row[]).map(toolLeaseFromRow);
  }

  renewToolLease(
    id: string,
    fencingToken: bigint,
    expiresAt: number,
    now = this.now()
  ): ToolLeaseRecord {
    return this.write(() => {
      if (expiresAt <= now) throw new StoreError("A renewed tool lease must expire in the future.");
      const current = this.getToolLease(id);
      const session = this.getSession(current.sessionId);
      if (
        current.state !== "active" ||
        current.fencingToken !== fencingToken ||
        current.expiresAt <= now ||
        current.generation !== session.descriptor.binding.generation
      ) {
        throw new StoreError(`Tool lease ${id} is stale or inactive.`);
      }
      const result = this.database.prepare(`
        UPDATE tool_leases SET expires_at = ?, updated_at = ?, revision = ?
        WHERE id = ? AND fencing_token = ? AND state = 'active' AND expires_at > ?
      `).run(
        expiresAt,
        now,
        asSqlInteger(this.requireActiveRevision()),
        id,
        asSqlInteger(fencingToken),
        now
      );
      if (result.changes !== 1) throw new StoreError(`Tool lease ${id} changed concurrently.`);
      return this.getToolLease(id);
    });
  }

  releaseToolLease(
    id: string,
    fencingToken: bigint,
    state: "released" | "revoked" = "released",
    now = this.now()
  ): ToolLeaseRecord {
    return this.write(() => {
      const current = this.getToolLease(id);
      if (current.fencingToken !== fencingToken) {
        throw new StoreError(`Tool lease ${id} has a different fencing token.`);
      }
      if (current.state !== "active") return current;
      const result = this.database.prepare(`
        UPDATE tool_leases SET state = ?, released_at = ?, updated_at = ?, revision = ?
        WHERE id = ? AND fencing_token = ? AND state = 'active'
      `).run(
        state,
        now,
        now,
        asSqlInteger(this.requireActiveRevision()),
        id,
        asSqlInteger(fencingToken)
      );
      if (result.changes !== 1) throw new StoreError(`Tool lease ${id} changed concurrently.`);
      return this.getToolLease(id);
    });
  }

  assertToolLease(id: string, fencingToken: bigint, at = this.now()): ToolLeaseRecord {
    const lease = this.getToolLease(id);
    const session = this.getSession(lease.sessionId);
    if (
      lease.state !== "active" ||
      lease.fencingToken !== fencingToken ||
      lease.expiresAt <= at ||
      lease.generation !== session.descriptor.binding.generation
    ) {
      throw new StoreError(`Tool lease ${id} is stale or inactive.`);
    }
    const currentFence = this.database.prepare(
      "SELECT last_token FROM tool_fence_counters WHERE tool_id = ?"
    ).get(lease.toolId) as Row | undefined;
    if (currentFence === undefined || toBigInt(currentFence["last_token"]) !== fencingToken) {
      throw new StoreError(`Tool lease ${id} has been fenced by a newer owner.`);
    }
    return lease;
  }

  expireToolLeases(at = this.now()): ToolLeaseRecord[] {
    const candidates = this.database.prepare(`
      SELECT id FROM tool_leases WHERE state = 'active' AND expires_at <= ? ORDER BY expires_at, id
    `).all(at) as Row[];
    if (candidates.length === 0) return [];
    return this.write(() => {
      const ids = candidates.map((row) => stringValue(row["id"]));
      this.database.prepare(`
        UPDATE tool_leases
        SET state = 'expired', released_at = ?, updated_at = ?, revision = ?
        WHERE state = 'active' AND expires_at <= ?
      `).run(at, at, asSqlInteger(this.requireActiveRevision()), at);
      return ids.map((id) => this.getToolLease(id));
    });
  }

  putArtifact(input: PutArtifactInput): ArtifactRecord {
    return this.write(() => {
      if (input.byteLength < 0 || !Number.isSafeInteger(input.byteLength)) {
        throw new StoreError("Artifact byte length must be a non-negative safe integer.");
      }
      const sha256 = normalizeSha256(input.sha256);
      if (input.sessionId !== undefined) this.getSession(input.sessionId);
      if (input.runId !== undefined) {
        const run = this.getRun(input.runId);
        if (input.sessionId !== undefined && run.descriptor.sessionId !== input.sessionId) {
          throw new StoreError("Artifact run does not belong to its session.");
        }
      }
      const existing = this.findArtifact(input.id, true);
      if (existing !== undefined) {
        if (
          existing.blob.sha256 !== sha256 ||
          existing.storageKey !== input.storageKey ||
          existing.blob.byteLength !== input.byteLength
        ) {
          throw new StoreError(`Artifact ${input.id} already names different content.`);
        }
        return existing;
      }
      const createdAt = input.createdAt ?? this.now();
      this.database.prepare(`
        INSERT INTO artifacts(
          id, sha256, byte_length, mime_type, file_name, storage_key,
          session_id, run_id, metadata_json, created_at, revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id,
        sha256,
        input.byteLength,
        nonBlank(input.mimeType, "Artifact MIME type"),
        input.fileName ?? null,
        nonBlank(input.storageKey, "Artifact storage key"),
        input.sessionId ?? null,
        input.runId ?? null,
        serializeJson(input.metadata ?? {}),
        createdAt,
        asSqlInteger(this.requireActiveRevision())
      );
      const artifact = this.getArtifact(input.id);
      if (input.sessionId !== undefined && input.traceId !== undefined) {
        const session = this.getSession(input.sessionId);
        this.appendEvent({
          backendId: session.descriptor.backendId,
          targetId: session.descriptor.targetId,
          sessionId: session.descriptor.id,
          ...(input.runId === undefined ? {} : { runId: input.runId }),
          generation: session.descriptor.binding.generation,
          traceId: input.traceId,
          payload: {
            type: "artifact",
            artifact: artifact.blob,
            purpose: input.purpose ?? "artifact"
          }
        });
      }
      return artifact;
    });
  }

  findPermanentArtifactByStorage(
    storageKey: string,
    mimeType: string,
    fileName: string | undefined
  ): ArtifactRecord | undefined {
    this.assertOpen();
    const row = this.database.prepare(`
      SELECT * FROM artifacts
      WHERE storage_key = ?
        AND mime_type = ?
        AND file_name IS ?
        AND deleted_at IS NULL
        AND json_type(metadata_json, '$.expiresAt') IS NULL
      ORDER BY created_at, id
      LIMIT 1
    `).get(storageKey, mimeType, fileName ?? null) as Row | undefined;
    return row === undefined ? undefined : artifactFromRow(row);
  }

  getArtifact(id: string, includeDeleted = false): ArtifactRecord {
    const artifact = this.findArtifact(id, includeDeleted);
    if (artifact === undefined) throw new NotFoundError("Artifact", id);
    return artifact;
  }

  findArtifact(id: string, includeDeleted = false): ArtifactRecord | undefined {
    this.assertOpen();
    const row = this.database.prepare(
      `SELECT * FROM artifacts WHERE id = ? ${includeDeleted ? "" : "AND deleted_at IS NULL"}`
    ).get(id) as Row | undefined;
    return row === undefined ? undefined : artifactFromRow(row);
  }

  listArtifacts(options: ArtifactListOptions = {}): ArtifactRecord[] {
    this.assertOpen();
    const filter = artifactSqlFilter(options);
    return (this.database.prepare(
      `SELECT artifact.* FROM artifacts AS artifact ${filter.where}
       ORDER BY artifact.created_at DESC, artifact.id LIMIT ? OFFSET ?`
    ).all(...filter.params, normalizeLimit(options.limit, 500), normalizeOffset(options.offset)) as Row[])
      .map(artifactFromRow);
  }

  countArtifacts(options: Omit<ArtifactListOptions, "limit" | "offset"> = {}): number {
    this.assertOpen();
    const filter = artifactSqlFilter(options);
    const row = this.database.prepare(
      `SELECT COUNT(*) AS count FROM artifacts AS artifact ${filter.where}`
    ).get(...filter.params) as Row;
    return numberValue(row["count"]);
  }

  /**
   * Atomically expires every due Artifact and returns at most one physical
   * storage candidate per key, but only when no live Artifact still references
   * that key. SQL performs the full-table reference fence without materializing
   * the Artifact catalog in application memory.
   */
  expireArtifacts(at = this.now()): ArtifactRecord[] {
    if (!Number.isSafeInteger(at) || at < 0) throw new StoreError("Artifact expiration time is invalid.");
    return this.write(() => {
      const revision = asSqlInteger(this.requireActiveRevision());
      const expired = this.database.prepare(`
        UPDATE artifacts
        SET deleted_at = ?, revision = ?
        WHERE deleted_at IS NULL
          AND json_type(metadata_json, '$.expiresAt') IN ('integer', 'real')
          AND json_extract(metadata_json, '$.expiresAt') <= ?
      `).run(at, revision, at);
      if (expired.changes === 0) return [];
      return (this.database.prepare(`
        SELECT candidate.*
        FROM artifacts AS candidate
        WHERE candidate.deleted_at = ?
          AND candidate.revision = ?
          AND NOT EXISTS (
            SELECT 1 FROM artifacts AS live
            WHERE live.storage_key = candidate.storage_key
              AND live.deleted_at IS NULL
          )
          AND candidate.rowid = (
            SELECT MIN(peer.rowid)
            FROM artifacts AS peer
            WHERE peer.storage_key = candidate.storage_key
              AND peer.deleted_at = ?
              AND peer.revision = ?
          )
        ORDER BY candidate.created_at, candidate.id
      `).all(at, revision, at, revision) as Row[]).map(artifactFromRow);
    });
  }

  hasLiveArtifactStorageKey(storageKey: string): boolean {
    this.assertOpen();
    return this.database.prepare(`
      SELECT 1 FROM artifacts
      WHERE storage_key = ? AND deleted_at IS NULL
      LIMIT 1
    `).get(nonBlank(storageKey, "Artifact storage key")) !== undefined;
  }

  deleteArtifact(id: string, deletedAt = this.now()): ArtifactRecord {
    return this.write(() => {
      const current = this.getArtifact(id, true);
      if (current.deletedAt !== undefined) return current;
      this.database.prepare(`
        UPDATE artifacts SET deleted_at = ?, revision = ? WHERE id = ? AND deleted_at IS NULL
      `).run(deletedAt, asSqlInteger(this.requireActiveRevision()), id);
      return this.getArtifact(id, true);
    });
  }

  putMakerMemoryEntry(input: PutMakerMemoryEntryInput): MakerMemoryEntry {
    const targetId = nonBlank(input.targetId, "Memory Target ID");
    this.getTarget(targetId);
    const kind = makerMemoryKind(input.kind);
    const backendId = input.backendId === undefined ? undefined : makerMemoryBackendId(input.backendId);
    if ((kind === "digest") !== (backendId !== undefined)) {
      throw new StoreError("Memory Backend ID is required only for compression digests.");
    }
    const slug = normalizeMakerMemorySlug(input.slug);
    const title = boundedPrivateMemoryText(input.title, "Memory title", 100, false);
    const description = boundedPrivateMemoryText(input.description, "Memory description", 200, false);
    if (/\r|\n/u.test(description)) throw new StoreError("Memory description must be one line.");
    const body = boundedPrivateMemoryText(input.body, "Memory body", 8_192, true);
    const mode = input.mode ?? "create";
    if (mode !== "create" && mode !== "update" && mode !== "append") {
      throw new StoreError("Memory write mode is invalid.");
    }
    const current = this.findMakerMemoryEntry(targetId, kind, slug);
    if (current !== undefined && current.backendId !== backendId) {
      throw new StoreError("Memory entry Backend ownership does not match.");
    }
    if (mode === "create" && current !== undefined) throw new StoreError("Memory entry already exists.");
    if ((mode === "update" || mode === "append") && current === undefined) {
      throw new NotFoundError("Memory entry", `${targetId}/${kind}/${slug}`);
    }
    const nextBody = mode === "append" && current !== undefined
      ? boundedPrivateMemoryText(`${current.body}\n\n${body}`, "Memory body", 8_192, true)
      : body;
    const id = current?.id ?? input.id ?? this.idFactory();
    const updatedAt = input.updatedAt ?? this.now();
    const createdAt = current?.createdAt ?? updatedAt;
    return this.write(() => {
      this.database.prepare(`
        INSERT INTO maker_memory_entries(
          id, target_id, kind, backend_id, slug, title, description, body,
          created_at, updated_at, revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(target_id, kind, slug) DO UPDATE SET
          title = excluded.title,
          description = excluded.description,
          body = excluded.body,
          updated_at = excluded.updated_at,
          revision = excluded.revision
      `).run(
        id,
        targetId,
        kind,
        backendId ?? null,
        slug,
        title,
        description,
        nextBody,
        createdAt,
        updatedAt,
        asSqlInteger(this.requireActiveRevision())
      );
      this.database.prepare("DELETE FROM maker_memory_fts WHERE entry_id = ?").run(id);
      this.database.prepare(`
        INSERT INTO maker_memory_fts(entry_id, target_id, kind, title, description, body)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, targetId, kind, title, description, nextBody);
      return this.getMakerMemoryEntry(id);
    });
  }

  getMakerMemoryEntry(id: string): MakerMemoryEntry {
    this.assertOpen();
    const row = this.database.prepare("SELECT * FROM maker_memory_entries WHERE id = ?")
      .get(nonBlank(id, "Memory entry ID")) as Row | undefined;
    if (row === undefined) throw new NotFoundError("Memory entry", id);
    return makerMemoryEntryFromRow(row);
  }

  findMakerMemoryEntry(
    targetId: string,
    kind: MakerMemoryKind,
    slug: string
  ): MakerMemoryEntry | undefined {
    this.assertOpen();
    const row = this.database.prepare(`
      SELECT * FROM maker_memory_entries WHERE target_id = ? AND kind = ? AND slug = ?
    `).get(targetId, makerMemoryKind(kind), normalizeMakerMemorySlug(slug)) as Row | undefined;
    return row === undefined ? undefined : makerMemoryEntryFromRow(row);
  }

  listMakerMemoryEntries(options: {
    readonly targetId?: string;
    readonly kind?: MakerMemoryKind;
    readonly backendId?: string;
    readonly limit?: number;
    readonly offset?: number;
  } = {}): MakerMemoryEntry[] {
    this.assertOpen();
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (options.targetId !== undefined) {
      clauses.push("target_id = ?");
      params.push(nonBlank(options.targetId, "Memory Target ID"));
    }
    if (options.kind !== undefined) {
      clauses.push("kind = ?");
      params.push(makerMemoryKind(options.kind));
    }
    if (options.backendId !== undefined) {
      clauses.push("backend_id = ?");
      params.push(makerMemoryBackendId(options.backendId));
    }
    const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
    return (this.database.prepare(`
      SELECT * FROM maker_memory_entries ${where}
      ORDER BY updated_at DESC, id LIMIT ? OFFSET ?
    `).all(
      ...params,
      normalizeLimit(options.limit, 1_000),
      normalizeOffset(options.offset)
    ) as Row[]).map(makerMemoryEntryFromRow);
  }

  countMakerMemoryEntries(kind?: MakerMemoryKind, backendId?: string): number {
    this.assertOpen();
    if (backendId !== undefined && kind !== "digest") {
      throw new StoreError("Memory Backend filters apply only to compression digests.");
    }
    const row = backendId !== undefined
      ? this.database.prepare("SELECT count(*) AS count FROM maker_memory_entries WHERE kind = 'digest' AND backend_id = ?")
        .get(makerMemoryBackendId(backendId)) as Row
      : kind === undefined
        ? this.database.prepare("SELECT count(*) AS count FROM maker_memory_entries").get() as Row
        : this.database.prepare("SELECT count(*) AS count FROM maker_memory_entries WHERE kind = ?")
          .get(makerMemoryKind(kind)) as Row;
    return numberValue(row["count"]);
  }

  searchMakerMemory(
    targetId: string,
    query: string,
    options: { readonly kind?: MakerMemoryKind; readonly limit?: number } = {}
  ): MakerMemorySearchHit[] {
    this.assertOpen();
    const normalizedTarget = nonBlank(targetId, "Memory Target ID");
    const normalizedQuery = query.trim();
    if (normalizedQuery.length === 0 || normalizedQuery.length > 256 || normalizedQuery.includes("\0")) {
      throw new StoreError("Memory search query must contain 1 through 256 safe characters.");
    }
    const tokens = [...new Set(normalizedQuery.match(/[\p{L}\p{N}_-]+/gu) ?? [])];
    if (tokens.length === 0) return [];
    const match = tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ");
    const kindClause = options.kind === undefined ? "" : "AND entry.kind = ?";
    const params: Array<string | number> = [match, normalizedTarget];
    if (options.kind !== undefined) params.push(makerMemoryKind(options.kind));
    params.push(normalizeLimit(options.limit, 10));
    return (this.database.prepare(`
      SELECT
        entry.id,
        entry.target_id,
        entry.kind,
        entry.title,
        entry.description,
        snippet(maker_memory_fts, 5, '', '', ' … ', 24) AS snippet,
        bm25(maker_memory_fts) AS score
      FROM maker_memory_fts
      JOIN maker_memory_entries AS entry ON entry.id = maker_memory_fts.entry_id
      WHERE maker_memory_fts MATCH ? AND entry.target_id = ? ${kindClause}
      ORDER BY score, entry.updated_at DESC, entry.id
      LIMIT ?
    `).all(...params) as Row[]).map((row) => ({
      id: stringValue(row["id"]),
      targetId: stringValue(row["target_id"]),
      kind: makerMemoryKind(row["kind"]),
      title: stringValue(row["title"]),
      description: stringValue(row["description"]),
      snippet: stringValue(row["snippet"]),
      score: Number(row["score"] ?? 0)
    }));
  }

  deleteMakerMemoryEntry(id: string): boolean {
    const entry = this.getMakerMemoryEntry(id);
    return this.write(() => {
      this.database.prepare("DELETE FROM maker_memory_fts WHERE entry_id = ?").run(entry.id);
      return this.database.prepare("DELETE FROM maker_memory_entries WHERE id = ?").run(entry.id).changes === 1;
    });
  }

  resetMakerMemory(scope: "curated"): { readonly removedEntries: number; readonly removedTargets: number };
  resetMakerMemory(scope: "digest", backendId: string): { readonly removedEntries: number; readonly removedTargets: number };
  resetMakerMemory(
    scope: "curated" | "digest",
    backendId?: string
  ): { readonly removedEntries: number; readonly removedTargets: number } {
    this.assertOpen();
    if (scope === "curated" && backendId !== undefined) {
      throw new StoreError("Curated Maker Memory reset does not accept a Backend ID.");
    }
    const normalizedBackendId = scope === "digest"
      ? makerMemoryBackendId(backendId ?? "")
      : undefined;
    const targets = scope === "curated"
      ? this.database.prepare("SELECT count(DISTINCT target_id) AS count FROM maker_memory_entries WHERE kind <> 'digest'").get() as Row
      : this.database.prepare("SELECT count(DISTINCT target_id) AS count FROM maker_memory_entries WHERE kind = 'digest' AND backend_id = ?")
        .get(normalizedBackendId!) as Row;
    return this.write(() => {
      const ftsResult = scope === "curated"
        ? this.database.prepare("DELETE FROM maker_memory_fts WHERE kind <> 'digest'").run()
        : this.database.prepare(`
            DELETE FROM maker_memory_fts WHERE entry_id IN (
              SELECT id FROM maker_memory_entries WHERE kind = 'digest' AND backend_id = ?
            )
          `).run(normalizedBackendId!);
      const result = scope === "curated"
        ? this.database.prepare("DELETE FROM maker_memory_entries WHERE kind <> 'digest'").run()
        : this.database.prepare("DELETE FROM maker_memory_entries WHERE kind = 'digest' AND backend_id = ?")
          .run(normalizedBackendId!);
      void ftsResult;
      return { removedEntries: Number(result.changes), removedTargets: numberValue(targets["count"]) };
    });
  }

  setSetting<T>(
    scopeType: SettingScope,
    scopeId: string,
    key: string,
    value: T,
    updatedAt = this.now()
  ): SettingRecord<T> {
    return this.write(() => {
      assertSafeSettingKey(key);
      const normalizedScopeId = nonBlank(scopeId, "Setting scope ID");
      const normalizedKey = key.trim();
      this.database.prepare(`
        INSERT INTO settings(scope_type, scope_id, key, value_json, updated_at, revision)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_type, scope_id, key) DO UPDATE SET
          value_json = excluded.value_json,
          updated_at = excluded.updated_at,
          revision = excluded.revision
      `).run(
        scopeType,
        normalizedScopeId,
        normalizedKey,
        serializeJson(value),
        updatedAt,
        asSqlInteger(this.requireActiveRevision())
      );
      return this.getSetting<T>(scopeType, normalizedScopeId, normalizedKey);
    });
  }

  getSetting<T = unknown>(scopeType: SettingScope, scopeId: string, key: string): SettingRecord<T> {
    this.assertOpen();
    const row = this.database.prepare(`
      SELECT * FROM settings WHERE scope_type = ? AND scope_id = ? AND key = ?
    `).get(scopeType, scopeId, key.trim()) as Row | undefined;
    if (row === undefined) throw new NotFoundError("Setting", `${scopeType}/${scopeId}/${key}`);
    return settingFromRow<T>(row);
  }

  findSetting<T = unknown>(scopeType: SettingScope, scopeId: string, key: string): SettingRecord<T> | undefined {
    this.assertOpen();
    const row = this.database.prepare(`
      SELECT * FROM settings WHERE scope_type = ? AND scope_id = ? AND key = ?
    `).get(scopeType, scopeId, key.trim()) as Row | undefined;
    return row === undefined ? undefined : settingFromRow<T>(row);
  }

  listSettings(scopeType?: SettingScope, scopeId?: string): SettingRecord[] {
    this.assertOpen();
    if (scopeType === undefined) {
      return (this.database.prepare(
        "SELECT * FROM settings ORDER BY scope_type, scope_id, key"
      ).all() as Row[]).map(settingFromRow);
    }
    if (scopeId === undefined) {
      return (this.database.prepare(
        "SELECT * FROM settings WHERE scope_type = ? ORDER BY scope_id, key"
      ).all(scopeType) as Row[]).map(settingFromRow);
    }
    return (this.database.prepare(`
      SELECT * FROM settings WHERE scope_type = ? AND scope_id = ? ORDER BY key
    `).all(scopeType, scopeId) as Row[]).map(settingFromRow);
  }

  deleteSetting(scopeType: SettingScope, scopeId: string, key: string): boolean {
    const existing = this.findSetting(scopeType, scopeId, key);
    if (existing === undefined) return false;
    return this.write(() => this.database.prepare(`
      DELETE FROM settings WHERE scope_type = ? AND scope_id = ? AND key = ?
    `).run(scopeType, scopeId, key.trim()).changes === 1);
  }

  appendDiagnostic(input: {
    readonly id?: string;
    readonly severity: DiagnosticRecord["severity"];
    readonly component: string;
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
    readonly createdAt?: number;
  }): DiagnosticRecord {
    return this.write(() => {
      const id = input.id ?? this.idFactory();
      this.database.prepare(`
        INSERT INTO diagnostics(
          id, severity, component, code, message, details_json, created_at, revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        input.severity,
        nonBlank(input.component, "Diagnostic component"),
        nonBlank(input.code, "Diagnostic code"),
        redactSecrets(input.message),
        serializeJson(input.details ?? {}),
        input.createdAt ?? this.now(),
        asSqlInteger(this.requireActiveRevision())
      );
      return this.getDiagnostic(id);
    });
  }

  getDiagnostic(id: string): DiagnosticRecord {
    this.assertOpen();
    const row = this.database.prepare("SELECT * FROM diagnostics WHERE id = ?").get(id) as Row | undefined;
    if (row === undefined) throw new NotFoundError("Diagnostic", id);
    return diagnosticFromRow(row);
  }

  listDiagnostics(options: {
    readonly component?: string;
    readonly severity?: DiagnosticRecord["severity"];
    readonly after?: number;
    readonly limit?: number;
    readonly offset?: number;
  } = {}): DiagnosticRecord[] {
    this.assertOpen();
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (options.component !== undefined) {
      clauses.push("component = ?");
      params.push(options.component);
    }
    if (options.severity !== undefined) {
      clauses.push("severity = ?");
      params.push(options.severity);
    }
    if (options.after !== undefined) {
      clauses.push("created_at > ?");
      params.push(options.after);
    }
    const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
    return (this.database.prepare(
      `SELECT * FROM diagnostics ${where} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`
    ).all(
      ...params,
      normalizeLimit(options.limit, 500),
      normalizeOffset(options.offset)
    ) as Row[]).map(diagnosticFromRow);
  }

  runAuthorizedOperation<T>(
    connectionId: string,
    authKeyDigest: string,
    input: Omit<OperationInput, "connectionId">,
    callback: (store: this, connection: ConnectionRecord) => T
  ): OperationExecution<T> {
    const operationInput: OperationInput = { ...input, connectionId };
    const bodyHash = operationBodyHash(input.body);
    let authorized = false;
    try {
      return this.transaction(() => {
        const connection = this.authorizeConnection(connectionId, authKeyDigest);
        authorized = true;
        const existing = this.findOperation<T>(input.id);
        if (existing !== undefined) {
          if (existing.connectionId !== connectionId) {
            throw new AuthorizationError("The operation belongs to a different connection.");
          }
          return replayOperation(existing, bodyHash);
        }
        const createdAt = input.createdAt ?? this.now();
        this.database.prepare(`
          INSERT INTO operations(
            id, connection_id, kind, body_json, body_hash, completion_mode,
            status, created_at, updated_at, revision
          ) VALUES (?, ?, ?, ?, ?, 'transactional', 'started', ?, ?, ?)
        `).run(
          input.id,
          connectionId,
          nonBlank(input.kind, "Operation kind"),
          serializeJson(input.body),
          bodyHash,
          createdAt,
          createdAt,
          asSqlInteger(this.requireActiveRevision())
        );
        const value = callback(this, connection);
        if (isPromiseLike(value)) throw new AsyncTransactionError();
        this.database.prepare(`
          UPDATE operations
          SET status = 'completed', response_json = ?, updated_at = ?, revision = ?
          WHERE id = ? AND status = 'started'
        `).run(
          serializeJson(value),
          this.now(),
          asSqlInteger(this.requireActiveRevision()),
          input.id
        );
        return { replayed: false, value, operation: this.getOperation<T>(input.id) };
      });
    } catch (error) {
      if (
        !authorized ||
        error instanceof AuthorizationError ||
        error instanceof OperationConflictError ||
        error instanceof OperationInProgressError ||
        error instanceof OperationPreviouslyFailedError ||
        error instanceof AsyncTransactionError
      ) throw error;
      this.persistOperationFailure(operationInput, bodyHash, error);
      throw error;
    }
  }

  getSessionSnapshot(sessionId: string): SessionSnapshot {
    return this.readConsistent(() => {
      const session = this.getSession(sessionId);
      const target = this.getTarget(session.descriptor.targetId);
      const backend = this.getBackend(session.descriptor.backendId);
      const revision = this.readRevision();
      const globalCursor = this.latestEventCursor();
      const counter = this.database.prepare(
        "SELECT last_sequence FROM session_event_counters WHERE session_id = ?"
      ).get(sessionId) as Row | undefined;
      if (counter === undefined) throw new StoreError(`Event counter is missing for session ${sessionId}.`);
      const runs = collectStorePages((offset, limit) => this.listRuns({ sessionId, limit, offset }));
      const attempts = (this.database.prepare(`
        SELECT a.* FROM attempts a
        JOIN runs r ON r.id = a.run_id
        WHERE r.session_id = ? ORDER BY a.started_at, a.id
      `).all(sessionId) as Row[]).map(attemptFromRow);
      return {
        revision,
        globalCursor,
        eventSequence: toBigInt(counter["last_sequence"]),
        backend,
        target,
        session,
        runs,
        attempts,
        queueItems: collectStorePages((offset, limit) => this.listQueueItems({ sessionId, limit, offset })),
        interactions: collectStorePages((offset, limit) => this.listInteractions({ sessionId, limit, offset })),
        schedules: this.listSchedules({ sessionId }),
        artifacts: collectStorePages((offset, limit) => this.listArtifacts({ sessionId, limit, offset }))
      };
    });
  }

  getSnapshot(at = this.now()): OperationalSnapshot {
    return this.readConsistent(() => ({
      revision: this.readRevision(),
      globalCursor: this.latestEventCursor(),
      devices: this.listDevices(),
      connections: this.listConnections(),
      backends: this.listBackends(),
      targets: this.listTargets(),
      sessions: this.listSessions({ includeArchived: true, includeDeleted: false }),
      activeRuns: collectStorePages((offset, limit) => this.listRuns({ activeOnly: true, limit, offset })),
      dueSchedules: collectStorePages((offset, limit) => this.listDueSchedules(at, limit, offset)),
      openInteractions: collectStorePages((offset, limit) => this.listInteractions({
        status: "open",
        limit,
        offset
      }))
    }));
  }

  private write<T>(callback: () => T): T {
    this.assertOpen();
    return this.transactionFrames.length === 0 ? this.transaction(callback) : callback();
  }

  /**
   * Converts one cumulative native observation into an additive, attributed
   * delta. Each capability-neutral source cursor is deliberately independent
   * of generation, Provider and model so a runtime handoff cannot count the
   * same cumulative prefix twice. Counter rollback starts a new cumulative
   * epoch.
   */
  recordUsageObservation(input: RecordUsageObservationInput): UsageObservationResult {
    this.assertOpen();
    const ownerId = usageIdentity(input.ownerId, "usage owner ID", 256, false);
    const sessionId = usageIdentity(input.sessionId, "usage Session ID", 256, false);
    const sourceId = usageIdentity(input.sourceId, "usage source ID", 512, false);
    const backendId = usageIdentity(input.backendId, "usage Backend ID", 256, false);
    const providerId = usageIdentity(input.providerId, "usage Provider ID", 512, true);
    const modelId = usageIdentity(input.modelId, "usage model ID", 512, true);
    const generation = safeUsageInteger(input.generation, "usage generation");
    const measuredAt = safeUsageInteger(input.measuredAt, "usage measurement time");
    const current = {
      inputTokens: safeUsageInteger(input.inputTokens, "usage input tokens"),
      outputTokens: safeUsageInteger(input.outputTokens, "usage output tokens"),
      cacheReadTokens: safeUsageInteger(input.cacheReadTokens, "usage cache-read tokens"),
      cacheWriteTokens: safeUsageInteger(input.cacheWriteTokens, "usage cache-write tokens"),
      totalTokens: safeUsageInteger(input.totalTokens, "usage total tokens")
    };
    const reportedCostMicros = input.reportedCostMicros === undefined
      ? undefined
      : safeUsageInteger(input.reportedCostMicros, "reported usage cost");
    const rates = input.costRates === undefined ? undefined : {
      inputMicrosPerMillion: safeUsageInteger(input.costRates.inputMicrosPerMillion, "input usage rate"),
      outputMicrosPerMillion: safeUsageInteger(input.costRates.outputMicrosPerMillion, "output usage rate"),
      ...(input.costRates.cacheReadMicrosPerMillion === undefined ? {} : {
        cacheReadMicrosPerMillion: safeUsageInteger(input.costRates.cacheReadMicrosPerMillion, "cache-read usage rate")
      }),
      ...(input.costRates.cacheWriteMicrosPerMillion === undefined ? {} : {
        cacheWriteMicrosPerMillion: safeUsageInteger(input.costRates.cacheWriteMicrosPerMillion, "cache-write usage rate")
      })
    };
    const currencyCode = usageCurrency(input.currencyCode ?? "USD");
    const day = usageDay(measuredAt);

    return this.write(() => {
      const session = this.getSession(sessionId);
      if (session.descriptor.backendId !== backendId) {
        throw new StoreError("Usage observation Backend does not own the Session.");
      }
      if (session.descriptor.binding.generation !== generation) {
        throw new StaleGenerationError(session.descriptor.binding.generation, generation);
      }
      const prior = this.database.prepare(`
        SELECT * FROM usage_session_cursors WHERE owner_id = ? AND session_id = ? AND source_id = ?
      `).get(ownerId, sessionId, sourceId) as Row | undefined;
      if (prior !== undefined) {
        const priorMeasuredAt = numberValue(prior["measured_at"]);
        const noChange = {
          changed: false,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
          costMicros: 0,
          costComplete: true,
          estimated: false,
          day: usageDay(priorMeasuredAt)
        } satisfies UsageObservationResult;
        if (measuredAt < priorMeasuredAt) return noChange;
        if (measuredAt === priorMeasuredAt) {
          const priorReported = prior["reported_cost_micros"];
          const samePayload = numberValue(prior["generation"]) === generation
            && stringValue(prior["backend_id"]) === backendId
            && stringValue(prior["provider_id"]) === providerId
            && stringValue(prior["model_id"]) === modelId
            && numberValue(prior["input_tokens"]) === current.inputTokens
            && numberValue(prior["output_tokens"]) === current.outputTokens
            && numberValue(prior["cache_read_tokens"]) === current.cacheReadTokens
            && numberValue(prior["cache_write_tokens"]) === current.cacheWriteTokens
            && numberValue(prior["total_tokens"]) === current.totalTokens
            && (priorReported === null || priorReported === undefined
              ? reportedCostMicros === undefined
              : numberValue(priorReported) === reportedCostMicros);
          if (!samePayload) {
            throw new StoreError("Conflicting usage observations share the same measurement time.");
          }
          return noChange;
        }
      }
      const delta = {
        inputTokens: usageCounterDelta(current.inputTokens, prior?.["input_tokens"]),
        outputTokens: usageCounterDelta(current.outputTokens, prior?.["output_tokens"]),
        cacheReadTokens: usageCounterDelta(current.cacheReadTokens, prior?.["cache_read_tokens"]),
        cacheWriteTokens: usageCounterDelta(current.cacheWriteTokens, prior?.["cache_write_tokens"]),
        totalTokens: usageCounterDelta(current.totalTokens, prior?.["total_tokens"])
      };
      const priorReported = prior?.["reported_cost_micros"];
      let costMicros = 0;
      let costComplete = true;
      let estimated = false;
      if (reportedCostMicros !== undefined && prior === undefined) {
        costMicros = reportedCostMicros;
        estimated = input.reportedCostEstimated === true;
      } else if (reportedCostMicros !== undefined && priorReported !== null && priorReported !== undefined) {
        costMicros = usageCounterDelta(reportedCostMicros, priorReported);
        estimated = input.reportedCostEstimated === true;
      } else if (reportedCostMicros !== undefined) {
        // A prior token-priced observation has already accounted for this
        // cumulative prefix. The first upstream cost therefore establishes a
        // baseline only; charging it again would double-count that prefix.
        costComplete = false;
        estimated = input.reportedCostEstimated === true;
      } else if (rates !== undefined) {
        const estimate = usageEstimatedCost(delta, rates);
        costMicros = estimate.costMicros;
        costComplete = estimate.complete;
        estimated = true;
      } else {
        costComplete = false;
        estimated = true;
      }
      const changed = delta.inputTokens !== 0
        || delta.outputTokens !== 0
        || delta.cacheReadTokens !== 0
        || delta.cacheWriteTokens !== 0
        || delta.totalTokens !== 0
        || costMicros !== 0;
      const revision = this.requireActiveRevision();

      this.database.prepare(`
        INSERT INTO usage_session_cursors(
          owner_id, session_id, source_id, generation, backend_id, provider_id, model_id,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
          total_tokens, reported_cost_micros, measured_at, revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(owner_id, session_id, source_id) DO UPDATE SET
          generation = excluded.generation,
          backend_id = excluded.backend_id,
          provider_id = excluded.provider_id,
          model_id = excluded.model_id,
          input_tokens = excluded.input_tokens,
          output_tokens = excluded.output_tokens,
          cache_read_tokens = excluded.cache_read_tokens,
          cache_write_tokens = excluded.cache_write_tokens,
          total_tokens = excluded.total_tokens,
          reported_cost_micros = excluded.reported_cost_micros,
          measured_at = MAX(usage_session_cursors.measured_at, excluded.measured_at),
          revision = excluded.revision
      `).run(
        ownerId, sessionId, sourceId, generation, backendId, providerId, modelId,
        current.inputTokens, current.outputTokens, current.cacheReadTokens,
        current.cacheWriteTokens, current.totalTokens, reportedCostMicros ?? null,
        measuredAt, asSqlInteger(revision)
      );

      if (changed) {
        this.database.prepare(`
          INSERT INTO usage_daily_ledger(
            owner_id, session_id, generation, backend_id, provider_id, model_id, day,
            input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
            total_tokens, cost_micros, currency_code, cost_complete, estimated,
            first_measured_at, last_measured_at, revision
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(owner_id, session_id, generation, backend_id, provider_id, model_id, day, currency_code)
          DO UPDATE SET
            input_tokens = usage_daily_ledger.input_tokens + excluded.input_tokens,
            output_tokens = usage_daily_ledger.output_tokens + excluded.output_tokens,
            cache_read_tokens = usage_daily_ledger.cache_read_tokens + excluded.cache_read_tokens,
            cache_write_tokens = usage_daily_ledger.cache_write_tokens + excluded.cache_write_tokens,
            total_tokens = usage_daily_ledger.total_tokens + excluded.total_tokens,
            cost_micros = usage_daily_ledger.cost_micros + excluded.cost_micros,
            cost_complete = MIN(usage_daily_ledger.cost_complete, excluded.cost_complete),
            estimated = MAX(usage_daily_ledger.estimated, excluded.estimated),
            first_measured_at = MIN(usage_daily_ledger.first_measured_at, excluded.first_measured_at),
            last_measured_at = MAX(usage_daily_ledger.last_measured_at, excluded.last_measured_at),
            revision = excluded.revision
        `).run(
          ownerId, sessionId, generation, backendId, providerId, modelId, day,
          delta.inputTokens, delta.outputTokens, delta.cacheReadTokens,
          delta.cacheWriteTokens, delta.totalTokens, costMicros, currencyCode,
          costComplete ? 1 : 0, estimated ? 1 : 0, measuredAt, measuredAt,
          asSqlInteger(revision)
        );
      }
      return { changed, ...delta, costMicros, costComplete, estimated, day };
    });
  }

  listUsageLedger(input: UsageLedgerQuery): UsageLedgerDailyRecord[] {
    this.assertOpen();
    const ownerId = usageIdentity(input.ownerId, "usage owner ID", 256, false);
    const conditions = ["owner_id = ?"];
    const parameters: Array<string | number> = [ownerId];
    if (input.fromDay !== undefined) {
      conditions.push("day >= ?");
      parameters.push(validUsageDay(input.fromDay));
    }
    if (input.throughDay !== undefined) {
      conditions.push("day <= ?");
      parameters.push(validUsageDay(input.throughDay));
    }
    if (input.backendId !== undefined) {
      conditions.push("backend_id = ?");
      parameters.push(usageIdentity(input.backendId, "usage Backend ID", 256, false));
    }
    if (input.providerId !== undefined) {
      conditions.push("provider_id = ?");
      parameters.push(usageIdentity(input.providerId, "usage Provider ID", 512, true));
    }
    return (this.database.prepare(`
      SELECT * FROM usage_daily_ledger
      WHERE ${conditions.join(" AND ")}
      ORDER BY day, provider_id, model_id, session_id, generation
    `).all(...parameters) as Row[]).map(usageLedgerDailyFromRow);
  }

  summarizeUsageLedger(input: UsageLedgerQuery): UsageLedgerSummary {
    const rows = this.listUsageLedger(input);
    if (rows.length === 0) return {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      costMicros: 0,
      currencyCode: "USD",
      costComplete: false,
      estimated: false
    };
    const currencies = new Set(rows.map((row) => row.currencyCode));
    return {
      inputTokens: safeUsageSum(rows.map((row) => row.inputTokens), "usage input tokens"),
      outputTokens: safeUsageSum(rows.map((row) => row.outputTokens), "usage output tokens"),
      cacheReadTokens: safeUsageSum(rows.map((row) => row.cacheReadTokens), "usage cache-read tokens"),
      cacheWriteTokens: safeUsageSum(rows.map((row) => row.cacheWriteTokens), "usage cache-write tokens"),
      totalTokens: safeUsageSum(rows.map((row) => row.totalTokens), "usage total tokens"),
      costMicros: safeUsageSum(rows.map((row) => row.costMicros), "usage cost"),
      currencyCode: currencies.size === 1 ? rows[0]!.currencyCode : "USD",
      costComplete: currencies.size === 1 && rows.every((row) => row.costComplete),
      estimated: rows.some((row) => row.estimated),
      periodStartedAt: Math.min(...rows.map((row) => row.firstMeasuredAt)),
      periodEndedAt: Math.max(...rows.map((row) => row.lastMeasuredAt)),
      measuredAt: Math.max(...rows.map((row) => row.lastMeasuredAt))
    };
  }

  findModelPriceOverride(
    ownerId: string,
    backendId: string,
    providerId: string,
    modelId: string
  ): ModelPriceOverrideRecord | undefined {
    this.assertOpen();
    const row = this.database.prepare(`
      SELECT * FROM model_price_overrides
      WHERE owner_id = ? AND backend_id = ? AND provider_id = ? AND model_id = ?
    `).get(
      usageIdentity(ownerId, "model price owner ID", 256, false),
      usageIdentity(backendId, "model price Backend ID", 256, false),
      usageIdentity(providerId, "model price Provider ID", 512, false),
      usageIdentity(modelId, "model price model ID", 512, false)
    ) as Row | undefined;
    return row === undefined ? undefined : modelPriceOverrideFromRow(row);
  }

  listModelPriceOverrides(ownerId: string): ModelPriceOverrideRecord[] {
    this.assertOpen();
    const owner = usageIdentity(ownerId, "model price owner ID", 256, false);
    return (this.database.prepare(`
      SELECT * FROM model_price_overrides
      WHERE owner_id = ? ORDER BY backend_id, provider_id, model_id
    `).all(owner) as Row[]).map(modelPriceOverrideFromRow);
  }

  upsertModelPriceOverride(input: UpsertModelPriceOverrideInput): ModelPriceOverrideRecord {
    this.assertOpen();
    const ownerId = usageIdentity(input.ownerId, "model price owner ID", 256, false);
    const backendId = usageIdentity(input.backendId, "model price Backend ID", 256, false);
    const providerId = usageIdentity(input.providerId, "model price Provider ID", 512, false);
    const modelId = usageIdentity(input.modelId, "model price model ID", 512, false);
    const currencyCode = modelPriceCurrency(input.currencyCode);
    const inputCost = safeUsageInteger(input.inputCostMicrosPerMillion, "model input price");
    const outputCost = safeUsageInteger(input.outputCostMicrosPerMillion, "model output price");
    const cacheReadCost = input.cacheReadCostMicrosPerMillion === undefined
      ? undefined
      : safeUsageInteger(input.cacheReadCostMicrosPerMillion, "model cache-read price");
    const cacheWriteCost = input.cacheWriteCostMicrosPerMillion === undefined
      ? undefined
      : safeUsageInteger(input.cacheWriteCostMicrosPerMillion, "model cache-write price");
    const updatedAt = safeUsageInteger(input.updatedAt ?? this.now(), "model price update time");
    return this.write(() => {
      const existing = this.findModelPriceOverride(ownerId, backendId, providerId, modelId);
      if (existing === undefined) {
        const count = this.database.prepare(
          "SELECT COUNT(*) AS count FROM model_price_overrides WHERE owner_id = ?"
        ).get(ownerId) as Row | undefined;
        if (numberValue(count?.["count"] ?? 0) >= 4_096) {
          throw new StoreError("Model price override limit reached.");
        }
      }
      this.database.prepare(`
        INSERT INTO model_price_overrides(
          owner_id, backend_id, provider_id, model_id, currency_code,
          input_cost_micros_per_million, output_cost_micros_per_million,
          cache_read_cost_micros_per_million, cache_write_cost_micros_per_million,
          updated_at, revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(owner_id, backend_id, provider_id, model_id) DO UPDATE SET
          currency_code = excluded.currency_code,
          input_cost_micros_per_million = excluded.input_cost_micros_per_million,
          output_cost_micros_per_million = excluded.output_cost_micros_per_million,
          cache_read_cost_micros_per_million = excluded.cache_read_cost_micros_per_million,
          cache_write_cost_micros_per_million = excluded.cache_write_cost_micros_per_million,
          updated_at = excluded.updated_at,
          revision = excluded.revision
      `).run(
        ownerId, backendId, providerId, modelId, currencyCode, inputCost, outputCost,
        cacheReadCost ?? null, cacheWriteCost ?? null, updatedAt,
        asSqlInteger(this.requireActiveRevision())
      );
      return this.findModelPriceOverride(ownerId, backendId, providerId, modelId)!;
    });
  }

  deleteModelPriceOverride(ownerId: string, backendId: string, providerId: string, modelId: string): boolean {
    this.assertOpen();
    const owner = usageIdentity(ownerId, "model price owner ID", 256, false);
    const backend = usageIdentity(backendId, "model price Backend ID", 256, false);
    const provider = usageIdentity(providerId, "model price Provider ID", 512, false);
    const model = usageIdentity(modelId, "model price model ID", 512, false);
    return this.write(() => Number(this.database.prepare(`
      DELETE FROM model_price_overrides
      WHERE owner_id = ? AND backend_id = ? AND provider_id = ? AND model_id = ?
    `).run(owner, backend, provider, model).changes) === 1);
  }

  activateLocalRuntimeOwner(input: ActivateLocalRuntimeOwnerInput): LocalRuntimeOwnerRecord {
    this.assertOpen();
    const scope = localRuntimeScope(input);
    const activatedAt = localRuntimeTimestamp(input.activatedAt ?? this.now(), "activation time");
    return this.localRuntimeWrite(() => {
      const current = this.findLocalRuntimeOwner(scope.ownerId, scope.runtimeId);
      if (current !== undefined && scope.ownerGeneration < current.ownerGeneration) {
        throw new StaleGenerationError(current.ownerGeneration, scope.ownerGeneration);
      }
      if (current?.ownerGeneration === scope.ownerGeneration) return current;
      if (current === undefined) {
        this.database.prepare(`
          INSERT INTO local_runtime_owners(
            owner_id, runtime_id, generation, activated_at, updated_at, revision
          ) VALUES (?, ?, ?, ?, ?, 1)
        `).run(scope.ownerId, scope.runtimeId, scope.ownerGeneration, activatedAt, activatedAt);
        return this.findLocalRuntimeOwner(scope.ownerId, scope.runtimeId)!;
      }

      const at = Math.max(activatedAt, current.updatedAt);
      this.database.prepare(`
        UPDATE local_runtime_owners SET
          generation = ?, activated_at = ?, updated_at = ?, revision = revision + 1
        WHERE owner_id = ? AND runtime_id = ?
      `).run(scope.ownerGeneration, at, at, scope.ownerId, scope.runtimeId);
      this.database.prepare(`
        UPDATE local_model_pull_checkpoints SET
          owner_generation = ?, revision = revision + 1
        WHERE owner_id = ? AND runtime_id = ?
      `).run(scope.ownerGeneration, scope.ownerId, scope.runtimeId);
      this.database.prepare(`
        UPDATE local_runtime_provider_bindings SET
          owner_generation = ?, revision = revision + 1
        WHERE owner_id = ? AND runtime_id = ?
      `).run(scope.ownerGeneration, scope.ownerId, scope.runtimeId);
      const installation = this.database.prepare(`
        SELECT * FROM local_runtime_installations
        WHERE owner_id = ? AND runtime_id = ?
      `).get(scope.ownerId, scope.runtimeId) as Row | undefined;
      if (installation !== undefined) {
        const startedAt = localRuntimeTimestamp(numberValue(installation["started_at"]), "stored install start time");
        const nextAt = Math.max(at, startedAt);
        if (installation["state"] === "installing") {
          this.database.prepare(`
            UPDATE local_runtime_installations SET
              owner_generation = ?, state = 'failed', version = NULL,
              archive_sha256 = NULL, public_error_code = 'OWNER_CHANGED',
              heartbeat_at = ?, lease_expires_at = ?, updated_at = ?, revision = revision + 1
            WHERE owner_id = ? AND runtime_id = ?
          `).run(scope.ownerGeneration, nextAt, nextAt, nextAt, scope.ownerId, scope.runtimeId);
        } else {
          this.database.prepare(`
            UPDATE local_runtime_installations SET
              owner_generation = ?, updated_at = MAX(updated_at, ?), revision = revision + 1
            WHERE owner_id = ? AND runtime_id = ?
          `).run(scope.ownerGeneration, nextAt, scope.ownerId, scope.runtimeId);
        }
      }
      return this.findLocalRuntimeOwner(scope.ownerId, scope.runtimeId)!;
    });
  }

  findLocalRuntimeOwner(ownerId: string, runtimeId: string): LocalRuntimeOwnerRecord | undefined {
    this.assertOpen();
    const owner = localRuntimeIdentity(ownerId, "owner ID", 256);
    const runtime = localRuntimeId(runtimeId);
    const row = this.database.prepare(`
      SELECT * FROM local_runtime_owners WHERE owner_id = ? AND runtime_id = ?
    `).get(owner, runtime) as Row | undefined;
    return row === undefined ? undefined : localRuntimeOwnerFromRow(row);
  }

  claimLocalRuntimeInstallation(input: ClaimLocalRuntimeInstallationInput): LocalRuntimeInstallationClaim {
    this.assertOpen();
    const scope = localRuntimeScope(input);
    const operationId = localRuntimeIdentity(input.operationId, "installation operation ID", 128);
    const at = localRuntimeTimestamp(input.at ?? this.now(), "installation claim time");
    const leaseDuration = localRuntimeLeaseDuration(input.leaseDurationMs);
    return this.localRuntimeWrite(() => {
      this.requireLocalRuntimeOwner(scope);
      const current = this.findLocalRuntimeInstallation(scope);
      if (current?.operationId === operationId) {
        if (current.state !== "installing" || current.leaseExpiresAt > at) {
          return { claimed: false, recovered: false, record: current };
        }
      } else if (current?.state === "installing" && current.leaseExpiresAt > at) {
        throw new OperationInProgressError(current.operationId);
      }
      const recovered = current?.state === "installing";
      this.database.prepare(`
        INSERT INTO local_runtime_installations(
          owner_id, runtime_id, owner_generation, operation_id, state,
          version, archive_sha256, public_error_code, started_at,
          heartbeat_at, lease_expires_at, updated_at, revision
        ) VALUES (?, ?, ?, ?, 'installing', NULL, NULL, NULL, ?, ?, ?, ?, 1)
        ON CONFLICT(owner_id, runtime_id) DO UPDATE SET
          owner_generation = excluded.owner_generation,
          operation_id = excluded.operation_id,
          state = 'installing',
          version = NULL,
          archive_sha256 = NULL,
          public_error_code = NULL,
          started_at = excluded.started_at,
          heartbeat_at = excluded.heartbeat_at,
          lease_expires_at = excluded.lease_expires_at,
          updated_at = excluded.updated_at,
          revision = local_runtime_installations.revision + 1
      `).run(
        scope.ownerId, scope.runtimeId, scope.ownerGeneration, operationId,
        at, at, at + leaseDuration, at
      );
      return {
        claimed: true,
        recovered,
        record: this.findLocalRuntimeInstallation(scope)!
      };
    });
  }

  heartbeatLocalRuntimeInstallation(input: HeartbeatLocalRuntimeInstallationInput): LocalRuntimeInstallationRecord {
    this.assertOpen();
    const scope = localRuntimeScope(input);
    const operationId = localRuntimeIdentity(input.operationId, "installation operation ID", 128);
    const at = localRuntimeTimestamp(input.at ?? this.now(), "installation heartbeat time");
    const leaseDuration = localRuntimeLeaseDuration(input.leaseDurationMs);
    return this.localRuntimeWrite(() => {
      this.requireLocalRuntimeOwner(scope);
      const current = this.requireLocalRuntimeInstallation(scope, operationId, "installing");
      const heartbeatAt = Math.max(at, current.heartbeatAt);
      this.database.prepare(`
        UPDATE local_runtime_installations SET
          heartbeat_at = ?, lease_expires_at = ?, updated_at = ?, revision = revision + 1
        WHERE owner_id = ? AND runtime_id = ?
          AND owner_generation = ? AND operation_id = ? AND state = 'installing'
      `).run(
        heartbeatAt, heartbeatAt + leaseDuration, heartbeatAt,
        scope.ownerId, scope.runtimeId, scope.ownerGeneration, operationId
      );
      return this.findLocalRuntimeInstallation(scope)!;
    });
  }

  completeLocalRuntimeInstallation(input: CompleteLocalRuntimeInstallationInput): LocalRuntimeInstallationRecord {
    this.assertOpen();
    const scope = localRuntimeScope(input);
    const operationId = localRuntimeIdentity(input.operationId, "installation operation ID", 128);
    const version = localRuntimeVersion(input.version);
    const archiveSha256 = localRuntimeSha256(input.archiveSha256);
    const at = localRuntimeTimestamp(input.at ?? this.now(), "installation completion time");
    return this.localRuntimeWrite(() => {
      this.requireLocalRuntimeOwner(scope);
      const current = this.requireLocalRuntimeInstallation(scope, operationId, "installing");
      const completedAt = Math.max(at, current.heartbeatAt);
      this.database.prepare(`
        UPDATE local_runtime_installations SET
          state = 'installed', version = ?, archive_sha256 = ?,
          public_error_code = NULL, heartbeat_at = ?, lease_expires_at = ?,
          updated_at = ?, revision = revision + 1
        WHERE owner_id = ? AND runtime_id = ?
          AND owner_generation = ? AND operation_id = ? AND state = 'installing'
      `).run(
        version, archiveSha256, completedAt, completedAt, completedAt,
        scope.ownerId, scope.runtimeId, scope.ownerGeneration, operationId
      );
      return this.findLocalRuntimeInstallation(scope)!;
    });
  }

  failLocalRuntimeInstallation(input: FailLocalRuntimeInstallationInput): LocalRuntimeInstallationRecord {
    this.assertOpen();
    const scope = localRuntimeScope(input);
    const operationId = localRuntimeIdentity(input.operationId, "installation operation ID", 128);
    const state = input.state;
    if (state !== "failed" && state !== "cancelled") throw new StoreError("Local runtime installation failure state is invalid.");
    const publicErrorCode = localRuntimePublicErrorCode(input.publicErrorCode);
    const at = localRuntimeTimestamp(input.at ?? this.now(), "installation failure time");
    return this.localRuntimeWrite(() => {
      this.requireLocalRuntimeOwner(scope);
      const current = this.requireLocalRuntimeInstallation(scope, operationId, "installing");
      const failedAt = Math.max(at, current.heartbeatAt);
      this.database.prepare(`
        UPDATE local_runtime_installations SET
          state = ?, version = NULL, archive_sha256 = NULL,
          public_error_code = ?, heartbeat_at = ?, lease_expires_at = ?,
          updated_at = ?, revision = revision + 1
        WHERE owner_id = ? AND runtime_id = ?
          AND owner_generation = ? AND operation_id = ? AND state = 'installing'
      `).run(
        state, publicErrorCode, failedAt, failedAt, failedAt,
        scope.ownerId, scope.runtimeId, scope.ownerGeneration, operationId
      );
      return this.findLocalRuntimeInstallation(scope)!;
    });
  }

  findLocalRuntimeInstallation(scopeInput: LocalRuntimeOwnerScope): LocalRuntimeInstallationRecord | undefined {
    this.assertOpen();
    const scope = localRuntimeScope(scopeInput);
    const row = this.database.prepare(`
      SELECT * FROM local_runtime_installations
      WHERE owner_id = ? AND runtime_id = ? AND owner_generation = ?
    `).get(scope.ownerId, scope.runtimeId, scope.ownerGeneration) as Row | undefined;
    return row === undefined ? undefined : localRuntimeInstallationFromRow(row);
  }

  putLocalModelPullCheckpoint(input: PutLocalModelPullCheckpointInput): LocalModelPullCheckpointRecord {
    this.assertOpen();
    const scope = localRuntimeScope(input);
    const modelKey = localRuntimeModelIdentity(input.modelKey, "model key");
    const modelName = localRuntimeModelIdentity(input.modelName, "model name");
    const completedBytes = input.completedBytes === undefined ? undefined : localRuntimeCounter(input.completedBytes, "completed bytes", true);
    const totalBytes = input.totalBytes === undefined ? undefined : localRuntimeCounter(input.totalBytes, "total bytes", false);
    if (completedBytes !== undefined && totalBytes !== undefined && completedBytes > totalBytes) {
      throw new StoreError("Local model pull completion exceeds its total size.");
    }
    const percent = input.percent === undefined ? undefined : localRuntimePercent(input.percent);
    const digests = localRuntimeDigests(input.digests);
    const updatedAt = localRuntimeTimestamp(input.updatedAt ?? this.now(), "pull checkpoint time");
    return this.localRuntimeWrite(() => {
      this.requireLocalRuntimeOwner(scope);
      const existing = this.database.prepare(`
        SELECT 1 FROM local_model_pull_checkpoints
        WHERE owner_id = ? AND runtime_id = ? AND model_key = ?
      `).get(scope.ownerId, scope.runtimeId, modelKey) as Row | undefined;
      if (existing === undefined) {
        const count = this.database.prepare(`
          SELECT COUNT(*) AS count FROM local_model_pull_checkpoints
          WHERE owner_id = ? AND runtime_id = ?
        `).get(scope.ownerId, scope.runtimeId) as Row | undefined;
        if (numberValue(count?.["count"] ?? 0) >= 128) throw new StoreError("Local model pull checkpoint limit reached.");
      }
      this.database.prepare(`
        INSERT INTO local_model_pull_checkpoints(
          owner_id, runtime_id, owner_generation, model_key, model_name,
          completed_bytes, total_bytes, percent, digests_json, updated_at, revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(owner_id, runtime_id, model_key) DO UPDATE SET
          owner_generation = excluded.owner_generation,
          model_name = excluded.model_name,
          completed_bytes = excluded.completed_bytes,
          total_bytes = excluded.total_bytes,
          percent = excluded.percent,
          digests_json = excluded.digests_json,
          updated_at = excluded.updated_at,
          revision = local_model_pull_checkpoints.revision + 1
        WHERE excluded.updated_at >= local_model_pull_checkpoints.updated_at
      `).run(
        scope.ownerId, scope.runtimeId, scope.ownerGeneration, modelKey, modelName,
        completedBytes ?? null, totalBytes ?? null, percent ?? null,
        JSON.stringify(digests), updatedAt
      );
      return this.findLocalModelPullCheckpoint(scope, modelKey)!;
    });
  }

  findLocalModelPullCheckpoint(scopeInput: LocalRuntimeOwnerScope, modelKeyInput: string): LocalModelPullCheckpointRecord | undefined {
    this.assertOpen();
    const scope = localRuntimeScope(scopeInput);
    const modelKey = localRuntimeModelIdentity(modelKeyInput, "model key");
    const row = this.database.prepare(`
      SELECT * FROM local_model_pull_checkpoints
      WHERE owner_id = ? AND runtime_id = ? AND owner_generation = ? AND model_key = ?
    `).get(scope.ownerId, scope.runtimeId, scope.ownerGeneration, modelKey) as Row | undefined;
    return row === undefined ? undefined : localModelPullCheckpointFromRow(row);
  }

  listLocalModelPullCheckpoints(scopeInput: LocalRuntimeOwnerScope): LocalModelPullCheckpointRecord[] {
    this.assertOpen();
    const scope = localRuntimeScope(scopeInput);
    return (this.database.prepare(`
      SELECT * FROM local_model_pull_checkpoints
      WHERE owner_id = ? AND runtime_id = ? AND owner_generation = ?
      ORDER BY updated_at, model_key
    `).all(scope.ownerId, scope.runtimeId, scope.ownerGeneration) as Row[]).map(localModelPullCheckpointFromRow);
  }

  removeLocalModelPullCheckpoint(scopeInput: LocalRuntimeOwnerScope, modelKeyInput: string): LocalModelPullCheckpointRecord | undefined {
    this.assertOpen();
    const scope = localRuntimeScope(scopeInput);
    const modelKey = localRuntimeModelIdentity(modelKeyInput, "model key");
    return this.localRuntimeWrite(() => {
      this.requireLocalRuntimeOwner(scope);
      const current = this.findLocalModelPullCheckpoint(scope, modelKey);
      if (current === undefined) return undefined;
      this.database.prepare(`
        DELETE FROM local_model_pull_checkpoints
        WHERE owner_id = ? AND runtime_id = ? AND owner_generation = ? AND model_key = ?
      `).run(scope.ownerId, scope.runtimeId, scope.ownerGeneration, modelKey);
      return current;
    });
  }

  putLocalRuntimeProviderBinding(input: PutLocalRuntimeProviderBindingInput): LocalRuntimeProviderBindingRecord {
    this.assertOpen();
    const scope = localRuntimeScope(input);
    const providerId = localRuntimeIdentity(input.providerId, "Provider ID", 256);
    if (input.providerVersion < 1n) throw new StoreError("Local runtime Provider version is invalid.");
    const modelIds = localRuntimeModelIds(input.modelIds);
    const updatedAt = localRuntimeTimestamp(input.updatedAt ?? this.now(), "Provider binding time");
    return this.localRuntimeWrite(() => {
      this.requireLocalRuntimeOwner(scope);
      this.database.prepare(`
        INSERT INTO local_runtime_provider_bindings(
          owner_id, runtime_id, owner_generation, provider_id,
          provider_version, model_ids_json, updated_at, revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(owner_id, runtime_id) DO UPDATE SET
          owner_generation = excluded.owner_generation,
          provider_id = excluded.provider_id,
          provider_version = excluded.provider_version,
          model_ids_json = excluded.model_ids_json,
          updated_at = excluded.updated_at,
          revision = local_runtime_provider_bindings.revision + 1
      `).run(
        scope.ownerId, scope.runtimeId, scope.ownerGeneration, providerId,
        input.providerVersion.toString(10), JSON.stringify(modelIds), updatedAt
      );
      return this.findLocalRuntimeProviderBinding(scope)!;
    });
  }

  findLocalRuntimeProviderBinding(scopeInput: LocalRuntimeOwnerScope): LocalRuntimeProviderBindingRecord | undefined {
    this.assertOpen();
    const scope = localRuntimeScope(scopeInput);
    const row = this.database.prepare(`
      SELECT * FROM local_runtime_provider_bindings
      WHERE owner_id = ? AND runtime_id = ? AND owner_generation = ?
    `).get(scope.ownerId, scope.runtimeId, scope.ownerGeneration) as Row | undefined;
    return row === undefined ? undefined : localRuntimeProviderBindingFromRow(row);
  }

  removeLocalRuntimeProviderBinding(scopeInput: LocalRuntimeOwnerScope): LocalRuntimeProviderBindingRecord | undefined {
    this.assertOpen();
    const scope = localRuntimeScope(scopeInput);
    return this.localRuntimeWrite(() => {
      this.requireLocalRuntimeOwner(scope);
      const current = this.findLocalRuntimeProviderBinding(scope);
      if (current === undefined) return undefined;
      this.database.prepare(`
        DELETE FROM local_runtime_provider_bindings
        WHERE owner_id = ? AND runtime_id = ? AND owner_generation = ?
      `).run(scope.ownerId, scope.runtimeId, scope.ownerGeneration);
      return current;
    });
  }

  private requireLocalRuntimeOwner(scope: LocalRuntimeOwnerScope): LocalRuntimeOwnerRecord {
    const current = this.findLocalRuntimeOwner(scope.ownerId, scope.runtimeId);
    if (current === undefined) throw new NotFoundError("Local runtime owner", `${scope.ownerId}/${scope.runtimeId}`);
    if (current.ownerGeneration !== scope.ownerGeneration) {
      throw new StaleGenerationError(current.ownerGeneration, scope.ownerGeneration);
    }
    return current;
  }

  private requireLocalRuntimeInstallation(
    scope: LocalRuntimeOwnerScope,
    operationId: string,
    state: LocalRuntimeInstallationRecord["state"]
  ): LocalRuntimeInstallationRecord {
    const current = this.findLocalRuntimeInstallation(scope);
    if (current === undefined) throw new NotFoundError("Local runtime installation", operationId);
    if (current.operationId !== operationId) throw new OperationInProgressError(current.operationId);
    if (current.state !== state) throw new InvalidStateTransitionError("local runtime installation", current.state, state);
    return current;
  }

  /** High-frequency internal checkpoints and leases do not invalidate public
   * Store snapshots; each row carries its own monotonic revision. */
  private localRuntimeWrite<T>(callback: () => T): T {
    this.assertOpen();
    if (this.transactionFrames.length !== 0) return callback();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      if (isPromiseLike(result)) throw new AsyncTransactionError();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  /** Scheduler heartbeats are fencing metadata, not public logical state. They
   * need an atomic commit without advancing the global content revision on
   * every 15-second touch (which would invalidate unrelated read cursors). */
  private schedulerRuntimeWrite<T>(callback: () => T): T {
    this.assertOpen();
    if (this.transactionFrames.length !== 0) return callback();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      if (isPromiseLike(result)) throw new AsyncTransactionError();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private readConsistent<T>(callback: () => T): T {
    this.assertOpen();
    if (this.transactionFrames.length !== 0) return callback();
    this.database.exec("BEGIN DEFERRED");
    try {
      const result = callback();
      if (isPromiseLike(result)) throw new AsyncTransactionError();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private readRevision(): bigint {
    const row = this.database.prepare(
      "SELECT revision FROM store_meta WHERE singleton = 1"
    ).get() as Row | undefined;
    if (row === undefined) throw new StoreError("Operational store revision row is missing.");
    return toBigInt(row["revision"]);
  }

  private latestEventCursor(): bigint {
    const row = this.database.prepare(
      "SELECT COALESCE(MAX(global_cursor), 0) AS cursor FROM events"
    ).get() as Row | undefined;
    return toBigInt(row?.["cursor"] ?? 0);
  }

  private requireActiveRevision(): bigint {
    if (this.activeRevision === undefined) {
      throw new StoreError("A write was attempted outside an operational store transaction.");
    }
    return this.activeRevision;
  }

  private currentFrame(): TransactionFrame {
    const frame = this.transactionFrames.at(-1);
    if (frame === undefined) throw new StoreError("An event was appended outside a transaction.");
    return frame;
  }

  private publishCommitted(events: readonly PersistedEvent[]): void {
    this.pendingPublications.push(...events);
    if (this.publishing) return;
    this.publishing = true;
    try {
      for (;;) {
        const event = this.pendingPublications.shift();
        if (event === undefined) break;
        for (const subscriber of [...this.subscribers]) {
          try {
            const result = subscriber(event);
            if (isPromiseLike(result)) void Promise.resolve(result).catch(() => undefined);
          } catch {
            // Subscribers observe committed state and cannot roll it back.
          }
        }
      }
    } finally {
      this.publishing = false;
    }
  }

  private publishCommittedOperationChanges(operationIds: readonly string[]): void {
    for (const operationId of new Set(operationIds)) {
      for (const subscriber of [...this.operationSubscribers]) {
        try {
          subscriber(operationId);
        } catch {
          // Subscribers observe committed state and cannot roll it back.
        }
      }
    }
  }

  private reopenDatabase(): void {
    const database = new DatabaseSync(this.filePath, { allowExtension: true });
    let messageVectorAvailable = false;
    try {
      try {
        sqliteVec.load(database);
        messageVectorAvailable = true;
      } catch {
        // Semantic vector search remains optional after database replacement.
      } finally {
        database.enableLoadExtension(false);
      }
      configureDatabase(database);
      initializeDatabase(database, this.now());
      if (messageVectorAvailable) {
        database.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${MESSAGE_SEARCH_VECTOR_TABLE}
          USING vec0(
            event_cursor INTEGER,
            session_id TEXT,
            target_id TEXT,
            provider_id TEXT,
            provider_generation_id TEXT,
            model_id TEXT,
            live INTEGER,
            embedding float[${MESSAGE_SEARCH_VECTOR_DIMENSIONS}] distance_metric=cosine
          )`);
      }
      verifyOpenOperationalDatabase(database);
    } catch (error) {
      database.close();
      throw error;
    }
    this.database = database;
    this.messageVectorAvailable = messageVectorAvailable;
    this.closed = false;
  }

  private assertOpen(): void {
    if (this.closed) throw new StoreClosedError();
  }

  private assertDerivedIndexWorkerBoundary(): void {
    if (this.transactionFrames.length !== 0) {
      throw new StoreError("Message embedding worker operations cannot run inside a product transaction.");
    }
  }

}

interface HistoryMaintenancePaths {
  readonly work: string;
  readonly rollback: string;
  readonly marker: string;
  readonly backup: string;
  readonly previousBackup: string;
}

function historyMaintenancePaths(databasePath: string): HistoryMaintenancePaths {
  return {
    work: `${databasePath}.history-maintenance.work`,
    rollback: `${databasePath}.history-maintenance.rollback`,
    marker: `${databasePath}.history-maintenance.json`,
    backup: `${databasePath}.history-backup`,
    previousBackup: `${databasePath}.history-backup.previous`
  };
}

function recoverInterruptedHistoryMaintenance(databasePath: string): void {
  const paths = historyMaintenancePaths(databasePath);
  if (!existsSync(paths.marker) && !existsSync(paths.rollback)) return;
  const marker = readMaintenanceMarker(paths.marker);
  const primaryValid = existsSync(databasePath) && verifyOperationalDatabaseFile(databasePath);
  const rollbackValid = existsSync(paths.rollback) && verifyOperationalDatabaseFile(paths.rollback);

  if (!primaryValid && rollbackValid) {
    removeDatabaseFamily(databasePath);
    renameSync(paths.rollback, databasePath);
  } else if (!primaryValid && existsSync(databasePath)) {
    throw new StoreError("The operational database is invalid and no verified maintenance rollback is available.");
  }

  const recoveredPrimaryValid = existsSync(databasePath) && verifyOperationalDatabaseFile(databasePath);
  if (!recoveredPrimaryValid) {
    // A new data directory has no database yet. Only stale work files are safe
    // to remove; initialization will create the primary database below.
    if (!existsSync(databasePath)) {
      rmSync(paths.work, { force: true });
      rmSync(paths.marker, { force: true });
      return;
    }
    throw new StoreError("The operational database failed startup integrity validation.");
  }

  if (existsSync(paths.rollback)) {
    if (marker?.backupEnabled === true) {
      if (existsSync(paths.backup)) rmSync(paths.backup, { force: true });
      renameSync(paths.rollback, paths.backup);
      restrictMaintenanceFile(paths.backup);
    } else {
      rmSync(paths.rollback, { force: true });
    }
  }
  if (!existsSync(paths.backup) && existsSync(paths.previousBackup)) {
    renameSync(paths.previousBackup, paths.backup);
  } else {
    rmSync(paths.previousBackup, { force: true });
  }
  rmSync(paths.work, { force: true });
  rmSync(paths.marker, { force: true });
}

function readMaintenanceMarker(markerPath: string): { readonly backupEnabled: boolean } | undefined {
  if (!existsSync(markerPath)) return undefined;
  try {
    const value = JSON.parse(readFileSync(markerPath, "utf8")) as Record<string, unknown>;
    if (value["version"] !== 1 || typeof value["backupEnabled"] !== "boolean") return undefined;
    return { backupEnabled: value["backupEnabled"] };
  } catch {
    return undefined;
  }
}

function writeMaintenanceMarker(
  markerPath: string,
  value: { readonly version: 1; readonly backupEnabled: boolean; readonly preparedAt: number }
): void {
  const temporaryPath = `${markerPath}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "w",
    flush: true
  });
  rmSync(markerPath, { force: true });
  renameSync(temporaryPath, markerPath);
  restrictMaintenanceFile(markerPath);
}

function verifyOperationalDatabaseFile(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  let database: DatabaseSync | undefined;
  try {
    if (!statSync(filePath).isFile()) return false;
    database = new DatabaseSync(filePath, { readOnly: true, allowExtension: true });
    try { sqliteVec.load(database); } catch { /* The vector index is optional. */ }
    finally { database.enableLoadExtension(false); }
    verifyOpenOperationalDatabase(database);
    return true;
  } catch {
    return false;
  } finally {
    database?.close();
  }
}

function verifyOpenOperationalDatabase(database: DatabaseSync): void {
  const quick = database.prepare("PRAGMA quick_check").all() as Row[];
  if (quick.length !== 1 || String(quick[0]?.["quick_check"] ?? "") !== "ok") {
    throw new StoreError("Operational database quick check failed.");
  }
  const foreignKeys = database.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeys.length !== 0) throw new StoreError("Operational database foreign-key check failed.");
}

function removeSqliteSidecars(databasePath: string): void {
  rmSync(`${databasePath}-wal`, { force: true });
  rmSync(`${databasePath}-shm`, { force: true });
}

function removeDatabaseFamily(databasePath: string): void {
  rmSync(databasePath, { force: true });
  removeSqliteSidecars(databasePath);
}

function restrictMaintenanceFile(filePath: string): void {
  try { chmodSync(filePath, 0o600); } catch { /* Windows ACLs remain authoritative. */ }
}

function normalizeMessageSearchQuery(value: string): string {
  if (typeof value !== "string") throw new StoreError("Message search query must be text.");
  const query = redactSecrets(value).replace(/\0/gu, " ").trim();
  const length = [...query].length;
  if (length === 0) throw new StoreError("Message search query must not be blank.");
  if (length > MAX_MESSAGE_SEARCH_QUERY_LENGTH) {
    throw new StoreError(`Message search query exceeds ${MAX_MESSAGE_SEARCH_QUERY_LENGTH} characters.`);
  }
  return query;
}

function normalizeDerivedIndexErrorCode(value: string): string {
  const normalized = value.trim().toLocaleUpperCase("en-US");
  if (!/^[A-Z0-9_]{1,64}$/u.test(normalized)) return "EMBEDDING_FAILED";
  return normalized;
}

function normalizeMessageSearchLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_MESSAGE_SEARCH_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_MESSAGE_SEARCH_LIMIT) {
    throw new StoreError(`Message search limit must be between 1 and ${MAX_MESSAGE_SEARCH_LIMIT}.`);
  }
  return limit;
}

function normalizeMessageSearchFilters(
  value: SearchSessionMessagesInput["filters"]
): NormalizedMessageSearchFilters {
  const normalizeIds = (values: readonly string[] | undefined, label: string): readonly string[] | undefined => {
    if (values === undefined) return undefined;
    if (!Array.isArray(values) || values.length > MAX_MESSAGE_SEARCH_FILTER_VALUES) {
      throw new StoreError(
        `${label} must contain at most ${MAX_MESSAGE_SEARCH_FILTER_VALUES} opaque identifiers.`
      );
    }
    return [...new Set(values.map((item) => durableOpaqueId(item, label)))]
      .sort((left, right) => left.localeCompare(right, "en"));
  };
  const timestamp = (item: number | undefined, label: string): number | undefined => {
    if (item === undefined) return undefined;
    if (!Number.isSafeInteger(item)) throw new StoreError(`${label} must be an integer Unix timestamp.`);
    return item;
  };
  const sessionStatus = value?.sessionStatus;
  if (sessionStatus !== undefined && sessionStatus !== "active" && sessionStatus !== "archived") {
    throw new StoreError("Message-search Session status filter is unsupported.");
  }
  const sessionActivityFrom = timestamp(value?.sessionActivityFrom, "Message-search Session activity cutoff");
  const messageCreatedFrom = timestamp(value?.messageCreatedFrom, "Message-search message start time");
  const messageCreatedBefore = timestamp(value?.messageCreatedBefore, "Message-search message end time");
  return {
    targetIds: normalizeIds(value?.targetIds, "Message-search Target filter"),
    sessionIds: normalizeIds(value?.sessionIds, "Message-search Session filter"),
    backendIds: normalizeIds(value?.backendIds, "Message-search Backend filter"),
    ...(sessionStatus === undefined ? {} : { sessionStatus }),
    ...(sessionActivityFrom === undefined ? {} : { sessionActivityFrom }),
    ...(messageCreatedFrom === undefined ? {} : { messageCreatedFrom }),
    ...(messageCreatedBefore === undefined ? {} : { messageCreatedBefore })
  };
}

function messageSearchStructuredFilterSql(
  filters: NormalizedMessageSearchFilters,
  eventAlias: string,
  sessionAlias: string
): { readonly clause: string; readonly params: readonly (string | number)[] } {
  const conditions: string[] = [];
  const params: Array<string | number> = [];
  const inList = (column: string, values: readonly string[] | undefined): void => {
    if (values === undefined) return;
    if (values.length === 0) {
      conditions.push("1 = 0");
      return;
    }
    conditions.push(`${column} IN (${values.map(() => "?").join(",")})`);
    params.push(...values);
  };
  inList(`${eventAlias}.target_id`, filters.targetIds);
  inList(`${eventAlias}.session_id`, filters.sessionIds);
  inList(`${sessionAlias}.backend_id`, filters.backendIds);
  if (filters.sessionStatus !== undefined) {
    conditions.push(`${sessionAlias}.archived = ?`);
    params.push(filters.sessionStatus === "archived" ? 1 : 0);
  }
  if (filters.sessionActivityFrom !== undefined) {
    conditions.push(`${sessionAlias}.updated_at >= ?`);
    params.push(filters.sessionActivityFrom);
  }
  if (filters.messageCreatedFrom !== undefined) {
    conditions.push(`${eventAlias}.emitted_at >= ?`);
    params.push(filters.messageCreatedFrom);
  }
  if (filters.messageCreatedBefore !== undefined) {
    conditions.push(`${eventAlias}.emitted_at < ?`);
    params.push(filters.messageCreatedBefore);
  }
  return {
    clause: conditions.length === 0 ? "" : ` AND ${conditions.join(" AND ")}`,
    params
  };
}

function hasMessageSearchStructuredFilters(filters: NormalizedMessageSearchFilters): boolean {
  return filters.targetIds !== undefined || filters.sessionIds !== undefined || filters.backendIds !== undefined
    || filters.sessionStatus !== undefined || filters.sessionActivityFrom !== undefined
    || filters.messageCreatedFrom !== undefined || filters.messageCreatedBefore !== undefined;
}

function normalizeMessageSearchSemantic(
  value: SearchSessionMessagesInput["semantic"],
  vectorAvailable: boolean
): NormalizedMessageSearchSemantic | undefined {
  if (value === undefined || !vectorAvailable) return undefined;
  const providerId = nonBlank(value.providerId, "Message embedding Provider ID");
  const providerGenerationId = nonBlank(
    value.providerGenerationId,
    "Message embedding Provider generation ID"
  );
  const modelId = normalizedEmbeddingModelIdentity(value.modelId);
  if (
    value.queryEmbedding.length !== MESSAGE_SEARCH_VECTOR_DIMENSIONS ||
    value.queryEmbedding.some((item) =>
      typeof item !== "number" || !Number.isFinite(item) || !Number.isFinite(Math.fround(item))
    )
  ) {
    throw new StoreError(`Message-search query embedding must contain ${MESSAGE_SEARCH_VECTOR_DIMENSIONS} finite values.`);
  }
  const requestedPool = value.poolLimit ?? MESSAGE_SEARCH_VECTOR_POOL;
  if (!Number.isSafeInteger(requestedPool) || requestedPool < 1) {
    throw new StoreError("Message-search vector pool limit must be a positive integer.");
  }
  return {
    providerId,
    providerGenerationId,
    modelId,
    queryEmbedding: value.queryEmbedding,
    poolLimit: Math.min(requestedPool, MESSAGE_SEARCH_VECTOR_POOL_MAX)
  };
}

function normalizeMessageSearchRetrieval(
  providerId: string | undefined,
  providerGenerationId: string | undefined,
  modelId: string | undefined
): string {
  if (providerId === undefined && providerGenerationId === undefined && modelId === undefined) {
    return "keyword";
  }
  if (providerId === undefined || providerGenerationId === undefined || modelId === undefined) {
    throw new StoreError(
      "Message-search retrieval Provider, Provider generation, and model must be selected together."
    );
  }
  return `hybrid:${nonBlank(providerId, "Message embedding Provider ID")}:` +
    `${nonBlank(providerGenerationId, "Message embedding Provider generation ID")}:` +
    `${nonBlank(modelId, "Message embedding model ID")}`;
}

function normalizedEmbeddingModelIdentity(value: string): string {
  const normalized = nonBlank(value, "Message embedding model ID");
  if (
    [...normalized].length > 512 || /[\u0000-\u001f\u007f]/u.test(normalized) ||
    redactSecrets(normalized) !== normalized
  ) {
    throw new StoreError("Message embedding model ID is malformed.");
  }
  return normalized;
}

function normalizeMessageSearchSkipReason(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const reason = redactSecrets(value).replace(/[\r\n\t]+/gu, " ").trim().slice(0, 240);
  return reason === "" ? undefined : reason;
}

function messageSearchQueryHash(
  scopeKind: MessageSearchCursor["scopeKind"],
  scopeId: string,
  query: string,
  retrieval: string,
  filters: NormalizedMessageSearchFilters
): string {
  const filterFingerprint = JSON.stringify([
    filters.targetIds ?? null,
    filters.sessionIds ?? null,
    filters.backendIds ?? null,
    filters.sessionStatus ?? null,
    filters.sessionActivityFrom ?? null,
    filters.messageCreatedFrom ?? null,
    filters.messageCreatedBefore ?? null
  ]);
  return createHash("sha256")
    .update(`${scopeKind}\0${scopeId}\0${retrieval}\0${filterFingerprint}\0${query}`)
    .digest("hex");
}

function fuseMessageSearchRanks(
  fts: readonly MessageSearchRankCandidate[],
  vector: readonly MessageSearchRankCandidate[]
): readonly FusedMessageSearchRank[] {
  const ranks = new Map<string, {
    readonly identityKey: string;
    eventCursor: bigint;
    score: number;
    ftsRank?: number;
    vectorRank?: number;
  }>();
  const add = (candidate: MessageSearchRankCandidate, rank: number, arm: "fts" | "vector"): void => {
    const key = messageSearchIdentityKey(candidate.sessionId, candidate.timelineItemId);
    const current = ranks.get(key) ?? {
      identityKey: key,
      eventCursor: candidate.eventCursor,
      score: 0
    };
    current.score += 1 / (MESSAGE_SEARCH_RRF_K + rank);
    if (arm === "fts") {
      current.ftsRank = rank;
      current.eventCursor = candidate.eventCursor;
    } else {
      current.vectorRank = rank;
    }
    ranks.set(key, current);
  };
  fts.forEach((candidate, index) => add(candidate, index + 1, "fts"));
  vector.forEach((candidate, index) => add(candidate, index + 1, "vector"));
  const maximum = 2 / (MESSAGE_SEARCH_RRF_K + 1);
  return [...ranks.values()]
    .map((entry) => ({ ...entry, score: Math.min(1, entry.score / maximum) }))
    .sort((left, right) =>
      right.score - left.score ||
      Number(right.eventCursor - left.eventCursor) ||
      left.eventCursor.toString(10).localeCompare(right.eventCursor.toString(10), "en")
    );
}

function messageSearchRankCandidateFromRow(row: Row): MessageSearchRankCandidate {
  return {
    eventCursor: toBigInt(row["global_cursor"]),
    sessionId: String(row["session_id"]),
    timelineItemId: String(row["timeline_item_id"])
  };
}

function messageSearchIdentityKey(sessionId: string, timelineItemId: string): string {
  return JSON.stringify([sessionId, timelineItemId]);
}

function fairMessageSearchRows(
  values: readonly { readonly row: Row; readonly rank: FusedMessageSearchRank }[]
): readonly { readonly row: Row; readonly rank: FusedMessageSearchRank }[] {
  const bySession = new Map<string, Array<{ readonly row: Row; readonly rank: FusedMessageSearchRank }>>();
  for (const value of values) {
    const sessionId = String(value.row["session_id"]);
    const bucket = bySession.get(sessionId) ?? [];
    bucket.push(value);
    bySession.set(sessionId, bucket);
  }
  const compare = (
    left: { readonly row: Row; readonly rank: FusedMessageSearchRank },
    right: { readonly row: Row; readonly rank: FusedMessageSearchRank }
  ): number => right.rank.score - left.rank.score ||
    Number(toBigInt(right.row["global_cursor"]) - toBigInt(left.row["global_cursor"])) ||
    String(left.row["event_id"]).localeCompare(String(right.row["event_id"]), "en");
  for (const bucket of bySession.values()) bucket.sort(compare);
  const sessions = [...bySession.entries()].sort((left, right) => {
    const compared = compare(left[1][0]!, right[1][0]!);
    return compared || left[0].localeCompare(right[0], "en");
  });
  const result: Array<{ readonly row: Row; readonly rank: FusedMessageSearchRank }> = [];
  for (let hitRank = 0; result.length < values.length; hitRank += 1) {
    let found = false;
    for (const [, bucket] of sessions) {
      const value = bucket[hitRank];
      if (value === undefined) continue;
      found = true;
      result.push(value);
    }
    if (!found) break;
  }
  return result;
}

function nativeBindingFingerprint(opaqueReference: string): string {
  return `sha256:${createHash("sha256").update(nativeBindingReference(opaqueReference)).digest("hex")}`;
}

function nativeBindingFingerprintIsValid(value: string): boolean {
  return /^sha256:[a-f0-9]{64}$/u.test(value);
}

function nativeBindingReference(value: string): string {
  if (value.trim() === "" || value.length > 32_768 || value.includes("\0")) {
    throw new StoreError("Native binding reference is invalid.");
  }
  return value;
}

function nativeHistoryIdentityText(value: string, label: string): string {
  if (value.trim() === "" || value.length > 4_096 || value.includes("\0")) {
    throw new StoreError(`Native history ${label} is invalid.`);
  }
  return value;
}

function encodeMessageSearchCursor(cursor: MessageSearchCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeMessageSearchCursor(token: string): MessageSearchCursor {
  if (
    token.length === 0 ||
    token.length > MAX_MESSAGE_SEARCH_PAGE_TOKEN_LENGTH ||
    !/^[A-Za-z0-9_-]+$/u.test(token)
  ) {
    throw new StoreError("Message search page token is malformed.");
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch (error) {
    throw new StoreError("Message search page token is malformed.", { cause: error });
  }
  if (!isRecord(value)) throw new StoreError("Message search page token is malformed.");
  const scopeKind = value["scopeKind"];
  const scopeId = value["scopeId"];
  const queryHash = value["queryHash"];
  const vectorFingerprint = value["vectorFingerprint"];
  const highWater = value["highWater"];
  const revision = value["revision"];
  const offset = value["offset"];
  if (
    value["v"] !== 1 ||
    (scopeKind !== "owner" && scopeKind !== "session" && scopeKind !== "target") ||
    typeof scopeId !== "string" || scopeId.length > 512 ||
    typeof queryHash !== "string" || !/^[a-f0-9]{64}$/u.test(queryHash) ||
    typeof vectorFingerprint !== "string" ||
      (vectorFingerprint !== "" && !/^[a-f0-9]{64}$/u.test(vectorFingerprint)) ||
    typeof highWater !== "string" || !/^(?:0|[1-9]\d*)$/u.test(highWater) ||
    typeof revision !== "string" || !/^(?:0|[1-9]\d*)$/u.test(revision) ||
    typeof offset !== "number" || !Number.isSafeInteger(offset) ||
    offset < 0 || offset > MAX_MESSAGE_SEARCH_OFFSET
  ) {
    throw new StoreError("Message search page token is malformed.");
  }
  return { v: 1, scopeKind, scopeId, queryHash, vectorFingerprint, highWater, revision, offset };
}

function messageSearchVectorFingerprint(semantic: NormalizedMessageSearchSemantic): string {
  const bytes = Buffer.allocUnsafe(semantic.queryEmbedding.length * 4);
  semantic.queryEmbedding.forEach((value, index) => bytes.writeFloatLE(Math.fround(value), index * 4));
  return createHash("sha256")
    .update(
      `${semantic.providerId}\0${semantic.providerGenerationId}\0` +
      `${semantic.modelId}\0${semantic.poolLimit}\0`
    )
    .update(bytes)
    .digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function messageSearchTokens(query: string): readonly string[] {
  return [...new Set(query.match(/[\p{L}\p{N}]+/gu) ?? [])].slice(0, MAX_MESSAGE_SEARCH_TOKENS);
}

function messageSearchFtsMatch(tokens: readonly string[]): string {
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ");
}

function makerMemoryKind(value: unknown): MakerMemoryKind {
  if (value === "user" || value === "feedback" || value === "project" || value === "reference" || value === "digest") {
    return value;
  }
  throw new StoreError("Memory kind is invalid.");
}

function makerMemoryBackendId(value: string): string {
  const id = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(id)) {
    throw new StoreError("Memory Backend ID is invalid.");
  }
  return id;
}

function normalizeMakerMemorySlug(value: string): string {
  const slug = value.trim().toLocaleLowerCase("en");
  if (!/^[a-z0-9_-]{1,64}$/u.test(slug)) {
    throw new StoreError("Memory slug must contain 1 through 64 lowercase ASCII letters, digits, underscores, or hyphens.");
  }
  return slug;
}

function boundedPrivateMemoryText(value: string, label: string, maximumBytes: number, multiline: boolean): string {
  if (typeof value !== "string" || value.includes("\0")) throw new StoreError(`${label} is invalid.`);
  const normalized = multiline ? value.trim() : value.trim().replace(/[\t ]+/gu, " ");
  if (normalized.length === 0 || Buffer.byteLength(normalized, "utf8") > maximumBytes) {
    throw new StoreError(`${label} exceeds its private storage boundary.`);
  }
  // Memory is long-lived and injected into future model contexts. Reject a
  // write if the common credential scrubber would alter it; never persist the
  // original secret-like bytes and never include them in the error.
  if (redactSecrets(normalized) !== normalized) {
    throw new StoreError(`${label} contains credential-like content and was not stored.`);
  }
  return normalized;
}

function escapeLikePattern(query: string): string {
  return query.replace(/[\\%_]/gu, (character) => `\\${character}`);
}

function visibleMessageText(payload: EventPayload): string | undefined {
  if (payload.type === "message_complete" && payload.automaticContinuation !== undefined) return undefined;
  let parts: readonly string[];
  if (payload.type === "message_complete" && (payload.role === "user" || payload.role === "assistant")) {
    parts = payload.blocks.flatMap((block) =>
      block.kind === "text" && block.text.trim() !== "" ? [block.text] : []
    );
  } else if (payload.type === "interaction_opened" && payload.interaction.kind === "question") {
    parts = [
      payload.interaction.prompt,
      ...payload.interaction.fields.flatMap((field) => [
        field.label,
        ...(field.description === undefined ? [] : [field.description])
      ])
    ];
  } else if (payload.type === "interaction_opened" && payload.interaction.kind === "plan_review") {
    parts = [payload.interaction.markdown];
  } else {
    return undefined;
  }
  const visible = parts
    .filter((part) => part.trim() !== "")
    .map((part) => redactSecrets(part))
    .join("\n")
    .trim();
  return visible === "" ? undefined : visible;
}

function visibleMessageSnippet(text: string, tokens: readonly string[]): string {
  const visible = redactSecrets(text).replace(/\s+/gu, " ").trim();
  const folded = visible.toLocaleLowerCase("en");
  let match = -1;
  let matchedLength = 0;
  for (const token of tokens) {
    const index = folded.indexOf(token.toLocaleLowerCase("en"));
    if (index >= 0 && (match < 0 || index < match)) {
      match = index;
      matchedLength = token.length;
    }
  }
  const start = Math.max(0, (match < 0 ? 0 : match) - Math.floor(MESSAGE_SEARCH_SNIPPET_LENGTH / 4));
  const end = Math.min(
    visible.length,
    Math.max(start + MESSAGE_SEARCH_SNIPPET_LENGTH, match + matchedLength)
  );
  return `${start > 0 ? "…" : ""}${visible.slice(start, end)}${end < visible.length ? "…" : ""}`;
}

function connectionFromRow(row: Row): ConnectionRecord {
  return {
    id: stringValue(row["id"]),
    deviceId: stringValue(row["device_id"]),
    name: stringValue(row["name"]),
    authKeyDigest: stringValue(row["auth_key_digest"]),
    state: enumValue(row["state"], ["active", "revoked"] as const),
    pairedAt: numberValue(row["paired_at"]),
    ...optionalNumber("lastSeenAt", row["last_seen_at"]),
    ...optionalNumber("revokedAt", row["revoked_at"]),
    revision: toBigInt(row["revision"])
  };
}

function deviceFromRow(row: Row): DeviceRecord {
  return {
    id: stringValue(row["id"]),
    name: stringValue(row["name"]),
    kind: enumValue(row["kind"], ["unspecified", "web", "desktop", "service"] as const),
    platform: stringValue(row["platform"]),
    appVersion: stringValue(row["app_version"]),
    state: enumValue(row["state"], ["active", "revoked"] as const),
    remoteControlEnabled: booleanValue(row["remote_control_enabled"]),
    pairedAt: numberValue(row["paired_at"]),
    ...optionalNumber("lastSeenAt", row["last_seen_at"]),
    ...optionalNumber("revokedAt", row["revoked_at"]),
    revision: toBigInt(row["revision"])
  };
}

function pairingFromRow(row: Row): PairingRecord {
  const deviceId = optionalString("deviceId", row["device_id"]).deviceId;
  const deviceName = optionalString("deviceName", row["device_name"]).deviceName;
  const deviceKind = optionalString("deviceKind", row["device_kind"]).deviceKind;
  const devicePlatform = optionalString("devicePlatform", row["device_platform"]).devicePlatform;
  const deviceAppVersion = optionalString("deviceAppVersion", row["device_app_version"]).deviceAppVersion;
  const deviceFields = [deviceId, deviceName, deviceKind, devicePlatform, deviceAppVersion];
  if (deviceFields.some((value) => value === undefined) && deviceFields.some((value) => value !== undefined)) {
    throw new StoreError("Stored Pairing Device metadata is incomplete.");
  }
  return {
    id: stringValue(row["id"]),
    codeDigest: stringValue(row["code_digest"]),
    ...optionalString("label", row["label"]),
    ...(deviceId === undefined ? {} : {
      device: {
        id: deviceId,
        name: deviceName!,
        kind: enumValue(deviceKind, ["unspecified", "web", "desktop", "service"] as const),
        platform: devicePlatform!,
        appVersion: deviceAppVersion!
      }
    }),
    expiresAt: numberValue(row["expires_at"]),
    ...optionalNumber("consumedAt", row["consumed_at"]),
    ...optionalString("consumedConnectionId", row["consumed_connection_id"]),
    createdAt: numberValue(row["created_at"]),
    revision: toBigInt(row["revision"])
  };
}

function normalizedBackendAdapterKind(value: string): string {
  if (value.trim() === "" || value !== value.trim() || [...value].length > 256) {
    throw new StoreError("Backend Adapter kind must be a non-empty normalized string.");
  }
  return value;
}

function validateOptionalBackendGeneration(value: number | undefined, label: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new StoreError(`Backend ${label} must be a non-negative safe integer.`);
  }
}

function validateBackendDescriptorAuthority(descriptor: BackendDescriptor): void {
  nonBlank(descriptor.id, "Backend ID");
  normalizedBackendAdapterKind(descriptor.adapterKind);
  if (!Number.isSafeInteger(descriptor.instanceGeneration) || descriptor.instanceGeneration < 0) {
    throw new StoreError("Backend instance generation must be a non-negative safe integer.");
  }
}

function writeBackendDescriptorRow(
  database: DatabaseSync,
  descriptor: BackendDescriptor,
  now: number,
  revision: number | bigint
): void {
  const capabilities = [...descriptor.capabilities.entries()];
  database.prepare(`
    INSERT INTO backends(
      id, adapter_kind, instance_generation, display_name, version, health,
      installation_state, authentication_state, error_json,
      capabilities_json, providers_json, models_json, tools_json, diagnostics_json, created_at, updated_at, revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      adapter_kind = excluded.adapter_kind,
      instance_generation = excluded.instance_generation,
      display_name = excluded.display_name,
      version = excluded.version,
      health = excluded.health,
      installation_state = excluded.installation_state,
      authentication_state = excluded.authentication_state,
      error_json = excluded.error_json,
      capabilities_json = excluded.capabilities_json,
      providers_json = excluded.providers_json,
      models_json = excluded.models_json,
      tools_json = excluded.tools_json,
      diagnostics_json = excluded.diagnostics_json,
      updated_at = excluded.updated_at,
      revision = excluded.revision
  `).run(
    descriptor.id,
    descriptor.adapterKind,
    descriptor.instanceGeneration,
    descriptor.displayName,
    descriptor.version,
    descriptor.health,
    descriptor.installationState,
    descriptor.authenticationState,
    descriptor.error === undefined ? null : serializeJson(descriptor.error),
    serializeJson(capabilities),
    serializeJson(descriptor.providers ?? []),
    serializeJson(descriptor.models),
    serializeJson(descriptor.tools),
    serializeJson(descriptor.diagnostics),
    now,
    now,
    revision
  );
}

function backendInstanceGenerationAuthorityFromRow(row: Row): BackendInstanceGenerationAuthority {
  return {
    backendId: stringValue(row["backend_id"]),
    adapterKind: stringValue(row["adapter_kind"]),
    highWaterGeneration: numberValue(row["high_water_generation"]),
    ...optionalNumber("currentGeneration", row["current_generation"]),
    createdAt: numberValue(row["created_at"]),
    updatedAt: numberValue(row["updated_at"]),
    revision: toBigInt(row["revision"])
  };
}

function staleBackendDescriptorPublication(
  authority: BackendInstanceGenerationAuthority,
  current: StoredBackend | undefined
): BackendDescriptorPublication {
  return {
    status: "stale",
    ...(current === undefined ? {} : { current }),
    authority
  };
}

function backendFromRow(row: Row): StoredBackend {
  const entries = parseJson<readonly (readonly [string, Capability])[]>(stringValue(row["capabilities_json"]));
  return {
    descriptor: {
      id: stringValue(row["id"]),
      adapterKind: stringValue(row["adapter_kind"]),
      instanceGeneration: numberValue(row["instance_generation"]),
      displayName: stringValue(row["display_name"]),
      version: stringValue(row["version"]),
      health: enumValue(row["health"], ["healthy", "degraded", "unavailable"] as const),
      installationState: enumValue(row["installation_state"], ["not_installed", "installing", "installed", "update_available", "error"] as const),
      authenticationState: enumValue(row["authentication_state"], ["not_required", "signed_out", "pending", "authenticated", "expired", "refreshing", "error"] as const),
      ...(row["error_json"] === null ? {} : { error: parseJson<NonNullable<BackendDescriptor["error"]>>(stringValue(row["error_json"])) }),
      capabilities: new Map(entries),
      providers: parseJson<NonNullable<BackendDescriptor["providers"]>>(stringValue(row["providers_json"])),
      models: parseJson<BackendDescriptor["models"]>(stringValue(row["models_json"])),
      tools: parseJson<BackendDescriptor["tools"]>(stringValue(row["tools_json"])),
      diagnostics: parseJson<BackendDescriptor["diagnostics"]>(stringValue(row["diagnostics_json"]))
    },
    createdAt: numberValue(row["created_at"]),
    updatedAt: numberValue(row["updated_at"]),
    revision: toBigInt(row["revision"])
  };
}

function targetFromRow(row: Row): StoredTarget {
  const remoteHostId = optionalString("hostId", row["remote_host_id"]).hostId;
  const remoteRoot = optionalString("workspaceRoot", row["remote_workspace_root"]).workspaceRoot;
  if ((remoteHostId === undefined) !== (remoteRoot === undefined)) {
    throw new StoreError("Stored Target Remote workspace binding is incomplete.");
  }
  return {
    descriptor: {
      id: stringValue(row["id"]),
      backendId: stringValue(row["backend_id"]),
      displayName: stringValue(row["display_name"]),
      workspaceRoot: stringValue(row["workspace_root"]),
      managed: booleanValue(row["managed"]),
      trusted: booleanValue(row["trusted"]),
      ...(remoteHostId === undefined || remoteRoot === undefined
        ? {}
        : {
            remoteWorkspace: {
              hostId: remoteHostAlias(remoteHostId),
              workspaceRoot: remoteWorkspaceRoot(remoteRoot)
            }
          })
    },
    metadata: parseJson(stringValue(row["metadata_json"])),
    createdAt: numberValue(row["created_at"]),
    updatedAt: numberValue(row["updated_at"]),
    revision: toBigInt(row["revision"])
  };
}

function deviceControlRelationFromRow(row: Row): DeviceControlRelationRecord {
  return {
    controllerDeviceId: stringValue(row["controller_device_id"]),
    targetDeviceId: stringValue(row["target_device_id"]),
    outboundEnabled: booleanValue(row["outbound_enabled"]),
    inboundAllowed: booleanValue(row["inbound_allowed"]),
    updatedAt: numberValue(row["updated_at"]),
    revision: toBigInt(row["revision"])
  };
}

function remoteHostFromRow(row: Row): RemoteHostRecord {
  const state = enumValue(
    row["status"],
    ["disconnected", "connecting", "authenticating", "ready", "failed"] as const
  );
  const trustAlgorithm = row["trust_algorithm"] === null
    ? undefined
    : remoteHostTrustAlgorithm(stringValue(row["trust_algorithm"]));
  const trustFingerprint = row["trust_fingerprint"] === null
    ? undefined
    : remoteHostTrustFingerprint(stringValue(row["trust_fingerprint"]));
  const trustPinnedAt = row["trust_pinned_at"] === null
    ? undefined
    : remoteHostTimestamp(numberValue(row["trust_pinned_at"]), "stored trust time");
  if (
    (trustAlgorithm === undefined) !== (trustFingerprint === undefined) ||
    (trustAlgorithm === undefined) !== (trustPinnedAt === undefined)
  ) {
    throw new StoreError("Remote Host trust metadata is incomplete.");
  }

  const failureCode = row["failure_code"] === null
    ? undefined
    : remoteHostFailureCode(stringValue(row["failure_code"]));
  const failureRetryable = row["failure_retryable"] === null
    ? undefined
    : booleanValue(row["failure_retryable"]);
  if (
    (state === "failed") !== (failureCode !== undefined) ||
    (state === "failed") !== (failureRetryable !== undefined)
  ) {
    throw new StoreError("Remote Host failure metadata is inconsistent with its status.");
  }
  if (
    failureCode !== undefined &&
    failureRetryable !== remoteHostFailureIsRetryable(failureCode)
  ) {
    throw new StoreError("Remote Host failure retryability is inconsistent with its bounded code.");
  }
  const authenticationMode = remoteHostAuthenticationMode(stringValue(row["authentication_mode"]));
  const credentialReferenceId = row["credential_reference_id"] === null
    ? undefined
    : remoteHostCredentialReference(stringValue(row["credential_reference_id"]));
  assertRemoteHostAuthentication(authenticationMode, credentialReferenceId);

  return {
    ownerId: remoteHostIdentity(stringValue(row["owner_id"]), "stored owner id", 256),
    targetId: remoteHostIdentity(stringValue(row["target_id"]), "stored target id", 256),
    id: remoteHostAlias(stringValue(row["host_id"])),
    hostname: remoteHostHostname(stringValue(row["hostname"])),
    port: remoteHostPort(numberValue(row["port"])),
    user: remoteHostUser(stringValue(row["username"])),
    source: remoteHostSource(stringValue(row["source"])),
    authenticationMode,
    ...(credentialReferenceId === undefined ? {} : { credentialReferenceId }),
    ...(trustAlgorithm === undefined || trustFingerprint === undefined || trustPinnedAt === undefined
      ? {}
      : {
          trust: {
            algorithm: trustAlgorithm,
            fingerprint: trustFingerprint,
            pinnedAt: trustPinnedAt
          }
        }),
    status: {
      state,
      changedAt: remoteHostTimestamp(numberValue(row["status_changed_at"]), "stored status time"),
      ...(failureCode === undefined || failureRetryable === undefined
        ? {}
        : { failure: { code: failureCode, retryable: failureRetryable } })
    },
    createdAt: remoteHostTimestamp(numberValue(row["created_at"]), "stored creation time"),
    updatedAt: remoteHostTimestamp(numberValue(row["updated_at"]), "stored update time"),
    revision: toBigInt(row["revision"])
  };
}

function sessionFromRow(row: Row): StoredSession {
  const remoteHostId = optionalString("hostId", row["remote_host_id"]).hostId;
  const remoteRoot = optionalString("workspaceRoot", row["remote_workspace_root"]).workspaceRoot;
  const automationScheduleId = optionalString("scheduleId", row["automation_schedule_id"]).scheduleId;
  const automationScheduleName = optionalString("scheduleName", row["automation_schedule_name"]).scheduleName;
  const automationRunId = optionalString("runId", row["automation_run_id"]).runId;
  const derivationKind = optionalString("kind", row["derivation_kind"]).kind;
  const derivationSourceSessionId = optionalString(
    "sourceSessionId",
    row["derivation_source_session_id"]
  ).sourceSessionId;
  const derivationSourceMessageId = optionalString(
    "sourceMessageId",
    row["derivation_source_message_id"]
  ).sourceMessageId;
  const derivationSourceEventId = optionalString(
    "sourceEventId",
    row["derivation_source_event_id"]
  ).sourceEventId;
  if ((remoteHostId === undefined) !== (remoteRoot === undefined)) {
    throw new StoreError("Stored Session Remote workspace binding is incomplete.");
  }
  if ((automationScheduleId === undefined) !== (automationRunId === undefined) ||
    (automationScheduleId === undefined && automationScheduleName !== undefined)) {
    throw new StoreError("Stored Session automation origin is incomplete.");
  }
  if (
    (derivationKind === undefined) !== (derivationSourceSessionId === undefined) ||
    (derivationSourceMessageId === undefined) !== (derivationSourceEventId === undefined) ||
    (derivationKind === "fork" && derivationSourceMessageId === undefined) ||
    (derivationKind !== undefined && derivationKind !== "fork" && derivationKind !== "clone")
  ) {
    throw new StoreError("Stored Session derivation origin is incomplete.");
  }
  return {
    descriptor: {
      id: stringValue(row["id"]),
      backendId: stringValue(row["backend_id"]),
      targetId: stringValue(row["target_id"]),
      ...optionalString("projectId", row["project_id"]),
      ...(automationScheduleId === undefined || automationRunId === undefined
        ? {}
        : {
            automationOrigin: {
              kind: "scheduler" as const,
              scheduleId: automationScheduleId,
              ...(automationScheduleName === undefined ? {} : { scheduleName: automationScheduleName }),
              runId: automationRunId
            }
          }),
      ...(derivationKind === undefined || derivationSourceSessionId === undefined
        ? {}
        : {
            derivationOrigin: {
              kind: derivationKind as "fork" | "clone",
              sourceSessionId: derivationSourceSessionId,
              ...(derivationSourceMessageId === undefined || derivationSourceEventId === undefined
                ? {}
                : {
                    sourceMessageId: derivationSourceMessageId,
                    sourceEventId: derivationSourceEventId
                  })
            }
          }),
      title: stringValue(row["title"]),
      titleSource: enumValue(row["title_source"], ["draft", "attachment", "placeholder", "automatic", "manual"] as const),
      ...optionalString("summary", row["task_summary"]),
      ...(row["summary_source_cursor"] === null || row["summary_source_cursor"] === undefined
        ? {}
        : { summarySourceCursor: toBigInt(row["summary_source_cursor"]) }),
      ...optionalNumber("summaryUpdatedAt", row["summary_updated_at"]),
      binding: {
        opaqueRef: stringValue(row["native_opaque_ref"]),
        ...optionalString("nativeSessionId", row["native_session_id"]),
        generation: numberValue(row["generation"])
      },
      pinned: booleanValue(row["pinned"]),
      archived: booleanValue(row["archived"]),
      ...optionalNumber("deletedAt", row["deleted_at"]),
      permissionMode: enumValue(row["permission_mode"], ["ask", "auto", "bypassPermissions"] as const),
      planMode: booleanValue(row["plan_mode"]),
      ...optionalString("providerId", row["provider_id"]),
      ...optionalString("modelId", row["model_id"]),
      ...optionalString("effort", row["effort"]),
      fastMode: booleanValue(row["fast_mode"]),
      ...optionalString("appendSystemPrompt", row["append_system_prompt"]),
      ...(remoteHostId === undefined || remoteRoot === undefined
        ? {}
        : {
            remoteWorkspace: {
              hostId: remoteHostAlias(remoteHostId),
              workspaceRoot: remoteWorkspaceRoot(remoteRoot)
            }
          }),
      createdAt: numberValue(row["created_at"]),
      updatedAt: numberValue(row["updated_at"])
    },
    revision: toBigInt(row["revision"])
  };
}

function objectiveFromRow(row: Row): ObjectiveRecord {
  const pendingOwnerGeneration = optionalNumber(
    "pendingOwnerGeneration",
    row["pending_owner_generation"]
  ).pendingOwnerGeneration;
  const pendingOperationId = optionalString("pendingOperationId", row["pending_operation_id"])
    .pendingOperationId;
  const pendingRunId = optionalString("pendingRunId", row["pending_run_id"]).pendingRunId;
  const pendingAttemptId = optionalString("pendingAttemptId", row["pending_attempt_id"])
    .pendingAttemptId;
  const pendingQueueItemId = optionalString("pendingQueueItemId", row["pending_queue_item_id"])
    .pendingQueueItemId;
  const pendingValues = [
    pendingOwnerGeneration,
    pendingOperationId,
    pendingRunId,
    pendingAttemptId,
    pendingQueueItemId
  ];
  if (pendingValues.some((value) => value === undefined) && pendingValues.some((value) => value !== undefined)) {
    throw new StoreError("Stored Objective pending-work identity is incomplete.");
  }
  return {
    sessionId: stringValue(row["session_id"]),
    text: stringValue(row["objective_text"]),
    status: objectiveStatus(stringValue(row["status"])),
    ...optionalNumber("tokenBudget", row["token_budget"]),
    ...optionalNumber("maximumTurns", row["maximum_turns"]),
    ...optionalNumber("noProgressTurnLimit", row["no_progress_turn_limit"]),
    turnsUsed: numberValue(row["turns_used"]),
    tokensUsed: numberValue(row["tokens_used"]),
    noProgressTurns: numberValue(row["no_progress_turns"]),
    dispatchRejections: numberValue(row["dispatch_rejections"]),
    ...optionalString("lastReason", row["last_reason"]),
    ownerGeneration: numberValue(row["owner_generation"]),
    sessionGeneration: numberValue(row["session_generation"]),
    ...(pendingOwnerGeneration === undefined
      ? {}
      : {
          pendingOwnerGeneration,
          pendingOperationId: pendingOperationId!,
          pendingRunId: pendingRunId!,
          pendingAttemptId: pendingAttemptId!,
          pendingQueueItemId: pendingQueueItemId!
        }),
    startedAt: numberValue(row["started_at"]),
    updatedAt: numberValue(row["updated_at"]),
    revision: toBigInt(row["revision"])
  };
}

function makerMemoryEntryFromRow(row: Row): MakerMemoryEntry {
  return {
    id: stringValue(row["id"]),
    targetId: stringValue(row["target_id"]),
    kind: makerMemoryKind(row["kind"]),
    ...(row["backend_id"] === null || row["backend_id"] === undefined
      ? {}
      : { backendId: stringValue(row["backend_id"]) }),
    slug: stringValue(row["slug"]),
    title: stringValue(row["title"]),
    description: stringValue(row["description"]),
    body: stringValue(row["body"]),
    createdAt: numberValue(row["created_at"]),
    updatedAt: numberValue(row["updated_at"]),
    revision: toBigInt(row["revision"])
  };
}

function sessionAttentionFromRow(row: Row): SessionAttentionRecord {
  return {
    sessionId: stringValue(row["session_id"]),
    kind: enumValue(row["kind"], ["done", "awaiting", "error"] as const),
    unread: booleanValue(row["unread"]),
    subjectCursor: toBigInt(row["subject_cursor"]),
    subjectGeneration: numberValue(row["subject_generation"]),
    attentionCursor: toBigInt(row["attention_cursor"]),
    attentionGeneration: numberValue(row["attention_generation"]),
    readThroughCursor: toBigInt(row["read_through_cursor"]),
    readThroughGeneration: numberValue(row["read_through_generation"]),
    updatedAt: numberValue(row["updated_at"]),
    revision: toBigInt(row["revision"])
  };
}

function sessionWorktreeFromRow(row: Row): SessionWorktreeBinding {
  return {
    leaseId: stringValue(row["lease_id"]),
    workspaceId: stringValue(row["workspace_id"]),
    path: stringValue(row["working_path"]),
    repositoryRoot: stringValue(row["repository_root"]),
    branch: stringValue(row["branch"]),
    sourceRef: stringValue(row["source_ref"]),
    sourceCommit: stringValue(row["source_commit"]),
    sourceStrategy: enumValue(row["source_strategy"], [
      "explicit",
      "remote_default_refreshed",
      "remote_default_local",
      "current_branch",
      "local_default",
      "head"
    ] as const),
    sourceRefreshed: booleanValue(row["source_refreshed"]),
    ...optionalString("sourceRemote", row["source_remote"]),
    state: enumValue(row["state"], ["active", "preserved"] as const),
    acquiredAt: numberValue(row["acquired_at"]),
    updatedAt: numberValue(row["updated_at"])
  };
}

function withSessionPresentation(
  session: StoredSession,
  attention: SessionAttentionRecord | undefined,
  worktree: SessionWorktreeBinding | undefined
): StoredSession {
  const attended = withSessionAttention(session, attention);
  if (worktree === undefined) return attended;
  return {
    ...attended,
    descriptor: { ...attended.descriptor, worktree }
  };
}

function withSessionAttention(
  session: StoredSession,
  attention: SessionAttentionRecord | undefined
): StoredSession {
  if (attention === undefined) return session;
  return {
    ...session,
    descriptor: {
      ...session.descriptor,
      attention: {
        kind: attention.kind,
        unread: attention.unread,
        subjectCursor: attention.subjectCursor,
        subjectGeneration: attention.subjectGeneration,
        attentionCursor: attention.attentionCursor,
        attentionGeneration: attention.attentionGeneration,
        readThroughCursor: attention.readThroughCursor,
        readThroughGeneration: attention.readThroughGeneration,
        updatedAt: attention.updatedAt
      }
    }
  };
}

function runFromRow(row: Row): StoredRun {
  return {
    descriptor: {
      id: stringValue(row["id"]),
      sessionId: stringValue(row["session_id"]),
      source: enumValue(row["source"], ["user", "schedule", "system"] as const),
      state: enumValue(row["state"], [
        "queued", "running", "waiting", "retrying", "completed", "aborted", "failed", "dispatch_unknown"
      ] as const),
      ...optionalString("parentRunId", row["parent_run_id"]),
      ...optionalString("activeAttemptId", row["active_attempt_id"]),
      createdAt: numberValue(row["created_at"]),
      ...optionalNumber("startedAt", row["started_at"]),
      ...optionalNumber("endedAt", row["ended_at"]),
      ...optionalJson<PublicError, "error">("error", row["error_json"])
    },
    revision: toBigInt(row["revision"])
  };
}

function attemptFromRow(row: Row): StoredAttempt {
  return {
    descriptor: {
      id: stringValue(row["id"]),
      runId: stringValue(row["run_id"]),
      ordinal: numberValue(row["ordinal"]),
      generation: numberValue(row["generation"]),
      ...optionalNumber("backendInstanceGeneration", row["backend_instance_generation"]),
      startedAt: numberValue(row["started_at"]),
      ...optionalNumber("endedAt", row["ended_at"]),
      ...optionalJson<PublicError, "error">("error", row["error_json"])
    },
    revision: toBigInt(row["revision"])
  };
}

function queueItemFromRow(row: Row, at: number): QueueItemRecord {
  const editLockExpiresAt = optionalNumber("editLockExpiresAt", row["edit_lock_expires_at"]).editLockExpiresAt;
  return {
    id: stringValue(row["id"]),
    sessionId: stringValue(row["session_id"]),
    runId: stringValue(row["run_id"]),
    ...optionalString("attemptId", row["attempt_id"]),
    operationId: stringValue(row["operation_id"]),
    disposition: enumValue(row["disposition"], ["prompt", "steer", "follow_up"] as const),
    state: enumValue(row["state"], [
      "accepted", "dispatching", "backend_accepted", "dispatch_unknown", "completed", "cancelled", "failed"
    ] as const),
    ...optionalNumber("backendInstanceGeneration", row["backend_instance_generation"]),
    position: numberValue(row["position"]),
    bodyHash: stringValue(row["body_hash"]),
    body: parseJson<PromptInput>(stringValue(row["body_json"])),
    ...optionalJson<import("@joko/core").TurnExecutionOverrides, "executionOverrides">(
      "executionOverrides",
      row["execution_overrides_json"]
    ),
    createdAt: numberValue(row["created_at"]),
    updatedAt: numberValue(row["updated_at"]),
    ...optionalNumber("dispatchedAt", row["dispatched_at"]),
    ...optionalNumber("backendAcceptedAt", row["backend_accepted_at"]),
    ...optionalNumber("completedAt", row["completed_at"]),
    ...optionalJson<PublicError, "error">("error", row["error_json"]),
    editLocked: editLockExpiresAt !== undefined && editLockExpiresAt > at,
    revision: toBigInt(row["revision"])
  };
}

function queueControlFromRow(row: Row, at: number): QueueControlRecord {
  const interactionLockExpiresAt = optionalNumber(
    "interactionLockExpiresAt",
    row["interaction_lock_expires_at"]
  ).interactionLockExpiresAt;
  return {
    sessionId: stringValue(row["session_id"]),
    paused: booleanValue(row["paused"]),
    ...optionalString("pauseReason", row["pause_reason"]),
    ...optionalNumber("pausedAt", row["paused_at"]),
    ...optionalString("pausedByConnectionId", row["paused_by_connection_id"]),
    interactionLocked: interactionLockExpiresAt !== undefined && interactionLockExpiresAt > at,
    updatedAt: numberValue(row["updated_at"]),
    revision: toBigInt(row["revision"])
  };
}

function operationFromRow<T>(row: Row): OperationRecord<T> {
  return {
    id: stringValue(row["id"]),
    ...optionalString("connectionId", row["connection_id"]),
    kind: stringValue(row["kind"]),
    body: parseJson(stringValue(row["body_json"])),
    bodyHash: stringValue(row["body_hash"]),
    completionMode: enumValue(row["completion_mode"], ["transactional", "external_effect"] as const),
    status: enumValue(row["status"], ["started", "completed", "failed"] as const),
    ...optionalJson<T, "response">("response", row["response_json"]),
    ...optionalJson("error", row["error_json"]),
    createdAt: numberValue(row["created_at"]),
    updatedAt: numberValue(row["updated_at"]),
    revision: toBigInt(row["revision"])
  };
}

function contextRebuildFromRow(row: Row): PendingContextRebuild {
  const state = stringValue(row["state"]);
  if (state !== "pending" && state !== "running") {
    throw new StoreError(`Unknown native context rebuild state '${state}'.`);
  }
  const claimToken = row["claim_token"] === null || row["claim_token"] === undefined
    ? undefined
    : stringValue(row["claim_token"]);
  const claimedAt = row["claimed_at"] === null || row["claimed_at"] === undefined
    ? undefined
    : numberValue(row["claimed_at"]);
  if (state === "running" && (claimToken === undefined || claimedAt === undefined)) {
    throw new StoreError("Running native context rebuild is missing its claim fence.");
  }
  return {
    sessionId: stringValue(row["session_id"]),
    reason: enumValue(row["reason"], ["message_deletion", "context_overflow", "prompt_timeout"] as const),
    latestDeletionOperationId: stringValue(row["latest_deletion_operation_id"]),
    sourceNativeOpaqueRef: stringValue(row["source_native_opaque_ref"]),
    ...optionalString("sourceRunId", row["source_run_id"]),
    ...optionalString("sourceQueueItemId", row["source_queue_item_id"]),
    sourceInputPending: booleanValue(row["source_input_pending"]),
    replaySafe: booleanValue(row["replay_safe"]),
    state,
    ...(claimToken === undefined ? {} : { claimToken }),
    ...(claimedAt === undefined ? {} : { claimedAt }),
    createdAt: numberValue(row["created_at"]),
    updatedAt: numberValue(row["updated_at"]),
    revision: toBigInt(row["revision"])
  };
}

interface SubagentRunPageCursor {
  readonly sessionId: string;
  readonly state: SubagentRunState | "";
  readonly resetCursor: bigint;
  readonly snapshotCursor: bigint;
  readonly offset: number;
}

interface SubagentTranscriptPageCursor {
  readonly sessionId: string;
  readonly runId: string;
  readonly childId: string;
  readonly afterCursor: bigint;
  readonly resetCursor: bigint;
  readonly snapshotCursor: bigint;
  readonly tail: boolean;
}

function boundedSubagentPageSize(value: number | undefined, maximum: number): number {
  if (value === undefined) return DEFAULT_SUBAGENT_PAGE_SIZE;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new StoreError("Subagent page size must be a positive integer.");
  }
  return Math.min(value, maximum);
}

function redactSubagentEventPayload(payload: EventPayload): EventPayload {
  if (payload.type === "subagent_run") {
    const run = payload.run;
    const children = run.children?.map((child) => ({
      ...redactSubagentTextFields(child, ["title", "assignment", "result"]),
      ...(child.error === undefined ? {} : { error: redactSubagentPublicError(child.error) })
    }));
    return {
      type: "subagent_run",
      run: {
        ...redactSubagentTextFields(run, [
          "title",
          "description",
          "assignment",
          "summary",
          "returnedResult"
        ]),
        ...(run.error === undefined ? {} : { error: redactSubagentPublicError(run.error) }),
        activity: run.activity.map((entry) => redactSubagentTextFields(entry, ["summary"])),
        ...(children === undefined ? {} : { children })
      }
    };
  }
  if (payload.type !== "subagent_transcript") return payload;
  const entry = redactSubagentTextFields(payload.entry, ["content", "childTitle", "toolInputJson"]);
  const systemEvent = entry.systemEvent === undefined
    ? undefined
    : {
        ...entry.systemEvent,
        ...(entry.systemEvent.params === undefined
          ? {}
          : {
              params: Object.fromEntries(
                Object.entries(entry.systemEvent.params).map(([key, value]) => [key, redactSecrets(value)])
              )
            })
      };
  return {
    type: "subagent_transcript",
    subagentRunId: payload.subagentRunId,
    entry: {
      ...entry,
      ...(systemEvent === undefined ? {} : { systemEvent })
    }
  };
}

function redactSubagentTextFields<T extends object, K extends keyof T>(
  value: T,
  fields: readonly K[]
): T {
  const result = { ...value };
  const mutable = result as Record<PropertyKey, unknown>;
  for (const field of fields) {
    const current = value[field];
    if (typeof current === "string") mutable[field] = redactSecrets(current);
  }
  return result;
}

function redactSubagentPublicError(error: PublicError): PublicError {
  return {
    ...error,
    message: redactSecrets(error.message),
    recovery: redactSecrets(error.recovery)
  };
}

function boundedSubagentIdentity(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized === "" || normalized.length > 512 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new StoreError(`Subagent ${label} is invalid.`);
  }
  if (redactSecrets(normalized) !== normalized) {
    throw new StoreError(`Subagent ${label} contains credential-like material.`);
  }
  return normalized;
}

function boundedSubagentText(value: string | undefined, maximum: number, label: string): void {
  if (value === undefined) return;
  if (value.length > maximum || value.includes("\u0000")) {
    throw new StoreError(`Subagent ${label} exceeds its durable bound.`);
  }
}

function validateSubagentRoute(route: SubagentRunDetail["route"]): void {
  if (route === undefined) return;
  if (route.providerId !== undefined) boundedSubagentIdentity(route.providerId, "provider ID");
  if (route.modelId !== undefined) boundedSubagentIdentity(route.modelId, "model ID");
  if (route.thinkingLevel !== undefined) boundedSubagentIdentity(route.thinkingLevel, "thinking level");
}

function validateSubagentUsage(usage: SubagentRunDetail["usage"]): void {
  if (usage === undefined) return;
  for (const [value, label] of [
    [usage.inputTokens, "input tokens"],
    [usage.outputTokens, "output tokens"],
    [usage.cacheReadTokens, "cache-read tokens"],
    [usage.cacheWriteTokens, "cache-write tokens"],
    [usage.totalTokens, "total tokens"],
    [usage.toolUses, "tool uses"],
    [usage.durationMs, "duration"]
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
      throw new StoreError(`Subagent ${label} must be a non-negative safe integer.`);
    }
  }
  if (usage.costUsd !== undefined && (!Number.isFinite(usage.costUsd) || usage.costUsd < 0)) {
    throw new StoreError("Subagent cost must be a finite non-negative number.");
  }
}

function validateSubagentPublicError(error: SubagentRunDetail["error"]): void {
  if (error === undefined) return;
  boundedSubagentIdentity(error.code, "error code");
  boundedSubagentText(error.message, 64 * 1024, "error message");
  boundedSubagentText(error.phase, 4 * 1024, "error phase");
  boundedSubagentText(error.recovery, 64 * 1024, "error recovery");
}

function assertAcyclicSubagentChildren(children: NonNullable<SubagentRunDetail["children"]>): void {
  const parents = new Map(children.map((child) => [child.id, child.parentChildId] as const));
  for (const child of children) {
    const seen = new Set<string>([child.id]);
    let parent = child.parentChildId;
    while (parent !== undefined) {
      if (seen.has(parent)) throw new StoreError("Subagent child parent relationships contain a cycle.");
      seen.add(parent);
      parent = parents.get(parent);
    }
  }
}

function resolveSubagentChildId(run: SubagentRunDetail, input: string | undefined): string {
  if (input === undefined) return "";
  const identifier = nonBlank(input, "Subagent child ID");
  const children = run.children ?? [];
  const exact = children.find((child) => child.id === identifier);
  if (exact !== undefined) return exact.id;
  const aliases = children.filter((child) => child.identityAliases.includes(identifier));
  if (aliases.length > 1) throw new StoreError("Subagent child alias is ambiguous in this run.");
  const child = aliases[0];
  if (child === undefined) throw new NotFoundError("Subagent child", identifier);
  return child.id;
}

function compareSubagentRuns(left: SubagentRunDetail, right: SubagentRunDetail): number {
  return right.startedAt - left.startedAt || right.id.localeCompare(left.id, "en");
}

function encodeSubagentRunPageToken(cursor: SubagentRunPageCursor): string {
  return Buffer.from(JSON.stringify({
    v: 1,
    kind: "subagent-runs",
    sessionId: cursor.sessionId,
    state: cursor.state,
    resetCursor: cursor.resetCursor.toString(),
    snapshotCursor: cursor.snapshotCursor.toString(),
    offset: cursor.offset
  }), "utf8").toString("base64url");
}

function decodeSubagentRunPageToken(raw: string | undefined): SubagentRunPageCursor | undefined {
  if (raw === undefined || raw === "") return undefined;
  const value = decodeSubagentPageToken(raw);
  if (value["v"] !== 1 || value["kind"] !== "subagent-runs") {
    throw new StoreError("Subagent run page token is malformed.");
  }
  const sessionId = boundedCursorText(value["sessionId"], "Session");
  const state = value["state"];
  if (state !== "" && state !== "queued" && state !== "running" && state !== "completed" && state !== "failed" && state !== "stopped") {
    throw new StoreError("Subagent run page token has an invalid state.");
  }
  const offset = value["offset"];
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) {
    throw new StoreError("Subagent run page token has an invalid offset.");
  }
  return {
    sessionId,
    state,
    resetCursor: cursorBigInt(value["resetCursor"]),
    snapshotCursor: cursorBigInt(value["snapshotCursor"]),
    offset
  };
}

function encodeSubagentTranscriptPageToken(cursor: SubagentTranscriptPageCursor): string {
  return Buffer.from(JSON.stringify({
    v: 1,
    kind: "subagent-transcript",
    sessionId: cursor.sessionId,
    runId: cursor.runId,
    childId: cursor.childId,
    afterCursor: cursor.afterCursor.toString(),
    resetCursor: cursor.resetCursor.toString(),
    snapshotCursor: cursor.snapshotCursor.toString(),
    tail: cursor.tail
  }), "utf8").toString("base64url");
}

function decodeSubagentTranscriptPageToken(raw: string | undefined): SubagentTranscriptPageCursor | undefined {
  if (raw === undefined || raw === "") return undefined;
  const value = decodeSubagentPageToken(raw);
  if (value["v"] !== 1 || value["kind"] !== "subagent-transcript") {
    throw new StoreError("Subagent transcript page token is malformed.");
  }
  if (typeof value["tail"] !== "boolean") {
    throw new StoreError("Subagent transcript page token has an invalid mode.");
  }
  return {
    sessionId: boundedCursorText(value["sessionId"], "Session"),
    runId: boundedCursorText(value["runId"], "run"),
    childId: value["childId"] === "" ? "" : boundedCursorText(value["childId"], "child"),
    afterCursor: cursorBigInt(value["afterCursor"]),
    resetCursor: cursorBigInt(value["resetCursor"]),
    snapshotCursor: cursorBigInt(value["snapshotCursor"]),
    tail: value["tail"]
  };
}

function decodeSubagentPageToken(raw: string): Record<string, unknown> {
  if (raw.length > MAX_SUBAGENT_PAGE_TOKEN_LENGTH) {
    throw new StoreError("Subagent page token is too long.");
  }
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== raw) throw new Error("non-canonical");
    const value: unknown = JSON.parse(decoded);
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("shape");
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof StoreError) throw error;
    throw new StoreError("Subagent page token is malformed.");
  }
}

function boundedCursorText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 512) {
    throw new StoreError(`Subagent ${label} identity in the page token is invalid.`);
  }
  return value;
}

function cursorBigInt(value: unknown): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new StoreError("Subagent page token has an invalid cursor.");
  }
  return BigInt(value);
}

function eventFromRow(row: Row): PersistedEvent {
  const stored = parseJson<{
    readonly payload: EventPayload;
    readonly pi?: NonNullable<AppendEventInput["pi"]> | null;
  }>(stringValue(row["payload_json"]));
  return {
    id: stringValue(row["id"]),
    globalCursor: toBigInt(row["global_cursor"]),
    sequence: toBigInt(row["session_sequence"]),
    revision: toBigInt(row["revision"]),
    emittedAt: numberValue(row["emitted_at"]),
    backendId: stringValue(row["backend_id"]),
    targetId: stringValue(row["target_id"]),
    sessionId: stringValue(row["session_id"]),
    ...optionalString("runId", row["run_id"]),
    ...optionalString("attemptId", row["attempt_id"]),
    ...optionalString("operationId", row["operation_id"]),
    generation: numberValue(row["generation"]),
    traceId: stringValue(row["trace_id"]),
    payload: stored.payload,
    ...(stored.pi === undefined || stored.pi === null ? {} : { pi: stored.pi }),
    ...(row["namespace"] === null || row["namespace"] === undefined
      ? {}
      : {
        metadata: {
          namespace: stringValue(row["namespace"]),
          fields: row["metadata_json"] === null || row["metadata_json"] === undefined
            ? {}
            : parseJson<Readonly<Record<string, string | number | boolean>>>(
              stringValue(row["metadata_json"])
            )
        }
      })
  };
}

function interactionFromRow(row: Row): InteractionRecord {
  return {
    id: stringValue(row["id"]),
    sessionId: stringValue(row["session_id"]),
    ...optionalString("runId", row["run_id"]),
    ...optionalString("attemptId", row["attempt_id"]),
    ...optionalString("operationId", row["operation_id"]),
    generation: numberValue(row["generation"]),
    kind: stringValue(row["kind"]) as InteractionRecord["kind"],
    status: enumValue(row["status"], ["open", "resolved", "dismissed"] as const),
    payload: parseJson<InteractionRecord["payload"]>(stringValue(row["payload_json"])),
    ...optionalJson("decision", row["decision_json"]),
    ...optionalString("dismissalReason", row["dismissal_reason"]),
    createdAt: numberValue(row["created_at"]),
    ...optionalNumber("resolvedAt", row["resolved_at"]),
    revision: toBigInt(row["revision"])
  };
}

function scheduleFromRow(row: Row): ScheduleRecord {
  return {
    id: stringValue(row["id"]),
    backendId: stringValue(row["backend_id"]),
    targetId: stringValue(row["target_id"]),
    sessionMode: enumValue(row["session_mode"], ["fresh", "persistent", "bound"] as const),
    ...optionalString("sessionId", row["session_id"]),
    name: stringValue(row["name"]),
    kind: enumValue(row["kind"], ["one_shot", "cron", "interval", "manual"] as const),
    ...optionalString("expression", row["expression"]),
    ...optionalNumber("anchorAt", row["anchor_at"]),
    timezone: stringValue(row["timezone"]),
    enabled: booleanValue(row["enabled"]),
    prompt: parseJson<PromptInput>(stringValue(row["prompt_json"])),
    executionSnapshot: parseJson(stringValue(row["execution_snapshot_json"])),
    overlapPolicy: enumValue(row["overlap_policy"], ["queue", "skip"] as const),
    misfirePolicy: enumValue(row["misfire_policy"], ["run_once", "skip"] as const),
    ...optionalNumber("nextRunAt", row["next_run_at"]),
    ...optionalNumber("lastRunAt", row["last_run_at"]),
    createdAt: numberValue(row["created_at"]),
    updatedAt: numberValue(row["updated_at"]),
    revision: toBigInt(row["revision"])
  };
}

function scheduleRunFromRow(row: Row): ScheduleRunRecord {
  const detail = row["detail_json"] === null || row["detail_json"] === undefined
    ? undefined
    : parseJson<unknown>(stringValue(row["detail_json"]));
  const readAt = isRecord(detail) && Number.isSafeInteger(detail["readAt"]) && Number(detail["readAt"]) >= 0
    ? Number(detail["readAt"])
    : undefined;
  return {
    id: toBigInt(row["id"]),
    scheduleId: stringValue(row["schedule_id"]),
    runId: stringValue(row["run_id"]),
    ...optionalString("sessionId", row["session_id"]),
    firedAt: numberValue(row["fired_at"]),
    ...optionalNumber("finishedAt", row["finished_at"]),
    status: stringValue(row["status"]),
    ...(detail === undefined ? {} : { detail }),
    ...(readAt === undefined ? {} : { readAt }),
    revision: toBigInt(row["revision"])
  };
}

function schedulerRuntimeOwnerFromRow(row: Row): SchedulerRuntimeOwnerRecord {
  return {
    ownerId: stringValue(row["owner_id"]),
    generation: numberValue(row["generation"]),
    startedAt: numberValue(row["started_at"]),
    heartbeatAt: numberValue(row["heartbeat_at"]),
    leaseExpiresAt: numberValue(row["lease_expires_at"]),
    updatedAt: numberValue(row["updated_at"]),
    revision: toBigInt(row["revision"])
  };
}

function scheduleRuntimeOccurrenceFromRow(row: Row): ScheduleRuntimeOccurrenceRecord {
  return {
    runId: stringValue(row["run_id"]),
    scheduleId: stringValue(row["schedule_id"]),
    source: enumValue(row["source"], ["automatic", "run-now"] as const),
    ...(row["execution_mode"] === null || row["execution_mode"] === undefined
      ? {}
      : { executionMode: enumValue(row["execution_mode"], ["agent", "script"] as const) }),
    phase: enumValue(row["phase"], [
      "loading",
      "claiming",
      "persisting",
      "running",
      "queued",
      "cancelling",
      "finalizing",
      "stalled",
      "recovering"
    ] as const),
    ownerId: stringValue(row["owner_id"]),
    ownerGeneration: numberValue(row["owner_generation"]),
    scheduledAt: numberValue(row["scheduled_at"]),
    startedAt: numberValue(row["started_at"]),
    heartbeatAt: numberValue(row["heartbeat_at"]),
    lastProgressAt: numberValue(row["last_progress_at"]),
    leaseExpiresAt: numberValue(row["lease_expires_at"]),
    ...optionalNumber("stallDetectedAt", row["stall_detected_at"]),
    ...optionalNumber("abortRequestedAt", row["abort_requested_at"]),
    createdAt: numberValue(row["created_at"]),
    updatedAt: numberValue(row["updated_at"]),
    revision: toBigInt(row["revision"])
  };
}

function toolLeaseFromRow(row: Row): ToolLeaseRecord {
  return {
    id: stringValue(row["id"]),
    toolId: stringValue(row["tool_id"]),
    sessionId: stringValue(row["session_id"]),
    ...optionalString("runId", row["run_id"]),
    generation: numberValue(row["generation"]),
    fencingToken: toBigInt(row["fencing_token"]),
    state: enumValue(row["state"], ["active", "released", "revoked", "expired"] as const),
    expiresAt: numberValue(row["expires_at"]),
    metadata: parseJson(stringValue(row["metadata_json"])),
    createdAt: numberValue(row["created_at"]),
    updatedAt: numberValue(row["updated_at"]),
    ...optionalNumber("releasedAt", row["released_at"]),
    revision: toBigInt(row["revision"])
  };
}

function artifactFromRow(row: Row): ArtifactRecord {
  return {
    blob: {
      id: stringValue(row["id"]),
      sha256: stringValue(row["sha256"]),
      byteLength: numberValue(row["byte_length"]),
      mimeType: stringValue(row["mime_type"]),
      ...optionalString("fileName", row["file_name"])
    },
    storageKey: stringValue(row["storage_key"]),
    ...optionalString("sessionId", row["session_id"]),
    ...optionalString("runId", row["run_id"]),
    metadata: parseJson(stringValue(row["metadata_json"])),
    createdAt: numberValue(row["created_at"]),
    ...optionalNumber("deletedAt", row["deleted_at"]),
    revision: toBigInt(row["revision"])
  };
}

function reviewRunFromRow(row: Row): ReviewRunRecord {
  return {
    id: stringValue(row["id"]),
    sourceSessionId: stringValue(row["source_session_id"]),
    ...optionalString("reviewerSessionId", row["reviewer_session_id"]),
    targetKind: enumValue(row["target_kind"], ["changes", "artifacts", "task", "mixed"] as const),
    state: enumValue(row["state"], ["running", "completed", "failed"] as const),
    freshness: enumValue(row["freshness"], ["current", "stale", "unavailable"] as const),
    freshnessCheckedAt: numberValue(row["freshness_checked_at"]),
    ...optionalString("result", row["result_text"]),
    ...optionalReviewFailureCode(row["failure_code"]),
    createdAt: numberValue(row["created_at"]),
    updatedAt: numberValue(row["updated_at"]),
    ...optionalNumber("endedAt", row["ended_at"]),
    revision: toBigInt(row["revision"])
  };
}

function reviewSourceLeaseFromRow(row: Row): ReviewSourceLeaseRecord {
  return {
    reviewRunId: stringValue(row["review_run_id"]),
    sourceSessionId: stringValue(row["source_session_id"]),
    fencingToken: toBigInt(row["fencing_token"]),
    state: enumValue(row["state"], ["active", "released"] as const),
    createdAt: numberValue(row["created_at"]),
    ...optionalNumber("releasedAt", row["released_at"]),
    revision: toBigInt(row["revision"])
  };
}

function reviewEvidenceSealFromRow(row: Row): ReviewEvidenceSealRecord {
  return {
    version: 1,
    conversationSha256: stringValue(row["conversation_sha256"]),
    workspaceSha256: stringValue(row["workspace_sha256"]),
    filesSha256: stringValue(row["files_sha256"]),
    artifactsSha256: stringValue(row["artifacts_sha256"]),
    sealSha256: stringValue(row["seal_sha256"]),
    createdAt: numberValue(row["created_at"]),
    revision: toBigInt(row["revision"])
  };
}

function reviewAttachmentFromRow(row: Row): ReviewAttachmentRecord {
  return {
    ordinal: numberValue(row["ordinal"]),
    kind: enumValue(row["kind"], ["file", "image"] as const),
    displayName: stringValue(row["display_name"]),
    blob: {
      id: stringValue(row["blob_id"]),
      sha256: stringValue(row["sha256"]),
      byteLength: numberValue(row["byte_length"]),
      mimeType: stringValue(row["mime_type"]),
      ...optionalString("fileName", row["file_name"])
    },
    revision: toBigInt(row["revision"])
  };
}

function sessionRuntimePolicyFromRow(row: Row): SessionRuntimePolicyRecord {
  return {
    sessionId: stringValue(row["session_id"]),
    reviewRunId: stringValue(row["review_run_id"]),
    policy: enumValue(row["policy"], ["review_read_only"] as const),
    sourceLeaseFencingToken: toBigInt(row["source_lease_fencing_token"]),
    createdAt: numberValue(row["created_at"]),
    updatedAt: numberValue(row["updated_at"]),
    revision: toBigInt(row["revision"])
  };
}

function usageLedgerDailyFromRow(row: Row): UsageLedgerDailyRecord {
  return {
    ownerId: stringValue(row["owner_id"]),
    sessionId: stringValue(row["session_id"]),
    generation: numberValue(row["generation"]),
    backendId: stringValue(row["backend_id"]),
    providerId: stringValue(row["provider_id"]),
    modelId: stringValue(row["model_id"]),
    day: validUsageDay(stringValue(row["day"])),
    inputTokens: numberValue(row["input_tokens"]),
    outputTokens: numberValue(row["output_tokens"]),
    cacheReadTokens: numberValue(row["cache_read_tokens"]),
    cacheWriteTokens: numberValue(row["cache_write_tokens"]),
    totalTokens: numberValue(row["total_tokens"]),
    costMicros: numberValue(row["cost_micros"]),
    currencyCode: usageCurrency(stringValue(row["currency_code"])),
    costComplete: booleanValue(row["cost_complete"]),
    estimated: booleanValue(row["estimated"]),
    firstMeasuredAt: numberValue(row["first_measured_at"]),
    lastMeasuredAt: numberValue(row["last_measured_at"]),
    revision: toBigInt(row["revision"])
  };
}

function modelPriceOverrideFromRow(row: Row): ModelPriceOverrideRecord {
  return {
    ownerId: stringValue(row["owner_id"]),
    backendId: stringValue(row["backend_id"]),
    providerId: stringValue(row["provider_id"]),
    modelId: stringValue(row["model_id"]),
    currencyCode: modelPriceCurrency(stringValue(row["currency_code"])),
    inputCostMicrosPerMillion: numberValue(row["input_cost_micros_per_million"]),
    outputCostMicrosPerMillion: numberValue(row["output_cost_micros_per_million"]),
    ...optionalNumber("cacheReadCostMicrosPerMillion", row["cache_read_cost_micros_per_million"]),
    ...optionalNumber("cacheWriteCostMicrosPerMillion", row["cache_write_cost_micros_per_million"]),
    updatedAt: numberValue(row["updated_at"]),
    revision: toBigInt(row["revision"])
  };
}

function localRuntimeOwnerFromRow(row: Row): LocalRuntimeOwnerRecord {
  return {
    ownerId: localRuntimeIdentity(stringValue(row["owner_id"]), "stored owner ID", 256),
    runtimeId: localRuntimeId(stringValue(row["runtime_id"])),
    ownerGeneration: localRuntimeGeneration(numberValue(row["generation"])),
    activatedAt: localRuntimeTimestamp(numberValue(row["activated_at"]), "stored activation time"),
    updatedAt: localRuntimeTimestamp(numberValue(row["updated_at"]), "stored owner update time"),
    revision: toBigInt(row["revision"])
  };
}

function localRuntimeInstallationFromRow(row: Row): LocalRuntimeInstallationRecord {
  const state = enumValue(row["state"], ["installing", "installed", "failed", "cancelled"] as const);
  const version = row["version"] === null ? undefined : localRuntimeVersion(stringValue(row["version"]));
  const archiveSha256 = row["archive_sha256"] === null ? undefined : localRuntimeSha256(stringValue(row["archive_sha256"]));
  const publicErrorCode = row["public_error_code"] === null ? undefined : localRuntimePublicErrorCode(stringValue(row["public_error_code"]));
  if ((state === "installed") !== (version !== undefined && archiveSha256 !== undefined)) {
    throw new StoreError("Stored local runtime installation metadata is inconsistent.");
  }
  if ((state === "failed" || state === "cancelled") !== (publicErrorCode !== undefined)) {
    throw new StoreError("Stored local runtime installation error metadata is inconsistent.");
  }
  return {
    ownerId: localRuntimeIdentity(stringValue(row["owner_id"]), "stored owner ID", 256),
    runtimeId: localRuntimeId(stringValue(row["runtime_id"])),
    ownerGeneration: localRuntimeGeneration(numberValue(row["owner_generation"])),
    operationId: localRuntimeIdentity(stringValue(row["operation_id"]), "stored installation operation ID", 128),
    state,
    ...(version === undefined ? {} : { version }),
    ...(archiveSha256 === undefined ? {} : { archiveSha256 }),
    ...(publicErrorCode === undefined ? {} : { publicErrorCode }),
    startedAt: localRuntimeTimestamp(numberValue(row["started_at"]), "stored installation start time"),
    heartbeatAt: localRuntimeTimestamp(numberValue(row["heartbeat_at"]), "stored installation heartbeat time"),
    leaseExpiresAt: localRuntimeTimestamp(numberValue(row["lease_expires_at"]), "stored installation lease time"),
    updatedAt: localRuntimeTimestamp(numberValue(row["updated_at"]), "stored installation update time"),
    revision: toBigInt(row["revision"])
  };
}

function localModelPullCheckpointFromRow(row: Row): LocalModelPullCheckpointRecord {
  return {
    ownerId: localRuntimeIdentity(stringValue(row["owner_id"]), "stored owner ID", 256),
    runtimeId: localRuntimeId(stringValue(row["runtime_id"])),
    ownerGeneration: localRuntimeGeneration(numberValue(row["owner_generation"])),
    modelKey: localRuntimeModelIdentity(stringValue(row["model_key"]), "stored model key"),
    modelName: localRuntimeModelIdentity(stringValue(row["model_name"]), "stored model name"),
    ...optionalLocalRuntimeCounter("completedBytes", row["completed_bytes"], true),
    ...optionalLocalRuntimeCounter("totalBytes", row["total_bytes"], false),
    ...(row["percent"] === null ? {} : { percent: localRuntimePercent(numberValue(row["percent"])) }),
    digests: localRuntimeDigests(parseJson<unknown>(stringValue(row["digests_json"]))),
    updatedAt: localRuntimeTimestamp(numberValue(row["updated_at"]), "stored pull checkpoint time"),
    revision: toBigInt(row["revision"])
  };
}

function localRuntimeProviderBindingFromRow(row: Row): LocalRuntimeProviderBindingRecord {
  const version = toBigInt(stringValue(row["provider_version"]));
  if (version < 1n) throw new StoreError("Stored local runtime Provider version is invalid.");
  return {
    ownerId: localRuntimeIdentity(stringValue(row["owner_id"]), "stored owner ID", 256),
    runtimeId: localRuntimeId(stringValue(row["runtime_id"])),
    ownerGeneration: localRuntimeGeneration(numberValue(row["owner_generation"])),
    providerId: localRuntimeIdentity(stringValue(row["provider_id"]), "stored Provider ID", 256),
    providerVersion: version,
    modelIds: localRuntimeModelIds(parseJson<unknown>(stringValue(row["model_ids_json"]))),
    updatedAt: localRuntimeTimestamp(numberValue(row["updated_at"]), "stored Provider binding time"),
    revision: toBigInt(row["revision"])
  };
}

function settingFromRow<T = unknown>(row: Row): SettingRecord<T> {
  return {
    scopeType: enumValue(row["scope_type"], ["service", "connection", "backend", "target", "session"] as const),
    scopeId: stringValue(row["scope_id"]),
    key: stringValue(row["key"]),
    value: parseJson<T>(stringValue(row["value_json"])),
    updatedAt: numberValue(row["updated_at"]),
    revision: toBigInt(row["revision"])
  };
}

function diagnosticFromRow(row: Row): DiagnosticRecord {
  return {
    id: stringValue(row["id"]),
    severity: enumValue(row["severity"], ["debug", "info", "warning", "error"] as const),
    component: stringValue(row["component"]),
    code: stringValue(row["code"]),
    message: stringValue(row["message"]),
    details: parseJson(stringValue(row["details_json"])),
    createdAt: numberValue(row["created_at"]),
    revision: toBigInt(row["revision"])
  };
}

function replayOperation<T>(operation: OperationRecord<T>, bodyHash: string): OperationExecution<T> {
  if (operation.bodyHash !== bodyHash) {
    throw new OperationConflictError(operation.id, operation.bodyHash, bodyHash);
  }
  if (operation.status === "failed") {
    throw new OperationPreviouslyFailedError(operation.id, operation.error);
  }
  if (operation.status !== "completed" || !("response" in operation)) {
    throw new OperationInProgressError(operation.id);
  }
  return { replayed: true, value: operation.response as T, operation };
}

function errorForStorage(error: unknown): unknown {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.cause === undefined ? {} : { cause: String(error.cause) })
    };
  }
  return { name: "Error", message: String(error) };
}

function assertEffectOperation(operation: OperationRecord, expectedBodyHash: string): void {
  if (operation.bodyHash !== expectedBodyHash) {
    throw new OperationConflictError(operation.id, operation.bodyHash, expectedBodyHash);
  }
  if (operation.completionMode !== "external_effect") {
    throw new StoreError(`Operation ${operation.id} is not an external-effect operation.`);
  }
}

function effectFailureError(error: unknown): PublicError {
  if (error instanceof JokoError) {
    return {
      ...error.publicError,
      message: redactSecrets(error.publicError.message),
      recovery: redactSecrets(error.publicError.recovery)
    };
  }
  return {
    code: "EFFECT_FAILED",
    message: redactSecrets(error instanceof Error ? error.message : String(error)),
    phase: "effect",
    retryable: false,
    stateMayHaveChanged: true,
    recovery: "Inspect the authoritative external state before deciding whether to issue a new operation."
  };
}

function effectOutcomeUnknownError(): PublicError {
  return {
    code: "EFFECT_OUTCOME_UNKNOWN",
    message: "The service restarted after the external effect was claimed but before its outcome was recorded.",
    phase: "effect",
    retryable: false,
    stateMayHaveChanged: true,
    recovery: "Inspect the authoritative external state and reconcile explicitly; do not blindly replay this operation."
  };
}

function dispatchUnknownError(): PublicError {
  return {
    code: "dispatch_unknown_after_restart",
    message: "The service restarted after dispatch began but before backend acceptance was confirmed.",
    phase: "dispatch",
    retryable: false,
    stateMayHaveChanged: true,
    recovery: "Inspect the native session and explicitly reconcile or create a linked retry run."
  };
}

function decisionText(value: unknown): string {
  if (typeof value === "string") return value;
  return serializeJson(value);
}

function isTerminalRunState(state: RunState): boolean {
  return state === "completed" || state === "aborted" || state === "failed";
}

function scheduleHistoryStatus(state: RunState): string {
  return state === "completed" ? "success" : state;
}

function scheduleHistoryDetailWithError(value: unknown, error: PublicError): Readonly<Record<string, unknown>> {
  const existing = typeof value === "string"
    ? parseJson<unknown>(value)
    : undefined;
  return {
    ...(isRecord(existing) ? existing : {}),
    error
  };
}

function scheduleDeletionCleanupFromRow(row: Row): ScheduleDeletionCleanupRecord {
  const generatedSessionIds = scheduleDeletionStringArray(row["generated_session_ids_json"], "generated Session IDs");
  const occurrenceRunIds = scheduleDeletionStringArray(row["occurrence_run_ids_json"], "occurrence run IDs");
  const completedSessionIds = scheduleDeletionStringArray(row["completed_session_ids_json"], "completed Session IDs");
  const failureValue = parseJson<unknown>(stringValue(row["failures_json"]));
  if (!Array.isArray(failureValue)) throw new StoreError("Schedule deletion cleanup failures are invalid.");
  const failures = failureValue.map((value): ScheduleDeletionCleanupFailure => {
    if (!isRecord(value) || typeof value["sessionId"] !== "string" || typeof value["message"] !== "string") {
      throw new StoreError("Schedule deletion cleanup failure is invalid.");
    }
    return {
      sessionId: nonBlank(value["sessionId"], "Schedule deletion failure Session ID"),
      message: nonBlank(value["message"], "Schedule deletion failure message")
    };
  });
  const projectTargetId = row["project_target_id"] === null
    ? undefined
    : stringValue(row["project_target_id"]);
  const projectConfigId = row["project_config_id"] === null
    ? undefined
    : stringValue(row["project_config_id"]);
  return {
    operationId: stringValue(row["operation_id"]),
    scheduleId: stringValue(row["schedule_id"]),
    disposition: enumValue(row["disposition"], ["keep", "archive", "delete"] as const),
    state: enumValue(row["state"], ["pending", "completed"] as const),
    generatedSessionIds,
    occurrenceRunIds,
    inflightCount: numberValue(row["inflight_count"]),
    completedSessionIds,
    failures,
    ...(projectTargetId === undefined ? {} : { projectTargetId }),
    ...(projectConfigId === undefined ? {} : { projectConfigId }),
    createdAt: numberValue(row["created_at"]),
    updatedAt: numberValue(row["updated_at"]),
    revision: toBigInt(row["revision"])
  };
}

function sessionLifecycleCleanupFromRow(row: Row): SessionLifecycleCleanupRecord {
  const failureValue = row["failure_json"] === null
    ? undefined
    : parseJson<unknown>(stringValue(row["failure_json"]));
  const failure = isRecord(failureValue) && typeof failureValue["message"] === "string"
    ? failureValue["message"]
    : undefined;
  return {
    operationId: stringValue(row["operation_id"]),
    sessionId: stringValue(row["session_id"]),
    disposition: enumValue(row["disposition"], ["archive", "delete"] as const),
    state: enumValue(row["state"], ["pending", "completed"] as const),
    deleteNativeSession: booleanValue(row["delete_native"]),
    deleteArtifacts: booleanValue(row["delete_artifacts"]),
    releaseWorktree: booleanValue(row["release_worktree"]),
    cleanupGitSafety: booleanValue(row["cleanup_git_safety"]),
    closeCompleted: booleanValue(row["close_completed"]),
    nativeCompleted: booleanValue(row["native_completed"]),
    worktreeCompleted: booleanValue(row["worktree_completed"]),
    gitSafetyCompleted: booleanValue(row["git_safety_completed"]),
    ...(failure === undefined ? {} : { failure }),
    createdAt: numberValue(row["created_at"]),
    updatedAt: numberValue(row["updated_at"]),
    revision: toBigInt(row["revision"])
  };
}

function scheduleDeletionStringArray(value: unknown, field: string): string[] {
  const parsed = parseJson<unknown>(stringValue(value));
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new StoreError(`Schedule deletion cleanup ${field} are invalid.`);
  }
  return [...new Set(parsed as string[])];
}

interface ScheduleRunMoneyDetail {
  readonly amountMicros: number;
  readonly currency: "USD" | "CNY";
  readonly approximate: boolean;
  readonly estimateReasons: readonly string[];
}

function scheduleRunMoneyDetail(
  value: unknown,
  expectedKind: "actual-cost" | "value-estimate"
): ScheduleRunMoneyDetail | undefined {
  if (!isRecord(value)) return undefined;
  const amount = value["amount"];
  const currency = value["currency"];
  const approximate = value["approximate"];
  if (
    typeof amount !== "number"
    || !Number.isFinite(amount)
    || amount < 0
    || (currency !== "USD" && currency !== "CNY")
    || typeof approximate !== "boolean"
    || value["kind"] !== expectedKind
  ) return undefined;
  const amountMicros = Math.round(amount * 1_000_000);
  if (!Number.isSafeInteger(amountMicros)) return undefined;
  const estimateReasons = Array.isArray(value["estimateReasons"])
    ? value["estimateReasons"].filter((reason): reason is string => typeof reason === "string").slice(0, 32)
    : [];
  return { amountMicros, currency, approximate, estimateReasons };
}

function scheduleRunMoneyMicros(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new StoreError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function scheduleRunMoneyCurrency(value: string): "USD" | "CNY" {
  if (value !== "USD" && value !== "CNY") throw new StoreError("Schedule run currency is unsupported.");
  return value;
}

function scheduleRunCostAttributionDetail(
  value: unknown
): "exact" | "direct" | "mixed" | "zero" | "unavailable" | undefined {
  return value === "exact" || value === "direct" || value === "mixed"
    || value === "zero" || value === "unavailable"
    ? value
    : undefined;
}

function mergeScheduleRunCostAttribution(
  current: ReturnType<typeof scheduleRunCostAttributionDetail>,
  next: "exact" | "direct"
): "exact" | "direct" | "mixed" {
  if (current === "mixed") return "mixed";
  if (current === "exact" || current === "direct") return current === next ? current : "mixed";
  return next;
}

function scheduleRunDetailWithReadAt(value: unknown, readAt: number | undefined): unknown {
  if (readAt === undefined) return value;
  return { ...(isRecord(value) ? value : {}), readAt };
}

function terminalScheduleHistoryStatus(status: string): boolean {
  return ["success", "succeeded", "completed", "skipped", "aborted", "interrupted", "cancelled", "failed"]
    .includes(status.toLowerCase());
}

function unreadScheduleHistoryStatus(status: string): boolean {
  return ["success", "succeeded", "completed", "aborted", "interrupted", "cancelled", "failed"]
    .includes(status.toLowerCase());
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  if (leftBytes.byteLength !== rightBytes.byteLength) {
    const dummy = Buffer.alloc(leftBytes.byteLength);
    timingSafeEqual(leftBytes, dummy);
    return false;
  }
  return timingSafeEqual(leftBytes, rightBytes);
}

function normalizeSha256(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/^sha256:/u, "");
  if (!/^[a-f0-9]{64}$/u.test(normalized)) throw new StoreError("Artifact SHA-256 is invalid.");
  return normalized;
}

function validateReviewSeal(value: CreateReviewRunInput["evidenceSeal"]): void {
  if (value.version !== 1) throw new StoreError("Review evidence seal version is unsupported.");
  for (const [label, digest] of Object.entries({
    conversation: value.conversationSha256,
    workspace: value.workspaceSha256,
    files: value.filesSha256,
    artifacts: value.artifactsSha256,
    seal: value.sealSha256
  })) {
    if (!/^[a-f0-9]{64}$/u.test(digest)) throw new StoreError(`Review ${label} SHA-256 is invalid.`);
  }
  const expectedSeal = createHash("sha256")
    .update("joko.review.freshness/v1")
    .update("\0")
    .update("seal")
    .update("\0")
    .update(JSON.stringify([
      value.conversationSha256,
      value.workspaceSha256,
      value.filesSha256,
      value.artifactsSha256
    ]))
    .digest("hex");
  if (value.sealSha256 !== expectedSeal) throw new StoreError("Review aggregate evidence seal is inconsistent.");
}

function validateReviewAttachments(values: CreateReviewRunInput["attachments"]): void {
  if (values.length > 20) throw new RangeError("A review accepts at most 20 durable attachments.");
  const blobIds = new Set<string>();
  for (const value of values) {
    if (!(["file", "image"] as const).includes(value.kind)) throw new StoreError("Review attachment kind is invalid.");
    validateReviewBasename(value.displayName, "Review attachment display name");
    const keys = Object.keys(value.blob);
    if (keys.some((key) => !["id", "sha256", "byteLength", "mimeType", "fileName"].includes(key))) {
      throw new StoreError("Review attachment BlobRef contains forbidden fields.");
    }
    const id = durableOpaqueId(value.blob.id, "Review attachment Blob ID");
    if (id.length > 500) throw new StoreError("Review attachment Blob ID is invalid.");
    if (blobIds.has(id)) throw new StoreError(`Duplicate review attachment Blob ID: ${id}`);
    blobIds.add(id);
    normalizeSha256(value.blob.sha256);
    if (!Number.isSafeInteger(value.blob.byteLength) || value.blob.byteLength < 0) throw new StoreError("Review attachment byte length is invalid.");
    const mimeType = nonBlank(value.blob.mimeType, "Review attachment MIME type");
    if (mimeType.length > 255 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:\s*;[\x20-\x7e]+)?$/iu.test(mimeType)) {
      throw new StoreError("Review attachment MIME type is invalid.");
    }
    if (value.blob.fileName !== undefined) validateReviewBasename(value.blob.fileName, "Review attachment file name");
  }
}

function validateReviewBasename(value: string, label: string): void {
  const normalized = nonBlank(value, label);
  if (normalized.length > 500 || normalized === "." || normalized === ".." || /[\\/\p{Cc}\u2028\u2029]/u.test(normalized)
    || /^[a-z]:/iu.test(normalized) || /^[a-z][a-z0-9+.-]*:/iu.test(normalized)) {
    throw new StoreError(`${label} must be a bounded basename, not a path.`);
  }
}

function boundedReviewResult(value: string): string {
  const normalized = redactSecrets(value.normalize("NFC").replace(/\r\n?/gu, "\n"))
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/giu, "[REDACTED PRIVATE KEY]")
    .replace(/(^|\n)([\t ]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|authorization|password|passwd|secret|cookie|credential)\s*[:=]\s*)([^\r\n]+)/giu, "$1$2[REDACTED]")
    .replace(/\b[A-Za-z]:[\\/](?:[^\s<>:"|?*\r\n]+[\\/])*[^\s<>:"|?*\r\n]*/gu, "[redacted-absolute-path]")
    .replace(/\/(?:Users|home|var|tmp|opt|srv|private|Volumes)\/(?:[^\s<>"'`\r\n]+\/?)+/gu, "[redacted-absolute-path]")
    .replace(/(^|[\s(])\/(?!\/)(?:[^\s<>"'`\r\n]+\/?)+/gmu, "$1[redacted-absolute-path]")
    .trim();
  const length = [...normalized].length;
  if (length === 0 || length > 100_000) throw new RangeError("Completed review result must contain between 1 and 100000 characters.");
  return normalized;
}

function reviewFreshnessTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new StoreError("Review freshness checkedAt must be a non-negative safe integer.");
  }
  return value;
}

function durableOpaqueId(value: string, label: string): string {
  const normalized = nonBlank(value, label);
  if (normalized.length > 500 || /[\\/\p{Cc}\u2028\u2029]/u.test(normalized)
    || /^[a-z]:/iu.test(normalized) || /^[a-z][a-z0-9+.-]*:\/\//iu.test(normalized)) {
    throw new StoreError(`${label} must be an opaque identifier, not a path or URI.`);
  }
  return normalized;
}

function sameReviewCreateRequest(bundle: ReviewRunBundle, input: CreateReviewRunInput): boolean {
  if (bundle.run.sourceSessionId !== input.sourceSessionId || bundle.run.targetKind !== input.targetKind) return false;
  const seal = bundle.evidenceSeal;
  const expected = input.evidenceSeal;
  if (seal.version !== expected.version
    || seal.conversationSha256 !== expected.conversationSha256
    || seal.workspaceSha256 !== expected.workspaceSha256
    || seal.filesSha256 !== expected.filesSha256
    || seal.artifactsSha256 !== expected.artifactsSha256
    || seal.sealSha256 !== expected.sealSha256) return false;
  if (bundle.attachments.length !== input.attachments.length) return false;
  return bundle.attachments.every((actual, index) => {
    const wanted = input.attachments[index];
    return wanted !== undefined
      && actual.kind === wanted.kind
      && actual.displayName === wanted.displayName
      && actual.blob.id === wanted.blob.id
      && actual.blob.sha256 === wanted.blob.sha256.toLowerCase().replace(/^sha256:/u, "")
      && actual.blob.byteLength === wanted.blob.byteLength
      && actual.blob.mimeType === wanted.blob.mimeType.toLowerCase()
      && actual.blob.fileName === wanted.blob.fileName;
  });
}

function optionalReviewFailureCode(value: unknown): { readonly failureCode?: ReviewRunRecord["failureCode"] } {
  if (value === null || value === undefined) return {};
  const failureCode = enumValue(value, REVIEW_FAILURE_CODES);
  return { failureCode };
}

function remoteHostIdentity(value: string, label: string, maximumLength: number): string {
  if (typeof value !== "string") throw new StoreError(`Remote Host ${label} must be text.`);
  if (
    value.length === 0 ||
    value.length > maximumLength ||
    value !== value.trim() ||
    /[\p{Cc}\u2028\u2029]/u.test(value)
  ) {
    throw new StoreError(`Remote Host ${label} is invalid.`);
  }
  return value;
}

function remoteHostAlias(value: string): string {
  const alias = remoteHostIdentity(value, "alias", 256);
  if (alias.startsWith("!") || /[\s*?'"\\#]/u.test(alias)) {
    throw new StoreError("Remote Host alias must identify one concrete host.");
  }
  return alias;
}

function remoteHostHostname(value: string): string {
  const hostname = remoteHostIdentity(value, "hostname", 1_024);
  if (/[\s/@'"\\#]/u.test(hostname)) {
    throw new StoreError("Remote Host hostname is invalid.");
  }
  return hostname;
}

function remoteHostPort(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new StoreError("Remote Host port must be an integer between 1 and 65535.");
  }
  return value;
}

function remoteHostUser(value: string): string {
  const user = remoteHostIdentity(value, "user", 256);
  if (/[\s@'"\\#]/u.test(user)) throw new StoreError("Remote Host user is invalid.");
  return user;
}

function remoteHostSource(value: string): RemoteHostSource {
  if (value !== "manual" && value !== "ssh_config") {
    throw new StoreError("Remote Host source is invalid.");
  }
  return value;
}

function remoteHostAuthenticationMode(value: string): RemoteHostAuthenticationMode {
  if (value !== "system_agent" && value !== "private_key") {
    throw new StoreError("Remote Host authentication mode is invalid.");
  }
  return value;
}

function assertRemoteHostAuthentication(
  mode: RemoteHostAuthenticationMode,
  credentialReferenceId: string | undefined
): void {
  if (mode === "system_agent" && credentialReferenceId !== undefined) {
    throw new StoreError("System-agent authentication cannot persist a credential reference.");
  }
  if (mode === "private_key" && credentialReferenceId === undefined) {
    throw new StoreError("Private-key authentication requires a credential reference.");
  }
}

function remoteWorkspaceRoot(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 16_384 ||
    value !== value.trim() ||
    !value.startsWith("/") ||
    value.includes("\0") ||
    /[\r\n]/u.test(value)
  ) {
    throw new StoreError("Remote workspace root must be an absolute POSIX path.");
  }
  const segments = value.split("/");
  if (
    value !== "/" &&
    segments.some((segment, index) => index > 0 && (segment.length === 0 || segment === "." || segment === ".."))
  ) {
    throw new StoreError("Remote workspace root must be a normalized absolute POSIX path.");
  }
  return value;
}

function sameRemoteWorkspace(
  left: TargetDescriptor["remoteWorkspace"],
  right: TargetDescriptor["remoteWorkspace"]
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.hostId === right.hostId && left.workspaceRoot === right.workspaceRoot;
}

function remoteHostCredentialReference(value: string): string {
  if (
    typeof value !== "string" ||
    value.length > 512 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/u.test(value)
  ) {
    throw new StoreError("Remote Host credential reference is invalid.");
  }
  return value;
}

function remoteHostTimestamp(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new StoreError(`Remote Host ${label} must be a non-negative safe integer.`);
  }
  return value;
}

function remoteHostStatus(value: string): RemoteHostStatus {
  if (!(Object.keys(REMOTE_HOST_STATUS_TRANSITIONS) as RemoteHostStatus[]).includes(value as RemoteHostStatus)) {
    throw new StoreError("Remote Host status is invalid.");
  }
  return value as RemoteHostStatus;
}

function remoteHostFailureCode(value: string): RemoteHostFailureCode {
  if (!(REMOTE_HOST_FAILURE_CODES as readonly string[]).includes(value)) {
    throw new StoreError("Remote Host failure code is invalid.");
  }
  return value as RemoteHostFailureCode;
}

function remoteHostTrustAlgorithm(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9@._+-]{0,127}$/u.test(value)) {
    throw new StoreError("Remote Host trust algorithm is invalid.");
  }
  return value;
}

function remoteHostTrustFingerprint(value: string): string {
  if (typeof value !== "string" || !/^SHA256:[A-Za-z0-9+/]{43}$/u.test(value)) {
    throw new StoreError("Remote Host trust fingerprint is invalid.");
  }
  return value;
}

function assertRemoteHostRevision(record: RemoteHostRecord, expectedRevision: bigint): void {
  if (record.revision !== expectedRevision) {
    throw new RevisionConflictError("Remote Host", record.id, expectedRevision, record.revision);
  }
}

function isRemoteHostActive(status: RemoteHostStatus): boolean {
  return status === "connecting" || status === "authenticating" || status === "ready";
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized < 1 || normalized > 100_000) {
    throw new RangeError("Query limit must be an integer between 1 and 100000.");
  }
  return normalized;
}

function normalizeOffset(value: number | undefined): number {
  const normalized = value ?? 0;
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new RangeError("Query offset must be a non-negative safe integer.");
  }
  return normalized;
}

function nonBlank(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized === "") throw new StoreError(`${label} must not be blank.`);
  return normalized;
}

function queueLockToken(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 16 || normalized.length > 256 || normalized.includes("\0")) {
    throw new StoreError("Queue lock token is invalid.");
  }
  return normalized;
}

function queueLockTtl(value: number | undefined): number {
  const ttl = value ?? DEFAULT_QUEUE_LOCK_TTL_MS;
  if (!Number.isSafeInteger(ttl) || ttl < MIN_QUEUE_LOCK_TTL_MS || ttl > MAX_QUEUE_LOCK_TTL_MS) {
    throw new StoreError("Queue lock lifetime is invalid.");
  }
  return ttl;
}

function sessionAutomationIdentity(value: string, label: string): string {
  if (value.trim().length === 0 || value.length > 256 || value.includes("\0")) {
    throw new StoreError(`${label} is invalid.`);
  }
  return value;
}

function sessionAutomationName(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 256 || normalized.includes("\0")) {
    throw new StoreError("Session automation Schedule name is invalid.");
  }
  return normalized;
}

function normalizeSessionDerivationOrigin(
  value: SessionDescriptor["derivationOrigin"]
): SessionDescriptor["derivationOrigin"] {
  if (value === undefined) return undefined;
  if (value.kind !== "fork" && value.kind !== "clone") {
    throw new StoreError("Session derivation kind is invalid.");
  }
  const sourceSessionId = boundedSessionDerivationIdentity(
    value.sourceSessionId,
    "Session derivation source Session ID"
  );
  if ((value.sourceMessageId === undefined) !== (value.sourceEventId === undefined)) {
    throw new StoreError("Session derivation message identity is incomplete.");
  }
  if (value.sourceMessageId === undefined || value.sourceEventId === undefined) {
    if (value.kind === "fork") throw new StoreError("A fork requires a source message identity.");
    return { kind: value.kind, sourceSessionId };
  }
  return {
    kind: value.kind,
    sourceSessionId,
    sourceMessageId: boundedSessionDerivationIdentity(
      value.sourceMessageId,
      "Session derivation source message ID"
    ),
    sourceEventId: boundedSessionDerivationIdentity(
      value.sourceEventId,
      "Session derivation source Event ID"
    )
  };
}

function boundedSessionDerivationIdentity(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 1_024 || /[\p{Cc}\u2028\u2029]/u.test(normalized)) {
    throw new StoreError(`${label} is invalid.`);
  }
  return normalized;
}

function sessionTimelineMessageId(event: PersistedEvent): string {
  if (event.payload.type !== "message_complete") {
    throw new StoreError("Session derivation Event is not a message.");
  }
  return event.payload.nativeHistory?.identity?.entryId || event.id;
}

function objectiveStatus(value: string): ObjectiveStatus {
  const statuses: readonly ObjectiveStatus[] = [
    "active",
    "paused",
    "blocked",
    "complete",
    "budget_limited",
    "usage_limited",
    "dispatch_unknown"
  ];
  if (!statuses.includes(value as ObjectiveStatus)) throw new StoreError("Objective status is invalid.");
  return value as ObjectiveStatus;
}

function objectiveText(value: string): string {
  if (typeof value !== "string") throw new StoreError("Objective text must be text.");
  const normalized = value.normalize("NFC").replace(/\r\n?/gu, "\n").trim();
  if (normalized.length === 0 || [...normalized].length > 32_000 || normalized.includes("\0")) {
    throw new StoreError("Objective text must contain between 1 and 32000 safe characters.");
  }
  return normalized;
}

function objectiveReason(value: string): string {
  if (typeof value !== "string") throw new StoreError("Objective reason must be text.");
  const normalized = redactSecrets(value.normalize("NFC").replace(/\r\n?/gu, "\n")).trim();
  if (normalized.length === 0 || [...normalized].length > 2_048 || normalized.includes("\0")) {
    throw new StoreError("Objective reason must contain between 1 and 2048 safe characters.");
  }
  return normalized;
}

function objectiveLimit(value: number, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new StoreError(`Objective ${label} must be an integer between 1 and ${maximum}.`);
  }
  return value;
}

function optionalObjectiveLimit(
  value: number | undefined,
  label: string,
  maximum: number
): number | undefined {
  return value === undefined ? undefined : objectiveLimit(value, label, maximum);
}

function objectiveCounter(value: number, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new StoreError(`Objective ${label} must be an integer between 0 and ${maximum}.`);
  }
  return value;
}

function objectiveTimestamp(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new StoreError(`Objective ${label} must be a non-negative safe integer.`);
  }
  return value;
}

function nextObjectiveOwnerGeneration(current: number): number {
  if (!Number.isSafeInteger(current) || current < 1 || current >= Number.MAX_SAFE_INTEGER) {
    throw new StoreError("Objective owner generation cannot advance safely.");
  }
  return current + 1;
}

function assertObjectiveFence(
  current: ObjectiveRecord,
  expectedRevision: bigint,
  expectedOwnerGeneration: number
): void {
  if (current.ownerGeneration !== expectedOwnerGeneration) {
    throw new StaleGenerationError(expectedOwnerGeneration, current.ownerGeneration);
  }
  if (current.revision !== expectedRevision) {
    throw new RevisionConflictError(
      "Objective",
      current.sessionId,
      expectedRevision,
      current.revision
    );
  }
}

function assertObjectivePendingWork(
  store: OperationalStore,
  sessionId: string,
  pending: NonNullable<UpdateObjectiveInput["pending"]>
): void {
  const operation = store.getOperation(pending.operationId);
  const run = store.getRun(pending.runId);
  const attempt = store.getAttempt(pending.attemptId);
  const queueItem = store.getQueueItem(pending.queueItemId);
  if (
    run.descriptor.sessionId !== sessionId ||
    attempt.descriptor.runId !== run.descriptor.id ||
    queueItem.sessionId !== sessionId ||
    queueItem.runId !== run.descriptor.id ||
    queueItem.attemptId !== attempt.descriptor.id ||
    queueItem.operationId !== operation.id ||
    queueItem.state !== "accepted"
  ) {
    throw new StoreError("Objective pending work does not match one accepted Session queue item.");
  }
}

function boundedSessionNavigationText(value: string, maximumCodePoints: number, label: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (normalized === "" || normalized.includes("\0")) {
    throw new StoreError(`${label} must contain safe visible text.`);
  }
  const codePoints = [...normalized];
  if (codePoints.length > maximumCodePoints) {
    throw new StoreError(`${label} exceeds its maximum length.`);
  }
  return normalized;
}

function boundedSchedulerRuntimeId(value: string, label: string): string {
  const normalized = nonBlank(value, label);
  if (normalized.length > 256 || normalized.includes("\u0000")) {
    throw new StoreError(`${label} is invalid.`);
  }
  return normalized;
}

function schedulerRuntimeTimestamp(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new StoreError(`${label} must be a non-negative safe integer.`);
  return value;
}

function checkedSchedulerGeneration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new StoreError("Scheduler runtime generation must be a positive safe integer.");
  }
  return value;
}

function schedulerRuntimePhase(value: ScheduleRuntimeOccurrencePhase): ScheduleRuntimeOccurrencePhase {
  const phases: readonly ScheduleRuntimeOccurrencePhase[] = [
    "loading",
    "claiming",
    "persisting",
    "running",
    "queued",
    "cancelling",
    "finalizing",
    "stalled",
    "recovering"
  ];
  if (!phases.includes(value)) throw new StoreError("Schedule runtime phase is invalid.");
  return value;
}

function boolInt(value: boolean): number {
  return value ? 1 : 0;
}

function localRuntimeScope(value: LocalRuntimeOwnerScope): LocalRuntimeOwnerScope {
  return {
    ownerId: localRuntimeIdentity(value.ownerId, "owner ID", 256),
    runtimeId: localRuntimeId(value.runtimeId),
    ownerGeneration: localRuntimeGeneration(value.ownerGeneration)
  };
}

function localRuntimeIdentity(value: string, label: string, maximumLength: number): string {
  if (
    typeof value !== "string"
    || value.trim() === ""
    || value.length > maximumLength
    || /[\u0000\r\n]/u.test(value)
  ) throw new StoreError(`Local runtime ${label} is invalid.`);
  return value;
}

function localRuntimeId(value: string): string {
  const runtimeId = localRuntimeIdentity(value, "ID", 64);
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(runtimeId)) throw new StoreError("Local runtime ID is invalid.");
  return runtimeId;
}

function localRuntimeGeneration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new StoreError("Local runtime owner generation is invalid.");
  return value;
}

function localRuntimeTimestamp(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new StoreError(`Local runtime ${label} is invalid.`);
  return value;
}

function localRuntimeLeaseDuration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 300_000) {
    throw new StoreError("Local runtime installation lease duration is invalid.");
  }
  return value;
}

function localRuntimeVersion(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u.test(value)) throw new StoreError("Local runtime version is invalid.");
  return value;
}

function localRuntimeSha256(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/^sha256:/u, "");
  if (!/^[a-f0-9]{64}$/u.test(normalized)) throw new StoreError("Local runtime archive SHA-256 is invalid.");
  return normalized;
}

function localRuntimePublicErrorCode(value: string): string {
  if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(value)) throw new StoreError("Local runtime public error code is invalid.");
  return value;
}

function localRuntimeModelIdentity(value: string, label: string): string {
  const model = localRuntimeIdentity(value, label, 512);
  if (
    model.startsWith("/")
    || model.startsWith("\\")
    || model.includes("\\")
    || /^[A-Za-z]:\//u.test(model)
    || model.split("/").some((segment) => segment === "." || segment === "..")
  ) throw new StoreError(`Local runtime ${label} is path-like.`);
  return model;
}

function localRuntimeCounter(value: number, label: string, allowZero: boolean): number {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new StoreError(`Local model pull ${label} is invalid.`);
  }
  return value;
}

function optionalLocalRuntimeCounter<K extends string>(
  key: K,
  value: unknown,
  allowZero: boolean
): { readonly [P in K]?: number } {
  return value === null || value === undefined
    ? {}
    : { [key]: localRuntimeCounter(numberValue(value), key, allowZero) } as { [P in K]: number };
}

function localRuntimePercent(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 100) throw new StoreError("Local model pull percent is invalid.");
  return value;
}

function localRuntimeDigests(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 256) throw new StoreError("Local model pull digest list is invalid.");
  const digests = value.map((item) => {
    if (typeof item !== "string" || !/^sha256:[a-f0-9]{64}$/iu.test(item)) {
      throw new StoreError("Local model pull digest is invalid.");
    }
    return item.toLowerCase();
  });
  return [...new Set(digests)].sort();
}

function localRuntimeModelIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 512) throw new StoreError("Local runtime Provider model list is invalid.");
  const modelIds = value.map((item) => {
    if (typeof item !== "string") throw new StoreError("Local runtime Provider model ID is invalid.");
    return localRuntimeModelIdentity(item, "Provider model ID");
  });
  if (new Set(modelIds).size !== modelIds.length) throw new StoreError("Local runtime Provider model list contains duplicates.");
  return [...modelIds].sort((left, right) => left.localeCompare(right, "en"));
}

function usageIdentity(value: string, label: string, maximumLength: number, allowEmpty: boolean): string {
  if (
    typeof value !== "string"
    || (!allowEmpty && value.trim().length === 0)
    || value.length > maximumLength
    || /[\u0000\r\n]/u.test(value)
  ) throw new StoreError(`${label} is invalid.`);
  return value;
}

function safeUsageInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new StoreError(`${label} must be a safe non-negative integer.`);
  return value;
}

function usageCounterDelta(current: number, stored: unknown): number {
  if (stored === undefined || stored === null) return current;
  const previous = numberValue(stored);
  return current >= previous ? current - previous : current;
}

function usageEstimatedCost(
  delta: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
  },
  rates: {
    readonly inputMicrosPerMillion: number;
    readonly outputMicrosPerMillion: number;
    readonly cacheReadMicrosPerMillion?: number;
    readonly cacheWriteMicrosPerMillion?: number;
  }
): { readonly costMicros: number; readonly complete: boolean } {
  const value = (
    delta.inputTokens * rates.inputMicrosPerMillion
    + delta.outputTokens * rates.outputMicrosPerMillion
    + delta.cacheReadTokens * (rates.cacheReadMicrosPerMillion ?? 0)
    + delta.cacheWriteTokens * (rates.cacheWriteMicrosPerMillion ?? 0)
  ) / 1_000_000;
  if (!Number.isFinite(value) || value > Number.MAX_SAFE_INTEGER) {
    throw new StoreError("Estimated usage cost exceeds the safe integer range.");
  }
  return {
    costMicros: Math.round(value),
    complete: (delta.cacheReadTokens === 0 || rates.cacheReadMicrosPerMillion !== undefined)
      && (delta.cacheWriteTokens === 0 || rates.cacheWriteMicrosPerMillion !== undefined)
  };
}

function safeUsageSum(values: readonly number[], label: string): number {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isSafeInteger(total) || total < 0) throw new StoreError(`${label} exceeds the safe integer range.`);
  }
  return total;
}

function usageDay(measuredAt: number): string {
  const day = new Date(measuredAt).toISOString().slice(0, 10);
  return validUsageDay(day);
}

function validUsageDay(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00.000Z`))) {
    throw new StoreError("Usage day is invalid.");
  }
  return value;
}

function usageCurrency(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z]{3,8}$/u.test(normalized)) throw new StoreError("Usage currency is invalid.");
  return normalized;
}

function modelPriceCurrency(value: string): "USD" | "CNY" {
  if (value !== "USD" && value !== "CNY") throw new StoreError("Model price currency is invalid.");
  return value;
}

function booleanValue(value: unknown): boolean {
  return numberValue(value) === 1;
}

function stringValue(value: unknown): string {
  if (typeof value !== "string") throw new StoreError(`Expected SQLite text, received ${typeof value}.`);
  return value;
}

function numberValue(value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "bigint" && value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(value);
  }
  throw new StoreError("SQLite integer exceeds the JavaScript safe integer range.");
}

function toBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^-?\d+$/u.test(value)) return BigInt(value);
  throw new StoreError("Expected a SQLite integer.");
}

function asSqlInteger(value: bigint): number | bigint {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
    ? Number(value)
    : value;
}

function enumValue<const T extends readonly string[]>(value: unknown, allowed: T): T[number] {
  const text = stringValue(value);
  if (!allowed.includes(text)) throw new StoreError(`Unexpected SQLite enum value: ${text}.`);
  return text as T[number];
}

function optionalString<K extends string>(key: K, value: unknown): { readonly [P in K]?: string } {
  return value === null || value === undefined ? {} : { [key]: stringValue(value) } as { [P in K]: string };
}

function optionalNumber<K extends string>(key: K, value: unknown): { readonly [P in K]?: number } {
  return value === null || value === undefined ? {} : { [key]: numberValue(value) } as { [P in K]: number };
}

function optionalJson<T, K extends string>(key: K, value: unknown): { readonly [P in K]?: T } {
  return value === null || value === undefined
    ? {}
    : { [key]: parseJson<T>(stringValue(value)) } as { [P in K]: T };
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" && value !== null) || typeof value === "function"
  ) && typeof (value as { readonly then?: unknown }).then === "function";
}
