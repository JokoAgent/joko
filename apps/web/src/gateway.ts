import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { createClient, ConnectError, Code, type Interceptor, type Transport } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import {
  ArtifactKind,
  ArtifactService,
  ArtifactStorageCleanupOutcome,
  AndroidAdbPathSource,
  AndroidAutomationIssue,
  AndroidAutomationRuntimeState,
  AuthenticationState,
  BackendService,
  BackendHealth,
  BackgroundTaskState,
  BlobDisposition,
  BrowserAutomationTarget,
  BrowserCommentDesignAction,
  BrowserCommentStringEntrySchema,
  BrowserCommentInspectionIntent,
  BrowserCommentTargetKind,
  BrowserCommentThemeVariant,
  BrowserBackendFailureReason,
  BrowserBackendStatus,
  BrowserActivityKind,
  BrowserPermissionAction,
  BrowserPageState,
  BrowserProviderState,
  BrowserService,
  BrowserTakeoverKey,
  BrowserTakeoverKeyModifier,
  BrowserTakeoverKeyPressSchema,
  BrowserTakeoverMouseButton,
  BrowserTakeoverMouseClickSchema,
  BrowserTakeoverMouseDragSchema,
  BrowserTakeoverMouseMoveSchema,
  BrowserTakeoverScrollSchema,
  BrowserTakeoverState,
  BrowserTakeoverTextInputSchema,
  BrowserTakeoverNavigateSchema,
  BrowserTakeoverNavigationCommandKind,
  BrowserTakeoverNavigationCommandSchema,
  BrowserTransferState,
  CapabilitySupport,
  capabilityNames,
  CodeHostPullRequestState,
  ComputerAutomationPermissionKind,
  ComputerAutomationRuntimeState,
  ComputerAutomationUpdatePhase,
  CompactSessionOutcome,
  CompactionState,
  ContextRebuildReason,
  CompositeArgumentKind,
  ConnectionService,
  CredentialKind,
  CredentialService,
  DeviceKind,
  DevicePresenceState,
  ConnectionState,
  DiagnosticLevel,
  EntityKind,
  ErrorSeverity,
  EventCursorSchema,
  ExtensionWidgetPlacement,
  ExtensionUiEffectKind,
  ExtensionNotificationKind as ProtoExtensionNotificationKind,
  EventService,
  ExtraDirectoryAccess,
  FileChangeKind,
  FilePermissionAction,
  DiffLineKind,
  GitDiffSource,
  GitFileStatus,
  HistoryMaintenanceService,
  WorkspaceDiffAction,
  WorkspaceDiffTarget,
  WorkspaceBranchBaseWarningCode,
  WorkspaceGitPushOutcome,
  WorkspaceEntryCreateKind,
  WorkspaceEntryListingPolicy,
  WorkspaceFileChangeKind,
  workspaceEntryAbsentRevision,
  InteractionKind,
  AutomationPermissionState,
  InteractionResolutionSchema,
  InteractionState,
  InstallationState,
  MessageInputDelivery as ProtoMessageInputDelivery,
  MemoryResetScope,
  ManagedModelRuntimeErrorCode,
  ManagedModelRuntimeResourceState,
  ManagedModelRuntimeService,
  ManagedModelRuntimeSource,
  ManagedModelRuntimeState,
  ManagedModelRuntimeTransferKind,
  ManagedModelRuntimeTransferPhase,
  ManagedProcessPriority,
  ModelInputModality,
  ModelOutputModality,
  ModelPriceCurrency,
  ModelPriceSource,
  NativeSessionCandidateState,
  NativeSessionPlacement,
  NativeEntryKind,
  nativeSessionTreeRoots,
  McpCredentialTarget,
  McpServerInputSchema,
  McpServerState,
  McpTransport,
  NativeSessionStartSchema,
  OperationService,
  OperationState,
  OperationMutationSchema,
  PermissionDecisionKind,
  PermissionMode as ProtoPermissionMode,
  PermissionRisk,
  PortableSessionFidelity,
  PortableSessionImportStatus,
  PortableSessionService,
  PiQueueMode,
  PolicySettingsSchema,
  ProviderConfigurationSchema,
  ProviderHeaderConfigurationSchema,
  ProviderApiCompatibility,
  ProviderCredentialSurfaceCapability,
  ProviderCredentialSurfaceKind,
  ProviderKind,
  ProviderModelConfigurationSchema,
  ProviderLoginFlowState,
  ProviderLoginMethod,
  ProviderLoginPromptKind,
  PlanStepState,
  PlanReviewDecisionKind,
  QuestionAnswerHandling,
  QuestionAnswerSchema,
  QueueDeliveryMode,
  QueueDispatchState,
  QueueEdge,
  QueueItemState,
  QueueSourceKind,
  ResourceAcquisitionSourceSchema,
  ResourceCompatibility,
  ResourceCompatibilityIssue,
  ResourceKind,
  ResourcePackageWarning,
  ResourcePermissionAction,
  ResourceRuntimeRequirementStatus,
  ResourceScope,
  ResourceState,
  ResourceUiApi,
  RecoveryActionKind,
  ReviewAttachmentKind,
  ReviewFreshnessState,
  ReviewFailureCode,
  ReviewRunState,
  ReviewTargetKind,
  RemoteHostAuthenticationMode,
  RemoteHostCapabilityKind,
  RemoteHostChangeKind,
  RemoteHostFailureCode,
  RemoteHostService,
  RemoteHostSource,
  RemoteHostStatus,
  RetryState,
  RuntimeRecoveryState,
  TaskHistoryMaintenancePhase,
  TaskHistoryMaintenanceStatus,
  TaskHistoryRetention,
  RewindSafety,
  RunState,
  ScheduleExecutionMode,
  ScheduleFireSource,
  ScheduleInputSchema,
  ScheduleMisfirePolicy,
  ScheduleOverlapPolicy,
  ScheduleRecurrenceSchema,
  ScheduleRunCostAttribution,
  ScheduleRunOutcome,
  ScheduleRunPhase,
  ScheduleGeneratedSessionDisposition,
  ScheduleScriptCapability,
  ScheduleSessionMode,
  ScheduleSource,
  ScheduleState,
  SchedulerService,
  ServerHealth,
  SessionMessageSearchKind,
  SessionMessageSearchRole,
  SessionMessageSearchSemanticMode,
  SessionMessageSearchSessionStatus,
  SessionService,
  SessionExportFormat,
  SessionAttentionKind,
  SessionAttentionAcknowledgementIntent,
  SessionDerivationKind,
  SessionState,
  SessionTitleSuggestionStatus,
  SessionWorktreeState,
  SubagentActivityKind,
  SubagentControlAction,
  SubagentParentContext,
  SubagentRunState,
  SubagentService,
  SubagentToolPhase,
  SubagentTranscriptRole,
  RuntimeToolSourceOrigin,
  RuntimeToolSourceScope,
  ToolFieldType,
  ToolCallOutputMode,
  ToolCallState,
  ToolService,
  ToolPolicyEffectiveSource,
  TransferDirection,
  VoiceInputFailureCode,
  VoiceInputConnectionTestFailure as ProtoVoiceInputConnectionTestFailure,
  VoiceInputDictionaryEntrySource,
  VoiceInputDictionaryLearningActionType,
  VoiceInputDictionaryLearningConfidence,
  VoiceInputDictionaryTermType,
  VoiceInputService,
  VoiceInputState,
  VoiceInputTerminalOutcome,
  VoiceInputTextSource,
  VoiceInputTranscriptionProtocol,
  WorktreeEligibility,
  WorktreeService,
  WorktreeSourceStrategy,
  WorkspaceService,
  WorkspaceKind,
  type Artifact,
  type BackgroundTask as ProtoBackgroundTask,
  type BackendDescriptor,
  type BrowserActivity,
  type BrowserCommentPlacement as ProtoBrowserCommentPlacement,
  type BrowserCommentTarget as ProtoBrowserCommentTarget,
  type BrowserTakeoverActionMutation,
  type BrowserPage,
  type BrowserProvider,
  type BrowserTransfer,
  type Connection,
  type ContextUsage as ProtoContextUsage,
  type CredentialDescriptor,
  type Device,
  type DeviceControlRelation,
  type DisplayArgument,
  type ErrorInfo,
  type Event,
  type ExtraDirectory,
  type ExtensionStatus,
  type ExtensionWidget,
  type FilePreview,
  type FileDiff,
  type Interaction,
  type PermissionSubject,
  type ManagedResource,
  type ManagedModelRuntime,
  type McpServerDescriptor,
  type MessageBlock as ProtoMessageBlock,
  type MessageCompletedEvent as ProtoMessageCompletedEvent,
  type ModelDescriptor,
  type NativeSessionTreeNestedNode,
  type ModelPriceOverrideView as ProtoModelPriceOverrideView,
  type ModelPriceQuote as ProtoModelPriceQuote,
  type NativeSessionCandidate,
  type NativeSessionCatalogEntry,
  type Operation,
  type ProviderDescriptor,
  type ProviderConfiguration,
  type ProviderLoginFlow,
  type QueueItem,
  type QueueControl,
  type QuestionAnswer,
  type QuestionChoice,
  type QuestionField,
  type Schedule,
  type SchedulerRuntimeSnapshot as ProtoSchedulerRuntimeSnapshot,
  type ScheduleRunHistory,
  type ReviewRun as ProtoReviewRun,
  type RemoteHost as ProtoRemoteHost,
  type SessionMessageSearchMatch,
  type Session,
  type SessionStatistics as ProtoSessionStatistics,
  type Snapshot,
  type Usage as ProtoUsage,
  type UsageCurrencyTotal as ProtoUsageCurrencyTotal,
  type UsageHistory as ProtoUsageHistory,
  type SubagentActivity as ProtoSubagentActivity,
  type SubagentChildRun as ProtoSubagentChildRun,
  type SubagentRun as ProtoSubagentRun,
  type SubagentRunDetail as ProtoSubagentRunDetail,
  type SubagentTranscriptEntry as ProtoSubagentTranscriptEntry,
  type SubagentUsage as ProtoSubagentUsage,
  type ToolCall,
  type ToolResult,
  type VoiceInputCapabilityProfile as ProtoVoiceInputCapabilityProfile,
  type VoiceInputSession as ProtoVoiceInputSession,
  type SettingsSnapshot,
  type RuntimeCommand,
  type RuntimeToolCatalog,
  type TaskHistoryCleanupResult,
  type TaskHistoryMaintenanceProgress,
  type WorkspaceDescriptor,
  type WorkspaceEntry,
  type WorkspaceFileChange,
  type WorkspaceSearchMatch,
  type WorkspaceDiff,
  type WorkspaceDiffImageSide,
  type WorkspaceChangeSet,
  type WorkspaceRewindPreview
} from "@joko/contracts";
import { presentJokoServiceTerminology } from "./user-facing-terminology.js";
import { projectTimelineGeneratedFiles } from "./generated-files.js";
import { emptySnapshot } from "./model.js";
import type {
  AppSnapshot,
  ArtifactStorageCleanupView,
  ArtifactStorageMaintenanceSupportView,
  ArtifactStorageMaintenanceView,
  ArtifactStorageReconcileView,
  ArtifactStorageScanView,
  ArtifactView,
  AttachmentDraft,
  BackgroundTaskHistoryView,
  TaskHistoryCleanupView,
  TaskHistoryCleanupProgressView,
  TaskHistoryMaintenanceSupportView,
  TaskHistoryRetentionView,
  TaskHistoryScanView,
  BackendView,
  BrowserActivityView,
  BrowserCommentDesignCommandView,
  BrowserCommentDesignBaselineView,
  BrowserCommentInspectionInputView,
  BrowserCommentInspectionResultView,
  BrowserCommentPlacementView,
  BrowserTakeoverActionView,
  BrowserSettingsView,
  BrowserSettingsPatchView,
  BrowserPageView,
  BrowserTransferView,
  BrowserView,
  ComposerDraft,
  ConnectionProfile,
  CredentialDraft,
  DeviceControlRelationView,
  DeviceView,
  DiscoveredOrchestratorView,
  ErrorView,
  ExtraDirectoryView,
  ExtensionStatusView,
  ExtensionWidgetView,
  InteractionView,
  InteractionResolutionDraft,
  ModelPriceOverrideView,
  ModelPriceQuoteView,
  ModelView,
  ManagedModelRuntimeView,
  OperationApi,
  PermissionArgumentView,
  PermissionMode,
  PermissionSubjectView,
  PortableSessionExecutionSelection,
  PortableSessionActivationResultView,
  PortableSessionExportOutcomeView,
  PortableSessionFidelityView,
  PortableSessionImportDraftView,
  PortableSessionImportResultView,
  ProviderDraft,
  BackendSettingsUpdate,
  ProviderRuntimeView,
  ProviderLoginFlowView,
  ProviderLoginMethodView,
  QueueItemView,
  QueueControlView,
  ReviewRunView,
  ResourceView,
  ResourceDraft,
  RuntimeCommandView,
  RuntimeProcessUsageSnapshotView,
  RuntimeProcessUsageView,
  RuntimeToolCatalogView,
  RuntimeToolFieldTypeView,
  RemoteConnectionView,
  RemoteHostCapabilitiesView,
  RemoteHostDraft,
  RemoteHostView,
  ScheduleView,
  ScheduleDraft,
  ScheduleHistoryPageView,
  ScheduleDeletionResultView,
  ScheduleGeneratedSessionDispositionView,
  SchedulerRuntimeView,
  SessionMessageSearchCollectionOptions,
  SessionMessageSearchFiltersView,
  SessionMessageSearchMatchView,
  SessionMessageSearchPageView,
  SessionMessageSearchResultView,
  SessionMessageSearchScopeView,
  SessionStatisticsView,
  SessionView,
  SessionWorktreeView,
  SubagentControlActionView,
  SubagentRunDetailView,
  SubagentRunPageView,
  SubagentRunStateView,
  SubagentRunView,
  SubagentTranscriptEntryView,
  SubagentTranscriptPageView,
  TimelineHistoryCursorView,
  TimelineHistoryPageView,
  TimelineItemView,
  TimelineMessageUsageView,
  UsageCurrencyTotalView,
  UsageHistorySummaryView,
  UsageHistoryView,
  UsageTokensView,
  WorkspaceEntryView,
  WorkspaceEntryDeleteDraft,
  WorkspaceEntryMoveDraft,
  WorkspaceEntryMutationDraft,
  WorkspaceEntryListingOptionsView,
  WorkspaceEntryPageView,
  WorkspaceFileChangeScopeView,
  WorkspaceFileChangeView,
  WorkspaceFileIndexView,
  WorkspaceFilePreviewView,
  WorkspaceSearchMatchView,
  WorkspaceSearchErrorCode,
  WorkspaceSearchPageView,
  WorkspaceSearchRequestView,
  WorkspaceSearchStreamEventView,
  WorkspaceDiffView,
  WorkspaceDiffQuery,
  WorkspaceDiffHunkMutationDraft,
  WorkspaceDiffImageView,
  WorkspaceFileDiffView,
  WorkspaceGitCommitDraft,
  WorkspaceGitPushDraft,
  WorkspaceGitPushResultView,
  WorkspaceChangeSetView,
  WorkspaceRewindPreviewView,
  WorkspaceTextFileWriteDraft,
  WorkspaceTextFileWriteResultView,
  VoiceInputCapabilitySupportView,
  VoiceInputCapabilityView,
  VoiceInputFailureCodeView,
  VoiceInputOutcomeView,
  VoiceInputSessionView,
  VoiceInputStateView,
  VoiceInputTextSourceView,
  McpServerDraft,
  NativeSessionCandidateView,
  NativeSessionCatalogEntryView,
  NativeSessionCatalogView,
  NewSessionDraft,
  McpServerView,
  NativeSessionTreeNodeView,
  NativeSessionTreeView,
  SettingsView,
  VoiceInputConnectionTestResultView,
  VoiceInputDictionaryAdviceDraft,
  VoiceInputDictionaryAdviceView,
  VoiceInputDictionaryLearningActionView,
  VoiceInputRefinementContextView,
  VoiceInputServiceSettingsDraft,
  VoiceInputTranscriptionProtocolView,
  TargetDraft,
  TargetWorktreeProbeView,
  WorktreeSourceView,
  WorkspaceView
} from "./model.js";
import { activeComposerMentions, messageMentionWireText } from "./message-reference.js";
import { normalizeComposerDocument, serializeComposerDocument } from "./composer-quote-document.js";
import { formatBrowserCommentsForSend, normalizeBrowserCommentTarget } from "./browser-comment-draft.js";
import { normalizeResourceDraft } from "./resource-draft.js";
import { isInsecureLanOrigin, isLoopbackHostname, normalizeOrchestratorOrigin } from "./connection-origin.js";
import { scheduleEpochFromLocalDateTime } from "./schedule-time.js";
import { randomUuid, sha256Hex } from "./web-crypto.js";
import { compareExtensionStateOrder } from "./extension-ui-presentation.js";
import { projectSessionRuntimeRecovery } from "./runtime-recovery.js";

export type GatewayConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting" | "offline";

export interface GatewayCallbacks {
  readonly onState?: (state: GatewayConnectionState, statusMessage?: string) => void;
  readonly onSnapshot?: (snapshot: AppSnapshot) => void;
  readonly onError?: (error: GatewayError) => void;
  /** Called once when Orchestrator rejects the saved bearer credential. */
  readonly onAuthenticationInvalidated?: (error: GatewayError) => void | Promise<void>;
  /** Fire-and-forget Backend extension UI effects for the currently connected client. */
  readonly onExtensionUiEffect?: (effect: ExtensionUiEffect) => void;
  /** Content-free, renderer-local Vision Bridge feedback. */
  readonly onVisionBridgeUiEffect?: (effect: VisionBridgeUiEffect) => void;
}

export interface OrchestratorIdentity {
  readonly serverId: string;
  readonly displayName: string;
  readonly version: string;
  readonly apiVersion: string;
  readonly pairingEnabled: boolean;
}

export type ExtensionNotificationKind = "unknown" | "info" | "warning" | "error";

interface ExtensionUiEffectBase {
  readonly eventId: string;
  readonly sessionId: string;
  readonly text: string;
}

export type ExtensionUiEffect =
  | (ExtensionUiEffectBase & {
    readonly kind: "notification";
    readonly notificationKind: ExtensionNotificationKind;
  })
  | (ExtensionUiEffectBase & { readonly kind: "title" | "editorText" });

export class GatewayError extends Error {
  readonly offline: boolean;
  readonly code?: string;

  constructor(message: string, options: { readonly offline?: boolean; readonly cause?: unknown; readonly code?: string } = {}) {
    super(presentJokoServiceTerminology(message), { cause: options.cause });
    this.name = "GatewayError";
    this.offline = options.offline ?? false;
    this.code = options.code;
  }
}

export interface PairingOutcome {
  readonly profile: ConnectionProfile;
  readonly authKey: string;
}

export interface OrchestratorGateway extends OperationApi {
  connect(): Promise<void>;
  disconnect(): void;
  pair(origin: string, humanCode: string, deviceName: string): Promise<PairingOutcome>;
  /** Authoritative owner-runtime shutdown fence, sampled only on demand. */
  probeRuntimeActivity(): Promise<boolean>;
}

export interface VisionBridgeUiEffect {
  readonly eventId: string;
  readonly sessionId: string;
  readonly kind: "recognizing" | "fallback" | "unavailable" | "clear";
  readonly imageCount?: number;
}

type MutationPayload = NonNullable<MessageInitShape<typeof OperationMutationSchema>["payload"]>;
type MutationPrecondition = NonNullable<MessageInitShape<typeof OperationMutationSchema>["preconditions"]>[number];

export type GatewayTransportFactory = (origin: string, authKey?: string) => Transport;

const APP_VERSION = "0.1.0";
const OPERATION_TERMINAL_WAIT_TIMEOUT_MS = 600_000;
const MAX_COMPLETE_MESSAGE_SEARCH_PAGES = 10_000;
const MAX_PORTABLE_SESSION_PACKAGE_BYTES = 256 * 1024 * 1024;
const PAIRING_WINDOW_CLOSED_MESSAGE = "Pairing is not currently enabled by the owner.";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const OWNER_SCOPE = { kind: { case: "owner" as const, value: {} } };
const TERMINAL_OPERATION_STATES = new Set([
  OperationState.SUCCEEDED,
  OperationState.FAILED,
  OperationState.CANCELLED,
  OperationState.CONFLICT
]);

interface ArtifactUrlLease {
  refs: number;
  pending?: Promise<string>;
  url?: string;
}

class ConnectOrchestratorGateway implements OrchestratorGateway {
  readonly #profile: ConnectionProfile | undefined;
  readonly #authKey: string | undefined;
  readonly #callbacks: GatewayCallbacks;
  readonly #transportFactory: GatewayTransportFactory;
  #transport: Transport | undefined;
  #abort: AbortController | undefined;
  #snapshot: AppSnapshot | undefined;
  #rawSnapshot: Snapshot | undefined;
  #streamTask: Promise<void> | undefined;
  #refreshPromise: Promise<void> | undefined;
  #eventRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  #eventRefreshQueued = false;
  readonly #artifactUrls = new Map<string, ArtifactUrlLease>();

  constructor(
    profile: ConnectionProfile | undefined,
    authKey: string | undefined,
    callbacks: GatewayCallbacks,
    transportFactory: GatewayTransportFactory
  ) {
    this.#profile = profile;
    this.#authKey = authKey;
    this.#callbacks = callbacks;
    this.#transportFactory = transportFactory;
  }

  async pair(origin: string, humanCode: string, deviceName: string): Promise<PairingOutcome> {
    // Identity discovery must never carry a saved bearer. Only after the
    // anonymous response matches the profile's durable node identity may a
    // credentialed transport be created for same-device pairing.
    const anonymousClient = createClient(ConnectionService, this.#transportFactory(origin));
    const identity = mapServerIdentity((await anonymousClient.getServerInfo({})).server);
    const reusableDeviceId = reusablePairingDeviceId(this.#profile, this.#authKey, origin, identity.serverId);
    const client = reusableDeviceId === undefined
      ? anonymousClient
      : createClient(ConnectionService, this.#transportFactory(origin, this.#authKey));
    let challengeId = "";
    try {
      const challengeResponse = await client.beginPairing({
        deviceDisplayName: deviceName,
        deviceKind: desktopAvailable() ? DeviceKind.DESKTOP : DeviceKind.WEB,
        platform: navigator.platform || "web",
        appVersion: APP_VERSION
      });
      const challenge = challengeResponse.challenge;
      if (challenge === undefined) throw new GatewayError("The Joko node did not return a pairing challenge.");
      challengeId = challenge.challengeId;
    } catch (error) {
      // A trusted local owner may have already issued the code with
      // `orchestrator --issue-pairing`. In that case the anonymous pairing window is
      // intentionally closed, and CompletePairing resolves the durable
      // challenge by its secret code without exposing its challenge ID.
      if (!isPairingWindowClosedError(error)) throw error;
    }
    const response = await client.completePairing({
      challengeId,
      humanCode: humanCode.trim(),
      deviceDisplayName: deviceName,
      deviceKind: desktopAvailable() ? DeviceKind.DESKTOP : DeviceKind.WEB,
      platform: navigator.platform || "web",
      appVersion: APP_VERSION,
      ...(reusableDeviceId === undefined ? {} : { deviceId: reusableDeviceId })
    });
    const result = response.result;
    const resultDeviceId = result?.device?.deviceId ?? "";
    if (
      result?.connection === undefined
      || result.authKey.length === 0
      || resultDeviceId.length === 0
      || result.connection.deviceId !== resultDeviceId
    ) {
      throw new GatewayError("Pairing completed without a connection credential.");
    }
    return {
      profile: {
        id: result.connection.connectionId,
        deviceId: resultDeviceId,
        serverId: identity.serverId,
        name: result.connection.displayName || new URL(origin).hostname,
        origin,
        lastConnectedAt: Date.now()
      },
      authKey: result.authKey
    };
  }

  async connect(): Promise<void> {
    if (this.#profile === undefined || this.#authKey === undefined) {
      throw new GatewayError("A connection profile and credential are required.");
    }
    this.disconnect();
    this.#callbacks.onState?.("connecting", "Connecting to Joko…");
    this.#transport = this.#transportFactory(this.#profile.origin, this.#authKey);
    this.#abort = new AbortController();
    try {
      await this.refresh();
      this.#callbacks.onState?.("connected");
      this.#streamTask = this.consumeEvents(this.#abort.signal);
    } catch (error) {
      const gatewayError = normalizeError(error);
      if (isUnauthenticatedError(error)) await this.terminateAuthentication(gatewayError);
      else this.#callbacks.onError?.(gatewayError);
      throw gatewayError;
    }
  }

  disconnect(): void {
    this.#abort?.abort();
    this.#abort = undefined;
    if (this.#eventRefreshTimer !== undefined) {
      clearTimeout(this.#eventRefreshTimer);
      this.#eventRefreshTimer = undefined;
    }
    this.#eventRefreshQueued = false;
    this.#transport = undefined;
    this.#streamTask = undefined;
    for (const lease of this.#artifactUrls.values()) if (lease.url !== undefined) URL.revokeObjectURL(lease.url);
    this.#artifactUrls.clear();
    this.#callbacks.onState?.("disconnected");
  }

  async refresh(): Promise<void> {
    if (this.#refreshPromise !== undefined) return this.#refreshPromise;
    const refreshPromise = this.loadSnapshot();
    this.#refreshPromise = refreshPromise;
    try {
      await refreshPromise;
    } finally {
      if (this.#refreshPromise === refreshPromise) this.#refreshPromise = undefined;
      this.armEventRefresh();
    }
  }

  async refreshProviderAccountUsage(backendId: string, providerId: string): Promise<void> {
    const normalizedBackendId = backendId.trim();
    const normalizedProviderId = providerId.trim();
    if (normalizedBackendId.length === 0 || normalizedBackendId.length > 256 || /[\u0000-\u001f\u007f]/u.test(normalizedBackendId)) {
      throw new GatewayError("Backend ID is invalid.");
    }
    if (normalizedProviderId.length === 0 || normalizedProviderId.length > 256 || /[\u0000-\u001f\u007f]/u.test(normalizedProviderId)) {
      throw new GatewayError("Provider ID is invalid.");
    }
    const client = createClient(BackendService, this.requireTransport());
    await client.getProviderUsage(
      { backendId: normalizedBackendId, providerId: normalizedProviderId },
      this.#abort === undefined ? undefined : { signal: this.#abort.signal }
    );
    await this.refresh();
  }

  async getArtifactStorageStats(protectedSha256: readonly string[] = []): Promise<ArtifactStorageMaintenanceView> {
    const client = createClient(ArtifactService, this.requireTransport());
    const response = await client.getArtifactStorageStats({ protectedSha256: artifactProtectedSha256(protectedSha256) });
    const support = artifactStorageSupport(response.support);
    const stats = response.stats;
    return {
      support,
      ...(response.supportReason.trim() === "" ? {} : { reason: response.supportReason.trim().slice(0, 512) }),
      ...(stats === undefined ? {} : { stats: {
        referenceCount: artifactStorageCount(stats.referenceCount),
        uniqueBlobCount: artifactStorageCount(stats.uniqueBlobCount),
        totalBytes: artifactStorageCount(stats.totalBytes),
        cacheReferenceCount: artifactStorageCount(stats.cacheReferenceCount),
        cacheBytes: artifactStorageCount(stats.cacheBytes),
        temporaryFileCount: artifactStorageCount(stats.temporaryFileCount),
        temporaryBytes: artifactStorageCount(stats.temporaryBytes)
      } })
    };
  }

  async scanArtifactStorage(protectedSha256: readonly string[] = []): Promise<ArtifactStorageScanView> {
    const client = createClient(ArtifactService, this.requireTransport());
    const response = await client.scanArtifactStorage({ protectedSha256: artifactProtectedSha256(protectedSha256) });
    const scan = response.scan;
    if (scan === undefined || !/^[a-f0-9]{64}$/u.test(scan.token)) throw new GatewayError("Orchestrator returned an invalid Artifact storage scan.");
    const expiresAt = timestampMs(scan.expiresAt);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) throw new GatewayError("Orchestrator returned an expired Artifact storage scan.");
    return {
      token: scan.token,
      expiresAt,
      protectedReferenceCount: artifactStorageCount(scan.protectedReferenceCount),
      expiredReferenceCount: artifactStorageCount(scan.expiredReferenceCount),
      orphanBlobCount: artifactStorageCount(scan.orphanBlobCount),
      orphanBlobBytes: artifactStorageCount(scan.orphanBlobBytes),
      temporaryFileCount: artifactStorageCount(scan.temporaryFileCount),
      temporaryBytes: artifactStorageCount(scan.temporaryBytes),
      missingBlobCount: artifactStorageCount(scan.missingBlobCount),
      unsafeEntryCount: artifactStorageCount(scan.unsafeEntryCount),
      cleanableBytes: artifactStorageCount(scan.cleanableBytes)
    };
  }

  async reconcileArtifactStorage(protectedSha256: readonly string[] = []): Promise<ArtifactStorageReconcileView> {
    const client = createClient(ArtifactService, this.requireTransport());
    const response = await client.reconcileArtifactStorage({ protectedSha256: artifactProtectedSha256(protectedSha256) });
    const result = response.result;
    if (result === undefined) throw new GatewayError("Orchestrator returned no Artifact storage reconciliation report.");
    return {
      healthy: result.healthy,
      missingBlobCount: artifactStorageCount(result.missingBlobCount),
      orphanBlobCount: artifactStorageCount(result.orphanBlobCount),
      unsafeEntryCount: artifactStorageCount(result.unsafeEntryCount)
    };
  }

  async cleanupArtifactStorage(
    scanToken: string,
    protectedSha256: readonly string[] = []
  ): Promise<ArtifactStorageCleanupView> {
    if (!/^[a-f0-9]{64}$/u.test(scanToken)) throw new GatewayError("Artifact storage scan token is invalid.");
    const client = createClient(ArtifactService, this.requireTransport());
    const response = await client.cleanupArtifactStorage({
      scanToken,
      protectedSha256: artifactProtectedSha256(protectedSha256)
    });
    if (response.outcome === ArtifactStorageCleanupOutcome.SCAN_EXPIRED) return { outcome: "scanExpired" };
    if (response.outcome === ArtifactStorageCleanupOutcome.STORAGE_CHANGED) return { outcome: "storageChanged" };
    if (response.outcome !== ArtifactStorageCleanupOutcome.COMPLETED || response.result === undefined) {
      throw new GatewayError("Orchestrator returned an invalid Artifact storage cleanup result.");
    }
    return {
      outcome: "completed",
      expiredReferencesDeleted: artifactStorageCount(response.result.expiredReferencesDeleted),
      blobsRemoved: artifactStorageCount(response.result.blobsRemoved),
      temporaryFilesRemoved: artifactStorageCount(response.result.temporaryFilesRemoved),
      freedBytes: artifactStorageCount(response.result.freedBytes),
      skipped: artifactStorageCount(response.result.skipped)
    };
  }

  async getTaskHistoryMaintenanceSupport(): Promise<TaskHistoryMaintenanceSupportView> {
    const client = createClient(HistoryMaintenanceService, this.requireTransport());
    const response = await client.getHistoryMaintenanceSupport({});
    return {
      supported: response.support === CapabilitySupport.SUPPORTED,
      ...(response.supportReason.trim() === "" ? {} : { reason: response.supportReason.trim().slice(0, 512) })
    };
  }

  async scanTaskHistory(
    retention: TaskHistoryRetentionView,
    includeActiveTasks: boolean
  ): Promise<TaskHistoryScanView> {
    const client = createClient(HistoryMaintenanceService, this.requireTransport());
    const response = await client.scanTaskHistory({
      retention: protoTaskHistoryRetention(retention),
      includeActiveTasks
    });
    const scan = response.scan;
    if (scan === undefined || !UUID_PATTERN.test(scan.scanId)) {
      throw new GatewayError("Orchestrator returned an invalid task history scan.");
    }
    const scannedAt = timestampMs(scan.scannedAt);
    const olderThan = timestampMs(scan.olderThan);
    const expiresAt = timestampMs(scan.expiresAt);
    if (expiresAt <= Date.now() || olderThan > scannedAt) {
      throw new GatewayError("Orchestrator returned an expired task history scan.");
    }
    return {
      scanId: scan.scanId,
      retention: taskHistoryRetention(scan.retention),
      includeActiveTasks: scan.includeActiveTasks,
      scannedAt,
      olderThan,
      expiresAt,
      activeTaskCount: artifactStorageCount(scan.activeTaskCount),
      deletedTaskCount: artifactStorageCount(scan.deletedTaskCount),
      archivedTaskCount: artifactStorageCount(scan.archivedTaskCount),
      messageCount: artifactStorageCount(scan.messageCount),
      estimatedHistoryBytes: artifactStorageCount(scan.estimatedHistoryBytes),
      databaseBytes: artifactStorageCount(scan.databaseBytes),
      temporaryBytesRequired: artifactStorageCount(scan.temporaryBytesRequired),
      ...(scan.databaseVolumeFreeBytes === undefined
        ? {}
        : { databaseVolumeFreeBytes: artifactStorageCount(scan.databaseVolumeFreeBytes) })
    };
  }

  async beginTaskHistoryCleanup(scanId: string, backupEnabled: boolean): Promise<TaskHistoryCleanupProgressView> {
    if (!UUID_PATTERN.test(scanId)) throw new GatewayError("Task history scan ID is invalid.");
    const client = createClient(HistoryMaintenanceService, this.requireTransport());
    const response = await client.beginTaskHistoryCleanup({ scanId, backupEnabled });
    if (response.progress === undefined) throw new GatewayError("Orchestrator returned no task history cleanup progress.");
    return taskHistoryCleanupProgress(response.progress);
  }

  async getTaskHistoryCleanup(maintenanceId: string): Promise<TaskHistoryCleanupProgressView> {
    if (!UUID_PATTERN.test(maintenanceId)) throw new GatewayError("Task history maintenance ID is invalid.");
    const client = createClient(HistoryMaintenanceService, this.requireTransport());
    const response = await client.getTaskHistoryCleanup({ maintenanceId });
    if (response.progress === undefined) throw new GatewayError("Orchestrator returned no task history cleanup progress.");
    const progress = taskHistoryCleanupProgress(response.progress);
    if (progress.status === "completed") await this.refresh();
    return progress;
  }

  async cancelTaskHistoryCleanup(maintenanceId: string): Promise<TaskHistoryCleanupProgressView> {
    if (!UUID_PATTERN.test(maintenanceId)) throw new GatewayError("Task history maintenance ID is invalid.");
    const client = createClient(HistoryMaintenanceService, this.requireTransport());
    const response = await client.cancelTaskHistoryCleanup({ maintenanceId });
    if (response.progress === undefined) throw new GatewayError("Orchestrator returned no task history cleanup progress.");
    return taskHistoryCleanupProgress(response.progress);
  }

  async getVoiceInputCapabilities(signal?: AbortSignal): Promise<VoiceInputCapabilityView> {
    const client = createClient(VoiceInputService, this.requireTransport());
    const response = await client.getVoiceInputCapabilities({}, voiceRpcOptions(this.#abort?.signal, signal));
    if (response.profile === undefined) throw new GatewayError("Orchestrator returned no voice input capability profile.");
    return mapVoiceInputCapability(response.profile);
  }

  async testVoiceInputConnection(signal?: AbortSignal): Promise<VoiceInputConnectionTestResultView> {
    const client = createClient(VoiceInputService, this.requireTransport());
    const response = await client.testVoiceInputConnection({}, voiceRpcOptions(this.#abort?.signal, signal));
    if (response.ok) {
      if (response.failure !== ProtoVoiceInputConnectionTestFailure.UNSPECIFIED) {
        throw new GatewayError("Orchestrator returned an inconsistent voice input connection test result.");
      }
      return { ok: true };
    }
    return { ok: false, reason: voiceInputConnectionTestFailure(response.failure) };
  }

  async adviseVoiceInputDictionaryEdit(
    draft: VoiceInputDictionaryAdviceDraft,
    signal?: AbortSignal
  ): Promise<VoiceInputDictionaryAdviceView> {
    const client = createClient(VoiceInputService, this.requireTransport());
    const response = await client.adviseVoiceInputDictionaryEdit({
      beforeText: draft.beforeText,
      afterText: draft.afterText,
      ...(draft.rawTranscriptText === undefined ? {} : { rawTranscriptText: draft.rawTranscriptText }),
      ...(draft.locale === undefined ? {} : { locale: draft.locale }),
      existingEntries: draft.existingEntries.map((entry) => ({
        term: entry.term,
        source: entry.source === "automatic"
          ? VoiceInputDictionaryEntrySource.AUTOMATIC
          : VoiceInputDictionaryEntrySource.MANUAL,
        frequency: entry.frequency,
        aliases: entry.aliases.map((alias) => ({ text: alias.text, count: alias.count }))
      })),
      existingCandidates: draft.existingCandidates.map((candidate) => ({
        term: candidate.term,
        evidenceCount: candidate.evidenceCount,
        aliases: candidate.aliases.map((alias) => ({ text: alias.text, count: alias.count }))
      }))
    }, voiceRpcOptions(this.#abort?.signal, signal));
    return Object.freeze({ actions: Object.freeze(response.actions.map(mapVoiceInputDictionaryAction)) });
  }

  async startVoiceInput(
    requestId: string,
    mimeType: string,
    locale?: string,
    refinement?: VoiceInputRefinementContextView,
    signal?: AbortSignal
  ): Promise<VoiceInputSessionView> {
    const client = createClient(VoiceInputService, this.requireTransport());
    const response = await client.startVoiceInput({
      requestId,
      mimeType,
      ...(locale === undefined ? {} : { locale }),
      ...(refinement?.instructions === undefined ? {} : { refinementInstructions: refinement.instructions }),
      dictionaryTerms: [...(refinement?.dictionaryTerms ?? [])]
    }, voiceRpcOptions(this.#abort?.signal, signal));
    return requireVoiceInputSession(response.session);
  }

  async appendVoiceAudio(
    voiceInputId: string,
    chunkSequence: bigint,
    audio: Uint8Array,
    durationMs: number,
    voiced: boolean,
    signal?: AbortSignal
  ): Promise<VoiceInputSessionView> {
    const client = createClient(VoiceInputService, this.requireTransport());
    const response = await client.appendVoiceAudio({
      voiceInputId,
      chunkSequence,
      audio: Uint8Array.from(audio),
      durationMs,
      voiced
    }, voiceRpcOptions(this.#abort?.signal, signal));
    return requireVoiceInputSession(response.session);
  }

  async stopVoiceInput(
    voiceInputId: string,
    expectedNextChunkSequence: bigint,
    signal?: AbortSignal
  ): Promise<VoiceInputSessionView> {
    const client = createClient(VoiceInputService, this.requireTransport());
    const response = await client.stopVoiceInput({ voiceInputId, expectedNextChunkSequence }, voiceRpcOptions(this.#abort?.signal, signal));
    return requireVoiceInputSession(response.session);
  }

  async cancelVoiceInput(voiceInputId: string, signal?: AbortSignal): Promise<VoiceInputSessionView> {
    const client = createClient(VoiceInputService, this.requireTransport());
    const response = await client.cancelVoiceInput({ voiceInputId }, voiceRpcOptions(this.#abort?.signal, signal));
    return requireVoiceInputSession(response.session);
  }

  async getVoiceInputSession(voiceInputId: string, signal?: AbortSignal): Promise<VoiceInputSessionView> {
    const client = createClient(VoiceInputService, this.requireTransport());
    const response = await client.getVoiceInputSession({ voiceInputId }, voiceRpcOptions(this.#abort?.signal, signal));
    return requireVoiceInputSession(response.session);
  }

  async probeRuntimeActivity(): Promise<boolean> {
    return probeRuntimeActivityWithTransport(this.requireTransport(), this.#abort?.signal);
  }

  private async loadSnapshot(): Promise<void> {
    const transport = this.requireTransport();
    const signal = this.#abort?.signal;
    const eventClient = createClient(EventService, transport);
    const [response, managedModelRuntimes] = await Promise.all([
      eventClient.getSnapshot({ scope: OWNER_SCOPE }, signal === undefined ? undefined : { signal }),
      loadManagedModelRuntimes(transport, signal)
    ]);
    if (response.snapshot === undefined) throw new GatewayError("Orchestrator returned an empty snapshot.");
    const raw = response.snapshot;
    const entryMap = await loadWorkspaceEntries(transport, raw.workspaces, signal);
    if (signal?.aborted === true || this.#transport !== transport) return;
    const currentCursor = this.#rawSnapshot?.resumeCursor;
    const fetchedCursor = raw.resumeCursor;
    if (
      currentCursor !== undefined
      && fetchedCursor !== undefined
      && currentCursor.generation === fetchedCursor.generation
      && fetchedCursor.sequence < currentCursor.sequence
    ) return;
    const mapped = {
      ...mapSnapshot(raw, entryMap, managedModelRuntimes),
      // Owner snapshots intentionally omit session timelines. Preserve the
      // client-side deletion fences until the App has reloaded the affected
      // authoritative history page.
      timelineHistoryRevisionBySession: this.#snapshot?.timelineHistoryRevisionBySession ?? new Map<string, bigint>()
    };
    this.#rawSnapshot = raw;
    this.#snapshot = mapped;
    this.#callbacks.onSnapshot?.(mapped);
  }

  async send(sessionId: string, draft: ComposerDraft): Promise<void> {
    if (draft.extraDirectoryIds?.some((id) => id.length === 0) === true) {
      throw new GatewayError("Extra-directory selections must use non-empty IDs.");
    }
    const browserComments = draft.browserComments ?? [];
    if (browserComments.some((item) => item.screenshot.kind !== "image")) {
      throw new GatewayError("Page annotations contain an invalid screenshot set.");
    }
    const parts: Array<Record<string, unknown>> = [];
    const serialized = serializeComposerDocument(normalizeComposerDocument(draft.editorDocument, draft.text));
    const text = formatBrowserCommentsForSend(browserComments, serialized.text);
    if (text.length > 0) parts.push({ content: { case: "text", value: text } });
    for (const attachment of draft.attachments) {
      const blob = await this.uploadAttachment(attachment.file);
      parts.push(attachment.kind === "image"
        ? { content: { case: "image", value: { blob, altText: attachment.file.name } } }
        : { content: { case: "file", value: blob } });
    }
    for (const mention of activeComposerMentions(draft.text, draft.mentions)) {
      if (mention.kind === "message") {
        parts.push({ content: { case: "text", value: messageMentionWireText(mention, window.location.href) } });
      } else if (mention.kind === "workspace") {
        parts.push({ content: { case: "workspaceMention", value: { workspaceId: mention.workspaceId ?? "", relativePath: mention.reference, displayText: mention.label } } });
      } else {
        parts.push({ content: { case: "resourceMention", value: { resourceId: mention.reference, displayText: mention.label } } });
      }
    }
    for (const item of browserComments) {
      const blob = await this.uploadAttachment(item.screenshot.file);
      parts.push({ content: { case: "image", value: { blob, altText: item.screenshot.file.name } } });
    }
    if (parts.length === 0) throw new GatewayError("A task input cannot be empty.");
    await this.submit({
      case: "sendInput",
      value: {
        sessionId,
        input: {
          parts,
          quotesEncoded: serialized.quotesEncoded,
          pastedTextRanges: serialized.pastedTextRanges?.map((range) => ({
            start: range.start,
            end: range.end,
            display: range.display
          })) ?? []
        },
        deliveryMode: deliveryMode(draft.deliveryMode),
        ...(draft.extraDirectoryIds === undefined
          ? {}
          : { overrides: { extraDirectoryIds: [...new Set(draft.extraDirectoryIds)] } })
      }
    });
  }

  async startReview(sourceSessionId: string, focus: string, attachments: readonly AttachmentDraft[]): Promise<string> {
    // Snapshot this invocation before the first await. A later edit or file
    // picker action must never change what the accepted /review inspects.
    const sourceAttachments = [...attachments];
    const uploaded = await Promise.all(sourceAttachments.map(async (attachment) => ({
      kind: attachment.kind === "image" ? ReviewAttachmentKind.IMAGE : ReviewAttachmentKind.FILE,
      displayName: attachment.file.name,
      blob: await this.uploadAttachment(attachment.file)
    })));
    const operation = await this.submit({
      case: "startReview",
      value: {
        sourceSessionId,
        focus: focus.trim(),
        attachments: uploaded
      }
    }, true);
    const payload = operation.result?.payload;
    const reviewRunId = payload?.case === "reviewRun" ? payload.value.reviewRunId : "";
    if (reviewRunId.length === 0) throw new GatewayError("Orchestrator accepted the review without a review task.");
    return reviewRunId;
  }

  async reobserveReview(reviewRunId: string): Promise<void> {
    const id = reviewRunId.trim();
    if (id.length === 0) throw new GatewayError("Review task ID is required.");
    const operation = await this.submit({
      case: "reobserveReview",
      value: { reviewRunId: id }
    }, true);
    const payload = operation.result?.payload;
    if (payload?.case !== "reviewRun" || payload.value.reviewRunId !== id) {
      throw new GatewayError("Orchestrator completed the evidence check without the selected review task.");
    }
    // Do not infer freshness from a successful Operation. Re-materialize the
    // authoritative Review projection before the card leaves its busy state.
    await this.refresh();
  }

  async abort(runId: string): Promise<void> {
    await this.submit({ case: "abortRun", value: { runId } });
  }

  async abortRetry(runId: string): Promise<void> {
    await this.submit({ case: "abortRetry", value: { runId } });
  }

  async retry(runId: string): Promise<void> {
    await this.submit({ case: "retryRun", value: { runId } }, true);
  }

  async resetSession(sessionId: string): Promise<void> {
    await this.submit({ case: "resetSession", value: { sessionId } }, true);
  }

  async deleteSessionMessage(sessionId: string, eventId: string): Promise<void> {
    await this.submit({ case: "deleteSessionMessage", value: { sessionId, eventId } }, true);
    this.invalidateTimelineHistory(sessionId);
    // The deletion event carries stable identities, not a complete surviving
    // transcript. Await the authoritative projection before reporting success.
    await this.refresh();
  }

  private invalidateTimelineHistory(sessionId: string): void {
    if (this.#snapshot === undefined || sessionId.length === 0) return;
    const snapshot = withTimelineHistoryInvalidation(this.#snapshot, sessionId, this.#snapshot.cursor);
    this.#snapshot = snapshot;
    this.#callbacks.onSnapshot?.(snapshot);
  }

  async renameSession(sessionId: string, name: string): Promise<void> {
    await this.submit({ case: "renameSession", value: { sessionId, displayName: name.trim() } });
  }

  async suggestSessionTitle(
    sessionId: string,
    signal?: AbortSignal
  ): Promise<import("./model.js").SessionTitleSuggestionView> {
    const client = createClient(SessionService, this.requireTransport());
    const response = await client.suggestSessionTitle({ sessionId }, { signal });
    const status = response.status === SessionTitleSuggestionStatus.OK
      ? "ok" as const
      : response.status === SessionTitleSuggestionStatus.NO_MATERIAL
        ? "no_material" as const
        : response.status === SessionTitleSuggestionStatus.PROVIDER_UNAVAILABLE
          ? "provider_unavailable" as const
          : "generation_failed" as const;
    return { title: response.title, status };
  }

  async pinSession(sessionId: string, pinned: boolean): Promise<void> {
    await this.submit({ case: "pinSession", value: { sessionId, pinned } });
  }

  async archiveSession(sessionId: string, archived: boolean): Promise<void> {
    await this.submit({ case: "archiveSession", value: { sessionId, archived } });
  }

  async moveSessionProject(
    sessionId: string,
    projectId?: string,
    catalogImport?: { readonly archived: boolean; readonly modifiedAt: number; readonly snapshotToken: string }
  ): Promise<void> {
    if (catalogImport !== undefined
      && (!Number.isSafeInteger(catalogImport.modifiedAt) || catalogImport.modifiedAt < 0)) {
      throw new GatewayError("Catalog import presentation has an invalid native timestamp.");
    }
    if (catalogImport !== undefined && !validCatalogSnapshotToken(catalogImport.snapshotToken)) {
      throw new GatewayError("Catalog import presentation has an invalid snapshot token.");
    }
    await this.submit({
      case: "moveSessionProject",
      value: {
        sessionId,
        ...(projectId === undefined ? {} : { projectId }),
        ...(catalogImport === undefined ? {} : {
          catalogImport: {
            archived: catalogImport.archived,
            modifiedAt: timestampFromMs(catalogImport.modifiedAt),
            snapshotToken: catalogImport.snapshotToken
          }
        })
      }
    }, true);
  }

  async acknowledgeSessionAttention(
    sessionId: string,
    throughCursor: import("./model.js").TimelineHistoryCursorView
  ): Promise<void> {
    await this.submitSessionAttentionAcknowledgement(sessionId, throughCursor, SessionAttentionAcknowledgementIntent.VIEWED);
  }

  async acknowledgeSessionError(
    sessionId: string,
    throughCursor: import("./model.js").TimelineHistoryCursorView
  ): Promise<void> {
    await this.submitSessionAttentionAcknowledgement(sessionId, throughCursor, SessionAttentionAcknowledgementIntent.EXPLICIT);
  }

  private async submitSessionAttentionAcknowledgement(
    sessionId: string,
    throughCursor: import("./model.js").TimelineHistoryCursorView,
    intent: SessionAttentionAcknowledgementIntent
  ): Promise<void> {
    await this.submit({
      case: "acknowledgeSessionAttention",
      value: {
        sessionId,
        throughCursor: create(EventCursorSchema, {
          opaqueToken: throughCursor.opaqueToken,
          sequence: throughCursor.sequence,
          generation: throughCursor.generation
        }),
        intent
      }
    });
  }

  async deleteSession(sessionId: string, deleteNative: boolean): Promise<void> {
    await this.submit({
      case: "deleteSession",
      value: { sessionId, deleteNativeSession: deleteNative, deleteArtifacts: false }
    });
  }

  async createTarget(draft: TargetDraft): Promise<string> {
    const name = draft.name.trim();
    const serverPath = draft.serverPath.trim();
    if (name.length === 0) throw new GatewayError("A project name is required.");
    if (draft.workspaceKind === "userProject" && serverPath.length === 0) throw new GatewayError("A service-node project path is required.");
    const operation = await this.submit({
      case: "createTarget",
      value: {
        backendId: draft.backendId,
        displayName: name,
        workspace: {
          kind: draft.workspaceKind === "managedDialogue" ? WorkspaceKind.MANAGED_DIALOGUE : WorkspaceKind.USER_PROJECT,
          serverPath,
          createIfMissing: draft.createIfMissing
        }
      }
    }, true);
    const payload = operation.result?.payload;
    if (payload?.case !== "target" || payload.value.targetId.length === 0) {
      throw new GatewayError("Orchestrator completed project creation without a typed project result.");
    }
    return payload.value.targetId;
  }

  async updateTarget(
    targetId: string,
    patch: {
      readonly name?: string;
      readonly pinned?: boolean;
      readonly workspaceLocation?:
        | { readonly kind: "remote"; readonly hostId: string; readonly workspaceRoot: string }
        | { readonly kind: "serviceNode" };
    }
  ): Promise<void> {
    const remoteWorkspaceRoot = patch.workspaceLocation?.kind === "remote"
      ? patch.workspaceLocation.workspaceRoot.trim()
      : undefined;
    if (remoteWorkspaceRoot === "") {
      throw new GatewayError("A remote workspace root is required.");
    }
    const workspaceLocationUpdate = patch.workspaceLocation === undefined
      ? { case: undefined }
      : patch.workspaceLocation.kind === "serviceNode"
        ? { case: "serviceNodeWorkspace" as const, value: true }
        : {
            case: "remoteWorkspace" as const,
            value: {
              hostId: patch.workspaceLocation.hostId,
              workspaceRootDisplay: remoteWorkspaceRoot!
            }
          };
    await this.submit({
      case: "updateTarget",
      value: {
        targetId,
        ...(patch.name === undefined ? {} : { displayName: patch.name.trim() }),
        ...(patch.pinned === undefined ? {} : { pinned: patch.pinned }),
        workspaceLocationUpdate
      }
    }, true);
  }

  async archiveTarget(targetId: string, archived: boolean): Promise<void> {
    await this.submit({ case: "archiveTarget", value: { targetId, archived } }, true);
  }

  async deleteTarget(targetId: string, deleteManagedWorkspace: boolean, deleteProductSessions: boolean): Promise<void> {
    await this.submit({ case: "deleteTarget", value: { targetId, deleteManagedWorkspace, deleteProductSessions } }, true);
  }

  async setWorkspaceTrust(workspaceId: string, trusted: boolean): Promise<void> {
    await this.submit({ case: "setWorkspaceTrust", value: { workspaceId, trusted } }, true);
  }

  async addExtraDirectory(workspaceId: string, serverPath: string, access: ExtraDirectoryView["access"]): Promise<void> {
    const path = serverPath.trim();
    if (path.length === 0) throw new GatewayError("A service-node directory path is required.");
    await this.submit({ case: "addExtraDirectory", value: { workspaceId, serverPath: path, access: access === "readWrite" ? ExtraDirectoryAccess.READ_WRITE : ExtraDirectoryAccess.READ_ONLY } }, true);
  }

  async removeExtraDirectory(extraDirectoryId: string): Promise<void> {
    await this.submit({ case: "removeExtraDirectory", value: { extraDirectoryId } }, true);
  }

  async createSession(draft: NewSessionDraft): Promise<string> {
    const targetId = draft.targetId;
    const target = this.#rawSnapshot?.targets.find((candidate) => candidate.targetId === targetId);
    if (target === undefined) throw new GatewayError("The selected target is no longer available.");
    if ((draft.appendSystemPrompt?.length ?? 0) > 8_000) {
      throw new GatewayError("Personalization instructions cannot exceed 8,000 characters.");
    }
    if (draft.worktree !== undefined && draft.nativeStart.kind !== "fresh") {
      throw new GatewayError("An isolated workspace requires a fresh task.");
    }
    if (draft.catalogImport !== undefined && draft.nativeStart.kind !== "attach") {
      throw new GatewayError("Catalog import presentation requires an attached native task.");
    }
    if (draft.catalogImport !== undefined
      && (!Number.isSafeInteger(draft.catalogImport.createdAt) || draft.catalogImport.createdAt < 0
        || !Number.isSafeInteger(draft.catalogImport.modifiedAt) || draft.catalogImport.modifiedAt < 0
        || draft.catalogImport.createdAt > draft.catalogImport.modifiedAt)) {
      throw new GatewayError("Catalog import presentation has invalid native timestamps.");
    }
    if (draft.catalogImport !== undefined && !validCatalogSnapshotToken(draft.catalogImport.snapshotToken)) {
      throw new GatewayError("Catalog import presentation has an invalid snapshot token.");
    }
    const nativeStart = create(
      NativeSessionStartSchema,
      draft.nativeStart.kind === "attach"
        ? { kind: { case: "attach", value: { opaqueNativeReference: draft.nativeStart.reference } } }
        : { kind: { case: "newSession", value: { parentNativeReference: "" } } }
    );
    const operation = await this.submit({
      case: "createSession",
      value: {
        backendId: target.backendId,
        targetId,
        displayName: draft.name.trim() || "New task",
        nativeStart,
        ...(draft.providerId.length > 0 && draft.modelId.length > 0 ? { model: { model: { providerId: draft.providerId, modelId: draft.modelId }, effortId: draft.effort ?? "", fastMode: draft.fastMode } } : {}),
        permissionMode: protoPermission(draft.permissionMode),
        planMode: draft.planMode,
        initialPlacement: draft.initialPlacement === "dialogue"
          ? NativeSessionPlacement.DIALOGUE
          : NativeSessionPlacement.PROJECT,
        ...(draft.catalogImport === undefined ? {} : {
          catalogImport: {
            ...(draft.catalogImport.projectId === undefined ? {} : { projectId: draft.catalogImport.projectId }),
            archived: draft.catalogImport.archived,
            createdAt: timestampFromMs(draft.catalogImport.createdAt),
            modifiedAt: timestampFromMs(draft.catalogImport.modifiedAt),
            snapshotToken: draft.catalogImport.snapshotToken
          }
        }),
        useWorktree: draft.worktree !== undefined,
        ...(draft.worktree?.sourceRef === undefined ? {} : { worktreeSourceRef: draft.worktree.sourceRef }),
        refreshWorktreeRemote: draft.worktree?.refreshRemote ?? false,
        ...(draft.nativeStart.kind === "fresh" && draft.appendSystemPrompt !== undefined
          ? { appendSystemPrompt: draft.appendSystemPrompt }
          : {})
      }
    }, true);
    const payload = operation.result?.payload;
    if (payload?.case !== "session" || payload.value.sessionId.length === 0) {
      throw new GatewayError("Orchestrator completed task creation without a typed task result.");
    }
    return payload.value.sessionId;
  }

  async discoverNativeSessions(targetId: string): Promise<readonly NativeSessionCandidateView[]> {
    const client = createClient(SessionService, this.requireTransport());
    const values: NativeSessionCandidateView[] = [];
    const consumedTokens = new Set<string>();
    let pageToken = "";
    for (let pageIndex = 0; pageIndex < MAX_COMPLETE_MESSAGE_SEARCH_PAGES; pageIndex += 1) {
      const response = await client.discoverNativeSessions(
        { targetId, page: { pageSize: 500, pageToken } },
        this.#abort === undefined ? undefined : { signal: this.#abort.signal }
      );
      values.push(...response.sessions.map(mapNativeSessionCandidate));
      const nextPageToken = response.page?.nextPageToken ?? "";
      if (nextPageToken === "") return values;
      if (nextPageToken === pageToken || consumedTokens.has(nextPageToken)) {
        throw new GatewayError("Orchestrator returned a cyclic native Session discovery page token.");
      }
      consumedTokens.add(nextPageToken);
      pageToken = nextPageToken;
    }
    throw new GatewayError("Native Session discovery exceeded the safe pagination limit.");
  }

  async scanNativeSessionCatalog(
    backendId: string,
    options?: { readonly signal?: AbortSignal; readonly force?: boolean }
  ): Promise<NativeSessionCatalogView> {
    const client = createClient(SessionService, this.requireTransport());
    const response = await client.scanNativeSessionCatalog(
      { backendId, force: options?.force ?? false },
      { signal: options?.signal ?? this.#abort?.signal }
    );
    if (response.entries.length > 10_000) {
      throw new GatewayError("Orchestrator returned too many native task catalog entries.");
    }
    if (!validCatalogSnapshotToken(response.snapshotToken)) {
      throw new GatewayError("Orchestrator returned an invalid native task catalog snapshot token.");
    }
    return {
      entries: response.entries.map(mapNativeSessionCatalogEntry),
      rejectedCount: numberValue(response.rejectedCount),
      existingCount: numberValue(response.existingCount),
      snapshotToken: response.snapshotToken
    };
  }

  async setModel(sessionId: string, providerId: string, modelId: string, effort: string | undefined, fastMode: boolean): Promise<void> {
    await this.submit({
      case: "setSessionModel",
      value: { sessionId, model: { model: { providerId, modelId }, effortId: effort ?? "", fastMode } }
    });
  }

  async setPermission(sessionId: string, mode: PermissionMode): Promise<void> {
    await this.submit({ case: "setSessionPermission", value: { sessionId, permissionMode: protoPermission(mode) } });
  }

  async setPlanMode(sessionId: string, enabled: boolean): Promise<void> {
    await this.submit({ case: "setSessionPlanMode", value: { sessionId, enabled } });
  }

  async compact(sessionId: string, customInstructions?: string): Promise<"compacted" | "noop"> {
    const instructions = customInstructions?.trim() ?? "";
    const operation = await this.submit(
      { case: "compactSession", value: { sessionId, customInstructions: instructions } },
      true
    );
    const payload = operation.result?.payload;
    if (payload?.case !== "compactSession") {
      throw new GatewayError("Orchestrator completed compact Session without a typed outcome.");
    }
    const outcome = payload.value.outcome;
    if (outcome === CompactSessionOutcome.COMPACTED) return "compacted";
    if (outcome === CompactSessionOutcome.NOOP) return "noop";
    throw new GatewayError("Orchestrator returned an unknown compact Session outcome.");
  }

  async probeTargetWorktree(targetId: string, signal?: AbortSignal): Promise<TargetWorktreeProbeView> {
    const client = createClient(WorktreeService, this.requireTransport());
    const response = await client.probeTargetWorktree(
      { targetId },
      signal === undefined ? undefined : { signal }
    );
    if (response.targetId !== targetId) throw new GatewayError("Orchestrator returned a Worktree probe for another Target.");
    return {
      targetId: response.targetId,
      eligibility: mapWorktreeEligibility(response.eligibility),
      ...(response.repositoryRootDisplay === "" ? {} : { repositoryRoot: response.repositoryRootDisplay }),
      ...(response.currentBranch === "" ? {} : { currentBranch: response.currentBranch }),
      ...(response.headCommit === "" ? {} : { headCommit: response.headCommit }),
      canRefreshRemote: response.canRefreshRemote
    };
  }

  async listTargetWorktreeSources(targetId: string, signal?: AbortSignal): Promise<readonly WorktreeSourceView[]> {
    const client = createClient(WorktreeService, this.requireTransport());
    const values: WorktreeSourceView[] = [];
    const consumedTokens = new Set<string>();
    let pageToken = "";
    for (let pageIndex = 0; pageIndex < MAX_COMPLETE_MESSAGE_SEARCH_PAGES; pageIndex += 1) {
      const response = await client.listTargetWorktreeSources(
        { targetId, page: { pageSize: 500, pageToken } },
        signal === undefined ? undefined : { signal }
      );
      values.push(...response.sources.map((source) => {
        if (source.ref === "" || source.commit === "" || source.displayName === "") {
          throw new GatewayError("Orchestrator returned an invalid Worktree source.");
        }
        return {
          ref: source.ref,
          commit: source.commit,
          name: source.displayName,
          remote: source.remote,
          current: source.current
        };
      }));
      const nextPageToken = response.page?.nextPageToken ?? "";
      if (nextPageToken === "") return values;
      if (nextPageToken === pageToken || consumedTokens.has(nextPageToken)) {
        throw new GatewayError("Orchestrator returned a cyclic Worktree source page token.");
      }
      consumedTokens.add(nextPageToken);
      pageToken = nextPageToken;
    }
    throw new GatewayError("Worktree source discovery exceeded the safe pagination limit.");
  }

  async exportSession(sessionId: string): Promise<void> {
    const operation = await this.submit(
      { case: "exportSession", value: { sessionId, format: SessionExportFormat.HTML } },
      true
    );
    const payload = operation.result?.payload;
    if (payload?.case !== "artifact") {
      throw new GatewayError("Orchestrator completed Session export without an Artifact.");
    }
    const blob = payload.value.blob;
    if (blob === undefined || blob.blobId.trim() === "") {
      throw new GatewayError("Orchestrator returned a Session export Artifact without a Blob.");
    }
    if (blob.mediaType.split(";", 1)[0]?.trim().toLowerCase() !== "text/html") {
      throw new GatewayError("Orchestrator returned a non-HTML Session export Artifact.");
    }
    await this.downloadArtifact(blob.blobId, blob.fileName || payload.value.title || "session-export.html");
  }

  async exportPortableSession(
    sessionId: string,
    options: { readonly password?: string; readonly excludeMedia: boolean }
  ): Promise<PortableSessionExportOutcomeView> {
    const client = createClient(PortableSessionService, this.requireTransport());
    try {
      const response = await client.exportPortableSession({
        sessionId,
        ...(options.password === undefined ? {} : { password: options.password }),
        excludeMedia: options.excludeMedia
      }, this.#abort === undefined ? undefined : { signal: this.#abort.signal });
      const artifact = response.artifact;
      if (artifact === undefined || artifact.blobId.trim() === "") {
        throw new GatewayError("Orchestrator completed portable task export without an Artifact.");
      }
      if (artifact.mediaType.split(";", 1)[0]?.trim().toLowerCase() !== "application/vnd.joko.session") {
        throw new GatewayError("Orchestrator returned an invalid portable task Artifact.");
      }
      const saved = await this.saveArtifact(artifact.blobId, artifact.fileName || "task.jshare");
      return saved
        ? { status: "exported", fidelity: mapPortableSessionFidelity(response.fidelity) }
        : { status: "cancelled" };
    } catch (error) {
      if (error instanceof ConnectError && error.code === Code.ResourceExhausted) {
        return {
          status: "oversize",
          mediaBytes: portableErrorByteCount(error.metadata.get("x-joko-portable-media-bytes")),
          limitBytes: portableErrorByteCount(error.metadata.get("x-joko-portable-limit-bytes"))
        };
      }
      throw normalizeError(error);
    }
  }

  async inspectPortableSessionImport(file: File): Promise<PortableSessionImportDraftView> {
    if (!file.name.toLocaleLowerCase("en-US").endsWith(".jshare")) {
      throw new GatewayError("Select a .jshare portable task package.", { code: "PORTABLE_SESSION_IMPORT_INVALID" });
    }
    if (file.size <= 0 || file.size > MAX_PORTABLE_SESSION_PACKAGE_BYTES) {
      throw new GatewayError("The portable task package has an invalid size.", { code: "PORTABLE_SESSION_IMPORT_INVALID" });
    }
    const client = createClient(PortableSessionService, this.requireTransport());
    try {
      const packageBlob = await this.uploadBlob(file, BlobDisposition.ATTACHMENT);
      const response = await client.inspectPortableSessionImport(
        { package: packageBlob },
        this.#abort === undefined ? undefined : { signal: this.#abort.signal }
      );
      return mapPortableSessionImportDraft(response.draft);
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      throw new GatewayError(ConnectError.from(error).rawMessage, {
        cause: error,
        code: "PORTABLE_SESSION_IMPORT_INVALID"
      });
    }
  }

  async unlockPortableSessionImport(draftId: string, password: string): Promise<PortableSessionImportDraftView> {
    const client = createClient(PortableSessionService, this.requireTransport());
    try {
      const response = await client.unlockPortableSessionImport(
        { draftId, password },
        this.#abort === undefined ? undefined : { signal: this.#abort.signal }
      );
      return mapPortableSessionImportDraft(response.draft);
    } catch (error) {
      const connected = ConnectError.from(error);
      throw new GatewayError(connected.rawMessage, {
        cause: error,
        code: connected.code === Code.InvalidArgument ? "DECRYPTION_FAILED" : "PORTABLE_SESSION_IMPORT_INVALID"
      });
    }
  }

  async cancelPortableSessionImport(draftId: string): Promise<void> {
    const client = createClient(PortableSessionService, this.requireTransport());
    await client.cancelPortableSessionImport(
      { draftId },
      this.#abort === undefined ? undefined : { signal: this.#abort.signal }
    );
  }

  async commitPortableSessionImport(input: {
    readonly draftId: string;
    readonly targetId: string;
    readonly execution: PortableSessionExecutionSelection;
    readonly overwrite: boolean;
    readonly useWorktree: boolean;
    readonly worktreeSourceRef?: string;
    readonly refreshWorktreeRemote?: boolean;
  }): Promise<PortableSessionImportResultView> {
    const client = createClient(PortableSessionService, this.requireTransport());
    const hasModel = input.execution.providerId !== undefined && input.execution.providerId !== ""
      && input.execution.modelId !== undefined && input.execution.modelId !== "";
    try {
      const response = await client.commitPortableSessionImport({
        operationId: randomUuid(),
        draftId: input.draftId,
        targetId: input.targetId,
        ...(hasModel ? {
          model: {
            model: {
              providerId: input.execution.providerId!,
              modelId: input.execution.modelId!
            },
            effortId: input.execution.effort ?? "",
            fastMode: input.execution.fastMode
          }
        } : {}),
        permissionMode: protoPermission(input.execution.permissionMode),
        planMode: input.execution.planMode,
        overwrite: input.overwrite,
        useWorktree: input.useWorktree,
        ...(input.useWorktree && input.worktreeSourceRef !== undefined
          ? { worktreeSourceRef: input.worktreeSourceRef }
          : {}),
        refreshWorktreeRemote: input.useWorktree && input.refreshWorktreeRemote === true
      }, this.#abort === undefined ? undefined : { signal: this.#abort.signal });
      const result = response.result;
      if (result === undefined || result.sessionId.trim() === "") {
        throw new GatewayError("Orchestrator completed portable task import without a task result.");
      }
      return {
        sessionId: result.sessionId,
        fidelity: mapPortableSessionFidelity(result.fidelity),
        messageCount: portableCount(result.messageCount, "message"),
        mediaCount: portableCount(result.mediaCount, "media"),
        workerCount: portableCount(result.workerCount, "worker"),
        replacedSessionIds: [...result.replacedSessionIds],
        status: mapPortableSessionImportStatus(result.status),
        ...(result.activationError === undefined ? {} : { activationError: mapError(result.activationError) })
      };
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      const connected = ConnectError.from(error);
      throw new GatewayError(connected.rawMessage, {
        cause: error,
        code: connected.code === Code.AlreadyExists
          ? "PORTABLE_SESSION_IMPORT_CONFLICT"
          : "PORTABLE_SESSION_IMPORT_INVALID"
      });
    }
  }

  async retryPortableSessionActivation(sessionId: string): Promise<PortableSessionActivationResultView> {
    const client = createClient(PortableSessionService, this.requireTransport());
    try {
      const response = await client.retryPortableSessionActivation(
        { sessionId },
        this.#abort === undefined ? undefined : { signal: this.#abort.signal }
      );
      if (response.sessionId !== sessionId) {
        throw new GatewayError("Orchestrator returned portable activation for a different task.");
      }
      return {
        sessionId,
        status: mapPortableSessionImportStatus(response.status),
        ...(response.activationError === undefined ? {} : { activationError: mapError(response.activationError) })
      };
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      const connected = ConnectError.from(error);
      throw new GatewayError(connected.rawMessage, {
        cause: error,
        code: "PORTABLE_SESSION_ACTIVATION_FAILED"
      });
    }
  }

  async executeUserShell(sessionId: string, command: string, excludeFromContext: boolean): Promise<void> {
    const value = command.trim();
    if (value.length === 0) throw new GatewayError("A shell command is required.");
    await this.submit({ case: "executeUserShell", value: { sessionId, command: value, excludeFromContext } }, true);
  }

  async abortUserShell(sessionId: string): Promise<void> {
    await this.submit({ case: "abortUserShell", value: { sessionId } }, true);
  }

  async getSessionStatistics(sessionId: string, signal?: AbortSignal): Promise<SessionStatisticsView> {
    const client = createClient(SessionService, this.requireTransport());
    const response = await client.getSessionStatistics(
      { sessionId },
      signal === undefined
        ? this.#abort === undefined ? undefined : { signal: this.#abort.signal }
        : { signal }
    );
    if (response.statistics === undefined) throw new GatewayError("Orchestrator returned no task statistics.");
    return mapSessionStatistics(response.statistics, sessionId);
  }

  async getSessionTree(sessionId: string): Promise<NativeSessionTreeView> {
    const client = createClient(SessionService, this.requireTransport());
    const response = await client.getNativeSessionTree({ sessionId }, this.#abort === undefined ? undefined : { signal: this.#abort.signal });
    const tree = response.tree;
    if (tree === undefined) throw new GatewayError("Orchestrator returned no native session tree.");
    return {
      nativeSessionId: tree.sessionId,
      ...(tree.activeEntryId.length === 0 ? {} : { activeLeafId: tree.activeEntryId }),
      roots: nativeSessionTreeRoots(tree).map(mapNativeTreeNode)
    };
  }

  async navigateSessionBranch(
    sessionId: string,
    entryId: string,
    options: { readonly summarize?: boolean; readonly customInstructions?: string } = {}
  ): Promise<void> {
    const customInstructions = options.customInstructions?.trim().slice(0, 4_000) ?? "";
    await this.submit({
      case: "navigateSessionBranch",
      value: {
        sessionId,
        nativeEntryId: entryId,
        summarize: options.summarize === true,
        customInstructions: options.summarize === true ? customInstructions : ""
      }
    }, true);
  }

  async forkSession(
    sessionId: string,
    entryId: string,
    name: string,
    sourceMessage?: { readonly messageId: string; readonly eventId: string }
  ): Promise<string> {
    const operation = await this.submit({
      case: "forkSession",
      value: {
        sourceSessionId: sessionId,
        nativeEntryId: entryId,
        newDisplayName: name.trim(),
        ...(sourceMessage === undefined ? {} : {
          sourceMessageId: sourceMessage.messageId,
          sourceEventId: sourceMessage.eventId
        })
      }
    }, true);
    return operationSessionId(operation);
  }

  async cloneSession(
    sessionId: string,
    name: string,
    sourceMessage?: { readonly messageId: string; readonly eventId: string }
  ): Promise<string> {
    const operation = await this.submit({
      case: "cloneSession",
      value: {
        sourceSessionId: sessionId,
        newDisplayName: name.trim(),
        ...(sourceMessage === undefined ? {} : {
          sourceMessageId: sourceMessage.messageId,
          sourceEventId: sourceMessage.eventId
        })
      }
    }, true);
    return operationSessionId(operation);
  }

  async resolveInteraction(interaction: InteractionView, resolution: InteractionResolutionDraft): Promise<void> {
    const raw = this.#rawSnapshot?.interactions.find((candidate) => candidate.interactionId === interaction.id);
    if (raw === undefined) throw new GatewayError("This interaction is no longer pending.");
    await this.submit({
      case: "resolveInteraction",
      value: {
        interactionId: interaction.id,
        interactionGeneration: interaction.generation,
        resolution: {
          connectionId: this.#profile?.id ?? "",
          decision: await interactionDecision(raw, resolution, (secret) => this.uploadSensitiveAnswer(secret))
        }
      }
    });
  }

  async dismissInteraction(interaction: InteractionView): Promise<void> {
    await this.submit({
      case: "dismissInteraction",
      value: { interactionId: interaction.id, interactionGeneration: interaction.generation, reason: "Dismissed by user" }
    });
  }

  async runSchedule(scheduleId: string): Promise<void> {
    await this.submit({ case: "triggerSchedule", value: { scheduleId } });
  }

  async setScheduleEnabled(scheduleId: string, enabled: boolean): Promise<void> {
    await this.submit({ case: "setScheduleEnabled", value: { scheduleId, enabled } });
  }

  async deleteSchedule(
    scheduleId: string,
    disposition: ScheduleGeneratedSessionDispositionView
  ): Promise<ScheduleDeletionResultView> {
    return scheduleDeletionResult(await this.submit({
      case: "deleteSchedule",
      value: {
        scheduleId,
        generatedSessionDisposition: disposition === "keep"
          ? ScheduleGeneratedSessionDisposition.KEEP
          : disposition === "archive"
            ? ScheduleGeneratedSessionDisposition.ARCHIVE
            : ScheduleGeneratedSessionDisposition.DELETE
      }
    }, true));
  }

  async markScheduleRunRead(scheduleId: string, triggerId: string): Promise<void> {
    await this.submit({ case: "markScheduleRunRead", value: { scheduleId, triggerId } });
  }

  async markScheduleRunsRead(scheduleId: string): Promise<number> {
    return scheduleRunsReadCount(await this.submit({ case: "markScheduleRunsRead", value: { scheduleId } }, true));
  }

  async markAllScheduleRunsRead(): Promise<number> {
    return scheduleRunsReadCount(await this.submit({ case: "markAllScheduleRunsRead", value: {} }, true));
  }

  async deleteScheduleRun(scheduleId: string, triggerId: string): Promise<void> {
    await this.submit({ case: "deleteScheduleRun", value: { scheduleId, triggerId } });
  }

  async restartScheduleRun(scheduleId: string, triggerId: string): Promise<void> {
    await this.submit({ case: "restartScheduleRun", value: { scheduleId, triggerId } });
  }

  async reconcileProjectAutomations(targetId: string): Promise<void> {
    await this.submit({ case: "reconcileProjectAutomations", value: { targetId } }, true);
  }

  async promoteScheduleToProject(scheduleId: string): Promise<void> {
    await this.submit({ case: "promoteScheduleToProject", value: { scheduleId } }, true);
  }

  async cloneProjectScheduleToUser(scheduleId: string, displayName: string): Promise<void> {
    await this.submit({ case: "cloneProjectScheduleToUser", value: { scheduleId, displayName } }, true);
  }

  async removeProjectSchedule(scheduleId: string, keepPersonalCopy: boolean): Promise<void> {
    await this.submit({ case: "removeProjectSchedule", value: { scheduleId, keepPersonalCopy } }, true);
  }

  async saveSchedule(scheduleId: string | undefined, draft: ScheduleDraft): Promise<void> {
    const scriptMode = draft.executionMode === "script";
    if (draft.useWorktree && (scriptMode || draft.sessionMode !== "fresh" || draft.sessionId !== "")) {
      throw new GatewayError("Isolated workspace schedules require agent execution with a new task every run.");
    }
    if (!scriptMode && draft.inputText.trim().length === 0) {
      throw new GatewayError("Agent schedules require a non-empty scheduled input.");
    }
    if (scriptMode && draft.scriptCommand.trim().length === 0) {
      throw new GatewayError("Script schedules require a command.");
    }
    if (draft.scriptTimeoutMs !== undefined && (!Number.isSafeInteger(draft.scriptTimeoutMs) || draft.scriptTimeoutMs <= 0)) {
      throw new GatewayError("Script timeout must be a positive whole number of milliseconds.");
    }
    const expireAt = draft.expireAtExpression.trim().length === 0
      ? undefined
      : scheduleEpochFromLocalDateTime(draft.expireAtExpression, draft.timezone);
    if (draft.expireAtExpression.trim().length > 0 && expireAt === undefined) {
      throw new GatewayError("Enter a valid expiration time in the selected IANA timezone.");
    }
    const schedule = create(ScheduleInputSchema, {
      displayName: draft.name.trim(),
      backendId: draft.backendId,
      targetId: draft.targetId,
      sessionId: scriptMode || draft.sessionMode === "fresh" ? "" : draft.sessionId,
      sessionMode: scriptMode || draft.sessionMode === "fresh"
        ? ScheduleSessionMode.FRESH
        : draft.sessionMode === "persistent"
          ? ScheduleSessionMode.PERSISTENT
          : ScheduleSessionMode.BOUND,
      recurrence: scheduleRecurrence(draft),
      timeZone: draft.timezone,
      input: { parts: draft.inputText.trim().length === 0 ? [] : [{ content: { case: "text", value: draft.inputText } }] },
      execution: {
        ...(!scriptMode && draft.providerId.length > 0 && draft.modelId.length > 0 ? { model: { model: { providerId: draft.providerId, modelId: draft.modelId }, effortId: draft.effort ?? "", fastMode: draft.fastMode } } : {}),
        permissionMode: protoPermission(draft.permissionMode),
        planMode: !scriptMode && draft.planMode,
        useWorktree: draft.useWorktree,
        ...(!draft.useWorktree || draft.worktreeSourceRef === undefined
          ? {}
          : { worktreeSourceRef: draft.worktreeSourceRef }),
        refreshWorktreeRemote: draft.useWorktree && draft.refreshWorktreeRemote,
        extraDirectoryIds: scriptMode ? [] : [...draft.extraDirectoryIds],
        executionMode: scriptMode ? ScheduleExecutionMode.SCRIPT : ScheduleExecutionMode.AGENT,
        ...(scriptMode ? {
          script: {
            command: draft.scriptCommand,
            ...(draft.scriptTimeoutMs === undefined ? {} : { timeout: durationFromMs(draft.scriptTimeoutMs) }),
            capabilities: draft.scriptDispatchSessions ? [ScheduleScriptCapability.SESSIONS_DISPATCH] : []
          }
        } : {}),
        silentWhenIdle: !scriptMode && draft.silentWhenIdle,
        notify: { desktop: draft.notifyDesktop },
        ...(expireAt === undefined ? {} : { expireAt: timestampFromMs(expireAt) }),
        ...(draft.preRunHook === undefined ? {} : {
          preRunHook: {
            command: draft.preRunHook.command,
            filePath: draft.preRunHook.filePath,
            ...(draft.preRunHook.timeoutMs === undefined ? {} : { timeout: durationFromMs(draft.preRunHook.timeoutMs) })
          }
        })
      },
      overlapPolicy: draft.overlapPolicy === "skip" ? ScheduleOverlapPolicy.SKIP : ScheduleOverlapPolicy.QUEUE,
      misfirePolicy: draft.misfirePolicy === "skip" ? ScheduleMisfirePolicy.SKIP : ScheduleMisfirePolicy.RUN_ONCE,
      enabled: draft.enabled
    });
    await this.submit(scheduleId === undefined
      ? { case: "createSchedule", value: { schedule } }
      : { case: "updateSchedule", value: { scheduleId, schedule } }, true);
  }

  async listScheduleRunHistory(scheduleId: string, pageToken = "", pageSize = 20): Promise<ScheduleHistoryPageView> {
    const client = createClient(SchedulerService, this.requireTransport());
    const response = await client.listScheduleRunHistory({
      scheduleId,
      page: { pageSize: Math.max(1, Math.min(100, Math.floor(pageSize))), pageToken }
    }, this.#abort === undefined ? undefined : { signal: this.#abort.signal });
    return {
      history: response.history.map(mapScheduleRunHistory),
      ...(response.page?.nextPageToken ? { nextPageToken: response.page.nextPageToken } : {}),
      totalSize: numberValue(response.page?.totalSize)
    };
  }

  async cancelQueueItem(queueItemId: string): Promise<void> {
    const existing = this.#rawSnapshot?.queueItems.find((item) => item.queueItemId === queueItemId);
    if (existing === undefined) throw new GatewayError("This queued input is no longer available.");
    await this.submit(
      { case: "cancelQueueItem", value: { queueItemId } },
      false,
      [queueItemPrecondition(existing)]
    );
  }

  async setQueueItemEditLock(queueItemId: string, lockToken: string, locked: boolean): Promise<void> {
    const existing = this.#rawSnapshot?.queueItems.find((item) => item.queueItemId === queueItemId);
    if (locked && existing === undefined) throw new GatewayError("This queued input is no longer available.");
    await this.submit(
      { case: "setQueueItemEditLock", value: { queueItemId, lockToken, locked } },
      false,
      locked && existing !== undefined ? [queueItemPrecondition(existing)] : []
    );
  }

  async setQueueInteractionLock(sessionId: string, lockToken: string, locked: boolean): Promise<void> {
    const existing = this.#rawSnapshot?.queueControls.find((control) => control.sessionId === sessionId);
    if (locked && existing === undefined) throw new GatewayError("This queue is no longer available.");
    await this.submit(
      { case: "setQueueInteractionLock", value: { sessionId, lockToken, locked } },
      false,
      locked && existing !== undefined ? [queueControlPrecondition(existing)] : []
    );
  }

  async editQueueItem(queueItemId: string, text: string, mode: ComposerDraft["deliveryMode"], lockToken: string): Promise<void> {
    const existing = this.#rawSnapshot?.queueItems.find((item) => item.queueItemId === queueItemId);
    if (existing === undefined) throw new GatewayError("This queued input is no longer available.");
    const retained = (existing.input?.parts ?? []).filter((part) => part.content.case !== "text");
    const normalized = text.trim();
    if (normalized.length === 0 && retained.length === 0) throw new GatewayError("Queued input cannot be empty.");
    await this.submit({
      case: "editQueueItem",
      value: {
        queueItemId,
        input: { parts: [...(normalized.length === 0 ? [] : [{ content: { case: "text" as const, value: normalized } }]), ...retained] },
        deliveryMode: deliveryMode(mode),
        lockToken
      }
    }, true, [queueItemPrecondition(existing)]);
  }

  async reorderQueueItem(queueItemId: string, placement: "first" | "last" | "before" | "after", anchorQueueItemId?: string, interactionLockToken?: string): Promise<void> {
    const existing = this.#rawSnapshot?.queueItems.find((item) => item.queueItemId === queueItemId);
    if (existing === undefined) throw new GatewayError("This queued input is no longer available.");
    const anchor = placement === "first" || placement === "last"
      ? { case: "edge" as const, value: placement === "first" ? QueueEdge.FIRST : QueueEdge.LAST }
      : placement === "before"
        ? { case: "beforeQueueItemId" as const, value: anchorQueueItemId ?? "" }
        : { case: "afterQueueItemId" as const, value: anchorQueueItemId ?? "" };
    if ((placement === "before" || placement === "after") && !anchorQueueItemId) throw new GatewayError("A queue reorder anchor is required.");
    await this.submit(
      { case: "reorderQueueItem", value: { queueItemId, placement: { anchor }, interactionLockToken: interactionLockToken ?? "" } },
      true,
      [queueItemPrecondition(existing)]
    );
  }

  async steerQueueItemNow(queueItemId: string, text: string, lockToken: string): Promise<void> {
    await this.editQueueItem(queueItemId, text, "steer", lockToken);
  }

  async pauseQueue(sessionId: string, reason = "Paused by user"): Promise<void> {
    const existing = this.#rawSnapshot?.queueControls.find((control) => control.sessionId === sessionId);
    if (existing === undefined) throw new GatewayError("This queue is no longer available.");
    await this.submit(
      { case: "pauseQueue", value: { sessionId, reason: reason.trim() || "Paused by user" } },
      true,
      [queueControlPrecondition(existing)]
    );
  }

  async resumeQueue(sessionId: string): Promise<void> {
    const existing = this.#rawSnapshot?.queueControls.find((control) => control.sessionId === sessionId);
    if (existing === undefined) throw new GatewayError("This queue is no longer available.");
    await this.submit(
      { case: "resumeQueue", value: { sessionId } },
      true,
      [queueControlPrecondition(existing)]
    );
  }

  async restartBrowser(browserId: string): Promise<void> {
    await this.submit({ case: "restartBrowser", value: { browserProviderId: browserId } });
  }

  async openBrowserPage(browserId: string, sessionId: string, url: string, recoveryPageId = ""): Promise<string> {
    const browser = this.#rawSnapshot?.browsers.find((candidate) => candidate.browserProviderId === browserId);
    if (browser === undefined) throw new GatewayError("The Browser Provider is unavailable.");
    const takeover = browser.takeover;
    if (takeover !== undefined && (
      takeover.state !== BrowserTakeoverState.ACTIVE ||
      takeover.connectionId !== this.#profile?.id ||
      takeover.generation !== browser.generation ||
      takeover.takeoverId.length === 0 ||
      takeover.pageId.length === 0
    )) {
      throw new GatewayError("The Browser Provider is controlled by another connection or a stale generation.");
    }
    const operation = await this.submit({
      case: "openBrowserPage",
      value: {
        browserProviderId: browserId,
        sessionId,
        url: durableBrowserTakeoverUrl(url),
        expectedGeneration: browser.generation,
        currentPageId: takeover?.pageId ?? "",
        takeoverId: takeover?.takeoverId ?? "",
        recoveryPageId
      }
    }, true);
    const payload = operation.result?.payload;
    if (payload?.case !== "browserTakeover" || payload.value.pageId.length === 0) {
      throw new GatewayError("Orchestrator completed the Browser page open without a page takeover.");
    }
    return payload.value.pageId;
  }

  async recoverBrowserPage(browserId: string, sessionId: string, pageId: string, url: string): Promise<string> {
    if (pageId.trim().length === 0) throw new GatewayError("A recoverable Browser page ID is required.");
    return this.openBrowserPage(browserId, sessionId, url, pageId);
  }

  async focusBrowserPage(browserId: string, pageId: string): Promise<string> {
    const browser = this.#rawSnapshot?.browsers.find((candidate) => candidate.browserProviderId === browserId);
    const takeover = this.requireOwnedBrowserTakeover(browserId);
    if (browser === undefined || takeover.generation !== browser.generation || takeover.pageId.length === 0) {
      throw new GatewayError("The Browser takeover fence does not match this Provider generation.");
    }
    const operation = await this.submit({
      case: "focusBrowserPage",
      value: {
        browserProviderId: browserId,
        pageId,
        currentPageId: takeover.pageId,
        takeoverId: takeover.takeoverId,
        generation: takeover.generation
      }
    }, true);
    const result = operation.result?.payload;
    if (result?.case !== "browserTakeover" || result.value.pageId.length === 0) {
      throw new GatewayError("Orchestrator completed Browser page focus without a page takeover.");
    }
    await this.refresh();
    return result.value.pageId;
  }

  async closeBrowserPage(browserId: string, pageId: string): Promise<string | undefined> {
    const browser = this.#rawSnapshot?.browsers.find((candidate) => candidate.browserProviderId === browserId);
    const takeover = this.requireOwnedBrowserTakeover(browserId);
    if (browser === undefined || takeover.generation !== browser.generation || takeover.pageId.length === 0) {
      throw new GatewayError("The Browser takeover fence does not match this Provider generation.");
    }
    const operation = await this.submit({
      case: "closeBrowserPage",
      value: {
        browserProviderId: browserId,
        pageId,
        currentPageId: takeover.pageId,
        takeoverId: takeover.takeoverId,
        generation: takeover.generation
      }
    }, true);
    await this.refresh();
    const result = operation.result?.payload;
    return result?.case === "browserTakeover" && result.value.pageId.length > 0 ? result.value.pageId : undefined;
  }

  async beginBrowserTakeover(browserId: string, pageId: string): Promise<void> {
    await this.submit({ case: "beginBrowserTakeover", value: { browserProviderId: browserId, pageId } });
  }

  async endBrowserTakeover(browserId: string): Promise<void> {
    const takeover = this.requireOwnedBrowserTakeover(browserId);
    await this.submit({ case: "endBrowserTakeover", value: { takeoverId: takeover.takeoverId } });
  }

  async performBrowserTakeoverAction(browserId: string, pageId: string, action: BrowserTakeoverActionView): Promise<string> {
    const browser = this.#rawSnapshot?.browsers.find((candidate) => candidate.browserProviderId === browserId);
    const takeover = this.requireOwnedBrowserTakeover(browserId);
    if (browser === undefined || takeover.pageId !== pageId || takeover.generation !== browser.generation) {
      throw new GatewayError("The browser takeover fence does not match this page generation.");
    }
    await this.submit({
      case: "browserTakeoverAction",
      value: {
        browserProviderId: browserId,
        pageId,
        takeoverId: takeover.takeoverId,
        generation: takeover.generation,
        action: browserTakeoverActionPayload(action)
      }
    }, true);
    const screenshot = await this.captureBrowserScreenshot(browserId, pageId, false);
    // Browser runtime state (URL, loading, and navigation-history availability)
    // is not reconstructed from an acknowledgement event. Refresh the typed
    // owner snapshot before the chrome action reports completion.
    await this.refresh();
    return screenshot;
  }

  async inspectBrowserCommentTarget(
    browserId: string,
    pageId: string,
    input: BrowserCommentInspectionInputView
  ): Promise<BrowserCommentInspectionResultView> {
    const { browser, takeover } = this.requireBrowserCommentFence(browserId, pageId);
    const intent = input.intent === "element"
      ? BrowserCommentInspectionIntent.ELEMENT
      : input.intent === "region"
        ? BrowserCommentInspectionIntent.REGION
        : BrowserCommentInspectionIntent.EXISTING_TEXT;
    const point = input.intent === "existingText" ? undefined : {
      x: input.point.x / Math.max(1, input.viewport.width),
      y: input.point.y / Math.max(1, input.viewport.height)
    };
    const region = input.intent !== "region" ? undefined : {
      x: input.region.x / Math.max(1, input.viewport.width),
      y: input.region.y / Math.max(1, input.viewport.height),
      width: input.region.width / Math.max(1, input.viewport.width),
      height: input.region.height / Math.max(1, input.viewport.height)
    };
    const client = createClient(BrowserService, this.requireTransport());
    const response = await client.inspectBrowserCommentTarget({
      browserProviderId: browser.browserProviderId,
      pageId,
      takeoverId: takeover.takeoverId,
      generation: takeover.generation,
      intent,
      point,
      region,
      markerNumber: input.markerNumber
    }, this.#abort === undefined ? undefined : { signal: this.#abort.signal });
    const target = response.target === undefined ? undefined : mapBrowserCommentTarget(response.target);
    return {
      ...(target === undefined ? {} : { target }),
      ...(response.targetToken.length === 0 ? {} : { targetToken: response.targetToken })
    };
  }

  async updateBrowserCommentDesign(browserId: string, pageId: string, command: BrowserCommentDesignCommandView): Promise<readonly BrowserCommentPlacementView[]> {
    const { browser, takeover } = this.requireBrowserCommentFence(browserId, pageId);
    const action = command.action === "apply"
      ? BrowserCommentDesignAction.APPLY
      : command.action === "reset"
        ? BrowserCommentDesignAction.RESET
        : command.action === "commit"
          ? BrowserCommentDesignAction.COMMIT
          : command.action === "reconcile"
            ? BrowserCommentDesignAction.RECONCILE
            : BrowserCommentDesignAction.RESET_ALL;
    const client = createClient(BrowserService, this.requireTransport());
    const response = await client.updateBrowserCommentDesign({
      browserProviderId: browser.browserProviderId,
      pageId,
      takeoverId: takeover.takeoverId,
      generation: takeover.generation,
      action,
      targetToken: "targetToken" in command ? command.targetToken : "",
      styles: command.action === "apply"
        ? Object.entries(command.styles).map(([key, value]) => create(BrowserCommentStringEntrySchema, { key, value }))
        : [],
      ...(command.action === "apply" && Object.prototype.hasOwnProperty.call(command, "text") ? { text: command.text } : {}),
      markerNumber: command.action === "commit" ? command.markerNumber : 0,
      validMarkerNumbers: command.action === "reconcile" ? [...command.validMarkerNumbers] : []
    }, this.#abort === undefined ? undefined : { signal: this.#abort.signal });
    return response.placements.map(mapBrowserCommentPlacement).filter((placement): placement is BrowserCommentPlacementView => placement !== undefined);
  }

  async listBrowserActivity(browserId: string, pageId: string): Promise<readonly BrowserActivityView[]> {
    const client = createClient(BrowserService, this.requireTransport());
    const values: BrowserActivityView[] = [];
    const consumedTokens = new Set<string>();
    let pageToken = "";
    for (let pageIndex = 0; pageIndex < MAX_COMPLETE_MESSAGE_SEARCH_PAGES; pageIndex += 1) {
      const response = await client.listBrowserActivity(
        { browserProviderId: browserId, pageId, page: { pageSize: 500, pageToken } },
        this.#abort === undefined ? undefined : { signal: this.#abort.signal }
      );
      values.push(...response.activities.map(mapBrowserActivity));
      const nextPageToken = response.page?.nextPageToken ?? "";
      if (nextPageToken === "") return values;
      if (nextPageToken === pageToken || consumedTokens.has(nextPageToken)) {
        throw new GatewayError("Orchestrator returned a cyclic Browser activity page token.");
      }
      consumedTokens.add(nextPageToken);
      pageToken = nextPageToken;
    }
    throw new GatewayError("Browser activity exceeded the safe pagination limit.");
  }

  async listBrowserTransfers(browserId: string, pageId: string): Promise<readonly BrowserTransferView[]> {
    const client = createClient(BrowserService, this.requireTransport());
    const values: BrowserTransferView[] = [];
    const consumedTokens = new Set<string>();
    let pageToken = "";
    for (let pageIndex = 0; pageIndex < MAX_COMPLETE_MESSAGE_SEARCH_PAGES; pageIndex += 1) {
      const response = await client.listBrowserTransfers(
        { browserProviderId: browserId, pageId, page: { pageSize: 500, pageToken } },
        this.#abort === undefined ? undefined : { signal: this.#abort.signal }
      );
      values.push(...response.transfers.map(mapBrowserTransfer));
      const nextPageToken = response.page?.nextPageToken ?? "";
      if (nextPageToken === "") return values;
      if (nextPageToken === pageToken || consumedTokens.has(nextPageToken)) {
        throw new GatewayError("Orchestrator returned a cyclic Browser transfer page token.");
      }
      consumedTokens.add(nextPageToken);
      pageToken = nextPageToken;
    }
    throw new GatewayError("Browser transfers exceeded the safe pagination limit.");
  }

  async uploadBrowserFile(browserId: string, pageId: string, file: File, inputHint = "input[type=file]"): Promise<void> {
    const blob = await this.uploadAttachment(file);
    await this.submit({
      case: "uploadBrowserFile",
      value: { browserProviderId: browserId, pageId, blob, inputHint }
    }, true);
  }

  async captureBrowserScreenshot(browserId: string, pageId: string, fullPage: boolean): Promise<string> {
    const operation = await this.submit({
      case: "captureBrowserScreenshot",
      value: { browserProviderId: browserId, pageId, fullPage }
    }, true);
    const payload = operation.result?.payload;
    const blobId = payload?.case === "screenshot" ? payload.value.blob?.blobId ?? "" : "";
    if (blobId.length === 0) throw new GatewayError("Orchestrator completed the capture without an authenticated screenshot blob.");
    return blobId;
  }

  async approveResource(resourceId: string, discoveredRevision?: string): Promise<void> {
    const resource = this.#rawSnapshot?.resources.find((candidate) => candidate.resourceId === resourceId);
    const revision = discoveredRevision ?? resource?.discoveredRevision;
    if (revision === undefined || revision.length === 0) throw new GatewayError("The resource must be discovered before it can be approved.");
    await this.submit({
      case: "approveResource",
      value: { resourceId, discoveredRevision: revision }
    }, true);
  }

  async discoverProjectResources(targetId: string): Promise<void> {
    await this.submit({ case: "discoverProjectResources", value: { targetId } }, true);
  }

  async addResource(draft: ResourceDraft): Promise<void> {
    const normalized = normalizeResourceDraft(draft);
    if (normalized === undefined) throw new GatewayError("The Pi resource source is invalid.");
    const acquisition = create(ResourceAcquisitionSourceSchema, {
      source: normalized.source.kind === "local"
        ? { case: "local", value: { serverPath: normalized.source.serverPath } }
        : normalized.source.kind === "npm"
          ? { case: "npm", value: { packageName: normalized.source.packageName, versionSpec: normalized.source.versionSpec } }
          : { case: "git", value: { repositoryUrl: normalized.source.repositoryUrl, ref: normalized.source.ref, subdirectory: normalized.source.subdirectory } }
    });
    await this.submit({
      case: "addResource",
      value: {
        backendId: normalized.backendId,
        targetId: normalized.targetId ?? "",
        kind: protoResourceKind(normalized.kind),
        scope: protoResourceScope(normalized.scope),
        name: normalized.name,
        version: normalized.version,
        acquisition
      }
    }, true);
  }

  async setResourceEnabled(resourceId: string, enabled: boolean): Promise<void> {
    await this.submit({ case: "setResourceEnabled", value: { resourceId, enabled } }, true);
  }

  async removeResource(resourceId: string): Promise<void> {
    await this.submit({ case: "removeResource", value: { resourceId } }, true);
  }

  async listCommands(sessionId: string): Promise<readonly RuntimeCommandView[]> {
    const client = createClient(SessionService, this.requireTransport());
    const response = await client.listRuntimeCommands({ sessionId }, this.#abort === undefined ? undefined : { signal: this.#abort.signal });
    return response.commands.map(mapRuntimeCommand);
  }

  async listRuntimeProcesses(backendId: string, signal?: AbortSignal): Promise<RuntimeProcessUsageSnapshotView> {
    const client = createClient(BackendService, this.requireTransport());
    const response = await client.listRuntimeProcesses(
      { backendId },
      signal === undefined ? undefined : { signal }
    );
    const capturedAt = timestampMs(response.capturedAt);
    if (!Number.isSafeInteger(capturedAt) || capturedAt < 0) {
      throw new GatewayError("Orchestrator returned an invalid runtime-process capture time.");
    }
    const processes = response.processes.map((process): RuntimeProcessUsageView => {
      const generation = exactSafeUnsignedNumber(process.runtimeGeneration);
      const pid = exactSafeUnsignedNumber(process.processId);
      const memoryKb = exactSafeUnsignedNumber(process.memoryKb);
      const processCount = exactSafeUnsignedNumber(BigInt(process.processCount));
      const processInstanceId = process.processInstanceId?.trim();
      if (
        process.backendId !== backendId
        || process.sessionId.trim() === ""
        || generation === undefined
        || generation < 1
        || pid === undefined
        || pid < 1
        || memoryKb === undefined
        || processCount === undefined
        || processCount < 1
        || !Number.isFinite(process.cpuPercent)
        || process.cpuPercent < 0
        || (process.terminable && !isRuntimeProcessInstanceId(processInstanceId))
        || (!process.terminable && processInstanceId !== undefined)
      ) throw new GatewayError("Orchestrator returned an invalid runtime-process fence or metric.");
      return {
        backendId: process.backendId,
        sessionId: process.sessionId,
        generation,
        pid,
        cpuPercent: process.cpuPercent,
        memoryKb,
        processCount,
        terminable: process.terminable,
        ...(processInstanceId === undefined ? {} : { processInstanceId })
      };
    });
    return { capturedAt, processes };
  }

  async getUsageHistory(days = 140, backendId = "", providerId = "", signal?: AbortSignal): Promise<UsageHistoryView> {
    if (!Number.isInteger(days) || days < 1 || days > 366) {
      throw new GatewayError("Usage history days must be between 1 and 366.");
    }
    const client = createClient(BackendService, this.requireTransport());
    const response = await client.getUsageHistory(
      { days, backendId: backendId.trim(), providerId: providerId.trim() },
      signal === undefined ? undefined : { signal }
    );
    if (response.history === undefined) throw new GatewayError("Orchestrator returned an empty usage history.");
    return mapUsageHistory(response.history, days);
  }

  async getModelPriceOverride(
    backendId: string,
    providerId: string,
    modelId: string,
    signal?: AbortSignal
  ): Promise<ModelPriceOverrideView> {
    const model = checkedModelPriceTarget(backendId, providerId, modelId);
    const client = createClient(BackendService, this.requireTransport());
    const response = await client.getModelPriceOverride(
      model,
      signal === undefined ? undefined : { signal }
    );
    if (response.price === undefined) throw new GatewayError("Orchestrator returned an empty model price.");
    return mapModelPriceOverride(response.price, model);
  }

  async setModelPriceOverride(
    backendId: string,
    providerId: string,
    modelId: string,
    desired: ModelPriceQuoteView,
    signal?: AbortSignal
  ): Promise<ModelPriceOverrideView> {
    const model = checkedModelPriceTarget(backendId, providerId, modelId);
    const client = createClient(BackendService, this.requireTransport());
    const response = await client.setModelPriceOverride(
      { ...model, desired: protoModelPriceQuote(desired) },
      signal === undefined ? undefined : { signal }
    );
    if (response.price === undefined) throw new GatewayError("Orchestrator returned an empty model price.");
    return mapModelPriceOverride(response.price, model);
  }

  async resetModelPriceOverride(
    backendId: string,
    providerId: string,
    modelId: string,
    signal?: AbortSignal
  ): Promise<ModelPriceOverrideView> {
    const model = checkedModelPriceTarget(backendId, providerId, modelId);
    const client = createClient(BackendService, this.requireTransport());
    const response = await client.resetModelPriceOverride(
      model,
      signal === undefined ? undefined : { signal }
    );
    if (response.price === undefined) throw new GatewayError("Orchestrator returned an empty model price.");
    return mapModelPriceOverride(response.price, model);
  }

  async terminateRuntimeProcess(process: RuntimeProcessUsageView): Promise<void> {
    if (
      process.backendId.trim() === ""
      || process.sessionId.trim() === ""
      || !Number.isSafeInteger(process.generation)
      || process.generation < 1
      || !Number.isSafeInteger(process.pid)
      || process.pid < 1
      || !process.terminable
      || !isRuntimeProcessInstanceId(process.processInstanceId)
    ) throw new GatewayError("A current terminable runtime-process fence is required.");
    await this.submit({
      case: "terminateRuntimeProcess",
      value: {
        backendId: process.backendId,
        sessionId: process.sessionId,
        runtimeGeneration: BigInt(process.generation),
        processId: BigInt(process.pid),
        processInstanceId: process.processInstanceId
      }
    }, true);
  }

  async listRuntimeTools(sessionId: string): Promise<RuntimeToolCatalogView> {
    const client = createClient(ToolService, this.requireTransport());
    const response = await client.getRuntimeToolCatalog(
      { sessionId },
      this.#abort === undefined ? undefined : { signal: this.#abort.signal }
    );
    if (response.catalog === undefined) throw new GatewayError("Orchestrator returned an empty runtime tool catalog.");
    return mapRuntimeToolCatalog(response.catalog);
  }

  async listBackgroundTasks(sessionId: string): Promise<readonly BackgroundTaskHistoryView[]> {
    const client = createClient(SessionService, this.requireTransport());
    const values: BackgroundTaskHistoryView[] = [];
    const consumedTokens = new Set<string>();
    let pageToken = "";
    for (let pageIndex = 0; pageIndex < MAX_COMPLETE_MESSAGE_SEARCH_PAGES; pageIndex += 1) {
      const response = await client.listBackgroundTasks({
        sessionId,
        page: { pageSize: 500, pageToken }
      }, this.#abort === undefined ? undefined : { signal: this.#abort.signal });
      values.push(...response.backgroundTasks.map(mapBackgroundTaskHistory));
      const nextPageToken = response.page?.nextPageToken ?? "";
      if (nextPageToken === "") return values;
      if (nextPageToken === pageToken || consumedTokens.has(nextPageToken)) {
        throw new GatewayError("Orchestrator returned a cyclic background-task page token.");
      }
      consumedTokens.add(nextPageToken);
      pageToken = nextPageToken;
    }
    throw new GatewayError("Background-task history exceeded the safe pagination limit.");
  }

  async cancelBackgroundTask(sessionId: string, backgroundTaskId: string): Promise<void> {
    await this.submit({
      case: "cancelBackgroundTask",
      value: { sessionId, backgroundTaskId }
    }, true);
  }

  async listSubagentRuns(
    sessionId: string,
    state?: SubagentRunStateView,
    pageToken = "",
    pageSize = 50
  ): Promise<SubagentRunPageView> {
    const client = createClient(SubagentService, this.requireTransport());
    const response = await client.listSubagentRuns({
      sessionId,
      ...(state === undefined ? {} : { state: protoSubagentRunState(state) }),
      page: { pageSize: Math.max(1, Math.min(100, Math.floor(pageSize))), pageToken }
    }, this.#abort === undefined ? undefined : { signal: this.#abort.signal });
    return {
      runs: response.runs.map(mapSubagentRun),
      ...(response.page?.nextPageToken ? { nextPageToken: response.page.nextPageToken } : {}),
      totalSize: numberValue(response.page?.totalSize)
    };
  }

  async getSubagentRun(sessionId: string, subagentRunId: string): Promise<SubagentRunDetailView> {
    const client = createClient(SubagentService, this.requireTransport());
    const response = await client.getSubagentRun(
      { sessionId, subagentRunId },
      this.#abort === undefined ? undefined : { signal: this.#abort.signal }
    );
    if (response.run === undefined) throw new GatewayError("Orchestrator returned no delegated-run detail.");
    return mapSubagentRunDetail(response.run);
  }

  async listSubagentTranscript(
    sessionId: string,
    subagentRunId: string,
    childId = "",
    pageToken = "",
    pageSize = 100
  ): Promise<SubagentTranscriptPageView> {
    const client = createClient(SubagentService, this.requireTransport());
    const response = await client.listSubagentTranscript({
      sessionId,
      subagentRunId,
      childId,
      page: { pageSize: Math.max(1, Math.min(200, Math.floor(pageSize))), pageToken }
    }, this.#abort === undefined ? undefined : { signal: this.#abort.signal });
    return {
      entries: response.entries.map(mapSubagentTranscriptEntry),
      ...(response.page?.nextPageToken ? { nextPageToken: response.page.nextPageToken } : {}),
      ...(response.tailPageToken.length === 0 ? {} : { tailPageToken: response.tailPageToken }),
      totalSize: numberValue(response.page?.totalSize)
    };
  }

  async controlSubagent(
    sessionId: string,
    subagentRunId: string,
    action: SubagentControlActionView,
    message = "",
    childId = ""
  ): Promise<void> {
    const normalized = message.trim();
    if (action === "stop" && normalized.length > 0) throw new GatewayError("Stop does not accept a delegated-run message.");
    if (action !== "stop" && (normalized.length === 0 || normalized.length > 32_000)) {
      throw new GatewayError("Delegated-run control messages must contain 1..32000 characters.");
    }
    await this.submit({
      case: "controlSubagent",
      value: {
        sessionId,
        subagentRunId,
        childId,
        action: protoSubagentControlAction(action),
        message: normalized
      }
    }, true);
  }

  async searchSessionMessages(query: string, pageToken = "", pageSize = 100, scope: SessionMessageSearchScopeView = { kind: "owner" }, filters?: SessionMessageSearchFiltersView): Promise<SessionMessageSearchPageView> {
    const value = query.trim();
    if (value.length === 0) return { matches: [], totalSize: 0, revision: this.#snapshot?.revision ?? 0n, vectorUsed: false, poolCapped: false };
    return loadSessionMessageSearchPage(
      this.requireTransport(),
      value,
      pageToken,
      pageSize,
      scope,
      "hybrid",
      normalizeSessionMessageSearchFilters(filters),
      this.#abort?.signal
    );
  }

  async searchAllSessionMessages(query: string, options: SessionMessageSearchCollectionOptions = {}): Promise<SessionMessageSearchResultView> {
    const value = query.trim();
    const connectionSignal = this.#abort?.signal;
    const signal = combinedAbortSignal(connectionSignal, options.signal);
    throwIfAborted(signal);
    if (value.length === 0) return { matches: [], totalSize: 0, revision: this.#snapshot?.revision ?? 0n, vectorUsed: false, poolCapped: false };

    // Capture the transport once. A reconnect must cancel this collection
    // instead of letting later pages silently come from a different Orchestrator.
    const transport = this.requireTransport();
    const scope = options.scope ?? { kind: "owner" };
    const filters = normalizeSessionMessageSearchFilters(options.filters);
    const pageSize = options.pageSize ?? 100;
    searchAttempts:
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const matches: SessionMessageSearchMatchView[] = [];
      const matchIds = new Set<string>();
      const consumedTokens = new Set<string>();
      let pageToken = "";
      let revision: bigint | undefined;
      let totalSize: number | undefined;
      let vectorUsed: boolean | undefined;
      let vectorSkipReason: string | undefined;
      let poolCapped = false;

      for (let pageNumber = 0; pageNumber < MAX_COMPLETE_MESSAGE_SEARCH_PAGES; pageNumber += 1) {
        throwIfAborted(signal);
        if (this.#transport !== transport) throw abortedGatewayRequest();
        if (pageToken !== "") {
          if (consumedTokens.has(pageToken)) {
            throw new GatewayError("Orchestrator returned a cyclic message-search page token.");
          }
          consumedTokens.add(pageToken);
        }

        let page: SessionMessageSearchPageView;
        try {
          page = await loadSessionMessageSearchPage(
            transport,
            value,
            pageToken,
            pageSize,
            scope,
            options.semanticMode ?? "hybrid",
            filters,
            signal
          );
        } catch (error) {
          throwIfAborted(signal);
          if (this.#transport !== transport) throw abortedGatewayRequest();
          if (!isMessageSearchRevisionDriftError(error)) throw error;
          if (attempt === 0) continue searchAttempts;
          throw new GatewayError(
            "Message-search results changed while pages were loading after retrying from the first page.",
            { cause: error }
          );
        }
        throwIfAborted(signal);
        if (this.#transport !== transport) throw abortedGatewayRequest();

        if (revision === undefined) revision = page.revision;
        else if (page.revision !== revision) {
          if (attempt === 0) continue searchAttempts;
          throw new GatewayError("Message-search results changed while pages were loading after retrying from the first page.");
        }
        if (totalSize === undefined) totalSize = page.totalSize;
        else if (page.totalSize !== totalSize) {
          throw new GatewayError("Orchestrator returned an inconsistent message-search result size.");
        }
        if (vectorUsed === undefined) {
          vectorUsed = page.vectorUsed;
          vectorSkipReason = page.vectorSkipReason;
        } else if (page.vectorUsed !== vectorUsed || page.vectorSkipReason !== vectorSkipReason) {
          throw new GatewayError("Orchestrator returned inconsistent message-search retrieval provenance.");
        }
        poolCapped ||= page.poolCapped;

        for (const match of page.matches) {
          const identity = messageSearchMatchIdentity(match);
          if (matchIds.has(identity)) continue;
          matchIds.add(identity);
          matches.push(match);
        }

        const nextPageToken = page.nextPageToken;
        if (nextPageToken === undefined || nextPageToken === "") {
          return {
            matches,
            totalSize: totalSize ?? 0,
            revision: revision ?? 0n,
            vectorUsed: vectorUsed ?? false,
            ...(vectorSkipReason === undefined ? {} : { vectorSkipReason }),
            poolCapped
          };
        }
        if (nextPageToken === pageToken || consumedTokens.has(nextPageToken)) {
          throw new GatewayError("Orchestrator returned a cyclic message-search page token.");
        }
        pageToken = nextPageToken;
      }

      throw new GatewayError("Message search exceeded the safe pagination limit.");
    }

    throw new GatewayError("Message-search results changed while pages were loading after retrying from the first page.");
  }

  async loadSessionTimelineAround(sessionId: string, eventId: string, limit = 160): Promise<readonly TimelineItemView[]> {
    const client = createClient(SessionService, this.requireTransport());
    const response = await client.listSessionTimeline({
      sessionId,
      aroundEventId: eventId,
      limit: Math.min(Math.max(Math.trunc(limit), 1), 500)
    }, this.#abort === undefined ? undefined : { signal: this.#abort.signal });
    return buildTimeline(response.events).get(sessionId) ?? [];
  }

  async loadSessionTimelinePage(sessionId: string, beforeCursor?: TimelineHistoryCursorView, limit = 200): Promise<TimelineHistoryPageView> {
    const client = createClient(SessionService, this.requireTransport());
    const response = await client.listSessionTimeline({
      sessionId,
      ...(beforeCursor === undefined ? {} : {
        beforeCursor: create(EventCursorSchema, {
          opaqueToken: beforeCursor.opaqueToken,
          sequence: beforeCursor.sequence,
          generation: beforeCursor.generation
        })
      }),
      limit: Math.min(Math.max(Math.trunc(limit), 1), 500)
    }, this.#abort === undefined ? undefined : { signal: this.#abort.signal });
    return {
      items: buildTimeline(response.events).get(sessionId) ?? [],
      ...(response.nextBeforeCursor === undefined ? {} : {
        nextBeforeCursor: {
          opaqueToken: response.nextBeforeCursor.opaqueToken,
          sequence: response.nextBeforeCursor.sequence,
          generation: response.nextBeforeCursor.generation
        }
      })
    };
  }

  async getSchedulerRuntime(signal?: AbortSignal): Promise<SchedulerRuntimeView> {
    const client = createClient(SchedulerService, this.requireTransport());
    const combinedSignal = combinedAbortSignal(this.#abort?.signal, signal);
    const response = await client.getSchedulerRuntime({}, combinedSignal === undefined ? undefined : { signal: combinedSignal });
    if (response.runtime === undefined) throw new GatewayError("Orchestrator returned no scheduler runtime snapshot.");
    return mapSchedulerRuntime(response.runtime);
  }

  async listWorkspaceEntries(
    workspaceId: string,
    parentPath: string,
    options?: WorkspaceEntryListingOptionsView
  ): Promise<readonly WorkspaceEntryView[]> {
    const values: WorkspaceEntryView[] = [];
    const consumed = new Set<string>();
    let pageToken: string | undefined;
    let revision: string | undefined;
    for (let pageNumber = 0; pageNumber < 10_000; pageNumber += 1) {
      const page = await this.listWorkspaceEntryPage(workspaceId, parentPath, pageToken, 500, options);
      if (revision === undefined) revision = page.revision;
      else if (page.revision !== revision) throw new GatewayError("Workspace entries changed while the directory was loading.", { code: "WORKSPACE_ENTRY_RESULT_CHANGED" });
      values.push(...page.entries);
      pageToken = page.nextPageToken;
      if (pageToken === undefined) return values;
      if (consumed.has(pageToken)) throw new GatewayError("Orchestrator returned a cyclic workspace-entry page token.");
      consumed.add(pageToken);
    }
    throw new GatewayError("Workspace directory exceeded the supported page count.");
  }

  async listWorkspaceEntryPage(
    workspaceId: string,
    parentPath: string,
    pageToken = "",
    pageSize = 500,
    options?: WorkspaceEntryListingOptionsView
  ): Promise<WorkspaceEntryPageView> {
    const client = createClient(WorkspaceService, this.requireTransport());
    const response = await client.listWorkspaceEntries({
      workspaceId,
      parentRelativePath: parentPath,
      includeHidden: options?.includeHidden ?? false,
      listingPolicy: protoWorkspaceEntryListingPolicy(options?.policy),
      page: { pageSize: Math.min(Math.max(Math.trunc(pageSize), 1), 500), pageToken }
    }, this.#abort === undefined ? undefined : { signal: this.#abort.signal });
    const workspace = this.#rawSnapshot?.workspaces.find((candidate) => candidate.workspaceId === workspaceId);
    const statuses = workspaceStatusMap(workspace);
    return {
      entries: response.entries.map((entry) => mapWorkspaceEntry(entry, statuses)),
      ...(response.page?.nextPageToken ? { nextPageToken: response.page.nextPageToken } : {}),
      totalSize: numberValue(response.page?.totalSize),
      revision: response.revision?.etag || response.revision?.value.toString(10) || "0"
    };
  }

  async listWorkspaceFiles(workspaceId: string, signal?: AbortSignal): Promise<WorkspaceFileIndexView> {
    const combinedSignal = combinedAbortSignal(this.#abort?.signal, signal);
    throwIfAborted(combinedSignal);
    const client = createClient(WorkspaceService, this.requireTransport());
    const response = await client.listWorkspaceFiles(
      { workspaceId },
      combinedSignal === undefined ? undefined : { signal: combinedSignal }
    );
    throwIfAborted(combinedSignal);
    if (response.relativePaths.length > 30_000) {
      throw new GatewayError("Orchestrator returned an oversized workspace file index.");
    }
    const paths = response.relativePaths.map(workspaceFileChangeRelativePath);
    if (new Set(paths).size !== paths.length) {
      throw new GatewayError("Orchestrator returned duplicate workspace file-index paths.");
    }
    const revision = response.revision?.etag || response.revision?.value.toString(10) || "";
    if (revision === "") throw new GatewayError("Orchestrator returned an unfenced workspace file index.");
    return { paths, truncated: response.truncated, revision };
  }

  async *watchWorkspaceFileChanges(
    scope: WorkspaceFileChangeScopeView,
    signal?: AbortSignal
  ): AsyncGenerator<WorkspaceFileChangeView> {
    const combinedSignal = combinedAbortSignal(this.#abort?.signal, signal);
    throwIfAborted(combinedSignal);
    const client = createClient(WorkspaceService, this.requireTransport());
    const stream = client.watchWorkspaceFileChanges({
      scope: scope.kind === "owner"
        ? { kind: { case: "owner", value: {} } }
        : { kind: { case: "workspace", value: { workspaceId: scope.workspaceId } } }
    }, combinedSignal === undefined ? undefined : { signal: combinedSignal });
    let previousSequence = 0n;
    for await (const response of stream) {
      throwIfAborted(combinedSignal);
      if (response.change === undefined) throw new GatewayError("Orchestrator returned an empty workspace file change.");
      const change = mapWorkspaceFileChange(response.change);
      if (scope.kind === "workspace" && change.workspaceId !== scope.workspaceId) {
        throw new GatewayError("Orchestrator returned a workspace file change outside the requested scope.");
      }
      if (change.sequence <= previousSequence) {
        throw new GatewayError("Orchestrator returned an out-of-order workspace file change stream.");
      }
      previousSequence = change.sequence;
      yield change;
    }
  }

  async readWorkspaceFile(workspaceId: string, path: string): Promise<WorkspaceFilePreviewView> {
    const client = createClient(WorkspaceService, this.requireTransport());
    const response = await client.readWorkspaceFile({
      workspaceId,
      relativePath: path,
      startByte: 0n,
      maximumBytes: 2_097_152n
    }, this.#abort === undefined ? undefined : { signal: this.#abort.signal });
    if (response.preview === undefined) throw new GatewayError("Orchestrator returned no file preview.");
    return mapFilePreview(response.preview);
  }

  async writeWorkspaceTextFile(
    workspaceId: string,
    draft: WorkspaceTextFileWriteDraft
  ): Promise<WorkspaceTextFileWriteResultView> {
    const client = createClient(WorkspaceService, this.requireTransport());
    const response = await client.writeWorkspaceTextFile({
      workspaceId,
      relativePath: draft.path,
      utf8Text: draft.text,
      expectedRevision: { opaqueRevision: draft.expectedRevision }
    }, this.#abort === undefined ? undefined : { signal: this.#abort.signal });
    const entry = response.entry;
    const revision = response.newRevision?.opaqueRevision ?? entry?.revision?.opaqueRevision ?? "";
    if (entry === undefined || revision === "") {
      throw new GatewayError("Orchestrator returned no saved workspace file revision.");
    }
    return {
      path: entry.relativePath,
      name: entry.displayName || entry.relativePath.split("/").at(-1) || entry.relativePath,
      revision
    };
  }

  async searchWorkspace(workspaceId: string, query: string): Promise<readonly WorkspaceSearchMatchView[]> {
    const matches: WorkspaceSearchMatchView[] = [];
    const consumedTokens = new Set<string>();
    let pageToken: string | undefined;
    for (let pageIndex = 0; pageIndex < MAX_COMPLETE_MESSAGE_SEARCH_PAGES; pageIndex += 1) {
      const page = await this.searchWorkspacePage(workspaceId, {
        query,
        caseSensitive: false,
        regularExpression: false,
        pageSize: 500,
        ...(pageToken === undefined ? {} : { pageToken })
      });
      matches.push(...page.matches);
      const nextPageToken = page.nextPageToken;
      if (nextPageToken === undefined) {
        if (page.truncated) throw new GatewayError("Workspace search was truncated before every match could be returned.");
        return matches;
      }
      if (nextPageToken === pageToken || consumedTokens.has(nextPageToken)) {
        throw new GatewayError("Orchestrator returned a cyclic Workspace search page token.");
      }
      consumedTokens.add(nextPageToken);
      pageToken = nextPageToken;
    }
    throw new GatewayError("Workspace search exceeded the safe pagination limit.");
  }

  async searchWorkspacePage(
    workspaceId: string,
    request: WorkspaceSearchRequestView,
    signal?: AbortSignal
  ): Promise<WorkspaceSearchPageView> {
    const token = decodeWorkspaceSearchPageToken(request.pageToken);
    const combinedSignal = combinedAbortSignal(this.#abort?.signal, signal);
    throwIfAborted(combinedSignal);
    const client = createClient(WorkspaceService, this.requireTransport());
    const response = await client.searchWorkspace({
      workspaceId,
      query: request.query,
      relativePathPrefix: "",
      caseSensitive: request.caseSensitive,
      regularExpression: request.regularExpression,
      page: {
        pageSize: Math.min(Math.max(Math.trunc(request.pageSize ?? 100), 1), 500),
        pageToken: token.serverToken
      }
    }, combinedSignal === undefined ? undefined : { signal: combinedSignal });
    throwIfAborted(combinedSignal);
    const revision = response.revision?.etag || response.revision?.value.toString(10) || "0";
    if (token.expectedRevision !== undefined && revision !== token.expectedRevision) {
      throw new GatewayError("Workspace search results changed while pages were loading.", { code: "WORKSPACE_SEARCH_RESULT_CHANGED" });
    }
    const matches = response.matches.map((match) => mapWorkspaceSearchMatch(match, request.pageToken));
    return {
      matches,
      ...(response.page?.nextPageToken
        ? { nextPageToken: encodeWorkspaceSearchPageToken(response.page.nextPageToken, revision) }
        : {}),
      truncated: response.truncated,
      totalMatches: numberValue(response.page?.totalSize) || matches.length,
      totalFiles: numberValue(response.totalFiles),
      revision
    };
  }

  async *streamWorkspaceSearch(
    workspaceId: string,
    query: string,
    caseSensitive: boolean,
    signal?: AbortSignal
  ): AsyncGenerator<WorkspaceSearchStreamEventView> {
    const combinedSignal = combinedAbortSignal(this.#abort?.signal, signal);
    throwIfAborted(combinedSignal);
    const client = createClient(WorkspaceService, this.requireTransport());
    const stream = client.streamWorkspaceSearch(
      { workspaceId, query, caseSensitive },
      combinedSignal === undefined ? undefined : { signal: combinedSignal }
    );
    let ended = false;
    let matchCount = 0;
    const matchedPaths = new Set<string>();
    for await (const response of stream) {
      throwIfAborted(combinedSignal);
      if (ended) throw new GatewayError("Orchestrator emitted workspace-search data after its terminal event.");
      if (response.event.case === "match") {
        const match = mapWorkspaceSearchMatch(response.event.value);
        matchCount += 1;
        if (matchCount > 1_000) throw new GatewayError("Orchestrator exceeded the workspace-search result ceiling.");
        matchedPaths.add(match.path);
        yield { kind: "match", match };
        continue;
      }
      if (response.event.case === "end") {
        const revision = response.event.value.revision?.etag
          || response.event.value.revision?.value.toString(10)
          || "";
        if (revision === "") throw new GatewayError("Orchestrator returned an unfenced workspace-search terminal event.");
        const totalMatches = numberValue(response.event.value.totalMatches);
        const totalFiles = numberValue(response.event.value.totalFiles);
        if (totalMatches !== matchCount || totalFiles !== matchedPaths.size) {
          throw new GatewayError("Orchestrator returned inconsistent workspace-search terminal totals.");
        }
        ended = true;
        yield {
          kind: "end",
          truncated: response.event.value.truncated,
          totalMatches,
          totalFiles,
          revision
        };
        continue;
      }
      if (response.event.case === "error") {
        const failure = mapWorkspaceSearchFailure(response.event.value.code, response.event.value.message);
        ended = true;
        yield { kind: "error", ...failure };
        continue;
      }
      throw new GatewayError("Orchestrator returned an empty workspace-search stream event.");
    }
    throwIfAborted(combinedSignal);
    if (!ended) throw new GatewayError("Orchestrator closed workspace search without a terminal event.");
  }

  async createWorkspaceEntry(draft: WorkspaceEntryMutationDraft): Promise<void> {
    await this.submit({
      case: "createWorkspaceEntry",
      value: {
        workspaceId: draft.workspaceId,
        relativePath: draft.path,
        kind: draft.kind === "directory" ? WorkspaceEntryCreateKind.DIRECTORY : WorkspaceEntryCreateKind.FILE,
        expectedRevision: workspaceEntryAbsentRevision
      }
    }, true);
  }

  async moveWorkspaceEntry(draft: WorkspaceEntryMoveDraft): Promise<void> {
    await this.submit({ case: "moveWorkspaceEntry", value: {
      workspaceId: draft.workspaceId,
      sourceRelativePath: draft.sourcePath,
      destinationRelativePath: draft.destinationPath,
      expectedRevision: draft.expectedRevision
    } }, true);
  }

  async deleteWorkspaceEntry(draft: WorkspaceEntryDeleteDraft): Promise<void> {
    await this.submit({ case: "deleteWorkspaceEntry", value: {
      workspaceId: draft.workspaceId,
      relativePath: draft.path,
      expectedRevision: draft.expectedRevision,
      confirmRecursive: draft.confirmRecursive
    } }, true);
  }

  async copyWorkspaceEntry(draft: WorkspaceEntryMoveDraft): Promise<void> {
    await this.submit({ case: "copyWorkspaceEntry", value: {
      workspaceId: draft.workspaceId,
      sourceRelativePath: draft.sourcePath,
      destinationRelativePath: draft.destinationPath,
      expectedRevision: draft.expectedRevision
    } }, true);
  }

  async getWorkspaceDiff(workspaceId: string, query: WorkspaceDiffQuery = {}): Promise<WorkspaceDiffView> {
    const client = createClient(WorkspaceService, this.requireTransport());
    const source = query.source === undefined ? GitDiffSource.UNSPECIFIED : protoWorkspaceReviewSource(query.source);
    const response = await client.getWorkspaceDiff({
      workspaceId,
      relativePaths: [...(query.paths ?? [])],
      ignoreWhitespace: query.ignoreWhitespace === true,
      source,
      sourceRevision: query.sourceRevision ?? "",
      expectedRepositoryRevision: query.expectedRepositoryRevision ?? "",
      expectedMergeBaseRevision: query.expectedMergeBaseRevision ?? ""
    }, this.#abort === undefined ? undefined : { signal: this.#abort.signal });
    if (response.diff === undefined) throw new GatewayError("Orchestrator returned no workspace diff.");
    const mapped = mapWorkspaceDiff(response.diff);
    if (query.source !== undefined && mapped.source !== query.source) {
      throw new GatewayError("Orchestrator returned a different Review source than requested.");
    }
    return mapped;
  }

  async readWorkspaceDiffFile(workspaceId: string, file: WorkspaceFileDiffView, diff: WorkspaceDiffView): Promise<WorkspaceFilePreviewView> {
    const source = protoWorkspaceFileSource(file.source);
    const client = createClient(WorkspaceService, this.requireTransport());
    const response = await client.readWorkspaceDiffFile({
      workspaceId,
      relativePath: file.path,
      source,
      expectedRepositoryRevision: diff.repositoryRevision,
      maximumBytes: 1_048_576n,
      sourceRevision: diff.sourceRevision ?? "",
      expectedMergeBaseRevision: diff.mergeBaseRevision ?? ""
    }, this.#abort === undefined ? undefined : { signal: this.#abort.signal });
    if (response.text === undefined) throw new GatewayError("Orchestrator returned no diff file preview.");
    assertWorkspaceDiffReadFence(diff, response.repositoryRevision, response.mergeBaseRevision);
    return {
      path: file.path,
      name: file.path.split("/").at(-1) ?? file.path,
      kind: "text",
      text: response.text.utf8Text,
      language: response.text.languageId,
      truncated: response.truncated
    };
  }

  async readWorkspaceDiffImage(workspaceId: string, file: WorkspaceFileDiffView, diff: WorkspaceDiffView): Promise<WorkspaceDiffImageView> {
    const source = protoWorkspaceFileSource(file.source);
    const client = createClient(WorkspaceService, this.requireTransport());
    const response = await client.readWorkspaceDiffImage({
      workspaceId,
      relativePath: file.path,
      oldRelativePath: file.oldPath ?? "",
      source,
      expectedRepositoryRevision: diff.repositoryRevision,
      sourceRevision: diff.sourceRevision ?? "",
      expectedMergeBaseRevision: diff.mergeBaseRevision ?? ""
    }, this.#abort === undefined ? undefined : { signal: this.#abort.signal });
    assertWorkspaceDiffReadFence(diff, response.repositoryRevision, response.mergeBaseRevision);
    return {
      oldImage: mapWorkspaceDiffImageSide(response.oldImage),
      newImage: mapWorkspaceDiffImageSide(response.newImage),
      repositoryRevision: response.repositoryRevision,
      ...(response.mergeBaseRevision === "" ? {} : { mergeBaseRevision: response.mergeBaseRevision }),
      maximumBytes: Number(response.maximumBytes)
    };
  }

  async applyWorkspaceDiffHunk(workspaceId: string, draft: WorkspaceDiffHunkMutationDraft): Promise<void> {
    await this.submit({
      case: "applyWorkspaceDiffHunk",
      value: {
        workspaceId,
        action: draft.action === "stage"
          ? WorkspaceDiffAction.STAGE
          : draft.action === "unstage" ? WorkspaceDiffAction.UNSTAGE : WorkspaceDiffAction.REVERT,
        source: draft.source === "staged" ? GitDiffSource.STAGED : GitDiffSource.UNSTAGED,
        relativePath: draft.path,
        oldRelativePath: draft.oldPath ?? "",
        hunkIndex: draft.hunkIndex ?? 0,
        expectedRepositoryRevision: draft.expectedRepositoryRevision,
        ignoreWhitespace: draft.ignoreWhitespace,
        confirmRevert: draft.confirmRevert,
        target: draft.target === "file" ? WorkspaceDiffTarget.FILE : WorkspaceDiffTarget.HUNK
      }
    }, true);
  }

  async commitWorkspaceDiff(workspaceId: string, draft: WorkspaceGitCommitDraft): Promise<void> {
    await this.submit({
      case: "commitWorkspaceDiff",
      value: {
        workspaceId,
        message: draft.message,
        expectedRepositoryRevision: draft.expectedRepositoryRevision,
        includeUnstaged: draft.includeUnstaged
      }
    }, true);
  }

  async pushWorkspaceBranch(workspaceId: string, draft: WorkspaceGitPushDraft): Promise<WorkspaceGitPushResultView> {
    const operation = await this.submit({
      case: "pushWorkspaceBranch",
      value: {
        workspaceId,
        remote: draft.remote,
        remoteRef: draft.remoteRef,
        expectedRepositoryRevision: draft.expectedRepositoryRevision,
        expectedHeadRevision: draft.expectedHeadRevision,
        confirmForceWithLease: draft.confirmForceWithLease,
        expectedRemoteOid: draft.expectedRemoteOid ?? ""
      }
    }, true);
    const payload = operation.result?.payload;
    if (payload?.case !== "workspaceGitPush") {
      throw new GatewayError("Orchestrator completed Git push without a typed outcome.");
    }
    const result = payload.value;
    const outcome = result.outcome === WorkspaceGitPushOutcome.PUSHED
      ? "pushed"
      : result.outcome === WorkspaceGitPushOutcome.NEEDS_FORCE ? "needsForce" : undefined;
    if (outcome === undefined) throw new GatewayError("Orchestrator returned an unknown Git push outcome.");
    if (outcome === "needsForce" && result.remoteOid === "") {
      throw new GatewayError("Orchestrator omitted the remote lease revision required for confirmation.");
    }
    return {
      outcome,
      remote: result.remote,
      remoteRef: result.remoteRef,
      ...(result.remoteOid === "" ? {} : { remoteOid: result.remoteOid }),
      ahead: result.ahead,
      behind: result.behind,
      repositoryRevision: result.repositoryRevision,
      headRevision: result.headRevision
    };
  }

  async listWorkspaceChangeSets(workspaceId: string, sessionId: string): Promise<readonly WorkspaceChangeSetView[]> {
    const client = createClient(WorkspaceService, this.requireTransport());
    const values: WorkspaceChangeSetView[] = [];
    const consumedTokens = new Set<string>();
    let pageToken = "";
    for (let pageIndex = 0; pageIndex < MAX_COMPLETE_MESSAGE_SEARCH_PAGES; pageIndex += 1) {
      const response = await client.listWorkspaceChangeSets({
        workspaceId,
        sessionId,
        page: { pageSize: 500, pageToken }
      }, this.#abort === undefined ? undefined : { signal: this.#abort.signal });
      values.push(...response.changeSets.map(mapWorkspaceChangeSet));
      const nextPageToken = response.page?.nextPageToken ?? "";
      if (nextPageToken === "") return values;
      if (nextPageToken === pageToken || consumedTokens.has(nextPageToken)) {
        throw new GatewayError("Orchestrator returned a cyclic Workspace change-set page token.");
      }
      consumedTokens.add(nextPageToken);
      pageToken = nextPageToken;
    }
    throw new GatewayError("Workspace change-set history exceeded the safe pagination limit.");
  }

  async previewWorkspaceRewind(workspaceId: string, changeSetId: string): Promise<WorkspaceRewindPreviewView> {
    const client = createClient(WorkspaceService, this.requireTransport());
    const response = await client.previewWorkspaceRewind({ workspaceId, changeSetId }, this.#abort === undefined ? undefined : { signal: this.#abort.signal });
    if (response.preview === undefined) throw new GatewayError("Orchestrator returned no rewind preview.");
    return mapWorkspaceRewindPreview(response.preview);
  }

  async executeWorkspaceRewind(workspaceId: string, previewId: string, changeSetId: string, dialogueOnly: boolean): Promise<void> {
    await this.submit({
      case: "executeWorkspaceRewind",
      value: {
        workspaceId,
        previewId,
        changeSetId,
        confirmFileRestore: !dialogueOnly,
        allowDialogueOnly: dialogueOnly
      }
    }, true);
  }

  async restartBackend(backendId: string): Promise<void> {
    await this.submit({ case: "restartBackend", value: { backendId } }, true);
  }

  async updateBackendSettings(backendId: string, patch: BackendSettingsUpdate): Promise<void> {
    if (patch.defaultModel !== undefined && patch.clearDefaultModel === true) {
      throw new GatewayError("A Backend default model cannot be set and cleared in the same update.");
    }
    if (patch.modelAccessUpdate !== undefined && (
      patch.enabled !== undefined
      || patch.permissionMode !== undefined
      || patch.planMode !== undefined
      || patch.defaultModel !== undefined
      || patch.clearDefaultModel === true
    )) {
      throw new GatewayError("A model access update must be submitted on its own.");
    }
    await this.submit({
      case: "updateBackendSettings",
      value: {
        patch: {
          backendId,
          ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
          ...(patch.permissionMode === undefined ? {} : { defaultPermissionMode: protoPermission(patch.permissionMode) }),
          ...(patch.planMode === undefined ? {} : { defaultPlanMode: patch.planMode }),
          ...(patch.defaultModel === undefined ? {} : {
            defaultModel: {
              model: {
                providerId: patch.defaultModel.providerId,
                modelId: patch.defaultModel.modelId
              },
              effortId: patch.defaultModel.effort ?? "",
              fastMode: patch.defaultModel.fastMode
            }
          }),
          clearDefaultModel: patch.clearDefaultModel === true,
          ...(patch.modelAccessUpdate === undefined ? {} : {
            modelAccessUpdate: {
              providerId: patch.modelAccessUpdate.providerId,
              modelId: patch.modelAccessUpdate.modelId,
              enabled: patch.modelAccessUpdate.enabled
            }
          })
        }
      }
    }, true);
  }

  async revokeDevice(deviceId: string): Promise<void> {
    await this.submit({ case: "revokeDevice", value: { deviceId, reason: "Revoked by owner" } }, true);
  }

  async renameDevice(deviceId: string, name: string): Promise<void> {
    const displayName = name.trim();
    if (displayName.length === 0) throw new GatewayError("A device name is required.");
    await this.submit({ case: "renameDevice", value: { deviceId, displayName } }, true);
  }

  async setDeviceRemoteControlEnabled(enabled: boolean): Promise<void> {
    await this.submit({ case: "setDeviceRemoteControlEnabled", value: { enabled } }, true);
  }

  async setDeviceControlTargetEnabled(targetDeviceId: string, enabled: boolean): Promise<void> {
    await this.submit({ case: "setDeviceControlTargetEnabled", value: { targetDeviceId, enabled } }, true);
  }

  async setDeviceControllerAllowed(controllerDeviceId: string, allowed: boolean): Promise<void> {
    await this.submit({ case: "setDeviceControllerAllowed", value: { controllerDeviceId, allowed } }, true);
  }

  async logoutConnection(connectionId: string): Promise<void> {
    await this.submit({ case: "logoutConnection", value: { connectionId } }, true);
  }

  async saveProvider(draft: ProviderDraft): Promise<void> {
    const existing = this.#rawSnapshot?.settings?.providers.find((provider) => provider.providerId === draft.id);
    if (draft.models.length === 0) throw new GatewayError("A provider must declare at least one model.");
    const headers = draft.headers.map((header) => ({
      headerName: header.headerName.trim(),
      environmentName: header.environmentName.trim(),
      credentialReferenceId: header.credentialId
    }));
    if (headers.some((header) => header.headerName.length === 0 || (header.environmentName.length === 0 && header.credentialReferenceId.length === 0))) {
      throw new GatewayError("Each provider header needs a name and an environment or credential binding.");
    }
    const models = draft.models.map((model) => ({
      modelId: model.modelId.trim(),
      displayName: model.name.trim(),
      ...(model.compatibility === undefined ? {} : { apiCompatibility: protoProviderCompatibility(model.compatibility) }),
      reasoning: model.reasoning,
      inputModalities: model.inputModalities.map(protoInputModality),
      contextWindowTokens: safeUnsignedBigInt(model.contextWindowTokens),
      maximumOutputTokens: safeUnsignedBigInt(model.maximumOutputTokens),
      inputCostMicrosPerMillion: safeSignedBigInt(model.inputCostMicrosPerMillion),
      outputCostMicrosPerMillion: safeSignedBigInt(model.outputCostMicrosPerMillion),
      cacheReadCostMicrosPerMillion: safeSignedBigInt(model.cacheReadCostMicrosPerMillion),
      cacheWriteCostMicrosPerMillion: safeSignedBigInt(model.cacheWriteCostMicrosPerMillion),
      thinkingLevels: model.thinkingLevels
        .filter((level) => level.effortId.trim().length > 0)
        .map((level) => ({ effortId: level.effortId.trim(), ...(level.nativeLevel?.trim() ? { nativeLevel: level.nativeLevel.trim() } : {}) })),
      ...(model.sampling === undefined ? {} : { sampling: {
        ...(model.sampling.temperature === undefined ? {} : { temperature: model.sampling.temperature }),
        ...(model.sampling.topP === undefined ? {} : { topP: model.sampling.topP }),
        ...(model.sampling.topK === undefined ? {} : { topK: model.sampling.topK }),
        ...(model.sampling.minP === undefined ? {} : { minP: model.sampling.minP }),
        ...(model.sampling.repetitionPenalty === undefined ? {} : { repetitionPenalty: model.sampling.repetitionPenalty }),
        ...(model.sampling.frequencyPenalty === undefined ? {} : { frequencyPenalty: model.sampling.frequencyPenalty }),
        ...(model.sampling.presencePenalty === undefined ? {} : { presencePenalty: model.sampling.presencePenalty }),
        ...(model.sampling.seed === undefined ? {} : { seed: safeUnsignedBigInt(model.sampling.seed) })
      } }),
      ...(model.compatibilityOptions === undefined ? {} : { compatibility: { ...model.compatibilityOptions } }),
      supportsFastMode: model.supportsFastMode,
      ...(model.defaultVisible === undefined ? {} : { defaultVisible: model.defaultVisible })
    }));
    if (models.some((model) => model.modelId.length === 0 || model.displayName.length === 0 || model.inputModalities.length === 0 || model.contextWindowTokens <= 0n || model.maximumOutputTokens <= 0n)) {
      throw new GatewayError("Every model needs an ID, name, input modality, context window, and maximum output size.");
    }
    if (new Set(models.map((model) => model.modelId)).size !== models.length) throw new GatewayError("Model IDs must be unique within a provider.");
    const provider = existing === undefined
      ? create(ProviderConfigurationSchema)
      : create(ProviderConfigurationSchema, existing);
    provider.providerId = draft.id.trim();
    provider.displayName = draft.name.trim();
    provider.kind = protoProviderKind(draft.kind);
    provider.apiCompatibility = protoProviderCompatibility(draft.compatibility);
    provider.endpoint = canonicalProviderEndpoint(draft.endpoint);
    provider.credentialReferenceId = draft.credentialId;
    provider.enabled = draft.enabled;
    provider.apiKeyEnvironment = draft.environmentName.trim();
    provider.keyless = draft.keyless;
    provider.authHeader = draft.authHeader;
    provider.headers = headers.map((header) => create(ProviderHeaderConfigurationSchema, header));
    provider.models = models.map((model) => create(ProviderModelConfigurationSchema, model));
    if (provider.providerId.length === 0 || provider.displayName.length === 0) throw new GatewayError("Provider ID and name are required.");
    await this.submit({ case: "upsertProvider", value: { provider } }, true);
  }

  async deleteProvider(providerId: string): Promise<void> {
    await this.submit({ case: "deleteProvider", value: { providerId } }, true);
  }

  async refreshProviderModels(backendId: string, providerId?: string, automatic = false): Promise<void> {
    await this.submit({
      case: "refreshProviderModels",
      value: { backendId, providerId: providerId ?? "", automatic }
    }, true);
    await this.refresh();
  }

  async refreshManagedModelRuntimes(signal?: AbortSignal): Promise<readonly ManagedModelRuntimeView[]> {
    const values = await loadManagedModelRuntimes(this.requireTransport(), signal ?? this.#abort?.signal);
    if (this.#snapshot !== undefined) {
      const snapshot = { ...this.#snapshot, managedModelRuntimes: values };
      this.#snapshot = snapshot;
      this.#callbacks.onSnapshot?.(snapshot);
    }
    return values;
  }

  async startManagedModelRuntime(runtimeId: string): Promise<ManagedModelRuntimeView> {
    const client = createClient(ManagedModelRuntimeService, this.requireTransport());
    const response = await client.startManagedModelRuntime({ runtimeId }, this.#abort === undefined ? undefined : { signal: this.#abort.signal });
    return this.commitManagedModelRuntime(response.runtime);
  }

  async installManagedModelRuntime(runtimeId: string): Promise<ManagedModelRuntimeView> {
    const client = createClient(ManagedModelRuntimeService, this.requireTransport());
    const response = await client.installManagedModelRuntime({ runtimeId }, this.#abort === undefined ? undefined : { signal: this.#abort.signal });
    return this.commitManagedModelRuntime(response.runtime);
  }

  async cancelManagedModelRuntimeInstall(runtimeId: string): Promise<ManagedModelRuntimeView> {
    const client = createClient(ManagedModelRuntimeService, this.requireTransport());
    const response = await client.cancelManagedModelRuntimeInstall({ runtimeId }, this.#abort === undefined ? undefined : { signal: this.#abort.signal });
    return this.commitManagedModelRuntime(response.runtime);
  }

  async pullManagedModel(runtimeId: string, modelName: string): Promise<ManagedModelRuntimeView> {
    const client = createClient(ManagedModelRuntimeService, this.requireTransport());
    const response = await client.pullManagedModel({ runtimeId, modelName }, this.#abort === undefined ? undefined : { signal: this.#abort.signal });
    return this.commitManagedModelRuntime(response.runtime);
  }

  async pauseManagedModelPull(runtimeId: string, modelName: string): Promise<ManagedModelRuntimeView> {
    const client = createClient(ManagedModelRuntimeService, this.requireTransport());
    const response = await client.pauseManagedModelPull({ runtimeId, modelName }, this.#abort === undefined ? undefined : { signal: this.#abort.signal });
    return this.commitManagedModelRuntime(response.runtime);
  }

  async resumeManagedModelPull(runtimeId: string, modelName: string): Promise<ManagedModelRuntimeView> {
    const client = createClient(ManagedModelRuntimeService, this.requireTransport());
    const response = await client.resumeManagedModelPull({ runtimeId, modelName }, this.#abort === undefined ? undefined : { signal: this.#abort.signal });
    return this.commitManagedModelRuntime(response.runtime);
  }

  async cancelManagedModelPull(runtimeId: string, modelName: string): Promise<ManagedModelRuntimeView> {
    const client = createClient(ManagedModelRuntimeService, this.requireTransport());
    const response = await client.cancelManagedModelPull({ runtimeId, modelName }, this.#abort === undefined ? undefined : { signal: this.#abort.signal });
    return this.commitManagedModelRuntime(response.runtime);
  }

  async deleteManagedModel(runtimeId: string, modelName: string): Promise<ManagedModelRuntimeView> {
    const client = createClient(ManagedModelRuntimeService, this.requireTransport());
    const response = await client.deleteManagedModel({ runtimeId, modelName }, this.#abort === undefined ? undefined : { signal: this.#abort.signal });
    return this.commitManagedModelRuntime(response.runtime);
  }

  async beginProviderLogin(backendId: string, providerId: string, method: ProviderLoginMethodView): Promise<ProviderLoginFlowView> {
    const operation = asRecord(await this.submit({
      case: "beginProviderLogin",
      value: { backendId, providerId, method: protoProviderLoginMethod(method) }
    }, true));
    const payload = asRecord(asRecord(asRecord(operation.result).payload));
    if (payload.case !== "providerLogin") throw new GatewayError("Orchestrator completed login setup without a provider login flow.");
    return mapProviderLoginFlow(payload.value as ProviderLoginFlow);
  }

  async getProviderLoginFlow(loginFlowId: string): Promise<ProviderLoginFlowView> {
    const client = createClient(BackendService, this.requireTransport());
    const response = await client.getProviderLoginFlow({ loginFlowId }, this.#abort === undefined ? undefined : { signal: this.#abort.signal });
    if (response.loginFlow === undefined) throw new GatewayError(response.error?.message || "Orchestrator returned no provider login flow.");
    return mapProviderLoginFlow(response.loginFlow);
  }

  async submitProviderLoginInput(flow: ProviderLoginFlowView, value: string): Promise<ProviderLoginFlowView> {
    const prompt = flow.pendingPrompt;
    if (prompt === undefined) throw new GatewayError("This provider login is not waiting for input.");
    const client = createClient(CredentialService, this.requireTransport());
    let input: { case: "choiceId" | "text" | "credentialInputTicketId"; value: string };
    if (prompt.kind === "select") {
      input = { case: "choiceId", value };
    } else if (prompt.kind === "text") {
      input = { case: "text", value };
    } else {
      const response = await client.beginProviderLoginInputUpload({ loginFlowId: flow.id, promptId: prompt.id }, this.#abort === undefined ? undefined : { signal: this.#abort.signal });
      const ticket = response.ticket;
      if (ticket === undefined || ticket.ticketId.length === 0 || ticket.relativeEndpoint.length === 0) {
        throw new GatewayError("Orchestrator has no credential channel available for this provider login input.");
      }
      const bytes = new TextEncoder().encode(value);
      try {
        if (ticket.maximumBytes > 0n && BigInt(bytes.byteLength) > ticket.maximumBytes) {
          throw new GatewayError("The provider login input exceeds the credential channel limit.");
        }
        const upload = await fetch(this.authorizedEndpoint(ticket.relativeEndpoint), {
          method: "PUT",
          headers: { authorization: `Bearer ${this.#authKey ?? ""}`, "content-type": "application/octet-stream" },
          body: bytes,
          signal: this.#abort?.signal
        });
        if (!upload.ok) throw new GatewayError(`Provider login input upload failed (${upload.status}).`);
      } finally {
        bytes.fill(0);
      }
      input = { case: "credentialInputTicketId", value: ticket.ticketId };
    }
    const response = await client.submitProviderLoginInput({ loginFlowId: flow.id, promptId: prompt.id, input }, this.#abort === undefined ? undefined : { signal: this.#abort.signal });
    if (response.loginFlow === undefined) throw new GatewayError("Orchestrator accepted no provider login input.");
    return mapProviderLoginFlow(response.loginFlow);
  }

  async cancelProviderLogin(loginFlowId: string): Promise<ProviderLoginFlowView> {
    const client = createClient(CredentialService, this.requireTransport());
    const response = await client.cancelProviderLogin({ loginFlowId }, this.#abort === undefined ? undefined : { signal: this.#abort.signal });
    if (response.loginFlow === undefined) throw new GatewayError("Orchestrator returned no cancelled provider login flow.");
    return mapProviderLoginFlow(response.loginFlow);
  }

  async refreshProviderCredential(backendId: string, providerId: string): Promise<void> {
    await this.submit({ case: "refreshProviderCredential", value: { backendId, providerId } }, true);
  }

  async logoutProvider(backendId: string, providerId: string): Promise<void> {
    await this.submit({ case: "logoutProvider", value: { backendId, providerId } }, true);
  }

  async saveProviderCredentialSurface(
    backendId: string,
    providerId: string,
    surfaceId: string,
    secret: string
  ): Promise<void> {
    if (backendId.trim() === "" || providerId.trim() === "" || surfaceId.trim() === "" || secret.length === 0) {
      throw new GatewayError("Provider credential surface and value are required.");
    }
    const ticketId = await this.uploadCredential(secret, CredentialKind.API_KEY, providerId, {
      backendId,
      surfaceId
    });
    await this.submit({
      case: "commitProviderCredentialSurface",
      value: {
        backendId,
        providerId,
        surfaceId,
        credentialUploadTicketId: ticketId
      }
    }, true);
  }

  async clearProviderCredentialSurface(
    backendId: string,
    providerId: string,
    surfaceId: string
  ): Promise<void> {
    await this.submit({
      case: "clearProviderCredentialSurface",
      value: { backendId, providerId, surfaceId }
    }, true);
  }

  async saveCredential(draft: CredentialDraft): Promise<void> {
    if (draft.id.trim().length === 0 || draft.name.trim().length === 0 || draft.secret.length === 0) throw new GatewayError("Credential ID, name, and value are required.");
    const kind = protoCredentialKind(draft.kind);
    const ticketId = await this.uploadCredential(draft.secret, kind, draft.providerId);
    await this.submit({
      case: "commitCredential",
      value: {
        credentialUploadTicketId: ticketId,
        credentialReferenceId: draft.id.trim(),
        displayName: draft.name.trim(),
        kind,
        providerId: draft.providerId,
        environmentName: draft.environmentName.trim()
      }
    }, true);
  }

  async deleteCredential(credentialId: string): Promise<void> {
    await this.submit({ case: "deleteCredential", value: { credentialReferenceId: credentialId } }, true);
  }

  async getRemoteHostCapabilities(
    targetId: string,
    signal?: AbortSignal
  ): Promise<RemoteHostCapabilitiesView> {
    const client = createClient(RemoteHostService, this.requireTransport());
    const response = await client.getRemoteHostCapabilities(
      { targetId },
      remoteHostRpcOptions(this.#abort?.signal, signal)
    );
    const supported = new Set(response.capabilities
      .filter((capability) => capability.support === CapabilitySupport.SUPPORTED)
      .map((capability) => capability.kind));
    return {
      catalog: supported.has(RemoteHostCapabilityKind.CATALOG),
      management: supported.has(RemoteHostCapabilityKind.MANAGEMENT),
      connectionControl: supported.has(RemoteHostCapabilityKind.CONNECTION_CONTROL),
      connectionTest: supported.has(RemoteHostCapabilityKind.CONNECTION_TEST),
      trustReset: supported.has(RemoteHostCapabilityKind.TRUST_RESET),
      commandExecution: supported.has(RemoteHostCapabilityKind.COMMAND_EXECUTION),
      processStreaming: supported.has(RemoteHostCapabilityKind.PROCESS_STREAMING),
      fileTransfer: supported.has(RemoteHostCapabilityKind.FILE_TRANSFER),
      tcpForwarding: supported.has(RemoteHostCapabilityKind.TCP_FORWARDING)
    };
  }

  async listRemoteHosts(targetId: string, signal?: AbortSignal): Promise<readonly RemoteHostView[]> {
    const client = createClient(RemoteHostService, this.requireTransport());
    const hosts: RemoteHostView[] = [];
    const consumedTokens = new Set<string>();
    let pageToken = "";
    for (let page = 0; page < MAX_COMPLETE_MESSAGE_SEARCH_PAGES; page += 1) {
      const response = await client.listRemoteHosts(
        { targetId, page: { pageSize: 500, pageToken } },
        remoteHostRpcOptions(this.#abort?.signal, signal)
      );
      hosts.push(...response.hosts.map(mapRemoteHost));
      const nextPageToken = response.page?.nextPageToken ?? "";
      if (nextPageToken === "") return hosts.sort(compareRemoteHosts);
      if (nextPageToken === pageToken || consumedTokens.has(nextPageToken)) {
        throw new GatewayError("Orchestrator returned a cyclic Remote Host catalog page token.");
      }
      consumedTokens.add(nextPageToken);
      pageToken = nextPageToken;
    }
    throw new GatewayError("Remote Host catalog pagination exceeded its safety limit.");
  }

  async *watchRemoteHosts(
    targetId: string,
    signal?: AbortSignal
  ): AsyncGenerator<readonly RemoteHostView[]> {
    const client = createClient(RemoteHostService, this.requireTransport());
    const stream = client.watchRemoteHosts(
      { targetId },
      remoteHostRpcOptions(this.#abort?.signal, signal)
    );
    let sequence = 0n;
    let hosts: RemoteHostView[] = [];
    for await (const response of stream) {
      if (response.sequence <= sequence) throw new GatewayError("Orchestrator returned an out-of-order Remote Host stream.");
      sequence = response.sequence;
      if (response.update.case === "snapshot") {
        hosts = response.update.value.hosts.map(mapRemoteHost);
      } else if (response.update.case === "change") {
        const changed = response.update.value.host;
        if (changed === undefined) throw new GatewayError("Orchestrator returned an empty Remote Host change.");
        const mapped = mapRemoteHost(changed);
        hosts = response.update.value.kind === RemoteHostChangeKind.DELETED
          ? hosts.filter((host) => host.id !== mapped.id)
          : upsertBy(hosts, mapped, (host) => host.id);
      } else {
        throw new GatewayError("Orchestrator returned an empty Remote Host stream update.");
      }
      if (hosts.some((host) => host.targetId !== targetId)) {
        throw new GatewayError("Orchestrator returned a Remote Host outside the requested target.");
      }
      yield [...hosts].sort(compareRemoteHosts);
    }
  }

  async refreshRemoteHostCatalog(targetId: string): Promise<readonly RemoteHostView[]> {
    const client = createClient(RemoteHostService, this.requireTransport());
    const response = await client.refreshRemoteHostCatalog(
      { targetId, requestId: randomUuid() },
      remoteHostRpcOptions(this.#abort?.signal)
    );
    return response.hosts.map(mapRemoteHost).sort(compareRemoteHosts);
  }

  async createRemoteHost(targetId: string, draft: RemoteHostDraft): Promise<RemoteHostView> {
    const client = createClient(RemoteHostService, this.requireTransport());
    const response = await client.createRemoteHost({
      requestId: randomUuid(),
      targetId,
      hostId: draft.id.trim() || randomUuid(),
      hostname: draft.hostname.trim(),
      port: draft.port,
      user: draft.user.trim(),
      authenticationMode: protoRemoteHostAuthentication(draft.authentication),
      ...(draft.authentication === "privateKey"
        ? { credentialReferenceId: draft.credentialReferenceId?.trim() ?? "" }
        : {})
    }, remoteHostRpcOptions(this.#abort?.signal));
    return requireRemoteHost(response.host);
  }

  async updateRemoteHost(
    targetId: string,
    hostId: string,
    expectedRevision: bigint,
    draft: RemoteHostDraft
  ): Promise<RemoteHostView> {
    const client = createClient(RemoteHostService, this.requireTransport());
    const response = await client.updateRemoteHost({
      targetId,
      hostId,
      hostname: draft.hostname.trim(),
      port: draft.port,
      user: draft.user.trim(),
      authenticationMode: protoRemoteHostAuthentication(draft.authentication),
      ...(draft.authentication === "privateKey"
        ? { credentialReferenceId: draft.credentialReferenceId?.trim() ?? "" }
        : {}),
      expectedRevision: { value: expectedRevision }
    }, remoteHostRpcOptions(this.#abort?.signal));
    return requireRemoteHost(response.host);
  }

  async deleteRemoteHost(targetId: string, hostId: string, expectedRevision: bigint): Promise<void> {
    const client = createClient(RemoteHostService, this.requireTransport());
    await client.deleteRemoteHost(
      { targetId, hostId, expectedRevision: { value: expectedRevision } },
      remoteHostRpcOptions(this.#abort?.signal)
    );
  }

  async connectRemoteHost(targetId: string, hostId: string, expectedRevision: bigint): Promise<RemoteHostView> {
    const client = createClient(RemoteHostService, this.requireTransport());
    const response = await client.connectRemoteHost(
      { targetId, hostId, expectedRevision: { value: expectedRevision } },
      remoteHostRpcOptions(this.#abort?.signal)
    );
    return requireRemoteHost(response.host);
  }

  async disconnectRemoteHost(targetId: string, hostId: string, expectedRevision: bigint): Promise<RemoteHostView> {
    const client = createClient(RemoteHostService, this.requireTransport());
    const response = await client.disconnectRemoteHost(
      { targetId, hostId, expectedRevision: { value: expectedRevision } },
      remoteHostRpcOptions(this.#abort?.signal)
    );
    return requireRemoteHost(response.host);
  }

  async testRemoteHostConnection(targetId: string, hostId: string, expectedRevision: bigint): Promise<RemoteHostView> {
    const client = createClient(RemoteHostService, this.requireTransport());
    const response = await client.testRemoteHostConnection(
      { targetId, hostId, expectedRevision: { value: expectedRevision } },
      remoteHostRpcOptions(this.#abort?.signal)
    );
    return requireRemoteHost(response.result?.host);
  }

  async clearRemoteHostTrust(targetId: string, hostId: string, expectedRevision: bigint): Promise<RemoteHostView> {
    const client = createClient(RemoteHostService, this.requireTransport());
    const response = await client.clearRemoteHostTrust(
      { targetId, hostId, expectedRevision: { value: expectedRevision } },
      remoteHostRpcOptions(this.#abort?.signal)
    );
    return requireRemoteHost(response.host);
  }

  async saveMcpServer(draft: McpServerDraft): Promise<void> {
    const id = draft.id.trim() || randomUuid();
    const credentialBindings = draft.credentialBindings.map((binding) => ({
      headerName: binding.target === "header" ? binding.name.trim() : "",
      credentialReferenceId: binding.credentialId.trim(),
      target: binding.target === "header" ? McpCredentialTarget.HEADER : McpCredentialTarget.ENVIRONMENT,
      targetName: binding.name.trim()
    }));
    const duplicateBindings = new Set<string>();
    for (const binding of draft.credentialBindings) {
      const name = binding.name.trim();
      const credentialId = binding.credentialId.trim();
      const expectedTarget = draft.transport === "stdio" ? "environment" : "header";
      if (binding.target !== expectedTarget || name.length === 0 || credentialId.length === 0) {
        throw new GatewayError("Every MCP credential binding requires a compatible target, name, and credential reference.");
      }
      const key = `${binding.target}:${name.toLocaleLowerCase("en-US")}`;
      if (duplicateBindings.has(key)) throw new GatewayError("MCP credential binding targets must be unique.");
      duplicateBindings.add(key);
    }
    const environment = draft.transport === "stdio"
      ? draft.environment.map((variable) => ({ name: variable.name.trim(), value: variable.value }))
      : [];
    const environmentNames = new Set<string>();
    for (const variable of environment) {
      if (variable.name.length === 0) throw new GatewayError("Every MCP environment variable requires a name.");
      const key = variable.name.toLocaleLowerCase("en-US");
      if (environmentNames.has(key)) throw new GatewayError("MCP environment variable names must be unique.");
      environmentNames.add(key);
    }
    const endpoint = draft.transport === "https" ? canonicalProviderEndpoint(draft.endpoint) : "";
    const server = create(
      McpServerInputSchema,
      draft.transport === "stdio"
        ? {
          displayName: draft.name.trim(),
          transport: McpTransport.STDIO,
          endpoint: "",
          credentialBindings,
          enabled: draft.enabled,
          transportConfig: { case: "stdio", value: { command: draft.command.trim(), arguments: [...draft.arguments], workingDirectory: draft.workingDirectory.trim(), environment } }
          }
        : {
          displayName: draft.name.trim(),
          transport: McpTransport.HTTPS_STREAMABLE_HTTP,
          endpoint,
          credentialBindings,
          enabled: draft.enabled,
          transportConfig: { case: "streamableHttp", value: { endpoint } }
          }
    );
    if (server.displayName.length === 0 || (draft.transport === "stdio" ? draft.command.trim().length === 0 : server.endpoint.length === 0)) throw new GatewayError("MCP name and transport configuration are required.");
    await this.submit({ case: "upsertMcpServer", value: { mcpServerId: id, server, expectedRevision: { value: draft.revision } } }, true);
  }

  async deleteMcpServer(serverId: string): Promise<void> {
    await this.submit({ case: "deleteMcpServer", value: { mcpServerId: serverId } }, true);
  }

  async restartMcpServer(serverId: string): Promise<void> {
    await this.submit({ case: "restartMcpServer", value: { mcpServerId: serverId } }, true);
  }

  async updatePiSettings(backendId: string, patch: { readonly autoCompaction?: boolean; readonly autoCompactionThresholdPercent?: number; readonly resetAutoCompactionThresholdPercent?: boolean; readonly autoRetry?: boolean; readonly steeringMode?: "all" | "oneAtATime"; readonly followUpMode?: "all" | "oneAtATime" }): Promise<void> {
    await this.submit({
      case: "updatePiSettings",
      value: {
        patch: {
          backendId,
          ...(patch.autoCompaction === undefined ? {} : { autoCompaction: patch.autoCompaction }),
          ...(patch.autoCompactionThresholdPercent === undefined ? {} : { autoCompactionThresholdPercent: patch.autoCompactionThresholdPercent }),
          resetAutoCompactionThresholdPercent: patch.resetAutoCompactionThresholdPercent ?? false,
          ...(patch.autoRetry === undefined ? {} : { autoRetry: patch.autoRetry }),
          ...(patch.steeringMode === undefined ? {} : { steeringMode: patch.steeringMode === "oneAtATime" ? PiQueueMode.ONE_AT_A_TIME : PiQueueMode.ALL }),
          ...(patch.followUpMode === undefined ? {} : { followUpMode: patch.followUpMode === "oneAtATime" ? PiQueueMode.ONE_AT_A_TIME : PiQueueMode.ALL })
        }
      }
    }, true);
  }

  async updateBrowserSettings(browserProviderId: string, patch: BrowserSettingsPatchView): Promise<void> {
    await this.submit({
      case: "updateBrowserSettings",
      value: {
        patch: {
          browserProviderId,
          ...(patch.targetId === undefined ? {} : { targetId: patch.targetId }),
          ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
          ...(patch.profileDisplayName === undefined ? {} : { profileDisplayName: patch.profileDisplayName.trim() }),
          ...(patch.takeoverTimeoutSeconds === undefined ? {} : { takeoverTimeout: { seconds: BigInt(Math.max(1, Math.floor(patch.takeoverTimeoutSeconds))), nanos: 0 } }),
          ...(patch.allowUploads === undefined ? {} : { allowUploads: patch.allowUploads }),
          ...(patch.allowDownloads === undefined ? {} : { allowDownloads: patch.allowDownloads }),
          ...(patch.automationTarget === undefined ? {} : {
            automationTarget: patch.automationTarget === "sidebar"
              ? BrowserAutomationTarget.SIDEBAR
              : BrowserAutomationTarget.EXTERNAL
          })
        }
      }
    }, true);
  }

  async updatePolicy(patch: Partial<SettingsView["policy"]>): Promise<void> {
    const current = this.#rawSnapshot?.settings?.policy;
    const policy = current === undefined
      ? create(PolicySettingsSchema)
      : create(PolicySettingsSchema, current);
    policy.defaultMode = patch.defaultMode === undefined ? current?.defaultMode ?? ProtoPermissionMode.ASK : protoPermission(patch.defaultMode);
    policy.rules = current?.rules ?? [];
    policy.projectTrustRequired = patch.projectTrustRequired ?? current?.projectTrustRequired ?? true;
    policy.redactCredentials = patch.redactCredentials ?? current?.redactCredentials ?? true;
    policy.stripChildProcessCredentials = patch.stripChildProcessCredentials ?? current?.stripChildProcessCredentials ?? true;
    await this.submit({
      case: "replacePolicySettings",
      value: {
        policy
      }
    }, true);
  }

  async updateDiagnostics(patch: Partial<SettingsView["diagnostics"]>): Promise<void> {
    await this.submit({
      case: "updateDiagnosticSettings",
      value: {
        patch: {
          ...(patch.level === undefined ? {} : { level: protoDiagnosticLevel(patch.level) }),
          ...(patch.retentionSeconds === undefined ? {} : { retention: { seconds: BigInt(Math.max(0, Math.floor(patch.retentionSeconds))), nanos: 0 } }),
          ...(patch.includeSanitizedBackendPayloads === undefined ? {} : { includeSanitizedBackendPayloads: patch.includeSanitizedBackendPayloads }),
          ...(patch.includePerformanceMetrics === undefined ? {} : { includePerformanceMetrics: patch.includePerformanceMetrics })
        }
      }
    }, true);
  }

  async updateVoiceInputServiceSettings(draft: VoiceInputServiceSettingsDraft): Promise<void> {
    const secret = draft.secret?.trim();
    const fallbackSecret = draft.fallbackSecret?.trim();
    const credentialUploadTicketId = secret === undefined || secret === ""
      ? undefined
      : await this.uploadCredential(secret, CredentialKind.API_KEY, "");
    const fallbackCredentialUploadTicketId = fallbackSecret === undefined || fallbackSecret === ""
      ? undefined
      : await this.uploadCredential(fallbackSecret, CredentialKind.API_KEY, "");
    await this.submit({
      case: "updateVoiceInputServiceSettings",
      value: {
        patch: {
          enabled: draft.enabled,
          protocol: protoVoiceInputProtocol(draft.protocol),
          endpoint: draft.endpoint.trim(),
          model: draft.model.trim(),
          keyless: draft.keyless,
          ...(credentialUploadTicketId === undefined ? {} : { credentialUploadTicketId }),
          ...(draft.clearCredential === undefined ? {} : { clearCredential: draft.clearCredential }),
          refinementEnabled: draft.refinementEnabled,
          refinerProviderId: draft.refinerProviderId,
          refinerModelId: draft.refinerModelId,
          refinerFallbackProviderId: draft.refinerFallbackProviderId,
          refinerFallbackModelId: draft.refinerFallbackModelId,
          fallbackEnabled: draft.fallbackEnabled,
          fallbackProtocol: protoVoiceInputProtocol(draft.fallbackProtocol),
          fallbackEndpoint: draft.fallbackEndpoint.trim(),
          fallbackModel: draft.fallbackModel.trim(),
          fallbackKeyless: draft.fallbackKeyless,
          ...(fallbackCredentialUploadTicketId === undefined ? {} : { fallbackCredentialUploadTicketId }),
          ...(draft.clearFallbackCredential === undefined ? {} : { clearFallbackCredential: draft.clearFallbackCredential }),
          expectedRevision: { value: draft.expectedRevision }
        }
      }
    }, true);
  }

  async showBrowserAutomation(browserProviderId: string, targetId: string): Promise<void> {
    await this.submit({ case: "showBrowserAutomation", value: { browserProviderId, targetId } }, true);
  }

  async updateComputerAutomationSettings(enabled: boolean): Promise<void> {
    await this.submit({
      case: "updateComputerAutomationSettings",
      value: { patch: { enabled } }
    }, true);
  }

  async installComputerAutomation(): Promise<void> {
    await this.submit({ case: "installComputerAutomation", value: {} }, true);
  }

  async probeComputerAutomation(fresh = true): Promise<void> {
    await this.submit({ case: "probeComputerAutomation", value: { fresh } }, true);
  }

  async requestComputerAutomationPermission(permission: "accessibility" | "screenRecording" | "all"): Promise<void> {
    await this.submit({
      case: "requestComputerAutomationPermission",
      value: {
        permission: permission === "accessibility"
          ? ComputerAutomationPermissionKind.ACCESSIBILITY
          : permission === "screenRecording"
            ? ComputerAutomationPermissionKind.SCREEN_RECORDING
            : ComputerAutomationPermissionKind.ALL
      }
    }, true);
  }

  async cancelComputerAutomationPermission(): Promise<void> {
    await this.submit({ case: "cancelComputerAutomationPermission", value: {} }, true);
  }

  async openComputerAutomationPermissionSettings(
    permission: "accessibility" | "screenRecording"
  ): Promise<void> {
    await this.submit({
      case: "openComputerAutomationPermissionSettings",
      value: {
        permission: permission === "accessibility"
          ? ComputerAutomationPermissionKind.ACCESSIBILITY
          : ComputerAutomationPermissionKind.SCREEN_RECORDING
      }
    }, true);
  }

  async checkComputerAutomationUpdate(fresh = false): Promise<void> {
    await this.submit({ case: "checkComputerAutomationUpdate", value: { fresh } }, true);
  }

  async updateComputerAutomationDriver(joinOnly = false): Promise<void> {
    await this.submit({ case: "updateComputerAutomationDriver", value: { joinOnly } }, true);
  }

  async updateAndroidAutomationSettings(enabled: boolean): Promise<void> {
    await this.submit({
      case: "updateAndroidAutomationSettings",
      value: { patch: { enabled } }
    }, true);
  }

  async prepareAndroidAdb(): Promise<void> {
    await this.submit({ case: "prepareAndroidAutomation", value: {} }, true);
  }

  async probeAndroidAutomation(fresh = true): Promise<void> {
    await this.submit({ case: "probeAndroidAutomation", value: { fresh } }, true);
  }

  async selectAndroidAutomationDevice(deviceSerial?: string): Promise<void> {
    await this.submit({
      case: "selectAndroidAutomationDevice",
      value: {
        selection: {
          choice: deviceSerial === undefined
            ? { case: "automatic", value: true }
            : { case: "deviceSerial", value: deviceSerial }
        }
      }
    }, true);
  }

  async setAndroidAdbPath(serverPath?: string): Promise<void> {
    await this.submit({
      case: "setAndroidAdbPath",
      value: {
        selection: {
          choice: serverPath === undefined
            ? { case: "automatic", value: true }
            : { case: "serverPath", value: serverPath }
        }
      }
    }, true);
  }

  async updateMemorySettings(patch: {
    readonly makerEnabled?: boolean;
    readonly backendId?: string;
    readonly backendEnabled?: boolean;
  }): Promise<void> {
    await this.submit({
      case: "updateMemorySettings",
      value: {
        restoreDefaults: false,
        patch: {
          ...(patch.makerEnabled === undefined ? {} : { makerEnabled: patch.makerEnabled }),
          ...(patch.backendId === undefined ? {} : { backendId: patch.backendId }),
          ...(patch.backendEnabled === undefined ? {} : { backendEnabled: patch.backendEnabled })
        }
      }
    }, true);
  }

  async restoreMemoryDefaults(): Promise<void> {
    await this.submit({
      case: "updateMemorySettings",
      value: { restoreDefaults: true }
    }, true);
  }

  async resetMemory(scope: "curated" | "backend", backendId?: string): Promise<{
    readonly removedEntries: number;
    readonly removedTargets: number;
  }> {
    const operation = await this.submit({
      case: "resetMemory",
      value: {
        scope: scope === "curated" ? MemoryResetScope.CURATED : MemoryResetScope.BACKEND,
        backendId: backendId ?? ""
      }
    }, true);
    const result = operation.result?.payload;
    if (result?.case !== "memoryReset") throw new GatewayError("Orchestrator returned no Memory reset result.");
    return {
      removedEntries: numberValue(result.value.removedEntries),
      removedTargets: numberValue(result.value.removedTargets)
    };
  }

  async updateMessageSearchSettings(enabled: boolean): Promise<void> {
    await this.submit({
      case: "updateMessageSearchSettings",
      value: { patch: { semanticIndexEnabled: enabled } }
    }, true);
  }

  async resetMessageSearchSettings(): Promise<void> {
    await this.submit({
      case: "updateMessageSearchSettings",
      value: { patch: { resetSemanticIndexEnabled: true } }
    }, true);
  }

  async updateVisionBridgeSettings(patch: Parameters<OperationApi["updateVisionBridgeSettings"]>[0]): Promise<void> {
    await this.submit({
      case: "updateVisionBridgeSettings",
      value: {
        patch: {
          ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
          ...(patch.targetModels === undefined ? {} : { targetModels: { values: [...patch.targetModels] } }),
          ...(patch.primary === undefined
            ? {}
            : { primary: patch.primary ?? { backendId: "", providerId: "", modelId: "" } }),
          ...(patch.fallback === undefined
            ? {}
            : { fallback: patch.fallback ?? { backendId: "", providerId: "", modelId: "" } }),
          resetAll: patch.resetAll ?? false,
          resetTargetModels: patch.resetTargetModels ?? false
        }
      }
    }, true);
  }

  async updatePromptRecommendationSettings(enabled: boolean): Promise<void> {
    await this.submit({
      case: "updatePromptRecommendationSettings",
      value: { patch: { enabled } }
    }, true);
  }

  async resetPromptRecommendationSettings(): Promise<void> {
    await this.submit({
      case: "updatePromptRecommendationSettings",
      value: { patch: { resetEnabled: true } }
    }, true);
  }

  async updateLanguageToolSettings(enabled: boolean): Promise<void> {
    await this.submit({
      case: "updateLanguageToolSettings",
      value: { patch: { enabled } }
    }, true);
  }

  async updateToolPolicySettings(
    toolProviderId: string,
    targetId: string | undefined,
    patch: Parameters<OperationApi["updateToolPolicySettings"]>[2]
  ): Promise<void> {
    const reset = "reset" in patch && patch.reset;
    await this.submit({
      case: "updateToolPolicySettings",
      value: {
        patch: {
          toolProviderId,
          targetId: targetId ?? "",
          ...(!reset && "enabled" in patch ? { enabled: patch.enabled } : {}),
          reset
        }
      }
    }, true);
  }

  async updateAgentResourceSettings(
    patch: Parameters<OperationApi["updateAgentResourceSettings"]>[0]
  ): Promise<void> {
    const resetAll = "resetAll" in patch && patch.resetAll;
    const values = "resetAll" in patch ? undefined : patch;
    await this.submit({
      case: "updateAgentResourceSettings",
      value: {
        patch: {
          ...(values?.maxConcurrentCommands !== undefined
            ? { maxConcurrentCommands: values.maxConcurrentCommands }
            : {}),
          ...(values?.processPriority !== undefined
            ? { processPriority: protoManagedProcessPriority(values.processPriority) }
            : {}),
          ...(values?.capToolchainThreads !== undefined
            ? { capToolchainThreads: values.capToolchainThreads }
            : {}),
          resetAll
        }
      }
    }, true);
  }

  async updateCollaborationSettings(
    patch: Parameters<OperationApi["updateCollaborationSettings"]>[0]
  ): Promise<void> {
    const resetAll = "resetAll" in patch && patch.resetAll;
    const values = "resetAll" in patch ? undefined : patch;
    await this.submit({
      case: "updateCollaborationSettings",
      value: {
        patch: {
          ...(values?.workerSoftLimit !== undefined
            ? { workerSoftLimit: values.workerSoftLimit }
            : {}),
          ...(values?.workerHardLimit !== undefined
            ? { workerHardLimit: values.workerHardLimit }
            : {}),
          ...(values?.workerIdleReleaseMinutes !== undefined
            ? { workerIdleReleaseMinutes: values.workerIdleReleaseMinutes }
            : {}),
          resetAll
        }
      }
    }, true);
  }

  async updateGitSafetySettings(
    patch: Parameters<OperationApi["updateGitSafetySettings"]>[0]
  ): Promise<void> {
    const resetAll = "resetAll" in patch && patch.resetAll;
    await this.submit({
      case: "updateGitSafetySettings",
      value: {
        patch: {
          ...(!resetAll && "autoSnapshotEnabled" in patch
            ? { autoSnapshotEnabled: patch.autoSnapshotEnabled }
            : {}),
          resetAll
        }
      }
    }, true);
  }

  async cleanupGitSafetySavepoints(): Promise<void> {
    await this.submit({
      case: "cleanupGitSafetySavepoints",
      value: {}
    }, true);
  }

  async predictNextPrompt(
    sessionId: string,
    expectedLastActivityAt: number,
    expectedGeneration: bigint
  ): Promise<string> {
    const client = createClient(SessionService, this.requireTransport());
    const response = await client.predictNextPrompt({
      sessionId,
      expectedLastActivityAt: timestampFromMs(expectedLastActivityAt),
      expectedGeneration
    }, this.#abort === undefined ? undefined : { signal: this.#abort.signal });
    return response.prompt;
  }

  async setSilentEncryptedRetryEnabled(enabled: boolean): Promise<void> {
    await this.submit({
      case: "updatePersonalizationSettings",
      value: { patch: { silentEncryptedRetryEnabled: enabled, resetSilentEncryptedRetry: false } }
    }, true);
  }

  async resetSilentEncryptedRetry(): Promise<void> {
    await this.submit({
      case: "updatePersonalizationSettings",
      value: { patch: { resetSilentEncryptedRetry: true } }
    }, true);
  }

  async setSessionRuntimeFallbackEnabled(enabled: boolean): Promise<void> {
    await this.submit({
      case: "updatePersonalizationSettings",
      value: {
        patch: {
          sessionRuntimeFallbackEnabled: enabled,
          resetSessionRuntimeFallback: false
        }
      }
    }, true);
  }

  async resetSessionRuntimeFallback(): Promise<void> {
    await this.submit({
      case: "updatePersonalizationSettings",
      value: { patch: { resetSessionRuntimeFallback: true } }
    }, true);
  }

  async createDiagnosticsBundle(): Promise<ArtifactView> {
    const operation = await this.submit({ case: "createDiagnosticsBundle", value: { level: DiagnosticLevel.STANDARD, diagnosticIds: [] } }, true);
    const payload = operation.result?.payload;
    if (payload?.case !== "diagnosticsBundle") throw new GatewayError("Orchestrator completed diagnostics without a bundle artifact.");
    return mapArtifact(payload.value);
  }

  async installResource(resourceId: string): Promise<ResourceView> {
    const operation = await this.submit({ case: "installResource", value: { resourceId } }, true);
    const payload = operation.result?.payload;
    if (payload?.case !== "resource") throw new GatewayError("Orchestrator completed resource installation without a resource result.");
    return mapResource(payload.value);
  }

  async updateResource(resourceId: string): Promise<ResourceView> {
    const operation = await this.submit({ case: "updateResource", value: { resourceId, requestedVersion: "" } }, true);
    const payload = operation.result?.payload;
    if (payload?.case !== "resource") throw new GatewayError("Orchestrator completed resource update without a resource result.");
    return mapResource(payload.value);
  }

  async getArtifactUrl(blobId: string): Promise<string> {
    const existing = this.#artifactUrls.get(blobId);
    if (existing !== undefined) {
      existing.refs += 1;
      if (existing.url !== undefined) return existing.url;
      if (existing.pending !== undefined) return existing.pending;
    }

    const lease: ArtifactUrlLease = { refs: 1 };
    const pending = this.fetchArtifact(blobId).then((blob) => {
      const url = URL.createObjectURL(blob);
      lease.pending = undefined;
      lease.url = url;
      if (this.#artifactUrls.get(blobId) !== lease || lease.refs === 0) {
        URL.revokeObjectURL(url);
        if (this.#artifactUrls.get(blobId) === lease) this.#artifactUrls.delete(blobId);
      }
      return url;
    }).catch((error: unknown) => {
      if (this.#artifactUrls.get(blobId) === lease) this.#artifactUrls.delete(blobId);
      throw error;
    });
    lease.pending = pending;
    this.#artifactUrls.set(blobId, lease);
    return pending;
  }

  releaseArtifactUrl(blobId: string): void {
    const lease = this.#artifactUrls.get(blobId);
    if (lease === undefined || lease.refs === 0) return;
    lease.refs -= 1;
    if (lease.refs > 0 || lease.url === undefined) return;
    URL.revokeObjectURL(lease.url);
    this.#artifactUrls.delete(blobId);
  }

  async downloadArtifact(blobId: string, fileName: string): Promise<void> {
    await this.saveArtifact(blobId, fileName);
  }

  private async saveArtifact(blobId: string, fileName: string): Promise<boolean> {
    const blob = await this.fetchArtifact(blobId);
    const desktop = typeof window === "undefined" ? undefined : window.jokoDesktop;
    if (desktop !== undefined) {
      return desktop.saveFile({
        name: fileName || "artifact",
        mediaType: blob.type || "application/octet-stream",
        bytes: new Uint8Array(await blob.arrayBuffer())
      });
    }
    const url = URL.createObjectURL(blob);
    try {
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName || "artifact";
      link.rel = "noopener";
      link.click();
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
    }
    return true;
  }

  private async consumeEvents(signal: AbortSignal): Promise<void> {
    let delay = 350;
    while (!signal.aborted) {
      try {
        const transport = this.requireTransport();
        const client = createClient(EventService, transport);
        const cursor = this.#rawSnapshot?.resumeCursor;
        let lastGeneration = this.#snapshot?.generation;
        let lastSequence = this.#snapshot?.cursor;
        this.#callbacks.onState?.("connected");
        for await (const response of client.streamEvents({ scope: OWNER_SCOPE, afterCursor: cursor }, { signal })) {
          if (signal.aborted) return;
          const event = response.event;
          if (event === undefined) continue;
          const invalidated = payloadCase(event) === "projectionInvalidated";
          const continuity = classifyEventContinuity(lastGeneration, lastSequence, event);
          const duplicate = continuity === "duplicate";
          if (duplicate && !invalidated) continue;
          // Transient renderer effects are valid only on a proven contiguous
          // stream edge. A gap/generation refresh restores durable status and
          // widget projections, but must never replay one-shot UI requests.
          if (transientUiEffectContinuitySafe(continuity)) {
            const extensionEffect = extensionUiEffect(event);
            if (extensionEffect !== undefined) this.#callbacks.onExtensionUiEffect?.(extensionEffect);
            const visionEffect = visionBridgeUiEffect(event);
            if (visionEffect !== undefined) this.#callbacks.onVisionBridgeUiEffect?.(visionEffect);
          }
          if (continuity === "gap" || continuity === "generationChanged" || continuity === "missingCursor" || invalidated) {
            await this.flushEventRefresh(event.cursor);
            lastGeneration = this.#snapshot?.generation;
            lastSequence = this.#snapshot?.cursor;
          } else {
            const rawSnapshot = this.#rawSnapshot;
            const snapshot = this.#snapshot;
            if (rawSnapshot === undefined || snapshot === undefined) {
              await this.flushEventRefresh(event.cursor);
              lastGeneration = this.#snapshot?.generation;
              lastSequence = this.#snapshot?.cursor;
              continue;
            }
            const projected = projectSnapshotEvent(rawSnapshot, snapshot, event);
            this.#rawSnapshot = projected.rawSnapshot;
            this.#snapshot = projected.snapshot;
            this.#callbacks.onSnapshot?.(projected.snapshot);
            lastGeneration = projected.snapshot.generation;
            lastSequence = projected.snapshot.cursor;
            if (projected.refresh === "batched") this.scheduleEventRefresh();
          }
          delay = 350;
        }
        if (!signal.aborted) throw new GatewayError("The Orchestrator event stream closed.", { offline: true });
      } catch (error) {
        if (signal.aborted) return;
        let retryError = error;
        if (requiresEventSnapshotResync(error)) {
          this.#callbacks.onState?.("reconnecting", "Refreshing the event snapshot…");
          try {
            await this.refresh();
            delay = 350;
            this.#callbacks.onState?.("connected");
            continue;
          } catch (refreshError) {
            retryError = refreshError;
          }
        }
        const gatewayError = normalizeError(retryError);
        if (isUnauthenticatedError(retryError)) {
          await this.terminateAuthentication(gatewayError);
          return;
        }
        this.#callbacks.onError?.(gatewayError);
        this.#callbacks.onState?.(gatewayError.offline ? "offline" : "reconnecting", "Connection interrupted; retrying…");
        await abortableDelay(delay, signal);
        delay = Math.min(delay * 2, 10_000);
      }
    }
  }

  private async terminateAuthentication(error: GatewayError): Promise<void> {
    this.disconnect();
    this.#callbacks.onError?.(error);
    this.#callbacks.onState?.("disconnected", error.message);
    try {
      await this.#callbacks.onAuthenticationInvalidated?.(error);
    } catch (clearError) {
      this.#callbacks.onError?.(normalizeError(clearError));
    }
  }

  private scheduleEventRefresh(): void {
    this.#eventRefreshQueued = true;
    this.armEventRefresh();
  }

  private armEventRefresh(): void {
    if (!this.#eventRefreshQueued || this.#eventRefreshTimer !== undefined || this.#refreshPromise !== undefined || this.#transport === undefined) return;
    this.#eventRefreshTimer = setTimeout(() => {
      this.#eventRefreshTimer = undefined;
      this.#eventRefreshQueued = false;
      void this.refresh().catch((error: unknown) => this.#callbacks.onError?.(normalizeError(error)));
    }, 75);
  }

  private async flushEventRefresh(minimumCursor?: Event["cursor"]): Promise<void> {
    if (this.#eventRefreshTimer !== undefined) {
      clearTimeout(this.#eventRefreshTimer);
      this.#eventRefreshTimer = undefined;
    }
    this.#eventRefreshQueued = false;
    await this.refresh();
    if (
      minimumCursor !== undefined
      && (
        this.#snapshot?.generation !== minimumCursor.generation
        || (this.#snapshot?.cursor ?? -1n) < minimumCursor.sequence
      )
    ) await this.refresh();
  }

  private async submit(
    payload: MutationPayload,
    waitForTerminal = false,
    preconditions: readonly MutationPrecondition[] = []
  ): Promise<Operation> {
    const transport = this.requireTransport();
    const client = createClient(OperationService, transport);
    const operationId = randomUuid();
    const request = {
      operationId,
      connectionId: this.#profile?.id ?? "",
      mutation: create(OperationMutationSchema, { payload, preconditions: [...preconditions] })
    };
    const options = this.#abort === undefined ? undefined : { signal: this.#abort.signal };
    const submitOnce = () => client.submitOperation(request, options);
    let response;
    try {
      response = await submitOnce();
    } catch (error) {
      // A dropped unary response does not say whether Orchestrator durably claimed
      // the effect. Re-submit the exact request under the same idempotency key;
      // never mint a second operation ID inside one user attempt.
      if (this.#abort?.signal.aborted === true || !isUncertainOperationSubmissionError(error)) throw error;
      response = await submitOnce();
    }
    if (response.operation === undefined) throw new GatewayError("Orchestrator accepted no operation.");
    let operation = response.operation;
    if (waitForTerminal && !TERMINAL_OPERATION_STATES.has(operation.state)) {
      const timeout = AbortSignal.timeout(OPERATION_TERMINAL_WAIT_TIMEOUT_MS);
      for await (const update of client.watchOperation({
        operationId,
        afterRevision: operation.version?.revision
      }, { signal: timeout })) {
        if (update.operation === undefined) continue;
        operation = update.operation;
        if (TERMINAL_OPERATION_STATES.has(operation.state)) break;
      }
      if (!TERMINAL_OPERATION_STATES.has(operation.state)) {
        const reconciled = await client.getOperation({ operationId });
        if (reconciled.operation !== undefined) operation = reconciled.operation;
      }
      if (!TERMINAL_OPERATION_STATES.has(operation.state)) {
        throw new GatewayError("Orchestrator stopped watching the operation before it reached a terminal state.");
      }
    }
    if (operation.state === OperationState.FAILED || operation.state === OperationState.CONFLICT || operation.state === OperationState.CANCELLED) {
      throw new GatewayError(operation.error?.message || `Operation ${operation.state} failed.`, {
        ...(operation.error?.code ? { code: operation.error.code } : {})
      });
    }
    void this.refresh().catch((error: unknown) => this.#callbacks.onError?.(normalizeError(error)));
    return operation;
  }

  private async uploadAttachment(file: File): Promise<Record<string, unknown>> {
    return this.uploadBlob(file, BlobDisposition.ATTACHMENT);
  }

  private async uploadBlob(file: File, disposition: BlobDisposition): Promise<Record<string, unknown>> {
    const transport = this.requireTransport();
    const client = createClient(ArtifactService, transport);
    const digest = await sha256Hex(await file.arrayBuffer());
    const response = await client.beginBlobUpload({
      fileName: file.name,
      mediaType: file.type || "application/octet-stream",
      byteSize: BigInt(file.size),
      sha256Hex: digest,
      disposition
    });
    const upload = response.upload;
    const endpoint = upload?.ticket?.relativeEndpoint;
    if (upload === undefined || endpoint === undefined || endpoint.length === 0) throw new GatewayError("Orchestrator returned no upload ticket.");
    const uploadResponse = await fetch(this.authorizedEndpoint(endpoint), {
      method: "PUT",
      headers: {
        authorization: `Bearer ${this.#authKey ?? ""}`,
        "content-type": "application/octet-stream"
      },
      body: file,
      signal: this.#abort?.signal
    });
    if (!uploadResponse.ok) throw new GatewayError(`Attachment upload failed (${uploadResponse.status}).`);
    const completed = await client.completeBlobUpload({ uploadId: upload.uploadId });
    if (completed.blob === undefined) throw new GatewayError("Orchestrator did not commit the uploaded attachment.");
    return completed.blob as unknown as Record<string, unknown>;
  }

  private async fetchArtifact(blobId: string): Promise<Blob> {
    const transport = this.requireTransport();
    const client = createClient(ArtifactService, transport);
    const response = await client.getBlobDownloadTicket({ blobId });
    const endpoint = response.ticket?.relativeEndpoint;
    if (endpoint === undefined || endpoint.length === 0) throw new GatewayError("Orchestrator returned no download ticket.");
    const download = await fetch(this.authorizedEndpoint(endpoint), {
      headers: { authorization: `Bearer ${this.#authKey ?? ""}` },
      cache: "no-store",
      signal: this.#abort?.signal
    });
    if (!download.ok) throw new GatewayError(`Artifact download failed (${download.status}).`);
    return download.blob();
  }

  private async uploadSensitiveAnswer(secret: string): Promise<string> {
    return this.uploadCredential(secret, CredentialKind.UNSPECIFIED, "");
  }

  private async uploadCredential(
    secret: string,
    kind: CredentialKind,
    providerId: string,
    surface?: { readonly backendId: string; readonly surfaceId: string }
  ): Promise<string> {
    const transport = this.requireTransport();
    const client = createClient(CredentialService, transport);
    const response = await client.beginCredentialUpload({
      kind,
      providerId,
      ...(surface === undefined ? {} : {
        backendId: surface.backendId,
        credentialSurfaceId: surface.surfaceId
      })
    }, this.#abort === undefined ? undefined : { signal: this.#abort.signal });
    const ticket = response.ticket;
    if (ticket === undefined || ticket.ticketId.length === 0 || ticket.relativeEndpoint.length === 0) {
      throw new GatewayError("Orchestrator has no credential channel available for this sensitive answer.");
    }
    const bytes = new TextEncoder().encode(secret);
    if (ticket.maximumBytes > 0n && BigInt(bytes.byteLength) > ticket.maximumBytes) {
      throw new GatewayError("The sensitive answer exceeds the credential channel limit.");
    }
    try {
      const upload = await fetch(this.authorizedEndpoint(ticket.relativeEndpoint), {
        method: "PUT",
        headers: {
          authorization: `Bearer ${this.#authKey ?? ""}`,
          "content-type": "application/octet-stream"
        },
        body: bytes,
        signal: this.#abort?.signal
      });
      if (!upload.ok) throw new GatewayError(`Sensitive answer upload failed (${upload.status}).`);
      return ticket.ticketId;
    } finally {
      bytes.fill(0);
    }
  }

  private commitManagedModelRuntime(runtime: ManagedModelRuntime | undefined): ManagedModelRuntimeView {
    if (runtime === undefined) throw new GatewayError("Orchestrator returned no managed model runtime state.");
    const value = mapManagedModelRuntime(runtime);
    if (this.#snapshot !== undefined) {
      const snapshot = {
        ...this.#snapshot,
        managedModelRuntimes: upsertBy(this.#snapshot.managedModelRuntimes ?? [], value, (item) => item.id)
      };
      this.#snapshot = snapshot;
      this.#callbacks.onSnapshot?.(snapshot);
    }
    return value;
  }

  private requireTransport(): Transport {
    if (this.#transport === undefined) throw new GatewayError("Connect to Orchestrator before performing this action.", { offline: true });
    return this.#transport;
  }

  private requireOwnedBrowserTakeover(browserId: string): NonNullable<BrowserProvider["takeover"]> {
    const takeover = this.#rawSnapshot?.browsers.find((browser) => browser.browserProviderId === browserId)?.takeover;
    if (takeover === undefined || takeover.state !== BrowserTakeoverState.ACTIVE || takeover.takeoverId.length === 0) {
      throw new GatewayError("There is no active browser takeover.");
    }
    if (takeover.connectionId.length === 0 || takeover.connectionId !== this.#profile?.id) {
      throw new GatewayError("This browser takeover belongs to another connection.");
    }
    return takeover;
  }

  private requireBrowserCommentFence(browserId: string, pageId: string): {
    readonly browser: BrowserProvider;
    readonly takeover: NonNullable<BrowserProvider["takeover"]>;
  } {
    const browser = this.#rawSnapshot?.browsers.find((candidate) => candidate.browserProviderId === browserId);
    const takeover = this.requireOwnedBrowserTakeover(browserId);
    if (
      browser === undefined
      || takeover.pageId !== pageId
      || takeover.generation !== browser.generation
      || !browser.pages.some((page) => page.pageId === pageId && !page.recoverable)
    ) {
      throw new GatewayError("The Browser comment fence does not match this live page generation.");
    }
    return { browser, takeover };
  }

  private authorizedEndpoint(relativeEndpoint: string): string {
    if (this.#profile === undefined) throw new GatewayError("The authenticated connection is unavailable.");
    const base = new URL(this.#profile.origin);
    const endpoint = new URL(relativeEndpoint, base);
    if (!relativeEndpoint.startsWith("/") || endpoint.origin !== base.origin) {
      throw new GatewayError("Orchestrator returned an unsafe authenticated transfer endpoint.");
    }
    return endpoint.href;
  }
}

export type EventContinuity = "contiguous" | "duplicate" | "gap" | "generationChanged" | "missingCursor";

export function classifyEventContinuity(
  generation: bigint | undefined,
  sequence: bigint | undefined,
  event: Event
): EventContinuity {
  const cursor = event.cursor;
  if (cursor === undefined) return "missingCursor";
  if (generation !== undefined && cursor.generation !== generation) return "generationChanged";
  if (sequence === undefined) return "contiguous";
  if (cursor.sequence <= sequence) return "duplicate";
  if (cursor.sequence > sequence + 1n) return "gap";
  return "contiguous";
}

export function transientUiEffectContinuitySafe(continuity: EventContinuity): boolean {
  return continuity === "contiguous";
}

export interface EventProjectionResult {
  readonly rawSnapshot: Snapshot;
  readonly snapshot: AppSnapshot;
  readonly refresh: "none" | "batched" | "authoritative";
}

/**
 * Applies one already continuity-checked event to the client projection.
 * Entity events contain complete replacements, while token/tool/status events
 * update only the affected timeline row. Events that cannot carry enough
 * authority for a lossless projection request a coalesced snapshot refresh.
 */
export function projectSnapshotEvent(
  rawSnapshot: Snapshot,
  snapshot: AppSnapshot,
  event: Event
): EventProjectionResult {
  const cursor = event.cursor;
  let raw: Snapshot = {
    ...rawSnapshot,
    ...(cursor === undefined ? {} : { resumeCursor: cursor, generation: cursor.generation })
  };
  let projected: AppSnapshot = {
    ...snapshot,
    ...(cursor === undefined ? {} : { cursor: cursor.sequence, generation: cursor.generation })
  };
  let refresh: EventProjectionResult["refresh"] = "none";
  let diagnosticsChanged = false;
  const kind = event.payload?.kind;

  if (kind?.case === "projectionInvalidated") {
    return { rawSnapshot: raw, snapshot: projected, refresh: "authoritative" };
  }
  if (kind?.case === undefined) {
    return { rawSnapshot: raw, snapshot: projected, refresh: "batched" };
  }

  if (isTimelineEvent(kind.case) && !isVisionBridgeStatusEvent(event)) {
    raw = { ...raw, timeline: [...raw.timeline, event] };
    projected = { ...projected, timelineBySession: projectTimelineEvent(projected.timelineBySession, event) };
    if (kind.case === "runtimeRecoveryChanged") {
      const sessionId = event.identity?.sessionId ?? "";
      if (sessionId.length > 0) projected = remapSessionProjection(raw, projected, sessionId);
    }
  }

  switch (kind.case) {
    case "connectionChanged": {
      const connection = kind.value.connection;
      if (connection !== undefined) {
        raw = { ...raw, connections: upsertBy(raw.connections, connection, (value) => value.connectionId) };
        projected = { ...projected, remoteConnections: upsertBy(projected.remoteConnections, mapRemoteConnection(connection), (value) => value.id) };
      }
      break;
    }
    case "backendChanged": {
      const backend = kind.value.backend;
      if (backend !== undefined) {
        raw = { ...raw, backends: upsertBy(raw.backends, backend, (value) => value.backendId) };
        projected = { ...projected, backends: upsertBy(projected.backends, mapBackend(backend), (value) => value.id) };
        diagnosticsChanged = true;
      }
      break;
    }
    case "targetChanged": {
      const target = kind.value.target;
      if (target !== undefined) {
        raw = { ...raw, targets: upsertBy(raw.targets, target, (value) => value.targetId) };
        projected = { ...projected, targets: upsertBy(projected.targets, mapTargetView(target, raw.workspaces), (value) => value.id) };
        diagnosticsChanged = true;
      }
      break;
    }
    case "sessionChanged": {
      const session = kind.value.session;
      if (session !== undefined) {
        raw = { ...raw, sessions: upsertBy(raw.sessions, session, (value) => value.sessionId) };
        projected = remapSessionProjection(raw, projected, session.sessionId);
        diagnosticsChanged = true;
      }
      break;
    }
    case "sessionAttentionChanged": {
      const sessionId = event.identity?.sessionId ?? "";
      const attention = kind.value.attention;
      const session = raw.sessions.find((candidate) => candidate.sessionId === sessionId);
      if (attention !== undefined && session !== undefined) {
        const updated = { ...session, attention };
        raw = { ...raw, sessions: upsertBy(raw.sessions, updated, (value) => value.sessionId) };
        projected = remapSessionProjection(raw, projected, sessionId);
        diagnosticsChanged = true;
      }
      break;
    }
    case "runChanged": {
      const run = kind.value.run;
      if (run !== undefined) {
        raw = { ...raw, runs: upsertBy(raw.runs, run, (value) => value.runId) };
        projected = remapSessionProjection(raw, projected, run.sessionId);
        diagnosticsChanged = true;
      }
      break;
    }
    case "attemptChanged": {
      const attempt = kind.value.attempt;
      if (attempt !== undefined) {
        const run = raw.runs.find((candidate) => candidate.runId === attempt.runId);
        if (run !== undefined) {
          const updated = { ...run, attempts: upsertBy(run.attempts, attempt, (value) => value.attemptId) };
          raw = { ...raw, runs: upsertBy(raw.runs, updated, (value) => value.runId) };
          projected = remapSessionProjection(raw, projected, run.sessionId);
          diagnosticsChanged = true;
        }
      }
      break;
    }
    case "queueItemChanged": {
      const queueItem = kind.value.queueItem;
      if (queueItem !== undefined) {
        raw = { ...raw, queueItems: upsertBy(raw.queueItems, queueItem, (value) => value.queueItemId) };
        projected = { ...projected, queue: upsertBy(projected.queue, mapQueueItem(queueItem), (value) => value.id) };
        diagnosticsChanged = true;
      }
      break;
    }
    case "queueControlChanged": {
      const control = kind.value.queueControl;
      if (control !== undefined) {
        raw = { ...raw, queueControls: upsertBy(raw.queueControls, control, (value) => value.sessionId) };
        projected = { ...projected, queueControls: upsertBy(projected.queueControls, mapQueueControl(control), (value) => value.sessionId) };
      }
      break;
    }
    case "scheduleChanged": {
      const schedule = kind.value.schedule;
      if (schedule !== undefined) {
        raw = { ...raw, schedules: upsertBy(raw.schedules, schedule, (value) => value.scheduleId) };
        projected = { ...projected, schedules: upsertBy(projected.schedules, mapSchedule(schedule), (value) => value.id) };
        diagnosticsChanged = true;
      }
      break;
    }
    case "operationChanged": {
      const operation = kind.value.operation;
      if (operation !== undefined) raw = { ...raw, operations: upsertBy(raw.operations, operation, (value) => value.operationId) };
      break;
    }
    case "artifactProduced": {
      const artifact = kind.value.artifact;
      if (artifact !== undefined) raw = { ...raw, artifacts: upsertBy(raw.artifacts, artifact, (value) => value.artifactId) };
      break;
    }
    case "workspaceDiffProduced":
      // A diff does not contain the resulting workspace descriptor/tree.
      refresh = "batched";
      break;
    case "interactionChanged": {
      const interaction = kind.value.interaction;
      if (interaction !== undefined) {
        raw = { ...raw, interactions: upsertBy(raw.interactions, interaction, (value) => value.interactionId) };
        const visible = raw.interactions.filter((value) => value.state === InteractionState.PENDING).map(mapInteraction);
        projected = { ...projected, interactions: visible };
      }
      break;
    }
    case "backgroundTaskChanged": {
      const task = kind.value.backgroundTask;
      if (task !== undefined) {
        raw = {
          ...raw,
          backgroundTasks: upsertBy(
            raw.backgroundTasks,
            task,
            (value) => `${value.sessionId}\0${value.backgroundTaskId}`
          )
        };
        projected = {
          ...projected,
          backgroundTasks: upsertBy(
            projected.backgroundTasks,
            mapBackgroundTaskActivity(task),
            (value) => `${value.sessionId}\0${value.id}`
          )
        };
      }
      break;
    }
    case "extensionWidgetChanged": {
      const widget = kind.value.widget;
      if (widget !== undefined) {
        const sameWidget = (candidate: ExtensionWidget): boolean =>
          candidate.sessionId === widget.sessionId && candidate.widgetKey === widget.widgetKey;
        const previous = raw.extensionWidgets.find(sameWidget);
        if (previous !== undefined && compareProtoTimestamps(widget.updatedAt, previous.updatedAt) < 0) break;
        raw = {
          ...raw,
          // Retain an explicit in-stream removal as a tombstone. It fences a
          // late update without making removed state visible in the mapped view.
          extensionWidgets: upsertBy(raw.extensionWidgets, widget, (candidate) => `${candidate.sessionId}\u0000${candidate.widgetKey}`)
        };
        projected = { ...projected, extensionWidgetsBySession: mapExtensionWidgets(raw.extensionWidgets) };
      }
      break;
    }
    case "extensionStatusChanged": {
      const status = kind.value.status;
      if (status !== undefined) {
        const sameStatus = (candidate: ExtensionStatus): boolean =>
          candidate.sessionId === status.sessionId && candidate.statusKey === status.statusKey;
        const previous = raw.extensionStatuses.find(sameStatus);
        if (previous !== undefined && compareProtoTimestamps(status.updatedAt, previous.updatedAt) < 0) break;
        raw = {
          ...raw,
          extensionStatuses: upsertBy(raw.extensionStatuses, status, (candidate) => `${candidate.sessionId}\u0000${candidate.statusKey}`)
        };
        projected = { ...projected, extensionStatusesBySession: mapExtensionStatuses(raw.extensionStatuses) };
      }
      break;
    }
    case "retryChanged": {
      const run = raw.runs.find((candidate) => candidate.runId === kind.value.runId);
      if (run !== undefined) {
        const state = kind.value.state === RetryState.EXHAUSTED
          ? RunState.FAILED
          : kind.value.state === RetryState.SUCCEEDED
            ? RunState.RUNNING
            : kind.value.state === RetryState.WAITING || kind.value.state === RetryState.STARTED
              ? RunState.RETRYING
              : run.state;
        const { error: _previousRetryError, ...runWithoutRetryError } = run;
        const updated = { ...runWithoutRetryError, state, ...(kind.value.error === undefined ? {} : { error: kind.value.error }) };
        raw = { ...raw, runs: upsertBy(raw.runs, updated, (value) => value.runId) };
        projected = remapSessionProjection(raw, projected, run.sessionId);
        diagnosticsChanged = true;
      }
      break;
    }
    case "contextUsageChanged": {
      const sessionId = event.identity?.sessionId ?? "";
      const session = raw.sessions.find((candidate) => candidate.sessionId === sessionId);
      if (session !== undefined) {
        const updated = { ...session, context: kind.value.context };
        raw = { ...raw, sessions: upsertBy(raw.sessions, updated, (value) => value.sessionId) };
        projected = remapSessionProjection(raw, projected, sessionId);
      }
      break;
    }
    case "nativeBranchChanged": {
      const sessionId = kind.value.productSessionId || event.identity?.sessionId || "";
      const session = raw.sessions.find((candidate) => candidate.sessionId === sessionId);
      raw = { ...raw, ...(kind.value.tree === undefined ? {} : { nativeSessionTree: kind.value.tree }) };
      if (session !== undefined) {
        const updated = { ...session, activeNativeEntryId: kind.value.activeEntryId };
        raw = { ...raw, sessions: upsertBy(raw.sessions, updated, (value) => value.sessionId) };
        projected = remapSessionProjection(raw, projected, sessionId);
      }
      if (kind.value.timelineRebuilt) refresh = "batched";
      break;
    }
    case "runtimeCommandsChanged": {
      const sessionId = event.identity?.sessionId ?? "";
      if (sessionId === "") break;
      const observed = kind.value.commands.map((command) => ({ ...command, sessionId }));
      raw = {
        ...raw,
        runtimeCommands: [
          ...raw.runtimeCommands.filter((command) =>
            command.sessionId !== "" && command.sessionId !== sessionId
          ),
          ...observed
        ]
      };
      projected = {
        ...projected,
        commands: raw.runtimeCommands.filter((command) => command.loaded).map(mapRuntimeCommand)
      };
      break;
    }
    case "reviewRunChanged": {
      const reviewRun = kind.value.reviewRun;
      if (reviewRun !== undefined) {
        raw = { ...raw, reviewRuns: upsertBy(raw.reviewRuns, reviewRun, (value) => value.reviewRunId) };
        projected = {
          ...projected,
          reviewRuns: upsertBy(projected.reviewRuns, mapReviewRun(reviewRun), (value) => value.id)
        };
      }
      break;
    }
    case "sessionReset": {
      const sessionId = kind.value.productSessionId || event.identity?.sessionId || "";
      if (sessionId === "") {
        refresh = "authoritative";
        break;
      }
      const timelineBySession = new Map(projected.timelineBySession);
      timelineBySession.delete(sessionId);
      const extensionWidgetsBySession = new Map(projected.extensionWidgetsBySession);
      extensionWidgetsBySession.delete(sessionId);
      const extensionStatusesBySession = new Map(projected.extensionStatusesBySession);
      extensionStatusesBySession.delete(sessionId);
      raw = {
        ...raw,
        timeline: raw.timeline.filter((candidate) => candidate.identity?.sessionId !== sessionId),
        runs: raw.runs.filter((candidate) => candidate.sessionId !== sessionId),
        queueItems: raw.queueItems.filter((candidate) => candidate.sessionId !== sessionId),
        queueControls: raw.queueControls.filter((candidate) => candidate.sessionId !== sessionId),
        interactions: raw.interactions.filter((candidate) => candidate.sessionId !== sessionId),
        artifacts: raw.artifacts.filter((candidate) => candidate.sessionId !== sessionId),
        toolLeases: raw.toolLeases.filter((candidate) => candidate.sessionId !== sessionId),
        backgroundTasks: raw.backgroundTasks.filter((candidate) => candidate.sessionId !== sessionId),
        runtimeCommands: raw.runtimeCommands.filter((candidate) => candidate.sessionId !== sessionId),
        extensionWidgets: raw.extensionWidgets.filter((candidate) => candidate.sessionId !== sessionId),
        extensionStatuses: raw.extensionStatuses.filter((candidate) => candidate.sessionId !== sessionId)
      };
      projected = {
        ...remapSessionProjection(raw, projected, sessionId),
        timelineBySession,
        extensionWidgetsBySession,
        extensionStatusesBySession,
        queue: projected.queue.filter((candidate) => candidate.sessionId !== sessionId),
        queueControls: projected.queueControls.filter((candidate) => candidate.sessionId !== sessionId),
        interactions: projected.interactions.filter((candidate) => candidate.sessionId !== sessionId),
        backgroundTasks: projected.backgroundTasks.filter((candidate) => candidate.sessionId !== sessionId),
        commands: projected.commands.filter((candidate) => candidate.sessionId !== sessionId)
      };
      diagnosticsChanged = true;
      // The reset event intentionally carries only the boundary identity. A
      // fresh snapshot supplies the new binding generation and authoritative
      // empty projections after the eager local clear above.
      refresh = "authoritative";
      break;
    }
    case "historyPruned": {
      const sessionId = kind.value.productSessionId || event.identity?.sessionId || "";
      if (sessionId === "") {
        refresh = "authoritative";
        break;
      }
      const timelineBySession = new Map(projected.timelineBySession);
      timelineBySession.delete(sessionId);
      const extensionWidgetsBySession = new Map(projected.extensionWidgetsBySession);
      extensionWidgetsBySession.delete(sessionId);
      const extensionStatusesBySession = new Map(projected.extensionStatusesBySession);
      extensionStatusesBySession.delete(sessionId);
      raw = {
        ...raw,
        timeline: raw.timeline.filter((candidate) => candidate.identity?.sessionId !== sessionId),
        runs: raw.runs.filter((candidate) => candidate.sessionId !== sessionId),
        queueItems: raw.queueItems.filter((candidate) => candidate.sessionId !== sessionId),
        queueControls: raw.queueControls.filter((candidate) => candidate.sessionId !== sessionId),
        interactions: raw.interactions.filter((candidate) => candidate.sessionId !== sessionId),
        toolLeases: raw.toolLeases.filter((candidate) => candidate.sessionId !== sessionId),
        backgroundTasks: raw.backgroundTasks.filter((candidate) => candidate.sessionId !== sessionId),
        runtimeCommands: raw.runtimeCommands.filter((candidate) => candidate.sessionId !== sessionId),
        extensionWidgets: raw.extensionWidgets.filter((candidate) => candidate.sessionId !== sessionId),
        extensionStatuses: raw.extensionStatuses.filter((candidate) => candidate.sessionId !== sessionId)
      };
      projected = {
        ...remapSessionProjection(raw, projected, sessionId),
        timelineBySession,
        extensionWidgetsBySession,
        extensionStatusesBySession,
        queue: projected.queue.filter((candidate) => candidate.sessionId !== sessionId),
        queueControls: projected.queueControls.filter((candidate) => candidate.sessionId !== sessionId),
        interactions: projected.interactions.filter((candidate) => candidate.sessionId !== sessionId),
        backgroundTasks: projected.backgroundTasks.filter((candidate) => candidate.sessionId !== sessionId),
        commands: projected.commands.filter((candidate) => candidate.sessionId !== sessionId)
      };
      diagnosticsChanged = true;
      refresh = "authoritative";
      break;
    }
    case "messageDeleted": {
      // Never infer an assistant turn or splice the transcript client-side.
      // Store owns the user-row/assistant-round semantics and the surviving
      // authoritative projection.
      const sessionId = kind.value.productSessionId || event.identity?.sessionId || "";
      if (sessionId.length > 0) {
        projected = withTimelineHistoryInvalidation(projected, sessionId, event.cursor?.sequence ?? projected.cursor);
      }
      refresh = "authoritative";
      break;
    }
    case "resourceChanged": {
      const resource = kind.value.resource;
      if (resource !== undefined) {
        raw = { ...raw, resources: upsertBy(raw.resources, resource, (value) => value.resourceId) };
        projected = {
          ...projected,
          resources: raw.resources.filter((value) => value.state !== ResourceState.REMOVED).map(mapResource)
        };
        diagnosticsChanged = true;
      }
      break;
    }
    case "browserChanged": {
      const browser = kind.value.browser;
      if (browser !== undefined) {
        raw = { ...raw, browsers: upsertBy(raw.browsers, browser, (value) => value.browserProviderId) };
        projected = { ...projected, browsers: upsertBy(projected.browsers, mapBrowser(browser), (value) => value.id) };
        diagnosticsChanged = true;
      }
      break;
    }
    case "browserPageChanged": {
      const page = kind.value.page;
      if (page !== undefined) {
        const browser = raw.browsers.find((candidate) => candidate.browserProviderId === page.browserProviderId);
        if (browser !== undefined) {
          const updated = { ...browser, pages: upsertBy(browser.pages, page, (value) => value.pageId) };
          raw = { ...raw, browsers: upsertBy(raw.browsers, updated, (value) => value.browserProviderId) };
          projected = { ...projected, browsers: upsertBy(projected.browsers, mapBrowser(updated), (value) => value.id) };
        }
      }
      break;
    }
    case "toolProviderChanged": {
      const provider = kind.value.provider;
      if (provider !== undefined) raw = { ...raw, toolProviders: upsertBy(raw.toolProviders, provider, (value) => value.toolProviderId) };
      break;
    }
    case "mcpServerChanged": {
      const server = kind.value.server;
      if (server !== undefined) {
        raw = { ...raw, mcpServers: upsertBy(raw.mcpServers, server, (value) => value.mcpServerId) };
        if (raw.settings !== undefined) {
          raw = { ...raw, settings: { ...raw.settings, mcpServers: upsertBy(raw.settings.mcpServers, server, (value) => value.mcpServerId) } };
        }
        projected = {
          ...projected,
          settings: { ...projected.settings, mcpServers: upsertBy(projected.settings.mcpServers, mapMcpServer(server), (value) => value.id) }
        };
      }
      break;
    }
    case "settingsChanged": {
      const settings = kind.value.settings;
      if (settings !== undefined) {
        raw = { ...raw, settings };
        const mappedSettings = mapSettings(settings);
        const rawProviders = new Map(raw.providers.map((provider) => [
          providerKey(provider.backendId, provider.providerId),
          provider
        ] as const));
        projected = {
          ...projected,
          settings: mappedSettings,
          models: raw.models.map((model) => {
            const provider = rawProviders.get(providerKey(model.backendId, model.key?.providerId ?? ""));
            return mapModel(
              model,
              provider,
              modelRouteEnabled(
                mappedSettings,
                model.backendId,
                model.key?.providerId ?? "",
                model.key?.modelId ?? "",
                provider?.ownerManaged === true
              )
            );
          }),
          providers: raw.providers.map((provider) => mapProviderRuntime(
            provider,
            providerRouteEnabled(mappedSettings, provider.backendId, provider.providerId, provider.ownerManaged)
          ))
        };
        for (const session of raw.sessions) projected = remapSessionProjection(raw, projected, session.sessionId);
      }
      break;
    }
    case "browserTransferChanged": {
      const transfer = kind.value.transfer;
      if (transfer !== undefined) raw = { ...raw, browserTransfers: upsertBy(raw.browserTransfers, transfer, (value) => value.browserTransferId) };
      break;
    }
    case "runDone": {
      ({ raw, projected } = projectTerminalRun(raw, projected, kind.value.runId, RunState.SUCCEEDED, kind.value.usage));
      diagnosticsChanged = true;
      break;
    }
    case "runAborted": {
      ({ raw, projected } = projectTerminalRun(raw, projected, kind.value.runId, RunState.ABORTED));
      diagnosticsChanged = true;
      break;
    }
    case "terminalError": {
      const runId = event.identity?.runId ?? "";
      if (runId.length > 0) ({ raw, projected } = projectTerminalRun(raw, projected, runId, RunState.FAILED, undefined, kind.value.error));
      diagnosticsChanged = true;
      break;
    }
    case "compactionChanged": {
      const sessionId = event.identity?.sessionId ?? "";
      const compacting = kind.value.state === CompactionState.STARTED
        ? true
        : kind.value.state === CompactionState.COMPLETED
          || kind.value.state === CompactionState.NO_OP
          || kind.value.state === CompactionState.ABORTED
          || kind.value.state === CompactionState.FAILED
          ? false
          : undefined;
      if (sessionId.length > 0 && compacting !== undefined) {
        const session = projected.sessions.find((candidate) => candidate.id === sessionId);
        if (session !== undefined) projected = {
          ...projected,
          sessions: upsertBy(projected.sessions, { ...session, compacting }, (candidate) => candidate.id)
        };
      }
      break;
    }
    case "messageStarted":
    case "textDelta":
    case "thinkingDelta":
    case "statusStream":
    case "messageCompleted":
    case "toolCallStarted":
    case "toolCallUpdated":
    case "toolCallCompleted":
    case "imageProduced":
    case "recoverableError":
    case "contextRebuilt":
    case "nativeSessionChanged":
    case "browserActivity":
      break;
  }

  if (diagnosticsChanged) projected = { ...projected, diagnostics: collectDiagnostics(raw) };
  return { rawSnapshot: raw, snapshot: projected, refresh };
}

function projectTerminalRun(
  raw: Snapshot,
  snapshot: AppSnapshot,
  runId: string,
  state: RunState,
  usage?: Snapshot["runs"][number]["usage"],
  error?: ErrorInfo
): { readonly raw: Snapshot; readonly projected: AppSnapshot } {
  const run = raw.runs.find((candidate) => candidate.runId === runId);
  if (run === undefined) return { raw, projected: snapshot };
  const updated = {
    ...run,
    state,
    ...(usage === undefined ? {} : { usage }),
    ...(error === undefined ? {} : { error })
  };
  const nextRaw = { ...raw, runs: upsertBy(raw.runs, updated, (value) => value.runId) };
  return { raw: nextRaw, projected: remapSessionProjection(nextRaw, snapshot, run.sessionId) };
}

function latestRetryableUncontinuedRun(
  runs: Snapshot["runs"],
  sessionId: string
): Snapshot["runs"][number] | undefined {
  const continuedRunIds = new Set(runs
    .map((run) => run.retryOfRunId)
    .filter((runId) => runId !== ""));
  return runs.filter((run) =>
    run.sessionId === sessionId
    && run.state === RunState.FAILED
    && run.error?.retryable === true
    && !continuedRunIds.has(run.runId)
  ).at(-1);
}

function remapSessionProjection(raw: Snapshot, snapshot: AppSnapshot, sessionId: string): AppSnapshot {
  const session = raw.sessions.find((candidate) => candidate.sessionId === sessionId);
  if (session === undefined) return snapshot;
  const providers = new Map(raw.providers.map((provider) => [providerKey(provider.backendId, provider.providerId), provider] as const));
  const models = new Map(raw.models.map((model) => [modelKey(model), model] as const));
  const activeRun = raw.runs.filter((run) => run.sessionId === sessionId && isActiveRun(run.state)).at(-1);
  const failedRun = latestRetryableUncontinuedRun(raw.runs, sessionId);
  const existingCompacting = snapshot.sessions.find((candidate) => candidate.id === sessionId)?.compacting;
  return {
    ...snapshot,
    sessions: upsertBy(
      snapshot.sessions,
      projectSessionRuntimeRecovery(
        mapSession(
          session,
          providers,
          models,
          activeRun,
          failedRun,
          existingCompacting
        ),
        snapshot.timelineBySession.get(sessionId) ?? []
      ),
      (value) => value.id
    )
  };
}

function mapTargetView(target: Snapshot["targets"][number], workspaces: readonly WorkspaceDescriptor[]): AppSnapshot["targets"][number] {
  const workspace = workspaces.find((candidate) => candidate.workspaceId === target.workspaceId);
  return {
    id: target.targetId,
    backendId: target.backendId,
    name: target.displayName,
    workspaceId: target.workspaceId,
    workspaceName: workspace?.displayName ?? target.workspaceId,
    trusted: workspace?.trusted ?? false,
    pinned: target.pinned,
    archived: target.state === 2,
    ...(target.remoteWorkspace === undefined ? {} : {
      remoteWorkspace: {
        hostId: target.remoteWorkspace.hostId,
        workspaceRoot: target.remoteWorkspace.workspaceRootDisplay
      }
    }),
    ...(target.error?.message ? { error: presentJokoServiceTerminology(target.error.message) } : {})
  };
}

function upsertBy<T>(values: readonly T[], value: T, key: (value: T) => string): T[] {
  const identity = key(value);
  const index = values.findIndex((candidate) => key(candidate) === identity);
  if (index < 0) return [...values, value];
  const result = [...values];
  result[index] = value;
  return result;
}

function isTimelineEvent(kind: NonNullable<NonNullable<Event["payload"]>["kind"]>["case"]): boolean {
  return kind === "messageStarted"
    || kind === "textDelta"
    || kind === "thinkingDelta"
    || kind === "statusStream"
    || kind === "messageCompleted"
    || kind === "toolCallStarted"
    || kind === "toolCallUpdated"
    || kind === "toolCallCompleted"
    || kind === "imageProduced"
    || kind === "artifactProduced"
    || kind === "workspaceDiffProduced"
    || kind === "interactionChanged"
    || kind === "backgroundTaskChanged"
    || kind === "reviewRunChanged"
    || kind === "retryChanged"
    || kind === "compactionChanged"
    || kind === "contextRebuilt"
    || kind === "runDone"
    || kind === "runAborted"
    || kind === "recoverableError"
    || kind === "terminalError"
    || kind === "runtimeRecoveryChanged";
}

function projectTimelineEvent(
  timeline: ReadonlyMap<string, readonly TimelineItemView[]>,
  event: Event
): ReadonlyMap<string, readonly TimelineItemView[]> {
  if (isVisionBridgeStatusEvent(event)) return timeline;
  const sessionId = event.identity?.sessionId ?? "";
  if (sessionId.length === 0) return timeline;
  const kind = event.payload?.kind;
  if (kind?.case === undefined) return timeline;
  const items = [...(timeline.get(sessionId) ?? [])];
  const sequence = event.cursor?.sequence ?? event.identity?.sequence ?? 0n;
  const createdAt = timestampMs(event.occurredAt);
  let changed = true;

  const replaceOrAppend = (item: TimelineItemView, identity: (candidate: TimelineItemView) => boolean = (candidate) => candidate.id === item.id): void => {
    const index = items.findIndex(identity);
    if (index < 0) items.push(item);
    else items[index] = item;
  };

  switch (kind.case) {
    case "messageStarted": {
      const existing = items.find((item) => item.id === kind.value.messageId);
      const userInput = kind.value.role === 1 ? kind.value.userInput : undefined;
      const userText = kind.value.role === 1 ? messageInputText(userInput) : undefined;
      const pastedTextRanges = userText === undefined
        ? []
        : messageInputPastedTextRanges(userInput, userText);
      const rawAutomationOrigin = kind.value.automationOrigin;
      const automationOrigin = rawAutomationOrigin !== undefined && rawAutomationOrigin.scheduleId.trim().length > 0
        ? {
            kind: "scheduler" as const,
            scheduleId: rawAutomationOrigin.scheduleId,
            ...(rawAutomationOrigin.scheduleName === "" ? {} : { scheduleName: rawAutomationOrigin.scheduleName }),
            ...(rawAutomationOrigin.runId === "" ? {} : { runId: rawAutomationOrigin.runId })
          }
        : existing?.automationOrigin;
      const inputDelivery = uiMessageInputDelivery(kind.value.inputDelivery);
      replaceOrAppend({
        id: kind.value.messageId,
        messageId: kind.value.messageId,
        sourceEventId: event.eventId,
        ...timelineNativeMessageIdentity(event, existing),
        ...(event.identity?.runId ? { runId: event.identity.runId } : {}),
        sequence: existing?.sequence ?? sequence,
        kind: kind.value.role === 1 ? "user" : "assistant",
        createdAt: existing?.createdAt ?? createdAt,
        text: kind.value.role === 1 ? userText : existing?.text ?? "",
        ...(kind.value.role === 1 ? { attachments: inputAttachments(userInput) } : {}),
        ...(kind.value.role === 1 && kind.value.quotesEncoded === true ? { quotesEncoded: true } : {}),
        ...(kind.value.role === 1 && pastedTextRanges.length > 0 ? { pastedTextRanges } : {}),
        ...(kind.value.role === 1 && automationOrigin !== undefined ? { automationOrigin } : {}),
        ...(kind.value.role === 1 && inputDelivery !== undefined ? { inputDelivery } : {}),
        ...(kind.value.role === 1 && kind.value.automaticContinuation && kind.value.runtimeRecoveryId.trim().length > 0
          ? { automaticContinuation: { recoveryId: kind.value.runtimeRecoveryId } }
          : {}),
        streaming: kind.value.role !== 1
      });
      break;
    }
    case "textDelta": {
      const contentIndex = kind.value.contentIndex;
      const existing = items.find((item) =>
        item.kind === "assistant"
        && isProjectedMessageItem(item, kind.value.messageId)
      );
      const textBlocks = [...(existing?.messageTextBlocks
        ?? (existing?.text === undefined || existing.text.length === 0
          ? []
          : [{ contentIndex, text: existing.text }]))];
      const blockIndex = textBlocks.findIndex((block) => block.contentIndex === contentIndex);
      const updatedBlock = {
        contentIndex,
        text: `${blockIndex < 0 ? "" : textBlocks[blockIndex]?.text ?? ""}${kind.value.delta}`
      };
      if (blockIndex < 0) textBlocks.push(updatedBlock);
      else textBlocks[blockIndex] = updatedBlock;
      textBlocks.sort((left, right) => left.contentIndex - right.contentIndex);
      replaceOrAppend({
        id: kind.value.messageId,
        messageId: kind.value.messageId,
        sourceEventId: existing?.sourceEventId ?? event.eventId,
        ...timelineNativeMessageIdentity(event, existing),
        ...(existing?.runId || event.identity?.runId ? { runId: existing?.runId || event.identity?.runId } : {}),
        sequence: existing?.sequence ?? sequence,
        kind: "assistant",
        createdAt: existing?.createdAt ?? createdAt,
        text: textBlocks.map((block) => block.text).join(""),
        messageTextBlocks: textBlocks,
        streaming: true
      });
      break;
    }
    case "thinkingDelta": {
      const id = `${kind.value.messageId}:thinking:${kind.value.contentIndex}`;
      const existing = items.find((item) => item.id === id);
      replaceOrAppend({
        id,
        messageId: kind.value.messageId,
        contentIndex: kind.value.contentIndex,
        ...(existing?.runId || event.identity?.runId ? { runId: existing?.runId || event.identity?.runId } : {}),
        sequence: existing?.sequence ?? sequence,
        kind: "thinking",
        createdAt: existing?.createdAt ?? createdAt,
        text: `${existing?.text ?? ""}${kind.value.delta}`,
        streaming: true
      });
      break;
    }
    case "messageCompleted": {
      const usage = kind.value.usage === undefined
        ? undefined
        : timelineMessageUsage(
          kind.value.usage,
          kind.value.generationDurationMs,
          kind.value.generationReliable
        );
      if (kind.value.role !== 1) {
        changed = reconcileCompletedAssistantMessage(items, event, kind.value, sequence, createdAt, usage);
        break;
      }
      let found = false;
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        if (item !== undefined && item.id === kind.value.messageId) {
          const finalText = completedMessageText(kind.value.blocks);
          const attachments = completedMessageAttachments(kind.value.blocks);
          items[index] = {
            ...item,
            messageId: kind.value.messageId,
            streaming: false,
            sourceEventId: event.eventId,
            ...timelineNativeMessageIdentity(event, item),
            ...(kind.value.blocks.length === 0 ? {} : { text: finalText, attachments })
          };
          found = true;
        }
      }
      changed = found;
      break;
    }
    case "toolCallStarted":
    case "toolCallUpdated":
    case "toolCallCompleted": {
      const call = kind.value.toolCall;
      if (call === undefined) {
        changed = false;
        break;
      }
      const existing = items.find((item) => item.id === call.toolCallId);
      const result = kind.case === "toolCallUpdated" ? kind.value.incrementalResult : call.result;
      const outputMode: "preserve" | "append" | "replace" = kind.case === "toolCallUpdated"
        ? kind.value.outputMode === ToolCallOutputMode.APPEND ? "append" : "replace"
        : kind.case === "toolCallCompleted" ? "replace" : "preserve";
      const toolItem = mapToolItem(
        call,
        existing?.sequence ?? sequence,
        existing?.createdAt ?? createdAt,
        existing,
        result,
        outputMode
      );
      const referencedBlobs = new Set((toolItem.attachments ?? []).map((attachment) => attachment.blobId));
      if (referencedBlobs.size > 0) {
        for (let index = items.length - 1; index >= 0; index -= 1) {
          const item = items[index];
          if (item?.artifact !== undefined && referencedBlobs.has(item.artifact.blobId)) items.splice(index, 1);
        }
      }
      replaceOrAppend(toolItem);
      break;
    }
    case "statusStream": {
      const id = kind.value.statusId || event.eventId;
      const existing = items.find((item) => item.id === id);
      const runId = event.identity?.runId || existing?.runId;
      replaceOrAppend({
        id,
        ...(runId ? { runId } : {}),
        sequence: existing?.sequence ?? sequence,
        kind: "status",
        createdAt: existing?.createdAt ?? createdAt,
        title: kind.value.label,
        text: kind.value.detail,
        streaming: !kind.value.terminal
      });
      break;
    }
    case "artifactProduced": {
      const artifact = kind.value.artifact;
      if (artifact === undefined) changed = false;
      else replaceOrAppend({ id: event.eventId, sequence, kind: "artifact", createdAt, title: artifact.title, artifact: mapArtifact(artifact) });
      break;
    }
    case "imageProduced": {
      const image = kind.value.image;
      const blob = image?.blob;
      replaceOrAppend({
        id: event.eventId,
        sequence,
        kind: "image",
        createdAt,
        title: image?.altText || "Image",
        text: blob?.fileName ?? "",
        ...(blob?.blobId
          ? { artifact: { id: blob.blobId, blobId: blob.blobId, title: image?.altText || blob.fileName || "Image", kind: "image", fileName: blob.fileName || "image", mediaType: blob.mediaType || "application/octet-stream", byteSize: numberValue(blob.byteSize) } satisfies ArtifactView }
          : {})
      });
      break;
    }
    case "workspaceDiffProduced": {
      const diff = kind.value.diff;
      const changeSet = kind.value.changeSet;
      const mapped = diff === undefined ? { files: [], truncated: false, repositoryRevision: "", source: "unspecified" as const } : mapWorkspaceDiff(diff);
      replaceOrAppend({
        id: event.eventId,
        sequence,
        kind: "diff",
        createdAt,
        title: "Workspace changes",
        text: `${mapped.files.length} changed files`,
        workspaceDiff: {
          ...mapped,
          workspaceId: diff?.workspaceId || changeSet?.workspaceId || "",
          ...(changeSet?.changeSetId ? { changeSetId: changeSet.changeSetId } : {}),
          completeBaseline: changeSet?.completeBaseline ?? false,
          gaps: (changeSet?.gaps ?? []).map((gap) => `${gap.relativePath}: ${gap.explanation}`),
          generatedFiles: projectTimelineGeneratedFiles(changeSet)
        }
      });
      break;
    }
    case "interactionChanged": {
      const interaction = kind.value.interaction;
      if (interaction === undefined) changed = false;
      else {
        const mapped = mapTimelineInteraction(interaction);
        const existing = items.find((item) => item.interaction?.id === interaction.interactionId);
        replaceOrAppend({
          id: `interaction:${interaction.interactionId}`,
          sequence: existing?.sequence ?? sequence,
          kind: "interaction",
          createdAt: existing?.createdAt ?? (interaction.createdAt === undefined ? createdAt : timestampMs(interaction.createdAt)),
          title: mapped.title,
          text: mapped.prompt,
          interaction: mapped
        }, (candidate) => candidate.interaction?.id === interaction.interactionId);
      }
      break;
    }
    case "backgroundTaskChanged": {
      const task = kind.value.backgroundTask;
      if (task === undefined) changed = false;
      else {
        const existing = items.find((item) => item.background?.id === task.backgroundTaskId);
        replaceOrAppend({
          id: existing?.id ?? event.eventId,
          sequence: existing?.sequence ?? sequence,
          kind: "background",
          createdAt: existing?.createdAt ?? (task.createdAt === undefined ? createdAt : timestampMs(task.createdAt)),
          title: task.displayName,
          background: {
            id: task.backgroundTaskId,
            title: task.displayName,
            state: backgroundState(task.state),
            updatedAt: task.updatedAt === undefined ? createdAt : timestampMs(task.updatedAt),
            ...(task.statusText.length === 0 ? {} : { detail: task.statusText }),
            ...(task.parentTaskId.length === 0 ? {} : { parentTaskId: task.parentTaskId }),
            ...(task.runId.length === 0 ? {} : { runId: task.runId }),
            ...(task.progressRatio === undefined || !Number.isFinite(task.progressRatio)
              ? {}
              : { progressRatio: Math.max(0, Math.min(1, task.progressRatio)) }),
            ...(task.startedAt === undefined ? {} : { startedAt: timestampMs(task.startedAt) }),
            ...(task.endedAt === undefined ? {} : { endedAt: timestampMs(task.endedAt) }),
            ...(task.error === undefined ? {} : { error: mapError(task.error, task.runId) })
          }
        }, (candidate) => candidate.background?.id === task.backgroundTaskId);
      }
      break;
    }
    case "retryChanged": {
      const maxAttempts = kind.value.maxAttempts;
      replaceOrAppend({
        id: event.eventId,
        ...(kind.value.runId || event.identity?.runId ? { runId: kind.value.runId || event.identity?.runId } : {}),
        sequence,
        kind: "status",
        createdAt,
        title: "Retry",
        text: kind.value.error?.message || `Attempt ${kind.value.attemptNumber}`,
        retry: {
          state: retryTimelineState(kind.value.state),
          source: kind.value.error?.code === "PI_SUMMARIZATION_RETRY" ? "summarization" : kind.value.state === RetryState.WAITING ? "auto" : "unknown",
          attemptNumber: kind.value.attemptNumber,
          ...(maxAttempts === undefined || maxAttempts <= 0 ? {} : { maxAttempts }),
          ...(kind.value.retryAt === undefined ? {} : { retryAt: timestampMs(kind.value.retryAt) }),
          ...(kind.value.error === undefined ? {} : { error: mapError(kind.value.error, kind.value.runId || event.identity?.runId) })
        }
      });
      break;
    }
    case "runtimeRecoveryChanged": {
      const recovery = kind.value;
      if (
        recovery.recoveryId.trim().length === 0
        || recovery.sourceRunId.trim().length === 0
        || recovery.error === undefined
      ) throw new GatewayError("Orchestrator returned an invalid runtime recovery event.");
      const existing = items.find((item) => item.runtimeRecovery?.id === recovery.recoveryId);
      replaceOrAppend({
        id: existing?.id ?? `runtime-recovery:${recovery.recoveryId}`,
        sourceEventId: event.eventId,
        ...(recovery.continuationRunId.length > 0 ? { runId: recovery.continuationRunId } : {}),
        sequence: existing?.sequence ?? sequence,
        kind: "runtimeRecovery",
        createdAt: existing?.createdAt ?? createdAt,
        runtimeRecovery: {
          id: recovery.recoveryId,
          sourceRunId: recovery.sourceRunId,
          ...(recovery.continuationRunId.length === 0 ? {} : { continuationRunId: recovery.continuationRunId }),
          state: runtimeRecoveryTimelineState(recovery.state),
          attempt: positiveTimelineInteger(recovery.attempt, "runtime recovery attempt"),
          maximumAttempts: positiveTimelineInteger(recovery.maximumAttempts, "runtime recovery attempt limit"),
          sessionTotal: positiveTimelineInteger(recovery.sessionTotal, "runtime recovery session total"),
          ...(recovery.delayMs <= 0 ? {} : { delayMs: positiveTimelineInteger(recovery.delayMs, "runtime recovery delay") }),
          ...(recovery.routeChanged ? { routeChanged: true } : {}),
          error: mapError(recovery.error, recovery.continuationRunId || recovery.sourceRunId)
        }
      }, (candidate) => candidate.runtimeRecovery?.id === recovery.recoveryId);
      break;
    }
    case "reviewRunChanged": {
      const review = kind.value.reviewRun;
      if (review === undefined || review.sourceSessionId !== sessionId) {
        changed = false;
        break;
      }
      const mapped = mapReviewRun(review);
      const existing = items.find((item) => item.review?.id === mapped.id);
      replaceOrAppend({
        id: `review:${mapped.id}`,
        sequence: existing?.sequence ?? sequence,
        kind: "review",
        createdAt: existing?.createdAt ?? mapped.createdAt,
        title: "Review",
        review: mapped
      }, (candidate) => candidate.review?.id === mapped.id);
      break;
    }
    case "compactionChanged": {
      const compactionId = kind.value.compactionId || event.eventId;
      const existing = items.find((item) => item.compaction?.id === compactionId);
      const existingCompaction = existing?.compaction;
      const state = compactionTimelineState(kind.value.state);
      const incomingReason = compactionTimelineReason(kind.value.reason, kind.value.automatic);
      const preserveStartDefaults = incomingReason === "unknown" && existingCompaction !== undefined;
      const reason = preserveStartDefaults ? existingCompaction.reason : incomingReason;
      const automatic = preserveStartDefaults ? existingCompaction.automatic : kind.value.automatic;
      const incomingTokensBefore = numberValue(kind.value.tokensBefore);
      const incomingTokensAfter = numberValue(kind.value.tokensAfter);
      const tokensBefore = incomingTokensBefore > 0 ? incomingTokensBefore : existingCompaction?.tokensBefore;
      const tokensAfter = incomingTokensAfter > 0 ? incomingTokensAfter : existingCompaction?.tokensAfter;
      const boundaryId = kind.value.boundaryId || existingCompaction?.boundaryId;
      const willRetry = kind.value.willRetry ?? existingCompaction?.willRetry;
      replaceOrAppend({
        id: existing?.id ?? event.eventId,
        sequence: existing?.sequence ?? sequence,
        kind: "compaction",
        createdAt: existing?.createdAt ?? createdAt,
        ...(kind.value.error?.message ? { text: presentJokoServiceTerminology(kind.value.error.message) } : {}),
        compaction: {
          id: compactionId,
          state,
          reason,
          automatic,
          ...(boundaryId === undefined || boundaryId.length === 0 ? {} : { boundaryId }),
          ...(tokensBefore === undefined ? {} : { tokensBefore }),
          ...(tokensAfter === undefined ? {} : { tokensAfter }),
          ...(willRetry === undefined ? {} : { willRetry })
        }
      }, (candidate) => candidate.compaction?.id === compactionId);
      break;
    }
    case "contextRebuilt": {
      const rebuilt = kind.value;
      const reason = contextRebuildTimelineReason(rebuilt.reason);
      if (
        reason === undefined
        || rebuilt.handoff.trim().length === 0
        || (rebuilt.productSessionId.length > 0 && rebuilt.productSessionId !== sessionId)
      ) {
        changed = false;
        break;
      }
      replaceOrAppend({
        id: event.eventId,
        sequence,
        kind: "contextRebuild",
        createdAt,
        contextRebuild: {
          reason,
          handoff: rebuilt.handoff,
          ...(rebuilt.sourceRunId.length === 0 ? {} : { sourceRunId: rebuilt.sourceRunId }),
          replayScheduled: rebuilt.replayScheduled
        }
      });
      break;
    }
    case "recoverableError":
    case "terminalError": {
      const error = kind.value.error;
      replaceOrAppend({
        id: event.eventId,
        ...(event.identity?.runId ? { runId: event.identity.runId } : {}),
        ...(kind.case === "terminalError" ? { runTerminal: "failed" as const } : {}),
        sequence,
        kind: "error",
        createdAt,
        title: error?.code || "Error",
        text: error?.message,
        ...(error === undefined ? {} : { error: mapError(error, event.identity?.runId) })
      });
      break;
    }
    case "runDone":
      replaceOrAppend({
        id: event.eventId,
        ...(event.identity?.runId ? { runId: event.identity.runId } : {}),
        runTerminal: "completed",
        sequence,
        kind: "status",
        createdAt,
        title: "Task complete"
      });
      break;
    case "runAborted":
      replaceOrAppend({
        id: event.eventId,
        ...(event.identity?.runId ? { runId: event.identity.runId } : {}),
        runTerminal: "aborted",
        sequence,
        kind: "status",
        createdAt,
        title: "Task stopped",
        text: kind.value.reason
      });
      break;
    default:
      changed = false;
      break;
  }

  if (!changed) return timeline;
  return new Map(timeline).set(sessionId, items);
}

function isProjectedMessageItem(item: TimelineItemView, messageId: string): boolean {
  return item.messageId === messageId
    || item.id === messageId
    || item.id.startsWith(`${messageId}:text:`)
    || item.id.startsWith(`${messageId}:thinking:`);
}

function reconcileCompletedAssistantMessage(
  items: TimelineItemView[],
  event: Event,
  completed: ProtoMessageCompletedEvent,
  sequence: bigint,
  createdAt: number,
  usage: TimelineItemView["usage"] | undefined
): boolean {
  const messageId = completed.messageId;
  const existingContent = items.filter((item) =>
    (item.kind === "assistant" || item.kind === "thinking")
    && isProjectedMessageItem(item, messageId)
  );
  const finalToolCallIds = new Set(completed.blocks.flatMap((block) =>
    block.content.case === "toolCall" || block.content.case === "toolResult"
      ? [block.content.value.callId]
      : []
  ));
  const existingToolItems = new Map(items.flatMap((item) =>
    finalToolCallIds.has(item.id) && (item.kind === "tool" || item.kind === "toolResult")
      ? [[item.id, item] as const]
      : []
  ));
  const firstTextIndex = completed.blocks.findIndex((block) => block.content.case === "text");
  const finalText = completedMessageText(completed.blocks);
  const attachments = completedMessageAttachments(completed.blocks);
  const finalItems: Array<{ readonly contentIndex: number; readonly item: TimelineItemView }> = [];
  const projectedToolItems = new Map<string, { contentIndex: number; item: TimelineItemView }>();

  for (let contentIndex = 0; contentIndex < completed.blocks.length; contentIndex += 1) {
    const block = completed.blocks[contentIndex];
    if (block === undefined) continue;
    if (block.content.case === "text") {
      if (contentIndex !== firstTextIndex) continue;
      const existing = existingContent.find((item) => item.kind === "assistant" && item.id === messageId)
        ?? existingContent.find((item) => item.kind === "assistant");
      finalItems.push({
        contentIndex,
        item: {
          id: messageId,
          messageId,
          contentIndex,
          sourceEventId: event.eventId,
          ...timelineNativeMessageIdentity(event, existing),
          ...(existing?.runId || event.identity?.runId ? { runId: existing?.runId || event.identity?.runId } : {}),
          sequence: existing?.sequence ?? sequence,
          kind: "assistant",
          createdAt: existing?.createdAt ?? createdAt,
          text: finalText,
          streaming: false,
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(usage === undefined ? {} : { usage })
        }
      });
      continue;
    }
    if (block.content.case === "thinking") {
      const id = `${messageId}:thinking:${contentIndex}`;
      const existing = existingContent.find((item) =>
        item.kind === "thinking" && (item.contentIndex === contentIndex || item.id === id)
      );
      finalItems.push({
        contentIndex,
        item: {
          id,
          messageId,
          contentIndex,
          ...(existing?.runId || event.identity?.runId ? { runId: existing?.runId || event.identity?.runId } : {}),
          sequence: existing?.sequence ?? sequence,
          kind: "thinking",
          createdAt: existing?.createdAt ?? createdAt,
          text: block.content.value.text,
          streaming: false
        }
      });
      continue;
    }
    if (block.content.case === "toolCall") {
      const value = block.content.value;
      const existing = projectedToolItems.get(value.callId)?.item ?? existingToolItems.get(value.callId);
      projectedToolItems.set(value.callId, {
        contentIndex: projectedToolItems.get(value.callId)?.contentIndex ?? contentIndex,
        item: {
          id: value.callId,
          messageId,
          contentIndex,
          ...(existing?.runId || event.identity?.runId ? { runId: existing?.runId || event.identity?.runId } : {}),
          sequence: existing?.sequence ?? sequence,
          kind: existing?.kind === "toolResult" ? "toolResult" : "tool",
          createdAt: existing?.createdAt ?? createdAt,
          title: value.name,
          streaming: false,
          tool: {
            id: value.callId,
            name: value.name,
            state: existing?.tool?.state ?? "requested",
            input: value.input,
            ...(existing?.tool?.output === undefined ? {} : { output: existing.tool.output }),
            isError: existing?.tool?.isError ?? false
          },
          ...(existing?.attachments === undefined ? {} : { attachments: existing.attachments })
        }
      });
      continue;
    }
    if (block.content.case === "toolResult") {
      const value = block.content.value;
      const projected = projectedToolItems.get(value.callId);
      const existing = projected?.item ?? existingToolItems.get(value.callId);
      projectedToolItems.set(value.callId, {
        contentIndex: projected?.contentIndex ?? contentIndex,
        item: {
          id: value.callId,
          messageId,
          contentIndex: projected?.contentIndex ?? contentIndex,
          ...(existing?.runId || event.identity?.runId ? { runId: existing?.runId || event.identity?.runId } : {}),
          sequence: existing?.sequence ?? sequence,
          kind: "toolResult",
          createdAt: existing?.createdAt ?? createdAt,
          title: existing?.tool?.name ?? "tool",
          streaming: false,
          tool: {
            id: value.callId,
            name: existing?.tool?.name ?? "tool",
            state: value.isError ? "failed" : "succeeded",
            input: existing?.tool?.input ?? "",
            output: value.output,
            isError: value.isError
          },
          ...(existing?.attachments === undefined ? {} : { attachments: existing.attachments })
        }
      });
    }
  }

  if (firstTextIndex < 0 && attachments.length > 0) {
    const contentIndex = completed.blocks.findIndex((block) =>
      block.content.case === "image" || block.content.case === "artifact"
    );
    const existing = existingContent.find((item) => item.kind === "assistant");
    finalItems.push({
      contentIndex,
      item: {
        id: messageId,
        messageId,
        contentIndex,
        sourceEventId: event.eventId,
        ...timelineNativeMessageIdentity(event, existing),
        ...(existing?.runId || event.identity?.runId ? { runId: existing?.runId || event.identity?.runId } : {}),
        sequence: existing?.sequence ?? sequence,
        kind: "assistant",
        createdAt: existing?.createdAt ?? createdAt,
        text: "",
        streaming: false,
        attachments,
        ...(usage === undefined ? {} : { usage })
      }
    });
  }

  for (const projected of projectedToolItems.values()) finalItems.push(projected);
  finalItems.sort((left, right) => left.contentIndex - right.contentIndex);

  const removableIndexes = items.flatMap((item, index) =>
    ((item.kind === "assistant" || item.kind === "thinking") && isProjectedMessageItem(item, messageId))
      || finalToolCallIds.has(item.id) && (item.kind === "tool" || item.kind === "toolResult")
      ? [index]
      : []
  );
  const insertionIndex = removableIndexes.length === 0 ? items.length : Math.min(...removableIndexes);
  for (let index = removableIndexes.length - 1; index >= 0; index -= 1) {
    const itemIndex = removableIndexes[index];
    if (itemIndex !== undefined) items.splice(itemIndex, 1);
  }
  items.splice(insertionIndex, 0, ...finalItems.map((entry) => entry.item));
  return removableIndexes.length > 0 || finalItems.length > 0;
}

function completedMessageText(blocks: readonly ProtoMessageBlock[]): string {
  return blocks.flatMap((block) => block.content.case === "text" ? [block.content.value] : []).join("");
}

function completedMessageAttachments(blocks: readonly ProtoMessageBlock[]): readonly ArtifactView[] {
  return blocks.flatMap((block): ArtifactView[] => {
    const image = block.content.case === "image" ? block.content.value : undefined;
    const artifact = block.content.case === "artifact" ? block.content.value : undefined;
    const blob = image?.blob ?? artifact?.blob;
    if (blob === undefined || blob.blobId.length === 0) return [];
    const kind = image === undefined ? "file" as const : "image" as const;
    const fileName = blob.fileName || (kind === "image" ? "image" : "file");
    return [{
      id: blob.blobId,
      blobId: blob.blobId,
      title: image?.altText || artifact?.label || fileName,
      kind,
      fileName,
      mediaType: blob.mediaType || "application/octet-stream",
      byteSize: numberValue(blob.byteSize)
    }];
  });
}

export function extensionUiEffect(event: Event): ExtensionUiEffect | undefined {
  const payload = event.payload?.kind;
  if (payload?.case !== "extensionUiEffect") return undefined;
  const kind = payload.value.kind === ExtensionUiEffectKind.NOTIFICATION
    ? "notification"
    : payload.value.kind === ExtensionUiEffectKind.TITLE
      ? "title"
      : payload.value.kind === ExtensionUiEffectKind.EDITOR_TEXT ? "editorText" : undefined;
  if (kind === undefined) return undefined;
  const sessionId = event.identity?.sessionId ?? "";
  if (sessionId.length === 0) return undefined;
  const common = { eventId: event.eventId, sessionId, text: payload.value.text } as const;
  if (kind !== "notification") return { ...common, kind };
  return { ...common, kind, notificationKind: extensionNotificationKind(payload.value.notificationKind) };
}

function extensionNotificationKind(value: ProtoExtensionNotificationKind): ExtensionNotificationKind {
  switch (value) {
    case ProtoExtensionNotificationKind.INFO: return "info";
    case ProtoExtensionNotificationKind.WARNING: return "warning";
    case ProtoExtensionNotificationKind.ERROR: return "error";
    default: return "unknown";
  }
}

/**
 * A Device may be reused only after an anonymous probe matches both the exact
 * origin and the saved Orchestrator node identity. Desktop-managed recovery stays
 * anonymous because its retained bearer may be the rejected credential being
 * repaired. The server performs the final connection-to-device ownership fence.
 */
export function reusablePairingDeviceId(
  profile: ConnectionProfile | undefined,
  authKey: string | undefined,
  origin: string,
  serverId: string
): string | undefined {
  if (
    profile === undefined
    || profile.deviceId.length === 0
    || profile.managedLocal === true
    || profile.serverId !== serverId
    || authKey === undefined
    || authKey.length === 0
  ) return undefined;
  try {
    return new URL(profile.origin).href === new URL(origin).href ? profile.deviceId : undefined;
  } catch {
    return undefined;
  }
}

export function createOrchestratorGateway(
  profile: ConnectionProfile | undefined,
  authKey: string | undefined,
  callbacks: GatewayCallbacks,
  transportFactory: GatewayTransportFactory = transportFor
): OrchestratorGateway {
  return new ConnectOrchestratorGateway(profile, authKey, callbacks, transportFactory);
}

const VISION_BRIDGE_STATUS_KINDS = new Map<string, VisionBridgeUiEffect["kind"]>([
  ["vision-bridge-recognizing", "recognizing"],
  ["vision-bridge-fallback", "fallback"],
  ["vision-bridge-unavailable", "unavailable"],
  ["vision-bridge-clear", "clear"]
]);

/** Extracts only the content-free Vision Bridge UI protocol. Generic output
 * and terminal events clear a still-running recognizing toast, but remain
 * otherwise untouched by the timeline projection. */
export function visionBridgeUiEffect(event: Event): VisionBridgeUiEffect | undefined {
  const sessionId = event.identity?.sessionId ?? "";
  if (sessionId.length === 0) return undefined;
  const payload = event.payload?.kind;
  if (payload?.case === "statusStream") {
    const key = payload.value.statusId || payload.value.label;
    const kind = VISION_BRIDGE_STATUS_KINDS.get(key);
    if (kind === undefined) return undefined;
    const parsedCount = Number.parseInt(payload.value.detail, 10);
    return {
      eventId: event.eventId,
      sessionId,
      kind,
      ...(kind === "recognizing" && Number.isSafeInteger(parsedCount) && parsedCount > 0
        ? { imageCount: parsedCount }
        : {})
    };
  }

  if (
    payload?.case === "textDelta" ||
    payload?.case === "thinkingDelta" ||
    payload?.case === "messageCompleted" ||
    payload?.case === "toolCallStarted" ||
    payload?.case === "imageProduced" ||
    payload?.case === "runDone" ||
    payload?.case === "runAborted" ||
    payload?.case === "terminalError"
  ) return { eventId: event.eventId, sessionId, kind: "clear" };
  return undefined;
}

export function isVisionBridgeStatusEvent(event: Event): boolean {
  const payload = event.payload?.kind;
  if (payload?.case !== "statusStream") return false;
  return VISION_BRIDGE_STATUS_KINDS.has(payload.value.statusId || payload.value.label);
}

/** One-shot authenticated runtime query for the Desktop-owned local Orchestrator.
 * It intentionally does not load a Snapshot or open an event stream. */
export function probeOrchestratorRuntimeActivityAt(
  origin: string,
  authKey: string,
  signal?: AbortSignal,
  transportFactory: GatewayTransportFactory = transportFor
): Promise<boolean> {
  return probeRuntimeActivityWithTransport(transportFactory(origin, authKey), signal);
}

/** Probes node identity without an Authorization header. This must run before
 * a saved bearer is decrypted and attached to a reconnect request. */
export async function probeOrchestratorOrigin(
  origin: string,
  signal: AbortSignal = AbortSignal.timeout(2_000),
  transportFactory: GatewayTransportFactory = transportFor
): Promise<OrchestratorIdentity> {
  const client = createClient(ConnectionService, transportFactory(origin));
  return mapServerIdentity((await client.getServerInfo({}, { signal })).server);
}

/** Lists public bootstrap candidates without ever constructing an auth
 * interceptor. The contacted node may contribute its short-lived LAN cache. */
export async function discoverOrchestratorNodesAt(
  origin: string,
  signal: AbortSignal = AbortSignal.timeout(2_000),
  transportFactory: GatewayTransportFactory = transportFor
): Promise<readonly DiscoveredOrchestratorView[]> {
  const normalizedOrigin = normalizeOrchestratorOrigin(origin);
  const client = createClient(ConnectionService, transportFactory(normalizedOrigin));
  const identity = mapServerIdentity((await client.getServerInfo({}, { signal })).server);
  const current = discoveredView({
    serverId: identity.serverId,
    displayName: identity.displayName,
    origin: normalizedOrigin,
    version: identity.version,
    apiVersion: identity.apiVersion,
    pairingEnabled: identity.pairingEnabled,
    lastSeenAt: Date.now()
  }, "current");
  let nodes: readonly DiscoveredOrchestratorView[] = [];
  try {
    const response = await client.listDiscoveredNodes({}, { signal });
    nodes = response.nodes.flatMap((node) => {
      try {
        return [discoveredView({
          serverId: node.serverId,
          displayName: node.displayName,
          origin: node.origin,
          version: node.version,
          apiVersion: node.apiVersion,
          pairingEnabled: node.pairingEnabled,
          lastSeenAt: node.lastSeen === undefined ? Date.now() : timestampMs(node.lastSeen)
        }, "orchestrator")];
      } catch {
        return [];
      }
    });
  } catch {
    throw new GatewayError("Joko node discovery is unavailable.");
  }
  return dedupeDiscoveredNodes([current, ...nodes]);
}

function discoveredView(
  value: {
    readonly serverId: string;
    readonly displayName: string;
    readonly origin: string;
    readonly version: string;
    readonly apiVersion: string;
    readonly pairingEnabled: boolean;
    readonly lastSeenAt: number;
  },
  source: DiscoveredOrchestratorView["source"]
): DiscoveredOrchestratorView {
  const origin = normalizeOrchestratorOrigin(value.origin);
  if (value.serverId.trim() === "" || value.apiVersion.trim() === "") throw new GatewayError("Discovery returned an invalid Joko node identity.");
  const url = new URL(origin);
  return {
    serverId: value.serverId,
    name: value.displayName || "Joko",
    origin,
    version: value.version,
    apiVersion: value.apiVersion,
    pairingEnabled: value.pairingEnabled,
    lastSeenAt: value.lastSeenAt,
    source,
    transport: url.protocol === "https:"
      ? "https"
      : isInsecureLanOrigin(origin)
        ? "lanHttp"
        : isLoopbackHostname(url.hostname)
          ? "loopbackHttp"
          : "lanHttp"
  };
}

function dedupeDiscoveredNodes(nodes: readonly DiscoveredOrchestratorView[]): readonly DiscoveredOrchestratorView[] {
  const byOrigin = new Map<string, DiscoveredOrchestratorView>();
  for (const node of nodes) {
    const previous = byOrigin.get(node.origin);
    if (previous === undefined || node.lastSeenAt > previous.lastSeenAt || (previous.source === "orchestrator" && node.source === "current")) {
      byOrigin.set(node.origin, node);
    }
  }
  return [...byOrigin.values()];
}

function mapServerIdentity(server: { readonly serverId: string; readonly displayName: string; readonly version: string; readonly apiVersion: string; readonly pairingEnabled: boolean } | undefined): OrchestratorIdentity {
  if (server === undefined || server.serverId.trim() === "" || server.apiVersion.trim() === "") {
    throw new GatewayError("The address did not return a valid Joko node identity.");
  }
  return {
    serverId: server.serverId,
    displayName: server.displayName || "Joko",
    version: server.version,
    apiVersion: server.apiVersion,
    pairingEnabled: server.pairingEnabled
  };
}

function transportFor(origin: string, authKey?: string): Transport {
  const interceptors: Interceptor[] = [];
  if (authKey !== undefined) {
    interceptors.push((next) => async (request) => {
      request.header.set("authorization", `Bearer ${authKey}`);
      request.header.set("x-joko-client-version", APP_VERSION);
      return next(request);
    });
  }
  return createConnectTransport({ baseUrl: origin, interceptors, useBinaryFormat: true });
}

async function loadWorkspaceEntries(
  transport: Transport,
  workspaces: readonly WorkspaceDescriptor[],
  signal?: AbortSignal
): Promise<ReadonlyMap<string, readonly WorkspaceEntry[]>> {
  const client = createClient(WorkspaceService, transport);
  const pairs = await Promise.all(workspaces.map(async (workspace) => {
    try {
      const entries: WorkspaceEntry[] = [];
      const consumedTokens = new Set<string>();
      let pageToken = "";
      let revision: string | undefined;
      for (let pageIndex = 0; pageIndex < MAX_COMPLETE_MESSAGE_SEARCH_PAGES; pageIndex += 1) {
        const response = await client.listWorkspaceEntries({
          workspaceId: workspace.workspaceId,
          parentRelativePath: "",
          includeHidden: false,
          page: { pageSize: 500, pageToken }
        }, signal === undefined ? undefined : { signal });
        const currentRevision = response.revision?.etag || response.revision?.value.toString(10) || "0";
        if (revision === undefined) revision = currentRevision;
        else if (currentRevision !== revision) throw new GatewayError("Workspace entries changed while the root directory was loading.");
        entries.push(...response.entries);
        const nextPageToken = response.page?.nextPageToken ?? "";
        if (nextPageToken === "") return [workspace.workspaceId, entries] as const;
        if (nextPageToken === pageToken || consumedTokens.has(nextPageToken)) {
          throw new GatewayError("Orchestrator returned a cyclic Workspace root page token.");
        }
        consumedTokens.add(nextPageToken);
        pageToken = nextPageToken;
      }
      throw new GatewayError("Workspace root directory exceeded the safe pagination limit.");
    } catch {
      return [workspace.workspaceId, [] as WorkspaceEntry[]] as const;
    }
  }));
  return new Map(pairs);
}

async function loadManagedModelRuntimes(
  transport: Transport,
  signal?: AbortSignal
): Promise<readonly ManagedModelRuntimeView[]> {
  try {
    const response = await createClient(ManagedModelRuntimeService, transport).listManagedModelRuntimes(
      {},
      signal === undefined ? undefined : { signal }
    );
    return response.runtimes.map(mapManagedModelRuntime);
  } catch (error) {
    if (signal?.aborted === true) throw error;
    // Runtime inventory enriches the owner Snapshot but is not required to
    // operate tasks. Isolated runtime-service faults do not hide the core
    // product; direct runtime actions still report their own typed failures.
    return [];
  }
}

export function mapSnapshot(
  snapshot: Snapshot,
  workspaceEntries: ReadonlyMap<string, readonly WorkspaceEntry[]> = new Map(),
  managedModelRuntimes: readonly ManagedModelRuntimeView[] = []
): AppSnapshot {
  const settings = mapSettings(snapshot.settings);
  const providers = new Map(snapshot.providers.map((provider) => [providerKey(provider.backendId, provider.providerId), provider] as const));
  const models = new Map(snapshot.models.map((model) => [modelKey(model), model] as const));
  const runsBySession = new Map<string, typeof snapshot.runs[number]>();
  const failedRunsBySession = new Map<string, typeof snapshot.runs[number]>();
  const continuedRunIds = new Set(snapshot.runs
    .map((run) => run.retryOfRunId)
    .filter((runId) => runId !== ""));
  for (const run of snapshot.runs) {
    if (isActiveRun(run.state)) runsBySession.set(run.sessionId, run);
    if (
      run.state === RunState.FAILED
      && run.error?.retryable === true
      && !continuedRunIds.has(run.runId)
    ) failedRunsBySession.set(run.sessionId, run);
  }
  const reviewRuns = snapshot.reviewRuns.map(mapReviewRun);
  const timelineBySession = withMissingRunningReviewCards(
    buildTimeline(snapshot.timeline),
    reviewRuns,
    snapshot.resumeCursor?.sequence ?? 0n
  );
  return {
    revision: snapshot.revision?.value ?? 0n,
    cursor: snapshot.resumeCursor?.sequence ?? 0n,
    generation: snapshot.generation,
    server: {
      name: snapshot.server?.displayName || "Joko",
      version: snapshot.server?.version ?? "",
      health: serverHealth(snapshot.server?.health)
    },
    backends: snapshot.backends.map(mapBackend),
    models: snapshot.models.map((model) => {
      const provider = providers.get(providerKey(model.backendId, model.key?.providerId ?? ""));
      return mapModel(
        model,
        provider,
        modelRouteEnabled(
          settings,
          model.backendId,
          model.key?.providerId ?? "",
          model.key?.modelId ?? "",
          provider?.ownerManaged === true
        )
      );
    }),
    providers: snapshot.providers.map((provider) => mapProviderRuntime(
      provider,
      providerRouteEnabled(settings, provider.backendId, provider.providerId, provider.ownerManaged)
    )),
    managedModelRuntimes,
    targets: snapshot.targets.map((target) => mapTargetView(target, snapshot.workspaces)),
    sessions: snapshot.sessions.map((session) => projectSessionRuntimeRecovery(
      mapSession(
        session,
        providers,
        models,
        runsBySession.get(session.sessionId),
        failedRunsBySession.get(session.sessionId)
      ),
      timelineBySession.get(session.sessionId) ?? []
    )),
    backgroundTasks: snapshot.backgroundTasks.map(mapBackgroundTaskActivity),
    timelineBySession,
    timelineHistoryRevisionBySession: new Map(),
    extensionWidgetsBySession: mapExtensionWidgets(snapshot.extensionWidgets),
    extensionStatusesBySession: mapExtensionStatuses(snapshot.extensionStatuses),
    queue: snapshot.queueItems.map(mapQueueItem),
    queueControls: snapshot.queueControls.map(mapQueueControl),
    interactions: snapshot.interactions.filter((interaction) => interaction.state === InteractionState.PENDING).map(mapInteraction),
    reviewRuns,
    workspaces: snapshot.workspaces.map((workspace) => mapWorkspace(workspace, workspaceEntries.get(workspace.workspaceId) ?? [])),
    schedules: snapshot.schedules.map(mapSchedule),
    browsers: snapshot.browsers.map(mapBrowser),
    extraDirectories: snapshot.extraDirectories.map(mapExtraDirectory),
    resources: snapshot.resources.filter((resource) => resource.state !== ResourceState.REMOVED).map(mapResource),
    commands: snapshot.runtimeCommands.filter((command) => command.loaded).map(mapRuntimeCommand),
    remoteConnections: snapshot.connections.map(mapRemoteConnection),
    devices: snapshot.devices.map(mapDevice),
    deviceControlRelations: snapshot.deviceControlRelations.map(mapDeviceControlRelation),
    settings,
    diagnostics: collectDiagnostics(snapshot)
  };
}

function mapExtensionWidgets(widgets: readonly ExtensionWidget[]): ReadonlyMap<string, readonly ExtensionWidgetView[]> {
  const grouped = new Map<string, ExtensionWidgetView[]>();
  for (const widget of widgets) {
    if (widget.sessionId.length === 0 || widget.removed) continue;
    const current = grouped.get(widget.sessionId) ?? [];
    current.push({
      sessionId: widget.sessionId,
      key: widget.widgetKey,
      lines: [...widget.lines],
      placement: widget.placement === ExtensionWidgetPlacement.BELOW_EDITOR ? "belowEditor" : "aboveEditor",
      updatedAt: timestampMs(widget.updatedAt)
    });
    grouped.set(widget.sessionId, current);
  }
  for (const [sessionId, values] of grouped) {
    grouped.set(sessionId, values.sort(compareExtensionStateOrder));
  }
  return grouped;
}

function mapExtensionStatuses(statuses: readonly ExtensionStatus[]): ReadonlyMap<string, readonly ExtensionStatusView[]> {
  const grouped = new Map<string, ExtensionStatusView[]>();
  for (const status of statuses) {
    if (status.sessionId.length === 0 || status.statusText === undefined) continue;
    const current = grouped.get(status.sessionId) ?? [];
    current.push({
      sessionId: status.sessionId,
      key: status.statusKey,
      text: status.statusText,
      updatedAt: timestampMs(status.updatedAt)
    });
    grouped.set(status.sessionId, current);
  }
  for (const [sessionId, values] of grouped) {
    grouped.set(sessionId, values.sort((left, right) => left.key.localeCompare(right.key)));
  }
  return grouped;
}

function voiceRpcOptions(
  connectionSignal: AbortSignal | undefined,
  requestSignal: AbortSignal | undefined
): { readonly signal: AbortSignal } | undefined {
  if (connectionSignal === undefined && requestSignal === undefined) return undefined;
  if (connectionSignal === undefined) return { signal: requestSignal! };
  if (requestSignal === undefined || requestSignal === connectionSignal) return { signal: connectionSignal };
  return { signal: AbortSignal.any([connectionSignal, requestSignal]) };
}

function remoteHostRpcOptions(
  connectionSignal: AbortSignal | undefined,
  requestSignal?: AbortSignal
): { readonly signal: AbortSignal } | undefined {
  const signal = combinedAbortSignal(connectionSignal, requestSignal);
  return signal === undefined ? undefined : { signal };
}

function mapVoiceInputCapability(profile: ProtoVoiceInputCapabilityProfile): VoiceInputCapabilityView {
  const limits = profile.limits;
  if (limits === undefined) throw new GatewayError("Orchestrator returned no voice input limits.");
  const supportedMimeTypes = [...new Set(limits.supportedMimeTypes.map((value) => {
    const normalized = value.trim().toLocaleLowerCase("en-US");
    if (normalized.length === 0 || normalized.length > 64) {
      throw new GatewayError("Orchestrator returned an invalid voice input media type.");
    }
    return normalized;
  }))];
  const support = voiceInputCapabilitySupport(profile.capability?.support);
  if (support === "supported" && supportedMimeTypes.length === 0) {
    throw new GatewayError("Orchestrator reported voice input support without a media type.");
  }
  return {
    support,
    ...(profile.capability?.reason.trim() ? { reason: profile.capability.reason.trim().slice(0, 512) } : {}),
    limits: {
      supportedMimeTypes,
      maximumAudioChunkBytes: voiceInputCounter(limits.maximumAudioChunkBytes, "audio chunk byte limit"),
      maximumAudioBytes: voiceInputCounter(limits.maximumAudioBytes, "audio byte limit"),
      maximumAudioChunkDurationMs: voiceInputDurationMs(limits.maximumAudioChunkDuration, "audio chunk duration limit"),
      maximumAudioDurationMs: voiceInputDurationMs(limits.maximumAudioDuration, "audio duration limit"),
      maximumLocaleCharacters: voiceInputNumber(limits.maximumLocaleCharacters, "locale character limit"),
      stableWaitMs: voiceInputDurationMs(limits.stableWait, "stable wait"),
      maximumConcurrentSessions: voiceInputNumber(limits.maximumConcurrentSessions, "concurrent session limit")
    },
    supportsLocale: profile.supportsLocale,
    supportsLiveDrafts: profile.supportsLiveDrafts,
    supportsRefinement: profile.supportsRefinement
  };
}

function voiceInputConnectionTestFailure(
  value: ProtoVoiceInputConnectionTestFailure
): Exclude<VoiceInputConnectionTestResultView, { readonly ok: true }>["reason"] {
  switch (value) {
    case ProtoVoiceInputConnectionTestFailure.CREDENTIALS_MISSING: return "credentialsMissing";
    case ProtoVoiceInputConnectionTestFailure.AUTHENTICATION_FAILED: return "authenticationFailed";
    case ProtoVoiceInputConnectionTestFailure.ROUTE_UNAVAILABLE: return "routeUnavailable";
    case ProtoVoiceInputConnectionTestFailure.TIMEOUT: return "timeout";
    case ProtoVoiceInputConnectionTestFailure.NETWORK: return "network";
    case ProtoVoiceInputConnectionTestFailure.SERVICE_ERROR: return "serviceError";
    case ProtoVoiceInputConnectionTestFailure.UNSPECIFIED:
      throw new GatewayError("Orchestrator returned no voice input connection test failure reason.");
  }
}

function mapVoiceInputDictionaryAction(value: {
  readonly action: VoiceInputDictionaryLearningActionType;
  readonly term: string;
  readonly aliases: readonly string[];
  readonly termType: VoiceInputDictionaryTermType;
  readonly confidence: VoiceInputDictionaryLearningConfidence;
}): VoiceInputDictionaryLearningActionView {
  const term = value.term.replace(/\s+/gu, " ").trim();
  if (term === "" || term.length > 120 || /[\u0000-\u001f\u007f]/u.test(term)) {
    throw new GatewayError("Orchestrator returned an invalid voice input dictionary term.");
  }
  const aliases = value.aliases.map((alias) => alias.replace(/\s+/gu, " ").trim());
  if (aliases.length === 0 || aliases.length > 5 || aliases.some((alias) => alias === "" || alias.length > 120 || /[\u0000-\u001f\u007f]/u.test(alias))) {
    throw new GatewayError("Orchestrator returned invalid voice input dictionary aliases.");
  }
  return Object.freeze({
    action: voiceInputDictionaryActionType(value.action),
    term,
    aliases: Object.freeze(aliases),
    type: voiceInputDictionaryTermType(value.termType),
    confidence: value.confidence === VoiceInputDictionaryLearningConfidence.HIGH
      ? "high"
      : value.confidence === VoiceInputDictionaryLearningConfidence.MEDIUM
        ? "medium"
        : (() => { throw new GatewayError("Orchestrator returned an unspecified voice input dictionary confidence."); })()
  });
}

function voiceInputDictionaryActionType(
  value: VoiceInputDictionaryLearningActionType
): VoiceInputDictionaryLearningActionView["action"] {
  switch (value) {
    case VoiceInputDictionaryLearningActionType.ADD_CANDIDATE: return "addCandidate";
    case VoiceInputDictionaryLearningActionType.ADD_ENTRY: return "addEntry";
    case VoiceInputDictionaryLearningActionType.UPDATE_ENTRY: return "updateEntry";
    case VoiceInputDictionaryLearningActionType.UNSPECIFIED:
      throw new GatewayError("Orchestrator returned an unspecified voice input dictionary action.");
  }
}

function voiceInputDictionaryTermType(
  value: VoiceInputDictionaryTermType
): VoiceInputDictionaryLearningActionView["type"] {
  switch (value) {
    case VoiceInputDictionaryTermType.PRODUCT_NAME: return "productName";
    case VoiceInputDictionaryTermType.PROJECT_NAME: return "projectName";
    case VoiceInputDictionaryTermType.TECHNICAL_TERM: return "technicalTerm";
    case VoiceInputDictionaryTermType.PERSON_NAME: return "personName";
    case VoiceInputDictionaryTermType.TEAM_NAME: return "teamName";
    case VoiceInputDictionaryTermType.CODE_NAME: return "codeName";
    case VoiceInputDictionaryTermType.PHRASE: return "phrase";
    case VoiceInputDictionaryTermType.OTHER: return "other";
    case VoiceInputDictionaryTermType.UNSPECIFIED:
      throw new GatewayError("Orchestrator returned an unspecified voice input dictionary term type.");
  }
}

function protoVoiceInputProtocol(value: VoiceInputTranscriptionProtocolView): VoiceInputTranscriptionProtocol {
  switch (value) {
    case "openAiCompatibleBatch": return VoiceInputTranscriptionProtocol.OPENAI_COMPATIBLE_BATCH;
    case "openAiCompatibleRealtime": return VoiceInputTranscriptionProtocol.OPENAI_COMPATIBLE_REALTIME;
    case "qwenCompatibleRealtime": return VoiceInputTranscriptionProtocol.QWEN_COMPATIBLE_REALTIME;
  }
}

function voiceInputProtocolView(value: VoiceInputTranscriptionProtocol): VoiceInputTranscriptionProtocolView {
  switch (value) {
    case VoiceInputTranscriptionProtocol.OPENAI_COMPATIBLE_BATCH: return "openAiCompatibleBatch";
    case VoiceInputTranscriptionProtocol.OPENAI_COMPATIBLE_REALTIME: return "openAiCompatibleRealtime";
    case VoiceInputTranscriptionProtocol.QWEN_COMPATIBLE_REALTIME: return "qwenCompatibleRealtime";
    case VoiceInputTranscriptionProtocol.UNSPECIFIED:
      throw new GatewayError("Orchestrator returned an unsupported voice input protocol.");
  }
}

function requireVoiceInputSession(value: ProtoVoiceInputSession | undefined): VoiceInputSessionView {
  if (value === undefined) throw new GatewayError("Orchestrator returned no voice input session.");
  const id = value.voiceInputId.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(id)) {
    throw new GatewayError("Orchestrator returned an invalid voice input identifier.");
  }
  const createdAt = voiceInputTimestamp(value.createdAt, "created");
  const updatedAt = voiceInputTimestamp(value.updatedAt, "updated");
  if (updatedAt < createdAt) throw new GatewayError("Orchestrator returned an invalid voice input update time.");
  if (value.nextChunkSequence < 1n) throw new GatewayError("Orchestrator returned an invalid voice input chunk sequence.");
  const outcome = voiceInputOutcome(value.outcome);
  return {
    id,
    state: voiceInputState(value.state),
    ...(outcome === undefined ? {} : { outcome }),
    ...(value.draft === undefined ? {} : { draft: {
      text: voiceInputText(value.draft.text),
      source: voiceInputTextSource(value.draft.source)
    } }),
    ...(value.result === undefined ? {} : { result: {
      text: voiceInputText(value.result.text),
      source: voiceInputTextSource(value.result.source),
      salvaged: value.result.salvaged,
      ...(value.result.rawTranscriptText === undefined
        ? {}
        : { rawTranscriptText: voiceInputText(value.result.rawTranscriptText) })
    } }),
    ...(value.failure === undefined ? {} : { failure: {
      code: voiceInputFailureCode(value.failure.code),
      transcriptKept: value.failure.transcriptKept
    } }),
    nextChunkSequence: value.nextChunkSequence,
    acceptedAudioBytes: voiceInputCounter(value.acceptedAudioBytes, "accepted audio bytes"),
    acceptedAudioDurationMs: voiceInputDurationMs(value.acceptedAudioDuration, "accepted audio duration"),
    createdAt,
    updatedAt,
    recoveryAttempts: voiceInputNumber(value.recoveryAttempts, "recovery count"),
    stallWarning: value.stallWarning
  };
}

function voiceInputCapabilitySupport(value: CapabilitySupport | undefined): VoiceInputCapabilitySupportView {
  switch (value) {
    case CapabilitySupport.SUPPORTED: return "supported";
    case CapabilitySupport.UPSTREAM_MISSING: return "upstreamMissing";
    case CapabilitySupport.NOT_IMPLEMENTED: return "notImplemented";
    case CapabilitySupport.PLATFORM_LIMITED: return "platformLimited";
    case CapabilitySupport.DISABLED_BY_POLICY: return "disabledByPolicy";
    case CapabilitySupport.TEMPORARILY_UNAVAILABLE: return "temporarilyUnavailable";
    case CapabilitySupport.UNSPECIFIED:
    case undefined: return "unspecified";
  }
}

function artifactStorageSupport(value: CapabilitySupport | undefined): ArtifactStorageMaintenanceSupportView {
  switch (value) {
    case CapabilitySupport.SUPPORTED: return "supported";
    case CapabilitySupport.UPSTREAM_MISSING: return "upstreamMissing";
    case CapabilitySupport.NOT_IMPLEMENTED: return "notImplemented";
    case CapabilitySupport.PLATFORM_LIMITED: return "platformLimited";
    case CapabilitySupport.DISABLED_BY_POLICY: return "disabledByPolicy";
    case CapabilitySupport.TEMPORARILY_UNAVAILABLE: return "temporarilyUnavailable";
    case CapabilitySupport.UNSPECIFIED:
    case undefined: return "unspecified";
  }
}

function artifactProtectedSha256(values: readonly string[]): string[] {
  if (values.length > 1_000) throw new GatewayError("Too many draft attachment digests were supplied.");
  const normalized = [...new Set(values.map((value) => value.trim().toLowerCase()))].sort();
  if (normalized.some((value) => !/^[a-f0-9]{64}$/u.test(value))) {
    throw new GatewayError("Draft attachment digests must be SHA-256 values.");
  }
  return normalized;
}

function artifactStorageCount(value: bigint): number {
  const result = exactSafeUnsignedNumber(value);
  if (result === undefined) throw new GatewayError("Orchestrator returned an invalid Artifact storage count.");
  return result;
}

function protoTaskHistoryRetention(value: TaskHistoryRetentionView): TaskHistoryRetention {
  switch (value) {
    case "7-days": return TaskHistoryRetention.SEVEN_DAYS;
    case "1-month": return TaskHistoryRetention.ONE_MONTH;
    case "3-months": return TaskHistoryRetention.THREE_MONTHS;
    case "6-months": return TaskHistoryRetention.SIX_MONTHS;
  }
}

function taskHistoryRetention(value: TaskHistoryRetention): TaskHistoryRetentionView {
  switch (value) {
    case TaskHistoryRetention.SEVEN_DAYS: return "7-days";
    case TaskHistoryRetention.ONE_MONTH: return "1-month";
    case TaskHistoryRetention.THREE_MONTHS: return "3-months";
    case TaskHistoryRetention.SIX_MONTHS: return "6-months";
    default: throw new GatewayError("Orchestrator returned an invalid task history retention window.");
  }
}

function taskHistoryCleanupResult(
  value: TaskHistoryCleanupResult
): Extract<TaskHistoryCleanupView, { readonly outcome: "completed" }> {
  return {
    outcome: "completed",
    activeTaskCount: artifactStorageCount(value.activeTaskCount),
    deletedTaskCount: artifactStorageCount(value.deletedTaskCount),
    archivedTaskCount: artifactStorageCount(value.archivedTaskCount),
    messageCount: artifactStorageCount(value.messageCount),
    beforeBytes: artifactStorageCount(value.beforeBytes),
    afterBytes: artifactStorageCount(value.afterBytes),
    reclaimedBytes: artifactStorageCount(value.reclaimedBytes),
    backupCreated: value.backupCreated,
    skippedTaskCount: artifactStorageCount(value.skippedTaskCount)
  };
}

function taskHistoryCleanupProgress(value: TaskHistoryMaintenanceProgress): TaskHistoryCleanupProgressView {
  if (!UUID_PATTERN.test(value.maintenanceId)) {
    throw new GatewayError("Orchestrator returned an invalid task history maintenance ID.");
  }
  if (!Number.isSafeInteger(value.percent) || value.percent < 0 || value.percent > 100) {
    throw new GatewayError("Orchestrator returned invalid task history cleanup progress.");
  }
  const phase = (() => {
    switch (value.phase) {
      case TaskHistoryMaintenancePhase.PREPARING: return "preparing" as const;
      case TaskHistoryMaintenancePhase.COPYING: return "copying" as const;
      case TaskHistoryMaintenancePhase.CLEANING: return "cleaning" as const;
      case TaskHistoryMaintenancePhase.COMPACTING: return "compacting" as const;
      case TaskHistoryMaintenancePhase.VERIFYING: return "verifying" as const;
      case TaskHistoryMaintenancePhase.INSTALLING: return "installing" as const;
      default: throw new GatewayError("Orchestrator returned an invalid task history cleanup phase.");
    }
  })();
  const common = {
    maintenanceId: value.maintenanceId,
    phase,
    percent: value.percent,
    updatedAt: timestampMs(value.updatedAt)
  };
  switch (value.status) {
    case TaskHistoryMaintenanceStatus.RUNNING:
      return { ...common, status: "running", cancellable: value.cancellable };
    case TaskHistoryMaintenanceStatus.COMPLETED:
      if (value.result === undefined) throw new GatewayError("Orchestrator returned no completed task history cleanup result.");
      return { ...common, status: "completed", cancellable: false, result: taskHistoryCleanupResult(value.result) };
    case TaskHistoryMaintenanceStatus.SCAN_EXPIRED:
      return { ...common, status: "scanExpired", cancellable: false };
    case TaskHistoryMaintenanceStatus.STORAGE_CHANGED:
      return { ...common, status: "storageChanged", cancellable: false };
    case TaskHistoryMaintenanceStatus.CANCELLED:
      return { ...common, status: "cancelled", cancellable: false };
    case TaskHistoryMaintenanceStatus.FAILED:
      return { ...common, status: "failed", cancellable: false };
    default:
      throw new GatewayError("Orchestrator returned an invalid task history cleanup status.");
  }
}

function voiceInputState(value: VoiceInputState): VoiceInputStateView {
  switch (value) {
    case VoiceInputState.IDLE: return "idle";
    case VoiceInputState.LISTENING: return "listening";
    case VoiceInputState.SUBMITTING: return "submitting";
    case VoiceInputState.REFINING: return "refining";
    case VoiceInputState.DONE: return "done";
    case VoiceInputState.ERROR: return "error";
    case VoiceInputState.UNSPECIFIED: throw new GatewayError("Orchestrator returned an unspecified voice input state.");
  }
}

function voiceInputOutcome(value: VoiceInputTerminalOutcome): VoiceInputOutcomeView | undefined {
  switch (value) {
    case VoiceInputTerminalOutcome.UNSPECIFIED: return undefined;
    case VoiceInputTerminalOutcome.SUCCESS: return "success";
    case VoiceInputTerminalOutcome.NO_SPEECH: return "noSpeech";
    case VoiceInputTerminalOutcome.FAILED: return "failed";
    case VoiceInputTerminalOutcome.CANCELLED: return "cancelled";
  }
}

function voiceInputTextSource(value: VoiceInputTextSource): VoiceInputTextSourceView {
  switch (value) {
    case VoiceInputTextSource.PARTIAL: return "partial";
    case VoiceInputTextSource.STABLE: return "stable";
    case VoiceInputTextSource.UNSPECIFIED: throw new GatewayError("Orchestrator returned an unspecified voice input text source.");
  }
}

function voiceInputFailureCode(value: VoiceInputFailureCode): VoiceInputFailureCodeView {
  switch (value) {
    case VoiceInputFailureCode.CONNECTION_INTERRUPTED: return "connectionInterrupted";
    case VoiceInputFailureCode.EMPTY_TRANSCRIPT: return "emptyTranscript";
    case VoiceInputFailureCode.HOST_SUBMISSION_FAILED: return "hostSubmissionFailed";
    case VoiceInputFailureCode.PROVIDER_AUTHENTICATION: return "providerAuthentication";
    case VoiceInputFailureCode.PROVIDER_CLOSE_FAILED: return "providerCloseFailed";
    case VoiceInputFailureCode.PROVIDER_ERROR: return "providerError";
    case VoiceInputFailureCode.PROVIDER_FLUSH_FAILED: return "providerFlushFailed";
    case VoiceInputFailureCode.PROVIDER_PROTOCOL: return "providerProtocol";
    case VoiceInputFailureCode.PROVIDER_QUOTA: return "providerQuota";
    case VoiceInputFailureCode.PROVIDER_START_FAILED: return "providerStartFailed";
    case VoiceInputFailureCode.UNSPECIFIED: throw new GatewayError("Orchestrator returned an unspecified voice input failure.");
  }
}

function voiceInputText(value: string): string {
  if (value.length > 200_000) throw new GatewayError("Orchestrator returned an oversized voice input transcript.");
  return value.replace(/\r\n?/gu, "\n");
}

function voiceInputCounter(value: bigint, label: string): number {
  const mapped = Number(value);
  if (!Number.isSafeInteger(mapped) || mapped < 0) throw new GatewayError(`Orchestrator returned an invalid voice input ${label}.`);
  return mapped;
}

function voiceInputNumber(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new GatewayError(`Orchestrator returned an invalid voice input ${label}.`);
  return value;
}

function voiceInputDurationMs(
  value: { readonly seconds: bigint; readonly nanos: number } | undefined,
  label: string
): number {
  if (value === undefined) throw new GatewayError(`Orchestrator returned no voice input ${label}.`);
  const mapped = Number(value.seconds) * 1_000 + Math.floor(value.nanos / 1_000_000);
  if (!Number.isSafeInteger(mapped) || mapped < 0) throw new GatewayError(`Orchestrator returned an invalid voice input ${label}.`);
  return mapped;
}

function voiceInputTimestamp(
  value: { readonly seconds: bigint; readonly nanos: number } | undefined,
  label: string
): number {
  if (value === undefined) throw new GatewayError(`Orchestrator returned no voice input ${label} time.`);
  const mapped = timestampMs(value);
  if (!Number.isSafeInteger(mapped) || mapped < 0) throw new GatewayError(`Orchestrator returned an invalid voice input ${label} time.`);
  return mapped;
}

function mapBackend(backend: BackendDescriptor): BackendView {
  return {
    id: backend.backendId,
    name: backend.displayName,
    version: backend.version,
    health: backend.health === BackendHealth.HEALTHY
      ? "healthy"
      : backend.health === BackendHealth.DEGRADED || backend.health === BackendHealth.STARTING
        ? "degraded"
        : "unavailable",
    instanceGeneration: numberValue(backend.entityVersion?.generation),
    installationState: backendInstallationState(backend.installationState),
    authenticationState: backendAuthenticationState(backend.authenticationState),
    ...(backend.error?.message ? { error: presentJokoServiceTerminology(backend.error.message) } : {}),
    capabilities: new Map((backend.capabilities?.capabilities ?? []).map((capability) => [capability.name, {
      name: capability.name,
      supported: capability.support === CapabilitySupport.SUPPORTED,
      ...(capability.reason.length > 0 ? { reason: capability.reason } : {}),
      options: capabilityOptions(capability.options),
      ...(capability.options?.kind.case === "input" && capability.options.kind.value.maximumBytes > 0n ? { maximumBytes: numberValue(capability.options.kind.value.maximumBytes) } : {}),
      ...(capability.options?.kind.case === "input" && capability.options.kind.value.maximumItems > 0 ? { maximumItems: capability.options.kind.value.maximumItems } : {})
    }] as const))
  };
}

function backendInstallationState(value: InstallationState): NonNullable<BackendView["installationState"]> {
  if (value === InstallationState.NOT_INSTALLED) return "notInstalled";
  if (value === InstallationState.INSTALLING) return "installing";
  if (value === InstallationState.INSTALLED) return "installed";
  if (value === InstallationState.UPDATE_AVAILABLE) return "updateAvailable";
  if (value === InstallationState.ERROR) return "error";
  return "unknown";
}

function backendAuthenticationState(value: AuthenticationState): NonNullable<BackendView["authenticationState"]> {
  if (value === AuthenticationState.NOT_REQUIRED) return "notRequired";
  if (value === AuthenticationState.SIGNED_OUT) return "signedOut";
  if (value === AuthenticationState.PENDING) return "pending";
  if (value === AuthenticationState.AUTHENTICATED) return "authenticated";
  if (value === AuthenticationState.EXPIRED) return "expired";
  if (value === AuthenticationState.REFRESHING) return "refreshing";
  if (value === AuthenticationState.ERROR) return "error";
  return "unknown";
}

function mapWorktreeEligibility(value: WorktreeEligibility): TargetWorktreeProbeView["eligibility"] {
  switch (value) {
    case WorktreeEligibility.ELIGIBLE: return "eligible";
    case WorktreeEligibility.NOT_GIT_REPOSITORY: return "notGitRepository";
    case WorktreeEligibility.ALREADY_LINKED: return "alreadyLinked";
    case WorktreeEligibility.UNSAFE: return "unsafe";
    case WorktreeEligibility.UNAVAILABLE: return "unavailable";
    default: throw new GatewayError("Orchestrator returned an unspecified Worktree eligibility.");
  }
}

function mapSessionWorktree(value: NonNullable<Session["worktree"]>): SessionWorktreeView {
  const required = [
    value.leaseId,
    value.workspaceId,
    value.workingPathDisplay,
    value.repositoryRootDisplay,
    value.branch,
    value.sourceRef,
    value.sourceCommit
  ];
  if (required.some((field) => field === "")) throw new GatewayError("Orchestrator returned an incomplete Session Worktree binding.");
  const sourceStrategy: SessionWorktreeView["sourceStrategy"] = value.sourceStrategy === WorktreeSourceStrategy.EXPLICIT
    ? "explicit"
    : value.sourceStrategy === WorktreeSourceStrategy.REMOTE_DEFAULT_REFRESHED
      ? "remoteDefaultRefreshed"
      : value.sourceStrategy === WorktreeSourceStrategy.REMOTE_DEFAULT_LOCAL
        ? "remoteDefaultLocal"
        : value.sourceStrategy === WorktreeSourceStrategy.CURRENT_BRANCH
          ? "currentBranch"
          : value.sourceStrategy === WorktreeSourceStrategy.LOCAL_DEFAULT
            ? "localDefault"
            : value.sourceStrategy === WorktreeSourceStrategy.HEAD
              ? "head"
              : (() => { throw new GatewayError("Orchestrator returned an unspecified Worktree source strategy."); })();
  const state: SessionWorktreeView["state"] = value.state === SessionWorktreeState.ACTIVE
    ? "active"
    : value.state === SessionWorktreeState.PRESERVED
      ? "preserved"
      : (() => { throw new GatewayError("Orchestrator returned an unspecified Session Worktree state."); })();
  return {
    leaseId: value.leaseId,
    workspaceId: value.workspaceId,
    workingPath: value.workingPathDisplay,
    repositoryRoot: value.repositoryRootDisplay,
    branch: value.branch,
    sourceRef: value.sourceRef,
    sourceCommit: value.sourceCommit,
    sourceStrategy,
    sourceRefreshed: value.sourceRefreshed,
    ...(value.sourceRemote === undefined ? {} : { sourceRemote: value.sourceRemote }),
    state,
    acquiredAt: timestampMs(value.acquiredAt),
    updatedAt: timestampMs(value.updatedAt)
  };
}

function mapSessionStatistics(
  statistics: ProtoSessionStatistics,
  expectedSessionId: string
): SessionStatisticsView {
  if (statistics.sessionId !== expectedSessionId || statistics.sessionId.trim() === "") {
    throw new GatewayError("Orchestrator returned statistics for a different task.");
  }
  return {
    sessionId: statistics.sessionId,
    messageCount: numberValue(statistics.messageCount),
    turnCount: numberValue(statistics.turnCount),
    branchCount: numberValue(statistics.branchCount),
    compactionCount: numberValue(statistics.compactionCount),
    ...(statistics.usage === undefined ? {} : { usage: mapUsageTokens(statistics.usage) }),
    ...(statistics.context === undefined ? {} : { context: mapContextStatistics(statistics.context) }),
    activeDurationMs: safeDurationMilliseconds(statistics.activeDuration, "task active duration")
  };
}

function mapContextStatistics(context: ProtoContextUsage): NonNullable<SessionStatisticsView["context"]> {
  return {
    usedTokens: numberValue(context.usedTokens),
    contextWindow: numberValue(context.contextWindowTokens),
    reservedTokens: numberValue(context.reservedTokens),
    utilizationRatio: contextUtilizationRatio(context),
    ...(context.measuredAt === undefined ? {} : { measuredAt: timestampMs(context.measuredAt) })
  };
}

function contextUtilizationRatio(context: Pick<ProtoContextUsage, "utilizationRatio">): number {
  if (!Number.isFinite(context.utilizationRatio) || context.utilizationRatio < 0 || context.utilizationRatio > 1) {
    throw new GatewayError("Orchestrator returned an invalid context utilization ratio.");
  }
  return context.utilizationRatio;
}

function safeDurationMilliseconds(
  value: { readonly seconds: bigint; readonly nanos: number } | undefined,
  label: string
): number {
  if (value === undefined) return 0;
  const milliseconds = Number(value.seconds) * 1_000 + Math.floor(value.nanos / 1_000_000);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || value.nanos < 0 || value.nanos >= 1_000_000_000) {
    throw new GatewayError(`Orchestrator returned an invalid ${label}.`);
  }
  return milliseconds;
}

function mapSession(
  session: Session,
  providers: ReadonlyMap<string, ProviderDescriptor>,
  models: ReadonlyMap<string, ModelDescriptor>,
  activeRun: Pick<Snapshot["runs"][number], "runId" | "state" | "startedAt"> | undefined,
  retryRun: { readonly runId: string } | undefined,
  compactingOverride?: boolean
): SessionView {
  const selected = session.model?.model;
  const descriptor = selected === undefined ? undefined : models.get(modelProjectionKey(session.backendId, selected.providerId, selected.modelId));
  const selectedProvider = selected === undefined ? undefined : providers.get(providerKey(session.backendId, selected.providerId));
  const context = session.context;
  const cumulativeUsage = context?.cumulativeUsage;
  const contextState = session.contextState;
  const compacting = compactingOverride ?? contextState?.compacting;
  const attention = session.attention;
  const attentionKind = attention?.kind === SessionAttentionKind.DONE
    ? "done" as const
    : attention?.kind === SessionAttentionKind.AWAITING
      ? "awaiting" as const
      : attention?.kind === SessionAttentionKind.ERROR ? "error" as const : undefined;
  return {
    id: session.sessionId,
    backendId: session.backendId,
    targetId: session.targetId,
    ...(session.projectId === undefined ? {} : { projectId: session.projectId }),
    ...(session.automationOrigin === undefined || session.automationOrigin.scheduleId.trim() === ""
      ? {}
      : {
        automationOrigin: {
          kind: "scheduler" as const,
          scheduleId: session.automationOrigin.scheduleId,
          ...(session.automationOrigin.scheduleName === "" ? {} : { scheduleName: session.automationOrigin.scheduleName }),
          ...(session.automationOrigin.runId === "" ? {} : { runId: session.automationOrigin.runId })
        }
      }),
    ...(session.derivationOrigin === undefined
      ? {}
      : {
          derivationOrigin: mapSessionDerivationOrigin(session.derivationOrigin)
        }),
    ...(session.remoteWorkspace === undefined ? {} : { remoteWorkspace: true }),
    name: session.displayName || "Untitled task",
    ...(session.taskSummary === "" ? {} : { summary: session.taskSummary }),
    state: sessionViewState(session.state, activeRun?.state),
    pinned: session.pinned,
    archived: session.archived,
    generation: session.nativeBinding?.runtimeGeneration ?? 0n,
    ...(descriptor !== undefined
      ? { model: mapModel(descriptor, selectedProvider) }
      : selected === undefined ? {} : { model: unavailableSessionModel(session.backendId, selected.providerId, selected.modelId, selectedProvider) }),
    ...(session.model?.effortId ? { effort: session.model.effortId } : {}),
    fastMode: session.model?.fastMode ?? false,
    permissionMode: uiPermission(session.permissionMode),
    planMode: session.planMode,
    ...(session.worktree === undefined ? {} : { worktree: mapSessionWorktree(session.worktree) }),
    ...(attention === undefined || attentionKind === undefined || attention.attentionCursor === undefined
      ? {}
      : {
        attention: {
          kind: attentionKind,
          unread: attention.unread,
          subjectCursor: attention.subjectCursor === undefined
            ? {
              opaqueToken: attention.attentionCursor.opaqueToken,
              sequence: attention.attentionCursor.sequence,
              generation: attention.attentionCursor.generation
            }
            : {
              opaqueToken: attention.subjectCursor.opaqueToken,
              sequence: attention.subjectCursor.sequence,
              generation: attention.subjectCursor.generation
            },
          attentionCursor: {
            opaqueToken: attention.attentionCursor.opaqueToken,
            sequence: attention.attentionCursor.sequence,
            generation: attention.attentionCursor.generation
          },
          readThroughCursor: attention.readThroughCursor === undefined
            ? { opaqueToken: "", sequence: 0n, generation: 0n }
            : {
              opaqueToken: attention.readThroughCursor.opaqueToken,
              sequence: attention.readThroughCursor.sequence,
              generation: attention.readThroughCursor.generation
            },
          updatedAt: timestampMs(attention.updatedAt)
        }
      }),
    codeHostPullRequests: session.codeHostPullRequests.map(mapCodeHostPullRequest),
    createdAt: timestampMs(session.createdAt),
    updatedAt: timestampMs(session.lastActivityAt) || timestampMs(session.createdAt),
    ...(cumulativeUsage === undefined ? {} : { usage: mapUsageTokens(cumulativeUsage) }),
    ...(context === undefined ? {} : {
      context: {
        usedTokens: numberValue(context.usedTokens),
        contextWindow: numberValue(context.contextWindowTokens),
        reservedTokens: numberValue(context.reservedTokens),
        utilizationRatio: contextUtilizationRatio(context),
        ...(context.measuredAt === undefined ? {} : { measuredAt: timestampMs(context.measuredAt) }),
        ...(contextState?.autoCompaction === undefined ? {} : { autoCompact: contextState.autoCompaction }),
        ...(contextState?.autoRetry === undefined ? {} : { autoRetry: contextState.autoRetry })
      }
    }),
    ...(compacting === undefined ? {} : { compacting }),
    ...(activeRun === undefined ? {} : { activeRunId: activeRun.runId }),
    ...(activeRun?.startedAt === undefined ? {} : { activeRunStartedAt: timestampMs(activeRun.startedAt) }),
    ...(retryRun === undefined ? {} : { retryRunId: retryRun.runId }),
    ...(session.activeNativeEntryId.length === 0 ? {} : { nativeLeafId: session.activeNativeEntryId })
  };
}

async function probeRuntimeActivityWithTransport(
  transport: Transport,
  parentSignal?: AbortSignal
): Promise<boolean> {
  const timeout = new AbortController();
  const timer = globalThis.setTimeout(() => timeout.abort(), 2_000);
  try {
    const signal = combinedAbortSignal(parentSignal, timeout.signal);
    const response = await createClient(EventService, transport).getRuntimeActivity(
      {},
      signal === undefined ? undefined : { signal }
    );
    if (response.summary === undefined) {
      throw new GatewayError("Orchestrator returned no runtime activity summary.");
    }
    // Keep detailed blocking kinds inside Orchestrator. The renderer needs only the
    // shutdown decision and must not grow a second runtime-state projector.
    return response.summary.blocksShutdown;
  } finally {
    globalThis.clearTimeout(timer);
    timeout.abort();
  }
}

function withTimelineHistoryInvalidation(
  snapshot: AppSnapshot,
  sessionId: string,
  candidateRevision: bigint
): AppSnapshot {
  const currentRevision = snapshot.timelineHistoryRevisionBySession.get(sessionId) ?? 0n;
  const nextRevision = candidateRevision > currentRevision ? candidateRevision : currentRevision + 1n;
  const timelineHistoryRevisionBySession = new Map(snapshot.timelineHistoryRevisionBySession);
  timelineHistoryRevisionBySession.set(sessionId, nextRevision);
  return { ...snapshot, timelineHistoryRevisionBySession };
}

function timelineNativeMessageIdentity(
  event: Event,
  existing?: Pick<TimelineItemView, "nativeEntryId" | "nativeParentEntryId">
): Pick<TimelineItemView, "nativeEntryId" | "nativeParentEntryId"> {
  const payload = event.payload?.kind;
  const identity = payload?.case === "messageStarted" || payload?.case === "messageCompleted"
    ? payload.value.nativeIdentity
    : undefined;
  const nativeEntryId = identity?.entryId || existing?.nativeEntryId;
  const nativeParentEntryId = identity?.parentEntryId || existing?.nativeParentEntryId;
  return {
    ...(nativeEntryId === undefined || nativeEntryId.length === 0 ? {} : { nativeEntryId }),
    ...(nativeParentEntryId === undefined || nativeParentEntryId.length === 0 ? {} : { nativeParentEntryId })
  };
}

function mapSessionDerivationOrigin(
  origin: NonNullable<Session["derivationOrigin"]>
): NonNullable<SessionView["derivationOrigin"]> {
  const kind = origin.kind === SessionDerivationKind.FORK
    ? "fork" as const
    : origin.kind === SessionDerivationKind.CLONE
      ? "clone" as const
      : undefined;
  if (kind === undefined || origin.sourceSessionId.trim() === "") {
    throw new GatewayError("Orchestrator returned an invalid task derivation origin.");
  }
  if ((origin.sourceMessageId === undefined) !== (origin.sourceEventId === undefined)) {
    throw new GatewayError("Orchestrator returned an incomplete task derivation message identity.");
  }
  if (kind === "fork" && origin.sourceMessageId === undefined) {
    throw new GatewayError("Orchestrator returned a fork without a source message identity.");
  }
  return {
    kind,
    sourceSessionId: origin.sourceSessionId,
    ...(origin.sourceMessageId === undefined || origin.sourceEventId === undefined
      ? {}
      : {
          sourceMessageId: origin.sourceMessageId,
          sourceEventId: origin.sourceEventId
        }),
    sourceSessionAvailable: origin.sourceSessionAvailable,
    sourceMessageAvailable: origin.sourceMessageAvailable
  };
}

function mapCodeHostPullRequest(
  value: Session["codeHostPullRequests"][number]
): NonNullable<SessionView["codeHostPullRequests"]>[number] {
  const reference = value.reference;
  if (reference === undefined) {
    throw new GatewayError("Orchestrator returned an invalid code-host pull request reference.");
  }
  const number = numberValue(reference.number);
  assertCodeHostPullRequestReference(reference, number);
  const projection = !value.observed
    ? undefined
    : validatedCodeHostPullRequestProjection(value);
  return {
    key: reference.referenceKey,
    host: reference.host,
    repositoryOwner: reference.repositoryOwner,
    repositoryName: reference.repositoryName,
    number,
    webUrl: reference.webUrl,
    ...(projection === undefined ? {} : { projection })
  };
}

function validatedCodeHostPullRequestProjection(
  value: Session["codeHostPullRequests"][number]
): NonNullable<NonNullable<SessionView["codeHostPullRequests"]>[number]["projection"]> {
  const title = boundedCodeHostDisplayText(value.title, 512);
  const headBranch = boundedCodeHostBranch(value.headBranch);
  if (
    title === undefined
    || headBranch === undefined
    || (value.unresolvedReviewThreadCount !== undefined && (
      !Number.isSafeInteger(value.unresolvedReviewThreadCount)
      || value.unresolvedReviewThreadCount < 0
      || value.unresolvedReviewThreadCount > 100
    ))
  ) throw new GatewayError("Orchestrator returned invalid code-host pull request metadata.");
  return {
        state: value.state === CodeHostPullRequestState.OPEN
          ? "open" as const
          : value.state === CodeHostPullRequestState.CLOSED
            ? "closed" as const
            : value.state === CodeHostPullRequestState.MERGED
              ? "merged" as const
              : invalidCodeHostPullRequestState(),
        draft: value.draft,
        title,
        headBranch,
        ...(value.unresolvedReviewThreadCount === undefined
          ? {}
          : { unresolvedReviewThreadCount: value.unresolvedReviewThreadCount }),
        observedAt: timestampMs(value.observedAt)
  };
}

function assertCodeHostPullRequestReference(
  reference: NonNullable<Session["codeHostPullRequests"][number]["reference"]>,
  number: number
): void {
  const repositoryPart = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/u;
  if (
    reference.host.length === 0
    || reference.host.length > 255
    || reference.host !== reference.host.toLocaleLowerCase("en-US")
    || /[\u0000-\u0020\u007f]/u.test(reference.host)
    || !repositoryPart.test(reference.repositoryOwner)
    || !repositoryPart.test(reference.repositoryName)
    || !Number.isSafeInteger(number)
    || number <= 0
    || number > 2_147_483_647
    || reference.referenceKey !== `${reference.host}/${reference.repositoryOwner}/${reference.repositoryName}#${number}`
    || !isCanonicalCodeHostPullRequestWebUrl(reference.webUrl, reference.host, reference.repositoryOwner, reference.repositoryName, number)
  ) throw new GatewayError("Orchestrator returned an invalid code-host pull request reference.");
}

function isCanonicalCodeHostPullRequestWebUrl(
  value: string,
  host: string,
  repositoryOwner: string,
  repositoryName: string,
  number: number
): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (
    url.href !== value
    || url.protocol !== "https:"
    || url.host !== host
    || url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
  ) return false;
  const owner = encodeURIComponent(repositoryOwner);
  const repository = encodeURIComponent(repositoryName);
  return url.pathname === `/${owner}/${repository}/pull/${number}`
    || url.pathname === `/${owner}/${repository}/-/merge_requests/${number}`;
}

function boundedCodeHostDisplayText(value: unknown, maximumLength: number): string | undefined {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximumLength
    && value.trim() === value
    && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)
    ? value
    : undefined;
}

function boundedCodeHostBranch(value: unknown): string | undefined {
  const branch = boundedCodeHostDisplayText(value, 255);
  if (
    branch === undefined
    || /[\u0000-\u0020\u007f~^:?*[\\]/u.test(branch)
    || branch === "@"
    || branch.startsWith("/")
    || branch.endsWith("/")
    || branch.endsWith(".")
    || branch.includes("//")
    || branch.includes("..")
    || branch.includes("@{")
    || branch.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock"))
  ) return undefined;
  return branch;
}

function invalidCodeHostPullRequestState(): never {
  throw new GatewayError("Orchestrator returned an invalid code-host pull request state.");
}

function mapModel(
  model: ModelDescriptor,
  provider: ProviderDescriptor | undefined,
  routingEnabled = true
): ModelView {
  const pricingCapability = provider?.capabilities?.capabilities.find((capability) =>
    capability.name === capabilityNames.modelPricing);
  return {
    backendId: model.backendId,
    providerId: model.key?.providerId ?? "",
    providerName: provider?.displayName ?? model.key?.providerId ?? "",
    ...(provider === undefined ? {} : { providerAccessKind: providerKind(provider.kind) }),
    ...(pricingCapability === undefined ? {} : {
      pricingKnown: pricingCapability.support === CapabilitySupport.SUPPORTED
    }),
    ...(model.priceSource === ModelPriceSource.PROVIDER_REFERENCE
      ? { pricingSource: "providerReference" as const }
      : model.priceSource === ModelPriceSource.UPSTREAM
        ? { pricingSource: "upstream" as const }
        : {}),
    ...(model.priceUpdatedAt === undefined ? {} : { pricingUpdatedAt: timestampMs(model.priceUpdatedAt) }),
    modelId: model.key?.modelId ?? "",
    logicalId: model.logicalId || model.key?.modelId || "",
    name: model.displayName,
    available: model.available,
    routingEnabled,
    defaultVisible: model.defaultVisible ?? true,
    supportsImages: model.inputModalities.includes(ModelInputModality.IMAGE),
    inputModalities: model.inputModalities.map(inputModality),
    outputModalities: model.outputModalities.map(outputModality),
    supportsFast: model.supportsFastMode,
    efforts: model.effortLevels.sort((left, right) => left.order - right.order).map((effort) => effort.effortId),
    contextWindow: numberValue(model.contextWindowTokens),
    maximumOutputTokens: numberValue(model.maximumOutputTokens),
    inputCostMicrosPerMillion: numberValueSigned(model.inputCostMicrosPerMillion),
    outputCostMicrosPerMillion: numberValueSigned(model.outputCostMicrosPerMillion),
    cacheReadCostMicrosPerMillion: numberValueSigned(model.cacheReadCostMicrosPerMillion),
    cacheWriteCostMicrosPerMillion: numberValueSigned(model.cacheWriteCostMicrosPerMillion),
    currencyCode: model.currencyCode || "USD"
  };
}

function providerRouteEnabled(
  settings: AppSnapshot["settings"],
  backendId: string,
  providerId: string,
  ownerManaged: boolean
): boolean {
  return (!ownerManaged || settings.providers.find((provider) => provider.id === providerId)?.enabled !== false)
    && !(settings.backendSettings.find((backend) => backend.backendId === backendId)
      ?.modelAccess?.disabledProviderIds.includes(providerId) ?? false);
}

function unavailableSessionModel(
  backendId: string,
  providerId: string,
  modelId: string,
  provider: ProviderDescriptor | undefined
): ModelView {
  return {
    backendId,
    providerId,
    providerName: provider?.displayName ?? providerId,
    ...(provider === undefined ? {} : { providerAccessKind: providerKind(provider.kind) }),
    modelId,
    logicalId: modelId,
    name: modelId,
    available: false,
    routingEnabled: false,
    defaultVisible: false,
    supportsImages: false,
    inputModalities: ["text"],
    outputModalities: ["text"],
    supportsFast: false,
    efforts: [],
    contextWindow: 0,
    maximumOutputTokens: 0,
    inputCostMicrosPerMillion: 0,
    outputCostMicrosPerMillion: 0,
    currencyCode: "USD"
  };
}

function modelRouteEnabled(
  settings: AppSnapshot["settings"],
  backendId: string,
  providerId: string,
  modelId: string,
  ownerManaged: boolean
): boolean {
  const access = settings.backendSettings.find((backend) => backend.backendId === backendId)?.modelAccess;
  return (!ownerManaged || settings.providers.find((provider) => provider.id === providerId)?.enabled !== false)
    && access?.disabledProviderIds.includes(providerId) !== true
    && access?.disabledModels.some((model) => model.providerId === providerId && model.modelId === modelId) !== true;
}

function mapUsageHistory(history: ProtoUsageHistory, expectedDays: number): UsageHistoryView {
  if (history.days.length !== expectedDays) throw new GatewayError("Orchestrator returned an incomplete usage history window.");
  const days = history.days.map((day) => {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(day.day) || day.usage === undefined) {
      throw new GatewayError("Orchestrator returned an invalid usage-history day.");
    }
    const measuredAt = day.measuredAt === undefined ? undefined : timestampMs(day.measuredAt);
    return {
      day: day.day,
      usage: mapUsageTokens(day.usage),
      currencyTotals: day.currencyTotals.map(mapUsageCurrencyTotal),
      costComplete: day.costComplete,
      estimated: day.estimated,
      ...(measuredAt === undefined ? {} : { measuredAt })
    };
  });
  if (history.today === undefined || history.last30Days === undefined || history.generatedAt === undefined) {
    throw new GatewayError("Orchestrator returned an incomplete usage summary.");
  }
  const generatedAt = timestampMs(history.generatedAt);
  if (!Number.isSafeInteger(generatedAt) || generatedAt < 0) throw new GatewayError("Orchestrator returned an invalid usage generation time.");
  const measuredAt = history.measuredAt === undefined ? undefined : timestampMs(history.measuredAt);
  return {
    days,
    modelDaily: history.modelDaily.map((daily) => {
      if (
        daily.model === undefined
        || daily.usage === undefined
        || !/^\d{4}-\d{2}-\d{2}$/u.test(daily.day)
      ) {
        throw new GatewayError("Orchestrator returned an invalid model usage day.");
      }
      const identity = checkedUsageModelIdentity(daily.backendId, daily.model.providerId, daily.model.modelId);
      return {
        day: daily.day,
        ...identity,
        usage: mapUsageTokens(daily.usage),
        currencyTotals: daily.currencyTotals.map(mapUsageCurrencyTotal),
        costComplete: daily.costComplete,
        estimated: daily.estimated
      };
    }),
    models: history.models.map((summary) => {
      if (summary.model === undefined || summary.usage === undefined) throw new GatewayError("Orchestrator returned an invalid model usage summary.");
      return {
        ...checkedUsageModelIdentity(summary.backendId, summary.model.providerId, summary.model.modelId),
        ...mapUsageSummary(summary)
      };
    }),
    today: mapUsageSummary(history.today),
    last30Days: mapUsageSummary(history.last30Days),
    currentStreakDays: history.currentStreakDays,
    longestStreakDays: history.longestStreakDays,
    todayAnomalous: history.todayAnomalous,
    generatedAt,
    ...(measuredAt === undefined ? {} : { measuredAt }),
    estimated: history.estimated
  };
}

function mapUsageSummary(summary: {
  readonly usage?: ProtoUsage;
  readonly currencyTotals: readonly ProtoUsageCurrencyTotal[];
  readonly costComplete: boolean;
  readonly estimated: boolean;
}): UsageHistorySummaryView {
  if (summary.usage === undefined) throw new GatewayError("Orchestrator returned an empty usage summary.");
  return {
    usage: mapUsageTokens(summary.usage),
    currencyTotals: summary.currencyTotals.map(mapUsageCurrencyTotal),
    costComplete: summary.costComplete,
    estimated: summary.estimated
  };
}

function mapUsageCurrencyTotal(total: ProtoUsageCurrencyTotal): UsageCurrencyTotalView {
  if (total.usage === undefined || !/^[A-Z]{3}$/u.test(total.currencyCode)) {
    throw new GatewayError("Orchestrator returned an invalid usage currency total.");
  }
  return {
    currencyCode: total.currencyCode,
    usage: mapUsageTokens(total.usage),
    costComplete: total.costComplete,
    estimated: total.estimated
  };
}

function mapUsageTokens(usage: ProtoUsage): UsageTokensView {
  const inputTokens = exactSafeUnsignedNumber(usage.inputTokens);
  const outputTokens = exactSafeUnsignedNumber(usage.outputTokens);
  const cacheReadTokens = exactSafeUnsignedNumber(usage.cacheReadTokens);
  const cacheWriteTokens = exactSafeUnsignedNumber(usage.cacheWriteTokens);
  const totalTokens = exactSafeUnsignedNumber(usage.totalTokens);
  const costMicros = Number(usage.costMicros);
  if (
    inputTokens === undefined || outputTokens === undefined || cacheReadTokens === undefined
    || cacheWriteTokens === undefined || totalTokens === undefined || !Number.isSafeInteger(costMicros) || costMicros < 0
  ) throw new GatewayError("Orchestrator returned usage outside the safe display range.");
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens, costMicros, currencyCode: usage.currencyCode };
}

function checkedModelPriceTarget(
  backendId: string,
  providerId: string,
  modelId: string
): { readonly backendId: string; readonly providerId: string; readonly modelId: string } {
  const backend = backendId.trim();
  const provider = providerId.trim();
  const model = modelId.trim();
  if (
    backend === ""
    || provider === ""
    || model === ""
    || backend.length > 256
    || provider.length > 512
    || model.length > 512
  ) {
    throw new GatewayError("A Backend, Provider, and model are required for model pricing.");
  }
  return { backendId: backend, providerId: provider, modelId: model };
}

function checkedUsageModelIdentity(
  backendId: string,
  providerId: string,
  modelId: string
): { readonly backendId: string; readonly providerId: string; readonly modelId: string } {
  const backend = backendId.trim();
  const provider = providerId.trim();
  const model = modelId.trim();
  if (
    backend === ""
    || provider === ""
    || model === ""
    || backend.length > 256
    || provider.length > 512
    || model.length > 512
  ) {
    throw new GatewayError("Orchestrator returned an invalid model usage identity.");
  }
  return { backendId: backend, providerId: provider, modelId: model };
}

function protoModelPriceQuote(quote: ModelPriceQuoteView): {
  readonly currency: ModelPriceCurrency;
  readonly inputCostMicrosPerMillion: bigint;
  readonly outputCostMicrosPerMillion: bigint;
  readonly cacheReadCostMicrosPerMillion?: bigint;
  readonly cacheWriteCostMicrosPerMillion?: bigint;
} {
  return {
    currency: quote.currency === "CNY" ? ModelPriceCurrency.CNY : ModelPriceCurrency.USD,
    inputCostMicrosPerMillion: priceUnitsToMicros(quote.inputPerMillion),
    outputCostMicrosPerMillion: priceUnitsToMicros(quote.outputPerMillion),
    ...(quote.cacheReadPerMillion === undefined ? {} : { cacheReadCostMicrosPerMillion: priceUnitsToMicros(quote.cacheReadPerMillion) }),
    ...(quote.cacheWritePerMillion === undefined ? {} : { cacheWriteCostMicrosPerMillion: priceUnitsToMicros(quote.cacheWritePerMillion) })
  };
}

function priceUnitsToMicros(value: number): bigint {
  const micros = Math.round(value * 1_000_000);
  if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(micros)) {
    throw new GatewayError("Model prices must be finite non-negative values.");
  }
  return BigInt(micros);
}

function mapModelPriceOverride(
  price: ProtoModelPriceOverrideView,
  expected: { readonly backendId: string; readonly providerId: string; readonly modelId: string }
): ModelPriceOverrideView {
  if (
    price.backendId !== expected.backendId
    || price.model?.providerId !== expected.providerId
    || price.model.modelId !== expected.modelId
    || price.reference === undefined
    || price.effective === undefined
  ) {
    throw new GatewayError("Orchestrator returned a model price for the wrong target.");
  }
  const allowedCurrencies = price.allowedCurrencies.map(modelPriceCurrency);
  if (allowedCurrencies.length === 0) throw new GatewayError("Orchestrator returned no supported model-price currencies.");
  const updatedAt = price.updatedAt === undefined ? undefined : timestampMs(price.updatedAt);
  return {
    ...expected,
    reference: mapModelPriceQuote(price.reference),
    effective: mapModelPriceQuote(price.effective),
    ...(price.override === undefined ? {} : { override: mapModelPriceQuote(price.override) }),
    allowedCurrencies,
    referenceAvailable: price.referenceAvailable,
    ...(price.registryUpdatedAt === undefined ? {} : { registryUpdatedAt: timestampMs(price.registryUpdatedAt) }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(price.version?.revision?.value === undefined ? {} : { revision: price.version.revision.value })
  };
}

function mapModelPriceQuote(quote: ProtoModelPriceQuote): ModelPriceQuoteView {
  const input = Number(quote.inputCostMicrosPerMillion);
  const output = Number(quote.outputCostMicrosPerMillion);
  const cacheRead = quote.cacheReadCostMicrosPerMillion === undefined ? undefined : Number(quote.cacheReadCostMicrosPerMillion);
  const cacheWrite = quote.cacheWriteCostMicrosPerMillion === undefined ? undefined : Number(quote.cacheWriteCostMicrosPerMillion);
  if ([input, output, cacheRead, cacheWrite].some((value) => value !== undefined && (!Number.isSafeInteger(value) || value < 0))) {
    throw new GatewayError("Orchestrator returned an invalid model price.");
  }
  return {
    currency: modelPriceCurrency(quote.currency),
    inputPerMillion: input / 1_000_000,
    outputPerMillion: output / 1_000_000,
    ...(cacheRead === undefined ? {} : { cacheReadPerMillion: cacheRead / 1_000_000 }),
    ...(cacheWrite === undefined ? {} : { cacheWritePerMillion: cacheWrite / 1_000_000 })
  };
}

function modelPriceCurrency(currency: ModelPriceCurrency): "USD" | "CNY" {
  if (currency === ModelPriceCurrency.USD) return "USD";
  if (currency === ModelPriceCurrency.CNY) return "CNY";
  throw new GatewayError("Orchestrator returned an unsupported model-price currency.");
}

function mapProviderRuntime(provider: ProviderDescriptor, routingEnabled = true): ProviderRuntimeView {
  const rate = provider.rateLimit;
  const usage = provider.usage;
  const accountUsage = provider.accountUsage;
  return {
    backendId: provider.backendId,
    id: provider.providerId,
    name: provider.displayName,
    kind: providerKind(provider.kind),
    ...(provider.accessProduct === undefined ? {} : { accessProduct: provider.accessProduct }),
    compatibility: providerCompatibility(provider.apiCompatibility),
    authenticationState: providerAuthenticationState(provider.authenticationState),
    endpoint: provider.endpointDisplay,
    ownerManaged: provider.ownerManaged,
    routingEnabled,
    supportsLogin: provider.supportsLogin,
    loginMethods: provider.loginMethods
      .filter((method) => method !== ProviderLoginMethod.UNSPECIFIED)
      .map(providerLoginMethod),
    supportsLogout: provider.supportsLogout,
    supportsRefresh: provider.supportsRefresh,
    supportsModelRefresh: provider.supportsModelRefresh,
    credentialSurfaces: provider.credentialSurfaces.map((surface) => ({
      id: surface.surfaceId,
      capability: providerCredentialSurfaceCapability(surface.capability),
      kind: providerCredentialSurfaceKind(surface.kind),
      configured: surface.configured,
      models: surface.models.map((model) => ({
        modelId: model.modelId,
        name: model.displayName
      }))
    })),
    capabilities: new Set((provider.capabilities?.capabilities ?? [])
      .filter((capability) => capability.support === CapabilitySupport.SUPPORTED)
      .map((capability) => capability.name)),
    ...(provider.credentialExpiresAt === undefined ? {} : { credentialExpiresAt: timestampMs(provider.credentialExpiresAt) }),
    ...(rate === undefined ? {} : {
      rateLimit: {
        limited: rate.limited,
        ...(rate.resetsAt === undefined ? {} : { resetsAt: timestampMs(rate.resetsAt) }),
        requestLimit: numberValue(rate.requestLimit),
        requestsRemaining: numberValue(rate.requestsRemaining),
        tokenLimit: numberValue(rate.tokenLimit),
        tokensRemaining: numberValue(rate.tokensRemaining)
      }
    }),
    ...(usage?.usage === undefined ? {} : { usage: {
      inputTokens: numberValue(usage.usage.inputTokens),
      outputTokens: numberValue(usage.usage.outputTokens),
      cacheReadTokens: numberValue(usage.usage.cacheReadTokens),
      cacheWriteTokens: numberValue(usage.usage.cacheWriteTokens),
      cost: numberValueSigned(usage.usage.costMicros) / 1_000_000,
      currency: usage.usage.currencyCode || "USD",
      ...(usage.periodStartedAt === undefined ? {} : { periodStartedAt: timestampMs(usage.periodStartedAt) }),
      ...(usage.periodEndedAt === undefined ? {} : { periodEndedAt: timestampMs(usage.periodEndedAt) }),
      ...(usage.measuredAt === undefined ? {} : { measuredAt: timestampMs(usage.measuredAt) }),
      estimated: usage.estimated
    } }),
    ...(accountUsage === undefined ? {} : { accountUsage: {
      ...(accountUsage.primaryWindow === undefined ? {} : { primaryWindow: mapProviderAccountUsageWindow(accountUsage.primaryWindow) }),
      ...(accountUsage.secondaryWindow === undefined ? {} : { secondaryWindow: mapProviderAccountUsageWindow(accountUsage.secondaryWindow) }),
      limitReached: accountUsage.limitReached,
      ...(accountUsage.planType === undefined ? {} : { planType: accountUsage.planType }),
      ...(accountUsage.credits === undefined ? {} : { credits: {
        hasCredits: accountUsage.credits.hasCredits,
        unlimited: accountUsage.credits.unlimited,
        balance: accountUsage.credits.balance,
        ...(accountUsage.credits.observedAt === undefined ? {} : { observedAt: timestampMs(accountUsage.credits.observedAt) })
      } }),
      ...(accountUsage.observedAt === undefined ? {} : { observedAt: timestampMs(accountUsage.observedAt) })
    } }),
    ...(provider.error?.message ? { error: presentJokoServiceTerminology(provider.error.message) } : {})
  };
}

function mapProviderAccountUsageWindow(
  window: NonNullable<ProviderDescriptor["accountUsage"]>["primaryWindow"]
): NonNullable<ProviderRuntimeView["accountUsage"]>["primaryWindow"] {
  if (window === undefined || !Number.isFinite(window.usedPercent) || window.usedPercent < 0 || window.usedPercent > 100) {
    throw new GatewayError("Orchestrator returned an invalid Provider account-usage window.");
  }
  return {
    usedPercent: window.usedPercent,
    windowMinutes: window.windowMinutes,
    ...(window.resetAt === undefined ? {} : { resetAt: timestampMs(window.resetAt) })
  };
}

function mapQueueItem(item: QueueItem): QueueItemView {
  const version = queueItemVersion(item);
  return {
    id: item.queueItemId,
    sessionId: item.sessionId,
    revision: version.revision,
    generation: version.generation,
    source: queueSource(item.sourceKind),
    mode: uiDeliveryMode(item.deliveryMode),
    text: inputText(item.input),
    state: queueState(item.state),
    editLocked: item.editLocked,
    ordinal: numberValue(item.ordinal),
    createdAt: timestampMs(item.acceptedAt)
  };
}

function queueItemVersion(item: QueueItem): { readonly revision: bigint; readonly generation: bigint } {
  if (item.version?.revision === undefined) {
    throw new GatewayError("Orchestrator returned a queued input without an entity version.");
  }
  return { revision: item.version.revision.value, generation: item.version.generation };
}

function queueItemPrecondition(item: QueueItem): MutationPrecondition {
  const version = queueItemVersion(item);
  return {
    entity: { kind: EntityKind.QUEUE_ITEM, id: item.queueItemId },
    expectedRevision: { value: version.revision },
    expectedGeneration: version.generation
  };
}

function queueSource(source: QueueSourceKind): QueueItemView["source"] {
  if (source === QueueSourceKind.UI) return "user";
  if (source === QueueSourceKind.SCHEDULE) return "schedule";
  if (source === QueueSourceKind.BACKEND) return "backend";
  if (source === QueueSourceKind.RETRY) return "retry";
  throw new GatewayError("Orchestrator returned a queued input without a source.");
}

function queueControlVersion(control: QueueControl): { readonly revision: bigint; readonly generation: bigint } {
  if (control.version?.revision === undefined) {
    throw new GatewayError("Orchestrator returned queue control without an entity version.");
  }
  return { revision: control.version.revision.value, generation: control.version.generation };
}

function queueControlPrecondition(control: QueueControl): MutationPrecondition {
  const version = queueControlVersion(control);
  return {
    entity: { kind: EntityKind.QUEUE_CONTROL, id: control.sessionId },
    expectedRevision: { value: version.revision },
    expectedGeneration: version.generation
  };
}

function mapQueueControl(control: QueueControl): QueueControlView {
  const version = queueControlVersion(control);
  return {
    sessionId: control.sessionId,
    revision: version.revision,
    generation: version.generation,
    state: control.dispatchState === QueueDispatchState.PAUSED ? "paused" : "active",
    ...(control.pauseReason.length === 0 ? {} : { pauseReason: control.pauseReason }),
    ...(control.pausedAt === undefined ? {} : { pausedAt: timestampMs(control.pausedAt) }),
    interactionLocked: control.interactionLocked,
    queuedItemCount: numberValue(control.queuedItemCount)
  };
}

export function mapInteraction(interaction: Interaction): InteractionView {
  const request = interaction.request;
  const base = {
    id: interaction.interactionId,
    sessionId: interaction.sessionId,
    generation: interaction.generation,
    createdAt: timestampMs(interaction.createdAt),
    ...(interaction.expiresAt === undefined ? {} : { expiresAt: timestampMs(interaction.expiresAt) }),
    fields: [],
    planSteps: []
  };
  if (request.case === "permission") {
    const permissionSubject = request.value.subject === undefined ? undefined : mapPermissionSubject(request.value.subject);
    return {
      ...base,
      kind: "permission",
      title: request.value.title || "Permission required",
      message: request.value.explanation,
      risk: permissionRisk(request.value.risk),
      ...(permissionSubject === undefined ? {} : { permissionSubject }),
      options: request.value.allowedDecisions.map((decision) => ({ id: String(decision), label: permissionDecisionLabel(decision) }))
    };
  }
  if (request.case === "question") {
    return {
      ...base,
      kind: "question",
      title: request.value.title || request.value.fields[0]?.label || "Question",
      message: request.value.prompt,
      options: [],
      fields: request.value.fields.map(mapQuestionField)
    };
  }
  if (request.case === "planReview") {
    return {
      ...base,
      kind: "plan",
      title: request.value.title || "Review plan",
      message: request.value.markdown,
      options: request.value.allowedDecisions.map((decision) => ({ id: String(decision), label: planDecisionLabel(decision) })),
      planMarkdown: request.value.markdown,
      planSteps: request.value.steps.map((step) => ({
        id: step.stepId,
        title: step.title,
        ...(step.description.length > 0 ? { description: step.description } : {}),
        state: planStepState(step.state)
      }))
    };
  }
  if (request.case === "extensionUi") {
    const extension = request.value.request;
    if (extension.case === "select") return { ...base, kind: "select", title: extension.value.title, message: "", options: extension.value.options.map((option) => ({ id: option, label: option })) };
    if (extension.case === "confirm") return { ...base, kind: "confirm", title: extension.value.title, message: extension.value.message, options: [] };
    if (extension.case === "editor") return { ...base, kind: "editor", title: extension.value.title, message: "", options: [], prefill: extension.value.prefill };
    return { ...base, kind: "input", title: extension.case === "input" ? extension.value.title : "Extension input", message: "", options: [], ...(extension.case === "input" && extension.value.placeholder.length > 0 ? { placeholder: extension.value.placeholder } : {}) };
  }
  return { ...base, kind: "question", title: "Interaction", message: "", options: [] };
}

function mapTimelineInteraction(interaction: Interaction): NonNullable<TimelineItemView["interaction"]> {
  const request = interaction.request;
  const state = interaction.state === InteractionState.PENDING
    ? "pending"
    : interaction.state === InteractionState.RESOLVED
      ? "resolved"
      : interaction.state === InteractionState.DISMISSED
        ? "dismissed"
        : interaction.state === InteractionState.EXPIRED
          ? "expired"
          : interaction.state === InteractionState.CANCELLED
            ? "cancelled"
            : "unknown";
  if (request.case === "question") {
    const resolution = interaction.resolution?.decision.case === "question"
      ? interaction.resolution.decision.value
      : undefined;
    const answers = new Map((resolution?.answers ?? []).map((answer) => [answer.fieldId, answer]));
    return {
      id: interaction.interactionId,
      kind: "question",
      state,
      title: request.value.title || request.value.fields[0]?.label || "Question",
      prompt: request.value.prompt,
      questions: request.value.fields.map((field) => {
        const answer = timelineQuestionAnswer(field, answers.get(field.fieldId));
        return {
          id: field.fieldId,
          question: field.label,
          ...(answer === undefined ? {} : { answer })
        };
      })
    };
  }
  if (request.case === "permission") return { id: interaction.interactionId, kind: "permission", state, title: request.value.title || "Permission required", prompt: request.value.explanation, questions: [] };
  if (request.case === "planReview") return { id: interaction.interactionId, kind: "plan", state, title: request.value.title || "Review plan", prompt: request.value.markdown, questions: [] };
  if (request.case === "extensionUi") return { id: interaction.interactionId, kind: "extension", state, title: "Extension input", prompt: request.value.request.case ?? "", questions: [] };
  return { id: interaction.interactionId, kind: "unknown", state, title: "Interaction", prompt: "", questions: [] };
}

function timelineQuestionAnswer(field: QuestionField, answer: QuestionAnswer | undefined): NonNullable<NonNullable<TimelineItemView["interaction"]>["questions"][number]["answer"]> | undefined {
  switch (answer?.value.case) {
    case "text": return { kind: "text", values: answer.value.value.trim() === "" ? [] : [answer.value.value] };
    case "choiceId": return { kind: "text", values: [questionChoiceLabel(field, answer.value.value)] };
    case "choiceIds": return { kind: "text", values: answer.value.value.values.map((value) => questionChoiceLabel(field, value)) };
    case "boolean": return { kind: "boolean", value: answer.value.value };
    case "sensitive": return { kind: "sensitive" };
    default: return undefined;
  }
}

function questionChoiceLabel(field: QuestionField, choiceId: string): string {
  const choices = field.input.case === "singleChoice" || field.input.case === "multipleChoice"
    ? field.input.value.choices
    : [];
  return choices.find((choice) => choice.choiceId === choiceId)?.label || choiceId;
}

function mapPermissionSubject(subject: PermissionSubject): PermissionSubjectView | undefined {
  const kind = subject.kind;
  if (kind.case === "file") return {
    kind: "file",
    workspaceId: kind.value.workspaceId,
    paths: [...kind.value.relativePaths],
    action: filePermissionAction(kind.value.action),
    outsidePrimaryWorkspace: kind.value.outsidePrimaryWorkspace
  };
  if (kind.case === "command") return {
    kind: "command",
    executable: kind.value.executable,
    arguments: [...kind.value.arguments],
    workingDirectory: kind.value.workingDirectoryDisplay,
    networkAccess: kind.value.networkAccess,
    writesOutsideWorkspace: kind.value.writesOutsideWorkspace,
    usesShell: kind.value.usesShell
  };
  if (kind.case === "mcp") return {
    kind: "mcp",
    serverId: kind.value.serverId,
    toolName: kind.value.toolName,
    arguments: kind.value.arguments.map(mapPermissionArgument)
  };
  if (kind.case === "browser") return {
    kind: "browser",
    providerId: kind.value.browserProviderId,
    pageId: kind.value.pageId,
    action: browserPermissionAction(kind.value.action),
    origin: kind.value.origin
  };
  if (kind.case === "customTool") return {
    kind: "customTool",
    toolId: kind.value.toolId,
    displayName: kind.value.displayName,
    arguments: kind.value.arguments.map(mapPermissionArgument)
  };
  if (kind.case === "resource") return {
    kind: "resource",
    resourceId: kind.value.resourceId,
    sourcePath: kind.value.sourcePathDisplay,
    action: resourcePermissionAction(kind.value.action)
  };
  return undefined;
}

function mapPermissionArgument(argument: DisplayArgument): PermissionArgumentView {
  return {
    fieldPath: argument.fieldPath,
    value: displayArgumentValue(argument),
    redacted: argument.redacted
  };
}

function displayArgumentValue(argument: DisplayArgument): string {
  if (argument.redacted) return argument.redactedPlaceholder || "••••";
  const value = argument.value;
  if (value.case === "text") return value.value;
  if (value.case === "number") return String(value.value);
  if (value.case === "integer") return value.value.toString();
  if (value.case === "boolean") return String(value.value);
  if (value.case === "blob") {
    const name = value.value.fileName || value.value.blobId;
    const type = value.value.mediaType || "binary";
    return `${name} (${type}, ${value.value.byteSize.toString()} bytes)`;
  }
  if (value.case === "null") return "null";
  if (value.case === "composite") {
    const shape = value.value.kind === CompositeArgumentKind.ARRAY ? "array" : "object";
    return `${shape} (${value.value.childCount})`;
  }
  return "";
}

function filePermissionAction(action: FilePermissionAction): Extract<PermissionSubjectView, { readonly kind: "file" }>["action"] {
  if (action === FilePermissionAction.READ) return "read";
  if (action === FilePermissionAction.CREATE) return "create";
  if (action === FilePermissionAction.UPDATE) return "update";
  if (action === FilePermissionAction.DELETE) return "delete";
  if (action === FilePermissionAction.MOVE) return "move";
  return "unknown";
}

function browserPermissionAction(action: BrowserPermissionAction): Extract<PermissionSubjectView, { readonly kind: "browser" }>["action"] {
  if (action === BrowserPermissionAction.READ_PAGE) return "readPage";
  if (action === BrowserPermissionAction.NAVIGATE) return "navigate";
  if (action === BrowserPermissionAction.INTERACT) return "interact";
  if (action === BrowserPermissionAction.UPLOAD) return "upload";
  if (action === BrowserPermissionAction.DOWNLOAD) return "download";
  if (action === BrowserPermissionAction.TAKE_OVER) return "takeOver";
  return "unknown";
}

function resourcePermissionAction(action: ResourcePermissionAction): Extract<PermissionSubjectView, { readonly kind: "resource" }>["action"] {
  if (action === ResourcePermissionAction.APPROVE) return "approve";
  if (action === ResourcePermissionAction.INSTALL) return "install";
  if (action === ResourcePermissionAction.UPDATE) return "update";
  if (action === ResourcePermissionAction.ENABLE) return "enable";
  return "unknown";
}

function mapQuestionField(field: QuestionField): InteractionView["fields"][number] {
  const input = field.input;
  const base = {
    id: field.fieldId,
    label: field.label || field.fieldId,
    ...(field.description ? { description: field.description } : {}),
    required: field.required,
    options: [],
    multiline: false,
    sensitive: false,
    minimumSelections: 0
  };
  if (input.case === "singleChoice") return {
    ...base,
    kind: "single",
    options: input.value.choices.map(mapQuestionChoice),
    ...(input.value.defaultChoiceId.length > 0 ? { defaultValue: input.value.defaultChoiceId } : {})
  };
  if (input.case === "multipleChoice") return {
    ...base,
    kind: "multiple",
    options: input.value.choices.map(mapQuestionChoice),
    defaultValue: [...input.value.defaultChoiceIds],
    minimumSelections: input.value.minimumSelections,
    ...(input.value.maximumSelections > 0 ? { maximumSelections: input.value.maximumSelections } : {})
  };
  if (input.case === "boolean") return { ...base, kind: "boolean", defaultValue: input.value.defaultValue };
  return {
    ...base,
    kind: "text",
    ...(input.case === "text" && input.value.placeholder.length > 0 ? { placeholder: input.value.placeholder } : {}),
    ...(input.case === "text" ? { defaultValue: input.value.defaultValue, multiline: input.value.multiline, sensitive: input.value.answerHandling === QuestionAnswerHandling.CREDENTIAL_CHANNEL } : {})
  };
}

function mapQuestionChoice(choice: QuestionChoice): InteractionView["options"][number] {
  return { id: choice.choiceId, label: choice.label, ...(choice.description ? { description: choice.description } : {}) };
}

function mapWorkspace(workspace: WorkspaceDescriptor, entries: readonly WorkspaceEntry[]): WorkspaceView {
  const statuses = workspaceStatusMap(workspace);
  return {
    id: workspace.workspaceId,
    targetId: workspace.targetId,
    name: workspace.displayName,
    kind: workspace.kind === WorkspaceKind.MANAGED_DIALOGUE ? "managedDialogue" : "userProject",
    serverPath: workspace.serverPathDisplay,
    trusted: workspace.trusted,
    ...(workspace.git?.branchName ? { branch: workspace.git.branchName } : {}),
    ...(workspace.git?.headCommit ? { head: workspace.git.headCommit } : {}),
    detachedHead: workspace.git?.detachedHead === true,
    operationInProgress: workspace.git?.operationInProgress === true,
    dirty: workspace.git?.dirty ?? false,
    ...(workspace.version?.revision?.value === undefined
      ? {}
      : { revision: workspace.version.revision.value.toString(10) }),
    entries: entries.map((entry) => mapWorkspaceEntry(entry, statuses))
  };
}

function mapExtraDirectory(directory: ExtraDirectory): ExtraDirectoryView {
  return {
    id: directory.extraDirectoryId,
    workspaceId: directory.workspaceId,
    serverPath: directory.serverPathDisplay,
    access: directory.access === ExtraDirectoryAccess.READ_WRITE ? "readWrite" : "readOnly",
    trusted: directory.trusted
  };
}

function mapWorkspaceEntry(entry: WorkspaceEntry, statuses: ReadonlyMap<string, WorkspaceEntryView["status"]> = new Map()): WorkspaceEntryView {
  return {
    path: entry.relativePath,
    name: entry.displayName,
    kind: entry.kind === 2 ? "directory" : "file",
    ...(entry.revision?.byteSize === undefined ? {} : { size: numberValue(entry.revision.byteSize) }),
    ...(entry.revision?.modifiedAt === undefined ? {} : { modifiedAt: timestampMs(entry.revision.modifiedAt) }),
    ...(entry.revision?.opaqueRevision ? { revision: entry.revision.opaqueRevision } : {}),
    ...(entry.mediaType ? { mediaType: entry.mediaType } : {}),
    ignored: entry.ignored,
    hidden: entry.hidden,
    generated: entry.generated,
    ...(statuses.get(entry.relativePath) === undefined ? {} : { status: statuses.get(entry.relativePath) })
  };
}

function mapWorkspaceFileChange(change: WorkspaceFileChange): WorkspaceFileChangeView {
  if (change.workspaceId.trim() === "") {
    throw new GatewayError("Orchestrator returned a workspace file change without a workspace ID.");
  }
  const kind = workspaceFileChangeKind(change.kind);
  const path = change.relativePath === "" ? undefined : workspaceFileChangeRelativePath(change.relativePath);
  const previousPath = change.previousRelativePath === ""
    ? undefined
    : workspaceFileChangeRelativePath(change.previousRelativePath);
  if ((kind === "overflow" || kind === "resync") && (path !== undefined || previousPath !== undefined)) {
    throw new GatewayError("Orchestrator returned a path on a workspace resync event.");
  }
  if (kind !== "overflow" && kind !== "resync" && path === undefined) {
    throw new GatewayError("Orchestrator returned a workspace file change without a path.");
  }
  if ((kind === "renamed") !== (previousPath !== undefined)) {
    throw new GatewayError("Orchestrator returned an invalid workspace rename event.");
  }
  if (kind === "renamed" && path === previousPath) {
    throw new GatewayError("Orchestrator returned a workspace rename with identical paths.");
  }
  if (change.sequence <= 0n || change.streamRevision.trim() === "") {
    throw new GatewayError("Orchestrator returned an unfenced workspace file change.");
  }
  return {
    workspaceId: change.workspaceId,
    kind,
    ...(path === undefined ? {} : { path }),
    ...(previousPath === undefined ? {} : { previousPath }),
    ...(change.revision?.opaqueRevision ? { revision: change.revision.opaqueRevision } : {}),
    ...(change.revision === undefined ? {} : { byteSize: numberValue(change.revision.byteSize) }),
    ...(change.revision?.modifiedAt === undefined ? {} : { modifiedAt: timestampMs(change.revision.modifiedAt) }),
    sequence: change.sequence,
    streamRevision: change.streamRevision,
    observedAt: timestampMs(change.observedAt)
  };
}

function workspaceFileChangeKind(value: WorkspaceFileChangeKind): WorkspaceFileChangeView["kind"] {
  switch (value) {
    case WorkspaceFileChangeKind.CREATED: return "created";
    case WorkspaceFileChangeKind.MODIFIED: return "modified";
    case WorkspaceFileChangeKind.DELETED: return "deleted";
    case WorkspaceFileChangeKind.RENAMED: return "renamed";
    case WorkspaceFileChangeKind.OVERFLOW: return "overflow";
    case WorkspaceFileChangeKind.RESYNC: return "resync";
    case WorkspaceFileChangeKind.UNSPECIFIED:
    default: throw new GatewayError("Orchestrator returned an unknown workspace file change kind.");
  }
}

function workspaceFileChangeRelativePath(value: string): string {
  if (
    value === "" ||
    value.startsWith("/") ||
    /^[a-z]:[\\/]/iu.test(value) ||
    value.includes("\\") ||
    /[\0-\x1f\x7f]/u.test(value)
  ) throw new GatewayError("Orchestrator returned a non-canonical workspace file change path.");
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new GatewayError("Orchestrator returned a non-canonical workspace file change path.");
  }
  return value;
}

function protoWorkspaceEntryListingPolicy(
  policy: WorkspaceEntryListingOptionsView["policy"]
): WorkspaceEntryListingPolicy {
  if (policy === "documentTree") return WorkspaceEntryListingPolicy.DOCUMENT_TREE;
  if (policy === "default") return WorkspaceEntryListingPolicy.DEFAULT;
  return WorkspaceEntryListingPolicy.UNSPECIFIED;
}

function workspaceStatusMap(workspace: WorkspaceDescriptor | undefined): ReadonlyMap<string, WorkspaceEntryView["status"]> {
  const statuses = new Map<string, WorkspaceEntryView["status"]>();
  for (const change of workspace?.git?.changes ?? []) {
    const status = gitFileStatus(change.workingTreeStatus === GitFileStatus.UNMODIFIED ? change.indexStatus : change.workingTreeStatus);
    if (status !== undefined) statuses.set(change.relativePath, status);
  }
  return statuses;
}

function mapFilePreview(preview: FilePreview): WorkspaceFilePreviewView {
  const entry = preview.entry;
  const base = {
    path: entry?.relativePath ?? "",
    name: entry?.displayName || entry?.relativePath || "File",
    ...(entry?.revision?.opaqueRevision ? { revision: entry.revision.opaqueRevision } : {}),
    ...(entry?.revision?.byteSize === undefined ? {} : { byteSize: numberValue(entry.revision.byteSize) }),
    ...(entry?.revision?.modifiedAt === undefined ? {} : { modifiedAt: timestampMs(entry.revision.modifiedAt) }),
    truncated: preview.truncated
  };
  if (preview.content.case === "text") return { ...base, kind: "text", text: preview.content.value.utf8Text, language: preview.content.value.languageId };
  if (preview.content.case === "image") return { ...base, kind: "image", ...(preview.content.value.blob?.blobId ? { blobId: preview.content.value.blob.blobId } : {}), mediaType: preview.content.value.blob?.mediaType ?? "image/*" };
  if (preview.content.case === "blob") return { ...base, kind: "blob", blobId: preview.content.value.blobId, mediaType: preview.content.value.mediaType };
  if (preview.content.case === "binary") return { ...base, kind: "binary", mediaType: preview.content.value.mediaType, summary: preview.content.value.summary };
  return { ...base, kind: "unknown" };
}

function mapWorkspaceSearchMatch(match: WorkspaceSearchMatch, pageToken?: string): WorkspaceSearchMatchView {
  const range = match.range;
  const revision = match.revision?.opaqueRevision ?? "";
  if (range === undefined || revision === "") {
    throw new GatewayError("Orchestrator returned an incomplete workspace-search match.");
  }
  const previewBoundaries = utf8ByteBoundaries(match.linePreview);
  const submatches = match.submatches.map((submatch) => {
    const startByte = exactSafeUnsignedNumber(submatch.startByte);
    const endByte = exactSafeUnsignedNumber(submatch.endByte);
    if (
      startByte === undefined
      || endByte === undefined
      || endByte <= startByte
      || !previewBoundaries.has(startByte)
      || !previewBoundaries.has(endByte)
    ) {
      throw new GatewayError("Orchestrator returned an invalid workspace-search UTF-8 submatch.");
    }
    return { startByte, endByte };
  });
  return {
    path: match.relativePath,
    line: range.startLine,
    preview: match.linePreview,
    submatches,
    range: {
      startByte: numberValue(range.startByte),
      endByte: numberValue(range.endByte),
      startLine: range.startLine,
      startColumn: range.startColumn,
      endLine: range.endLine,
      endColumn: range.endColumn
    },
    revision,
    ...(pageToken === undefined ? {} : { pageToken })
  };
}

function mapWorkspaceSearchFailure(code: string, message: string): {
  readonly code: WorkspaceSearchErrorCode;
  readonly message: string;
} {
  if (!isWorkspaceSearchErrorCode(code)) {
    throw new GatewayError("Orchestrator returned an unknown workspace-search error code.");
  }
  const normalizedMessage = message.trim();
  if (normalizedMessage === "" || new TextEncoder().encode(normalizedMessage).byteLength > 4_096) {
    throw new GatewayError("Orchestrator returned an invalid workspace-search error message.");
  }
  return { code, message: normalizedMessage };
}

function isWorkspaceSearchErrorCode(value: string): value is WorkspaceSearchErrorCode {
  return value === "WORKSPACE_SEARCH_INVALID"
    || value === "WORKSPACE_SEARCH_FAILED"
    || value === "WORKSPACE_SEARCH_RESULT_CHANGED"
    || value === "RG_UNAVAILABLE";
}

function exactSafeUnsignedNumber(value: bigint): number | undefined {
  const candidate = Number(value);
  return Number.isSafeInteger(candidate) && candidate >= 0 && BigInt(candidate) === value ? candidate : undefined;
}

function isRuntimeProcessInstanceId(value: string | undefined): value is string {
  return value !== undefined
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function utf8ByteBoundaries(value: string): ReadonlySet<number> {
  const boundaries = new Set<number>([0]);
  const encoder = new TextEncoder();
  let byteOffset = 0;
  for (const character of value) {
    byteOffset += encoder.encode(character).byteLength;
    boundaries.add(byteOffset);
  }
  return boundaries;
}

function protoWorkspaceReviewSource(source: NonNullable<WorkspaceDiffQuery["source"]>): GitDiffSource {
  if (source === "unstaged") return GitDiffSource.UNSTAGED;
  if (source === "staged") return GitDiffSource.STAGED;
  if (source === "commit") return GitDiffSource.COMMIT;
  return GitDiffSource.BRANCH;
}

function protoWorkspaceFileSource(source: WorkspaceFileDiffView["source"]): GitDiffSource {
  if (source === "unstaged") return GitDiffSource.UNSTAGED;
  if (source === "staged") return GitDiffSource.STAGED;
  if (source === "commit") return GitDiffSource.COMMIT;
  if (source === "branch") return GitDiffSource.BRANCH;
  throw new GatewayError("Persisted Review evidence cannot be read as a live Git source.");
}

function workspaceReviewSource(source: GitDiffSource | undefined): WorkspaceDiffView["source"] {
  if (source === GitDiffSource.UNSTAGED) return "unstaged";
  if (source === GitDiffSource.STAGED) return "staged";
  if (source === GitDiffSource.COMMIT) return "commit";
  if (source === GitDiffSource.BRANCH) return "branch";
  if (source === GitDiffSource.LAST_TURN) return "lastTurn";
  if (source === GitDiffSource.TURN_SET) return "turnSet";
  return "unspecified";
}

function workspaceFileSource(source: GitDiffSource): WorkspaceFileDiffView["source"] {
  if (source === GitDiffSource.UNSTAGED) return "unstaged";
  if (source === GitDiffSource.STAGED) return "staged";
  if (source === GitDiffSource.COMMIT) return "commit";
  if (source === GitDiffSource.BRANCH) return "branch";
  if (source === GitDiffSource.TURN_SET) return "turnSet";
  return "unspecified";
}

function assertWorkspaceDiffReadFence(diff: WorkspaceDiffView, repositoryRevision: string, mergeBaseRevision: string): void {
  if (diff.repositoryRevision === "" || repositoryRevision !== diff.repositoryRevision) {
    throw new GatewayError("Review changed while its preview was being read. Refresh and retry.");
  }
  if (diff.mergeBaseRevision !== undefined && mergeBaseRevision !== diff.mergeBaseRevision) {
    throw new GatewayError("The Review merge base changed while its preview was being read. Refresh and retry.");
  }
}

function mapWorkspaceDiffImageSide(side: WorkspaceDiffImageSide | undefined): WorkspaceDiffImageView["oldImage"] {
  if (side === undefined) return { present: false, tooLarge: false };
  const blob = side.image?.blob;
  return {
    present: side.present,
    tooLarge: side.tooLarge,
    ...(blob?.blobId ? { blobId: blob.blobId, mediaType: blob.mediaType } : {}),
    ...(side.image === undefined ? {} : {
      width: side.image.widthPixels,
      height: side.image.heightPixels,
      alt: side.image.altText
    })
  };
}

function mapWorkspaceDiff(diff: WorkspaceDiff): WorkspaceDiffView {
  const branchBaseWarning = diff.branchBaseWarning?.code === WorkspaceBranchBaseWarningCode.REQUESTED_BASE_MISSING
    ? {
        code: "requestedBaseMissing" as const,
        requestedBaseRef: diff.branchBaseWarning.requestedBaseRef,
        resolvedBaseRef: diff.branchBaseWarning.resolvedBaseRef
      }
    : undefined;
  return {
    files: diff.files.map((file) => mapWorkspaceFileDiff(file)),
    truncated: diff.truncated,
    repositoryRevision: diff.repositoryRevision ?? "",
    source: workspaceReviewSource(diff.source),
    ...(diff.sourceRevision === undefined ? {} : { sourceRevision: diff.sourceRevision }),
    ...(diff.requestedBaseRef === undefined ? {} : { requestedBaseRef: diff.requestedBaseRef }),
    ...(diff.resolvedBaseRef === undefined ? {} : { resolvedBaseRef: diff.resolvedBaseRef }),
    ...(branchBaseWarning === undefined ? {} : { branchBaseWarning }),
    ...(diff.baseRevision === undefined ? {} : { baseRevision: diff.baseRevision }),
    ...(diff.headRevision === undefined ? {} : { headRevision: diff.headRevision }),
    ...(diff.mergeBaseRevision === undefined ? {} : { mergeBaseRevision: diff.mergeBaseRevision }),
    ...(diff.completeDiff?.blobId ? { completeDiffBlobId: diff.completeDiff.blobId } : {})
  };
}

function mapWorkspaceChangeSet(changeSet: WorkspaceChangeSet): WorkspaceChangeSetView {
  return {
    id: changeSet.changeSetId,
    runId: changeSet.runId,
    turnId: changeSet.turnId,
    changeCount: changeSet.changes.length,
    changes: changeSet.changes.map((change, index) => ({
      path: change.relativePath,
      ...(change.oldRelativePath === "" ? {} : { oldPath: change.oldRelativePath }),
      kind: change.kind === FileChangeKind.CREATED
        ? "created" as const
        : change.kind === FileChangeKind.UPDATED
          ? "updated" as const
          : change.kind === FileChangeKind.DELETED
            ? "deleted" as const
            : change.kind === FileChangeKind.RENAMED ? "renamed" as const : "unspecified" as const,
      ...(change.diff === undefined ? {} : {
        diff: {
          ...mapWorkspaceFileDiff(change.diff, `${changeSet.changeSetId}:${index}`),
          source: "turnSet" as const
        }
      })
    })),
    completeBaseline: changeSet.completeBaseline,
    gaps: changeSet.gaps.map((gap) => `${gap.relativePath}: ${gap.explanation}`),
    capturedAt: timestampMs(changeSet.capturedAt)
  };
}

function mapWorkspaceRewindPreview(preview: WorkspaceRewindPreview): WorkspaceRewindPreviewView {
  return {
    id: preview.previewId,
    changeSetId: preview.changeSetId,
    safety: preview.safety === RewindSafety.SAFE ? "safe" : preview.safety === RewindSafety.REQUIRES_CONFIRMATION ? "requiresConfirmation" : "blocked",
    inversePaths: preview.inverseChanges.map((change) => change.relativePath),
    gaps: preview.gaps.map((gap) => `${gap.relativePath}: ${gap.explanation}`),
    conflicts: preview.conflicts.map((conflict) => `${conflict.relativePath}: ${conflict.explanation}`),
    ...(preview.diff === undefined ? {} : { diff: mapWorkspaceDiff(preview.diff) }),
    dialogueOnlyAvailable: preview.dialogueOnlyAvailable,
    ...(preview.expiresAt === undefined ? {} : { expiresAt: timestampMs(preview.expiresAt) })
  };
}

function mapSchedule(schedule: Schedule): ScheduleView {
  const recurrence = schedule.recurrence?.kind;
  let kind: ScheduleView["kind"] = "manual";
  let expression = "Manual";
  if (recurrence?.case === "oneShot") {
    kind = "once";
    expression = new Date(timestampMs(recurrence.value.triggerAt)).toISOString();
  } else if (recurrence?.case === "cron") {
    kind = "cron";
    expression = recurrence.value.expression;
  } else if (recurrence?.case === "interval") {
    kind = "interval";
    expression = `${durationSeconds(recurrence.value.interval)}s`;
  }
  const last = schedule.recentRuns[0];
  return {
    id: schedule.scheduleId,
    name: schedule.displayName,
    source: schedule.source === ScheduleSource.PROJECT ? "project" : "user",
    ...(schedule.projectConfigId.length === 0 ? {} : { projectConfigId: schedule.projectConfigId }),
    ...(schedule.projectConfigPath.length === 0 ? {} : { projectConfigPath: schedule.projectConfigPath }),
    backendId: schedule.backendId,
    targetId: schedule.targetId,
    sessionMode: schedule.sessionMode === ScheduleSessionMode.FRESH
      ? "fresh"
      : schedule.sessionMode === ScheduleSessionMode.PERSISTENT
        ? "persistent"
        : schedule.sessionMode === ScheduleSessionMode.BOUND || schedule.sessionId.length > 0
          ? "bound"
          : "fresh",
    ...(schedule.sessionId.length === 0 ? {} : { sessionId: schedule.sessionId }),
    enabled: schedule.state === ScheduleState.ENABLED || schedule.state === ScheduleState.RUNNING,
    kind,
    expression,
    timezone: schedule.timeZone,
    inputText: inputText(schedule.input),
    executionMode: schedule.execution?.executionMode === ScheduleExecutionMode.SCRIPT ? "script" : "agent",
    ...(schedule.execution?.script === undefined ? {} : {
      script: {
        command: schedule.execution.script.command,
        ...(schedule.execution.script.timeout === undefined
          ? {}
          : { timeoutMs: Math.round(durationSeconds(schedule.execution.script.timeout) * 1_000) }),
        capabilities: schedule.execution.script.capabilities
          .filter((capability) => capability === ScheduleScriptCapability.SESSIONS_DISPATCH)
          .map(() => "sessions.dispatch" as const)
      }
    }),
    ...(schedule.execution?.model?.model === undefined ? {} : {
      model: {
        providerId: schedule.execution.model.model.providerId,
        modelId: schedule.execution.model.model.modelId,
        ...(schedule.execution.model.effortId.length > 0 ? { effort: schedule.execution.model.effortId } : {}),
        fastMode: schedule.execution.model.fastMode
      }
    }),
    permissionMode: uiPermission(schedule.execution?.permissionMode ?? ProtoPermissionMode.ASK),
    planMode: schedule.execution?.planMode ?? false,
    useWorktree: schedule.execution?.useWorktree ?? false,
    ...(schedule.execution?.worktreeSourceRef === undefined
      ? {}
      : { worktreeSourceRef: schedule.execution.worktreeSourceRef }),
    refreshWorktreeRemote: schedule.execution?.refreshWorktreeRemote ?? false,
    extraDirectoryIds: [...(schedule.execution?.extraDirectoryIds ?? [])],
    silentWhenIdle: schedule.execution?.silentWhenIdle ?? false,
    notifyDesktop: schedule.execution?.notify?.desktop ?? true,
    ...(schedule.execution?.expireAt === undefined ? {} : { expireAt: timestampMs(schedule.execution.expireAt) }),
    ...(schedule.execution?.preRunHook === undefined ? {} : {
      preRunHook: {
        command: schedule.execution.preRunHook.command,
        filePath: schedule.execution.preRunHook.filePath,
        ...(schedule.execution.preRunHook.timeout === undefined
          ? {}
          : { timeoutMs: Math.round(durationSeconds(schedule.execution.preRunHook.timeout) * 1_000) })
      }
    }),
    overlapPolicy: schedule.overlapPolicy === ScheduleOverlapPolicy.SKIP ? "skip" : "queue",
    misfirePolicy: schedule.misfirePolicy === ScheduleMisfirePolicy.SKIP ? "skip" : "runOnce",
    ...(schedule.nextTriggerAt === undefined ? {} : { nextRunAt: timestampMs(schedule.nextTriggerAt) }),
    ...(last === undefined ? {} : { lastRun: { state: scheduleRunHistoryState(last), at: timestampMs(last.triggeredAt) } }),
    unreadRunCount: schedulerCounter(schedule.unreadRunCount, "unread run count"),
    history: schedule.recentRuns.map(mapScheduleRunHistory)
  };
}

function mapScheduleRunHistory(run: ScheduleRunHistory): ScheduleView["history"][number] {
  return {
    id: run.triggerId,
    runId: run.runId,
    sessionId: run.sessionId,
    state: scheduleRunHistoryState(run),
    scheduledAt: timestampMs(run.scheduledFor),
    triggeredAt: timestampMs(run.triggeredAt),
    ...(run.finishedAt === undefined ? {} : { finishedAt: timestampMs(run.finishedAt) }),
    ...(run.duration === undefined ? {} : { durationMs: schedulerDurationMs(run.duration, "run") }),
    ...(run.resultText.length === 0 ? {} : { resultText: run.resultText }),
    zeroCost: run.zeroCost,
    costAttribution: scheduleRunCostAttribution(run.costAttribution),
    ...(run.cost === undefined ? {} : { cost: scheduleRunMoney(run.cost) }),
    ...(run.estimatedValue === undefined ? {} : { estimatedValue: scheduleRunMoney(run.estimatedValue) }),
    ...(run.preRun === undefined ? {} : { preRun: schedulePreRunResult(run.preRun) }),
    ...(run.readAt === undefined ? {} : { readAt: timestampMs(run.readAt) }),
    ...(run.error?.message ? { error: presentJokoServiceTerminology(run.error.message) } : {})
  };
}

function scheduleRunHistoryState(run: ScheduleRunHistory): ScheduleView["history"][number]["state"] {
  switch (run.outcome) {
    case ScheduleRunOutcome.SUCCEEDED: return "completed";
    case ScheduleRunOutcome.SKIPPED: return "skipped";
    case ScheduleRunOutcome.ABORTED: return "aborted";
    case ScheduleRunOutcome.INTERRUPTED: return "interrupted";
    case ScheduleRunOutcome.RUNNING:
    case ScheduleRunOutcome.QUEUED: return "running";
    case ScheduleRunOutcome.FAILED: return "failed";
    default: return scheduleRunState(run.state);
  }

}

function scheduleRunCostAttribution(
  value: ScheduleRunCostAttribution
): ScheduleView["history"][number]["costAttribution"] {
  switch (value) {
    case ScheduleRunCostAttribution.EXACT: return "exact";
    case ScheduleRunCostAttribution.DIRECT: return "direct";
    case ScheduleRunCostAttribution.MIXED: return "mixed";
    case ScheduleRunCostAttribution.ZERO: return "zero";
    case ScheduleRunCostAttribution.UNAVAILABLE:
    default: return "unavailable";
  }
}

function scheduleRunMoney(value: import("@joko/contracts").ScheduleRunMoney): import("./model.js").ScheduleRunMoneyView {
  const amountMicros = numberValue(value.amountMicros);
  if ((value.currencyCode !== "CNY" && value.currencyCode !== "USD")
    || (value.kind !== "actual-cost" && value.kind !== "value-estimate")) {
    throw new GatewayError("Orchestrator returned invalid Schedule run money metadata.");
  }
  return {
    amount: amountMicros / 1_000_000,
    currency: value.currencyCode,
    approximate: value.approximate,
    kind: value.kind,
    estimateReasons: [...value.estimateReasons]
  };
}

function schedulePreRunResult(
  value: import("@joko/contracts").SchedulePreRunResult
): import("./model.js").SchedulePreRunResultView {
  const statuses = new Set(["passed", "skipped", "failed", "timed_out", "aborted"] as const);
  const decisions = new Set(["run", "skip", "block"] as const);
  if (!statuses.has(value.status as never) || !decisions.has(value.decision as never) || value.duration === undefined) {
    throw new GatewayError("Orchestrator returned invalid Schedule pre-run metadata.");
  }
  return {
    status: value.status as import("./model.js").SchedulePreRunResultView["status"],
    decision: value.decision as import("./model.js").SchedulePreRunResultView["decision"],
    ...(value.exitCode === undefined ? {} : { exitCode: value.exitCode }),
    durationMs: schedulerDurationMs(value.duration, "pre-run"),
    ...(value.stdout.length === 0 ? {} : { stdout: value.stdout }),
    ...(value.stderr.length === 0 ? {} : { stderr: value.stderr }),
    stdoutTruncated: value.stdoutTruncated,
    stderrTruncated: value.stderrTruncated,
    timedOut: value.timedOut,
    aborted: value.aborted,
    ...(value.spawnError.length === 0 ? {} : { spawnError: value.spawnError }),
    ...(value.error.length === 0 ? {} : { error: value.error })
  };
}

function mapSchedulerRuntime(runtime: ProtoSchedulerRuntimeSnapshot): SchedulerRuntimeView {
  const maxConcurrentRuns = schedulerCounter(runtime.maxConcurrentRuns, "maximum concurrency");
  if (maxConcurrentRuns < 1 || maxConcurrentRuns > 256) throw new GatewayError("Orchestrator returned an invalid scheduler concurrency limit.");
  if (runtime.inFlightRuns.length > 256 || runtime.waitingTasks.length > 10_000) {
    throw new GatewayError("Orchestrator returned an oversized scheduler runtime snapshot.");
  }
  const runs: SchedulerRuntimeView["runs"] = runtime.inFlightRuns.map((run) => ({
    scheduleId: requiredSchedulerIdentifier(run.scheduleId, "schedule"),
    ...(run.scheduleName.length === 0 ? {} : { scheduleName: run.scheduleName }),
    ...(run.runId.length === 0 ? {} : { runId: run.runId }),
    source: scheduleFireSource(run.source),
    executionMode: scheduleRuntimeExecutionMode(run.executionMode),
    startedAt: requiredSchedulerTimestamp(run.startedAt, "run start"),
    ...(run.slotWait === undefined ? {} : { slotWaitMs: schedulerDurationMs(run.slotWait, "slot wait") }),
    phase: scheduleRuntimePhase(run.phase),
    lastProgressAt: requiredSchedulerTimestamp(run.lastProgressAt, "last progress")
  }));
  const waiting: SchedulerRuntimeView["waiting"] = runtime.waitingTasks.map((task) => ({
    scheduleId: requiredSchedulerIdentifier(task.scheduleId, "waiting schedule"),
    ...(task.scheduleName.length === 0 ? {} : { scheduleName: task.scheduleName }),
    waitingSince: requiredSchedulerTimestamp(task.waitingSince, "capacity wait")
  }));
  const inFlight = schedulerCounter(runtime.inFlight, "in-flight count");
  const slotsInUse = schedulerCounter(runtime.slotsInUse, "slot count");
  if (inFlight !== runs.length) throw new GatewayError("Orchestrator returned an inconsistent scheduler runtime snapshot.");
  if (slotsInUse > inFlight) throw new GatewayError("Orchestrator returned an inconsistent scheduler slot count.");
  return {
    instanceId: requiredSchedulerIdentifier(runtime.schedulerInstanceId, "instance"),
    ...(runtime.processId === undefined ? {} : { processId: schedulerCounter(runtime.processId, "process identifier") }),
    inFlight,
    slotsInUse,
    maxConcurrentRuns,
    runs,
    waiting
  };
}

function scheduleRuntimePhase(value: ScheduleRunPhase): SchedulerRuntimeView["runs"][number]["phase"] {
  if (value === ScheduleRunPhase.LOADING) return "loading";
  if (value === ScheduleRunPhase.CLAIMING) return "claiming";
  if (value === ScheduleRunPhase.PERSISTING) return "persisting";
  if (value === ScheduleRunPhase.RUNNING) return "running";
  if (value === ScheduleRunPhase.QUEUED) return "queued";
  if (value === ScheduleRunPhase.CANCELLING) return "cancelling";
  if (value === ScheduleRunPhase.FINALIZING) return "finalizing";
  if (value === ScheduleRunPhase.STALLED) return "stalled";
  if (value === ScheduleRunPhase.RECOVERING) return "recovering";
  throw new GatewayError("Orchestrator returned an unknown scheduler run phase.");
}

function scheduleFireSource(value: ScheduleFireSource): SchedulerRuntimeView["runs"][number]["source"] {
  if (value === ScheduleFireSource.AUTOMATIC) return "automatic";
  if (value === ScheduleFireSource.RUN_NOW) return "runNow";
  throw new GatewayError("Orchestrator returned an unknown scheduler fire source.");
}

function scheduleRuntimeExecutionMode(value: ScheduleExecutionMode): ScheduleView["executionMode"] {
  if (value === ScheduleExecutionMode.AGENT) return "agent";
  if (value === ScheduleExecutionMode.SCRIPT) return "script";
  throw new GatewayError("Orchestrator returned an unknown scheduler execution mode.");
}

function requiredSchedulerIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 512) throw new GatewayError(`Orchestrator returned an invalid scheduler ${label} identifier.`);
  return normalized;
}

function requiredSchedulerTimestamp(
  value: { readonly seconds: bigint; readonly nanos: number } | undefined,
  label: string
): number {
  if (value === undefined) throw new GatewayError(`Orchestrator returned no scheduler ${label} timestamp.`);
  const milliseconds = timestampMs(value);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) throw new GatewayError(`Orchestrator returned an invalid scheduler ${label} timestamp.`);
  return milliseconds;
}

function schedulerDurationMs(value: { readonly seconds: bigint; readonly nanos: number }, label: string): number {
  const milliseconds = Number(value.seconds) * 1_000 + Math.floor(value.nanos / 1_000_000);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) throw new GatewayError(`Orchestrator returned an invalid scheduler ${label} duration.`);
  return milliseconds;
}

function schedulerCounter(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new GatewayError(`Orchestrator returned an invalid scheduler ${label}.`);
  return value;
}

function mapBrowserCommentTarget(target: ProtoBrowserCommentTarget): NonNullable<BrowserCommentInspectionResultView["target"]> {
  const kind = target.kind === BrowserCommentTargetKind.ELEMENT
    ? "element"
    : target.kind === BrowserCommentTargetKind.REGION
      ? "region"
      : target.kind === BrowserCommentTargetKind.TEXT
        ? "text"
        : undefined;
  let designBaseline: BrowserCommentDesignBaselineView | undefined;
  if (target.designBaseline !== undefined) {
    const styles = browserCommentEntryRecord(target.designBaseline.styles);
    const provenance = browserCommentEntryRecord(target.designBaseline.provenance);
    if (styles === undefined || provenance === undefined) {
      throw new GatewayError("Orchestrator returned an invalid Browser comment design baseline.");
    }
    designBaseline = {
      styles,
      provenance,
      ...(target.designBaseline.editableText === undefined ? {} : { editableText: target.designBaseline.editableText })
    };
  }
  const normalized = normalizeBrowserCommentTarget({
    kind,
    point: target.point,
    viewport: target.viewport,
    region: target.region,
    textRegions: target.textRegions,
    selectedText: target.selectedText,
    targetTag: target.targetTag,
    targetLabel: target.targetLabel,
    targetRole: target.targetRole,
    targetSelector: target.targetSelector,
    targetPath: target.targetPath,
    nearbyText: target.nearbyText,
    themeVariant: target.themeVariant === BrowserCommentThemeVariant.LIGHT
      ? "light"
      : target.themeVariant === BrowserCommentThemeVariant.DARK
        ? "dark"
        : undefined,
    designBaseline
  });
  if (normalized === undefined) throw new GatewayError("Orchestrator returned an invalid Browser comment target.");
  return normalized;
}

function browserCommentEntryRecord(entries: readonly { readonly key: string; readonly value: string }[]): Record<string, string> | undefined {
  const result: Record<string, string> = {};
  for (const entry of entries) {
    if (entry.key.length === 0 || Object.prototype.hasOwnProperty.call(result, entry.key)) return undefined;
    result[entry.key] = entry.value;
  }
  return result;
}

export function mapBrowserCommentPlacement(placement: ProtoBrowserCommentPlacement): BrowserCommentPlacementView | undefined {
  if (!Number.isSafeInteger(placement.markerNumber) || placement.markerNumber < 1 || placement.markerNumber > 0xffff_ffff) return undefined;
  const viewport = placement.viewport;
  const point = placement.point;
  if (viewport === undefined || point === undefined
    || ![viewport.width, viewport.height, point.x, point.y].every(Number.isFinite)
    || viewport.width < 1 || viewport.height < 1 || viewport.width > 100_000 || viewport.height > 100_000
    || Math.abs(point.x) > 1_000_000 || Math.abs(point.y) > 1_000_000) return undefined;
  const normalizeRegion = (region: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | undefined) => {
    if (region === undefined || ![region.x, region.y, region.width, region.height].every(Number.isFinite)
      || region.width <= 0 || region.height <= 0 || Math.abs(region.x) > 1_000_000 || Math.abs(region.y) > 1_000_000
      || region.width > 100_000 || region.height > 100_000) return undefined;
    return { x: region.x, y: region.y, width: region.width, height: region.height };
  };
  const region = placement.pending ? normalizeRegion(placement.region) : undefined;
  const textRegions = placement.pending
    ? placement.textRegions.slice(0, 50).map(normalizeRegion).filter((candidate): candidate is NonNullable<ReturnType<typeof normalizeRegion>> => candidate !== undefined)
    : [];
  return {
    markerNumber: placement.markerNumber,
    point: { x: point.x, y: point.y },
    viewport: { width: viewport.width, height: viewport.height },
    pending: placement.pending,
    ...(region === undefined ? {} : { region }),
    ...(textRegions.length === 0 ? {} : { textRegions })
  };
}

function mapBrowser(browser: BrowserProvider): BrowserView {
  return {
    id: browser.browserProviderId,
    name: browser.displayName,
    state: browserState(browser.state),
    generation: browser.generation,
    ...(browser.activePageId === "" ? {} : { activePageId: browser.activePageId }),
    ...(browser.takeover === undefined ? {} : { takeover: {
      id: browser.takeover.takeoverId,
      pageId: browser.takeover.pageId,
      connectionId: browser.takeover.connectionId,
      state: browserTakeoverState(browser.takeover.state),
      generation: browser.takeover.generation,
      ...(browser.takeover.startedAt === undefined ? {} : { startedAt: timestampMs(browser.takeover.startedAt) }),
      ...(browser.takeover.expiresAt === undefined ? {} : { expiresAt: timestampMs(browser.takeover.expiresAt) })
    } }),
    pages: browser.pages.map(mapBrowserPage)
  };
}

function mapBrowserPage(page: BrowserPage): BrowserPageView {
  return {
    id: page.pageId,
    ...(page.sessionId.length === 0 ? {} : { sessionId: page.sessionId }),
    title: page.title || "Untitled page",
    url: page.url,
    state: pageState(page.state),
    canGoBack: page.canGoBack,
    canGoForward: page.canGoForward,
    recoverable: page.recoverable,
    lastKnownGeneration: page.lastKnownGeneration,
    ...(page.latestScreenshot?.blob?.blobId ? { screenshotBlobId: page.latestScreenshot.blob.blobId } : {}),
    ...(page.lastActivityAt === undefined ? {} : { lastActivityAt: timestampMs(page.lastActivityAt) })
  };
}

function mapBrowserActivity(activity: BrowserActivity): BrowserActivityView {
  return {
    id: activity.activityId,
    pageId: activity.pageId,
    ...(activity.toolCallId.length === 0 ? {} : { toolCallId: activity.toolCallId }),
    kind: browserActivityKind(activity.kind),
    description: activity.description,
    occurredAt: timestampMs(activity.occurredAt)
  };
}

function mapBrowserTransfer(transfer: BrowserTransfer): BrowserTransferView {
  const blob = transfer.blob ?? transfer.artifact?.blob;
  return {
    id: transfer.browserTransferId,
    browserId: transfer.browserProviderId,
    pageId: transfer.pageId,
    ...(transfer.toolCallId.length === 0 ? {} : { toolCallId: transfer.toolCallId }),
    direction: transfer.direction === TransferDirection.UPLOAD ? "upload" : transfer.direction === TransferDirection.DOWNLOAD ? "download" : "unknown",
    state: browserTransferState(transfer.state),
    ...(blob?.blobId ? { blobId: blob.blobId } : {}),
    ...(transfer.artifact?.artifactId ? { artifactId: transfer.artifact.artifactId } : {}),
    fileName: blob?.fileName || transfer.artifact?.title || transfer.browserTransferId,
    mediaType: blob?.mediaType ?? "",
    byteSize: numberValue(blob?.byteSize),
    startedAt: timestampMs(transfer.startedAt),
    ...(transfer.completedAt === undefined ? {} : { completedAt: timestampMs(transfer.completedAt) }),
    ...(transfer.error?.message ? { error: presentJokoServiceTerminology(transfer.error.message) } : {})
  };
}

function mapResource(resource: ManagedResource): ResourceView {
  return {
    id: resource.resourceId,
    backendId: resource.backendId,
    ...(resource.targetId.length === 0 ? {} : { targetId: resource.targetId }),
    name: resource.name,
    ...(resource.version.length === 0 ? {} : { version: resource.version }),
    kind: resourceKind(resource.kind),
    scope: resourceScope(resource.source?.scope),
    state: resourceState(resource.state),
    enabled: resource.enabled,
    source: resource.source?.sourceDisplay ?? "",
    discoveredRevision: resource.discoveredRevision,
    compatibilityDetails: resource.compatibilityDetails.map((detail) => ({
      kind: resourceKind(detail.kind),
      name: detail.name,
      compatibility: resourceCompatibility(detail.compatibility),
      issues: detail.issues.map(resourceCompatibilityIssue),
      detectedApis: detail.detectedApis.map(resourceUiApi),
      adaptedApis: detail.adaptedApis.map(resourceUiApi),
      unsupportedApis: detail.unsupportedApis.map(resourceUiApi)
    })),
    runtimeRequirements: resource.runtimeRequirements.map((requirement) => ({
      packageName: requirement.packageName,
      range: requirement.range,
      ...(requirement.currentVersion === undefined ? {} : { currentVersion: requirement.currentVersion }),
      status: requirement.status === ResourceRuntimeRequirementStatus.COMPATIBLE
        ? "compatible"
        : requirement.status === ResourceRuntimeRequirementStatus.INCOMPATIBLE
          ? "incompatible"
          : "unknown"
    })),
    warnings: resource.warnings.map(resourcePackageWarning),
    disabledLifecycleScripts: [...resource.disabledLifecycleScripts],
    canToggle: resource.canToggle,
    requiresExtensionApproval: resource.requiresExtensionApproval,
    ...(resource.extensionContentFingerprint.length === 0
      ? {}
      : { extensionContentFingerprint: resource.extensionContentFingerprint }),
    postMutationNotice: resource.postMutationNotice,
    ...(resource.error?.message ? { error: presentJokoServiceTerminology(resource.error.message) } : {})
  };
}

function mapRuntimeCommand(command: RuntimeCommand): RuntimeCommandView {
  return {
    id: command.commandId,
    ...(command.sessionId === "" ? {} : { sessionId: command.sessionId }),
    name: command.name,
    description: command.description,
    source: runtimeCommandSource(command.source),
    ...(command.resourceId.length > 0 ? { resourceId: command.resourceId } : {}),
    loaded: command.loaded
  };
}

function mapRuntimeToolCatalog(catalog: RuntimeToolCatalog): RuntimeToolCatalogView {
  if (catalog.observedAt === undefined) throw new GatewayError("Orchestrator returned a runtime tool catalog without an observation time.");
  return {
    runtimeGeneration: catalog.runtimeGeneration,
    observedAt: timestampMs(catalog.observedAt),
    tools: catalog.tools.map((tool) => {
      if (tool.inputSchema === undefined || tool.sourceInfo === undefined) {
        throw new GatewayError("Orchestrator returned an incomplete runtime tool descriptor.");
      }
      return {
        name: tool.name,
        description: tool.description,
        fields: tool.inputSchema.fields.map((field) => ({
          path: field.fieldPath,
          title: field.title,
          description: field.description,
          type: runtimeToolFieldType(field.type),
          required: field.required,
          secret: field.secret,
          enumValues: [...field.enumValues],
          ...(field.constraints === undefined
            ? {}
            : {
                constraints: {
                  ...(field.constraints.minimumLength === 0 ? {} : { minimumLength: field.constraints.minimumLength }),
                  ...(field.constraints.maximumLength === 0 ? {} : { maximumLength: field.constraints.maximumLength }),
                  ...(field.constraints.minimumNumber === 0 ? {} : { minimumNumber: field.constraints.minimumNumber }),
                  ...(field.constraints.maximumNumber === 0 ? {} : { maximumNumber: field.constraints.maximumNumber }),
                  ...(field.constraints.pattern === "" ? {} : { pattern: field.constraints.pattern }),
                  ...(field.constraints.itemFieldPath === "" ? {} : { itemPath: field.constraints.itemFieldPath })
                }
              })
        })),
        allowsAdditionalFields: tool.inputSchema.allowsAdditionalFields,
        promptGuidelines: [...tool.promptGuidelines],
        active: tool.active,
        source: {
          path: tool.sourceInfo.path,
          name: tool.sourceInfo.source,
          scope: tool.sourceInfo.scope === RuntimeToolSourceScope.USER
            ? "user"
            : tool.sourceInfo.scope === RuntimeToolSourceScope.PROJECT
              ? "project"
              : tool.sourceInfo.scope === RuntimeToolSourceScope.TEMPORARY ? "temporary" : "unknown",
          origin: tool.sourceInfo.origin === RuntimeToolSourceOrigin.PACKAGE
            ? "package"
            : tool.sourceInfo.origin === RuntimeToolSourceOrigin.TOP_LEVEL ? "topLevel" : "unknown",
          ...(tool.sourceInfo.baseDir === undefined ? {} : { baseDirectory: tool.sourceInfo.baseDir })
        }
      };
    })
  };
}

function runtimeToolFieldType(value: ToolFieldType): RuntimeToolFieldTypeView {
  switch (value) {
    case ToolFieldType.STRING: return "string";
    case ToolFieldType.NUMBER: return "number";
    case ToolFieldType.INTEGER: return "integer";
    case ToolFieldType.BOOLEAN: return "boolean";
    case ToolFieldType.OBJECT: return "object";
    case ToolFieldType.ARRAY: return "array";
    case ToolFieldType.BLOB: return "blob";
    default: return "unknown";
  }
}

function mapNativeSessionCandidate(candidate: NativeSessionCandidate): NativeSessionCandidateView {
  return {
    id: candidate.nativeSessionId,
    reference: candidate.nativeReference,
    name: candidate.name,
    workspaceRoot: candidate.workspaceRoot,
    messageCount: numberValue(candidate.messageCount),
    modifiedAt: timestampMs(candidate.modifiedAt),
    state: candidate.state === NativeSessionCandidateState.READY ? "ready" : "error",
    ...(candidate.boundSessionId === undefined || candidate.boundSessionId.length === 0 ? {} : { boundSessionId: candidate.boundSessionId })
  };
}

function mapNativeSessionCatalogEntry(entry: NativeSessionCatalogEntry): NativeSessionCatalogEntryView {
  const placement = entry.placement === NativeSessionPlacement.PROJECT
    ? "project"
    : entry.placement === NativeSessionPlacement.DIALOGUE
      ? "dialogue"
      : undefined;
  if (placement === undefined) throw new GatewayError("Orchestrator returned an invalid native task catalog placement.");
  const createdAt = timestampMs(entry.createdAt);
  const modifiedAt = timestampMs(entry.modifiedAt);
  if (createdAt > modifiedAt) throw new GatewayError("Orchestrator returned invalid native task catalog timestamps.");
  return {
    id: entry.nativeSessionId || entry.nativeReference,
    reference: entry.nativeReference,
    ...(entry.title === "" ? {} : { title: entry.title }),
    ...(entry.workingDirectory === undefined || entry.workingDirectory === ""
      ? {}
      : { workingDirectory: entry.workingDirectory }),
    ...(entry.projectDirectory === undefined || entry.projectDirectory === ""
      ? {}
      : { projectDirectory: entry.projectDirectory }),
    createdAt,
    modifiedAt,
    archived: entry.archived,
    placement,
    ...(entry.targetId === undefined || entry.targetId.length === 0 ? {} : { targetId: entry.targetId }),
    ...(entry.projectTargetId === undefined || entry.projectTargetId.length === 0
      ? {}
      : { projectTargetId: entry.projectTargetId }),
    ...(entry.existingSessionId === undefined || entry.existingSessionId.length === 0
      ? {}
      : { existingSessionId: entry.existingSessionId })
  };
}

function runtimeCommandSource(value: number): RuntimeCommandView["source"] {
  if (value === 1) return "extension";
  if (value === 2) return "prompt";
  if (value === 3) return "skill";
  if (value === 4) return "backend";
  return "unknown";
}

function mapRemoteConnection(connection: Connection): RemoteConnectionView {
  return {
    id: connection.connectionId,
    deviceId: connection.deviceId,
    name: connection.displayName,
    state: connection.state === ConnectionState.PAIRING ? "pairing" : connection.state === ConnectionState.CONNECTED ? "connected" : connection.state === ConnectionState.REVOKED ? "revoked" : connection.state === ConnectionState.LOGGED_OUT ? "loggedOut" : "disconnected",
    ...(connection.lastSeenAt === undefined ? {} : { lastSeenAt: timestampMs(connection.lastSeenAt) })
  };
}

function mapDevice(device: Device): DeviceView {
  return {
    id: device.deviceId,
    name: device.displayName,
    kind: device.kind === DeviceKind.WEB ? "web" : device.kind === DeviceKind.DESKTOP ? "desktop" : device.kind === DeviceKind.SERVICE ? "service" : "unknown",
    platform: device.platform,
    appVersion: device.appVersion,
    revoked: device.revoked,
    remoteControlEnabled: device.remoteControlEnabled,
    presence: device.presence === DevicePresenceState.ONLINE ? "online" : "offline",
    ...(device.lastSeenAt === undefined ? {} : { lastSeenAt: timestampMs(device.lastSeenAt) })
  };
}

function mapDeviceControlRelation(relation: DeviceControlRelation): DeviceControlRelationView {
  return {
    id: relation.relationId,
    controllerDeviceId: relation.controllerDeviceId,
    targetDeviceId: relation.targetDeviceId,
    outboundEnabled: relation.outboundEnabled,
    inboundAllowed: relation.inboundAllowed,
    effective: relation.effective,
    ...(relation.updatedAt === undefined ? {} : { updatedAt: timestampMs(relation.updatedAt) }),
    revision: relation.version?.revision?.value ?? 0n
  };
}

export function mapManagedModelRuntime(runtime: ManagedModelRuntime): ManagedModelRuntimeView {
  return {
    id: runtime.runtimeId,
    name: runtime.displayName,
    state: managedModelRuntimeState(runtime.state),
    source: managedModelRuntimeSource(runtime.source),
    ...(runtime.version === "" ? {} : { version: runtime.version }),
    capabilities: {
      canInstall: runtime.capabilities?.canInstall ?? false,
      canCancelInstall: runtime.capabilities?.canCancelInstall ?? false,
      canStart: runtime.capabilities?.canStart ?? false,
      canListModels: runtime.capabilities?.canListModels ?? false,
      canPullModels: runtime.capabilities?.canPullModels ?? false,
      canDeleteModels: runtime.capabilities?.canDeleteModels ?? false,
      canPausePulls: runtime.capabilities?.canPausePulls ?? false,
      canResumePulls: runtime.capabilities?.canResumePulls ?? false,
      canCancelPulls: runtime.capabilities?.canCancelPulls ?? false,
      supportsCustomModels: runtime.capabilities?.supportsCustomModels ?? false,
      supportsCuratedCatalog: runtime.capabilities?.supportsCuratedCatalog ?? false,
      supportsModelPreflight: runtime.capabilities?.supportsModelPreflight ?? false
    },
    installPreflight: mapManagedModelPreflight(runtime.installPreflight),
    installedModels: runtime.installedModels.map((model) => ({
      name: model.modelName,
      displayName: model.displayName || model.modelName,
      ...(model.sizeBytes === undefined ? {} : { sizeBytes: numberValue(model.sizeBytes) }),
      ...(model.contextWindowTokens === undefined ? {} : { contextWindowTokens: numberValue(model.contextWindowTokens) }),
      supportsTools: model.supportsTools,
      supportsImages: model.supportsImages,
      ...(model.requiredRuntimeVersion === "" ? {} : { requiredRuntimeVersion: model.requiredRuntimeVersion })
    })),
    catalog: runtime.catalog.map((model) => ({
      id: model.catalogId,
      name: model.modelName,
      displayName: model.displayName || model.modelName,
      sizeBytes: numberValue(model.sizeBytes),
      minimumMemoryGb: model.minimumMemoryGb,
      platformLimited: model.platformLimited,
      recommended: model.recommended,
      preflight: mapManagedModelPreflight(model.preflight)
    })),
    transfers: runtime.transfers.map((transfer) => ({
      kind: transfer.kind === ManagedModelRuntimeTransferKind.RUNTIME_INSTALL ? "runtimeInstall" : "modelPull",
      ...(transfer.modelName === "" ? {} : { modelName: transfer.modelName }),
      phase: managedModelRuntimeTransferPhase(transfer.phase),
      ...(transfer.completedBytes === undefined ? {} : { completedBytes: numberValue(transfer.completedBytes) }),
      ...(transfer.totalBytes === undefined ? {} : { totalBytes: numberValue(transfer.totalBytes) }),
      ...(transfer.percent === undefined ? {} : { percent: transfer.percent }),
      ...(transfer.bytesPerSecond === undefined ? {} : { bytesPerSecond: numberValue(transfer.bytesPerSecond) }),
      done: transfer.done,
      ...managedModelRuntimeError(transfer.errorCode)
    })),
    ...managedModelRuntimeError(runtime.errorCode),
    ...(runtime.errorMessage === "" ? {} : { errorMessage: runtime.errorMessage }),
    revision: runtime.entityVersion?.revision?.value ?? 0n
  };
}

function mapManagedModelPreflight(
  preflight: ManagedModelRuntime["installPreflight"] | undefined
): ManagedModelRuntimeView["installPreflight"] {
  return {
    allowed: preflight?.allowed ?? false,
    memory: preflight?.memory === ManagedModelRuntimeResourceState.SUFFICIENT
      ? "sufficient"
      : preflight?.memory === ManagedModelRuntimeResourceState.CONSTRAINED
        ? "constrained"
        : "unknown",
    disk: preflight?.disk === ManagedModelRuntimeResourceState.SUFFICIENT
      ? "sufficient"
      : preflight?.disk === ManagedModelRuntimeResourceState.INSUFFICIENT
        ? "insufficient"
        : "unknown",
    requiredDiskBytes: numberValue(preflight?.requiredDiskBytes),
    ...managedModelRuntimeError(preflight?.errorCode)
  };
}

function mapSettings(settings: SettingsSnapshot | undefined): SettingsView {
  if (settings === undefined) return emptySnapshot().settings;
  if (settings.agentResource === undefined || settings.collaboration === undefined || settings.gitSafety === undefined) {
    throw new Error("Orchestrator returned an incomplete governance settings snapshot.");
  }
  return {
    revision: settings?.revision?.value ?? 0n,
    providers: (settings?.providers ?? []).map(mapProviderConfiguration),
    credentials: (settings?.credentials ?? []).map(mapCredential),
    mcpServers: (settings?.mcpServers ?? []).map(mapMcpServer),
    browsers: (settings?.browsers ?? []).map((browser) => ({
      browserProviderId: browser.browserProviderId,
      targetSettings: browser.targetSettings.map((target) => ({ targetId: target.targetId, enabled: target.enabled })),
      backendHealth: {
        active: browser.backendHealth?.active ?? false,
        status: browserBackendStatus(browser.backendHealth?.status),
        canRecover: browser.backendHealth?.canRecover ?? false,
        ...browserBackendFailureReason(browser.backendHealth?.reason)
      },
      profileDisplayName: browser.profileDisplayName,
      takeoverTimeoutSeconds: durationSeconds(browser.takeoverTimeout),
      allowUploads: browser.allowUploads,
      allowDownloads: browser.allowDownloads,
      automationTarget: browser.automationTarget === BrowserAutomationTarget.SIDEBAR ? "sidebar" : "external",
      support: automationCapabilitySupport(browser.support),
      supportReason: browser.supportReason,
      detectedBrowser: browser.detectedBrowser
    })),
    computerAutomation: {
      enabled: settings?.computerAutomation?.enabled ?? false,
      support: automationCapabilitySupport(settings?.computerAutomation?.support),
      supportReason: settings?.computerAutomation?.supportReason ?? "",
      installed: settings?.computerAutomation?.installed ?? false,
      driverVersion: settings?.computerAutomation?.driverVersion ?? "",
      daemonRunning: settings?.computerAutomation?.daemonRunning ?? false,
      accessibilityPermission: automationPermissionState(settings?.computerAutomation?.accessibilityPermission),
      screenRecordingPermission: automationPermissionState(settings?.computerAutomation?.screenRecordingPermission),
      screenRecordingCapturable: settings?.computerAutomation?.screenRecordingCapturable ?? false,
      ready: settings?.computerAutomation?.ready ?? false,
      runtimeState: computerAutomationRuntimeState(settings?.computerAutomation?.runtimeState),
      failureReason: settings?.computerAutomation?.failureReason ?? "",
      platform: settings?.computerAutomation?.platform ?? "unknown",
      updateCurrentVersion: settings?.computerAutomation?.updateCurrentVersion ?? "",
      updateLatestVersion: settings?.computerAutomation?.updateLatestVersion ?? "",
      updateAvailable: settings?.computerAutomation?.updateAvailable ?? false,
      updateInProgress: settings?.computerAutomation?.updateInProgress ?? false,
      updatePhase: computerAutomationUpdatePhase(settings?.computerAutomation?.updatePhase),
      ...(settings?.computerAutomation?.updateDownloadedBytes === undefined
        ? {}
        : { updateDownloadedBytes: Number(settings.computerAutomation.updateDownloadedBytes) }),
      ...(settings?.computerAutomation?.updateTotalBytes === undefined
        ? {}
        : { updateTotalBytes: Number(settings.computerAutomation.updateTotalBytes) })
    },
    androidAutomation: {
      enabled: settings?.androidAutomation?.enabled ?? false,
      support: automationCapabilitySupport(settings?.androidAutomation?.support),
      supportReason: settings?.androidAutomation?.supportReason ?? "",
      adbAvailable: settings?.androidAutomation?.adbAvailable ?? false,
      adbPath: settings?.androidAutomation?.adbPath ?? "",
      adbPathSource: androidAdbPathSource(settings?.androidAutomation?.adbPathSource),
      preparationSupported: settings?.androidAutomation?.preparationSupported ?? false,
      preparationReady: settings?.androidAutomation?.preparationReady ?? false,
      preparationError: settings?.androidAutomation?.preparationError ?? "",
      adbVersion: settings?.androidAutomation?.adbVersion ?? "",
      devices: (settings?.androidAutomation?.devices ?? []).map((device) => ({
        deviceSerial: device.deviceSerial,
        state: device.state,
        product: device.product,
        model: device.model,
        device: device.device,
        transportId: device.transportId,
        usb: device.usb
      })),
      defaultDeviceSerial: settings?.androidAutomation?.defaultDeviceSerial ?? "",
      configuredDefaultDeviceSerial: settings?.androidAutomation?.configuredDefaultDeviceSerial ?? "",
      adbPathOverride: settings?.androidAutomation?.adbPathOverride ?? "",
      issue: androidAutomationIssue(settings?.androidAutomation?.issue),
      failureReason: settings?.androidAutomation?.failureReason ?? "",
      platform: settings?.androidAutomation?.platform ?? "unknown",
      runtimeState: androidAutomationRuntimeState(settings?.androidAutomation?.runtimeState),
      statusObserved: settings?.androidAutomation?.statusObserved ?? false
    },
    languageTools: {
      enabled: settings?.languageTools?.enabled ?? false
    },
    toolPolicies: (settings?.toolPolicies ?? []).map((policy) => ({
      toolProviderId: policy.toolProviderId,
      displayName: policy.displayName,
      description: policy.description,
      productDefaultEnabled: policy.productDefaultEnabled,
      userEffectiveEnabled: policy.userEffectiveEnabled,
      userEffectiveSource: toolPolicyEffectiveSource(policy.userEffectiveSource),
      ...(policy.userOverride === undefined ? {} : { userOverride: { enabled: policy.userOverride.enabled } }),
      targetSettings: policy.targetSettings.map((target) => ({
        targetId: target.targetId,
        effectiveEnabled: target.effectiveEnabled,
        effectiveSource: toolPolicyEffectiveSource(target.effectiveSource),
        ...(target.projectOverride === undefined
          ? {}
          : { projectOverride: { enabled: target.projectOverride.enabled } })
      }))
    })),
    agentResource: {
      maxConcurrentCommands: settings.agentResource.maxConcurrentCommands,
      processPriority: managedProcessPriorityView(settings.agentResource.processPriority),
      capToolchainThreads: settings.agentResource.capToolchainThreads,
      customized: settings.agentResource.customized,
      revision: settings.agentResource.version?.revision?.value ?? 0n
    },
    collaboration: {
      workerSoftLimit: settings.collaboration.workerSoftLimit,
      workerHardLimit: settings.collaboration.workerHardLimit,
      workerIdleReleaseMinutes: settings.collaboration.workerIdleReleaseMinutes,
      customized: settings.collaboration.customized,
      revision: settings.collaboration.version?.revision?.value ?? 0n
    },
    gitSafety: {
      autoSnapshotEnabled: settings.gitSafety.autoSnapshotEnabled,
      pendingTurns: settings.gitSafety.pendingTurns,
      trackedSessions: settings.gitSafety.trackedSessions,
      trackedRepositories: settings.gitSafety.trackedRepositories,
      cleanupAvailable: settings.gitSafety.cleanupAvailable,
      customized: settings.gitSafety.customized,
      revision: settings.gitSafety.version?.revision?.value ?? 0n
    },
    voiceInput: settings.voiceInput === undefined
      ? {
          enabled: false,
          protocol: "openAiCompatibleBatch",
          endpoint: "https://api.openai.com/v1/audio/transcriptions",
          model: "whisper-1",
          keyless: false,
          credentialConfigured: false,
          refinementEnabled: false,
          refinerProviderId: "",
          refinerModelId: "",
          refinerFallbackProviderId: "",
          refinerFallbackModelId: "",
          fallbackEnabled: false,
          fallbackProtocol: "openAiCompatibleBatch",
          fallbackEndpoint: "https://api.openai.com/v1/audio/transcriptions",
          fallbackModel: "whisper-1",
          fallbackKeyless: false,
          fallbackCredentialConfigured: false,
          revision: 0n
        }
      : {
          enabled: settings.voiceInput.enabled,
          protocol: voiceInputProtocolView(settings.voiceInput.protocol),
          endpoint: settings.voiceInput.endpoint,
          model: settings.voiceInput.model,
          keyless: settings.voiceInput.keyless,
          credentialConfigured: settings.voiceInput.credentialConfigured,
          refinementEnabled: settings.voiceInput.refinementEnabled,
          refinerProviderId: settings.voiceInput.refinerProviderId,
          refinerModelId: settings.voiceInput.refinerModelId,
          refinerFallbackProviderId: settings.voiceInput.refinerFallbackProviderId,
          refinerFallbackModelId: settings.voiceInput.refinerFallbackModelId,
          fallbackEnabled: settings.voiceInput.fallbackEnabled,
          fallbackProtocol: voiceInputProtocolView(settings.voiceInput.fallbackProtocol),
          fallbackEndpoint: settings.voiceInput.fallbackEndpoint,
          fallbackModel: settings.voiceInput.fallbackModel,
          fallbackKeyless: settings.voiceInput.fallbackKeyless,
          fallbackCredentialConfigured: settings.voiceInput.fallbackCredentialConfigured,
          revision: settings.voiceInput.version?.revision?.value ?? 0n
        },
    backendSettings: (settings?.backends ?? []).map((backend) => ({
      backendId: backend.backendId,
      enabled: backend.enabled,
      permissionMode: uiPermission(backend.defaultPermissionMode),
      planMode: backend.defaultPlanMode,
      modelAccess: {
        disabledProviderIds: [...(backend.modelAccess?.disabledProviderIds ?? [])],
        disabledModels: (backend.modelAccess?.disabledModels ?? []).map((model) => ({
          providerId: model.providerId,
          modelId: model.modelId
        }))
      },
      ...(backend.defaultModel?.model === undefined ? {} : { model: { providerId: backend.defaultModel.model.providerId, modelId: backend.defaultModel.model.modelId, ...(backend.defaultModel.effortId.length === 0 ? {} : { effort: backend.defaultModel.effortId }), fastMode: backend.defaultModel.fastMode } })
    })),
    pi: (settings?.pi ?? []).map((pi) => ({
      backendId: pi.backendId,
      autoCompaction: pi.autoCompaction,
      autoCompactionThresholdPercent: pi.autoCompactionThresholdPercent || 75,
      autoCompactionThresholdCustomized: pi.autoCompactionThresholdCustomized,
      autoRetry: pi.autoRetry,
      steeringMode: pi.steeringMode === PiQueueMode.ONE_AT_A_TIME ? "oneAtATime" : "all",
      followUpMode: pi.followUpMode === PiQueueMode.ONE_AT_A_TIME ? "oneAtATime" : "all"
    })),
    policy: {
      defaultMode: uiPermission(settings?.policy?.defaultMode ?? ProtoPermissionMode.ASK),
      projectTrustRequired: settings?.policy?.projectTrustRequired ?? true,
      redactCredentials: settings?.policy?.redactCredentials ?? true,
      stripChildProcessCredentials: settings?.policy?.stripChildProcessCredentials ?? true,
      ruleCount: settings?.policy?.rules.length ?? 0
    },
    diagnostics: {
      level: diagnosticLevel(settings?.diagnostics?.level),
      retentionSeconds: durationSeconds(settings?.diagnostics?.retention),
      includeSanitizedBackendPayloads: settings?.diagnostics?.includeSanitizedBackendPayloads ?? false,
      includePerformanceMetrics: settings?.diagnostics?.includePerformanceMetrics ?? false
    },
    messageSearch: {
      semanticIndexEnabled: settings?.messageSearch?.semanticIndexEnabled ?? true,
      vectorAvailable: settings?.messageSearch?.vectorAvailable ?? false,
      embeddingProviderAvailable: settings?.messageSearch?.embeddingProviderAvailable ?? false,
      modelId: settings?.messageSearch?.modelId || "voyage/voyage-4",
      pendingCount: numberValue(settings?.messageSearch?.pendingCount),
      runningCount: numberValue(settings?.messageSearch?.runningCount),
      doneCount: numberValue(settings?.messageSearch?.doneCount),
      failedCount: numberValue(settings?.messageSearch?.failedCount),
      customized: settings?.messageSearch?.customized ?? false
    },
    memory: {
      makerEnabled: settings?.memory?.makerEnabled ?? true,
      makerSupported: settings?.memory?.makerSupport === CapabilitySupport.SUPPORTED,
      makerReason: settings?.memory?.makerReason ?? "Maker Memory is unavailable.",
      customized: settings?.memory?.customized ?? false,
      entryCount: numberValue(settings?.memory?.entryCount),
      backends: (settings?.memory?.backends ?? []).map((backend) => ({
        backendId: backend.backendId,
        enabled: backend.enabled,
        supported: backend.support === CapabilitySupport.SUPPORTED,
        reason: backend.reason,
        entryCount: numberValue(backend.entryCount)
      }))
    },
    visionBridge: {
      enabled: settings?.visionBridge?.enabled ?? false,
      targetModels: (settings?.visionBridge?.targetModels ?? []).map((target) => ({
        backendId: target.backendId,
        providerId: target.providerId,
        modelId: target.modelId
      })),
      ...(settings?.visionBridge?.primary === undefined
        ? {}
        : { primary: { backendId: settings.visionBridge.primary.backendId, providerId: settings.visionBridge.primary.providerId, modelId: settings.visionBridge.primary.modelId } }),
      ...(settings?.visionBridge?.fallback === undefined
        ? {}
        : { fallback: { backendId: settings.visionBridge.fallback.backendId, providerId: settings.visionBridge.fallback.providerId, modelId: settings.visionBridge.fallback.modelId } }),
      available: settings?.visionBridge?.available ?? false,
      unavailableReason: settings?.visionBridge?.unavailableReason ?? "Vision Bridge is unavailable.",
      customized: settings?.visionBridge?.customized ?? false,
      customizedFields: settings?.visionBridge?.customizedFields ?? []
    },
    promptRecommendation: {
      enabled: settings?.promptRecommendation?.enabled ?? true,
      available: settings?.promptRecommendation?.available ?? false,
      unavailableReason: settings?.promptRecommendation?.unavailableReason ?? "Prompt recommendation is unavailable.",
      customized: settings?.promptRecommendation?.customized ?? false
    },
    personalization: {
      silentEncryptedRetryEnabled: settings?.personalization?.silentEncryptedRetryEnabled ?? true,
      silentEncryptedRetryCustomized: settings?.personalization?.silentEncryptedRetryCustomized ?? false,
      sessionRuntimeFallbackEnabled: settings?.personalization?.sessionRuntimeFallbackEnabled ?? false,
      sessionRuntimeFallbackCustomized: settings?.personalization?.sessionRuntimeFallbackCustomized ?? false
    }
  };
}

function mapWorkspaceFileDiff(file: FileDiff, evidenceId?: string): WorkspaceFileDiffView {
  return {
    path: file.relativePath,
    ...(file.oldRelativePath.length > 0 ? { oldPath: file.oldRelativePath } : {}),
    source: workspaceFileSource(file.source),
    ...(evidenceId === undefined ? {} : { evidenceId }),
    status: gitFileStatus(file.status),
    binary: file.binary,
    text: file.hunks.map((hunk) => [
      `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@${hunk.heading ? ` ${hunk.heading}` : ""}`,
      ...hunk.lines.map((line) => `${diffLinePrefix(line.kind)}${line.text}`)
    ].join("\n")).join("\n"),
    hunks: file.hunks.map((hunk) => ({
      oldStart: hunk.oldStart,
      oldCount: hunk.oldCount,
      newStart: hunk.newStart,
      newCount: hunk.newCount,
      heading: hunk.heading,
      lines: hunk.lines.map((line) => ({
        kind: diffLineKind(line.kind),
        oldLine: line.oldLine,
        newLine: line.newLine,
        text: line.text
      }))
    })),
    ...(file.fullDiff?.blobId ? { fullDiffBlobId: file.fullDiff.blobId } : {})
  };
}

function mapProviderConfiguration(provider: ProviderConfiguration): SettingsView["providers"][number] {
  return {
    id: provider.providerId,
    name: provider.displayName,
    kind: providerKind(provider.kind),
    compatibility: providerCompatibility(provider.apiCompatibility),
    endpoint: provider.endpoint,
    credentialId: provider.credentialReferenceId,
    enabled: provider.enabled,
    keyless: provider.keyless,
    authHeader: provider.authHeader,
    environmentName: provider.apiKeyEnvironment,
    modelCount: provider.models.length,
    headers: provider.headers.map((header) => ({
      headerName: header.headerName,
      environmentName: header.environmentName,
      credentialId: header.credentialReferenceId
    })),
    models: provider.models.map((model) => ({
      modelId: model.modelId,
      name: model.displayName,
      ...(model.apiCompatibility === undefined ? {} : { compatibility: providerCompatibility(model.apiCompatibility) }),
      reasoning: model.reasoning,
      inputModalities: model.inputModalities.map(inputModality),
      contextWindowTokens: numberValue(model.contextWindowTokens),
      maximumOutputTokens: numberValue(model.maximumOutputTokens),
      inputCostMicrosPerMillion: numberValueSigned(model.inputCostMicrosPerMillion),
      outputCostMicrosPerMillion: numberValueSigned(model.outputCostMicrosPerMillion),
      cacheReadCostMicrosPerMillion: numberValueSigned(model.cacheReadCostMicrosPerMillion),
      cacheWriteCostMicrosPerMillion: numberValueSigned(model.cacheWriteCostMicrosPerMillion),
      thinkingLevels: model.thinkingLevels.map((level) => ({ effortId: level.effortId, ...(level.nativeLevel === undefined ? {} : { nativeLevel: level.nativeLevel }) })),
      ...(model.sampling === undefined ? {} : { sampling: {
        ...(model.sampling.temperature === undefined ? {} : { temperature: model.sampling.temperature }),
        ...(model.sampling.topP === undefined ? {} : { topP: model.sampling.topP }),
        ...(model.sampling.topK === undefined ? {} : { topK: model.sampling.topK }),
        ...(model.sampling.minP === undefined ? {} : { minP: model.sampling.minP }),
        ...(model.sampling.repetitionPenalty === undefined ? {} : { repetitionPenalty: model.sampling.repetitionPenalty }),
        ...(model.sampling.frequencyPenalty === undefined ? {} : { frequencyPenalty: model.sampling.frequencyPenalty }),
        ...(model.sampling.presencePenalty === undefined ? {} : { presencePenalty: model.sampling.presencePenalty }),
        ...(model.sampling.seed === undefined ? {} : { seed: numberValue(model.sampling.seed) })
      } }),
      ...(model.compatibility === undefined ? {} : { compatibilityOptions: {
        ...(model.compatibility.supportsDeveloperRole === undefined ? {} : { supportsDeveloperRole: model.compatibility.supportsDeveloperRole }),
        ...(model.compatibility.supportsReasoningEffort === undefined ? {} : { supportsReasoningEffort: model.compatibility.supportsReasoningEffort }),
        ...(model.compatibility.supportsUsageInStreaming === undefined ? {} : { supportsUsageInStreaming: model.compatibility.supportsUsageInStreaming }),
        ...(model.compatibility.supportsFinishReason === undefined ? {} : { supportsFinishReason: model.compatibility.supportsFinishReason }),
        ...(model.compatibility.requiresReasoningContentOnAssistantMessages === undefined ? {} : { requiresReasoningContentOnAssistantMessages: model.compatibility.requiresReasoningContentOnAssistantMessages }),
        ...(model.compatibility.supportsStore === undefined ? {} : { supportsStore: model.compatibility.supportsStore }),
        ...(model.compatibility.supportsStrictMode === undefined ? {} : { supportsStrictMode: model.compatibility.supportsStrictMode }),
        ...(model.compatibility.supportsOpenaiGrammarTools === undefined ? {} : { supportsOpenaiGrammarTools: model.compatibility.supportsOpenaiGrammarTools }),
        ...(model.compatibility.supportsEagerToolInputStreaming === undefined ? {} : { supportsEagerToolInputStreaming: model.compatibility.supportsEagerToolInputStreaming }),
        ...(model.compatibility.supportsLongCacheRetention === undefined ? {} : { supportsLongCacheRetention: model.compatibility.supportsLongCacheRetention }),
        ...(model.compatibility.supportsCacheControlOnTools === undefined ? {} : { supportsCacheControlOnTools: model.compatibility.supportsCacheControlOnTools }),
        ...(model.compatibility.supportsStrictTools === undefined ? {} : { supportsStrictTools: model.compatibility.supportsStrictTools }),
        ...(model.compatibility.thinkingFormat === undefined ? {} : { thinkingFormat: model.compatibility.thinkingFormat }),
        ...(model.compatibility.cacheControlFormat === undefined ? {} : { cacheControlFormat: model.compatibility.cacheControlFormat })
      } }),
      supportsFastMode: model.supportsFastMode,
      ...(model.defaultVisible === undefined ? {} : { defaultVisible: model.defaultVisible })
    }))
  };
}

function mapCredential(credential: CredentialDescriptor): SettingsView["credentials"][number] {
  return {
    id: credential.credentialReferenceId,
    name: credential.displayName,
    kind: credentialKind(credential.kind),
    providerId: credential.providerId,
    configured: credential.configured,
    ...(credential.expiresAt === undefined ? {} : { expiresAt: timestampMs(credential.expiresAt) }),
    ...(credential.lastRefreshedAt === undefined ? {} : { lastRefreshedAt: timestampMs(credential.lastRefreshedAt) }),
    ...(credential.error?.message ? { error: presentJokoServiceTerminology(credential.error.message) } : {})
  };
}

function mapMcpServer(server: McpServerDescriptor): McpServerView {
  const transport = server.transport === McpTransport.STDIO ? "stdio" : server.transport === McpTransport.HTTPS_STREAMABLE_HTTP ? "https" : "loopback";
  const stdio = server.transportConfig.case === "stdio" ? server.transportConfig.value : undefined;
  const streamableHttp = server.transportConfig.case === "streamableHttp" ? server.transportConfig.value : undefined;
  if (transport === "stdio" && stdio === undefined) throw new GatewayError("Orchestrator returned an incomplete Stdio MCP configuration.");
  if (transport === "https" && streamableHttp === undefined) throw new GatewayError("Orchestrator returned an incomplete HTTP MCP configuration.");
  const credentialBindings = server.credentialBindings.map((binding) => {
    const target = binding.target === McpCredentialTarget.HEADER
      ? "header" as const
      : binding.target === McpCredentialTarget.ENVIRONMENT
        ? "environment" as const
        : undefined;
    if (target === undefined || binding.credentialReferenceId.trim().length === 0 || binding.targetName.trim().length === 0) {
      throw new GatewayError("Orchestrator returned an incomplete MCP credential binding.");
    }
    return {
      credentialId: binding.credentialReferenceId,
      target,
      name: binding.targetName,
      configured: binding.configured
    };
  });
  return {
    id: server.mcpServerId,
    name: server.displayName,
    transport,
    endpoint: streamableHttp?.endpoint ?? (transport === "https" ? server.endpointDisplay : ""),
    state: server.state === McpServerState.DISABLED ? "disabled" : server.state === McpServerState.STARTING ? "starting" : server.state === McpServerState.CONNECTED ? "connected" : server.state === McpServerState.DEGRADED ? "degraded" : server.state === McpServerState.ERROR ? "error" : "disconnected",
    generation: server.runtimeGeneration,
    toolCount: server.tools.length,
    credentialIds: credentialBindings.map((binding) => binding.credentialId),
    credentialBindings,
    enabled: server.enabled,
    command: stdio?.command ?? "",
    arguments: [...(stdio?.arguments ?? [])],
    workingDirectory: stdio?.workingDirectory ?? "",
    environment: (stdio?.environment ?? []).map((variable) => ({ name: variable.name, value: variable.value })),
    revision: server.version?.revision?.value ?? 0n,
    ...(server.error?.message ? { error: presentJokoServiceTerminology(server.error.message) } : {})
  };
}

export function mapNativeTreeNode(node: NativeSessionTreeNestedNode): NativeSessionTreeNodeView {
  return mapNativeTreeNodes([node])[0]!;
}

function mapNativeTreeNodes(
  nodes: readonly NativeSessionTreeNestedNode[]
): NativeSessionTreeNodeView[] {
  const roots: NativeSessionTreeNodeView[] = [];
  const seenNodes = new Set<object>();
  const seenEntryIds = new Set<string>();
  const stack: Array<{
    readonly node: NativeSessionTreeNestedNode;
    readonly output: NativeSessionTreeNodeView[];
    readonly mappedChildren?: NativeSessionTreeNodeView[];
  }> = [];
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    stack.push({ node: nodes[index]!, output: roots });
  }
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.mappedChildren !== undefined) {
      frame.output.push(nativeTreeNodeView(frame.node, frame.mappedChildren));
      continue;
    }
    if (
      typeof frame.node !== "object" ||
      frame.node === null ||
      frame.node.entryId.length === 0 ||
      !Array.isArray(frame.node.children)
    ) throw new GatewayError("Orchestrator returned an invalid Native Session tree node.");
    if (seenNodes.has(frame.node) || seenEntryIds.has(frame.node.entryId)) {
      throw new GatewayError("Orchestrator returned a cyclic or repeated Native Session tree node.");
    }
    seenNodes.add(frame.node);
    seenEntryIds.add(frame.node.entryId);
    const mappedChildren: NativeSessionTreeNodeView[] = [];
    stack.push({ ...frame, mappedChildren });
    for (let index = frame.node.children.length - 1; index >= 0; index -= 1) {
      stack.push({ node: frame.node.children[index]!, output: mappedChildren });
    }
  }
  return roots;
}

function nativeTreeNodeView(
  node: NativeSessionTreeNestedNode,
  children: NativeSessionTreeNodeView[]
): NativeSessionTreeNodeView {
  const role = node.kind === NativeEntryKind.USER_MESSAGE ? "user" : node.kind === NativeEntryKind.ASSISTANT_MESSAGE ? "assistant" : node.kind === NativeEntryKind.TOOL_RESULT ? "tool" : undefined;
  return {
    id: node.entryId,
    ...(node.parentEntryId.length === 0 ? {} : { parentId: node.parentEntryId }),
    kind: nativeTreeNodeKind(node.kind),
    ...(role === undefined ? {} : { role }),
    text: node.summary,
    ...(node.summary.length === 0 ? {} : { summary: node.summary }),
    ...(node.createdAt === undefined ? {} : { createdAt: timestampMs(node.createdAt) }),
    active: node.active,
    children
  };
}

function requireRemoteHost(host: ProtoRemoteHost | undefined): RemoteHostView {
  if (host === undefined) throw new GatewayError("Orchestrator returned no Remote Host.");
  return mapRemoteHost(host);
}

function mapRemoteHost(host: ProtoRemoteHost): RemoteHostView {
  const revision = host.revision?.value ?? 0n;
  const status = host.status;
  if (
    host.targetId.trim() === "" || host.hostId.trim() === "" || host.hostname.trim() === "" ||
    host.user.trim() === "" || host.port < 1 || host.port > 65_535 || revision <= 0n ||
    status === undefined || status.changedAt === undefined
  ) throw new GatewayError("Orchestrator returned an incomplete Remote Host.");
  const state = remoteHostStatus(status.state);
  const failure = status.failure;
  if ((state === "failed") !== (failure !== undefined)) {
    throw new GatewayError("Orchestrator returned an inconsistent Remote Host status.");
  }
  const authentication = host.authenticationMode === RemoteHostAuthenticationMode.SYSTEM_AGENT
    ? "systemAgent" as const
    : host.authenticationMode === RemoteHostAuthenticationMode.PRIVATE_KEY
      ? "privateKey" as const
      : (() => { throw new GatewayError("Orchestrator returned an unknown Remote Host authentication mode."); })();
  if (
    (authentication === "systemAgent" && host.credentialReferenceId !== undefined) ||
    (authentication === "privateKey" && (host.credentialReferenceId?.trim() ?? "") === "")
  ) {
    throw new GatewayError("Orchestrator returned an inconsistent Remote Host authentication mode.");
  }
  if (host.trust !== undefined && (
    host.trust.algorithm.trim() === "" || host.trust.sha256Fingerprint.trim() === "" ||
    host.trust.pinnedAt === undefined
  )) {
    throw new GatewayError("Orchestrator returned an incomplete Remote Host trust pin.");
  }
  return {
    targetId: host.targetId,
    id: host.hostId,
    hostname: host.hostname,
    port: host.port,
    user: host.user,
    source: host.source === RemoteHostSource.MANUAL
      ? "manual"
      : host.source === RemoteHostSource.SSH_CONFIG
        ? "sshConfig"
        : (() => { throw new GatewayError("Orchestrator returned an unknown Remote Host source."); })(),
    authentication,
    ...(host.credentialReferenceId === undefined ? {} : { credentialReferenceId: host.credentialReferenceId }),
    ...(host.trust === undefined ? {} : {
      trust: {
        algorithm: host.trust.algorithm,
        sha256Fingerprint: host.trust.sha256Fingerprint,
        pinnedAt: timestampMs(host.trust.pinnedAt)
      }
    }),
    status: {
      state,
      changedAt: timestampMs(status.changedAt),
      ...(failure === undefined ? {} : {
        failure: { code: remoteHostFailureCode(failure.code), retryable: failure.retryable }
      })
    },
    revision
  };
}

function remoteHostStatus(value: RemoteHostStatus): RemoteHostView["status"]["state"] {
  if (value === RemoteHostStatus.DISCONNECTED) return "disconnected";
  if (value === RemoteHostStatus.CONNECTING) return "connecting";
  if (value === RemoteHostStatus.AUTHENTICATING) return "authenticating";
  if (value === RemoteHostStatus.READY) return "ready";
  if (value === RemoteHostStatus.FAILED) return "failed";
  throw new GatewayError("Orchestrator returned an unknown Remote Host status.");
}

function remoteHostFailureCode(value: RemoteHostFailureCode): string {
  switch (value) {
    case RemoteHostFailureCode.ABORTED: return "aborted";
    case RemoteHostFailureCode.AUTHENTICATION_FAILED: return "authenticationFailed";
    case RemoteHostFailureCode.CONNECTION_FAILED: return "connectionFailed";
    case RemoteHostFailureCode.CONNECTION_TIMEOUT: return "connectionTimeout";
    case RemoteHostFailureCode.CONNECTOR_PROTOCOL: return "connectorProtocol";
    case RemoteHostFailureCode.CONNECTOR_UNAVAILABLE: return "connectorUnavailable";
    case RemoteHostFailureCode.HOST_KEY_CHANGED: return "hostKeyChanged";
    case RemoteHostFailureCode.HOST_KEY_CONFLICT: return "hostKeyConflict";
    case RemoteHostFailureCode.HOST_KEY_INVALID: return "hostKeyInvalid";
    case RemoteHostFailureCode.HOST_KEY_MISSING: return "hostKeyMissing";
    case RemoteHostFailureCode.HOST_KEY_STORE_CORRUPT: return "hostKeyStoreCorrupt";
    case RemoteHostFailureCode.HOST_KEY_STORE_MISSING: return "hostKeyStoreMissing";
    case RemoteHostFailureCode.HOST_KEY_STORE_UNREADABLE: return "hostKeyStoreUnreadable";
    case RemoteHostFailureCode.HOST_KEY_STORE_WRITE_FAILED: return "hostKeyStoreWriteFailed";
    default: throw new GatewayError("Orchestrator returned an unknown Remote Host failure code.");
  }
}

function protoRemoteHostAuthentication(value: RemoteHostDraft["authentication"]): RemoteHostAuthenticationMode {
  return value === "privateKey"
    ? RemoteHostAuthenticationMode.PRIVATE_KEY
    : RemoteHostAuthenticationMode.SYSTEM_AGENT;
}

function compareRemoteHosts(left: RemoteHostView, right: RemoteHostView): number {
  return left.id.localeCompare(right.id) || left.hostname.localeCompare(right.hostname);
}

function mapSessionMessageSearchMatch(match: SessionMessageSearchMatch): SessionMessageSearchMatchView {
  const role = (() => {
    switch (match.role) {
      case SessionMessageSearchRole.USER: return "user" as const;
      case SessionMessageSearchRole.ASSISTANT: return "assistant" as const;
      default: throw new GatewayError("Orchestrator returned an unsupported message-search role.");
    }
  })();
  if (match.kind !== SessionMessageSearchKind.TEXT_MESSAGE) {
    throw new GatewayError("Orchestrator returned an unsupported message-search result kind.");
  }
  return {
    sessionId: match.sessionId,
    eventId: match.eventId,
    timelineItemId: match.timelineItemId,
    role,
    kind: "textMessage",
    snippet: match.snippet,
    createdAt: timestampMs(match.createdAt),
    score: Number.isFinite(match.score) ? Math.min(1, Math.max(0, match.score)) : 0,
    ...(match.ftsRank === undefined || match.ftsRank < 1 ? {} : { ftsRank: match.ftsRank }),
    ...(match.vectorRank === undefined || match.vectorRank < 1 ? {} : { vectorRank: match.vectorRank })
  };
}

async function loadSessionMessageSearchPage(
  transport: Transport,
  query: string,
  pageToken: string,
  pageSize: number,
  scope: SessionMessageSearchScopeView,
  semanticMode: "hybrid" | "keyword",
  filters: SessionMessageSearchFiltersView | undefined,
  signal?: AbortSignal
): Promise<SessionMessageSearchPageView> {
  throwIfAborted(signal);
  const client = createClient(SessionService, transport);
  const response = await client.searchSessionMessages({
    scope: sessionMessageSearchScope(scope),
    query,
    page: { pageSize: Math.min(Math.max(Math.trunc(pageSize), 1), 100), pageToken },
    semanticMode: semanticMode === "keyword"
      ? SessionMessageSearchSemanticMode.KEYWORD
      : SessionMessageSearchSemanticMode.HYBRID,
    ...(filters === undefined ? {} : { filters: sessionMessageSearchFilters(filters) })
  }, signal === undefined ? undefined : { signal });
  throwIfAborted(signal);
  const totalSize = Number(response.page?.totalSize ?? 0n);
  if (!Number.isSafeInteger(totalSize) || totalSize < 0) {
    throw new GatewayError("Orchestrator returned an invalid message-search result size.");
  }
  return {
    matches: response.matches.map(mapSessionMessageSearchMatch),
    ...(response.page?.nextPageToken ? { nextPageToken: response.page.nextPageToken } : {}),
    totalSize,
    revision: response.revision?.value ?? 0n,
    vectorUsed: response.vectorUsed,
    ...(response.vectorSkipReason === "" ? {} : { vectorSkipReason: response.vectorSkipReason }),
    poolCapped: response.poolCapped
  };
}

function normalizeSessionMessageSearchFilters(
  filters: SessionMessageSearchFiltersView | undefined
): SessionMessageSearchFiltersView | undefined {
  if (filters === undefined) return undefined;
  const copy = (values: readonly string[] | undefined): readonly string[] | undefined =>
    values === undefined ? undefined : [...values];
  return {
    ...(filters.targetIds === undefined ? {} : { targetIds: copy(filters.targetIds) }),
    ...(filters.sessionIds === undefined ? {} : { sessionIds: copy(filters.sessionIds) }),
    ...(filters.backendIds === undefined ? {} : { backendIds: copy(filters.backendIds) }),
    ...(filters.sessionStatus === undefined ? {} : { sessionStatus: filters.sessionStatus }),
    ...(filters.sessionActivityFrom === undefined ? {} : { sessionActivityFrom: filters.sessionActivityFrom }),
    ...(filters.messageCreatedFrom === undefined ? {} : { messageCreatedFrom: filters.messageCreatedFrom }),
    ...(filters.messageCreatedBefore === undefined ? {} : { messageCreatedBefore: filters.messageCreatedBefore })
  };
}

function sessionMessageSearchFilters(filters: SessionMessageSearchFiltersView): {
  readonly targetIds?: { readonly values: string[] };
  readonly sessionIds?: { readonly values: string[] };
  readonly backendIds?: { readonly values: string[] };
  readonly sessionStatus: SessionMessageSearchSessionStatus;
  readonly sessionActivityFrom?: { readonly seconds: bigint; readonly nanos: number };
  readonly messageCreatedFrom?: { readonly seconds: bigint; readonly nanos: number };
  readonly messageCreatedBefore?: { readonly seconds: bigint; readonly nanos: number };
} {
  return {
    ...(filters.targetIds === undefined ? {} : { targetIds: { values: [...filters.targetIds] } }),
    ...(filters.sessionIds === undefined ? {} : { sessionIds: { values: [...filters.sessionIds] } }),
    ...(filters.backendIds === undefined ? {} : { backendIds: { values: [...filters.backendIds] } }),
    sessionStatus: filters.sessionStatus === "active"
      ? SessionMessageSearchSessionStatus.ACTIVE
      : filters.sessionStatus === "archived"
        ? SessionMessageSearchSessionStatus.ARCHIVED
        : SessionMessageSearchSessionStatus.UNSPECIFIED,
    ...(filters.sessionActivityFrom === undefined
      ? {}
      : { sessionActivityFrom: messageSearchTimestamp(filters.sessionActivityFrom, "Session activity cutoff") }),
    ...(filters.messageCreatedFrom === undefined
      ? {}
      : { messageCreatedFrom: messageSearchTimestamp(filters.messageCreatedFrom, "Message start time") }),
    ...(filters.messageCreatedBefore === undefined
      ? {}
      : { messageCreatedBefore: messageSearchTimestamp(filters.messageCreatedBefore, "Message end time") })
  };
}

function messageSearchTimestamp(value: number, label: string): { readonly seconds: bigint; readonly nanos: number } {
  if (!Number.isSafeInteger(value)) throw new GatewayError(`${label} must be an integer Unix timestamp.`);
  return timestampFromMs(value);
}

function messageSearchMatchIdentity(match: SessionMessageSearchMatchView): string {
  return JSON.stringify([match.sessionId, match.eventId, match.timelineItemId]);
}

function combinedAbortSignal(...candidates: readonly (AbortSignal | undefined)[]): AbortSignal | undefined {
  const signals = candidates.filter((candidate): candidate is AbortSignal => candidate !== undefined);
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}

const WORKSPACE_SEARCH_PAGE_TOKEN_PREFIX = "joko-workspace-search-v1:";

function encodeWorkspaceSearchPageToken(serverToken: string, revision: string): string {
  return `${WORKSPACE_SEARCH_PAGE_TOKEN_PREFIX}${encodeURIComponent(JSON.stringify({ token: serverToken, revision }))}`;
}

function decodeWorkspaceSearchPageToken(value: string | undefined): {
  readonly serverToken: string;
  readonly expectedRevision?: string;
} {
  if (value === undefined || value === "") return { serverToken: "" };
  if (!value.startsWith(WORKSPACE_SEARCH_PAGE_TOKEN_PREFIX) || value.length > 4_096) {
    throw new GatewayError("Workspace-search page token is invalid.");
  }
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(value.slice(WORKSPACE_SEARCH_PAGE_TOKEN_PREFIX.length)));
    if (
      typeof parsed !== "object"
      || parsed === null
      || !("token" in parsed)
      || !("revision" in parsed)
      || typeof parsed.token !== "string"
      || typeof parsed.revision !== "string"
      || parsed.token === ""
      || parsed.revision === ""
    ) throw new Error("invalid");
    return { serverToken: parsed.token, expectedRevision: parsed.revision };
  } catch {
    throw new GatewayError("Workspace-search page token is invalid.");
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  if (signal.reason !== undefined) throw signal.reason;
  throw new DOMException("The operation was aborted.", "AbortError");
}

function abortedGatewayRequest(): DOMException {
  return new DOMException("The Orchestrator connection changed while the request was running.", "AbortError");
}

function isMessageSearchRevisionDriftError(error: unknown): boolean {
  let candidate: unknown = error;
  const seen = new Set<unknown>();
  while (candidate instanceof Error && !seen.has(candidate)) {
    if (candidate instanceof ConnectError && candidate.code === Code.Aborted) return true;
    seen.add(candidate);
    candidate = candidate.cause;
  }
  return false;
}

function sessionMessageSearchScope(scope: SessionMessageSearchScopeView):
  | { readonly case: "owner"; readonly value: Record<string, never> }
  | { readonly case: "targetId"; readonly value: string }
  | { readonly case: "sessionId"; readonly value: string } {
  if (scope.kind === "session") return { case: "sessionId", value: scope.sessionId };
  if (scope.kind === "target") return { case: "targetId", value: scope.targetId };
  return { case: "owner", value: {} };
}

function nativeTreeNodeKind(kind: NativeEntryKind): NativeSessionTreeNodeView["kind"] {
  switch (kind) {
    case NativeEntryKind.USER_MESSAGE:
    case NativeEntryKind.ASSISTANT_MESSAGE:
    case NativeEntryKind.TOOL_RESULT: return "message";
    case NativeEntryKind.MODEL_CHANGE: return "model";
    case NativeEntryKind.COMPACTION: return "compaction";
    case NativeEntryKind.BRANCH_SUMMARY: return "summary";
    case NativeEntryKind.CUSTOM: return "custom";
    default: return "unknown";
  }
}

function operationSessionId(operation: Operation): string {
  const payload = operation.result?.payload;
  const sessionId = payload?.case === "session" ? payload.value.sessionId : "";
  if (sessionId.length === 0) throw new GatewayError("Orchestrator completed the operation without a derived task.");
  return sessionId;
}

function scheduleRunsReadCount(operation: Operation): number {
  const payload = operation.result?.payload;
  if (payload?.case !== "scheduleRunsRead") {
    throw new GatewayError("Orchestrator completed the read acknowledgement without an updated run count.");
  }
  const count = exactSafeUnsignedNumber(payload.value.updatedCount);
  if (count === undefined) throw new GatewayError("Orchestrator returned an invalid updated run count.");
  return count;
}

function scheduleDeletionResult(operation: Operation): ScheduleDeletionResultView {
  const payload = operation.result?.payload;
  if (payload?.case !== "scheduleDeletion") {
    throw new GatewayError("Orchestrator completed Schedule deletion without a cleanup result.");
  }
  const disposition = payload.value.generatedSessionDisposition === ScheduleGeneratedSessionDisposition.KEEP
    ? "keep"
    : payload.value.generatedSessionDisposition === ScheduleGeneratedSessionDisposition.ARCHIVE
      ? "archive"
      : payload.value.generatedSessionDisposition === ScheduleGeneratedSessionDisposition.DELETE
        ? "delete"
        : undefined;
  if (disposition === undefined) throw new GatewayError("Orchestrator returned an invalid generated task disposition.");
  return {
    scheduleId: payload.value.scheduleId,
    disposition,
    generatedSessionIds: [...payload.value.generatedSessionIds],
    completedSessionIds: [...payload.value.completedSessionIds],
    failures: payload.value.failures.map((failure) => ({
      sessionId: failure.sessionId,
      message: failure.message
    })),
    inflightCount: payload.value.inflightCount
  };
}

function buildTimeline(events: readonly Event[]): ReadonlyMap<string, readonly TimelineItemView[]> {
  let timeline: ReadonlyMap<string, readonly TimelineItemView[]> = new Map();
  for (const event of [...events].sort((left, right) => Number((left.cursor?.sequence ?? 0n) - (right.cursor?.sequence ?? 0n)))) {
    timeline = projectTimelineEvent(timeline, event);
  }
  return timeline;
}

/** Resurface an in-flight Review card even when its originating event
 * has fallen outside the bounded owner timeline window. Terminal cards remain
 * history-owned and are never manufactured from snapshot state alone. */
function withMissingRunningReviewCards(
  timeline: ReadonlyMap<string, readonly TimelineItemView[]>,
  reviewRuns: readonly ReviewRunView[],
  cursor: bigint
): ReadonlyMap<string, readonly TimelineItemView[]> {
  let result = timeline;
  let ordinal = 0n;
  for (const review of reviewRuns) {
    if (review.state !== "running") continue;
    const current = result.get(review.sourceSessionId) ?? [];
    if (current.some((item) => item.review?.id === review.id)) continue;
    ordinal += 1n;
    result = new Map(result).set(review.sourceSessionId, [...current, {
      id: `review:${review.id}`,
      sequence: cursor + ordinal,
      kind: "review",
      createdAt: review.createdAt,
      title: "Review",
      review
    }]);
  }
  return result;
}

function mapReviewRun(review: ProtoReviewRun): ReviewRunView {
  const failureCode = reviewFailureCode(review.failureCode);
  const result = review.resultMarkdown;
  if (review.freshness === undefined) {
    throw new GatewayError("Orchestrator returned a Review without freshness.");
  }
  const freshness = review.freshness.state === ReviewFreshnessState.CURRENT
    ? "current" as const
    : review.freshness.state === ReviewFreshnessState.STALE
      ? "stale" as const
      : review.freshness.state === ReviewFreshnessState.UNAVAILABLE
        ? "unavailable" as const
        : (() => { throw new GatewayError("Orchestrator returned an unspecified Review freshness state."); })();
  if (review.freshness.checkedAt === undefined) {
    throw new GatewayError("Orchestrator returned a Review without a freshness check time.");
  }
  if (review.evidence === undefined || review.evidence.capturedAt === undefined) {
    throw new GatewayError("Orchestrator returned a Review without evidence identity.");
  }
  const freshnessCheckedAt = timestampMs(review.freshness.checkedAt);
  const evidence = {
    sealSha256: review.evidence.sealSha256Hex,
    capturedAt: timestampMs(review.evidence.capturedAt)
  };
  return {
    id: review.reviewRunId,
    sourceSessionId: review.sourceSessionId,
    ...(review.reviewerSessionId === "" ? {} : { reviewerSessionId: review.reviewerSessionId }),
    state: review.state === ReviewRunState.RUNNING
      ? "running"
      : review.state === ReviewRunState.COMPLETED ? "completed" : "failed",
    freshness,
    freshnessCheckedAt,
    targetKind: review.targetKind === ReviewTargetKind.CHANGES
      ? "changes"
      : review.targetKind === ReviewTargetKind.ARTIFACTS
        ? "artifacts"
        : review.targetKind === ReviewTargetKind.MIXED ? "mixed" : "task",
    ...(failureCode === undefined ? {} : { failureCode }),
    evidence,
    ...(result === "" ? {} : { result }),
    createdAt: timestampMs(review.createdAt),
    updatedAt: timestampMs(review.updatedAt),
    ...(review.endedAt === undefined ? {} : { endedAt: timestampMs(review.endedAt) }),
    revision: review.revision?.value ?? 0n
  };
}

function reviewFailureCode(code: ReviewFailureCode): ReviewRunView["failureCode"] {
  if (code === ReviewFailureCode.NO_VISIBLE_RESULT) return "no-visible-result";
  if (code === ReviewFailureCode.REVIEWER_CLOSED) return "reviewer-closed";
  if (code === ReviewFailureCode.CANCELLED_BEFORE_START) return "cancelled-before-start";
  if (code === ReviewFailureCode.INTERRUPTED) return "interrupted";
  if (code === ReviewFailureCode.SOURCE_WORKSPACE_CHANGED) return "source-workspace-changed";
  if (code === ReviewFailureCode.SOURCE_CONVERSATION_CHANGED) return "source-conversation-changed";
  if (code === ReviewFailureCode.SOURCE_FILES_CHANGED) return "source-files-changed";
  if (code === ReviewFailureCode.ARTIFACT_CHANGED) return "artifact-changed";
  if (code === ReviewFailureCode.ARTIFACT_UNAVAILABLE) return "artifact-unavailable";
  if (code === ReviewFailureCode.PROVIDER_FAILED) return "provider-failed";
  return undefined;
}

function mapToolItem(
  call: ToolCall,
  sequence: bigint,
  createdAt: number,
  existing: TimelineItemView | undefined,
  result: ToolResult | undefined,
  outputMode: "preserve" | "append" | "replace"
): TimelineItemView {
  const attachments = toolResultAttachments(result);
  const name = call.toolId || existing?.tool?.name || "tool";
  const currentInput = displayArguments(call.arguments);
  const outputChunk = toolResultText(result);
  const output = outputMode === "append"
    ? existing?.tool?.output === undefined && outputChunk === undefined
      ? undefined
      : `${existing?.tool?.output ?? ""}${outputChunk ?? ""}`
    : outputMode === "replace"
      ? outputChunk
      : outputChunk ?? existing?.tool?.output;
  const projectedAttachments = outputMode === "append"
    ? attachments.reduce(
      (current, attachment) => upsertBy(current, attachment, (value) => value.blobId),
      [...(existing?.attachments ?? [])]
    )
    : outputMode === "preserve" && attachments.length === 0
      ? existing?.attachments ?? []
      : attachments;
  return {
    id: call.toolCallId,
    ...(call.runId || existing?.runId ? { runId: call.runId || existing?.runId } : {}),
    sequence,
    kind: call.state === ToolCallState.SUCCEEDED || call.state === ToolCallState.FAILED ? "toolResult" : "tool",
    createdAt,
    title: name,
    tool: {
      id: call.toolCallId,
      name,
      state: toolState(call.state),
      input: currentInput || existing?.tool?.input || "",
      ...(output === undefined ? {} : { output }),
      isError: call.state === ToolCallState.FAILED
    },
    ...(projectedAttachments.length === 0 ? {} : { attachments: projectedAttachments })
  };
}

function mapArtifact(artifact: Artifact): ArtifactView {
  return {
    id: artifact.artifactId,
    blobId: artifact.blob?.blobId ?? artifact.artifactId,
    title: artifact.title,
    kind: artifactKind(artifact.kind),
    fileName: artifact.blob?.fileName ?? "artifact",
    mediaType: artifact.blob?.mediaType ?? "application/octet-stream",
    byteSize: numberValue(artifact.blob?.byteSize)
  };
}

function collectDiagnostics(snapshot: Snapshot): readonly ErrorView[] {
  const errors: ErrorInfo[] = [];
  for (const entity of [...snapshot.backends, ...snapshot.targets, ...snapshot.sessions, ...snapshot.runs, ...snapshot.queueItems, ...snapshot.schedules, ...snapshot.resources, ...snapshot.browsers]) {
    if (entity.error !== undefined && entity.error.message.length > 0) errors.push(entity.error);
  }
  return errors.map((error) => mapError(error));
}

export function mapError(error: ErrorInfo, runId?: string): ErrorView {
  return {
    ...(runId === undefined || runId.length === 0 ? {} : { runId }),
    code: error.code,
    message: presentJokoServiceTerminology(error.message),
    phase: error.phase,
    severity: errorSeverity(error.severity),
    retryable: error.retryable,
    recovery: error.recoveryActions.map((action, index) => ({
      id: `${action.kind}:${index}`,
      kind: recoveryActionKind(action.kind),
      label: presentJokoServiceTerminology(action.label),
      ...(action.retryAfter === undefined ? {} : { retryAfterMs: durationSeconds(action.retryAfter) * 1_000 })
    }))
  };
}

function recoveryActionKind(kind: RecoveryActionKind): ErrorView["recovery"][number]["kind"] {
  if (kind === RecoveryActionKind.WAIT) return "wait";
  if (kind === RecoveryActionKind.RETRY) return "retry";
  if (kind === RecoveryActionKind.RECONNECT) return "resnapshot";
  if (kind === RecoveryActionKind.REAUTHENTICATE) return "reauthenticate";
  if (kind === RecoveryActionKind.RESOLVE_INTERACTION) return "resolveInteraction";
  if (kind === RecoveryActionKind.SELECT_NEW_SESSION) return "openSession";
  if (kind === RecoveryActionKind.OPEN_DIAGNOSTICS) return "openDiagnostics";
  if (kind === RecoveryActionKind.CONTACT_OWNER) return "contactOwner";
  if (kind === RecoveryActionKind.ABORT) return "abort";
  return "unknown";
}

async function interactionDecision(
  raw: Interaction,
  resolution: InteractionResolutionDraft,
  uploadSensitive: (secret: string) => Promise<string>
): Promise<NonNullable<MessageInitShape<typeof InteractionResolutionSchema>["decision"]>> {
  if (raw.request.case === "permission") {
    if (resolution.kind !== "permission") throw new GatewayError("This permission response is no longer valid.");
    const parsed = Number(resolution.decisionId);
    return { case: "permission", value: { decision: Number.isFinite(parsed) ? parsed : PermissionDecisionKind.DENY_ONCE } };
  }
  if (raw.request.case === "planReview") {
    if (resolution.kind !== "plan") throw new GatewayError("This plan response is no longer valid.");
    const parsed = Number(resolution.decisionId);
    return { case: "planReview", value: { decision: Number.isFinite(parsed) ? parsed : PlanReviewDecisionKind.STAY_IN_PLAN_MODE, feedback: resolution.feedback } };
  }
  if (raw.request.case === "extensionUi") {
    if (resolution.kind !== "extension") throw new GatewayError("This extension response is no longer valid.");
    return { case: "extensionUi", value: { result: typeof resolution.value === "boolean" ? { case: "confirmed", value: resolution.value } : { case: "value", value: resolution.value } } };
  }
  if (raw.request.case === "question") {
    if (resolution.kind !== "question") throw new GatewayError("These question answers are no longer valid.");
    const answers: Array<MessageInitShape<typeof QuestionAnswerSchema>> = [];
    for (const field of raw.request.value.fields) {
      const answer = resolution.answers[field.fieldId];
      if (answer === undefined) {
        if (field.required) throw new GatewayError(`${field.label || field.fieldId} is required.`);
        continue;
      }
      let value: NonNullable<MessageInitShape<typeof QuestionAnswerSchema>["value"]>;
      if (field.input.case === "boolean") {
        if (typeof answer !== "boolean") throw new GatewayError(`${field.label || field.fieldId} requires a yes or no answer.`);
        value = { case: "boolean", value: answer };
      } else if (field.input.case === "singleChoice") {
        if (typeof answer !== "string") throw new GatewayError(`${field.label || field.fieldId} requires one choice.`);
        value = { case: "choiceId", value: answer };
      } else if (field.input.case === "multipleChoice") {
        if (!Array.isArray(answer)) throw new GatewayError(`${field.label || field.fieldId} requires a list of choices.`);
        value = { case: "choiceIds", value: { values: [...answer] } };
      } else {
        if (typeof answer !== "string") throw new GatewayError(`${field.label || field.fieldId} requires text.`);
        if (field.input.case === "text" && field.input.value.answerHandling === QuestionAnswerHandling.CREDENTIAL_CHANNEL) {
          if (answer.length === 0 && !field.required) continue;
          value = { case: "sensitive", value: { credentialUploadTicketId: await uploadSensitive(answer) } };
        } else {
          value = { case: "text", value: answer };
        }
      }
      answers.push({ fieldId: field.fieldId, value });
    }
    return { case: "question", value: { answers } };
  }
  return { case: "dismissal", value: { reason: "Unsupported interaction" } };
}

function normalizeError(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error;
  if (error instanceof ConnectError) {
    const offline = [Code.Unavailable, Code.DeadlineExceeded, Code.Aborted].includes(error.code);
  if (error.code === Code.Unauthenticated) return new GatewayError("This Joko connection was revoked or logged out.", { cause: error });
    return new GatewayError(error.rawMessage || error.message, { offline, cause: error });
  }
  return new GatewayError(error instanceof Error ? error.message : "Unexpected connection error", { cause: error });
}

function isUncertainOperationSubmissionError(error: unknown): boolean {
  let candidate: unknown = error;
  const seen = new Set<unknown>();
  while (candidate instanceof Error && !seen.has(candidate)) {
    if (
      candidate instanceof ConnectError
      && [Code.Unavailable, Code.DeadlineExceeded, Code.Aborted].includes(candidate.code)
    ) return true;
    seen.add(candidate);
    candidate = candidate.cause;
  }
  return false;
}

function isPairingWindowClosedError(error: unknown): boolean {
  let candidate: unknown = error;
  const seen = new Set<unknown>();
  while (candidate instanceof Error && !seen.has(candidate)) {
    if (
      candidate instanceof ConnectError
      && candidate.code === Code.FailedPrecondition
      && candidate.rawMessage === PAIRING_WINDOW_CLOSED_MESSAGE
    ) return true;
    seen.add(candidate);
    candidate = candidate.cause;
  }
  return false;
}

export function isUnauthenticatedError(error: unknown): boolean {
  let candidate: unknown = error;
  const seen = new Set<unknown>();
  while (candidate instanceof Error && !seen.has(candidate)) {
    if (candidate instanceof ConnectError && candidate.code === Code.Unauthenticated) return true;
    seen.add(candidate);
    candidate = candidate.cause;
  }
  return false;
}

export function requiresEventSnapshotResync(error: unknown): boolean {
  let candidate: unknown = error;
  const seen = new Set<unknown>();
  while (candidate instanceof Error && !seen.has(candidate)) {
    if (candidate instanceof ConnectError && candidate.code === Code.FailedPrecondition) return true;
    seen.add(candidate);
    candidate = candidate.cause;
  }
  return false;
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolvePromise) => {
    if (signal.aborted) return resolvePromise();
    const timer = window.setTimeout(resolvePromise, milliseconds);
    signal.addEventListener("abort", () => {
      window.clearTimeout(timer);
      resolvePromise();
    }, { once: true });
  });
}

function desktopAvailable(): boolean {
  return "jokoDesktop" in window;
}

function payloadCase(event: Event): string | undefined {
  return event.payload?.kind.case;
}

function modelKey(model: ModelDescriptor): string {
  return modelProjectionKey(model.backendId, model.key?.providerId ?? "", model.key?.modelId ?? "");
}

function modelProjectionKey(backendId: string, providerId: string, modelId: string): string {
  return `${backendId}\u0000${providerId}\u0000${modelId}`;
}

function providerKey(backendId: string, providerId: string): string {
  return `${backendId}\u0000${providerId}`;
}

function inputText(input: any): string {
  return (input?.parts ?? []).map((part: any) => {
    const content = part.content;
    if (content?.case === "text") return String(content.value);
    if (content?.case === "file") return `@${content.value.fileName}`;
    if (content?.case === "image") return `![${content.value.altText || content.value.blob?.fileName || "image"}]`;
    if (content?.case === "workspaceMention") return `@${content.value.displayText || content.value.relativePath}`;
    if (content?.case === "resourceMention") return `/${content.value.displayText}`;
    return "";
  }).filter(Boolean).join("\n");
}

function messageInputText(input: any): string {
  return (input?.parts ?? []).map((part: any) => {
    const content = part.content;
    if (content?.case === "text") return String(content.value);
    if (content?.case === "workspaceMention") return `@${content.value.displayText || content.value.relativePath}`;
    if (content?.case === "resourceMention") return `/${content.value.displayText}`;
    return "";
  }).filter(Boolean).join("\n");
}

function messageInputPastedTextRanges(
  input: any,
  text: string
): NonNullable<TimelineItemView["pastedTextRanges"]> {
  const ranges = input?.pastedTextRanges ?? [];
  if (!Array.isArray(ranges)) throw new GatewayError("Orchestrator returned invalid pasted-text metadata.");
  const mapped: NonNullable<TimelineItemView["pastedTextRanges"]>[number][] = [];
  let previousEnd = 0;
  for (const range of ranges) {
    const start = range?.start;
    const end = range?.end;
    const display = range?.display;
    if (!Number.isSafeInteger(start)
      || !Number.isSafeInteger(end)
      || start < previousEnd
      || start < 0
      || end <= start
      || end > text.length
      || !utf16Boundary(text, start)
      || !utf16Boundary(text, end)
      || typeof display !== "string"
      || display.trim().length === 0
      || display.length > 500) {
      throw new GatewayError("Orchestrator returned invalid pasted-text metadata.");
    }
    mapped.push({ start, end, display });
    previousEnd = end;
  }
  return mapped;
}

function timelineMessageUsage(
  value: any,
  generationDurationMs: bigint | undefined,
  generationReliable: boolean | undefined
): NonNullable<TimelineItemView["usage"]> {
  const usage = mapUsageTokens(value);
  if (!/^[A-Z]{3}$/u.test(usage.currencyCode)) {
    throw new GatewayError("Orchestrator returned invalid message usage currency metadata.");
  }
  const generationTiming = timelineMessageGenerationTiming(generationDurationMs, generationReliable);
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    totalTokens: usage.totalTokens,
    cost: usage.costMicros / 1_000_000,
    currency: usage.currencyCode,
    ...generationTiming
  };
}

function timelineMessageGenerationTiming(
  duration: bigint | undefined,
  reliable: boolean | undefined
): Pick<TimelineMessageUsageView, "generationDurationMs" | "generationReliable"> {
  if (reliable === true) {
    if (duration === undefined) {
      throw new GatewayError("Orchestrator returned reliable generation timing without a duration.");
    }
    const mapped = exactSafeUnsignedNumber(duration);
    if (mapped === undefined || mapped <= 0) {
      throw new GatewayError("Orchestrator returned generation timing outside the safe display range.");
    }
    return { generationDurationMs: mapped, generationReliable: true };
  }
  if (duration !== undefined) {
    throw new GatewayError("Orchestrator returned generation duration without reliable timing metadata.");
  }
  return reliable === false ? { generationReliable: false } : {};
}

function utf16Boundary(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return true;
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff);
}

function inputAttachments(input: any): readonly ArtifactView[] {
  return (input?.parts ?? []).flatMap((part: any): ArtifactView[] => {
    const content = part.content;
    const image = content?.case === "image" ? content.value : undefined;
    const blob = content?.case === "file" ? content.value : image?.blob;
    if (blob?.blobId === undefined || String(blob.blobId).length === 0) return [];
    const kind = image === undefined ? "file" as const : "image" as const;
    const fileName = String(blob.fileName || (kind === "image" ? "image" : "file"));
    return [{
      id: String(blob.blobId),
      blobId: String(blob.blobId),
      title: kind === "image" ? String(image.altText || fileName) : fileName,
      kind,
      fileName,
      mediaType: String(blob.mediaType || "application/octet-stream"),
      byteSize: numberValue(blob.byteSize)
    }];
  });
}

function capabilityOptions(options: any): readonly string[] {
  if (options?.kind?.case === "model") return [...(options.kind.value.effortIds ?? [])];
  if (options?.kind?.case === "input") return [...(options.kind.value.mediaTypes ?? [])];
  if (options?.kind?.case === "permission") {
    const modes = (options.kind.value.modes ?? []).map((mode: ProtoPermissionMode) => uiPermission(mode));
    if (options.kind.value.supportsPlanMode === true) modes.push("planMode");
    return modes;
  }
  return [];
}

function displayArguments(argumentsValue: readonly any[] | undefined): string {
  return (argumentsValue ?? []).map((argument) => {
    const value = argument.redacted ? argument.redactedPlaceholder || "••••" : argument.value?.value;
    return `${argument.fieldPath}: ${String(value ?? "")}`;
  }).join("\n");
}

function toolResultText(result: any): string | undefined {
  if (result === undefined) return undefined;
  const text = (result.parts ?? []).map((part: any) => {
    if (part.content?.case === "text") return part.content.value;
    if (part.content?.case === "command") return `${part.content.value.stdout ?? ""}${part.content.value.stderr ?? ""}`;
    return "";
  }).filter(Boolean).join("\n");
  return text === "" ? undefined : text;
}

function toolResultAttachments(result: any): readonly ArtifactView[] {
  if (result === undefined) return [];
  const attachments: ArtifactView[] = [];
  for (const part of result.parts ?? []) {
    if (part.content?.case === "image") {
      const image = part.content.value;
      const blob = image?.blob;
      if (blob?.blobId === undefined || blob.blobId === "") continue;
      attachments.push({
        id: blob.blobId,
        blobId: blob.blobId,
        title: image.altText || blob.fileName || "Image",
        kind: "image",
        fileName: blob.fileName || "image",
        mediaType: blob.mediaType || "application/octet-stream",
        byteSize: numberValue(blob.byteSize)
      });
    } else if (part.content?.case === "artifact") {
      const artifact = part.content.value;
      const blob = artifact?.blob;
      if (blob?.blobId === undefined || blob.blobId === "") continue;
      attachments.push({
        id: artifact.artifactId || blob.blobId,
        blobId: blob.blobId,
        title: artifact.title || blob.fileName || "Artifact",
        kind: artifactKind(artifact.kind),
        fileName: blob.fileName || "artifact",
        mediaType: blob.mediaType || "application/octet-stream",
        byteSize: numberValue(blob.byteSize)
      });
    }
  }
  return attachments;
}

function asRecord(value: unknown): Record<string, any> {
  return value !== null && typeof value === "object" ? value as Record<string, any> : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function timestampMs(value: { readonly seconds: bigint; readonly nanos: number } | undefined): number {
  return value === undefined ? 0 : Number(value.seconds) * 1_000 + Math.floor(value.nanos / 1_000_000);
}

function compareProtoTimestamps(
  left: { readonly seconds: bigint; readonly nanos: number } | undefined,
  right: { readonly seconds: bigint; readonly nanos: number } | undefined
): number {
  const leftSeconds = left?.seconds ?? 0n;
  const rightSeconds = right?.seconds ?? 0n;
  if (leftSeconds !== rightSeconds) return leftSeconds < rightSeconds ? -1 : 1;
  return (left?.nanos ?? 0) - (right?.nanos ?? 0);
}

function mapPortableSessionFidelity(value: PortableSessionFidelity): PortableSessionFidelityView {
  if (value === PortableSessionFidelity.FULL) return "full";
  if (value === PortableSessionFidelity.PARTIAL) return "partial";
  if (value === PortableSessionFidelity.PRODUCT_ONLY) return "product_only";
  throw new GatewayError("Orchestrator returned an unknown portable task fidelity.");
}

function mapPortableSessionImportStatus(
  value: PortableSessionImportStatus
): "ready" | "imported_activation_failed" {
  if (value === PortableSessionImportStatus.READY) return "ready";
  if (value === PortableSessionImportStatus.IMPORTED_ACTIVATION_FAILED) return "imported_activation_failed";
  throw new GatewayError("Orchestrator returned an unknown portable task activation status.");
}

function mapPortableSessionImportDraft(
  draft: import("@joko/contracts").PortableSessionImportDraft | undefined
): PortableSessionImportDraftView {
  if (draft === undefined || draft.draftId.trim() === "") {
    throw new GatewayError("Orchestrator returned no portable task import draft.");
  }
  const expiresAt = timestampMs(draft.expiresAt);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) {
    throw new GatewayError("Orchestrator returned an invalid portable task import expiry.");
  }
  const preview = draft.preview;
  return {
    draftId: draft.draftId,
    expiresAt,
    encrypted: draft.encrypted,
    passwordRequired: draft.passwordRequired,
    ...(preview === undefined ? {} : {
      preview: {
        title: preview.title,
        workspaceKind: preview.workspaceKind === WorkspaceKind.MANAGED_DIALOGUE
          ? "dialogue" as const
          : preview.workspaceKind === WorkspaceKind.USER_PROJECT
            ? "project" as const
            : portableWorkspaceKindError(),
        exportedAt: timestampMs(preview.exportedAt),
        applicationVersion: preview.applicationVersion,
        backendCapability: preview.backendCapability,
        fidelity: mapPortableSessionFidelity(preview.fidelity),
        messageCount: portableCount(preview.messageCount, "message"),
        mediaCount: portableCount(preview.mediaCount, "media"),
        workerCount: portableCount(preview.workerCount, "worker"),
        nativeHistory: preview.nativeHistory
      }
    })
  };
}

function portableWorkspaceKindError(): never {
  throw new GatewayError("Orchestrator returned an unknown portable task workspace kind.");
}

function portableCount(value: bigint, label: string): number {
  const mapped = exactSafeUnsignedNumber(value);
  if (mapped === undefined) throw new GatewayError(`Orchestrator returned an invalid portable task ${label} count.`);
  return mapped;
}

function portableErrorByteCount(value: string | null): number {
  if (value === null || !/^(?:0|[1-9][0-9]{0,15})$/.test(value)) return 0;
  const mapped = Number(value);
  return Number.isSafeInteger(mapped) && mapped >= 0 ? mapped : 0;
}

function durationSeconds(value: { readonly seconds: bigint; readonly nanos: number } | undefined): number {
  return value === undefined ? 0 : Number(value.seconds) + value.nanos / 1_000_000_000;
}

function numberValue(value: bigint | undefined): number {
  const number = Number(value ?? 0n);
  return Number.isSafeInteger(number) ? number : Number.MAX_SAFE_INTEGER;
}

function validCatalogSnapshotToken(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !/[\p{Cc}\u2028\u2029]/u.test(value);
}

function numberValueSigned(value: bigint | undefined): number {
  const number = Number(value ?? 0n);
  return Number.isSafeInteger(number) ? number : number < 0 ? Number.MIN_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
}

function safeUnsignedBigInt(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) throw new GatewayError("Model token and cost fields must be safe non-negative whole numbers.");
  return BigInt(value);
}

function safeSignedBigInt(value: number): bigint {
  if (!Number.isSafeInteger(value)) throw new GatewayError("Model cost fields must be safe whole numbers.");
  return BigInt(value);
}

function serverHealth(value: ServerHealth | undefined): "healthy" | "degraded" | "unavailable" {
  return value === ServerHealth.HEALTHY ? "healthy" : value === ServerHealth.DEGRADED || value === ServerHealth.STARTING ? "degraded" : "unavailable";
}

function managedModelRuntimeState(value: ManagedModelRuntimeState): ManagedModelRuntimeView["state"] {
  switch (value) {
    case ManagedModelRuntimeState.ABSENT: return "absent";
    case ManagedModelRuntimeState.STOPPED: return "stopped";
    case ManagedModelRuntimeState.STARTING: return "starting";
    case ManagedModelRuntimeState.READY: return "ready";
    case ManagedModelRuntimeState.PORT_CONFLICT: return "portConflict";
    case ManagedModelRuntimeState.INSTALLING: return "installing";
    case ManagedModelRuntimeState.ERROR: return "error";
    default: return "unknown";
  }
}

function managedModelRuntimeSource(value: ManagedModelRuntimeSource): ManagedModelRuntimeView["source"] {
  switch (value) {
    case ManagedModelRuntimeSource.RUNNING: return "running";
    case ManagedModelRuntimeSource.APPLICATION: return "application";
    case ManagedModelRuntimeSource.CLI: return "cli";
    case ManagedModelRuntimeSource.MANAGED_SIDECAR: return "managedSidecar";
    case ManagedModelRuntimeSource.NONE: return "none";
    default: return "unknown";
  }
}

function managedModelRuntimeTransferPhase(
  value: ManagedModelRuntimeTransferPhase
): ManagedModelRuntimeView["transfers"][number]["phase"] {
  switch (value) {
    case ManagedModelRuntimeTransferPhase.STARTING: return "starting";
    case ManagedModelRuntimeTransferPhase.RESOLVING: return "resolving";
    case ManagedModelRuntimeTransferPhase.MANIFEST: return "manifest";
    case ManagedModelRuntimeTransferPhase.DOWNLOADING: return "downloading";
    case ManagedModelRuntimeTransferPhase.VERIFYING: return "verifying";
    case ManagedModelRuntimeTransferPhase.EXTRACTING: return "extracting";
    case ManagedModelRuntimeTransferPhase.WRITING: return "writing";
    case ManagedModelRuntimeTransferPhase.PROMOTING: return "promoting";
    case ManagedModelRuntimeTransferPhase.SUCCESS: return "success";
    case ManagedModelRuntimeTransferPhase.PAUSED: return "paused";
    case ManagedModelRuntimeTransferPhase.CANCELLED: return "cancelled";
    case ManagedModelRuntimeTransferPhase.ERROR: return "error";
    default: return "unknown";
  }
}

function managedModelRuntimeError(
  value: ManagedModelRuntimeErrorCode | undefined
): { readonly errorCode?: NonNullable<ManagedModelRuntimeView["errorCode"]> } {
  switch (value) {
    case ManagedModelRuntimeErrorCode.OWNER_CHANGED: return { errorCode: "ownerChanged" };
    case ManagedModelRuntimeErrorCode.RUNTIME_UNREACHABLE: return { errorCode: "runtimeUnreachable" };
    case ManagedModelRuntimeErrorCode.PORT_CONFLICT: return { errorCode: "portConflict" };
    case ManagedModelRuntimeErrorCode.UNSUPPORTED_PLATFORM: return { errorCode: "unsupportedPlatform" };
    case ManagedModelRuntimeErrorCode.INSTALL_BUSY: return { errorCode: "installBusy" };
    case ManagedModelRuntimeErrorCode.PULL_BUSY: return { errorCode: "pullBusy" };
    case ManagedModelRuntimeErrorCode.MODEL_INVALID: return { errorCode: "modelInvalid" };
    case ManagedModelRuntimeErrorCode.MODEL_NOT_FOUND: return { errorCode: "modelNotFound" };
    case ManagedModelRuntimeErrorCode.MODEL_UNAUTHORIZED: return { errorCode: "modelUnauthorized" };
    case ManagedModelRuntimeErrorCode.MODEL_INCOMPATIBLE: return { errorCode: "modelIncompatible" };
    case ManagedModelRuntimeErrorCode.DISK_SPACE_LOW: return { errorCode: "diskSpaceLow" };
    case ManagedModelRuntimeErrorCode.DOWNLOAD_REJECTED: return { errorCode: "downloadRejected" };
    case ManagedModelRuntimeErrorCode.DOWNLOAD_TOO_LARGE: return { errorCode: "downloadTooLarge" };
    case ManagedModelRuntimeErrorCode.DOWNLOAD_TIMEOUT: return { errorCode: "downloadTimeout" };
    case ManagedModelRuntimeErrorCode.CHECKSUM_MISMATCH: return { errorCode: "checksumMismatch" };
    case ManagedModelRuntimeErrorCode.ARCHIVE_REJECTED: return { errorCode: "archiveRejected" };
    case ManagedModelRuntimeErrorCode.START_FAILED: return { errorCode: "startFailed" };
    case ManagedModelRuntimeErrorCode.OPERATION_CANCELLED: return { errorCode: "operationCancelled" };
    case ManagedModelRuntimeErrorCode.RUNTIME_ERROR: return { errorCode: "runtimeError" };
    default: return {};
  }
}

function isActiveRun(value: RunState): boolean {
  return [RunState.ACCEPTED, RunState.QUEUED, RunState.DISPATCHING, RunState.DISPATCH_UNKNOWN, RunState.RUNNING, RunState.WAITING, RunState.RETRYING].includes(value);
}

function sessionViewState(value: SessionState, run: RunState | undefined): SessionView["state"] {
  if (run === RunState.RETRYING) return "retrying";
  if (run === RunState.WAITING || value === SessionState.WAITING) return "waiting";
  if (run !== undefined && isActiveRun(run)) return "running";
  if (value === SessionState.ERROR) return "error";
  if ([SessionState.CLOSED, SessionState.CLOSING, SessionState.DETACHED].includes(value)) return "closed";
  return "idle";
}

function protoPermission(value: PermissionMode): ProtoPermissionMode {
  return value === "auto" ? ProtoPermissionMode.AUTO : value === "bypassPermissions" ? ProtoPermissionMode.BYPASS_PERMISSIONS : ProtoPermissionMode.ASK;
}

function providerKind(value: ProviderKind): SettingsView["providers"][number]["kind"] {
  if (value === ProviderKind.MANAGED) return "managed";
  if (value === ProviderKind.API_KEY) return "apiKey";
  if (value === ProviderKind.OAUTH) return "oauth";
  if (value === ProviderKind.SUBSCRIPTION) return "subscription";
  if (value === ProviderKind.LOCAL_KEYLESS) return "localKeyless";
  return "customEndpoint";
}

function providerCredentialSurfaceCapability(
  value: ProviderCredentialSurfaceCapability
): ProviderRuntimeView["credentialSurfaces"][number]["capability"] {
  if (value === ProviderCredentialSurfaceCapability.IMAGE_GENERATION) return "imageGeneration";
  throw new GatewayError("Orchestrator returned an unsupported Provider credential capability.");
}

function providerCredentialSurfaceKind(
  value: ProviderCredentialSurfaceKind
): ProviderRuntimeView["credentialSurfaces"][number]["kind"] {
  if (value === ProviderCredentialSurfaceKind.API_KEY) return "apiKey";
  throw new GatewayError("Orchestrator returned an unsupported Provider credential kind.");
}

function providerAuthenticationState(value: AuthenticationState): ProviderRuntimeView["authenticationState"] {
  if (value === AuthenticationState.NOT_REQUIRED) return "notRequired";
  if (value === AuthenticationState.SIGNED_OUT) return "signedOut";
  if (value === AuthenticationState.PENDING) return "pending";
  if (value === AuthenticationState.AUTHENTICATED) return "authenticated";
  if (value === AuthenticationState.EXPIRED) return "expired";
  if (value === AuthenticationState.REFRESHING) return "refreshing";
  if (value === AuthenticationState.ERROR) return "error";
  return "unknown";
}

function inputModality(value: ModelInputModality): ModelView["inputModalities"][number] {
  if (value === ModelInputModality.IMAGE) return "image";
  if (value === ModelInputModality.FILE) return "file";
  if (value === ModelInputModality.AUDIO) return "audio";
  return "text";
}

function protoInputModality(value: ModelView["inputModalities"][number]): ModelInputModality {
  if (value === "image") return ModelInputModality.IMAGE;
  if (value === "file") return ModelInputModality.FILE;
  if (value === "audio") return ModelInputModality.AUDIO;
  return ModelInputModality.TEXT;
}

function outputModality(value: ModelOutputModality): ModelView["outputModalities"][number] {
  if (value === ModelOutputModality.IMAGE) return "image";
  if (value === ModelOutputModality.AUDIO) return "audio";
  return "text";
}

function protoProviderKind(value: ProviderDraft["kind"]): ProviderKind {
  if (value === "managed") return ProviderKind.MANAGED;
  if (value === "apiKey") return ProviderKind.API_KEY;
  if (value === "oauth") return ProviderKind.OAUTH;
  if (value === "subscription") return ProviderKind.SUBSCRIPTION;
  if (value === "localKeyless") return ProviderKind.LOCAL_KEYLESS;
  return ProviderKind.CUSTOM_ENDPOINT;
}

export function protoProviderLoginMethod(value: ProviderLoginMethodView): ProviderLoginMethod {
  if (value === "apiKey") return ProviderLoginMethod.API_KEY;
  if (value === "deviceCode") return ProviderLoginMethod.DEVICE_CODE;
  if (value === "subscription") return ProviderLoginMethod.SUBSCRIPTION;
  return ProviderLoginMethod.OAUTH_BROWSER;
}

export function providerLoginMethod(value: ProviderLoginMethod): ProviderLoginMethodView {
  if (value === ProviderLoginMethod.API_KEY) return "apiKey";
  if (value === ProviderLoginMethod.DEVICE_CODE) return "deviceCode";
  if (value === ProviderLoginMethod.SUBSCRIPTION) return "subscription";
  return "oauthBrowser";
}

function mapProviderLoginFlow(flow: ProviderLoginFlow): ProviderLoginFlowView {
  const prompt = flow.pendingPrompt;
  return {
    id: flow.loginFlowId,
    providerId: flow.providerId,
    method: providerLoginMethod(flow.method),
    ...(flow.verificationUri.length === 0 ? {} : { verificationUri: flow.verificationUri }),
    ...(flow.userCode.length === 0 ? {} : { userCode: flow.userCode }),
    ...(flow.expiresAt === undefined ? {} : { expiresAt: timestampMs(flow.expiresAt) }),
    state: providerLoginState(flow.state),
    ...(prompt === undefined ? {} : {
      pendingPrompt: {
        id: prompt.promptId,
        kind: prompt.kind === ProviderLoginPromptKind.SECRET ? "secret" : prompt.kind === ProviderLoginPromptKind.MANUAL_CODE ? "manualCode" : prompt.kind === ProviderLoginPromptKind.SELECT ? "select" : "text",
        message: prompt.message,
        placeholder: prompt.placeholder,
        options: prompt.options.map((option) => ({ id: option.optionId, label: option.label, description: option.description }))
      }
    }),
    updatedAt: timestampMs(flow.updatedAt),
    ...(flow.error?.message ? { error: presentJokoServiceTerminology(flow.error.message) } : {})
  };
}

function providerLoginState(value: ProviderLoginFlowState): ProviderLoginFlowView["state"] {
  if (value === ProviderLoginFlowState.COMPLETED) return "completed";
  if (value === ProviderLoginFlowState.CANCELLED) return "cancelled";
  if (value === ProviderLoginFlowState.TIMED_OUT) return "timedOut";
  if (value === ProviderLoginFlowState.OUTCOME_UNKNOWN) return "outcomeUnknown";
  if (value === ProviderLoginFlowState.FAILED) return "failed";
  if (value === ProviderLoginFlowState.PENDING) return "pending";
  return "starting";
}

function providerCompatibility(value: ProviderApiCompatibility): SettingsView["providers"][number]["compatibility"] {
  if (value === ProviderApiCompatibility.ANTHROPIC_MESSAGES) return "anthropic";
  if (value === ProviderApiCompatibility.OPENAI_RESPONSES) return "openaiResponses";
  if (value === ProviderApiCompatibility.OPENAI_CHAT_COMPLETIONS) return "openaiChat";
  if (value === ProviderApiCompatibility.OPENAI_COMPLETIONS) return "openaiCompletions";
  if (value === ProviderApiCompatibility.GOOGLE_GENERATIVE_AI) return "google";
  return "native";
}

function protoProviderCompatibility(value: ProviderDraft["compatibility"]): ProviderApiCompatibility {
  if (value === "anthropic") return ProviderApiCompatibility.ANTHROPIC_MESSAGES;
  if (value === "openaiResponses") return ProviderApiCompatibility.OPENAI_RESPONSES;
  if (value === "openaiChat") return ProviderApiCompatibility.OPENAI_CHAT_COMPLETIONS;
  if (value === "openaiCompletions") return ProviderApiCompatibility.OPENAI_COMPLETIONS;
  if (value === "google") return ProviderApiCompatibility.GOOGLE_GENERATIVE_AI;
  return ProviderApiCompatibility.NATIVE;
}

function credentialKind(value: CredentialKind): SettingsView["credentials"][number]["kind"] {
  if (value === CredentialKind.OAUTH) return "oauth";
  if (value === CredentialKind.SUBSCRIPTION) return "subscription";
  if (value === CredentialKind.LOCAL_KEYLESS) return "localKeyless";
  if (value === CredentialKind.HEADER_SECRET) return "headerSecret";
  if (value === CredentialKind.SSH_PRIVATE_KEY) return "sshPrivateKey";
  return "apiKey";
}

function protoCredentialKind(value: CredentialDraft["kind"]): CredentialKind {
  if (value === "oauth") return CredentialKind.OAUTH;
  if (value === "subscription") return CredentialKind.SUBSCRIPTION;
  if (value === "localKeyless") return CredentialKind.LOCAL_KEYLESS;
  if (value === "headerSecret") return CredentialKind.HEADER_SECRET;
  if (value === "sshPrivateKey") return CredentialKind.SSH_PRIVATE_KEY;
  return CredentialKind.API_KEY;
}

function diagnosticLevel(value: DiagnosticLevel | undefined): SettingsView["diagnostics"]["level"] {
  if (value === DiagnosticLevel.ERRORS) return "errors";
  if (value === DiagnosticLevel.VERBOSE) return "verbose";
  return "standard";
}

function protoDiagnosticLevel(value: SettingsView["diagnostics"]["level"]): DiagnosticLevel {
  return value === "errors" ? DiagnosticLevel.ERRORS : value === "verbose" ? DiagnosticLevel.VERBOSE : DiagnosticLevel.STANDARD;
}

function canonicalProviderEndpoint(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  let endpoint: URL;
  try {
    endpoint = new URL(trimmed);
  } catch {
    throw new GatewayError("Enter a valid provider endpoint URL.");
  }
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(endpoint.hostname);
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) throw new GatewayError("Remote provider endpoints require HTTPS.");
  if (endpoint.username.length > 0 || endpoint.password.length > 0) throw new GatewayError("Provider endpoints cannot contain credentials.");
  for (const key of endpoint.searchParams.keys()) if (/(?:key|token|secret|auth|password)/iu.test(key)) throw new GatewayError("Provider endpoints cannot contain secret query parameters.");
  endpoint.hash = "";
  return endpoint.href.replace(/\/$/u, "");
}

function uiPermission(value: ProtoPermissionMode): PermissionMode {
  return value === ProtoPermissionMode.AUTO ? "auto" : value === ProtoPermissionMode.BYPASS_PERMISSIONS ? "bypassPermissions" : "ask";
}

function deliveryMode(value: ComposerDraft["deliveryMode"]): QueueDeliveryMode {
  return value === "steer" ? QueueDeliveryMode.STEER : value === "followUp" ? QueueDeliveryMode.FOLLOW_UP : QueueDeliveryMode.PROMPT;
}

function scheduleRecurrence(draft: ScheduleDraft): MessageInitShape<typeof ScheduleRecurrenceSchema> {
  if (draft.kind === "once") {
    const triggerAt = scheduleEpochFromLocalDateTime(draft.expression, draft.timezone);
    if (triggerAt === undefined) throw new GatewayError("Enter a valid one-time trigger date in the selected IANA timezone.");
    return { kind: { case: "oneShot", value: { triggerAt: timestampFromMs(triggerAt) } } };
  }
  if (draft.kind === "cron") {
    if (draft.expression.trim().length === 0) throw new GatewayError("Enter a cron expression.");
    return { kind: { case: "cron", value: { expression: draft.expression.trim() } } };
  }
  if (draft.kind === "interval") {
    const seconds = Number(draft.expression);
    if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isInteger(seconds)) throw new GatewayError("Enter a positive whole interval in seconds.");
    return { kind: { case: "interval", value: { interval: { seconds: BigInt(seconds), nanos: 0 }, anchorAt: timestampFromMs(Date.now()) } } };
  }
  return { kind: { case: "manual", value: {} } };
}

function timestampFromMs(value: number): { readonly seconds: bigint; readonly nanos: number } {
  const seconds = Math.floor(value / 1_000);
  return { seconds: BigInt(seconds), nanos: Math.floor((value - seconds * 1_000) * 1_000_000) };
}

function toolPolicyEffectiveSource(value: ToolPolicyEffectiveSource | undefined): import("./model.js").ToolPolicyEffectiveSourceView {
  if (value === ToolPolicyEffectiveSource.USER_DEFAULT) return "userDefault";
  if (value === ToolPolicyEffectiveSource.PROJECT_OVERRIDE) return "projectOverride";
  return "productDefault";
}

function protoManagedProcessPriority(
  value: NonNullable<SettingsView["agentResource"]>["processPriority"]
): ManagedProcessPriority {
  switch (value) {
    case "low":
      return ManagedProcessPriority.LOW;
    case "lowest":
      return ManagedProcessPriority.LOWEST;
    case "normal":
      return ManagedProcessPriority.NORMAL;
  }
}

function managedProcessPriorityView(
  value: ManagedProcessPriority
): NonNullable<SettingsView["agentResource"]>["processPriority"] {
  switch (value) {
    case ManagedProcessPriority.LOW:
      return "low";
    case ManagedProcessPriority.LOWEST:
      return "lowest";
    case ManagedProcessPriority.NORMAL:
    case ManagedProcessPriority.UNSPECIFIED:
      return "normal";
  }
}

function durationFromMs(value: number): { readonly seconds: bigint; readonly nanos: number } {
  const seconds = Math.floor(value / 1_000);
  return { seconds: BigInt(seconds), nanos: Math.floor((value - seconds * 1_000) * 1_000_000) };
}

function uiDeliveryMode(value: QueueDeliveryMode): QueueItemView["mode"] {
  return value === QueueDeliveryMode.STEER ? "steer" : value === QueueDeliveryMode.FOLLOW_UP ? "followUp" : "prompt";
}

function queueState(value: QueueItemState): QueueItemView["state"] {
  if (value === QueueItemState.QUEUED) return "queued";
  if (value === QueueItemState.DISPATCHING) return "dispatching";
  if (value === QueueItemState.BACKEND_ACCEPTED || value === QueueItemState.RUNNING) return "acceptedByBackend";
  if (value === QueueItemState.DISPATCH_UNKNOWN) return "dispatchUnknown";
  if (value === QueueItemState.COMPLETED) return "completed";
  if (value === QueueItemState.CANCELLED || value === QueueItemState.ABORTED) return "cancelled";
  if (value === QueueItemState.FAILED) return "failed";
  return "accepted";
}

function permissionRisk(value: PermissionRisk): NonNullable<InteractionView["risk"]> {
  if (value === PermissionRisk.READ_ONLY) return "read";
  if (value === PermissionRisk.LOW) return "low";
  if (value === PermissionRisk.MEDIUM) return "medium";
  if (value === PermissionRisk.HIGH) return "high";
  return "critical";
}

function permissionDecisionLabel(value: PermissionDecisionKind): string {
  return ({
    [PermissionDecisionKind.ALLOW_ONCE]: "Allow once",
    [PermissionDecisionKind.ALLOW_FOR_TURN]: "Allow for turn",
    [PermissionDecisionKind.ALLOW_FOR_SESSION]: "Allow for task",
    [PermissionDecisionKind.DENY_ONCE]: "Deny",
    [PermissionDecisionKind.DENY_FOR_SESSION]: "Deny for task",
    [PermissionDecisionKind.ABORT_RUN]: "Stop task"
  } as Partial<Record<number, string>>)[value] ?? "Choose";
}

function planDecisionLabel(value: PlanReviewDecisionKind): string {
  return ({
    [PlanReviewDecisionKind.EXECUTE]: "Execute plan",
    [PlanReviewDecisionKind.STAY_IN_PLAN_MODE]: "Stay in plan mode",
    [PlanReviewDecisionKind.REFINE]: "Refine plan"
  } as Partial<Record<number, string>>)[value] ?? "Choose";
}

function planStepState(value: PlanStepState): InteractionView["planSteps"][number]["state"] {
  if (value === PlanStepState.IN_PROGRESS) return "inProgress";
  if (value === PlanStepState.COMPLETED) return "completed";
  if (value === PlanStepState.SKIPPED) return "skipped";
  return "pending";
}

function scheduleRunState(value: RunState): NonNullable<ScheduleView["lastRun"]>["state"] {
  if (value === RunState.SUCCEEDED) return "completed";
  if (value === RunState.RUNNING || value === RunState.DISPATCHING) return "running";
  if (value === RunState.CANCELLED) return "skipped";
  if (value === RunState.ABORTED) return "aborted";
  return "failed";
}

function browserState(value: BrowserProviderState): BrowserView["state"] {
  return ({
    [BrowserProviderState.STOPPED]: "stopped",
    [BrowserProviderState.STARTING]: "starting",
    [BrowserProviderState.READY]: "ready",
    [BrowserProviderState.DEGRADED]: "degraded",
    [BrowserProviderState.DISCONNECTED]: "disconnected",
    [BrowserProviderState.RECOVERING]: "recovering",
    [BrowserProviderState.ERROR]: "error"
  } as Partial<Record<number, BrowserView["state"]>>)[value] ?? "stopped";
}

function browserTakeoverState(value: BrowserTakeoverState): NonNullable<BrowserView["takeover"]>["state"] {
  return ({
    [BrowserTakeoverState.INACTIVE]: "inactive",
    [BrowserTakeoverState.REQUESTED]: "requested",
    [BrowserTakeoverState.ACTIVE]: "active",
    [BrowserTakeoverState.RELEASING]: "releasing",
    [BrowserTakeoverState.FENCED]: "fenced"
  } as Partial<Record<number, NonNullable<BrowserView["takeover"]>["state"]>>)[value] ?? "unknown";
}

function validNormalizedBrowserPoint(x: number, y: number): boolean {
  return Number.isFinite(x) && x >= 0 && x <= 1 && Number.isFinite(y) && y >= 0 && y <= 1;
}

function browserTakeoverActionPayload(action: BrowserTakeoverActionView): BrowserTakeoverActionMutation["action"] {
  switch (action.kind) {
    case "mouseClick": {
      if (!Number.isFinite(action.normalizedX) || action.normalizedX < 0 || action.normalizedX > 1 || !Number.isFinite(action.normalizedY) || action.normalizedY < 0 || action.normalizedY > 1) {
        throw new GatewayError("Browser click coordinates must be normalized between zero and one.");
      }
      const button = action.button === "middle"
        ? BrowserTakeoverMouseButton.MIDDLE
        : action.button === "secondary"
          ? BrowserTakeoverMouseButton.SECONDARY
          : BrowserTakeoverMouseButton.PRIMARY;
      return { case: "mouseClick", value: create(BrowserTakeoverMouseClickSchema, { normalizedX: action.normalizedX, normalizedY: action.normalizedY, button, clickCount: action.clickCount ?? 1 }) };
    }
    case "mouseMove": {
      if (!validNormalizedBrowserPoint(action.normalizedX, action.normalizedY)) throw new GatewayError("Browser pointer coordinates must be normalized between zero and one.");
      return { case: "mouseMove", value: create(BrowserTakeoverMouseMoveSchema, { normalizedX: action.normalizedX, normalizedY: action.normalizedY }) };
    }
    case "mouseDrag": {
      if (!validNormalizedBrowserPoint(action.startNormalizedX, action.startNormalizedY) || !validNormalizedBrowserPoint(action.endNormalizedX, action.endNormalizedY)) {
        throw new GatewayError("Browser drag coordinates must be normalized between zero and one.");
      }
      if (action.startNormalizedX === action.endNormalizedX && action.startNormalizedY === action.endNormalizedY) throw new GatewayError("Browser drag must move the pointer.");
      const button = action.button === "middle"
        ? BrowserTakeoverMouseButton.MIDDLE
        : action.button === "secondary"
          ? BrowserTakeoverMouseButton.SECONDARY
          : BrowserTakeoverMouseButton.PRIMARY;
      return { case: "mouseDrag", value: create(BrowserTakeoverMouseDragSchema, {
        startNormalizedX: action.startNormalizedX,
        startNormalizedY: action.startNormalizedY,
        endNormalizedX: action.endNormalizedX,
        endNormalizedY: action.endNormalizedY,
        button
      }) };
    }
    case "scroll": {
      if (!Number.isFinite(action.deltaXCssPixels) || !Number.isFinite(action.deltaYCssPixels)) throw new GatewayError("Browser scroll deltas must be finite.");
      const deltaXCssPixels = Math.max(-10_000, Math.min(10_000, Math.trunc(action.deltaXCssPixels)));
      const deltaYCssPixels = Math.max(-10_000, Math.min(10_000, Math.trunc(action.deltaYCssPixels)));
      if (deltaXCssPixels === 0 && deltaYCssPixels === 0) throw new GatewayError("Browser scroll must have a non-zero delta.");
      return { case: "scroll", value: create(BrowserTakeoverScrollSchema, { deltaXCssPixels, deltaYCssPixels }) };
    }
    case "keyPress": {
      const namedKeys = {
        enter: BrowserTakeoverKey.ENTER,
        tab: BrowserTakeoverKey.TAB,
        escape: BrowserTakeoverKey.ESCAPE,
        backspace: BrowserTakeoverKey.BACKSPACE,
        delete: BrowserTakeoverKey.DELETE,
        arrowUp: BrowserTakeoverKey.ARROW_UP,
        arrowDown: BrowserTakeoverKey.ARROW_DOWN,
        arrowLeft: BrowserTakeoverKey.ARROW_LEFT,
        arrowRight: BrowserTakeoverKey.ARROW_RIGHT,
        home: BrowserTakeoverKey.HOME,
        end: BrowserTakeoverKey.END,
        pageUp: BrowserTakeoverKey.PAGE_UP,
        pageDown: BrowserTakeoverKey.PAGE_DOWN,
        space: BrowserTakeoverKey.SPACE
      } as const;
      const key = namedKeys[action.key as keyof typeof namedKeys];
      const character = key === undefined ? action.key : "";
      if (key === undefined && !/^[a-z0-9]$/u.test(character)) {
        throw new GatewayError("Browser character key must be one ASCII letter or digit.");
      }
      const modifierMap = {
        alt: BrowserTakeoverKeyModifier.ALT,
        control: BrowserTakeoverKeyModifier.CONTROL,
        meta: BrowserTakeoverKeyModifier.META,
        shift: BrowserTakeoverKeyModifier.SHIFT
      } as const;
      const modifierViews = action.modifiers ?? [];
      if (new Set(modifierViews).size !== modifierViews.length || modifierViews.length > 4) {
        throw new GatewayError("Browser key modifiers must be unique and bounded.");
      }
      return {
        case: "keyPress",
        value: create(BrowserTakeoverKeyPressSchema, {
          key: key ?? BrowserTakeoverKey.UNSPECIFIED,
          character,
          modifiers: modifierViews.map((modifier) => modifierMap[modifier])
        })
      };
    }
    case "textInput":
      if (action.text.length === 0 || action.text.length > 4_096 || action.text.includes("\0")) throw new GatewayError("Browser text input must contain between 1 and 4096 safe characters.");
      return { case: "textInput", value: create(BrowserTakeoverTextInputSchema, { text: action.text }) };
    case "navigate":
      return {
        case: "navigate",
        value: create(BrowserTakeoverNavigateSchema, { url: durableBrowserTakeoverUrl(action.url) })
      };
    case "navigationCommand": {
      const command = {
        back: BrowserTakeoverNavigationCommandKind.BACK,
        forward: BrowserTakeoverNavigationCommandKind.FORWARD,
        reload: BrowserTakeoverNavigationCommandKind.RELOAD,
        stop: BrowserTakeoverNavigationCommandKind.STOP
      } as const;
      return {
        case: "navigationCommand",
        value: create(BrowserTakeoverNavigationCommandSchema, { command: command[action.command] })
      };
    }
  }
}

function automationCapabilitySupport(value: CapabilitySupport | undefined): SettingsView["computerAutomation"]["support"] {
  switch (value) {
    case CapabilitySupport.SUPPORTED: return "supported";
    case CapabilitySupport.UPSTREAM_MISSING: return "upstreamMissing";
    case CapabilitySupport.NOT_IMPLEMENTED: return "notImplemented";
    case CapabilitySupport.PLATFORM_LIMITED: return "platformLimited";
    case CapabilitySupport.DISABLED_BY_POLICY: return "disabledByPolicy";
    case CapabilitySupport.TEMPORARILY_UNAVAILABLE: return "temporarilyUnavailable";
    case CapabilitySupport.UNSPECIFIED:
    default:
      return "unspecified";
  }
}

function browserBackendStatus(value: BrowserBackendStatus | undefined): BrowserSettingsView["backendHealth"]["status"] {
  switch (value) {
    case BrowserBackendStatus.READY: return "ready";
    case BrowserBackendStatus.RECOVERING: return "recovering";
    case BrowserBackendStatus.DISCONNECTED: return "disconnected";
    case BrowserBackendStatus.UNAVAILABLE: return "unavailable";
    case BrowserBackendStatus.ERROR: return "error";
    case BrowserBackendStatus.UNSPECIFIED:
    case undefined: return "disconnected";
  }
}

function browserBackendFailureReason(
  value: BrowserBackendFailureReason | undefined
): { readonly reason?: BrowserSettingsView["backendHealth"]["reason"] } {
  switch (value) {
    case BrowserBackendFailureReason.DISPOSING: return { reason: "disposing" };
    case BrowserBackendFailureReason.HOST_UNAVAILABLE: return { reason: "hostUnavailable" };
    case BrowserBackendFailureReason.START_FAILED: return { reason: "startFailed" };
    case BrowserBackendFailureReason.STATUS_FAILED: return { reason: "statusFailed" };
    case BrowserBackendFailureReason.RECOVERY_FAILED: return { reason: "recoveryFailed" };
    case BrowserBackendFailureReason.UNSPECIFIED:
    case undefined: return {};
  }
}

function automationPermissionState(value: AutomationPermissionState | undefined): SettingsView["computerAutomation"]["accessibilityPermission"] {
  switch (value) {
    case AutomationPermissionState.GRANTED: return "granted";
    case AutomationPermissionState.MISSING: return "missing";
    case AutomationPermissionState.NOT_REQUIRED: return "notRequired";
    case AutomationPermissionState.UNKNOWN:
    case AutomationPermissionState.UNSPECIFIED:
    default:
      return "unknown";
  }
}

function computerAutomationRuntimeState(value: ComputerAutomationRuntimeState | undefined): SettingsView["computerAutomation"]["runtimeState"] {
  switch (value) {
    case ComputerAutomationRuntimeState.CHECKING: return "checking";
    case ComputerAutomationRuntimeState.READY: return "ready";
    case ComputerAutomationRuntimeState.UNAVAILABLE: return "unavailable";
    case ComputerAutomationRuntimeState.ERROR: return "error";
    case ComputerAutomationRuntimeState.DISABLED:
    case ComputerAutomationRuntimeState.UNSPECIFIED:
    default:
      return "disabled";
  }
}

function computerAutomationUpdatePhase(value: ComputerAutomationUpdatePhase | undefined): SettingsView["computerAutomation"]["updatePhase"] {
  switch (value) {
    case ComputerAutomationUpdatePhase.DOWNLOADING: return "downloading";
    case ComputerAutomationUpdatePhase.INSTALLING: return "installing";
    case ComputerAutomationUpdatePhase.DONE: return "done";
    case ComputerAutomationUpdatePhase.UNSPECIFIED:
    default:
      return "idle";
  }
}

function androidAdbPathSource(value: AndroidAdbPathSource | undefined): SettingsView["androidAutomation"]["adbPathSource"] {
  switch (value) {
    case AndroidAdbPathSource.CUSTOM: return "custom";
    case AndroidAdbPathSource.ENVIRONMENT: return "environment";
    case AndroidAdbPathSource.PREPARED: return "prepared";
    case AndroidAdbPathSource.BUNDLED: return "bundled";
    case AndroidAdbPathSource.SDK: return "sdk";
    case AndroidAdbPathSource.PATH: return "path";
    case AndroidAdbPathSource.FALLBACK: return "fallback";
    case AndroidAdbPathSource.UNSPECIFIED:
    default:
      return "unspecified";
  }
}

function androidAutomationIssue(value: AndroidAutomationIssue | undefined): SettingsView["androidAutomation"]["issue"] {
  switch (value) {
    case AndroidAutomationIssue.ADB_NOT_FOUND: return "adbNotFound";
    case AndroidAutomationIssue.NO_DEVICE: return "noDevice";
    case AndroidAutomationIssue.MULTIPLE_DEVICES: return "multipleDevices";
    case AndroidAutomationIssue.DEVICE_UNAUTHORIZED: return "deviceUnauthorized";
    case AndroidAutomationIssue.DEVICE_OFFLINE: return "deviceOffline";
    case AndroidAutomationIssue.UI_DUMP_FAILED: return "uiDumpFailed";
    case AndroidAutomationIssue.SCREENSHOT_FAILED: return "screenshotFailed";
    case AndroidAutomationIssue.INVALID_NODE: return "invalidNode";
    case AndroidAutomationIssue.DRIVER_ERROR: return "driverError";
    case AndroidAutomationIssue.UNSPECIFIED:
    default:
      return "unspecified";
  }
}

function androidAutomationRuntimeState(
  value: AndroidAutomationRuntimeState | undefined
): SettingsView["androidAutomation"]["runtimeState"] {
  switch (value) {
    case AndroidAutomationRuntimeState.CHECKING: return "checking";
    case AndroidAutomationRuntimeState.PREPARING: return "preparing";
    case AndroidAutomationRuntimeState.READY: return "ready";
    case AndroidAutomationRuntimeState.UNAVAILABLE: return "unavailable";
    case AndroidAutomationRuntimeState.ERROR: return "error";
    case AndroidAutomationRuntimeState.DISABLED:
    case AndroidAutomationRuntimeState.UNSPECIFIED:
    default:
      return "disabled";
  }
}

function uiMessageInputDelivery(value: ProtoMessageInputDelivery): TimelineItemView["inputDelivery"] {
  if (value === ProtoMessageInputDelivery.PROMPT) return "prompt";
  if (value === ProtoMessageInputDelivery.STEER) return "steer";
  if (value === ProtoMessageInputDelivery.FOLLOW_UP) return "followUp";
  if (value === ProtoMessageInputDelivery.SCHEDULER) return "scheduler";
  return undefined;
}

function durableBrowserTakeoverUrl(value: string): string {
  if (value === "about:blank") return value;
  if (value.length === 0 || value.length > 8_192 || value.includes("\0")) {
    throw new GatewayError("Browser navigation URL is invalid.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new GatewayError("Browser navigation URL is invalid.");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username !== "" || url.password !== "") {
    throw new GatewayError("Only credential-free HTTP(S) browser navigation is allowed.");
  }
  if (url.hash !== "" || [...url.searchParams].some(([name, item]) =>
    /(?:^|[_-])(?:access|auth|bearer|code|credential|jwt|key|password|secret|session|signature|token)(?:$|[_-])/iu.test(name)
    || (item.length >= 32 && /^[A-Za-z0-9._~+/=-]+$/u.test(item)))) {
    throw new GatewayError("Credential-shaped URL material cannot enter durable Browser operations.");
  }
  return url.href;
}

function browserActivityKind(value: BrowserActivityKind): BrowserActivityView["kind"] {
  return ({
    [BrowserActivityKind.NAVIGATION]: "navigation",
    [BrowserActivityKind.INTERACTION]: "interaction",
    [BrowserActivityKind.SCREENSHOT]: "screenshot",
    [BrowserActivityKind.UPLOAD]: "upload",
    [BrowserActivityKind.DOWNLOAD]: "download",
    [BrowserActivityKind.LOGIN]: "login",
    [BrowserActivityKind.TAKEOVER]: "takeover",
    [BrowserActivityKind.RECOVERY]: "recovery"
  } as Partial<Record<number, BrowserActivityView["kind"]>>)[value] ?? "unknown";
}

function browserTransferState(value: BrowserTransferState): BrowserTransferView["state"] {
  if (value === BrowserTransferState.RUNNING) return "running";
  if (value === BrowserTransferState.COMPLETED) return "completed";
  if (value === BrowserTransferState.FAILED) return "failed";
  if (value === BrowserTransferState.CANCELLED) return "cancelled";
  return "pending";
}

function pageState(value: BrowserPageState): BrowserPageView["state"] {
  return value === BrowserPageState.LOADING ? "loading" : value === BrowserPageState.READY ? "ready" : value === BrowserPageState.CRASHED ? "crashed" : "closed";
}

function gitFileStatus(value: GitFileStatus): WorkspaceEntryView["status"] {
  if (value === GitFileStatus.ADDED) return "added";
  if (value === GitFileStatus.MODIFIED) return "modified";
  if (value === GitFileStatus.DELETED) return "deleted";
  if (value === GitFileStatus.RENAMED || value === GitFileStatus.COPIED) return "renamed";
  if (value === GitFileStatus.UNTRACKED) return "untracked";
  if (value === GitFileStatus.CONFLICTED) return "conflicted";
  return undefined;
}

function diffLinePrefix(value: DiffLineKind): string {
  if (value === DiffLineKind.ADDED) return "+";
  if (value === DiffLineKind.REMOVED) return "-";
  if (value === DiffLineKind.NO_NEWLINE) return "\\";
  return " ";
}

function diffLineKind(value: DiffLineKind): "context" | "added" | "removed" | "noNewline" {
  if (value === DiffLineKind.ADDED) return "added";
  if (value === DiffLineKind.REMOVED) return "removed";
  if (value === DiffLineKind.NO_NEWLINE) return "noNewline";
  return "context";
}

function resourceKind(value: ResourceKind): ResourceView["kind"] {
  if (value === ResourceKind.EXTENSION) return "extension";
  if (value === ResourceKind.SKILL) return "skill";
  if (value === ResourceKind.PROMPT_TEMPLATE) return "prompt";
  if (value === ResourceKind.THEME) return "theme";
  return "package";
}

function protoResourceKind(value: ResourceView["kind"]): ResourceKind {
  if (value === "extension") return ResourceKind.EXTENSION;
  if (value === "skill") return ResourceKind.SKILL;
  if (value === "prompt") return ResourceKind.PROMPT_TEMPLATE;
  if (value === "theme") return ResourceKind.THEME;
  return ResourceKind.PACKAGE;
}

function resourceCompatibility(value: ResourceCompatibility): ResourceView["compatibilityDetails"][number]["compatibility"] {
  if (value === ResourceCompatibility.SUPPORTED) return "supported";
  if (value === ResourceCompatibility.PARTIAL) return "partial";
  if (value === ResourceCompatibility.UNSUPPORTED) return "unsupported";
  return "unknown";
}

function resourceCompatibilityIssue(
  value: ResourceCompatibilityIssue
): ResourceView["compatibilityDetails"][number]["issues"][number] {
  if (value === ResourceCompatibilityIssue.WORKING_INDICATOR) return "workingIndicator";
  if (value === ResourceCompatibilityIssue.WIDGET_COMPONENT) return "widgetComponent";
  if (value === ResourceCompatibilityIssue.EDITOR_INTEGRATION) return "editorIntegration";
  if (value === ResourceCompatibilityIssue.TUI_LAYOUT) return "terminalLayout";
  if (value === ResourceCompatibilityIssue.CUSTOM_UI) return "customUi";
  if (value === ResourceCompatibilityIssue.THEME_CONTROL) return "themeControl";
  if (value === ResourceCompatibilityIssue.TERMINAL_INPUT) return "terminalInput";
  if (value === ResourceCompatibilityIssue.TUI_RENDERING) return "terminalRendering";
  if (value === ResourceCompatibilityIssue.CLI_FLAGS) return "cliFlags";
  if (value === ResourceCompatibilityIssue.ANALYSIS_INCOMPLETE) return "analysisIncomplete";
  return "unknown";
}

function resourceUiApi(value: ResourceUiApi): ResourceView["compatibilityDetails"][number]["detectedApis"][number] {
  const known = ({
    [ResourceUiApi.SELECT]: "select",
    [ResourceUiApi.CONFIRM]: "confirm",
    [ResourceUiApi.INPUT]: "input",
    [ResourceUiApi.EDITOR]: "editor",
    [ResourceUiApi.NOTIFY]: "notify",
    [ResourceUiApi.SET_STATUS]: "setStatus",
    [ResourceUiApi.SET_WORKING_MESSAGE]: "setWorkingMessage",
    [ResourceUiApi.SET_WORKING_VISIBLE]: "setWorkingVisible",
    [ResourceUiApi.SET_WORKING_INDICATOR]: "setWorkingIndicator",
    [ResourceUiApi.SET_HIDDEN_THINKING_LABEL]: "setHiddenThinkingLabel",
    [ResourceUiApi.SET_WIDGET]: "setWidget",
    [ResourceUiApi.SET_TITLE]: "setTitle",
    [ResourceUiApi.SET_EDITOR_TEXT]: "setEditorText",
    [ResourceUiApi.GET_EDITOR_TEXT]: "getEditorText",
    [ResourceUiApi.PASTE_TO_EDITOR]: "pasteToEditor",
    [ResourceUiApi.GET_EDITOR_COMPONENT]: "getEditorComponent",
    [ResourceUiApi.ADD_AUTOCOMPLETE_PROVIDER]: "addAutocompleteProvider",
    [ResourceUiApi.SET_EDITOR_COMPONENT]: "setEditorComponent",
    [ResourceUiApi.SET_FOOTER]: "setFooter",
    [ResourceUiApi.SET_HEADER]: "setHeader",
    [ResourceUiApi.SET_TOOLS_EXPANDED]: "setToolsExpanded",
    [ResourceUiApi.GET_TOOLS_EXPANDED]: "getToolsExpanded",
    [ResourceUiApi.CUSTOM]: "custom",
    [ResourceUiApi.GET_ALL_THEMES]: "getAllThemes",
    [ResourceUiApi.GET_THEME]: "getTheme",
    [ResourceUiApi.SET_THEME]: "setTheme",
    [ResourceUiApi.THEME]: "theme",
    [ResourceUiApi.ON_TERMINAL_INPUT]: "onTerminalInput",
    [ResourceUiApi.REGISTER_SHORTCUT]: "registerShortcut",
    [ResourceUiApi.REGISTER_FLAG]: "registerFlag",
    [ResourceUiApi.REGISTER_MESSAGE_RENDERER]: "registerMessageRenderer",
    [ResourceUiApi.REGISTER_MARKDOWN_TRANSFORMER]: "registerMarkdownTransformer",
    [ResourceUiApi.REGISTER_ENTRY_RENDERER]: "registerEntryRenderer"
  } as Partial<Record<ResourceUiApi, ResourceView["compatibilityDetails"][number]["detectedApis"][number]>>)[value];
  return known ?? "unknown";
}

function resourcePackageWarning(value: ResourcePackageWarning): ResourceView["warnings"][number] {
  if (value === ResourcePackageWarning.NO_RESOURCES) return "noResources";
  if (value === ResourcePackageWarning.INSPECTION_FAILED) return "inspectionFailed";
  if (value === ResourcePackageWarning.INSPECTION_LIMIT) return "inspectionLimit";
  if (value === ResourcePackageWarning.LIFECYCLE_SCRIPTS_DISABLED) return "lifecycleScriptsDisabled";
  return "unknown";
}

function protoResourceScope(value: ResourceView["scope"]): ResourceScope {
  if (value === "global") return ResourceScope.GLOBAL;
  if (value === "project") return ResourceScope.PROJECT;
  if (value === "managed") return ResourceScope.MANAGED;
  return ResourceScope.USER;
}

function resourceScope(value: ResourceScope | undefined): ResourceView["scope"] {
  return value === ResourceScope.GLOBAL ? "global" : value === ResourceScope.PROJECT ? "project" : value === ResourceScope.MANAGED ? "managed" : "user";
}

function resourceState(value: ResourceState): ResourceView["state"] {
  return ({
    [ResourceState.DISCOVERED]: "discovered",
    [ResourceState.AWAITING_APPROVAL]: "awaitingApproval",
    [ResourceState.APPROVED]: "approved",
    [ResourceState.INSTALLING]: "installing",
    [ResourceState.INSTALLED]: "installed",
    [ResourceState.LOADED]: "loaded",
    [ResourceState.DISABLED]: "disabled",
    [ResourceState.UPDATE_AVAILABLE]: "updateAvailable",
    [ResourceState.ERROR]: "error",
    [ResourceState.REMOVED]: "removed"
  } as Partial<Record<number, ResourceView["state"]>>)[value] ?? "discovered";
}

function toolState(value: ToolCallState): NonNullable<TimelineItemView["tool"]>["state"] {
  if (value === ToolCallState.WAITING_PERMISSION) return "waiting";
  if (value === ToolCallState.RUNNING) return "running";
  if (value === ToolCallState.SUCCEEDED) return "succeeded";
  if (value === ToolCallState.FAILED) return "failed";
  if (value === ToolCallState.ABORTED) return "aborted";
  return "requested";
}

function artifactKind(value: ArtifactKind): ArtifactView["kind"] {
  return value === ArtifactKind.IMAGE ? "image" : value === ArtifactKind.EXPORT ? "export" : value === ArtifactKind.TOOL_RESULT ? "tool" : value === ArtifactKind.DIAGNOSTICS ? "diagnostics" : value === ArtifactKind.DIFF ? "diff" : "file";
}

function backgroundState(value: BackgroundTaskState): NonNullable<TimelineItemView["background"]>["state"] {
  return value === BackgroundTaskState.QUEUED
    ? "queued"
    : value === BackgroundTaskState.RUNNING
      ? "running"
      : value === BackgroundTaskState.WAITING
        ? "waiting"
        : value === BackgroundTaskState.SUCCEEDED
          ? "completed"
          : value === BackgroundTaskState.FAILED
            ? "failed"
            : value === BackgroundTaskState.ABORTED ? "aborted" : "unknown";
}

function compactionTimelineState(value: CompactionState): NonNullable<TimelineItemView["compaction"]>["state"] {
  if (value === CompactionState.STARTED) return "started";
  if (value === CompactionState.COMPLETED) return "completed";
  if (value === CompactionState.NO_OP) return "noOp";
  if (value === CompactionState.ABORTED) return "aborted";
  if (value === CompactionState.FAILED) return "failed";
  return "unknown";
}

function contextRebuildTimelineReason(
  value: ContextRebuildReason
): NonNullable<TimelineItemView["contextRebuild"]>["reason"] | undefined {
  if (value === ContextRebuildReason.CONTEXT_OVERFLOW) return "contextOverflow";
  if (value === ContextRebuildReason.PROMPT_TIMEOUT) return "promptTimeout";
  return undefined;
}

function mapBackgroundTaskActivity(task: Snapshot["backgroundTasks"][number]): AppSnapshot["backgroundTasks"][number] {
  return {
    id: task.backgroundTaskId,
    sessionId: task.sessionId,
    state: task.state === BackgroundTaskState.QUEUED
      ? "queued"
      : task.state === BackgroundTaskState.RUNNING
        ? "running"
        : task.state === BackgroundTaskState.WAITING
          ? "waiting"
          : task.state === BackgroundTaskState.SUCCEEDED
            ? "completed"
            : task.state === BackgroundTaskState.FAILED
              ? "failed"
              : task.state === BackgroundTaskState.ABORTED ? "aborted" : "unknown"
  };
}

function mapBackgroundTaskHistory(task: ProtoBackgroundTask): BackgroundTaskHistoryView {
  if (task.createdAt === undefined || task.updatedAt === undefined) {
    throw new GatewayError("Orchestrator returned a background task without durable observation times.");
  }
  return {
    id: task.backgroundTaskId,
    backendId: task.backendId,
    targetId: task.targetId,
    sessionId: task.sessionId,
    title: task.displayName,
    state: backgroundState(task.state),
    ...(task.statusText === "" ? {} : { detail: task.statusText }),
    ...(task.parentTaskId === "" ? {} : { parentTaskId: task.parentTaskId }),
    ...(task.runId === "" ? {} : { runId: task.runId }),
    ...(task.progressRatio === undefined ? {} : { progressRatio: task.progressRatio }),
    ...(task.startedAt === undefined ? {} : { startedAt: timestampMs(task.startedAt) }),
    ...(task.endedAt === undefined ? {} : { endedAt: timestampMs(task.endedAt) }),
    createdAt: timestampMs(task.createdAt),
    updatedAt: timestampMs(task.updatedAt),
    revision: task.version?.revision?.value ?? 0n,
    ...(task.error === undefined ? {} : { error: mapError(task.error, task.runId) })
  };
}

function mapSubagentRun(run: ProtoSubagentRun): SubagentRunView {
  if (run.startedAt === undefined || run.updatedAt === undefined) {
    throw new GatewayError("Orchestrator returned a delegated run without durable observation times.");
  }
  const capabilities = run.capabilities;
  return {
    id: requiredSubagentIdentifier(run.subagentRunId, "run"),
    sessionId: requiredSubagentIdentifier(run.sessionId, "session"),
    ...(run.parentRunId.length === 0 ? {} : { parentRunId: run.parentRunId }),
    ...(run.parentSubagentRunId.length === 0 ? {} : { parentSubagentRunId: run.parentSubagentRunId }),
    ...(run.parentTaskId.length === 0 ? {} : { parentTaskId: run.parentTaskId }),
    ...(run.parentToolCallId.length === 0 ? {} : { parentToolCallId: run.parentToolCallId }),
    ...(run.logicalAgentId.length === 0 ? {} : { logicalAgentId: run.logicalAgentId }),
    identityAliases: [...run.identityAliases],
    providerRunIds: [...run.providerRunIds],
    state: subagentRunState(run.state),
    title: run.title || run.description || run.logicalAgentId || run.subagentRunId,
    ...(run.description.length === 0 ? {} : { description: run.description }),
    ...(run.assignment.length === 0 ? {} : { assignment: run.assignment }),
    ...(run.summary.length === 0 ? {} : { summary: run.summary }),
    ...(run.route === undefined ? {} : { route: {
      ...(run.route.providerId.length === 0 ? {} : { providerId: run.route.providerId }),
      ...(run.route.modelId.length === 0 ? {} : { modelId: run.route.modelId }),
      ...(run.route.thinkingLevel.length === 0 ? {} : { thinkingLevel: run.route.thinkingLevel })
    } }),
    ...(run.usage === undefined ? {} : { usage: mapSubagentUsage(run.usage) }),
    ...(run.readOnly === undefined ? {} : { readOnly: run.readOnly }),
    capabilities: {
      viewActivity: capabilities?.viewActivity ?? false,
      viewReturnedResult: capabilities?.viewReturnedResult ?? false,
      viewFullTranscript: capabilities?.viewFullTranscript ?? false,
      stop: capabilities?.stop ?? false,
      steer: capabilities?.steer ?? false,
      followUp: capabilities?.followUp ?? false,
      resume: capabilities?.resume ?? false,
      parentContext: subagentParentContext(capabilities?.parentContext ?? SubagentParentContext.UNSPECIFIED)
    },
    startedAt: timestampMs(run.startedAt),
    updatedAt: timestampMs(run.updatedAt),
    ...(run.endedAt === undefined ? {} : { endedAt: timestampMs(run.endedAt) }),
    ...(run.error === undefined ? {} : { error: mapError(run.error, run.parentRunId) }),
    revision: run.version?.revision?.value ?? 0n
  };
}

function mapSubagentRunDetail(detail: ProtoSubagentRunDetail): SubagentRunDetailView {
  if (detail.run === undefined) throw new GatewayError("Orchestrator returned a delegated-run detail without its run.");
  return {
    run: mapSubagentRun(detail.run),
    activity: detail.activity.map(mapSubagentActivity),
    children: detail.children.map(mapSubagentChildRun),
    ...(detail.returnedResult === undefined ? {} : { returnedResult: detail.returnedResult }),
    ...(detail.returnedResultTruncated === undefined ? {} : { returnedResultTruncated: detail.returnedResultTruncated }),
    ...(detail.childrenObserved === undefined ? {} : { childrenObserved: detail.childrenObserved })
  };
}

function mapSubagentActivity(activity: ProtoSubagentActivity): SubagentRunDetailView["activity"][number] {
  if (activity.occurredAt === undefined) throw new GatewayError("Orchestrator returned delegated activity without a timestamp.");
  return {
    sequence: numberValue(activity.sequence),
    kind: subagentActivityKind(activity.kind),
    state: subagentRunState(activity.state),
    ...(activity.summary.length === 0 ? {} : { summary: activity.summary }),
    ...(activity.lastToolName.length === 0 ? {} : { lastToolName: activity.lastToolName }),
    occurredAt: timestampMs(activity.occurredAt)
  };
}

function mapSubagentChildRun(child: ProtoSubagentChildRun): SubagentRunDetailView["children"][number] {
  if (child.startedAt === undefined) throw new GatewayError("Orchestrator returned a delegated child without a start time.");
  return {
    id: requiredSubagentIdentifier(child.childId, "child"),
    ...(child.parentChildId.length === 0 ? {} : { parentChildId: child.parentChildId }),
    identityAliases: [...child.identityAliases],
    ...(child.role.length === 0 ? {} : { role: child.role }),
    title: child.title || child.role || child.childId,
    ...(child.assignment.length === 0 ? {} : { assignment: child.assignment }),
    state: subagentRunState(child.state),
    ...(child.route === undefined ? {} : { route: {
      ...(child.route.providerId.length === 0 ? {} : { providerId: child.route.providerId }),
      ...(child.route.modelId.length === 0 ? {} : { modelId: child.route.modelId }),
      ...(child.route.thinkingLevel.length === 0 ? {} : { thinkingLevel: child.route.thinkingLevel })
    } }),
    ...(child.usage === undefined ? {} : { usage: mapSubagentUsage(child.usage) }),
    ...(child.readOnly === undefined ? {} : { readOnly: child.readOnly }),
    ...(child.awaitingApproval === undefined ? {} : { awaitingApproval: child.awaitingApproval }),
    ...(child.result === undefined ? {} : { result: child.result }),
    ...(child.resultTruncated === undefined ? {} : { resultTruncated: child.resultTruncated }),
    ...(child.error === undefined ? {} : { error: mapError(child.error, "") }),
    startedAt: timestampMs(child.startedAt),
    ...(child.endedAt === undefined ? {} : { endedAt: timestampMs(child.endedAt) })
  };
}

function mapSubagentUsage(usage: ProtoSubagentUsage): NonNullable<SubagentRunView["usage"]> {
  if (usage.costUsd !== undefined && (!Number.isFinite(usage.costUsd) || usage.costUsd < 0)) {
    throw new GatewayError("Orchestrator returned invalid delegated-run cost data.");
  }
  return {
    ...(usage.inputTokens === undefined ? {} : { inputTokens: numberValue(usage.inputTokens) }),
    ...(usage.outputTokens === undefined ? {} : { outputTokens: numberValue(usage.outputTokens) }),
    ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: numberValue(usage.cacheReadTokens) }),
    ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: numberValue(usage.cacheWriteTokens) }),
    ...(usage.totalTokens === undefined ? {} : { totalTokens: numberValue(usage.totalTokens) }),
    ...(usage.toolUses === undefined ? {} : { toolUses: numberValue(usage.toolUses) }),
    ...(usage.duration === undefined ? {} : { durationMs: Math.max(0, Math.round(durationSeconds(usage.duration) * 1_000)) }),
    ...(usage.costUsd === undefined ? {} : { costUsd: usage.costUsd })
  };
}

function mapSubagentTranscriptEntry(entry: ProtoSubagentTranscriptEntry): SubagentTranscriptEntryView {
  if (entry.occurredAt === undefined) throw new GatewayError("Orchestrator returned a delegated transcript entry without a timestamp.");
  return {
    id: requiredSubagentIdentifier(entry.entryId, "transcript entry"),
    sequence: numberValue(entry.sequence),
    role: subagentTranscriptRole(entry.role),
    content: entry.content,
    occurredAt: timestampMs(entry.occurredAt),
    ...(entry.childId.length === 0 ? {} : { childId: entry.childId }),
    ...(entry.childTitle.length === 0 ? {} : { childTitle: entry.childTitle }),
    ...(entry.toolName.length === 0 ? {} : { toolName: entry.toolName }),
    ...(entry.toolCallId.length === 0 ? {} : { toolCallId: entry.toolCallId }),
    ...subagentToolPhase(entry.toolPhase),
    ...(entry.toolInputJson.length === 0 ? {} : { toolInputJson: entry.toolInputJson }),
    ...(entry.isError === undefined ? {} : { isError: entry.isError }),
    ...subagentControlAction(entry.controlAction),
    ...(entry.systemEvent === undefined ? {} : {
      systemEvent: {
        kind: entry.systemEvent.kind,
        params: entry.systemEvent.params.map((parameter) => ({ key: parameter.key, value: parameter.value }))
      }
    })
  };
}

function subagentRunState(value: SubagentRunState): SubagentRunStateView {
  if (value === SubagentRunState.QUEUED) return "queued";
  if (value === SubagentRunState.RUNNING) return "running";
  if (value === SubagentRunState.COMPLETED) return "completed";
  if (value === SubagentRunState.FAILED) return "failed";
  if (value === SubagentRunState.STOPPED) return "stopped";
  throw new GatewayError("Orchestrator returned an unknown delegated-run state.");
}

function protoSubagentRunState(value: SubagentRunStateView): SubagentRunState {
  if (value === "queued") return SubagentRunState.QUEUED;
  if (value === "running") return SubagentRunState.RUNNING;
  if (value === "completed") return SubagentRunState.COMPLETED;
  if (value === "failed") return SubagentRunState.FAILED;
  return SubagentRunState.STOPPED;
}

function subagentActivityKind(value: SubagentActivityKind): SubagentRunDetailView["activity"][number]["kind"] {
  if (value === SubagentActivityKind.STARTED) return "started";
  if (value === SubagentActivityKind.PROGRESS) return "progress";
  if (value === SubagentActivityKind.MESSAGE) return "message";
  if (value === SubagentActivityKind.QUESTION) return "question";
  if (value === SubagentActivityKind.DECISION) return "decision";
  if (value === SubagentActivityKind.RESUMED) return "resumed";
  if (value === SubagentActivityKind.STEERED) return "steered";
  if (value === SubagentActivityKind.FOLLOWED_UP) return "followedUp";
  if (value === SubagentActivityKind.COMPLETED) return "completed";
  if (value === SubagentActivityKind.FAILED) return "failed";
  if (value === SubagentActivityKind.STOPPED) return "stopped";
  throw new GatewayError("Orchestrator returned an unknown delegated activity kind.");
}

function subagentParentContext(value: SubagentParentContext): SubagentRunView["capabilities"]["parentContext"] {
  if (value === SubagentParentContext.NONE) return "none";
  if (value === SubagentParentContext.SNAPSHOT) return "snapshot";
  if (value === SubagentParentContext.LIVE) return "live";
  return "unknown";
}

function subagentTranscriptRole(value: SubagentTranscriptRole): SubagentTranscriptEntryView["role"] {
  if (value === SubagentTranscriptRole.PARENT) return "parent";
  if (value === SubagentTranscriptRole.SUBAGENT) return "subagent";
  if (value === SubagentTranscriptRole.TOOL) return "tool";
  if (value === SubagentTranscriptRole.SYSTEM) return "system";
  throw new GatewayError("Orchestrator returned an unknown delegated transcript role.");
}

function subagentToolPhase(value: SubagentToolPhase): Pick<SubagentTranscriptEntryView, "toolPhase"> | Record<string, never> {
  if (value === SubagentToolPhase.START) return { toolPhase: "start" };
  if (value === SubagentToolPhase.UPDATE) return { toolPhase: "update" };
  if (value === SubagentToolPhase.END) return { toolPhase: "end" };
  return {};
}

function subagentControlAction(value: SubagentControlAction): Pick<SubagentTranscriptEntryView, "controlAction"> | Record<string, never> {
  if (value === SubagentControlAction.STOP) return { controlAction: "stop" };
  if (value === SubagentControlAction.STEER) return { controlAction: "steer" };
  if (value === SubagentControlAction.FOLLOW_UP) return { controlAction: "followUp" };
  if (value === SubagentControlAction.RESUME) return { controlAction: "resume" };
  return {};
}

function protoSubagentControlAction(value: SubagentControlActionView): SubagentControlAction {
  if (value === "stop") return SubagentControlAction.STOP;
  if (value === "steer") return SubagentControlAction.STEER;
  if (value === "followUp") return SubagentControlAction.FOLLOW_UP;
  return SubagentControlAction.RESUME;
}

function requiredSubagentIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 512) throw new GatewayError(`Orchestrator returned an invalid delegated ${label} identifier.`);
  return normalized;
}

function compactionTimelineReason(value: string, automatic: boolean): NonNullable<TimelineItemView["compaction"]>["reason"] {
  const reason = value.trim().toLocaleLowerCase();
  if (reason === "manual") return "manual";
  if (reason === "threshold") return "threshold";
  if (reason === "overflow") return "overflow";
  if (reason === "branch") return "branch";
  if (reason === "automatic" || reason === "auto") return "automatic";
  return automatic ? "automatic" : "unknown";
}

function retryTimelineState(value: RetryState): NonNullable<TimelineItemView["retry"]>["state"] {
  if (value === RetryState.WAITING) return "waiting";
  if (value === RetryState.STARTED) return "started";
  if (value === RetryState.ABORTED) return "aborted";
  if (value === RetryState.SUCCEEDED) return "succeeded";
  if (value === RetryState.EXHAUSTED) return "exhausted";
  return "unknown";
}

function runtimeRecoveryTimelineState(
  value: RuntimeRecoveryState
): NonNullable<TimelineItemView["runtimeRecovery"]>["state"] {
  if (value === RuntimeRecoveryState.WAITING) return "waiting";
  if (value === RuntimeRecoveryState.RUNNING) return "running";
  if (value === RuntimeRecoveryState.SUCCEEDED) return "succeeded";
  if (value === RuntimeRecoveryState.FAILED) return "failed";
  if (value === RuntimeRecoveryState.EXHAUSTED) return "exhausted";
  if (value === RuntimeRecoveryState.CANCELLED) return "cancelled";
  throw new GatewayError("Orchestrator returned an unknown runtime recovery state.");
}

function positiveTimelineInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new GatewayError(`Orchestrator returned an invalid ${label}.`);
  }
  return value;
}

function errorSeverity(value: ErrorSeverity): ErrorView["severity"] {
  return value === ErrorSeverity.WAITING ? "waiting" : value === ErrorSeverity.RETRYABLE ? "retryable" : value === ErrorSeverity.BLOCKED ? "blocked" : "fatal";
}
