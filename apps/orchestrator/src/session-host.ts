import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type {
  AdapterContext,
  ApprovedDirectory,
  BackendAdapter,
  BackendDescriptor,
  BlobRef,
  ContextRebuildInput,
  DurableNativeDispatchPreparation,
  EventPayload,
  InteractionDecision,
  InteractionPayload,
  NativeSessionBinding,
  NativeSessionCandidate,
  NativeSessionCatalogEntry,
  NativeSessionCatalogResult,
  NativeSessionForkResult,
  NativeHistoryProjection,
  NativeSessionState,
  NativeSessionStart,
  MessageAutomationOrigin,
  MessageBlock,
  MessageInputDelivery,
  PermissionMode,
  PromptInput,
  PublicError,
  RuntimeCommand,
  RuntimeToolCatalog,
  SessionDescriptor,
  SubagentControlInput,
  SubagentRunDetail,
  TargetDescriptor,
  TurnExecutionOverrides,
  UserShellInput,
  UserShellResult,
  UsageSnapshot
} from "@joko/core";
import { JokoError, decideToolCall, nativeHistoryEventContext, redactSecrets, toPublicError, validInlineTextRanges, type ToolRisk } from "@joko/core";
import {
  AuthorizationError,
  InvalidStateTransitionError,
  OperationConflictError,
  OperationPreviouslyFailedError,
  RevisionConflictError,
  StoreError,
  StaleGenerationError
} from "@joko/store";
import type {
  ConnectionRecord,
  OperationExecution,
  OperationalStore,
  PendingContextRebuild,
  PersistedEvent,
  QueueItemRecord,
  ScheduleRecord,
  StoredTarget,
  StoredSession
} from "@joko/store";
import { operationBodyHash } from "@joko/store";
import type { ArtifactStore } from "./artifact-store.js";
import { ExtraDirectoryManager } from "./extra-directory-manager.js";
import { TIMED_EXTENSION_INTERACTION_EXPIRED_REASON } from "./interaction-expiry.js";
import {
  EXTENSION_STATUSES_SETTING_KEY,
  EXTENSION_WIDGETS_SETTING_KEY,
  updateExtensionStatuses,
  updateExtensionWidgets
} from "./extension-ui-state.js";
import {
  bindNativeHistoryEventMetadata,
  NATIVE_HISTORY_BINDING_FINGERPRINT_FIELD,
  projectNativeHistory
} from "./native-history.js";
import {
  markNativeStateObservationStale as staleNativeStateObservation,
  materializedNativeStateObservation,
  nativeBindingFingerprint,
  nativeStateObservation,
  SESSION_NATIVE_STATE_OBSERVATION_SETTING_KEY
} from "./native-state-observation.js";
import {
  materializedSessionRuntimeState,
  mergeMaterializedSessionRuntimeState,
  SESSION_RUNTIME_STATE_SETTING_KEY
} from "./session-runtime-state.js";
import {
  materializedRuntimeCommands,
  normalizeRuntimeCommands,
  runtimeCommandsObservation,
  sameRuntimeCommands,
  SESSION_RUNTIME_COMMANDS_SETTING_KEY
} from "./runtime-command-state.js";
import { activeNativeTimeline } from "./snapshot-projector.js";
import { policySnapshotFor } from "./policy-settings.js";
import { clearProviderRateLimit, recordProviderRateLimit } from "./provider-rate-limit.js";
import type { CreateFreshReviewerInput, ReviewRuntimeDispatch, ReviewRuntimeOutcome } from "./review-coordinator.js";
import type { ScheduleRunNotificationController } from "./schedule-run-notifications.js";
import {
  SCHEDULED_WORKTREE_OWNER_SETTING_KEY,
  type SessionWorktreeCoordinator
} from "./session-worktree-coordinator.js";
import {
  buildPortableSessionExport,
  materializePortableSessionImport,
  preparePortableSessionImport,
  type PortableSessionExportBuild,
  type PreparedPortableSessionImport
} from "./portable-session-transfer.js";
import { MAXIMUM_PORTABLE_SESSION_WORKERS, PortableSessionPackageError } from "./portable-session-package.js";
import {
  MAXIMUM_PORTABLE_SESSION_MESSAGES,
  PortableSessionProjectionError
} from "./portable-session-projection.js";
import {
  listAllInteractions,
  listAllQueueItems,
  listAllRuns,
  listAllVisibleSessionEvents,
  visitSessionEventsIncludingTombstones,
  visitVisibleSessionEvents
} from "./operational-pagination.js";
import {
  SessionRuntimeControlRegistry,
  applySessionRuntimeAxisPatch,
  pickSessionRuntimeFallback,
  resolveCompatibleSessionRuntimeAxisPatch,
  resolveSessionRuntimeProfile,
  sessionRuntimeBaseline,
  type SessionRuntimeAxisPatch,
  type SessionRuntimeControlSnapshot,
  type SessionRuntimeMutationSource,
  type SessionRuntimePatch,
  type SessionRuntimeProfile
} from "./session-runtime-control.js";
import {
  isSafeSessionRuntimeRecoveryError,
  SESSION_RUNTIME_RECOVERY_MAX_CONSECUTIVE_ATTEMPTS,
  SESSION_RUNTIME_RECOVERY_MAX_EPISODE_ATTEMPTS,
  sessionRuntimeRecoveryDelayMs
} from "./session-runtime-recovery.js";

const MAXIMUM_APPEND_SYSTEM_PROMPT_CHARACTERS = 8_000;
const SESSION_COMPACTION_QUEUE_SETTING_KEY = "runtime.compaction.dispatch.queue";
const SESSION_NATIVE_DISPATCH_RECOVERY_SETTING_KEY = "native.dispatch.recovery";
const PORTABLE_IMPORT_SOURCE_SETTING_KEY = "portable.import.source";
const PORTABLE_IMPORT_ACTIVATION_SETTING_KEY = "portable.import.activation";
const PORTABLE_IMPORT_DRAFT_TTL_MS = 10 * 60 * 1_000;
const MAXIMUM_PORTABLE_IMPORT_DRAFTS = 128;
const NATIVE_SESSION_CATALOG_TTL_MS = 30_000;
const NATIVE_SESSION_CATALOG_SNAPSHOT_TTL_MS = 10 * 60_000;
const MAXIMUM_NATIVE_SESSION_CATALOG_SNAPSHOTS = 32;
const DEFAULT_RUN_SILENCE_TIMEOUT_MS = 45 * 60_000;
const DEFAULT_BACKEND_RETIREMENT_TIMEOUT_MS = 10_000;
const RUN_SILENCE_WATCHDOG_SLICE_MS = 60_000;
const RUN_SILENCE_SUSPEND_GAP_MS = 30_000;
const SESSION_RUNTIME_USAGE_SOURCE_ID = "session-runtime";

interface ActiveSession {
  readonly adapter: BackendAdapter;
  readonly sessionId: string;
  /** Exact Backend process instance that owns this native runtime handle. */
  readonly backendInstanceGeneration: number;
  lastActivityAt: number;
}

interface ActiveBackendSideEffectLease {
  readonly sessionId: string;
  readonly backendId: string;
  readonly active: ActiveSession;
  readonly stored: StoredSession;
  readonly productGeneration: number;
  readonly backendInstanceGeneration: number;
  readonly context: AdapterContext;
  readonly release: () => void;
}

interface BackendSideEffectAdmissionAllowance {
  readonly backendReplacement?: boolean;
  readonly runtimeRestart?: boolean;
  readonly sessionReset?: boolean;
  readonly lifecycleOperationId?: string;
}

interface NativeSessionCatalogFlight {
  readonly adapterGeneration: number;
  readonly force: boolean;
  readonly epoch: number;
  readonly promise: Promise<NativeSessionCatalogCacheEntry>;
}

interface NativeSessionCatalogCacheEntry {
  readonly adapterGeneration: number;
  readonly scanEpoch: number;
  readonly scannedAt: number;
  readonly result: NativeSessionCatalogResult;
}

interface NativeSessionCatalogSnapshot {
  readonly token: string;
  readonly result: NativeSessionCatalogResult;
  readonly existingCount: number;
  readonly scanEpoch: number;
}

interface RetainedNativeSessionCatalogSnapshot extends NativeSessionCatalogSnapshot {
  readonly backendId: string;
  readonly adapterGeneration: number;
  readonly scannedAt: number;
}

interface PendingInteraction {
  readonly sessionId: string;
  readonly generation: number;
  readonly backendInstanceGeneration: number;
  readonly runId?: string;
  readonly attemptId?: string;
  readonly resolve: (decision: InteractionDecision) => void;
  readonly expiryTimer?: ReturnType<typeof setTimeout>;
  readonly abortSignal?: AbortSignal;
  readonly abortListener?: () => void;
}

interface RunSilenceWatchdog {
  readonly sessionId: string;
  readonly generation: number;
  remainingMs: number;
  sliceStartedAt: number;
  timer?: ReturnType<typeof setTimeout>;
}

interface PendingDispatchAcceptance {
  settlement?: "completed" | "aborted" | "failed";
}

interface NativeDispatchRecoveryBaseline {
  readonly format: 1;
  readonly phase: "prepared" | "accepted";
  readonly runId: string;
  readonly queueItemId: string;
  readonly attemptId: string;
  readonly operationId: string;
  readonly disposition: "prompt" | "steer" | "follow_up";
  readonly generation: number;
  readonly backendInstanceGeneration: number;
  readonly bindingFingerprint: string;
  readonly projectionCount: number;
  readonly projectionDigest: string;
  readonly lineageCount: number;
  readonly lineageDigest: string;
  readonly inputBodyHash: string;
  readonly inputFingerprint: string;
  readonly activeEntryId?: string;
  readonly recordedAt: number;
}

interface NativeDispatchRecoveryJournal {
  readonly format: 1;
  readonly entries: readonly NativeDispatchRecoveryBaseline[];
}

interface NativeDispatchRecoveryCompletion {
  readonly baseline: NativeDispatchRecoveryBaseline;
  readonly outcome: "completed" | "aborted" | "failed";
  readonly nativeEntryIds: ReadonlySet<string>;
}

interface ReviewRuntimeFlight {
  readonly accepted: Promise<void>;
  readonly accept: () => void;
  readonly rejectAcceptance: (error: Error) => void;
  readonly promise: Promise<ReviewRuntimeOutcome>;
  readonly resolve: (outcome: ReviewRuntimeOutcome) => void;
  readonly text: string[];
  hasCompleteMessage: boolean;
  settled: boolean;
}

interface DispatchPreparation {
  readonly settled: Promise<void>;
  readonly resolve: () => void;
  phase: "pre-send" | "sending";
}

interface CompactionQueueWindow {
  readonly generation: number;
  readonly startedAt: number;
  readonly baselineQueueItemIds: Set<string>;
  readonly heldQueueItemIds: Set<string>;
  eventStarted: boolean;
  willRetry: boolean;
}

interface ExplicitCompactionFlight {
  readonly instructions: string | undefined;
  promise: Promise<"compacted" | "noop">;
}

type CompactionDispatchDecision =
  | { readonly kind: "normal" }
  | { readonly kind: "blocked" }
  | { readonly kind: "bypass"; readonly queueItemId: string };

interface UserShellLease {
  readonly active: ActiveSession;
  readonly generation: number;
  readonly context: AdapterContext;
  readonly task: Promise<UserShellResult>;
  abortTask?: Promise<void>;
}

interface UserShellRequestFlight {
  readonly settled: Promise<void>;
  readonly resolve: () => void;
}

interface TrackedBackgroundTask {
  readonly taskId: string;
  readonly parentTaskId?: string;
  readonly title: string;
  readonly progressRatio?: number;
  readonly startedAt?: number;
  readonly generation: number;
  readonly runId?: string;
  readonly attemptId?: string;
  readonly operationId?: string;
}

interface TurnOverrideLease {
  readonly runId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly effort?: string;
  readonly fastMode: boolean;
  readonly permissionMode: PermissionMode;
  readonly planMode: boolean;
  readonly modelChanged: boolean;
  readonly effortChanged: boolean;
  readonly fastModeChanged: boolean;
  readonly permissionModeChanged: boolean;
  readonly planModeChanged: boolean;
  readonly extraDirectories: readonly ApprovedDirectory[];
  readonly extraDirectoriesChanged: boolean;
}

interface RuntimeProfileChanges {
  readonly model: boolean;
  readonly effort: boolean;
  readonly effortClear: boolean;
  readonly fastMode: boolean;
}

interface MessageDeletionPlan {
  readonly requestedEventId: string;
  readonly deletedEventIds: readonly string[];
}

interface SessionResetPreparation {
  readonly active: ActiveSession;
  readonly sourceBinding: NativeSessionBinding;
  readonly context: AdapterContext;
}

interface ScheduledWorktreeOwner {
  readonly format: 1;
  readonly scheduleId: string;
  readonly runId: string;
  readonly leaseId: string;
  readonly phase: "creating" | "admitted";
  readonly createdAt: number;
}

interface ContextRecoveryTrigger {
  readonly reason: "context_overflow" | "prompt_timeout";
  readonly operationId: string;
  readonly runId: string;
  readonly queueItemId: string;
  readonly sourceInputPending: boolean;
  readonly replaySafe: boolean;
}

interface PortableImportDraft {
  readonly id: string;
  readonly connectionId: string;
  readonly authKeyDigest: string;
  readonly package: BlobRef;
  readonly encrypted: boolean;
  createdAt: number;
  expiresAt: number;
  prepared?: PreparedPortableSessionImport;
}

interface PortableImportActivationRecord {
  readonly format: 1;
  readonly status: "ready" | "imported_activation_failed";
  readonly error?: PublicError;
  readonly updatedAt: number;
}

export interface CreateSessionInput {
  readonly operationId: string;
  readonly connection: ConnectionRecord;
  readonly targetId: string;
  readonly title: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly effort?: string;
  readonly fastMode: boolean;
  readonly permissionMode: PermissionMode;
  readonly planMode: boolean;
  /** Private creation snapshot; attached native tasks always ignore it. */
  readonly appendSystemPrompt?: string;
  readonly nativeStart?: NativeSessionStart;
  readonly initialPlacement?: "project" | "dialogue";
  readonly catalogImport?: {
    readonly projectId?: string;
    readonly archived: boolean;
    readonly createdAt: number;
    readonly modifiedAt: number;
    readonly snapshotToken: string;
  };
  readonly worktree?: { readonly sourceRef?: string; readonly refreshRemote: boolean };
}

export interface CreateScheduledSessionInput {
  readonly operationId: string;
  readonly targetId: string;
  readonly title: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly effort?: string;
  readonly fastMode: boolean;
  readonly permissionMode: PermissionMode;
  readonly planMode: boolean;
  readonly appendSystemPrompt?: undefined;
  readonly nativeStart?: undefined;
  readonly catalogImport?: undefined;
  readonly worktree?: { readonly sourceRef?: string; readonly refreshRemote: boolean };
  readonly automationOrigin: {
    readonly scheduleId: string;
    readonly scheduleName?: string;
    readonly runId: string;
    readonly scheduleRevision: bigint;
  };
  /** Durable owner fence for a Scheduler-only ephemeral worktree. */
  readonly worktreeOwner?: { readonly scheduleId: string; readonly runId: string };
}

/** Service-owned creation for a normal visible Session handoff. Unlike a
 * scheduled Session this has no ephemeral-worktree owner and survives after
 * its first queued message settles. */
export interface CreateServiceSessionInput {
  readonly operationId: string;
  readonly serviceKind: "session_handoff";
  readonly targetId: string;
  readonly title: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly effort?: string;
  readonly fastMode: boolean;
  readonly permissionMode: PermissionMode;
  readonly planMode: boolean;
  readonly appendSystemPrompt?: undefined;
  readonly nativeStart?: undefined;
  readonly catalogImport?: undefined;
  readonly worktree?: { readonly sourceRef?: string; readonly refreshRemote: boolean };
}

type SessionCreationInput = CreateSessionInput | CreateScheduledSessionInput | CreateServiceSessionInput;

export interface EnqueueResult {
  readonly sessionId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly queueItemId: string;
}

export interface DeriveSessionInput {
  readonly operationId: string;
  readonly connection: ConnectionRecord;
  readonly sourceSessionId: string;
  readonly title: string;
  readonly entryId?: string;
  readonly kind: "fork" | "clone";
  readonly sourceMessage?: {
    readonly messageId: string;
    readonly eventId: string;
  };
}

export interface WorkspaceRunCapture {
  captureBeforeRun(input: { readonly sessionId: string; readonly runId: string; readonly target: TargetDescriptor; readonly nativeLeafId?: string }): Promise<void>;
  captureAfterRun(input: { readonly sessionId: string; readonly runId: string; readonly target: TargetDescriptor }): Promise<void>;
  abortRun?(input: { readonly sessionId: string; readonly runId: string }): void;
  closeSession?(sessionId: string): Promise<void>;
}

export interface ExportPortableSessionInput {
  readonly sessionId: string;
  /** Transient secret. It is never written to an Operation, Event, Setting, or diagnostic. */
  readonly password?: string;
  readonly excludeMedia?: boolean;
  readonly applicationVersion?: string;
}

export interface ExportPortableSessionResult extends Omit<PortableSessionExportBuild, "bytes"> {
  readonly artifact: BlobRef;
}

export interface ImportPortableSessionInput {
  readonly operationId: string;
  readonly connection: ConnectionRecord;
  readonly targetId: string;
  readonly package: BlobRef;
  /** Transient secret. It is excluded from the canonical Operation body. */
  readonly password?: string;
  readonly title?: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly effort?: string;
  readonly fastMode: boolean;
  readonly permissionMode: PermissionMode;
  readonly planMode: boolean;
  readonly overwrite: boolean;
  readonly worktree?: { readonly sourceRef?: string; readonly refreshRemote: boolean };
}

export interface ImportPortableSessionResult {
  readonly sessionId: string;
  readonly fidelity: "full" | "partial" | "product_only";
  readonly messageCount: number;
  readonly mediaCount: number;
  readonly workerCount: number;
  readonly replacedSessionIds: readonly string[];
  readonly status: "ready" | "imported_activation_failed";
  readonly activationError?: PublicError;
}

export interface RetryPortableSessionActivationResult {
  readonly sessionId: string;
  readonly status: "ready" | "imported_activation_failed";
  readonly activationError?: PublicError;
}

export interface PortableSessionImportPreview {
  readonly title: string;
  readonly workspaceKind: "dialogue" | "project";
  readonly exportedAt: string;
  readonly applicationVersion: string;
  readonly formatVersion: 1;
  readonly backendCapability: string;
  readonly fidelity: "full" | "partial" | "product_only";
  readonly messageCount: number;
  readonly mediaCount: number;
  readonly workerCount: number;
  readonly nativeHistory: boolean;
}

export interface PortableSessionImportDraftResult {
  readonly draftId: string;
  readonly expiresAt: number;
  readonly encrypted: boolean;
  readonly passwordRequired: boolean;
  readonly preview?: PortableSessionImportPreview;
}

export interface CommitPortableSessionDraftInput extends Omit<ImportPortableSessionInput, "package" | "password"> {
  readonly draftId: string;
}

export interface EnqueueServiceInput {
  readonly operationId: string;
  readonly sessionId: string;
  readonly prompt: PromptInput;
  readonly source: "schedule" | "system";
  readonly parentRunId?: string;
  /** Durable non-secret ownership fence for cross-Session helper messages. */
  readonly originSessionId?: string;
  readonly overrides?: TurnExecutionOverrides;
}

export type SessionRuntimeControlErrorCode = "CONFLICT" | "INVALID_ARGS" | "ROUTE_UNAVAILABLE";

export class SessionRuntimeControlError extends Error {
  constructor(readonly code: SessionRuntimeControlErrorCode, message: string) {
    super(message);
    this.name = "SessionRuntimeControlError";
  }
}

export interface SessionRuntimeMutationResult {
  readonly status: "applied" | "deferred";
  readonly generation: number;
  readonly effective: SessionRuntimeProfile;
  readonly pending?: SessionRuntimeControlSnapshot["pending"];
}

interface SessionRuntimeRecoveryState {
  token: number;
  consecutiveAttempts: number;
  episodeAttempts: number;
  totalAttempts: number;
  rootRunId: string;
  currentRunId?: string;
  timer?: ReturnType<typeof setTimeout>;
  current?: {
    readonly recoveryId: string;
    readonly sourceRunId: string;
    readonly attempt: number;
    readonly delayMs: number;
    readonly error: PublicError;
    continuationRunId?: string;
    routeChanged?: boolean;
  };
}

export type SessionRuntimeActivityKind =
  | "run"
  | "queue_dispatch"
  | "interaction"
  | "tool_lease"
  | "background_task"
  | "compaction"
  | "user_shell"
  | "session_lifecycle"
  | "review"
  | "operation";

export interface BackendInstanceReplacementHooks {
  /** Validate the candidate and detach every active idle runtime from the exact old instance. */
  readonly preparePrevious: (adapter: BackendAdapter, generation: number) => Promise<void>;
  /** Install the prevalidated, durably published candidate without yielding or throwing. */
  readonly activateCurrent: () => void;
}

export class SessionHost {
  readonly #store: OperationalStore;
  readonly #artifactStore: ArtifactStore;
  readonly #adapters = new Map<string, BackendAdapter>();
  readonly #adapterGenerations = new Map<string, number>();
  readonly #initialBackendDescriptors = new Map<string, BackendDescriptor>();
  readonly #active = new Map<string, ActiveSession>();
  readonly #activating = new Map<string, Promise<ActiveSession>>();
  readonly #nativeSessionCatalogFlights = new Map<string, NativeSessionCatalogFlight>();
  readonly #nativeSessionCatalogCache = new Map<string, NativeSessionCatalogCacheEntry>();
  readonly #nativeSessionCatalogSnapshots = new Map<string, RetainedNativeSessionCatalogSnapshot>();
  readonly #nativeSessionCatalogEpochs = new Map<string, number>();
  readonly #nativeSessionCatalogConsumedEpochs = new Map<string, Map<string, number>>();
  readonly #closeIfActiveFlights = new Map<string, Promise<void>>();
  readonly #runtimeRestartFlights = new Map<string, Promise<void>>();
  readonly #runtimeRestartFences = new Set<string>();
  readonly #backendReplacementFences = new Map<string, symbol>();
  readonly #backendAdmissionEffects = new Map<string, number>();
  /** Admission ownership held from an authenticated lifecycle claim through its final Store commit. */
  readonly #sessionLifecycleFences = new Map<string, string>();
  readonly #sessionLifecycleBackendAdmissions = new Map<string, {
    readonly backendId: string;
    readonly operationId: string;
    readonly release: () => void;
  }>();
  readonly #draining = new Set<string>();
  readonly #drainSettlements = new Map<string, Promise<void>>();
  readonly #pendingInteractions = new Map<string, PendingInteraction>();
  readonly #pendingDispatchAcceptances = new Map<string, PendingDispatchAcceptance>();
  readonly #dispatchPreparations = new Map<string, DispatchPreparation>();
  readonly #creationLocks = new Map<string, {
    readonly bodyHash: string;
    readonly connectionId: string;
    readonly authKeyDigest: string;
    readonly task: Promise<OperationExecution<{ readonly sessionId: string }>>;
  }>();
  readonly #portableImportLocks = new Map<string, {
    readonly bodyHash: string;
    readonly connectionId: string;
    readonly authKeyDigest: string;
    readonly task: Promise<OperationExecution<ImportPortableSessionResult>>;
  }>();
  readonly #portableImportDrafts = new Map<string, PortableImportDraft>();
  readonly #nativeBindingLocks = new Map<string, Promise<void>>();
  readonly #turnOverrideLeases = new Map<string, TurnOverrideLease>();
  readonly #sessionRuntimeControl = new SessionRuntimeControlRegistry();
  readonly #sessionRuntimeControlTails = new Map<string, Promise<void>>();
  readonly #sessionRuntimeControlEffects = new Set<string>();
  readonly #sessionRuntimeRecoveries = new Map<string, SessionRuntimeRecoveryState>();
  readonly #nativeHistoryTails = new Map<string, Promise<void>>();
  readonly #runtimeCommandTails = new Map<string, Promise<void>>();
  readonly #nativeStateTails = new Map<string, Promise<void>>();
  /**
   * A live native compaction is a dispatch barrier, not a failed turn. Native
   * observations/events own the generation value; the explicit flight map
   * coalesces identical callers before the effect token installs the barrier.
   */
  readonly #nativeCompactions = new Map<string, number>();
  readonly #compactionEventEpochs = new Map<string, number>();
  readonly #explicitCompactionFlights = new Map<string, ExplicitCompactionFlight>();
  readonly #compactionEffects = new Map<string, Set<symbol>>();
  readonly #compactionQueueWindows = new Map<string, CompactionQueueWindow>();
  readonly #userShellRequests = new Set<string>();
  readonly #userShellRequestFlights = new Map<string, UserShellRequestFlight>();
  readonly #userShells = new Map<string, UserShellLease>();
  readonly #inflightEmissions = new Map<string, Set<Promise<void>>>();
  readonly #reaping = new Map<string, Promise<void>>();
  readonly #activeEffects = new Map<string, number>();
  readonly #activeEffectFlights = new Map<string, Set<Promise<void>>>();
  readonly #backendSideEffectFlights = new Map<string, Set<Promise<void>>>();
  readonly #backgroundTasks = new Map<string, Map<string, TrackedBackgroundTask>>();
  readonly #runSilenceWatchdogs = new Map<string, RunSilenceWatchdog>();
  readonly #runSilenceRecoveries = new Map<string, Promise<boolean>>();
  readonly #messageDeletionLocks = new Set<string>();
  readonly #sessionResetLocks = new Set<string>();
  readonly #reviewRuntimeFlights = new Map<string, ReviewRuntimeFlight>();
  readonly #scheduledWorktreeCreations = new Set<string>();
  readonly #workspaceCapture: WorkspaceRunCapture | undefined;
  readonly #freezeToolPolicies: ((sessionId: string, targetId: string) => void) | undefined;
  readonly #onSessionRuntimeClosed: ((sessionId: string) => void) | undefined;
  readonly #scheduleRunNotifications: ScheduleRunNotificationController | undefined;
  readonly #worktrees: SessionWorktreeCoordinator | undefined;
  readonly #usageOwnerId: string;
  readonly #usageMoneyKind: (
    backendId: string,
    providerId: string
  ) => "actual-cost" | "subscription-value" | "reference-value";
  readonly #sessionRuntimeFallbackEnabled: () => boolean;
  readonly #backendEnabled: (backendId: string) => boolean;
  readonly #providerRoutingEnabled: (backendId: string, providerId: string) => boolean;
  readonly #modelRoutingEnabled: (backendId: string, providerId: string, modelId: string) => boolean;
  readonly #modelAccessRestricted: (backendId: string) => boolean;
  readonly #sessionRuntimeFallbackContext: (backendId: string) => {
    readonly availableProviderIds: ReadonlySet<string>;
    readonly explicitDefault?: { readonly providerId: string; readonly modelId: string };
  };
  readonly #sessionRuntimeRecoveryDelayMs: (attempt: number) => number;
  readonly #monotonicNow: () => number;
  readonly #runSilenceTimeoutMs: number;
  readonly #backendRetirementTimeoutMs: number;
  readonly extraDirectories: ExtraDirectoryManager;
  #scheduledWorktreeReconciliation: Promise<void> | undefined;
  #disposed = false;

  constructor(
    store: OperationalStore,
    artifactStore: ArtifactStore,
    adapters: readonly BackendAdapter[],
    options: {
      readonly workspaceCapture?: WorkspaceRunCapture;
      readonly freezeToolPolicies?: (sessionId: string, targetId: string) => void;
      readonly onSessionRuntimeClosed?: (sessionId: string) => void;
      readonly scheduleRunNotifications?: ScheduleRunNotificationController;
      readonly worktrees?: SessionWorktreeCoordinator;
      readonly monotonicNow?: () => number;
      /** Consecutive accepted-Run silence before fail-closed recovery; 0 disables. */
      readonly runSilenceTimeoutMs?: number;
      /** Bound for each old-generation projection, close, or hard-retirement step. */
      readonly backendRetirementTimeoutMs?: number;
      /** Stable Orchestrator node identity; never accepted from an RPC request. */
      readonly usageOwnerId?: string;
      /** Exact Backend/Provider billing provenance; never inferred from a global Provider ID. */
      readonly usageMoneyKind?: (
        backendId: string,
        providerId: string
      ) => "actual-cost" | "subscription-value" | "reference-value";
      /** Owner setting read at decision time; the default is deliberately off. */
      readonly sessionRuntimeFallbackEnabled?: () => boolean;
      /** Owner enablement read at every new-task admission boundary. */
      readonly backendEnabled?: (backendId: string) => boolean;
      /** Owner Provider access read at every new-route admission boundary. */
      readonly providerRoutingEnabled?: (backendId: string, providerId: string) => boolean;
      /** Owner model access read at every new-route admission boundary. */
      readonly modelRoutingEnabled?: (backendId: string, providerId: string, modelId: string) => boolean;
      /** Whether an unspecified native default must be replaced or rejected. */
      readonly modelAccessRestricted?: (backendId: string) => boolean;
      /** Current connected Provider rail and the owner's explicit new-task default. */
      readonly sessionRuntimeFallbackContext?: (backendId: string) => {
        readonly availableProviderIds: ReadonlySet<string>;
        readonly explicitDefault?: { readonly providerId: string; readonly modelId: string };
      };
      readonly sessionRuntimeRecoveryDelayMs?: (attempt: number) => number;
      /** Registry-probed descriptors, including unavailable instance shadows. */
      readonly backendDescriptors?: readonly BackendDescriptor[];
    } = {}
  ) {
    this.#store = store;
    this.#artifactStore = artifactStore;
    this.#workspaceCapture = options.workspaceCapture;
    this.#freezeToolPolicies = options.freezeToolPolicies;
    this.#onSessionRuntimeClosed = options.onSessionRuntimeClosed;
    this.#scheduleRunNotifications = options.scheduleRunNotifications;
    this.#worktrees = options.worktrees;
    this.#usageOwnerId = options.usageOwnerId ?? "orchestrator";
    this.#usageMoneyKind = options.usageMoneyKind ?? (() => "actual-cost");
    this.#sessionRuntimeFallbackEnabled = options.sessionRuntimeFallbackEnabled ?? (() => false);
    this.#backendEnabled = options.backendEnabled ?? (() => true);
    this.#providerRoutingEnabled = options.providerRoutingEnabled ?? (() => true);
    this.#modelRoutingEnabled = options.modelRoutingEnabled ?? (() => true);
    this.#modelAccessRestricted = options.modelAccessRestricted ?? (() => false);
    this.#sessionRuntimeFallbackContext = options.sessionRuntimeFallbackContext
      ?? (() => ({ availableProviderIds: new Set<string>() }));
    this.#sessionRuntimeRecoveryDelayMs = options.sessionRuntimeRecoveryDelayMs
      ?? sessionRuntimeRecoveryDelayMs;
    this.#monotonicNow = options.monotonicNow ?? (() => performance.now());
    const runSilenceTimeoutMs = options.runSilenceTimeoutMs ?? DEFAULT_RUN_SILENCE_TIMEOUT_MS;
    if (!Number.isSafeInteger(runSilenceTimeoutMs) || runSilenceTimeoutMs < 0) {
      throw new Error("Run silence timeout must be a non-negative safe integer.");
    }
    this.#runSilenceTimeoutMs = runSilenceTimeoutMs;
    const backendRetirementTimeoutMs = options.backendRetirementTimeoutMs
      ?? DEFAULT_BACKEND_RETIREMENT_TIMEOUT_MS;
    if (!Number.isSafeInteger(backendRetirementTimeoutMs) || backendRetirementTimeoutMs < 1) {
      throw new Error("Backend retirement timeout must be a positive safe integer.");
    }
    this.#backendRetirementTimeoutMs = backendRetirementTimeoutMs;
    this.extraDirectories = new ExtraDirectoryManager(store);
    for (const descriptor of options.backendDescriptors ?? []) {
      if (this.#initialBackendDescriptors.has(descriptor.id)) {
        throw new Error(`Duplicate Backend descriptor ID: ${descriptor.id}`);
      }
      this.#initialBackendDescriptors.set(descriptor.id, descriptor);
    }
    for (const adapter of adapters) {
      if (this.#adapters.has(adapter.id)) throw new Error(`Duplicate Backend Adapter ID: ${adapter.id}`);
      this.#adapters.set(adapter.id, adapter);
      this.#adapterGenerations.set(
        adapter.id,
        this.#initialBackendDescriptors.get(adapter.id)?.instanceGeneration
          ?? storedBackendInstanceGeneration(store, adapter.id)
          ?? 0
      );
    }
  }

  get store(): OperationalStore {
    return this.#store;
  }

  /** Current process-local adapter projection; replacement never leaves a stale array behind. */
  currentAdapters(): readonly BackendAdapter[] {
    this.#assertOpen();
    return [...this.#adapters.values()];
  }

  currentAdapter(backendId: string): BackendAdapter | undefined {
    this.#assertOpen();
    return this.#adapters.get(backendId);
  }

  /**
   * Point-in-time, content-free authority for work owned by this SessionHost
   * that a process shutdown could interrupt. Purely accepted/queued prompts
   * remain durable and intentionally do not count.
   */
  inspectRuntimeActivity(): readonly SessionRuntimeActivityKind[] {
    this.#assertOpen();
    const durable = this.#store.inspectDurableRuntimeActivity();
    const kinds = new Set<SessionRuntimeActivityKind>();
    if (durable.run) kinds.add("run");
    if (
      durable.queueDispatch
      || this.#draining.size > 0
      || this.#pendingDispatchAcceptances.size > 0
      || this.#dispatchPreparations.size > 0
    ) kinds.add("queue_dispatch");
    if (durable.interaction || this.#pendingInteractions.size > 0) kinds.add("interaction");
    if (durable.toolLease) kinds.add("tool_lease");
    if (
      durable.backgroundTask
      || [...this.#backgroundTasks.values()].some((tasks) => tasks.size > 0)
    ) kinds.add("background_task");
    if (
      this.#nativeCompactions.size > 0
      || this.#explicitCompactionFlights.size > 0
      || this.#compactionEffects.size > 0
    ) kinds.add("compaction");
    if (this.#userShellRequests.size > 0 || this.#userShells.size > 0) kinds.add("user_shell");
    if (durable.review || this.#reviewRuntimeFlights.size > 0) kinds.add("review");
    if (durable.operation) kinds.add("operation");
    if (
      this.#activating.size > 0
      || this.#creationLocks.size > 0
      || this.#portableImportLocks.size > 0
      || this.#nativeBindingLocks.size > 0
      || this.#reaping.size > 0
      || this.#runSilenceRecoveries.size > 0
      || this.#activeEffects.size > 0
      || this.#inflightEmissions.size > 0
      || this.#messageDeletionLocks.size > 0
      || this.#sessionResetLocks.size > 0
      || this.#closeIfActiveFlights.size > 0
      || this.#runtimeRestartFlights.size > 0
      || this.#runtimeRestartFences.size > 0
      || this.#backendReplacementFences.size > 0
      || this.#backendAdmissionEffects.size > 0
    ) kinds.add("session_lifecycle");
    return [...kinds];
  }

  async initialize(): Promise<void> {
    this.#assertOpen();
    this.#store.recoverStartup();
    this.#store.recoverPendingContextRebuilds();
    for (const descriptor of this.#initialBackendDescriptors.values()) this.#store.upsertBackend(descriptor);
    const unprobed = [...this.#adapters.values()]
      .filter((adapter) => !this.#initialBackendDescriptors.has(adapter.id));
    const probes = await Promise.allSettled(unprobed.map((adapter) => adapter.describe()));
    for (let index = 0; index < probes.length; index += 1) {
      const adapter = unprobed[index]!;
      const probe = probes[index]!;
      this.#store.upsertBackend(probe.status === "fulfilled"
        ? probe.value
        : {
            id: adapter.id,
            adapterKind: adapter.id,
            instanceGeneration: 0,
            displayName: adapter.id,
            version: "unknown",
            health: "unavailable",
            installationState: "error",
            authenticationState: "error",
            capabilities: new Map(),
            models: [],
            tools: [],
            diagnostics: ["Backend instance probe failed during service startup."]
          });
    }
    // Native runtimes are lazy. Accepted durable work below is sufficient to
    // reactivate its owning session; merely having a product Session must not
    // keep a Backend process resident after a Orchestrator restart.
    const detachedSubagentRecoveries: Promise<void>[] = [];
    for (const session of this.#store.listSessions({ includeArchived: true })) {
      if (
        this.#store.findPendingScheduleDeletionCleanupForSession(session.descriptor.id) !== undefined
        || this.#store.findPendingSessionLifecycleCleanup(session.descriptor.id) !== undefined
      ) {
        continue;
      }
      this.recoverInterruptedCompactionQueue(session.descriptor.id);
      this.ensureContextOverflowReplay(session.descriptor.id);
      const adapter = this.#adapters.get(session.descriptor.backendId);
      if (adapter === undefined) {
        this.recordFailure("backend_instance_recovery_unavailable", new JokoError({
          code: "BACKEND_INSTANCE_UNAVAILABLE",
          message: "A persisted Session's Backend instance is unavailable during startup recovery.",
          phase: "recovery",
          retryable: true,
          stateMayHaveChanged: false,
          recovery: "Restore the Backend instance and restart recovery."
        }));
        continue;
      }
      void this.drain(session.descriptor.id);
      if (adapter.observeDetachedSubagents !== undefined) {
        detachedSubagentRecoveries.push(
          adapter.observeDetachedSubagents(this.contextFor(session)).catch((error: unknown) => {
            this.recordFailure("detached_subagent_recovery", error);
          })
        );
      }
    }
    await Promise.all(detachedSubagentRecoveries);
    await this.reconcileScheduledWorktrees();
  }

  async registerTarget(target: TargetDescriptor, metadata: unknown = {}): Promise<void> {
    this.#assertOpen();
    const adapter = this.requireAdapter(target.backendId);
    const generation = this.requireAdapterGeneration(target.backendId, adapter);
    const release = this.beginBackendAdmissionEffect(target.backendId);
    try {
      this.assertCurrentAdapterGeneration(target.backendId, adapter, generation);
      await adapter.validateTarget(target);
      this.assertCurrentAdapterGeneration(target.backendId, adapter, generation);
      this.#store.upsertTarget(target, metadata);
      this.assertCurrentAdapterGeneration(target.backendId, adapter, generation);
    } finally {
      release();
    }
  }

  /** Validate adapter ownership and workspace safety without mutating product state. */
  async validateTarget(target: TargetDescriptor): Promise<void> {
    this.#assertOpen();
    const adapter = this.requireAdapter(target.backendId);
    const generation = this.requireAdapterGeneration(target.backendId, adapter);
    const release = this.beginBackendAdmissionEffect(target.backendId);
    try {
      this.assertCurrentAdapterGeneration(target.backendId, adapter, generation);
      await adapter.validateTarget(target);
      this.assertCurrentAdapterGeneration(target.backendId, adapter, generation);
    } finally {
      release();
    }
  }

  async listNativeSessions(targetId: string): Promise<readonly NativeSessionCandidate[]> {
    this.#assertOpen();
    const target = this.#store.getTarget(targetId).descriptor;
    const adapter = this.requireAdapter(target.backendId);
    const discovery = this.#store.getBackend(target.backendId).descriptor.capabilities.get("session.discovery");
    if (discovery?.supported !== true) {
      throw new JokoError({
        code: "NATIVE_SESSION_DISCOVERY_UNSUPPORTED",
        message: "The selected Backend does not support native session discovery.",
        phase: "capability",
        retryable: false,
        stateMayHaveChanged: false,
        recovery: "Select a Backend that advertises session.discovery."
      });
    }
    if (adapter.listNativeSessions === undefined) {
      throw new JokoError({
        code: "NATIVE_SESSION_DISCOVERY_UNSUPPORTED",
        message: "The selected Backend does not support native session discovery.",
        phase: "capability",
        retryable: false,
        stateMayHaveChanged: false,
        recovery: "The Backend capability manifest is inconsistent; refresh or update the Adapter."
      });
    }
    const generation = this.requireAdapterGeneration(target.backendId, adapter);
    const release = this.beginBackendAdmissionEffect(target.backendId);
    try {
      this.assertCurrentAdapterGeneration(target.backendId, adapter, generation);
      const sessions = await adapter.listNativeSessions(target);
      this.assertCurrentAdapterGeneration(target.backendId, adapter, generation);
      return sessions;
    } finally {
      release();
    }
  }

  async scanNativeSessionCatalog(backendId: string, force = false): Promise<NativeSessionCatalogResult> {
    return (await this.scanNativeSessionCatalogSnapshot(backendId, force)).result;
  }

  async scanNativeSessionCatalogSnapshot(backendId: string, force = false): Promise<NativeSessionCatalogSnapshot> {
    this.#assertOpen();
    const adapter = this.requireAdapter(backendId);
    const adapterGeneration = this.requireAdapterGeneration(backendId, adapter);
    const cached = this.#nativeSessionCatalogCache.get(backendId);
    if (
      !force
      && cached?.adapterGeneration === adapterGeneration
      && this.#monotonicNow() - cached.scannedAt < NATIVE_SESSION_CATALOG_TTL_MS
    ) return this.createNativeSessionCatalogSnapshot(backendId, cached);

    const existing = this.#nativeSessionCatalogFlights.get(backendId);
    if (
      existing?.adapterGeneration === adapterGeneration
      && (!force || existing.force)
    ) return this.createNativeSessionCatalogSnapshot(backendId, await existing.promise);

    const epoch = (this.#nativeSessionCatalogEpochs.get(backendId) ?? 0) + 1;
    this.#nativeSessionCatalogEpochs.set(backendId, epoch);
    const promise = this.scanNativeSessionCatalogOnce(backendId).then((result): NativeSessionCatalogCacheEntry => {
      const scannedAt = this.#monotonicNow();
      if (
        this.#nativeSessionCatalogEpochs.get(backendId) !== epoch
        || this.#adapters.get(backendId) !== adapter
        || this.#adapterGenerations.get(backendId) !== adapterGeneration
      ) {
        throw new StoreError("The native task catalog scan was superseded. Scan again and retry.");
      }
      const completed = {
        adapterGeneration,
        scanEpoch: epoch,
        scannedAt,
        result
      };
      this.#nativeSessionCatalogCache.set(backendId, completed);
      return completed;
    });
    const flight: NativeSessionCatalogFlight = { adapterGeneration, force, epoch, promise };
    this.#nativeSessionCatalogFlights.set(backendId, flight);
    try {
      return this.createNativeSessionCatalogSnapshot(backendId, await promise);
    } finally {
      if (this.#nativeSessionCatalogFlights.get(backendId) === flight) {
        this.#nativeSessionCatalogFlights.delete(backendId);
      }
    }
  }

  private createNativeSessionCatalogSnapshot(
    backendId: string,
    scanned: NativeSessionCatalogCacheEntry
  ): NativeSessionCatalogSnapshot {
    const targets = this.#store.listTargets(backendId);
    const entries: NativeSessionCatalogEntry[] = [];
    let existingCount = 0;
    for (const entry of scanned.result.entries) {
      const existing = this.#store.findLiveSessionByNativeBinding(backendId, entry.nativeReference);
      const existingPlacement = existing?.descriptor.projectId === undefined ? "dialogue" : "project";
      if (
        this.nativeSessionCatalogEntryWasConsumed(backendId, scanned.scanEpoch, entry.nativeReference)
        || nativeSessionCatalogEntryUsesManagedDirectory(targets, entry)
        || (existing !== undefined
          && (entry.existingMatch === "binding" || existingPlacement === entry.placement))
      ) {
        existingCount += 1;
      } else {
        entries.push(entry);
      }
    }
    const visibleResult = entries.length === scanned.result.entries.length
      ? scanned.result
      : { entries, rejectedCount: scanned.result.rejectedCount };
    const snapshot = {
      backendId,
      adapterGeneration: scanned.adapterGeneration,
      scanEpoch: scanned.scanEpoch,
      scannedAt: scanned.scannedAt,
      token: randomUUID(),
      result: visibleResult,
      existingCount
    };
    this.retainNativeSessionCatalogSnapshot(snapshot);
    return snapshot;
  }

  async validateCatalogSessionReclassification(input: {
    readonly sessionId: string;
    readonly projectId?: string;
    readonly archived: boolean;
    readonly modifiedAt: number;
    readonly snapshotToken: string;
  }): Promise<{ readonly title: string; readonly archived: boolean; readonly modifiedAt: number }> {
    this.#assertOpen();
    const session = this.#store.getSession(input.sessionId);
    const snapshot = this.requireNativeSessionCatalogSnapshot(
      session.descriptor.backendId,
      input.snapshotToken
    );
    const entry = snapshot.result.entries.find((candidate) =>
      candidate.nativeReference === session.descriptor.binding.opaqueRef);
    if (entry === undefined || entry.existingMatch !== "binding_and_placement") {
      throw new StoreError("The native task is no longer eligible for catalog reclassification.");
    }
    if (this.nativeSessionCatalogEntryWasConsumed(
      snapshot.backendId,
      snapshot.scanEpoch,
      entry.nativeReference
    )) {
      throw new StoreError("The native task catalog entry was already used. Scan again and retry.");
    }
    if (entry.modifiedAt !== input.modifiedAt || entry.archived !== input.archived) {
      throw new StoreError("The native task changed after the catalog was scanned.");
    }
    const currentPlacement = session.descriptor.projectId === undefined ? "dialogue" : "project";
    if (currentPlacement === entry.placement) {
      throw new StoreError("The native task already has the catalog placement.");
    }
    const placement = input.projectId === undefined ? "dialogue" : "project";
    if (entry.placement !== placement) {
      throw new StoreError("The native task placement changed after the catalog was scanned.");
    }
    if (input.projectId !== undefined) {
      const projectTarget = this.#store.getTarget(input.projectId);
      if (projectTarget.descriptor.backendId !== session.descriptor.backendId) {
        throw new StoreError("Catalog reclassification project does not belong to the Session Backend.");
      }
      const projectDirectory = entry.projectDirectory ?? entry.workingDirectory;
      if (projectDirectory === undefined
        || !(await sameServicePath(projectDirectory, projectTarget.descriptor.workspaceRoot))) {
        throw new StoreError("The native task does not belong to the selected project Target.");
      }
    }
    const externallyAuthoritative = entry.modifiedAt >= session.descriptor.updatedAt;
    const presentation = {
      title: externallyAuthoritative
        ? entry.title?.trim() || session.descriptor.title
        : session.descriptor.title,
      archived: externallyAuthoritative ? entry.archived : session.descriptor.archived,
      modifiedAt: Math.max(session.descriptor.updatedAt, entry.modifiedAt)
    };
    this.consumeNativeSessionCatalogEntry(snapshot, entry.nativeReference);
    return presentation;
  }

  private retainNativeSessionCatalogSnapshot(snapshot: RetainedNativeSessionCatalogSnapshot): void {
    const prunableBackends = new Set<string>();
    for (const [token, retained] of this.#nativeSessionCatalogSnapshots) {
      if (snapshot.scannedAt - retained.scannedAt >= NATIVE_SESSION_CATALOG_SNAPSHOT_TTL_MS) {
        this.#nativeSessionCatalogSnapshots.delete(token);
        prunableBackends.add(retained.backendId);
      }
    }
    if (this.#nativeSessionCatalogSnapshots.size >= MAXIMUM_NATIVE_SESSION_CATALOG_SNAPSHOTS) {
      const oldest = [...this.#nativeSessionCatalogSnapshots.values()]
        .sort((left, right) => left.scannedAt - right.scannedAt)[0];
      if (oldest !== undefined) {
        this.#nativeSessionCatalogSnapshots.delete(oldest.token);
        prunableBackends.add(oldest.backendId);
      }
    }
    this.#nativeSessionCatalogSnapshots.set(snapshot.token, snapshot);
    for (const backendId of prunableBackends) this.pruneNativeSessionCatalogConsumedEpochs(backendId);
  }

  private requireNativeSessionCatalogSnapshot(
    backendId: string,
    token: string
  ): RetainedNativeSessionCatalogSnapshot {
    const snapshot = this.#nativeSessionCatalogSnapshots.get(token);
    const adapter = this.requireAdapter(backendId);
    const adapterGeneration = this.requireAdapterGeneration(backendId, adapter);
    if (snapshot === undefined || snapshot.backendId !== backendId) {
      throw new StoreError("The native task catalog snapshot is no longer available. Scan again and retry.");
    }
    if (
      snapshot.adapterGeneration !== adapterGeneration
      || this.#monotonicNow() - snapshot.scannedAt >= NATIVE_SESSION_CATALOG_SNAPSHOT_TTL_MS
    ) {
      if (this.#nativeSessionCatalogSnapshots.get(token) === snapshot) {
        this.#nativeSessionCatalogSnapshots.delete(token);
        this.pruneNativeSessionCatalogConsumedEpochs(snapshot.backendId);
      }
      throw new StoreError("The native task catalog snapshot is no longer available. Scan again and retry.");
    }
    return snapshot;
  }

  private consumeNativeSessionCatalogEntry(
    snapshot: RetainedNativeSessionCatalogSnapshot,
    nativeReference: string
  ): void {
    if (this.requireNativeSessionCatalogSnapshot(snapshot.backendId, snapshot.token) !== snapshot) {
      throw new StoreError("The native task catalog snapshot is no longer available. Scan again and retry.");
    }
    if (this.nativeSessionCatalogEntryWasConsumed(
      snapshot.backendId,
      snapshot.scanEpoch,
      nativeReference
    )) {
      throw new StoreError("The native task catalog entry was already used. Scan again and retry.");
    }
    const consumedThroughEpoch = this.#nativeSessionCatalogEpochs.get(snapshot.backendId) ?? snapshot.scanEpoch;
    const backendFences = this.#nativeSessionCatalogConsumedEpochs.get(snapshot.backendId) ?? new Map<string, number>();
    backendFences.set(
      nativeReference,
      Math.max(backendFences.get(nativeReference) ?? 0, consumedThroughEpoch)
    );
    this.#nativeSessionCatalogConsumedEpochs.set(snapshot.backendId, backendFences);
    this.#nativeSessionCatalogCache.delete(snapshot.backendId);
    this.#nativeSessionCatalogFlights.delete(snapshot.backendId);
    this.#nativeSessionCatalogEpochs.set(snapshot.backendId, consumedThroughEpoch + 1);
  }

  private nativeSessionCatalogEntryWasConsumed(
    backendId: string,
    scanEpoch: number,
    nativeReference: string
  ): boolean {
    return (this.#nativeSessionCatalogConsumedEpochs.get(backendId)?.get(nativeReference) ?? -1) >= scanEpoch;
  }

  private pruneNativeSessionCatalogConsumedEpochs(backendId: string): void {
    const fences = this.#nativeSessionCatalogConsumedEpochs.get(backendId);
    if (fences === undefined) return;
    const retainedReferences = new Set<string>();
    for (const snapshot of this.#nativeSessionCatalogSnapshots.values()) {
      if (snapshot.backendId !== backendId) continue;
      for (const entry of snapshot.result.entries) {
        const fence = fences.get(entry.nativeReference);
        if (fence !== undefined && snapshot.scanEpoch <= fence) {
          retainedReferences.add(entry.nativeReference);
        }
      }
    }
    for (const nativeReference of fences.keys()) {
      if (!retainedReferences.has(nativeReference)) fences.delete(nativeReference);
    }
    if (fences.size === 0) this.#nativeSessionCatalogConsumedEpochs.delete(backendId);
  }

  invalidateNativeSessionCatalog(backendId: string): void {
    this.#nativeSessionCatalogCache.delete(backendId);
    this.#nativeSessionCatalogFlights.delete(backendId);
    for (const [token, snapshot] of this.#nativeSessionCatalogSnapshots) {
      if (snapshot.backendId === backendId) this.#nativeSessionCatalogSnapshots.delete(token);
    }
    this.#nativeSessionCatalogEpochs.set(
      backendId,
      (this.#nativeSessionCatalogEpochs.get(backendId) ?? 0) + 1
    );
    this.#nativeSessionCatalogConsumedEpochs.delete(backendId);
  }

  private async scanNativeSessionCatalogOnce(backendId: string): Promise<NativeSessionCatalogResult> {
    const adapter = this.requireAdapter(backendId);
    const catalog = this.#store.getBackend(backendId).descriptor.capabilities.get("session.catalog");
    if (catalog?.supported !== true || adapter.scanNativeSessionCatalog === undefined) {
      throw new JokoError({
        code: "NATIVE_SESSION_CATALOG_UNSUPPORTED",
        message: "The selected Backend does not support local task catalog scanning.",
        phase: "capability",
        retryable: false,
        stateMayHaveChanged: false,
        recovery: "Select a Backend that advertises session.catalog."
      });
    }
    const generation = this.requireAdapterGeneration(backendId, adapter);
    const release = this.beginBackendAdmissionEffect(backendId);
    try {
      this.assertCurrentAdapterGeneration(backendId, adapter, generation);
      const result = await adapter.scanNativeSessionCatalog();
      this.assertCurrentAdapterGeneration(backendId, adapter, generation);
      return result;
    } finally {
      release();
    }
  }

  async createSession(input: CreateSessionInput): Promise<OperationExecution<{ readonly sessionId: string }>> {
    this.#assertOpen();
    validateAppendSystemPrompt(input.appendSystemPrompt);
    const target = this.#store.getTarget(input.targetId);
    if (input.nativeStart?.kind !== "attach") {
      this.validateFastSelection(
        target.descriptor.backendId,
        input.providerId,
        input.modelId,
        input.fastMode,
        "Creating a Fast Mode task"
      );
    }
    const bodyHash = operationBodyHash(createSessionOperationBody(input));
    const existingLock = this.#creationLocks.get(input.operationId);
    if (existingLock !== undefined) {
      if (
        existingLock.connectionId !== input.connection.id ||
        existingLock.authKeyDigest !== input.connection.authKeyDigest
      ) {
        throw new AuthorizationError("The operation belongs to a different connection.");
      }
      if (existingLock.bodyHash !== bodyHash) {
        throw new OperationConflictError(input.operationId, existingLock.bodyHash, bodyHash);
      }
      return existingLock.task;
    }
    const task = this.createSessionOnce(input).finally(() => this.#creationLocks.delete(input.operationId));
    this.#creationLocks.set(input.operationId, {
      bodyHash,
      connectionId: input.connection.id,
      authKeyDigest: input.connection.authKeyDigest,
      task
    });
    return task;
  }

  /** Service-owned Session creation used by Scheduler. The operation is
   * durably claimed before the Adapter effect, and the product Session is
   * persisted before a scheduled input can be queued. */
  async createScheduledSession(input: CreateScheduledSessionInput): Promise<OperationExecution<{ readonly sessionId: string }>> {
    this.#assertOpen();
    const target = this.#store.getTarget(input.targetId);
    this.validateFastSelection(
      target.descriptor.backendId,
      input.providerId,
      input.modelId,
      input.fastMode,
      "Creating a scheduled task"
    );
    return this.createSessionOnce(input);
  }

  /** Creates a normal visible Session for a trusted service workflow. The
   * deferred operation is persisted before the Adapter effect and remains
   * idempotent across retries. */
  async createServiceSession(input: CreateServiceSessionInput): Promise<OperationExecution<{ readonly sessionId: string }>> {
    this.#assertOpen();
    const target = this.#store.getTarget(input.targetId);
    this.validateFastSelection(
      target.descriptor.backendId,
      input.providerId,
      input.modelId,
      input.fastMode,
      "Creating a handed-off task"
    );
    return this.createSessionOnce(input);
  }

  /** Content-free volatile probe used only to classify a helper wake result. */
  isSessionActive(sessionId: string): boolean {
    this.#assertOpen();
    this.#store.getSession(sessionId);
    return this.#active.has(sessionId) || this.#activating.has(sessionId);
  }

  sessionRuntimeFallbackEnabled(): boolean {
    this.#assertOpen();
    return this.#sessionRuntimeFallbackEnabled();
  }

  /** Volatile Desktop-host authority; application restart intentionally returns to the durable baseline. */
  getSessionRuntimeControl(sessionId: string): SessionRuntimeControlSnapshot {
    this.#assertOpen();
    const stored = this.#store.getSession(sessionId);
    return this.#sessionRuntimeControl.snapshot(sessionId, sessionRuntimeBaseline(stored.descriptor));
  }

  async setSessionRuntimeControl(input: {
    readonly sessionId: string;
    readonly expectedGeneration: number;
    readonly patch: SessionRuntimePatch;
    readonly source?: SessionRuntimeMutationSource;
  }): Promise<SessionRuntimeMutationResult> {
    this.#assertOpen();
    if (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 0) {
      throw new SessionRuntimeControlError("INVALID_ARGS", "expected_generation must be a non-negative integer.");
    }
    if (
      input.patch.providerId === undefined && input.patch.modelId === undefined
      && input.patch.effort === undefined && input.patch.fastMode === undefined
    ) {
      throw new SessionRuntimeControlError("INVALID_ARGS", "At least one runtime selection axis is required.");
    }
    return this.#withSessionRuntimeControlLock(input.sessionId, async () => {
      const stored = this.#store.getSession(input.sessionId);
      if (stored.descriptor.deletedAt !== undefined || stored.descriptor.archived) {
        throw new SessionRuntimeControlError("ROUTE_UNAVAILABLE", "Archived or deleted tasks cannot change runtime selection.");
      }
      const baseline = sessionRuntimeBaseline(stored.descriptor);
      if (baseline === undefined) {
        throw new SessionRuntimeControlError("ROUTE_UNAVAILABLE", "The task has no complete model baseline.");
      }
      const snapshot = this.#sessionRuntimeControl.snapshot(input.sessionId, baseline);
      if (snapshot.generation !== input.expectedGeneration) {
        throw new SessionRuntimeControlError("CONFLICT", "The task runtime selection changed; read it again before retrying.");
      }
      const routeExplicit = input.patch.providerId !== undefined || input.patch.modelId !== undefined;
      const current = routeExplicit
        ? snapshot.pending?.profile ?? snapshot.effective ?? baseline
        : snapshot.effective ?? baseline;
      const backend = this.#store.getBackend(stored.descriptor.backendId).descriptor;
      const profile = resolveSessionRuntimeProfile({
        baseline,
        current,
        patch: input.patch,
        models: backend.models,
        fastModeSupported: backend.capabilities.get("model.fast_mode")?.supported === true
      });
      if (profile === undefined) {
        throw new SessionRuntimeControlError(
          "ROUTE_UNAVAILABLE",
          "The requested same-Backend model, effort, or Fast combination is unavailable."
        );
      }
      if (
        routeExplicit
        && (profile.providerId !== current.providerId || profile.modelId !== current.modelId)
        && !this.#modelRoutingEnabled(backend.id, profile.providerId, profile.modelId)
      ) {
        throw new SessionRuntimeControlError(
          "ROUTE_UNAVAILABLE",
          "The requested model is disabled for new routes."
        );
      }
      this.assertSessionRuntimeProfileCapabilities(
        backend,
        runtimeProfileChanges(snapshot.effective ?? baseline, profile)
      );
      const pendingProfile = !routeExplicit && snapshot.pending !== undefined
        ? applySessionRuntimeAxisPatch(
            snapshot.pending.profile,
            resolveCompatibleSessionRuntimeAxisPatch({
              profile: snapshot.pending.profile,
              patch: input.patch,
              models: backend.models,
              fastModeSupported: backend.capabilities.get("model.fast_mode")?.supported === true
            })
          )
        : undefined;
      if (pendingProfile !== undefined && snapshot.pending !== undefined) {
        this.assertSessionRuntimeProfileCapabilities(
          backend,
          runtimeProfileChanges(snapshot.pending.profile, pendingProfile)
        );
      }
      const source = input.source ?? "agent";
      if (this.#sessionRuntimeMutationMustDefer(input.sessionId)) {
        if (routeExplicit) {
          this.#sessionRuntimeControl.acceptDeferred(input.sessionId, source, profile, snapshot.effective);
        } else {
          this.#sessionRuntimeControl.acceptDeferredAxis(
            input.sessionId,
            source,
            snapshot.effective ?? baseline,
            pendingProfile ?? profile
          );
        }
        const accepted = this.#sessionRuntimeControl.snapshot(input.sessionId, baseline);
        this.#publishSessionRuntimeControlChanged(stored);
        return {
          status: "deferred",
          generation: accepted.generation,
          effective: accepted.effective ?? baseline,
          ...(accepted.pending === undefined ? {} : { pending: accepted.pending })
        };
      }

      this.#sessionRuntimeControlEffects.add(input.sessionId);
      try {
        const active = await this.activate(input.sessionId);
        if (!this.#sessionRuntimeControl.generationMatches(input.sessionId, input.expectedGeneration)) {
          throw new SessionRuntimeControlError("CONFLICT", "The task runtime selection changed while it was being applied.");
        }
        await this.#applySessionRuntimeProfile(input.sessionId, active, profile);
        if (routeExplicit) {
          this.#sessionRuntimeControl.acceptApplied(input.sessionId, source, profile, snapshot.effective);
        } else {
          this.#sessionRuntimeControl.acceptAppliedAxis(input.sessionId, source, profile, pendingProfile);
        }
        const accepted = this.#sessionRuntimeControl.snapshot(input.sessionId, baseline);
        this.#publishSessionRuntimeControlChanged(this.#store.getSession(input.sessionId));
        return {
          status: "applied",
          generation: accepted.generation,
          effective: accepted.effective ?? profile
        };
      } finally {
        this.#sessionRuntimeControlEffects.delete(input.sessionId);
        void this.drain(input.sessionId);
      }
    });
  }

  /** A complete owner selection becomes the new durable baseline and cancels temporary routing. */
  recordUserSessionRuntimeSelection(sessionId: string): number {
    this.#assertOpen();
    const stored = this.#store.getSession(sessionId);
    const generation = this.#sessionRuntimeControl.recordUserSelection(sessionId);
    this.#clearSessionRuntimeRecovery(sessionId);
    this.#publishSessionRuntimeControlChanged(stored);
    return generation;
  }

  /** Apply owner-selected axes to the live temporary route and retain any accepted pending route. */
  async applyUserSessionRuntimeAxes(
    sessionId: string,
    patch: SessionRuntimeAxisPatch
  ): Promise<NativeSessionState> {
    this.#assertOpen();
    if (patch.effort === undefined && patch.fastMode === undefined) {
      throw new SessionRuntimeControlError("INVALID_ARGS", "At least one runtime selection axis is required.");
    }
    if (this.isReviewReadOnlySession(sessionId)) throw new StoreError("Reviewer runtime settings are immutable.");
    this.#dismissPendingInteractions(
      new Set([sessionId]),
      "Execution policy changed while the interaction was pending."
    );
    return this.#withSessionRuntimeControlLock(sessionId, async () => {
      const stored = this.#store.getSession(sessionId);
      if (stored.descriptor.deletedAt !== undefined || stored.descriptor.archived) {
        throw new SessionRuntimeControlError("ROUTE_UNAVAILABLE", "Archived or deleted tasks cannot change runtime selection.");
      }
      const baseline = sessionRuntimeBaseline(stored.descriptor);
      if (baseline === undefined) {
        throw new SessionRuntimeControlError("ROUTE_UNAVAILABLE", "The task has no complete model baseline.");
      }
      const snapshot = this.#sessionRuntimeControl.snapshot(sessionId, baseline);
      const effective = snapshot.effective ?? baseline;
      const backend = this.#store.getBackend(stored.descriptor.backendId).descriptor;
      const fastModeSupported = backend.capabilities.get("model.fast_mode")?.supported === true;
      const selected = backend.models.find((candidate) =>
        candidate.providerId === effective.providerId && candidate.modelId === effective.modelId);
      if (selected === undefined || (
        patch.effort === null && selected.thinkingLevels.length > 0
      )) {
        throw new SessionRuntimeControlError(
          "ROUTE_UNAVAILABLE",
          "The requested effort or Fast selection is unavailable for the effective model."
        );
      }
      const profile = resolveSessionRuntimeProfile({
        baseline,
        current: effective,
        patch: {
          ...(typeof patch.effort === "string" ? { effort: patch.effort } : {}),
          ...(patch.fastMode === undefined ? {} : { fastMode: patch.fastMode })
        },
        models: backend.models,
        fastModeSupported
      });
      if (profile === undefined) {
        throw new SessionRuntimeControlError(
          "ROUTE_UNAVAILABLE",
          "The requested effort or Fast selection is unavailable for the effective model."
        );
      }
      const normalizedProfile = patch.effort === null
        ? applySessionRuntimeAxisPatch(profile, { effort: null })
        : profile;
      this.assertSessionRuntimeProfileCapabilities(
        backend,
        runtimeProfileChanges(effective, normalizedProfile)
      );
      const pendingPatch = snapshot.pending === undefined
        ? undefined
        : resolveCompatibleSessionRuntimeAxisPatch({
            profile: snapshot.pending.profile,
            patch,
            models: backend.models,
            fastModeSupported
          });
      const active = await this.activate(sessionId);
      const observed = await this.#applySessionRuntimeAxes(
        sessionId,
        active,
        effective,
        normalizedProfile,
        patch
      );
      this.#sessionRuntimeControl.recordUserAxisSelection(
        sessionId,
        {
          ...(patch.effort === undefined
            ? {}
            : { effort: normalizedProfile.effort ?? null }),
          ...(patch.fastMode === undefined ? {} : { fastMode: normalizedProfile.fastMode })
        },
        pendingPatch
      );
      this.#clearSessionRuntimeRecovery(sessionId);
      this.#publishSessionRuntimeControlChanged(this.#store.getSession(sessionId));
      return observed;
    });
  }

  /** Reclaims Scheduler-owned isolated workspaces only after their durable Run
   * is terminal (or a pre-admission owner is no longer live). Calls coalesce so
   * startup, scheduler ticks, and terminal callbacks cannot double-release. */
  reconcileScheduledWorktrees(): Promise<void> {
    if (this.#disposed || this.#worktrees === undefined) return Promise.resolve();
    if (this.#scheduledWorktreeReconciliation !== undefined) return this.#scheduledWorktreeReconciliation;
    const task = this.reconcileScheduledWorktreesOnce()
      .finally(() => {
        if (this.#scheduledWorktreeReconciliation === task) {
          this.#scheduledWorktreeReconciliation = undefined;
        }
      });
    this.#scheduledWorktreeReconciliation = task;
    return task;
  }

  private async reconcileScheduledWorktreesOnce(): Promise<void> {
    const owners = this.#store.listSettings("service")
      .filter((setting) => setting.key === SCHEDULED_WORKTREE_OWNER_SETTING_KEY)
      .map((setting) => ({ sessionId: setting.scopeId, owner: scheduledWorktreeOwner(setting.value) }))
      .filter((entry): entry is { readonly sessionId: string; readonly owner: ScheduledWorktreeOwner } =>
        entry.owner !== undefined
      );
    const sessions = new Map(this.#store.listSessions({ includeArchived: true, includeDeleted: true })
      .map((session) => [session.descriptor.id, session] as const));
    for (const entry of owners) {
      try {
        if (this.#scheduledWorktreeCreations.has(entry.sessionId)) continue;
        const session = sessions.get(entry.sessionId);
        if (session !== undefined) {
          const binding = session.descriptor.worktree;
          if (binding === undefined || binding.leaseId !== entry.owner.leaseId) {
            throw new StoreError("Scheduled isolated workspace ownership no longer matches its Session binding.");
          }
          if (entry.owner.phase === "creating"
            && this.#store.findScheduleRuntimeOccurrence(entry.owner.runId) !== undefined) continue;
          if (entry.owner.phase === "admitted" && this.hasDurableSessionWork(entry.sessionId)) continue;
        }
        await this.releaseScheduledWorktree(entry.sessionId, entry.owner, session);
      } catch (error) {
        this.recordFailure("scheduled_worktree_reconcile", error);
      }
    }
  }

  private hasDurableSessionWork(sessionId: string): boolean {
    if (this.#store.listRuns({ sessionId, activeOnly: true, limit: 1 }).length > 0) return true;
    return this.#store.listQueueItems({
      sessionId,
      states: ["accepted", "dispatching", "backend_accepted", "dispatch_unknown"],
      limit: 1
    }).length > 0;
  }

  private markScheduledWorktreeAdmitted(
    store: OperationalStore,
    sessionId: string,
    scheduleId: string,
    runId: string
  ): void {
    const setting = store.findSetting("service", sessionId, SCHEDULED_WORKTREE_OWNER_SETTING_KEY);
    if (setting === undefined) return;
    const owner = scheduledWorktreeOwner(setting.value);
    if (owner === undefined || owner.scheduleId !== scheduleId || owner.runId !== runId) {
      throw new StoreError("Scheduled isolated workspace admission did not match its durable owner.");
    }
    if (owner.phase === "admitted") return;
    store.setSetting("service", sessionId, SCHEDULED_WORKTREE_OWNER_SETTING_KEY, {
      ...owner,
      phase: "admitted"
    } satisfies ScheduledWorktreeOwner);
  }

  private async releaseScheduledWorktree(
    sessionId: string,
    owner: ScheduledWorktreeOwner,
    initialSession: StoredSession | undefined
  ): Promise<void> {
    let session = initialSession;
    const releaseBackendAdmission = session === undefined
      ? undefined
      : this.beginBackendAdmissionEffect(session.descriptor.backendId);
    try {
    if (session !== undefined) {
      if (this.hasDurableSessionWork(sessionId)) return;
      if (!session.descriptor.archived) {
        session = this.#store.updateSession(sessionId, { archived: true }, session.revision);
      }
      const active = this.#active.get(sessionId);
      if (active !== undefined) {
        await active.adapter.closeSession(session.descriptor.binding, this.contextFor(session));
        if (this.#active.get(sessionId) === active) this.#active.delete(sessionId);
        this.#nativeCompactions.delete(sessionId);
        this.clearTurnOverrideLeases(sessionId);
        this.#releaseSessionTools(sessionId);
      }
    }
    const current = this.#store.findSetting("service", sessionId, SCHEDULED_WORKTREE_OWNER_SETTING_KEY);
    const currentOwner = scheduledWorktreeOwner(current?.value);
    if (currentOwner === undefined || currentOwner.runId !== owner.runId || currentOwner.leaseId !== owner.leaseId) return;
    await this.#worktrees!.release(sessionId);
      this.#store.deleteSetting("service", sessionId, SCHEDULED_WORKTREE_OWNER_SETTING_KEY);
    } finally {
      releaseBackendAdmission?.();
    }
  }

  /** Dedicated Reviewer creation. It cannot attach/fork and does not project native history. */
  async createFreshReviewer(input: CreateFreshReviewerInput): Promise<{ readonly reviewerSessionId: string }> {
    this.#assertOpen();
    const review = this.#store.getReviewRunBundle(input.reviewRunId);
    if (review.run.state !== "running"
      || review.run.sourceSessionId !== input.sourceSessionId
      || review.sourceLease.state !== "active"
      || review.sourceLease.fencingToken !== input.sourceLeaseFencingToken) {
      throw new StoreError("Reviewer creation rejected stale durable review state.");
    }
    if (input.runtimePolicy !== "review_read_only" || input.nativeStart.kind !== "new"
      || input.permissionMode !== "ask" || input.planMode !== false || input.fastMode !== false) {
      throw new StoreError("Reviewer creation requires the immutable fresh read-only profile.");
    }
    const source = this.#store.getSession(input.sourceSessionId);
    if (source.descriptor.targetId !== input.targetId) throw new StoreError("Reviewer target changed after evidence capture.");
    if (input.providerId !== source.descriptor.providerId
      || input.modelId !== source.descriptor.modelId
      || input.effort !== source.descriptor.effort) {
      throw new StoreError("Reviewer model selection must exactly inherit the source Session.");
    }
    const target = this.#store.getTarget(input.targetId);
    this.assertInheritedSessionCreationReady(
      target.descriptor.backendId,
      input,
      "The source task's model is unavailable for a new reviewer route."
    );
    const adapter = this.requireAdapter(target.descriptor.backendId);
    const reviewerSessionId = stableId("reviewer", input.reviewRunId);
    const existing = this.#store.listSessions({ includeArchived: true, includeDeleted: true })
      .find((session) => session.descriptor.id === reviewerSessionId);
    if (existing !== undefined) {
      if (this.#store.findSessionRuntimePolicy(reviewerSessionId)?.reviewRunId !== input.reviewRunId) {
        throw new StoreError("Reviewer Session identity was already used outside this Review run.");
      }
      return { reviewerSessionId };
    }
    const backendInstanceGeneration = this.requireAdapterGeneration(target.descriptor.backendId, adapter);
    const releaseBackendAdmission = this.beginBackendAdmissionEffect(target.descriptor.backendId);
    const now = Date.now();
    const context = this.provisionalContext(
      reviewerSessionId,
      target.descriptor,
      1,
      "review_read_only",
      undefined,
      backendInstanceGeneration
    );
    let binding: NativeSessionBinding | undefined;
    try {
      binding = await adapter.createSession({
        target: target.descriptor,
        ...(input.providerId === undefined ? {} : { providerId: input.providerId }),
        ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
        ...(input.effort === undefined ? {} : { effort: input.effort }),
        fastMode: false,
        permissionMode: "ask",
        nativeStart: { kind: "new" },
        runtimePolicy: "review_read_only"
      }, context);
      this.#store.createSession({
        id: reviewerSessionId,
        backendId: target.descriptor.backendId,
        targetId: target.descriptor.id,
        title: input.title ?? "Review · Task",
        binding,
        pinned: false,
        archived: false,
        permissionMode: "ask",
        planMode: false,
        ...(input.providerId === undefined ? {} : { providerId: input.providerId }),
        ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
        ...(input.effort === undefined ? {} : { effort: input.effort }),
        fastMode: false,
        ...(target.descriptor.remoteWorkspace === undefined
          ? {}
          : { remoteWorkspace: target.descriptor.remoteWorkspace }),
        createdAt: now,
        updatedAt: now
      });
      this.assertCurrentAdapterGeneration(target.descriptor.backendId, adapter, backendInstanceGeneration);
      this.#active.set(
        reviewerSessionId,
        this.activeSession(adapter, reviewerSessionId, backendInstanceGeneration)
      );
      return { reviewerSessionId };
    } catch (error) {
      if (binding !== undefined) await adapter.closeSession(binding, { ...context, binding }).catch(() => undefined);
      throw error;
    } finally {
      releaseBackendAdmission();
    }
  }

  /** Host-owned exactly-once Review queue. Policy attachment is a hard admission fence. */
  async enqueueInitialPrompt(input: {
    readonly operationId: string;
    readonly reviewRunId: string;
    readonly reviewerSessionId: string;
    readonly prompt: PromptInput;
  }): Promise<ReviewRuntimeDispatch> {
    this.#assertOpen();
    assertPromptInlineTextRanges(input.prompt);
    const existingFlight = this.#reviewRuntimeFlights.get(input.reviewerSessionId);
    if (existingFlight !== undefined) return { accepted: existingFlight.accepted, outcome: existingFlight.promise };
    const review = this.#store.getReviewRun(input.reviewRunId);
    const policy = this.#store.getSessionRuntimePolicy(input.reviewerSessionId);
    this.assertBackendAdmissionOpen(
      this.#store.getSession(input.reviewerSessionId).descriptor.backendId
    );
    if (review.state !== "running" || review.reviewerSessionId !== input.reviewerSessionId
      || policy.reviewRunId !== input.reviewRunId || policy.policy !== "review_read_only") {
      throw new StoreError("Reviewer prompt dispatch requires an attached immutable read-only policy.");
    }
    let resolveFlight!: (outcome: ReviewRuntimeOutcome) => void;
    let acceptFlight!: () => void;
    let rejectAcceptance!: (error: Error) => void;
    const flight: ReviewRuntimeFlight = {
      accepted: new Promise<void>((resolve, reject) => {
        acceptFlight = resolve;
        rejectAcceptance = reject;
      }),
      accept: () => acceptFlight(),
      rejectAcceptance: (error) => rejectAcceptance(error),
      promise: new Promise((resolve) => { resolveFlight = resolve; }),
      resolve: (outcome) => resolveFlight(outcome),
      text: [],
      hasCompleteMessage: false,
      settled: false
    };
    this.#reviewRuntimeFlights.set(input.reviewerSessionId, flight);
    try {
      const now = Date.now();
      const runId = stableId("review-run", input.operationId);
      const attemptId = stableId("review-attempt", input.operationId);
      const queueItemId = stableId("review-queue", input.operationId);
      this.#store.runOperation(
        { id: input.operationId, kind: "review_initial_prompt", body: { reviewRunId: input.reviewRunId, reviewerSessionId: input.reviewerSessionId } },
        (store) => {
          const durablePolicy = store.getSessionRuntimePolicy(input.reviewerSessionId);
          if (durablePolicy.reviewRunId !== input.reviewRunId || durablePolicy.policy !== "review_read_only") {
            throw new StoreError("Reviewer runtime policy changed before durable queue admission.");
          }
          store.createRun({ id: runId, sessionId: input.reviewerSessionId, source: "system", state: "queued", createdAt: now });
          store.createAttempt({ id: attemptId, runId, ordinal: 1, generation: store.getSession(input.reviewerSessionId).descriptor.binding.generation, startedAt: now });
          store.enqueueQueueItem({
            id: queueItemId,
            sessionId: input.reviewerSessionId,
            runId,
            attemptId,
            operationId: input.operationId,
            disposition: "prompt",
            body: input.prompt,
            createdAt: now
          });
          return { queueItemId };
        }
      );
      void this.drain(input.reviewerSessionId);
      return { accepted: flight.accepted, outcome: flight.promise };
    } catch (error) {
      this.#reviewRuntimeFlights.delete(input.reviewerSessionId);
      throw error;
    }
  }

  async closeReviewer(reviewerSessionId: string): Promise<void> {
    const flight = this.#reviewRuntimeFlights.get(reviewerSessionId);
    if (flight !== undefined && !flight.settled) {
      flight.rejectAcceptance(new StoreError("Reviewer closed before Backend acceptance."));
      await this.finishReviewSettledSession(reviewerSessionId, "aborted").catch(() => undefined);
      this.settleReviewRuntime(reviewerSessionId, { state: "closed" });
    }
    const active = this.#active.get(reviewerSessionId);
    const stored = this.#store.listSessions({ includeArchived: true, includeDeleted: true })
      .find((candidate) => candidate.descriptor.id === reviewerSessionId);
    if (stored === undefined) {
      this.#reviewRuntimeFlights.delete(reviewerSessionId);
      this.#releaseSessionTools(reviewerSessionId);
      return;
    }
    const adapter = active?.adapter ?? this.requireAdapter(stored.descriptor.backendId);
    const generation = active?.backendInstanceGeneration
      ?? this.requireAdapterGeneration(stored.descriptor.backendId, adapter);
    const release = this.beginBackendAdmissionEffect(stored.descriptor.backendId);
    try {
      this.assertCurrentAdapterGeneration(stored.descriptor.backendId, adapter, generation);
      await adapter.closeSession(
        stored.descriptor.binding,
        this.contextFor(stored, undefined, undefined, undefined, undefined, generation)
      );
      this.assertCurrentAdapterGeneration(stored.descriptor.backendId, adapter, generation);
    } finally {
      if (active !== undefined && this.#active.get(reviewerSessionId) === active) {
        this.#active.delete(reviewerSessionId);
      }
      this.#reviewRuntimeFlights.delete(reviewerSessionId);
      this.#releaseSessionTools(reviewerSessionId);
      release();
    }
  }

  async cleanupRecoveredReviewer(reviewerSessionId: string): Promise<void> {
    await this.closeReviewer(reviewerSessionId).catch(() => undefined);
  }

  enqueueInput(input: {
    readonly operationId: string;
    readonly connection: ConnectionRecord;
    readonly sessionId: string;
    readonly prompt: PromptInput;
    readonly source?: "user" | "schedule" | "system";
    readonly parentRunId?: string;
    readonly overrides?: TurnExecutionOverrides;
  }): OperationExecution<EnqueueResult> {
    this.#assertOpen();
    assertPromptInlineTextRanges(input.prompt);
    this.assertInputCapabilities(input.sessionId, input.prompt);
    if (this.isReviewReadOnlySession(input.sessionId)) {
      throw new StoreError("Reviewer input is admitted only through the host-owned Review queue.");
    }
    this.assertBackendAdmissionOpen(this.#store.getSession(input.sessionId).descriptor.backendId);
    this.assertSessionNotPendingScheduleDeletion(input.sessionId);
    this.assertMessageDeletionAdmission(input.sessionId);
    this.validateTurnOverrides(input.sessionId, input.overrides);
    const now = Date.now();
    const runId = stableId("run", input.operationId);
    const attemptId = stableId("attempt", input.operationId);
    const queueItemId = stableId("queue", input.operationId);
    const operationBody = {
      sessionId: input.sessionId,
      prompt: input.prompt,
      source: input.source ?? "user",
      ...(input.overrides === undefined ? {} : { overrides: input.overrides }),
      ...(input.parentRunId === undefined ? {} : { parentRunId: input.parentRunId })
    };
    const execution = this.#store.runAuthorizedOperation(
      input.connection.id,
      input.connection.authKeyDigest,
      { id: input.operationId, kind: "send_input", body: operationBody },
      (store) => {
        store.createRun({
          id: runId,
          sessionId: input.sessionId,
          source: input.source ?? "user",
          state: "queued",
          ...(input.parentRunId === undefined ? {} : { parentRunId: input.parentRunId }),
          createdAt: now
        }, { operationId: input.operationId, traceId: `operation:${input.operationId}` });
        store.createAttempt({ id: attemptId, runId, ordinal: 1, generation: store.getSession(input.sessionId).descriptor.binding.generation, startedAt: now });
        store.enqueueQueueItem({
          id: queueItemId,
          sessionId: input.sessionId,
          runId,
          attemptId,
          operationId: input.operationId,
          disposition: input.prompt.disposition,
          body: input.prompt,
          ...(input.overrides === undefined ? {} : { executionOverrides: input.overrides }),
          createdAt: now
        });
        return { sessionId: input.sessionId, runId, attemptId, queueItemId };
      }
    );
    if (!execution.replayed) {
      if ((input.source ?? "user") === "user") this.#clearSessionRuntimeRecovery(input.sessionId);
      void this.drain(input.sessionId);
    }
    return execution;
  }

  /** Host-owned input admission for service workflows such as a granted
   * Scheduler script capability. The mutation and queue item commit before
   * the adapter is allowed to observe the work. */
  enqueueServiceInput(input: EnqueueServiceInput): OperationExecution<EnqueueResult> {
    this.#assertOpen();
    assertPromptInlineTextRanges(input.prompt);
    this.assertInputCapabilities(input.sessionId, input.prompt);
    if (this.isReviewReadOnlySession(input.sessionId)) {
      throw new StoreError("Reviewer input is admitted only through the host-owned Review queue.");
    }
    const session = this.#store.getSession(input.sessionId).descriptor;
    if (session.deletedAt !== undefined || session.archived) {
      throw new StoreError("The target task is archived or deleted.");
    }
    this.assertBackendAdmissionOpen(session.backendId);
    if (input.originSessionId !== undefined) {
      if (input.source !== "system") throw new StoreError("Only system Session handoffs may carry an origin task.");
      const origin = this.#store.getSession(input.originSessionId).descriptor;
      if (origin.deletedAt !== undefined) throw new StoreError("The origin task is deleted.");
    }
    this.assertSessionNotPendingScheduleDeletion(input.sessionId);
    this.assertMessageDeletionAdmission(input.sessionId);
    this.validateTurnOverrides(input.sessionId, input.overrides);
    const now = Date.now();
    const runId = stableId("run", input.operationId);
    const attemptId = stableId("attempt", input.operationId);
    const queueItemId = stableId("queue", input.operationId);
    const execution = this.#store.runOperation(
      {
        id: input.operationId,
        kind: "service_send_input",
        body: {
          sessionId: input.sessionId,
           prompt: input.prompt,
          source: input.source,
          ...(input.parentRunId === undefined ? {} : { parentRunId: input.parentRunId }),
          ...(input.originSessionId === undefined ? {} : { originSessionId: input.originSessionId }),
          ...(input.overrides === undefined ? {} : { overrides: input.overrides })
        }
      },
      (store) => {
        store.createRun({
          id: runId,
          sessionId: input.sessionId,
          source: input.source,
          state: "queued",
          ...(input.parentRunId === undefined ? {} : { parentRunId: input.parentRunId }),
          createdAt: now
        }, { operationId: input.operationId, traceId: `operation:${input.operationId}` });
        store.createAttempt({
          id: attemptId,
          runId,
          ordinal: 1,
          generation: store.getSession(input.sessionId).descriptor.binding.generation,
          startedAt: now
        });
        store.enqueueQueueItem({
          id: queueItemId,
          sessionId: input.sessionId,
          runId,
          attemptId,
          operationId: input.operationId,
          disposition: input.prompt.disposition,
          body: input.prompt,
          ...(input.overrides === undefined ? {} : { executionOverrides: input.overrides }),
          createdAt: now
        });
        return { sessionId: input.sessionId, runId, attemptId, queueItemId };
      }
    );
    if (!execution.replayed) void this.drain(input.sessionId);
    return execution;
  }

  enqueueScheduledInput(input: {
    readonly operationId: string;
    readonly schedule: ScheduleRecord;
    readonly sessionId: string;
    readonly scheduledAt: number;
    readonly nextRunAt?: number;
  }): OperationExecution<EnqueueResult> {
    const sessionId = input.sessionId;
    this.assertBackendAdmissionOpen(this.#store.getSession(sessionId).descriptor.backendId);
    this.assertSessionNotPendingScheduleDeletion(sessionId);
    this.assertMessageDeletionAdmission(sessionId);
    const overrides = scheduleTurnOverrides(input.schedule.executionSnapshot);
    let validationCause: unknown;
    let validationFailure: PublicError | undefined;
    try {
      this.validateTurnOverrides(sessionId, overrides);
      assertPromptInlineTextRanges(input.schedule.prompt);
      this.assertInputCapabilities(sessionId, input.schedule.prompt);
    } catch (error) {
      validationCause = error;
      validationFailure = toPublicError(error, {
        code: "SCHEDULE_EXECUTION_SNAPSHOT_FAILED",
        phase: "schedule",
        retryable: false,
        stateMayHaveChanged: false,
        recovery: "Correct the schedule model, permission, or plan snapshot before triggering it again."
      });
    }
    const runId = stableId("run", input.operationId);
    const attemptId = stableId("attempt", input.operationId);
    const queueItemId = stableId("queue", input.operationId);
    const body = {
      scheduleId: input.schedule.id,
      scheduleName: input.schedule.name,
      scheduleRevision: input.schedule.revision,
      sessionId,
      scheduledAt: input.scheduledAt,
      prompt: input.schedule.prompt,
      executionSnapshot: input.schedule.executionSnapshot
    };
    const execution = this.#store.runOperation(
      { id: input.operationId, kind: "schedule_dispatch", body },
      (store) => {
        store.createRun({
          id: runId,
          sessionId,
          source: "schedule",
          state: "queued",
          createdAt: input.scheduledAt
        }, { operationId: input.operationId, traceId: `schedule:${input.schedule.id}` });
        const generation = store.getSession(sessionId).descriptor.binding.generation;
        store.createAttempt({ id: attemptId, runId, ordinal: 1, generation, startedAt: input.scheduledAt });
        store.enqueueQueueItem({
          id: queueItemId,
          sessionId,
          runId,
          attemptId,
          operationId: input.operationId,
          disposition: input.schedule.prompt.disposition,
          body: input.schedule.prompt,
          ...(overrides === undefined ? {} : { executionOverrides: overrides }),
          createdAt: input.scheduledAt
        });
        if (validationFailure !== undefined) {
          store.updateQueueState({
            queueItemId,
            state: "failed",
            attemptId,
            error: validationFailure,
            traceId: `schedule:${runId}:configuration-failed`
          });
          store.updateRunState({
            runId,
            state: "failed",
            activeAttemptId: attemptId,
            error: validationFailure,
            operationId: input.operationId,
            traceId: `schedule:${runId}:configuration-failed`
          });
          store.finishAttempt(attemptId, validationFailure);
        }
        advanceSchedule(store, input.schedule, input.scheduledAt, input.nextRunAt);
        store.recordScheduleRun(
          input.schedule.id,
          runId,
          validationFailure === undefined ? "queued" : "failed",
          validationFailure,
          input.scheduledAt
        );
        this.markScheduledWorktreeAdmitted(store, sessionId, input.schedule.id, runId);
        return { sessionId, runId, attemptId, queueItemId };
      }
    );
    if (validationFailure === undefined) void this.drain(sessionId);
    else {
      if (!execution.replayed) this.recordFailure("schedule_execution_snapshot", validationCause);
      void this.reconcileScheduledWorktrees();
    }
    return execution;
  }

  /**
   * Wake the per-session singleton dispatcher after an external queue-control
   * transaction commits. Calling this repeatedly is safe: durable claiming and
   * #draining ensure at most one dispatcher can own an accepted item.
   */
  requestQueueDrain(sessionId: string): void {
    // A resume racing shutdown remains durably committed. The next initialize
    // pass will discover the accepted item; never turn that safe handoff into
    // a post-commit RPC failure.
    if (this.#disposed) return;
    this.#store.getSession(sessionId);
    if (this.#store.findPendingScheduleDeletionCleanupForSession(sessionId) !== undefined) return;
    void this.drain(sessionId);
  }

  skipScheduledOccurrence(input: {
    readonly operationId: string;
    readonly schedule: ScheduleRecord;
    readonly sessionId: string;
    readonly scheduledAt: number;
    readonly nextRunAt?: number;
    readonly reason: string;
  }): OperationExecution<{ readonly runId: string }> {
    const sessionId = input.sessionId;
    const runId = stableId("run", input.operationId);
    const execution = this.#store.runOperation(
      {
        id: input.operationId,
        kind: "schedule_skip",
        body: {
          scheduleId: input.schedule.id,
          scheduleRevision: input.schedule.revision,
          sessionId,
          scheduledAt: input.scheduledAt,
          reason: input.reason
        }
      },
      (store) => {
        store.createRun({
          id: runId,
          sessionId,
          source: "schedule",
          state: "aborted",
          createdAt: input.scheduledAt,
          endedAt: Date.now()
        }, { operationId: input.operationId, traceId: `schedule:${input.schedule.id}:skipped` });
        advanceSchedule(store, input.schedule, input.scheduledAt, input.nextRunAt);
        store.recordScheduleRun(input.schedule.id, runId, "skipped", { reason: input.reason }, input.scheduledAt);
        this.markScheduledWorktreeAdmitted(store, sessionId, input.schedule.id, runId);
        return { runId };
      }
    );
    void this.reconcileScheduledWorktrees();
    return execution;
  }

  async mutate<T>(input: {
    readonly operationId: string;
    readonly connection: ConnectionRecord;
    readonly kind: string;
    readonly body: unknown;
    readonly commit: (store: OperationalStore) => T;
    /** Rechecked both when the effect is claimed and in the final commit transaction. */
    readonly precondition?: (store: OperationalStore) => void;
    readonly effect?: () => Promise<void>;
    /** Fence task admission while this claimed lifecycle effect reaches its final commit. */
    readonly sessionLifecycleFenceId?: string;
    /** Wrap the final synchronous Store completion in a serialized external commit protocol. */
    readonly complete?: (
      commit: () => OperationExecution<T>
    ) => Promise<OperationExecution<T>>;
    /**
     * A durable product-specific recovery record may make an effect safe to
     * resume after an error. Returning true keeps the authenticated operation
     * claim in `started` instead of writing an irreversible failure tombstone.
     */
    readonly preserveClaimOnEffectFailure?: (error: unknown) => boolean;
  }): Promise<OperationExecution<T>> {
    this.#assertOpen();
    if (input.effect === undefined) {
      return this.#store.runAuthorizedOperation(
        input.connection.id,
        input.connection.authKeyDigest,
        { id: input.operationId, kind: input.kind, body: input.body },
        input.commit
      );
    }
    const claim = this.#store.claimAuthorizedDeferredEffectOperation<T>(
      input.connection.id,
      input.connection.authKeyDigest,
      { id: input.operationId, kind: input.kind, body: input.body },
      input.precondition === undefined ? undefined : (store) => input.precondition!(store)
    );
    if (!claim.claimed) {
      return { replayed: true, value: claim.value, operation: claim.operation };
    }
    let installedLifecycleFence = false;
    try {
      if (input.sessionLifecycleFenceId !== undefined) {
        const owner = this.#sessionLifecycleFences.get(input.sessionLifecycleFenceId);
        if (owner !== undefined && owner !== claim.operation.id) {
          throw new StoreError("A task lifecycle transition is already in progress.");
        }
        const stored = this.#store.getSession(input.sessionLifecycleFenceId);
        const release = this.beginBackendAdmissionEffect(stored.descriptor.backendId);
        this.#sessionLifecycleBackendAdmissions.set(input.sessionLifecycleFenceId, {
          backendId: stored.descriptor.backendId,
          operationId: claim.operation.id,
          release
        });
        this.#sessionLifecycleFences.set(input.sessionLifecycleFenceId, claim.operation.id);
        installedLifecycleFence = true;
      }
      await input.effect();
      const commit = (): OperationExecution<T> =>
        this.#store.completeAuthorizedDeferredEffectOperation<T>(
          input.connection.id,
          input.connection.authKeyDigest,
          claim.operation.id,
          claim.operation.bodyHash,
          (store) => {
            input.precondition?.(store);
            return input.commit(store);
          }
        );
      return input.complete === undefined ? commit() : await input.complete(commit);
    } catch (error) {
      if (input.preserveClaimOnEffectFailure?.(error) === true) throw error;
      return this.failClaimedEffect(input.kind, claim.operation.id, claim.operation.bodyHash, error);
    } finally {
      if (
        installedLifecycleFence
        && input.sessionLifecycleFenceId !== undefined
        && this.#sessionLifecycleFences.get(input.sessionLifecycleFenceId) === claim.operation.id
      ) {
        this.#sessionLifecycleFences.delete(input.sessionLifecycleFenceId);
      }
      if (input.sessionLifecycleFenceId !== undefined) {
        const admission = this.#sessionLifecycleBackendAdmissions.get(input.sessionLifecycleFenceId);
        if (admission?.operationId === claim.operation.id) {
          this.#sessionLifecycleBackendAdmissions.delete(input.sessionLifecycleFenceId);
          admission.release();
        }
      }
    }
  }

  /**
   * Product-message deletion. The native runtime is fenced
   * and closed before durable truth is re-read; the Store then atomically
   * tombstones the selected rows and arms a content-free rebuild marker.
   */
  async deleteSessionMessage<T>(input: {
    readonly operationId: string;
    readonly connection: ConnectionRecord;
    readonly sessionId: string;
    readonly eventId: string;
    readonly body: unknown;
    readonly precondition?: (store: OperationalStore) => void;
    readonly result: (deletedEventIds: readonly string[]) => T;
  }): Promise<OperationExecution<T>> {
    this.#assertOpen();
    this.#clearSessionRuntimeRecovery(input.sessionId);
    if (this.#sessionResetLocks.has(input.sessionId)) {
      throw sessionResetError(
        "SESSION_RESET_IN_PROGRESS",
        "This task is currently clearing its context.",
        "Wait for the current clear operation to finish before deleting a message."
      );
    }
    if (this.#messageDeletionLocks.has(input.sessionId)) {
      throw messageDeletionError(
        "SESSION_MESSAGE_DELETE_IN_PROGRESS",
        "A message deletion is already in progress for this task.",
        "Wait for the current deletion to finish before trying again."
      );
    }
    const messageDeletionAdmission = this.beginBackendAdmissionEffect(
      this.#store.getSession(input.sessionId).descriptor.backendId
    );
    try {
      this.#messageDeletionLocks.add(input.sessionId);
    } finally {
      messageDeletionAdmission();
    }
    let prepared: MessageDeletionPlan | undefined;
    const assertPrecondition = (store: OperationalStore): void => {
      input.precondition?.(store);
      this.assertMessageDeletionSupported(input.sessionId);
      this.assertMessageDeletionIdle(input.sessionId, store);
      const current = planMessageDeletion(store, input.sessionId, input.eventId);
      if (prepared !== undefined && !sameEventIds(current.deletedEventIds, prepared.deletedEventIds)) {
        throw new StoreError("The visible message turn changed while deletion was being prepared.");
      }
    };
    try {
      return await this.mutate({
        operationId: input.operationId,
        connection: input.connection,
        kind: "delete_session_message",
        body: input.body,
        precondition: assertPrecondition,
        effect: async () => {
          await this.prepareMessageDeletion(input.sessionId);
          prepared = planMessageDeletion(this.#store, input.sessionId, input.eventId);
        },
        commit: (store) => {
          if (prepared === undefined) throw new StoreError("Message deletion preparation did not complete.");
          const committed = store.commitMessageDeletion({
            sessionId: input.sessionId,
            requestedEventId: prepared.requestedEventId,
            deletedEventIds: prepared.deletedEventIds,
            operationId: input.operationId,
            traceId: `message-delete:${input.operationId}`
          });
          return input.result(committed.deletedEventIds);
        }
      });
    } finally {
      this.#messageDeletionLocks.delete(input.sessionId);
    }
  }

  /**
   * `/clear` retains the Product Session and replaces its native
   * context with a genuinely empty session, then publish one durable boundary
   * that hides every prior projection. Native I/O completes before Store truth
   * changes, so uncertain failures never expose a half-cleared Product Session.
   */
  async prepareHistoryMaintenanceBindings(sessionIds: readonly string[]): Promise<readonly {
    readonly sessionId: string;
    readonly source: NativeSessionBinding;
    readonly replacement: NativeSessionBinding;
  }[]> {
    this.#assertOpen();
    const ids = [...new Set(sessionIds.map((sessionId) => sessionId.trim()))]
      .filter((sessionId) => sessionId !== "")
      .sort((left, right) => left.localeCompare(right, "en"));
    for (const sessionId of ids) {
      if (this.#sessionResetLocks.has(sessionId) || this.#messageDeletionLocks.has(sessionId)) {
        throw sessionResetError(
          "SESSION_RESET_IN_PROGRESS",
          "A context replacement is already in progress for a selected task.",
          "Wait for the selected tasks to become idle, then scan history again."
        );
      }
      this.assertSessionResetSupported(sessionId, this.#store);
      this.assertSessionResetIdle(sessionId, this.#store);
    }
    for (const sessionId of ids) {
      this.#clearSessionRuntimeRecovery(sessionId);
      this.#sessionResetLocks.add(sessionId);
    }

    const replacements: Array<{
      readonly sessionId: string;
      readonly source: NativeSessionBinding;
      readonly replacement: NativeSessionBinding;
    }> = [];
    try {
      for (const sessionId of ids) {
        const prepared = await this.prepareSessionReset(sessionId);
        let replacement: NativeSessionBinding | undefined;
        try {
          replacement = await prepared.active.adapter.resetContext!({
            ...prepared.context,
            emit: async () => undefined
          });
          if (
            replacement.opaqueRef === prepared.sourceBinding.opaqueRef
            || replacement.generation <= prepared.sourceBinding.generation
          ) {
            throw sessionResetError(
              "SESSION_RESET_IDENTITY_UNCHANGED",
              "The Backend did not return a fresh native context.",
              "Retry only after the Backend can create a new empty native session."
            );
          }
          await prepared.active.adapter.closeSession(replacement, {
            ...prepared.context,
            binding: replacement,
            generation: replacement.generation,
            emit: async () => undefined
          });
          replacements.push({
            sessionId,
            source: prepared.sourceBinding,
            replacement
          });
        } catch (error) {
          await prepared.active.adapter.closeSession(replacement ?? prepared.sourceBinding, {
            ...prepared.context,
            binding: replacement ?? prepared.sourceBinding,
            generation: (replacement ?? prepared.sourceBinding).generation,
            emit: async () => undefined
          }).catch(() => undefined);
          throw error;
        } finally {
          if (this.#active.get(sessionId) === prepared.active) this.#active.delete(sessionId);
          this.#nativeCompactions.delete(sessionId);
          this.#explicitCompactionFlights.delete(sessionId);
          this.#compactionEffects.delete(sessionId);
          this.#compactionQueueWindows.delete(sessionId);
          this.clearTurnOverrideLeases(sessionId);
          this.#releaseSessionTools(sessionId);
          await Promise.all([
            this.#nativeHistoryTails.get(sessionId) ?? Promise.resolve(),
            this.#runtimeCommandTails.get(sessionId) ?? Promise.resolve(),
            this.#nativeStateTails.get(sessionId) ?? Promise.resolve(),
            ...(this.#inflightEmissions.get(sessionId) ?? [])
          ]);
        }
      }
      return replacements;
    } catch (error) {
      this.releaseHistoryMaintenanceSessions(ids);
      throw error;
    }
  }

  releaseHistoryMaintenanceSessions(sessionIds: readonly string[]): void {
    for (const sessionId of new Set(sessionIds)) {
      this.#active.delete(sessionId);
      this.#nativeCompactions.delete(sessionId);
      this.#explicitCompactionFlights.delete(sessionId);
      this.#compactionEffects.delete(sessionId);
      this.#compactionQueueWindows.delete(sessionId);
      this.clearTurnOverrideLeases(sessionId);
      this.#releaseSessionTools(sessionId);
      this.#sessionResetLocks.delete(sessionId);
    }
  }

  async resetSession<T>(input: {
    readonly operationId: string;
    readonly connection: ConnectionRecord;
    readonly sessionId: string;
    readonly body: unknown;
    readonly precondition?: (store: OperationalStore) => void;
    readonly result: (session: StoredSession) => T;
  }): Promise<OperationExecution<T>> {
    this.#assertOpen();
    this.#clearSessionRuntimeRecovery(input.sessionId);
    if (this.#sessionResetLocks.has(input.sessionId)) {
      throw sessionResetError(
        "SESSION_RESET_IN_PROGRESS",
        "A context clear is already in progress for this task.",
        "Wait for the current clear operation to finish before trying again."
      );
    }
    if (this.#messageDeletionLocks.has(input.sessionId)) {
      throw messageDeletionError(
        "SESSION_MESSAGE_DELETE_IN_PROGRESS",
        "This task is currently deleting a message.",
        "Wait for message deletion to finish before clearing the task."
      );
    }
    const sessionResetAdmission = this.beginBackendAdmissionEffect(
      this.#store.getSession(input.sessionId).descriptor.backendId
    );
    try {
      this.#sessionResetLocks.add(input.sessionId);
    } finally {
      sessionResetAdmission();
    }
    let sourceBinding: NativeSessionBinding | undefined;
    let nextBinding: NativeSessionBinding | undefined;
    const assertPrecondition = (store: OperationalStore): void => {
      input.precondition?.(store);
      this.assertSessionResetSupported(input.sessionId, store);
      this.assertSessionResetIdle(input.sessionId, store);
      if (sourceBinding !== undefined) {
        const current = store.getSession(input.sessionId).descriptor.binding;
        if (!sameNativeBinding(current, sourceBinding)) {
          throw sessionResetError(
            "SESSION_RESET_BINDING_CHANGED",
            "The native task changed while context clear was in progress.",
            "Reload the task and retry clear after it is idle."
          );
        }
      }
    };
    try {
      return await this.mutate({
        operationId: input.operationId,
        connection: input.connection,
        kind: "reset_session",
        body: input.body,
        precondition: assertPrecondition,
        effect: async () => {
          const prepared = await this.prepareSessionReset(input.sessionId);
          sourceBinding = prepared.sourceBinding;
          try {
            const resetBinding = await prepared.active.adapter.resetContext!({
              ...prepared.context,
              // A reset is a boundary effect, not a prompt lifecycle. Native
              // bridge chatter must not leak into either side of that boundary.
              emit: async () => undefined
            });
            nextBinding = resetBinding;
            if (
              resetBinding.opaqueRef === prepared.sourceBinding.opaqueRef ||
              resetBinding.generation <= prepared.sourceBinding.generation
            ) {
              throw sessionResetError(
                "SESSION_RESET_IDENTITY_UNCHANGED",
                "The Backend did not return a fresh native context.",
                "Retry only after the Backend can create a new empty native session."
              );
            }
            await prepared.active.adapter.closeSession(resetBinding, {
              ...prepared.context,
              binding: resetBinding,
              generation: resetBinding.generation,
              emit: async () => undefined
            });
          } catch (error) {
            const uncertainBinding = nextBinding ?? prepared.sourceBinding;
            await prepared.active.adapter.closeSession(
              uncertainBinding,
              {
                ...prepared.context,
                binding: uncertainBinding,
                generation: uncertainBinding.generation,
                emit: async () => undefined
              }
            ).catch(() => undefined);
            if (error instanceof JokoError) throw error;
            throw sessionResetError(
              "SESSION_RESET_EFFECT_FAILED",
              "The Backend could not complete context clear.",
              "The task remains uncleared; retry after confirming the Backend is available.",
              error
            );
          } finally {
            if (this.#active.get(input.sessionId) === prepared.active) this.#active.delete(input.sessionId);
            this.#nativeCompactions.delete(input.sessionId);
            this.#explicitCompactionFlights.delete(input.sessionId);
            this.#compactionEffects.delete(input.sessionId);
            this.#compactionQueueWindows.delete(input.sessionId);
            this.clearTurnOverrideLeases(input.sessionId);
            this.#releaseSessionTools(input.sessionId);
            await Promise.all([
              this.#nativeHistoryTails.get(input.sessionId) ?? Promise.resolve(),
              this.#runtimeCommandTails.get(input.sessionId) ?? Promise.resolve(),
              this.#nativeStateTails.get(input.sessionId) ?? Promise.resolve(),
              ...(this.#inflightEmissions.get(input.sessionId) ?? [])
            ]);
          }
        },
        commit: (store) => {
          if (sourceBinding === undefined || nextBinding === undefined) {
            throw new StoreError("Session reset preparation did not complete.");
          }
          const committed = store.commitSessionReset({
            sessionId: input.sessionId,
            sourceBinding,
            binding: nextBinding,
            operationId: input.operationId,
            traceId: `session-reset:${input.operationId}`
          });
          return input.result(committed.session);
        }
      });
    } finally {
      this.#sessionResetLocks.delete(input.sessionId);
    }
  }

  async abort(sessionId: string, runId: string): Promise<void> {
    this.#clearSessionRuntimeRecovery(sessionId);
    const run = this.#store.getRun(runId);
    if (run.descriptor.sessionId !== sessionId) throw new Error("Run does not belong to the task.");
    const active = await this.activate(sessionId);
    const lease = this.beginActiveBackendSideEffect(sessionId, active);
    try {
      await active.adapter.abort(this.contextFor(
        lease.stored,
        runId,
        run.descriptor.activeAttemptId,
        undefined,
        undefined,
        lease.backendInstanceGeneration
      ));
      this.assertActiveBackendSideEffectLease(lease);
    } finally {
      lease.release();
    }
  }

  async cancelBackgroundTask(sessionId: string, taskId: string, operationId?: string): Promise<void> {
    this.#assertOpen();
    if (sessionId.trim() === "") throw backgroundTaskCancellationError(
      "BACKGROUND_TASK_SESSION_REQUIRED",
      "A task is required to stop background work.",
      "Refresh the task and retry the stop action."
    );
    if (taskId.trim() === "") throw backgroundTaskCancellationError(
      "BACKGROUND_TASK_ID_REQUIRED",
      "A background task identifier is required.",
      "Refresh background tasks and choose an active item."
    );
    if (this.isReviewReadOnlySession(sessionId)) throw backgroundTaskCancellationError(
      "BACKGROUND_TASK_CANCEL_REVIEWER_DENIED",
      "Reviewer background work is controlled only by the Review coordinator.",
      "Stop the owning Review instead of using task controls."
    );

    let stored = this.#store.getSession(sessionId);
    this.assertBackgroundTaskCancellationAvailable(stored, this.requireAdapter(stored.descriptor.backendId));
    this.requireDurableBackgroundTaskOwnership(stored, taskId);

    const active = await this.activate(sessionId);
    stored = this.#store.getSession(sessionId);
    this.assertBackgroundTaskCancellationAvailable(stored, active.adapter);
    const observed = this.requireDurableBackgroundTaskOwnership(stored, taskId);
    const tracked = this.#backgroundTasks.get(sessionId)?.get(taskId);
    if (tracked !== undefined && tracked.generation !== stored.descriptor.binding.generation) {
      throw new StaleGenerationError(stored.descriptor.binding.generation, tracked.generation);
    }

    const lease = this.beginActiveBackendSideEffect(sessionId, active, operationId);
    const cancel = active.adapter.cancelBackgroundTask!;
    try {
      await cancel.call(
        active.adapter,
        this.contextFor(
          lease.stored,
          observed.runId,
          observed.attemptId,
          operationId,
          undefined,
          lease.backendInstanceGeneration
        ),
        taskId
      );
      this.assertActiveBackendSideEffectLease(lease);
      this.touchActiveSession(sessionId);
    } finally {
      lease.release();
    }
  }

  async controlSubagent(
    sessionId: string,
    input: SubagentControlInput,
    operationId?: string
  ): Promise<void> {
    this.#assertOpen();
    if (sessionId.trim() === "") throw subagentControlError(
      "SUBAGENT_SESSION_REQUIRED",
      "A task is required to control delegated work.",
      "Refresh the task before retrying the control action."
    );
    if (input.runId.trim() === "") throw subagentControlError(
      "SUBAGENT_RUN_REQUIRED",
      "A delegated run identifier is required.",
      "Refresh delegated runs and choose a visible item."
    );
    if (input.runId.length > 512 || (input.childId?.length ?? 0) > 512) throw subagentControlError(
      "SUBAGENT_IDENTITY_INVALID",
      "The delegated run or child identifier is too long.",
      "Refresh delegated runs and choose an existing item."
    );
    if (input.action !== "stop" && (input.message === undefined || input.message.trim() === "")) {
      throw subagentControlError(
        "SUBAGENT_MESSAGE_REQUIRED",
        "This delegated-run action requires a message.",
        "Enter a message and retry the action."
      );
    }
    if ((input.message?.length ?? 0) > 32_000 || (input.action === "stop" && input.message?.trim())) {
      throw subagentControlError(
        "SUBAGENT_MESSAGE_INVALID",
        "The delegated-run control message is invalid.",
        "Use no message for stop, or a message of at most 32000 characters for other actions."
      );
    }
    if (this.isReviewReadOnlySession(sessionId)) throw subagentControlError(
      "SUBAGENT_CONTROL_REVIEWER_DENIED",
      "Reviewer delegated work is controlled only by the Review coordinator.",
      "Control the owning Review instead."
    );

    let stored = this.#store.getSession(sessionId);
    let adapter = this.requireAdapter(stored.descriptor.backendId);
    this.assertSubagentControlAvailable(stored, adapter, input.action);
    let resolved = this.requireDurableSubagentControl(stored, input);

    let projection = this.#store.getSessionSubagentRun(sessionId, resolved.runId);
    if (projection === undefined) throw subagentControlError(
      "SUBAGENT_NOT_FOUND",
      "The delegated run is no longer visible in durable history.",
      "Refresh delegated runs before retrying the action."
    );
    const detachedContext = this.contextFor(
      stored,
      projection.event.runId,
      projection.event.attemptId,
      operationId
    );
    if (adapter.controlSubagent !== undefined
        && adapter.supportsDetachedSubagentControl?.(resolved.action, detachedContext) === true) {
      const generation = stored.descriptor.binding.generation;
      const backendGeneration = this.requireAdapterGeneration(stored.descriptor.backendId, adapter);
      const release = this.beginBackendAdmissionEffect(stored.descriptor.backendId);
      try {
        this.assertCurrentAdapterGeneration(stored.descriptor.backendId, adapter, backendGeneration);
        await adapter.controlSubagent(resolved, {
          ...detachedContext,
          backendInstanceGeneration: backendGeneration
        });
        this.assertCurrentAdapterGeneration(stored.descriptor.backendId, adapter, backendGeneration);
        const current = this.#store.getSession(sessionId);
        if (current.descriptor.binding.generation !== generation) {
          throw new StaleGenerationError(generation, current.descriptor.binding.generation);
        }
      } finally {
        release();
      }
      return;
    }

    const active = await this.activate(sessionId);
    stored = this.#store.getSession(sessionId);
    adapter = active.adapter;
    this.assertSubagentControlAvailable(stored, adapter, input.action);
    resolved = this.requireDurableSubagentControl(stored, resolved);
    projection = this.#store.getSessionSubagentRun(sessionId, resolved.runId);
    if (projection === undefined) throw subagentControlError(
      "SUBAGENT_NOT_FOUND",
      "The delegated run is no longer visible in durable history.",
      "Refresh delegated runs before retrying the action."
    );

    const lease = this.beginActiveBackendSideEffect(sessionId, active, operationId);
    try {
      await adapter.controlSubagent!(
        resolved,
        this.contextFor(
          lease.stored,
          projection.event.runId,
          projection.event.attemptId,
          operationId,
          undefined,
          lease.backendInstanceGeneration
        )
      );
      this.assertActiveBackendSideEffectLease(lease);
      this.touchActiveSession(sessionId);
    } finally {
      lease.release();
    }
  }

  async resume(sessionId: string) {
    if (this.isReviewReadOnlySession(sessionId)) throw new StoreError("Reviewer runtimes cannot be resumed.");
    await this.activate(sessionId);
    return this.inspect(sessionId);
  }

  async detach(sessionId: string): Promise<void> {
    if (this.isReviewReadOnlySession(sessionId)) return this.closeReviewer(sessionId);
    this.clearRunSilenceWatchdog(sessionId);
    const active = await this.activate(sessionId);
    const lease = this.beginActiveBackendSideEffect(sessionId, active);
    try {
      if (active.adapter.detachSession !== undefined) {
        await active.adapter.detachSession(lease.stored.descriptor.binding, lease.context);
      } else {
        await active.adapter.closeSession(lease.stored.descriptor.binding, lease.context);
      }
      this.assertActiveBackendSideEffectLease(lease);
      if (this.#active.get(sessionId) === active) this.#active.delete(sessionId);
    } finally {
      lease.release();
    }
    this.#nativeCompactions.delete(sessionId);
    this.clearTurnOverrideLeases(sessionId);
    this.#releaseSessionTools(sessionId);
  }

  async close(sessionId: string): Promise<void> {
    if (this.isReviewReadOnlySession(sessionId)) return this.closeReviewer(sessionId);
    this.clearRunSilenceWatchdog(sessionId);
    const active = await this.activate(sessionId);
    const lease = this.beginActiveBackendSideEffect(sessionId, active);
    try {
      await active.adapter.closeSession(lease.stored.descriptor.binding, lease.context);
      this.assertActiveBackendSideEffectLease(lease);
      if (this.#active.get(sessionId) === active) this.#active.delete(sessionId);
    } finally {
      lease.release();
    }
    this.#nativeCompactions.delete(sessionId);
    this.clearTurnOverrideLeases(sessionId);
    this.#releaseSessionTools(sessionId);
  }

  /**
   * Closes an already-live native runtime without resuming a sleeping one.
   * Calls coalesce so durable cleanup can replay after a later effect fails
   * without reactivating the runtime that the first attempt already closed.
   */
  async closeIfActive(sessionId: string): Promise<void> {
    this.#assertOpen();
    const existing = this.#closeIfActiveFlights.get(sessionId);
    if (existing !== undefined) return existing;
    const task = this.closeIfActiveOnce(sessionId).finally(() => {
      if (this.#closeIfActiveFlights.get(sessionId) === task) {
        this.#closeIfActiveFlights.delete(sessionId);
      }
    });
    this.#closeIfActiveFlights.set(sessionId, task);
    return task;
  }

  /**
   * Synchronous archive admission guard. It is invoked inside the authenticated
   * operation claim transaction, before the durable lifecycle manifest can
   * cancel any queued work. A busy task is therefore left completely intact.
   */
  assertSessionLifecycleIdle(sessionId: string): void {
    this.#assertOpen();
    this.#store.getSession(sessionId);
    if (this.canEnterSessionArchive(sessionId)) return;
    throw new StoreError(
      "A task can be archived only after its runtime, workspace command, background work, and queue are idle."
    );
  }

  /**
   * Quiesces effects that are not represented by a product Run before a
   * destructive close. In particular, user-shell commands can mutate the
   * workspace without owning a Run, so deletion explicitly aborts and awaits
   * their terminal result rather than terminating the transport underneath
   * an unknown external side effect.
   */
  async prepareSessionLifecycleClose(sessionId: string, disposition: "archive" | "delete"): Promise<void> {
    this.#assertOpen();
    if (disposition === "archive") {
      this.assertSessionLifecycleIdle(sessionId);
      // The claimed durable lifecycle fence prevents new work from entering.
      // Let already-published terminal events finish their history, runtime
      // state, command, and workspace-diff projections before closeSession.
      // These tails are internal settlement, not user-visible active work.
      await this.waitForSessionProjectionIdle(sessionId);
      this.assertSessionLifecycleIdle(sessionId);
      return;
    }
    await this.prepareDestructiveSessionClose(sessionId);
  }

  /** Shared quiescence for deletion-owned task disposal, including generated
   * tasks that a Schedule archives. The owning durable manifest is required. */
  async prepareDestructiveSessionClose(sessionId: string): Promise<void> {
    this.#assertOpen();
    this.assertDestructiveSessionCleanupPending(sessionId);
    this.#dismissPendingInteractions(
      new Set([sessionId]),
      "The task is being removed while this interaction is pending."
    );
    for (;;) {
      const request = this.#userShellRequestFlights.get(sessionId);
      const lease = this.#userShells.get(sessionId);
      if (lease !== undefined) {
        lease.abortTask ??= lease.active.adapter.abortUserShell!(lease.context);
        await lease.abortTask;
        await lease.task.catch(() => undefined);
      }
      if (request === undefined && lease === undefined) break;
      await (request?.settled ?? Promise.resolve());
      if (!this.#userShellRequests.has(sessionId) && !this.#userShells.has(sessionId)) break;
    }
    for (;;) {
      const activeEffects = [...(this.#activeEffectFlights.get(sessionId) ?? [])];
      if (activeEffects.length === 0) break;
      await Promise.allSettled(activeEffects);
    }
    await Promise.all([
      this.#activating.get(sessionId)?.then(() => undefined, () => undefined) ?? Promise.resolve(),
      this.#dispatchPreparations.get(sessionId)?.settled ?? Promise.resolve(),
      this.#drainSettlements.get(sessionId) ?? Promise.resolve(),
      this.#nativeHistoryTails.get(sessionId) ?? Promise.resolve(),
      this.#runtimeCommandTails.get(sessionId) ?? Promise.resolve(),
      this.#nativeStateTails.get(sessionId) ?? Promise.resolve(),
      ...(this.#inflightEmissions.get(sessionId) ?? [])
    ]);
    this.assertDestructiveSessionCleanupPending(sessionId);
  }

  async deleteNativeSession(sessionId: string, lifecycleOperationId?: string): Promise<void> {
    if (this.isReviewReadOnlySession(sessionId)) throw new StoreError("Reviewer native Sessions cannot be deleted through task controls.");
    this.#clearSessionRuntimeRecovery(sessionId);
    this.clearRunSilenceWatchdog(sessionId);
    const detachedStored = this.#store.getSession(sessionId);
    const lifecycleAdmission = this.#sessionLifecycleBackendAdmissions.get(sessionId);
    if (lifecycleAdmission !== undefined && lifecycleAdmission.operationId !== lifecycleOperationId) {
      throw new StoreError("The native lifecycle effect does not own the admitted task cleanup.");
    }
    const releaseBackendAdmission = lifecycleAdmission === undefined
      ? this.beginBackendAdmissionEffect(detachedStored.descriptor.backendId)
      : undefined;
    try {
      const detachedAdapter = this.requireAdapter(detachedStored.descriptor.backendId);
      const detachedContext = this.contextFor(detachedStored, undefined, undefined, lifecycleOperationId);
      if (detachedAdapter.supportsDetachedSessionDeletion?.(detachedContext) === true) {
        await detachedAdapter.deleteSession(detachedStored.descriptor.binding, detachedContext);
        this.#active.delete(sessionId);
        this.#nativeCompactions.delete(sessionId);
        this.clearTurnOverrideLeases(sessionId);
        this.#sessionRuntimeControl.clear(sessionId);
        this.#releaseSessionTools(sessionId);
        return;
      }
      const active = await this.activateWithPolicy(sessionId, false, false, lifecycleOperationId);
      const stored = this.#store.getSession(sessionId);
      await active.adapter.deleteSession(
        stored.descriptor.binding,
        this.contextFor(stored, undefined, undefined, lifecycleOperationId)
      );
      this.#active.delete(sessionId);
      this.#nativeCompactions.delete(sessionId);
      this.clearTurnOverrideLeases(sessionId);
      this.#sessionRuntimeControl.clear(sessionId);
      this.#releaseSessionTools(sessionId);
    } finally {
      releaseBackendAdmission?.();
    }
  }

  async setName(sessionId: string, name: string): Promise<void> {
    if (this.isReviewReadOnlySession(sessionId)) throw new StoreError("Reviewer runtime settings are immutable.");
    const active = await this.activate(sessionId);
    const lease = this.beginActiveBackendSideEffect(sessionId, active);
    try {
      await active.adapter.setName(name, lease.context);
      this.assertActiveBackendSideEffectLease(lease);
      await this.refreshNativeStateBestEffort(sessionId, active, "native_state_name_sync");
      this.assertActiveBackendSideEffectLease(lease);
    } finally {
      lease.release();
    }
  }

  async setAutoCompaction(sessionId: string, enabled: boolean): Promise<void> {
    if (this.isReviewReadOnlySession(sessionId)) throw new StoreError("Reviewer runtime settings are immutable.");
    const active = await this.activate(sessionId);
    const lease = this.beginActiveBackendSideEffect(sessionId, active);
    try {
      await active.adapter.setAutoCompaction(enabled, lease.context);
      this.assertActiveBackendSideEffectLease(lease);
      await this.refreshNativeStateBestEffort(sessionId, active, "native_state_auto_compaction_sync");
      this.assertActiveBackendSideEffectLease(lease);
    } finally {
      lease.release();
    }
  }

  async setAutoRetry(sessionId: string, enabled: boolean): Promise<void> {
    if (this.isReviewReadOnlySession(sessionId)) throw new StoreError("Reviewer runtime settings are immutable.");
    const active = await this.activate(sessionId);
    const lease = this.beginActiveBackendSideEffect(sessionId, active);
    try {
      await active.adapter.setAutoRetry(enabled, lease.context);
      this.assertActiveBackendSideEffectLease(lease);
      await this.refreshNativeStateBestEffort(sessionId, active, "native_state_auto_retry_sync");
      this.assertActiveBackendSideEffectLease(lease);
    } finally {
      lease.release();
    }
  }

  async abortRetry(sessionId: string): Promise<void> {
    if (this.isReviewReadOnlySession(sessionId)) throw new StoreError("Reviewer runtime settings are immutable.");
    const active = await this.activate(sessionId);
    const lease = this.beginActiveBackendSideEffect(sessionId, active);
    try {
      await active.adapter.abortRetry(lease.context);
      this.assertActiveBackendSideEffectLease(lease);
    } finally {
      lease.release();
    }
  }

  async executeUserShell(sessionId: string, input: UserShellInput, operationId?: string): Promise<UserShellResult> {
    this.#assertOpen();
    if (this.isReviewReadOnlySession(sessionId)) throw new StoreError("Reviewer shell execution is disabled.");
    const command = input.command.trim();
    if (command.length === 0) throw userShellError(
      "USER_SHELL_COMMAND_REQUIRED",
      "A user shell command is required.",
      "Enter a non-empty workspace command."
    );
    if (this.#userShellRequests.has(sessionId) || this.#userShells.has(sessionId)) throw userShellError(
      "USER_SHELL_ALREADY_RUNNING",
      "A user shell command is already running for this task.",
      "Abort or wait for the current user shell command before starting another."
    );

    let resolveRequest!: () => void;
    const requestFlight: UserShellRequestFlight = {
      settled: new Promise<void>((resolve) => { resolveRequest = resolve; }),
      resolve: () => resolveRequest()
    };
    this.#userShellRequests.add(sessionId);
    this.#userShellRequestFlights.set(sessionId, requestFlight);
    try {
      let stored = this.#store.getSession(sessionId);
      this.assertUserShellAvailable(stored, this.requireAdapter(stored.descriptor.backendId));

      const active = await this.activate(sessionId);
      stored = this.#store.getSession(sessionId);
      this.assertUserShellAvailable(stored, active.adapter);

      const generation = stored.descriptor.binding.generation;
      const context = this.contextFor(stored, undefined, undefined, operationId);
      await this.authorizeUserShell(stored, command, context);
      this.assertSessionNotPendingScheduleDeletion(sessionId);
      const current = this.#store.getSession(sessionId);
      if (this.#active.get(sessionId) !== active || current.descriptor.binding.generation !== generation) {
        throw new StaleGenerationError(generation, current.descriptor.binding.generation);
      }

      const execute = active.adapter.executeUserShell!;
      const task = execute.call(active.adapter, { command, excludeFromContext: input.excludeFromContext }, context);
      const lease: UserShellLease = { active, generation, context, task };
      this.#userShells.set(sessionId, lease);
      try {
        const result = await task;
        this.assertUserShellFence(sessionId, lease);
        this.touchActiveSession(sessionId);
        return result;
      } finally {
        if (this.#userShells.get(sessionId) === lease) this.#userShells.delete(sessionId);
      }
    } finally {
      this.#userShellRequests.delete(sessionId);
      if (this.#userShellRequestFlights.get(sessionId) === requestFlight) {
        this.#userShellRequestFlights.delete(sessionId);
      }
      requestFlight.resolve();
    }
  }

  async abortUserShell(sessionId: string): Promise<void> {
    this.#assertOpen();
    const lease = this.#userShells.get(sessionId);
    // Abort is deliberately idempotent. It must not activate a sleeping
    // Backend merely because a client replayed or raced a stop request.
    if (lease === undefined) return;
    this.assertUserShellFence(sessionId, lease);
    lease.abortTask ??= lease.active.adapter.abortUserShell!(lease.context);
    await lease.abortTask;
    this.assertUserShellFence(sessionId, lease);
  }

  async invokeAdapter<T>(
    sessionId: string,
    effect: (adapter: BackendAdapter, context: AdapterContext) => Promise<T>
  ): Promise<T> {
    if (this.isReviewReadOnlySession(sessionId)) throw new StoreError("Reviewer adapter access is host-owned.");
    const active = await this.activate(sessionId);
    const lease = this.beginActiveBackendSideEffect(sessionId, active);
    try {
      const result = await effect(active.adapter, lease.context);
      this.assertActiveBackendSideEffectLease(lease);
      return result;
    } finally {
      lease.release();
    }
  }

  /**
   * Applies an effect only to native runtimes that are already active (or are
   * already being activated by another caller). It never calls activate(), so
   * a durable settings update cannot start an otherwise sleeping session.
   */
  async applyToActiveSessions(
    filter: { readonly backendId: string },
    effect: (sessionId: string, adapter: BackendAdapter, context: AdapterContext) => Promise<void>
  ): Promise<readonly string[]> {
    this.#assertOpen();
    if (filter.backendId.trim() === "") throw new Error("An active runtime filter requires a Backend ID.");
    const candidates = new Set([...this.#active.keys(), ...this.#activating.keys()]);
    const applied: string[] = [];
    for (const sessionId of candidates) {
      if (this.isReviewReadOnlySession(sessionId)) continue;
      if (this.#sessionResetLocks.has(sessionId)) continue;
      if (this.#runtimeRestartFences.has(sessionId)) continue;
      const activating = this.#activating.get(sessionId);
      if (activating !== undefined) await activating.catch(() => undefined);
      const active = this.#active.get(sessionId);
      if (active === undefined || this.#reaping.has(sessionId)) continue;
      const stored = this.#store.getSession(sessionId);
      if (
        stored.descriptor.backendId !== filter.backendId ||
        stored.descriptor.archived ||
        stored.descriptor.deletedAt !== undefined ||
        this.#store.findPendingScheduleDeletionCleanupForSession(sessionId) !== undefined ||
        this.#store.findPendingSessionLifecycleCleanup(sessionId) !== undefined ||
        this.#sessionLifecycleFences.has(sessionId) ||
        this.#runtimeRestartFences.has(sessionId)
      ) continue;
      let lease: ActiveBackendSideEffectLease;
      try {
        lease = this.beginActiveBackendSideEffect(sessionId, active);
      } catch (error) {
        if (this.#backendReplacementFences.has(filter.backendId)) continue;
        throw error;
      }
      try {
        await effect(sessionId, active.adapter, lease.context);
        this.assertActiveBackendSideEffectLease(lease);
        await this.refreshNativeStateBestEffort(sessionId, active, "native_state_active_effect_sync");
        this.assertActiveBackendSideEffectLease(lease);
        applied.push(sessionId);
      } finally {
        lease.release();
      }
    }
    return applied;
  }

  /** Revoke every pending owner decision, then hot-fence the current ordered
   * policy snapshot into already-running Backends without waking idle tasks. */
  async refreshPolicySettings(): Promise<void> {
    this.#assertOpen();
    const sessionIds = new Set(this.#store.listSessions({ includeArchived: true, includeDeleted: true })
      .map((session) => session.descriptor.id));
    this.#dismissPendingInteractions(
      sessionIds,
      "Ordered policy settings changed while the interaction was pending."
    );
    for (const adapter of this.#adapters.values()) {
      if (adapter.setPolicySnapshot === undefined) continue;
      try {
        await this.applyToActiveSessions({ backendId: adapter.id }, async (_sessionId, activeAdapter, context) => {
          await activeAdapter.setPolicySnapshot?.(context);
        });
      } catch (error) {
        this.recordFailure(`policy_settings_reconciliation:${adapter.id}`, error);
      }
    }
  }

  async deriveSession(input: DeriveSessionInput): Promise<OperationExecution<{ readonly sessionId: string }>> {
    if (this.isReviewReadOnlySession(input.sourceSessionId)) {
      throw new StoreError("Reviewer Sessions cannot be attached, forked, or cloned.");
    }
    const persistedOperation = this.#store.findOperation(input.operationId);
    const persistedSourceMessage = derivationSourceMessageFromOperationBody(persistedOperation?.body);
    const sourceMessage = input.sourceMessage
      ?? persistedSourceMessage
      ?? (persistedOperation === undefined
        ? this.#store.findVisibleSessionMessageOrigin({
            sessionId: input.sourceSessionId,
            ...(input.kind === "fork" ? { nativeBoundaryId: requiredEntryId(input.entryId) } : {})
          })
        : undefined);
    if (input.kind === "fork" && sourceMessage === undefined) {
      throw new StoreError("A fork requires a visible source message anchor.");
    }
    const logicalBody = {
      sourceSessionId: input.sourceSessionId,
      title: input.title,
      kind: input.kind,
      ...(input.entryId === undefined ? {} : { entryId: input.entryId }),
      ...(sourceMessage === undefined ? {} : {
        sourceMessageId: sourceMessage.messageId,
        sourceEventId: sourceMessage.eventId
      })
    };
    const claim = this.#store.claimAuthorizedDeferredEffectOperation<{ readonly sessionId: string }>(
      input.connection.id,
      input.connection.authKeyDigest,
      { id: input.operationId, kind: `${input.kind}_session`, body: logicalBody },
      (store) => {
        const source = store.getSession(input.sourceSessionId);
        if (source.descriptor.deletedAt !== undefined) throw new Error("A deleted task cannot be derived.");
        if (input.kind === "fork") requiredEntryId(input.entryId);
        if (sourceMessage !== undefined) {
          const visible = store.findVisibleSessionMessageOrigin({
            sessionId: input.sourceSessionId,
            eventId: sourceMessage.eventId
          });
          if (visible?.messageId !== sourceMessage.messageId) {
            throw new StoreError("The derivation source message is no longer visible.");
          }
        }
      }
    );
    if (!claim.claimed) {
      return { replayed: true, value: claim.value, operation: claim.operation };
    }

    let restoreSource = false;
    let releaseBackendAdmission: (() => void) | undefined;
    let sideEffectLease: ActiveBackendSideEffectLease | undefined;
    try {
      const admittedSource = this.#store.getSession(input.sourceSessionId);
      this.assertInheritedSessionCreationReady(
        admittedSource.descriptor.backendId,
        {
          ...(admittedSource.descriptor.providerId === undefined
            ? {}
            : { providerId: admittedSource.descriptor.providerId }),
          ...(admittedSource.descriptor.modelId === undefined
            ? {}
            : { modelId: admittedSource.descriptor.modelId }),
          fastMode: admittedSource.descriptor.fastMode
        },
        "The source task's model is unavailable for a new derived route."
      );
      releaseBackendAdmission = this.beginBackendAdmissionEffect(admittedSource.descriptor.backendId);
      const active = await this.activate(input.sourceSessionId);
      sideEffectLease = this.beginActiveBackendSideEffect(input.sourceSessionId, active, input.operationId);
      const source = sideEffectLease.stored;
      const sourceContext = sideEffectLease.context;
      // A native clone/fork may switch the current runtime to the derived history. Keep
      // that transient binding out of the source product task's event stream.
      const derivationContext: AdapterContext = { ...sourceContext, emit: async () => undefined };
      const forkResult: NativeSessionForkResult | undefined = input.kind === "fork"
        ? await active.adapter.fork(requiredEntryId(input.entryId), derivationContext)
        : undefined;
      this.assertActiveBackendSideEffectLease(sideEffectLease);
      const binding = forkResult?.binding ?? await active.adapter.clone(derivationContext);
      this.assertActiveBackendSideEffectLease(sideEffectLease);
      const forkEditorText = forkResult?.editorText === undefined
        ? undefined
        : redactSecrets(forkResult.editorText);
      if (active.adapter.detachSession !== undefined) {
        await active.adapter.detachSession(binding, { ...derivationContext, binding });
      } else {
        await active.adapter.closeSession(binding, { ...derivationContext, binding });
      }
      this.assertActiveBackendSideEffectLease(sideEffectLease);
      const sessionId = stableId("session", input.operationId);
      this.#freezeToolPolicies?.(sessionId, source.descriptor.targetId);
      const now = Date.now();
      const execution = this.#store.completeAuthorizedDeferredEffectOperation(
        input.connection.id,
        input.connection.authKeyDigest,
        claim.operation.id,
        claim.operation.bodyHash,
        (store) => {
          const currentSource = store.getSession(input.sourceSessionId);
          assertBindingFence(source, currentSource);
          if (
            store.getBackend(currentSource.descriptor.backendId).descriptor.instanceGeneration
            !== sideEffectLease!.backendInstanceGeneration
          ) throw staleBackendInstanceContextError();
          if (currentSource.descriptor.deletedAt !== undefined) throw new Error("The source task was deleted while it was being derived.");
          const duplicate = store.findLiveSessionByNativeBinding(currentSource.descriptor.backendId, binding.opaqueRef);
          if (duplicate !== undefined) throw nativeBindingConflict(duplicate.descriptor.id);
          const created = store.createSession({
            ...currentSource.descriptor,
            id: sessionId,
            title: input.title.trim() || `${currentSource.descriptor.title} (${input.kind})`,
            binding,
            pinned: false,
            archived: false,
            deletedAt: undefined,
            derivationOrigin: {
              kind: input.kind,
              sourceSessionId: input.sourceSessionId,
              ...(sourceMessage === undefined ? {} : {
                sourceMessageId: sourceMessage.messageId,
                sourceEventId: sourceMessage.eventId
              })
            },
            createdAt: now,
            updatedAt: now
          });
          store.appendEvent({
            id: stableId("event", `${input.operationId}:derived-session`),
            backendId: created.descriptor.backendId,
            targetId: created.descriptor.targetId,
            sessionId,
            operationId: input.operationId,
            generation: binding.generation,
            emittedAt: now,
            traceId: `derived-session:${sessionId}:${binding.generation}`,
            payload: { type: "session_changed" }
          });
          if (forkEditorText !== undefined) {
            store.appendEvent({
              id: stableId("event", `${input.operationId}:fork-editor`),
              backendId: currentSource.descriptor.backendId,
              targetId: currentSource.descriptor.targetId,
              sessionId,
              operationId: input.operationId,
              generation: binding.generation,
              emittedAt: now,
              traceId: `fork-editor:${sessionId}:${binding.generation}`,
              payload: {
                type: "extension_ui_effect",
                effect: "editor_text",
                text: forkEditorText
              },
              metadata: {
                namespace: "joko.native_fork",
                fields: {
                  effect: "editor_text"
                }
              }
            });
          }
          return { sessionId };
        }
      );
      this.assertActiveBackendSideEffectLease(sideEffectLease);
      if (this.#active.get(input.sourceSessionId) === active) this.#active.delete(input.sourceSessionId);
      restoreSource = true;
      return execution;
    } catch (error) {
      return this.failClaimedEffect(`${input.kind}_session`, claim.operation.id, claim.operation.bodyHash, error);
    } finally {
      sideEffectLease?.release();
      releaseBackendAdmission?.();
      if (restoreSource) {
        void this.activate(input.sourceSessionId)
          .catch((error: unknown) => this.recordFailure("restore_source_after_derive", error));
      }
    }
  }

  #sessionRuntimeMutationMustDefer(sessionId: string): boolean {
    return this.#store.listRuns({
      sessionId,
      states: ["running", "waiting", "retrying", "dispatch_unknown"],
      limit: 1
    }).length > 0
      || this.#draining.has(sessionId)
      || this.#dispatchPreparations.has(sessionId)
      || this.#sessionRuntimeControlEffects.has(sessionId);
  }

  async #applyPendingSessionRuntimeControl(sessionId: string): Promise<boolean> {
    return this.#withSessionRuntimeControlLock(sessionId, async () => {
      const stored = this.#store.getSession(sessionId);
      const baseline = sessionRuntimeBaseline(stored.descriptor);
      const snapshot = this.#sessionRuntimeControl.snapshot(sessionId, baseline);
      const pending = snapshot.pending;
      if (pending === undefined) return true;
      if (baseline === undefined || this.#store.listRuns({
        sessionId,
        states: ["running", "waiting", "retrying", "dispatch_unknown"],
        limit: 1
      }).length > 0 || this.#dispatchPreparations.has(sessionId)) return false;
      this.#sessionRuntimeControlEffects.add(sessionId);
      try {
        const active = await this.activate(sessionId);
        if (!this.#sessionRuntimeControl.generationMatches(sessionId, pending.generation)) return false;
        await this.#applySessionRuntimeProfile(sessionId, active, pending.profile);
        if (!this.#sessionRuntimeControl.settlePending(sessionId, pending.generation)) return false;
        this.#publishSessionRuntimeControlChanged(this.#store.getSession(sessionId));
        return true;
      } catch (error) {
        this.recordFailure("session_runtime_control_boundary", error);
        return false;
      } finally {
        this.#sessionRuntimeControlEffects.delete(sessionId);
      }
    });
  }

  async #applySessionRuntimeProfile(
    sessionId: string,
    active: ActiveSession,
    profile: SessionRuntimeProfile
  ): Promise<void> {
    const durable = this.#store.getSession(sessionId);
    if (durable.descriptor.backendId !== profile.backendId) {
      throw new SessionRuntimeControlError("ROUTE_UNAVAILABLE", "Runtime control cannot switch Backend.");
    }
    const baseline = sessionRuntimeBaseline(durable.descriptor);
    const current = this.#sessionRuntimeControl.snapshot(sessionId, baseline).effective;
    if (current === undefined) {
      throw new SessionRuntimeControlError("ROUTE_UNAVAILABLE", "The task has no complete runtime profile.");
    }
    const backend = this.#store.getBackend(durable.descriptor.backendId).descriptor;
    const changes = runtimeProfileChanges(current, profile);
    if (changes.model && !this.#modelRoutingEnabled(backend.id, profile.providerId, profile.modelId)) {
      throw new SessionRuntimeControlError("ROUTE_UNAVAILABLE", "The pending model was disabled before it could be applied.");
    }
    this.assertSessionRuntimeProfileCapabilities(backend, changes);
    const lease = this.beginActiveBackendSideEffect(sessionId, active);
    const stored = lease.stored;
    const context = lease.context;
    try {
      if (changes.fastMode && !profile.fastMode) {
        await active.adapter.setFastMode(false, context);
        this.assertActiveBackendSideEffectLease(lease);
      }
      if (changes.model) {
        await active.adapter.setModel(profile.providerId, profile.modelId, context);
        this.assertActiveBackendSideEffectLease(lease);
      }
      if (changes.effort && profile.effort !== undefined) {
        await active.adapter.setEffort(profile.effort, context);
        this.assertActiveBackendSideEffectLease(lease);
      }
      if (changes.fastMode && profile.fastMode) {
        await active.adapter.setFastMode(true, context);
        this.assertActiveBackendSideEffectLease(lease);
      }
      const observed = await this.refreshNativeStateObservation(sessionId, active);
      this.assertActiveBackendSideEffectLease(lease);
      if (
        observed.providerId !== profile.providerId || observed.modelId !== profile.modelId
        || observed.fastMode !== profile.fastMode
        || ((changes.effort || changes.effortClear) && observed.effort !== profile.effort)
      ) {
        throw new SessionRuntimeControlError(
          "ROUTE_UNAVAILABLE",
          "The Backend did not report the requested runtime selection."
        );
      }
      this.persistRuntimeUsage(
        sessionId,
        observed.binding.generation,
        observed.usage,
        false,
        observed.providerId,
        observed.modelId
      );
      this.touchActiveSession(sessionId);
    } catch (error) {
      await active.adapter.closeSession(stored.descriptor.binding, context).catch(() => undefined);
      if (this.#active.get(sessionId) === active) this.#active.delete(sessionId);
      throw error;
    } finally {
      lease.release();
    }
  }

  async #applySessionRuntimeAxes(
    sessionId: string,
    active: ActiveSession,
    current: SessionRuntimeProfile,
    profile: SessionRuntimeProfile,
    patch: SessionRuntimeAxisPatch
  ): Promise<NativeSessionState> {
    const durable = this.#store.getSession(sessionId);
    const changes = runtimeProfileChanges(current, profile);
    this.assertSessionRuntimeProfileCapabilities(
      this.#store.getBackend(durable.descriptor.backendId).descriptor,
      changes
    );
    const lease = this.beginActiveBackendSideEffect(sessionId, active);
    const stored = lease.stored;
    const context = lease.context;
    try {
      if (changes.fastMode && !profile.fastMode) {
        await active.adapter.setFastMode(false, context);
        this.assertActiveBackendSideEffectLease(lease);
      }
      if (changes.effort && patch.effort !== undefined && profile.effort !== undefined) {
        await active.adapter.setEffort(profile.effort, context);
        this.assertActiveBackendSideEffectLease(lease);
      }
      if (changes.fastMode && profile.fastMode) {
        await active.adapter.setFastMode(true, context);
        this.assertActiveBackendSideEffectLease(lease);
      }
      const observed = await this.refreshNativeStateObservation(sessionId, active);
      this.assertActiveBackendSideEffectLease(lease);
      if (
        observed.providerId !== profile.providerId || observed.modelId !== profile.modelId
        || (patch.fastMode !== undefined && observed.fastMode !== profile.fastMode)
        || (patch.effort !== undefined && observed.effort !== profile.effort)
      ) {
        throw new SessionRuntimeControlError(
          "ROUTE_UNAVAILABLE",
          "The Backend did not report the requested runtime axes."
        );
      }
      this.persistRuntimeUsage(
        sessionId,
        observed.binding.generation,
        observed.usage,
        false,
        observed.providerId,
        observed.modelId
      );
      this.touchActiveSession(sessionId);
      return observed;
    } catch (error) {
      await active.adapter.closeSession(stored.descriptor.binding, context).catch(() => undefined);
      if (this.#active.get(sessionId) === active) this.#active.delete(sessionId);
      throw error;
    } finally {
      lease.release();
    }
  }

  async #withSessionRuntimeControlLock<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.#sessionRuntimeControlTails.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => gate);
    this.#sessionRuntimeControlTails.set(sessionId, tail);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.#sessionRuntimeControlTails.get(sessionId) === tail) {
        this.#sessionRuntimeControlTails.delete(sessionId);
      }
    }
  }

  #publishSessionRuntimeControlChanged(stored: StoredSession): void {
    this.#store.appendEvent({
      id: randomUUID(),
      backendId: stored.descriptor.backendId,
      targetId: stored.descriptor.targetId,
      sessionId: stored.descriptor.id,
      generation: stored.descriptor.binding.generation,
      emittedAt: Date.now(),
      traceId: `runtime-control:${stored.descriptor.id}:${randomUUID()}`,
      payload: { type: "session_changed" }
    });
  }

  #clearSessionRuntimeRecovery(
    sessionId: string,
    terminalState: "cancelled" | "succeeded" | "exhausted" = "cancelled",
    terminalError?: PublicError
  ): void {
    const state = this.#sessionRuntimeRecoveries.get(sessionId);
    if (state?.timer !== undefined) clearTimeout(state.timer);
    if (state?.current !== undefined) {
      this.#publishSessionRuntimeRecovery(sessionId, state, terminalState, terminalError);
    }
    this.#sessionRuntimeRecoveries.delete(sessionId);
  }

  #publishSessionRuntimeRecovery(
    sessionId: string,
    state: SessionRuntimeRecoveryState,
    recoveryState: Extract<EventPayload, { readonly type: "runtime_recovery" }>["state"],
    errorOverride?: PublicError
  ): void {
    const current = state.current;
    if (current === undefined) return;
    const stored = this.#store.getSession(sessionId);
    this.#store.appendEvent({
      id: randomUUID(),
      backendId: stored.descriptor.backendId,
      targetId: stored.descriptor.targetId,
      sessionId,
      ...(current.continuationRunId === undefined ? {} : { runId: current.continuationRunId }),
      generation: stored.descriptor.binding.generation,
      emittedAt: Date.now(),
      traceId: `runtime-recovery:${current.recoveryId}:${recoveryState}`,
      payload: {
        type: "runtime_recovery",
        recoveryId: current.recoveryId,
        sourceRunId: current.sourceRunId,
        ...(current.continuationRunId === undefined ? {} : { continuationRunId: current.continuationRunId }),
        state: recoveryState,
        attempt: current.attempt,
        maximumAttempts: SESSION_RUNTIME_RECOVERY_MAX_CONSECUTIVE_ATTEMPTS,
        sessionTotal: state.totalAttempts,
        ...(recoveryState === "waiting" ? { delayMs: current.delayMs } : {}),
        ...(current.routeChanged === true ? { routeChanged: true } : {}),
        error: errorOverride ?? current.error
      }
    });
  }

  #noteSessionRuntimeRecoveryProgress(sessionId: string, runId: string, payload: EventPayload): void {
    const state = this.#sessionRuntimeRecoveries.get(sessionId);
    if (state?.currentRunId !== runId || !isSubstantiveSessionRuntimeProgress(payload)) return;
    state.consecutiveAttempts = 0;
  }

  #terminalRunError(sessionId: string, runId: string): PublicError | undefined {
    const event = this.#store.listEvents({ sessionId, order: "desc", limit: 1_000 })
      .find((candidate) => candidate.runId === runId
        && candidate.payload.type === "error" && candidate.payload.terminal);
    return event?.payload.type === "error" ? event.payload.error : undefined;
  }

  #scheduleSessionRuntimeRecovery(sessionId: string, runId: string, error: PublicError): void {
    if (!isSafeSessionRuntimeRecoveryError(error)) {
      const current = this.#sessionRuntimeRecoveries.get(sessionId);
      if (current?.currentRunId === runId) this.#clearSessionRuntimeRecovery(sessionId, "exhausted", error);
      return;
    }
    const run = this.#store.getRun(runId).descriptor;
    const item = this.#store.findQueueItemByRunId(sessionId, runId, { includeCleared: true });
    const current = this.#sessionRuntimeRecoveries.get(sessionId);
    const ownedContinuation = run.source === "system" && current?.currentRunId === runId;
    if (
      item === undefined
      || (run.source !== "user" && !ownedContinuation)
      || (run.source === "user" && item.disposition !== "prompt")
      || contextRecoveryEvidence(this.#store, sessionId, runId).hasExternalDispatchOwner
    ) {
      if (ownedContinuation) this.#clearSessionRuntimeRecovery(sessionId, "exhausted", error);
      return;
    }
    const state = current ?? {
      token: 0,
      consecutiveAttempts: 0,
      episodeAttempts: 0,
      totalAttempts: 0,
      rootRunId: runId
    };
    if (state.timer !== undefined) return;
    if (
      state.consecutiveAttempts >= SESSION_RUNTIME_RECOVERY_MAX_CONSECUTIVE_ATTEMPTS
      || state.episodeAttempts >= SESSION_RUNTIME_RECOVERY_MAX_EPISODE_ATTEMPTS
    ) {
      this.#clearSessionRuntimeRecovery(sessionId, "exhausted", error);
      return;
    }
    if (ownedContinuation && state.current !== undefined) {
      this.#publishSessionRuntimeRecovery(sessionId, state, "failed");
    }
    state.currentRunId = undefined;
    state.consecutiveAttempts += 1;
    state.episodeAttempts += 1;
    state.totalAttempts += 1;
    state.token += 1;
    const token = state.token;
    const delayMs = this.#sessionRuntimeRecoveryDelayMs(state.consecutiveAttempts);
    state.current = {
      recoveryId: stableId(
        "runtime-recovery-row",
        `${sessionId}:${state.rootRunId}:${state.episodeAttempts}`
      ),
      sourceRunId: runId,
      attempt: state.consecutiveAttempts,
      delayMs,
      error
    };
    state.timer = setTimeout(() => {
      if (this.#sessionRuntimeRecoveries.get(sessionId) !== state || state.token !== token) return;
      state.timer = undefined;
      void this.#dispatchSessionRuntimeRecovery(sessionId, runId, token)
        .catch((recoveryError: unknown) => {
          this.recordFailure("session_runtime_recovery", recoveryError);
          if (this.#sessionRuntimeRecoveries.get(sessionId) === state && state.token === token) {
            this.#clearSessionRuntimeRecovery(sessionId, "exhausted");
          }
        });
    }, delayMs);
    this.#sessionRuntimeRecoveries.set(sessionId, state);
    this.#publishSessionRuntimeRecovery(sessionId, state, "waiting");
  }

  async #dispatchSessionRuntimeRecovery(sessionId: string, failedRunId: string, token: number): Promise<void> {
    const state = this.#sessionRuntimeRecoveries.get(sessionId);
    if (state === undefined || state.token !== token || this.#disposed) return;
    const stored = this.#store.getSession(sessionId);
    if (stored.descriptor.archived || stored.descriptor.deletedAt !== undefined) {
      this.#clearSessionRuntimeRecovery(sessionId);
      return;
    }
    const hasNewWork = listAllRuns(this.#store, { sessionId, activeOnly: true }).length > 0
      || listAllQueueItems(this.#store, { sessionId, states: ["accepted", "dispatching"] }).length > 0;
    if (hasNewWork) {
      this.#clearSessionRuntimeRecovery(sessionId);
      return;
    }
    const routeChanged = state.episodeAttempts >= 2
      ? await this.#applyAutomaticSessionRuntimeFallback(sessionId)
      : false;
    if (this.#sessionRuntimeRecoveries.get(sessionId) !== state || state.token !== token) return;
    const source = this.#store.findQueueItemByRunId(sessionId, failedRunId, { includeCleared: true });
    if (source === undefined) {
      this.#clearSessionRuntimeRecovery(sessionId);
      return;
    }
    const evidence = contextRecoveryEvidence(this.#store, sessionId, failedRunId);
    const continuation = state.current;
    if (continuation === undefined || continuation.sourceRunId !== failedRunId) {
      this.#clearSessionRuntimeRecovery(sessionId, "cancelled");
      return;
    }
    const automaticContinuation = {
      recoveryId: continuation.recoveryId,
      sourceRunId: continuation.sourceRunId,
      attempt: continuation.attempt,
      maximumAttempts: SESSION_RUNTIME_RECOVERY_MAX_CONSECUTIVE_ATTEMPTS,
      sessionTotal: state.totalAttempts
    };
    const prompt: PromptInput = evidence.hasAssistantOrToolEffects
      ? {
          text: "Continue from the interrupted response. Do not repeat completed work or side effects.",
          images: [],
          files: [],
          mentions: [],
          disposition: "follow_up",
          automaticContinuation
        }
      : { ...source.body, automaticContinuation };
    const operationId = stableId(
      "runtime-recovery",
      `${sessionId}:${state.rootRunId}:${state.episodeAttempts}:${token}`
    );
    const recovery = this.enqueueServiceInput({
      operationId,
      sessionId,
      prompt,
      source: "system",
      parentRunId: failedRunId
    });
    state.currentRunId = recovery.value.runId;
    continuation.continuationRunId = recovery.value.runId;
    if (routeChanged) continuation.routeChanged = true;
    this.#publishSessionRuntimeRecovery(sessionId, state, "running");
  }

  async #applyAutomaticSessionRuntimeFallback(sessionId: string): Promise<boolean> {
    if (!this.#sessionRuntimeFallbackEnabled()) return false;
    const stored = this.#store.getSession(sessionId);
    const baseline = sessionRuntimeBaseline(stored.descriptor);
    if (baseline === undefined) return false;
    const snapshot = this.#sessionRuntimeControl.snapshot(sessionId, baseline);
    if (snapshot.pending !== undefined || snapshot.effective === undefined) return false;
    const backend = this.#store.getBackend(stored.descriptor.backendId).descriptor;
    const context = this.#sessionRuntimeFallbackContext(stored.descriptor.backendId);
    const candidate = pickSessionRuntimeFallback({
      current: snapshot.effective,
      models: backend.models.filter((model) =>
        this.#modelRoutingEnabled(backend.id, model.providerId, model.modelId)),
      availableProviderIds: context.availableProviderIds,
      ...(context.explicitDefault === undefined ? {} : { explicitDefault: context.explicitDefault }),
      visitedRoutes: snapshot.visitedRoutes,
      currentHop: snapshot.fallbackHop,
      maxHops: 2,
      fastModeSupported: backend.capabilities.get("model.fast_mode")?.supported === true
    });
    if (candidate === undefined) return false;
    try {
      const result = await this.setSessionRuntimeControl({
        sessionId,
        expectedGeneration: snapshot.generation,
        patch: {
          providerId: candidate.providerId,
          modelId: candidate.modelId,
          ...(candidate.effort === undefined ? {} : { effort: candidate.effort }),
          fastMode: candidate.fastMode
        },
        source: "fallback"
      });
      return result.status === "applied";
    } catch (error) {
      this.#sessionRuntimeControl.recordFailedFallbackCandidate(
        sessionId,
        snapshot.generation,
        candidate
      );
      this.recordFailure("session_runtime_fallback", error);
      return false;
    }
  }

  async applySessionSettings(sessionId: string, fields: {
    readonly providerId?: string;
    readonly modelId?: string;
    readonly effort?: string;
    readonly fastMode?: boolean;
    readonly permissionMode?: PermissionMode;
    readonly planMode?: boolean;
  }, options: {
    /** Require one generation-fenced native observation before the caller commits resolved settings. */
    readonly requireNativeObservation?: boolean;
  } = {}): Promise<NativeSessionState | undefined> {
    if (this.isReviewReadOnlySession(sessionId)) throw new StoreError("Reviewer runtime settings are immutable.");
    const stored = this.#store.getSession(sessionId);
    const backend = this.#store.getBackend(stored.descriptor.backendId).descriptor;
    const hasProvider = fields.providerId !== undefined;
    const hasModel = fields.modelId !== undefined;
    if (hasProvider !== hasModel || fields.providerId?.trim() === "" || fields.modelId?.trim() === "") {
      throw turnOverrideError(
        "SESSION_MODEL_INVALID",
        "Task model selection requires both non-empty provider and model IDs."
      );
    }
    const providerId = fields.providerId ?? stored.descriptor.providerId;
    const modelId = fields.modelId ?? stored.descriptor.modelId;
    const fastMode = fields.fastMode ?? stored.descriptor.fastMode;
    const modelChanged = hasProvider && hasModel && (
      providerId !== stored.descriptor.providerId || modelId !== stored.descriptor.modelId
    );
    const effortChanged = fields.effort !== undefined && fields.effort !== stored.descriptor.effort;
    const fastModeChanged = fields.fastMode !== undefined && fields.fastMode !== stored.descriptor.fastMode;
    const permissionModeChanged = fields.permissionMode !== undefined &&
      fields.permissionMode !== stored.descriptor.permissionMode;
    const planModeChanged = fields.planMode !== undefined && fields.planMode !== stored.descriptor.planMode;
    const selectedModel = providerId === undefined || modelId === undefined
      ? undefined
      : backend.models.find((candidate) =>
          candidate.providerId === providerId && candidate.modelId === modelId);
    if (hasProvider && selectedModel === undefined) {
      throw turnOverrideError(
        "SESSION_MODEL_UNAVAILABLE",
        "The selected task model is not present in the current Backend catalog."
      );
    }
    if (
      modelChanged && providerId !== undefined && modelId !== undefined
      && !this.#modelRoutingEnabled(backend.id, providerId, modelId)
    ) {
      throw turnOverrideError(
        "SESSION_MODEL_UNAVAILABLE",
        "The selected task model is disabled for new routes."
      );
    }
    if (modelChanged && backend.capabilities.get("model.switch")?.supported !== true) {
      throw turnOverrideError(
        "SESSION_MODEL_SWITCH_UNSUPPORTED",
        "The selected Backend does not support task model switching."
      );
    }
    if (effortChanged && (
      backend.capabilities.get("model.effort")?.supported !== true ||
      selectedModel === undefined || !selectedModel.thinkingLevels.includes(fields.effort!)
    )) {
      throw turnOverrideError(
        "SESSION_EFFORT_UNSUPPORTED",
        "The selected Backend model does not support the requested effort."
      );
    }
    this.validateFastSelection(
      stored.descriptor.backendId,
      providerId,
      modelId,
      fastMode,
      "Applying the selected task model"
    );
    if (fastModeChanged && backend.capabilities.get("model.fast_mode")?.supported !== true) {
      throw turnOverrideError(
        "SESSION_FAST_MODE_UNSUPPORTED",
        "The selected Backend does not support task Fast Mode changes."
      );
    }
    if (permissionModeChanged) {
      const change = backend.capabilities.get("permission.change");
      const modes = backend.capabilities.get("permission.modes");
      if (
        change?.supported !== true || modes?.supported !== true ||
        !modes.options?.includes(fields.permissionMode!)
      ) {
        throw turnOverrideError(
          "SESSION_PERMISSION_MODE_UNSUPPORTED",
          "The selected Backend does not support the requested task permission mode."
        );
      }
    }
    if (planModeChanged && backend.capabilities.get("plan_mode")?.supported !== true) {
      throw turnOverrideError(
        "SESSION_PLAN_MODE_UNSUPPORTED",
        "The selected Backend does not support task plan mode changes."
      );
    }
    this.#dismissPendingInteractions(
      new Set([sessionId]),
      "Execution policy changed while the interaction was pending."
    );
    const active = await this.activate(sessionId);
    const lease = this.beginActiveBackendSideEffect(sessionId, active);
    try {
      const currentBackend = this.#store.getBackend(lease.backendId).descriptor;
      if (currentBackend.instanceGeneration !== backend.instanceGeneration) {
        throw new StoreError("The Backend process instance changed while task settings were being admitted.");
      }
      const context = lease.context;
      if (fastModeChanged && fields.fastMode === false) {
        await active.adapter.setFastMode(false, context);
        this.assertActiveBackendSideEffectLease(lease);
      }
      if (modelChanged && fields.providerId !== undefined && fields.modelId !== undefined) {
        await active.adapter.setModel(fields.providerId, fields.modelId, context);
        this.assertActiveBackendSideEffectLease(lease);
      }
      if (effortChanged && fields.effort !== undefined) {
        await active.adapter.setEffort(fields.effort, context);
        this.assertActiveBackendSideEffectLease(lease);
      }
      if (fastModeChanged && fields.fastMode === true) {
        await active.adapter.setFastMode(true, context);
        this.assertActiveBackendSideEffectLease(lease);
      }
      if (permissionModeChanged && fields.permissionMode !== undefined) {
        await active.adapter.setPermissionMode(fields.permissionMode, context);
        this.assertActiveBackendSideEffectLease(lease);
      }
      if (planModeChanged && fields.planMode !== undefined) {
        await active.adapter.setPlanMode(fields.planMode, context);
        this.assertActiveBackendSideEffectLease(lease);
      }
      if (options.requireNativeObservation === true) {
        const state = await this.refreshNativeStateObservation(sessionId, active);
        this.assertActiveBackendSideEffectLease(lease);
        this.persistRuntimeUsage(sessionId, state.binding.generation, state.usage, false, state.providerId, state.modelId);
        return state;
      }
      await this.refreshNativeStateBestEffort(sessionId, active, "native_state_session_settings_sync");
      this.assertActiveBackendSideEffectLease(lease);
      return undefined;
    } finally {
      lease.release();
    }
  }

  /** Refresh live root policies; a failed refresh fences the stale runtime. */
  async refreshTargetExtraDirectories(targetId: string): Promise<void> {
    this.fencePendingInteractionsForTarget(
      targetId,
      "Approved extra-directory policy changed while the interaction was pending."
    );
    const target = this.#store.getTarget(targetId).descriptor;
    const backend = this.#store.getBackend(target.backendId).descriptor;
    if (backend.capabilities.get("workspace.extra_dirs")?.supported !== true) return;
    const registered = this.#adapters.get(target.backendId);
    if (registered?.setExtraDirectories === undefined) {
      throw extraDirectoryCapabilityInvariant(target.backendId);
    }
    const directories = this.extraDirectories.listForTarget(targetId);
    for (const session of this.#store.listSessions({ targetId, includeArchived: true })) {
      if (this.isReviewReadOnlySession(session.descriptor.id)) continue;
      const active = this.#active.get(session.descriptor.id);
      if (active === undefined) continue;
      if (active.adapter.setExtraDirectories === undefined) {
        throw extraDirectoryCapabilityInvariant(target.backendId);
      }
      let lease: ActiveBackendSideEffectLease;
      try {
        lease = this.beginActiveBackendSideEffect(session.descriptor.id, active);
      } catch (error) {
        if (this.#backendReplacementFences.has(session.descriptor.backendId)) continue;
        throw error;
      }
      const context: AdapterContext = { ...lease.context, extraDirectories: directories };
      try {
        await active.adapter.setExtraDirectories(directories, context);
        this.assertActiveBackendSideEffectLease(lease);
      } catch (error) {
        await active.adapter.closeSession(lease.stored.descriptor.binding, context).catch(() => undefined);
        if (this.#active.get(session.descriptor.id) === active) this.#active.delete(session.descriptor.id);
        throw error;
      } finally {
        lease.release();
      }
    }
  }

  private assertSessionRuntimeProfileCapabilities(
    backend: BackendDescriptor,
    changes: RuntimeProfileChanges
  ): void {
    if (changes.effortClear && !changes.model) {
      throw new SessionRuntimeControlError(
        "ROUTE_UNAVAILABLE",
        "The selected Backend does not expose an exact same-model effort reset."
      );
    }
    const unsupported = changes.model && backend.capabilities.get("model.switch")?.supported !== true
      ? "model switching"
      : changes.effort && backend.capabilities.get("model.effort")?.supported !== true
        ? "effort changes"
        : changes.fastMode && backend.capabilities.get("model.fast_mode")?.supported !== true
          ? "Fast Mode changes"
          : undefined;
    if (unsupported === undefined) return;
    throw new SessionRuntimeControlError(
      "ROUTE_UNAVAILABLE",
      `The selected Backend does not support runtime ${unsupported}.`
    );
  }

  private validateTurnOverrides(sessionId: string, overrides: TurnExecutionOverrides | undefined): void {
    if (overrides === undefined) return;
    const stored = this.#store.getSession(sessionId);
    const backend = this.#store.getBackend(stored.descriptor.backendId).descriptor;
    const hasProvider = overrides.providerId !== undefined;
    const hasModel = overrides.modelId !== undefined;
    if (hasProvider !== hasModel || (overrides.providerId?.trim() === "") || (overrides.modelId?.trim() === "")) {
      throw turnOverrideError("TURN_OVERRIDE_MODEL_INVALID", "Per-turn model selection requires both provider and model IDs.");
    }
    if (hasProvider && (stored.descriptor.providerId === undefined || stored.descriptor.modelId === undefined)) {
      throw turnOverrideError(
        "TURN_OVERRIDE_MODEL_BASELINE_MISSING",
        "A per-turn model cannot be restored because the product task has no durable model baseline."
      );
    }
    const modelChanged = hasProvider && hasModel && (
      overrides.providerId !== stored.descriptor.providerId ||
      overrides.modelId !== stored.descriptor.modelId
    );
    if (modelChanged && backend.capabilities.get("model.switch")?.supported !== true) {
      throw turnOverrideError(
        "TURN_OVERRIDE_MODEL_UNSUPPORTED",
        "The selected Backend does not support per-turn model switching."
      );
    }
    const effectiveProviderId = overrides.providerId ?? stored.descriptor.providerId;
    const effectiveModelId = overrides.modelId ?? stored.descriptor.modelId;
    const effectiveModel = effectiveProviderId === undefined || effectiveModelId === undefined
      ? undefined
      : backend.models.find((candidate) =>
          candidate.providerId === effectiveProviderId && candidate.modelId === effectiveModelId);
    if (hasProvider && effectiveModel === undefined) {
      throw turnOverrideError(
        "TURN_OVERRIDE_MODEL_UNAVAILABLE",
        "The requested per-turn model is not present in the current Backend catalog."
      );
    }
    if (
      modelChanged && effectiveProviderId !== undefined && effectiveModelId !== undefined
      && !this.#modelRoutingEnabled(backend.id, effectiveProviderId, effectiveModelId)
    ) {
      throw turnOverrideError(
        "TURN_OVERRIDE_MODEL_UNAVAILABLE",
        "The requested per-turn model is disabled for new routes."
      );
    }
    if (overrides.effort !== undefined) {
      if (overrides.effort.trim() === "") throw turnOverrideError("TURN_OVERRIDE_EFFORT_INVALID", "Per-turn effort must not be empty.");
      if (stored.descriptor.effort === undefined) {
        throw turnOverrideError(
          "TURN_OVERRIDE_EFFORT_BASELINE_MISSING",
          "Per-turn effort cannot be restored because the product task has no durable effort baseline."
        );
      }
      if (overrides.effort !== stored.descriptor.effort) {
        if (backend.capabilities.get("model.effort")?.supported !== true) {
          throw turnOverrideError(
            "TURN_OVERRIDE_EFFORT_UNSUPPORTED",
            "The selected Backend does not support per-turn effort changes."
          );
        }
        if (effectiveModel === undefined || !effectiveModel.thinkingLevels.includes(overrides.effort)) {
          throw turnOverrideError(
            "TURN_OVERRIDE_EFFORT_UNAVAILABLE",
            "The requested per-turn effort is unavailable for the effective model."
          );
        }
      }
    }
    const effectiveFastMode = overrides.fastMode ?? stored.descriptor.fastMode;
    this.validateFastSelection(
      stored.descriptor.backendId,
      overrides.providerId ?? stored.descriptor.providerId,
      overrides.modelId ?? stored.descriptor.modelId,
      effectiveFastMode,
      "Applying the per-turn model policy"
    );
    if (
      overrides.fastMode !== undefined &&
      overrides.fastMode !== stored.descriptor.fastMode &&
      backend.capabilities.get("model.fast_mode")?.supported !== true
    ) {
      throw turnOverrideError(
        "TURN_OVERRIDE_FAST_MODE_UNSUPPORTED",
        "The selected Backend does not support per-turn Fast Mode changes."
      );
    }
    if (
      overrides.permissionMode !== undefined &&
      overrides.permissionMode !== "ask" &&
      overrides.permissionMode !== "auto" &&
      overrides.permissionMode !== "bypassPermissions"
    ) {
      throw turnOverrideError("TURN_OVERRIDE_PERMISSION_INVALID", "Per-turn permission mode is invalid.");
    }
    if (overrides.permissionMode !== undefined && overrides.permissionMode !== stored.descriptor.permissionMode) {
      const change = backend.capabilities.get("permission.change");
      const modes = backend.capabilities.get("permission.modes");
      if (
        change?.supported !== true || modes?.supported !== true ||
        !modes.options?.includes(overrides.permissionMode)
      ) {
        throw turnOverrideError(
          "TURN_OVERRIDE_PERMISSION_UNSUPPORTED",
          "The selected Backend does not support the requested per-turn permission mode."
        );
      }
    }
    if (
      overrides.planMode !== undefined &&
      overrides.planMode !== stored.descriptor.planMode &&
      backend.capabilities.get("plan_mode")?.supported !== true
    ) {
      throw turnOverrideError(
        "TURN_OVERRIDE_PLAN_MODE_UNSUPPORTED",
        "The selected Backend does not support per-turn plan mode changes."
      );
    }
    if (
      overrides.extraDirectoryIds !== undefined &&
      backend.capabilities.get("workspace.extra_dirs")?.supported !== true
    ) {
      throw turnOverrideError(
        "TURN_OVERRIDE_EXTRA_DIRECTORIES_UNSUPPORTED",
        "The selected Backend does not support per-turn extra directories."
      );
    }
    this.extraDirectories.resolveSelection(stored.descriptor.targetId, overrides.extraDirectoryIds);
  }

  assertInputCapabilities(sessionId: string, prompt: PromptInput): void {
    const stored = this.#store.getSession(sessionId);
    const capabilities = this.#store.getBackend(stored.descriptor.backendId).descriptor.capabilities;
    const required = new Set<string>();
    if (prompt.text.trim() !== "") required.add("input.text");
    if (prompt.images.length > 0) required.add("input.image");
    if (prompt.files.length > 0) required.add("input.file");
    if (prompt.mentions.length > 0) required.add("input.mention");
    if (required.size === 0) {
      throw inputCapabilityError(
        "INPUT_EMPTY",
        "Task input must contain text, an image, a file, or a mention."
      );
    }
    if (prompt.disposition === "steer") required.add("turn.steer");
    if (prompt.disposition === "follow_up") required.add("turn.follow_up");
    const unavailable = [...required].find((capability) => capabilities.get(capability)?.supported !== true);
    if (unavailable === undefined) return;
    throw inputCapabilityError(
      "INPUT_CAPABILITY_UNAVAILABLE",
      `The selected Backend does not support ${unavailable}.`
    );
  }

  private async beginTurnOverrideLease(
    item: QueueItemRecord,
    active: ActiveSession,
    stored: StoredSession
  ): Promise<AdapterContext> {
    const overrides = item.executionOverrides;
    const baseContext = this.contextFor(
      stored,
      item.runId,
      item.attemptId,
      item.operationId,
      undefined,
      item.backendInstanceGeneration
    );
    if (!hasTurnOverrides(overrides)) return baseContext;
    this.validateTurnOverrides(stored.descriptor.id, overrides);
    this.#dismissPendingInteractions(
      new Set([stored.descriptor.id]),
      "Per-turn execution policy changed while the interaction was pending."
    );
    const selectedDirectories = overrides.extraDirectoryIds === undefined
      ? this.extraDirectories.listForTarget(stored.descriptor.targetId)
      : this.extraDirectories.resolveSelection(stored.descriptor.targetId, overrides.extraDirectoryIds);
    const baselineDirectories = this.extraDirectories.listForTarget(stored.descriptor.targetId);
    const extraDirectoriesChanged = overrides.extraDirectoryIds !== undefined &&
      !sameDirectorySelection(selectedDirectories, baselineDirectories);
    if (extraDirectoriesChanged && active.adapter.setExtraDirectories === undefined) {
      throw turnOverrideError(
        "TURN_OVERRIDE_EXTRA_DIRECTORIES_UNSUPPORTED",
        "The selected Backend cannot apply extra directories for a turn."
      );
    }
    const context = this.contextFor(
      stored,
      item.runId,
      item.attemptId,
      item.operationId,
      selectedDirectories,
      item.backendInstanceGeneration
    );
    const modelChanged = overrides.providerId !== undefined && overrides.modelId !== undefined && (
      overrides.providerId !== stored.descriptor.providerId ||
      overrides.modelId !== stored.descriptor.modelId
    );
    const effortChanged = overrides.effort !== undefined && overrides.effort !== stored.descriptor.effort;
    const fastModeChanged = overrides.fastMode !== undefined && overrides.fastMode !== stored.descriptor.fastMode;
    const permissionModeChanged = overrides.permissionMode !== undefined &&
      overrides.permissionMode !== stored.descriptor.permissionMode;
    const planModeChanged = overrides.planMode !== undefined && overrides.planMode !== stored.descriptor.planMode;
    const lease: TurnOverrideLease = {
      runId: item.runId,
      sessionId: stored.descriptor.id,
      generation: stored.descriptor.binding.generation,
      providerId: stored.descriptor.providerId,
      modelId: stored.descriptor.modelId,
      effort: stored.descriptor.effort,
      fastMode: stored.descriptor.fastMode,
      permissionMode: stored.descriptor.permissionMode,
      planMode: stored.descriptor.planMode,
      modelChanged,
      effortChanged,
      fastModeChanged,
      permissionModeChanged,
      planModeChanged,
      extraDirectories: baselineDirectories,
      extraDirectoriesChanged
    };
    try {
      if (fastModeChanged && overrides.fastMode === false) {
        await active.adapter.setFastMode(false, context);
        this.assertSessionNotPendingScheduleDeletion(stored.descriptor.id);
      }
      if (modelChanged && overrides.providerId !== undefined && overrides.modelId !== undefined) {
        await active.adapter.setModel(overrides.providerId, overrides.modelId, context);
        this.assertSessionNotPendingScheduleDeletion(stored.descriptor.id);
      }
      if (effortChanged && overrides.effort !== undefined) {
        await active.adapter.setEffort(overrides.effort, context);
        this.assertSessionNotPendingScheduleDeletion(stored.descriptor.id);
      }
      if (fastModeChanged && overrides.fastMode === true) {
        await active.adapter.setFastMode(true, context);
        this.assertSessionNotPendingScheduleDeletion(stored.descriptor.id);
      }
      if (permissionModeChanged && overrides.permissionMode !== undefined) {
        await active.adapter.setPermissionMode(overrides.permissionMode, context);
        this.assertSessionNotPendingScheduleDeletion(stored.descriptor.id);
      }
      if (planModeChanged && overrides.planMode !== undefined) {
        await active.adapter.setPlanMode(overrides.planMode, context);
        this.assertSessionNotPendingScheduleDeletion(stored.descriptor.id);
      }
      if (extraDirectoriesChanged) {
        await active.adapter.setExtraDirectories!(selectedDirectories, context);
        this.assertSessionNotPendingScheduleDeletion(stored.descriptor.id);
      }
      this.assertSessionNotPendingScheduleDeletion(stored.descriptor.id);
      this.#turnOverrideLeases.set(item.runId, lease);
      return context;
    } catch (error) {
      if (
        this.#sessionLifecycleFences.has(stored.descriptor.id)
        || this.#store.findPendingSessionLifecycleCleanup(stored.descriptor.id) !== undefined
        || this.#store.findPendingScheduleDeletionCleanupForSession(stored.descriptor.id) !== undefined
      ) {
        throw error;
      }
      await this.restoreRuntimeConfiguration(lease, active, context).catch(async () => {
        await active.adapter.closeSession(stored.descriptor.binding, context).catch(() => undefined);
        this.#active.delete(stored.descriptor.id);
      });
      throw error;
    }
  }

  private async restoreTurnOverrideLease(runId: string): Promise<void> {
    const lease = this.#turnOverrideLeases.get(runId);
    if (lease === undefined) return;
    if (
      this.#sessionLifecycleFences.has(lease.sessionId)
      || this.#store.findPendingSessionLifecycleCleanup(lease.sessionId) !== undefined
      || this.#store.findPendingScheduleDeletionCleanupForSession(lease.sessionId) !== undefined
    ) {
      this.#turnOverrideLeases.delete(runId);
      return;
    }
    const active = this.#active.get(lease.sessionId);
    if (active === undefined) {
      this.#turnOverrideLeases.delete(runId);
      return;
    }
    const stored = this.#store.getSession(lease.sessionId);
    if (stored.descriptor.binding.generation !== lease.generation) {
      this.#turnOverrideLeases.delete(runId);
      return;
    }
    let sideEffect: ActiveBackendSideEffectLease;
    try {
      sideEffect = this.beginActiveBackendSideEffect(lease.sessionId, active);
    } catch (error) {
      if (this.#backendReplacementFences.has(stored.descriptor.backendId)) {
        this.#turnOverrideLeases.delete(runId);
        return;
      }
      throw error;
    }
    this.#turnOverrideLeases.delete(runId);
    this.#dismissPendingInteractions(
      new Set([lease.sessionId]),
      "Per-turn execution policy lease ended while the interaction was pending."
    );
    const context = this.contextFor(
      sideEffect.stored,
      runId,
      undefined,
      undefined,
      lease.extraDirectories,
      sideEffect.backendInstanceGeneration
    );
    try {
      await this.restoreRuntimeConfiguration(lease, active, context);
      this.assertActiveBackendSideEffectLease(sideEffect);
    } catch (error) {
      await active.adapter.closeSession(sideEffect.stored.descriptor.binding, context).catch(() => undefined);
      if (this.#active.get(lease.sessionId) === active) this.#active.delete(lease.sessionId);
      this.recordFailure("turn_override_restore", error);
    } finally {
      sideEffect.release();
    }
  }

  private async restoreRuntimeConfiguration(
    lease: TurnOverrideLease,
    active: ActiveSession,
    context: AdapterContext
  ): Promise<void> {
    if (lease.fastModeChanged && !lease.fastMode) await active.adapter.setFastMode(false, context);
    if (lease.modelChanged && lease.providerId !== undefined && lease.modelId !== undefined) {
      await active.adapter.setModel(lease.providerId, lease.modelId, context);
    }
    if (lease.effortChanged && lease.effort !== undefined) await active.adapter.setEffort(lease.effort, context);
    if (lease.fastModeChanged && lease.fastMode) await active.adapter.setFastMode(true, context);
    if (lease.permissionModeChanged) await active.adapter.setPermissionMode(lease.permissionMode, context);
    if (lease.planModeChanged) await active.adapter.setPlanMode(lease.planMode, context);
    if (lease.extraDirectoriesChanged && active.adapter.setExtraDirectories !== undefined) {
      await active.adapter.setExtraDirectories(lease.extraDirectories, context);
    }
  }

  private clearTurnOverrideLeases(sessionId: string): void {
    for (const [runId, lease] of this.#turnOverrideLeases) {
      if (lease.sessionId === sessionId) this.#turnOverrideLeases.delete(runId);
    }
  }

  private async applyScheduledExecution(sessionId: string, value: unknown): Promise<void> {
    if (!isRecord(value)) return;
    const permissionMode = value["permissionMode"];
    await this.applySessionSettings(sessionId, {
      ...(typeof value["providerId"] === "string" && typeof value["modelId"] === "string"
        ? { providerId: value["providerId"], modelId: value["modelId"] }
        : {}),
      ...(typeof value["effort"] === "string" ? { effort: value["effort"] } : {}),
      ...(typeof value["fastMode"] === "boolean" ? { fastMode: value["fastMode"] } : {}),
      ...(permissionMode === "ask" || permissionMode === "auto" || permissionMode === "bypassPermissions"
        ? { permissionMode }
        : {}),
      ...(typeof value["planMode"] === "boolean" ? { planMode: value["planMode"] } : {})
    });
  }

  private failScheduledDispatch(execution: EnqueueResult, error: unknown): void {
    const failure = toPublicError(error, {
      code: "SCHEDULE_EXECUTION_SNAPSHOT_FAILED",
      phase: "schedule",
      retryable: false,
      stateMayHaveChanged: false,
      recovery: "Correct the schedule model, permission, or plan snapshot before triggering it again."
    });
    const queue = this.#store.getQueueItem(execution.queueItemId);
    if (queue.state === "accepted") {
      this.#store.updateQueueState({
        queueItemId: execution.queueItemId,
        state: "failed",
        attemptId: execution.attemptId,
        error: failure,
        traceId: `schedule:${execution.queueItemId}:configuration-failed`
      });
    }
    const run = this.#store.getRun(execution.runId);
    if (run.descriptor.state === "queued") {
      this.#store.updateRunState({
        runId: execution.runId,
        state: "failed",
        activeAttemptId: execution.attemptId,
        error: failure,
        traceId: `schedule:${execution.runId}:configuration-failed`
      });
      this.#store.finishAttempt(execution.attemptId, failure);
    }
    this.recordFailure("schedule_execution_snapshot", failure);
  }

  async compact(sessionId: string, customInstructions?: string): Promise<"compacted" | "noop"> {
    if (this.isReviewReadOnlySession(sessionId)) throw new StoreError("Reviewer compaction is disabled.");
    const trimmedInstructions = customInstructions?.trim();
    const instructions = trimmedInstructions === "" ? undefined : trimmedInstructions;
    const existing = this.#explicitCompactionFlights.get(sessionId);
    if (existing !== undefined) {
      if (existing.instructions === instructions) return existing.promise;
      throw compactionInProgressError();
    }
    // A native/automatic compaction has no explicit result Promise to join.
    // Reject instead of launching a second native compaction against the same history.
    if (this.compactionBlocksDispatch(sessionId)) throw compactionInProgressError();

    // Install the barrier before the first await. A prompt accepted while
    // activation or the compact RPC is starting must remain durably queued.
    const token = this.beginCompactionEffect(sessionId);
    let flight: ExplicitCompactionFlight;
    const promise = Promise.resolve().then(async () => {
      try {
        // If dispatch won the synchronous queue-claim race, let its Backend
        // acceptance resolve before compact() can abort or reject that request.
        // The barrier above prevents a second item from being claimed meanwhile.
        await this.#dispatchPreparations.get(sessionId)?.settled;
        const active = await this.activate(sessionId);
        const stored = this.#store.getSession(sessionId);
        const result = await active.adapter.compact(instructions, this.contextFor(stored));
        if (result === "compacted") {
          // compact() acknowledges the native persistence boundary. Project it
          // immediately so the summary/tree leaf is reconnect-safe before this
          // effect returns, matching navigateTree's persistence-confirmed sync.
          await this.synchronizeNativeHistory(sessionId);
        }
        await this.refreshNativeStateBestEffort(sessionId, active, "native_state_compaction_sync");
        return result;
      } finally {
        this.finishCompactionEffect(sessionId, token);
        if (this.#explicitCompactionFlights.get(sessionId) === flight) {
          this.#explicitCompactionFlights.delete(sessionId);
        }
      }
    });
    flight = { instructions, promise };
    this.#explicitCompactionFlights.set(sessionId, flight);
    return promise;
  }

  async exportSession(sessionId: string): Promise<BlobRef> {
    if (this.isReviewReadOnlySession(sessionId)) throw new StoreError("Reviewer export is disabled.");
    const active = await this.activate(sessionId);
    const lease = this.beginActiveBackendSideEffect(sessionId, active);
    try {
    const artifact = await active.adapter.exportSession(lease.context);
    this.assertActiveBackendSideEffectLease(lease);
    // An adapter may only return the exact BlobRef that its context committed.
    // Reading it here proves that the durable record exists and its storage
    // path is still safe before any Operation can publish the reference.
    const durable = await this.#artifactStore.get(artifact.id);
    if (
      artifact.id !== durable.id ||
      artifact.sha256.toLowerCase() !== durable.sha256.toLowerCase() ||
      artifact.byteLength !== durable.byteLength ||
      artifact.mimeType !== durable.mimeType ||
      artifact.fileName !== durable.fileName
    ) {
      throw new Error("Session export Blob reference does not match the durable Artifact.");
    }
    this.assertActiveBackendSideEffectLease(lease);
    return artifact;
    } finally {
      lease.release();
    }
  }

  /**
   * Builds a full portable task package. The package is materialized as an
   * authenticated Artifact; neither a service path nor the transient password
   * enters durable product state.
   */
  async exportPortableSession(input: ExportPortableSessionInput): Promise<ExportPortableSessionResult> {
    this.#assertOpen();
    if (this.isReviewReadOnlySession(input.sessionId)) throw new StoreError("Reviewer portable export is disabled.");
    const stored = this.#store.getSession(input.sessionId);
    const adapter = this.requireAdapter(stored.descriptor.backendId);
    const capability = this.#store.getBackend(stored.descriptor.backendId).descriptor.capabilities
      .get("session.portable_transfer");
    if (capability?.supported !== true || adapter.exportPortableNativeSession === undefined) {
      throw new JokoError({
        code: "PORTABLE_SESSION_EXPORT_UNSUPPORTED",
        message: "The selected Backend does not support portable task export.",
        phase: "capability",
        retryable: false,
        stateMayHaveChanged: false,
        recovery: "Choose a Backend that advertises session.portable_transfer."
      });
    }

    const active = await this.activate(input.sessionId);
    const lease = this.beginActiveBackendSideEffect(input.sessionId, active);
    const current = lease.stored;
    let nativeSession: Awaited<ReturnType<NonNullable<BackendAdapter["exportPortableNativeSession"]>>>;
    try {
      if (active.adapter !== adapter || active.adapter.exportPortableNativeSession === undefined) {
        throw staleBackendInstanceContextError();
      }
      nativeSession = await active.adapter.exportPortableNativeSession(lease.context);
      this.assertActiveBackendSideEffectLease(lease);
    } finally {
      lease.release();
    }
    const events: PersistedEvent[] = [];
    visitVisibleSessionEvents(this.#store, input.sessionId, (event) => {
      if (event.payload.type !== "message_complete" || event.payload.automaticContinuation !== undefined) return;
      if (events.length >= MAXIMUM_PORTABLE_SESSION_MESSAGES) {
        throw portableSessionProjectionLimitError();
      }
      events.push(event);
    });
    const workerDetail: SubagentRunDetail[] = [];
    const workerPageTokens = new Set<string>();
    let pageToken: string | undefined;
    for (;;) {
      const remaining = MAXIMUM_PORTABLE_SESSION_WORKERS - workerDetail.length;
      if (remaining <= 0) throw portableSessionProjectionLimitError();
      const page = this.#store.listSubagentRuns({
        sessionId: input.sessionId,
        limit: Math.min(100, remaining),
        ...(pageToken === undefined ? {} : { pageToken })
      });
      if (page.totalSize > MAXIMUM_PORTABLE_SESSION_WORKERS || page.runs.length > remaining) {
        throw portableSessionProjectionLimitError();
      }
      workerDetail.push(...page.runs);
      const nextPageToken = page.nextPageToken;
      if (nextPageToken === undefined) break;
      if (nextPageToken === pageToken || workerPageTokens.has(nextPageToken)) {
        throw new StoreError("Portable Session delegated-run pagination returned a cyclic token.");
      }
      workerPageTokens.add(nextPageToken);
      pageToken = nextPageToken;
    }
    const workers = workerDetail.map((run, index) => ({
      id: run.id,
      title: run.title?.trim() || run.description?.trim() || `Worker ${index + 1}`,
      ...(run.description?.trim() ? { label: run.description.trim() } : {}),
      state: portableWorkerState(run.state),
      focused: false,
      backendCapability: "managed-subagent-v1"
    } as const));
    const target = this.targetForSession(current);
    let built: PortableSessionExportBuild;
    try {
      built = await buildPortableSessionExport({
        applicationVersion: input.applicationVersion ?? "0.1.0",
        title: current.descriptor.title,
        workspaceKind: target.managed ? "dialogue" : "project",
        backendCapability: "native-portable-session-v1",
        events,
        nativeSession,
        workers,
        workerDetail,
        ...(input.password === undefined ? {} : { password: input.password }),
        ...(input.excludeMedia === undefined ? {} : { excludeMedia: input.excludeMedia }),
        contentLimitBytes: Math.min(this.#artifactStore.maximumBlobBytes, 256 * 1024 * 1024),
        readBlob: (blob) => this.#artifactStore.readBlob(blob)
      });
    } catch (error) {
      if (error instanceof PortableSessionProjectionError) throw portableSessionProjectionLimitError();
      throw error;
    }
    const storedArtifact = await this.#artifactStore.ingestBytes(built.bytes, {
      fileName: `${portableFileStem(current.descriptor.title)}.jshare`,
      mimeType: "application/vnd.joko.session"
    });
    const artifact: BlobRef = {
      id: storedArtifact.id,
      sha256: storedArtifact.sha256,
      byteLength: storedArtifact.byteLength,
      mimeType: storedArtifact.mimeType,
      ...(storedArtifact.fileName === undefined ? {} : { fileName: storedArtifact.fileName })
    };
    return {
      artifact,
      fidelity: built.fidelity,
      messageCount: built.messageCount,
      mediaCount: built.mediaCount,
      missingMediaCount: built.missingMediaCount,
      workerCount: built.workerCount,
      mediaBytes: built.mediaBytes
    };
  }

  async importPortableSession(
    input: ImportPortableSessionInput
  ): Promise<OperationExecution<ImportPortableSessionResult>> {
    return this.importPortableSessionPrepared(input);
  }

  async inspectPortableSessionImport(input: {
    readonly connection: ConnectionRecord;
    readonly package: BlobRef;
  }): Promise<PortableSessionImportDraftResult> {
    this.#assertOpen();
    this.#store.authorizeConnection(input.connection.id, input.connection.authKeyDigest);
    this.expirePortableImportDrafts();
    const content = await this.#artifactStore.readBlob(input.package);
    let prepared: PreparedPortableSessionImport | undefined;
    let encrypted = false;
    try {
      prepared = preparePortableSessionImport(content.data, {
        contentLimitBytes: Math.min(this.#artifactStore.maximumBlobBytes, 256 * 1024 * 1024)
      });
    } catch (error) {
      if (!(error instanceof PortableSessionPackageError) || error.code !== "PASSWORD_REQUIRED") throw error;
      encrypted = true;
    }
    const now = Date.now();
    if (this.#portableImportDrafts.size >= MAXIMUM_PORTABLE_IMPORT_DRAFTS) {
      const oldest = [...this.#portableImportDrafts.values()].sort((left, right) => left.createdAt - right.createdAt)[0];
      if (oldest !== undefined) this.#portableImportDrafts.delete(oldest.id);
    }
    const draft: PortableImportDraft = {
      id: `portable-draft-${randomUUID()}`,
      connectionId: input.connection.id,
      authKeyDigest: input.connection.authKeyDigest,
      package: { ...input.package },
      encrypted,
      createdAt: now,
      expiresAt: now + PORTABLE_IMPORT_DRAFT_TTL_MS,
      ...(prepared === undefined ? {} : { prepared })
    };
    this.#portableImportDrafts.set(draft.id, draft);
    return portableImportDraftResult(draft);
  }

  async unlockPortableSessionImport(input: {
    readonly connection: ConnectionRecord;
    readonly draftId: string;
    readonly password: string;
  }): Promise<PortableSessionImportDraftResult> {
    this.#assertOpen();
    const draft = this.requirePortableImportDraft(input.connection, input.draftId);
    const content = await this.#artifactStore.readBlob(draft.package);
    draft.prepared = preparePortableSessionImport(content.data, {
      password: input.password,
      contentLimitBytes: Math.min(this.#artifactStore.maximumBlobBytes, 256 * 1024 * 1024)
    });
    draft.expiresAt = Date.now() + PORTABLE_IMPORT_DRAFT_TTL_MS;
    return portableImportDraftResult(draft);
  }

  cancelPortableSessionImport(input: {
    readonly connection: ConnectionRecord;
    readonly draftId: string;
  }): void {
    this.#assertOpen();
    const draft = this.requirePortableImportDraft(input.connection, input.draftId);
    this.#portableImportDrafts.delete(draft.id);
  }

  async commitPortableSessionImport(
    input: CommitPortableSessionDraftInput
  ): Promise<OperationExecution<ImportPortableSessionResult>> {
    this.#assertOpen();
    const draft = this.requirePortableImportDraft(input.connection, input.draftId);
    if (draft.prepared === undefined) {
      throw new JokoError({
        code: "PORTABLE_SESSION_PASSWORD_REQUIRED",
        message: "Unlock this portable task before importing it.",
        phase: "session",
        retryable: false,
        stateMayHaveChanged: false,
        recovery: "Enter the package password, review the preview, then import again."
      });
    }
    const result = await this.importPortableSessionPrepared({
      operationId: input.operationId,
      connection: input.connection,
      targetId: input.targetId,
      package: draft.package,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.providerId === undefined ? {} : { providerId: input.providerId }),
      ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
      ...(input.effort === undefined ? {} : { effort: input.effort }),
      fastMode: input.fastMode,
      permissionMode: input.permissionMode,
      planMode: input.planMode,
      overwrite: input.overwrite,
      ...(input.worktree === undefined ? {} : { worktree: input.worktree })
    }, draft.prepared);
    this.#portableImportDrafts.delete(draft.id);
    return result;
  }

  async retryPortableSessionActivation(input: {
    readonly connection: ConnectionRecord;
    readonly sessionId: string;
  }): Promise<RetryPortableSessionActivationResult> {
    this.#assertOpen();
    this.#store.authorizeConnection(input.connection.id, input.connection.authKeyDigest);
    const session = this.#store.getSession(input.sessionId);
    if (session.descriptor.deletedAt !== undefined) throw new StoreError("The imported task is no longer available.");
    if (this.#store.findSetting("session", input.sessionId, PORTABLE_IMPORT_SOURCE_SETTING_KEY) === undefined) {
      throw new StoreError("This task was not created by a portable import.");
    }
    const current = portableImportActivationRecord(this.#store.findSetting(
      "session",
      input.sessionId,
      PORTABLE_IMPORT_ACTIVATION_SETTING_KEY
    )?.value);
    if (current?.status === "ready") return portableActivationResult(input.sessionId, current);
    const activation = await this.tryPortableSessionActivation(input.sessionId);
    return portableActivationResult(input.sessionId, activation);
  }

  private importPortableSessionPrepared(
    input: ImportPortableSessionInput,
    prepared?: PreparedPortableSessionImport
  ): Promise<OperationExecution<ImportPortableSessionResult>> {
    this.#assertOpen();
    const bodyHash = operationBodyHash(portableImportOperationBody(input));
    const existing = this.#portableImportLocks.get(input.operationId);
    if (existing !== undefined) {
      if (existing.connectionId !== input.connection.id || existing.authKeyDigest !== input.connection.authKeyDigest) {
        throw new AuthorizationError("The operation belongs to a different connection.");
      }
      if (existing.bodyHash !== bodyHash) {
        throw new OperationConflictError(input.operationId, existing.bodyHash, bodyHash);
      }
      return existing.task;
    }
    const task = this.importPortableSessionOnce(input, prepared)
      .finally(() => this.#portableImportLocks.delete(input.operationId));
    this.#portableImportLocks.set(input.operationId, {
      bodyHash,
      connectionId: input.connection.id,
      authKeyDigest: input.connection.authKeyDigest,
      task
    });
    return task;
  }

  private requirePortableImportDraft(
    connection: ConnectionRecord,
    draftId: string
  ): PortableImportDraft {
    this.#store.authorizeConnection(connection.id, connection.authKeyDigest);
    this.expirePortableImportDrafts();
    const draft = this.#portableImportDrafts.get(draftId);
    if (draft === undefined) {
      throw new JokoError({
        code: "PORTABLE_SESSION_DRAFT_EXPIRED",
        message: "This portable task preview has expired.",
        phase: "session",
        retryable: false,
        stateMayHaveChanged: false,
        recovery: "Choose the package again to start a new import preview."
      });
    }
    if (draft.connectionId !== connection.id || draft.authKeyDigest !== connection.authKeyDigest) {
      throw new AuthorizationError("The portable import draft belongs to a different connection.");
    }
    return draft;
  }

  private expirePortableImportDrafts(now = Date.now()): void {
    for (const [id, draft] of this.#portableImportDrafts) {
      if (draft.expiresAt <= now) this.#portableImportDrafts.delete(id);
    }
  }

  async navigateTree(
    sessionId: string,
    entryId: string,
    summarize: boolean,
    customInstructions?: string
  ): Promise<void> {
    if (this.isReviewReadOnlySession(sessionId)) throw new StoreError("Reviewer history navigation is disabled.");
    const active = await this.activate(sessionId);
    const lease = this.beginActiveBackendSideEffect(sessionId, active);
    try {
      await active.adapter.navigateTree(entryId, summarize, lease.context, customInstructions);
      this.assertActiveBackendSideEffectLease(lease);
      await this.synchronizeNativeHistory(sessionId);
      this.assertActiveBackendSideEffectLease(lease);
      await this.refreshRuntimeCommands(sessionId, active)
        .catch((error: unknown) => this.recordFailure("runtime_commands_navigation_sync", error));
      this.assertActiveBackendSideEffectLease(lease);
      await this.refreshNativeStateBestEffort(sessionId, active, "native_state_navigation_sync");
      this.assertActiveBackendSideEffectLease(lease);
    } finally {
      lease.release();
    }
  }

  async getTree(sessionId: string) {
    if (this.isReviewReadOnlySession(sessionId)) throw new StoreError("Reviewer history is not projected.");
    const active = await this.activate(sessionId);
    const lease = this.beginActiveBackendSideEffect(sessionId, active);
    try {
      const tree = await active.adapter.getTree(lease.context);
      this.assertActiveBackendSideEffectLease(lease);
      return tree;
    } finally {
      lease.release();
    }
  }

  async inspect(sessionId: string) {
    const active = await this.activate(sessionId);
    const lease = this.beginActiveBackendSideEffect(sessionId, active);
    try {
      const state = await this.refreshNativeStateObservation(sessionId, active);
      this.assertActiveBackendSideEffectLease(lease);
      this.persistRuntimeUsage(sessionId, state.binding.generation, state.usage, false, state.providerId, state.modelId);
      return state;
    } finally {
      lease.release();
    }
  }

  async getCommands(sessionId: string): Promise<readonly RuntimeCommand[]> {
    if (this.isReviewReadOnlySession(sessionId)) return [];
    const active = await this.activate(sessionId);
    // This RPC is an explicit live observation. Adapter failures are surfaced
    // to the caller, while the last durable truth remains untouched.
    const lease = this.beginActiveBackendSideEffect(sessionId, active);
    try {
      const commands = await this.refreshRuntimeCommands(sessionId, active);
      return commands;
    } finally {
      lease.release();
    }
  }

  async getRuntimeTools(sessionId: string): Promise<RuntimeToolCatalog> {
    if (this.isReviewReadOnlySession(sessionId)) throw new StoreError("Reviewer runtime tools are not projected.");
    const active = await this.activate(sessionId);
    if (active.adapter.getRuntimeTools === undefined) {
      throw new StoreError("This Backend does not expose a live runtime tool registry.");
    }
    const lease = this.beginActiveBackendSideEffect(sessionId, active);
    try {
      const tools = await active.adapter.getRuntimeTools(lease.context);
      this.assertActiveBackendSideEffectLease(lease);
      return tools;
    } finally {
      lease.release();
    }
  }

  async getResources(sessionId: string) {
    if (this.isReviewReadOnlySession(sessionId)) return [];
    const active = await this.activate(sessionId);
    const lease = this.beginActiveBackendSideEffect(sessionId, active);
    try {
      const resources = await active.adapter.getResources(lease.context);
      this.assertActiveBackendSideEffectLease(lease);
      await this.refreshRuntimeCommands(sessionId, active)
        .catch((error: unknown) => this.recordFailure("runtime_commands_resource_sync", error));
      this.assertActiveBackendSideEffectLease(lease);
      return resources;
    } finally {
      lease.release();
    }
  }

  /**
   * Reclaim native runtimes that have no live product or native work. The
   * monotonic activity clock avoids wall-clock jumps, while the per-session
   * reap fence makes a concurrent caller wait for detach before resuming the
   * same durable JSONL binding.
   */
  async reapIdleRuntimes(idleForMs = 30 * 60_000): Promise<readonly string[]> {
    this.#assertOpen();
    if (!Number.isFinite(idleForMs) || idleForMs < 1_000) {
      throw new Error("Runtime idle timeout must be at least one second.");
    }
    const now = this.#monotonicNow();
    const reclaimed: string[] = [];
    for (const [sessionId, candidate] of [...this.#active]) {
      if (this.isReviewReadOnlySession(sessionId)) continue;
      if (now - candidate.lastActivityAt < idleForMs || !this.canReapRuntime(sessionId)) continue;
      const stored = this.#store.getSession(sessionId);
      let releaseAdmission: (() => void) | undefined;
      try {
        try {
          releaseAdmission = this.beginBackendAdmissionEffect(stored.descriptor.backendId);
        } catch {
          continue;
        }
        const nativeState = await candidate.adapter.inspectSession(
          stored.descriptor.binding,
          this.contextFor(stored, undefined, undefined, undefined, undefined, candidate.backendInstanceGeneration)
        ).catch(() => undefined);
        if (
          nativeState === undefined ||
          nativeState.streaming ||
          nativeState.compacting ||
          nativeState.pendingMessages > 0 ||
          this.#active.get(sessionId) !== candidate ||
          this.#adapters.get(stored.descriptor.backendId) !== candidate.adapter ||
          this.#adapterGenerations.get(stored.descriptor.backendId) !== candidate.backendInstanceGeneration ||
          this.#store.getBackend(stored.descriptor.backendId).descriptor.instanceGeneration
            !== candidate.backendInstanceGeneration ||
          now - candidate.lastActivityAt < idleForMs ||
          !this.canReapRuntime(sessionId)
        ) continue;

        const task = (async (): Promise<void> => {
          try {
            if (candidate.adapter.detachSession !== undefined) {
              await candidate.adapter.detachSession(stored.descriptor.binding, this.contextFor(stored));
            } else {
              await candidate.adapter.closeSession(stored.descriptor.binding, this.contextFor(stored));
            }
          } finally {
            if (this.#active.get(sessionId) === candidate) this.#active.delete(sessionId);
            this.clearTurnOverrideLeases(sessionId);
          }
        })();
        this.#reaping.set(sessionId, task);
        releaseAdmission();
        releaseAdmission = undefined;
        try {
          await task;
          reclaimed.push(sessionId);
        } catch (error) {
          this.recordFailure("runtime_idle_reap", error);
        } finally {
          if (this.#reaping.get(sessionId) === task) this.#reaping.delete(sessionId);
        }
      } finally {
        releaseAdmission?.();
      }
    }
    return reclaimed;
  }

  /** Observe only already-running runtimes; this must never start a task merely to project resource state. */
  async observeActiveResources(filter: {
    readonly backendId?: string;
    readonly targetId?: string;
  } = {}): Promise<readonly {
    readonly backendId: string;
    readonly targetId: string;
    readonly sessionId: string;
    readonly generation: number;
    readonly resource: import("@joko/core").RuntimeResource;
  }[]> {
    const observations: Array<{
      backendId: string;
      targetId: string;
      sessionId: string;
      generation: number;
      resource: import("@joko/core").RuntimeResource;
    }> = [];
    for (const [sessionId, active] of this.#active) {
      const stored = this.#store.getSession(sessionId);
      if (filter.backendId !== undefined && stored.descriptor.backendId !== filter.backendId) continue;
      if (filter.targetId !== undefined && stored.descriptor.targetId !== filter.targetId) continue;
      let lease: ActiveBackendSideEffectLease;
      try {
        lease = this.beginActiveBackendSideEffect(sessionId, active);
      } catch {
        continue;
      }
      try {
        const resources = await active.adapter.getResources(lease.context).catch(() => undefined);
        if (resources === undefined) continue;
        this.assertActiveBackendSideEffectLease(lease);
        await this.refreshRuntimeCommands(sessionId, active)
          .catch((error: unknown) => this.recordFailure("runtime_commands_resource_observation", error));
        this.assertActiveBackendSideEffectLease(lease);
        for (const resource of resources) observations.push({
          backendId: lease.stored.descriptor.backendId,
          targetId: lease.stored.descriptor.targetId,
          sessionId,
          generation: lease.productGeneration,
          resource
        });
      } finally {
        lease.release();
      }
    }
    return observations;
  }

  private canReapRuntime(sessionId: string): boolean {
    if (
      this.#activating.has(sessionId) ||
      this.#messageDeletionLocks.has(sessionId) ||
      this.#sessionResetLocks.has(sessionId) ||
      (this.#activeEffects.get(sessionId) ?? 0) > 0 ||
      this.#reaping.has(sessionId) ||
      this.#runSilenceRecoveries.has(sessionId) ||
      this.#runtimeRestartFences.has(sessionId) ||
      this.#draining.has(sessionId) ||
      this.#nativeHistoryTails.has(sessionId) ||
      this.#runtimeCommandTails.has(sessionId) ||
      this.#userShellRequests.has(sessionId) ||
      this.#userShells.has(sessionId) ||
      (this.#backgroundTasks.get(sessionId)?.size ?? 0) > 0
    ) return false;
    for (const interaction of this.#pendingInteractions.values()) {
      if (interaction.sessionId === sessionId) return false;
    }
    for (const lease of this.#turnOverrideLeases.values()) {
      if (lease.sessionId === sessionId) return false;
    }
    if (listAllRuns(this.#store, { sessionId, activeOnly: true }).some((run) =>
      run.descriptor.state === "running" ||
      run.descriptor.state === "waiting" ||
      run.descriptor.state === "retrying")) return false;
    return this.#store.listQueueItems({
      sessionId,
      states: ["accepted", "dispatching", "backend_accepted"],
      limit: 1
    }).length === 0;
  }

  private canEnterSessionArchive(sessionId: string): boolean {
    if (
      this.#activating.has(sessionId)
      || this.#messageDeletionLocks.has(sessionId)
      || this.#sessionResetLocks.has(sessionId)
      || (this.#activeEffects.get(sessionId) ?? 0) > 0
      || this.#reaping.has(sessionId)
      || this.#runSilenceRecoveries.has(sessionId)
      || this.#draining.has(sessionId)
      || this.#dispatchPreparations.has(sessionId)
      || this.#nativeCompactions.has(sessionId)
      || this.#explicitCompactionFlights.has(sessionId)
      || this.#compactionEffects.has(sessionId)
      || this.#userShellRequests.has(sessionId)
      || this.#userShells.has(sessionId)
      || (this.#backgroundTasks.get(sessionId)?.size ?? 0) > 0
      || this.#closeIfActiveFlights.has(sessionId)
      || this.#runtimeRestartFences.has(sessionId)
      || this.#sessionRuntimeControlEffects.has(sessionId)
    ) return false;
    for (const interaction of this.#pendingInteractions.values()) {
      if (interaction.sessionId === sessionId) return false;
    }
    for (const lease of this.#turnOverrideLeases.values()) {
      if (lease.sessionId === sessionId) return false;
    }
    if (listAllRuns(this.#store, { sessionId, activeOnly: true }).some((run) =>
      run.descriptor.state === "queued"
      || run.descriptor.state === "running"
      || run.descriptor.state === "waiting"
      || run.descriptor.state === "retrying"
      || run.descriptor.state === "dispatch_unknown")) return false;
    return this.#store.listQueueItems({
      sessionId,
      states: ["accepted", "dispatching", "backend_accepted", "dispatch_unknown"],
      limit: 1
    }).length === 0;
  }

  #assertBackendReplacementIdle(backendId: string): void {
    if ((this.#backendSideEffectFlights.get(backendId)?.size ?? 0) > 0) {
      throw new StoreError("A Backend can be replaced only after every native side effect has settled.");
    }
    if ((this.#backendAdmissionEffects.get(backendId) ?? 0) > 0) {
      throw new StoreError("A Backend can be replaced only while it has no native admission effect in progress.");
    }
    for (const session of this.#store.listSessions({ includeArchived: true, includeDeleted: true })) {
      if (session.descriptor.backendId !== backendId) continue;
      const sessionId = session.descriptor.id;
      if (
        this.#sessionLifecycleFences.has(sessionId)
        || this.#sessionLifecycleBackendAdmissions.has(sessionId)
        || this.#store.findPendingSessionLifecycleCleanup(sessionId) !== undefined
        || this.#store.findPendingScheduleDeletionCleanupForSession(sessionId) !== undefined
      ) {
        throw new StoreError("A Backend cannot be replaced while one of its task lifecycle owners is pending.");
      }
      if (session.descriptor.archived || session.descriptor.deletedAt !== undefined) continue;
      if (this.isReviewReadOnlySession(sessionId)) {
        if (
          this.#active.has(sessionId)
          || this.#reviewRuntimeFlights.has(sessionId)
          || !this.canEnterSessionArchive(sessionId)
        ) throw new StoreError("A Backend cannot be replaced while a reviewer runtime is active.");
        continue;
      }
      this.assertRuntimeRestartIdle(sessionId);
    }
  }

  private assertBackendAdmissionOpen(backendId: string): void {
    if (this.#backendReplacementFences.has(backendId)) {
      throw new StoreError("The selected Backend is fenced while its process instance is being replaced.");
    }
  }

  private beginBackendAdmissionEffect(backendId: string): () => void {
    this.assertBackendAdmissionOpen(backendId);
    const releaseFlight = this.registerBackendSideEffectFlight(backendId);
    this.#backendAdmissionEffects.set(backendId, (this.#backendAdmissionEffects.get(backendId) ?? 0) + 1);
    try {
      this.assertBackendAdmissionOpen(backendId);
    } catch (error) {
      releaseFlight();
      const remaining = (this.#backendAdmissionEffects.get(backendId) ?? 1) - 1;
      if (remaining <= 0) this.#backendAdmissionEffects.delete(backendId);
      else this.#backendAdmissionEffects.set(backendId, remaining);
      throw error;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.#backendAdmissionEffects.get(backendId) ?? 1) - 1;
      if (remaining <= 0) this.#backendAdmissionEffects.delete(backendId);
      else this.#backendAdmissionEffects.set(backendId, remaining);
      releaseFlight();
    };
  }

  private beginActiveBackendSideEffect(
    sessionId: string,
    active: ActiveSession,
    operationId?: string,
    allowance: BackendSideEffectAdmissionAllowance = {}
  ): ActiveBackendSideEffectLease {
    const initial = this.assertActiveBackendSideEffectOwner(sessionId, active, undefined, true, allowance);
    const release = this.registerBackendSideEffectFlight(initial.descriptor.backendId, sessionId);
    try {
      const stored = this.assertActiveBackendSideEffectOwner(
        sessionId,
        active,
        initial.descriptor.binding.generation,
        true,
        allowance
      );
      return {
        sessionId,
        backendId: stored.descriptor.backendId,
        active,
        stored,
        productGeneration: stored.descriptor.binding.generation,
        backendInstanceGeneration: active.backendInstanceGeneration,
        context: this.contextFor(
          stored,
          undefined,
          undefined,
          operationId,
          undefined,
          active.backendInstanceGeneration
        ),
        release
      };
    } catch (error) {
      release();
      throw error;
    }
  }

  private assertActiveBackendSideEffectLease(lease: ActiveBackendSideEffectLease): StoredSession {
    return this.assertActiveBackendSideEffectOwner(
      lease.sessionId,
      lease.active,
      lease.productGeneration,
      false
    );
  }

  private assertActiveBackendSideEffectOwner(
    sessionId: string,
    active: ActiveSession,
    expectedProductGeneration: number | undefined,
    requireAdmissionOpen: boolean,
    allowance: BackendSideEffectAdmissionAllowance = {}
  ): StoredSession {
    this.#assertOpen();
    const stored = this.#store.getSession(sessionId);
    if (requireAdmissionOpen) {
      if (allowance.backendReplacement !== true) {
        this.assertBackendAdmissionOpen(stored.descriptor.backendId);
      }
      const lifecycleOwner = this.#sessionLifecycleFences.get(sessionId);
      const durableLifecycle = this.#store.findPendingSessionLifecycleCleanup(sessionId);
      if (
        (this.#runtimeRestartFences.has(sessionId) && allowance.runtimeRestart !== true) ||
        (lifecycleOwner !== undefined && lifecycleOwner !== allowance.lifecycleOperationId) ||
        (durableLifecycle !== undefined && durableLifecycle.operationId !== allowance.lifecycleOperationId) ||
        this.#store.findPendingScheduleDeletionCleanupForSession(sessionId) !== undefined ||
        this.#messageDeletionLocks.has(sessionId) ||
        (this.#sessionResetLocks.has(sessionId) && allowance.sessionReset !== true) ||
        this.#closeIfActiveFlights.has(sessionId) ||
        this.#reaping.has(sessionId)
      ) throw new StoreError("The native runtime is fenced from starting another Backend side effect.");
    }
    if (
      this.#active.get(sessionId) !== active ||
      active.sessionId !== sessionId ||
      active.adapter.id !== stored.descriptor.backendId ||
      this.#adapters.get(stored.descriptor.backendId) !== active.adapter ||
      this.#adapterGenerations.get(stored.descriptor.backendId) !== active.backendInstanceGeneration ||
      this.#store.getBackend(stored.descriptor.backendId).descriptor.instanceGeneration !== active.backendInstanceGeneration ||
      (expectedProductGeneration !== undefined &&
        stored.descriptor.binding.generation !== expectedProductGeneration)
    ) throw staleBackendInstanceContextError();
    return stored;
  }

  private registerBackendSideEffectFlight(backendId: string, sessionId?: string): () => void {
    let settle!: () => void;
    const flight = new Promise<void>((resolve) => { settle = resolve; });
    const backendFlights = this.#backendSideEffectFlights.get(backendId) ?? new Set<Promise<void>>();
    backendFlights.add(flight);
    this.#backendSideEffectFlights.set(backendId, backendFlights);
    if (sessionId !== undefined) {
      const sessionFlights = this.#activeEffectFlights.get(sessionId) ?? new Set<Promise<void>>();
      sessionFlights.add(flight);
      this.#activeEffectFlights.set(sessionId, sessionFlights);
      this.#activeEffects.set(sessionId, (this.#activeEffects.get(sessionId) ?? 0) + 1);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      backendFlights.delete(flight);
      if (backendFlights.size === 0 && this.#backendSideEffectFlights.get(backendId) === backendFlights) {
        this.#backendSideEffectFlights.delete(backendId);
      }
      if (sessionId !== undefined) {
        const sessionFlights = this.#activeEffectFlights.get(sessionId);
        sessionFlights?.delete(flight);
        if (sessionFlights?.size === 0) this.#activeEffectFlights.delete(sessionId);
        const remaining = (this.#activeEffects.get(sessionId) ?? 1) - 1;
        if (remaining <= 0) this.#activeEffects.delete(sessionId);
        else this.#activeEffects.set(sessionId, remaining);
      }
      settle();
    };
  }

  private tryBeginBackendCallbackFlight(backendId: string, sessionId: string): (() => void) | undefined {
    try {
      this.assertBackendAdmissionOpen(backendId);
    } catch {
      return undefined;
    }
    const release = this.registerBackendSideEffectFlight(backendId, sessionId);
    try {
      this.assertBackendAdmissionOpen(backendId);
      return release;
    } catch {
      release();
      return undefined;
    }
  }

  private async waitForSessionProjectionIdle(sessionId: string): Promise<void> {
    for (;;) {
      const pending = [
        this.#nativeHistoryTails.get(sessionId),
        this.#runtimeCommandTails.get(sessionId),
        this.#nativeStateTails.get(sessionId),
        ...(this.#inflightEmissions.get(sessionId) ?? [])
      ].filter((task): task is Promise<void> => task !== undefined);
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    }
  }

  private assertMessageDeletionAdmission(sessionId: string): void {
    if (this.#sessionResetLocks.has(sessionId)) {
      throw sessionResetError(
        "SESSION_RESET_IN_PROGRESS",
        "This task is currently clearing its context.",
        "Wait for clear to finish; the prompt has not been queued."
      );
    }
    if (!this.#messageDeletionLocks.has(sessionId)) return;
    throw messageDeletionError(
      "SESSION_MESSAGE_DELETE_IN_PROGRESS",
      "This task is currently deleting a message.",
      "Wait for deletion to finish; the prompt has not been queued."
    );
  }

  private assertSessionNotPendingScheduleDeletion(sessionId: string): void {
    const session = this.#store.getSession(sessionId);
    if (session.descriptor.deletedAt !== undefined || session.descriptor.archived) {
      throw new StoreError("Archived or deleted tasks cannot accept input or activate a native runtime.");
    }
    if (this.#store.findPendingScheduleDeletionCleanupForSession(sessionId) !== undefined) {
      throw new StoreError("The task is fenced while its Schedule deletion is in progress.");
    }
    if (this.#store.findPendingSessionLifecycleCleanup(sessionId) !== undefined) {
      throw new StoreError("The task is fenced while its lifecycle transition is in progress.");
    }
    if (this.#sessionLifecycleFences.has(sessionId)) {
      throw new StoreError("The task is fenced while its lifecycle transition is in progress.");
    }
  }

  private assertDestructiveSessionCleanupPending(sessionId: string): void {
    const lifecycle = this.#store.findPendingSessionLifecycleCleanup(sessionId);
    if (lifecycle?.disposition === "delete") return;
    if (this.#store.findPendingScheduleDeletionCleanupForSession(sessionId) !== undefined) return;
    throw new StoreError("Destructive task cleanup requires a durable lifecycle owner.");
  }

  private assertMessageDeletionSupported(sessionId: string): void {
    const stored = this.#store.getSession(sessionId);
    const backend = this.#store.getBackend(stored.descriptor.backendId).descriptor;
    const adapter = this.requireAdapter(stored.descriptor.backendId);
    if (
      backend.capabilities.get("session.message_delete")?.supported === true &&
      adapter.rebuildContext !== undefined
    ) return;
    throw messageDeletionError(
      "SESSION_MESSAGE_DELETE_UNSUPPORTED",
      "The selected Backend cannot safely delete a message from native context.",
      "Use a Backend that advertises session.message_delete."
    );
  }

  private assertMessageDeletionIdle(sessionId: string, store: OperationalStore): void {
    store.getSession(sessionId);
    const liveRuns = listAllRuns(store, { sessionId, activeOnly: true });
    const queued = store.listQueueItems({
      sessionId,
      states: ["accepted", "dispatching", "backend_accepted", "dispatch_unknown"],
      limit: 1
    });
    const busy =
      liveRuns.length > 0 ||
      queued.length > 0 ||
      this.#draining.has(sessionId) ||
      this.#dispatchPreparations.has(sessionId) ||
      this.#runtimeRestartFences.has(sessionId) ||
      this.#activating.has(sessionId) ||
      this.#reaping.has(sessionId) ||
      (this.#activeEffects.get(sessionId) ?? 0) > 0 ||
      this.#nativeCompactions.has(sessionId) ||
      this.#explicitCompactionFlights.has(sessionId) ||
      this.#compactionEffects.has(sessionId) ||
      this.#userShellRequests.has(sessionId) ||
      this.#userShells.has(sessionId) ||
      (this.#backgroundTasks.get(sessionId)?.size ?? 0) > 0 ||
      [...this.#pendingInteractions.values()].some((interaction) => interaction.sessionId === sessionId);
    if (!busy) return;
    throw messageDeletionError(
      "SESSION_MESSAGE_DELETE_NOT_IDLE",
      "Messages can be deleted only while the task has no active or queued work.",
      "Wait for the task, background work, and queue to become idle, then retry."
    );
  }

  private async prepareMessageDeletion(sessionId: string): Promise<void> {
    this.assertMessageDeletionIdle(sessionId, this.#store);
    const active = this.#active.get(sessionId);
    if (active !== undefined) {
      let stored = this.#store.getSession(sessionId);
      const before = await active.adapter.inspectSession(
        stored.descriptor.binding,
        this.contextFor(stored)
      );
      assertNativeDeletionIdle(before);
      await this.synchronizeNativeHistory(sessionId);
      await Promise.all([
        this.#runtimeCommandTails.get(sessionId) ?? Promise.resolve(),
        this.#nativeStateTails.get(sessionId) ?? Promise.resolve(),
        ...(this.#inflightEmissions.get(sessionId) ?? [])
      ]);
      stored = this.#store.getSession(sessionId);
      if (this.#active.get(sessionId) !== active) {
        throw new StoreError("The native runtime changed while message deletion was being prepared.");
      }
      const after = await active.adapter.inspectSession(
        stored.descriptor.binding,
        this.contextFor(stored)
      );
      assertNativeDeletionIdle(after);
      await active.adapter.closeSession(stored.descriptor.binding, this.contextFor(stored));
      if (this.#active.get(sessionId) === active) this.#active.delete(sessionId);
      this.#nativeCompactions.delete(sessionId);
      this.clearTurnOverrideLeases(sessionId);
    }
    await Promise.all([
      this.#nativeHistoryTails.get(sessionId) ?? Promise.resolve(),
      this.#runtimeCommandTails.get(sessionId) ?? Promise.resolve(),
      this.#nativeStateTails.get(sessionId) ?? Promise.resolve(),
      ...(this.#inflightEmissions.get(sessionId) ?? [])
    ]);
    this.assertMessageDeletionIdle(sessionId, this.#store);
  }

  private assertSessionResetSupported(sessionId: string, store: OperationalStore): void {
    const stored = store.getSession(sessionId);
    const backend = store.getBackend(stored.descriptor.backendId).descriptor;
    const adapter = this.requireAdapter(stored.descriptor.backendId);
    if (
      backend.capabilities.get("session.reset")?.supported === true &&
      adapter.resetContext !== undefined
    ) return;
    throw sessionResetError(
      "SESSION_RESET_UNSUPPORTED",
      "The selected Backend cannot safely clear native context.",
      "Use a Backend that advertises session.reset."
    );
  }

  private assertSessionResetIdle(sessionId: string, store: OperationalStore): void {
    store.getSession(sessionId);
    const busy =
      store.listRuns({ sessionId, activeOnly: true, limit: 1 }).length > 0 ||
      store.listQueueItems({
        sessionId,
        states: ["accepted", "dispatching", "backend_accepted", "dispatch_unknown"],
        limit: 1
      }).length > 0 ||
      store.listInteractions({ sessionId, status: "open", limit: 1 }).length > 0 ||
      store.listToolLeases({ sessionId, activeOnly: true }).length > 0 ||
      store.hasActiveSessionBackgroundTasks(sessionId) ||
      this.#draining.has(sessionId) ||
      this.#dispatchPreparations.has(sessionId) ||
      this.#activating.has(sessionId) ||
      this.#reaping.has(sessionId) ||
      (this.#activeEffects.get(sessionId) ?? 0) > 0 ||
      this.#nativeCompactions.has(sessionId) ||
      this.#explicitCompactionFlights.has(sessionId) ||
      this.#compactionEffects.has(sessionId) ||
      this.#userShellRequests.has(sessionId) ||
      this.#userShells.has(sessionId) ||
      (this.#backgroundTasks.get(sessionId)?.size ?? 0) > 0 ||
      [...this.#pendingInteractions.values()].some((interaction) => interaction.sessionId === sessionId);
    if (!busy) return;
    throw sessionResetError(
      "SESSION_RESET_NOT_IDLE",
      "This task can be cleared only when it has no queued, background, tool, or interaction work.",
      "Wait for all task activity to settle, then retry clear."
    );
  }

  private async prepareSessionReset(sessionId: string): Promise<SessionResetPreparation> {
    this.assertSessionResetIdle(sessionId, this.#store);
    const active = await this.activateForSessionReset(sessionId);
    let stored = this.#store.getSession(sessionId);
    const before = await active.adapter.inspectSession(stored.descriptor.binding, this.contextFor(stored));
    assertNativeResetIdle(before);
    await this.synchronizeNativeHistory(sessionId);
    await Promise.all([
      this.#nativeHistoryTails.get(sessionId) ?? Promise.resolve(),
      this.#runtimeCommandTails.get(sessionId) ?? Promise.resolve(),
      this.#nativeStateTails.get(sessionId) ?? Promise.resolve(),
      ...(this.#inflightEmissions.get(sessionId) ?? [])
    ]);
    stored = this.#store.getSession(sessionId);
    if (this.#active.get(sessionId) !== active) {
      throw sessionResetError(
        "SESSION_RESET_RUNTIME_CHANGED",
        "The native runtime changed while context clear was being prepared.",
        "Reload the task and retry clear after it is idle."
      );
    }
    this.assertSessionResetIdle(sessionId, this.#store);
    const after = await active.adapter.inspectSession(stored.descriptor.binding, this.contextFor(stored));
    assertNativeResetIdle(after);
    return {
      active,
      sourceBinding: stored.descriptor.binding,
      context: this.contextFor(stored)
    };
  }

  private touchActiveSession(sessionId: string): void {
    const active = this.#active.get(sessionId);
    if (active !== undefined) active.lastActivityAt = this.#monotonicNow();
  }

  /**
   * A run is watchdog-owned only after durable Backend acceptance. Queued and
   * dispatching work have separate recovery paths, while idle runtime reaping
   * remains based on lastActivityAt rather than turn progress.
   */
  private acceptedRunsAwaitingProgress(sessionId: string): ReturnType<OperationalStore["listRuns"]> {
    const acceptedRunIds = new Set(
      listAllQueueItems(this.#store, { sessionId, states: ["backend_accepted"] })
        .map((item) => item.runId)
    );
    return listAllRuns(this.#store, { sessionId, activeOnly: true })
      .filter((run) => acceptedRunIds.has(run.descriptor.id))
      .filter((run) =>
        run.descriptor.state === "running" ||
        run.descriptor.state === "waiting" ||
        run.descriptor.state === "retrying"
      );
  }

  private runSilenceWatchdogPaused(sessionId: string, generation: number): boolean {
    if ([...this.#pendingInteractions.values()].some((interaction) =>
      interaction.sessionId === sessionId && interaction.generation === generation
    )) return true;
    return [...(this.#backgroundTasks.get(sessionId)?.values() ?? [])]
      .some((task) => task.generation === generation);
  }

  private clearRunSilenceWatchdog(sessionId: string): void {
    const watchdog = this.#runSilenceWatchdogs.get(sessionId);
    if (watchdog?.timer !== undefined) clearTimeout(watchdog.timer);
    this.#runSilenceWatchdogs.delete(sessionId);
  }

  /** Reset only after progress is durable, or after an explicit wait ends. */
  private refreshRunSilenceWatchdog(sessionId: string): void {
    this.clearRunSilenceWatchdog(sessionId);
    if (
      this.#disposed ||
      this.#runSilenceTimeoutMs === 0 ||
      this.#runSilenceRecoveries.has(sessionId)
    ) return;
    let stored: StoredSession;
    try {
      stored = this.#store.getSession(sessionId);
    } catch {
      return;
    }
    const generation = stored.descriptor.binding.generation;
    if (
      this.acceptedRunsAwaitingProgress(sessionId).length === 0 ||
      this.runSilenceWatchdogPaused(sessionId, generation)
    ) return;
    const watchdog: RunSilenceWatchdog = {
      sessionId,
      generation,
      remainingMs: this.#runSilenceTimeoutMs,
      sliceStartedAt: this.#monotonicNow()
    };
    this.#runSilenceWatchdogs.set(sessionId, watchdog);
    this.armRunSilenceWatchdogSlice(watchdog);
  }

  private armRunSilenceWatchdogSlice(watchdog: RunSilenceWatchdog): void {
    if (this.#runSilenceWatchdogs.get(watchdog.sessionId) !== watchdog) return;
    const sliceMs = Math.min(watchdog.remainingMs, RUN_SILENCE_WATCHDOG_SLICE_MS);
    watchdog.sliceStartedAt = this.#monotonicNow();
    watchdog.timer = setTimeout(() => {
      watchdog.timer = undefined;
      this.advanceRunSilenceWatchdog(watchdog, sliceMs);
    }, sliceMs);
  }

  private advanceRunSilenceWatchdog(watchdog: RunSilenceWatchdog, sliceMs: number): void {
    if (this.#runSilenceWatchdogs.get(watchdog.sessionId) !== watchdog || this.#disposed) return;
    let stored: StoredSession;
    try {
      stored = this.#store.getSession(watchdog.sessionId);
    } catch {
      this.clearRunSilenceWatchdog(watchdog.sessionId);
      return;
    }
    if (
      stored.descriptor.binding.generation !== watchdog.generation ||
      this.acceptedRunsAwaitingProgress(watchdog.sessionId).length === 0 ||
      this.runSilenceWatchdogPaused(watchdog.sessionId, watchdog.generation)
    ) {
      this.clearRunSilenceWatchdog(watchdog.sessionId);
      return;
    }
    const elapsedMs = Math.max(0, this.#monotonicNow() - watchdog.sliceStartedAt);
    // A suspended host cannot infer Backend silence from a single delayed
    // callback. Restart the complete window instead of killing a healthy run.
    if (elapsedMs > sliceMs + RUN_SILENCE_SUSPEND_GAP_MS) {
      this.refreshRunSilenceWatchdog(watchdog.sessionId);
      return;
    }
    watchdog.remainingMs -= Math.max(sliceMs, elapsedMs);
    if (watchdog.remainingMs > 0) {
      this.armRunSilenceWatchdogSlice(watchdog);
      return;
    }
    this.clearRunSilenceWatchdog(watchdog.sessionId);
    this.beginRunSilenceRecovery(watchdog.sessionId, watchdog.generation);
  }

  private beginRunSilenceRecovery(sessionId: string, generation: number): void {
    if (this.#disposed || this.#runSilenceRecoveries.has(sessionId)) return;
    // Defer the body by one microtask so the recovery fence is installed
    // before any queue or Adapter work can begin.
    const recovery = Promise.resolve().then(() => this.recoverRunSilence(sessionId, generation));
    this.#runSilenceRecoveries.set(sessionId, recovery);
    void recovery.then((safe) => {
      if (!safe || this.#runSilenceRecoveries.get(sessionId) !== recovery) return;
      this.#runSilenceRecoveries.delete(sessionId);
      this.refreshRunSilenceWatchdog(sessionId);
      void this.drain(sessionId);
    }).catch((error: unknown) => {
      // Retain the resolved/rejected recovery as a dispatch fence: an
      // uncertain native lifecycle must not overlap the next durable prompt.
      this.recordFailure("run_silence_recovery", error);
    });
  }

  private async recoverRunSilence(sessionId: string, generation: number): Promise<boolean> {
    const stored = this.#store.getSession(sessionId);
    if (stored.descriptor.binding.generation !== generation) return true;
    const runs = this.acceptedRunsAwaitingProgress(sessionId);
    if (runs.length === 0) return true;
    const active = this.#active.get(sessionId);
    let sideEffectLease: ActiveBackendSideEffectLease | undefined;
    let releaseBackendAdmission: (() => void) | undefined;
    try {
      if (active === undefined) {
        releaseBackendAdmission = this.beginBackendAdmissionEffect(stored.descriptor.backendId);
      } else {
        sideEffectLease = this.beginActiveBackendSideEffect(sessionId, active);
      }
    } catch {
      // A Backend replacement that won admission keeps this recovery record as
      // a durable dispatch fence; a later explicit recovery can reconcile it.
      return false;
    }
    try {
    const queueItems = listAllQueueItems(this.#store, { sessionId, states: ["backend_accepted"] })
      .filter((item) => runs.some((run) => run.descriptor.id === item.runId));
    const failure: PublicError = {
      code: "BACKEND_RUN_SILENCE_TIMEOUT",
      message: "The Backend stopped reporting progress for an active run.",
      phase: "stream",
      retryable: true,
      stateMayHaveChanged: true,
      recovery: "The native runtime was stopped or verified idle. Inspect durable activity before retrying."
    };
    const emittedAt = Date.now();
    this.#store.transaction((store) => {
      for (const run of runs) {
        const item = queueItems.find((candidate) => candidate.runId === run.descriptor.id);
        // The failure event is committed before queue/run publication can
        // expose the terminal state to readers.
        store.appendEvent({
          backendId: stored.descriptor.backendId,
          targetId: stored.descriptor.targetId,
          sessionId,
          runId: run.descriptor.id,
          ...(run.descriptor.activeAttemptId === undefined ? {} : { attemptId: run.descriptor.activeAttemptId }),
          ...(item === undefined ? {} : { operationId: item.operationId }),
          generation,
          emittedAt,
          traceId: `run-silence:${run.descriptor.id}:${generation}`,
          payload: { type: "error", terminal: true, error: failure }
        });
        if (item !== undefined) {
          store.updateQueueState({
            queueItemId: item.id,
            state: "failed",
            attemptId: item.attemptId,
            error: failure,
            traceId: `run-silence:${item.id}:failed`
          });
        }
        store.updateRunState({
          runId: run.descriptor.id,
          state: "failed",
          activeAttemptId: run.descriptor.activeAttemptId,
          error: failure,
          traceId: `run-silence:${run.descriptor.id}:failed`,
          ...(item === undefined ? {} : { operationId: item.operationId })
        });
        if (run.descriptor.activeAttemptId !== undefined) {
          store.finishAttempt(run.descriptor.activeAttemptId, failure);
        }
      }
    });
    for (const run of runs) {
      this.#workspaceCapture?.abortRun?.({ sessionId, runId: run.descriptor.id });
      await this.restoreTurnOverrideLease(run.descriptor.id);
    }
    if (this.isReviewReadOnlySession(sessionId)) {
      this.settleReviewRuntime(sessionId, { state: "failed" });
    }

    if (active === undefined) return true;
    const context = sideEffectLease!.context;
    await active.adapter.abort(context)
      .catch((error: unknown) => this.recordFailure("run_silence_abort", error));
    try {
      this.assertActiveBackendSideEffectLease(sideEffectLease!);
    } catch {
      return false;
    }
    const nativeState = await active.adapter.inspectSession(stored.descriptor.binding, context)
      .catch((error: unknown) => {
        this.recordFailure("run_silence_inspection", error);
        return undefined;
      });
    if (
      nativeState !== undefined &&
      !nativeState.streaming &&
      !nativeState.compacting &&
      nativeState.pendingMessages === 0
    ) return true;
    try {
      await active.adapter.closeSession(stored.descriptor.binding, context);
    } catch (error) {
      this.recordFailure("run_silence_close", error);
      return false;
    }
    if (this.#active.get(sessionId) === active) this.#active.delete(sessionId);
    this.#nativeCompactions.delete(sessionId);
    this.clearTurnOverrideLeases(sessionId);
    this.#releaseSessionTools(sessionId);
    this.#dismissPendingInteractions(
      new Set([sessionId]),
      "Backend runtime stopped after an active run ceased reporting progress."
    );
    return true;
    } finally {
      sideEffectLease?.release();
      releaseBackendAdmission?.();
    }
  }

  private trackBackgroundTask(
    sessionId: string,
    generation: number,
    payload: Extract<import("@joko/core").EventPayload, { readonly type: "background_task" }>,
    runId?: string,
    attemptId?: string,
    operationId?: string
  ): void {
    const terminal = payload.state === "completed" || payload.state === "failed" || payload.state === "aborted" || payload.state === "cancelled";
    const tasks = this.#backgroundTasks.get(sessionId) ?? new Map<string, TrackedBackgroundTask>();
    if (terminal) {
      if (tasks.get(payload.taskId)?.generation === generation) tasks.delete(payload.taskId);
    } else {
      const candidate = tasks.get(payload.taskId);
      const previous = candidate?.generation === generation ? candidate : undefined;
      const parentTaskId = payload.parentTaskId ?? previous?.parentTaskId;
      const progressRatio = payload.progressRatio ?? previous?.progressRatio;
      const startedAt = payload.startedAt ?? previous?.startedAt;
      tasks.set(payload.taskId, {
        taskId: payload.taskId,
        ...(parentTaskId === undefined ? {} : { parentTaskId }),
        title: payload.title,
        ...(progressRatio === undefined ? {} : { progressRatio }),
        ...(startedAt === undefined ? {} : { startedAt }),
        generation,
        ...(runId === undefined ? {} : { runId }),
        ...(attemptId === undefined ? {} : { attemptId }),
        ...(operationId === undefined ? {} : { operationId })
      });
    }
    if (tasks.size === 0) this.#backgroundTasks.delete(sessionId);
    else this.#backgroundTasks.set(sessionId, tasks);
  }

  private failBackgroundTasksForRuntimeLoss(stored: StoredSession, generation: number): void {
    const sessionId = stored.descriptor.id;
    const tasks = this.#backgroundTasks.get(sessionId);
    if (tasks === undefined) return;
    const matching = [...tasks.values()].filter((task) => task.generation === generation);
    if (matching.length === 0) return;
    const emittedAt = Date.now();
    const failure: PublicError = {
      code: "BACKGROUND_TASK_RUNTIME_LOST",
      message: "The backend runtime exited before this background task completed.",
      phase: "runtime",
      retryable: true,
      stateMayHaveChanged: true,
      recovery: "Resume the task and retry the background operation after checking its latest durable activity."
    };
    try {
      this.#store.transaction((store) => {
        for (const task of matching) {
          store.appendEvent({
            backendId: stored.descriptor.backendId,
            targetId: stored.descriptor.targetId,
            sessionId,
            ...(task.runId === undefined ? {} : { runId: task.runId }),
            ...(task.attemptId === undefined ? {} : { attemptId: task.attemptId }),
            ...(task.operationId === undefined ? {} : { operationId: task.operationId }),
            generation,
            emittedAt,
            traceId: `runtime-exit:${sessionId}:${generation}:${randomUUID()}`,
            payload: {
              type: "background_task",
              taskId: task.taskId,
              ...(task.parentTaskId === undefined ? {} : { parentTaskId: task.parentTaskId }),
              title: task.title,
              state: "failed",
              detail: "Backend runtime exited before this background task completed.",
              ...(task.progressRatio === undefined ? {} : { progressRatio: task.progressRatio }),
              ...(task.startedAt === undefined ? {} : { startedAt: task.startedAt }),
              endedAt: emittedAt,
              error: failure
            }
          });
        }
      });
    } catch (error) {
      this.recordFailure("background_task_runtime_exit", error);
    } finally {
      for (const task of matching) {
        if (tasks.get(task.taskId) === task) tasks.delete(task.taskId);
      }
      if (tasks.size === 0) this.#backgroundTasks.delete(sessionId);
    }
  }

  #releaseSessionTools(sessionId: string): void {
    try {
      this.#onSessionRuntimeClosed?.(sessionId);
    } catch {
      // Tool snapshot cleanup cannot change the already-completed Backend
      // lifecycle outcome; providers also clear all state during shutdown.
    }
  }

  resolveInteraction(id: string, generation: number, decision: InteractionDecision, traceId: string, operationId?: string): void {
    const interaction = this.#store.getInteraction(id);
    if (interaction.status !== "open") {
      throw new InvalidStateTransitionError("interaction", interaction.status, "resolved");
    }
    const pending = this.#pendingInteractions.get(id);
    if (pending?.generation === generation && !this.backendInstanceGenerationOwnsContext(
      interaction.sessionId,
      pending.backendInstanceGeneration,
      pending.runId,
      pending.attemptId
    )) {
      this.#store.dismissInteraction(
        id,
        generation,
        "The Backend instance was replaced before this response arrived.",
        traceId,
        operationId
      );
      this.#pendingInteractions.delete(id);
      clearPendingInteractionExpiry(pending);
      pending.resolve({ kind: "cancelled" });
      throw new JokoError({
        code: "BACKEND_INSTANCE_STALE",
        message: "The interaction belongs to a retired Backend instance.",
        phase: "interaction",
        retryable: false,
        stateMayHaveChanged: false,
        recovery: "Refresh the task before responding to another interaction."
      });
    }
    this.#store.resolveInteraction(id, generation, decision, traceId, operationId);
    if (pending?.generation === generation) {
      this.#pendingInteractions.delete(id);
      clearPendingInteractionExpiry(pending);
      pending.resolve(decision);
    }
    this.refreshRunSilenceWatchdog(interaction.sessionId);
    if (decision.kind === "plan_review" && decision.decision === "execute") {
      this.#store.updateSession(interaction.sessionId, { planMode: false });
      this.#dismissPendingInteractions(
        new Set([interaction.sessionId]),
        "Plan mode ended after the approved plan was scheduled for execution."
      );
    }
  }

  dismissInteraction(id: string, generation: number, reason: string, traceId: string, operationId?: string): void {
    const interaction = this.#store.getInteraction(id);
    if (interaction.status !== "open") {
      throw new InvalidStateTransitionError("interaction", interaction.status, "dismissed");
    }
    this.#store.dismissInteraction(id, generation, reason, traceId, operationId);
    const pending = this.#pendingInteractions.get(id);
    if (pending?.generation === generation) {
      this.#pendingInteractions.delete(id);
      clearPendingInteractionExpiry(pending);
      pending.resolve({ kind: "cancelled" });
    }
    this.refreshRunSilenceWatchdog(interaction.sessionId);
  }

  fencePendingInteractionsForTarget(targetId: string, reason: string): void {
    const sessionIds = new Set(
      this.#store.listSessions({ targetId, includeArchived: true, includeDeleted: true })
        .map((session) => session.descriptor.id)
    );
    this.#dismissPendingInteractions(sessionIds, reason);
  }

  #dismissPendingInteractions(sessionIds: ReadonlySet<string>, reason: string): void {
    if (sessionIds.size === 0) return;
    const open = listAllInteractions(this.#store, { status: "open" })
      .filter((interaction) => sessionIds.has(interaction.sessionId));
    for (const interaction of open) {
      try {
        this.#store.dismissInteraction(
          interaction.id,
          interaction.generation,
          reason,
          `interaction-policy:${interaction.id}`
        );
      } catch (error) {
        // A newer native binding already fences this interaction in the
        // durable store. Still release any in-memory waiter so a stale bridge
        // cannot hold the previous runtime open.
        if (!(error instanceof StaleGenerationError)) throw error;
      }
      const pending = this.#pendingInteractions.get(interaction.id);
      if (pending?.generation === interaction.generation) {
        this.#pendingInteractions.delete(interaction.id);
        clearPendingInteractionExpiry(pending);
        pending.resolve({ kind: "cancelled" });
      }
    }
    for (const sessionId of sessionIds) this.refreshRunSilenceWatchdog(sessionId);
  }

  /**
   * Adapter lifecycle callback for an unexpectedly exited native runtime.
   * It removes only the matching product-generation activation so the next
   * operation resumes the durable native session instead of reusing a dead
   * transport retained by SessionHost.
   */
  invalidateRuntime(input: {
    readonly backendId: string;
    readonly backendInstanceGeneration: number;
    readonly sessionId: string;
    readonly generation: number;
  }): void {
    if (this.#disposed) return;
    const active = this.#active.get(input.sessionId);
    if (
      active === undefined
      || active.adapter.id !== input.backendId
      || active.backendInstanceGeneration !== input.backendInstanceGeneration
      || this.#adapters.get(input.backendId) !== active.adapter
      || this.#adapterGenerations.get(input.backendId) !== input.backendInstanceGeneration
    ) return;
    let stored: StoredSession;
    try {
      stored = this.#store.getSession(input.sessionId);
      if (
        this.#store.getBackend(input.backendId).descriptor.instanceGeneration
        !== input.backendInstanceGeneration
      ) return;
    } catch {
      return;
    }
    if (
      stored.descriptor.backendId !== input.backendId
      || stored.descriptor.binding.generation !== input.generation
    ) return;
    this.clearRunSilenceWatchdog(input.sessionId);
    this.failBackgroundTasksForRuntimeLoss(stored, input.generation);
    this.#active.delete(input.sessionId);
    this.#nativeCompactions.delete(input.sessionId);
    this.clearTurnOverrideLeases(input.sessionId);
    this.#dismissPendingInteractions(
      new Set([input.sessionId]),
      "Backend runtime exited while the interaction was pending."
    );
    if (this.isReviewReadOnlySession(input.sessionId)) {
      this.#reviewRuntimeFlights.get(input.sessionId)?.rejectAcceptance(
        new StoreError("Reviewer Backend exited before acceptance.")
      );
      void this.finishReviewSettledSession(input.sessionId, "failed")
        .catch(() => undefined)
        .finally(() => this.settleReviewRuntime(input.sessionId, { state: "failed" }));
    }
  }

  /** Exact-generation admission for native effects that are scoped to a whole Backend process. */
  async invokeBackendAdapter<T>(
    backendId: string,
    effect: (adapter: BackendAdapter, backendInstanceGeneration: number) => T | Promise<T>
  ): Promise<T> {
    this.#assertOpen();
    if (backendId.trim() === "") throw new StoreError("A Backend effect requires a Backend ID.");
    const adapter = this.requireAdapter(backendId);
    const generation = this.requireAdapterGeneration(backendId, adapter);
    const release = this.beginBackendAdmissionEffect(backendId);
    try {
      this.assertCurrentAdapterGeneration(backendId, adapter, generation);
      const result = await effect(adapter, generation);
      this.assertCurrentAdapterGeneration(backendId, adapter, generation);
      return result;
    } finally {
      release();
    }
  }

  /**
   * Coordinates an idle-only Backend process replacement. The fence is
   * installed before candidate construction starts. The supplied replacement
   * owner must durably publish before invoking `activateCurrent`; that callback
   * switches this Host synchronously, before the replacement owner can await.
   */
  async replaceBackendInstance<T>(input: {
    readonly backendId: string;
    readonly expectedCurrentGeneration: number;
    readonly perform: (hooks: BackendInstanceReplacementHooks) => Promise<T>;
  }): Promise<T> {
    this.#assertOpen();
    if (!Number.isSafeInteger(input.expectedCurrentGeneration) || input.expectedCurrentGeneration < 0) {
      throw new StoreError("Backend instance generation must be a non-negative safe integer.");
    }
    const durable = this.#store.getBackend(input.backendId).descriptor;
    if (durable.instanceGeneration !== input.expectedCurrentGeneration) {
      throw new StoreError("The Backend durable generation changed before replacement admission.");
    }
    if (this.#backendReplacementFences.has(input.backendId)) {
      throw new StoreError("This Backend instance is already being replaced.");
    }
    const previousAdapter = this.#adapters.get(input.backendId);
    const previousAdapterGeneration = this.#adapterGenerations.get(input.backendId);
    if (
      previousAdapter !== undefined
      && previousAdapterGeneration !== input.expectedCurrentGeneration
    ) throw new StoreError("The Backend process-local generation does not match durable truth.");
    if (previousAdapter === undefined && previousAdapterGeneration !== undefined) {
      throw new StoreError("The unavailable Backend retained an invalid process-local generation.");
    }

    const token = Symbol(`backend-replacement:${input.backendId}`);
    const closedSessionIds: string[] = [];
    let prepared = false;
    let switched = false;
    let currentAdapter: BackendAdapter | undefined;
    let currentAdapterGeneration: number | undefined;
    let commitCurrent = (): void => undefined;
    this.#backendReplacementFences.set(input.backendId, token);

    const restore = async (): Promise<void> => {
      const failures: unknown[] = [];
      for (const sessionId of closedSessionIds) {
        try {
          const stored = this.#store.getSession(sessionId);
          if (stored.descriptor.archived || stored.descriptor.deletedAt !== undefined) continue;
          await this.activateWithPolicy(sessionId, false, false, undefined, false, true);
        } catch (error) {
          failures.push(error);
        }
      }
      closedSessionIds.length = 0;
      if (failures.length > 0) {
        throw new AggregateError(failures, "Backend replacement could not restore every previously active task.");
      }
    };

    try {
      // Replacement is strictly idle-only. Reject before candidate construction
      // so an already-running native effect cannot make a freshly built
      // process instance stale while the Host waits.
      this.#assertBackendReplacementIdle(input.backendId);
      const result = await input.perform({
        preparePrevious: async (adapter, generation) => {
          if (prepared) throw new StoreError("The Backend replacement was prepared more than once.");
          if (this.#backendReplacementFences.get(input.backendId) !== token) {
            throw new StoreError("The Backend replacement admission fence changed.");
          }
          if (
            adapter.id !== input.backendId
            || !Number.isSafeInteger(generation)
            || generation <= input.expectedCurrentGeneration
          ) throw new StoreError("The Backend replacement candidate identity or generation is invalid.");
          if (
            this.#adapters.get(input.backendId) !== previousAdapter
            || this.#adapterGenerations.get(input.backendId) !== previousAdapterGeneration
          ) throw new StoreError("The Backend process-local owner changed before replacement preparation.");
          if (this.#store.getBackend(input.backendId).descriptor.instanceGeneration !== input.expectedCurrentGeneration) {
            throw new StoreError("The Backend durable generation changed before replacement preparation.");
          }
          prepared = true;
          commitCurrent = () => {
            this.#adapters.set(input.backendId, adapter);
            this.#adapterGenerations.set(input.backendId, generation);
            this.invalidateNativeSessionCatalog(input.backendId);
            currentAdapter = adapter;
            currentAdapterGeneration = generation;
            switched = true;
          };
          if (
            this.#adapters.get(input.backendId) !== previousAdapter
            || this.#adapterGenerations.get(input.backendId) !== previousAdapterGeneration
            || this.#store.getBackend(input.backendId).descriptor.instanceGeneration !== input.expectedCurrentGeneration
          ) throw new StoreError("The Backend owner changed before replacement preparation.");
          this.#assertBackendReplacementIdle(input.backendId);
          const sessions = this.#store.listSessions({ includeArchived: false })
            .filter((session) => session.descriptor.backendId === input.backendId);
          const activeSessions: Array<{ readonly sessionId: string; readonly active: ActiveSession }> = [];
          // Drain every old-generation projection before closing any runtime.
          // A later whole-Adapter hard retirement is therefore never allowed
          // to overtake durable projection work owned by another task.
          for (const stored of sessions) {
            const sessionId = stored.descriptor.id;
            const active = this.#active.get(sessionId);
            if (active === undefined) continue;
            if (
              previousAdapter === undefined
              || active.adapter !== previousAdapter
              || active.backendInstanceGeneration !== input.expectedCurrentGeneration
            ) throw new StoreError("An active task is not owned by the exact Backend generation being replaced.");
            await backendRetirementDeadline(
              this.waitForSessionProjectionIdle(sessionId),
              this.#backendRetirementTimeoutMs,
              "Old-generation task projections did not drain before the Backend retirement deadline."
            );
            if (this.#active.get(sessionId) !== active) {
              throw new StoreError("A task runtime changed while Backend replacement was draining projections.");
            }
            activeSessions.push({ sessionId, active });
          }
          let forceRetiredPrevious = false;
          for (const { sessionId, active } of activeSessions) {
            const current = this.#store.getSession(sessionId);
            if (this.#active.get(sessionId) !== active) {
              throw new StoreError("A task runtime changed while Backend replacement was preparing it.");
            }
            let retired = false;
            try {
              const close = active.adapter.closeSession(
                current.descriptor.binding,
                this.contextFor(current, undefined, undefined, undefined, undefined, active.backendInstanceGeneration)
              );
              await backendRetirementDeadline(
                close,
                this.#backendRetirementTimeoutMs,
                "The old Backend runtime did not close before its retirement deadline."
              );
              retired = true;
            } catch (error) {
              if (!(error instanceof BackendRetirementTimeoutError)) {
                // A completed close rejection may already have retired native
                // state. Preserve the prior fail-closed restoration behavior.
                retired = true;
                throw error;
              }
              if (active.adapter.forceDispose === undefined) throw error;
              await backendRetirementDeadline(
                Promise.resolve().then(() => active.adapter.forceDispose!()),
                this.#backendRetirementTimeoutMs,
                "The exact old Backend instance did not confirm hard retirement."
              );
              retired = true;
              forceRetiredPrevious = true;
            } finally {
              if (retired) {
                if (this.#active.get(sessionId) === active) this.#active.delete(sessionId);
                this.#nativeCompactions.delete(sessionId);
                this.clearTurnOverrideLeases(sessionId);
                closedSessionIds.push(sessionId);
              }
            }
            if (forceRetiredPrevious) {
              // forceDispose retires the whole exact Adapter instance. Remove
              // every remaining old-generation runtime projection in one
              // synchronous sweep; every projection was drained above.
              for (const remaining of activeSessions) {
                const remainingId = remaining.sessionId;
                const remainingActive = this.#active.get(remainingId);
                if (remainingActive !== remaining.active) continue;
                this.#active.delete(remainingId);
                this.#nativeCompactions.delete(remainingId);
                this.clearTurnOverrideLeases(remainingId);
                if (!closedSessionIds.includes(remainingId)) closedSessionIds.push(remainingId);
              }
              break;
            }
          }
          this.#assertBackendReplacementIdle(input.backendId);
        },
        activateCurrent: () => { commitCurrent(); }
      });
      if (!switched) throw new StoreError("Backend replacement completed without activating a new instance.");
      if (currentAdapter === undefined || currentAdapterGeneration === undefined) {
        throw new StoreError("Backend replacement lost the activated process owner.");
      }
      await this.reconcileDetachedSubagentObserversForBackend(
        input.backendId,
        currentAdapter,
        currentAdapterGeneration
      );
      await restore();
      return result;
    } catch (error) {
      try {
        await restore();
      } catch (restoreError) {
        throw new AggregateError([error, restoreError], "Backend replacement failed and active-task restoration was incomplete.");
      }
      throw error;
    } finally {
      if (this.#backendReplacementFences.get(input.backendId) === token) {
        this.#backendReplacementFences.delete(input.backendId);
      }
      if (!this.#disposed) {
        for (const session of this.#store.listSessions({ includeArchived: false })) {
          if (session.descriptor.backendId === input.backendId) void this.drain(session.descriptor.id);
        }
      }
    }
  }

  private async reconcileDetachedSubagentObserversForBackend(
    backendId: string,
    adapter: BackendAdapter,
    backendInstanceGeneration: number
  ): Promise<void> {
    if (adapter.observeDetachedSubagents === undefined) return;
    for (const stored of this.#store.listSessions({ includeArchived: false })) {
      if (
        stored.descriptor.backendId !== backendId
        || stored.descriptor.deletedAt !== undefined
        || this.#store.findPendingSessionLifecycleCleanup(stored.descriptor.id) !== undefined
        || this.#store.findPendingScheduleDeletionCleanupForSession(stored.descriptor.id) !== undefined
      ) continue;
      try {
        this.assertCurrentAdapterGeneration(backendId, adapter, backendInstanceGeneration);
        await adapter.observeDetachedSubagents(this.contextFor(
          stored,
          undefined,
          undefined,
          undefined,
          undefined,
          backendInstanceGeneration
        ));
        this.assertCurrentAdapterGeneration(backendId, adapter, backendInstanceGeneration);
      } catch (error) {
        this.recordFailure("detached_subagent_replacement_recovery", error);
      }
    }
  }

  assertRuntimeRestartIdle(sessionId: string): void {
    this.#assertOpen();
    if (this.isReviewReadOnlySession(sessionId)) {
      throw new StoreError("Reviewer runtimes cannot be restarted.");
    }
    this.assertSessionNotPendingScheduleDeletion(sessionId);
    if (
      this.#store.listActiveSessionBackgroundTaskEvents(sessionId).length > 0 ||
      this.#store.listInteractions({ sessionId, status: "open", limit: 1 }).length > 0 ||
      this.#store.listToolLeases({ sessionId, activeOnly: true }).length > 0 ||
      this.#store.hasActiveSessionBackgroundTasks(sessionId) ||
      !this.canEnterSessionArchive(sessionId)
    ) {
      throw new StoreError(
        "A Backend can be restarted only after every affected task has no active or queued work."
      );
    }
  }

  async restart(sessionId: string): Promise<void> {
    const existing = this.#runtimeRestartFlights.get(sessionId);
    if (existing !== undefined) return existing;
    const restartAdmission = this.beginBackendAdmissionEffect(
      this.#store.getSession(sessionId).descriptor.backendId
    );
    try {
      this.assertRuntimeRestartIdle(sessionId);
      this.#runtimeRestartFences.add(sessionId);
    } finally {
      restartAdmission();
    }
    const task = this.restartOnce(sessionId).finally(() => {
      if (this.#runtimeRestartFlights.get(sessionId) === task) {
        this.#runtimeRestartFlights.delete(sessionId);
      }
      this.#runtimeRestartFences.delete(sessionId);
      if (this.#disposed) return;
      void this.drain(sessionId);
    });
    this.#runtimeRestartFlights.set(sessionId, task);
    return task;
  }

  private async restartOnce(sessionId: string): Promise<void> {
    this.clearRunSilenceWatchdog(sessionId);
    this.#dismissPendingInteractions(
      new Set([sessionId]),
      "Backend runtime restarted while the interaction was pending."
    );
    await this.waitForSessionProjectionIdle(sessionId);
    const active = this.#active.get(sessionId);
    if (active !== undefined) {
      const stored = this.#store.getSession(sessionId);
      try {
        await active.adapter.closeSession(stored.descriptor.binding, this.contextFor(stored));
      } finally {
        if (this.#active.get(sessionId) === active) this.#active.delete(sessionId);
        this.#nativeCompactions.delete(sessionId);
        this.clearTurnOverrideLeases(sessionId);
      }
    }
    await this.activateWithPolicy(sessionId, false, false, undefined, true);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const pending of this.#pendingInteractions.values()) {
      clearPendingInteractionExpiry(pending);
      pending.resolve({ kind: "cancelled" });
    }
    this.#pendingInteractions.clear();
    for (const watchdog of this.#runSilenceWatchdogs.values()) {
      if (watchdog.timer !== undefined) clearTimeout(watchdog.timer);
    }
    this.#runSilenceWatchdogs.clear();
    for (const reviewerSessionId of this.#reviewRuntimeFlights.keys()) {
      this.settleReviewRuntime(reviewerSessionId, { state: "closed" });
    }
    this.#reviewRuntimeFlights.clear();
    this.#pendingDispatchAcceptances.clear();
    for (const preparation of this.#dispatchPreparations.values()) preparation.resolve();
    this.#dispatchPreparations.clear();
    this.#turnOverrideLeases.clear();
    await Promise.allSettled([...this.#sessionRuntimeControlTails.values()]);
    this.#sessionRuntimeControlTails.clear();
    this.#sessionRuntimeControlEffects.clear();
    this.#sessionRuntimeControl.clearAll();
    for (const recovery of this.#sessionRuntimeRecoveries.values()) {
      if (recovery.timer !== undefined) clearTimeout(recovery.timer);
    }
    this.#sessionRuntimeRecoveries.clear();
    this.#backgroundTasks.clear();
    this.#messageDeletionLocks.clear();
    this.#sessionResetLocks.clear();
    this.#sessionLifecycleFences.clear();
    await Promise.allSettled([...this.#runtimeRestartFlights.values()]);
    this.#runtimeRestartFlights.clear();
    this.#runtimeRestartFences.clear();
    this.#backendReplacementFences.clear();
    await Promise.allSettled(
      [...this.#backendSideEffectFlights.values()].flatMap((flights) => [...flights])
    );
    this.#backendSideEffectFlights.clear();
    this.#activeEffectFlights.clear();
    this.#sessionLifecycleBackendAdmissions.clear();
    this.#backendAdmissionEffects.clear();
    await Promise.allSettled([...this.#closeIfActiveFlights.values()]);
    this.#closeIfActiveFlights.clear();
    await Promise.allSettled([...this.#reaping.values()]);
    this.#reaping.clear();
    await Promise.allSettled([...this.#runSilenceRecoveries.values()]);
    this.#runSilenceRecoveries.clear();
    await Promise.allSettled([...this.#nativeHistoryTails.values()]);
    this.#nativeHistoryTails.clear();
    await Promise.allSettled([...this.#runtimeCommandTails.values()]);
    this.#runtimeCommandTails.clear();
    await Promise.allSettled([...this.#nativeStateTails.values()]);
    this.#nativeStateTails.clear();
    this.#nativeCompactions.clear();
    this.#compactionEventEpochs.clear();
    this.#explicitCompactionFlights.clear();
    this.#compactionEffects.clear();
    this.#compactionQueueWindows.clear();
    const adapters = [...this.#adapters.values()];
    const adapterResults = await Promise.allSettled(adapters.map((adapter) => adapter.dispose()));
    const adapterFailures: unknown[] = [];
    for (let index = 0; index < adapterResults.length; index += 1) {
      const result = adapterResults[index]!;
      if (result.status === "fulfilled") continue;
      adapterFailures.push(result.reason);
      try {
        this.recordFailure(`adapter_shutdown:${adapters[index]!.id}`, result.reason, true);
      } catch {
        // Store shutdown races cannot make the original fail-closed Adapter
        // error disappear; it remains in the aggregate thrown below.
      }
    }
    // Adapter shutdown interrupts any send that was still awaiting native
    // acceptance. Join those dispatchers while the Store remains available so
    // none can resume against a Store closed by the application owner.
    await Promise.allSettled([...this.#drainSettlements.values()]);
    this.#drainSettlements.clear();
    await Promise.allSettled([...this.#inflightEmissions.values()].flatMap((emissions) => [...emissions]));
    this.#inflightEmissions.clear();
    this.#active.clear();
    this.#activating.clear();
    this.#draining.clear();
    this.#creationLocks.clear();
    this.#portableImportLocks.clear();
    this.#portableImportDrafts.clear();
    this.#nativeBindingLocks.clear();
    this.#nativeSessionCatalogFlights.clear();
    this.#nativeSessionCatalogCache.clear();
    this.#nativeSessionCatalogSnapshots.clear();
    this.#nativeSessionCatalogEpochs.clear();
    this.#nativeSessionCatalogConsumedEpochs.clear();
    this.#activeEffects.clear();
    this.#adapters.clear();
    this.#adapterGenerations.clear();
    if (adapterFailures.length > 0) {
      throw new AggregateError(
        adapterFailures,
        `${adapterFailures.length} Backend Adapter shutdown${adapterFailures.length === 1 ? "" : "s"} failed.`
      );
    }
  }

  private portableImportExecutionWithActivation(
    execution: OperationExecution<ImportPortableSessionResult>
  ): OperationExecution<ImportPortableSessionResult> {
    const activation = portableImportActivationRecord(this.#store.findSetting(
      "session",
      execution.value.sessionId,
      PORTABLE_IMPORT_ACTIVATION_SETTING_KEY
    )?.value) ?? portableActivationFailedRecord(new Error("Native task activation did not complete."));
    const { activationError: _storedActivationError, ...storedValue } = execution.value;
    return {
      ...execution,
      value: {
        ...storedValue,
        status: activation.status,
        ...(activation.error === undefined ? {} : { activationError: activation.error })
      }
    };
  }

  private persistPortableImportActivation(sessionId: string, record: PortableImportActivationRecord): void {
    this.#store.setSetting("session", sessionId, PORTABLE_IMPORT_ACTIVATION_SETTING_KEY, record, record.updatedAt);
  }

  private async tryPortableSessionActivation(sessionId: string): Promise<PortableImportActivationRecord> {
    try {
      await this.activate(sessionId);
      const ready = portableActivationReadyRecord();
      this.persistPortableImportActivation(sessionId, ready);
      return ready;
    } catch (error) {
      this.recordFailure("portable_import_activation", error);
      const failed = portableActivationFailedRecord(error);
      this.persistPortableImportActivation(sessionId, failed);
      return failed;
    }
  }

  private async importPortableSessionOnce(
    input: ImportPortableSessionInput,
    preparedDraft?: PreparedPortableSessionImport
  ): Promise<OperationExecution<ImportPortableSessionResult>> {
    this.#store.authorizeConnection(input.connection.id, input.connection.authKeyDigest);
    const prepared = preparedDraft ?? preparePortableSessionImport(
      (await this.#artifactStore.readBlob(input.package)).data,
      {
        ...(input.password === undefined ? {} : { password: input.password }),
        contentLimitBytes: Math.min(this.#artifactStore.maximumBlobBytes, 256 * 1024 * 1024)
      }
    );
    const importTitle = portableImportTitle(input.title, prepared.manifest.title);
    const logicalBody = portableImportOperationBody(input);
    const claim = this.#store.claimAuthorizedDeferredEffectOperation<ImportPortableSessionResult>(
      input.connection.id,
      input.connection.authKeyDigest,
      { id: input.operationId, kind: "import_portable_session", body: logicalBody },
      (store) => {
        store.getTarget(input.targetId);
        const conflict = findPortableImportConflict(store, input.targetId, input.package.sha256);
        if (conflict !== undefined && !input.overwrite) throw portableImportConflict(conflict.descriptor.id);
      }
    );
    if (!claim.claimed) {
      return this.portableImportExecutionWithActivation({
        replayed: true,
        value: claim.value,
        operation: claim.operation
      });
    }

    const sessionId = stableId("session", input.operationId);
    let createdBinding: NativeSessionBinding | undefined;
    let cleanupContext: AdapterContext | undefined;
    let acquiredWorktree = false;
    let createdLiveRuntime = false;
    let replaced: StoredSession | undefined;
    let adapterForCleanup: BackendAdapter | undefined;
    let backendInstanceGeneration: number | undefined;
    let releaseBackendAdmission: (() => void) | undefined;
    try {
      const target = this.#store.getTarget(input.targetId);
      let providerId = input.providerId;
      let modelId = input.modelId;
      if (prepared.nativeSession === undefined) {
        const resolved = this.resolveNewSessionRoute(target.descriptor.backendId, {
          operationId: input.operationId,
          connection: input.connection,
          targetId: input.targetId,
          title: importTitle,
          ...(providerId === undefined ? {} : { providerId }),
          ...(modelId === undefined ? {} : { modelId }),
          ...(input.effort === undefined ? {} : { effort: input.effort }),
          fastMode: input.fastMode,
          permissionMode: input.permissionMode,
          planMode: input.planMode,
          nativeStart: { kind: "new" }
        });
        this.assertBackendCreationReady(target.descriptor.backendId, resolved);
        providerId = resolved.providerId;
        modelId = resolved.modelId;
      } else {
        this.assertBackendCreationReady(target.descriptor.backendId, {
          operationId: input.operationId,
          connection: input.connection,
          targetId: input.targetId,
          title: importTitle,
          ...(providerId === undefined ? {} : { providerId }),
          ...(modelId === undefined ? {} : { modelId }),
          ...(input.effort === undefined ? {} : { effort: input.effort }),
          fastMode: input.fastMode,
          permissionMode: input.permissionMode,
          planMode: input.planMode,
          nativeStart: { kind: "attach", nativeReference: "portable://existing" }
        });
      }
      const adapter = this.requireAdapter(target.descriptor.backendId);
      adapterForCleanup = adapter;
      backendInstanceGeneration = this.requireAdapterGeneration(target.descriptor.backendId, adapter);
      releaseBackendAdmission = this.beginBackendAdmissionEffect(target.descriptor.backendId);
      this.validateFastSelection(
        target.descriptor.backendId,
        providerId,
        modelId,
        input.fastMode,
        "Importing a portable task with Fast Mode"
      );
      if (prepared.nativeSession !== undefined) {
        const capability = this.#store.getBackend(target.descriptor.backendId).descriptor.capabilities
          .get("session.portable_transfer");
        if (capability?.supported !== true || adapter.importPortableNativeSession === undefined) {
          throw new JokoError({
            code: "PORTABLE_SESSION_IMPORT_UNSUPPORTED",
            message: "The selected Backend cannot restore this package's native task history.",
            phase: "capability",
            retryable: false,
            stateMayHaveChanged: false,
            recovery: "Choose a Backend that advertises session.portable_transfer."
          });
        }
      }
      if (input.worktree !== undefined && prepared.manifest.workspaceKind !== "project") {
        throw new StoreError("Only a project task can be imported into an isolated workspace.");
      }
      if (input.worktree !== undefined && target.descriptor.remoteWorkspace !== undefined) {
        throw new StoreError("Isolated workspaces are unavailable for Remote portable imports.");
      }
      if (input.worktree !== undefined && this.#worktrees === undefined) {
        throw new StoreError("Isolated workspace creation is unavailable on this service.");
      }

      replaced = findPortableImportConflict(this.#store, input.targetId, input.package.sha256);
      if (replaced !== undefined) {
        if (!input.overwrite) throw portableImportConflict(replaced.descriptor.id);
        this.assertPortableReplacementIdle(replaced.descriptor.id);
        const active = this.#active.get(replaced.descriptor.id);
        if (active !== undefined) {
          if (active.adapter.detachSession !== undefined) {
            await active.adapter.detachSession(replaced.descriptor.binding, this.contextFor(replaced));
          } else {
            await active.adapter.closeSession(replaced.descriptor.binding, this.contextFor(replaced));
          }
          this.#active.delete(replaced.descriptor.id);
          this.#nativeCompactions.delete(replaced.descriptor.id);
          this.clearTurnOverrideLeases(replaced.descriptor.id);
          this.#releaseSessionTools(replaced.descriptor.id);
        }
      }

      const sessionWorktree = input.worktree === undefined
        ? undefined
        : await this.#worktrees!.acquire({
            sessionId,
            target: target.descriptor,
            ...(input.worktree.sourceRef === undefined ? {} : { sourceRef: input.worktree.sourceRef }),
            refreshRemote: input.worktree.refreshRemote
          });
      if (sessionWorktree !== undefined) acquiredWorktree = true;
      const runtimeTarget = sessionWorktree === undefined
        ? target.descriptor
        : { ...target.descriptor, workspaceRoot: sessionWorktree.path };
      const provisional = this.provisionalContext(
        sessionId,
        runtimeTarget,
        1,
        undefined,
        undefined,
        backendInstanceGeneration
      );
      createdBinding = prepared.nativeSession === undefined
        ? await adapter.createSession({
            target: runtimeTarget,
            name: importTitle,
            providerId,
            modelId,
            effort: input.effort,
            fastMode: input.fastMode,
            permissionMode: input.permissionMode,
            nativeStart: { kind: "new" }
          }, provisional)
        : await adapter.importPortableNativeSession!({
            target: runtimeTarget,
            bytes: prepared.nativeSession.bytes,
            generation: 1,
            nativeSessionId: stableId("portable", input.operationId)
          }, provisional.signal);
      createdLiveRuntime = prepared.nativeSession === undefined;
      cleanupContext = { ...provisional, binding: createdBinding };
      if (createdLiveRuntime && input.planMode) await adapter.setPlanMode(true, cleanupContext);

      const materialized = await materializePortableSessionImport(prepared, async (media) => {
        const stored = await this.#artifactStore.ingestBytes(media.bytes, {
          ...(media.fileName === undefined ? {} : { fileName: media.fileName }),
          mimeType: media.mimeType
        });
        return {
          id: stored.id,
          sha256: stored.sha256,
          byteLength: stored.byteLength,
          mimeType: stored.mimeType,
          ...(stored.fileName === undefined ? {} : { fileName: stored.fileName })
        };
      });
      if (operationBodyHash(portableImportOperationBody(input)) !== claim.operation.bodyHash) {
        throw new Error("Portable task import input changed during execution.");
      }
      this.assertCurrentAdapterGeneration(
        target.descriptor.backendId,
        adapter,
        backendInstanceGeneration
      );
      const now = Date.now();
      const result = this.#store.completeAuthorizedDeferredEffectOperation<ImportPortableSessionResult>(
        input.connection.id,
        input.connection.authKeyDigest,
        claim.operation.id,
        claim.operation.bodyHash,
        (store) => {
          const currentTarget = store.getTarget(input.targetId);
          if (currentTarget.revision !== target.revision) {
            throw new RevisionConflictError("Target", input.targetId, target.revision, currentTarget.revision);
          }
          const currentConflict = findPortableImportConflict(store, input.targetId, input.package.sha256);
          if (currentConflict?.descriptor.id !== replaced?.descriptor.id) {
            if (currentConflict !== undefined || replaced !== undefined) {
              throw new RevisionConflictError(
                "Portable import conflict",
                input.targetId,
                replaced?.revision ?? 0n,
                currentConflict?.revision ?? 0n
              );
            }
          }
          if (replaced !== undefined) {
            const current = store.getSession(replaced.descriptor.id);
            if (current.revision !== replaced.revision) {
              throw new RevisionConflictError("Session", current.descriptor.id, replaced.revision, current.revision);
            }
            store.updateSession(current.descriptor.id, {
              deletedAt: now,
              archived: true,
              pinned: false
            }, current.revision, now);
          }
          const descriptor: SessionDescriptor = {
            id: sessionId,
            backendId: target.descriptor.backendId,
            targetId: target.descriptor.id,
            title: importTitle,
            binding: createdBinding!,
            pinned: false,
            archived: false,
            permissionMode: input.permissionMode,
            planMode: input.planMode,
            ...(providerId === undefined ? {} : { providerId }),
            ...(modelId === undefined ? {} : { modelId }),
            ...(input.effort === undefined ? {} : { effort: input.effort }),
            fastMode: input.fastMode,
            ...(sessionWorktree === undefined ? {} : { worktree: sessionWorktree }),
            ...(target.descriptor.remoteWorkspace === undefined
              ? {}
              : { remoteWorkspace: target.descriptor.remoteWorkspace }),
            createdAt: now,
            updatedAt: now
          };
          store.createSession(descriptor);
          store.setSetting("session", sessionId, PORTABLE_IMPORT_SOURCE_SETTING_KEY, {
            format: 1,
            targetId: input.targetId,
            packageSha256: input.package.sha256,
            importedAt: now
          }, now);
          const initialActivation = prepared.nativeSession === undefined
            ? portableActivationReadyRecord(now)
            : portableActivationFailedRecord(new Error("Native task activation has not completed."), now);
          store.setSetting(
            "session",
            sessionId,
            PORTABLE_IMPORT_ACTIVATION_SETTING_KEY,
            initialActivation,
            now
          );
          materialized.events.forEach((event, index) => {
            store.appendEvent({
              backendId: descriptor.backendId,
              targetId: descriptor.targetId,
              sessionId,
              operationId: input.operationId,
              generation: descriptor.binding.generation,
              emittedAt: event.emittedAt,
              traceId: `portable-import:${input.operationId}:message:${index}`,
              payload: event.payload,
              metadata: {
                namespace: "joko.portable_import",
                fields: { sourceSha256: input.package.sha256, messageIndex: index }
              }
            });
          });
          for (const [index, worker] of (materialized.manifest.workers ?? []).entries()) {
            const workerId = stableId("imported-worker", `${sessionId}\0${worker.id}`);
            const state = importedSubagentState(worker.state);
            const at = Number.isFinite(Date.parse(materialized.manifest.exportedAt))
              ? Date.parse(materialized.manifest.exportedAt)
              : now;
            store.appendEvent({
              backendId: descriptor.backendId,
              targetId: descriptor.targetId,
              sessionId,
              operationId: input.operationId,
              generation: descriptor.binding.generation,
              emittedAt: at + index,
              traceId: `portable-import:${input.operationId}:worker:${index}`,
              payload: {
                type: "subagent_run",
                run: {
                  id: workerId,
                  sessionId,
                  logicalAgentId: workerId,
                  identityAliases: [worker.id],
                  providerRunIds: [],
                  state,
                  title: worker.title,
                  ...(worker.label === undefined ? {} : { description: worker.label }),
                  capabilities: {
                    viewActivity: true,
                    viewReturnedResult: false,
                    viewFullTranscript: false,
                    stop: false,
                    steer: false,
                    followUp: false,
                    resume: false,
                    parentContext: "snapshot"
                  },
                  startedAt: at,
                  updatedAt: at,
                  ...(state === "completed" || state === "failed" || state === "stopped" ? { endedAt: at } : {}),
                  activity: []
                }
              },
              metadata: {
                namespace: "joko.portable_import",
                fields: { sourceSha256: input.package.sha256, workerIndex: index, focused: worker.focused }
              }
            });
          }
          return {
            sessionId,
            fidelity: materialized.manifest.fidelity,
            messageCount: materialized.manifest.messageCount,
            mediaCount: materialized.manifest.mediaCount,
            workerCount: materialized.manifest.workers?.length ?? 0,
            replacedSessionIds: replaced === undefined ? [] : [replaced.descriptor.id],
            status: initialActivation.status,
            ...(initialActivation.error === undefined ? {} : { activationError: initialActivation.error })
          };
        }
      );
      acquiredWorktree = false;
      createdBinding = undefined;
      cleanupContext = undefined;
      if (createdLiveRuntime) {
        this.#active.set(
          sessionId,
          this.activeSession(adapter, sessionId, backendInstanceGeneration)
        );
      } else {
        await this.tryPortableSessionActivation(sessionId);
      }
      if (replaced !== undefined) {
        const replacedContext = this.contextFor(replaced);
        await adapter.deleteSession(replaced.descriptor.binding, replacedContext)
          .catch((error: unknown) => this.recordFailure("portable_import_replaced_native_cleanup", error));
        if (replaced.descriptor.worktree !== undefined && this.#worktrees !== undefined) {
          await this.#worktrees.release(replaced.descriptor.id)
            .catch((error: unknown) => this.recordFailure("portable_import_replaced_worktree_cleanup", error));
        }
      }
      return this.portableImportExecutionWithActivation(result);
    } catch (error) {
      if (createdBinding !== undefined && cleanupContext !== undefined && adapterForCleanup !== undefined) {
        await adapterForCleanup.deleteSession(createdBinding, cleanupContext).catch(() => undefined);
      }
      if (acquiredWorktree && this.#worktrees !== undefined) {
        await this.#worktrees.release(sessionId).catch(() => undefined);
      }
      return this.failClaimedEffect("import_portable_session", claim.operation.id, claim.operation.bodyHash, error);
    } finally {
      releaseBackendAdmission?.();
    }
  }

  private assertPortableReplacementIdle(sessionId: string): void {
    if (this.hasDurableSessionWork(sessionId)
      || this.#store.listInteractions({ sessionId, status: "open", limit: 1 }).length > 0
      || this.#store.hasActiveSessionBackgroundTasks(sessionId)
      || [...this.#pendingInteractions.values()].some((interaction) => interaction.sessionId === sessionId)
      || this.#userShells.has(sessionId)
      || this.#messageDeletionLocks.has(sessionId)
      || this.#sessionResetLocks.has(sessionId)
      || this.compactionBlocksDispatch(sessionId)) {
      throw new JokoError({
        code: "PORTABLE_SESSION_REPLACEMENT_BUSY",
        message: "The existing imported task is still active and cannot be replaced.",
        phase: "session",
        retryable: true,
        stateMayHaveChanged: false,
        recovery: "Wait for its run, interaction, background work, shell, and compaction to finish, then retry."
      });
    }
  }

  private async createSessionOnce(input: SessionCreationInput): Promise<OperationExecution<{ readonly sessionId: string }>> {
    const logicalBody = createSessionOperationBody(input);
    const authorized = "connection" in input;
    const operationKind = authorized
      ? "create_session"
      : "serviceKind" in input
        ? "create_session_handoff"
        : "create_scheduled_session";
    const claim = authorized
      ? this.#store.claimAuthorizedDeferredEffectOperation<{ readonly sessionId: string }>(
        input.connection.id,
        input.connection.authKeyDigest,
        { id: input.operationId, kind: operationKind, body: logicalBody },
        (store) => { store.getTarget(input.targetId); }
      )
      : this.#store.claimDeferredEffectOperation<{ readonly sessionId: string }>(
        { id: input.operationId, kind: operationKind, body: logicalBody },
        (store) => { store.getTarget(input.targetId); }
      );
    if (!claim.claimed) {
      return { replayed: true, value: claim.value, operation: claim.operation };
    }

    let createdBinding: NativeSessionBinding | undefined;
    let adapterForCleanup: BackendAdapter | undefined;
    let contextForCleanup: AdapterContext | undefined;
    let acquiredWorktreeSessionId: string | undefined;
    let scheduledWorktreeSessionId: string | undefined;
    let releaseBackendAdmission: (() => void) | undefined;
    try {
      const target = this.#store.getTarget(input.targetId);
      const adapter = this.requireAdapter(target.descriptor.backendId);
      const backendInstanceGeneration = this.requireAdapterGeneration(target.descriptor.backendId, adapter);
      const routedInput = this.resolveNewSessionRoute(target.descriptor.backendId, input);
      if (input.catalogImport === undefined) {
        this.assertBackendCreationReady(target.descriptor.backendId, routedInput);
      }
      releaseBackendAdmission = this.beginBackendAdmissionEffect(target.descriptor.backendId);
      adapterForCleanup = adapter;
      const sessionId = stableId("session", input.operationId);
      const worktreeOwner = "worktreeOwner" in input ? input.worktreeOwner : undefined;
      const automationOrigin = "automationOrigin" in input ? input.automationOrigin : undefined;
      if (worktreeOwner !== undefined && input.worktree === undefined) {
        throw new StoreError("Scheduled isolated workspace ownership requires isolated workspace creation.");
      }
      if (worktreeOwner !== undefined) {
        scheduledWorktreeSessionId = sessionId;
        this.#scheduledWorktreeCreations.add(sessionId);
      }
      const now = Date.now();
      let nativeStart = input.nativeStart ?? { kind: "new" as const };
      let catalogEntry: NativeSessionCatalogEntry | undefined;
      if (input.catalogImport !== undefined) {
        if (nativeStart.kind !== "attach" || input.worktree !== undefined) {
          throw new StoreError("Catalog import presentation requires a non-Worktree native attach.");
        }
        if (!Number.isSafeInteger(input.catalogImport.createdAt) || input.catalogImport.createdAt < 0
          || !Number.isSafeInteger(input.catalogImport.modifiedAt) || input.catalogImport.modifiedAt < 0
          || input.catalogImport.createdAt > input.catalogImport.modifiedAt) {
          throw new StoreError("Catalog import presentation has invalid native timestamps.");
        }
        const catalogReference = nativeStart.nativeReference;
        const snapshot = this.requireNativeSessionCatalogSnapshot(
          target.descriptor.backendId,
          input.catalogImport.snapshotToken
        );
        catalogEntry = snapshot.result.entries.find((entry) => entry.nativeReference === catalogReference);
        if (catalogEntry === undefined) {
          throw new StoreError("The native task is no longer present in the scanned catalog.");
        }
        if (this.nativeSessionCatalogEntryWasConsumed(
          snapshot.backendId,
          snapshot.scanEpoch,
          catalogReference
        )) {
          throw new StoreError("The native task catalog entry was already used. Scan again and retry.");
        }
        if (
          catalogEntry.createdAt !== input.catalogImport.createdAt
          || catalogEntry.modifiedAt !== input.catalogImport.modifiedAt
          || catalogEntry.archived !== input.catalogImport.archived
          || catalogEntry.placement !== input.initialPlacement
        ) {
          throw new StoreError("The native task changed after the catalog was scanned.");
        }
        if (catalogEntry.workingDirectory === undefined
          || !(await sameServicePath(catalogEntry.workingDirectory, target.descriptor.workspaceRoot))) {
          throw new StoreError("The native task does not belong to the selected runtime Target.");
        }
        if (input.catalogImport.projectId !== undefined) {
          const projectTarget = this.#store.getTarget(input.catalogImport.projectId);
          if (projectTarget.descriptor.backendId !== target.descriptor.backendId) {
            throw new StoreError("Catalog import project does not belong to the runtime Backend.");
          }
          const projectDirectory = catalogEntry.projectDirectory ?? catalogEntry.workingDirectory;
          if (projectDirectory === undefined
            || !(await sameServicePath(projectDirectory, projectTarget.descriptor.workspaceRoot))) {
            throw new StoreError("The native task does not belong to the selected project Target.");
          }
        } else if (catalogEntry.placement === "project") {
          throw new StoreError("A project catalog import requires its project Target.");
        }
        this.consumeNativeSessionCatalogEntry(snapshot, catalogReference);
      }
      const presentationCreatedAt = input.catalogImport?.createdAt ?? now;
      const presentationAt = input.catalogImport?.modifiedAt ?? now;
      const appendSystemPrompt = nativeStart.kind === "attach" ? undefined : input.appendSystemPrompt;
      if (input.worktree !== undefined
        && (nativeStart.kind !== "new" || nativeStart.parentNativeReference !== undefined)) {
        throw new JokoError({
          code: "WORKTREE_NATIVE_START_UNSUPPORTED",
          message: "An isolated workspace requires a fresh native task.",
          phase: "workspace",
          retryable: false,
          stateMayHaveChanged: false,
          recovery: "Start a fresh task or disable isolated workspace mode."
        });
      }
      if (input.worktree !== undefined && target.descriptor.remoteWorkspace !== undefined) {
        throw new JokoError({
          code: "REMOTE_WORKTREE_UNSUPPORTED",
          message: "Isolated workspaces are not available for this Remote workspace.",
          phase: "capability",
          retryable: false,
          stateMayHaveChanged: false,
          recovery: "Disable isolated workspace mode for this Remote target."
        });
      }
      if (input.worktree !== undefined && this.#worktrees === undefined) {
        throw new JokoError({
          code: "WORKTREE_UNAVAILABLE",
          message: "Isolated workspaces are unavailable on this service.",
          phase: "capability",
          retryable: false,
          stateMayHaveChanged: false,
          recovery: "Disable isolated workspace mode or use a service that advertises it."
        });
      }
      const sessionWorktree = input.worktree === undefined
        ? undefined
        : await this.#worktrees!.acquire({
            sessionId,
            target: target.descriptor,
            ...(input.worktree.sourceRef === undefined ? {} : { sourceRef: input.worktree.sourceRef }),
            refreshRemote: input.worktree.refreshRemote
          });
      if (sessionWorktree !== undefined) acquiredWorktreeSessionId = sessionId;
      if (sessionWorktree !== undefined && worktreeOwner !== undefined) {
        this.#store.setSetting("service", sessionId, SCHEDULED_WORKTREE_OWNER_SETTING_KEY, {
          format: 1,
          scheduleId: worktreeOwner.scheduleId,
          runId: worktreeOwner.runId,
          leaseId: sessionWorktree.leaseId,
          phase: "creating",
          createdAt: now
        } satisfies ScheduledWorktreeOwner, now);
      }
      const runtimeTarget = sessionWorktree === undefined
        ? target.descriptor
        : { ...target.descriptor, workspaceRoot: sessionWorktree.path };
      const context = this.provisionalContext(
        sessionId,
        runtimeTarget,
        1,
        undefined,
        appendSystemPrompt,
        backendInstanceGeneration
      );
      let catalogBinding: NativeSessionBinding | undefined;
      if (nativeStart.kind === "attach") {
        if (catalogEntry === undefined
          && this.#store.getBackend(target.descriptor.backendId).descriptor.capabilities.get("session.resume")?.supported !== true) {
          throw nativeStartUnsupported("attach");
        }
        const resolved = catalogEntry === undefined
          ? await (async () => {
              if (adapter.resolveNativeSessionReference === undefined) throw nativeStartUnsupported("attach");
              return adapter.resolveNativeSessionReference(
                nativeStart.nativeReference,
                target.descriptor,
                context.generation
              );
            })()
          : await (async () => {
              if (adapter.bindCatalogSession === undefined) throw nativeStartUnsupported("attach");
              return adapter.bindCatalogSession(catalogEntry, context.generation);
            })();
        catalogBinding = catalogEntry === undefined ? undefined : resolved;
        nativeStart = { kind: "attach", nativeReference: resolved.opaqueRef };
      } else if (nativeStart.parentNativeReference !== undefined) {
        if (adapter.resolveNativeSessionReference === undefined) throw nativeStartUnsupported("parent");
        const parent = await adapter.resolveNativeSessionReference(
          nativeStart.parentNativeReference,
          target.descriptor,
          context.generation
        );
        nativeStart = { kind: "new", parentNativeReference: parent.opaqueRef };
      }

      const execute = async (): Promise<OperationExecution<{ readonly sessionId: string }>> => {
        if (nativeStart.kind === "attach") {
          const duplicate = this.#store.findLiveSessionByNativeBinding(
            target.descriptor.backendId,
            nativeStart.nativeReference
          );
          if (duplicate !== undefined) throw nativeBindingConflict(duplicate.descriptor.id);
        }
        const attaching = nativeStart.kind === "attach";
        let binding: NativeSessionBinding;
        let attachedState: NativeSessionState | undefined;
        let nativeHistory: NativeHistoryProjection | undefined;
        if (catalogBinding !== undefined) {
          binding = catalogBinding;
        } else {
          binding = await adapter.createSession({
            target: runtimeTarget,
            name: input.title,
            ...(!attaching && routedInput.providerId !== undefined ? { providerId: routedInput.providerId } : {}),
            ...(!attaching && routedInput.modelId !== undefined ? { modelId: routedInput.modelId } : {}),
            ...(!attaching && routedInput.effort !== undefined ? { effort: routedInput.effort } : {}),
            fastMode: attaching ? false : routedInput.fastMode,
            permissionMode: attaching ? "ask" : input.permissionMode,
            ...(appendSystemPrompt === undefined ? {} : { appendSystemPrompt }),
            nativeStart
          }, context);
          createdBinding = binding;
          contextForCleanup = { ...context, binding };
          if (!attaching && input.planMode) await adapter.setPlanMode(true, contextForCleanup);
          if (nativeStart.kind === "attach") {
            attachedState = await adapter.inspectSession(binding, contextForCleanup);
            assertAttachedNativeState(binding, attachedState, context.generation);
            // The Adapter's observation is the authority for an existing native
            // task. Persisting the creation draft here would later replay stale
            // runtime axes over the resumed runtime.
            binding = attachedState.binding;
            createdBinding = binding;
            contextForCleanup = { ...context, binding };
          }
          if (attaching) {
            if (adapter.getNativeHistoryProjection === undefined) {
              throw new JokoError({
                code: "NATIVE_HISTORY_UNSUPPORTED",
                message: "The selected Backend cannot project the attached native task history.",
                phase: "session",
                retryable: false,
                stateMayHaveChanged: false,
                recovery: "Use a Backend that advertises native history projection for attach."
              });
            }
            // A fresh native task has no history to hydrate yet, and some native
            // runtimes do not publish queryable task metadata until the first
            // human turn. History hydration is therefore an attach-only gate.
            nativeHistory = await adapter.getNativeHistoryProjection(contextForCleanup);
          }
        }
        if (operationBodyHash(createSessionOperationBody(input)) !== claim.operation.bodyHash) {
          throw new Error("Create task input changed during execution.");
        }
        this.assertCurrentAdapterGeneration(
          target.descriptor.backendId,
          adapter,
          backendInstanceGeneration
        );
        const complete = (store: OperationalStore): { readonly sessionId: string } => {
            const currentTarget = store.getTarget(input.targetId);
            if (currentTarget.revision !== target.revision) {
              throw new RevisionConflictError("Target", input.targetId, target.revision, currentTarget.revision);
            }
            const duplicate = store.findLiveSessionByNativeBinding(target.descriptor.backendId, binding.opaqueRef);
            if (duplicate !== undefined) throw nativeBindingConflict(duplicate.descriptor.id);
            if (automationOrigin !== undefined) {
              const currentSchedule = store.getSchedule(automationOrigin.scheduleId);
              if (currentSchedule.revision !== automationOrigin.scheduleRevision) {
                throw new RevisionConflictError(
                  "Schedule",
                  automationOrigin.scheduleId,
                  automationOrigin.scheduleRevision,
                  currentSchedule.revision
                );
              }
            }
            const descriptor: SessionDescriptor = {
              id: sessionId,
              backendId: target.descriptor.backendId,
              targetId: target.descriptor.id,
              ...(input.catalogImport?.projectId === undefined
                ? {}
                : { projectId: input.catalogImport.projectId }),
              ...(automationOrigin === undefined ? {} : {
                automationOrigin: {
                  kind: "scheduler",
                  scheduleId: automationOrigin.scheduleId,
                  ...(automationOrigin.scheduleName === undefined ? {} : { scheduleName: automationOrigin.scheduleName }),
                  runId: automationOrigin.runId
                }
              }),
              title: catalogEntry === undefined
                ? input.title.trim() || "New task"
                : catalogEntry.title?.trim() || catalogEntry.nativeSessionId || "Untitled task",
              binding,
              pinned: false,
              archived: input.catalogImport?.archived ?? false,
              permissionMode: catalogBinding === undefined
                ? attachedState?.permissionMode ?? input.permissionMode
                : "ask",
              planMode: catalogBinding === undefined
                ? attachedState?.planMode ?? (attaching ? false : input.planMode)
                : false,
              ...(catalogBinding !== undefined
                ? { fastMode: false }
                : attachedState === undefined
                ? {
                    ...(routedInput.providerId === undefined ? {} : { providerId: routedInput.providerId }),
                    ...(routedInput.modelId === undefined ? {} : { modelId: routedInput.modelId }),
                    ...(routedInput.effort === undefined ? {} : { effort: routedInput.effort }),
                    fastMode: routedInput.fastMode
                  }
                : {
                    ...(attachedState.providerId === undefined ? {} : { providerId: attachedState.providerId }),
                    ...(attachedState.modelId === undefined ? {} : { modelId: attachedState.modelId }),
                    ...(attachedState.effort === undefined ? {} : { effort: attachedState.effort }),
                    fastMode: attachedState.fastMode
                  }),
              ...(sessionWorktree === undefined ? {} : { worktree: sessionWorktree }),
              ...(target.descriptor.remoteWorkspace === undefined
                ? {}
                : { remoteWorkspace: target.descriptor.remoteWorkspace }),
              ...(appendSystemPrompt === undefined ? {} : { appendSystemPrompt }),
              createdAt: presentationCreatedAt,
              updatedAt: presentationAt
            };
            store.createSession(descriptor, {
              nativeSessionBlank: nativeStart.kind === "new"
                && nativeStart.parentNativeReference === undefined
            });
            if (nativeHistory !== undefined) {
              this.appendNativeHistory(store, descriptor, nativeHistory, input.operationId);
            }
            if (authorized && input.initialPlacement === "dialogue") {
              const created = store.getSession(sessionId);
              store.moveSessionProject({
                sessionId,
                expectedRevision: created.revision,
                movedAt: presentationAt
              });
            }
            return { sessionId };
        };
        const result = authorized
          ? this.#store.completeAuthorizedDeferredEffectOperation(
            input.connection.id,
            input.connection.authKeyDigest,
            claim.operation.id,
            claim.operation.bodyHash,
            complete
          )
          : this.#store.completeDeferredEffectOperation(
            claim.operation.id,
            claim.operation.bodyHash,
            complete
          );
        if (catalogBinding === undefined) {
          this.#active.set(
            sessionId,
            this.activeSession(adapter, sessionId, backendInstanceGeneration)
          );
          const active = this.#active.get(sessionId)!;
          await this.refreshRuntimeCommands(sessionId, active)
            .catch((error: unknown) => this.recordFailure("runtime_commands_create_sync", error));
          await this.refreshNativeStateBestEffort(sessionId, active, "native_state_create_sync");
          if (attaching) this.invalidateNativeSessionCatalog(target.descriptor.backendId);
        }
        createdBinding = undefined;
        acquiredWorktreeSessionId = undefined;
        return result;
      };

      const executeWithParentFence = async (): Promise<OperationExecution<{ readonly sessionId: string }>> => {
        let parentSessionId: string | undefined;
        if (nativeStart.kind === "new" && nativeStart.parentNativeReference !== undefined) {
          const parent = this.#store.findLiveSessionByNativeBinding(
            target.descriptor.backendId,
            nativeStart.parentNativeReference
          );
          if (parent !== undefined && this.#active.has(parent.descriptor.id)) {
            const parentActive = this.#active.get(parent.descriptor.id)!;
            const parentContext = this.contextFor(parent);
            if (parentActive.adapter.detachSession !== undefined) {
              await parentActive.adapter.detachSession(parent.descriptor.binding, parentContext);
            } else {
              await parentActive.adapter.closeSession(parent.descriptor.binding, parentContext);
            }
            this.#active.delete(parent.descriptor.id);
            parentSessionId = parent.descriptor.id;
          }
        }
        try {
          return await execute();
        } finally {
          if (parentSessionId !== undefined) {
            void this.activate(parentSessionId)
              .catch((error: unknown) => this.recordFailure("restore_parent_after_native_new", error));
          }
        }
      };
      const lockedReference = nativeStart.kind === "attach"
        ? nativeStart.nativeReference
        : nativeStart.parentNativeReference;
      return lockedReference === undefined
        ? await executeWithParentFence()
        : await this.withNativeBindingLock(target.descriptor.backendId, lockedReference, executeWithParentFence);
    } catch (error) {
      if (createdBinding !== undefined && adapterForCleanup !== undefined && contextForCleanup !== undefined) {
        await adapterForCleanup.closeSession(createdBinding, contextForCleanup).catch(() => undefined);
      }
      if (acquiredWorktreeSessionId !== undefined && this.#worktrees !== undefined) {
        await this.#worktrees.release(acquiredWorktreeSessionId).catch(() => undefined);
        this.#store.deleteSetting("service", acquiredWorktreeSessionId, SCHEDULED_WORKTREE_OWNER_SETTING_KEY);
      }
      return this.failClaimedEffect(operationKind, claim.operation.id, claim.operation.bodyHash, error);
    } finally {
      releaseBackendAdmission?.();
      if (scheduledWorktreeSessionId !== undefined) {
        this.#scheduledWorktreeCreations.delete(scheduledWorktreeSessionId);
      }
    }
  }

  private resolveNewSessionRoute(backendId: string, input: SessionCreationInput): SessionCreationInput {
    if (
      input.catalogImport !== undefined
      || input.nativeStart?.kind === "attach"
      || input.providerId !== undefined
      || input.modelId !== undefined
    ) return input;
    const accessRestricted = this.#modelAccessRestricted(backendId);
    if (input.nativeStart?.kind === "new" && input.nativeStart.parentNativeReference !== undefined) {
      const parent = this.#store.findLiveSessionByNativeBinding(
        backendId,
        input.nativeStart.parentNativeReference
      )?.descriptor;
      if (parent !== undefined) {
        this.assertInheritedSessionCreationReady(
          backendId,
          {
            ...(parent.providerId === undefined ? {} : { providerId: parent.providerId }),
            ...(parent.modelId === undefined ? {} : { modelId: parent.modelId }),
            fastMode: parent.fastMode
          },
          "The native parent task's model is unavailable for a new route."
        );
        return input;
      }
      if (accessRestricted) {
        throw modelAccessUnavailable("The native parent task's inherited model cannot be proven enabled.");
      }
      return input;
    }
    const backend = this.#store.getBackend(backendId).descriptor;
    const authenticatedProviders = (backend.providers ?? []).filter((provider) =>
      provider.authenticationState === "authenticated" || provider.authenticationState === "not_required");
    if (backend.capabilities.get("model.switch")?.supported !== true) {
      if (
        authenticatedProviders.length > 0
        && authenticatedProviders.every((provider) => !this.#providerRoutingEnabled(backendId, provider.providerId))
      ) throw modelAccessUnavailable("Every authenticated Provider for this Backend is disabled for new tasks.");
      if (accessRestricted) {
        throw modelAccessUnavailable("This Backend cannot prove that its native default model is enabled for new tasks.");
      }
      return input;
    }
    const candidates = backend.models.filter((model) => {
      const provider = backend.providers?.find((item) => item.providerId === model.providerId);
      const authenticated = provider === undefined
        ? backend.authenticationState === "authenticated" || backend.authenticationState === "not_required"
        : provider.authenticationState === "authenticated" || provider.authenticationState === "not_required";
      return authenticated && this.#modelRoutingEnabled(backendId, model.providerId, model.modelId);
    });
    if (backend.models.length === 0) {
      if (accessRestricted) {
        throw modelAccessUnavailable("No enabled model is available for a new task on this Backend.");
      }
      return input;
    }
    if (candidates.length === 0) {
      throw modelAccessUnavailable("Every available model for this Backend is disabled for new tasks.");
    }
    const configured = this.#sessionRuntimeFallbackContext(backendId).explicitDefault;
    const nativeDefault = configured ?? backend.models[0]!;
    const nativeDefaultCandidate = candidates.find((model) =>
      model.providerId === nativeDefault.providerId && model.modelId === nativeDefault.modelId);
    if (!accessRestricted && nativeDefaultCandidate !== undefined) return input;
    const selected = nativeDefaultCandidate ?? candidates[0]!;
    return { ...input, providerId: selected.providerId, modelId: selected.modelId };
  }

  private assertInheritedSessionCreationReady(
    backendId: string,
    input: {
      readonly providerId?: string;
      readonly modelId?: string;
      readonly fastMode: boolean;
    },
    unavailableMessage: string
  ): void {
    if (
      input.providerId === undefined
      && input.modelId === undefined
      && this.#modelAccessRestricted(backendId)
    ) throw modelAccessUnavailable(unavailableMessage);
    this.assertBackendCreationReady(backendId, { ...input, nativeStart: { kind: "new" } });
  }

  private assertBackendCreationReady<T extends {
    readonly providerId?: string;
    readonly modelId?: string;
    readonly fastMode: boolean;
    readonly nativeStart?: NativeSessionStart;
  }>(
    backendId: string,
    input: T
  ): void {
    const backend = this.#store.getBackend(backendId).descriptor;
    if (!this.#backendEnabled(backendId)) {
      throw new JokoError({
        code: "BACKEND_DISABLED",
        message: "This Backend is disabled for new tasks.",
        phase: "capability",
        retryable: false,
        stateMayHaveChanged: false,
        recovery: "Enable the Backend in Settings before creating or importing a task."
      });
    }
    if (backend.health === "unavailable"
      || (backend.installationState !== "installed" && backend.installationState !== "update_available")) {
      throw new JokoError({
        code: "BACKEND_UNAVAILABLE",
        message: "This Backend is not ready to create or import tasks.",
        phase: "capability",
        retryable: true,
        stateMayHaveChanged: false,
        recovery: backend.error?.recovery ?? "Repair the native runtime in Settings and retry its readiness probe."
      });
    }
    if (backend.authenticationState !== "authenticated" && backend.authenticationState !== "not_required") {
      throw new JokoError({
        code: "BACKEND_AUTHENTICATION_REQUIRED",
        message: "This Backend is not authenticated for new tasks.",
        phase: "capability",
        retryable: true,
        stateMayHaveChanged: false,
        recovery: backend.error?.recovery ?? "Complete the Backend authorization in Settings and retry."
      });
    }
    if (backend.capabilities.get("input.text")?.supported !== true) {
      throw new JokoError({
        code: "BACKEND_TEXT_INPUT_UNAVAILABLE",
        message: "This Backend does not currently support task input.",
        phase: "capability",
        retryable: false,
        stateMayHaveChanged: false,
        recovery: "Choose a Backend that advertises text input support."
      });
    }
    if (input.nativeStart?.kind === "attach") return;
    const hasProvider = input.providerId !== undefined;
    const hasModel = input.modelId !== undefined;
    if (hasProvider !== hasModel) {
      throw new JokoError({
        code: "MODEL_SELECTION_INCOMPLETE",
        message: "A model selection must include both Provider and model identity.",
        phase: "capability",
        retryable: false,
        stateMayHaveChanged: false,
        recovery: "Refresh this Backend's model catalog and choose one advertised model."
      });
    }
    const selectedModel = hasProvider && hasModel
      ? backend.models.find((model) => model.providerId === input.providerId && model.modelId === input.modelId)
      : undefined;
    if (hasProvider && selectedModel === undefined) {
      throw new JokoError({
        code: "MODEL_ROUTE_UNAVAILABLE",
        message: "The selected model does not belong to this Backend instance.",
        phase: "capability",
        retryable: true,
        stateMayHaveChanged: false,
        recovery: "Refresh this Backend's model catalog and select one of its current models."
      });
    }
    if (
      hasProvider && hasModel
      && !this.#modelRoutingEnabled(backendId, input.providerId!, input.modelId!)
    ) throw modelAccessUnavailable("The selected model is disabled for new tasks.");
    if (input.fastMode && (
      selectedModel === undefined
      || backend.capabilities.get("model.fast_mode")?.supported !== true
      || selectedModel.supportsFastMode !== true
    )) {
      throw new JokoError({
        code: "MODEL_FAST_MODE_UNAVAILABLE",
        message: "Fast Mode is not supported by the selected Backend model.",
        phase: "capability",
        retryable: false,
        stateMayHaveChanged: false,
        recovery: "Disable Fast Mode or choose a model that advertises it."
      });
    }
  }

  private async withNativeBindingLock<T>(backendId: string, opaqueRef: string, action: () => Promise<T>): Promise<T> {
    const normalizedRef = process.platform === "win32" ? opaqueRef.toLowerCase() : opaqueRef;
    const key = `${backendId}\0${normalizedRef}`;
    const previous = this.#nativeBindingLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    const tail = previous.then(() => gate);
    this.#nativeBindingLocks.set(key, tail);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.#nativeBindingLocks.get(key) === tail) this.#nativeBindingLocks.delete(key);
    }
  }

  private async activate(sessionId: string): Promise<ActiveSession> {
    return this.activateWithPolicy(sessionId, false);
  }

  private async activateForSessionReset(sessionId: string): Promise<ActiveSession> {
    return this.activateWithPolicy(sessionId, true, true);
  }

  private async activateWithPolicy(
    sessionId: string,
    allowPendingRebuild: boolean,
    allowSessionReset = false,
    lifecycleOperationId?: string,
    allowRuntimeRestart = false,
    allowBackendReplacement = false
  ): Promise<ActiveSession> {
    this.#assertOpen();
    const session = this.#store.getSession(sessionId);
    if (session.descriptor.deletedAt !== undefined || session.descriptor.archived) {
      throw new StoreError("Archived or deleted tasks cannot activate a native runtime.");
    }
    if (this.#store.findPendingScheduleDeletionCleanupForSession(sessionId) !== undefined) {
      throw new StoreError("The task is fenced while its Schedule deletion is in progress.");
    }
    const durableLifecycle = this.#store.findPendingSessionLifecycleCleanup(sessionId);
    if (durableLifecycle !== undefined && durableLifecycle.operationId !== lifecycleOperationId) {
      throw new StoreError("The task is fenced while its lifecycle transition is in progress.");
    }
    const lifecycleOwner = this.#sessionLifecycleFences.get(sessionId);
    if (lifecycleOwner !== undefined && lifecycleOwner !== lifecycleOperationId) {
      throw new StoreError("The task is fenced while its lifecycle transition is in progress.");
    }
    if (this.#closeIfActiveFlights.has(sessionId)) {
      throw new StoreError("The native runtime is fenced while this task is being removed.");
    }
    if (this.#runtimeRestartFences.has(sessionId) && !allowRuntimeRestart) {
      throw new StoreError("The native runtime is fenced while this Backend restarts.");
    }
    if (this.#backendReplacementFences.has(session.descriptor.backendId) && !allowBackendReplacement) {
      throw new StoreError("The native runtime is fenced while its Backend process instance is being replaced.");
    }
    if (this.#sessionResetLocks.has(sessionId) && !allowSessionReset) {
      throw sessionResetError(
        "SESSION_RESET_IN_PROGRESS",
        "The native runtime is fenced while this task clears its context.",
        "Wait for clear to finish before using this task."
      );
    }
    if (this.#messageDeletionLocks.has(sessionId)) {
      throw messageDeletionError(
        "SESSION_MESSAGE_DELETE_IN_PROGRESS",
        "The native runtime is fenced while a message is being deleted.",
        "Wait for deletion to finish before using this task."
      );
    }
    if (!allowPendingRebuild && this.#store.findPendingContextRebuild(sessionId) !== undefined) {
      throw messageDeletionError(
        "SESSION_CONTEXT_REBUILD_PENDING",
        "This task must rebuild native context before it can continue.",
        "Send the next prompt to trigger the safe context rebuild."
      );
    }
    const reaping = this.#reaping.get(sessionId);
    if (reaping !== undefined) {
      await reaping.catch(() => undefined);
      this.#assertOpen();
    }
    const active = this.#active.get(sessionId);
    if (active !== undefined) {
      active.lastActivityAt = this.#monotonicNow();
      return active;
    }
    const inflight = this.#activating.get(sessionId);
    if (inflight !== undefined) return inflight;
    const task = this.activateOnce(sessionId, {
      backendReplacement: allowBackendReplacement,
      runtimeRestart: allowRuntimeRestart,
      sessionReset: allowSessionReset,
      ...(lifecycleOperationId === undefined ? {} : { lifecycleOperationId })
    }).finally(() => this.#activating.delete(sessionId));
    this.#activating.set(sessionId, task);
    return task;
  }

  private async closeIfActiveOnce(sessionId: string): Promise<void> {
    if (this.isReviewReadOnlySession(sessionId)) return;
    const initial = this.#store.getSession(sessionId);
    const lifecycleAdmission = this.#sessionLifecycleBackendAdmissions.get(sessionId);
    const releaseBackendAdmission = lifecycleAdmission === undefined
      ? this.beginBackendAdmissionEffect(initial.descriptor.backendId)
      : undefined;
    try {
    this.clearRunSilenceWatchdog(sessionId);
    const reaping = this.#reaping.get(sessionId);
    if (reaping !== undefined) await reaping.catch(() => undefined);
    const preparationBeforeClose = this.#dispatchPreparations.get(sessionId);
    if (preparationBeforeClose?.phase === "pre-send") {
      // Pre-send adapter configuration is not safely interruptible. The
      // durable deletion guard makes every awaited step exit promptly; wait
      // for that phase before closing so no setter races closeSession.
      await preparationBeforeClose.settled;
    }
    const activating = this.#activating.get(sessionId);
    if (activating !== undefined) await activating.catch(() => undefined);
    const active = this.#active.get(sessionId);
    if (active !== undefined) {
      const stored = this.#store.getSession(sessionId);
      const generation = stored.descriptor.binding.generation;
      await active.adapter.closeSession(stored.descriptor.binding, this.contextFor(stored));
      if (this.#active.get(sessionId) === active) this.#active.delete(sessionId);
      this.failBackgroundTasksForRuntimeLoss(stored, generation);
    }
    const drainSettlement = this.#drainSettlements.get(sessionId);
    if (drainSettlement !== undefined) await drainSettlement;
    await Promise.all([
      this.#nativeHistoryTails.get(sessionId) ?? Promise.resolve(),
      this.#runtimeCommandTails.get(sessionId) ?? Promise.resolve(),
      this.#nativeStateTails.get(sessionId) ?? Promise.resolve(),
      ...(this.#inflightEmissions.get(sessionId) ?? [])
    ]);
    this.#nativeCompactions.delete(sessionId);
    this.clearTurnOverrideLeases(sessionId);
    this.#releaseSessionTools(sessionId);
    } finally {
      releaseBackendAdmission?.();
    }
  }

  private async activateOnce(
    sessionId: string,
    allowance: BackendSideEffectAdmissionAllowance
  ): Promise<ActiveSession> {
    let stored = this.#store.getSession(sessionId);
    if (this.isReviewReadOnlySession(sessionId)) {
      throw new StoreError("Reviewer runtimes are fresh-only and cannot resume native state.");
    }
    const adapter = this.requireAdapter(stored.descriptor.backendId);
    const backendInstanceGeneration = this.requireAdapterGeneration(stored.descriptor.backendId, adapter);
    const previousBinding = stored.descriptor.binding;
    const nextBinding = { ...previousBinding, generation: previousBinding.generation + 1 };
    stored = this.#store.updateSession(sessionId, { binding: nextBinding }, stored.revision);
    const context = this.contextFor(
      stored,
      undefined,
      undefined,
      undefined,
      undefined,
      backendInstanceGeneration
    );
    try {
      let state: NativeSessionState;
      let reprovisionedBlank = false;
      try {
        state = await adapter.resumeSession(previousBinding, context);
      } catch (error) {
        if (!blankContinuityGapWithoutSideEffects(error)
          || !this.#store.nativeBlankRecoveryEligible(sessionId)) throw error;
        const recovered = await this.reprovisionBlankNativeSession(
          stored,
          adapter,
          backendInstanceGeneration
        );
        stored = recovered.stored;
        state = recovered.state;
        reprovisionedBlank = true;
      }
      if (
        state.binding.opaqueRef !== stored.descriptor.binding.opaqueRef ||
        state.binding.nativeSessionId !== stored.descriptor.binding.nativeSessionId ||
        state.binding.generation !== stored.descriptor.binding.generation
      ) {
        const normalized = { ...state.binding, generation: stored.descriptor.binding.generation + 1 };
        stored = this.#store.updateSession(sessionId, { binding: normalized }, stored.revision);
      }
      const restoredContext = this.contextFor(
        stored,
        undefined,
        undefined,
        undefined,
        undefined,
        backendInstanceGeneration
      );
      const runtimeProfile = this.#sessionRuntimeControl.snapshot(
        sessionId,
        sessionRuntimeBaseline(stored.descriptor)
      ).effective;
      const capabilities = this.#store.getBackend(stored.descriptor.backendId).descriptor.capabilities;
      if (runtimeProfile !== undefined && capabilities.get("model.switch")?.supported === true) {
        await adapter.setModel(runtimeProfile.providerId, runtimeProfile.modelId, restoredContext);
      }
      if (
        runtimeProfile?.effort !== undefined &&
        capabilities.get("model.effort")?.supported === true
      ) await adapter.setEffort(runtimeProfile.effort, restoredContext);
      if (capabilities.get("model.fast_mode")?.supported === true) {
        await adapter.setFastMode(runtimeProfile?.fastMode ?? stored.descriptor.fastMode, restoredContext);
      }
      if (capabilities.get("permission.change")?.supported === true) {
        await adapter.setPermissionMode(stored.descriptor.permissionMode, restoredContext);
      }
      if (capabilities.get("plan_mode")?.supported === true) {
        await adapter.setPlanMode(stored.descriptor.planMode, restoredContext);
      }
      this.assertCurrentAdapterGeneration(
        stored.descriptor.backendId,
        adapter,
        backendInstanceGeneration
      );
      const result = this.activeSession(adapter, sessionId, backendInstanceGeneration);
      this.#active.set(sessionId, result);
      this.persistRuntimeUsage(sessionId, stored.descriptor.binding.generation, state.usage, false, state.providerId, state.modelId);
      await this.refreshNativeStateBestEffort(sessionId, result, "native_state_activation_sync", allowance);
      if (!reprovisionedBlank) await this.synchronizeNativeHistory(sessionId, allowance);
      await this.refreshRuntimeCommands(sessionId, result, allowance)
        .catch((error: unknown) => this.recordFailure("runtime_commands_activation_sync", error));
      return result;
    } catch (error) {
      this.#active.delete(sessionId);
      await adapter.closeSession(
        stored.descriptor.binding,
        this.contextFor(
          stored,
          undefined,
          undefined,
          undefined,
          undefined,
          backendInstanceGeneration
        )
      ).catch(() => undefined);
      throw error;
    }
  }

  private async reprovisionBlankNativeSession(
    expected: StoredSession,
    adapter: BackendAdapter,
    backendInstanceGeneration: number
  ): Promise<{ readonly stored: StoredSession; readonly state: NativeSessionState }> {
    if (!this.#store.nativeBlankRecoveryEligible(expected.descriptor.id)) {
      throw new StoreError("The native Session is no longer eligible for blank-runtime recovery.");
    }
    const generation = expected.descriptor.binding.generation + 1;
    const target = this.targetForSession(expected);
    const context = this.provisionalContext(
      expected.descriptor.id,
      target,
      generation,
      undefined,
      expected.descriptor.appendSystemPrompt,
      backendInstanceGeneration
    );
    let createdBinding: NativeSessionBinding | undefined;
    try {
      createdBinding = await adapter.createSession({
        target,
        name: expected.descriptor.title,
        ...(expected.descriptor.providerId === undefined ? {} : { providerId: expected.descriptor.providerId }),
        ...(expected.descriptor.modelId === undefined ? {} : { modelId: expected.descriptor.modelId }),
        ...(expected.descriptor.effort === undefined ? {} : { effort: expected.descriptor.effort }),
        fastMode: expected.descriptor.fastMode,
        permissionMode: expected.descriptor.permissionMode,
        ...(expected.descriptor.appendSystemPrompt === undefined
          ? {}
          : { appendSystemPrompt: expected.descriptor.appendSystemPrompt }),
        nativeStart: { kind: "new" }
      }, context);
      if (
        createdBinding.generation !== generation
        || createdBinding.opaqueRef === expected.descriptor.binding.opaqueRef
      ) {
        throw new StoreError("Blank-runtime recovery did not create a fresh next-generation native binding.");
      }
      const boundContext = { ...context, binding: createdBinding };
      const state = await adapter.inspectSession(createdBinding, boundContext);
      assertAttachedNativeState(createdBinding, state, generation);
      this.assertCurrentAdapterGeneration(
        expected.descriptor.backendId,
        adapter,
        backendInstanceGeneration
      );
      const stored = this.#store.rebindNativeBlankSession({
        sessionId: expected.descriptor.id,
        expectedRevision: expected.revision,
        expectedBinding: expected.descriptor.binding,
        binding: createdBinding
      });
      createdBinding = undefined;
      return { stored, state };
    } catch (error) {
      if (createdBinding !== undefined) {
        await adapter.closeSession(createdBinding, { ...context, binding: createdBinding }).catch(() => undefined);
      }
      throw error;
    }
  }

  private beginCompactionEffect(sessionId: string): symbol {
    const session = this.#store.getSession(sessionId);
    this.ensureCompactionQueueWindow(sessionId, session.descriptor.binding.generation);
    const token = Symbol(`compaction:${sessionId}`);
    const effects = this.#compactionEffects.get(sessionId) ?? new Set<symbol>();
    effects.add(token);
    this.#compactionEffects.set(sessionId, effects);
    return token;
  }

  private finishCompactionEffect(sessionId: string, token: symbol): void {
    const wasBlocked = this.compactionBlocksDispatch(sessionId);
    const effects = this.#compactionEffects.get(sessionId);
    if (effects?.delete(token) !== true) return;
    if (effects.size === 0) this.#compactionEffects.delete(sessionId);
    if (wasBlocked && !this.compactionBlocksDispatch(sessionId)) {
      this.releaseCompactionQueueWindow(sessionId);
      void this.drain(sessionId);
    }
  }

  private observeNativeCompaction(
    sessionId: string,
    generation: number,
    compacting: boolean,
    wakeOnRelease: boolean,
    willRetry = false,
    source: "event" | "observation" = "observation"
  ): void {
    if (this.#disposed) return;
    let currentGeneration: number;
    try {
      currentGeneration = this.#store.getSession(sessionId).descriptor.binding.generation;
    } catch {
      return;
    }
    if (currentGeneration !== generation) return;
    if (source === "event") {
      this.#compactionEventEpochs.set(
        sessionId,
        (this.#compactionEventEpochs.get(sessionId) ?? 0) + 1
      );
    }
    const wasBlocked = this.compactionBlocksDispatch(sessionId);
    if (compacting) {
      const window = this.ensureCompactionQueueWindow(sessionId, generation);
      if (source === "event" && !window.eventStarted) {
        window.eventStarted = true;
        this.persistCompactionQueueWindow(sessionId, window);
      }
      this.#nativeCompactions.set(sessionId, generation);
    } else {
      const window = this.#compactionQueueWindows.get(sessionId);
      // A state response can observe idle after the Backend has emitted compaction_end
      // but before its event metadata reaches Orchestrator. Once event_start was
      // seen, only the matching terminal event may decide willRetry/promotion.
      if (source === "observation" && window?.generation === generation && window.eventStarted) return;
      if (window?.generation === generation) {
        window.willRetry ||= willRetry;
        this.persistCompactionQueueWindow(sessionId, window);
      }
      this.#nativeCompactions.delete(sessionId);
    }
    if (wakeOnRelease && wasBlocked && !this.compactionBlocksDispatch(sessionId)) {
      this.releaseCompactionQueueWindow(sessionId);
      void this.drain(sessionId);
    }
  }

  private ensureCompactionQueueWindow(sessionId: string, generation: number): CompactionQueueWindow {
    const existing = this.#compactionQueueWindows.get(sessionId);
    if (existing?.generation === generation) return existing;
    if (existing !== undefined && (this.#compactionEffects.get(sessionId)?.size ?? 0) > 0) {
      // Explicit compact() installs its queue window before activation. Resume
      // advances the product generation, but that must not turn inputs accepted
      // during activation into the new window's baseline. Transfer the original
      // effect window and all held IDs across the generation fence instead.
      const transferred: CompactionQueueWindow = { ...existing, generation };
      this.#compactionQueueWindows.set(sessionId, transferred);
      this.persistCompactionQueueWindow(sessionId, transferred);
      return transferred;
    }
    const startedAt = Date.now();
    const window: CompactionQueueWindow = {
      generation,
      startedAt,
      baselineQueueItemIds: new Set(listAllQueueItems(this.#store, {
        sessionId,
        states: ["accepted"]
      }).map((item) => item.id)),
      heldQueueItemIds: new Set<string>(),
      eventStarted: false,
      willRetry: false
    };
    this.#compactionQueueWindows.set(sessionId, window);
    this.persistCompactionQueueWindow(sessionId, window);
    return window;
  }

  private persistCompactionQueueWindow(sessionId: string, window: CompactionQueueWindow): void {
    this.#store.setSetting("session", sessionId, SESSION_COMPACTION_QUEUE_SETTING_KEY, {
      format: 1,
      generation: window.generation,
      startedAt: window.startedAt,
      baselineQueueItemIds: [...window.baselineQueueItemIds],
      heldQueueItemIds: [...window.heldQueueItemIds],
      eventStarted: window.eventStarted,
      willRetry: window.willRetry
    });
  }

  private markCompactionQueueHeld(
    sessionId: string,
    window: CompactionQueueWindow,
    queueItemIds: readonly string[]
  ): void {
    let changed = false;
    for (const queueItemId of queueItemIds) {
      if (window.heldQueueItemIds.has(queueItemId)) continue;
      window.heldQueueItemIds.add(queueItemId);
      changed = true;
    }
    if (changed) this.persistCompactionQueueWindow(sessionId, window);
  }

  private releaseCompactionQueueWindow(sessionId: string): void {
    const window = this.#compactionQueueWindows.get(sessionId);
    if (window === undefined) return;
    this.#compactionQueueWindows.delete(sessionId);
    this.#store.transaction((store) => {
      if (!window.willRetry) {
        const firstHeld = listAllQueueItems(store, { sessionId, states: ["accepted"] })
          .find((item) =>
            window.heldQueueItemIds.has(item.id) || (
              !window.baselineQueueItemIds.has(item.id) && item.createdAt >= window.startedAt
            )
          );
        if (firstHeld !== undefined && firstHeld.disposition !== "prompt") {
          const generation = store.getSession(sessionId).descriptor.binding.generation;
          const promotable = firstHeld.attemptId === undefined ||
            store.getAttempt(firstHeld.attemptId).descriptor.generation !== generation
            ? store.renewQueueAttemptGeneration({
                queueItemId: firstHeld.id,
                attemptId: stableId("attempt", `${firstHeld.operationId}:generation:${generation}`),
                generation
              })
            : firstHeld;
          store.editQueueItem({
            queueItemId: promotable.id,
            body: { ...promotable.body, disposition: "prompt" },
            expectedRevision: promotable.revision,
            traceId: `compaction:${promotable.id}:promote-prompt`
          });
        }
      }
      store.deleteSetting("session", sessionId, SESSION_COMPACTION_QUEUE_SETTING_KEY);
    });
  }

  private recoverInterruptedCompactionQueue(sessionId: string): void {
    const durable = materializedCompactionQueueWindow(this.#store.findSetting(
      "session",
      sessionId,
      SESSION_COMPACTION_QUEUE_SETTING_KEY
    )?.value);
    if (durable === undefined) {
      if (this.#store.findSetting("session", sessionId, SESSION_COMPACTION_QUEUE_SETTING_KEY) !== undefined) {
        this.#store.deleteSetting("session", sessionId, SESSION_COMPACTION_QUEUE_SETTING_KEY);
      }
      return;
    }
    this.#store.transaction((store) => {
      const accepted = listAllQueueItems(store, { sessionId, states: ["accepted"] });
      const baseline = new Set(durable.baselineQueueItemIds);
      const held = new Set(durable.heldQueueItemIds);
      // The prior native process cannot continue its compaction/retry
      // lifecycle after SessionHost recovery. Include every post-window queue
      // acceptance so the first continuation becomes a fresh prompt.
      const firstHeld = accepted.find((item) =>
        held.has(item.id) || (!baseline.has(item.id) && item.createdAt >= durable.startedAt)
      );
      if (firstHeld !== undefined && firstHeld.disposition !== "prompt") {
        const generation = store.getSession(sessionId).descriptor.binding.generation;
        const promotable = firstHeld.attemptId === undefined ||
          store.getAttempt(firstHeld.attemptId).descriptor.generation !== generation
          ? store.renewQueueAttemptGeneration({
              queueItemId: firstHeld.id,
              attemptId: stableId("attempt", `${firstHeld.operationId}:generation:${generation}`),
              generation
            })
          : firstHeld;
        store.editQueueItem({
          queueItemId: promotable.id,
          body: { ...promotable.body, disposition: "prompt" },
          expectedRevision: promotable.revision,
          traceId: `compaction-recovery:${promotable.id}:promote-prompt`
        });
      }
      store.deleteSetting("session", sessionId, SESSION_COMPACTION_QUEUE_SETTING_KEY);
    });
  }

  private compactionBlocksDispatch(sessionId: string): boolean {
    if ((this.#compactionEffects.get(sessionId)?.size ?? 0) > 0) return true;
    const nativeGeneration = this.#nativeCompactions.get(sessionId);
    if (nativeGeneration === undefined) return false;
    try {
      return this.#store.getSession(sessionId).descriptor.binding.generation === nativeGeneration;
    } catch {
      return false;
    }
  }

  private async compactionDispatchDecision(
    sessionId: string
  ): Promise<CompactionDispatchDecision> {
    const active = this.#active.get(sessionId);
    if (active !== undefined) {
      try {
        await this.refreshNativeStateObservation(sessionId, active);
      } catch (error) {
        // Event-driven state remains authoritative if a best-effort inspection
        // fails. Preserve pre-existing dispatch behavior when neither source
        // has observed compaction.
        this.recordFailure("native_state_pre_dispatch_sync", error);
      }
    }
    if (!this.compactionBlocksDispatch(sessionId)) return { kind: "normal" };

    const session = this.#store.getSession(sessionId);
    const window = this.ensureCompactionQueueWindow(sessionId, session.descriptor.binding.generation);
    const accepted = listAllQueueItems(this.#store, { sessionId, states: ["accepted"] });
    if (active?.adapter.dispatchDuringCompaction === undefined) {
      this.markCompactionQueueHeld(sessionId, window, accepted.map((item) => item.id));
      return { kind: "blocked" };
    }

    const context = this.contextFor(session);
    for (const candidate of accepted) {
      if (hasTurnOverrides(candidate.executionOverrides)) {
        this.markCompactionQueueHeld(sessionId, window, [candidate.id]);
        continue;
      }
      let disposition: PromptInput["disposition"] | undefined;
      try {
        disposition = await active.adapter.dispatchDuringCompaction(candidate.body, context);
      } catch (error) {
        this.recordFailure("compaction_dispatch_classification", error);
        this.markCompactionQueueHeld(sessionId, window, accepted.map((item) => item.id));
        return { kind: "blocked" };
      }
      if (!this.compactionBlocksDispatch(sessionId)) return { kind: "normal" };
      if (disposition === undefined) {
        this.markCompactionQueueHeld(sessionId, window, [candidate.id]);
        continue;
      }
      const current = this.#store.getQueueItem(candidate.id);
      if (current.state !== "accepted") continue;
      let immediate = current;
      if (current.disposition !== disposition) {
        immediate = this.#store.editQueueItem({
          queueItemId: current.id,
          body: { ...current.body, disposition },
          expectedRevision: current.revision,
          traceId: `compaction:${current.id}:immediate-disposition`
        });
      }
      if (accepted[0]?.id !== immediate.id) {
        this.#store.reorderQueueItem({
          queueItemId: immediate.id,
          placement: { edge: "first" },
          expectedRevision: immediate.revision,
          traceId: `compaction:${immediate.id}:immediate-first`
        });
      }
      window.heldQueueItemIds.delete(immediate.id);
      this.persistCompactionQueueWindow(sessionId, window);
      return { kind: "bypass", queueItemId: immediate.id };
    }
    return { kind: "blocked" };
  }

  private beginDispatchPreparation(sessionId: string): DispatchPreparation {
    if (this.#dispatchPreparations.has(sessionId)) {
      throw new Error("A task already has a queue item preparing for Backend dispatch.");
    }
    let resolve!: () => void;
    const settled = new Promise<void>((resolvePromise) => {
      resolve = resolvePromise;
    });
    const preparation: DispatchPreparation = { settled, resolve, phase: "pre-send" };
    this.#dispatchPreparations.set(sessionId, preparation);
    return preparation;
  }

  private finishDispatchPreparation(sessionId: string, preparation: DispatchPreparation): void {
    if (this.#dispatchPreparations.get(sessionId) !== preparation) return;
    this.#dispatchPreparations.delete(sessionId);
    preparation.resolve();
    void this.#applyPendingSessionRuntimeControl(sessionId).then((applied) => {
      if (applied) void this.drain(sessionId);
    }).catch((error: unknown) => this.recordFailure("session_runtime_control_boundary", error));
  }

  private contextRecoveryTrigger(
    store: OperationalStore,
    sessionId: string,
    runId: string,
    error: PublicError
  ): ContextRecoveryTrigger | undefined {
    const reason = terminalContextRecoveryReason(error);
    if (reason === undefined) return undefined;
    const queueItem = store.findQueueItemByRunId(sessionId, runId, { includeCleared: true });
    if (queueItem === undefined || ![
      "accepted",
      "dispatching",
      "backend_accepted",
      "dispatch_unknown"
    ].includes(queueItem.state)) return undefined;
    const run = store.getRun(runId);
    if (run.descriptor.sessionId !== sessionId) return undefined;
    const evidence = contextRecoveryEvidence(store, sessionId, runId);
    const sourceInputPending = reason === "prompt_timeout" || !evidence.hasAssistantOrToolEffects;
    const replaySafe = reason === "context_overflow"
      && sourceInputPending
      && queueItem.disposition === "prompt"
      && run.descriptor.source === "user"
      && !evidence.hasExternalDispatchOwner;
    return {
      reason,
      operationId: queueItem.operationId,
      runId,
      queueItemId: queueItem.id,
      sourceInputPending,
      replaySafe
    };
  }

  private async rebuildPendingContextBeforeDispatch(sessionId: string): Promise<boolean> {
    const pending = this.#store.findPendingContextRebuild(sessionId);
    if (pending === undefined) return true;
    if (pending.state !== "pending") return false;
    if (pending.replaySafe && !this.ensureContextOverflowReplay(sessionId)) return false;
    const claim = this.#store.claimPendingContextRebuild(sessionId);
    if (claim === undefined) return false;
    const active = this.#active.get(sessionId);
    const stored = this.#store.getSession(sessionId);
    let sideEffectLease: ActiveBackendSideEffectLease | undefined;
    let releaseBackendAdmission: (() => void) | undefined;
    let adapter: BackendAdapter;
    let backendInstanceGeneration: number;
    try {
      if (active !== undefined) {
        sideEffectLease = this.beginActiveBackendSideEffect(
          sessionId,
          active,
          claim.latestDeletionOperationId
        );
        adapter = active.adapter;
        backendInstanceGeneration = sideEffectLease.backendInstanceGeneration;
      } else {
        adapter = this.requireAdapter(stored.descriptor.backendId);
        backendInstanceGeneration = this.requireAdapterGeneration(stored.descriptor.backendId, adapter);
        releaseBackendAdmission = this.beginBackendAdmissionEffect(stored.descriptor.backendId);
        this.assertCurrentAdapterGeneration(stored.descriptor.backendId, adapter, backendInstanceGeneration);
      }
    } catch {
      sideEffectLease?.release();
      releaseBackendAdmission?.();
      this.#store.releasePendingContextRebuild(sessionId, claim.claimToken);
      return false;
    }
    try {
      if (stored.descriptor.binding.opaqueRef !== claim.sourceNativeOpaqueRef) {
        throw new StoreError("The pending rebuild no longer owns this native binding.");
      }
      if (claim.reason === "message_deletion") this.assertMessageDeletionSupported(sessionId);
      const rebuild = adapter.rebuildContext;
      if (rebuild === undefined) {
        throw new StoreError("The Backend cannot replace an unhealthy native context.");
      }
      const rebuildInput = contextRebuildInput(this.#store, sessionId, claim);
      const nextBinding = await rebuild.call(
        adapter,
        rebuildInput,
        {
          ...this.contextFor(
            stored,
            undefined,
            undefined,
            claim.latestDeletionOperationId,
            undefined,
            backendInstanceGeneration
          ),
          // A context rebuild is a hidden boundary effect. Native bridge
          // chatter must not enter the old product generation.
          emit: async () => undefined
        }
      );
      if (sideEffectLease !== undefined) this.assertActiveBackendSideEffectLease(sideEffectLease);
      else this.assertCurrentAdapterGeneration(stored.descriptor.backendId, adapter, backendInstanceGeneration);
      if (
        nextBinding.opaqueRef === stored.descriptor.binding.opaqueRef ||
        nextBinding.generation <= stored.descriptor.binding.generation
      ) {
        throw new StoreError("Backend context rebuild did not return a fresh, newer native binding.");
      }
      if (this.#active.get(sessionId) === active) this.#active.delete(sessionId);
      this.#nativeCompactions.delete(sessionId);
      this.clearTurnOverrideLeases(sessionId);
      this.#store.completePendingContextRebuild({
        sessionId,
        claimToken: claim.claimToken,
        binding: nextBinding,
        operationId: claim.latestDeletionOperationId,
        handoff: rebuildInput.handoff,
        replayScheduled: claim.replaySafe && this.hasContextOverflowReplay(claim),
        traceId: `context-rebuild:${claim.latestDeletionOperationId}`
      });
      return true;
    } catch (error) {
      if (active !== undefined && this.#active.get(sessionId) === active) {
        const current = this.#store.getSession(sessionId);
        await active.adapter.closeSession(
          current.descriptor.binding,
          this.contextFor(
            current,
            undefined,
            undefined,
            claim.latestDeletionOperationId,
            undefined,
            backendInstanceGeneration
          )
        ).catch(() => undefined);
        this.#active.delete(sessionId);
      }
      this.#nativeCompactions.delete(sessionId);
      this.clearTurnOverrideLeases(sessionId);
      this.#store.releasePendingContextRebuild(sessionId, claim.claimToken);
      this.recordFailure("native_context_rebuild", error);
      return false;
    } finally {
      sideEffectLease?.release();
      releaseBackendAdmission?.();
    }
  }

  /** Queue one deterministic Host-owned replay only for a safe user input. */
  private ensureContextOverflowReplay(sessionId: string): boolean {
    const pending = this.#store.findPendingContextRebuild(sessionId);
    if (
      pending?.reason !== "context_overflow" ||
      !pending.replaySafe ||
      pending.sourceQueueItemId === undefined ||
      pending.sourceRunId === undefined
    ) return true;
    const source = this.#store.getQueueItem(pending.sourceQueueItemId);
    const operationId = stableId("context-replay", `${sessionId}:${source.id}`);
    const runId = stableId("run", operationId);
    const attemptId = stableId("attempt", operationId);
    const queueItemId = stableId("queue", operationId);
    const now = Date.now();
    try {
      this.#store.runOperation(
        {
          id: operationId,
          kind: "context_overflow_replay",
          body: { sessionId, sourceRunId: pending.sourceRunId, sourceQueueItemId: source.id }
        },
        (store) => {
          const current = store.findPendingContextRebuild(sessionId);
          if (
            current?.reason !== "context_overflow" ||
            !current.replaySafe ||
            current.sourceQueueItemId !== source.id ||
            current.sourceRunId !== pending.sourceRunId
          ) throw new StoreError("The context-overflow replay fence changed before queue admission.");
          store.createRun({
            id: runId,
            sessionId,
            source: "system",
            state: "queued",
            parentRunId: pending.sourceRunId,
            createdAt: now
          });
          store.createAttempt({
            id: attemptId,
            runId,
            ordinal: 1,
            generation: store.getSession(sessionId).descriptor.binding.generation,
            startedAt: now
          });
          const replayItem = store.enqueueQueueItem({
            id: queueItemId,
            sessionId,
            runId,
            attemptId,
            operationId,
            disposition: source.disposition,
            body: source.body,
            ...(source.executionOverrides === undefined ? {} : { executionOverrides: source.executionOverrides }),
            createdAt: now
          });
          store.reorderQueueItem({
            queueItemId: replayItem.id,
            placement: { edge: "first" },
            expectedRevision: replayItem.revision,
            traceId: `context-replay:${replayItem.id}:first`,
            at: now
          });
          return { queueItemId };
        }
      );
      return this.hasContextOverflowReplay(pending);
    } catch (error) {
      this.recordFailure("context_overflow_replay", error);
      return false;
    }
  }

  private hasContextOverflowReplay(pending: PendingContextRebuild): boolean {
    if (pending.sourceQueueItemId === undefined) return false;
    const operationId = stableId("context-replay", `${pending.sessionId}:${pending.sourceQueueItemId}`);
    const queueItemId = stableId("queue", operationId);
    try {
      const item = this.#store.getQueueItem(queueItemId);
      return item.sessionId === pending.sessionId;
    } catch {
      return false;
    }
  }

  private async persistNativeDispatchRecoveryBaseline(
    item: QueueItemRecord,
    stored: StoredSession,
    runId: string,
    attemptId: string | undefined,
    preparation: DurableNativeDispatchPreparation
  ): Promise<void> {
    const history = preparation.nativeHistory;
    const lineage = history.activeLineage;
    if (attemptId === undefined || item.backendInstanceGeneration === undefined || lineage === undefined) {
      throw new StoreError("The recoverable native runtime did not provide a complete dispatch lineage.");
    }
    if (!/^[a-f0-9]{64}$/u.test(preparation.inputFingerprint) || !validNativeLineage(history)) {
      throw new StoreError("The recoverable native runtime provided an invalid dispatch lineage or fingerprint.");
    }
    const baseline: NativeDispatchRecoveryBaseline = {
      format: 1,
      phase: "prepared",
      runId,
      queueItemId: item.id,
      attemptId,
      operationId: item.operationId,
      disposition: item.disposition,
      generation: stored.descriptor.binding.generation,
      backendInstanceGeneration: item.backendInstanceGeneration,
      bindingFingerprint: nativeBindingFingerprint(stored.descriptor.binding.opaqueRef),
      projectionCount: history.events.length,
      projectionDigest: nativeProjectionDigest(history.events),
      lineageCount: lineage.length,
      lineageDigest: nativeLineageDigest(lineage),
      inputBodyHash: item.bodyHash,
      inputFingerprint: preparation.inputFingerprint,
      ...(history.activeEntryId === undefined ? {} : { activeEntryId: history.activeEntryId }),
      recordedAt: Date.now()
    };
    this.#store.transaction((store) => {
      const currentSession = store.getSession(item.sessionId);
      const currentItem = store.getQueueItem(item.id);
      const currentRun = store.getRun(runId);
      const currentAttempt = store.getAttempt(attemptId);
      if (
        currentSession.descriptor.binding.generation !== baseline.generation ||
        currentSession.descriptor.binding.opaqueRef !== stored.descriptor.binding.opaqueRef ||
        currentItem.state !== "dispatching" || currentItem.attemptId !== attemptId ||
        currentItem.backendInstanceGeneration !== baseline.backendInstanceGeneration ||
        currentRun.descriptor.sessionId !== item.sessionId ||
        currentAttempt.descriptor.runId !== runId ||
        currentAttempt.descriptor.generation !== baseline.generation ||
        currentAttempt.descriptor.backendInstanceGeneration !== baseline.backendInstanceGeneration ||
        currentAttempt.descriptor.endedAt !== undefined
      ) throw new StoreError("Native dispatch recovery baseline crossed its serial dispatch fence.");
      const journal = nativeDispatchRecoveryJournal(store.findSetting(
        "session",
        item.sessionId,
        SESSION_NATIVE_DISPATCH_RECOVERY_SETTING_KEY
      )?.value) ?? { format: 1, entries: [] };
      const existing = journal.entries.find((entry) => entry.queueItemId === item.id);
      if (existing !== undefined) {
        if (JSON.stringify(existing) !== JSON.stringify(baseline)) {
          throw new StoreError("Native dispatch recovery preparation changed behind its durable queue fence.");
        }
        return;
      }
      if (journal.entries.length >= 256) throw new StoreError("Native dispatch recovery journal is full.");
      store.setSetting(
        "session",
        item.sessionId,
        SESSION_NATIVE_DISPATCH_RECOVERY_SETTING_KEY,
        { format: 1, entries: [...journal.entries, baseline] } satisfies NativeDispatchRecoveryJournal,
        baseline.recordedAt
      );
    });
  }

  private async drain(sessionId: string): Promise<void> {
    const existingSettlement = this.#drainSettlements.get(sessionId);
    if (existingSettlement !== undefined) return existingSettlement;
    if (
      this.#runSilenceRecoveries.has(sessionId)
      || this.#runtimeRestartFences.has(sessionId)
      || this.#disposed
      || this.#store.findPendingScheduleDeletionCleanupForSession(sessionId) !== undefined
    ) return;
    let settle!: () => void;
    const settlement = new Promise<void>((resolve) => { settle = resolve; });
    this.#drainSettlements.set(sessionId, settlement);
    this.#draining.add(sessionId);
    try {
      while (!this.#disposed) {
        if (
          this.#runSilenceRecoveries.has(sessionId)
          || this.#runtimeRestartFences.has(sessionId)
          || this.#store.findPendingScheduleDeletionCleanupForSession(sessionId) !== undefined
        ) return;
        // claimNextQueueItem intentionally returns undefined while paused. Exit
        // instead of polling a durable control state in a synchronous loop;
        // resumeQueue explicitly wakes this session after its commit.
        if (this.#store.getQueueControl(sessionId).paused) return;
        let pending = this.#store.listQueueItems({ sessionId, states: ["accepted"], limit: 1 })[0];
        if (pending === undefined) return;
        // The accepted prompt remains durable while the old native context is
        // replaced. A failed rebuild releases only its claim and exits; the
        // queue item is never moved to dispatching or dropped.
        if (!await this.rebuildPendingContextBeforeDispatch(sessionId)) return;
        if (this.#store.findPendingScheduleDeletionCleanupForSession(sessionId) !== undefined) return;
        pending = this.#store.listQueueItems({ sessionId, states: ["accepted"], limit: 1 })[0];
        if (pending === undefined) return;
        // Rebuild can advance the product generation before durable queue
        // claim. Renew while still accepted so claim's queue_update event is
        // generation-consistent; normal activation may renew once more below.
        const rebuiltGeneration = this.#store.getSession(sessionId).descriptor.binding.generation;
        pending = this.#store.renewQueueAttemptGeneration({
          queueItemId: pending.id,
          attemptId: stableId("attempt", `${pending.operationId}:context-rebuild-generation:${rebuiltGeneration}`),
          generation: rebuiltGeneration
        });
        const compactionDecision = await this.compactionDispatchDecision(sessionId);
        if (this.#store.findPendingScheduleDeletionCleanupForSession(sessionId) !== undefined) return;
        if (compactionDecision.kind === "blocked") return;
        if (!await this.#applyPendingSessionRuntimeControl(sessionId)) return;
        const bypassQueueItemId = compactionDecision.kind === "bypass"
          ? compactionDecision.queueItemId
          : undefined;
        // Inspection yields to queue control, cancellation, reordering, and
        // native events. Re-read every durable precondition, then perform the
        // final barrier check and claim synchronously so they cannot race.
        if (this.#store.getQueueControl(sessionId).paused) return;
        pending = this.#store.listQueueItems({ sessionId, states: ["accepted"], limit: 1 })[0];
        if (pending === undefined) return;
        // Classification/reordering awaited Backend state. Never let its
        // bypass authorization transfer to a different item that was moved or
        // cancelled concurrently; restart the decision against durable truth.
        if (bypassQueueItemId !== undefined && pending.id !== bypassQueueItemId) continue;
        const bypassesCompaction = bypassQueueItemId !== undefined;
        const refreshedPendingRunId = pending.runId;
        const otherActive = listAllRuns(this.#store, { sessionId, activeOnly: true })
          .some((run) => run.descriptor.id !== refreshedPendingRunId && run.descriptor.state !== "queued");
        // A scoped policy cannot overlap another active turn. Catalogued
        // compaction-safe commands are the sole exception and were durably
        // normalized/reordered by compactionDispatchDecision above.
        if (!bypassesCompaction && otherActive && (
          pending.disposition === "prompt" || hasTurnOverrides(pending.executionOverrides)
        )) return;
        if (!bypassesCompaction && this.compactionBlocksDispatch(sessionId)) return;
        const claimSession = this.#store.getSession(sessionId);
        const claimBackendInstanceGeneration = this.#store
          .getBackend(claimSession.descriptor.backendId).descriptor.instanceGeneration;
        const claimedItem = this.#store.claimNextQueueItem({
          sessionId,
          backendInstanceGeneration: claimBackendInstanceGeneration,
          traceId: `dispatch:${pending.id}`
        });
        // A concurrent pause may land between the control read and durable
        // claim. The resume path owns the next wake-up, so never busy-poll.
        if (claimedItem === undefined) return;
        const dispatchPreparation = this.beginDispatchPreparation(sessionId);
        let item = claimedItem;
        const run = this.#store.getRun(item.runId);
        let attemptId = item.attemptId;
        const reviewReadOnly = this.isReviewReadOnlySession(sessionId);
        try {
          let active: ActiveSession | undefined;
          try {
            active = await this.activate(sessionId);
          } finally {
            // Accepted work may survive while its runtime does not. Runtime
            // activation advances the Session generation, so dispatch must
            // receive a fresh Attempt before any new-generation event can be
            // associated with it. The Store transition is atomic and leaves
            // the prior Attempt as durable history.
            const generation = this.#store.getSession(sessionId).descriptor.binding.generation;
            item = this.#store.renewQueueAttemptGeneration({
              queueItemId: item.id,
              attemptId: stableId("attempt", `${item.operationId}:generation:${generation}`),
              generation
            });
            attemptId = item.attemptId;
          }
          if (active === undefined) throw new Error("Session activation returned no active runtime.");
          if (
            item.backendInstanceGeneration === undefined ||
            active.backendInstanceGeneration !== item.backendInstanceGeneration
          ) {
            throw new JokoError({
              code: "BACKEND_INSTANCE_STALE",
              message: "The durable dispatch claim does not match the active Backend instance.",
              phase: "dispatch",
              retryable: true,
              stateMayHaveChanged: false,
              recovery: "Retry after Backend instance replacement finishes."
            });
          }
          this.assertSessionNotPendingScheduleDeletion(sessionId);
          const stored = this.#store.getSession(sessionId);
          const target = this.targetForSession(stored);
          if (this.#workspaceCapture !== undefined && !reviewReadOnly) {
            const nativeLeafId = active.adapter.getTree === undefined
              ? undefined
              : await active.adapter.getTree(this.contextFor(
                  stored,
                  run.descriptor.id,
                  attemptId,
                  item.operationId,
                  undefined,
                  item.backendInstanceGeneration
                ))
                .then((tree) => tree.leafId)
                .catch((error: unknown) => {
                  this.recordFailure("workspace-dialogue-baseline", error);
                  return undefined;
                });
            await this.#workspaceCapture.captureBeforeRun({
              sessionId,
              runId: run.descriptor.id,
              target,
              ...(nativeLeafId === undefined ? {} : { nativeLeafId })
            })
              .catch((error: unknown) => this.recordFailure("workspace-baseline", error));
          }
          this.assertSessionNotPendingScheduleDeletion(sessionId);
          const context = await this.beginTurnOverrideLease(item, active, stored);
          this.assertSessionNotPendingScheduleDeletion(sessionId);
          this.assertDispatchAdmissionOwner(
            item,
            attemptId,
            active,
            stored.descriptor.binding.generation
          );
          dispatchPreparation.phase = "sending";
          const pendingAcceptance: PendingDispatchAcceptance = {};
          this.#pendingDispatchAcceptances.set(run.descriptor.id, pendingAcceptance);
          if (!reviewReadOnly && active.adapter.sendWithDurableNativeDispatchFence !== undefined) {
            await active.adapter.sendWithDurableNativeDispatchFence(item.body, context, (preparation) => {
              this.assertDispatchAdmissionOwner(
                item,
                attemptId,
                active,
                stored.descriptor.binding.generation
              );
              return this.persistNativeDispatchRecoveryBaseline(
                item,
                stored,
                run.descriptor.id,
                attemptId,
                preparation
              );
            });
          } else {
            await active.adapter.send(item.body, context);
          }
          if (this.#disposed) return;
          this.#store.transaction((store) => {
            store.updateQueueState({
              queueItemId: item.id,
              state: "backend_accepted",
              attemptId,
              traceId: `dispatch:${item.id}:accepted`
            });
            store.updateRunState({
              runId: run.descriptor.id,
              state: "running",
              activeAttemptId: attemptId,
              traceId: `dispatch:${item.id}:running`,
              operationId: item.operationId
            });
            markNativeDispatchRecoveryAccepted(store, sessionId, item.id);
          });
          this.refreshRunSilenceWatchdog(sessionId);
          if (reviewReadOnly) {
            this.persistReviewerPromptEvent({
              sessionId,
              runId: run.descriptor.id,
              ...(attemptId === undefined ? {} : { attemptId }),
              operationId: item.operationId,
              generation: stored.descriptor.binding.generation,
              target,
              prompt: item.body
            });
            this.#reviewRuntimeFlights.get(sessionId)?.accept();
          }
          this.#pendingDispatchAcceptances.delete(run.descriptor.id);
          if (!reviewReadOnly) void this.refreshNativeStateBestEffort(sessionId, active, "native_state_dispatch_sync");
          if (pendingAcceptance.settlement !== undefined) {
            if (reviewReadOnly) {
              await this.finishReviewSettledSession(sessionId, pendingAcceptance.settlement, run.descriptor.id);
              this.settleReviewRuntime(
                sessionId,
                this.reviewRuntimeOutcome(sessionId, pendingAcceptance.settlement)
              );
            } else {
              await this.finishSettledSession(sessionId, pendingAcceptance.settlement, run.descriptor.id);
            }
          }
        } catch (error) {
          this.#pendingDispatchAcceptances.delete(run.descriptor.id);
          this.#workspaceCapture?.abortRun?.({ sessionId, runId: run.descriptor.id });
          if (this.#disposed) return;
          await this.restoreTurnOverrideLease(run.descriptor.id);
          if (this.#disposed) return;
          if (this.#store.findPendingScheduleDeletionCleanupForSession(sessionId) !== undefined) {
            this.#store.transaction((store) => {
              const queueItem = store.getQueueItem(item.id);
              if (["accepted", "dispatching", "backend_accepted", "dispatch_unknown"].includes(queueItem.state)) {
                store.cancelQueueItem({
                  queueItemId: item.id,
                  traceId: `schedule-deletion:${item.id}:cancelled`
                });
              }
              const currentRun = store.getRun(run.descriptor.id);
              if (["queued", "running", "waiting", "retrying", "dispatch_unknown"].includes(currentRun.descriptor.state)) {
                store.updateRunState({
                  runId: currentRun.descriptor.id,
                  state: "aborted",
                  endedAt: Date.now(),
                  traceId: `schedule-deletion:${currentRun.descriptor.id}:aborted`
                });
              }
            });
            return;
          }
          // Ordinary archive/delete installs a claimed lifecycle fence and
          // terminalizes durable work before closing the runtime. Do not turn
          // the expected send interruption into a second failure transition.
          if (
            this.#sessionLifecycleFences.has(sessionId)
            || this.#store.findPendingSessionLifecycleCleanup(sessionId) !== undefined
          ) return;
          const failure: PublicError = reviewReadOnly ? {
            code: "REVIEWER_DISPATCH_FAILED",
            message: "The isolated reviewer Backend did not accept the request.",
            phase: "dispatch",
            retryable: false,
            stateMayHaveChanged: false,
            recovery: "Start a new review after checking provider and artifact availability."
          } : toPublicError(error, {
              code: "BACKEND_DISPATCH_FAILED",
              phase: "dispatch",
              retryable: true,
              stateMayHaveChanged: false,
              recovery: "Inspect Backend diagnostics and explicitly retry when safe."
            });
          const uncertain = failure.stateMayHaveChanged;
          if (uncertain) {
            const active = this.#active.get(sessionId);
            if (active !== undefined) this.markNativeStateObservationStale(sessionId, active);
          }
          const recoveryTrigger = reviewReadOnly
            ? undefined
            : this.contextRecoveryTrigger(this.#store, sessionId, run.descriptor.id, failure);
          this.#store.transaction((store) => {
            store.updateQueueState({
              queueItemId: item.id,
              state: uncertain ? "dispatch_unknown" : "failed",
              attemptId,
              error: failure,
              traceId: `dispatch:${item.id}:failed`
            });
            store.updateRunState({
              runId: run.descriptor.id,
              state: uncertain ? "dispatch_unknown" : "failed",
              activeAttemptId: attemptId,
              error: failure,
              traceId: `dispatch:${item.id}:failed`,
              operationId: item.operationId
            });
            if (attemptId !== undefined) store.finishAttempt(attemptId, failure);
            if (recoveryTrigger !== undefined) {
              store.armPendingContextRebuild({
                sessionId,
                reason: recoveryTrigger.reason,
                operationId: recoveryTrigger.operationId,
                sourceRunId: recoveryTrigger.runId,
                sourceQueueItemId: recoveryTrigger.queueItemId,
                sourceInputPending: recoveryTrigger.sourceInputPending,
                replaySafe: recoveryTrigger.replaySafe
              });
            }
          });
          if (!uncertain) {
            removeNativeDispatchRecoveryEntry(this.#store, sessionId, run.descriptor.id);
          }
          if (recoveryTrigger?.reason === "context_overflow") this.ensureContextOverflowReplay(sessionId);
          if (this.isReviewReadOnlySession(sessionId)) {
            this.#reviewRuntimeFlights.get(sessionId)?.rejectAcceptance(
              new StoreError("Reviewer Backend did not accept the durable prompt.")
            );
            this.settleReviewRuntime(sessionId, { state: "failed" });
          }
        } finally {
          this.finishDispatchPreparation(sessionId, dispatchPreparation);
        }
      }
    } finally {
      this.#draining.delete(sessionId);
      if (this.#drainSettlements.get(sessionId) === settlement) {
        this.#drainSettlements.delete(sessionId);
      }
      settle();
    }
  }

  private targetForSession(stored: StoredSession): TargetDescriptor {
    const current = this.#worktrees?.effectiveTarget(stored)
      ?? this.#store.getTarget(stored.descriptor.targetId).descriptor;
    return {
      ...current,
      remoteWorkspace: stored.descriptor.remoteWorkspace
    };
  }

  private contextFor(
    stored: StoredSession,
    runId?: string,
    attemptId?: string,
    operationId?: string,
    extraDirectories?: readonly ApprovedDirectory[],
    backendInstanceGeneration?: number
  ): AdapterContext {
    const runtimePolicy = this.#store.findSessionRuntimePolicy(stored.descriptor.id)?.policy;
    return this.makeContext(
      stored.descriptor.id,
      this.targetForSession(stored),
      stored.descriptor.binding.generation,
      stored.descriptor.binding,
      runId,
      attemptId,
      operationId,
      extraDirectories,
      runtimePolicy,
      stored.descriptor.appendSystemPrompt,
      backendInstanceGeneration
    );
  }

  private provisionalContext(
    sessionId: string,
    target: TargetDescriptor,
    generation: number,
    runtimePolicy?: "review_read_only",
    appendSystemPrompt?: string,
    backendInstanceGeneration?: number
  ): AdapterContext {
    if (runtimePolicy === undefined) this.#freezeToolPolicies?.(sessionId, target.id);
    return this.makeContext(
      sessionId,
      target,
      generation,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      runtimePolicy,
      appendSystemPrompt,
      backendInstanceGeneration
    );
  }

  private makeContext(
    sessionId: string,
    target: TargetDescriptor,
    generation: number,
    binding?: NativeSessionBinding,
    runId?: string,
    attemptId?: string,
    operationId?: string,
    selectedExtraDirectories?: readonly ApprovedDirectory[],
    runtimePolicy?: "review_read_only",
    appendSystemPrompt?: string,
    backendInstanceGenerationOverride?: number
  ): AdapterContext {
    const signal = new AbortController().signal;
    const backend = this.#store.getBackend(target.backendId).descriptor;
    const backendInstanceGeneration = backendInstanceGenerationOverride ??
      this.#active.get(sessionId)?.backendInstanceGeneration ??
      backend.instanceGeneration;
    const extraDirectoriesSupported = backend.capabilities.get("workspace.extra_dirs")?.supported === true;
    return {
      sessionId,
      generation,
      backendInstanceGeneration,
      target,
      policySnapshot: policySnapshotFor(this.#store, target),
      ...(runtimePolicy === undefined ? {} : { runtimePolicy }),
      ...(runtimePolicy === "review_read_only" || appendSystemPrompt === undefined ? {} : { appendSystemPrompt }),
      extraDirectories: runtimePolicy === "review_read_only" || !extraDirectoriesSupported
        ? []
        : selectedExtraDirectories ?? this.extraDirectories.listForTarget(target.id),
      ...(binding === undefined ? {} : { binding }),
      ...(operationId === undefined ? {} : { operationId }),
      signal,
      emit: (payload, metadata) => {
        if (this.#disposed || !this.backendInstanceGenerationOwnsContext(
          sessionId,
          backendInstanceGeneration,
          runId,
          attemptId
        )) return Promise.resolve();
        const releaseContextFlight = this.tryBeginBackendCallbackFlight(target.backendId, sessionId);
        if (releaseContextFlight === undefined || !this.backendInstanceGenerationOwnsContext(
          sessionId,
          backendInstanceGeneration,
          runId,
          attemptId
        )) {
          releaseContextFlight?.();
          return Promise.resolve();
        }
        try {
          if (runtimePolicy === "review_read_only") this.assertReviewRuntimeEventAllowed(payload);
          this.assertSubagentEventAvailable(target.backendId, payload);
        } catch (error) {
          releaseContextFlight();
          throw error;
        }
        if (runtimePolicy === "review_read_only") {
          this.collectReviewRuntimePayload(sessionId, payload);
          // The host persists the exact accepted prompt under a stable event
          // identity. Ignore the Backend's echo so the retained Reviewer task
          // cannot grow a duplicate user row.
          if (payload.type === "message_complete" && payload.role === "user") {
            releaseContextFlight();
            return Promise.resolve();
          }
        }
        const durablePayload = this.withAcceptedInputMetadata(payload, sessionId, runId);
        const durableMetadata = bindNativeHistoryEventMetadata(durablePayload, binding?.opaqueRef, metadata);
        // Close the event-delivery race synchronously: once a live compaction
        // start reaches Orchestrator, no queue claim can interleave before its
        // durable event append. Terminal states release only after that append has
        // been attempted, then idempotently wakes the singleton dispatcher.
        if (payload.type === "compaction" && payload.state === "started") {
          this.observeNativeCompaction(sessionId, generation, true, false, false, "event");
        }
        const releasesCompaction = payload.type === "compaction" && payload.state !== "started";
        const emission = (async (): Promise<void> => {
          try {
            if (this.#disposed) return;
            if (!this.backendInstanceGenerationOwnsContext(
              sessionId,
              backendInstanceGeneration,
              runId,
              attemptId
            )) return;
            const session = this.#store.listSessions({ includeArchived: true, includeDeleted: true })
              .find((candidate) => candidate.descriptor.id === sessionId);
            if (session === undefined) return;
            const emittedAt = Date.now();
            const append = (store: OperationalStore): void => {
              store.appendEvent({
              backendId: target.backendId,
              targetId: target.id,
              sessionId,
              ...(runId === undefined ? {} : { runId }),
              ...(attemptId === undefined ? {} : { attemptId }),
              ...(operationId === undefined ? {} : { operationId }),
              generation,
              emittedAt,
              traceId: `adapter:${sessionId}:${randomUUID()}`,
              payload: durablePayload,
              ...(durableMetadata === undefined ? {} : {
                metadata: { namespace: durableMetadata.namespace, fields: durableMetadata.fields },
                ...(durableMetadata.pi === undefined ? {} : { pi: durableMetadata.pi })
              })
              });
            };
            const appendAndArmRecovery = (store: OperationalStore): void => {
              append(store);
              if (durablePayload.type !== "error" || !durablePayload.terminal || runId === undefined) return;
              const failedItem = listAllQueueItems(store, { sessionId })
                .find((candidate) => candidate.runId === runId);
              recordProviderRateLimit(
                store,
                session.descriptor.backendId,
                failedItem?.executionOverrides?.providerId ?? session.descriptor.providerId,
                durablePayload.error,
                emittedAt
              );
              const trigger = this.contextRecoveryTrigger(store, sessionId, runId, durablePayload.error);
              if (trigger === undefined) return;
              store.armPendingContextRebuild({
                sessionId,
                reason: trigger.reason,
                operationId: trigger.operationId,
                sourceRunId: trigger.runId,
                sourceQueueItemId: trigger.queueItemId,
                sourceInputPending: trigger.sourceInputPending,
                replaySafe: trigger.replaySafe,
                at: emittedAt
              });
            };
            if (payload.type === "extension_widget" || payload.type === "extension_status") {
              this.#store.transaction((store) => {
                const settingKey = payload.type === "extension_widget"
                  ? EXTENSION_WIDGETS_SETTING_KEY
                  : EXTENSION_STATUSES_SETTING_KEY;
                const existing = store.findSetting<unknown>("session", sessionId, settingKey)?.value;
                const next = payload.type === "extension_widget"
                  ? updateExtensionWidgets(existing, payload, emittedAt)
                  : updateExtensionStatuses(existing, payload, emittedAt);
                if (next.length === 0) store.deleteSetting("session", sessionId, settingKey);
                else store.setSetting("session", sessionId, settingKey, next, emittedAt);
                appendAndArmRecovery(store);
              });
            } else if (durablePayload.type === "error" && durablePayload.terminal && runId !== undefined) {
              this.#store.transaction(appendAndArmRecovery);
            } else if (durablePayload.type === "usage") {
              this.#store.transaction((store) => {
                const usageItem = runId === undefined ? undefined : listAllQueueItems(store, { sessionId })
                  .find((candidate) => candidate.runId === runId);
                this.recordUsageObservation(
                  store,
                  session,
                  generation,
                  durablePayload.usage,
                  emittedAt,
                  SESSION_RUNTIME_USAGE_SOURCE_ID,
                  usageItem?.executionOverrides?.providerId,
                  usageItem?.executionOverrides?.modelId,
                  true,
                  scheduleRunUsageTarget(store, [runId], "exact")
                );
                appendAndArmRecovery(store);
              });
            } else if (durablePayload.type === "subagent_run" && durablePayload.run.usage !== undefined) {
              const childUsage = durablePayload.run.usage;
              this.#store.transaction((store) => {
                this.recordUsageObservation(
                  store,
                  session,
                  generation,
                  subagentUsageSnapshot(childUsage),
                  emittedAt,
                  `delegated-run:${durablePayload.run.id}`,
                  durablePayload.run.route?.providerId,
                  durablePayload.run.route?.modelId,
                  false,
                  scheduleRunUsageTarget(store, [durablePayload.run.parentRunId, runId], "direct")
                );
                appendAndArmRecovery(store);
              });
            } else append(this.#store);
            if (runId !== undefined) {
              this.#noteSessionRuntimeRecoveryProgress(sessionId, runId, durablePayload);
            }
            this.touchActiveSession(sessionId);
            if (payload.type === "background_task") {
              this.trackBackgroundTask(sessionId, generation, payload, runId, attemptId, operationId);
            }
            this.refreshRunSilenceWatchdog(sessionId);
          } catch (error) {
            if (error instanceof StaleGenerationError) return;
            throw error;
          } finally {
            if (releasesCompaction) {
              this.observeNativeCompaction(
                sessionId,
                generation,
                false,
                true,
                payload.type === "compaction" && payload.willRetry === true,
                "event"
              );
            }
            releaseContextFlight();
          }
          if (payload.type === "compaction" && payload.state === "started") {
            // The start event is durable now. Revisit accepted work so a
            // Backend-classified immediate extension command can bypass the
            // barrier even when an ordinary message is ahead of it.
            void this.drain(sessionId);
          }
          if (payload.type === "done") {
            this.clearRunSilenceWatchdog(sessionId);
            const pendingAcceptance = runId === undefined ? undefined : this.#pendingDispatchAcceptances.get(runId);
            if (pendingAcceptance === undefined) await this.finishSettledSession(sessionId, payload.outcome, runId);
            else pendingAcceptance.settlement ??= payload.outcome;
          }
          else if (payload.type === "retry" && !isTerminalRetryState(payload.state) && runId !== undefined) {
            const current = this.#store.getRun(runId);
            if (current.descriptor.state === "running" || current.descriptor.state === "waiting") {
              this.#store.updateRunState({ runId, state: "retrying", traceId: `retry:${runId}`, operationId });
            }
          }
        })();
        const inflight = this.#inflightEmissions.get(sessionId) ?? new Set<Promise<void>>();
        inflight.add(emission);
        this.#inflightEmissions.set(sessionId, inflight);
        void emission.then(
          () => {
            inflight.delete(emission);
            if (inflight.size === 0 && this.#inflightEmissions.get(sessionId) === inflight) {
              this.#inflightEmissions.delete(sessionId);
            }
          },
          () => {
            inflight.delete(emission);
            if (inflight.size === 0 && this.#inflightEmissions.get(sessionId) === inflight) {
              this.#inflightEmissions.delete(sessionId);
            }
          }
        );
        return emission;
      },
      requestInteraction: (interaction, options) => runtimePolicy === "review_read_only"
        ? Promise.reject(new StoreError("Reviewer runtime interactions are disabled."))
        : this.requestInteraction(
            sessionId,
            generation,
            backendInstanceGeneration,
            interaction,
            runId,
            attemptId,
            operationId,
            options?.signal
          ),
      artifactCapacityBytes: this.#artifactStore.maximumBlobBytes,
      storeArtifact: async (sourcePath, options) => {
        if (runtimePolicy === "review_read_only") {
          throw new StoreError("Reviewer runtime artifacts are disabled.");
        }
        if (this.#disposed) throw new Error("Session Host is closed.");
        if (!this.backendInstanceGenerationOwnsContext(
          sessionId,
          backendInstanceGeneration,
          runId,
          attemptId
        )) throw staleBackendInstanceContextError();
        const artifact = await this.#artifactStore.ingestPath(sourcePath, options);
        if (this.#disposed) throw new Error("Session Host closed while storing a Backend artifact.");
        if (!this.backendInstanceGenerationOwnsContext(
          sessionId,
          backendInstanceGeneration,
          runId,
          attemptId
        )) throw staleBackendInstanceContextError();
        const current = this.#store.getSession(sessionId);
        const blob: BlobRef = {
          id: artifact.id,
          sha256: artifact.sha256,
          byteLength: artifact.byteLength,
          mimeType: artifact.mimeType,
          ...(artifact.fileName === undefined ? {} : { fileName: artifact.fileName })
        };
        const artifactEventId = `backend-artifact-${createHash("sha256")
          .update(sessionId).update("\0").update(blob.id)
          .digest("hex")}`;
        this.#store.appendEventIfAbsent({
          id: artifactEventId,
          backendId: current.descriptor.backendId,
          targetId: current.descriptor.targetId,
          sessionId,
          ...(runId === undefined ? {} : { runId }),
          ...(attemptId === undefined ? {} : { attemptId }),
          generation,
          traceId: `artifact:${blob.id}`,
          payload: { type: "artifact", artifact: blob, purpose: "backend_artifact" }
        });
        this.touchActiveSession(sessionId);
        return blob;
      }
    };
  }

  /** Collect the terminal conclusion while the normal durable Event path keeps
   * the isolated Reviewer's own task readable after its runtime is closed. */
  private collectReviewRuntimePayload(sessionId: string, payload: EventPayload): void {
    const flight = this.#reviewRuntimeFlights.get(sessionId);
    if (flight === undefined || flight.settled) return;
    if (payload.type === "text_delta" && !flight.hasCompleteMessage) {
      flight.text.push(payload.delta);
      return;
    }
    if (payload.type === "message_complete" && payload.role === "assistant") {
      flight.text.splice(0);
      for (const block of payload.blocks) {
        if (block.kind === "text" && block.text !== "") flight.text.push(block.text);
      }
      flight.hasCompleteMessage = true;
    }
  }

  private persistReviewerPromptEvent(input: {
    readonly sessionId: string;
    readonly runId: string;
    readonly attemptId?: string;
    readonly operationId: string;
    readonly generation: number;
    readonly target: TargetDescriptor;
    readonly prompt: PromptInput;
  }): void {
    const policy = this.#store.getSessionRuntimePolicy(input.sessionId);
    const flight = this.#reviewRuntimeFlights.get(input.sessionId);
    if (policy.policy !== "review_read_only" || flight === undefined) {
      throw new StoreError("Reviewer prompt persistence requires the active immutable Review flight.");
    }
    const blocks: MessageBlock[] = [
      ...(input.prompt.text === "" ? [] : [{ kind: "text" as const, text: input.prompt.text }]),
      ...input.prompt.images.map((image) => ({
        kind: "image" as const,
        blob: image.blob,
        ...(image.alt === undefined ? {} : { alt: image.alt })
      })),
      ...input.prompt.files.map((file) => ({
        kind: "artifact" as const,
        blob: file.blob,
        label: file.workspacePath ?? file.blob.fileName ?? "file"
      }))
    ];
    this.#store.appendEventIfAbsent({
      id: `review-prompt-${createHash("sha256").update(policy.reviewRunId).digest("hex")}`,
      backendId: input.target.backendId,
      targetId: input.target.id,
      sessionId: input.sessionId,
      runId: input.runId,
      ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
      operationId: input.operationId,
      generation: input.generation,
      traceId: `review-prompt:${policy.reviewRunId}`,
      payload: {
        type: "message_complete",
        role: "user",
        blocks,
        ...(input.prompt.quotesEncoded === true ? { quotesEncoded: true } : {}),
        ...(input.prompt.pastedTextRanges === undefined ? {} : { pastedTextRanges: input.prompt.pastedTextRanges })
      }
    });
    this.touchActiveSession(input.sessionId);
  }

  private reviewRuntimeOutcome(
    sessionId: string,
    outcome: "completed" | "aborted" | "failed"
  ): ReviewRuntimeOutcome {
    if (outcome === "aborted") return { state: "aborted" };
    if (outcome === "failed") return { state: "failed" };
    const text = this.#reviewRuntimeFlights.get(sessionId)?.text.join("\n").trim() ?? "";
    const characters = [...text];
    const visibleResult = characters.length <= 100_000
      ? text
      : `${characters.slice(0, 99_970).join("")}\n\n[review output truncated]`;
    return { state: "completed", visibleResult };
  }

  private settleReviewRuntime(sessionId: string, outcome: ReviewRuntimeOutcome): void {
    const flight = this.#reviewRuntimeFlights.get(sessionId);
    if (flight === undefined || flight.settled) return;
    flight.settled = true;
    flight.resolve(outcome);
  }

  private isReviewReadOnlySession(sessionId: string): boolean {
    return this.#store.findSessionRuntimePolicy(sessionId)?.policy === "review_read_only";
  }

  private requestInteraction(
    sessionId: string,
    generation: number,
    backendInstanceGeneration: number,
    interaction: InteractionPayload,
    runId?: string,
    attemptId?: string,
    operationId?: string,
    signal?: AbortSignal
  ): Promise<InteractionDecision> {
    if (this.#disposed || signal?.aborted === true) return Promise.resolve({ kind: "cancelled" });
    if (!this.backendInstanceGenerationOwnsContext(
      sessionId,
      backendInstanceGeneration,
      runId,
      attemptId
    )) {
      return Promise.resolve({ kind: "cancelled" });
    }
    this.touchActiveSession(sessionId);
    this.#store.openInteraction({
      sessionId,
      ...(runId === undefined ? {} : { runId }),
      ...(attemptId === undefined ? {} : { attemptId }),
      ...(operationId === undefined ? {} : { operationId }),
      generation,
      payload: interaction,
      traceId: `interaction:${interaction.id}`
    });
    return new Promise((resolvePromise) => {
      const timeoutMs = timedExtensionInteractionTimeout(interaction);
      const pending: PendingInteraction = {
        sessionId,
        generation,
        backendInstanceGeneration,
        ...(runId === undefined ? {} : { runId }),
        ...(attemptId === undefined ? {} : { attemptId }),
        resolve: resolvePromise,
        ...(timeoutMs === undefined ? {} : {
          expiryTimer: setTimeout(() => this.expirePendingInteraction(interaction.id, generation), timeoutMs)
        }),
        ...(signal === undefined ? {} : {
          abortSignal: signal,
          abortListener: () => this.cancelPendingInteractionFromAdapter(interaction.id, generation)
        })
      };
      this.#pendingInteractions.set(interaction.id, pending);
      if (pending.abortSignal !== undefined && pending.abortListener !== undefined) {
        pending.abortSignal.addEventListener("abort", pending.abortListener, { once: true });
        if (pending.abortSignal.aborted) pending.abortListener();
      }
      this.refreshRunSilenceWatchdog(sessionId);
    });
  }

  private cancelPendingInteractionFromAdapter(id: string, generation: number): void {
    const pending = this.#pendingInteractions.get(id);
    if (pending?.generation !== generation) return;
    try {
      const interaction = this.#store.getInteraction(id);
      if (interaction.status === "open") {
        this.#store.dismissInteraction(
          id,
          generation,
          "The Backend cancelled its native interaction request.",
          `interaction-backend-cancelled:${id}`
        );
      }
    } catch (error) {
      if (!(error instanceof StaleGenerationError)) this.recordFailure("interaction_backend_cancel", error);
    } finally {
      if (this.#pendingInteractions.get(id) === pending) this.#pendingInteractions.delete(id);
      clearPendingInteractionExpiry(pending);
      pending.resolve({ kind: "cancelled" });
      this.refreshRunSilenceWatchdog(pending.sessionId);
    }
  }

  private expirePendingInteraction(id: string, generation: number): void {
    const pending = this.#pendingInteractions.get(id);
    if (pending?.generation !== generation) return;
    try {
      const interaction = this.#store.getInteraction(id);
      if (interaction.status === "open") {
        this.#store.dismissInteraction(
          id,
          generation,
          TIMED_EXTENSION_INTERACTION_EXPIRED_REASON,
          `interaction-expired:${id}`
        );
      }
    } catch (error) {
      if (!(error instanceof StaleGenerationError)) this.recordFailure("interaction_expiry", error);
    } finally {
      if (this.#pendingInteractions.get(id) === pending) this.#pendingInteractions.delete(id);
      clearPendingInteractionExpiry(pending);
      pending.resolve({ kind: "cancelled" });
      this.refreshRunSilenceWatchdog(pending.sessionId);
    }
  }

  private async finishSettledSession(
    sessionId: string,
    outcome: "completed" | "aborted" | "failed",
    settledRunId?: string
  ): Promise<void> {
    this.clearRunSilenceWatchdog(sessionId);
    if (this.isReviewReadOnlySession(sessionId)) {
      await this.finishReviewSettledSession(sessionId, outcome, settledRunId);
      this.settleReviewRuntime(sessionId, this.reviewRuntimeOutcome(sessionId, outcome));
      return;
    }
    await this.synchronizeNativeHistory(sessionId)
      .catch((error: unknown) => this.recordFailure("native_history_settled_sync", error));
    const terminalUsageObserved = await this.refreshRuntimeUsage(sessionId, true, settledRunId)
      .catch((error: unknown) => {
        this.recordFailure("runtime_usage_settled_sync", error);
        return false;
      });
    const active = this.#active.get(sessionId);
    if (active !== undefined) {
      await this.refreshRuntimeCommands(sessionId, active)
        .catch((error: unknown) => this.recordFailure("runtime_commands_settled_sync", error));
    }
    const runs = listAllRuns(this.#store, { sessionId, activeOnly: true })
      .filter((run) => run.descriptor.state !== "queued" && run.descriptor.state !== "dispatch_unknown")
      .filter((run) => settledRunId === undefined || run.descriptor.id === settledRunId);
    const runtimeRecoveryFailures: Array<{ readonly runId: string; readonly error: PublicError }> = [];
    for (const run of runs) {
      const state = outcome === "completed" ? "completed" : outcome === "aborted" ? "aborted" : "failed";
      const error: PublicError | undefined = state === "failed"
        ? this.#terminalRunError(sessionId, run.descriptor.id) ?? {
            code: "BACKEND_RUN_FAILED",
            message: "The Backend reported a terminal run failure.",
            phase: "stream",
            retryable: true,
            stateMayHaveChanged: true,
            recovery: "Inspect the task timeline before explicitly retrying."
          }
        : undefined;
      const scheduleAttention = run.descriptor.source === "schedule"
        ? this.#scheduleRunNotifications?.settle(run.descriptor.id, state)
        : undefined;
      this.#store.updateRunState({
        runId: run.descriptor.id,
        state,
        ...(error === undefined ? {} : { error }),
        ...(scheduleAttention?.suppressAttention === true ? { suppressTerminalAttention: true } : {}),
        ...(scheduleAttention?.markHistoryRead === true ? { markScheduleRunRead: true } : {}),
        traceId: `settled:${run.descriptor.id}`
      });
      if (run.descriptor.source === "schedule") {
        this.#store.finalizeScheduleRunUsage(
          run.descriptor.id,
          settledRunId === run.descriptor.id && terminalUsageObserved
        );
      }
      if (run.descriptor.activeAttemptId !== undefined) this.#store.finishAttempt(run.descriptor.activeAttemptId, error);
      for (const item of listAllQueueItems(this.#store, { sessionId, states: ["backend_accepted"] })
        .filter((item) => item.runId === run.descriptor.id)) {
        this.#store.updateQueueState({ queueItemId: item.id, state: state === "completed" ? "completed" : state === "aborted" ? "cancelled" : "failed", ...(error === undefined ? {} : { error }), traceId: `settled:${item.id}` });
      }
      removeNativeDispatchRecoveryEntry(this.#store, sessionId, run.descriptor.id);
      await this.restoreTurnOverrideLease(run.descriptor.id);
      if (this.#workspaceCapture !== undefined) {
        const session = this.#store.getSession(sessionId);
        const target = this.targetForSession(session);
        await this.#workspaceCapture.captureAfterRun({ sessionId, runId: run.descriptor.id, target })
          .catch((captureError: unknown) => this.recordFailure("workspace-change-set", captureError));
      }
      if (error !== undefined) runtimeRecoveryFailures.push({ runId: run.descriptor.id, error });
      else if (this.#sessionRuntimeRecoveries.get(sessionId)?.currentRunId === run.descriptor.id) {
        this.#clearSessionRuntimeRecovery(sessionId, "succeeded");
      }
    }
    if (outcome === "failed") this.ensureContextOverflowReplay(sessionId);
    await this.#applyPendingSessionRuntimeControl(sessionId);
    for (const failure of runtimeRecoveryFailures) {
      this.#scheduleSessionRuntimeRecovery(sessionId, failure.runId, failure.error);
    }
    this.refreshRunSilenceWatchdog(sessionId);
    void this.reconcileScheduledWorktrees();
    void this.drain(sessionId);
  }

  /** Minimal queue bookkeeping for Review. No history, usage, resource, command, or workspace projection is allowed. */
  private async finishReviewSettledSession(
    sessionId: string,
    outcome: "completed" | "aborted" | "failed",
    settledRunId?: string
  ): Promise<void> {
    this.clearRunSilenceWatchdog(sessionId);
    const runs = listAllRuns(this.#store, { sessionId, activeOnly: true })
      .filter((run) => run.descriptor.state !== "queued" && run.descriptor.state !== "dispatch_unknown")
      .filter((run) => settledRunId === undefined || run.descriptor.id === settledRunId);
    for (const run of runs) {
      const state = outcome === "completed" ? "completed" : outcome === "aborted" ? "aborted" : "failed";
      const error: PublicError | undefined = state === "failed" ? {
        code: "BACKEND_RUN_FAILED",
        message: "The reviewer Backend reported a terminal failure.",
        phase: "stream",
        retryable: false,
        stateMayHaveChanged: false,
        recovery: "Start a new review after checking provider availability."
      } : undefined;
      this.#store.updateRunState({
        runId: run.descriptor.id,
        state,
        ...(error === undefined ? {} : { error }),
        traceId: `review-settled:${run.descriptor.id}`
      });
      if (run.descriptor.activeAttemptId !== undefined) this.#store.finishAttempt(run.descriptor.activeAttemptId, error);
      for (const item of listAllQueueItems(this.#store, { sessionId, states: ["backend_accepted"] })
        .filter((item) => item.runId === run.descriptor.id)) {
        this.#store.updateQueueState({
          queueItemId: item.id,
          state: state === "completed" ? "completed" : state === "aborted" ? "cancelled" : "failed",
          ...(error === undefined ? {} : { error }),
          traceId: `review-settled:${item.id}`
        });
      }
      await this.restoreTurnOverrideLease(run.descriptor.id);
    }
    this.refreshRunSilenceWatchdog(sessionId);
  }

  private async refreshRuntimeUsage(
    sessionId: string,
    emitEvent: boolean,
    scheduleRunId?: string
  ): Promise<boolean> {
    const active = this.#active.get(sessionId);
    if (active === undefined) return false;
    const state = await this.refreshNativeStateObservation(sessionId, active);
    return this.persistRuntimeUsage(
      sessionId,
      state.binding.generation,
      state.usage,
      emitEvent,
      state.providerId,
      state.modelId,
      scheduleRunId
    );
  }

  private persistRuntimeUsage(
    sessionId: string,
    generation: number,
    usage: UsageSnapshot | undefined,
    emitEvent: boolean,
    observedProviderId?: string,
    observedModelId?: string,
    scheduleRunId?: string
  ): boolean {
    if (usage === undefined) return false;
    this.#store.transaction((store) => {
      const session = store.getSession(sessionId);
      if (session.descriptor.binding.generation !== generation) {
        throw new StaleGenerationError(session.descriptor.binding.generation, generation);
      }
      const existing = store.findSetting<unknown>("session", sessionId, SESSION_RUNTIME_STATE_SETTING_KEY)?.value;
      const previous = materializedSessionRuntimeState(existing);
      const at = Date.now();
      this.recordUsageObservation(
        store,
        session,
        generation,
        usage,
        at,
        SESSION_RUNTIME_USAGE_SOURCE_ID,
        observedProviderId,
        observedModelId,
        false,
        scheduleRunUsageTarget(store, [scheduleRunId], "direct")
      );
      if (sameUsageSnapshot(previous?.usage, usage)) return;
      store.setSetting(
        "session",
        sessionId,
        SESSION_RUNTIME_STATE_SETTING_KEY,
        mergeMaterializedSessionRuntimeState(existing, { usage }, at),
        at
      );
      if (emitEvent) {
        store.appendEvent({
          backendId: session.descriptor.backendId,
          targetId: session.descriptor.targetId,
          sessionId,
          generation,
          emittedAt: at,
          traceId: `runtime-usage:${sessionId}:${generation}:${at}`,
          payload: usage.contextTokens === undefined || usage.contextWindow === undefined
            ? { type: "context_cleared" }
            : { type: "usage", usage },
          metadata: { namespace: "joko.runtime_usage", fields: { cumulative: true } }
        });
      }
    });
    return true;
  }

  private recordUsageObservation(
    store: OperationalStore,
    session: StoredSession,
    generation: number,
    usage: UsageSnapshot,
    measuredAt: number,
    sourceId: string,
    observedProviderId?: string,
    observedModelId?: string,
    provesProviderAvailable = false,
    scheduleUsage?: { readonly runId: string; readonly attribution: "exact" | "direct" }
  ): ReturnType<OperationalStore["recordUsageObservation"]> {
    const providerId = observedProviderId ?? session.descriptor.providerId ?? "";
    const modelId = observedModelId ?? session.descriptor.modelId ?? "";
    const usageMoneyKind = this.#usageMoneyKind(session.descriptor.backendId, providerId);
    if (provesProviderAvailable) {
      clearProviderRateLimit(store, session.descriptor.backendId, providerId);
    }
    const backend = store.getBackend(session.descriptor.backendId).descriptor;
    const model = backend.models.find((candidate) =>
      candidate.providerId === providerId && candidate.modelId === modelId
    );
    const priceOverride = providerId === "" || modelId === ""
      ? undefined
      : store.findModelPriceOverride(this.#usageOwnerId, session.descriptor.backendId, providerId, modelId);
    const reportedCostMicros = usage.cost > 0
      ? Math.round(usage.cost * 1_000_000)
      : undefined;
    const costRates = priceOverride === undefined
      ? model === undefined ? undefined : {
          inputMicrosPerMillion: modelCostMicros(model.cost.input),
          outputMicrosPerMillion: modelCostMicros(model.cost.output),
          cacheReadMicrosPerMillion: modelCostMicros(model.cost.cacheRead),
          cacheWriteMicrosPerMillion: modelCostMicros(model.cost.cacheWrite)
        }
      : {
          inputMicrosPerMillion: priceOverride.inputCostMicrosPerMillion,
          outputMicrosPerMillion: priceOverride.outputCostMicrosPerMillion,
          ...(priceOverride.cacheReadCostMicrosPerMillion === undefined
            ? {}
            : { cacheReadMicrosPerMillion: priceOverride.cacheReadCostMicrosPerMillion }),
          ...(priceOverride.cacheWriteCostMicrosPerMillion === undefined
            ? {}
            : { cacheWriteMicrosPerMillion: priceOverride.cacheWriteCostMicrosPerMillion })
        };
    const currencyCode = reportedCostMicros === undefined
      ? priceOverride?.currencyCode ?? "USD"
      : "USD";
    const result = store.recordUsageObservation({
      ownerId: this.#usageOwnerId,
      sessionId: session.descriptor.id,
      sourceId,
      generation,
      backendId: session.descriptor.backendId,
      providerId,
      modelId,
      measuredAt,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      totalTokens: usage.totalTokens,
      ...(reportedCostMicros === undefined ? {} : { reportedCostMicros }),
      ...(reportedCostMicros === undefined || usageMoneyKind === "actual-cost"
        ? {}
        : { reportedCostEstimated: true }),
      ...(costRates === undefined ? {} : { costRates }),
      currencyCode
    });
    if (scheduleUsage !== undefined && result.changed) {
      const valueEstimate = usageMoneyKind !== "actual-cost";
      const approximate = valueEstimate || result.estimated;
      const estimateReasons = valueEstimate || result.estimated
        ? usageMoneyKind === "subscription-value"
          ? (result.costComplete
              ? ["subscription-value", "reference-price"] as const
              : ["subscription-value", "reference-price", "partial-pricing"] as const)
          : (result.costComplete
              ? ["reference-price"] as const
              : ["reference-price", "partial-pricing"] as const)
        : [];
      store.recordScheduleRunUsage({
        runId: scheduleUsage.runId,
        actualCostMicros: valueEstimate ? 0 : result.costMicros,
        estimatedValueMicros: valueEstimate ? result.costMicros : 0,
        currencyCode,
        approximate,
        attribution: scheduleUsage.attribution,
        costComplete: result.costComplete,
        ...(estimateReasons.length === 0 ? {} : { estimateReasons })
      });
    }
    return result;
  }

  /**
   * Serialize exact native observations per product Session. A response is
   * committed only while both the active runtime identity and binding
   * generation still match the request that produced it.
   */
  private refreshNativeStateObservation(
    sessionId: string,
    active: ActiveSession,
    allowance: BackendSideEffectAdmissionAllowance = {}
  ): Promise<NativeSessionState> {
    let lease: ActiveBackendSideEffectLease;
    try {
      lease = this.beginActiveBackendSideEffect(sessionId, active, undefined, allowance);
    } catch (error) {
      return Promise.reject(error);
    }
    const previous = this.#nativeStateTails.get(sessionId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      this.assertActiveBackendSideEffectLease(lease);
      const state = await this.refreshNativeStateObservationOnce(sessionId, active);
      this.assertActiveBackendSideEffectLease(lease);
      return state;
    }).finally(() => lease.release());
    const tail = operation.then(() => undefined, () => undefined);
    this.#nativeStateTails.set(sessionId, tail);
    void tail.then(() => {
      if (this.#nativeStateTails.get(sessionId) === tail) this.#nativeStateTails.delete(sessionId);
    });
    return operation;
  }

  private async refreshNativeStateObservationOnce(
    sessionId: string,
    active: ActiveSession
  ): Promise<NativeSessionState> {
    if (this.#disposed || this.#active.get(sessionId) !== active) {
      throw new Error("The native runtime changed before state observation.");
    }
    const stored = this.#store.getSession(sessionId);
    const generation = stored.descriptor.binding.generation;
    const compactionEventEpoch = this.#compactionEventEpochs.get(sessionId) ?? 0;
    let state: NativeSessionState;
    try {
      state = await active.adapter.inspectSession(stored.descriptor.binding, this.contextFor(stored));
    } catch (error) {
      this.markNativeStateObservationStale(sessionId, active, generation);
      throw error;
    }

    try {
      const observation = nativeStateObservation(state);
      const committed = this.#store.transaction((store) => {
        const current = store.getSession(sessionId);
        if (
          this.#disposed ||
          this.#active.get(sessionId) !== active ||
          current.descriptor.binding.generation !== generation ||
          state.binding.generation !== generation
        ) {
          throw new StaleGenerationError(current.descriptor.binding.generation, generation);
        }
        if (
          state.binding.opaqueRef !== current.descriptor.binding.opaqueRef ||
          state.binding.nativeSessionId !== current.descriptor.binding.nativeSessionId
        ) {
          throw new Error("The native state response belongs to a different binding.");
        }
        store.setSetting(
          "session",
          sessionId,
          SESSION_NATIVE_STATE_OBSERVATION_SETTING_KEY,
          observation,
          observation.observedAt
        );
        return state;
      });
      // The generation-fenced observation is exact live state. It closes the
      // small window before a compaction event reaches the translator, and it
      // can also release a fence if a terminal event was lost during shutdown.
      if ((this.#compactionEventEpochs.get(sessionId) ?? 0) === compactionEventEpoch) {
        this.observeNativeCompaction(sessionId, generation, committed.compacting, true);
      }
      return committed;
    } catch (error) {
      this.markNativeStateObservationStale(sessionId, active, generation);
      throw error;
    }
  }

  private async refreshNativeStateBestEffort(
    sessionId: string,
    active: ActiveSession,
    component: string,
    allowance: BackendSideEffectAdmissionAllowance = {}
  ): Promise<void> {
    await this.refreshNativeStateObservation(sessionId, active, allowance)
      .then((state) => this.persistRuntimeUsage(sessionId, state.binding.generation, state.usage, false, state.providerId, state.modelId))
      .catch((error: unknown) => this.recordFailure(component, error));
  }

  private markNativeStateObservationStale(
    sessionId: string,
    active: ActiveSession,
    expectedGeneration?: number
  ): void {
    const staleAt = Date.now();
    this.#store.transaction((store) => {
      const current = store.getSession(sessionId);
      const generation = expectedGeneration ?? current.descriptor.binding.generation;
      if (
        this.#disposed ||
        this.#active.get(sessionId) !== active ||
        current.descriptor.binding.generation !== generation
      ) return;
      const existing = materializedNativeStateObservation(store.findSetting(
        "session",
        sessionId,
        SESSION_NATIVE_STATE_OBSERVATION_SETTING_KEY
      )?.value);
      if (
        existing === undefined ||
        existing.generation !== generation ||
        existing.bindingFingerprint !== nativeBindingFingerprint(current.descriptor.binding.opaqueRef) ||
        existing.staleAt !== undefined
      ) return;
      store.setSetting(
        "session",
        sessionId,
        SESSION_NATIVE_STATE_OBSERVATION_SETTING_KEY,
        staleNativeStateObservation(existing, Math.max(staleAt, existing.observedAt)),
        staleAt
      );
    });
  }

  /**
   * Serialize observations per product Session so a slower response cannot
   * commit after a newer response from the same runtime generation.
   */
  private refreshRuntimeCommands(
    sessionId: string,
    active: ActiveSession,
    allowance: BackendSideEffectAdmissionAllowance = {}
  ): Promise<readonly RuntimeCommand[]> {
    let lease: ActiveBackendSideEffectLease;
    try {
      lease = this.beginActiveBackendSideEffect(sessionId, active, undefined, allowance);
    } catch (error) {
      return Promise.reject(error);
    }
    const previous = this.#runtimeCommandTails.get(sessionId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      try {
        this.assertActiveBackendSideEffectLease(lease);
        const commands = await this.refreshRuntimeCommandsOnce(sessionId, active);
        this.assertActiveBackendSideEffectLease(lease);
        return commands;
      } catch (error) {
        if (
          error instanceof StaleGenerationError
          || (error instanceof JokoError && error.publicError.code === "BACKEND_INSTANCE_STALE")
        ) return this.readDurableRuntimeCommands(sessionId);
        throw error;
      }
    }).finally(() => lease.release());
    const tail = operation.then(() => undefined, () => undefined);
    this.#runtimeCommandTails.set(sessionId, tail);
    void tail.then(() => {
      if (this.#runtimeCommandTails.get(sessionId) === tail) {
        this.#runtimeCommandTails.delete(sessionId);
      }
    });
    return operation;
  }

  private async refreshRuntimeCommandsOnce(
    sessionId: string,
    active: ActiveSession
  ): Promise<readonly RuntimeCommand[]> {
    if (this.#disposed || this.#active.get(sessionId) !== active) {
      return this.readDurableRuntimeCommands(sessionId);
    }
    const stored = this.#store.getSession(sessionId);
    const generation = stored.descriptor.binding.generation;
    const commands = normalizeRuntimeCommands(
      await active.adapter.getCommands(this.contextFor(stored))
    );
    const observedAt = Date.now();

    return this.#store.transaction((store) => {
      const current = store.getSession(sessionId);
      const existing = materializedRuntimeCommands(store.findSetting(
        "session",
        sessionId,
        SESSION_RUNTIME_COMMANDS_SETTING_KEY
      )?.value);
      if (
        this.#disposed ||
        this.#active.get(sessionId) !== active ||
        current.descriptor.binding.generation !== generation
      ) {
        return existing?.commands ?? [];
      }

      const changed = existing === undefined || !sameRuntimeCommands(existing.commands, commands);
      if (!changed && existing.generation === generation) return existing.commands;

      const observation = runtimeCommandsObservation(generation, commands, observedAt);
      // The setting and event share one SQLite transaction. Store publication
      // happens only after both writes commit, so reconnect snapshots and the
      // event stream can never observe different catalogs for this revision.
      store.setSetting(
        "session",
        sessionId,
        SESSION_RUNTIME_COMMANDS_SETTING_KEY,
        observation,
        observedAt
      );
      if (changed) {
        store.appendEvent({
          backendId: current.descriptor.backendId,
          targetId: current.descriptor.targetId,
          sessionId,
          generation,
          emittedAt: observedAt,
          traceId: `runtime-commands:${sessionId}:${generation}:${observedAt}`,
          payload: { type: "runtime_commands_changed", commands: observation.commands }
        });
      }
      return observation.commands;
    });
  }

  private readDurableRuntimeCommands(sessionId: string): readonly RuntimeCommand[] {
    return materializedRuntimeCommands(this.#store.findSetting(
      "session",
      sessionId,
      SESSION_RUNTIME_COMMANDS_SETTING_KEY
    )?.value)?.commands ?? [];
  }

  private synchronizeNativeHistory(
    sessionId: string,
    allowance: BackendSideEffectAdmissionAllowance = {}
  ): Promise<void> {
    const active = this.#active.get(sessionId);
    if (active?.adapter.getNativeHistoryProjection === undefined) return Promise.resolve();
    let lease: ActiveBackendSideEffectLease;
    try {
      lease = this.beginActiveBackendSideEffect(sessionId, active, undefined, allowance);
    } catch (error) {
      return Promise.reject(error);
    }
    const previous = this.#nativeHistoryTails.get(sessionId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      if (this.#disposed) return;
      this.assertActiveBackendSideEffectLease(lease);
      const stored = lease.stored;
      const history = await active.adapter.getNativeHistoryProjection!(lease.context);
      this.assertActiveBackendSideEffectLease(lease);
      const current = this.#store.getSession(sessionId);
      if (current.descriptor.binding.generation !== stored.descriptor.binding.generation) {
        throw new StaleGenerationError(current.descriptor.binding.generation, stored.descriptor.binding.generation);
      }
      const candidateJournal = nativeDispatchRecoveryJournal(this.#store.findSetting(
        "session",
        sessionId,
        SESSION_NATIVE_DISPATCH_RECOVERY_SETTING_KEY
      )?.value);
      const candidateBaseline = candidateJournal?.entries.find((entry) =>
        this.#store.findRun(entry.runId)?.descriptor.state === "dispatch_unknown");
      const candidateRecovery = candidateBaseline === undefined
        ? undefined
        : nativeDispatchRecoveryIsCompleted(this.#store, current.descriptor, candidateBaseline, history);
      const candidateRun = candidateRecovery === undefined
        ? undefined
        : this.#store.getRun(candidateRecovery.baseline.runId);
      const scheduleAttention = candidateRun?.descriptor.source === "schedule"
        ? this.#scheduleRunNotifications?.settle(
            candidateRun.descriptor.id,
            candidateRecovery!.outcome === "completed"
              ? "completed"
              : candidateRecovery!.outcome === "aborted" ? "aborted" : "failed"
          )
        : undefined;
      const recovered = this.#store.transaction((store) => {
        const journal = nativeDispatchRecoveryJournal(store.findSetting(
          "session",
          sessionId,
          SESSION_NATIVE_DISPATCH_RECOVERY_SETTING_KEY
        )?.value);
        const baseline = journal?.entries.find((entry) =>
          store.findRun(entry.runId)?.descriptor.state === "dispatch_unknown");
        const recovered = baseline === undefined
          ? undefined
          : nativeDispatchRecoveryIsCompleted(store, current.descriptor, baseline, history);
        this.appendNativeHistory(
          store,
          current.descriptor,
          history,
          recovered?.baseline.operationId,
          recovered === undefined ? undefined : {
            runId: recovered.baseline.runId,
            nativeEntryIds: recovered.nativeEntryIds
          }
        );
        if (recovered === undefined) return undefined;
        const state = recovered.outcome === "completed"
          ? "completed"
          : recovered.outcome === "aborted" ? "aborted" : "failed";
        const error: PublicError | undefined = state === "failed" ? {
          code: "BACKEND_RUN_FAILED",
          message: "The Backend reported a terminal run failure before service recovery.",
          phase: "stream",
          retryable: true,
          stateMayHaveChanged: true,
          recovery: "Inspect the recovered task timeline before explicitly retrying."
        } : undefined;
        const recoveryAttempt = store.getAttempt(recovered.baseline.attemptId);
        if (
          recoveryAttempt.descriptor.runId !== recovered.baseline.runId
          || recoveryAttempt.descriptor.backendInstanceGeneration !== recovered.baseline.backendInstanceGeneration
        ) throw new StoreError("Native recovery no longer owns the exact dispatched Attempt.");
        const recoveryAttemptId = stableId(
          "attempt",
          `${recovered.baseline.operationId}:native-recovery:generation:${current.descriptor.binding.generation}`
        );
        if (!store.listAttempts(recovered.baseline.runId).some((attempt) => attempt.descriptor.id === recoveryAttemptId)) {
          store.createAttempt({
            id: recoveryAttemptId,
            runId: recovered.baseline.runId,
            ordinal: store.listAttempts(recovered.baseline.runId)
              .reduce((highest, attempt) => Math.max(highest, attempt.descriptor.ordinal), 0) + 1,
            generation: current.descriptor.binding.generation,
            backendInstanceGeneration: recovered.baseline.backendInstanceGeneration,
            startedAt: Date.now()
          });
        }
        store.updateRunState({
          runId: recovered.baseline.runId,
          state,
          activeAttemptId: recoveryAttemptId,
          ...(error === undefined ? {} : { error }),
          ...(scheduleAttention?.suppressAttention === true ? { suppressTerminalAttention: true } : {}),
          ...(scheduleAttention?.markHistoryRead === true ? { markScheduleRunRead: true } : {}),
          traceId: `native-recovery:${recovered.baseline.runId}:${state}`,
          operationId: recovered.baseline.operationId
        });
        store.finishAttempt(recovered.baseline.attemptId, error);
        store.finishAttempt(recoveryAttemptId, error);
        store.updateQueueState({
          queueItemId: recovered.baseline.queueItemId,
          state: state === "completed" ? "completed" : state === "aborted" ? "cancelled" : "failed",
          attemptId: recovered.baseline.attemptId,
          projectionAttemptId: recoveryAttemptId,
          ...(error === undefined ? {} : { error }),
          traceId: `native-recovery:${recovered.baseline.queueItemId}:${state}`
        });
        removeNativeDispatchRecoveryEntry(store, sessionId, recovered.baseline.runId);
        return recovered;
      });
      if (recovered !== undefined) {
        const recoveredRunId = recovered.baseline.runId;
        this.clearRunSilenceWatchdog(sessionId);
        await this.restoreTurnOverrideLease(recoveredRunId);
        if (this.#workspaceCapture !== undefined) {
          const recoveredSession = this.#store.getSession(sessionId);
          await this.#workspaceCapture.captureAfterRun({
            sessionId,
            runId: recoveredRunId,
            target: this.targetForSession(recoveredSession)
          }).catch((error: unknown) => this.recordFailure("workspace-change-set", error));
        }
        if (recovered.outcome === "failed") this.ensureContextOverflowReplay(sessionId);
        this.refreshRunSilenceWatchdog(sessionId);
        void this.reconcileScheduledWorktrees();
        void this.drain(sessionId);
      }
    }).finally(() => lease.release());
    const tail = operation.then(() => undefined, () => undefined);
    this.#nativeHistoryTails.set(sessionId, tail);
    void tail.then(() => {
      if (this.#nativeHistoryTails.get(sessionId) === tail) this.#nativeHistoryTails.delete(sessionId);
    });
    return operation;
  }

  private appendNativeHistory(
    store: OperationalStore,
    session: SessionDescriptor,
    history: NativeHistoryProjection,
    operationId?: string,
    recoveryOwnership?: {
      readonly runId: string;
      readonly nativeEntryIds: ReadonlySet<string>;
    }
  ): void {
    type AcceptedUserMetadata = {
      readonly quotesEncoded: boolean;
      readonly pastedTextRanges: Extract<EventPayload, { readonly type: "message_complete" }>["pastedTextRanges"];
      readonly automationOrigin: Extract<EventPayload, { readonly type: "message_complete" }>["automationOrigin"];
      readonly inputDelivery: Extract<EventPayload, { readonly type: "message_complete" }>["inputDelivery"];
      readonly automaticContinuation: Extract<EventPayload, { readonly type: "message_complete" }>["automaticContinuation"];
    };
    const acceptedUserMetadata = new Map<string, AcceptedUserMetadata>();
    const unmatchedAcceptedUserMetadata = new Map<string, AcceptedUserMetadata[]>();
    const hydratedUserEntryIdsBySignature = new Map<string, Set<string>>();
    const knownEventIds = new Set<string>();
    const importedMessageCounts = new Map<string, number>();
    const bindingFingerprint = nativeBindingFingerprint(session.binding.opaqueRef);
    visitSessionEventsIncludingTombstones(store, session.id, (event) => {
      knownEventIds.add(event.id);
      if (
        event.generation !== session.binding.generation
        || event.payload.type !== "message_complete"
        || event.payload.role !== "user"
        || event.metadata?.fields[NATIVE_HISTORY_BINDING_FINGERPRINT_FIELD] !== bindingFingerprint
      ) return;
      const entryId = nativeHistoryEventContext(event.payload)?.identity?.entryId;
      if (entryId === undefined) return;
      const signature = nativeHistoryMessageSignature(event.payload);
      const entries = hydratedUserEntryIdsBySignature.get(signature) ?? new Set<string>();
      entries.add(entryId);
      hydratedUserEntryIdsBySignature.set(signature, entries);
    });
    visitVisibleSessionEvents(store, session.id, (event) => {
      if (
        event.payload.type === "message_complete"
        && event.payload.role === "user"
        && (event.payload.quotesEncoded === true
          || event.payload.pastedTextRanges !== undefined
          || event.payload.automationOrigin !== undefined
          || event.payload.inputDelivery !== undefined
          || event.payload.automaticContinuation !== undefined)
      ) {
        const metadata: AcceptedUserMetadata = {
          quotesEncoded: event.payload.quotesEncoded === true,
          pastedTextRanges: event.payload.pastedTextRanges,
          automationOrigin: event.payload.automationOrigin,
          inputDelivery: event.payload.inputDelivery,
          automaticContinuation: event.payload.automaticContinuation
        };
        const entryId = nativeHistoryEventContext(event.payload)?.identity?.entryId;
        const eventBindingFingerprint = event.metadata?.fields[NATIVE_HISTORY_BINDING_FINGERPRINT_FIELD];
        if (entryId !== undefined && eventBindingFingerprint === bindingFingerprint) {
          acceptedUserMetadata.set(entryId, metadata);
        } else if (entryId === undefined && event.runId !== undefined && event.generation === session.binding.generation) {
          const signature = nativeHistoryMessageSignature(event.payload);
          const matches = unmatchedAcceptedUserMetadata.get(signature) ?? [];
          matches.push(metadata);
          unmatchedAcceptedUserMetadata.set(signature, matches);
        }
      }
      if (event.metadata?.namespace === "joko.portable_import" && event.payload.type === "message_complete") {
        const signature = portableMessageSignature(event.payload);
        importedMessageCounts.set(signature, (importedMessageCounts.get(signature) ?? 0) + 1);
      }
    });
    for (const [signature, entryIds] of hydratedUserEntryIdsBySignature) {
      const matches = unmatchedAcceptedUserMetadata.get(signature);
      if (matches === undefined) continue;
      if (matches.length <= entryIds.size) unmatchedAcceptedUserMetadata.delete(signature);
      else unmatchedAcceptedUserMetadata.set(signature, matches.slice(entryIds.size));
    }
    const projections = projectNativeHistory(session.id, session.binding.opaqueRef, history);
    const newProjectionCounts = new Map<string, number>();
    for (const projection of projections) {
      if (
        knownEventIds.has(projection.id)
        || projection.payload.type !== "message_complete"
        || projection.payload.role !== "user"
      ) continue;
      const entryId = nativeHistoryEventContext(projection.payload)?.identity?.entryId;
      if (entryId !== undefined && acceptedUserMetadata.has(entryId)) continue;
      const signature = nativeHistoryMessageSignature(projection.payload);
      newProjectionCounts.set(signature, (newProjectionCounts.get(signature) ?? 0) + 1);
    }
    const eligibleFallbackSignatures = new Set<string>();
    for (const [signature, count] of newProjectionCounts) {
      if (unmatchedAcceptedUserMetadata.get(signature)?.length === count) {
        eligibleFallbackSignatures.add(signature);
      }
    }
    for (const projection of projections) {
      const projectionEntryId = nativeHistoryEventContext(projection.payload)?.identity?.entryId;
      const recoveredProjection = recoveryOwnership !== undefined && projectionEntryId !== undefined &&
        recoveryOwnership.nativeEntryIds.has(projectionEntryId);
      let acceptedMetadata = projection.payload.type === "message_complete"
        && projection.payload.role === "user"
        && nativeHistoryEventContext(projection.payload)?.identity?.entryId !== undefined
        ? acceptedUserMetadata.get(nativeHistoryEventContext(projection.payload)!.identity!.entryId)
        : undefined;
      if (
        acceptedMetadata === undefined
        && !knownEventIds.has(projection.id)
        && projection.payload.type === "message_complete"
        && projection.payload.role === "user"
      ) {
        const signature = nativeHistoryMessageSignature(projection.payload);
        const matches = unmatchedAcceptedUserMetadata.get(signature);
        if (eligibleFallbackSignatures.has(signature)) {
          acceptedMetadata = matches?.shift();
          if (matches?.length === 0) unmatchedAcceptedUserMetadata.delete(signature);
        }
      }
      const payload = acceptedMetadata === undefined
        ? projection.payload
        : {
            ...projection.payload,
            ...(acceptedMetadata.quotesEncoded ? { quotesEncoded: true as const } : {}),
            ...(acceptedMetadata.pastedTextRanges === undefined
              ? {}
              : { pastedTextRanges: acceptedMetadata.pastedTextRanges }),
            ...(acceptedMetadata.automationOrigin === undefined ? {} : { automationOrigin: acceptedMetadata.automationOrigin }),
            ...(acceptedMetadata.inputDelivery === undefined ? {} : { inputDelivery: acceptedMetadata.inputDelivery }),
            ...(acceptedMetadata.automaticContinuation === undefined
              ? {}
              : { automaticContinuation: acceptedMetadata.automaticContinuation })
          };
      if (payload.type === "message_complete") {
        const signature = portableMessageSignature(payload);
        const remaining = importedMessageCounts.get(signature) ?? 0;
        if (remaining > 0) {
          if (remaining === 1) importedMessageCounts.delete(signature);
          else importedMessageCounts.set(signature, remaining - 1);
          continue;
        }
      }
      store.appendEventIfAbsent({
        id: projection.id,
        ...(projection.emittedAt === undefined ? {} : { emittedAt: projection.emittedAt }),
        backendId: session.backendId,
        targetId: session.targetId,
        sessionId: session.id,
        ...(operationId === undefined || (recoveryOwnership !== undefined && !recoveredProjection)
          ? {}
          : { operationId }),
        ...(recoveredProjection ? { runId: recoveryOwnership.runId } : {}),
        generation: session.binding.generation,
        traceId: `native-history:${projection.id}`,
        payload,
        pi: projection.pi,
        metadata: projection.metadata
      });
    }

    const runtimeState = store.findSetting<unknown>("session", session.id, SESSION_RUNTIME_STATE_SETTING_KEY)?.value;
    if (materializedSessionRuntimeState(runtimeState)?.activeNativeEntryId !== history.activeEntryId) {
      store.setSetting(
        "session",
        session.id,
        SESSION_RUNTIME_STATE_SETTING_KEY,
        mergeMaterializedSessionRuntimeState(runtimeState, {
          activeNativeEntryId: history.activeEntryId ?? null
        })
      );
    }

    const previous = store.findLatestNativeSessionChange(session.id);
    const previousPayload = previous?.payload.type === "native_session_changed" ? previous.payload : undefined;
    const sameLeaf = previousPayload !== undefined &&
      previousPayload.opaqueRef === session.binding.opaqueRef &&
      previousPayload.nativeSessionId === session.binding.nativeSessionId &&
      previousPayload.leafId === history.activeEntryId;
    if (sameLeaf) return;
    const leafToken = history.activeEntryId ?? "<none>";
    const markerDigest = createHash("sha256")
      .update(session.id).update("\0")
      .update(session.binding.opaqueRef).update("\0")
      .update(previous?.id ?? "<root>").update("\0")
      .update(leafToken)
      .digest("hex");
    const markerId = `native-leaf-${markerDigest}`;
    const activeEntryMetadata = history.activeEntryMetadata;
    store.appendEventIfAbsent({
      id: markerId,
      backendId: session.backendId,
      targetId: session.targetId,
      sessionId: session.id,
      ...(operationId === undefined ? {} : { operationId }),
      generation: session.binding.generation,
      traceId: `native-history:${markerId}`,
      payload: {
        type: "native_session_changed",
        opaqueRef: session.binding.opaqueRef,
        ...(session.binding.nativeSessionId === undefined ? {} : { nativeSessionId: session.binding.nativeSessionId }),
        ...(history.activeEntryId === undefined ? {} : { leafId: history.activeEntryId })
      },
      ...(activeEntryMetadata?.pi === undefined ? {} : { pi: activeEntryMetadata.pi }),
      ...(activeEntryMetadata === undefined
        ? {}
        : { metadata: { namespace: activeEntryMetadata.namespace, fields: activeEntryMetadata.fields } })
    });
  }

  private withAcceptedInputMetadata(
    payload: EventPayload,
    sessionId: string,
    runId?: string
  ): EventPayload {
    if (payload.type !== "message_complete" || payload.role !== "user" || runId === undefined) return payload;
    const queued = this.#store.findQueueItemByRunId(sessionId, runId);
    if (queued === undefined) return payload;
    const operation = this.#store.findOperation(queued.operationId);
    const operationBody = operation?.kind === "schedule_dispatch" && isRecord(operation.body)
      ? operation.body
      : undefined;
    const scheduleId = operationBody?.["scheduleId"];
    const scheduleName = operationBody?.["scheduleName"];
    const automationOrigin: MessageAutomationOrigin | undefined = typeof scheduleId === "string" && scheduleId.trim().length > 0
      ? {
          kind: "scheduler",
          scheduleId,
          runId,
          ...(typeof scheduleName === "string" && scheduleName.trim().length > 0 ? { scheduleName } : {})
        }
      : undefined;
    const inputDelivery: MessageInputDelivery = automationOrigin === undefined ? queued.disposition : "scheduler";
    return {
      ...payload,
      ...(queued.body.quotesEncoded === true ? { quotesEncoded: true } : {}),
      ...(queued.body.pastedTextRanges === undefined ? {} : { pastedTextRanges: queued.body.pastedTextRanges }),
      ...(automationOrigin === undefined ? {} : { automationOrigin }),
      ...(queued.body.automaticContinuation === undefined
        ? {}
        : { automaticContinuation: { recoveryId: queued.body.automaticContinuation.recoveryId } }),
      inputDelivery
    };
  }

  private requireAdapter(id: string): BackendAdapter {
    const adapter = this.#adapters.get(id);
    if (adapter === undefined) throw new JokoError({
      code: "BACKEND_INSTANCE_UNAVAILABLE",
      message: "The selected Backend instance is unavailable on this service node.",
      phase: "provision",
      retryable: true,
      stateMayHaveChanged: false,
      recovery: "Refresh Backend status or select another available instance."
    });
    return adapter;
  }

  private requireAdapterGeneration(backendId: string, adapter: BackendAdapter): number {
    const generation = this.#adapterGenerations.get(backendId);
    if (this.#adapters.get(backendId) !== adapter || generation === undefined) {
      throw new StoreError("The selected Backend Adapter is not the current process-local instance.");
    }
    return generation;
  }

  private assertCurrentAdapterGeneration(
    backendId: string,
    adapter: BackendAdapter,
    generation: number
  ): void {
    if (
      this.#adapters.get(backendId) !== adapter
      || this.#adapterGenerations.get(backendId) !== generation
      || this.#store.getBackend(backendId).descriptor.instanceGeneration !== generation
    ) throw new StoreError("The Backend process instance changed while native activation was in progress.");
  }

  private activeSession(
    adapter: BackendAdapter,
    sessionId: string,
    backendInstanceGeneration: number
  ): ActiveSession {
    const session = this.#store.getSession(sessionId);
    if (session.descriptor.backendId !== adapter.id) {
      throw new StoreError("The active runtime Adapter does not own the product Session Backend.");
    }
    return {
      adapter,
      sessionId,
      backendInstanceGeneration,
      lastActivityAt: this.#monotonicNow()
    };
  }

  private backendInstanceGenerationOwnsContext(
    sessionId: string,
    expected: number,
    runId?: string,
    attemptId?: string
  ): boolean {
    try {
      const session = this.#store.getSession(sessionId);
      const backend = this.#store.getBackend(session.descriptor.backendId);
      if (backend.descriptor.instanceGeneration === expected) return true;
      if (runId === undefined || attemptId === undefined) return false;
      const item = this.#store.findQueueItemByRunId(sessionId, runId, { includeCleared: true });
      if (
        item === undefined || item.attemptId !== attemptId ||
        item.backendInstanceGeneration !== expected ||
        !["dispatching", "backend_accepted", "dispatch_unknown"].includes(item.state)
      ) return false;
      const attempt = this.#store.getAttempt(attemptId);
      return attempt.descriptor.runId === runId &&
        attempt.descriptor.backendInstanceGeneration === expected &&
        attempt.descriptor.endedAt === undefined;
    } catch {
      return false;
    }
  }

  private assertDispatchAdmissionOwner(
    admitted: QueueItemRecord,
    attemptId: string | undefined,
    active: ActiveSession,
    productGeneration: number
  ): void {
    const current = this.#store.getQueueItem(admitted.id);
    const session = this.#store.getSession(admitted.sessionId);
    const attempt = attemptId === undefined ? undefined : this.#store.getAttempt(attemptId);
    if (
      current.state !== "dispatching" ||
      attemptId === undefined ||
      current.attemptId !== attemptId ||
      current.runId !== admitted.runId ||
      current.backendInstanceGeneration === undefined ||
      current.backendInstanceGeneration !== admitted.backendInstanceGeneration ||
      active.sessionId !== admitted.sessionId ||
      active.backendInstanceGeneration !== current.backendInstanceGeneration ||
      session.descriptor.binding.generation !== productGeneration ||
      attempt?.descriptor.runId !== current.runId ||
      attempt.descriptor.generation !== productGeneration ||
      attempt.descriptor.backendInstanceGeneration !== current.backendInstanceGeneration ||
      attempt.descriptor.endedAt !== undefined
    ) {
      throw new JokoError({
        code: "DISPATCH_ADMISSION_STALE",
        message: "The durable Queue and Attempt admission changed before Backend dispatch.",
        phase: "dispatch",
        retryable: true,
        stateMayHaveChanged: false,
        recovery: "Retry after the current Backend instance and Session generation settle."
      });
    }
  }

  private assertUserShellAvailable(stored: StoredSession, adapter: BackendAdapter): void {
    const capability = this.#store.getBackend(stored.descriptor.backendId).descriptor.capabilities.get("runtime.user_shell");
    if (
      capability?.supported !== true ||
      adapter.executeUserShell === undefined ||
      adapter.abortUserShell === undefined
    ) throw userShellError(
      "USER_SHELL_UNSUPPORTED",
      "The selected Backend does not support the user shell capability.",
      "Select a Backend that advertises runtime.user_shell."
    );
  }

  private assertBackgroundTaskCancellationAvailable(stored: StoredSession, adapter: BackendAdapter): void {
    const capability = this.#store.getBackend(stored.descriptor.backendId).descriptor.capabilities
      .get("background.tasks.cancel");
    if (capability?.supported === true && adapter.cancelBackgroundTask !== undefined) return;
    throw backgroundTaskCancellationError(
      "BACKGROUND_TASK_CANCEL_UNSUPPORTED",
      "The selected Backend does not support stopping individual background tasks.",
      "Use a Backend that advertises background.tasks.cancel."
    );
  }

  private assertSubagentControlAvailable(
    stored: StoredSession,
    adapter: BackendAdapter,
    action: SubagentControlInput["action"]
  ): void {
    const capability = subagentControlCapability(action);
    const supported = this.#store.getBackend(stored.descriptor.backendId).descriptor.capabilities
      .get(capability)?.supported === true;
    if (supported && adapter.controlSubagent !== undefined) return;
    throw subagentControlError(
      "SUBAGENT_CONTROL_UNSUPPORTED",
      `The selected Backend does not support ${capability}.`,
      "Use a Backend and delegated run that advertise this control."
    );
  }

  private assertSubagentEventAvailable(backendId: string, payload: EventPayload): void {
    const required = payload.type === "subagent_run"
      ? ["subagents.list", "subagents.detail"]
      : payload.type === "subagent_transcript"
        ? ["subagents.transcript"]
        : [];
    if (required.length === 0) return;
    const capabilities = this.#store.getBackend(backendId).descriptor.capabilities;
    const unsupported = required.find((key) => capabilities.get(key)?.supported !== true);
    if (unsupported === undefined) return;
    throw new JokoError({
      code: "SUBAGENT_EVENT_UNSUPPORTED",
      message: `The selected Backend emitted delegated-run data without ${unsupported}.`,
      phase: "subagent_event",
      retryable: false,
      stateMayHaveChanged: false,
      recovery: "Refresh Backend capabilities before publishing delegated-run data."
    });
  }

  private assertReviewRuntimeEventAllowed(payload: EventPayload): void {
    switch (payload.type) {
      case "run_state":
      case "session_changed":
      case "text_delta":
      case "thinking_delta":
      case "message_complete":
      case "status":
      case "tool_start":
      case "tool_update":
      case "tool_result":
      case "queue_update":
      case "compaction":
      case "retry":
      case "usage":
      case "error":
      case "done":
        return;
      default:
        throw new JokoError({
          code: "REVIEW_RUNTIME_EVENT_DENIED",
          message: "Reviewer runtime emitted an event outside its immutable read-only lifecycle.",
          phase: "review_runtime_event",
          retryable: false,
          stateMayHaveChanged: false,
          recovery: "Close the Reviewer runtime and start a new isolated Review."
        });
    }
  }

  private requireDurableSubagentControl(
    stored: StoredSession,
    input: SubagentControlInput
  ): SubagentControlInput {
    const projection = this.#store.getSessionSubagentRun(stored.descriptor.id, input.runId);
    if (projection === undefined) throw subagentControlError(
      "SUBAGENT_NOT_FOUND",
      "The delegated run is not present in this task's durable history.",
      "Refresh delegated runs before retrying the action."
    );
    if (projection.event.generation !== stored.descriptor.binding.generation) {
      throw new StaleGenerationError(
        stored.descriptor.binding.generation,
        projection.event.generation
      );
    }
    const run = projection.run;
    const allowed = input.action === "stop"
      ? run.capabilities.stop
      : input.action === "steer"
        ? run.capabilities.steer
        : input.action === "follow_up"
          ? run.capabilities.followUp
          : run.capabilities.resume;
    if (!allowed) throw subagentControlError(
      "SUBAGENT_ACTION_UNAVAILABLE",
      "This delegated run does not advertise the requested control.",
      "Refresh the run detail and choose an available action."
    );
    const terminal = run.state === "completed" || run.state === "failed" || run.state === "stopped";
    const stateAllowed = input.action === "resume"
      ? terminal
      : input.action === "stop"
        ? !terminal
        : run.state === "running";
    if (!stateAllowed) throw subagentControlError(
      "SUBAGENT_STATE_CONFLICT",
      "The delegated run is not in a state that accepts this control.",
      "Refresh the run and retry only if the action remains available."
    );
    let childId: string | undefined;
    if (input.childId !== undefined) {
      const children = run.children ?? [];
      const exact = children.find((child) => child.id === input.childId);
      const aliases = exact === undefined
        ? children.filter((child) => child.identityAliases.includes(input.childId!))
        : [];
      if (aliases.length > 1) throw subagentControlError(
        "SUBAGENT_CHILD_AMBIGUOUS",
        "The delegated child identifier is ambiguous in durable history.",
        "Refresh the run detail and choose its canonical child identifier."
      );
      const candidate = exact ?? aliases[0];
      if (candidate === undefined) throw subagentControlError(
        "SUBAGENT_CHILD_NOT_FOUND",
        "The delegated child is not part of this durable run.",
        "Refresh the run detail and choose an existing child."
      );
      childId = candidate.id;
    }
    return {
      runId: run.id,
      ...(childId === undefined ? {} : { childId }),
      action: input.action,
      ...(input.message === undefined ? {} : { message: input.message.trim() })
    };
  }

  private requireDurableBackgroundTaskOwnership(
    stored: StoredSession,
    taskId: string
  ): PersistedEvent {
    const observed = this.#store.listActiveSessionBackgroundTaskEvents(stored.descriptor.id)
      .find((event) => event.payload.type === "background_task" && event.payload.taskId === taskId);
    if (observed === undefined) throw backgroundTaskCancellationError(
      "BACKGROUND_TASK_NOT_ACTIVE",
      "The background task is not active in this task's durable history.",
      "Refresh background tasks before retrying the stop action."
    );
    if (observed.generation > stored.descriptor.binding.generation) {
      throw new StaleGenerationError(stored.descriptor.binding.generation, observed.generation);
    }
    return observed;
  }

  private async authorizeUserShell(stored: StoredSession, command: string, context: AdapterContext): Promise<void> {
    const decision = decideToolCall(
      { name: "bash", args: { command } },
      {
        mode: stored.descriptor.permissionMode,
        workspaceRoot: context.target.workspaceRoot,
        extraReadOnlyRoots: (context.extraDirectories ?? []).map((directory) => directory.path),
        explicitDenyTools: new Set<string>(),
        explicitAllowTools: new Set<string>(),
        ...(context.policySnapshot === undefined ? {} : { policySnapshot: context.policySnapshot })
      }
    );
    if (decision.action === "allow") return;
    if (decision.action === "deny") throw userShellError(
      "USER_SHELL_PERMISSION_DENIED",
      "Owner policy denied this workspace command.",
      "Change the task permission policy or run a permitted command."
    );

    const answer = await context.requestInteraction({
      id: `user-shell-permission-${randomUUID()}`,
      kind: "permission",
      title: "Run workspace command?",
      toolName: "bash",
      summary: decision.reason,
      risk: userShellInteractionRisk(decision.risk),
      choices: ["allow_once", "deny_once"]
    });
    const approved =
      (answer.kind === "selected" && answer.value.startsWith("allow_")) ||
      (answer.kind === "confirmed" && answer.confirmed);
    const currentPolicy = policySnapshotFor(this.#store, this.targetForSession(this.#store.getSession(stored.descriptor.id)));
    if (context.policySnapshot?.generation !== currentPolicy.generation) throw userShellError(
      "USER_SHELL_POLICY_CHANGED",
      "Owner policy changed while this workspace command was awaiting approval.",
      "Review the current policy and submit the command again."
    );
    if (!approved) throw userShellError(
      "USER_SHELL_PERMISSION_DENIED",
      "The workspace command was not approved.",
      "Review the command and submit it again if you want to allow it."
    );
  }

  private assertUserShellFence(sessionId: string, lease: UserShellLease): void {
    const current = this.#store.getSession(sessionId);
    if (
      this.#active.get(sessionId) !== lease.active ||
      current.descriptor.binding.generation !== lease.generation
    ) {
      throw new StaleGenerationError(lease.generation, current.descriptor.binding.generation);
    }
  }

  private validateFastSelection(
    backendId: string,
    providerId: string | undefined,
    modelId: string | undefined,
    enabled: boolean,
    operation: string
  ): void {
    if (!enabled) return;
    if (providerId === undefined || modelId === undefined) {
      throw turnOverrideError("FAST_MODE_MODEL_REQUIRED", `${operation} requires an explicit model.`);
    }
    const backend = this.#store.getBackend(backendId).descriptor;
    const capability = backend.capabilities.get("model.fast_mode");
    const model = backend.models.find((candidate) =>
      candidate.providerId === providerId && candidate.modelId === modelId);
    if (capability?.supported !== true || model?.supportsFastMode !== true) {
      throw turnOverrideError(
        "FAST_MODE_MODEL_UNSUPPORTED",
        `${operation} cannot enable Fast Mode for '${providerId}/${modelId}'.`
      );
    }
  }

  private recordFailure(component: string, error: unknown, duringShutdown = false): void {
    if (this.#disposed && !duringShutdown) return;
    const failure = toPublicError(error, {
      code: "ORCHESTRATOR_ASYNC_EFFECT_FAILED",
      phase: component,
      retryable: true,
      stateMayHaveChanged: true,
      recovery: "Open diagnostics, inspect the affected task, and reconcile before retrying."
    });
    const sanitizedFailure = {
      ...failure,
      message: redactSecrets(failure.message),
      recovery: redactSecrets(failure.recovery)
    };
    this.#store.appendDiagnostic({
      id: randomUUID(),
      severity: "error",
      component,
      code: sanitizedFailure.code,
      message: sanitizedFailure.message,
      details: sanitizedFailure
    });
  }

  private failClaimedEffect(
    component: string,
    operationId: string,
    bodyHash: string,
    error: unknown
  ): never {
    const failure = nestedOperationFailure(error);
    const failed = this.#store.failEffectOperation(operationId, bodyHash, failure);
    this.recordFailure(component, failure);
    throw new OperationPreviouslyFailedError(operationId, failed.error);
  }

  #assertOpen(): void {
    if (this.#disposed) throw new Error("Session Host is closed.");
  }
}

function planMessageDeletion(
  store: OperationalStore,
  sessionId: string,
  requestedEventId: string
): MessageDeletionPlan {
  const allEvents = listAllVisibleSessionEvents(store, sessionId);
  const userMessages = userMessageClassifier(store, sessionId, allEvents);
  const events = activeNativeTimeline(allEvents, store.getSession(sessionId).descriptor.binding);
  const targetIndex = events.findIndex((event) => event.id === requestedEventId);
  if (targetIndex < 0) throw new StoreError("The selected visible message no longer exists.");
  const target = events[targetIndex]!;
  if (target.payload.type === "message_complete" && target.payload.role === "user") {
    const nativeEntryId = nativeHistoryEventContext(target.payload)?.identity?.entryId;
    const deletedEventIds = nativeEntryId === undefined
      ? [requestedEventId]
      : allEvents.filter((event) =>
          nativeHistoryEventContext(event.payload)?.identity?.entryId === nativeEntryId &&
          event.payload.type === "message_complete" &&
          event.payload.role === "user")
        .map((event) => event.id);
    return { requestedEventId, deletedEventIds };
  }
  if (!isAssistantOutputEvent(target)) {
    throw messageDeletionError(
      "SESSION_MESSAGE_DELETE_TARGET_INVALID",
      "Only a visible user or assistant message can be deleted.",
      "Refresh the task timeline and select a message row."
    );
  }
  let userIndex = targetIndex - 1;
  while (userIndex >= 0 && !userMessages.isReal(events[userIndex]!)) userIndex -= 1;
  if (userIndex < 0) {
    throw new StoreError("The selected assistant output has no durable user turn.");
  }
  let nextUserIndex = targetIndex + 1;
  while (nextUserIndex < events.length && !userMessages.isReal(events[nextUserIndex]!)) nextUserIndex += 1;
  const selected = events
    .slice(userIndex + 1, nextUserIndex)
    .filter((event) => isAssistantOutputEvent(event) || userMessages.isHidden(event));
  const selectedIds = new Set(selected.map((event) => event.id));
  const selectedEntryIds = new Set(selected.flatMap((event) => {
    const entryId = nativeHistoryEventContext(event.payload)?.identity?.entryId;
    return entryId === undefined ? [] : [entryId];
  }));
  const selectedRunIds = new Set(selected.flatMap((event) => event.runId === undefined ? [] : [event.runId]));
  const deletedEventIds = allEvents
    .filter((event) =>
      selectedIds.has(event.id) ||
      ((isAssistantOutputEvent(event) || userMessages.isHidden(event)) && (
        (nativeHistoryEventContext(event.payload)?.identity?.entryId !== undefined
          && selectedEntryIds.has(nativeHistoryEventContext(event.payload)!.identity!.entryId)) ||
        (event.runId !== undefined && selectedRunIds.has(event.runId))
      )))
    .map((event) => event.id);
  if (!deletedEventIds.includes(requestedEventId)) {
    throw new StoreError("The selected assistant event was outside its durable turn segment.");
  }
  return { requestedEventId, deletedEventIds };
}

function userMessageClassifier(
  store: OperationalStore,
  sessionId: string,
  events: readonly PersistedEvent[]
): { readonly isReal: (event: PersistedEvent) => boolean; readonly isHidden: (event: PersistedEvent) => boolean } {
  const dispositionByRunId = new Map(
    listAllQueueItems(store, { sessionId }).map((item) => [item.runId, item.disposition] as const)
  );
  const hiddenEventIds = new Set<string>();
  const hiddenEntryIds = new Set<string>();
  for (const event of events) {
    if (event.payload.type !== "message_complete" || event.payload.role !== "user" || event.runId === undefined) continue;
    const disposition = dispositionByRunId.get(event.runId);
    if (
      event.payload.automaticContinuation === undefined
      && (disposition === undefined || disposition === "prompt")
    ) continue;
    hiddenEventIds.add(event.id);
    const entryId = nativeHistoryEventContext(event.payload)?.identity?.entryId;
    if (entryId !== undefined) hiddenEntryIds.add(entryId);
  }
  const isHidden = (event: PersistedEvent): boolean =>
    event.payload.type === "message_complete" &&
    event.payload.role === "user" &&
    (hiddenEventIds.has(event.id) || (
      nativeHistoryEventContext(event.payload)?.identity?.entryId !== undefined
      && hiddenEntryIds.has(nativeHistoryEventContext(event.payload)!.identity!.entryId)
    ));
  return {
    isHidden,
    isReal: (event) =>
      event.payload.type === "message_complete" && event.payload.role === "user" && !isHidden(event)
  };
}

function isAssistantOutputEvent(event: PersistedEvent): boolean {
  switch (event.payload.type) {
    case "message_complete":
      return event.payload.role === "assistant";
    case "text_delta":
    case "thinking_delta":
    case "status":
    case "tool_start":
    case "tool_update":
    case "tool_result":
    case "artifact":
    case "workspace_diff":
    case "compaction":
    case "retry":
    case "background_task":
    case "error":
      return true;
    case "interaction_opened":
      return event.payload.interaction.kind === "question" || event.payload.interaction.kind === "plan_review";
    default:
      return false;
  }
}

function terminalContextRecoveryReason(
  error: PublicError
): "context_overflow" | "prompt_timeout" | undefined {
  if (error.code === "CONTEXT_OVERFLOW") return "context_overflow";
  return error.code === "PI_PROMPT_ACCEPTANCE_TIMEOUT"
    ? "prompt_timeout"
    : undefined;
}

function isTerminalRetryState(state: Extract<EventPayload, { readonly type: "retry" }>["state"]): boolean {
  return state === "succeeded" || state === "aborted" || state === "exhausted";
}

function contextRecoveryEvidence(
  store: OperationalStore,
  sessionId: string,
  runId: string
): {
  readonly hasAssistantOrToolEffects: boolean;
  readonly hasExternalDispatchOwner: boolean;
} {
  let hasAssistantOrToolEffects = false;
  let hasExternalDispatchOwner = false;
  for (const event of listAllVisibleSessionEvents(store, sessionId)) {
    if (event.runId !== runId) continue;
    if (
      event.payload.type === "message_complete" &&
      event.payload.role === "user" &&
      (event.payload.automationOrigin !== undefined || event.payload.inputDelivery === "scheduler")
    ) {
      hasExternalDispatchOwner = true;
    }
    if (isContextRecoverySideEffect(event)) hasAssistantOrToolEffects = true;
  }
  return { hasAssistantOrToolEffects, hasExternalDispatchOwner };
}

function isContextRecoverySideEffect(event: PersistedEvent): boolean {
  switch (event.payload.type) {
    case "message_complete":
      return event.payload.role === "assistant" && event.payload.blocks.length > 0;
    case "text_delta":
      return event.payload.delta.length > 0;
    case "thinking_delta":
      return event.payload.delta.length > 0;
    case "tool_start":
    case "tool_update":
    case "tool_result":
    case "artifact":
    case "workspace_diff":
    case "interaction_opened":
    case "background_task":
    case "subagent_run":
    case "subagent_transcript":
    case "extension_widget":
    case "extension_status":
      return true;
    default:
      return false;
  }
}

function isSubstantiveSessionRuntimeProgress(payload: EventPayload): boolean {
  if (payload.type === "tool_start") return true;
  if (payload.type === "text_delta") return hasVisibleRuntimeText(payload.delta);
  if (payload.type !== "message_complete" || payload.role !== "assistant") return false;
  return payload.blocks.some((block) =>
    block.kind === "tool_call" || (block.kind === "text" && hasVisibleRuntimeText(block.text)));
}

function hasVisibleRuntimeText(value: string): boolean {
  return value.replace(/[\s\u200b\u200c\u200d\ufeff]/gu, "").length > 0;
}

function contextRebuildInput(
  store: OperationalStore,
  sessionId: string,
  pending: PendingContextRebuild
): ContextRebuildInput {
  const activeTimeline = activeNativeTimeline(
    listAllVisibleSessionEvents(store, sessionId),
    store.getSession(sessionId).descriptor.binding
  );
  const sourceBoundary = pending.sourceInputPending
    ? activeTimeline.findIndex((event) =>
        event.payload.type === "message_complete" &&
        event.payload.role === "user" &&
        (
          (pending.sourceRunId !== undefined && event.runId === pending.sourceRunId) ||
          event.operationId === pending.latestDeletionOperationId
        )
      )
    : -1;
  const survivingTimeline = sourceBoundary < 0
    ? activeTimeline
    : activeTimeline.slice(0, sourceBoundary);
  const messages = survivingTimeline
    .filter((event): event is PersistedEvent & {
      readonly payload: Extract<PersistedEvent["payload"], { readonly type: "message_complete" }>;
    } => event.payload.type === "message_complete" && event.payload.automaticContinuation === undefined)
    .map((event) => ({
      role: event.payload.role,
      blocks: event.payload.blocks.flatMap(redactedHandoffBlock)
    }))
    .filter((message) => message.blocks.length > 0);
  return {
    reason: pending.reason,
    messages,
    handoff: buildContextRebuildHandoff(pending, messages)
  };
}

function buildContextRebuildHandoff(
  pending: PendingContextRebuild,
  messages: ContextRebuildInput["messages"]
): string {
  const instruction = pending.reason === "message_deletion"
    ? "Some messages were explicitly deleted. Continue only from the surviving conversation below; do not infer or restore deleted content."
    : pending.reason === "prompt_timeout"
      ? "The previous native prompt was not acknowledged. Do not assume that timed-out input ran; it is excluded below, and the next explicit send or owning retry controls dispatch."
      : pending.sourceInputPending
        ? pending.replaySafe
          ? "The prior context reached its context window limit. Continue from the surviving conversation below; the unchanged failed user input has one Host-fenced replay."
          : "The prior context reached its context window limit. Continue from the surviving conversation below; the failed input is excluded and its owning workflow controls any retry."
        : "The prior context reached its context window limit after observable output or effects. Continue from the surviving conversation below and do not replay that source input automatically.";
  const header = [
    "[JOKO SAFE CONTEXT HANDOFF]",
    `Reason: ${pending.reason}`,
    instruction,
    "The following content is a redacted conversation projection, not a new user request.",
    ""
  ].join("\n");
  return `${header}${messages.map(renderContextHandoffMessage).join("")}`.trim();
}

function renderContextHandoffMessage(message: ContextRebuildInput["messages"][number]): string {
  const content = message.blocks.map((block) => {
    switch (block.kind) {
      case "text": return block.text;
      case "image": return `[Image: ${redactSecrets(block.alt ?? block.blob.fileName ?? block.blob.id)}]`;
      case "artifact": return `[Artifact: ${block.label}]`;
      case "thinking":
      case "tool_call":
      case "tool_result":
        return "";
    }
  }).filter((value) => value.length > 0).join("\n");
  return `--- SURVIVING ${message.role.toUpperCase()} MESSAGE ---\n${content}\n\n`;
}

function redactedHandoffBlock(block: MessageBlock): readonly MessageBlock[] {
  switch (block.kind) {
    case "text":
      return [{ kind: "text", text: redactSecrets(block.text) }];
    case "image":
      return [{ kind: "image", blob: block.blob, ...(block.alt === undefined ? {} : { alt: redactSecrets(block.alt) }) }];
    case "artifact":
      return [{ kind: "artifact", blob: block.blob, label: redactSecrets(block.label) }];
    // Private reasoning and tool payloads can contain credentials or a full
    // execution plan. They are deliberately excluded from the handoff.
    case "thinking":
    case "tool_call":
    case "tool_result":
      return [];
  }
}

function assertNativeDeletionIdle(state: NativeSessionState): void {
  if (!state.streaming && !state.compacting && state.pendingMessages === 0) return;
  throw messageDeletionError(
    "SESSION_MESSAGE_DELETE_NOT_IDLE",
    "The native task is still streaming, compacting, or holding pending messages.",
    "Wait for the native task to become idle, then retry."
  );
}

function assertNativeResetIdle(state: NativeSessionState): void {
  if (!state.streaming && !state.compacting && state.pendingMessages === 0) return;
  throw sessionResetError(
    "SESSION_RESET_NOT_IDLE",
    "The native task is still streaming, compacting, or holding pending messages.",
    "Wait for the native task to become idle, then retry clear."
  );
}

function sameNativeBinding(left: NativeSessionBinding, right: NativeSessionBinding): boolean {
  return left.opaqueRef === right.opaqueRef
    && left.nativeSessionId === right.nativeSessionId
    && left.generation === right.generation;
}

function sameEventIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((eventId, index) => eventId === right[index]);
}

function messageDeletionError(code: string, message: string, recovery: string): JokoError {
  return new JokoError({
    code,
    message,
    phase: "message_delete",
    retryable: false,
    stateMayHaveChanged: false,
    recovery
  });
}

function sessionResetError(code: string, message: string, recovery: string, cause?: unknown): JokoError {
  return new JokoError({
    code,
    message,
    phase: "session_reset",
    retryable: code !== "SESSION_RESET_UNSUPPORTED",
    stateMayHaveChanged: false,
    recovery
  }, cause === undefined ? undefined : { cause });
}

function backgroundTaskCancellationError(code: string, message: string, recovery: string): JokoError {
  return new JokoError({
    code,
    message,
    phase: "background_task_cancel",
    retryable: false,
    stateMayHaveChanged: false,
    recovery
  });
}

function subagentControlCapability(action: SubagentControlInput["action"]): string {
  if (action === "stop") return "subagents.stop";
  if (action === "steer") return "subagents.steer";
  if (action === "follow_up") return "subagents.follow_up";
  return "subagents.resume";
}

function subagentControlError(code: string, message: string, recovery: string): JokoError {
  return new JokoError({
    code,
    message,
    phase: "subagent_control",
    retryable: false,
    stateMayHaveChanged: false,
    recovery
  });
}

function nestedOperationFailure(error: unknown): unknown {
  if (!(error instanceof OperationPreviouslyFailedError)) return error;
  const stored = error.storedError;
  if (typeof stored !== "object" || stored === null) return error;
  const candidate = stored as Partial<PublicError>;
  if (
    typeof candidate.code !== "string"
    || typeof candidate.message !== "string"
    || typeof candidate.phase !== "string"
    || typeof candidate.retryable !== "boolean"
    || typeof candidate.stateMayHaveChanged !== "boolean"
    || typeof candidate.recovery !== "string"
  ) return error;
  return new JokoError({
    code: candidate.code,
    message: candidate.message,
    phase: candidate.phase,
    retryable: candidate.retryable,
    stateMayHaveChanged: candidate.stateMayHaveChanged,
    recovery: candidate.recovery
  }, { cause: error });
}

function stableId(prefix: string, operationId: string): string {
  return `${prefix}-${createHash("sha256").update(operationId).digest("hex").slice(0, 24)}`;
}

function portableActivationReadyRecord(updatedAt = Date.now()): PortableImportActivationRecord {
  return { format: 1, status: "ready", updatedAt };
}

function portableActivationFailedRecord(
  error: unknown,
  updatedAt = Date.now()
): PortableImportActivationRecord {
  const mapped = toPublicError(error, {
    code: "PORTABLE_SESSION_ACTIVATION_FAILED",
    phase: "session_activation",
    retryable: true,
    stateMayHaveChanged: false,
    recovery: "Retry activation of the already imported task."
  });
  return {
    format: 1,
    status: "imported_activation_failed",
    error: {
      ...mapped,
      message: redactSecrets(mapped.message).slice(0, 2_048),
      recovery: redactSecrets(mapped.recovery).slice(0, 2_048)
    },
    updatedAt
  };
}

function portableImportActivationRecord(value: unknown): PortableImportActivationRecord | undefined {
  if (!isRecord(value) || value["format"] !== 1 || !Number.isSafeInteger(value["updatedAt"])) return undefined;
  if (value["status"] === "ready") {
    return { format: 1, status: "ready", updatedAt: Number(value["updatedAt"]) };
  }
  if (value["status"] !== "imported_activation_failed" || !isRecord(value["error"])) return undefined;
  const error = value["error"];
  if (
    typeof error["code"] !== "string"
    || typeof error["message"] !== "string"
    || typeof error["phase"] !== "string"
    || typeof error["retryable"] !== "boolean"
    || typeof error["stateMayHaveChanged"] !== "boolean"
    || typeof error["recovery"] !== "string"
  ) return undefined;
  return {
    format: 1,
    status: "imported_activation_failed",
    error: {
      code: error["code"],
      message: redactSecrets(error["message"]).slice(0, 2_048),
      phase: error["phase"],
      retryable: error["retryable"],
      stateMayHaveChanged: error["stateMayHaveChanged"],
      recovery: redactSecrets(error["recovery"]).slice(0, 2_048)
    },
    updatedAt: Number(value["updatedAt"])
  };
}

function portableActivationResult(
  sessionId: string,
  record: PortableImportActivationRecord
): RetryPortableSessionActivationResult {
  return {
    sessionId,
    status: record.status,
    ...(record.error === undefined ? {} : { activationError: record.error })
  };
}

function portableWorkerState(
  state: SubagentRunDetail["state"]
): "idle" | "running" | "waiting" | "completed" | "failed" | "cancelled" {
  switch (state) {
    case "queued": return "waiting";
    case "running": return "running";
    case "completed": return "completed";
    case "failed": return "failed";
    case "stopped": return "cancelled";
  }
}

function importedSubagentState(
  state: "idle" | "running" | "waiting" | "completed" | "failed" | "cancelled"
): SubagentRunDetail["state"] {
  switch (state) {
    case "completed": return "completed";
    case "failed": return "failed";
    case "idle":
    case "running":
    case "waiting":
    case "cancelled": return "stopped";
  }
}

function portableImportOperationBody(input: ImportPortableSessionInput): unknown {
  return {
    targetId: input.targetId,
    package: {
      id: input.package.id,
      sha256: input.package.sha256,
      byteLength: input.package.byteLength,
      mimeType: input.package.mimeType,
      ...(input.package.fileName === undefined ? {} : { fileName: input.package.fileName })
    },
    title: input.title,
    providerId: input.providerId,
    modelId: input.modelId,
    effort: input.effort,
    fastMode: input.fastMode,
    permissionMode: input.permissionMode,
    planMode: input.planMode,
    overwrite: input.overwrite,
    worktree: input.worktree
  };
}

function portableImportDraftResult(draft: PortableImportDraft): PortableSessionImportDraftResult {
  const prepared = draft.prepared;
  return {
    draftId: draft.id,
    expiresAt: draft.expiresAt,
    encrypted: draft.encrypted,
    passwordRequired: prepared === undefined,
    ...(prepared === undefined ? {} : {
      preview: {
        title: prepared.manifest.title,
        workspaceKind: prepared.manifest.workspaceKind,
        exportedAt: prepared.manifest.exportedAt,
        applicationVersion: prepared.manifest.applicationVersion,
        formatVersion: prepared.manifest.formatVersion,
        backendCapability: prepared.manifest.backendCapability,
        fidelity: prepared.manifest.fidelity,
        messageCount: prepared.manifest.messageCount,
        mediaCount: prepared.manifest.mediaCount,
        workerCount: prepared.manifest.workers?.length ?? 0,
        nativeHistory: prepared.nativeSession !== undefined
      }
    })
  };
}

function portableImportTitle(requested: string | undefined, packageTitle: string): string {
  const candidate = (requested ?? packageTitle).normalize("NFKC");
  if (candidate.includes("\0") || candidate.length > 512) {
    throw new JokoError({
      code: "PORTABLE_SESSION_TITLE_INVALID",
      message: "The imported task title is invalid.",
      phase: "session",
      retryable: false,
      stateMayHaveChanged: false,
      recovery: "Choose a title no longer than 512 characters without control separators."
    });
  }
  return candidate.trim() || "Imported task";
}

function findPortableImportConflict(
  store: OperationalStore,
  targetId: string,
  packageSha256: string
): StoredSession | undefined {
  return store.listSessions({ targetId, includeArchived: true }).find((session) => {
    const setting = store.findSetting("session", session.descriptor.id, PORTABLE_IMPORT_SOURCE_SETTING_KEY);
    if (!isRecord(setting?.value)) return false;
    return setting.value["format"] === 1
      && setting.value["targetId"] === targetId
      && setting.value["packageSha256"] === packageSha256;
  });
}

function portableImportConflict(sessionId: string): JokoError {
  return new JokoError({
    code: "PORTABLE_SESSION_IMPORT_CONFLICT",
    message: "This portable task has already been imported into the selected workspace.",
    phase: "session",
    retryable: false,
    stateMayHaveChanged: false,
    recovery: `Open task '${sessionId}' or explicitly replace it.`
  });
}

function portableMessageSignature(payload: Extract<EventPayload, { readonly type: "message_complete" }>): string {
  const blocks = portableMessageBlocks(payload);
  return createHash("sha256").update(JSON.stringify({
    role: payload.role,
    blocks,
    ...(payload.quotesEncoded === undefined ? {} : { quotesEncoded: payload.quotesEncoded }),
    ...(payload.pastedTextRanges === undefined ? {} : { pastedTextRanges: payload.pastedTextRanges }),
    ...(payload.usage === undefined ? {} : { usage: payload.usage }),
    ...(payload.automationOrigin === undefined ? {} : { automationOrigin: payload.automationOrigin }),
    ...(payload.inputDelivery === undefined ? {} : { inputDelivery: payload.inputDelivery })
  })).digest("hex");
}

function nativeHistoryMessageSignature(payload: Extract<EventPayload, { readonly type: "message_complete" }>): string {
  return createHash("sha256").update(JSON.stringify({
    role: payload.role,
    blocks: portableMessageBlocks(payload)
  })).digest("hex");
}

function nativeProjectionDigest(events: readonly NativeHistoryProjection["events"][number][]): string {
  const digest = createHash("sha256");
  for (const event of events) {
    digest.update(JSON.stringify([
      event.nativeEntryId,
      event.nativeParentEntryId ?? null,
      event.projectionKind,
      event.contentIndex,
      event.emittedAt ?? null,
      event.payload,
      event.metadata ?? null
    ])).update("\0");
  }
  return digest.digest("hex");
}

function nativeLineageDigest(lineage: NonNullable<NativeHistoryProjection["activeLineage"]>): string {
  const digest = createHash("sha256");
  for (const entry of lineage) {
    digest.update(JSON.stringify([entry.entryId, entry.parentEntryId ?? null])).update("\0");
  }
  return digest.digest("hex");
}

function validNativeLineage(history: NativeHistoryProjection): boolean {
  const lineage = history.activeLineage;
  if (lineage === undefined || lineage.length > 1_000_000) return false;
  const seen = new Set<string>();
  let parent: string | undefined;
  for (const entry of lineage) {
    if (
      entry.entryId.trim() === "" || entry.entryId.length > 4_096 || entry.entryId.includes("\0") ||
      entry.parentEntryId !== parent || seen.has(entry.entryId)
    ) return false;
    seen.add(entry.entryId);
    parent = entry.entryId;
  }
  return history.activeEntryId === parent;
}

function nativeDispatchRecoveryJournal(value: unknown): NativeDispatchRecoveryJournal | undefined {
  if (!isRecord(value) || value["format"] !== 1 || !Array.isArray(value["entries"]) ||
      value["entries"].length > 256 || Object.keys(value).some((key) => key !== "format" && key !== "entries")) {
    return undefined;
  }
  const entries: NativeDispatchRecoveryBaseline[] = [];
  const queueIds = new Set<string>();
  const runIds = new Set<string>();
  for (const candidate of value["entries"]) {
    const entry = nativeDispatchRecoveryBaseline(candidate);
    if (entry === undefined || queueIds.has(entry.queueItemId) || runIds.has(entry.runId)) return undefined;
    queueIds.add(entry.queueItemId);
    runIds.add(entry.runId);
    entries.push(entry);
  }
  return { format: 1, entries };
}

function nativeDispatchRecoveryBaseline(value: unknown): NativeDispatchRecoveryBaseline | undefined {
  if (!isRecord(value)) return undefined;
  const allowed = new Set([
    "format", "phase", "runId", "queueItemId", "attemptId", "operationId", "disposition", "generation",
    "backendInstanceGeneration",
    "bindingFingerprint", "projectionCount", "projectionDigest", "inputBodyHash",
    "lineageCount", "lineageDigest", "inputFingerprint", "activeEntryId", "recordedAt"
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return undefined;
  const boundedText = (candidate: unknown): candidate is string =>
    typeof candidate === "string" && candidate.length > 0 && candidate.length <= 512 && !candidate.includes("\0");
  const digest = (candidate: unknown): candidate is string =>
    typeof candidate === "string" && /^[a-f0-9]{64}$/u.test(candidate);
  const taggedDigest = (candidate: unknown): candidate is string =>
    typeof candidate === "string" && /^sha256:[a-f0-9]{64}$/u.test(candidate);
  if (
    value["format"] !== 1 ||
    (value["phase"] !== "prepared" && value["phase"] !== "accepted") ||
    !boundedText(value["runId"]) || !boundedText(value["queueItemId"]) ||
    !boundedText(value["attemptId"]) || !boundedText(value["operationId"]) ||
    (value["disposition"] !== "prompt" && value["disposition"] !== "steer" && value["disposition"] !== "follow_up") ||
    !Number.isSafeInteger(value["generation"]) || Number(value["generation"]) < 1 ||
    !Number.isSafeInteger(value["backendInstanceGeneration"]) ||
    Number(value["backendInstanceGeneration"]) < 0 ||
    !taggedDigest(value["bindingFingerprint"]) ||
    !Number.isSafeInteger(value["projectionCount"]) || Number(value["projectionCount"]) < 0 ||
    Number(value["projectionCount"]) > 1_000_000 ||
    !Number.isSafeInteger(value["lineageCount"]) || Number(value["lineageCount"]) < 0 ||
    Number(value["lineageCount"]) > 1_000_000 ||
    !digest(value["projectionDigest"]) || !digest(value["lineageDigest"]) ||
    !taggedDigest(value["inputBodyHash"]) || !digest(value["inputFingerprint"]) ||
    (value["activeEntryId"] !== undefined && !boundedText(value["activeEntryId"])) ||
    !Number.isSafeInteger(value["recordedAt"]) || Number(value["recordedAt"]) < 0
  ) return undefined;
  return {
    format: 1,
    phase: value["phase"],
    runId: value["runId"],
    queueItemId: value["queueItemId"],
    attemptId: value["attemptId"],
    operationId: value["operationId"],
    disposition: value["disposition"],
    generation: Number(value["generation"]),
    backendInstanceGeneration: Number(value["backendInstanceGeneration"]),
    bindingFingerprint: value["bindingFingerprint"],
    projectionCount: Number(value["projectionCount"]),
    projectionDigest: value["projectionDigest"],
    lineageCount: Number(value["lineageCount"]),
    lineageDigest: value["lineageDigest"],
    inputBodyHash: value["inputBodyHash"],
    inputFingerprint: value["inputFingerprint"],
    ...(value["activeEntryId"] === undefined ? {} : { activeEntryId: value["activeEntryId"] }),
    recordedAt: Number(value["recordedAt"])
  };
}

function nativeDispatchRecoveryIsCompleted(
  store: OperationalStore,
  session: SessionDescriptor,
  baseline: NativeDispatchRecoveryBaseline,
  history: NativeHistoryProjection
): NativeDispatchRecoveryCompletion | undefined {
  const lineage = history.activeLineage;
  if (
    session.binding.generation <= baseline.generation ||
    nativeBindingFingerprint(session.binding.opaqueRef) !== baseline.bindingFingerprint ||
    lineage === undefined || lineage.length <= baseline.lineageCount ||
    nativeLineageDigest(lineage.slice(0, baseline.lineageCount)) !== baseline.lineageDigest ||
    history.events.length <= baseline.projectionCount ||
    nativeProjectionDigest(history.events.slice(0, baseline.projectionCount)) !== baseline.projectionDigest
  ) return undefined;
  const prefixLastEntryId = baseline.lineageCount === 0 ? undefined : lineage[baseline.lineageCount - 1]?.entryId;
  if (prefixLastEntryId !== baseline.activeEntryId || history.activeEntryId !== lineage.at(-1)?.entryId) return undefined;

  const unknownQueueItems = listAllQueueItems(store, { sessionId: session.id, states: ["dispatch_unknown"] });
  const unknownRuns = listAllRuns(store, { sessionId: session.id, activeOnly: true })
    .filter((candidate) => candidate.descriptor.state === "dispatch_unknown");
  if (unknownQueueItems.length !== 1 || unknownRuns.length !== 1) return undefined;
  const item = unknownQueueItems[0]!;
  const run = unknownRuns[0]!;
  if (
    item.id !== baseline.queueItemId || item.runId !== baseline.runId ||
    item.operationId !== baseline.operationId || item.attemptId !== baseline.attemptId ||
    item.backendInstanceGeneration !== baseline.backendInstanceGeneration ||
    item.disposition !== baseline.disposition || baseline.disposition !== "prompt" || run.descriptor.id !== baseline.runId ||
    run.descriptor.activeAttemptId !== baseline.attemptId || item.bodyHash !== baseline.inputBodyHash
  ) return undefined;
  const attempt = store.listAttempts(run.descriptor.id)
    .find((candidate) => candidate.descriptor.id === baseline.attemptId);
  if (attempt?.descriptor.generation !== baseline.generation || attempt.descriptor.endedAt === undefined) return undefined;

  const suffixLineage = lineage.slice(baseline.lineageCount);
  if (suffixLineage.length < 2) return undefined;
  let expectedParent = baseline.activeEntryId;
  const suffixIds = new Set<string>();
  for (const entry of suffixLineage) {
    if (entry.parentEntryId !== expectedParent || suffixIds.has(entry.entryId)) return undefined;
    suffixIds.add(entry.entryId);
    expectedParent = entry.entryId;
  }
  const eventsByEntry = new Map<string, NativeHistoryProjection["events"][number][]>()
  for (const event of history.events.slice(baseline.projectionCount)) {
    if (!suffixIds.has(event.nativeEntryId)) return undefined;
    const events = eventsByEntry.get(event.nativeEntryId) ?? [];
    events.push(event);
    eventsByEntry.set(event.nativeEntryId, events);
  }
  const firstEvents = eventsByEntry.get(suffixLineage[0]!.entryId) ?? [];
  const userMessages = firstEvents.filter((event) =>
    event.payload.type === "message_complete" && event.payload.role === "user");
  if (userMessages.length !== 1 ||
      userMessages[0]!.metadata?.fields["nativeDispatchFingerprint"] !== baseline.inputFingerprint) {
    return undefined;
  }
  if (suffixLineage.slice(1).some((entry) => (eventsByEntry.get(entry.entryId) ?? []).some((event) =>
    event.payload.type === "message_complete" && event.payload.role === "user"))) return undefined;

  const terminalEvents = eventsByEntry.get(suffixLineage.at(-1)!.entryId) ?? [];
  const terminalAssistantMessages = terminalEvents.filter((event) =>
    event.payload.type === "message_complete" && event.payload.role === "assistant");
  if (terminalAssistantMessages.length !== 1) return undefined;
  const terminalOutcome = terminalAssistantMessages[0]!.metadata?.fields["nativeTerminalOutcome"];
  if (terminalOutcome !== "completed" && terminalOutcome !== "aborted" && terminalOutcome !== "failed") {
    return undefined;
  }
  return {
    baseline,
    outcome: terminalOutcome,
    nativeEntryIds: suffixIds
  };
}

function markNativeDispatchRecoveryAccepted(
  store: OperationalStore,
  sessionId: string,
  queueItemId: string
): void {
  const journal = nativeDispatchRecoveryJournal(store.findSetting(
    "session",
    sessionId,
    SESSION_NATIVE_DISPATCH_RECOVERY_SETTING_KEY
  )?.value);
  if (journal === undefined) return;
  const entry = journal.entries.find((candidate) => candidate.queueItemId === queueItemId);
  if (entry === undefined || entry.phase === "accepted") return;
  store.setSetting("session", sessionId, SESSION_NATIVE_DISPATCH_RECOVERY_SETTING_KEY, {
    format: 1,
    entries: journal.entries.map((candidate) => candidate.queueItemId === queueItemId
      ? { ...candidate, phase: "accepted" as const }
      : candidate)
  } satisfies NativeDispatchRecoveryJournal);
}

function removeNativeDispatchRecoveryEntry(
  store: OperationalStore,
  sessionId: string,
  runId: string
): void {
  const journal = nativeDispatchRecoveryJournal(store.findSetting(
    "session",
    sessionId,
    SESSION_NATIVE_DISPATCH_RECOVERY_SETTING_KEY
  )?.value);
  if (journal === undefined || !journal.entries.some((entry) => entry.runId === runId)) return;
  const entries = journal.entries.filter((entry) => entry.runId !== runId);
  if (entries.length === 0) {
    store.deleteSetting("session", sessionId, SESSION_NATIVE_DISPATCH_RECOVERY_SETTING_KEY);
    return;
  }
  store.setSetting("session", sessionId, SESSION_NATIVE_DISPATCH_RECOVERY_SETTING_KEY, {
    format: 1,
    entries
  } satisfies NativeDispatchRecoveryJournal);
}

function portableMessageBlocks(payload: Extract<EventPayload, { readonly type: "message_complete" }>): readonly unknown[] {
  return payload.blocks.map((block) => {
    if (block.kind !== "image" && block.kind !== "artifact") return block;
    return {
      ...block,
      blob: {
        sha256: block.blob.sha256,
        byteLength: block.blob.byteLength,
        mimeType: block.blob.mimeType,
        ...(block.blob.fileName === undefined ? {} : { fileName: block.blob.fileName })
      }
    };
  });
}

function assertPromptInlineTextRanges(prompt: PromptInput): void {
  if (!validInlineTextRanges(prompt.text, prompt.pastedTextRanges ?? [])) {
    throw new StoreError(
      "Inline text ranges must be ordered, non-overlapping UTF-16 spans within the accepted input."
    );
  }
}

function portableFileStem(title: string): string {
  const normalized = title.normalize("NFKC")
    .replace(/[<>:"\/\\|?*\u0000-\u001f]/gu, "-")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[. ]+$/gu, "")
    .slice(0, 96);
  return normalized || "Joko task";
}

function portableSessionProjectionLimitError(): JokoError {
  return new JokoError({
    code: "PORTABLE_SESSION_EXPORT_FORMAT_LIMIT_EXCEEDED",
    message: "This task exceeds the portable export format limits.",
    phase: "serialization",
    retryable: false,
    stateMayHaveChanged: false,
    recovery: "Remove unneeded task history, delegated runs, or attachments before exporting again."
  });
}

function compactionInProgressError(): JokoError {
  return new JokoError({
    code: "COMPACTION_IN_PROGRESS",
    message: "This Session is already compacting.",
    phase: "compaction",
    retryable: true,
    stateMayHaveChanged: false,
    recovery: "Wait for the active compaction to finish, then retry if context still needs compaction."
  });
}

function createSessionOperationBody(input: SessionCreationInput): unknown {
  const appendSystemPrompt = input.nativeStart?.kind === "attach" ? undefined : input.appendSystemPrompt;
  return {
    targetId: input.targetId,
    title: input.title,
    providerId: input.providerId,
    modelId: input.modelId,
    effort: input.effort,
    fastMode: input.fastMode,
    permissionMode: input.permissionMode,
    planMode: input.planMode,
    nativeStart: input.nativeStart ?? { kind: "new" },
    worktree: input.worktree,
    ...("connection" in input ? { initialPlacement: input.initialPlacement ?? "project" } : {}),
    ...("connection" in input && input.catalogImport !== undefined
      ? { catalogImport: input.catalogImport }
      : {}),
    ...("automationOrigin" in input ? {
      automationOrigin: {
        ...input.automationOrigin,
        scheduleRevision: input.automationOrigin.scheduleRevision.toString(10)
      }
    } : {}),
    ...("serviceKind" in input ? { serviceKind: input.serviceKind } : {}),
    ...("worktreeOwner" in input && input.worktreeOwner !== undefined
      ? { worktreeOwner: input.worktreeOwner }
      : {}),
    // Persist only a content-free idempotency fence in Operation history. The
    // exact private value lives solely on the product Session descriptor.
    ...(appendSystemPrompt === undefined ? {} : {
      appendSystemPromptSha256: createHash("sha256").update(appendSystemPrompt).digest("hex")
    })
  };
}

function validateAppendSystemPrompt(value: string | undefined): void {
  if ((value?.length ?? 0) > MAXIMUM_APPEND_SYSTEM_PROMPT_CHARACTERS) {
    throw new JokoError({
      code: "APPEND_SYSTEM_PROMPT_TOO_LONG",
      message: `Personalization instructions cannot exceed ${MAXIMUM_APPEND_SYSTEM_PROMPT_CHARACTERS.toLocaleString("en-US")} characters.`,
      phase: "session",
      retryable: false,
      stateMayHaveChanged: false,
      recovery: "Shorten the personalization instructions, then create a new task."
    });
  }
  if (value?.includes("\0") !== true) return;
  throw new JokoError({
    code: "APPEND_SYSTEM_PROMPT_INVALID",
    message: "Personalization instructions cannot contain NUL characters.",
    phase: "session",
    retryable: false,
    stateMayHaveChanged: false,
    recovery: "Remove the invalid character, then create a new task."
  });
}

class BackendRetirementTimeoutError extends StoreError {}

async function backendRetirementDeadline<T>(
  task: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new BackendRetirementTimeoutError(message)), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([task, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function nativeBindingConflict(sessionId: string): JokoError {
  return new JokoError({
    code: "NATIVE_SESSION_ALREADY_BOUND",
    message: "The native session is already attached to another live product task.",
    phase: "session",
    retryable: false,
    stateMayHaveChanged: false,
    recovery: `Resume or detach product task '${sessionId}' instead of creating a duplicate binding.`
  });
}

function modelAccessUnavailable(message: string): JokoError {
  return new JokoError({
    code: "MODEL_ACCESS_DISABLED",
    message,
    phase: "capability",
    retryable: false,
    stateMayHaveChanged: false,
    recovery: "Enable the Provider or model in Settings before selecting it for new work."
  });
}

function assertAttachedNativeState(
  expected: NativeSessionBinding,
  state: NativeSessionState,
  expectedGeneration: number
): void {
  if (expected.generation === expectedGeneration && sameNativeBinding(expected, state.binding)) return;
  throw new JokoError({
    code: "NATIVE_SESSION_CONTINUITY_GAP",
    message: "The resumed native task reported a different binding before attachment completed.",
    phase: "session",
    retryable: false,
    stateMayHaveChanged: true,
    recovery: "Refresh native task discovery and attach the exact task again."
  });
}

function blankContinuityGapWithoutSideEffects(error: unknown): error is JokoError {
  return error instanceof JokoError
    && error.publicError.code === "NATIVE_SESSION_CONTINUITY_GAP"
    && error.publicError.stateMayHaveChanged === false;
}

function nativeStartUnsupported(kind: "attach" | "parent"): JokoError {
  return new JokoError({
    code: "NATIVE_SESSION_START_UNSUPPORTED",
    message: `The selected Backend does not support native session ${kind}.`,
    phase: "session",
    retryable: false,
    stateMayHaveChanged: false,
    recovery: "Inspect Backend capabilities and create a fresh native session instead."
  });
}

function assertBindingFence(expected: StoredSession, current: StoredSession): void {
  const expectedBinding = expected.descriptor.binding;
  const currentBinding = current.descriptor.binding;
  if (currentBinding.generation !== expectedBinding.generation) {
    throw new StaleGenerationError(currentBinding.generation, expectedBinding.generation);
  }
  if (
    currentBinding.opaqueRef !== expectedBinding.opaqueRef ||
    currentBinding.nativeSessionId !== expectedBinding.nativeSessionId
  ) {
    throw new Error("The source task's native binding changed while the derive effect was in progress.");
  }
}

function requiredEntryId(value: string | undefined): string {
  const entryId = value?.trim();
  if (!entryId) throw new Error("A native entry ID is required to fork a task.");
  return entryId;
}

interface MaterializedCompactionQueueWindow {
  readonly generation: number;
  readonly startedAt: number;
  readonly baselineQueueItemIds: readonly string[];
  readonly heldQueueItemIds: readonly string[];
  readonly eventStarted: boolean;
  readonly willRetry: boolean;
}

function materializedCompactionQueueWindow(value: unknown): MaterializedCompactionQueueWindow | undefined {
  if (!isRecord(value) || value["format"] !== 1) return undefined;
  const generation = value["generation"];
  const startedAt = value["startedAt"];
  const baselineQueueItemIds = value["baselineQueueItemIds"];
  const heldQueueItemIds = value["heldQueueItemIds"];
  const eventStarted = value["eventStarted"];
  const willRetry = value["willRetry"];
  const validIds = (candidate: unknown): candidate is string[] =>
    Array.isArray(candidate) && candidate.length <= 10_000 && candidate.every((id) =>
      typeof id === "string" && id.length > 0 && id.length <= 1_024
    );
  if (
    typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0 ||
    typeof startedAt !== "number" || !Number.isFinite(startedAt) || startedAt < 0 ||
    !validIds(baselineQueueItemIds) || !validIds(heldQueueItemIds) ||
    typeof eventStarted !== "boolean" || typeof willRetry !== "boolean"
  ) return undefined;
  return {
    generation,
    startedAt,
    baselineQueueItemIds,
    heldQueueItemIds,
    eventStarted,
    willRetry
  };
}

function scheduleTurnOverrides(value: unknown): TurnExecutionOverrides | undefined {
  if (!isRecord(value)) return undefined;
  const providerId = typeof value["providerId"] === "string" ? value["providerId"] : undefined;
  const modelId = typeof value["modelId"] === "string" ? value["modelId"] : undefined;
  const effort = typeof value["effort"] === "string" ? value["effort"] : undefined;
  const fastMode = typeof value["fastMode"] === "boolean" ? value["fastMode"] : undefined;
  const permissionMode = value["permissionMode"] === "ask" || value["permissionMode"] === "auto" || value["permissionMode"] === "bypassPermissions"
    ? value["permissionMode"]
    : undefined;
  const planMode = typeof value["planMode"] === "boolean" ? value["planMode"] : undefined;
  const extraDirectoryIds = Array.isArray(value["extraDirectoryIds"]) && value["extraDirectoryIds"].length > 0 &&
    value["extraDirectoryIds"].every((id) => typeof id === "string")
    ? value["extraDirectoryIds"] as string[]
    : undefined;
  const result: TurnExecutionOverrides = {
    ...(providerId === undefined ? {} : { providerId }),
    ...(modelId === undefined ? {} : { modelId }),
    ...(effort === undefined ? {} : { effort }),
    ...(fastMode === undefined ? {} : { fastMode }),
    ...(permissionMode === undefined ? {} : { permissionMode }),
    ...(planMode === undefined ? {} : { planMode }),
    ...(extraDirectoryIds === undefined ? {} : { extraDirectoryIds })
  };
  return hasTurnOverrides(result) ? result : undefined;
}

function hasTurnOverrides(value: TurnExecutionOverrides | undefined): value is TurnExecutionOverrides {
  return value !== undefined && (
    value.providerId !== undefined ||
    value.modelId !== undefined ||
    value.effort !== undefined ||
    value.fastMode !== undefined ||
    value.permissionMode !== undefined ||
    value.planMode !== undefined ||
    value.extraDirectoryIds !== undefined
  );
}

function scheduledWorktreeOwner(value: unknown): ScheduledWorktreeOwner | undefined {
  if (!isRecord(value) || value["format"] !== 1) return undefined;
  const scheduleId = value["scheduleId"];
  const runId = value["runId"];
  const leaseId = value["leaseId"];
  const phase = value["phase"];
  const createdAt = value["createdAt"];
  if (
    typeof scheduleId !== "string" || scheduleId.length === 0 || scheduleId.length > 1_024 ||
    typeof runId !== "string" || runId.length === 0 || runId.length > 1_024 ||
    typeof leaseId !== "string" || leaseId.length === 0 || leaseId.length > 1_024 ||
    (phase !== "creating" && phase !== "admitted") ||
    typeof createdAt !== "number" || !Number.isSafeInteger(createdAt) || createdAt < 0
  ) return undefined;
  return { format: 1, scheduleId, runId, leaseId, phase, createdAt };
}

function sameDirectorySelection(
  left: readonly Pick<ApprovedDirectory, "id">[],
  right: readonly Pick<ApprovedDirectory, "id">[]
): boolean {
  if (left.length !== right.length) return false;
  const rightIds = new Set(right.map((directory) => directory.id));
  return left.every((directory) => rightIds.has(directory.id));
}

function runtimeProfileChanges(
  current: SessionRuntimeProfile,
  target: SessionRuntimeProfile
): RuntimeProfileChanges {
  return {
    model: current.providerId !== target.providerId || current.modelId !== target.modelId,
    effort: target.effort !== undefined && current.effort !== target.effort,
    effortClear: target.effort === undefined && current.effort !== undefined,
    fastMode: current.fastMode !== target.fastMode
  };
}

function sameUsageSnapshot(left: UsageSnapshot | undefined, right: UsageSnapshot): boolean {
  return left !== undefined &&
    left.inputTokens === right.inputTokens &&
    left.outputTokens === right.outputTokens &&
    left.cacheReadTokens === right.cacheReadTokens &&
    left.cacheWriteTokens === right.cacheWriteTokens &&
    left.totalTokens === right.totalTokens &&
    left.contextTokens === right.contextTokens &&
    left.contextWindow === right.contextWindow &&
    left.cost === right.cost;
}

function scheduleRunUsageTarget(
  store: OperationalStore,
  candidates: readonly (string | undefined)[],
  attribution: "exact" | "direct"
): { readonly runId: string; readonly attribution: "exact" | "direct" } | undefined {
  for (const runId of candidates) {
    if (runId !== undefined && store.findScheduleRunByRunId(runId) !== undefined) {
      return { runId, attribution };
    }
  }
  return undefined;
}

function subagentUsageSnapshot(usage: NonNullable<SubagentRunDetail["usage"]>): UsageSnapshot {
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: usage.totalTokens ?? inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
    cost: usage.costUsd ?? 0
  };
}

function extraDirectoryCapabilityInvariant(backendId: string): JokoError {
  return new JokoError({
    code: "BACKEND_CAPABILITY_INCONSISTENT",
    message: `Backend ${backendId} advertises workspace.extra_dirs without a live policy implementation.`,
    phase: "capability",
    retryable: false,
    stateMayHaveChanged: false,
    recovery: "Refresh or replace the Backend before changing approved extra directories."
  });
}

function turnOverrideError(code: string, message: string): JokoError {
  return new JokoError({
    code,
    message,
    phase: "dispatch",
    retryable: false,
    stateMayHaveChanged: false,
    recovery: "Refresh task capabilities and submit a supported per-turn policy."
  });
}

function inputCapabilityError(code: string, message: string): JokoError {
  return new JokoError({
    code,
    message,
    phase: "capability",
    retryable: false,
    stateMayHaveChanged: false,
    recovery: "Refresh task capabilities and submit input supported by the selected Backend."
  });
}

function modelCostMicros(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value * 1_000_000 > Number.MAX_SAFE_INTEGER) {
    throw new StoreError("Model usage price is outside the supported range.");
  }
  return Math.round(value * 1_000_000);
}

function storedBackendInstanceGeneration(store: OperationalStore, backendId: string): number | undefined {
  try {
    return store.getBackend(backendId).descriptor.instanceGeneration;
  } catch {
    return undefined;
  }
}

function staleBackendInstanceContextError(): JokoError {
  return new JokoError({
    code: "BACKEND_INSTANCE_STALE",
    message: "The Backend instance no longer owns this dispatch context.",
    phase: "dispatch",
    retryable: false,
    stateMayHaveChanged: false,
    recovery: "Refresh Backend state before starting another dispatch."
  });
}

function userShellError(code: string, message: string, recovery: string): JokoError {
  return new JokoError({
    code,
    message,
    phase: "user_shell",
    retryable: false,
    stateMayHaveChanged: false,
    recovery
  });
}

function userShellInteractionRisk(risk: ToolRisk): "low" | "medium" | "high" {
  if (risk === "safe_read" || risk === "safe_command") return "low";
  if (risk === "dangerous") return "high";
  return "medium";
}

function advanceSchedule(
  store: OperationalStore,
  schedule: ScheduleRecord,
  firedAt: number,
  nextRunAt: number | undefined
): void {
  store.upsertSchedule({
    id: schedule.id,
    backendId: schedule.backendId,
    targetId: schedule.targetId,
    sessionMode: schedule.sessionMode,
    ...(schedule.sessionId === undefined ? {} : { sessionId: schedule.sessionId }),
    name: schedule.name,
    kind: schedule.kind,
    ...(schedule.expression === undefined ? {} : { expression: schedule.expression }),
    timezone: schedule.timezone,
    enabled: schedule.kind !== "one_shot" && schedule.enabled,
    prompt: schedule.prompt,
    executionSnapshot: schedule.executionSnapshot,
    overlapPolicy: schedule.overlapPolicy,
    misfirePolicy: schedule.misfirePolicy,
    ...(nextRunAt === undefined ? {} : { nextRunAt }),
    lastRunAt: firedAt,
    expectedRevision: schedule.revision,
    now: Date.now()
  });
}

function timedExtensionInteractionTimeout(interaction: InteractionPayload): number | undefined {
  if (
    interaction.kind !== "extension_select" &&
    interaction.kind !== "extension_confirm" &&
    interaction.kind !== "extension_input"
  ) return undefined;
  const value = interaction.timeoutMs;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, 2_147_483_647)
    : undefined;
}

function clearPendingInteractionExpiry(interaction: PendingInteraction): void {
  if (interaction.expiryTimer !== undefined) clearTimeout(interaction.expiryTimer);
  if (interaction.abortSignal !== undefined && interaction.abortListener !== undefined) {
    interaction.abortSignal.removeEventListener("abort", interaction.abortListener);
  }
}

function servicePathIdentity(value: string): string {
  const normalized = resolve(value).replaceAll("\\", "/").replace(/\/+$/u, "");
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function nativeSessionCatalogEntryUsesManagedDirectory(
  targets: readonly StoredTarget[],
  entry: NativeSessionCatalogEntry
): boolean {
  const candidates = [entry.workingDirectory, entry.projectDirectory]
    .filter((value): value is string => value !== undefined);
  if (candidates.length === 0) return false;
  for (const target of targets) {
    if (!target.descriptor.managed || target.descriptor.remoteWorkspace !== undefined) continue;
    const root = resolve(target.descriptor.workspaceRoot);
    for (const candidate of candidates) {
      const child = relative(root, resolve(candidate));
      if (
        child === ""
        || (child !== ".." && !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(child))
      ) return true;
    }
  }
  return false;
}

async function sameServicePath(left: string, right: string): Promise<boolean> {
  const canonicalIdentity = async (value: string): Promise<string> => {
    try {
      return servicePathIdentity(await realpath(value));
    } catch {
      return servicePathIdentity(value);
    }
  };
  return (await canonicalIdentity(left)) === (await canonicalIdentity(right));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function derivationSourceMessageFromOperationBody(value: unknown): {
  readonly messageId: string;
  readonly eventId: string;
} | undefined {
  if (!isRecord(value)) return undefined;
  const messageId = value["sourceMessageId"];
  const eventId = value["sourceEventId"];
  if (typeof messageId !== "string" || messageId.trim() === "") return undefined;
  if (typeof eventId !== "string" || eventId.trim() === "") return undefined;
  return { messageId, eventId };
}
