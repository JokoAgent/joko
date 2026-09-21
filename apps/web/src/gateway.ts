import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { createClient, ConnectError, Code, type Interceptor, type Transport } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { createTerminalGateway } from "./terminal-gateway.js";
import { UsageReportGroup } from "@joko/contracts";
import { SshKeyService, SshAgentState, SshKeyPassphrasePurpose, SshInstallShell, type SshKey, type CredentialUploadTicket } from "@joko/contracts";
import type { SshKeyView, SshKeyCatalogView, SshKeyGenerateDraft, SshKeyInstallCommandDraft } from "./model.js";
import type { UsageReportQueryView, UsageReportView } from "./model.js";
import {
  ArtifactKind,
  AudioArtifactKind,
  type AudioArtifactMetadata,
  ArtifactService,
  ArtifactStorageCleanupOutcome,
  AndroidAdbPathSource,
  AndroidAutomationIssue,
  AndroidAutomationRuntimeState,
  AuthenticationState,
  BackendService,
  BackendHealth,
  BackendMemoryKind,
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
  CollaborationRole as ProtoCollaborationRole,
  CollaborationScopeKind as ProtoCollaborationScopeKind,
  CompactionState,
  ContextRebuildReason,
  CompositeArgumentKind,
  ConnectionService,
  ContactDuplicateMatchType,
  ContactKind as ProtoContactKind,
  ContactRelationDirection,
  ContactService,
  ContactSource as ProtoContactSource,
  ContactStatus as ProtoContactStatus,
  ContactSyncErrorCode,
  ContactSyncPeerState,
  ContactSyncPhase,
  ContactSyncRoute,
  ContactVCardImportDecisionKind,
  ContactVCardImportDisposition,
  ContactVCardImportOutcome,
  PartnerInitializationErrorCode,
  PartnerInitializationState,
  PartnerInvitationStage,
  PartnerDelegationStatus,
  PartnerLifecycle,
  PartnerPrivateMessageDeliveryStatus,
  PartnerPrivateThreadCloseReason,
  PartnerPrivateThreadStatus,
  PartnerSessionRole,
  PartnerService,
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
  ExtensionCatalogSource as ProtoExtensionCatalogSource,
  ExtensionLibraryEntryKind as ProtoExtensionLibraryEntryKind,
  ExtensionLibraryCallSchema,
  ExtensionLibraryLocationKind as ProtoExtensionLibraryLocationKind,
  ExtensionLibraryState as ProtoExtensionLibraryState,
  ExtensionLibraryUnavailableReason as ProtoExtensionLibraryUnavailableReason,
  ExtensionMainViewIcon as ProtoExtensionMainViewIcon,
  ExtensionPackageAction as ProtoExtensionPackageAction,
  ExtensionPackageExportState as ProtoExtensionPackageExportState,
  ExtensionSourceKind as ProtoExtensionSourceKind,
  ExtensionSourceState as ProtoExtensionSourceState,
  ExtensionInstallState as ProtoExtensionInstallState,
  ExtensionService,
  ExtensionSetupFieldKind as ProtoExtensionSetupFieldKind,
  ExtensionSetupState as ProtoExtensionSetupState,
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
  InlineTextRangeSchema,
  InputContentSchema,
  InputMentionRangeSchema,
  InputPartSchema,
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
  ProviderConfigurationField,
  ProviderRuntimeConfigurationSchema,
  ProviderCredentialSurfaceCapability,
  ProviderCredentialSurfaceKind,
  ProviderKind,
  ProviderModelConfigurationSchema,
  ProviderLoginFlowState,
  ProviderLoginMethod,
  ProviderLoginPromptKind,
  PlanStepState,
  PlanReviewDecisionKind,
  QuestionAnswerSchema,
  QueueDeliveryMode,
  QueueDispatchState,
  QueueEdge,
  QueueItemState,
  QueueSourceKind,
  QueueTextEditSpliceSchema,
  ResourceAcquisitionSourceSchema,
  ResourceCompatibility,
  ResourceCompatibilityIssue,
  ResourceAcquisitionKind,
  ResourceKind,
  ResourcePackageWarning,
  ResourcePermissionAction,
  ResourceRuntimeRequirementStatus,
  ResourceScope,
  ResourceState,
  ResourceUsageComparisonUnavailableReason as ProtoResourceUsageComparisonUnavailableReason,
  ResourceUsageSource as ProtoResourceUsageSource,
  ResourceUiApi,
  RecoveryActionKind,
  ReviewAttachmentKind,
  ReviewFreshnessState,
  ReviewFailureCode,
  ReviewRunState,
  ReviewTargetKind,
  RemoteHostAuthenticationMode,
  RemoteBackendRuntimeFailureCode,
  RemoteBackendRuntimeInstallPhase,
  RemoteBackendRuntimeState,
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
  TargetService,
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
  SkillDiffChangeKind,
  SkillDraftKind,
  SkillFileKind,
  SkillMarketInstallAction as ProtoSkillMarketInstallAction,
  SkillMarketInstallConfirmationReason as ProtoSkillMarketInstallConfirmationReason,
  SkillMarketInstallStatusState as ProtoSkillMarketInstallStatusState,
  SkillMarketPreviewUnavailableReason as ProtoSkillMarketPreviewUnavailableReason,
  SkillMarketSort,
  SkillMarketSourceKind as ProtoSkillMarketSourceKind,
  SkillMarketSourceState as ProtoSkillMarketSourceState,
  SkillMarketSyncJobState as ProtoSkillMarketSyncJobState,
  SkillMarketSyncOutcome as ProtoSkillMarketSyncOutcome,
  SkillPublicationGateStatus as ProtoSkillPublicationGateStatus,
  SkillPublicationMode as ProtoSkillPublicationMode,
  SkillPublicationPublisher as ProtoSkillPublicationPublisher,
  SkillPublicationState as ProtoSkillPublicationState,
  SkillPublicationVerdict as ProtoSkillPublicationVerdict,
  SkillPublicationVisibility as ProtoSkillPublicationVisibility,
  SkillRecoveryStatus,
  SkillService,
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
  type ContactDirectory as ProtoContactDirectory,
  type ContactDraft as ProtoContactDraft,
  type ContactDuplicateCandidate as ProtoContactDuplicateCandidate,
  type ContactGroup as ProtoContactGroup,
  type ContactIdentity as ProtoContactIdentity,
  type ContactEvent as ProtoContactEvent,
  type ContactProfile as ProtoContactProfile,
  type ContactRelation as ProtoContactRelation,
  type ContactSummary as ProtoContactSummary,
  type ContactSyncStatus as ProtoContactSyncStatus,
  type ContactVCardImportPreviewEntry as ProtoContactVCardImportPreviewEntry,
  type PartnerCapabilities as ProtoPartnerCapabilities,
  type PartnerActivity as ProtoPartnerActivity,
  type PartnerDelegation as ProtoPartnerDelegation,
  type PartnerDirectory as ProtoPartnerDirectory,
  type PartnerPrivateMessage as ProtoPartnerPrivateMessage,
  type PartnerPrivateThread as ProtoPartnerPrivateThread,
  type PartnerPrivateThreadReadState as ProtoPartnerPrivateThreadReadState,
  type PartnerProfile as ProtoPartnerProfile,
  type PartnerSession as ProtoPartnerSession,
  type CollaborationDirectory as ProtoCollaborationDirectory,
  type ContextUsage as ProtoContextUsage,
  type CredentialDescriptor,
  type Device,
  type DeviceControlRelation,
  type DisplayArgument,
  type ErrorInfo,
  type Event,
  type ExtraDirectory,
  type ExtensionStatus,
  type ExtensionCatalogEntry as ProtoExtensionCatalogEntry,
  type ExtensionLibraryCallResult as ProtoExtensionLibraryCallResult,
  type ExtensionLibraryEntry as ProtoExtensionLibraryEntry,
  type ExtensionLibraryGraceEntry as ProtoExtensionLibraryGraceEntry,
  type ExtensionLibraryLocation as ProtoExtensionLibraryLocation,
  type ExtensionLibraryOverview as ProtoExtensionLibraryOverview,
  type ExtensionLibrarySession as ProtoExtensionLibrarySession,
  type ExtensionLibrarySqlResult as ProtoExtensionLibrarySqlResult,
  type ExtensionLibrarySqlValue as ProtoExtensionLibrarySqlValue,
  type ExtensionLibraryTrashEntry as ProtoExtensionLibraryTrashEntry,
  type ExtensionMainViewSurface as ProtoExtensionMainViewSurface,
  type ExtensionPackageExportAuthority as ProtoExtensionPackageExportAuthority,
  type ExtensionPackageExportJob as ProtoExtensionPackageExportJob,
  type ExtensionPackageExportPreview as ProtoExtensionPackageExportPreview,
  type ExtensionPackagePreview as ProtoExtensionPackagePreview,
  type ExtensionSourceDescriptor as ProtoExtensionSourceDescriptor,
  type ExtensionWidget,
  type FilePreview,
  type FileDiff,
  type Interaction,
  type InputContent,
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
  type ProviderRuntimeConfiguration,
  type ProviderLoginFlow,
  type QueueItem,
  type QueueControl,
  type QuestionAnswer,
  type QuestionChoice,
  type QuestionField,
  type ResourceUsageMetrics as ProtoResourceUsageMetrics,
  type ResourceUsageReport as ProtoResourceUsageReport,
  type ResourceUsageVersionBreakdown as ProtoResourceUsageVersionBreakdown,
  type Schedule,
  type SchedulerRuntimeSnapshot as ProtoSchedulerRuntimeSnapshot,
  type ScheduleRunHistory,
  type ReviewRun as ProtoReviewRun,
  type RemoteHost as ProtoRemoteHost,
  type RemoteBackendRuntime as ProtoRemoteBackendRuntime,
  type SessionMessageSearchMatch,
  type Session,
  type SessionStatistics as ProtoSessionStatistics,
  type SkillDescriptor as ProtoSkillDescriptor,
  type SkillDiff as ProtoSkillDiff,
  type SkillDiffChange as ProtoSkillDiffChange,
  type SkillDraft as ProtoSkillDraft,
  type SkillFileContent as ProtoSkillFileContent,
  type SkillFileEntry as ProtoSkillFileEntry,
  type SkillMarketArchiveEntry as ProtoSkillMarketArchiveEntry,
  type SkillAccessPolicy as ProtoSkillAccessPolicy,
  type SkillMarketEntry as ProtoSkillMarketEntry,
  type SkillMarketEntryIdentity as ProtoSkillMarketEntryIdentity,
  type SkillMarketInstallPlan as ProtoSkillMarketInstallPlan,
  type SkillMarketInstallPreview as ProtoSkillMarketInstallPreview,
  type SkillMarketInstallStatus as ProtoSkillMarketInstallStatus,
  type SkillMarketInstallTarget as ProtoSkillMarketInstallTarget,
  type SkillMarketPreview as ProtoSkillMarketPreview,
  type SkillMarketPreviewFile as ProtoSkillMarketPreviewFile,
  type SkillMarketSourceDescriptor as ProtoSkillMarketSourceDescriptor,
  type SkillMarketSyncBaseline as ProtoSkillMarketSyncBaseline,
  type SkillMarketSyncJob as ProtoSkillMarketSyncJob,
  type SkillMarketSyncJobAuthority as ProtoSkillMarketSyncJobAuthority,
  type SkillMarketSyncPolicy as ProtoSkillMarketSyncPolicy,
  type SkillMarketSyncTarget as ProtoSkillMarketSyncTarget,
  type SkillPublicationAuthority as ProtoSkillPublicationAuthority,
  type SkillPublicationGate as ProtoSkillPublicationGate,
  type SkillPublicationJob as ProtoSkillPublicationJob,
  type SkillPublicationMetadata as ProtoSkillPublicationMetadata,
  type SkillPublicationPreview as ProtoSkillPublicationPreview,
  type SkillPublicationResult as ProtoSkillPublicationResult,
  type SkillRecovery as ProtoSkillRecovery,
  type SkillSession as ProtoSkillSession,
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
  type SessionResource,
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
import { presentJokoServiceTerminology } from "./i18n/service-terminology.js";
import { projectTimelineGeneratedFiles } from "./generated-files.js";
import { emptySnapshot } from "./model.js";
import { saveArtifactBlob } from "./artifact-download.js";
import {
  captureNativeArtifactSourceReveal,
  captureNativeFileCopy,
  captureNativeFileOpen,
  copyNativeArtifactFile,
  NATIVE_FILE_COPY_MAXIMUM_BYTES,
  NATIVE_FILE_OPEN_MAXIMUM_BYTES,
  openNativeArtifactFile,
  revealNativeArtifactSource
} from "./native-file-actions.js";
import type {
  AppSnapshot,
  ArtifactStorageCleanupView,
  ArtifactStorageMaintenanceSupportView,
  ArtifactStorageMaintenanceView,
  ArtifactStorageReconcileView,
  ArtifactStorageScanView,
  ArtifactReferenceCatalogItemView,
  ArtifactView,
  ArtifactDownloadContext,
  ArtifactDownloadOutcome,
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
  ContactCreateResultView,
  ContactDirectoryView,
  ContactDraftView,
  ContactDuplicateCandidateView,
  ContactDuplicatePairView,
  ContactEventInputView,
  ContactEventView,
  ContactGroupView,
  ContactIdentityInputView,
  ContactIdentityView,
  ContactKindView,
  ContactListOptionsView,
  ContactListPageView,
  ContactMergeResultView,
  ContactMutationView,
  ContactPatchView,
  ContactProfileView,
  ContactRelationView,
  ContactSourceView,
  ContactStatusView,
  ContactSyncStatusView,
  ContactSummaryView,
  ContactVCardExportView,
  ContactVCardImportDecisionKindView,
  ContactVCardImportDecisionView,
  ContactVCardImportDispositionView,
  ContactVCardImportPreviewEntryView,
  ContactVCardImportPreviewView,
  ContactVCardImportResultView,
  CredentialDraft,
  DeviceControlRelationView,
  DeviceView,
  DiscoveredOrchestratorView,
  ErrorView,
  ExtraDirectoryView,
  ExtensionStatusView,
  ExtensionCatalogEntryView,
  ExtensionCatalogView,
  ExtensionLibraryCallResultView,
  ExtensionLibraryCallView,
  ExtensionLibraryEntryView,
  ExtensionLibraryGraceEntryView,
  ExtensionLibraryLocationValidationView,
  ExtensionLibraryLocationView,
  ExtensionLibraryOverviewView,
  ExtensionLibrarySessionView,
  ExtensionLibrarySqlResultView,
  ExtensionLibrarySqlValueView,
  ExtensionLibraryTrashEntryView,
  ExtensionMainViewIconView,
  ExtensionMainViewSurfaceView,
  ExtensionPackageExportAuthorityView,
  ExtensionPackageExportCatalogView,
  ExtensionPackageExportJobView,
  ExtensionPackageExportPreviewView,
  ExtensionPackagePreviewView,
  ExtensionSourceCatalogView,
  ExtensionSourceDraft,
  ExtensionSourceGitPreflightView,
  ExtensionSourceView,
  ExtensionWidgetView,
  InteractionView,
  InteractionResolutionDraft,
  QuestionAnswerDraft,
  ModelPriceOverrideView,
  ModelPriceQuoteView,
  ModelView,
  ManagedModelRuntimeView,
  OperationApi,
  PartnerCapabilitiesView,
  PartnerActivityView,
  PartnerDelegationStatusView,
  PartnerDelegationView,
  PartnerDefaultsMutationView,
  PartnerDirectoryView,
  PartnerDraftView,
  PartnerInitializationErrorCodeView,
  PartnerInitializationStateView,
  PartnerInvitationStageView,
  PartnerLifecycleView,
  PartnerListView,
  PartnerModelRouteView,
  PartnerMutationView,
  PartnerPatchView,
  PartnerPrivateMessageDeliveryStatusView,
  PartnerPrivateMessageView,
  PartnerPrivateThreadCloseReasonView,
  PartnerPrivateThreadDetailView,
  PartnerPrivateThreadReadStateView,
  PartnerPrivateThreadStatusView,
  PartnerPrivateThreadView,
  PartnerProfileView,
  PartnerSessionRoleView,
  PartnerSessionView,
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
  QueueItemTextEditView,
  QueueItemView,
  QueueControlView,
  ReviewRunView,
  ResourceView,
  ResourceDraft,
  ResourceUsageMetricsView,
  ResourceUsageReportView,
  ResourceUsageSourceView,
  ResourceUsageVersionBreakdownView,
  RuntimeCommandView,
  SessionResourceView,
  RuntimeProcessUsageSnapshotView,
  RuntimeProcessUsageView,
  RuntimeToolCatalogView,
  RuntimeToolFieldTypeView,
  RemoteConnectionView,
  RemoteBackendRuntimeFailureCodeView,
  RemoteBackendRuntimeInstallEventView,
  RemoteBackendRuntimeView,
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
  SessionWorktreeRemovalPreviewView,
  SessionWorktreeView,
  TargetView,
  SkillCatalogView,
  CollaborationDirectoryView,
  CollaborationScopeKindView,
  CollaborationScopeView,
  SkillDescriptorView,
  SkillDiffChangeView,
  SkillDiffView,
  SkillDraftView,
  SkillFileContentView,
  SkillFileEntryView,
  SkillMarketArchiveEntryView,
  SkillMarketArchivePageView,
  SkillMarketCatalogPageView,
  SkillMarketEntryIdentityView,
  SkillMarketEntryView,
  SkillAccessPolicyView,
  SkillMarketGitPreflightView,
  SkillMarketInstallPlanView,
  SkillMarketInstallPreviewView,
  SkillMarketInstallStatusView,
  SkillMarketInstallTargetView,
  SkillMarketPreviewFileView,
  SkillMarketPreviewView,
  SkillMarketSourceCatalogView,
  SkillMarketSourceDraft,
  SkillMarketSourceView,
  SkillMarketSortView,
  SkillMarketSyncBaselineView,
  SkillMarketSyncCatalogView,
  SkillMarketSyncJobAuthorityView,
  SkillMarketSyncJobStateView,
  SkillMarketSyncJobView,
  SkillMarketSyncOutcomeView,
  SkillMarketSyncPolicyView,
  SkillMarketSyncTargetView,
  SkillPublicationAuthorityView,
  SkillPublicationAccessSelectionView,
  SkillPublicationGateView,
  SkillPublicationJobView,
  SkillPublicationMetadataView,
  SkillPublicationPreviewView,
  SkillPublicationResultView,
  SkillPublicationStateView,
  SkillMutationResultView,
  SkillRecoveryView,
  SkillSessionView,
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
import { messageMentionWireText } from "./message-reference.js";
import { composerDocumentPlainText, normalizeComposerDocument, serializeComposerDocument } from "./composer-quote-document.js";
import { normalizeComposerInlineMentionRanges } from "./composer-mention-ranges.js";
import { equalQueueItemTextEdit, queueItemEditProjection } from "./queue-item-edit.js";
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

export interface OrchestratorGateway extends Omit<OperationApi, "openBrowserPage" | "recoverBrowserPage"> {
  connect(): Promise<void>;
  disconnect(): void;
  pair(origin: string, humanCode: string, deviceName: string): Promise<PairingOutcome>;
  /** Authoritative owner-runtime shutdown fence, sampled only on demand. */
  probeRuntimeActivity(): Promise<boolean>;
  openBrowserPage(browserId: string, sessionId: string, url: string, presentationTarget: BrowserSettingsView["automationTarget"], recoveryPageId?: string, workspaceHtml?: { readonly workspaceId: string; readonly relativePath: string; readonly expectedRevision: string }): Promise<string>;
  recoverBrowserPage(browserId: string, sessionId: string, pageId: string, url: string, presentationTarget: BrowserSettingsView["automationTarget"]): Promise<string>;
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
const MAX_EXTENSION_SOURCE_DECLARED_ENTRIES = 512;
const MAX_EXTENSION_SOURCE_EXTENSIONS = 2_048;
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

interface GatewayActionScope {
  readonly transport: Transport;
  readonly authKey: string;
  readonly signal: AbortSignal;
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

  async readSessionArtifact(sessionId: string, artifactId: string, signal: AbortSignal): Promise<ArtifactView> {
    if (!sessionId || !artifactId) throw new GatewayError("An Artifact reference requires its original task and object identity.");
    const scope = this.captureActionScope(signal);
    const response = await createClient(ArtifactService, scope.transport).getArtifact({ artifactId }, { signal: scope.signal }).catch((error: unknown) => {
      scope.signal.throwIfAborted();
      if (ConnectError.from(error).code === Code.NotFound) throw new GatewayError("The referenced Artifact is unavailable in its original task.");
      throw error;
    });
    scope.signal.throwIfAborted();
    const artifact = response.artifact;
    if (artifact === undefined || artifact.artifactId !== artifactId || artifact.sessionId !== sessionId || !artifact.blob?.blobId
      || artifact.expiresAt !== undefined && timestampMs(artifact.expiresAt) <= Date.now()) {
      throw new GatewayError("The referenced Artifact is unavailable in its original task.");
    }
    return mapArtifact(artifact);
  }

  async listSessionArtifacts(sessionId: string, signal?: AbortSignal): Promise<readonly ArtifactView[]> {
    if (!validResourceIdentityText(sessionId)) throw new GatewayError("An Artifact catalog requires its exact task identity.");
    const scope = this.captureActionScope(signal);
    const client = createClient(ArtifactService, scope.transport);

    artifactCatalogAttempts:
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const artifacts: ArtifactView[] = [];
      const artifactIds = new Set<string>();
      const consumedTokens = new Set<string>();
      let pageToken = "";
      let revision: bigint | undefined;
      let totalSize: number | undefined;
      let received = 0;
      try {
        for (let pageIndex = 0; pageIndex < MAX_COMPLETE_MESSAGE_SEARCH_PAGES; pageIndex += 1) {
          scope.signal.throwIfAborted();
          if (pageToken !== "") {
            if (consumedTokens.has(pageToken)) throw new GatewayError("Orchestrator returned a cyclic Artifact catalog page token.");
            consumedTokens.add(pageToken);
          }
          const response = await client.listArtifacts(
            { sessionId, page: { pageSize: 500, pageToken } },
            { signal: scope.signal }
          );
          scope.signal.throwIfAborted();
          const pageRevision = response.revision?.value;
          if (pageRevision === undefined) throw new GatewayError("Orchestrator returned an Artifact catalog without its durable revision.");
          if (revision === undefined) revision = pageRevision;
          else if (revision !== pageRevision) {
            if (attempt === 0) continue artifactCatalogAttempts;
            throw new GatewayError("Artifact catalog changed repeatedly while it was being loaded.");
          }
          const page = response.page;
          const pageTotal = page === undefined ? undefined : exactSafeUnsignedNumber(page.totalSize);
          if (pageTotal === undefined) throw new GatewayError("Orchestrator returned an invalid Artifact catalog size.");
          if (totalSize === undefined) totalSize = pageTotal;
          else if (totalSize !== pageTotal) throw new GatewayError("Orchestrator returned inconsistent Artifact catalog sizes.");
          if (response.artifacts.length > 500 || received + response.artifacts.length > pageTotal) {
            throw new GatewayError("Orchestrator returned an invalid Artifact catalog page.");
          }
          for (const artifact of response.artifacts) {
            const mapped = mapSessionArtifactCatalogItem(artifact, sessionId, artifactIds);
            if (mapped !== undefined) artifacts.push(mapped);
          }
          received += response.artifacts.length;
          const nextPageToken = page?.nextPageToken ?? "";
          if (nextPageToken === "") {
            if (received !== pageTotal) throw new GatewayError("Orchestrator returned an incomplete Artifact catalog.");
            return artifacts;
          }
          if (received >= pageTotal || nextPageToken === pageToken || consumedTokens.has(nextPageToken)) {
            throw new GatewayError("Orchestrator returned an invalid Artifact catalog pagination boundary.");
          }
          pageToken = nextPageToken;
        }
      } catch (error) {
        if (attempt === 0 && isRevisionDriftError(error)) continue;
        throw error;
      }
      throw new GatewayError("Artifact catalog exceeded the safe pagination limit.");
    }
    throw new GatewayError("Artifact catalog changed repeatedly while it was being loaded.");
  }

  async listArtifactReferenceCatalog(
    targetSessionId: string,
    targetGeneration: bigint,
    signal?: AbortSignal
  ): Promise<readonly ArtifactReferenceCatalogItemView[]> {
    if (!validSessionMentionId(targetSessionId)) {
      throw new GatewayError("An Artifact reference catalog requires its exact receiving task identity.");
    }
    if (targetGeneration < 1n || targetGeneration > 18_446_744_073_709_551_615n) {
      throw new GatewayError("An Artifact reference catalog requires the receiving task generation.");
    }
    const scope = this.captureActionScope(signal);
    const client = createClient(ArtifactService, scope.transport);

    artifactReferenceCatalogAttempts:
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const artifacts: ArtifactReferenceCatalogItemView[] = [];
      const artifactIdentities = new Set<string>();
      const consumedTokens = new Set<string>();
      let pageToken = "";
      let revision: bigint | undefined;
      let totalSize: number | undefined;
      let received = 0;
      try {
        for (let pageIndex = 0; pageIndex < MAX_COMPLETE_MESSAGE_SEARCH_PAGES; pageIndex += 1) {
          scope.signal.throwIfAborted();
          if (pageToken !== "") {
            if (consumedTokens.has(pageToken)) throw new GatewayError("Orchestrator returned a cyclic Artifact reference catalog page token.");
            consumedTokens.add(pageToken);
          }
          const response = await client.listArtifacts(
            {
              referenceTargetSessionId: targetSessionId,
              referenceTargetGeneration: targetGeneration,
              page: { pageSize: 500, pageToken }
            },
            { signal: scope.signal }
          );
          scope.signal.throwIfAborted();
          const pageRevision = response.revision?.value;
          if (pageRevision === undefined) throw new GatewayError("Orchestrator returned an Artifact reference catalog without its durable revision.");
          if (revision === undefined) revision = pageRevision;
          else if (revision !== pageRevision) {
            if (attempt === 0) continue artifactReferenceCatalogAttempts;
            throw new GatewayError("Artifact reference catalog changed repeatedly while it was being loaded.");
          }
          const page = response.page;
          const pageTotal = page === undefined ? undefined : exactSafeUnsignedNumber(page.totalSize);
          if (pageTotal === undefined) throw new GatewayError("Orchestrator returned an invalid Artifact reference catalog size.");
          if (totalSize === undefined) totalSize = pageTotal;
          else if (totalSize !== pageTotal) throw new GatewayError("Orchestrator returned inconsistent Artifact reference catalog sizes.");
          if (response.artifacts.length > 500 || received + response.artifacts.length > pageTotal) {
            throw new GatewayError("Orchestrator returned an invalid Artifact reference catalog page.");
          }
          for (const artifact of response.artifacts) {
            const mapped = mapArtifactReferenceCatalogItem(artifact, artifactIdentities);
            if (mapped !== undefined) artifacts.push(mapped);
          }
          received += response.artifacts.length;
          const nextPageToken = page?.nextPageToken ?? "";
          if (nextPageToken === "") {
            if (received !== pageTotal) throw new GatewayError("Orchestrator returned an incomplete Artifact reference catalog.");
            return artifacts;
          }
          if (received >= pageTotal || nextPageToken === pageToken || consumedTokens.has(nextPageToken)) {
            throw new GatewayError("Orchestrator returned an invalid Artifact reference catalog pagination boundary.");
          }
          pageToken = nextPageToken;
        }
      } catch (error) {
        if (attempt === 0 && isRevisionDriftError(error)) continue;
        throw error;
      }
      throw new GatewayError("Artifact reference catalog exceeded the safe pagination limit.");
    }
    throw new GatewayError("Artifact reference catalog changed repeatedly while it was being loaded.");
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

  getTerminalCapabilities(...args: Parameters<OperationApi["getTerminalCapabilities"]>) { return createTerminalGateway(this.requireTransport(), this.#abort?.signal).getTerminalCapabilities(...args); }
  listTerminals(...args: Parameters<OperationApi["listTerminals"]>) { return createTerminalGateway(this.requireTransport(), this.#abort?.signal).listTerminals(...args); }
  createTerminal(...args: Parameters<OperationApi["createTerminal"]>) { return createTerminalGateway(this.requireTransport(), this.#abort?.signal).createTerminal(...args); }
  getTerminal(...args: Parameters<OperationApi["getTerminal"]>) { return createTerminalGateway(this.requireTransport(), this.#abort?.signal).getTerminal(...args); }
  watchTerminal(...args: Parameters<OperationApi["watchTerminal"]>) { return createTerminalGateway(this.requireTransport(), this.#abort?.signal).watchTerminal(...args); }
  updateTerminalAppearance(...args: Parameters<OperationApi["updateTerminalAppearance"]>) { return createTerminalGateway(this.requireTransport(), this.#abort?.signal).updateTerminalAppearance(...args); }
  writeTerminal(...args: Parameters<OperationApi["writeTerminal"]>) { return createTerminalGateway(this.requireTransport(), this.#abort?.signal).writeTerminal(...args); }
  resizeTerminal(...args: Parameters<OperationApi["resizeTerminal"]>) { return createTerminalGateway(this.requireTransport(), this.#abort?.signal).resizeTerminal(...args); }
  restartTerminal(...args: Parameters<OperationApi["restartTerminal"]>) { return createTerminalGateway(this.requireTransport(), this.#abort?.signal).restartTerminal(...args); }
  closeTerminal(...args: Parameters<OperationApi["closeTerminal"]>) { return createTerminalGateway(this.requireTransport(), this.#abort?.signal).closeTerminal(...args); }

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

  async send(sessionId: string, draft: ComposerDraft, admission: { readonly expectedGeneration: bigint }): Promise<void> {
    const scope = this.captureActionScope();
    const expectedGeneration = admission.expectedGeneration;
    if (expectedGeneration < 1n || expectedGeneration > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new GatewayError("Input requires the source task generation.");
    }
    if (draft.extraDirectoryIds?.some((id) => id.length === 0) === true) {
      throw new GatewayError("Extra-directory selections must use non-empty IDs.");
    }
    const browserComments = draft.browserComments ?? [];
    if (browserComments.some((item) => item.screenshot.kind !== "image")) {
      throw new GatewayError("Page annotations contain an invalid screenshot set.");
    }
    const parts: Array<Record<string, unknown>> = [];
    const document = normalizeComposerDocument(draft.editorDocument, draft.text);
    const mentions = [...draft.mentions];
    if (mentions.some((mention) => mention.kind === "workspace" && !mention.workspaceId)) throw new GatewayError("A workspace mention requires its original workspace identity.");
    if (mentions.some((mention) => mention.kind === "artifact"
      && (!validSessionMentionId(mention.sourceSessionId) || !validResourceIdentityText(mention.reference)))) {
      throw new GatewayError("An Artifact mention requires its original task and object identity.");
    }
    const occurrences = normalizeComposerInlineMentionRanges(draft.inlineMentionRanges, composerDocumentPlainText(document), mentions);
    if (occurrences === undefined) throw new GatewayError("The task input has invalid mention occurrences.");
    const serialized = serializeComposerDocument(document, occurrences);
    const { text, bodyStart } = formatBrowserCommentsForSend(browserComments, serialized.text);
    const typedMentions = mentions.filter((mention) => mention.kind !== "message");
    const mentionIndices = new Map(typedMentions.map((mention, index) => [mention.id, index]));
    const mentionRanges = (serialized.mentionRanges ?? []).map((range) => ({
      start: bodyStart + range.start, end: bodyStart + range.end, mentionIndex: mentionIndices.get(range.mentionId)!
    }));
    if (mentionRanges.some((range) => !utf16Boundary(text, range.start) || !utf16Boundary(text, range.end)
      || serialized.pastedTextRanges?.some((pasted) => range.start < bodyStart + pasted.end && bodyStart + pasted.start < range.end))) {
      throw new GatewayError("The task input mention occurrence overlaps a structured text atom.");
    }
    if (text.length > 0) parts.push({ content: { case: "text", value: text } });
    for (const attachment of draft.attachments) {
      const blob = await this.uploadAttachment(attachment.file, scope);
      scope.signal.throwIfAborted();
      parts.push(attachment.kind === "image"
        ? { content: { case: "image", value: { blob, altText: attachment.file.name } } }
        : { content: { case: "file", value: blob } });
    }
    for (const mention of mentions) {
      if (mention.kind === "message") {
        parts.push({ content: { case: "text", value: messageMentionWireText(mention, window.location.href) } });
      } else if (mention.kind === "workspace") {
        parts.push({ content: { case: "workspaceMention", value: {
          workspaceId: mention.workspaceId ?? "", relativePath: mention.reference, displayText: mention.label,
          directory: mention.directory === true,
          ...(mention.lineRange === undefined ? {} : { lineRange: mention.lineRange })
        } } });
      } else if (mention.kind === "artifact") {
        parts.push({ content: { case: "artifactMention", value: {
          sourceSessionId: mention.sourceSessionId,
          artifactId: mention.reference,
          displayText: mention.label
        } } });
      } else if (mention.kind === "session") {
        if (!validSessionMentionId(mention.reference)) {
          throw new GatewayError("A task mention requires its exact task identity.");
        }
        parts.push({ content: { case: "sessionMention", value: { sessionId: mention.reference, displayText: mention.label } } });
      } else {
        if (!validResourceIdentityText(mention.reference)
          || !validResourceIdentityText(mention.discoveredRevision)
          || !validResourceVersionText(mention.resourceVersion)
          || !Number.isSafeInteger(mention.runtimeGeneration) || mention.runtimeGeneration < 1) {
          throw new GatewayError("A resource mention requires an exact runtime identity.");
        }
        const resourceVersion = BigInt(mention.resourceVersion);
        if (resourceVersion > 18_446_744_073_709_551_615n) {
          throw new GatewayError("A resource mention version exceeds the supported range.");
        }
        parts.push({ content: { case: "resourceMention", value: {
          resourceId: mention.reference,
          displayText: mention.label,
          discoveredRevision: mention.discoveredRevision,
          resourceVersion,
          runtimeGeneration: BigInt(mention.runtimeGeneration)
        } } });
      }
    }
    for (const item of browserComments) {
      const blob = await this.uploadAttachment(item.screenshot.file, scope);
      scope.signal.throwIfAborted();
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
            start: bodyStart + range.start,
            end: bodyStart + range.end,
            display: range.display
          })) ?? [],
          mentionRanges
        },
        deliveryMode: deliveryMode(draft.deliveryMode),
        ...(draft.extraDirectoryIds === undefined
          ? {}
          : { overrides: { extraDirectoryIds: [...new Set(draft.extraDirectoryIds)] } })
      }
    }, false, [{ entity: { kind: EntityKind.SESSION, id: sessionId }, expectedGeneration }], scope.signal);
  }

  async startReview(sourceSessionId: string, focus: string, attachments: readonly AttachmentDraft[]): Promise<string> {
    const scope = this.captureActionScope();
    // Snapshot this invocation before the first await. A later edit or file
    // picker action must never change what the accepted /review inspects.
    const sourceAttachments = [...attachments];
    const uploaded = await Promise.all(sourceAttachments.map(async (attachment) => ({
      kind: attachment.kind === "image" ? ReviewAttachmentKind.IMAGE : ReviewAttachmentKind.FILE,
      displayName: attachment.file.name,
      blob: await this.uploadAttachment(attachment.file, scope)
    })));
    scope.signal.throwIfAborted();
    const operation = await this.submit({
      case: "startReview",
      value: {
        sourceSessionId,
        focus: focus.trim(),
        attachments: uploaded
      }
    }, true, [], scope.signal);
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

  async prepareTargetWorkspace(targetId: string, expectedRevision: bigint, signal?: AbortSignal): Promise<void> {
    if (targetId.trim() === "" || typeof expectedRevision !== "bigint" || expectedRevision < 1n) {
      throw new GatewayError("A current Target identity and revision are required.");
    }
    const scope = this.captureActionScope(signal);
    const response = await createClient(TargetService, scope.transport).prepareTargetWorkspace({
      targetId,
      expectedTargetRevision: { value: expectedRevision }
    }, { signal: scope.signal });
    scope.signal.throwIfAborted();
    const workspace = response.workspace;
    if (workspace === undefined
      || workspace.targetId !== targetId
      || workspace.workspaceId === ""
      || workspace.version?.revision?.value !== expectedRevision) {
      throw new GatewayError("Orchestrator prepared a different project workspace revision.");
    }
  }

  async updateTarget(
    targetId: string,
    patch: {
      readonly name?: string;
      readonly pinned?: boolean;
      readonly workspaceLocation?:
        | { readonly kind: "remote"; readonly hostId: string; readonly workspaceRoot: string }
        | { readonly kind: "serviceNode" };
    },
    expectedRevision: bigint
  ): Promise<void> {
    if (typeof expectedRevision !== "bigint" || expectedRevision < 1n) {
      throw new GatewayError("A current Target revision is required.");
    }
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
    }, true, [{ entity: { kind: EntityKind.TARGET, id: targetId }, expectedRevision: { value: expectedRevision } }]);
  }

  async archiveTarget(targetId: string, archived: boolean): Promise<TargetView | undefined> {
    await this.submit({ case: "archiveTarget", value: { targetId, archived } }, true);
    // submit() schedules a refresh, but restoration needs the current catalogue
    // before a renderer may re-admit the project to its private filter. Joining
    // the in-flight refresh also covers an event-stream update that won the race.
    await this.refresh();
    return this.#snapshot?.targets.find((target) => target.id === targetId);
  }

  async deleteTarget(targetId: string, deleteManagedWorkspace: boolean): Promise<void> {
    await this.submit({ case: "deleteTarget", value: { targetId, deleteManagedWorkspace } }, true);
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

  async createSession(draft: NewSessionDraft): Promise<{ readonly sessionId: string; readonly generation: bigint }> {
    const targetId = draft.targetId;
    const target = this.#rawSnapshot?.targets.find((candidate) => candidate.targetId === targetId);
    if (target === undefined) throw new GatewayError("The selected target is no longer available.");
    const expectedTargetRevision = draft.expectedTargetRevision ?? target.version?.revision?.value;
    if (expectedTargetRevision === undefined || expectedTargetRevision < 1n) {
      throw new GatewayError("The selected target has no current revision.");
    }
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
    await this.prepareTargetWorkspace(targetId, expectedTargetRevision);
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
    }, true, [{
      entity: { kind: EntityKind.TARGET, id: targetId },
      expectedRevision: { value: expectedTargetRevision }
    }]);
    const payload = operation.result?.payload;
    if (payload?.case !== "session" || payload.value.sessionId.length === 0) {
      throw new GatewayError("Orchestrator completed task creation without a typed task result.");
    }
    const generation = payload.value.nativeBinding?.runtimeGeneration;
    if (generation === undefined || generation < 1n || generation > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new GatewayError("Orchestrator completed task creation without a valid task generation.");
    }
    return { sessionId: payload.value.sessionId, generation };
  }

  async discoverNativeSessions(targetId: string, signal?: AbortSignal): Promise<readonly NativeSessionCandidateView[]> {
    const client = createClient(SessionService, this.requireTransport());
    const requestSignal = combinedAbortSignal(signal, this.#abort?.signal);
    requestSignal?.throwIfAborted();
    const values: NativeSessionCandidateView[] = [];
    const consumedTokens = new Set<string>();
    let pageToken = "";
    for (let pageIndex = 0; pageIndex < MAX_COMPLETE_MESSAGE_SEARCH_PAGES; pageIndex += 1) {
      const response = await client.discoverNativeSessions(
        { targetId, page: { pageSize: 500, pageToken } },
        requestSignal === undefined ? undefined : { signal: requestSignal }
      );
      requestSignal?.throwIfAborted();
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

  async getSessionWorktreeRemovalPreview(
    sessionId: string,
    signal?: AbortSignal
  ): Promise<SessionWorktreeRemovalPreviewView> {
    const scope = this.captureActionScope(signal);
    const client = createClient(WorktreeService, scope.transport);
    const response = await client.getSessionWorktreeRemovalPreview(
      { sessionId },
      { signal: scope.signal }
    );
    scope.signal.throwIfAborted();
    if (response.sessionId !== sessionId || (!response.hasWorktree && response.dirty)) {
      throw new GatewayError("Orchestrator returned an invalid Worktree removal preview.");
    }
    return { hasWorktree: response.hasWorktree, dirty: response.dirty };
  }

  async exportSession(sessionId: string, context: ArtifactDownloadContext): Promise<ArtifactDownloadOutcome> {
    const ownedContext = this.artifactDownloadContext(context);
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
    ownedContext.signal.throwIfAborted();
    return this.downloadArtifact(blob.blobId, blob.fileName || payload.value.title || "session-export.html", ownedContext);
  }

  async exportPortableSession(
    sessionId: string,
    options: { readonly password?: string; readonly excludeMedia: boolean },
    context: ArtifactDownloadContext
  ): Promise<PortableSessionExportOutcomeView> {
    const ownedContext = this.artifactDownloadContext(context);
    const client = createClient(PortableSessionService, this.requireTransport());
    try {
      const response = await client.exportPortableSession({
        sessionId,
        ...(options.password === undefined ? {} : { password: options.password }),
        excludeMedia: options.excludeMedia
      }, { signal: ownedContext.signal });
      ownedContext.signal.throwIfAborted();
      const artifact = response.artifact;
      if (artifact === undefined || artifact.blobId.trim() === "") {
        throw new GatewayError("Orchestrator completed portable task export without an Artifact.");
      }
      if (artifact.mediaType.split(";", 1)[0]?.trim().toLowerCase() !== "application/vnd.joko.session") {
        throw new GatewayError("Orchestrator returned an invalid portable task Artifact.");
      }
      const saved = await this.downloadArtifact(artifact.blobId, artifact.fileName || "task.jshare", ownedContext);
      return saved !== "cancelled"
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
    const scope = this.captureActionScope();
    const client = createClient(PortableSessionService, scope.transport);
    try {
      const packageBlob = await this.uploadBlob(file, BlobDisposition.ATTACHMENT, scope);
      scope.signal.throwIfAborted();
      const response = await client.inspectPortableSessionImport(
        { package: packageBlob },
        { signal: scope.signal }
      );
      scope.signal.throwIfAborted();
      return mapPortableSessionImportDraft(response.draft);
    } catch (error) {
      scope.signal.throwIfAborted();
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
    target: import("./model.js").NativeNavigationTargetView,
    options: { readonly expectedGeneration: bigint; readonly summarize?: boolean; readonly customInstructions?: string }
  ): Promise<void> {
    if (options.expectedGeneration < 1n) throw new GatewayError("A source task generation is required for navigation.");
    const customInstructions = options.customInstructions?.trim().slice(0, 4_000) ?? "";
    await this.submit({
      case: "navigateSessionBranch",
      value: {
        sessionId,
        target: { kind: target.kind === "session_start" ? { case: "sessionStart", value: {} } : { case: "nativeEntryId", value: target.entryId } },
        summarize: options.summarize === true,
        customInstructions: options.summarize === true ? customInstructions : ""
      }
    }, true, [{ entity: { kind: EntityKind.SESSION, id: sessionId }, expectedGeneration: options.expectedGeneration }]);
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
    const scope = this.captureActionScope();
    const raw = this.#rawSnapshot?.interactions.find((candidate) => candidate.interactionId === interaction.id);
    if (raw === undefined) throw new GatewayError("This interaction is no longer pending.");
    const decision = await interactionDecision(raw, resolution);
    scope.signal.throwIfAborted();
    await this.submit({
      case: "resolveInteraction",
      value: {
        interactionId: interaction.id,
        interactionGeneration: interaction.generation,
        resolution: {
          connectionId: this.#profile?.id ?? "",
          decision
        }
      }
    }, false, [], scope.signal);
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

  async editQueueItem(queueItemId: string, edit: QueueItemTextEditView, mode: ComposerDraft["deliveryMode"], lockToken: string): Promise<void> {
    const existing = this.#rawSnapshot?.queueItems.find((item) => item.queueItemId === queueItemId);
    if (existing === undefined) throw new GatewayError("This queued input is no longer available.");
    const originalInput = requiredQueueInput(existing);
    const original = mapQueueItem(existing);
    const editorSource = queueItemEditProjection(original);
    const sameEdit = equalQueueItemTextEdit(edit, editorSource);
    if (sameEdit && mode === original.mode) return;
    const input = sameEdit
      ? originalInput
      : editedQueueInput(originalInput, edit);
    await this.submit({
      case: "editQueueItem",
      value: {
        queueItemId,
        input,
        deliveryMode: deliveryMode(mode),
        lockToken,
        textSplices: sameEdit ? [] : edit.textSplices.map((splice) => create(QueueTextEditSpliceSchema, splice))
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

  async steerQueueItemNow(queueItemId: string, lockToken: string): Promise<void> {
    const existing = this.#rawSnapshot?.queueItems.find((item) => item.queueItemId === queueItemId);
    if (existing === undefined) throw new GatewayError("This queued input is no longer available.");
    await this.submit({
      case: "editQueueItem",
      value: {
        queueItemId,
        input: requiredQueueInput(existing),
        deliveryMode: QueueDeliveryMode.STEER,
        lockToken
      }
    }, true, [queueItemPrecondition(existing)]);
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

  async openBrowserPage(
    browserId: string,
    sessionId: string,
    url: string,
    presentationTarget: BrowserSettingsView["automationTarget"],
    recoveryPageId = "",
    workspaceHtml?: { readonly workspaceId: string; readonly relativePath: string; readonly expectedRevision: string }
  ): Promise<string> {
    if (presentationTarget !== "sidebar" && presentationTarget !== "external") {
      throw new GatewayError("A Browser presentation target is required.");
    }
    if (workspaceHtml !== undefined && (url !== "" || recoveryPageId !== "" || workspaceHtml.expectedRevision === "")) {
      throw new GatewayError("HTML page opens require an exact file revision without a URL or recovery page.");
    }
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
        url: workspaceHtml === undefined ? durableBrowserTakeoverUrl(url) : "",
        expectedGeneration: browser.generation,
        presentationTarget: presentationTarget === "sidebar"
          ? BrowserAutomationTarget.SIDEBAR
          : BrowserAutomationTarget.EXTERNAL,
        currentPageId: takeover?.pageId ?? "",
        takeoverId: takeover?.takeoverId ?? "",
        recoveryPageId,
        ...(workspaceHtml === undefined ? {} : { workspaceHtml })
      }
    }, true);
    const payload = operation.result?.payload;
    if (payload?.case !== "browserTakeover" || payload.value.pageId.length === 0) {
      throw new GatewayError("Orchestrator completed the Browser page open without a page takeover.");
    }
    return payload.value.pageId;
  }

  async recoverBrowserPage(
    browserId: string,
    sessionId: string,
    pageId: string,
    url: string,
    presentationTarget: BrowserSettingsView["automationTarget"]
  ): Promise<string> {
    if (pageId.trim().length === 0) throw new GatewayError("A recoverable Browser page ID is required.");
    return this.openBrowserPage(browserId, sessionId, url, presentationTarget, pageId);
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
    const scope = this.captureActionScope();
    const blob = await this.uploadAttachment(file, scope);
    scope.signal.throwIfAborted();
    await this.submit({
      case: "uploadBrowserFile",
      value: { browserProviderId: browserId, pageId, blob, inputHint }
    }, true, [], scope.signal);
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

  async approveResource(resourceId: string, discoveredRevision: string): Promise<void> {
    if (discoveredRevision.length === 0) throw new GatewayError("The resource must be discovered before it can be approved.");
    await this.submit({
      case: "approveResource",
      value: { resourceId, discoveredRevision }
    }, true);
  }

  async discoverProjectResources(targetId: string): Promise<void> {
    await this.submit({ case: "discoverProjectResources", value: { targetId } }, true);
  }

  async addResource(draft: ResourceDraft): Promise<void> {
    const normalized = normalizeResourceDraft(draft);
    if (normalized === undefined) throw new GatewayError("The managed resource source is invalid.");
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

  async listSkills(options: {
    readonly query?: string;
    readonly backendId?: string;
    readonly targetId?: string;
    readonly scope?: SkillDescriptorView["scope"];
    readonly signal?: AbortSignal;
  } = {}): Promise<SkillCatalogView> {
    const scope = this.captureActionScope(options.signal);
    const client = createClient(SkillService, scope.transport);
    skillsCatalogAttempts:
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const skills: SkillDescriptorView[] = [];
      const identities = new Set<string>();
      const consumedTokens = new Set<string>();
      let pageToken = "";
      let revision: bigint | undefined;
      let totalSize: number | undefined;
      for (let pageIndex = 0; pageIndex < MAX_COMPLETE_MESSAGE_SEARCH_PAGES; pageIndex += 1) {
        scope.signal.throwIfAborted();
        const response = await client.listSkills({
          query: options.query ?? "",
          backendId: options.backendId ?? "",
          targetId: options.targetId ?? "",
          ...(options.scope === undefined ? {} : { scope: protoResourceScope(options.scope) }),
          page: { pageSize: 500, pageToken }
        }, { signal: scope.signal });
        const pageRevision = response.catalogRevision?.value;
        if (pageRevision === undefined) throw new GatewayError("The service returned Skills without a catalog revision.");
        if (revision === undefined) revision = pageRevision;
        else if (revision !== pageRevision) {
          if (attempt === 0) continue skillsCatalogAttempts;
          throw new GatewayError("Skills changed repeatedly while they were being loaded.");
        }
        const pageTotal = response.page === undefined ? undefined : exactSafeUnsignedNumber(response.page.totalSize);
        if (pageTotal === undefined) throw new GatewayError("The service returned an invalid Skill catalog size.");
        if (totalSize === undefined) totalSize = pageTotal;
        else if (totalSize !== pageTotal) throw new GatewayError("The service returned inconsistent Skill catalog sizes.");
        if (response.skills.length > 500 || skills.length + response.skills.length > pageTotal) {
          throw new GatewayError("The service returned an invalid Skill catalog page.");
        }
        for (const value of response.skills) {
          const mapped = mapSkillDescriptor(value);
          if (identities.has(mapped.id)) throw new GatewayError("The service returned a duplicate Skill identity.");
          identities.add(mapped.id);
          skills.push(mapped);
        }
        const nextPageToken = response.page?.nextPageToken ?? "";
        if (nextPageToken === "") {
          if (skills.length !== pageTotal) throw new GatewayError("The service returned an incomplete Skill catalog.");
          return { revision, skills };
        }
        if (nextPageToken === pageToken || consumedTokens.has(nextPageToken)) {
          throw new GatewayError("The service returned a cyclic Skill catalog page token.");
        }
        consumedTokens.add(nextPageToken);
        pageToken = nextPageToken;
      }
      throw new GatewayError("Skills exceeded the safe pagination limit.");
    }
    throw new GatewayError("Skills changed repeatedly while they were being loaded.");
  }

  async getSkillResourceUsageReport(
    resourceId: string,
    timeZone: string,
    signal?: AbortSignal
  ): Promise<ResourceUsageReportView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(SkillService, scope.transport).getSkillResourceUsageReport(
      { resourceId, timeZone },
      { signal: scope.signal }
    );
    if (response.report === undefined) throw new GatewayError("The service returned an empty Resource usage report.");
    return mapResourceUsageReport(response.report, resourceId, timeZone);
  }

  async openSkill(skillId: string, expectedRevision: bigint, signal?: AbortSignal): Promise<SkillSessionView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(SkillService, scope.transport).openSkill({
      skillId,
      expectedResourceRevision: { value: expectedRevision }
    }, { signal: scope.signal });
    if (response.skill === undefined) throw new GatewayError("The service returned an empty Skill session.");
    const session = mapSkillSession(response.skill);
    try {
      const files = await this.listSkillFiles(session.id, "", scope.signal);
      return { ...session, files };
    } catch (error) {
      void this.closeSkill(session.id).catch(() => undefined);
      throw error;
    }
  }

  async listSkillFiles(sessionId: string, parentKey = "", signal?: AbortSignal): Promise<readonly SkillFileEntryView[]> {
    const scope = this.captureActionScope(signal);
    const client = createClient(SkillService, scope.transport);
    const files: SkillFileEntryView[] = [];
    const keys = new Set<string>();
    const consumedTokens = new Set<string>();
    let pageToken = "";
    let totalSize: number | undefined;
    for (let pageIndex = 0; pageIndex < MAX_COMPLETE_MESSAGE_SEARCH_PAGES; pageIndex += 1) {
      scope.signal.throwIfAborted();
      const response = await client.listSkillFiles(
        { sessionId, parentKey, page: { pageSize: 500, pageToken } },
        { signal: scope.signal }
      );
      const pageTotal = response.page === undefined ? undefined : exactSafeUnsignedNumber(response.page.totalSize);
      if (pageTotal === undefined || pageTotal > 10_000 || (totalSize !== undefined && totalSize !== pageTotal)) {
        throw new GatewayError("The service returned an invalid Skill file-list size.");
      }
      totalSize = pageTotal;
      if (response.files.length > 500 || files.length + response.files.length > pageTotal) {
        throw new GatewayError("The service returned an invalid Skill file-list page.");
      }
      for (const value of response.files) {
        const mapped = mapSkillFileEntry(value);
        if (keys.has(mapped.key)) throw new GatewayError("The service returned a duplicate Skill file key.");
        keys.add(mapped.key);
        files.push(mapped);
      }
      const nextPageToken = response.page?.nextPageToken ?? "";
      if (nextPageToken === "") {
        if (files.length !== pageTotal) throw new GatewayError("The service returned an incomplete Skill file list.");
        return files;
      }
      if (nextPageToken === pageToken || consumedTokens.has(nextPageToken)) {
        throw new GatewayError("The service returned a cyclic Skill file-list page token.");
      }
      consumedTokens.add(nextPageToken);
      pageToken = nextPageToken;
    }
    throw new GatewayError("Skill files exceeded the safe pagination limit.");
  }

  async readSkillFile(sessionId: string, key: string, signal?: AbortSignal): Promise<SkillFileContentView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(SkillService, scope.transport).readSkillFile(
      { sessionId, key },
      { signal: scope.signal }
    );
    if (response.file === undefined) throw new GatewayError("The service returned an empty Skill file.");
    return mapSkillFileContent(response.file);
  }

  async getSkillDiff(sessionId: string, signal?: AbortSignal): Promise<SkillDiffView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(SkillService, scope.transport).getSkillDiff(
      { sessionId },
      { signal: scope.signal }
    );
    if (response.diff === undefined) throw new GatewayError("The service returned an empty Skill diff.");
    return mapSkillDiff(response.diff);
  }

  async prepareSkillFileEdit(
    sessionId: string,
    key: string,
    expectedFileRevision: string,
    content: string,
    signal?: AbortSignal
  ): Promise<SkillDraftView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(SkillService, scope.transport).prepareSkillFileEdit(
      { sessionId, key, expectedFileRevision, content },
      { signal: scope.signal }
    );
    if (response.draft === undefined) throw new GatewayError("The service returned an empty Skill draft.");
    return mapSkillDraft(response.draft);
  }

  async prepareSkillRename(sessionId: string, name: string, signal?: AbortSignal): Promise<SkillDraftView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(SkillService, scope.transport).prepareSkillRename(
      { sessionId, name },
      { signal: scope.signal }
    );
    if (response.draft === undefined) throw new GatewayError("The service returned an empty Skill rename draft.");
    return mapSkillDraft(response.draft);
  }

  async applySkillDraft(draft: SkillDraftView, signal?: AbortSignal): Promise<SkillMutationResultView> {
    const scope = this.captureActionScope(signal);
    return skillMutationResult(await this.submit(
      { case: "applySkillDraft", value: { draftId: draft.id } },
      true,
      [],
      scope.signal
    ));
  }

  async setSkillEnabled(skill: SkillDescriptorView, enabled: boolean, signal?: AbortSignal): Promise<SkillMutationResultView> {
    const scope = this.captureActionScope(signal);
    return skillMutationResult(await this.submit({
      case: "setSkillEnabled",
      value: { skillId: skill.id, expectedResourceRevision: { value: skill.revision }, enabled }
    }, true, [], scope.signal));
  }

  async deleteSkill(session: SkillSessionView, confirmation: string, signal?: AbortSignal): Promise<SkillMutationResultView> {
    const scope = this.captureActionScope(signal);
    return skillMutationResult(await this.submit({
      case: "deleteSkill",
      value: { sessionId: session.id, confirmation }
    }, true, [], scope.signal));
  }

  async listSkillRecoveries(signal?: AbortSignal): Promise<readonly SkillRecoveryView[]> {
    const scope = this.captureActionScope(signal);
    const client = createClient(SkillService, scope.transport);
    const recoveries: SkillRecoveryView[] = [];
    const ids = new Set<string>();
    const consumedTokens = new Set<string>();
    let pageToken = "";
    let totalSize: number | undefined;
    for (let pageIndex = 0; pageIndex < MAX_COMPLETE_MESSAGE_SEARCH_PAGES; pageIndex += 1) {
      scope.signal.throwIfAborted();
      const response = await client.listSkillRecoveries(
        { page: { pageSize: 500, pageToken } },
        { signal: scope.signal }
      );
      const pageTotal = response.page === undefined ? undefined : exactSafeUnsignedNumber(response.page.totalSize);
      if (pageTotal === undefined || (totalSize !== undefined && totalSize !== pageTotal)) {
        throw new GatewayError("The service returned an invalid Skill recovery-list size.");
      }
      totalSize = pageTotal;
      if (response.recoveries.length > 500 || recoveries.length + response.recoveries.length > pageTotal) {
        throw new GatewayError("The service returned an invalid Skill recovery-list page.");
      }
      for (const value of response.recoveries) {
        const mapped = mapSkillRecovery(value);
        if (ids.has(mapped.id)) throw new GatewayError("The service returned a duplicate Skill recovery.");
        ids.add(mapped.id);
        recoveries.push(mapped);
      }
      const nextPageToken = response.page?.nextPageToken ?? "";
      if (nextPageToken === "") {
        if (recoveries.length !== pageTotal) throw new GatewayError("The service returned an incomplete Skill recovery list.");
        return recoveries;
      }
      if (nextPageToken === pageToken || consumedTokens.has(nextPageToken)) {
        throw new GatewayError("The service returned a cyclic Skill recovery-list page token.");
      }
      consumedTokens.add(nextPageToken);
      pageToken = nextPageToken;
    }
    throw new GatewayError("Skill recoveries exceeded the safe pagination limit.");
  }

  async closeSkill(sessionId: string, signal?: AbortSignal): Promise<boolean> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(SkillService, scope.transport).closeSkill({ sessionId }, { signal: scope.signal });
    return response.closed;
  }

  async getSkillMarketGitPreflight(signal?: AbortSignal): Promise<SkillMarketGitPreflightView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(SkillService, scope.transport)
      .getSkillMarketGitPreflight({}, { signal: scope.signal });
    const preflight = response.preflight;
    if (preflight === undefined || preflight.minimumVersion.trim() === "") {
      throw new GatewayError("The service returned an incomplete Skill market Git preflight result.");
    }
    return {
      available: preflight.available,
      ...(preflight.version === undefined ? {} : { version: preflight.version }),
      minimumVersion: preflight.minimumVersion
    };
  }

  async listSkillMarketSources(signal?: AbortSignal): Promise<SkillMarketSourceCatalogView> {
    const scope = this.captureActionScope(signal);
    const client = createClient(SkillService, scope.transport);
    sourceCatalogAttempts:
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const sources: SkillMarketSourceView[] = [];
      const ids = new Set<string>();
      const consumedTokens = new Set<string>();
      let pageToken = "";
      let revision: bigint | undefined;
      let recoveredFromCorruption = false;
      let totalSize: number | undefined;
      for (let pageIndex = 0; pageIndex < MAX_COMPLETE_MESSAGE_SEARCH_PAGES; pageIndex += 1) {
        scope.signal.throwIfAborted();
        const response = await client.listSkillMarketSources(
          { page: { pageSize: 500, pageToken } },
          { signal: scope.signal }
        );
        const pageRevision = response.catalogRevision?.value;
        if (pageRevision === undefined) throw new GatewayError("The service returned Skill market sources without a catalog revision.");
        if (revision === undefined) {
          revision = pageRevision;
          recoveredFromCorruption = response.recoveredFromCorruption;
        } else if (revision !== pageRevision || recoveredFromCorruption !== response.recoveredFromCorruption) {
          if (attempt === 0) continue sourceCatalogAttempts;
          throw new GatewayError("Skill market sources changed repeatedly while they were being loaded.");
        }
        const pageTotal = response.page === undefined ? undefined : exactSafeUnsignedNumber(response.page.totalSize);
        if (pageTotal === undefined || (totalSize !== undefined && totalSize !== pageTotal)) {
          throw new GatewayError("The service returned an invalid Skill market source catalog size.");
        }
        totalSize = pageTotal;
        if (response.sources.length > 500 || sources.length + response.sources.length > pageTotal) {
          throw new GatewayError("The service returned an invalid Skill market source page.");
        }
        for (const value of response.sources) {
          const mapped = mapSkillMarketSource(value);
          if (ids.has(mapped.id)) throw new GatewayError("The service returned a duplicate Skill market source identity.");
          ids.add(mapped.id);
          sources.push(mapped);
        }
        const nextPageToken = response.page?.nextPageToken ?? "";
        if (nextPageToken === "") {
          if (sources.length !== pageTotal) throw new GatewayError("The service returned an incomplete Skill market source catalog.");
          return { revision, sources, recoveredFromCorruption };
        }
        if (nextPageToken === pageToken || consumedTokens.has(nextPageToken)) {
          throw new GatewayError("The service returned a cyclic Skill market source page token.");
        }
        consumedTokens.add(nextPageToken);
        pageToken = nextPageToken;
      }
      throw new GatewayError("Skill market sources exceeded the safe pagination limit.");
    }
    throw new GatewayError("Skill market sources changed repeatedly while they were being loaded.");
  }

  async addSkillMarketSource(
    source: SkillMarketSourceDraft,
    expectedCatalogRevision: bigint,
    signal?: AbortSignal
  ): Promise<void> {
    const scope = this.captureActionScope(signal);
    await this.submit({
      case: "addSkillMarketSource",
      value: {
        source: protoSkillMarketSource(source),
        expectedCatalogRevision: { value: expectedCatalogRevision }
      }
    }, true, [], scope.signal);
  }

  async refreshSkillMarketSource(sourceId: string, expectedRevision: bigint, signal?: AbortSignal): Promise<void> {
    const scope = this.captureActionScope(signal);
    await this.submit({
      case: "refreshSkillMarketSource",
      value: { sourceId, expectedRevision: { value: expectedRevision } }
    }, true, [], scope.signal);
  }

  async removeSkillMarketSource(sourceId: string, expectedRevision: bigint, signal?: AbortSignal): Promise<void> {
    const scope = this.captureActionScope(signal);
    await this.submit({
      case: "removeSkillMarketSource",
      value: { sourceId, expectedRevision: { value: expectedRevision } }
    }, true, [], scope.signal);
  }

  async listSkillMarketCatalog(options: {
    readonly expectedRevision?: bigint;
    readonly query?: string;
    readonly category?: string;
    readonly sort?: SkillMarketSortView;
    readonly pageToken?: string;
    readonly pageSize?: number;
    readonly signal?: AbortSignal;
  } = {}): Promise<SkillMarketCatalogPageView> {
    const scope = this.captureActionScope(options.signal);
    const pageSize = Math.min(Math.max(Math.trunc(options.pageSize ?? 24), 1), 100);
    const response = await createClient(SkillService, scope.transport).listSkillMarketCatalog({
      ...(options.expectedRevision === undefined ? {} : { expectedCatalogRevision: { value: options.expectedRevision } }),
      query: options.query?.trim() ?? "",
      category: options.category?.trim() ?? "",
      sort: protoSkillMarketSort(options.sort ?? "trending"),
      page: { pageSize, pageToken: options.pageToken ?? "" }
    }, { signal: scope.signal });
    const revision = response.catalogRevision?.value;
    const totalSize = response.page === undefined ? undefined : exactSafeUnsignedNumber(response.page.totalSize);
    if (revision === undefined || totalSize === undefined || response.sourceCount < 0 || !Number.isSafeInteger(response.sourceCount)
      || response.entries.length > pageSize || response.entries.length > totalSize) {
      throw new GatewayError("The service returned an invalid Skill market catalog page.");
    }
    const identities = new Set<string>();
    const entries = response.entries.map((value) => {
      const entry = mapSkillMarketEntry(value);
      const key = `${entry.identity.sourceId}\0${entry.identity.entryId}`;
      if (identities.has(key)) throw new GatewayError("The service returned a duplicate Skill market entry identity.");
      identities.add(key);
      return entry;
    });
    if (response.page?.nextPageToken === "" && entries.length > totalSize) {
      throw new GatewayError("The service returned an inconsistent Skill market catalog page.");
    }
    const categories = response.categories.map((value) => value.trim());
    if (categories.some((value) => value === "") || new Set(categories).size !== categories.length) {
      throw new GatewayError("The service returned invalid Skill market categories.");
    }
    return {
      revision,
      entries,
      categories,
      sourceCount: response.sourceCount,
      totalSize,
      ...(response.page?.nextPageToken ? { nextPageToken: response.page.nextPageToken } : {})
    };
  }

  async getSkillMarketEntry(identity: SkillMarketEntryIdentityView, signal?: AbortSignal): Promise<SkillMarketEntryView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(SkillService, scope.transport).getSkillMarketEntry(
      { identity: protoSkillMarketIdentity(identity) },
      { signal: scope.signal }
    );
    if (response.entry === undefined) throw new GatewayError("The service returned an empty Skill market entry.");
    return mapSkillMarketEntry(response.entry);
  }

  async openSkillMarketPreview(identity: SkillMarketEntryIdentityView, signal?: AbortSignal): Promise<SkillMarketPreviewView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(SkillService, scope.transport).openSkillMarketPreview(
      { identity: protoSkillMarketIdentity(identity) },
      { signal: scope.signal }
    );
    if (response.preview === undefined) throw new GatewayError("The service returned an empty Skill market preview.");
    return mapSkillMarketPreview(response.preview);
  }

  async listSkillMarketPreviewFiles(
    preview: SkillMarketPreviewView,
    pageToken = "",
    pageSize = 100,
    signal?: AbortSignal
  ): Promise<SkillMarketArchivePageView> {
    const scope = this.captureActionScope(signal);
    const size = Math.min(Math.max(Math.trunc(pageSize), 1), 500);
    const response = await createClient(SkillService, scope.transport).listSkillMarketPreviewFiles({
      previewId: preview.id,
      expectedSnapshotRevision: preview.snapshotRevision,
      page: { pageSize: size, pageToken }
    }, { signal: scope.signal });
    const totalSize = response.page === undefined ? undefined : exactSafeUnsignedNumber(response.page.totalSize);
    if (response.snapshotRevision !== preview.snapshotRevision || totalSize === undefined
      || response.files.length > size || response.files.length > totalSize) {
      throw new GatewayError("The service returned an invalid Skill market preview file page.");
    }
    const keys = new Set<string>();
    const files = response.files.map((value) => {
      const file = mapSkillMarketArchiveEntry(value);
      if (keys.has(file.key)) throw new GatewayError("The service returned a duplicate Skill market preview file key.");
      keys.add(file.key);
      return file;
    });
    return {
      snapshotRevision: response.snapshotRevision,
      files,
      totalSize,
      ...(response.page?.nextPageToken ? { nextPageToken: response.page.nextPageToken } : {})
    };
  }

  async readSkillMarketPreviewFile(
    preview: SkillMarketPreviewView,
    key: string,
    signal?: AbortSignal
  ): Promise<SkillMarketPreviewFileView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(SkillService, scope.transport).readSkillMarketPreviewFile({
      previewId: preview.id,
      expectedSnapshotRevision: preview.snapshotRevision,
      key
    }, { signal: scope.signal });
    if (response.file === undefined) throw new GatewayError("The service returned an empty Skill market preview file.");
    return mapSkillMarketPreviewFile(response.file, preview);
  }

  async closeSkillMarketPreview(previewId: string, signal?: AbortSignal): Promise<boolean> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(SkillService, scope.transport).closeSkillMarketPreview(
      { previewId },
      { signal: scope.signal }
    );
    return response.closed;
  }

  async createSkillMarketInstallPlan(
    identity: SkillMarketEntryIdentityView,
    target: SkillMarketInstallTargetView,
    signal?: AbortSignal
  ): Promise<SkillMarketInstallPlanView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(SkillService, scope.transport).createSkillMarketInstallPlan({
      identity: protoSkillMarketIdentity(identity),
      target: protoSkillMarketInstallTarget(target)
    }, { signal: scope.signal });
    if (response.plan === undefined) throw new GatewayError("The service returned an empty Skill market install plan.");
    return mapSkillMarketInstallPlan(response.plan);
  }

  async getSkillMarketInstallPlan(planId: string, signal?: AbortSignal): Promise<SkillMarketInstallPlanView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(SkillService, scope.transport).getSkillMarketInstallPlan(
      { planId },
      { signal: scope.signal }
    );
    if (response.plan === undefined) throw new GatewayError("The service returned an empty Skill market install plan.");
    return mapSkillMarketInstallPlan(response.plan);
  }

  async closeSkillMarketInstallPlan(planId: string, signal?: AbortSignal): Promise<boolean> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(SkillService, scope.transport).closeSkillMarketInstallPlan(
      { planId },
      { signal: scope.signal }
    );
    return response.closed;
  }

  async installSkillMarketPlan(
    plan: SkillMarketInstallPlanView,
    confirmReplacement: boolean,
    signal?: AbortSignal
  ): Promise<SkillMutationResultView> {
    const scope = this.captureActionScope(signal);
    return skillMutationResult(await this.submit({
      case: "installSkillMarketPlan",
      value: {
        planId: plan.id,
        expectedCandidateRevision: plan.preview.candidateRevision,
        confirmReplacement
      }
    }, true, [], scope.signal));
  }

  async listSkillMarketSyncPolicies(signal?: AbortSignal): Promise<SkillMarketSyncCatalogView<SkillMarketSyncPolicyView>> {
    const scope = this.captureActionScope(signal);
    const client = createClient(SkillService, scope.transport);
    const items: SkillMarketSyncPolicyView[] = [];
    const identities = new Set<string>();
    const consumedTokens = new Set<string>();
    let pageToken = "";
    let totalSize: number | undefined;
    let recoveredFromCorruption: boolean | undefined;
    for (let pageIndex = 0; pageIndex < MAX_COMPLETE_MESSAGE_SEARCH_PAGES; pageIndex += 1) {
      const response = await client.listSkillMarketSyncPolicies(
        { page: { pageSize: 500, pageToken } },
        { signal: scope.signal }
      );
      const pageTotal = response.page === undefined ? undefined : exactSafeUnsignedNumber(response.page.totalSize);
      if (pageTotal === undefined || (totalSize !== undefined && totalSize !== pageTotal)
        || (recoveredFromCorruption !== undefined && recoveredFromCorruption !== response.recoveredFromCorruption)) {
        throw new GatewayError("The service returned an inconsistent Skill market sync policy page.");
      }
      totalSize = pageTotal;
      recoveredFromCorruption = response.recoveredFromCorruption;
      for (const value of response.policies) {
        const mapped = mapSkillMarketSyncPolicy(value);
        if (identities.has(mapped.resourceId)) throw new GatewayError("The service returned a duplicate Skill market sync policy.");
        identities.add(mapped.resourceId);
        items.push(mapped);
      }
      if (items.length > pageTotal) throw new GatewayError("The service returned too many Skill market sync policies.");
      const next = response.page?.nextPageToken ?? "";
      if (next === "") {
        if (items.length !== pageTotal) throw new GatewayError("The service returned an incomplete Skill market sync policy catalog.");
        return { items, recoveredFromCorruption: recoveredFromCorruption ?? false };
      }
      if (next === pageToken || consumedTokens.has(next)) throw new GatewayError("The service returned a cyclic Skill market sync policy page token.");
      consumedTokens.add(next);
      pageToken = next;
    }
    throw new GatewayError("Skill market sync policies exceeded the safe pagination limit.");
  }

  async listSkillMarketSyncJobs(
    resourceId?: string,
    signal?: AbortSignal
  ): Promise<SkillMarketSyncCatalogView<SkillMarketSyncJobView>> {
    const scope = this.captureActionScope(signal);
    const client = createClient(SkillService, scope.transport);
    const items: SkillMarketSyncJobView[] = [];
    const identities = new Set<string>();
    const consumedTokens = new Set<string>();
    let pageToken = "";
    let totalSize: number | undefined;
    let recoveredFromCorruption: boolean | undefined;
    for (let pageIndex = 0; pageIndex < MAX_COMPLETE_MESSAGE_SEARCH_PAGES; pageIndex += 1) {
      const response = await client.listSkillMarketSyncJobs({
        ...(resourceId === undefined ? {} : { resourceId }),
        page: { pageSize: 500, pageToken }
      }, { signal: scope.signal });
      const pageTotal = response.page === undefined ? undefined : exactSafeUnsignedNumber(response.page.totalSize);
      if (pageTotal === undefined || (totalSize !== undefined && totalSize !== pageTotal)
        || (recoveredFromCorruption !== undefined && recoveredFromCorruption !== response.recoveredFromCorruption)) {
        throw new GatewayError("The service returned an inconsistent Skill market sync job page.");
      }
      totalSize = pageTotal;
      recoveredFromCorruption = response.recoveredFromCorruption;
      for (const value of response.jobs) {
        const mapped = mapSkillMarketSyncJob(value);
        if ((resourceId !== undefined && mapped.policyResourceId !== resourceId) || identities.has(mapped.id)) {
          throw new GatewayError("The service returned an invalid Skill market sync job identity.");
        }
        identities.add(mapped.id);
        items.push(mapped);
      }
      if (items.length > pageTotal) throw new GatewayError("The service returned too many Skill market sync jobs.");
      const next = response.page?.nextPageToken ?? "";
      if (next === "") {
        if (items.length !== pageTotal) throw new GatewayError("The service returned an incomplete Skill market sync job catalog.");
        return { items, recoveredFromCorruption: recoveredFromCorruption ?? false };
      }
      if (next === pageToken || consumedTokens.has(next)) throw new GatewayError("The service returned a cyclic Skill market sync job page token.");
      consumedTokens.add(next);
      pageToken = next;
    }
    throw new GatewayError("Skill market sync jobs exceeded the safe pagination limit.");
  }

  async getSkillMarketSyncJob(jobId: string, signal?: AbortSignal): Promise<SkillMarketSyncJobView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(SkillService, scope.transport).getSkillMarketSyncJob(
      { jobId },
      { signal: scope.signal }
    );
    if (response.job === undefined) throw new GatewayError("The service returned an empty Skill market sync job.");
    return mapSkillMarketSyncJob(response.job);
  }

  async enableSkillMarketSync(
    resourceId: string,
    expectedResourceRevision: bigint,
    target: SkillMarketInstallTargetView,
    signal?: AbortSignal
  ): Promise<void> {
    const scope = this.captureActionScope(signal);
    await this.submit({
      case: "enableSkillMarketSync",
      value: { resourceId, expectedResourceRevision: { value: expectedResourceRevision }, target: protoSkillMarketInstallTarget(target) }
    }, true, [], scope.signal);
  }

  async disableSkillMarketSync(policy: SkillMarketSyncPolicyView, signal?: AbortSignal): Promise<void> {
    const scope = this.captureActionScope(signal);
    await this.submit({
      case: "disableSkillMarketSync",
      value: { resourceId: policy.resourceId, expectedPolicyRevision: { value: policy.revision } }
    }, true, [], scope.signal);
  }

  async enqueueSkillMarketSync(policy: SkillMarketSyncPolicyView, signal?: AbortSignal): Promise<void> {
    const scope = this.captureActionScope(signal);
    await this.submit({
      case: "enqueueSkillMarketSync",
      value: { resourceId: policy.resourceId, expectedPolicyRevision: { value: policy.revision } }
    }, true, [], scope.signal);
  }

  async cancelSkillMarketSync(job: SkillMarketSyncJobView, signal?: AbortSignal): Promise<void> {
    const scope = this.captureActionScope(signal);
    await this.submit({
      case: "cancelSkillMarketSync",
      value: { jobId: job.id, expectedRevision: { value: job.revision } }
    }, true, [], scope.signal);
  }

  async retrySkillMarketSync(job: SkillMarketSyncJobView, signal?: AbortSignal): Promise<void> {
    const scope = this.captureActionScope(signal);
    await this.submit({
      case: "retrySkillMarketSync",
      value: { jobId: job.id, expectedRevision: { value: job.revision } }
    }, true, [], scope.signal);
  }

  async getSkillPublicationPreview(
    resourceId: string,
    expectedResourceRevision: bigint,
    sourceId: string,
    expectedSourceRevision: bigint,
    slug?: string,
    signal?: AbortSignal
  ): Promise<SkillPublicationPreviewView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(SkillService, scope.transport).getSkillPublicationPreview({
      resourceId,
      expectedResourceRevision: { value: expectedResourceRevision },
      sourceId,
      expectedSourceRevision: { value: expectedSourceRevision },
      ...(slug === undefined ? {} : { slug })
    }, { signal: scope.signal });
    if (response.preview === undefined) throw new GatewayError("The service returned an empty Skill publication preview.");
    return mapSkillPublicationPreview(response.preview);
  }

  async listSkillPublicationJobs(
    resourceId?: string,
    signal?: AbortSignal
  ): Promise<SkillMarketSyncCatalogView<SkillPublicationJobView>> {
    const scope = this.captureActionScope(signal);
    const client = createClient(SkillService, scope.transport);
    const items: SkillPublicationJobView[] = [];
    const identities = new Set<string>();
    const consumedTokens = new Set<string>();
    let pageToken = "";
    let totalSize: number | undefined;
    let recoveredFromCorruption: boolean | undefined;
    for (let pageIndex = 0; pageIndex < MAX_COMPLETE_MESSAGE_SEARCH_PAGES; pageIndex += 1) {
      const response = await client.listSkillPublicationJobs({
        ...(resourceId === undefined ? {} : { resourceId }),
        page: { pageSize: 500, pageToken }
      }, { signal: scope.signal });
      const pageTotal = response.page === undefined ? undefined : exactSafeUnsignedNumber(response.page.totalSize);
      if (pageTotal === undefined || (totalSize !== undefined && totalSize !== pageTotal)
        || (recoveredFromCorruption !== undefined && recoveredFromCorruption !== response.recoveredFromCorruption)) {
        throw new GatewayError("The service returned an inconsistent Skill publication page.");
      }
      totalSize = pageTotal;
      recoveredFromCorruption = response.recoveredFromCorruption;
      for (const value of response.jobs) {
        const mapped = mapSkillPublicationJob(value);
        if ((resourceId !== undefined && mapped.authority.resourceId !== resourceId) || identities.has(mapped.id)) {
          throw new GatewayError("The service returned an invalid Skill publication identity.");
        }
        identities.add(mapped.id);
        items.push(mapped);
      }
      if (items.length > pageTotal) throw new GatewayError("The service returned too many Skill publication jobs.");
      const next = response.page?.nextPageToken ?? "";
      if (next === "") {
        if (items.length !== pageTotal) throw new GatewayError("The service returned an incomplete Skill publication catalog.");
        return { items, recoveredFromCorruption: recoveredFromCorruption ?? false };
      }
      if (next === pageToken || consumedTokens.has(next)) throw new GatewayError("The service returned a cyclic Skill publication page token.");
      consumedTokens.add(next);
      pageToken = next;
    }
    throw new GatewayError("Skill publications exceeded the safe pagination limit.");
  }

  async getSkillPublicationJob(jobId: string, signal?: AbortSignal): Promise<SkillPublicationJobView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(SkillService, scope.transport).getSkillPublicationJob(
      { jobId },
      { signal: scope.signal }
    );
    if (response.job === undefined) throw new GatewayError("The service returned an empty Skill publication job.");
    return mapSkillPublicationJob(response.job);
  }

  async getCollaborationDirectory(signal?: AbortSignal): Promise<CollaborationDirectoryView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(SkillService, scope.transport).getCollaborationDirectory({}, { signal: scope.signal });
    if (response.directory === undefined) throw new GatewayError("The service returned an empty collaboration directory.");
    return mapCollaborationDirectory(response.directory);
  }

  async createCollaborationScope(
    kind: CollaborationScopeKindView,
    name: string,
    expectedCatalogRevision: bigint,
    signal?: AbortSignal
  ): Promise<void> {
    const scope = this.captureActionScope(signal);
    await this.submit({
      case: "createCollaborationScope",
      value: {
        expectedCatalogRevision: { value: expectedCatalogRevision },
        kind: protoCollaborationScopeKind(kind),
        name
      }
    }, true, [], scope.signal);
  }

  async updateCollaborationScope(scopeValue: CollaborationScopeView, name: string, signal?: AbortSignal): Promise<void> {
    const scope = this.captureActionScope(signal);
    await this.submit({
      case: "updateCollaborationScope",
      value: { scopeId: scopeValue.id, expectedRevision: { value: scopeValue.revision }, name }
    }, true, [], scope.signal);
  }

  async deleteCollaborationScope(scopeValue: CollaborationScopeView, signal?: AbortSignal): Promise<void> {
    const scope = this.captureActionScope(signal);
    await this.submit({
      case: "deleteCollaborationScope",
      value: { scopeId: scopeValue.id, expectedRevision: { value: scopeValue.revision } }
    }, true, [], scope.signal);
  }

  async updateSkillMarketAccess(
    entry: SkillMarketEntryView,
    collaborationRevision: bigint,
    selection: SkillPublicationAccessSelectionView,
    signal?: AbortSignal
  ): Promise<void> {
    const scope = this.captureActionScope(signal);
    await this.submit({
      case: "updateSkillMarketAccess",
      value: {
        identity: protoSkillMarketIdentity(entry.identity),
        expectedAccessRevision: { value: entry.access.revision },
        expectedCollaborationRevision: { value: collaborationRevision },
        publisher: protoSkillPublicationPublisher(selection.publisher),
        ...(selection.publisherScopeId === undefined ? {} : { publisherScopeId: selection.publisherScopeId }),
        visibility: protoSkillPublicationVisibility(selection.visibility),
        audienceScopeIds: [...selection.audienceScopeIds]
      }
    }, true, [], scope.signal);
  }

  async startSkillPublication(
    preview: SkillPublicationPreviewView,
    metadata: SkillPublicationMetadataView,
    access: SkillPublicationAccessSelectionView,
    signal?: AbortSignal
  ): Promise<void> {
    const scope = this.captureActionScope(signal);
    const authority = preview.authority;
    await this.submit({
      case: "startSkillPublication",
      value: {
        resourceId: authority.resourceId,
        expectedResourceRevision: { value: authority.resourceRevision },
        expectedObservedRevision: authority.observedRevision,
        sourceId: authority.sourceId,
        expectedSourceRevision: { value: authority.sourceRevision },
        expectedSourceContentRevision: authority.sourceContentRevision,
        ...(authority.existingEntryId === undefined ? {} : { expectedExistingEntryId: authority.existingEntryId }),
        expectedCollaborationRevision: { value: preview.collaborationRevision },
        metadata: protoSkillPublicationMetadata(metadata),
        publisher: protoSkillPublicationPublisher(access.publisher),
        ...(access.publisherScopeId === undefined ? {} : { publisherScopeId: access.publisherScopeId }),
        visibility: protoSkillPublicationVisibility(access.visibility),
        audienceScopeIds: [...access.audienceScopeIds]
      }
    }, true, [], scope.signal);
  }

  async cancelSkillPublication(job: SkillPublicationJobView, signal?: AbortSignal): Promise<void> {
    const scope = this.captureActionScope(signal);
    await this.submit({
      case: "cancelSkillPublication",
      value: { jobId: job.id, expectedRevision: { value: job.revision } }
    }, true, [], scope.signal);
  }

  async retrySkillPublication(job: SkillPublicationJobView, signal?: AbortSignal): Promise<void> {
    const scope = this.captureActionScope(signal);
    await this.submit({
      case: "retrySkillPublication",
      value: { jobId: job.id, expectedRevision: { value: job.revision } }
    }, true, [], scope.signal);
  }

  async listCommands(sessionId: string): Promise<readonly RuntimeCommandView[]> {
    const client = createClient(SessionService, this.requireTransport());
    const response = await client.listRuntimeCommands({ sessionId }, this.#abort === undefined ? undefined : { signal: this.#abort.signal });
    return response.commands.map(mapRuntimeCommand);
  }

  async listSessionResources(sessionId: string, signal?: AbortSignal): Promise<readonly SessionResourceView[]> {
    const client = createClient(SessionService, this.requireTransport());
    const requestSignal = combinedAbortSignal(signal, this.#abort?.signal);
    const response = await client.listSessionResources(
      { sessionId },
      requestSignal === undefined ? undefined : { signal: requestSignal }
    );
    return response.resources.map((resource) => mapSessionResource(resource, sessionId));
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

  async getUsageReport(query: UsageReportQueryView, signal: AbortSignal): Promise<UsageReportView> {
    const client = createClient(BackendService, this.requireTransport());
    const requestSignal = this.#abort === undefined ? signal : AbortSignal.any([signal, this.#abort.signal]);
    requestSignal.throwIfAborted();
    const group = { task: UsageReportGroup.TASK, model: UsageReportGroup.MODEL,
      provider: UsageReportGroup.PROVIDER, backend: UsageReportGroup.BACKEND }[query.group];
    const response = await client.getUsageReport({ ...query, group,
      page: { pageSize: 25, pageToken: query.pageToken ?? "" } }, { signal: requestSignal });
    requestSignal.throwIfAborted();
    if (response.summary === undefined || response.page === undefined) throw new GatewayError("Joko returned an incomplete usage report.");
    const totalGroups = Number(response.page.totalSize);
    if (!Number.isSafeInteger(totalGroups) || totalGroups < 0 || response.entries.length > 25) throw new GatewayError("Joko returned an invalid usage report page.");
    const keys = new Set<string>();
    return { summary: mapUsageSummary(response.summary), totalGroups, nextPageToken: response.page.nextPageToken,
      entries: response.entries.map((entry) => {
        if (entry.key === "" || keys.has(entry.key) || entry.summary === undefined || entry.measuredAt === undefined
          || (entry.referenceAvailable && entry.sessionId === "")) throw new GatewayError("Joko returned an invalid usage report entry.");
        keys.add(entry.key);
        return { key: entry.key, sessionId: entry.sessionId, backendId: entry.backendId, providerId: entry.providerId,
          modelId: entry.modelId, title: entry.title, referenceAvailable: entry.referenceAvailable,
          summary: mapUsageSummary(entry.summary), measuredAt: timestampMs(entry.measuredAt) };
      }) };
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

  async listExtensions(options: {
    readonly source?: ExtensionCatalogEntryView["source"];
    readonly installed?: boolean;
    readonly query?: string;
    readonly sessionId?: string;
    readonly signal?: AbortSignal;
  } = {}): Promise<ExtensionCatalogView> {
    const scope = this.captureActionScope(options.signal);
    const client = createClient(ExtensionService, scope.transport);
    extensionCatalogAttempts:
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const extensions: ExtensionCatalogEntryView[] = [];
      const ids = new Set<string>();
      const consumedTokens = new Set<string>();
      let pageToken = "";
      let revision: bigint | undefined;
      let recoveredFromCorruption = false;
      let totalSize: number | undefined;
      for (let pageIndex = 0; pageIndex < MAX_COMPLETE_MESSAGE_SEARCH_PAGES; pageIndex += 1) {
        scope.signal.throwIfAborted();
        const response = await client.listExtensions({
          ...(options.source === undefined ? {} : {
            source: options.source === "local" ? ProtoExtensionCatalogSource.LOCAL : ProtoExtensionCatalogSource.MARKET
          }),
          ...(options.installed === undefined ? {} : { installed: options.installed }),
          query: options.query ?? "",
          ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
          page: { pageSize: 500, pageToken }
        }, { signal: scope.signal });
        const pageRevision = response.catalogRevision?.value;
        if (pageRevision === undefined) throw new GatewayError("Orchestrator returned an Extension catalog without its revision.");
        if (revision === undefined) {
          revision = pageRevision;
          recoveredFromCorruption = response.recoveredFromCorruption;
        } else if (revision !== pageRevision || recoveredFromCorruption !== response.recoveredFromCorruption) {
          if (attempt === 0) continue extensionCatalogAttempts;
          throw new GatewayError("Extension catalog changed repeatedly while it was being loaded.");
        }
        const pageTotal = response.page === undefined ? undefined : exactSafeUnsignedNumber(response.page.totalSize);
        if (pageTotal === undefined) throw new GatewayError("Orchestrator returned an invalid Extension catalog size.");
        if (totalSize === undefined) totalSize = pageTotal;
        else if (totalSize !== pageTotal) throw new GatewayError("Orchestrator returned inconsistent Extension catalog sizes.");
        if (response.extensions.length > 500 || extensions.length + response.extensions.length > pageTotal) {
          throw new GatewayError("Orchestrator returned an invalid Extension catalog page.");
        }
        for (const value of response.extensions) {
          const mapped = mapExtensionCatalogEntry(value);
          if (ids.has(mapped.id)) throw new GatewayError("Orchestrator returned a duplicate Extension identity.");
          ids.add(mapped.id);
          extensions.push(mapped);
        }
        const nextPageToken = response.page?.nextPageToken ?? "";
        if (nextPageToken === "") {
          if (extensions.length !== pageTotal) throw new GatewayError("Orchestrator returned an incomplete Extension catalog.");
          return { revision, extensions, recoveredFromCorruption };
        }
        if (nextPageToken === pageToken || consumedTokens.has(nextPageToken)) {
          throw new GatewayError("Orchestrator returned a cyclic Extension catalog page token.");
        }
        consumedTokens.add(nextPageToken);
        pageToken = nextPageToken;
      }
      throw new GatewayError("Extension catalog exceeded the safe pagination limit.");
    }
    throw new GatewayError("Extension catalog changed repeatedly while it was being loaded.");
  }

  async getExtension(extensionId: string, sessionId?: string, signal?: AbortSignal): Promise<ExtensionCatalogView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(ExtensionService, scope.transport).getExtension({
      extensionId,
      ...(sessionId === undefined ? {} : { sessionId })
    }, { signal: scope.signal });
    if (response.extension === undefined || response.catalogRevision?.value === undefined) {
      throw new GatewayError("Orchestrator returned an incomplete Extension detail.");
    }
    return {
      revision: response.catalogRevision.value,
      extensions: [mapExtensionCatalogEntry(response.extension)],
      recoveredFromCorruption: response.recoveredFromCorruption
    };
  }

  async openExtensionMainView(
    extensionId: string,
    expectedRevision: bigint,
    signal?: AbortSignal
  ): Promise<ExtensionMainViewSurfaceView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(ExtensionService, scope.transport).openExtensionMainView({
      extensionId,
      expectedRevision: { value: expectedRevision }
    }, { signal: scope.signal });
    if (response.surface === undefined) throw new GatewayError("Orchestrator returned an empty Extension main view.");
    return mapExtensionMainViewSurface(response.surface);
  }

  async getExtensionMainViewSurface(surfaceId: string, signal?: AbortSignal): Promise<ExtensionMainViewSurfaceView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(ExtensionService, scope.transport).getExtensionMainViewSurface(
      { surfaceId },
      { signal: scope.signal }
    );
    if (response.surface === undefined) throw new GatewayError("Orchestrator returned an empty Extension main-view probe.");
    return mapExtensionMainViewSurface(response.surface);
  }

  async closeExtensionMainView(surfaceId: string, signal?: AbortSignal): Promise<boolean> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(ExtensionService, scope.transport).closeExtensionMainView(
      { surfaceId },
      { signal: scope.signal }
    );
    return response.closed;
  }

  async getExtensionLibraryOverview(
    extensionId: string,
    expectedRevision: bigint,
    signal?: AbortSignal
  ): Promise<ExtensionLibraryOverviewView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(ExtensionService, scope.transport).getExtensionLibraryOverview({
      extensionId,
      expectedRevision: { value: expectedRevision }
    }, { signal: scope.signal });
    if (response.library === undefined) throw new GatewayError("Orchestrator returned an empty Extension Library overview.");
    return mapExtensionLibraryOverview(response.library);
  }

  async validateExtensionLibraryLocation(
    extensionId: string,
    expectedRevision: bigint,
    candidate: string,
    signal?: AbortSignal
  ): Promise<ExtensionLibraryLocationValidationView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(ExtensionService, scope.transport).validateExtensionLibraryLocation({
      extensionId,
      expectedRevision: { value: expectedRevision },
      candidate
    }, { signal: scope.signal });
    if (response.validation === undefined) throw new GatewayError("Orchestrator returned an empty Extension Library location validation.");
    return {
      libraryRoot: response.validation.libraryRoot,
      warnings: [...response.validation.warnings],
      ...(response.validation.diskFreeBytes === undefined ? {} : { diskFreeBytes: response.validation.diskFreeBytes })
    };
  }

  async relocateExtensionLibrary(
    extensionId: string,
    expectedRevision: bigint,
    destination: { readonly kind: "default" } | { readonly kind: "custom"; readonly candidate: string },
    signal?: AbortSignal
  ): Promise<{ readonly changed: boolean; readonly migrationId?: string; readonly location: ExtensionLibraryLocationView; readonly files: number; readonly bytes: bigint; readonly warnings: readonly string[]; readonly graceId?: string }> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(ExtensionService, scope.transport).relocateExtensionLibrary({
      extensionId,
      expectedRevision: { value: expectedRevision },
      destinationKind: destination.kind === "default"
        ? ProtoExtensionLibraryLocationKind.DEFAULT
        : ProtoExtensionLibraryLocationKind.CUSTOM,
      ...(destination.kind === "custom" ? { candidate: destination.candidate } : {})
    }, { signal: scope.signal });
    if (response.location === undefined) throw new GatewayError("Orchestrator returned an incomplete Extension Library relocation.");
    return {
      changed: response.changed,
      ...(response.migrationId === undefined ? {} : { migrationId: response.migrationId }),
      location: mapExtensionLibraryLocation(response.location),
      files: response.files,
      bytes: response.bytes,
      warnings: [...response.warnings],
      ...(response.graceId === undefined ? {} : { graceId: response.graceId })
    };
  }

  async rebindExtensionLibrary(
    extensionId: string,
    expectedRevision: bigint,
    candidate: string,
    signal?: AbortSignal
  ): Promise<{ readonly location: ExtensionLibraryLocationView; readonly warnings: readonly string[] }> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(ExtensionService, scope.transport).rebindExtensionLibrary({
      extensionId,
      expectedRevision: { value: expectedRevision },
      candidate
    }, { signal: scope.signal });
    if (response.location === undefined) throw new GatewayError("Orchestrator returned an incomplete Extension Library rebind.");
    return { location: mapExtensionLibraryLocation(response.location), warnings: [...response.warnings] };
  }

  async unbindExtensionLibrary(
    extensionId: string,
    expectedRevision: bigint,
    signal?: AbortSignal
  ): Promise<{ readonly detachedPath?: string }> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(ExtensionService, scope.transport).unbindExtensionLibrary({
      extensionId,
      expectedRevision: { value: expectedRevision }
    }, { signal: scope.signal });
    return { ...(response.detachedPath === undefined ? {} : { detachedPath: response.detachedPath }) };
  }

  async repairExtensionLibraryState(signal?: AbortSignal): Promise<{ readonly recoveredFromPrevious: boolean; readonly bindings: number; readonly trash: number }> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(ExtensionService, scope.transport).repairExtensionLibraryState({}, { signal: scope.signal });
    return { recoveredFromPrevious: response.recoveredFromPrevious, bindings: response.bindings, trash: response.trash };
  }

  async repairExtensionLibraryMetadata(
    extensionId: string,
    expectedRevision: bigint,
    signal?: AbortSignal
  ): Promise<ExtensionLibraryOverviewView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(ExtensionService, scope.transport).repairExtensionLibraryMetadata({
      extensionId,
      expectedRevision: { value: expectedRevision }
    }, { signal: scope.signal });
    if (response.library === undefined) throw new GatewayError("Orchestrator returned an empty repaired Extension Library.");
    return mapExtensionLibraryOverview(response.library);
  }

  async trashExtensionLibrary(
    extensionId: string,
    expectedRevision: bigint,
    confirmation: string,
    signal?: AbortSignal
  ): Promise<ExtensionLibraryTrashEntryView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(ExtensionService, scope.transport).trashExtensionLibrary({
      extensionId,
      expectedRevision: { value: expectedRevision },
      confirmation
    }, { signal: scope.signal });
    if (response.trash === undefined) throw new GatewayError("Orchestrator returned an empty Extension Library trash record.");
    return mapExtensionLibraryTrash(response.trash);
  }

  async listExtensionLibraryTrash(extensionId?: string, signal?: AbortSignal): Promise<readonly ExtensionLibraryTrashEntryView[]> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(ExtensionService, scope.transport).listExtensionLibraryTrash(
      { ...(extensionId === undefined ? {} : { extensionId }) },
      { signal: scope.signal }
    );
    return response.trash.map(mapExtensionLibraryTrash);
  }

  async restoreExtensionLibraryTrash(
    trashId: string,
    confirmation: string,
    destination?: { readonly kind: "default" } | { readonly kind: "custom"; readonly candidate: string },
    signal?: AbortSignal
  ): Promise<{ readonly extensionId: string; readonly location: ExtensionLibraryLocationView }> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(ExtensionService, scope.transport).restoreExtensionLibraryTrash({
      trashId,
      confirmation,
      destinationKind: destination === undefined
        ? ProtoExtensionLibraryLocationKind.UNSPECIFIED
        : destination.kind === "default"
          ? ProtoExtensionLibraryLocationKind.DEFAULT
          : ProtoExtensionLibraryLocationKind.CUSTOM,
      ...(destination?.kind === "custom" ? { candidate: destination.candidate } : {})
    }, { signal: scope.signal });
    if (response.location === undefined || response.extensionId.length === 0) {
      throw new GatewayError("Orchestrator returned an incomplete Extension Library restore.");
    }
    return { extensionId: response.extensionId, location: mapExtensionLibraryLocation(response.location) };
  }

  async purgeExtensionLibraryTrash(trashId: string, confirmation: string, signal?: AbortSignal): Promise<boolean> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(ExtensionService, scope.transport).purgeExtensionLibraryTrash(
      { trashId, confirmation },
      { signal: scope.signal }
    );
    return response.purged;
  }

  async listExtensionLibraryGrace(extensionId?: string, signal?: AbortSignal): Promise<readonly ExtensionLibraryGraceEntryView[]> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(ExtensionService, scope.transport).listExtensionLibraryGrace(
      { ...(extensionId === undefined ? {} : { extensionId }) },
      { signal: scope.signal }
    );
    return response.grace.map(mapExtensionLibraryGrace);
  }

  async rollbackExtensionLibrary(
    extensionId: string,
    expectedRevision: bigint,
    graceId: string,
    signal?: AbortSignal
  ): Promise<{ readonly location: ExtensionLibraryLocationView; readonly graceId: string }> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(ExtensionService, scope.transport).rollbackExtensionLibrary({
      extensionId,
      expectedRevision: { value: expectedRevision },
      graceId
    }, { signal: scope.signal });
    if (response.location === undefined || response.graceId.length === 0) {
      throw new GatewayError("Orchestrator returned an incomplete Extension Library rollback.");
    }
    return { location: mapExtensionLibraryLocation(response.location), graceId: response.graceId };
  }

  async purgeExpiredExtensionLibraries(signal?: AbortSignal): Promise<{ readonly trash: number; readonly grace: number }> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(ExtensionService, scope.transport).purgeExpiredExtensionLibraries({}, { signal: scope.signal });
    return { trash: response.trash, grace: response.grace };
  }

  async openExtensionLibrary(
    extensionId: string,
    expectedRevision: bigint,
    signal?: AbortSignal
  ): Promise<ExtensionLibrarySessionView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(ExtensionService, scope.transport).openExtensionLibrary({
      extensionId,
      expectedRevision: { value: expectedRevision }
    }, { signal: scope.signal });
    if (response.library === undefined) throw new GatewayError("Orchestrator returned an empty Extension Library session.");
    return mapExtensionLibrarySession(response.library);
  }

  async callExtensionLibrary(
    sessionId: string,
    call: ExtensionLibraryCallView,
    signal?: AbortSignal
  ): Promise<ExtensionLibraryCallResultView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(ExtensionService, scope.transport).callExtensionLibrary({
      sessionId,
      call: mapExtensionLibraryCall(call)
    }, { signal: scope.signal });
    if (response.result === undefined) throw new GatewayError("Orchestrator returned an empty Extension Library call result.");
    return mapExtensionLibraryCallResult(response.result);
  }

  async closeExtensionLibrary(sessionId: string, signal?: AbortSignal): Promise<boolean> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(ExtensionService, scope.transport).closeExtensionLibrary(
      { sessionId },
      { signal: scope.signal }
    );
    return response.closed;
  }

  async getExtensionPackagePreview(
    extensionId: string,
    expectedRevision: bigint,
    backendId: string,
    signal?: AbortSignal
  ): Promise<ExtensionPackagePreviewView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(ExtensionService, scope.transport).getExtensionPackagePreview({
      extensionId,
      expectedRevision: { value: expectedRevision },
      backendId
    }, { signal: scope.signal });
    if (response.preview === undefined) throw new GatewayError("Orchestrator returned an empty Extension package preview.");
    return mapExtensionPackagePreview(response.preview);
  }

  async adoptExtensionPackage(
    preview: ExtensionPackagePreviewView,
    allowSourceReplacement = false,
    signal?: AbortSignal
  ): Promise<void> {
    const scope = this.captureActionScope(signal);
    await this.submit({
      case: "adoptExtensionPackage",
      value: {
        extensionId: preview.extensionId,
        expectedRevision: { value: preview.extensionRevision },
        backendId: preview.backendId,
        expectedAction: protoExtensionPackageAction(preview.action),
        expectedCurrentResourceId: preview.currentResource?.resourceId ?? "",
        ...(preview.currentResource === undefined
          ? {}
          : { expectedCurrentResourceRevision: { value: preview.currentResource.resourceRevision } }),
        allowSourceReplacement
      }
    }, true, [], scope.signal);
  }

  async removeExtensionPackage(extensionId: string, expectedRevision: bigint, signal?: AbortSignal): Promise<void> {
    const scope = this.captureActionScope(signal);
    await this.submit({
      case: "removeExtensionPackage",
      value: { extensionId, expectedRevision: { value: expectedRevision } }
    }, true, [], scope.signal);
  }

  async getExtensionPackageExportPreview(
    extensionId: string,
    expectedRevision: bigint,
    signal?: AbortSignal
  ): Promise<ExtensionPackageExportPreviewView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(ExtensionService, scope.transport).getExtensionPackageExportPreview({
      extensionId,
      expectedRevision: { value: expectedRevision }
    }, { signal: scope.signal });
    if (response.preview === undefined) throw new GatewayError("Orchestrator returned an empty Extension package export preview.");
    return {
      ...mapExtensionPackageExportPreview(response.preview),
      recoveredFromCorruption: response.recoveredFromCorruption
    };
  }

  async listExtensionPackageExports(
    extensionId?: string,
    signal?: AbortSignal
  ): Promise<ExtensionPackageExportCatalogView> {
    const scope = this.captureActionScope(signal);
    const client = createClient(ExtensionService, scope.transport);
    const exports: ExtensionPackageExportJobView[] = [];
    const identities = new Set<string>();
    const consumedTokens = new Set<string>();
    let pageToken = "";
    let recoveredFromCorruption: boolean | undefined;
    let totalSize: number | undefined;
    for (let pageIndex = 0; pageIndex < MAX_COMPLETE_MESSAGE_SEARCH_PAGES; pageIndex += 1) {
      scope.signal.throwIfAborted();
      const response = await client.listExtensionPackageExports({
        ...(extensionId === undefined ? {} : { extensionId }),
        page: { pageSize: 500, pageToken }
      }, { signal: scope.signal });
      if (recoveredFromCorruption === undefined) recoveredFromCorruption = response.recoveredFromCorruption;
      else if (recoveredFromCorruption !== response.recoveredFromCorruption) {
        throw new GatewayError("Extension package export recovery state changed while it was being loaded.");
      }
      const pageTotal = response.page === undefined ? undefined : exactSafeUnsignedNumber(response.page.totalSize);
      if (pageTotal === undefined) throw new GatewayError("Orchestrator returned an invalid Extension package export catalog size.");
      if (totalSize === undefined) totalSize = pageTotal;
      else if (totalSize !== pageTotal) throw new GatewayError("Orchestrator returned inconsistent Extension package export catalog sizes.");
      if (response.exports.length > 500 || exports.length + response.exports.length > pageTotal) {
        throw new GatewayError("Orchestrator returned an invalid Extension package export page.");
      }
      for (const value of response.exports) {
        const mapped = mapExtensionPackageExportJob(value);
        if (extensionId !== undefined && mapped.authority.extensionId !== extensionId) {
          throw new GatewayError("Orchestrator returned an Extension package export outside the requested owner.");
        }
        if (identities.has(mapped.id)) throw new GatewayError("Orchestrator returned a duplicate Extension package export identity.");
        identities.add(mapped.id);
        exports.push(mapped);
      }
      const nextPageToken = response.page?.nextPageToken ?? "";
      if (nextPageToken === "") {
        if (exports.length !== pageTotal) throw new GatewayError("Orchestrator returned an incomplete Extension package export catalog.");
        return { exports, recoveredFromCorruption: recoveredFromCorruption ?? false };
      }
      if (nextPageToken === pageToken || consumedTokens.has(nextPageToken)) {
        throw new GatewayError("Orchestrator returned a cyclic Extension package export page token.");
      }
      consumedTokens.add(nextPageToken);
      pageToken = nextPageToken;
    }
    throw new GatewayError("Extension package exports exceeded the safe pagination limit.");
  }

  async getExtensionPackageExport(exportId: string, signal?: AbortSignal): Promise<ExtensionPackageExportJobView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(ExtensionService, scope.transport).getExtensionPackageExport(
      { exportId },
      { signal: scope.signal }
    );
    if (response.export === undefined) throw new GatewayError("Orchestrator returned an empty Extension package export.");
    return mapExtensionPackageExportJob(response.export);
  }

  async startExtensionPackageExport(
    preview: ExtensionPackageExportPreviewView,
    signal?: AbortSignal
  ): Promise<ExtensionPackageExportJobView> {
    const scope = this.captureActionScope(signal);
    const operation = await this.submit({
      case: "startExtensionPackageExport",
      value: {
        extensionId: preview.extensionId,
        expectedExtensionRevision: { value: preview.extensionRevision },
        resourceId: preview.resourceId,
        expectedResourceRevision: { value: preview.resourceRevision },
        backendId: preview.backendId,
        expectedBackendRevision: { value: preview.backendRevision },
        expectedBackendGeneration: BigInt(preview.backendGeneration)
      }
    }, true, [], scope.signal);
    if (operation.operationId.trim() === "") throw new GatewayError("Orchestrator returned an Extension package export without an identity.");
    return this.getExtensionPackageExport(operation.operationId, scope.signal);
  }

  async cancelExtensionPackageExport(
    exportId: string,
    expectedRevision: bigint,
    signal?: AbortSignal
  ): Promise<ExtensionPackageExportJobView> {
    const scope = this.captureActionScope(signal);
    await this.submit({
      case: "cancelExtensionPackageExport",
      value: { exportId, expectedRevision: { value: expectedRevision } }
    }, true, [], scope.signal);
    return this.getExtensionPackageExport(exportId, scope.signal);
  }

  async getExtensionSourceGitPreflight(signal?: AbortSignal): Promise<ExtensionSourceGitPreflightView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(ExtensionService, scope.transport)
      .getExtensionSourceGitPreflight({}, { signal: scope.signal });
    const preflight = response.preflight;
    if (preflight === undefined || preflight.minimumVersion.trim() === "") {
      throw new GatewayError("Orchestrator returned an incomplete Extension source preflight result.");
    }
    return {
      available: preflight.available,
      ...(preflight.version === undefined ? {} : { version: preflight.version }),
      minimumVersion: preflight.minimumVersion
    };
  }

  async listExtensionSources(signal?: AbortSignal): Promise<ExtensionSourceCatalogView> {
    const scope = this.captureActionScope(signal);
    const client = createClient(ExtensionService, scope.transport);
    sourceCatalogAttempts:
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const sources: ExtensionSourceView[] = [];
      const ids = new Set<string>();
      const consumedTokens = new Set<string>();
      let pageToken = "";
      let revision: bigint | undefined;
      let recoveredFromCorruption = false;
      let totalSize: number | undefined;
      for (let pageIndex = 0; pageIndex < MAX_COMPLETE_MESSAGE_SEARCH_PAGES; pageIndex += 1) {
        scope.signal.throwIfAborted();
        const response = await client.listExtensionSources({ page: { pageSize: 500, pageToken } }, { signal: scope.signal });
        const pageRevision = response.catalogRevision?.value;
        if (pageRevision === undefined) throw new GatewayError("Orchestrator returned Extension sources without a catalog revision.");
        if (revision === undefined) {
          revision = pageRevision;
          recoveredFromCorruption = response.recoveredFromCorruption;
        } else if (revision !== pageRevision || recoveredFromCorruption !== response.recoveredFromCorruption) {
          if (attempt === 0) continue sourceCatalogAttempts;
          throw new GatewayError("Extension sources changed repeatedly while they were being loaded.");
        }
        const pageTotal = response.page === undefined ? undefined : exactSafeUnsignedNumber(response.page.totalSize);
        if (pageTotal === undefined) throw new GatewayError("Orchestrator returned an invalid Extension source catalog size.");
        if (totalSize === undefined) totalSize = pageTotal;
        else if (totalSize !== pageTotal) throw new GatewayError("Orchestrator returned inconsistent Extension source catalog sizes.");
        if (response.sources.length > 500 || sources.length + response.sources.length > pageTotal) {
          throw new GatewayError("Orchestrator returned an invalid Extension source page.");
        }
        for (const value of response.sources) {
          const mapped = mapExtensionSource(value);
          if (ids.has(mapped.id)) throw new GatewayError("Orchestrator returned a duplicate Extension source identity.");
          ids.add(mapped.id);
          sources.push(mapped);
        }
        const nextPageToken = response.page?.nextPageToken ?? "";
        if (nextPageToken === "") {
          if (sources.length !== pageTotal) throw new GatewayError("Orchestrator returned an incomplete Extension source catalog.");
          return { revision, sources, recoveredFromCorruption };
        }
        if (nextPageToken === pageToken || consumedTokens.has(nextPageToken)) {
          throw new GatewayError("Orchestrator returned a cyclic Extension source page token.");
        }
        consumedTokens.add(nextPageToken);
        pageToken = nextPageToken;
      }
      throw new GatewayError("Extension sources exceeded the safe pagination limit.");
    }
    throw new GatewayError("Extension sources changed repeatedly while they were being loaded.");
  }

  async addExtensionSource(source: ExtensionSourceDraft, expectedCatalogRevision: bigint): Promise<void> {
    await this.submit({
      case: "addExtensionSource",
      value: {
        source: extensionSourceLocation(source),
        expectedCatalogRevision: { value: expectedCatalogRevision }
      }
    }, true);
  }

  async refreshExtensionSource(sourceId: string, expectedRevision: bigint): Promise<void> {
    await this.submit({ case: "refreshExtensionSource", value: { sourceId, expectedRevision: { value: expectedRevision } } }, true);
  }

  async removeExtensionSource(sourceId: string, expectedRevision: bigint): Promise<void> {
    await this.submit({ case: "removeExtensionSource", value: { sourceId, expectedRevision: { value: expectedRevision } } }, true);
  }

  async setExtensionEnabled(extensionId: string, enabled: boolean, expectedRevision: bigint): Promise<void> {
    await this.submit({ case: "setExtensionEnabled", value: { extensionId, enabled, expectedRevision: { value: expectedRevision } } }, true);
  }

  async setExtensionSidebarVisible(extensionId: string, visible: boolean, expectedRevision: bigint): Promise<void> {
    await this.submit({ case: "setExtensionSidebarVisible", value: { extensionId, visible, expectedRevision: { value: expectedRevision } } }, true);
  }

  async beginExtensionSetup(extensionId: string, expectedRevision: bigint): Promise<void> {
    await this.submit({ case: "beginExtensionSetup", value: { extensionId, expectedRevision: { value: expectedRevision } } }, true);
  }

  async submitExtensionSetupInteraction(
    extensionId: string,
    attemptId: string,
    fieldId: string,
    value: string | boolean,
    expectedRevision: bigint
  ): Promise<void> {
    await this.submit({
      case: "submitExtensionSetupInteraction",
      value: {
        extensionId,
        attemptId,
        fieldId,
        value: typeof value === "boolean" ? { case: "confirmed", value } : { case: "text", value },
        expectedRevision: { value: expectedRevision }
      }
    }, true);
  }

  async saveExtensionSetupCredential(
    extensionId: string,
    attemptId: string,
    fieldId: string,
    kind: "apiKey" | "oauth" | "headerSecret",
    secret: string,
    expectedRevision: bigint,
    signal?: AbortSignal
  ): Promise<void> {
    if (secret.length === 0) throw new GatewayError("Extension credential value is required.");
    const scope = this.captureActionScope(signal);
    const response = await createClient(ExtensionService, scope.transport).beginExtensionSetupCredentialUpload({
      extensionId,
      attemptId,
      fieldId,
      kind: kind === "oauth" ? CredentialKind.OAUTH : kind === "headerSecret" ? CredentialKind.HEADER_SECRET : CredentialKind.API_KEY
    }, { signal: scope.signal });
    const ticketId = await this.uploadCredentialTicket(secret, response.ticket, scope);
    scope.signal.throwIfAborted();
    await this.submit({
      case: "commitExtensionSetupCredential",
      value: {
        extensionId,
        attemptId,
        fieldId,
        credentialUploadTicketId: ticketId,
        expectedRevision: { value: expectedRevision }
      }
    }, true, [], scope.signal);
  }

  async completeExtensionSetup(extensionId: string, attemptId: string, expectedRevision: bigint): Promise<void> {
    await this.submit({ case: "completeExtensionSetup", value: { extensionId, attemptId, expectedRevision: { value: expectedRevision } } }, true);
  }

  async cancelExtensionSetup(extensionId: string, attemptId: string, expectedRevision: bigint): Promise<void> {
    await this.submit({ case: "cancelExtensionSetup", value: { extensionId, attemptId, expectedRevision: { value: expectedRevision } } }, true);
  }

  async revokeExtensionSetup(extensionId: string, expectedRevision: bigint): Promise<void> {
    await this.submit({ case: "revokeExtensionSetup", value: { extensionId, expectedRevision: { value: expectedRevision } } }, true);
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
          if (!isRevisionDriftError(error)) throw error;
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

  async readWorkspaceHtmlSnapshot(sessionId: string, workspaceId: string, path: string, signal: AbortSignal): Promise<{ readonly file: { readonly workspaceId: string; readonly relativePath: string; readonly expectedRevision: string }; readonly html: string }> {
    const transport = this.requireTransport();
    const requestSignal = this.#abort === undefined ? signal : AbortSignal.any([signal, this.#abort.signal]);
    requestSignal.throwIfAborted();
    const response = await createClient(WorkspaceService, transport).readWorkspaceHtmlSnapshot({
      sessionId, file: { workspaceId, relativePath: path, expectedRevision: "" }
    }, { signal: requestSignal });
    requestSignal.throwIfAborted();
    if (this.requireTransport() !== transport || response.file === undefined || response.file.expectedRevision === ""
      || response.file.workspaceId !== workspaceId || response.file.relativePath !== path) {
      throw new GatewayError("The HTML preview source is no longer available.");
    }
    return { file: response.file, html: response.utf8Html };
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

  async saveProvider(draft: ProviderDraft, signal?: AbortSignal): Promise<void> {
    const scope = this.captureActionScope(signal);
    if (draft.runtimes.length === 0 || new Set(draft.runtimes.map((runtime) => runtime.backendId)).size !== draft.runtimes.length) {
      throw new GatewayError("A provider must configure distinct runtime identities.");
    }
    const runtimes = draft.runtimes.map((runtime) => {
    if (runtime.models.length === 0) throw new GatewayError("Each provider runtime must declare at least one model.");
    const headers = runtime.headers.map((header) => ({
      headerName: header.headerName.trim(),
      environmentName: header.environmentName.trim(),
      credentialReferenceId: header.credentialId
    }));
    if (headers.some((header) => header.headerName.length === 0 || (header.environmentName.length === 0 && header.credentialReferenceId.length === 0))) {
      throw new GatewayError("Each provider header needs a name and an environment or credential binding.");
    }
    const models = runtime.models.map((model) => ({
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
      ...(model.defaultVisible === undefined ? {} : { defaultVisible: model.defaultVisible }),
      ...(model.supportsTools === undefined ? {} : { supportsTools: model.supportsTools })
    }));
    if (models.some((model) => model.modelId.length === 0 || model.displayName.length === 0 || model.inputModalities.length === 0)) {
      throw new GatewayError("Every model needs an ID, name, and input modality.");
    }
    if (new Set(models.map((model) => model.modelId)).size !== models.length) throw new GatewayError("Model IDs must be unique within a provider.");
    return create(ProviderRuntimeConfigurationSchema, {
      backendId: runtime.backendId,
      apiCompatibility: protoProviderCompatibility(runtime.compatibility),
      endpoint: canonicalProviderEndpoint(runtime.endpoint),
      credentialReferenceId: runtime.credentialId,
      apiKeyEnvironment: runtime.environmentName.trim(),
      keyless: runtime.keyless,
      authHeader: runtime.authHeader,
      credentialOrigin: runtime.credentialOrigin,
      ...(runtime.requestPath === undefined ? {} : { requestPath: runtime.requestPath }),
      ...(runtime.modelsEndpoint === undefined ? {} : { modelsEndpoint: canonicalProviderEndpoint(runtime.modelsEndpoint) }),
      headers: headers.map((header) => create(ProviderHeaderConfigurationSchema, header)),
      models: models.map((model) => create(ProviderModelConfigurationSchema, model))
    });
    });
    const provider = create(ProviderConfigurationSchema, {
      providerId: draft.id.trim(), displayName: draft.name.trim(), kind: protoProviderKind(draft.kind),
      enabled: draft.enabled, version: { revision: { value: draft.revision } }, runtimes
    });
    if (provider.providerId.length === 0 || provider.displayName.length === 0) throw new GatewayError("Provider ID and name are required.");
    await this.submit({ case: "upsertProvider", value: { provider } }, true, [], scope.signal);
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
    const scope = this.captureActionScope();
    const ticketId = await this.uploadCredential(secret, CredentialKind.API_KEY, providerId, scope, {
      backendId,
      surfaceId
    });
    scope.signal.throwIfAborted();
    await this.submit({
      case: "commitProviderCredentialSurface",
      value: {
        backendId,
        providerId,
        surfaceId,
        credentialUploadTicketId: ticketId
      }
    }, true, [], scope.signal);
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

  async saveCredential(draft: CredentialDraft, signal?: AbortSignal): Promise<void> {
    if (draft.id.trim().length === 0 || draft.name.trim().length === 0 || draft.secret.length === 0) throw new GatewayError("Credential ID, name, and value are required.");
    const kind = protoCredentialKind(draft.kind);
    const scope = this.captureActionScope(signal);
    const ticketId = await this.uploadCredential(draft.secret, kind, draft.providerId, scope);
    scope.signal.throwIfAborted();
    await this.submit({
      case: "commitCredential",
      value: {
        credentialUploadTicketId: ticketId,
        credentialReferenceId: draft.id.trim(),
        displayName: draft.name.trim(),
        kind,
        providerId: draft.providerId
      }
    }, true, [], scope.signal);
  }

  async deleteCredential(credentialId: string): Promise<void> {
    await this.submit({ case: "deleteCredential", value: { credentialReferenceId: credentialId } }, true);
  }

  async getPartnerDirectory(signal?: AbortSignal): Promise<PartnerDirectoryView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(PartnerService, scope.transport).getPartnerDirectory({}, { signal: scope.signal });
    scope.signal.throwIfAborted();
    return mapPartnerDirectory(response.directory);
  }

  async listPartners(lifecycle?: PartnerLifecycleView, signal?: AbortSignal): Promise<PartnerListView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(PartnerService, scope.transport).listPartners({
      ...(lifecycle === undefined ? {} : { lifecycle: protoPartnerLifecycle(lifecycle) })
    }, { signal: scope.signal });
    scope.signal.throwIfAborted();
    return {
      partners: response.partners.map(mapPartnerProfile),
      directory: mapPartnerDirectory(response.directory)
    };
  }

  async getPartner(partnerId: string, signal?: AbortSignal): Promise<PartnerProfileView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(PartnerService, scope.transport).getPartner({ partnerId }, { signal: scope.signal });
    scope.signal.throwIfAborted();
    return mapPartnerProfile(response.partner);
  }

  async createPartner(
    expectedDirectoryRevision: bigint,
    draft: PartnerDraftView,
    signal?: AbortSignal
  ): Promise<PartnerMutationView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(PartnerService, scope.transport).createPartner({
      expectedDirectoryRevision: { value: expectedDirectoryRevision },
      draft: {
        displayName: draft.displayName,
        avatar: draft.avatar,
        identitySource: draft.identitySource,
        templateId: draft.templateId,
        ...(draft.capabilities === undefined ? {} : { capabilities: protoPartnerCapabilities(draft.capabilities) }),
        usesDirectoryDefaults: draft.usesDirectoryDefaults
      }
    }, { signal: scope.signal });
    scope.signal.throwIfAborted();
    return mapPartnerMutation(response.partner, response.directory);
  }

  async updatePartner(
    partnerId: string,
    expectedRevision: bigint,
    patch: PartnerPatchView,
    signal?: AbortSignal
  ): Promise<PartnerMutationView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(PartnerService, scope.transport).updatePartner({
      partnerId,
      expectedRevision: { value: expectedRevision },
      patch: protoPartnerPatch(patch)
    }, { signal: scope.signal });
    scope.signal.throwIfAborted();
    return mapPartnerMutation(response.partner, response.directory);
  }

  async setPartnerLifecycle(
    partnerId: string,
    expectedRevision: bigint,
    lifecycle: PartnerLifecycleView,
    signal?: AbortSignal
  ): Promise<PartnerMutationView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(PartnerService, scope.transport).setPartnerLifecycle({
      partnerId,
      expectedRevision: { value: expectedRevision },
      lifecycle: protoPartnerLifecycle(lifecycle)
    }, { signal: scope.signal });
    scope.signal.throwIfAborted();
    return mapPartnerMutation(response.partner, response.directory);
  }

  async retryPartnerInitialization(
    partnerId: string,
    expectedRevision: bigint,
    signal?: AbortSignal
  ): Promise<PartnerMutationView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(PartnerService, scope.transport).retryPartnerInitialization({
      partnerId,
      expectedRevision: { value: expectedRevision }
    }, { signal: scope.signal });
    scope.signal.throwIfAborted();
    return mapPartnerMutation(response.partner, response.directory);
  }

  async updatePartnerDefaults(
    expectedDirectoryRevision: bigint,
    capabilities: PartnerCapabilitiesView,
    signal?: AbortSignal
  ): Promise<PartnerDefaultsMutationView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(PartnerService, scope.transport).updatePartnerDefaults({
      expectedDirectoryRevision: { value: expectedDirectoryRevision },
      capabilities: protoPartnerCapabilities(capabilities)
    }, { signal: scope.signal });
    scope.signal.throwIfAborted();
    return {
      directory: mapPartnerDirectory(response.directory),
      affectedPartners: response.affectedPartners.map(mapPartnerProfile)
    };
  }

  async listPartnerSessions(partnerId: string, signal?: AbortSignal): Promise<readonly PartnerSessionView[]> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(PartnerService, scope.transport).listPartnerSessions(
      { partnerId }, { signal: scope.signal }
    );
    scope.signal.throwIfAborted();
    const sessions = response.sessions.map(mapPartnerSession);
    if (sessions.some((session) => session.partnerId !== partnerId)) {
      throw new GatewayError("Orchestrator returned a Partner task owned by another profile.");
    }
    return sessions;
  }

  async markPartnerRead(
    partnerId: string,
    throughCursor: bigint,
    signal?: AbortSignal
  ): Promise<PartnerActivityView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(PartnerService, scope.transport).markPartnerRead({
      partnerId,
      throughCursor: { value: throughCursor }
    }, { signal: scope.signal });
    scope.signal.throwIfAborted();
    const activity = mapPartnerActivity(response.activity);
    if (activity.partnerId !== partnerId || activity.readThroughCursor < throughCursor) {
      throw new GatewayError("Orchestrator returned activity owned by another Partner.");
    }
    return activity;
  }

  async listPartnerPrivateThreads(
    partnerId: string,
    signal?: AbortSignal
  ): Promise<readonly PartnerPrivateThreadView[]> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(PartnerService, scope.transport).listPartnerPrivateThreads(
      { partnerId }, { signal: scope.signal }
    );
    scope.signal.throwIfAborted();
    const threads = response.threads.map(mapPartnerPrivateThread);
    if (threads.some((thread) => thread.firstPartnerId !== partnerId && thread.secondPartnerId !== partnerId)) {
      throw new GatewayError("Orchestrator returned a private thread owned by other Partners.");
    }
    return threads;
  }

  async getPartnerPrivateThread(
    partnerId: string,
    threadId: string,
    signal?: AbortSignal
  ): Promise<PartnerPrivateThreadDetailView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(PartnerService, scope.transport).getPartnerPrivateThread(
      { partnerId, threadId }, { signal: scope.signal }
    );
    scope.signal.throwIfAborted();
    const thread = mapPartnerPrivateThread(response.thread);
    const messages = response.messages.map(mapPartnerPrivateMessage);
    const readState = response.readState === undefined ? undefined : mapPartnerPrivateReadState(response.readState);
    let previousSequence = 0;
    if (thread.id !== threadId
      || (thread.firstPartnerId !== partnerId && thread.secondPartnerId !== partnerId)
      || thread.messageCount !== messages.length
      || messages.some((message) => {
        const participantsMatch = message.senderPartnerId === thread.firstPartnerId
          && message.recipientPartnerId === thread.secondPartnerId
          || message.senderPartnerId === thread.secondPartnerId
          && message.recipientPartnerId === thread.firstPartnerId;
        const valid = message.threadId === thread.id && participantsMatch && message.sequence > previousSequence;
        previousSequence = message.sequence;
        return !valid;
      })
      || (readState !== undefined && (
        readState.threadId !== thread.id || readState.partnerId !== partnerId
        || readState.throughSequence > (messages.at(-1)?.sequence ?? 0)
      ))) {
      throw new GatewayError("Orchestrator returned a mismatched Partner private thread.");
    }
    return { thread, messages, ...(readState === undefined ? {} : { readState }) };
  }

  async markPartnerPrivateThreadRead(
    partnerId: string,
    threadId: string,
    throughSequence: number,
    signal?: AbortSignal
  ): Promise<PartnerPrivateThreadReadStateView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(PartnerService, scope.transport).markPartnerPrivateThreadRead({
      partnerId,
      threadId,
      throughSequence: BigInt(throughSequence)
    }, { signal: scope.signal });
    scope.signal.throwIfAborted();
    const readState = mapPartnerPrivateReadState(response.readState);
    if (readState.partnerId !== partnerId || readState.threadId !== threadId
      || readState.throughSequence < throughSequence) {
      throw new GatewayError("Orchestrator returned a mismatched Partner private read state.");
    }
    return readState;
  }

  async listPartnerDelegations(
    partnerId: string,
    signal?: AbortSignal
  ): Promise<readonly PartnerDelegationView[]> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(PartnerService, scope.transport).listPartnerDelegations(
      { partnerId }, { signal: scope.signal }
    );
    scope.signal.throwIfAborted();
    const delegations = response.delegations.map(mapPartnerDelegation);
    if (delegations.some((delegation) => delegation.requesterPartnerId !== partnerId)) {
      throw new GatewayError("Orchestrator returned a delegation owned by another Partner.");
    }
    return delegations;
  }

  async getPartnerDelegation(
    partnerId: string,
    delegationId: string,
    signal?: AbortSignal
  ): Promise<PartnerDelegationView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(PartnerService, scope.transport).getPartnerDelegation(
      { partnerId, delegationId }, { signal: scope.signal }
    );
    scope.signal.throwIfAborted();
    const delegation = mapPartnerDelegation(response.delegation);
    if (delegation.id !== delegationId
      || (delegation.requesterPartnerId !== partnerId && delegation.targetPartnerId !== partnerId)) {
      throw new GatewayError("Orchestrator returned a mismatched Partner delegation.");
    }
    return delegation;
  }

  async cancelPartnerDelegation(
    partnerId: string,
    delegationId: string,
    expectedRevision: bigint,
    signal?: AbortSignal
  ): Promise<PartnerDelegationView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(PartnerService, scope.transport).cancelPartnerDelegation({
      partnerId,
      delegationId,
      expectedRevision: { value: expectedRevision }
    }, { signal: scope.signal });
    scope.signal.throwIfAborted();
    const delegation = mapPartnerDelegation(response.delegation);
    if (delegation.id !== delegationId || delegation.requesterPartnerId !== partnerId) {
      throw new GatewayError("Orchestrator returned a mismatched Partner delegation cancellation.");
    }
    return delegation;
  }

  async getContactDirectory(signal?: AbortSignal): Promise<ContactDirectoryView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(ContactService, scope.transport).getContactDirectory({}, { signal: scope.signal });
    scope.signal.throwIfAborted();
    return mapContactDirectory(response.directory);
  }

  async setContactDirectoryEnabled(expectedRevision: bigint, enabled: boolean, signal?: AbortSignal): Promise<ContactDirectoryView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(ContactService, scope.transport).setContactDirectoryEnabled({
      expectedDirectoryRevision: { value: expectedRevision }, enabled
    }, { signal: scope.signal });
    scope.signal.throwIfAborted();
    return mapContactDirectory(response.directory);
  }

  async listContacts(options: ContactListOptionsView = {}, signal?: AbortSignal): Promise<ContactListPageView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(ContactService, scope.transport).listContacts({
      ...(options.query === undefined ? {} : { query: options.query }),
      ...(options.kind === undefined ? {} : { kind: protoContactKind(options.kind) }),
      ...(options.status === undefined ? {} : { status: protoContactStatus(options.status) }),
      ...(options.groupId === undefined ? {} : { contactGroupId: options.groupId }),
      pageSize: options.pageSize ?? 100,
      pageOffset: options.pageOffset ?? 0
    }, { signal: scope.signal });
    scope.signal.throwIfAborted();
    return {
      contacts: response.contacts.map(mapContactSummary),
      total: response.total,
      ...(response.nextPageOffset === undefined ? {} : { nextPageOffset: response.nextPageOffset })
    };
  }

  async getContact(contactId: string, signal?: AbortSignal): Promise<ContactProfileView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(ContactService, scope.transport).getContact({ contactId }, { signal: scope.signal });
    scope.signal.throwIfAborted();
    return mapContactProfile(response.contact);
  }

  async findSimilarContacts(contact: ContactDraftView, signal?: AbortSignal): Promise<readonly ContactDuplicateCandidateView[]> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(ContactService, scope.transport).findSimilarContacts({ contact: protoContactDraft(contact) }, { signal: scope.signal });
    scope.signal.throwIfAborted();
    return response.candidates.map(mapContactDuplicateCandidate);
  }

  async createContact(
    expectedDirectoryRevision: bigint,
    contact: ContactDraftView,
    confirmedNameCandidateIds: readonly string[] = [],
    signal?: AbortSignal
  ): Promise<ContactCreateResultView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(ContactService, scope.transport).createContact({
      expectedDirectoryRevision: { value: expectedDirectoryRevision },
      contact: protoContactDraft(contact),
      confirmedNameCandidateIds: [...confirmedNameCandidateIds]
    }, { signal: scope.signal });
    scope.signal.throwIfAborted();
    return {
      ...(response.contact === undefined ? {} : { contact: mapContactProfile(response.contact) }),
      candidates: response.candidates.map(mapContactDuplicateCandidate),
      directory: mapContactDirectory(response.directory)
    };
  }

  async updateContact(contactId: string, expectedRevision: bigint, patch: ContactPatchView, signal?: AbortSignal): Promise<ContactMutationView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(ContactService, scope.transport).updateContact({
      contactId, expectedRevision: { value: expectedRevision }, patch: protoContactPatch(patch)
    }, { signal: scope.signal });
    scope.signal.throwIfAborted();
    return mapContactMutation(response.contact, response.directory);
  }

  async confirmContact(contactId: string, expectedRevision: bigint, signal?: AbortSignal): Promise<ContactMutationView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(ContactService, scope.transport).confirmContact({
      contactId, expectedRevision: { value: expectedRevision }
    }, { signal: scope.signal });
    scope.signal.throwIfAborted();
    return mapContactMutation(response.contact, response.directory);
  }

  async deleteContact(contactId: string, expectedRevision: bigint, signal?: AbortSignal): Promise<ContactDirectoryView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(ContactService, scope.transport).deleteContact({
      contactId, expectedRevision: { value: expectedRevision }
    }, { signal: scope.signal });
    scope.signal.throwIfAborted();
    return mapContactDirectory(response.directory);
  }

  async addContactIdentity(contactId: string, expectedContactRevision: bigint, identity: ContactIdentityInputView, signal?: AbortSignal): Promise<ContactMutationView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(ContactService, scope.transport).addContactIdentity({
      contactId, expectedContactRevision: { value: expectedContactRevision }, identity: protoContactIdentityInput(identity)
    }, { signal: scope.signal });
    scope.signal.throwIfAborted();
    return mapContactMutation(response.contact, response.directory);
  }

  async removeContactIdentity(contactId: string, expectedContactRevision: bigint, contactIdentityId: string, signal?: AbortSignal): Promise<ContactMutationView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(ContactService, scope.transport).removeContactIdentity({
      contactId, expectedContactRevision: { value: expectedContactRevision }, contactIdentityId
    }, { signal: scope.signal });
    scope.signal.throwIfAborted();
    return mapContactMutation(response.contact, response.directory);
  }

  async appendContactEvent(contactId: string, expectedContactRevision: bigint, event: ContactEventInputView, signal?: AbortSignal): Promise<ContactMutationView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(ContactService, scope.transport).appendContactEvent({
      contactId, expectedContactRevision: { value: expectedContactRevision }, event: protoContactEventInput(event)
    }, { signal: scope.signal });
    scope.signal.throwIfAborted();
    return mapContactMutation(response.contact, response.directory);
  }

  async removeContactEvent(contactId: string, expectedContactRevision: bigint, contactEventId: string, signal?: AbortSignal): Promise<ContactMutationView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(ContactService, scope.transport).removeContactEvent({
      contactId, expectedContactRevision: { value: expectedContactRevision }, contactEventId
    }, { signal: scope.signal });
    scope.signal.throwIfAborted();
    return mapContactMutation(response.contact, response.directory);
  }

  async listContactGroups(signal?: AbortSignal): Promise<readonly ContactGroupView[]> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(ContactService, scope.transport).listContactGroups({}, { signal: scope.signal });
    scope.signal.throwIfAborted();
    return response.groups.map(mapContactGroup);
  }

  async createContactGroup(expectedDirectoryRevision: bigint, name: string, description: string, signal?: AbortSignal): Promise<{ readonly group: ContactGroupView; readonly directory: ContactDirectoryView }> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(ContactService, scope.transport).createContactGroup({
      expectedDirectoryRevision: { value: expectedDirectoryRevision }, name, description
    }, { signal: scope.signal });
    scope.signal.throwIfAborted();
    return { group: mapContactGroup(response.group), directory: mapContactDirectory(response.directory) };
  }

  async updateContactGroup(contactGroupId: string, expectedRevision: bigint, name: string, description: string, signal?: AbortSignal): Promise<{ readonly group: ContactGroupView; readonly directory: ContactDirectoryView }> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(ContactService, scope.transport).updateContactGroup({
      contactGroupId, expectedRevision: { value: expectedRevision }, name, description
    }, { signal: scope.signal });
    scope.signal.throwIfAborted();
    return { group: mapContactGroup(response.group), directory: mapContactDirectory(response.directory) };
  }

  async deleteContactGroup(contactGroupId: string, expectedRevision: bigint, signal?: AbortSignal): Promise<ContactDirectoryView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(ContactService, scope.transport).deleteContactGroup({
      contactGroupId, expectedRevision: { value: expectedRevision }
    }, { signal: scope.signal });
    scope.signal.throwIfAborted();
    return mapContactDirectory(response.directory);
  }

  async setContactGroupMembership(contactId: string, expectedContactRevision: bigint, contactGroupId: string, member: boolean, signal?: AbortSignal): Promise<ContactMutationView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(ContactService, scope.transport).setContactGroupMembership({
      contactId, expectedContactRevision: { value: expectedContactRevision }, contactGroupId, member
    }, { signal: scope.signal });
    scope.signal.throwIfAborted();
    return mapContactMutation(response.contact, response.directory);
  }

  async addContactRelation(fromContactId: string, expectedFromRevision: bigint, toContactId: string, relation: string, note: string, signal?: AbortSignal): Promise<ContactMutationView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(ContactService, scope.transport).addContactRelation({
      fromContactId, expectedFromRevision: { value: expectedFromRevision }, toContactId, relation, note
    }, { signal: scope.signal });
    scope.signal.throwIfAborted();
    return mapContactMutation(response.contact, response.directory);
  }

  async updateContactRelation(ownerContactId: string, expectedOwnerRevision: bigint, contactRelationId: string, expectedRelationRevision: bigint, relation: string, note: string, signal?: AbortSignal): Promise<ContactMutationView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(ContactService, scope.transport).updateContactRelation({
      ownerContactId,
      expectedOwnerRevision: { value: expectedOwnerRevision },
      contactRelationId,
      expectedRelationRevision: { value: expectedRelationRevision },
      relation,
      note
    }, { signal: scope.signal });
    scope.signal.throwIfAborted();
    return mapContactMutation(response.contact, response.directory);
  }

  async removeContactRelation(ownerContactId: string, expectedOwnerRevision: bigint, contactRelationId: string, signal?: AbortSignal): Promise<ContactMutationView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(ContactService, scope.transport).removeContactRelation({
      ownerContactId, expectedOwnerRevision: { value: expectedOwnerRevision }, contactRelationId
    }, { signal: scope.signal });
    scope.signal.throwIfAborted();
    return mapContactMutation(response.contact, response.directory);
  }

  async scanContactDuplicates(limit = 100, signal?: AbortSignal): Promise<{ readonly pairs: readonly ContactDuplicatePairView[]; readonly directory: ContactDirectoryView }> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(ContactService, scope.transport).scanContactDuplicates({ limit }, { signal: scope.signal });
    scope.signal.throwIfAborted();
    return {
      pairs: response.pairs.map((pair) => ({ first: mapContactSummary(pair.first), second: mapContactSummary(pair.second) })),
      directory: mapContactDirectory(response.directory)
    };
  }

  async mergeContacts(targetContactId: string, expectedTargetRevision: bigint, mergedContactId: string, expectedMergedRevision: bigint, signal?: AbortSignal): Promise<ContactMergeResultView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(ContactService, scope.transport).mergeContacts({
      targetContactId,
      expectedTargetRevision: { value: expectedTargetRevision },
      mergedContactId,
      expectedMergedRevision: { value: expectedMergedRevision }
    }, { signal: scope.signal });
    scope.signal.throwIfAborted();
    return {
      target: mapContactProfile(response.target),
      mergedContactId: response.mergedContactId,
      movedIdentities: response.movedIdentities,
      movedEvents: response.movedEvents,
      movedRelations: response.movedRelations,
      directory: mapContactDirectory(response.directory)
    };
  }

  async previewContactVCardImport(vcardText: string, signal?: AbortSignal): Promise<ContactVCardImportPreviewView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(ContactService, scope.transport).previewContactVCardImport({ vcardText }, { signal: scope.signal });
    scope.signal.throwIfAborted();
    return {
      previewId: response.previewId,
      directoryRevision: requiredContactRevision(response.directoryRevision, "vCard preview directory"),
      entries: response.entries.map(mapContactVCardImportPreviewEntry),
      expiresAt: requiredContactTimestamp(response.expiresAt, "vCard preview expiry")
    };
  }

  async commitContactVCardImport(previewId: string, expectedDirectoryRevision: bigint, decisions: readonly ContactVCardImportDecisionView[], signal?: AbortSignal): Promise<ContactVCardImportResultView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(ContactService, scope.transport).commitContactVCardImport({
      previewId,
      expectedDirectoryRevision: { value: expectedDirectoryRevision },
      decisions: decisions.map(protoContactVCardImportDecision)
    }, { signal: scope.signal });
    scope.signal.throwIfAborted();
    const entries = response.entries.map((entry) => {
      const outcome = entry.outcome === ContactVCardImportOutcome.CREATED ? "created" as const
        : entry.outcome === ContactVCardImportOutcome.ENRICHED ? "enriched" as const
          : entry.outcome === ContactVCardImportOutcome.SKIPPED ? "skipped" as const
            : undefined;
      if (entry.entryId.trim() === "" || entry.displayName.trim() === "" || outcome === undefined
        || (outcome === "skipped") !== (entry.contactId === undefined)) {
        throw new GatewayError("Orchestrator returned an invalid Contact vCard entry result.");
      }
      return {
        entryId: entry.entryId,
        displayName: entry.displayName,
        outcome,
        ...(entry.contactId === undefined ? {} : { contactId: entry.contactId })
      };
    });
    if (response.created !== entries.filter((entry) => entry.outcome === "created").length
      || response.enriched !== entries.filter((entry) => entry.outcome === "enriched").length
      || response.skipped !== entries.filter((entry) => entry.outcome === "skipped").length) {
      throw new GatewayError("Orchestrator returned inconsistent Contact vCard import totals.");
    }
    return {
      created: response.created,
      enriched: response.enriched,
      skipped: response.skipped,
      contactIds: response.contactIds,
      entries,
      directory: mapContactDirectory(response.directory)
    };
  }

  async exportContactsVCard(contactIds: readonly string[] = [], signal?: AbortSignal): Promise<ContactVCardExportView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(ContactService, scope.transport).exportContactsVCard({ contactIds: [...contactIds] }, { signal: scope.signal });
    scope.signal.throwIfAborted();
    return { text: response.vcardText, contactCount: response.contactCount, suggestedFileName: response.suggestedFileName };
  }

  async getContactSyncStatus(signal?: AbortSignal): Promise<ContactSyncStatusView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(ContactService, scope.transport).getContactSyncStatus({}, { signal: scope.signal });
    scope.signal.throwIfAborted();
    return mapContactSyncStatus(response.status);
  }

  async setContactSyncEnabled(expectedConfigurationRevision: bigint, enabled: boolean, signal?: AbortSignal): Promise<ContactSyncStatusView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(ContactService, scope.transport).setContactSyncEnabled({
      expectedConfigurationRevision: { value: expectedConfigurationRevision },
      enabled
    }, { signal: scope.signal });
    scope.signal.throwIfAborted();
    return mapContactSyncStatus(response.status);
  }

  async grantContactSyncPeer(nodeId: string, expectedFingerprint: string, signal?: AbortSignal): Promise<ContactSyncStatusView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(ContactService, scope.transport).grantContactSyncPeer({
      nodeId,
      expectedFingerprint
    }, { signal: scope.signal });
    scope.signal.throwIfAborted();
    return mapContactSyncStatus(response.status);
  }

  async revokeContactSyncPeer(peerId: string, expectedRevision: bigint, signal?: AbortSignal): Promise<ContactSyncStatusView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(ContactService, scope.transport).revokeContactSyncPeer({
      peerId,
      expectedRevision: { value: expectedRevision }
    }, { signal: scope.signal });
    scope.signal.throwIfAborted();
    return mapContactSyncStatus(response.status);
  }

  async syncContactsNow(peerId?: string, signal?: AbortSignal): Promise<ContactSyncStatusView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(ContactService, scope.transport).syncContactsNow({
      ...(peerId === undefined ? {} : { peerId })
    }, { signal: scope.signal });
    scope.signal.throwIfAborted();
    return mapContactSyncStatus(response.status);
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
      tcpForwarding: supported.has(RemoteHostCapabilityKind.TCP_FORWARDING),
      backendRuntimeSetup: supported.has(RemoteHostCapabilityKind.BACKEND_RUNTIME_SETUP)
    };
  }

  async listSshKeys(signal: AbortSignal): Promise<SshKeyCatalogView> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(SshKeyService, scope.transport).listSshKeys({}, { signal: scope.signal });
    scope.signal.throwIfAborted();
    return { keys: response.keys.map(mapSshKey), generationSupported: response.generationSupported,
      agentState: response.agentState === SshAgentState.READY ? "ready" : response.agentState === SshAgentState.UNAVAILABLE ? "unavailable" : "failed" };
  }

  async generateSshKey(draft: SshKeyGenerateDraft, signal: AbortSignal): Promise<SshKeyView> {
    const scope = this.captureActionScope(signal);
    const client = createClient(SshKeyService, scope.transport);
    const ticketId = draft.passphrase === undefined ? undefined : await this.uploadSshKeyPassphrase(draft.passphrase, SshKeyPassphrasePurpose.GENERATE, scope);
    scope.signal.throwIfAborted();
    const response = await client.generateSshKey({ name: draft.name, comment: draft.comment,
      ...(ticketId === undefined ? {} : { passphraseUploadTicketId: ticketId }) }, { signal: scope.signal });
    scope.signal.throwIfAborted();
    if (response.key === undefined) throw new GatewayError("The SSH key creation result is unavailable.");
    return mapSshKey(response.key);
  }

  async addSshKeyToAgent(keyId: string, expectedFingerprint: string, passphrase: string | undefined, signal: AbortSignal): Promise<void> {
    const scope = this.captureActionScope(signal);
    const client = createClient(SshKeyService, scope.transport);
    const ticketId = passphrase === undefined ? undefined : await this.uploadSshKeyPassphrase(passphrase, SshKeyPassphrasePurpose.AGENT_ADD, scope, { keyId, expectedFingerprint });
    scope.signal.throwIfAborted();
    await client.addSshKeyToAgent({ keyId, expectedFingerprint, ...(ticketId === undefined ? {} : { passphraseUploadTicketId: ticketId }) }, { signal: scope.signal });
    scope.signal.throwIfAborted();
  }

  async readSshPublicKey(keyId: string, expectedFingerprint: string, signal: AbortSignal): Promise<string> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(SshKeyService, scope.transport).readSshPublicKey({ keyId, expectedFingerprint }, { signal: scope.signal });
    scope.signal.throwIfAborted();
    return response.publicKey;
  }

  async getSshKeyInstallCommand(draft: SshKeyInstallCommandDraft, signal: AbortSignal): Promise<string> {
    const scope = this.captureActionScope(signal);
    const response = await createClient(SshKeyService, scope.transport).getSshKeyInstallCommand({
      keyId: draft.keyId, expectedFingerprint: draft.expectedFingerprint,
      destination: draft.destination.kind === "savedHost"
        ? { case: "savedHost", value: { targetId: draft.destination.targetId, hostId: draft.destination.hostId, expectedRevision: { value: draft.destination.expectedRevision } } }
        : { case: "draftHost", value: { hostname: draft.destination.hostname, user: draft.destination.user, port: draft.destination.port } },
      shell: draft.shell === "posix" ? SshInstallShell.POSIX : SshInstallShell.POWERSHELL
    }, { signal: scope.signal });
    scope.signal.throwIfAborted();
    return response.command;
  }

  private async uploadSshKeyPassphrase(secret: string, purpose: SshKeyPassphrasePurpose, scope: GatewayActionScope, key?: { keyId: string; expectedFingerprint: string }): Promise<string> {
    scope.signal.throwIfAborted();
    const response = await createClient(SshKeyService, scope.transport).beginSshKeyPassphraseUpload({ purpose, ...key }, { signal: scope.signal });
    scope.signal.throwIfAborted();
    return this.uploadCredentialTicket(secret, response.ticket, scope);
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
      if (sequence === 0n && response.update.case !== "snapshot") {
        throw new GatewayError("Orchestrator returned no initial Remote Host snapshot.");
      }
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
      ...(draft.authentication === "nodeKey" ? { nodeKey: draft.nodeKey } : {}),
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
      ...(draft.authentication === "nodeKey" ? { nodeKey: draft.nodeKey } : {}),
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

  async probeRemoteBackendRuntime(
    targetId: string,
    hostId: string,
    expectedTargetRevision: bigint,
    expectedHostRevision: bigint,
    signal?: AbortSignal
  ): Promise<RemoteBackendRuntimeView> {
    const response = await createClient(RemoteHostService, this.requireTransport()).probeRemoteBackendRuntime({
      targetId,
      hostId,
      expectedTargetRevision: { value: expectedTargetRevision },
      expectedHostRevision: { value: expectedHostRevision }
    }, remoteHostRpcOptions(this.#abort?.signal, signal));
    return requireRemoteBackendRuntime(
      response.runtime,
      targetId,
      hostId,
      expectedTargetRevision,
      expectedHostRevision
    );
  }

  async *installRemoteBackendRuntime(
    targetId: string,
    hostId: string,
    expectedTargetRevision: bigint,
    expectedHostRevision: bigint,
    reinstall: boolean,
    signal?: AbortSignal
  ): AsyncGenerator<RemoteBackendRuntimeInstallEventView> {
    const requestId = randomUuid();
    const stream = createClient(RemoteHostService, this.requireTransport()).installRemoteBackendRuntime({
      requestId,
      targetId,
      hostId,
      expectedTargetRevision: { value: expectedTargetRevision },
      expectedHostRevision: { value: expectedHostRevision },
      reinstall
    }, remoteHostRpcOptions(this.#abort?.signal, signal));
    let sequence = 0n;
    let terminal = false;
    for await (const response of stream) {
      if (terminal || response.requestId !== requestId || response.sequence !== sequence + 1n || response.runtime === undefined || response.observedAt === undefined) {
        throw new GatewayError("Orchestrator returned invalid remote Backend runtime progress.");
      }
      sequence = response.sequence;
      const phase = remoteBackendRuntimeInstallPhase(response.phase);
      const runtime = requireRemoteBackendRuntime(
        response.runtime,
        targetId,
        hostId,
        expectedTargetRevision,
        expectedHostRevision
      );
      if ((phase === "probing" && runtime.state !== "probing")
        || ((phase === "downloading" || phase === "installing" || phase === "validating") && runtime.state !== "installing")
        || (phase === "complete" && runtime.state !== "ready")
        || (phase === "outcomeUnknown" && runtime.state !== "outcomeUnknown")) {
        throw new GatewayError("Orchestrator returned inconsistent remote Backend runtime progress.");
      }
      terminal = phase === "complete" || phase === "failed" || phase === "outcomeUnknown";
      yield {
        requestId,
        sequence,
        phase,
        runtime,
        observedAt: timestampMs(response.observedAt)
      };
    }
    if (!terminal && signal?.aborted !== true && this.#abort?.signal.aborted !== true) {
      throw new GatewayError("Remote Backend runtime installation ended without a terminal result.");
    }
  }

  async uninstallRemoteBackendRuntime(
    targetId: string,
    hostId: string,
    expectedTargetRevision: bigint,
    expectedHostRevision: bigint
  ): Promise<RemoteBackendRuntimeView> {
    const response = await createClient(RemoteHostService, this.requireTransport()).uninstallRemoteBackendRuntime({
      requestId: randomUuid(),
      targetId,
      hostId,
      expectedTargetRevision: { value: expectedTargetRevision },
      expectedHostRevision: { value: expectedHostRevision }
    }, remoteHostRpcOptions(this.#abort?.signal));
    return requireRemoteBackendRuntime(
      response.runtime,
      targetId,
      hostId,
      expectedTargetRevision,
      expectedHostRevision
    );
  }

  async saveMcpServer(draft: McpServerDraft): Promise<void> {
    const id = draft.id.trim() || randomUuid();
    const credentialBindings = draft.credentialBindings.map((binding) => ({
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
    const endpoint = draft.transport !== "stdio" ? canonicalMcpEndpoint(draft.endpoint) : "";
    const server = create(
      McpServerInputSchema,
      draft.transport === "stdio"
        ? {
          displayName: draft.name.trim(),
          transport: McpTransport.STDIO,
          credentialBindings,
          enabled: draft.enabled,
          transportConfig: { case: "stdio", value: { command: draft.command.trim(), arguments: [...draft.arguments], workingDirectory: draft.workingDirectory.trim(), environment } }
          }
        : {
          displayName: draft.name.trim(),
          transport: draft.transport === "sse" ? McpTransport.HTTP_SSE : McpTransport.HTTPS_STREAMABLE_HTTP,
          credentialBindings,
          enabled: draft.enabled,
          transportConfig: { case: draft.transport === "sse" ? "sse" : "streamableHttp", value: { endpoint } }
          }
    );
    if (server.displayName.length === 0 || (draft.transport === "stdio" ? draft.command.trim().length === 0 : endpoint.length === 0)) throw new GatewayError("MCP name and transport configuration are required.");
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
            automationTarget: protoBrowserAutomationTarget(patch.automationTarget)
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
    const scope = this.captureActionScope();
    const secret = draft.secret?.trim();
    const fallbackSecret = draft.fallbackSecret?.trim();
    const credentialUploadTicketId = secret === undefined || secret === ""
      ? undefined
      : await this.uploadCredential(secret, CredentialKind.API_KEY, "", scope);
    scope.signal.throwIfAborted();
    const fallbackCredentialUploadTicketId = fallbackSecret === undefined || fallbackSecret === ""
      ? undefined
      : await this.uploadCredential(fallbackSecret, CredentialKind.API_KEY, "", scope);
    scope.signal.throwIfAborted();
    await this.submit({
      case: "updateVoiceInputServiceSettings",
      value: {
        patch: {
          enabled: draft.enabled,
          protocol: protoVoiceInputProtocol(draft.protocol),
          endpoint: draft.endpoint.trim(),
          model: draft.model.trim(),
          resourceId: draft.resourceId.trim(),
          keyless: draft.keyless,
          ...(credentialUploadTicketId === undefined ? {} : { credentialUploadTicketId }),
          ...(draft.clearCredential === undefined ? {} : { clearCredential: draft.clearCredential }),
          refinementEnabled: draft.refinementEnabled,
          refinerModel: draft.refinerModel ?? { backendId: "", providerId: "", modelId: "" },
          refinerFallbackModel: draft.refinerFallbackModel ?? { backendId: "", providerId: "", modelId: "" },
          fallbackEnabled: draft.fallbackEnabled,
          fallbackProtocol: protoVoiceInputProtocol(draft.fallbackProtocol),
          fallbackEndpoint: draft.fallbackEndpoint.trim(),
          fallbackModel: draft.fallbackModel.trim(),
          fallbackResourceId: draft.fallbackResourceId.trim(),
          fallbackKeyless: draft.fallbackKeyless,
          ...(fallbackCredentialUploadTicketId === undefined ? {} : { fallbackCredentialUploadTicketId }),
          ...(draft.clearFallbackCredential === undefined ? {} : { clearFallbackCredential: draft.clearFallbackCredential }),
          expectedRevision: { value: draft.expectedRevision }
        }
      }
    }, true, [], scope.signal);
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
    readonly removedEntries?: number;
    readonly removedTargets?: number;
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
      ...(result.value.removedEntries === undefined
        ? {}
        : { removedEntries: numberValue(result.value.removedEntries) }),
      ...(result.value.removedTargets === undefined
        ? {}
        : { removedTargets: numberValue(result.value.removedTargets) })
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

  async updateAuxiliaryTextSettings(models: Parameters<OperationApi["updateAuxiliaryTextSettings"]>[0], expectedRevision: bigint): Promise<void> {
    await this.submit({
      case: "updateAuxiliaryTextSettings",
      value: {
        models: models.map((route) => ({ ...route })),
        expectedRevision: { value: expectedRevision }
      }
    }, true);
  }

  async updatePromptRecommendationSettings(enabled: boolean): Promise<void> {
    await this.submit({
      case: "updatePromptRecommendationSettings",
      value: { patch: { enabled } }
    }, true);
  }

  async updateSubagentModelSettings(backendId: string, model: Parameters<OperationApi["updateSubagentModelSettings"]>[1], expectedRevision: bigint): Promise<void> {
    await this.submit({
      case: "updateSubagentModelSettings",
      value: {
        backendId,
        ...(model === undefined ? { clearDefaultModel: true } : { model: { ...model } }),
        expectedRevision: { value: expectedRevision }
      }
    }, true);
  }

  async updateSubagentSmartRouting(backendId: string, enabled: boolean, expectedRevision: bigint): Promise<void> {
    await this.submit({
      case: "updateSubagentModelSettings",
      value: { backendId, smartRoutingEnabled: enabled, expectedRevision: { value: expectedRevision } }
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
    expectedGeneration: bigint,
    signal: AbortSignal
  ): Promise<string> {
    signal.throwIfAborted();
    const client = createClient(SessionService, this.requireTransport());
    const requestSignal = this.#abort === undefined ? signal : AbortSignal.any([signal, this.#abort.signal]);
    requestSignal.throwIfAborted();
    const response = await client.predictNextPrompt({
      sessionId,
      expectedLastActivityAt: timestampFromMs(expectedLastActivityAt),
      expectedGeneration
    }, { signal: requestSignal });
    requestSignal.throwIfAborted();
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

  private artifactDownloadContext(context: ArtifactDownloadContext): ArtifactDownloadContext {
    this.requireTransport();
    const connection = this.#abort;
    if (connection === undefined) throw new GatewayError("Connect to Joko before downloading an artifact.");
    const signal = AbortSignal.any([context.signal, connection.signal]);
    signal.throwIfAborted();
    return { ownerDocument: context.ownerDocument, signal };
  }

  async downloadArtifact(blobId: string, fileName: string, context: ArtifactDownloadContext): Promise<ArtifactDownloadOutcome> {
    const ownedContext = this.artifactDownloadContext(context);
    // The trusted host capability is separate from a detached view's Document.
    // Inspector windows do not receive filesystem IPC authority.
    const desktop = typeof window === "undefined" ? undefined : window.jokoDesktop;
    const nativeSave = desktop?.saveFile.bind(desktop);
    const blob = await this.fetchArtifact(blobId, ownedContext.signal);
    ownedContext.signal.throwIfAborted();
    return saveArtifactBlob(blob, fileName, ownedContext, nativeSave);
  }

  async copyArtifactFile(blobId: string, fileName: string, byteSize: number, context: ArtifactDownloadContext): Promise<import("./native-file-actions.js").NativeFileCopyOutcome> {
    const ownedContext = this.artifactDownloadContext(context);
    const host = captureNativeFileCopy();
    if (host === undefined) return { status: "unavailable" };
    if (!Number.isSafeInteger(byteSize) || byteSize < 0 || byteSize > NATIVE_FILE_COPY_MAXIMUM_BYTES) return { status: "failed", reason: "capacity" };
    const blob = await this.fetchArtifact(blobId, ownedContext.signal);
    return copyNativeArtifactFile(blob, fileName, ownedContext, host);
  }

  async openArtifactFile(blobId: string, fileName: string, byteSize: number, context: ArtifactDownloadContext): Promise<import("./native-file-actions.js").NativeFileOpenOutcome> {
    const ownedContext = this.artifactDownloadContext(context);
    const host = captureNativeFileOpen();
    if (host === undefined) return { status: "unavailable" };
    if (!Number.isSafeInteger(byteSize) || byteSize < 0 || byteSize > NATIVE_FILE_OPEN_MAXIMUM_BYTES) return { status: "failed", reason: "capacity" };
    const blob = await this.fetchArtifact(blobId, ownedContext.signal);
    return openNativeArtifactFile(blob, fileName, ownedContext, host);
  }

  async revealArtifactSource(sessionId: string, artifactId: string, context: ArtifactDownloadContext): Promise<import("./native-file-actions.js").NativeArtifactSourceRevealOutcome> {
    const ownedContext = this.artifactDownloadContext(context);
    const host = captureNativeArtifactSourceReveal();
    const profile = this.#profile;
    if (host === undefined || profile === undefined) return { status: "unavailable" };
    return revealNativeArtifactSource(
      profile.id,
      profile.serverId,
      sessionId,
      artifactId,
      ownedContext,
      host
    );
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
    preconditions: readonly MutationPrecondition[] = [],
    callerSignal?: AbortSignal
  ): Promise<Operation> {
    callerSignal?.throwIfAborted();
    const transport = this.requireTransport();
    const client = createClient(OperationService, transport);
    const operationId = randomUuid();
    const request = {
      operationId,
      connectionId: this.#profile?.id ?? "",
      mutation: create(OperationMutationSchema, { payload, preconditions: [...preconditions] })
    };
    const signal = combinedAbortSignal(callerSignal, this.#abort?.signal);
    const options = signal === undefined ? undefined : { signal };
    const submitOnce = () => { signal?.throwIfAborted(); return client.submitOperation(request, options); };
    let response;
    try {
      response = await submitOnce();
    } catch (error) {
      // A dropped unary response does not say whether Orchestrator durably claimed
      // the effect. Re-submit the exact request under the same idempotency key;
      // never mint a second operation ID inside one user attempt.
      if (signal?.aborted === true || !isUncertainOperationSubmissionError(error)) throw error;
      response = await submitOnce();
    }
    callerSignal?.throwIfAborted();
    if (response.operation === undefined) throw new GatewayError("Orchestrator accepted no operation.");
    let operation = response.operation;
    if (waitForTerminal && !TERMINAL_OPERATION_STATES.has(operation.state)) {
      const timeout = AbortSignal.timeout(OPERATION_TERMINAL_WAIT_TIMEOUT_MS);
      for await (const update of client.watchOperation({
        operationId,
        afterRevision: operation.version?.revision
      }, { signal: combinedAbortSignal(callerSignal, timeout) })) {
        callerSignal?.throwIfAborted();
        if (update.operation === undefined) continue;
        operation = update.operation;
        if (TERMINAL_OPERATION_STATES.has(operation.state)) break;
      }
      if (!TERMINAL_OPERATION_STATES.has(operation.state)) {
        callerSignal?.throwIfAborted();
        const reconciled = await client.getOperation({ operationId }, options);
        callerSignal?.throwIfAborted();
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
    callerSignal?.throwIfAborted();
    void this.refresh().catch((error: unknown) => { if (!signal?.aborted) this.#callbacks.onError?.(normalizeError(error)); });
    return operation;
  }

  private async uploadAttachment(file: File, scope: GatewayActionScope): Promise<Record<string, unknown>> {
    return this.uploadBlob(file, BlobDisposition.ATTACHMENT, scope);
  }

  private async uploadBlob(file: File, disposition: BlobDisposition, scope: GatewayActionScope): Promise<Record<string, unknown>> {
    scope.signal.throwIfAborted();
    const client = createClient(ArtifactService, scope.transport);
    const bytes = await file.arrayBuffer();
    scope.signal.throwIfAborted();
    const digest = await sha256Hex(bytes);
    scope.signal.throwIfAborted();
    const response = await client.beginBlobUpload({
      fileName: file.name,
      mediaType: file.type || "application/octet-stream",
      byteSize: BigInt(file.size),
      sha256Hex: digest,
      disposition
    }, { signal: scope.signal });
    scope.signal.throwIfAborted();
    const upload = response.upload;
    const endpoint = upload?.ticket?.relativeEndpoint;
    if (upload === undefined || endpoint === undefined || endpoint.length === 0) throw new GatewayError("Orchestrator returned no upload ticket.");
    const uploadResponse = await fetch(this.authorizedEndpoint(endpoint), {
      method: "PUT",
      headers: {
        authorization: `Bearer ${scope.authKey}`,
        "content-type": "application/octet-stream"
      },
      body: file,
      signal: scope.signal
    });
    scope.signal.throwIfAborted();
    if (!uploadResponse.ok) throw new GatewayError(`Attachment upload failed (${uploadResponse.status}).`);
    const completed = await client.completeBlobUpload({ uploadId: upload.uploadId }, { signal: scope.signal });
    scope.signal.throwIfAborted();
    if (completed.blob === undefined) throw new GatewayError("Orchestrator did not commit the uploaded attachment.");
    return completed.blob as unknown as Record<string, unknown>;
  }

  private async fetchArtifact(blobId: string, callerSignal?: AbortSignal): Promise<Blob> {
    const transport = this.requireTransport();
    const signal = combinedAbortSignal(callerSignal, this.#abort?.signal);
    signal?.throwIfAborted();
    const authKey = this.#authKey;
    const client = createClient(ArtifactService, transport);
    const response = await client.getBlobDownloadTicket({ blobId }, { signal });
    signal?.throwIfAborted();
    const endpoint = response.ticket?.relativeEndpoint;
    if (endpoint === undefined || endpoint.length === 0) throw new GatewayError("Orchestrator returned no download ticket.");
    const download = await fetch(this.authorizedEndpoint(endpoint), {
      headers: { authorization: `Bearer ${authKey ?? ""}` },
      cache: "no-store",
      signal
    });
    signal?.throwIfAborted();
    if (!download.ok) throw new GatewayError(`Artifact download failed (${download.status}).`);
    const blob = await download.blob();
    signal?.throwIfAborted();
    return blob;
  }

  private captureActionScope(callerSignal?: AbortSignal): GatewayActionScope {
    const transport = this.requireTransport();
    if (this.#abort === undefined || this.#authKey === undefined) {
      throw new GatewayError("Connect to Orchestrator before performing this action.", { offline: true });
    }
    const signal = callerSignal === undefined ? this.#abort.signal : AbortSignal.any([callerSignal, this.#abort.signal]);
    signal.throwIfAborted();
    return { transport, authKey: this.#authKey, signal };
  }

  private async uploadCredential(
    secret: string,
    kind: CredentialKind,
    providerId: string,
    scope: GatewayActionScope,
    surface?: { readonly backendId: string; readonly surfaceId: string }
  ): Promise<string> {
    scope.signal.throwIfAborted();
    const client = createClient(CredentialService, scope.transport);
    const response = await client.beginCredentialUpload({
      kind,
      providerId,
      ...(surface === undefined ? {} : {
        backendId: surface.backendId,
        credentialSurfaceId: surface.surfaceId
      })
    }, { signal: scope.signal });
    scope.signal.throwIfAborted();
    return this.uploadCredentialTicket(secret, response.ticket, scope);
  }

  private async uploadCredentialTicket(secret: string, ticket: CredentialUploadTicket | undefined, scope: GatewayActionScope): Promise<string> {
    scope.signal.throwIfAborted();
    if (ticket === undefined || ticket.ticketId.length === 0 || ticket.relativeEndpoint.length === 0) {
      throw new GatewayError("Orchestrator has no credential channel available for this credential input.");
    }
    const bytes = new TextEncoder().encode(secret);
    try {
      if (ticket.maximumBytes > 0n && BigInt(bytes.byteLength) > ticket.maximumBytes) {
        throw new GatewayError("The credential input exceeds the credential channel limit.");
      }
      scope.signal.throwIfAborted();
      const upload = await fetch(this.authorizedEndpoint(ticket.relativeEndpoint), {
        method: "PUT",
        headers: {
          authorization: `Bearer ${scope.authKey}`,
          "content-type": "application/octet-stream"
        },
        body: bytes,
        signal: scope.signal
      });
      scope.signal.throwIfAborted();
      if (!upload.ok) throw new GatewayError(`Credential input upload failed (${upload.status}).`);
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
    case "browserActivity":
      break;
    case "nativeSessionChanged":
      // A marker can remove the whole active prefix; only the service owns
      // which durable events remain visible on this native branch.
      refresh = "authoritative";
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
  const revision = target.version?.revision?.value;
  if (revision === undefined || revision < 1n) throw new GatewayError("Orchestrator returned a Target without a current revision.");
  const workspace = workspaces.find((candidate) => candidate.workspaceId === target.workspaceId);
  return {
    id: target.targetId,
    revision,
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
      const userInputAccepted = kind.value.role === 1 && kind.value.userInputAccepted === true;
      const inputMentions = messageInputMentions(userInput);
      if (!userInputAccepted && (inputMentions.length > 0 || userInput?.mentionRanges.length || userInput?.pastedTextRanges.length || userInput?.quotesEncoded)) {
        throw new GatewayError("Orchestrator returned structured user input without an accepted receipt.");
      }
      const pastedTextRanges = userText === undefined
        ? []
        : messageInputPastedTextRanges(userInput, userText);
      const mentionRanges = messageInputMentionRanges(userInput, userText ?? "", inputMentions.length, pastedTextRanges);
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
        ...(userInputAccepted ? { userInputAccepted: true } : {}),
        ...(userInputAccepted && inputMentions.length > 0 ? { inputMentions } : {}),
        ...(userInputAccepted && mentionRanges.length > 0 ? { mentionRanges } : {}),
        ...(userInputAccepted && userInput?.quotesEncoded === true ? { quotesEncoded: true } : {}),
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
            ...(item.userInputAccepted === true || kind.value.blocks.length === 0 ? {} : { text: finalText, attachments })
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
          ? { artifact: { id: blob.blobId, blobId: blob.blobId, sourceRevealAvailable: false, title: image?.altText || blob.fileName || "Image", kind: "image", fileName: blob.fileName || "image", mediaType: blob.mediaType || "application/octet-stream", byteSize: numberValue(blob.byteSize) } satisfies ArtifactView }
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
        ...(changeSet?.runId ? { runId: changeSet.runId } : {}),
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
      sourceRevealAvailable: false,
      title: artifact?.audioMetadata?.title.trim() || image?.altText || artifact?.label || fileName,
      ...(artifact?.audioMetadata === undefined ? {} : { audioMetadata: mapAudioMetadata(artifact.audioMetadata) }),
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
    extensions: snapshot.extensionCatalog?.entries.map(mapExtensionCatalogEntry) ?? [],
    extensionCatalogRevision: snapshot.extensionCatalog?.revision?.value ?? 0n,
    extensionCatalogRecovered: snapshot.extensionCatalog?.recoveredFromCorruption ?? false,
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
    case "elevenLabsScribeRealtime": return VoiceInputTranscriptionProtocol.ELEVENLABS_SCRIBE_REALTIME;
    case "volcengineSauc": return VoiceInputTranscriptionProtocol.VOLCENGINE_SAUC;
  }
}

function voiceInputProtocolView(value: VoiceInputTranscriptionProtocol): VoiceInputTranscriptionProtocolView {
  switch (value) {
    case VoiceInputTranscriptionProtocol.OPENAI_COMPATIBLE_BATCH: return "openAiCompatibleBatch";
    case VoiceInputTranscriptionProtocol.OPENAI_COMPATIBLE_REALTIME: return "openAiCompatibleRealtime";
    case VoiceInputTranscriptionProtocol.QWEN_COMPATIBLE_REALTIME: return "qwenCompatibleRealtime";
    case VoiceInputTranscriptionProtocol.ELEVENLABS_SCRIBE_REALTIME: return "elevenLabsScribeRealtime";
    case VoiceInputTranscriptionProtocol.VOLCENGINE_SAUC: return "volcengineSauc";
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
    ...(backend.providerRuntimeSupport === undefined ? {} : { providerRuntimeSupport: {
      protocols: backend.providerRuntimeSupport.protocols.map(providerCompatibility),
      fields: backend.providerRuntimeSupport.fields.flatMap((field) => {
        const mapped = providerConfigurationField(field);
        return mapped === undefined ? [] : [mapped];
      })
    } }),
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
    case WorktreeEligibility.GIT_NOT_FOUND: return "gitNotFound";
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
  existing?: Pick<TimelineItemView, "nativeEntryId" | "nativeParentEntryId" | "nativeRewindBefore">
): Pick<TimelineItemView, "nativeEntryId" | "nativeParentEntryId" | "nativeRewindBefore"> {
  const payload = event.payload?.kind;
  const identity = payload?.case === "messageStarted" || payload?.case === "messageCompleted"
    ? payload.value.nativeIdentity
    : undefined;
  const nativeEntryId = identity?.entryId || existing?.nativeEntryId;
  const nativeParentEntryId = identity?.parentEntryId || existing?.nativeParentEntryId;
  const target = identity?.rewindBefore?.kind;
  const nativeRewindBefore: import("./model.js").NativeNavigationTargetView | undefined = identity === undefined ? existing?.nativeRewindBefore
    : target?.case === "sessionStart" ? { kind: "session_start" }
      : target?.case === "nativeEntryId" && target.value.length > 0 && target.value.length <= 4_096 && !/[\u0000-\u001f\u007f]/u.test(target.value)
        ? { kind: "native_entry", entryId: target.value } : undefined;
  return {
    ...(nativeEntryId === undefined || nativeEntryId.length === 0 ? {} : { nativeEntryId }),
    ...(nativeParentEntryId === undefined || nativeParentEntryId.length === 0 ? {} : { nativeParentEntryId }),
    nativeRewindBefore
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
  const text = messageInputText(item.input);
  const inputMentions = messageInputMentions(item.input);
  const pastedTextRanges = messageInputPastedTextRanges(item.input, text);
  const mentionRanges = messageInputMentionRanges(item.input, text, inputMentions.length, pastedTextRanges);
  const attachments = messageInputAttachments(item.input);
  return {
    id: item.queueItemId,
    sessionId: item.sessionId,
    revision: version.revision,
    generation: version.generation,
    source: queueSource(item.sourceKind),
    mode: uiDeliveryMode(item.deliveryMode),
    text,
    ...(item.input?.quotesEncoded === true ? { quotesEncoded: true } : {}),
    ...(pastedTextRanges.length === 0 ? {} : { pastedTextRanges }),
    ...(inputMentions.length === 0 ? {} : { inputMentions }),
    ...(mentionRanges.length === 0 ? {} : { mentionRanges }),
    ...(attachments.length === 0 ? {} : { attachments }),
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
    validateQuestionRequestDeclaration(request.value.fields);
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
    case "singleChoice": {
      const selection = answer.value.value.selection;
      if (selection.case === "choiceId") return { kind: "text", values: [questionChoiceLabel(field, selection.value)] };
      if (selection.case === "otherText") return { kind: "text", values: [selection.value] };
      return undefined;
    }
    case "multipleChoice": return {
      kind: "text",
      values: [
        ...answer.value.value.choiceIds.map((value) => questionChoiceLabel(field, value)),
        ...(answer.value.value.otherText === undefined ? [] : [answer.value.value.otherText])
      ]
    };
    case "boolean": return { kind: "boolean", value: answer.value.value };
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
    minimumSelections: 0,
    allowOther: false
  };
  if (input.case === "singleChoice") {
    if (input.value.allowOther === undefined) throw new GatewayError("Question choice fields require explicit free-text authority.");
    return {
      ...base,
      kind: "single",
      options: input.value.choices.map(mapQuestionChoice),
      allowOther: input.value.allowOther,
      ...(input.value.defaultChoiceId.length > 0 ? { defaultValue: input.value.defaultChoiceId } : {})
    };
  }
  if (input.case === "multipleChoice") {
    if (input.value.allowOther === undefined) throw new GatewayError("Question choice fields require explicit free-text authority.");
    return {
      ...base,
      kind: "multiple",
      options: input.value.choices.map(mapQuestionChoice),
      defaultValue: [...input.value.defaultChoiceIds],
      minimumSelections: input.value.minimumSelections,
      allowOther: input.value.allowOther,
      ...(input.value.maximumSelections > 0 ? { maximumSelections: input.value.maximumSelections } : {})
    };
  }
  if (input.case === "boolean") return { ...base, kind: "boolean", defaultValue: input.value.defaultValue };
  if (input.case === "text") return {
    ...base,
    kind: "text",
    ...(input.value.placeholder.length > 0 ? { placeholder: input.value.placeholder } : {}),
    defaultValue: input.value.defaultValue,
    multiline: input.value.multiline
  };
  throw new GatewayError("This question has a field without a current input type.");
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

const RESOURCE_USAGE_COUNT_KEYS = [
  "samples",
  "strongActive",
  "semiActive",
  "passiveExposures",
  "reads",
  "rereads",
  "toolCalls",
  "toolErrors",
  "commands",
  "commandFailures"
] as const;

function mapResourceUsageReport(
  report: ProtoResourceUsageReport,
  requestedResourceId: string,
  requestedTimeZone: string
): ResourceUsageReportView {
  if (
    requestedResourceId.trim() === "" || requestedResourceId.length > 4_096 ||
    report.resourceId !== requestedResourceId || report.timeZone !== requestedTimeZone ||
    !validResourceUsageTimeZone(report.timeZone) || !validResourceUsageDay(report.fromDay) ||
    !validResourceUsageDay(report.throughDay) || report.days.length !== 30 ||
    addResourceUsageDays(report.fromDay, 29) !== report.throughDay
  ) throw new GatewayError("The service returned an invalid Resource usage report authority.");

  const days = report.days.map((day, index) => {
    const expectedDay = addResourceUsageDays(report.fromDay, index);
    if (day.localDay !== expectedDay) throw new GatewayError("The service returned an invalid Resource usage day series.");
    return { localDay: day.localDay, metrics: mapResourceUsageMetrics(day.metrics) };
  });
  const totals = mapResourceUsageMetrics(report.totals);

  const sourceIdentities = new Set<ResourceUsageSourceView>();
  const sources = report.sources.map((entry) => {
    const source = mapResourceUsageSource(entry.source);
    if (sourceIdentities.has(source)) throw new GatewayError("The service returned duplicate Resource usage sources.");
    sourceIdentities.add(source);
    return { source, metrics: mapResourceUsageMetrics(entry.metrics) };
  });

  const agentIdentities = new Set<string>();
  const agents = report.agents.map((entry) => {
    const backendId = entry.backendId;
    if (
      backendId.trim() === "" || backendId.length > 4_096 || privatePathLikeLabel(backendId) ||
      agentIdentities.has(backendId)
    ) throw new GatewayError("The service returned an invalid Resource usage Backend breakdown.");
    agentIdentities.add(backendId);
    return { backendId, metrics: mapResourceUsageMetrics(entry.metrics) };
  });

  const versionIdentities = new Set<string>();
  const versions = report.versions.map((entry) => {
    const mapped = mapResourceUsageVersion(entry);
    const identity = resourceUsageVersionKey(mapped);
    if (versionIdentities.has(identity)) throw new GatewayError("The service returned duplicate Resource usage versions.");
    versionIdentities.add(identity);
    return mapped;
  });

  if (
    !resourceUsageCountsMatch(days, totals) ||
    !resourceUsageCountsMatch(sources, totals) ||
    !resourceUsageCountsMatch(agents, totals) ||
    !resourceUsageCountsMatch(versions, totals)
  ) throw new GatewayError("The service returned inconsistent Resource usage totals.");

  const comparison = mapResourceUsageComparison(report, versions);
  const projection = mapResourceUsageProjection(report);
  return {
    resourceId: report.resourceId,
    timeZone: report.timeZone,
    fromDay: report.fromDay,
    throughDay: report.throughDay,
    days,
    totals,
    sources,
    agents,
    versions,
    comparison,
    projection
  };
}

function mapResourceUsageMetrics(value: ProtoResourceUsageMetrics | undefined): ResourceUsageMetricsView {
  if (value === undefined) throw new GatewayError("The service returned incomplete Resource usage metrics.");
  const metrics = {
    samples: exactSafeUnsignedNumber(value.samples),
    strongActive: exactSafeUnsignedNumber(value.strongActive),
    semiActive: exactSafeUnsignedNumber(value.semiActive),
    passiveExposures: exactSafeUnsignedNumber(value.passiveExposures),
    reads: exactSafeUnsignedNumber(value.reads),
    rereads: exactSafeUnsignedNumber(value.rereads),
    toolCalls: exactSafeUnsignedNumber(value.toolCalls),
    toolErrors: exactSafeUnsignedNumber(value.toolErrors),
    commands: exactSafeUnsignedNumber(value.commands),
    commandFailures: exactSafeUnsignedNumber(value.commandFailures)
  };
  if (Object.values(metrics).some((entry) => entry === undefined)) {
    throw new GatewayError("The service returned unsafe Resource usage metrics.");
  }
  const safe = metrics as { readonly [K in typeof RESOURCE_USAGE_COUNT_KEYS[number]]: number };
  if (
    safe.strongActive + safe.semiActive + safe.passiveExposures !== safe.samples ||
    safe.rereads > safe.reads || safe.reads > safe.samples ||
    safe.toolErrors > safe.toolCalls || safe.toolCalls > safe.samples ||
    safe.commandFailures > safe.commands || safe.commands > safe.samples ||
    safe.reads + safe.toolCalls + safe.commands > safe.samples
  ) throw new GatewayError("The service returned inconsistent Resource usage metrics.");
  const latestUsedAt = optionalResourceUsageTimestamp(value.latestUsedAt);
  return { ...safe, ...(latestUsedAt === undefined ? {} : { latestUsedAt }) };
}

function mapResourceUsageSource(value: ProtoResourceUsageSource): ResourceUsageSourceView {
  switch (value) {
    case ProtoResourceUsageSource.STRUCTURED_RESOURCE_MENTION: return "structuredResourceMention";
    case ProtoResourceUsageSource.NATIVE_SKILL_COMMAND: return "nativeSkillCommand";
    case ProtoResourceUsageSource.RUNTIME_CONFIRMED_RESOURCE_LOAD: return "runtimeConfirmedResourceLoad";
    case ProtoResourceUsageSource.EXACT_FILE_READ: return "exactFileRead";
    case ProtoResourceUsageSource.RUNTIME_TOOL_CALL: return "runtimeToolCall";
    default: throw new GatewayError("The service returned an unknown Resource usage source.");
  }
}

function mapResourceUsageVersion(value: ProtoResourceUsageVersionBreakdown): ResourceUsageVersionBreakdownView {
  const revision = value.identity?.resourceRevision?.value;
  const contentRevision = value.identity?.contentRevision ?? "";
  const version = value.identity?.version;
  if (
    revision === undefined || revision < 1n ||
    !/^sha256:[a-f0-9]{64}$/u.test(contentRevision) ||
    (version !== undefined && (version.trim() === "" || version.length > 256))
  ) throw new GatewayError("The service returned an invalid Resource usage version identity.");
  const metrics = mapResourceUsageMetrics(value.metrics);
  const firstUsedAt = optionalResourceUsageTimestamp(value.firstUsedAt);
  if ((metrics.samples === 0) !== (firstUsedAt === undefined)) {
    throw new GatewayError("The service returned inconsistent Resource usage version timing.");
  }
  return {
    identity: {
      resourceRevision: revision,
      contentRevision,
      ...(version === undefined ? {} : { version })
    },
    metrics,
    ...(firstUsedAt === undefined ? {} : { firstUsedAt })
  };
}

function mapResourceUsageComparison(
  report: ProtoResourceUsageReport,
  versions: readonly ResourceUsageVersionBreakdownView[]
): ResourceUsageReportView["comparison"] {
  const value = report.comparison;
  if (value === undefined || !Number.isSafeInteger(value.minimumSamples) || value.minimumSamples < 1) {
    throw new GatewayError("The service returned an invalid Resource usage comparison.");
  }
  const current = value.current === undefined ? undefined : mapResourceUsageVersion(value.current);
  const previous = value.previous === undefined ? undefined : mapResourceUsageVersion(value.previous);
  for (const compared of [current, previous]) {
    if (compared === undefined) continue;
    const canonical = versions.find((entry) => resourceUsageVersionKey(entry) === resourceUsageVersionKey(compared));
    if (canonical === undefined || !resourceUsageMetricsEqual(canonical.metrics, compared.metrics)
      || canonical.firstUsedAt !== compared.firstUsedAt) {
      throw new GatewayError("The service returned an unanchored Resource usage comparison.");
    }
  }
  const unavailableReason = value.unavailableReason === undefined
    ? undefined
    : mapResourceUsageComparisonReason(value.unavailableReason);
  if (value.available) {
    if (
      unavailableReason !== undefined || current === undefined || previous === undefined ||
      current.metrics.samples < value.minimumSamples || previous.metrics.samples < value.minimumSamples
    ) throw new GatewayError("The service returned an inconsistent available Resource usage comparison.");
  } else {
    const validUnavailable = unavailableReason === "noCurrentVersion"
      ? current === undefined && previous === undefined
      : unavailableReason === "noPreviousVersion"
        ? current !== undefined && previous === undefined
        : unavailableReason === "currentSamples"
          ? current !== undefined && previous !== undefined && current.metrics.samples < value.minimumSamples
          : unavailableReason === "previousSamples"
            ? current !== undefined && previous !== undefined
              && current.metrics.samples >= value.minimumSamples
              && previous.metrics.samples < value.minimumSamples
            : false;
    if (!validUnavailable) throw new GatewayError("The service returned an inconsistent unavailable Resource usage comparison.");
  }
  return {
    available: value.available,
    minimumSamples: value.minimumSamples,
    ...(unavailableReason === undefined ? {} : { unavailableReason }),
    ...(current === undefined ? {} : { current }),
    ...(previous === undefined ? {} : { previous })
  };
}

function mapResourceUsageComparisonReason(
  value: ProtoResourceUsageComparisonUnavailableReason
): NonNullable<ResourceUsageReportView["comparison"]["unavailableReason"]> {
  switch (value) {
    case ProtoResourceUsageComparisonUnavailableReason.NO_CURRENT_VERSION: return "noCurrentVersion";
    case ProtoResourceUsageComparisonUnavailableReason.NO_PREVIOUS_VERSION: return "noPreviousVersion";
    case ProtoResourceUsageComparisonUnavailableReason.CURRENT_SAMPLES: return "currentSamples";
    case ProtoResourceUsageComparisonUnavailableReason.PREVIOUS_SAMPLES: return "previousSamples";
    default: throw new GatewayError("The service returned an unknown Resource usage comparison reason.");
  }
}

function mapResourceUsageProjection(report: ProtoResourceUsageReport): ResourceUsageReportView["projection"] {
  const value = report.projection;
  if (
    value === undefined || !Number.isSafeInteger(value.streamCount) || value.streamCount < 0 ||
    !Number.isSafeInteger(value.pendingStreamCount) || value.pendingStreamCount < 0 ||
    value.pendingStreamCount > value.streamCount
  ) throw new GatewayError("The service returned an invalid Resource usage projection status.");
  const lastProjectedAt = optionalResourceUsageTimestamp(value.lastProjectedAt);
  const failureIdentities = new Set<string>();
  const failures = value.failures.map((failure) => {
    const source = mapResourceUsageSource(failure.source);
    const retryAt = requiredResourceUsageTimestamp(failure.retryAt);
    const identity = `${failure.sessionId}\u0000${source}`;
    if (
      failure.sessionId.trim() === "" || failure.sessionId.length > 4_096 ||
      !Number.isSafeInteger(failure.attempts) || failure.attempts < 1 ||
      !/^[A-Z][A-Z0-9_]{0,127}$/u.test(failure.errorCode) || failureIdentities.has(identity)
    ) throw new GatewayError("The service returned an invalid Resource usage projection failure.");
    failureIdentities.add(identity);
    return { sessionId: failure.sessionId, source, attempts: failure.attempts, retryAt, errorCode: failure.errorCode };
  });
  if (
    failures.length > value.pendingStreamCount ||
    value.complete !== (value.pendingStreamCount === 0 && failures.length === 0)
  ) throw new GatewayError("The service returned an inconsistent Resource usage projection status.");
  return {
    complete: value.complete,
    streamCount: value.streamCount,
    pendingStreamCount: value.pendingStreamCount,
    ...(lastProjectedAt === undefined ? {} : { lastProjectedAt }),
    failures
  };
}

function resourceUsageCountsMatch(
  values: readonly { readonly metrics: ResourceUsageMetricsView }[],
  totals: ResourceUsageMetricsView
): boolean {
  return RESOURCE_USAGE_COUNT_KEYS.every((key) => {
    let sum = 0;
    for (const value of values) {
      sum += value.metrics[key];
      if (!Number.isSafeInteger(sum)) return false;
    }
    return sum === totals[key];
  });
}

function resourceUsageMetricsEqual(left: ResourceUsageMetricsView, right: ResourceUsageMetricsView): boolean {
  return RESOURCE_USAGE_COUNT_KEYS.every((key) => left[key] === right[key])
    && left.latestUsedAt === right.latestUsedAt;
}

function resourceUsageVersionKey(value: ResourceUsageVersionBreakdownView): string {
  return `${value.identity.contentRevision}\u0000${value.identity.version ?? ""}`;
}

function validResourceUsageTimeZone(value: string): boolean {
  if (value.trim() === "" || value.length > 128 || value !== value.trim() || /[\u0000\r\n]/u.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

function validResourceUsageDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

function addResourceUsageDays(value: string, amount: number): string {
  if (!validResourceUsageDay(value)) throw new GatewayError("The service returned an invalid Resource usage calendar day.");
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function optionalResourceUsageTimestamp(
  value: { readonly seconds: bigint; readonly nanos: number } | undefined
): number | undefined {
  if (value === undefined) return undefined;
  return requiredResourceUsageTimestamp(value);
}

function requiredResourceUsageTimestamp(
  value: { readonly seconds: bigint; readonly nanos: number } | undefined
): number {
  if (
    value === undefined || value.seconds < 0n || value.nanos < 0 || value.nanos >= 1_000_000_000 ||
    !Number.isSafeInteger(value.nanos)
  ) throw new GatewayError("The service returned an invalid Resource usage timestamp.");
  const seconds = Number(value.seconds);
  const result = seconds * 1_000 + Math.floor(value.nanos / 1_000_000);
  if (!Number.isSafeInteger(seconds) || !Number.isSafeInteger(result)) {
    throw new GatewayError("The service returned an unsafe Resource usage timestamp.");
  }
  return result;
}

function mapSkillDescriptor(skill: ProtoSkillDescriptor): SkillDescriptorView {
  const revision = skill.entityVersion?.revision?.value;
  const scope = skill.scope === ResourceScope.GLOBAL
    ? "global" as const
    : skill.scope === ResourceScope.PROJECT
      ? "project" as const
      : undefined;
  if (
    skill.skillId.trim() === "" || skill.backendId.trim() === "" || skill.name.trim() === "" ||
    skill.sourceLabel.trim() === "" || privatePathLikeLabel(skill.sourceLabel) || scope === undefined ||
    revision === undefined || revision < 1n || skill.approvedRevision.trim() === "" || skill.updatedAt === undefined
  ) throw new GatewayError("The service returned an incomplete or path-bearing Skill descriptor.");
  return {
    id: skill.skillId,
    backendId: skill.backendId,
    ...(skill.targetId === "" ? {} : { targetId: skill.targetId }),
    scope,
    name: skill.name,
    sourceLabel: skill.sourceLabel,
    state: resourceState(skill.state),
    enabled: skill.enabled,
    canToggle: skill.canToggle,
    contentAvailable: skill.contentAvailable,
    canEdit: skill.canEdit,
    canDelete: skill.canDelete,
    revision,
    approvedRevision: skill.approvedRevision,
    updatedAt: timestampMs(skill.updatedAt)
  };
}

function mapSkillFileEntry(file: ProtoSkillFileEntry): SkillFileEntryView {
  const kind = file.kind === SkillFileKind.DIRECTORY
    ? "directory" as const
    : file.kind === SkillFileKind.FILE
      ? "file" as const
      : undefined;
  const size = exactSafeUnsignedNumber(file.size);
  if (kind === undefined || size === undefined || !portableSkillKey(file.key) || !portableSkillName(file.name)) {
    throw new GatewayError("The service returned an invalid Skill file entry.");
  }
  return { key: file.key, name: file.name, kind, size, editable: file.editable };
}

function mapSkillFileContent(file: ProtoSkillFileContent): SkillFileContentView {
  const size = exactSafeUnsignedNumber(file.size);
  if (size === undefined || !portableSkillKey(file.key) || file.revision.trim() === "") {
    throw new GatewayError("The service returned an invalid Skill file.");
  }
  return { key: file.key, content: file.content, revision: file.revision, size, editable: file.editable };
}

function mapSkillDiffChange(change: ProtoSkillDiffChange): SkillDiffChangeView {
  const kind = change.kind === SkillDiffChangeKind.ADDED
    ? "added" as const
    : change.kind === SkillDiffChangeKind.MODIFIED
      ? "modified" as const
      : change.kind === SkillDiffChangeKind.DELETED
        ? "deleted" as const
        : undefined;
  if (kind === undefined || !portableSkillKey(change.key)) throw new GatewayError("The service returned an invalid Skill diff change.");
  return {
    key: change.key,
    kind,
    binary: change.binary,
    ...(change.unifiedDiff === "" ? {} : { unifiedDiff: change.unifiedDiff })
  };
}

function mapSkillDiff(diff: ProtoSkillDiff): SkillDiffView {
  return {
    available: diff.available,
    ...(diff.reason === "" ? {} : { reason: diff.reason }),
    changes: diff.changes.map(mapSkillDiffChange),
    truncated: diff.truncated
  };
}

function mapSkillSession(session: ProtoSkillSession): SkillSessionView {
  const fileCount = exactSafeUnsignedNumber(session.fileCount);
  const bytes = exactSafeUnsignedNumber(session.bytes);
  if (
    session.skill === undefined || session.metadata === undefined || session.diff === undefined ||
    session.sessionId.trim() === "" || session.observedRevision.trim() === "" || session.expiresAt === undefined ||
    fileCount === undefined || bytes === undefined
  ) throw new GatewayError("The service returned an incomplete Skill session.");
  let frontmatter: unknown;
  try {
    frontmatter = JSON.parse(session.metadata.frontmatterJson);
  } catch {
    throw new GatewayError("The service returned invalid Skill frontmatter metadata.");
  }
  if (typeof frontmatter !== "object" || frontmatter === null || Array.isArray(frontmatter)) {
    throw new GatewayError("The service returned invalid Skill frontmatter metadata.");
  }
  return {
    id: session.sessionId,
    skill: mapSkillDescriptor(session.skill),
    observedRevision: session.observedRevision,
    dirty: session.dirty,
    baselineAvailable: session.baselineAvailable,
    metadata: {
      ...(session.metadata.name === "" ? {} : { name: session.metadata.name }),
      ...(session.metadata.description === "" ? {} : { description: session.metadata.description }),
      ...(session.metadata.version === "" ? {} : { version: session.metadata.version }),
      frontmatter: frontmatter as Readonly<Record<string, unknown>>,
      ...(session.metadata.parseError === "" ? {} : { parseError: session.metadata.parseError })
    },
    files: [],
    fileCount,
    bytes,
    diff: mapSkillDiff(session.diff),
    expiresAt: timestampMs(session.expiresAt)
  };
}

function mapSkillDraft(draft: ProtoSkillDraft): SkillDraftView {
  const kind = draft.kind === SkillDraftKind.EDIT
    ? "edit" as const
    : draft.kind === SkillDraftKind.RENAME
      ? "rename" as const
      : undefined;
  const resourceRevision = draft.resourceRevision?.value;
  if (
    kind === undefined || draft.draftId.trim() === "" || draft.sessionId.trim() === "" || draft.skillId.trim() === "" ||
    draft.name.trim() === "" || resourceRevision === undefined || resourceRevision < 1n ||
    draft.observedRevision.trim() === "" || draft.expiresAt === undefined
  ) throw new GatewayError("The service returned an incomplete Skill draft.");
  return {
    id: draft.draftId,
    sessionId: draft.sessionId,
    skillId: draft.skillId,
    kind,
    name: draft.name,
    resourceRevision,
    observedRevision: draft.observedRevision,
    changes: draft.changes.map(mapSkillDiffChange),
    expiresAt: timestampMs(draft.expiresAt)
  };
}

function mapSkillRecovery(recovery: ProtoSkillRecovery): SkillRecoveryView {
  const scope = recovery.scope === ResourceScope.GLOBAL
    ? "global" as const
    : recovery.scope === ResourceScope.PROJECT
      ? "project" as const
      : undefined;
  const status = recovery.status === SkillRecoveryStatus.READY
    ? "ready" as const
    : recovery.status === SkillRecoveryStatus.MISSING
      ? "missing" as const
      : undefined;
  const files = exactSafeUnsignedNumber(recovery.files);
  const bytes = exactSafeUnsignedNumber(recovery.bytes);
  if (
    scope === undefined || status === undefined || files === undefined || bytes === undefined ||
    recovery.recoveryId.trim() === "" || recovery.skillId.trim() === "" || recovery.backendId.trim() === "" ||
    recovery.name.trim() === "" || recovery.revision.trim() === "" || recovery.createdAt === undefined
  ) throw new GatewayError("The service returned an incomplete Skill recovery.");
  return {
    id: recovery.recoveryId,
    skillId: recovery.skillId,
    backendId: recovery.backendId,
    ...(recovery.targetId === "" ? {} : { targetId: recovery.targetId }),
    scope,
    name: recovery.name,
    revision: recovery.revision,
    files,
    bytes,
    createdAt: timestampMs(recovery.createdAt),
    status
  };
}

function skillMutationResult(operation: Operation): SkillMutationResultView {
  const payload = operation.result?.payload;
  if (payload?.case !== "skill") throw new GatewayError("The service completed the Skill operation without a Skill result.");
  return {
    ...(payload.value.skill === undefined ? {} : { skill: mapSkillDescriptor(payload.value.skill) }),
    ...(payload.value.replacedSkillId === "" ? {} : { replacedSkillId: payload.value.replacedSkillId }),
    ...(payload.value.recoveryId === "" ? {} : { recoveryId: payload.value.recoveryId })
  };
}

function protoSkillMarketSource(source: SkillMarketSourceDraft) {
  return {
    kind: source.kind === "local"
      ? { case: "local" as const, value: { serverPath: source.serverPath } }
      : {
          case: "git" as const,
          value: {
            repositoryUrl: source.repositoryUrl,
            ...(source.ref === undefined ? {} : { ref: source.ref }),
            sparsePaths: [...source.sparsePaths]
          }
        }
  };
}

function protoSkillMarketIdentity(identity: SkillMarketEntryIdentityView) {
  return {
    sourceId: identity.sourceId,
    sourceRevision: { value: identity.sourceRevision },
    entryId: identity.entryId,
    entryRevision: { value: identity.entryRevision },
    contentRevision: identity.contentRevision
  };
}

function protoSkillMarketInstallTarget(target: SkillMarketInstallTargetView) {
  return {
    backendId: target.backendId,
    scope: target.scope === "global" ? ResourceScope.GLOBAL : ResourceScope.PROJECT,
    ...(target.targetId === undefined ? {} : { targetId: target.targetId }),
    ...(target.relativeParent === undefined ? {} : { relativeParent: target.relativeParent })
  };
}

function protoSkillMarketSort(sort: SkillMarketSortView): SkillMarketSort {
  switch (sort) {
    case "trending": return SkillMarketSort.TRENDING;
    case "downloads": return SkillMarketSort.DOWNLOADS;
    case "updated": return SkillMarketSort.UPDATED;
    case "created": return SkillMarketSort.CREATED;
  }
}

function mapSkillMarketSource(source: ProtoSkillMarketSourceDescriptor): SkillMarketSourceView {
  const revision = source.revision?.value;
  const state = source.state === ProtoSkillMarketSourceState.READY
    ? "ready" as const
    : source.state === ProtoSkillMarketSourceState.ERROR
      ? "error" as const
      : undefined;
  const kind = source.kind === ProtoSkillMarketSourceKind.LOCAL
    ? "local" as const
    : source.kind === ProtoSkillMarketSourceKind.GIT
      ? "git" as const
      : undefined;
  const addedAt = source.addedAt === undefined ? undefined : timestampMs(source.addedAt);
  const refreshedAt = source.refreshedAt === undefined ? undefined : timestampMs(source.refreshedAt);
  if (!/^skill_market_source_[a-f0-9]{32}$/u.test(source.sourceId) || revision === undefined || revision < 1n
    || kind === undefined || state === undefined || source.display.trim() === "" || privatePathLikeLabel(source.display)
    || source.name.trim() === "" || privatePathLikeLabel(source.name) || (source.displayName !== undefined && privatePathLikeLabel(source.displayName))
    || !/^sha256:[a-f0-9]{64}$/u.test(source.contentRevision) || !Number.isSafeInteger(source.entryCount) || source.entryCount < 0
    || addedAt === undefined || !Number.isSafeInteger(addedAt) || addedAt < 0
    || (refreshedAt !== undefined && (!Number.isSafeInteger(refreshedAt) || refreshedAt < addedAt))
    || (state === "error") !== (source.error !== undefined)) {
    throw new GatewayError("The service returned an invalid or path-bearing Skill market source.");
  }
  return {
    id: source.sourceId,
    revision,
    kind,
    display: source.display,
    name: source.name,
    ...(source.displayName === undefined ? {} : { displayName: source.displayName }),
    state,
    contentRevision: source.contentRevision,
    entryCount: source.entryCount,
    addedAt,
    ...(refreshedAt === undefined ? {} : { refreshedAt }),
    ...(source.error === undefined ? {} : { error: source.error })
  };
}

function mapSkillMarketIdentity(identity: ProtoSkillMarketEntryIdentity | undefined): SkillMarketEntryIdentityView {
  const sourceRevision = identity?.sourceRevision?.value;
  const entryRevision = identity?.entryRevision?.value;
  if (identity === undefined || !/^skill_market_source_[a-f0-9]{32}$/u.test(identity.sourceId)
    || !/^skill_market_entry_[a-f0-9]{32}$/u.test(identity.entryId)
    || sourceRevision === undefined || sourceRevision < 1n || entryRevision === undefined || entryRevision < 1n
    || !/^sha256:[a-f0-9]{64}$/u.test(identity.contentRevision)) {
    throw new GatewayError("The service returned an invalid Skill market entry identity.");
  }
  return {
    sourceId: identity.sourceId,
    sourceRevision,
    entryId: identity.entryId,
    entryRevision,
    contentRevision: identity.contentRevision
  };
}

function mapSkillMarketEntry(entry: ProtoSkillMarketEntry): SkillMarketEntryView {
  const downloads = exactSafeUnsignedNumber(entry.downloads);
  const archiveBytes = exactSafeUnsignedNumber(entry.archiveBytes);
  const sourceState = entry.sourceState === ProtoSkillMarketSourceState.READY
    ? "ready" as const
    : entry.sourceState === ProtoSkillMarketSourceState.ERROR
      ? "error" as const
      : undefined;
  const createdAt = entry.createdAt === undefined ? undefined : timestampMs(entry.createdAt);
  const updatedAt = entry.updatedAt === undefined ? undefined : timestampMs(entry.updatedAt);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(entry.slug) || entry.name.trim() === ""
    || (entry.category !== undefined && entry.category.trim() === "")
    || (entry.changelog !== undefined && entry.changelog.trim() === "")
    || entry.version.trim() === "" || entry.sourceName.trim() === "" || privatePathLikeLabel(entry.sourceName)
    || (entry.sourceDisplayName !== undefined && privatePathLikeLabel(entry.sourceDisplayName))
    || entry.tags.some((value) => value.trim() === "") || new Set(entry.tags).size !== entry.tags.length
    || downloads === undefined || archiveBytes === undefined || !Number.isFinite(entry.trendScore) || entry.trendScore < 0
    || sourceState === undefined || createdAt === undefined || updatedAt === undefined || createdAt < 0 || updatedAt < createdAt
    || (sourceState === "error") !== (entry.sourceError !== undefined)) {
    throw new GatewayError("The service returned an invalid or path-bearing Skill market entry.");
  }
  const installStatuses = entry.installStatuses.map(mapSkillMarketInstallStatus);
  const access = mapSkillAccessPolicy(entry.access);
  if (new Set(installStatuses.map((status) => status.resourceId)).size !== installStatuses.length) {
    throw new GatewayError("The service returned duplicate Skill market install statuses.");
  }
  return {
    identity: mapSkillMarketIdentity(entry.identity),
    slug: entry.slug,
    name: entry.name,
    ...(entry.author === undefined ? {} : { author: entry.author }),
    description: entry.description,
    ...(entry.category === undefined ? {} : { category: entry.category }),
    tags: [...entry.tags],
    version: entry.version,
    ...(entry.changelog === undefined ? {} : { changelog: entry.changelog }),
    createdAt,
    updatedAt,
    downloads,
    trendScore: entry.trendScore,
    archiveBytes,
    sourceName: entry.sourceName,
    ...(entry.sourceDisplayName === undefined ? {} : { sourceDisplayName: entry.sourceDisplayName }),
    sourceState,
    ...(entry.sourceError === undefined ? {} : { sourceError: entry.sourceError }),
    installStatuses,
    access,
    canManage: entry.canManage
  };
}

function mapSkillAccessPolicy(policy: ProtoSkillAccessPolicy | undefined): SkillAccessPolicyView {
  const revision = policy?.revision?.value;
  const publisher = policy?.publisher;
  const visibility = policy?.visibility === ProtoSkillPublicationVisibility.PUBLIC
    ? "public" as const
    : policy?.visibility === ProtoSkillPublicationVisibility.DEPARTMENT
      ? "department" as const
      : policy?.visibility === ProtoSkillPublicationVisibility.PRIVATE
        ? "private" as const
        : undefined;
  const ids = policy?.audienceScopeIds ?? [];
  if (policy === undefined || publisher === undefined || revision === undefined || revision < 1n || visibility === undefined
    || ids.some((id) => !validCollaborationId(id)) || new Set(ids).size !== ids.length) {
    throw new GatewayError("The service returned an invalid Skill access policy.");
  }
  if (publisher.kind === ProtoSkillPublicationPublisher.PERSONAL
    && publisher.actorId !== undefined && publisher.scopeId === undefined && publisher.sourceId === undefined
    && visibility !== "department" && ids.length === 0 && validCollaborationId(publisher.actorId)) {
    return { revision, publisher: { kind: "personal", actorId: publisher.actorId }, visibility, audienceScopeIds: [] };
  }
  if (publisher.kind === ProtoSkillPublicationPublisher.TEAM
    && publisher.scopeId !== undefined && publisher.actorId === undefined && publisher.sourceId === undefined
    && validCollaborationId(publisher.scopeId)
    && (visibility === "public" && ids.length === 0 || visibility === "department" && ids.length > 0)) {
    return { revision, publisher: { kind: "team", scopeId: publisher.scopeId }, visibility, audienceScopeIds: [...ids] };
  }
  if (publisher.kind === ProtoSkillPublicationPublisher.EXTERNAL
    && publisher.sourceId !== undefined && publisher.actorId === undefined && publisher.scopeId === undefined
    && validCollaborationId(publisher.sourceId) && visibility === "public" && ids.length === 0) {
    return { revision, publisher: { kind: "external", sourceId: publisher.sourceId }, visibility, audienceScopeIds: [] };
  }
  throw new GatewayError("The service returned an inconsistent Skill access policy.");
}

function mapCollaborationDirectory(directory: ProtoCollaborationDirectory): CollaborationDirectoryView {
  const revision = directory.revision?.value;
  const unavailableReason = directory.unavailableReason === undefined || directory.unavailableReason === ""
    ? undefined
    : directory.unavailableReason;
  if (revision === undefined || revision < 0n
    || (unavailableReason !== undefined && (!validPublicationText(unavailableReason, 512) || containsPrivatePath(unavailableReason)))) {
    throw new GatewayError("The service returned an invalid collaboration directory.");
  }
  if (!directory.available) {
    if (revision !== 0n || directory.actor !== undefined || directory.scopes.length !== 0 || unavailableReason === undefined) {
      throw new GatewayError("The service returned an inconsistent unavailable collaboration directory.");
    }
    return {
      available: false,
      revision,
      scopes: [],
      recoveredFromCorruption: directory.recoveredFromCorruption,
      unavailableReason
    };
  }
  const actor = directory.actor;
  if (revision < 1n || actor === undefined || !validCollaborationId(actor.actorId)
    || !validPublicationText(actor.displayName, 128) || privatePathLikeLabel(actor.displayName)) {
    throw new GatewayError("The service returned an invalid collaboration identity.");
  }
  const scopes = directory.scopes.map((scope) => {
    const scopeRevision = scope.revision?.value;
    const kind = scope.kind === ProtoCollaborationScopeKind.TEAM
      ? "team" as const
      : scope.kind === ProtoCollaborationScopeKind.DEPARTMENT
        ? "department" as const
        : undefined;
    const members = scope.members.map((member) => {
      const role = member.role === ProtoCollaborationRole.VIEWER
        ? "viewer" as const
        : member.role === ProtoCollaborationRole.PUBLISHER
          ? "publisher" as const
          : member.role === ProtoCollaborationRole.ADMINISTRATOR
            ? "administrator" as const
            : undefined;
      if (!validCollaborationId(member.actorId) || role === undefined) {
        throw new GatewayError("The service returned an invalid collaboration membership.");
      }
      return { actorId: member.actorId, role };
    });
    if (!validCollaborationId(scope.scopeId) || scopeRevision === undefined || scopeRevision < 1n || kind === undefined
      || !validPublicationText(scope.name, 128) || privatePathLikeLabel(scope.name)
      || members.length === 0 || new Set(members.map((member) => member.actorId)).size !== members.length
      || !members.some((member) => member.actorId === actor.actorId)) {
      throw new GatewayError("The service returned an invalid collaboration scope.");
    }
    return { id: scope.scopeId, revision: scopeRevision, kind, name: scope.name, members };
  });
  if (new Set(scopes.map((scope) => scope.id)).size !== scopes.length || unavailableReason !== undefined) {
    throw new GatewayError("The service returned an inconsistent collaboration directory.");
  }
  return {
    available: true,
    revision,
    actor: { id: actor.actorId, displayName: actor.displayName },
    scopes,
    recoveredFromCorruption: directory.recoveredFromCorruption
  };
}

function mapSkillMarketInstallStatus(status: ProtoSkillMarketInstallStatus): SkillMarketInstallStatusView {
  const resourceRevision = status.resourceRevision?.value;
  const scope = status.scope === ResourceScope.GLOBAL
    ? "global" as const
    : status.scope === ResourceScope.PROJECT
      ? "project" as const
      : undefined;
  const state = status.state === ProtoSkillMarketInstallStatusState.INSTALLED
    ? "installed" as const
    : status.state === ProtoSkillMarketInstallStatusState.UPDATE_AVAILABLE
      ? "updateAvailable" as const
      : status.state === ProtoSkillMarketInstallStatusState.CONFLICT
        ? "conflict" as const
        : undefined;
  if (status.resourceId.trim() === "" || status.backendId.trim() === "" || resourceRevision === undefined
    || resourceRevision < 1n || scope === undefined || state === undefined
    || (scope === "global" && (status.targetId !== undefined || status.relativeParent !== undefined))
    || (scope === "project" && (status.targetId === undefined || status.targetId.trim() === ""
      || status.relativeParent === undefined || !portableSkillKey(status.relativeParent)))
    || (status.installedVersion !== undefined && status.installedVersion.trim() === "")) {
    throw new GatewayError("The service returned an invalid Skill market install status.");
  }
  return {
    resourceId: status.resourceId,
    resourceRevision,
    backendId: status.backendId,
    ...(status.targetId === undefined ? {} : { targetId: status.targetId }),
    scope,
    ...(status.relativeParent === undefined ? {} : { relativeParent: status.relativeParent }),
    state,
    ...(status.installedVersion === undefined ? {} : { installedVersion: status.installedVersion })
  };
}

function mapSkillMarketArchiveEntry(file: ProtoSkillMarketArchiveEntry): SkillMarketArchiveEntryView {
  const kind = file.kind === SkillFileKind.DIRECTORY
    ? "directory" as const
    : file.kind === SkillFileKind.FILE
      ? "file" as const
      : undefined;
  const size = exactSafeUnsignedNumber(file.size);
  if (kind === undefined || size === undefined || !portableSkillKey(file.key)) {
    throw new GatewayError("The service returned an invalid Skill market archive entry.");
  }
  return { key: file.key, kind, size };
}

function mapSkillMarketPreview(preview: ProtoSkillMarketPreview): SkillMarketPreviewView {
  const files = exactSafeUnsignedNumber(preview.files);
  const bytes = exactSafeUnsignedNumber(preview.bytes);
  if (!/^skill_market_preview_[a-f0-9]{32}$/u.test(preview.previewId)
    || !/^sha256:[a-f0-9]{64}$/u.test(preview.snapshotRevision) || files === undefined || bytes === undefined
    || preview.entry === undefined || preview.expiresAt === undefined) {
    throw new GatewayError("The service returned an invalid Skill market preview.");
  }
  return {
    id: preview.previewId,
    entry: mapSkillMarketEntry(preview.entry),
    snapshotRevision: preview.snapshotRevision,
    files,
    bytes,
    expiresAt: timestampMs(preview.expiresAt)
  };
}

function mapSkillMarketPreviewFile(
  file: ProtoSkillMarketPreviewFile,
  preview: SkillMarketPreviewView
): SkillMarketPreviewFileView {
  const size = exactSafeUnsignedNumber(file.size);
  const unavailableReason = file.unavailableReason === undefined
    ? undefined
    : file.unavailableReason === ProtoSkillMarketPreviewUnavailableReason.BINARY
      ? "binary" as const
      : file.unavailableReason === ProtoSkillMarketPreviewUnavailableReason.TOO_LARGE
        ? "tooLarge" as const
        : null;
  if (file.previewId !== preview.id || file.snapshotRevision !== preview.snapshotRevision
    || !portableSkillKey(file.key) || size === undefined || unavailableReason === null
    || file.previewable !== (file.content !== undefined) || file.previewable === (unavailableReason !== undefined)) {
    throw new GatewayError("The service returned an invalid Skill market preview file.");
  }
  return {
    previewId: file.previewId,
    snapshotRevision: file.snapshotRevision,
    key: file.key,
    size,
    previewable: file.previewable,
    ...(file.content === undefined ? {} : { content: file.content }),
    ...(unavailableReason === undefined ? {} : { unavailableReason })
  };
}

function mapSkillMarketInstallTarget(target: {
  readonly backendId: string;
  readonly scope: ResourceScope;
  readonly targetId?: string;
  readonly relativeParent?: string;
} | undefined): SkillMarketInstallTargetView {
  const scope = target?.scope === ResourceScope.GLOBAL
    ? "global" as const
    : target?.scope === ResourceScope.PROJECT
      ? "project" as const
      : undefined;
  if (target === undefined || target.backendId.trim() === "" || scope === undefined
    || (scope === "global" && (target.targetId !== undefined || target.relativeParent !== undefined))
    || (scope === "project" && (target.targetId?.trim() ?? "") === "")
    || (target.relativeParent !== undefined && !portableSkillKey(target.relativeParent))) {
    throw new GatewayError("The service returned an invalid Skill market install target.");
  }
  return {
    backendId: target.backendId,
    scope,
    ...(target.targetId === undefined ? {} : { targetId: target.targetId }),
    ...(target.relativeParent === undefined ? {} : { relativeParent: target.relativeParent })
  };
}

function mapSkillMarketCurrentResource(value: NonNullable<ProtoSkillMarketInstallPreview["currentResource"]>) {
  const resourceRevision = value.resourceRevision?.value;
  const sourceKind = value.sourceKind === ResourceAcquisitionKind.LOCAL
    ? "local" as const
    : value.sourceKind === ResourceAcquisitionKind.NPM
      ? "npm" as const
      : value.sourceKind === ResourceAcquisitionKind.GIT
        ? "git" as const
        : value.sourceKind === ResourceAcquisitionKind.EXTENSION_SOURCE
          ? "extensionSource" as const
          : value.sourceKind === ResourceAcquisitionKind.SKILL_MARKET
            ? "skillMarket" as const
            : undefined;
  if (value.resourceId.trim() === "" || resourceRevision === undefined || resourceRevision < 1n || value.name.trim() === ""
    || sourceKind === undefined || value.sourceDisplay.trim() === "" || privatePathLikeLabel(value.sourceDisplay)
    || value.discoveredRevision.trim() === "" || value.observedRevision.trim() === "") {
    throw new GatewayError("The service returned an invalid or path-bearing current Skill resource.");
  }
  return {
    resourceId: value.resourceId,
    resourceRevision,
    name: value.name,
    ...(value.version === undefined ? {} : { version: value.version }),
    sourceKind,
    sourceDisplay: value.sourceDisplay,
    discoveredRevision: value.discoveredRevision,
    observedRevision: value.observedRevision,
    dirty: value.dirty
  };
}

function mapSkillMarketInstallPreview(preview: ProtoSkillMarketInstallPreview): SkillMarketInstallPreviewView {
  const action = preview.action === ProtoSkillMarketInstallAction.INSTALL
    ? "install" as const
    : preview.action === ProtoSkillMarketInstallAction.UPDATE
      ? "update" as const
      : preview.action === ProtoSkillMarketInstallAction.REPLACE
        ? "replace" as const
        : undefined;
  const files = exactSafeUnsignedNumber(preview.files);
  const bytes = exactSafeUnsignedNumber(preview.bytes);
  if (action === undefined || preview.resourceId.trim() === "" || preview.name.trim() === ""
    || preview.availableVersion.trim() === "" || !/^sha256:[a-f0-9]{64}$/u.test(preview.candidateRevision)
    || files === undefined || bytes === undefined || (preview.diffAvailable === false && preview.changes.length > 0)) {
    throw new GatewayError("The service returned an invalid Skill market install preview.");
  }
  return {
    action,
    resourceId: preview.resourceId,
    target: mapSkillMarketInstallTarget(preview.target),
    name: preview.name,
    availableVersion: preview.availableVersion,
    candidateRevision: preview.candidateRevision,
    files,
    bytes,
    ...(preview.currentResource === undefined ? {} : { currentResource: mapSkillMarketCurrentResource(preview.currentResource) }),
    unregisteredDestination: preview.unregisteredDestination,
    sourceReplacement: preview.sourceReplacement,
    preservesEnabled: preview.preservesEnabled,
    diffAvailable: preview.diffAvailable,
    ...(preview.diffReason === undefined ? {} : { diffReason: preview.diffReason }),
    changes: preview.changes.map(mapSkillDiffChange),
    diffTruncated: preview.diffTruncated
  };
}

function mapSkillMarketConfirmationReason(
  value: ProtoSkillMarketInstallConfirmationReason
): SkillMarketInstallPlanView["confirmationReasons"][number] {
  switch (value) {
    case ProtoSkillMarketInstallConfirmationReason.SOURCE_REPLACEMENT: return "sourceReplacement";
    case ProtoSkillMarketInstallConfirmationReason.LOCAL_OWNERSHIP: return "localOwnership";
    case ProtoSkillMarketInstallConfirmationReason.DIRTY_CONTENT: return "dirtyContent";
    case ProtoSkillMarketInstallConfirmationReason.UNREGISTERED_DESTINATION: return "unregisteredDestination";
    case ProtoSkillMarketInstallConfirmationReason.DOWNGRADE: return "downgrade";
    default: throw new GatewayError("The service returned an invalid Skill market confirmation reason.");
  }
}

function mapSkillMarketInstallPlan(plan: ProtoSkillMarketInstallPlan): SkillMarketInstallPlanView {
  if (!/^skill_market_install_[a-f0-9]{32}$/u.test(plan.planId) || plan.entry === undefined || plan.target === undefined
    || plan.preview === undefined || plan.expiresAt === undefined) {
    throw new GatewayError("The service returned an invalid Skill market install plan.");
  }
  const target = mapSkillMarketInstallTarget(plan.target);
  const preview = mapSkillMarketInstallPreview(plan.preview);
  const confirmationReasons = plan.confirmationReasons.map(mapSkillMarketConfirmationReason);
  if (new Set(confirmationReasons).size !== confirmationReasons.length
    || plan.requiresConfirmation !== (confirmationReasons.length > 0)
    || JSON.stringify(target) !== JSON.stringify(preview.target)) {
    throw new GatewayError("The service returned an inconsistent Skill market install plan.");
  }
  return {
    id: plan.planId,
    entry: mapSkillMarketEntry(plan.entry),
    target,
    preview,
    confirmationReasons,
    requiresConfirmation: plan.requiresConfirmation,
    expiresAt: timestampMs(plan.expiresAt)
  };
}

function mapSkillMarketSyncTarget(target: ProtoSkillMarketSyncTarget | undefined): SkillMarketSyncTargetView {
  const mapped = mapSkillMarketInstallTarget(target);
  const targetRevision = target?.targetRevision?.value;
  if (targetRevision !== undefined && targetRevision < 1n) {
    throw new GatewayError("The service returned an invalid Skill market sync target revision.");
  }
  return { ...mapped, ...(targetRevision === undefined ? {} : { targetRevision }) };
}

function mapSkillMarketSyncBaseline(baseline: ProtoSkillMarketSyncBaseline | undefined): SkillMarketSyncBaselineView {
  const resourceRevision = baseline?.resourceRevision?.value;
  const sourceRevision = baseline?.sourceRevision?.value;
  const entryRevision = baseline?.entryRevision?.value;
  if (baseline === undefined || resourceRevision === undefined || resourceRevision < 1n
    || sourceRevision === undefined || sourceRevision < 1n || entryRevision === undefined || entryRevision < 1n
    || !/^sha256:[a-f0-9]{64}$/u.test(baseline.resourceContentRevision)
    || !/^sha256:[a-f0-9]{64}$/u.test(baseline.installedContentRevision)
    || !/^sha256:[a-f0-9]{64}$/u.test(baseline.entryContentRevision) || baseline.installedVersion.trim() === "") {
    throw new GatewayError("The service returned an invalid Skill market sync baseline.");
  }
  return {
    resourceRevision,
    resourceContentRevision: baseline.resourceContentRevision,
    installedContentRevision: baseline.installedContentRevision,
    installedVersion: baseline.installedVersion,
    sourceRevision,
    entryRevision,
    entryContentRevision: baseline.entryContentRevision
  };
}

function mapSkillMarketSyncPolicy(policy: ProtoSkillMarketSyncPolicy): SkillMarketSyncPolicyView {
  const revision = policy.revision?.value;
  if (policy.resourceId.trim() === "" || revision === undefined || revision < 1n
    || !/^skill_market_source_[a-f0-9]{32}$/u.test(policy.sourceId)
    || !/^skill_market_entry_[a-f0-9]{32}$/u.test(policy.entryId)
    || policy.target === undefined || policy.baseline === undefined || policy.createdAt === undefined || policy.updatedAt === undefined) {
    throw new GatewayError("The service returned an invalid Skill market sync policy.");
  }
  const createdAt = timestampMs(policy.createdAt);
  const updatedAt = timestampMs(policy.updatedAt);
  if (updatedAt < createdAt) throw new GatewayError("The service returned invalid Skill market sync policy timestamps.");
  return {
    resourceId: policy.resourceId,
    revision,
    enabled: policy.enabled,
    sourceId: policy.sourceId,
    entryId: policy.entryId,
    target: mapSkillMarketSyncTarget(policy.target),
    baseline: mapSkillMarketSyncBaseline(policy.baseline),
    createdAt,
    updatedAt,
    ...(policy.disabledReason === undefined ? {} : { disabledReason: policy.disabledReason })
  };
}

function mapSkillMarketSyncAuthority(authority: ProtoSkillMarketSyncJobAuthority | undefined): SkillMarketSyncJobAuthorityView {
  if (authority === undefined || !/^skill_market_source_[a-f0-9]{32}$/u.test(authority.sourceId)
    || !/^skill_market_entry_[a-f0-9]{32}$/u.test(authority.entryId)
    || authority.target === undefined || authority.baseline === undefined) {
    throw new GatewayError("The service returned an invalid Skill market sync job authority.");
  }
  return {
    sourceId: authority.sourceId,
    entryId: authority.entryId,
    target: mapSkillMarketSyncTarget(authority.target),
    baseline: mapSkillMarketSyncBaseline(authority.baseline)
  };
}

function mapSkillMarketSyncJobState(value: ProtoSkillMarketSyncJobState): SkillMarketSyncJobStateView {
  switch (value) {
    case ProtoSkillMarketSyncJobState.PENDING_REVALIDATION: return "pendingRevalidation";
    case ProtoSkillMarketSyncJobState.RUNNING: return "running";
    case ProtoSkillMarketSyncJobState.CANCELLING: return "cancelling";
    case ProtoSkillMarketSyncJobState.SUCCEEDED: return "succeeded";
    case ProtoSkillMarketSyncJobState.UP_TO_DATE: return "upToDate";
    case ProtoSkillMarketSyncJobState.BLOCKED: return "blocked";
    case ProtoSkillMarketSyncJobState.FAILED: return "failed";
    case ProtoSkillMarketSyncJobState.CANCELLED: return "cancelled";
    default: throw new GatewayError("The service returned an invalid Skill market sync job state.");
  }
}

function mapSkillMarketSyncOutcome(value: ProtoSkillMarketSyncOutcome): SkillMarketSyncOutcomeView {
  switch (value) {
    case ProtoSkillMarketSyncOutcome.UPDATED: return "updated";
    case ProtoSkillMarketSyncOutcome.ALREADY_CURRENT: return "alreadyCurrent";
    case ProtoSkillMarketSyncOutcome.DOWNGRADE_BLOCKED: return "downgradeBlocked";
    case ProtoSkillMarketSyncOutcome.DIRTY_CONTENT: return "dirtyContent";
    case ProtoSkillMarketSyncOutcome.OWNER_CHANGED: return "ownerChanged";
    case ProtoSkillMarketSyncOutcome.TARGET_CHANGED: return "targetChanged";
    case ProtoSkillMarketSyncOutcome.RESOURCE_REMOVED: return "resourceRemoved";
    case ProtoSkillMarketSyncOutcome.CANCELLED: return "cancelled";
    default: throw new GatewayError("The service returned an invalid Skill market sync outcome.");
  }
}

function mapSkillMarketSyncJob(job: ProtoSkillMarketSyncJob): SkillMarketSyncJobView {
  const revision = job.revision?.value;
  const policyRevision = job.policyRevision?.value;
  if (!/^skill_sync_[a-f0-9]{32}$/u.test(job.jobId) || revision === undefined || revision < 1n
    || job.policyResourceId.trim() === "" || policyRevision === undefined || policyRevision < 1n
    || job.authority === undefined || !Number.isSafeInteger(job.attempt) || job.attempt < 1
    || job.createdAt === undefined || job.updatedAt === undefined) {
    throw new GatewayError("The service returned an invalid Skill market sync job.");
  }
  const createdAt = timestampMs(job.createdAt);
  const updatedAt = timestampMs(job.updatedAt);
  const completedAt = job.completedAt === undefined ? undefined : timestampMs(job.completedAt);
  if (updatedAt < createdAt || (completedAt !== undefined && completedAt < createdAt)) {
    throw new GatewayError("The service returned invalid Skill market sync job timestamps.");
  }
  return {
    id: job.jobId,
    revision,
    state: mapSkillMarketSyncJobState(job.state),
    policyResourceId: job.policyResourceId,
    policyRevision,
    authority: mapSkillMarketSyncAuthority(job.authority),
    attempt: job.attempt,
    ...(job.retryOfJobId === undefined ? {} : { retryOfJobId: job.retryOfJobId }),
    ...(job.availableVersion === undefined ? {} : { availableVersion: job.availableVersion }),
    ...(job.outcome === undefined ? {} : { outcome: mapSkillMarketSyncOutcome(job.outcome) }),
    ...(job.error === undefined ? {} : { error: job.error }),
    createdAt,
    updatedAt,
    ...(completedAt === undefined ? {} : { completedAt })
  };
}

function protoSkillPublicationMetadata(metadata: SkillPublicationMetadataView) {
  return {
    slug: metadata.slug,
    name: metadata.name,
    ...(metadata.author === undefined ? {} : { author: metadata.author }),
    description: metadata.description,
    ...(metadata.category === undefined ? {} : { category: metadata.category }),
    tags: [...metadata.tags],
    version: metadata.version,
    ...(metadata.changelog === undefined ? {} : { changelog: metadata.changelog })
  };
}

function mapSkillPublicationMetadata(metadata: ProtoSkillPublicationMetadata | undefined): SkillPublicationMetadataView {
  if (metadata === undefined || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(metadata.slug)
    || !validPublicationText(metadata.name, 64)
    || !validPublicationText(metadata.description, 2_000, true)
    || !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u.test(metadata.version)
    || (metadata.author !== undefined && !validPublicationText(metadata.author, 128))
    || (metadata.category !== undefined && !validPublicationText(metadata.category, 64))
    || (metadata.changelog !== undefined && !validPublicationText(metadata.changelog, 280))
    || metadata.tags.length > 20 || metadata.tags.some((tag) => !validPublicationText(tag, 48))
    || new Set(metadata.tags.map((tag) => tag.toLocaleLowerCase("en-US"))).size !== metadata.tags.length) {
    throw new GatewayError("The service returned invalid Skill publication metadata.");
  }
  return {
    slug: metadata.slug,
    name: metadata.name,
    ...(metadata.author === undefined ? {} : { author: metadata.author }),
    description: metadata.description,
    ...(metadata.category === undefined ? {} : { category: metadata.category }),
    tags: [...metadata.tags],
    version: metadata.version,
    ...(metadata.changelog === undefined ? {} : { changelog: metadata.changelog })
  };
}

function mapSkillPublicationAuthority(authority: ProtoSkillPublicationAuthority | undefined): SkillPublicationAuthorityView {
  const resourceRevision = authority?.resourceRevision?.value;
  const sourceRevision = authority?.sourceRevision?.value;
  const scope = authority?.scope === ResourceScope.GLOBAL
    ? "global" as const
    : authority?.scope === ResourceScope.PROJECT
      ? "project" as const
      : undefined;
  if (authority === undefined || authority.resourceId.trim() === "" || resourceRevision === undefined || resourceRevision < 1n
    || !/^sha256:[a-f0-9]{64}$/u.test(authority.observedRevision) || authority.backendId.trim() === "" || scope === undefined
    || (scope === "global" && authority.targetId !== undefined)
    || (scope === "project" && (authority.targetId?.trim() ?? "") === "")
    || !/^skill_market_source_[a-f0-9]{32}$/u.test(authority.sourceId) || sourceRevision === undefined || sourceRevision < 1n
    || !/^sha256:[a-f0-9]{64}$/u.test(authority.sourceContentRevision)
    || authority.sourceDisplay.trim() === "" || containsPrivatePath(authority.sourceDisplay)
    || (authority.existingEntryId !== undefined && !/^skill_market_entry_[a-f0-9]{32}$/u.test(authority.existingEntryId))) {
    throw new GatewayError("The service returned invalid or path-bearing Skill publication authority.");
  }
  return {
    resourceId: authority.resourceId,
    resourceRevision,
    observedRevision: authority.observedRevision,
    backendId: authority.backendId,
    ...(authority.targetId === undefined ? {} : { targetId: authority.targetId }),
    scope,
    sourceId: authority.sourceId,
    sourceRevision,
    sourceContentRevision: authority.sourceContentRevision,
    sourceDisplay: authority.sourceDisplay,
    ...(authority.existingEntryId === undefined ? {} : { existingEntryId: authority.existingEntryId })
  };
}

function mapSkillPublicationGate(gate: ProtoSkillPublicationGate): SkillPublicationGateView {
  const id = gate.gateId === "metadata" || gate.gateId === "package" || gate.gateId === "sensitive_content"
    || gate.gateId === "source_authority" ? gate.gateId : undefined;
  const status = gate.status === ProtoSkillPublicationGateStatus.PENDING
    ? "pending" as const
    : gate.status === ProtoSkillPublicationGateStatus.PASSED
      ? "passed" as const
      : gate.status === ProtoSkillPublicationGateStatus.BLOCKED
        ? "blocked" as const
        : undefined;
  if (id === undefined || status === undefined || !validPublicationText(gate.label, 80) || gate.issues.length > 20) {
    throw new GatewayError("The service returned an invalid Skill publication gate.");
  }
  const issues = gate.issues.map((issue) => {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/u.test(issue.code) || !validPublicationText(issue.message, 512)
      || containsPrivatePath(issue.message)
      || (issue.path !== undefined && !portableSkillKey(issue.path))) {
      throw new GatewayError("The service returned an invalid Skill publication gate issue.");
    }
    return {
      code: issue.code,
      message: issue.message,
      ...(issue.path === undefined ? {} : { path: issue.path })
    };
  });
  return { id, label: gate.label, status, issues };
}

function mapSkillPublicationResult(result: ProtoSkillPublicationResult | undefined): SkillPublicationResultView {
  const sourceRevision = result?.sourceRevision?.value;
  const entryRevision = result?.entryRevision?.value;
  if (result === undefined || !/^skill_market_source_[a-f0-9]{32}$/u.test(result.sourceId)
    || sourceRevision === undefined || sourceRevision < 1n
    || !/^skill_market_entry_[a-f0-9]{32}$/u.test(result.entryId)
    || entryRevision === undefined || entryRevision < 1n
    || !/^sha256:[a-f0-9]{64}$/u.test(result.entryContentRevision)
    || !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u.test(result.version)) {
    throw new GatewayError("The service returned an invalid Skill publication result.");
  }
  return {
    sourceId: result.sourceId,
    sourceRevision,
    entryId: result.entryId,
    entryRevision,
    entryContentRevision: result.entryContentRevision,
    version: result.version
  };
}

function mapSkillPublicationState(value: ProtoSkillPublicationState): SkillPublicationStateView {
  switch (value) {
    case ProtoSkillPublicationState.PENDING: return "pending";
    case ProtoSkillPublicationState.SNAPSHOTTING: return "snapshotting";
    case ProtoSkillPublicationState.PACKAGING: return "packaging";
    case ProtoSkillPublicationState.SCANNING: return "scanning";
    case ProtoSkillPublicationState.COMMITTING: return "committing";
    case ProtoSkillPublicationState.RECONCILING: return "reconciling";
    case ProtoSkillPublicationState.CANCELLING: return "cancelling";
    case ProtoSkillPublicationState.PUBLISHED: return "published";
    case ProtoSkillPublicationState.BLOCKED: return "blocked";
    case ProtoSkillPublicationState.FAILED: return "failed";
    case ProtoSkillPublicationState.CANCELLED: return "cancelled";
    default: throw new GatewayError("The service returned an invalid Skill publication state.");
  }
}

function mapSkillPublicationJob(job: ProtoSkillPublicationJob): SkillPublicationJobView {
  const revision = job.revision?.value;
  const accessRevision = job.accessRevision?.value;
  const files = exactSafeUnsignedNumber(job.files);
  const uncompressedBytes = exactSafeUnsignedNumber(job.uncompressedBytes);
  const archiveBytes = exactSafeUnsignedNumber(job.archiveBytes);
  const publisher = job.publisher === ProtoSkillPublicationPublisher.PERSONAL
    ? "personal" as const
    : job.publisher === ProtoSkillPublicationPublisher.TEAM
      ? "team" as const
      : undefined;
  const visibility = job.visibility === ProtoSkillPublicationVisibility.PUBLIC
    ? "public" as const
    : job.visibility === ProtoSkillPublicationVisibility.DEPARTMENT
      ? "department" as const
      : job.visibility === ProtoSkillPublicationVisibility.PRIVATE
        ? "private" as const
        : undefined;
  const accessShapeValid = publisher === "personal"
    ? job.publisherScopeId === undefined && visibility !== "department" && job.audienceScopeIds.length === 0
    : publisher === "team"
      ? job.publisherScopeId !== undefined && validCollaborationId(job.publisherScopeId)
        && (visibility === "public" && job.audienceScopeIds.length === 0
          || visibility === "department" && job.audienceScopeIds.length > 0)
      : false;
  if (!/^skill_publication_[a-f0-9]{32}$/u.test(job.jobId) || revision === undefined || revision < 1n
    || accessRevision === undefined || accessRevision < 1n || job.authority === undefined || job.metadata === undefined
    || publisher === undefined || visibility === undefined || !accessShapeValid
    || job.audienceScopeIds.some((id) => !validCollaborationId(id))
    || new Set(job.audienceScopeIds).size !== job.audienceScopeIds.length
    || files === undefined || uncompressedBytes === undefined
    || archiveBytes === undefined || !Number.isSafeInteger(job.attempt) || job.attempt < 1
    || job.gates.length !== 4 || job.createdAt === undefined || job.updatedAt === undefined) {
    throw new GatewayError("The service returned an invalid Skill publication job.");
  }
  const state = mapSkillPublicationState(job.state);
  const terminal = state === "published" || state === "blocked" || state === "failed" || state === "cancelled";
  const verdict = job.verdict === ProtoSkillPublicationVerdict.PENDING
    ? "pending" as const
    : job.verdict === ProtoSkillPublicationVerdict.PASSED
      ? "passed" as const
      : job.verdict === ProtoSkillPublicationVerdict.BLOCKED
        ? "blocked" as const
        : undefined;
  const gates = job.gates.map(mapSkillPublicationGate);
  const expectedGateIds: SkillPublicationGateView["id"][] = ["metadata", "package", "sensitive_content", "source_authority"];
  const createdAt = timestampMs(job.createdAt);
  const updatedAt = timestampMs(job.updatedAt);
  const completedAt = job.completedAt === undefined ? undefined : timestampMs(job.completedAt);
  if (verdict === undefined || gates.some((gate, index) => gate.id !== expectedGateIds[index])
    || updatedAt < createdAt || terminal !== (completedAt !== undefined)
    || (completedAt !== undefined && completedAt < updatedAt) || terminal && job.cancellable
    || (state === "published") !== (job.result !== undefined)
    || state === "published" && (verdict !== "passed" || gates.some((gate) => gate.status !== "passed"))
    || state === "blocked" && (verdict !== "blocked" || !gates.some((gate) => gate.status === "blocked"))
    || ((state === "failed" || state === "reconciling" || state === "cancelled") !== (job.error !== undefined))
    || (job.error !== undefined && (!validPublicationText(job.error, 2_048) || containsPrivatePath(job.error)))) {
    throw new GatewayError("The service returned an inconsistent Skill publication job.");
  }
  return {
    id: job.jobId,
    revision,
    state,
    authority: mapSkillPublicationAuthority(job.authority),
    metadata: mapSkillPublicationMetadata(job.metadata),
    publisher,
    ...(job.publisherScopeId === undefined ? {} : { publisherScopeId: job.publisherScopeId }),
    visibility,
    audienceScopeIds: [...job.audienceScopeIds],
    accessRevision,
    gates,
    verdict,
    files,
    uncompressedBytes,
    archiveBytes,
    attempt: job.attempt,
    ...(job.retryOfJobId === undefined ? {} : { retryOfJobId: job.retryOfJobId }),
    ...(job.result === undefined ? {} : { result: mapSkillPublicationResult(job.result) }),
    createdAt,
    updatedAt,
    ...(completedAt === undefined ? {} : { completedAt }),
    ...(job.error === undefined ? {} : { error: job.error }),
    cancellable: job.cancellable
  };
}

function mapSkillPublicationPreview(preview: ProtoSkillPublicationPreview): SkillPublicationPreviewView {
  const mode = preview.mode === ProtoSkillPublicationMode.FIRST
    ? "first" as const
    : preview.mode === ProtoSkillPublicationMode.VERSION
      ? "version" as const
      : undefined;
  const collaborationRevision = preview.collaborationRevision?.value;
  const collaborationUnavailableReason = preview.collaborationUnavailableReason === ""
    ? undefined
    : preview.collaborationUnavailableReason;
  const collaborationAvailable = preview.personalPublisherAvailable;
  if (preview.authority === undefined || preview.source === undefined || mode === undefined
    || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(preview.suggestedSlug)
    || !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u.test(preview.suggestedVersion)
    || collaborationRevision === undefined || collaborationRevision < 0n
    || preview.departmentVisibilityAvailable && !preview.teamPublisherAvailable
    || collaborationAvailable !== preview.publicVisibilityAvailable
    || collaborationAvailable !== preview.privateVisibilityAvailable
    || (!collaborationAvailable && (collaborationRevision !== 0n || preview.teamPublisherAvailable
      || preview.departmentVisibilityAvailable || collaborationUnavailableReason === undefined))
    || (collaborationAvailable && collaborationRevision < 1n)
    || (collaborationUnavailableReason !== undefined
      && (!validPublicationText(collaborationUnavailableReason, 512) || containsPrivatePath(collaborationUnavailableReason)))) {
    throw new GatewayError("The service returned an invalid Skill publication preview.");
  }
  const authority = mapSkillPublicationAuthority(preview.authority);
  const source = mapSkillMarketSource(preview.source);
  const existingEntry = preview.existingEntry === undefined ? undefined : mapSkillMarketEntry(preview.existingEntry);
  if (source.id !== authority.sourceId || source.revision !== authority.sourceRevision
    || source.contentRevision !== authority.sourceContentRevision || source.state !== "ready" || source.kind !== "local"
    || (mode === "first") !== (existingEntry === undefined)
    || (existingEntry === undefined) !== (authority.existingEntryId === undefined)
    || existingEntry !== undefined && (existingEntry.identity.entryId !== authority.existingEntryId
      || existingEntry.slug !== preview.suggestedSlug)) {
    throw new GatewayError("The service returned an inconsistent Skill publication preview.");
  }
  return {
    authority,
    source,
    mode,
    suggestedSlug: preview.suggestedSlug,
    suggestedVersion: preview.suggestedVersion,
    ...(existingEntry === undefined ? {} : { existingEntry }),
    dirty: preview.dirty,
    collaborationRevision,
    personalPublisherAvailable: preview.personalPublisherAvailable,
    teamPublisherAvailable: preview.teamPublisherAvailable,
    publicVisibilityAvailable: preview.publicVisibilityAvailable,
    departmentVisibilityAvailable: preview.departmentVisibilityAvailable,
    privateVisibilityAvailable: preview.privateVisibilityAvailable,
    ...(collaborationUnavailableReason === undefined ? {} : { collaborationUnavailableReason })
  };
}

function privatePathLikeLabel(value: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\/u.test(value) || value.startsWith("/");
}

function validCollaborationId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value);
}

function protoCollaborationScopeKind(value: CollaborationScopeKindView): ProtoCollaborationScopeKind {
  return value === "team" ? ProtoCollaborationScopeKind.TEAM : ProtoCollaborationScopeKind.DEPARTMENT;
}

function protoSkillPublicationPublisher(value: SkillPublicationAccessSelectionView["publisher"]): ProtoSkillPublicationPublisher {
  return value === "personal" ? ProtoSkillPublicationPublisher.PERSONAL : ProtoSkillPublicationPublisher.TEAM;
}

function protoSkillPublicationVisibility(value: SkillPublicationAccessSelectionView["visibility"]): ProtoSkillPublicationVisibility {
  if (value === "public") return ProtoSkillPublicationVisibility.PUBLIC;
  if (value === "department") return ProtoSkillPublicationVisibility.DEPARTMENT;
  return ProtoSkillPublicationVisibility.PRIVATE;
}

function validPublicationText(value: string, maximum: number, allowEmpty = false): boolean {
  return value === value.trim() && value.length <= maximum && (allowEmpty || value !== "")
    && !/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value);
}

function containsPrivatePath(value: string): boolean {
  return /[A-Za-z]:[\\/]/u.test(value)
    || /\\\\[^\\\s"']+[\\/]/u.test(value)
    || /(?:^|[\s"'(])\/(?:[^/\s"'()]+\/)+[^/\s"'()]*/u.test(value);
}

function portableSkillName(value: string): boolean {
  return value.length > 0 && value !== "." && value !== ".." && !value.includes("/") && !value.includes("\\") && !value.includes("\0");
}

function portableSkillKey(value: string): boolean {
  return value.length > 0 && !value.startsWith("/") && !value.includes("\\") && !value.includes("\0")
    && value.split("/").every(portableSkillName);
}

function extensionSourceLocation(source: ExtensionSourceDraft) {
  return {
    kind: source.kind === "local"
      ? { case: "local" as const, value: { path: source.path } }
      : {
          case: "git" as const,
          value: {
            repositoryUrl: source.repositoryUrl,
            ...(source.ref === undefined ? {} : { ref: source.ref }),
            sparsePaths: [...source.sparsePaths]
          }
        }
  };
}

function mapExtensionSource(source: ProtoExtensionSourceDescriptor): ExtensionSourceView {
  const revision = source.revision?.value;
  if (!/^extension_source_[a-f0-9]{32}$/u.test(source.sourceId) || revision === undefined || revision < 1n
    || !/^sha256:[a-f0-9]{64}$/u.test(source.contentRevision) || source.name.trim() === "" || source.addedAt === undefined) {
    throw new GatewayError("Orchestrator returned an incomplete Extension source descriptor.");
  }
  const location = source.location?.kind;
  const mappedLocation: ExtensionSourceView["location"] = location?.case === "local"
    ? location.value.path.trim() === "" || source.kind !== ProtoExtensionSourceKind.LOCAL
      ? (() => { throw new GatewayError("Orchestrator returned an invalid local Extension source."); })()
      : { kind: "local", path: location.value.path }
    : location?.case === "git"
      ? location.value.repositoryUrl.trim() === "" || source.kind !== ProtoExtensionSourceKind.GIT
        ? (() => { throw new GatewayError("Orchestrator returned an invalid Git Extension source."); })()
        : {
            kind: "git",
            repositoryUrl: location.value.repositoryUrl,
            ...(location.value.ref === undefined ? {} : { ref: location.value.ref }),
            sparsePaths: [...location.value.sparsePaths]
          }
      : (() => { throw new GatewayError("Orchestrator returned an Extension source without its location."); })();
  const state: ExtensionSourceView["state"] = source.state === ProtoExtensionSourceState.READY
    ? "ready"
    : source.state === ProtoExtensionSourceState.ERROR
      ? "error"
      : (() => { throw new GatewayError("Orchestrator returned an invalid Extension source state."); })();
  for (const count of [source.discoveredExtensionCount, source.declaredEntryCount, source.skippedEntryCount, source.unreadableEntryCount]) {
    if (!Number.isSafeInteger(count) || count < 0) throw new GatewayError("Orchestrator returned invalid Extension source counts.");
  }
  if (source.discoveredExtensionCount > MAX_EXTENSION_SOURCE_EXTENSIONS
    || source.declaredEntryCount > MAX_EXTENSION_SOURCE_DECLARED_ENTRIES
    || source.skippedEntryCount + source.unreadableEntryCount > source.declaredEntryCount
    || (state === "error") !== (source.error !== undefined)) {
    throw new GatewayError("Orchestrator returned inconsistent Extension source state.");
  }
  const addedAt = timestampMs(source.addedAt);
  const refreshedAt = source.refreshedAt === undefined ? undefined : timestampMs(source.refreshedAt);
  if (!Number.isSafeInteger(addedAt) || addedAt < 0 || (refreshedAt !== undefined && (!Number.isSafeInteger(refreshedAt) || refreshedAt < addedAt))) {
    throw new GatewayError("Orchestrator returned invalid Extension source timestamps.");
  }
  return {
    id: source.sourceId,
    revision,
    kind: mappedLocation.kind,
    location: mappedLocation,
    name: source.name,
    ...(source.displayName === undefined ? {} : { displayName: source.displayName }),
    state,
    contentRevision: source.contentRevision,
    discoveredExtensionCount: source.discoveredExtensionCount,
    declaredEntryCount: source.declaredEntryCount,
    skippedEntryCount: source.skippedEntryCount,
    unreadableEntryCount: source.unreadableEntryCount,
    addedAt,
    ...(refreshedAt === undefined ? {} : { refreshedAt }),
    ...(source.error === undefined ? {} : { error: source.error })
  };
}

function mapExtensionCatalogEntry(extension: ProtoExtensionCatalogEntry): ExtensionCatalogEntryView {
  const revision = extension.revision?.value;
  const setup = extension.setup;
  if (extension.extensionId.trim() === "" || revision === undefined || revision < 1n || setup?.revision?.value === undefined) {
    throw new GatewayError("Orchestrator returned an incomplete Extension descriptor.");
  }
  const owner = extension.owner?.kind;
  const mappedOwner: ExtensionCatalogEntryView["owner"] = owner?.case === "resource"
    ? owner.value.resourceVersion?.value === undefined || owner.value.resourceId.trim() === "" || owner.value.discoveredRevision.trim() === ""
      ? (() => { throw new GatewayError("Orchestrator returned an incomplete Extension Resource owner."); })()
      : {
          kind: "resource",
          resourceId: owner.value.resourceId,
          discoveredRevision: owner.value.discoveredRevision,
          resourceRevision: owner.value.resourceVersion.value
        }
    : owner?.case === "mcp"
      ? owner.value.serverRevision?.value === undefined || owner.value.mcpServerId.trim() === ""
        ? (() => { throw new GatewayError("Orchestrator returned an incomplete Extension MCP owner."); })()
        : { kind: "mcp", serverId: owner.value.mcpServerId, serverRevision: owner.value.serverRevision.value }
      : owner?.case === "source"
        ? owner.value.sourceRevision?.value === undefined || owner.value.sourceRevision.value < 1n
          || !/^extension_source_[a-f0-9]{32}$/u.test(owner.value.sourceId)
          || !/^extension_source_entry_[a-f0-9]{32}$/u.test(owner.value.entryId)
          || !/^sha256:[a-f0-9]{64}$/u.test(owner.value.contentRevision)
          ? (() => { throw new GatewayError("Orchestrator returned an incomplete Extension Source owner."); })()
          : {
              kind: "source",
              sourceId: owner.value.sourceId,
              sourceRevision: owner.value.sourceRevision.value,
              entryId: owner.value.entryId,
              contentRevision: owner.value.contentRevision
            }
        : (() => { throw new GatewayError("Orchestrator returned an Extension without an owner."); })();
  if (
    extension.update !== undefined
    && (
      mappedOwner.kind !== "resource"
      || (extension.update.availableVersion !== undefined && extension.update.availableVersion.trim() === "")
    )
  ) throw new GatewayError("Orchestrator returned an invalid Extension package update.");
  const mainViewIcon = extension.mainView === undefined ? undefined : extensionMainViewIcon(extension.mainView.icon);
  const mainView = extension.mainView === undefined ? undefined : {
    ...(extension.mainView.title === undefined ? {} : { title: extension.mainView.title }),
    ...(mainViewIcon === undefined ? {} : { icon: mainViewIcon })
  };
  if (extension.mainView?.title !== undefined && (
    extension.mainView.title.trim() !== extension.mainView.title
    || extension.mainView.title.length === 0
    || extension.mainView.title.length > 80
  ) || extension.sidebarSupported !== (mainView !== undefined) || extension.sidebarVisible && mainView === undefined) {
    throw new GatewayError("Orchestrator returned an invalid Extension main-view capability.");
  }
  const library = extension.library === undefined
    ? undefined
    : extension.library.schemaVersion === 1
      ? { schemaVersion: 1 as const }
      : (() => { throw new GatewayError("Orchestrator returned an invalid Extension Library capability."); })();
  return {
    id: extension.extensionId,
    revision,
    owner: mappedOwner,
    source: extension.source === ProtoExtensionCatalogSource.LOCAL
      ? "local"
      : extension.source === ProtoExtensionCatalogSource.MARKET
        ? "market"
        : (() => { throw new GatewayError("Orchestrator returned an invalid Extension source."); })(),
    installed: extension.installed,
    installState: extensionInstallState(extension.installState),
    name: extension.name,
    ...(extension.version === undefined ? {} : { version: extension.version }),
    ...(extension.author === undefined ? {} : { author: extension.author }),
    description: extension.description,
    enabled: extension.enabled,
    ...(mainView === undefined ? {} : { mainView }),
    ...(library === undefined ? {} : { library }),
    sidebarSupported: extension.sidebarSupported,
    sidebarVisible: extension.sidebarVisible,
    tools: extension.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      requiresPermission: tool.requiresPermission
    })),
    permissions: extension.permissions.map((permission) => ({
      id: permission.permissionId,
      label: permission.label,
      description: permission.description,
      required: permission.required,
      granted: permission.granted
    })),
    commands: extension.commands.map((command) => ({
      name: command.name,
      description: command.description,
      sessionId: command.sessionId
    })),
    setup: {
      state: extensionSetupState(setup.state),
      ...(setup.attemptId === undefined ? {} : { attemptId: setup.attemptId }),
      revision: setup.revision.value,
      fields: setup.fields.map((field) => ({
        id: field.fieldId,
        label: field.label,
        description: field.description,
        kind: extensionSetupFieldKind(field.kind),
        required: field.required,
        configured: field.configured,
        options: [...field.options]
      })),
      ...(setup.error === undefined ? {} : { error: setup.error })
    },
    ...(extension.update === undefined ? {} : {
      update: {
        source: mapExtensionSourceOwner(extension.update.source),
        ...(extension.update.availableVersion === undefined ? {} : { availableVersion: extension.update.availableVersion }),
        sourceReplacement: extension.update.sourceReplacement
      }
    }),
    useSupported: extension.useSupported,
    ...(extension.error === undefined ? {} : { error: extension.error })
  };
}

function mapExtensionMainViewSurface(surface: ProtoExtensionMainViewSurface): ExtensionMainViewSurfaceView {
  const resourceRevision = surface.owner?.resourceVersion?.value;
  const backendRevision = surface.backendRevision?.value;
  const backendGeneration = exactSafeUnsignedNumber(surface.backendGeneration);
  const expiresAt = surface.expiresAt === undefined ? undefined : timestampMs(surface.expiresAt);
  const icon = extensionMainViewIcon(surface.icon);
  if (!/^extension_surface_[a-f0-9]{32}$/u.test(surface.surfaceId)
    || !/^extension_[a-f0-9]{32}$/u.test(surface.extensionId)
    || surface.owner === undefined || surface.owner.resourceId.trim() === ""
    || !/^sha256:[a-f0-9]{64}$/u.test(surface.owner.discoveredRevision)
    || resourceRevision === undefined || resourceRevision < 1n
    || surface.backendId.trim() === "" || backendRevision === undefined || backendRevision < 1n
    || backendGeneration === undefined || expiresAt === undefined || !Number.isSafeInteger(expiresAt) || expiresAt < 0
    || !validExtensionSurfaceEndpoint(surface.endpoint, surface.surfaceId)
    || surface.title !== undefined && (surface.title.trim() !== surface.title || surface.title.length === 0 || surface.title.length > 80)) {
    throw new GatewayError("Orchestrator returned an invalid Extension main-view surface.");
  }
  return {
    id: surface.surfaceId,
    extensionId: surface.extensionId,
    owner: {
      kind: "resource",
      resourceId: surface.owner.resourceId,
      discoveredRevision: surface.owner.discoveredRevision,
      resourceRevision
    },
    backendId: surface.backendId,
    backendRevision,
    backendGeneration,
    endpoint: surface.endpoint,
    ...(surface.title === undefined ? {} : { title: surface.title }),
    ...(icon === undefined ? {} : { icon }),
    expiresAt
  };
}

function mapExtensionLibraryOverview(value: ProtoExtensionLibraryOverview): ExtensionLibraryOverviewView {
  const state = extensionLibraryState(value.state);
  const unavailableReason = extensionLibraryUnavailableReason(value.unavailableReason);
  if (!/^extension_[a-f0-9]{32}$/u.test(value.extensionId) || value.name.trim() === ""
    || !Number.isSafeInteger(value.files) || value.files < 0 || !Number.isSafeInteger(value.trashCount) || value.trashCount < 0
    || !Number.isSafeInteger(value.graceCount) || value.graceCount < 0 || value.bytes < 0n || value.softLimitBytes < 1n
    || value.diskFreeBytes !== undefined && value.diskFreeBytes < 0n
    || state === "unavailable" && unavailableReason === undefined
    || state !== "unavailable" && unavailableReason !== undefined
    || value.operation !== undefined && (value.operation.operationId.trim() === "" || value.operation.phase.trim() === "")) {
    throw new GatewayError("Orchestrator returned an invalid Extension Library overview.");
  }
  return {
    extensionId: value.extensionId,
    name: value.name,
    state,
    ...(unavailableReason === undefined ? {} : { unavailableReason }),
    ...(value.location === undefined ? {} : { location: mapExtensionLibraryLocation(value.location) }),
    files: value.files,
    bytes: value.bytes,
    ...(value.diskFreeBytes === undefined ? {} : { diskFreeBytes: value.diskFreeBytes }),
    softLimitBytes: value.softLimitBytes,
    softLimitExceeded: value.softLimitExceeded,
    orphaned: value.orphaned,
    trashCount: value.trashCount,
    graceCount: value.graceCount,
    ...(value.operation === undefined ? {} : { operation: { id: value.operation.operationId, phase: value.operation.phase } })
  };
}

function extensionLibraryState(value: ProtoExtensionLibraryState): ExtensionLibraryOverviewView["state"] {
  switch (value) {
    case ProtoExtensionLibraryState.READY: return "ready";
    case ProtoExtensionLibraryState.READ_ONLY: return "readOnly";
    case ProtoExtensionLibraryState.UNAVAILABLE: return "unavailable";
    default: throw new GatewayError("Orchestrator returned an invalid Extension Library state.");
  }
}

function extensionLibraryUnavailableReason(
  value: ProtoExtensionLibraryUnavailableReason
): ExtensionLibraryOverviewView["unavailableReason"] {
  switch (value) {
    case ProtoExtensionLibraryUnavailableReason.UNSPECIFIED: return undefined;
    case ProtoExtensionLibraryUnavailableReason.METADATA_CORRUPT: return "metadataCorrupt";
    case ProtoExtensionLibraryUnavailableReason.FILE_LIMIT: return "fileLimit";
    case ProtoExtensionLibraryUnavailableReason.IO: return "io";
    case ProtoExtensionLibraryUnavailableReason.OPERATION_IN_PROGRESS: return "operationInProgress";
    case ProtoExtensionLibraryUnavailableReason.DISK_MISSING: return "diskMissing";
    case ProtoExtensionLibraryUnavailableReason.BINDING_MOVED: return "bindingMoved";
    case ProtoExtensionLibraryUnavailableReason.STATE_CORRUPT: return "stateCorrupt";
    default: throw new GatewayError("Orchestrator returned an invalid Extension Library unavailable reason.");
  }
}

function mapExtensionLibraryLocation(value: ProtoExtensionLibraryLocation): ExtensionLibraryLocationView {
  const generation = value.generation?.value;
  const kind = value.kind === ProtoExtensionLibraryLocationKind.DEFAULT
    ? "default" as const
    : value.kind === ProtoExtensionLibraryLocationKind.CUSTOM
      ? "custom" as const
      : undefined;
  if (kind === undefined || value.path.trim() === "" || generation === undefined || generation < 1n) {
    throw new GatewayError("Orchestrator returned an invalid Extension Library location.");
  }
  return { kind, path: value.path, generation };
}

function mapExtensionLibrarySession(value: ProtoExtensionLibrarySession): ExtensionLibrarySessionView {
  const expiresAt = requiredExtensionLibraryTimestamp(value.expiresAt, "session expiry");
  const generation = value.bindingGeneration?.value;
  const limits = value.limits;
  if (!/^library_session_[a-f0-9]{32}$/u.test(value.sessionId)
    || !/^extension_[a-f0-9]{32}$/u.test(value.extensionId) || generation === undefined || generation < 1n
    || limits === undefined || limits.maximumReadBytes < 1n || limits.maximumWriteBytes < 1n
    || limits.maximumStreamBytes < limits.maximumWriteBytes || limits.maximumPathCharacters < 1
    || limits.maximumPathSegments < 1 || limits.maximumListPageSize < 1 || limits.maximumFiles < 1
    || limits.softLimitBytes < 1n || limits.diskReserveBytes < 1n) {
    throw new GatewayError("Orchestrator returned an invalid Extension Library session.");
  }
  return {
    id: value.sessionId,
    extensionId: value.extensionId,
    expiresAt,
    bindingGeneration: generation,
    limits: {
      maximumReadBytes: limits.maximumReadBytes,
      maximumWriteBytes: limits.maximumWriteBytes,
      maximumStreamBytes: limits.maximumStreamBytes,
      maximumPathCharacters: limits.maximumPathCharacters,
      maximumPathSegments: limits.maximumPathSegments,
      maximumListPageSize: limits.maximumListPageSize,
      maximumFiles: limits.maximumFiles,
      softLimitBytes: limits.softLimitBytes,
      diskReserveBytes: limits.diskReserveBytes
    }
  };
}

function mapExtensionLibraryTrash(value: ProtoExtensionLibraryTrashEntry): ExtensionLibraryTrashEntryView {
  if (!/^library_trash_[a-f0-9]{32}$/u.test(value.trashId) || !/^extension_[a-f0-9]{32}$/u.test(value.extensionId)
    || value.name.trim() === "" || !Number.isSafeInteger(value.files) || value.files < 0 || value.bytes < 0n) {
    throw new GatewayError("Orchestrator returned an invalid Extension Library trash record.");
  }
  const deletedAt = requiredExtensionLibraryTimestamp(value.deletedAt, "trash deletion");
  const expiresAt = requiredExtensionLibraryTimestamp(value.expiresAt, "trash expiry");
  if (expiresAt <= deletedAt) throw new GatewayError("Orchestrator returned an invalid Extension Library trash retention window.");
  return { id: value.trashId, extensionId: value.extensionId, name: value.name, deletedAt, expiresAt, files: value.files, bytes: value.bytes };
}

function mapExtensionLibraryGrace(value: ProtoExtensionLibraryGraceEntry): ExtensionLibraryGraceEntryView {
  if (!/^library_grace_[a-f0-9]{32}$/u.test(value.graceId) || !/^extension_[a-f0-9]{32}$/u.test(value.extensionId)
    || value.name.trim() === "" || !Number.isSafeInteger(value.files) || value.files < 0 || value.bytes < 0n) {
    throw new GatewayError("Orchestrator returned an invalid Extension Library grace record.");
  }
  const createdAt = requiredExtensionLibraryTimestamp(value.createdAt, "grace creation");
  const expiresAt = requiredExtensionLibraryTimestamp(value.expiresAt, "grace expiry");
  if (expiresAt <= createdAt) throw new GatewayError("Orchestrator returned an invalid Extension Library grace window.");
  return { id: value.graceId, extensionId: value.extensionId, name: value.name, createdAt, expiresAt, files: value.files, bytes: value.bytes };
}

function mapExtensionLibraryCall(call: ExtensionLibraryCallView) {
  const statement = (value: { readonly sql: string; readonly parameters?: readonly ExtensionLibrarySqlValueView[] }) => ({
    sql: value.sql,
    parameters: (value.parameters ?? []).map(mapExtensionLibrarySqlValueInput)
  });
  switch (call.kind) {
    case "read": return create(ExtensionLibraryCallSchema, { operation: { case: "read", value: {
      path: call.path,
      ...(call.offset === undefined ? {} : { offset: call.offset }),
      ...(call.length === undefined ? {} : { length: call.length })
    } } });
    case "write": return create(ExtensionLibraryCallSchema, { operation: { case: "write", value: {
      path: call.path, content: call.content, ifNotExists: call.ifNotExists ?? false
    } } });
    case "stat": return create(ExtensionLibraryCallSchema, { operation: { case: "stat", value: { path: call.path } } });
    case "list": return create(ExtensionLibraryCallSchema, { operation: { case: "list", value: {
      ...(call.path === undefined ? {} : { path: call.path }),
      recursive: call.recursive ?? false,
      ...(call.limit === undefined ? {} : { limit: call.limit }),
      ...(call.cursor === undefined ? {} : { cursor: call.cursor })
    } } });
    case "mkdir": return create(ExtensionLibraryCallSchema, { operation: { case: "mkdir", value: { path: call.path } } });
    case "delete": return create(ExtensionLibraryCallSchema, { operation: { case: "delete", value: { path: call.path, recursive: call.recursive ?? false } } });
    case "rename": return create(ExtensionLibraryCallSchema, { operation: { case: "rename", value: { from: call.from, to: call.to, overwrite: call.overwrite ?? false } } });
    case "writeBegin": return create(ExtensionLibraryCallSchema, { operation: { case: "writeBegin", value: {
      path: call.path,
      totalBytes: call.totalBytes,
      ...(call.sha256 === undefined ? {} : { sha256: call.sha256 }),
      ifNotExists: call.ifNotExists ?? false
    } } });
    case "writeChunk": return create(ExtensionLibraryCallSchema, { operation: { case: "writeChunk", value: {
      streamId: call.streamId, sequence: call.sequence, content: call.content
    } } });
    case "writeCommit": return create(ExtensionLibraryCallSchema, { operation: { case: "writeCommit", value: { streamId: call.streamId } } });
    case "writeAbort": return create(ExtensionLibraryCallSchema, { operation: { case: "writeAbort", value: { streamId: call.streamId } } });
    case "sqlOpen": return create(ExtensionLibraryCallSchema, { operation: { case: "sqlOpen", value: {
      path: call.path, create: call.create ?? false, readOnly: call.readOnly ?? false
    } } });
    case "sqlExecute": return create(ExtensionLibraryCallSchema, { operation: { case: "sqlExecute", value: {
      handleId: call.handleId, statement: statement(call.statement)
    } } });
    case "sqlBatch": return create(ExtensionLibraryCallSchema, { operation: { case: "sqlBatch", value: {
      handleId: call.handleId, statements: call.statements.map(statement)
    } } });
    case "sqlMigrate": return create(ExtensionLibraryCallSchema, { operation: { case: "sqlMigrate", value: {
      handleId: call.handleId,
      migrations: call.migrations.map((migration) => ({ version: migration.version, statements: [...migration.statements] }))
    } } });
    case "sqlBackup": return create(ExtensionLibraryCallSchema, { operation: { case: "sqlBackup", value: {
      handleId: call.handleId, targetPath: call.targetPath
    } } });
    case "sqlCheck": return create(ExtensionLibraryCallSchema, { operation: { case: "sqlCheck", value: { handleId: call.handleId } } });
    case "sqlClose": return create(ExtensionLibraryCallSchema, { operation: { case: "sqlClose", value: { handleId: call.handleId } } });
  }
}

function mapExtensionLibrarySqlValueInput(value: ExtensionLibrarySqlValueView) {
  switch (value.kind) {
    case "null": return { value: { case: "nullValue" as const, value: true } };
    case "number": return { value: { case: "numberValue" as const, value: value.value } };
    case "integer": return { value: { case: "integerValue" as const, value: value.value.toString(10) } };
    case "text": return { value: { case: "textValue" as const, value: value.value } };
    case "blob": return { value: { case: "blobValue" as const, value: value.value } };
  }
}

function mapExtensionLibraryCallResult(value: ProtoExtensionLibraryCallResult): ExtensionLibraryCallResultView {
  switch (value.result.case) {
    case "read":
      if (!validLibraryRelativePath(value.result.value.path) || !/^[a-f0-9]{64}$/u.test(value.result.value.sha256)) {
        throw new GatewayError("Orchestrator returned an invalid Extension Library read result.");
      }
      return { kind: "read", path: value.result.value.path, content: Uint8Array.from(value.result.value.content), sha256: value.result.value.sha256 };
    case "write":
      if (!validLibraryRelativePath(value.result.value.path) || value.result.value.bytes < 0n || !/^[a-f0-9]{64}$/u.test(value.result.value.sha256)) {
        throw new GatewayError("Orchestrator returned an invalid Extension Library write result.");
      }
      return { kind: "write", path: value.result.value.path, bytes: value.result.value.bytes, sha256: value.result.value.sha256 };
    case "stat": return { kind: "stat", entry: mapExtensionLibraryEntry(value.result.value) };
    case "list": return {
      kind: "list",
      entries: value.result.value.entries.map(mapExtensionLibraryEntry),
      ...(value.result.value.nextCursor === undefined ? {} : { nextCursor: value.result.value.nextCursor })
    };
    case "path":
      if (!validLibraryRelativePath(value.result.value.path)) throw new GatewayError("Orchestrator returned an invalid Extension Library path result.");
      return { kind: "path", path: value.result.value.path, existed: value.result.value.existed };
    case "rename":
      if (!validLibraryRelativePath(value.result.value.from) || !validLibraryRelativePath(value.result.value.to)) {
        throw new GatewayError("Orchestrator returned an invalid Extension Library rename result.");
      }
      return { kind: "rename", from: value.result.value.from, to: value.result.value.to };
    case "stream": {
      if (!/^library_stream_[a-f0-9]{32}$/u.test(value.result.value.streamId) || value.result.value.receivedBytes < 0n
        || !Number.isSafeInteger(value.result.value.nextSequence) || value.result.value.nextSequence < 0) {
        throw new GatewayError("Orchestrator returned an invalid Extension Library stream result.");
      }
      return {
        kind: "stream",
        streamId: value.result.value.streamId,
        receivedBytes: value.result.value.receivedBytes,
        nextSequence: value.result.value.nextSequence,
        ...(value.result.value.expiresAt === undefined ? {} : { expiresAt: requiredExtensionLibraryTimestamp(value.result.value.expiresAt, "stream expiry") }),
        aborted: value.result.value.aborted
      };
    }
    case "sqlHandle":
      if (value.result.value.handleId.trim() === "" || !validLibraryRelativePath(value.result.value.path)) {
        throw new GatewayError("Orchestrator returned an invalid Extension Library SQLite handle.");
      }
      return {
        kind: "sqlHandle",
        handleId: value.result.value.handleId,
        path: value.result.value.path,
        readOnly: value.result.value.readOnly,
        userVersion: value.result.value.userVersion
      };
    case "sqlResult": return { kind: "sqlResult", value: mapExtensionLibrarySqlResult(value.result.value) };
    case "sqlBatch": return { kind: "sqlBatch", results: value.result.value.results.map(mapExtensionLibrarySqlResult) };
    case "sqlVersion": return {
      kind: "sqlVersion",
      userVersion: value.result.value.userVersion,
      ...(value.result.value.path === undefined ? {} : { path: value.result.value.path })
    };
    case "boolean": return { kind: "boolean", value: value.result.value.value };
    default: throw new GatewayError("Orchestrator returned an unknown Extension Library call result.");
  }
}

function mapExtensionLibraryEntry(value: ProtoExtensionLibraryEntry): ExtensionLibraryEntryView {
  const kind = value.kind === ProtoExtensionLibraryEntryKind.FILE
    ? "file" as const
    : value.kind === ProtoExtensionLibraryEntryKind.DIRECTORY
      ? "directory" as const
      : undefined;
  if (kind === undefined || !validLibraryRelativePath(value.path) || value.bytes < 0n) {
    throw new GatewayError("Orchestrator returned an invalid Extension Library entry.");
  }
  return { path: value.path, kind, bytes: value.bytes, modifiedAt: requiredExtensionLibraryTimestamp(value.modifiedAt, "entry modification") };
}

function mapExtensionLibrarySqlResult(value: ProtoExtensionLibrarySqlResult): ExtensionLibrarySqlResultView {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value.changes)
    || value.lastInsertRowId !== undefined && !/^-?(?:0|[1-9][0-9]*)$/u.test(value.lastInsertRowId)) {
    throw new GatewayError("Orchestrator returned invalid Extension Library SQLite counters.");
  }
  return {
    rows: value.rows.map((row) => ({ cells: row.cells.map((cell) => {
      if (cell.name.trim() === "" || cell.value === undefined) throw new GatewayError("Orchestrator returned an invalid Extension Library SQLite cell.");
      return { name: cell.name, value: mapExtensionLibrarySqlValue(cell.value) };
    }) })),
    changes: BigInt(value.changes),
    ...(value.lastInsertRowId === undefined ? {} : { lastInsertRowId: BigInt(value.lastInsertRowId) })
  };
}

function mapExtensionLibrarySqlValue(value: ProtoExtensionLibrarySqlValue): ExtensionLibrarySqlValueView {
  switch (value.value.case) {
    case "nullValue":
      if (!value.value.value) throw new GatewayError("Orchestrator returned an invalid Extension Library SQLite null.");
      return { kind: "null" };
    case "numberValue":
      if (!Number.isFinite(value.value.value)) throw new GatewayError("Orchestrator returned a non-finite Extension Library SQLite number.");
      return { kind: "number", value: value.value.value };
    case "integerValue":
      if (!/^-?(?:0|[1-9][0-9]*)$/u.test(value.value.value)) throw new GatewayError("Orchestrator returned an invalid Extension Library SQLite integer.");
      return { kind: "integer", value: BigInt(value.value.value) };
    case "textValue": return { kind: "text", value: value.value.value };
    case "blobValue": return { kind: "blob", value: Uint8Array.from(value.value.value) };
    default: throw new GatewayError("Orchestrator returned an empty Extension Library SQLite value.");
  }
}

function requiredExtensionLibraryTimestamp(
  value: { readonly seconds: bigint; readonly nanos: number } | undefined,
  label: string
): number {
  const mapped = timestampMs(value);
  if (value === undefined || !Number.isSafeInteger(mapped) || mapped < 0 || value.nanos < 0 || value.nanos >= 1_000_000_000) {
    throw new GatewayError(`Orchestrator returned an invalid Extension Library ${label}.`);
  }
  return mapped;
}

function validLibraryRelativePath(value: string): boolean {
  if (value.length === 0 || value.length > 512 || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/u.test(value)) return false;
  const segments = value.split("/");
  return segments.length <= 32 && segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function extensionMainViewIcon(value: ProtoExtensionMainViewIcon): ExtensionMainViewIconView | undefined {
  switch (value) {
    case ProtoExtensionMainViewIcon.UNSPECIFIED: return undefined;
    case ProtoExtensionMainViewIcon.ACTIVITY: return "activity";
    case ProtoExtensionMainViewIcon.BOX: return "box";
    case ProtoExtensionMainViewIcon.CODE: return "code";
    case ProtoExtensionMainViewIcon.FILE_TEXT: return "fileText";
    case ProtoExtensionMainViewIcon.GLOBE: return "globe";
    case ProtoExtensionMainViewIcon.LAYOUT: return "layout";
    case ProtoExtensionMainViewIcon.SEARCH: return "search";
    case ProtoExtensionMainViewIcon.SPARKLES: return "sparkles";
    case ProtoExtensionMainViewIcon.TERMINAL: return "terminal";
    case ProtoExtensionMainViewIcon.TOOL: return "tool";
    default: throw new GatewayError("Orchestrator returned an invalid Extension main-view icon.");
  }
}

function validExtensionSurfaceEndpoint(value: string, surfaceId: string): boolean {
  const prefix = `/v1/extensions/main-views/${surfaceId}/`;
  if (!value.startsWith(prefix) || value.includes("?") || value.includes("#")) return false;
  const suffix = value.slice(prefix.length);
  const separator = suffix.indexOf("/");
  if (separator !== 64 || !/^[a-f0-9]{64}$/u.test(suffix.slice(0, separator))) return false;
  const encodedEntry = suffix.slice(separator + 1);
  if (encodedEntry === "" || encodedEntry.includes("/")) return false;
  try {
    const entry = decodeURIComponent(encodedEntry);
    return entry !== "." && entry !== ".." && !entry.includes("/") && !entry.includes("\\") && !entry.includes("\0");
  } catch {
    return false;
  }
}

function mapExtensionSourceOwner(
  owner: { readonly sourceId: string; readonly sourceRevision?: { readonly value: bigint }; readonly entryId: string; readonly contentRevision: string } | undefined
): Extract<ExtensionCatalogEntryView["owner"], { readonly kind: "source" }> {
  if (
    owner?.sourceRevision?.value === undefined
    || owner.sourceRevision.value < 1n
    || !/^extension_source_[a-f0-9]{32}$/u.test(owner.sourceId)
    || !/^extension_source_entry_[a-f0-9]{32}$/u.test(owner.entryId)
    || !/^sha256:[a-f0-9]{64}$/u.test(owner.contentRevision)
  ) throw new GatewayError("Orchestrator returned an incomplete Extension Source owner.");
  return {
    kind: "source",
    sourceId: owner.sourceId,
    sourceRevision: owner.sourceRevision.value,
    entryId: owner.entryId,
    contentRevision: owner.contentRevision
  };
}

function mapExtensionPackagePreview(preview: ProtoExtensionPackagePreview): ExtensionPackagePreviewView {
  const extensionRevision = preview.extensionRevision?.value;
  const action = extensionPackageAction(preview.action);
  const current = preview.currentResource;
  if (
    preview.extensionId.trim() === ""
    || extensionRevision === undefined
    || extensionRevision < 1n
    || preview.resourceId.trim() === ""
    || preview.backendId.trim() === ""
    || preview.packageName.trim() === ""
    || (preview.installedVersion !== undefined && preview.installedVersion.trim() === "")
    || (preview.availableVersion !== undefined && preview.availableVersion.trim() === "")
    || (action === "install" ? current !== undefined || preview.sourceReplacement : current === undefined)
    || preview.sourceReplacement !== (action === "replace")
    || (action === "update" && preview.resourceId !== current?.resourceId)
    || (action === "replace" && preview.resourceId === current?.resourceId)
  ) throw new GatewayError("Orchestrator returned an invalid Extension package preview.");
  if (
    current !== undefined
    && (
      current.resourceId.trim() === ""
      || current.resourceRevision?.value === undefined
      || current.resourceRevision.value < 1n
      || current.name.trim() === ""
      || current.sourceDisplay.trim() === ""
    )
  ) throw new GatewayError("Orchestrator returned an invalid current Extension Resource.");
  return {
    extensionId: preview.extensionId,
    extensionRevision,
    action,
    resourceId: preview.resourceId,
    backendId: preview.backendId,
    packageName: preview.packageName,
    ...(preview.installedVersion === undefined ? {} : { installedVersion: preview.installedVersion }),
    ...(preview.availableVersion === undefined ? {} : { availableVersion: preview.availableVersion }),
    ...(current === undefined ? {} : {
      currentResource: {
        resourceId: current.resourceId,
        resourceRevision: current.resourceRevision!.value,
        name: current.name,
        sourceDisplay: current.sourceDisplay
      }
    }),
    sourceReplacement: preview.sourceReplacement,
    preservesEnabled: preview.preservesEnabled,
    compatibilityDetails: preview.compatibilityDetails.map((detail) => ({
      kind: strictResourceKind(detail.kind),
      name: detail.name,
      compatibility: strictResourceCompatibility(detail.compatibility),
      issues: detail.issues.map(strictResourceCompatibilityIssue),
      detectedApis: detail.detectedApis.map(strictResourceUiApi),
      adaptedApis: detail.adaptedApis.map(strictResourceUiApi),
      unsupportedApis: detail.unsupportedApis.map(strictResourceUiApi)
    })),
    runtimeRequirements: preview.runtimeRequirements.map((requirement) => ({
      packageName: requirement.packageName,
      range: requirement.range,
      ...(requirement.currentVersion === undefined ? {} : { currentVersion: requirement.currentVersion }),
      status: strictResourceRuntimeRequirementStatus(requirement.status)
    })),
    warnings: preview.warnings.map(strictResourcePackageWarning),
    disabledLifecycleScripts: [...preview.disabledLifecycleScripts],
    canToggle: preview.canToggle
  };
}

function mapExtensionPackageExportAuthority(
  authority: ProtoExtensionPackageExportAuthority | undefined
): ExtensionPackageExportAuthorityView {
  const extensionRevision = authority?.extensionRevision?.value;
  const resourceRevision = authority?.resourceRevision?.value;
  const backendRevision = authority?.backendRevision?.value;
  const backendGeneration = authority === undefined ? undefined : exactSafeUnsignedNumber(authority.backendGeneration);
  if (
    authority === undefined
    || authority.extensionId.trim() === ""
    || extensionRevision === undefined
    || extensionRevision < 1n
    || authority.resourceId.trim() === ""
    || resourceRevision === undefined
    || resourceRevision < 1n
    || !/^sha256:[a-f0-9]{64}$/u.test(authority.discoveredRevision)
    || authority.backendId.trim() === ""
    || backendRevision === undefined
    || backendRevision < 1n
    || backendGeneration === undefined
    || backendGeneration < 1
    || authority.packageName.trim() === ""
    || (authority.packageVersion !== undefined && authority.packageVersion.trim() === "")
  ) throw new GatewayError("Orchestrator returned an invalid Extension package export authority.");
  return {
    extensionId: authority.extensionId,
    extensionRevision,
    resourceId: authority.resourceId,
    resourceRevision,
    discoveredRevision: authority.discoveredRevision,
    backendId: authority.backendId,
    backendRevision,
    backendGeneration,
    packageName: authority.packageName,
    ...(authority.packageVersion === undefined ? {} : { packageVersion: authority.packageVersion })
  };
}

function mapExtensionPackageExportJob(job: ProtoExtensionPackageExportJob): ExtensionPackageExportJobView {
  const revision = job.revision?.value;
  const state = extensionPackageExportState(job.state);
  const authority = mapExtensionPackageExportAuthority(job.authority);
  const uncompressedBytes = exactSafeUnsignedNumber(job.uncompressedBytes);
  const createdAt = timestampMs(job.createdAt);
  const updatedAt = timestampMs(job.updatedAt);
  const completedAt = job.completedAt === undefined ? undefined : timestampMs(job.completedAt);
  const active = state === "pending" || state === "snapshotting" || state === "packaging" || state === "verifying";
  if (
    job.exportId.trim() === ""
    || revision === undefined
    || revision < 1n
    || job.archiveFormat !== "npm-tar-gzip"
    || !isSafeArchiveFileName(job.fileName)
    || !Number.isSafeInteger(job.files)
    || job.files < 0
    || uncompressedBytes === undefined
    || createdAt < 1
    || updatedAt < createdAt
    || (active && completedAt !== undefined)
    || (!active && completedAt === undefined)
    || (completedAt !== undefined && completedAt < updatedAt)
    || (state === "ready" ? job.artifact === undefined : job.artifact !== undefined)
    || (state === "failed" ? job.error?.trim() === "" || job.error === undefined : job.error !== undefined)
  ) throw new GatewayError("Orchestrator returned an invalid Extension package export job.");
  const artifact = job.artifact;
  const artifactBytes = artifact === undefined ? undefined : exactSafeUnsignedNumber(artifact.byteSize);
  if (
    artifact !== undefined
    && (
      artifact.blobId.trim() === ""
      || !/^[a-f0-9]{64}$/u.test(artifact.sha256Hex)
      || artifactBytes === undefined
      || artifactBytes < 1
      || artifact.mediaType !== "application/gzip"
      || artifact.fileName !== job.fileName
    )
  ) throw new GatewayError("Orchestrator returned an invalid Extension package export Artifact.");
  return {
    id: job.exportId,
    revision,
    state,
    authority,
    archiveFormat: "npm-tar-gzip",
    fileName: job.fileName,
    files: job.files,
    uncompressedBytes,
    ...(artifact === undefined ? {} : {
      artifact: {
        blobId: artifact.blobId,
        sha256: artifact.sha256Hex,
        byteSize: artifactBytes!,
        mediaType: artifact.mediaType,
        fileName: artifact.fileName
      }
    }),
    createdAt,
    updatedAt,
    ...(completedAt === undefined ? {} : { completedAt }),
    ...(job.error === undefined ? {} : { error: job.error })
  };
}

function mapExtensionPackageExportPreview(preview: ProtoExtensionPackageExportPreview): Omit<ExtensionPackageExportPreviewView, "recoveredFromCorruption"> {
  const authority = mapExtensionPackageExportAuthority(preview.authority);
  const maximumUncompressedBytes = exactSafeUnsignedNumber(preview.maximumUncompressedBytes);
  const activeExport = preview.activeExport === undefined ? undefined : mapExtensionPackageExportJob(preview.activeExport);
  if (
    preview.archiveFormat !== "npm-tar-gzip"
    || !isSafeArchiveFileName(preview.fileName)
    || !Number.isSafeInteger(preview.maximumEntries)
    || preview.maximumEntries < 1
    || maximumUncompressedBytes === undefined
    || maximumUncompressedBytes < 1
    || preview.localOnly !== true
    || (activeExport !== undefined && (
      !["pending", "snapshotting", "packaging", "verifying"].includes(activeExport.state)
      || !sameExtensionPackageExportAuthority(activeExport.authority, authority)
    ))
  ) throw new GatewayError("Orchestrator returned an invalid Extension package export preview.");
  return {
    ...authority,
    archiveFormat: "npm-tar-gzip",
    fileName: preview.fileName,
    maximumEntries: preview.maximumEntries,
    maximumUncompressedBytes,
    localOnly: true,
    ...(activeExport === undefined ? {} : { activeExport })
  };
}

function extensionPackageExportState(value: ProtoExtensionPackageExportState): ExtensionPackageExportJobView["state"] {
  switch (value) {
    case ProtoExtensionPackageExportState.PENDING: return "pending";
    case ProtoExtensionPackageExportState.SNAPSHOTTING: return "snapshotting";
    case ProtoExtensionPackageExportState.PACKAGING: return "packaging";
    case ProtoExtensionPackageExportState.VERIFYING: return "verifying";
    case ProtoExtensionPackageExportState.READY: return "ready";
    case ProtoExtensionPackageExportState.FAILED: return "failed";
    case ProtoExtensionPackageExportState.CANCELLED: return "cancelled";
    case ProtoExtensionPackageExportState.UNSPECIFIED:
    default: throw new GatewayError("Orchestrator returned an invalid Extension package export state.");
  }
}

function isSafeArchiveFileName(value: string): boolean {
  return value.trim() !== "" && value.length <= 255 && value.endsWith(".tgz")
    && !value.includes("/") && !value.includes("\\") && !value.includes("\0");
}

function sameExtensionPackageExportAuthority(
  left: ExtensionPackageExportAuthorityView,
  right: ExtensionPackageExportAuthorityView
): boolean {
  return left.extensionId === right.extensionId
    && left.extensionRevision === right.extensionRevision
    && left.resourceId === right.resourceId
    && left.resourceRevision === right.resourceRevision
    && left.discoveredRevision === right.discoveredRevision
    && left.backendId === right.backendId
    && left.backendRevision === right.backendRevision
    && left.backendGeneration === right.backendGeneration
    && left.packageName === right.packageName
    && left.packageVersion === right.packageVersion;
}

function extensionPackageAction(value: ProtoExtensionPackageAction): ExtensionPackagePreviewView["action"] {
  switch (value) {
    case ProtoExtensionPackageAction.INSTALL: return "install";
    case ProtoExtensionPackageAction.UPDATE: return "update";
    case ProtoExtensionPackageAction.REPLACE: return "replace";
    case ProtoExtensionPackageAction.UNSPECIFIED:
    default: throw new GatewayError("Orchestrator returned an invalid Extension package action.");
  }
}

function protoExtensionPackageAction(value: ExtensionPackagePreviewView["action"]): ProtoExtensionPackageAction {
  switch (value) {
    case "install": return ProtoExtensionPackageAction.INSTALL;
    case "update": return ProtoExtensionPackageAction.UPDATE;
    case "replace": return ProtoExtensionPackageAction.REPLACE;
  }
}

function strictResourceKind(value: ResourceKind): ResourceView["kind"] {
  switch (value) {
    case ResourceKind.EXTENSION: return "extension";
    case ResourceKind.SKILL: return "skill";
    case ResourceKind.PROMPT_TEMPLATE: return "prompt";
    case ResourceKind.PACKAGE: return "package";
    case ResourceKind.THEME: return "theme";
    case ResourceKind.UNSPECIFIED:
    default: throw new GatewayError("Orchestrator returned an invalid package Resource kind.");
  }
}

function strictResourceCompatibility(value: ResourceCompatibility): ResourceView["compatibilityDetails"][number]["compatibility"] {
  switch (value) {
    case ResourceCompatibility.SUPPORTED: return "supported";
    case ResourceCompatibility.PARTIAL: return "partial";
    case ResourceCompatibility.UNSUPPORTED: return "unsupported";
    case ResourceCompatibility.UNKNOWN: return "unknown";
    case ResourceCompatibility.UNSPECIFIED:
    default: throw new GatewayError("Orchestrator returned an invalid package compatibility state.");
  }
}

function strictResourceCompatibilityIssue(
  value: ResourceCompatibilityIssue
): ResourceView["compatibilityDetails"][number]["issues"][number] {
  const mapped = resourceCompatibilityIssue(value);
  if (mapped === "unknown") {
    throw new GatewayError("Orchestrator returned an invalid package compatibility issue.");
  }
  return mapped;
}

function strictResourceUiApi(value: ResourceUiApi): ResourceView["compatibilityDetails"][number]["detectedApis"][number] {
  const mapped = resourceUiApi(value);
  if (mapped === "unknown") throw new GatewayError("Orchestrator returned an invalid package UI API.");
  return mapped;
}

function strictResourceRuntimeRequirementStatus(
  value: ResourceRuntimeRequirementStatus
): ResourceView["runtimeRequirements"][number]["status"] {
  switch (value) {
    case ResourceRuntimeRequirementStatus.COMPATIBLE: return "compatible";
    case ResourceRuntimeRequirementStatus.INCOMPATIBLE: return "incompatible";
    case ResourceRuntimeRequirementStatus.UNKNOWN: return "unknown";
    case ResourceRuntimeRequirementStatus.UNSPECIFIED:
    default: throw new GatewayError("Orchestrator returned an invalid package runtime requirement state.");
  }
}

function strictResourcePackageWarning(value: ResourcePackageWarning): ResourceView["warnings"][number] {
  const mapped = resourcePackageWarning(value);
  if (mapped === "unknown") throw new GatewayError("Orchestrator returned an invalid package warning.");
  return mapped;
}

function extensionInstallState(value: ProtoExtensionInstallState): ExtensionCatalogEntryView["installState"] {
  switch (value) {
    case ProtoExtensionInstallState.AVAILABLE: return "available";
    case ProtoExtensionInstallState.INSTALLING: return "installing";
    case ProtoExtensionInstallState.INSTALLED: return "installed";
    case ProtoExtensionInstallState.UPDATE_AVAILABLE: return "updateAvailable";
    case ProtoExtensionInstallState.ERROR: return "error";
    case ProtoExtensionInstallState.UNSPECIFIED:
    default:
      throw new GatewayError("Orchestrator returned an invalid Extension install state.");
  }
}

function extensionSetupState(value: ProtoExtensionSetupState): ExtensionCatalogEntryView["setup"]["state"] {
  switch (value) {
    case ProtoExtensionSetupState.NOT_REQUIRED: return "notRequired";
    case ProtoExtensionSetupState.REQUIRED: return "required";
    case ProtoExtensionSetupState.IN_PROGRESS: return "inProgress";
    case ProtoExtensionSetupState.READY: return "ready";
    case ProtoExtensionSetupState.CANCELLED: return "cancelled";
    case ProtoExtensionSetupState.FAILED: return "failed";
    case ProtoExtensionSetupState.UNSPECIFIED:
    default:
      throw new GatewayError("Orchestrator returned an invalid Extension setup state.");
  }
}

function extensionSetupFieldKind(value: ProtoExtensionSetupFieldKind): ExtensionCatalogEntryView["setup"]["fields"][number]["kind"] {
  switch (value) {
    case ProtoExtensionSetupFieldKind.TEXT: return "text";
    case ProtoExtensionSetupFieldKind.SECRET: return "secret";
    case ProtoExtensionSetupFieldKind.OAUTH: return "oauth";
    case ProtoExtensionSetupFieldKind.CONFIRMATION: return "confirmation";
    case ProtoExtensionSetupFieldKind.UNSPECIFIED:
    default:
      throw new GatewayError("Orchestrator returned an invalid Extension setup field.");
  }
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
        ...(tool.resourceId === "" ? {} : { resourceId: tool.resourceId }),
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
    kind: device.kind === DeviceKind.WEB ? "web" : device.kind === DeviceKind.DESKTOP ? "desktop" : device.kind === DeviceKind.SERVICE ? "service" : device.kind === DeviceKind.MOBILE ? "mobile" : "unknown",
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
  if (settings.auxiliaryText?.revision === undefined) {
    throw new Error("Orchestrator returned incomplete auxiliary text settings.");
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
      automationTarget: browserAutomationTarget(browser.automationTarget),
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
          resourceId: "",
          keyless: false,
          credentialConfigured: false,
          refinementEnabled: false,
          fallbackEnabled: false,
          fallbackProtocol: "openAiCompatibleBatch",
          fallbackEndpoint: "https://api.openai.com/v1/audio/transcriptions",
          fallbackModel: "whisper-1",
          fallbackResourceId: "",
          fallbackKeyless: false,
          fallbackCredentialConfigured: false,
          revision: 0n
        }
      : {
          enabled: settings.voiceInput.enabled,
          protocol: voiceInputProtocolView(settings.voiceInput.protocol),
          endpoint: settings.voiceInput.endpoint,
          model: settings.voiceInput.model,
          resourceId: settings.voiceInput.resourceId,
          keyless: settings.voiceInput.keyless,
          credentialConfigured: settings.voiceInput.credentialConfigured,
          refinementEnabled: settings.voiceInput.refinementEnabled,
          ...(settings.voiceInput.refinerModel === undefined ? {} : { refinerModel: {
            backendId: settings.voiceInput.refinerModel.backendId, providerId: settings.voiceInput.refinerModel.providerId, modelId: settings.voiceInput.refinerModel.modelId
          } }),
          ...(settings.voiceInput.refinerFallbackModel === undefined ? {} : { refinerFallbackModel: {
            backendId: settings.voiceInput.refinerFallbackModel.backendId, providerId: settings.voiceInput.refinerFallbackModel.providerId, modelId: settings.voiceInput.refinerFallbackModel.modelId
          } }),
          fallbackEnabled: settings.voiceInput.fallbackEnabled,
          fallbackProtocol: voiceInputProtocolView(settings.voiceInput.fallbackProtocol),
          fallbackEndpoint: settings.voiceInput.fallbackEndpoint,
          fallbackModel: settings.voiceInput.fallbackModel,
          fallbackResourceId: settings.voiceInput.fallbackResourceId,
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
        ...(backend.entryCount === undefined ? {} : { entryCount: numberValue(backend.entryCount) }),
        kind: backendMemoryKind(backend.kind),
        resettable: backend.resettable,
        updatesActiveLocalSessions: backend.updatesActiveLocalSessions
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
    subagentModels: settings.subagentModels.map((setting) => {
      if (setting.backendId === "" || setting.revision === undefined) throw new Error("Orchestrator returned incomplete subagent model settings.");
      return {
        backendId: setting.backendId,
        ...(setting.model === undefined ? {} : { model: { providerId: setting.model.providerId, modelId: setting.model.modelId } }),
        defaultModelSupported: setting.defaultModelSupported,
        available: setting.available,
        unavailableReason: setting.unavailableReason,
        smartRoutingSupported: setting.smartRoutingSupported,
        smartRoutingEnabled: setting.smartRoutingEnabled,
        smartRoutingAvailable: setting.smartRoutingAvailable,
        smartRoutingUnavailableReason: setting.smartRoutingUnavailableReason,
        smartRoutingApplied: setting.smartRoutingApplied,
        smartRoutingRestartPending: setting.smartRoutingRestartPending,
        ...(setting.runtimeGeneration === undefined ? {} : { runtimeGeneration: setting.runtimeGeneration }),
        runtimeRevision: setting.runtimeRevision,
        revision: setting.revision.value
      };
    }),
    auxiliaryText: {
      models: settings.auxiliaryText.models.map(({ backendId, providerId, modelId }) => ({ backendId, providerId, modelId })),
      automaticModels: settings.auxiliaryText.automaticModels.map(({ backendId, providerId, modelId }) => ({ backendId, providerId, modelId })),
      options: settings.auxiliaryText.options.map((option) => {
        if (option.route === undefined) throw new Error("Orchestrator returned an incomplete auxiliary text route.");
        const { backendId, providerId, modelId } = option.route;
        return { route: { backendId, providerId, modelId }, available: option.available, unavailableReason: option.unavailableReason };
      }),
      available: settings.auxiliaryText.available,
      unavailableReason: settings.auxiliaryText.unavailableReason,
      revision: settings.auxiliaryText.revision.value,
      runtimeRevision: settings.auxiliaryText.runtimeRevision
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
    enabled: provider.enabled,
    revision: provider.version?.revision?.value ?? 0n,
    runtimes: provider.runtimes.map(mapProviderRuntimeConfiguration)
  };
}

function mapProviderRuntimeConfiguration(provider: ProviderRuntimeConfiguration): SettingsView["providers"][number]["runtimes"][number] {
  return {
    backendId: provider.backendId,
    compatibility: providerCompatibility(provider.apiCompatibility),
    endpoint: provider.endpoint,
    credentialId: provider.credentialReferenceId,
    keyless: provider.keyless,
    authHeader: provider.authHeader,
    environmentName: provider.apiKeyEnvironment,
    credentialOrigin: provider.credentialOrigin,
    ...(provider.requestPath === undefined ? {} : { requestPath: provider.requestPath }),
    ...(provider.modelsEndpoint === undefined ? {} : { modelsEndpoint: provider.modelsEndpoint }),
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
      ...(model.defaultVisible === undefined ? {} : { defaultVisible: model.defaultVisible }),
      ...(model.supportsTools === undefined ? {} : { supportsTools: model.supportsTools })
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
  const transport = server.transport === McpTransport.STDIO ? "stdio"
    : server.transport === McpTransport.HTTPS_STREAMABLE_HTTP ? "https"
    : server.transport === McpTransport.HTTP_SSE ? "sse"
    : server.transport === McpTransport.LOOPBACK_BRIDGE ? "loopback" : undefined;
  if (transport === undefined) throw new GatewayError("Orchestrator returned an unknown MCP transport.");
  const stdio = server.transportConfig.case === "stdio" ? server.transportConfig.value : undefined;
  const streamableHttp = server.transportConfig.case === "streamableHttp" ? server.transportConfig.value : undefined;
  const sse = server.transportConfig.case === "sse" ? server.transportConfig.value : undefined;
  if (transport === "stdio" && stdio === undefined) throw new GatewayError("Orchestrator returned an incomplete Stdio MCP configuration.");
  if (transport === "https" && streamableHttp === undefined) throw new GatewayError("Orchestrator returned an incomplete HTTP MCP configuration.");
  if (transport === "sse" && sse === undefined) throw new GatewayError("Orchestrator returned an incomplete SSE MCP configuration.");
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
    endpoint: transport === "https" ? streamableHttp!.endpoint : transport === "sse" ? sse!.endpoint : "",
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
      : host.authenticationMode === RemoteHostAuthenticationMode.NODE_KEY ? "nodeKey" as const
      : (() => { throw new GatewayError("Orchestrator returned an unknown Remote Host authentication mode."); })();
  if (
    ((authentication === "privateKey") !== (host.credentialReferenceId !== undefined)) ||
    (authentication === "privateKey" && (host.credentialReferenceId?.trim() ?? "") === "") ||
    ((authentication === "nodeKey") !== (host.nodeKey !== undefined)) ||
    (host.nodeKey !== undefined && (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(host.nodeKey.id) || !/^SHA256:[A-Za-z0-9+/]{43}$/u.test(host.nodeKey.expectedFingerprint)))
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
    ...(host.nodeKey === undefined ? {} : { nodeKey: { id: host.nodeKey.id, expectedFingerprint: host.nodeKey.expectedFingerprint } }),
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
    case RemoteHostFailureCode.NODE_KEY_CHANGED: return "nodeKeyChanged";
    case RemoteHostFailureCode.NODE_KEY_UNAVAILABLE: return "nodeKeyUnavailable";
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
  if (value === "nodeKey") return RemoteHostAuthenticationMode.NODE_KEY;
  return value === "privateKey"
    ? RemoteHostAuthenticationMode.PRIVATE_KEY
    : RemoteHostAuthenticationMode.SYSTEM_AGENT;
}

function mapSshKey(key: SshKey): SshKeyView {
  return { id: key.id, name: key.name, algorithm: key.algorithm, comment: key.comment, sha256Fingerprint: key.sha256Fingerprint,
    modifiedAt: timestampMs(key.modifiedAt), inAgent: key.inAgent };
}

function requireRemoteBackendRuntime(
  runtime: ProtoRemoteBackendRuntime | undefined,
  expectedTargetId: string,
  expectedHostId: string,
  expectedTargetRevision: bigint,
  expectedHostRevision: bigint
): RemoteBackendRuntimeView {
  if (runtime === undefined || runtime.observedAt === undefined || runtime.targetRevision === undefined || runtime.hostRevision === undefined
    || runtime.targetId !== expectedTargetId || runtime.hostId !== expectedHostId || runtime.displayName.trim() === ""
    || runtime.expectedVersion.trim() === "" || runtime.targetRevision.value !== expectedTargetRevision
    || runtime.hostRevision.value !== expectedHostRevision) {
    throw new GatewayError("Orchestrator returned an incomplete remote Backend runtime.");
  }
  const state = remoteBackendRuntimeState(runtime.state);
  const failure = runtime.failure === undefined ? undefined : {
    code: remoteBackendRuntimeFailureCode(runtime.failure.code),
    retryable: runtime.failure.retryable
  };
  if ((state === "failed" || state === "outcomeUnknown") && failure === undefined) {
    throw new GatewayError("Orchestrator returned an inconsistent remote Backend runtime failure.");
  }
  if ((state === "ready") !== (runtime.canReinstall && runtime.canUninstall)
    || ((state === "probing" || state === "installing") && (runtime.canInstall || runtime.canReinstall || runtime.canUninstall))) {
    throw new GatewayError("Orchestrator returned inconsistent remote Backend runtime actions.");
  }
  return {
    targetId: runtime.targetId,
    hostId: runtime.hostId,
    displayName: runtime.displayName,
    expectedVersion: runtime.expectedVersion,
    ...(runtime.installedVersion === undefined ? {} : { installedVersion: runtime.installedVersion }),
    state,
    canInstall: runtime.canInstall,
    canReinstall: runtime.canReinstall,
    canUninstall: runtime.canUninstall,
    ...(failure === undefined ? {} : { failure }),
    observedAt: timestampMs(runtime.observedAt),
    targetRevision: runtime.targetRevision.value,
    hostRevision: runtime.hostRevision.value
  };
}

function remoteBackendRuntimeState(value: RemoteBackendRuntimeState): RemoteBackendRuntimeView["state"] {
  switch (value) {
    case RemoteBackendRuntimeState.PROBING: return "probing";
    case RemoteBackendRuntimeState.NOT_INSTALLED: return "notInstalled";
    case RemoteBackendRuntimeState.INSTALLING: return "installing";
    case RemoteBackendRuntimeState.READY: return "ready";
    case RemoteBackendRuntimeState.FAILED: return "failed";
    case RemoteBackendRuntimeState.OUTCOME_UNKNOWN: return "outcomeUnknown";
    default: throw new GatewayError("Orchestrator returned an unknown remote Backend runtime state.");
  }
}

function remoteBackendRuntimeInstallPhase(value: RemoteBackendRuntimeInstallPhase): RemoteBackendRuntimeInstallEventView["phase"] {
  switch (value) {
    case RemoteBackendRuntimeInstallPhase.PROBING: return "probing";
    case RemoteBackendRuntimeInstallPhase.DOWNLOADING: return "downloading";
    case RemoteBackendRuntimeInstallPhase.INSTALLING: return "installing";
    case RemoteBackendRuntimeInstallPhase.VALIDATING: return "validating";
    case RemoteBackendRuntimeInstallPhase.COMPLETE: return "complete";
    case RemoteBackendRuntimeInstallPhase.FAILED: return "failed";
    case RemoteBackendRuntimeInstallPhase.OUTCOME_UNKNOWN: return "outcomeUnknown";
    default: throw new GatewayError("Orchestrator returned an unknown remote Backend runtime phase.");
  }
}

function remoteBackendRuntimeFailureCode(value: RemoteBackendRuntimeFailureCode): RemoteBackendRuntimeFailureCodeView {
  switch (value) {
    case RemoteBackendRuntimeFailureCode.ABORTED: return "aborted";
    case RemoteBackendRuntimeFailureCode.AUTHORITY_CHANGED: return "authorityChanged";
    case RemoteBackendRuntimeFailureCode.HOST_NOT_READY: return "hostNotReady";
    case RemoteBackendRuntimeFailureCode.NOT_SUPPORTED: return "notSupported";
    case RemoteBackendRuntimeFailureCode.PROBE_FAILED: return "probeFailed";
    case RemoteBackendRuntimeFailureCode.INSTALL_FAILED: return "installFailed";
    case RemoteBackendRuntimeFailureCode.UNINSTALL_FAILED: return "uninstallFailed";
    case RemoteBackendRuntimeFailureCode.BUSY: return "busy";
    default: throw new GatewayError("Orchestrator returned an unknown remote Backend runtime failure code.");
  }
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

function isRevisionDriftError(error: unknown): boolean {
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
  const blob = artifact.blob;
  if (blob === undefined || blob.blobId === "") throw new GatewayError("Orchestrator returned an Artifact without its Blob identity.");
  return {
    id: artifact.artifactId,
    blobId: blob.blobId,
    ...(artifact.sessionId === "" ? {} : { sourceSessionId: artifact.sessionId }),
    sourceRevealAvailable: artifact.sourceRevealAvailable,
    title: artifact.title,
    ...(artifact.audioMetadata === undefined ? {} : { audioMetadata: mapAudioMetadata(artifact.audioMetadata) }),
    ...(artifact.description === "" ? {} : { description: artifact.description }),
    kind: artifactKind(artifact.kind),
    fileName: blob.fileName || "artifact",
    mediaType: blob.mediaType || "application/octet-stream",
    byteSize: numberValue(blob.byteSize)
  };
}

function mapSessionArtifactCatalogItem(
  artifact: Artifact,
  expectedSessionId: string,
  seenArtifactIds: Set<string>
): ArtifactView | undefined {
  if (artifact.sessionId !== expectedSessionId) {
    throw new GatewayError("Orchestrator returned an invalid Artifact catalog identity.");
  }
  return mapArtifactCatalogItem(artifact, artifact.artifactId, seenArtifactIds);
}

function mapArtifactReferenceCatalogItem(
  artifact: Artifact,
  seenArtifactIdentities: Set<string>
): ArtifactReferenceCatalogItemView | undefined {
  if (!validSessionMentionId(artifact.sessionId)) {
    throw new GatewayError("Orchestrator returned an invalid Artifact reference catalog source task.");
  }
  const mapped = mapArtifactCatalogItem(
    artifact,
    `${artifact.sessionId}\u0000${artifact.artifactId}`,
    seenArtifactIdentities
  );
  return mapped === undefined ? undefined : { ...mapped, sourceSessionId: artifact.sessionId };
}

function mapArtifactCatalogItem(
  artifact: Artifact,
  identity: string,
  seenArtifactIdentities: Set<string>
): ArtifactView | undefined {
  const blob = artifact.blob;
  const byteSize = blob === undefined ? undefined : exactSafeUnsignedNumber(blob.byteSize);
  const createdAt = artifact.createdAt === undefined ? undefined : timestampMs(artifact.createdAt);
  const expiresAt = artifact.expiresAt === undefined ? undefined : timestampMs(artifact.expiresAt);
  if (
    !validResourceIdentityText(artifact.artifactId)
    || seenArtifactIdentities.has(identity)
    || blob === undefined
    || !validResourceIdentityText(blob.blobId)
    || !/^[a-f0-9]{64}$/u.test(blob.sha256Hex)
    || byteSize === undefined
    || blob.mediaType.trim() === ""
    || createdAt === undefined
    || !Number.isSafeInteger(createdAt)
    || createdAt < 0
    || expiresAt !== undefined && (!Number.isSafeInteger(expiresAt) || expiresAt < 0)
    || !artifactCatalogKind(artifact.kind)
  ) throw new GatewayError("Orchestrator returned an invalid Artifact catalog identity.");
  seenArtifactIdentities.add(identity);
  if (expiresAt !== undefined && expiresAt <= Date.now()) return undefined;
  const mapped = mapArtifact(artifact);
  if ((mapped.title || mapped.fileName).trim() === "") {
    throw new GatewayError("Orchestrator returned an Artifact catalog item without a display name.");
  }
  return mapped;
}

function artifactCatalogKind(value: ArtifactKind): boolean {
  return value === ArtifactKind.FILE
    || value === ArtifactKind.IMAGE
    || value === ArtifactKind.EXPORT
    || value === ArtifactKind.TOOL_RESULT
    || value === ArtifactKind.DIAGNOSTICS
    || value === ArtifactKind.DIFF;
}

function mapAudioMetadata(audio: AudioArtifactMetadata): NonNullable<ArtifactView["audioMetadata"]> {
  const kind = audio.kind === AudioArtifactKind.GENERIC ? "generic" : audio.kind === AudioArtifactKind.MUSIC ? "music" : audio.kind === AudioArtifactKind.SOUND_EFFECT ? "sound_effect" : undefined;
  if (kind === undefined) throw new Error("Audio Artifact kind is invalid.");
  return { kind, title: audio.title, description: audio.description,
    ...(audio.durationSeconds === undefined ? {} : { durationSeconds: audio.durationSeconds }),
    ...(audio.artwork?.blob === undefined ? {} : { artwork: { blobId: audio.artwork.blob.blobId, width: audio.artwork.widthPixels, height: audio.artwork.heightPixels, alt: audio.artwork.altText } }) };
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
  resolution: InteractionResolutionDraft
): Promise<NonNullable<MessageInitShape<typeof InteractionResolutionSchema>["decision"]>> {
  if (raw.request.case === "permission") {
    if (resolution.kind !== "permission") throw new GatewayError("This permission response is no longer valid.");
    const decision = advertisedInteractionDecision(
      resolution.decisionId,
      CURRENT_PERMISSION_DECISIONS,
      raw.request.value.allowedDecisions,
      "permission"
    );
    return { case: "permission", value: { decision } };
  }
  if (raw.request.case === "planReview") {
    if (resolution.kind !== "plan") throw new GatewayError("This plan response is no longer valid.");
    if (typeof resolution.feedback !== "string") throw new GatewayError("Plan review feedback must be text.");
    const decision = advertisedInteractionDecision(
      resolution.decisionId,
      CURRENT_PLAN_REVIEW_DECISIONS,
      raw.request.value.allowedDecisions,
      "plan review"
    );
    return { case: "planReview", value: { decision, feedback: resolution.feedback } };
  }
  if (raw.request.case === "extensionUi") {
    if (resolution.kind !== "extension") throw new GatewayError("This extension response is no longer valid.");
    const request = raw.request.value.request;
    if (request.case === "confirm") {
      if (typeof resolution.value !== "boolean") throw new GatewayError("This extension confirmation requires a yes or no response.");
      return { case: "extensionUi", value: { result: { case: "confirmed", value: resolution.value } } };
    }
    if (request.case === "select") {
      if (typeof resolution.value !== "string" || !request.value.options.includes(resolution.value)) {
        throw new GatewayError("This extension selection is not one of the currently advertised options.");
      }
      return { case: "extensionUi", value: { result: { case: "value", value: resolution.value } } };
    }
    if (request.case === "input" || request.case === "editor") {
      if (typeof resolution.value !== "string") throw new GatewayError("This extension input requires text.");
      return { case: "extensionUi", value: { result: { case: "value", value: resolution.value } } };
    }
    throw new GatewayError("This extension request has no current response type.");
  }
  if (raw.request.case === "question") {
    if (resolution.kind !== "question") throw new GatewayError("These question answers are no longer valid.");
    return { case: "question", value: { answers: exactQuestionAnswers(raw.request.value.fields, resolution.answers) } };
  }
  throw new GatewayError("This interaction has no current response type.");
}

const CURRENT_PERMISSION_DECISIONS: ReadonlySet<number> = new Set([
  PermissionDecisionKind.ALLOW_ONCE,
  PermissionDecisionKind.ALLOW_FOR_TURN,
  PermissionDecisionKind.ALLOW_FOR_SESSION,
  PermissionDecisionKind.DENY_ONCE,
  PermissionDecisionKind.DENY_FOR_SESSION,
  PermissionDecisionKind.ABORT_RUN
]);

const CURRENT_PLAN_REVIEW_DECISIONS: ReadonlySet<number> = new Set([
  PlanReviewDecisionKind.EXECUTE,
  PlanReviewDecisionKind.STAY_IN_PLAN_MODE,
  PlanReviewDecisionKind.REFINE
]);

function advertisedInteractionDecision(
  decisionId: string,
  current: ReadonlySet<number>,
  advertised: readonly number[],
  label: string
): number {
  if (typeof decisionId !== "string" || !/^[1-9][0-9]*$/u.test(decisionId)) {
    throw new GatewayError(`This ${label} response is not a current decision.`);
  }
  const decision = Number(decisionId);
  if (!Number.isSafeInteger(decision) || String(decision) !== decisionId
    || !current.has(decision) || !advertised.includes(decision)) {
    throw new GatewayError(`This ${label} response is not one of the currently advertised decisions.`);
  }
  return decision;
}

function exactQuestionAnswers(
  rawFields: readonly QuestionField[],
  draft: Readonly<Record<string, QuestionAnswerDraft>>
): Array<MessageInitShape<typeof QuestionAnswerSchema>> {
  if (!questionAnswerRecord(draft)) throw new GatewayError("Question answers must be a typed field map.");
  validateQuestionRequestDeclaration(rawFields);
  const fields = new Map<string, QuestionField>();
  for (const field of rawFields) {
    fields.set(field.fieldId, field);
  }

  const submitted = new Map<string, unknown>();
  for (const property of Reflect.ownKeys(draft)) {
    if (typeof property !== "string") throw new GatewayError("Question answers contain an undeclared field.");
    const field = fields.get(property);
    if (field === undefined) throw new GatewayError("Question answers contain an undeclared field.");
    submitted.set(property, draft[property]);
  }

  const answers: Array<MessageInitShape<typeof QuestionAnswerSchema>> = [];
  for (const field of rawFields) {
    const answer = submitted.get(field.fieldId);
    if (answer === undefined) {
      if (field.required) throw new GatewayError(`${field.label || field.fieldId} is required.`);
      continue;
    }
    answers.push({ fieldId: field.fieldId, value: exactQuestionAnswer(field, answer) });
  }
  return answers;
}

function questionAnswerRecord(value: unknown): value is Readonly<Record<string, QuestionAnswerDraft>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateQuestionRequestDeclaration(rawFields: readonly QuestionField[]): void {
  if (rawFields.length === 0) throw new GatewayError("This question has no current fields.");
  const fieldIds = new Set<string>();
  for (const field of rawFields) {
    if (typeof field.fieldId !== "string" || field.fieldId.trim() === "" || fieldIds.has(field.fieldId)) {
      throw new GatewayError("This question has an invalid field declaration.");
    }
    fieldIds.add(field.fieldId);
    validateQuestionFieldDeclaration(field);
  }
}

function validateQuestionFieldDeclaration(field: QuestionField): void {
  const input = field.input;
  if (input.case === "text" || input.case === "boolean") return;
  if (input.case === "singleChoice") {
    const choices = declaredQuestionChoiceIds(input.value.choices);
    if (typeof input.value.allowOther !== "boolean") {
      throw new GatewayError("Question choice fields require explicit free-text authority.");
    }
    if (input.value.defaultChoiceId !== "" && !choices.has(input.value.defaultChoiceId)) {
      throw new GatewayError("This question has an invalid default choice.");
    }
    return;
  }
  if (input.case === "multipleChoice") {
    const choices = declaredQuestionChoiceIds(input.value.choices);
    const defaults = input.value.defaultChoiceIds;
    const minimum = Math.max(field.required ? 1 : 0, input.value.minimumSelections);
    const maximum = input.value.maximumSelections === 0 ? undefined : input.value.maximumSelections;
    if (typeof input.value.allowOther !== "boolean") {
      throw new GatewayError("Question choice fields require explicit free-text authority.");
    }
    const capacity = choices.size + (input.value.allowOther ? 1 : 0);
    if (!Number.isSafeInteger(input.value.minimumSelections) || input.value.minimumSelections < 0
      || minimum > capacity
      || maximum !== undefined && (!Number.isSafeInteger(maximum) || maximum < minimum || maximum > capacity)
      || new Set(defaults).size !== defaults.length
      || defaults.some((choiceId) => !choices.has(choiceId))
      || maximum !== undefined && defaults.length > maximum) {
      throw new GatewayError("This question has invalid multiple-choice bounds or defaults.");
    }
    return;
  }
  throw new GatewayError("This question has a field without a current input type.");
}

function exactQuestionAnswer(
  field: QuestionField,
  answer: unknown
): NonNullable<MessageInitShape<typeof QuestionAnswerSchema>["value"]> {
  const label = field.label || field.fieldId;
  if (typeof answer !== "object" || answer === null || Array.isArray(answer)) {
    throw new GatewayError(`${label} requires a current typed answer.`);
  }
  const typed = answer as Readonly<Record<string, unknown>>;
  if (field.input.case === "text") {
    if (!exactQuestionDraftKeys(typed, ["kind", "value"])
      || typed["kind"] !== "text" || typeof typed["value"] !== "string") {
      throw new GatewayError(`${label} requires text.`);
    }
    if (field.required && typed["value"].trim() === "") throw new GatewayError(`${label} is required.`);
    return { case: "text", value: typed["value"] };
  }
  if (field.input.case === "boolean") {
    if (!exactQuestionDraftKeys(typed, ["kind", "value"])
      || typed["kind"] !== "boolean" || typeof typed["value"] !== "boolean") {
      throw new GatewayError(`${label} requires a yes or no answer.`);
    }
    return { case: "boolean", value: typed["value"] };
  }
  if (field.input.case === "singleChoice") {
    if (!exactQuestionDraftKeys(typed, ["kind", "selection"]) || typed["kind"] !== "single"
      || typeof typed["selection"] !== "object" || typed["selection"] === null || Array.isArray(typed["selection"])) {
      throw new GatewayError(`${label} requires one currently advertised choice.`);
    }
    const selection = typed["selection"] as Readonly<Record<string, unknown>>;
    const choices = declaredQuestionChoiceIds(field.input.value.choices);
    if (exactQuestionDraftKeys(selection, ["kind", "choiceId"])
      && selection["kind"] === "choice" && typeof selection["choiceId"] === "string"
      && choices.has(selection["choiceId"])) {
      return { case: "singleChoice", value: { selection: { case: "choiceId", value: selection["choiceId"] } } };
    }
    if (!exactQuestionDraftKeys(selection, ["kind", "text"])
      || selection["kind"] !== "other" || typeof selection["text"] !== "string"
      || !field.input.value.allowOther || selection["text"].trim() === "") {
      throw new GatewayError(`${label} requires one currently advertised choice or allowed free-text response.`);
    }
    return { case: "singleChoice", value: { selection: { case: "otherText", value: selection["text"] } } };
  }
  if (field.input.case === "multipleChoice") {
    if (!exactQuestionDraftKeys(typed, ["kind", "choiceIds"], ["otherText"])
      || typed["kind"] !== "multiple" || !Array.isArray(typed["choiceIds"])
      || typed["choiceIds"].some((value) => typeof value !== "string")
      || (typed["otherText"] !== undefined && typeof typed["otherText"] !== "string")) {
      throw new GatewayError(`${label} requires a list of choices.`);
    }
    const choiceIds = typed["choiceIds"] as readonly string[];
    const otherText = typed["otherText"] as string | undefined;
    const choices = declaredQuestionChoiceIds(field.input.value.choices);
    const minimum = Math.max(field.required ? 1 : 0, field.input.value.minimumSelections);
    const maximum = field.input.value.maximumSelections === 0 ? undefined : field.input.value.maximumSelections;
    const count = choiceIds.length + (otherText === undefined ? 0 : 1);
    if (new Set(choiceIds).size !== choiceIds.length || choiceIds.some((value) => !choices.has(value))
      || (otherText !== undefined && (!field.input.value.allowOther || otherText.trim() === ""))
      || count < minimum || maximum !== undefined && count > maximum) {
      throw new GatewayError(`${label} does not satisfy its advertised choices and selection bounds.`);
    }
    return {
      case: "multipleChoice",
      value: {
        choiceIds: [...choiceIds],
        ...(otherText === undefined ? {} : { otherText })
      }
    };
  }
  throw new GatewayError(`${label} has no current answer type.`);
}

function exactQuestionDraftKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const keys = Reflect.ownKeys(value);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && keys.every((key) => typeof key === "string" && (required.includes(key) || optional.includes(key)));
}

function declaredQuestionChoiceIds(choices: readonly QuestionChoice[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const choice of choices) {
    if (typeof choice.choiceId !== "string" || choice.choiceId.trim() === "" || ids.has(choice.choiceId)) {
      throw new GatewayError("This question has an invalid choice declaration.");
    }
    ids.add(choice.choiceId);
  }
  if (ids.size === 0) throw new GatewayError("This question has no selectable choices.");
  return ids;
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
    if (content?.case === "artifactMention") return `@${content.value.displayText}`;
    if (content?.case === "sessionMention") return `@${content.value.displayText}`;
    return "";
  }).filter(Boolean).join("\n");
}

function messageInputText(input: any): string {
  return (input?.parts ?? []).filter((part: any) => part.content?.case === "text").map((part: any) => String(part.content.value)).join("");
}

function requiredQueueInput(item: QueueItem): InputContent {
  const input = item.input;
  if (input === undefined || input.parts.length === 0 || input.parts.some((part) => part.content.case === undefined)) {
    throw new GatewayError("Orchestrator returned a queued input without its canonical content.");
  }
  return input;
}

function editedQueueInput(original: InputContent, edit: QueueItemTextEditView): InputContent {
  const originalMentionParts = original.parts.filter((part) => typedInputMention(part.content.case));
  const pastedTextRanges = messageInputPastedTextRanges({ pastedTextRanges: edit.pastedTextRanges }, edit.text);
  const mentionRanges = messageInputMentionRanges(
    { mentionRanges: edit.mentionRanges },
    edit.text,
    originalMentionParts.length,
    pastedTextRanges
  );
  const originallyInline = new Set(original.mentionRanges.map((range) => range.mentionIndex));
  if (mentionRanges.some((range) => !originallyInline.has(range.mentionIndex))) {
    throw new GatewayError("A queued-input edit cannot create new reference authority from display text.");
  }
  const stillInline = new Set(mentionRanges.map((range) => range.mentionIndex));
  const retainedParts: InputContent["parts"] = [];
  const retainedMentionIndices = new Map<number, number>();
  let originalMentionIndex = 0;
  for (const part of original.parts) {
    if (part.content.case === "text") continue;
    if (!typedInputMention(part.content.case)) {
      retainedParts.push(part);
      continue;
    }
    if (!originallyInline.has(originalMentionIndex) || stillInline.has(originalMentionIndex)) {
      retainedMentionIndices.set(originalMentionIndex, retainedMentionIndices.size);
      retainedParts.push(part);
    }
    originalMentionIndex += 1;
  }
  const parts: InputContent["parts"] = [
    ...(edit.text.length === 0 ? [] : [create(InputPartSchema, { content: { case: "text", value: edit.text } })]),
    ...retainedParts
  ];
  if (parts.length === 0 || edit.text.trim().length === 0 && retainedParts.length === 0) {
    throw new GatewayError("Queued input cannot be empty.");
  }
  return create(InputContentSchema, {
    parts,
    quotesEncoded: false,
    pastedTextRanges: pastedTextRanges.map((range) => create(InlineTextRangeSchema, range)),
    mentionRanges: mentionRanges.map((range) => create(InputMentionRangeSchema, {
      start: range.start,
      end: range.end,
      mentionIndex: retainedMentionIndices.get(range.mentionIndex)!
    }))
  });
}

function typedInputMention(value: string | undefined): boolean {
  return value === "workspaceMention" || value === "resourceMention" || value === "artifactMention" || value === "sessionMention";
}

function messageInputMentions(input: any): NonNullable<TimelineItemView["inputMentions"]> {
  return (input?.parts ?? []).flatMap((part: any): NonNullable<TimelineItemView["inputMentions"]>[number][] => {
    const content = part.content;
    const value = content?.value;
    if (content?.case === "workspaceMention") {
      if (!value.workspaceId || !value.relativePath) throw new GatewayError("Orchestrator returned a workspace mention without its identity.");
      return [{ kind: "workspace", workspaceId: value.workspaceId, relativePath: value.relativePath, displayText: value.displayText, directory: value.directory,
        ...(value.lineRange === undefined ? {} : { lineRange: { startLine: value.lineRange.startLine, endLine: value.lineRange.endLine } }) }];
    }
    if (content?.case === "resourceMention") {
      const runtimeGeneration = exactSafeUnsignedNumber(value.runtimeGeneration);
      if (!value.resourceId || !value.discoveredRevision || value.resourceVersion < 1n || runtimeGeneration === undefined || runtimeGeneration < 1) {
        throw new GatewayError("Orchestrator returned a resource mention without its exact runtime identity.");
      }
      return [{
        kind: "resource",
        resourceId: value.resourceId,
        displayText: value.displayText,
        discoveredRevision: value.discoveredRevision,
        resourceVersion: value.resourceVersion.toString(10),
        runtimeGeneration
      }];
    }
    if (content?.case === "artifactMention") {
      if (!validSessionMentionId(value.sourceSessionId) || !validResourceIdentityText(value.artifactId)) {
        throw new GatewayError("Orchestrator returned an Artifact mention without its original task and object identity.");
      }
      return [{ kind: "artifact", sourceSessionId: value.sourceSessionId, artifactId: value.artifactId, displayText: value.displayText }];
    }
    if (content?.case === "sessionMention") {
      if (!validSessionMentionId(value.sessionId)) throw new GatewayError("Orchestrator returned a task mention without its identity.");
      return [{ kind: "session", sessionId: value.sessionId, displayText: value.displayText }];
    }
    return [];
  });
}

function messageInputAttachments(input: any): NonNullable<QueueItemView["attachments"]> {
  return (input?.parts ?? []).flatMap((part: any): NonNullable<QueueItemView["attachments"]>[number][] => {
    const content = part.content;
    if (content?.case === "image") {
      return [{ kind: "image", label: content.value.altText || content.value.blob?.fileName || "" }];
    }
    if (content?.case === "file") return [{ kind: "file", label: content.value.fileName || "" }];
    return [];
  });
}

function messageInputMentionRanges(input: any, text: string, mentionCount: number, pastedRanges: NonNullable<TimelineItemView["pastedTextRanges"]>): NonNullable<TimelineItemView["mentionRanges"]> {
  const ranges = input?.mentionRanges ?? [];
  if (!Array.isArray(ranges)) throw new GatewayError("Orchestrator returned invalid mention occurrence metadata.");
  let previousEnd = 0;
  return ranges.map((range) => {
    const { start, end, mentionIndex } = range;
    if (![start, end, mentionIndex].every(Number.isSafeInteger) || start < previousEnd || start < 0 || end <= start || end > text.length
      || mentionIndex < 0 || mentionIndex >= mentionCount || !utf16Boundary(text, start) || !utf16Boundary(text, end)
      || pastedRanges.some((pasted) => start < pasted.end && pasted.start < end)) throw new GatewayError("Orchestrator returned invalid mention occurrence metadata.");
    previousEnd = end;
    return { start, end, mentionIndex };
  });
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
      sourceRevealAvailable: false,
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
  if (options?.kind?.case === "runtime") return [...(options.kind.value.resourceKinds ?? [])];
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
        sourceRevealAvailable: false,
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
        sourceRevealAvailable: false,
        title: artifact.audioMetadata?.title.trim() || artifact.title || blob.fileName || "Artifact",
        ...(artifact.audioMetadata === undefined ? {} : { audioMetadata: mapAudioMetadata(artifact.audioMetadata) }),
        kind: artifactKind(artifact.kind),
        fileName: blob.fileName || "artifact",
        mediaType: blob.mediaType || "application/octet-stream",
        byteSize: numberValue(blob.byteSize)
      });
    }
  }
  return attachments;
}

function requiredPartnerRevision(value: { readonly value: bigint } | undefined, label: string): bigint {
  if (value === undefined || value.value < 1n) throw new GatewayError(`Orchestrator returned an invalid ${label} revision.`);
  return value.value;
}

function protoPartnerLifecycle(value: PartnerLifecycleView): PartnerLifecycle {
  if (value === "active") return PartnerLifecycle.ACTIVE;
  if (value === "archived") return PartnerLifecycle.ARCHIVED;
  return PartnerLifecycle.DELETED;
}

function partnerLifecycle(value: PartnerLifecycle): PartnerLifecycleView {
  if (value === PartnerLifecycle.ACTIVE) return "active";
  if (value === PartnerLifecycle.ARCHIVED) return "archived";
  if (value === PartnerLifecycle.DELETED) return "deleted";
  throw new GatewayError("Orchestrator returned an unknown Partner lifecycle.");
}

function partnerInitializationState(value: PartnerInitializationState): PartnerInitializationStateView {
  if (value === PartnerInitializationState.PENDING) return "pending";
  if (value === PartnerInitializationState.READY) return "ready";
  if (value === PartnerInitializationState.ERROR) return "error";
  throw new GatewayError("Orchestrator returned an unknown Partner initialization state.");
}

function partnerInvitationStage(value: PartnerInvitationStage): PartnerInvitationStageView {
  if (value === PartnerInvitationStage.HOME) return "home";
  if (value === PartnerInvitationStage.AVATAR) return "avatar";
  if (value === PartnerInvitationStage.SESSION) return "session";
  if (value === PartnerInvitationStage.READY) return "ready";
  if (value === PartnerInvitationStage.FAILED) return "failed";
  throw new GatewayError("Orchestrator returned an unknown Partner invitation stage.");
}

function partnerInitializationError(value: PartnerInitializationErrorCode): PartnerInitializationErrorCodeView {
  if (value === PartnerInitializationErrorCode.HOME_UNAVAILABLE) return "homeUnavailable";
  if (value === PartnerInitializationErrorCode.AVATAR_UNAVAILABLE) return "avatarUnavailable";
  if (value === PartnerInitializationErrorCode.MODEL_UNAVAILABLE) return "modelUnavailable";
  if (value === PartnerInitializationErrorCode.SESSION_UNAVAILABLE) return "sessionUnavailable";
  if (value === PartnerInitializationErrorCode.STATE_CHANGED) return "stateChanged";
  throw new GatewayError("Orchestrator returned an unknown Partner initialization error.");
}

function protoPartnerRoute(value: PartnerModelRouteView) {
  return {
    backendId: value.backendId,
    providerId: value.providerId,
    modelId: value.modelId,
    ...(value.effort === undefined ? {} : { effort: value.effort }),
    fastMode: value.fastMode
  };
}

function protoPartnerCapabilities(value: PartnerCapabilitiesView) {
  return {
    modelChain: value.modelChain.map(protoPartnerRoute),
    permissionMode: protoPermission(value.permissionMode),
    planMode: value.planMode
  };
}

function protoPartnerPatch(value: PartnerPatchView) {
  return {
    ...(value.displayName === undefined ? {} : { displayName: value.displayName }),
    ...(value.avatar === undefined ? {} : { avatar: value.avatar }),
    ...(value.identitySource === undefined ? {} : { identitySource: value.identitySource }),
    ...(value.modelChain === undefined ? {} : { modelChain: { routes: value.modelChain.map(protoPartnerRoute) } }),
    ...(value.permissionMode === undefined ? {} : { permissionMode: protoPermission(value.permissionMode) }),
    ...(value.planMode === undefined ? {} : { planMode: value.planMode }),
    ...(value.usesDirectoryDefaults === undefined ? {} : { usesDirectoryDefaults: value.usesDirectoryDefaults })
  };
}

function mapPartnerCapabilities(value: ProtoPartnerCapabilities | undefined): PartnerCapabilitiesView {
  if (value === undefined || value.modelChain.length < 1 || value.modelChain.length > 3) {
    throw new GatewayError("Orchestrator returned an invalid Partner model chain.");
  }
  const routes = value.modelChain.map((route): PartnerModelRouteView => {
    if (route.backendId.trim() === "" || route.providerId.trim() === "" || route.modelId.trim() === ""
      || (route.effort !== undefined && route.effort.trim() === "")) {
      throw new GatewayError("Orchestrator returned an incomplete Partner model route.");
    }
    return {
      backendId: route.backendId,
      providerId: route.providerId,
      modelId: route.modelId,
      ...(route.effort === undefined ? {} : { effort: route.effort }),
      fastMode: route.fastMode
    };
  });
  const backendId = routes[0]!.backendId;
  const identities = new Set(routes.map((route) => `${route.providerId}\u0000${route.modelId}`));
  if (routes.some((route) => route.backendId !== backendId) || identities.size !== routes.length) {
    throw new GatewayError("Orchestrator returned an inconsistent Partner model chain.");
  }
  const permissionMode = value.permissionMode === ProtoPermissionMode.ASK ? "ask" as const
    : value.permissionMode === ProtoPermissionMode.AUTO ? "auto" as const : undefined;
  if (permissionMode === undefined) throw new GatewayError("Orchestrator returned an unsupported Partner permission mode.");
  return { modelChain: routes, permissionMode, planMode: value.planMode };
}

function mapPartnerProfile(value: ProtoPartnerProfile | undefined): PartnerProfileView {
  if (value === undefined || value.partnerId.trim() === "" || value.displayName.trim() === ""
    || value.avatar.trim() === "" || value.identitySource.trim() === "" || value.templateId.trim() === ""
    || value.homeTargetId.trim() === "" || value.profileVersion < 1n
    || (value.canonicalSessionId !== undefined && value.canonicalSessionId.trim() === "")) {
    throw new GatewayError("Orchestrator returned an incomplete Partner profile.");
  }
  const lifecycle = partnerLifecycle(value.lifecycle);
  const initializationState = partnerInitializationState(value.initializationState);
  const invitationStage = partnerInvitationStage(value.invitationStage);
  const initializationErrorCode = value.initializationErrorCode === undefined
    ? undefined : partnerInitializationError(value.initializationErrorCode);
  if ((initializationState === "error") !== (initializationErrorCode !== undefined)
    || (initializationState === "error") !== (invitationStage === "failed")
    || (initializationState === "ready") !== (invitationStage === "ready")
    || (initializationState === "ready" && value.canonicalSessionId === undefined)) {
    throw new GatewayError("Orchestrator returned an inconsistent Partner initialization state.");
  }
  const activity = mapPartnerActivity(value.activity);
  if (activity.partnerId !== value.partnerId) {
    throw new GatewayError("Orchestrator returned Partner activity owned by another profile.");
  }
  return {
    id: value.partnerId,
    revision: requiredPartnerRevision(value.revision, "Partner"),
    profileVersion: value.profileVersion,
    displayName: value.displayName,
    avatar: value.avatar,
    identitySource: value.identitySource,
    templateId: value.templateId,
    lifecycle,
    initializationState,
    invitationStage,
    ...(initializationErrorCode === undefined ? {} : { initializationErrorCode }),
    homeTargetId: value.homeTargetId,
    ...(value.canonicalSessionId === undefined ? {} : { canonicalSessionId: value.canonicalSessionId }),
    capabilities: mapPartnerCapabilities(value.capabilities),
    usesDirectoryDefaults: value.usesDirectoryDefaults,
    createdAt: requiredContactTimestamp(value.createdAt, "Partner creation"),
    updatedAt: requiredContactTimestamp(value.updatedAt, "Partner update"),
    activity
  };
}

function mapPartnerActivity(value: ProtoPartnerActivity | undefined): PartnerActivityView {
  if (value === undefined || value.partnerId.trim() === "") {
    throw new GatewayError("Orchestrator returned an incomplete Partner activity summary.");
  }
  if ((value.latestReplyCursor === undefined) !== (value.latestReplyAt === undefined)) {
    throw new GatewayError("Orchestrator returned an inconsistent Partner latest reply.");
  }
  return {
    partnerId: value.partnerId,
    unreadReplyCount: safePartnerCount(value.unreadReplyCount, "Partner unread reply count"),
    ...(value.latestReplyCursor === undefined
      ? {}
      : { latestReplyCursor: partnerCursor(value.latestReplyCursor, "Partner latest reply cursor") }),
    ...(value.latestReplyAt === undefined
      ? {}
      : { latestReplyAt: requiredContactTimestamp(value.latestReplyAt, "Partner latest reply") }),
    artifactCount: safePartnerCount(value.artifactCount, "Partner Artifact count"),
    activeDelegationCount: safePartnerCount(value.activeDelegationCount, "Partner active delegation count"),
    readThroughCursor: partnerCursor(value.readThroughCursor, "Partner read cursor"),
    readUpdatedAt: requiredContactTimestamp(value.readUpdatedAt, "Partner read update")
  };
}

function mapPartnerSession(value: ProtoPartnerSession): PartnerSessionView {
  if (value.sessionId.trim() === "" || value.partnerId.trim() === "" || value.displayName.trim() === ""
    || value.profileVersion < 1n || value.parentSessionId?.trim() === "" || value.delegationId?.trim() === "") {
    throw new GatewayError("Orchestrator returned an incomplete Partner task link.");
  }
  const role: PartnerSessionRoleView = value.role === PartnerSessionRole.CANONICAL ? "canonical"
    : value.role === PartnerSessionRole.HISTORY ? "history"
      : value.role === PartnerSessionRole.DELEGATION ? "delegation"
        : (() => { throw new GatewayError("Orchestrator returned an unknown Partner task role."); })();
  if ((role === "delegation") !== (value.parentSessionId !== undefined)
    || (role === "delegation") !== (value.delegationId !== undefined)
    || (role !== "canonical" && !value.readOnly)) {
    throw new GatewayError("Orchestrator returned an inconsistent Partner task link.");
  }
  return {
    sessionId: value.sessionId,
    partnerId: value.partnerId,
    role,
    profileVersion: value.profileVersion,
    ...(value.parentSessionId === undefined ? {} : { parentSessionId: value.parentSessionId }),
    ...(value.delegationId === undefined ? {} : { delegationId: value.delegationId }),
    displayName: value.displayName,
    available: value.available,
    readOnly: value.readOnly,
    archived: value.archived,
    deleted: value.deleted,
    createdAt: requiredContactTimestamp(value.createdAt, "Partner task creation"),
    ...(value.lastActivityAt === undefined
      ? {}
      : { lastActivityAt: requiredContactTimestamp(value.lastActivityAt, "Partner task activity") })
  };
}

function mapPartnerPrivateThread(value: ProtoPartnerPrivateThread | undefined): PartnerPrivateThreadView {
  if (value === undefined || value.threadId.trim() === "" || value.firstPartnerId.trim() === ""
    || value.secondPartnerId.trim() === "" || value.firstPartnerId === value.secondPartnerId
    || value.messageCount > value.maxMessages || value.maxMessages < 1) {
    throw new GatewayError("Orchestrator returned an invalid Partner private thread.");
  }
  const status: PartnerPrivateThreadStatusView = value.status === PartnerPrivateThreadStatus.ACTIVE ? "active"
    : value.status === PartnerPrivateThreadStatus.CLOSED ? "closed"
      : (() => { throw new GatewayError("Orchestrator returned an unknown Partner private thread status."); })();
  const closeReason: PartnerPrivateThreadCloseReasonView | undefined = value.closeReason === undefined
    ? undefined
    : value.closeReason === PartnerPrivateThreadCloseReason.MESSAGE_LIMIT ? "messageLimit"
      : value.closeReason === PartnerPrivateThreadCloseReason.IDLE_TIMEOUT ? "idleTimeout"
        : (() => { throw new GatewayError("Orchestrator returned an unknown Partner private thread close reason."); })();
  const expiresAt = requiredContactTimestamp(value.expiresAt, "Partner private thread expiry");
  const blockedUntil = value.blockedUntil === undefined
    ? undefined
    : requiredContactTimestamp(value.blockedUntil, "Partner private thread cooldown");
  const createdAt = requiredContactTimestamp(value.createdAt, "Partner private thread creation");
  const updatedAt = requiredContactTimestamp(value.updatedAt, "Partner private thread update");
  const closedAt = value.closedAt === undefined
    ? undefined
    : requiredContactTimestamp(value.closedAt, "Partner private thread closure");
  if ((status === "active") !== (closeReason === undefined)
    || (status === "active") !== (closedAt === undefined)
    || (closeReason === "messageLimit") !== (blockedUntil !== undefined)
    || updatedAt < createdAt || expiresAt < createdAt
    || (closedAt !== undefined && closedAt < createdAt)
    || (blockedUntil !== undefined && blockedUntil < createdAt)) {
    throw new GatewayError("Orchestrator returned an inconsistent Partner private thread.");
  }
  return {
    id: value.threadId,
    firstPartnerId: value.firstPartnerId,
    secondPartnerId: value.secondPartnerId,
    status,
    ...(closeReason === undefined ? {} : { closeReason }),
    messageCount: value.messageCount,
    maxMessages: value.maxMessages,
    expiresAt,
    ...(blockedUntil === undefined ? {} : { blockedUntil }),
    createdAt,
    updatedAt,
    ...(closedAt === undefined ? {} : { closedAt })
  };
}

function mapPartnerPrivateMessage(value: ProtoPartnerPrivateMessage): PartnerPrivateMessageView {
  if (value.messageId.trim() === "" || value.threadId.trim() === "" || value.senderPartnerId.trim() === ""
    || value.recipientPartnerId.trim() === "" || value.senderPartnerId === value.recipientPartnerId
    || value.content.trim() === "" || value.sequence < 1n) {
    throw new GatewayError("Orchestrator returned an invalid Partner private message.");
  }
  const deliveryStatus: PartnerPrivateMessageDeliveryStatusView =
    value.deliveryStatus === PartnerPrivateMessageDeliveryStatus.PENDING ? "pending"
      : value.deliveryStatus === PartnerPrivateMessageDeliveryStatus.DELIVERED ? "delivered"
        : value.deliveryStatus === PartnerPrivateMessageDeliveryStatus.FAILED ? "failed"
          : (() => { throw new GatewayError("Orchestrator returned an unknown Partner message state."); })();
  const createdAt = requiredContactTimestamp(value.createdAt, "Partner private message creation");
  const deliveredAt = value.deliveredAt === undefined
    ? undefined
    : requiredContactTimestamp(value.deliveredAt, "Partner private message delivery");
  if ((deliveryStatus === "delivered") !== (deliveredAt !== undefined)
    || (deliveredAt !== undefined && deliveredAt < createdAt)) {
    throw new GatewayError("Orchestrator returned an inconsistent Partner private message.");
  }
  return {
    id: value.messageId,
    threadId: value.threadId,
    sequence: safePartnerCount(value.sequence, "Partner private message sequence"),
    senderPartnerId: value.senderPartnerId,
    recipientPartnerId: value.recipientPartnerId,
    content: value.content,
    deliveryStatus,
    createdAt,
    ...(deliveredAt === undefined ? {} : { deliveredAt })
  };
}

function mapPartnerPrivateReadState(
  value: ProtoPartnerPrivateThreadReadState | undefined
): PartnerPrivateThreadReadStateView {
  if (value === undefined || value.threadId.trim() === "" || value.partnerId.trim() === "") {
    throw new GatewayError("Orchestrator returned an invalid Partner private read state.");
  }
  return {
    threadId: value.threadId,
    partnerId: value.partnerId,
    throughSequence: safePartnerCount(value.throughSequence, "Partner private read sequence"),
    updatedAt: requiredContactTimestamp(value.updatedAt, "Partner private read update")
  };
}

function mapPartnerDelegation(value: ProtoPartnerDelegation | undefined): PartnerDelegationView {
  if (value === undefined || value.delegationId.trim() === "" || value.requesterPartnerId.trim() === ""
    || value.targetPartnerId.trim() === "" || value.parentSessionId.trim() === ""
    || value.requesterPartnerId === value.targetPartnerId
    || value.targetProfileVersion < 1n || value.title.trim() === "" || value.objective.trim() === ""
    || value.childSessionId?.trim() === "" || value.runId?.trim() === ""
    || value.resultSummary?.trim() === "" || value.error?.trim() === "") {
    throw new GatewayError("Orchestrator returned an incomplete Partner delegation.");
  }
  const status = partnerDelegationStatus(value.status);
  const createdAt = requiredContactTimestamp(value.createdAt, "Partner delegation creation");
  const updatedAt = requiredContactTimestamp(value.updatedAt, "Partner delegation update");
  const startedAt = value.startedAt === undefined
    ? undefined
    : requiredContactTimestamp(value.startedAt, "Partner delegation start");
  const completedAt = value.completedAt === undefined
    ? undefined
    : requiredContactTimestamp(value.completedAt, "Partner delegation completion");
  const dispatched = status === "queued" || status === "running" || status === "waiting" || status === "completed";
  const terminal = status === "completed" || status === "failed" || status === "cancelled";
  if (updatedAt < createdAt
    || (startedAt !== undefined && startedAt < createdAt)
    || (completedAt !== undefined && completedAt < createdAt)
    || (dispatched && (value.childSessionId === undefined || value.runId === undefined))
    || (terminal !== (completedAt !== undefined))
    || ((status === "running" || status === "waiting" || status === "completed") && startedAt === undefined)
    || ((status === "completed") !== (value.resultSummary !== undefined))
    || (status === "failed" && value.error === undefined)
    || (status !== "failed" && status !== "unknown" && value.error !== undefined)) {
    throw new GatewayError("Orchestrator returned an inconsistent Partner delegation.");
  }
  return {
    id: value.delegationId,
    revision: requiredPartnerRevision(value.revision, "Partner delegation"),
    requesterPartnerId: value.requesterPartnerId,
    targetPartnerId: value.targetPartnerId,
    parentSessionId: value.parentSessionId,
    targetProfileVersion: value.targetProfileVersion,
    title: value.title,
    objective: value.objective,
    status,
    ...(value.childSessionId === undefined ? {} : { childSessionId: value.childSessionId }),
    ...(value.runId === undefined ? {} : { runId: value.runId }),
    ...(value.resultSummary === undefined ? {} : { resultSummary: value.resultSummary }),
    ...(value.error === undefined ? {} : { error: value.error }),
    artifactCount: safePartnerCount(value.artifactCount, "Partner delegation Artifact count"),
    createdAt,
    updatedAt,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(completedAt === undefined ? {} : { completedAt })
  };
}

function partnerDelegationStatus(value: PartnerDelegationStatus): PartnerDelegationStatusView {
  if (value === PartnerDelegationStatus.PREPARING) return "preparing";
  if (value === PartnerDelegationStatus.QUEUED) return "queued";
  if (value === PartnerDelegationStatus.RUNNING) return "running";
  if (value === PartnerDelegationStatus.WAITING) return "waiting";
  if (value === PartnerDelegationStatus.COMPLETED) return "completed";
  if (value === PartnerDelegationStatus.FAILED) return "failed";
  if (value === PartnerDelegationStatus.CANCELLED) return "cancelled";
  if (value === PartnerDelegationStatus.UNKNOWN) return "unknown";
  throw new GatewayError("Orchestrator returned an unknown Partner delegation status.");
}

function partnerCursor(value: { readonly value: bigint } | undefined, label: string): bigint {
  if (value === undefined || value.value < 0n) throw new GatewayError(`Orchestrator returned an invalid ${label}.`);
  return value.value;
}

function safePartnerCount(value: bigint, label: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new GatewayError(`Orchestrator returned an invalid ${label}.`);
  }
  return Number(value);
}

function mapPartnerDirectory(value: ProtoPartnerDirectory | undefined): PartnerDirectoryView {
  if (value === undefined || ![value.activeCount, value.archivedCount, value.errorCount]
    .every((count) => Number.isSafeInteger(count) && count >= 0)) {
    throw new GatewayError("Orchestrator returned an invalid Partner directory.");
  }
  const templates = value.templates.map((template) => {
    if (template.templateId.trim() === "" || template.displayName.trim() === ""
      || template.description.trim() === "" || template.identitySource.trim() === "") {
      throw new GatewayError("Orchestrator returned an incomplete Partner template.");
    }
    return {
      id: template.templateId,
      displayName: template.displayName,
      description: template.description,
      identitySource: template.identitySource
    };
  });
  const templateIds = new Set(templates.map((template) => template.id));
  const avatars = value.avatarPresets.map((avatar) => avatar.trim());
  if (templateIds.size !== templates.length || avatars.some((avatar) => avatar === "")
    || new Set(avatars).size !== avatars.length) {
    throw new GatewayError("Orchestrator returned a duplicate Partner directory option.");
  }
  return {
    revision: requiredPartnerRevision(value.revision, "Partner directory"),
    activeCount: value.activeCount,
    archivedCount: value.archivedCount,
    errorCount: value.errorCount,
    updatedAt: requiredContactTimestamp(value.updatedAt, "Partner directory update"),
    templates,
    avatarPresets: avatars,
    ...(value.defaultCapabilities === undefined
      ? {} : { defaultCapabilities: mapPartnerCapabilities(value.defaultCapabilities) })
  };
}

function mapPartnerMutation(
  partner: ProtoPartnerProfile | undefined,
  directory: ProtoPartnerDirectory | undefined
): PartnerMutationView {
  return { partner: mapPartnerProfile(partner), directory: mapPartnerDirectory(directory) };
}

function requiredContactRevision(value: { readonly value: bigint } | undefined, label: string): bigint {
  if (value === undefined || value.value < 1n) throw new GatewayError(`Orchestrator returned an invalid ${label} revision.`);
  return value.value;
}

function requiredContactTimestamp(
  value: { readonly seconds: bigint; readonly nanos: number } | undefined,
  label: string
): number {
  if (value === undefined) throw new GatewayError(`Orchestrator returned no ${label} timestamp.`);
  const mapped = timestampMs(value);
  if (!Number.isSafeInteger(mapped) || mapped < 0) throw new GatewayError(`Orchestrator returned an invalid ${label} timestamp.`);
  return mapped;
}

function protoContactKind(value: ContactKindView): ProtoContactKind {
  return value === "person" ? ProtoContactKind.PERSON : ProtoContactKind.ORGANIZATION;
}

function contactKind(value: ProtoContactKind): ContactKindView {
  if (value === ProtoContactKind.PERSON) return "person";
  if (value === ProtoContactKind.ORGANIZATION) return "organization";
  throw new GatewayError("Orchestrator returned an unknown Contact kind.");
}

function protoContactStatus(value: ContactStatusView): ProtoContactStatus {
  return value === "confirmed" ? ProtoContactStatus.CONFIRMED : ProtoContactStatus.PENDING;
}

function contactStatus(value: ProtoContactStatus): ContactStatusView {
  if (value === ProtoContactStatus.CONFIRMED) return "confirmed";
  if (value === ProtoContactStatus.PENDING) return "pending";
  throw new GatewayError("Orchestrator returned an unknown Contact status.");
}

function protoContactSource(value: ContactSourceView): ProtoContactSource {
  if (value === "manual") return ProtoContactSource.MANUAL;
  if (value === "agent") return ProtoContactSource.AGENT;
  return ProtoContactSource.IMPORT;
}

function contactSource(value: ProtoContactSource): ContactSourceView {
  if (value === ProtoContactSource.MANUAL) return "manual";
  if (value === ProtoContactSource.AGENT) return "agent";
  if (value === ProtoContactSource.IMPORT) return "import";
  throw new GatewayError("Orchestrator returned an unknown Contact source.");
}

function protoContactIdentityInput(value: ContactIdentityInputView) {
  return { platform: value.platform, value: value.value, label: value.label, note: value.note };
}

function protoContactEventInput(value: ContactEventInputView) {
  return { date: value.date, text: value.text, source: value.source };
}

function protoContactDraft(value: ContactDraftView) {
  return {
    kind: protoContactKind(value.kind),
    displayName: value.displayName,
    aliases: [...value.aliases],
    summary: value.summary,
    narrative: value.narrative,
    agentNotes: value.agentNotes,
    status: protoContactStatus(value.status),
    source: protoContactSource(value.source),
    identities: value.identities.map(protoContactIdentityInput)
  };
}

function protoContactPatch(value: ContactPatchView) {
  return {
    ...(value.kind === undefined ? {} : { kind: protoContactKind(value.kind) }),
    ...(value.displayName === undefined ? {} : { displayName: value.displayName }),
    ...(value.aliases === undefined ? {} : { aliases: { values: [...value.aliases] } }),
    ...(value.summary === undefined ? {} : { summary: value.summary }),
    ...(value.narrative === undefined ? {} : { narrative: value.narrative }),
    ...(value.agentNotes === undefined ? {} : { agentNotes: value.agentNotes }),
    ...(value.status === undefined ? {} : { status: protoContactStatus(value.status) })
  };
}

function mapContactIdentity(value: ProtoContactIdentity): ContactIdentityView {
  return {
    id: value.contactIdentityId,
    contactId: value.contactId,
    revision: requiredContactRevision(value.revision, "Contact identity"),
    platform: value.platform,
    value: value.value,
    normalizedValue: value.normalizedValue,
    label: value.label,
    note: value.note,
    createdAt: requiredContactTimestamp(value.createdAt, "Contact identity creation")
  };
}

function mapContactEvent(value: ProtoContactEvent): ContactEventView {
  return {
    id: value.contactEventId,
    contactId: value.contactId,
    revision: requiredContactRevision(value.revision, "Contact event"),
    date: value.date,
    text: value.text,
    source: value.source,
    createdAt: requiredContactTimestamp(value.createdAt, "Contact event creation")
  };
}

function mapContactGroup(value: ProtoContactGroup | undefined): ContactGroupView {
  if (value === undefined) throw new GatewayError("Orchestrator returned no Contact group.");
  return {
    id: value.contactGroupId,
    revision: requiredContactRevision(value.revision, "Contact group"),
    name: value.name,
    description: value.description,
    memberCount: value.memberCount,
    createdAt: requiredContactTimestamp(value.createdAt, "Contact group creation"),
    updatedAt: requiredContactTimestamp(value.updatedAt, "Contact group update")
  };
}

function mapContactRelation(value: ProtoContactRelation): ContactRelationView {
  const direction = value.direction === ContactRelationDirection.OUTGOING
    ? "outgoing"
    : value.direction === ContactRelationDirection.INCOMING
      ? "incoming"
      : undefined;
  if (direction === undefined) throw new GatewayError("Orchestrator returned an unknown Contact relation direction.");
  return {
    id: value.contactRelationId,
    revision: requiredContactRevision(value.revision, "Contact relation"),
    fromContactId: value.fromContactId,
    toContactId: value.toContactId,
    relation: value.relation,
    note: value.note,
    createdAt: requiredContactTimestamp(value.createdAt, "Contact relation creation"),
    direction,
    relatedContactId: value.relatedContactId,
    relatedDisplayName: value.relatedDisplayName,
    relatedKind: contactKind(value.relatedKind)
  };
}

function mapContactSummary(value: ProtoContactSummary | undefined): ContactSummaryView {
  if (value === undefined) throw new GatewayError("Orchestrator returned no Contact summary.");
  return {
    id: value.contactId,
    revision: requiredContactRevision(value.revision, "Contact"),
    kind: contactKind(value.kind),
    displayName: value.displayName,
    aliases: value.aliases,
    summary: value.summary,
    status: contactStatus(value.status),
    source: contactSource(value.source),
    identityCount: value.identityCount,
    createdAt: requiredContactTimestamp(value.createdAt, "Contact creation"),
    updatedAt: requiredContactTimestamp(value.updatedAt, "Contact update")
  };
}

function mapContactProfile(value: ProtoContactProfile | undefined): ContactProfileView {
  if (value === undefined) throw new GatewayError("Orchestrator returned no Contact profile.");
  return {
    ...mapContactSummary(value.summary),
    narrative: value.narrative,
    agentNotes: value.agentNotes,
    identities: value.identities.map(mapContactIdentity),
    events: value.events.map(mapContactEvent),
    groups: value.groups.map(mapContactGroup),
    relations: value.relations.map(mapContactRelation)
  };
}

function mapContactDirectory(value: ProtoContactDirectory | undefined): ContactDirectoryView {
  if (value === undefined) throw new GatewayError("Orchestrator returned no Contact directory state.");
  return {
    format: value.format,
    revision: requiredContactRevision(value.revision, "Contact directory"),
    enabled: value.enabled,
    people: value.people,
    organizations: value.organizations,
    pending: value.pending,
    groups: value.groups
  };
}

function mapContactSyncStatus(value: ProtoContactSyncStatus | undefined): ContactSyncStatusView {
  if (value === undefined || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value.nodeId) ||
    !/^[a-f0-9]{64}$/u.test(value.fingerprint)) {
    throw new GatewayError("Orchestrator returned an invalid Contacts sync status.");
  }
  const phase = value.phase === ContactSyncPhase.OFF ? "off" as const
    : value.phase === ContactSyncPhase.WAITING ? "waiting" as const
      : value.phase === ContactSyncPhase.SYNCING ? "syncing" as const
        : value.phase === ContactSyncPhase.UP_TO_DATE ? "upToDate" as const
          : value.phase === ContactSyncPhase.ERROR ? "error" as const
            : undefined;
  if (phase === undefined) throw new GatewayError("Orchestrator returned an unknown Contacts sync phase.");
  const errorCode = value.errorCode === undefined ? undefined
    : value.errorCode === ContactSyncErrorCode.IDENTITY_UNAVAILABLE ? "identityUnavailable" as const
      : value.errorCode === ContactSyncErrorCode.PEER_IDENTITY_CHANGED ? "peerIdentityChanged" as const
        : value.errorCode === ContactSyncErrorCode.SYNC_FAILED ? "syncFailed" as const
          : undefined;
  if (value.errorCode !== undefined && errorCode === undefined) {
    throw new GatewayError("Orchestrator returned an unknown Contacts sync error.");
  }
  const lastRoute = value.lastRoute === undefined ? undefined
    : value.lastRoute === ContactSyncRoute.LAN ? "lan" as const : undefined;
  if (value.lastRoute !== undefined && lastRoute === undefined) throw new GatewayError("Orchestrator returned an unknown Contacts sync route.");
  const peers = value.peers.map((peer) => {
    const state = peer.state === ContactSyncPeerState.PENDING ? "pending" as const
      : peer.state === ContactSyncPeerState.ACTIVE ? "active" as const : undefined;
    const route = peer.lastRoute === undefined ? undefined
      : peer.lastRoute === ContactSyncRoute.LAN ? "lan" as const : undefined;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(peer.peerId) || !validContactSyncDisplayName(peer.displayName) ||
      !/^[a-f0-9]{64}$/u.test(peer.fingerprint) || state === undefined ||
      (peer.lastRoute !== undefined && route === undefined)) {
      throw new GatewayError("Orchestrator returned an invalid Contacts sync peer.");
    }
    const lastSyncAt = peer.lastSyncAt === undefined ? undefined
      : requiredContactTimestamp(peer.lastSyncAt, "Contacts sync peer completion");
    if ((lastSyncAt === undefined) !== (route === undefined) || (state === "active") !== (lastSyncAt !== undefined)) {
      throw new GatewayError("Orchestrator returned an incomplete Contacts sync peer.");
    }
    return {
      peerId: peer.peerId,
      revision: requiredContactRevision(peer.revision, "Contacts sync peer"),
      displayName: peer.displayName,
      fingerprint: peer.fingerprint,
      online: peer.online,
      state,
      grantedAt: requiredContactTimestamp(peer.grantedAt, "Contacts sync peer grant"),
      ...(lastSyncAt === undefined ? {} : { lastSyncAt }),
      ...(route === undefined ? {} : { lastRoute: route })
    };
  });
  const candidates = value.candidates.map((candidate) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(candidate.nodeId) || !validContactSyncDisplayName(candidate.displayName) ||
      !/^[a-f0-9]{64}$/u.test(candidate.fingerprint) || candidate.granted && candidate.keyChanged) {
      throw new GatewayError("Orchestrator returned an invalid Contacts sync candidate.");
    }
    return {
      nodeId: candidate.nodeId,
      displayName: candidate.displayName,
      fingerprint: candidate.fingerprint,
      seenAt: requiredContactTimestamp(candidate.seenAt, "Contacts sync candidate observation"),
      granted: candidate.granted,
      keyChanged: candidate.keyChanged
    };
  });
  if (new Set(peers.map((peer) => peer.peerId)).size !== peers.length ||
    new Set(candidates.map((candidate) => candidate.nodeId)).size !== candidates.length ||
    value.onlinePeerCount !== peers.filter((peer) => peer.online).length) {
    throw new GatewayError("Orchestrator returned inconsistent Contacts sync peers.");
  }
  const lastSyncAt = value.lastSyncAt === undefined ? undefined
    : requiredContactTimestamp(value.lastSyncAt, "Contacts sync completion");
  const hasLastSyncIdentity = value.lastSyncPeerId !== undefined && value.lastSyncPeerName !== undefined;
  if ((lastSyncAt === undefined) !== !hasLastSyncIdentity || (lastSyncAt === undefined) !== (lastRoute === undefined) ||
    hasLastSyncIdentity && (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value.lastSyncPeerId!) ||
      !validContactSyncDisplayName(value.lastSyncPeerName!))) {
    throw new GatewayError("Orchestrator returned an incomplete Contacts sync completion.");
  }
  return {
    available: value.available,
    configurationRevision: requiredContactRevision(value.configurationRevision, "Contacts sync configuration"),
    nodeId: value.nodeId,
    fingerprint: value.fingerprint,
    enabled: value.enabled,
    phase,
    onlinePeerCount: value.onlinePeerCount,
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(lastSyncAt === undefined ? {} : {
      lastSyncAt,
      lastSyncPeerId: value.lastSyncPeerId!,
      lastSyncPeerName: value.lastSyncPeerName!,
      lastRoute: lastRoute!
    }),
    peers,
    candidates
  };
}

function validContactSyncDisplayName(value: string): boolean {
  return value === value.trim() && value.length >= 1 && value.length <= 100 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function mapContactMutation(contact: ProtoContactProfile | undefined, directory: ProtoContactDirectory | undefined): ContactMutationView {
  return { contact: mapContactProfile(contact), directory: mapContactDirectory(directory) };
}

function mapContactDuplicateCandidate(value: ProtoContactDuplicateCandidate): ContactDuplicateCandidateView {
  const matchType = value.matchType === ContactDuplicateMatchType.IDENTITY
    ? "identity"
    : value.matchType === ContactDuplicateMatchType.NAME
      ? "name"
      : undefined;
  if (matchType === undefined) throw new GatewayError("Orchestrator returned an unknown Contact duplicate match type.");
  return {
    matchType,
    contactId: value.contactId,
    displayName: value.displayName,
    kind: contactKind(value.kind),
    status: contactStatus(value.status),
    summary: value.summary,
    ...(value.matchedPlatform === undefined ? {} : { matchedPlatform: value.matchedPlatform }),
    ...(value.matchedValue === undefined ? {} : { matchedValue: value.matchedValue })
  };
}

function contactVCardImportDisposition(value: ContactVCardImportDisposition): ContactVCardImportDispositionView {
  if (value === ContactVCardImportDisposition.CREATE) return "create";
  if (value === ContactVCardImportDisposition.AUTO_ENRICH) return "autoEnrich";
  if (value === ContactVCardImportDisposition.NEEDS_REVIEW) return "needsReview";
  throw new GatewayError("Orchestrator returned an unknown Contact vCard import disposition.");
}

function protoContactVCardImportDecisionKind(value: ContactVCardImportDecisionKindView): ContactVCardImportDecisionKind {
  if (value === "create") return ContactVCardImportDecisionKind.CREATE;
  if (value === "merge") return ContactVCardImportDecisionKind.MERGE;
  return ContactVCardImportDecisionKind.SKIP;
}

function mapProtoContactDraft(value: ProtoContactDraft | undefined): ContactDraftView {
  if (value === undefined) throw new GatewayError("Orchestrator returned no Contact vCard draft.");
  return {
    kind: contactKind(value.kind),
    displayName: value.displayName,
    aliases: value.aliases,
    summary: value.summary,
    narrative: value.narrative,
    agentNotes: value.agentNotes,
    status: contactStatus(value.status),
    source: contactSource(value.source),
    identities: value.identities.map((identity) => ({
      platform: identity.platform,
      value: identity.value,
      label: identity.label,
      note: identity.note
    }))
  };
}

function mapContactVCardImportPreviewEntry(value: ProtoContactVCardImportPreviewEntry): ContactVCardImportPreviewEntryView {
  return {
    entryId: value.entryId,
    contact: mapProtoContactDraft(value.contact),
    disposition: contactVCardImportDisposition(value.disposition),
    ...(value.existingContactId === undefined ? {} : { existingContactId: value.existingContactId }),
    candidates: value.candidates.map(mapContactDuplicateCandidate),
    ...(value.existingEntryId === undefined ? {} : { existingEntryId: value.existingEntryId }),
    similarEntryIds: value.similarEntryIds,
    ...(value.organizationName === undefined ? {} : { organizationName: value.organizationName }),
    ...(value.title === undefined ? {} : { title: value.title }),
    groups: value.groups,
    ...(value.organizationContactId === undefined ? {} : { organizationContactId: value.organizationContactId }),
    organizationCandidates: value.organizationCandidates.map(mapContactDuplicateCandidate)
  };
}

function protoContactVCardImportDecision(value: ContactVCardImportDecisionView) {
  return {
    entryId: value.entryId,
    decision: protoContactVCardImportDecisionKind(value.decision),
    ...(value.targetContactId === undefined ? {} : { targetContactId: value.targetContactId }),
    ...(value.expectedTargetRevision === undefined ? {} : { expectedTargetRevision: { value: value.expectedTargetRevision } }),
    confirmedNameCandidateIds: [...(value.confirmedNameCandidateIds ?? [])],
    ...(value.targetEntryId === undefined ? {} : { targetEntryId: value.targetEntryId }),
    ...(value.organizationDecision === undefined ? {} : { organizationDecision: protoContactVCardImportDecisionKind(value.organizationDecision) }),
    ...(value.organizationTargetContactId === undefined ? {} : { organizationTargetContactId: value.organizationTargetContactId }),
    ...(value.expectedOrganizationTargetRevision === undefined
      ? {}
      : { expectedOrganizationTargetRevision: { value: value.expectedOrganizationTargetRevision } }),
    ...(value.organizationTargetEntryId === undefined ? {} : { organizationTargetEntryId: value.organizationTargetEntryId }),
    confirmedOrganizationCandidateIds: [...(value.confirmedOrganizationCandidateIds ?? [])]
  };
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

function backendMemoryKind(value: BackendMemoryKind): "compaction_digest" | "native_auto_memory" {
  switch (value) {
    case BackendMemoryKind.COMPACTION_DIGEST: return "compaction_digest";
    case BackendMemoryKind.NATIVE_AUTO_MEMORY: return "native_auto_memory";
    case BackendMemoryKind.UNSPECIFIED: throw new Error("Backend memory kind is missing.");
    default: throw new Error("Backend memory kind is unsupported.");
  }
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

function providerCompatibility(value: ProviderApiCompatibility): SettingsView["providers"][number]["runtimes"][number]["compatibility"] {
  if (value === ProviderApiCompatibility.ANTHROPIC_MESSAGES) return "anthropic";
  if (value === ProviderApiCompatibility.OPENAI_RESPONSES) return "openaiResponses";
  if (value === ProviderApiCompatibility.OPENAI_CHAT_COMPLETIONS) return "openaiChat";
  if (value === ProviderApiCompatibility.OPENAI_COMPLETIONS) return "openaiCompletions";
  if (value === ProviderApiCompatibility.GOOGLE_GENERATIVE_AI) return "google";
  return "native";
}

function protoProviderCompatibility(value: ProviderDraft["runtimes"][number]["compatibility"]): ProviderApiCompatibility {
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

function canonicalMcpEndpoint(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  let endpoint: URL;
  try {
    endpoint = new URL(trimmed);
  } catch {
    throw new GatewayError("Enter a valid MCP endpoint URL.");
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname);
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && loopback)) {
    throw new GatewayError("MCP endpoints require HTTPS or an HTTP loopback address.");
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new GatewayError("MCP endpoints cannot contain credentials, query parameters, or fragments.");
  }
  return endpoint.href;
}

function providerConfigurationField(value: ProviderConfigurationField): NonNullable<BackendView["providerRuntimeSupport"]>["fields"][number] | undefined {
  switch (value) {
    case ProviderConfigurationField.REQUEST_PATH: return "requestPath";
    case ProviderConfigurationField.MODELS_ENDPOINT: return "modelsEndpoint";
    case ProviderConfigurationField.HEADERS: return "headers";
    case ProviderConfigurationField.KEYLESS: return "keyless";
    case ProviderConfigurationField.AUTH_HEADER: return "authHeader";
    case ProviderConfigurationField.MODEL_LIMITS: return "modelLimits";
    case ProviderConfigurationField.MODEL_COSTS: return "modelCosts";
    case ProviderConfigurationField.MODEL_INPUT_MODALITIES: return "modelInputModalities";
    case ProviderConfigurationField.MODEL_THINKING_LEVELS: return "modelThinkingLevels";
    case ProviderConfigurationField.MODEL_SAMPLING: return "modelSampling";
    case ProviderConfigurationField.MODEL_COMPATIBILITY: return "modelCompatibility";
    case ProviderConfigurationField.MODEL_FAST_MODE: return "modelFastMode";
    default: return undefined;
  }
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
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname);
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
  switch (value) {
    case QueueDeliveryMode.PROMPT: return "prompt";
    case QueueDeliveryMode.STEER: return "steer";
    case QueueDeliveryMode.FOLLOW_UP: return "followUp";
    default: throw new GatewayError("Orchestrator returned an unknown Queue delivery mode.");
  }
}

function queueState(value: QueueItemState): QueueItemView["state"] {
  switch (value) {
    case QueueItemState.ACCEPTED: return "accepted";
    case QueueItemState.DISPATCHING: return "dispatching";
    case QueueItemState.BACKEND_ACCEPTED: return "acceptedByBackend";
    case QueueItemState.DISPATCH_UNKNOWN: return "dispatchUnknown";
    case QueueItemState.COMPLETED: return "completed";
    case QueueItemState.CANCELLED: return "cancelled";
    case QueueItemState.FAILED: return "failed";
    default: throw new GatewayError("Orchestrator returned an unknown Queue item state.");
  }
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

function browserAutomationTarget(value: BrowserAutomationTarget): BrowserSettingsView["automationTarget"] {
  switch (value) {
    case BrowserAutomationTarget.SIDEBAR: return "sidebar";
    case BrowserAutomationTarget.EXTERNAL: return "external";
    case BrowserAutomationTarget.UNSPECIFIED:
    default: throw new Error("Orchestrator returned an invalid Browser automation target.");
  }
}

function protoBrowserAutomationTarget(value: BrowserSettingsView["automationTarget"]): BrowserAutomationTarget {
  switch (value) {
    case "sidebar": return BrowserAutomationTarget.SIDEBAR;
    case "external": return BrowserAutomationTarget.EXTERNAL;
    default: throw new GatewayError("Browser automation target must be sidebar or external.");
  }
}

function mapSessionResource(resource: SessionResource, expectedSessionId: string): SessionResourceView {
  const runtimeGeneration = exactSafeUnsignedNumber(resource.runtimeGeneration);
  const kind = sessionResourceKind(resource.kind);
  if (
    resource.sessionId !== expectedSessionId
    || kind === undefined
    || !validResourceIdentityText(resource.resourceId)
    || resource.name.trim() === ""
    || !validResourceIdentityText(resource.discoveredRevision)
    || resource.resourceVersion < 1n
    || runtimeGeneration === undefined
    || runtimeGeneration < 1
  ) throw new GatewayError("Orchestrator returned an invalid task resource identity.");
  return {
    sessionId: resource.sessionId,
    id: resource.resourceId,
    name: resource.name,
    ...(resource.version === "" ? {} : { version: resource.version }),
    kind,
    discoveredRevision: resource.discoveredRevision,
    resourceVersion: resource.resourceVersion.toString(10),
    runtimeGeneration
  };
}

function validResourceIdentityText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096
    && value === value.trim() && !/[\u0000-\u001f\u007f\u2028\u2029]/u.test(value);
}

function validSessionMentionId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 1_024
    && value === value.trim() && !/[\u0000-\u001f\u007f\u2028\u2029]/u.test(value);
}

function validResourceVersionText(value: unknown): value is string {
  return typeof value === "string" && value.length <= 20 && /^[1-9][0-9]*$/u.test(value);
}

function sessionResourceKind(value: ResourceKind): SessionResourceView["kind"] | undefined {
  if (value === ResourceKind.EXTENSION) return "extension";
  if (value === ResourceKind.SKILL) return "skill";
  if (value === ResourceKind.PROMPT_TEMPLATE) return "prompt";
  if (value === ResourceKind.PACKAGE) return "package";
  return undefined;
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
