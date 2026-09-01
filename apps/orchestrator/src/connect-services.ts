import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import { Code, ConnectError, type ConnectRouter, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import {
  PI_AUTO_COMPACTION_THRESHOLD_PERCENT_MAXIMUM,
  PI_AUTO_COMPACTION_THRESHOLD_PERCENT_MINIMUM,
  PiBackendAdapter,
  piProviderModel,
  type PiManagedModel,
  type PiManagedProvider,
  type PiSupportedApi
} from "@joko/adapter-pi";
import * as contract from "@joko/contracts";
import {
  DEFAULT_AGENT_RESOURCE_SETTINGS,
  DEFAULT_COLLABORATION_SETTINGS,
  type ManagedProcessPriority
} from "@joko/runtime-governance";
import { JokoError, redactSecrets, type BackendAdapter, type BackendDescriptor, type BackendToolDescriptor, type BlobRef, type DynamicInputFieldType, type InteractionDecision, type NativeSessionCandidate as CoreNativeSessionCandidate, type NativeSessionCatalogEntry as CoreNativeSessionCatalogEntry, type PermissionMode as CorePermissionMode, type PiNativeStateMetadata, type PromptInput, type ProviderModel, type RuntimeCommand, type RuntimeResource, type RuntimeToolCatalog, type SessionTree, type SessionTreeNode, type TurnExecutionOverrides } from "@joko/core";
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
  SensitiveDataError,
  StaleGenerationError,
  StoreClosedError,
  StoreError,
  MESSAGE_SEARCH_EMBEDDING_MODEL_ID,
  operationBodyHash
} from "@joko/store";
import type {
  ConnectionRecord,
  DeviceControlRelationRecord,
  DeviceRecord,
  InteractionRecord,
  OperationExecution,
  OperationRecord,
  OperationalStore,
  PersistedEvent,
  QueueItemRecord,
  ScheduleRecord,
  ScheduleDeletionCleanupFailure,
  ScheduleDeletionCleanupRecord,
  ScheduleDeletionDisposition,
  SessionLifecycleCleanupRecord,
  StoredRun,
  StoredSession,
  StoredTarget
} from "@joko/store";
import {
  BrowserTakeoverConflictError,
  BrowserTakeoverInputError,
  BrowserTakeoverRateLimitError,
  sameTakeoverFence,
  validateTakeoverInput,
  validateTakeoverNavigationUrl,
  type BrowserActivity as NativeBrowserActivity,
  type BrowserCommentDesignUpdate,
  type BrowserCommentInspectionInput,
  type BrowserCommentPlacement as NativeBrowserCommentPlacement,
  type BrowserCommentTarget as NativeBrowserCommentTarget,
  type BrowserPageState as NativeBrowserPage,
  type BrowserProvider,
  type BrowserTakeoverFence,
  type BrowserTakeoverInput
} from "@joko/tool-browser";
import type { ArtifactRecord, ArtifactRepository, ArtifactStore } from "./artifact-store.js";
import {
  ArtifactMaintenanceScanChangedError,
  ArtifactMaintenanceScanExpiredError,
  type ArtifactMaintenance
} from "./artifact-maintenance.js";
import { NATIVE_PI_SETTINGS_DEFAULTS, type OrchestratorApplication, type SessionContextDefaultsResolver } from "./application.js";
import { projectBackgroundTaskHistory } from "./background-task-history.js";
import {
  modelRoutingEnabled,
  readBackendModelAccess,
  writeBackendModelAccess
} from "./backend-model-access.js";
import type { BlobTransferCoordinator } from "./blob-transfers.js";
import {
  BROWSER_AUTOMATION_ACTIONS,
  assertActionCapabilities,
  type BrowserAutomationInputArtifact,
  type BrowserAutomationNodeExecutor,
  type BrowserAutomationNodeProjection
} from "./browser-automation-node.js";
import {
  BrowserSettingsEffectError,
  BrowserSettingsValidationError,
  type BrowserSettingsController
} from "./browser-settings.js";
import type { BrowserTransferCoordinator } from "./browser-transfers.js";
import type { AndroidAutomationSettingsController } from "./android-automation-settings.js";
import type { AndroidToolBridgeProvider } from "./android-tool-bridge.js";
import type { ComputerAutomationSettingsController } from "./computer-automation-settings.js";
import type { ComputerToolBridgeProvider } from "./computer-tool-bridge.js";
import { ConnectionAuthenticationError, PairingRequestError, type ConnectionManager } from "./connection-manager.js";
import type {
  CredentialDescriptor as NativeCredentialDescriptor,
  CredentialKind as NativeCredentialKind,
  CredentialManager,
  ManagedProviderEntry,
  ProviderCatalogManager,
  ProviderDescriptor as NativeProviderDescriptor,
  ProviderLoginFlow as NativeProviderLoginFlow
} from "./credential-manager.js";
import { ProviderAuthUnsupportedError } from "./credential-manager.js";
import type { DiagnosticsBundleService } from "./diagnostics-bundle.js";
import type { HistoryMaintenanceJob, HistoryMaintenanceResult, HistoryRetention } from "./history-maintenance.js";
import type {
  PiProviderAuthFlowRecord,
  PiProviderAuthPromptAnswer,
  PiProviderAuthPromptKind,
  PiProviderAuthPromptRecord,
  PiProviderAuthSupervisor
} from "./pi-provider-auth-supervisor.js";
import {
  clearProviderRateLimit,
  providerRateLimitSettingKey
} from "./provider-rate-limit.js";
import {
  PROVIDER_ACCOUNT_USAGE_CAPABILITY,
  type ProviderAccountUsageProvider,
  type ProviderAccountUsageSnapshot as NativeProviderAccountUsageSnapshot
} from "./provider-account-usage.js";
import type {
  McpCredentialBinding as NativeMcpCredentialBinding,
  McpRouter,
  McpServerDescriptor as NativeMcpServerDescriptor,
  McpServerInput as NativeMcpServerInput,
  McpServerState as NativeMcpServerState
} from "./mcp-router.js";
import {
  fromProtoEventCursor,
  fromProtoDuration,
  fromProtoBlobRef,
  fromProtoInputContent,
  fromProtoInteractionDecision,
  fromProtoRevision,
  fromProtoRemoteWorkspace,
  fromProtoTimestamp,
  mapErrorToProto,
  toProtoArtifact,
  toProtoBackend,
  toProtoBlobRef,
  toProtoConnection,
  toProtoContextUsage,
  toProtoDuration,
  toProtoEntityVersion,
  toProtoEvent,
  toProtoEventCursor,
  toProtoInteraction,
  toProtoInputContent,
  toProtoModelDescriptor,
  toProtoOperation as toProtoStoredOperation,
  toProtoProviderDescriptor,
  toProtoQueueItem,
  toProtoQueueControl,
  toProtoReviewRun,
  toProtoRevision,
  toProtoRuntimeCommand,
  toProtoRun,
  toProtoSchedule,
  toProtoSchedulerRuntime,
  toProtoSession,
  toProtoSubagentRun,
  toProtoSubagentRunDetail,
  toProtoSubagentTranscriptEntry,
  toProtoTarget,
  toProtoTimestamp,
  toProtoToolLease,
  toProtoUsage,
  toProtoWorkspace
} from "./proto-mapper.js";
import { ProtoMappingError } from "./proto-mapper.js";
import { TIMED_EXTENSION_INTERACTION_EXPIRED_REASON } from "./interaction-expiry.js";
import { BROWSER_TOOLS } from "./browser-tool-bridge.js";
import type { OperationalBrowserState, RecoverableBrowserPageRecord } from "./operational-browser-state.js";
import type { SessionHost, SessionRuntimeActivityKind } from "./session-host.js";
import type { ScheduleCoordinator } from "./schedule-coordinator.js";
import {
  defaultScheduleExtensionSnapshot,
  scheduleExtensionSnapshot,
  scheduleWorktreeConfiguration,
  withScheduleExtensionSnapshot,
  type ScheduleExtensionSnapshot,
  type SchedulePreRunHookConfiguration,
  type ScheduleScriptExecutionConfiguration
} from "./schedule-extensions.js";
import { nextOccurrence, type ScheduleTiming } from "./scheduler.js";
import { materializedSessionRuntimeState, SESSION_RUNTIME_STATE_SETTING_KEY } from "./session-runtime-state.js";
import {
  configuredSessionRuntimeFallback,
  SESSION_RUNTIME_FALLBACK_DEFAULT_ENABLED,
  SESSION_RUNTIME_FALLBACK_SETTING_KEY,
  sessionRuntimeFallbackCustomized
} from "./session-runtime-fallback.js";
import {
  materializedNativeStateObservation,
  nativeStateObservationIsCurrent,
  SESSION_NATIVE_STATE_OBSERVATION_SETTING_KEY,
  type MaterializedNativeStateObservation
} from "./native-state-observation.js";
import { materializedRuntimeCommands, SESSION_RUNTIME_COMMANDS_SETTING_KEY } from "./runtime-command-state.js";
import type {
  PiResourceDescriptor as NativePiResourceDescriptor,
  PiResourceKind as NativePiResourceKind,
  PiResourceManager,
  PiResourceState as NativePiResourceState
} from "./resource-manager.js";
import {
  normalizePiPackageSource,
  piPackageSourceIdentity,
  type PiPackageSource
} from "./resource-acquisition.js";
import {
  projectSnapshot as projectStoreSnapshot,
  sessionProjectionContext
} from "./snapshot-projector.js";
import { listProjectedToolCalls } from "./tool-call-projector.js";
import type { RewindPreviewRecord, SnapshotFile, WorkspaceChange, WorkspaceChangeSetRecord, WorkspaceChangeSetService } from "./workspace-change-set.js";
import {
  WorkspaceEntryMutationError,
  WorkspaceFilePreviewError,
  WorkspaceGitReviewError,
  WorkspaceSearchError,
  WorkspaceTextFileWriteError
} from "./workspace-service.js";
import type { GitState, WorkspaceEntryListingPolicy, WorkspaceEntryRecord, WorkspaceFilePreview, WorkspaceGitImageSide, WorkspaceGitPushResult, WorkspaceGitReviewSource, WorkspaceRegistration, WorkspaceSearchResult, WorkspaceService as NativeWorkspaceService } from "./workspace-service.js";
import type { WorkspaceFileChangeRecord, WorkspaceFileChangeScope } from "./workspace-change-stream.js";
import { moveManagedWorkspaceToTrash } from "./managed-workspace-trash.js";
import type { DiscoveredNodeRecord } from "./lan-discovery.js";
import type { MessageSearchEmbeddingCoordinator, MessageSearchSemanticMode } from "./message-search-embedding.js";
import { LANGUAGE_TOOL_SETTING_KEY, languageToolsEnabled } from "./lsp-tool-bridge.js";
import {
  MAKER_MEMORY_SETTING_KEY,
  type MakerMemoryBackendRole,
  type MakerMemoryController
} from "./maker-memory.js";
import {
  createModelRouteCatalog,
  normalizePromptRecommendationSettings,
  normalizeVisionBridgeSettings,
  type ModelRouteDescriptor,
  type ModelRouteRef,
  type PromptPredictionService,
  type VisionBridgeCoordinator
} from "./personalization-inference.js";
import type { SessionNavigationCoordinator } from "./session-navigation-coordinator.js";
import {
  evaluateSessionProjectPlacement,
  SessionProjectPlacementError,
  type ProjectPlacementSessionSnapshot,
  type ProjectPlacementTargetSnapshot,
  type SessionProjectPlacementPlan
} from "./session-project-placement.js";
import { ReviewStartError, type ReviewCoordinator } from "./review-coordinator.js";
import type { RuntimeActivityTracker } from "./runtime-activity-tracker.js";
import { createRemoteHostConnectService } from "./remote-host-connect-service.js";
import { createManagedModelRuntimeConnectService } from "./managed-model-runtime-connect-service.js";
import type { ManagedModelRuntimeController } from "./managed-model-runtime-controller.js";
import { PortableSessionPackageError } from "./portable-session-package.js";
import { PortableSessionExportTooLargeError } from "./portable-session-transfer.js";
import type { RemoteHostRegistry } from "./remote-host-registry.js";
import { createVoiceInputConnectService } from "./voice-input-connect-service.js";
import type { VoiceInputCoordinator } from "./voice-input-coordinator.js";
import {
  VoiceInputSettingsError,
  type VoiceInputSettingsController
} from "./voice-input-settings.js";
import { createWorktreeConnectService } from "./worktree-connect-service.js";
import { installSessionCodeHostContextRuntime } from "./session-code-host-context.js";
import type { SessionWorktreeCoordinator } from "./session-worktree-coordinator.js";
import { RuntimeProcessControl } from "./runtime-process-control.js";
import {
  DEFAULT_GIT_SAFETY_SETTINGS,
  GitSafetyCleanupBusyError,
  type GitSafetyCoordinator
} from "@joko/git-safety";
import type { RuntimeGovernanceSettingsRepository } from "./runtime-governance-settings.js";
import type { ToolPolicySettingsRepository } from "./tool-policy-settings.js";
import {
  POLICY_SETTINGS_KEY,
  PolicySettingsValidationError,
  validatePolicySettings
} from "./policy-settings.js";
import {
  ProjectAutomationConfigController,
  projectScheduleId,
  scheduleProjectAutomationOrigin,
  withoutScheduleProjectAutomationOrigin,
  withScheduleProjectAutomationOrigin
} from "./project-automation-config.js";
import {
  resolveDeclaredProviderCredentialSurface,
  validatedProviderCredentialSurfaces,
  type ResolvedProviderCredentialSurface
} from "./provider-credential-surface.js";

interface ConnectServiceDependencies {
  readonly connections: ConnectionManager;
  readonly store: OperationalStore;
  readonly adapters: () => readonly BackendAdapter[];
  readonly restartBackend?: (backendId: string) => Promise<void>;
  readonly refreshBackendDescriptor?: (backendId: string) => Promise<void>;
  readonly runtimeProcesses: RuntimeProcessControl;
  readonly sessionHost: SessionHost;
  readonly sessionWorktrees?: SessionWorktreeCoordinator;
  readonly runtimeActivity?: RuntimeActivityTracker;
  readonly runtimeGovernance?: RuntimeGovernanceSettingsRepository;
  readonly toolPolicies?: ToolPolicySettingsRepository;
  readonly gitSafety?: GitSafetyCoordinator;
  readonly workspaceService: NativeWorkspaceService;
  readonly workspaceChanges: WorkspaceChangeSetService;
  readonly artifactStore: ArtifactStore;
  readonly artifactMaintenance?: ArtifactMaintenance;
  readonly historyMaintenance: OrchestratorApplication["historyMaintenance"];
  readonly blobTransfers: BlobTransferCoordinator;
  readonly scheduleCoordinator: ScheduleCoordinator;
  readonly projectAutomations: ProjectAutomationConfigController;
  readonly artifactRepository?: ArtifactRepository;
  readonly browserProvider?: BrowserProvider;
  readonly browserTransfers?: BrowserTransferCoordinator;
  readonly browserSettings?: BrowserSettingsController;
  readonly browserAutomationNode?: BrowserAutomationNodeExecutor;
  readonly computerAutomation?: ComputerAutomationSettingsController;
  readonly computerBridge?: ComputerToolBridgeProvider;
  readonly androidAutomation?: AndroidAutomationSettingsController;
  readonly androidBridge?: AndroidToolBridgeProvider;
  readonly browserState?: OperationalBrowserState;
  readonly credentials?: CredentialManager;
  readonly providers?: ProviderCatalogManager;
  readonly managedModelRuntime?: ManagedModelRuntimeController;
  readonly mcpRouter?: McpRouter;
  readonly piResources?: PiResourceManager;
  readonly piBackendIds?: ReadonlySet<string>;
  readonly diagnosticsBundles?: DiagnosticsBundleService;
  readonly providerAuth?: PiProviderAuthSupervisor;
  readonly providerAccountUsage?: ProviderAccountUsageProvider;
  readonly messageSearch?: MessageSearchEmbeddingCoordinator;
  readonly makerMemory?: MakerMemoryController;
  readonly visionBridge?: VisionBridgeCoordinator;
  readonly promptPrediction?: PromptPredictionService;
  readonly sessionNavigation?: SessionNavigationCoordinator;
  readonly reviewCoordinator?: ReviewCoordinator;
  readonly remoteHosts?: RemoteHostRegistry;
  readonly voiceInput?: VoiceInputCoordinator;
  readonly voiceInputSettings?: VoiceInputSettingsController;
  readonly refreshPiGeneration?: () => Promise<void>;
  readonly resolveSessionContextDefaults?: SessionContextDefaultsResolver;
  readonly piSettingsDefaults?: OrchestratorApplication["piSettingsDefaults"];
  readonly providerLoginFlows: Map<string, NativeProviderLoginFlow>;
  readonly backendProviderLoginFlows: Map<string, BackendProviderLoginFlow>;
  readonly backendProviderLoginTails: Map<string, Promise<void>>;
  readonly diagnosticsArtifacts: Map<string, string>;
  readonly browserTransferOperations: Map<string, string>;
  readonly managedWorkspaceRoot?: string;
  /** Public, credential-free LAN bootstrap projection. */
  readonly discoveredNodes?: () => readonly DiscoveredNodeRecord[];
  readonly server?: {
    readonly id?: string;
    readonly displayName?: string;
    readonly version?: string;
    readonly apiVersion?: string;
    readonly publicOrigin?: string;
    readonly pairingEnabled?: boolean;
  };
  /** Changes whenever the in-memory Orchestrator runtime is replaced. Durable event cursors are fenced by it. */
  readonly generation?: bigint;
  readonly now?: () => number;
  /** Optional durable Browser activity projection supplied by the process composition root. */
  readonly browserActivities?: () => readonly NativeBrowserActivity[];
}

function toProtoRuntimeActivityKind(kind: SessionRuntimeActivityKind): contract.RuntimeActivityKind {
  switch (kind) {
    case "run": return contract.RuntimeActivityKind.RUN;
    case "queue_dispatch": return contract.RuntimeActivityKind.QUEUE_DISPATCH;
    case "interaction": return contract.RuntimeActivityKind.INTERACTION;
    case "tool_lease": return contract.RuntimeActivityKind.TOOL_LEASE;
    case "background_task": return contract.RuntimeActivityKind.BACKGROUND_TASK;
    case "compaction": return contract.RuntimeActivityKind.COMPACTION;
    case "user_shell": return contract.RuntimeActivityKind.USER_SHELL;
    case "session_lifecycle": return contract.RuntimeActivityKind.SESSION_LIFECYCLE;
    case "review": return contract.RuntimeActivityKind.REVIEW;
    case "operation": return contract.RuntimeActivityKind.OPERATION;
  }
}

function artifactProtectedSha256(values: readonly string[]): string[] {
  if (values.length > 1_000) throw invalidArgument("protected_sha256 has too many values");
  const normalized = [...new Set(values.map((value) => value.trim().toLowerCase()))].sort();
  if (normalized.some((value) => !/^[a-f0-9]{64}$/u.test(value))) {
    throw invalidArgument("protected_sha256 must contain SHA-256 values");
  }
  return normalized;
}

function fromProtoTaskHistoryRetention(value: contract.TaskHistoryRetention): HistoryRetention {
  switch (value) {
    case contract.TaskHistoryRetention.SEVEN_DAYS: return "7-days";
    case contract.TaskHistoryRetention.ONE_MONTH: return "1-month";
    case contract.TaskHistoryRetention.THREE_MONTHS: return "3-months";
    case contract.TaskHistoryRetention.SIX_MONTHS: return "6-months";
    default: throw invalidArgument("retention is required");
  }
}

function toProtoTaskHistoryRetention(value: HistoryRetention): contract.TaskHistoryRetention {
  switch (value) {
    case "7-days": return contract.TaskHistoryRetention.SEVEN_DAYS;
    case "1-month": return contract.TaskHistoryRetention.ONE_MONTH;
    case "3-months": return contract.TaskHistoryRetention.THREE_MONTHS;
    case "6-months": return contract.TaskHistoryRetention.SIX_MONTHS;
  }
}

function toProtoTaskHistoryResult(result: HistoryMaintenanceResult) {
  return {
    activeTaskCount: BigInt(result.activeTaskCount),
    deletedTaskCount: BigInt(result.deletedTaskCount),
    archivedTaskCount: BigInt(result.archivedTaskCount),
    messageCount: BigInt(result.messageCount),
    beforeBytes: BigInt(result.beforeBytes),
    afterBytes: BigInt(result.afterBytes),
    reclaimedBytes: BigInt(result.reclaimedBytes),
    backupCreated: result.backupCreated,
    skippedTaskCount: BigInt(result.skippedTaskCount)
  };
}

function toProtoTaskHistoryProgress(progress: HistoryMaintenanceJob) {
  const status = (() => {
    switch (progress.status) {
      case "running": return contract.TaskHistoryMaintenanceStatus.RUNNING;
      case "completed": return contract.TaskHistoryMaintenanceStatus.COMPLETED;
      case "scan-expired": return contract.TaskHistoryMaintenanceStatus.SCAN_EXPIRED;
      case "storage-changed": return contract.TaskHistoryMaintenanceStatus.STORAGE_CHANGED;
      case "cancelled": return contract.TaskHistoryMaintenanceStatus.CANCELLED;
      case "failed": return contract.TaskHistoryMaintenanceStatus.FAILED;
    }
  })();
  const phase = (() => {
    switch (progress.phase) {
      case "preparing": return contract.TaskHistoryMaintenancePhase.PREPARING;
      case "copying": return contract.TaskHistoryMaintenancePhase.COPYING;
      case "cleaning": return contract.TaskHistoryMaintenancePhase.CLEANING;
      case "compacting": return contract.TaskHistoryMaintenancePhase.COMPACTING;
      case "verifying": return contract.TaskHistoryMaintenancePhase.VERIFYING;
      case "installing": return contract.TaskHistoryMaintenancePhase.INSTALLING;
    }
  })();
  return {
    maintenanceId: progress.maintenanceId,
    status,
    phase,
    percent: progress.percent,
    cancellable: progress.cancellable,
    updatedAt: toProtoTimestamp(progress.updatedAt),
    ...(progress.result === undefined ? {} : { result: toProtoTaskHistoryResult(progress.result) })
  };
}

export interface ConnectServiceSet {
  readonly connection: ServiceImpl<typeof contract.ConnectionService>;
  readonly event: ServiceImpl<typeof contract.EventService>;
  readonly operation: ServiceImpl<typeof contract.OperationService>;
  readonly backend: ServiceImpl<typeof contract.BackendService>;
  readonly target: ServiceImpl<typeof contract.TargetService>;
  readonly session: ServiceImpl<typeof contract.SessionService>;
  readonly portableSession: ServiceImpl<typeof contract.PortableSessionService>;
  readonly run: ServiceImpl<typeof contract.RunService>;
  readonly subagent: ServiceImpl<typeof contract.SubagentService>;
  readonly review: ServiceImpl<typeof contract.ReviewService>;
  readonly queue: ServiceImpl<typeof contract.QueueService>;
  readonly scheduler: ServiceImpl<typeof contract.SchedulerService>;
  readonly interaction: ServiceImpl<typeof contract.InteractionService>;
  readonly workspace: ServiceImpl<typeof contract.WorkspaceService>;
  readonly worktree: ServiceImpl<typeof contract.WorktreeService>;
  readonly artifact: ServiceImpl<typeof contract.ArtifactService>;
  readonly historyMaintenance: ServiceImpl<typeof contract.HistoryMaintenanceService>;
  readonly credential: ServiceImpl<typeof contract.CredentialService>;
  readonly settings: ServiceImpl<typeof contract.SettingsService>;
  readonly managedModelRuntime: ServiceImpl<typeof contract.ManagedModelRuntimeService>;
  readonly tool: ServiceImpl<typeof contract.ToolService>;
  readonly browser: ServiceImpl<typeof contract.BrowserService>;
  readonly remoteHost: ServiceImpl<typeof contract.RemoteHostService>;
  readonly voiceInput: ServiceImpl<typeof contract.VoiceInputService>;
  readonly pi: ServiceImpl<typeof contract.PiService>;
}

function withConnectErrors<T extends object>(implementation: T): T {
  return new Proxy(implementation, {
    get(target, property, receiver) {
      const handler = Reflect.get(target, property, receiver) as unknown;
      if (typeof handler !== "function") return handler;
      return (...args: unknown[]) => {
        try {
          const result = Reflect.apply(handler, target, args) as unknown;
          if (isAsyncIterable(result)) return mapAsyncIterableErrors(result);
          if (isPromiseLike(result)) return Promise.resolve(result).catch((error: unknown) => { throw toConnectError(error); });
          return result;
        } catch (error) {
          throw toConnectError(error);
        }
      };
    }
  });
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return value !== null && typeof value === "object" && typeof (value as { then?: unknown }).then === "function";
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return value !== null && typeof value === "object" && Symbol.asyncIterator in value;
}

async function* mapAsyncIterableErrors(values: AsyncIterable<unknown>): AsyncGenerator<unknown> {
  try {
    yield* values;
  } catch (error) {
    throw toConnectError(error);
  }
}

function toConnectError(error: unknown): ConnectError {
  if (error instanceof ConnectError) return error;
  if (typeof error === "object" && error !== null && "name" in error && error.name === "AbortError") {
    return new ConnectError("The request was cancelled.", Code.Canceled);
  }
  if (error instanceof NotFoundError) return new ConnectError(error.message, Code.NotFound);
  if (error instanceof OperationConflictError) return new ConnectError(error.message, Code.AlreadyExists);
  if (error instanceof OperationPreviouslyFailedError) {
    const storedMessage = stringValue(asRecord(error.storedError)["message"]);
    return new ConnectError(redactSecrets(storedMessage ?? error.message), Code.FailedPrecondition);
  }
  if (error instanceof OperationInProgressError) return new ConnectError(error.message, Code.Aborted);
  if (error instanceof InvalidStateTransitionError) return new ConnectError(error.message, Code.FailedPrecondition);
  if (error instanceof RevisionConflictError || error instanceof StaleGenerationError) {
    return new ConnectError(error.message, Code.Aborted);
  }
  if (error instanceof AuthorizationError) return new ConnectError(error.message, Code.Unauthenticated);
  if (error instanceof PairingError) return new ConnectError("Pairing failed.", Code.PermissionDenied);
  if (error instanceof SensitiveDataError || error instanceof ProtoMappingError || error instanceof RangeError) {
    return new ConnectError(error.message, Code.InvalidArgument);
  }
  if (error instanceof BrowserSettingsValidationError) return new ConnectError(error.message, Code.InvalidArgument);
  if (error instanceof BrowserSettingsEffectError) return new ConnectError(error.message, Code.FailedPrecondition);
  if (error instanceof VoiceInputSettingsError) {
    return new ConnectError(
      error.message,
      error.code === "invalid" ? Code.InvalidArgument
        : error.code === "conflict" ? Code.Aborted
          : Code.FailedPrecondition
    );
  }
  if (error instanceof BrowserTakeoverConflictError) return new ConnectError(error.message, Code.FailedPrecondition);
  if (error instanceof BrowserTakeoverInputError) return new ConnectError(error.message, Code.InvalidArgument);
  if (error instanceof BrowserTakeoverRateLimitError) return new ConnectError(error.message, Code.ResourceExhausted);
  if (error instanceof StoreClosedError) return new ConnectError(error.message, Code.Unavailable);
  if (error instanceof AsyncTransactionError) return new ConnectError(error.message, Code.FailedPrecondition);
  if (error instanceof ProviderAuthUnsupportedError) return new ConnectError(error.message, Code.Unimplemented);
  if (error instanceof PortableSessionExportTooLargeError) {
    return new ConnectError(error.message, Code.ResourceExhausted);
  }
  if (error instanceof PortableSessionPackageError) {
    const code = error.code === "PASSWORD_REQUIRED" ? Code.FailedPrecondition
      : error.code === "CONTENT_LIMIT_EXCEEDED" ? Code.ResourceExhausted
        : Code.InvalidArgument;
    return new ConnectError(error.message, code);
  }
  if (error instanceof JokoError && error.publicError.code.startsWith("PORTABLE_SESSION_")) {
    const code = error.publicError.code.endsWith("_UNSUPPORTED") ? Code.Unimplemented
      : error.publicError.code.endsWith("_CONFLICT") ? Code.AlreadyExists
        : error.publicError.code.endsWith("_INVALID") ? Code.InvalidArgument
          : Code.FailedPrecondition;
    return new ConnectError(redactSecrets(error.publicError.message), code);
  }
  if (error instanceof WorkspaceFilePreviewError) {
    return new ConnectError(
      error.message,
      error.kind === "invalid" ? Code.InvalidArgument
        : error.kind === "stale" ? Code.Aborted
          : error.kind === "unsupported" ? Code.FailedPrecondition : Code.Internal
    );
  }
  if (error instanceof WorkspaceSearchError) {
    return new ConnectError(
      error.message,
      error.kind === "invalid" ? Code.InvalidArgument
        : error.kind === "result_changed" ? Code.Aborted : Code.Internal
    );
  }
  if (error instanceof WorkspaceEntryMutationError) return workspaceEntryMutationConnectError(error);
  if (error instanceof ReviewStartError) {
    const code = error.code === "REVIEW_SOURCE_CHANGED" ? Code.Aborted
      : error.code === "REVIEW_SOURCE_BUSY" ? Code.FailedPrecondition
      : error.code === "REVIEW_NOTHING_TO_REVIEW" ? Code.InvalidArgument
      : error.code === "REVIEW_ARTIFACT_UNAVAILABLE" ? Code.FailedPrecondition
      : Code.Unavailable;
    return new ConnectError(error.message, code);
  }
  if (error instanceof PairingRequestError) {
    return new ConnectError(
      error.message,
      error.code === "PAIRING_WINDOW_CLOSED" ? Code.FailedPrecondition : Code.ResourceExhausted
    );
  }
  if (error instanceof ConnectionAuthenticationError) {
    const code = error.code.startsWith("PAIRING_") ? Code.PermissionDenied : Code.Unauthenticated;
    return new ConnectError(error.code.startsWith("PAIRING_") ? "Pairing failed." : error.message, code);
  }
  if (error instanceof JokoError) {
    return new ConnectError(
      redactSecrets(error.publicError.message),
      jokoConnectCode(error.publicError)
    );
  }
  return new ConnectError("Orchestrator could not complete the request.", Code.Internal);
}

function jokoConnectCode(error: import("@joko/core").PublicError): Code {
  const code = error.code.toLocaleUpperCase("en-US");
  const phase = error.phase.toLocaleLowerCase("en-US");
  if (phase === "capability" || code.endsWith("_UNSUPPORTED")) return Code.Unimplemented;
  if (phase === "auth" || phase === "authentication") return Code.Unauthenticated;
  if (code.endsWith("_NOT_FOUND")) return Code.NotFound;
  if (code.endsWith("_LIMIT") || code.includes("_SIZE_LIMIT")) return Code.ResourceExhausted;
  if (error.stateMayHaveChanged) return Code.Aborted;
  return error.retryable ? Code.Unavailable : Code.FailedPrecondition;
}

interface OperationOutcome {
  readonly accepted: boolean;
  readonly resultCase?: contract.OperationResult["payload"]["case"];
  readonly entityId?: string;
  readonly unsupportedReason?: string;
  readonly compactSessionOutcome?: "compacted" | "noop";
  readonly memoryReset?: {
    readonly removedEntries: number;
    readonly removedTargets: number;
  };
  readonly scheduleRunsReadCount?: number;
  readonly scheduleDeletion?: {
    readonly scheduleId: string;
    readonly disposition: ScheduleDeletionDisposition;
    readonly generatedSessionIds: readonly string[];
    readonly completedSessionIds: readonly string[];
    readonly failures: readonly ScheduleDeletionCleanupFailure[];
    readonly inflightCount: number;
  };
  readonly workspaceRewind?: {
    readonly workspaceId: string;
    readonly changeSetId: string;
    readonly restoredPaths: readonly string[];
    readonly dialogueRewound: boolean;
    readonly filesRewound: boolean;
  };
  readonly workspaceGitPush?: {
    readonly kind: "pushed" | "needs_force";
    readonly remote: string;
    readonly remoteRef: string;
    readonly repositoryRevision: string;
    readonly headRevision: string;
    readonly remoteOid?: string;
    readonly ahead?: number;
    readonly behind?: number;
  };
  readonly providerLogin?: {
    readonly loginFlowId: string;
    readonly providerId: string;
    readonly method: NativeProviderLoginFlow["method"];
    readonly verificationUri?: string;
    readonly userCode?: string;
    readonly expiresAt?: number;
  };
  readonly browserTransferBinaryBase64?: string;
}

interface PresentedOperation {
  readonly record: OperationRecord<unknown>;
  readonly outcome: OperationOutcome;
}

interface HostMutationInput<T> {
  readonly operationId: string;
  readonly connection: ConnectionRecord;
  readonly kind: string;
  readonly body: unknown;
  readonly commit: (store: OperationalStore) => T;
  readonly precondition?: (store: OperationalStore) => void;
  readonly effect?: () => Promise<void>;
  readonly sessionLifecycleFenceId?: string;
  readonly complete?: (
    commit: () => OperationExecution<T>
  ) => Promise<OperationExecution<T>>;
  readonly preserveClaimOnEffectFailure?: (error: unknown) => boolean;
}

interface PageSlice<T> {
  readonly values: T[];
  readonly page: contract.PageInfo;
}

type ExtendedSessionHost = SessionHost & {
  validateTarget(target: import("@joko/core").TargetDescriptor): Promise<void>;
  listNativeSessions(targetId: string): Promise<readonly import("@joko/core").NativeSessionCandidate[]>;
  scanNativeSessionCatalog(backendId: string, force?: boolean): Promise<import("@joko/core").NativeSessionCatalogResult>;
  scanNativeSessionCatalogSnapshot(backendId: string, force?: boolean): Promise<{
    readonly token: string;
    readonly result: import("@joko/core").NativeSessionCatalogResult;
    readonly existingCount: number;
  }>;
  validateCatalogSessionReclassification(input: {
    readonly sessionId: string;
    readonly projectId?: string;
    readonly archived: boolean;
    readonly modifiedAt: number;
    readonly snapshotToken: string;
  }): Promise<{ readonly title: string; readonly archived: boolean; readonly modifiedAt: number }>;
  observeActiveResources(filter?: { readonly backendId?: string; readonly targetId?: string }): Promise<readonly {
    readonly backendId: string;
    readonly targetId: string;
    readonly sessionId: string;
    readonly generation: number;
    readonly resource: RuntimeResource;
  }[]>;
  resume(sessionId: string): Promise<void>;
  detach(sessionId: string): Promise<void>;
  close(sessionId: string): Promise<void>;
  deleteNativeSession(sessionId: string, lifecycleOperationId?: string): Promise<void>;
  setName(sessionId: string, name: string): Promise<void>;
  deriveSession(input: { readonly operationId: string; readonly connection: ConnectionRecord; readonly sourceSessionId: string; readonly title?: string; readonly kind: "fork" | "clone"; readonly entryId?: string }): Promise<OperationExecution<{ readonly sessionId: string }>>;
  abortRetry?(sessionId: string): Promise<void>;
  setAutoCompaction?(sessionId: string, enabled: boolean): Promise<void>;
  setAutoRetry?(sessionId: string, enabled: boolean): Promise<void>;
  executeUserShell(sessionId: string, input: import("@joko/core").UserShellInput, operationId?: string): Promise<import("@joko/core").UserShellResult>;
  abortUserShell(sessionId: string): Promise<void>;
  invokeAdapter<T>(sessionId: string, callback: (adapter: import("@joko/core").BackendAdapter, context: import("@joko/core").AdapterContext) => Promise<T>): Promise<T>;
  invokeBackendAdapter<T>(
    backendId: string,
    effect: (
      adapter: import("@joko/core").BackendAdapter,
      backendInstanceGeneration: number
    ) => T | Promise<T>
  ): Promise<T>;
  applyToActiveSessions(
    filter: { readonly backendId: string },
    effect: (sessionId: string, adapter: import("@joko/core").BackendAdapter, context: import("@joko/core").AdapterContext) => Promise<void>
  ): Promise<readonly string[]>;
};

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;
const DEFAULT_MESSAGE_SEARCH_PAGE_SIZE = 25;
const MAX_MESSAGE_SEARCH_PAGE_SIZE = 100;
const EVENT_STREAM_PAGE_SIZE = 1_000;
const STORE_QUERY_PAGE_SIZE = 100_000;
const DEVICE_PRESENCE_WINDOW_MS = 75_000;
const BROWSER_PROVIDER_ID = "browser";
const MANAGED_PROVIDER_CATALOG_CAPABILITY = "provider.managed_catalog";
const SILENT_ENCRYPTED_RETRY_SETTING_KEY = "settings.personalization.silent_encrypted_retry";
const SILENT_ENCRYPTED_RETRY_DEFAULT_ENABLED = true;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const RUNTIME_GENERATION = BigInt(Date.now());

/** Register all public v1 services. Every descriptor method receives a concrete handler. */
export function registerConnectServices(router: ConnectRouter, application: OrchestratorApplication): void {
  const services = createConnectServices(application);
  router.service(contract.ConnectionService, withConnectErrors(services.connection));
  router.service(contract.EventService, withConnectErrors(services.event));
  router.service(contract.OperationService, withConnectErrors(services.operation));
  router.service(contract.BackendService, withConnectErrors(services.backend));
  router.service(contract.TargetService, withConnectErrors(services.target));
  router.service(contract.SessionService, withConnectErrors(services.session));
  router.service(contract.PortableSessionService, withConnectErrors(services.portableSession));
  router.service(contract.RunService, withConnectErrors(services.run));
  router.service(contract.SubagentService, withConnectErrors(services.subagent));
  router.service(contract.ReviewService, withConnectErrors(services.review));
  router.service(contract.QueueService, withConnectErrors(services.queue));
  router.service(contract.SchedulerService, withConnectErrors(services.scheduler));
  router.service(contract.InteractionService, withConnectErrors(services.interaction));
  router.service(contract.WorkspaceService, withConnectErrors(services.workspace));
  router.service(contract.WorktreeService, withConnectErrors(services.worktree));
  router.service(contract.ArtifactService, withConnectErrors(services.artifact));
  router.service(contract.HistoryMaintenanceService, withConnectErrors(services.historyMaintenance));
  router.service(contract.CredentialService, withConnectErrors(services.credential));
  router.service(contract.SettingsService, withConnectErrors(services.settings));
  router.service(contract.ManagedModelRuntimeService, withConnectErrors(services.managedModelRuntime));
  router.service(contract.ToolService, withConnectErrors(services.tool));
  router.service(contract.BrowserService, withConnectErrors(services.browser));
  router.service(contract.RemoteHostService, withConnectErrors(services.remoteHost));
  router.service(contract.VoiceInputService, withConnectErrors(services.voiceInput));
  router.service(contract.PiService, withConnectErrors(services.pi));
}

export function createConnectServices(application: OrchestratorApplication): ConnectServiceSet {
  const providerLoginFlows = new Map<string, NativeProviderLoginFlow>();
  const backendProviderLoginFlows = new Map<string, BackendProviderLoginFlow>();
  const backendProviderLoginTails = new Map<string, Promise<void>>();
  const diagnosticsArtifacts = new Map<string, string>();
  const browserTransferOperations = new Map<string, string>();
  const projectAutomations = new ProjectAutomationConfigController({ store: application.store });
  const dependencies: ConnectServiceDependencies = {
    connections: application.connections,
    store: application.store,
    adapters: () => application.adapters,
    restartBackend: application.restartBackend,
    refreshBackendDescriptor: application.refreshBackendDescriptor,
    runtimeProcesses: new RuntimeProcessControl(
      application.store,
      (backendId, effect) => application.sessionHost.invokeBackendAdapter(backendId, effect)
    ),
    sessionHost: application.sessionHost,
    sessionWorktrees: application.sessionWorktrees,
    ...(application.runtimeActivity === undefined ? {} : { runtimeActivity: application.runtimeActivity }),
    ...(application.runtimeGovernance === undefined ? {} : { runtimeGovernance: application.runtimeGovernance }),
    ...(application.toolPolicies === undefined ? {} : { toolPolicies: application.toolPolicies }),
    ...(application.gitSafety === undefined ? {} : { gitSafety: application.gitSafety }),
    workspaceService: application.workspaces,
    workspaceChanges: application.workspaceChanges,
    artifactStore: application.artifacts,
    ...(application.artifactMaintenance === undefined ? {} : { artifactMaintenance: application.artifactMaintenance }),
    historyMaintenance: application.historyMaintenance,
    blobTransfers: application.blobTransfers,
    scheduleCoordinator: application.scheduler,
    projectAutomations,
    artifactRepository: application.artifactRepository,
    ...(application.browser === undefined ? {} : { browserProvider: application.browser }),
    ...(application.browserTransfers === undefined ? {} : { browserTransfers: application.browserTransfers }),
    ...(application.browserSettings === undefined ? {} : { browserSettings: application.browserSettings }),
    ...(application.browserAutomationNode === undefined ? {} : { browserAutomationNode: application.browserAutomationNode }),
    ...(application.computerAutomation === undefined ? {} : { computerAutomation: application.computerAutomation }),
    ...(application.computerBridge === undefined ? {} : { computerBridge: application.computerBridge }),
    ...(application.androidAutomation === undefined ? {} : { androidAutomation: application.androidAutomation }),
    ...(application.androidBridge === undefined ? {} : { androidBridge: application.androidBridge }),
    ...(application.browserState === undefined ? {} : { browserState: application.browserState }),
    ...(application.credentials === undefined ? {} : { credentials: application.credentials }),
    ...(application.providers === undefined ? {} : { providers: application.providers }),
    ...(application.managedModelRuntime === undefined ? {} : { managedModelRuntime: application.managedModelRuntime }),
    ...(application.mcpRouter === undefined ? {} : { mcpRouter: application.mcpRouter }),
    ...(application.piResources === undefined ? {} : { piResources: application.piResources }),
    piBackendIds: new Set(application.adapters
      .filter((adapter): adapter is PiBackendAdapter => adapter instanceof PiBackendAdapter)
      .map((adapter) => adapter.id)),
    ...(application.diagnosticsBundles === undefined ? {} : { diagnosticsBundles: application.diagnosticsBundles }),
    ...(application.providerAuth === undefined ? {} : { providerAuth: application.providerAuth }),
    ...(application.providerAccountUsage === undefined ? {} : { providerAccountUsage: application.providerAccountUsage }),
    ...(application.messageSearch === undefined ? {} : { messageSearch: application.messageSearch }),
    ...(application.makerMemory === undefined ? {} : { makerMemory: application.makerMemory }),
    ...(application.visionBridge === undefined ? {} : { visionBridge: application.visionBridge }),
    ...(application.promptPrediction === undefined ? {} : { promptPrediction: application.promptPrediction }),
    ...(application.sessionNavigation === undefined ? {} : { sessionNavigation: application.sessionNavigation }),
    ...(application.reviewCoordinator === undefined ? {} : { reviewCoordinator: application.reviewCoordinator }),
    ...(application.remoteHosts === undefined ? {} : { remoteHosts: application.remoteHosts }),
    ...(application.voiceInput === undefined ? {} : { voiceInput: application.voiceInput }),
    ...(application.voiceInputSettings === undefined ? {} : { voiceInputSettings: application.voiceInputSettings }),
    ...(application.refreshPiGeneration === undefined ? {} : { refreshPiGeneration: application.refreshPiGeneration }),
    ...(application.resolveSessionContextDefaults === undefined
      ? {}
      : { resolveSessionContextDefaults: application.resolveSessionContextDefaults }),
    ...(application.piSettingsDefaults === undefined ? {} : { piSettingsDefaults: application.piSettingsDefaults }),
    providerLoginFlows,
    backendProviderLoginFlows,
    backendProviderLoginTails,
    diagnosticsArtifacts,
    browserTransferOperations,
    ...(application.config.dataDirectory === undefined ? {} : { managedWorkspaceRoot: join(application.config.dataDirectory, "managed-workspaces") }),
    browserActivities: () => application.browserActivity,
    ...(application.lanDiscovery === undefined ? {} : { discoveredNodes: () => application.lanDiscovery.list() }),
    generation: RUNTIME_GENERATION,
    server: {
      id: application.serverId ?? "orchestrator",
      displayName: "Joko",
      version: "0.1.0",
      apiVersion: "joko.v1",
      publicOrigin: application.config.publicOrigin
    }
  };
  scheduleDeletionRetryDisposed.delete(application.store);
  sessionLifecycleRetryDisposed.delete(application.store);
  application.registerServiceCleanup?.(() => {
    cancelPendingScheduleDeletionRetries(application.store);
    cancelPendingSessionLifecycleRetries(application.store);
  });
  const now = dependencies.now ?? Date.now;
  const generation = dependencies.generation ?? 1n;
  const sessionCodeHostContext = installSessionCodeHostContextRuntime({
    store: dependencies.store,
    providers: application.codeHostProviders ?? [],
    now
  });
  if (typeof (application.store as Partial<OperationalStore>).listTargets === "function") {
    void Promise.all([
      recoverPendingSessionLifecycleCleanups(dependencies),
      recoverPendingScheduleDeletionCleanups(dependencies)
    ]).then(() => projectAutomations.reconcileAll(scheduleInput)).catch((error: unknown) => {
      if (typeof (application.store as Partial<OperationalStore>).appendDiagnostic !== "function") return;
      try {
        application.store.appendDiagnostic({
          severity: "warning",
          component: "scheduler",
          code: "PROJECT_AUTOMATION_RECONCILE_FAILED",
          message: "Project automation configuration could not be reconciled during startup.",
          details: { error: redactSecrets(error instanceof Error ? error.message : "unknown") }
        });
      } catch {
        // Startup reconciliation is best effort once the owning store has begun shutdown.
      }
    });
  }
  const operationMutations = new Map<string, contract.OperationMutation>();
  const operationOutcomes = new Map<string, OperationOutcome>();

  const authenticate = (context: HandlerContext): ConnectionRecord => requireAuthentication(dependencies, context);
  const remoteHost = createRemoteHostConnectService(
    dependencies.remoteHosts,
    (context) => ({ connectionId: authenticate(context).id }),
    (connectionId, listener) => dependencies.connections.onRevoked(connectionId, listener),
    now
  );
  const voiceInput = createVoiceInputConnectService(dependencies.voiceInput, dependencies.voiceInputSettings, (context) => ({
    connectionId: authenticate(context).id
  }));
  const managedModelRuntime = createManagedModelRuntimeConnectService(
    dependencies.managedModelRuntime,
    (context) => authenticate(context)
  );
  const worktree = createWorktreeConnectService(
    dependencies.sessionWorktrees,
    dependencies.store,
    (context) => ({ connectionId: authenticate(context).id })
  );

  const connection = {
    getServerInfo: () => ({ server: serverInfo(dependencies, now()) }),
    listDiscoveredNodes: () => ({
      nodes: (dependencies.discoveredNodes?.() ?? [fallbackDiscoveredNode(dependencies, now())])
        .map(toProtoDiscoveredNode)
    }),
    beginPairing: (request, context) => {
      const authorization = context.requestHeader.get("authorization");
      const owner = authorization !== null;
      if (owner) {
        dependencies.connections.authenticate(authorization);
        dependencies.connections.openPairingWindow();
      }
      const challenge = dependencies.connections.requestPairing(request.deviceDisplayName, {
        name: request.deviceDisplayName,
        kind: request.deviceKind === contract.DeviceKind.WEB
          ? "web"
          : request.deviceKind === contract.DeviceKind.DESKTOP
            ? "desktop"
            : request.deviceKind === contract.DeviceKind.SERVICE
              ? "service"
              : "unspecified",
        platform: request.platform,
        appVersion: request.appVersion
      });
      return {
        challenge: create(contract.PairingChallengeSchema, {
          challengeId: challenge.id,
          // Anonymous clients never receive the secret; an authenticated owner may explicitly reopen pairing.
          humanCode: owner ? challenge.code : "",
          verificationUri: `${dependencies.server?.publicOrigin ?? ""}/pair`,
          expiresAt: toProtoTimestamp(challenge.expiresAt)
        })
      };
    },
    completePairing: (request, context) => {
      let existingDevice: DeviceRecord | undefined;
      if (request.deviceId !== undefined) {
        const owner = authenticate(context);
        if (owner.deviceId !== request.deviceId) {
          throw new ConnectError("An existing Device may only add its own connection.", Code.PermissionDenied);
        }
        existingDevice = dependencies.store.getDevice(request.deviceId);
        if (existingDevice.state !== "active") {
          throw new ConnectError("The Device has been revoked.", Code.PermissionDenied);
        }
      }
      const completed = dependencies.connections.completePairing({
        challengeId: request.challengeId,
        code: request.humanCode,
        connectionName: request.deviceDisplayName,
        ...(existingDevice === undefined ? {} : {
          device: {
            id: existingDevice.id,
            name: existingDevice.name,
            kind: existingDevice.kind,
            platform: existingDevice.platform,
            appVersion: existingDevice.appVersion
          }
        })
      });
      const mapped = toProtoConnection(completed.connection);
      return {
        result: create(contract.PairingResultSchema, {
          connection: mapped,
          device: deviceFromRecord(
            dependencies.store.getDevice(completed.connection.deviceId),
            dependencies.store.listDeviceConnections(completed.connection.deviceId)
          ),
          authKey: completed.authKey
        })
      };
    },
    listConnections: (request, context) => {
      authenticate(context);
      const values = dependencies.store.listConnections()
        .filter((item) => request.state === undefined || connectionState(item) === request.state)
        .map(toProtoConnection);
      const result = paginate(values, request.page);
      return { connections: result.values, page: result.page };
    },
    getConnection: (request, context) => {
      authenticate(context);
      return { connection: toProtoConnection(dependencies.store.getConnection(request.connectionId)) };
    },
    listDevices: (request, context) => {
      authenticate(context);
      const observedAt = now();
      const values = dependencies.store.listDevices()
        .filter((item) => request.revoked === undefined || (item.state === "revoked") === request.revoked)
        .map((item) => deviceFromRecord(item, dependencies.store.listDeviceConnections(item.id), observedAt));
      const result = paginate(values, request.page);
      return { devices: result.values, page: result.page };
    },
    getDevice: (request, context) => {
      authenticate(context);
      const device = dependencies.store.getDevice(request.deviceId);
      return { device: deviceFromRecord(device, dependencies.store.listDeviceConnections(device.id), now()) };
    },
    listDeviceControlRelations: (request, context) => {
      authenticate(context);
      const observedAt = now();
      const values = dependencies.store.listDeviceControlRelations(request.deviceId || undefined)
        .map((relation) => deviceControlRelationFromRecord(dependencies.store, relation, observedAt));
      const result = paginate(values, request.page);
      return { relations: result.values, page: result.page };
    }
  } satisfies ServiceImpl<typeof contract.ConnectionService>;

  const event = {
    getSnapshot: async (request, context) => {
      authenticate(context);
      if (typeof (dependencies.store as Partial<OperationalStore>).listSessions === "function") {
        sessionCodeHostContext.refreshSessionsInBackground(dependencies.store
          .listSessions({ includeArchived: true, includeDeleted: false })
          .map((item) => item.descriptor.id));
      }
      const scope = request.scope ?? create(contract.SnapshotScopeSchema, {
        kind: { case: "owner", value: create(contract.OwnerSnapshotScopeSchema, {}) }
      });
      const projected = projectStoreSnapshot(dependencies.store, scope, {
        server: serverInfo(dependencies, now()),
        now,
        idFactory: randomUUID,
        timelinePageSize: 200,
        resolveSessionContextDefaults: dependencies.resolveSessionContextDefaults,
        resolveSessionRuntimeModel: ({ sessionId }) =>
          dependencies.sessionHost.getSessionRuntimeControl(sessionId).effective
      });
      const createdAt = now();
      const enriched = await enrichSnapshot(dependencies, projected, scope, createdAt, context.signal);
      return {
        snapshot: create(contract.SnapshotSchema, {
          ...enriched,
          reviewRuns: snapshotReviewRuns(dependencies.store, scope),
          generation,
          resumeCursor: toProtoEventCursor(fromProtoEventCursor(projected.resumeCursor).sequence, generation, createdAt),
          timeline: projected.timeline.map((item) => create(contract.EventSchema, {
            ...item,
            cursor: toProtoEventCursor(fromProtoEventCursor(item.cursor).sequence, generation, createdAt)
          }))
        })
      };
    },
    getRuntimeActivity: (_request, context) => {
      authenticate(context);
      const kinds = new Set<contract.RuntimeActivityKind>();
      const sampleSessionHost = (): void => {
        for (const kind of dependencies.sessionHost.inspectRuntimeActivity()) {
          kinds.add(toProtoRuntimeActivityKind(kind));
        }
      };

      // Sample volatile SessionHost state for the destructive-action probe:
      // state, inspect independent coordinators, then sample SessionHost again
      // to close the coordinator-read race. Any thrown probe rejects the RPC;
      // renderer callers deliberately treat that as busy (fail closed).
      sampleSessionHost();
      if (dependencies.scheduleCoordinator.hasInFlightActivity()) {
        kinds.add(contract.RuntimeActivityKind.SCHEDULE);
      }
      if (dependencies.reviewCoordinator?.hasInFlightActivity() === true) {
        kinds.add(contract.RuntimeActivityKind.REVIEW);
      }
      if (dependencies.browserTransfers?.hasInFlightActivity() === true) {
        kinds.add(contract.RuntimeActivityKind.BROWSER_TRANSFER);
      }
      sampleSessionHost();

      const observedAt = now();
      if (kinds.size > 0) dependencies.runtimeActivity?.markBlockingActivity();
      const lastBlockingActivityAt = dependencies.runtimeActivity?.lastBlockingActivityAt();
      const health = dependencies.store.health();
      const blockingKinds = [...kinds].sort((left, right) => left - right);
      return {
        summary: create(contract.RuntimeActivitySummarySchema, {
          blocksShutdown: blockingKinds.length > 0,
          blockingKinds,
          revision: toProtoRevision(health.revision),
          cursor: toProtoEventCursor(health.globalCursor, generation, observedAt),
          observedAt: toProtoTimestamp(observedAt),
          ...(lastBlockingActivityAt === undefined
            ? {}
            : { lastBlockingActivityAt: toProtoTimestamp(lastBlockingActivityAt) })
        })
      };
    },
    streamEvents: async function* (request, context) {
      const authenticated = authenticate(context);
      const queue = new AsyncEventQueue(context.signal);
      const stopRevocation = dependencies.connections.onRevoked(authenticated.id, () => queue.close());
      const unsubscribe = dependencies.store.subscribe((item) => queue.push(item));
      try {
        const highWater = dependencies.store.health().globalCursor;
        const after = request.afterCursor === undefined
          ? 0n
          : validateStreamCursor(request.afterCursor, generation, highWater);
        let scanned = after;
        while (scanned < highWater) {
          const page = dependencies.store.listEvents({ afterCursor: scanned, limit: EVENT_STREAM_PAGE_SIZE });
          let advanced = false;
          for (const item of page) {
            if (item.globalCursor > highWater) break;
            scanned = item.globalCursor;
            advanced = true;
            if (eventMatchesScope(item, request.scope, dependencies)) {
              dependencies.connections.fence(authenticated);
              yield { event: eventWithServiceCursor(item, dependencies, generation) };
            }
          }
          if (!advanced) {
            throw new ConnectError("The durable event history no longer contains the requested cursor; fetch a new snapshot.", Code.FailedPrecondition);
          }
        }
        let observed = highWater;
        while (!context.signal.aborted) {
          const item = await queue.next();
          if (item === undefined) break;
          if (item.globalCursor <= observed) continue;
          observed = item.globalCursor;
          if (!eventMatchesScope(item, request.scope, dependencies)) continue;
          dependencies.connections.fence(authenticated);
          yield { event: eventWithServiceCursor(item, dependencies, generation) };
        }
      } finally {
        unsubscribe();
        stopRevocation();
        queue.close();
      }
    }
  } satisfies ServiceImpl<typeof contract.EventService>;

  const operation = {
    submitOperation: async (request, context) => {
      const authenticated = authenticate(context);
      if (request.operationId.trim() === "") throw invalidArgument("operation_id is required");
      if (request.connectionId !== "" && request.connectionId !== authenticated.id) {
        throw new ConnectError("connection_id does not match the authenticated connection", Code.PermissionDenied);
      }
      if (request.mutation === undefined || request.mutation.payload.case === undefined) {
        throw invalidArgument("mutation.payload is required");
      }
      const existing = dependencies.store.findOperation(request.operationId);
      if (existing !== undefined) {
        if (existing.connectionId !== authenticated.id) {
          throw new AuthorizationError("The operation belongs to a different connection.");
        }
        const presentedHash = operationBodyHash(request.mutation);
        if (existing.bodyHash !== presentedHash) {
          throw new OperationConflictError(request.operationId, existing.bodyHash, presentedHash);
        }
        const existingOutcome = operationOutcomes.get(existing.id) ?? outcomeFromRecord(existing);
        operationMutations.set(existing.id, request.mutation);
        if (existing.status !== "started") operationOutcomes.set(existing.id, existingOutcome);
        return {
          operation: toProtoOperation(dependencies, existing, request.mutation, existingOutcome, now())
        };
      }
      let presented: PresentedOperation;
      try {
        presented = await dispatchMutation(dependencies, request.operationId, stableConnection(authenticated), request.mutation);
      } catch (error) {
        if (
          !(error instanceof OperationPreviouslyFailedError)
          && !(error instanceof OperationInProgressError)
        ) throw error;
        if (error.operationId !== request.operationId) throw error;
        const current = dependencies.store.getOperation(request.operationId);
        if (current.connectionId !== authenticated.id) {
          throw new AuthorizationError("The operation belongs to a different connection.");
        }
        const currentOutcome = outcomeFromRecord(current);
        operationMutations.set(current.id, request.mutation);
        if (current.status !== "started") operationOutcomes.set(current.id, currentOutcome);
        return {
          operation: toProtoOperation(dependencies, current, request.mutation, currentOutcome, now())
        };
      }
      operationMutations.set(request.operationId, request.mutation);
      operationOutcomes.set(request.operationId, presented.outcome);
      return { operation: toProtoOperation(dependencies, presented.record, request.mutation, presented.outcome, now()) };
    },
    getOperation: (request, context) => {
      authenticate(context);
      const record = dependencies.store.getOperation(request.operationId);
      return {
        operation: toProtoOperation(
          dependencies,
          record,
          operationMutations.get(record.id) ?? mutationFromRecord(dependencies.store, record),
          operationOutcomes.get(record.id) ?? outcomeFromRecord(record),
          now()
        )
      };
    },
    listOperations: (request, context) => {
      authenticate(context);
      const status = operationRecordStatus(request.state);
      const window = storePageWindow(request.page);
      const query = {
        ...(status === undefined ? {} : { status }),
        ...(request.sessionId === "" ? {} : { sessionId: request.sessionId }),
        ...(request.targetId === "" ? {} : { targetId: request.targetId }),
        limit: window.limit,
        offset: window.offset
      };
      const records = dependencies.store.listOperations(query);
      const values = records.map((record) => toProtoOperation(
        dependencies,
        record,
        operationMutations.get(record.id) ?? mutationFromRecord(dependencies.store, record),
        operationOutcomes.get(record.id) ?? outcomeFromRecord(record),
        now()
      ));
      const result = storePage(values, dependencies.store.countOperations(query), window);
      return { operations: result.values, page: result.page };
    },
    watchOperation: async function* (request, context) {
      const authenticated = authenticate(context);
      const queue = new AsyncEventQueue<"changed">(context.signal);
      const stopRevocation = dependencies.connections.onRevoked(authenticated.id, () => queue.close());
      let unsubscribeEvents = (): void => undefined;
      let unsubscribeOperations = (): void => undefined;
      try {
        // Subscribe before the first read so a terminal commit cannot land in
        // the read/yield-to-subscribe gap and leave this watcher asleep.
        unsubscribeEvents = dependencies.store.subscribe((item) => {
          if (item.operationId === request.operationId) queue.push("changed");
        });
        unsubscribeOperations = dependencies.store.subscribeOperationChanges((operationId) => {
          if (operationId === request.operationId) queue.push("changed");
        });
        let observedRevision = request.afterRevision === undefined ? 0n : fromProtoRevision(request.afterRevision, "after_revision");
        const record = dependencies.store.getOperation(request.operationId);
        if (record.revision > observedRevision) {
          dependencies.connections.fence(authenticated);
          yield {
            operation: toProtoOperation(
              dependencies,
              record,
              operationMutations.get(record.id) ?? mutationFromRecord(dependencies.store, record),
              operationOutcomes.get(record.id) ?? outcomeFromRecord(record),
              now()
            )
          };
          observedRevision = record.revision;
        }
        // Store operations are atomically committed. Terminal records need no open stream.
        if (record.status !== "started") return;
        while (!context.signal.aborted) {
          if (await queue.next() === undefined) return;
          const current = dependencies.store.getOperation(request.operationId);
          if (current.revision <= observedRevision) continue;
          dependencies.connections.fence(authenticated);
          yield {
            operation: toProtoOperation(
              dependencies,
              current,
              operationMutations.get(current.id) ?? mutationFromRecord(dependencies.store, current),
              operationOutcomes.get(current.id) ?? outcomeFromRecord(current),
              now()
            )
          };
          observedRevision = current.revision;
          if (current.status !== "started") return;
        }
      } finally {
        unsubscribeEvents();
        unsubscribeOperations();
        stopRevocation();
        queue.close();
      }
    }
  } satisfies ServiceImpl<typeof contract.OperationService>;

  const backend = {
    listBackends: (request, context) => {
      authenticate(context);
      const result = paginate(dependencies.store.listBackends().map(toProtoBackend), request.page);
      return { backends: result.values, page: result.page };
    },
    getBackend: (request, context) => {
      authenticate(context);
      return { backend: toProtoBackend(dependencies.store.getBackend(request.backendId)) };
    },
    listRuntimeProcesses: async (request, context) => {
      authenticate(context);
      const snapshot = await dependencies.runtimeProcesses.list(request.backendId);
      return {
        capturedAt: toProtoTimestamp(snapshot.capturedAt),
        processes: snapshot.processes.map((process) => create(contract.RuntimeProcessUsageSchema, {
          backendId: process.backendId,
          sessionId: process.sessionId,
          runtimeGeneration: BigInt(process.generation),
          processId: BigInt(process.pid),
          cpuPercent: process.cpuPercent,
          memoryKb: BigInt(process.memoryKb),
          processCount: process.processCount,
          terminable: process.terminable,
          ...(process.processInstanceId === undefined ? {} : { processInstanceId: process.processInstanceId })
        }))
      };
    },
    listProviders: async (request, context) => {
      authenticate(context);
      const records = request.backendId === ""
        ? dependencies.store.listBackends()
        : [dependencies.store.getBackend(request.backendId)];
      const providers: contract.ProviderDescriptor[] = [];
      for (const record of records) {
        if (managedProviderCatalogApplies(dependencies, record.descriptor.id)) {
          providers.push(...await Promise.all(dependencies.providers.list().map(async (provider) => mapProviderDescriptor(
            record.descriptor.id,
            provider,
            providerUsageSummary(dependencies, provider.provider.id, record.descriptor.id),
            providerRateLimit(dependencies, record.descriptor.id, provider.provider.id),
            await providerAccountUsageSnapshot(dependencies, provider, context.signal)
          ))));
          continue;
        }
        const providerIds = new Set<string>();
        for (const provider of record.descriptor.providers ?? []) {
          if (providerIds.has(provider.providerId)) continue;
          providerIds.add(provider.providerId);
          providers.push(await backendProviderDescriptorWithAccountUsage(
            dependencies,
            record.descriptor,
            provider.providerId,
            record.revision,
            toProtoProviderDescriptor(
              record.descriptor.id,
              provider.providerId,
              provider.api,
              backendAuthenticationAvailable(provider.authenticationState),
              record.revision,
              record.updatedAt,
              {
                login: provider.supportsLogin,
                logout: provider.supportsLogout,
                refresh: provider.supportsRefresh,
                modelRefresh: provider.supportsModelRefresh,
                loginMethods: provider.loginMethods,
                displayName: provider.displayName,
                authenticationState: provider.authenticationState,
                accessKind: provider.accessKind,
                accessProduct: provider.accessProduct,
                providesModelPricing: provider.providesModelPricing,
                credentialSurfaces: provider.credentialSurfaces
              }
            ),
            context.signal
          ));
        }
        for (const model of record.descriptor.models) {
          if (!providerIds.has(model.providerId)) {
            providerIds.add(model.providerId);
            providers.push(await backendProviderDescriptorWithAccountUsage(
              dependencies,
              record.descriptor,
              model.providerId,
              record.revision,
              toProtoProviderDescriptor(
                record.descriptor.id,
                model.providerId,
                model.api,
                backendAuthenticationAvailable(record.descriptor.authenticationState),
                record.revision,
                record.updatedAt,
                backendProviderOperations(record.descriptor)
              ),
              context.signal
            ));
          }
        }
      }
      const result = paginate(providers, request.page);
      return { providers: result.values, page: result.page };
    },
    getProvider: async (request, context) => {
      authenticate(context);
      const records = request.backendId === ""
        ? dependencies.store.listBackends().filter((record) => managedProviderCatalogApplies(dependencies, record.descriptor.id)
          ? dependencies.providers.list().some((provider) => provider.provider.id === request.providerId)
          : (record.descriptor.providers?.some((provider) => provider.providerId === request.providerId) === true
            || record.descriptor.models.some((model) => model.providerId === request.providerId)))
        : [dependencies.store.getBackend(request.backendId)];
      if (records.length === 0) throw new NotFoundError("Provider", request.providerId);
      if (records.length > 1) throw invalidArgument("backend_id is required when a Provider ID belongs to multiple Backend instances");
      const record = records[0]!;
      if (managedProviderCatalogApplies(dependencies, record.descriptor.id)) {
        const provider = dependencies.providers.get(request.providerId);
        return { provider: mapProviderDescriptor(
          record.descriptor.id,
          provider,
          providerUsageSummary(dependencies, provider.provider.id, record.descriptor.id),
          providerRateLimit(dependencies, record.descriptor.id, provider.provider.id),
          await providerAccountUsageSnapshot(dependencies, provider, context.signal)
        ) };
      }
      const explicit = record.descriptor.providers?.find((item) => item.providerId === request.providerId);
      const model = record.descriptor.models.find((item) => item.providerId === request.providerId);
      if (explicit === undefined && model === undefined) throw new NotFoundError("Provider", request.providerId);
      const mapped = toProtoProviderDescriptor(
        record.descriptor.id,
        explicit?.providerId ?? model!.providerId,
        explicit?.api ?? model!.api,
        backendAuthenticationAvailable(explicit?.authenticationState ?? record.descriptor.authenticationState),
        record.revision,
        record.updatedAt,
        explicit === undefined ? backendProviderOperations(record.descriptor) : {
          login: explicit.supportsLogin,
          logout: explicit.supportsLogout,
          refresh: explicit.supportsRefresh,
          modelRefresh: explicit.supportsModelRefresh,
          loginMethods: explicit.loginMethods,
          displayName: explicit.displayName,
          authenticationState: explicit.authenticationState,
          accessKind: explicit.accessKind,
          accessProduct: explicit.accessProduct,
          providesModelPricing: explicit.providesModelPricing,
          credentialSurfaces: explicit.credentialSurfaces
        }
      );
      return {
        provider: {
          ...await backendProviderDescriptorWithAccountUsage(
            dependencies,
            record.descriptor,
            request.providerId,
            record.revision,
            mapped,
            context.signal
          ),
          usage: providerUsageSummary(dependencies, request.providerId, record.descriptor.id),
          rateLimit: providerRateLimit(dependencies, record.descriptor.id, request.providerId)
        }
      };
    },
    getProviderUsage: async (request, context) => {
      authenticate(context);
      const records = request.backendId === ""
        ? dependencies.store.listBackends().filter((record) => managedProviderCatalogApplies(dependencies, record.descriptor.id)
          ? dependencies.providers.list().some((provider) => provider.provider.id === request.providerId)
          : (record.descriptor.providers?.some((provider) => provider.providerId === request.providerId) === true
            || record.descriptor.models.some((model) => model.providerId === request.providerId)))
        : [dependencies.store.getBackend(request.backendId)];
      if (records.length === 0) throw new NotFoundError("Provider", request.providerId);
      if (records.length > 1) throw invalidArgument("backend_id is required when a Provider ID belongs to multiple Backend instances");
      const backend = records[0]!;
      const managedProvider = managedProviderCatalogApplies(dependencies, backend.descriptor.id);
      let provider: NativeProviderDescriptor | undefined;
      if (managedProvider) {
        provider = dependencies.providers.get(request.providerId);
      } else if (backend.descriptor.providers?.some((item) => item.providerId === request.providerId) !== true
        && !backend.descriptor.models.some((model) => model.providerId === request.providerId)) {
        throw new NotFoundError("Provider", request.providerId);
      }
      const nativeAccountUsage = provider !== undefined
        ? undefined
        : await backendProviderAccountUsageSnapshot(
            dependencies,
            backend.descriptor,
            request.providerId,
            context.signal
          );
      return {
        usage: providerUsageSummary(dependencies, request.providerId, backend.descriptor.id),
        rateLimit: providerRateLimit(dependencies, backend.descriptor.id, request.providerId),
        ...(provider === undefined
          ? nativeAccountUsage === undefined ? {} : { accountUsage: nativeAccountUsage }
          : { accountUsage: await providerAccountUsageSnapshot(dependencies, provider, context.signal) })
      };
    },
    getUsageHistory: (request, context) => {
      authenticate(context);
      const days = request.days === 0 ? 140 : request.days;
      if (!Number.isSafeInteger(days) || days < 1 || days > 366) {
        throw invalidArgument("Usage history days must be between 1 and 366.");
      }
      if (request.backendId !== "") dependencies.store.getBackend(request.backendId);
      if (request.providerId !== "") assertUsageProvider(dependencies, request.providerId, request.backendId || undefined);
      return { history: usageHistory(dependencies, days, request.backendId || undefined, request.providerId || undefined) };
    },
    getModelPriceOverride: (request, context) => {
      authenticate(context);
      return {
        price: modelPriceOverrideView(dependencies, request.backendId, request.providerId, request.modelId)
      };
    },
    setModelPriceOverride: (request, context) => {
      authenticate(context);
      const desired = request.desired;
      if (desired === undefined) throw invalidArgument("A model price is required.");
      const reference = modelPriceReference(dependencies, request.backendId, request.providerId, request.modelId);
      const currencyCode = modelPriceCurrencyCode(desired.currency);
      const quote = {
        currencyCode,
        inputCostMicrosPerMillion: safeUnsignedNumber(desired.inputCostMicrosPerMillion, "Model input price"),
        outputCostMicrosPerMillion: safeUnsignedNumber(desired.outputCostMicrosPerMillion, "Model output price"),
        ...(desired.cacheReadCostMicrosPerMillion === undefined ? {} : {
          cacheReadCostMicrosPerMillion: safeUnsignedNumber(desired.cacheReadCostMicrosPerMillion, "Model cache-read price")
        }),
        ...(desired.cacheWriteCostMicrosPerMillion === undefined ? {} : {
          cacheWriteCostMicrosPerMillion: safeUnsignedNumber(desired.cacheWriteCostMicrosPerMillion, "Model cache-write price")
        })
      };
      const ownerId = usageOwnerId(dependencies);
      if (reference.available && sameModelPrice(reference.quote, quote)) {
        dependencies.store.deleteModelPriceOverride(
          ownerId,
          reference.backendId,
          reference.providerId,
          reference.modelId
        );
      } else {
        dependencies.store.upsertModelPriceOverride({
          ownerId,
          backendId: reference.backendId,
          providerId: reference.providerId,
          modelId: reference.modelId,
          ...quote,
          updatedAt: (dependencies.now ?? Date.now)()
        });
      }
      return {
        price: modelPriceOverrideView(
          dependencies,
          reference.backendId,
          reference.providerId,
          reference.modelId
        )
      };
    },
    resetModelPriceOverride: (request, context) => {
      authenticate(context);
      const reference = modelPriceReference(dependencies, request.backendId, request.providerId, request.modelId);
      dependencies.store.deleteModelPriceOverride(
        usageOwnerId(dependencies),
        reference.backendId,
        reference.providerId,
        reference.modelId
      );
      return {
        price: modelPriceOverrideView(
          dependencies,
          reference.backendId,
          reference.providerId,
          reference.modelId
        )
      };
    },
    listModels: (request, context) => {
      authenticate(context);
      const records = request.backendId === ""
        ? dependencies.store.listBackends()
        : [dependencies.store.getBackend(request.backendId)];
      const providerAuthentication = new Map(
        dependencies.providers?.list().map((provider) => [provider.provider.id, provider.authenticationState] as const) ?? []
      );
      const values = records.flatMap((record) => backendCatalogModels(dependencies, record.descriptor)
        .filter((model) => request.providerId === "" || model.providerId === request.providerId)
        .map((model) => {
          const descriptor = toProtoModelDescriptor(record.descriptor.id, model);
          const authenticationState = managedProviderCatalogApplies(dependencies, record.descriptor.id)
            ? providerAuthentication.get(model.providerId)
            : undefined;
          descriptor.available = authenticationState === undefined
            ? backendAuthenticationAvailable(record.descriptor.authenticationState)
            : authenticationState === "authenticated" || authenticationState === "not_required";
          return descriptor;
        }));
      const result = paginate(values, request.page);
      return { models: result.values, page: result.page };
    },
    getProviderLoginFlow: async (request, context) => {
      authenticate(context);
      const backendFlow = dependencies.backendProviderLoginFlows.get(request.loginFlowId);
      if (backendFlow !== undefined) {
        const flow = await withBackendProviderLoginLock(dependencies, request.loginFlowId, async () => {
          const current = dependencies.backendProviderLoginFlows.get(request.loginFlowId);
          if (current === undefined) throw new ConnectError("Provider login flow not found.", Code.NotFound);
          return observeBackendProviderLoginFlow(dependencies, current);
        });
        const backend = dependencies.store.getBackend(flow.backendId).descriptor;
        return {
          loginFlow: mapProviderLoginFlow(request.loginFlowId, flow),
          authenticationState: mapAuthenticationState(backend.authenticationState),
          error: backend.error === undefined ? undefined : mapErrorToProto(backend.error)
        };
      }
      const flow = currentProviderLoginFlow(dependencies, request.loginFlowId);
      if (flow !== undefined && dependencies.providers !== undefined) {
        const provider = dependencies.providers.get(flow.providerId);
        return {
          loginFlow: mapProviderLoginFlow(request.loginFlowId, flow),
          authenticationState: mapAuthenticationState(provider.authenticationState),
          error: provider.error === undefined ? undefined : provisioningError("provider.login", provider.error)
        };
      }
      throw new ConnectError("Provider login flow not found.", Code.NotFound);
    }
  } satisfies ServiceImpl<typeof contract.BackendService>;

  const target = {
    listTargets: (request, context) => {
      authenticate(context);
      let records = dependencies.store.listTargets(request.backendId === "" ? undefined : request.backendId);
      if (request.searchQuery !== "") {
        const query = request.searchQuery.toLocaleLowerCase();
        records = records.filter((item) => item.descriptor.displayName.toLocaleLowerCase().includes(query));
      }
      const values = records.map(toProtoTarget)
        .filter((item) => request.state === undefined || item.state === request.state);
      const result = paginate(values, request.page);
      return { targets: result.values, page: result.page };
    },
    getTarget: (request, context) => {
      authenticate(context);
      return { target: toProtoTarget(dependencies.store.getTarget(request.targetId)) };
    }
  } satisfies ServiceImpl<typeof contract.TargetService>;

  const discoverNativeSessions = async (
    targetId: string,
    expectedBackendId?: string
  ): Promise<{ readonly target: StoredTarget; readonly candidates: readonly CoreNativeSessionCandidate[] }> => {
    if (targetId === "") throw invalidArgument("target_id is required");
    const target = dependencies.store.getTarget(targetId);
    if (expectedBackendId !== undefined && expectedBackendId !== "" && expectedBackendId !== target.descriptor.backendId) {
      throw new ConnectError("Target does not belong to the requested Backend.", Code.FailedPrecondition);
    }
    const discovery = dependencies.store.getBackend(target.descriptor.backendId).descriptor.capabilities.get("session.discovery");
    if (discovery?.supported !== true) {
      throw new ConnectError("Native session discovery is not supported by the Target's Backend.", Code.Unimplemented);
    }
    return {
      target,
      candidates: await (dependencies.sessionHost as ExtendedSessionHost).listNativeSessions(targetId)
    };
  };
  const session = {
    listSessions: async (request, context) => {
      authenticate(context);
      let records = dependencies.store.listSessions({
        ...(request.targetId === "" ? {} : { targetId: request.targetId }),
        includeArchived: request.archived ?? true,
        includeDeleted: false
      });
      if (request.backendId !== "") records = records.filter((item) => item.descriptor.backendId === request.backendId);
      if (request.archived !== undefined) records = records.filter((item) => item.descriptor.archived === request.archived);
      if (request.searchQuery !== "") {
        const query = request.searchQuery.toLocaleLowerCase();
        records = records.filter((item) => item.descriptor.title.toLocaleLowerCase().includes(query));
      }
      sessionCodeHostContext.refreshSessionsInBackground(records.map((item) => item.descriptor.id));
      const values = records.map((item) => mapSession(dependencies, item))
        .filter((item) => request.state === undefined || item.state === request.state);
      const result = paginate(values, request.page);
      return { sessions: result.values, page: result.page };
    },
    getSession: async (request, context) => {
      authenticate(context);
      sessionCodeHostContext.refreshSessionInBackground(request.sessionId);
      const stored = dependencies.store.getSession(request.sessionId);
      return { session: mapSession(dependencies, stored) };
    },
    discoverNativeSessions: async (request, context) => {
      authenticate(context);
      const discovered = await discoverNativeSessions(request.targetId);
      const result = paginate(discovered.candidates.map((candidate) =>
        mapNativeSessionCandidate(dependencies, discovered.target, candidate, now())), request.page);
      return { sessions: result.values, page: result.page };
    },
    scanNativeSessionCatalog: async (request, context) => {
      authenticate(context);
      const backendId = request.backendId.trim();
      if (backendId === "") throw invalidArgument("backend_id is required");
      const backend = dependencies.store.getBackend(backendId).descriptor;
      if (backend.capabilities.get("session.catalog")?.supported !== true) {
        throw new ConnectError("Local task catalog scanning is not supported by this Backend.", Code.Unimplemented);
      }
      const snapshot = await (dependencies.sessionHost as ExtendedSessionHost).scanNativeSessionCatalogSnapshot(
        backendId,
        request.force
      );
      const scanned = snapshot.result;
      assertNativeSessionCatalogResult(scanned);
      const catalogTargets = dependencies.store.listTargets(backendId);
      const targetIds = nativeSessionCatalogTargetIds(catalogTargets);
      const visibleEntries: Array<{
        readonly entry: CoreNativeSessionCatalogEntry;
        readonly existingSessionId?: string;
      }> = scanned.entries.map((entry) => {
        const existing = dependencies.store.findLiveSessionByNativeBinding(backendId, entry.nativeReference);
        return {
          entry,
          ...(existing === undefined ? {} : { existingSessionId: existing.descriptor.id })
        };
      });
      if (!Number.isSafeInteger(snapshot.existingCount) || snapshot.existingCount < 0) {
        throw new ConnectError("Backend returned an invalid native task catalog.", Code.Internal);
      }
      const observedAt = now();
      return {
        entries: visibleEntries.map(({ entry, existingSessionId }) => mapNativeSessionCatalogEntry(
          entry,
          entry.workingDirectory === undefined
            ? undefined
            : targetIds.get(serviceNodePathIdentity(entry.workingDirectory)),
          entry.projectDirectory === undefined
            ? undefined
            : targetIds.get(serviceNodePathIdentity(entry.projectDirectory)),
          existingSessionId,
          observedAt
        )),
        rejectedCount: BigInt(scanned.rejectedCount),
        existingCount: BigInt(snapshot.existingCount),
        snapshotToken: snapshot.token
      };
    },
    getNativeSessionTree: async (request, context) => {
      authenticate(context);
      const stored = dependencies.store.getSession(request.sessionId);
      const tree = await dependencies.sessionHost.getTree(request.sessionId);
      return { tree: nativeTree(request.sessionId, tree, stored.revision) };
    },
    getSessionStatistics: async (request, context) => {
      authenticate(context);
      return { statistics: await sessionStatistics(dependencies, request.sessionId) };
    },
    listRuntimeCommands: async (request, context) => {
      authenticate(context);
      const commands = await dependencies.sessionHost.getCommands(request.sessionId);
      return { commands: commands.map((command) => toProtoRuntimeCommand(command, request.sessionId)) };
    },
    listBackgroundTasks: (request, context) => {
      authenticate(context);
      const sessionId = request.sessionId.trim();
      if (sessionId === "") throw invalidArgument("session_id is required");
      const stored = dependencies.store.getSession(sessionId);
      const backend = dependencies.store.getBackend(stored.descriptor.backendId).descriptor;
      if (backend.capabilities.get(contract.capabilityNames.backgroundTasks)?.supported !== true) {
        throw new ConnectError(
          "Background task history is not supported by the Session's Backend.",
          Code.Unimplemented
        );
      }
      const values = projectBackgroundTaskHistory(
        dependencies.store.listSessionBackgroundTaskEvents(sessionId)
      ).filter((task) => request.state === undefined || task.state === request.state);
      const result = paginate(values, request.page);
      return { backgroundTasks: result.values, page: result.page };
    },
    listSessionTimeline: (request, context) => {
      authenticate(context);
      const aroundEventId = request.aroundEventId.trim();
      if (aroundEventId !== "" && request.beforeCursor !== undefined) {
        throw invalidArgument("around_event_id and before_cursor are mutually exclusive");
      }
      if (request.aroundEventId !== "" && aroundEventId === "") {
        throw invalidArgument("around_event_id must not be blank");
      }
      const before = request.beforeCursor === undefined
        ? undefined
        : validateStreamCursor(request.beforeCursor, generation, dependencies.store.health().globalCursor);
      const limit = Math.min(Math.max(request.limit || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
      if (aroundEventId !== "") {
        return {
          events: dependencies.store.listEventsAround(request.sessionId, aroundEventId, limit)
            .map((item) => eventWithServiceCursor(item, dependencies, generation)),
          nextBeforeCursor: undefined
        };
      }
      const page = dependencies.store.listEvents({
        sessionId: request.sessionId,
        ...(before === undefined ? {} : { beforeCursor: before }),
        order: "desc",
        limit: limit + 1
      });
      const hasMore = page.length > limit;
      const selected = page.slice(0, limit).reverse();
      return {
        events: selected.map((item) => eventWithServiceCursor(item, dependencies, generation)),
        nextBeforeCursor: hasMore && selected[0] !== undefined
          ? toProtoEventCursor(selected[0].globalCursor, generation, now())
          : undefined
      };
    },
    searchSessionMessages: async (request, context) => {
      authenticate(context);
      const scope = request.scope.case === "sessionId"
        ? { sessionId: request.scope.value }
        : request.scope.case === "targetId"
          ? { targetId: request.scope.value }
          : request.scope.case === "owner"
            ? { owner: true as const }
            : undefined;
      if (scope === undefined) {
        throw invalidArgument("scope must explicitly select a Session, Target, or owner search");
      }
      const requestedSize = request.page?.pageSize ?? 0;
      const limit = requestedSize === 0 ? DEFAULT_MESSAGE_SEARCH_PAGE_SIZE : requestedSize;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_MESSAGE_SEARCH_PAGE_SIZE) {
        throw invalidArgument(`page_size must be between 1 and ${MAX_MESSAGE_SEARCH_PAGE_SIZE}`);
      }
      try {
        const filters = nativeSessionMessageSearchFilters(request.filters);
        const semanticMode = nativeMessageSearchSemanticMode(request.semanticMode);
        const semanticRequested = semanticMode !== "keyword" && dependencies.messageSearch !== undefined;
        const initialGeneration = semanticRequested ? dependencies.messageSearch!.status() : undefined;
        const validated = dependencies.store.validateSessionMessageSearch({
          scope,
          query: request.query,
          ...(filters === undefined ? {} : { filters }),
          limit,
          semanticRequested,
          ...(initialGeneration?.providerId === undefined ||
            initialGeneration.providerGenerationId === undefined
            ? {}
            : {
                retrievalProviderId: initialGeneration.providerId,
                retrievalProviderGenerationId: initialGeneration.providerGenerationId,
                retrievalModelId: initialGeneration.modelId
              }),
          ...(request.page?.pageToken === undefined || request.page.pageToken === ""
            ? {}
            : { pageToken: request.page.pageToken })
        });
        const embedding = semanticMode === "keyword"
          ? { skipReason: "Semantic retrieval was disabled for this request." }
          : dependencies.messageSearch === undefined
            ? { skipReason: "Semantic retrieval is unavailable on this Orchestrator node; keyword search was used." }
            : validated.useSemantic
              ? await dependencies.messageSearch.embedQuery(validated.query, semanticMode)
              : { skipReason: "This result set is pinned to its first-page keyword fallback." };
        const finalGeneration = semanticRequested ? dependencies.messageSearch!.status() : undefined;
        const result = dependencies.store.searchSessionMessages({
          scope,
          query: validated.query,
          ...(filters === undefined ? {} : { filters }),
          limit,
          ...(embedding.semantic === undefined ? {} : { semantic: embedding.semantic }),
          ...(finalGeneration?.providerId === undefined ||
            finalGeneration.providerGenerationId === undefined
            ? {}
            : {
                retrievalProviderId: finalGeneration.providerId,
                retrievalProviderGenerationId: finalGeneration.providerGenerationId,
                retrievalModelId: finalGeneration.modelId
              }),
          ...(embedding.skipReason === undefined ? {} : { semanticSkipReason: embedding.skipReason }),
          ...(request.page?.pageToken === undefined || request.page.pageToken === ""
            ? {}
            : { pageToken: request.page.pageToken })
        });
        return {
          matches: result.matches.map((match) => create(contract.SessionMessageSearchMatchSchema, {
            sessionId: match.sessionId,
            eventId: match.eventId,
            timelineItemId: match.timelineItemId,
            role: match.role === "user"
              ? contract.SessionMessageSearchRole.USER
              : contract.SessionMessageSearchRole.ASSISTANT,
            kind: contract.SessionMessageSearchKind.TEXT_MESSAGE,
            snippet: match.snippet,
            createdAt: toProtoTimestamp(match.createdAt),
            score: match.score,
            ...(match.ftsRank === undefined ? {} : { ftsRank: match.ftsRank }),
            ...(match.vectorRank === undefined ? {} : { vectorRank: match.vectorRank })
          })),
          page: create(contract.PageInfoSchema, {
            nextPageToken: result.nextPageToken ?? "",
            totalSize: BigInt(result.totalSize)
          }),
          revision: toProtoRevision(result.revision),
          vectorUsed: result.vectorUsed,
          vectorSkipReason: result.vectorSkipReason ?? "",
          poolCapped: result.poolCapped
        };
      } catch (error) {
        if (error instanceof NotFoundError) throw error;
        if (error instanceof StoreClosedError) throw error;
        if (error instanceof ProtoMappingError) throw invalidArgument(error.message);
        if (error instanceof StoreError) throw invalidArgument(error.message);
        throw error;
      }
    },
    predictNextPrompt: async (request, context) => {
      authenticate(context);
      if (request.sessionId.trim() === "") throw invalidArgument("session_id is required");
      const expectedLastActivityAt = fromProtoTimestamp(
        request.expectedLastActivityAt,
        "expected_last_activity_at"
      );
      if (expectedLastActivityAt === undefined) throw invalidArgument("expected_last_activity_at is required");
      if (dependencies.promptPrediction === undefined) return { prompt: "" };
      const locale = dependencies.store.findSetting<{ readonly locale?: string }>(
        "service",
        "orchestrator",
        "settings.appearance"
      )?.value.locale ?? "en";
      return {
        prompt: await dependencies.promptPrediction.predict({
          sessionId: request.sessionId,
          expectedLastActivityAt,
          expectedGeneration: safeUnsignedNumber(request.expectedGeneration, "expected_generation"),
          locale,
          signal: context.signal
        })
      };
    },
    suggestSessionTitle: async (request, context) => {
      authenticate(context);
      if (request.sessionId.trim() === "") throw invalidArgument("session_id is required");
      if (dependencies.sessionNavigation === undefined) {
        return {
          title: "",
          status: contract.SessionTitleSuggestionStatus.PROVIDER_UNAVAILABLE
        };
      }
      const locale = dependencies.store.findSetting<{ readonly locale?: string }>(
        "service",
        "orchestrator",
        "settings.appearance"
      )?.value.locale ?? "en";
      const result = await dependencies.sessionNavigation.suggestTitle(request.sessionId, locale, context.signal);
      const status = result.status === "ok"
        ? contract.SessionTitleSuggestionStatus.OK
        : result.status === "no_material"
          ? contract.SessionTitleSuggestionStatus.NO_MATERIAL
          : result.status === "provider_unavailable"
            ? contract.SessionTitleSuggestionStatus.PROVIDER_UNAVAILABLE
            : contract.SessionTitleSuggestionStatus.GENERATION_FAILED;
      return { title: result.title, status };
    }
  } satisfies ServiceImpl<typeof contract.SessionService>;

  const portableSession = {
    exportPortableSession: async (request, context) => {
      authenticate(context);
      const sessionId = nonBlankRequest(request.sessionId, "session_id");
      const result = await dependencies.sessionHost.exportPortableSession({
        sessionId,
        ...(request.password === undefined ? {} : { password: request.password }),
        excludeMedia: request.excludeMedia,
        applicationVersion: dependencies.server?.version ?? "0.1.0"
      });
      return {
        artifact: toProtoBlobRef(result.artifact),
        fidelity: protoPortableSessionFidelity(result.fidelity),
        messageCount: BigInt(result.messageCount),
        mediaCount: BigInt(result.mediaCount),
        missingMediaCount: BigInt(result.missingMediaCount),
        workerCount: BigInt(result.workerCount),
        mediaBytes: BigInt(result.mediaBytes)
      };
    },
    inspectPortableSessionImport: async (request, context) => {
      const connection = authenticate(context);
      if (request.package === undefined) throw invalidArgument("package is required");
      const draft = await dependencies.sessionHost.inspectPortableSessionImport({
        connection: stableConnection(connection),
        package: fromProtoBlobRef(request.package)
      });
      return { draft: protoPortableSessionImportDraft(draft) };
    },
    unlockPortableSessionImport: async (request, context) => {
      const connection = authenticate(context);
      const draft = await dependencies.sessionHost.unlockPortableSessionImport({
        connection: stableConnection(connection),
        draftId: nonBlankRequest(request.draftId, "draft_id"),
        password: request.password
      });
      return { draft: protoPortableSessionImportDraft(draft) };
    },
    cancelPortableSessionImport: (request, context) => {
      const connection = authenticate(context);
      dependencies.sessionHost.cancelPortableSessionImport({
        connection: stableConnection(connection),
        draftId: nonBlankRequest(request.draftId, "draft_id")
      });
      return { cancelled: true };
    },
    commitPortableSessionImport: async (request, context) => {
      const connection = authenticate(context);
      const model = request.model?.model;
      if (request.model !== undefined && (
        model === undefined || model.providerId.trim() === "" || model.modelId.trim() === ""
      )) throw invalidArgument("model requires both provider_id and model_id");
      if (!request.useWorktree && (request.worktreeSourceRef !== undefined || request.refreshWorktreeRemote)) {
        throw invalidArgument("Worktree options require use_worktree");
      }
      const execution = await dependencies.sessionHost.commitPortableSessionImport({
        operationId: nonBlankRequest(request.operationId, "operation_id"),
        connection: stableConnection(connection),
        draftId: nonBlankRequest(request.draftId, "draft_id"),
        targetId: nonBlankRequest(request.targetId, "target_id"),
        ...(request.title === undefined ? {} : { title: request.title }),
        ...(model === undefined ? {} : { providerId: model.providerId, modelId: model.modelId }),
        ...(request.model?.effortId === undefined || request.model.effortId === ""
          ? {}
          : { effort: request.model.effortId }),
        fastMode: request.model?.fastMode ?? false,
        permissionMode: corePermission(request.permissionMode),
        planMode: request.planMode,
        overwrite: request.overwrite,
        ...(request.useWorktree ? {
          worktree: {
            ...(request.worktreeSourceRef === undefined ? {} : { sourceRef: request.worktreeSourceRef }),
            refreshRemote: request.refreshWorktreeRemote
          }
        } : {})
      });
      return {
        replayed: execution.replayed,
        result: create(contract.PortableSessionImportResultSchema, {
          sessionId: execution.value.sessionId,
          fidelity: protoPortableSessionFidelity(execution.value.fidelity),
          messageCount: BigInt(execution.value.messageCount),
          mediaCount: BigInt(execution.value.mediaCount),
          workerCount: BigInt(execution.value.workerCount),
          replacedSessionIds: [...execution.value.replacedSessionIds],
          status: protoPortableSessionImportStatus(execution.value.status),
          ...(execution.value.activationError === undefined
            ? {}
            : { activationError: mapErrorToProto(execution.value.activationError) })
        })
      };
    },
    retryPortableSessionActivation: async (request, context) => {
      const connection = authenticate(context);
      const result = await dependencies.sessionHost.retryPortableSessionActivation({
        connection: stableConnection(connection),
        sessionId: nonBlankRequest(request.sessionId, "session_id")
      });
      return {
        sessionId: result.sessionId,
        status: protoPortableSessionImportStatus(result.status),
        ...(result.activationError === undefined
          ? {}
          : { activationError: mapErrorToProto(result.activationError) })
      };
    }
  } satisfies ServiceImpl<typeof contract.PortableSessionService>;

  const run = {
    listRuns: (request, context) => {
      authenticate(context);
      const window = storePageWindow(request.page);
      const states = coreRunListStates(request.state);
      if (states?.length === 0) return { runs: [], page: storePage([], 0, window).page };
      const query = {
        ...(request.sessionId === "" ? {} : { sessionId: request.sessionId }),
        ...(request.targetId === "" ? {} : { targetId: request.targetId }),
        ...(states === undefined ? {} : { states }),
        limit: window.limit,
        offset: window.offset
      };
      const values = dependencies.store.listRuns(query).map((item) => mapRun(dependencies.store, item));
      const result = storePage(values, dependencies.store.countRuns(query), window);
      return { runs: result.values, page: result.page };
    },
    getRun: (request, context) => {
      authenticate(context);
      return { run: mapRun(dependencies.store, dependencies.store.getRun(request.runId)) };
    }
  } satisfies ServiceImpl<typeof contract.RunService>;

  const subagent = {
    listSubagentRuns: (request, context) => {
      authenticate(context);
      const sessionId = nonBlankRequest(request.sessionId, "session_id");
      requireSubagentCapability(dependencies, sessionId, contract.capabilityNames.subagentsList);
      const result = dependencies.store.listSubagentRuns({
        sessionId,
        ...(request.state === undefined
          ? {}
          : { state: coreSubagentRunState(request.state, "state") }),
        ...(request.page?.pageToken ? { pageToken: request.page.pageToken } : {}),
        limit: Math.min(Math.max(request.page?.pageSize || 50, 1), 100)
      });
      return {
        runs: result.runs.map((value) => toProtoSubagentRun(value)),
        page: create(contract.PageInfoSchema, {
          nextPageToken: result.nextPageToken ?? "",
          totalSize: BigInt(result.totalSize)
        })
      };
    },
    getSubagentRun: (request, context) => {
      authenticate(context);
      const sessionId = nonBlankRequest(request.sessionId, "session_id");
      const runId = nonBlankRequest(request.subagentRunId, "subagent_run_id");
      requireSubagentCapability(dependencies, sessionId, contract.capabilityNames.subagentsDetail);
      const projection = dependencies.store.getSessionSubagentRun(sessionId, runId);
      if (projection === undefined) throw new NotFoundError("Subagent run", runId);
      return {
        run: toProtoSubagentRunDetail(projection.run, {
          revision: projection.event.revision,
          generation: projection.event.generation,
          updatedAt: projection.event.emittedAt
        })
      };
    },
    listSubagentTranscript: (request, context) => {
      authenticate(context);
      const sessionId = nonBlankRequest(request.sessionId, "session_id");
      const runId = nonBlankRequest(request.subagentRunId, "subagent_run_id");
      requireSubagentCapability(dependencies, sessionId, contract.capabilityNames.subagentsTranscript);
      const projection = dependencies.store.getSessionSubagentRun(sessionId, runId);
      if (projection === undefined) throw new NotFoundError("Subagent run", runId);
      if (!projection.run.capabilities.viewFullTranscript) {
        throw new ConnectError("Full transcript is unavailable for this run.", Code.Unimplemented);
      }
      const result = dependencies.store.listSubagentTranscript({
        sessionId,
        subagentRunId: projection.run.id,
        ...(request.childId.trim() === "" ? {} : { childId: request.childId }),
        ...(request.page?.pageToken ? { pageToken: request.page.pageToken } : {}),
        limit: Math.min(Math.max(request.page?.pageSize || 50, 1), 200)
      });
      return {
        entries: result.entries.map(toProtoSubagentTranscriptEntry),
        page: create(contract.PageInfoSchema, {
          nextPageToken: result.nextPageToken ?? "",
          totalSize: BigInt(result.totalSize)
        }),
        tailPageToken: result.tailPageToken
      };
    }
  } satisfies ServiceImpl<typeof contract.SubagentService>;

  const review = {
    listReviewRuns: (request, context) => {
      authenticate(context);
      const window = storePageWindow(request.page);
      const query = {
        ...(request.sourceSessionId === undefined ? {} : { sourceSessionId: request.sourceSessionId }),
        ...(request.reviewerSessionId === undefined ? {} : { reviewerSessionId: request.reviewerSessionId }),
        ...(request.state === undefined ? {} : { state: coreReviewRunState(request.state) }),
        limit: window.limit,
        offset: window.offset
      };
      const values = dependencies.store.listReviewRuns(query).map((run) => mapStoredReviewRun(dependencies.store, run));
      const result = storePage(values, dependencies.store.countReviewRuns(query), window);
      return { reviewRuns: result.values, page: result.page };
    },
    getReviewRun: (request, context) => {
      authenticate(context);
      return { reviewRun: mapStoredReviewRun(dependencies.store, dependencies.store.getReviewRun(request.reviewRunId)) };
    }
  } satisfies ServiceImpl<typeof contract.ReviewService>;

  const queue = {
    listQueueItems: (request, context) => {
      authenticate(context);
      const window = storePageWindow(request.page);
      const states = coreQueueListStates(request.state);
      if (states?.length === 0) return { queueItems: [], page: storePage([], 0, window).page };
      const query = {
        ...(request.sessionId === "" ? {} : { sessionId: request.sessionId }),
        ...(request.targetId === "" ? {} : { targetId: request.targetId }),
        ...(states === undefined ? {} : { states }),
        limit: window.limit,
        offset: window.offset
      };
      const values = dependencies.store.listQueueItems(query)
        .map((item, index) => mapQueueItem(dependencies.store, item, BigInt(window.offset + index)));
      const result = storePage(values, dependencies.store.countQueueItems(query), window);
      return { queueItems: result.values, page: result.page };
    },
    getQueueControl: (request, context) => {
      authenticate(context);
      return { queueControl: mapQueueControl(dependencies.store, request.sessionId) };
    }
  } satisfies ServiceImpl<typeof contract.QueueService>;

  const scheduler = {
    listSchedules: (request, context) => {
      authenticate(context);
      let records = dependencies.store.listSchedules({
        ...(request.targetId === "" ? {} : { targetId: request.targetId }),
        ...(request.sessionId === "" ? {} : { sessionId: request.sessionId })
      });
      if (request.backendId !== "") records = records.filter((item) => item.backendId === request.backendId);
      const values = records.map((item) => mapSchedule(dependencies.store, item))
        .filter((item) => request.state === undefined || item.state === request.state);
      const result = paginate(values, request.page);
      return { schedules: result.values, page: result.page };
    },
    getSchedule: (request, context) => {
      authenticate(context);
      return { schedule: mapSchedule(dependencies.store, dependencies.store.getSchedule(request.scheduleId)) };
    },
    listScheduleRunHistory: (request, context) => {
      authenticate(context);
      const schedule = dependencies.store.getSchedule(request.scheduleId);
      const window = storePageWindow(request.page);
      const history = dependencies.store.listScheduleRuns(schedule.id, window.limit, window.offset);
      const values = toProtoSchedule(schedule, history, runMap(dependencies.store, history)).recentRuns;
      const result = storePage(values, dependencies.store.countScheduleRuns(schedule.id), window);
      return { history: result.values, page: result.page };
    },
    getSchedulerRuntime: (_request, context) => {
      authenticate(context);
      return { runtime: toProtoSchedulerRuntime(dependencies.scheduleCoordinator.runtimeSnapshot()) };
    }
  } satisfies ServiceImpl<typeof contract.SchedulerService>;

  const interaction = {
    listInteractions: (request, context) => {
      authenticate(context);
      const window = storePageWindow(request.page);
      const kind = coreInteractionListKinds(request.kind);
      const state = coreInteractionListState(request.state);
      if (kind?.length === 0 || state?.unsupported === true) {
        return { interactions: [], page: storePage([], 0, window).page };
      }
      const query = {
        ...(request.sessionId === "" ? {} : { sessionId: request.sessionId }),
        ...(request.runId === "" ? {} : { runId: request.runId }),
        ...(kind === undefined ? {} : { kinds: kind }),
        ...(state?.statuses === undefined ? {} : { statuses: state.statuses }),
        ...(state?.dismissalReason === undefined ? {} : { dismissalReason: state.dismissalReason }),
        ...(state?.excludeDismissalReason === undefined ? {} : { excludeDismissalReason: state.excludeDismissalReason }),
        limit: window.limit,
        offset: window.offset
      };
      const values = dependencies.store.listInteractions(query).map((item) => mapInteraction(dependencies.store, item));
      const result = storePage(values, dependencies.store.countInteractions(query), window);
      return { interactions: result.values, page: result.page };
    },
    getInteraction: (request, context) => {
      authenticate(context);
      return { interaction: mapInteraction(dependencies.store, dependencies.store.getInteraction(request.interactionId)) };
    }
  } satisfies ServiceImpl<typeof contract.InteractionService>;

  const workspace = {
    listWorkspaces: async (request, context) => {
      authenticate(context);
      let registrations = [...dependencies.workspaceService.listRegistrations()];
      if (request.targetId !== "") registrations = registrations.filter((item) => targetForWorkspace(dependencies.store, item.id)?.descriptor.id === request.targetId);
      const values = await Promise.all(registrations.map((item) => mapWorkspace(dependencies, item)));
      const result = paginate(values, request.page);
      return { workspaces: result.values, page: result.page };
    },
    getWorkspace: async (request, context) => {
      authenticate(context);
      const registration = requireWorkspace(dependencies.workspaceService, request.workspaceId);
      return { workspace: await mapWorkspace(dependencies, registration) };
    },
    watchWorkspaceFileChanges: async function* (request, context) {
      const authenticated = authenticate(context);
      const scope = nativeWorkspaceFileChangeScope(request.scope);
      if (scope.kind === "workspace") {
        requireWorkspace(dependencies.workspaceService, scope.workspaceId);
        assertWorkspaceFileWatchSupported(dependencies, scope.workspaceId);
      }
      const revoked = new AbortController();
      const stopRevocation = dependencies.connections.onRevoked(authenticated.id, () => revoked.abort());
      const signal = AbortSignal.any([context.signal, revoked.signal]);
      try {
        for await (const change of dependencies.workspaceService.watchChanges(scope, signal)) {
          if (scope.kind === "owner" && !workspaceFileWatchSupported(dependencies, change.workspaceId)) continue;
          dependencies.connections.fence(authenticated);
          yield { change: mapWorkspaceFileChange(change) };
        }
      } finally {
        stopRevocation();
        revoked.abort();
      }
    },
    listWorkspaceEntries: async (request, context) => {
      authenticate(context);
      const listingPolicy = nativeWorkspaceEntryListingPolicy(request.listingPolicy);
      const entries = await dependencies.workspaceService.list(request.workspaceId, request.parentRelativePath, {
        recursive: false,
        maximumEntries: 10_000,
        listingPolicy
      });
      const visible = request.includeHidden ? entries : entries.filter((item) => !isHiddenPath(item.path));
      const normalized = visible.map((item) => mapWorkspaceEntry(request.workspaceId, item));
      const revision = workspaceEntryListingRevision(normalized);
      const result = paginateWorkspaceEntries(normalized, request.page, revision);
      return {
        entries: result.values,
        page: result.page,
        revision: create(contract.RevisionSchema, { value: 0n, etag: revision })
      };
    },
    listWorkspaceFiles: async (request, context) => {
      authenticate(context);
      const result = await dependencies.workspaceService.listFiles(request.workspaceId, context.signal);
      return {
        relativePaths: [...result.paths],
        truncated: result.truncated,
        revision: create(contract.RevisionSchema, { value: 0n, etag: result.revision })
      };
    },
    readWorkspaceFile: async (request, context) => {
      authenticate(context);
      const maximum = safeByteCount(request.maximumBytes, 2 * 1024 * 1024);
      const start = safeByteCount(request.startByte, 0);
      const preview = await dependencies.workspaceService.preview(request.workspaceId, request.relativePath, start + maximum);
      if (request.expectedRevision !== undefined && request.expectedRevision.opaqueRevision !== "" && request.expectedRevision.opaqueRevision !== preview.entry.revision) {
        throw new ConnectError("Workspace file revision changed.", Code.Aborted);
      }
      let materialized: ArtifactRecord | undefined;
      if (preview.bytes === undefined && preview.text === undefined) {
        if (preview.entry.size > dependencies.artifactStore.maximumBlobBytes) {
          throw new ConnectError("Workspace file exceeds the configured Blob download limit.", Code.ResourceExhausted);
        }
        materialized = await dependencies.workspaceService.materializeFile(
          request.workspaceId,
          request.relativePath,
          preview.entry.revision,
          (handle, options) => dependencies.artifactStore.ingestFileHandle(handle, {
            ...options,
            fileName: basename(preview.entry.path),
            mimeType: preview.mediaType,
            expiresAt: Date.now() + 5 * 60 * 1000
          }),
          context.signal
        );
      }
      return { preview: await mapFilePreview(dependencies.artifactStore, request.workspaceId, preview, start, maximum, materialized) };
    },
    writeWorkspaceTextFile: async (request, context) => {
      authenticate(context);
      try {
        const target = targetForWorkspace(dependencies.store, request.workspaceId);
        if (target === undefined) {
          throw new ConnectError("Workspace is not attached to a durable Target.", Code.FailedPrecondition);
        }
        const backend = dependencies.store.getBackend(target.descriptor.backendId).descriptor;
        if (backend.capabilities.get("workspace.files.write")?.supported !== true) {
          throw new ConnectError("Backend does not support workspace.files.write.", Code.FailedPrecondition);
        }
        const result = await dependencies.workspaceService.writeTextFile(request.workspaceId, {
          path: request.relativePath,
          text: request.utf8Text,
          expectedRevision: request.expectedRevision?.opaqueRevision ?? ""
        });
        return {
          entry: mapWorkspaceEntry(request.workspaceId, result.entry, result.mediaType),
          previousRevision: preserveFileRevision(request.expectedRevision, result.previousRevision),
          newRevision: fileRevision(result.entry)
        };
      } catch (error) {
        throw workspaceTextFileConnectError(error);
      }
    },
    searchWorkspace: async (request, context) => {
      authenticate(context);
      const offset = decodePageToken(request.page?.pageToken ?? "");
      const pageSize = Math.min(Math.max(request.page?.pageSize || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
      const searchGlob = workspaceSearchPrefixGlob(request.relativePathPrefix);
      const result = await dependencies.workspaceService.searchPage(request.workspaceId, request.query, {
        ...(searchGlob === undefined ? {} : { glob: searchGlob }),
        maximumResults: pageSize,
        offset,
        caseSensitive: request.caseSensitive,
        regularExpression: request.regularExpression
      });
      return {
        matches: result.matches.map(mapWorkspaceSearchResult),
        page: create(contract.PageInfoSchema, {
          nextPageToken: result.nextOffset === undefined ? "" : encodePageToken(result.nextOffset),
          totalSize: BigInt(result.totalResults)
        }),
        revision: create(contract.RevisionSchema, { value: 0n, etag: result.revision }),
        truncated: result.truncated,
        totalFiles: BigInt(result.totalFiles)
      };
    },
    streamWorkspaceSearch: async function* (request, context) {
      const authenticated = authenticate(context);
      for await (const event of dependencies.workspaceService.searchStream(
        request.workspaceId,
        request.query,
        request.caseSensitive,
        context.signal
      )) {
        dependencies.connections.fence(authenticated);
        if (event.kind === "match") {
          yield {
            event: {
              case: "match" as const,
              value: mapWorkspaceSearchResult(event.match)
            }
          };
        } else if (event.kind === "end") {
          yield {
            event: {
              case: "end" as const,
              value: create(contract.WorkspaceSearchEndSchema, {
                truncated: event.truncated,
                totalMatches: BigInt(event.totalResults),
                totalFiles: BigInt(event.totalFiles),
                revision: create(contract.RevisionSchema, { value: 0n, etag: event.revision })
              })
            }
          };
        } else {
          yield {
            event: {
              case: "error" as const,
              value: create(contract.ErrorInfoSchema, {
                code: event.code,
                phase: "workspace_search",
                message: event.message,
                severity: contract.ErrorSeverity.RETRYABLE,
                retryable: true,
                queueImpact: contract.StateImpact.UNCHANGED,
                workspaceImpact: contract.StateImpact.UNCHANGED,
                nativeSessionImpact: contract.StateImpact.UNCHANGED,
                recoveryActions: [],
                diagnosticId: ""
              })
            }
          };
        }
      }
    },
    getGitStatus: async (request, context) => {
      authenticate(context);
      return { git: mapGitState(await dependencies.workspaceService.gitState(request.workspaceId)) };
    },
    getWorkspaceDiff: async (request, context) => {
      authenticate(context);
      const reviewSource = nativeWorkspaceReviewSource(request.source);
      if (reviewSource !== undefined) {
        try {
          const layers = await dependencies.workspaceService.gitReviewDiff(request.workspaceId, {
            source: reviewSource,
            ...(request.sourceRevision === "" ? {} : { sourceRevision: request.sourceRevision }),
            ...(request.expectedRepositoryRevision === "" ? {} : { expectedRepositoryRevision: request.expectedRepositoryRevision }),
            ...(request.expectedMergeBaseRevision === "" ? {} : { expectedMergeBaseRevision: request.expectedMergeBaseRevision }),
            paths: request.relativePaths,
            ignoreWhitespace: request.ignoreWhitespace
          });
          const raw = reviewSource === "staged"
            ? layers.index
            : reviewSource === "unstaged" ? layers.workingTree : layers.comparison;
          const parsed = parseWorkspaceDiff(request.workspaceId, raw, request.source);
          return {
            diff: create(contract.WorkspaceDiffSchema, {
              workspaceId: request.workspaceId,
              files: parsed.files,
              truncated: parsed.truncated,
              repositoryRevision: layers.repositoryRevision,
              source: request.source,
              ...(layers.sourceRevision === undefined ? {} : { sourceRevision: layers.sourceRevision }),
              ...(layers.requestedBaseRef === undefined ? {} : { requestedBaseRef: layers.requestedBaseRef }),
              ...(layers.resolvedBaseRef === undefined ? {} : { resolvedBaseRef: layers.resolvedBaseRef }),
              ...(layers.branchBaseWarning === undefined ? {} : {
                branchBaseWarning: create(contract.WorkspaceBranchBaseWarningSchema, {
                  code: contract.WorkspaceBranchBaseWarningCode.REQUESTED_BASE_MISSING,
                  requestedBaseRef: layers.branchBaseWarning.requestedBaseRef,
                  resolvedBaseRef: layers.branchBaseWarning.resolvedBaseRef
                })
              }),
              ...(layers.baseRevision === undefined ? {} : { baseRevision: layers.baseRevision }),
              ...(layers.headRevision === undefined ? {} : { headRevision: layers.headRevision }),
              ...(layers.mergeBaseRevision === undefined ? {} : { mergeBaseRevision: layers.mergeBaseRevision })
            })
          };
        } catch (error) {
          throw workspaceGitConnectError(error);
        }
      }
      if (request.source === contract.GitDiffSource.LAST_TURN) {
        throw new ConnectError("LAST_TURN is derived by filtering staged and unstaged Review files with persisted workspace change sets.", Code.FailedPrecondition);
      }
      if (request.source === contract.GitDiffSource.TURN_SET) {
        throw new ConnectError("TURN_SET is read through ListWorkspaceChangeSets and is not a Git diff layer.", Code.FailedPrecondition);
      }
      throw invalidArgument("An exact Review source is required for this diff request.");
    },
    readWorkspaceDiffFile: async (request, context) => {
      authenticate(context);
      try {
        const reviewSource = nativeWorkspaceReviewSource(request.source);
        if (reviewSource !== undefined) {
          const preview = await dependencies.workspaceService.readGitReviewFile(request.workspaceId, {
            path: request.relativePath,
            source: reviewSource,
            expectedRepositoryRevision: request.expectedRepositoryRevision,
            ...(request.sourceRevision === "" ? {} : { sourceRevision: request.sourceRevision }),
            ...(request.expectedMergeBaseRevision === "" ? {} : { expectedMergeBaseRevision: request.expectedMergeBaseRevision }),
            maximumBytes: safeByteCount(request.maximumBytes, 1_048_576)
          });
          return {
            text: create(contract.TextFilePreviewSchema, {
              utf8Text: preview.text,
              languageId: "markdown",
              startByte: 0n,
              endByte: BigInt(Buffer.byteLength(preview.text, "utf8")),
              totalLines: preview.text === "" ? 0 : preview.text.split(/\r?\n/gu).length
            }),
            truncated: preview.truncated,
            repositoryRevision: preview.repositoryRevision,
            mergeBaseRevision: preview.mergeBaseRevision ?? ""
          };
        }
        if (request.source === contract.GitDiffSource.LAST_TURN || request.source === contract.GitDiffSource.TURN_SET) {
          throw new ConnectError("The selected Review source is backed by persisted change sets, not a Git file preview.", Code.FailedPrecondition);
        }
        throw invalidArgument("An exact Review source is required for this file preview.");
      } catch (error) {
        throw workspaceGitConnectError(error);
      }
    },
    readWorkspaceDiffImage: async (request, context) => {
      authenticate(context);
      const source = nativeWorkspaceReviewSource(request.source);
      if (source === undefined) {
        if (request.source === contract.GitDiffSource.LAST_TURN || request.source === contract.GitDiffSource.TURN_SET) {
          throw new ConnectError("Change-set Review sources do not expose a mutable Git image layer.", Code.FailedPrecondition);
        }
        throw invalidArgument("A concrete staged, unstaged, commit, or branch image source is required.");
      }
      try {
        const preview = await dependencies.workspaceService.readGitDiffImage(request.workspaceId, {
          path: request.relativePath,
          ...(request.oldRelativePath === "" ? {} : { oldPath: request.oldRelativePath }),
          source,
          expectedRepositoryRevision: request.expectedRepositoryRevision,
          ...(request.sourceRevision === "" ? {} : { sourceRevision: request.sourceRevision }),
          ...(request.expectedMergeBaseRevision === "" ? {} : { expectedMergeBaseRevision: request.expectedMergeBaseRevision })
        });
        const [oldImage, newImage] = await Promise.all([
          mapWorkspaceDiffImageSide(dependencies.artifactStore, preview.oldImage, "Previous Review image"),
          mapWorkspaceDiffImageSide(dependencies.artifactStore, preview.newImage, "Current Review image")
        ]);
        return {
          oldImage,
          newImage,
          repositoryRevision: preview.repositoryRevision,
          mergeBaseRevision: preview.mergeBaseRevision ?? "",
          maximumBytes: BigInt(4 * 1024 * 1024)
        };
      } catch (error) {
        throw workspaceGitConnectError(error);
      }
    },
    listWorkspaceChangeSets: async (request, context) => {
      authenticate(context);
      const values = (await dependencies.workspaceChanges.listChangeSets({
        ...(request.workspaceId === "" ? {} : { workspaceId: request.workspaceId }),
        ...(request.sessionId === "" ? {} : { sessionId: request.sessionId })
      })).map(mapWorkspaceChangeSet);
      const result = paginate(values, request.page);
      return { changeSets: result.values, page: result.page };
    },
    previewWorkspaceRewind: async (request, context) => {
      authenticate(context);
      const changeSet = await dependencies.workspaceChanges.getChangeSet(request.changeSetId);
      if (changeSet === undefined) throw new ConnectError("Workspace change set not found.", Code.NotFound);
      if (changeSet.workspaceId !== request.workspaceId) {
        throw new ConnectError("Workspace change set does not belong to the requested workspace.", Code.FailedPrecondition);
      }
      const preview = await dependencies.workspaceChanges.previewRewind(changeSet.id);
      const session = dependencies.store.listSessions({ includeArchived: true, includeDeleted: true })
        .find((candidate) => candidate.descriptor.id === changeSet.sessionId);
      const backend = session === undefined ? undefined : dependencies.store.getBackend(session.descriptor.backendId).descriptor;
      const dialogueOnlyAvailable = changeSet.dialogueEntryId !== undefined &&
        session !== undefined &&
        backend?.capabilities.get("session.rewind")?.supported === true;
      return {
        preview: mapWorkspaceRewindPreview(
          changeSet,
          preview,
          dialogueOnlyAvailable,
          await buildInverseWorkspaceDiff(changeSet)
        )
      };
    }
  } satisfies ServiceImpl<typeof contract.WorkspaceService>;

  const artifact = {
    listArtifacts: (request, context) => {
      authenticate(context);
      const window = storePageWindow(request.page);
      const kind = coreArtifactListKind(request.kind);
      if (kind?.unsupported === true) return { artifacts: [], page: storePage([], 0, window).page };
      const query = {
        ...(request.sessionId === "" ? {} : { sessionId: request.sessionId }),
        ...(request.runId === "" ? {} : { runId: request.runId }),
        ...(kind?.kind === undefined ? {} : { kind: kind.kind }),
        limit: window.limit,
        offset: window.offset
      };
      const values = dependencies.store.listArtifacts(query).map(toProtoArtifact);
      const result = storePage(values, dependencies.store.countArtifacts(query), window);
      return { artifacts: result.values, page: result.page };
    },
    getArtifact: (request, context) => {
      authenticate(context);
      return { artifact: toProtoArtifact(dependencies.store.getArtifact(request.artifactId)) };
    },
    beginBlobUpload: async (request, context) => {
      authenticate(context);
      const ticket = await dependencies.blobTransfers.beginUpload({
        expectedSha256: request.sha256Hex || undefined,
        expectedSize: safeByteCount(request.byteSize, undefined),
        maximumSize: safeByteCount(request.byteSize, undefined),
        mimeType: request.mediaType || undefined,
        fileName: request.fileName || undefined
      });
      return {
        upload: create(contract.PendingBlobUploadSchema, {
          uploadId: ticket.uploadId,
          ticket: create(contract.BlobTransferTicketSchema, {
            ticketId: ticket.ticketId,
            blobId: "",
            direction: contract.TransferDirection.UPLOAD,
            relativeEndpoint: ticket.relativeEndpoint,
            expiresAt: toProtoTimestamp(ticket.expiresAt),
            maximumBytes: request.byteSize,
            requiredMediaType: request.mediaType
          }),
          expectedSha256Hex: request.sha256Hex,
          expectedByteSize: request.byteSize
        })
      };
    },
    completeBlobUpload: (request, context) => {
      authenticate(context);
      return { blob: directArtifactBlob(dependencies.blobTransfers.completeUpload(request.uploadId)) };
    },
    getBlobDownloadTicket: async (request, context) => {
      authenticate(context);
      const ticket = await dependencies.blobTransfers.beginDownload(request.blobId);
      const artifactRecord = dependencies.store.getArtifact(request.blobId);
      return {
        ticket: create(contract.BlobTransferTicketSchema, {
          ticketId: ticket.ticketId,
          blobId: request.blobId,
          direction: contract.TransferDirection.DOWNLOAD,
          relativeEndpoint: ticket.relativeEndpoint,
          expiresAt: toProtoTimestamp(ticket.expiresAt),
          maximumBytes: BigInt(artifactRecord.blob.byteLength),
          requiredMediaType: artifactRecord.blob.mimeType
        })
      };
    },
    getArtifactStorageStats: async (request, context) => {
      authenticate(context);
      if (dependencies.artifactMaintenance === undefined) {
        return {
          support: contract.CapabilitySupport.NOT_IMPLEMENTED,
          supportReason: "Artifact storage maintenance is unavailable on this service."
        };
      }
      const protectedSha256 = artifactProtectedSha256(request.protectedSha256);
      const stats = await dependencies.artifactMaintenance.stats(protectedSha256).catch(() => {
        throw new ConnectError("Artifact storage statistics could not be read.", Code.Internal);
      });
      return {
        support: contract.CapabilitySupport.SUPPORTED,
        supportReason: "",
        stats: {
          referenceCount: BigInt(stats.referenceCount),
          uniqueBlobCount: BigInt(stats.uniqueBlobCount),
          totalBytes: BigInt(stats.totalBytes),
          cacheReferenceCount: BigInt(stats.cacheReferenceCount),
          cacheBytes: BigInt(stats.cacheBytes),
          temporaryFileCount: BigInt(stats.temporaryFileCount),
          temporaryBytes: BigInt(stats.temporaryBytes)
        }
      };
    },
    scanArtifactStorage: async (request, context) => {
      authenticate(context);
      if (dependencies.artifactMaintenance === undefined) throw new ConnectError("Artifact storage maintenance is unavailable.", Code.Unimplemented);
      const scan = await dependencies.artifactMaintenance.scan(artifactProtectedSha256(request.protectedSha256)).catch(() => {
        throw new ConnectError("Artifact storage scan failed.", Code.Internal);
      });
      return {
        scan: {
          token: scan.token,
          expiresAt: toProtoTimestamp(scan.expiresAt),
          protectedReferenceCount: BigInt(scan.protectedReferenceCount),
          expiredReferenceCount: BigInt(scan.expiredReferenceCount),
          orphanBlobCount: BigInt(scan.orphanBlobCount),
          orphanBlobBytes: BigInt(scan.orphanBlobBytes),
          temporaryFileCount: BigInt(scan.temporaryFileCount),
          temporaryBytes: BigInt(scan.temporaryBytes),
          missingBlobCount: BigInt(scan.missingBlobCount),
          unsafeEntryCount: BigInt(scan.unsafeEntryCount),
          cleanableBytes: BigInt(scan.cleanableBytes)
        }
      };
    },
    reconcileArtifactStorage: async (request, context) => {
      authenticate(context);
      if (dependencies.artifactMaintenance === undefined) throw new ConnectError("Artifact storage maintenance is unavailable.", Code.Unimplemented);
      const result = await dependencies.artifactMaintenance.reconcile(artifactProtectedSha256(request.protectedSha256)).catch(() => {
        throw new ConnectError("Artifact storage reconciliation failed.", Code.Internal);
      });
      return {
        result: {
          healthy: result.healthy,
          missingBlobCount: BigInt(result.missingBlobCount),
          orphanBlobCount: BigInt(result.orphanBlobCount),
          unsafeEntryCount: BigInt(result.unsafeEntryCount)
        }
      };
    },
    cleanupArtifactStorage: async (request, context) => {
      authenticate(context);
      if (dependencies.artifactMaintenance === undefined) throw new ConnectError("Artifact storage maintenance is unavailable.", Code.Unimplemented);
      if (!/^[a-f0-9]{64}$/u.test(request.scanToken)) throw invalidArgument("scan_token is invalid");
      try {
        const result = await dependencies.artifactMaintenance.cleanup(
          request.scanToken,
          artifactProtectedSha256(request.protectedSha256)
        );
        return {
          outcome: contract.ArtifactStorageCleanupOutcome.COMPLETED,
          result: {
            expiredReferencesDeleted: BigInt(result.expiredReferencesDeleted),
            blobsRemoved: BigInt(result.blobsRemoved),
            temporaryFilesRemoved: BigInt(result.temporaryFilesRemoved),
            freedBytes: BigInt(result.freedBytes),
            skipped: BigInt(result.skipped)
          }
        };
      } catch (error) {
        if (error instanceof ArtifactMaintenanceScanExpiredError) {
          return { outcome: contract.ArtifactStorageCleanupOutcome.SCAN_EXPIRED };
        }
        if (error instanceof ArtifactMaintenanceScanChangedError) {
          return { outcome: contract.ArtifactStorageCleanupOutcome.STORAGE_CHANGED };
        }
        throw new ConnectError("Artifact storage cleanup failed.", Code.Internal);
      }
    }
  } satisfies ServiceImpl<typeof contract.ArtifactService>;

  const historyMaintenance = {
    getHistoryMaintenanceSupport: (_request, context) => {
      authenticate(context);
      const supported = dependencies.historyMaintenance.supported();
      return {
        support: supported ? contract.CapabilitySupport.SUPPORTED : contract.CapabilitySupport.NOT_IMPLEMENTED,
        supportReason: supported ? "" : "Task history maintenance requires a file-backed Orchestrator database."
      };
    },
    scanTaskHistory: (request, context) => {
      authenticate(context);
      const retention = fromProtoTaskHistoryRetention(request.retention);
      try {
        const scan = dependencies.historyMaintenance.scan({
          retention,
          includeActiveTasks: request.includeActiveTasks
        });
        return {
          scan: {
            scanId: scan.scanId,
            retention: toProtoTaskHistoryRetention(scan.retention),
            includeActiveTasks: scan.includeActiveTasks,
            scannedAt: toProtoTimestamp(scan.scannedAt),
            olderThan: toProtoTimestamp(scan.olderThan),
            expiresAt: toProtoTimestamp(scan.expiresAt),
            activeTaskCount: BigInt(scan.activeTaskCount),
            deletedTaskCount: BigInt(scan.deletedTaskCount),
            archivedTaskCount: BigInt(scan.archivedTaskCount),
            messageCount: BigInt(scan.messageCount),
            estimatedHistoryBytes: BigInt(scan.estimatedHistoryBytes),
            databaseBytes: BigInt(scan.databaseBytes),
            temporaryBytesRequired: BigInt(scan.temporaryBytesRequired),
            ...(scan.databaseVolumeFreeBytes === undefined
              ? {}
              : { databaseVolumeFreeBytes: BigInt(scan.databaseVolumeFreeBytes) })
          }
        };
      } catch {
        throw new ConnectError("Task history scan failed.", Code.Internal);
      }
    },
    beginTaskHistoryCleanup: (request, context) => {
      authenticate(context);
      if (!UUID_PATTERN.test(request.scanId)) throw invalidArgument("scan_id is invalid");
      try {
        return { progress: toProtoTaskHistoryProgress(
          dependencies.historyMaintenance.beginCleanup(request.scanId, request.backupEnabled)
        ) };
      } catch {
        throw new ConnectError("Task history cleanup could not be started.", Code.FailedPrecondition);
      }
    },
    getTaskHistoryCleanup: (request, context) => {
      authenticate(context);
      if (!UUID_PATTERN.test(request.maintenanceId)) throw invalidArgument("maintenance_id is invalid");
      const progress = dependencies.historyMaintenance.getCleanup(request.maintenanceId);
      if (progress === undefined) throw new ConnectError("Task history cleanup not found.", Code.NotFound);
      return { progress: toProtoTaskHistoryProgress(progress) };
    },
    cancelTaskHistoryCleanup: (request, context) => {
      authenticate(context);
      if (!UUID_PATTERN.test(request.maintenanceId)) throw invalidArgument("maintenance_id is invalid");
      const progress = dependencies.historyMaintenance.cancelCleanup(request.maintenanceId);
      if (progress === undefined) throw new ConnectError("Task history cleanup not found.", Code.NotFound);
      return { progress: toProtoTaskHistoryProgress(progress) };
    }
  } satisfies ServiceImpl<typeof contract.HistoryMaintenanceService>;

  const credential = {
    beginCredentialUpload: (request, context) => {
      const connection = authenticate(context);
      if (dependencies.credentials === undefined) return {};
      const kind = nativeCredentialKind(request.kind, true);
      const surfaceRequested = request.backendId !== "" || request.credentialSurfaceId !== "";
      let surfaceCredentialReferenceId: string | undefined;
      if (surfaceRequested) {
        if (request.backendId === "" || request.providerId === "" || request.credentialSurfaceId === "") {
          throw invalidArgument("backend_id, provider_id, and credential_surface_id are required together");
        }
        const resolved = resolveProviderCredentialSurface(
          dependencies,
          nonBlankRequest(request.backendId, "backend_id"),
          nonBlankRequest(request.providerId, "provider_id"),
          nonBlankRequest(request.credentialSurfaceId, "credential_surface_id")
        );
        if (kind !== resolved.surface.kind) {
          throw invalidArgument("Credential kind does not match the Provider credential surface");
        }
        surfaceCredentialReferenceId = resolved.credentialReferenceId;
      }
      const ticket = dependencies.credentials.createUploadTicket({
        ...(kind === undefined ? {} : { kind }),
        ...(request.providerId === "" ? {} : { providerId: request.providerId }),
        connectionId: connection.id,
        ...(surfaceCredentialReferenceId === undefined ? {} : { credentialReferenceId: surfaceCredentialReferenceId })
      });
      return {
        ticket: create(contract.CredentialUploadTicketSchema, {
          ticketId: ticket.credentialUploadTicketId,
          relativeEndpoint: `/v1/credentials/upload/${encodeURIComponent(ticket.credentialUploadTicketId)}`,
          expiresAt: toProtoTimestamp(ticket.expiresAt),
          maximumBytes: BigInt(ticket.maximumBytes)
        })
      };
    },
    listCredentials: (request, context) => {
      authenticate(context);
      if (dependencies.credentials === undefined) return { credentials: [], page: emptyPage(request.page) };
      reserveAllProviderCredentialSurfaces(dependencies);
      const result = paginate(dependencies.credentials.list({
        ...(request.providerId === "" ? {} : { providerId: request.providerId })
      }).map(mapCredentialDescriptor), request.page);
      return { credentials: result.values, page: result.page };
    },
    beginProviderLoginInputUpload: (request, context) => {
      const connection = authenticate(context);
      const flowId = nonBlankRequest(request.loginFlowId, "login_flow_id");
      const promptId = nonBlankRequest(request.promptId, "prompt_id");
      const backendFlow = dependencies.backendProviderLoginFlows.get(flowId);
      if (backendFlow !== undefined) {
        if (dependencies.credentials === undefined) {
          throw new ConnectError("The secure Provider input channel is not configured.", Code.Unimplemented);
        }
        requireActiveProviderLoginPrompt(backendFlow, promptId, ["secret", "manual_code"]);
        const ticket = dependencies.credentials.createProviderLoginInputTicket({
          flowId,
          promptId,
          connectionId: connection.id
        });
        return {
          ticket: create(contract.CredentialUploadTicketSchema, {
            ticketId: ticket.credentialUploadTicketId,
            relativeEndpoint: `/v1/credentials/upload/${encodeURIComponent(ticket.credentialUploadTicketId)}`,
            expiresAt: toProtoTimestamp(ticket.expiresAt),
            maximumBytes: BigInt(ticket.maximumBytes)
          })
        };
      }
      const supervisor = requireProviderAuth(dependencies);
      const flow = requireCurrentProviderLoginFlow(dependencies, flowId);
      requireActiveProviderLoginPrompt(flow, promptId, ["secret", "manual_code"]);
      let ticket: ReturnType<PiProviderAuthSupervisor["beginInputUpload"]>;
      try {
        ticket = supervisor.beginInputUpload({ flowId: flow.opaqueFlowId, promptId, connectionId: connection.id });
      } catch {
        throw new ConnectError("The Provider login prompt changed before an upload ticket could be created.", Code.FailedPrecondition);
      }
      return {
        ticket: create(contract.CredentialUploadTicketSchema, {
          ticketId: ticket.credentialUploadTicketId,
          relativeEndpoint: `/v1/credentials/upload/${encodeURIComponent(ticket.credentialUploadTicketId)}`,
          expiresAt: toProtoTimestamp(ticket.expiresAt),
          maximumBytes: BigInt(ticket.maximumBytes)
        })
      };
    },
    submitProviderLoginInput: async (request, context) => {
      const connection = authenticate(context);
      const flowId = nonBlankRequest(request.loginFlowId, "login_flow_id");
      const promptId = nonBlankRequest(request.promptId, "prompt_id");
      const backendFlow = dependencies.backendProviderLoginFlows.get(flowId);
      if (backendFlow !== undefined) {
        return withBackendProviderLoginLock(dependencies, flowId, async () => {
        const backendFlow = dependencies.backendProviderLoginFlows.get(flowId);
        if (backendFlow === undefined || backendFlow.state !== "pending") {
          throw new ConnectError("Provider login flow is no longer active.", Code.FailedPrecondition);
        }
        if (dependencies.credentials === undefined) {
          throw new ConnectError("The secure Provider input channel is not configured.", Code.Unimplemented);
        }
        const prompt = requireActiveProviderLoginPrompt(backendFlow, promptId, ["secret"]);
        if (request.input.case !== "credentialInputTicketId" || request.input.value.trim() === "") {
          throw invalidArgument("credential_input_ticket_id is required for sensitive Provider login input.");
        }
        let secret: string | undefined;
        let acceptedFlow: BackendProviderLoginFlow | undefined;
        try {
          secret = dependencies.credentials.consumeProviderLoginInput({
            credentialUploadTicketId: request.input.value,
            flowId,
            promptId: prompt.promptId,
            connectionId: connection.id
          });
          await dependencies.sessionHost.invokeBackendAdapter(backendFlow.backendId, async (adapter) => {
            const { operations } = backendProviderAccountOperations(
              dependencies,
              backendFlow.backendId,
              backendFlow.providerId,
              "provider.login",
              adapter
            );
            const result = await operations.beginLogin!({ method: "api_key", apiKey: secret! });
            if (result.method !== "api_key") throw new Error("Native Provider returned the wrong login method.");
          });
          const acceptedAt = (dependencies.now ?? Date.now)();
          acceptedFlow = updateBackendProviderLoginFlow(dependencies, backendFlow, {
            credentialAcceptedAt: acceptedAt,
            updatedAt: acceptedAt,
            pendingPrompt: undefined,
            error: undefined
          });
        } catch {
          const failed = updateBackendProviderLoginFlow(dependencies, backendFlow, {
            state: "error",
            updatedAt: (dependencies.now ?? Date.now)(),
            pendingPrompt: undefined,
            error: "Provider rejected the submitted login credential."
          });
          throw new ConnectError(
            mapProviderLoginFlow(flowId, failed).error?.message ?? "Provider login failed.",
            Code.FailedPrecondition
          );
        } finally {
          secret = undefined;
        }
        try {
          await dependencies.refreshBackendDescriptor?.(backendFlow.backendId);
          const completed = updateBackendProviderLoginFlow(dependencies, acceptedFlow!, {
            state: "completed",
            updatedAt: (dependencies.now ?? Date.now)(),
            pendingPrompt: undefined,
            error: undefined
          });
          return { loginFlow: mapProviderLoginFlow(flowId, completed) };
        } catch {
          const synchronizing = updateBackendProviderLoginFlow(dependencies, acceptedFlow!, {
            updatedAt: (dependencies.now ?? Date.now)(),
            pendingPrompt: undefined,
            error: "Provider credential was saved; account projection is still synchronizing."
          });
          return { loginFlow: mapProviderLoginFlow(flowId, synchronizing) };
        }
        });
      }
      const supervisor = requireProviderAuth(dependencies);
      const flow = requireCurrentProviderLoginFlow(dependencies, flowId);
      const prompt = requireActiveProviderLoginPrompt(flow, promptId);
      const answer = providerLoginPromptAnswer(prompt.kind, request.input);
      try {
        return {
          loginFlow: mapProviderLoginFlow(flowId, supervisor.submitInput({
            flowId: flow.opaqueFlowId,
            promptId,
            connectionId: connection.id,
            answer
          }))
        };
      } catch (error) {
        if (error instanceof ConnectError) throw error;
        throw new ConnectError("The Provider login prompt changed or rejected the submitted input.", Code.FailedPrecondition);
      }
    },
    cancelProviderLogin: async (request, context) => {
      authenticate(context);
      const flowId = nonBlankRequest(request.loginFlowId, "login_flow_id");
      const backendFlow = dependencies.backendProviderLoginFlows.get(flowId);
      if (backendFlow !== undefined) {
        return withBackendProviderLoginLock(dependencies, flowId, async () => {
        const backendFlow = dependencies.backendProviderLoginFlows.get(flowId);
        if (backendFlow === undefined) {
          throw new ConnectError("Provider login flow is no longer active.", Code.FailedPrecondition);
        }
        if (backendFlow.state !== "pending") {
          throw new ConnectError("Provider login flow is no longer active.", Code.FailedPrecondition);
        }
        if (backendFlow.credentialAcceptedAt !== undefined) {
          throw new ConnectError("Provider credential has already been accepted and cannot be cancelled.", Code.FailedPrecondition);
        }
        const at = (dependencies.now ?? Date.now)();
        try {
          if (backendFlow.nativeLoginId !== undefined) {
            await dependencies.sessionHost.invokeBackendAdapter(backendFlow.backendId, async (adapter) => {
              await backendProviderAccountOperations(
                dependencies,
                backendFlow.backendId,
                backendFlow.providerId,
                "provider.login",
                adapter
              ).operations.cancelLogin!(backendFlow.nativeLoginId!);
            });
          }
          const cancelled = updateBackendProviderLoginFlow(dependencies, backendFlow, {
            state: "cancelled",
            updatedAt: at,
            pendingPrompt: undefined,
            error: undefined
          });
          if (backendFlow.nativeLoginId !== undefined) {
            try {
              await dependencies.refreshBackendDescriptor?.(backendFlow.backendId);
            } catch {
              // The cancellation result is authoritative; descriptor refresh is independently retryable.
            }
          }
          return { loginFlow: mapProviderLoginFlow(flowId, cancelled) };
        } catch {
          const uncertain = updateBackendProviderLoginFlow(dependencies, backendFlow, {
            state: "outcome_unknown",
            updatedAt: at,
            pendingPrompt: undefined,
            error: "Provider login cancellation outcome is unknown."
          });
          return { loginFlow: mapProviderLoginFlow(flowId, uncertain) };
        }
        });
      }
      const supervisor = requireProviderAuth(dependencies);
      const flow = requireCurrentProviderLoginFlow(dependencies, flowId);
      if (flow.state !== "starting" && flow.state !== "pending") {
        throw new ConnectError("Provider login flow is no longer active.", Code.FailedPrecondition);
      }
      try {
        return { loginFlow: mapProviderLoginFlow(flowId, supervisor.cancel(flow.opaqueFlowId)) };
      } catch {
        throw new ConnectError("Provider login flow is no longer active.", Code.FailedPrecondition);
      }
    }
  } satisfies ServiceImpl<typeof contract.CredentialService>;

  const settings = {
    getSettings: (_request, context) => {
      authenticate(context);
      return { settings: settingsSnapshot(dependencies) };
    }
  } satisfies ServiceImpl<typeof contract.SettingsService>;

  const tool = {
    listToolProviders: (request, context) => {
      authenticate(context);
      const values = toolProviders(dependencies).filter((item) => request.kind === undefined || item.kind === request.kind);
      const result = paginate(values, request.page);
      return { providers: result.values, page: result.page };
    },
    getToolProvider: (request, context) => {
      authenticate(context);
      const provider = toolProviders(dependencies).find((item) => item.toolProviderId === request.toolProviderId);
      if (provider === undefined) throw new ConnectError("Tool Provider not found.", Code.NotFound);
      return { provider };
    },
    getRuntimeToolCatalog: async (request, context) => {
      authenticate(context);
      const sessionId = nonBlankRequest(request.sessionId, "session_id");
      const session = dependencies.store.getSession(sessionId);
      const backend = dependencies.store.getBackend(session.descriptor.backendId).descriptor;
      if (backend.capabilities.get("runtime.tools")?.supported !== true) {
        throw new ConnectError("The selected task does not expose a live runtime tool registry.", Code.FailedPrecondition);
      }
      return { catalog: mapRuntimeToolCatalog(await dependencies.sessionHost.getRuntimeTools(sessionId)) };
    },
    getToolCall: (request, context) => {
      authenticate(context);
      const call = listProjectedToolCalls(dependencies.store).find((item) => item.value.toolCallId === request.toolCallId);
      if (call === undefined) throw new ConnectError("Tool Call not found.", Code.NotFound);
      return { toolCall: call.value };
    },
    listToolCalls: (request, context) => {
      authenticate(context);
      const values = listProjectedToolCalls(dependencies.store, {
        ...(request.sessionId === "" ? {} : { sessionId: request.sessionId }),
        ...(request.runId === "" ? {} : { runId: request.runId })
      }).map((item) => item.value).filter((item) => request.state === undefined || item.state === request.state);
      const result = paginate(values, request.page);
      return { toolCalls: result.values, page: result.page };
    },
    listToolLeases: (request, context) => {
      authenticate(context);
      let records = dependencies.store.listToolLeases({
        ...(request.sessionId === "" ? {} : { sessionId: request.sessionId }),
        activeOnly: false
      });
      if (request.runId !== "") records = records.filter((item) => item.runId === request.runId);
      const values = records.map((item) => toProtoToolLease(item, dependencies.store.getSession(item.sessionId).descriptor.backendId))
        .filter((item) => request.state === undefined || item.state === request.state);
      const result = paginate(values, request.page);
      return { toolLeases: result.values, page: result.page };
    },
    listMcpServers: (request, context) => {
      authenticate(context);
      if (dependencies.mcpRouter === undefined) return { servers: [], page: emptyPage(request.page) };
      const state = request.state === undefined ? undefined : nativeMcpState(request.state);
      const result = paginate(dependencies.mcpRouter.list(state).map(mapMcpServerDescriptor), request.page);
      return { servers: result.values, page: result.page };
    }
  } satisfies ServiceImpl<typeof contract.ToolService>;

  const browser = {
    listBrowserProviders: async (request, context) => {
      authenticate(context);
      const values = dependencies.browserProvider === undefined ? [] : [await mapBrowserProvider(dependencies.browserProvider, now(), dependencies.browserState, dependencies.browserSettings)];
      const result = paginate(values, request.page);
      return { providers: result.values, page: result.page };
    },
    getBrowserProvider: async (request, context) => {
      authenticate(context);
      if (dependencies.browserProvider === undefined || !isBrowserProviderId(request.browserProviderId)) return {};
      return { provider: await mapBrowserProvider(dependencies.browserProvider, now(), dependencies.browserState, dependencies.browserSettings) };
    },
    listBrowserPages: async (request, context) => {
      authenticate(context);
      if (dependencies.browserProvider === undefined || !isBrowserProviderId(request.browserProviderId)) return { pages: [], page: emptyPage(request.page) };
      const values = await mapBrowserPages(dependencies.browserProvider, now(), dependencies.browserState);
      const filtered = values.filter((item) => request.state === undefined || item.state === request.state);
      const result = paginate(filtered, request.page);
      return { pages: result.values, page: result.page };
    },
    getBrowserPage: async (request, context) => {
      authenticate(context);
      if (dependencies.browserProvider === undefined) return {};
      const page = (await mapBrowserPages(dependencies.browserProvider, now(), dependencies.browserState)).find((item) => item.pageId === request.pageId);
      return { page };
    },
    listBrowserActivity: (request, context) => {
      authenticate(context);
      const values = [...(dependencies.browserActivities?.() ?? [])]
        .filter((item) => request.pageId === "" || item.pageId === request.pageId)
        .reverse()
        .map(mapBrowserActivity);
      const result = paginate(values, request.page);
      return { activities: result.values, page: result.page };
    },
    listBrowserTransfers: (request, context) => {
      authenticate(context);
      if (dependencies.browserTransfers === undefined) return { transfers: [], page: emptyPage(request.page) };
      const result = paginate(dependencies.browserTransfers.list({
        ...(request.browserProviderId === "" ? {} : { browserProviderId: request.browserProviderId }),
        ...(request.pageId === "" ? {} : { pageId: request.pageId }),
        ...(request.direction === undefined ? {} : { direction: request.direction }),
        ...(request.state === undefined ? {} : { state: request.state })
      }), request.page);
      return { transfers: result.values, page: result.page };
    },
    listBrowserAutomationNodes: (_request, context) => {
      const connection = authenticate(context);
      requireServiceDevice(dependencies, connection);
      const node = dependencies.browserAutomationNode?.project();
      return { nodes: node === undefined ? [] : [toProtoBrowserAutomationNode(node)] };
    },
    executeBrowserAutomationAction: async (request, context) => {
      const connection = authenticate(context);
      requireServiceDevice(dependencies, connection);
      const executor = dependencies.browserAutomationNode;
      if (executor === undefined) throw new ConnectError("Browser automation is unavailable on this node.", Code.Unavailable);
      const before = executor.project();
      const expectedGeneration = safeContractGeneration(request.expectedGeneration, "expected_generation");
      if (request.nodeId !== before.id || expectedGeneration !== before.generation || !before.available) {
        throw new ConnectError("Browser automation node generation is stale or unavailable.", Code.FailedPrecondition);
      }
      const action = request.action as (typeof BROWSER_AUTOMATION_ACTIONS)[number];
      if (!BROWSER_AUTOMATION_ACTIONS.includes(action)) throw invalidArgument("action is invalid");
      const arguments_ = parseBrowserAutomationArguments(request.argumentsJson);
      if (arguments_["target"] !== undefined || arguments_["node"] !== undefined) {
        throw invalidArgument("Remote Browser arguments cannot contain a nested route");
      }
      // Recheck the advertised action/act/feature set in the authenticated
      // service before the executor repeats the same fence at dispatch.
      try { assertActionCapabilities(action, arguments_, before.capabilities); }
      catch (error) { throw new ConnectError(browserAutomationErrorMessage(error), Code.FailedPrecondition); }
      const inputArtifacts = request.inputArtifacts.map(fromProtoBrowserAutomationArtifact);
      let result;
      try {
        result = await executor.execute({
          nodeId: request.nodeId,
          expectedGeneration,
          action,
          arguments: arguments_,
          inputArtifacts
        }, context.signal);
      } catch (error) {
        throw new ConnectError(browserAutomationErrorMessage(error), Code.FailedPrecondition);
      }
      const after = executor.project();
      if (after.generation !== before.generation || after.id !== before.id || !after.available) {
        throw new ConnectError("Browser automation node was fenced during execution.", Code.Aborted);
      }
      return create(contract.ExecuteBrowserAutomationActionResponseSchema, {
        node: toProtoBrowserAutomationNode(after),
        ok: result.ok,
        dataJson: result.data === undefined ? "" : boundedBrowserAutomationJson(result.data),
        errorCode: result.errorCode ?? "",
        message: result.message ?? "",
        binary: result.binary === undefined ? undefined : toProtoBrowserAutomationBinary(result.binary)
      });
    },
    inspectBrowserCommentTarget: async (request, context) => {
      const connection = authenticate(context);
      const provider = dependencies.browserProvider;
      if (provider === undefined) throw new ConnectError("Browser Provider is unavailable.", Code.Unavailable);
      const fence = requireOwnedBrowserPageFence(provider, connection.id, {
        browserProviderId: request.browserProviderId,
        currentPageId: request.pageId,
        takeoverId: request.takeoverId,
        generation: request.generation
      });
      try {
        const pageOwner = requireActiveBrowserPageAuthority(
          dependencies.browserState,
          provider.id,
          fence.pageId,
          fence.generation
        );
        const result = await provider.inspectHumanCommentTarget(fence, browserCommentInspectionInput(request));
        requireActiveBrowserPageAuthority(
          dependencies.browserState,
          provider.id,
          fence.pageId,
          fence.generation,
          pageOwner
        );
        return create(contract.InspectBrowserCommentTargetResponseSchema, {
          target: result.target === undefined ? undefined : toProtoBrowserCommentTarget(result.target),
          targetToken: result.targetToken ?? ""
        });
      } catch (error) {
        throw browserCommentConnectError(error);
      }
    },
    updateBrowserCommentDesign: async (request, context) => {
      const connection = authenticate(context);
      const provider = dependencies.browserProvider;
      if (provider === undefined) throw new ConnectError("Browser Provider is unavailable.", Code.Unavailable);
      const fence = requireOwnedBrowserPageFence(provider, connection.id, {
        browserProviderId: request.browserProviderId,
        currentPageId: request.pageId,
        takeoverId: request.takeoverId,
        generation: request.generation
      });
      try {
        const pageOwner = requireActiveBrowserPageAuthority(
          dependencies.browserState,
          provider.id,
          fence.pageId,
          fence.generation
        );
        const result = await provider.updateHumanCommentDesign(fence, browserCommentDesignUpdate(request));
        requireActiveBrowserPageAuthority(
          dependencies.browserState,
          provider.id,
          fence.pageId,
          fence.generation,
          pageOwner
        );
        return create(contract.UpdateBrowserCommentDesignResponseSchema, {
          placements: result.placements.map(toProtoBrowserCommentPlacement)
        });
      } catch (error) {
        throw browserCommentConnectError(error);
      }
    }
  } satisfies ServiceImpl<typeof contract.BrowserService>;

  // Pi-only narrowing is deliberately scoped to the namespaced PiService
  // implementation. SessionService and OperationService never inspect a
  // Backend class or ID to decide public behavior.
  const invokePiPanel = async <T>(
    sessionId: string,
    callback: (adapter: PiBackendAdapter, context: import("@joko/core").AdapterContext) => Promise<T>
  ): Promise<T> => (dependencies.sessionHost as ExtendedSessionHost).invokeAdapter(sessionId, async (adapter, adapterContext) => {
    if (!(adapter instanceof PiBackendAdapter)) {
      throw new ConnectError("The selected task is not owned by the Pi Backend.", Code.FailedPrecondition);
    }
    return callback(adapter, adapterContext);
  });

  const pi = {
    getPiSessionState: async (request, context) => {
      authenticate(context);
      return livePiSessionState(dependencies, request.sessionId);
    },
    getPiSessionTree: async (request, context) => {
      authenticate(context);
      const tree = await dependencies.sessionHost.getTree(request.sessionId);
      const stored = dependencies.store.getSession(request.sessionId);
      return { tree: piTree(stored.descriptor.binding.nativeSessionId ?? stored.descriptor.binding.opaqueRef, tree) };
    },
    listPiMessages: async (request, context) => {
      authenticate(context);
      const values = await invokePiPanel(request.sessionId, (adapter, adapterContext) => adapter.getMessages(adapterContext));
      const result = paginate(values, request.page);
      const mapped = await Promise.all(result.values.map((value) => mapPiMessage(value, dependencies.artifactStore)));
      return {
        messages: mapped.filter((item): item is contract.PiNativeMessage => item !== undefined),
        page: result.page
      };
    },
    listPiEntries: async (request, context) => {
      authenticate(context);
      const native = await invokePiPanel(request.sessionId, (adapter, adapterContext) => adapter.getEntries(request.sinceEntryId || undefined, adapterContext));
      const result = paginate(native.entries, request.page);
      const mapped = await Promise.all(result.values.map((value) => mapPiEntry(value, dependencies.artifactStore)));
      return {
        entries: mapped.filter((item): item is contract.PiSessionEntry => item !== undefined),
        activeLeafId: native.leafId ?? "",
        page: result.page
      };
    },
    listPiForkCandidates: async (request, context) => {
      authenticate(context);
      const candidates = await invokePiPanel(request.sessionId, (adapter, adapterContext) => adapter.getForkMessages(adapterContext));
      return {
        candidates: candidates.map((item) => create(contract.PiForkCandidateSchema, {
          entryId: item.entryId,
          text: item.text
        }))
      };
    },
    listPiCommands: async (request, context) => {
      authenticate(context);
      const commands = await dependencies.sessionHost.getCommands(request.sessionId);
      return { commands: commands.map(mapPiCommand) };
    },
    listPiResources: async (request, context) => {
      authenticate(context);
      if (dependencies.piResources !== undefined) {
        const observations = await (dependencies.sessionHost as ExtendedSessionHost).observeActiveResources({
          ...(request.backendId === "" ? {} : { backendId: request.backendId }),
          ...(request.targetId === "" ? {} : { targetId: request.targetId })
        });
        for (const observation of observations) {
          if (observation.resource.state !== "loaded") continue;
          let managed: NativePiResourceDescriptor;
          try {
            managed = dependencies.piResources.get(observation.resource.id);
          } catch {
            // Adapter-only/project discovery is never allowed to invent a
            // durable managed-resource record.
            continue;
          }
          if (
            managed.backendId !== observation.backendId ||
            (managed.targetId !== undefined && managed.targetId !== observation.targetId) ||
            !managed.enabled ||
            managed.state === "loaded" ||
            observation.resource.runtimeGeneration !== observation.generation ||
            observation.resource.revision === undefined ||
            observation.resource.revision !== managed.discoveredRevision ||
            observation.resource.resourceVersion === undefined ||
            observation.resource.resourceVersion !== managed.versionNumber
          ) continue;
          await dependencies.piResources.markLoaded(
            managed.id,
            true,
            undefined,
            {
              discoveredRevision: observation.resource.revision,
              resourceVersion: observation.resource.resourceVersion,
              sessionId: observation.sessionId,
              runtimeGeneration: observation.generation
            }
          );
        }
        const result = paginate(dependencies.piResources.list({
          ...(request.backendId === "" ? {} : { backendId: request.backendId }),
          ...(request.targetId === "" ? {} : { targetId: request.targetId }),
          ...(request.kind === undefined ? {} : { kind: nativeResourceKind(request.kind) }),
          ...(request.state === undefined ? {} : { state: nativeResourceState(request.state) })
        }).map(mapManagedResource), request.page);
        return { resources: result.values, page: result.page };
      }
      const observations = await (dependencies.sessionHost as ExtendedSessionHost).observeActiveResources({
        ...(request.backendId === "" ? {} : { backendId: request.backendId }),
        ...(request.targetId === "" ? {} : { targetId: request.targetId })
      });
      const unique = new Map<string, contract.ManagedResource>();
      for (const observation of observations) {
        const mapped = mapPiResource(observation.resource, observation.backendId, observation.targetId);
        if ((request.kind === undefined || mapped.kind === request.kind) && (request.state === undefined || mapped.state === request.state)) {
          unique.set(`${mapped.backendId}\0${mapped.targetId}\0${mapped.resourceId}`, mapped);
        }
      }
      const result = paginate([...unique.values()], request.page);
      return { resources: result.values, page: result.page };
    }
  } satisfies ServiceImpl<typeof contract.PiService>;

  return { connection, event, operation, backend, target, session, portableSession, run, subagent, review, queue, scheduler, interaction, workspace, worktree, artifact, historyMaintenance, credential, settings, managedModelRuntime, tool, browser, remoteHost, voiceInput, pi };
}

function requireAuthentication(dependencies: ConnectServiceDependencies, context: HandlerContext): ConnectionRecord {
  try {
    return dependencies.connections.authenticate(context.requestHeader.get("authorization") ?? undefined);
  } catch (error) {
    throw new ConnectError(error instanceof Error ? error.message : "Authentication failed.", Code.Unauthenticated);
  }
}

function requireServiceDevice(
  dependencies: ConnectServiceDependencies,
  connection: ConnectionRecord
): void {
  const device = dependencies.store.getDevice(connection.deviceId);
  if (device.state !== "active" || device.kind !== "service") {
    throw new ConnectError("Browser automation node RPCs require an authenticated service Device.", Code.PermissionDenied);
  }
}

function toProtoBrowserAutomationNode(
  node: BrowserAutomationNodeProjection
): contract.BrowserAutomationNode {
  return create(contract.BrowserAutomationNodeSchema, {
    nodeId: node.id,
    displayName: node.displayName,
    available: node.available,
    generation: BigInt(node.generation),
    capabilities: [...node.capabilities].sort()
  });
}

function parseBrowserAutomationArguments(value: string): Readonly<Record<string, unknown>> {
  if (value === "" || Buffer.byteLength(value, "utf8") > 200_000) {
    throw invalidArgument("arguments_json is empty or exceeds its byte limit");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(value) as unknown; }
  catch { throw invalidArgument("arguments_json is invalid JSON"); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw invalidArgument("arguments_json must encode an object");
  }
  return parsed as Readonly<Record<string, unknown>>;
}

function fromProtoBrowserAutomationArtifact(
  value: contract.BrowserAutomationBinary
): BrowserAutomationInputArtifact {
  const byteSize = safeContractGenerationOrZero(value.byteSize, "input_artifacts.byte_size");
  if (byteSize !== value.data.byteLength || byteSize > 10 * 1024 * 1024) {
    throw invalidArgument("Browser automation input artifact size is invalid");
  }
  if (!/^[a-f0-9]{64}$/u.test(value.sha256Hex) ||
    createHash("sha256").update(value.data).digest("hex") !== value.sha256Hex) {
    throw invalidArgument("Browser automation input artifact digest is invalid");
  }
  return {
    artifactId: boundedBrowserAutomationText(value.artifactId, 512, "input_artifacts.artifact_id"),
    fileName: boundedBrowserAutomationText(value.fileName, 255, "input_artifacts.file_name"),
    mediaType: boundedBrowserAutomationText(value.mediaType, 128, "input_artifacts.media_type"),
    byteSize,
    sha256Hex: value.sha256Hex,
    data: new Uint8Array(value.data)
  };
}

function toProtoBrowserAutomationBinary(value: {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly fileName?: string;
}): contract.BrowserAutomationBinary {
  if (value.bytes.byteLength > 10 * 1024 * 1024) {
    throw new ConnectError("Browser automation binary result exceeds its byte limit.", Code.ResourceExhausted);
  }
  return create(contract.BrowserAutomationBinarySchema, {
    artifactId: "",
    fileName: value.fileName ?? "",
    mediaType: value.mediaType,
    byteSize: BigInt(value.bytes.byteLength),
    sha256Hex: createHash("sha256").update(value.bytes).digest("hex"),
    data: value.bytes
  });
}

function boundedBrowserAutomationJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > 200_000) {
    throw new ConnectError("Browser automation result exceeds its byte limit.", Code.ResourceExhausted);
  }
  return serialized;
}

function boundedBrowserAutomationText(value: string, maximumLength: number, field: string): string {
  const normalized = value.trim();
  if (normalized === "" || normalized.length > maximumLength || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw invalidArgument(`${field} is invalid`);
  }
  return normalized;
}

function safeContractGeneration(value: bigint, field: string): number {
  const result = safeContractGenerationOrZero(value, field);
  if (result < 1) throw invalidArgument(`${field} is invalid`);
  return result;
}

function safeContractGenerationOrZero(value: bigint, field: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0 || BigInt(result) !== value) throw invalidArgument(`${field} is invalid`);
  return result;
}

function strictRuntimeProcessIdentity(value: string, field: string): string {
  if (
    value !== value.trim()
    || value === ""
    || value.length > 512
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) throw invalidArgument(`${field} is invalid`);
  return value;
}

function validRuntimeProcessInstanceId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function browserAutomationErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Browser automation request failed.";
}

function invalidArgument(message: string): ConnectError {
  return new ConnectError(message, Code.InvalidArgument);
}

function scheduleHistoryTriggerId(value: string): bigint {
  if (!/^[1-9][0-9]*$/u.test(value)) throw invalidArgument("Schedule run trigger ID is invalid.");
  const id = BigInt(value);
  if (id > 9_223_372_036_854_775_807n) throw invalidArgument("Schedule run trigger ID is invalid.");
  return id;
}

function assertScheduleHistoryOwnership(actualScheduleId: string, expectedScheduleId: string): void {
  if (actualScheduleId !== expectedScheduleId) {
    throw invalidArgument("The Schedule run does not belong to this Schedule.");
  }
}

function terminalScheduleHistoryStatus(status: string): boolean {
  return ["success", "succeeded", "completed", "skipped", "aborted", "interrupted", "cancelled", "failed"]
    .includes(status.toLowerCase());
}

function unreadScheduleHistoryStatus(status: string): boolean {
  return ["success", "succeeded", "completed", "aborted", "interrupted", "cancelled", "failed"]
    .includes(status.toLowerCase());
}

function scheduleDeletionDispositionFromProto(
  value: contract.ScheduleGeneratedSessionDisposition
): ScheduleDeletionDisposition {
  if (value === contract.ScheduleGeneratedSessionDisposition.KEEP) return "keep";
  if (value === contract.ScheduleGeneratedSessionDisposition.ARCHIVE) return "archive";
  if (value === contract.ScheduleGeneratedSessionDisposition.DELETE) return "delete";
  throw invalidArgument("delete_schedule.generated_session_disposition is required");
}

function scheduleDeletionDispositionToProto(
  value: ScheduleDeletionDisposition
): contract.ScheduleGeneratedSessionDisposition {
  if (value === "keep") return contract.ScheduleGeneratedSessionDisposition.KEEP;
  if (value === "archive") return contract.ScheduleGeneratedSessionDisposition.ARCHIVE;
  return contract.ScheduleGeneratedSessionDisposition.DELETE;
}

function scheduleDeletionOutcomeFromRecord(
  value: Readonly<Record<string, unknown>>
): NonNullable<OperationOutcome["scheduleDeletion"]> {
  const disposition = value["disposition"];
  if (disposition !== "keep" && disposition !== "archive" && disposition !== "delete") {
    throw new Error("The stored Schedule deletion disposition is invalid.");
  }
  const failures = Array.isArray(value["failures"])
    ? value["failures"].flatMap((item) => {
        const failure = asRecord(item);
        const sessionId = stringValue(failure["sessionId"]);
        const message = stringValue(failure["message"]);
        return sessionId === undefined || message === undefined ? [] : [{ sessionId, message }];
      })
    : [];
  return {
    scheduleId: stringValue(value["scheduleId"]) ?? "",
    disposition,
    generatedSessionIds: Array.isArray(value["generatedSessionIds"])
      ? value["generatedSessionIds"].filter((item): item is string => typeof item === "string")
      : [],
    completedSessionIds: Array.isArray(value["completedSessionIds"])
      ? value["completedSessionIds"].filter((item): item is string => typeof item === "string")
      : [],
    failures,
    inflightCount: typeof value["inflightCount"] === "number" ? value["inflightCount"] : 0
  };
}

function scheduleDeletionOperationOutcome(
  manifest: ScheduleDeletionCleanupRecord
): OperationOutcome {
  return {
    accepted: true,
    resultCase: "scheduleDeletion",
    scheduleDeletion: {
      scheduleId: manifest.scheduleId,
      disposition: manifest.disposition,
      generatedSessionIds: manifest.generatedSessionIds,
      completedSessionIds: manifest.completedSessionIds,
      failures: manifest.failures,
      inflightCount: manifest.inflightCount
    }
  };
}

async function cleanupScheduleGeneratedSessions(
  dependencies: Pick<ConnectServiceDependencies, "store" | "sessionHost" | "sessionWorktrees" | "gitSafety">,
  manifest: ScheduleDeletionCleanupRecord
): Promise<{
  readonly completedSessionIds: readonly string[];
  readonly failures: readonly ScheduleDeletionCleanupFailure[];
}> {
  if (manifest.disposition === "keep") return { completedSessionIds: [], failures: [] };
  const alreadyCompleted = new Set(manifest.completedSessionIds);
  const sessions = new Map(dependencies.store.listSessions({ includeArchived: true, includeDeleted: true })
    .map((session) => [session.descriptor.id, session] as const));
  const completedSessionIds: string[] = [];
  const failures: ScheduleDeletionCleanupFailure[] = [];
  for (const sessionId of manifest.generatedSessionIds) {
    if (alreadyCompleted.has(sessionId)) continue;
    const session = sessions.get(sessionId);
    if (session === undefined) {
      completedSessionIds.push(sessionId);
      continue;
    }
    try {
      const worktree = session.descriptor.worktree;
      await dependencies.sessionHost.prepareDestructiveSessionClose(sessionId);
      if (manifest.disposition === "delete") {
        // A generated task can still own a live adapter runtime even without
        // an isolated workspace. Match ordinary task deletion by fencing that
        // runtime before any durable tombstone is committed.
        await dependencies.sessionHost.closeIfActive(sessionId);
        let cleanupError: unknown;
        if (worktree !== undefined) {
          if (dependencies.sessionWorktrees === undefined) {
            cleanupError = new Error("Isolated workspace cleanup is unavailable.");
          } else {
            try {
              // Both active and preserved worktrees retain branch/snapshot
              // ownership and therefore require the full release path.
              await dependencies.sessionWorktrees.release(sessionId);
            } catch (error) {
              cleanupError = error;
            }
          }
        }
        try {
          await dependencies.gitSafety?.closeSession(sessionId);
        } catch (error) {
          cleanupError ??= error;
        }
        if (cleanupError !== undefined) throw cleanupError;
      } else {
        // Archiving is also an input/runtime fence. A task without a worktree,
        // or one whose worktree is already preserved, may still own a live
        // native runtime and must be closed before the durable archive bit.
        await dependencies.sessionHost.closeIfActive(sessionId);
        if (worktree?.state === "active") {
          if (dependencies.sessionWorktrees === undefined) {
            throw new Error("Isolated workspace cleanup is unavailable.");
          }
          await dependencies.sessionWorktrees.archive(sessionId);
        }
      }
      completedSessionIds.push(sessionId);
    } catch (error) {
      failures.push({
        sessionId,
        message: redactSecrets(error instanceof Error ? error.message : "Generated task cleanup failed.").slice(0, 512)
      });
    }
  }
  return { completedSessionIds, failures };
}

async function cleanupScheduleGeneratedSessionsWithRetry(
  dependencies: Pick<ConnectServiceDependencies, "store" | "sessionHost" | "sessionWorktrees" | "gitSafety">,
  manifest: ScheduleDeletionCleanupRecord,
  maximumAttempts = 1
): Promise<{
  readonly completedSessionIds: readonly string[];
  readonly failures: readonly ScheduleDeletionCleanupFailure[];
}> {
  const completed = new Set(manifest.completedSessionIds);
  let failures: readonly ScheduleDeletionCleanupFailure[] = [];
  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    const cleanup = await cleanupScheduleGeneratedSessions(dependencies, {
      ...manifest,
      completedSessionIds: [...completed]
    });
    for (const sessionId of cleanup.completedSessionIds) completed.add(sessionId);
    failures = cleanup.failures;
    if (failures.length === 0) break;
  }
  return { completedSessionIds: [...completed], failures };
}

function sessionLifecycleOperationOutcome(
  cleanup: SessionLifecycleCleanupRecord
): OperationOutcome {
  return {
    accepted: true,
    resultCase: "session",
    entityId: cleanup.sessionId
  };
}

async function advanceSessionLifecycleCleanup(
  dependencies: Pick<ConnectServiceDependencies, "store" | "sessionHost" | "sessionWorktrees" | "gitSafety" | "now">,
  initial: SessionLifecycleCleanupRecord
): Promise<SessionLifecycleCleanupRecord> {
  let cleanup = initial;
  const advance = (phase: "close" | "native" | "worktree" | "git_safety") => {
    cleanup = dependencies.store.advanceSessionLifecycleCleanup({
      operationId: cleanup.operationId,
      phase,
      at: (dependencies.now ?? Date.now)()
    });
  };
  try {
    if (!cleanup.closeCompleted) {
      await dependencies.sessionHost.prepareSessionLifecycleClose(
        cleanup.sessionId,
        cleanup.disposition
      );
      await dependencies.sessionHost.closeIfActive(cleanup.sessionId);
      advance("close");
    }
    if (!cleanup.nativeCompleted) {
      await dependencies.sessionHost.deleteNativeSession(cleanup.sessionId, cleanup.operationId);
      advance("native");
    }
    if (!cleanup.worktreeCompleted) {
      const session = dependencies.store.getSession(cleanup.sessionId);
      const worktree = session.descriptor.worktree;
      if (worktree !== undefined) {
        if (dependencies.sessionWorktrees === undefined) {
          throw new ConnectError("Isolated workspace cleanup is unavailable.", Code.FailedPrecondition);
        }
        if (cleanup.disposition === "archive") {
          if (worktree.state === "active") await dependencies.sessionWorktrees.archive(cleanup.sessionId);
        } else {
          await dependencies.sessionWorktrees.release(cleanup.sessionId);
        }
      }
      advance("worktree");
    }
    if (!cleanup.gitSafetyCompleted) {
      await dependencies.gitSafety?.closeSession(cleanup.sessionId);
      advance("git_safety");
    }
    return cleanup;
  } catch (error) {
    dependencies.store.recordSessionLifecycleCleanupFailure({
      operationId: cleanup.operationId,
      message: redactSecrets(error instanceof Error ? error.message : "Task lifecycle cleanup failed."),
      at: (dependencies.now ?? Date.now)()
    });
    throw error;
  }
}

const SCHEDULE_DELETION_RETRY_DELAY_MS = 2_000;
const SCHEDULE_DELETION_RETRY_MAX_DELAY_MS = 30_000;
interface ScheduleDeletionRetryState {
  timer?: ReturnType<typeof setTimeout>;
  failureStreak: number;
}
const scheduleDeletionRetryStates = new WeakMap<
  OperationalStore,
  Map<string, ScheduleDeletionRetryState>
>();
const scheduleDeletionRetryDisposed = new WeakSet<OperationalStore>();

function cancelPendingScheduleDeletionRetries(store: OperationalStore): void {
  scheduleDeletionRetryDisposed.add(store);
  const states = scheduleDeletionRetryStates.get(store);
  if (states === undefined) return;
  for (const state of states.values()) {
    if (state.timer !== undefined) clearTimeout(state.timer);
  }
  states.clear();
  scheduleDeletionRetryStates.delete(store);
}

function schedulePendingScheduleDeletionRetry(
  dependencies: ConnectServiceDependencies,
  operationId: string,
  madeProgress = false
): void {
  if (scheduleDeletionRetryDisposed.has(dependencies.store)) return;
  let manifest: ScheduleDeletionCleanupRecord | undefined;
  try {
    manifest = dependencies.store.findScheduleDeletionCleanup(operationId);
  } catch {
    return;
  }
  if (manifest?.state !== "pending") return;
  let states = scheduleDeletionRetryStates.get(dependencies.store);
  if (states === undefined) {
    states = new Map();
    scheduleDeletionRetryStates.set(dependencies.store, states);
  }
  const state = states.get(operationId) ?? { failureStreak: 0 };
  states.set(operationId, state);
  if (state.timer !== undefined) return;
  state.failureStreak = madeProgress ? 0 : state.failureStreak + 1;
  const delayMs = Math.min(
    SCHEDULE_DELETION_RETRY_DELAY_MS * (2 ** Math.max(0, state.failureStreak - 1)),
    SCHEDULE_DELETION_RETRY_MAX_DELAY_MS
  );
  const timer = setTimeout(() => {
    state.timer = undefined;
    void (async () => {
      if (scheduleDeletionRetryDisposed.has(dependencies.store)) return;
      let before = 0;
      let progressed = false;
      try {
        before = dependencies.store.findScheduleDeletionCleanup(operationId)?.completedSessionIds.length ?? 0;
        const result = await resumePendingScheduleDeletionCleanup(dependencies, operationId);
        progressed = result !== undefined && result.completedSessionIds.length > before;
      } catch (error) {
        if (typeof (dependencies.store as Partial<OperationalStore>).appendDiagnostic === "function") {
          try {
            dependencies.store.appendDiagnostic({
              severity: "warning",
              component: "scheduler",
              code: "SCHEDULE_DELETION_RECOVERY_RETRY_FAILED",
              message: "A pending Schedule deletion cleanup will be retried.",
              details: { error: redactSecrets(error instanceof Error ? error.message : "unknown") }
            });
          } catch {
            // The durable manifest remains the source of truth even if diagnostics fail.
          }
        }
      }
      try {
        if (scheduleDeletionRetryDisposed.has(dependencies.store)) return;
        if (dependencies.store.findScheduleDeletionCleanup(operationId)?.state === "pending") {
          schedulePendingScheduleDeletionRetry(dependencies, operationId, progressed);
        } else {
          states!.delete(operationId);
        }
      } catch {
        // Store shutdown ends this process-local retry loop; the manifest is
        // picked up before generic operation recovery on the next startup.
      }
    })().catch(() => {
      // The manifest is durable. Any unexpected process-local callback fault
      // must not surface as an unhandled rejection during shutdown.
    });
  }, delayMs);
  timer.unref?.();
  state.timer = timer;
}

const sessionLifecycleRetryStates = new WeakMap<
  OperationalStore,
  Map<string, ScheduleDeletionRetryState>
>();
const sessionLifecycleRetryDisposed = new WeakSet<OperationalStore>();

function cancelPendingSessionLifecycleRetries(store: OperationalStore): void {
  sessionLifecycleRetryDisposed.add(store);
  const states = sessionLifecycleRetryStates.get(store);
  if (states === undefined) return;
  for (const state of states.values()) {
    if (state.timer !== undefined) clearTimeout(state.timer);
  }
  states.clear();
  sessionLifecycleRetryStates.delete(store);
}

function sessionLifecycleCompletedPhaseCount(cleanup: SessionLifecycleCleanupRecord): number {
  return Number(cleanup.closeCompleted)
    + Number(cleanup.nativeCompleted)
    + Number(cleanup.worktreeCompleted)
    + Number(cleanup.gitSafetyCompleted);
}

function schedulePendingSessionLifecycleRetry(
  dependencies: ConnectServiceDependencies,
  operationId: string,
  madeProgress = false
): void {
  if (sessionLifecycleRetryDisposed.has(dependencies.store)) return;
  let cleanup: SessionLifecycleCleanupRecord | undefined;
  try {
    cleanup = dependencies.store.findSessionLifecycleCleanup(operationId);
  } catch {
    return;
  }
  if (cleanup?.state !== "pending") return;
  let states = sessionLifecycleRetryStates.get(dependencies.store);
  if (states === undefined) {
    states = new Map();
    sessionLifecycleRetryStates.set(dependencies.store, states);
  }
  const state = states.get(operationId) ?? { failureStreak: 0 };
  states.set(operationId, state);
  if (state.timer !== undefined) return;
  state.failureStreak = madeProgress ? 0 : state.failureStreak + 1;
  const delayMs = Math.min(
    SCHEDULE_DELETION_RETRY_DELAY_MS * (2 ** Math.max(0, state.failureStreak - 1)),
    SCHEDULE_DELETION_RETRY_MAX_DELAY_MS
  );
  const timer = setTimeout(() => {
    state.timer = undefined;
    void (async () => {
      if (sessionLifecycleRetryDisposed.has(dependencies.store)) return;
      let progressed = false;
      try {
        const before = dependencies.store.findSessionLifecycleCleanup(operationId);
        const result = await resumePendingSessionLifecycleCleanup(dependencies, operationId);
        progressed = before !== undefined
          && result !== undefined
          && sessionLifecycleCompletedPhaseCount(result) > sessionLifecycleCompletedPhaseCount(before);
      } catch (error) {
        try {
          dependencies.store.appendDiagnostic({
            severity: "warning",
            component: "session-lifecycle",
            code: "SESSION_LIFECYCLE_RECOVERY_RETRY_FAILED",
            message: "A pending task lifecycle cleanup will be retried.",
            details: { error: redactSecrets(error instanceof Error ? error.message : "unknown") }
          });
        } catch {
          // The durable manifest remains authoritative during Store shutdown.
        }
      }
      try {
        if (sessionLifecycleRetryDisposed.has(dependencies.store)) return;
        if (dependencies.store.findSessionLifecycleCleanup(operationId)?.state === "pending") {
          schedulePendingSessionLifecycleRetry(dependencies, operationId, progressed);
        } else {
          states!.delete(operationId);
        }
      } catch {
        // Startup recovery resumes the durable manifest after a process stop.
      }
    })().catch(() => undefined);
  }, delayMs);
  timer.unref?.();
  state.timer = timer;
}

async function resumePendingSessionLifecycleCleanup(
  dependencies: ConnectServiceDependencies,
  operationId: string
): Promise<SessionLifecycleCleanupRecord | undefined> {
  let cleanup = dependencies.store.findSessionLifecycleCleanup(operationId);
  if (cleanup?.state !== "pending") return cleanup;
  cleanup = await advanceSessionLifecycleCleanup(dependencies, cleanup);
  return dependencies.store.finalizeSessionLifecycleCleanup({
    operationId,
    recoveredOperationResponse: sessionLifecycleOperationOutcome(cleanup),
    at: (dependencies.now ?? Date.now)()
  });
}

async function recoverPendingSessionLifecycleCleanups(
  dependencies: ConnectServiceDependencies
): Promise<void> {
  for (const cleanup of dependencies.store.listPendingSessionLifecycleCleanups()) {
    try {
      await resumePendingSessionLifecycleCleanup(dependencies, cleanup.operationId);
    } catch {
      schedulePendingSessionLifecycleRetry(dependencies, cleanup.operationId);
    }
  }
}

async function resumePendingScheduleDeletionCleanup(
  dependencies: ConnectServiceDependencies,
  operationId: string,
  fenceAlreadyInstalled = false
): Promise<ScheduleDeletionCleanupRecord | undefined> {
  let manifest = dependencies.store.findScheduleDeletionCleanup(operationId);
  if (manifest?.state !== "pending") return manifest;
  let occurrenceRunIds: readonly string[] = [];
  if (!fenceAlreadyInstalled) {
    occurrenceRunIds = await dependencies.scheduleCoordinator.beginScheduleDeletion(
      manifest.scheduleId,
      manifest.operationId
    );
  }
  manifest = dependencies.store.findScheduleDeletionCleanup(operationId);
  if (manifest?.state !== "pending") return manifest;
  manifest = dependencies.store.refreshScheduleDeletionCleanup({
    operationId,
    occurrenceRunIds,
    at: (dependencies.now ?? Date.now)()
  });
  const cleanup = await cleanupScheduleGeneratedSessionsWithRetry(dependencies, manifest);
  const recovered = {
    ...manifest,
    completedSessionIds: cleanup.completedSessionIds,
    failures: cleanup.failures
  } satisfies ScheduleDeletionCleanupRecord;
  const cleanupComplete = manifest.disposition === "keep"
    || (cleanup.failures.length === 0 && cleanup.completedSessionIds.length === manifest.generatedSessionIds.length);
  const commit = async (): Promise<ScheduleDeletionCleanupRecord> =>
    dependencies.store.finalizeScheduleDeletionCleanup({
      operationId: manifest!.operationId,
      completedSessionIds: cleanup.completedSessionIds,
      failures: cleanup.failures,
      ...(cleanupComplete ? { recoveredOperationResponse: scheduleDeletionOperationOutcome(recovered) } : {}),
      at: (dependencies.now ?? Date.now)()
    });
  const result = cleanupComplete && manifest.projectTargetId !== undefined && manifest.projectConfigId !== undefined
    ? await dependencies.projectAutomations.removeWithCommit(
        manifest.projectTargetId,
        manifest.projectConfigId,
        commit
      )
    : await commit();
  if (result.state === "completed") {
    dependencies.scheduleCoordinator.releaseScheduleDeletion(result.scheduleId, result.operationId);
  }
  return result;
}

async function recoverPendingScheduleDeletionCleanups(
  dependencies: ConnectServiceDependencies
): Promise<void> {
  const manifests = dependencies.store.listPendingScheduleDeletionCleanups();
  // Install every deletion fence before awaiting any individual cleanup. A
  // slow first recovery must not leave later pending Schedules dispatchable.
  const fenced = manifests.map((manifest) => ({
    manifest,
    ready: dependencies.scheduleCoordinator.beginScheduleDeletion(manifest.scheduleId, manifest.operationId)
  }));
  const readiness = await Promise.allSettled(fenced.map((entry) => entry.ready));
  for (const [index, { manifest }] of fenced.entries()) {
    if (readiness[index]?.status === "rejected") {
      schedulePendingScheduleDeletionRetry(dependencies, manifest.operationId);
      continue;
    }
    try {
      const result = await resumePendingScheduleDeletionCleanup(dependencies, manifest.operationId, true);
      if (result?.state === "pending") {
        schedulePendingScheduleDeletionRetry(
          dependencies,
          manifest.operationId,
          result.completedSessionIds.length > manifest.completedSessionIds.length
        );
      }
    } catch {
      schedulePendingScheduleDeletionRetry(dependencies, manifest.operationId);
    }
  }
}

function derivationSourceMessageInput(
  messageId: string | undefined,
  eventId: string | undefined,
  field: string
): { readonly messageId: string; readonly eventId: string } | undefined {
  if (messageId === undefined && eventId === undefined) return undefined;
  if (messageId === undefined || eventId === undefined) {
    throw invalidArgument(`${field} source message identity is incomplete`);
  }
  return {
    messageId: strictDerivationIdentity(messageId, `${field}.source_message_id`),
    eventId: strictDerivationIdentity(eventId, `${field}.source_event_id`)
  };
}

function strictDerivationIdentity(value: string, field: string): string {
  if (
    value !== value.trim()
    || value === ""
    || value.length > 1_024
    || /[\u0000-\u001f\u007f\u2028\u2029]/u.test(value)
  ) throw invalidArgument(`${field} is invalid`);
  return value;
}

function unsupportedError(capability: string, detail: string): contract.ErrorInfo {
  return mapErrorToProto({
    code: "UNSUPPORTED_CAPABILITY",
    message: detail,
    phase: capability,
    retryable: false,
    stateMayHaveChanged: false,
    recovery: "Select a Backend or Tool Provider that advertises this capability."
  });
}

function validatePreconditions(store: OperationalStore, mutation: contract.OperationMutation): void {
  for (const precondition of mutation.preconditions) {
    const entity = precondition.entity;
    if (entity === undefined || entity.id.trim() === "") throw invalidArgument("precondition.entity is required");
    const current = entityVersion(store, entity);
    if (precondition.expectedRevision !== undefined) {
      const expected = fromProtoRevision(precondition.expectedRevision, "mutation.preconditions.expected_revision");
      if (expected !== current.revision) {
        throw new ConnectError(`Revision precondition failed for ${entity.id}.`, Code.Aborted);
      }
    }
    if (precondition.expectedGeneration !== 0n && precondition.expectedGeneration !== current.generation) {
      throw new ConnectError(`Generation precondition failed for ${entity.id}.`, Code.Aborted);
    }
  }
}

function requireEntityVersionPrecondition(
  mutation: contract.OperationMutation,
  kind: contract.EntityKind,
  id: string,
  field: string
): void {
  const precondition = mutation.preconditions.find((candidate) => (
    candidate.entity?.kind === kind && candidate.entity.id === id
  ));
  if (precondition?.expectedRevision === undefined) {
    throw invalidArgument(`${field} requires an exact entity revision precondition`);
  }
}

function entityVersion(store: OperationalStore, entity: contract.EntityRef): { revision: bigint; generation: bigint } {
  switch (entity.kind) {
    case contract.EntityKind.CONNECTION: return { revision: store.getConnection(entity.id).revision, generation: 0n };
    case contract.EntityKind.DEVICE: return { revision: store.getDevice(entity.id).revision, generation: 0n };
    case contract.EntityKind.DEVICE_CONTROL_RELATION: {
      const identity = parseDeviceControlRelationId(entity.id);
      return {
        revision: store.getDeviceControlRelation(identity.controllerDeviceId, identity.targetDeviceId).revision,
        generation: 0n
      };
    }
    case contract.EntityKind.BACKEND: return { revision: store.getBackend(entity.id).revision, generation: 0n };
    case contract.EntityKind.TARGET: return { revision: store.getTarget(entity.id).revision, generation: 0n };
    case contract.EntityKind.SESSION: {
      const item = store.getSession(entity.id);
      return { revision: item.revision, generation: BigInt(item.descriptor.binding.generation) };
    }
    case contract.EntityKind.RUN: return { revision: store.getRun(entity.id).revision, generation: 0n };
    case contract.EntityKind.ATTEMPT: {
      const item = store.getAttempt(entity.id);
      return { revision: item.revision, generation: BigInt(item.descriptor.generation) };
    }
    case contract.EntityKind.QUEUE_ITEM: {
      const item = store.getQueueItem(entity.id);
      const session = store.getSession(item.sessionId);
      return { revision: item.revision, generation: BigInt(session.descriptor.binding.generation) };
    }
    case contract.EntityKind.QUEUE_CONTROL: {
      const item = store.getQueueControl(entity.id);
      const session = store.getSession(item.sessionId);
      return { revision: item.revision, generation: BigInt(session.descriptor.binding.generation) };
    }
    case contract.EntityKind.SCHEDULE: return { revision: store.getSchedule(entity.id).revision, generation: 0n };
    case contract.EntityKind.REVIEW_RUN: return { revision: store.getReviewRun(entity.id).revision, generation: 0n };
    case contract.EntityKind.OPERATION: return { revision: store.getOperation(entity.id).revision, generation: 0n };
    case contract.EntityKind.INTERACTION: {
      const item = store.getInteraction(entity.id);
      return { revision: item.revision, generation: BigInt(item.generation) };
    }
    case contract.EntityKind.WORKSPACE: {
      const item = targetForWorkspace(store, entity.id);
      if (item === undefined) throw new ConnectError("Workspace not found.", Code.NotFound);
      return { revision: item.revision, generation: 0n };
    }
    case contract.EntityKind.ARTIFACT: return { revision: store.getArtifact(entity.id).revision, generation: 0n };
    case contract.EntityKind.TOOL_LEASE: {
      const item = store.getToolLease(entity.id);
      return { revision: item.revision, generation: BigInt(item.generation) };
    }
    default: throw new ConnectError(`Preconditions for entity kind ${entity.kind} are not supported.`, Code.InvalidArgument);
  }
}

function toProtoOperation(
  dependencies: ConnectServiceDependencies,
  record: OperationRecord<unknown>,
  mutation: contract.OperationMutation,
  outcome: OperationOutcome,
  at: number
): contract.Operation {
  const base = toProtoStoredOperation(record, Number(dependencies.generation ?? 0n));
  const result = record.status === "started" ? undefined : operationResult(dependencies, outcome, at);
  const rejected = record.status === "failed" || (record.status === "completed" && !outcome.accepted);
  return create(contract.OperationSchema, {
    ...base,
    mutation,
    result,
    state: rejected ? contract.OperationState.FAILED : base.state,
    error: record.status === "failed"
      ? mapErrorToProto(record.error)
      : outcome.unsupportedReason === undefined ? base.error : unsupportedError(record.kind, outcome.unsupportedReason)
  });
}

function operationResult(
  dependencies: ConnectServiceDependencies,
  outcome: OperationOutcome,
  at: number
): contract.OperationResult {
  let payload: contract.OperationResult["payload"] = {
    case: "acknowledgement",
    value: create(contract.AcknowledgementSchema, { accepted: outcome.accepted })
  };
  if (outcome.accepted && outcome.compactSessionOutcome !== undefined) {
    let compactOutcome: contract.CompactSessionOutcome;
    switch (outcome.compactSessionOutcome) {
      case "compacted": compactOutcome = contract.CompactSessionOutcome.COMPACTED; break;
      case "noop": compactOutcome = contract.CompactSessionOutcome.NOOP; break;
      default: throw new Error("The stored compact Session outcome is invalid.");
    }
    payload = {
      case: "compactSession",
      value: create(contract.CompactSessionResultSchema, {
        outcome: compactOutcome
      })
    };
    return create(contract.OperationResultSchema, { payload });
  }
  if (outcome.accepted && outcome.memoryReset !== undefined) {
    payload = {
      case: "memoryReset",
      value: create(contract.MemoryResetResultSchema, {
        removedEntries: BigInt(outcome.memoryReset.removedEntries),
        removedTargets: BigInt(outcome.memoryReset.removedTargets)
      })
    };
    return create(contract.OperationResultSchema, { payload });
  }
  if (outcome.accepted && outcome.scheduleRunsReadCount !== undefined) {
    payload = {
      case: "scheduleRunsRead",
      value: create(contract.ScheduleRunsReadResultSchema, {
        updatedCount: BigInt(outcome.scheduleRunsReadCount)
      })
    };
    return create(contract.OperationResultSchema, { payload });
  }
  if (outcome.accepted && outcome.scheduleDeletion !== undefined) {
    payload = {
      case: "scheduleDeletion",
      value: create(contract.ScheduleDeletionResultSchema, {
        scheduleId: outcome.scheduleDeletion.scheduleId,
        generatedSessionDisposition: scheduleDeletionDispositionToProto(outcome.scheduleDeletion.disposition),
        generatedSessionIds: [...outcome.scheduleDeletion.generatedSessionIds],
        completedSessionIds: [...outcome.scheduleDeletion.completedSessionIds],
        failures: outcome.scheduleDeletion.failures.map((failure) => create(contract.ScheduleDeletionFailureSchema, {
          sessionId: failure.sessionId,
          message: failure.message
        })),
        inflightCount: outcome.scheduleDeletion.inflightCount
      })
    };
    return create(contract.OperationResultSchema, { payload });
  }
  if (outcome.accepted && outcome.workspaceRewind !== undefined) {
    payload = {
      case: "workspaceRewind",
      value: create(contract.WorkspaceRewindResultSchema, {
        workspaceId: outcome.workspaceRewind.workspaceId,
        changeSetId: outcome.workspaceRewind.changeSetId,
        restoredPaths: [...outcome.workspaceRewind.restoredPaths],
        remainingGaps: [],
        dialogueRewound: outcome.workspaceRewind.dialogueRewound,
        filesRewound: outcome.workspaceRewind.filesRewound
      })
    };
    return create(contract.OperationResultSchema, { payload });
  }
  if (outcome.accepted && outcome.workspaceGitPush !== undefined) {
    const push = outcome.workspaceGitPush;
    payload = {
      case: "workspaceGitPush",
      value: create(contract.WorkspaceGitPushResultSchema, {
        outcome: push.kind === "needs_force"
          ? contract.WorkspaceGitPushOutcome.NEEDS_FORCE
          : contract.WorkspaceGitPushOutcome.PUSHED,
        remote: push.remote,
        remoteRef: push.remoteRef,
        remoteOid: push.remoteOid ?? "",
        ahead: push.ahead ?? 0,
        behind: push.behind ?? 0,
        repositoryRevision: push.repositoryRevision,
        headRevision: push.headRevision
      })
    };
    return create(contract.OperationResultSchema, { payload });
  }
  if (!outcome.accepted || outcome.entityId === undefined) return create(contract.OperationResultSchema, { payload });
  try {
    switch (outcome.resultCase) {
      case "connection": payload = { case: "connection", value: toProtoConnection(dependencies.store.getConnection(outcome.entityId)) }; break;
      case "device": {
        const device = dependencies.store.getDevice(outcome.entityId);
        payload = { case: "device", value: deviceFromRecord(device, dependencies.store.listDeviceConnections(device.id), at) };
        break;
      }
      case "deviceControlRelation": {
        const identity = parseDeviceControlRelationId(outcome.entityId);
        const relation = dependencies.store.getDeviceControlRelation(identity.controllerDeviceId, identity.targetDeviceId);
        payload = {
          case: "deviceControlRelation",
          value: deviceControlRelationFromRecord(dependencies.store, relation, at)
        };
        break;
      }
      case "backend": payload = { case: "backend", value: toProtoBackend(dependencies.store.getBackend(outcome.entityId)) }; break;
      case "target": payload = { case: "target", value: toProtoTarget(dependencies.store.getTarget(outcome.entityId)) }; break;
      case "session": {
        const item = dependencies.store.getSession(outcome.entityId);
        payload = { case: "session", value: mapSession(dependencies, item) };
        break;
      }
      case "sessionAttention": {
        const item = dependencies.store.getSession(outcome.entityId);
        const attention = mapSession(dependencies, item).attention;
        if (attention !== undefined) payload = { case: "sessionAttention", value: attention };
        break;
      }
      case "run": payload = { case: "run", value: mapRun(dependencies.store, dependencies.store.getRun(outcome.entityId)) }; break;
      case "reviewRun": payload = { case: "reviewRun", value: mapStoredReviewRun(dependencies.store, dependencies.store.getReviewRun(outcome.entityId)) }; break;
      case "queueItem": payload = { case: "queueItem", value: mapQueueItem(dependencies.store, dependencies.store.getQueueItem(outcome.entityId), 0n) }; break;
      case "queueControl": payload = { case: "queueControl", value: mapQueueControl(dependencies.store, outcome.entityId) }; break;
      case "schedule": payload = { case: "schedule", value: mapSchedule(dependencies.store, dependencies.store.getSchedule(outcome.entityId)) }; break;
      case "interaction": payload = { case: "interaction", value: mapInteraction(dependencies.store, dependencies.store.getInteraction(outcome.entityId)) }; break;
      case "workspace": {
        const target = targetForWorkspace(dependencies.store, outcome.entityId);
        if (target !== undefined) payload = { case: "workspace", value: toProtoWorkspace(target) };
        break;
      }
      case "artifact": payload = { case: "artifact", value: toProtoArtifact(dependencies.store.getArtifact(outcome.entityId)) }; break;
      case "settings": payload = { case: "settings", value: settingsSnapshot(dependencies) }; break;
      case "provider": {
        const item = dependencies.providers?.get(outcome.entityId);
        const backendId = managedProviderBackendIds(dependencies)[0];
        if (item !== undefined && backendId !== undefined) payload = { case: "provider", value: mapProviderDescriptor(
          backendId,
          item,
          providerUsageSummary(dependencies, item.provider.id, backendId),
          providerRateLimit(dependencies, backendId, item.provider.id)
        ) };
        break;
      }
      case "credential": {
        const item = dependencies.credentials?.find(outcome.entityId);
        if (item !== undefined) payload = { case: "credential", value: mapCredentialDescriptor(item) };
        break;
      }
      case "providerLogin": {
        const current = outcome.entityId === undefined
          ? undefined
          : currentProviderLoginFlow(dependencies, outcome.entityId);
        if (current !== undefined) {
          payload = { case: "providerLogin", value: mapProviderLoginFlow(outcome.entityId!, current) };
        } else if (outcome.providerLogin !== undefined) {
          payload = { case: "providerLogin", value: mapPersistedProviderLoginFlow(outcome.providerLogin) };
        } else {
          const item = dependencies.providerLoginFlows.get(outcome.entityId);
          if (item !== undefined) payload = { case: "providerLogin", value: mapProviderLoginFlow(outcome.entityId, item) };
        }
        break;
      }
      case "mcpServer": {
        const managed = dependencies.mcpRouter === undefined ? undefined : dependencies.mcpRouter.get(outcome.entityId);
        if (managed !== undefined) payload = { case: "mcpServer", value: mapMcpServerDescriptor(managed) };
        break;
      }
      case "resource": {
        const item = dependencies.piResources?.get(outcome.entityId);
        if (item !== undefined) payload = { case: "resource", value: mapManagedResource(item) };
        break;
      }
      case "diagnosticsBundle": {
        const artifactId = dependencies.diagnosticsArtifacts.get(outcome.entityId) ?? outcome.entityId;
        payload = { case: "diagnosticsBundle", value: toProtoArtifact(dependencies.store.getArtifact(artifactId)) };
        break;
      }
      case "browserTransfer": {
        const transfer = outcome.browserTransferBinaryBase64 === undefined
          ? dependencies.browserTransfers?.get(dependencies.browserTransferOperations.get(outcome.entityId) ?? outcome.entityId)
          : fromBinary(contract.BrowserTransferSchema, Buffer.from(outcome.browserTransferBinaryBase64, "base64"));
        if (transfer !== undefined) payload = { case: "browserTransfer", value: transfer };
        break;
      }
      case "browserTakeover": {
        const takeover = dependencies.browserProvider === undefined
          ? undefined
          : mapBrowserTakeover(dependencies.browserProvider, outcome.entityId);
        if (takeover !== undefined) payload = { case: "browserTakeover", value: takeover };
        break;
      }
      case "screenshot": {
        const artifact = dependencies.store.getArtifact(outcome.entityId);
        payload = { case: "screenshot", value: create(contract.ImageRefSchema, { blob: toProtoArtifact(artifact).blob, widthPixels: 0, heightPixels: 0, altText: artifact.blob.fileName ?? "Browser screenshot" }) };
        break;
      }
      default: break;
    }
  } catch {
    // A tombstoned result remains a successful acknowledgement in operation history.
  }
  return create(contract.OperationResultSchema, { payload });
}

function operationRecordStatus(state: contract.OperationState | undefined): OperationRecord["status"] | undefined {
  if (state === undefined || state === contract.OperationState.UNSPECIFIED) return undefined;
  if (state === contract.OperationState.ACCEPTED || state === contract.OperationState.RUNNING || state === contract.OperationState.WAITING) return "started";
  if (state === contract.OperationState.SUCCEEDED) return "completed";
  return "failed";
}

function coreRunListStates(value: contract.RunState | undefined): readonly import("@joko/core").RunState[] | undefined {
  if (value === undefined) return undefined;
  switch (value) {
    case contract.RunState.QUEUED: return ["queued"];
    case contract.RunState.DISPATCH_UNKNOWN: return ["dispatch_unknown"];
    case contract.RunState.RUNNING: return ["running"];
    case contract.RunState.WAITING: return ["waiting"];
    case contract.RunState.RETRYING: return ["retrying"];
    case contract.RunState.SUCCEEDED: return ["completed"];
    case contract.RunState.ABORTED: return ["aborted"];
    case contract.RunState.FAILED: return ["failed"];
    default: return [];
  }
}

function coreQueueListStates(value: contract.QueueItemState | undefined): readonly import("@joko/core").QueueState[] | undefined {
  if (value === undefined) return undefined;
  switch (value) {
    case contract.QueueItemState.ACCEPTED: return ["accepted"];
    case contract.QueueItemState.DISPATCHING: return ["dispatching"];
    case contract.QueueItemState.BACKEND_ACCEPTED: return ["backend_accepted"];
    case contract.QueueItemState.DISPATCH_UNKNOWN: return ["dispatch_unknown"];
    case contract.QueueItemState.COMPLETED: return ["completed"];
    case contract.QueueItemState.CANCELLED: return ["cancelled"];
    case contract.QueueItemState.FAILED: return ["failed"];
    default: return [];
  }
}

function coreInteractionListKinds(
  value: contract.InteractionKind | undefined
): readonly InteractionRecord["kind"][] | undefined {
  if (value === undefined) return undefined;
  switch (value) {
    case contract.InteractionKind.PERMISSION: return ["permission"];
    case contract.InteractionKind.QUESTION: return ["question"];
    case contract.InteractionKind.PLAN_REVIEW: return ["plan_review"];
    case contract.InteractionKind.EXTENSION_UI:
      return ["extension_select", "extension_confirm", "extension_input", "extension_editor"];
    default: return [];
  }
}

type InteractionListStateFilter = {
  readonly unsupported?: boolean;
  readonly statuses?: readonly InteractionRecord["status"][];
  readonly dismissalReason?: string;
  readonly excludeDismissalReason?: string;
};

function coreInteractionListState(value: contract.InteractionState | undefined): InteractionListStateFilter | undefined {
  if (value === undefined) return undefined;
  switch (value) {
    case contract.InteractionState.PENDING: return { statuses: ["open"] };
    case contract.InteractionState.RESOLVED: return { statuses: ["resolved"] };
    case contract.InteractionState.DISMISSED:
      return { statuses: ["dismissed"], excludeDismissalReason: TIMED_EXTENSION_INTERACTION_EXPIRED_REASON };
    case contract.InteractionState.EXPIRED:
      return { statuses: ["dismissed"], dismissalReason: TIMED_EXTENSION_INTERACTION_EXPIRED_REASON };
    default: return { unsupported: true };
  }
}

type ArtifactListKindFilter = {
  readonly unsupported?: boolean;
  readonly kind?: "file" | "image" | "export" | "tool_result" | "diagnostics" | "diff";
};

function coreArtifactListKind(value: contract.ArtifactKind | undefined): ArtifactListKindFilter | undefined {
  if (value === undefined) return undefined;
  switch (value) {
    case contract.ArtifactKind.FILE: return { kind: "file" };
    case contract.ArtifactKind.IMAGE: return { kind: "image" };
    case contract.ArtifactKind.EXPORT: return { kind: "export" };
    case contract.ArtifactKind.TOOL_RESULT: return { kind: "tool_result" };
    case contract.ArtifactKind.DIAGNOSTICS: return { kind: "diagnostics" };
    case contract.ArtifactKind.DIFF: return { kind: "diff" };
    default: return { unsupported: true };
  }
}

function mutationFromRecord(store: OperationalStore, record: OperationRecord<unknown>): contract.OperationMutation {
  const body = asRecord(record.body);
  const storedPayload = asRecord(body["payload"]);
  if (typeof storedPayload["case"] === "string") {
    return create(contract.OperationMutationSchema, {
      preconditions: restoreOperationPreconditions(body["preconditions"]),
      payload: storedPayload as unknown as contract.OperationMutation["payload"]
    });
  }
  const empty = (): contract.OperationMutation => create(contract.OperationMutationSchema, { preconditions: [], payload: { case: undefined } });
  if (record.kind === "create_session") {
    const targetId = stringValue(body["targetId"]) ?? "";
    let backendId = "";
    try { backendId = store.getTarget(targetId).descriptor.backendId; } catch { /* Historical target tombstone. */ }
    const providerId = stringValue(body["providerId"]) ?? "";
    const modelId = stringValue(body["modelId"]) ?? "";
    const selection = providerId === "" && modelId === "" ? undefined : create(contract.ModelSelectionSchema, {
      model: create(contract.ModelKeySchema, { providerId, modelId }),
      effortId: stringValue(body["effort"]) ?? "",
      fastMode: booleanValue(body["fastMode"]) ?? false
    });
    return create(contract.OperationMutationSchema, {
      preconditions: [],
      payload: { case: "createSession", value: create(contract.CreateSessionMutationSchema, {
        backendId,
        targetId,
        displayName: stringValue(body["title"]) ?? "",
        nativeStart: create(contract.NativeSessionStartSchema, {
          kind: { case: "newSession", value: create(contract.NewNativeSessionSchema, { parentNativeReference: "" }) }
        }),
        model: selection,
        permissionMode: protoPermission(stringValue(body["permissionMode"])),
        planMode: booleanValue(body["planMode"]) ?? false,
        useWorktree: false,
        refreshWorktreeRemote: false,
        initialPlacement: stringValue(body["initialPlacement"]) === "dialogue"
          ? contract.NativeSessionPlacement.DIALOGUE
          : contract.NativeSessionPlacement.PROJECT
      }) }
    });
  }
  if (record.kind === "fork_session" || record.kind === "clone_session") {
    const sourceSessionId = stringValue(body["sourceSessionId"]) ?? "";
    const title = stringValue(body["title"]) ?? "";
    const sourceMessageId = stringValue(body["sourceMessageId"]);
    const sourceEventId = stringValue(body["sourceEventId"]);
    return create(contract.OperationMutationSchema, {
      preconditions: [],
      payload: record.kind === "fork_session"
        ? { case: "forkSession", value: create(contract.ForkSessionMutationSchema, {
            sourceSessionId,
            nativeEntryId: stringValue(body["entryId"]) ?? "",
            newDisplayName: title,
            ...(sourceMessageId === undefined ? {} : { sourceMessageId }),
            ...(sourceEventId === undefined ? {} : { sourceEventId })
          }) }
        : { case: "cloneSession", value: create(contract.CloneSessionMutationSchema, {
            sourceSessionId,
            newDisplayName: title,
            ...(sourceMessageId === undefined ? {} : { sourceMessageId }),
            ...(sourceEventId === undefined ? {} : { sourceEventId })
          }) }
    });
  }
  if (record.kind === "send_input") {
    const parentRunId = stringValue(body["parentRunId"]);
    if (parentRunId !== undefined) {
      return create(contract.OperationMutationSchema, {
        preconditions: [],
        payload: { case: "retryRun", value: create(contract.RetryRunMutationSchema, { runId: parentRunId }) }
      });
    }
    const prompt = body["prompt"] as PromptInput | undefined;
    if (prompt !== undefined) {
      return create(contract.OperationMutationSchema, {
        preconditions: [],
        payload: { case: "sendInput", value: create(contract.SendInputMutationSchema, {
          sessionId: stringValue(body["sessionId"]) ?? "",
          input: toProtoInputContent(prompt),
          deliveryMode: protoDeliveryMode(prompt.disposition),
          overrides: undefined
        }) }
      });
    }
  }
  return empty();
}

function restoreOperationPreconditions(value: unknown): contract.OperationPrecondition[] {
  if (!Array.isArray(value)) return [];
  return value.map((candidate) => {
    const item = asRecord(candidate);
    const entity = asRecord(item["entity"]);
    const revision = asRecord(item["expectedRevision"]);
    return create(contract.OperationPreconditionSchema, {
      entity: create(contract.EntityRefSchema, {
        kind: numericEnum(entity["kind"], contract.EntityKind.UNSPECIFIED),
        id: stringValue(entity["id"]) ?? "",
        displayName: stringValue(entity["displayName"]) ?? ""
      }),
      expectedRevision: Object.keys(revision).length === 0 ? undefined : create(contract.RevisionSchema, {
        value: bigintValue(revision["value"]),
        etag: stringValue(revision["etag"]) ?? ""
      }),
      expectedGeneration: bigintValue(item["expectedGeneration"])
    });
  });
}

function outcomeFromRecord(record: OperationRecord<unknown>): OperationOutcome {
  if (record.status === "failed") return { accepted: false, unsupportedReason: safePreview(record.error) };
  const response = asRecord(record.response);
  if (typeof response["reviewRunId"] === "string") {
    return { accepted: true, resultCase: "reviewRun", entityId: response["reviewRunId"] };
  }
  if (typeof response["accepted"] === "boolean") {
    const rewind = asRecord(response["workspaceRewind"]);
    const login = asRecord(response["providerLogin"]);
    const gitPush = asRecord(response["workspaceGitPush"]);
    const scheduleDeletion = asRecord(response["scheduleDeletion"]);
    return {
      accepted: response["accepted"],
      resultCase: stringValue(response["resultCase"]) as OperationOutcome["resultCase"],
      entityId: stringValue(response["entityId"]),
      unsupportedReason: stringValue(response["unsupportedReason"]),
      ...(response["compactSessionOutcome"] === "compacted" || response["compactSessionOutcome"] === "noop"
        ? { compactSessionOutcome: response["compactSessionOutcome"] }
        : {}),
      ...(typeof response["scheduleRunsReadCount"] === "number"
        ? { scheduleRunsReadCount: response["scheduleRunsReadCount"] }
        : {}),
      ...(Object.keys(scheduleDeletion).length === 0 ? {} : {
        scheduleDeletion: scheduleDeletionOutcomeFromRecord(scheduleDeletion)
      }),
      ...(Object.keys(rewind).length === 0 ? {} : {
        workspaceRewind: {
          workspaceId: stringValue(rewind["workspaceId"]) ?? "",
          changeSetId: stringValue(rewind["changeSetId"]) ?? "",
          restoredPaths: Array.isArray(rewind["restoredPaths"])
            ? rewind["restoredPaths"].filter((item): item is string => typeof item === "string")
            : [],
          dialogueRewound: booleanValue(rewind["dialogueRewound"]) ?? false,
          filesRewound: booleanValue(rewind["filesRewound"]) ?? false
        }
      }),
      ...(Object.keys(login).length === 0 ? {} : {
        providerLogin: {
          loginFlowId: stringValue(login["loginFlowId"]) ?? "",
          providerId: stringValue(login["providerId"]) ?? "",
          method: nativePersistedProviderLoginMethod(login["method"]),
          ...(stringValue(login["verificationUri"]) === undefined ? {} : { verificationUri: stringValue(login["verificationUri"]) }),
          ...(stringValue(login["userCode"]) === undefined ? {} : { userCode: stringValue(login["userCode"]) }),
          ...(typeof login["expiresAt"] !== "number" ? {} : { expiresAt: login["expiresAt"] })
        }
      }),
      ...(gitPush["kind"] !== "pushed" && gitPush["kind"] !== "needs_force" ? {} : {
        workspaceGitPush: {
          kind: gitPush["kind"],
          remote: stringValue(gitPush["remote"]) ?? "",
          remoteRef: stringValue(gitPush["remoteRef"]) ?? "",
          repositoryRevision: stringValue(gitPush["repositoryRevision"]) ?? "",
          headRevision: stringValue(gitPush["headRevision"]) ?? "",
          ...(stringValue(gitPush["remoteOid"]) === undefined ? {} : { remoteOid: stringValue(gitPush["remoteOid"])! }),
          ...(typeof gitPush["ahead"] !== "number" ? {} : { ahead: gitPush["ahead"] }),
          ...(typeof gitPush["behind"] !== "number" ? {} : { behind: gitPush["behind"] })
        }
      }),
      ...(stringValue(response["browserTransferBinaryBase64"]) === undefined
        ? {}
        : { browserTransferBinaryBase64: stringValue(response["browserTransferBinaryBase64"]) })
    };
  }
  if (typeof response["sessionId"] === "string") return { accepted: true, resultCase: "session", entityId: response["sessionId"] };
  if (typeof response["queueItemId"] === "string") return { accepted: true, resultCase: "queueItem", entityId: response["queueItemId"] };
  if (typeof response["runId"] === "string") return { accepted: true, resultCase: "run", entityId: response["runId"] };
  return { accepted: record.status === "completed", resultCase: "acknowledgement" };
}

function serverInfo(dependencies: ConnectServiceDependencies, at: number): contract.ServerInfo {
  return create(contract.ServerInfoSchema, {
    serverId: dependencies.server?.id ?? "orchestrator",
    displayName: dependencies.server?.displayName ?? "Joko",
    version: dependencies.server?.version ?? "0.1.0",
    apiVersion: dependencies.server?.apiVersion ?? "joko.v1",
    serverTime: toProtoTimestamp(at),
    health: contract.ServerHealth.HEALTHY,
    pairingEnabled: dependencies.server?.pairingEnabled ?? dependencies.connections.pairingEnabled
  });
}

function fallbackDiscoveredNode(dependencies: ConnectServiceDependencies, at: number): DiscoveredNodeRecord {
  return {
    serverId: dependencies.server?.id ?? "orchestrator",
    displayName: dependencies.server?.displayName ?? "Joko",
    origin: dependencies.server?.publicOrigin ?? "",
    version: dependencies.server?.version ?? "0.1.0",
    apiVersion: dependencies.server?.apiVersion ?? "joko.v1",
    pairingEnabled: dependencies.server?.pairingEnabled ?? dependencies.connections.pairingEnabled,
    lastSeen: at
  };
}

function toProtoDiscoveredNode(node: DiscoveredNodeRecord): contract.DiscoveredNode {
  return create(contract.DiscoveredNodeSchema, {
    serverId: node.serverId,
    displayName: node.displayName,
    origin: node.origin,
    version: node.version,
    apiVersion: node.apiVersion,
    pairingEnabled: node.pairingEnabled,
    lastSeen: toProtoTimestamp(node.lastSeen)
  });
}

function connectionState(record: ConnectionRecord): contract.ConnectionState {
  return record.state === "active" ? contract.ConnectionState.CONNECTED : contract.ConnectionState.REVOKED;
}

function deviceFromRecord(
  record: DeviceRecord,
  connections: readonly ConnectionRecord[],
  observedAt = Date.now()
): contract.Device {
  const online = record.state === "active" && connections.some((connection) =>
    connection.state === "active" && connection.lastSeenAt !== undefined &&
    observedAt - connection.lastSeenAt <= DEVICE_PRESENCE_WINDOW_MS);
  return create(contract.DeviceSchema, {
    deviceId: record.id,
    displayName: record.name,
    kind: record.kind === "web"
      ? contract.DeviceKind.WEB
      : record.kind === "desktop"
        ? contract.DeviceKind.DESKTOP
        : record.kind === "service"
          ? contract.DeviceKind.SERVICE
          : contract.DeviceKind.UNSPECIFIED,
    platform: record.platform,
    appVersion: record.appVersion,
    revoked: record.state === "revoked",
    pairedAt: toProtoTimestamp(record.pairedAt),
    lastSeenAt: record.lastSeenAt === undefined ? undefined : toProtoTimestamp(record.lastSeenAt),
    connectionIds: connections.map((connection) => connection.id),
    remoteControlEnabled: record.remoteControlEnabled,
    presence: online ? contract.DevicePresenceState.ONLINE : contract.DevicePresenceState.OFFLINE,
    version: toProtoEntityVersion(record.revision, 0, record.lastSeenAt ?? record.revokedAt ?? record.pairedAt)
  });
}

function deviceControlRelationId(controllerDeviceId: string, targetDeviceId: string): string {
  return `${controllerDeviceId}:${targetDeviceId}`;
}

function boundedDeviceDisplayName(value: string): string {
  const normalized = value.trim();
  if (normalized === "" || normalized.length > 80 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw invalidArgument("display_name is invalid");
  }
  return normalized;
}

function requireControllableDevice(device: DeviceRecord): void {
  if (device.state !== "active" || (device.kind !== "desktop" && device.kind !== "service")) {
    throw new ConnectError("Remote control requires an active Desktop or service Device.", Code.FailedPrecondition);
  }
}

function parseDeviceControlRelationId(value: string): { readonly controllerDeviceId: string; readonly targetDeviceId: string } {
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1 || value.indexOf(":", separator + 1) !== -1) {
    throw invalidArgument("Device control relation identity is invalid.");
  }
  return { controllerDeviceId: value.slice(0, separator), targetDeviceId: value.slice(separator + 1) };
}

function deviceControlRelationFromRecord(
  store: OperationalStore,
  record: DeviceControlRelationRecord,
  observedAt = Date.now()
): contract.DeviceControlRelation {
  const controller = store.getDevice(record.controllerDeviceId);
  const target = store.getDevice(record.targetDeviceId);
  return create(contract.DeviceControlRelationSchema, {
    relationId: deviceControlRelationId(record.controllerDeviceId, record.targetDeviceId),
    controllerDeviceId: record.controllerDeviceId,
    targetDeviceId: record.targetDeviceId,
    outboundEnabled: record.outboundEnabled,
    inboundAllowed: record.inboundAllowed,
    effective: controller.state === "active" && target.state === "active" && target.remoteControlEnabled &&
      record.outboundEnabled && record.inboundAllowed,
    updatedAt: toProtoTimestamp(record.updatedAt),
    version: toProtoEntityVersion(record.revision, 0, record.updatedAt || observedAt)
  });
}

function paginate<T>(values: readonly T[], request: contract.PageRequest | undefined): PageSlice<T> {
  const offset = decodePageToken(request?.pageToken ?? "");
  const size = Math.min(Math.max(request?.pageSize || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const selected = values.slice(offset, offset + size);
  const next = offset + selected.length;
  return {
    values: selected,
    page: create(contract.PageInfoSchema, {
      nextPageToken: next < values.length ? encodePageToken(next) : "",
      totalSize: BigInt(values.length)
    })
  };
}

interface StorePageWindow {
  readonly offset: number;
  readonly limit: number;
}

function storePageWindow(request: contract.PageRequest | undefined): StorePageWindow {
  return {
    offset: decodePageToken(request?.pageToken ?? ""),
    limit: Math.min(Math.max(request?.pageSize || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE)
  };
}

function storePage<T>(values: readonly T[], totalSize: number, window: StorePageWindow): PageSlice<T> {
  const next = window.offset + values.length;
  return {
    values: [...values],
    page: create(contract.PageInfoSchema, {
      nextPageToken: next < totalSize ? encodePageToken(next) : "",
      totalSize: BigInt(totalSize)
    })
  };
}

function collectStoreOffsetPages<T>(read: (offset: number, limit: number) => readonly T[]): T[] {
  const values: T[] = [];
  for (;;) {
    const page = read(values.length, STORE_QUERY_PAGE_SIZE);
    values.push(...page);
    if (page.length < STORE_QUERY_PAGE_SIZE) return values;
  }
}

function paginateWorkspaceEntries(
  values: readonly contract.WorkspaceEntry[],
  request: contract.PageRequest | undefined,
  revision: string
): PageSlice<contract.WorkspaceEntry> {
  const cursor = decodeWorkspaceEntryPageToken(request?.pageToken ?? "");
  if (cursor !== undefined && cursor.revision !== revision) {
    throw new ConnectError(
      "Workspace entries changed while the directory was being paged; restart from the first page.",
      Code.Aborted
    );
  }
  const offset = cursor?.offset ?? 0;
  if (offset > values.length) {
    throw new ConnectError("Workspace entry page token is outside the current result set.", Code.FailedPrecondition);
  }
  const size = Math.min(Math.max(request?.pageSize || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const selected = values.slice(offset, offset + size);
  const next = offset + selected.length;
  return {
    values: selected,
    page: create(contract.PageInfoSchema, {
      nextPageToken: next < values.length ? encodeWorkspaceEntryPageToken(revision, next) : "",
      totalSize: BigInt(values.length)
    })
  };
}

function workspaceEntryListingRevision(values: readonly contract.WorkspaceEntry[]): string {
  const hash = createHash("sha256");
  hash.update("joko.workspace-entry-listing.v1\0");
  for (const value of values) {
    const bytes = toBinary(contract.WorkspaceEntrySchema, value);
    hash.update(String(bytes.byteLength));
    hash.update("\0");
    hash.update(bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}

function encodeWorkspaceEntryPageToken(revision: string, offset: number): string {
  return Buffer.from(JSON.stringify({ version: 1, revision, offset }), "utf8").toString("base64url");
}

function decodeWorkspaceEntryPageToken(token: string): { readonly revision: string; readonly offset: number } | undefined {
  if (token === "") return undefined;
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== token) throw new Error("non-canonical");
    const value: unknown = JSON.parse(decoded);
    const record = asRecord(value);
    if (record["version"] !== 1) throw new Error("version");
    const revision = record["revision"];
    const offset = record["offset"];
    if (typeof revision !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(revision)) throw new Error("revision");
    if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0) throw new Error("offset");
    return { revision, offset };
  } catch {
    throw invalidArgument("page_token is malformed");
  }
}

function emptyPage(request: contract.PageRequest | undefined): contract.PageInfo {
  return paginate([], request).page;
}

function encodePageToken(offset: number): string {
  return Buffer.from(`joko-page:${offset}`, "utf8").toString("base64url");
}

function decodePageToken(token: string): number {
  if (token === "") return 0;
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const match = /^joko-page:(\d+)$/u.exec(decoded);
    if (match?.[1] === undefined || Buffer.from(decoded, "utf8").toString("base64url") !== token) throw new Error("invalid");
    const value = Number(match[1]);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("range");
    return value;
  } catch {
    throw invalidArgument("page_token is malformed");
  }
}

function validateStreamCursor(cursor: contract.EventCursor, generation: bigint, highWater: bigint): bigint {
  const decoded = fromProtoEventCursor(cursor);
  if (decoded.generation !== generation) {
    throw new ConnectError("The cursor belongs to an earlier Orchestrator runtime generation; fetch a new snapshot.", Code.FailedPrecondition);
  }
  if (decoded.sequence > highWater) {
    throw new ConnectError("The cursor is ahead of Orchestrator's durable event history; fetch a new snapshot.", Code.FailedPrecondition);
  }
  return decoded.sequence;
}

function eventWithServiceCursor(item: PersistedEvent, dependencies: ConnectServiceDependencies, generation: bigint): contract.Event {
  const mapped = toProtoEvent(item, eventContext(item, dependencies));
  return create(contract.EventSchema, {
    ...mapped,
    cursor: toProtoEventCursor(item.globalCursor, generation, item.emittedAt)
  });
}

function eventContext(
  item: PersistedEvent,
  dependencies: ConnectServiceDependencies
): Parameters<typeof toProtoEvent>[1] {
  const store = dependencies.store;
  let session: StoredSession | undefined;
  let target: StoredTarget | undefined;
  let run: StoredRun | undefined;
  let queueItem: QueueItemRecord | undefined;
  let queueControl: import("@joko/store").QueueControlRecord | undefined;
  let interaction: InteractionRecord | undefined;
  try { session = store.getSession(item.sessionId); } catch { /* Historical tombstone. */ }
  try { target = store.getTarget(item.targetId); } catch { /* Historical tombstone. */ }
  if (item.runId !== undefined) {
    try { run = store.getRun(item.runId); } catch { /* Historical tombstone. */ }
    queueItem = store.findQueueItemByRunId(item.sessionId, item.runId);
  }
  if (item.payload.type === "interaction_opened" || item.payload.type === "interaction_resolved" || item.payload.type === "interaction_dismissed") {
    const id = item.payload.type === "interaction_opened" ? item.payload.interaction.id : item.payload.interactionId;
    try { interaction = store.getInteraction(id); } catch { /* Event still maps its embedded payload. */ }
  }
  if (item.payload.type === "queue_control") {
    try { queueControl = store.getQueueControl(item.sessionId); } catch { /* Historical tombstone. */ }
  }
  const artifact = item.payload.type === "artifact" ? store.findArtifact(item.payload.artifact.id) : undefined;
  const sessionActiveRun = item.payload.type === "session_changed" && session !== undefined
    ? activeRun(store, session.descriptor.id)
    : undefined;
  const sessionContext = item.payload.type === "session_changed" && session !== undefined
    ? sessionProjectionContext(store, session, {
        ...(sessionActiveRun === undefined ? {} : { activeRun: sessionActiveRun }),
        runtimeAttached: sessionActiveRun !== undefined,
        resolveContextDefaults: dependencies.resolveSessionContextDefaults,
        runtimeModel: dependencies.sessionHost.getSessionRuntimeControl(session.descriptor.id).effective
      })
    : undefined;
  return {
    ...(session === undefined ? {} : { session }),
    ...(target === undefined ? {} : { target }),
    ...(run === undefined ? {} : { run, attempts: store.listAttempts(run.descriptor.id) }),
    ...(queueItem === undefined ? {} : { queueItem }),
    ...(queueControl === undefined ? {} : { queueControl }),
    ...(interaction === undefined ? {} : { interaction }),
    ...(artifact === undefined ? {} : { artifact }),
    ...(sessionContext === undefined ? {} : { sessionContext })
  };
}

function eventMatchesScope(item: PersistedEvent, scope: contract.SnapshotScope | undefined, dependencies: ConnectServiceDependencies): boolean {
  switch (scope?.kind.case) {
    case undefined:
    case "owner": return true;
    case "backend": return item.backendId === scope.kind.value.backendId;
    case "target": return item.targetId === scope.kind.value.targetId;
    case "session": return item.sessionId === scope.kind.value.sessionId;
    case "workspace": {
      const target = targetForWorkspace(dependencies.store, scope.kind.value.workspaceId);
      return target !== undefined && item.targetId === target.descriptor.id;
    }
    case "schedule": {
      const schedule = dependencies.store.findSchedule(scope.kind.value.scheduleId);
      return schedule !== undefined && item.targetId === schedule.targetId && (schedule.sessionId === undefined || item.sessionId === schedule.sessionId);
    }
    case "tool": return true;
  }
}

class AsyncEventQueue<T = PersistedEvent> {
  readonly #signal: AbortSignal;
  readonly #values: T[] = [];
  readonly #waiters: Array<(value: T | undefined) => void> = [];
  #closed = false;

  constructor(signal: AbortSignal) {
    this.#signal = signal;
    signal.addEventListener("abort", () => this.close(), { once: true });
  }

  push(value: T): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#values.push(value);
    else waiter(value);
  }

  next(): Promise<T | undefined> {
    if (this.#signal.aborted || this.#closed) return Promise.resolve(undefined);
    const value = this.#values.shift();
    if (value !== undefined) return Promise.resolve(value);
    return new Promise((resolvePromise) => this.#waiters.push(resolvePromise));
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) waiter(undefined);
    this.#values.length = 0;
  }
}

function activeRun(store: OperationalStore, sessionId: string): StoredRun | undefined {
  return store.listRuns({ sessionId, activeOnly: true, limit: 1 })[0];
}

function projectPlacementSession(
  store: OperationalStore,
  sessionId: string
): ProjectPlacementSessionSnapshot {
  const session = store.getSession(sessionId);
  const run = activeRun(store, sessionId);
  const activity: ProjectPlacementSessionSnapshot["activity"] = run === undefined
    ? "idle"
    : run.descriptor.state === "waiting"
      ? "waiting"
      : run.descriptor.state === "retrying" || run.descriptor.state === "dispatch_unknown"
        ? "recovering"
        : "running";
  return {
    id: session.descriptor.id,
    revision: session.revision,
    backendId: session.descriptor.backendId,
    targetId: session.descriptor.targetId,
    ...(session.descriptor.projectId === undefined ? {} : { projectId: session.descriptor.projectId }),
    archived: session.descriptor.archived,
    deleted: session.descriptor.deletedAt !== undefined,
    remoteWorkspace: session.descriptor.remoteWorkspace !== undefined,
    // External live takeover/attachment is not a supported Joko Session mode;
    // native activation alone does not change navigation placement safety.
    runtimeAttached: false,
    activity
  };
}

function projectPlacementTarget(
  store: OperationalStore,
  projectId: string | undefined
): ProjectPlacementTargetSnapshot | undefined {
  if (projectId === undefined) return undefined;
  const target = store.getTarget(projectId);
  const metadata = asRecord(target.metadata);
  const state = metadata["state"];
  return {
    id: target.descriptor.id,
    active: (state === undefined || state === "active") && metadata["deletedAt"] === undefined,
    remoteWorkspace: target.descriptor.remoteWorkspace !== undefined
  };
}

function placementPlanOrThrow(input: {
  readonly store: OperationalStore;
  readonly sessionId: string;
  readonly projectId?: string;
}): SessionProjectPlacementPlan {
  try {
    return evaluateSessionProjectPlacement({
      sessionId: input.sessionId,
      placement: input.projectId === undefined
        ? { kind: "dialogue" }
        : { kind: "project", projectId: input.projectId },
      session: projectPlacementSession(input.store, input.sessionId),
      project: projectPlacementTarget(input.store, input.projectId)
    });
  } catch (error) {
    if (!(error instanceof SessionProjectPlacementError)) throw error;
    const code = error.code === "invalid_identity"
      ? Code.InvalidArgument
      : error.code === "session_not_found" || error.code === "project_not_found"
        ? Code.NotFound
        : Code.FailedPrecondition;
    throw new ConnectError(error.message, code);
  }
}

function mapSession(
  dependencies: Pick<ConnectServiceDependencies, "store" | "sessionHost" | "resolveSessionContextDefaults">,
  session: StoredSession
): contract.Session {
  const sessionActiveRun = activeRun(dependencies.store, session.descriptor.id);
  return toProtoSession(session, sessionProjectionContext(dependencies.store, session, {
    ...(sessionActiveRun === undefined ? {} : { activeRun: sessionActiveRun }),
    runtimeAttached: sessionActiveRun !== undefined,
    resolveContextDefaults: dependencies.resolveSessionContextDefaults,
    runtimeModel: dependencies.sessionHost.getSessionRuntimeControl(session.descriptor.id).effective
  }));
}

function mapRun(store: OperationalStore, record: StoredRun): contract.Run {
  const session = store.getSession(record.descriptor.sessionId);
  const queueItem = store.findQueueItemByRunId(record.descriptor.sessionId, record.descriptor.id);
  return toProtoRun(record, {
    backendId: session.descriptor.backendId,
    targetId: session.descriptor.targetId,
    attempts: store.listAttempts(record.descriptor.id),
    ...(queueItem === undefined ? {} : { sourceQueueItemId: queueItem.id })
  });
}

function mapQueueItem(store: OperationalStore, item: QueueItemRecord, ordinal: bigint): contract.QueueItem {
  const session = store.getSession(item.sessionId);
  const run = store.getRun(item.runId);
  return toProtoQueueItem(item, {
    backendId: session.descriptor.backendId,
    targetId: session.descriptor.targetId,
    source: run.descriptor.source,
    ...(run.descriptor.parentRunId === undefined ? {} : { parentRunId: run.descriptor.parentRunId }),
    generation: session.descriptor.binding.generation
  }, ordinal);
}

function mapQueueControl(store: OperationalStore, sessionId: string): contract.QueueControl {
  const control = store.getQueueControl(sessionId);
  const session = store.getSession(sessionId);
  const queued = store.countQueueItems({ sessionId, states: ["accepted"] });
  return toProtoQueueControl(control, session, queued);
}

function mapSchedule(store: OperationalStore, schedule: ScheduleRecord): contract.Schedule {
  const history = store.listScheduleRuns(schedule.id, 20);
  return toProtoSchedule(schedule, history, runMap(store, history), store.countUnreadScheduleRuns(schedule.id));
}

function runMap(store: OperationalStore, history: readonly import("@joko/store").ScheduleRunRecord[]): ReadonlyMap<string, StoredRun> {
  const runs = new Map<string, StoredRun>();
  for (const item of history) {
    const run = store.findRun(item.runId);
    if (run !== undefined) runs.set(run.descriptor.id, run);
  }
  return runs;
}

function mapInteraction(store: OperationalStore, item: InteractionRecord): contract.Interaction {
  const session = store.getSession(item.sessionId);
  return toProtoInteraction(item, { backendId: session.descriptor.backendId, targetId: session.descriptor.targetId });
}

function visitSessionEvents(
  store: OperationalStore,
  sessionId: string,
  visitor: (event: PersistedEvent) => void
): void {
  let afterCursor: bigint | undefined;
  for (;;) {
    const page = store.listEvents({
      sessionId,
      ...(afterCursor === undefined ? {} : { afterCursor }),
      order: "asc",
      limit: STORE_QUERY_PAGE_SIZE
    });
    if (page.length === 0) return;
    let lastCursor = afterCursor ?? -1n;
    for (const event of page) {
      if (event.globalCursor <= lastCursor) {
        throw new StoreError("Session Event history did not advance while paging.");
      }
      visitor(event);
      lastCursor = event.globalCursor;
    }
    if (page.length < STORE_QUERY_PAGE_SIZE) return;
    afterCursor = lastCursor;
  }
}

async function sessionStatistics(dependencies: ConnectServiceDependencies, sessionId: string): Promise<contract.SessionStatistics> {
  dependencies.store.getSession(sessionId);
  const runtimeState = materializedSessionRuntimeState(dependencies.store.findSetting(
    "session",
    sessionId,
    SESSION_RUNTIME_STATE_SETTING_KEY
  )?.value);
  let messageCount = 0n;
  let turnCount = 0n;
  let compactionCount = 0n;
  visitSessionEvents(dependencies.store, sessionId, (event) => {
    if (event.payload.type === "message_complete" && event.payload.automaticContinuation === undefined) {
      messageCount += 1n;
    }
    if (event.payload.type === "done") turnCount += 1n;
    if (event.payload.type === "compaction" && event.payload.state === "completed") compactionCount += 1n;
  });
  let branchCount = 0;
  try {
    const tree = await dependencies.sessionHost.getTree(sessionId);
    branchCount = countTreeNodes(tree.roots);
  } catch {
    branchCount = 0;
  }
  const activeDuration = dependencies.store.sumRunActiveDuration({ sessionId });
  return create(contract.SessionStatisticsSchema, {
    sessionId,
    messageCount,
    turnCount,
    branchCount: BigInt(branchCount),
    compactionCount,
    ...(runtimeState?.usage === undefined ? {} : {
      usage: toProtoUsage(runtimeState.usage),
      context: toProtoContextUsage(runtimeState.usage, runtimeState.updatedAt)
    }),
    activeDuration: toProtoDuration(activeDuration)
  });
}

function snapshotReviewRuns(store: OperationalStore, scope: contract.SnapshotScope): contract.ReviewRun[] {
  const runs = collectStoreOffsetPages((offset, limit) => store.listReviewRuns({ limit, offset }));
  if (scope.kind.case === "owner") return runs.map((run) => mapStoredReviewRun(store, run));
  if (scope.kind.case === "session") {
    const sessionId = scope.kind.value.sessionId;
    return runs
      .filter((run) => run.sourceSessionId === sessionId || run.reviewerSessionId === sessionId)
      .map((run) => mapStoredReviewRun(store, run));
  }
  return [];
}

function mapStoredReviewRun(store: OperationalStore, run: import("@joko/store").ReviewRunRecord): contract.ReviewRun {
  return toProtoReviewRun(run, store.getReviewRunBundle(run.id).evidenceSeal);
}

function countTreeNodes(nodes: readonly SessionTreeNode[]): number {
  let count = 0;
  const seenNodes = new Set<object>();
  const seenEntryIds = new Set<string>();
  const stack = [...nodes].reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    const children = checkedSessionTreeChildren(node, seenNodes, seenEntryIds);
    count += 1;
    if (!Number.isSafeInteger(count)) throw new StoreError("Session tree node count exceeds the safe integer range.");
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]!);
  }
  return count;
}

function mapSessionTreeNodes<Output>(
  nodes: readonly SessionTreeNode[],
  project: (node: SessionTreeNode, children: Output[]) => Output
): Output[] {
  const roots: Output[] = [];
  const seenNodes = new Set<object>();
  const seenEntryIds = new Set<string>();
  const stack: Array<{
    readonly node: SessionTreeNode;
    readonly output: Output[];
    readonly mappedChildren?: Output[];
  }> = [];
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    stack.push({ node: nodes[index]!, output: roots });
  }
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.mappedChildren !== undefined) {
      frame.output.push(project(frame.node, frame.mappedChildren));
      continue;
    }
    const children = checkedSessionTreeChildren(frame.node, seenNodes, seenEntryIds);
    const mappedChildren: Output[] = [];
    stack.push({ ...frame, mappedChildren });
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ node: children[index]!, output: mappedChildren });
    }
  }
  return roots;
}

function checkedSessionTreeChildren(
  node: SessionTreeNode,
  seenNodes: Set<object>,
  seenEntryIds: Set<string>
): readonly SessionTreeNode[] {
  if (
    typeof node !== "object" ||
    node === null ||
    typeof node.entryId !== "string" ||
    node.entryId.length === 0 ||
    !Array.isArray(node.children)
  ) throw new StoreError("Session tree contains an invalid node.");
  if (seenNodes.has(node) || seenEntryIds.has(node.entryId)) {
    throw new StoreError("Session tree contains a cycle or repeated entry.");
  }
  seenNodes.add(node);
  seenEntryIds.add(node.entryId);
  return node.children;
}

function nativeTree(sessionId: string, tree: SessionTree, revision: bigint): contract.NativeSessionTree {
  const nestedRoots = mapSessionTreeNodes<contract.NativeSessionTreeNestedNode>(
    tree.roots,
    (node, children) => nativeTreeNode(node, tree.leafId, children)
  );
  return create(contract.NativeSessionTreeSchema, {
    sessionId,
    activeEntryId: tree.leafId ?? "",
    ...contract.nativeSessionTreeWireFields(nestedRoots),
    revision: toProtoRevision(revision)
  });
}

function mapNativeSessionCandidate(
  dependencies: ConnectServiceDependencies,
  target: StoredTarget,
  candidate: CoreNativeSessionCandidate,
  observedAt: number
): contract.NativeSessionCandidate {
  const common = nativeSessionCandidateFields(dependencies, target, candidate, observedAt);
  return create(contract.NativeSessionCandidateSchema, {
    ...common,
    state: candidate.state === "ready"
      ? contract.NativeSessionCandidateState.READY
      : contract.NativeSessionCandidateState.ERROR
  });
}

function mapNativeSessionCatalogEntry(
  entry: CoreNativeSessionCatalogEntry,
  targetId: string | undefined,
  projectTargetId: string | undefined,
  existingSessionId: string | undefined,
  observedAt: number
): contract.NativeSessionCatalogEntry {
  const modifiedAt = normalizeNativeTimestamp(entry.modifiedAt, observedAt);
  const createdAt = Math.min(normalizeNativeTimestamp(entry.createdAt, modifiedAt), modifiedAt);
  return create(contract.NativeSessionCatalogEntrySchema, {
    nativeSessionId: entry.nativeSessionId ?? "",
    nativeReference: entry.nativeReference,
    title: entry.title ?? "",
    ...(entry.workingDirectory === undefined ? {} : { workingDirectory: entry.workingDirectory }),
    ...(entry.projectDirectory === undefined ? {} : { projectDirectory: entry.projectDirectory }),
    modifiedAt: toProtoTimestamp(modifiedAt),
    createdAt: toProtoTimestamp(createdAt),
    archived: entry.archived,
    placement: entry.placement === "dialogue"
      ? contract.NativeSessionPlacement.DIALOGUE
      : contract.NativeSessionPlacement.PROJECT,
    ...(targetId === undefined ? {} : { targetId }),
    ...(projectTargetId === undefined ? {} : { projectTargetId }),
    ...(existingSessionId === undefined ? {} : { existingSessionId })
  });
}

function nativeSessionCatalogTargetIds(targets: readonly StoredTarget[]): ReadonlyMap<string, string> {
  const targetIds = new Map<string, string>();
  for (const target of targets) {
    const metadata = asRecord(target.metadata);
    const state = metadata["state"];
    if (
      target.descriptor.remoteWorkspace !== undefined
      || metadata["deletedAt"] !== undefined
      || (state !== undefined && state !== "active")
    ) continue;
    const identity = serviceNodePathIdentity(target.descriptor.workspaceRoot);
    if (!targetIds.has(identity)) targetIds.set(identity, target.descriptor.id);
  }
  return targetIds;
}

function assertNativeSessionCatalogResult(result: import("@joko/core").NativeSessionCatalogResult): void {
  if (!Number.isSafeInteger(result.rejectedCount) || result.rejectedCount < 0 || result.entries.length > 10_000) {
    throw new ConnectError("Backend returned an invalid native task catalog.", Code.Internal);
  }
  for (const entry of result.entries) {
    if (
      entry.nativeReference.length === 0
      || entry.nativeReference.length > 4_096
      || (entry.nativeSessionId !== undefined
        && (entry.nativeSessionId.length === 0 || entry.nativeSessionId.length > 1_024))
      || (entry.title !== undefined && entry.title.length > 8_192)
      || (entry.workingDirectory !== undefined && !validNativeCatalogDirectory(entry.workingDirectory))
      || (entry.projectDirectory !== undefined && !validNativeCatalogDirectory(entry.projectDirectory))
      || (entry.placement === "project" && entry.projectDirectory === undefined)
      || (entry.placement === "dialogue" && entry.projectDirectory !== undefined)
      || (entry.placement !== "project" && entry.placement !== "dialogue")
      || (entry.existingMatch !== "binding" && entry.existingMatch !== "binding_and_placement")
      || typeof entry.archived !== "boolean"
      || !Number.isSafeInteger(entry.createdAt)
      || entry.createdAt < 0
      || !Number.isSafeInteger(entry.modifiedAt)
      || entry.modifiedAt < 0
      || entry.createdAt > entry.modifiedAt
    ) throw new ConnectError("Backend returned an invalid native task catalog entry.", Code.Internal);
  }
}

function validNativeCatalogDirectory(value: string): boolean {
  return value.length > 0
    && value.length <= 32_768
    && !value.includes("\0")
    && isAbsolute(value);
}

function validNativeCatalogSnapshotToken(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !/[\p{Cc}\u2028\u2029]/u.test(value);
}

function serviceNodePathIdentity(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function nativeSessionCandidateFields(
  dependencies: ConnectServiceDependencies,
  target: StoredTarget,
  candidate: CoreNativeSessionCandidate,
  observedAt: number
) {
  const bound = dependencies.store.findLiveSessionByNativeBinding(
    target.descriptor.backendId,
    candidate.nativeReference
  );
  return {
    nativeSessionId: candidate.nativeSessionId ?? "",
    nativeReference: candidate.nativeReference,
    name: candidate.name ?? "",
    // The selected Target is the authorization boundary. Never project an
    // untrusted cwd string copied from native persistence metadata.
    workspaceRoot: target.descriptor.workspaceRoot,
    messageCount: BigInt(candidate.messageCount),
    modifiedAt: toProtoTimestamp(normalizeNativeTimestamp(candidate.modifiedAt, observedAt)),
    ...(bound === undefined ? {} : { boundSessionId: bound.descriptor.id })
  };
}

function nativeTreeNode(
  node: SessionTreeNode,
  leafId: string | undefined,
  children: contract.NativeSessionTreeNestedNode[]
): contract.NativeSessionTreeNestedNode {
  return {
    ...create(contract.NativeSessionTreeNodeSchema, {
    entryId: node.entryId,
    parentEntryId: node.parentId ?? "",
    kind: nativeEntryKind(node.kind, node.role),
    summary: node.label ?? "",
    createdAt: toProtoTimestamp(node.timestamp),
    active: node.entryId === leafId,
    childCount: 0
    }),
    children
  };
}

function nativeEntryKind(kind: string, role?: SessionTreeNode["role"]): contract.NativeEntryKind {
  if (role === "user") return contract.NativeEntryKind.USER_MESSAGE;
  if (role === "assistant") return contract.NativeEntryKind.ASSISTANT_MESSAGE;
  if (role === "toolResult") return contract.NativeEntryKind.TOOL_RESULT;
  const normalized = kind.toLowerCase();
  if (normalized.includes("user")) return contract.NativeEntryKind.USER_MESSAGE;
  if (normalized.includes("assistant")) return contract.NativeEntryKind.ASSISTANT_MESSAGE;
  if (normalized.includes("tool")) return contract.NativeEntryKind.TOOL_RESULT;
  if (normalized.includes("compact")) return contract.NativeEntryKind.COMPACTION;
  if (normalized.includes("branch")) return contract.NativeEntryKind.BRANCH_SUMMARY;
  if (normalized.includes("model")) return contract.NativeEntryKind.MODEL_CHANGE;
  return contract.NativeEntryKind.CUSTOM;
}

function targetForWorkspace(store: OperationalStore, workspaceId: string): StoredTarget | undefined {
  const directTarget = store.listTargets().find((item) => {
    const metadata = asRecord(item.metadata);
    return metadata["workspaceId"] === workspaceId || item.descriptor.id === workspaceId;
  });
  if (directTarget !== undefined) return directTarget;
  const isolatedSession = sessionForIsolatedWorkspace(store, workspaceId);
  return isolatedSession === undefined ? undefined : store.getTarget(isolatedSession.descriptor.targetId);
}

function sessionForIsolatedWorkspace(store: OperationalStore, workspaceId: string): StoredSession | undefined {
  return store.listSessions({ includeArchived: true, includeDeleted: false })
    .find((session) => session.descriptor.worktree?.workspaceId === workspaceId);
}

const GIT_WRITE_BUSY_QUEUE_STATES = [
  "accepted",
  "dispatching",
  "backend_accepted",
  "dispatch_unknown"
] as const;

function assertSessionArchiveIdle(store: OperationalStore, sessionId: string): void {
  store.getSession(sessionId);
  const busy = store.listRuns({ sessionId, activeOnly: true, limit: 1 }).length > 0
    || store.listQueueItems({
      sessionId,
      states: GIT_WRITE_BUSY_QUEUE_STATES,
      limit: 1
    }).length > 0;
  if (busy) {
    throw new ConnectError(
      "A running or queued task must be stopped before it can be archived.",
      Code.FailedPrecondition
    );
  }
}

/**
 * Git Review writes affect the Target worktree shared by every bound task.
 * Re-resolve the workspace binding on each check and fail closed when any of
 * those tasks has durable active or queued work.
 */
function assertWorkspaceGitWriteIdle(
  store: OperationalStore,
  workspaceId: string,
  expectedTargetId: string
): void {
  const currentTarget = targetForWorkspace(store, workspaceId);
  if (currentTarget?.descriptor.id !== expectedTargetId) {
    throw new ConnectError("The workspace Target changed before the Git operation could start.", Code.FailedPrecondition);
  }
  const isolatedSession = sessionForIsolatedWorkspace(store, workspaceId);
  const sessions = isolatedSession === undefined
    ? store.listSessions({
        targetId: expectedTargetId,
        includeArchived: true,
        includeDeleted: false
      }).filter((session) => session.descriptor.targetId === expectedTargetId)
    : [isolatedSession];
  const busy = sessions.some((session) =>
    store.listRuns({ sessionId: session.descriptor.id, activeOnly: true, limit: 1 }).length > 0 ||
    store.listQueueItems({
      sessionId: session.descriptor.id,
      states: GIT_WRITE_BUSY_QUEUE_STATES,
      limit: 1
    }).length > 0
  );
  if (busy) {
    throw new ConnectError(
      "Git Review changes are unavailable while this workspace has active or queued task work.",
      Code.FailedPrecondition
    );
  }
}

function requireWorkspace(service: NativeWorkspaceService, id: string): WorkspaceRegistration {
  const item = service.listRegistrations().find((candidate) => candidate.id === id);
  if (item === undefined) throw new ConnectError(`Workspace ${id} does not exist.`, Code.NotFound);
  return item;
}

function nativeWorkspaceFileChangeScope(scope: contract.WorkspaceFileChangeScope | undefined): WorkspaceFileChangeScope {
  if (scope?.kind.case === "owner") return { kind: "owner" };
  if (scope?.kind.case === "workspace") {
    const workspaceId = scope.kind.value.workspaceId.trim();
    if (workspaceId === "") throw invalidArgument("scope.workspace.workspace_id is required");
    return { kind: "workspace", workspaceId };
  }
  throw invalidArgument("scope must explicitly select the authenticated owner or one workspace");
}

function workspaceFileWatchSupported(dependencies: ConnectServiceDependencies, workspaceId: string): boolean {
  const target = targetForWorkspace(dependencies.store, workspaceId);
  if (target === undefined) return false;
  return dependencies.store.getBackend(target.descriptor.backendId).descriptor.capabilities
    .get("workspace.files.watch")?.supported === true;
}

function assertWorkspaceFileWatchSupported(dependencies: ConnectServiceDependencies, workspaceId: string): void {
  if (!workspaceFileWatchSupported(dependencies, workspaceId)) {
    throw new ConnectError("Backend does not support workspace.files.watch.", Code.FailedPrecondition);
  }
}

function mapWorkspaceFileChange(change: WorkspaceFileChangeRecord): contract.WorkspaceFileChange {
  return create(contract.WorkspaceFileChangeSchema, {
    workspaceId: change.workspaceId,
    kind: protoWorkspaceFileChangeKind(change.kind),
    relativePath: change.path ?? "",
    previousRelativePath: change.previousPath ?? "",
    revision: change.revision === undefined
      ? undefined
      : create(contract.FileRevisionSchema, {
          sha256Hex: "",
          opaqueRevision: change.revision.opaqueRevision,
          byteSize: BigInt(change.revision.byteSize),
          modifiedAt: toProtoTimestamp(Math.trunc(change.revision.modifiedAt))
        }),
    sequence: change.sequence,
    streamRevision: change.streamRevision,
    observedAt: toProtoTimestamp(change.observedAt)
  });
}

function protoWorkspaceFileChangeKind(kind: WorkspaceFileChangeRecord["kind"]): contract.WorkspaceFileChangeKind {
  switch (kind) {
    case "created": return contract.WorkspaceFileChangeKind.CREATED;
    case "modified": return contract.WorkspaceFileChangeKind.MODIFIED;
    case "deleted": return contract.WorkspaceFileChangeKind.DELETED;
    case "renamed": return contract.WorkspaceFileChangeKind.RENAMED;
    case "overflow": return contract.WorkspaceFileChangeKind.OVERFLOW;
    case "resync": return contract.WorkspaceFileChangeKind.RESYNC;
  }
}

async function mapWorkspace(dependencies: ConnectServiceDependencies, registration: WorkspaceRegistration): Promise<contract.WorkspaceDescriptor> {
  const target = targetForWorkspace(dependencies.store, registration.id);
  const revision = target?.revision ?? dependencies.store.health().revision;
  return create(contract.WorkspaceDescriptorSchema, {
    workspaceId: registration.id,
    targetId: target?.descriptor.id ?? "",
    displayName: registration.displayName,
    kind: target?.descriptor.managed === true ? contract.WorkspaceKind.MANAGED_DIALOGUE : contract.WorkspaceKind.USER_PROJECT,
    serverPathDisplay: registration.root,
    trusted: registration.trusted,
    git: mapGitState(await dependencies.workspaceService.gitState(registration.id)),
    version: toProtoEntityVersion(revision, 0, target?.updatedAt ?? Date.now())
  });
}

function nativeWorkspaceEntryListingPolicy(
  policy: contract.WorkspaceEntryListingPolicy
): WorkspaceEntryListingPolicy {
  if (
    policy === contract.WorkspaceEntryListingPolicy.UNSPECIFIED ||
    policy === contract.WorkspaceEntryListingPolicy.DEFAULT
  ) return "default";
  if (policy === contract.WorkspaceEntryListingPolicy.DOCUMENT_TREE) return "document_tree";
  throw invalidArgument("listing_policy is unsupported");
}

function mapWorkspaceEntry(workspaceId: string, item: WorkspaceEntryRecord, mediaType = mediaTypeForPath(item.path)): contract.WorkspaceEntry {
  return create(contract.WorkspaceEntrySchema, {
    workspaceId,
    relativePath: item.path,
    displayName: item.name,
    kind: item.kind === "directory" ? contract.FileKind.DIRECTORY : contract.FileKind.REGULAR,
    revision: fileRevision(item),
    generated: item.generated,
    ignored: false,
    hidden: isHiddenPath(item.path),
    mediaType
  });
}

function fileRevision(item: WorkspaceEntryRecord): contract.FileRevision {
  return create(contract.FileRevisionSchema, {
    sha256Hex: "",
    byteSize: BigInt(item.size),
    modifiedAt: toProtoTimestamp(Math.trunc(item.modifiedAt)),
    opaqueRevision: item.revision
  });
}

function preserveFileRevision(value: contract.FileRevision | undefined, opaqueRevision: string): contract.FileRevision {
  if (value?.opaqueRevision === opaqueRevision) return value;
  return create(contract.FileRevisionSchema, {
    sha256Hex: value?.sha256Hex ?? "",
    byteSize: value?.byteSize ?? 0n,
    ...(value?.modifiedAt === undefined ? {} : { modifiedAt: value.modifiedAt }),
    opaqueRevision
  });
}

async function mapFilePreview(
  artifacts: ArtifactStore,
  workspaceId: string,
  preview: WorkspaceFilePreview,
  start: number,
  maximum: number,
  materialized?: ArtifactRecord
): Promise<contract.FilePreview> {
  let content: contract.FilePreview["content"];
  let byteWindowTruncated = false;
  if (preview.bytes !== undefined || materialized !== undefined) {
    const record = materialized ?? await artifacts.ingestBytes(preview.bytes!, {
      fileName: basename(preview.entry.path),
      mimeType: preview.mediaType,
      expiresAt: Date.now() + 5 * 60 * 1000
    });
    const blob = directArtifactBlob(
      record,
      preview.mediaType.startsWith("image/") ? contract.BlobDisposition.INLINE : contract.BlobDisposition.ATTACHMENT
    );
    content = preview.mediaType.startsWith("image/")
      ? {
          case: "image",
          value: create(contract.ImageRefSchema, {
            blob,
            widthPixels: 0,
            heightPixels: 0,
            altText: basename(preview.entry.path)
          })
        }
      : { case: "blob", value: blob };
  } else if (preview.text === undefined) {
    content = {
      case: "binary",
      value: create(contract.BinaryFilePreviewSchema, { mediaType: preview.mediaType, summary: `${preview.entry.size} bytes` })
    };
  } else {
    const source = Buffer.from(preview.text, "utf8");
    const end = Math.min(source.byteLength, start + maximum);
    const text = source.subarray(Math.min(start, source.byteLength), end).toString("utf8");
    byteWindowTruncated = start + maximum < preview.entry.size;
    content = {
      case: "text",
      value: create(contract.TextFilePreviewSchema, {
        utf8Text: text,
        languageId: languageForPath(preview.entry.path),
        startByte: BigInt(start),
        endByte: BigInt(end),
        totalLines: preview.text.split(/\r?\n/u).length
      })
    };
  }
  return create(contract.FilePreviewSchema, {
    entry: mapWorkspaceEntry(workspaceId, preview.entry),
    content,
    truncated: preview.truncated || byteWindowTruncated
  });
}

function mapWorkspaceSearchResult(item: WorkspaceSearchResult): contract.WorkspaceSearchMatch {
  return create(contract.WorkspaceSearchMatchSchema, {
    relativePath: item.path,
    range: create(contract.TextRangeSchema, {
      startByte: BigInt(Math.max(0, item.startByte)),
      endByte: BigInt(Math.max(item.startByte, item.endByte)),
      startLine: Math.max(0, item.line),
      startColumn: Math.max(0, item.column),
      endLine: Math.max(0, item.line),
      endColumn: Math.max(0, item.endColumn)
    }),
    linePreview: item.preview,
    submatches: (item.submatches ?? []).map((submatch) => create(contract.WorkspaceSearchSubmatchSchema, {
      startByte: BigInt(submatch.startByte),
      endByte: BigInt(submatch.endByte)
    })),
    revision: create(contract.FileRevisionSchema, {
      sha256Hex: "",
      byteSize: 0n,
      opaqueRevision: item.revision
    })
  });
}

function workspaceSearchPrefixGlob(value: string): string | undefined {
  if (value === "") return undefined;
  const normalized = value.replace(/\/$/u, "");
  if (
    normalized === ""
    || normalized.startsWith("/")
    || /^[a-z]:/iu.test(normalized)
    || normalized.includes("\\")
    || /[\0-\x1f\x7f*?\[\]{}]/u.test(normalized)
    || normalized.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw invalidArgument("relative_path_prefix must be a canonical relative workspace directory");
  }
  return `${normalized}/**`;
}

function mapWorkspaceChangeSet(item: WorkspaceChangeSetRecord): contract.WorkspaceChangeSet {
  return create(contract.WorkspaceChangeSetSchema, {
    changeSetId: item.id,
    workspaceId: item.workspaceId,
    sessionId: item.sessionId,
    runId: item.runId,
    turnId: item.runId,
    baselineId: item.baselineId,
    changes: item.changes.map(mapWorkspaceChange),
    completeBaseline: item.complete,
    gaps: item.gaps.map((gap) => mapRewindGap(gap)),
    capturedAt: toProtoTimestamp(item.capturedAt)
  });
}

function mapWorkspaceChange(item: WorkspaceChange): contract.FileChange {
  return create(contract.FileChangeSchema, {
    relativePath: item.path,
    oldRelativePath: "",
    kind: item.kind === "created"
      ? contract.FileChangeKind.CREATED
      : item.kind === "deleted" ? contract.FileChangeKind.DELETED : contract.FileChangeKind.UPDATED,
    beforeRevision: item.before === undefined ? undefined : snapshotFileRevision(item.before),
    afterRevision: item.after === undefined ? undefined : snapshotFileRevision(item.after),
    diff: undefined
  });
}

function mapInverseWorkspaceChange(item: WorkspaceChange): contract.FileChange {
  return create(contract.FileChangeSchema, {
    relativePath: item.path,
    oldRelativePath: "",
    kind: item.kind === "created"
      ? contract.FileChangeKind.DELETED
      : item.kind === "deleted" ? contract.FileChangeKind.CREATED : contract.FileChangeKind.UPDATED,
    beforeRevision: item.after === undefined ? undefined : snapshotFileRevision(item.after),
    afterRevision: item.before === undefined ? undefined : snapshotFileRevision(item.before),
    diff: undefined
  });
}

function snapshotFileRevision(item: SnapshotFile): contract.FileRevision {
  return create(contract.FileRevisionSchema, {
    sha256Hex: item.sha256,
    byteSize: BigInt(item.byteLength),
    modifiedAt: toProtoTimestamp(item.modifiedAt),
    opaqueRevision: `${item.sha256}:${item.byteLength}:${item.modifiedAt}`
  });
}

function mapRewindGap(value: string): contract.RewindGap {
  const separator = value.indexOf(":");
  const relativePath = separator < 0 ? "" : value.slice(0, separator).trim();
  const lower = value.toLowerCase();
  const kind = lower.includes("symbolic link") || lower.includes("special file")
    ? contract.RewindGapKind.UNSUPPORTED_FILE
    : contract.RewindGapKind.CAPTURE_FAILED;
  return create(contract.RewindGapSchema, { kind, relativePath, explanation: value });
}

function mapWorkspaceRewindPreview(
  changeSet: WorkspaceChangeSetRecord,
  preview: RewindPreviewRecord,
  dialogueOnlyAvailable = false,
  diff?: contract.WorkspaceDiff
): contract.WorkspaceRewindPreview {
  const byPath = new Map(changeSet.changes.map((item) => [item.path, item]));
  return create(contract.WorkspaceRewindPreviewSchema, {
    previewId: preview.id,
    changeSetId: changeSet.id,
    workspaceId: changeSet.workspaceId,
    safety: preview.safe ? contract.RewindSafety.REQUIRES_CONFIRMATION : contract.RewindSafety.BLOCKED,
    inverseChanges: changeSet.changes.map(mapInverseWorkspaceChange),
    gaps: preview.gaps.map((gap) => mapRewindGap(gap)),
    conflicts: preview.conflicts.map((path) => {
      const expected = byPath.get(path)?.after;
      return create(contract.WorkspaceConflictSchema, {
        relativePath: path,
        expectedRevision: expected === undefined ? undefined : snapshotFileRevision(expected),
        actualRevision: undefined,
        explanation: "Workspace content changed after the captured run."
      });
    }),
    diff,
    expiresAt: toProtoTimestamp(preview.expiresAt),
    dialogueOnlyAvailable
  });
}

const REWIND_DIFF_MAXIMUM_BYTES = 1024 * 1024;
const REWIND_DIFF_MAXIMUM_LINES = 4_000;

async function buildInverseWorkspaceDiff(changeSet: WorkspaceChangeSetRecord): Promise<contract.WorkspaceDiff> {
  let remainingBytes = REWIND_DIFF_MAXIMUM_BYTES;
  let remainingLines = REWIND_DIFF_MAXIMUM_LINES;
  let truncated = false;
  const files: contract.FileDiff[] = [];
  for (const change of changeSet.changes) {
    const oldValue = await readSnapshotDiffText(change.after, remainingBytes);
    if (oldValue.truncated) truncated = true;
    remainingBytes = Math.max(0, remainingBytes - oldValue.bytesRead);
    const newValue = await readSnapshotDiffText(change.before, remainingBytes);
    if (newValue.truncated) truncated = true;
    remainingBytes = Math.max(0, remainingBytes - newValue.bytesRead);
    const binary = oldValue.binary || newValue.binary;
    const lines: contract.DiffLine[] = [];
    if (!binary && !oldValue.truncated && !newValue.truncated) {
      const removed = diffLines(oldValue.text, contract.DiffLineKind.REMOVED, true);
      const added = diffLines(newValue.text, contract.DiffLineKind.ADDED, false);
      const available = Math.max(0, remainingLines);
      const selected = [...removed, ...added].slice(0, available);
      if (selected.length < removed.length + added.length) truncated = true;
      lines.push(...selected);
      remainingLines -= selected.length;
    }
    files.push(create(contract.FileDiffSchema, {
      relativePath: change.path,
      oldRelativePath: "",
      status: change.kind === "created"
        ? contract.GitFileStatus.DELETED
        : change.kind === "deleted" ? contract.GitFileStatus.ADDED : contract.GitFileStatus.MODIFIED,
      binary,
      source: contract.GitDiffSource.UNSPECIFIED,
      hunks: lines.length === 0
        ? []
        : [create(contract.DiffHunkSchema, {
          oldStart: 1,
          oldCount: oldValue.lineCount,
          newStart: 1,
          newCount: newValue.lineCount,
          heading: "Dialogue/run inverse workspace change",
          lines
        })],
      fullDiff: undefined
    }));
  }
  return create(contract.WorkspaceDiffSchema, {
    workspaceId: changeSet.workspaceId,
    files,
    truncated,
    completeDiff: undefined
  });
}

async function readSnapshotDiffText(
  snapshot: SnapshotFile | undefined,
  maximumBytes: number
): Promise<{ readonly text: string; readonly lineCount: number; readonly binary: boolean; readonly truncated: boolean; readonly bytesRead: number }> {
  if (snapshot === undefined) return { text: "", lineCount: 0, binary: false, truncated: false, bytesRead: 0 };
  if (snapshot.byteLength > maximumBytes) {
    return { text: "", lineCount: 0, binary: false, truncated: true, bytesRead: 0 };
  }
  const bytes = await readFile(snapshot.blobPath);
  if (bytes.byteLength !== snapshot.byteLength || createHash("sha256").update(bytes).digest("hex") !== snapshot.sha256) {
    throw new ConnectError("Workspace snapshot content failed integrity verification.", Code.DataLoss);
  }
  if (bytes.includes(0)) return { text: "", lineCount: 0, binary: true, truncated: false, bytesRead: bytes.byteLength };
  const text = bytes.toString("utf8");
  return {
    text,
    lineCount: text === "" ? 0 : text.split(/\r?\n/u).length,
    binary: false,
    truncated: false,
    bytesRead: bytes.byteLength
  };
}

function diffLines(text: string, kind: contract.DiffLineKind, oldSide: boolean): contract.DiffLine[] {
  if (text === "") return [];
  return text.split(/\r?\n/u).map((line, index) => create(contract.DiffLineSchema, {
    kind,
    oldLine: oldSide ? index + 1 : 0,
    newLine: oldSide ? 0 : index + 1,
    text: line
  }));
}

function mapGitState(state: GitState): contract.GitRepositoryState {
  return create(contract.GitRepositoryStateSchema, {
    repository: state.repository,
    branchName: state.branch ?? "",
    headCommit: state.head ?? "",
    detachedHead: state.detachedHead,
    dirty: state.dirty,
    operationInProgress: state.operationInProgress,
    changes: state.changes.map((item) => create(contract.GitFileChangeSchema, {
      relativePath: item.path,
      oldRelativePath: item.originalPath ?? "",
      indexStatus: gitStatus(item.index),
      workingTreeStatus: gitStatus(item.worktree),
      binary: false
    }))
  });
}

function gitStatus(code: string): contract.GitFileStatus {
  switch (code) {
    case "A": return contract.GitFileStatus.ADDED;
    case "M": return contract.GitFileStatus.MODIFIED;
    case "D": return contract.GitFileStatus.DELETED;
    case "R": return contract.GitFileStatus.RENAMED;
    case "C": return contract.GitFileStatus.COPIED;
    case "?": return contract.GitFileStatus.UNTRACKED;
    case "!": return contract.GitFileStatus.IGNORED;
    case "U": return contract.GitFileStatus.CONFLICTED;
    case " ": return contract.GitFileStatus.UNMODIFIED;
    default: return contract.GitFileStatus.UNSPECIFIED;
  }
}

function nativeWorkspaceReviewSource(source: contract.GitDiffSource): WorkspaceGitReviewSource | undefined {
  if (source === contract.GitDiffSource.UNSTAGED) return "unstaged";
  if (source === contract.GitDiffSource.STAGED) return "staged";
  if (source === contract.GitDiffSource.COMMIT) return "commit";
  if (source === contract.GitDiffSource.BRANCH) return "branch";
  return undefined;
}

function nativeMutableWorkspaceDiffSource(source: contract.GitDiffSource): "staged" | "unstaged" {
  if (source === contract.GitDiffSource.STAGED) return "staged";
  if (source === contract.GitDiffSource.UNSTAGED) return "unstaged";
  throw invalidArgument("Review mutations require an explicit staged or unstaged source.");
}

function nativeWorkspaceDiffTarget(target: contract.WorkspaceDiffTarget): "file" | "hunk" {
  if (target === contract.WorkspaceDiffTarget.FILE) return "file";
  if (target === contract.WorkspaceDiffTarget.HUNK) return "hunk";
  throw invalidArgument("A concrete Review mutation target is required.");
}

function nativeWorkspaceDiffAction(action: contract.WorkspaceDiffAction): "stage" | "unstage" | "revert" {
  if (action === contract.WorkspaceDiffAction.STAGE) return "stage";
  if (action === contract.WorkspaceDiffAction.UNSTAGE) return "unstage";
  if (action === contract.WorkspaceDiffAction.REVERT) return "revert";
  throw invalidArgument("A concrete workspace diff action is required.");
}

function workspaceGitConnectError(error: unknown): ConnectError {
  if (error instanceof ConnectError) return error;
  if (error instanceof WorkspaceGitReviewError) {
    const code = error.kind === "invalid"
      ? Code.InvalidArgument
      : error.kind === "stale" || error.kind === "lease_expired"
        ? Code.Aborted
        : error.kind === "unsupported" ? Code.FailedPrecondition : Code.Internal;
    return new ConnectError(error.message, code);
  }
  return new ConnectError("Workspace Git operation failed.", Code.Internal);
}

function workspaceTextFileConnectError(error: unknown): ConnectError {
  if (error instanceof ConnectError) return error;
  if (error instanceof WorkspaceTextFileWriteError) {
    const code = error.kind === "invalid"
      ? Code.InvalidArgument
      : error.kind === "stale"
        ? Code.Aborted
        : error.kind === "unsupported"
          ? Code.FailedPrecondition
          : error.kind === "too_large"
            ? Code.ResourceExhausted
            : Code.Internal;
    return new ConnectError(error.message, code);
  }
  return new ConnectError("Workspace text file could not be saved.", Code.Internal);
}

function workspaceEntryMutationConnectError(error: WorkspaceEntryMutationError): ConnectError {
  const code = error.kind === "invalid"
    ? Code.InvalidArgument
    : error.kind === "stale"
      ? Code.Aborted
      : error.kind === "not_found"
        ? Code.NotFound
        : error.kind === "conflict"
          ? Code.AlreadyExists
          : error.kind === "too_large"
            ? Code.ResourceExhausted
            : error.kind === "unsupported" || error.kind === "unsafe"
              ? Code.FailedPrecondition
              : Code.Internal;
  return new ConnectError(error.message, code);
}

function parseWorkspaceDiff(
  workspaceId: string,
  raw: string,
  source = contract.GitDiffSource.UNSPECIFIED
): contract.WorkspaceDiff {
  const files: contract.FileDiff[] = [];
  let current: contract.FileDiff | undefined;
  let currentHunk: contract.DiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;
  for (const line of raw.split(/\r?\n/u)) {
    if (line.startsWith("diff --git ")) {
      if (current !== undefined) files.push(current);
      const paths = parseGitDiffHeader(line);
      current = create(contract.FileDiffSchema, {
        relativePath: paths?.path ?? "",
        oldRelativePath: paths?.oldPath ?? "",
        status: contract.GitFileStatus.MODIFIED,
        binary: false,
        hunks: [],
        source
      });
      currentHunk = undefined;
      continue;
    }
    if (current === undefined) continue;
    if (line.startsWith("new file mode")) current.status = contract.GitFileStatus.ADDED;
    else if (line.startsWith("deleted file mode")) current.status = contract.GitFileStatus.DELETED;
    else if (line.startsWith("rename from ")) {
      current.status = contract.GitFileStatus.RENAMED;
      current.oldRelativePath = decodeGitPathToken(line.slice("rename from ".length));
    } else if (line.startsWith("rename to ")) current.relativePath = decodeGitPathToken(line.slice("rename to ".length));
    else if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) current.binary = true;
    else if (line.startsWith("@@")) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@\s?(.*)$/u.exec(line);
      if (match === null) continue;
      oldLine = Number(match[1]);
      newLine = Number(match[3]);
      currentHunk = create(contract.DiffHunkSchema, {
        oldStart: oldLine,
        oldCount: Number(match[2] ?? "1"),
        newStart: newLine,
        newCount: Number(match[4] ?? "1"),
        heading: match[5] ?? "",
        lines: []
      });
      if (currentHunk !== undefined) current.hunks.push(currentHunk);
    } else if (currentHunk !== undefined && (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ") || line === "\\ No newline at end of file")) {
      const kind = line.startsWith("+")
        ? contract.DiffLineKind.ADDED
        : line.startsWith("-")
          ? contract.DiffLineKind.REMOVED
          : line.startsWith("\\") ? contract.DiffLineKind.NO_NEWLINE : contract.DiffLineKind.CONTEXT;
      currentHunk.lines.push(create(contract.DiffLineSchema, {
        kind,
        oldLine: kind === contract.DiffLineKind.ADDED ? 0 : oldLine,
        newLine: kind === contract.DiffLineKind.REMOVED ? 0 : newLine,
        text: line.startsWith("\\") ? line : line.slice(1)
      }));
      if (kind !== contract.DiffLineKind.ADDED && kind !== contract.DiffLineKind.NO_NEWLINE) oldLine += 1;
      if (kind !== contract.DiffLineKind.REMOVED && kind !== contract.DiffLineKind.NO_NEWLINE) newLine += 1;
    }
  }
  if (current !== undefined) files.push(current);
  return create(contract.WorkspaceDiffSchema, { workspaceId, files, truncated: false });
}

function parseGitDiffHeader(line: string): { readonly oldPath: string; readonly path: string } | undefined {
  if (!line.startsWith("diff --git ")) return undefined;
  const tokens = tokenizeGitHeader(line.slice("diff --git ".length));
  if (tokens.length !== 2 || !tokens[0]!.startsWith("a/") || !tokens[1]!.startsWith("b/")) return undefined;
  return { oldPath: tokens[0]!.slice(2), path: tokens[1]!.slice(2) };
}

function tokenizeGitHeader(value: string): string[] {
  const tokens: string[] = [];
  let offset = 0;
  while (offset < value.length) {
    while (value[offset] === " ") offset += 1;
    if (offset >= value.length) break;
    if (value[offset] !== '"') {
      const end = value.indexOf(" ", offset);
      tokens.push(value.slice(offset, end < 0 ? value.length : end));
      offset = end < 0 ? value.length : end + 1;
      continue;
    }
    const start = offset;
    offset += 1;
    let escaped = false;
    while (offset < value.length) {
      const character = value[offset]!;
      offset += 1;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        break;
      }
    }
    tokens.push(decodeGitPathToken(value.slice(start, offset)));
  }
  return tokens;
}

function decodeGitPathToken(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"')) return value;
  const bytes: number[] = [];
  const content = value.slice(1, -1);
  for (let offset = 0; offset < content.length; offset += 1) {
    const character = content[offset]!;
    if (character !== "\\") {
      bytes.push(...Buffer.from(character, "utf8"));
      continue;
    }
    const escaped = content[++offset];
    if (escaped === undefined) return "";
    const octal = /^[0-7]$/u.test(escaped)
      ? /^([0-7]{1,3})/u.exec(content.slice(offset))?.[1]
      : undefined;
    if (octal !== undefined) {
      bytes.push(Number.parseInt(octal, 8));
      offset += octal.length - 1;
      continue;
    }
    const mapped = escaped === "n" ? 0x0a
      : escaped === "r" ? 0x0d
        : escaped === "t" ? 0x09
          : escaped === "b" ? 0x08
            : escaped === "f" ? 0x0c
              : escaped === "v" ? 0x0b
                : escaped.charCodeAt(0);
    bytes.push(mapped);
  }
  return Buffer.from(bytes).toString("utf8");
}

function directArtifactBlob(
  record: import("./artifact-store.js").ArtifactRecord,
  disposition = contract.BlobDisposition.ATTACHMENT
): contract.BlobRef {
  return create(contract.BlobRefSchema, {
    blobId: record.id,
    fileName: record.fileName ?? "",
    mediaType: record.mimeType,
    byteSize: BigInt(record.byteLength),
    sha256Hex: record.sha256.replace(/^sha256:/u, ""),
    createdAt: toProtoTimestamp(record.createdAt),
    expiresAt: record.expiresAt === undefined ? undefined : toProtoTimestamp(record.expiresAt),
    disposition
  });
}

async function mapWorkspaceDiffImageSide(
  artifacts: ArtifactStore,
  side: WorkspaceGitImageSide,
  altText: string
): Promise<contract.WorkspaceDiffImageSide> {
  if (!side.present || side.tooLarge || side.bytes === undefined || side.mediaType === undefined) {
    return create(contract.WorkspaceDiffImageSideSchema, {
      present: side.present,
      tooLarge: side.tooLarge
    });
  }
  const record = await artifacts.ingestBytes(side.bytes, {
    fileName: basename(side.path ?? "review-image"),
    mimeType: side.mediaType,
    expiresAt: Date.now() + 5 * 60 * 1000
  });
  return create(contract.WorkspaceDiffImageSideSchema, {
    present: true,
    tooLarge: false,
    image: create(contract.ImageRefSchema, {
      blob: directArtifactBlob(record, contract.BlobDisposition.INLINE),
      widthPixels: 0,
      heightPixels: 0,
      altText
    })
  });
}

function provisioningError(phase: string, message: string): contract.ErrorInfo {
  return mapErrorToProto({
    code: "PROVISIONING_ERROR",
    message,
    phase,
    retryable: false,
    stateMayHaveChanged: false,
    recovery: "Review the typed configuration and retry the operation."
  });
}

function mapCredentialDescriptor(item: NativeCredentialDescriptor): contract.CredentialDescriptor {
  return create(contract.CredentialDescriptorSchema, {
    credentialReferenceId: item.credentialReferenceId,
    displayName: item.displayName,
    kind: protoCredentialKind(item.kind),
    providerId: item.providerId ?? "",
    configured: item.configured,
    expiresAt: item.expiresAt === undefined ? undefined : toProtoTimestamp(item.expiresAt),
    lastRefreshedAt: item.lastRefreshedAt === undefined ? undefined : toProtoTimestamp(item.lastRefreshedAt),
    error: item.error === undefined ? undefined : provisioningError("credential", item.error)
  });
}

function nativeCredentialKind(value: contract.CredentialKind, optional: true): NativeCredentialKind | undefined;
function nativeCredentialKind(value: contract.CredentialKind, optional: false): NativeCredentialKind;
function nativeCredentialKind(value: contract.CredentialKind, optional: boolean): NativeCredentialKind | undefined {
  switch (value) {
    case contract.CredentialKind.API_KEY: return "api_key";
    case contract.CredentialKind.OAUTH: return "oauth";
    case contract.CredentialKind.SUBSCRIPTION: return "subscription";
    case contract.CredentialKind.LOCAL_KEYLESS: return "local_keyless";
    case contract.CredentialKind.HEADER_SECRET: return "header_secret";
    case contract.CredentialKind.SSH_PRIVATE_KEY: return "ssh_private_key";
    case contract.CredentialKind.UNSPECIFIED:
      if (optional) return undefined;
      throw invalidArgument("credential.kind is required");
  }
}

function protoCredentialKind(value: NativeCredentialKind): contract.CredentialKind {
  switch (value) {
    case "api_key": return contract.CredentialKind.API_KEY;
    case "oauth": return contract.CredentialKind.OAUTH;
    case "subscription": return contract.CredentialKind.SUBSCRIPTION;
    case "local_keyless": return contract.CredentialKind.LOCAL_KEYLESS;
    case "header_secret": return contract.CredentialKind.HEADER_SECRET;
    case "ssh_private_key": return contract.CredentialKind.SSH_PRIVATE_KEY;
  }
}

function backendAuthenticationAvailable(state: BackendDescriptor["authenticationState"]): boolean {
  return state === "authenticated" || state === "not_required";
}

interface BackendProviderAccountSnapshot {
  readonly authenticated: boolean;
  readonly authenticationState: BackendDescriptor["authenticationState"];
}

type BackendProviderLoginInput =
  | { readonly method: "api_key"; readonly apiKey: string }
  | { readonly method: "oauth_browser" }
  | { readonly method: "device_code" };

type BackendProviderLoginResult =
  | { readonly method: "api_key" }
  | { readonly method: "oauth_browser"; readonly loginId: string; readonly url: string }
  | { readonly method: "device_code"; readonly loginId: string; readonly url: string; readonly userCode: string };

/** Capability-detected native account port. Shared services never branch on an Adapter kind or ID. */
interface BackendProviderAccountOperations {
  readAccount?(refreshToken?: boolean): Promise<BackendProviderAccountSnapshot>;
  readLoginOutcome?(loginId: string): Promise<{
    readonly outcome: "pending" | "completed" | "cancelled" | "error";
    readonly failureReason?: "not_a_subscription";
  }>;
  readAccountUsage?(
    providerId: string,
    signal?: AbortSignal
  ): Promise<NativeProviderAccountUsageSnapshot>;
  listModels?(): Promise<readonly ProviderModel[]>;
  beginLogin?(input: BackendProviderLoginInput): Promise<BackendProviderLoginResult>;
  cancelLogin?(loginId: string): Promise<void>;
  logout?(): Promise<void>;
}

type BackendProviderLoginState = "pending" | "completed" | "cancelled" | "timed_out" | "outcome_unknown" | "error";

interface BackendProviderLoginFlow extends NativeProviderLoginFlow {
  readonly backendId: string;
  readonly state: BackendProviderLoginState;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly nativeLoginId?: string;
  readonly credentialAcceptedAt?: number;
  readonly pendingPrompt?: PiProviderAuthPromptRecord;
  readonly error?: string;
}

function backendProviderOperations(descriptor: BackendDescriptor): {
  readonly login: boolean;
  readonly logout: boolean;
  readonly refresh: boolean;
  readonly modelRefresh: boolean;
  readonly loginMethods: readonly string[];
} {
  const login = descriptor.capabilities.get("provider.login");
  return {
    login: login?.supported === true,
    logout: descriptor.capabilities.get("provider.logout")?.supported === true,
    refresh: descriptor.capabilities.get("provider.refresh")?.supported === true,
    modelRefresh: descriptor.capabilities.get("provider.model_refresh")?.supported === true,
    loginMethods: login?.options ?? []
  };
}

function reserveAllProviderCredentialSurfaces(dependencies: ConnectServiceDependencies): void {
  if (dependencies.credentials === undefined) return;
  for (const record of dependencies.store.listBackends()) {
    const providers = Array.isArray(record.descriptor.providers) ? record.descriptor.providers as readonly unknown[] : [];
    for (const candidate of providers) {
      const provider = asRecord(candidate);
      const providerId = stringValue(provider["providerId"]);
      const surfaces = Array.isArray(provider["credentialSurfaces"])
        ? provider["credentialSurfaces"] as readonly unknown[]
        : [];
      if (providerId === undefined) continue;
      for (const candidateSurface of surfaces) {
        const surfaceId = stringValue(asRecord(candidateSurface)["surfaceId"]);
        if (surfaceId === undefined) continue;
        try {
          resolveDeclaredProviderCredentialSurface(
            dependencies.store,
            dependencies.credentials,
            { backendId: record.descriptor.id, providerId, surfaceId }
          );
        } catch {
          // Malformed or duplicate persisted declarations remain unreserved.
        }
      }
    }
  }
}

function resolveProviderCredentialSurface(
  dependencies: ConnectServiceDependencies,
  backendId: string,
  providerId: string,
  surfaceId: string
): ResolvedProviderCredentialSurface {
  let resolved: ResolvedProviderCredentialSurface | undefined;
  try {
    resolved = resolveDeclaredProviderCredentialSurface(
      dependencies.store,
      dependencies.credentials,
      { backendId, providerId, surfaceId }
    );
  } catch {
    throw new ConnectError("Provider credential surface is duplicated.", Code.FailedPrecondition);
  }
  if (resolved === undefined) throw new NotFoundError("Provider credential surface", surfaceId);
  return resolved;
}

function configureProviderCredentialSurfaces(
  dependencies: ConnectServiceDependencies,
  backend: BackendDescriptor,
  provider: contract.ProviderDescriptor
): contract.ProviderDescriptor {
  if (provider.credentialSurfaces.length === 0) return provider;
  return create(contract.ProviderDescriptorSchema, {
    ...provider,
    credentialSurfaces: provider.credentialSurfaces.map((surface) => {
      let resolved: ResolvedProviderCredentialSurface | undefined;
      try {
        resolved = resolveDeclaredProviderCredentialSurface(
          dependencies.store,
          dependencies.credentials,
          { backendId: backend.id, providerId: provider.providerId, surfaceId: surface.surfaceId }
        );
      } catch {
        return surface;
      }
      if (resolved === undefined) return surface;
      const credential = dependencies.credentials?.find(resolved.credentialReferenceId);
      return create(contract.ProviderCredentialSurfaceSchema, {
        ...surface,
        configured: credential?.configured === true
          && credential.kind === resolved.surface.kind
          && credential.providerId === resolved.provider.providerId
      });
    })
  });
}

function backendInstallationAvailable(state: BackendDescriptor["installationState"]): boolean {
  return state === "installed" || state === "update_available";
}

function managedProviderCatalogApplies(
  dependencies: ConnectServiceDependencies,
  backendId: string
): dependencies is ConnectServiceDependencies & { readonly providers: ProviderCatalogManager } {
  if (dependencies.providers === undefined) return false;
  if (backendId === "") return true;
  return dependencies.store.getBackend(backendId).descriptor.capabilities
    .get(MANAGED_PROVIDER_CATALOG_CAPABILITY)?.supported === true;
}

function backendCatalogModels(
  dependencies: ConnectServiceDependencies,
  backend: BackendDescriptor
): readonly ProviderModel[] {
  if (
    dependencies.providers === undefined
    || backend.capabilities.get(MANAGED_PROVIDER_CATALOG_CAPABILITY)?.supported !== true
  ) return backend.models;
  const models = new Map<string, ProviderModel>(backend.models.map((model) => [
    `${model.providerId}\u0000${model.modelId}`,
    model
  ]));
  for (const provider of dependencies.providers.list()) {
    for (const model of provider.provider.models ?? []) {
      const projected = piProviderModel(provider.provider, model);
      models.set(`${projected.providerId}\u0000${projected.modelId}`, projected);
    }
  }
  for (const model of dependencies.providerAuth?.listNativeModels() ?? []) {
    models.set(`${model.providerId}\u0000${model.modelId}`, model);
  }
  return [...models.values()];
}

function managedProviderBackendIds(dependencies: ConnectServiceDependencies): readonly string[] {
  if (dependencies.providers === undefined) return [];
  return dependencies.store.listBackends()
    .filter((record) => record.descriptor.capabilities.get(MANAGED_PROVIDER_CATALOG_CAPABILITY)?.supported === true)
    .map((record) => record.descriptor.id);
}

function clearManagedProviderRateLimit(
  dependencies: ConnectServiceDependencies,
  providerId: string
): void {
  for (const backendId of managedProviderBackendIds(dependencies)) {
    clearProviderRateLimit(dependencies.store, backendId, providerId);
  }
}

function mapProviderDescriptor(
  backendId: string,
  item: NativeProviderDescriptor,
  usage?: contract.ProviderUsageSummary,
  rateLimit?: contract.RateLimitState,
  accountUsage?: contract.ProviderAccountUsageSnapshot
): contract.ProviderDescriptor {
  const capabilities = [...(item.capabilities ?? [])]
    .sort((left, right) => left.localeCompare(right, "en"))
    .map((name) => create(contract.CapabilitySchema, {
      name,
      support: contract.CapabilitySupport.SUPPORTED,
      reason: ""
    }));
  return create(contract.ProviderDescriptorSchema, {
    backendId,
    providerId: item.provider.id,
    displayName: item.displayName,
    kind: protoProviderKind(item.kind),
    apiCompatibility: protoProviderApi(item.provider.api),
    authenticationState: mapAuthenticationState(item.authenticationState),
    endpointDisplay: item.provider.baseUrl ?? "",
    ownerManaged: true,
    supportsLogin: item.supportsLogin,
    supportsLogout: item.supportsLogout,
    supportsRefresh: item.supportsRefresh,
    loginMethods: item.supportsLogin
      ? (item.loginMethods ?? nativeProviderLoginMethodsForKind(item.kind)).map(protoManagedProviderLoginMethod)
      : [],
    supportsModelRefresh: item.supportsModelRefresh === true,
    credentialSurfaces: [],
    credentialExpiresAt: item.credentialExpiresAt === undefined ? undefined : toProtoTimestamp(item.credentialExpiresAt),
    rateLimit,
    usage,
    accountUsage,
    capabilities: create(contract.CapabilityManifestSchema, {
      schemaVersion: "joko.provider.v1",
      capabilities,
      revision: toProtoRevision(item.version)
    }),
    version: toProtoEntityVersion(item.version, 0, item.updatedAt),
    error: item.error === undefined ? undefined : provisioningError("provider", item.error)
  });
}

function providerUsageSummary(
  dependencies: ConnectServiceDependencies,
  providerId: string,
  backendId?: string
): contract.ProviderUsageSummary {
  const rows = dependencies.store.listUsageLedger({
    ownerId: usageOwnerId(dependencies),
    providerId,
    ...(backendId === undefined ? {} : { backendId })
  });
  const aggregate = aggregateUsageRows(rows);
  const models = groupUsageRows(rows, (row) => row.modelId)
    .map(([modelId, modelRows]) => create(contract.ModelUsageSummarySchema, {
      model: create(contract.ModelKeySchema, { providerId, modelId }),
      usage: aggregateUsageMessage(aggregateUsageRows(modelRows)),
      periodStartedAt: modelRows.length === 0 ? undefined : toProtoTimestamp(Math.min(...modelRows.map((row) => row.firstMeasuredAt))),
      periodEndedAt: modelRows.length === 0 ? undefined : toProtoTimestamp(Math.max(...modelRows.map((row) => row.lastMeasuredAt)))
    }));
  const at = aggregate.measuredAt ?? (dependencies.now ?? Date.now)();
  return create(contract.ProviderUsageSummarySchema, {
    providerId,
    usage: aggregateUsageMessage(aggregate),
    models,
    currencyTotals: aggregateCurrencyTotals(rows),
    periodStartedAt: aggregate.periodStartedAt === undefined ? undefined : toProtoTimestamp(aggregate.periodStartedAt),
    periodEndedAt: toProtoTimestamp(at),
    measuredAt: toProtoTimestamp(at),
    estimated: aggregate.estimated
  });
}

async function providerAccountUsageSnapshot(
  dependencies: ConnectServiceDependencies,
  provider: NativeProviderDescriptor,
  signal?: AbortSignal
): Promise<contract.ProviderAccountUsageSnapshot | undefined> {
  if (dependencies.providerAccountUsage === undefined
      || provider.capabilities?.has(PROVIDER_ACCOUNT_USAGE_CAPABILITY) !== true) return undefined;
  const snapshot = await dependencies.providerAccountUsage.get(provider.provider.id, signal);
  return snapshot === undefined ? undefined : mapProviderAccountUsageSnapshot(snapshot);
}

function peekProviderAccountUsageSnapshot(
  dependencies: ConnectServiceDependencies,
  provider: NativeProviderDescriptor
): contract.ProviderAccountUsageSnapshot | undefined {
  if (dependencies.providerAccountUsage === undefined
      || provider.capabilities?.has(PROVIDER_ACCOUNT_USAGE_CAPABILITY) !== true) return undefined;
  const snapshot = dependencies.providerAccountUsage.peek(provider.provider.id);
  void dependencies.providerAccountUsage.get(provider.provider.id).catch(() => undefined);
  return snapshot === undefined ? undefined : mapProviderAccountUsageSnapshot(snapshot);
}

function backendProviderAccountUsageAvailable(
  dependencies: ConnectServiceDependencies,
  descriptor: BackendDescriptor,
  providerId: string
): boolean {
  if (descriptor.capabilities?.get(PROVIDER_ACCOUNT_USAGE_CAPABILITY)?.supported !== true) return false;
  const ownsProvider = descriptor.providers?.some((provider) => provider.providerId === providerId) === true
    || descriptor.models.some((model) => model.providerId === providerId);
  if (!ownsProvider) return false;
  const adapter = dependencies.adapters().find((candidate) => candidate.id === descriptor.id);
  return typeof (adapter as (BackendAdapter & BackendProviderAccountOperations) | undefined)?.readAccountUsage === "function";
}

async function backendProviderAccountUsageSnapshot(
  dependencies: ConnectServiceDependencies,
  descriptor: BackendDescriptor,
  providerId: string,
  signal?: AbortSignal
): Promise<contract.ProviderAccountUsageSnapshot | undefined> {
  if (!backendProviderAccountUsageAvailable(dependencies, descriptor, providerId)) return undefined;
  try {
    return await dependencies.sessionHost.invokeBackendAdapter(descriptor.id, async (adapter) => {
      const { operations } = backendProviderAccountOperations(
        dependencies,
        descriptor.id,
        providerId,
        "provider.account_usage",
        adapter
      );
      const snapshot = await operations.readAccountUsage!(providerId, signal);
      if (signal?.aborted === true) {
        throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
      }
      if (snapshot === null || typeof snapshot !== "object" || snapshot.providerId !== providerId) return undefined;
      return mapProviderAccountUsageSnapshot(snapshot);
    });
  } catch (error) {
    if (signal?.aborted === true) throw signal.reason ?? error;
    return undefined;
  }
}

async function backendProviderDescriptorWithAccountUsage(
  dependencies: ConnectServiceDependencies,
  descriptor: BackendDescriptor,
  providerId: string,
  revision: bigint,
  provider: contract.ProviderDescriptor,
  signal?: AbortSignal
): Promise<contract.ProviderDescriptor> {
  provider = configureProviderCredentialSurfaces(dependencies, descriptor, provider);
  if (!backendProviderAccountUsageAvailable(dependencies, descriptor, providerId)) return provider;
  const accountUsage = await backendProviderAccountUsageSnapshot(dependencies, descriptor, providerId, signal);
  const capabilities = [
    ...(provider.capabilities?.capabilities ?? []).filter((capability) =>
      capability.name !== PROVIDER_ACCOUNT_USAGE_CAPABILITY),
    create(contract.CapabilitySchema, {
      name: PROVIDER_ACCOUNT_USAGE_CAPABILITY,
      support: contract.CapabilitySupport.SUPPORTED,
      reason: ""
    })
  ];
  return create(contract.ProviderDescriptorSchema, {
    ...provider,
    accountUsage,
    capabilities: create(contract.CapabilityManifestSchema, {
      schemaVersion: provider.capabilities?.schemaVersion || "joko.provider.v1",
      capabilities,
      revision: provider.capabilities?.revision ?? toProtoRevision(revision)
    })
  });
}

function mapProviderAccountUsageSnapshot(
  snapshot: NativeProviderAccountUsageSnapshot
): contract.ProviderAccountUsageSnapshot {
  const mapWindow = (window: NativeProviderAccountUsageSnapshot["primaryWindow"]): contract.ProviderAccountUsageWindow | undefined =>
    window === undefined ? undefined : create(contract.ProviderAccountUsageWindowSchema, {
      usedPercent: window.usedPercent,
      windowMinutes: window.windowMinutes,
      resetAt: window.resetAt === undefined ? undefined : toProtoTimestamp(window.resetAt)
    });
  return create(contract.ProviderAccountUsageSnapshotSchema, {
    providerId: snapshot.providerId,
    primaryWindow: mapWindow(snapshot.primaryWindow),
    secondaryWindow: mapWindow(snapshot.secondaryWindow),
    limitReached: snapshot.limitReached,
    planType: snapshot.planType,
    credits: snapshot.credits === undefined ? undefined : create(contract.ProviderAccountCreditsSnapshotSchema, {
      hasCredits: snapshot.credits.hasCredits,
      unlimited: snapshot.credits.unlimited,
      balance: snapshot.credits.balance,
      observedAt: toProtoTimestamp(snapshot.credits.observedAt)
    }),
    observedAt: toProtoTimestamp(snapshot.observedAt)
  });
}

type UsageLedgerRow = ReturnType<OperationalStore["listUsageLedger"]>[number];

interface AggregatedUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly totalTokens: number;
  readonly costMicros: number;
  readonly currencyCode: string;
  readonly costComplete: boolean;
  readonly estimated: boolean;
  readonly periodStartedAt?: number;
  readonly periodEndedAt?: number;
  readonly measuredAt?: number;
}

function usageOwnerId(dependencies: ConnectServiceDependencies): string {
  return dependencies.server?.id?.trim() || "orchestrator";
}

function assertUsageProvider(dependencies: ConnectServiceDependencies, providerId: string, backendId?: string): void {
  if (providerId.trim() === "" || providerId.length > 512) throw invalidArgument("Provider ID is invalid.");
  const backends = backendId === undefined
    ? dependencies.store.listBackends()
    : [dependencies.store.getBackend(backendId)];
  if (!backends.some((backend) => backendOwnsUsageProvider(dependencies, backend.descriptor, providerId))) {
    throw new NotFoundError("Provider", providerId);
  }
}

function backendOwnsUsageProvider(
  dependencies: ConnectServiceDependencies,
  backend: BackendDescriptor,
  providerId: string
): boolean {
  if (backend.providers?.some((provider) => provider.providerId === providerId) === true
    || backend.models.some((model) => model.providerId === providerId)) return true;
  return managedProviderCatalogApplies(dependencies, backend.id)
    && dependencies.providers.list().some((provider) => provider.provider.id === providerId);
}

function usageHistory(
  dependencies: ConnectServiceDependencies,
  days: number,
  backendId?: string,
  providerId?: string
): contract.UsageHistory {
  const generatedAt = (dependencies.now ?? Date.now)();
  const dayKeys = usageDayKeys(generatedAt, days);
  const rows = dependencies.store.listUsageLedger({
    ownerId: usageOwnerId(dependencies),
    fromDay: dayKeys[0],
    throughDay: dayKeys.at(-1),
    ...(backendId === undefined ? {} : { backendId }),
    ...(providerId === undefined ? {} : { providerId })
  });
  const byDay = new Map(groupUsageRows(rows, (row) => row.day));
  const daysProto = dayKeys.map((day) => usageHistoryDay(day, byDay.get(day) ?? []));
  const lastThirtyDays = new Set(dayKeys.slice(-30));
  const lastThirtyRows = rows.filter((row) => lastThirtyDays.has(row.day));
  const modelDaily = groupUsageRows(
    lastThirtyRows,
    (row) => `${row.day}\u0000${row.backendId}\u0000${row.providerId}\u0000${row.modelId}`
  )
    .map(([, modelRows]) => {
      const row = modelRows[0]!;
      const aggregate = aggregateUsageRows(modelRows);
      return create(contract.ModelUsageHistoryDaySchema, {
        day: row.day,
        backendId: row.backendId,
        model: create(contract.ModelKeySchema, { providerId: row.providerId, modelId: row.modelId }),
        usage: aggregateUsageMessage(aggregate),
        currencyTotals: aggregateCurrencyTotals(modelRows),
        costComplete: aggregate.costComplete,
        estimated: aggregate.estimated
      });
    });
  const models = groupUsageRows(
    lastThirtyRows,
    (row) => `${row.backendId}\u0000${row.providerId}\u0000${row.modelId}`
  )
    .map(([, modelRows]) => {
      const row = modelRows[0]!;
      const aggregate = aggregateUsageRows(modelRows);
      return create(contract.ModelUsageHistorySummarySchema, {
        backendId: row.backendId,
        model: create(contract.ModelKeySchema, { providerId: row.providerId, modelId: row.modelId }),
        usage: aggregateUsageMessage(aggregate),
        currencyTotals: aggregateCurrencyTotals(modelRows),
        costComplete: aggregate.costComplete,
        estimated: aggregate.estimated
      });
    })
    .sort((left, right) => Number((right.usage?.totalTokens ?? 0n) - (left.usage?.totalTokens ?? 0n)));
  const todayRows = byDay.get(dayKeys.at(-1)!) ?? [];
  const activeDays = daysProto.map((day) => (day.usage?.totalTokens ?? 0n) > 0n);
  const todayAnomalous = usageTodayAnomalous(todayRows, rows, dayKeys.at(-1)!);
  const measuredAt = rows.length === 0 ? generatedAt : Math.max(...rows.map((row) => row.lastMeasuredAt));
  return create(contract.UsageHistorySchema, {
    days: daysProto,
    modelDaily,
    models,
    today: usageHistorySummary(todayRows),
    last30Days: usageHistorySummary(lastThirtyRows),
    currentStreakDays: currentUsageStreak(activeDays),
    longestStreakDays: longestUsageStreak(activeDays),
    todayAnomalous,
    generatedAt: toProtoTimestamp(generatedAt),
    measuredAt: toProtoTimestamp(measuredAt),
    estimated: rows.some((row) => row.estimated)
  });
}

function usageHistoryDay(day: string, rows: readonly UsageLedgerRow[]): contract.UsageHistoryDay {
  const aggregate = aggregateUsageRows(rows);
  return create(contract.UsageHistoryDaySchema, {
    day,
    usage: aggregateUsageMessage(aggregate),
    currencyTotals: aggregateCurrencyTotals(rows),
    costComplete: aggregate.costComplete,
    estimated: aggregate.estimated,
    measuredAt: aggregate.measuredAt === undefined ? undefined : toProtoTimestamp(aggregate.measuredAt)
  });
}

function usageHistorySummary(rows: readonly UsageLedgerRow[]): contract.UsageHistorySummary {
  const aggregate = aggregateUsageRows(rows);
  return create(contract.UsageHistorySummarySchema, {
    usage: aggregateUsageMessage(aggregate),
    currencyTotals: aggregateCurrencyTotals(rows),
    costComplete: aggregate.costComplete,
    estimated: aggregate.estimated
  });
}

function aggregateUsageRows(rows: readonly UsageLedgerRow[]): AggregatedUsage {
  const currencies = new Set(rows.map((row) => row.currencyCode));
  const onlyCurrency = currencies.size === 1 ? rows[0]?.currencyCode ?? "" : "";
  const add = (select: (row: UsageLedgerRow) => number): number => {
    let value = 0;
    for (const row of rows) {
      value += select(row);
      if (!Number.isSafeInteger(value) || value < 0) throw new StoreError("Usage history exceeds the safe integer range.");
    }
    return value;
  };
  return {
    inputTokens: add((row) => row.inputTokens),
    outputTokens: add((row) => row.outputTokens),
    cacheReadTokens: add((row) => row.cacheReadTokens),
    cacheWriteTokens: add((row) => row.cacheWriteTokens),
    totalTokens: add((row) => row.totalTokens),
    costMicros: currencies.size === 1 ? add((row) => row.costMicros) : 0,
    currencyCode: onlyCurrency,
    costComplete: rows.length > 0 && currencies.size === 1 && rows.every((row) => row.costComplete),
    estimated: rows.some((row) => row.estimated),
    ...(rows.length === 0 ? {} : {
      periodStartedAt: Math.min(...rows.map((row) => row.firstMeasuredAt)),
      periodEndedAt: Math.max(...rows.map((row) => row.lastMeasuredAt)),
      measuredAt: Math.max(...rows.map((row) => row.lastMeasuredAt))
    })
  };
}

function aggregateUsageMessage(value: AggregatedUsage): contract.Usage {
  return create(contract.UsageSchema, {
    inputTokens: BigInt(value.inputTokens),
    outputTokens: BigInt(value.outputTokens),
    cacheReadTokens: BigInt(value.cacheReadTokens),
    cacheWriteTokens: BigInt(value.cacheWriteTokens),
    totalTokens: BigInt(value.totalTokens),
    costMicros: BigInt(value.costMicros),
    currencyCode: value.currencyCode
  });
}

function aggregateCurrencyTotals(rows: readonly UsageLedgerRow[]): contract.UsageCurrencyTotal[] {
  return groupUsageRows(rows, (row) => row.currencyCode).map(([currencyCode, currencyRows]) => {
    const aggregate = aggregateUsageRows(currencyRows);
    return create(contract.UsageCurrencyTotalSchema, {
      currencyCode,
      usage: aggregateUsageMessage(aggregate),
      costComplete: currencyRows.every((row) => row.costComplete),
      estimated: currencyRows.some((row) => row.estimated)
    });
  });
}

function groupUsageRows(
  rows: readonly UsageLedgerRow[],
  key: (row: UsageLedgerRow) => string
): Array<[string, UsageLedgerRow[]]> {
  const groups = new Map<string, UsageLedgerRow[]>();
  for (const row of rows) groups.set(key(row), [...(groups.get(key(row)) ?? []), row]);
  return [...groups.entries()];
}

function usageDayKeys(at: number, count: number): string[] {
  const today = new Date(at);
  const midnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Array.from({ length: count }, (_unused, index) =>
    new Date(midnight - (count - index - 1) * 86_400_000).toISOString().slice(0, 10)
  );
}

function currentUsageStreak(active: readonly boolean[]): number {
  let value = 0;
  let index = active.length - 1;
  // An unused current day does not end the streak: yesterday remains the
  // streak anchor until today records activity.
  if (index >= 0 && !active[index]) index -= 1;
  for (; index >= 0 && active[index]; index -= 1) value += 1;
  return value;
}

function longestUsageStreak(active: readonly boolean[]): number {
  let longest = 0;
  let current = 0;
  for (const day of active) {
    current = day ? current + 1 : 0;
    longest = Math.max(longest, current);
  }
  return longest;
}

function usageTodayAnomalous(
  todayRows: readonly UsageLedgerRow[],
  rows: readonly UsageLedgerRow[],
  today: string
): boolean {
  const priorDays = usageDayKeys(Date.parse(`${today}T00:00:00.000Z`) - 86_400_000, 7);
  for (const [currency, currencyToday] of groupUsageRows(todayRows, (row) => row.currencyCode)) {
    const todayCost = aggregateUsageRows(currencyToday).costMicros;
    if (todayCost < 1_000_000) continue;
    const daily = priorDays.map((day) => aggregateUsageRows(rows.filter((row) => row.day === day && row.currencyCode === currency)).costMicros);
    if (daily.filter((value) => value >= 10_000).length < 3) continue;
    const average = daily.reduce((sum, value) => sum + value, 0) / daily.length;
    if (todayCost > average * 2) return true;
  }
  return false;
}

interface ModelPriceReference {
  readonly backendId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly quote: {
    readonly currencyCode: "USD" | "CNY";
    readonly inputCostMicrosPerMillion: number;
    readonly outputCostMicrosPerMillion: number;
    readonly cacheReadCostMicrosPerMillion?: number;
    readonly cacheWriteCostMicrosPerMillion?: number;
  };
  readonly available: boolean;
  readonly registryUpdatedAt?: number;
  readonly revision: bigint;
  readonly updatedAt: number;
}

function modelPriceReference(
  dependencies: ConnectServiceDependencies,
  backendId: string,
  providerId: string,
  modelId: string
): ModelPriceReference {
  if (
    backendId.trim() === ""
    || providerId.trim() === ""
    || modelId.trim() === ""
    || backendId.length > 256
    || providerId.length > 512
    || modelId.length > 512
  ) {
    throw invalidArgument("Backend, Provider, and model IDs are required.");
  }
  const backend = dependencies.store.getBackend(backendId);
  const model = backend.descriptor.models.find((candidate) =>
    candidate.providerId === providerId && candidate.modelId === modelId
  );
  if (model === undefined) throw new NotFoundError("Model", `${backendId}/${providerId}/${modelId}`);
  const available = model.pricing !== undefined
    || model.cost.input > 0
    || model.cost.output > 0
    || model.cost.cacheRead > 0
    || model.cost.cacheWrite > 0;
  return {
    backendId,
    providerId,
    modelId,
    quote: {
      currencyCode: model.pricing?.currencyCode === "CNY" ? "CNY" : "USD",
      inputCostMicrosPerMillion: priceMicros(model.cost.input),
      outputCostMicrosPerMillion: priceMicros(model.cost.output),
      ...((model.pricing?.cacheReadAvailable ?? model.cost.cacheRead > 0) ? {
        cacheReadCostMicrosPerMillion: priceMicros(model.cost.cacheRead)
      } : {}),
      ...((model.pricing?.cacheWriteAvailable ?? model.cost.cacheWrite > 0) ? {
        cacheWriteCostMicrosPerMillion: priceMicros(model.cost.cacheWrite)
      } : {})
    },
    available,
    ...(model.pricing?.updatedAt === undefined ? {} : { registryUpdatedAt: model.pricing.updatedAt }),
    revision: backend.revision,
    updatedAt: backend.updatedAt
  };
}

function modelPriceOverrideView(
  dependencies: ConnectServiceDependencies,
  backendId: string,
  providerId: string,
  modelId: string
): contract.ModelPriceOverrideView {
  const reference = modelPriceReference(dependencies, backendId, providerId, modelId);
  const override = dependencies.store.findModelPriceOverride(
    usageOwnerId(dependencies),
    backendId,
    providerId,
    modelId
  );
  const updatedAt = override?.updatedAt ?? reference.updatedAt;
  return create(contract.ModelPriceOverrideViewSchema, {
    backendId,
    model: create(contract.ModelKeySchema, { providerId, modelId }),
    reference: protoModelPriceQuote(reference.quote),
    effective: protoModelPriceQuote(override ?? reference.quote),
    override: override === undefined ? undefined : protoModelPriceQuote(override),
    allowedCurrencies: [contract.ModelPriceCurrency.USD, contract.ModelPriceCurrency.CNY],
    referenceAvailable: reference.available,
    registryUpdatedAt: reference.registryUpdatedAt === undefined ? undefined : toProtoTimestamp(reference.registryUpdatedAt),
    updatedAt: toProtoTimestamp(updatedAt),
    version: toProtoEntityVersion(override?.revision ?? reference.revision, 0, updatedAt)
  });
}

function protoModelPriceQuote(value: {
  readonly currencyCode: "USD" | "CNY";
  readonly inputCostMicrosPerMillion: number;
  readonly outputCostMicrosPerMillion: number;
  readonly cacheReadCostMicrosPerMillion?: number;
  readonly cacheWriteCostMicrosPerMillion?: number;
}): contract.ModelPriceQuote {
  return create(contract.ModelPriceQuoteSchema, {
    currency: value.currencyCode === "CNY" ? contract.ModelPriceCurrency.CNY : contract.ModelPriceCurrency.USD,
    inputCostMicrosPerMillion: BigInt(value.inputCostMicrosPerMillion),
    outputCostMicrosPerMillion: BigInt(value.outputCostMicrosPerMillion),
    ...(value.cacheReadCostMicrosPerMillion === undefined ? {} : {
      cacheReadCostMicrosPerMillion: BigInt(value.cacheReadCostMicrosPerMillion)
    }),
    ...(value.cacheWriteCostMicrosPerMillion === undefined ? {} : {
      cacheWriteCostMicrosPerMillion: BigInt(value.cacheWriteCostMicrosPerMillion)
    })
  });
}

function modelPriceCurrencyCode(value: contract.ModelPriceCurrency): "USD" | "CNY" {
  if (value === contract.ModelPriceCurrency.USD) return "USD";
  if (value === contract.ModelPriceCurrency.CNY) return "CNY";
  throw invalidArgument("Model price currency must be USD or CNY.");
}

function sameModelPrice(
  left: ModelPriceReference["quote"],
  right: ModelPriceReference["quote"]
): boolean {
  return left.currencyCode === right.currencyCode
    && left.inputCostMicrosPerMillion === right.inputCostMicrosPerMillion
    && left.outputCostMicrosPerMillion === right.outputCostMicrosPerMillion
    && left.cacheReadCostMicrosPerMillion === right.cacheReadCostMicrosPerMillion
    && left.cacheWriteCostMicrosPerMillion === right.cacheWriteCostMicrosPerMillion;
}

function priceMicros(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value * 1_000_000 > Number.MAX_SAFE_INTEGER) {
    throw new StoreError("Model reference price is outside the supported range.");
  }
  return Math.round(value * 1_000_000);
}

export { providerRateLimitSettingKey } from "./provider-rate-limit.js";

function providerRateLimit(
  dependencies: ConnectServiceDependencies,
  backendId: string | undefined,
  providerId: string
): contract.RateLimitState | undefined {
  if (backendId === undefined || backendId === "") return undefined;
  const value = dependencies.store.findSetting<unknown>(
    "service",
    "orchestrator",
    providerRateLimitSettingKey(backendId, providerId)
  )?.value;
  const record = asRecord(value);
  const limited = booleanValue(record["limited"]);
  const resetCandidate = optionalNumberValue(record["resetsAt"]);
  const resetsAt = resetCandidate !== undefined && Number.isSafeInteger(resetCandidate) && resetCandidate >= 0
    ? resetCandidate
    : undefined;
  const requestLimit = safeUnsignedBigInt(record["requestLimit"]);
  const requestsRemaining = safeUnsignedBigInt(record["requestsRemaining"]);
  const tokenLimit = safeUnsignedBigInt(record["tokenLimit"]);
  const tokensRemaining = safeUnsignedBigInt(record["tokensRemaining"]);
  if (
    limited === undefined && resetsAt === undefined && requestLimit === undefined &&
    requestsRemaining === undefined && tokenLimit === undefined && tokensRemaining === undefined
  ) return undefined;
  if (limited === true && resetsAt !== undefined && resetsAt <= Date.now()) return undefined;
  return create(contract.RateLimitStateSchema, {
    limited: limited ?? false,
    resetsAt: resetsAt === undefined ? undefined : toProtoTimestamp(Math.trunc(resetsAt)),
    requestLimit: requestLimit ?? 0n,
    requestsRemaining: requestsRemaining ?? 0n,
    tokenLimit: tokenLimit ?? 0n,
    tokensRemaining: tokensRemaining ?? 0n
  });
}

function safeUnsignedBigInt(value: unknown): bigint | undefined {
  let parsed: bigint | undefined;
  if (typeof value === "bigint") parsed = value;
  else if (typeof value === "number" && Number.isSafeInteger(value)) parsed = BigInt(value);
  else if (typeof value === "string" && /^\d+$/u.test(value)) parsed = BigInt(value);
  return parsed !== undefined && parsed >= 0n && parsed <= 0xffff_ffff_ffff_ffffn ? parsed : undefined;
}

function mapProviderConfiguration(item: NativeProviderDescriptor): contract.ProviderConfiguration {
  const bindings = (item as NativeProviderDescriptor & {
    readonly credentialBindings?: Readonly<Record<string, string>>;
  }).credentialBindings ?? {};
  const provider = item.provider;
  return create(contract.ProviderConfigurationSchema, {
    providerId: provider.id,
    displayName: item.displayName,
    kind: protoProviderKind(item.kind),
    apiCompatibility: protoProviderApi(provider.api),
    endpoint: provider.baseUrl ?? "",
    credentialReferenceId: provider.apiKeyEnv === undefined ? "" : bindings[provider.apiKeyEnv] ?? "",
    enabled: item.enabled,
    version: toProtoEntityVersion(item.version, 0, item.updatedAt),
    apiKeyEnvironment: provider.apiKeyEnv ?? "",
    keyless: provider.keyless ?? false,
    authHeader: provider.authHeader ?? false,
    headers: Object.entries(provider.headers ?? {}).map(([headerName, value]) => create(contract.ProviderHeaderConfigurationSchema, {
      headerName,
      environmentName: value.env,
      credentialReferenceId: bindings[value.env] ?? ""
    })),
    models: provider.models.map(mapProviderModelConfiguration)
  });
}

function mapProviderModelConfiguration(item: PiManagedModel): contract.ProviderModelConfiguration {
  const sampling = asRecord(item.samplingParams);
  const compat = asRecord(item.compat);
  return create(contract.ProviderModelConfigurationSchema, {
    modelId: item.id,
    displayName: item.name ?? item.id,
    apiCompatibility: item.api === undefined ? undefined : protoProviderApi(item.api),
    reasoning: item.reasoning ?? false,
    supportsFastMode: item.supportsFastMode === true,
    defaultVisible: item.defaultVisible,
    inputModalities: (item.input ?? ["text"]).map((value) => value === "image" ? contract.ModelInputModality.IMAGE : contract.ModelInputModality.TEXT),
    contextWindowTokens: item.contextWindow === undefined ? 0n : BigInt(item.contextWindow),
    maximumOutputTokens: item.maxTokens === undefined ? 0n : BigInt(item.maxTokens),
    inputCostMicrosPerMillion: costToMicros(item.cost?.input),
    outputCostMicrosPerMillion: costToMicros(item.cost?.output),
    cacheReadCostMicrosPerMillion: costToMicros(item.cost?.cacheRead),
    cacheWriteCostMicrosPerMillion: costToMicros(item.cost?.cacheWrite),
    thinkingLevels: Object.entries(item.thinkingLevelMap ?? {}).map(([effortId, nativeLevel]) => create(contract.ProviderThinkingLevelMappingSchema, {
      effortId,
      nativeLevel: nativeLevel ?? undefined
    })),
    sampling: Object.keys(sampling).length === 0 ? undefined : create(contract.ProviderSamplingConfigurationSchema, {
      temperature: optionalNumberValue(sampling["temperature"]),
      topP: optionalNumberValue(sampling["topP"]),
      topK: optionalIntegerValue(sampling["topK"]),
      minP: optionalNumberValue(sampling["minP"]),
      repetitionPenalty: optionalNumberValue(sampling["repetitionPenalty"]),
      frequencyPenalty: optionalNumberValue(sampling["frequencyPenalty"]),
      presencePenalty: optionalNumberValue(sampling["presencePenalty"]),
      seed: optionalUnsignedBigInt(sampling["seed"])
    }),
    compatibility: Object.keys(compat).length === 0 ? undefined : create(contract.ProviderCompatibilityConfigurationSchema, {
      supportsDeveloperRole: optionalBooleanValue(compat["supportsDeveloperRole"]),
      supportsReasoningEffort: optionalBooleanValue(compat["supportsReasoningEffort"]),
      supportsUsageInStreaming: optionalBooleanValue(compat["supportsUsageInStreaming"]),
      supportsFinishReason: optionalBooleanValue(compat["supportsFinishReason"]),
      requiresReasoningContentOnAssistantMessages: optionalBooleanValue(compat["requiresReasoningContentOnAssistantMessages"]),
      supportsStore: optionalBooleanValue(compat["supportsStore"]),
      supportsStrictMode: optionalBooleanValue(compat["supportsStrictMode"]),
      supportsOpenaiGrammarTools: optionalBooleanValue(compat["supportsOpenaiGrammarTools"]),
      supportsEagerToolInputStreaming: optionalBooleanValue(compat["supportsEagerToolInputStreaming"]),
      supportsLongCacheRetention: optionalBooleanValue(compat["supportsLongCacheRetention"]),
      supportsCacheControlOnTools: optionalBooleanValue(compat["supportsCacheControlOnTools"]),
      supportsStrictTools: optionalBooleanValue(compat["supportsStrictTools"]),
      thinkingFormat: optionalStringValue(compat["thinkingFormat"]),
      cacheControlFormat: optionalStringValue(compat["cacheControlFormat"])
    })
  });
}

function providerEntryFromProto(input: contract.ProviderConfiguration): Omit<ManagedProviderEntry, "version" | "updatedAt"> & { readonly expectedVersion?: bigint } {
  if (input.providerId.trim() === "") throw invalidArgument("provider.provider_id is required");
  const api = nativeProviderApi(input.apiCompatibility, true);
  const headers: Record<string, { readonly env: string }> = {};
  const credentialBindings: Record<string, string> = {};
  if (input.credentialReferenceId !== "") {
    if (input.apiKeyEnvironment === "") throw invalidArgument("provider.api_key_environment is required when credential_reference_id is set");
    credentialBindings[input.apiKeyEnvironment] = input.credentialReferenceId;
  }
  for (const header of input.headers) {
    if (header.headerName === "" || header.environmentName === "") throw invalidArgument("provider.headers require header_name and environment_name");
    if (headers[header.headerName] !== undefined) throw invalidArgument(`provider header '${header.headerName}' is duplicated`);
    headers[header.headerName] = { env: header.environmentName };
    if (header.credentialReferenceId !== "") credentialBindings[header.environmentName] = header.credentialReferenceId;
  }
  const provider: PiManagedProvider = {
    id: input.providerId,
    ...(input.endpoint === "" ? {} : { baseUrl: input.endpoint }),
    ...(api === undefined ? {} : { api }),
    ...(input.apiKeyEnvironment === "" ? {} : { apiKeyEnv: input.apiKeyEnvironment }),
    keyless: input.keyless,
    authHeader: input.authHeader,
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
    models: input.models.map(providerModelFromProto)
  };
  if (provider.models.length === 0) throw invalidArgument("provider.models must contain at least one model");
  const kind = nativeProviderKind(input.kind);
  return {
    provider,
    displayName: input.displayName || input.providerId,
    kind,
    credentialBindings,
    enabled: input.enabled,
    supportsLogin: kind === "oauth" || kind === "subscription",
    supportsLogout: Object.keys(credentialBindings).length > 0 || kind === "oauth" || kind === "subscription",
    supportsRefresh: kind === "oauth" || kind === "subscription",
    ...(input.version?.revision === undefined ? {} : { expectedVersion: fromProtoRevision(input.version.revision, "provider.version.revision") })
  };
}

function providerModelFromProto(input: contract.ProviderModelConfiguration): PiManagedModel {
  if (input.modelId.trim() === "") throw invalidArgument("provider.models.model_id is required");
  const modalities = input.inputModalities.length === 0 ? undefined : input.inputModalities.map((value): "text" | "image" => {
    if (value === contract.ModelInputModality.TEXT) return "text";
    if (value === contract.ModelInputModality.IMAGE) return "image";
    throw invalidArgument("Pi BYOM supports only text and image input modalities");
  });
  const thinkingLevelMap = input.thinkingLevels.length === 0 ? undefined : Object.fromEntries(input.thinkingLevels.map((item) => [
    item.effortId,
    item.nativeLevel ?? null
  ]));
  const sampling = input.sampling === undefined ? undefined : definedRecord({
    temperature: input.sampling.temperature,
    topP: input.sampling.topP,
    topK: input.sampling.topK,
    minP: input.sampling.minP,
    repetitionPenalty: input.sampling.repetitionPenalty,
    frequencyPenalty: input.sampling.frequencyPenalty,
    presencePenalty: input.sampling.presencePenalty,
    seed: input.sampling.seed === undefined ? undefined : safeUnsignedNumber(input.sampling.seed, "provider.models.sampling.seed")
  });
  const compatibility = input.compatibility === undefined ? undefined : definedRecord({
    supportsDeveloperRole: input.compatibility.supportsDeveloperRole,
    supportsReasoningEffort: input.compatibility.supportsReasoningEffort,
    supportsUsageInStreaming: input.compatibility.supportsUsageInStreaming,
    supportsFinishReason: input.compatibility.supportsFinishReason,
    requiresReasoningContentOnAssistantMessages: input.compatibility.requiresReasoningContentOnAssistantMessages,
    supportsStore: input.compatibility.supportsStore,
    supportsStrictMode: input.compatibility.supportsStrictMode,
    supportsOpenaiGrammarTools: input.compatibility.supportsOpenaiGrammarTools,
    supportsEagerToolInputStreaming: input.compatibility.supportsEagerToolInputStreaming,
    supportsLongCacheRetention: input.compatibility.supportsLongCacheRetention,
    supportsCacheControlOnTools: input.compatibility.supportsCacheControlOnTools,
    supportsStrictTools: input.compatibility.supportsStrictTools,
    thinkingFormat: input.compatibility.thinkingFormat,
    cacheControlFormat: input.compatibility.cacheControlFormat
  });
  const hasCost = [input.inputCostMicrosPerMillion, input.outputCostMicrosPerMillion, input.cacheReadCostMicrosPerMillion, input.cacheWriteCostMicrosPerMillion].some((value) => value !== 0n);
  return {
    id: input.modelId,
    ...(input.displayName === "" ? {} : { name: input.displayName }),
    ...(input.apiCompatibility === undefined ? {} : { api: nativeProviderApi(input.apiCompatibility, false)! }),
    reasoning: input.reasoning,
    supportsFastMode: input.supportsFastMode,
    ...(input.defaultVisible === undefined ? {} : { defaultVisible: input.defaultVisible }),
    ...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap }),
    ...(modalities === undefined ? {} : { input: modalities }),
    ...(input.contextWindowTokens === 0n ? {} : { contextWindow: safeUnsignedNumber(input.contextWindowTokens, "provider.models.context_window_tokens") }),
    ...(input.maximumOutputTokens === 0n ? {} : { maxTokens: safeUnsignedNumber(input.maximumOutputTokens, "provider.models.maximum_output_tokens") }),
    ...(hasCost ? { cost: {
      input: costFromMicros(input.inputCostMicrosPerMillion),
      output: costFromMicros(input.outputCostMicrosPerMillion),
      cacheRead: costFromMicros(input.cacheReadCostMicrosPerMillion),
      cacheWrite: costFromMicros(input.cacheWriteCostMicrosPerMillion)
    } } : {}),
    ...(sampling === undefined || Object.keys(sampling).length === 0 ? {} : { samplingParams: sampling }),
    ...(compatibility === undefined || Object.keys(compatibility).length === 0 ? {} : { compat: compatibility })
  };
}

function nativeProviderKind(value: contract.ProviderKind): ManagedProviderEntry["kind"] {
  switch (value) {
    case contract.ProviderKind.MANAGED: return "managed";
    case contract.ProviderKind.API_KEY: return "api_key";
    case contract.ProviderKind.OAUTH: return "oauth";
    case contract.ProviderKind.SUBSCRIPTION: return "subscription";
    case contract.ProviderKind.LOCAL_KEYLESS: return "local_keyless";
    case contract.ProviderKind.CUSTOM_ENDPOINT: return "custom_endpoint";
    case contract.ProviderKind.UNSPECIFIED: throw invalidArgument("provider.kind is required");
  }
}

function protoProviderKind(value: ManagedProviderEntry["kind"]): contract.ProviderKind {
  switch (value) {
    case "managed": return contract.ProviderKind.MANAGED;
    case "api_key": return contract.ProviderKind.API_KEY;
    case "oauth": return contract.ProviderKind.OAUTH;
    case "subscription": return contract.ProviderKind.SUBSCRIPTION;
    case "local_keyless": return contract.ProviderKind.LOCAL_KEYLESS;
    case "custom_endpoint": return contract.ProviderKind.CUSTOM_ENDPOINT;
  }
}

function nativeProviderApi(value: contract.ProviderApiCompatibility, optional: boolean): PiSupportedApi | undefined {
  switch (value) {
    case contract.ProviderApiCompatibility.ANTHROPIC_MESSAGES: return "anthropic-messages";
    case contract.ProviderApiCompatibility.OPENAI_RESPONSES: return "openai-responses";
    case contract.ProviderApiCompatibility.OPENAI_CHAT_COMPLETIONS:
    case contract.ProviderApiCompatibility.OPENAI_COMPLETIONS: return "openai-completions";
    case contract.ProviderApiCompatibility.GOOGLE_GENERATIVE_AI: return "google-generative-ai";
    case contract.ProviderApiCompatibility.UNSPECIFIED:
      if (optional) return undefined;
      throw invalidArgument("provider API compatibility is required");
    case contract.ProviderApiCompatibility.NATIVE:
      throw invalidArgument("The selected Provider API compatibility is not supported losslessly by Pi");
  }
}

function protoProviderApi(value: PiSupportedApi | undefined): contract.ProviderApiCompatibility {
  switch (value) {
    case "anthropic-messages": return contract.ProviderApiCompatibility.ANTHROPIC_MESSAGES;
    case "openai-responses": return contract.ProviderApiCompatibility.OPENAI_RESPONSES;
    case "openai-completions": return contract.ProviderApiCompatibility.OPENAI_COMPLETIONS;
    case "google-generative-ai": return contract.ProviderApiCompatibility.GOOGLE_GENERATIVE_AI;
    case undefined: return contract.ProviderApiCompatibility.UNSPECIFIED;
  }
}

function mapAuthenticationState(value: NativeProviderDescriptor["authenticationState"]): contract.AuthenticationState {
  switch (value) {
    case "not_required": return contract.AuthenticationState.NOT_REQUIRED;
    case "signed_out": return contract.AuthenticationState.SIGNED_OUT;
    case "pending": return contract.AuthenticationState.PENDING;
    case "authenticated": return contract.AuthenticationState.AUTHENTICATED;
    case "expired": return contract.AuthenticationState.EXPIRED;
    case "refreshing": return contract.AuthenticationState.REFRESHING;
    case "error": return contract.AuthenticationState.ERROR;
  }
}

function nativeProviderLoginMethod(value: contract.ProviderLoginMethod): NativeProviderLoginFlow["method"] {
  switch (value) {
    case contract.ProviderLoginMethod.API_KEY: return "api_key";
    case contract.ProviderLoginMethod.OAUTH_BROWSER: return "oauth_browser";
    case contract.ProviderLoginMethod.DEVICE_CODE: return "device_code";
    case contract.ProviderLoginMethod.SUBSCRIPTION: return "subscription";
    case contract.ProviderLoginMethod.UNSPECIFIED: throw invalidArgument("provider login method is required");
  }
}

function nativePersistedProviderLoginMethod(value: unknown): NativeProviderLoginFlow["method"] {
  if (value === "api_key" || value === "oauth_browser" || value === "device_code" || value === "subscription") return value;
  throw new Error("Persisted Provider login method is invalid.");
}

function nativeProviderLoginMethodsForKind(
  kind: NativeProviderDescriptor["kind"]
): readonly NonNullable<NativeProviderDescriptor["loginMethods"]>[number][] {
  if (kind === "api_key") return ["api_key"];
  if (kind === "oauth") return ["oauth_browser", "device_code"];
  if (kind === "subscription") return ["subscription"];
  return [];
}

function protoManagedProviderLoginMethod(
  value: NonNullable<NativeProviderDescriptor["loginMethods"]>[number]
): contract.ProviderLoginMethod {
  if (value === "api_key") return contract.ProviderLoginMethod.API_KEY;
  if (value === "device_code") return contract.ProviderLoginMethod.DEVICE_CODE;
  if (value === "subscription") return contract.ProviderLoginMethod.SUBSCRIPTION;
  return contract.ProviderLoginMethod.OAUTH_BROWSER;
}

const BACKEND_PROVIDER_LOGIN_FLOW_LIMIT = 256;
const BACKEND_PROVIDER_LOGIN_TTL_MS = 10 * 60_000;
const QUEUE_LOCK_TTL_MS = 90_000;

function wakeQueueAfterLockExpiry(host: SessionHost, sessionId: string, expireLocks: () => void): void {
  const timer = setTimeout(() => {
    try {
      expireLocks();
    } catch {
      // The store may already be closed during shutdown.
    }
    try {
      host.requestQueueDrain(sessionId);
    } catch {
      // The host may already be closed during shutdown.
    }
  }, QUEUE_LOCK_TTL_MS + 50);
  timer.unref();
}
const BACKEND_PROVIDER_SYNC_GRACE_MS = 15_000;

function backendProviderAccountOperations(
  dependencies: ConnectServiceDependencies,
  backendId: string,
  providerId: string,
  capability?: "provider.login" | "provider.logout" | "provider.refresh" | "provider.model_refresh" | "provider.account_usage",
  admittedAdapter?: BackendAdapter
): { readonly descriptor: BackendDescriptor; readonly operations: BackendProviderAccountOperations } {
  const normalizedBackendId = nonBlankRequest(backendId, "backend_id");
  const normalizedProviderId = nonBlankRequest(providerId, "provider_id");
  const descriptor = dependencies.store.getBackend(normalizedBackendId).descriptor;
  if (descriptor.providers?.some((provider) => provider.providerId === normalizedProviderId) !== true
    && !descriptor.models.some((model) => model.providerId === normalizedProviderId)) {
    throw new NotFoundError("Provider", normalizedProviderId);
  }
  if (capability !== undefined && descriptor.capabilities.get(capability)?.supported !== true) {
    throw new ConnectError("The selected Backend does not advertise this Provider operation.", Code.Unimplemented);
  }
  const adapter = admittedAdapter ?? dependencies.adapters().find((candidate) => candidate.id === normalizedBackendId);
  if (adapter === undefined) {
    throw new ConnectError("The selected Backend is not currently available.", Code.Unavailable);
  }
  if (adapter.id !== normalizedBackendId) {
    throw new ConnectError("The admitted Backend does not own this Provider operation.", Code.FailedPrecondition);
  }
  const operations = adapter as BackendAdapter & BackendProviderAccountOperations;
  const supported = capability === "provider.login"
    ? typeof operations.readAccount === "function"
      && typeof operations.beginLogin === "function"
      && typeof operations.cancelLogin === "function"
    : capability === "provider.logout"
      ? typeof operations.logout === "function"
      : capability === "provider.model_refresh"
        ? typeof operations.listModels === "function" || dependencies.refreshBackendDescriptor !== undefined
        : capability === "provider.account_usage"
          ? typeof operations.readAccountUsage === "function"
          : capability === "provider.refresh"
            ? typeof operations.readAccount === "function" || dependencies.refreshBackendDescriptor !== undefined
            : typeof operations.readAccount === "function";
  if (!supported) {
    throw new ConnectError("The selected Backend has no native channel for this Provider operation.", Code.Unimplemented);
  }
  return { descriptor, operations };
}

function rememberBackendProviderLoginFlow(
  dependencies: ConnectServiceDependencies,
  flow: BackendProviderLoginFlow
): BackendProviderLoginFlow {
  if (!dependencies.backendProviderLoginFlows.has(flow.opaqueFlowId)
    && dependencies.backendProviderLoginFlows.size >= BACKEND_PROVIDER_LOGIN_FLOW_LIMIT) {
    const terminal = [...dependencies.backendProviderLoginFlows].find(([, item]) =>
      item.state !== "pending");
    const oldest = terminal?.[0] ?? dependencies.backendProviderLoginFlows.keys().next().value as string | undefined;
    if (oldest !== undefined) dependencies.backendProviderLoginFlows.delete(oldest);
  }
  dependencies.backendProviderLoginFlows.set(flow.opaqueFlowId, flow);
  return flow;
}

function backendProviderCredentialSurfaceAdvertised(
  backend: BackendDescriptor,
  providerId: string,
  modelId: string | undefined
): boolean {
  const providers: readonly unknown[] = Array.isArray(backend.providers) ? backend.providers : [];
  return providers.some((candidate) => {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const provider = candidate as Record<string, unknown>;
    if (provider["providerId"] !== providerId) return false;
    return validatedProviderCredentialSurfaces(provider["credentialSurfaces"]).some((surface) =>
      modelId === undefined || surface.models.some((model) => model.modelId === modelId));
  });
}

function withBackendProviderLoginLock<T>(
  dependencies: ConnectServiceDependencies,
  flowId: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = dependencies.backendProviderLoginTails.get(flowId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  const tail = current.then(() => undefined, () => undefined);
  dependencies.backendProviderLoginTails.set(flowId, tail);
  void tail.then(() => {
    if (dependencies.backendProviderLoginTails.get(flowId) === tail) {
      dependencies.backendProviderLoginTails.delete(flowId);
    }
  });
  return current;
}

function updateBackendProviderLoginFlow(
  dependencies: ConnectServiceDependencies,
  flow: BackendProviderLoginFlow,
  patch: Partial<Omit<BackendProviderLoginFlow, "opaqueFlowId" | "backendId" | "providerId" | "method" | "startedAt">>
): BackendProviderLoginFlow {
  const current = dependencies.backendProviderLoginFlows.get(flow.opaqueFlowId);
  if (current !== undefined && current !== flow) return current;
  if (flow.state !== "pending") return flow;
  return rememberBackendProviderLoginFlow(dependencies, { ...flow, ...patch });
}

async function observeBackendProviderLoginFlow(
  dependencies: ConnectServiceDependencies,
  flow: BackendProviderLoginFlow
): Promise<BackendProviderLoginFlow> {
  if (flow.state !== "pending") return flow;
  const at = (dependencies.now ?? Date.now)();
  const expired = flow.expiresAt !== undefined && flow.expiresAt <= at;
  let account: BackendProviderAccountSnapshot;
  let refreshFailed = false;
  try {
    const observation = await dependencies.sessionHost.invokeBackendAdapter(flow.backendId, async (adapter) => {
      const operations = backendProviderAccountOperations(
        dependencies,
        flow.backendId,
        flow.providerId,
        undefined,
        adapter
      ).operations;
      if (flow.nativeLoginId !== undefined && operations.readLoginOutcome !== undefined) {
        let loginObservation = await operations.readLoginOutcome(flow.nativeLoginId);
        if (expired && loginObservation.outcome === "pending") {
          if (operations.cancelLogin === undefined) {
            return { outcome: "outcome_unknown" as const };
          }
          try {
            await operations.cancelLogin(flow.nativeLoginId);
          } catch {
            try {
              loginObservation = await operations.readLoginOutcome(flow.nativeLoginId);
            } catch {
              return { outcome: "outcome_unknown" as const };
            }
            if (loginObservation.outcome === "pending") {
              return { outcome: "outcome_unknown" as const };
            }
          }
          if (loginObservation.outcome === "pending") {
            try {
              await dependencies.refreshBackendDescriptor?.(flow.backendId);
            } catch {
              // Cancellation is already known; descriptor discovery remains independently retryable.
            }
            return { outcome: "timed_out" as const };
          }
        }
        const outcome = loginObservation.outcome;
        if (outcome !== "completed") {
          if (outcome === "cancelled" || outcome === "error") {
            try {
              await operations.readAccount!(false);
              await dependencies.refreshBackendDescriptor?.(flow.backendId);
            } catch {
              return { outcome, failureReason: loginObservation.failureReason, refreshFailed: true } as const;
            }
          }
          return { outcome, failureReason: loginObservation.failureReason, refreshFailed: false } as const;
        }
      } else if (expired && flow.credentialAcceptedAt === undefined) {
        if (flow.nativeLoginId !== undefined) {
          if (operations.cancelLogin === undefined) {
            return { outcome: "outcome_unknown" as const };
          }
          try {
            await operations.cancelLogin(flow.nativeLoginId);
          } catch {
            return { outcome: "outcome_unknown" as const };
          }
          try {
            await dependencies.refreshBackendDescriptor?.(flow.backendId);
          } catch {
            // Cancellation is already known; descriptor discovery remains independently retryable.
          }
        }
        return { outcome: "timed_out" as const };
      }
      const observedAccount = await operations.readAccount!(false);
      if (observedAccount.authenticated || observedAccount.authenticationState === "authenticated") {
        try {
          await dependencies.refreshBackendDescriptor?.(flow.backendId);
        } catch {
          return { outcome: "completed" as const, account: observedAccount, refreshFailed: true };
        }
      }
      return { outcome: "completed" as const, account: observedAccount, refreshFailed: false };
    });
    if (observation.outcome === "outcome_unknown") {
      return updateBackendProviderLoginFlow(dependencies, flow, {
        state: "outcome_unknown",
        updatedAt: at,
        pendingPrompt: undefined,
        error: "Provider login timed out and its cancellation outcome is unknown."
      });
    }
    if (observation.outcome === "timed_out") {
      return updateBackendProviderLoginFlow(dependencies, flow, {
        state: "timed_out",
        updatedAt: at,
        pendingPrompt: undefined,
        error: "Provider login timed out."
      });
    }
    if (observation.outcome === "pending") {
      return updateBackendProviderLoginFlow(dependencies, flow, { updatedAt: at, error: undefined });
    }
    if (observation.outcome === "cancelled" || observation.outcome === "error") {
      return updateBackendProviderLoginFlow(dependencies, flow, {
        state: observation.outcome === "cancelled" ? "cancelled" : "error",
        updatedAt: at,
        pendingPrompt: undefined,
        error: observation.outcome === "cancelled"
          ? undefined
          : observation.failureReason === "not_a_subscription"
            ? "The authorized account does not provide subscription model access."
            : "Provider login could not be completed."
      });
    }
    if (observation.account === undefined) {
      return updateBackendProviderLoginFlow(dependencies, flow, { updatedAt: at, error: undefined });
    }
    account = observation.account;
    refreshFailed = observation.refreshFailed;
  } catch {
    if (flow.credentialAcceptedAt !== undefined
      && (expired || at - flow.credentialAcceptedAt >= BACKEND_PROVIDER_SYNC_GRACE_MS)) {
      return updateBackendProviderLoginFlow(dependencies, flow, {
        state: "outcome_unknown",
        updatedAt: at,
        pendingPrompt: undefined,
        error: "Provider credential was saved, but account projection could not be confirmed."
      });
    }
    return updateBackendProviderLoginFlow(dependencies, flow, {
      updatedAt: at,
      error: "Provider account state could not be refreshed."
    });
  }
  if (account.authenticationState === "error" || account.authenticationState === "expired") {
    return updateBackendProviderLoginFlow(dependencies, flow, {
      state: "error",
      updatedAt: at,
      pendingPrompt: undefined,
      error: account.authenticationState === "expired"
        ? "Provider login returned an expired credential."
        : "Provider login could not be completed."
    });
  }
  if (!account.authenticated && account.authenticationState !== "authenticated") {
    return updateBackendProviderLoginFlow(dependencies, flow, { updatedAt: at, error: undefined });
  }
  if (refreshFailed) {
    const credentialAcceptedAt = flow.credentialAcceptedAt ?? at;
    if (expired || at - credentialAcceptedAt >= BACKEND_PROVIDER_SYNC_GRACE_MS) {
      return updateBackendProviderLoginFlow(dependencies, flow, {
        state: "outcome_unknown",
        credentialAcceptedAt,
        updatedAt: at,
        pendingPrompt: undefined,
        error: "Provider credential was saved, but account projection could not be confirmed."
      });
    }
    return updateBackendProviderLoginFlow(dependencies, flow, {
      credentialAcceptedAt,
      updatedAt: at,
      pendingPrompt: undefined,
      error: "Provider account is connected, but its model catalog could not be refreshed."
    });
  }
  return updateBackendProviderLoginFlow(dependencies, flow, {
    state: "completed",
    updatedAt: at,
    pendingPrompt: undefined,
    error: undefined
  });
}

function currentProviderLoginFlow(
  dependencies: ConnectServiceDependencies,
  loginFlowId: string
): NativeProviderLoginFlow | PiProviderAuthFlowRecord | BackendProviderLoginFlow | undefined {
  const backendFlow = dependencies.backendProviderLoginFlows.get(loginFlowId);
  if (backendFlow !== undefined) return backendFlow;
  const projected = dependencies.providerLoginFlows.get(loginFlowId);
  const nativeFlowId = projected?.opaqueFlowId ?? loginFlowId;
  return dependencies.providerAuth?.getFlow(nativeFlowId) ?? projected;
}

function requireProviderAuth(dependencies: ConnectServiceDependencies): PiProviderAuthSupervisor {
  if (dependencies.providerAuth === undefined) {
    throw new ConnectError("Interactive Provider login is not available from the active Backend.", Code.Unimplemented);
  }
  return dependencies.providerAuth;
}

function requireCurrentProviderLoginFlow(
  dependencies: ConnectServiceDependencies,
  loginFlowId: string
): PiProviderAuthFlowRecord {
  const supervisor = requireProviderAuth(dependencies);
  const projected = dependencies.providerLoginFlows.get(loginFlowId);
  const flow = supervisor.getFlow(projected?.opaqueFlowId ?? loginFlowId);
  if (flow === undefined) throw new ConnectError("Provider login flow not found.", Code.NotFound);
  return flow;
}

function requireActiveProviderLoginPrompt(
  flow: Pick<PiProviderAuthFlowRecord, "state" | "pendingPrompt">
    | Pick<BackendProviderLoginFlow, "state" | "pendingPrompt">,
  promptId: string,
  allowedKinds?: readonly PiProviderAuthPromptKind[]
): NonNullable<PiProviderAuthFlowRecord["pendingPrompt"]> {
  if (flow.state !== "starting" && flow.state !== "pending") {
    throw new ConnectError("Provider login flow is no longer active.", Code.FailedPrecondition);
  }
  const prompt = flow.pendingPrompt;
  if (prompt === undefined || prompt.promptId !== promptId) {
    throw new ConnectError("Provider login prompt is stale or does not exist.", Code.FailedPrecondition);
  }
  if (allowedKinds !== undefined && !allowedKinds.includes(prompt.kind)) {
    throw new ConnectError("Provider login prompt does not accept credential-channel input.", Code.FailedPrecondition);
  }
  return prompt;
}

function providerLoginPromptAnswer(
  kind: PiProviderAuthPromptKind,
  input: contract.SubmitProviderLoginInputRequest["input"]
): PiProviderAuthPromptAnswer {
  if (kind === "select") {
    if (input.case !== "choiceId" || input.value.trim() === "") {
      throw invalidArgument("A non-empty choice_id is required for this Provider login prompt.");
    }
    return { case: "choice", optionId: input.value };
  }
  if (kind === "text") {
    if (input.case !== "text") throw invalidArgument("text is required for this Provider login prompt.");
    return { case: "text", text: input.value };
  }
  if (input.case !== "credentialInputTicketId" || input.value.trim() === "") {
    throw invalidArgument("credential_input_ticket_id is required for sensitive Provider login input.");
  }
  return { case: "credential_upload", credentialUploadTicketId: input.value };
}

function nonBlankRequest(value: string, field: string): string {
  if (value.trim() === "") throw invalidArgument(`${field} is required`);
  return value;
}

function mapProviderLoginFlow(
  loginFlowId: string,
  item: NativeProviderLoginFlow | PiProviderAuthFlowRecord | BackendProviderLoginFlow
): contract.ProviderLoginFlow {
  const native = "state" in item ? item : undefined;
  return create(contract.ProviderLoginFlowSchema, {
    loginFlowId,
    providerId: item.providerId,
    method: item.method === "api_key"
      ? contract.ProviderLoginMethod.API_KEY
      : item.method === "oauth_browser"
        ? contract.ProviderLoginMethod.OAUTH_BROWSER
        : item.method === "device_code" ? contract.ProviderLoginMethod.DEVICE_CODE : contract.ProviderLoginMethod.SUBSCRIPTION,
    verificationUri: item.verificationUri ?? "",
    userCode: item.userCode ?? "",
    expiresAt: item.expiresAt === undefined ? undefined : toProtoTimestamp(item.expiresAt),
    state: native === undefined ? contract.ProviderLoginFlowState.PENDING : providerLoginFlowState(native.state),
    pendingPrompt: native?.pendingPrompt === undefined ? undefined : create(contract.ProviderLoginPromptSchema, {
      promptId: native.pendingPrompt.promptId,
      kind: providerLoginPromptKind(native.pendingPrompt.kind),
      message: native.pendingPrompt.message,
      placeholder: native.pendingPrompt.placeholder ?? "",
      options: native.pendingPrompt.options?.map((option) => create(contract.ProviderLoginPromptOptionSchema, {
        optionId: option.id,
        label: option.label,
        description: option.description ?? ""
      })) ?? []
    }),
    updatedAt: native === undefined ? undefined : toProtoTimestamp(native.updatedAt),
    error: native?.error === undefined ? undefined : provisioningError("provider.login", native.error)
  });
}

function providerLoginFlowState(
  value: PiProviderAuthFlowRecord["state"] | BackendProviderLoginState
): contract.ProviderLoginFlowState {
  switch (value) {
    case "starting": return contract.ProviderLoginFlowState.STARTING;
    case "pending": return contract.ProviderLoginFlowState.PENDING;
    case "completed": return contract.ProviderLoginFlowState.COMPLETED;
    case "cancelled": return contract.ProviderLoginFlowState.CANCELLED;
    case "timed_out": return contract.ProviderLoginFlowState.TIMED_OUT;
    case "outcome_unknown": return contract.ProviderLoginFlowState.OUTCOME_UNKNOWN;
    case "error": return contract.ProviderLoginFlowState.FAILED;
  }
}

function providerLoginPromptKind(value: PiProviderAuthPromptKind): contract.ProviderLoginPromptKind {
  switch (value) {
    case "text": return contract.ProviderLoginPromptKind.TEXT;
    case "secret": return contract.ProviderLoginPromptKind.SECRET;
    case "manual_code": return contract.ProviderLoginPromptKind.MANUAL_CODE;
    case "select": return contract.ProviderLoginPromptKind.SELECT;
  }
}

function mapPersistedProviderLoginFlow(item: NonNullable<OperationOutcome["providerLogin"]>): contract.ProviderLoginFlow {
  return create(contract.ProviderLoginFlowSchema, {
    loginFlowId: item.loginFlowId,
    providerId: item.providerId,
    method: item.method === "api_key"
      ? contract.ProviderLoginMethod.API_KEY
      : item.method === "oauth_browser"
        ? contract.ProviderLoginMethod.OAUTH_BROWSER
      : item.method === "device_code" ? contract.ProviderLoginMethod.DEVICE_CODE : contract.ProviderLoginMethod.SUBSCRIPTION,
    verificationUri: item.verificationUri ?? "",
    userCode: item.userCode ?? "",
    expiresAt: item.expiresAt === undefined ? undefined : toProtoTimestamp(item.expiresAt),
    state: contract.ProviderLoginFlowState.OUTCOME_UNKNOWN,
    error: provisioningError(
      "provider.login",
      "Provider login was interrupted; start a new flow before submitting credentials."
    )
  });
}

function costFromMicros(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw invalidArgument("Provider model cost is outside the supported range");
  return Number(value) / 1_000_000;
}

function costToMicros(value: number | undefined): bigint {
  if (value === undefined) return 0n;
  if (!Number.isFinite(value) || value < 0) throw invalidArgument("Provider model cost must be finite and non-negative");
  return BigInt(Math.round(value * 1_000_000));
}

function safeUnsignedNumber(value: bigint, label: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw invalidArgument(`${label} is outside the supported range`);
  return Number(value);
}

function definedRecord(input: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function optionalNumberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalIntegerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function optionalBooleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optionalStringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalUnsignedBigInt(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value >= 0n ? value : undefined;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  return undefined;
}

function mapMcpServerDescriptor(item: NativeMcpServerDescriptor): contract.McpServerDescriptor {
  return create(contract.McpServerDescriptorSchema, {
    mcpServerId: item.id,
    displayName: item.displayName,
    transport: item.transport === "stdio" ? contract.McpTransport.STDIO : contract.McpTransport.HTTPS_STREAMABLE_HTTP,
    endpointDisplay: item.endpointDisplay,
    state: protoMcpState(item.state),
    runtimeGeneration: BigInt(item.runtimeGeneration),
    tools: item.tools.map((tool) => mapMcpToolDescriptor(tool)),
    credentialBindings: item.credentialBindings.map((binding) => create(contract.CredentialBindingSchema, {
      headerName: binding.target === "header" ? binding.name : "",
      credentialReferenceId: binding.credentialReferenceId,
      configured: binding.configured,
      target: binding.target === "header" ? contract.McpCredentialTarget.HEADER : contract.McpCredentialTarget.ENVIRONMENT,
      targetName: binding.name
    })),
    enabled: item.enabled,
    transportConfig: item.configuration.case === "stdio"
      ? {
        case: "stdio",
        value: create(contract.StdioMcpConfigurationSchema, {
          command: item.configuration.command,
          arguments: [...item.configuration.arguments],
          workingDirectory: item.configuration.workingDirectory,
          environment: Object.entries(item.configuration.environment)
            .sort(([left], [right]) => left.localeCompare(right, "en"))
            .map(([name, value]) => create(contract.McpEnvironmentVariableSchema, { name, value }))
        })
      }
      : {
        case: "streamableHttp",
        value: create(contract.StreamableHttpMcpConfigurationSchema, { endpoint: item.configuration.endpoint })
      },
    version: toProtoEntityVersion(item.version, item.runtimeGeneration, item.updatedAt),
    error: item.error === undefined ? undefined : provisioningError("mcp", item.error)
  });
}

function mapMcpToolDescriptor(
  item: NativeMcpServerDescriptor["tools"][number],
  toolProviderId = `mcp:${item.serverId}`
): contract.ToolDescriptor {
  return create(contract.ToolDescriptorSchema, {
    toolId: `${toolProviderId}:${item.name}`,
    toolProviderId,
    name: item.name,
    displayName: item.name,
    description: item.description,
    inputSchema: mapToolInputSchema(item.inputSchema),
    requiresPermission: item.requiresPermission,
    streamingUpdates: false,
    enabled: true
  });
}

function mapBackendToolDescriptor(
  item: BackendToolDescriptor,
  toolProviderId: string
): contract.ToolDescriptor {
  return create(contract.ToolDescriptorSchema, {
    toolId: `${toolProviderId}:${item.toolId}`,
    toolProviderId,
    name: item.name,
    displayName: item.displayName,
    description: item.description,
    inputSchema: mapDynamicToolInputSchema(item.inputSchema),
    requiresPermission: item.requiresPermission,
    streamingUpdates: item.streamingUpdates,
    enabled: item.enabled
  });
}

function requireSubagentCapability(
  dependencies: ConnectServiceDependencies,
  sessionId: string,
  capability: string
): void {
  const session = dependencies.store.getSession(sessionId);
  const backend = dependencies.store.getBackend(session.descriptor.backendId).descriptor;
  if (backend.capabilities.get(capability)?.supported !== true) {
    throw new ConnectError(`Backend does not support ${capability}.`, Code.Unimplemented);
  }
}

function coreSubagentRunState(
  value: contract.SubagentRunState,
  field: string
): import("@joko/core").SubagentRunState {
  if (value === contract.SubagentRunState.QUEUED) return "queued";
  if (value === contract.SubagentRunState.RUNNING) return "running";
  if (value === contract.SubagentRunState.COMPLETED) return "completed";
  if (value === contract.SubagentRunState.FAILED) return "failed";
  if (value === contract.SubagentRunState.STOPPED) return "stopped";
  throw invalidArgument(`${field} is invalid`);
}

function coreSubagentControlAction(
  value: contract.SubagentControlAction
): import("@joko/core").SubagentControlAction {
  if (value === contract.SubagentControlAction.STOP) return "stop";
  if (value === contract.SubagentControlAction.STEER) return "steer";
  if (value === contract.SubagentControlAction.FOLLOW_UP) return "follow_up";
  if (value === contract.SubagentControlAction.RESUME) return "resume";
  throw invalidArgument("control_subagent.action is required");
}

function subagentControlCapability(action: import("@joko/core").SubagentControlAction): string {
  if (action === "stop") return contract.capabilityNames.subagentsStop;
  if (action === "steer") return contract.capabilityNames.subagentsSteer;
  if (action === "follow_up") return contract.capabilityNames.subagentsFollowUp;
  return contract.capabilityNames.subagentsResume;
}

function mapDynamicToolInputSchema(item: BackendToolDescriptor["inputSchema"]): contract.ToolInputSchema {
  return create(contract.ToolInputSchemaSchema, {
    fields: item.fields.map((field) => create(contract.ToolInputFieldSchema, {
      fieldPath: field.fieldPath,
      title: field.title,
      description: field.description,
      type: protoDynamicToolFieldType(field.type),
      required: field.required,
      secret: field.secret,
      enumValues: [...field.enumValues],
      constraints: field.constraints === undefined
        ? undefined
        : create(contract.ToolFieldConstraintsSchema, {
          minimumLength: field.constraints.minimumLength ?? 0,
          maximumLength: field.constraints.maximumLength ?? 0,
          minimumNumber: field.constraints.minimumNumber ?? 0,
          maximumNumber: field.constraints.maximumNumber ?? 0,
          pattern: field.constraints.pattern ?? "",
          itemFieldPath: field.constraints.itemFieldPath ?? ""
        })
    })),
    allowsAdditionalFields: item.allowsAdditionalFields
  });
}

function mapRuntimeToolCatalog(item: RuntimeToolCatalog): contract.RuntimeToolCatalog {
  return create(contract.RuntimeToolCatalogSchema, {
    runtimeGeneration: BigInt(item.runtimeGeneration),
    observedAt: toProtoTimestamp(item.observedAt),
    tools: item.tools.map((tool) => create(contract.RuntimeToolDescriptorSchema, {
      name: tool.name,
      description: tool.description,
      inputSchema: mapDynamicToolInputSchema(tool.inputSchema),
      promptGuidelines: [...tool.promptGuidelines],
      active: tool.active,
      sourceInfo: create(contract.RuntimeToolSourceInfoSchema, {
        path: tool.sourceInfo.path,
        source: tool.sourceInfo.source,
        scope: runtimeToolSourceScope(tool.sourceInfo.scope),
        origin: runtimeToolSourceOrigin(tool.sourceInfo.origin),
        ...(tool.sourceInfo.baseDir === undefined ? {} : { baseDir: tool.sourceInfo.baseDir })
      })
    }))
  });
}

function runtimeToolSourceScope(value: RuntimeToolCatalog["tools"][number]["sourceInfo"]["scope"]): contract.RuntimeToolSourceScope {
  switch (value) {
    case "user": return contract.RuntimeToolSourceScope.USER;
    case "project": return contract.RuntimeToolSourceScope.PROJECT;
    case "temporary": return contract.RuntimeToolSourceScope.TEMPORARY;
  }
}

function runtimeToolSourceOrigin(value: RuntimeToolCatalog["tools"][number]["sourceInfo"]["origin"]): contract.RuntimeToolSourceOrigin {
  switch (value) {
    case "package": return contract.RuntimeToolSourceOrigin.PACKAGE;
    case "top-level": return contract.RuntimeToolSourceOrigin.TOP_LEVEL;
  }
}

function protoDynamicToolFieldType(value: DynamicInputFieldType): contract.ToolFieldType {
  switch (value) {
    case "string": return contract.ToolFieldType.STRING;
    case "number": return contract.ToolFieldType.NUMBER;
    case "integer": return contract.ToolFieldType.INTEGER;
    case "boolean": return contract.ToolFieldType.BOOLEAN;
    case "object": return contract.ToolFieldType.OBJECT;
    case "array": return contract.ToolFieldType.ARRAY;
    case "blob": return contract.ToolFieldType.BLOB;
  }
}

function mapToolInputSchema(schema: Readonly<Record<string, unknown>>): contract.ToolInputSchema {
  const properties = asRecord(schema["properties"]);
  const required = new Set(Array.isArray(schema["required"])
    ? schema["required"].filter((item): item is string => typeof item === "string")
    : []);
  const fields = Object.entries(properties).sort(([left], [right]) => left.localeCompare(right, "en")).map(([name, raw]) => {
    const value = asRecord(raw);
    const enumValues = Array.isArray(value["enum"])
      ? value["enum"].filter((item): item is string => typeof item === "string")
      : [];
    return create(contract.ToolInputFieldSchema, {
      fieldPath: name,
      title: stringValue(value["title"]) ?? name,
      description: stringValue(value["description"]) ?? "",
      type: protoToolFieldType(value["type"], value["contentEncoding"]),
      required: required.has(name),
      secret: Boolean(value["writeOnly"]) || /(?:secret|password|token|credential|api[_-]?key)/iu.test(name),
      enumValues,
      constraints: create(contract.ToolFieldConstraintsSchema, {
        minimumLength: safeNonNegativeUInt32(value["minLength"]),
        maximumLength: safeNonNegativeUInt32(value["maxLength"]),
        minimumNumber: optionalNumberValue(value["minimum"]) ?? 0,
        maximumNumber: optionalNumberValue(value["maximum"]) ?? 0,
        pattern: stringValue(value["pattern"]) ?? "",
        itemFieldPath: ""
      })
    });
  });
  return create(contract.ToolInputSchemaSchema, {
    fields,
    allowsAdditionalFields: schema["additionalProperties"] !== false
  });
}

function protoToolFieldType(value: unknown, contentEncoding: unknown): contract.ToolFieldType {
  if (contentEncoding === "base64") return contract.ToolFieldType.BLOB;
  switch (value) {
    case "string": return contract.ToolFieldType.STRING;
    case "number": return contract.ToolFieldType.NUMBER;
    case "integer": return contract.ToolFieldType.INTEGER;
    case "boolean": return contract.ToolFieldType.BOOLEAN;
    case "object": return contract.ToolFieldType.OBJECT;
    case "array": return contract.ToolFieldType.ARRAY;
    default: return contract.ToolFieldType.UNSPECIFIED;
  }
}

function safeNonNegativeUInt32(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff ? value : 0;
}

function nativeMcpState(value: contract.McpServerState): NativeMcpServerState | undefined {
  switch (value) {
    case contract.McpServerState.DISABLED: return "disabled";
    case contract.McpServerState.STARTING: return "starting";
    case contract.McpServerState.CONNECTED: return "connected";
    case contract.McpServerState.DEGRADED: return "degraded";
    case contract.McpServerState.DISCONNECTED: return "disconnected";
    case contract.McpServerState.ERROR: return "error";
    case contract.McpServerState.UNSPECIFIED: return undefined;
  }
}

function protoMcpState(value: NativeMcpServerState): contract.McpServerState {
  switch (value) {
    case "disabled": return contract.McpServerState.DISABLED;
    case "starting": return contract.McpServerState.STARTING;
    case "connected": return contract.McpServerState.CONNECTED;
    case "degraded": return contract.McpServerState.DEGRADED;
    case "disconnected": return contract.McpServerState.DISCONNECTED;
    case "error": return contract.McpServerState.ERROR;
  }
}

function nativeMcpServerInput(id: string, input: contract.McpServerInput): NativeMcpServerInput {
  const serverId = id.trim();
  if (serverId === "") throw invalidArgument("mcp_server_id is required");
  const displayName = input.displayName.trim() || serverId;
  const credentialBindings = input.credentialBindings.map(nativeMcpCredentialBinding);
  if (input.transport === contract.McpTransport.STDIO) {
    if (input.transportConfig.case !== "stdio") throw invalidArgument("server.stdio transport_config is required for STDIO");
    if (input.endpoint !== "") throw invalidArgument("server.endpoint is not valid for STDIO");
    const config = input.transportConfig.value;
    if (config.command.trim() === "") throw invalidArgument("server.stdio.command is required");
    const environment: Record<string, string> = {};
    for (const variable of config.environment) {
      if (variable.name.trim() === "") throw invalidArgument("server.stdio.environment.name is required");
      if (environment[variable.name] !== undefined) throw invalidArgument(`server.stdio.environment '${variable.name}' is duplicated`);
      environment[variable.name] = variable.value;
    }
    return {
      id: serverId,
      displayName,
      enabled: input.enabled,
      credentialBindings,
      transport: "stdio",
      command: config.command,
      ...(config.arguments.length === 0 ? {} : { args: [...config.arguments] }),
      ...(config.workingDirectory === "" ? {} : { cwd: config.workingDirectory }),
      ...(Object.keys(environment).length === 0 ? {} : { environment })
    };
  }
  if (input.transport === contract.McpTransport.HTTPS_STREAMABLE_HTTP) {
    if (input.transportConfig.case !== "streamableHttp") throw invalidArgument("server.streamable_http transport_config is required for HTTPS Streamable HTTP");
    const configuredEndpoint = input.transportConfig.value.endpoint;
    if (input.endpoint !== "" && configuredEndpoint !== "" && input.endpoint !== configuredEndpoint) {
      throw invalidArgument("server.endpoint and server.streamable_http.endpoint do not match");
    }
    const endpoint = configuredEndpoint || input.endpoint;
    if (endpoint.trim() === "") throw invalidArgument("server.streamable_http.endpoint is required");
    return {
      id: serverId,
      displayName,
      enabled: input.enabled,
      credentialBindings,
      transport: "streamable_http",
      endpoint
    };
  }
  if (input.transport === contract.McpTransport.LOOPBACK_BRIDGE) {
    throw invalidArgument("LOOPBACK_BRIDGE is an internal transport and cannot be provisioned");
  }
  throw invalidArgument("server.transport is required");
}

function nativeMcpCredentialBinding(input: contract.CredentialBinding): NativeMcpCredentialBinding {
  if (input.credentialReferenceId.trim() === "") throw invalidArgument("server.credential_bindings.credential_reference_id is required");
  if (input.target === contract.McpCredentialTarget.HEADER) {
    const name = input.targetName || input.headerName;
    if (name.trim() === "") throw invalidArgument("header credential binding target_name is required");
    if (input.headerName !== "" && input.targetName !== "" && input.headerName !== input.targetName) {
      throw invalidArgument("header credential binding header_name and target_name do not match");
    }
    return { target: "header", name, credentialReferenceId: input.credentialReferenceId };
  }
  if (input.target === contract.McpCredentialTarget.ENVIRONMENT) {
    if (input.targetName.trim() === "") throw invalidArgument("environment credential binding target_name is required");
    if (input.headerName !== "") throw invalidArgument("environment credential binding cannot set header_name");
    return { target: "environment", name: input.targetName, credentialReferenceId: input.credentialReferenceId };
  }
  throw invalidArgument("server.credential_bindings.target is required");
}

function mapManagedResource(item: NativePiResourceDescriptor): contract.ManagedResource {
  return create(contract.ManagedResourceSchema, {
    resourceId: item.id,
    backendId: item.backendId,
    targetId: item.targetId ?? "",
    kind: protoResourceKind(item.kind),
    name: item.name,
    version: item.version ?? "",
    source: create(contract.ResourceSourceSchema, {
      scope: protoResourceScope(item.scope),
      sourceDisplay: item.sourceDisplay,
      canonicalPathFingerprint: item.canonicalPathFingerprint,
      symbolicLinkDetected: item.symbolicLinkDetected,
      specialFileDetected: item.specialFileDetected,
      acquisitionKind: protoResourceAcquisitionKind(item.sourceKind),
      sourceIdentity: item.sourceIdentity ?? item.sourceDisplay
    }),
    state: protoResourceState(item.state),
    enabled: item.enabled,
    approvedAt: item.approvedAt === undefined ? undefined : toProtoTimestamp(item.approvedAt),
    approvedByConnectionId: item.approvedByConnectionId ?? "",
    entityVersion: toProtoEntityVersion(item.versionNumber, 0, item.updatedAt),
    error: item.error === undefined ? undefined : provisioningError("pi_resource", item.error),
    discoveredRevision: item.discoveredRevision,
    compatibilityDetails: item.resourceDetails.map((detail) => create(contract.ResourceCompatibilityDetailSchema, {
      kind: protoResourceKind(detail.kind),
      name: detail.name,
      compatibility: protoResourceCompatibility(detail.compatibility),
      issues: detail.compatibilityIssues.map(protoResourceCompatibilityIssue),
      detectedApis: detail.detectedApis.map(protoResourceUiApi),
      adaptedApis: detail.adaptedApis.map(protoResourceUiApi),
      unsupportedApis: detail.unsupportedApis.map(protoResourceUiApi)
    })),
    runtimeRequirements: item.runtimeRequirements.map((requirement) => create(contract.ResourceRuntimeRequirementSchema, {
      packageName: requirement.packageName,
      range: requirement.range,
      ...(requirement.currentVersion === undefined ? {} : { currentVersion: requirement.currentVersion }),
      status: requirement.compatible === true
        ? contract.ResourceRuntimeRequirementStatus.COMPATIBLE
        : requirement.compatible === false
          ? contract.ResourceRuntimeRequirementStatus.INCOMPATIBLE
          : contract.ResourceRuntimeRequirementStatus.UNKNOWN
    })),
    warnings: item.warnings.map(protoResourcePackageWarning),
    disabledLifecycleScripts: [...item.disabledLifecycleScripts],
    canToggle: item.canToggle,
    requiresExtensionApproval: item.requiresExtensionApproval,
    extensionContentFingerprint: item.extensionContentFingerprint ?? "",
    postMutationNotice: item.postMutationNotice
  });
}

function nativeResourceKind(value: contract.ResourceKind): NativePiResourceKind {
  switch (value) {
    case contract.ResourceKind.EXTENSION: return "extension";
    case contract.ResourceKind.SKILL: return "skill";
    case contract.ResourceKind.PROMPT_TEMPLATE: return "prompt";
    case contract.ResourceKind.PACKAGE: return "package";
    case contract.ResourceKind.THEME: return "theme";
    case contract.ResourceKind.UNSPECIFIED: throw invalidArgument("resource.kind is required");
  }
}

function protoResourceKind(value: NativePiResourceKind): contract.ResourceKind {
  switch (value) {
    case "extension": return contract.ResourceKind.EXTENSION;
    case "skill": return contract.ResourceKind.SKILL;
    case "prompt": return contract.ResourceKind.PROMPT_TEMPLATE;
    case "package": return contract.ResourceKind.PACKAGE;
    case "theme": return contract.ResourceKind.THEME;
  }
}

function protoResourceCompatibility(
  value: NativePiResourceDescriptor["resourceDetails"][number]["compatibility"]
): contract.ResourceCompatibility {
  switch (value) {
    case "supported": return contract.ResourceCompatibility.SUPPORTED;
    case "partial": return contract.ResourceCompatibility.PARTIAL;
    case "unsupported": return contract.ResourceCompatibility.UNSUPPORTED;
    case "unknown": return contract.ResourceCompatibility.UNKNOWN;
  }
}

function protoResourceCompatibilityIssue(
  value: NativePiResourceDescriptor["resourceDetails"][number]["compatibilityIssues"][number]
): contract.ResourceCompatibilityIssue {
  switch (value) {
    case "working-indicator": return contract.ResourceCompatibilityIssue.WORKING_INDICATOR;
    case "widget-component": return contract.ResourceCompatibilityIssue.WIDGET_COMPONENT;
    case "editor-integration": return contract.ResourceCompatibilityIssue.EDITOR_INTEGRATION;
    case "tui-layout": return contract.ResourceCompatibilityIssue.TUI_LAYOUT;
    case "custom-ui": return contract.ResourceCompatibilityIssue.CUSTOM_UI;
    case "theme-control": return contract.ResourceCompatibilityIssue.THEME_CONTROL;
    case "terminal-input": return contract.ResourceCompatibilityIssue.TERMINAL_INPUT;
    case "tui-rendering": return contract.ResourceCompatibilityIssue.TUI_RENDERING;
    case "cli-flags": return contract.ResourceCompatibilityIssue.CLI_FLAGS;
    case "analysis-incomplete": return contract.ResourceCompatibilityIssue.ANALYSIS_INCOMPLETE;
  }
}

function protoResourceUiApi(
  value: NativePiResourceDescriptor["resourceDetails"][number]["detectedApis"][number]
): contract.ResourceUiApi {
  switch (value) {
    case "select": return contract.ResourceUiApi.SELECT;
    case "confirm": return contract.ResourceUiApi.CONFIRM;
    case "input": return contract.ResourceUiApi.INPUT;
    case "editor": return contract.ResourceUiApi.EDITOR;
    case "notify": return contract.ResourceUiApi.NOTIFY;
    case "setStatus": return contract.ResourceUiApi.SET_STATUS;
    case "setWorkingMessage": return contract.ResourceUiApi.SET_WORKING_MESSAGE;
    case "setWorkingVisible": return contract.ResourceUiApi.SET_WORKING_VISIBLE;
    case "setWorkingIndicator": return contract.ResourceUiApi.SET_WORKING_INDICATOR;
    case "setHiddenThinkingLabel": return contract.ResourceUiApi.SET_HIDDEN_THINKING_LABEL;
    case "setWidget": return contract.ResourceUiApi.SET_WIDGET;
    case "setTitle": return contract.ResourceUiApi.SET_TITLE;
    case "setEditorText": return contract.ResourceUiApi.SET_EDITOR_TEXT;
    case "getEditorText": return contract.ResourceUiApi.GET_EDITOR_TEXT;
    case "pasteToEditor": return contract.ResourceUiApi.PASTE_TO_EDITOR;
    case "getEditorComponent": return contract.ResourceUiApi.GET_EDITOR_COMPONENT;
    case "addAutocompleteProvider": return contract.ResourceUiApi.ADD_AUTOCOMPLETE_PROVIDER;
    case "setEditorComponent": return contract.ResourceUiApi.SET_EDITOR_COMPONENT;
    case "setFooter": return contract.ResourceUiApi.SET_FOOTER;
    case "setHeader": return contract.ResourceUiApi.SET_HEADER;
    case "setToolsExpanded": return contract.ResourceUiApi.SET_TOOLS_EXPANDED;
    case "getToolsExpanded": return contract.ResourceUiApi.GET_TOOLS_EXPANDED;
    case "custom": return contract.ResourceUiApi.CUSTOM;
    case "getAllThemes": return contract.ResourceUiApi.GET_ALL_THEMES;
    case "getTheme": return contract.ResourceUiApi.GET_THEME;
    case "setTheme": return contract.ResourceUiApi.SET_THEME;
    case "theme": return contract.ResourceUiApi.THEME;
    case "onTerminalInput": return contract.ResourceUiApi.ON_TERMINAL_INPUT;
    case "registerShortcut": return contract.ResourceUiApi.REGISTER_SHORTCUT;
    case "registerFlag": return contract.ResourceUiApi.REGISTER_FLAG;
    case "registerMessageRenderer": return contract.ResourceUiApi.REGISTER_MESSAGE_RENDERER;
    case "registerMarkdownTransformer": return contract.ResourceUiApi.REGISTER_MARKDOWN_TRANSFORMER;
    case "registerEntryRenderer": return contract.ResourceUiApi.REGISTER_ENTRY_RENDERER;
  }
}

function protoResourcePackageWarning(
  value: NativePiResourceDescriptor["warnings"][number]
): contract.ResourcePackageWarning {
  switch (value) {
    case "no-resources": return contract.ResourcePackageWarning.NO_RESOURCES;
    case "inspection-failed": return contract.ResourcePackageWarning.INSPECTION_FAILED;
    case "inspection-limit": return contract.ResourcePackageWarning.INSPECTION_LIMIT;
    case "lifecycle-scripts-disabled": return contract.ResourcePackageWarning.LIFECYCLE_SCRIPTS_DISABLED;
  }
}

function nativeResourceState(value: contract.ResourceState): NativePiResourceState {
  switch (value) {
    case contract.ResourceState.DISCOVERED: return "discovered";
    case contract.ResourceState.AWAITING_APPROVAL: return "awaiting_approval";
    case contract.ResourceState.APPROVED: return "approved";
    case contract.ResourceState.INSTALLING: return "installing";
    case contract.ResourceState.INSTALLED: return "installed";
    case contract.ResourceState.LOADED: return "loaded";
    case contract.ResourceState.DISABLED: return "disabled";
    case contract.ResourceState.UPDATE_AVAILABLE: return "update_available";
    case contract.ResourceState.ERROR: return "error";
    case contract.ResourceState.REMOVED: return "removed";
    case contract.ResourceState.UNSPECIFIED: throw invalidArgument("resource.state is required");
  }
}

function protoResourceState(value: NativePiResourceState): contract.ResourceState {
  switch (value) {
    case "discovered": return contract.ResourceState.DISCOVERED;
    case "awaiting_approval": return contract.ResourceState.AWAITING_APPROVAL;
    case "approved": return contract.ResourceState.APPROVED;
    case "installing": return contract.ResourceState.INSTALLING;
    case "installed": return contract.ResourceState.INSTALLED;
    case "loaded": return contract.ResourceState.LOADED;
    case "disabled": return contract.ResourceState.DISABLED;
    case "update_available": return contract.ResourceState.UPDATE_AVAILABLE;
    case "error": return contract.ResourceState.ERROR;
    case "removed": return contract.ResourceState.REMOVED;
  }
}

function protoResourceScope(value: NativePiResourceDescriptor["scope"]): contract.ResourceScope {
  switch (value) {
    case "user": return contract.ResourceScope.USER;
    case "global": return contract.ResourceScope.GLOBAL;
    case "project": return contract.ResourceScope.PROJECT;
    case "managed": return contract.ResourceScope.MANAGED;
  }
}

function nativeResourceScope(value: contract.ResourceScope): NativePiResourceDescriptor["scope"] {
  switch (value) {
    case contract.ResourceScope.USER: return "user";
    case contract.ResourceScope.GLOBAL: return "global";
    case contract.ResourceScope.PROJECT: return "project";
    case contract.ResourceScope.MANAGED: return "managed";
    case contract.ResourceScope.UNSPECIFIED: throw invalidArgument("resource.scope is required");
  }
}

function nativeDiagnosticLevel(value: contract.DiagnosticLevel): "minimal" | "standard" | "verbose" {
  switch (value) {
    case contract.DiagnosticLevel.ERRORS: return "minimal";
    case contract.DiagnosticLevel.VERBOSE: return "verbose";
    case contract.DiagnosticLevel.STANDARD:
    case contract.DiagnosticLevel.UNSPECIFIED:
      return "standard";
  }
}

function settingsSnapshot(dependencies: ConnectServiceDependencies): contract.SettingsSnapshot {
  reserveAllProviderCredentialSurfaces(dependencies);
  const health = dependencies.store.health();
  const read = <T>(key: string): T | undefined => dependencies.store.findSetting<T>("service", "orchestrator", key)?.value;
  const appearance = read<contract.AppearanceSettings>("settings.appearance");
  const policy = read<contract.PolicySettings>("settings.policy");
  const diagnostics = read<contract.DiagnosticSettings>("settings.diagnostics");
  const silentEncryptedRetry = read<{ readonly enabled?: boolean }>(SILENT_ENCRYPTED_RETRY_SETTING_KEY);
  const messageSearchStatus = dependencies.messageSearch?.status() ?? dependencies.store.messageEmbeddingStatus();
  const messageSearchOverride = read<{ readonly semanticIndexEnabled?: boolean }>("settings.message_search");
  const configuredMessageSearch = dependencies.messageSearch?.configuredEnabled?.()
    ?? messageSearchOverride?.semanticIndexEnabled
    ?? true;
  const visionBridge = dependencies.visionBridge?.state() ?? {
    enabled: false,
    targetModels: [],
    primary: null,
    fallback: null,
    available: false,
    unavailableReason: "Vision Bridge is unavailable on this Orchestrator node.",
    customizedFields: []
  };
  const promptRecommendationOverride = normalizePromptRecommendationSettings(read<unknown>("settings.prompt_recommendation"));
  const promptRecommendation = dependencies.promptPrediction?.state() ?? {
    enabled: promptRecommendationOverride.enabled ?? true,
    available: false,
    unavailableReason: "Prompt recommendation is unavailable on this Orchestrator node."
  };
  const governance = dependencies.runtimeGovernance?.snapshot();
  const agentResource = governance?.agentResource;
  const collaboration = governance?.collaboration;
  const gitSafetySetting = governance?.gitSafety;
  const gitSafetyStatus = dependencies.gitSafety?.status() ?? {
    pendingTurns: 0,
    trackedSessions: 0,
    trackedRepositories: 0,
    cleanupAvailable: false
  };
  const backendRecords = dependencies.store.listBackends();
  const memoryBackendRecords = backendRecords.filter((item) =>
    item.descriptor.capabilities.get("memory.compaction_digest")?.supported === true);
  const memoryBackendRoles: readonly MakerMemoryBackendRole[] = memoryBackendRecords.map((item) => ({
    backendId: item.descriptor.id,
    role: "compaction_digest"
  }));
  const memoryState = dependencies.makerMemory?.snapshot(memoryBackendRoles);
  const makerRuntimeSupported = backendRecords.some((item) =>
    item.descriptor.capabilities.get("memory.curated")?.supported === true);
  const makerSupport = dependencies.makerMemory === undefined
    ? contract.CapabilitySupport.NOT_IMPLEMENTED
    : makerRuntimeSupported
      ? contract.CapabilitySupport.SUPPORTED
      : contract.CapabilitySupport.UPSTREAM_MISSING;
  const makerReason = dependencies.makerMemory === undefined
    ? "Maker Memory is not configured on this Orchestrator node."
    : makerRuntimeSupported
      ? ""
      : "No available Backend advertises memory.curated.";
  return create(contract.SettingsSnapshotSchema, {
    appearance: appearance ?? create(contract.AppearanceSettingsSchema, {
      locale: "en",
      theme: contract.ThemePreference.SYSTEM,
      reducedMotion: false,
      highContrast: false,
      showThinking: true
    }),
    connectionProfiles: dependencies.store.listConnections().map((item) => create(contract.ConnectionProfileSettingsSchema, {
      connectionProfileId: item.id,
      displayName: item.name,
      serverOrigin: dependencies.server?.publicOrigin ?? "",
      reconnectAutomatically: true,
      desktopNotifications: false,
      lastConnectedAt: item.lastSeenAt === undefined ? undefined : toProtoTimestamp(item.lastSeenAt)
    })),
    backends: dependencies.store.listBackends().map((item) => {
      const configured = read<contract.BackendSettingsPatch>(`settings.backend.${item.descriptor.id}`);
      return create(contract.BackendSettingsSchema, {
        backendId: item.descriptor.id,
        defaultModel: configured?.defaultModel,
        defaultPermissionMode: configured?.defaultPermissionMode ?? contract.PermissionMode.ASK,
        defaultPlanMode: configured?.defaultPlanMode ?? false,
        enabled: configured?.enabled ?? backendInstallationAvailable(item.descriptor.installationState),
        modelAccess: readBackendModelAccess(dependencies.store, item.descriptor.id)
      });
    }),
    providers: dependencies.providers?.list().map(mapProviderConfiguration) ?? [],
    credentials: dependencies.credentials?.list().map(mapCredentialDescriptor) ?? [],
    mcpServers: dependencies.mcpRouter?.list().map(mapMcpServerDescriptor) ?? [],
    browsers: [dependencies.browserProvider === undefined
      ? create(contract.BrowserSettingsSchema, {
          browserProviderId: BROWSER_PROVIDER_ID,
          profileDisplayName: "Joko",
          takeoverTimeout: toProtoDuration(15 * 60_000),
          allowUploads: true,
          allowDownloads: true,
          automationTarget: contract.BrowserAutomationTarget.EXTERNAL,
          support: contract.CapabilitySupport.UPSTREAM_MISSING,
          supportReason: "No compatible local browser was detected on this Orchestrator node.",
          detectedBrowser: "",
          targetSettings: dependencies.store.listTargets().map((target) => create(contract.BrowserTargetSettingsSchema, {
            targetId: target.descriptor.id,
            enabled: false,
            version: toProtoEntityVersion(target.revision, 0, target.updatedAt)
          })),
          backendHealth: create(contract.BrowserBackendHealthSchema, {
            active: false,
            status: contract.BrowserBackendStatus.UNAVAILABLE,
            canRecover: false,
            reason: contract.BrowserBackendFailureReason.HOST_UNAVAILABLE
          }),
          version: toProtoEntityVersion(health.revision, 0, Date.now())
        })
      : dependencies.browserSettings?.snapshot() ?? create(contract.BrowserSettingsSchema, {
          browserProviderId: BROWSER_PROVIDER_ID,
          profileDisplayName: "Joko",
          takeoverTimeout: toProtoDuration(15 * 60_000),
          allowUploads: true,
          allowDownloads: true,
          automationTarget: contract.BrowserAutomationTarget.EXTERNAL,
          support: contract.CapabilitySupport.SUPPORTED,
          supportReason: "",
          detectedBrowser: "",
          targetSettings: dependencies.store.listTargets().map((target) => create(contract.BrowserTargetSettingsSchema, {
            targetId: target.descriptor.id,
            enabled: true,
            version: toProtoEntityVersion(target.revision, 0, target.updatedAt)
          })),
          backendHealth: create(contract.BrowserBackendHealthSchema, {
            active: dependencies.browserProvider.running,
            status: dependencies.browserProvider.running ? contract.BrowserBackendStatus.READY : contract.BrowserBackendStatus.DISCONNECTED,
            canRecover: true,
            reason: contract.BrowserBackendFailureReason.UNSPECIFIED
          }),
          version: toProtoEntityVersion(health.revision, dependencies.browserProvider.generation, Date.now())
        })],
    computerAutomation: dependencies.computerAutomation?.snapshot() ?? create(contract.ComputerAutomationSettingsSchema, {
      enabled: false,
      support: contract.CapabilitySupport.NOT_IMPLEMENTED,
      supportReason: "Computer automation is not configured on this Orchestrator node.",
      installed: false,
      driverVersion: "",
      daemonRunning: false,
      accessibilityPermission: contract.AutomationPermissionState.UNKNOWN,
      screenRecordingPermission: contract.AutomationPermissionState.UNKNOWN,
      screenRecordingCapturable: false,
      ready: false,
      runtimeState: contract.ComputerAutomationRuntimeState.UNAVAILABLE,
      failureReason: "",
      platform: process.platform,
      updateCurrentVersion: "",
      updateLatestVersion: "",
      updateAvailable: false,
      updateInProgress: false,
      updatePhase: contract.ComputerAutomationUpdatePhase.UNSPECIFIED,
      version: toProtoEntityVersion(health.revision, 0, Date.now())
    }),
    androidAutomation: dependencies.androidAutomation?.snapshot() ?? create(contract.AndroidAutomationSettingsSchema, {
      enabled: false,
      support: contract.CapabilitySupport.NOT_IMPLEMENTED,
      supportReason: "Android automation is not configured on this Orchestrator node.",
      adbAvailable: false,
      adbPath: "",
      adbPathSource: contract.AndroidAdbPathSource.UNSPECIFIED,
      preparationSupported: false,
      preparationReady: false,
      preparationError: "",
      adbVersion: "",
      devices: [],
      defaultDeviceSerial: "",
      configuredDefaultDeviceSerial: "",
      adbPathOverride: "",
      issue: contract.AndroidAutomationIssue.ADB_NOT_FOUND,
      failureReason: "",
      platform: process.platform,
      runtimeState: contract.AndroidAutomationRuntimeState.UNAVAILABLE,
      statusObserved: false,
      version: toProtoEntityVersion(health.revision, 0, Date.now())
    }),
    languageTools: create(contract.LanguageToolSettingsSchema, {
      enabled: languageToolsEnabled(read<unknown>(LANGUAGE_TOOL_SETTING_KEY))
    }),
    toolPolicies: [...(dependencies.toolPolicies?.snapshot(appearance?.locale || "en") ?? [])],
    agentResource: create(contract.AgentResourceSettingsSchema, {
      maxConcurrentCommands: agentResource?.value.maxConcurrentCommands
        ?? DEFAULT_AGENT_RESOURCE_SETTINGS.maxConcurrentCommands,
      processPriority: toProtoManagedProcessPriority(
        agentResource?.value.processPriority ?? DEFAULT_AGENT_RESOURCE_SETTINGS.processPriority
      ),
      capToolchainThreads: agentResource?.value.capToolchainThreads
        ?? DEFAULT_AGENT_RESOURCE_SETTINGS.capToolchainThreads,
      customized: agentResource === undefined ? false : !sameAgentResourceSettings(
        agentResource.value,
        DEFAULT_AGENT_RESOURCE_SETTINGS
      ),
      version: toProtoEntityVersion(
        agentResource?.revision ?? health.revision,
        0,
        agentResource?.updatedAt ?? Date.now()
      )
    }),
    collaboration: create(contract.CollaborationSettingsSchema, {
      workerSoftLimit: collaboration?.value.workerSoftLimit
        ?? DEFAULT_COLLABORATION_SETTINGS.workerSoftLimit,
      workerHardLimit: collaboration?.value.workerHardLimit
        ?? DEFAULT_COLLABORATION_SETTINGS.workerHardLimit,
      workerIdleReleaseMinutes: collaboration?.value.workerIdleReleaseMinutes
        ?? DEFAULT_COLLABORATION_SETTINGS.workerIdleReleaseMinutes,
      customized: collaboration === undefined ? false : !sameCollaborationSettings(
        collaboration.value,
        DEFAULT_COLLABORATION_SETTINGS
      ),
      version: toProtoEntityVersion(
        collaboration?.revision ?? health.revision,
        0,
        collaboration?.updatedAt ?? Date.now()
      )
    }),
    gitSafety: create(contract.GitSafetySettingsSchema, {
      autoSnapshotEnabled: gitSafetySetting?.value.autoSnapshotEnabled
        ?? DEFAULT_GIT_SAFETY_SETTINGS.autoSnapshotEnabled,
      pendingTurns: gitSafetyStatus.pendingTurns,
      trackedSessions: gitSafetyStatus.trackedSessions,
      trackedRepositories: gitSafetyStatus.trackedRepositories,
      cleanupAvailable: gitSafetyStatus.cleanupAvailable,
      customized: gitSafetySetting === undefined ? false :
        gitSafetySetting.value.autoSnapshotEnabled !== DEFAULT_GIT_SAFETY_SETTINGS.autoSnapshotEnabled,
      version: toProtoEntityVersion(
        gitSafetySetting?.revision ?? health.revision,
        0,
        gitSafetySetting?.updatedAt ?? Date.now()
      )
    }),
    pi: dependencies.store.listBackends().filter((item) => dependencies.piBackendIds?.has(item.descriptor.id) === true).map((item) => {
      const configured = read<contract.PiSettingsPatch>(`settings.pi.${item.descriptor.id}`);
      const defaults = piProjectionDefaults(dependencies, item.descriptor.id);
      return create(contract.PiSettingsSchema, {
        backendId: item.descriptor.id,
        autoCompaction: configured?.autoCompaction ?? defaults.autoCompaction,
        autoCompactionThresholdPercent: configured?.autoCompactionThresholdPercent
          ?? defaults.autoCompactionThresholdPercent,
        autoCompactionThresholdCustomized: configured?.autoCompactionThresholdPercent !== undefined,
        autoRetry: configured?.autoRetry ?? defaults.autoRetry,
        steeringMode: configured?.steeringMode ?? toProtoPiQueueMode(defaults.steeringMode),
        followUpMode: configured?.followUpMode ?? toProtoPiQueueMode(defaults.followUpMode),
        resources: dependencies.piResources?.list({ backendId: item.descriptor.id }).map(mapManagedResource) ?? [],
        version: toProtoEntityVersion(item.revision, 0, item.updatedAt)
      });
    }),
    policy: policy ?? create(contract.PolicySettingsSchema, {
      defaultMode: contract.PermissionMode.ASK,
      rules: [],
      projectTrustRequired: true,
      redactCredentials: true,
      stripChildProcessCredentials: true,
      version: toProtoEntityVersion(health.revision, 0, Date.now())
    }),
    diagnostics: diagnostics ?? create(contract.DiagnosticSettingsSchema, {
      level: contract.DiagnosticLevel.STANDARD,
      retention: toProtoDuration(7 * 24 * 60 * 60_000),
      includeSanitizedBackendPayloads: false,
      includePerformanceMetrics: true
    }),
    messageSearch: create(contract.MessageSearchSettingsSchema, {
      semanticIndexEnabled: configuredMessageSearch,
      vectorAvailable: messageSearchStatus.vectorAvailable,
      modelId: messageSearchStatus.modelId,
      pendingCount: BigInt(messageSearchStatus.pendingCount),
      runningCount: BigInt(messageSearchStatus.runningCount),
      doneCount: BigInt(messageSearchStatus.doneCount),
      failedCount: BigInt(messageSearchStatus.failedCount),
      embeddingProviderAvailable: dependencies.providers !== undefined &&
        typeof dependencies.providers.resolveOpenAiEmbeddingRoute === "function" &&
        dependencies.providers.resolveOpenAiEmbeddingRoute(
          MESSAGE_SEARCH_EMBEDDING_MODEL_ID,
          messageSearchStatus.providerId
        ) !== undefined,
      customized: messageSearchOverride?.semanticIndexEnabled !== undefined
    }),
    visionBridge: create(contract.VisionBridgeSettingsSchema, {
      enabled: visionBridge.enabled,
      targetModels: visionBridge.targetModels.map((target) => create(contract.ModelRouteRefSchema, {
        backendId: target.backendId,
        providerId: target.providerId,
        modelId: target.modelId
      })),
      primary: visionBridge.primary === null
        ? undefined
        : create(contract.ModelRouteRefSchema, {
            backendId: visionBridge.primary.backendId,
            providerId: visionBridge.primary.providerId,
            modelId: visionBridge.primary.modelId
          }),
      fallback: visionBridge.fallback === null
        ? undefined
        : create(contract.ModelRouteRefSchema, {
            backendId: visionBridge.fallback.backendId,
            providerId: visionBridge.fallback.providerId,
            modelId: visionBridge.fallback.modelId
          }),
      available: visionBridge.available,
      unavailableReason: visionBridge.unavailableReason,
      customized: visionBridge.customizedFields.length > 0,
      customizedFields: [...visionBridge.customizedFields]
    }),
    promptRecommendation: create(contract.PromptRecommendationSettingsSchema, {
      enabled: promptRecommendation.enabled,
      available: promptRecommendation.available,
      unavailableReason: promptRecommendation.unavailableReason,
      customized: promptRecommendationOverride.enabled !== undefined
    }),
    personalization: create(contract.PersonalizationSettingsSchema, {
      silentEncryptedRetryEnabled: typeof silentEncryptedRetry?.enabled === "boolean"
        ? silentEncryptedRetry.enabled
        : SILENT_ENCRYPTED_RETRY_DEFAULT_ENABLED,
      silentEncryptedRetryCustomized: typeof silentEncryptedRetry?.enabled === "boolean",
      sessionRuntimeFallbackEnabled: configuredSessionRuntimeFallback(dependencies.store),
      sessionRuntimeFallbackCustomized: sessionRuntimeFallbackCustomized(dependencies.store)
    }),
    memory: create(contract.MemorySettingsSchema, {
      makerEnabled: memoryState?.makerEnabled ?? false,
      makerSupport,
      makerReason,
      customized: memoryState?.customized ?? false,
      entryCount: BigInt(memoryState?.entryCount ?? 0),
      backends: memoryBackendRecords.map((item) => create(contract.BackendMemorySettingsSchema, {
        backendId: item.descriptor.id,
        enabled: memoryState?.backendEnabled[item.descriptor.id] ?? false,
        support: dependencies.makerMemory === undefined
          ? contract.CapabilitySupport.TEMPORARILY_UNAVAILABLE
          : contract.CapabilitySupport.SUPPORTED,
        reason: dependencies.makerMemory === undefined
          ? "Memory storage is unavailable on this Orchestrator node."
          : "",
        entryCount: BigInt(memoryState?.backendEntryCount[item.descriptor.id] ?? 0)
      }))
    }),
    voiceInput: dependencies.voiceInputSettings?.snapshot(),
    revision: toProtoRevision(health.revision)
  });
}

/**
 * SnapshotProjector deliberately owns only durable Store state.  This join is
 * the single API boundary where independently-owned provisioning and Tool
 * Provider projections are captured for a client snapshot.  No native Pi
 * context is reconstructed here and no volatile Browser handle is persisted.
 */
function providerDescriptorKey(backendId: string, providerId: string): string {
  return `${backendId}\u0000${providerId}`;
}

function modelDescriptorKey(backendId: string, providerId: string, modelId: string): string {
  return `${providerDescriptorKey(backendId, providerId)}\u0000${modelId}`;
}

async function enrichSnapshot(
  dependencies: ConnectServiceDependencies,
  projected: contract.Snapshot,
  scope: contract.SnapshotScope,
  at: number,
  signal?: AbortSignal
): Promise<contract.Snapshot> {
  const scopeCase = scope.kind.case;
  const owner = scopeCase === "owner";
  const toolScopeId = scopeCase === "tool" ? scope.kind.value.toolProviderId : undefined;

  const providerRecords = dependencies.providers?.list();
  const backendRecords = new Map(dependencies.store.listBackends().map((record) => [
    record.descriptor.id,
    record
  ] as const));
  const projectedModelMap = new Map(projected.models.map((model, index) => [
    model.key === undefined
      ? `projected\u0000${index}`
      : modelDescriptorKey(model.backendId, model.key.providerId, model.key.modelId),
    model
  ] as const));
  if (owner) {
    for (const backend of projected.backends) {
      const record = backendRecords.get(backend.backendId);
      if (record === undefined || !managedProviderCatalogApplies(dependencies, backend.backendId)) continue;
      for (const model of backendCatalogModels(dependencies, record.descriptor)) {
        projectedModelMap.set(
          modelDescriptorKey(backend.backendId, model.providerId, model.modelId),
          toProtoModelDescriptor(backend.backendId, model)
        );
      }
    }
  }
  const projectedModels = [...projectedModelMap.values()];
  const visibleProviderKeys = new Set(projectedModels.flatMap((model) => model.key === undefined
    ? []
    : [providerDescriptorKey(model.backendId, model.key.providerId)]));
  const authoritativeProviderMap = new Map(projected.providers.map((provider) => [
    providerDescriptorKey(provider.backendId, provider.providerId),
    provider
  ] as const));
  await Promise.all([...authoritativeProviderMap].map(async ([key, provider]) => {
    const record = backendRecords.get(provider.backendId);
    if (record === undefined || managedProviderCatalogApplies(dependencies, provider.backendId)) return;
    authoritativeProviderMap.set(key, await backendProviderDescriptorWithAccountUsage(
      dependencies,
      record.descriptor,
      provider.providerId,
      record.revision,
      provider,
      signal
    ));
  }));
  if (providerRecords !== undefined) {
    for (const backendId of managedProviderBackendIds(dependencies)) {
      for (const provider of providerRecords) {
        const key = providerDescriptorKey(backendId, provider.provider.id);
        if (!owner && !visibleProviderKeys.has(key)) continue;
        authoritativeProviderMap.set(key, mapProviderDescriptor(
          backendId,
          provider,
          providerUsageSummary(dependencies, provider.provider.id, backendId),
          providerRateLimit(dependencies, backendId, provider.provider.id),
          peekProviderAccountUsageSnapshot(dependencies, provider)
        ));
      }
    }
  }
  const authoritativeProviders = [...authoritativeProviderMap.values()];
  const authentication = new Map(authoritativeProviders.map((provider) => [
    providerDescriptorKey(provider.backendId, provider.providerId),
    provider.authenticationState
  ] as const));
  const models = projectedModels.map((model) => {
    const providerId = model.key?.providerId;
    const state = providerId === undefined
      ? undefined
      : authentication.get(providerDescriptorKey(model.backendId, providerId));
    const available = state === undefined
      ? model.available
      : state === contract.AuthenticationState.AUTHENTICATED || state === contract.AuthenticationState.NOT_REQUIRED;
    return create(contract.ModelDescriptorSchema, { ...model, available });
  });

  const allToolProviders = toolProviders(dependencies);
  const visibleToolProviders = owner
    ? allToolProviders
    : toolScopeId === undefined
      ? allToolProviders.filter((provider) => scopeCase === "backend" && provider.toolProviderId === `backend:${scope.kind.value.backendId}`)
      : allToolProviders.filter((provider) => provider.toolProviderId === toolScopeId);
  const mcpServers = owner
    ? dependencies.mcpRouter?.list().map(mapMcpServerDescriptor) ?? []
    : toolScopeId?.startsWith("mcp:") === true
      ? dependencies.mcpRouter?.list().filter((server) => `mcp:${server.id}` === toolScopeId).map(mapMcpServerDescriptor) ?? []
      : [];
  const includeBrowser = dependencies.browserProvider !== undefined && (owner || toolScopeId === BROWSER_PROVIDER_ID);
  const browsers = includeBrowser
    ? [await mapBrowserProvider(dependencies.browserProvider!, at, dependencies.browserState, dependencies.browserSettings)]
    : [];
  const browserTransfers = includeBrowser ? [...(dependencies.browserTransfers?.list({}) ?? [])] : [];
  const resources = dependencies.piResources?.list(resourceFilterForScope(dependencies, scope)).map(mapManagedResource) ?? projected.resources;
  const sessions = projected.sessions;
  const pi = await durablePiSnapshot(
    dependencies,
    create(contract.SnapshotSchema, { ...projected, sessions }),
    resources,
    at
  );

  return create(contract.SnapshotSchema, {
    ...projected,
    devices: owner
      ? dependencies.store.listDevices().map((device) => deviceFromRecord(
          device,
          dependencies.store.listDeviceConnections(device.id),
          at
        ))
      : projected.devices,
    deviceControlRelations: owner
      ? dependencies.store.listDeviceControlRelations().map((relation) =>
          deviceControlRelationFromRecord(dependencies.store, relation, at))
      : projected.deviceControlRelations,
    queueControls: projected.sessions.map((session) => mapQueueControl(dependencies.store, session.sessionId)),
    sessions,
    providers: authoritativeProviders,
    models,
    toolProviders: visibleToolProviders,
    mcpServers,
    browsers,
    resources,
    settings: owner ? settingsSnapshot(dependencies) : projected.settings,
    browserTransfers,
    pi
  });
}

async function durablePiSnapshot(
  dependencies: ConnectServiceDependencies,
  projected: contract.Snapshot,
  resources: readonly contract.ManagedResource[],
  at: number
): Promise<contract.PiSnapshot | undefined> {
  const backendIds = dependencies.piBackendIds ?? new Set<string>();
  const sessions = projected.sessions
    .filter((session) => backendIds.has(session.backendId))
    .map((session) => durablePiSessionSnapshot(dependencies, session));
  const targets = projected.targets.filter((target) => backendIds.has(target.backendId));
  if (sessions.length === 0 && targets.length === 0 && resources.every((resource) => !backendIds.has(resource.backendId))) {
    return undefined;
  }
  const candidateGroups = await Promise.all(targets.map(async (target) => {
    const candidates = await (dependencies.sessionHost as ExtendedSessionHost).listNativeSessions(target.targetId).catch(() => []);
    const workspaceRoot = dependencies.store.getTarget(target.targetId).descriptor.workspaceRoot;
    return candidates.map((candidate) => {
      const bound = dependencies.store.findLiveSessionByNativeBinding(target.backendId, candidate.nativeReference);
      return create(contract.PiNativeSessionCandidateSchema, {
        nativeSessionId: candidate.nativeSessionId ?? "",
        nativeReference: candidate.nativeReference,
        name: candidate.name ?? "",
        workspaceRoot,
        messageCount: BigInt(candidate.messageCount),
        modifiedAt: toProtoTimestamp(normalizeNativeTimestamp(candidate.modifiedAt, at)),
        state: candidate.state === "ready"
          ? contract.PiNativeSessionCandidateState.READY
          : contract.PiNativeSessionCandidateState.ERROR,
        ...(bound === undefined ? {} : { boundSessionId: bound.descriptor.id })
      });
    });
  }));
  return create(contract.PiSnapshotSchema, {
    sessions,
    resources: resources.filter((resource) => backendIds.has(resource.backendId)),
    nativeSessions: candidateGroups.flat(),
    revision: projected.revision,
    capturedAt: toProtoTimestamp(at)
  });
}

function durablePiSessionSnapshot(
  dependencies: ConnectServiceDependencies,
  projected: contract.Session
): contract.PiSessionSnapshot {
  const stored = dependencies.store.getSession(projected.sessionId);
  const binding = stored.descriptor.binding;
  let marker: PersistedEvent | undefined;
  const nativeEventCandidates: PersistedEvent[] = [];
  visitSessionEvents(dependencies.store, projected.sessionId, (event) => {
    if (event.generation !== binding.generation) return;
    if (event.payload.type === "native_session_changed") marker = event;
    if (event.pi?.entryId !== undefined && event.metadata?.namespace === "pi.native_history") {
      nativeEventCandidates.push(event);
    }
  });
  const nativeReference = marker?.payload.type === "native_session_changed"
    ? marker.payload.opaqueRef
    : binding.opaqueRef;
  const nativeEvents = nativeEventCandidates.filter((event) =>
    (event.metadata?.fields["nativeReference"] === undefined || event.metadata?.fields["nativeReference"] === nativeReference)
  );
  const confirmed = dependencies.store.getSession(projected.sessionId);
  const bindingStable = confirmed.descriptor.binding.generation === binding.generation &&
    confirmed.descriptor.binding.opaqueRef === binding.opaqueRef;
  const projectedBindingCurrent = projected.nativeBinding?.runtimeGeneration === BigInt(binding.generation) &&
    projected.nativeBinding.opaqueReference === binding.opaqueRef;
  const historyComplete = bindingStable && projectedBindingCurrent &&
    marker?.payload.type === "native_session_changed" &&
    marker.payload.opaqueRef === binding.opaqueRef;
  const runtimeState = materializedSessionRuntimeState(dependencies.store.findSetting(
    "session",
    projected.sessionId,
    SESSION_RUNTIME_STATE_SETTING_KEY
  )?.value);
  const runtimeCommands = materializedRuntimeCommands(dependencies.store.findSetting(
    "session",
    projected.sessionId,
    SESSION_RUNTIME_COMMANDS_SETTING_KEY
  )?.value);
  const activeLeafId = runtimeState?.activeNativeEntryId ??
    (marker?.payload.type === "native_session_changed" ? marker.payload.leafId : undefined) ?? "";
  const messages = nativeEvents.map(durablePiMessage).filter((message): message is contract.PiNativeMessage => message !== undefined);
  const messagesByEntryId = new Map(messages.map((message) => [message.nativeEntryId, message] as const));
  const entries = nativeEvents.map((event) => durablePiEntry(event, messagesByEntryId.get(event.pi?.entryId ?? "")));
  const nativeObservation = materializedNativeStateObservation(dependencies.store.findSetting(
    "session",
    projected.sessionId,
    SESSION_NATIVE_STATE_OBSERVATION_SETTING_KEY
  )?.value);
  const projectedState = projectDurablePiState(nativeObservation, {
    generation: stored.descriptor.binding.generation,
    opaqueRef: stored.descriptor.binding.opaqueRef
  });
  const sessionState = projectedState.state;
  const durableTree = contract.piSessionTreeWireFields(durablePiTree(nativeEvents, activeLeafId));
  return create(contract.PiSessionSnapshotSchema, {
    backendId: stored.descriptor.backendId,
    targetId: stored.descriptor.targetId,
    productSessionId: stored.descriptor.id,
    ...(sessionState === undefined ? {} : { sessionState }),
    sessionTree: create(contract.PiSessionTreeUpdateSchema, {
      nativeSessionId: sessionState?.nativeSessionId ?? stored.descriptor.binding.nativeSessionId ?? "",
      activeLeafId,
      ...durableTree
    }),
    messages,
    entries,
    forkCandidates: messages.map((message) => create(contract.PiForkCandidateSchema, {
      entryId: message.nativeEntryId,
      text: piMessagePreview(message)
    })),
    commands: runtimeCommands?.commands.map(mapPiCommand) ?? [],
    activeLeafId,
    messagesComplete: historyComplete,
    entriesComplete: historyComplete,
    revision: toProtoRevision(stored.revision),
    observation: projectedState.observation
  });
}

function toProtoManagedProcessPriority(value: ManagedProcessPriority): contract.ManagedProcessPriority {
  if (value === "low") return contract.ManagedProcessPriority.LOW;
  if (value === "lowest") return contract.ManagedProcessPriority.LOWEST;
  return contract.ManagedProcessPriority.NORMAL;
}

function nativeManagedProcessPriority(value: contract.ManagedProcessPriority): ManagedProcessPriority {
  if (value === contract.ManagedProcessPriority.LOW) return "low";
  if (value === contract.ManagedProcessPriority.LOWEST) return "lowest";
  if (value === contract.ManagedProcessPriority.NORMAL) return "normal";
  throw invalidArgument("patch.process_priority is required");
}

function sameAgentResourceSettings(
  left: typeof DEFAULT_AGENT_RESOURCE_SETTINGS,
  right: typeof DEFAULT_AGENT_RESOURCE_SETTINGS
): boolean {
  return left.maxConcurrentCommands === right.maxConcurrentCommands
    && left.processPriority === right.processPriority
    && left.capToolchainThreads === right.capToolchainThreads;
}

function sameCollaborationSettings(
  left: typeof DEFAULT_COLLABORATION_SETTINGS,
  right: typeof DEFAULT_COLLABORATION_SETTINGS
): boolean {
  return left.workerSoftLimit === right.workerSoftLimit
    && left.workerHardLimit === right.workerHardLimit
    && left.workerIdleReleaseMinutes === right.workerIdleReleaseMinutes;
}

function nativeMessageSearchSemanticMode(
  value: contract.SessionMessageSearchSemanticMode
): MessageSearchSemanticMode {
  switch (value) {
    case contract.SessionMessageSearchSemanticMode.KEYWORD: return "keyword";
    case contract.SessionMessageSearchSemanticMode.HYBRID:
    case contract.SessionMessageSearchSemanticMode.UNSPECIFIED:
    case undefined:
      return "hybrid";
    default:
      throw invalidArgument("semantic_mode is not recognized");
  }
}

function nativeSessionMessageSearchFilters(
  value: contract.SessionMessageSearchFilters | undefined
): {
  readonly targetIds?: readonly string[];
  readonly sessionIds?: readonly string[];
  readonly backendIds?: readonly string[];
  readonly sessionStatus?: "active" | "archived";
  readonly sessionActivityFrom?: number;
  readonly messageCreatedFrom?: number;
  readonly messageCreatedBefore?: number;
} | undefined {
  if (value === undefined) return undefined;
  const sessionStatus = (() => {
    switch (value.sessionStatus) {
      case contract.SessionMessageSearchSessionStatus.UNSPECIFIED:
      case undefined:
        return undefined;
      case contract.SessionMessageSearchSessionStatus.ACTIVE:
        return "active" as const;
      case contract.SessionMessageSearchSessionStatus.ARCHIVED:
        return "archived" as const;
      default:
        throw invalidArgument("filters.session_status is not recognized");
    }
  })();
  const sessionActivityFrom = fromProtoTimestamp(
    value.sessionActivityFrom,
    "filters.session_activity_from"
  );
  const messageCreatedFrom = fromProtoTimestamp(
    value.messageCreatedFrom,
    "filters.message_created_from"
  );
  const messageCreatedBefore = fromProtoTimestamp(
    value.messageCreatedBefore,
    "filters.message_created_before"
  );
  return {
    ...(value.targetIds === undefined ? {} : { targetIds: value.targetIds.values }),
    ...(value.sessionIds === undefined ? {} : { sessionIds: value.sessionIds.values }),
    ...(value.backendIds === undefined ? {} : { backendIds: value.backendIds.values }),
    ...(sessionStatus === undefined ? {} : { sessionStatus }),
    ...(sessionActivityFrom === undefined ? {} : { sessionActivityFrom }),
    ...(messageCreatedFrom === undefined ? {} : { messageCreatedFrom }),
    ...(messageCreatedBefore === undefined ? {} : { messageCreatedBefore })
  };
}

function durablePiMessage(event: PersistedEvent): contract.PiNativeMessage | undefined {
  const entryId = event.pi?.entryId;
  if (entryId === undefined) return undefined;
  let role: contract.PiMessageRole;
  let parts: contract.PiMessagePart[];
  if (event.payload.type === "message_complete") {
    role = event.payload.role === "user" ? contract.PiMessageRole.USER : contract.PiMessageRole.ASSISTANT;
    parts = event.payload.blocks.map((block): contract.PiMessagePart => {
      switch (block.kind) {
        case "text":
          return create(contract.PiMessagePartSchema, { content: { case: "text", value: block.text } });
        case "thinking":
          return create(contract.PiMessagePartSchema, {
            content: {
              case: "thinking",
              value: create(contract.PiThinkingContentSchema, { text: block.text, hidden: block.redacted })
            }
          });
        case "image":
          return create(contract.PiMessagePartSchema, {
            content: {
              case: "image",
              value: create(contract.ImageRefSchema, {
                blob: toProtoBlobRef(block.blob),
                widthPixels: 0,
                heightPixels: 0,
                altText: block.alt ?? ""
              })
            }
          });
        case "tool_call":
          return create(contract.PiMessagePartSchema, {
            content: {
              case: "toolCall",
              value: create(contract.PiToolCallContentSchema, {
                nativeToolCallId: block.callId,
                toolName: block.name,
                arguments: [create(contract.DisplayArgumentSchema, {
                  fieldPath: "input",
                  value: { case: "text", value: block.input },
                  redacted: false,
                  redactedPlaceholder: ""
                })]
              })
            }
          });
        case "artifact":
          return create(contract.PiMessagePartSchema, { content: { case: "text", value: `[artifact: ${block.label}]` } });
        case "tool_result":
          return create(contract.PiMessagePartSchema, { content: { case: "text", value: block.output } });
      }
    });
  } else if (event.payload.type === "tool_result") {
    role = contract.PiMessageRole.TOOL_RESULT;
    parts = [create(contract.PiMessagePartSchema, { content: { case: "text", value: event.payload.output } })];
  } else {
    return undefined;
  }
  return create(contract.PiNativeMessageSchema, {
    nativeMessageId: entryId,
    nativeEntryId: entryId,
    role,
    parts,
    createdAt: toProtoTimestamp(event.emittedAt)
  });
}

function durablePiEntry(event: PersistedEvent, message: contract.PiNativeMessage | undefined): contract.PiSessionEntry {
  const entryId = event.pi?.entryId ?? event.id;
  const nativeType = typeof event.metadata?.fields["nativeEntryType"] === "string"
    ? event.metadata.fields["nativeEntryType"]
    : event.pi?.rpcEventType ?? "custom";
  let payload: contract.PiSessionEntry["payload"];
  if (message !== undefined) {
    payload = { case: "message", value: message };
  } else if (nativeType.includes("model") && event.payload.type === "status") {
    const [providerId = "", modelId = ""] = (event.payload.text ?? "").split("/", 2);
    payload = {
      case: "modelChange",
      value: create(contract.PiModelChangeEntrySchema, {
        model: create(contract.ModelKeySchema, { providerId, modelId })
      })
    };
  } else if (nativeType.includes("thinking") && event.payload.type === "status") {
    payload = {
      case: "thinkingLevelChange",
      value: create(contract.PiThinkingLevelChangeEntrySchema, { thinkingLevel: event.payload.text ?? "" })
    };
  } else if (nativeType.includes("branch") && event.payload.type === "compaction") {
    payload = {
      case: "branchSummary",
      value: create(contract.PiBranchSummaryEntrySchema, {
        branchFromEntryId: event.pi?.parentEntryId ?? "",
        summary: event.payload.summary ?? ""
      })
    };
  } else if (nativeType.includes("compact") && event.payload.type === "compaction") {
    const compaction = event.pi?.payload.case === "compactionUpdate"
      ? event.pi.payload.value
      : undefined;
    payload = {
      case: "compaction",
      value: create(contract.PiCompactionEntrySchema, {
        boundaryEntryId: compaction?.boundaryEntryId ?? "",
        summary: event.payload.summary ?? "",
        tokensBefore: BigInt(compaction?.tokensBefore ?? 0),
        tokensAfter: BigInt(compaction?.tokensAfter ?? 0)
      })
    };
  } else {
    payload = {
      case: "custom",
      value: create(contract.PiCustomEntrySchema, {
        customType: nativeType,
        textPreview: durableEventPreview(event)
      })
    };
  }
  return create(contract.PiSessionEntrySchema, {
    entryId,
    parentId: event.pi?.parentEntryId ?? "",
    createdAt: toProtoTimestamp(event.emittedAt),
    payload
  });
}

function durablePiTree(events: readonly PersistedEvent[], activeLeafId: string): contract.PiSessionTreeNestedNode[] {
  const byId = new Map<string, PersistedEvent>();
  const childIds = new Map<string, string[]>();
  for (const event of events) {
    const id = event.pi?.entryId;
    if (id === undefined || byId.has(id)) continue;
    byId.set(id, event);
    const parent = event.pi?.parentEntryId;
    if (parent !== undefined && parent !== id) childIds.set(parent, [...(childIds.get(parent) ?? []), id]);
  }
  const visited = new Set<string>();
  const build = (id: string): contract.PiSessionTreeNestedNode | undefined => {
    const first = byId.get(id);
    if (first === undefined) return undefined;
    const activePath = new Set<string>([id]);
    visited.add(id);
    const stack: Array<{
      readonly id: string;
      readonly event: PersistedEvent;
      readonly children: readonly string[];
      readonly mappedChildren: contract.PiSessionTreeNestedNode[];
      childIndex: number;
    }> = [{ id, event: first, children: childIds.get(id) ?? [], mappedChildren: [], childIndex: 0 }];
    let result: contract.PiSessionTreeNestedNode | undefined;
    while (stack.length > 0) {
      const frame = stack.at(-1)!;
      if (frame.childIndex < frame.children.length) {
        const childId = frame.children[frame.childIndex++]!;
        if (activePath.has(childId)) continue;
        const child = byId.get(childId);
        if (child === undefined) continue;
        activePath.add(childId);
        visited.add(childId);
        stack.push({
          id: childId,
          event: child,
          children: childIds.get(childId) ?? [],
          mappedChildren: [],
          childIndex: 0
        });
        continue;
      }
      const mapped = durablePiTreeNode(frame.event, frame.id, activeLeafId, frame.mappedChildren);
      activePath.delete(frame.id);
      stack.pop();
      const parent = stack.at(-1);
      if (parent === undefined) result = mapped;
      else parent.mappedChildren.push(mapped);
    }
    return result;
  };
  const roots = [...byId.entries()]
    .filter(([id, event]) => event.pi?.parentEntryId === undefined || event.pi.parentEntryId === id || !byId.has(event.pi.parentEntryId))
    .map(([id]) => build(id))
    .filter((node): node is contract.PiSessionTreeNestedNode => node !== undefined);
  for (const id of byId.keys()) {
    if (visited.has(id)) continue;
    const node = build(id);
    if (node !== undefined) roots.push(node);
  }
  return roots;
}

function durablePiTreeNode(
  event: PersistedEvent,
  id: string,
  activeLeafId: string,
  children: contract.PiSessionTreeNestedNode[]
): contract.PiSessionTreeNestedNode {
  const nativeType = typeof event.metadata?.fields["nativeEntryType"] === "string"
    ? event.metadata.fields["nativeEntryType"]
    : event.pi?.rpcEventType ?? "custom";
  const role = event.payload.type === "message_complete"
    ? event.payload.role
    : event.payload.type === "tool_result"
      ? "toolResult"
      : "";
  const preview = durableEventPreview(event);
  return {
    ...create(contract.PiSessionTreeNodeSchema, {
    entryId: id,
    parentId: event.pi?.parentEntryId ?? "",
    kind: piEntryKind(nativeType),
    role,
    textPreview: preview,
    branchSummary: nativeType.includes("branch") ? preview : "",
    createdAt: toProtoTimestamp(event.emittedAt),
    active: id === activeLeafId,
    childCount: 0
    }),
    children
  };
}

function durableEventPreview(event: PersistedEvent): string {
  let value = "";
  switch (event.payload.type) {
    case "message_complete":
      value = event.payload.blocks.map((block) => block.kind === "text" || block.kind === "thinking"
        ? block.text
        : block.kind === "tool_call"
          ? `${block.name}: ${block.input}`
          : block.kind === "tool_result"
            ? block.output
            : block.kind === "artifact"
              ? block.label
              : block.alt ?? "[image]").join("\n");
      break;
    case "tool_result": value = event.payload.output; break;
    case "status": value = event.payload.text ?? event.payload.key; break;
    case "compaction": value = event.payload.summary ?? event.payload.reason; break;
    default: value = event.pi?.rpcEventType ?? event.payload.type;
  }
  return value.length <= 512 ? value : `${value.slice(0, 509)}...`;
}

function piMessagePreview(message: contract.PiNativeMessage): string {
  const text = message.parts.map((part) => {
    switch (part.content.case) {
      case "text": return part.content.value;
      case "thinking": return part.content.value.text;
      case "toolCall": return part.content.value.toolName;
      case "toolResult": return part.content.value.toolName;
      case "image": return part.content.value.altText;
      case undefined: return "";
    }
  }).filter(Boolean).join("\n");
  return text.length <= 512 ? text : `${text.slice(0, 509)}...`;
}

function normalizeNativeTimestamp(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER
    ? Math.trunc(value)
    : Math.trunc(fallback);
}

function resourceFilterForScope(
  dependencies: ConnectServiceDependencies,
  scope: contract.SnapshotScope
): { readonly backendId?: string; readonly targetId?: string } {
  switch (scope.kind.case) {
    case "backend": return { backendId: scope.kind.value.backendId };
    case "target": return { targetId: scope.kind.value.targetId };
    case "session": {
      const session = dependencies.store.getSession(scope.kind.value.sessionId).descriptor;
      return { backendId: session.backendId, targetId: session.targetId };
    }
    case "schedule": {
      const schedule = dependencies.store.getSchedule(scope.kind.value.scheduleId);
      return { backendId: schedule.backendId, targetId: schedule.targetId };
    }
    case "workspace": {
      const workspaceId = scope.kind.value.workspaceId;
      const target = dependencies.store.listTargets().find((candidate) => {
        const metadata = asRecord(candidate.metadata);
        return (stringValue(metadata["workspaceId"]) ?? candidate.descriptor.id) === workspaceId;
      });
      return target === undefined ? {} : { backendId: target.descriptor.backendId, targetId: target.descriptor.id };
    }
    default: return {};
  }
}

function toolProviders(dependencies: ConnectServiceDependencies): contract.ToolProviderDescriptor[] {
  const health = dependencies.store.health();
  const result = dependencies.store.listBackends().map((item) => {
    const toolProviderId = `backend:${item.descriptor.id}`;
    return create(contract.ToolProviderDescriptorSchema, {
      toolProviderId,
      displayName: `${item.descriptor.displayName} built-ins`,
      kind: contract.ToolProviderKind.BACKEND_BUILT_IN,
      version: item.descriptor.version,
      health: item.descriptor.health === "healthy" ? contract.ToolHealth.HEALTHY : item.descriptor.health === "degraded" ? contract.ToolHealth.DEGRADED : contract.ToolHealth.UNAVAILABLE,
      tools: item.descriptor.tools.map((tool) => mapBackendToolDescriptor(tool, toolProviderId)),
      entityVersion: toProtoEntityVersion(item.revision, 0, item.updatedAt)
    });
  });
  if (dependencies.browserProvider !== undefined) {
    result.push(create(contract.ToolProviderDescriptorSchema, {
      toolProviderId: BROWSER_PROVIDER_ID,
      displayName: "Browser",
      kind: contract.ToolProviderKind.BROWSER,
      version: "1",
      health: dependencies.browserProvider.running ? contract.ToolHealth.HEALTHY : contract.ToolHealth.STOPPED,
      tools: BROWSER_TOOLS.map((tool) => mapMcpToolDescriptor(tool, BROWSER_PROVIDER_ID)),
      entityVersion: toProtoEntityVersion(health.revision, dependencies.browserProvider.generation, Date.now())
    }));
  }
  if (dependencies.computerAutomation !== undefined) {
    const computer = dependencies.computerAutomation.snapshot();
    result.push(create(contract.ToolProviderDescriptorSchema, {
      toolProviderId: "computer",
      displayName: "Computer",
      kind: contract.ToolProviderKind.COMPUTER,
      version: computer.driverVersion || "1",
      health: computer.ready
        ? contract.ToolHealth.HEALTHY
        : !computer.enabled
          ? contract.ToolHealth.STOPPED
          : computer.installed
            ? contract.ToolHealth.DEGRADED
            : contract.ToolHealth.UNAVAILABLE,
      tools: (dependencies.computerBridge?.tools ?? []).map((tool) => mapMcpToolDescriptor(tool, "computer")),
      entityVersion: computer.version ?? toProtoEntityVersion(health.revision, 0, Date.now())
    }));
  }
  if (dependencies.androidAutomation !== undefined) {
    const android = dependencies.androidAutomation.snapshot();
    result.push(create(contract.ToolProviderDescriptorSchema, {
      toolProviderId: "android",
      displayName: "Android",
      kind: contract.ToolProviderKind.ANDROID,
      version: android.adbVersion || "1",
      health: !android.enabled
        ? contract.ToolHealth.STOPPED
        : android.runtimeState === contract.AndroidAutomationRuntimeState.CHECKING
          || android.runtimeState === contract.AndroidAutomationRuntimeState.PREPARING
          ? contract.ToolHealth.STARTING
          : android.runtimeState === contract.AndroidAutomationRuntimeState.READY
            ? contract.ToolHealth.HEALTHY
            : android.adbAvailable
              ? contract.ToolHealth.DEGRADED
              : contract.ToolHealth.UNAVAILABLE,
      tools: (dependencies.androidBridge?.tools ?? []).map((tool) => mapMcpToolDescriptor(tool, "android")),
      entityVersion: android.version ?? toProtoEntityVersion(health.revision, 0, Date.now())
    }));
  }
  for (const server of dependencies.mcpRouter?.list() ?? []) {
    result.push(create(contract.ToolProviderDescriptorSchema, {
      toolProviderId: `mcp:${server.id}`,
      displayName: server.displayName,
      kind: contract.ToolProviderKind.MCP,
      version: server.version.toString(10),
      health: server.state === "connected"
        ? contract.ToolHealth.HEALTHY
        : server.state === "starting" ? contract.ToolHealth.STARTING
          : server.state === "degraded" ? contract.ToolHealth.DEGRADED
            : server.state === "disabled" ? contract.ToolHealth.STOPPED : contract.ToolHealth.UNAVAILABLE,
      tools: server.tools.map((tool) => mapMcpToolDescriptor(tool)),
      entityVersion: toProtoEntityVersion(server.version, server.runtimeGeneration, server.updatedAt),
      error: server.error === undefined ? undefined : provisioningError("mcp", server.error)
    }));
  }
  return result;
}

async function mapBrowserProvider(
  provider: BrowserProvider,
  at: number,
  state?: OperationalBrowserState,
  settings?: BrowserSettingsController
): Promise<contract.BrowserProvider> {
  let pages: contract.BrowserPage[] = [];
  try {
    pages = await mapBrowserPages(provider, at, state);
  } catch {
    settings?.setBackendHealth({ active: false, status: "error", canRecover: true, reason: "statusFailed" });
  }
  return create(contract.BrowserProviderSchema, {
    browserProviderId: BROWSER_PROVIDER_ID,
    displayName: "Orchestrator Browser",
    version: "1",
    state: provider.running ? contract.BrowserProviderState.READY : contract.BrowserProviderState.STOPPED,
    generation: BigInt(provider.generation),
    profileDisplayName: settings?.profileDisplayName() ?? "Joko",
    pages,
    takeover: mapBrowserTakeover(provider),
    activePageId: (() => {
      const candidate = provider.currentHumanTakeover()?.pageId
        ?? (typeof state?.activePageId === "function" ? state.activePageId(BROWSER_PROVIDER_ID) : undefined);
      return candidate !== undefined && pages.some((page) => page.pageId === candidate) ? candidate : "";
    })(),
    entityVersion: toProtoEntityVersion(0n, provider.generation, at)
  });
}

async function mapBrowserPages(
  provider: BrowserProvider,
  at: number,
  state?: OperationalBrowserState
): Promise<contract.BrowserPage[]> {
  const observed = provider.running ? await provider.listPages() : [];
  const live = state === undefined ? observed : observed.filter((item) => {
    const owner = state.findRecoverablePage(BROWSER_PROVIDER_ID, item.id);
    if (owner?.generation !== provider.generation) return false;
    try {
      const assertPageAuthority = (state as Partial<OperationalBrowserState>).assertPageAuthority;
      if (typeof assertPageAuthority === "function") assertPageAuthority.call(state, {
        browserProviderId: owner.browserProviderId,
        pageId: owner.pageId,
        browserGeneration: owner.generation,
        sessionId: owner.sessionId,
        targetId: owner.targetId,
        bindingGeneration: owner.bindingGeneration
      });
      return true;
    } catch {
      return false;
    }
  });
  const pages = live.map((item) => mapBrowserPage(item, provider.generation, at, state));
  const recoverable = typeof state?.recoverablePages === "function"
    ? state.recoverablePages(BROWSER_PROVIDER_ID, new Set(live.map((item) => item.id))).filter((item) => {
      try {
        const assertPageAuthority = (state as Partial<OperationalBrowserState>).assertPageAuthority;
        if (typeof assertPageAuthority === "function") assertPageAuthority.call(state, {
          browserProviderId: item.browserProviderId,
          pageId: item.pageId,
          browserGeneration: item.generation,
          sessionId: item.sessionId,
          targetId: item.targetId,
          bindingGeneration: item.bindingGeneration
        });
        return true;
      } catch {
        return false;
      }
    })
    : [];
  return [...pages, ...recoverable.map(mapRecoverableBrowserPage)];
}

function mapBrowserPage(
  item: NativeBrowserPage,
  generation: number,
  at: number,
  state?: OperationalBrowserState
): contract.BrowserPage {
  let origin = "";
  try { origin = item.url === "" ? "" : new URL(item.url).origin; } catch { /* Keep an opaque invalid URL out of origin. */ }
  const screenshot = state?.findScreenshot(BROWSER_PROVIDER_ID, item.id, generation);
  const ownerCandidate = typeof state?.findRecoverablePage === "function"
    ? state.findRecoverablePage(BROWSER_PROVIDER_ID, item.id)
    : undefined;
  const owner = ownerCandidate?.generation === generation ? ownerCandidate : undefined;
  return create(contract.BrowserPageSchema, {
    pageId: item.id,
    browserProviderId: BROWSER_PROVIDER_ID,
    title: item.title,
    url: item.url,
    origin,
    state: item.state === "ready" ? contract.BrowserPageState.READY : item.state === "loading" ? contract.BrowserPageState.LOADING : item.state === "crashed" ? contract.BrowserPageState.CRASHED : contract.BrowserPageState.CLOSED,
    latestScreenshot: screenshot === undefined ? undefined : create(contract.ImageRefSchema, {
      blob: toProtoBlobRef(screenshot.blob, screenshot.capturedAt),
      widthPixels: screenshot.widthPixels ?? 0,
      heightPixels: screenshot.heightPixels ?? 0,
      altText: screenshot.blob.fileName ?? "Browser screenshot"
    }),
    lastActivityAt: toProtoTimestamp(at),
    activeToolCallId: "",
    version: toProtoEntityVersion(0n, generation, at),
    canGoBack: item.canGoBack ?? false,
    canGoForward: item.canGoForward ?? false,
    recoverable: false,
    lastKnownGeneration: BigInt(generation),
    sessionId: owner?.sessionId ?? ""
  });
}

function mapRecoverableBrowserPage(item: RecoverableBrowserPageRecord): contract.BrowserPage {
  let origin = "";
  try { origin = item.url === "about:blank" ? "" : new URL(item.url).origin; } catch { /* Validated durable records fail closed. */ }
  return create(contract.BrowserPageSchema, {
    pageId: item.pageId,
    browserProviderId: item.browserProviderId,
    title: item.title,
    url: item.url,
    origin,
    state: contract.BrowserPageState.CLOSED,
    lastActivityAt: toProtoTimestamp(item.updatedAt),
    activeToolCallId: "",
    version: toProtoEntityVersion(0n, item.generation, item.updatedAt),
    canGoBack: false,
    canGoForward: false,
    recoverable: true,
    lastKnownGeneration: BigInt(item.generation),
    sessionId: item.sessionId
  });
}

function mapBrowserTakeover(provider: BrowserProvider, expectedTakeoverId?: string): contract.BrowserTakeover | undefined {
  const takeover = provider.currentHumanTakeover();
  if (takeover === undefined || (expectedTakeoverId !== undefined && takeover.takeoverId !== expectedTakeoverId)) return undefined;
  return create(contract.BrowserTakeoverSchema, {
    takeoverId: takeover.takeoverId,
    pageId: takeover.pageId,
    connectionId: takeover.owner,
    state: contract.BrowserTakeoverState.ACTIVE,
    generation: BigInt(takeover.generation),
    startedAt: toProtoTimestamp(takeover.startedAt),
    expiresAt: toProtoTimestamp(takeover.expiresAt)
  });
}

function mapBrowserActivity(item: NativeBrowserActivity): contract.BrowserActivity {
  return create(contract.BrowserActivitySchema, {
    activityId: activityId(item),
    pageId: item.pageId ?? "",
    toolCallId: "",
    kind: browserActivityKind(item.type),
    description: item.detail,
    occurredAt: toProtoTimestamp(item.at)
  });
}

function activityId(item: NativeBrowserActivity): string {
  return `activity-${createHash("sha256").update(`${item.at}:${item.type}:${item.pageId ?? ""}:${item.detail}`).digest("hex").slice(0, 24)}`;
}

function browserActivityKind(kind: NativeBrowserActivity["type"]): contract.BrowserActivityKind {
  if (kind === "navigation" || kind === "page") return contract.BrowserActivityKind.NAVIGATION;
  if (kind === "download") return contract.BrowserActivityKind.DOWNLOAD;
  if (kind === "takeover") return contract.BrowserActivityKind.TAKEOVER;
  if (kind === "crashed" || kind === "started" || kind === "stopped") return contract.BrowserActivityKind.RECOVERY;
  return contract.BrowserActivityKind.INTERACTION;
}

function isAbortableToolCallState(state: contract.ToolCallState): boolean {
  return state === contract.ToolCallState.REQUESTED ||
    state === contract.ToolCallState.WAITING_PERMISSION ||
    state === contract.ToolCallState.RUNNING;
}

function isBrowserProviderId(id: string): boolean {
  return id === "" || id === BROWSER_PROVIDER_ID;
}

function requireOpaqueTakeoverId(value: string, label: string): void {
  if (value.trim() === "" || value.length > 1_024) {
    throw invalidArgument(`${label} must be a non-empty opaque identifier.`);
  }
}

function mapBrowserTakeoverInput(
  action: contract.BrowserTakeoverActionMutation["action"]
): BrowserTakeoverInput {
  let input: BrowserTakeoverInput;
  switch (action.case) {
  case "mouseClick":
    input = {
      type: "mouseClick",
      normalizedX: action.value.normalizedX,
      normalizedY: action.value.normalizedY,
      button: mapBrowserTakeoverMouseButton(action.value.button),
      ...(action.value.clickCount === 0 ? {} : { clickCount: action.value.clickCount as 1 | 2 })
    };
    break;
  case "mouseMove":
    input = {
      type: "mouseMove",
      normalizedX: action.value.normalizedX,
      normalizedY: action.value.normalizedY
    };
    break;
  case "mouseDrag":
    input = {
      type: "mouseDrag",
      startNormalizedX: action.value.startNormalizedX,
      startNormalizedY: action.value.startNormalizedY,
      endNormalizedX: action.value.endNormalizedX,
      endNormalizedY: action.value.endNormalizedY,
      button: mapBrowserTakeoverMouseButton(action.value.button)
    };
    break;
  case "scroll":
    input = {
      type: "scroll",
      deltaX: action.value.deltaXCssPixels,
      deltaY: action.value.deltaYCssPixels
    };
    break;
  case "keyPress":
    if (action.value.character !== "" && action.value.key !== contract.BrowserTakeoverKey.UNSPECIFIED) {
      throw invalidArgument("Browser takeover key press must choose a named key or a character, not both.");
    }
    input = {
      type: "keyPress",
      key: action.value.character === ""
        ? mapBrowserTakeoverKey(action.value.key)
        : mapBrowserTakeoverCharacter(action.value.character),
      modifiers: action.value.modifiers.map(mapBrowserTakeoverKeyModifier)
    };
    break;
  case "textInput":
    input = { type: "textInput", text: action.value.text };
    break;
  case "navigate":
    input = { type: "navigate", url: action.value.url };
    break;
  case "navigationCommand":
    input = { type: "navigationCommand", command: mapBrowserTakeoverNavigationCommand(action.value.command) };
    break;
  case undefined:
    throw invalidArgument("Browser takeover action is required.");
  }
  validateTakeoverInput(input);
  return input;
}

function mapBrowserTakeoverMouseButton(
  value: contract.BrowserTakeoverMouseButton
): "primary" | "middle" | "secondary" {
  switch (value) {
  case contract.BrowserTakeoverMouseButton.PRIMARY: return "primary";
  case contract.BrowserTakeoverMouseButton.MIDDLE: return "middle";
  case contract.BrowserTakeoverMouseButton.SECONDARY: return "secondary";
  default: throw invalidArgument("Browser takeover mouse button is required and must be supported.");
  }
}

function mapBrowserTakeoverKey(value: contract.BrowserTakeoverKey): Extract<BrowserTakeoverInput, { type: "keyPress" }>["key"] {
  switch (value) {
  case contract.BrowserTakeoverKey.ENTER: return "Enter";
  case contract.BrowserTakeoverKey.TAB: return "Tab";
  case contract.BrowserTakeoverKey.ESCAPE: return "Escape";
  case contract.BrowserTakeoverKey.BACKSPACE: return "Backspace";
  case contract.BrowserTakeoverKey.DELETE: return "Delete";
  case contract.BrowserTakeoverKey.ARROW_UP: return "ArrowUp";
  case contract.BrowserTakeoverKey.ARROW_DOWN: return "ArrowDown";
  case contract.BrowserTakeoverKey.ARROW_LEFT: return "ArrowLeft";
  case contract.BrowserTakeoverKey.ARROW_RIGHT: return "ArrowRight";
  case contract.BrowserTakeoverKey.HOME: return "Home";
  case contract.BrowserTakeoverKey.END: return "End";
  case contract.BrowserTakeoverKey.PAGE_UP: return "PageUp";
  case contract.BrowserTakeoverKey.PAGE_DOWN: return "PageDown";
  case contract.BrowserTakeoverKey.SPACE: return "Space";
  default: throw invalidArgument("Browser takeover key is required and must be supported.");
  }
}

async function livePiSessionState(
  dependencies: ConnectServiceDependencies,
  sessionId: string
): Promise<contract.GetPiSessionStateResponse> {
  const state = await dependencies.sessionHost.inspect(sessionId);
  const stored = dependencies.store.getSession(sessionId);
  const observation = materializedNativeStateObservation(dependencies.store.findSetting(
    "session",
    sessionId,
    SESSION_NATIVE_STATE_OBSERVATION_SETTING_KEY
  )?.value);
  const bindingCurrent = observation !== undefined && nativeStateObservationIsCurrent(
    observation,
    stored.descriptor.binding.generation,
    stored.descriptor.binding.opaqueRef
  );
  if (!bindingCurrent || observation?.generation !== state.binding.generation) {
    throw new ConnectError("The native Pi state changed while it was being observed.", Code.Aborted);
  }
  return create(contract.GetPiSessionStateResponseSchema, {
    ...(state.pi === undefined ? {} : { state: mapObservedPiState(state.pi) }),
    observation: mapPiStateObservation(
      observation,
      contract.PiStateObservationSource.LIVE_RPC,
      state.pi === undefined
        ? contract.PiStateObservationCompleteness.PARTIAL
        : contract.PiStateObservationCompleteness.COMPLETE,
      true
    )
  });
}

function mapBrowserTakeoverCharacter(
  value: string
): Extract<BrowserTakeoverInput, { type: "keyPress" }>["key"] {
  const normalized = value.toLowerCase();
  if (!/^[a-z0-9]$/u.test(normalized)) {
    throw invalidArgument("Browser takeover character key must be one ASCII letter or digit.");
  }
  return normalized as Extract<BrowserTakeoverInput, { type: "keyPress" }>["key"];
}

function mapBrowserTakeoverKeyModifier(
  value: contract.BrowserTakeoverKeyModifier
): NonNullable<Extract<BrowserTakeoverInput, { type: "keyPress" }>["modifiers"]>[number] {
  switch (value) {
  case contract.BrowserTakeoverKeyModifier.ALT: return "Alt";
  case contract.BrowserTakeoverKeyModifier.CONTROL: return "Control";
  case contract.BrowserTakeoverKeyModifier.META: return "Meta";
  case contract.BrowserTakeoverKeyModifier.SHIFT: return "Shift";
  default: throw invalidArgument("Browser takeover key modifier must be supported.");
  }
}

function browserGeneration(value: bigint, label = "Browser takeover generation"): number {
  if (value < 1n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw invalidArgument(`${label} must be a positive safe integer.`);
  }
  return Number(value);
}

function browserCommentInspectionInput(request: contract.InspectBrowserCommentTargetRequest): BrowserCommentInspectionInput {
  const markerNumber = request.markerNumber;
  switch (request.intent) {
  case contract.BrowserCommentInspectionIntent.ELEMENT:
    if (request.point === undefined) throw invalidArgument("Browser comment element point is required.");
    return { intent: "element", markerNumber, normalizedX: request.point.x, normalizedY: request.point.y };
  case contract.BrowserCommentInspectionIntent.REGION:
    if (request.point === undefined || request.region === undefined) throw invalidArgument("Browser comment region coordinates are required.");
    return {
      intent: "region",
      markerNumber,
      normalizedPoint: { x: request.point.x, y: request.point.y },
      normalizedRegion: { x: request.region.x, y: request.region.y, width: request.region.width, height: request.region.height }
    };
  case contract.BrowserCommentInspectionIntent.EXISTING_TEXT:
    return { intent: "existingText", markerNumber };
  default:
    throw invalidArgument("Browser comment inspection intent is invalid.");
  }
}

function browserCommentDesignUpdate(request: contract.UpdateBrowserCommentDesignRequest): BrowserCommentDesignUpdate {
  switch (request.action) {
  case contract.BrowserCommentDesignAction.APPLY:
    return {
      action: "apply",
      targetToken: request.targetToken,
      styles: browserCommentStringEntryRecord(request.styles) as Extract<BrowserCommentDesignUpdate, { readonly action: "apply" }>["styles"],
      ...(request.text === undefined ? {} : { text: request.text })
    };
  case contract.BrowserCommentDesignAction.RESET:
    return { action: "reset", targetToken: request.targetToken };
  case contract.BrowserCommentDesignAction.COMMIT:
    return { action: "commit", targetToken: request.targetToken, markerNumber: request.markerNumber };
  case contract.BrowserCommentDesignAction.RECONCILE:
    return { action: "reconcile", validMarkerNumbers: request.validMarkerNumbers };
  case contract.BrowserCommentDesignAction.RESET_ALL:
    return { action: "resetAll" };
  default:
    throw invalidArgument("Browser comment design action is invalid.");
  }
}

function browserCommentStringEntryRecord(entries: readonly { readonly key: string; readonly value: string }[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of entries) {
    if (entry.key.length === 0 || Object.prototype.hasOwnProperty.call(result, entry.key)) {
      throw invalidArgument("Browser comment style entries must have unique non-empty keys.");
    }
    result[entry.key] = entry.value;
  }
  return result;
}

function toProtoBrowserCommentPlacement(placement: NativeBrowserCommentPlacement): contract.BrowserCommentPlacement {
  return create(contract.BrowserCommentPlacementSchema, {
    markerNumber: placement.markerNumber,
    point: create(contract.BrowserCommentPointSchema, placement.point),
    viewport: create(contract.BrowserCommentViewportSchema, placement.viewport),
    pending: placement.pending,
    region: placement.region === undefined ? undefined : create(contract.BrowserCommentRegionSchema, placement.region),
    textRegions: (placement.textRegions ?? []).map((region) => create(contract.BrowserCommentRegionSchema, region))
  });
}

function toProtoBrowserCommentTarget(target: NativeBrowserCommentTarget): contract.BrowserCommentTarget {
  return create(contract.BrowserCommentTargetSchema, {
    kind: target.kind === "element"
      ? contract.BrowserCommentTargetKind.ELEMENT
      : target.kind === "region"
        ? contract.BrowserCommentTargetKind.REGION
        : contract.BrowserCommentTargetKind.TEXT,
    point: create(contract.BrowserCommentPointSchema, target.point),
    viewport: create(contract.BrowserCommentViewportSchema, target.viewport),
    region: target.region === undefined ? undefined : create(contract.BrowserCommentRegionSchema, target.region),
    textRegions: (target.textRegions ?? []).map((region) => create(contract.BrowserCommentRegionSchema, region)),
    selectedText: target.selectedText ?? "",
    targetTag: target.targetTag ?? "",
    targetLabel: target.targetLabel ?? "",
    targetRole: target.targetRole ?? "",
    targetSelector: target.targetSelector ?? "",
    targetPath: target.targetPath ?? "",
    nearbyText: target.nearbyText ?? "",
    themeVariant: target.themeVariant === "light"
      ? contract.BrowserCommentThemeVariant.LIGHT
      : target.themeVariant === "dark"
        ? contract.BrowserCommentThemeVariant.DARK
        : contract.BrowserCommentThemeVariant.UNSPECIFIED,
    designBaseline: target.designBaseline === undefined ? undefined : create(contract.BrowserCommentDesignBaselineSchema, {
      styles: Object.entries(target.designBaseline.styles).map(([key, value]) => create(contract.BrowserCommentStringEntrySchema, { key, value })),
      editableText: target.designBaseline.editableText,
      provenance: Object.entries(target.designBaseline.provenance).map(([key, value]) => create(contract.BrowserCommentStringEntrySchema, { key, value }))
    })
  });
}

function browserCommentConnectError(error: unknown): ConnectError {
  if (error instanceof ConnectError) return error;
  if (error instanceof BrowserTakeoverConflictError) {
    return new ConnectError("Browser comment target is missing, detached, or fenced.", Code.FailedPrecondition);
  }
  if (error instanceof TypeError || error instanceof RangeError) return invalidArgument(error.message);
  return new ConnectError("Browser page annotation failed.", Code.Internal);
}

function requireOwnedBrowserPageFence(
  provider: BrowserProvider,
  connectionId: string,
  value: {
    readonly browserProviderId: string;
    readonly currentPageId: string;
    readonly takeoverId: string;
    readonly generation: bigint;
  }
): NonNullable<ReturnType<BrowserProvider["currentHumanTakeover"]>> {
  requireOpaqueTakeoverId(value.browserProviderId, "Browser Provider ID");
  requireOpaqueTakeoverId(value.currentPageId, "Current Browser page ID");
  requireOpaqueTakeoverId(value.takeoverId, "Browser takeover ID");
  const generation = browserGeneration(value.generation);
  const current = provider.currentHumanTakeover();
  if (
    value.browserProviderId !== provider.id ||
    current === undefined ||
    current.providerId !== value.browserProviderId ||
    current.pageId !== value.currentPageId ||
    current.takeoverId !== value.takeoverId ||
    current.generation !== generation ||
    current.owner !== connectionId
  ) {
    throw new ConnectError("Browser takeover is missing, fenced, or owned by another Connection.", Code.FailedPrecondition);
  }
  return current;
}

function requireBrowserState(state: OperationalBrowserState | undefined): OperationalBrowserState {
  if (state === undefined) throw new BrowserTakeoverConflictError("Browser page authority is unavailable or fenced.");
  return state;
}

function requireActiveBrowserSessionAuthority(
  state: OperationalBrowserState | undefined,
  authority: { readonly sessionId: string; readonly targetId: string; readonly bindingGeneration: number }
): void {
  const browserState = requireBrowserState(state);
  const assertSessionAuthority = (browserState as Partial<OperationalBrowserState>).assertSessionAuthority;
  if (typeof assertSessionAuthority === "function") assertSessionAuthority.call(browserState, authority);
}

function requireActiveBrowserPageAuthority(
  state: OperationalBrowserState | undefined,
  browserProviderId: string,
  pageId: string,
  browserGeneration: number,
  expected?: {
    readonly sessionId: string;
    readonly targetId: string;
    readonly bindingGeneration: number;
  }
): RecoverableBrowserPageRecord {
  try {
    const browserState = requireBrowserState(state);
    const owner = browserState.findRecoverablePage(browserProviderId, pageId);
    if (
      owner === undefined ||
      owner.generation !== browserGeneration ||
      (expected !== undefined && (
        owner.sessionId !== expected.sessionId ||
        owner.targetId !== expected.targetId ||
        owner.bindingGeneration !== expected.bindingGeneration
      ))
    ) throw new BrowserTakeoverConflictError("Browser page authority is unavailable or fenced.");
    const assertPageAuthority = (browserState as Partial<OperationalBrowserState>).assertPageAuthority;
    if (typeof assertPageAuthority === "function") assertPageAuthority.call(browserState, {
      browserProviderId,
      pageId,
      browserGeneration,
      sessionId: owner.sessionId,
      targetId: owner.targetId,
      bindingGeneration: owner.bindingGeneration
    });
    return owner;
  } catch (error) {
    if (error instanceof BrowserTakeoverConflictError) throw error;
    throw new BrowserTakeoverConflictError("Browser page authority is unavailable or fenced.");
  }
}

function requireSameBrowserPageOwner(
  left: RecoverableBrowserPageRecord,
  right: RecoverableBrowserPageRecord
): void {
  if (
    left.sessionId !== right.sessionId ||
    left.targetId !== right.targetId ||
    left.bindingGeneration !== right.bindingGeneration ||
    left.generation !== right.generation
  ) throw new BrowserTakeoverConflictError("Browser page authority is unavailable or fenced.");
}

function recoverableBrowserUrl(value: string): string | undefined {
  try { return validateTakeoverNavigationUrl(value); } catch { return undefined; }
}

function mapBrowserTakeoverNavigationCommand(
  value: contract.BrowserTakeoverNavigationCommandKind
): Extract<BrowserTakeoverInput, { type: "navigationCommand" }>["command"] {
  switch (value) {
  case contract.BrowserTakeoverNavigationCommandKind.BACK: return "back";
  case contract.BrowserTakeoverNavigationCommandKind.FORWARD: return "forward";
  case contract.BrowserTakeoverNavigationCommandKind.RELOAD: return "reload";
  case contract.BrowserTakeoverNavigationCommandKind.STOP: return "stop";
  default: throw invalidArgument("Browser takeover navigation command must be supported.");
  }
}

function mapObservedPiState(state: PiNativeStateMetadata): contract.PiSessionState {
  return create(contract.PiSessionStateSchema, {
    nativeSessionId: state.nativeSessionId,
    nativeSessionName: state.nativeSessionName,
    nativeSessionFileDisplay: state.nativeSessionFileDisplay,
    model: state.model === undefined
      ? undefined
      : create(contract.ModelKeySchema, {
          providerId: state.model.providerId,
          modelId: state.model.modelId
        }),
    thinkingLevel: state.thinkingLevel,
    streaming: state.streaming,
    compacting: state.compacting,
    steeringMode: state.steeringMode === "all" ? contract.PiQueueMode.ALL : contract.PiQueueMode.ONE_AT_A_TIME,
    followUpMode: state.followUpMode === "all" ? contract.PiQueueMode.ALL : contract.PiQueueMode.ONE_AT_A_TIME,
    autoCompaction: state.autoCompaction,
    autoRetry: state.autoRetry,
    messageCount: BigInt(state.messageCount),
    pendingMessageCount: BigInt(state.pendingMessageCount),
    activeLeafId: state.activeLeafId
  });
}

function mapPiStateObservation(
  observation: MaterializedNativeStateObservation,
  source: contract.PiStateObservationSource,
  completeness: contract.PiStateObservationCompleteness,
  bindingCurrent: boolean
): contract.PiStateObservation {
  return create(contract.PiStateObservationSchema, {
    source,
    completeness,
    runtimeGeneration: BigInt(observation.generation),
    observedAt: toProtoTimestamp(observation.observedAt),
    bindingCurrent
  });
}

export function projectDurablePiState(
  observation: MaterializedNativeStateObservation | undefined,
  current: { readonly generation: number; readonly opaqueRef: string }
): { readonly state?: contract.PiSessionState; readonly observation: contract.PiStateObservation } {
  if (observation === undefined) {
    return {
      observation: create(contract.PiStateObservationSchema, {
        source: contract.PiStateObservationSource.UNSPECIFIED,
        completeness: contract.PiStateObservationCompleteness.UNOBSERVED,
        runtimeGeneration: BigInt(current.generation),
        bindingCurrent: false
      })
    };
  }
  const bindingCurrent = nativeStateObservationIsCurrent(
    observation,
    current.generation,
    current.opaqueRef
  );
  return {
    ...(observation.pi === undefined ? {} : { state: mapObservedPiState(observation.pi) }),
    observation: mapPiStateObservation(
      observation,
      contract.PiStateObservationSource.DURABLE_RPC,
      bindingCurrent
        ? observation.pi === undefined
          ? contract.PiStateObservationCompleteness.PARTIAL
          : contract.PiStateObservationCompleteness.COMPLETE
        : contract.PiStateObservationCompleteness.STALE,
      bindingCurrent
    )
  };
}

function piTree(nativeSessionId: string, tree: SessionTree): contract.PiSessionTreeUpdate {
  const nestedRoots = mapSessionTreeNodes<contract.PiSessionTreeNestedNode>(
    tree.roots,
    (node, children) => piTreeNode(node, tree.leafId, children)
  );
  return create(contract.PiSessionTreeUpdateSchema, {
    nativeSessionId,
    activeLeafId: tree.leafId ?? "",
    ...contract.piSessionTreeWireFields(nestedRoots)
  });
}

function piTreeNode(
  node: SessionTreeNode,
  leafId: string | undefined,
  children: contract.PiSessionTreeNestedNode[]
): contract.PiSessionTreeNestedNode {
  return {
    ...create(contract.PiSessionTreeNodeSchema, {
    entryId: node.entryId,
    parentId: node.parentId ?? "",
    kind: piEntryKind(node.kind),
    role: node.role ?? roleFromKind(node.kind),
    textPreview: node.label ?? "",
    branchSummary: node.kind.toLowerCase().includes("branch") ? node.label ?? "" : "",
    createdAt: toProtoTimestamp(node.timestamp),
    active: node.entryId === leafId,
    childCount: 0
    }),
    children
  };
}

function piEntryKind(kind: string): contract.PiSessionEntryKind {
  const value = kind.toLowerCase();
  if (value.includes("message") || value === "user" || value === "assistant") return contract.PiSessionEntryKind.MESSAGE;
  if (value.includes("model")) return contract.PiSessionEntryKind.MODEL_CHANGE;
  if (value.includes("thinking")) return contract.PiSessionEntryKind.THINKING_LEVEL_CHANGE;
  if (value.includes("compact")) return contract.PiSessionEntryKind.COMPACTION;
  if (value.includes("branch")) return contract.PiSessionEntryKind.BRANCH_SUMMARY;
  if (value.includes("label")) return contract.PiSessionEntryKind.LABEL;
  if (value.includes("session")) return contract.PiSessionEntryKind.SESSION;
  return contract.PiSessionEntryKind.CUSTOM_MESSAGE;
}

function roleFromKind(kind: string): string {
  const value = kind.toLowerCase();
  if (value.includes("user")) return "user";
  if (value.includes("assistant")) return "assistant";
  if (value.includes("tool")) return "toolResult";
  return "";
}

async function mapPiMessage(
  value: unknown,
  artifacts: ArtifactStore,
  fallbackNativeEntryId?: string
): Promise<contract.PiNativeMessage | undefined> {
  const record = asRecord(value);
  const id = stringValue(record["id"]) ?? fallbackNativeEntryId;
  if (id === undefined) return undefined;
  const role = stringValue(record["role"]) ?? "custom";
  const content = record["content"];
  const parts: contract.PiMessagePart[] = [];
  if (role === "toolResult") {
    parts.push(await mapPiToolResultMessage(record, content, artifacts));
  } else if (typeof content === "string") {
    parts.push(create(contract.PiMessagePartSchema, { content: { case: "text", value: piDisplayText(content) } }));
  } else if (Array.isArray(content)) {
    for (const part of content) {
      const mapped = await mapPiMessagePart(part, artifacts);
      if (mapped !== undefined) parts.push(mapped);
    }
  }
  const usage = mapPiMessageUsage(record["usage"]);
  return create(contract.PiNativeMessageSchema, {
    nativeMessageId: piDisplayText(id, 512),
    nativeEntryId: piDisplayText(stringValue(record["entryId"]) ?? fallbackNativeEntryId ?? "", 512),
    role: role === "user" ? contract.PiMessageRole.USER : role === "assistant" ? contract.PiMessageRole.ASSISTANT : role === "toolResult" ? contract.PiMessageRole.TOOL_RESULT : contract.PiMessageRole.CUSTOM,
    parts,
    ...(usage === undefined ? {} : { usage }),
    createdAt: optionalDate(record["timestamp"])
  });
}

async function mapPiMessagePart(value: unknown, artifacts: ArtifactStore): Promise<contract.PiMessagePart | undefined> {
  if (typeof value === "string") return create(contract.PiMessagePartSchema, { content: { case: "text", value: piDisplayText(value) } });
  const record = asRecord(value);
  const type = stringValue(record["type"]) ?? "text";
  if (type === "text" && typeof record["text"] === "string") return create(contract.PiMessagePartSchema, { content: { case: "text", value: piDisplayText(record["text"]) } });
  if (type === "thinking" && typeof record["thinking"] === "string") {
    return create(contract.PiMessagePartSchema, {
      content: {
        case: "thinking",
        value: create(contract.PiThinkingContentSchema, {
          text: record["redacted"] === true ? "" : piDisplayText(record["thinking"]),
          hidden: record["redacted"] === true
        })
      }
    });
  }
  if (type === "image") {
    const image = await mapPiImageRef(record, artifacts);
    return image === undefined
      ? undefined
      : create(contract.PiMessagePartSchema, { content: { case: "image", value: image } });
  }
  if (type === "toolCall") {
    return create(contract.PiMessagePartSchema, {
      content: {
        case: "toolCall",
        value: create(contract.PiToolCallContentSchema, {
          nativeToolCallId: piDisplayText(stringValue(record["id"]) ?? "", 512),
          toolName: piDisplayText(stringValue(record["name"]) ?? "", 256),
          arguments: displayArguments(record["arguments"])
        })
      }
    });
  }
  return undefined;
}

async function mapPiToolResultMessage(
  message: Record<string, unknown>,
  content: unknown,
  artifacts: ArtifactStore
): Promise<contract.PiMessagePart> {
  const parts: contract.ToolResultPart[] = [];
  const values = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
  for (const value of values) {
    const record = asRecord(value);
    const type = stringValue(record["type"]) ?? "text";
    if (type === "text" && typeof record["text"] === "string") {
      parts.push(create(contract.ToolResultPartSchema, { content: { case: "text", value: piDisplayText(record["text"]) } }));
      continue;
    }
    if (type === "image") {
      const image = await mapPiImageRef(record, artifacts);
      if (image !== undefined) parts.push(create(contract.ToolResultPartSchema, { content: { case: "image", value: image } }));
    }
  }
  return create(contract.PiMessagePartSchema, {
    content: {
      case: "toolResult",
      value: create(contract.PiToolResultContentSchema, {
        nativeToolCallId: piDisplayText(stringValue(message["toolCallId"]) ?? "", 512),
        toolName: piDisplayText(stringValue(message["toolName"]) ?? "", 256),
        result: create(contract.ToolResultSchema, { parts, truncated: false }),
        error: message["isError"] === true
      })
    }
  });
}

async function mapPiImageRef(
  value: Record<string, unknown>,
  artifacts: ArtifactStore
): Promise<contract.ImageRef | undefined> {
  const data = stringValue(value["data"])?.replace(/\s+/gu, "");
  const mimeType = stringValue(value["mimeType"])?.toLowerCase();
  if (data === undefined || data === "" || mimeType === undefined || !/^image\/[a-z0-9][a-z0-9.+-]*$/u.test(mimeType)) return undefined;
  const byteLength = canonicalPiBase64ByteLength(data);
  if (byteLength === undefined) return undefined;
  if (byteLength > artifacts.maximumBlobBytes) {
    throw new ConnectError("Pi message image exceeds the Artifact Blob capability.", Code.ResourceExhausted);
  }
  const bytes = Buffer.from(data, "base64");
  if (bytes.byteLength !== byteLength) return undefined;
  const artifact = await artifacts.ingestBytes(bytes, { mimeType, fileName: `pi-message-image.${piImageExtension(mimeType)}` });
  return create(contract.ImageRefSchema, {
    blob: toProtoBlobRef(artifact),
    widthPixels: 0,
    heightPixels: 0,
    altText: ""
  });
}

/** Validate canonical padded base64 and enforce Artifact capacity before
 * allocating the decoded image buffer. */
function canonicalPiBase64ByteLength(value: string): number | undefined {
  if (value.length === 0 || value.length % 4 !== 0) return undefined;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const contentLength = value.length - padding;
  for (let index = 0; index < contentLength; index += 1) {
    if (piBase64AlphabetValue(value.charCodeAt(index)) < 0) return undefined;
  }
  for (let index = contentLength; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 0x3d) return undefined;
  }
  if (padding === 2 && (piBase64AlphabetValue(value.charCodeAt(contentLength - 1)) & 0x0f) !== 0) return undefined;
  if (padding === 1 && (piBase64AlphabetValue(value.charCodeAt(contentLength - 1)) & 0x03) !== 0) return undefined;
  const byteLength = value.length / 4 * 3 - padding;
  return byteLength > 0 ? byteLength : undefined;
}

function piBase64AlphabetValue(value: number): number {
  if (value >= 0x41 && value <= 0x5a) return value - 0x41;
  if (value >= 0x61 && value <= 0x7a) return value - 0x61 + 26;
  if (value >= 0x30 && value <= 0x39) return value - 0x30 + 52;
  if (value === 0x2b) return 62;
  if (value === 0x2f) return 63;
  return -1;
}

function piImageExtension(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  const subtype = mimeType.slice("image/".length).split(/[.+-]/u, 1)[0];
  return subtype === undefined || subtype === "" ? "image" : subtype;
}

function displayArguments(value: unknown): contract.DisplayArgument[] {
  const record = asRecord(value);
  return Object.entries(record).map(([name, item]) => {
    const sensitive = /token|secret|password|api[_-]?key/iu.test(name);
    return create(contract.DisplayArgumentSchema, {
      fieldPath: piDisplayText(name, 256),
      value: { case: "text", value: sensitive ? "" : piDisplayText(typeof item === "string" ? item : safeJson(item)) },
      redacted: sensitive,
      redactedPlaceholder: sensitive ? "••••" : ""
    });
  });
}

function mapPiMessageUsage(value: unknown): contract.Usage | undefined {
  const record = asRecord(value);
  if (Object.keys(record).length === 0) return undefined;
  return create(contract.UsageSchema, {
    inputTokens: bigintValue(record["input"]),
    outputTokens: bigintValue(record["output"]),
    cacheReadTokens: bigintValue(record["cacheRead"]),
    cacheWriteTokens: bigintValue(record["cacheWrite"]),
    totalTokens: bigintValue(record["totalTokens"]),
    costMicros: BigInt(Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(
      typeof record["costMicros"] === "number" && Number.isFinite(record["costMicros"])
        ? record["costMicros"]
        : 0
    )))),
    currencyCode: "USD"
  });
}

function piDisplayText(value: string, maximumCharacters?: number): string {
  const redacted = redactSecrets(value);
  return maximumCharacters === undefined ? redacted : redacted.slice(0, maximumCharacters);
}

async function mapPiEntry(value: unknown, artifacts: ArtifactStore): Promise<contract.PiSessionEntry | undefined> {
  const record = asRecord(value);
  const id = stringValue(record["id"]);
  if (id === undefined) return undefined;
  const type = stringValue(record["type"]) ?? "custom";
  let payload: contract.PiSessionEntry["payload"];
  if (type === "message") {
    const message = await mapPiMessage(record["message"], artifacts, id);
    payload = message === undefined
      ? { case: "custom", value: await mapPiCustomEntry(record, type, artifacts) }
      : { case: "message", value: message };
  } else if (type === "model_change") {
    payload = {
      case: "modelChange",
      value: create(contract.PiModelChangeEntrySchema, {
        model: create(contract.ModelKeySchema, {
          providerId: stringValue(record["provider"]) ?? "",
          modelId: stringValue(record["modelId"]) ?? ""
        })
      })
    };
  } else if (type === "thinking_level_change") {
    payload = { case: "thinkingLevelChange", value: create(contract.PiThinkingLevelChangeEntrySchema, { thinkingLevel: stringValue(record["thinkingLevel"]) ?? "" }) };
  } else if (type === "compaction") {
    payload = { case: "compaction", value: create(contract.PiCompactionEntrySchema, {
      boundaryEntryId: stringValue(record["firstKeptEntryId"]) ?? "",
      summary: stringValue(record["summary"]) ?? "",
      tokensBefore: bigintValue(record["tokensBefore"]),
      // Pi's persisted CompactionEntry does not retain the live
      // estimatedTokensAfter value.
      tokensAfter: 0n
    }) };
  } else if (type === "branch_summary") {
    payload = { case: "branchSummary", value: create(contract.PiBranchSummaryEntrySchema, { branchFromEntryId: stringValue(record["fromId"]) ?? "", summary: stringValue(record["summary"]) ?? "" }) };
  } else {
    payload = { case: "custom", value: await mapPiCustomEntry(record, type, artifacts) };
  }
  return create(contract.PiSessionEntrySchema, {
    entryId: id,
    parentId: stringValue(record["parentId"]) ?? "",
    createdAt: optionalDate(record["timestamp"]),
    payload
  });
}

function mapPiCommand(item: RuntimeCommand): contract.PiSlashCommand {
  return create(contract.PiSlashCommandSchema, {
    name: item.name,
    description: item.description,
    source: item.source === "extension" ? contract.PiCommandSource.EXTENSION : item.source === "skill" ? contract.PiCommandSource.SKILL : contract.PiCommandSource.PROMPT,
    sourceInfo: create(contract.PiSourceInfoSchema, { resourceId: "", scope: contract.ResourceScope.UNSPECIFIED, sourceDisplay: item.path ?? "", packageName: "" })
  });
}

async function mapPiCustomEntry(
  record: Record<string, unknown>,
  type: string,
  artifacts: ArtifactStore
): Promise<contract.PiCustomEntry> {
  const serialized = redactSecrets(safeJson(record));
  const byteLength = Buffer.byteLength(serialized, "utf8");
  if (byteLength > artifacts.maximumBlobBytes) {
    throw new ConnectError("Sanitized Pi custom entry exceeds the Artifact Blob capability.", Code.ResourceExhausted);
  }
  const digest = createHash("sha256").update(serialized).digest("hex");
  const artifact = await artifacts.ingestBytes(Buffer.from(serialized, "utf8"), {
    mimeType: "application/json",
    fileName: `pi-custom-entry-${digest.slice(0, 16)}.json`
  });
  return create(contract.PiCustomEntrySchema, {
    customType: type,
    textPreview: safePreview(serialized),
    sanitizedPayloadArtifact: toProtoBlobRef(artifact)
  });
}

function protoResourceAcquisitionKind(value: NativePiResourceDescriptor["sourceKind"]): contract.ResourceAcquisitionKind {
  switch (value) {
    case "local": return contract.ResourceAcquisitionKind.LOCAL;
    case "npm": return contract.ResourceAcquisitionKind.NPM;
    case "git": return contract.ResourceAcquisitionKind.GIT;
    default: return contract.ResourceAcquisitionKind.UNSPECIFIED;
  }
}

function nativeResourceAcquisition(value: contract.ResourceAcquisitionSource): PiPackageSource {
  try {
    switch (value.source.case) {
      case "local":
        if (value.source.value.serverPath.trim() === "") throw new Error("empty local path");
        return normalizePiPackageSource({ kind: "local", path: value.source.value.serverPath });
      case "npm":
        if (value.source.value.packageName.trim() === "") throw new Error("empty npm package name");
        return normalizePiPackageSource({
          kind: "npm",
          packageName: value.source.value.packageName,
          ...(value.source.value.versionSpec.trim() === "" ? {} : { versionSpec: value.source.value.versionSpec })
        });
      case "git":
        if (value.source.value.repositoryUrl.trim() === "") throw new Error("empty git repository URL");
        return normalizePiPackageSource({
          kind: "git",
          repositoryUrl: value.source.value.repositoryUrl,
          ...(value.source.value.ref.trim() === "" ? {} : { ref: value.source.value.ref }),
          ...(value.source.value.subdirectory.trim() === "" ? {} : { subdirectory: value.source.value.subdirectory })
        });
      case undefined:
        throw new Error("missing acquisition source");
    }
  } catch {
    throw invalidArgument("resource acquisition source is invalid");
  }
}

function nativeLocalResourceAcquisition(serverPath: string): Extract<PiPackageSource, { readonly kind: "local" }> {
  try {
    return normalizePiPackageSource({ kind: "local", path: serverPath }) as Extract<PiPackageSource, { readonly kind: "local" }>;
  } catch {
    throw invalidArgument("server_path must be a normalized absolute local path");
  }
}

function mapPiResource(item: RuntimeResource, backendId: string, targetId: string): contract.ManagedResource {
  return create(contract.ManagedResourceSchema, {
    resourceId: item.id,
    backendId,
    targetId,
    kind: item.kind === "extension" ? contract.ResourceKind.EXTENSION : item.kind === "skill" ? contract.ResourceKind.SKILL : item.kind === "prompt" ? contract.ResourceKind.PROMPT_TEMPLATE : contract.ResourceKind.PACKAGE,
    name: item.name,
    version: item.version ?? "",
    source: create(contract.ResourceSourceSchema, {
      scope: contract.ResourceScope.PROJECT,
      sourceDisplay: item.source,
      canonicalPathFingerprint: createHash("sha256").update(item.source).digest("hex"),
      symbolicLinkDetected: false,
      specialFileDetected: false,
      acquisitionKind: contract.ResourceAcquisitionKind.LOCAL,
      sourceIdentity: item.source
    }),
    state: resourceState(item.state),
    enabled: item.state !== "disabled" && item.state !== "error",
    approvedByConnectionId: "",
    discoveredRevision: "",
    compatibilityDetails: [],
    runtimeRequirements: [],
    warnings: [],
    disabledLifecycleScripts: [],
    canToggle: item.kind !== "extension" || item.state !== "error",
    requiresExtensionApproval: false,
    extensionContentFingerprint: "",
    postMutationNotice: false
  });
}

function resourceState(state: RuntimeResource["state"]): contract.ResourceState {
  if (state === "discovered") return contract.ResourceState.DISCOVERED;
  if (state === "approved") return contract.ResourceState.APPROVED;
  if (state === "loaded") return contract.ResourceState.LOADED;
  if (state === "disabled") return contract.ResourceState.DISABLED;
  return contract.ResourceState.ERROR;
}

/**
 * Revocation is already durable when this runs. Release only a takeover whose
 * authenticated owner is one of the newly revoked Connections, and hand the
 * Provider the complete observed fence so a queued cleanup cannot end a newer
 * takeover generation.
 */
function releaseRevokedBrowserTakeovers(
  dependencies: ConnectServiceDependencies,
  connectionIds: readonly string[]
): void {
  if (dependencies.browserProvider === undefined) return;
  for (const connectionId of new Set(connectionIds)) {
    void releaseRevokedBrowserTakeover(dependencies, connectionId);
  }
}

async function releaseRevokedBrowserTakeover(
  dependencies: ConnectServiceDependencies,
  connectionId: string
): Promise<void> {
  const provider = dependencies.browserProvider;
  if (provider === undefined) return;
  let fence: BrowserTakeoverFence | undefined;
  try {
    const current = provider.currentHumanTakeover();
    if (current === undefined || current.owner !== connectionId) return;
    fence = {
      providerId: current.providerId,
      pageId: current.pageId,
      generation: current.generation,
      owner: current.owner,
      takeoverId: current.takeoverId
    };
    await provider.endHumanTakeover(fence);
  } catch {
    // A concurrent end/recovery/new generation is a successful fence outcome:
    // it proves the revoked owner's exact capability is no longer current.
    if (fence !== undefined) {
      try {
        const current = provider.currentHumanTakeover();
        if (current === undefined || !sameTakeoverFence(current, fence)) return;
      } catch {
        // A failed state probe still needs the same redacted diagnostic below.
      }
    }
    try {
      dependencies.store.appendDiagnostic({
        severity: "warning",
        component: "browser",
        code: "BROWSER_TAKEOVER_REVOKE_CLEANUP_FAILED",
        message: "A revoked Connection's Browser takeover could not be released automatically.",
        details: {}
      });
    } catch {
      // Cleanup must never change the already committed revocation outcome.
    }
  }
}

async function dispatchMutation(
  dependencies: ConnectServiceDependencies,
  operationId: string,
  connection: ConnectionRecord,
  mutation: contract.OperationMutation
): Promise<PresentedOperation> {
  const host = withOperationPreconditions(dependencies.sessionHost as ExtendedSessionHost, mutation);
  dependencies = { ...dependencies, sessionHost: host };
  const payload = mutation.payload;
  switch (payload.case) {
    case "startReview": {
      if (dependencies.reviewCoordinator === undefined) {
        return unsupportedOperation(dependencies, operationId, connection, mutation, payload.case, "Isolated Review is not configured on this Orchestrator node.");
      }
      const source = dependencies.store.getSession(payload.value.sourceSessionId);
      const backend = dependencies.store.getBackend(source.descriptor.backendId).descriptor;
      if (backend.capabilities.get("review.isolated")?.supported !== true) {
        return unsupportedOperation(dependencies, operationId, connection, mutation, payload.case, "Backend does not support review.isolated.");
      }
      const result = await dependencies.reviewCoordinator.start({
        operationId,
        connection,
        operationBody: mutation,
        request: {
          sourceSessionId: payload.value.sourceSessionId,
          ...(payload.value.focus.trim() === "" ? {} : { focus: payload.value.focus }),
          attachments: payload.value.attachments.map((attachment, index) => {
            if (attachment.blob === undefined) throw invalidArgument(`start_review.attachments[${index}].blob is required`);
            return {
              kind: attachment.kind === contract.ReviewAttachmentKind.IMAGE ? "image" as const
                : attachment.kind === contract.ReviewAttachmentKind.FILE ? "file" as const
                  : (() => { throw invalidArgument(`start_review.attachments[${index}].kind is required`); })(),
              displayName: attachment.displayName,
              blob: fromProtoBlobRef(attachment.blob)
            };
          })
        }
      });
      return {
        record: dependencies.store.getOperation(operationId),
        outcome: { accepted: true, resultCase: "reviewRun", entityId: result.reviewRunId }
      };
    }
    case "reobserveReview": {
      if (dependencies.reviewCoordinator === undefined) {
        return unsupportedOperation(dependencies, operationId, connection, mutation, payload.case, "Review evidence observation is not configured on this Orchestrator node.");
      }
      const reviewRunId = payload.value.reviewRunId.trim();
      if (reviewRunId === "") throw invalidArgument("review_run_id is required");
      const result = await dependencies.reviewCoordinator.reobserve({
        operationId,
        connection,
        reviewRunId,
        operationBody: mutation,
        precondition: (store) => validatePreconditions(store, mutation)
      });
      return {
        record: dependencies.store.getOperation(operationId),
        outcome: { accepted: true, resultCase: "reviewRun", entityId: result.reviewRunId }
      };
    }
    case "revokeDevice": {
      let revokedConnectionIds: readonly string[] = [];
      const execution = await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        commit: () => {
          const result = dependencies.connections.revokeDevice(payload.value.deviceId);
          revokedConnectionIds = result.connections.map((item) => item.id);
          return { accepted: true, resultCase: "device", entityId: result.device.id } satisfies OperationOutcome;
        }
      });
      if (!execution.replayed) releaseRevokedBrowserTakeovers(dependencies, revokedConnectionIds);
      return presented(execution);
    }
    case "renameDevice": {
      const deviceId = payload.value.deviceId.trim();
      if (deviceId === "") throw invalidArgument("device_id is required");
      const displayName = boundedDeviceDisplayName(payload.value.displayName);
      return presented(await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        commit: (store) => {
          const device = store.renameDevice(deviceId, displayName);
          return { accepted: true, resultCase: "device", entityId: device.id } satisfies OperationOutcome;
        }
      }));
    }
    case "setDeviceRemoteControlEnabled": {
      return presented(await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        commit: (store) => {
          requireControllableDevice(store.getDevice(connection.deviceId));
          const device = store.setDeviceRemoteControlEnabled(connection.deviceId, payload.value.enabled);
          return { accepted: true, resultCase: "device", entityId: device.id } satisfies OperationOutcome;
        }
      }));
    }
    case "setDeviceControlTargetEnabled": {
      const targetDeviceId = payload.value.targetDeviceId.trim();
      if (targetDeviceId === "" || targetDeviceId === connection.deviceId) {
        throw invalidArgument("target_device_id must identify another Device");
      }
      return presented(await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        commit: (store) => {
          requireControllableDevice(store.getDevice(targetDeviceId));
          const relation = store.setDeviceControlRelation({
            controllerDeviceId: connection.deviceId,
            targetDeviceId,
            outboundEnabled: payload.value.enabled
          });
          return {
            accepted: true,
            resultCase: "deviceControlRelation",
            entityId: deviceControlRelationId(relation.controllerDeviceId, relation.targetDeviceId)
          } satisfies OperationOutcome;
        }
      }));
    }
    case "setDeviceControllerAllowed": {
      const controllerDeviceId = payload.value.controllerDeviceId.trim();
      if (controllerDeviceId === "" || controllerDeviceId === connection.deviceId) {
        throw invalidArgument("controller_device_id must identify another Device");
      }
      return presented(await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        commit: (store) => {
          requireControllableDevice(store.getDevice(connection.deviceId));
          store.getDevice(controllerDeviceId);
          const relation = store.setDeviceControlRelation({
            controllerDeviceId,
            targetDeviceId: connection.deviceId,
            inboundAllowed: payload.value.allowed
          });
          return {
            accepted: true,
            resultCase: "deviceControlRelation",
            entityId: deviceControlRelationId(relation.controllerDeviceId, relation.targetDeviceId)
          } satisfies OperationOutcome;
        }
      }));
    }
    case "logoutConnection": {
      let revokedConnectionId: string | undefined;
      const execution = await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        commit: () => {
          const requestedConnectionId = payload.value.connectionId || connection.id;
          if (dependencies.store.getConnection(requestedConnectionId).state !== "active") {
            throw new ConnectError("Connection access is already revoked.", Code.FailedPrecondition);
          }
          const revoked = dependencies.connections.logout(requestedConnectionId, connection.id);
          revokedConnectionId = revoked.id;
          return { accepted: true, resultCase: "connection", entityId: revoked.id } satisfies OperationOutcome;
        }
      });
      if (!execution.replayed && revokedConnectionId !== undefined) {
        releaseRevokedBrowserTakeovers(dependencies, [revokedConnectionId]);
      }
      return presented(execution);
    }
    case "restartBackend": {
      if (dependencies.restartBackend === undefined) {
        return unsupportedOperation(
          dependencies,
          operationId,
          connection,
          mutation,
          payload.case,
          "Backend instance replacement is unavailable on this service node."
        );
      }
      return ackOperation(
        dependencies,
        operationId,
        connection,
        mutation,
        payload.case,
        () => dependencies.restartBackend!(payload.value.backendId)
      );
    }
    case "createTarget": {
      const id = stableId("target", operationId);
      const workspaceId = stableId("workspace", operationId);
      const workspace = payload.value.workspace;
      if (workspace === undefined) return unsupportedOperation(dependencies, operationId, connection, mutation, payload.case, "Typed Target workspace input is required.");
      if (workspace.kind !== contract.WorkspaceKind.USER_PROJECT && workspace.kind !== contract.WorkspaceKind.MANAGED_DIALOGUE) {
        throw invalidArgument("workspace.kind is required");
      }
      const managed = workspace.kind === contract.WorkspaceKind.MANAGED_DIALOGUE;
      let requestedRoot: string;
      if (managed) {
        if (dependencies.managedWorkspaceRoot === undefined) {
          return unsupportedOperation(dependencies, operationId, connection, mutation, payload.case, "The managed workspace root is not configured.");
        }
        requestedRoot = resolve(dependencies.managedWorkspaceRoot, id);
        if (workspace.serverPath !== "" && resolve(workspace.serverPath) !== requestedRoot) {
          throw invalidArgument("MANAGED_DIALOGUE workspaces cannot select an arbitrary server_path");
        }
      } else {
        if (workspace.serverPath.trim() === "") return unsupportedOperation(dependencies, operationId, connection, mutation, payload.case, "A server workspace path is required.");
        requestedRoot = resolve(workspace.serverPath);
      }
      if (!workspace.createIfMissing) await requireExistingDirectory(requestedRoot, "workspace.server_path");
      let descriptor: import("@joko/core").TargetDescriptor | undefined;
      const execution = await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        commit: (store) => {
          if (descriptor === undefined) throw new Error("Target workspace preparation completed without a descriptor.");
          store.upsertTarget(descriptor, { workspaceId });
          return { accepted: true, resultCase: "target", entityId: id } satisfies OperationOutcome;
        },
        effect: async () => {
          const existed = await pathExists(requestedRoot);
          if (workspace.createIfMissing) await mkdir(requestedRoot, { recursive: true });
          try {
            const root = await requireExistingDirectory(requestedRoot, "workspace.server_path");
            descriptor = {
              id,
              backendId: payload.value.backendId,
              displayName: payload.value.displayName || "New target",
              workspaceRoot: root,
              managed,
              trusted: false
            };
            // Adapter validation is an external check only. Product state is
            // written exclusively by the deferred final commit above.
            await host.validateTarget(descriptor);
          } catch (error) {
            if (managed && workspace.createIfMissing && !existed && dependencies.managedWorkspaceRoot !== undefined) {
              await moveManagedWorkspaceToTrash({
                managedRoot: resolve(dependencies.managedWorkspaceRoot),
                workspaceRoot: requestedRoot,
                targetId: id,
                operationId
              }).catch(() => undefined);
            }
            throw error;
          }
        }
      });
      const stored = dependencies.store.getTarget(id);
      await dependencies.workspaceService.register({
        id: workspaceId,
        root: stored.descriptor.workspaceRoot,
        displayName: stored.descriptor.displayName,
        trusted: stored.descriptor.trusted
      });
      return presented(execution);
    }
    case "updateTarget": {
      const existing = dependencies.store.getTarget(payload.value.targetId);
      const metadata = asRecord(existing.metadata);
      const { remoteWorkspace: _previousRemoteWorkspace, ...serviceNodeDescriptor } = existing.descriptor;
      let descriptor: import("@joko/core").TargetDescriptor;
      switch (payload.value.workspaceLocationUpdate.case) {
        case "remoteWorkspace": {
          if (dependencies.remoteHosts === undefined) {
            throw new ConnectError("Remote workspace binding is unavailable.", Code.Unimplemented);
          }
          const remoteWorkspace = fromProtoRemoteWorkspace(payload.value.workspaceLocationUpdate.value);
          const host = dependencies.remoteHosts.get(existing.descriptor.id, remoteWorkspace.hostId);
          if (host.status.state !== "ready" || host.trust === undefined) {
            throw new ConnectError(
              "Test and trust the Remote Host before binding this target.",
              Code.FailedPrecondition
            );
          }
          descriptor = { ...serviceNodeDescriptor, remoteWorkspace };
          break;
        }
        case "serviceNodeWorkspace":
          if (!payload.value.workspaceLocationUpdate.value) {
            throw new ConnectError("service_node_workspace must be true.", Code.InvalidArgument);
          }
          descriptor = serviceNodeDescriptor;
          break;
        default:
          descriptor = existing.descriptor;
      }
      if (payload.value.displayName !== undefined) {
        descriptor = { ...descriptor, displayName: payload.value.displayName };
      }
      const execution = await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        commit: (store) => {
          store.upsertTarget(descriptor, { ...metadata, ...(payload.value.pinned === undefined ? {} : { pinned: payload.value.pinned }) });
          return { accepted: true, resultCase: "target", entityId: descriptor.id } satisfies OperationOutcome;
        }
      });
      const stored = dependencies.store.getTarget(descriptor.id);
      const storedMetadata = asRecord(stored.metadata);
      const workspaceId = stringValue(storedMetadata["workspaceId"]) ?? stored.descriptor.id;
      const binding = stored.descriptor.remoteWorkspace;
      await dependencies.workspaceService.register({
        id: workspaceId,
        root: binding?.workspaceRoot ?? stored.descriptor.workspaceRoot,
        displayName: stored.descriptor.displayName,
        trusted: stored.descriptor.trusted,
        ...(binding === undefined ? {} : {
          remote: {
            targetId: stored.descriptor.id,
            hostId: binding.hostId,
            workspaceRoot: binding.workspaceRoot
          }
        })
      });
      return presented(execution);
    }
    case "archiveTarget": {
      const existing = dependencies.store.getTarget(payload.value.targetId);
      const execution = await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        commit: (store) => {
          store.upsertTarget(existing.descriptor, {
            ...asRecord(existing.metadata),
            state: payload.value.archived ? "archived" : "active",
            archivedAt: payload.value.archived ? Date.now() : undefined
          });
          return { accepted: true, resultCase: "target", entityId: existing.descriptor.id } satisfies OperationOutcome;
        }
      });
      return presented(execution);
    }
    case "deleteTarget": {
      const existing = dependencies.store.getTarget(payload.value.targetId);
      const metadata = asRecord(existing.metadata);
      const workspaceId = stringValue(metadata["workspaceId"]) ?? existing.descriptor.id;
      const sessions = dependencies.store.listSessions({
        targetId: existing.descriptor.id,
        includeArchived: true,
        includeDeleted: true
      }).filter((item) => item.descriptor.deletedAt === undefined);
      if (sessions.length > 0 && !payload.value.deleteProductSessions) {
        throw new ConnectError("Target still owns product sessions; set delete_product_sessions to tombstone them.", Code.FailedPrecondition);
      }
      if (payload.value.deleteManagedWorkspace && !existing.descriptor.managed) {
        throw new ConnectError("Only a service-created managed workspace can be moved to managed trash.", Code.FailedPrecondition);
      }
      if (payload.value.deleteManagedWorkspace && dependencies.managedWorkspaceRoot === undefined) {
        throw new ConnectError("The managed workspace trash root is not configured.", Code.FailedPrecondition);
      }
      const deletedAt = Date.now();
      let trashedPath: string | undefined;
      const assertDeletionPrecondition = (store: OperationalStore): void => {
        const current = store.getTarget(existing.descriptor.id);
        if (current.revision !== existing.revision) {
          throw new RevisionConflictError("Target", current.descriptor.id, existing.revision, current.revision);
        }
        const currentSessions = store.listSessions({
          targetId: existing.descriptor.id,
          includeArchived: true,
          includeDeleted: true
        }).filter((item) => item.descriptor.deletedAt === undefined);
        if (
          currentSessions.length !== sessions.length ||
          currentSessions.some((item, index) => item.descriptor.id !== sessions[index]?.descriptor.id)
        ) {
          throw new InvalidStateTransitionError("Target session graph", "changed", "delete");
        }
      };
      const execution = await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        precondition: assertDeletionPrecondition,
        ...(payload.value.deleteManagedWorkspace || sessions.some((session) => session.descriptor.worktree !== undefined) ? {
          effect: async () => {
            // Stop native runtimes before moving their cwd on platforms that
            // hold directory handles. Closing a UI is never used as a proxy.
            for (const session of sessions) {
              if (payload.value.deleteManagedWorkspace || session.descriptor.worktree !== undefined) {
                await host.close(session.descriptor.id);
              }
              if (session.descriptor.worktree !== undefined) {
                if (dependencies.sessionWorktrees === undefined) throw new ConnectError("Isolated workspace cleanup is unavailable.", Code.FailedPrecondition);
                await dependencies.sessionWorktrees.release(session.descriptor.id);
              }
            }
            if (payload.value.deleteManagedWorkspace) {
              const trashed = await moveManagedWorkspaceToTrash({
                managedRoot: resolve(dependencies.managedWorkspaceRoot!),
                workspaceRoot: existing.descriptor.workspaceRoot,
                targetId: existing.descriptor.id,
                operationId
              });
              trashedPath = trashed.trashedPath;
              dependencies.workspaceService.unregister(workspaceId);
            }
          }
        } : {}),
        commit: (store) => {
          assertDeletionPrecondition(store);
          for (const item of sessions) {
            store.updateSession(item.descriptor.id, { archived: true, deletedAt }, item.revision, deletedAt);
          }
          store.upsertTarget(existing.descriptor, {
            ...metadata,
            state: "archived",
            deletedAt,
            deletionReason: payload.value.deleteManagedWorkspace ? "managed workspace moved to trash" : "target deleted",
            ...(trashedPath === undefined ? {} : { managedWorkspaceTrashPath: trashedPath, deletionOperationId: operationId })
          });
          return { accepted: true, resultCase: "target", entityId: existing.descriptor.id } satisfies OperationOutcome;
        }
      });
      dependencies.workspaceService.unregister(workspaceId);
      return presented(execution);
    }
    case "createSession": {
      const target = dependencies.store.getTarget(payload.value.targetId);
      if (payload.value.backendId === "" || payload.value.backendId !== target.descriptor.backendId) {
        throw invalidArgument("create_session.backend_id must match the selected Target backend");
      }
      const nativeStart = payload.value.nativeStart?.kind;
      const initialPlacement = payload.value.initialPlacement === contract.NativeSessionPlacement.DIALOGUE
        ? "dialogue"
        : payload.value.initialPlacement === contract.NativeSessionPlacement.UNSPECIFIED
          || payload.value.initialPlacement === contract.NativeSessionPlacement.PROJECT
          ? "project"
          : undefined;
      if (initialPlacement === undefined) {
        throw invalidArgument("create_session.initial_placement is invalid");
      }
      if (initialPlacement === "dialogue" && (nativeStart?.case === "clone" || nativeStart?.case === "fork")) {
        throw invalidArgument("create_session.initial_placement dialogue is unavailable for derived tasks");
      }
      const worktreeSourceRef = payload.value.worktreeSourceRef;
      if (payload.value.useWorktree) {
        const freshNativeStart = nativeStart?.case === undefined
          || (nativeStart.case === "newSession" && nativeStart.value.parentNativeReference === "");
        if (!freshNativeStart) {
          throw invalidArgument("create_session.use_worktree requires a fresh native Session without a parent");
        }
        if (dependencies.sessionWorktrees === undefined) {
          throw new ConnectError("Isolated workspaces are unavailable.", Code.Unimplemented);
        }
        if (worktreeSourceRef !== undefined && (
          worktreeSourceRef === "" || worktreeSourceRef !== worktreeSourceRef.trim()
          || worktreeSourceRef.length > 1_024 || /[\p{Cc}\u2028\u2029]/u.test(worktreeSourceRef)
        )) {
          throw invalidArgument("create_session.worktree_source_ref is invalid");
        }
      } else if (worktreeSourceRef !== undefined || payload.value.refreshWorktreeRemote) {
        throw invalidArgument("create_session Worktree options require use_worktree");
      }
      const catalogImportValue = payload.value.catalogImport;
      let catalogImport: {
        readonly projectId?: string;
        readonly archived: boolean;
        readonly createdAt: number;
        readonly modifiedAt: number;
        readonly snapshotToken: string;
      } | undefined;
      if (catalogImportValue !== undefined) {
        if (nativeStart?.case !== "attach" || payload.value.useWorktree) {
          throw invalidArgument("create_session.catalog_import requires a non-Worktree native attach");
        }
        if (initialPlacement === "dialogue" && catalogImportValue.projectId !== undefined) {
          throw invalidArgument("create_session.catalog_import dialogue cannot name a project");
        }
        if (initialPlacement === "project" && catalogImportValue.projectId === undefined) {
          throw invalidArgument("create_session.catalog_import project requires a project Target");
        }
        if (catalogImportValue.projectId !== undefined) {
          const projectTarget = dependencies.store.getTarget(catalogImportValue.projectId);
          if (projectTarget.descriptor.backendId !== target.descriptor.backendId) {
            throw invalidArgument("create_session.catalog_import project must use the selected Backend");
          }
        }
        const modifiedAt = fromProtoTimestamp(
          catalogImportValue.modifiedAt,
          "create_session.catalog_import.modified_at"
        );
        if (modifiedAt === undefined) {
          throw invalidArgument("create_session.catalog_import.modified_at is required");
        }
        const createdAt = fromProtoTimestamp(
          catalogImportValue.createdAt,
          "create_session.catalog_import.created_at"
        );
        if (createdAt === undefined || createdAt > modifiedAt) {
          throw invalidArgument("create_session.catalog_import.created_at is invalid");
        }
        if (!validNativeCatalogSnapshotToken(catalogImportValue.snapshotToken)) {
          throw invalidArgument("create_session.catalog_import.snapshot_token is invalid");
        }
        catalogImport = {
          ...(catalogImportValue.projectId === undefined ? {} : { projectId: catalogImportValue.projectId }),
          archived: catalogImportValue.archived,
          createdAt,
          modifiedAt,
          snapshotToken: catalogImportValue.snapshotToken
        };
      }
      const requestedAppendSystemPrompt = payload.value.appendSystemPrompt;
      if ((requestedAppendSystemPrompt?.length ?? 0) > 8_000) {
        throw invalidArgument("create_session.append_system_prompt cannot exceed 8,000 characters");
      }
      if (requestedAppendSystemPrompt?.includes("\0") === true) {
        throw invalidArgument("create_session.append_system_prompt cannot contain NUL characters");
      }
      // Personalization is sampled only into a newly created native task.
      // Attach/clone/fork retain the native/source task's original launch state.
      const appendSystemPrompt = nativeStart?.case === "attach"
        || nativeStart?.case === "clone"
        || nativeStart?.case === "fork"
        || requestedAppendSystemPrompt === ""
        ? undefined
        : requestedAppendSystemPrompt;
      const model = payload.value.model;
      const requestedModel = model?.model;
      if (requestedModel !== undefined) {
        const advertised = dependencies.store.getBackend(payload.value.backendId).descriptor.models.some((candidate) =>
          candidate.providerId === requestedModel.providerId && candidate.modelId === requestedModel.modelId);
        if (!advertised) {
          throw new ConnectError("The selected model is not advertised by this Backend instance.", Code.FailedPrecondition);
        }
        if (!modelRoutingEnabled(
          dependencies.store,
          payload.value.backendId,
          requestedModel.providerId,
          requestedModel.modelId
        )) {
          throw new ConnectError("The selected model is disabled in model access settings.", Code.FailedPrecondition);
        }
      }
      const nestedId = nestedOperationId(payload.case, operationId);
      const sessionId = stableId("session", nestedId);
      const outcome = { accepted: true, resultCase: "session", entityId: sessionId } satisfies OperationOutcome;
      if (nativeStart?.case === "clone" || nativeStart?.case === "fork") {
        const sourceId = nativeStart.value.sourceProductSessionId;
        const sourceMessage = derivationSourceMessageInput(
          nativeStart.value.sourceMessageId,
          nativeStart.value.sourceEventId,
          "create_session.native_start"
        );
        const source = dependencies.store.getSession(sourceId);
        if (
          source.descriptor.backendId !== payload.value.backendId ||
          source.descriptor.targetId !== payload.value.targetId
        ) {
          throw invalidArgument("create_session native source must belong to the selected Backend and Target");
        }
        if (nativeStart.case === "fork" && nativeStart.value.nativeEntryId.trim() === "") {
          throw invalidArgument("create_session.native_start.fork.native_entry_id is required");
        }
        const execution = await host.mutate({
          operationId,
          connection,
          kind: payload.case,
          body: mutation,
          commit: () => outcome,
          effect: async () => {
            const nested = await dependencies.sessionHost.deriveSession({
              operationId: nestedId,
              connection,
              sourceSessionId: sourceId,
              title: payload.value.displayName || "",
              kind: nativeStart.case === "fork" ? "fork" : "clone",
              ...(nativeStart.case === "fork" ? { entryId: nativeStart.value.nativeEntryId } : {}),
              ...(sourceMessage === undefined ? {} : { sourceMessage })
            });
            if (nested.value.sessionId !== sessionId) throw new Error("CreateSession derive returned a non-deterministic Session ID.");
          }
        });
        return presented(execution);
      }
      const execution = await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        commit: () => outcome,
        effect: async () => {
          const nested = await dependencies.sessionHost.createSession({
            operationId: nestedId,
            connection,
            targetId: payload.value.targetId,
            title: payload.value.displayName || "New task",
            ...(model?.model?.providerId === undefined ? {} : { providerId: model.model.providerId }),
            ...(model?.model?.modelId === undefined ? {} : { modelId: model.model.modelId }),
            ...(model?.effortId === undefined || model.effortId === "" ? {} : { effort: model.effortId }),
            fastMode: model?.fastMode ?? false,
            permissionMode: corePermission(payload.value.permissionMode),
            planMode: payload.value.planMode,
            initialPlacement,
            ...(catalogImport === undefined ? {} : { catalogImport }),
            ...(payload.value.useWorktree ? {
              worktree: {
                ...(worktreeSourceRef === undefined ? {} : { sourceRef: worktreeSourceRef }),
                refreshRemote: payload.value.refreshWorktreeRemote
              }
            } : {}),
            ...(appendSystemPrompt === undefined ? {} : { appendSystemPrompt }),
            nativeStart: nativeStart?.case === "attach"
              ? { kind: "attach", nativeReference: nativeStart.value.opaqueNativeReference }
              : {
                  kind: "new",
                  ...(nativeStart?.case === "newSession" && nativeStart.value.parentNativeReference !== ""
                    ? { parentNativeReference: nativeStart.value.parentNativeReference }
                    : {})
                }
          });
          if (nested.value.sessionId !== sessionId) throw new Error("CreateSession returned a non-deterministic Session ID.");
        }
      });
      return presented(execution);
    }
    case "resumeSession":
      return ackOperation(dependencies, operationId, connection, mutation, payload.case, () => host.resume(payload.value.sessionId).then(() => undefined));
    case "detachSession":
      return ackOperation(dependencies, operationId, connection, mutation, payload.case, () => host.detach(payload.value.sessionId));
    case "closeSession":
      return ackOperation(dependencies, operationId, connection, mutation, payload.case, () => host.close(payload.value.sessionId));
    case "resetSession": {
      if (payload.value.sessionId.trim() === "") throw invalidArgument("reset_session.session_id is required");
      const execution = await host.resetSession({
        operationId,
        connection,
        sessionId: payload.value.sessionId,
        body: mutation,
        precondition: (store) => validatePreconditions(store, mutation),
        result: (session) => ({
          accepted: true,
          resultCase: "session",
          entityId: session.descriptor.id
        } satisfies OperationOutcome)
      });
      return presented(execution);
    }
    case "deleteSessionMessage": {
      if (payload.value.sessionId.trim() === "") throw invalidArgument("delete_session_message.session_id is required");
      if (payload.value.eventId.trim() === "") throw invalidArgument("delete_session_message.event_id is required");
      const execution = await host.deleteSessionMessage({
        operationId,
        connection,
        sessionId: payload.value.sessionId,
        eventId: payload.value.eventId,
        body: mutation,
        precondition: (store) => validatePreconditions(store, mutation),
        result: () => ({ accepted: true, resultCase: "acknowledgement" } satisfies OperationOutcome)
      });
      return presented(execution);
    }
    case "renameSession": {
      const execution = await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        commit: (store) => {
          store.updateSession(payload.value.sessionId, { title: payload.value.displayName });
          return { accepted: true, resultCase: "session", entityId: payload.value.sessionId } satisfies OperationOutcome;
        },
        effect: () => host.setName(payload.value.sessionId, payload.value.displayName)
      });
      return presented(execution);
    }
    case "pinSession":
      return updateSessionOperation(
        dependencies,
        operationId,
        connection,
        mutation,
        payload.case,
        payload.value.sessionId,
        { pinned: payload.value.pinned },
        payload.value.pinned
          ? async () => dependencies.sessionNavigation?.refreshSummary(payload.value.sessionId, true)
          : undefined
      );
    case "archiveSession": {
      const existing = dependencies.store.getSession(payload.value.sessionId);
      if (!payload.value.archived) {
        return updateSessionOperation(
          dependencies,
          operationId,
          connection,
          mutation,
          payload.case,
          payload.value.sessionId,
          { archived: false },
          existing.descriptor.worktree?.state === "preserved"
            ? async () => {
                if (dependencies.sessionWorktrees === undefined) {
                  throw new ConnectError("Isolated workspace lifecycle is unavailable.", Code.FailedPrecondition);
                }
                await dependencies.sessionWorktrees.restore(payload.value.sessionId);
              }
            : undefined
        );
      }
      let cleanup: SessionLifecycleCleanupRecord | undefined;
      try {
        const execution = await host.mutate({
          operationId,
          connection,
          kind: payload.case,
          body: mutation,
          sessionLifecycleFenceId: payload.value.sessionId,
          precondition: (store) => {
            assertSessionArchiveIdle(store, payload.value.sessionId);
            try {
              dependencies.sessionHost.assertSessionLifecycleIdle(payload.value.sessionId);
            } catch (error) {
              if (error instanceof StoreError) throw new ConnectError(error.message, Code.FailedPrecondition);
              throw error;
            }
          },
          effect: async () => {
            cleanup = dependencies.store.findSessionLifecycleCleanup(operationId)
              ?? dependencies.store.prepareSessionLifecycleCleanup({
                operationId,
                sessionId: payload.value.sessionId,
                disposition: "archive",
                releaseWorktree: existing.descriptor.worktree !== undefined,
                at: (dependencies.now ?? Date.now)()
              });
            cleanup = await advanceSessionLifecycleCleanup(dependencies, cleanup);
          },
          commit: (store) => {
            const completed = store.finalizeSessionLifecycleCleanup({
              operationId,
              at: (dependencies.now ?? Date.now)()
            });
            return sessionLifecycleOperationOutcome(completed);
          },
          preserveClaimOnEffectFailure: () =>
            dependencies.store.findSessionLifecycleCleanup(operationId)?.state === "pending"
        });
        return presented(execution);
      } catch (error) {
        if (dependencies.store.findSessionLifecycleCleanup(operationId)?.state === "pending") {
          schedulePendingSessionLifecycleRetry(dependencies, operationId);
          throw new OperationInProgressError(operationId);
        }
        throw error;
      }
    }
    case "acknowledgeSessionAttention": {
      if (payload.value.sessionId.trim() === "") {
        throw invalidArgument("acknowledge_session_attention.session_id is required");
      }
      const session = dependencies.store.getSession(payload.value.sessionId);
      const backend = dependencies.store.getBackend(session.descriptor.backendId).descriptor;
      if (backend.capabilities.get("session.attention")?.supported !== true) {
        return unsupportedOperation(
          dependencies,
          operationId,
          connection,
          mutation,
          payload.case,
          "Backend does not support session.attention."
        );
      }
      const through = fromProtoEventCursor(payload.value.throughCursor);
      if (through.sequence <= 0n || through.generation > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw invalidArgument("acknowledge_session_attention.through_cursor is outside the supported range");
      }
      const intent = payload.value.intent === contract.SessionAttentionAcknowledgementIntent.VIEWED
        ? "viewed"
        : payload.value.intent === contract.SessionAttentionAcknowledgementIntent.EXPLICIT
          ? "explicit"
          : undefined;
      if (intent === undefined) {
        throw invalidArgument("acknowledge_session_attention.intent is required");
      }
      const execution = await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        commit: (store) => {
          store.acknowledgeSessionAttention({
            sessionId: payload.value.sessionId,
            throughCursor: through.sequence,
            generation: Number(through.generation),
            intent,
            traceId: `attention-ack:${operationId}`,
            operationId
          });
          return {
            accepted: true,
            resultCase: "sessionAttention",
            entityId: payload.value.sessionId
          } satisfies OperationOutcome;
        }
      });
      return presented(execution);
    }
    case "deleteSession": {
      const existing = dependencies.store.getSession(payload.value.sessionId);
      const releaseWorktree = existing.descriptor.worktree !== undefined;
      try {
        const execution = await host.mutate({
          operationId,
          connection,
          kind: payload.case,
          body: mutation,
          sessionLifecycleFenceId: payload.value.sessionId,
          effect: async () => {
            let cleanup = dependencies.store.findSessionLifecycleCleanup(operationId)
              ?? dependencies.store.prepareSessionLifecycleCleanup({
                operationId,
                sessionId: payload.value.sessionId,
                disposition: "delete",
                deleteNativeSession: payload.value.deleteNativeSession,
                deleteArtifacts: payload.value.deleteArtifacts,
                releaseWorktree,
                cleanupGitSafety: dependencies.gitSafety !== undefined,
                at: (dependencies.now ?? Date.now)()
              });
            cleanup = await advanceSessionLifecycleCleanup(dependencies, cleanup);
          },
          commit: (store) => {
            const completed = store.finalizeSessionLifecycleCleanup({
              operationId,
              at: (dependencies.now ?? Date.now)()
            });
            return sessionLifecycleOperationOutcome(completed);
          },
          preserveClaimOnEffectFailure: () =>
            dependencies.store.findSessionLifecycleCleanup(operationId)?.state === "pending"
        });
        return presented(execution);
      } catch (error) {
        if (dependencies.store.findSessionLifecycleCleanup(operationId)?.state === "pending") {
          schedulePendingSessionLifecycleRetry(dependencies, operationId);
          throw new OperationInProgressError(operationId);
        }
        throw error;
      }
    }
    case "forkSession": {
      const sourceMessage = derivationSourceMessageInput(
        payload.value.sourceMessageId,
        payload.value.sourceEventId,
        "fork_session"
      );
      const nestedId = nestedOperationId(payload.case, operationId);
      const sessionId = stableId("session", nestedId);
      const execution = await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        commit: () => ({ accepted: true, resultCase: "session", entityId: sessionId } satisfies OperationOutcome),
        effect: async () => {
          const nested = await host.deriveSession({
            operationId: nestedId,
            connection,
            sourceSessionId: payload.value.sourceSessionId,
            title: payload.value.newDisplayName || "",
            kind: "fork",
            entryId: payload.value.nativeEntryId,
            ...(sourceMessage === undefined ? {} : { sourceMessage })
          });
          if (nested.value.sessionId !== sessionId) throw new Error("ForkSession returned a non-deterministic Session ID.");
        }
      });
      return presented(execution);
    }
    case "cloneSession": {
      const sourceMessage = derivationSourceMessageInput(
        payload.value.sourceMessageId,
        payload.value.sourceEventId,
        "clone_session"
      );
      const nestedId = nestedOperationId(payload.case, operationId);
      const sessionId = stableId("session", nestedId);
      const execution = await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        commit: () => ({ accepted: true, resultCase: "session", entityId: sessionId } satisfies OperationOutcome),
        effect: async () => {
          const nested = await host.deriveSession({
            operationId: nestedId,
            connection,
            sourceSessionId: payload.value.sourceSessionId,
            title: payload.value.newDisplayName || "",
            kind: "clone",
            ...(sourceMessage === undefined ? {} : { sourceMessage })
          });
          if (nested.value.sessionId !== sessionId) throw new Error("CloneSession returned a non-deterministic Session ID.");
        }
      });
      return presented(execution);
    }
    case "navigateSessionBranch": {
      if (payload.value.sessionId.trim() === "") throw invalidArgument("navigate_session_branch.session_id is required");
      if (payload.value.nativeEntryId.trim() === "") throw invalidArgument("navigate_session_branch.native_entry_id is required");
      const customInstructions = payload.value.customInstructions.trim();
      if (customInstructions.length > 4_000) {
        throw invalidArgument("navigate_session_branch.custom_instructions must not exceed 4000 characters");
      }
      return ackOperation(
        dependencies,
        operationId,
        connection,
        mutation,
        payload.case,
        () => host.navigateTree(
          payload.value.sessionId,
          payload.value.nativeEntryId,
          payload.value.summarize,
          payload.value.summarize && customInstructions !== "" ? customInstructions : undefined
        )
      );
    }
    case "compactSession": {
      let compactSessionOutcome: "compacted" | "noop" | undefined;
      return presented(await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        effect: async () => {
          compactSessionOutcome = await host.compact(
            payload.value.sessionId,
            payload.value.customInstructions || undefined
          );
        },
        commit: () => {
          if (compactSessionOutcome === undefined) {
            throw new Error("The Backend returned no compact Session outcome.");
          }
          return {
            accepted: true,
            resultCase: "compactSession",
            compactSessionOutcome
          } satisfies OperationOutcome;
        }
      }));
    }
    case "exportSession": {
      if (payload.value.sessionId.trim() === "") throw invalidArgument("export_session.session_id is required");
      if (payload.value.format !== contract.SessionExportFormat.HTML) {
        throw invalidArgument("export_session.format must be HTML");
      }
      let artifact: BlobRef | undefined;
      const execution = await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        effect: async () => {
          artifact = await host.exportSession(payload.value.sessionId);
          if (artifact.mimeType.split(";", 1)[0]?.trim().toLowerCase() !== "text/html") {
            throw new Error("The Backend returned a non-HTML Session export artifact.");
          }
        },
        commit: (store) => {
          if (artifact === undefined) throw new Error("The Backend returned no Session export artifact.");
          const durable = store.getArtifact(artifact.id).blob;
          assertBlobRefIdentity(artifact, durable, "Session export");
          return { accepted: true, resultCase: "artifact", entityId: artifact.id } satisfies OperationOutcome;
        }
      });
      return presented(execution);
    }
    case "setSessionModel": {
      const model = payload.value.model;
      const modelKey = model?.model;
      if (model === undefined || modelKey === undefined) return unsupportedOperation(dependencies, operationId, connection, mutation, payload.case, "Model selection is required.");
      const stored = dependencies.store.getSession(payload.value.sessionId);
      const selectedModel = dependencies.store.getBackend(stored.descriptor.backendId).descriptor.models.find((candidate) =>
        candidate.providerId === modelKey.providerId && candidate.modelId === modelKey.modelId);
      if (selectedModel === undefined) {
        throw new ConnectError("The selected model is not advertised by this Backend instance.", Code.FailedPrecondition);
      }
      if (!modelRoutingEnabled(
        dependencies.store,
        stored.descriptor.backendId,
        modelKey.providerId,
        modelKey.modelId
      )) {
        throw new ConnectError("The selected model is disabled in model access settings.", Code.FailedPrecondition);
      }
      const axisOnly = stored.descriptor.providerId === modelKey.providerId
        && stored.descriptor.modelId === modelKey.modelId;
      let resolved: {
        readonly providerId: string;
        readonly modelId: string;
        readonly effort: string | null;
        readonly fastMode: boolean;
      } | undefined;
      const execution = await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        effect: async () => {
          const state = axisOnly
            ? await host.applyUserSessionRuntimeAxes(payload.value.sessionId, {
                effort: selectedModel?.thinkingLevels.length === 0
                  ? null
                  : model.effortId || undefined,
                fastMode: model.fastMode
              })
            : await host.applySessionSettings(payload.value.sessionId, {
                providerId: modelKey.providerId,
                modelId: modelKey.modelId,
                effort: model.effortId || undefined,
                fastMode: model.fastMode
              }, { requireNativeObservation: true });
          if (
            state === undefined || state.providerId !== modelKey.providerId ||
            state.modelId !== modelKey.modelId
          ) {
            throw new JokoError({
              code: "MODEL_SELECTION_NOT_APPLIED",
              message: "The Backend did not report the requested model after applying the selection.",
              phase: "model",
              retryable: true,
              stateMayHaveChanged: true,
              recovery: "Refresh the task and choose the model again after the Backend catalog is current."
            });
          }
          resolved = {
            providerId: state.providerId,
            modelId: state.modelId,
            // A model with no public effort choices must not retain an effort
            // from the previous model and replay it during the next activation.
            effort: selectedModel?.thinkingLevels.length === 0 ? null : state.effort ?? null,
            fastMode: state.fastMode
          };
        },
        commit: (store) => {
          if (resolved === undefined) throw new Error("The resolved Backend model selection is missing.");
          store.updateSession(payload.value.sessionId, resolved);
          return { accepted: true, resultCase: "session", entityId: payload.value.sessionId } satisfies OperationOutcome;
        }
      });
      if (!execution.replayed && !axisOnly) host.recordUserSessionRuntimeSelection(payload.value.sessionId);
      return presented(execution);
    }
    case "setSessionPermission": {
      const mode = corePermission(payload.value.permissionMode);
      return updateSessionOperation(dependencies, operationId, connection, mutation, payload.case, payload.value.sessionId, { permissionMode: mode }, async () => {
        await host.applySessionSettings(payload.value.sessionId, { permissionMode: mode });
      });
    }
    case "setSessionPlanMode":
      return updateSessionOperation(dependencies, operationId, connection, mutation, payload.case, payload.value.sessionId, { planMode: payload.value.enabled }, async () => {
        await host.applySessionSettings(payload.value.sessionId, { planMode: payload.value.enabled });
      });
    case "moveSessionProject": {
      const sessionId = payload.value.sessionId;
      const projectId = payload.value.projectId;
      let catalogImport: {
        readonly title?: string;
        readonly archived: boolean;
        readonly modifiedAt: number;
        readonly snapshotToken: string;
      } | undefined;
      if (payload.value.catalogImport !== undefined) {
        const modifiedAt = fromProtoTimestamp(
          payload.value.catalogImport.modifiedAt,
          "move_session_project.catalog_import.modified_at"
        );
        if (modifiedAt === undefined) {
          throw invalidArgument("move_session_project.catalog_import.modified_at is required");
        }
        if (!validNativeCatalogSnapshotToken(payload.value.catalogImport.snapshotToken)) {
          throw invalidArgument("move_session_project.catalog_import.snapshot_token is invalid");
        }
        catalogImport = {
          archived: payload.value.catalogImport.archived,
          modifiedAt,
          snapshotToken: payload.value.catalogImport.snapshotToken
        };
      }
      let validatedCatalogImport: {
        readonly title: string;
        readonly archived: boolean;
        readonly modifiedAt: number;
      } | undefined;
      const execution = await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        ...(catalogImport === undefined ? {} : {
          effect: async () => {
            validatedCatalogImport = await (host as ExtendedSessionHost).validateCatalogSessionReclassification({
              sessionId,
              ...(projectId === undefined ? {} : { projectId }),
              archived: catalogImport.archived,
              modifiedAt: catalogImport.modifiedAt,
              snapshotToken: catalogImport.snapshotToken
            });
          }
        }),
        commit: (store) => {
          validatePreconditions(store, mutation);
          if (catalogImport !== undefined && validatedCatalogImport === undefined) {
            throw new Error("Catalog reclassification completed without an authoritative presentation.");
          }
          const presentation = validatedCatalogImport;
          const plan = placementPlanOrThrow({
            store,
            sessionId,
            ...(projectId === undefined ? {} : { projectId })
          });
          const session = plan.kind === "unchanged"
            ? store.getSession(sessionId)
            : store.moveSessionProject({
                sessionId: plan.sessionId,
                expectedRevision: plan.expectedRevision,
                ...(plan.projectId === undefined ? {} : { projectId: plan.projectId }),
                ...(presentation === undefined ? {} : { movedAt: presentation.modifiedAt })
              });
          const presentationPatch = presentation === undefined
            ? {}
            : {
                ...(session.descriptor.title === presentation.title ? {} : { title: presentation.title }),
                ...(session.descriptor.archived === presentation.archived ? {} : { archived: presentation.archived })
              };
          const presentedSession = Object.keys(presentationPatch).length === 0
            ? session
            : store.updateSession(
                session.descriptor.id,
                presentationPatch,
                session.revision,
                presentation?.modifiedAt ?? session.descriptor.updatedAt
              );
          return {
            accepted: true,
            resultCase: "session",
            entityId: presentedSession.descriptor.id
          } satisfies OperationOutcome;
        }
      });
      return presented(execution);
    }
    case "sendInput": {
      const disposition = deliveryMode(payload.value.deliveryMode);
      const prompt = fromProtoInputContent(payload.value.input, disposition);
      const overrides = coreTurnOverrides(payload.value.overrides);
      const nestedId = nestedOperationId(payload.case, operationId);
      const queueItemId = stableId("queue", nestedId);
      const execution = await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        commit: () => ({ accepted: true, resultCase: "queueItem", entityId: queueItemId } satisfies OperationOutcome),
        effect: async () => {
          const nested = dependencies.sessionHost.enqueueInput({
            operationId: nestedId,
            connection,
            sessionId: payload.value.sessionId,
            prompt,
            ...(overrides === undefined ? {} : { overrides })
          });
          if (nested.value.queueItemId !== queueItemId) throw new Error("SendInput returned a non-deterministic Queue Item ID.");
          dependencies.sessionNavigation?.observeAcceptedPrompt(payload.value.sessionId, prompt);
        }
      });
      return presented(execution);
    }
    case "abortRun": {
      const run = dependencies.store.getRun(payload.value.runId);
      return ackOperation(dependencies, operationId, connection, mutation, payload.case, () => host.abort(run.descriptor.sessionId, run.descriptor.id));
    }
    case "terminateRuntimeProcess": {
      const backendId = strictRuntimeProcessIdentity(payload.value.backendId, "terminate_runtime_process.backend_id");
      const sessionId = strictRuntimeProcessIdentity(payload.value.sessionId, "terminate_runtime_process.session_id");
      const runtimeGeneration = safeContractGeneration(
        payload.value.runtimeGeneration,
        "terminate_runtime_process.runtime_generation"
      );
      const processId = safeContractGeneration(payload.value.processId, "terminate_runtime_process.process_id");
      const processInstanceId = payload.value.processInstanceId;
      if (!validRuntimeProcessInstanceId(processInstanceId)) {
        throw invalidArgument("terminate_runtime_process.process_instance_id is invalid");
      }
      const session = dependencies.store.getSession(sessionId);
      if (session.descriptor.backendId !== backendId) {
        throw invalidArgument("terminate_runtime_process Backend does not own the Session");
      }
      const backend = dependencies.store.getBackend(backendId).descriptor;
      if (backend.capabilities.get(contract.capabilityNames.runtimeProcessTerminate)?.supported !== true) {
        return unsupportedOperation(
          dependencies,
          operationId,
          connection,
          mutation,
          payload.case,
          `Backend does not support ${contract.capabilityNames.runtimeProcessTerminate}.`
        );
      }
      const assertFence = (store: OperationalStore): void => {
        const current = store.getSession(sessionId);
        if (current.descriptor.backendId !== backendId) {
          throw new StoreError("Runtime process Backend ownership changed.");
        }
        if (current.descriptor.binding.generation !== runtimeGeneration) {
          throw new StaleGenerationError(runtimeGeneration, current.descriptor.binding.generation);
        }
        if (store.getBackend(backendId).descriptor.capabilities
          .get(contract.capabilityNames.runtimeProcessTerminate)?.supported !== true) {
          throw new StoreError("Runtime process termination capability changed.");
        }
      };
      const execution = await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        precondition: assertFence,
        effect: () => dependencies.runtimeProcesses.terminate({
          backendId,
          sessionId,
          generation: runtimeGeneration,
          pid: processId,
          processInstanceId
        }),
        commit: () => ({ accepted: true, resultCase: "acknowledgement" } satisfies OperationOutcome)
      });
      return presented(execution);
    }
    case "cancelBackgroundTask": {
      if (payload.value.sessionId.trim() === "") {
        throw invalidArgument("cancel_background_task.session_id is required");
      }
      if (payload.value.backgroundTaskId.trim() === "") {
        throw invalidArgument("cancel_background_task.background_task_id is required");
      }
      const session = dependencies.store.getSession(payload.value.sessionId);
      const backend = dependencies.store.getBackend(session.descriptor.backendId).descriptor;
      if (backend.capabilities.get(contract.capabilityNames.backgroundTasksCancel)?.supported !== true) {
        return unsupportedOperation(
          dependencies,
          operationId,
          connection,
          mutation,
          payload.case,
          `Backend does not support ${contract.capabilityNames.backgroundTasksCancel}.`
        );
      }
      return ackOperation(
        dependencies,
        operationId,
        connection,
        mutation,
        payload.case,
        () => host.cancelBackgroundTask(
          payload.value.sessionId,
          payload.value.backgroundTaskId,
          operationId
        )
      );
    }
    case "controlSubagent": {
      const sessionId = payload.value.sessionId.trim();
      const runId = payload.value.subagentRunId.trim();
      const childId = payload.value.childId.trim();
      if (sessionId === "") throw invalidArgument("control_subagent.session_id is required");
      if (runId === "") throw invalidArgument("control_subagent.subagent_run_id is required");
      if (runId.length > 512 || childId.length > 512) {
        throw invalidArgument("control_subagent identities are too long");
      }
      const action = coreSubagentControlAction(payload.value.action);
      const message = payload.value.message.trim();
      if (action !== "stop" && (message === "" || message.length > 32_000)) {
        throw invalidArgument("control_subagent.message must contain 1..32000 characters");
      }
      if (action === "stop" && message !== "") {
        throw invalidArgument("control_subagent.message is not accepted for stop");
      }
      const capability = subagentControlCapability(action);
      const session = dependencies.store.getSession(sessionId);
      const backend = dependencies.store.getBackend(session.descriptor.backendId).descriptor;
      if (backend.capabilities.get(capability)?.supported !== true) {
        return unsupportedOperation(
          dependencies,
          operationId,
          connection,
          mutation,
          payload.case,
          `Backend does not support ${capability}.`
        );
      }
      return ackOperation(
        dependencies,
        operationId,
        connection,
        mutation,
        payload.case,
        () => host.controlSubagent(
          sessionId,
          {
            runId,
            ...(childId === "" ? {} : { childId }),
            action,
            ...(message === "" ? {} : { message })
          },
          operationId
        )
      );
    }
    case "retryRun": {
      const run = dependencies.store.getRun(payload.value.runId);
      if (run.descriptor.state !== "failed" || run.descriptor.error?.retryable !== true) {
        return unsupportedOperation(
          dependencies,
          operationId,
          connection,
          mutation,
          payload.case,
          "Only a retryable failed Run can be retried."
        );
      }
      const previous = dependencies.store.findQueueItemByRunId(run.descriptor.sessionId, run.descriptor.id);
      if (previous === undefined) return unsupportedOperation(dependencies, operationId, connection, mutation, payload.case, "The original durable queue input is unavailable.");
      if (dependencies.store.findRunByParentId(run.descriptor.id) !== undefined) {
        return unsupportedOperation(
          dependencies,
          operationId,
          connection,
          mutation,
          payload.case,
          "This Run already has a durable continuation."
        );
      }
      const nestedId = nestedOperationId(payload.case, operationId);
      const runId = stableId("run", nestedId);
      const execution = await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        precondition: (store) => {
          const current = store.getRun(run.descriptor.id).descriptor;
          if (current.state !== "failed" || current.error?.retryable !== true) {
            throw new StoreError("Only a retryable failed Run can be retried.");
          }
          const continuation = store.findRunByParentId(current.id);
          if (continuation !== undefined && continuation.descriptor.id !== runId) {
            throw new StoreError("This Run already has a durable continuation.");
          }
        },
        commit: () => ({ accepted: true, resultCase: "run", entityId: runId } satisfies OperationOutcome),
        effect: async () => {
          const nested = dependencies.sessionHost.enqueueInput({
            operationId: nestedId,
            connection,
            sessionId: run.descriptor.sessionId,
            prompt: previous.body,
            parentRunId: run.descriptor.id,
            ...(previous.executionOverrides === undefined ? {} : { overrides: previous.executionOverrides })
          });
          if (nested.value.runId !== runId) throw new Error("RetryRun returned a non-deterministic Run ID.");
        }
      });
      return presented(execution);
    }
    case "abortRetry": {
      const run = dependencies.store.getRun(payload.value.runId);
      return ackOperation(dependencies, operationId, connection, mutation, payload.case, () => host.abortRetry!(run.descriptor.sessionId));
    }
    case "setQueueItemEditLock": {
      const current = dependencies.store.getQueueItem(payload.value.queueItemId);
      if (payload.value.locked) {
        requireEntityVersionPrecondition(
          mutation,
          contract.EntityKind.QUEUE_ITEM,
          current.id,
          "set_queue_item_edit_lock"
        );
      }
      const run = dependencies.store.getRun(current.runId).descriptor;
      if (run.source !== "user" || run.parentRunId !== undefined) {
        return unsupportedOperation(
          dependencies,
          operationId,
          connection,
          mutation,
          payload.case,
          "Only user-created queued input can be edited."
        );
      }
      const execution = await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        commit: (store) => {
          store.setQueueItemEditLock({
            queueItemId: current.id,
            connectionId: connection.id,
            lockToken: payload.value.lockToken,
            locked: payload.value.locked,
            ttlMs: QUEUE_LOCK_TTL_MS,
            traceId: `operation:${operationId}:queue-edit-lock`
          });
          return { accepted: true, resultCase: "queueItem", entityId: current.id } satisfies OperationOutcome;
        }
      });
      if (payload.value.locked) {
        wakeQueueAfterLockExpiry(host, current.sessionId, () => {
          dependencies.store.expireQueueLocks({
            sessionId: current.sessionId,
            traceId: `queue:${current.sessionId}:lock-expiry`
          });
        });
      }
      else host.requestQueueDrain(current.sessionId);
      return presented(execution);
    }
    case "setQueueInteractionLock": {
      const sessionId = payload.value.sessionId.trim();
      if (sessionId === "") throw invalidArgument("set_queue_interaction_lock.session_id is required");
      if (payload.value.locked) {
        requireEntityVersionPrecondition(
          mutation,
          contract.EntityKind.QUEUE_CONTROL,
          sessionId,
          "set_queue_interaction_lock"
        );
      }
      const execution = await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        commit: (store) => {
          store.setQueueInteractionLock({
            sessionId,
            connectionId: connection.id,
            lockToken: payload.value.lockToken,
            locked: payload.value.locked,
            ttlMs: QUEUE_LOCK_TTL_MS,
            traceId: `operation:${operationId}:queue-interaction-lock`
          });
          return { accepted: true, resultCase: "queueControl", entityId: sessionId } satisfies OperationOutcome;
        }
      });
      if (payload.value.locked) {
        wakeQueueAfterLockExpiry(host, sessionId, () => {
          dependencies.store.expireQueueLocks({
            sessionId,
            traceId: `queue:${sessionId}:lock-expiry`
          });
        });
      }
      else host.requestQueueDrain(sessionId);
      return presented(execution);
    }
    case "cancelQueueItem": {
      const current = dependencies.store.getQueueItem(payload.value.queueItemId);
      requireEntityVersionPrecondition(mutation, contract.EntityKind.QUEUE_ITEM, current.id, "cancel_queue_item");
      if (current.state !== "accepted") {
        return unsupportedOperation(
          dependencies,
          operationId,
          connection,
          mutation,
          payload.case,
          "Only pending queued input can be cancelled."
        );
      }
      const execution = await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        commit: (store) => {
          store.cancelQueueItem({
            queueItemId: payload.value.queueItemId,
            connectionId: connection.id,
            traceId: `operation:${operationId}`
          });
          return { accepted: true, resultCase: "queueItem", entityId: payload.value.queueItemId } satisfies OperationOutcome;
        }
      });
      return presented(execution);
    }
    case "editQueueItem": {
      const current = dependencies.store.getQueueItem(payload.value.queueItemId);
      requireEntityVersionPrecondition(mutation, contract.EntityKind.QUEUE_ITEM, current.id, "edit_queue_item");
      const run = dependencies.store.getRun(current.runId).descriptor;
      if (run.source !== "user" || run.parentRunId !== undefined) {
        return unsupportedOperation(
          dependencies,
          operationId,
          connection,
          mutation,
          payload.case,
          "Only user-created queued input can be edited."
        );
      }
      const disposition = payload.value.deliveryMode === undefined
        ? current.disposition
        : deliveryMode(payload.value.deliveryMode);
      const prompt = fromProtoInputContent(payload.value.input, disposition);
      const execution = await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        precondition: () => dependencies.sessionHost.assertInputCapabilities(current.sessionId, prompt),
        commit: (store) => {
          const updated = store.editQueueItem({
            queueItemId: current.id,
            body: prompt,
            connectionId: connection.id,
            lockToken: payload.value.lockToken,
            traceId: `operation:${operationId}`
          });
            if (disposition === "steer") {
              store.reorderQueueItem({
                queueItemId: current.id,
                placement: { edge: "first" },
                connectionId: connection.id,
                editLockToken: payload.value.lockToken,
                expectedRevision: updated.revision,
                traceId: `operation:${operationId}:steer`
              });
          }
          return { accepted: true, resultCase: "queueItem", entityId: current.id } satisfies OperationOutcome;
        }
      });
      return presented(execution);
    }
    case "reorderQueueItem": {
      requireEntityVersionPrecondition(
        mutation,
        contract.EntityKind.QUEUE_ITEM,
        payload.value.queueItemId,
        "reorder_queue_item"
      );
      const anchor = payload.value.placement?.anchor;
      if (anchor === undefined || anchor.case === undefined) throw invalidArgument("reorder_queue_item.placement.anchor is required");
      const placement: import("@joko/store").QueuePlacement = anchor.case === "beforeQueueItemId"
        ? { beforeQueueItemId: anchor.value }
        : anchor.case === "afterQueueItemId"
          ? { afterQueueItemId: anchor.value }
          : anchor.value === contract.QueueEdge.FIRST
            ? { edge: "first" }
            : anchor.value === contract.QueueEdge.LAST
              ? { edge: "last" }
              : (() => { throw invalidArgument("reorder_queue_item.placement.edge is required"); })();
      const execution = await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        commit: (store) => {
          store.reorderQueueItem({
            queueItemId: payload.value.queueItemId,
            placement,
            connectionId: connection.id,
            ...(payload.value.interactionLockToken === "" ? {} : { lockToken: payload.value.interactionLockToken }),
            traceId: `operation:${operationId}`
          });
          return { accepted: true, resultCase: "queueItem", entityId: payload.value.queueItemId } satisfies OperationOutcome;
        }
      });
      return presented(execution);
    }
    case "pauseQueue": {
      requireEntityVersionPrecondition(
        mutation,
        contract.EntityKind.QUEUE_CONTROL,
        payload.value.sessionId,
        "pause_queue"
      );
      const execution = await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        commit: (store) => {
          store.setQueuePaused({
            sessionId: payload.value.sessionId,
            paused: true,
            reason: payload.value.reason,
            connectionId: connection.id,
            traceId: `operation:${operationId}`
          });
          return { accepted: true, resultCase: "queueControl", entityId: payload.value.sessionId } satisfies OperationOutcome;
        }
      });
      return presented(execution);
    }
    case "resumeQueue": {
      requireEntityVersionPrecondition(
        mutation,
        contract.EntityKind.QUEUE_CONTROL,
        payload.value.sessionId,
        "resume_queue"
      );
      const execution = await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        commit: (store) => {
          store.setQueuePaused({
            sessionId: payload.value.sessionId,
            paused: false,
            connectionId: connection.id,
            traceId: `operation:${operationId}`
          });
          return { accepted: true, resultCase: "queueControl", entityId: payload.value.sessionId } satisfies OperationOutcome;
        }
      });
      // The durable control transition commits before dispatch is woken. This
      // remains safe for authorized idempotent replays because SessionHost has
      // one drain owner per session and queue claims are durable.
      host.requestQueueDrain(payload.value.sessionId);
      return presented(execution);
    }
    case "createSchedule": {
      if (payload.value.schedule === undefined) return unsupportedOperation(dependencies, operationId, connection, mutation, payload.case, "Schedule input is required.");
      const id = stableId("schedule", operationId);
      const candidate = scheduleInput(id, payload.value.schedule, (dependencies.now ?? Date.now)());
      await validateScheduleWorktreeEligibility(dependencies, candidate);
      const execution = await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        commit: (store) => {
          store.upsertSchedule(candidate);
          return { accepted: true, resultCase: "schedule", entityId: id } satisfies OperationOutcome;
        }
      });
      return presented(execution);
    }
    case "updateSchedule": {
      if (payload.value.schedule === undefined) return unsupportedOperation(dependencies, operationId, connection, mutation, payload.case, "Schedule input is required.");
      const existing = dependencies.store.getSchedule(payload.value.scheduleId);
      const projectOrigin = scheduleProjectAutomationOrigin(existing.executionSnapshot);
      const parsed = scheduleInput(existing.id, payload.value.schedule, (dependencies.now ?? Date.now)(), existing);
      const candidate = projectOrigin === undefined
        ? parsed
        : {
            ...parsed,
            executionSnapshot: withScheduleProjectAutomationOrigin(parsed.executionSnapshot, projectOrigin)
          };
      await validateScheduleWorktreeEligibility(dependencies, candidate);
      if (projectOrigin !== undefined) {
        if (candidate.targetId !== projectOrigin.targetId) {
          throw invalidArgument("Project Schedules cannot move to another Target.");
        }
      }
      const commit = () => host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        commit: (store) => {
          store.upsertSchedule({
            ...candidate,
            expectedRevision: existing.revision
          });
          return { accepted: true, resultCase: "schedule", entityId: existing.id } satisfies OperationOutcome;
        }
      });
      const execution = projectOrigin === undefined
        ? await commit()
        : await dependencies.projectAutomations.upsertWithCommit(
            projectOrigin.targetId,
            projectOrigin.configId,
            payload.value.schedule,
            commit
          );
      return presented(execution);
    }
    case "markScheduleRunRead": {
      const scheduleId = payload.value.scheduleId;
      dependencies.store.getSchedule(scheduleId);
      const triggerId = scheduleHistoryTriggerId(payload.value.triggerId);
      const record = dependencies.store.getScheduleRun(triggerId);
      assertScheduleHistoryOwnership(record.scheduleId, scheduleId);
      if (!unreadScheduleHistoryStatus(record.status)) {
        throw invalidArgument("This Schedule run does not produce unread activity.");
      }
      const execution = await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        commit: (store) => {
          store.markScheduleRunRead(scheduleId, triggerId, (dependencies.now ?? Date.now)());
          return { accepted: true, resultCase: "acknowledgement" } satisfies OperationOutcome;
        }
      });
      return presented(execution);
    }
    case "markScheduleRunsRead": {
      const scheduleId = payload.value.scheduleId;
      dependencies.store.getSchedule(scheduleId);
      const execution = await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        commit: (store) => {
          const updated = store.markScheduleRunsRead(scheduleId, (dependencies.now ?? Date.now)());
          return { accepted: true, scheduleRunsReadCount: updated } satisfies OperationOutcome;
        }
      });
      return presented(execution);
    }
    case "markAllScheduleRunsRead": {
      const execution = await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        commit: (store) => {
          const updated = store.markAllScheduleRunsRead((dependencies.now ?? Date.now)());
          return { accepted: true, scheduleRunsReadCount: updated } satisfies OperationOutcome;
        }
      });
      return presented(execution);
    }
    case "deleteScheduleRun": {
      const scheduleId = payload.value.scheduleId;
      dependencies.store.getSchedule(scheduleId);
      const triggerId = scheduleHistoryTriggerId(payload.value.triggerId);
      const record = dependencies.store.getScheduleRun(triggerId);
      assertScheduleHistoryOwnership(record.scheduleId, scheduleId);
      if (!terminalScheduleHistoryStatus(record.status)) {
        throw invalidArgument("Only a terminal Schedule run can be deleted.");
      }
      const execution = await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        commit: (store) => {
          store.deleteScheduleRun(scheduleId, triggerId);
          return { accepted: true, resultCase: "acknowledgement" } satisfies OperationOutcome;
        }
      });
      return presented(execution);
    }
    case "restartScheduleRun": {
      const scheduleId = payload.value.scheduleId;
      dependencies.store.getSchedule(scheduleId);
      const triggerId = scheduleHistoryTriggerId(payload.value.triggerId);
      const record = dependencies.store.getScheduleRun(triggerId);
      assertScheduleHistoryOwnership(record.scheduleId, scheduleId);
      const status = record.status.toLowerCase();
      if (record.sessionId !== undefined || (status !== "aborted" && status !== "interrupted")) {
        throw invalidArgument("Only an aborted or interrupted Schedule run without a Session can be restarted.");
      }
      return ackOperation(
        dependencies,
        operationId,
        connection,
        mutation,
        payload.case,
        () => dependencies.scheduleCoordinator.runNow(scheduleId, operationId)
      );
    }
    case "deleteSchedule": {
      const scheduleId = payload.value.scheduleId;
      const disposition = scheduleDeletionDispositionFromProto(payload.value.generatedSessionDisposition);
      let manifest: ScheduleDeletionCleanupRecord | undefined;
      let cleanup: Awaited<ReturnType<typeof cleanupScheduleGeneratedSessions>> | undefined;
      let execution: OperationExecution<OperationOutcome>;
      try {
        execution = await host.mutate({
          operationId,
          connection,
          kind: payload.case,
          body: mutation,
          commit: (store) => {
            if (manifest === undefined || cleanup === undefined) {
              throw new Error("Schedule deletion effect completed without a durable cleanup manifest.");
            }
            const result = store.finalizeScheduleDeletionCleanup({
              operationId,
              completedSessionIds: cleanup.completedSessionIds,
              failures: cleanup.failures,
              at: (dependencies.now ?? Date.now)()
            });
            return scheduleDeletionOperationOutcome(result);
          },
          effect: async () => {
            let durable = dependencies.store.findScheduleDeletionCleanup(operationId);
            if (durable === undefined) {
              // The disabled Schedule and authoritative generated-task
              // ownership snapshot are durable before coordinator abort/idle
              // waits. Startup can therefore recover this exact operation
              // after a process loss in any awaited deletion phase.
              const current = dependencies.store.getSchedule(scheduleId);
              const projectOrigin = scheduleProjectAutomationOrigin(current.executionSnapshot);
              durable = dependencies.store.prepareScheduleDeletionCleanup({
                operationId,
                scheduleId,
                disposition,
                ...(projectOrigin === undefined ? {} : {
                  projectTargetId: projectOrigin.targetId,
                  projectConfigId: projectOrigin.configId
                }),
                at: (dependencies.now ?? Date.now)()
              });
            }
            if (durable.scheduleId !== scheduleId || durable.disposition !== disposition) {
              throw invalidArgument("The Schedule deletion operation does not match its durable cleanup manifest.");
            }
            const occurrenceRunIds = await dependencies.scheduleCoordinator.beginScheduleDeletion(scheduleId, operationId);
            durable = dependencies.store.refreshScheduleDeletionCleanup({
              operationId,
              occurrenceRunIds,
              at: (dependencies.now ?? Date.now)()
            });
            manifest = durable;
            cleanup = await cleanupScheduleGeneratedSessionsWithRetry(dependencies, durable);
            if (cleanup.failures.length > 0) {
              manifest = dependencies.store.finalizeScheduleDeletionCleanup({
                operationId,
                completedSessionIds: cleanup.completedSessionIds,
                failures: cleanup.failures,
                at: (dependencies.now ?? Date.now)()
              });
              throw new StoreError("Schedule deletion cleanup is pending and will be retried.");
            }
          },
          complete: async (commit) => {
            const durable = manifest ?? dependencies.store.getScheduleDeletionCleanup(operationId);
            if (durable.projectTargetId === undefined || durable.projectConfigId === undefined) {
              return commit();
            }
            return dependencies.projectAutomations.removeWithCommit(
              durable.projectTargetId,
              durable.projectConfigId,
              async () => commit()
            );
          },
          preserveClaimOnEffectFailure: () =>
            dependencies.store.findScheduleDeletionCleanup(operationId) !== undefined
        });
      } catch (error) {
        if (dependencies.store.findScheduleDeletionCleanup(operationId)?.state === "pending") {
          schedulePendingScheduleDeletionRetry(dependencies, operationId);
          throw new OperationInProgressError(operationId);
        }
        throw error;
      }
      const durable = dependencies.store.findScheduleDeletionCleanup(operationId);
      if (durable?.state === "completed") {
        dependencies.scheduleCoordinator.releaseScheduleDeletion(scheduleId, operationId);
      } else if (durable?.state === "pending") {
        schedulePendingScheduleDeletionRetry(
          dependencies,
          operationId,
          durable.completedSessionIds.length > (manifest?.completedSessionIds.length ?? 0)
        );
      }
      return presented(execution);
    }
    case "triggerSchedule":
      dependencies.store.getSchedule(payload.value.scheduleId);
      return ackOperation(
        dependencies,
        operationId,
        connection,
        mutation,
        payload.case,
        () => dependencies.scheduleCoordinator.runNow(payload.value.scheduleId, operationId)
      );
    case "setScheduleEnabled": {
      const schedule = dependencies.store.getSchedule(payload.value.scheduleId);
      const changedAt = (dependencies.now ?? Date.now)();
      const nextRunAt = payload.value.enabled
        ? nextStoredScheduleOccurrence(schedule, changedAt - 1)
        : schedule.nextRunAt;
      if (payload.value.enabled && schedule.kind !== "manual" && nextRunAt === undefined) {
        throw invalidArgument("The Schedule has no future occurrence and cannot be re-enabled.");
      }
      if (payload.value.enabled) {
        await validateScheduleWorktreeEligibility(dependencies, { ...schedule, enabled: true });
      }
      const execution = await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        commit: (store) => {
          store.upsertSchedule({
            ...schedule,
            enabled: payload.value.enabled,
            expectedRevision: schedule.revision,
            now: changedAt,
            ...(nextRunAt === undefined ? {} : { nextRunAt })
          });
          return { accepted: true, resultCase: "schedule", entityId: schedule.id } satisfies OperationOutcome;
        }
      });
      if (!payload.value.enabled) {
        await dependencies.scheduleCoordinator.abortSchedule(schedule.id);
      }
      return presented(execution);
    }
    case "reconcileProjectAutomations": {
      const targetId = payload.value.targetId;
      if (targetId.trim() === "") throw invalidArgument("reconcile_project_automations.target_id is required");
      const before = dependencies.store.listSchedules({ targetId })
        .filter((schedule) => scheduleProjectAutomationOrigin(schedule.executionSnapshot)?.targetId === targetId)
        .map((schedule) => schedule.id);
      await dependencies.projectAutomations.reconcileTarget(targetId, scheduleInput);
      const after = new Set(dependencies.store.listSchedules({ targetId }).map((schedule) => schedule.id));
      for (const scheduleId of before) {
        if (!after.has(scheduleId)) await dependencies.scheduleCoordinator.abortSchedule(scheduleId);
      }
      const execution = await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        commit: () => ({ accepted: true, resultCase: "acknowledgement" } satisfies OperationOutcome)
      });
      return presented(execution);
    }
    case "promoteScheduleToProject": {
      const current = dependencies.store.getSchedule(payload.value.scheduleId);
      if (scheduleProjectAutomationOrigin(current.executionSnapshot) !== undefined) {
        throw invalidArgument("The Schedule is already owned by its project configuration.");
      }
      if (current.sessionMode === "bound") {
        throw invalidArgument("A task-bound Schedule cannot be promoted to project configuration.");
      }
      const configId = dependencies.projectAutomations.generateConfigId(current.name);
      const projectInput = scheduleRecordInput(current);
      const projectId = projectScheduleId(current.targetId, configId);
      const parsed = scheduleInput(projectId, projectInput, (dependencies.now ?? Date.now)());
      const candidate = {
        ...parsed,
        enabled: current.enabled,
        executionSnapshot: withScheduleProjectAutomationOrigin(parsed.executionSnapshot, {
          targetId: current.targetId,
          configId
        })
      };
      await validateScheduleWorktreeEligibility(dependencies, candidate);
      const linkedOccurrences = collectStoreOffsetPages((offset, limit) =>
        dependencies.store.listScheduleRuns(current.id, limit, offset));
      const execution = await dependencies.projectAutomations.upsertWithCommit(
        current.targetId,
        configId,
        projectInput,
        () => host.mutate({
          operationId,
          connection,
          kind: payload.case,
          body: mutation,
          commit: (store) => {
            store.upsertSchedule(candidate);
            store.deleteSchedule(current.id, current.revision);
            return { accepted: true, resultCase: "schedule", entityId: projectId } satisfies OperationOutcome;
          }
        })
      );
      await dependencies.scheduleCoordinator.abortSchedule(current.id, linkedOccurrences);
      return presented(execution);
    }
    case "cloneProjectScheduleToUser": {
      const current = dependencies.store.getSchedule(payload.value.scheduleId);
      if (scheduleProjectAutomationOrigin(current.executionSnapshot) === undefined) {
        throw invalidArgument("Only a project-owned Schedule can be cloned to personal automation.");
      }
      const copyId = stableId("schedule", operationId);
      const copy = personalScheduleCopy(
        current,
        copyId,
        (dependencies.now ?? Date.now)(),
        payload.value.displayName.trim() || `${current.name} copy`
      );
      const execution = await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        commit: (store) => {
          store.upsertSchedule(copy);
          return { accepted: true, resultCase: "schedule", entityId: copyId } satisfies OperationOutcome;
        }
      });
      return presented(execution);
    }
    case "removeProjectSchedule": {
      const current = dependencies.store.getSchedule(payload.value.scheduleId);
      const projectOrigin = scheduleProjectAutomationOrigin(current.executionSnapshot);
      if (projectOrigin === undefined) {
        throw invalidArgument("Only a project-owned Schedule can be removed from project configuration.");
      }
      const keepPersonalCopy = payload.value.keepPersonalCopy;
      const copyId = keepPersonalCopy ? stableId("schedule", operationId) : undefined;
      const linkedOccurrences = collectStoreOffsetPages((offset, limit) =>
        dependencies.store.listScheduleRuns(current.id, limit, offset));
      const execution = await dependencies.projectAutomations.removeWithCommit(
        projectOrigin.targetId,
        projectOrigin.configId,
        () => host.mutate({
          operationId,
          connection,
          kind: payload.case,
          body: mutation,
          commit: (store) => {
            if (copyId !== undefined) store.upsertSchedule(personalScheduleCopy(current, copyId, (dependencies.now ?? Date.now)()));
            store.deleteSchedule(current.id, current.revision);
            return copyId === undefined
              ? { accepted: true, resultCase: "acknowledgement" } satisfies OperationOutcome
              : { accepted: true, resultCase: "schedule", entityId: copyId } satisfies OperationOutcome;
          }
        })
      );
      await dependencies.scheduleCoordinator.abortSchedule(current.id, linkedOccurrences);
      return presented(execution);
    }
    case "resolveInteraction": {
      if (payload.value.resolution === undefined) return unsupportedOperation(dependencies, operationId, connection, mutation, payload.case, "Interaction resolution is required.");
      const mapped = fromProtoInteractionDecision(payload.value.resolution);
      const execution = await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        commit: () => {
          if (mapped.kind === "dismissal") host.dismissInteraction(payload.value.interactionId, Number(payload.value.interactionGeneration), mapped.reason, `operation:${operationId}`, operationId);
          else host.resolveInteraction(payload.value.interactionId, Number(payload.value.interactionGeneration), coreInteractionDecision(mapped.value), `operation:${operationId}`, operationId);
          return { accepted: true, resultCase: "interaction", entityId: payload.value.interactionId } satisfies OperationOutcome;
        }
      });
      return presented(execution);
    }
    case "dismissInteraction": {
      const execution = await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        commit: () => {
          host.dismissInteraction(payload.value.interactionId, Number(payload.value.interactionGeneration), payload.value.reason || "dismissed", `operation:${operationId}`, operationId);
          return { accepted: true, resultCase: "interaction", entityId: payload.value.interactionId } satisfies OperationOutcome;
        }
      });
      return presented(execution);
    }
    case "setWorkspaceTrust":
      return workspaceTrustOperation(dependencies, operationId, connection, mutation, payload.case, payload.value.workspaceId, payload.value.trusted);
    case "createWorkspaceEntry": {
      const kind = payload.value.kind === contract.WorkspaceEntryCreateKind.FILE
        ? "file"
        : payload.value.kind === contract.WorkspaceEntryCreateKind.DIRECTORY ? "directory" : undefined;
      if (kind === undefined) throw invalidArgument("A concrete workspace entry create kind is required.");
      return workspaceEntryEffectOperation(
        dependencies,
        operationId,
        connection,
        mutation,
        payload.case,
        payload.value.workspaceId,
        () => dependencies.workspaceService.createEntry(payload.value.workspaceId, {
          path: payload.value.relativePath,
          kind,
          expectedRevision: payload.value.expectedRevision
        }).then(() => undefined)
      );
    }
    case "moveWorkspaceEntry":
      return workspaceEntryEffectOperation(
        dependencies,
        operationId,
        connection,
        mutation,
        payload.case,
        payload.value.workspaceId,
        () => dependencies.workspaceService.moveEntry(payload.value.workspaceId, {
          sourcePath: payload.value.sourceRelativePath,
          destinationPath: payload.value.destinationRelativePath,
          expectedRevision: payload.value.expectedRevision
        }).then(() => undefined)
      );
    case "deleteWorkspaceEntry":
      return workspaceEntryEffectOperation(
        dependencies,
        operationId,
        connection,
        mutation,
        payload.case,
        payload.value.workspaceId,
        () => dependencies.workspaceService.deleteEntry(payload.value.workspaceId, {
          path: payload.value.relativePath,
          expectedRevision: payload.value.expectedRevision,
          confirmRecursive: payload.value.confirmRecursive
        })
      );
    case "copyWorkspaceEntry":
      return workspaceEntryEffectOperation(
        dependencies,
        operationId,
        connection,
        mutation,
        payload.case,
        payload.value.workspaceId,
        () => dependencies.workspaceService.copyEntry(payload.value.workspaceId, {
          sourcePath: payload.value.sourceRelativePath,
          destinationPath: payload.value.destinationRelativePath,
          expectedRevision: payload.value.expectedRevision
        }).then(() => undefined)
      );
    case "addExtraDirectory": {
      const target = targetForWorkspace(dependencies.store, payload.value.workspaceId);
      if (target === undefined) {
        return unsupportedOperation(
          dependencies,
          operationId,
          connection,
          mutation,
          payload.case,
          "Workspace is not attached to a durable Target."
        );
      }
      const backend = dependencies.store.getBackend(target.descriptor.backendId).descriptor;
      if (backend.capabilities.get("workspace.extra_dirs")?.supported !== true) {
        return unsupportedOperation(
          dependencies,
          operationId,
          connection,
          mutation,
          payload.case,
          "Backend does not support workspace.extra_dirs."
        );
      }
      let targetId: string | undefined;
      const execution = await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        effect: async () => {
          const currentTarget = targetForWorkspace(dependencies.store, payload.value.workspaceId);
          if (currentTarget?.descriptor.id !== target.descriptor.id) {
            throw new StoreError("Workspace Target changed before the extra-directory policy could be applied.");
          }
          const currentBackend = dependencies.store.getBackend(currentTarget.descriptor.backendId).descriptor;
          if (currentBackend.capabilities.get("workspace.extra_dirs")?.supported !== true) {
            throw new StoreError("Backend extra-directory capability changed before the policy could be applied.");
          }
          dependencies.sessionHost.fencePendingInteractionsForTarget(
            currentTarget.descriptor.id,
            "Approved extra-directory policy is changing."
          );
          const directory = await dependencies.sessionHost.extraDirectories.add({
            workspaceId: payload.value.workspaceId,
            serverPath: payload.value.serverPath,
            access: coreExtraDirectoryAccess(payload.value.access)
          });
          targetId = directory.targetId;
          await dependencies.sessionHost.refreshTargetExtraDirectories(directory.targetId);
        },
        commit: () => ({ accepted: true } satisfies OperationOutcome)
      });
      if (targetId === undefined && !execution.replayed) throw new Error("Extra-directory target was not resolved.");
      return presented(execution);
    }
    case "removeExtraDirectory": {
      const execution = await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        effect: async () => {
          const existing = dependencies.sessionHost.extraDirectories.get(payload.value.extraDirectoryId);
          dependencies.sessionHost.fencePendingInteractionsForTarget(
            existing.targetId,
            "Approved extra-directory policy is changing."
          );
          const directory = dependencies.sessionHost.extraDirectories.remove(payload.value.extraDirectoryId);
          await dependencies.sessionHost.refreshTargetExtraDirectories(directory.targetId);
        },
        commit: () => ({ accepted: true } satisfies OperationOutcome)
      });
      return presented(execution);
    }
    case "applyWorkspaceDiffHunk": {
      const action = nativeWorkspaceDiffAction(payload.value.action);
      const source = nativeMutableWorkspaceDiffSource(payload.value.source);
      const reviewTarget = nativeWorkspaceDiffTarget(payload.value.target);
      if (action === "revert" && !payload.value.confirmRevert) {
        throw new ConnectError("Reverting workspace Review content requires explicit confirmation.", Code.FailedPrecondition);
      }
      const capability = action === "stage"
        ? "workspace.diff.stage"
        : action === "unstage" ? "workspace.diff.unstage" : "workspace.diff.revert";
      const target = targetForWorkspace(dependencies.store, payload.value.workspaceId);
      if (target === undefined) {
        return unsupportedOperation(dependencies, operationId, connection, mutation, payload.case, "Workspace is not attached to a durable Target.");
      }
      const backend = dependencies.store.getBackend(target.descriptor.backendId).descriptor;
      if (backend.capabilities.get(capability)?.supported !== true) {
        return unsupportedOperation(dependencies, operationId, connection, mutation, payload.case, `Backend does not support ${capability}.`);
      }
      assertWorkspaceGitWriteIdle(dependencies.store, payload.value.workspaceId, target.descriptor.id);
      return ackOperation(dependencies, operationId, connection, mutation, payload.case, async () => {
        try {
          assertWorkspaceGitWriteIdle(dependencies.store, payload.value.workspaceId, target.descriptor.id);
          await dependencies.workspaceService.applyGitDiff(payload.value.workspaceId, {
            action,
            source,
            target: reviewTarget,
            path: payload.value.relativePath,
            ...(payload.value.oldRelativePath === "" ? {} : { oldPath: payload.value.oldRelativePath }),
            ...(reviewTarget === "hunk" ? { hunkIndex: payload.value.hunkIndex } : {}),
            expectedRepositoryRevision: payload.value.expectedRepositoryRevision,
            ignoreWhitespace: payload.value.ignoreWhitespace,
            confirmRevert: payload.value.confirmRevert
          });
        } catch (error) {
          throw workspaceGitConnectError(error);
        }
      });
    }
    case "commitWorkspaceDiff": {
      const target = targetForWorkspace(dependencies.store, payload.value.workspaceId);
      if (target === undefined) {
        return unsupportedOperation(dependencies, operationId, connection, mutation, payload.case, "Workspace is not attached to a durable Target.");
      }
      const backend = dependencies.store.getBackend(target.descriptor.backendId).descriptor;
      if (backend.capabilities.get("workspace.diff.commit")?.supported !== true) {
        return unsupportedOperation(dependencies, operationId, connection, mutation, payload.case, "Backend does not support workspace.diff.commit.");
      }
      assertWorkspaceGitWriteIdle(dependencies.store, payload.value.workspaceId, target.descriptor.id);
      return ackOperation(dependencies, operationId, connection, mutation, payload.case, async () => {
        try {
          assertWorkspaceGitWriteIdle(dependencies.store, payload.value.workspaceId, target.descriptor.id);
          await dependencies.workspaceService.commitGitReview(payload.value.workspaceId, {
            message: payload.value.message,
            expectedRepositoryRevision: payload.value.expectedRepositoryRevision,
            includeUnstaged: payload.value.includeUnstaged
          });
        } catch (error) {
          throw workspaceGitConnectError(error);
        }
      });
    }
    case "pushWorkspaceBranch": {
      const target = targetForWorkspace(dependencies.store, payload.value.workspaceId);
      if (target === undefined) {
        return unsupportedOperation(dependencies, operationId, connection, mutation, payload.case, "Workspace is not attached to a durable Target.");
      }
      const backend = dependencies.store.getBackend(target.descriptor.backendId).descriptor;
      if (backend.capabilities.get("workspace.diff.push")?.supported !== true) {
        return unsupportedOperation(dependencies, operationId, connection, mutation, payload.case, "Backend does not support workspace.diff.push.");
      }
      assertWorkspaceGitWriteIdle(dependencies.store, payload.value.workspaceId, target.descriptor.id);
      let push: WorkspaceGitPushResult | undefined;
      return presented(await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        effect: async () => {
          try {
            assertWorkspaceGitWriteIdle(dependencies.store, payload.value.workspaceId, target.descriptor.id);
            push = await dependencies.workspaceService.pushGitReview(payload.value.workspaceId, {
              remote: payload.value.remote,
              remoteRef: payload.value.remoteRef,
              expectedRepositoryRevision: payload.value.expectedRepositoryRevision,
              expectedHeadRevision: payload.value.expectedHeadRevision,
              confirmForceWithLease: payload.value.confirmForceWithLease,
              ...(payload.value.expectedRemoteOid === "" ? {} : { expectedRemoteOid: payload.value.expectedRemoteOid })
            });
          } catch (error) {
            throw workspaceGitConnectError(error);
          }
        },
        commit: () => {
          if (push === undefined) throw new ConnectError("Workspace push did not produce a durable result.", Code.Internal);
          return {
            accepted: true,
            resultCase: "workspaceGitPush",
            workspaceGitPush: push
          } satisfies OperationOutcome;
        }
      }));
    }
    case "executeWorkspaceRewind": {
      const dialogueOnly = payload.value.allowDialogueOnly && !payload.value.confirmFileRestore;
      const filesOnly = payload.value.confirmFileRestore && !payload.value.allowDialogueOnly;
      if (!dialogueOnly && !filesOnly) {
        throw new ConnectError("Choose exactly one rewind mode: confirmed file restore or dialogue-only.", Code.FailedPrecondition);
      }
      const preview = await dependencies.workspaceChanges.getRewindPreview(payload.value.previewId);
      if (preview === undefined) throw new ConnectError("Workspace rewind preview not found.", Code.NotFound);
      if (preview.changeSetId !== payload.value.changeSetId) {
        throw new ConnectError("Workspace rewind preview does not match the requested change set.", Code.FailedPrecondition);
      }
      const changeSet = await dependencies.workspaceChanges.getChangeSet(preview.changeSetId);
      if (changeSet === undefined) throw new ConnectError("Workspace rewind change set not found.", Code.NotFound);
      if (changeSet.workspaceId !== payload.value.workspaceId) {
        throw new ConnectError("Workspace rewind preview does not belong to the requested workspace.", Code.FailedPrecondition);
      }
      let outcome: OperationOutcome | undefined;
      return presented(await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        effect: async () => {
          // Re-read immediately before the irreversible apply so a stale preview
          // cannot cross the durable effect claim boundary.
          const currentPreview = await dependencies.workspaceChanges.getRewindPreview(payload.value.previewId);
          if (currentPreview === undefined || currentPreview.changeSetId !== payload.value.changeSetId) {
            throw new ConnectError("Workspace rewind preview changed before apply.", Code.FailedPrecondition);
          }
          const currentChangeSet = await dependencies.workspaceChanges.getChangeSet(currentPreview.changeSetId);
          if (currentChangeSet === undefined || currentChangeSet.workspaceId !== payload.value.workspaceId) {
            throw new ConnectError("Workspace rewind change set changed before apply.", Code.FailedPrecondition);
          }
          if (dialogueOnly) {
            if (currentChangeSet.dialogueEntryId === undefined) {
              throw new ConnectError("Dialogue-only rewind is unavailable for this change set.", Code.FailedPrecondition);
            }
            const currentSession = dependencies.store.listSessions({ includeArchived: true, includeDeleted: true })
              .find((candidate) => candidate.descriptor.id === currentChangeSet.sessionId);
            const currentTarget = currentSession === undefined
              ? undefined
              : dependencies.store.getTarget(currentSession.descriptor.targetId);
            const currentWorkspaceId = currentTarget === undefined
              ? undefined
              : stringValue(asRecord(currentTarget.metadata)["workspaceId"]) ?? currentTarget.descriptor.id;
            if (currentSession === undefined || currentWorkspaceId !== currentChangeSet.workspaceId) {
              throw new ConnectError("The task owning this dialogue rewind is unavailable or moved.", Code.FailedPrecondition);
            }
            await dependencies.workspaceChanges.consumeDialogueOnlyRewind(currentPreview.id);
            await dependencies.sessionHost.navigateTree(currentSession.descriptor.id, currentChangeSet.dialogueEntryId, false);
          } else {
            await dependencies.workspaceChanges.applyRewind(currentPreview.id);
          }
          outcome = {
            accepted: true,
            resultCase: "workspaceRewind",
            entityId: currentChangeSet.workspaceId,
            workspaceRewind: {
              workspaceId: currentChangeSet.workspaceId,
              changeSetId: currentChangeSet.id,
              restoredPaths: dialogueOnly ? [] : currentChangeSet.changes.map((item) => item.path),
              dialogueRewound: dialogueOnly,
              filesRewound: !dialogueOnly
            }
          };
        },
        commit: () => {
          if (outcome === undefined) throw new Error("Workspace rewind effect completed without an outcome.");
          return outcome;
        }
      }));
    }
    case "deleteArtifact": {
      const execution = await host.mutate({ operationId, connection, kind: payload.case, body: mutation, commit: (store) => {
        store.deleteArtifact(payload.value.artifactId);
        return { accepted: true, resultCase: "artifact", entityId: payload.value.artifactId } satisfies OperationOutcome;
      } });
      return presented(execution);
    }
    case "updateAppearanceSettings":
      return settingOperation(dependencies, operationId, connection, mutation, payload.case, "settings.appearance", payload.value.patch);
    case "updateLanguageToolSettings": {
      const patch = payload.value.patch;
      if (patch === undefined || patch.enabled === undefined) {
        throw invalidArgument("patch.enabled is required");
      }
      return settingOperation(
        dependencies,
        operationId,
        connection,
        mutation,
        payload.case,
        LANGUAGE_TOOL_SETTING_KEY,
        create(contract.LanguageToolSettingsPatchSchema, { enabled: patch.enabled })
      );
    }
    case "updateToolPolicySettings": {
      const repository = dependencies.toolPolicies;
      if (repository === undefined) {
        return unsupportedOperation(
          dependencies,
          operationId,
          connection,
          mutation,
          payload.case,
          "Tool policy settings are unavailable on this Orchestrator node."
        );
      }
      const patch = payload.value.patch;
      if (patch === undefined) throw invalidArgument("update_tool_policy_settings.patch is required");
      if (patch.toolProviderId.trim().length === 0 || patch.toolProviderId.length > 128) {
        throw invalidArgument("patch.tool_provider_id is invalid");
      }
      if (patch.reset === (patch.enabled !== undefined)) {
        throw invalidArgument("Specify either enabled or reset, but not both");
      }
      if (!repository.snapshot().some((item) => item.toolProviderId === patch.toolProviderId)) {
        throw new ConnectError("Tool policy is not available on this Orchestrator node.", Code.NotFound);
      }
      if (patch.targetId !== "") dependencies.store.getTarget(patch.targetId);
      const execution = await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        commit: () => {
          repository.apply({
            toolProviderId: patch.toolProviderId,
            ...(patch.targetId === "" ? {} : { targetId: patch.targetId }),
            ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
            reset: patch.reset
          });
          return { accepted: true, resultCase: "settings" } satisfies OperationOutcome;
        }
      });
      return presented(execution);
    }
    case "updateAgentResourceSettings": {
      const repository = dependencies.runtimeGovernance;
      if (repository === undefined) {
        return unsupportedOperation(
          dependencies,
          operationId,
          connection,
          mutation,
          payload.case,
          "Agent resource governance is unavailable on this Orchestrator node."
        );
      }
      const patch = payload.value.patch;
      if (patch === undefined) throw invalidArgument("update_agent_resource_settings.patch is required");
      const hasFields = patch.maxConcurrentCommands !== undefined
        || patch.processPriority !== undefined
        || patch.capToolchainThreads !== undefined;
      if (patch.resetAll === hasFields) {
        throw invalidArgument("Specify reset_all or at least one Agent resource field, but not both");
      }
      if (patch.maxConcurrentCommands !== undefined && (
        !Number.isSafeInteger(patch.maxConcurrentCommands)
        || patch.maxConcurrentCommands < 0
        || patch.maxConcurrentCommands > 64
      )) throw invalidArgument("patch.max_concurrent_commands must be an integer from 0 through 64");
      const priority = patch.processPriority === undefined
        ? undefined
        : nativeManagedProcessPriority(patch.processPriority);
      const execution = await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        commit: () => {
          if (patch.resetAll) repository.resetAgentResource();
          else repository.updateAgentResource({
            ...(patch.maxConcurrentCommands === undefined
              ? {}
              : { maxConcurrentCommands: patch.maxConcurrentCommands }),
            ...(priority === undefined ? {} : { processPriority: priority }),
            ...(patch.capToolchainThreads === undefined
              ? {}
              : { capToolchainThreads: patch.capToolchainThreads })
          });
          return { accepted: true, resultCase: "settings" } satisfies OperationOutcome;
        }
      });
      const effectivePriority = patch.resetAll ? DEFAULT_AGENT_RESOURCE_SETTINGS.processPriority : priority;
      if (!execution.replayed && effectivePriority !== undefined) {
        const backendIds = [...new Set(dependencies.adapters().map((adapter) => adapter.id))];
        await Promise.all(backendIds.map((backendId) => host.invokeBackendAdapter(
          backendId,
          async (adapter) => {
            await adapter.applyProcessPriorityToActive?.(effectivePriority);
          }
        ).catch(() => undefined)));
      }
      return presented(execution);
    }
    case "updateCollaborationSettings": {
      const repository = dependencies.runtimeGovernance;
      if (repository === undefined) {
        return unsupportedOperation(
          dependencies,
          operationId,
          connection,
          mutation,
          payload.case,
          "Collaboration governance is unavailable on this Orchestrator node."
        );
      }
      const patch = payload.value.patch;
      if (patch === undefined) throw invalidArgument("update_collaboration_settings.patch is required");
      const hasFields = patch.workerSoftLimit !== undefined
        || patch.workerHardLimit !== undefined
        || patch.workerIdleReleaseMinutes !== undefined;
      if (patch.resetAll === hasFields) {
        throw invalidArgument("Specify reset_all or at least one collaboration field, but not both");
      }
      for (const [field, value, minimum, maximum] of [
        ["worker_soft_limit", patch.workerSoftLimit, 1, 20],
        ["worker_hard_limit", patch.workerHardLimit, 1, 20],
        ["worker_idle_release_minutes", patch.workerIdleReleaseMinutes, 0, 120]
      ] as const) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value < minimum || value > maximum)) {
          throw invalidArgument(`patch.${field} must be an integer from ${minimum} through ${maximum}`);
        }
      }
      const current = repository.collaboration();
      const nextSoft = patch.workerSoftLimit ?? current.workerSoftLimit;
      const nextHard = patch.workerHardLimit ?? current.workerHardLimit;
      if (!patch.resetAll && nextHard < nextSoft) {
        throw invalidArgument("patch.worker_hard_limit must be greater than or equal to worker_soft_limit");
      }
      const execution = await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        commit: () => {
          if (patch.resetAll) repository.resetCollaboration();
          else repository.updateCollaboration({
            ...(patch.workerSoftLimit === undefined ? {} : { workerSoftLimit: patch.workerSoftLimit }),
            ...(patch.workerHardLimit === undefined ? {} : { workerHardLimit: patch.workerHardLimit }),
            ...(patch.workerIdleReleaseMinutes === undefined
              ? {}
              : { workerIdleReleaseMinutes: patch.workerIdleReleaseMinutes })
          });
          return { accepted: true, resultCase: "settings" } satisfies OperationOutcome;
        }
      });
      return presented(execution);
    }
    case "updateGitSafetySettings": {
      const repository = dependencies.runtimeGovernance;
      if (repository === undefined) {
        return unsupportedOperation(
          dependencies,
          operationId,
          connection,
          mutation,
          payload.case,
          "Workspace savepoint settings are unavailable on this Orchestrator node."
        );
      }
      const patch = payload.value.patch;
      if (patch === undefined) throw invalidArgument("update_git_safety_settings.patch is required");
      const hasField = patch.autoSnapshotEnabled !== undefined;
      if (patch.resetAll === hasField) {
        throw invalidArgument("Specify reset_all or auto_snapshot_enabled, but not both");
      }
      const execution = await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        commit: () => {
          if (patch.resetAll) repository.resetGitSafety();
          else repository.updateGitSafety({ autoSnapshotEnabled: patch.autoSnapshotEnabled! });
          return { accepted: true, resultCase: "settings" } satisfies OperationOutcome;
        }
      });
      return presented(execution);
    }
    case "cleanupGitSafetySavepoints": {
      if (dependencies.gitSafety === undefined) {
        return unsupportedOperation(
          dependencies,
          operationId,
          connection,
          mutation,
          payload.case,
          "Workspace savepoint cleanup is unavailable on this Orchestrator node."
        );
      }
      const execution = await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        commit: () => ({ accepted: true, resultCase: "acknowledgement" } satisfies OperationOutcome),
        effect: async () => {
          try {
            await dependencies.gitSafety!.cleanupAll();
          } catch (error) {
            if (error instanceof GitSafetyCleanupBusyError) {
              throw new ConnectError("Workspace savepoints are busy with active turns.", Code.FailedPrecondition);
            }
            throw error;
          }
        }
      });
      return presented(execution);
    }
    case "updateBackendSettings": {
      const patch = payload.value.patch;
      if (patch === undefined) throw invalidArgument("update_backend_settings.patch is required");
      const backendId = nonBlankRequest(patch.backendId, "patch.backend_id");
      const backend = dependencies.store.getBackend(backendId).descriptor;
      const catalogModels = backendCatalogModels(dependencies, backend);
      const modelAccessUpdate = patch.modelAccessUpdate;
      if (modelAccessUpdate !== undefined) {
        if (
          patch.defaultModel !== undefined
          || patch.defaultPermissionMode !== undefined
          || patch.defaultPlanMode !== undefined
          || patch.enabled !== undefined
          || patch.clearDefaultModel
        ) {
          throw invalidArgument("model_access_update must be submitted on its own");
        }
        const providerId = nonBlankRequest(modelAccessUpdate.providerId, "patch.model_access_update.provider_id");
        const modelId = modelAccessUpdate.modelId === undefined
          ? undefined
          : nonBlankRequest(modelAccessUpdate.modelId, "patch.model_access_update.model_id");
        const currentAccess = readBackendModelAccess(dependencies.store, backendId);
        const storedDisabled = modelId === undefined
          ? currentAccess.disabledProviderIds.includes(providerId)
          : currentAccess.disabledModels.some((model) =>
            model.providerId === providerId && model.modelId === modelId);
        const providerAdvertised = backend.providers?.some((provider) => provider.providerId === providerId) === true
          || catalogModels.some((model) => model.providerId === providerId);
        const supplementalModelAdvertised = modelId !== undefined
          && backendProviderCredentialSurfaceAdvertised(backend, providerId, modelId);
        if (!providerAdvertised && !(modelAccessUpdate.enabled && storedDisabled)) {
          throw new ConnectError("The selected Provider is not advertised by this Backend instance.", Code.NotFound);
        }
        if (modelId !== undefined && !catalogModels.some((model) =>
          model.providerId === providerId && model.modelId === modelId)
          && !supplementalModelAdvertised
          && !(modelAccessUpdate.enabled && storedDisabled)) {
          throw new ConnectError("The selected model is not advertised by this Backend instance.", Code.NotFound);
        }
        const execution = await host.mutate({
          operationId,
          connection,
          kind: payload.case,
          body: mutation,
          commit: (store) => {
            writeBackendModelAccess(store, backendId, modelAccessUpdate);
            return { accepted: true, resultCase: "settings" } satisfies OperationOutcome;
          }
        });
        const supplementalExecutionAffected = backendProviderCredentialSurfaceAdvertised(
          backend,
          providerId,
          modelId
        );
        if (managedProviderCatalogApplies(dependencies, backendId) || supplementalExecutionAffected) {
          await dependencies.refreshPiGeneration?.();
        }
        dependencies.messageSearch?.reconcileAvailability();
        return presented(execution);
      }
      if (patch.clearDefaultModel && patch.defaultModel !== undefined) {
        throw invalidArgument("Specify either default_model or clear_default_model, but not both");
      }
      if (patch.defaultModel !== undefined) {
        const modelKey = patch.defaultModel.model;
        if (modelKey === undefined || modelKey.providerId.trim() === "" || modelKey.modelId.trim() === "") {
          throw invalidArgument("patch.default_model.model is required");
        }
        if (backend.capabilities.get("model.switch")?.supported !== true) {
          return unsupportedOperation(dependencies, operationId, connection, mutation, payload.case, "Backend does not support model.switch.");
        }
        const model = catalogModels.find((candidate) =>
          candidate.providerId === modelKey.providerId && candidate.modelId === modelKey.modelId);
        if (model === undefined) {
          return unsupportedOperation(dependencies, operationId, connection, mutation, payload.case, "The selected model is not advertised by this Backend instance.");
        }
        if (!modelRoutingEnabled(dependencies.store, backendId, modelKey.providerId, modelKey.modelId)) {
          throw new ConnectError("The selected model is disabled in model access settings.", Code.FailedPrecondition);
        }
        if (patch.defaultModel.effortId !== "" && (
          backend.capabilities.get("model.effort")?.supported !== true
          || !model.thinkingLevels.includes(patch.defaultModel.effortId)
        )) {
          return unsupportedOperation(dependencies, operationId, connection, mutation, payload.case, "The selected effort is not supported by this Backend model.");
        }
        if (patch.defaultModel.fastMode && (
          backend.capabilities.get("model.fast_mode")?.supported !== true
          || model.supportsFastMode !== true
        )) {
          return unsupportedOperation(dependencies, operationId, connection, mutation, payload.case, "The selected Backend model does not support Fast Mode.");
        }
      }
      if (patch.defaultPermissionMode !== undefined) {
        const permissionMode = requiredCorePermission(patch.defaultPermissionMode, "patch.default_permission_mode");
        const permissionModes = backend.capabilities.get("permission.modes");
        if (permissionModes?.supported !== true || !permissionModes.options?.includes(permissionMode)) {
          return unsupportedOperation(dependencies, operationId, connection, mutation, payload.case, "The selected permission mode is not advertised by this Backend instance.");
        }
      }
      if (patch.defaultPlanMode === true && backend.capabilities.get("plan_mode")?.supported !== true) {
        return unsupportedOperation(dependencies, operationId, connection, mutation, payload.case, "Backend does not support plan_mode.");
      }
      const current = dependencies.store.findSetting<contract.BackendSettingsPatch>(
        "service",
        "orchestrator",
        `settings.backend.${backendId}`
      )?.value;
      const next = create(contract.BackendSettingsPatchSchema, {
        backendId,
        defaultModel: patch.clearDefaultModel ? undefined : patch.defaultModel ?? current?.defaultModel,
        defaultPermissionMode: patch.defaultPermissionMode ?? current?.defaultPermissionMode,
        defaultPlanMode: patch.defaultPlanMode ?? current?.defaultPlanMode,
        enabled: patch.enabled ?? current?.enabled,
        clearDefaultModel: false
      });
      return settingOperation(
        dependencies,
        operationId,
        connection,
        mutation,
        payload.case,
        `settings.backend.${backendId}`,
        next
      );
    }
    case "updatePiSettings": {
      const patch = payload.value.patch;
      if (patch === undefined) return unsupportedOperation(dependencies, operationId, connection, mutation, payload.case, "Pi settings patch is required.");
      if (patch.backendId.trim() === "") throw invalidArgument("patch.backend_id is required");
      if (patch.resetAutoCompactionThresholdPercent && patch.autoCompactionThresholdPercent !== undefined) {
        throw invalidArgument("Specify either auto_compaction_threshold_percent or reset_auto_compaction_threshold_percent, but not both");
      }
      if (patch.autoCompactionThresholdPercent !== undefined && (
        !Number.isSafeInteger(patch.autoCompactionThresholdPercent)
        || patch.autoCompactionThresholdPercent < PI_AUTO_COMPACTION_THRESHOLD_PERCENT_MINIMUM
        || patch.autoCompactionThresholdPercent > PI_AUTO_COMPACTION_THRESHOLD_PERCENT_MAXIMUM
      )) {
        throw invalidArgument(
          `patch.auto_compaction_threshold_percent must be an integer from ${PI_AUTO_COMPACTION_THRESHOLD_PERCENT_MINIMUM} through ${PI_AUTO_COMPACTION_THRESHOLD_PERCENT_MAXIMUM}`
        );
      }
      if (dependencies.piBackendIds?.has(patch.backendId) !== true) {
        return unsupportedOperation(dependencies, operationId, connection, mutation, payload.case, "The selected Backend does not own the Pi settings namespace.");
      }
      const settingKey = `settings.pi.${patch.backendId}`;
      const previous = dependencies.store.findSetting<contract.PiSettingsPatch>("service", "orchestrator", settingKey)?.value;
      const merged = create(contract.PiSettingsPatchSchema, {
        backendId: patch.backendId,
        autoCompaction: patch.autoCompaction ?? previous?.autoCompaction,
        autoCompactionThresholdPercent: patch.resetAutoCompactionThresholdPercent
          ? undefined
          : patch.autoCompactionThresholdPercent ?? previous?.autoCompactionThresholdPercent,
        autoRetry: patch.autoRetry ?? previous?.autoRetry,
        steeringMode: patch.steeringMode ?? previous?.steeringMode,
        followUpMode: patch.followUpMode ?? previous?.followUpMode,
        resetAutoCompactionThresholdPercent: false
      });
      const hasOverrides = merged.autoCompaction !== undefined
        || merged.autoCompactionThresholdPercent !== undefined
        || merged.autoRetry !== undefined
        || merged.steeringMode !== undefined
        || merged.followUpMode !== undefined;
      const execution = await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        commit: (store) => {
          if (hasOverrides) store.setSetting("service", "orchestrator", settingKey, merged);
          else store.deleteSetting("service", "orchestrator", settingKey);
          return { accepted: true, resultCase: "settings" } satisfies OperationOutcome;
        }
      });
      // The durable setting is authoritative. Runtime/generation reconciliation
      // intentionally happens only after its transaction commits, and replayed
      // operation IDs do not repeat the side effects.
      if (!execution.replayed) {
        const failures: string[] = [];
        try {
          await dependencies.refreshPiGeneration?.();
        } catch {
          failures.push("generation");
        }
        const apply = async (label: string, work: () => Promise<void>): Promise<void> => {
          try {
            await work();
          } catch {
            failures.push(label);
          }
        };
        await host.applyToActiveSessions({ backendId: patch.backendId }, async (sessionId, adapter, adapterContext) => {
          if (patch.autoCompaction !== undefined) {
            await apply(`auto_compaction:${sessionId}`, () => adapter.setAutoCompaction(patch.autoCompaction as boolean, adapterContext));
          }
          const effectiveThreshold = patch.resetAutoCompactionThresholdPercent
            ? piProjectionDefaults(dependencies, patch.backendId).autoCompactionThresholdPercent
            : patch.autoCompactionThresholdPercent;
          if (effectiveThreshold !== undefined) {
            await apply(`auto_compaction_threshold:${sessionId}`, async () => {
              if (!(adapter instanceof PiBackendAdapter)) throw new Error("The active settings target is not a Pi runtime.");
              await adapter.setAutoCompactionThreshold(effectiveThreshold, adapterContext);
            });
          }
          if (patch.autoRetry !== undefined) {
            await apply(`auto_retry:${sessionId}`, () => adapter.setAutoRetry(patch.autoRetry as boolean, adapterContext));
          }
          if (patch.steeringMode !== undefined) {
            const mode = nativePiQueueMode(patch.steeringMode);
            await apply(`steering:${sessionId}`, async () => {
              if (!(adapter instanceof PiBackendAdapter)) throw new Error("The active settings target is not a Pi runtime.");
              await adapter.setSteeringMode(mode, adapterContext);
            });
          }
          if (patch.followUpMode !== undefined) {
            const mode = nativePiQueueMode(patch.followUpMode);
            await apply(`follow_up:${sessionId}`, async () => {
              if (!(adapter instanceof PiBackendAdapter)) throw new Error("The active settings target is not a Pi runtime.");
              await adapter.setFollowUpMode(mode, adapterContext);
            });
          }
        });
        if (failures.length > 0) {
          dependencies.store.appendDiagnostic({
            severity: "warning",
            component: "pi",
            code: "PI_SETTINGS_RECONCILIATION_FAILED",
            message: "Durable Pi settings were committed, but one or more live runtime projections could not be refreshed.",
            details: { backendId: patch.backendId, failures }
          });
        }
      }
      return presented(execution);
    }
    case "updateMemorySettings": {
      const patch = payload.value.patch;
      if (payload.value.restoreDefaults && patch !== undefined) {
        throw invalidArgument("update_memory_settings cannot restore defaults and apply a patch together");
      }
      const memory = dependencies.makerMemory;
      if (payload.value.restoreDefaults) {
        const execution = await host.mutate({
          operationId,
          connection,
          kind: payload.case,
          body: mutation,
          commit: (store) => {
            store.deleteSetting("service", "orchestrator", MAKER_MEMORY_SETTING_KEY);
            return { accepted: true, resultCase: "settings" } satisfies OperationOutcome;
          }
        });
        // Restoring the durable default remains available even while the
        // optional runtime owner is absent. Reconcile only when it exists.
        await memory?.reconcileSettingsChange();
        return presented(execution);
      }
      if (memory === undefined) {
        return unsupportedOperation(
          dependencies,
          operationId,
          connection,
          mutation,
          payload.case,
          "Maker Memory is not configured on this Orchestrator node."
        );
      }
      let nextSettings: ReturnType<MakerMemoryController["settings"]> | undefined;
      if (patch === undefined) throw invalidArgument("update_memory_settings.patch is required");
      if (patch.makerEnabled === undefined && patch.backendEnabled === undefined) {
        throw invalidArgument("memory settings patch is empty");
      }
      if (patch.backendEnabled === undefined && patch.backendId.trim() !== "") {
        throw invalidArgument("patch.backend_id is valid only with patch.backend_enabled");
      }
      if (patch.backendEnabled !== undefined) {
        if (patch.backendId.trim() === "") throw invalidArgument("patch.backend_id is required");
        let backend;
        try {
          backend = dependencies.store.getBackend(patch.backendId).descriptor;
        } catch {
          throw new ConnectError("Memory Backend not found.", Code.NotFound);
        }
        if (backend.capabilities.get("memory.compaction_digest")?.supported !== true) {
          throw new ConnectError("Backend does not support memory.compaction_digest.", Code.FailedPrecondition);
        }
      }
      try {
        nextSettings = memory.patchedSettings({
          ...(patch.makerEnabled === undefined ? {} : { makerEnabled: patch.makerEnabled }),
          ...(patch.backendEnabled === undefined
            ? {}
            : { backendId: patch.backendId, backendEnabled: patch.backendEnabled })
        });
      } catch (error) {
        throw invalidArgument(error instanceof Error ? error.message : "Memory settings patch is invalid.");
      }
      const execution = await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        commit: (store) => {
          store.setSetting("service", "orchestrator", MAKER_MEMORY_SETTING_KEY, nextSettings!);
          return { accepted: true, resultCase: "settings" } satisfies OperationOutcome;
        }
      });
      // Settings affect only future runtimes. Active runtimes retain the
      // immutable Memory/provider snapshot captured when they started.
      await memory.reconcileSettingsChange();
      return presented(execution);
    }
    case "resetMemory": {
      const memory = dependencies.makerMemory;
      if (memory === undefined) {
        return unsupportedOperation(
          dependencies,
          operationId,
          connection,
          mutation,
          payload.case,
          "Maker Memory is not configured on this Orchestrator node."
        );
      }
      let reset: () => { readonly removedEntries: number; readonly removedTargets: number };
      switch (payload.value.scope) {
        case contract.MemoryResetScope.CURATED:
          if (payload.value.backendId.trim() !== "") {
            throw invalidArgument("reset_memory.backend_id must be empty for CURATED scope");
          }
          reset = () => memory.reset("curated");
          break;
        case contract.MemoryResetScope.BACKEND: {
          const backendId = payload.value.backendId.trim();
          if (backendId === "") throw invalidArgument("reset_memory.backend_id is required for BACKEND scope");
          let backend;
          try {
            backend = dependencies.store.getBackend(backendId).descriptor;
          } catch {
            throw new ConnectError("Memory Backend not found.", Code.NotFound);
          }
          if (backend.capabilities.get("memory.compaction_digest")?.supported !== true) {
            throw new ConnectError("Backend does not support memory.compaction_digest.", Code.FailedPrecondition);
          }
          reset = () => memory.reset("backend", backendId);
          break;
        }
        case contract.MemoryResetScope.UNSPECIFIED:
          throw invalidArgument("reset_memory.scope is required");
        default:
          throw invalidArgument("reset_memory.scope is invalid");
      }
      // dispatchMutation is reachable only after owner authentication. The
      // Curated scope spans all Targets without touching Backend-owned digests;
      // Backend scope spans all Targets for one capability-assigned Backend.
      // No Memory body is copied into the durable Operation result.
      const execution = await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        commit: () => ({
          accepted: true,
          memoryReset: reset()
        } satisfies OperationOutcome)
      });
      return presented(execution);
    }
    case "updateBrowserSettings": {
      if (dependencies.browserProvider === undefined || dependencies.browserSettings === undefined) {
        return unsupportedOperation(dependencies, operationId, connection, mutation, payload.case, "Browser settings are not configured on this Orchestrator node.");
      }
      const patch = payload.value.patch;
      if (patch === undefined) throw invalidArgument("update_browser_settings.patch is required");
      if (patch.browserProviderId !== BROWSER_PROVIDER_ID) {
        throw new ConnectError("Browser Provider not found.", Code.NotFound);
      }
      return effectOperation(dependencies, operationId, connection, mutation, payload.case, {
        accepted: true,
        resultCase: "acknowledgement",
        entityId: BROWSER_PROVIDER_ID
      }, async () => {
        await dependencies.browserSettings!.apply(patch);
      });
    }
    case "updateVoiceInputServiceSettings": {
      if (dependencies.voiceInputSettings === undefined) {
        return unsupportedOperation(
          dependencies,
          operationId,
          connection,
          mutation,
          payload.case,
          "Voice input settings are not configured on this Orchestrator node."
        );
      }
      const patch = payload.value.patch;
      if (patch === undefined) throw invalidArgument("update_voice_input_service_settings.patch is required");
      return effectOperation(dependencies, operationId, connection, mutation, payload.case, {
        accepted: true,
        resultCase: "acknowledgement",
        entityId: "voice-input"
      }, async () => {
        await dependencies.voiceInputSettings!.apply(patch, connection.id);
      });
    }
    case "showBrowserAutomation": {
      if (dependencies.browserProvider === undefined || dependencies.browserSettings === undefined) {
        return unsupportedOperation(
          dependencies,
          operationId,
          connection,
          mutation,
          payload.case,
          "Browser automation is not configured on this Orchestrator node."
        );
      }
      if (payload.value.browserProviderId !== dependencies.browserProvider.id) {
        throw new ConnectError("Browser Provider not found.", Code.NotFound);
      }
      if (!dependencies.browserSettings.enabled(payload.value.targetId)) {
        throw new ConnectError("Browser automation is disabled by owner settings.", Code.FailedPrecondition);
      }
      if (dependencies.browserSettings.automationTarget() !== "external") {
        throw new ConnectError("The dedicated Browser window requires the external target.", Code.FailedPrecondition);
      }
      return effectOperation(dependencies, operationId, connection, mutation, payload.case, {
        accepted: true,
        resultCase: "acknowledgement",
        entityId: dependencies.browserProvider.id
      }, async () => {
        await dependencies.browserProvider!.showExternalWindow();
      });
    }
    case "updateComputerAutomationSettings": {
      if (dependencies.computerAutomation === undefined) {
        return unsupportedOperation(
          dependencies,
          operationId,
          connection,
          mutation,
          payload.case,
          "Computer automation is not configured on this Orchestrator node."
        );
      }
      const enabled = payload.value.patch?.enabled;
      if (enabled === undefined) {
        throw invalidArgument("update_computer_automation_settings.patch.enabled is required");
      }
      return effectOperation(dependencies, operationId, connection, mutation, payload.case, {
        accepted: true,
        resultCase: "acknowledgement",
        entityId: "computer"
      }, async () => {
        await dependencies.computerAutomation!.setEnabled(enabled);
      });
    }
    case "installComputerAutomation": {
      if (dependencies.computerAutomation === undefined) {
        return unsupportedOperation(
          dependencies,
          operationId,
          connection,
          mutation,
          payload.case,
          "Computer automation is not configured on this Orchestrator node."
        );
      }
      return effectOperation(dependencies, operationId, connection, mutation, payload.case, {
        accepted: true,
        resultCase: "acknowledgement",
        entityId: "computer"
      }, async () => {
        await dependencies.computerAutomation!.install();
      });
    }
    case "probeComputerAutomation": {
      if (dependencies.computerAutomation === undefined) {
        return unsupportedOperation(
          dependencies,
          operationId,
          connection,
          mutation,
          payload.case,
          "Computer automation is not configured on this Orchestrator node."
        );
      }
      return effectOperation(dependencies, operationId, connection, mutation, payload.case, {
        accepted: true,
        resultCase: "acknowledgement",
        entityId: "computer"
      }, async () => {
        await dependencies.computerAutomation!.probe(payload.value.fresh);
      });
    }
    case "requestComputerAutomationPermission": {
      if (dependencies.computerAutomation === undefined) {
        return unsupportedOperation(
          dependencies,
          operationId,
          connection,
          mutation,
          payload.case,
          "Computer automation is not configured on this Orchestrator node."
        );
      }
      const permission = payload.value.permission === contract.ComputerAutomationPermissionKind.ACCESSIBILITY
        ? "accessibility"
        : payload.value.permission === contract.ComputerAutomationPermissionKind.SCREEN_RECORDING
          ? "screenRecording"
          : payload.value.permission === contract.ComputerAutomationPermissionKind.ALL
            ? "all"
            : undefined;
      if (permission === undefined) {
        throw invalidArgument("request_computer_automation_permission.permission is required");
      }
      return effectOperation(dependencies, operationId, connection, mutation, payload.case, {
        accepted: true,
        resultCase: "acknowledgement",
        entityId: "computer"
      }, async () => {
        await dependencies.computerAutomation!.requestPermission(permission);
      });
    }
    case "cancelComputerAutomationPermission": {
      if (dependencies.computerAutomation === undefined) {
        return unsupportedOperation(
          dependencies,
          operationId,
          connection,
          mutation,
          payload.case,
          "Computer automation is not configured on this Orchestrator node."
        );
      }
      return effectOperation(dependencies, operationId, connection, mutation, payload.case, {
        accepted: true,
        resultCase: "acknowledgement",
        entityId: "computer"
      }, async () => {
        dependencies.computerAutomation!.cancelPermissionRequest();
      });
    }
    case "openComputerAutomationPermissionSettings": {
      if (dependencies.computerAutomation === undefined) {
        return unsupportedOperation(
          dependencies,
          operationId,
          connection,
          mutation,
          payload.case,
          "Computer automation is not configured on this Orchestrator node."
        );
      }
      if (dependencies.computerAutomation.snapshot().platform !== "darwin") {
        throw new ConnectError("Computer system permission settings are available only on macOS.", Code.FailedPrecondition);
      }
      const permission = payload.value.permission === contract.ComputerAutomationPermissionKind.ACCESSIBILITY
        ? "accessibility"
        : payload.value.permission === contract.ComputerAutomationPermissionKind.SCREEN_RECORDING
          ? "screenRecording"
          : undefined;
      if (permission === undefined) {
        throw invalidArgument("open_computer_automation_permission_settings.permission must select a fixed pane");
      }
      return effectOperation(dependencies, operationId, connection, mutation, payload.case, {
        accepted: true,
        resultCase: "acknowledgement",
        entityId: "computer"
      }, async () => {
        await dependencies.computerAutomation!.openPermissionSettings(permission);
      });
    }
    case "checkComputerAutomationUpdate": {
      if (dependencies.computerAutomation === undefined) {
        return unsupportedOperation(
          dependencies,
          operationId,
          connection,
          mutation,
          payload.case,
          "Computer automation is not configured on this Orchestrator node."
        );
      }
      return effectOperation(dependencies, operationId, connection, mutation, payload.case, {
        accepted: true,
        resultCase: "acknowledgement",
        entityId: "computer"
      }, async () => {
        await dependencies.computerAutomation!.checkForUpdate(payload.value.fresh);
      });
    }
    case "updateComputerAutomationDriver": {
      if (dependencies.computerAutomation === undefined) {
        return unsupportedOperation(
          dependencies,
          operationId,
          connection,
          mutation,
          payload.case,
          "Computer automation is not configured on this Orchestrator node."
        );
      }
      return effectOperation(dependencies, operationId, connection, mutation, payload.case, {
        accepted: true,
        resultCase: "acknowledgement",
        entityId: "computer"
      }, async () => {
        await dependencies.computerAutomation!.updateDriver({ joinOnly: payload.value.joinOnly });
      });
    }
    case "updateAndroidAutomationSettings": {
      if (dependencies.androidAutomation === undefined) {
        return unsupportedOperation(
          dependencies,
          operationId,
          connection,
          mutation,
          payload.case,
          "Android automation is not configured on this Orchestrator node."
        );
      }
      const enabled = payload.value.patch?.enabled;
      if (enabled === undefined) {
        throw invalidArgument("update_android_automation_settings.patch.enabled is required");
      }
      return effectOperation(dependencies, operationId, connection, mutation, payload.case, {
        accepted: true,
        resultCase: "acknowledgement",
        entityId: "android"
      }, async () => {
        await dependencies.androidAutomation!.setEnabled(enabled);
      });
    }
    case "probeAndroidAutomation": {
      if (dependencies.androidAutomation === undefined) {
        return unsupportedOperation(
          dependencies,
          operationId,
          connection,
          mutation,
          payload.case,
          "Android automation is not configured on this Orchestrator node."
        );
      }
      return effectOperation(dependencies, operationId, connection, mutation, payload.case, {
        accepted: true,
        resultCase: "acknowledgement",
        entityId: "android"
      }, async () => {
        await dependencies.androidAutomation!.probe(payload.value.fresh);
      });
    }
    case "prepareAndroidAutomation": {
      if (dependencies.androidAutomation === undefined) {
        return unsupportedOperation(
          dependencies,
          operationId,
          connection,
          mutation,
          payload.case,
          "Android automation is not configured on this Orchestrator node."
        );
      }
      return effectOperation(dependencies, operationId, connection, mutation, payload.case, {
        accepted: true,
        resultCase: "acknowledgement",
        entityId: "android"
      }, async () => {
        await dependencies.androidAutomation!.prepare();
      });
    }
    case "selectAndroidAutomationDevice": {
      if (dependencies.androidAutomation === undefined) {
        return unsupportedOperation(
          dependencies,
          operationId,
          connection,
          mutation,
          payload.case,
          "Android automation is not configured on this Orchestrator node."
        );
      }
      const selection = payload.value.selection?.choice;
      const deviceSerial = selection?.case === "automatic"
        ? selection.value === true ? undefined : null
        : selection?.case === "deviceSerial"
          ? selection.value
          : null;
      if (deviceSerial === null) {
        throw invalidArgument("select_android_automation_device.selection is required");
      }
      return effectOperation(dependencies, operationId, connection, mutation, payload.case, {
        accepted: true,
        resultCase: "acknowledgement",
        entityId: "android"
      }, async () => {
        await dependencies.androidAutomation!.selectDevice(deviceSerial);
      });
    }
    case "setAndroidAdbPath": {
      if (dependencies.androidAutomation === undefined) {
        return unsupportedOperation(
          dependencies,
          operationId,
          connection,
          mutation,
          payload.case,
          "Android automation is not configured on this Orchestrator node."
        );
      }
      const selection = payload.value.selection?.choice;
      const serverPath = selection?.case === "automatic"
        ? selection.value === true ? undefined : null
        : selection?.case === "serverPath"
          ? selection.value
          : null;
      if (serverPath === null) {
        throw invalidArgument("set_android_adb_path.selection is required");
      }
      return effectOperation(dependencies, operationId, connection, mutation, payload.case, {
        accepted: true,
        resultCase: "acknowledgement",
        entityId: "android"
      }, async () => {
        await dependencies.androidAutomation!.setAdbPath(serverPath);
      });
    }
    case "replacePolicySettings": {
      if (payload.value.policy === undefined) {
        return unsupportedOperation(dependencies, operationId, connection, mutation, payload.case, "The typed policy settings payload is required.");
      }
      try {
        validatePolicySettings(payload.value.policy);
      } catch (error) {
        if (error instanceof PolicySettingsValidationError) throw invalidArgument(error.message);
        throw error;
      }
      const result = await settingOperation(
        dependencies,
        operationId,
        connection,
        mutation,
        payload.case,
        POLICY_SETTINGS_KEY,
        payload.value.policy
      );
      // Reconcile on idempotent replay as well: the durable commit may have
      // survived a prior process exit before its live runtime fences changed.
      await dependencies.sessionHost.refreshPolicySettings();
      return result;
    }
    case "updateDiagnosticSettings":
      return settingOperation(dependencies, operationId, connection, mutation, payload.case, "settings.diagnostics", payload.value.patch);
    case "updateMessageSearchSettings": {
      const patch = payload.value.patch;
      if (patch === undefined || patch.resetSemanticIndexEnabled === (patch.semanticIndexEnabled !== undefined)) {
        throw invalidArgument("Specify exactly one of patch.semantic_index_enabled or patch.reset_semantic_index_enabled");
      }
      const enabled = patch.resetSemanticIndexEnabled ? true : patch.semanticIndexEnabled as boolean;
      const execution = await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        commit: (store) => {
          if (!patch.resetSemanticIndexEnabled && enabled && (dependencies.messageSearch === undefined || !dependencies.messageSearch.available())) {
            throw new ConnectError(
              "Chat semantic indexing is unavailable because no unique eligible embedding Provider route can be resolved.",
              Code.FailedPrecondition
            );
          }
          if (patch.resetSemanticIndexEnabled) store.deleteSetting("service", "orchestrator", "settings.message_search");
          else store.setSetting("service", "orchestrator", "settings.message_search", create(
            contract.MessageSearchSettingsPatchSchema,
            { semanticIndexEnabled: enabled, resetSemanticIndexEnabled: false }
          ));
          return { accepted: true, resultCase: "settings" } satisfies OperationOutcome;
        }
      });
      // Reconcile even on an idempotent replay: Orchestrator may have crashed after
      // the durable setting commit but before this in-memory worker effect.
      if (dependencies.messageSearch === undefined) dependencies.store.setMessageEmbeddingEnabled(false);
      else dependencies.messageSearch.setEnabled(enabled);
      return presented(execution);
    }
    case "updateVisionBridgeSettings": {
      const patch = payload.value.patch;
      if (patch === undefined) throw invalidArgument("update_vision_bridge_settings.patch is required");
      if (patch.resetAll && (
        patch.resetTargetModels || patch.enabled !== undefined || patch.targetModels !== undefined ||
        patch.primary !== undefined || patch.fallback !== undefined
      )) throw invalidArgument("Vision Bridge reset_all cannot be combined with another patch field");
      if (patch.resetAll) {
        const execution = await host.mutate({
          operationId,
          connection,
          kind: payload.case,
          body: mutation,
          commit: (store) => {
            store.deleteSetting("service", "orchestrator", "settings.vision_bridge");
            return { accepted: true, resultCase: "settings" } satisfies OperationOutcome;
          }
        });
        try {
          await dependencies.refreshPiGeneration?.();
        } catch {
          throw new ConnectError(
            "Vision Bridge settings were saved, but the managed Pi generation could not be refreshed.",
            Code.Unavailable
          );
        }
        return presented(execution);
      }
      if (dependencies.visionBridge === undefined || dependencies.providers === undefined) {
        return unsupportedOperation(
          dependencies,
          operationId,
          connection,
          mutation,
          payload.case,
          "Vision Bridge is not configured on this Orchestrator node."
        );
      }
      if (
        patch.enabled === undefined &&
        patch.targetModels === undefined &&
        patch.primary === undefined &&
        patch.fallback === undefined &&
        !patch.resetAll &&
        !patch.resetTargetModels
      ) throw invalidArgument("update_vision_bridge_settings.patch must change at least one field");
      if (patch.resetTargetModels && (
        patch.enabled !== undefined || patch.targetModels !== undefined || patch.primary !== undefined || patch.fallback !== undefined
      )) throw invalidArgument("Vision Bridge reset_target_models cannot be combined with another patch field");

      const previous = normalizeVisionBridgeSettings(dependencies.store.findSetting<unknown>(
        "service",
        "orchestrator",
        "settings.vision_bridge"
      )?.value);
      const modelRoutes = createModelRouteCatalog(dependencies.store, dependencies.providers);
      const targetModels = patch.resetTargetModels
        ? undefined
        : patch.targetModels === undefined
        ? previous.targetModels
        : normalizeVisionTargets(patch.targetModels.values, modelRoutes.list());
      const primary = patch.primary === undefined
        ? previous.primary
        : normalizeVisionSlot("primary", patch.primary, modelRoutes.list());
      const fallback = patch.fallback === undefined
        ? previous.fallback
        : normalizeVisionSlot("fallback", patch.fallback, modelRoutes.list());
      const next = patch.resetAll ? {} : {
        ...(patch.enabled === undefined && previous.enabled === undefined
          ? {}
          : { enabled: patch.enabled ?? previous.enabled ?? false }),
        ...(targetModels === undefined ? {} : { targetModels }),
        ...(primary === undefined ? {} : { primary }),
        ...(fallback === undefined ? {} : { fallback })
      } satisfies StoredVisionSettingsForMutation;
      const execution = await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        commit: (store) => {
          if (patch.resetAll || Object.keys(next).length === 0) {
            store.deleteSetting("service", "orchestrator", "settings.vision_bridge");
          } else {
            store.setSetting("service", "orchestrator", "settings.vision_bridge", next);
          }
          return { accepted: true, resultCase: "settings" } satisfies OperationOutcome;
        }
      });
      try {
        await dependencies.refreshPiGeneration?.();
      } catch {
        throw new ConnectError(
          "Vision Bridge settings were saved, but the managed Pi generation could not be refreshed.",
          Code.Unavailable
        );
      }
      return presented(execution);
    }
    case "updatePromptRecommendationSettings": {
      const patch = payload.value.patch;
      if (patch === undefined || patch.resetEnabled === (patch.enabled !== undefined)) {
        throw invalidArgument("Specify exactly one of patch.enabled or patch.reset_enabled");
      }
      if (!patch.resetEnabled && dependencies.promptPrediction === undefined) {
        return unsupportedOperation(
          dependencies,
          operationId,
          connection,
          mutation,
          payload.case,
          "Prompt recommendation is not configured on this Orchestrator node."
        );
      }
      const enabled = patch.resetEnabled ? true : patch.enabled as boolean;
      const execution = await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        commit: (store) => {
          if (patch.resetEnabled) store.deleteSetting("service", "orchestrator", "settings.prompt_recommendation");
          else store.setSetting("service", "orchestrator", "settings.prompt_recommendation", { enabled });
          return { accepted: true, resultCase: "settings" } satisfies OperationOutcome;
        }
      });
      return presented(execution);
    }
    case "updatePersonalizationSettings": {
      const patch = payload.value.patch;
      if (patch === undefined) throw invalidArgument("update_personalization_settings.patch is required");
      const silentSpecified = patch.resetSilentEncryptedRetry !== (patch.silentEncryptedRetryEnabled !== undefined);
      const runtimeFallbackSpecified = patch.resetSessionRuntimeFallback
        !== (patch.sessionRuntimeFallbackEnabled !== undefined);
      if (silentSpecified === runtimeFallbackSpecified) {
        throw invalidArgument(
          "Specify exactly one personalization setting family and either its value or reset flag"
        );
      }
      if (runtimeFallbackSpecified) {
        const enabled = patch.resetSessionRuntimeFallback
          ? SESSION_RUNTIME_FALLBACK_DEFAULT_ENABLED
          : patch.sessionRuntimeFallbackEnabled as boolean;
        const execution = await host.mutate({
          operationId,
          connection,
          kind: payload.case,
          body: mutation,
          commit: (store) => {
            if (patch.resetSessionRuntimeFallback) {
              store.deleteSetting("service", "orchestrator", SESSION_RUNTIME_FALLBACK_SETTING_KEY);
            } else {
              store.setSetting("service", "orchestrator", SESSION_RUNTIME_FALLBACK_SETTING_KEY, { enabled });
            }
            return { accepted: true, resultCase: "settings" } satisfies OperationOutcome;
          }
        });
        return presented(execution);
      }
      const reset = patch.resetSilentEncryptedRetry;
      const enabled = reset
        ? SILENT_ENCRYPTED_RETRY_DEFAULT_ENABLED
        : patch.silentEncryptedRetryEnabled as boolean;
      const capableBackendIds = dependencies.store.listBackends()
        .filter((item) => item.descriptor.capabilities.get("context.silent_encrypted_retry")?.supported === true)
        .map((item) => item.descriptor.id);
      if (capableBackendIds.length === 0) {
        return unsupportedOperation(
          dependencies,
          operationId,
          connection,
          mutation,
          payload.case,
          "No configured Backend supports silent encrypted-reasoning recovery."
        );
      }
      const execution = await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        commit: (store) => {
          if (reset) store.deleteSetting("service", "orchestrator", SILENT_ENCRYPTED_RETRY_SETTING_KEY);
          else store.setSetting("service", "orchestrator", SILENT_ENCRYPTED_RETRY_SETTING_KEY, { enabled });
          return { accepted: true, resultCase: "settings" } satisfies OperationOutcome;
        }
      });

      // Reconcile even on replay: a prior service process may have committed
      // the owner setting and exited before updating generation/runtime files.
      const failures: string[] = [];
      for (const backendId of capableBackendIds) {
        try {
          await host.invokeBackendAdapter(backendId, async (adapter) => {
            if (adapter.configureSilentEncryptedRetry === undefined) {
              failures.push(`future:${backendId}`);
              return;
            }
            await adapter.configureSilentEncryptedRetry(enabled);
          });
        } catch {
          failures.push(`future:${backendId}`);
        }
      }
      for (const backendId of capableBackendIds) {
        try {
          await host.applyToActiveSessions({ backendId }, async (sessionId, adapter, adapterContext) => {
            if (adapter.setSilentEncryptedRetry === undefined) {
              failures.push(`unsupported:${sessionId}`);
              return;
            }
            try {
              await adapter.setSilentEncryptedRetry(enabled, adapterContext);
            } catch {
              failures.push(`runtime:${sessionId}`);
            }
          });
        } catch {
          failures.push(`backend:${backendId}`);
        }
      }
      if (failures.length > 0) {
        dependencies.store.appendDiagnostic({
          severity: "warning",
          component: "personalization",
          code: "SILENT_ENCRYPTED_RETRY_RECONCILIATION_FAILED",
          message: "The owner preference was committed, but one or more live Backend projections could not be refreshed.",
          details: { failures }
        });
      }
      return presented(execution);
    }
    case "upsertProvider": {
      if (dependencies.providers === undefined) return unsupportedOperation(dependencies, operationId, connection, mutation, payload.case, "The managed Provider catalog is not configured.");
      if (payload.value.provider === undefined) return unsupportedOperation(dependencies, operationId, connection, mutation, payload.case, "Provider configuration is required.");
      const entry = providerEntryFromProto(payload.value.provider);
      return effectOperation(dependencies, operationId, connection, mutation, payload.case, {
        accepted: true,
        resultCase: "provider",
        entityId: entry.provider.id
      }, async () => {
        await dependencies.providers!.upsert(entry);
        clearManagedProviderRateLimit(dependencies, entry.provider.id);
        await dependencies.refreshPiGeneration?.();
        dependencies.messageSearch?.reconcileAvailability();
      });
    }
    case "deleteProvider": {
      if (dependencies.providers === undefined) return unsupportedOperation(dependencies, operationId, connection, mutation, payload.case, "The managed Provider catalog is not configured.");
      return effectOperation(dependencies, operationId, connection, mutation, payload.case, {
        accepted: true,
        resultCase: "acknowledgement"
      }, async () => {
        if (!await dependencies.providers!.delete(payload.value.providerId)) throw new ConnectError("Provider not found.", Code.NotFound);
        clearManagedProviderRateLimit(dependencies, payload.value.providerId);
        await dependencies.refreshPiGeneration?.();
        dependencies.messageSearch?.reconcileAvailability();
      });
    }
    case "refreshProviderModels": {
      const backendId = nonBlankRequest(payload.value.backendId, "backend_id");
      const rawProviderId = payload.value.providerId;
      const providerId = rawProviderId.trim();
      if (rawProviderId !== "" && providerId === "") throw invalidArgument("provider_id is invalid");
      if (managedProviderCatalogApplies(dependencies, backendId)) {
        if (dependencies.providerAuth === undefined) {
          return unsupportedOperation(dependencies, operationId, connection, mutation, payload.case, "Provider model catalog refresh is not configured.");
        }
        return effectOperation(dependencies, operationId, connection, mutation, payload.case, {
          accepted: true,
          resultCase: "acknowledgement"
        }, async () => {
          await dependencies.providerAuth!.refreshModelCatalogs({
            ...(providerId === "" ? {} : { providerId }),
            automatic: payload.value.automatic
          });
          dependencies.messageSearch?.reconcileAvailability();
        });
      }
      const descriptor = dependencies.store.getBackend(backendId).descriptor;
      const nativeProviderId = providerId
        || descriptor.providers?.[0]?.providerId
        || descriptor.models[0]?.providerId;
      if (nativeProviderId === undefined) throw new ConnectError("Provider not found.", Code.NotFound);
      backendProviderAccountOperations(dependencies, backendId, nativeProviderId, "provider.model_refresh");
      return effectOperation(dependencies, operationId, connection, mutation, payload.case, {
        accepted: true,
        resultCase: "acknowledgement"
      }, async () => {
        await dependencies.sessionHost.invokeBackendAdapter(backendId, async (adapter) => {
          const { operations } = backendProviderAccountOperations(
            dependencies,
            backendId,
            nativeProviderId,
            "provider.model_refresh",
            adapter
          );
          if (dependencies.refreshBackendDescriptor === undefined) await operations.listModels!();
          else await dependencies.refreshBackendDescriptor(backendId);
        });
        dependencies.messageSearch?.reconcileAvailability();
      });
    }
    case "commitCredential": {
      if (dependencies.credentials === undefined) return unsupportedOperation(dependencies, operationId, connection, mutation, payload.case, "The managed Credential channel is not configured.");
      const kind = nativeCredentialKind(payload.value.kind, false)!;
      const reference = payload.value.credentialReferenceId || `cred_${createHash("sha256").update(operationId).digest("hex").slice(0, 24)}`;
      if (payload.value.providerId !== "" && dependencies.providers === undefined) {
        return unsupportedOperation(dependencies, operationId, connection, mutation, payload.case, "The Provider catalog required to bind this credential is not configured.");
      }
      return effectOperation(dependencies, operationId, connection, mutation, payload.case, {
        accepted: true,
        resultCase: "credential",
        entityId: reference
      }, async () => {
        if (payload.value.providerId !== "") {
          await dependencies.providers!.commitCredential({
            providerId: payload.value.providerId,
            ...(payload.value.environmentName === "" ? {} : { environmentName: payload.value.environmentName }),
            credentialUploadTicketId: payload.value.credentialUploadTicketId,
            credentialReferenceId: reference,
            displayName: payload.value.displayName,
            kind,
            connectionId: connection.id
          });
          clearManagedProviderRateLimit(dependencies, payload.value.providerId);
          await dependencies.refreshPiGeneration?.();
          dependencies.messageSearch?.reconcileAvailability();
        } else {
          await dependencies.credentials!.commitUpload({
            credentialUploadTicketId: payload.value.credentialUploadTicketId,
            credentialReferenceId: reference,
            displayName: payload.value.displayName,
            kind,
            connectionId: connection.id
          });
        }
      });
    }
    case "commitProviderCredentialSurface": {
      if (dependencies.credentials === undefined) return unsupportedOperation(dependencies, operationId, connection, mutation, payload.case, "The managed Credential channel is not configured.");
      const backendId = nonBlankRequest(payload.value.backendId, "backend_id");
      const providerId = nonBlankRequest(payload.value.providerId, "provider_id");
      const surfaceId = nonBlankRequest(payload.value.surfaceId, "surface_id");
      const resolved = resolveProviderCredentialSurface(dependencies, backendId, providerId, surfaceId);
      return effectOperation(dependencies, operationId, connection, mutation, payload.case, {
        accepted: true,
        resultCase: "acknowledgement"
      }, async () => {
        const current = resolveProviderCredentialSurface(dependencies, backendId, providerId, surfaceId);
        if (current.credentialReferenceId !== resolved.credentialReferenceId
          || current.surface.kind !== resolved.surface.kind
          || current.surface.capability !== resolved.surface.capability
          || current.surface.executionApi !== resolved.surface.executionApi) {
          throw new ConnectError("Provider credential surface changed before commit.", Code.FailedPrecondition);
        }
        await dependencies.credentials!.commitManagedUpload({
          credentialUploadTicketId: payload.value.credentialUploadTicketId,
          credentialReferenceId: current.credentialReferenceId,
          displayName: `${current.provider.displayName} image generation`,
          kind: current.surface.kind,
          providerId,
          connectionId: connection.id
        });
        await dependencies.refreshPiGeneration?.();
      });
    }
    case "clearProviderCredentialSurface": {
      if (dependencies.credentials === undefined) return unsupportedOperation(dependencies, operationId, connection, mutation, payload.case, "The managed Credential channel is not configured.");
      const backendId = nonBlankRequest(payload.value.backendId, "backend_id");
      const providerId = nonBlankRequest(payload.value.providerId, "provider_id");
      const surfaceId = nonBlankRequest(payload.value.surfaceId, "surface_id");
      const resolved = resolveProviderCredentialSurface(dependencies, backendId, providerId, surfaceId);
      return effectOperation(dependencies, operationId, connection, mutation, payload.case, {
        accepted: true,
        resultCase: "acknowledgement"
      }, async () => {
        const current = resolveProviderCredentialSurface(dependencies, backendId, providerId, surfaceId);
        if (current.credentialReferenceId !== resolved.credentialReferenceId
          || current.surface.kind !== resolved.surface.kind
          || current.surface.capability !== resolved.surface.capability
          || current.surface.executionApi !== resolved.surface.executionApi) {
          throw new ConnectError("Provider credential surface changed before removal.", Code.FailedPrecondition);
        }
        await dependencies.credentials!.deleteManagedSecret(current.credentialReferenceId);
        await dependencies.refreshPiGeneration?.();
      });
    }
    case "deleteCredential": {
      if (dependencies.credentials === undefined) return unsupportedOperation(dependencies, operationId, connection, mutation, payload.case, "The managed Credential channel is not configured.");
      return effectOperation(dependencies, operationId, connection, mutation, payload.case, {
        accepted: true,
        resultCase: "acknowledgement"
      }, async () => {
        const providerBindings = dependencies.providers?.list().filter((item) =>
          item.credentialReferenceIds.includes(payload.value.credentialReferenceId)) ?? [];
        const nativeProvider = providerBindings.find((item) =>
          item.nativeCredentialReferenceId === payload.value.credentialReferenceId);
        const managedProviderBound = providerBindings.some((item) =>
          item.nativeCredentialReferenceId !== payload.value.credentialReferenceId);
        const mcpBound = dependencies.mcpRouter?.list().some((item) => item.credentialBindings.some(
          (binding) => binding.credentialReferenceId === payload.value.credentialReferenceId
        )) ?? false;
        if (managedProviderBound || mcpBound || (nativeProvider !== undefined && providerBindings.length !== 1)) {
          throw new ConnectError("Credential is still referenced by managed configuration; remove its bindings first.", Code.FailedPrecondition);
        }
        if (nativeProvider !== undefined) {
          await dependencies.providers!.logout(nativeProvider.provider.id);
          clearManagedProviderRateLimit(dependencies, nativeProvider.provider.id);
          await dependencies.refreshPiGeneration?.();
          dependencies.messageSearch?.reconcileAvailability();
        } else if (!await dependencies.credentials!.delete(payload.value.credentialReferenceId)) {
          throw new ConnectError("Credential not found.", Code.NotFound);
        }
      });
    }
    case "beginProviderLogin": {
      const backendId = nonBlankRequest(payload.value.backendId, "backend_id");
      const providerId = nonBlankRequest(payload.value.providerId, "provider_id");
      const method = nativeProviderLoginMethod(payload.value.method);
      if (managedProviderCatalogApplies(dependencies, backendId)) {
        let flow: NativeProviderLoginFlow | undefined;
        return presented(await host.mutate({
          operationId,
          connection,
          kind: payload.case,
          body: mutation,
          effect: async () => {
            flow = await dependencies.providers.beginLogin(providerId, method);
            dependencies.providerLoginFlows.set(flow.opaqueFlowId, flow);
          },
          commit: () => {
            if (flow === undefined) throw new Error("Provider login effect completed without a flow.");
            const loginFlowId = flow.opaqueFlowId;
            return {
              accepted: true,
              resultCase: "providerLogin",
              entityId: loginFlowId,
              providerLogin: {
                loginFlowId,
                providerId: flow.providerId,
                method: flow.method,
                ...(flow.verificationUri === undefined ? {} : { verificationUri: flow.verificationUri }),
                ...(flow.userCode === undefined ? {} : { userCode: flow.userCode }),
                ...(flow.expiresAt === undefined ? {} : { expiresAt: flow.expiresAt })
              }
            } satisfies OperationOutcome;
          }
        }));
      }
      backendProviderAccountOperations(dependencies, backendId, providerId, "provider.login");
      let flow: BackendProviderLoginFlow | undefined;
      return presented(await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        effect: async () => {
          const at = (dependencies.now ?? Date.now)();
          const loginFlowId = randomUUID();
          if (method === "api_key") {
            flow = rememberBackendProviderLoginFlow(dependencies, {
              backendId,
              providerId,
              method,
              opaqueFlowId: loginFlowId,
              state: "pending",
              startedAt: at,
              updatedAt: at,
              expiresAt: at + BACKEND_PROVIDER_LOGIN_TTL_MS,
              pendingPrompt: {
                promptId: randomUUID(),
                kind: "secret",
                message: "Enter the Provider API key.",
                placeholder: "",
                createdAt: at
              }
            });
            return;
          }
          const nativeMethod = method === "device_code" ? "device_code" : "oauth_browser";
          const result = await dependencies.sessionHost.invokeBackendAdapter(backendId, async (adapter) => {
            const { operations } = backendProviderAccountOperations(
              dependencies,
              backendId,
              providerId,
              "provider.login",
              adapter
            );
            const begun = await operations.beginLogin!({ method: nativeMethod });
            if (begun.method === "api_key") {
              throw new Error("Native Provider returned the wrong login method.");
            }
            if (begun.method !== nativeMethod) {
              await operations.cancelLogin?.(begun.loginId);
              throw new Error("Native Provider returned the wrong login method.");
            }
            return begun;
          });
          flow = rememberBackendProviderLoginFlow(dependencies, {
            backendId,
            providerId,
            method,
            opaqueFlowId: loginFlowId,
            state: "pending",
            startedAt: at,
            updatedAt: at,
            expiresAt: at + BACKEND_PROVIDER_LOGIN_TTL_MS,
            nativeLoginId: result.loginId,
            verificationUri: result.url,
            ...(result.method === "device_code" ? { userCode: result.userCode } : {})
          });
          try {
            await dependencies.refreshBackendDescriptor?.(backendId);
          } catch {
            flow = updateBackendProviderLoginFlow(dependencies, flow, {
              updatedAt: (dependencies.now ?? Date.now)(),
              error: "Provider login started, but account state could not be refreshed."
            });
          }
        },
        commit: () => {
          if (flow === undefined) throw new Error("Provider login effect completed without a flow.");
          return {
            accepted: true,
            resultCase: "providerLogin",
            entityId: flow.opaqueFlowId,
            providerLogin: {
              loginFlowId: flow.opaqueFlowId,
              providerId: flow.providerId,
              method: flow.method,
              ...(flow.verificationUri === undefined ? {} : { verificationUri: flow.verificationUri }),
              ...(flow.userCode === undefined ? {} : { userCode: flow.userCode }),
              ...(flow.expiresAt === undefined ? {} : { expiresAt: flow.expiresAt })
            }
          } satisfies OperationOutcome;
        }
      }));
    }
    case "refreshProviderCredential": {
      const backendId = nonBlankRequest(payload.value.backendId, "backend_id");
      const providerId = nonBlankRequest(payload.value.providerId, "provider_id");
      if (!managedProviderCatalogApplies(dependencies, backendId)) {
        backendProviderAccountOperations(dependencies, backendId, providerId, "provider.refresh");
        return effectOperation(dependencies, operationId, connection, mutation, payload.case, {
          accepted: true,
          resultCase: "acknowledgement"
        }, async () => {
          await dependencies.sessionHost.invokeBackendAdapter(backendId, async (adapter) => {
            const { operations } = backendProviderAccountOperations(
              dependencies,
              backendId,
              providerId,
              "provider.refresh",
              adapter
            );
            if (operations.readAccount === undefined) {
              await dependencies.refreshBackendDescriptor?.(backendId);
              return;
            }
            await operations.readAccount(true);
            try {
              await dependencies.refreshBackendDescriptor?.(backendId);
            } catch {
              try {
                dependencies.store.appendDiagnostic({
                  severity: "warning",
                  component: "provider",
                  code: "PROVIDER_ACCOUNT_PROJECTION_REFRESH_FAILED",
                  message: "Provider account refresh completed, but its projected state could not be refreshed.",
                  details: { backendId, providerId }
                });
              } catch {
                // The credential mutation is authoritative even when diagnostics are unavailable.
              }
            }
          });
        });
      }
      return effectOperation(dependencies, operationId, connection, mutation, payload.case, {
        accepted: true,
        resultCase: "provider",
        entityId: providerId
      }, async () => {
        await dependencies.providers.refreshCredential(providerId);
        clearProviderRateLimit(dependencies.store, backendId, providerId);
        await dependencies.refreshPiGeneration?.();
        dependencies.messageSearch?.reconcileAvailability();
      });
    }
    case "logoutProvider": {
      const backendId = nonBlankRequest(payload.value.backendId, "backend_id");
      const providerId = nonBlankRequest(payload.value.providerId, "provider_id");
      if (!managedProviderCatalogApplies(dependencies, backendId)) {
        backendProviderAccountOperations(dependencies, backendId, providerId, "provider.logout");
        return effectOperation(dependencies, operationId, connection, mutation, payload.case, {
          accepted: true,
          resultCase: "acknowledgement"
        }, async () => {
          await dependencies.sessionHost.invokeBackendAdapter(backendId, async (adapter) => {
            const operations = backendProviderAccountOperations(
              dependencies,
              backendId,
              providerId,
              "provider.logout",
              adapter
            ).operations;
            await operations.logout!();
            try {
              await dependencies.refreshBackendDescriptor?.(backendId);
            } catch {
              try {
                dependencies.store.appendDiagnostic({
                  severity: "warning",
                  component: "provider",
                  code: "PROVIDER_LOGOUT_PROJECTION_REFRESH_FAILED",
                  message: "Provider logout completed, but its projected state could not be refreshed.",
                  details: { backendId, providerId }
                });
              } catch {
                // Logout is authoritative even when diagnostics are unavailable.
              }
            }
          });
        });
      }
      return effectOperation(dependencies, operationId, connection, mutation, payload.case, {
        accepted: true,
        resultCase: "provider",
        entityId: providerId
      }, async () => {
        await dependencies.providers.logout(providerId);
        clearProviderRateLimit(dependencies.store, backendId, providerId);
        await dependencies.refreshPiGeneration?.();
        dependencies.messageSearch?.reconcileAvailability();
      });
    }
    case "createDiagnosticsBundle": {
      if (dependencies.diagnosticsBundles === undefined) return unsupportedOperation(dependencies, operationId, connection, mutation, payload.case, "Diagnostics bundle materialization is not configured.");
      let artifactId: string | undefined;
      return presented(await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        effect: async () => {
          const artifact = await dependencies.diagnosticsBundles!.create({
          level: nativeDiagnosticLevel(payload.value.level),
          diagnosticIds: payload.value.diagnosticIds
          });
          artifactId = artifact.id;
          dependencies.diagnosticsArtifacts.set(operationId, artifact.id);
        },
        commit: () => {
          if (artifactId === undefined) throw new Error("Diagnostics effect completed without an Artifact.");
          return { accepted: true, resultCase: "diagnosticsBundle", entityId: artifactId } satisfies OperationOutcome;
        }
      }));
    }
    case "executeUserShell":
      return ackOperation(dependencies, operationId, connection, mutation, payload.case, () => host.executeUserShell(payload.value.sessionId, {
        command: payload.value.command,
        excludeFromContext: payload.value.excludeFromContext
      }, operationId).then(() => undefined));
    case "abortUserShell":
      return ackOperation(dependencies, operationId, connection, mutation, payload.case, () => host.abortUserShell(payload.value.sessionId));
    case "uploadBrowserFile": {
      if (dependencies.browserTransfers === undefined) return unsupportedOperation(dependencies, operationId, connection, mutation, payload.case, "Browser file transfer is not configured.");
      if (dependencies.browserProvider === undefined) return unsupportedOperation(dependencies, operationId, connection, mutation, payload.case, "Browser Provider is not configured.");
      if (payload.value.browserProviderId !== dependencies.browserTransfers.browserProviderId) {
        throw new ConnectError("Browser Provider not found.", Code.NotFound);
      }
      if (dependencies.browserSettings?.uploadAllowed() === false) {
        throw new ConnectError("Browser uploads are disabled by owner policy.", Code.FailedPrecondition);
      }
      if (payload.value.blob === undefined) return unsupportedOperation(dependencies, operationId, connection, mutation, payload.case, "A typed Browser upload Blob is required.");
      const blob = fromProtoBlobRef(payload.value.blob);
      const pageOwner = requireActiveBrowserPageAuthority(
        dependencies.browserState,
        dependencies.browserProvider.id,
        payload.value.pageId,
        dependencies.browserProvider.generation
      );
      let transfer: contract.BrowserTransfer | undefined;
      return presented(await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        precondition: () => {
          requireActiveBrowserPageAuthority(
            dependencies.browserState,
            dependencies.browserProvider!.id,
            payload.value.pageId,
            dependencies.browserProvider!.generation,
            pageOwner
          );
        },
        effect: async () => {
          const takeover = dependencies.browserProvider?.currentHumanTakeover();
          const humanTakeover = takeover !== undefined
            && takeover.providerId === dependencies.browserTransfers!.browserProviderId
            && takeover.pageId === payload.value.pageId
            && takeover.owner === connection.id
            && takeover.generation === dependencies.browserProvider!.generation
              ? takeover
              : undefined;
          transfer = await dependencies.browserTransfers!.upload(blob, payload.value.pageId, payload.value.inputHint, {
            id: connection.id,
            ...(humanTakeover === undefined ? {} : { humanTakeover })
          });
          requireActiveBrowserPageAuthority(
            dependencies.browserState,
            dependencies.browserProvider!.id,
            payload.value.pageId,
            dependencies.browserProvider!.generation,
            pageOwner
          );
          dependencies.browserTransferOperations.set(operationId, transfer.browserTransferId);
        },
        commit: () => {
          if (transfer === undefined) throw new Error("Browser upload effect completed without a transfer.");
          return {
            accepted: true,
            resultCase: "browserTransfer",
            entityId: transfer.browserTransferId,
            browserTransferBinaryBase64: Buffer.from(toBinary(contract.BrowserTransferSchema, transfer)).toString("base64")
          } satisfies OperationOutcome;
        }
      }));
    }
    case "upsertMcpServer": {
      if (dependencies.mcpRouter === undefined) return unsupportedOperation(dependencies, operationId, connection, mutation, payload.case, "The MCP Router is not configured.");
      if (payload.value.server === undefined) return unsupportedOperation(dependencies, operationId, connection, mutation, payload.case, "MCP Server input is required.");
      const input = nativeMcpServerInput(payload.value.mcpServerId, payload.value.server);
      if (payload.value.expectedRevision === undefined) throw invalidArgument("expected_revision is required");
      const expectedVersion = fromProtoRevision(payload.value.expectedRevision, "upsert_mcp_server.expected_revision");
      return effectOperation(dependencies, operationId, connection, mutation, payload.case, {
        accepted: true,
        resultCase: "mcpServer",
        entityId: input.id
      }, async () => {
        await dependencies.mcpRouter!.upsert(input, expectedVersion);
        await dependencies.refreshPiGeneration?.();
      });
    }
    case "deleteMcpServer": {
      if (dependencies.mcpRouter === undefined) return unsupportedOperation(dependencies, operationId, connection, mutation, payload.case, "The MCP Router is not configured.");
      return effectOperation(dependencies, operationId, connection, mutation, payload.case, {
        accepted: true,
        resultCase: "acknowledgement"
      }, async () => {
        if (!await dependencies.mcpRouter!.delete(payload.value.mcpServerId)) throw new ConnectError("MCP Server not found.", Code.NotFound);
        await dependencies.refreshPiGeneration?.();
      });
    }
    case "restartMcpServer": {
      if (dependencies.mcpRouter === undefined) return unsupportedOperation(dependencies, operationId, connection, mutation, payload.case, "The MCP Router is not configured.");
      return effectOperation(dependencies, operationId, connection, mutation, payload.case, {
        accepted: true,
        resultCase: "mcpServer",
        entityId: payload.value.mcpServerId
      }, async () => {
        await dependencies.mcpRouter!.restart(payload.value.mcpServerId);
        await dependencies.refreshPiGeneration?.();
      });
    }
    case "discoverProjectResources": {
      if (dependencies.piResources === undefined) return unsupportedOperation(dependencies, operationId, connection, mutation, payload.case, "The Pi Resource Manager is not configured.");
      const target = dependencies.store.getTarget(payload.value.targetId).descriptor;
      if (!target.trusted) throw new ConnectError("Project resources can only be discovered after the Target is trusted.", Code.FailedPrecondition);
      return ackOperation(dependencies, operationId, connection, mutation, payload.case, async () => {
        await dependencies.piResources!.discoverProjectResources({ backendId: target.backendId, targetId: target.id });
      });
    }
    case "addResource": {
      if (dependencies.piResources === undefined) return unsupportedOperation(dependencies, operationId, connection, mutation, payload.case, "The Pi Resource Manager is not configured.");
      const backendId = payload.value.backendId.trim();
      if (backendId === "") throw invalidArgument("backend_id is required");
      dependencies.store.getBackend(backendId);
      const scope = nativeResourceScope(payload.value.scope);
      let targetId: string | undefined;
      let workspaceRoot: string | undefined;
      if (scope === "project") {
        if (payload.value.targetId.trim() === "") throw invalidArgument("target_id is required for a project resource");
        const target = dependencies.store.getTarget(payload.value.targetId).descriptor;
        if (target.backendId !== backendId) throw new ConnectError("Target does not belong to the requested Backend.", Code.FailedPrecondition);
        if (!target.trusted) throw new ConnectError("Project resources can only be added after the Target is trusted.", Code.FailedPrecondition);
        targetId = target.id;
        workspaceRoot = target.workspaceRoot;
      } else if (payload.value.targetId !== "") {
        throw invalidArgument("target_id is only valid for a project resource");
      }
      const kind = nativeResourceKind(payload.value.kind);
      if (payload.value.acquisition === undefined) throw invalidArgument("acquisition is required");
      const acquisition = nativeResourceAcquisition(payload.value.acquisition);
      if (acquisition.kind !== "local" && kind !== "package") {
        throw invalidArgument("npm and git acquisition are valid only for package resources");
      }
      let resourceSourceIdentity: string;
      if (kind === "package") resourceSourceIdentity = piPackageSourceIdentity(acquisition);
      else {
        if (acquisition.kind !== "local") throw invalidArgument("non-package resources require a local acquisition source");
        resourceSourceIdentity = `${kind}:${process.platform === "win32" ? resolve(acquisition.path).toLowerCase() : resolve(acquisition.path)}`;
      }
      const resourceId = `resource_owner_${createHash("sha256")
        .update(`${backendId}\0${targetId ?? ""}\0${scope}\0${kind}\0${resourceSourceIdentity}`)
        .digest("hex").slice(0, 32)}`;
      return ackOperation(dependencies, operationId, connection, mutation, payload.case, async () => {
        const common = {
          id: resourceId,
          backendId,
          ...(targetId === undefined ? {} : { targetId }),
          scope,
          ...(payload.value.name.trim() === "" ? {} : { name: payload.value.name }),
          ...(payload.value.version.trim() === "" ? {} : { version: payload.value.version })
        };
        if (kind === "package") {
          await dependencies.piResources!.discoverPackage({
            ...common,
            source: acquisition,
            ...(workspaceRoot === undefined || acquisition.kind !== "local" ? {} : { workspaceRoot })
          });
        } else {
          if (acquisition.kind !== "local") throw new Error("Non-package resource acquisition was not local.");
          await dependencies.piResources!.discover({
            ...common,
            kind,
            source: acquisition,
            ...(workspaceRoot === undefined ? {} : { workspaceRoot })
          });
        }
      });
    }
    case "approveResource": {
      if (dependencies.piResources === undefined) return unsupportedOperation(dependencies, operationId, connection, mutation, payload.case, "The Pi Resource Manager is not configured.");
      return resourceEffectOperation(dependencies, operationId, connection, mutation, payload.case, payload.value.resourceId, async () => {
        await dependencies.piResources!.approve(payload.value.resourceId, payload.value.discoveredRevision, connection.id);
      });
    }
    case "installResource": {
      if (dependencies.piResources === undefined) return unsupportedOperation(dependencies, operationId, connection, mutation, payload.case, "The Pi Resource Manager is not configured.");
      return resourceEffectOperation(dependencies, operationId, connection, mutation, payload.case, payload.value.resourceId, async () => {
        await dependencies.piResources!.install(payload.value.resourceId);
      });
    }
    case "updateResource": {
      if (dependencies.piResources === undefined) return unsupportedOperation(dependencies, operationId, connection, mutation, payload.case, "The Pi Resource Manager is not configured.");
      if (payload.value.acquisition !== undefined && payload.value.requestedVersion !== "") {
        throw invalidArgument("acquisition and requested_version cannot both be set");
      }
      const acquisition = payload.value.acquisition === undefined
        ? undefined
        : nativeResourceAcquisition(payload.value.acquisition);
      return resourceEffectOperation(dependencies, operationId, connection, mutation, payload.case, payload.value.resourceId, async () => {
        await dependencies.piResources!.update(payload.value.resourceId, {
          ...(payload.value.requestedVersion === "" ? {} : { requestedVersion: payload.value.requestedVersion }),
          ...(acquisition === undefined ? {} : { source: acquisition }),
          approvedByConnectionId: connection.id
        });
      });
    }
    case "setResourceEnabled": {
      if (dependencies.piResources === undefined) return unsupportedOperation(dependencies, operationId, connection, mutation, payload.case, "The Pi Resource Manager is not configured.");
      return resourceEffectOperation(dependencies, operationId, connection, mutation, payload.case, payload.value.resourceId, async () => {
        await dependencies.piResources!.setEnabled(payload.value.resourceId, payload.value.enabled);
      });
    }
    case "removeResource": {
      if (dependencies.piResources === undefined) return unsupportedOperation(dependencies, operationId, connection, mutation, payload.case, "The Pi Resource Manager is not configured.");
      return resourceEffectOperation(dependencies, operationId, connection, mutation, payload.case, payload.value.resourceId, async () => {
        await dependencies.piResources!.remove(payload.value.resourceId);
      });
    }
    case "abortToolCall": {
      const projected = listProjectedToolCalls(dependencies.store).find((item) => item.value.toolCallId === payload.value.toolCallId);
      if (projected === undefined) throw new ConnectError("Tool Call not found.", Code.NotFound);
      if (projected.runId === undefined || !isAbortableToolCallState(projected.value.state)) {
        throw new ConnectError("Tool Call is not attached to an abortable active Run.", Code.FailedPrecondition);
      }
      return ackOperation(dependencies, operationId, connection, mutation, payload.case, () => dependencies.sessionHost.abort(projected.sessionId, projected.runId!));
    }
    case "restartBrowser":
    case "recoverBrowser": {
      if (dependencies.browserTransfers === undefined) return unsupportedOperation(dependencies, operationId, connection, mutation, payload.case, "Browser recovery coordination is not configured.");
      if (payload.value.browserProviderId !== dependencies.browserTransfers.browserProviderId) throw new ConnectError("Browser Provider not found.", Code.NotFound);
      if (dependencies.browserSettings?.anyTargetEnabled() === false) throw new ConnectError("Browser Provider is disabled for every project.", Code.FailedPrecondition);
      return ackOperation(
        dependencies,
        operationId,
        connection,
        mutation,
        payload.case,
        async () => {
          dependencies.browserSettings?.setBackendHealth({ active: false, status: "recovering", canRecover: false });
          try {
            await (payload.case === "restartBrowser" ? dependencies.browserTransfers!.restart() : dependencies.browserTransfers!.recover());
            dependencies.browserSettings?.setBackendHealth({ active: true, status: "ready", canRecover: true });
          } catch (error) {
            dependencies.browserSettings?.setBackendHealth({ active: false, status: "error", canRecover: true, reason: "recoveryFailed" });
            throw error;
          }
        }
      );
    }
    case "beginBrowserTakeover": {
      if (dependencies.browserProvider === undefined) return unsupportedOperation(dependencies, operationId, connection, mutation, payload.case, "Browser Provider is not configured.");
      if (dependencies.browserSettings?.anyTargetEnabled() === false) throw new ConnectError("Browser Provider is disabled for every project.", Code.FailedPrecondition);
      if (payload.value.browserProviderId !== dependencies.browserProvider.id) {
        throw new ConnectError("Browser Provider not found.", Code.NotFound);
      }
      const requestedGeneration = dependencies.browserProvider.generation;
      const requestedOwner = requireActiveBrowserPageAuthority(
        dependencies.browserState,
        dependencies.browserProvider.id,
        payload.value.pageId,
        requestedGeneration
      );
      let takeover: ReturnType<BrowserProvider["currentHumanTakeover"]>;
      const execution = await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        precondition: () => {
          requireActiveBrowserPageAuthority(
            dependencies.browserState,
            dependencies.browserProvider!.id,
            payload.value.pageId,
            requestedGeneration,
            requestedOwner
          );
          if (takeover !== undefined) {
            dependencies.browserProvider!.assertHumanTakeover(takeover);
          } else if (dependencies.browserProvider!.generation !== requestedGeneration) {
            throw new StaleGenerationError(requestedGeneration, dependencies.browserProvider!.generation);
          }
        },
        effect: async () => {
          takeover = await dependencies.browserProvider!.beginHumanTakeover({
            providerId: dependencies.browserProvider!.id,
            pageId: payload.value.pageId,
            generation: requestedGeneration,
            owner: connection.id
          }, dependencies.browserSettings?.takeoverTimeout());
        },
        commit: () => ({ accepted: true, resultCase: "browserTakeover", entityId: takeover?.takeoverId } satisfies OperationOutcome)
      });
      return presented(execution);
    }
    case "openBrowserPage": {
      if (dependencies.browserProvider === undefined) return unsupportedOperation(dependencies, operationId, connection, mutation, payload.case, "Browser Provider is not configured.");
      if (payload.value.browserProviderId !== dependencies.browserProvider.id) {
        throw new ConnectError("Browser Provider not found.", Code.NotFound);
      }
      requireOpaqueTakeoverId(payload.value.sessionId, "Session ID");
      let browserSession;
      try {
        browserSession = dependencies.store.getSession(payload.value.sessionId);
      } catch {
        throw new ConnectError("Session not found.", Code.NotFound);
      }
      if (
        browserSession.descriptor.archived
        || browserSession.descriptor.deletedAt !== undefined
        || dependencies.store.findPendingSessionLifecycleCleanup(payload.value.sessionId) !== undefined
      ) {
        throw new ConnectError("Browser pages can only be opened for an active task.", Code.FailedPrecondition);
      }
      if (dependencies.browserSettings?.enabled(browserSession.descriptor.targetId) === false) {
        throw new ConnectError("Browser Provider is disabled for this project.", Code.FailedPrecondition);
      }
      const requestedPageOwner = {
        sessionId: browserSession.descriptor.id,
        targetId: browserSession.descriptor.targetId,
        bindingGeneration: browserSession.descriptor.binding.generation
      };
      try {
        requireActiveBrowserSessionAuthority(dependencies.browserState, requestedPageOwner);
      } catch {
        throw new ConnectError("Browser pages can only be opened for an active task.", Code.FailedPrecondition);
      }
      if (payload.value.expectedGeneration > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw invalidArgument("Expected Browser generation must be a non-negative safe integer.");
      }
      const expectedGeneration = Number(payload.value.expectedGeneration);
      const requestedUrl = validateTakeoverNavigationUrl(payload.value.url);
      const recovery = payload.value.recoveryPageId === ""
        ? undefined
        : dependencies.browserState?.findRecoverablePage(payload.value.browserProviderId, payload.value.recoveryPageId);
      if (payload.value.recoveryPageId !== "" && recovery === undefined) {
        throw new ConnectError("The Browser page recovery descriptor is missing or no longer recoverable.", Code.FailedPrecondition);
      }
      if (recovery !== undefined && recovery.sessionId !== payload.value.sessionId) {
        throw new ConnectError("The Browser page recovery descriptor belongs to another task.", Code.FailedPrecondition);
      }
      if (recovery !== undefined) {
        requireActiveBrowserPageAuthority(
          dependencies.browserState,
          payload.value.browserProviderId,
          recovery.pageId,
          recovery.generation,
          requestedPageOwner
        );
      }
      if (recovery !== undefined && requestedUrl !== recovery.url) {
        throw invalidArgument("Browser page recovery URL does not match its durable descriptor.");
      }
      const targetUrl = recovery?.url ?? requestedUrl;
      const provider = dependencies.browserProvider;
      const observed = provider.currentHumanTakeover();
      let sourceFence: ReturnType<BrowserProvider["currentHumanTakeover"]> = undefined;
      if (observed === undefined) {
        if (payload.value.currentPageId !== "" || payload.value.takeoverId !== "") {
          throw new ConnectError("Browser page open supplied a takeover fence while no human takeover is active.", Code.FailedPrecondition);
        }
      } else {
        sourceFence = requireOwnedBrowserPageFence(provider, connection.id, {
          browserProviderId: payload.value.browserProviderId,
          currentPageId: payload.value.currentPageId,
          takeoverId: payload.value.takeoverId,
          generation: payload.value.expectedGeneration
        });
        requireActiveBrowserPageAuthority(
          dependencies.browserState,
          provider.id,
          sourceFence.pageId,
          sourceFence.generation,
          requestedPageOwner
        );
      }
      let takeover: ReturnType<BrowserProvider["currentHumanTakeover"]>;
      let openedPage: NativeBrowserPage | undefined;
      const execution = await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        precondition: () => {
          requireActiveBrowserSessionAuthority(dependencies.browserState, requestedPageOwner);
          if (takeover !== undefined) {
            provider.assertHumanTakeover(takeover);
            return;
          }
          if (provider.generation !== expectedGeneration) {
            throw new StaleGenerationError(expectedGeneration, provider.generation);
          }
          if (sourceFence === undefined) {
            if (provider.currentHumanTakeover() !== undefined) {
              throw new BrowserTakeoverConflictError("Browser Provider acquired a human takeover after the page-open fence was observed.");
            }
          } else {
            provider.assertHumanTakeover(sourceFence);
            requireActiveBrowserPageAuthority(
              dependencies.browserState,
              provider.id,
              sourceFence.pageId,
              sourceFence.generation,
              requestedPageOwner
            );
          }
        },
        effect: async () => {
          if (recovery !== undefined && provider.running && (await provider.listPages()).some((page) => page.id === recovery.pageId)) {
            throw new ConnectError("The Browser page is still live and does not need recovery.", Code.FailedPrecondition);
          }
          await provider.start();
          const requestedGeneration = provider.generation;
          takeover = await provider.openHumanPage({
            providerId: provider.id,
            generation: requestedGeneration,
            owner: connection.id,
            url: targetUrl
          }, dependencies.browserSettings?.takeoverTimeout());
          openedPage = (await provider.listPages()).find((page) => page.id === takeover?.pageId);
        },
        commit: () => {
          if (takeover === undefined || openedPage === undefined) throw new Error("Browser page open completed without a live page takeover.");
          requireBrowserState(dependencies.browserState).recordHumanPage({
            browserProviderId: provider.id,
            pageId: openedPage.id,
            generation: takeover.generation,
            sessionId: payload.value.sessionId,
            targetId: browserSession.descriptor.targetId,
            bindingGeneration: browserSession.descriptor.binding.generation,
            url: targetUrl,
            title: openedPage.title,
            updatedAt: (dependencies.now ?? Date.now)()
          }, { active: true, ...(recovery === undefined ? {} : { replacesPageId: recovery.pageId }) });
          return { accepted: true, resultCase: "browserTakeover", entityId: takeover.takeoverId } satisfies OperationOutcome;
        }
      });
      return presented(execution);
    }
    case "focusBrowserPage": {
      if (dependencies.browserProvider === undefined) return unsupportedOperation(dependencies, operationId, connection, mutation, payload.case, "Browser Provider is not configured.");
      requireOpaqueTakeoverId(payload.value.pageId, "Target Browser page ID");
      const provider = dependencies.browserProvider;
      const current = requireOwnedBrowserPageFence(provider, connection.id, payload.value);
      const currentOwner = requireActiveBrowserPageAuthority(
        dependencies.browserState,
        provider.id,
        current.pageId,
        current.generation
      );
      const targetOwner = requireActiveBrowserPageAuthority(
        dependencies.browserState,
        provider.id,
        payload.value.pageId,
        current.generation
      );
      requireSameBrowserPageOwner(currentOwner, targetOwner);
      let takeover: ReturnType<BrowserProvider["currentHumanTakeover"]>;
      let focusedPage: NativeBrowserPage | undefined;
      const execution = await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        precondition: () => {
          provider.assertHumanTakeover(takeover ?? current);
          const currentPageOwner = requireActiveBrowserPageAuthority(
            dependencies.browserState,
            provider.id,
            current.pageId,
            current.generation,
            currentOwner
          );
          const focusedPageOwner = requireActiveBrowserPageAuthority(
            dependencies.browserState,
            provider.id,
            payload.value.pageId,
            current.generation,
            targetOwner
          );
          requireSameBrowserPageOwner(currentPageOwner, focusedPageOwner);
        },
        effect: async () => {
          takeover = await provider.focusHumanPage(current, payload.value.pageId, dependencies.browserSettings?.takeoverTimeout());
          focusedPage = (await provider.listPages()).find((page) => page.id === takeover?.pageId);
        },
        commit: () => {
          if (takeover === undefined || focusedPage === undefined) throw new Error("Browser page focus completed without a live page takeover.");
          requireActiveBrowserPageAuthority(
            dependencies.browserState,
            provider.id,
            focusedPage.id,
            takeover.generation,
            targetOwner
          );
          const recoveryUrl = recoverableBrowserUrl(focusedPage.url);
          if (recoveryUrl !== undefined) {
            requireBrowserState(dependencies.browserState).recordHumanPage({
              browserProviderId: provider.id,
              pageId: focusedPage.id,
              generation: takeover.generation,
              sessionId: targetOwner.sessionId,
              targetId: targetOwner.targetId,
              bindingGeneration: targetOwner.bindingGeneration,
              url: recoveryUrl,
              title: focusedPage.title,
              updatedAt: (dependencies.now ?? Date.now)()
            }, { active: true });
          }
          return { accepted: true, resultCase: "browserTakeover", entityId: takeover.takeoverId } satisfies OperationOutcome;
        }
      });
      return presented(execution);
    }
    case "closeBrowserPage": {
      if (dependencies.browserProvider === undefined) return unsupportedOperation(dependencies, operationId, connection, mutation, payload.case, "Browser Provider is not configured.");
      requireOpaqueTakeoverId(payload.value.pageId, "Target Browser page ID");
      const provider = dependencies.browserProvider;
      const current = requireOwnedBrowserPageFence(provider, connection.id, payload.value);
      const currentOwner = requireActiveBrowserPageAuthority(
        dependencies.browserState,
        provider.id,
        current.pageId,
        current.generation
      );
      const targetOwner = requireActiveBrowserPageAuthority(
        dependencies.browserState,
        provider.id,
        payload.value.pageId,
        current.generation
      );
      requireSameBrowserPageOwner(currentOwner, targetOwner);
      let takeover: ReturnType<BrowserProvider["currentHumanTakeover"]>;
      let activePage: NativeBrowserPage | undefined;
      let replacementOwner: RecoverableBrowserPageRecord | undefined;
      const execution = await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        precondition: () => {
          const currentPageOwner = requireActiveBrowserPageAuthority(
            dependencies.browserState,
            provider.id,
            current.pageId,
            current.generation,
            currentOwner
          );
          const closingPageOwner = requireActiveBrowserPageAuthority(
            dependencies.browserState,
            provider.id,
            payload.value.pageId,
            current.generation,
            targetOwner
          );
          requireSameBrowserPageOwner(currentPageOwner, closingPageOwner);
          if (takeover !== undefined) provider.assertHumanTakeover(takeover);
          else if (provider.currentHumanTakeover() !== undefined) provider.assertHumanTakeover(current);
        },
        effect: async () => {
          takeover = await provider.closeHumanPage(current, payload.value.pageId, dependencies.browserSettings?.takeoverTimeout());
          activePage = takeover === undefined
            ? undefined
            : (await provider.listPages()).find((page) => page.id === takeover?.pageId);
          if (takeover !== undefined && activePage !== undefined) {
            try {
              replacementOwner = requireActiveBrowserPageAuthority(
                dependencies.browserState,
                provider.id,
                activePage.id,
                takeover.generation
              );
              requireSameBrowserPageOwner(currentOwner, replacementOwner);
            } catch {
              await provider.endHumanTakeover(takeover).catch(() => undefined);
              takeover = undefined;
              activePage = undefined;
              replacementOwner = undefined;
            }
          }
        },
        commit: () => {
          requireBrowserState(dependencies.browserState).closeHumanPage(provider.id, payload.value.pageId, current.generation, takeover?.pageId);
          if (takeover !== undefined && activePage !== undefined && replacementOwner !== undefined) {
            const recoveryUrl = recoverableBrowserUrl(activePage.url);
            if (recoveryUrl !== undefined) {
              requireBrowserState(dependencies.browserState).recordHumanPage({
                browserProviderId: provider.id,
                pageId: activePage.id,
                generation: takeover.generation,
                sessionId: replacementOwner.sessionId,
                targetId: replacementOwner.targetId,
                bindingGeneration: replacementOwner.bindingGeneration,
                url: recoveryUrl,
                title: activePage.title,
                updatedAt: (dependencies.now ?? Date.now)()
              }, { active: true });
            }
            return { accepted: true, resultCase: "browserTakeover", entityId: takeover.takeoverId } satisfies OperationOutcome;
          }
          return { accepted: true, resultCase: "acknowledgement" } satisfies OperationOutcome;
        }
      });
      return presented(execution);
    }
    case "endBrowserTakeover": {
      if (dependencies.browserProvider === undefined) return unsupportedOperation(dependencies, operationId, connection, mutation, payload.case, "Browser Provider is not configured.");
      const current = dependencies.browserProvider.currentHumanTakeover();
      if (
        current === undefined ||
        current.takeoverId !== payload.value.takeoverId ||
        current.owner !== connection.id
      ) throw new ConnectError("Browser takeover is missing, fenced, or owned by another Connection.", Code.FailedPrecondition);
      return ackOperation(
        dependencies,
        operationId,
        connection,
        mutation,
        payload.case,
        () => dependencies.browserProvider!.endHumanTakeover(current)
      );
    }
    case "browserTakeoverAction": {
      if (dependencies.browserProvider === undefined) return unsupportedOperation(dependencies, operationId, connection, mutation, payload.case, "Browser Provider is not configured.");
      if (dependencies.browserSettings?.anyTargetEnabled() === false) throw new ConnectError("Browser Provider is disabled for every project.", Code.FailedPrecondition);
      const value = payload.value;
      requireOpaqueTakeoverId(value.browserProviderId, "Browser Provider ID");
      requireOpaqueTakeoverId(value.pageId, "Browser page ID");
      requireOpaqueTakeoverId(value.takeoverId, "Browser takeover ID");
      if (value.browserProviderId !== dependencies.browserProvider.id) {
        throw new ConnectError("Browser Provider not found.", Code.NotFound);
      }
      if (value.generation < 1n || value.generation > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw invalidArgument("Browser takeover generation must be a positive safe integer.");
      }
      const current = dependencies.browserProvider.currentHumanTakeover();
      if (
        current === undefined ||
        current.providerId !== value.browserProviderId ||
        current.pageId !== value.pageId ||
        current.takeoverId !== value.takeoverId ||
        BigInt(current.generation) !== value.generation ||
        current.owner !== connection.id
      ) {
        throw new ConnectError("Browser takeover is missing, fenced, or owned by another Connection.", Code.FailedPrecondition);
      }
      const input = mapBrowserTakeoverInput(value.action);
      const pageOwner = requireActiveBrowserPageAuthority(
        dependencies.browserState,
        current.providerId,
        current.pageId,
        current.generation
      );
      let updatedPage: NativeBrowserPage | undefined;
      const execution = await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        precondition: () => {
          dependencies.browserProvider!.assertHumanTakeover(current);
          requireActiveBrowserPageAuthority(
            dependencies.browserState,
            current.providerId,
            current.pageId,
            current.generation,
            pageOwner
          );
        },
        effect: async () => {
          await dependencies.browserProvider!.performHumanTakeoverAction(current, input);
          updatedPage = (await dependencies.browserProvider!.listPages()).find((page) => page.id === current.pageId);
          requireActiveBrowserPageAuthority(
            dependencies.browserState,
            current.providerId,
            current.pageId,
            current.generation,
            pageOwner
          );
        },
        commit: () => {
          const recoveryUrl = updatedPage === undefined ? undefined : recoverableBrowserUrl(updatedPage.url);
          if (recoveryUrl !== undefined && updatedPage !== undefined) {
            requireBrowserState(dependencies.browserState).recordHumanPage({
              browserProviderId: current.providerId,
              pageId: current.pageId,
              generation: current.generation,
              sessionId: pageOwner.sessionId,
              targetId: pageOwner.targetId,
              bindingGeneration: pageOwner.bindingGeneration,
              url: recoveryUrl,
              title: updatedPage.title,
              updatedAt: (dependencies.now ?? Date.now)()
            }, { active: true });
          }
          return { accepted: true, resultCase: "acknowledgement" } satisfies OperationOutcome;
        }
      });
      return presented(execution);
    }
    case "captureBrowserScreenshot": {
      if (dependencies.browserProvider === undefined) return unsupportedOperation(dependencies, operationId, connection, mutation, payload.case, "Browser Provider is not configured.");
      if (dependencies.browserSettings?.anyTargetEnabled() === false) throw new ConnectError("Browser Provider is disabled for every project.", Code.FailedPrecondition);
      if (
        !isBrowserProviderId(payload.value.browserProviderId) ||
        payload.value.browserProviderId === "" ||
        payload.value.browserProviderId !== dependencies.browserProvider.id
      ) {
        throw new ConnectError("Browser Provider not found.", Code.NotFound);
      }
      const expectedGeneration = dependencies.browserProvider.generation;
      const pageOwner = requireActiveBrowserPageAuthority(
        dependencies.browserState,
        dependencies.browserProvider.id,
        payload.value.pageId,
        expectedGeneration
      );
      let artifact: Awaited<ReturnType<BlobTransferCoordinator["acceptUpload"]>> | undefined;
      let capturedAt: number | undefined;
      const execution = await host.mutate({
        operationId,
        connection,
        kind: payload.case,
        body: mutation,
        precondition: () => {
          if (dependencies.browserProvider!.generation !== expectedGeneration) {
            throw new StaleGenerationError(expectedGeneration, dependencies.browserProvider!.generation);
          }
          requireActiveBrowserPageAuthority(
            dependencies.browserState,
            dependencies.browserProvider!.id,
            payload.value.pageId,
            expectedGeneration,
            pageOwner
          );
        },
        effect: async () => {
          const provider = dependencies.browserProvider!;
          const takeover = provider.currentHumanTakeover();
          let snapshot;
          if (takeover !== undefined && takeover.pageId === payload.value.pageId && takeover.owner === connection.id) {
            snapshot = await provider.snapshotHumanTakeover(takeover, { fullPage: payload.value.fullPage });
          } else {
            const lease = provider.acquireAgentLease(`connection:${connection.id}:screenshot`, 30_000);
            try {
              snapshot = await provider.snapshot(payload.value.pageId, lease, { fullPage: payload.value.fullPage });
            } finally {
              await provider.releaseAgentLease(lease).catch(() => undefined);
            }
          }
          if (dependencies.browserProvider!.generation !== expectedGeneration) {
            throw new StaleGenerationError(expectedGeneration, dependencies.browserProvider!.generation);
          }
          requireActiveBrowserPageAuthority(
            dependencies.browserState,
            provider.id,
            payload.value.pageId,
            expectedGeneration,
            pageOwner
          );
          const transfer = await dependencies.blobTransfers.beginUpload({ expectedSize: snapshot.screenshot.byteLength, maximumSize: snapshot.screenshot.byteLength, mimeType: "image/png", fileName: `${payload.value.pageId}.png` });
          const endpoint = transfer.relativeEndpoint.split("/");
          const secret = decodeURIComponent(endpoint.at(-1) ?? "");
          artifact = await dependencies.blobTransfers.acceptUpload(transfer.ticketId, secret, Readable.from(snapshot.screenshot));
          requireActiveBrowserPageAuthority(
            dependencies.browserState,
            provider.id,
            payload.value.pageId,
            expectedGeneration,
            pageOwner
          );
          capturedAt = (dependencies.now ?? Date.now)();
        },
        commit: () => {
          if (artifact === undefined || capturedAt === undefined) throw new Error("Browser screenshot effect completed without an Artifact.");
          dependencies.browserState?.recordScreenshot({
            browserProviderId: BROWSER_PROVIDER_ID,
            pageId: payload.value.pageId,
            generation: expectedGeneration,
            artifactId: artifact.id,
            blob: {
              id: artifact.id,
              sha256: artifact.sha256,
              byteLength: artifact.byteLength,
              mimeType: artifact.mimeType,
              ...(artifact.fileName === undefined ? {} : { fileName: artifact.fileName })
            },
            capturedAt
          });
          return { accepted: true, resultCase: "screenshot", entityId: artifact.id } satisfies OperationOutcome;
        }
      });
      return presented(execution);
    }
    case undefined:
      throw invalidArgument("mutation.payload is required");
  }
}

function withOperationPreconditions(
  host: ExtendedSessionHost,
  mutation: contract.OperationMutation
): ExtendedSessionHost {
  const mutate = async <T>(input: HostMutationInput<T>): Promise<OperationExecution<T>> => {
    const protocolPrecondition = (store: OperationalStore): void => {
      validatePreconditions(store, mutation);
      input.precondition?.(store);
    };
    if (input.effect !== undefined) {
      return host.mutate({ ...input, precondition: protocolPrecondition });
    }
    return host.mutate({
      ...input,
      commit: (store) => {
        protocolPrecondition(store);
        return input.commit(store);
      }
    });
  };
  return new Proxy(host, {
    get(target, property, receiver) {
      if (property === "mutate") return mutate;
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

function presented(execution: OperationExecution<OperationOutcome>): PresentedOperation {
  return { record: execution.operation, outcome: execution.value };
}

async function effectOperation(
  dependencies: ConnectServiceDependencies,
  operationId: string,
  connection: ConnectionRecord,
  mutation: contract.OperationMutation,
  kind: string,
  outcome: OperationOutcome,
  effect: () => Promise<void>
): Promise<PresentedOperation> {
  return presented(await dependencies.sessionHost.mutate({
    operationId,
    connection,
    kind,
    body: mutation,
    commit: () => outcome,
    effect: () => effect()
  }));
}

async function resourceEffectOperation(
  dependencies: ConnectServiceDependencies,
  operationId: string,
  connection: ConnectionRecord,
  mutation: contract.OperationMutation,
  kind: string,
  resourceId: string,
  effect: () => Promise<void>
): Promise<PresentedOperation> {
  return effectOperation(dependencies, operationId, connection, mutation, kind, {
    accepted: true,
    resultCase: "resource",
    entityId: resourceId
  }, async () => {
    await effect();
    await dependencies.refreshPiGeneration?.();
  });
}

async function ackOperation(
  dependencies: ConnectServiceDependencies,
  operationId: string,
  connection: ConnectionRecord,
  mutation: contract.OperationMutation,
  kind: string,
  effect?: () => Promise<void>
): Promise<PresentedOperation> {
  const execution = await dependencies.sessionHost.mutate({
    operationId,
    connection,
    kind,
    body: mutation,
    commit: () => ({ accepted: true, resultCase: "acknowledgement" } satisfies OperationOutcome),
    ...(effect === undefined ? {} : { effect: () => effect() })
  });
  return presented(execution);
}

async function unsupportedOperation(
  dependencies: ConnectServiceDependencies,
  operationId: string,
  connection: ConnectionRecord,
  mutation: contract.OperationMutation,
  kind: string,
  reason: string
): Promise<PresentedOperation> {
  const execution = await dependencies.sessionHost.mutate({
    operationId,
    connection,
    kind,
    body: mutation,
    commit: () => ({ accepted: false, resultCase: "acknowledgement", unsupportedReason: reason } satisfies OperationOutcome)
  });
  return presented(execution);
}

async function updateSessionOperation(
  dependencies: ConnectServiceDependencies,
  operationId: string,
  connection: ConnectionRecord,
  mutation: contract.OperationMutation,
  kind: string,
  sessionId: string,
  patch: Partial<Pick<import("@joko/core").SessionDescriptor, "title" | "pinned" | "archived" | "deletedAt" | "permissionMode" | "planMode" | "providerId" | "modelId" | "effort" | "fastMode" | "binding">>,
  effect?: () => Promise<void>
): Promise<PresentedOperation> {
  const execution = await dependencies.sessionHost.mutate({
    operationId,
    connection,
    kind,
    body: mutation,
    commit: (store) => {
      store.updateSession(sessionId, patch);
      return { accepted: true, resultCase: "session", entityId: sessionId } satisfies OperationOutcome;
    },
    ...(effect === undefined ? {} : { effect: () => effect() })
  });
  return presented(execution);
}

async function workspaceTrustOperation(
  dependencies: ConnectServiceDependencies,
  operationId: string,
  connection: ConnectionRecord,
  mutation: contract.OperationMutation,
  kind: string,
  workspaceId: string,
  trusted: boolean
): Promise<PresentedOperation> {
  const target = targetForWorkspace(dependencies.store, workspaceId);
  if (target === undefined) return unsupportedOperation(dependencies, operationId, connection, mutation, kind, "Workspace is not attached to a durable Target.");
  const execution = await dependencies.sessionHost.mutate({
    operationId,
    connection,
    kind,
    body: mutation,
    commit: (store) => {
      store.upsertTarget({ ...target.descriptor, trusted }, target.metadata);
      return { accepted: true, resultCase: "workspace", entityId: workspaceId } satisfies OperationOutcome;
    },
    effect: async () => {
      const registration = requireWorkspace(dependencies.workspaceService, workspaceId);
      await dependencies.workspaceService.register({ ...registration, trusted });
    }
  });
  return presented(execution);
}

async function workspaceEntryEffectOperation(
  dependencies: ConnectServiceDependencies,
  operationId: string,
  connection: ConnectionRecord,
  mutation: contract.OperationMutation,
  kind: string,
  workspaceId: string,
  effect: () => Promise<void>
): Promise<PresentedOperation> {
  const target = targetForWorkspace(dependencies.store, workspaceId);
  if (target === undefined) {
    return unsupportedOperation(
      dependencies,
      operationId,
      connection,
      mutation,
      kind,
      "Workspace is not attached to a durable Target."
    );
  }
  const backend = dependencies.store.getBackend(target.descriptor.backendId).descriptor;
  if (backend.capabilities.get("workspace.files.write")?.supported !== true) {
    return unsupportedOperation(
      dependencies,
      operationId,
      connection,
      mutation,
      kind,
      "Backend does not support workspace.files.write."
    );
  }
  // ackOperation delegates to SessionHost's deferred-effect path: the
  // Operation claim is durable before the first filesystem side effect.
  return ackOperation(dependencies, operationId, connection, mutation, kind, effect);
}

async function settingOperation(
  dependencies: ConnectServiceDependencies,
  operationId: string,
  connection: ConnectionRecord,
  mutation: contract.OperationMutation,
  kind: string,
  key: string,
  value: unknown,
  effect?: () => Promise<void>,
  resultCase: OperationOutcome["resultCase"] = "settings",
  entityId?: string
): Promise<PresentedOperation> {
  if (value === undefined) return unsupportedOperation(dependencies, operationId, connection, mutation, kind, "The typed settings payload is required.");
  const execution = await dependencies.sessionHost.mutate({
    operationId,
    connection,
    kind,
    body: mutation,
    commit: (store) => {
      store.setSetting("service", "orchestrator", key, value);
      return { accepted: true, resultCase, ...(entityId === undefined ? {} : { entityId }) } satisfies OperationOutcome;
    },
    ...(effect === undefined ? {} : { effect: () => effect() })
  });
  return presented(execution);
}

async function deleteSettingOperation(
  dependencies: ConnectServiceDependencies,
  operationId: string,
  connection: ConnectionRecord,
  mutation: contract.OperationMutation,
  kind: string,
  key: string
): Promise<PresentedOperation> {
  const execution = await dependencies.sessionHost.mutate({
    operationId,
    connection,
    kind,
    body: mutation,
    commit: (store) => {
      store.deleteSetting("service", "orchestrator", key);
      return { accepted: true, resultCase: "acknowledgement" } satisfies OperationOutcome;
    }
  });
  return presented(execution);
}

function scheduleInput(
  id: string,
  input: contract.ScheduleInput,
  at: number,
  existing?: ScheduleRecord
): import("@joko/store").UpsertScheduleInput {
  if (input.recurrence === undefined) throw invalidArgument("schedule.recurrence is required");
  const recurrence = input.recurrence.kind;
  let kind: import("@joko/store").ScheduleKind;
  let expression: string | undefined;
  let anchorAt: number | undefined;
  let nextRunAt: number | undefined;
  const timezone = input.timeZone || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(at));
  } catch {
    throw invalidArgument("schedule.time_zone must be a valid IANA timezone");
  }
  switch (recurrence.case) {
    case "oneShot":
      kind = "one_shot";
      nextRunAt = fromProtoTimestamp(recurrence.value.triggerAt, "schedule.recurrence.one_shot.trigger_at");
      break;
    case "cron":
      kind = "cron";
      expression = recurrence.value.expression;
      try {
        nextRunAt = nextOccurrence({ kind: "cron", expression, timezone }, at - 1);
      } catch {
        throw invalidArgument("schedule.recurrence.cron or schedule.time_zone is invalid");
      }
      break;
    case "interval":
      kind = "interval";
      expression = String(fromProtoDuration(recurrence.value.interval, "schedule.recurrence.interval.interval") ?? 0);
      {
        anchorAt = fromProtoTimestamp(recurrence.value.anchorAt, "schedule.recurrence.interval.anchor_at");
        if (anchorAt === undefined) throw invalidArgument("schedule.recurrence.interval.anchor_at is required");
        nextRunAt = nextOccurrence({ kind: "interval", everyMs: Number(expression), anchorAt }, at - 1);
      }
      break;
    case "manual":
    case undefined:
      kind = "manual";
      break;
  }
  if (input.enabled && kind !== "manual" && nextRunAt === undefined) {
    throw invalidArgument("Enabled Schedule recurrence must have a future occurrence");
  }
  const sessionMode = input.sessionMode === contract.ScheduleSessionMode.FRESH
    ? "fresh"
    : input.sessionMode === contract.ScheduleSessionMode.PERSISTENT
      ? "persistent"
      : input.sessionMode === contract.ScheduleSessionMode.BOUND || input.sessionId !== ""
        ? "bound"
        : "fresh";
  if (sessionMode === "fresh" && input.sessionId !== "") {
    throw invalidArgument("Fresh Schedules cannot retain a Session binding.");
  }
  if (sessionMode === "bound" && input.sessionId === "") {
    throw invalidArgument("Bound Schedules require a Session binding.");
  }
  const prompt = fromProtoInputContent(input.input, "prompt");
  const executionSnapshot = scheduleExecutionSnapshot(input.execution, existing?.executionSnapshot);
  const extension = scheduleExtensionSnapshot(executionSnapshot);
  const worktree = scheduleWorktreeConfiguration(executionSnapshot);
  assertPublicScheduleExecutionCompatibility(
    extension,
    worktree,
    { mode: sessionMode, sessionId: input.sessionId },
    prompt
  );
  return {
    id,
    backendId: input.backendId,
    targetId: input.targetId,
    sessionMode,
    ...(sessionMode === "fresh" || input.sessionId === "" ? {} : { sessionId: input.sessionId }),
    name: input.displayName || "Schedule",
    kind,
    ...(expression === undefined ? {} : { expression }),
    ...(anchorAt === undefined ? {} : { anchorAt }),
    timezone,
    enabled: input.enabled,
    prompt,
    executionSnapshot,
    overlapPolicy: coreScheduleOverlapPolicy(input.overlapPolicy),
    misfirePolicy: coreScheduleMisfirePolicy(input.misfirePolicy),
    ...(nextRunAt === undefined ? {} : { nextRunAt })
  };
}

function scheduleRecordInput(schedule: ScheduleRecord): contract.ScheduleInput {
  const projected = toProtoSchedule(schedule);
  return create(contract.ScheduleInputSchema, {
    displayName: projected.displayName,
    backendId: projected.backendId,
    targetId: projected.targetId,
    sessionId: "",
    sessionMode: projected.sessionMode === contract.ScheduleSessionMode.PERSISTENT
      ? contract.ScheduleSessionMode.PERSISTENT
      : contract.ScheduleSessionMode.FRESH,
    recurrence: projected.recurrence,
    timeZone: projected.timeZone,
    input: projected.input,
    execution: projected.execution,
    overlapPolicy: projected.overlapPolicy,
    misfirePolicy: projected.misfirePolicy,
    enabled: schedule.enabled
  });
}

function personalScheduleCopy(
  source: ScheduleRecord,
  id: string,
  now: number,
  name = source.name
): import("@joko/store").UpsertScheduleInput {
  return {
    id,
    backendId: source.backendId,
    targetId: source.targetId,
    sessionMode: source.sessionMode === "persistent" ? "persistent" : "fresh",
    name,
    kind: source.kind,
    ...(source.expression === undefined ? {} : { expression: source.expression }),
    ...(source.anchorAt === undefined ? {} : { anchorAt: source.anchorAt }),
    timezone: source.timezone,
    enabled: source.enabled,
    prompt: source.prompt,
    executionSnapshot: withoutScheduleProjectAutomationOrigin(source.executionSnapshot),
    overlapPolicy: source.overlapPolicy,
    misfirePolicy: source.misfirePolicy,
    ...(source.nextRunAt === undefined ? {} : { nextRunAt: source.nextRunAt }),
    now
  };
}

async function validateScheduleWorktreeEligibility(
  dependencies: ConnectServiceDependencies,
  schedule: Pick<ScheduleRecord, "targetId" | "sessionMode" | "sessionId" | "enabled" | "executionSnapshot">
): Promise<void> {
  let worktree: ReturnType<typeof scheduleWorktreeConfiguration>;
  try {
    worktree = scheduleWorktreeConfiguration(schedule.executionSnapshot);
  } catch {
    throw invalidArgument("schedule.execution isolated workspace configuration is invalid");
  }
  if (!worktree.useWorktree) return;
  if (schedule.sessionMode !== "fresh" || schedule.sessionId !== undefined) {
    throw invalidArgument("schedule.execution.use_worktree requires fresh Session mode");
  }
  const target = dependencies.store.getTarget(schedule.targetId).descriptor;
  if (target.managed) {
    throw invalidArgument("schedule.execution.use_worktree requires a user project Target");
  }
  const coordinator = dependencies.sessionWorktrees;
  if (coordinator === undefined) {
    if (schedule.enabled) throw invalidArgument("Enabled isolated workspace Schedules require Worktree support");
    return;
  }
  let probe: Awaited<ReturnType<SessionWorktreeCoordinator["probe"]>>;
  try {
    probe = await coordinator.probe(target);
  } catch {
    if (schedule.enabled) throw invalidArgument("Enabled isolated workspace Schedules require a successful Target probe");
    return;
  }
  if (probe.eligibility !== "eligible") {
    if (probe.eligibility === "unavailable" && !schedule.enabled) return;
    throw invalidArgument("The selected Target cannot safely create an isolated workspace");
  }
  if (worktree.refreshRemote && !probe.canRefreshRemote) {
    throw invalidArgument("The selected Target cannot refresh Worktree sources");
  }
  if (worktree.sourceRef === undefined) return;
  try {
    const sources = await coordinator.listSources(target);
    if (!sources.some((source) => source.ref === worktree.sourceRef)) {
      throw invalidArgument("schedule.execution.worktree_source_ref is unavailable for the selected Target");
    }
  } catch (error) {
    if (error instanceof ConnectError) throw error;
    if (schedule.enabled) throw invalidArgument("Enabled isolated workspace Schedules require a successful source probe");
  }
}

function nextStoredScheduleOccurrence(schedule: ScheduleRecord, after: number): number | undefined {
  let timing: ScheduleTiming;
  switch (schedule.kind) {
    case "manual": timing = { kind: "manual" }; break;
    case "one_shot": {
      if (schedule.nextRunAt === undefined) return undefined;
      timing = { kind: "once", at: schedule.nextRunAt };
      break;
    }
    case "interval": {
      const everyMs = Number(schedule.expression);
      if (!Number.isSafeInteger(everyMs) || everyMs < 1_000) throw invalidArgument("Stored Schedule interval is invalid");
      if (schedule.anchorAt === undefined) throw invalidArgument("Stored interval Schedule has no anchor");
      timing = { kind: "interval", everyMs, anchorAt: schedule.anchorAt };
      break;
    }
    case "cron": {
      if (schedule.expression === undefined) throw invalidArgument("Stored cron Schedule has no expression");
      timing = { kind: "cron", expression: schedule.expression, timezone: schedule.timezone };
      break;
    }
  }
  return nextOccurrence(timing, after);
}

function coreScheduleOverlapPolicy(value: contract.ScheduleOverlapPolicy): "queue" | "skip" {
  if (value === contract.ScheduleOverlapPolicy.QUEUE) return "queue";
  if (value === contract.ScheduleOverlapPolicy.SKIP) return "skip";
  throw invalidArgument("schedule.overlap_policy is required");
}

function coreScheduleMisfirePolicy(value: contract.ScheduleMisfirePolicy): "run_once" | "skip" {
  if (value === contract.ScheduleMisfirePolicy.RUN_ONCE) return "run_once";
  if (value === contract.ScheduleMisfirePolicy.SKIP) return "skip";
  throw invalidArgument("schedule.misfire_policy is required");
}

function scheduleExecutionSnapshot(
  input: contract.ScheduleExecutionSnapshot | undefined,
  existing?: unknown
): Readonly<Record<string, unknown>> {
  if (input === undefined) {
    if (existing === undefined) return withScheduleExtensionSnapshot({
      useWorktree: false,
      refreshWorktreeRemote: false
    }, defaultScheduleExtensionSnapshot());
    return withScheduleExtensionSnapshot(existing, scheduleExtensionSnapshot(existing));
  }
  const model = input.model?.model;
  if (model !== undefined && (model.providerId.trim() === "" || model.modelId.trim() === "")) {
    throw invalidArgument("schedule.execution.model requires both provider_id and model_id");
  }
  if (!input.useWorktree && (input.worktreeSourceRef !== undefined || input.refreshWorktreeRemote)) {
    throw invalidArgument("schedule.execution Worktree options require use_worktree");
  }
  if (input.worktreeSourceRef !== undefined && (
    input.worktreeSourceRef.trim() !== input.worktreeSourceRef || input.worktreeSourceRef.length === 0 ||
    input.worktreeSourceRef.length > 1_024 || /[\p{Cc}\u2028\u2029]/u.test(input.worktreeSourceRef)
  )) {
    throw invalidArgument("schedule.execution.worktree_source_ref is invalid");
  }
  const base = {
    ...(model === undefined ? {} : { providerId: model.providerId, modelId: model.modelId }),
    ...(input.model?.effortId === undefined || input.model.effortId === "" ? {} : { effort: input.model.effortId }),
    ...(input.model === undefined ? {} : { fastMode: input.model.fastMode }),
    permissionMode: corePermission(input.permissionMode),
    planMode: input.planMode,
    useWorktree: input.useWorktree,
    ...(input.worktreeSourceRef === undefined ? {} : { worktreeSourceRef: input.worktreeSourceRef }),
    refreshWorktreeRemote: input.refreshWorktreeRemote,
    extraDirectoryIds: [...input.extraDirectoryIds]
  };
  const executionMode = input.executionMode === contract.ScheduleExecutionMode.SCRIPT ? "script" : "agent";
  const scriptConfig = publicScheduleScriptConfiguration(input.script);
  if ((executionMode === "script") !== (scriptConfig !== undefined)) {
    throw invalidArgument("Script execution mode requires script configuration, and agent mode forbids it.");
  }
  const priorExtension = existing === undefined
    ? undefined
    : scheduleExtensionSnapshot(existing);
  const requestedPreRunHook = publicSchedulePreRunHook(input.preRunHook);
  const preRunHook = preservedPublicSchedulePreRunHook(priorExtension?.preRunHook, requestedPreRunHook);
  const expireAt = fromProtoTimestamp(input.expireAt, "schedule.execution.expire_at");
  const extension: ScheduleExtensionSnapshot = {
    format: 1,
    silentWhenIdle: input.silentWhenIdle,
    notify: { desktop: input.notify?.desktop ?? true },
    executionMode,
    ...(scriptConfig === undefined ? {} : { scriptConfig }),
    ...(expireAt === undefined ? {} : { expireAt }),
    ...(preRunHook === undefined ? {} : { preRunHook })
  };
  return withScheduleExtensionSnapshot(base, extension);
}

function publicScheduleScriptConfiguration(
  input: contract.ScheduleScriptExecution | undefined
): ScheduleScriptExecutionConfiguration | undefined {
  if (input === undefined) return undefined;
  const command = boundedPublicScheduleText(input.command, "schedule.execution.script.command", 32_768);
  if (redactSecrets(command) !== command) {
    throw invalidArgument("schedule.execution.script.command cannot contain credential material");
  }
  const capabilities = input.capabilities.map((capability) => {
    if (capability !== contract.ScheduleScriptCapability.SESSIONS_DISPATCH) {
      throw invalidArgument("schedule.execution.script.capabilities contains an unsupported capability");
    }
    return "sessions.dispatch" as const;
  });
  if (new Set(capabilities).size !== capabilities.length) {
    throw invalidArgument("schedule.execution.script.capabilities cannot contain duplicates");
  }
  const timeoutMs = fromProtoDuration(input.timeout, "schedule.execution.script.timeout");
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)) {
    throw invalidArgument("schedule.execution.script.timeout must be a positive safe duration");
  }
  return {
    command,
    capabilities,
    ...(timeoutMs === undefined ? {} : { timeoutMs })
  };
}

function publicSchedulePreRunHook(
  input: contract.SchedulePreRunHook | undefined
): SchedulePreRunHookConfiguration | undefined {
  if (input === undefined) return undefined;
  const command = boundedPublicScheduleText(input.command, "schedule.execution.pre_run_hook.command", 32_768);
  const filePath = boundedPublicScheduleText(input.filePath, "schedule.execution.pre_run_hook.file_path", 4_096);
  const timeoutMs = fromProtoDuration(input.timeout, "schedule.execution.pre_run_hook.timeout");
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)) {
    throw invalidArgument("schedule.execution.pre_run_hook.timeout must be a positive safe duration");
  }
  return {
    command,
    filePath,
    ...(timeoutMs === undefined ? {} : { timeoutMs })
  };
}

function preservedPublicSchedulePreRunHook(
  existing: SchedulePreRunHookConfiguration | undefined,
  requested: SchedulePreRunHookConfiguration | undefined
): SchedulePreRunHookConfiguration | undefined {
  if (existing === undefined) {
    if (requested !== undefined) {
      throw invalidArgument("schedule.execution.pre_run_hook must be installed through the managed Schedule hook workflow");
    }
    return undefined;
  }
  if (requested === undefined) return existing;
  if (
    requested.command !== existing.command ||
    requested.filePath !== existing.filePath ||
    requested.timeoutMs !== existing.timeoutMs
  ) {
    throw invalidArgument("schedule.execution.pre_run_hook cannot be changed through a generic Schedule update");
  }
  return existing;
}

function assertPublicScheduleExecutionCompatibility(
  extension: ScheduleExtensionSnapshot,
  worktree: ReturnType<typeof scheduleWorktreeConfiguration>,
  binding: { readonly mode: ScheduleRecord["sessionMode"]; readonly sessionId: string },
  prompt: PromptInput
): void {
  if (worktree.useWorktree && (
    extension.executionMode !== "agent" || binding.mode !== "fresh" || binding.sessionId !== ""
  )) {
    throw invalidArgument("schedule.execution.use_worktree requires agent execution with fresh Session mode");
  }
  if (extension.executionMode === "agent") {
    if (prompt.text.trim() === "") throw invalidArgument("Agent Schedules require a non-empty prompt.");
    return;
  }
  if (binding.mode !== "fresh" || binding.sessionId !== "") {
    throw invalidArgument("Script Schedules cannot bind or persist a product task.");
  }
  if (extension.silentWhenIdle) {
    throw invalidArgument("Script Schedules cannot use silent_when_idle.");
  }
}

function boundedPublicScheduleText(value: string, field: string, maximum: number): string {
  if (value.trim() === "" || value.length > maximum || value.includes("\0")) {
    throw invalidArgument(`${field} must be non-empty and at most ${maximum} characters`);
  }
  return value;
}

function corePermission(value: contract.PermissionMode): CorePermissionMode {
  if (value === contract.PermissionMode.AUTO) return "auto";
  if (value === contract.PermissionMode.BYPASS_PERMISSIONS) return "bypassPermissions";
  return "ask";
}

function requiredCorePermission(value: contract.PermissionMode, field: string): CorePermissionMode {
  if (
    value !== contract.PermissionMode.ASK
    && value !== contract.PermissionMode.AUTO
    && value !== contract.PermissionMode.BYPASS_PERMISSIONS
  ) throw invalidArgument(`${field} is required`);
  return corePermission(value);
}

function protoPortableSessionFidelity(
  value: "full" | "partial" | "product_only"
): contract.PortableSessionFidelity {
  if (value === "full") return contract.PortableSessionFidelity.FULL;
  if (value === "partial") return contract.PortableSessionFidelity.PARTIAL;
  return contract.PortableSessionFidelity.PRODUCT_ONLY;
}

function protoPortableSessionImportStatus(
  value: "ready" | "imported_activation_failed"
): contract.PortableSessionImportStatus {
  return value === "ready"
    ? contract.PortableSessionImportStatus.READY
    : contract.PortableSessionImportStatus.IMPORTED_ACTIVATION_FAILED;
}

function protoPortableSessionImportDraft(
  draft: import("./session-host.js").PortableSessionImportDraftResult
): contract.PortableSessionImportDraft {
  return create(contract.PortableSessionImportDraftSchema, {
    draftId: draft.draftId,
    expiresAt: toProtoTimestamp(draft.expiresAt),
    encrypted: draft.encrypted,
    passwordRequired: draft.passwordRequired,
    ...(draft.preview === undefined ? {} : {
      preview: create(contract.PortableSessionImportPreviewSchema, {
        title: draft.preview.title,
        workspaceKind: draft.preview.workspaceKind === "project"
          ? contract.WorkspaceKind.USER_PROJECT
          : contract.WorkspaceKind.MANAGED_DIALOGUE,
        exportedAt: toProtoTimestamp(Date.parse(draft.preview.exportedAt)),
        applicationVersion: draft.preview.applicationVersion,
        formatVersion: draft.preview.formatVersion,
        backendCapability: draft.preview.backendCapability,
        fidelity: protoPortableSessionFidelity(draft.preview.fidelity),
        messageCount: BigInt(draft.preview.messageCount),
        mediaCount: BigInt(draft.preview.mediaCount),
        workerCount: BigInt(draft.preview.workerCount),
        nativeHistory: draft.preview.nativeHistory
      })
    })
  });
}

function coreExtraDirectoryAccess(value: contract.ExtraDirectoryAccess): "read_only" | "read_write" {
  if (value === contract.ExtraDirectoryAccess.READ_ONLY) return "read_only";
  if (value === contract.ExtraDirectoryAccess.READ_WRITE) return "read_write";
  throw invalidArgument("extra_directory.access is required");
}

function nativePiQueueMode(value: contract.PiQueueMode): "all" | "one-at-a-time" {
  if (value === contract.PiQueueMode.ONE_AT_A_TIME) return "one-at-a-time";
  if (value === contract.PiQueueMode.ALL) return "all";
  throw invalidArgument("Pi queue mode is required");
}

function toProtoPiQueueMode(value: "all" | "one-at-a-time"): contract.PiQueueMode {
  return value === "all" ? contract.PiQueueMode.ALL : contract.PiQueueMode.ONE_AT_A_TIME;
}

function piProjectionDefaults(
  dependencies: ConnectServiceDependencies,
  backendId: string
): import("./application.js").PiSettingsProjectionDefaults {
  return dependencies.piSettingsDefaults?.[backendId] ?? NATIVE_PI_SETTINGS_DEFAULTS;
}

function protoPermission(value: string | undefined): contract.PermissionMode {
  if (value === "auto") return contract.PermissionMode.AUTO;
  if (value === "bypassPermissions") return contract.PermissionMode.BYPASS_PERMISSIONS;
  return contract.PermissionMode.ASK;
}

function deliveryMode(value: contract.QueueDeliveryMode): PromptInput["disposition"] {
  if (value === contract.QueueDeliveryMode.STEER) return "steer";
  if (value === contract.QueueDeliveryMode.FOLLOW_UP) return "follow_up";
  return "prompt";
}

function protoDeliveryMode(value: PromptInput["disposition"]): contract.QueueDeliveryMode {
  if (value === "steer") return contract.QueueDeliveryMode.STEER;
  if (value === "follow_up") return contract.QueueDeliveryMode.FOLLOW_UP;
  return contract.QueueDeliveryMode.PROMPT;
}

function coreInteractionDecision(value: unknown): InteractionDecision {
  if (typeof value === "boolean") return { kind: "confirmed", confirmed: value };
  if (typeof value === "string") return { kind: "selected", value };
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (record["cancelled"] === true) return { kind: "cancelled" };
    const planDecision = record["decision"];
    if (planDecision === "execute" || planDecision === "stay" || planDecision === "refine") {
      return {
        kind: "plan_review",
        decision: planDecision,
        feedback: typeof record["feedback"] === "string" ? record["feedback"] : ""
      };
    }
    const answers: Record<string, string | boolean | readonly string[]> = {};
    for (const [fieldId, answer] of Object.entries(record)) {
      if (typeof answer === "string" || typeof answer === "boolean" ||
        (Array.isArray(answer) && answer.every((entry) => typeof entry === "string"))) {
        answers[fieldId] = answer as string | boolean | readonly string[];
      } else {
        throw new ConnectError("Question response contains an invalid answer.", Code.InvalidArgument);
      }
    }
    return { kind: "question", answers };
  }
  return { kind: "selected", value: safeJson(value) };
}

function stableConnection(connection: ConnectionRecord): ConnectionRecord {
  return { ...connection, pairedAt: 0, lastSeenAt: undefined, revokedAt: undefined, revision: 0n };
}

function stableId(prefix: string, operationId: string): string {
  return `${prefix}-${createHash("sha256").update(operationId).digest("hex").slice(0, 24)}`;
}

function nestedOperationId(kind: string, operationId: string): string {
  return stableId("internal", `${kind}:${operationId}`);
}

function coreTurnOverrides(value: contract.PerTurnOverrides | undefined): TurnExecutionOverrides | undefined {
  if (value === undefined) return undefined;
  const model = value.model?.model;
  if (value.model !== undefined && (model === undefined || model.providerId.trim() === "" || model.modelId.trim() === "")) {
    throw invalidArgument("send_input.overrides.model requires both provider_id and model_id");
  }
  const overrides: TurnExecutionOverrides = {
    ...(model === undefined ? {} : { providerId: model.providerId, modelId: model.modelId }),
    ...(value.model?.effortId === undefined || value.model.effortId === "" ? {} : { effort: value.model.effortId }),
    ...(value.model === undefined ? {} : { fastMode: value.model.fastMode }),
    ...(value.permissionMode === undefined ? {} : { permissionMode: corePermission(value.permissionMode) }),
    ...(value.planMode === undefined ? {} : { planMode: value.planMode }),
    ...(value.extraDirectoryIds.length === 0 ? {} : { extraDirectoryIds: [...value.extraDirectoryIds] })
  };
  return Object.keys(overrides).length === 0 ? undefined : overrides;
}

/** Construct a protobuf-es v2 message without depending on protobuf's runtime from this package. */
function create<T extends { readonly $typeName: string }>(
  schema: { readonly typeName: T["$typeName"]; readonly $codegenv2: { readonly a: T } },
  fields: Omit<T, "$typeName" | "$unknown">
): T {
  return { $typeName: schema.typeName, ...fields } as T;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function bigintValue(value: unknown): bigint {
  if (typeof value === "bigint") return value < 0n ? 0n : value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^\d+$/u.test(value)) return BigInt(value);
  return 0n;
}

type StoredVisionSettingsForMutation = {
  readonly enabled?: boolean;
  readonly targetModels?: readonly ModelRouteRef[];
  readonly primary?: ModelRouteRef | null;
  readonly fallback?: ModelRouteRef | null;
};

function normalizeVisionTargets(
  values: readonly contract.ModelRouteRef[],
  catalog: readonly ModelRouteDescriptor[]
): readonly ModelRouteRef[] {
  if (values.length > 256) throw invalidArgument("Vision Bridge accepts at most 256 target models");
  const targets = new Map<string, ModelRouteRef>();
  for (const value of values) {
    const target = normalizeVisionReference("target_models", value);
    assertVisionCatalogModel(target, catalog, false);
    const key = modelRouteRefKey(target);
    if (targets.has(key)) throw invalidArgument("Vision Bridge target models must be unique");
    targets.set(key, target);
  }
  return [...targets.values()].sort((left, right) =>
    left.backendId.localeCompare(right.backendId, "en") ||
    left.providerId.localeCompare(right.providerId, "en") ||
    left.modelId.localeCompare(right.modelId, "en")
  );
}

function normalizeVisionSlot(
  field: "primary" | "fallback",
  value: contract.ModelRouteRef,
  catalog: readonly ModelRouteDescriptor[]
): ModelRouteRef | null {
  if (value.backendId.trim() === "" && value.providerId.trim() === "" && value.modelId.trim() === "") return null;
  const selection = normalizeVisionReference(field, value);
  assertVisionCatalogModel(selection, catalog, true);
  return selection;
}

function normalizeVisionReference(
  field: string,
  value: Pick<contract.ModelRouteRef, "backendId" | "providerId" | "modelId">
): ModelRouteRef {
  const backendId = value.backendId.trim();
  const providerId = value.providerId.trim();
  const modelId = value.modelId.trim();
  if (backendId === "" || backendId.length > 128 || /\s/u.test(backendId)) {
    throw invalidArgument(`Vision Bridge ${field}.backend_id is invalid`);
  }
  if (providerId === "" || providerId.length > 128 || /\s/u.test(providerId)) {
    throw invalidArgument(`Vision Bridge ${field}.provider_id is invalid`);
  }
  if (modelId === "" || modelId.length > 256 || /\s/u.test(modelId)) {
    throw invalidArgument(`Vision Bridge ${field}.model_id is invalid`);
  }
  return { backendId, providerId, modelId };
}

function assertVisionCatalogModel(
  selection: ModelRouteRef,
  catalog: readonly ModelRouteDescriptor[],
  requireImages: boolean
): void {
  const model = catalog.find((candidate) => modelRouteRefKey(candidate) === modelRouteRefKey(selection));
  if (model === undefined) throw new ConnectError("Vision Bridge Provider model not found.", Code.NotFound);
  if (requireImages && (!model.supportsImages || !model.credentialRoute)) {
    throw new ConnectError(
      "Vision Bridge analysis models must declare image input support and an Orchestrator credential route.",
      Code.FailedPrecondition
    );
  }
}

function modelRouteRefKey(reference: ModelRouteRef): string {
  return `${reference.backendId}\0${reference.providerId}\0${reference.modelId}`;
}

function numericEnum<T extends number>(value: unknown, fallback: T): T {
  return typeof value === "number" && Number.isInteger(value) ? value as T : fallback;
}

function safeJson(value: unknown): string {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? String(value) : encoded;
  } catch {
    return "[unserializable]";
  }
}

function safePreview(value: unknown, maximum = 240): string {
  const text = redactSecrets(typeof value === "string" ? value : safeJson(value));
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;
}

function optionalDate(value: unknown): ReturnType<typeof toProtoTimestamp> | undefined {
  if (value instanceof Date && Number.isFinite(value.getTime())) return toProtoTimestamp(value.getTime());
  if (typeof value === "number" && Number.isFinite(value)) return toProtoTimestamp(value);
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return toProtoTimestamp(parsed);
  }
  return undefined;
}

function safeByteCount(value: bigint, fallback: number): number;
function safeByteCount(value: bigint, fallback: undefined): number | undefined;
function safeByteCount(value: bigint, fallback: number | undefined): number | undefined {
  if (value === 0n) return fallback;
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw invalidArgument("byte count is outside the supported range");
  return Number(value);
}

function coreReviewRunState(value: contract.ReviewRunState): "running" | "completed" | "failed" {
  if (value === contract.ReviewRunState.RUNNING) return "running";
  if (value === contract.ReviewRunState.COMPLETED) return "completed";
  if (value === contract.ReviewRunState.FAILED) return "failed";
  throw invalidArgument("review_run.state is required");
}

function assertBlobRefIdentity(expected: BlobRef, actual: BlobRef, label: string): void {
  if (
    expected.id !== actual.id ||
    expected.sha256.toLowerCase() !== actual.sha256.toLowerCase() ||
    expected.byteLength !== actual.byteLength ||
    expected.mimeType !== actual.mimeType ||
    expected.fileName !== actual.fileName
  ) {
    throw new Error(`${label} reference does not match its durable Artifact.`);
  }
}

function isHiddenPath(path: string): boolean {
  return path.replace(/\\/gu, "/").split("/").some((part) => part.startsWith(".") && part !== "." && part !== "..");
}

async function requireExistingDirectory(path: string, field: string): Promise<string> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(path);
  } catch (error) {
    if (asRecord(error)["code"] === "ENOENT") throw new ConnectError(`${field} does not exist.`, Code.NotFound);
    throw error;
  }
  if (!info.isDirectory()) throw invalidArgument(`${field} must refer to a directory`);
  return realpath(path);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (asRecord(error)["code"] === "ENOENT") return false;
    throw error;
  }
}

function mediaTypeForPath(path: string): string {
  const extension = /(?:\.([^.\/]+))$/u.exec(path)?.[1]?.toLowerCase();
  switch (extension) {
    case "md": return "text/markdown";
    case "txt": return "text/plain";
    case "json": return "application/json";
    case "js": case "mjs": case "cjs": return "text/javascript";
    case "ts": case "tsx": return "text/typescript";
    case "html": return "text/html";
    case "css": return "text/css";
    case "yaml": case "yml": return "application/yaml";
    case "xml": return "application/xml";
    case "svg": return "image/svg+xml";
    case "glb": return "model/gltf-binary";
    case "gltf": return "model/gltf+json";
    case "ktx2": return "image/ktx2";
    case "png": return "image/png";
    case "jpg": case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    case "pdf": return "application/pdf";
    default: return "application/octet-stream";
  }
}

function languageForPath(path: string): string {
  const fileName = basename(path).toLowerCase();
  if (fileName === "makefile") return "makefile";
  if (fileName === "dockerfile") return "dockerfile";
  const extension = /(?:\.([^.\/]+))$/u.exec(path)?.[1]?.toLowerCase();
  switch (extension) {
    case "ts": return "typescript";
    case "tsx": return "tsx";
    case "js": case "mjs": case "cjs": return "javascript";
    case "jsx": return "jsx";
    case "json": case "jsonc": return "json";
    case "md": case "markdown": case "mdown": case "mkd": case "mdx": return "markdown";
    case "html": case "htm": return "html";
    case "vue": case "svelte": case "xml": case "svg": return "xml";
    case "css": case "scss": case "sass": case "less": return "css";
    case "yaml": case "yml": return "yaml";
    case "py": return "python";
    case "rb": return "ruby";
    case "rs": return "rust";
    case "go": return "go";
    case "java": return "java";
    case "cs": return "csharp";
    case "c": case "h": case "cpp": case "cc": case "cxx": case "hpp": return "cpp";
    case "kt": return "kotlin";
    case "swift": return "swift";
    case "scala": case "sc": return "scala";
    case "groovy": case "gradle": return "groovy";
    case "pl": case "pm": return "perl";
    case "r": return "r";
    case "hs": return "haskell";
    case "proto": return "protobuf";
    case "php": return "php";
    case "dart": return "dart";
    case "lua": return "lua";
    case "sh": case "bash": return "shell";
    case "zsh": return "shell";
    case "ps1": return "powershell";
    case "toml": return "toml";
    case "ini": return "ini";
    case "sql": return "sql";
    case "graphql": case "gql": return "graphql";
    case "diff": case "patch": return "diff";
    case "dockerfile": return "dockerfile";
    case "makefile": case "mk": return "makefile";
    default: return "";
  }
}
