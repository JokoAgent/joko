import { createHash } from "node:crypto";
import {
  ActorKind,
  ArtifactKind,
  AttemptState,
  AuthenticationState,
  BackgroundTaskState,
  BackendHealth,
  BlobDisposition,
  CapabilitySupport,
  CodeHostPullRequestState,
  CompactionState,
  ConnectionState,
  ContextRebuildReason as ProtoContextRebuildReason,
  ErrorSeverity,
  ExtensionWidgetPlacement,
  ExtraDirectoryAccess,
  FileChangeKind,
  FileKind,
  GitDiffSource,
  GitFileStatus,
  InstallationState,
  InteractionKind,
  InteractionState,
  MessageInputDelivery as ProtoMessageInputDelivery,
  MessageRole,
  ModelInputModality,
  ModelOutputModality,
  ModelPriceSource,
  NativeSessionChangeKind,
  OperationState,
  PermissionDecisionKind,
  PermissionMode,
  PermissionRisk,
  PlanReviewDecisionKind,
  ProviderApiCompatibility,
  ProviderCredentialSurfaceCapability,
  ProviderCredentialSurfaceKind,
  ProviderKind,
  ProviderLoginMethod,
  QueueDeliveryMode,
  QueueDispatchState,
  QueueItemState,
  QueueSourceKind,
  RecoveryActionKind,
  RewindGapKind,
  RetryState,
  RuntimeRecoveryState as ProtoRuntimeRecoveryState,
  ReviewFailureCode,
  ReviewFreshnessState,
  ReviewRunState,
  ReviewTargetKind,
  RunState,
  ScheduleMisfirePolicy,
  ScheduleOverlapPolicy,
  ScheduleSessionMode,
  ScheduleSource,
  ScheduleState,
  ServerHealth,
  SessionDerivationKind,
  SessionState,
  SessionWorktreeState,
  StateImpact,
  TargetState,
  ToolCallState,
  ToolLeaseState,
  WorktreeSourceStrategy,
  type ActorRef,
  type Acknowledgement,
  type Artifact,
  type ArtifactRef,
  type ArtifactProducedEvent,
  type Attempt,
  type BackgroundTask,
  type BackgroundTaskChangedEvent,
  type BackendDescriptor as ProtoBackendDescriptor,
  type BlobRef as ProtoBlobRef,
  type Capability as ProtoCapability,
  type CapabilityManifest,
  type CapabilityOptions,
  type Connection,
  type ContextUsage,
  type ContextUsageChangedEvent,
  type ContextRebuiltEvent,
  type CronRecurrence,
  type CustomToolPermissionSubject,
  type DisplayArgument,
  type DismissalResolution,
  type EffortLevel,
  type EntityVersion,
  type ErrorInfo,
  type ExtraDirectory as ProtoExtraDirectory,
  type FileChange,
  type FileDiff,
  type FileRevision,
  type GitFileChange,
  type GitRepositoryState,
  type HistoryPrunedEvent,
  type Event as ProtoEvent,
  type EventCursor,
  type EventIdentity,
  type EventPayload as ProtoEventPayload,
  type ExtensionConfirmRequest,
  type ExtensionEditorRequest,
  type ExtensionInputRequest,
  type ExtensionSelectRequest,
  type ExtensionUiInteraction,
  type ExtensionUiEffectEvent,
  type ExtensionUiResolution,
  type ExtensionStatus,
  type ExtensionStatusChangedEvent,
  type ExtensionWidget,
  type ExtensionWidgetChangedEvent,
  type ImageRef,
  type InputContent,
  type InputPart,
  type InlineTextRange as ProtoInlineTextRange,
  type Interaction as ProtoInteraction,
  type InteractionResolution,
  type InteractionChangedEvent,
  type IntervalRecurrence,
  type ManualRecurrence,
  type ModelDescriptor,
  type ModelKey,
  type ModelSelection,
  type MessageAutomationOrigin as ProtoMessageAutomationOrigin,
  type MessageCompletedEvent,
  type MessageStartedEvent,
  type NativeMessageIdentity as ProtoNativeMessageIdentity,
  type NativeSessionBinding as ProtoNativeSessionBinding,
  type NativeSessionChangedEvent,
  type OneShotRecurrence,
  type Operation as ProtoOperation,
  type OperationResult,
  type PermissionRequest,
  type PermissionResolution,
  type PermissionSubject,
  type PiEventMetadata as ProtoPiEventMetadata,
  type PlanReviewRequest,
  type PlanReviewResolution,
  type ProviderCapabilityModelDescriptor,
  type ProviderCredentialSurface,
  type ProviderDescriptor,
  type QuestionAnswer,
  QuestionAnswerHandling,
  type QuestionBooleanInput,
  type QuestionChoice,
  type QuestionField,
  type QuestionMultipleChoiceInput,
  type QuestionRequest,
  type QuestionResolution,
  type QuestionSingleChoiceInput,
  type QuestionTextInput,
  type QueueItem as ProtoQueueItem,
  type QueueItemChangedEvent,
  type QueueControl,
  type QueueControlChangedEvent,
  type RecoveryAction,
  type RewindGap,
  type ResourceMention,
  type Revision,
  type RetryChangedEvent,
  type ReviewEvidenceSummary,
  type ReviewFreshness,
  type ReviewRun as ProtoReviewRun,
  type ReviewRunChangedEvent,
  type ReviewSourceRevision,
  type RuntimeCommandsChangedEvent,
  type RuntimeRecoveryChangedEvent,
  type RunAbortedEvent,
  type RunDoneEvent,
  type Run as ProtoRun,
  type Schedule as ProtoSchedule,
  type ScheduleExecutionSnapshot,
  type ScheduleRecurrence,
  type ScheduleRunHistory,
  type ServerInfo,
  type Session as ProtoSession,
  type SessionWorktree as ProtoSessionWorktree,
  type StatusStreamEvent,
  type StringList,
  type Target as ProtoTarget,
  type ToolCall,
  type ToolCallCompletedEvent,
  type ToolCallStartedEvent,
  type ToolCallUpdatedEvent,
  type ToolLease as ProtoToolLease,
  type ToolResult,
  type ToolResultPart,
  type TerminalErrorEvent,
  type TextDeltaEvent,
  type ThinkingDeltaEvent,
  type TraceContext,
  type Usage,
  type RecoverableErrorEvent,
  type CompactionChangedEvent,
  type WorkspaceMention,
  type WorkspaceChangeSet,
  type WorkspaceDescriptor,
  type WorkspaceDiff,
  type WorkspaceDiffProducedEvent,
  type WorkspaceEntry,
  WorkspaceKind
} from "@joko/contracts";
import * as contract from "@joko/contracts";
import type { CodeHostSessionReferenceProjection } from "@joko/code-host";
import { redactSecrets, sanitizePublicError } from "@joko/core";
import { validatedProviderCredentialSurfaces } from "./provider-credential-surface.js";
import {
  PROJECT_AUTOMATION_CONFIG_PATH,
  scheduleProjectAutomationOrigin,
  withScheduleProjectAutomationOrigin
} from "./project-automation-config.js";
import type {
  PiEventMetadata as CorePiEventMetadata,
  AttemptDescriptor,
  BackendDescriptor,
  BackendProviderAccessKind,
  BackendProviderCredentialSurface,
  BlobRef,
  Capability,
  EventPayload,
  InlineTextRange as CoreInlineTextRange,
  InputDisposition,
  InteractionPayload,
  InteractionQuestionField,
  MessageBlock as CoreMessageBlock,
  MessageInputDelivery as CoreMessageInputDelivery,
  NativeMessageIdentity as CoreNativeMessageIdentity,
  NativeSessionBinding,
  PlanReviewDecision,
  PermissionMode as CorePermissionMode,
  PromptInput,
  ProviderModel,
  PublicError,
  QueueState,
  ReviewEvidenceProjection as CoreReviewEvidenceProjection,
  RetryEventState,
  RuntimeCommand as CoreRuntimeCommand,
  RunDescriptor,
  RunState as CoreRunState,
  SessionAttention as CoreSessionAttention,
  SessionDescriptor,
  SessionWorktreeBinding,
  SubagentActivityEntry,
  SubagentChildRun,
  SubagentRun,
  SubagentRunDetail,
  SubagentRunState,
  SubagentTranscriptEntry,
  SubagentUsage,
  TargetDescriptor,
  ToolResultContentPart as CoreToolResultContentPart,
  UsageSnapshot
} from "@joko/core";
import { validInlineTextRanges } from "@joko/core";
import type { ExtraDirectoryRecord } from "./extra-directory-manager.js";
import { TIMED_EXTENSION_INTERACTION_EXPIRED_REASON } from "./interaction-expiry.js";
import {
  scheduleExtensionSnapshot,
  scheduleWorktreeConfiguration,
  withScheduleExtensionSnapshot,
  type ScheduleExtensionSnapshot
} from "./schedule-extensions.js";
import type { SchedulerRuntimeSnapshot as CoreSchedulerRuntimeSnapshot } from "./scheduler-runtime-state.js";
import {
  AsyncTransactionError,
  AuthorizationError,
  InvalidStateTransitionError,
  NotFoundError,
  OperationConflictError,
  OperationPreviouslyFailedError,
  PairingError,
  RevisionConflictError,
  SensitiveDataError,
  StaleGenerationError,
  StoreClosedError,
  StoreError,
  type AppendEventInput,
  type ArtifactRecord,
  type ConnectionRecord,
  type InteractionRecord,
  type OpenInteractionInput,
  type OperationRecord,
  type PersistedEvent,
  type QueueItemRecord,
  type QueueControlRecord,
  type ScheduleRecord,
  type ScheduleRunRecord,
  type ReviewRunRecord,
  type ReviewEvidenceSealRecord,
  type StoredAttempt,
  type StoredBackend,
  type StoredRun,
  type StoredSession,
  type StoredTarget,
  type ToolLeaseRecord,
  type UpsertScheduleInput
} from "@joko/store";

type MessageShape = { readonly $typeName: string };

export type ProtoTimestamp = {
  readonly $typeName: "google.protobuf.Timestamp";
  seconds: bigint;
  nanos: number;
};

export type ProtoDuration = {
  readonly $typeName: "google.protobuf.Duration";
  seconds: bigint;
  nanos: number;
};

export class ProtoMappingError extends Error {
  constructor(
    readonly code: "invalid_argument" | "unsupported_mapping" | "out_of_range" | "malformed_cursor",
    readonly fieldPath: string,
    message: string
  ) {
    super(message);
    this.name = "ProtoMappingError";
  }
}

export interface EventMappingContext {
  readonly queueItem?: QueueItemRecord;
  readonly queueControl?: QueueControlRecord;
  readonly interaction?: InteractionRecord;
  readonly artifact?: ArtifactRecord;
  readonly schedule?: ScheduleRecord;
  readonly run?: StoredRun;
  readonly attempts?: readonly StoredAttempt[];
  readonly session?: StoredSession;
  /** Authoritative service-side joins for a Session projection Event. */
  readonly sessionContext?: SessionMappingContext;
  readonly target?: StoredTarget;
}

type WorkspaceEventPayload = Extract<EventPayload, { readonly type: "workspace_diff" }>;
type WorkspaceChangeSetProjection = NonNullable<WorkspaceEventPayload["changeSet"]>;
type WorkspaceDiffProjection = NonNullable<WorkspaceEventPayload["diff"]>;
type WorkspaceDescriptorProjection = NonNullable<WorkspaceEventPayload["workspace"]>;
type WorkspaceEntryProjection = NonNullable<WorkspaceEventPayload["upsertedEntries"]>[number];
type WorkspaceFileRevisionProjection = NonNullable<WorkspaceEntryProjection["revision"]>;
type WorkspaceGitStatusProjection = NonNullable<WorkspaceDiffProjection["files"]>[number]["status"];

export interface RunMappingContext {
  readonly backendId: string;
  readonly targetId: string;
  readonly attempts?: readonly StoredAttempt[];
  readonly sourceQueueItemId?: string;
}

export interface SessionMappingContext {
  readonly activeRun?: StoredRun;
  readonly runtimeAttached?: boolean;
  readonly usage?: UsageSnapshot;
  readonly usageMeasuredAt?: number;
  readonly activeNativeEntryId?: string;
  readonly codeHostPullRequests?: readonly CodeHostSessionReferenceProjection[];
  readonly derivationOriginAvailability?: {
    readonly sourceSessionAvailable: boolean;
    readonly sourceMessageAvailable: boolean;
  };
  readonly contextState?: {
    readonly compacting?: boolean;
    readonly autoCompaction?: boolean;
    readonly autoRetry?: boolean;
  };
  /** Volatile runtime selection currently applied to the native task. */
  readonly runtimeModel?: {
    readonly providerId: string;
    readonly modelId: string;
    readonly effort?: string;
    readonly fastMode: boolean;
  };
}

export interface InteractionRouting {
  readonly backendId: string;
  readonly targetId: string;
}

export function toProtoTimestamp(unixMillis: number): ProtoTimestamp {
  if (!Number.isSafeInteger(unixMillis)) {
    throw new ProtoMappingError("out_of_range", "timestamp", "Timestamp milliseconds must be a safe integer.");
  }
  const seconds = Math.floor(unixMillis / 1_000);
  const nanos = (unixMillis - seconds * 1_000) * 1_000_000;
  return message<ProtoTimestamp>("google.protobuf.Timestamp", { seconds: BigInt(seconds), nanos });
}

export function fromProtoTimestamp(timestamp: ProtoTimestamp | undefined, fieldPath = "timestamp"): number | undefined {
  if (timestamp === undefined) return undefined;
  validateNanoseconds(timestamp.nanos, fieldPath);
  const millis = timestamp.seconds * 1_000n + BigInt(Math.trunc(timestamp.nanos / 1_000_000));
  if (millis < BigInt(Number.MIN_SAFE_INTEGER) || millis > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ProtoMappingError("out_of_range", fieldPath, "Timestamp is outside the JavaScript safe integer range.");
  }
  return Number(millis);
}

export function toProtoDuration(milliseconds: number): ProtoDuration {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new ProtoMappingError("out_of_range", "duration", "Duration must be non-negative safe integer milliseconds.");
  }
  const seconds = Math.floor(milliseconds / 1_000);
  return message<ProtoDuration>("google.protobuf.Duration", {
    seconds: BigInt(seconds),
    nanos: (milliseconds - seconds * 1_000) * 1_000_000
  });
}

export function fromProtoDuration(duration: ProtoDuration | undefined, fieldPath = "duration"): number | undefined {
  if (duration === undefined) return undefined;
  if (duration.seconds < 0n) {
    throw new ProtoMappingError("out_of_range", fieldPath, "Duration must not be negative.");
  }
  validateNanoseconds(duration.nanos, fieldPath);
  const millis = duration.seconds * 1_000n + BigInt(Math.trunc(duration.nanos / 1_000_000));
  if (millis < 0n || millis > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ProtoMappingError("out_of_range", fieldPath, "Duration is outside the supported range.");
  }
  return Number(millis);
}

export function toProtoRevision(value: bigint): Revision {
  assertUnsigned(value, "revision");
  return message<Revision>("joko.v1.Revision", {
    value,
    etag: `W/\"rev-${value.toString(10)}\"`
  });
}

export function fromProtoRevision(revision: Revision | undefined, fieldPath = "revision"): bigint {
  if (revision === undefined) {
    throw new ProtoMappingError("invalid_argument", fieldPath, "Revision is required.");
  }
  assertUnsigned(revision.value, fieldPath);
  return revision.value;
}

export function toProtoEntityVersion(revision: bigint, generation: number, updatedAt: number): EntityVersion {
  return message<EntityVersion>("joko.v1.EntityVersion", {
    revision: toProtoRevision(revision),
    generation: unsignedBigInt(generation, "generation"),
    updatedAt: toProtoTimestamp(updatedAt)
  });
}

export function encodeCursorToken(sequence: bigint, generation: bigint): string {
  assertUnsigned(sequence, "cursor.sequence");
  assertUnsigned(generation, "cursor.generation");
  return Buffer.from(`joko-v1:${sequence.toString(10)}:${generation.toString(10)}`, "utf8").toString("base64url");
}

export function decodeCursorToken(token: string): { readonly sequence: bigint; readonly generation: bigint } {
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const match = /^joko-v1:(\d+):(\d+)$/u.exec(decoded);
    if (match === null || match[1] === undefined || match[2] === undefined) throw new Error("shape");
    const sequence = BigInt(match[1]);
    const generation = BigInt(match[2]);
    if (encodeCursorToken(sequence, generation) !== token) throw new Error("canonical");
    return { sequence, generation };
  } catch (error) {
    void error;
    throw new ProtoMappingError("malformed_cursor", "cursor.opaque_token", "Event cursor token is malformed.");
  }
}

export function toProtoEventCursor(sequence: bigint, generation: number | bigint, issuedAt: number): EventCursor {
  const normalizedGeneration = typeof generation === "bigint"
    ? generation
    : unsignedBigInt(generation, "cursor.generation");
  return message<EventCursor>("joko.v1.EventCursor", {
    opaqueToken: encodeCursorToken(sequence, normalizedGeneration),
    sequence,
    generation: normalizedGeneration,
    issuedAt: toProtoTimestamp(issuedAt)
  });
}

export function fromProtoEventCursor(cursor: EventCursor | undefined): {
  readonly sequence: bigint;
  readonly generation: bigint;
} {
  if (cursor === undefined) {
    throw new ProtoMappingError("invalid_argument", "cursor", "Event cursor is required.");
  }
  const decoded = decodeCursorToken(cursor.opaqueToken);
  if (decoded.sequence !== cursor.sequence || decoded.generation !== cursor.generation) {
    throw new ProtoMappingError("malformed_cursor", "cursor", "Event cursor fields do not match its opaque token.");
  }
  return decoded;
}

export function toProtoConnection(record: ConnectionRecord): Connection {
  return message<Connection>("joko.v1.Connection", {
    connectionId: record.id,
    connectionProfileId: record.id,
    deviceId: record.deviceId,
    displayName: record.name,
    state: record.state === "active" ? ConnectionState.CONNECTED : ConnectionState.REVOKED,
    createdAt: toProtoTimestamp(record.pairedAt),
    lastSeenAt: optionalTimestamp(record.lastSeenAt),
    version: toProtoEntityVersion(record.revision, 0, record.lastSeenAt ?? record.revokedAt ?? record.pairedAt)
  });
}

export function fromProtoConnection(
  connection: Connection,
  authKeyDigest: string
): { readonly id: string; readonly name: string; readonly authKeyDigest: string; readonly pairedAt?: number } {
  requireText(connection.connectionId, "connection.connection_id");
  requireText(connection.displayName, "connection.display_name");
  requireText(authKeyDigest, "auth_key_digest");
  return {
    id: connection.connectionId,
    name: connection.displayName,
    authKeyDigest,
    ...(fromProtoTimestamp(connection.createdAt) === undefined
      ? {}
      : { pairedAt: fromProtoTimestamp(connection.createdAt) as number })
  };
}

export function toProtoBackend(record: StoredBackend): ProtoBackendDescriptor {
  const backend = record.descriptor;
  return message<ProtoBackendDescriptor>("joko.v1.BackendDescriptor", {
    backendId: backend.id,
    displayName: backend.displayName,
    version: backend.version,
    health: toProtoBackendHealth(backend.health),
    installationState: toProtoBackendInstallationState(backend.installationState),
    authenticationState: toProtoBackendAuthenticationState(backend.authenticationState),
    capabilities: message<CapabilityManifest>("joko.v1.CapabilityManifest", {
      schemaVersion: "joko.core.v1",
      capabilities: [...backend.capabilities.values()].map(toProtoCapability),
      revision: toProtoRevision(record.revision)
    }),
    entityVersion: toProtoEntityVersion(record.revision, backend.instanceGeneration, record.updatedAt),
    error: optionalError(backend.error)
  });
}

export function toProtoTarget(record: StoredTarget): ProtoTarget {
  const metadata = objectValue(record.metadata);
  return message<ProtoTarget>("joko.v1.Target", {
    targetId: record.descriptor.id,
    backendId: record.descriptor.backendId,
    displayName: record.descriptor.displayName,
    workspaceId: stringField(metadata, "workspaceId") ?? record.descriptor.id,
    state: protoTargetState(stringField(metadata, "state")),
    pinned: booleanField(metadata, "pinned") ?? false,
    createdAt: toProtoTimestamp(record.createdAt),
    lastActivityAt: toProtoTimestamp(record.updatedAt),
    version: toProtoEntityVersion(record.revision, 0, record.updatedAt),
    error: undefined,
    remoteWorkspace: toProtoRemoteWorkspace(record.descriptor.remoteWorkspace)
  });
}

export function fromProtoTarget(target: ProtoTarget, workspaceRoot: string): TargetDescriptor {
  requireText(target.targetId, "target.target_id");
  requireText(target.backendId, "target.backend_id");
  requireText(workspaceRoot, "workspace_root");
  return {
    id: target.targetId,
    backendId: target.backendId,
    displayName: target.displayName,
    workspaceRoot,
    managed: false,
    trusted: target.state !== TargetState.ERROR && target.state !== TargetState.DELETING,
    ...(target.remoteWorkspace === undefined
      ? {}
      : { remoteWorkspace: fromProtoRemoteWorkspace(target.remoteWorkspace) })
  };
}

function protoTargetState(value: string | undefined): TargetState {
  switch (value) {
    case "archived": return TargetState.ARCHIVED;
    case "deleting": return TargetState.DELETING;
    case "error": return TargetState.ERROR;
    default: return TargetState.ACTIVE;
  }
}

export function toProtoNativeBinding(
  backendId: string,
  binding: NativeSessionBinding,
  runtimeAttached = false
): ProtoNativeSessionBinding {
  return message<ProtoNativeSessionBinding>("joko.v1.NativeSessionBinding", {
    backendId,
    opaqueReference: binding.opaqueRef,
    runtimeGeneration: unsignedBigInt(binding.generation, "native_binding.runtime_generation"),
    runtimeAttached
  });
}

export function fromProtoNativeBinding(binding: ProtoNativeSessionBinding): NativeSessionBinding {
  requireText(binding.opaqueReference, "native_binding.opaque_reference");
  return {
    opaqueRef: binding.opaqueReference,
    generation: safeNumber(binding.runtimeGeneration, "native_binding.runtime_generation")
  };
}

export function toProtoSession(record: StoredSession, context: SessionMappingContext = {}): ProtoSession {
  const session = record.descriptor;
  const runtimeModel = context.runtimeModel ?? (
    session.providerId === undefined || session.modelId === undefined
      ? undefined
      : {
          providerId: session.providerId,
          modelId: session.modelId,
          ...(session.effort === undefined ? {} : { effort: session.effort }),
          fastMode: session.fastMode
        }
  );
  return message<ProtoSession>("joko.v1.Session", {
    sessionId: session.id,
    backendId: session.backendId,
    targetId: session.targetId,
    projectId: session.projectId,
    automationOrigin: session.automationOrigin === undefined
      ? undefined
      : message<contract.SessionAutomationOrigin>("joko.v1.SessionAutomationOrigin", {
          scheduleId: session.automationOrigin.scheduleId,
          scheduleName: session.automationOrigin.scheduleName ?? "",
          runId: session.automationOrigin.runId
        }),
    derivationOrigin: session.derivationOrigin === undefined
      ? undefined
      : message<contract.SessionDerivationOrigin>("joko.v1.SessionDerivationOrigin", {
          kind: session.derivationOrigin.kind === "fork"
            ? SessionDerivationKind.FORK
            : SessionDerivationKind.CLONE,
          sourceSessionId: session.derivationOrigin.sourceSessionId,
          ...(session.derivationOrigin.sourceMessageId === undefined
            ? {}
            : { sourceMessageId: session.derivationOrigin.sourceMessageId }),
          ...(session.derivationOrigin.sourceEventId === undefined
            ? {}
            : { sourceEventId: session.derivationOrigin.sourceEventId }),
          sourceSessionAvailable: context.derivationOriginAvailability?.sourceSessionAvailable ?? false,
          sourceMessageAvailable: context.derivationOriginAvailability?.sourceMessageAvailable ?? false
        }),
    displayName: session.title,
    taskSummary: session.summary ?? "",
    state: sessionState(session, context.activeRun),
    nativeBinding: toProtoNativeBinding(session.backendId, session.binding, context.runtimeAttached ?? false),
    model: runtimeModel === undefined
      ? undefined
      : toProtoModelSelection(
          runtimeModel.providerId,
          runtimeModel.modelId,
          runtimeModel.effort,
          runtimeModel.fastMode
        ),
    permissionMode: toProtoPermissionMode(session.permissionMode),
    planMode: session.planMode,
    pinned: session.pinned,
    archived: session.archived,
    context: context.usage === undefined
      ? undefined
      : toProtoContextUsage(context.usage, context.usageMeasuredAt ?? session.updatedAt),
    activeNativeEntryId: context.activeNativeEntryId ?? "",
    contextState: context.contextState === undefined
      ? undefined
      : message<contract.SessionContextState>("joko.v1.SessionContextState", {
          compacting: context.contextState.compacting,
          autoCompaction: context.contextState.autoCompaction,
          autoRetry: context.contextState.autoRetry
        }),
    codeHostPullRequests: (context.codeHostPullRequests ?? []).map(toProtoCodeHostPullRequest),
    attention: session.attention === undefined ? undefined : toProtoSessionAttention(session.attention),
    worktree: session.worktree === undefined ? undefined : toProtoSessionWorktree(session.worktree),
    remoteWorkspace: toProtoRemoteWorkspace(session.remoteWorkspace),
    createdAt: toProtoTimestamp(session.createdAt),
    lastActivityAt: toProtoTimestamp(session.updatedAt),
    version: toProtoEntityVersion(record.revision, session.binding.generation, session.updatedAt),
    error: undefined
  });
}

function toProtoCodeHostPullRequest(
  entry: CodeHostSessionReferenceProjection
): contract.CodeHostPullRequestProjection {
  const projection = entry.projection;
  return message<contract.CodeHostPullRequestProjection>("joko.v1.CodeHostPullRequestProjection", {
    reference: message<contract.CodeHostPullRequestReference>("joko.v1.CodeHostPullRequestReference", {
      referenceKey: entry.reference.key,
      host: entry.reference.host,
      repositoryOwner: entry.reference.repositoryOwner,
      repositoryName: entry.reference.repositoryName,
      number: BigInt(entry.reference.number),
      webUrl: entry.reference.webUrl
    }),
    state: projection === undefined
      ? CodeHostPullRequestState.UNSPECIFIED
      : projection.state === "open"
        ? CodeHostPullRequestState.OPEN
        : projection.state === "closed"
          ? CodeHostPullRequestState.CLOSED
          : CodeHostPullRequestState.MERGED,
    draft: projection?.draft ?? false,
    unresolvedReviewThreadCount: projection?.unresolvedReviewThreadCount,
    observedAt: projection === undefined ? undefined : toProtoTimestamp(projection.observedAt),
    observed: projection !== undefined,
    title: projection?.title ?? "",
    headBranch: projection?.headBranch ?? ""
  });
}

function toProtoSessionWorktree(worktree: SessionWorktreeBinding): ProtoSessionWorktree {
  return message<ProtoSessionWorktree>("joko.v1.SessionWorktree", {
    leaseId: worktree.leaseId,
    workspaceId: worktree.workspaceId,
    workingPathDisplay: worktree.path,
    repositoryRootDisplay: worktree.repositoryRoot,
    branch: worktree.branch,
    sourceRef: worktree.sourceRef,
    sourceCommit: worktree.sourceCommit,
    sourceStrategy: toProtoWorktreeSourceStrategy(worktree.sourceStrategy),
    sourceRefreshed: worktree.sourceRefreshed,
    ...(worktree.sourceRemote === undefined ? {} : { sourceRemote: worktree.sourceRemote }),
    state: worktree.state === "active"
      ? SessionWorktreeState.ACTIVE
      : SessionWorktreeState.PRESERVED,
    acquiredAt: toProtoTimestamp(worktree.acquiredAt),
    updatedAt: toProtoTimestamp(worktree.updatedAt)
  });
}

function fromProtoSessionWorktree(worktree: ProtoSessionWorktree): SessionWorktreeBinding {
  const acquiredAt = fromProtoTimestamp(worktree.acquiredAt, "session.worktree.acquired_at") ?? 0;
  return {
    leaseId: requireText(worktree.leaseId, "session.worktree.lease_id"),
    workspaceId: requireText(worktree.workspaceId, "session.worktree.workspace_id"),
    path: requireText(worktree.workingPathDisplay, "session.worktree.working_path_display"),
    repositoryRoot: requireText(worktree.repositoryRootDisplay, "session.worktree.repository_root_display"),
    branch: requireText(worktree.branch, "session.worktree.branch"),
    sourceRef: requireText(worktree.sourceRef, "session.worktree.source_ref"),
    sourceCommit: requireText(worktree.sourceCommit, "session.worktree.source_commit"),
    sourceStrategy: fromProtoWorktreeSourceStrategy(worktree.sourceStrategy),
    sourceRefreshed: worktree.sourceRefreshed,
    ...(worktree.sourceRemote === undefined ? {} : { sourceRemote: worktree.sourceRemote }),
    state: worktree.state === SessionWorktreeState.ACTIVE ? "active" : "preserved",
    acquiredAt,
    updatedAt: fromProtoTimestamp(worktree.updatedAt, "session.worktree.updated_at") ?? acquiredAt
  };
}

function toProtoWorktreeSourceStrategy(
  strategy: SessionWorktreeBinding["sourceStrategy"]
): WorktreeSourceStrategy {
  switch (strategy) {
    case "explicit": return WorktreeSourceStrategy.EXPLICIT;
    case "remote_default_refreshed": return WorktreeSourceStrategy.REMOTE_DEFAULT_REFRESHED;
    case "remote_default_local": return WorktreeSourceStrategy.REMOTE_DEFAULT_LOCAL;
    case "current_branch": return WorktreeSourceStrategy.CURRENT_BRANCH;
    case "local_default": return WorktreeSourceStrategy.LOCAL_DEFAULT;
    case "head": return WorktreeSourceStrategy.HEAD;
  }
}

function fromProtoWorktreeSourceStrategy(
  strategy: WorktreeSourceStrategy
): SessionWorktreeBinding["sourceStrategy"] {
  switch (strategy) {
    case WorktreeSourceStrategy.EXPLICIT: return "explicit";
    case WorktreeSourceStrategy.REMOTE_DEFAULT_REFRESHED: return "remote_default_refreshed";
    case WorktreeSourceStrategy.REMOTE_DEFAULT_LOCAL: return "remote_default_local";
    case WorktreeSourceStrategy.CURRENT_BRANCH: return "current_branch";
    case WorktreeSourceStrategy.LOCAL_DEFAULT: return "local_default";
    case WorktreeSourceStrategy.HEAD: return "head";
    default: throw new ProtoMappingError(
      "invalid_argument",
      "session.worktree.source_strategy",
      "Worktree source strategy is required."
    );
  }
}

export function fromProtoSession(session: ProtoSession): SessionDescriptor {
  if (session.nativeBinding === undefined) {
    throw new ProtoMappingError("invalid_argument", "session.native_binding", "Native session binding is required.");
  }
  const createdAt = fromProtoTimestamp(session.createdAt, "session.created_at") ?? Date.now();
  const updatedAt = fromProtoTimestamp(session.lastActivityAt, "session.last_activity_at") ?? createdAt;
  return {
    id: requireText(session.sessionId, "session.session_id"),
    backendId: requireText(session.backendId, "session.backend_id"),
    targetId: requireText(session.targetId, "session.target_id"),
    ...(session.projectId === undefined
      ? {}
      : { projectId: requireText(session.projectId, "session.project_id") }),
    ...(session.automationOrigin === undefined
      ? {}
      : {
          automationOrigin: {
            kind: "scheduler" as const,
            scheduleId: requireText(session.automationOrigin.scheduleId, "session.automation_origin.schedule_id"),
            ...(session.automationOrigin.scheduleName === ""
              ? {}
              : { scheduleName: session.automationOrigin.scheduleName }),
            runId: requireText(session.automationOrigin.runId, "session.automation_origin.run_id")
          }
        }),
    ...(session.derivationOrigin === undefined
      ? {}
      : {
          derivationOrigin: fromProtoSessionDerivationOrigin(session.derivationOrigin)
        }),
    title: session.displayName,
    ...(session.taskSummary === "" ? {} : { summary: session.taskSummary }),
    binding: fromProtoNativeBinding(session.nativeBinding),
    pinned: session.pinned,
    archived: session.archived || session.state === SessionState.ARCHIVED,
    ...(session.state === SessionState.CLOSED ? { deletedAt: updatedAt } : {}),
    permissionMode: fromProtoPermissionMode(session.permissionMode),
    planMode: session.planMode,
    ...(session.worktree === undefined ? {} : { worktree: fromProtoSessionWorktree(session.worktree) }),
    ...(session.model?.model?.providerId === undefined ? {} : { providerId: session.model.model.providerId }),
    ...(session.model?.model?.modelId === undefined ? {} : { modelId: session.model.model.modelId }),
    ...(session.model?.effortId === undefined || session.model.effortId === ""
      ? {}
      : { effort: session.model.effortId }),
    fastMode: session.model?.fastMode ?? false,
    ...(session.attention === undefined ? {} : { attention: fromProtoSessionAttention(session.attention) }),
    createdAt,
    updatedAt
  };
}

export function toProtoAttempt(record: StoredAttempt, run: StoredRun): Attempt {
  const attempt = record.descriptor;
  return message<Attempt>("joko.v1.Attempt", {
    attemptId: attempt.id,
    runId: attempt.runId,
    attemptNumber: attempt.ordinal,
    state: attemptState(attempt, run.descriptor),
    generation: unsignedBigInt(attempt.generation, "attempt.generation"),
    backendInstanceGeneration: attempt.backendInstanceGeneration === undefined
      ? undefined
      : unsignedBigInt(attempt.backendInstanceGeneration, "attempt.backend_instance_generation"),
    createdAt: toProtoTimestamp(attempt.startedAt),
    startedAt: toProtoTimestamp(attempt.startedAt),
    endedAt: optionalTimestamp(attempt.endedAt),
    retryAt: undefined,
    usage: undefined,
    error: optionalError(attempt.error)
  });
}

export function fromProtoAttempt(attempt: Attempt): AttemptDescriptor {
  const startedAt = fromProtoTimestamp(attempt.startedAt, "attempt.started_at") ??
    fromProtoTimestamp(attempt.createdAt, "attempt.created_at");
  if (startedAt === undefined) {
    throw new ProtoMappingError("invalid_argument", "attempt.started_at", "Attempt start time is required.");
  }
  return {
    id: requireText(attempt.attemptId, "attempt.attempt_id"),
    runId: requireText(attempt.runId, "attempt.run_id"),
    ordinal: attempt.attemptNumber,
    generation: safeNumber(attempt.generation, "attempt.generation"),
    ...(attempt.backendInstanceGeneration === undefined
      ? {}
      : {
          backendInstanceGeneration: safeNumber(
            attempt.backendInstanceGeneration,
            "attempt.backend_instance_generation"
          )
        }),
    startedAt,
    ...(fromProtoTimestamp(attempt.endedAt, "attempt.ended_at") === undefined
      ? {}
      : { endedAt: fromProtoTimestamp(attempt.endedAt, "attempt.ended_at") as number }),
    ...(attempt.error === undefined ? {} : { error: fromProtoErrorInfo(attempt.error) })
  };
}

export function toProtoRun(record: StoredRun, context: RunMappingContext): ProtoRun {
  const run = record.descriptor;
  const attempts = context.attempts ?? [];
  return message<ProtoRun>("joko.v1.Run", {
    runId: run.id,
    sessionId: run.sessionId,
    targetId: context.targetId,
    backendId: context.backendId,
    sourceQueueItemId: context.sourceQueueItemId ?? "",
    retryOfRunId: run.parentRunId ?? "",
    state: toProtoRunState(run.state),
    attempts: attempts.map((attempt) => toProtoAttempt(attempt, record)),
    activeAttemptId: run.activeAttemptId ?? "",
    usage: undefined,
    acceptedAt: toProtoTimestamp(run.createdAt),
    startedAt: optionalTimestamp(run.startedAt),
    endedAt: optionalTimestamp(run.endedAt),
    version: toProtoEntityVersion(record.revision, activeAttemptGeneration(run, attempts), run.endedAt ?? run.startedAt ?? run.createdAt),
    error: optionalError(run.error)
  });
}

export function fromProtoRun(run: ProtoRun): RunDescriptor {
  const createdAt = fromProtoTimestamp(run.acceptedAt, "run.accepted_at");
  if (createdAt === undefined) {
    throw new ProtoMappingError("invalid_argument", "run.accepted_at", "Run accepted time is required.");
  }
  return {
    id: requireText(run.runId, "run.run_id"),
    sessionId: requireText(run.sessionId, "run.session_id"),
    source: run.sourceQueueItemId === "" ? "system" : "user",
    state: fromProtoRunState(run.state),
    ...(run.retryOfRunId === "" ? {} : { parentRunId: run.retryOfRunId }),
    ...(run.activeAttemptId === "" ? {} : { activeAttemptId: run.activeAttemptId }),
    createdAt,
    ...(fromProtoTimestamp(run.startedAt, "run.started_at") === undefined
      ? {}
      : { startedAt: fromProtoTimestamp(run.startedAt, "run.started_at") as number }),
    ...(fromProtoTimestamp(run.endedAt, "run.ended_at") === undefined
      ? {}
      : { endedAt: fromProtoTimestamp(run.endedAt, "run.ended_at") as number }),
    ...(run.error === undefined ? {} : { error: fromProtoErrorInfo(run.error) })
  };
}

export function toProtoQueueItem(
  item: QueueItemRecord,
  routing: {
    readonly backendId: string;
    readonly targetId: string;
    readonly source: RunDescriptor["source"];
    readonly parentRunId?: string;
    readonly generation: number;
  },
  ordinal = 0n
): ProtoQueueItem {
  return message<ProtoQueueItem>("joko.v1.QueueItem", {
    queueItemId: item.id,
    backendId: routing.backendId,
    targetId: routing.targetId,
    sessionId: item.sessionId,
    runId: item.runId,
    sourceKind: routing.parentRunId !== undefined
      ? QueueSourceKind.RETRY
      : routing.source === "schedule"
      ? QueueSourceKind.SCHEDULE
      : routing.source === "user" ? QueueSourceKind.UI : QueueSourceKind.BACKEND,
    sourceId: item.operationId,
    deliveryMode: toProtoDeliveryMode(item.disposition),
    state: toProtoQueueState(item.state),
    ordinal,
    acceptedAt: toProtoTimestamp(item.createdAt),
    dispatchedAt: optionalTimestamp(item.dispatchedAt),
    version: toProtoEntityVersion(item.revision, routing.generation, item.updatedAt),
    error: optionalError(item.error),
    input: toProtoInputContent(item.body),
    backendInstanceGeneration: item.backendInstanceGeneration === undefined
      ? undefined
      : unsignedBigInt(item.backendInstanceGeneration, "queue_item.backend_instance_generation"),
    editLocked: item.editLocked
  });
}

export function toProtoQueueControl(
  control: QueueControlRecord,
  session: StoredSession,
  queuedItemCount: number
): QueueControl {
  return message<QueueControl>("joko.v1.QueueControl", {
    sessionId: control.sessionId,
    backendId: session.descriptor.backendId,
    targetId: session.descriptor.targetId,
    dispatchState: control.paused ? QueueDispatchState.PAUSED : QueueDispatchState.ACTIVE,
    pauseReason: control.pauseReason ?? "",
    pausedAt: optionalTimestamp(control.pausedAt),
    pausedBy: control.pausedByConnectionId === undefined
      ? undefined
      : message<ActorRef>("joko.v1.ActorRef", {
          kind: ActorKind.CONNECTION,
          id: control.pausedByConnectionId,
          displayName: control.pausedByConnectionId
        }),
    queuedItemCount: unsignedBigInt(queuedItemCount, "queue_control.queued_item_count"),
    version: toProtoEntityVersion(control.revision, session.descriptor.binding.generation, control.updatedAt),
    interactionLocked: control.interactionLocked
  });
}

export function fromProtoQueueItem(
  item: ProtoQueueItem,
  operationId = item.sourceId
): {
  readonly id: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly operationId: string;
  readonly disposition: InputDisposition;
  readonly body: PromptInput;
  readonly createdAt?: number;
} {
  const disposition = fromProtoDeliveryMode(item.deliveryMode);
  return {
    id: requireText(item.queueItemId, "queue_item.queue_item_id"),
    sessionId: requireText(item.sessionId, "queue_item.session_id"),
    runId: requireText(item.runId, "queue_item.run_id"),
    operationId: requireText(operationId, "queue_item.operation_id"),
    disposition,
    body: fromProtoInputContent(item.input, disposition),
    ...(fromProtoTimestamp(item.acceptedAt, "queue_item.accepted_at") === undefined
      ? {}
      : { createdAt: fromProtoTimestamp(item.acceptedAt, "queue_item.accepted_at") as number })
  };
}

export function toProtoBlobRef(blob: BlobRef, createdAt?: number): ProtoBlobRef {
  return message<ProtoBlobRef>("joko.v1.BlobRef", {
    blobId: blob.id,
    fileName: blob.fileName ?? "",
    mediaType: blob.mimeType,
    byteSize: unsignedBigInt(blob.byteLength, "blob.byte_size"),
    sha256Hex: blob.sha256.replace(/^sha256:/u, "").toLowerCase(),
    createdAt: optionalTimestamp(createdAt),
    expiresAt: undefined,
    disposition: BlobDisposition.ATTACHMENT
  });
}

export function fromProtoBlobRef(blob: ProtoBlobRef): BlobRef {
  return {
    id: requireText(blob.blobId, "blob.blob_id"),
    sha256: requireSha256(blob.sha256Hex, "blob.sha256_hex"),
    byteLength: safeNumber(blob.byteSize, "blob.byte_size"),
    mimeType: requireText(blob.mediaType, "blob.media_type"),
    ...(blob.fileName === "" ? {} : { fileName: blob.fileName })
  };
}

export function toProtoInputContent(input: PromptInput): InputContent {
  const pastedTextRanges = checkedInlineTextRanges(
    input.text,
    input.pastedTextRanges ?? [],
    "input.pasted_text_ranges"
  );
  const parts: InputPart[] = [];
  if (input.text !== "" || (input.images.length === 0 && input.files.length === 0 && input.mentions.length === 0)) {
    parts.push(message<InputPart>("joko.v1.InputPart", { content: { case: "text", value: input.text } }));
  }
  for (const image of input.images) {
    parts.push(message<InputPart>("joko.v1.InputPart", {
      content: {
        case: "image",
        value: message<ImageRef>("joko.v1.ImageRef", {
          blob: toProtoBlobRef(image.blob),
          widthPixels: 0,
          heightPixels: 0,
          altText: image.alt ?? ""
        })
      }
    }));
  }
  for (const file of input.files) {
    parts.push(message<InputPart>("joko.v1.InputPart", {
      content: { case: "file", value: toProtoBlobRef(file.blob) }
    }));
  }
  for (const mention of input.mentions) {
    if (mention.kind === "workspace_file") {
      parts.push(message<InputPart>("joko.v1.InputPart", {
        content: {
          case: "workspaceMention",
          value: message<WorkspaceMention>("joko.v1.WorkspaceMention", {
            workspaceId: "",
            relativePath: mention.reference,
            displayText: mention.label,
            revision: undefined
          })
        }
      }));
    } else {
      parts.push(message<InputPart>("joko.v1.InputPart", {
        content: {
          case: "resourceMention",
          value: message<ResourceMention>("joko.v1.ResourceMention", {
            resourceId: mention.reference,
            displayText: mention.label
          })
        }
      }));
    }
  }
  return message<InputContent>("joko.v1.InputContent", {
    parts,
    quotesEncoded: input.quotesEncoded === true,
    pastedTextRanges: pastedTextRanges.map((range) => message<ProtoInlineTextRange>("joko.v1.InlineTextRange", {
      start: range.start,
      end: range.end,
      display: range.display
    }))
  });
}

export function fromProtoInputContent(
  content: InputContent | undefined,
  disposition: InputDisposition = "prompt"
): PromptInput {
  const text: string[] = [];
  const images: PromptInput["images"][number][] = [];
  const files: PromptInput["files"][number][] = [];
  const mentions: PromptInput["mentions"][number][] = [];
  for (const part of content?.parts ?? []) {
    switch (part.content.case) {
      case "text":
        text.push(part.content.value);
        break;
      case "image":
        if (part.content.value.blob === undefined) {
          throw new ProtoMappingError("invalid_argument", "input.parts.image.blob", "Image blob is required.");
        }
        images.push({
          blob: fromProtoBlobRef(part.content.value.blob),
          ...(part.content.value.altText === "" ? {} : { alt: part.content.value.altText })
        });
        break;
      case "file":
        files.push({ blob: fromProtoBlobRef(part.content.value) });
        break;
      case "resourceMention":
        mentions.push({
          kind: "resource",
          label: part.content.value.displayText,
          reference: part.content.value.resourceId
        });
        break;
      case "workspaceMention":
        mentions.push({
          kind: "workspace_file",
          label: part.content.value.displayText,
          reference: part.content.value.relativePath
        });
        break;
      case undefined:
        throw new ProtoMappingError("invalid_argument", "input.parts.content", "Input part content is required.");
    }
  }
  const joinedText = text.join("");
  const pastedTextRanges = checkedInlineTextRanges(
    joinedText,
    (content?.pastedTextRanges ?? []).map((range) => ({
      start: range.start,
      end: range.end,
      display: range.display
    })),
    "input.pasted_text_ranges"
  );
  return {
    text: joinedText,
    images,
    files,
    mentions,
    disposition,
    ...(content?.quotesEncoded === true ? { quotesEncoded: true } : {}),
    ...(pastedTextRanges.length === 0 ? {} : { pastedTextRanges })
  };
}

function fromProtoSessionDerivationOrigin(
  origin: contract.SessionDerivationOrigin
): NonNullable<SessionDescriptor["derivationOrigin"]> {
  const kind = origin.kind === SessionDerivationKind.FORK
    ? "fork" as const
    : origin.kind === SessionDerivationKind.CLONE
      ? "clone" as const
      : undefined;
  if (kind === undefined) {
    throw new ProtoMappingError(
      "invalid_argument",
      "session.derivation_origin.kind",
      "Session derivation kind is required."
    );
  }
  if ((origin.sourceMessageId === undefined) !== (origin.sourceEventId === undefined)) {
    throw new ProtoMappingError(
      "invalid_argument",
      "session.derivation_origin",
      "Session derivation source message identity is incomplete."
    );
  }
  if (kind === "fork" && origin.sourceMessageId === undefined) {
    throw new ProtoMappingError(
      "invalid_argument",
      "session.derivation_origin.source_message_id",
      "A fork source message identity is required."
    );
  }
  return {
    kind,
    sourceSessionId: requireText(origin.sourceSessionId, "session.derivation_origin.source_session_id"),
    ...(origin.sourceMessageId === undefined || origin.sourceEventId === undefined
      ? {}
      : {
          sourceMessageId: requireText(origin.sourceMessageId, "session.derivation_origin.source_message_id"),
          sourceEventId: requireText(origin.sourceEventId, "session.derivation_origin.source_event_id")
        })
  };
}

function checkedInlineTextRanges(
  text: string,
  ranges: readonly CoreInlineTextRange[],
  path: string
): readonly CoreInlineTextRange[] {
  if (!validInlineTextRanges(text, ranges)) {
    throw new ProtoMappingError(
      "invalid_argument",
      path,
      "Inline text ranges must be ordered, non-overlapping UTF-16 spans within the input text."
    );
  }
  return ranges;
}

function toProtoSessionAttention(attention: CoreSessionAttention): contract.SessionAttention {
  return message<contract.SessionAttention>("joko.v1.SessionAttention", {
    kind: attention.kind === "done"
      ? contract.SessionAttentionKind.DONE
      : attention.kind === "awaiting"
        ? contract.SessionAttentionKind.AWAITING
        : contract.SessionAttentionKind.ERROR,
    unread: attention.unread,
    subjectCursor: toProtoEventCursor(
      attention.subjectCursor,
      attention.subjectGeneration,
      attention.updatedAt
    ),
    attentionCursor: toProtoEventCursor(
      attention.attentionCursor,
      attention.attentionGeneration,
      attention.updatedAt
    ),
    readThroughCursor: toProtoEventCursor(
      attention.readThroughCursor,
      attention.readThroughGeneration,
      attention.updatedAt
    ),
    updatedAt: toProtoTimestamp(attention.updatedAt)
  });
}

function fromProtoSessionAttention(attention: contract.SessionAttention): CoreSessionAttention {
  const subjectCursor = fromProtoEventCursor(attention.subjectCursor);
  const attentionCursor = fromProtoEventCursor(attention.attentionCursor);
  const readThroughCursor = attention.readThroughCursor === undefined
    ? { sequence: 0n, generation: 0n }
    : fromProtoEventCursor(attention.readThroughCursor);
  const kind = attention.kind === contract.SessionAttentionKind.DONE
    ? "done"
    : attention.kind === contract.SessionAttentionKind.AWAITING
      ? "awaiting"
      : attention.kind === contract.SessionAttentionKind.ERROR
        ? "error"
        : undefined;
  if (kind === undefined) {
    throw new ProtoMappingError("invalid_argument", "session.attention.kind", "Session attention kind is required.");
  }
  if (attentionCursor.sequence < 1n) {
    throw new ProtoMappingError(
      "invalid_argument",
      "session.attention.attention_cursor",
      "Session attention cursor must reference a durable Event."
    );
  }
  if (
    subjectCursor.sequence < 1n ||
    subjectCursor.sequence > attentionCursor.sequence ||
    subjectCursor.generation > attentionCursor.generation ||
    (subjectCursor.sequence === attentionCursor.sequence && subjectCursor.generation !== attentionCursor.generation)
  ) {
    throw new ProtoMappingError(
      "invalid_argument",
      "session.attention.subject_cursor",
      "Session attention subject cursor is inconsistent with its acknowledgement fence."
    );
  }
  if (
    readThroughCursor.sequence > attentionCursor.sequence ||
    readThroughCursor.generation > attentionCursor.generation ||
    (readThroughCursor.sequence === 0n && readThroughCursor.generation !== 0n) ||
    (attention.unread && readThroughCursor.sequence >= attentionCursor.sequence) ||
    (!attention.unread && (
      readThroughCursor.sequence !== attentionCursor.sequence ||
      readThroughCursor.generation !== attentionCursor.generation
    ))
  ) {
    throw new ProtoMappingError(
      "invalid_argument",
      "session.attention.read_through_cursor",
      "Session attention read cursor is inconsistent with its attention cursor."
    );
  }
  return {
    kind,
    unread: attention.unread,
    subjectCursor: subjectCursor.sequence,
    subjectGeneration: safeNumber(subjectCursor.generation, "session.attention.subject_cursor.generation"),
    attentionCursor: attentionCursor.sequence,
    attentionGeneration: safeNumber(attentionCursor.generation, "session.attention.attention_cursor.generation"),
    readThroughCursor: readThroughCursor.sequence,
    readThroughGeneration: safeNumber(readThroughCursor.generation, "session.attention.read_through_cursor.generation"),
    updatedAt: fromProtoTimestamp(attention.updatedAt, "session.attention.updated_at") ?? 0
  };
}

export function toProtoReviewRun(record: ReviewRunRecord, evidence: ReviewEvidenceSealRecord): ProtoReviewRun {
  return message<ProtoReviewRun>("joko.v1.ReviewRun", {
    reviewRunId: record.id,
    sourceSessionId: record.sourceSessionId,
    reviewerSessionId: record.reviewerSessionId ?? "",
    state: record.state === "running" ? ReviewRunState.RUNNING
      : record.state === "completed" ? ReviewRunState.COMPLETED : ReviewRunState.FAILED,
    targetKind: record.targetKind === "changes" ? ReviewTargetKind.CHANGES
      : record.targetKind === "artifacts" ? ReviewTargetKind.ARTIFACTS
        : record.targetKind === "mixed" ? ReviewTargetKind.MIXED : ReviewTargetKind.TASK,
    failureCode: toProtoReviewFailureCode(record.failureCode),
    resultMarkdown: record.result ?? "",
    freshness: toProtoReviewFreshness(record.freshness, record.freshnessCheckedAt),
    evidence: toProtoReviewEvidence({
      sealSha256: evidence.sealSha256,
      sourceRevision: {
        version: evidence.version,
        conversationSha256: evidence.conversationSha256,
        workspaceSha256: evidence.workspaceSha256,
        filesSha256: evidence.filesSha256,
        artifactsSha256: evidence.artifactsSha256
      },
      targetKind: record.targetKind,
      capturedAt: evidence.createdAt
    }),
    createdAt: toProtoTimestamp(record.createdAt),
    updatedAt: toProtoTimestamp(record.updatedAt),
    endedAt: record.endedAt === undefined ? undefined : toProtoTimestamp(record.endedAt),
    revision: toProtoRevision(record.revision)
  });
}

function toProtoReviewFreshness(
  freshness: ReviewRunRecord["freshness"] | CoreReviewEvidenceFreshness,
  checkedAt: number
): ReviewFreshness {
  return message<ReviewFreshness>("joko.v1.ReviewFreshness", {
    state: freshness === "current" ? ReviewFreshnessState.CURRENT
      : freshness === "stale" ? ReviewFreshnessState.STALE : ReviewFreshnessState.UNAVAILABLE,
    checkedAt: toProtoTimestamp(checkedAt)
  });
}

type CoreReviewEvidenceFreshness = "current" | "stale" | "unavailable";

function toProtoReviewEvidence(evidence: CoreReviewEvidenceProjection): ReviewEvidenceSummary {
  return message<ReviewEvidenceSummary>("joko.v1.ReviewEvidenceSummary", {
    sealSha256Hex: evidence.sealSha256,
    sourceRevision: message<ReviewSourceRevision>("joko.v1.ReviewSourceRevision", {
      sealVersion: evidence.sourceRevision.version,
      conversationSha256Hex: evidence.sourceRevision.conversationSha256,
      workspaceSha256Hex: evidence.sourceRevision.workspaceSha256,
      filesSha256Hex: evidence.sourceRevision.filesSha256,
      artifactsSha256Hex: evidence.sourceRevision.artifactsSha256
    }),
    targetKind: evidence.targetKind === "changes" ? ReviewTargetKind.CHANGES
      : evidence.targetKind === "artifacts" ? ReviewTargetKind.ARTIFACTS
        : evidence.targetKind === "mixed" ? ReviewTargetKind.MIXED : ReviewTargetKind.TASK,
    capturedAt: toProtoTimestamp(evidence.capturedAt)
  });
}

function fromProtoReviewFreshness(value: ReviewFreshness | undefined): {
  readonly freshness: "current" | "stale" | "unavailable";
  readonly freshnessCheckedAt: number;
} {
  if (value === undefined) {
    throw new ProtoMappingError("invalid_argument", "review_run.freshness", "Review freshness is required.");
  }
  const state = value.state;
  const freshness = state === ReviewFreshnessState.CURRENT ? "current"
    : state === ReviewFreshnessState.STALE ? "stale"
      : state === ReviewFreshnessState.UNAVAILABLE ? "unavailable"
        : (() => { throw new ProtoMappingError("invalid_argument", "review_run.freshness.state", "Review freshness state is required."); })();
  const checkedAt = fromProtoTimestamp(value.checkedAt, "review_run.freshness.checked_at");
  if (checkedAt === undefined) {
    throw new ProtoMappingError("invalid_argument", "review_run.freshness.checked_at", "Review freshness check time is required.");
  }
  return {
    freshness,
    freshnessCheckedAt: checkedAt
  };
}

function fromProtoReviewEvidence(
  value: ReviewEvidenceSummary,
  targetKind: CoreReviewEvidenceProjection["targetKind"]
): CoreReviewEvidenceProjection {
  const source = value.sourceRevision;
  if (source === undefined || source.sealVersion !== 1) {
    throw new ProtoMappingError(
      "invalid_argument",
      "review_run.evidence.source_revision",
      "Review evidence source revision version 1 is required."
    );
  }
  const evidenceTargetKind = value.targetKind === ReviewTargetKind.CHANGES ? "changes"
    : value.targetKind === ReviewTargetKind.ARTIFACTS ? "artifacts"
      : value.targetKind === ReviewTargetKind.MIXED ? "mixed"
        : value.targetKind === ReviewTargetKind.TASK ? "task"
          : (() => { throw new ProtoMappingError("invalid_argument", "review_run.evidence.target_kind", "Review evidence target kind is required."); })();
  if (evidenceTargetKind !== targetKind) {
    throw new ProtoMappingError(
      "invalid_argument",
      "review_run.evidence.target_kind",
      "Review evidence target kind must match the Review run."
    );
  }
  const capturedAt = fromProtoTimestamp(value.capturedAt, "review_run.evidence.captured_at");
  if (capturedAt === undefined) {
    throw new ProtoMappingError("invalid_argument", "review_run.evidence.captured_at", "Review evidence capture time is required.");
  }
  return {
    sealSha256: requireSha256(value.sealSha256Hex, "review_run.evidence.seal_sha256_hex").slice(7),
    sourceRevision: {
      version: 1,
      conversationSha256: requireSha256(source.conversationSha256Hex, "review_run.evidence.source_revision.conversation_sha256_hex").slice(7),
      workspaceSha256: requireSha256(source.workspaceSha256Hex, "review_run.evidence.source_revision.workspace_sha256_hex").slice(7),
      filesSha256: requireSha256(source.filesSha256Hex, "review_run.evidence.source_revision.files_sha256_hex").slice(7),
      artifactsSha256: requireSha256(source.artifactsSha256Hex, "review_run.evidence.source_revision.artifacts_sha256_hex").slice(7)
    },
    targetKind,
    capturedAt
  };
}

function promptInputFromMessageBlocks(
  blocks: readonly import("@joko/core").MessageBlock[],
  quotesEncoded: boolean,
  pastedTextRanges: readonly CoreInlineTextRange[] = []
): PromptInput {
  return {
    text: blocks.flatMap((block) => block.kind === "text" ? [block.text] : []).join(""),
    images: blocks.flatMap((block) => block.kind === "image"
      ? [{ blob: block.blob, ...(block.alt === undefined ? {} : { alt: block.alt }) }]
      : []),
    files: blocks.flatMap((block) => block.kind === "artifact" ? [{ blob: block.blob }] : []),
    mentions: [],
    disposition: "prompt",
    ...(quotesEncoded ? { quotesEncoded: true } : {}),
    ...(pastedTextRanges.length === 0 ? {} : { pastedTextRanges })
  };
}

function toProtoMessageBlock(block: CoreMessageBlock): contract.MessageBlock {
  switch (block.kind) {
    case "text":
      return message<contract.MessageBlock>("joko.v1.MessageBlock", {
        content: { case: "text", value: block.text }
      });
    case "thinking":
      return message<contract.MessageBlock>("joko.v1.MessageBlock", {
        content: {
          case: "thinking",
          value: message<contract.MessageThinkingBlock>("joko.v1.MessageThinkingBlock", {
            text: block.text,
            redacted: block.redacted
          })
        }
      });
    case "image":
      return message<contract.MessageBlock>("joko.v1.MessageBlock", {
        content: {
          case: "image",
          value: message<ImageRef>("joko.v1.ImageRef", {
            blob: toProtoBlobRef(block.blob),
            widthPixels: 0,
            heightPixels: 0,
            altText: block.alt ?? ""
          })
        }
      });
    case "artifact":
      return message<contract.MessageBlock>("joko.v1.MessageBlock", {
        content: {
          case: "artifact",
          value: message<contract.MessageArtifactBlock>("joko.v1.MessageArtifactBlock", {
            blob: toProtoBlobRef(block.blob),
            label: block.label
          })
        }
      });
    case "tool_call":
      return message<contract.MessageBlock>("joko.v1.MessageBlock", {
        content: {
          case: "toolCall",
          value: message<contract.MessageToolCallBlock>("joko.v1.MessageToolCallBlock", {
            callId: block.callId,
            name: block.name,
            input: block.input
          })
        }
      });
    case "tool_result":
      return message<contract.MessageBlock>("joko.v1.MessageBlock", {
        content: {
          case: "toolResult",
          value: message<contract.MessageToolResultBlock>("joko.v1.MessageToolResultBlock", {
            callId: block.callId,
            output: block.output,
            isError: block.isError
          })
        }
      });
  }
}

function fromProtoMessageBlock(block: contract.MessageBlock): CoreMessageBlock {
  switch (block.content.case) {
    case "text":
      return { kind: "text", text: block.content.value };
    case "thinking":
      return {
        kind: "thinking",
        text: block.content.value.text,
        redacted: block.content.value.redacted
      };
    case "image": {
      const image = block.content.value;
      if (image.blob === undefined) {
        throw new ProtoMappingError("invalid_argument", "event.payload.message_completed.blocks.image.blob", "Image blob is required.");
      }
      return {
        kind: "image",
        blob: fromProtoBlobRef(image.blob),
        ...(image.altText === "" ? {} : { alt: image.altText })
      };
    }
    case "artifact": {
      const artifact = block.content.value;
      if (artifact.blob === undefined) {
        throw new ProtoMappingError("invalid_argument", "event.payload.message_completed.blocks.artifact.blob", "Artifact blob is required.");
      }
      return {
        kind: "artifact",
        blob: fromProtoBlobRef(artifact.blob),
        label: artifact.label
      };
    }
    case "toolCall":
      return {
        kind: "tool_call",
        callId: block.content.value.callId,
        name: block.content.value.name,
        input: block.content.value.input
      };
    case "toolResult":
      return {
        kind: "tool_result",
        callId: block.content.value.callId,
        output: block.content.value.output,
        isError: block.content.value.isError
      };
    case undefined:
      throw new ProtoMappingError(
        "invalid_argument",
        "event.payload.message_completed.blocks.content",
        "Message block content is required."
      );
  }
}

export function toProtoModelSelection(
  providerId: string,
  modelId: string,
  effortId: string | undefined,
  fastMode: boolean
): ModelSelection {
  return message<ModelSelection>("joko.v1.ModelSelection", {
    model: message<ModelKey>("joko.v1.ModelKey", { providerId, modelId }),
    effortId: effortId ?? "",
    fastMode
  });
}

export function toProtoModelDescriptor(backendId: string, model: ProviderModel): ModelDescriptor {
  requireText(backendId, "model.backend_id");
  const inferredPriceSource = model.pricing?.source
    ?? (model.cost.input > 0 || model.cost.output > 0 || model.cost.cacheRead > 0 || model.cost.cacheWrite > 0
      ? "upstream"
      : undefined);
  return message<ModelDescriptor>("joko.v1.ModelDescriptor", {
    backendId,
    key: message<ModelKey>("joko.v1.ModelKey", { providerId: model.providerId, modelId: model.modelId }),
    displayName: model.displayName,
    logicalId: model.logicalId ?? model.modelId,
    family: (model.logicalId ?? model.modelId).split(/[/:]/u)[0] ?? model.modelId,
    contextWindowTokens: unsignedBigInt(model.contextWindow, "model.context_window"),
    maximumOutputTokens: unsignedBigInt(model.maxOutputTokens, "model.maximum_output_tokens"),
    inputModalities: model.supportsImages
      ? [ModelInputModality.TEXT, ModelInputModality.IMAGE]
      : [ModelInputModality.TEXT],
    outputModalities: [ModelOutputModality.TEXT],
    effortLevels: model.thinkingLevels.map((level, index) => message<EffortLevel>("joko.v1.EffortLevel", {
      effortId: level,
      displayName: level,
      order: index,
      defaultLevel: index === 0
    })),
    supportsFastMode: model.supportsFastMode ?? false,
    defaultVisible: model.defaultVisible,
    available: true,
    inputCostMicrosPerMillion: costMicros(model.cost.input),
    outputCostMicrosPerMillion: costMicros(model.cost.output),
    cacheReadCostMicrosPerMillion: costMicros(model.cost.cacheRead),
    cacheWriteCostMicrosPerMillion: costMicros(model.cost.cacheWrite),
    currencyCode: model.pricing?.currencyCode ?? "USD",
    priceSource: inferredPriceSource === "providerReference"
      ? ModelPriceSource.PROVIDER_REFERENCE
      : inferredPriceSource === "upstream"
        ? ModelPriceSource.UPSTREAM
        : ModelPriceSource.UNSPECIFIED,
    priceUpdatedAt: model.pricing?.updatedAt === undefined ? undefined : toProtoTimestamp(model.pricing.updatedAt),
    error: undefined
  });
}

export function toProtoProviderDescriptor(
  backendId: string,
  providerId: string,
  api: ProviderModel["api"],
  authenticated: boolean,
  revision: bigint,
  updatedAt: number,
  operations: {
    readonly login?: boolean;
    readonly logout?: boolean;
    readonly refresh?: boolean;
    readonly modelRefresh?: boolean;
    readonly loginMethods?: readonly string[];
    readonly displayName?: string;
    readonly authenticationState?: BackendDescriptor["authenticationState"];
    readonly accessKind?: BackendProviderAccessKind;
    readonly accessProduct?: string;
    readonly providesModelPricing?: boolean;
    readonly credentialSurfaces?: readonly BackendProviderCredentialSurface[];
  } = {}
): ProviderDescriptor {
  requireText(backendId, "provider.backend_id");
  return message<ProviderDescriptor>("joko.v1.ProviderDescriptor", {
    backendId,
    providerId,
    displayName: operations.displayName ?? providerId,
    kind: protoBackendProviderAccessKind(operations.accessKind),
    accessProduct: operations.accessProduct,
    apiCompatibility: providerApi(api),
    authenticationState: operations.authenticationState === undefined
      ? authenticated ? AuthenticationState.AUTHENTICATED : AuthenticationState.SIGNED_OUT
      : toProtoBackendAuthenticationState(operations.authenticationState),
    endpointDisplay: "",
    ownerManaged: false,
    supportsLogin: operations.login === true,
    supportsLogout: operations.logout === true,
    supportsRefresh: operations.refresh === true,
    loginMethods: operations.login === true
      ? (operations.loginMethods ?? []).map(protoProviderLoginMethod).filter((method) => method !== undefined)
      : [],
    supportsModelRefresh: operations.modelRefresh === true,
    credentialSurfaces: validatedProviderCredentialSurfaces(operations.credentialSurfaces).map((surface) => message<ProviderCredentialSurface>("joko.v1.ProviderCredentialSurface", {
      surfaceId: surface.surfaceId,
      capability: surface.capability === "image_generation"
        ? ProviderCredentialSurfaceCapability.IMAGE_GENERATION
        : ProviderCredentialSurfaceCapability.UNSPECIFIED,
      kind: surface.kind === "api_key"
        ? ProviderCredentialSurfaceKind.API_KEY
        : ProviderCredentialSurfaceKind.UNSPECIFIED,
      configured: false,
      models: surface.models.map((model) => message<ProviderCapabilityModelDescriptor>("joko.v1.ProviderCapabilityModelDescriptor", {
        modelId: model.modelId,
        displayName: model.displayName
      }))
    })),
    capabilities: operations.providesModelPricing === undefined ? undefined : message<CapabilityManifest>("joko.v1.CapabilityManifest", {
      schemaVersion: "joko.provider.v1",
      capabilities: [message<ProtoCapability>("joko.v1.Capability", {
        name: contract.capabilityNames.modelPricing,
        support: operations.providesModelPricing ? CapabilitySupport.SUPPORTED : CapabilitySupport.UPSTREAM_MISSING,
        reason: operations.providesModelPricing ? "" : "The upstream model catalog does not publish price quotes."
      })],
      revision: toProtoRevision(revision)
    }),
    credentialExpiresAt: undefined,
    rateLimit: undefined,
    version: toProtoEntityVersion(revision, 0, updatedAt),
    error: undefined
  });
}

function protoBackendProviderAccessKind(value: BackendProviderAccessKind | undefined): ProviderKind {
  switch (value) {
    case "apiKey": return ProviderKind.API_KEY;
    case "oauth": return ProviderKind.OAUTH;
    case "subscription": return ProviderKind.SUBSCRIPTION;
    case "localKeyless": return ProviderKind.LOCAL_KEYLESS;
    case "customEndpoint": return ProviderKind.CUSTOM_ENDPOINT;
    case "managed":
    case undefined: return ProviderKind.MANAGED;
  }
}

function protoProviderLoginMethod(value: string): ProviderLoginMethod | undefined {
  if (value === "api_key") return ProviderLoginMethod.API_KEY;
  if (value === "oauth_browser") return ProviderLoginMethod.OAUTH_BROWSER;
  if (value === "device_code") return ProviderLoginMethod.DEVICE_CODE;
  if (value === "subscription") return ProviderLoginMethod.SUBSCRIPTION;
  return undefined;
}

export function toProtoSchedule(
  schedule: ScheduleRecord,
  history: readonly ScheduleRunRecord[] = [],
  runs: ReadonlyMap<string, StoredRun> = new Map(),
  unreadRunCount = history.filter((record) => terminalScheduleRunOutcome(record.status) && record.readAt === undefined).length
): ProtoSchedule {
  const projectOrigin = scheduleProjectAutomationOrigin(schedule.executionSnapshot);
  return message<ProtoSchedule>("joko.v1.Schedule", {
    scheduleId: schedule.id,
    displayName: schedule.name,
    state: schedule.enabled ? ScheduleState.ENABLED : ScheduleState.DISABLED,
    backendId: schedule.backendId,
    targetId: schedule.targetId,
    sessionId: schedule.sessionId ?? "",
    sessionMode: schedule.sessionMode === "fresh"
      ? ScheduleSessionMode.FRESH
      : schedule.sessionMode === "persistent"
        ? ScheduleSessionMode.PERSISTENT
        : ScheduleSessionMode.BOUND,
    recurrence: toProtoScheduleRecurrence(schedule),
    timeZone: schedule.timezone,
    input: toProtoInputContent(schedule.prompt),
    execution: toProtoScheduleExecution(schedule.executionSnapshot),
    overlapPolicy: schedule.overlapPolicy === "queue" ? ScheduleOverlapPolicy.QUEUE : ScheduleOverlapPolicy.SKIP,
    misfirePolicy: schedule.misfirePolicy === "run_once" ? ScheduleMisfirePolicy.RUN_ONCE : ScheduleMisfirePolicy.SKIP,
    nextTriggerAt: optionalTimestamp(schedule.nextRunAt),
    lastTriggeredAt: optionalTimestamp(schedule.lastRunAt),
    recentRuns: history.map((record) => toProtoScheduleHistory(record, runs.get(record.runId))),
    source: projectOrigin === undefined ? ScheduleSource.USER : ScheduleSource.PROJECT,
    projectConfigId: projectOrigin?.configId ?? "",
    projectConfigPath: projectOrigin === undefined ? "" : PROJECT_AUTOMATION_CONFIG_PATH,
    unreadRunCount: unsignedInt32(unreadRunCount, "schedule.unread_run_count"),
    version: toProtoEntityVersion(schedule.revision, 0, schedule.updatedAt),
    error: undefined
  });
}

export function fromProtoSchedule(schedule: ProtoSchedule, expectedRevision?: bigint): UpsertScheduleInput {
  const recurrence = fromProtoScheduleRecurrence(schedule.recurrence);
  const prompt = fromProtoInputContent(schedule.input, "prompt");
  const baseExecutionSnapshot = fromProtoScheduleExecution(schedule.execution);
  const executionSnapshot = schedule.source === ScheduleSource.PROJECT
    ? withScheduleProjectAutomationOrigin(baseExecutionSnapshot, {
        targetId: requireText(schedule.targetId, "schedule.target_id"),
        configId: requireText(schedule.projectConfigId, "schedule.project_config_id")
      })
    : baseExecutionSnapshot;
  const sessionMode = schedule.sessionMode === ScheduleSessionMode.FRESH
    ? "fresh"
    : schedule.sessionMode === ScheduleSessionMode.PERSISTENT
      ? "persistent"
      : schedule.sessionMode === ScheduleSessionMode.BOUND || schedule.sessionId !== ""
        ? "bound"
        : "fresh";
  let worktree: ReturnType<typeof scheduleWorktreeConfiguration>;
  try {
    worktree = scheduleWorktreeConfiguration(executionSnapshot);
  } catch {
    throw new ProtoMappingError(
      "invalid_argument",
      "schedule.execution.use_worktree",
      "Schedule isolated workspace configuration is invalid."
    );
  }
  if (worktree.useWorktree && (sessionMode !== "fresh" || schedule.sessionId !== "")) {
    throw new ProtoMappingError(
      "invalid_argument",
      "schedule.execution.use_worktree",
      "Isolated workspace Schedules require fresh Session mode."
    );
  }
  return {
    id: requireText(schedule.scheduleId, "schedule.schedule_id"),
    backendId: requireText(schedule.backendId, "schedule.backend_id"),
    targetId: requireText(schedule.targetId, "schedule.target_id"),
    sessionMode,
    ...(schedule.sessionId === "" ? {} : { sessionId: schedule.sessionId }),
    name: requireText(schedule.displayName, "schedule.display_name"),
    kind: recurrence.kind,
    ...(recurrence.expression === undefined ? {} : { expression: recurrence.expression }),
    ...(recurrence.anchorAt === undefined ? {} : { anchorAt: recurrence.anchorAt }),
    timezone: requireText(schedule.timeZone, "schedule.time_zone"),
    enabled: schedule.state === ScheduleState.ENABLED || schedule.state === ScheduleState.RUNNING,
    prompt,
    executionSnapshot,
    overlapPolicy: schedule.overlapPolicy === ScheduleOverlapPolicy.QUEUE ? "queue" : "skip",
    misfirePolicy: schedule.misfirePolicy === ScheduleMisfirePolicy.RUN_ONCE ? "run_once" : "skip",
    ...(fromProtoTimestamp(schedule.nextTriggerAt, "schedule.next_trigger_at") === undefined
      ? {}
      : { nextRunAt: fromProtoTimestamp(schedule.nextTriggerAt, "schedule.next_trigger_at") as number }),
    ...(fromProtoTimestamp(schedule.lastTriggeredAt, "schedule.last_triggered_at") === undefined
      ? {}
      : { lastRunAt: fromProtoTimestamp(schedule.lastTriggeredAt, "schedule.last_triggered_at") as number }),
    ...(expectedRevision === undefined ? {} : { expectedRevision })
  };
}

export function toProtoInteraction(
  interaction: InteractionRecord,
  routing: InteractionRouting
): ProtoInteraction {
  const expiresAt = interactionExpiry(interaction);
  const expired = interaction.status === "dismissed" &&
    interaction.dismissalReason === TIMED_EXTENSION_INTERACTION_EXPIRED_REASON;
  return message<ProtoInteraction>("joko.v1.Interaction", {
    interactionId: interaction.id,
    kind: toProtoInteractionKind(interaction.payload.kind),
    state: interaction.status === "open"
      ? InteractionState.PENDING
      : interaction.status === "resolved" ? InteractionState.RESOLVED
        : expired ? InteractionState.EXPIRED : InteractionState.DISMISSED,
    backendId: routing.backendId,
    targetId: routing.targetId,
    sessionId: interaction.sessionId,
    runId: interaction.runId ?? "",
    attemptId: interaction.attemptId ?? "",
    generation: unsignedBigInt(interaction.generation, "interaction.generation"),
    createdAt: toProtoTimestamp(interaction.createdAt),
    expiresAt: optionalTimestamp(expiresAt),
    request: toProtoInteractionRequest(interaction.payload),
    resolution: interaction.status === "open" ? undefined : toProtoInteractionResolution(interaction),
    version: toProtoEntityVersion(
      interaction.revision,
      interaction.generation,
      interaction.resolvedAt ?? interaction.createdAt
    )
  });
}

export function fromProtoInteraction(
  interaction: ProtoInteraction,
  traceId: string,
  operationId?: string
): OpenInteractionInput {
  const createdAt = fromProtoTimestamp(interaction.createdAt, "interaction.created_at");
  const expiresAt = fromProtoTimestamp(interaction.expiresAt, "interaction.expires_at");
  const payload = interactionPayloadWithTimeout(
    fromProtoInteractionRequest(interaction),
    createdAt,
    expiresAt
  );
  return {
    sessionId: requireText(interaction.sessionId, "interaction.session_id"),
    ...(interaction.runId === "" ? {} : { runId: interaction.runId }),
    ...(interaction.attemptId === "" ? {} : { attemptId: interaction.attemptId }),
    ...(operationId === undefined ? {} : { operationId }),
    generation: safeNumber(interaction.generation, "interaction.generation"),
    payload,
    traceId: requireText(traceId, "trace_id"),
    ...(createdAt === undefined ? {} : { createdAt })
  };
}

export function toProtoSchedulerRuntime(
  snapshot: CoreSchedulerRuntimeSnapshot
): contract.SchedulerRuntimeSnapshot {
  return message<contract.SchedulerRuntimeSnapshot>("joko.v1.SchedulerRuntimeSnapshot", {
    schedulerInstanceId: snapshot.schedulerInstanceId,
    ...(snapshot.processId === undefined ? {} : { processId: snapshot.processId }),
    inFlight: snapshot.inFlight,
    slotsInUse: snapshot.slotsInUse,
    maxConcurrentRuns: snapshot.maxConcurrentRuns,
    inFlightRuns: snapshot.inFlightRuns.map((run) => message<contract.ScheduleInflightRun>(
      "joko.v1.ScheduleInflightRun",
      {
        scheduleId: run.scheduleId,
        scheduleName: run.scheduleName ?? "",
        runId: run.runId,
        source: run.source === "automatic"
          ? contract.ScheduleFireSource.AUTOMATIC
          : contract.ScheduleFireSource.RUN_NOW,
        executionMode: run.executionMode === "script"
          ? contract.ScheduleExecutionMode.SCRIPT
          : contract.ScheduleExecutionMode.AGENT,
        startedAt: toProtoTimestamp(run.startedAt),
        ...(run.slotWaitMs === undefined ? {} : { slotWait: toProtoDuration(run.slotWaitMs) }),
        phase: protoScheduleRunPhase(run.phase),
        lastProgressAt: toProtoTimestamp(run.lastProgressAt)
      }
    )),
    waitingTasks: snapshot.waitingSchedules.map((schedule) => message<contract.ScheduleWaitingTask>(
      "joko.v1.ScheduleWaitingTask",
      {
        scheduleId: schedule.scheduleId,
        scheduleName: schedule.scheduleName,
        waitingSince: toProtoTimestamp(schedule.waitingSince)
      }
    ))
  });
}

export function fromProtoInteractionDecision(resolution: InteractionResolution):
  | { readonly kind: "decision"; readonly value: unknown }
  | { readonly kind: "dismissal"; readonly reason: string } {
  switch (resolution.decision.case) {
    case "permission":
      return { kind: "decision", value: permissionDecisionName(resolution.decision.value.decision) };
    case "question":
      return {
        kind: "decision",
        value: Object.fromEntries(resolution.decision.value.answers.map((answer) => [
          answer.fieldId,
          questionAnswerValue(answer)
        ]))
      };
    case "planReview":
      return {
        kind: "decision",
        value: {
          decision: planDecisionName(resolution.decision.value.decision),
          feedback: resolution.decision.value.feedback
        }
      };
    case "extensionUi":
      return { kind: "decision", value: extensionResolutionValue(resolution.decision.value) };
    case "dismissal":
      return { kind: "dismissal", reason: resolution.decision.value.reason };
    case undefined:
      throw new ProtoMappingError("invalid_argument", "interaction.resolution.decision", "Interaction decision is required.");
  }
}

export function toProtoArtifact(record: ArtifactRecord): Artifact {
  const metadata = objectValue(record.metadata);
  return message<Artifact>("joko.v1.Artifact", {
    artifactId: record.blob.id,
    sessionId: record.sessionId ?? "",
    runId: record.runId ?? "",
    kind: artifactKind(stringField(metadata, "kind"), record.blob.mimeType),
    title: record.blob.fileName ?? stringField(metadata, "title") ?? record.blob.id,
    description: stringField(metadata, "description") ?? "",
    blob: {
      ...toProtoBlobRef(record.blob, record.createdAt),
      disposition: BlobDisposition.ARTIFACT
    },
    createdAt: toProtoTimestamp(record.createdAt),
    expiresAt: undefined
  });
}

export function toProtoOperation(record: OperationRecord, generation = operationGeneration(record)): ProtoOperation {
  const completed = record.status !== "started";
  const result = record.status === "completed"
    ? message<OperationResult>("joko.v1.OperationResult", {
      payload: {
        case: "acknowledgement",
        value: message<Acknowledgement>("joko.v1.Acknowledgement", { accepted: true })
      }
    })
    : undefined;
  return message<ProtoOperation>("joko.v1.Operation", {
    operationId: record.id,
    connectionId: record.connectionId ?? "",
    requestSha256Hex: record.bodyHash.replace(/^sha256:/u, ""),
    state: record.status === "started"
      ? OperationState.RUNNING
      : record.status === "completed" ? OperationState.SUCCEEDED : OperationState.FAILED,
    // The store retains a sanitized canonical request, not a protobuf oneof.
    // Connect mutation handlers may enrich this when the original typed request is available.
    mutation: undefined,
    result,
    error: record.status === "failed" ? mapErrorToProto(record.error) : undefined,
    actor: message<ActorRef>("joko.v1.ActorRef", {
      kind: record.connectionId === undefined ? ActorKind.ORCHESTRATOR : ActorKind.CONNECTION,
      id: record.connectionId ?? "orchestrator",
      displayName: record.connectionId ?? "Orchestrator"
    }),
    generation: unsignedBigInt(generation, "operation.generation"),
    acceptedAt: toProtoTimestamp(record.createdAt),
    startedAt: toProtoTimestamp(record.createdAt),
    completedAt: completed ? toProtoTimestamp(record.updatedAt) : undefined,
    version: toProtoEntityVersion(record.revision, generation, record.updatedAt)
  });
}

export function toProtoWorkspace(record: StoredTarget): WorkspaceDescriptor {
  const metadata = objectValue(record.metadata);
  return message<WorkspaceDescriptor>("joko.v1.WorkspaceDescriptor", {
    workspaceId: stringField(metadata, "workspaceId") ?? record.descriptor.id,
    targetId: record.descriptor.id,
    displayName: record.descriptor.displayName,
    kind: record.descriptor.managed ? WorkspaceKind.MANAGED_DIALOGUE : WorkspaceKind.USER_PROJECT,
    serverPathDisplay: record.descriptor.workspaceRoot,
    trusted: record.descriptor.trusted,
    git: undefined,
    remoteWorkspace: toProtoRemoteWorkspace(record.descriptor.remoteWorkspace),
    version: toProtoEntityVersion(record.revision, 0, record.updatedAt)
  });
}

export function toProtoRemoteWorkspace(
  value: TargetDescriptor["remoteWorkspace"]
): contract.RemoteWorkspaceBinding | undefined {
  if (value === undefined) return undefined;
  return message<contract.RemoteWorkspaceBinding>("joko.v1.RemoteWorkspaceBinding", {
    hostId: value.hostId,
    workspaceRootDisplay: value.workspaceRoot
  });
}

export function fromProtoRemoteWorkspace(
  value: contract.RemoteWorkspaceBinding
): NonNullable<TargetDescriptor["remoteWorkspace"]> {
  requireText(value.hostId, "remote_workspace.host_id");
  requireText(value.workspaceRootDisplay, "remote_workspace.workspace_root_display");
  if (!value.workspaceRootDisplay.startsWith("/") || value.workspaceRootDisplay.includes("\0")) {
    throw new ProtoMappingError(
      "invalid_argument",
      "remote_workspace.workspace_root_display",
      "Remote workspace root must be an absolute POSIX path."
    );
  }
  return { hostId: value.hostId, workspaceRoot: value.workspaceRootDisplay };
}

function toProtoWorkspaceChangeSetProjection(value: WorkspaceChangeSetProjection): WorkspaceChangeSet {
  return message<WorkspaceChangeSet>("joko.v1.WorkspaceChangeSet", {
    changeSetId: value.changeSetId,
    workspaceId: value.workspaceId,
    sessionId: value.sessionId,
    runId: value.runId,
    turnId: value.turnId,
    baselineId: value.baselineId,
    changes: value.changes.map((change) => message<FileChange>("joko.v1.FileChange", {
      relativePath: change.relativePath,
      oldRelativePath: "",
      kind: change.kind === "created"
        ? FileChangeKind.CREATED
        : change.kind === "deleted" ? FileChangeKind.DELETED : FileChangeKind.UPDATED,
      beforeRevision: change.beforeRevision === undefined ? undefined : toProtoWorkspaceFileRevision(change.beforeRevision),
      afterRevision: change.afterRevision === undefined ? undefined : toProtoWorkspaceFileRevision(change.afterRevision),
      diff: undefined
    })),
    completeBaseline: value.completeBaseline,
    gaps: value.gaps.map((gap) => message<RewindGap>("joko.v1.RewindGap", {
      kind: /symbolic link|special file/iu.test(gap) ? RewindGapKind.UNSUPPORTED_FILE : RewindGapKind.CAPTURE_FAILED,
      relativePath: gap.includes(":") ? gap.slice(0, gap.indexOf(":")) : "",
      explanation: gap
    })),
    capturedAt: toProtoTimestamp(value.capturedAt)
  });
}

function toProtoWorkspaceDiffProjection(value: WorkspaceDiffProjection): WorkspaceDiff {
  return message<WorkspaceDiff>("joko.v1.WorkspaceDiff", {
    workspaceId: value.workspaceId,
    files: value.files.map((file) => message<FileDiff>("joko.v1.FileDiff", {
      relativePath: file.relativePath,
      oldRelativePath: file.oldRelativePath ?? "",
      status: toProtoGitFileStatus(file.status),
      binary: file.binary,
      source: GitDiffSource.UNSPECIFIED,
      hunks: [],
      fullDiff: undefined
    })),
    truncated: value.truncated,
    completeDiff: undefined
  });
}

function toProtoWorkspaceDescriptorProjection(value: WorkspaceDescriptorProjection): WorkspaceDescriptor {
  return message<WorkspaceDescriptor>("joko.v1.WorkspaceDescriptor", {
    workspaceId: value.workspaceId,
    targetId: value.targetId,
    displayName: value.displayName,
    kind: value.kind === "managed_dialogue" ? WorkspaceKind.MANAGED_DIALOGUE : WorkspaceKind.USER_PROJECT,
    serverPathDisplay: value.serverPathDisplay,
    trusted: value.trusted,
    git: value.git === undefined
      ? undefined
      : message<GitRepositoryState>("joko.v1.GitRepositoryState", {
        repository: value.git.repository,
        branchName: value.git.branchName ?? "",
        headCommit: value.git.headCommit ?? "",
        detachedHead: value.git.detachedHead,
        dirty: value.git.dirty,
        operationInProgress: value.git.operationInProgress,
        changes: value.git.changes.map((change) => message<GitFileChange>("joko.v1.GitFileChange", {
          relativePath: change.relativePath,
          oldRelativePath: change.oldRelativePath ?? "",
          indexStatus: toProtoGitFileStatus(change.indexStatus),
          workingTreeStatus: toProtoGitFileStatus(change.workingTreeStatus),
          binary: change.binary
        })),
        error: undefined
      }),
    version: toProtoEntityVersion(
      decimalRevision(value.revision, 0n),
      Number(decimalRevision(value.generation, 0n)),
      value.updatedAt
    )
  });
}

function toProtoWorkspaceEntryProjection(value: WorkspaceEntryProjection): WorkspaceEntry {
  return message<WorkspaceEntry>("joko.v1.WorkspaceEntry", {
    workspaceId: value.workspaceId,
    relativePath: value.relativePath,
    displayName: value.displayName,
    kind: value.kind === "directory" ? FileKind.DIRECTORY : FileKind.REGULAR,
    revision: value.revision === undefined ? undefined : toProtoWorkspaceFileRevision(value.revision),
    generated: value.generated,
    ignored: value.ignored,
    hidden: value.hidden,
    mediaType: value.mediaType
  });
}

function toProtoWorkspaceFileRevision(value: WorkspaceFileRevisionProjection): FileRevision {
  return message<FileRevision>("joko.v1.FileRevision", {
    sha256Hex: value.sha256Hex,
    byteSize: unsignedBigInt(value.byteSize, "workspace.file_revision.byte_size"),
    modifiedAt: toProtoTimestamp(value.modifiedAt),
    opaqueRevision: value.opaqueRevision
  });
}

function toProtoGitFileStatus(value: WorkspaceGitStatusProjection): GitFileStatus {
  switch (value) {
    case "unmodified": return GitFileStatus.UNMODIFIED;
    case "added": return GitFileStatus.ADDED;
    case "modified": return GitFileStatus.MODIFIED;
    case "deleted": return GitFileStatus.DELETED;
    case "renamed": return GitFileStatus.RENAMED;
    case "copied": return GitFileStatus.COPIED;
    case "untracked": return GitFileStatus.UNTRACKED;
    case "ignored": return GitFileStatus.IGNORED;
    case "conflicted": return GitFileStatus.CONFLICTED;
    default: return GitFileStatus.UNSPECIFIED;
  }
}

function fromProtoWorkspaceChangeSetProjection(value: WorkspaceChangeSet): WorkspaceChangeSetProjection {
  return {
    changeSetId: value.changeSetId,
    workspaceId: value.workspaceId,
    sessionId: value.sessionId,
    runId: value.runId,
    turnId: value.turnId,
    baselineId: value.baselineId,
    changes: value.changes.map((change) => ({
      relativePath: change.relativePath,
      kind: change.kind === FileChangeKind.CREATED
        ? "created"
        : change.kind === FileChangeKind.DELETED ? "deleted" : "updated",
      ...(change.beforeRevision === undefined
        ? {}
        : { beforeRevision: fromProtoWorkspaceFileRevision(change.beforeRevision) }),
      ...(change.afterRevision === undefined
        ? {}
        : { afterRevision: fromProtoWorkspaceFileRevision(change.afterRevision) })
    })),
    completeBaseline: value.completeBaseline,
    gaps: value.gaps.map((gap) => gap.explanation),
    capturedAt: fromProtoTimestamp(value.capturedAt, "workspace_change_set.captured_at") ?? 0
  };
}

function fromProtoWorkspaceDiffProjection(value: WorkspaceDiff): WorkspaceDiffProjection {
  return {
    workspaceId: value.workspaceId,
    files: value.files.map((file) => ({
      relativePath: file.relativePath,
      ...(file.oldRelativePath === "" ? {} : { oldRelativePath: file.oldRelativePath }),
      status: fromProtoGitFileStatus(file.status),
      binary: file.binary
    })),
    truncated: value.truncated
  };
}

function fromProtoWorkspaceDescriptorProjection(value: WorkspaceDescriptor): WorkspaceDescriptorProjection {
  const version = value.version;
  return {
    workspaceId: value.workspaceId,
    targetId: value.targetId,
    displayName: value.displayName,
    kind: value.kind === WorkspaceKind.MANAGED_DIALOGUE ? "managed_dialogue" : "user_project",
    // Absolute server paths are deliberately excluded from durable event payloads.
    serverPathDisplay: "",
    trusted: value.trusted,
    ...(value.git === undefined
      ? {}
      : {
          git: {
            repository: value.git.repository,
            ...(value.git.branchName === "" ? {} : { branchName: value.git.branchName }),
            ...(value.git.headCommit === "" ? {} : { headCommit: value.git.headCommit }),
            detachedHead: value.git.detachedHead,
            dirty: value.git.dirty,
            operationInProgress: value.git.operationInProgress,
            changes: value.git.changes.map((change) => ({
              relativePath: change.relativePath,
              ...(change.oldRelativePath === "" ? {} : { oldRelativePath: change.oldRelativePath }),
              indexStatus: fromProtoGitFileStatus(change.indexStatus),
              workingTreeStatus: fromProtoGitFileStatus(change.workingTreeStatus),
              binary: change.binary
            }))
          }
        }),
    revision: version?.revision?.value.toString(10) ?? "0",
    generation: version?.generation.toString(10) ?? "0",
    updatedAt: fromProtoTimestamp(version?.updatedAt, "workspace.version.updated_at") ?? 0
  };
}

function fromProtoWorkspaceEntryProjection(value: WorkspaceEntry): WorkspaceEntryProjection {
  return {
    workspaceId: value.workspaceId,
    relativePath: value.relativePath,
    displayName: value.displayName,
    kind: value.kind === FileKind.DIRECTORY ? "directory" : "regular",
    ...(value.revision === undefined ? {} : { revision: fromProtoWorkspaceFileRevision(value.revision) }),
    generated: value.generated,
    ignored: value.ignored,
    hidden: value.hidden,
    mediaType: value.mediaType
  };
}

function fromProtoWorkspaceFileRevision(value: FileRevision): WorkspaceFileRevisionProjection {
  return {
    sha256Hex: value.sha256Hex,
    byteSize: safeNumber(value.byteSize, "workspace.file_revision.byte_size"),
    modifiedAt: fromProtoTimestamp(value.modifiedAt, "workspace.file_revision.modified_at") ?? 0,
    opaqueRevision: value.opaqueRevision
  };
}

function fromProtoGitFileStatus(value: GitFileStatus): WorkspaceGitStatusProjection {
  switch (value) {
    case GitFileStatus.UNMODIFIED: return "unmodified";
    case GitFileStatus.ADDED: return "added";
    case GitFileStatus.MODIFIED: return "modified";
    case GitFileStatus.DELETED: return "deleted";
    case GitFileStatus.RENAMED: return "renamed";
    case GitFileStatus.COPIED: return "copied";
    case GitFileStatus.UNTRACKED: return "untracked";
    case GitFileStatus.IGNORED: return "ignored";
    case GitFileStatus.CONFLICTED: return "conflicted";
    default: return "unspecified";
  }
}

function decimalRevision(value: string, fallback: bigint): bigint {
  return /^\d+$/u.test(value) ? BigInt(value) : fallback;
}

function requiredDecimalRevision(value: string, fieldPath: string): bigint {
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new ProtoMappingError("invalid_argument", fieldPath, `${fieldPath} must be a decimal revision.`);
  }
  return BigInt(value);
}

export function toProtoExtraDirectory(record: ExtraDirectoryRecord): ProtoExtraDirectory {
  return message<ProtoExtraDirectory>("joko.v1.ExtraDirectory", {
    extraDirectoryId: record.id,
    workspaceId: record.workspaceId,
    serverPathDisplay: record.path,
    access: record.access === "read_write"
      ? ExtraDirectoryAccess.READ_WRITE
      : ExtraDirectoryAccess.READ_ONLY,
    trusted: true,
    version: toProtoEntityVersion(record.revision, 0, record.updatedAt)
  });
}

export function toProtoExtensionWidget(input: {
  readonly sessionId: string;
  readonly key: string;
  readonly lines: readonly string[];
  readonly placement: "above_editor" | "below_editor";
  readonly updatedAt: number;
  readonly removed: boolean;
}): ExtensionWidget {
  return message<ExtensionWidget>("joko.v1.ExtensionWidget", {
    sessionId: input.sessionId,
    widgetKey: input.key,
    lines: [...input.lines],
    placement: input.placement === "below_editor"
      ? ExtensionWidgetPlacement.BELOW_EDITOR
      : ExtensionWidgetPlacement.ABOVE_EDITOR,
    updatedAt: toProtoTimestamp(input.updatedAt),
    removed: input.removed
  });
}

export function toProtoExtensionStatus(input: {
  readonly sessionId: string;
  readonly key: string;
  readonly text: string;
  readonly updatedAt: number;
}): ExtensionStatus {
  return message<ExtensionStatus>("joko.v1.ExtensionStatus", {
    sessionId: input.sessionId,
    statusKey: input.key,
    statusText: input.text,
    updatedAt: toProtoTimestamp(input.updatedAt)
  });
}

export function toProtoToolLease(
  lease: ToolLeaseRecord,
  backendId: string
): ProtoToolLease {
  return message<ProtoToolLease>("joko.v1.ToolLease", {
    toolLeaseId: lease.id,
    toolProviderId: lease.toolId,
    backendId,
    sessionId: lease.sessionId,
    runId: lease.runId ?? "",
    generation: unsignedBigInt(lease.generation, "tool_lease.generation"),
    state: lease.state === "active"
      ? ToolLeaseState.ACTIVE
      : lease.state === "released" ? ToolLeaseState.RELEASED
        : lease.state === "expired" ? ToolLeaseState.EXPIRED : ToolLeaseState.FENCED,
    acquiredAt: toProtoTimestamp(lease.createdAt),
    expiresAt: toProtoTimestamp(lease.expiresAt),
    version: toProtoEntityVersion(lease.revision, lease.generation, lease.updatedAt)
  });
}

export function toProtoErrorInfo(error: PublicError): ErrorInfo {
  const sanitized = sanitizePublicError(error);
  const stateImpact = sanitized.stateMayHaveChanged ? StateImpact.MAY_HAVE_CHANGED : StateImpact.UNCHANGED;
  const actions: RecoveryAction[] = [];
  if (sanitized.retryable) {
    actions.push(message<RecoveryAction>("joko.v1.RecoveryAction", {
      kind: RecoveryActionKind.RETRY,
      label: sanitized.recovery,
      retryAfter: undefined
    }));
  } else if (sanitized.recovery !== "") {
    actions.push(message<RecoveryAction>("joko.v1.RecoveryAction", {
      kind: recoveryKind(sanitized.recovery),
      label: sanitized.recovery,
      retryAfter: undefined
    }));
  }
  return message<ErrorInfo>("joko.v1.ErrorInfo", {
    code: sanitized.code,
    phase: sanitized.phase,
    message: sanitized.message,
    severity: sanitized.retryable
      ? ErrorSeverity.RETRYABLE
      : sanitized.stateMayHaveChanged ? ErrorSeverity.BLOCKED : ErrorSeverity.FATAL,
    retryable: sanitized.retryable,
    queueImpact: stateImpact,
    workspaceImpact: stateImpact,
    nativeSessionImpact: stateImpact,
    recoveryActions: actions,
    diagnosticId: ""
  });
}

export function fromProtoErrorInfo(error: ErrorInfo): PublicError {
  const mayHaveChanged = [error.queueImpact, error.workspaceImpact, error.nativeSessionImpact]
    .some((impact) => impact === StateImpact.CHANGED || impact === StateImpact.MAY_HAVE_CHANGED || impact === StateImpact.UNKNOWN);
  return sanitizePublicError({
    code: error.code || "unknown",
    message: error.message,
    phase: error.phase || "unknown",
    retryable: error.retryable,
    stateMayHaveChanged: mayHaveChanged,
    recovery: error.recoveryActions.map((action) => action.label).filter(Boolean).join("; ") ||
      (error.retryable ? "Retry the operation." : "Open diagnostics.")
  });
}

export function mapErrorToProto(error: unknown): ErrorInfo {
  return toProtoErrorInfo(mapErrorToPublic(error));
}

export function mapErrorToPublic(error: unknown): PublicError {
  if (isPublicError(error)) return sanitizePublicError(error);
  if (error instanceof OperationConflictError) return publicError(
    "operation_id_conflict", error.message, "operation", false, false,
    "Generate a new operation ID or replay the original request body."
  );
  if (error instanceof OperationPreviouslyFailedError) return publicError(
    "operation_previously_failed", error.message, "operation", false, false,
    "Inspect the stored failure and create a new operation ID for an explicit retry."
  );
  if (error instanceof RevisionConflictError) return publicError(
    "revision_conflict", error.message, "projection", true, false,
    "Refresh the authoritative snapshot before retrying."
  );
  if (error instanceof StaleGenerationError) return publicError(
    "generation_mismatch", error.message, "session", false, true,
    "Fetch a fresh session snapshot and do not replay the stale mutation."
  );
  if (error instanceof AuthorizationError) return publicError(
    "connection_unauthorized", error.message, "authorization", false, false,
    "Reconnect or pair the device again."
  );
  if (error instanceof NotFoundError) return publicError(
    "not_found", error.message, "lookup", false, false,
    "Refresh the authoritative snapshot."
  );
  if (error instanceof PairingError) return publicError(
    "pairing_failed", error.message, "pairing", false, false,
    "Request a new pairing challenge."
  );
  if (error instanceof InvalidStateTransitionError) return publicError(
    "invalid_state_transition", error.message, "state", false, false,
    "Refresh the entity and choose an action valid for its current state."
  );
  if (error instanceof SensitiveDataError) return publicError(
    "sensitive_data_rejected", error.message, "serialization", false, false,
    "Store the credential in the credential channel and persist only its opaque reference."
  );
  if (error instanceof AsyncTransactionError) return publicError(
    "async_transaction_rejected", error.message, "storage", false, false,
    "Commit durable state before starting external asynchronous work."
  );
  if (error instanceof StoreClosedError) return publicError(
    "store_closed", error.message, "storage", true, false,
    "Wait for Orchestrator to restart and reconnect."
  );
  if (error instanceof StoreError) return publicError(
    "store_error", error.message, "storage", false, false,
    "Open diagnostics and contact the owner if the problem persists."
  );
  if (error instanceof ProtoMappingError) return publicError(
    error.code, error.message, "mapping", false, false,
    `Correct the invalid field: ${error.fieldPath}.`
  );
  return publicError(
    "internal_error",
    error instanceof Error ? error.message : "Unknown internal error.",
    "internal",
    false,
    false,
    "Open diagnostics and contact the owner if the problem persists."
  );
}

/** Map one Session-scoped durable command observation to the public contract. */
export function toProtoRuntimeCommand(
  item: CoreRuntimeCommand,
  sessionId: string
): contract.RuntimeCommand {
  const normalizedSessionId = requireText(sessionId, "runtime_command.session_id");
  const identity = `${normalizedSessionId}\u0000${item.source}\u0000${item.name}\u0000${item.path ?? ""}`;
  return message<contract.RuntimeCommand>("joko.v1.RuntimeCommand", {
    commandId: createHash("sha256").update(identity).digest("hex"),
    name: item.name,
    description: item.description,
    source: item.source === "extension"
      ? contract.RuntimeCommandSource.EXTENSION
      : item.source === "skill"
        ? contract.RuntimeCommandSource.SKILL
        : contract.RuntimeCommandSource.PROMPT,
    resourceId: "",
    loaded: item.loaded,
    sessionId: normalizedSessionId
  });
}

export function fromProtoRuntimeCommand(item: contract.RuntimeCommand): CoreRuntimeCommand {
  const source: CoreRuntimeCommand["source"] = item.source === contract.RuntimeCommandSource.EXTENSION
    ? "extension"
    : item.source === contract.RuntimeCommandSource.PROMPT
      ? "prompt"
      : item.source === contract.RuntimeCommandSource.SKILL
        ? "skill"
        : (() => {
            throw new ProtoMappingError(
              "unsupported_mapping",
              "runtime_command.source",
              "Runtime command source is not representable by the core Adapter contract."
            );
          })();
  return {
    name: requireText(item.name, "runtime_command.name"),
    description: item.description,
    source,
    loaded: item.loaded
  };
}

export function toProtoEvent(event: PersistedEvent, context: EventMappingContext = {}): ProtoEvent {
  const identity = message<EventIdentity>("joko.v1.EventIdentity", {
    backendId: event.backendId,
    targetId: event.targetId,
    sessionId: event.sessionId,
    runId: event.runId ?? "",
    attemptId: event.attemptId ?? "",
    operationId: event.operationId ?? "",
    queueItemId: queueItemId(event, context),
    toolLeaseId: "",
    generation: unsignedBigInt(event.generation, "event.identity.generation"),
    sequence: event.sequence,
    trace: message<TraceContext>("joko.v1.TraceContext", {
      traceId: event.traceId,
      spanId: "",
      parentSpanId: ""
    })
  });
  return message<ProtoEvent>("joko.v1.Event", {
    eventId: event.id,
    cursor: toProtoEventCursor(event.globalCursor, event.generation, event.emittedAt),
    identity,
    occurredAt: toProtoTimestamp(event.emittedAt),
    actor: message<ActorRef>("joko.v1.ActorRef", {
      kind: ActorKind.ORCHESTRATOR,
      id: "orchestrator",
      displayName: "Orchestrator"
    }),
    payload: toProtoEventPayload(event, context),
    pi: event.pi === undefined ? undefined : toProtoPiMetadata(event.pi)
  });
}

export function fromProtoEvent(event: ProtoEvent): AppendEventInput {
  if (event.identity === undefined || event.payload === undefined) {
    throw new ProtoMappingError("invalid_argument", "event", "Event identity and payload are required.");
  }
  const identity = event.identity;
  const occurredAt = fromProtoTimestamp(event.occurredAt, "event.occurred_at");
  return {
    id: requireText(event.eventId, "event.event_id"),
    ...(occurredAt === undefined ? {} : { emittedAt: occurredAt }),
    backendId: requireText(identity.backendId, "event.identity.backend_id"),
    targetId: requireText(identity.targetId, "event.identity.target_id"),
    sessionId: requireText(identity.sessionId, "event.identity.session_id"),
    ...(identity.runId === "" ? {} : { runId: identity.runId }),
    ...(identity.attemptId === "" ? {} : { attemptId: identity.attemptId }),
    ...(identity.operationId === "" ? {} : { operationId: identity.operationId }),
    generation: safeNumber(identity.generation, "event.identity.generation"),
    traceId: requireText(identity.trace?.traceId ?? "", "event.identity.trace.trace_id"),
    payload: fromProtoEventPayload(event.payload, identity.sessionId, occurredAt),
    ...(event.pi === undefined ? {} : { pi: fromProtoPiMetadata(event.pi) })
  };
}

function toProtoEventPayload(event: PersistedEvent, context: EventMappingContext): ProtoEventPayload {
  const payload = event.payload;
  switch (payload.type) {
    case "run_state": {
      if (context.run === undefined) throw missingPayload("event.context.run");
      if (context.target === undefined) throw missingPayload("event.context.target");
      return protoPayload("runChanged", message("joko.v1.RunChangedEvent", {
        run: toProtoRun(context.run, {
          backendId: event.backendId,
          targetId: event.targetId,
          attempts: context.attempts ?? []
        })
      }));
    }
    case "session_changed":
      if (context.session === undefined) throw missingPayload("event.context.session");
      return protoPayload("sessionChanged", message<contract.SessionChangedEvent>("joko.v1.SessionChangedEvent", {
        session: toProtoSession(context.session, context.sessionContext)
      }));
    case "text_delta":
      return protoPayload("textDelta", message<TextDeltaEvent>("joko.v1.TextDeltaEvent", {
        messageId: payload.blockId,
        contentIndex: payload.contentIndex ?? 0,
        delta: payload.delta
      }));
    case "thinking_delta":
      return protoPayload("thinkingDelta", message<ThinkingDeltaEvent>("joko.v1.ThinkingDeltaEvent", {
        messageId: payload.blockId,
        contentIndex: payload.contentIndex ?? 0,
        delta: payload.delta,
        hidden: false
      }));
    case "message_complete":
      if (payload.role === "user") {
        if (payload.generationDurationMs !== undefined || payload.generationReliable !== undefined) {
          throw new ProtoMappingError(
            "invalid_argument",
            "event.payload.message_completed.generation_reliable",
            "User messages cannot carry model generation timing."
          );
        }
        return protoPayload("messageStarted", message<MessageStartedEvent>("joko.v1.MessageStartedEvent", {
          messageId: payload.nativeHistory?.identity?.entryId ?? event.id,
          turnId: event.runId ?? "",
          role: MessageRole.USER,
          userInput: toProtoInputContent(promptInputFromMessageBlocks(
            payload.blocks,
            payload.quotesEncoded === true,
            payload.pastedTextRanges
          )),
          quotesEncoded: payload.quotesEncoded === true,
          inputDelivery: toProtoMessageInputDelivery(payload.inputDelivery),
          automationOrigin: payload.automationOrigin === undefined
            ? undefined
            : message<ProtoMessageAutomationOrigin>("joko.v1.MessageAutomationOrigin", {
                scheduleId: payload.automationOrigin.scheduleId,
                scheduleName: payload.automationOrigin.scheduleName ?? "",
                runId: payload.automationOrigin.runId ?? event.runId ?? ""
              }),
          nativeIdentity: toProtoNativeMessageIdentity(payload.nativeHistory?.identity),
          automaticContinuation: payload.automaticContinuation !== undefined,
          runtimeRecoveryId: payload.automaticContinuation?.recoveryId ?? ""
        }));
      }
      return protoPayload("messageCompleted", message<MessageCompletedEvent>("joko.v1.MessageCompletedEvent", {
        messageId: payload.nativeHistory?.identity?.entryId ?? event.id,
        turnId: event.runId ?? "",
        role: MessageRole.ASSISTANT,
        blocks: payload.blocks.map(toProtoMessageBlock),
        usage: payload.usage === undefined ? undefined : toProtoUsage(payload.usage),
        stopReason: "",
        nativeIdentity: toProtoNativeMessageIdentity(payload.nativeHistory?.identity),
        ...toProtoMessageGenerationTiming(payload)
      }));
    case "runtime_recovery":
      return protoPayload("runtimeRecoveryChanged", message<RuntimeRecoveryChangedEvent>("joko.v1.RuntimeRecoveryChangedEvent", {
        recoveryId: payload.recoveryId,
        sourceRunId: payload.sourceRunId,
        continuationRunId: payload.continuationRunId ?? "",
        state: toProtoRuntimeRecoveryState(payload.state),
        attempt: payload.attempt,
        maximumAttempts: payload.maximumAttempts,
        sessionTotal: payload.sessionTotal,
        delayMs: payload.delayMs ?? 0,
        routeChanged: payload.routeChanged === true,
        error: toProtoErrorInfo(payload.error)
      }));
    case "status":
      return statusPayload(payload.key, payload.key, payload.text ?? "", false);
    case "extension_ui_effect":
      return protoPayload("extensionUiEffect", message<ExtensionUiEffectEvent>("joko.v1.ExtensionUiEffectEvent", {
        kind: payload.effect === "notification"
          ? contract.ExtensionUiEffectKind.NOTIFICATION
          : payload.effect === "title"
            ? contract.ExtensionUiEffectKind.TITLE
            : contract.ExtensionUiEffectKind.EDITOR_TEXT,
        text: payload.text,
        notificationKind: toProtoExtensionNotificationKind(payload.notificationKind)
      }));
    case "tool_start":
      return protoPayload("toolCallStarted", message<ToolCallStartedEvent>("joko.v1.ToolCallStartedEvent", {
        toolCall: protoToolCall(event, payload.callId, payload.name, ToolCallState.RUNNING, payload.input)
      }));
    case "tool_update":
      return protoPayload("toolCallUpdated", message<ToolCallUpdatedEvent>("joko.v1.ToolCallUpdatedEvent", {
        toolCall: protoToolCall(event, payload.callId, payload.name, ToolCallState.RUNNING),
        incrementalResult: protoToolResult(payload.output, payload.artifact, payload.parts),
        outputMode: toProtoToolCallOutputMode(payload.outputMode)
      }));
    case "tool_result":
      return protoPayload("toolCallCompleted", message<ToolCallCompletedEvent>("joko.v1.ToolCallCompletedEvent", {
        toolCall: {
          ...protoToolCall(
            event,
            payload.callId,
            payload.name,
            payload.isError ? ToolCallState.FAILED : ToolCallState.SUCCEEDED
          ),
          endedAt: toProtoTimestamp(event.emittedAt),
          result: protoToolResult(payload.output, payload.artifact, payload.parts)
        }
      }));
    case "artifact": {
      const artifact = context.artifact === undefined
        ? artifactFromBlob(payload.artifact, event, payload.purpose)
        : toProtoArtifact(context.artifact);
      return protoPayload("artifactProduced", message<ArtifactProducedEvent>("joko.v1.ArtifactProducedEvent", {
        artifact
      }));
    }
    case "workspace_diff": {
      if (payload.changeSet === undefined) throw missingPayload("event.payload.workspace_diff.change_set");
      if (payload.diff === undefined) throw missingPayload("event.payload.workspace_diff.diff");
      if (payload.workspace === undefined) throw missingPayload("event.payload.workspace_diff.workspace");
      if (payload.entriesRevision === undefined) throw missingPayload("event.payload.workspace_diff.entries_revision");
      if (payload.upsertedEntries === undefined) throw missingPayload("event.payload.workspace_diff.upserted_entries");
      if (payload.removedRelativePaths === undefined) throw missingPayload("event.payload.workspace_diff.removed_relative_paths");
      return protoPayload("workspaceDiffProduced", message<WorkspaceDiffProducedEvent>("joko.v1.WorkspaceDiffProducedEvent", {
        turnId: payload.changeSet.turnId,
        changeSet: toProtoWorkspaceChangeSetProjection(payload.changeSet),
        diff: toProtoWorkspaceDiffProjection(payload.diff),
        workspace: toProtoWorkspaceDescriptorProjection(payload.workspace),
        entriesRevision: toProtoRevision(requiredDecimalRevision(
          payload.entriesRevision,
          "event.payload.workspace_diff.entries_revision"
        )),
        upsertedEntries: payload.upsertedEntries.map(toProtoWorkspaceEntryProjection),
        removedRelativePaths: [...payload.removedRelativePaths]
      }));
    }
    case "interaction_opened":
      return protoPayload("interactionChanged", message<InteractionChangedEvent>("joko.v1.InteractionChangedEvent", {
        interaction: context.interaction === undefined
          ? interactionFromPayload(payload.interaction, event, "open")
          : toProtoInteraction(context.interaction, { backendId: event.backendId, targetId: event.targetId })
      }));
    case "interaction_resolved":
      return protoPayload("interactionChanged", message<InteractionChangedEvent>("joko.v1.InteractionChangedEvent", {
        interaction: context.interaction === undefined
          ? resolvedInteractionFromEvent(payload.interactionId, payload.decision, event, false)
          : toProtoInteraction(context.interaction, { backendId: event.backendId, targetId: event.targetId })
      }));
    case "interaction_dismissed":
      return protoPayload("interactionChanged", message<InteractionChangedEvent>("joko.v1.InteractionChangedEvent", {
        interaction: context.interaction === undefined
          ? resolvedInteractionFromEvent(payload.interactionId, payload.reason, event, true)
          : toProtoInteraction(context.interaction, { backendId: event.backendId, targetId: event.targetId })
      }));
    case "queue_update":
      if (context.queueItem === undefined) throw missingPayload("event.context.queue_item");
      if (context.session === undefined) throw missingPayload("event.context.session");
      if (context.run === undefined) throw missingPayload("event.context.run");
      return protoPayload("queueItemChanged", message<QueueItemChangedEvent>("joko.v1.QueueItemChangedEvent", {
        queueItem: toProtoQueueItem(context.queueItem, {
          backendId: event.backendId,
          targetId: event.targetId,
          source: context.run.descriptor.source,
          ...(context.run.descriptor.parentRunId === undefined
            ? {}
            : { parentRunId: context.run.descriptor.parentRunId }),
          generation: context.session.descriptor.binding.generation
        })
      }));
    case "queue_control":
      if (context.queueControl === undefined) throw missingPayload("event.context.queue_control");
      if (context.session === undefined) throw missingPayload("event.context.session");
      return protoPayload("queueControlChanged", message<QueueControlChangedEvent>("joko.v1.QueueControlChangedEvent", {
        queueControl: toProtoQueueControl(context.queueControl, context.session, 0)
      }));
    case "compaction": {
      const reason = payload.reason || "compaction";
      return protoPayload("compactionChanged", message<CompactionChangedEvent>("joko.v1.CompactionChangedEvent", {
        compactionId: payload.compactionId,
        state: toProtoCompactionState(payload.state),
        boundaryId: payload.boundaryEntryId ?? "",
        tokensBefore: unsignedBigInt(
          payload.tokensBefore ?? 0,
          "event.payload.compaction.tokens_before"
        ),
        tokensAfter: unsignedBigInt(
          payload.tokensAfter ?? 0,
          "event.payload.compaction.tokens_after"
        ),
        automatic: payload.automatic ?? automaticCompactionReason(reason),
        error: optionalError(payload.error),
        reason,
        willRetry: payload.willRetry
      }));
    }
    case "retry":
      return protoPayload("retryChanged", message<RetryChangedEvent>("joko.v1.RetryChangedEvent", {
        runId: event.runId ?? "",
        attemptId: event.attemptId ?? "",
        state: toProtoRetryState(payload.state),
        attemptNumber: unsignedInt32(payload.attempt, "event.payload.retry.attempt"),
        retryAt: payload.state === "waiting"
          ? toProtoTimestamp(event.emittedAt + (payload.delayMs ?? 0))
          : undefined,
        maxAttempts: payload.maxAttempts === undefined
          ? undefined
          : unsignedInt32(payload.maxAttempts, "event.payload.retry.max_attempts"),
        error: optionalError(payload.error)
      }));
    case "usage":
      return protoPayload("contextUsageChanged", message<ContextUsageChangedEvent>("joko.v1.ContextUsageChangedEvent", {
        context: toProtoContextUsage(payload.usage, event.emittedAt)
      }));
    case "context_cleared":
      return protoPayload("contextUsageChanged", message<ContextUsageChangedEvent>("joko.v1.ContextUsageChangedEvent", {
        context: undefined
      }));
    case "context_rebuild":
      return protoPayload("contextRebuilt", message<ContextRebuiltEvent>("joko.v1.ContextRebuiltEvent", {
        productSessionId: event.sessionId,
        reason: payload.reason === "context_overflow"
          ? ProtoContextRebuildReason.CONTEXT_OVERFLOW
          : ProtoContextRebuildReason.PROMPT_TIMEOUT,
        handoff: payload.handoff,
        sourceRunId: payload.sourceRunId ?? "",
        replayScheduled: payload.replayScheduled
      }));
    case "message_deleted":
      return protoPayload("messageDeleted", message<contract.MessageDeletedEvent>("joko.v1.MessageDeletedEvent", {
        productSessionId: event.sessionId,
        requestedEventId: payload.requestedEventId,
        deletedEventIds: [...payload.deletedEventIds]
      }));
    case "session_reset":
      return protoPayload("sessionReset", message<contract.SessionResetEvent>("joko.v1.SessionResetEvent", {
        productSessionId: event.sessionId
      }));
    case "history_pruned":
      return protoPayload("historyPruned", message<HistoryPrunedEvent>("joko.v1.HistoryPrunedEvent", {
        productSessionId: event.sessionId,
        activeContextReset: payload.activeContextReset
      }));
    case "native_session_changed":
      return protoPayload("nativeSessionChanged", message<NativeSessionChangedEvent>("joko.v1.NativeSessionChangedEvent", {
        productSessionId: event.sessionId,
        previousOpaqueNativeReference: "",
        opaqueNativeReference: payload.opaqueRef,
        change: NativeSessionChangeKind.SWITCHED
      }));
    case "runtime_commands_changed":
      return protoPayload("runtimeCommandsChanged", message<RuntimeCommandsChangedEvent>("joko.v1.RuntimeCommandsChangedEvent", {
        commands: payload.commands.map((command) => toProtoRuntimeCommand(command, event.sessionId))
      }));
    case "review_run_changed":
      return protoPayload("reviewRunChanged", message<ReviewRunChangedEvent>("joko.v1.ReviewRunChangedEvent", {
        reviewRun: message<ProtoReviewRun>("joko.v1.ReviewRun", {
          reviewRunId: payload.reviewRun.id,
          sourceSessionId: payload.reviewRun.sourceSessionId,
          reviewerSessionId: payload.reviewRun.reviewerSessionId ?? "",
          state: payload.reviewRun.state === "running" ? ReviewRunState.RUNNING
            : payload.reviewRun.state === "completed" ? ReviewRunState.COMPLETED : ReviewRunState.FAILED,
          targetKind: payload.reviewRun.targetKind === "changes" ? ReviewTargetKind.CHANGES
            : payload.reviewRun.targetKind === "artifacts" ? ReviewTargetKind.ARTIFACTS
              : payload.reviewRun.targetKind === "mixed" ? ReviewTargetKind.MIXED : ReviewTargetKind.TASK,
          failureCode: toProtoReviewFailureCode(payload.reviewRun.failureCode),
          resultMarkdown: payload.reviewRun.result ?? "",
          freshness: toProtoReviewFreshness(payload.reviewRun.freshness, payload.reviewRun.freshnessCheckedAt),
          evidence: toProtoReviewEvidence(payload.reviewRun.evidence),
          createdAt: toProtoTimestamp(payload.reviewRun.createdAt),
          updatedAt: toProtoTimestamp(payload.reviewRun.updatedAt),
          endedAt: payload.reviewRun.endedAt === undefined ? undefined : toProtoTimestamp(payload.reviewRun.endedAt),
          revision: toProtoRevision(BigInt(payload.reviewRun.revision))
        })
      }));
    case "session_attention":
      return protoPayload(
        "sessionAttentionChanged",
        message<contract.SessionAttentionChangedEvent>("joko.v1.SessionAttentionChangedEvent", {
          attention: toProtoSessionAttention({
            kind: payload.kind,
            unread: payload.unread,
            subjectCursor: BigInt(payload.subjectCursor),
            subjectGeneration: payload.subjectGeneration,
            attentionCursor: BigInt(payload.attentionCursor),
            attentionGeneration: payload.attentionGeneration,
            readThroughCursor: BigInt(payload.readThroughCursor),
            readThroughGeneration: payload.readThroughGeneration,
            updatedAt: event.emittedAt
          })
        })
      );
    case "background_task":
      return protoPayload("backgroundTaskChanged", message<BackgroundTaskChangedEvent>("joko.v1.BackgroundTaskChangedEvent", {
        backgroundTask: message<BackgroundTask>("joko.v1.BackgroundTask", {
          backgroundTaskId: payload.taskId,
          parentTaskId: payload.parentTaskId ?? "",
          backendId: event.backendId,
          targetId: event.targetId,
          sessionId: event.sessionId,
          runId: event.runId ?? "",
          displayName: payload.title,
          state: backgroundTaskState(payload.state),
          statusText: payload.detail ?? "",
          progressRatio: optionalProgressRatio(payload.progressRatio, "background_task.progress_ratio"),
          startedAt: optionalTimestamp(payload.startedAt),
          endedAt: optionalTimestamp(payload.endedAt),
          version: toProtoEntityVersion(event.revision, event.generation, event.emittedAt),
          error: optionalError(payload.error),
          createdAt: toProtoTimestamp(event.emittedAt),
          updatedAt: toProtoTimestamp(event.emittedAt)
        })
      }));
    case "subagent_run":
      return protoPayload("subagentRunChanged", message<contract.SubagentRunChangedEvent>("joko.v1.SubagentRunChangedEvent", {
        run: toProtoSubagentRunDetail(payload.run, {
          revision: event.revision,
          generation: event.generation,
          updatedAt: event.emittedAt
        })
      }));
    case "subagent_transcript":
      return protoPayload("subagentTranscriptAppended", message<contract.SubagentTranscriptAppendedEvent>("joko.v1.SubagentTranscriptAppendedEvent", {
        subagentRunId: payload.subagentRunId,
        entry: toProtoSubagentTranscriptEntry(payload.entry)
      }));
    case "extension_widget":
      return protoPayload("extensionWidgetChanged", message<ExtensionWidgetChangedEvent>("joko.v1.ExtensionWidgetChangedEvent", {
        widget: toProtoExtensionWidget({
          sessionId: event.sessionId,
          key: payload.key,
          lines: payload.lines,
          placement: payload.placement,
          updatedAt: event.emittedAt,
          removed: payload.removed
        })
      }));
    case "extension_status":
      return protoPayload("extensionStatusChanged", message<ExtensionStatusChangedEvent>("joko.v1.ExtensionStatusChangedEvent", {
        status: payload.text === undefined ? message<ExtensionStatus>("joko.v1.ExtensionStatus", {
          sessionId: event.sessionId,
          statusKey: payload.key,
          statusText: undefined,
          updatedAt: toProtoTimestamp(event.emittedAt)
        }) : toProtoExtensionStatus({
          sessionId: event.sessionId,
          key: payload.key,
          text: payload.text,
          updatedAt: event.emittedAt
        })
      }));
    case "error":
      return payload.terminal
        ? protoPayload("terminalError", message<TerminalErrorEvent>("joko.v1.TerminalErrorEvent", {
          error: toProtoErrorInfo(payload.error)
        }))
        : protoPayload("recoverableError", message<RecoverableErrorEvent>("joko.v1.RecoverableErrorEvent", {
          error: toProtoErrorInfo(payload.error)
        }));
    case "done":
      if (payload.outcome === "aborted") {
        return protoPayload("runAborted", message<RunAbortedEvent>("joko.v1.RunAbortedEvent", {
          runId: event.runId ?? "",
          reason: "aborted"
        }));
      }
      if (payload.outcome === "failed") {
        if (context.run === undefined) throw missingPayload("event.context.run");
        if (context.target === undefined) throw missingPayload("event.context.target");
        return protoPayload("runChanged", message("joko.v1.RunChangedEvent", {
          run: toProtoRun(context.run, {
            backendId: event.backendId,
            targetId: event.targetId,
            attempts: context.attempts ?? []
          })
        }));
      }
      return protoPayload("runDone", message<RunDoneEvent>("joko.v1.RunDoneEvent", {
        runId: event.runId ?? "",
        usage: undefined
      }));
  }
}

function fromProtoEventPayload(
  payload: ProtoEventPayload,
  sessionId: string,
  occurredAt?: number
): EventPayload {
  switch (payload.kind.case) {
    case "sessionChanged":
      return { type: "session_changed" };
    case "runChanged": {
      const run = payload.kind.value.run;
      if (run === undefined) throw missingPayload("run_changed.run");
      return {
        type: "run_state",
        state: coreRunStateName(fromProtoRunState(run.state)),
        ...(run.error === undefined ? {} : { error: fromProtoErrorInfo(run.error) })
      };
    }
    case "textDelta":
      return {
        type: "text_delta",
        blockId: payload.kind.value.messageId,
        delta: payload.kind.value.delta,
        contentIndex: payload.kind.value.contentIndex
      };
    case "thinkingDelta":
      return {
        type: "thinking_delta",
        blockId: payload.kind.value.messageId,
        delta: payload.kind.value.delta,
        contentIndex: payload.kind.value.contentIndex
      };
    case "messageStarted": {
      const input = fromProtoInputContent(payload.kind.value.userInput, "prompt");
      const origin = payload.kind.value.automationOrigin;
      const inputDelivery = fromProtoMessageInputDelivery(payload.kind.value.inputDelivery);
      return {
        type: "message_complete",
        role: payload.kind.value.role === MessageRole.ASSISTANT ? "assistant" : "user",
        blocks: [
          ...(input.text === "" ? [] : [{ kind: "text" as const, text: input.text }]),
          ...input.images.map((image) => ({ kind: "image" as const, blob: image.blob, ...(image.alt === undefined ? {} : { alt: image.alt }) })),
          ...input.files.map((file) => ({ kind: "artifact" as const, blob: file.blob, label: file.blob.fileName ?? "file" }))
        ],
        ...(payload.kind.value.quotesEncoded === true || input.quotesEncoded === true ? { quotesEncoded: true } : {}),
        ...(input.pastedTextRanges === undefined ? {} : { pastedTextRanges: input.pastedTextRanges }),
        ...(inputDelivery === undefined ? {} : { inputDelivery }),
        ...(payload.kind.value.automaticContinuation && payload.kind.value.runtimeRecoveryId.trim().length > 0 ? {
          automaticContinuation: {
            recoveryId: payload.kind.value.runtimeRecoveryId
          }
        } : {}),
        ...(fromProtoNativeMessageIdentity(payload.kind.value.nativeIdentity) === undefined
          ? {}
          : { nativeHistory: { identity: fromProtoNativeMessageIdentity(payload.kind.value.nativeIdentity)! } }),
        ...(origin === undefined ? {} : {
          automationOrigin: {
            kind: "scheduler" as const,
            scheduleId: requireText(origin.scheduleId, "event.payload.message_started.automation_origin.schedule_id"),
            ...(origin.scheduleName === "" ? {} : { scheduleName: origin.scheduleName }),
            ...(origin.runId === "" ? {} : { runId: origin.runId })
          }
        })
      };
    }
    case "runtimeRecoveryChanged": {
      const recovery = payload.kind.value;
      if (recovery.error === undefined) throw missingPayload("runtime_recovery_changed.error");
      return {
        type: "runtime_recovery",
        recoveryId: requireText(recovery.recoveryId, "event.payload.runtime_recovery_changed.recovery_id"),
        sourceRunId: requireText(recovery.sourceRunId, "event.payload.runtime_recovery_changed.source_run_id"),
        ...(recovery.continuationRunId === "" ? {} : { continuationRunId: recovery.continuationRunId }),
        state: fromProtoRuntimeRecoveryState(recovery.state),
        attempt: positiveUnsignedInt32(recovery.attempt, "event.payload.runtime_recovery_changed.attempt"),
        maximumAttempts: positiveUnsignedInt32(recovery.maximumAttempts, "event.payload.runtime_recovery_changed.maximum_attempts"),
        sessionTotal: positiveUnsignedInt32(recovery.sessionTotal, "event.payload.runtime_recovery_changed.session_total"),
        ...(recovery.delayMs === 0 ? {} : { delayMs: unsignedInt32(recovery.delayMs, "event.payload.runtime_recovery_changed.delay_ms") }),
        ...(recovery.routeChanged ? { routeChanged: true } : {}),
        error: fromProtoErrorInfo(recovery.error)
      };
    }
    case "messageCompleted": {
      const generationTiming = fromProtoMessageGenerationTiming(payload.kind.value);
      if (payload.kind.value.role === MessageRole.USER && Object.keys(generationTiming).length > 0) {
        throw new ProtoMappingError(
          "invalid_argument",
          "event.payload.message_completed.generation_reliable",
          "User messages cannot carry model generation timing."
        );
      }
      return {
        type: "message_complete",
        role: payload.kind.value.role === MessageRole.USER ? "user" : "assistant",
        blocks: payload.kind.value.blocks.map(fromProtoMessageBlock),
        ...(payload.kind.value.usage === undefined
          ? {}
          : { usage: fromProtoUsage(payload.kind.value.usage) }),
        ...(fromProtoNativeMessageIdentity(payload.kind.value.nativeIdentity) === undefined
          ? {}
          : { nativeHistory: { identity: fromProtoNativeMessageIdentity(payload.kind.value.nativeIdentity)! } }),
        ...generationTiming
      };
    }
    case "statusStream":
      return fromStatusPayload(payload.kind.value);
    case "extensionUiEffect": {
      const effect = payload.kind.value;
      const kind = effect.kind === contract.ExtensionUiEffectKind.NOTIFICATION
        ? "notification" as const
        : effect.kind === contract.ExtensionUiEffectKind.TITLE
          ? "title" as const
          : effect.kind === contract.ExtensionUiEffectKind.EDITOR_TEXT
            ? "editor_text" as const
            : undefined;
      if (kind === undefined) {
        throw new ProtoMappingError(
          "unsupported_mapping",
          "event.payload.extension_ui_effect.kind",
          "Extension UI effect kind is not representable by the core event contract."
        );
      }
      return {
        type: "extension_ui_effect",
        effect: kind,
        text: effect.text,
        ...(kind === "notification"
          ? { notificationKind: fromProtoExtensionNotificationKind(effect.notificationKind) }
          : {})
      };
    }
    case "toolCallStarted": {
      const call = payload.kind.value.toolCall;
      if (call === undefined) throw missingPayload("tool_call_started.tool_call");
      return {
        type: "tool_start",
        callId: call.toolCallId,
        name: call.toolId,
        input: toolInput(call)
      };
    }
    case "toolCallUpdated": {
      const call = payload.kind.value.toolCall;
      if (call === undefined) throw missingPayload("tool_call_updated.tool_call");
      const result = payload.kind.value.incrementalResult;
      const parts = coreToolResultParts(result);
      const outputMode = fromProtoToolCallOutputMode(payload.kind.value.outputMode);
      return {
        type: "tool_update",
        callId: call.toolCallId,
        name: requireText(call.toolId, "event.payload.tool_call_updated.tool_call.tool_id"),
        output: toolOutput(result),
        ...(outputMode === undefined ? {} : { outputMode }),
        ...(parts.length === 0 ? {} : { parts }),
        ...(result?.completeOutput === undefined ? {} : { artifact: fromProtoBlobRef(result.completeOutput) })
      };
    }
    case "toolCallCompleted": {
      const call = payload.kind.value.toolCall;
      if (call === undefined) throw missingPayload("tool_call_completed.tool_call");
      const parts = coreToolResultParts(call.result);
      return {
        type: "tool_result",
        callId: call.toolCallId,
        name: requireText(call.toolId, "event.payload.tool_call_completed.tool_call.tool_id"),
        output: toolOutput(call.result),
        ...(parts.length === 0 ? {} : { parts }),
        ...(call.result?.completeOutput === undefined ? {} : { artifact: fromProtoBlobRef(call.result.completeOutput) }),
        isError: call.state === ToolCallState.FAILED || call.state === ToolCallState.ABORTED
      };
    }
    case "artifactProduced": {
      const artifact = payload.kind.value.artifact;
      if (artifact?.blob === undefined) throw missingPayload("artifact_produced.artifact.blob");
      return {
        type: "artifact",
        artifact: fromProtoBlobRef(artifact.blob),
        purpose: artifact.description || artifact.title || "artifact"
      };
    }
    case "workspaceDiffProduced": {
      const produced = payload.kind.value;
      if (produced.changeSet === undefined) throw missingPayload("workspace_diff_produced.change_set");
      if (produced.diff === undefined) throw missingPayload("workspace_diff_produced.diff");
      if (produced.workspace === undefined) throw missingPayload("workspace_diff_produced.workspace");
      if (produced.entriesRevision === undefined) throw missingPayload("workspace_diff_produced.entries_revision");
      const count = produced.changeSet.changes.length;
      return {
        type: "workspace_diff",
        changeSetId: produced.changeSet.changeSetId,
        summary: `${count} workspace file${count === 1 ? "" : "s"} changed`,
        changeSet: fromProtoWorkspaceChangeSetProjection(produced.changeSet),
        diff: fromProtoWorkspaceDiffProjection(produced.diff),
        workspace: fromProtoWorkspaceDescriptorProjection(produced.workspace),
        entriesRevision: produced.entriesRevision.value.toString(10),
        upsertedEntries: produced.upsertedEntries.map(fromProtoWorkspaceEntryProjection),
        removedRelativePaths: [...produced.removedRelativePaths]
      };
    }
    case "interactionChanged": {
      const interaction = payload.kind.value.interaction;
      if (interaction === undefined) throw missingPayload("interaction_changed.interaction");
      if (interaction.state === InteractionState.RESOLVED) {
        return {
          type: "interaction_resolved",
          interactionId: interaction.interactionId,
          decision: interaction.resolution === undefined
            ? "resolved"
            : JSON.stringify(fromProtoInteractionDecision(interaction.resolution))
        };
      }
      if (interaction.state === InteractionState.DISMISSED) {
        const resolution = interaction.resolution === undefined
          ? undefined
          : fromProtoInteractionDecision(interaction.resolution);
        return {
          type: "interaction_dismissed",
          interactionId: interaction.interactionId,
          reason: resolution?.kind === "dismissal" ? resolution.reason : "dismissed"
        };
      }
      return { type: "interaction_opened", interaction: fromProtoInteractionRequest(interaction) };
    }
    case "queueItemChanged":
      return {
        type: "queue_update",
        ...(payload.kind.value.queueItem?.queueItemId === undefined
          ? {}
          : { itemId: payload.kind.value.queueItem.queueItemId }),
        steering: [],
        followUps: []
      };
    case "queueControlChanged": {
      const control = payload.kind.value.queueControl;
      if (control === undefined) throw missingPayload("queue_control_changed.queue_control");
      return {
        type: "queue_control",
        paused: control.dispatchState === QueueDispatchState.PAUSED,
        ...(control.pauseReason === "" ? {} : { reason: control.pauseReason }),
        ...(fromProtoTimestamp(control.pausedAt, "queue_control.paused_at") === undefined
          ? {}
          : { pausedAt: fromProtoTimestamp(control.pausedAt, "queue_control.paused_at") as number }),
        ...(control.pausedBy?.id === undefined || control.pausedBy.id === ""
          ? {}
          : { connectionId: control.pausedBy.id })
      };
    }
    case "compactionChanged": {
      const compaction = payload.kind.value;
      const state = fromProtoCompactionState(compaction.state);
      return {
        type: "compaction",
        compactionId: requireText(compaction.compactionId, "event.payload.compaction_changed.compaction_id"),
        reason: compaction.reason || compaction.boundaryId || "compaction",
        state,
        ...(compaction.boundaryId === "" ? {} : { boundaryEntryId: compaction.boundaryId }),
        tokensBefore: safeNumber(compaction.tokensBefore, "event.payload.compaction.tokens_before"),
        tokensAfter: safeNumber(compaction.tokensAfter, "event.payload.compaction.tokens_after"),
        automatic: compaction.automatic,
        ...(compaction.willRetry === undefined ? {} : { willRetry: compaction.willRetry }),
        ...(compaction.error === undefined ? {} : { error: fromProtoErrorInfo(compaction.error) })
      };
    }
    case "retryChanged": {
      const retryAt = fromProtoTimestamp(payload.kind.value.retryAt, "retry_changed.retry_at");
      return {
        type: "retry",
        state: fromProtoRetryState(payload.kind.value.state),
        attempt: payload.kind.value.attemptNumber,
        ...(payload.kind.value.maxAttempts === undefined ? {} : { maxAttempts: payload.kind.value.maxAttempts }),
        ...(retryAt === undefined || occurredAt === undefined ? {} : { delayMs: retryAt - occurredAt }),
        ...(payload.kind.value.error === undefined ? {} : { error: fromProtoErrorInfo(payload.kind.value.error) })
      };
    }
    case "contextUsageChanged": {
      const usage = payload.kind.value.context?.cumulativeUsage;
      if (usage === undefined) return { type: "context_cleared" };
      return { type: "usage", usage: fromProtoUsage(usage, payload.kind.value.context) };
    }
    case "contextRebuilt": {
      const rebuilt = payload.kind.value;
      if (rebuilt.productSessionId !== "" && rebuilt.productSessionId !== sessionId) {
        throw new ProtoMappingError(
          "invalid_argument",
          "event.payload.context_rebuilt.product_session_id",
          "Context rebuild Session scope does not match the event identity."
        );
      }
      const reason = rebuilt.reason === ProtoContextRebuildReason.CONTEXT_OVERFLOW
        ? "context_overflow" as const
        : rebuilt.reason === ProtoContextRebuildReason.PROMPT_TIMEOUT
          ? "prompt_timeout" as const
          : undefined;
      if (reason === undefined) {
        throw new ProtoMappingError(
          "invalid_argument",
          "event.payload.context_rebuilt.reason",
          "Context rebuild reason is required."
        );
      }
      return {
        type: "context_rebuild",
        reason,
        handoff: requireText(rebuilt.handoff, "event.payload.context_rebuilt.handoff"),
        ...(rebuilt.sourceRunId === "" ? {} : { sourceRunId: rebuilt.sourceRunId }),
        replayScheduled: rebuilt.replayScheduled
      };
    }
    case "messageDeleted": {
      if (payload.kind.value.productSessionId !== "" && payload.kind.value.productSessionId !== sessionId) {
        throw new ProtoMappingError(
          "invalid_argument",
          "event.payload.message_deleted.product_session_id",
          "Message deletion Session scope does not match the event identity."
        );
      }
      return {
        type: "message_deleted",
        requestedEventId: requireText(
          payload.kind.value.requestedEventId,
          "event.payload.message_deleted.requested_event_id"
        ),
        deletedEventIds: payload.kind.value.deletedEventIds.map((eventId, index) =>
          requireText(eventId, `event.payload.message_deleted.deleted_event_ids[${index}]`))
      };
    }
    case "sessionReset":
      if (payload.kind.value.productSessionId !== "" && payload.kind.value.productSessionId !== sessionId) {
        throw new ProtoMappingError(
          "invalid_argument",
          "event.payload.session_reset.product_session_id",
          "Session reset scope does not match the event identity."
        );
      }
      return { type: "session_reset" };
    case "historyPruned":
      if (payload.kind.value.productSessionId !== "" && payload.kind.value.productSessionId !== sessionId) {
        throw new ProtoMappingError(
          "invalid_argument",
          "event.payload.history_pruned.product_session_id",
          "History maintenance scope does not match the event identity."
        );
      }
      return { type: "history_pruned", activeContextReset: payload.kind.value.activeContextReset };
    case "nativeSessionChanged":
      return {
        type: "native_session_changed",
        opaqueRef: payload.kind.value.opaqueNativeReference
      };
    case "runtimeCommandsChanged":
      return {
        type: "runtime_commands_changed",
        commands: payload.kind.value.commands.map((command) => {
          if (command.sessionId !== "" && command.sessionId !== sessionId) {
            throw new ProtoMappingError(
              "invalid_argument",
              "event.payload.runtime_commands_changed.commands.session_id",
              "Runtime command Session scope does not match the event identity."
            );
          }
          return fromProtoRuntimeCommand(command);
        })
      };
    case "reviewRunChanged": {
      const review = payload.kind.value.reviewRun;
      if (review === undefined) throw missingPayload("review_run_changed.review_run");
      const targetKind = review.targetKind === ReviewTargetKind.CHANGES ? "changes"
        : review.targetKind === ReviewTargetKind.ARTIFACTS ? "artifacts"
          : review.targetKind === ReviewTargetKind.MIXED ? "mixed"
            : review.targetKind === ReviewTargetKind.TASK ? "task"
              : (() => { throw new ProtoMappingError("invalid_argument", "review_run.target_kind", "Review target kind is required."); })();
      const freshness = fromProtoReviewFreshness(review.freshness);
      if (review.evidence === undefined) {
        throw new ProtoMappingError("invalid_argument", "review_run.evidence", "Review evidence is required.");
      }
      const result = review.resultMarkdown === "" ? undefined : review.resultMarkdown;
      return {
        type: "review_run_changed",
        reviewRun: {
          id: requireText(review.reviewRunId, "review_run.review_run_id"),
          sourceSessionId: requireText(review.sourceSessionId, "review_run.source_session_id"),
          ...(review.reviewerSessionId === "" ? {} : { reviewerSessionId: review.reviewerSessionId }),
          state: review.state === ReviewRunState.RUNNING ? "running"
            : review.state === ReviewRunState.COMPLETED ? "completed"
              : review.state === ReviewRunState.FAILED ? "failed"
                : (() => { throw new ProtoMappingError("invalid_argument", "review_run.state", "Review run state is required."); })(),
          targetKind,
          ...freshness,
          evidence: fromProtoReviewEvidence(review.evidence, targetKind),
          ...(result === undefined
            ? {}
            : { result }),
          ...fromProtoReviewFailureCode(review.failureCode),
          createdAt: fromProtoTimestamp(review.createdAt, "review_run.created_at") ?? 0,
          updatedAt: fromProtoTimestamp(review.updatedAt, "review_run.updated_at") ?? 0,
          ...(fromProtoTimestamp(review.endedAt, "review_run.ended_at") === undefined
            ? {}
            : { endedAt: fromProtoTimestamp(review.endedAt, "review_run.ended_at") as number }),
          revision: (review.revision?.value ?? 0n).toString()
        }
      };
    }
    case "sessionAttentionChanged": {
      const attention = payload.kind.value.attention;
      if (attention === undefined) throw missingPayload("session_attention_changed.attention");
      const mapped = fromProtoSessionAttention(attention);
      return {
        type: "session_attention",
        kind: mapped.kind,
        unread: mapped.unread,
        subjectCursor: mapped.subjectCursor.toString(),
        subjectGeneration: mapped.subjectGeneration,
        attentionCursor: mapped.attentionCursor.toString(),
        attentionGeneration: mapped.attentionGeneration,
        readThroughCursor: mapped.readThroughCursor.toString(),
        readThroughGeneration: mapped.readThroughGeneration
      };
    }
    case "backgroundTaskChanged": {
      const task = payload.kind.value.backgroundTask;
      if (task === undefined) throw missingPayload("background_task_changed.background_task");
      const progressRatio = optionalProgressRatio(task.progressRatio, "background_task.progress_ratio");
      const startedAt = fromProtoTimestamp(task.startedAt, "background_task.started_at");
      const endedAt = fromProtoTimestamp(task.endedAt, "background_task.ended_at");
      return {
        type: "background_task",
        taskId: task.backgroundTaskId,
        ...(task.parentTaskId === "" ? {} : { parentTaskId: task.parentTaskId }),
        title: task.displayName,
        state: backgroundTaskStateName(task.state),
        ...(task.statusText === "" ? {} : { detail: task.statusText }),
        ...(progressRatio === undefined ? {} : { progressRatio }),
        ...(startedAt === undefined ? {} : { startedAt }),
        ...(endedAt === undefined ? {} : { endedAt }),
        ...(task.error === undefined ? {} : { error: fromProtoErrorInfo(task.error) })
      };
    }
    case "subagentRunChanged": {
      const run = payload.kind.value.run;
      if (run === undefined) throw missingPayload("subagent_run_changed.run");
      const mapped = fromProtoSubagentRunDetail(run);
      if (mapped.sessionId !== sessionId) {
        throw new ProtoMappingError(
          "invalid_argument",
          "event.payload.subagent_run_changed.run.session_id",
          "Subagent run Session scope does not match the Event identity."
        );
      }
      return { type: "subagent_run", run: mapped };
    }
    case "subagentTranscriptAppended": {
      const entry = payload.kind.value.entry;
      if (entry === undefined) throw missingPayload("subagent_transcript_appended.entry");
      return {
        type: "subagent_transcript",
        subagentRunId: requireText(
          payload.kind.value.subagentRunId,
          "subagent_transcript_appended.subagent_run_id"
        ),
        entry: fromProtoSubagentTranscriptEntry(entry)
      };
    }
    case "extensionWidgetChanged": {
      const widget = payload.kind.value.widget;
      if (widget === undefined) throw missingPayload("extension_widget_changed.widget");
      return {
        type: "extension_widget",
        key: widget.widgetKey,
        lines: widget.lines,
        placement: widget.placement === ExtensionWidgetPlacement.BELOW_EDITOR ? "below_editor" : "above_editor",
        removed: widget.removed
      };
    }
    case "extensionStatusChanged": {
      const status = payload.kind.value.status;
      if (status === undefined) throw missingPayload("extension_status_changed.status");
      return {
        type: "extension_status",
        key: status.statusKey,
        ...(status.statusText === undefined ? {} : { text: status.statusText })
      };
    }
    case "recoverableError":
      if (payload.kind.value.error === undefined) throw missingPayload("recoverable_error.error");
      return { type: "error", error: fromProtoErrorInfo(payload.kind.value.error), terminal: false };
    case "terminalError":
      if (payload.kind.value.error === undefined) throw missingPayload("terminal_error.error");
      return { type: "error", error: fromProtoErrorInfo(payload.kind.value.error), terminal: true };
    case "runDone":
      return { type: "done", outcome: "completed" };
    case "runAborted":
      return { type: "done", outcome: "aborted" };
    default:
      throw new ProtoMappingError(
        "unsupported_mapping",
        "event.payload.kind",
        `The protobuf event kind ${payload.kind.case ?? "unspecified"} has no core EventPayload mapping.`
      );
  }
}

function toProtoInteractionRequest(payload: InteractionPayload): ProtoInteraction["request"] {
  switch (payload.kind) {
    case "permission": {
      const subject = message<PermissionSubject>("joko.v1.PermissionSubject", {
        kind: {
          case: "customTool",
          value: message<CustomToolPermissionSubject>("joko.v1.CustomToolPermissionSubject", {
            toolId: payload.toolName,
            displayName: payload.toolName,
            arguments: []
          })
        }
      });
      return {
        case: "permission",
        value: message<PermissionRequest>("joko.v1.PermissionRequest", {
          activeMode: PermissionMode.ASK,
          risk: permissionRisk(payload.risk),
          title: payload.title,
          explanation: payload.summary,
          subject,
          allowedDecisions: payload.choices.map(permissionDecision).filter((value) => value !== PermissionDecisionKind.UNSPECIFIED),
          autoReviewAttempted: false,
          policyRuleId: ""
        })
      };
    }
    case "question": {
      return {
        case: "question",
        value: message<QuestionRequest>("joko.v1.QuestionRequest", {
          title: payload.title,
          prompt: payload.prompt,
          fields: payload.fields.map(toProtoQuestionField)
        })
      };
    }
    case "plan_review":
      return {
        case: "planReview",
        value: message<PlanReviewRequest>("joko.v1.PlanReviewRequest", {
          title: payload.title,
          markdown: payload.markdown,
          steps: [],
          allowedDecisions: payload.choices.map(planDecision).filter((value) => value !== PlanReviewDecisionKind.UNSPECIFIED)
        })
      };
    case "extension_select":
    case "extension_confirm":
    case "extension_input":
    case "extension_editor":
      return {
        case: "extensionUi",
        value: toProtoExtensionInteraction(payload)
      };
  }
}

function fromProtoInteractionRequest(interaction: ProtoInteraction): InteractionPayload {
  switch (interaction.request.case) {
    case "permission": {
      const subject = interaction.request.value.subject;
      const toolName = subject?.kind.case === "customTool"
        ? subject.kind.value.toolId
        : "permission";
      return {
        id: interaction.interactionId,
        kind: "permission",
        title: interaction.request.value.title,
        toolName,
        summary: interaction.request.value.explanation,
        risk: fromPermissionRisk(interaction.request.value.risk),
        choices: interaction.request.value.allowedDecisions.map(permissionDecisionName)
      };
    }
    case "question": {
      return {
        id: interaction.interactionId,
        kind: "question",
        title: interaction.request.value.title,
        prompt: interaction.request.value.prompt,
        fields: interaction.request.value.fields.map(fromProtoQuestionField)
      };
    }
    case "planReview":
      return {
        id: interaction.interactionId,
        kind: "plan_review",
        title: interaction.request.value.title,
        markdown: interaction.request.value.markdown,
        choices: interaction.request.value.allowedDecisions
          .map(planDecisionName)
          .filter((value): value is PlanReviewDecision => value !== "unspecified")
      };
    case "extensionUi":
      return fromProtoExtensionInteraction(interaction.interactionId, interaction.request.value);
    case undefined:
      throw new ProtoMappingError("invalid_argument", "interaction.request", "Interaction request is required.");
  }
}

function toProtoExtensionInteraction(
  payload: Extract<InteractionPayload, { readonly kind: `extension_${string}` }>
): ExtensionUiInteraction {
  let request: ExtensionUiInteraction["request"];
  switch (payload.kind) {
    case "extension_select":
      request = {
        case: "select",
        value: message<ExtensionSelectRequest>("joko.v1.ExtensionSelectRequest", {
          title: payload.title,
          options: [...(payload.options ?? [])]
        })
      };
      break;
    case "extension_confirm":
      request = {
        case: "confirm",
        value: message<ExtensionConfirmRequest>("joko.v1.ExtensionConfirmRequest", {
          title: payload.title,
          message: payload.message ?? ""
        })
      };
      break;
    case "extension_input":
      request = {
        case: "input",
        value: message<ExtensionInputRequest>("joko.v1.ExtensionInputRequest", {
          title: payload.title,
          placeholder: payload.placeholder ?? ""
        })
      };
      break;
    case "extension_editor":
      request = {
        case: "editor",
        value: message<ExtensionEditorRequest>("joko.v1.ExtensionEditorRequest", {
          title: payload.title,
          prefill: payload.prefill ?? ""
        })
      };
      break;
  }
  return message<ExtensionUiInteraction>("joko.v1.ExtensionUiInteraction", {
    requestId: payload.id,
    extensionId: payload.extensionId,
    request
  });
}

function fromProtoExtensionInteraction(id: string, interaction: ExtensionUiInteraction): InteractionPayload {
  switch (interaction.request.case) {
    case "select":
      return {
        id,
        kind: "extension_select",
        extensionId: interaction.extensionId,
        title: interaction.request.value.title,
        options: interaction.request.value.options
      };
    case "confirm":
      return {
        id,
        kind: "extension_confirm",
        extensionId: interaction.extensionId,
        title: interaction.request.value.title,
        message: interaction.request.value.message
      };
    case "input":
      return {
        id,
        kind: "extension_input",
        extensionId: interaction.extensionId,
        title: interaction.request.value.title,
        placeholder: interaction.request.value.placeholder
      };
    case "editor":
      return {
        id,
        kind: "extension_editor",
        extensionId: interaction.extensionId,
        title: interaction.request.value.title,
        prefill: interaction.request.value.prefill
      };
    case undefined:
      throw new ProtoMappingError("invalid_argument", "interaction.extension_ui.request", "Extension UI request is required.");
  }
}

function toProtoInteractionResolution(interaction: InteractionRecord): InteractionResolution {
  const actor = message<ActorRef>("joko.v1.ActorRef", {
    kind: ActorKind.OWNER,
    id: "owner",
    displayName: "Owner"
  });
  if (interaction.status === "dismissed") {
    return message<InteractionResolution>("joko.v1.InteractionResolution", {
      connectionId: "",
      actor,
      resolvedAt: optionalTimestamp(interaction.resolvedAt),
      decision: {
        case: "dismissal",
        value: message<DismissalResolution>("joko.v1.DismissalResolution", {
          reason: interaction.dismissalReason ?? "dismissed"
        })
      }
    });
  }
  const decision = interaction.decision;
  let mapped: InteractionResolution["decision"];
  switch (interaction.payload.kind) {
    case "permission": {
      const record = requireInteractionDecisionRecord(decision, "selected", ["value"]);
      mapped = {
        case: "permission",
        value: message<PermissionResolution>("joko.v1.PermissionResolution", {
          decision: permissionDecision(requireInteractionDecisionString(record, "value"))
        })
      };
      break;
    }
    case "question": {
      const record = requireInteractionDecisionRecord(decision, "question", ["answers"]);
      mapped = {
        case: "question",
        value: message<QuestionResolution>("joko.v1.QuestionResolution", {
          answers: decisionAnswers(record["answers"])
        })
      };
      break;
    }
    case "plan_review": {
      const record = requireInteractionDecisionRecord(decision, "plan_review", ["decision", "feedback"]);
      mapped = {
        case: "planReview",
        value: message<PlanReviewResolution>("joko.v1.PlanReviewResolution", {
          decision: planDecision(requireInteractionDecisionString(record, "decision")),
          feedback: requireInteractionDecisionString(record, "feedback")
        })
      };
      break;
    }
    default: {
      const record = objectValue(decision);
      let result: ExtensionUiResolution["result"];
      if (record["kind"] === "selected") {
        const selected = requireInteractionDecisionRecord(decision, "selected", ["value"]);
        result = { case: "value", value: requireInteractionDecisionString(selected, "value") };
      } else if (record["kind"] === "confirmed") {
        const confirmed = requireInteractionDecisionRecord(decision, "confirmed", ["confirmed"]);
        result = { case: "confirmed", value: requireInteractionDecisionBoolean(confirmed, "confirmed") };
      } else if (record["kind"] === "cancelled") {
        requireInteractionDecisionRecord(decision, "cancelled", []);
        result = { case: "cancelled", value: true };
      } else {
        throw new ProtoMappingError(
          "invalid_argument",
          "interaction.decision",
          "Resolved Extension UI interactions require a selected, confirmed, or cancelled decision."
        );
      }
      mapped = {
        case: "extensionUi",
        value: message<ExtensionUiResolution>("joko.v1.ExtensionUiResolution", {
          result
        })
      };
    }
  }
  return message<InteractionResolution>("joko.v1.InteractionResolution", {
    connectionId: "",
    actor,
    resolvedAt: optionalTimestamp(interaction.resolvedAt),
    decision: mapped
  });
}

function interactionExpiry(interaction: InteractionRecord): number | undefined {
  const payload = interaction.payload;
  if (
    payload.kind !== "extension_select" &&
    payload.kind !== "extension_confirm" &&
    payload.kind !== "extension_input"
  ) return undefined;
  const timeoutMs = payload.timeoutMs;
  if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 0) return undefined;
  const expiresAt = interaction.createdAt + timeoutMs;
  return Number.isSafeInteger(expiresAt) ? expiresAt : undefined;
}

function interactionPayloadWithTimeout(
  payload: InteractionPayload,
  createdAt: number | undefined,
  expiresAt: number | undefined
): InteractionPayload {
  if (
    createdAt === undefined ||
    expiresAt === undefined ||
    (payload.kind !== "extension_select" && payload.kind !== "extension_confirm" && payload.kind !== "extension_input")
  ) return payload;
  const timeoutMs = Math.max(0, expiresAt - createdAt);
  return Number.isSafeInteger(timeoutMs) ? { ...payload, timeoutMs } : payload;
}

function interactionFromPayload(
  payload: InteractionPayload,
  event: PersistedEvent,
  status: InteractionRecord["status"]
): ProtoInteraction {
  return toProtoInteraction({
    id: payload.id,
    sessionId: event.sessionId,
    ...(event.runId === undefined ? {} : { runId: event.runId }),
    ...(event.attemptId === undefined ? {} : { attemptId: event.attemptId }),
    ...(event.operationId === undefined ? {} : { operationId: event.operationId }),
    generation: event.generation,
    kind: payload.kind,
    status,
    payload,
    createdAt: event.emittedAt,
    revision: event.revision
  }, { backendId: event.backendId, targetId: event.targetId });
}

function resolvedInteractionFromEvent(
  interactionId: string,
  value: string,
  event: PersistedEvent,
  dismissed: boolean
): ProtoInteraction {
  const request: ProtoInteraction["request"] = { case: undefined };
  const resolution = message<InteractionResolution>("joko.v1.InteractionResolution", {
    connectionId: "",
    actor: message<ActorRef>("joko.v1.ActorRef", { kind: ActorKind.OWNER, id: "owner", displayName: "Owner" }),
    resolvedAt: toProtoTimestamp(event.emittedAt),
    decision: dismissed
      ? {
        case: "dismissal",
        value: message<DismissalResolution>("joko.v1.DismissalResolution", { reason: value })
      }
      : {
        case: "extensionUi",
        value: message<ExtensionUiResolution>("joko.v1.ExtensionUiResolution", {
          result: { case: "value", value }
        })
      }
  });
  return message<ProtoInteraction>("joko.v1.Interaction", {
    interactionId,
    kind: InteractionKind.UNSPECIFIED,
    state: dismissed
      ? value === TIMED_EXTENSION_INTERACTION_EXPIRED_REASON ? InteractionState.EXPIRED : InteractionState.DISMISSED
      : InteractionState.RESOLVED,
    backendId: event.backendId,
    targetId: event.targetId,
    sessionId: event.sessionId,
    runId: event.runId ?? "",
    attemptId: event.attemptId ?? "",
    generation: BigInt(event.generation),
    createdAt: toProtoTimestamp(event.emittedAt),
    expiresAt: undefined,
    request,
    resolution,
    version: toProtoEntityVersion(event.revision, event.generation, event.emittedAt)
  });
}

export interface ServerIdentity {
  readonly serverId: string;
  readonly displayName: string;
  readonly version: string;
  readonly apiVersion: string;
  readonly health?: ServerHealth;
  readonly pairingEnabled: boolean;
}

export function toProtoServerInfo(identity: ServerIdentity, now = Date.now()): ServerInfo {
  return message<ServerInfo>("joko.v1.ServerInfo", {
    serverId: requireText(identity.serverId, "server.server_id"),
    displayName: requireText(identity.displayName, "server.display_name"),
    version: requireText(identity.version, "server.version"),
    apiVersion: requireText(identity.apiVersion, "server.api_version"),
    serverTime: toProtoTimestamp(now),
    health: identity.health ?? ServerHealth.HEALTHY,
    pairingEnabled: identity.pairingEnabled
  });
}

function message<T extends MessageShape>(
  typeName: T["$typeName"],
  fields: Omit<T, "$typeName" | "$unknown">
): T {
  return { $typeName: typeName, ...fields } as T;
}

function optionalTimestamp(value: number | undefined): ProtoTimestamp | undefined {
  return value === undefined ? undefined : toProtoTimestamp(value);
}

function optionalProgressRatio(value: number | undefined, fieldPath: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new ProtoMappingError("out_of_range", fieldPath, `${fieldPath} must be between 0 and 1.`);
  }
  return value;
}

function assertUnsigned(value: bigint, fieldPath: string): void {
  if (value < 0n) {
    throw new ProtoMappingError("out_of_range", fieldPath, `${fieldPath} must be unsigned.`);
  }
}

function validateNanoseconds(value: number, fieldPath: string): void {
  if (!Number.isInteger(value) || value < 0 || value >= 1_000_000_000 || value % 1_000_000 !== 0) {
    throw new ProtoMappingError(
      "out_of_range",
      fieldPath,
      `${fieldPath} nanoseconds must be millisecond-aligned and between 0 and 999999999.`
    );
  }
}

function unsignedBigInt(value: number, fieldPath: string): bigint {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ProtoMappingError("out_of_range", fieldPath, `${fieldPath} must be a non-negative safe integer.`);
  }
  return BigInt(value);
}

function safeNumber(value: bigint, fieldPath: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ProtoMappingError("out_of_range", fieldPath, `${fieldPath} is outside the supported integer range.`);
  }
  return Number(value);
}

function requireText(value: string, fieldPath: string): string {
  if (value.trim() === "") {
    throw new ProtoMappingError("invalid_argument", fieldPath, `${fieldPath} must not be empty.`);
  }
  return value;
}

function requireSha256(value: string, fieldPath: string): string {
  const normalized = value.replace(/^sha256:/u, "").toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    throw new ProtoMappingError("invalid_argument", fieldPath, `${fieldPath} must be a 64-character SHA-256 digest.`);
  }
  return `sha256:${normalized}`;
}

function objectValue(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};
}

function stringField(value: Readonly<Record<string, unknown>>, key: string): string | undefined {
  return typeof value[key] === "string" ? value[key] : undefined;
}

function booleanField(value: Readonly<Record<string, unknown>>, key: string): boolean | undefined {
  return typeof value[key] === "boolean" ? value[key] : undefined;
}

function requireInteractionDecisionRecord(
  value: unknown,
  kind: "selected" | "confirmed" | "question" | "plan_review" | "cancelled",
  fields: readonly string[]
): Readonly<Record<string, unknown>> {
  const record = objectValue(value);
  const allowed = new Set(["kind", ...fields]);
  if (
    !Object.hasOwn(record, "kind")
    || record["kind"] !== kind
    || fields.some((field) => !Object.hasOwn(record, field))
    || Object.keys(record).some((field) => !allowed.has(field))
  ) {
    throw new ProtoMappingError(
      "invalid_argument",
      "interaction.decision",
      `Resolved interaction decision must use the current ${kind} shape.`
    );
  }
  return record;
}

function requireInteractionDecisionString(
  value: Readonly<Record<string, unknown>>,
  key: string
): string {
  const field = stringField(value, key);
  if (field === undefined) {
    throw new ProtoMappingError("invalid_argument", `interaction.decision.${key}`, `Interaction decision ${key} must be a string.`);
  }
  return field;
}

function requireInteractionDecisionBoolean(
  value: Readonly<Record<string, unknown>>,
  key: string
): boolean {
  const field = booleanField(value, key);
  if (field === undefined) {
    throw new ProtoMappingError("invalid_argument", `interaction.decision.${key}`, `Interaction decision ${key} must be a boolean.`);
  }
  return field;
}

function costMicros(value: number): bigint {
  if (!Number.isFinite(value) || value < 0) {
    throw new ProtoMappingError("out_of_range", "model.cost", "Model cost must be a finite non-negative number.");
  }
  return BigInt(Math.round(value * 1_000_000));
}

function providerApi(api: ProviderModel["api"]): ProviderApiCompatibility {
  switch (api) {
    case "anthropic-messages": return ProviderApiCompatibility.ANTHROPIC_MESSAGES;
    case "openai-responses": return ProviderApiCompatibility.OPENAI_RESPONSES;
    case "openai-completions": return ProviderApiCompatibility.OPENAI_COMPLETIONS;
    default: return ProviderApiCompatibility.NATIVE;
  }
}

function toProtoCapability(capability: Capability): ProtoCapability {
  return message<ProtoCapability>("joko.v1.Capability", {
    name: capability.key,
    support: capability.supported ? CapabilitySupport.SUPPORTED : capabilitySupport(capability.reason),
    reason: capability.detail ?? capability.reason ?? "",
    options: toProtoCapabilityOptions(capability)
  });
}

function fromProtoCapability(capability: ProtoCapability): Capability {
  const reason = capabilityReason(capability.support);
  const options = fromProtoCapabilityOptions(capability.options);
  return {
    key: requireText(capability.name, "capability.name"),
    supported: capability.support === CapabilitySupport.SUPPORTED,
    ...(reason === undefined ? {} : { reason }),
    ...(capability.reason === "" ? {} : { detail: capability.reason }),
    ...(options.length === 0 ? {} : { options })
  };
}

function capabilitySupport(reason: Capability["reason"]): CapabilitySupport {
  switch (reason) {
    case "upstream_missing": return CapabilitySupport.UPSTREAM_MISSING;
    case "not_implemented": return CapabilitySupport.NOT_IMPLEMENTED;
    case "platform_limited": return CapabilitySupport.PLATFORM_LIMITED;
    case "policy_denied": return CapabilitySupport.DISABLED_BY_POLICY;
    default: return CapabilitySupport.TEMPORARILY_UNAVAILABLE;
  }
}

function capabilityReason(support: CapabilitySupport): Capability["reason"] | undefined {
  switch (support) {
    case CapabilitySupport.UPSTREAM_MISSING: return "upstream_missing";
    case CapabilitySupport.NOT_IMPLEMENTED: return "not_implemented";
    case CapabilitySupport.PLATFORM_LIMITED: return "platform_limited";
    case CapabilitySupport.DISABLED_BY_POLICY: return "policy_denied";
    default: return undefined;
  }
}

function toProtoCapabilityOptions(capability: Capability): CapabilityOptions | undefined {
  if (capability.options === undefined || capability.options.length === 0) return undefined;
  let kind: CapabilityOptions["kind"];
  if (capability.key.startsWith("model.")) {
    kind = {
      case: "model",
      value: {
        $typeName: "joko.v1.ModelCapabilityOptions",
        providerAware: true,
        switchDuringSession: true,
        supportsEffort: capability.key === "model.effort",
        supportsFastMode: capability.key === "model.fast_mode",
        effortIds: [...capability.options]
      }
    };
  } else if (capability.key.startsWith("input.")) {
    kind = {
      case: "input",
      value: {
        $typeName: "joko.v1.InputCapabilityOptions",
        mediaTypes: [...capability.options],
        maximumBytes: 0n,
        maximumItems: 0
      }
    };
  } else if (capability.key.startsWith("permission.")) {
    kind = {
      case: "permission",
      value: {
        $typeName: "joko.v1.PermissionCapabilityOptions",
        modes: capability.options.flatMap((value) =>
          value === "ask" || value === "auto" || value === "bypassPermissions"
            ? [toProtoPermissionMode(value)]
            : []
        ),
        mutableDuringSession: true,
        supportsPerTurnPolicy: false,
        supportsPlanMode: capability.options.includes("plan_mode")
      }
    };
  } else {
    return undefined;
  }
  return message<CapabilityOptions>("joko.v1.CapabilityOptions", { kind });
}

function fromProtoCapabilityOptions(options: CapabilityOptions | undefined): readonly string[] {
  if (options === undefined) return [];
  switch (options.kind.case) {
    case "model": return options.kind.value.effortIds;
    case "input": return options.kind.value.mediaTypes;
    case "permission": return options.kind.value.modes.map(fromProtoPermissionMode);
    default: return [];
  }
}

function toProtoBackendHealth(value: BackendDescriptor["health"]): BackendHealth {
  switch (value) {
    case "healthy": return BackendHealth.HEALTHY;
    case "degraded": return BackendHealth.DEGRADED;
    case "unavailable": return BackendHealth.UNAVAILABLE;
  }
}

function toProtoBackendInstallationState(
  value: NonNullable<BackendDescriptor["installationState"]>
): InstallationState {
  switch (value) {
    case "not_installed": return InstallationState.NOT_INSTALLED;
    case "installing": return InstallationState.INSTALLING;
    case "installed": return InstallationState.INSTALLED;
    case "update_available": return InstallationState.UPDATE_AVAILABLE;
    case "error": return InstallationState.ERROR;
  }
}

function toProtoBackendAuthenticationState(
  value: NonNullable<BackendDescriptor["authenticationState"]>
): AuthenticationState {
  switch (value) {
    case "not_required": return AuthenticationState.NOT_REQUIRED;
    case "signed_out": return AuthenticationState.SIGNED_OUT;
    case "pending": return AuthenticationState.PENDING;
    case "authenticated": return AuthenticationState.AUTHENTICATED;
    case "expired": return AuthenticationState.EXPIRED;
    case "refreshing": return AuthenticationState.REFRESHING;
    case "error": return AuthenticationState.ERROR;
  }
}

function toProtoPermissionMode(value: CorePermissionMode): PermissionMode {
  switch (value) {
    case "ask": return PermissionMode.ASK;
    case "auto": return PermissionMode.AUTO;
    case "bypassPermissions": return PermissionMode.BYPASS_PERMISSIONS;
  }
}

function fromProtoPermissionMode(value: PermissionMode): CorePermissionMode {
  switch (value) {
    case PermissionMode.AUTO: return "auto";
    case PermissionMode.BYPASS_PERMISSIONS: return "bypassPermissions";
    default: return "ask";
  }
}

function toProtoDeliveryMode(value: InputDisposition): QueueDeliveryMode {
  switch (value) {
    case "prompt": return QueueDeliveryMode.PROMPT;
    case "steer": return QueueDeliveryMode.STEER;
    case "follow_up": return QueueDeliveryMode.FOLLOW_UP;
  }
}

function fromProtoDeliveryMode(value: QueueDeliveryMode): InputDisposition {
  switch (value) {
    case QueueDeliveryMode.STEER: return "steer";
    case QueueDeliveryMode.FOLLOW_UP: return "follow_up";
    default: return "prompt";
  }
}

function toProtoRunState(value: CoreRunState): RunState {
  switch (value) {
    case "queued": return RunState.QUEUED;
    case "running": return RunState.RUNNING;
    case "waiting": return RunState.WAITING;
    case "retrying": return RunState.RETRYING;
    case "completed": return RunState.SUCCEEDED;
    case "aborted": return RunState.ABORTED;
    case "failed": return RunState.FAILED;
    case "dispatch_unknown": return RunState.DISPATCH_UNKNOWN;
  }
}

function fromProtoRunState(value: RunState): CoreRunState {
  switch (value) {
    case RunState.RUNNING: return "running";
    case RunState.WAITING: return "waiting";
    case RunState.RETRYING: return "retrying";
    case RunState.SUCCEEDED: return "completed";
    case RunState.ABORTED:
    case RunState.CANCELLED: return "aborted";
    case RunState.FAILED: return "failed";
    case RunState.DISPATCH_UNKNOWN: return "dispatch_unknown";
    default: return "queued";
  }
}

function coreRunStateName(value: CoreRunState): CoreRunState {
  return value;
}

function toProtoQueueState(value: QueueState): QueueItemState {
  switch (value) {
    case "accepted": return QueueItemState.ACCEPTED;
    case "dispatching": return QueueItemState.DISPATCHING;
    case "backend_accepted": return QueueItemState.BACKEND_ACCEPTED;
    case "dispatch_unknown": return QueueItemState.DISPATCH_UNKNOWN;
    case "completed": return QueueItemState.COMPLETED;
    case "cancelled": return QueueItemState.CANCELLED;
    case "failed": return QueueItemState.FAILED;
  }
}

function sessionState(session: SessionDescriptor, activeRun: StoredRun | undefined): SessionState {
  if (session.deletedAt !== undefined) return SessionState.CLOSED;
  if (session.archived) return SessionState.ARCHIVED;
  switch (activeRun?.descriptor.state) {
    case "running":
    case "retrying": return SessionState.RUNNING;
    case "waiting": return SessionState.WAITING;
    case "dispatch_unknown": return SessionState.RECOVERING;
    case "failed": return SessionState.ERROR;
    default: return SessionState.IDLE;
  }
}

function attemptState(attempt: AttemptDescriptor, run: RunDescriptor): AttemptState {
  if (attempt.error !== undefined || run.state === "failed") return AttemptState.FAILED;
  if (run.state === "aborted") return AttemptState.ABORTED;
  if (attempt.endedAt !== undefined || run.state === "completed") return AttemptState.SUCCEEDED;
  if (run.state === "waiting") return AttemptState.WAITING;
  if (run.state === "running" || run.state === "retrying") return AttemptState.RUNNING;
  if (run.state === "dispatch_unknown") return AttemptState.DISPATCHING;
  return AttemptState.CREATED;
}

function activeAttemptGeneration(run: RunDescriptor, attempts: readonly StoredAttempt[]): number {
  return attempts.find((attempt) => attempt.descriptor.id === run.activeAttemptId)?.descriptor.generation ??
    attempts.at(-1)?.descriptor.generation ?? 0;
}

function optionalError(error: PublicError | undefined): ErrorInfo | undefined {
  return error === undefined ? undefined : toProtoErrorInfo(error);
}

function requiredProtoText(value: string, fieldPath: string, maximum: number): string {
  if (value.trim() === "" || value.length > maximum || value.includes("\0")) {
    throw new ProtoMappingError(
      "invalid_argument",
      fieldPath,
      `${fieldPath} must be non-empty and at most ${maximum} characters.`
    );
  }
  return value;
}

function toProtoReviewFailureCode(value: ReviewRunRecord["failureCode"] | undefined): ReviewFailureCode {
  if (value === undefined) return ReviewFailureCode.UNSPECIFIED;
  const values: Record<NonNullable<ReviewRunRecord["failureCode"]>, ReviewFailureCode> = {
    "no-visible-result": ReviewFailureCode.NO_VISIBLE_RESULT,
    "reviewer-closed": ReviewFailureCode.REVIEWER_CLOSED,
    "cancelled-before-start": ReviewFailureCode.CANCELLED_BEFORE_START,
    interrupted: ReviewFailureCode.INTERRUPTED,
    "source-workspace-changed": ReviewFailureCode.SOURCE_WORKSPACE_CHANGED,
    "source-conversation-changed": ReviewFailureCode.SOURCE_CONVERSATION_CHANGED,
    "source-files-changed": ReviewFailureCode.SOURCE_FILES_CHANGED,
    "artifact-changed": ReviewFailureCode.ARTIFACT_CHANGED,
    "artifact-unavailable": ReviewFailureCode.ARTIFACT_UNAVAILABLE,
    "provider-failed": ReviewFailureCode.PROVIDER_FAILED
  };
  return values[value];
}

function fromProtoReviewFailureCode(value: ReviewFailureCode): { readonly failureCode?: NonNullable<ReviewRunRecord["failureCode"]> } {
  const values: Partial<Record<ReviewFailureCode, NonNullable<ReviewRunRecord["failureCode"]>>> = {
    [ReviewFailureCode.NO_VISIBLE_RESULT]: "no-visible-result",
    [ReviewFailureCode.REVIEWER_CLOSED]: "reviewer-closed",
    [ReviewFailureCode.CANCELLED_BEFORE_START]: "cancelled-before-start",
    [ReviewFailureCode.INTERRUPTED]: "interrupted",
    [ReviewFailureCode.SOURCE_WORKSPACE_CHANGED]: "source-workspace-changed",
    [ReviewFailureCode.SOURCE_CONVERSATION_CHANGED]: "source-conversation-changed",
    [ReviewFailureCode.SOURCE_FILES_CHANGED]: "source-files-changed",
    [ReviewFailureCode.ARTIFACT_CHANGED]: "artifact-changed",
    [ReviewFailureCode.ARTIFACT_UNAVAILABLE]: "artifact-unavailable",
    [ReviewFailureCode.PROVIDER_FAILED]: "provider-failed"
  };
  const failureCode = values[value];
  return failureCode === undefined ? {} : { failureCode };
}

function toProtoMessageInputDelivery(value: CoreMessageInputDelivery | undefined): ProtoMessageInputDelivery {
  switch (value) {
    case "prompt": return ProtoMessageInputDelivery.PROMPT;
    case "steer": return ProtoMessageInputDelivery.STEER;
    case "follow_up": return ProtoMessageInputDelivery.FOLLOW_UP;
    case "scheduler": return ProtoMessageInputDelivery.SCHEDULER;
    case undefined: return ProtoMessageInputDelivery.UNSPECIFIED;
  }
}

function fromProtoMessageInputDelivery(value: ProtoMessageInputDelivery): CoreMessageInputDelivery | undefined {
  switch (value) {
    case ProtoMessageInputDelivery.PROMPT: return "prompt";
    case ProtoMessageInputDelivery.STEER: return "steer";
    case ProtoMessageInputDelivery.FOLLOW_UP: return "follow_up";
    case ProtoMessageInputDelivery.SCHEDULER: return "scheduler";
    case ProtoMessageInputDelivery.UNSPECIFIED:
    default: return undefined;
  }
}

function toProtoNativeMessageIdentity(
  value: CoreNativeMessageIdentity | undefined
): ProtoNativeMessageIdentity | undefined {
  if (value === undefined) return undefined;
  return message<ProtoNativeMessageIdentity>("joko.v1.NativeMessageIdentity", {
    entryId: requireText(value.entryId, "event.payload.native_identity.entry_id"),
    parentEntryId: value.parentEntryId ?? ""
  });
}

function fromProtoNativeMessageIdentity(
  value: ProtoNativeMessageIdentity | undefined
): CoreNativeMessageIdentity | undefined {
  if (value === undefined) return undefined;
  return {
    entryId: requireText(value.entryId, "event.payload.native_identity.entry_id"),
    ...(value.parentEntryId === "" ? {} : { parentEntryId: value.parentEntryId })
  };
}

function toProtoExtensionNotificationKind(
  value: Extract<EventPayload, { readonly type: "extension_ui_effect" }>["notificationKind"]
): contract.ExtensionNotificationKind {
  if (value === "info") return contract.ExtensionNotificationKind.INFO;
  if (value === "warning") return contract.ExtensionNotificationKind.WARNING;
  if (value === "error") return contract.ExtensionNotificationKind.ERROR;
  return contract.ExtensionNotificationKind.UNSPECIFIED;
}

function fromProtoExtensionNotificationKind(
  value: contract.ExtensionNotificationKind
): NonNullable<Extract<EventPayload, { readonly type: "extension_ui_effect" }>["notificationKind"]> {
  if (value === contract.ExtensionNotificationKind.INFO) return "info";
  if (value === contract.ExtensionNotificationKind.WARNING) return "warning";
  if (value === contract.ExtensionNotificationKind.ERROR) return "error";
  return "unknown";
}

function toProtoCompactionState(
  state: "started" | "completed" | "no_op" | "aborted" | "failed"
): CompactionState {
  switch (state) {
    case "started": return CompactionState.STARTED;
    case "completed": return CompactionState.COMPLETED;
    case "no_op": return CompactionState.NO_OP;
    case "aborted": return CompactionState.ABORTED;
    case "failed": return CompactionState.FAILED;
  }
}

function toProtoRetryState(state: RetryEventState): RetryState {
  switch (state) {
    case "unknown": return RetryState.UNSPECIFIED;
    case "waiting": return RetryState.WAITING;
    case "started": return RetryState.STARTED;
    case "succeeded": return RetryState.SUCCEEDED;
    case "aborted": return RetryState.ABORTED;
    case "exhausted": return RetryState.EXHAUSTED;
  }
}

function fromProtoRetryState(state: RetryState): RetryEventState {
  switch (state) {
    case RetryState.WAITING: return "waiting";
    case RetryState.STARTED: return "started";
    case RetryState.SUCCEEDED: return "succeeded";
    case RetryState.ABORTED: return "aborted";
    case RetryState.EXHAUSTED: return "exhausted";
    default: return "unknown";
  }
}

function fromProtoCompactionState(
  state: CompactionState
): "started" | "completed" | "no_op" | "aborted" | "failed" {
  switch (state) {
    case CompactionState.STARTED: return "started";
    case CompactionState.COMPLETED: return "completed";
    case CompactionState.NO_OP: return "no_op";
    case CompactionState.ABORTED: return "aborted";
    case CompactionState.FAILED: return "failed";
    default:
      throw new ProtoMappingError(
        "invalid_argument",
        "event.payload.compaction_changed.state",
        "Compaction state is required."
      );
  }
}

function automaticCompactionReason(reason: string): boolean {
  return reason === "threshold" || reason === "overflow" || reason === "automatic";
}

function toProtoScheduleRecurrence(schedule: ScheduleRecord): ScheduleRecurrence {
  let kind: ScheduleRecurrence["kind"];
  switch (schedule.kind) {
    case "one_shot":
      kind = {
        case: "oneShot",
        value: message<OneShotRecurrence>("joko.v1.OneShotRecurrence", {
          triggerAt: optionalTimestamp(schedule.nextRunAt)
        })
      };
      break;
    case "cron":
      kind = {
        case: "cron",
        value: message<CronRecurrence>("joko.v1.CronRecurrence", {
          expression: requireText(schedule.expression ?? "", "schedule.expression")
        })
      };
      break;
    case "interval": {
      const interval = Number(schedule.expression);
      if (!Number.isSafeInteger(interval) || interval <= 0) {
        throw new ProtoMappingError("invalid_argument", "schedule.expression", "Interval expression must be positive integer milliseconds.");
      }
      if (schedule.anchorAt === undefined) {
        throw new ProtoMappingError("invalid_argument", "schedule.anchor_at", "Interval anchor is required.");
      }
      kind = {
        case: "interval",
        value: message<IntervalRecurrence>("joko.v1.IntervalRecurrence", {
          interval: toProtoDuration(interval),
          anchorAt: toProtoTimestamp(schedule.anchorAt)
        })
      };
      break;
    }
    case "manual":
      kind = { case: "manual", value: message<ManualRecurrence>("joko.v1.ManualRecurrence", {}) };
      break;
  }
  return message<ScheduleRecurrence>("joko.v1.ScheduleRecurrence", { kind });
}

function fromProtoScheduleRecurrence(recurrence: ScheduleRecurrence | undefined): {
  readonly kind: ScheduleRecord["kind"];
  readonly expression?: string;
  readonly anchorAt?: number;
} {
  switch (recurrence?.kind.case) {
    case "oneShot": return { kind: "one_shot" };
    case "cron": return { kind: "cron", expression: requireText(recurrence.kind.value.expression, "schedule.recurrence.cron.expression") };
    case "interval": {
      const interval = fromProtoDuration(recurrence.kind.value.interval, "schedule.recurrence.interval");
      if (interval === undefined || interval <= 0) {
        throw new ProtoMappingError("invalid_argument", "schedule.recurrence.interval", "Interval duration is required.");
      }
      const anchorAt = fromProtoTimestamp(
        recurrence.kind.value.anchorAt,
        "schedule.recurrence.interval.anchor_at"
      );
      if (anchorAt === undefined) {
        throw new ProtoMappingError("invalid_argument", "schedule.recurrence.interval.anchor_at", "Interval anchor is required.");
      }
      return { kind: "interval", expression: interval.toString(10), anchorAt };
    }
    case "manual": return { kind: "manual" };
    default: throw new ProtoMappingError("invalid_argument", "schedule.recurrence", "Schedule recurrence is required.");
  }
}

function toProtoScheduleExecution(value: unknown): ScheduleExecutionSnapshot {
  const record = objectValue(value);
  const extension = scheduleExtensionSnapshot(value);
  const providerId = stringField(record, "providerId");
  const modelId = stringField(record, "modelId");
  const permission = stringField(record, "permissionMode");
  const extraDirectoryIds = Array.isArray(record.extraDirectoryIds)
    ? record.extraDirectoryIds.filter((entry): entry is string => typeof entry === "string")
    : [];
  return message<ScheduleExecutionSnapshot>("joko.v1.ScheduleExecutionSnapshot", {
    model: providerId === undefined || modelId === undefined
      ? undefined
      : toProtoModelSelection(providerId, modelId, stringField(record, "effort"), booleanField(record, "fastMode") ?? false),
    permissionMode: toProtoPermissionMode(
      permission === "auto" || permission === "bypassPermissions" ? permission : "ask"
    ),
    planMode: booleanField(record, "planMode") ?? false,
    useWorktree: booleanField(record, "useWorktree") ?? false,
    worktreeSourceRef: stringField(record, "worktreeSourceRef"),
    refreshWorktreeRemote: booleanField(record, "refreshWorktreeRemote") ?? false,
    extraDirectoryIds,
    executionMode: extension.executionMode === "script"
      ? contract.ScheduleExecutionMode.SCRIPT
      : contract.ScheduleExecutionMode.AGENT,
    script: extension.scriptConfig === undefined ? undefined : message<contract.ScheduleScriptExecution>(
      "joko.v1.ScheduleScriptExecution",
      {
      command: extension.scriptConfig.command,
      timeout: extension.scriptConfig.timeoutMs === undefined
        ? undefined
        : toProtoDuration(extension.scriptConfig.timeoutMs),
      capabilities: extension.scriptConfig.capabilities.map(() =>
        contract.ScheduleScriptCapability.SESSIONS_DISPATCH)
      }
    ),
    silentWhenIdle: extension.silentWhenIdle,
    notify: message<contract.ScheduleNotification>("joko.v1.ScheduleNotification", {
      desktop: extension.notify.desktop
    }),
    expireAt: optionalTimestamp(extension.expireAt),
    preRunHook: extension.preRunHook === undefined ? undefined : message<contract.SchedulePreRunHook>(
      "joko.v1.SchedulePreRunHook",
      {
        command: extension.preRunHook.command,
        filePath: extension.preRunHook.filePath,
        timeout: extension.preRunHook.timeoutMs === undefined
          ? undefined
          : toProtoDuration(extension.preRunHook.timeoutMs)
      }
    )
  });
}

function fromProtoScheduleExecution(value: ScheduleExecutionSnapshot | undefined): unknown {
  if (value === undefined) return {};
  const base = {
    ...(value.model?.model?.providerId === undefined ? {} : { providerId: value.model.model.providerId }),
    ...(value.model?.model?.modelId === undefined ? {} : { modelId: value.model.model.modelId }),
    ...(value.model?.effortId === undefined || value.model.effortId === "" ? {} : { effort: value.model.effortId }),
    fastMode: value.model?.fastMode ?? false,
    permissionMode: fromProtoPermissionMode(value.permissionMode),
    planMode: value.planMode,
    useWorktree: value.useWorktree,
    ...(value.worktreeSourceRef === undefined ? {} : { worktreeSourceRef: value.worktreeSourceRef }),
    refreshWorktreeRemote: value.refreshWorktreeRemote,
    extraDirectoryIds: [...value.extraDirectoryIds]
  };
  const executionMode = value.executionMode === contract.ScheduleExecutionMode.SCRIPT ? "script" : "agent";
  const scriptConfig = value.script === undefined
    ? undefined
    : {
        command: requiredProtoText(value.script.command, "schedule.execution.script.command", 32_768),
        capabilities: value.script.capabilities.map((capability) => {
          if (capability !== contract.ScheduleScriptCapability.SESSIONS_DISPATCH) {
            throw new ProtoMappingError(
              "invalid_argument",
              "schedule.execution.script.capabilities",
              "Schedule script capability is unsupported."
            );
          }
          return "sessions.dispatch" as const;
        }),
        ...(value.script.timeout === undefined
          ? {}
          : { timeoutMs: fromProtoDuration(value.script.timeout, "schedule.execution.script.timeout") as number })
      };
  if ((executionMode === "script") !== (scriptConfig !== undefined)) {
    throw new ProtoMappingError(
      "invalid_argument",
      "schedule.execution.script",
      "Script execution mode requires a script configuration, and agent mode forbids one."
    );
  }
  const preRunHook = value.preRunHook === undefined
    ? undefined
    : {
        command: requiredProtoText(value.preRunHook.command, "schedule.execution.pre_run_hook.command", 32_768),
        filePath: requiredProtoText(value.preRunHook.filePath, "schedule.execution.pre_run_hook.file_path", 4_096),
        ...(value.preRunHook.timeout === undefined
          ? {}
          : { timeoutMs: fromProtoDuration(value.preRunHook.timeout, "schedule.execution.pre_run_hook.timeout") as number })
      };
  const extension: ScheduleExtensionSnapshot = {
    format: 1,
    silentWhenIdle: value.silentWhenIdle,
    notify: { desktop: value.notify?.desktop ?? true },
    executionMode,
    ...(scriptConfig === undefined ? {} : { scriptConfig }),
    ...(value.expireAt === undefined ? {} : {
      expireAt: fromProtoTimestamp(value.expireAt, "schedule.execution.expire_at") as number
    }),
    ...(preRunHook === undefined ? {} : { preRunHook })
  };
  return withScheduleExtensionSnapshot(base, extension);
}

function toProtoScheduleHistory(record: ScheduleRunRecord, run: StoredRun | undefined): ScheduleRunHistory {
  const detail = objectValue(record.detail);
  const script = objectValue(detail["script"]);
  const error = run?.descriptor.error ?? (isPublicError(record.detail)
    ? record.detail
    : scheduleHistoryDetailError(record.status, detail, script));
  const finishedAt = record.finishedAt ?? run?.descriptor.endedAt;
  const cost = scheduleHistoryMoney(detail["costMoney"], "actual-cost");
  const estimatedValue = scheduleHistoryMoney(detail["estimatedValueMoney"], "value-estimate");
  const preRun = scheduleHistoryPreRunResult(detail["preRunHook"]);
  return message<ScheduleRunHistory>("joko.v1.ScheduleRunHistory", {
    triggerId: record.id.toString(10),
    runId: record.runId,
    scheduledFor: toProtoTimestamp(record.firedAt),
    triggeredAt: toProtoTimestamp(record.firedAt),
    state: run === undefined ? scheduleRunState(record.status) : toProtoRunState(run.descriptor.state),
    error: optionalError(error),
    sessionId: record.sessionId ?? "",
    finishedAt: optionalTimestamp(record.finishedAt),
    resultText: typeof script["resultText"] === "string"
      ? redactSecrets(script["resultText"])
      : "",
    zeroCost: detail["costAttribution"] === "zero",
    outcome: scheduleRunOutcome(record.status),
    costAttribution: scheduleRunCostAttribution(detail["costAttribution"]),
    ...(cost === undefined ? {} : { cost }),
    ...(estimatedValue === undefined ? {} : { estimatedValue }),
    ...(preRun === undefined ? {} : { preRun }),
    ...(record.readAt === undefined ? {} : { readAt: toProtoTimestamp(record.readAt) }),
    ...(finishedAt === undefined
      ? {}
      : { duration: toProtoDuration(Math.max(0, finishedAt - record.firedAt)) })
  });
}

function toProtoRuntimeRecoveryState(
  state: Extract<EventPayload, { readonly type: "runtime_recovery" }>["state"]
): ProtoRuntimeRecoveryState {
  switch (state) {
    case "waiting": return ProtoRuntimeRecoveryState.WAITING;
    case "running": return ProtoRuntimeRecoveryState.RUNNING;
    case "succeeded": return ProtoRuntimeRecoveryState.SUCCEEDED;
    case "failed": return ProtoRuntimeRecoveryState.FAILED;
    case "exhausted": return ProtoRuntimeRecoveryState.EXHAUSTED;
    case "cancelled": return ProtoRuntimeRecoveryState.CANCELLED;
  }
}

function fromProtoRuntimeRecoveryState(
  state: ProtoRuntimeRecoveryState
): Extract<EventPayload, { readonly type: "runtime_recovery" }>["state"] {
  switch (state) {
    case ProtoRuntimeRecoveryState.WAITING: return "waiting";
    case ProtoRuntimeRecoveryState.RUNNING: return "running";
    case ProtoRuntimeRecoveryState.SUCCEEDED: return "succeeded";
    case ProtoRuntimeRecoveryState.FAILED: return "failed";
    case ProtoRuntimeRecoveryState.EXHAUSTED: return "exhausted";
    case ProtoRuntimeRecoveryState.CANCELLED: return "cancelled";
    default:
      throw new ProtoMappingError(
        "invalid_argument",
        "event.payload.runtime_recovery_changed.state",
        "Runtime recovery state is required."
      );
  }
}

function terminalScheduleRunOutcome(status: string): boolean {
  return ["success", "succeeded", "completed", "aborted", "interrupted", "cancelled", "failed"]
    .includes(status.toLowerCase());
}

function scheduleRunOutcome(status: string): contract.ScheduleRunOutcome {
  switch (status.toLowerCase()) {
    case "completed":
    case "success":
    case "succeeded": return contract.ScheduleRunOutcome.SUCCEEDED;
    case "preflight_passed":
    case "running": return contract.ScheduleRunOutcome.RUNNING;
    case "skipped": return contract.ScheduleRunOutcome.SKIPPED;
    case "aborted":
    case "cancelled": return contract.ScheduleRunOutcome.ABORTED;
    case "interrupted": return contract.ScheduleRunOutcome.INTERRUPTED;
    case "failed": return contract.ScheduleRunOutcome.FAILED;
    default: return contract.ScheduleRunOutcome.QUEUED;
  }
}

function scheduleRunCostAttribution(value: unknown): contract.ScheduleRunCostAttribution {
  switch (value) {
    case "exact": return contract.ScheduleRunCostAttribution.EXACT;
    case "direct": return contract.ScheduleRunCostAttribution.DIRECT;
    case "mixed": return contract.ScheduleRunCostAttribution.MIXED;
    case "zero": return contract.ScheduleRunCostAttribution.ZERO;
    case "unavailable":
    default: return contract.ScheduleRunCostAttribution.UNAVAILABLE;
  }
}

function scheduleHistoryMoney(
  value: unknown,
  expectedKind: "actual-cost" | "value-estimate"
): contract.ScheduleRunMoney | undefined {
  const money = objectValue(value);
  const amount = money["amount"];
  const currency = money["currency"];
  const approximate = money["approximate"];
  const kind = money["kind"];
  if (
    typeof amount !== "number"
    || !Number.isFinite(amount)
    || amount < 0
    || (currency !== "CNY" && currency !== "USD")
    || typeof approximate !== "boolean"
    || kind !== expectedKind
  ) {
    return undefined;
  }
  const amountMicros = Math.round(amount * 1_000_000);
  if (!Number.isSafeInteger(amountMicros)) return undefined;
  const estimateReasons = Array.isArray(money["estimateReasons"])
    ? money["estimateReasons"].filter((reason): reason is string => typeof reason === "string").slice(0, 32)
    : [];
  return message<contract.ScheduleRunMoney>("joko.v1.ScheduleRunMoney", {
    amountMicros: BigInt(amountMicros),
    currencyCode: currency,
    approximate,
    kind: expectedKind,
    estimateReasons
  });
}

function scheduleHistoryPreRunResult(value: unknown): contract.SchedulePreRunResult | undefined {
  const result = objectValue(value);
  const status = result["status"];
  const decision = result["decision"];
  const durationMs = result["durationMs"];
  if (
    (status !== "passed" && status !== "skipped" && status !== "failed" && status !== "timed_out" && status !== "aborted")
    || (decision !== "run" && decision !== "skip" && decision !== "block")
    || typeof durationMs !== "number"
    || !Number.isSafeInteger(durationMs)
    || durationMs < 0
  ) {
    return undefined;
  }
  const exitCode = result["exitCode"];
  return message<contract.SchedulePreRunResult>("joko.v1.SchedulePreRunResult", {
    status,
    decision,
    ...(typeof exitCode === "number" && Number.isSafeInteger(exitCode) && exitCode >= -2_147_483_648 && exitCode <= 2_147_483_647
      ? { exitCode }
      : {}),
    duration: toProtoDuration(durationMs),
    stdout: scheduleHistoryText(result["stdoutSummary"], 512),
    stderr: scheduleHistoryText(result["stderrSummary"], 512),
    stdoutTruncated: result["stdoutTruncated"] === true,
    stderrTruncated: result["stderrTruncated"] === true,
    timedOut: result["timedOut"] === true,
    aborted: result["aborted"] === true,
    spawnError: scheduleHistoryText(result["spawnError"], 2_048),
    error: scheduleHistoryText(result["error"], 2_048)
  });
}

function scheduleHistoryText(value: unknown, maximum: number): string {
  return typeof value === "string" ? redactSecrets(value).slice(0, maximum) : "";
}

function protoScheduleRunPhase(
  phase: import("./scheduler-runtime-state.js").ScheduleRunPhase
): contract.ScheduleRunPhase {
  switch (phase) {
    case "loading": return contract.ScheduleRunPhase.LOADING;
    case "claiming": return contract.ScheduleRunPhase.CLAIMING;
    case "persisting": return contract.ScheduleRunPhase.PERSISTING;
    case "running": return contract.ScheduleRunPhase.RUNNING;
    case "queued": return contract.ScheduleRunPhase.QUEUED;
    case "cancelling": return contract.ScheduleRunPhase.CANCELLING;
    case "finalizing": return contract.ScheduleRunPhase.FINALIZING;
    case "stalled": return contract.ScheduleRunPhase.STALLED;
    case "recovering": return contract.ScheduleRunPhase.RECOVERING;
  }
}

function scheduleRunState(status: string): RunState {
  switch (status.toLowerCase()) {
    case "completed":
    case "success":
    case "succeeded": return RunState.SUCCEEDED;
    case "preflight_passed":
    case "running": return RunState.RUNNING;
    case "skipped": return RunState.CANCELLED;
    case "aborted":
    case "interrupted":
    case "cancelled": return RunState.ABORTED;
    case "failed": return RunState.FAILED;
    default: return RunState.QUEUED;
  }
}

function toProtoInteractionKind(kind: InteractionPayload["kind"]): InteractionKind {
  switch (kind) {
    case "permission": return InteractionKind.PERMISSION;
    case "question": return InteractionKind.QUESTION;
    case "plan_review": return InteractionKind.PLAN_REVIEW;
    default: return InteractionKind.EXTENSION_UI;
  }
}

function permissionRisk(value: "low" | "medium" | "high"): PermissionRisk {
  switch (value) {
    case "low": return PermissionRisk.LOW;
    case "medium": return PermissionRisk.MEDIUM;
    case "high": return PermissionRisk.HIGH;
  }
}

function fromPermissionRisk(value: PermissionRisk): "low" | "medium" | "high" {
  switch (value) {
    case PermissionRisk.HIGH:
    case PermissionRisk.CRITICAL: return "high";
    case PermissionRisk.MEDIUM: return "medium";
    default: return "low";
  }
}

function permissionDecision(value: string): PermissionDecisionKind {
  switch (value.toLowerCase().replace(/[ -]/gu, "_")) {
    case "allow":
    case "allow_once": return PermissionDecisionKind.ALLOW_ONCE;
    case "allow_for_turn": return PermissionDecisionKind.ALLOW_FOR_TURN;
    case "allow_for_session": return PermissionDecisionKind.ALLOW_FOR_SESSION;
    case "deny":
    case "deny_once": return PermissionDecisionKind.DENY_ONCE;
    case "deny_for_session": return PermissionDecisionKind.DENY_FOR_SESSION;
    case "abort":
    case "abort_run": return PermissionDecisionKind.ABORT_RUN;
    default: return PermissionDecisionKind.UNSPECIFIED;
  }
}

function permissionDecisionName(value: PermissionDecisionKind): string {
  switch (value) {
    case PermissionDecisionKind.ALLOW_ONCE: return "allow_once";
    case PermissionDecisionKind.ALLOW_FOR_TURN: return "allow_for_turn";
    case PermissionDecisionKind.ALLOW_FOR_SESSION: return "allow_for_session";
    case PermissionDecisionKind.DENY_ONCE: return "deny_once";
    case PermissionDecisionKind.DENY_FOR_SESSION: return "deny_for_session";
    case PermissionDecisionKind.ABORT_RUN: return "abort_run";
    default: return "unspecified";
  }
}

function planDecision(value: string): PlanReviewDecisionKind {
  switch (value.toLowerCase().replace(/[ -]/gu, "_")) {
    case "execute":
    case "execute_plan": return PlanReviewDecisionKind.EXECUTE;
    case "stay":
    case "stay_in_plan_mode": return PlanReviewDecisionKind.STAY_IN_PLAN_MODE;
    case "refine":
    case "refine_plan": return PlanReviewDecisionKind.REFINE;
    default: return PlanReviewDecisionKind.UNSPECIFIED;
  }
}

function toProtoQuestionField(field: InteractionQuestionField): QuestionField {
  const choices = "choices" in field
    ? field.choices.map((choice) => message<QuestionChoice>("joko.v1.QuestionChoice", {
        choiceId: choice.id,
        label: choice.label,
        description: choice.description ?? ""
      }))
    : [];
  let input: QuestionField["input"];
  switch (field.kind) {
    case "text":
      input = {
        case: "text",
        value: message<QuestionTextInput>("joko.v1.QuestionTextInput", {
          placeholder: field.placeholder ?? "",
          defaultValue: field.defaultValue ?? "",
          multiline: field.multiline,
          answerHandling: field.sensitive
            ? QuestionAnswerHandling.CREDENTIAL_CHANNEL
            : QuestionAnswerHandling.NORMAL
        })
      };
      break;
    case "single":
      input = {
        case: "singleChoice",
        value: message<QuestionSingleChoiceInput>("joko.v1.QuestionSingleChoiceInput", {
          choices,
          defaultChoiceId: field.defaultChoiceId ?? ""
        })
      };
      break;
    case "multiple":
      input = {
        case: "multipleChoice",
        value: message<QuestionMultipleChoiceInput>("joko.v1.QuestionMultipleChoiceInput", {
          choices,
          defaultChoiceIds: [...field.defaultChoiceIds],
          minimumSelections: field.minimumSelections,
          maximumSelections: field.maximumSelections ?? 0
        })
      };
      break;
    case "boolean":
      input = {
        case: "boolean",
        value: message<QuestionBooleanInput>("joko.v1.QuestionBooleanInput", { defaultValue: field.defaultValue })
      };
      break;
  }
  return message<QuestionField>("joko.v1.QuestionField", {
    fieldId: field.id,
    label: field.label,
    description: field.description ?? "",
    required: field.required,
    input
  });
}

function fromProtoQuestionField(field: QuestionField): InteractionQuestionField {
  const base = {
    id: field.fieldId,
    label: field.label,
    ...(field.description === "" ? {} : { description: field.description }),
    required: field.required
  };
  const choices = (values: readonly QuestionChoice[]) => values.map((choice) => ({
    id: choice.choiceId,
    label: choice.label,
    ...(choice.description === "" ? {} : { description: choice.description })
  }));
  switch (field.input.case) {
    case "text":
      return {
        ...base,
        kind: "text",
        ...(field.input.value.placeholder === "" ? {} : { placeholder: field.input.value.placeholder }),
        ...(field.input.value.defaultValue === "" ? {} : { defaultValue: field.input.value.defaultValue }),
        multiline: field.input.value.multiline,
        sensitive: field.input.value.answerHandling === QuestionAnswerHandling.CREDENTIAL_CHANNEL
      };
    case "singleChoice":
      return {
        ...base,
        kind: "single",
        choices: choices(field.input.value.choices),
        ...(field.input.value.defaultChoiceId === "" ? {} : { defaultChoiceId: field.input.value.defaultChoiceId })
      };
    case "multipleChoice":
      return {
        ...base,
        kind: "multiple",
        choices: choices(field.input.value.choices),
        defaultChoiceIds: [...field.input.value.defaultChoiceIds],
        minimumSelections: field.input.value.minimumSelections,
        ...(field.input.value.maximumSelections === 0 ? {} : { maximumSelections: field.input.value.maximumSelections })
      };
    case "boolean":
      return { ...base, kind: "boolean", defaultValue: field.input.value.defaultValue };
    case undefined:
      throw new ProtoMappingError("invalid_argument", "interaction.question.field.input", "Question field input is required.");
  }
}

function planDecisionName(value: PlanReviewDecisionKind): PlanReviewDecision | "unspecified" {
  switch (value) {
    case PlanReviewDecisionKind.EXECUTE: return "execute";
    case PlanReviewDecisionKind.STAY_IN_PLAN_MODE: return "stay";
    case PlanReviewDecisionKind.REFINE: return "refine";
    default: return "unspecified";
  }
}

function decisionAnswers(value: unknown): QuestionAnswer[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtoMappingError(
      "invalid_argument",
      "interaction.decision.answers",
      "Question interaction answers must be an object."
    );
  }
  const entries = Object.entries(value as Readonly<Record<string, unknown>>);
  return entries.map(([fieldId, answer]) => message<QuestionAnswer>("joko.v1.QuestionAnswer", {
    fieldId,
    value: questionAnswer(answer, fieldId)
  }));
}

function questionAnswer(value: unknown, fieldId: string): QuestionAnswer["value"] {
  if (typeof value === "boolean") return { case: "boolean", value };
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return {
      case: "choiceIds",
      value: message<StringList>("joko.v1.StringList", { values: value })
    };
  }
  if (typeof value === "string") return { case: "text", value };
  throw new ProtoMappingError(
    "invalid_argument",
    `interaction.decision.answers.${fieldId}`,
    "Question interaction answers must be strings, booleans, or string lists."
  );
}

function questionAnswerValue(answer: QuestionAnswer): unknown {
  switch (answer.value.case) {
    case "text":
    case "choiceId": return answer.value.value;
    case "choiceIds": return [...answer.value.value.values];
    case "boolean": return answer.value.value;
    case "sensitive": return { credentialUploadTicketId: answer.value.value.credentialUploadTicketId };
    case undefined: return undefined;
  }
}

function extensionResolutionValue(resolution: ExtensionUiResolution): unknown {
  switch (resolution.result.case) {
    case "value": return resolution.result.value;
    case "confirmed": return resolution.result.value;
    case "cancelled": return { cancelled: resolution.result.value };
    case undefined: return undefined;
  }
}

function artifactKind(value: string | undefined, mediaType: string): ArtifactKind {
  switch (value?.toLowerCase()) {
    case "image": return ArtifactKind.IMAGE;
    case "export": return ArtifactKind.EXPORT;
    case "tool_result": return ArtifactKind.TOOL_RESULT;
    case "diagnostics": return ArtifactKind.DIAGNOSTICS;
    case "diff": return ArtifactKind.DIFF;
    case "file": return ArtifactKind.FILE;
    default: return mediaType.startsWith("image/") ? ArtifactKind.IMAGE : ArtifactKind.FILE;
  }
}

function recoveryKind(value: string): RecoveryActionKind {
  const normalized = value.toLowerCase();
  if (normalized.includes("reconnect")) return RecoveryActionKind.RECONNECT;
  if (normalized.includes("auth")) return RecoveryActionKind.REAUTHENTICATE;
  if (normalized.includes("interaction")) return RecoveryActionKind.RESOLVE_INTERACTION;
  if (normalized.includes("session")) return RecoveryActionKind.SELECT_NEW_SESSION;
  if (normalized.includes("diagnostic")) return RecoveryActionKind.OPEN_DIAGNOSTICS;
  if (normalized.includes("owner")) return RecoveryActionKind.CONTACT_OWNER;
  if (normalized.includes("abort")) return RecoveryActionKind.ABORT;
  if (normalized.includes("wait")) return RecoveryActionKind.WAIT;
  return RecoveryActionKind.OPEN_DIAGNOSTICS;
}

function isPublicError(value: unknown): value is PublicError {
  const record = objectValue(value);
  return typeof record.code === "string" && typeof record.message === "string" &&
    typeof record.phase === "string" && typeof record.retryable === "boolean" &&
    typeof record.stateMayHaveChanged === "boolean" && typeof record.recovery === "string";
}

function publicError(
  code: string,
  messageText: string,
  phase: string,
  retryable: boolean,
  stateMayHaveChanged: boolean,
  recovery: string
): PublicError {
  return sanitizePublicError({ code, message: messageText, phase, retryable, stateMayHaveChanged, recovery });
}

function queueItemId(event: PersistedEvent, context: EventMappingContext): string {
  if (context.queueItem !== undefined) return context.queueItem.id;
  return event.payload.type === "queue_update" ? event.payload.itemId ?? "" : "";
}

function operationGeneration(record: OperationRecord): number {
  for (const candidate of [objectValue(record.body), objectValue(record.response)]) {
    for (const key of ["generation", "expectedGeneration", "interactionGeneration"]) {
      const value = candidate[key];
      if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
      if (typeof value === "string" && /^\d+$/u.test(value)) {
        const parsed = Number(value);
        if (Number.isSafeInteger(parsed)) return parsed;
      }
    }
  }
  return 0;
}

type ProtoPayloadCase = Exclude<ProtoEventPayload["kind"]["case"], undefined>;

function protoPayload(caseName: ProtoPayloadCase, value: MessageShape): ProtoEventPayload {
  return message<ProtoEventPayload>("joko.v1.EventPayload", {
    kind: { case: caseName, value } as unknown as ProtoEventPayload["kind"]
  });
}

function statusPayload(
  statusId: string,
  label: string,
  detail: string,
  terminal: boolean
): ProtoEventPayload {
  return protoPayload("statusStream", message<StatusStreamEvent>("joko.v1.StatusStreamEvent", {
    statusId,
    label,
    detail,
    progressRatio: 0,
    terminal
  }));
}

function protoToolCall(
  event: PersistedEvent,
  callId: string,
  name: string,
  state: ToolCallState,
  input?: string
): ToolCall {
  const argumentsList: DisplayArgument[] = input === undefined ? [] : [message<DisplayArgument>("joko.v1.DisplayArgument", {
    fieldPath: "$",
    value: { case: "text", value: input },
    redacted: false,
    redactedPlaceholder: ""
  })];
  return message<ToolCall>("joko.v1.ToolCall", {
    toolCallId: callId,
    toolId: name,
    toolProviderId: "",
    sessionId: event.sessionId,
    runId: event.runId ?? "",
    attemptId: event.attemptId ?? "",
    state,
    arguments: argumentsList,
    startedAt: toProtoTimestamp(event.emittedAt),
    endedAt: undefined,
    result: undefined,
    error: undefined
  });
}

export function protoToolResult(
  output: string,
  artifact?: BlobRef,
  parts?: readonly CoreToolResultContentPart[]
): ToolResult {
  return message<ToolResult>("joko.v1.ToolResult", {
    parts: parts === undefined
      ? [message<ToolResultPart>("joko.v1.ToolResultPart", { content: { case: "text", value: output } })]
      : parts.map(protoToolResultPart),
    truncated: artifact !== undefined,
    completeOutput: artifact === undefined ? undefined : toProtoBlobRef(artifact)
  });
}

function toProtoToolCallOutputMode(
  value: Extract<EventPayload, { readonly type: "tool_update" }>["outputMode"]
): contract.ToolCallOutputMode {
  if (value === "append") return contract.ToolCallOutputMode.APPEND;
  if (value === "replace") return contract.ToolCallOutputMode.REPLACE;
  return contract.ToolCallOutputMode.UNSPECIFIED;
}

function fromProtoToolCallOutputMode(
  value: contract.ToolCallOutputMode
): Extract<EventPayload, { readonly type: "tool_update" }>["outputMode"] {
  if (value === contract.ToolCallOutputMode.APPEND) return "append";
  if (value === contract.ToolCallOutputMode.REPLACE) return "replace";
  return undefined;
}

function scheduleHistoryDetailError(
  status: string,
  detail: Readonly<Record<string, unknown>>,
  script: Readonly<Record<string, unknown>>
): PublicError | undefined {
  const normalized = status.toLowerCase();
  if (normalized !== "failed" && normalized !== "interrupted") return undefined;
  const raw = typeof script["error"] === "string"
    ? script["error"]
    : typeof detail["reason"] === "string"
      ? detail["reason"]
      : "Schedule execution failed.";
  return publicError(
    normalized === "interrupted" ? "SCHEDULE_INTERRUPTED" : "SCHEDULE_EXECUTION_FAILED",
    redactSecrets(raw).slice(0, 2_048),
    "schedule",
    false,
    normalized === "interrupted",
    normalized === "interrupted"
      ? "Inspect external effects before running this Schedule again."
      : "Inspect the Schedule run details, correct the configuration, and retry."
  );
}

function protoToolResultPart(part: CoreToolResultContentPart): ToolResultPart {
  switch (part.kind) {
    case "text":
      return message<ToolResultPart>("joko.v1.ToolResultPart", { content: { case: "text", value: part.text } });
    case "image":
      return message<ToolResultPart>("joko.v1.ToolResultPart", {
        content: {
          case: "image",
          value: message<ImageRef>("joko.v1.ImageRef", {
            blob: toProtoBlobRef(part.blob),
            widthPixels: 0,
            heightPixels: 0,
            altText: part.alt ?? ""
          })
        }
      });
    case "artifact":
      return message<ToolResultPart>("joko.v1.ToolResultPart", {
        content: {
          case: "artifact",
          value: message<ArtifactRef>("joko.v1.ArtifactRef", {
            artifactId: part.blob.id,
            blob: toProtoBlobRef(part.blob),
            kind: ArtifactKind.TOOL_RESULT,
            title: part.label
          })
        }
      });
  }
}

function coreToolResultParts(result: ToolResult | undefined): readonly CoreToolResultContentPart[] {
  if (result === undefined) return [];
  const parts: CoreToolResultContentPart[] = [];
  for (const part of result.parts) {
    switch (part.content.case) {
      case "text":
        parts.push({ kind: "text", text: part.content.value });
        break;
      case "image": {
        const blob = part.content.value.blob;
        if (blob !== undefined) {
          parts.push({
            kind: "image",
            blob: fromProtoBlobRef(blob),
            ...(part.content.value.altText === "" ? {} : { alt: part.content.value.altText })
          });
        }
        break;
      }
      case "artifact": {
        const blob = part.content.value.blob;
        if (blob !== undefined) {
          parts.push({
            kind: "artifact",
            blob: fromProtoBlobRef(blob),
            label: part.content.value.title || part.content.value.artifactId
          });
        }
        break;
      }
      default:
        break;
    }
  }
  return parts;
}

function toolInput(call: ToolCall): string {
  const values = call.arguments.map((argument) => {
    switch (argument.value.case) {
      case "text": return argument.value.value;
      case "number": return String(argument.value.value);
      case "integer": return argument.value.value.toString(10);
      case "boolean": return String(argument.value.value);
      case "blob": return argument.value.value.blobId;
      case "null": return "null";
      case "composite": return argument.redacted ? argument.redactedPlaceholder : "[composite]";
      case undefined: return "";
    }
  });
  return values.length <= 1 ? values[0] ?? "" : JSON.stringify(values);
}

function toolOutput(result: ToolResult | undefined): string {
  if (result === undefined) return "";
  return result.parts.map((part) => {
    switch (part.content.case) {
      case "text": return part.content.value;
      case "image":
      case "artifact": return "";
      case "command": return `${part.content.value.stdoutPreview}${part.content.value.stderrPreview}`;
      case "fileChange": return part.content.value.relativePath;
      case "table": return JSON.stringify(part.content.value.rows.map((row) => row.cells));
      case undefined: return "";
    }
  }).join("");
}

function artifactFromBlob(blob: BlobRef, event: PersistedEvent, purpose: string): Artifact {
  return message<Artifact>("joko.v1.Artifact", {
    artifactId: blob.id,
    sessionId: event.sessionId,
    runId: event.runId ?? "",
    kind: artifactKind(undefined, blob.mimeType),
    title: blob.fileName ?? blob.id,
    description: purpose,
    blob: { ...toProtoBlobRef(blob, event.emittedAt), disposition: BlobDisposition.ARTIFACT },
    createdAt: toProtoTimestamp(event.emittedAt),
    expiresAt: undefined
  });
}

export function toProtoSubagentRun(
  value: SubagentRun,
  version?: { readonly revision: bigint; readonly generation: number; readonly updatedAt: number }
): contract.SubagentRun {
  return message<contract.SubagentRun>("joko.v1.SubagentRun", {
    subagentRunId: value.id,
    sessionId: value.sessionId,
    parentRunId: value.parentRunId ?? "",
    parentSubagentRunId: value.parentSubagentRunId ?? "",
    parentTaskId: value.parentTaskId ?? "",
    parentToolCallId: value.parentToolCallId ?? "",
    logicalAgentId: value.logicalAgentId,
    identityAliases: [...value.identityAliases],
    providerRunIds: [...value.providerRunIds],
    state: toProtoSubagentRunState(value.state),
    title: value.title ?? "",
    description: value.description ?? "",
    assignment: value.assignment ?? "",
    summary: value.summary ?? "",
    route: value.route === undefined ? undefined : message<contract.SubagentRoute>("joko.v1.SubagentRoute", {
      providerId: value.route.providerId ?? "",
      modelId: value.route.modelId ?? "",
      thinkingLevel: value.route.thinkingLevel ?? ""
    }),
    usage: value.usage === undefined ? undefined : toProtoSubagentUsage(value.usage),
    readOnly: value.readOnly,
    capabilities: message<contract.SubagentCapabilities>("joko.v1.SubagentCapabilities", {
      viewActivity: value.capabilities.viewActivity,
      viewReturnedResult: value.capabilities.viewReturnedResult,
      viewFullTranscript: value.capabilities.viewFullTranscript,
      stop: value.capabilities.stop,
      steer: value.capabilities.steer,
      followUp: value.capabilities.followUp,
      resume: value.capabilities.resume,
      parentContext: value.capabilities.parentContext === "none"
        ? contract.SubagentParentContext.NONE
        : value.capabilities.parentContext === "snapshot"
          ? contract.SubagentParentContext.SNAPSHOT
          : value.capabilities.parentContext === "live"
            ? contract.SubagentParentContext.LIVE
            : contract.SubagentParentContext.UNSPECIFIED
    }),
    startedAt: toProtoTimestamp(value.startedAt),
    updatedAt: toProtoTimestamp(value.updatedAt),
    endedAt: value.endedAt === undefined ? undefined : toProtoTimestamp(value.endedAt),
    error: optionalError(value.error),
    version: version === undefined
      ? undefined
      : toProtoEntityVersion(version.revision, version.generation, version.updatedAt)
  });
}

export function toProtoSubagentRunDetail(
  value: SubagentRunDetail,
  version?: { readonly revision: bigint; readonly generation: number; readonly updatedAt: number }
): contract.SubagentRunDetail {
  return message<contract.SubagentRunDetail>("joko.v1.SubagentRunDetail", {
    run: toProtoSubagentRun(value, version),
    activity: value.activity.map((entry) => message<contract.SubagentActivity>("joko.v1.SubagentActivity", {
      sequence: BigInt(entry.sequence),
      kind: toProtoSubagentActivityKind(entry.kind),
      state: toProtoSubagentRunState(entry.state),
      summary: entry.summary ?? "",
      lastToolName: entry.lastToolName ?? "",
      occurredAt: toProtoTimestamp(entry.occurredAt)
    })),
    children: (value.children ?? []).map(toProtoSubagentChildRun),
    childrenObserved: value.children === undefined ? undefined : true,
    returnedResult: value.returnedResult,
    returnedResultTruncated: value.returnedResultTruncated
  });
}

export function toProtoSubagentTranscriptEntry(value: SubagentTranscriptEntry): contract.SubagentTranscriptEntry {
  return message<contract.SubagentTranscriptEntry>("joko.v1.SubagentTranscriptEntry", {
    entryId: value.id,
    sequence: BigInt(value.sequence),
    role: value.role === "parent"
      ? contract.SubagentTranscriptRole.PARENT
      : value.role === "subagent"
        ? contract.SubagentTranscriptRole.SUBAGENT
        : value.role === "tool"
          ? contract.SubagentTranscriptRole.TOOL
          : contract.SubagentTranscriptRole.SYSTEM,
    content: value.content,
    occurredAt: toProtoTimestamp(value.occurredAt),
    childId: value.childId ?? "",
    childTitle: value.childTitle ?? "",
    toolName: value.toolName ?? "",
    toolCallId: value.toolCallId ?? "",
    toolPhase: value.toolPhase === "start"
      ? contract.SubagentToolPhase.START
      : value.toolPhase === "update"
        ? contract.SubagentToolPhase.UPDATE
        : value.toolPhase === "end"
          ? contract.SubagentToolPhase.END
          : contract.SubagentToolPhase.UNSPECIFIED,
    toolInputJson: value.toolInputJson ?? "",
    isError: value.isError,
    controlAction: value.controlAction === "stop"
      ? contract.SubagentControlAction.STOP
      : value.controlAction === "steer"
        ? contract.SubagentControlAction.STEER
        : value.controlAction === "follow_up"
          ? contract.SubagentControlAction.FOLLOW_UP
          : value.controlAction === "resume"
            ? contract.SubagentControlAction.RESUME
            : contract.SubagentControlAction.UNSPECIFIED,
    systemEvent: value.systemEvent === undefined
      ? undefined
      : message<contract.SubagentSystemEvent>("joko.v1.SubagentSystemEvent", {
          kind: value.systemEvent.kind,
          params: Object.entries(value.systemEvent.params ?? {}).map(([key, paramValue]) =>
            message<contract.SubagentSystemParameter>("joko.v1.SubagentSystemParameter", {
              key,
              value: paramValue
            }))
        })
  });
}

export function fromProtoSubagentRunDetail(value: contract.SubagentRunDetail): SubagentRunDetail {
  const run = value.run;
  if (run === undefined) throw missingPayload("subagent_run_detail.run");
  const capabilities = run.capabilities;
  if (capabilities === undefined) throw missingPayload("subagent_run.capabilities");
  const startedAt = requiredSubagentTimestamp(run.startedAt, "subagent_run.started_at");
  const updatedAt = requiredSubagentTimestamp(run.updatedAt, "subagent_run.updated_at");
  const children = subagentChildren(value);
  return {
    id: requireText(run.subagentRunId, "subagent_run.subagent_run_id"),
    sessionId: requireText(run.sessionId, "subagent_run.session_id"),
    ...(run.parentRunId === "" ? {} : { parentRunId: run.parentRunId }),
    ...(run.parentSubagentRunId === "" ? {} : { parentSubagentRunId: run.parentSubagentRunId }),
    ...(run.parentTaskId === "" ? {} : { parentTaskId: run.parentTaskId }),
    ...(run.parentToolCallId === "" ? {} : { parentToolCallId: run.parentToolCallId }),
    logicalAgentId: requireText(run.logicalAgentId, "subagent_run.logical_agent_id"),
    identityAliases: [...run.identityAliases],
    providerRunIds: [...run.providerRunIds],
    state: fromProtoSubagentRunState(run.state, "subagent_run.state"),
    ...(run.title === "" ? {} : { title: run.title }),
    ...(run.description === "" ? {} : { description: run.description }),
    ...(run.assignment === "" ? {} : { assignment: run.assignment }),
    ...(run.summary === "" ? {} : { summary: run.summary }),
    ...(run.route === undefined ? {} : {
      route: {
        ...(run.route.providerId === "" ? {} : { providerId: run.route.providerId }),
        ...(run.route.modelId === "" ? {} : { modelId: run.route.modelId }),
        ...(run.route.thinkingLevel === "" ? {} : { thinkingLevel: run.route.thinkingLevel })
      }
    }),
    ...(run.usage === undefined ? {} : { usage: fromProtoSubagentUsage(run.usage) }),
    ...(run.readOnly === undefined ? {} : { readOnly: run.readOnly }),
    capabilities: {
      viewActivity: capabilities.viewActivity,
      viewReturnedResult: capabilities.viewReturnedResult,
      viewFullTranscript: capabilities.viewFullTranscript,
      stop: capabilities.stop,
      steer: capabilities.steer,
      followUp: capabilities.followUp,
      resume: capabilities.resume,
      parentContext: capabilities.parentContext === contract.SubagentParentContext.NONE
        ? "none"
        : capabilities.parentContext === contract.SubagentParentContext.SNAPSHOT
          ? "snapshot"
          : capabilities.parentContext === contract.SubagentParentContext.LIVE
            ? "live"
            : "unknown"
    },
    startedAt,
    updatedAt,
    ...(fromProtoTimestamp(run.endedAt, "subagent_run.ended_at") === undefined
      ? {}
      : { endedAt: fromProtoTimestamp(run.endedAt, "subagent_run.ended_at") as number }),
    ...(run.error === undefined ? {} : { error: fromProtoErrorInfo(run.error) }),
    activity: value.activity.map(fromProtoSubagentActivity),
    ...(children === undefined ? {} : { children }),
    ...(value.returnedResult === undefined ? {} : { returnedResult: value.returnedResult }),
    ...(value.returnedResultTruncated === undefined
      ? {}
      : { returnedResultTruncated: value.returnedResultTruncated })
  };
}

export function fromProtoSubagentTranscriptEntry(value: contract.SubagentTranscriptEntry): SubagentTranscriptEntry {
  return {
    id: requireText(value.entryId, "subagent_transcript_entry.entry_id"),
    sequence: safeNumber(value.sequence, "subagent_transcript_entry.sequence"),
    role: value.role === contract.SubagentTranscriptRole.PARENT
      ? "parent"
      : value.role === contract.SubagentTranscriptRole.SUBAGENT
        ? "subagent"
        : value.role === contract.SubagentTranscriptRole.TOOL
          ? "tool"
          : value.role === contract.SubagentTranscriptRole.SYSTEM
            ? "system"
            : (() => { throw new ProtoMappingError("invalid_argument", "subagent_transcript_entry.role", "Transcript role is required."); })(),
    content: value.content,
    occurredAt: requiredSubagentTimestamp(value.occurredAt, "subagent_transcript_entry.occurred_at"),
    ...(value.childId === "" ? {} : { childId: value.childId }),
    ...(value.childTitle === "" ? {} : { childTitle: value.childTitle }),
    ...(value.toolName === "" ? {} : { toolName: value.toolName }),
    ...(value.toolCallId === "" ? {} : { toolCallId: value.toolCallId }),
    ...(value.toolPhase === contract.SubagentToolPhase.START
      ? { toolPhase: "start" as const }
      : value.toolPhase === contract.SubagentToolPhase.UPDATE
        ? { toolPhase: "update" as const }
        : value.toolPhase === contract.SubagentToolPhase.END
          ? { toolPhase: "end" as const }
          : {}),
    ...(value.toolInputJson === "" ? {} : { toolInputJson: value.toolInputJson }),
    ...(value.isError === undefined ? {} : { isError: value.isError }),
    ...(value.controlAction === contract.SubagentControlAction.STOP
      ? { controlAction: "stop" as const }
      : value.controlAction === contract.SubagentControlAction.STEER
        ? { controlAction: "steer" as const }
        : value.controlAction === contract.SubagentControlAction.FOLLOW_UP
          ? { controlAction: "follow_up" as const }
          : value.controlAction === contract.SubagentControlAction.RESUME
            ? { controlAction: "resume" as const }
            : {}),
    ...(value.systemEvent === undefined ? {} : {
      systemEvent: fromProtoSubagentSystemEvent(value.systemEvent)
    })
  };
}

function fromProtoSubagentSystemEvent(
  value: contract.SubagentSystemEvent
): NonNullable<SubagentTranscriptEntry["systemEvent"]> {
  const params = subagentSystemParams(value.params);
  return {
    kind: requireText(value.kind, "subagent_transcript_entry.system_event.kind"),
    ...(params === undefined ? {} : { params })
  };
}

function subagentSystemParams(
  values: readonly contract.SubagentSystemParameter[]
): Readonly<Record<string, string>> | undefined {
  if (values.length === 0) return undefined;
  const result: Record<string, string> = {};
  for (const value of values) {
    const key = requireText(value.key, "subagent_transcript_entry.system_event.params.key");
    if (Object.hasOwn(result, key)) {
      throw new ProtoMappingError(
        "invalid_argument",
        "subagent_transcript_entry.system_event.params.key",
        "System event parameter keys must be unique."
      );
    }
    result[key] = value.value;
  }
  return result;
}

function subagentChildren(value: contract.SubagentRunDetail): readonly SubagentChildRun[] | undefined {
  if (value.childrenObserved !== true) {
    if (value.children.length !== 0) {
      throw new ProtoMappingError(
        "invalid_argument",
        "subagent_run_detail.children_observed",
        "Child detail requires an explicit observation marker."
      );
    }
    return undefined;
  }
  return value.children.map(fromProtoSubagentChildRun);
}

function toProtoSubagentUsage(value: SubagentUsage): contract.SubagentUsage {
  return message<contract.SubagentUsage>("joko.v1.SubagentUsage", {
    inputTokens: value.inputTokens === undefined ? undefined : BigInt(value.inputTokens),
    outputTokens: value.outputTokens === undefined ? undefined : BigInt(value.outputTokens),
    cacheReadTokens: value.cacheReadTokens === undefined ? undefined : BigInt(value.cacheReadTokens),
    cacheWriteTokens: value.cacheWriteTokens === undefined ? undefined : BigInt(value.cacheWriteTokens),
    totalTokens: value.totalTokens === undefined ? undefined : BigInt(value.totalTokens),
    toolUses: value.toolUses === undefined ? undefined : BigInt(value.toolUses),
    duration: value.durationMs === undefined ? undefined : toProtoDuration(value.durationMs),
    costUsd: value.costUsd
  });
}

function fromProtoSubagentUsage(value: contract.SubagentUsage): SubagentUsage {
  return {
    ...(value.inputTokens === undefined ? {} : { inputTokens: safeNumber(value.inputTokens, "subagent_usage.input_tokens") }),
    ...(value.outputTokens === undefined ? {} : { outputTokens: safeNumber(value.outputTokens, "subagent_usage.output_tokens") }),
    ...(value.cacheReadTokens === undefined ? {} : { cacheReadTokens: safeNumber(value.cacheReadTokens, "subagent_usage.cache_read_tokens") }),
    ...(value.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: safeNumber(value.cacheWriteTokens, "subagent_usage.cache_write_tokens") }),
    ...(value.totalTokens === undefined ? {} : { totalTokens: safeNumber(value.totalTokens, "subagent_usage.total_tokens") }),
    ...(value.toolUses === undefined ? {} : { toolUses: safeNumber(value.toolUses, "subagent_usage.tool_uses") }),
    ...(value.duration === undefined ? {} : { durationMs: fromProtoDuration(value.duration, "subagent_usage.duration") as number }),
    ...(value.costUsd === undefined
      ? {}
      : { costUsd: finiteNonNegative(value.costUsd, "subagent_usage.cost_usd") })
  };
}

function toProtoSubagentChildRun(value: SubagentChildRun): contract.SubagentChildRun {
  return message<contract.SubagentChildRun>("joko.v1.SubagentChildRun", {
    childId: value.id,
    parentChildId: value.parentChildId ?? "",
    identityAliases: [...value.identityAliases],
    role: value.role,
    title: value.title ?? "",
    assignment: value.assignment ?? "",
    state: toProtoSubagentRunState(value.state),
    route: value.route === undefined ? undefined : message<contract.SubagentRoute>("joko.v1.SubagentRoute", {
      providerId: value.route.providerId ?? "",
      modelId: value.route.modelId ?? "",
      thinkingLevel: value.route.thinkingLevel ?? ""
    }),
    usage: value.usage === undefined ? undefined : toProtoSubagentUsage(value.usage),
    readOnly: value.readOnly,
    awaitingApproval: value.awaitingApproval,
    result: value.result,
    resultTruncated: value.resultTruncated,
    error: optionalError(value.error),
    startedAt: value.startedAt === undefined ? undefined : toProtoTimestamp(value.startedAt),
    endedAt: value.endedAt === undefined ? undefined : toProtoTimestamp(value.endedAt)
  });
}

function fromProtoSubagentChildRun(value: contract.SubagentChildRun): SubagentChildRun {
  return {
    id: requireText(value.childId, "subagent_child.child_id"),
    ...(value.parentChildId === "" ? {} : { parentChildId: value.parentChildId }),
    identityAliases: [...value.identityAliases],
    role: requireText(value.role, "subagent_child.role"),
    ...(value.title === "" ? {} : { title: value.title }),
    ...(value.assignment === "" ? {} : { assignment: value.assignment }),
    state: fromProtoSubagentRunState(value.state, "subagent_child.state"),
    ...(value.route === undefined ? {} : { route: {
      ...(value.route.providerId === "" ? {} : { providerId: value.route.providerId }),
      ...(value.route.modelId === "" ? {} : { modelId: value.route.modelId }),
      ...(value.route.thinkingLevel === "" ? {} : { thinkingLevel: value.route.thinkingLevel })
    } }),
    ...(value.usage === undefined ? {} : { usage: fromProtoSubagentUsage(value.usage) }),
    ...(value.readOnly === undefined ? {} : { readOnly: value.readOnly }),
    ...(value.awaitingApproval === undefined ? {} : { awaitingApproval: value.awaitingApproval }),
    ...(value.result === undefined ? {} : { result: value.result }),
    ...(value.resultTruncated === undefined ? {} : { resultTruncated: value.resultTruncated }),
    ...(value.error === undefined ? {} : { error: fromProtoErrorInfo(value.error) }),
    ...(fromProtoTimestamp(value.startedAt, "subagent_child.started_at") === undefined
      ? {}
      : { startedAt: fromProtoTimestamp(value.startedAt, "subagent_child.started_at") as number }),
    ...(fromProtoTimestamp(value.endedAt, "subagent_child.ended_at") === undefined
      ? {}
      : { endedAt: fromProtoTimestamp(value.endedAt, "subagent_child.ended_at") as number })
  };
}

function fromProtoSubagentActivity(value: contract.SubagentActivity): SubagentActivityEntry {
  return {
    sequence: safeNumber(value.sequence, "subagent_activity.sequence"),
    kind: value.kind === contract.SubagentActivityKind.STARTED ? "started"
      : value.kind === contract.SubagentActivityKind.PROGRESS ? "progress"
        : value.kind === contract.SubagentActivityKind.MESSAGE ? "message"
          : value.kind === contract.SubagentActivityKind.QUESTION ? "question"
            : value.kind === contract.SubagentActivityKind.DECISION ? "decision"
              : value.kind === contract.SubagentActivityKind.RESUMED ? "resumed"
                : value.kind === contract.SubagentActivityKind.STEERED ? "steered"
                  : value.kind === contract.SubagentActivityKind.FOLLOWED_UP ? "followed_up"
                    : value.kind === contract.SubagentActivityKind.COMPLETED ? "completed"
                      : value.kind === contract.SubagentActivityKind.FAILED ? "failed"
                        : value.kind === contract.SubagentActivityKind.STOPPED ? "stopped"
                          : (() => { throw new ProtoMappingError("invalid_argument", "subagent_activity.kind", "Activity kind is required."); })(),
    state: fromProtoSubagentRunState(value.state, "subagent_activity.state"),
    ...(value.summary === "" ? {} : { summary: value.summary }),
    ...(value.lastToolName === "" ? {} : { lastToolName: value.lastToolName }),
    occurredAt: requiredSubagentTimestamp(value.occurredAt, "subagent_activity.occurred_at")
  };
}

function toProtoSubagentActivityKind(value: SubagentActivityEntry["kind"]): contract.SubagentActivityKind {
  switch (value) {
    case "started": return contract.SubagentActivityKind.STARTED;
    case "progress": return contract.SubagentActivityKind.PROGRESS;
    case "message": return contract.SubagentActivityKind.MESSAGE;
    case "question": return contract.SubagentActivityKind.QUESTION;
    case "decision": return contract.SubagentActivityKind.DECISION;
    case "resumed": return contract.SubagentActivityKind.RESUMED;
    case "steered": return contract.SubagentActivityKind.STEERED;
    case "followed_up": return contract.SubagentActivityKind.FOLLOWED_UP;
    case "completed": return contract.SubagentActivityKind.COMPLETED;
    case "failed": return contract.SubagentActivityKind.FAILED;
    case "stopped": return contract.SubagentActivityKind.STOPPED;
  }
}

function toProtoSubagentRunState(value: SubagentRunState): contract.SubagentRunState {
  switch (value) {
    case "queued": return contract.SubagentRunState.QUEUED;
    case "running": return contract.SubagentRunState.RUNNING;
    case "completed": return contract.SubagentRunState.COMPLETED;
    case "failed": return contract.SubagentRunState.FAILED;
    case "stopped": return contract.SubagentRunState.STOPPED;
  }
}

function fromProtoSubagentRunState(value: contract.SubagentRunState, fieldPath: string): SubagentRunState {
  if (value === contract.SubagentRunState.QUEUED) return "queued";
  if (value === contract.SubagentRunState.RUNNING) return "running";
  if (value === contract.SubagentRunState.COMPLETED) return "completed";
  if (value === contract.SubagentRunState.FAILED) return "failed";
  if (value === contract.SubagentRunState.STOPPED) return "stopped";
  throw new ProtoMappingError("invalid_argument", fieldPath, "Subagent run state is required.");
}

function requiredSubagentTimestamp(value: ProtoTimestamp | undefined, fieldPath: string): number {
  const mapped = fromProtoTimestamp(value, fieldPath);
  if (mapped === undefined) throw new ProtoMappingError("invalid_argument", fieldPath, "Timestamp is required.");
  return mapped;
}

function finiteNonNegative(value: number, fieldPath: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new ProtoMappingError("out_of_range", fieldPath, "Value must be finite and non-negative.");
  }
  return value;
}

export function toProtoUsage(value: UsageSnapshot): Usage {
  return message<Usage>("joko.v1.Usage", {
    inputTokens: unsignedBigInt(value.inputTokens, "usage.input_tokens"),
    outputTokens: unsignedBigInt(value.outputTokens, "usage.output_tokens"),
    cacheReadTokens: unsignedBigInt(value.cacheReadTokens, "usage.cache_read_tokens"),
    cacheWriteTokens: unsignedBigInt(value.cacheWriteTokens, "usage.cache_write_tokens"),
    totalTokens: unsignedBigInt(value.totalTokens, "usage.total_tokens"),
    costMicros: costMicros(value.cost),
    currencyCode: "USD"
  });
}

type MessageCompletionPayload = Extract<EventPayload, { readonly type: "message_complete" }>;
type MessageGenerationTiming = Pick<
  MessageCompletionPayload,
  "generationDurationMs" | "generationReliable"
>;

function toProtoMessageGenerationTiming(
  value: MessageCompletionPayload
): Pick<MessageCompletedEvent, "generationDurationMs" | "generationReliable"> {
  const duration = value.generationDurationMs;
  const reliable = value.generationReliable;
  if (reliable === true) {
    if (!Number.isSafeInteger(duration) || (duration ?? 0) <= 0) {
      throw new ProtoMappingError(
        "out_of_range",
        "event.payload.message_completed.generation_duration_ms",
        "Reliable generation timing requires a positive safe whole-millisecond duration."
      );
    }
    return {
      generationDurationMs: BigInt(duration as number),
      generationReliable: true
    };
  }
  if (duration !== undefined) {
    throw new ProtoMappingError(
      "invalid_argument",
      "event.payload.message_completed.generation_reliable",
      "Generation duration must be explicitly marked reliable."
    );
  }
  return reliable === false ? { generationReliable: false } : {};
}

function fromProtoMessageGenerationTiming(value: MessageCompletedEvent): MessageGenerationTiming {
  const duration = value.generationDurationMs === undefined
    ? undefined
    : safeNumber(
      value.generationDurationMs,
      "event.payload.message_completed.generation_duration_ms"
    );
  if (value.generationReliable === true) {
    if (duration === undefined || duration <= 0) {
      throw new ProtoMappingError(
        "out_of_range",
        "event.payload.message_completed.generation_duration_ms",
        "Reliable generation timing requires a positive duration."
      );
    }
    return { generationDurationMs: duration, generationReliable: true };
  }
  if (duration !== undefined) {
    throw new ProtoMappingError(
      "invalid_argument",
      "event.payload.message_completed.generation_reliable",
      "Generation duration must be explicitly marked reliable."
    );
  }
  return value.generationReliable === false ? { generationReliable: false } : {};
}

export function toProtoContextUsage(value: UsageSnapshot, measuredAt: number): ContextUsage | undefined {
  // Pi deliberately reports an unknown current-context token count after
  // compaction until a fresh assistant response supplies trustworthy usage.
  // Cumulative billed tokens are not a substitute for that live window.
  if (value.contextTokens === undefined || value.contextWindow === undefined) return undefined;
  const used = value.contextTokens;
  const window = value.contextWindow;
  return message<ContextUsage>("joko.v1.ContextUsage", {
    usedTokens: unsignedBigInt(used, "context.used_tokens"),
    contextWindowTokens: unsignedBigInt(window, "context.context_window_tokens"),
    reservedTokens: unsignedBigInt(Math.max(0, window - used), "context.reserved_tokens"),
    utilizationRatio: window === 0 ? 0 : Math.min(1, used / window),
    cumulativeUsage: toProtoUsage(value),
    measuredAt: toProtoTimestamp(measuredAt)
  });
}

function fromProtoUsage(value: Usage, context?: ContextUsage): UsageSnapshot {
  const used = context === undefined ? undefined : safeNumber(context.usedTokens, "context.used_tokens");
  const window = context === undefined ? undefined : safeNumber(context.contextWindowTokens, "context.context_window_tokens");
  const cost = safeNumber(value.costMicros, "usage.cost_micros") / 1_000_000;
  return {
    inputTokens: safeNumber(value.inputTokens, "usage.input_tokens"),
    outputTokens: safeNumber(value.outputTokens, "usage.output_tokens"),
    cacheReadTokens: safeNumber(value.cacheReadTokens, "usage.cache_read_tokens"),
    cacheWriteTokens: safeNumber(value.cacheWriteTokens, "usage.cache_write_tokens"),
    totalTokens: safeNumber(value.totalTokens, "usage.total_tokens"),
    ...(used === undefined ? {} : { contextTokens: used }),
    ...(window === undefined ? {} : { contextWindow: window }),
    cost
  };
}

function backgroundTaskState(value: string): BackgroundTaskState {
  switch (value.toLowerCase()) {
    case "queued": return BackgroundTaskState.QUEUED;
    case "running": return BackgroundTaskState.RUNNING;
    case "waiting": return BackgroundTaskState.WAITING;
    case "completed":
    case "succeeded": return BackgroundTaskState.SUCCEEDED;
    case "failed": return BackgroundTaskState.FAILED;
    case "aborted":
    case "cancelled": return BackgroundTaskState.ABORTED;
    default: return BackgroundTaskState.UNSPECIFIED;
  }
}

function backgroundTaskStateName(value: BackgroundTaskState): string {
  switch (value) {
    case BackgroundTaskState.QUEUED: return "queued";
    case BackgroundTaskState.RUNNING: return "running";
    case BackgroundTaskState.WAITING: return "waiting";
    case BackgroundTaskState.SUCCEEDED: return "succeeded";
    case BackgroundTaskState.FAILED: return "failed";
    case BackgroundTaskState.ABORTED: return "aborted";
    default: return "unknown";
  }
}

function toProtoPiMetadata(value: NonNullable<PersistedEvent["pi"]>): ProtoPiEventMetadata {
  const runtimePayload = (value as unknown as { readonly payload?: unknown }).payload;
  if (!isTypedCorePiPayload(runtimePayload)) {
    throw new ProtoMappingError("invalid_argument", "event.pi.payload", "Pi metadata requires a typed payload.");
  }
  const payload = value.payload;
  switch (payload.case) {
    case "rpcAcknowledgement":
      return piMetadata("rpcAcknowledgement", message<contract.PiRpcAcknowledgement>("joko.v1.PiRpcAcknowledgement", {
        rpcRequestId: payload.value.requestId,
        command: protoPiEnum(contract.PiRpcCommandKind, payload.value.command, contract.PiRpcCommandKind.UNSPECIFIED),
        accepted: payload.value.accepted,
        cancelled: payload.value.cancelled,
        error: payload.value.error === undefined ? undefined : toProtoErrorInfo(payload.value.error)
      }));
    case "nativeState":
      return piMetadata("nativeState", message<contract.PiSessionState>("joko.v1.PiSessionState", {
        nativeSessionId: payload.value.nativeSessionId,
        nativeSessionName: payload.value.nativeSessionName,
        nativeSessionFileDisplay: payload.value.nativeSessionFileDisplay,
        model: payload.value.model === undefined ? undefined : toProtoPiModelKey(payload.value.model),
        thinkingLevel: payload.value.thinkingLevel,
        streaming: payload.value.streaming,
        compacting: payload.value.compacting,
        steeringMode: protoPiEnum(contract.PiQueueMode, payload.value.steeringMode, contract.PiQueueMode.UNSPECIFIED),
        followUpMode: protoPiEnum(contract.PiQueueMode, payload.value.followUpMode, contract.PiQueueMode.UNSPECIFIED),
        autoCompaction: payload.value.autoCompaction,
        autoRetry: payload.value.autoRetry,
        messageCount: unsignedBigInt(payload.value.messageCount, "event.pi.native_state.message_count"),
        pendingMessageCount: unsignedBigInt(payload.value.pendingMessageCount, "event.pi.native_state.pending_message_count"),
        activeLeafId: payload.value.activeLeafId
      }));
    case "messageLifecycle":
      return piMetadata("messageLifecycle", message<contract.PiMessageLifecycle>("joko.v1.PiMessageLifecycle", {
        kind: protoPiEnum(contract.PiMessageLifecycleKind, payload.value.kind, contract.PiMessageLifecycleKind.UNSPECIFIED),
        nativeMessageId: payload.value.nativeMessageId,
        nativeEntryId: payload.value.nativeEntryId,
        role: payload.value.role,
        contentIndex: unsignedInt32(payload.value.contentIndex, "event.pi.message_lifecycle.content_index"),
        parentEntryId: payload.value.parentEntryId
      }));
    case "toolLifecycle":
      return piMetadata("toolLifecycle", message<contract.PiToolLifecycle>("joko.v1.PiToolLifecycle", {
        nativeToolCallId: payload.value.nativeToolCallId,
        toolName: payload.value.toolName,
        builtInKind: protoPiEnum(contract.PiBuiltInToolKind, payload.value.builtInKind, contract.PiBuiltInToolKind.UNSPECIFIED),
        phase: protoPiEnum(contract.PiToolPhase, payload.value.phase, contract.PiToolPhase.UNSPECIFIED),
        contentIndex: unsignedInt32(payload.value.contentIndex, "event.pi.tool_lifecycle.content_index")
      }));
    case "bashUpdate":
      return piMetadata("bashUpdate", message<contract.PiBashUpdate>("joko.v1.PiBashUpdate", {
        nativeBashId: payload.value.nativeBashId,
        commandDisplay: payload.value.commandDisplay,
        stdoutDelta: payload.value.stdoutDelta,
        stderrDelta: payload.value.stderrDelta,
        completed: payload.value.completed,
        exitCode: signedInt32(payload.value.exitCode, "event.pi.bash_update.exit_code"),
        excludedFromContext: payload.value.excludedFromContext
      }));
    case "queueUpdate":
      return piMetadata("queueUpdate", message<contract.PiQueueUpdate>("joko.v1.PiQueueUpdate", {
        steering: payload.value.steering.map(toProtoPiQueuedMessage),
        followUp: payload.value.followUp.map(toProtoPiQueuedMessage),
        steeringMode: protoPiEnum(contract.PiQueueMode, payload.value.steeringMode, contract.PiQueueMode.UNSPECIFIED),
        followUpMode: protoPiEnum(contract.PiQueueMode, payload.value.followUpMode, contract.PiQueueMode.UNSPECIFIED)
      }));
    case "compactionUpdate":
      return piMetadata("compactionUpdate", message<contract.PiCompactionUpdate>("joko.v1.PiCompactionUpdate", {
        compactionId: payload.value.compactionId,
        trigger: protoPiEnum(contract.PiCompactionTrigger, payload.value.trigger, contract.PiCompactionTrigger.UNSPECIFIED),
        state: protoPiEnum(contract.PiCompactionState, payload.value.state, contract.PiCompactionState.UNSPECIFIED),
        reason: payload.value.reason ?? "",
        boundaryEntryId: payload.value.boundaryEntryId,
        tokensBefore: unsignedBigInt(payload.value.tokensBefore, "event.pi.compaction_update.tokens_before"),
        tokensAfter: unsignedBigInt(payload.value.tokensAfter, "event.pi.compaction_update.tokens_after"),
        summaryPreview: payload.value.summaryPreview,
        willRetry: payload.value.willRetry,
        error: payload.value.error === undefined ? undefined : toProtoErrorInfo(payload.value.error)
      }));
    case "retryUpdate":
      return piMetadata("retryUpdate", message<contract.PiRetryUpdate>("joko.v1.PiRetryUpdate", {
        state: protoPiEnum(contract.PiRetryState, payload.value.state, contract.PiRetryState.UNSPECIFIED),
        attemptNumber: unsignedInt32(payload.value.attemptNumber, "event.pi.retry_update.attempt_number"),
        retryAt: payload.value.retryAt === undefined ? undefined : toProtoTimestamp(payload.value.retryAt),
        reason: payload.value.reason,
        error: payload.value.error === undefined ? undefined : toProtoErrorInfo(payload.value.error)
      }));
    case "sessionIdentityUpdate":
      return piMetadata("sessionIdentityUpdate", message<contract.PiSessionIdentityUpdate>("joko.v1.PiSessionIdentityUpdate", {
        previousNativeSessionId: payload.value.previousNativeSessionId,
        nativeSessionId: payload.value.nativeSessionId,
        nativeSessionName: payload.value.nativeSessionName,
        nativeSessionFileDisplay: payload.value.nativeSessionFileDisplay,
        activeLeafId: payload.value.activeLeafId,
        change: protoPiEnum(contract.PiSessionIdentityChangeKind, payload.value.change, contract.PiSessionIdentityChangeKind.UNSPECIFIED)
      }));
    case "sessionTreeUpdate":
      return piMetadata("sessionTreeUpdate", toProtoPiSessionTreeUpdate(payload.value));
    case "commandCatalogUpdate":
      return piMetadata("commandCatalogUpdate", message<contract.PiCommandCatalogUpdate>("joko.v1.PiCommandCatalogUpdate", {
        commands: payload.value.commands.map(toProtoPiSlashCommand)
      }));
    case "extensionUiEffect":
      return piMetadata("extensionUiEffect", toProtoPiExtensionUi(payload.value));
    case "resourceUpdate":
      return piMetadata("resourceUpdate", message<contract.PiResourceUpdate>("joko.v1.PiResourceUpdate", {
        resource: toProtoPiManagedResource(payload.value.resource),
        updateKind: protoPiEnum(contract.PiResourceUpdateKind, payload.value.updateKind, contract.PiResourceUpdateKind.UNSPECIFIED)
      }));
    case "modelUpdate":
      return piMetadata("modelUpdate", message<contract.PiModelUpdate>("joko.v1.PiModelUpdate", {
        previousModel: payload.value.previousModel === undefined ? undefined : toProtoPiModelKey(payload.value.previousModel),
        model: payload.value.model === undefined ? undefined : toProtoPiModelKey(payload.value.model),
        thinkingLevel: payload.value.thinkingLevel,
        scopedModel: payload.value.scopedModel,
        contextWindowTokens: unsignedBigInt(payload.value.contextWindowTokens, "event.pi.model_update.context_window_tokens")
      }));
    case "diagnostic":
      return piMetadata("diagnostic", message<contract.PiDiagnosticMetadata>("joko.v1.PiDiagnosticMetadata", {
        command: protoPiEnum(contract.PiRpcCommandKind, payload.value.command, contract.PiRpcCommandKind.UNSPECIFIED),
        nativeEventType: boundedPiDiagnostic(payload.value.nativeEventType, "event.pi.diagnostic.native_event_type", 128),
        processExitCode: payload.value.processExitCode === undefined ? 0 : signedInt32(payload.value.processExitCode, "event.pi.diagnostic.process_exit_code"),
        sanitizedStderrExcerpt: boundedPiDiagnostic(payload.value.sanitizedStderrExcerpt ?? "", "event.pi.diagnostic.sanitized_stderr_excerpt", 2_048),
        jsonlLineNumber: payload.value.jsonlLineNumber === undefined ? 0n : unsignedBigInt(payload.value.jsonlLineNumber, "event.pi.diagnostic.jsonl_line_number"),
        parseError: boundedPiDiagnostic(payload.value.parseError ?? "", "event.pi.diagnostic.parse_error", 1_024)
      }));
    default:
      return assertNeverPiMetadata(payload);
  }
}

const CORE_PI_PAYLOAD_CASES = new Set([
  "rpcAcknowledgement",
  "nativeState",
  "messageLifecycle",
  "toolLifecycle",
  "bashUpdate",
  "queueUpdate",
  "compactionUpdate",
  "retryUpdate",
  "sessionIdentityUpdate",
  "sessionTreeUpdate",
  "commandCatalogUpdate",
  "extensionUiEffect",
  "resourceUpdate",
  "modelUpdate",
  "diagnostic"
]);

function isTypedCorePiPayload(value: unknown): value is CorePiEventMetadata["payload"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as { readonly case?: unknown; readonly value?: unknown };
  return typeof candidate.case === "string" && CORE_PI_PAYLOAD_CASES.has(candidate.case) &&
    typeof candidate.value === "object" && candidate.value !== null && !Array.isArray(candidate.value);
}

function fromProtoPiMetadata(value: ProtoPiEventMetadata): NonNullable<AppendEventInput["pi"]> {
  const payload = value.payload;
  switch (payload.case) {
    case "rpcAcknowledgement":
      return corePiMetadata("rpc_acknowledgement", {
        case: "rpcAcknowledgement",
        value: {
          requestId: payload.value.rpcRequestId,
          command: fromProtoPiEnum(contract.PiRpcCommandKind, payload.value.command, "unknown"),
          accepted: payload.value.accepted,
          cancelled: payload.value.cancelled,
          ...(payload.value.error === undefined ? {} : { error: fromProtoErrorInfo(payload.value.error) })
        }
      });
    case "nativeState":
      return corePiMetadata("native_state", {
        case: "nativeState",
        value: {
          nativeSessionId: payload.value.nativeSessionId,
          nativeSessionName: payload.value.nativeSessionName,
          nativeSessionFileDisplay: payload.value.nativeSessionFileDisplay,
          ...(payload.value.model === undefined ? {} : { model: fromProtoPiModelKey(payload.value.model) }),
          thinkingLevel: payload.value.thinkingLevel,
          streaming: payload.value.streaming,
          compacting: payload.value.compacting,
          steeringMode: fromProtoPiEnum(contract.PiQueueMode, payload.value.steeringMode, "unknown"),
          followUpMode: fromProtoPiEnum(contract.PiQueueMode, payload.value.followUpMode, "unknown"),
          autoCompaction: payload.value.autoCompaction,
          autoRetry: payload.value.autoRetry,
          messageCount: safeNumber(payload.value.messageCount, "event.pi.native_state.message_count"),
          pendingMessageCount: safeNumber(payload.value.pendingMessageCount, "event.pi.native_state.pending_message_count"),
          activeLeafId: payload.value.activeLeafId
        }
      }, { leafId: payload.value.activeLeafId || undefined });
    case "messageLifecycle": {
      const kind = fromProtoPiEnum(contract.PiMessageLifecycleKind, payload.value.kind, "unknown");
      return corePiMetadata(kind === "unknown" ? "message_lifecycle" : kind, {
        case: "messageLifecycle",
        value: {
          kind,
          nativeMessageId: payload.value.nativeMessageId,
          nativeEntryId: payload.value.nativeEntryId,
          parentEntryId: payload.value.parentEntryId,
          role: payload.value.role,
          contentIndex: payload.value.contentIndex
        }
      }, {
        entryId: payload.value.nativeEntryId || undefined,
        parentEntryId: payload.value.parentEntryId || undefined,
        contentIndex: payload.value.contentIndex
      });
    }
    case "toolLifecycle": {
      const phase = fromProtoPiEnum(contract.PiToolPhase, payload.value.phase, "unknown");
      return corePiMetadata(phase === "unknown" ? "tool_lifecycle" : `tool_execution_${phase}`, {
        case: "toolLifecycle",
        value: {
          nativeToolCallId: payload.value.nativeToolCallId,
          toolName: payload.value.toolName,
          builtInKind: fromProtoPiEnum(contract.PiBuiltInToolKind, payload.value.builtInKind, "unknown"),
          phase,
          contentIndex: payload.value.contentIndex
        }
      }, { contentIndex: payload.value.contentIndex, nativeToolName: payload.value.toolName || undefined });
    }
    case "bashUpdate":
      return corePiMetadata("bash_execution_update", {
        case: "bashUpdate",
        value: {
          nativeBashId: payload.value.nativeBashId,
          commandDisplay: payload.value.commandDisplay,
          stdoutDelta: payload.value.stdoutDelta,
          stderrDelta: payload.value.stderrDelta,
          completed: payload.value.completed,
          exitCode: payload.value.exitCode,
          excludedFromContext: payload.value.excludedFromContext
        }
      });
    case "queueUpdate":
      return corePiMetadata("queue_update", {
        case: "queueUpdate",
        value: {
          steering: payload.value.steering.map(fromProtoPiQueuedMessage),
          followUp: payload.value.followUp.map(fromProtoPiQueuedMessage),
          steeringMode: fromProtoPiEnum(contract.PiQueueMode, payload.value.steeringMode, "unknown"),
          followUpMode: fromProtoPiEnum(contract.PiQueueMode, payload.value.followUpMode, "unknown")
        }
      });
    case "compactionUpdate":
      return corePiMetadata("compaction_update", {
        case: "compactionUpdate",
        value: {
          compactionId: payload.value.compactionId,
          trigger: fromProtoPiEnum(contract.PiCompactionTrigger, payload.value.trigger, "unknown"),
          ...(payload.value.reason === "" ? {} : { reason: payload.value.reason }),
          state: fromProtoPiEnum(contract.PiCompactionState, payload.value.state, "unknown"),
          boundaryEntryId: payload.value.boundaryEntryId,
          tokensBefore: safeNumber(payload.value.tokensBefore, "event.pi.compaction_update.tokens_before"),
          tokensAfter: safeNumber(payload.value.tokensAfter, "event.pi.compaction_update.tokens_after"),
          summaryPreview: payload.value.summaryPreview,
          ...(payload.value.willRetry === undefined ? {} : { willRetry: payload.value.willRetry }),
          ...(payload.value.error === undefined ? {} : { error: fromProtoErrorInfo(payload.value.error) })
        }
      }, { parentEntryId: payload.value.boundaryEntryId || undefined });
    case "retryUpdate":
      return corePiMetadata("retry_update", {
        case: "retryUpdate",
        value: {
          state: fromProtoPiEnum(contract.PiRetryState, payload.value.state, "unknown"),
          attemptNumber: payload.value.attemptNumber,
          ...(payload.value.retryAt === undefined ? {} : { retryAt: requiredProtoTimestamp(payload.value.retryAt, "event.pi.retry_update.retry_at") }),
          reason: payload.value.reason,
          ...(payload.value.error === undefined ? {} : { error: fromProtoErrorInfo(payload.value.error) })
        }
      });
    case "sessionIdentityUpdate":
      return corePiMetadata("session_identity_update", {
        case: "sessionIdentityUpdate",
        value: {
          previousNativeSessionId: payload.value.previousNativeSessionId,
          nativeSessionId: payload.value.nativeSessionId,
          nativeSessionName: payload.value.nativeSessionName,
          nativeSessionFileDisplay: payload.value.nativeSessionFileDisplay,
          activeLeafId: payload.value.activeLeafId,
          change: fromProtoPiEnum(contract.PiSessionIdentityChangeKind, payload.value.change, "unknown")
        }
      }, { leafId: payload.value.activeLeafId || undefined });
    case "sessionTreeUpdate":
      return corePiMetadata("session_tree_update", {
        case: "sessionTreeUpdate",
        value: {
          nativeSessionId: payload.value.nativeSessionId,
          activeLeafId: payload.value.activeLeafId,
          roots: fromProtoPiSessionTreeNodes(materializedPiSessionTreeRoots(payload.value))
        }
      }, { leafId: payload.value.activeLeafId || undefined });
    case "commandCatalogUpdate":
      return corePiMetadata("command_catalog_update", {
        case: "commandCatalogUpdate",
        value: { commands: payload.value.commands.map(fromProtoPiSlashCommand) }
      });
    case "extensionUiEffect":
      return corePiMetadata("extension_ui_effect", {
        case: "extensionUiEffect",
        value: fromProtoPiExtensionUi(payload.value)
      });
    case "resourceUpdate":
      if (payload.value.resource === undefined) {
        throw new ProtoMappingError("invalid_argument", "event.pi.resource_update.resource", "Pi resource update requires a resource.");
      }
      return corePiMetadata("resource_update", {
        case: "resourceUpdate",
        value: {
          resource: fromProtoPiManagedResource(payload.value.resource),
          updateKind: fromProtoPiEnum(contract.PiResourceUpdateKind, payload.value.updateKind, "unknown")
        }
      });
    case "modelUpdate":
      return corePiMetadata("model_update", {
        case: "modelUpdate",
        value: {
          ...(payload.value.previousModel === undefined ? {} : { previousModel: fromProtoPiModelKey(payload.value.previousModel) }),
          ...(payload.value.model === undefined ? {} : { model: fromProtoPiModelKey(payload.value.model) }),
          thinkingLevel: payload.value.thinkingLevel,
          scopedModel: payload.value.scopedModel,
          contextWindowTokens: safeNumber(payload.value.contextWindowTokens, "event.pi.model_update.context_window_tokens")
        }
      });
    case "diagnostic": {
      const nativeEventType = boundedPiDiagnostic(payload.value.nativeEventType || "unknown", "event.pi.diagnostic.native_event_type", 128);
      return corePiMetadata(nativeEventType, {
        case: "diagnostic",
        value: {
          command: fromProtoPiEnum(contract.PiRpcCommandKind, payload.value.command, "unknown"),
          nativeEventType,
          ...(payload.value.processExitCode === 0 ? {} : { processExitCode: payload.value.processExitCode }),
          ...(payload.value.sanitizedStderrExcerpt === "" ? {} : { sanitizedStderrExcerpt: boundedPiDiagnostic(payload.value.sanitizedStderrExcerpt, "event.pi.diagnostic.sanitized_stderr_excerpt", 2_048) }),
          ...(payload.value.jsonlLineNumber === 0n ? {} : { jsonlLineNumber: safeNumber(payload.value.jsonlLineNumber, "event.pi.diagnostic.jsonl_line_number") }),
          ...(payload.value.parseError === "" ? {} : { parseError: boundedPiDiagnostic(payload.value.parseError, "event.pi.diagnostic.parse_error", 1_024) })
        }
      });
    }
    case undefined:
      throw new ProtoMappingError("invalid_argument", "event.pi.payload", "Pi metadata payload is required.");
    default:
      return assertNeverProtoPiMetadata(payload);
  }
}

type CorePiPayload = CorePiEventMetadata["payload"];
type CorePiQueuedMessage = Extract<CorePiPayload, { readonly case: "queueUpdate" }>["value"]["steering"][number];
type CorePiSessionTree = Extract<CorePiPayload, { readonly case: "sessionTreeUpdate" }>["value"];
type CorePiTreeNode = Extract<CorePiPayload, { readonly case: "sessionTreeUpdate" }>["value"]["roots"][number];
type CorePiSlashCommand = Extract<CorePiPayload, { readonly case: "commandCatalogUpdate" }>["value"]["commands"][number];
type CorePiExtensionUi = Extract<CorePiPayload, { readonly case: "extensionUiEffect" }>["value"];
type CorePiManagedResource = Extract<CorePiPayload, { readonly case: "resourceUpdate" }>["value"]["resource"];

function piMetadata<C extends Exclude<ProtoPiEventMetadata["payload"]["case"], undefined>>(
  caseName: C,
  value: Extract<ProtoPiEventMetadata["payload"], { readonly case: C }>["value"]
): ProtoPiEventMetadata {
  return message<ProtoPiEventMetadata>("joko.v1.PiEventMetadata", {
    payload: { case: caseName, value } as ProtoPiEventMetadata["payload"]
  });
}

function corePiMetadata(
  rpcEventType: string,
  payload: CorePiPayload,
  common: {
    readonly entryId?: string | undefined;
    readonly parentEntryId?: string | undefined;
    readonly leafId?: string | undefined;
    readonly contentIndex?: number | undefined;
    readonly nativeToolName?: string | undefined;
  } = {}
): CorePiEventMetadata {
  return {
    rpcEventType,
    ...(common.entryId === undefined ? {} : { entryId: common.entryId }),
    ...(common.parentEntryId === undefined ? {} : { parentEntryId: common.parentEntryId }),
    ...(common.leafId === undefined ? {} : { leafId: common.leafId }),
    ...(common.contentIndex === undefined ? {} : { contentIndex: common.contentIndex }),
    ...(common.nativeToolName === undefined ? {} : { nativeToolName: common.nativeToolName }),
    payload
  };
}

function protoPiEnum<T extends number>(
  enumeration: Readonly<Record<string, string | number>>,
  value: string,
  fallback: T
): T {
  const candidate = enumeration[value.toUpperCase()];
  return typeof candidate === "number" ? candidate as T : fallback;
}

function fromProtoPiEnum<T extends string>(
  enumeration: Readonly<Record<string | number, string | number>>,
  value: number,
  fallback: T
): T {
  const candidate = enumeration[value];
  return typeof candidate === "string" ? candidate.toLocaleLowerCase() as T : fallback;
}

function unsignedInt32(value: number, fieldPath: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new ProtoMappingError("out_of_range", fieldPath, `${fieldPath} must be a uint32.`);
  }
  return value;
}

function positiveUnsignedInt32(value: number, fieldPath: string): number {
  const bounded = unsignedInt32(value, fieldPath);
  if (bounded === 0) {
    throw new ProtoMappingError("out_of_range", fieldPath, `${fieldPath} must be positive.`);
  }
  return bounded;
}

function signedInt32(value: number, fieldPath: string): number {
  if (!Number.isSafeInteger(value) || value < -0x8000_0000 || value > 0x7fff_ffff) {
    throw new ProtoMappingError("out_of_range", fieldPath, `${fieldPath} must be an int32.`);
  }
  return value;
}

function boundedPiDiagnostic(value: string, _fieldPath: string, maximumCharacters: number): string {
  const sanitized = redactSecrets(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "�");
  return [...sanitized].slice(0, maximumCharacters).join("");
}

function requiredProtoTimestamp(value: ProtoTimestamp, fieldPath: string): number {
  const mapped = fromProtoTimestamp(value, fieldPath);
  if (mapped === undefined) throw new ProtoMappingError("invalid_argument", fieldPath, `${fieldPath} is required.`);
  return mapped;
}

function toProtoPiModelKey(value: { readonly providerId: string; readonly modelId: string }): contract.ModelKey {
  return message<contract.ModelKey>("joko.v1.ModelKey", {
    providerId: value.providerId,
    modelId: value.modelId
  });
}

function fromProtoPiModelKey(value: contract.ModelKey): { readonly providerId: string; readonly modelId: string } {
  return { providerId: value.providerId, modelId: value.modelId };
}

function toProtoPiQueuedMessage(value: CorePiQueuedMessage): contract.PiQueuedMessage {
  return message<contract.PiQueuedMessage>("joko.v1.PiQueuedMessage", {
    nativeQueueId: value.nativeQueueId,
    textPreview: value.textPreview,
    imageCount: unsignedInt32(value.imageCount, "event.pi.queue_update.image_count"),
    queuedAt: value.queuedAt === undefined ? undefined : toProtoTimestamp(value.queuedAt)
  });
}

function fromProtoPiQueuedMessage(value: contract.PiQueuedMessage): CorePiQueuedMessage {
  return {
    nativeQueueId: value.nativeQueueId,
    textPreview: value.textPreview,
    imageCount: value.imageCount,
    ...(value.queuedAt === undefined ? {} : { queuedAt: requiredProtoTimestamp(value.queuedAt, "event.pi.queue_update.queued_at") })
  };
}

function toProtoPiSessionTreeUpdate(value: CorePiSessionTree): contract.PiSessionTreeUpdate {
  const nestedRoots = toProtoPiSessionTreeNodes(value.roots);
  try {
    return message<contract.PiSessionTreeUpdate>("joko.v1.PiSessionTreeUpdate", {
      nativeSessionId: value.nativeSessionId,
      activeLeafId: value.activeLeafId,
      ...contract.piSessionTreeWireFields(nestedRoots)
    });
  } catch (error) {
    throw piTreeWireMappingError(error);
  }
}

function materializedPiSessionTreeRoots(
  value: contract.PiSessionTreeUpdate
): contract.PiSessionTreeNestedNode[] {
  try {
    return contract.piSessionTreeRoots(value);
  } catch (error) {
    throw piTreeWireMappingError(error);
  }
}

function piTreeWireMappingError(error: unknown): ProtoMappingError {
  if (error instanceof contract.ProtobufTreeWireError) {
    return new ProtoMappingError(
      "invalid_argument",
      "event.pi.session_tree_update.roots",
      error.message
    );
  }
  throw error;
}

function toProtoPiSessionTreeNodes(values: readonly CorePiTreeNode[]): contract.PiSessionTreeNestedNode[] {
  return mapPiSessionTreeNodes(values, (value, children) =>
    ({
      ...message<contract.PiSessionTreeNode>("joko.v1.PiSessionTreeNode", {
        entryId: value.entryId,
        parentId: value.parentId,
        kind: protoPiEnum(contract.PiSessionEntryKind, value.kind, contract.PiSessionEntryKind.UNSPECIFIED),
        role: value.role,
        textPreview: value.textPreview,
        branchSummary: value.branchSummary,
        createdAt: value.createdAt === undefined ? undefined : toProtoTimestamp(value.createdAt),
        active: value.active,
        childCount: 0
      }),
      children
    })
  );
}

function fromProtoPiSessionTreeNodes(values: readonly contract.PiSessionTreeNestedNode[]): CorePiTreeNode[] {
  return mapPiSessionTreeNodes(values, (value, children) => ({
      entryId: value.entryId,
      parentId: value.parentId,
      kind: fromProtoPiEnum(contract.PiSessionEntryKind, value.kind, "unknown"),
      role: value.role,
      textPreview: value.textPreview,
      branchSummary: value.branchSummary,
      ...(value.createdAt === undefined ? {} : { createdAt: requiredProtoTimestamp(value.createdAt, "event.pi.session_tree_update.node.created_at") }),
      active: value.active,
      children
    })
  );
}

function mapPiSessionTreeNodes<
  Source extends { readonly entryId: string; readonly children: readonly Source[] },
  Output
>(
  values: readonly Source[],
  project: (value: Source, children: Output[]) => Output
): Output[] {
  const roots: Output[] = [];
  const seenNodes = new Set<object>();
  const seenEntryIds = new Set<string>();
  const stack: Array<{
    readonly value: Source;
    readonly output: Output[];
    readonly mappedChildren?: Output[];
  }> = [];
  for (let index = values.length - 1; index >= 0; index -= 1) {
    stack.push({ value: values[index]!, output: roots });
  }
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.mappedChildren !== undefined) {
      frame.output.push(project(frame.value, frame.mappedChildren));
      continue;
    }
    const value = frame.value;
    if (
      typeof value !== "object" ||
      value === null ||
      typeof value.entryId !== "string" ||
      value.entryId.length === 0 ||
      !Array.isArray(value.children)
    ) {
      throw new ProtoMappingError(
        "invalid_argument",
        "event.pi.session_tree_update.roots",
        "Pi Session tree contains an invalid node."
      );
    }
    if (seenNodes.has(value) || seenEntryIds.has(value.entryId)) {
      throw new ProtoMappingError(
        "invalid_argument",
        "event.pi.session_tree_update.roots",
        "Pi Session tree contains a cycle or repeated entry."
      );
    }
    seenNodes.add(value);
    seenEntryIds.add(value.entryId);
    const mappedChildren: Output[] = [];
    stack.push({ ...frame, mappedChildren });
    for (let index = value.children.length - 1; index >= 0; index -= 1) {
      stack.push({ value: value.children[index]!, output: mappedChildren });
    }
  }
  return roots;
}

function toProtoPiSlashCommand(value: CorePiSlashCommand): contract.PiSlashCommand {
  return message<contract.PiSlashCommand>("joko.v1.PiSlashCommand", {
    name: value.name,
    description: value.description,
    source: protoPiEnum(contract.PiCommandSource, value.source, contract.PiCommandSource.UNSPECIFIED),
    sourceInfo: message<contract.PiSourceInfo>("joko.v1.PiSourceInfo", {
      resourceId: value.sourceInfo.resourceId,
      scope: protoPiEnum(contract.ResourceScope, value.sourceInfo.scope, contract.ResourceScope.UNSPECIFIED),
      sourceDisplay: value.sourceInfo.sourceDisplay,
      packageName: value.sourceInfo.packageName
    })
  });
}

function fromProtoPiSlashCommand(value: contract.PiSlashCommand): CorePiSlashCommand {
  const source = value.sourceInfo;
  return {
    name: value.name,
    description: value.description,
    source: fromProtoPiEnum(contract.PiCommandSource, value.source, "unknown"),
    sourceInfo: {
      resourceId: source?.resourceId ?? "",
      scope: fromProtoPiEnum(contract.ResourceScope, source?.scope ?? contract.ResourceScope.UNSPECIFIED, "unknown"),
      sourceDisplay: source?.sourceDisplay ?? "",
      packageName: source?.packageName ?? ""
    }
  };
}

function toProtoPiExtensionUi(value: CorePiExtensionUi): contract.PiExtensionUiEffect {
  let effect: contract.PiExtensionUiEffect["effect"];
  switch (value.effect.case) {
    case "notify":
      effect = {
        case: "notify",
        value: message<contract.PiExtensionNotify>("joko.v1.PiExtensionNotify", {
          message: value.effect.value.message,
          kind: protoPiEnum(contract.PiNotificationKind, value.effect.value.kind, contract.PiNotificationKind.UNSPECIFIED)
        })
      };
      break;
    case "status":
      effect = {
        case: "status",
        value: message<contract.PiExtensionStatus>("joko.v1.PiExtensionStatus", {
          statusKey: value.effect.value.statusKey,
          statusText: value.effect.value.statusText
        })
      };
      break;
    case "widget":
      effect = {
        case: "widget",
        value: message<contract.PiExtensionWidget>("joko.v1.PiExtensionWidget", {
          widgetKey: value.effect.value.widgetKey,
          lines: [...value.effect.value.lines],
          placement: protoPiEnum(contract.PiWidgetPlacement, value.effect.value.placement, contract.PiWidgetPlacement.UNSPECIFIED),
          removed: value.effect.value.removed
        })
      };
      break;
    case "title":
      effect = { case: "title", value: message<contract.PiExtensionTitle>("joko.v1.PiExtensionTitle", { title: value.effect.value.title }) };
      break;
    case "editorText":
      effect = { case: "editorText", value: message<contract.PiExtensionEditorText>("joko.v1.PiExtensionEditorText", { text: value.effect.value.text }) };
      break;
    default:
      return assertNeverPiExtension(value.effect);
  }
  return message<contract.PiExtensionUiEffect>("joko.v1.PiExtensionUiEffect", {
    requestId: value.requestId,
    extensionId: value.extensionId,
    effect
  });
}

function fromProtoPiExtensionUi(value: contract.PiExtensionUiEffect): CorePiExtensionUi {
  const common = { requestId: value.requestId, extensionId: value.extensionId };
  switch (value.effect.case) {
    case "notify":
      return { ...common, effect: { case: "notify", value: { message: value.effect.value.message, kind: fromProtoPiEnum(contract.PiNotificationKind, value.effect.value.kind, "unknown") } } };
    case "status":
      return { ...common, effect: { case: "status", value: { statusKey: value.effect.value.statusKey, ...(value.effect.value.statusText === undefined ? {} : { statusText: value.effect.value.statusText }) } } };
    case "widget":
      return { ...common, effect: { case: "widget", value: { widgetKey: value.effect.value.widgetKey, lines: [...value.effect.value.lines], placement: fromProtoPiEnum(contract.PiWidgetPlacement, value.effect.value.placement, "unknown"), removed: value.effect.value.removed } } };
    case "title":
      return { ...common, effect: { case: "title", value: { title: value.effect.value.title } } };
    case "editorText":
      return { ...common, effect: { case: "editorText", value: { text: value.effect.value.text } } };
    case undefined:
      throw new ProtoMappingError("invalid_argument", "event.pi.extension_ui_effect.effect", "Pi extension UI effect is required.");
    default:
      return assertNeverProtoPiExtension(value.effect);
  }
}

function toProtoPiManagedResource(value: CorePiManagedResource): contract.ManagedResource {
  return message<contract.ManagedResource>("joko.v1.ManagedResource", {
    resourceId: value.resourceId,
    backendId: value.backendId,
    targetId: value.targetId,
    kind: protoPiEnum(contract.ResourceKind, value.kind, contract.ResourceKind.UNSPECIFIED),
    name: value.name,
    version: value.version,
    source: message<contract.ResourceSource>("joko.v1.ResourceSource", {
      scope: protoPiEnum(contract.ResourceScope, value.source.scope, contract.ResourceScope.UNSPECIFIED),
      sourceDisplay: value.source.sourceDisplay,
      canonicalPathFingerprint: value.source.canonicalPathFingerprint,
      symbolicLinkDetected: value.source.symbolicLinkDetected,
      specialFileDetected: value.source.specialFileDetected,
      acquisitionKind: contract.ResourceAcquisitionKind.UNSPECIFIED,
      sourceIdentity: ""
    }),
    state: protoPiEnum(contract.ResourceState, value.state, contract.ResourceState.UNSPECIFIED),
    enabled: value.enabled,
    approvedAt: value.approvedAt === undefined ? undefined : toProtoTimestamp(value.approvedAt),
    approvedByConnectionId: value.approvedByConnectionId,
    entityVersion: toProtoEntityVersion(BigInt(value.revision), value.generation, value.updatedAt),
    error: value.error === undefined ? undefined : toProtoErrorInfo(value.error),
    discoveredRevision: value.discoveredRevision,
    compatibilityDetails: [],
    runtimeRequirements: [],
    warnings: [],
    disabledLifecycleScripts: [],
    canToggle: true,
    requiresExtensionApproval: false,
    extensionContentFingerprint: "",
    postMutationNotice: false
  });
}

function fromProtoPiManagedResource(value: contract.ManagedResource): CorePiManagedResource {
  if (value.source === undefined) {
    throw new ProtoMappingError("invalid_argument", "event.pi.resource_update.resource.source", "Pi resource source is required.");
  }
  if (value.entityVersion === undefined) {
    throw new ProtoMappingError("invalid_argument", "event.pi.resource_update.resource.entity_version", "Pi resource entity version is required.");
  }
  return {
    resourceId: value.resourceId,
    backendId: value.backendId,
    targetId: value.targetId,
    kind: fromProtoPiEnum(contract.ResourceKind, value.kind, "unknown"),
    name: value.name,
    version: value.version,
    source: {
      scope: fromProtoPiEnum(contract.ResourceScope, value.source.scope, "unknown"),
      sourceDisplay: value.source.sourceDisplay,
      canonicalPathFingerprint: value.source.canonicalPathFingerprint,
      symbolicLinkDetected: value.source.symbolicLinkDetected,
      specialFileDetected: value.source.specialFileDetected
    },
    state: fromProtoPiEnum(contract.ResourceState, value.state, "unknown"),
    enabled: value.enabled,
    ...(value.approvedAt === undefined ? {} : { approvedAt: requiredProtoTimestamp(value.approvedAt, "event.pi.resource_update.resource.approved_at") }),
    approvedByConnectionId: value.approvedByConnectionId,
    revision: safeNumber(fromProtoRevision(value.entityVersion.revision, "event.pi.resource_update.resource.entity_version.revision"), "event.pi.resource_update.resource.entity_version.revision"),
    generation: safeNumber(value.entityVersion.generation, "event.pi.resource_update.resource.entity_version.generation"),
    updatedAt: value.entityVersion.updatedAt === undefined ? 0 : requiredProtoTimestamp(value.entityVersion.updatedAt, "event.pi.resource_update.resource.entity_version.updated_at"),
    discoveredRevision: value.discoveredRevision,
    ...(value.error === undefined ? {} : { error: fromProtoErrorInfo(value.error) })
  };
}

function assertNeverPiMetadata(value: never): never {
  throw new ProtoMappingError("invalid_argument", "event.pi.payload", `Unsupported core Pi metadata payload: ${String(value)}`);
}

function assertNeverProtoPiMetadata(value: never): never {
  throw new ProtoMappingError("invalid_argument", "event.pi.payload", `Unsupported protobuf Pi metadata payload: ${String(value)}`);
}

function assertNeverPiExtension(value: never): never {
  throw new ProtoMappingError("invalid_argument", "event.pi.extension_ui_effect.effect", `Unsupported core Pi extension effect: ${String(value)}`);
}

function assertNeverProtoPiExtension(value: never): never {
  throw new ProtoMappingError("invalid_argument", "event.pi.extension_ui_effect.effect", `Unsupported protobuf Pi extension effect: ${String(value)}`);
}

function fromStatusPayload(value: StatusStreamEvent): EventPayload {
  return { type: "status", key: value.statusId || value.label, ...(value.detail === "" ? {} : { text: value.detail }) };
}

function missingPayload(fieldPath: string): ProtoMappingError {
  return new ProtoMappingError("invalid_argument", fieldPath, `${fieldPath} is required.`);
}
