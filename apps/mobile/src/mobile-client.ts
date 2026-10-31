import { isEndpointTrustError, observeEndpointTrustFailure, rememberEndpointTrust, replaceEndpointTrust, trustedEndpointPublicKey, trustedEndpointTransportKind } from "@joko/connection-transport";
import { extensionCardFormDeliveryScope, pendingExtensionCardFormDelivery } from "@joko/contracts";
import { encodeModelSpeed, decodeModelSpeed } from "@joko/contracts";
import { ExtensionPackageAction } from "@joko/contracts";
import { projectProviderGroupRebalance, type ProviderGroupRebalanceSuggestion } from "@joko/contracts";
import { assertMobileExtensionPackagePreview, type MobileExtensionPackagePreview } from "./mobile-extension-packages";
import { executeExtensionSettingsCall } from "@joko/connection-transport";
import type { SessionArchivePreview } from "@joko/contracts";
import { InteractionSchema, splitQuestionReferences } from "@joko/contracts";
import { clipBareHttpAutolinkText } from "./mobile-markdown-url-boundary";
import { clone, create, equals, fromJsonString, toBinary } from "@bufbuild/protobuf";
import { MobileTaskOutboxStore, mobileTaskOutboxModel, mobileTaskOutboxOwnerMatches,
  type MobileTaskOutboxRecord } from "./mobile-task-outbox";
import { projectPartnerSessionTask } from "@joko/contracts";
import { TaskShareMethod, SetSessionRuntimeMutationSchema, type JoinedTaskShare, type TaskSharingApi, type TaskShareRuntimeControl } from "@joko/contracts";
import { mobileTaskSharingApi, mobileJoinedTaskNetwork, assertMobileSharedTaskSnapshot,
  assertMobileSharedTaskOperation, mobileSharedTaskAuthorMatches, mobileTaskSharingDelay,
  mobileSharedTaskDraftProfileId,
  type MobileJoinedTaskSource, type MobileTaskSource } from "./mobile-task-sharing";
import { resolveMobileSharedRuntimeControls } from "./mobile-runtime-controls";
import { MobileNewTaskModelMemory, type MobileNewTaskSourceSelection } from "./mobile-new-task-model-memory";
import { sameMobileModelSourceProject } from "./mobile-model-source-project";
import { CreateRemoteTargetMutationSchema, CreateDevicePeerTargetMutationSchema } from "@joko/contracts";
import { resolveMobileSharedContextControls } from "./mobile-context-controls";
import { normalizeMobileObjectiveInput, type MobileObjectiveInput, type MobileObjectiveApi } from "./mobile-objective";
import { MobileObjectiveRecovery, type MobileObjectiveRecoveryIdentity } from "./mobile-objective-recovery";
import { mobileWorkerTargets, mobileWorkerLabel, mobileWorkerInitialTask, normalizeMobileWorkerForm,
  type MobileCollaborationApi, type MobileCollaborationView, type MobileWorkerForm } from "./mobile-collaboration";
import { MobileWorkerStorage, type MobileWorkerFormIdentity } from "./mobile-worker-storage";
import { CollaborationSessionRole, CollaborationGoalStatus, CollaborationWorkerStatus, type CollaborationGoalTree, type CollaborationSettings } from "@joko/contracts";
import { MobileAttachmentCamera } from "./mobile-attachment-camera";
import { MobilePhotoLibrary } from "./mobile-photo-library";
import { waitForMobileAttachmentAuthority } from "./mobile-attachment-authority";
import { createMobileGroupImageTools } from "./mobile-partner-group-images";
import { createMobileGroupMedia } from "./mobile-partner-group-media";
import type { MobilePartnerAvatarTransport } from "./mobile-partner-avatar";
import { mobilePartnerRosterSourceKey, type MobilePartnerRosterSource, type MobilePartnerRosterSourceTransport } from "./mobile-partner-roster";
import { readMobilePartnerOfflineConversation } from "./mobile-partner-offline-conversation";
import type { MobilePartnerGroupSourceTransport, MobilePartnerGroupSelection } from "./mobile-partner-group-roster";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { Code } from "@connectrpc/connect";
import {
  PartnerResumeEditor, PartnerImportEditor, PartnerImportReceipts, PartnerMemoryEditor, PartnerConnectionsEditor, PartnerSkillsEditor,
  PartnerGroupAttachmentSchema, PartnerGroupAttachmentCategory,
  ArchiveSessionMutationSchema, BlobDisposition, BlobRefSchema, CancelQueueItemMutationSchema, CapabilitySupport, CompactSessionMutationSchema, CompactSessionOutcome,
  ConnectionState, CreateScheduleMutationSchema, CreateSessionMutationSchema, CloneSessionMutationSchema, ForkSessionMutationSchema, OpenSideChatMutationSchema, SessionDerivationKind,
  CreateTargetMutationSchema, TargetWorkspaceInputSchema,
  CreateTaskTagMutationSchema, UpdateTaskTagMutationSchema, ReorderTaskTagsMutationSchema, SetSessionTaskTagsMutationSchema, DeleteTaskTagMutationSchema,
  DeleteScheduleMutationSchema, DeleteSessionMessageMutationSchema, DeleteSessionMutationSchema, DeviceKind, DismissInteractionMutationSchema,
  EditQueueItemMutationSchema, EntityKind, EntityRefSchema, EventSchema, ExecuteUserShellMutationSchema, ExecuteWorkspaceRewindMutationSchema,
  LAN_DISCOVERY_PEER_TTL_MS,
  RemoteDesktopHostMuteRequestSchema,
  RemoteDesktopPrivacyScreenRequestSchema,
  ModelKeySchema, ModelSelectionSchema, NativeSessionPlacement, NativeSessionStartSchema, NewNativeSessionSchema,
  ModelFavoriteConfigurationSchema, UpdateModelFavoritesMutationSchema,
  ModelSourceKind,
  DeleteScheduleRunMutationSchema, LogoutConnectionMutationSchema, MarkAllScheduleRunsReadMutationSchema,
  MarkScheduleRunReadMutationSchema, MarkScheduleRunsReadMutationSchema, NavigateSessionBranchMutationSchema,
  OperationPreconditionSchema, OperationState, OperationMutationSchema, PerTurnOverridesSchema, RewindSafety,
  MessageRole, PermissionMode, PinSessionMutationSchema, QueueDeliveryMode, QueueItemState, RenameSessionMutationSchema, TaskTagColor,
  ReorderQueueItemMutationSchema, ResetSessionMutationSchema, ResolveInteractionMutationSchema, RestartScheduleRunMutationSchema,
  DeviceSchema, RenameDeviceMutationSchema, ResetDeviceNameMutationSchema, RevisionSchema, RevokeDeviceMutationSchema,
  CloneProjectScheduleToUserMutationSchema, PromoteScheduleToProjectMutationSchema,
  ReconcileProjectAutomationsMutationSchema, RemoveProjectScheduleMutationSchema,
  ReviewAttachmentInputSchema, ReviewAttachmentKind, ReviewRunState, RunState, SendInputMutationSchema, SessionMessageSearchSessionStatus,
  SessionState, SetQueueInteractionLockMutationSchema, SetQueueItemEditLockMutationSchema, SetScheduleEnabledMutationSchema, SetSessionModelMutationSchema,
  SetSessionPermissionMutationSchema, SetSessionPlanModeMutationSchema, TargetState, capabilityNames,
  StartReviewMutationSchema, TriggerScheduleMutationSchema, UpdateScheduleMutationSchema,
  UpdateVoiceInputServiceSettingsMutationSchema, VoiceInputServiceSettingsPatchSchema,
  FileKind, ImageRefSchema, ResourceKind, RuntimeCommandInputMode,
  type Artifact, type BackendDescriptor, type BlobRef, type Device, type DiscoveredNodeRecord, type Event, type EventCursor, type FilePreview, type FileRevision, type Interaction,
  type Operation, type OperationMutation, type QueueControl, type QueueItem, type Schedule, type Session, type Snapshot, type Target, type TaskTagDeletePreview,
  type WorkspaceEntry, type WorkspaceSearchMatch
} from "@joko/contracts";
import { mobileVoiceCredentialBindingChanged, type MobileVoiceSettingsTransport } from "./mobile-voice-service-settings";
import { McpAppNativeOperation, McpAppOperation, McpAppNativeServiceOperateRequestSchema, McpAppServiceOperateRequestSchema } from "@joko/contracts";
import { mobileDeviceNameSource, validMobileDeviceName, type MobileDeviceNameSourceProvider } from "./mobile-device-name";
import { resolveMobileMessageForkSource, type MobileMessageForkSource } from "./mobile-message-fork";
import {
  assertMobileWorkspaceRewindPreview, mobileMessageChangeSet, mobileMessageRewindIdle, mobileRewindCapability,
  mobileRewindToStartSupported, mobileWorkspaceRewindExpiresAt, resolveMobileMessageRewindSource,
  type MobileMessageRewindControls, type MobileMessageRewindPreview, type MobileMessageRewindResult
} from "./mobile-message-rewind";
import {
  mobileSessionOriginKey, mobileSessionOriginSessionKey, mobileSessionOriginSourceAvailable,
  projectMobileSessionOrigin, type MobileSessionOriginControls
} from "./mobile-session-origin";
import { buildMobileMessageDeepLink, buildMobileTaskDeepLink, parseMobileNativeIntent } from "./mobile-native-intent";
import { awaitMobileMarkdownResourceRead, MobileMarkdownResourceReader, type MobileMarkdownResourceContext, type MobileMarkdownResourceDescriptor } from "./mobile-markdown-resources";
import { mobileFileTextSource } from "./mobile-file-text-source";
import { MobileFileHtmlReader, type MobileFileHtmlContext, type MobileFileHtmlDescriptor } from "./mobile-file-html-reader";
import { mobileFileHtmlComplete } from "./mobile-file-html";
import { HtmlResourceBudgetError } from "./mobile-file-html-resources";
import { mobileGeneratedPreviewPages, mobileWorkspacePreviewPages, type MobileFilesPreviewPage, type MobileFilesPreviewPager } from "./mobile-files-preview-pager";
import { MobileTimelineImageReader, type MobileTimelineImageContext, type MobileTimelineImagePreview } from "./mobile-timeline-images";
import { MobileFilesThumbnailReader, mobileFilesThumbnailKind, mobileFilesThumbnailSourceKey, mobileFilesDocumentBytes,
  MOBILE_FILES_DOCUMENT_MAXIMUM_BYTES, MOBILE_FILES_IMAGE_MAXIMUM_BYTES, type MobileFilesThumbnailContext, type MobileFilesThumbnailPreview } from "./mobile-files-thumbnails";
import type { MobileFilesThumbnailCache } from "./mobile-files-thumbnail-cache";
import {
  MobileCredentialStorageError, profileFromCredential,
  type MobileConnectionProfile, type MobileStorage, type PendingOperation
} from "./connection-storage";
import type { MobileDiscovery } from "./connection-discovery";
import {
  MobileRemoteDesktopAuthorityError,
  type MobileRemoteDesktopTransport
} from "./remote-desktop-controller";
import type { MobileHomeStatusFilter } from "./home-navigation";
import {
  MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES,
  MOBILE_FILE_SHARE_MAXIMUM_BYTES,
  assertWorkspaceFilePreview,
  normalizeNodeOrigin,
  type MobileNetwork, type MobilePushCapabilityResult, type MobilePushRegistrationInput,
  type MobilePushRegistrationResult, type MobilePushRevocationTicket, type NodeIdentity, type PairedCredential
} from "./network";
import {
  assertMobileCanonicalPartnerSession, emptyMobilePartnerPrivateState,
  validMobilePartnerId, type MobilePartner, type MobilePartnerPrivateState, type MobilePrivateDetail
} from "./mobile-partner-private";
import {
  mobilePartnerResourceKey,
  projectMobilePartnerResourcePreview,
  type MobilePartnerResourcePreview,
  type MobilePartnerResourceTransport
} from "./mobile-partner-resources";
import {
  assertMobilePartnerDirectorySession,
  mobilePartnerDirectoryIdentity,
  type MobilePartnerCatalog,
  type MobilePartnerDirectoryProfile,
  type MobilePartnerDirectoryTransport
} from "./mobile-partner-directory";
import { mobilePartnerVisibleReply, type MobilePartnerConversationTransport } from "./mobile-partner-conversation";
import type { MobilePartnerDirectoryObservation } from "./mobile-partner-activity";
import type { MobilePartnerWorkingTransport } from "./mobile-partner-working";
import { projectSessionWorkingStatus, workingStatusTurnKey } from "@joko/contracts";
import { validateMobilePartnerProfileDraft, mobilePartnerDraftCatalogIdentity, mobilePartnerProfileDraft, type MobilePartnerProfileTransport } from "./mobile-partner-profile";
import { sameMobilePartnerTaskOutputSource } from "./mobile-partner-task-outputs";
import type { MobilePartnerInitializationModel, MobilePartnerInitializationTransport } from "./mobile-partner-initialization";
import { MobilePartnerCreationRejected, mobilePartnerCreationBackends, mobilePartnerCreationFields, validateMobilePartnerCreationDraft,
  type MobilePartnerCreationTransport, type MobilePartnerCreationResult } from "./mobile-partner-creation";
import type { MobilePartnerCreationReceipts } from "./mobile-partner-creation-receipts";
import type { MobilePartnerDeletionReceipts, MobilePartnerDeletionTransport } from "./mobile-partner-deletion";
import type { MobilePartnerRestartReceipts, MobilePartnerRestartTransport } from "./mobile-partner-restart";
import {
  assertMobileExtensionMainViewSurface,
  mobileExtensionKey,
  projectMobileExtensionMainViewSurface,
  sameMobileExtensionMainViewSurface,
  type MobileExtension,
  type MobileExtensionCommand,
  type MobileExtensionCredentialKind,
  type MobileExtensionMainViewSurface,
  type MobileExtensionMutationResult,
  type MobileExtensionPendingMutationKind,
  type MobileExtensionTransport,
  type MobileExtensionUseDestination,
  type MobileExtensionUseResult
} from "./mobile-extensions";
import {
  mobileExtensionLibraryReady,
  mobileExtensionLibrarySupported,
  normalizeMobileExtensionLibraryCandidate,
  sameMobileExtensionLibraryGraceEntry,
  sameMobileExtensionLibrarySnapshot,
  sameMobileExtensionLibraryTrashEntry,
  sameMobileExtensionLibraryValidation,
  type MobileExtensionLibraryLocationValidation,
  type MobileExtensionLibraryMutation,
  type MobileExtensionLibrarySnapshot
} from "./mobile-extension-library";
import type {
  MobileExtensionLibraryCall, MobileExtensionLibraryCallResult, MobileExtensionLibrarySession
} from "./mobile-extension-library-runtime";
import {
  applyMobileExtensionUseCommand,
  assertMobileExtensionTaskChoice,
  mobileExtensionNewTaskTarget,
  projectMobileExtensionTaskChoices,
  resolveMobileExtensionUseCommand
} from "./mobile-extension-use-handoff";
import {
  artifactTitle,
  bytesToDataUri,
  canonicalWorkspacePath,
  emptyMobileFilesState,
  filterWorkspaceFileNames,
  isTextMediaType,
  isTextFilePreviewMetadata,
  normalizeMediaType,
  resolveMobileWorkspaceAuthority,
  sortArtifacts,
  sortWorkspaceEntries,
  workspaceBasename,
  workspaceEntryRevisionKey,
  workspaceParentPath,
  type MobileFileSearchResult,
  type MobileFilePreview,
  type MobileFilesComposerResult,
  type MobileFilesComposerSource,
  type MobileFilesSearchMode,
  type MobileFilesState,
  type MobileWorkspaceAuthority
} from "./workspace-files";
import { sortMobileGeneratedArtifacts, sortMobileWorkspaceEntries, type MobileFilesSortMode } from "./mobile-files-presentation";
import type { MobileFilesClipboardLease } from "./mobile-files-clipboard";
import { MobileComposerImagePaste } from "./mobile-composer-image-paste";
import { mapMobileAudioMetadata, mobileAudioMetadataSourceKey } from "./mobile-audio-metadata";
import {
  mobileMediaPreviewKind,
  type MobileMediaPreviewFiles,
  type MobileMediaPreviewLease
} from "./mobile-media-preview";
import {
  isMobilePdfPreviewMediaType,
  type MobilePdfPreviewFiles,
  type MobilePdfPreviewLease
} from "./mobile-pdf-preview";
import {
  mobileModelPreviewKind,
  type MobileModelPreviewFiles,
  type MobileModelPreviewLease,
  type MobileModelResourceKind,
  type MobileModelResourceSnapshot
} from "./mobile-model-preview";
import {
  acceptedQueueItems,
  backendSupports,
  editQueueItemText,
  mobileQueueCapabilities,
  queueItemHasStructuredInput,
  queueItemText,
  queueMove
} from "./task-actions";
import {
  createMobileInteractionResolution,
  pendingMobileInteractions,
  type MobileInteractionSubmission
} from "./mobile-interactions";
import type { MobileInteractionDraftIdentity } from "./interaction-draft-store";
import type { MobileInputHandoffApi, MobileInputHandoffTasksApi } from "./mobile-input-handoff";
import type {
  MobileComposerDraftIdentity,
  MobileComposerDraftSnapshot,
  MobileComposerDraftStore
} from "./composer-draft-store";
import {
  emptyMobileComposerDraft,
  appendMobileFileSelectionQuote,
  insertMobileArtifactMention,
  insertMobileWorkspaceMention,
  mobileComposerDraftWithoutPrefix,
  mobileComposerDraftsEqual,
  mobileComposerInput,
  normalizeMobileComposerDraft,
  recoverMobileComposerDraft,
  type MobileComposerDraft
} from "./mobile-composer-document";
import {
  parseMobileComposerRouteHref,
  type MobileComposerRouteResolutionTarget
} from "./mobile-composer-route-links";
import {
  referencedMobileNativeTreeText,
  referencedMobileTimelineText
} from "./mobile-composer-route-resolution";
import {
  appendMobileComposerAttachments,
  assertMobileAttachmentCandidate,
  assertMobileAttachmentPolicy,
  mobileComposerAttachmentStorageIds,
  mobileComposerAttachmentsEqual,
  normalizeMobileComposerAttachment,
  replaceMobileComposerAttachment,
  replaceMobileComposerAttachmentSlot,
  resolveMobileAttachmentPolicy,
  type MobileAttachmentControls,
  type MobileComposerAttachment,
  type MobileComposerImageAnnotationSource,
  type MobileLocalComposerAttachment,
  type MobileUploadedComposerAttachment
} from "./mobile-attachments";
import type { MobileAttachmentFiles } from "./mobile-attachment-files";
import { copiedMobileIncomingShareStorageId } from "./mobile-incoming-share-order";
import {
  assertMobileCatalogMentionCandidate,
  assertMobileCatalogMentionDraft,
  assertMobileCatalogMentionDraftCatalog,
  createMobileCatalogMentionControls,
  projectMobileArtifactMentionCatalog,
  projectMobileResourceMentionCatalog,
  type MobileArtifactMentionCandidate,
  type MobileCatalogMentionCandidate,
  type MobileCatalogMentionCatalog,
  type MobileCatalogMentionControls,
  type MobileResourceMentionCandidate
} from "./mobile-catalog-mentions";
import {
  assertMobileSessionMentionCandidate,
  assertMobileSessionMentionDraft,
  createMobileNewTaskSessionMentionControls,
  createMobileSessionMentionControls,
  type MobileSessionMentionCandidate,
  type MobileSessionMentionControls
} from "./mobile-session-mentions";
import {
  assertMobileWorkspaceMentionCandidate,
  assertMobileWorkspaceMentionDraft,
  createMobileNewTaskWorkspaceMentionControls,
  createMobileWorkspaceMentionControls,
  projectMobileWorkspaceMentionDirectory,
  projectMobileWorkspaceMentionFileIndex,
  type MobileWorkspaceMentionCandidate,
  type MobileWorkspaceMentionControls,
  type MobileWorkspaceMentionDirectory,
  type MobileWorkspaceMentionFileIndex
} from "./mobile-workspace-mentions";
import {
  assertMobileWorkspacePathPasteDraft,
  assertMobileWorkspacePathPasteResolutions,
  createMobileNewTaskWorkspacePathPasteControls,
  createMobileWorkspacePathPasteControls,
  mobileComposerWorkspacePathAtoms,
  projectMobileWorkspacePathPasteDirectory,
  type MobileWorkspacePathPasteControls,
  type MobileWorkspacePathPasteResolution
} from "./mobile-workspace-path-paste";
import {
  mergeMobileNewTaskUnsentInput,
  type MobileNewTaskCreateSubmission,
  type MobileNewTaskDraft,
  type MobileNewTaskDraftIdentity,
  type MobileNewTaskDraftSnapshot,
  type MobileNewTaskDraftStore,
  type MobileNewTaskSendSubmission,
  type MobileNewTaskSubmission
} from "./new-task-draft-store";
import {
  assertMobileModelSelection,
  assertMobileModelFavoriteMutation,
  assertMobilePermissionMode,
  assertMobilePlanMode,
  resolveMobileExplicitNewTaskModelAuthority,
  resolveMobileNewTaskDefaultModelAuthority,
  resolveMobileNewTaskExecutionAuthority,
  resolveMobileRuntimeControls,
  resolveMobileSessionModelAuthority,
  type MobileModelControlSelection,
  type MobileModelFavoriteMutation,
  type MobileRuntimeControls
} from "./mobile-runtime-controls";
import {
  assertMobileContextCompact,
  resolveMobileContextControls,
  type MobileCompactOutcome,
  type MobileContextControls
} from "./mobile-context-controls";
import {
  assertMobileRuntimeCommandCandidate,
  createMobileRuntimeCommandControls,
  projectMobileRuntimeCommandCatalog,
  type MobileRuntimeCommandCatalog,
  type MobileRuntimeCommandCandidate,
  type MobileRuntimeCommandControls
} from "./mobile-runtime-commands";
import {
  assertMobileAppCommandInvocation,
  createMobileAppCommandControls,
  isMobileRemoteAppCommandInvocation,
  type MobileAppCommandControls,
  type MobileAppCommandInvocation,
  type MobileRemoteAppCommandInvocation
} from "./mobile-app-commands";
import type { MobileVoiceTransport } from "./mobile-voice-input";
import type { MobileVoiceDictionaryTransport } from "./mobile-voice-dictionary-service";
import { mobileReadOnlyDictionaryScope, type MobileReadOnlyDictionaryTransport } from "./mobile-voice-dictionary-readonly";
import type { MobileVoiceDictionaryReadOnlyCache } from "./mobile-voice-dictionary-readonly-cache";
import {
  assertMobileNativeTreeNavigation,
  projectMobileNativeTree,
  resolveMobileNativeTreeControls,
  type MobileNativeTreeControls,
  type MobileNativeTreeSnapshot
} from "./mobile-native-tree";
import {
  MOBILE_ANNOTATION_MAX_BURN_DIMENSION,
  canAnnotateMobileImage,
  encodeMobileBase64,
  mobileImageRequiresNativeRaster,
  mobileAnnotationOutputMediaType,
  normalizeMobileAnnotationStrokes,
  sniffMobileImageMediaType,
  type MobileImageAnnotationStroke
} from "./mobile-image-annotation";
import {
  mobileAnnotatedImageFileName,
  mobileRasterizedImageFileName,
  type MobileBurnedImage,
  type MobileComposerImageCommitResult,
  type MobileComposerImageEditorRequest,
  type MobileComposerImageEditorSession
} from "./mobile-composer-image-editor";
import {
  assertMobileImageGalleryDimensions,
  confirmMobileImageGalleryCanvas,
  inspectMobileImageGalleryBytes,
  mobileImageGalleryDimensionsMatch,
  mobileImageGalleryMediaType,
  mobileImageGalleryNativeAnimationMatches,
  mobileImageGalleryPreviewUri,
  mobileImageGalleryPage,
  mobileImageGalleryPageSummary,
  mobileQueueGalleryPages,
  mobileTimelineGalleryPages,
  mobileTimelineGalleryWindowKey,
  sameMobileImageGalleryPage,
  type MobileImageGalleryDecodedImage,
  type MobileImageGalleryDescriptor,
  type MobileImageGalleryNativeDecode,
  type MobileImageGalleryPage,
  type MobileImageGalleryPageSession
} from "./mobile-image-gallery";
import type { MobileImageOutputSource } from "./mobile-image-output";
import { timelineRows } from "./timeline";
import {
  mobileMessageShareable, projectMobileConversationShareMessage,
  type MobileConversationShareSnapshot, type MobileConversationShareImage
} from "./mobile-conversation-share";
import {
  inspectMobileImageOutputBytes,
  mobileImageOutputExtension,
  mobileImageOutputMediaType
} from "./mobile-image-output-format";
import {
  isMobileTimelinePreviewArtifact,
  mobileTimelineArtifactWindowKey,
  mobileTimelinePreviewWindowKey,
  resolveMobileTimelineArtifact,
  resolveMobileTimelinePreviewArtifact,
  sameMobileTimelineArtifact,
  sameMobileTimelinePreviewArtifact,
  type MobileTimelineArtifact,
  type MobileTimelinePreviewArtifact
} from "./mobile-timeline-artifacts";
import type { MobileFileShare, MobileFileShareProgress } from "./mobile-file-share";
import type { MobileOfflineCache, MobileOfflineCacheSnapshot } from "./mobile-offline-cache";
import { retainMobileHistoryPrefix } from "./mobile-history-continuity";
import { SnapshotSchema } from "@joko/contracts";
import { mobileProviderUsageIdentity, mobileProviderUsageSupported, type MobileProviderUsageTransport } from "./mobile-account-usage";
import {
  canRestartMobileAutomationRun,
  emptyMobileAutomationsState,
  isMobileAutomationRunTerminal,
  isMobileAutomationRunUnread,
  projectMobileAutomationCatalog,
  projectMobileAutomationHistory,
  projectMobileAutomationSchedule,
  projectMobileSchedulerRuntime,
  type MobileAutomationFilter,
  type MobileAutomationRun,
  type MobileAutomationSchedule,
  type MobileAutomationsState
} from "./mobile-automation";
import {
  buildMobileAutomationScheduleInput,
  mobileAutomationDispositionProto,
  mobileAutomationScheduleRevisionKey,
  mobileAutomationTargetOptions,
  projectMobileAutomationDeletionResult,
  type MobileAutomationDeletionOutcome,
  type MobileAutomationDeletionPreview,
  type MobileAutomationDisposition,
  type MobileAutomationDraft,
  type MobileAutomationWorktreeProof
} from "./mobile-automation-authoring";

export type { MobileStorage, PendingOperation } from "./connection-storage";

export interface MobileTaskCloneControls {
  readonly authorityKey: string;
  readonly surfaceOwnerKey: string;
  readonly sourceSessionId: string;
  readonly sourceName: string;
  readonly canClone: boolean;
}

export type MobileTaskCloneResult = { readonly kind: "cloned"; readonly sessionId: string }
  | { readonly kind: "unknown" | "rejected" | "retired" };

export interface MobileMessageForkControls extends Omit<MobileTaskCloneControls, "canClone"> {
  readonly canFork: boolean;
  readonly source: MobileMessageForkSource;
}
export type MobileMessageForkResult = { readonly kind: "forked"; readonly sessionId: string; readonly draftRestored: boolean }
  | { readonly kind: "unknown" | "rejected" | "retired" };

export type SavedCredentialState = "unknown" | "checking" | "available" | "missing" | "unreadable" | "unavailable" | "identity-conflict" | "offline";

export interface SavedMobileConnection extends MobileConnectionProfile {
  readonly automatic: boolean;
  readonly credentialState: SavedCredentialState;
  readonly pendingOperations: readonly PendingOperation[];
  readonly error?: string;
}

export interface NearbyMobileNode extends DiscoveredNodeRecord {
  readonly health: number;
}

export interface MobileState {
  readonly connectionEntries?: { readonly profileId: string; readonly entries: readonly import('@joko/connection-transport/entries').ConnectionEntryView[]; readonly returnToPreferred: boolean; readonly notice?: string };
  readonly status: "starting" | "unpaired" | "connecting" | "connected" | "offline" | "revoked";
  readonly busy: boolean;
  readonly node?: NodeIdentity;
  readonly origin?: string;
  readonly saved: readonly SavedMobileConnection[];
  readonly automaticProfileId?: string;
  readonly activeProfileId?: string;
  readonly connectionMode: "nearby" | "saved" | "add";
  readonly candidate?: { readonly origin: string; readonly node: NodeIdentity };
  readonly connectionAttemptError?: string;
  readonly discoveryState: "idle" | "refreshing" | "ready" | "error";
  readonly nearby: readonly NearbyMobileNode[];
  readonly discoveryError?: string;
  readonly challenge?: { readonly id: string; readonly origin: string; readonly deviceName: string; readonly endpointPublicKey?: string; readonly transportKind?: import('@joko/connection-transport/trust').EndpointTransportKind };
  readonly owner?: Snapshot;
  readonly selectedId?: string;
  readonly taskSource?: MobileTaskSource;
  readonly detail?: Snapshot;
  readonly older: readonly Event[];
  readonly window?: readonly Event[];
  readonly live: readonly Event[];
  readonly liveStatus: "paused" | "verifying" | "streaming" | "polling";
  readonly historyBusy: boolean;
  readonly historyEnd: boolean;
  readonly before?: EventCursor;
  readonly pending: readonly PendingOperation[];
  readonly taskOutbox?: readonly MobileTaskOutboxRecord[];
  readonly restoredComposerDraft?: { readonly profileId: string; readonly sessionId: string; readonly sequence: number };
  readonly homeSearchQuery: string;
  readonly homeSearchFilter: MobileHomeStatusFilter;
  readonly homeSearchStatus: "idle" | "searching" | "ready" | "error";
  readonly homeSearchSessionIds: readonly string[];
  readonly homeSearchError?: string;
  readonly timelinePreview?: MobileFilePreview;
  readonly files: MobileFilesState;
  readonly automations: MobileAutomationsState;
  readonly partnerPrivate: MobilePartnerPrivateState;
  readonly offlineSnapshotAt?: number;
  readonly error?: string;
}

export interface MobileTaskSendObserver {
  /** Caller-owned durable Operation identity, allocated before dispatch. */
  readonly operationId?: string;
  readonly deliveryMode?: QueueDeliveryMode;
  /** Presentation of the original input, before any disk/upload wait. */
  readonly onProgress?: (progress: import("./mobile-pending-send").MobilePendingSendProgress) => void;
  readonly confirmRebalance?: (suggestion: ProviderGroupRebalanceSuggestion, signal: AbortSignal) => Promise<"keep" | "cancel" | { readonly remember: boolean }>;
  /** Presentation-only notification after validation/upload and immediately before durable submit. */
  readonly onDispatch?: (draft: MobileComposerDraft) => void;
}

export interface MobileNewTaskUploadObserver {
  readonly optimisticConversation?: boolean;
  readonly signal: AbortSignal;
  readonly waitForLeaveDecision: () => Promise<boolean>;
  readonly onUploadingChange: (uploading: boolean) => void;
}

export interface MobilePushAuthority {
  readonly key: string;
  readonly profileId: string;
  readonly origin: string;
  readonly serverId: string;
  readonly connectionId: string;
  readonly deviceId: string;
  readonly deviceRevision: bigint;
}

export interface MobilePushLifecycleScope {
  readonly ready: boolean;
  readonly activeProfileId?: string;
}

interface MobileFilesContext {
  readonly credential: PairedCredential;
  readonly authority: MobileWorkspaceAuthority;
  readonly key: string;
}
interface MobileFilesPreviewPagerLease {
  readonly context: MobileFilesContext; readonly epoch: number; readonly controller: AbortController;
  readonly window: { readonly kind: "workspace"; readonly parent: string; readonly revision: string } | { readonly kind: "generated"; readonly revision: string };
  descriptor: MobileFilesPreviewPager;
  original?: WorkspaceEntry;
}

interface MobileWorkspaceModelObservation {
  readonly revisionKey: string;
  readonly mediaType: string;
}

interface MobileComposerImageEditLease {
  readonly leaseId: string;
  readonly request: MobileComposerImageEditorRequest;
  readonly profileId: string;
  readonly credentialKey: string;
  readonly surfaceOwnerKey: string;
  readonly attachment: MobileComposerAttachment;
  readonly source: MobileComposerImageAnnotationSource;
  readonly sourceBytes: Uint8Array;
  readonly sourceUri: string;
  readonly sourceStored: boolean;
  commitInFlight: boolean;
  readonly owner:
    | {
        readonly kind: "task";
        readonly authorityKey: string;
        readonly identity: MobileComposerDraftIdentity;
        readonly snapshot: MobileComposerDraftSnapshot;
        readonly draft: MobileComposerDraft;
      }
    | {
        readonly kind: "new-task";
        readonly identity: MobileNewTaskDraftIdentity;
        readonly snapshot: MobileNewTaskDraftSnapshot;
        readonly draft: MobileNewTaskDraft;
      };
}

interface MobileImageGalleryLease {
  readonly cachedOnly?: true;
  previewLeaseIds?: Set<string>;
  readonly leaseId: string;
  readonly profileId: string;
  readonly credentialKey: string;
  readonly taskAuthorityKey: string;
  readonly attachmentOwnerKey?: string;
  readonly identity: MobileComposerDraftIdentity;
  readonly snapshot: MobileComposerDraftSnapshot;
  readonly draft: MobileComposerDraft;
  readonly descriptor: MobileImageGalleryDescriptor;
  readonly pages: readonly MobileImageGalleryPage[];
  readonly source:
    | {
        readonly kind: "files";
        readonly filesEpoch: number;
        readonly filesAuthorityKey: string;
        readonly filesWindowKey: string;
      }
    | {
        readonly kind: "timeline";
        readonly eventId: string;
        readonly pageId: string;
        readonly windowKey: string;
      }
    | {
        readonly kind: "markdown";
        readonly resourceLeaseId: string;
      }
    | {
        readonly kind: "queue";
        readonly queueItemId: string;
      };
  loaded?: {
    readonly loadId: string;
    readonly page: MobileImageGalleryPage;
    readonly pageIndex: number;
    readonly bytes: Uint8Array;
    decoded: MobileImageGalleryDecodedImage;
    confirmed: boolean;
  };
  operationInFlight: boolean;
  shareController?: AbortController;
}

interface MobileTimelinePreviewLease {
  readonly controller: AbortController;
  readonly profileId: string;
  readonly sessionId: string;
  readonly taskAuthorityKey: string;
  readonly windowKey: string;
  readonly artifact?: MobileTimelinePreviewArtifact;
  readonly extensionCard?: { readonly id: string; readonly html: string; readonly uri: string };
  media?: MobileMediaPreviewLease;
  pdf?: MobilePdfPreviewLease;
  model?: MobileModelPreviewLease;
}

type MobileFileShareLease = {
  readonly controller: AbortController;
  readonly profileId: string;
  readonly sessionId: string;
  readonly taskAuthorityKey: string;
  phase: "preparing" | "dispatching";
} & ({
  readonly kind: "files";
  readonly filesEpoch: number;
  readonly filesAuthorityKey: string;
  readonly source: MobileFilesComposerSource;
} | {
  readonly kind: "timeline";
  readonly windowKey: string;
  readonly artifact: MobileTimelineArtifact;
});

export interface MobileQueueEditLease {
  readonly connectionId: string;
  readonly sessionId: string;
  readonly queueItemId: string;
  readonly lockToken: string;
  readonly authorityKey: string;
  readonly text: string;
  readonly replacesStructuredInput: boolean;
}

interface MobileQueueInteractionLease {
  readonly credential: PairedCredential;
  readonly sessionId: string;
  readonly lockToken: string;
  readonly authorityKey: string;
}

interface MobileConversationShareLease {
  readonly leaseId: string;
  readonly ownerKey: string;
  readonly credential: PairedCredential;
  readonly sessionId: string;
  readonly rowEvents: ReadonlyMap<string, string>;
  readonly sources: ReadonlyMap<string, string>;
  readonly markdownResources: string[];
}

type TrackedMutationResult =
  | { readonly accepted: true; readonly definitive: boolean; readonly operation?: Operation }
  | { readonly accepted: false; readonly definitive: boolean; readonly operation?: Operation };

export interface MobileNewTaskResult {
  readonly sessionId?: string;
  readonly created: boolean;
  readonly sent: boolean;
  readonly definitive: boolean;
}

export type MobileAppCommandOutcome =
  | { readonly kind: "help"; readonly status: "succeeded" }
  | { readonly kind: "jumpSession"; readonly status: "succeeded"; readonly sessionId: string }
  | { readonly kind: "userShell" | "sessionReset"; readonly status: "succeeded" | "rejected" | "unknown" }
  | { readonly kind: "review"; readonly status: "succeeded" | "rejected" | "unknown"; readonly reviewRunId?: string };

const isTerminal = (state: OperationState): boolean => [
  OperationState.SUCCEEDED, OperationState.FAILED, OperationState.CANCELLED, OperationState.CONFLICT
].includes(state);

type MobileExtensionReceiptKind = Extract<PendingOperation["kind"],
  | "extension-enabled"
  | "extension-sidebar"
  | "extension-package-adopt"
  | "extension-package-remove"
  | "extension-settings-routing"
  | "extension-settings-credential-clear"
  | "extension-settings-directory"
  | "extension-setup-begin"
  | "extension-setup-interaction"
  | "extension-setup-credential"
  | "extension-setup-complete"
  | "extension-setup-cancel"
  | "extension-setup-revoke">;

function isMobileExtensionReceiptKind(kind: PendingOperation["kind"]): kind is MobileExtensionReceiptKind {
  return kind === "extension-enabled" || kind === "extension-sidebar"
    || kind === "extension-package-adopt" || kind === "extension-package-remove"
    || kind === "extension-settings-routing" || kind === "extension-settings-credential-clear" || kind === "extension-settings-directory"
    || kind === "extension-setup-begin" || kind === "extension-setup-interaction"
    || kind === "extension-setup-credential" || kind === "extension-setup-complete"
    || kind === "extension-setup-cancel" || kind === "extension-setup-revoke";
}

function mobileExtensionPendingMutationKind(kind: MobileExtensionReceiptKind): MobileExtensionPendingMutationKind {
  switch (kind) {
    case "extension-enabled": return "enabled";
    case "extension-sidebar": return "sidebar";
    case "extension-package-adopt": return "packageAdopt";
    case "extension-package-remove": return "packageRemove";
    case "extension-settings-routing": return "settingsRouting";
    case "extension-settings-credential-clear": return "settingsCredentialClear";
    case "extension-settings-directory": return "settingsDirectory";
    case "extension-setup-begin": return "setupBegin";
    case "extension-setup-interaction": return "setupInteraction";
    case "extension-setup-credential": return "setupCredential";
    case "extension-setup-complete": return "setupComplete";
    case "extension-setup-cancel": return "setupCancel";
    case "extension-setup-revoke": return "setupRevoke";
  }
}

function trackedOperation(operation: Operation): TrackedMutationResult {
  const rejected = operation.state === OperationState.FAILED
    || operation.state === OperationState.CONFLICT
    || operation.state === OperationState.CANCELLED;
  return rejected
    ? { accepted: false, definitive: true, operation }
    : { accepted: true, definitive: isTerminal(operation.state), operation };
}

function entityVersionKey(version: {
  readonly generation: bigint;
  readonly revision?: { readonly value: bigint; readonly etag: string };
} | undefined): string {
  return [
    version?.generation.toString(10) ?? "",
    version?.revision?.value.toString(10) ?? "",
    version?.revision?.etag ?? ""
  ].join("\u001e");
}

function automationCatalogAuthorityKey(schedules: readonly Schedule[]): string {
  return schedules.map((schedule) => [
    schedule.scheduleId,
    entityVersionKey(schedule.version),
    String(schedule.state),
    String(schedule.unreadRunCount),
    schedule.recentRuns.map((run) => [
      run.triggerId,
      run.runId,
      String(run.outcome),
      run.readAt === undefined ? "" : `${run.readAt.seconds.toString(10)}:${run.readAt.nanos}`
    ].join("\u001d")).sort().join("\u001c")
  ].join("\u001e")).sort().join("\u001f");
}

function backendAuthorityKey(backend: BackendDescriptor): string {
  return [
    backend.backendId,
    backend.version,
    entityVersionKey(backend.entityVersion),
    backend.capabilities?.schemaVersion ?? "",
    backend.capabilities?.revision?.value.toString(10) ?? "",
    backend.capabilities?.revision?.etag ?? ""
  ].join("\u001e");
}

const textOnlyIncomingSharePolicy: MobileAttachmentControls["policy"] = {
  images: false,
  files: false,
  maximumItems: 0,
  maximumBytes: 0,
  imageMediaTypes: [],
  fileMediaTypes: []
};

function confirmedMobileDeviceName(operation: Operation, deviceId: string, connectionId: string): Device {
  const confirmed = operation.result?.payload.case === "device" ? operation.result.payload.value : undefined;
  if (operation.state !== OperationState.SUCCEEDED || !confirmed || confirmed.deviceId !== deviceId
    || confirmed.kind !== DeviceKind.MOBILE || confirmed.revoked || !confirmed.connectionIds.includes(connectionId)
    || (confirmed.version?.revision?.value ?? 0n) < 1n || !validMobileDeviceName(confirmed.defaultDisplayName)
    || (confirmed.manualDisplayName !== undefined && !validMobileDeviceName(confirmed.manualDisplayName))
    || confirmed.displayName !== (confirmed.manualDisplayName ?? confirmed.defaultDisplayName)) {
    throw new Error("The Joko node completed the device name change without the expected Device result.");
  }
  return confirmed;
}

import { DeviceAuthorizationReceiver, parseDeviceInvitation, bindDeviceInvitationTransport, type DeviceAuthorizationPort, type DeviceAuthorizationOwner } from '@joko/connection-transport/device-authorization';

export class MobileClient {
  #entryAttempt?: AbortController;
  #entryLastSwitch = 0;
  #entryStableSince = 0;
  #entryRefreshAt = 0;
  #entriesBusy = false;
  #entryChanges: Promise<unknown> = Promise.resolve();
  #changeEntries<T>(action: () => Promise<T>): Promise<T> {
    const result = this.#entryChanges.then(action, action); this.#entryChanges = result.catch(() => undefined); return result;
  }
  connectionEntrySupported: (kind: import('@joko/connection-transport/trust').EndpointTransportKind) => boolean = kind => kind === 'https';
  connectionEntryIrohMode: 'native' | 'relay' = 'relay';
  #authorizationReceiverValue?: DeviceAuthorizationReceiver;
  #authorizationReceiver(): DeviceAuthorizationReceiver {
    if (!this.storage.readDeviceAuthorization || !this.storage.writeDeviceAuthorization || !this.network.deviceAuthorizationTransport) throw new Error('Device approval is unavailable in this build.');
    return this.#authorizationReceiverValue ??= new DeviceAuthorizationReceiver({ read: () => this.storage.readDeviceAuthorization!(), write: draft => this.storage.writeDeviceAuthorization!(draft),
      readTransportRequest: () => this.storage.readDeviceTransportRequest!(), writeTransportRequest: draft => this.storage.writeDeviceTransportRequest!(draft) },
      { uuid: this.newId, secret: () => bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(32))),
        digest: async value => bytesToHex(sha256(new TextEncoder().encode(value))) }, invitation => this.network.deviceAuthorizationTransport!(invitation));
  }
  deviceAuthorizationOwner(): DeviceAuthorizationOwner {
    const credential = this.#ready(), abort = this.#abort;
    if (!this.network.deviceAuthorizationOwner) throw new Error('Device approval is unavailable in this build.');
    return this.network.deviceAuthorizationOwner(credential, () => {
      if (this.#credential !== credential || this.#abort !== abort || this.#disposed) throw new Error('The original node connection changed.');
      abort?.signal.throwIfAborted();
    });
  }
  serverAccess(): import('@joko/connection-transport/server-access').ServerAccessClient {
    const credential = this.#ready(), abort = this.#abort;
    if (!this.network.serverAccess) throw new Error('Server access management is unavailable in this build.');
    return this.network.serverAccess(credential, () => {
      if (this.#credential !== credential || this.#abort !== abort || this.#disposed) throw new Error('The original node connection changed.');
      abort?.signal.throwIfAborted();
    });
  }
  get deviceAuthorization(): DeviceAuthorizationPort {
    return {
      transportRequest: (kind, signal) => this.#authorizationReceiver().transportRequest(kind, signal, this.connectionEntryIrohMode),
      pendingTransportRequest: signal => this.#authorizationReceiver().pendingTransportRequest(signal),
      cancelTransportRequest: (requestId, signal) => this.#authorizationReceiver().cancelTransportRequest(requestId, signal),
      resolveTarget: (link, code, signal) => this.#authorizationReceiver().resolveTarget(link, code, signal),
      entries: async (link, signal) => (await this.#authorizationReceiver().entries(link, signal)).filter(entry => this.connectionEntrySupported(entry.kind)),
      start: (link, name, signal, entryId) => {
        const invitation = parseDeviceInvitation(link);
        if (this.#profiles.some(profile => (profile.origin === invitation.origin || profile.serverId === invitation.serverId)
          && profile.endpointPublicKey !== undefined && profile.endpointPublicKey !== invitation.endpointPublicKey)) throw new Error('The invitation conflicts with a saved node identity.');
        return this.#authorizationReceiver().start(link, name, DeviceKind.MOBILE, this.platform, signal, entryId);
      },
      refresh: signal => this.#authorizationReceiver().refresh(signal),
      cancel: signal => this.#authorizationReceiver().cancel(signal),
      discard: allowUnconfirmed => this.#authorizationReceiver().discard(allowUnconfirmed),
      finish: async (signal, automatic) => {
        const { generation, controller } = this.#beginConnectionAttempt();
        const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
        try {
          const { draft, authorization } = await this.#authorizationReceiver().claim(combined);
          if (!this.#connectionAttemptCurrent(generation, controller)) return;
          const connection = authorization.connection!;
          const credential: PairedCredential = { profileId: connection.connectionProfileId, connectionId: connection.connectionId,
            deviceId: connection.deviceId, origin: draft.invitation.origin, serverId: draft.invitation.serverId,
            endpointPublicKey: draft.invitation.endpointPublicKey, transportKind: draft.endpointTransport?.kind ?? 'https', displayName: connection.displayName, authKey: draft.authKey };
          const node = await this.network.inspect(credential.origin, combined);
          const owner = await this.network.readOwner(credential, this.deviceNameSource(), combined);
          this.#assertOwner(credential, owner, node);
          if (!this.#connectionAttemptCurrent(generation, controller)) return;
          combined.throwIfAborted();
          await this.storage.saveConnection(credential);
          if (!this.#connectionAttemptCurrent(generation, controller)) return;
          combined.throwIfAborted();
          this.#profiles = upsertProfile(this.#profiles, profileFromCredential(credential));
          if (automatic !== undefined) {
            await this.storage.saveAutomaticProfile(automatic ? credential.profileId : undefined);
            if (!this.#connectionAttemptCurrent(generation, controller)) return;
            combined.throwIfAborted();
            this.#automaticProfileId = automatic ? credential.profileId : undefined;
          }
          if (draft.entryId) {
            if (!this.storage.readConnectionEntries || !this.storage.writeConnectionEntries) throw new Error('Protected entrance storage is unavailable.');
            const api = await import('@joko/connection-transport/entries'), profile = profileFromCredential(credential);
            const entryOwner = { profileId: profile.profileId, deviceId: profile.deviceId, serverId: profile.serverId, endpointPublicKey: profile.endpointPublicKey! };
            const saved = await this.storage.readConnectionEntries(profile) ?? api.initialConnectionEntries(entryOwner, profile);
            const active = api.activeConnectionEntry(saved, profile);
            if (!active) throw new Error('The invitation entrance is unavailable.');
            const selected = await api.prepareSelectedConnectionEntry(entryOwner, saved, draft.entryId, active, credential.authKey,
              { read: () => this.storage.readConnectionEntries!(profile), write: async value => { combined.throwIfAborted(); await this.storage.writeConnectionEntries!(profile, value); } },
              this.connectionEntrySupported, combined, { uuid: this.newId, irohMode: this.connectionEntryIrohMode });
            await this.connectSaved(profile.profileId, automatic, selected.entryId);
          } else await this.#adoptConnection(generation, controller, credential, node, owner);
          if (this.#credential?.connectionId === credential.connectionId) await this.#authorizationReceiver().clear(draft.requestId);
        } catch (error) { this.#failConnectionAttempt(generation, controller, message(error)); throw error; }
      }
    };
  }
  #state: MobileState = { status: "starting", busy: false, saved: [], connectionMode: "nearby",
    discoveryState: "idle", nearby: [], older: [], live: [], liveStatus: "paused",
    historyBusy: false, historyEnd: false, pending: [], homeSearchQuery: "", homeSearchFilter: "active",
    homeSearchStatus: "idle", homeSearchSessionIds: [], files: emptyMobileFilesState(),
    automations: emptyMobileAutomationsState(), partnerPrivate: emptyMobilePartnerPrivateState() };
  #credentialValue?: PairedCredential;
  #stopEndpointTrustWatch = () => {};
  get #credential(): PairedCredential | undefined { return this.#credentialValue; }
  set #credential(value: PairedCredential | undefined) {
    this.#stopEndpointTrustWatch();
    this.#credentialValue = value;
    this.#stopEndpointTrustWatch = value === undefined ? () => {} : observeEndpointTrustFailure(value, error => {
      if (!this.#disposed && this.#credential === value) void this.#identityConflict(this.#epoch, value.profileId, error.message);
    });
  }
  #joinedTask?: { readonly source: MobileJoinedTaskSource; readonly credential: PairedCredential;
    readonly api: TaskSharingApi; readonly network: MobileNetwork; readonly lifetime: AbortController };
  private get network(): MobileNetwork { return this.#joinedTask?.network ?? this.ownerNetwork; }
  #profiles: MobileConnectionProfile[] = [];
  #automaticProfileId?: string;
  #activeProfileId?: string;
  #allPending: PendingOperation[] = [];
  #listeners = new Set<(state: MobileState) => void>();
  #epoch = 0;
  #abort?: AbortController;
  #timer?: ReturnType<typeof setTimeout>;
  #proofTimer?: ReturnType<typeof setTimeout>;
  #projectionTimer?: ReturnType<typeof setTimeout>;
  #streamAbort?: AbortController;
  #historyOwner?: symbol;
  #projectionReading = false;
  #projectionMisses = 0;
  #streamSequence?: bigint;
  #streamGeneration?: bigint;
  #foreground = true;
  #extensionOAuthRetention?: { readonly transport: MobileExtensionTransport; readonly current: () => boolean };
  #providerRebalanceConfirmation?: { readonly sourceKey: string };
  #partnerRosterEpoch = 0;
  #partnerRosterNavigation?: { readonly sourceKey: string; readonly profileId: string; readonly sessionId: string; readonly partnerId: string; readonly homeTargetId: string };
  #partnerProfileSave?: { readonly action: symbol; readonly epoch: number; readonly credential: PairedCredential;
    readonly directoryKey: string; readonly presentationKey: string; readonly sessionId: string; readonly targetId: string;
    readonly backendId: string; readonly backendKey: string;
    readonly ownerKey: string; readonly transport: MobilePartnerProfileTransport; readonly partner: MobilePartnerDirectoryProfile;
    refreshPending?: boolean };
  #partnerProfileContinuation?: { readonly epoch: number; readonly credential: PairedCredential; readonly directoryKey: string;
    readonly ownerKey: string; readonly sessionId: string; readonly targetId: string; readonly backendId: string;
    readonly runtimeGeneration: bigint; readonly partner: MobilePartnerDirectoryProfile; readonly transport: MobilePartnerProfileTransport };
  #remoteDesktopPresentationTransition?: {
    isCurrent(): boolean;
    close(): void;
    matches(host: Parameters<MobileRemoteDesktopTransport["capabilities"]>[0], leaseId: string): boolean;
  };
  #disposed = false;
  #lastAuthenticatedAt?: number;
  #durableSnapshotAt?: number;
  #mutationOwner?: symbol;
  #userShellFlight?: { readonly owner: symbol; readonly sessionId: string };
  #pendingWrite: Promise<void> = Promise.resolve();
  #catalogEpoch = 0;
  #catalogAbort?: AbortController;
  #connectionAttemptEpoch = 0;
  #connectionAttemptAbort?: AbortController;
  #discoveryExpiryTimer?: ReturnType<typeof setTimeout>;
  #homeSearchEpoch = 0;
  #homeSearchAbort?: AbortController;
  #filesEpoch = 0;
  #filesCopyEpoch = 0;
  #filesListAbort?: AbortController;
  #filesSearchAbort?: AbortController;
  #filesPreviewAbort?: AbortController;
  #filesPreviewPager?: MobileFilesPreviewPagerLease;
  #filesPagerOpeningAbort?: AbortController;
  #filesPagerNavigationAbort?: AbortController;
  #filesPagerReadActive = false;
  #filesPagerReadWaiting?: { grant(): void; cancel(): void };
  #filesMediaPreview?: MobileMediaPreviewLease;
  #filesPdfPreview?: MobilePdfPreviewLease;
  #filesModelPreview?: MobileModelPreviewLease;
  #timelinePreview?: MobileTimelinePreviewLease;
  #fileShareLease?: MobileFileShareLease;
  #filesWatchAbort?: AbortController;
  #filesRefreshTimer?: ReturnType<typeof setTimeout>;
  #queueEditLease?: MobileQueueEditLease;
  #queueInteractionLease?: MobileQueueInteractionLease;
  #newTaskSubmissionActive = false;
  readonly #taskOutbox?: MobileTaskOutboxStore;
  #taskOutboxFlight?: Promise<void>;
  #newTaskUploadObserver?: MobileNewTaskUploadObserver;
  #composerImageEdit?: MobileComposerImageEditLease;
  #imageGallery?: MobileImageGalleryLease;
  #conversationShare?: MobileConversationShareLease;
  #markdownResources = new MobileMarkdownResourceReader();
  #fileHtmlResources = new MobileFileHtmlReader();
  #timelineImages = new MobileTimelineImageReader();
  #galleryBlobRead: ReturnType<MobileNetwork["downloadBlob"]> | undefined;
  #filesThumbnails: MobileFilesThumbnailReader;
  #messageRewindPreviews = new WeakSet<MobileMessageRewindPreview>();
  #automationEpoch = 0;
  #automationAbort?: AbortController;
  #automationHistoryAbort?: AbortController;
  #automationHistoryPageTokens = new Set<string>();
  #partnerPrivateEpoch = 0;
  #partnerTaskOutputShellCredential?: PairedCredential;
  #partnerTaskOutputShellOccurrence = 0;
  #partnerTaskOutputOpenFlight?: symbol;
  #partnerGroupAttachments?: import("./mobile-partner-groups").MobileGroupAttachmentTransport;
  #partnerGroupSelections = new WeakMap<MobilePartnerGroupSelection, PairedCredential>();
  #partnerPrivateAbort?: AbortController;
  #partnerPrivateReadAbort?: AbortController;
  #partnerPrivateReadFlight?: Promise<void>;
  #partnerPrivateReadTarget?: number;
  #partnerPrivateDetailLease?: symbol;
  #partnerPrivateRefreshTimer?: ReturnType<typeof setTimeout>;
  #partnerPrivateSourceSessionId?: string;
  #partnerPrivateSourceTargetId?: string;
  #partnerCreationFlight?: { readonly ownerKey: string; readonly token: symbol };
  #newTaskModelMemory?: MobileNewTaskModelMemory;
  #runtimeModelSelection?: { readonly ownerKey: string; readonly control: TaskShareRuntimeControl };
  #partnerCreationKnown?: { readonly ownerKey: string; readonly requestId: string };
  #partnerPrivateResume?: {
    readonly credentialKey: string;
    readonly selectedPartnerId?: string;
    readonly selectedThreadId?: string;
    readonly sourceSessionId?: string;
    readonly sourceTargetId?: string;
  };

  constructor(
    private readonly ownerNetwork: MobileNetwork,
    private readonly storage: MobileStorage,
    private readonly discovery: MobileDiscovery,
    private readonly newId: () => string,
    private readonly platform: string,
    private readonly now: () => number = Date.now,
    private readonly clearInteractionDraft?: (identity: MobileInteractionDraftIdentity) => Promise<void>,
    private readonly newTaskDrafts?: MobileNewTaskDraftStore,
    private readonly composerDrafts?: MobileComposerDraftStore,
    private readonly attachmentFiles?: MobileAttachmentFiles,
    private readonly mediaPreviewFiles?: MobileMediaPreviewFiles,
    private readonly pdfPreviewFiles?: MobilePdfPreviewFiles,
    private readonly modelPreviewFiles?: MobileModelPreviewFiles,
    private readonly fileShare?: Pick<MobileFileShare, "perform">,
    private readonly offlineCache?: Pick<MobileOfflineCache, "load" | "save" | "clear">,
    private readonly readOnlyDictionaryCache?: Pick<MobileVoiceDictionaryReadOnlyCache, "clear">,
    filesThumbnailDisk?: Pick<MobileFilesThumbnailCache, "get" | "put" | "remove">,
    private readonly deviceNameSource: MobileDeviceNameSourceProvider = () => mobileDeviceNameSource(undefined, platform),
    private readonly partnerCreationReceipts?: MobilePartnerCreationReceipts,
    private readonly partnerDeletionReceipts?: MobilePartnerDeletionReceipts,
    private readonly partnerRestartReceipts?: MobilePartnerRestartReceipts
  ) {
    this.#filesThumbnails = new MobileFilesThumbnailReader(filesThumbnailDisk);
    if (composerDrafts) this.#taskOutbox = new MobileTaskOutboxStore(composerDrafts.driver);
  }

  get state(): MobileState { return this.#state; }

  partnerCreationTransport(): MobilePartnerCreationTransport | undefined {
    const context = this.#partnerPrivateContext();
    const directory = this.partnerDirectoryTransport();
    const receipts = this.partnerCreationReceipts;
    if (!context || !directory || !receipts || !this.network.getPartnerCreationOptions || !this.network.createPartner
      || !this.network.getPartnerCreation || !this.network.retirePartnerCreation) return undefined;
    const ownerKey = context.authorityKey;
    const requireCurrent = (signal: AbortSignal): void => {
      signal.throwIfAborted();
      if (this.#partnerPrivateAuthorityKey(this.#state) !== ownerKey || this.#credential !== context.credential) {
        throw new Error("The Partner creation owner changed.");
      }
    };
    const pending = async (signal: AbortSignal): Promise<string | undefined> => {
      requireCurrent(signal);
      const stored = await receipts.load(context.credential, signal);
      requireCurrent(signal);
      if (stored) {
        this.#partnerCreationKnown = { ownerKey, requestId: stored };
        return stored;
      }
      return this.#partnerCreationKnown?.ownerKey === ownerKey ? this.#partnerCreationKnown.requestId : undefined;
    };
    const load: MobilePartnerCreationTransport["load"] = async (signal) => {
      requireCurrent(signal);
      const options = await this.network.getPartnerCreationOptions!(context.credential, signal);
      const catalog = await directory.list(signal);
      const observed = await this.network.readOwner(context.credential, this.deviceNameSource(), signal);
      requireCurrent(signal);
      this.#assertOwner(context.credential, observed, this.#state.node!);
      if (this.#partnerPrivateAuthorityKey({ ...this.#state, owner: observed.snapshot }) !== ownerKey
        || options.revision !== catalog.directory.revision) throw new Error("The Partner creation options changed. Refresh this form.");
      return { ownerKey, options, names: catalog.partners.map(({ partnerId, displayName }) => ({ partnerId, displayName })),
        backends: mobilePartnerCreationBackends(observed.snapshot) };
    };
    const action = async <T,>(signal: AbortSignal, perform: () => Promise<T>): Promise<T> => {
      requireCurrent(signal);
      if (this.#partnerCreationFlight?.ownerKey === ownerKey) throw new Error("A Partner creation action is already in flight.");
      const token = Symbol("partner-create"); this.#partnerCreationFlight = { ownerKey, token };
      try { return await perform(); }
      finally { if (this.#partnerCreationFlight?.token === token) this.#partnerCreationFlight = undefined; }
    };
    const resolve = async (requestId: string, result: MobilePartnerCreationResult, signal: AbortSignal): Promise<MobilePartnerCreationResult> => {
      requireCurrent(signal);
      if (result.kind !== "absent") {
        await receipts.resolve(context.credential, requestId, signal);
        requireCurrent(signal);
        if (this.#partnerCreationKnown?.ownerKey === ownerKey && this.#partnerCreationKnown.requestId === requestId) {
          this.#partnerCreationKnown = undefined;
        }
      }
      return result;
    };
    const requirePending = async (requestId: string, signal: AbortSignal): Promise<void> => {
      if (await pending(signal) !== requestId) throw new Error("Select the current retained Partner creation request.");
      requireCurrent(signal);
    };
    return { ownerKey, pending, load,
      create: (snapshot, draft, signal) => action(signal, async () => {
        if (snapshot.ownerKey !== ownerKey) throw new Error("The Partner creation draft belongs to another owner.");
        if (await pending(signal)) throw new Error("Check the retained Partner creation result before creating again.");
        const fresh = await load(signal);
        const previousFields = mobilePartnerCreationFields(snapshot, draft), freshFields = mobilePartnerCreationFields(fresh, draft);
        if (!previousFields || !freshFields || mobilePartnerDraftCatalogIdentity(freshFields) !== mobilePartnerDraftCatalogIdentity(previousFields)) {
          throw new Error("Refresh the Partner form before creating.");
        }
        const validated = validateMobilePartnerCreationDraft(fresh, draft);
        const frozen = { ...validated, avatar: typeof validated.avatar === "string" ? validated.avatar : { base64: validated.avatar.base64 },
          capabilities: { ...validated.capabilities, modelChain: validated.capabilities.modelChain.map((route) => ({ ...route })) } };
        const requestId = this.newId();
        await receipts.claim(context.credential, requestId, signal);
        requireCurrent(signal);
        this.#partnerCreationKnown = { ownerKey, requestId };
        try {
          const returned = await this.network.createPartner!(context.credential, requestId, fresh.options.revision, frozen, signal);
          requireCurrent(signal);
          const confirmed = await this.network.getPartnerCreation!(context.credential, requestId, signal);
          requireCurrent(signal);
          if (confirmed.kind === "absent" || confirmed.kind === "retired" || returned.kind === "found"
            && confirmed.kind === "found" && returned.partner.partnerId !== confirmed.partner.partnerId) {
            throw new Error("The created Partner could not be confirmed.");
          }
          return await resolve(requestId, confirmed, signal);
        } catch (error) {
          requireCurrent(signal);
          if (error instanceof MobilePartnerCreationRejected) await resolve(requestId, { kind: "retired" }, signal);
          throw error;
        }
      }),
      lookup: (requestId, signal) => action(signal, async () => {
        await requirePending(requestId, signal);
        const result = await this.network.getPartnerCreation!(context.credential, requestId, signal);
        requireCurrent(signal);
        return resolve(requestId, result, signal);
      }),
      retire: (requestId, signal) => action(signal, async () => {
        await requirePending(requestId, signal);
        const result = await this.network.retirePartnerCreation!(context.credential, requestId, signal);
        requireCurrent(signal);
        if (result.kind === "absent") throw new Error("The original Partner intent could not be retired.");
        return resolve(requestId, result, signal);
      }) };
  }

  partnerWorkingTransport(): MobilePartnerWorkingTransport | undefined {
    const context = this.#partnerPrivateContext();
    if (!context || !this.network.readPartnerWorkingStatus) return undefined;
    const ownerKey = context.authorityKey;
    const current = (): boolean => this.#partnerPrivateAuthorityKey(this.#state) === ownerKey && this.#credential === context.credential;
    return { ownerKey, read: async (partner, expected, locale, signal) => {
      const requireCurrent = (): void => {
        signal.throwIfAborted();
        if (!current() || partner.lifecycle !== "active" || partner.initializationState !== "ready"
          || partner.canonicalSessionId !== expected.sessionId || partner.homeTargetId !== expected.targetId
          ) throw new Error("The Partner working owner changed.");
        const snapshot = this.#state.detail?.sessions.some((session) => session.sessionId === expected.sessionId)
          ? this.#state.detail : this.#state.owner;
        const matches = snapshot?.sessions.filter((session) => session.sessionId === expected.sessionId) ?? [];
        const live = snapshot && matches.length === 1
          ? projectSessionWorkingStatus(matches[0]!, snapshot.runs, snapshot.interactions, []) : undefined;
        if (!live || workingStatusTurnKey(live) !== workingStatusTurnKey(expected)) throw new Error("The Partner working turn changed.");
      };
      requireCurrent();
      const text = await this.network.readPartnerWorkingStatus!(context.credential, partner.partnerId, expected, locale, signal);
      requireCurrent();
      return text;
    } };
  }

  partnerDirectoryObservation(): MobilePartnerDirectoryObservation | undefined {
    if (this.#state.status !== "connected" && this.#state.status !== "offline") return undefined;
    const ownerKey = this.#partnerPrivateAuthorityKey({ ...this.#state, status: "connected" });
    return ownerKey && this.#state.owner ? { ownerKey, online: this.#state.status === "connected", snapshot: this.#state.owner } : undefined;
  }

  partnerTaskOutputsShellIdentity(): string | undefined {
    if (!["connected", "offline", "connecting"].includes(this.#state.status)) return undefined;
    const ownerKey = this.#partnerPrivateAuthorityKey({ ...this.#state, status: "connected" });
    const owner = this.#state.owner;
    const credential = this.#credential;
    const sessionId = this.#state.selectedId;
    if (!ownerKey || !owner || !credential || !sessionId) return undefined;
    const sessions = owner.sessions.filter(session => session.sessionId === sessionId);
    const session = sessions.length === 1 ? sessions[0] : undefined;
    const generation = session?.nativeBinding?.runtimeGeneration;
    if (!session || !generation || generation < 1n) return undefined;
    if (this.#partnerTaskOutputShellCredential !== credential) {
      this.#partnerTaskOutputShellCredential = credential;
      this.#partnerTaskOutputShellOccurrence++;
    }
    return [ownerKey, this.#partnerTaskOutputShellOccurrence, sessionId, session.backendId,
      session.targetId, generation.toString(10)].join("\u001f");
  }

  partnerDirectoryTransport(): MobilePartnerDirectoryTransport | undefined {
    const context = this.#partnerPrivateContext();
    const listPartnerCatalog = this.network.listPartnerCatalog;
    if (!context || !listPartnerCatalog) return undefined;
    const ownerKey = context.authorityKey;
    const current = (): boolean => this.#partnerPrivateAuthorityKey(this.#state) === ownerKey
      && this.#credential === context.credential;
    const requireCurrent = (signal: AbortSignal): void => {
      signal.throwIfAborted();
      if (!current()) throw new Error("The Partner directory owner changed.");
    };
    const list = async (signal: AbortSignal): Promise<MobilePartnerCatalog> => {
      requireCurrent(signal);
      const catalog = await listPartnerCatalog.call(this.network, context.credential, signal);
      requireCurrent(signal);
      return catalog;
    };
    const exact = (catalog: MobilePartnerCatalog, selected: MobilePartnerDirectoryProfile): MobilePartnerDirectoryProfile => {
      const matches = catalog.partners.filter((partner) => partner.partnerId === selected.partnerId);
      if (matches.length !== 1 || mobilePartnerDirectoryIdentity(matches[0]!) !== mobilePartnerDirectoryIdentity(selected)) {
        throw new Error("The selected Partner changed; refresh the directory and try again.");
      }
      return matches[0]!;
    };
    return {
      ownerKey,
      list,
      open: async (selected, signal, allowPaused = false) => {
        const initial = exact(await list(signal), selected);
        const initialSessions = await this.network.listPartnerSessions(context.credential, initial.partnerId, signal);
        requireCurrent(signal);
        const sessionId = assertMobilePartnerDirectorySession(initial, initialSessions, allowPaused);
        const visible = this.#state.owner?.sessions.filter((session) => session.sessionId === sessionId) ?? [];
        if (visible.length !== 1 || visible[0]!.targetId !== initial.homeTargetId
          || visible[0]!.archived
          || visible[0]!.state === SessionState.ARCHIVED || visible[0]!.state === SessionState.CLOSED) {
          throw new Error("The Partner canonical task is not available in the current task directory.");
        }
        await this.select(sessionId);
        requireCurrent(signal);
        if (this.#state.selectedId !== sessionId) {
          throw new Error("The Partner canonical task was not selected by the current owner.");
        }
        const finalPartner = exact(await list(signal), initial);
        const finalSessions = await this.network.listPartnerSessions(context.credential, finalPartner.partnerId, signal);
        requireCurrent(signal);
        if (assertMobilePartnerDirectorySession(finalPartner, finalSessions, allowPaused) !== sessionId) {
          throw new Error("The Partner canonical task changed while it was opening.");
        }
        return { sessionId };
      }
    };
  }

  partnerRosterSources(): readonly MobilePartnerRosterSource[] {
    return this.#state.saved.filter(profile => !["missing", "unreadable", "identity-conflict"].includes(profile.credentialState))
      .map(profile => ({ profile, key: mobilePartnerRosterSourceKey(profile), current: profile.profileId === this.#activeProfileId }));
  }

  async readPartnerOfflineConversation(source: MobilePartnerRosterSource,
    row: import("./mobile-partner-roster").MobilePartnerRosterDisplay, signal: AbortSignal) {
    if (!this.offlineCache) throw new Error("Saved offline conversations are unavailable on this device.");
    const epoch = this.#partnerRosterEpoch;
    return readMobilePartnerOfflineConversation(this.offlineCache, source, row,
      () => !this.#disposed && this.#foreground && epoch === this.#partnerRosterEpoch
        && this.partnerRosterSources().some(candidate => candidate.key === source.key), signal);
  }

  /** A saved roster has its own authenticated owner; the active Session filter is unrelated. */
  async partnerRosterSourceTransport(profileId: string, signal: AbortSignal): Promise<MobilePartnerRosterSourceTransport> {
    const profile = this.#profiles.find(candidate => candidate.profileId === profileId);
    if (!profile || !this.network.listPartnerCatalog) throw new Error("The saved Partner source is no longer available.");
    const sourceKey = mobilePartnerRosterSourceKey(profile), epoch = this.#partnerRosterEpoch;
    let retired = false;
    const isCurrent = (): boolean => !retired && !signal.aborted && !this.#disposed && this.#foreground
      && epoch === this.#partnerRosterEpoch && this.partnerRosterSources().some(source => source.key === sourceKey);
    const assertCurrent = (): void => { signal.throwIfAborted(); if (!isCurrent()) throw new Error("The saved Partner source changed."); };
    const owned = async <T>(caller: AbortSignal, effect: (request: AbortSignal) => Promise<T>): Promise<T> => {
      const request = new AbortController(), cancel = (): void => request.abort();
      assertCurrent();
      if (caller.aborted) cancel(); else caller.addEventListener("abort", cancel, { once: true });
      signal.addEventListener("abort", cancel, { once: true });
      const unsubscribe = this.subscribe(() => { if (!isCurrent()) cancel(); });
      try { request.signal.throwIfAborted(); const result = await effect(request.signal); request.signal.throwIfAborted(); assertCurrent(); return result; }
      finally { request.abort(); unsubscribe(); caller.removeEventListener("abort", cancel); signal.removeEventListener("abort", cancel); }
    };
    const invalidate = async (error: unknown): Promise<void> => {
      if (!isCurrent() || !(error instanceof CredentialIdentityError) && !isEndpointTrustError(error) && !isRevoked(error)) return;
      if (this.#activeProfileId === profileId && this.#credential) {
        if (isRevoked(error)) await this.#invalidateCredential(this.#epoch, profileId, "The Partner source connection was revoked.");
        else await this.#identityConflict(this.#epoch, profileId, "The saved Partner source identity changed.");
      } else {
        const cleanup = await this.#clearOfflineCache(profileId);
        if (!isCurrent()) return;
        let credentialFailure: string | undefined;
        if (isRevoked(error)) { try { await this.storage.deleteCredential(profileId); } catch { credentialFailure = "The revoked Partner credential could not be cleared."; } }
        if (!isCurrent()) return;
        this.#set({ saved: this.#savedViews(profileId, isRevoked(error) ? "missing" : "identity-conflict",
          ["The saved Partner source must be paired again.", cleanup, credentialFailure].filter(Boolean).join(" ")) });
      }
      retired = true;
    };
    let credential: PairedCredential, snapshot: Snapshot, generation: bigint;
    const inspect = async (request: AbortSignal): Promise<NodeIdentity> => {
      await this.storage.loadEndpointTransport?.(profile);
      rememberEndpointTrust(profile);
      const node = await this.network.inspect(profile.origin, request); assertCurrent();
      if (node.serverId !== profile.serverId) throw new CredentialIdentityError();
      return node;
    };
    const prove = async (request: AbortSignal): Promise<Snapshot> => {
      const node = await inspect(request);
      const owner = await this.network.readOwner(credential, this.deviceNameSource(), request);
      assertCurrent(); this.#assertOwner(credential, owner, node);
      if (owner.snapshot.generation < 1n || generation !== undefined && owner.snapshot.generation !== generation) {
        throw new Error("The Partner source generation changed. Refresh its directory.");
      }
      snapshot = owner.snapshot;
      return snapshot;
    };
    try {
      await owned(signal, async request => {
        const node = await inspect(request);
        let saved: PairedCredential | undefined;
        try { saved = await this.storage.loadCredential(profileId); }
        catch (error) {
          request.throwIfAborted(); assertCurrent();
          if (credentialFailure(error) === "unreadable") {
            this.#set({ saved: this.#savedViews(profileId, "unreadable", "The saved Partner credential is unreadable. Pair its node again.") });
            retired = true;
          }
          throw error;
        }
        request.throwIfAborted(); assertCurrent();
        if (!saved || !credentialMatchesProfile(saved, profile)) throw new CredentialIdentityError();
        credential = Object.freeze({ ...saved });
        const owner = await this.network.readOwner(credential, this.deviceNameSource(), request);
        assertCurrent(); this.#assertOwner(credential, owner, node);
        if (owner.snapshot.generation < 1n) throw new CredentialIdentityError();
        snapshot = owner.snapshot; generation = snapshot.generation;
      });
    } catch (error) { await invalidate(error); throw error; }
    const ownerKey = `${sourceKey}\u001f${generation!}\u001f${epoch}\u001fpartner-roster`;
    const list = async (caller: AbortSignal): Promise<MobilePartnerCatalog> => {
      try { return await owned(caller, async request => { await prove(request); const catalog = await this.network.listPartnerCatalog!(credential, request); assertCurrent(); return catalog; }); }
      catch (error) { await invalidate(error); throw error; }
    };
    const groupFactory = this.network.partnerGroupApi;
    let groupApi: import("@joko/contracts").PartnerGroupApi | undefined;
    const readGroup = async <T>(caller: AbortSignal, effect: (api: import("@joko/contracts").PartnerGroupApi, request: AbortSignal) => Promise<T>): Promise<T> => {
      try { return await owned(caller, async request => {
        await prove(request);
        groupApi ??= groupFactory?.call(this.network, credential, ownerKey, this.newId, current => { current.throwIfAborted(); assertCurrent(); });
        if (!groupApi) throw new Error("Partner groups are unavailable on this source.");
        return effect(groupApi, request);
      }); }
      catch (error) { await invalidate(error); throw error; }
    };
    return { sourceKey, ownerKey, profile, isCurrent, list,
      groups: groupFactory ? { list: caller => readGroup(caller, (api, request) => api.list(request)),
        get: (groupId, before, caller) => readGroup(caller, (api, request) => api.get(groupId, before, request)) } : undefined,
      observation: () => isCurrent() ? { ownerKey, online: true, snapshot: snapshot! } : undefined,
      avatar: this.network.readPartnerAvatar ? { ownerKey, read: (partner, caller) => owned(caller, async request => {
        const fresh = (await list(request)).partners.filter(item => item.partnerId === partner.partnerId);
        if (fresh.length !== 1 || fresh[0]!.revision !== partner.revision) throw new Error("The Partner avatar source changed.");
        return this.network.readPartnerAvatar!(credential, partner, request);
      }) } : undefined,
      canonical: (selected, caller, allowPaused = false) => owned(caller, async request => {
        const matches = (await list(request)).partners.filter(partner => partner.partnerId === selected.partnerId);
        if (matches.length !== 1 || mobilePartnerDirectoryIdentity(matches[0]!) !== mobilePartnerDirectoryIdentity(selected)) {
          throw new Error("The selected Partner changed. Refresh its source directory.");
        }
        const partner = matches[0]!, links = await this.network.listPartnerSessions(credential, partner.partnerId, request);
        assertCurrent(); const sessionId = assertMobilePartnerDirectorySession(partner, links, allowPaused);
        const owner = await prove(request), sessions = owner.sessions.filter(session => session.sessionId === sessionId);
        const session = sessions.length === 1 ? sessions[0] : undefined;
        if (!session || session.targetId !== partner.homeTargetId || session.archived
          || session.state === SessionState.CLOSED || session.state === SessionState.ARCHIVED
          || owner.targets.filter(target => target.targetId === partner.homeTargetId && target.backendId === session.backendId).length !== 1
          || owner.backends.filter(backend => backend.backendId === session.backendId).length !== 1) {
          throw new Error("The Partner canonical task does not belong to its source home.");
        }
        return { sessionId, partner };
      }) };
  }

  async partnerGroupRosterSourceTransport(profileId: string, signal: AbortSignal, expectedSourceKey?: string): Promise<MobilePartnerGroupSourceTransport> {
    if (expectedSourceKey !== undefined && !this.#profiles.some(profile => profile.profileId === profileId
      && mobilePartnerRosterSourceKey(profile) === expectedSourceKey)) throw new Error("The saved Partner group source identity changed.");
    const source = await this.partnerRosterSourceTransport(profileId, signal);
    const api = source.groups;
    if (!api) throw new Error("Partner groups are unavailable on this source.");
    return { sourceKey: source.sourceKey, ownerKey: `${source.ownerKey}\u001fgroup-roster`,
      receiptScope: JSON.stringify([source.profile.serverId, source.profile.profileId, source.profile.deviceId, new URL(source.profile.origin).href]),
      isCurrent: source.isCurrent,
      list: async caller => {
        const catalog = await api.list(caller), partners = await source.list(caller);
        caller.throwIfAborted();
        if (!source.isCurrent()) throw new Error("The Partner group source changed.");
        const visible = new Set(partners.partners.filter(partner => partner.lifecycle !== "archived").map(partner => partner.partnerId));
        return { ...catalog, groups: catalog.groups.filter(group => group.members.every(member => visible.has(member.partnerId))) };
      } };
  }

  partnerGroupSourceClaimCurrent(selection: MobilePartnerGroupSelection): boolean {
    return this.partnerGroupSourceClaimRetained(selection) && this.#foreground
      && this.#state.status === "connected" && this.#activeProfileId === selection.profileId
      && this.#partnerPrivateAuthorityKey(this.#state) === selection.ownerKey;
  }

  /** Retained presentation does not authorize navigation or any Group effect. */
  partnerGroupSourceClaimRetained(selection: MobilePartnerGroupSelection): boolean {
    const credential = this.#partnerGroupSelections.get(selection);
    return credential !== undefined && credential === this.#credential && !this.#disposed
      && this.#activeProfileId === selection.profileId && mobilePartnerRosterSourceKey(credential) === selection.sourceKey
      && this.partnerGroupReceiptScope() === selection.receiptScope
      && this.partnerRosterSources().some(source => source.key === selection.sourceKey);
  }

  /** A source selection adopts the original node; its existing Group owner performs all writes. */
  async openPartnerGroupRosterSource(profileId: string, groupId: string | undefined,
    signal: AbortSignal, expectedSourceKey?: string): Promise<MobilePartnerGroupSelection> {
    if (groupId !== undefined && !validMobilePartnerId(groupId)) throw new Error("Select a current Partner group.");
    if (expectedSourceKey !== undefined && !this.#profiles.some(profile => profile.profileId === profileId
      && mobilePartnerRosterSourceKey(profile) === expectedSourceKey)) throw new Error("The saved Partner group source identity changed.");
    const epoch = this.#partnerRosterEpoch;
    const source = await this.partnerRosterSourceTransport(profileId, signal), api = source.groups;
    if (!api) throw new Error("Partner groups are unavailable on this source.");
    const read = async (groupApi: Pick<import("@joko/contracts").PartnerGroupApi, "list" | "get">,
      directory: () => Promise<MobilePartnerCatalog>, requireCurrent: () => void): Promise<void> => {
      const groups = await groupApi.list(signal); requireCurrent();
      const partners = await directory(); requireCurrent();
      const visible = new Set(partners.partners.filter(partner => partner.lifecycle !== "archived").map(partner => partner.partnerId));
      if (groupId === undefined) return;
      const selected = groups.groups.filter(group => group.id === groupId);
      if (selected.length !== 1 || selected[0]!.deleting || !selected[0]!.members.every(member => visible.has(member.partnerId))) {
        throw new Error("The Partner group is no longer available on its original source.");
      }
      const response = await groupApi.get(groupId, undefined, signal); requireCurrent();
      const group = response.detail?.group;
      if (!group || group.id !== groupId || group.deleting || !group.members.every(member => visible.has(member.partnerId))) {
        throw new Error("The Partner group membership changed on its original source.");
      }
    };
    const requireSource = (): void => {
      signal.throwIfAborted();
      if (epoch !== this.#partnerRosterEpoch || !source.isCurrent()) throw new Error("The Partner group source changed before node adoption.");
    };
    await read(api, () => source.list(signal), requireSource);
    await this.composerDrafts?.flush(); await this.newTaskDrafts?.flush(); requireSource();
    await this.connectSaved(profileId); requireSource();
    const context = this.#partnerPrivateContext(), currentApi = this.partnerGroupApi(), directory = this.partnerDirectoryTransport();
    if (!context || !currentApi || !directory || this.#activeProfileId !== profileId
      || mobilePartnerRosterSourceKey(context.credential) !== source.sourceKey) throw new Error("The Partner group source was not adopted by this node.");
    const requireCurrent = (): void => {
      requireSource();
      if (this.#credential !== context.credential || this.#partnerPrivateAuthorityKey(this.#state) !== context.authorityKey
        || this.#activeProfileId !== profileId) throw new Error("The Partner group node changed during navigation.");
    };
    await read(currentApi, () => directory.list(signal), requireCurrent); requireCurrent();
    const receiptScope = this.partnerGroupReceiptScope();
    if (!receiptScope) throw new Error("The Partner group creation receipt owner is unavailable.");
    const selection: MobilePartnerGroupSelection = Object.freeze({ sourceKey: source.sourceKey, receiptScope,
      ownerKey: currentApi.ownerKey, profileId, ...(groupId === undefined ? {} : { groupId }) });
    this.#partnerGroupSelections.set(selection, context.credential);
    return selection;
  }

  async openPartnerRosterSource(profileId: string, selected: MobilePartnerDirectoryProfile, signal: AbortSignal,
    mode: "conversation" | "settings" = "conversation"): Promise<{ readonly sessionId: string }> {
    const epoch = this.#partnerRosterEpoch;
    const source = await this.partnerRosterSourceTransport(profileId, signal);
    const allowPaused = mode === "settings";
    const initial = await source.canonical(selected, signal, allowPaused);
    await this.composerDrafts?.flush(); await this.newTaskDrafts?.flush();
    signal.throwIfAborted();
    if (!source.isCurrent()) throw new Error("The Partner source retired before navigation.");
    await this.connectSaved(profileId);
    signal.throwIfAborted();
    const requireOwner = (): void => {
      if (epoch !== this.#partnerRosterEpoch || this.#disposed || !this.#foreground
        || this.#activeProfileId !== profileId || this.#state.status !== "connected"
        || !this.#credential || mobilePartnerRosterSourceKey(this.#credential) !== source.sourceKey) {
        throw new Error("The Partner source was not adopted by the current node.");
      }
    };
    requireOwner();
    const adopted = this.partnerDirectoryTransport();
    if (!adopted) throw new Error("The Partner source has no current directory owner.");
    const result = await adopted.open(initial.partner, signal, allowPaused); requireOwner();
    const verified = await source.canonical(initial.partner, signal, allowPaused); requireOwner();
    if (result.sessionId !== initial.sessionId || verified.sessionId !== initial.sessionId
      || this.#state.detail?.sessions.filter(session => session.sessionId === initial.sessionId
        && session.targetId === selected.homeTargetId).length !== 1) {
      throw new Error("The Partner relationship changed during node navigation.");
    }
    this.#partnerRosterNavigation = { sourceKey: source.sourceKey, profileId, sessionId: result.sessionId,
      partnerId: selected.partnerId, homeTargetId: selected.homeTargetId };
    return result;
  }

  async openPartnerRosterInitializationSource(profileId: string, selected: MobilePartnerDirectoryProfile,
    signal: AbortSignal): Promise<{ readonly ownerKey: string; readonly partnerId: string }> {
    const epoch = this.#partnerRosterEpoch;
    const source = await this.partnerRosterSourceTransport(profileId, signal);
    const exact = (catalog: MobilePartnerCatalog): MobilePartnerDirectoryProfile => {
      const matches = catalog.partners.filter(partner => partner.partnerId === selected.partnerId);
      if (matches.length !== 1 || mobilePartnerDirectoryIdentity(matches[0]!) !== mobilePartnerDirectoryIdentity(selected)
        || matches[0]!.lifecycle !== "active" || matches[0]!.initializationState === "ready") {
        throw new Error("The Partner preparation source changed. Refresh its directory.");
      }
      return matches[0]!;
    };
    exact(await source.list(signal));
    await this.composerDrafts?.flush(); await this.newTaskDrafts?.flush(); signal.throwIfAborted();
    if (!source.isCurrent()) throw new Error("The Partner preparation source retired before navigation.");
    await this.connectSaved(profileId); signal.throwIfAborted();
    const requireCurrent = (): void => {
      if (epoch !== this.#partnerRosterEpoch || !source.isCurrent() || this.#activeProfileId !== profileId
        || this.#state.status !== "connected" || !this.#credential
        || mobilePartnerRosterSourceKey(this.#credential) !== source.sourceKey) throw new Error("The Partner preparation node was not adopted.");
    };
    requireCurrent(); exact(await source.list(signal)); requireCurrent();
    const initialization = this.partnerInitializationTransport();
    if (!initialization) throw new Error("The Partner preparation owner is unavailable on this node.");
    const current = await initialization.load(selected.partnerId, signal); requireCurrent();
    if (mobilePartnerDirectoryIdentity(current) !== mobilePartnerDirectoryIdentity(selected)) throw new Error("The Partner preparation changed while opening.");
    return { ownerKey: initialization.ownerKey, partnerId: current.partnerId };
  }

  partnerInitializationTransport(): MobilePartnerInitializationTransport | undefined {
    const directory = this.partnerDirectoryTransport();
    const context = this.#partnerPrivateContext();
    const retryInitialization = this.network.retryPartnerInitialization;
    if (!directory || !context || !retryInitialization) return undefined;
    const ownerKey = directory.ownerKey;
    const requireCurrent = (signal: AbortSignal): void => {
      signal.throwIfAborted();
      if (this.#credential !== context.credential || this.#partnerPrivateAuthorityKey(this.#state) !== ownerKey) {
        throw new Error("The Partner initialization owner changed.");
      }
    };
    const load: MobilePartnerInitializationTransport["load"] = async (partnerId, signal) => {
      if (!validMobilePartnerId(partnerId)) throw new Error("Select a current Partner initialization.");
      const catalog = await directory.list(signal);
      requireCurrent(signal);
      const matches = catalog.partners.filter((partner) => partner.partnerId === partnerId);
      if (matches.length !== 1 || matches[0]!.lifecycle !== "active") {
        throw new Error("The Partner initialization is no longer available.");
      }
      return matches[0]!;
    };
    const models = (partner: MobilePartnerDirectoryProfile): readonly MobilePartnerInitializationModel[] => {
      if (this.#credential !== context.credential || this.#partnerPrivateAuthorityKey(this.#state) !== ownerKey
        || partner.canonicalSessionId || partner.initializationErrorCode !== "modelUnavailable") return [];
      return mobilePartnerCreationBackends(this.#state.owner).filter(backend => backend.permissionModes.includes(partner.capabilities.permissionMode)
        && (!partner.capabilities.planMode || backend.canSetPlanMode)).flatMap(backend => backend.models.map(model => {
        const effort = model.efforts.find(option => option.default)?.id ?? model.efforts[0]?.id;
        return { id: model.key, label: `${model.displayName} · ${model.providerName}`,
          route: { backendId: model.backendId, providerId: model.providerId, modelId: model.modelId, fastMode: false,
            ...(effort === undefined ? {} : { effort }) } };
      }));
    };
    return { ownerKey, load, models, ...(this.network.updatePartnerProfile ? { configure: async (selected: MobilePartnerDirectoryProfile,
      choice: MobilePartnerInitializationModel, signal: AbortSignal) => {
      requireCurrent(signal);
      const current = await load(selected.partnerId, signal);
      if (mobilePartnerDirectoryIdentity(current) !== mobilePartnerDirectoryIdentity(selected)
        || current.canonicalSessionId || current.initializationErrorCode !== "modelUnavailable") {
        throw new Error("The Partner model setup changed; refresh before choosing a model.");
      }
      const model = models(current).find(candidate => candidate.id === choice.id && JSON.stringify(candidate.route) === JSON.stringify(choice.route));
      if (!model) throw new Error("Choose an available model from this node.");
      const action = this.#claimMutation();
      try {
        const updated = await this.network.updatePartnerProfile!(context.credential, current.partnerId, current.revision,
          { ...mobilePartnerProfileDraft(current), usesDirectoryDefaults: false,
            capabilities: { ...current.capabilities, modelChain: [model.route] } }, signal);
        requireCurrent(signal);
        const confirmed = await load(current.partnerId, signal);
        if (confirmed.revision < updated.revision || confirmed.revision <= current.revision
          || confirmed.homeTargetId !== current.homeTargetId || confirmed.lifecycle !== "active"
          || JSON.stringify(confirmed.capabilities.modelChain) !== JSON.stringify([model.route])) {
          throw new Error("The selected Partner model could not be confirmed.");
        }
        return confirmed;
      } catch (error) {
        signal.throwIfAborted();
        throw new Error("The Partner model choice may have been applied. Refresh before choosing again.", { cause: error });
      } finally { this.#releaseMutation(action); }
    } } : {}), retry: async (selected, signal) => {
      requireCurrent(signal);
      const current = await load(selected.partnerId, signal);
      if (mobilePartnerDirectoryIdentity(current) !== mobilePartnerDirectoryIdentity(selected)
        || current.initializationState !== "error") {
        throw new Error("The Partner initialization changed; refresh before retrying.");
      }
      const action = this.#claimMutation();
      try {
        const updated = await retryInitialization.call(this.network, context.credential, current.partnerId,
          current.revision, signal);
        requireCurrent(signal);
        const sameProfile = (value: MobilePartnerDirectoryProfile): boolean => value.partnerId === current.partnerId
          && value.lifecycle === "active" && value.homeTargetId === current.homeTargetId
          && value.profileVersion === current.profileVersion
          && value.capabilities.modelChain[0]?.backendId === current.capabilities.modelChain[0]?.backendId
          && (current.canonicalSessionId === undefined || value.canonicalSessionId === current.canonicalSessionId);
        if (!sameProfile(updated) || updated.revision <= current.revision) {
          throw new Error("The initialization result belongs to another Partner profile.");
        }
        const confirmed = await load(current.partnerId, signal);
        if (!sameProfile(confirmed) || confirmed.revision < updated.revision) {
          throw new Error("The Partner initialization result could not be confirmed.");
        }
        return confirmed;
      } catch (error) {
        signal.throwIfAborted();
        throw new Error("The Partner initialization retry may have been applied. Refresh before another retry.", { cause: error });
      } finally { this.#releaseMutation(action); }
    }, open: async (selected, signal) => {
      requireCurrent(signal);
      const current = await load(selected.partnerId, signal);
      if (mobilePartnerDirectoryIdentity(current) !== mobilePartnerDirectoryIdentity(selected)
        || current.initializationState !== "ready") throw new Error("The initialized Partner changed before opening.");
      // A just-initialized home may not be in the last task snapshot yet. Observe it without reconnecting
      // or retiring the recovery page's owner, then use the existing canonical navigation checks.
      const node = this.#state.node!;
      const observed = await this.network.readOwner(context.credential, this.deviceNameSource(), signal);
      requireCurrent(signal);
      this.#assertOwner(context.credential, observed, node);
      if (this.#partnerPrivateAuthorityKey({ ...this.#state, owner: observed.snapshot }) !== ownerKey) {
        throw new Error("The Partner initialization task directory owner changed.");
      }
      this.#set({ owner: observed.snapshot });
      requireCurrent(signal);
      const result = await directory.open(current, signal);
      requireCurrent(signal);
      this.#partnerRosterNavigation = { sourceKey: mobilePartnerRosterSourceKey(context.credential), profileId: context.credential.profileId,
        sessionId: result.sessionId, partnerId: current.partnerId, homeTargetId: current.homeTargetId };
      return result;
    } };
  }

  partnerConversationTransport(): MobilePartnerConversationTransport | undefined {
    if (this.#joinedTask) return undefined;
    const directory = this.partnerDirectoryTransport();
    const presentationKey = this.taskPresentationOwnerKey();
    const credential = this.#credential;
    const sessionId = this.#state.selectedId;
    if (!directory || !presentationKey || !credential || !sessionId) return undefined;
    const ownerKey = `${directory.ownerKey}\u001f${presentationKey}`;
    const requireCurrent = (signal: AbortSignal): Session => {
      signal.throwIfAborted();
      if (this.#credential !== credential || this.#partnerPrivateAuthorityKey(this.#state) !== directory.ownerKey
        || this.taskPresentationOwnerKey() !== presentationKey || this.#state.selectedId !== sessionId) {
        throw new Error("The Partner conversation owner changed.");
      }
      return this.#selectedSession()!;
    };
    const resolve = async (signal: AbortSignal): Promise<MobilePartnerDirectoryProfile | undefined> => {
      const catalog = await directory.list(signal);
      const session = requireCurrent(signal);
      const matches = catalog.partners.filter((partner) => partner.canonicalSessionId === sessionId);
      const expected = this.#partnerRosterNavigation;
      if (expected?.profileId === credential.profileId && expected.sessionId === sessionId
        && (expected.sourceKey !== mobilePartnerRosterSourceKey(credential) || matches.length !== 1
          || matches[0]!.partnerId !== expected.partnerId || matches[0]!.homeTargetId !== expected.homeTargetId)) {
        throw new Error("The selected Partner source relationship changed. Return to its directory and refresh.");
      }
      if (matches.length === 0) return undefined;
      const partner = matches[0]!;
      if (matches.length !== 1 || partner.homeTargetId !== session.targetId) {
        throw new Error("The Partner conversation identity is inconsistent.");
      }
      const sessions = await this.network.listPartnerSessions(credential, partner.partnerId, signal);
      requireCurrent(signal);
      if (assertMobilePartnerDirectorySession(partner, sessions, true) !== sessionId) {
        throw new Error("The Partner conversation is no longer canonical.");
      }
      return partner;
    };
    return { ownerKey, sessionId, resolve, acknowledge: async (partner, reply, signal, stillVisible) => {
      const requireVisible = (): void => {
        const session = requireCurrent(signal);
        if (!stillVisible() || session.archived || ![SessionState.IDLE, SessionState.ERROR].includes(session.state)) {
          throw new Error("The completed Partner reply is no longer visible in an idle conversation.");
        }
        const events = this.#state.window
          ?? [...this.#state.older, ...(this.#state.detail?.timeline ?? []), ...this.#state.live];
        const actual = mobilePartnerVisibleReply(events, sessionId, this.#state.owner!.generation,
          new Set([reply.messageId]));
        if (!actual || actual.eventId !== reply.eventId || actual.cursor !== reply.cursor) {
          throw new Error("The Partner read cursor is not a current completed public reply.");
        }
      };
      requireVisible();
      const current = await resolve(signal);
      requireVisible();
      if (!current || mobilePartnerDirectoryIdentity(current) !== mobilePartnerDirectoryIdentity(partner)) {
        throw new Error("The Partner profile changed before read acknowledgement.");
      }
      if (reply.cursor <= current.activity.readThroughCursor) return current.activity;
      if (!this.network.markPartnerRead) throw new Error("Partner read acknowledgement is unavailable.");
      const activity = await this.network.markPartnerRead(credential, partner.partnerId, reply.cursor, signal);
      requireCurrent(signal);
      if (activity.partnerId !== partner.partnerId || activity.readThroughCursor < reply.cursor) {
        throw new Error("The Partner read acknowledgement is invalid.");
      }
      return activity;
    } };
  }

  partnerAvatarTransport(): MobilePartnerAvatarTransport | undefined {
    const context = this.#partnerPrivateContext();
    if (!context || !this.network.readPartnerAvatar) return undefined;
    const ownerKey = context.authorityKey;
    const requireCurrent = (signal: AbortSignal): void => {
      signal.throwIfAborted();
      if (this.#partnerPrivateAuthorityKey(this.#state) !== ownerKey || this.#credential !== context.credential) {
        throw new Error("The Partner image owner changed.");
      }
    };
    return { ownerKey, read: async (partner, signal) => {
      requireCurrent(signal);
      const uri = await this.network.readPartnerAvatar!(context.credential, partner, signal);
      requireCurrent(signal); return uri;
    } };
  }

  partnerProfileTransport(): MobilePartnerProfileTransport | undefined {
    const saving = this.#currentPartnerProfileSave();
    if (saving) return saving.transport;
    const continuation = this.#currentPartnerProfileContinuation();
    if (continuation) return continuation.transport;
    const conversation = this.partnerConversationTransport();
    const directory = this.partnerDirectoryTransport();
    const context = this.#partnerPrivateContext();
    if (!conversation || !directory || !context || !this.network.getPartnerProfileOptions || !this.network.updatePartnerProfile) return undefined;
    const ownerKey = conversation.ownerKey;
    let facade!: MobilePartnerProfileTransport;
    const currentConversation = (): MobilePartnerConversationTransport => this.#currentPartnerProfileContinuation()?.ownerKey === ownerKey
      || this.#currentPartnerProfileSave()?.ownerKey === ownerKey
      ? this.partnerConversationTransport()! : conversation;
    const requireCurrent = (signal: AbortSignal): void => {
      signal.throwIfAborted();
      if (this.partnerConversationTransport()?.ownerKey !== ownerKey && this.#currentPartnerProfileContinuation()?.ownerKey !== ownerKey
        && this.#currentPartnerProfileSave()?.ownerKey !== ownerKey
        || this.#credential !== context.credential) {
        throw new Error("The Partner profile owner changed.");
      }
    };
    const load: MobilePartnerProfileTransport["load"] = async (selected, signal) => {
      requireCurrent(signal);
      const partner = await currentConversation().resolve(signal);
      requireCurrent(signal);
      if (!partner || partner.partnerId !== selected.partnerId) throw new Error("The Partner profile is no longer canonical.");
      const options = await this.network.getPartnerProfileOptions!(context.credential, signal);
      const catalog = await directory.list(signal);
      requireCurrent(signal);
      const final = catalog.partners.find((candidate) => candidate.partnerId === partner.partnerId);
      if (!final || mobilePartnerDirectoryIdentity(final) !== mobilePartnerDirectoryIdentity(partner)
        || options.revision !== catalog.directory.revision) throw new Error("The Partner profile changed while its settings were loading.");
      const controls = this.taskRuntimeControls();
      const taskModels = mobilePartnerCreationBackends(this.#state.owner).flatMap(backend => backend.models.map(model => ({ ...model,
        canSwitchModel: backend.canSwitchModel, canSetEffort: backend.canSetEffort, canSetFastMode: backend.canSetFastMode, canSetPlanMode: backend.canSetPlanMode,
        permissionModes: backend.permissionModes })));
      const sessions = await this.network.listPartnerSessions(context.credential, final.partnerId, signal); requireCurrent(signal);
      return { ownerKey, partner: final, options,
        tasks: sessions.tasks.map(task => projectPartnerSessionTask(task, final.partnerId)),
        names: catalog.partners.map(({ partnerId, displayName }) => ({ partnerId, displayName })),
        models: taskModels,
        taskModels,
        canSwitchModel: controls?.canSwitchModel === true, canSetEffort: controls?.canSetEffort === true,
        canSetFastMode: controls?.canSetFastMode === true, canSetPlanMode: controls?.canSetPlanMode === true,
        permissionModes: (controls?.permissionModes ?? []).filter((mode) => mode === PermissionMode.ASK || mode === PermissionMode.ACCEPT_EDITS || mode === PermissionMode.AUTO || mode === PermissionMode.BYPASS_PERMISSIONS)
          .map((mode) => mode === PermissionMode.ASK ? "ask" as const : mode === PermissionMode.ACCEPT_EDITS ? "acceptEdits" as const : mode === PermissionMode.AUTO ? "auto" as const : "bypassPermissions" as const) };
    };
    const listOutputs: NonNullable<MobilePartnerProfileTransport["listOutputs"]> = async (snapshot, signal) => {
      requireCurrent(signal);
      if (snapshot.ownerKey !== ownerKey || !this.network.listPartnerTaskOutputs) throw new Error("Partner task outputs are unavailable.");
      const partner = await currentConversation().resolve(signal); requireCurrent(signal);
      if (!partner || mobilePartnerDirectoryIdentity(partner) !== mobilePartnerDirectoryIdentity(snapshot.partner)) {
        throw new Error("The Partner output source owner changed.");
      }
      const outputs = await this.network.listPartnerTaskOutputs(context.credential, partner.partnerId, signal);
      requireCurrent(signal);
      const confirmed = await currentConversation().resolve(signal); requireCurrent(signal);
      if (outputs.partnerId !== partner.partnerId || !confirmed
        || mobilePartnerDirectoryIdentity(confirmed) !== mobilePartnerDirectoryIdentity(partner)) {
        throw new Error("The Partner output source owner changed.");
      }
      return outputs;
    };
    facade = { ownerKey, load,
      ...(this.network.listPartnerTaskOutputs ? ({ listOutputs, openOutputTask: async (snapshot, row, signal) => {
        requireCurrent(signal);
        if (this.#partnerTaskOutputOpenFlight) throw new Error("A Partner output source is already opening.");
        const flight = Symbol("partner-output-open"); this.#partnerTaskOutputOpenFlight = flight;
        try {
          const outputs = await listOutputs(snapshot, signal); requireCurrent(signal);
          const matches = outputs.rows.filter(candidate => candidate.kind === row.kind && candidate.id === row.id);
          const fresh = matches.length === 1 ? matches[0] : undefined;
          if (!fresh?.sessionId || !sameMobilePartnerTaskOutputSource(fresh, row)) throw new Error("The Partner task output source changed.");
          const currentSession = this.#selectedSession()!;
          const observed = await this.network.readOwner(context.credential, this.deviceNameSource(), signal);
          requireCurrent(signal); this.#assertOwner(context.credential, observed, this.#state.node!);
          const sameSession = (left: Session, right: Session): boolean => left.sessionId === right.sessionId
            && left.backendId === right.backendId && left.targetId === right.targetId
            && left.nativeBinding?.runtimeGeneration === right.nativeBinding?.runtimeGeneration;
          const current = observed.snapshot.sessions.filter(candidate => candidate.sessionId === currentSession.sessionId);
          const destinations = observed.snapshot.sessions.filter(candidate => candidate.sessionId === fresh.sessionId);
          const destination = destinations.length === 1 ? destinations[0] : undefined;
          if (this.#partnerPrivateAuthorityKey({ ...this.#state, owner: observed.snapshot }) !== context.authorityKey
            || current.length !== 1 || !sameSession(current[0]!, currentSession)
            || !destination?.nativeBinding?.runtimeGeneration || destination.nativeBinding.runtimeGeneration < 1n) {
            throw new Error("The Partner output source task is unavailable in the current task directory.");
          }
          this.#set({ owner: observed.snapshot }); requireCurrent(signal);
          await this.select(destination.sessionId);
          signal.throwIfAborted();
          const selected = this.#selectedSession();
          if (this.#credential !== context.credential || this.#partnerPrivateAuthorityKey(this.#state) !== context.authorityKey
            || this.#state.selectedId !== destination.sessionId || !selected || !sameSession(selected, destination)
            || !this.taskPresentationOwnerKey()) throw new Error("The Partner output source owner changed while opening.");
        } finally { if (this.#partnerTaskOutputOpenFlight === flight) this.#partnerTaskOutputOpenFlight = undefined; }
      } } satisfies Pick<MobilePartnerProfileTransport, "listOutputs" | "openOutputTask">) : {}),
      controlTask: async (snapshot, task, action, signal) => {
        requireCurrent(signal);
        if (snapshot.ownerKey !== ownerKey || task.partnerId !== snapshot.partner.partnerId || !this.network.controlPartnerSessionTask) throw new Error("Independent task control is unavailable.");
        await this.network.controlPartnerSessionTask(context.credential, this.newId(), snapshot.partner.partnerId, snapshot.partner.revision, task, action, signal); requireCurrent(signal);
      },
      openTask: async (snapshot, task, signal) => {
        requireCurrent(signal); if (snapshot.ownerKey !== ownerKey || task.partnerId !== snapshot.partner.partnerId || !task.sessionId) throw new Error("Select a current independent task.");
        const listed = await this.network.listPartnerSessions(context.credential, task.partnerId, signal); requireCurrent(signal);
        if (!listed.tasks.some(item => item.id === task.id && item.partnerId === task.partnerId && item.sessionId === task.sessionId)) throw new Error("The independent task changed.");
        await this.select(task.sessionId);
        if (this.#credential !== context.credential || this.#state.selectedId !== task.sessionId) throw new Error("The task owner changed while opening.");
      },
      save: async (snapshot, draft, signal) => {
      requireCurrent(signal);
      if (snapshot.ownerKey !== ownerKey) throw new Error("The Partner profile draft belongs to another owner.");
      const fresh = await load(snapshot.partner, signal);
      if (mobilePartnerDirectoryIdentity(fresh.partner) !== mobilePartnerDirectoryIdentity(snapshot.partner)
        || mobilePartnerDraftCatalogIdentity(fresh) !== mobilePartnerDraftCatalogIdentity(snapshot)) {
        throw new Error("The Partner profile changed; refresh settings before saving this draft.");
      }
      const validated = validateMobilePartnerProfileDraft(fresh, draft);
      requireCurrent(signal);
      const saveEpoch = this.#epoch;
      const saveSession = this.#selectedSession()!;
      const requireSaveOwner = (): void => {
        signal.throwIfAborted();
        const session = this.#selectedSession();
        if (!this.#current(saveEpoch) || this.#credential !== context.credential
          || this.#partnerPrivateAuthorityKey(this.#state) !== directory.ownerKey
          || this.#state.selectedId !== conversation.sessionId || session?.targetId !== saveSession.targetId
          || session.backendId !== saveSession.backendId) {
          const changed = !this.#current(saveEpoch) ? "lifecycle" : this.#credential !== context.credential ? "credential"
            : this.#partnerPrivateAuthorityKey(this.#state) !== directory.ownerKey ? "connection"
              : this.#state.selectedId !== conversation.sessionId ? "selection"
                : session?.targetId !== saveSession.targetId ? "home target"
                  : "backend";
          throw new Error(`The Partner profile source changed while saving (${changed}).`);
        }
      };
      const action = this.#claimMutation();
      this.#partnerProfileSave = { action, epoch: saveEpoch, credential: context.credential, directoryKey: directory.ownerKey,
        presentationKey: this.taskPresentationOwnerKey()!, sessionId: conversation.sessionId, targetId: saveSession.targetId,
        backendId: saveSession.backendId,
        ownerKey, transport: facade, partner: fresh.partner,
        backendKey: backendAuthorityKey(this.#state.owner!.backends.find(backend => backend.backendId === saveSession.backendId)!) };
      let savedSuccessfully = false;
      try {
        const updated = await this.network.updatePartnerProfile!(context.credential, fresh.partner.partnerId,
          fresh.partner.revision, validated, signal);
        requireSaveOwner();
        if (updated.partnerId !== fresh.partner.partnerId || updated.canonicalSessionId !== conversation.sessionId
          || updated.homeTargetId !== fresh.partner.homeTargetId || updated.revision < fresh.partner.revision) {
          throw new Error("The Partner update returned a different canonical identity.");
        }
        // The accepted profile update advances its canonical Session revision. An owner push may
        // arrive before the detail read; reconcile both snapshots before using the ordinary editor.
        rememberEndpointTrust(context.credential);
        const node = await this.network.inspect(context.credential.origin, signal); requireSaveOwner();
        if (node.serverId !== context.credential.serverId || node.apiVersion !== this.#state.node?.apiVersion) throw new CredentialIdentityError();
        const observed = await this.network.readOwner(context.credential, this.deviceNameSource(), signal); requireSaveOwner();
        this.#assertOwner(context.credential, observed, node);
        const detail = await this.network.readSession(context.credential, conversation.sessionId, signal); requireSaveOwner();
        const owned = observed.snapshot.sessions.filter(session => session.sessionId === conversation.sessionId);
        const detailed = detail.sessions.filter(session => session.sessionId === conversation.sessionId);
        if (observed.snapshot.generation !== this.#taskGeneration() || detail.generation !== observed.snapshot.generation
          || detail.server?.serverId !== node.serverId || detail.server.apiVersion !== node.apiVersion
          || owned.length !== 1 || detailed.length !== 1 || owned[0]!.targetId !== saveSession.targetId
          || detailed[0]!.targetId !== saveSession.targetId || owned[0]!.backendId !== saveSession.backendId
          || detailed[0]!.backendId !== saveSession.backendId
          || !owned[0]!.nativeBinding?.runtimeGeneration || owned[0]!.nativeBinding!.runtimeGeneration! < 1n
          || detailed[0]!.nativeBinding?.runtimeGeneration !== owned[0]!.nativeBinding?.runtimeGeneration
          || entityVersionKey(owned[0]!.version) !== entityVersionKey(detailed[0]!.version)) {
          throw new Error("The updated Partner canonical task could not be revalidated.");
        }
        const links = await this.network.listPartnerSessions(context.credential, updated.partnerId, signal); requireSaveOwner();
        if (assertMobilePartnerDirectorySession(updated, links, true) !== conversation.sessionId
          || observed.snapshot.targets.filter(target => target.targetId === saveSession.targetId && target.backendId === saveSession.backendId).length !== 1
          || observed.snapshot.backends.filter(backend => backend.backendId === saveSession.backendId
            && backendAuthorityKey(backend) === this.#partnerProfileSave!.backendKey).length !== 1) {
          throw new Error("The updated Partner source home or Backend changed.");
        }
        this.#set({ owner: observed.snapshot, detail });
        requireCurrent(signal);
        const confirmed = (await load(updated, signal)).partner;
        if (confirmed.revision < updated.revision || confirmed.displayName !== validated.displayName
          || confirmed.description !== validated.description
          || JSON.stringify(confirmed.avatar) !== JSON.stringify(updated.avatar) || confirmed.identitySource !== validated.identitySource
          || confirmed.usesDirectoryDefaults !== validated.usesDirectoryDefaults
          || JSON.stringify(confirmed.taskModelOverride) !== JSON.stringify(validated.taskModelOverride)
          || !validated.usesDirectoryDefaults && JSON.stringify(confirmed.capabilities) !== JSON.stringify(validated.capabilities)) {
          throw new Error("The saved Partner profile could not be confirmed by the current node.");
        }
        this.#partnerProfileContinuation = { epoch: saveEpoch, credential: context.credential, directoryKey: directory.ownerKey,
          ownerKey, sessionId: conversation.sessionId, targetId: saveSession.targetId, backendId: saveSession.backendId,
          runtimeGeneration: owned[0]!.nativeBinding!.runtimeGeneration!, partner: confirmed, transport: facade };
        savedSuccessfully = true;
        return confirmed;
      } catch (error) {
        signal.throwIfAborted();
        throw new Error("The Partner update may have been applied. Refresh settings before another save.", { cause: error });
      } finally {
        const pendingRefresh = this.#partnerProfileSave?.action === action && this.#partnerProfileSave.refreshPending;
        if (this.#partnerProfileSave?.action === action) this.#partnerProfileSave = undefined;
        this.#releaseMutation(action);
        if (pendingRefresh && this.#current(saveEpoch) && this.#credential === context.credential) {
          if (savedSuccessfully) { this.#beginStream(saveEpoch, context.credential, this.#state.owner!); this.#schedule(); }
          else void this.refresh();
        }
      }
    } };
    return facade;
  }

  #currentPartnerProfileContinuation() {
    const continuation = this.#partnerProfileContinuation;
    if (!continuation || !this.#current(continuation.epoch) || this.#credential !== continuation.credential
      || this.#partnerPrivateAuthorityKey(this.#state) !== continuation.directoryKey || this.#state.selectedId !== continuation.sessionId) return undefined;
    for (const snapshot of [this.#state.owner, this.#state.detail]) {
      const sessions = snapshot?.sessions.filter(session => session.sessionId === continuation.sessionId) ?? [];
      if (sessions.length !== 1 || sessions[0]!.targetId !== continuation.targetId || sessions[0]!.backendId !== continuation.backendId
        || sessions[0]!.nativeBinding?.runtimeGeneration !== continuation.runtimeGeneration) return undefined;
    }
    return continuation;
  }

  #currentPartnerProfileSave() {
    const saving = this.#partnerProfileSave, session = this.#selectedSession();
    return saving && this.#mutationOwner === saving.action && this.#current(saving.epoch)
      && this.#credential === saving.credential && this.#partnerPrivateAuthorityKey(this.#state) === saving.directoryKey
      && this.#state.selectedId === saving.sessionId && session?.targetId === saving.targetId && session.backendId === saving.backendId ? saving : undefined;
  }

  partnerProfileContinuationPartner(): MobilePartnerDirectoryProfile | undefined {
    return this.#currentPartnerProfileSave()?.partner ?? this.#currentPartnerProfileContinuation()?.partner;
  }

  #partnerProfileOwnerMatches(ownerKey: string): boolean {
    return this.partnerConversationTransport()?.ownerKey === ownerKey || this.#currentPartnerProfileContinuation()?.ownerKey === ownerKey
      || this.#currentPartnerProfileSave()?.ownerKey === ownerKey;
  }

  partnerDeletionTransport(): MobilePartnerDeletionTransport | undefined {
    const context = this.#partnerPrivateContext(); const directory = this.partnerDirectoryTransport();
    const receipts = this.partnerDeletionReceipts;
    if (!context || !directory || !receipts || !this.network.deletePartner || !this.network.getPartnerDeletion
      || !this.network.retryPartnerDeletion || !this.network.retirePartnerDeletion) return undefined;
    const ownerKey = context.authorityKey;
    const requireCurrent = (signal: AbortSignal): void => {
      signal.throwIfAborted();
      if (this.#partnerPrivateAuthorityKey(this.#state) !== ownerKey || this.#credential !== context.credential) throw new Error("The Partner deletion owner changed.");
    };
    const settle = async (result: import("@joko/contracts").PartnerDeletionResult, requestId: string, signal: AbortSignal) => {
      requireCurrent(signal);
      if (result.deletion && (result.deletion.requestId !== requestId || result.retired)) throw new Error("The Partner deletion receipt changed.");
      if (result.retired || result.deletion?.phase === "completed") await receipts.resolve(context.credential, requestId, signal);
      requireCurrent(signal); return result;
    };
    return { ownerKey,
      newRequestId: () => this.newId(),
      listRequests: async (signal) => {
        requireCurrent(signal); const ids = await receipts.load(context.credential, signal);
        const catalog = await directory.list(signal); requireCurrent(signal);
        return [...new Set([...ids, ...(catalog.pendingDeletions ?? []).map((entry) => entry.requestId)])];
      },
      delete: async (requestId, selected, confirmName, signal) => {
        requireCurrent(signal); const catalog = await directory.list(signal); requireCurrent(signal);
        const fresh = catalog.partners.find((entry) => entry.partnerId === selected.partnerId);
        if (!fresh || fresh.revision !== selected.revision || fresh.displayName !== confirmName) throw new Error("Refresh the Partner before confirming deletion.");
        await receipts.claim(context.credential, requestId, signal); requireCurrent(signal);
        const action = this.#claimMutation();
        try {
          const deletion = await this.network.deletePartner!(context.credential, requestId, selected.partnerId, selected.revision, confirmName, signal);
          if (deletion.partnerId !== selected.partnerId) throw new Error("The Partner deletion owner changed.");
          await settle({ deletion, retired: false }, requestId, signal); return deletion;
        } finally { this.#releaseMutation(action); }
      },
      read: async (id, signal) => { requireCurrent(signal); return settle(await this.network.getPartnerDeletion!(context.credential, id, signal), id, signal); },
      retire: async (id, signal) => { requireCurrent(signal); return settle(await this.network.retirePartnerDeletion!(context.credential, id, signal), id, signal); },
      retry: async (id, signal) => {
        requireCurrent(signal); const action = this.#claimMutation();
        try { const deletion = await this.network.retryPartnerDeletion!(context.credential, id, signal);
          await settle({ deletion, retired: false }, id, signal); return deletion;
        } finally { this.#releaseMutation(action); }
      }
    };
  }

  partnerRestartTransport(): MobilePartnerRestartTransport | undefined {
    const context = this.#partnerPrivateContext(); const directory = this.partnerDirectoryTransport();
    const receipts = this.partnerRestartReceipts;
    if (!context || !directory || !receipts || !this.network.restartPartner || !this.network.getPartnerRestart
      || !this.network.retryPartnerRestart || !this.network.retirePartnerRestart || !this.network.getPartnerRestartControls) return undefined;
    const ownerKey = context.authorityKey;
    const requireCurrent = (signal: AbortSignal): void => {
      signal.throwIfAborted();
      if (this.#partnerPrivateAuthorityKey(this.#state) !== ownerKey || this.#credential !== context.credential) throw new Error("The Partner restart owner changed.");
    };
    const settle = async (result: import("@joko/contracts").PartnerRestartResult, requestId: string, signal: AbortSignal) => {
      requireCurrent(signal);
      if (result.restart && (result.restart.requestId !== requestId || result.retired)) throw new Error("The Partner restart receipt changed.");
      if (result.retired || result.restart?.phase === "ready") await receipts.resolve(context.credential, requestId, signal);
      requireCurrent(signal); return result;
    };
    return { ownerKey,
      newRequestId: () => this.newId(),
      controls: async (selected, signal) => { requireCurrent(signal);
        const controls = await this.network.getPartnerRestartControls!(context.credential, selected.partnerId, signal);
        requireCurrent(signal); return controls; },
      listRequests: async (signal) => {
        requireCurrent(signal); const ids = await receipts.load(context.credential, signal);
        const catalog = await directory.list(signal); requireCurrent(signal);
        return [...new Set([...ids, ...(catalog.pendingRestarts ?? []).map((entry) => entry.requestId)])];
      },
      restart: async (requestId, selected, signal) => {
        requireCurrent(signal); const catalog = await directory.list(signal); requireCurrent(signal);
        const fresh = catalog.partners.find((entry) => entry.partnerId === selected.partnerId);
        if (!fresh || fresh.revision !== selected.revision) throw new Error("Refresh the Partner before restarting.");
        const controls = await this.network.getPartnerRestartControls!(context.credential, selected.partnerId, signal); requireCurrent(signal);
        if (!controls.available || controls.revision !== selected.revision) throw new Error("The Partner restart controls changed.");
        await receipts.claim(context.credential, requestId, signal); requireCurrent(signal);
        const action = this.#claimMutation();
        try {
          const restart = await this.network.restartPartner!(context.credential, requestId, selected.partnerId, selected.revision, signal);
          if (restart.partnerId !== selected.partnerId) throw new Error("The Partner restart owner changed.");
          await settle({ restart, retired: false }, requestId, signal); return restart;
        } finally { this.#releaseMutation(action); }
      },
      read: async (id, signal) => { requireCurrent(signal); return settle(await this.network.getPartnerRestart!(context.credential, id, signal), id, signal); },
      retire: async (id, signal) => { requireCurrent(signal); return settle(await this.network.retirePartnerRestart!(context.credential, id, signal), id, signal); },
      retry: async (id, signal) => {
        requireCurrent(signal); const action = this.#claimMutation();
        try { const restart = await this.network.retryPartnerRestart!(context.credential, id, signal);
          await settle({ restart, retired: false }, id, signal); return restart;
        } finally { this.#releaseMutation(action); }
      }
    };
  }

  partnerResumeEditor(selected: MobilePartnerDirectoryProfile, conversationOwnerKey?: string): PartnerResumeEditor | undefined {
    const context = this.#partnerPrivateContext(); const directory = this.partnerDirectoryTransport();
    if (!context || !directory || !this.network.resumePartner || selected.lifecycle !== "paused") return undefined;
    const ownerKey = conversationOwnerKey ?? context.authorityKey;
    const requireCurrent = (signal: AbortSignal): void => {
      signal.throwIfAborted();
      if (this.#partnerPrivateAuthorityKey(this.#state) !== context.authorityKey || this.#credential !== context.credential
        || conversationOwnerKey !== undefined && !this.#partnerProfileOwnerMatches(conversationOwnerKey)) {
        throw new Error("The Partner resume owner changed.");
      }
    };
    const profile = (value: MobilePartnerDirectoryProfile) => ({ ...value, backendId: value.capabilities.modelChain[0]?.backendId ?? "" });
    const read = async (signal: AbortSignal) => {
      requireCurrent(signal); const catalog = await directory.list(signal); requireCurrent(signal);
      const rows = catalog.partners.filter(value => value.partnerId === selected.partnerId);
      if (rows.length !== 1) throw new Error("The paused Partner is no longer available.");
      return profile(rows[0]!);
    };
    return new PartnerResumeEditor({ ownerKey, read, resume: async (current, signal) => {
      requireCurrent(signal); const fresh = await read(signal); requireCurrent(signal);
      if (mobilePartnerDirectoryIdentity(fresh) !== mobilePartnerDirectoryIdentity(current) || fresh.lifecycle !== "paused"
        || fresh.pauseCleanupPending !== current.pauseCleanupPending) throw new Error("Refresh the Partner before resuming.");
      const action = this.#claimMutation();
      try { const resumed = await this.network.resumePartner!(context.credential, current.partnerId, current.revision, signal);
        requireCurrent(signal); return profile(resumed);
      } finally { this.#releaseMutation(action); }
    } }, profile(selected));
  }

  partnerImportEditor(storage: import("@joko/contracts").ImportReceiptStorage): import("@joko/contracts").PartnerImportEditor | undefined {
    const context = this.#partnerPrivateContext();
    if (!context || !this.network.partnerImportApi) return undefined;
    const api = this.network.partnerImportApi(context.credential, context.authorityKey, this.newId, signal => {
      signal.throwIfAborted();
      if (this.#partnerPrivateAuthorityKey(this.#state) !== context.authorityKey || this.#credential !== context.credential) throw new Error("IMPORT_OWNER_CHANGED");
    });
    const credential = context.credential;
    return new PartnerImportEditor(api, new PartnerImportReceipts(storage,
      JSON.stringify([credential.serverId, credential.profileId, credential.deviceId, new URL(credential.origin).href])));
  }

  partnerHomeApi(): import("@joko/contracts").PartnerHomeApi | undefined {
    const context = this.#partnerPrivateContext(); if (!context || !this.network.partnerHomeApi) return undefined;
    return this.network.partnerHomeApi(context.credential, context.authorityKey, signal => {
      signal.throwIfAborted(); if (this.#credential !== context.credential || this.#partnerPrivateAuthorityKey(this.#state) !== context.authorityKey) {
        throw new Error("The Partner home service owner changed.");
      }
    });
  }

  partnerSkillsEditor(partner: MobilePartnerDirectoryProfile, conversationOwnerKey: string): import("@joko/contracts").PartnerSkillsEditor | undefined {
    const context = this.#partnerPrivateContext();
    if (!context || !this.network.partnerSkillsApi || !partner.canonicalSessionId
      || !this.#partnerProfileOwnerMatches(conversationOwnerKey)) return undefined;
    const api = this.network.partnerSkillsApi(context.credential, partner.partnerId, conversationOwnerKey, signal => {
      signal.throwIfAborted();
      if (this.#partnerPrivateAuthorityKey(this.#state) !== context.authorityKey || this.#credential !== context.credential
        || !this.#partnerProfileOwnerMatches(conversationOwnerKey)) throw new Error("Partner skills owner changed.");
    });
    return new PartnerSkillsEditor(api, { partnerId: partner.partnerId, homeTargetId: partner.homeTargetId, canonicalSessionId: partner.canonicalSessionId });
  }

  partnerConnectionsEditor(partner: MobilePartnerDirectoryProfile, conversationOwnerKey?: string): import("@joko/contracts").PartnerConnectionsEditor | undefined {
    const context = this.#partnerPrivateContext();
    if (!context || !this.network.partnerConnectionsApi || !partner.canonicalSessionId
      || conversationOwnerKey !== undefined && !this.#partnerProfileOwnerMatches(conversationOwnerKey)) return undefined;
    const ownerKey = conversationOwnerKey ?? context.authorityKey;
    const api = this.network.partnerConnectionsApi(context.credential, partner.partnerId, ownerKey, signal => {
      signal.throwIfAborted();
      if (this.#partnerPrivateAuthorityKey(this.#state) !== context.authorityKey || this.#credential !== context.credential
        || conversationOwnerKey !== undefined && !this.#partnerProfileOwnerMatches(conversationOwnerKey)) throw new Error("Partner connections owner changed.");
    });
    return new PartnerConnectionsEditor(api, { partnerId: partner.partnerId, homeTargetId: partner.homeTargetId, canonicalSessionId: partner.canonicalSessionId });
  }

  partnerMemoryEditor(partner: MobilePartnerDirectoryProfile, conversationOwnerKey?: string): import("@joko/contracts").PartnerMemoryEditor | undefined {
    const context = this.#partnerPrivateContext();
    if (!context || !this.network.partnerMemoryApi || !partner.canonicalSessionId
      || conversationOwnerKey !== undefined && !this.#partnerProfileOwnerMatches(conversationOwnerKey)) return undefined;
    const ownerKey = conversationOwnerKey ?? context.authorityKey;
    const api = this.network.partnerMemoryApi(context.credential, partner.partnerId, ownerKey, signal => {
      signal.throwIfAborted();
      if (this.#partnerPrivateAuthorityKey(this.#state) !== context.authorityKey || this.#credential !== context.credential
        || conversationOwnerKey !== undefined && !this.#partnerProfileOwnerMatches(conversationOwnerKey)) {
        throw new Error("Partner memory owner changed.");
      }
    });
    return new PartnerMemoryEditor(api, { partnerId: partner.partnerId, homeTargetId: partner.homeTargetId, canonicalSessionId: partner.canonicalSessionId });
  }

  partnerGroupAttachmentTransport(): import("./mobile-partner-groups").MobileGroupAttachmentTransport | undefined {
    const context = this.#partnerPrivateContext(), files = this.attachmentFiles, api = this.partnerGroupApi();
    if (!context || !files || !this.network.listPartnerCatalog || !api) return undefined;
    if (this.#partnerGroupAttachments?.ownerKey === context.authorityKey) return this.#partnerGroupAttachments;
    const current = (signal: AbortSignal) => { signal.throwIfAborted(); if (this.#partnerPrivateAuthorityKey(this.#state) !== context.authorityKey || this.#credential !== context.credential) throw new Error("Group attachment owner changed."); };
    const photoLibrary = new MobilePhotoLibrary(files), camera = new MobileAttachmentCamera(files);
    const policyFor = async (group: import("@joko/contracts").PartnerGroupSummary, signal: AbortSignal) => {
        current(signal); const catalog = await this.network.listPartnerCatalog!(context.credential, signal); current(signal);
        const policies = catalog.partners.filter(partner => group.members.some(member => member.partnerId === partner.partnerId)).flatMap(partner => {
          const route = partner.capabilities.modelChain[0], backend = this.#state.owner?.backends.find(item => item.backendId === route?.backendId);
          const model = route ? resolveMobileExplicitNewTaskModelAuthority(this.#state.owner, route.backendId, { providerId: route.providerId, modelId: route.modelId, fastMode: route.fastMode, ...(route.effort ? { effortId: route.effort } : {}) }) : undefined;
          const policy = resolveMobileAttachmentPolicy(backend, model?.supportsImages === true); return policy ? [policy] : [];
        });
        if (!policies.length) throw new Error("No current group member accepts attachments.");
        const policy = { images: policies.some(item => item.images), files: policies.some(item => item.files), maximumItems: 20,
          maximumBytes: Math.min(...policies.map(item => item.maximumBytes)), imageMediaTypes: [...new Set(policies.flatMap(item => item.imageMediaTypes))],
          fileMediaTypes: policies.some(item => item.files && !item.fileMediaTypes.length) ? [] : [...new Set(policies.flatMap(item => item.fileMediaTypes))] };
        return policy;
    };
    const transport: import("./mobile-partner-groups").MobileGroupAttachmentTransport = { ownerKey: context.authorityKey, profileId: context.credential.profileId, photoLibrary,
      ...createMobileGroupMedia({ ownerKey: context.authorityKey, api, newId: this.newId, current, fileShare: this.fileShare,
        thumbnail: (blob, signal) => this.network.readImageThumbnail(context.credential, blob, 256, signal),
        download: (blob, signal) => this.network.downloadBlob(context.credential, blob, signal), authorize: (blob, signal) => this.network.authorizeBlobDownload(context.credential, blob, signal) }),
      ...createMobileGroupImageTools({ files, profileId: context.credential.profileId, newId: this.newId, current, policy: policyFor }),
      paste: async (group, existing, images, signal) => {
        const policy = await policyFor(group, signal);
        const staged = await new MobileComposerImagePaste(files).stage(context.credential.profileId, existing, policy, images, this.newId, signal);
        try { current(signal); return staged; }
        catch (error) { await Promise.all(staged.map(item => files.remove(context.credential.profileId, item))); throw error; }
      },
      removeReplacedImage: async (original, replacement) => { if (original.attachmentId === replacement.attachmentId) return;
        await files.removeVisibleBytes(context.credential.profileId, original);
        if (original.annotation && original.annotation.source.storageId !== replacement.annotation?.source.storageId) await files.removeOwnedBytes(context.credential.profileId, original.annotation.source.storageId);
      },
      pick: async (group, existing, signal, source = "files", assets) => {
        const policy = await policyFor(group, signal);
        const staged = source === "camera" ? await camera.captureAndStage(context.credential.profileId, existing, policy, this.newId, signal)
          : source === "photos" ? assets ? await photoLibrary.stageSelectedAssets(context.credential.profileId, existing, policy, assets, this.newId, signal)
            : await photoLibrary.pickSystemAndStage(context.credential.profileId, existing, policy, this.newId, signal)
          : await files.pickAndStage(context.credential.profileId, existing, policy, this.newId, signal);
        try {
          await waitForMobileAttachmentAuthority({ profileId: context.credential.profileId, surfaceOwnerKey: context.authorityKey },
            () => this.#partnerPrivateAuthorityKey(this.#state) ? { profileId: context.credential.profileId, surfaceOwnerKey: this.#partnerPrivateAuthorityKey(this.#state)!, policy } : undefined,
            listener => this.subscribe(() => listener()), { signal, retired: () => this.#disposed || this.#credential !== context.credential || this.#activeProfileId !== context.credential.profileId || ["unpaired", "revoked"].includes(this.#state.status) });
          current(signal); return staged;
        } catch (error) { await Promise.all(staged.map(item => files.remove(context.credential.profileId, item))); throw error; }
      },
      upload: async (attachment, signal) => {
        current(signal); const source = await files.verifyForUpload(context.credential.profileId, attachment, signal); current(signal);
        const blob = await this.network.uploadBlob(context.credential, source, signal); current(signal);
        return create(PartnerGroupAttachmentSchema, { id: attachment.attachmentId, name: attachment.fileName, blob, annotated: attachment.annotation !== undefined,
          category: attachment.kind === "image" ? PartnerGroupAttachmentCategory.IMAGE : attachment.mediaType === "application/pdf" ? PartnerGroupAttachmentCategory.PDF : attachment.mediaType.startsWith("text/") ? PartnerGroupAttachmentCategory.TEXT : PartnerGroupAttachmentCategory.FILE });
      }, remove: attachment => files.remove(context.credential.profileId, attachment) };
    this.#partnerGroupAttachments = transport;
    return transport;
  }

  partnerGroupReceiptScope(): string | undefined {
    const credential = this.#credential;
    return credential ? JSON.stringify([credential.serverId, credential.profileId, credential.deviceId, new URL(credential.origin).href]) : undefined;
  }

  partnerGroupApi(): import("@joko/contracts").PartnerGroupApi | undefined {
    const context = this.#partnerPrivateContext(); if (!context || !this.network.partnerGroupApi) return undefined;
    return this.network.partnerGroupApi(context.credential, context.authorityKey, this.newId, signal => {
      signal.throwIfAborted(); if (this.#partnerPrivateAuthorityKey(this.#state) !== context.authorityKey || this.#credential !== context.credential) throw new Error("Partner group owner changed.");
    });
  }
  partnerNetworkApi(): import("./mobile-partner-network").MobilePartnerNetworkApi | undefined {
    const context = this.#partnerPrivateContext(), ownerSignal = this.#abort?.signal, epoch = this.#epoch;
    if (!context || !this.network.partnerNetworkApi || !ownerSignal || this.#joinedTask) return undefined;
    return this.network.partnerNetworkApi(context.credential, `${context.authorityKey}:${epoch}`, signal => {
      signal.throwIfAborted(); ownerSignal.throwIfAborted();
      if (!this.#current(epoch) || this.#credential !== context.credential || this.#partnerPrivateAuthorityKey(this.#state) !== context.authorityKey) throw new Error("The group conversation owner changed.");
    });
  }
  partnerIdentityApi(): import("./mobile-partner-identity").MobilePartnerIdentityApi | undefined {
    const context = this.#partnerPrivateContext(), ownerSignal = this.#abort?.signal, epoch = this.#epoch;
    if (!context || !this.network.partnerIdentityApi || !ownerSignal || this.#joinedTask) return undefined;
    return this.network.partnerIdentityApi(context.credential, `${context.authorityKey}:${epoch}`, signal => {
      signal.throwIfAborted(); ownerSignal.throwIfAborted();
      if (!this.#current(epoch) || this.#joinedTask || this.#credential !== context.credential || this.#partnerPrivateAuthorityKey(this.#state) !== context.authorityKey) throw new Error("The Partner identity owner changed.");
    });
  }

  inputHandoffTasksApi(): MobileInputHandoffTasksApi | undefined {
    const context = this.#partnerPrivateContext(), read = this.network.listInputHandoffTasks, ownerSignal = this.#abort?.signal, epoch = this.#epoch;
    if (!context || !read || !ownerSignal || this.#joinedTask) return undefined;
    const ownerKey = `${context.authorityKey}\u001f${epoch}`;
    const current = () => !ownerSignal.aborted && this.#current(epoch) && !this.#joinedTask && this.#credential === context.credential
      && this.#partnerPrivateAuthorityKey(this.#state) === context.authorityKey;
    return { ownerKey, isCurrent: current, list: async signal => {
      const active = AbortSignal.any([signal, ownerSignal]); active.throwIfAborted(); if (!current()) throw new Error("The input task owner changed.");
      const tasks = await read.call(this.network, context.credential, active); active.throwIfAborted(); if (!current()) throw new Error("The input task owner changed.");
      return tasks.filter(task => this.#state.owner?.sessions.some(session => !session.archived && session.sessionId === task.sessionId
        && session.nativeBinding?.runtimeGeneration === task.generation));
    } };
  }

  taskInputHandoffApi(): MobileInputHandoffApi | undefined {
    const credential = this.#credential, ownerKey = this.taskHeaderSourceKey(), session = this.#selectedSession();
    if (this.#joinedTask || !credential || !ownerKey || !session || session.archived || !this.#foreground
      || this.#state.status !== "connected" || !this.#abort || !this.network.inputHandoffApi) return undefined;
    const signal = this.#abort.signal;
    return this.network.inputHandoffApi(credential, { ownerKey, sessionId: session.sessionId, deviceId: credential.deviceId, signal,
      assertCurrent: active => { active.throwIfAborted(); signal.throwIfAborted();
        if (this.#credential !== credential || this.#joinedTask || !this.#foreground || this.taskHeaderSourceKey() !== ownerKey
          || this.#selectedSession()?.archived) throw new Error("The input handoff owner changed."); } });
  }

  mcpAppApi(sessionId: string): import("./mobile-mcp-app-api").MobileMcpAppApi | undefined {
    const credential = this.#credential;
    if (!credential || this.#state.status !== "connected" || this.#state.selectedId !== sessionId || this.#state.taskSource?.kind === "joined") return undefined;
    const source = this.network.mcpAppApi?.(credential, JSON.stringify([credential.profileId, credential.connectionId, sessionId]));
    if (!source) return undefined;
    const current = () => { if (this.#credential !== credential || this.#state.status !== "connected" || this.#state.selectedId !== sessionId)
      throw new Error("The application card owner changed."); };
    return { ownerKey: source.ownerKey, metadata: (request, signal) => {
      // Cleanup remains attached to the original Connection after navigation.
      if (request.operation !== McpAppOperation.CANCEL_OPEN && request.operation !== McpAppOperation.TEARDOWN) current();
      return source.metadata({ ...request, sessionId }, signal);
    }, native: (request, signal) => {
      const response = request.operation === McpAppNativeOperation.MESSAGE && typeof request.messageJson === "string" && !JSON.parse(request.messageJson).method;
      if (request.operation !== McpAppNativeOperation.POLL && !response) current();
      const bound = create(McpAppNativeServiceOperateRequestSchema, request);
      bound.view ??= create(McpAppServiceOperateRequestSchema); bound.view.sessionId = sessionId;
      return source.native(bound, signal);
    } };
  }

  extensionCardApi(sessionId: string): import("./mobile-extension-card-api").MobileExtensionCardApi | undefined {
    const credential = this.#credential, authority = this.#taskAuthorityKey();
    if (!credential || !authority || this.#state.status !== "connected" || this.#state.selectedId !== sessionId || this.#state.taskSource?.kind === "joined" || this.#selectedSession()?.archived) return;
    const source = this.network.extensionCardApi?.(credential);
    if (!source) return;
    const current = () => { if (this.#credential !== credential || this.#taskAuthorityKey() !== authority || this.#state.status !== "connected" || this.#state.selectedId !== sessionId || this.#selectedSession()?.archived) throw new Error("Extension card owner changed."); };
    return { formScope: source.formScope,
      beginAttachment: async (request, options) => { current(); options?.signal?.throwIfAborted(); const value = await source.beginAttachment({ ...request, sessionId }, options); current(); return value; },
      readMedia: async (request, options) => { current(); options?.signal?.throwIfAborted(); const value = await source.readMedia({ ...request, sessionId }, options); current(); return value; },
      previewMedia: async (cardId, uri) => { current(); await this.#previewExtensionCardMedia(sessionId, cardId, uri, current); },
      prepareAudio: this.mediaPreviewFiles ? async (cardId, uri, signal) => {
        current(); signal.throwIfAborted();
        if (!/^joko-media:\/\/blobs\/[a-f0-9]{64}\.(mp3|wav|m4a)$/u.test(uri)) throw new Error("Extension audio unavailable.");
        const { blob } = await source.readMedia({ sessionId, cardId, uri, metadataOnly: true }, { signal });
        current(); signal.throwIfAborted(); if (!blob) throw new Error("Extension audio unavailable.");
        const download = await this.network.downloadBlob(credential, blob, signal); current(); signal.throwIfAborted();
        if (normalizeMediaType(download.mediaType) !== blob.mediaType || BigInt(download.bytes.length) !== blob.byteSize || bytesToHex(sha256(download.bytes)) !== blob.sha256Hex) throw new Error("Extension audio changed.");
        const staged = await this.mediaPreviewFiles!.stage(credential.profileId, this.newId(), blob.fileName, blob.mediaType, blob.sha256Hex, download.bytes, signal);
        try {
          current(); signal.throwIfAborted();
          const checked = await source.readMedia({ sessionId, cardId, uri, metadataOnly: true }, { signal });
          current(); signal.throwIfAborted(); if (checked.blob?.blobId !== blob.blobId || checked.blob.sha256Hex !== blob.sha256Hex) throw new Error("Extension audio changed.");
          return { uri: staged.uri, mediaType: blob.mediaType, instanceId: this.newId(), release: () => this.mediaPreviewFiles!.remove(staged) };
        } catch (error) { await this.mediaPreviewFiles!.remove(staged).catch(() => undefined); throw error; }
      } : undefined,
      uploadAttachment: async (_sessionId, cardId, file, inline, signal) => { current(); const value = await source.uploadAttachment(sessionId, cardId, file, inline, signal); current(); return value; },
      pickAttachment: this.attachmentFiles ? async (cardId, inline, signal) => {
        current(); const files = this.attachmentFiles!, policy = { images: true, files: !inline, maximumItems: 1, maximumBytes: 16 * 1024 * 1024,
          imageMediaTypes: ["image/png", "image/jpeg", "image/gif", "image/webp"], fileMediaTypes: [] };
        const staged = await files.pickAndStage(credential.profileId, [], policy, this.newId, signal);
        try {
          current(); signal.throwIfAborted(); const selected = staged[0]; if (!selected) return;
          const verified = await files.verifyForUpload(credential.profileId, selected, signal); current(); signal.throwIfAborted();
          const value = await source.uploadAttachment(sessionId, cardId, verified, inline, signal); current(); return value;
        } finally { await Promise.all(staged.map(file => files.remove(credential.profileId, file).catch(() => undefined))); }
      } : undefined,
      previewMail: async (request, options) => { current(); options?.signal?.throwIfAborted(); const value = await source.previewMail({ ...request, sessionId }, options); current(); return value; },
      get: async (request, options) => { current(); options?.signal?.throwIfAborted(); const value = await source.get({ ...request, sessionId }, options); current(); return value; },
      dispatch: async (request, options) => { current(); options?.signal?.throwIfAborted(); const value = await source.dispatch({ ...request, sessionId }, options); current(); return value; },
      authorizeLink: async (request, options) => { current(); options?.signal?.throwIfAborted(); const value = await source.authorizeLink({ ...request, sessionId }, options); current(); return value; }
    };
  }

  partnerAutonomyApi(conversationOwnerKey: string): import("@joko/contracts").PartnerAutonomyApi | undefined {
    const context = this.#partnerPrivateContext();
    if (!context || !this.network.partnerAutonomyApi || this.partnerConversationTransport()?.ownerKey !== conversationOwnerKey) return undefined;
    return this.network.partnerAutonomyApi(context.credential, conversationOwnerKey, this.newId, signal => {
      signal.throwIfAborted();
      if (this.#credential !== context.credential || this.#partnerPrivateAuthorityKey(this.#state) !== context.authorityKey
        || this.partnerConversationTransport()?.ownerKey !== conversationOwnerKey) throw new Error("The Partner glance owner changed.");
    });
  }

  partnerResourceTransport(): MobilePartnerResourceTransport | undefined {
    const context = this.#partnerPrivateContext();
    if (!context) return undefined;
    const ownerKey = context.authorityKey;
    const current = (): boolean => this.#partnerPrivateAuthorityKey(this.#state) === ownerKey
      && this.#credential === context.credential;
    const requireCurrent = (signal: AbortSignal): void => {
      signal.throwIfAborted();
      if (!current()) throw new Error("The Partner Resource owner changed.");
    };
    const readPartners = async (signal: AbortSignal): Promise<readonly MobilePartner[]> => {
      requireCurrent(signal);
      const partners = await this.network.listPartners(context.credential, signal);
      requireCurrent(signal);
      return partners;
    };
    const exactPartner = (partners: readonly MobilePartner[], partnerId: string): MobilePartner => {
      if (!validMobilePartnerId(partnerId)) throw new Error("Select a current Partner Resource.");
      const matches = partners.filter((partner) => partner.partnerId === partnerId);
      if (matches.length !== 1) throw new Error("The selected Partner Resource is no longer available.");
      const partner = matches[0]!;
      if (partner.lifecycle !== "active" || partner.initializationState !== "ready"
        || partner.canonicalSessionId === undefined) {
        throw new Error("The selected Partner Resource does not have an available canonical task.");
      }
      return partner;
    };
    return {
      ownerKey,
      list: readPartners,
      preview: async (partnerId, signal) => {
        const initial = exactPartner(await readPartners(signal), partnerId);
        const sessions = await this.network.listPartnerSessions(context.credential, initial.partnerId, signal);
        requireCurrent(signal);
        assertMobileCanonicalPartnerSession(initial, initial.canonicalSessionId!, sessions);
        const catalog = await this.network.listSessionArtifacts(context.credential, initial.canonicalSessionId!, signal);
        requireCurrent(signal);
        const finalPartner = exactPartner(await readPartners(signal), partnerId);
        if (mobilePartnerResourceKey(finalPartner) !== mobilePartnerResourceKey(initial)) {
          throw new Error("The Partner Resource changed while its preview was loading.");
        }
        const finalSessions = await this.network.listPartnerSessions(context.credential, finalPartner.partnerId, signal);
        requireCurrent(signal);
        return projectMobilePartnerResourcePreview(finalPartner, finalSessions, catalog);
      },
      open: async (preview: MobilePartnerResourcePreview, signal) => {
        requireCurrent(signal);
        const partner = exactPartner(await readPartners(signal), preview.partner.partnerId);
        if (mobilePartnerResourceKey(partner) !== preview.resourceKey
          || partner.canonicalSessionId !== preview.session.sessionId) {
          throw new Error("The Partner Resource changed; refresh its preview before opening it.");
        }
        const sessions = await this.network.listPartnerSessions(context.credential, partner.partnerId, signal);
        requireCurrent(signal);
        assertMobileCanonicalPartnerSession(partner, preview.session.sessionId, sessions);
        const visible = this.#state.owner?.sessions.filter((session) => session.sessionId === preview.session.sessionId) ?? [];
        if (visible.length !== 1 || visible[0]!.archived
          || visible[0]!.state === SessionState.ARCHIVED || visible[0]!.state === SessionState.CLOSED) {
          throw new Error("The Partner canonical task is not available in the current task directory.");
        }
        requireCurrent(signal);
        await this.select(preview.session.sessionId);
        requireCurrent(signal);
        if (this.#state.selectedId !== preview.session.sessionId) {
          throw new Error("The Partner canonical task was not selected by the current owner.");
        }
        return preview.session.sessionId;
      }
    };
  }

  extensionCatalogTransport(): MobileExtensionTransport | undefined {
    const context = this.#partnerPrivateContext();
    if (!context) return this.#extensionOAuthRetention?.current() ? this.#extensionOAuthRetention.transport : undefined;
    const ownerKey = context.authorityKey;
    let retired = false;
    const isCurrent = (): boolean => !retired && this.#partnerPrivateAuthorityKey(this.#state) === ownerKey
      && this.#credential === context.credential;
    const requireCurrent = (signal: AbortSignal): void => {
      if (signal.aborted || !isCurrent()) {
        throw new Error("The Extension catalog owner changed or the request was cancelled.");
      }
    };
    const owned = async <T>(signal: AbortSignal, effect: (current: AbortSignal) => Promise<T>): Promise<T> => {
      const request = new AbortController();
      const cancel = (): void => request.abort();
      if (signal.aborted) request.abort();
      else signal.addEventListener("abort", cancel, { once: true });
      const unsubscribe = this.subscribe(() => {
        if (!isCurrent()) {
          if (!(this.#extensionOAuthRetention?.transport === transport && settingsOwnerCurrent())) retired = true;
          request.abort();
        }
      });
      try {
        requireCurrent(request.signal);
        const value = await effect(request.signal);
        requireCurrent(request.signal);
        return value;
      } finally {
        request.abort();
        unsubscribe();
        signal.removeEventListener("abort", cancel);
      }
    };
    const readExactDetail = async (expected: MobileExtension, signal: AbortSignal, installed = true): Promise<MobileExtension> => {
      requireCurrent(signal);
      if (installed && !expected.installed) throw new Error("Select an installed Extension.");
      const extension = await this.network.getExtension(context.credential, expected.extensionId, signal);
      requireCurrent(signal);
      if (mobileExtensionKey(extension) !== mobileExtensionKey(expected)) {
        throw new Error("The Extension changed; refresh the catalog before using its details.");
      }
      return extension;
    };
    const refreshExact = async (extensionId: string, signal: AbortSignal): Promise<MobileExtensionMutationResult> => {
      const catalog = await this.network.listExtensions(context.credential, signal);
      requireCurrent(signal);
      const matches = catalog.extensions.filter((extension) => extension.extensionId === extensionId);
      if (matches.length !== 1) throw new Error("The changed Extension is no longer in the installed catalog.");
      const extension = await this.network.getExtension(context.credential, extensionId, signal);
      requireCurrent(signal);
      if (mobileExtensionKey(extension) !== mobileExtensionKey(matches[0]!)) {
        throw new Error("The Extension changed while its current state was being refreshed.");
      }
      return { catalog, extension };
    };
    const pendingForExtension = (extensionId: string): boolean => this.#state.pending.some((receipt) =>
      receipt.connectionId === context.credential.connectionId && receipt.extensionId === extensionId
      && isMobileExtensionReceiptKind(receipt.kind));
    const submitExtensionMutation = async (
      extension: MobileExtension,
      receiptKind: MobileExtensionReceiptKind,
      mutation: OperationMutation,
      signal: AbortSignal,
      verify: (current: MobileExtension) => boolean
    ): Promise<MobileExtensionMutationResult> => {
      const result = await this.#submitTerminal(mutation, {
        kind: receiptKind,
        extensionId: extension.extensionId,
        extensionRevision: extension.revision.toString(10)
      }, undefined, false, false, {
        signal,
        isCurrent,
        beforeTerminalReceipt: async (operation) => {
          if (operation.state === OperationState.SUCCEEDED) this.#assertExtensionMutationAcknowledgement(operation);
        }
      });
      requireCurrent(signal);
      if (!result.definitive) {
        throw new Error("The Extension change result is unknown. Check its operation receipt; the change was not resent.");
      }
      if (!result.accepted || result.operation?.state !== OperationState.SUCCEEDED) {
        throw new Error(result.operation?.error?.message || "The Extension change was rejected.");
      }
      const refreshed = await refreshExact(extension.extensionId, signal);
      if (!verify(refreshed.extension)) {
        throw new Error("The Extension changed again before its updated state could be confirmed.");
      }
      return refreshed;
    };
    const mutate = (
      expected: MobileExtension,
      kind: "enabled" | "sidebar",
      value: boolean,
      signal: AbortSignal
    ): Promise<MobileExtensionMutationResult> => owned(signal, async (current) => {
      const extension = await readExactDetail(expected, current);
      if (kind === "sidebar" && !extension.sidebarSupported) {
        throw new Error("This Extension does not provide a sidebar main view.");
      }
      if (pendingForExtension(extension.extensionId)) {
        throw new Error("A previous change to this Extension still has an unresolved result. Check its operation receipt first.");
      }
      if (kind === "enabled" ? extension.enabled === value : extension.sidebarVisible === value) {
        return refreshExact(extension.extensionId, current);
      }
      const action = this.#claimMutation();
      try {
        const mutation = create(OperationMutationSchema, {
          payload: kind === "enabled"
            ? { case: "setExtensionEnabled", value: {
                extensionId: extension.extensionId,
                enabled: value,
                expectedRevision: { value: extension.revision }
              } }
            : { case: "setExtensionSidebarVisible", value: {
                extensionId: extension.extensionId,
                visible: value,
                expectedRevision: { value: extension.revision }
              } }
        });
        return submitExtensionMutation(
          extension,
          kind === "enabled" ? "extension-enabled" : "extension-sidebar",
          mutation,
          current,
          (refreshed) => kind === "enabled" ? refreshed.enabled === value : refreshed.sidebarVisible === value
        );
      } finally {
        this.#releaseMutation(action);
      }
    });
    const activeSetupAttempt = (extension: MobileExtension): string => {
      if (extension.setup.state !== "inProgress" || extension.setup.attemptId === undefined) {
        throw new Error("Begin a current Extension setup attempt before changing its fields.");
      }
      return extension.setup.attemptId;
    };
    const setupField = (extension: MobileExtension, fieldId: string) => {
      const matches = extension.setup.fields.filter((field) => field.fieldId === fieldId);
      if (matches.length !== 1) throw new Error("Select a current Extension setup field.");
      return matches[0]!;
    };
    const setupMutation = (
      expected: MobileExtension,
      receiptKind: Exclude<MobileExtensionReceiptKind, "extension-enabled" | "extension-sidebar" | "extension-package-adopt" | "extension-package-remove" | "extension-settings-routing" | "extension-settings-credential-clear" | "extension-settings-directory">,
      prepare: (
        extension: MobileExtension,
        signal: AbortSignal
      ) => Promise<{ readonly mutation: OperationMutation; readonly verify: (current: MobileExtension) => boolean }>
        | { readonly mutation: OperationMutation; readonly verify: (current: MobileExtension) => boolean },
      signal: AbortSignal
    ): Promise<MobileExtensionMutationResult> => owned(signal, async (current) => {
      const extension = await readExactDetail(expected, current);
      if (pendingForExtension(extension.extensionId)) {
        throw new Error("A previous change to this Extension still has an unresolved result. Check its operation receipt first.");
      }
      const action = this.#claimMutation();
      try {
        const prepared = await prepare(extension, current);
        requireCurrent(current);
        return await submitExtensionMutation(extension, receiptKind, prepared.mutation, current, prepared.verify);
      } finally {
        this.#releaseMutation(action);
      }
    });
    const beginSetup = (expected: MobileExtension, signal: AbortSignal) => setupMutation(
      expected,
      "extension-setup-begin",
      (extension) => {
        if (extension.setup.state !== "required" && extension.setup.state !== "cancelled"
          && extension.setup.state !== "failed" && extension.setup.state !== "ready") {
          throw new Error("This Extension setup cannot be started from its current state.");
        }
        return {
          mutation: create(OperationMutationSchema, { payload: { case: "beginExtensionSetup", value: {
            extensionId: extension.extensionId,
            expectedRevision: { value: extension.revision }
          } } }),
          verify: (current) => current.setup.state === "inProgress" && current.setup.attemptId !== undefined
        };
      },
      signal
    );
    const submitSetupInteraction = (
      expected: MobileExtension,
      fieldId: string,
      value: string | boolean,
      signal: AbortSignal
    ) => setupMutation(expected, "extension-setup-interaction", (extension) => {
      const attemptId = activeSetupAttempt(extension);
      const field = setupField(extension, fieldId);
      let wireValue: { readonly case: "text"; readonly value: string }
        | { readonly case: "confirmed"; readonly value: boolean };
      let expectedConfigured: boolean;
      if (field.kind === "confirmation") {
        if (typeof value !== "boolean") throw new Error("This Extension setup confirmation requires a yes or no value.");
        wireValue = { case: "confirmed", value };
        expectedConfigured = value;
      } else {
        if (field.kind !== "text" || typeof value !== "string") {
          throw new Error("This Extension setup field must use its protected credential channel.");
        }
        const normalized = value.trim();
        if (normalized.length === 0 || normalized.length > 8_192 || normalized.includes("\0")) {
          throw new Error("The Extension setup value is invalid.");
        }
        if (field.options.length > 0 && !field.options.includes(normalized)) {
          throw new Error("Select one of the current Extension setup choices.");
        }
        wireValue = { case: "text", value: normalized };
        expectedConfigured = true;
      }
      return {
        mutation: create(OperationMutationSchema, { payload: { case: "submitExtensionSetupInteraction", value: {
          extensionId: extension.extensionId,
          attemptId,
          fieldId: field.fieldId,
          value: wireValue,
          expectedRevision: { value: extension.revision }
        } } }),
        verify: (current) => current.setup.state === "inProgress"
          && current.setup.attemptId === attemptId
          && current.setup.fields.find((candidate) => candidate.fieldId === field.fieldId)?.configured === expectedConfigured
      };
    }, signal);
    const saveSetupCredential = (
      expected: MobileExtension,
      fieldId: string,
      kind: MobileExtensionCredentialKind,
      secret: string,
      signal: AbortSignal
    ) => setupMutation(expected, "extension-setup-credential", async (extension, current) => {
      const attemptId = activeSetupAttempt(extension);
      const field = setupField(extension, fieldId);
      if (field.kind !== "secret" && field.kind !== "oauth") {
        throw new Error("This Extension setup field does not accept a protected credential.");
      }
      if (field.kind === "oauth" && kind !== "oauth") {
        throw new Error("This Extension setup field requires an OAuth credential.");
      }
      if (secret.length === 0 || secret.length > 64 * 1024 || secret.includes("\0")) {
        throw new Error("The Extension credential input is invalid.");
      }
      const ticketId = await this.network.uploadExtensionSetupCredential(
        context.credential,
        extension.extensionId,
        attemptId,
        field.fieldId,
        kind,
        secret,
        current
      );
      requireCurrent(current);
      return {
        mutation: create(OperationMutationSchema, { payload: { case: "commitExtensionSetupCredential", value: {
          extensionId: extension.extensionId,
          attemptId,
          fieldId: field.fieldId,
          credentialUploadTicketId: ticketId,
          expectedRevision: { value: extension.revision }
        } } }),
        verify: (refreshed) => refreshed.setup.state === "inProgress"
          && refreshed.setup.attemptId === attemptId
          && refreshed.setup.fields.find((candidate) => candidate.fieldId === field.fieldId)?.configured === true
      };
    }, signal);
    const completeSetup = (expected: MobileExtension, signal: AbortSignal) => setupMutation(
      expected,
      "extension-setup-complete",
      (extension) => {
        const attemptId = activeSetupAttempt(extension);
        if (extension.setup.fields.some((field) => field.required && !field.configured)) {
          throw new Error("Complete every required Extension setup field first.");
        }
        return {
          mutation: create(OperationMutationSchema, { payload: { case: "completeExtensionSetup", value: {
            extensionId: extension.extensionId,
            attemptId,
            expectedRevision: { value: extension.revision }
          } } }),
          verify: (current) => current.setup.state === "ready"
        };
      },
      signal
    );
    const cancelSetup = (expected: MobileExtension, signal: AbortSignal) => setupMutation(
      expected,
      "extension-setup-cancel",
      (extension) => {
        const attemptId = activeSetupAttempt(extension);
        return {
          mutation: create(OperationMutationSchema, { payload: { case: "cancelExtensionSetup", value: {
            extensionId: extension.extensionId,
            attemptId,
            expectedRevision: { value: extension.revision }
          } } }),
          verify: (current) => current.setup.state === "cancelled"
        };
      },
      signal
    );
    const revokeSetup = (expected: MobileExtension, signal: AbortSignal) => setupMutation(
      expected,
      "extension-setup-revoke",
      (extension) => {
        if (extension.setup.state !== "ready") throw new Error("Only a ready Extension setup can be revoked.");
        return {
          mutation: create(OperationMutationSchema, { payload: { case: "revokeExtensionSetup", value: {
            extensionId: extension.extensionId,
            expectedRevision: { value: extension.revision }
          } } }),
          verify: (current) => current.setup.state === "required"
            && current.setup.attemptId === undefined
            && current.setup.fields.every((field) => !field.configured)
        };
      },
      signal
    );
    const useCommand = (
      expected: MobileExtension,
      command: MobileExtensionCommand,
      destination: MobileExtensionUseDestination,
      signal: AbortSignal
    ): Promise<MobileExtensionUseResult> => {
      if (destination.kind === "newTask") return owned(signal, async (current) => {
        if (pendingForExtension(expected.extensionId)) {
          throw new Error("A previous change to this Extension still has an unresolved result. Check its operation receipt first.");
        }
        if (!this.newTaskDrafts) throw new Error("Retained new-task drafts are unavailable on this mobile client.");
        const profileId = context.credential.profileId;
        assertMobileExtensionTaskChoice(this.#state.owner, expected, command.sessionId);
        const fresh = await this.network.getExtensionForRuntime(
          context.credential,
          expected.extensionId,
          command.sessionId,
          current
        );
        const resolved = resolveMobileExtensionUseCommand(expected, command, fresh, command.sessionId);
        assertMobileExtensionTaskChoice(this.#state.owner, fresh, command.sessionId);
        const targetId = mobileExtensionNewTaskTarget(this.#state.owner, fresh);
        const identity = { profileId };
        const snapshot = await this.newTaskDrafts.readSnapshot(identity);
        requireCurrent(current);
        if (snapshot.draft?.submission !== undefined) {
          throw new Error("The current new-task draft is already being submitted.");
        }
        const original = snapshot.draft ?? { targetId: "", name: "", input: emptyMobileComposerDraft() };
        const next = {
          targetId: targetId ?? original.targetId,
          name: original.name,
          input: applyMobileExtensionUseCommand(original.input, resolved.name, false)
        };
        if (!this.newTaskDrafts.saveIfRevision(identity, next, snapshot.revision)) {
          throw new Error("The new-task draft changed. The Extension command was not inserted.");
        }
        try {
          await this.newTaskDrafts.flush(identity);
          requireCurrent(current);
          if (mobileExtensionNewTaskTarget(this.#state.owner, fresh) !== targetId) {
            throw new Error("The Extension project changed before its command handoff completed.");
          }
        } catch (failure) {
          try {
            const committed = await this.newTaskDrafts.readSnapshot(identity);
            if (committed.draft?.submission === undefined
              && committed.draft?.targetId === next.targetId && committed.draft.name === next.name
              && mobileComposerDraftsEqual(committed.draft.input, next.input)) {
              const original = snapshot.draft ?? { targetId: "", name: "", input: emptyMobileComposerDraft() };
              if (this.newTaskDrafts.saveIfRevision(identity, original, committed.revision)) {
                await this.newTaskDrafts.flush(identity);
              }
            }
          } catch {
            // A concurrent draft edit owns the newer state and must not be overwritten.
          }
          throw failure;
        }
        return { kind: "newTask" };
      });

      return (async (): Promise<MobileExtensionUseResult> => {
        if (!this.composerDrafts) throw new Error("Retained task drafts are unavailable on this mobile client.");
        const prepared = await owned(signal, async (current) => {
          if (pendingForExtension(expected.extensionId)) {
            throw new Error("A previous change to this Extension still has an unresolved result. Check its operation receipt first.");
          }
          const profileId = context.credential.profileId;
          assertMobileExtensionTaskChoice(this.#state.owner, expected, destination.sessionId);
          const fresh = await this.network.getExtensionForRuntime(
            context.credential,
            expected.extensionId,
            destination.sessionId,
            current
          );
          const resolved = resolveMobileExtensionUseCommand(expected, command, fresh, destination.sessionId);
          assertMobileExtensionTaskChoice(this.#state.owner, fresh, destination.sessionId);
          const identity = { profileId, sessionId: destination.sessionId };
          const snapshot = await this.composerDrafts!.readSnapshot(identity);
          requireCurrent(current);
          assertMobileExtensionTaskChoice(this.#state.owner, fresh, destination.sessionId);
          const next = applyMobileExtensionUseCommand(snapshot.draft ?? emptyMobileComposerDraft(), resolved.name, true);
          if (!this.composerDrafts!.saveIfRevision(identity, next, snapshot.revision)) {
            throw new Error("The task draft changed. The Extension command was not inserted.");
          }
          await this.composerDrafts!.flush(identity);
          requireCurrent(current);
          return { fresh, identity, snapshot, next };
        });
        try {
          if (signal.aborted || this.#credential !== context.credential
            || this.#activeProfileId !== context.credential.profileId) {
            throw new Error("The Extension catalog owner changed or the request was cancelled.");
          }
          assertMobileExtensionTaskChoice(this.#state.owner, prepared.fresh, destination.sessionId);
          await this.select(destination.sessionId);
          if (signal.aborted || this.#credential !== context.credential
            || this.#activeProfileId !== context.credential.profileId
            || this.#state.status !== "connected" || this.#state.selectedId !== destination.sessionId) {
            throw new Error("The selected task did not remain current after the Extension command was inserted.");
          }
          assertMobileExtensionTaskChoice(this.#state.owner, prepared.fresh, destination.sessionId);
        } catch (failure) {
          try {
            const committed = await this.composerDrafts.readSnapshot(prepared.identity);
            if (committed.draft && mobileComposerDraftsEqual(committed.draft, prepared.next)) {
              const restored = prepared.snapshot.draft
                ? this.composerDrafts.saveIfRevision(prepared.identity, prepared.snapshot.draft, committed.revision)
                : await this.composerDrafts.clearIfRevision(prepared.identity, committed.revision);
              if (restored) await this.composerDrafts.flush(prepared.identity);
            }
          } catch {
            // A concurrent draft edit owns the newer state and must not be overwritten.
          }
          throw failure;
        }
        return { kind: "task", sessionId: destination.sessionId };
      })();
    };
    const openMainView = async (
      expected: MobileExtension,
      signal: AbortSignal
    ): Promise<MobileExtensionMainViewSurface> => {
      let opened: MobileExtensionMainViewSurface | undefined;
      try {
        return await owned(signal, async (current) => {
          if (pendingForExtension(expected.extensionId)) {
            throw new Error("A previous change to this Extension still has an unresolved result. Check its operation receipt first.");
          }
          const extension = await readExactDetail(expected, current);
          opened = await this.network.openExtensionMainView(
            context.credential,
            extension.extensionId,
            extension.revision,
            current
          );
          requireCurrent(current);
          assertMobileExtensionMainViewSurface(extension, opened);
          return opened;
        });
      } catch (error) {
        if (opened !== undefined) {
          await this.network.closeExtensionMainView(context.credential, opened.surfaceId).catch(() => undefined);
        }
        throw error;
      }
    };
    const probeMainView = (
      expected: MobileExtensionMainViewSurface,
      signal: AbortSignal
    ): Promise<MobileExtensionMainViewSurface> => owned(signal, async (current) => {
      const surface = await this.network.getExtensionMainViewSurface(context.credential, expected.surfaceId, current);
      requireCurrent(current);
      if (!sameMobileExtensionMainViewSurface(expected, surface) || surface.expiresAt <= Date.now()) {
        throw new Error("The Extension main-view surface changed or expired.");
      }
      return surface;
    });
    const readLibrarySnapshot = async (
      expected: MobileExtension,
      signal: AbortSignal
    ): Promise<{ readonly extension: MobileExtension; readonly snapshot: MobileExtensionLibrarySnapshot }> => {
      const extension = await readExactDetail(expected, signal);
      if (!mobileExtensionLibrarySupported(extension)) {
        throw new Error("This Extension does not own a current Resource Library.");
      }
      const overview = mobileExtensionLibraryReady(extension)
        ? this.network.getExtensionLibraryOverview(
          context.credential,
          extension.extensionId,
          extension.revision,
          signal
        )
        : Promise.resolve(undefined);
      const [currentOverview, trash, grace] = await Promise.all([
        overview,
        this.network.listExtensionLibraryTrash(context.credential, extension.extensionId, signal),
        this.network.listExtensionLibraryGrace(context.credential, extension.extensionId, signal)
      ]);
      requireCurrent(signal);
      return {
        extension,
        snapshot: {
          ...(currentOverview === undefined ? {} : { overview: currentOverview }),
          trash,
          grace
        }
      };
    };
    const libraryLeases = new Map<MobileExtensionLibrarySession, {
      readonly extensionKey: string; readonly surface: MobileExtensionMainViewSurface;
    }>();
    const requireLibrarySurface = async (
      expected: MobileExtension, surface: MobileExtensionMainViewSurface, signal: AbortSignal
    ): Promise<MobileExtension> => {
      if (pendingForExtension(expected.extensionId)) {
        throw new Error("Check the unresolved Extension change before using its Library.");
      }
      const extension = await readExactDetail(expected, signal);
      if (!mobileExtensionLibraryReady(extension)) throw new Error("The Extension Library is not ready.");
      assertMobileExtensionMainViewSurface(extension, surface);
      const fresh = await this.network.getExtensionMainViewSurface(context.credential, surface.surfaceId, signal);
      requireCurrent(signal);
      if (!sameMobileExtensionMainViewSurface(surface, fresh)) throw new Error("The Library main-view surface changed.");
      assertMobileExtensionMainViewSurface(extension, fresh);
      return extension;
    };
    const closeLibrary = async (session: MobileExtensionLibrarySession): Promise<boolean> => {
      if (!libraryLeases.delete(session)) return false;
      return this.network.closeExtensionLibrary(context.credential, session.id);
    };
    const openLibrary = async (
      expected: MobileExtension, surface: MobileExtensionMainViewSurface, signal: AbortSignal
    ): Promise<MobileExtensionLibrarySession> => {
      let opened: MobileExtensionLibrarySession | undefined;
      try {
        return await owned(signal, async (current) => {
          const extension = await requireLibrarySurface(expected, surface, current);
          opened = await this.network.openExtensionLibrary(context.credential, extension.extensionId, extension.revision, surface.surfaceId, current);
          requireCurrent(current);
          if (opened.extensionId !== extension.extensionId || opened.expiresAt <= Date.now()) {
            throw new Error("The Extension Library session changed or expired.");
          }
          libraryLeases.set(opened, { extensionKey: mobileExtensionKey(extension), surface });
          return opened;
        });
      } catch (error) {
        if (opened !== undefined) {
          libraryLeases.delete(opened);
          await this.network.closeExtensionLibrary(context.credential, opened.id).catch(() => undefined);
        }
        throw error;
      }
    };
    const callLibrary = async (
      expected: MobileExtension, surface: MobileExtensionMainViewSurface, session: MobileExtensionLibrarySession,
      call: MobileExtensionLibraryCall, signal: AbortSignal
    ): Promise<MobileExtensionLibraryCallResult> => {
      try {
        return await owned(signal, async (current) => {
          const lease = libraryLeases.get(session);
          if (lease === undefined || lease.extensionKey !== mobileExtensionKey(expected)
            || !sameMobileExtensionMainViewSurface(lease.surface, surface) || session.expiresAt <= Date.now()) {
            throw new Error("The Extension Library session is not owned by this surface.");
          }
          await requireLibrarySurface(expected, surface, current);
          requireCurrent(current);
          if (libraryLeases.get(session) !== lease) throw new Error("The Extension Library session was closed.");
          const result = await this.network.callExtensionLibrary(context.credential, session.id, call, current);
          requireCurrent(current);
          if (libraryLeases.get(session) !== lease) throw new Error("The Extension Library call result was retired.");
          return result;
        });
      } catch (error) {
        await closeLibrary(session).catch(() => undefined);
        throw error;
      }
    };
    const libraryStatus = (expected: MobileExtension, surface: MobileExtensionMainViewSurface, signal: AbortSignal) =>
      owned(signal, async (current) => {
        const extension = await requireLibrarySurface(expected, surface, current);
        const overview = await this.network.getExtensionLibraryOverview(context.credential, extension.extensionId, extension.revision, current);
        requireCurrent(current);
        return overview;
      });
    const loadLibrary = (
      expected: MobileExtension,
      signal: AbortSignal
    ): Promise<MobileExtensionLibrarySnapshot> => owned(signal, async (current) =>
      (await readLibrarySnapshot(expected, current)).snapshot);
    const validateLibraryLocation = (
      expected: MobileExtension,
      candidate: string,
      signal: AbortSignal
    ): Promise<MobileExtensionLibraryLocationValidation> => owned(signal, async (current) => {
      const extension = await readExactDetail(expected, current);
      if (!mobileExtensionLibraryReady(extension)) {
        throw new Error("Enable and finish setting up this Extension before changing its Library location.");
      }
      if (pendingForExtension(extension.extensionId)) {
        throw new Error("A previous change to this Extension still has an unresolved result. Check its operation receipt first.");
      }
      const exactCandidate = normalizeMobileExtensionLibraryCandidate(candidate);
      const validation = await this.network.validateExtensionLibraryLocation(
        context.credential,
        extension.extensionId,
        extension.revision,
        exactCandidate,
        current
      );
      requireCurrent(current);
      return validation;
    });
    const mutateLibrary = (
      expected: MobileExtension,
      snapshot: MobileExtensionLibrarySnapshot,
      mutation: MobileExtensionLibraryMutation,
      signal: AbortSignal
    ): Promise<MobileExtensionLibrarySnapshot> => owned(signal, async (current) => {
      const fresh = await readLibrarySnapshot(expected, current);
      const extension = fresh.extension;
      if (!sameMobileExtensionLibrarySnapshot(snapshot, fresh.snapshot)) {
        throw new Error("The Extension Library changed; refresh it before performing this action.");
      }
      if (pendingForExtension(extension.extensionId)) {
        throw new Error("A previous change to this Extension still has an unresolved result. Check its operation receipt first.");
      }
      const overview = fresh.snapshot.overview;
      const requireReadyOverview = (): NonNullable<MobileExtensionLibrarySnapshot["overview"]> => {
        if (!mobileExtensionLibraryReady(extension) || overview === undefined) {
          throw new Error("Enable and finish setting up this Extension before changing its Library.");
        }
        return overview;
      };
      let customValidation: MobileExtensionLibraryLocationValidation | undefined;
      if (mutation.kind === "relocate" && mutation.destination.kind === "custom") {
        requireReadyOverview();
        const candidate = normalizeMobileExtensionLibraryCandidate(mutation.destination.candidate);
        customValidation = await this.network.validateExtensionLibraryLocation(
          context.credential,
          extension.extensionId,
          extension.revision,
          candidate,
          current
        );
        requireCurrent(current);
        if (!sameMobileExtensionLibraryValidation(mutation.destination.validation, customValidation)) {
          throw new Error("The Extension Library location validation changed; validate the path again.");
        }
      } else if (mutation.kind === "rebind") {
        const currentOverview = requireReadyOverview();
        if (currentOverview.state !== "unavailable"
          || currentOverview.unavailableReason !== "diskMissing"
            && currentOverview.unavailableReason !== "bindingMoved") {
          throw new Error("This Extension Library can no longer be rebound from its current state.");
        }
        const candidate = normalizeMobileExtensionLibraryCandidate(mutation.candidate);
        customValidation = await this.network.validateExtensionLibraryLocation(
          context.credential,
          extension.extensionId,
          extension.revision,
          candidate,
          current
        );
        requireCurrent(current);
        if (!sameMobileExtensionLibraryValidation(mutation.validation, customValidation)) {
          throw new Error("The Extension Library location validation changed; validate the path again.");
        }
      }

      const action = this.#claimMutation();
      let dispatched = false;
      try {
        try {
          switch (mutation.kind) {
            case "relocate": {
              const currentOverview = requireReadyOverview();
              if (currentOverview.state === "unavailable") {
                throw new Error("Repair or rebind this unavailable Extension Library before moving it.");
              }
              dispatched = true;
              await this.network.relocateExtensionLibrary(
                context.credential,
                extension.extensionId,
                extension.revision,
                mutation.destination.kind === "default"
                  ? { kind: "default" }
                  : {
                      kind: "custom",
                      candidate: normalizeMobileExtensionLibraryCandidate(mutation.destination.candidate)
                    },
                current
              );
              break;
            }
            case "rebind":
              dispatched = true;
              await this.network.rebindExtensionLibrary(
                context.credential,
                extension.extensionId,
                extension.revision,
                normalizeMobileExtensionLibraryCandidate(mutation.candidate),
                current
              );
              break;
            case "unbind": {
              const currentOverview = requireReadyOverview();
              if (currentOverview.location === undefined) throw new Error("This Extension Library is already unbound.");
              dispatched = true;
              await this.network.unbindExtensionLibrary(
                context.credential,
                extension.extensionId,
                extension.revision,
                current
              );
              break;
            }
            case "repairState": {
              const currentOverview = requireReadyOverview();
              if (currentOverview.state !== "unavailable" || currentOverview.unavailableReason !== "stateCorrupt") {
                throw new Error("The Extension Library state no longer requires repair.");
              }
              dispatched = true;
              await this.network.repairExtensionLibraryState(context.credential, current);
              break;
            }
            case "repairMetadata": {
              const currentOverview = requireReadyOverview();
              if (currentOverview.state !== "unavailable" || currentOverview.unavailableReason !== "metadataCorrupt") {
                throw new Error("The Extension Library metadata no longer requires repair.");
              }
              dispatched = true;
              await this.network.repairExtensionLibraryMetadata(
                context.credential,
                extension.extensionId,
                extension.revision,
                current
              );
              break;
            }
            case "trash": {
              const currentOverview = requireReadyOverview();
              if (currentOverview.state === "unavailable" || currentOverview.location === undefined
                || mutation.confirmation !== extension.name) {
                throw new Error("Enter the exact current Extension name before moving its Library to trash.");
              }
              dispatched = true;
              await this.network.trashExtensionLibrary(
                context.credential,
                extension.extensionId,
                extension.revision,
                mutation.confirmation,
                current
              );
              break;
            }
            case "restore": {
              const entries = fresh.snapshot.trash.filter((entry) => entry.id === mutation.entry.id);
              if (entries.length !== 1 || !sameMobileExtensionLibraryTrashEntry(entries[0]!, mutation.entry)
                || mutation.confirmation !== mutation.entry.name) {
                throw new Error("The Extension Library trash record changed; refresh before restoring it.");
              }
              dispatched = true;
              await this.network.restoreExtensionLibraryTrash(
                context.credential,
                extension.extensionId,
                mutation.entry.id,
                mutation.confirmation,
                mutation.destination,
                current
              );
              break;
            }
            case "purge": {
              const entries = fresh.snapshot.trash.filter((entry) => entry.id === mutation.entry.id);
              if (entries.length !== 1 || !sameMobileExtensionLibraryTrashEntry(entries[0]!, mutation.entry)
                || mutation.confirmation !== mutation.entry.name) {
                throw new Error("The Extension Library trash record changed; refresh before purging it.");
              }
              dispatched = true;
              await this.network.purgeExtensionLibraryTrash(
                context.credential,
                extension.extensionId,
                mutation.entry.id,
                mutation.confirmation,
                current
              );
              break;
            }
            case "rollback": {
              requireReadyOverview();
              const entries = fresh.snapshot.grace.filter((entry) => entry.id === mutation.entry.id);
              if (entries.length !== 1 || !sameMobileExtensionLibraryGraceEntry(entries[0]!, mutation.entry)) {
                throw new Error("The Extension Library grace record changed; refresh before rolling it back.");
              }
              dispatched = true;
              await this.network.rollbackExtensionLibrary(
                context.credential,
                extension.extensionId,
                extension.revision,
                mutation.entry.id,
                current
              );
              break;
            }
          }
          requireCurrent(current);
          return (await readLibrarySnapshot(expected, current)).snapshot;
        } catch (cause) {
          if (!dispatched) throw cause;
          const detail = cause instanceof Error && cause.message.trim().length > 0 ? ` ${cause.message}` : "";
          throw new Error(`The Extension Library action could not be confirmed. Refresh before trying another action; it was not resent.${detail}`);
        }
      } finally {
        this.#releaseMutation(action);
      }
    });
    const packageBackends = () => isCurrent() ? (this.#state.owner?.backends ?? []).filter(backend =>
      backend.capabilities?.capabilities.some(capability => capability.name === "runtime.resources"
        && capability.support === CapabilitySupport.SUPPORTED && capability.options?.kind.case === "runtime"
        && capability.options.kind.value.resourceKinds.includes("package")))
      .map(backend => ({ backendId: backend.backendId, name: backend.displayName })) : [];
    const browse = (signal: AbortSignal) => owned(signal, current =>
      (this.network.browseExtensions ?? this.network.listExtensions)(context.credential, current));
    const previewPackage = (expected: MobileExtension, backendId: string, signal: AbortSignal) => owned(signal, async current => {
      const fresh = await readExactDetail(expected, current, false);
      if (!this.network.getExtensionPackagePreview || !packageBackends().some(backend => backend.backendId === backendId)
        || pendingForExtension(fresh.extensionId)) throw new Error("Extension package management is unavailable or has an unresolved operation.");
      const preview = await this.network.getExtensionPackagePreview(context.credential, fresh, backendId, current);
      requireCurrent(current); assertMobileExtensionPackagePreview(fresh, preview);
      return preview;
    });
    const packageMutation = (expected: MobileExtension, preview: MobileExtensionPackagePreview | undefined,
      allowSourceReplacement: boolean, signal: AbortSignal) => owned(signal, async current => {
      const action = this.#claimMutation();
      try {
        const fresh = await readExactDetail(expected, current, false);
        if (pendingForExtension(fresh.extensionId)) throw new Error("Check the original Extension operation before another change.");
        if (preview) {
          assertMobileExtensionPackagePreview(fresh, preview);
          if (!packageBackends().some(backend => backend.backendId === preview.backendId)
            || preview.sourceReplacement && !allowSourceReplacement) throw new Error("Confirm this package source replacement before installing.");
        } else if (!fresh.installed || fresh.owner.kind !== "resource") throw new Error("Select an installed package before removing it.");
        const mutation = create(OperationMutationSchema, { payload: preview ? { case: "adoptExtensionPackage", value: {
          extensionId: fresh.extensionId, expectedRevision: { value: fresh.revision }, backendId: preview.backendId,
          expectedAction: preview.action === "install" ? ExtensionPackageAction.INSTALL
            : preview.action === "update" ? ExtensionPackageAction.UPDATE : ExtensionPackageAction.REPLACE,
          expectedCurrentResourceId: preview.currentResource?.resourceId ?? "",
          ...(preview.currentResource ? { expectedCurrentResourceRevision: { value: preview.currentResource.revision } } : {}),
          allowSourceReplacement
        } } : { case: "removeExtensionPackage", value: { extensionId: fresh.extensionId, expectedRevision: { value: fresh.revision } } } });
        const resourceId = preview?.resourceId ?? (fresh.owner.kind === "resource" ? fresh.owner.resourceId : "");
        const result = await this.#submitTerminal(mutation, { kind: preview ? "extension-package-adopt" : "extension-package-remove",
          extensionId: fresh.extensionId, extensionRevision: fresh.revision.toString(10), extensionResourceId: resourceId }, undefined, false, false,
        { signal: current, isCurrent, beforeTerminalReceipt: async operation => {
          if (operation.state === OperationState.SUCCEEDED) this.#assertExtensionPackageResult(operation, resourceId);
        } });
        requireCurrent(current);
        if (!result.definitive) throw new Error("The package change result is unknown. Check its original operation; it was not resent.");
        if (!result.accepted || result.operation?.state !== OperationState.SUCCEEDED) throw new Error(result.operation?.error?.message || "The package change was rejected.");
        return await (this.network.browseExtensions ?? this.network.listExtensions)(context.credential, current);
      } finally { this.#releaseMutation(action); }
    });
    const settingsOwnerCurrent = () => !this.#disposed && this.#credential === context.credential
      && this.#partnerPrivateAuthorityKey(this.#state, true) === ownerKey;
    const freshSettings = async (surface: MobileExtensionMainViewSurface, signal: AbortSignal, allowBackground = false) => {
      const assert = () => {
        signal.throwIfAborted();
        if (allowBackground ? !settingsOwnerCurrent() : !isCurrent()) throw new Error("Plugin settings owner changed.");
      };
      assert();
      const actual = await this.network.getExtensionMainViewSurface(context.credential, surface.surfaceId, signal); assert();
      if (surface.purpose !== "settings" || surface.mobileSettings !== true || !sameMobileExtensionMainViewSurface(surface, actual)) throw new Error("Plugin settings document changed.");
      const extension = await this.network.getExtension(context.credential, surface.extensionId, signal); assert();
      if (!extension.installed || !extension.settings || extension.owner.kind !== "resource" || extension.owner.resourceId !== surface.owner.resourceId
        || extension.owner.discoveredRevision !== surface.owner.discoveredRevision || extension.owner.resourceRevision !== surface.owner.resourceRevision) throw new Error("Plugin settings installation changed.");
      return extension;
    };
    const callSettings: NonNullable<MobileExtensionTransport["callSettings"]> = async (surface, call, host, signal) => {
      requireCurrent(signal);
      const api = this.network.extensionSettingsApi?.(context.credential), upload = this.network.uploadPrivateExtensionInput;
      if (!api || !upload || pendingForExtension(surface.extensionId)) throw new Error("Check the original plugin operation before another settings change.");
      const authorization = call.kind === "oauth.connect";
      const retention = authorization ? { transport, current: settingsOwnerCurrent } : undefined;
      const settingsHost = retention ? { ...host, authorize: async (...args: Parameters<typeof host.authorize>) => {
        requireCurrent(args[2]);
        if (this.#extensionOAuthRetention) throw new Error("Another plugin authorization is in progress.");
        this.#extensionOAuthRetention = retention;
        return host.authorize(...args);
      } } : host;
      const execute = (current: AbortSignal) => executeExtensionSettingsCall({ surface, api,
        ...(this.network.extensionOAuthApi ? { oauth: this.network.extensionOAuthApi(context.credential) } : {}),
        ...(this.network.extensionConnectionsApi ? { connections: this.network.extensionConnectionsApi(context.credential) } : {}),
        upload: (ticket, value, signal) => upload(context.credential, ticket, value, signal),
        current: () => { current.throwIfAborted(); if (authorization ? !settingsOwnerCurrent() : !isCurrent()) throw new Error("Plugin settings owner changed."); },
        fresh: signal => freshSettings(surface, signal, authorization),
        submit: async (extension, mutation, kind, signal) => {
          const action = this.#claimMutation();
          try {
            const result = await this.#submitTerminal(mutation, { kind: kind === "routing" ? "extension-settings-routing" : "extension-settings-credential-clear",
              extensionId: extension.extensionId, extensionRevision: extension.revision.toString(10) }, undefined, false, false,
            { signal, isCurrent, beforeTerminalReceipt: async operation => {
              if (operation.state === OperationState.SUCCEEDED) this.#assertExtensionMutationAcknowledgement(operation);
            } });
            requireCurrent(signal);
            if (!result.definitive) throw new Error("Plugin settings result is unknown. Check its original operation; it was not resent.");
            if (!result.accepted || result.operation?.state !== OperationState.SUCCEEDED) throw new Error(result.operation?.error?.message || "Plugin settings change was rejected.");
          } finally { this.#releaseMutation(action); }
        },
        pickDirectory: async (extension, mutation, signal) => {
          const action = this.#claimMutation();
          try {
            const result = await this.#submitTerminal(mutation, { kind: "extension-settings-directory", extensionId: extension.extensionId,
              extensionRevision: extension.revision.toString(10) }, undefined, false, false,
              { signal, isCurrent, beforeTerminalReceipt: async operation => {
                if (operation.state === OperationState.SUCCEEDED) this.#assertExtensionDirectoryReceipt(operation);
              } });
            requireCurrent(signal);
            if (!result.definitive) throw new Error("Directory selection result is unknown. Check the original operation before choosing again.");
            if (!result.accepted || result.operation?.state !== OperationState.SUCCEEDED) throw new Error(result.operation?.error?.message || "Directory selection was rejected.");
            await freshSettings(surface, signal); requireCurrent(signal);
            return this.#assertExtensionDirectoryReceipt(result.operation);
          } finally { this.#releaseMutation(action); }
        },
        begin: beginSetup, field: submitSetupInteraction,
        secret: (extension, fieldId, value, signal) => saveSetupCredential(extension, fieldId, "headerSecret", value, signal), complete: completeSetup
      }, call, settingsHost, current);
      const request = authorization ? new AbortController() : undefined;
      const unsubscribe = request ? this.subscribe(() => {
        if (!settingsOwnerCurrent() || !this.#foreground && this.#extensionOAuthRetention !== retention) request.abort();
      }) : undefined;
      try {
        return request ? await execute(AbortSignal.any([signal, request.signal])) : await owned(signal, execute);
      } finally {
        unsubscribe?.(); request?.abort();
        if (retention && this.#extensionOAuthRetention === retention) { this.#extensionOAuthRetention = undefined; this.#set({}); }
      }
    };
    const openSettings: NonNullable<MobileExtensionTransport["openSettings"]> = (expected, signal) => owned(signal, async current => {
      const extension = await readExactDetail(expected, current), api = this.network.extensionSettingsApi?.(context.credential);
      if (!extension.settings || !api || pendingForExtension(extension.extensionId)) throw new Error("Plugin author settings are unavailable.");
      const response = await api.openExtensionSettings({ extensionId: extension.extensionId, expectedRevision: { value: extension.revision }, mobile: true }, { signal: current });
      if (!response.surface) throw new Error("The Joko node returned an empty plugin settings surface.");
      const surface = projectMobileExtensionMainViewSurface(response.surface, context.credential.origin);
      try { await freshSettings(surface, current); return surface; }
      catch (error) { await this.network.closeExtensionMainView(context.credential, surface.surfaceId).catch(() => undefined); throw error; }
    });
    const exactPending = (operationId: string) => {
      const matches = this.#state.pending.filter((receipt) => receipt.operationId === operationId
        && receipt.connectionId === context.credential.connectionId
        && isMobileExtensionReceiptKind(receipt.kind));
      if (matches.length !== 1) throw new Error("Select a current Extension operation receipt.");
      return matches[0]!;
    };
    const transport: MobileExtensionTransport = {
      ownerKey,
      openSettings,
      callSettings,
      pending: Object.freeze(this.#state.pending.flatMap((receipt) => receipt.connectionId === context.credential.connectionId
        && receipt.extensionId !== undefined && isMobileExtensionReceiptKind(receipt.kind)
        ? [{ operationId: receipt.operationId, extensionId: receipt.extensionId,
            kind: mobileExtensionPendingMutationKind(receipt.kind),
            state: receipt.state }]
        : [])),
      list: (signal) => owned(signal, (current) => this.network.listExtensions(context.credential, current)),
      browse,
      packageBackends,
      previewPackage,
      adoptPackage: (expected, preview, allow, signal) => packageMutation(expected, preview, allow, signal),
      removePackage: (expected, signal) => packageMutation(expected, undefined, false, signal),
      getTaskPreferences: (expected, signal) => owned(signal, async current => {
        await readExactDetail(expected, current); const api = this.network.extensionTaskApi?.(context.credential);
        if (!api) throw new Error("Plugin task preferences are unavailable.");
        const result = await api.getPreferences({ extensionId: expected.extensionId }, { signal: current }); requireCurrent(current);
        if (!result.preferences || result.preferences.extensionId !== expected.extensionId) throw new Error("Plugin preference owner changed."); return result.preferences;
      }),
      setTaskPreferences: (expected, preferences, model, permissionMode, signal) => owned(signal, async current => {
        await readExactDetail(expected, current); const api = this.network.extensionTaskApi?.(context.credential);
        if (!api || preferences.extensionId !== expected.extensionId) throw new Error("Plugin task preferences are unavailable.");
        const result = await api.updatePreferences({ extensionId: expected.extensionId, expectedRevision: preferences.revision, model, permissionMode,
          targetId: preferences.targetId }, { signal: current }); requireCurrent(current);
        if (!result.preferences || result.preferences.extensionId !== expected.extensionId) throw new Error("Plugin preference owner changed."); return result.preferences;
      }),
      retryTaskWriteAccess: (expected, taskId, signal) => owned(signal, async current => {
        await readExactDetail(expected, current); const api = this.network.extensionTaskApi?.(context.credential);
        if (!api) throw new Error("Plugin task permissions are unavailable.");
        const result = await api.retryWriteAccess({ extensionId: expected.extensionId, taskId }, { signal: current }); requireCurrent(current);
        if (!result.preferences || result.preferences.extensionId !== expected.extensionId) throw new Error("Plugin permission owner changed."); return result.preferences;
      }),
      detail: (expected, signal) => owned(signal, (current) => readExactDetail(expected, current, false)),
      setEnabled: (expected, enabled, signal) => mutate(expected, "enabled", enabled, signal),
      setSidebarVisible: (expected, visible, signal) => mutate(expected, "sidebar", visible, signal),
      beginSetup,
      submitSetupInteraction,
      saveSetupCredential,
      completeSetup,
      cancelSetup,
      revokeSetup,
      tasks: (expected) => isCurrent() ? projectMobileExtensionTaskChoices(this.#state.owner, expected) : [],
      useCommand,
      openMainView,
      probeMainView,
      readMainViewResource: (expected, url, kind, signal, text) => owned(signal, async current => {
        await probeMainView(expected, current);
        const resource = await this.network.readExtensionMainViewResource(context.credential, expected, url, kind, current, text);
        requireCurrent(current);
        await probeMainView(expected, current);
        requireCurrent(current);
        return resource;
      }),
      closeMainView: (expected) => this.network.closeExtensionMainView(
        context.credential,
        expected.surfaceId
      ),
      openLibrary,
      callLibrary,
      closeLibrary,
      libraryStatus,
      loadLibrary,
      validateLibraryLocation,
      mutateLibrary,
      reconcile: (operationId, signal) => owned(signal, async (current) => {
        exactPending(operationId);
        await this.reconcile();
        requireCurrent(current);
      }),
      dismiss: (operationId, signal) => owned(signal, async (current) => {
        const pending = exactPending(operationId);
        if (pending.state !== "unknown") throw new Error("Only an unconfirmed Extension operation can be cleared.");
        await this.dismissUnconfirmed(operationId);
        requireCurrent(current);
      })
    };
    return transport;
  }

  #assertExtensionDirectoryReceipt(operation: Operation) {
    const payload = operation.result?.payload;
    if (payload?.case !== "pickedDirectory" || !payload.value.token || payload.value.fileCount < 1 || payload.value.fileCount > 500
      || payload.value.fileCount !== payload.value.relativePaths.length || payload.value.totalBytes > 524_288_000n
      || payload.value.totalBytes < 0n || !payload.value.expiresAt
      || payload.value.relativePaths.some(value => !value || value.length > 4096 || value.startsWith("/") || value.includes("\\")
        || value.includes("\0") || value.split("/").some(part => part === ".."))) {
      throw new Error("The original directory selection has no valid read deposit receipt.");
    }
    return payload.value;
  }

  #assertExtensionMutationAcknowledgement(operation: Operation): void {
    const payload = operation.result?.payload;
    if (payload?.case !== "acknowledgement" || payload.value.accepted !== true) {
      throw new Error("The Joko node completed the Extension change without an accepted acknowledgement.");
    }
  }

  #assertExtensionPackageResult(operation: Operation, expectedResourceId?: string): void {
    const payload = operation.result?.payload;
    if (payload?.case !== "resource" || !payload.value.resourceId
      || expectedResourceId !== undefined && payload.value.resourceId !== expectedResourceId) {
      throw new Error("The Joko node completed the package change without its original Resource result.");
    }
  }

  remoteDesktopTransport(): MobileRemoteDesktopTransport | undefined {
    const credential = this.#credential;
    const ownerKey = this.#remoteDesktopOwnerKey(false);
    if (!credential || !ownerKey || !this.network.listRemoteDesktopHosts || !this.network.getRemoteDesktopCapabilities
      || !this.network.getRemoteDesktopPermissions || !this.network.showRemoteDesktopPermissionGuide
      || !this.network.startRemoteDesktop || !this.network.heartbeatRemoteDesktop || !this.network.stopRemoteDesktop
      || !this.network.setRemoteDesktopControl || !this.network.setRemoteDesktopPresentation
      || !this.network.setRemoteDesktopHostMute
      || !this.network.sendRemoteDesktopInput
      || !this.network.getRemoteDesktopIceConfiguration || !this.network.createRemoteDesktopOffer
      || !this.network.exchangeRemoteDesktopIce || !this.network.getRemoteDesktopFrame
      || !this.network.listRemoteDesktopDisplayModes || !this.network.setRemoteDesktopDisplayMode
      || !this.network.transferRemoteDesktopClipboardText
      || !this.network.transferRemoteDesktopClipboardContent) return undefined;
    const authoritySame = (): boolean => !this.#disposed && this.#credential === credential
      && this.#remoteDesktopOwnerKey(false) === ownerKey;
    const current = (): boolean => authoritySame() && this.#foreground && this.#state.status === "connected";
    const checked = async <T>(operation: () => Promise<T>): Promise<T> => {
      if (!current()) throw new MobileRemoteDesktopAuthorityError();
      const value = await operation();
      if (!current()) throw new MobileRemoteDesktopAuthorityError();
      return value;
    };
    const route = (host: Parameters<MobileRemoteDesktopTransport["capabilities"]>[0]) => {
      if (!host.route) throw new Error("The selected Remote Desktop host has no current route.");
      return host.route;
    };
    const routeKey = (host: Parameters<MobileRemoteDesktopTransport["capabilities"]>[0]): string => {
      const value = route(host);
      return JSON.stringify([value.targetDeviceId, value.relationId,
        value.targetDeviceRevision?.value.toString(10), value.targetDeviceRevision?.etag,
        value.relationRevision?.value.toString(10), value.relationRevision?.etag, value.routeGeneration.toString(10)]);
    };
    // Only the captured presentation request can cross a short Home transition.
    // The ordinary current/checked boundary remains foreground-only.
    const beginBackgroundTransition = (host: Parameters<MobileRemoteDesktopTransport["capabilities"]>[0], leaseId: string) => {
      if (this.platform !== "ios" || !current() || !leaseId || leaseId.length > 256) return undefined;
      const key = routeKey(host), deadline = performance.now() + 4_000;
      this.#remoteDesktopPresentationTransition?.close();
      let closed = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const ticket = {
        isCurrent: (): boolean => !closed && this.#remoteDesktopPresentationTransition === ticket
          && performance.now() < deadline && authoritySame() && this.#state.status === "connected"
          && routeKey(host) === key,
        close: (): void => {
          closed = true;
          if (timer !== undefined) clearTimeout(timer);
          timer = undefined;
          if (this.#remoteDesktopPresentationTransition === ticket) this.#remoteDesktopPresentationTransition = undefined;
        },
        matches: (candidate: Parameters<MobileRemoteDesktopTransport["capabilities"]>[0], lease: string): boolean =>
          lease === leaseId && ticket.isCurrent() && routeKey(candidate) === key
      };
      this.#remoteDesktopPresentationTransition = ticket;
      timer = setTimeout(ticket.close, 4_000);
      return ticket;
    };
    return {
      ownerKey,
      preferenceOwner: Object.freeze({ profileId: credential.profileId, serverId: credential.serverId,
        controllerDeviceId: credential.deviceId }),
      isCurrent: current,
      canStop: authoritySame,
      beginBackgroundTransition,
      listHosts: (signal) => checked(() => this.network.listRemoteDesktopHosts!(credential, signal)),
      capabilities: (host, signal) => checked(() => this.network.getRemoteDesktopCapabilities!(credential, route(host), signal)),
      permissions: (host, signal) => checked(() => this.network.getRemoteDesktopPermissions!(credential, route(host), signal)),
      showPermissionGuide: (host, signal) => checked(() => this.network.showRemoteDesktopPermissionGuide!(credential, route(host), signal)),
      start: (host, displayId, mode, signal, control) => checked(() =>
        this.network.startRemoteDesktop!(credential, route(host), displayId, mode, signal, control)),
      heartbeat: (host, leaseId, signal) => checked(() =>
        this.network.heartbeatRemoteDesktop!(credential, route(host), leaseId, signal)),
      stop: async (host, leaseId, exit, signal) => {
        if (!authoritySame()) throw new MobileRemoteDesktopAuthorityError();
        await this.network.stopRemoteDesktop!(credential, route(host), leaseId, exit, signal);
        if (!authoritySame()) throw new MobileRemoteDesktopAuthorityError();
      },
      control: (host, leaseId, enabled, signal) => checked(() =>
        this.network.setRemoteDesktopControl!(credential, route(host), leaseId, enabled, signal)),
      setHostMute: (host, leaseId, controlGeneration, enabled, signal) => checked(() =>
        this.network.setRemoteDesktopHostMute!(credential, route(host),
          create(RemoteDesktopHostMuteRequestSchema, { leaseId, controlGeneration, enabled }), signal)),
      setPrivacyScreen: (host, leaseId, controlGeneration, enabled, lockOnExit, signal) => checked(() => {
        if (!this.network.setRemoteDesktopPrivacyScreen) throw new Error("Remote Desktop privacy screen is unavailable.");
        return this.network.setRemoteDesktopPrivacyScreen(credential, route(host),
          create(RemoteDesktopPrivacyScreenRequestSchema, { leaseId, controlGeneration, enabled, lockOnExit }), signal);
      }),
      lockState: (host, signal) => checked(() => {
        if (!this.network.getRemoteDesktopLockState) throw new Error("CREDENTIAL_UNAVAILABLE");
        return this.network.getRemoteDesktopLockState(credential, route(host), signal);
      }),
      credentials: (host, request, signal) => checked(() => {
        if (!this.network.requestRemoteDesktopCredentials) throw new Error("CREDENTIAL_UNAVAILABLE");
        return this.network.requestRemoteDesktopCredentials(credential, route(host), request, signal);
      }),
      setClipboardSync: async (host, request, signal) => {
        if (!this.network.setRemoteDesktopClipboardSync) throw new Error("Remote Desktop clipboard sync is unavailable.");
        if (request.enabled) return checked(() => this.network.setRemoteDesktopClipboardSync!(credential, route(host), request, signal));
        if (!authoritySame()) throw new MobileRemoteDesktopAuthorityError();
        const result = await this.network.setRemoteDesktopClipboardSync(credential, route(host), request, signal);
        if (!authoritySame()) throw new MobileRemoteDesktopAuthorityError();
        return result;
      },
      clipboardVersion: (host, request, signal) => checked(() => {
        if (!this.network.getRemoteDesktopClipboardVersion) throw new Error("Remote Desktop clipboard version is unavailable.");
        return this.network.getRemoteDesktopClipboardVersion(credential, route(host), request, signal);
      }),
      presentation: async (host, leaseId, enabled, signal) => {
        const transition = this.#remoteDesktopPresentationTransition;
        const permitted = (): boolean => authoritySame() && (current() || transition?.matches(host, leaseId) === true);
        if (!permitted()) throw new MobileRemoteDesktopAuthorityError();
        const value = await this.network.setRemoteDesktopPresentation!(credential, route(host), leaseId, enabled, signal);
        if (!permitted()) throw new MobileRemoteDesktopAuthorityError();
        return value;
      },
      input: (host, leaseId, sequence, events, signal) => checked(() =>
        this.network.sendRemoteDesktopInput!(credential, route(host), leaseId, sequence, events, signal)),
      iceConfiguration: (host, leaseId, signal) => checked(() =>
        this.network.getRemoteDesktopIceConfiguration!(credential, route(host), leaseId, signal)),
      offer: (host, leaseId, attemptId, sdp, settings, cursorOverlay, signal) => checked(() =>
        this.network.createRemoteDesktopOffer!(credential, route(host), leaseId, attemptId, sdp, settings,
          cursorOverlay, signal)),
      ice: (host, leaseId, attemptId, candidates, after, signal) => checked(() =>
        this.network.exchangeRemoteDesktopIce!(credential, route(host), leaseId, attemptId, candidates, after, signal)),
      frame: (host, leaseId, cursorOverlay, signal) => checked(() =>
        this.network.getRemoteDesktopFrame!(credential, route(host), leaseId, cursorOverlay, signal)),
      listDisplayModes: (host, leaseId, signal) => checked(() =>
        this.network.listRemoteDesktopDisplayModes!(credential, route(host), leaseId, signal)),
      setDisplayMode: (host, leaseId, controlGeneration, modeId, temporary, signal, control) => checked(() =>
        this.network.setRemoteDesktopDisplayMode!(credential, route(host), leaseId, controlGeneration, modeId, temporary, signal, control)),
      fitViewerDisplay: (host, leaseId, controlGeneration, width, height, signal, control) => checked(() => {
        if (!this.network.setRemoteDesktopViewerDisplay) throw new Error("Remote Desktop viewer display is unavailable.");
        return this.network.setRemoteDesktopViewerDisplay(credential, route(host), leaseId, controlGeneration, width, height, signal, control);
      }),
      restoreViewerDisplay: (host, leaseId, controlGeneration, signal, control) => checked(() => {
        if (!this.network.restoreRemoteDesktopViewerDisplay) throw new Error("Remote Desktop viewer display restore is unavailable.");
        return this.network.restoreRemoteDesktopViewerDisplay(credential, route(host), leaseId, controlGeneration, signal, control);
      }),
      systemAction: (host, leaseId, controlGeneration, action, signal) => checked(() => {
        if (!this.network.performRemoteDesktopSystemAction) throw new Error("Remote Desktop system actions are unavailable.");
        return this.network.performRemoteDesktopSystemAction(credential, route(host), leaseId, controlGeneration, action, signal);
      }),
      clipboardText: (host, transferValue, signal) => checked(() =>
        this.network.transferRemoteDesktopClipboardText!(credential, route(host), transferValue, signal)),
      clipboardContent: (host, transferValue, signal) => checked(() =>
        this.network.transferRemoteDesktopClipboardContent!(credential, route(host), transferValue, signal))
    };
  }

  mobilePushLifecycleScope(): MobilePushLifecycleScope {
    return {
      ready: this.#state.status !== "starting",
      ...(this.#state.activeProfileId === undefined ? {} : { activeProfileId: this.#state.activeProfileId })
    };
  }

  mobilePushAuthority(): MobilePushAuthority | undefined {
    const credential = this.#credential;
    const node = this.#state.node;
    const owner = this.#state.owner;
    if (!this.#foreground || this.platform !== "ios" || this.#state.status !== "connected" || !credential || !node || !owner
      || this.#activeProfileId !== credential.profileId || this.#state.activeProfileId !== credential.profileId
      || this.#state.origin !== credential.origin || node.serverId !== credential.serverId
      || owner.server?.serverId !== credential.serverId || owner.server.apiVersion !== node.apiVersion) return undefined;
    const connections = owner.connections.filter((item) => item.connectionId === credential.connectionId);
    const devices = owner.devices.filter((item) => item.deviceId === credential.deviceId);
    if (connections.length !== 1 || devices.length !== 1) return undefined;
    const connection = connections[0]!;
    const device = devices[0]!;
    const revision = device.version?.revision?.value ?? 0n;
    if (connection.connectionProfileId !== credential.profileId || connection.deviceId !== credential.deviceId
      || connection.state !== ConnectionState.CONNECTED || device.kind !== DeviceKind.MOBILE || device.revoked
      || device.platform.trim().toLocaleLowerCase("en-US") !== "ios"
      || !device.connectionIds.includes(credential.connectionId) || revision < 1n) return undefined;
    return Object.freeze({
      key: [credential.profileId, credential.origin, credential.serverId, credential.connectionId,
        credential.deviceId, revision.toString(10)].join("\u001f"),
      profileId: credential.profileId,
      origin: credential.origin,
      serverId: credential.serverId,
      connectionId: credential.connectionId,
      deviceId: credential.deviceId,
      deviceRevision: revision
    });
  }

  async getMobilePushCapability(
    authority: MobilePushAuthority,
    signal?: AbortSignal
  ): Promise<MobilePushCapabilityResult> {
    if (this.mobilePushAuthority()?.key !== authority.key) throw new Error("The mobile push owner changed.");
    const result = await this.network.getMobilePushCapability(authority.origin, signal);
    if (this.mobilePushAuthority()?.key !== authority.key) throw new Error("The mobile push owner changed.");
    return result;
  }

  async registerMobilePush(
    authority: MobilePushAuthority,
    input: Omit<MobilePushRegistrationInput, "expectedDeviceRevision">,
    signal?: AbortSignal
  ): Promise<MobilePushRegistrationResult> {
    const current = this.mobilePushAuthority();
    if (current?.key !== authority.key) throw new Error("The mobile push owner changed.");
    const credential = this.#ready();
    if (credential.profileId !== authority.profileId || credential.origin !== authority.origin
      || credential.serverId !== authority.serverId || credential.connectionId !== authority.connectionId
      || credential.deviceId !== authority.deviceId) throw new Error("The mobile push owner changed.");
    const result = await this.network.registerMobilePush(credential, {
      ...input,
      expectedDeviceRevision: authority.deviceRevision
    }, signal);
    if (this.mobilePushAuthority()?.key !== authority.key) throw new Error("The mobile push owner changed.");
    return result;
  }

  unregisterMobilePush(
    origin: string,
    ticket: MobilePushRevocationTicket,
    signal?: AbortSignal
  ): Promise<void> {
    return this.network.unregisterMobilePush(origin, ticket, signal);
  }

  subscribe(listener: (state: MobileState) => void): () => void {
    this.#listeners.add(listener);
    listener(this.#state);
    return () => this.#listeners.delete(listener);
  }

  #set(patch: Partial<MobileState>): void {
    if (this.#disposed) return;
    const previousAuthority = this.filesAuthorityKey();
    const previousPartnerAuthority = this.#partnerPrivateAuthorityKey(this.#state);
    let next = { ...this.#state, ...patch };
    if (patch.detail && next.activeProfileId === this.#state.activeProfileId && next.selectedId === this.#state.selectedId
      && next.taskSource?.kind === this.#state.taskSource?.kind) {
      next = { ...next, detail: retainMobileHistoryPrefix(patch.detail, this.#state.detail) };
    }
    const nextAuthority = this.#filesAuthorityKey(next);
    const nextPartnerAuthority = this.#partnerPrivateAuthorityKey(next);
    const sourceSessionChanged = this.#partnerPrivateSourceSessionId !== undefined
      && next.selectedId !== this.#partnerPrivateSourceSessionId;
    const partnerAuthorityChanged = previousPartnerAuthority !== undefined && nextPartnerAuthority !== undefined
      && previousPartnerAuthority !== nextPartnerAuthority;
    if (next.partnerPrivate.open && (previousPartnerAuthority !== nextPartnerAuthority || sourceSessionChanged)) {
      if (partnerAuthorityChanged) {
        this.#partnerPrivateResume = {
          credentialKey: this.#partnerPrivateCredentialKey(this.#credential)!,
          ...(this.#state.partnerPrivate.selectedPartnerId === undefined ? {}
            : { selectedPartnerId: this.#state.partnerPrivate.selectedPartnerId }),
          ...(this.#state.partnerPrivate.selectedThreadId === undefined ? {}
            : { selectedThreadId: this.#state.partnerPrivate.selectedThreadId }),
          ...(this.#partnerPrivateSourceSessionId === undefined ? {}
            : { sourceSessionId: this.#partnerPrivateSourceSessionId }),
          ...(this.#partnerPrivateSourceTargetId === undefined ? {}
            : { sourceTargetId: this.#partnerPrivateSourceTargetId })
        };
      }
      this.#cancelPartnerPrivateRequests();
      this.#partnerPrivateSourceSessionId = undefined;
      this.#partnerPrivateSourceTargetId = undefined;
      if (sourceSessionChanged) this.#partnerPrivateResume = undefined;
      next = { ...next, partnerPrivate: emptyMobilePartnerPrivateState(true,
        nextPartnerAuthority === undefined ? "offline" : "idle") };
    }
    if (next.files.open && previousAuthority !== nextAuthority) {
      this.#cancelFilesRequests();
      next = {
        ...next,
        files: {
          ...emptyMobileFilesState(),
          open: true,
          status: next.status === "connected" ? "idle" : "offline",
        }
      };
    } else if (next.files.open && next.status !== "connected" && next.files.status !== "offline") {
      next = { ...next, files: { ...next.files, status: "offline" } };
    }
    if (next.automations.open && next.status !== "connected") {
      let schedules: readonly MobileAutomationSchedule[] = [];
      let automationError: string | undefined;
      try { schedules = projectMobileAutomationCatalog(next.owner?.schedules ?? []); }
      catch (error) { automationError = message(error); }
      const selectedScheduleId = schedules.some((schedule) => schedule.scheduleId === next.automations.selectedScheduleId)
        ? next.automations.selectedScheduleId
        : schedules[0]?.scheduleId;
      next = {
        ...next,
        automations: {
          ...next.automations,
          status: "offline",
          schedules,
          ...(selectedScheduleId === undefined ? { selectedScheduleId: undefined } : { selectedScheduleId }),
          detail: undefined,
          history: [],
          historyStatus: "idle",
          historyNextPageToken: undefined,
          historyTotalSize: 0,
          runtime: undefined,
          error: automationError ?? "Reconnect to inspect or control Automations."
        }
      };
    }
    if (this.#timelinePreview && !this.#timelinePreviewSourceCurrent(this.#timelinePreview, next)) {
      this.#cancelTimelinePreviewLease();
      next = { ...next, timelinePreview: undefined };
    }
    this.#state = next;
    if ((this.#filesPreviewPager && !this.#filesPreviewPagerCurrent(this.#filesPreviewPager)) || (next.files.previewPager && !this.#filesPreviewPager)) {
      this.#retireFilesPreviewPager(); this.#filesPreviewAbort?.abort();
      this.#state = { ...next, files: { ...next.files, preview: undefined, previewPager: undefined } };
    }
    this.#markdownResources.retireStale();
    this.#fileHtmlResources.retireStale();
    this.#timelineImages.retainOwner(this.#taskAuthorityKey(true));
    this.#timelineImages.retireStale();
    this.#filesThumbnails.retainOwner(next.files.open ? this.filesAuthorityKey() : undefined);
    this.#filesThumbnails.retireStale();
    if (this.#fileShareLease?.phase === "preparing"
      && !this.#fileShareLeaseCurrent(this.#fileShareLease)) {
      this.#fileShareLease.controller.abort();
    }
    for (const listener of this.#listeners) listener(this.#state);
    if (partnerAuthorityChanged && next.partnerPrivate.open) this.#schedulePartnerPrivateRefresh(250);
    else if (next.partnerPrivate.open && nextPartnerAuthority !== undefined
      && this.#partnerPrivateRefreshTimer === undefined) {
      this.#schedulePartnerPrivateRefresh(next.partnerPrivate.detail?.messages.some(
        (item) => item.deliveryStatus === "pending") ? 4_000 : 30_000);
    }
  }

  #retire(): number {
    this.#entryAttempt?.abort();
    this.#partnerGroupAttachments = undefined;
    const partnerPrivate = this.#state.partnerPrivate;
    const credentialKey = this.#partnerPrivateCredentialKey(this.#credential);
    if (partnerPrivate.open && credentialKey
      && (partnerPrivate.selectedPartnerId !== undefined || partnerPrivate.selectedThreadId !== undefined
        || this.#partnerPrivateResume?.credentialKey !== credentialKey)) {
      this.#partnerPrivateResume = {
        credentialKey,
        ...(partnerPrivate.selectedPartnerId === undefined ? {} : { selectedPartnerId: partnerPrivate.selectedPartnerId }),
        ...(partnerPrivate.selectedThreadId === undefined ? {} : { selectedThreadId: partnerPrivate.selectedThreadId }),
        ...(this.#partnerPrivateSourceSessionId === undefined ? {} : { sourceSessionId: this.#partnerPrivateSourceSessionId }),
        ...(this.#partnerPrivateSourceTargetId === undefined ? {} : { sourceTargetId: this.#partnerPrivateSourceTargetId })
      };
    }
    this.#cancelPartnerPrivateRequests();
    if (this.#partnerPrivateRefreshTimer !== undefined) clearTimeout(this.#partnerPrivateRefreshTimer);
    this.#partnerPrivateRefreshTimer = undefined;
    this.#partnerPrivateSourceSessionId = undefined;
    this.#partnerPrivateSourceTargetId = undefined;
    this.#abort?.abort();
    this.#streamAbort?.abort();
    this.#streamAbort = undefined;
    this.#homeSearchAbort?.abort();
    this.#homeSearchAbort = undefined;
    this.#homeSearchEpoch += 1;
    this.#cancelAutomationRequests();
    this.#cancelFilesRequests();
    this.#cancelTimelinePreviewLease();
    this.#cancelPreparingFileShare();
    this.#composerImageEdit = undefined;
    this.#retireImageGallery();
    if (this.#conversationShare) this.releaseConversationShare(this.#conversationShare.leaseId);
    this.#markdownResources.releaseAll();
    this.#fileHtmlResources.releaseAll();
    this.#timelineImages.releaseAll();
    this.#filesThumbnails.releaseAll();
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    if (this.#proofTimer !== undefined) clearTimeout(this.#proofTimer);
    if (this.#projectionTimer !== undefined) clearTimeout(this.#projectionTimer);
    this.#timer = undefined;
    this.#proofTimer = undefined;
    this.#projectionTimer = undefined;
    this.#historyOwner = undefined;
    this.#projectionReading = false;
    this.#projectionMisses = 0;
    this.#streamSequence = undefined;
    this.#streamGeneration = undefined;
    this.#state = {
      ...this.#state,
      homeSearchStatus: "idle",
      homeSearchSessionIds: [],
      homeSearchError: undefined,
      timelinePreview: undefined,
      partnerPrivate: emptyMobilePartnerPrivateState(partnerPrivate.open,
        partnerPrivate.open ? "offline" : "idle"),
      ...(this.#state.files.preview?.kind === "media" || this.#state.files.preview?.kind === "pdf"
        || this.#state.files.preview?.kind === "model"
        ? { files: { ...this.#state.files, preview: undefined } }
        : {})
    };
    this.#abort = new AbortController();
    return ++this.#epoch;
  }

  #current(epoch: number): boolean { return !this.#disposed && this.#foreground && this.#epoch === epoch; }

  #partnerPrivateCredentialKey(credential: PairedCredential | undefined): string | undefined {
    return credential === undefined ? undefined : [credential.profileId, credential.origin, credential.serverId,
      credential.connectionId, credential.deviceId].join("\u001f");
  }

  #partnerPrivateAuthorityKey(state: MobileState, allowBackground = false): string | undefined {
    const credential = this.#credential;
    const node = state.node;
    const owner = state.owner;
    if (this.#disposed || !allowBackground && !this.#foreground || !credential || !node || !owner
      || state.status !== "connected" || state.activeProfileId !== credential.profileId
      || this.#activeProfileId !== credential.profileId || state.origin !== credential.origin
      || node.serverId !== credential.serverId || owner.server?.serverId !== credential.serverId
      || owner.server.apiVersion !== node.apiVersion) return undefined;
    const connections = owner.connections.filter((item) => item.connectionId === credential.connectionId);
    const devices = owner.devices.filter((item) => item.deviceId === credential.deviceId);
    if (connections.length !== 1 || devices.length !== 1) return undefined;
    const connection = connections[0]!;
    const device = devices[0]!;
    if (connection.connectionProfileId !== credential.profileId || connection.deviceId !== credential.deviceId
      || connection.state !== ConnectionState.CONNECTED || device.kind !== DeviceKind.MOBILE
      || device.revoked || !device.connectionIds.includes(credential.connectionId)) return undefined;
    return [this.#partnerPrivateCredentialKey(credential), owner.generation.toString(10),
      entityVersionKey(connection.version), entityVersionKey(device.version)].join("\u001f");
  }

  #partnerPrivateContext(): { readonly credential: PairedCredential; readonly authorityKey: string } | undefined {
    const credential = this.#credential;
    const authorityKey = this.#partnerPrivateAuthorityKey(this.#state);
    return credential && authorityKey ? { credential, authorityKey } : undefined;
  }

  #cancelPartnerPrivateRequests(): void {
    this.#partnerPrivateAbort?.abort();
    this.#partnerPrivateReadAbort?.abort();
    this.#partnerPrivateAbort = undefined;
    this.#partnerPrivateReadAbort = undefined;
    this.#partnerPrivateReadTarget = undefined;
    this.#partnerPrivateReadFlight = undefined;
    this.#partnerPrivateDetailLease = undefined;
    this.#partnerPrivateEpoch += 1;
  }

  #schedulePartnerPrivateRefresh(delay: number): void {
    if (this.#partnerPrivateRefreshTimer !== undefined) clearTimeout(this.#partnerPrivateRefreshTimer);
    this.#partnerPrivateRefreshTimer = setTimeout(() => {
      this.#partnerPrivateRefreshTimer = undefined;
      if (!this.#state.partnerPrivate.open || !this.#partnerPrivateContext()) return;
      if (this.#partnerPrivateResume) void this.#resumePartnerPrivate();
      else void this.refreshPartnerPrivate();
    }, delay);
  }

  #beginPartnerPrivateRequest(): { readonly generation: number; readonly controller: AbortController } {
    this.#cancelPartnerPrivateRequests();
    const controller = new AbortController();
    this.#partnerPrivateAbort = controller;
    return { generation: this.#partnerPrivateEpoch, controller };
  }

  #partnerPrivateRequestCurrent(
    generation: number, controller: AbortController, authorityKey: string
  ): boolean {
    return this.#partnerPrivateEpoch === generation && this.#partnerPrivateAbort === controller
      && !controller.signal.aborted && this.#partnerPrivateAuthorityKey(this.#state) === authorityKey
      && this.#state.partnerPrivate.open;
  }

  async openPartnerDirectory(): Promise<void> {
    const context = this.#partnerPrivateContext();
    const { generation, controller } = this.#beginPartnerPrivateRequest();
    this.#partnerPrivateSourceSessionId = undefined;
    this.#partnerPrivateSourceTargetId = undefined;
    this.#set({ partnerPrivate: emptyMobilePartnerPrivateState(true, context ? "loading" : "offline") });
    if (!context) return;
    try {
      const partners = await this.network.listPartners(context.credential, controller.signal);
      if (!this.#partnerPrivateRequestCurrent(generation, controller, context.authorityKey)) return;
      this.#set({ partnerPrivate: { ...emptyMobilePartnerPrivateState(true, "ready"), partners } });
    } catch (error) {
      if (!this.#partnerPrivateRequestCurrent(generation, controller, context.authorityKey)) return;
      this.#set({ partnerPrivate: { ...emptyMobilePartnerPrivateState(true, "error"), error: message(error) } });
    }
  }

  async selectPartnerPrivatePartner(partnerId: string): Promise<void> {
    const context = this.#partnerPrivateContext();
    const current = this.#state.partnerPrivate;
    if (!context || !current.open) {
      this.#set({ partnerPrivate: emptyMobilePartnerPrivateState(true, "offline") });
      return;
    }
    const partner = current.partners.filter((item) => item.partnerId === partnerId);
    if (!validMobilePartnerId(partnerId) || partner.length !== 1) {
      this.#set({ partnerPrivate: { ...current, status: "error", error: "The selected Partner is no longer in this directory." } });
      return;
    }
    const { generation, controller } = this.#beginPartnerPrivateRequest();
    this.#set({ partnerPrivate: { ...current, status: "loading", selectedPartnerId: partnerId,
      threads: [], selectedThreadId: undefined, detail: undefined, detailStatus: "idle", detailError: undefined,
      error: undefined } });
    try {
      const threads = await this.network.listPartnerPrivateThreads(context.credential, partnerId, controller.signal);
      if (!this.#partnerPrivateRequestCurrent(generation, controller, context.authorityKey)
        || this.#state.partnerPrivate.selectedPartnerId !== partnerId) return;
      this.#set({ partnerPrivate: { ...this.#state.partnerPrivate, status: "ready", threads } });
    } catch (error) {
      if (!this.#partnerPrivateRequestCurrent(generation, controller, context.authorityKey)) return;
      this.#set({ partnerPrivate: { ...this.#state.partnerPrivate, status: "error", error: message(error) } });
    }
  }

  async openPartnerPrivateThread(partnerId: string, threadId: string): Promise<void> {
    const context = this.#partnerPrivateContext();
    const current = this.#state.partnerPrivate;
    if (!context || !current.open) {
      this.#set({ partnerPrivate: emptyMobilePartnerPrivateState(true, "offline") });
      return;
    }
    if (current.selectedPartnerId !== partnerId || current.status !== "ready") {
      await this.selectPartnerPrivatePartner(partnerId);
    }
    const selected = this.#state.partnerPrivate;
    if (selected.status !== "ready" || selected.selectedPartnerId !== partnerId) return;
    const threads = selected.threads.filter((item) => item.threadId === threadId);
    if (!validMobilePartnerId(threadId) || threads.length !== 1) {
      this.#set({ partnerPrivate: { ...selected, detailStatus: "error",
        detailError: "The selected private thread is no longer in this Partner's list." } });
      return;
    }
    const { generation, controller } = this.#beginPartnerPrivateRequest();
    this.#set({ partnerPrivate: { ...selected, selectedThreadId: threadId, detail: undefined,
      detailStatus: "loading", detailError: undefined } });
    try {
      const detail = await this.network.getPartnerPrivateThread(context.credential, partnerId, threadId, controller.signal);
      if (!this.#partnerPrivateRequestCurrent(generation, controller, context.authorityKey)
        || this.#state.partnerPrivate.selectedPartnerId !== partnerId
        || this.#state.partnerPrivate.selectedThreadId !== threadId) return;
      if (detail.thread.otherPartnerId !== threads[0]!.otherPartnerId
        || detail.thread.firstPartnerId !== threads[0]!.firstPartnerId
        || detail.thread.secondPartnerId !== threads[0]!.secondPartnerId) {
        throw new Error("The selected private thread participants changed.");
      }
      this.#partnerPrivateDetailLease = Symbol("partner-private-detail");
      this.#set({ partnerPrivate: { ...this.#state.partnerPrivate, detailStatus: "ready", detail,
        threads: this.#state.partnerPrivate.threads.map((item) => item.threadId === threadId ? detail.thread : item) } });
      if (detail.messages.some((item) => item.deliveryStatus === "pending")) {
        this.#schedulePartnerPrivateRefresh(4_000);
      }
    } catch (error) {
      if (!this.#partnerPrivateRequestCurrent(generation, controller, context.authorityKey)) return;
      this.#set({ partnerPrivate: { ...this.#state.partnerPrivate, detail: undefined,
        detailStatus: "error", detailError: message(error) } });
    }
  }

  async openPartnerPrivateFromSession(sessionId: string, threadId: string, targetPartnerId?: string): Promise<void> {
    const sourceCurrent = (): boolean => this.#state.selectedId === sessionId
      && this.#state.owner?.sessions.filter((session) => session.sessionId === sessionId).length === 1;
    if (!validMobilePartnerId(sessionId) || !validMobilePartnerId(threadId) || !sourceCurrent()) {
      this.#set({ partnerPrivate: { ...emptyMobilePartnerPrivateState(true, "error"),
        error: "Open the current Partner task before inspecting its private thread." } });
      return;
    }
    await this.openPartnerDirectory();
    const context = this.#partnerPrivateContext();
    const directory = this.#state.partnerPrivate;
    if (!context || directory.status !== "ready" || !sourceCurrent()) return;
    const matching = directory.partners.filter((partner) => partner.canonicalSessionId === sessionId);
    if (matching.length !== 1 || targetPartnerId !== undefined
      && (!validMobilePartnerId(targetPartnerId) || targetPartnerId === matching[0]?.partnerId)) {
      this.#set({ partnerPrivate: { ...directory, status: "error",
        error: "This task does not have a unique current Partner owner." } });
      return;
    }
    const viewer = matching[0]!;
    const { generation, controller } = this.#beginPartnerPrivateRequest();
    try {
      const sessions = await this.network.listPartnerSessions(context.credential, viewer.partnerId, controller.signal);
      if (!this.#partnerPrivateRequestCurrent(generation, controller, context.authorityKey) || !sourceCurrent()) return;
      assertMobileCanonicalPartnerSession(viewer, sessionId, sessions);
      this.#partnerPrivateSourceSessionId = sessionId;
      this.#partnerPrivateSourceTargetId = targetPartnerId;
    } catch (error) {
      if (!this.#partnerPrivateRequestCurrent(generation, controller, context.authorityKey)) return;
      this.#set({ partnerPrivate: { ...this.#state.partnerPrivate, status: "error", error: message(error) } });
      return;
    }
    await this.selectPartnerPrivatePartner(viewer.partnerId);
    if (!sourceCurrent() || this.#state.partnerPrivate.status !== "ready") return;
    const listed = this.#state.partnerPrivate.threads.filter((thread) => thread.threadId === threadId);
    if (listed.length !== 1 || targetPartnerId !== undefined && listed[0]?.otherPartnerId !== targetPartnerId) {
      this.#set({ partnerPrivate: { ...this.#state.partnerPrivate, detailStatus: "error",
        detailError: "This private thread does not belong to the current Partner pair." } });
      return;
    }
    await this.openPartnerPrivateThread(viewer.partnerId, threadId);
    if (!sourceCurrent()) {
      this.closePartnerPrivate();
    }
  }

  async refreshPartnerPrivate(): Promise<void> {
    const current = this.#state.partnerPrivate;
    if (!current.open) return;
    const sourceSessionId = this.#partnerPrivateSourceSessionId;
    const sourceTargetId = this.#partnerPrivateSourceTargetId;
    const selectedPartnerId = current.selectedPartnerId;
    const selectedThreadId = current.selectedThreadId;
    if (sourceSessionId !== undefined && selectedThreadId !== undefined) {
      await this.openPartnerPrivateFromSession(sourceSessionId, selectedThreadId, sourceTargetId);
      return;
    }
    await this.openPartnerDirectory();
    if (this.#state.partnerPrivate.status !== "ready" || selectedPartnerId === undefined) return;
    await this.selectPartnerPrivatePartner(selectedPartnerId);
    if (this.#state.partnerPrivate.status !== "ready" || selectedThreadId === undefined) return;
    await this.openPartnerPrivateThread(selectedPartnerId, selectedThreadId);
  }

  closePartnerPrivateThread(): void {
    this.#cancelPartnerPrivateRequests();
    const current = this.#state.partnerPrivate;
    this.#set({ partnerPrivate: { ...current, selectedThreadId: undefined, detail: undefined,
      detailStatus: "idle", detailError: undefined } });
  }

  closePartnerPrivatePartner(): void {
    this.#cancelPartnerPrivateRequests();
    this.#partnerPrivateSourceSessionId = undefined;
    this.#partnerPrivateSourceTargetId = undefined;
    const current = this.#state.partnerPrivate;
    this.#set({ partnerPrivate: { ...current, selectedPartnerId: undefined, threads: [],
      selectedThreadId: undefined, detail: undefined, detailStatus: "idle", detailError: undefined,
      status: this.#partnerPrivateContext() ? "ready" : "offline" } });
  }

  async #resumePartnerPrivate(): Promise<void> {
    const current = this.#state.partnerPrivate;
    if (!current.open) { this.#partnerPrivateResume = undefined; return; }
    const resume = this.#partnerPrivateResume;
    this.#partnerPrivateResume = undefined;
    if (!resume) {
      await this.openPartnerDirectory();
      return;
    }
    if (resume.credentialKey !== this.#partnerPrivateCredentialKey(this.#credential)) {
      this.closePartnerPrivate();
      return;
    }
    if (resume.sourceSessionId !== undefined) {
      if (resume.sourceSessionId !== this.#state.selectedId || resume.selectedThreadId === undefined) {
        this.closePartnerPrivate();
        return;
      }
      await this.openPartnerPrivateFromSession(resume.sourceSessionId, resume.selectedThreadId, resume.sourceTargetId);
      return;
    }
    await this.openPartnerDirectory();
    if (this.#state.partnerPrivate.status !== "ready" || resume.selectedPartnerId === undefined) return;
    await this.selectPartnerPrivatePartner(resume.selectedPartnerId);
    if (this.#state.partnerPrivate.status !== "ready" || resume.selectedThreadId === undefined) return;
    await this.openPartnerPrivateThread(resume.selectedPartnerId, resume.selectedThreadId);
  }

  closePartnerPrivate(): void {
    this.#cancelPartnerPrivateRequests();
    if (this.#partnerPrivateRefreshTimer !== undefined) clearTimeout(this.#partnerPrivateRefreshTimer);
    this.#partnerPrivateRefreshTimer = undefined;
    this.#partnerPrivateSourceSessionId = undefined;
    this.#partnerPrivateSourceTargetId = undefined;
    this.#partnerPrivateResume = undefined;
    this.#set({ partnerPrivate: emptyMobilePartnerPrivateState() });
  }

  async markPartnerPrivateVisible(partnerId: string, threadId: string, throughSequence: number): Promise<void> {
    const context = this.#partnerPrivateContext();
    const state = this.#state.partnerPrivate;
    const detail = state.detail;
    const lease = this.#partnerPrivateDetailLease;
    if (!context || !lease || !detail || !state.open || state.detailStatus !== "ready"
      || state.selectedPartnerId !== partnerId || state.selectedThreadId !== threadId
      || detail.thread.threadId !== threadId || !Number.isSafeInteger(throughSequence)
      || throughSequence < 1 || !detail.messages.some((item) => item.sequence === throughSequence)) return;
    if (throughSequence <= (detail.readState?.throughSequence ?? 0)) return;
    this.#partnerPrivateReadTarget = Math.max(throughSequence, this.#partnerPrivateReadTarget ?? 0);
    if (this.#partnerPrivateReadFlight) {
      await this.#partnerPrivateReadFlight;
      return;
    }
    const controller = new AbortController();
    this.#partnerPrivateReadAbort = controller;
    const flight = (async () => {
      while (this.#partnerPrivateReadTarget !== undefined) {
        const current = this.#state.partnerPrivate;
        const exact = current.detail;
        const target = this.#partnerPrivateReadTarget;
        this.#partnerPrivateReadTarget = undefined;
        if (controller.signal.aborted || this.#partnerPrivateDetailLease !== lease
          || this.#partnerPrivateAuthorityKey(this.#state) !== context.authorityKey
          || current.selectedPartnerId !== partnerId || current.selectedThreadId !== threadId
          || current.detailStatus !== "ready" || !exact || !exact.messages.some((item) => item.sequence === target)) return;
        if (target <= (exact.readState?.throughSequence ?? 0)) continue;
        try {
          const maximum = exact.messages.at(-1)!.sequence;
          const readState = await this.network.markPartnerPrivateThreadRead(context.credential,
            partnerId, threadId, target, maximum, controller.signal);
          if (controller.signal.aborted || this.#partnerPrivateDetailLease !== lease
            || this.#partnerPrivateAuthorityKey(this.#state) !== context.authorityKey) return;
          const latest = this.#state.partnerPrivate;
          if (latest.detailStatus !== "ready" || latest.selectedPartnerId !== partnerId
            || latest.selectedThreadId !== threadId || !latest.detail) return;
          this.#set({ partnerPrivate: { ...latest, detail: { ...latest.detail, readState }, detailError: undefined } });
        } catch (error) {
          if (controller.signal.aborted || this.#partnerPrivateDetailLease !== lease
            || this.#partnerPrivateAuthorityKey(this.#state) !== context.authorityKey) return;
          this.#set({ partnerPrivate: { ...this.#state.partnerPrivate, detailError: message(error) } });
          return;
        }
      }
    })();
    this.#partnerPrivateReadFlight = flight;
    try { await flight; }
    finally {
      if (this.#partnerPrivateReadFlight === flight) this.#partnerPrivateReadFlight = undefined;
      if (this.#partnerPrivateReadAbort === controller) this.#partnerPrivateReadAbort = undefined;
    }
  }

  #cancelAutomationRequests(): void {
    this.#automationAbort?.abort();
    this.#automationHistoryAbort?.abort();
    this.#automationAbort = undefined;
    this.#automationHistoryAbort = undefined;
    this.#automationHistoryPageTokens.clear();
    this.#automationEpoch += 1;
  }

  #beginConnectionAttempt(): { readonly generation: number; readonly controller: AbortController } {
    if (this.#mutationOwner) throw new Error("Finish the current task operation before changing Joko nodes.");
    this.#cancelCatalogAttempt();
    this.#connectionAttemptAbort?.abort();
    const controller = new AbortController();
    this.#connectionAttemptAbort = controller;
    const generation = ++this.#connectionAttemptEpoch;
    this.#set({ busy: true, connectionAttemptError: undefined });
    return { generation, controller };
  }

  #connectionAttemptCurrent(generation: number, controller: AbortController): boolean {
    return !this.#disposed && this.#foreground && this.#connectionAttemptEpoch === generation
      && this.#connectionAttemptAbort === controller && !controller.signal.aborted;
  }

  #hasActiveConnection(): boolean {
    return this.#credential !== undefined && this.#activeProfileId !== undefined;
  }

  #hasOfflineProjection(profileId = this.#activeProfileId): boolean {
    return profileId !== undefined && this.#activeProfileId === profileId
      && this.#state.activeProfileId === profileId && this.#state.offlineSnapshotAt !== undefined
      && this.#state.owner !== undefined;
  }

  #showOfflineProjection(
    profile: MobileConnectionProfile,
    cached: MobileOfflineCacheSnapshot,
    selectedId: string | undefined,
    status: "connecting" | "offline",
    error?: string
  ): void {
    const selected = selectedId !== undefined
      && cached.owner.sessions.some((session) => session.sessionId === selectedId)
      ? selectedId
      : undefined;
    const visibleCachedAt = selected !== undefined && cached.detail !== undefined
      ? cached.detailCachedAt ?? cached.cachedAt
      : cached.cachedAt;
    this.#activeProfileId = profile.profileId;
    this.#lastAuthenticatedAt = visibleCachedAt;
    this.#durableSnapshotAt = visibleCachedAt;
    this.#set({
      status,
      busy: status === "connecting",
      node: cached.node,
      origin: profile.origin,
      owner: cached.owner,
      detail: selected === undefined ? undefined : cached.detail,
      selectedId: selected,
      activeProfileId: profile.profileId,
      automaticProfileId: this.#automaticProfileId,
      pending: this.#allPending.filter((item) => item.connectionId === profile.connectionId && item.taskJoinId === undefined),
      older: [],
      window: undefined,
      before: undefined,
      historyEnd: false,
      historyBusy: false,
      live: [],
      liveStatus: "paused",
      offlineSnapshotAt: visibleCachedAt,
      error: [cached.warning, error].filter(Boolean).join(" ") || undefined
    });
  }

  #adoptOfflineFallback(
    generation: number,
    controller: AbortController,
    profile: MobileConnectionProfile,
    cached: MobileOfflineCacheSnapshot,
    selectedId: string | undefined,
    detail: string,
    credential?: PairedCredential
  ): boolean {
    if (!this.#connectionAttemptCurrent(generation, controller)) return false;
    this.#connectionAttemptAbort = undefined;
    if (credential !== undefined) this.#credential = credential;
    this.#showOfflineProjection(profile, cached, selectedId, "offline", detail);
    this.#set({
      busy: false,
      saved: this.#savedViews(profile.profileId, "offline", detail),
      candidate: undefined,
      challenge: undefined,
      connectionAttemptError: detail
    });
    if (credential !== undefined) this.#schedule();
    return true;
  }

  async #clearOfflineCache(profileId: string): Promise<string | undefined> {
    try {
      const results = await Promise.allSettled([this.offlineCache?.clear(profileId), this.readOnlyDictionaryCache?.clear(profileId),
        this.ownerNetwork.clearMediaCache?.(profileId)]);
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      return undefined;
    } catch (error) {
      return `The saved offline content could not be cleared: ${message(error)}`;
    }
  }

  #dropOfflineProjection(profileId: string): void {
    if (!this.#hasOfflineProjection(profileId) || this.#credential !== undefined) return;
    this.#activeProfileId = undefined;
    this.#lastAuthenticatedAt = undefined;
    this.#durableSnapshotAt = undefined;
    this.#set({
      activeProfileId: undefined,
      node: undefined,
      origin: undefined,
      owner: undefined,
      detail: undefined,
      selectedId: undefined,
      older: [],
      window: undefined,
      before: undefined,
      historyEnd: false,
      historyBusy: false,
      live: [],
      liveStatus: "paused",
      pending: [],
      offlineSnapshotAt: undefined
    });
  }

  async #persistOfflineProjection(
    epoch: number,
    credential: PairedCredential,
    node: NodeIdentity,
    owner: Snapshot,
    detail?: Snapshot
  ): Promise<void> {
    if (!this.offlineCache || !this.#current(epoch) || this.#credential !== credential
      || this.#activeProfileId !== credential.profileId) return;
    const profile = this.#profiles.find((candidate) => candidate.profileId === credential.profileId)
      ?? profileFromCredential(credential);
    try {
      const cachedDetail = detail && this.#state.detail === detail && this.#state.window === undefined && this.#state.older.length > 0
        ? create(SnapshotSchema, { ...detail, timeline: [...this.#state.older, ...detail.timeline]
          .filter((event, index, events) => events.findIndex(candidate => candidate.eventId === event.eventId) === index) })
        : detail;
      await this.offlineCache.save(profile, node, owner, cachedDetail);
      if (this.#current(epoch) && this.#credential === credential
        && this.#activeProfileId === credential.profileId) {
        this.#durableSnapshotAt = this.#lastAuthenticatedAt;
      }
    } catch (error) {
      if (this.#current(epoch) && this.#credential === credential && this.#state.status === "connected") {
        const warning = `Connected, but Joko could not save the offline copy: ${message(error)}`;
        this.#set({ error: [this.#state.error, warning].filter(Boolean).join(" ") });
      }
    }
  }

  async start(): Promise<void> {
    const epoch = this.#retire();
    try {
      const [index, pending] = await Promise.all([
        this.storage.loadConnectionIndex(), this.storage.loadPending()
      ]);
      await this.#taskOutbox?.load();
      for (const record of [...(this.#taskOutbox?.records ?? [])]) {
        if (!index.profiles.some((profile) => mobileTaskOutboxOwnerMatches(record.owner, profile))) continue;
        if (record.state === "staging") await this.#finishTaskOutboxHandoff(record);
        else if (record.state === "restoring") await this.#restoreTaskOutboxDraft(record);
      }
      if (!this.#current(epoch)) return;
      this.#profiles = [...index.profiles];
      this.#automaticProfileId = index.automaticProfileId;
      this.#allPending = pending;
      this.#set({
        pending: [],
        taskOutbox: this.#taskOutbox?.records,
        selectedId: undefined,
        automaticProfileId: index.automaticProfileId,
        saved: this.#savedViews(),
        connectionMode: index.automaticProfileId === undefined ? this.#state.connectionMode : "saved",
        status: index.automaticProfileId === undefined ? "unpaired" : "connecting",
        candidate: undefined,
        connectionAttemptError: undefined,
        error: undefined
      });
      if (index.automaticProfileId === undefined) return;
      if (!this.#profiles.some((profile) => profile.profileId === index.automaticProfileId)) {
        this.#set({
          status: "unpaired",
          error: "The automatic Joko connection no longer exists on this device. Turn automatic entry off or choose another saved connection."
        });
        return;
      }
      try { await this.connectSaved(index.automaticProfileId); }
      catch { /* connectSaved owns the exact, actionable recovery state. */ }
    } catch (error) {
      if (this.#current(epoch)) this.#set({ status: "unpaired", error: message(error) });
    }
  }

  async inspect(rawOrigin: string): Promise<NodeIdentity> {
    const origin = normalizeNodeOrigin(rawOrigin);
    const { generation, controller } = this.#beginConnectionAttempt();
    try {
      const node = await this.network.inspect(origin, controller.signal);
      if (!this.#connectionAttemptCurrent(generation, controller)) return node;
      this.#connectionAttemptAbort = undefined;
      this.#set({ candidate: { origin, node }, busy: false, challenge: undefined, connectionAttemptError: undefined });
      return node;
    } catch (error) {
      this.#failConnectionAttempt(generation, controller, message(error));
      throw error;
    }
  }

  async trustEndpoint(rawOrigin: string, endpointPublicKey: string, replace = false, serverId?: string, endpointTransport?: import('@joko/connection-transport/trust').EndpointTransport): Promise<void> {
    const input = { origin: normalizeNodeOrigin(rawOrigin), endpointPublicKey, serverId, endpointTransport, transportKind: endpointTransport?.kind ?? 'https' as const };
    const challenge = this.#state.challenge;
    if (challenge?.origin === input.origin && (challenge.endpointPublicKey !== input.endpointPublicKey || (challenge.transportKind ?? 'https') !== input.transportKind)) await this.cancelPairing();
    if (replace) replaceEndpointTrust(input); else rememberEndpointTrust(input);
    if (endpointTransport !== undefined) for (const profile of this.#profiles) {
      if (profile.origin === input.origin && profile.endpointPublicKey === endpointPublicKey && profile.transportKind === endpointTransport.kind) await this.storage.saveEndpointTransport?.(profile);
    }
  }

  async createTailcatClient(rawOrigin: string, endpointPublicKey: string, endpointTransport: import('@joko/connection-transport/trust').EndpointTransport): Promise<{ readonly publicKey: string }> {
    const { createTailcatClientIdentity } = await import('@joko/connection-transport/trust');
    return createTailcatClientIdentity(normalizeNodeOrigin(rawOrigin), endpointPublicKey, endpointTransport);
  }

  async createIrohClient(rawOrigin?: string, endpointPublicKey?: string, endpointTransport?: import('@joko/connection-transport/trust').EndpointTransport, mobileMode?: 'native' | 'relay'): Promise<{ readonly publicKey: string }> {
    const { createIrohClientIdentity } = await import('@joko/connection-transport/trust');
    return createIrohClientIdentity(rawOrigin === undefined ? undefined : normalizeNodeOrigin(rawOrigin), endpointPublicKey, endpointTransport, mobileMode);
  }

  async setProfileIrohMode(profileId: string, mode: 'native' | 'relay'): Promise<void> {
    if (mode !== 'native' && mode !== 'relay') throw new Error('Select a supported local iroh connection mode.');
    if (this.#mutationOwner || this.#connectionAttemptAbort || this.#entryAttempt || this.#state.busy) throw new Error('Finish the current operation before changing this connection path.');
    const profile = this.#profiles.find(value => value.profileId === profileId);
    if (profile?.transportKind !== 'iroh' || profile.endpointPublicKey === undefined || this.storage.loadEndpointTransport === undefined || this.storage.saveEndpointTransport === undefined) throw new Error('The original protected iroh connection is unavailable.');
    const { rememberEndpointTransport, trustedEndpointTransport } = await import('@joko/connection-transport/trust');
    this.#set({ busy: true });
    try {
      await this.#changeEntries(async () => {
        const epoch = this.#epoch, key = profile.endpointPublicKey!;
        const current = () => { if (!this.#current(epoch) || this.#profiles.find(value => value.profileId === profileId) !== profile) throw new Error('The original node connection changed.'); };
        const entries = await this.storage.readConnectionEntries?.(profile);
        const { activeConnectionEntry } = await import('@joko/connection-transport/entries');
        const entry = entries && activeConnectionEntry(entries, profile);
        if (!entries) await this.storage.loadEndpointTransport!(profile);
        const previous = entries ? entry?.transport : trustedEndpointTransport(profile.origin, key, 'iroh');
        current();
        if (previous?.kind !== 'iroh') throw new Error('The original private iroh locator is unavailable.');
        if (entries && entry) {
          if (!this.storage.writeConnectionEntries) throw new Error('Protected entrance storage is unavailable.');
          await this.storage.writeConnectionEntries(profile, { ...entries, entries: entries.entries.map(value => value.id === entry.id
            ? { ...value, irohMode: mode, transport: { ...previous, mobileMode: mode } } : value) });
          current();
          rememberEndpointTransport(profile.origin, key, { ...previous, mobileMode: mode });
        } else {
          rememberEndpointTransport(profile.origin, key, { ...previous, mobileMode: mode });
          try { await this.storage.saveEndpointTransport!(profile); }
          catch (error) { rememberEndpointTransport(profile.origin, key, previous); throw error; }
        }
      });
    } finally { this.#set({ busy: false }); }
    if (this.#activeProfileId === profileId && this.#credential) await this.refresh();
  }

  async authorizeNewDevice(options?: import("@joko/connection-transport/trust").NewDeviceAuthorizationOptions): Promise<import("@joko/connection-transport/trust").NodePairingInvitation> {
    const credential = this.#ready(), ownerAbort = this.#abort;
    if (!this.network.authorizeNewDevice) throw new Error("New-device authorization is unavailable.");
    let authorization = options;
    if (options?.irohRelay !== undefined) {
      const { requireIrohRelayInvitationRequest, trustedEndpointTransport } = await import('@joko/connection-transport/trust');
      if (credential.endpointPublicKey === undefined) throw new Error('The original pinned node connection is required.');
      const transport = trustedEndpointTransport(credential.origin, credential.endpointPublicKey, credential.transportKind ?? 'https');
      const request = requireIrohRelayInvitationRequest(transport, options);
      if (transport?.kind !== 'iroh' || request === undefined || this.storage.claimIrohRelayRequest === undefined || this.storage.confirmIrohRelayRequest === undefined) throw new Error('The original relay request journal is unavailable.');
      const retained = await this.storage.claimIrohRelayRequest(credential, { ...request, requestId: this.newId(), nodeEndpointId: transport.endpointId });
      if (this.#credential !== credential || this.#abort !== ownerAbort) throw new Error('The original node connection changed.');
      authorization = { irohRelay: retained, onIrohRelayLease: expiresAt => this.storage.confirmIrohRelayRequest!(credential, retained, expiresAt) };
    }
    const result = await this.network.authorizeNewDevice(credential, ownerAbort?.signal, authorization);
    if (this.#credential !== credential || this.#abort !== ownerAbort) throw new Error("The node connection changed. Check its invitation and connections before retrying.");
    return result;
  }

  async cancelDevicePairing(invitation: import("@joko/connection-transport/trust").NodePairingInvitation): Promise<void> {
    const credential = this.#ready();
    if (credential.serverId !== invitation.serverId || (credential.endpointPublicKey !== undefined && credential.endpointPublicKey !== invitation.endpointPublicKey)
      || (credential.transportKind ?? 'https') !== (invitation.endpointTransport?.kind ?? 'https')) throw new Error("Select the original node and connection path before canceling its invitation.");
    if (!this.network.cancelPairing) throw new Error("Pairing cancellation is unavailable.");
    rememberEndpointTrust(credential);
    await this.network.cancelPairing(credential.origin, invitation.challengeId, this.#abort?.signal, invitation.endpointPublicKey, credential.transportKind ?? 'https');
  }

  async cancelPairing(): Promise<void> {
    const challenge = this.#state.challenge;
    if (challenge !== undefined) {
      if (!this.network.cancelPairing) throw new Error("Pairing cancellation is unavailable.");
      await this.network.cancelPairing(challenge.origin, challenge.id, undefined, challenge.endpointPublicKey, challenge.transportKind ?? 'https');
      if (this.#state.challenge !== challenge) return;
    }
    this.cancel(false);
  }

  async requestPairing(rawOrigin: string, deviceName: string): Promise<string> {
    if (!deviceName.trim()) throw new Error("Enter a device name.");
    if (this.#state.challenge !== undefined) await this.cancelPairing();
    const origin = normalizeNodeOrigin(rawOrigin);
    const endpointPublicKey = trustedEndpointPublicKey(origin);
    const transportKind = endpointPublicKey === undefined ? 'https' : trustedEndpointTransportKind(origin, endpointPublicKey);
    const { generation, controller } = this.#beginConnectionAttempt();
    this.#set({ challenge: undefined });
    try {
      const request = await this.network.requestPairing(origin, deviceName, this.platform, this.deviceNameSource(), controller.signal);
      if (!this.#connectionAttemptCurrent(generation, controller)) return "";
      const candidate = this.#state.candidate;
      if (candidate && (candidate.origin !== origin || candidate.node.serverId !== request.identity.serverId)) {
        throw new Error("The Joko node identity changed. Inspect it again.");
      }
      this.#connectionAttemptAbort = undefined;
      this.#set({ candidate: { origin, node: request.identity }, challenge: { id: request.challengeId, origin, deviceName, endpointPublicKey, transportKind },
        busy: false, connectionAttemptError: undefined });
      return request.challengeId;
    } catch (error) {
      this.#failConnectionAttempt(generation, controller, message(error));
      throw error;
    }
  }

  async pair(rawOrigin: string, code: string, deviceName: string, automatic = false): Promise<void> {
    if (!code.trim() || !deviceName.trim()) throw new Error("Enter a pairing code and device name.");
    const origin = normalizeNodeOrigin(rawOrigin);
    const challenge = this.#state.challenge;
    if (!challenge || challenge.origin !== origin || challenge.deviceName !== deviceName) {
      throw new Error("Request pairing for this node and device before entering its code.");
    }
    if (trustedEndpointPublicKey(origin) !== challenge.endpointPublicKey
      || challenge.endpointPublicKey !== undefined && trustedEndpointTransportKind(origin, challenge.endpointPublicKey) !== (challenge.transportKind ?? 'https')) throw new Error('The pairing connection path changed. Request pairing again on the original trusted node.');
    const existing = challenge.endpointPublicKey ? this.#profiles.find(profile => profile.serverId === this.#state.candidate?.node.serverId && profile.endpointPublicKey === challenge.endpointPublicKey) : undefined;
    if (existing?.endpointPublicKey && this.storage.readConnectionEntries && this.storage.writeConnectionEntries) {
      const api = await import('@joko/connection-transport/entries'), { trustedEndpointTransport } = await import('@joko/connection-transport/trust');
      const epoch = this.#epoch, owner = { profileId: existing.profileId, deviceId: existing.deviceId, serverId: existing.serverId, endpointPublicKey: existing.endpointPublicKey };
      const endpointTransport = trustedEndpointTransport(origin, existing.endpointPublicKey, challenge.transportKind);
      const entryId = await this.#changeEntries(async () => {
        let saved = await this.storage.readConnectionEntries!(existing);
        if (!saved) { await this.storage.loadEndpointTransport?.(existing); saved = api.initialConnectionEntries(owner, existing); }
        const next = api.acceptInvitedConnectionEntry(owner, saved, { origin, serverId: existing.serverId, endpointPublicKey: existing.endpointPublicKey!,
          transportKind: challenge.transportKind, endpointTransport }, this.newId());
        if (!this.#current(epoch) || this.#state.challenge !== challenge) throw new Error('The selected node changed.');
        await this.storage.writeConnectionEntries!(existing, next.saved); return next.entryId;
      });
      if (!this.#current(epoch) || this.#state.challenge !== challenge) return;
      this.cancel(); await this.connectSaved(existing.profileId, automatic, entryId); return;
    }
    const { generation, controller } = this.#beginConnectionAttempt();
    try {
      const result = await this.network.completePairing(origin, challenge.id, code, deviceName, this.platform, this.deviceNameSource(), controller.signal);
      if (!this.#connectionAttemptCurrent(generation, controller)) return;
      const candidate = this.#state.candidate;
      if (candidate && (candidate.origin !== origin || candidate.node.serverId !== result.identity.serverId)) {
        throw new Error("The Joko node identity changed during pairing. Inspect it again.");
      }
      // Prove the credential's identity and device before making it durable.
      rememberEndpointTrust(result.credential);
      const observed = await this.network.inspect(origin, controller.signal);
      if (!this.#connectionAttemptCurrent(generation, controller)) return;
      if (observed.serverId !== result.credential.serverId) throw new Error("The Joko node identity changed during pairing.");
      const owner = await this.network.readOwner(result.credential, this.deviceNameSource(), controller.signal);
      this.#assertOwner(result.credential, owner, observed);
      if (!this.#connectionAttemptCurrent(generation, controller)) return;
      await this.storage.saveConnection(result.credential);
      if (!this.#connectionAttemptCurrent(generation, controller)) return;
      const profile = profileFromCredential(result.credential);
      this.#profiles = upsertProfile(this.#profiles, profile);
      let preferenceError: string | undefined;
      try {
        // Apply the same explicit automatic-entry choice for every successful
        // pairing path, but only after the new credential is durable.
        await this.storage.saveAutomaticProfile(automatic ? profile.profileId : undefined);
        this.#automaticProfileId = automatic ? profile.profileId : undefined;
      }
      catch (error) { preferenceError = `Paired, but automatic entry could not be saved: ${message(error)}`; }
      await this.#adoptConnection(generation, controller, result.credential, observed, owner, undefined, undefined, preferenceError);
    } catch (error) {
      this.#failConnectionAttempt(generation, controller, message(error));
      throw error;
    }
  }

  cancel(cancelPendingPairing = true): void {
    this.#entryAttempt?.abort();
    const challenge = this.#state.challenge;
    if (cancelPendingPairing && challenge !== undefined && this.network.cancelPairing) {
      void this.network.cancelPairing(challenge.origin, challenge.id, undefined, challenge.endpointPublicKey, challenge.transportKind ?? 'https').catch(error => this.#set({ connectionAttemptError: message(error) }));
    }
    this.#cancelCatalogAttempt();
    this.#connectionAttemptAbort?.abort();
    this.#connectionAttemptAbort = undefined;
    this.#connectionAttemptEpoch += 1;
    this.#set({
      busy: this.#mutationOwner !== undefined,
      challenge: undefined,
      candidate: undefined,
      connectionAttemptError: undefined,
      ...(!this.#hasActiveConnection() && this.#state.status === "connecting"
        ? { status: this.#hasOfflineProjection() ? "offline" as const : "unpaired" as const }
        : {})
    });
  }

  async refreshConnectionEntries(profileId: string): Promise<void> {
    return this.#changeEntries(() => this.#refreshConnectionEntries(profileId));
  }
  async connectSavedInvitation(link: string, automatic?: boolean, selectedEntryId?: string): Promise<void> {
    this.#entryAttempt?.abort();
    const attempt = new AbortController(); this.#entryAttempt = attempt;
    const epoch = this.#epoch, signal = AbortSignal.any([attempt.signal, AbortSignal.timeout(30_000)]);
    const current = () => { signal.throwIfAborted(); if (!this.#current(epoch) || !this.#foreground) throw new Error('The selected node changed.'); };
    try { return await this.#changeEntries(async () => {
      current();
      const invitation = parseDeviceInvitation(link);
      const profile = this.#profiles.find(p => p.serverId === invitation.serverId && p.endpointPublicKey === invitation.endpointPublicKey);
      if (!profile?.endpointPublicKey || invitation.expiresAt <= this.now() || !this.storage.readConnectionEntries || !this.storage.writeConnectionEntries) throw new Error('This invitation does not match a saved, verified node.');
      const api = await import('@joko/connection-transport/entries');
      const owner = { profileId: profile.profileId, deviceId: profile.deviceId, serverId: profile.serverId, endpointPublicKey: profile.endpointPublicKey };
      let saved = await this.storage.readConnectionEntries(profile);
      if (!saved) { await this.storage.loadEndpointTransport?.(profile); saved = api.initialConnectionEntries(owner, profile); }
      const next = api.acceptInvitedConnectionEntry(owner, saved, { ...invitation, transportKind: invitation.endpointTransport?.kind,
        endpointTransport: bindDeviceInvitationTransport(invitation, invitation.transportRequestId ? await this.storage.readDeviceTransportRequest?.() : undefined) }, this.newId());
      current();
      await this.storage.writeConnectionEntries(profile, next.saved);
      let entryId = next.entryId;
      if (selectedEntryId) {
        const bootstrap = await api.resolvePreparedConnection(owner, next.saved, async () => {
          const credential = await this.storage.loadCredential(profile.profileId);
          if (!credential || !credentialMatchesProfile(credential, profile)) throw new CredentialIdentityError();
          return credential.authKey;
        }, this.connectionEntrySupported, signal, entryId);
        entryId = (await api.prepareSelectedConnectionEntry(owner, bootstrap.saved, selectedEntryId, bootstrap.entry, bootstrap.authKey,
          { read: () => this.storage.readConnectionEntries!(profile), write: async value => { current(); await this.storage.writeConnectionEntries!(profile, value); current(); } },
          this.connectionEntrySupported, signal, { uuid: this.newId, irohMode: this.connectionEntryIrohMode })).entryId;
      }
      current(); await this.#connectSaved(profile.profileId, automatic, entryId, false, attempt);
    }); } finally { if (this.#entryAttempt === attempt) this.#entryAttempt = undefined; }
  }
  async #refreshConnectionEntries(profileId: string): Promise<void> {
    const profile = this.#profiles.find(p => p.profileId === profileId);
    if (!profile?.endpointPublicKey || !this.storage.readConnectionEntries || !this.storage.writeConnectionEntries) return;
    const api = await import('@joko/connection-transport/entries'), epoch = this.#epoch;
    const owner = { profileId, deviceId: profile.deviceId, serverId: profile.serverId, endpointPublicKey: profile.endpointPublicKey };
    let saved = await this.storage.readConnectionEntries(profile);
    if (!saved) { await this.storage.loadEndpointTransport?.(profile); saved = api.initialConnectionEntries(owner, profile); }
    const credential = this.#credential;
    if (credential?.profileId === profileId && this.#state.status === 'connected') {
      const active = api.activeConnectionEntry(saved, credential);
      if (!active) throw new Error('The current entrance is absent from the saved directory.');
      const directory = await api.readConnectionEntryDirectory(owner, active, credential.authKey, AbortSignal.timeout(10_000));
      if (!this.#current(epoch) || this.#credential !== credential) return;
      saved = api.mergeConnectionEntryDirectory(saved, owner, directory);
      await this.storage.writeConnectionEntries(profile, saved);
      for (const id of api.entriesNeedingRenewal(saved, this.connectionEntrySupported, this.now())) {
        saved = await api.prepareEntryAndSave(owner, saved, id, active, credential.authKey, { read: () => this.storage.readConnectionEntries!(profile), write: async value => {
          if (!this.#current(epoch) || this.#credential !== credential) throw new Error('The node connection changed.');
          await this.storage.writeConnectionEntries!(profile, value);
        } }, AbortSignal.timeout(25_000), { uuid: this.newId, irohMode: this.connectionEntryIrohMode, renew: true });
      }
    }
    if (!this.#current(epoch)) return;
    this.#entryRefreshAt = this.now();
    this.#set({ connectionEntries: { profileId, entries: api.connectionEntryViews(saved, credential?.profileId === profileId ? credential : profile, this.connectionEntrySupported),
      returnToPreferred: saved.returnToPreferred } });
  }

  async prepareConnectionEntry(profileId: string, entryId: string): Promise<void> {
    return this.#changeEntries(() => this.#prepareConnectionEntry(profileId, entryId));
  }
  async #prepareConnectionEntry(profileId: string, entryId: string): Promise<void> {
    const credential = this.#credential, profile = this.#profiles.find(p => p.profileId === profileId);
    if (!credential || credential.profileId !== profileId || !profile?.endpointPublicKey || this.#state.status !== 'connected'
      || !this.storage.readConnectionEntries || !this.storage.writeConnectionEntries) throw new Error('Connect to this saved node before preparing a backup.');
    const api = await import('@joko/connection-transport/entries'), epoch = this.#epoch;
    const saved = await this.storage.readConnectionEntries(profile);
    const active = saved ? api.activeConnectionEntry(saved, credential) : undefined;
    const candidate = saved?.entries.find(e => e.id === entryId);
    if (!saved || !active || !candidate || !this.connectionEntrySupported(candidate.kind)) throw new Error('This entrance is unavailable on this client.');
    const current = () => { if (!this.#current(epoch) || this.#credential !== credential) throw new Error('The original connection changed.'); };
    const next = await api.prepareEntryAndSave({ profileId, deviceId: profile.deviceId, serverId: profile.serverId, endpointPublicKey: profile.endpointPublicKey },
      saved, entryId, active, credential.authKey, { read: () => this.storage.readConnectionEntries!(profile),
        write: async value => { current(); await this.storage.writeConnectionEntries!(profile, value); current(); } }, AbortSignal.timeout(25_000),
      { uuid: this.newId, irohMode: this.connectionEntryIrohMode });
    current(); this.#set({ connectionEntries: { profileId, entries: api.connectionEntryViews(next, credential, this.connectionEntrySupported), returnToPreferred: next.returnToPreferred } });
  }
  async setConnectionEntryPolicy(profileId: string, backupIds: readonly string[], returnToPreferred: boolean): Promise<void> {
    this.#entryAttempt?.abort();
    this.#entryStableSince = 0;
    return this.#changeEntries(() => this.#setConnectionEntryPolicy(profileId, backupIds, returnToPreferred));
  }
  async #setConnectionEntryPolicy(profileId: string, backupIds: readonly string[], returnToPreferred: boolean): Promise<void> {
    const profile = this.#profiles.find(p => p.profileId === profileId);
    if (!profile?.endpointPublicKey || !this.storage.readConnectionEntries || !this.storage.writeConnectionEntries) throw new Error('The saved node is unavailable.');
    const saved = await this.storage.readConnectionEntries(profile);
    if (!saved || backupIds.some(id => !saved.entries.some(e => e.id === id && e.prepared && this.connectionEntrySupported(e.kind)))) throw new Error('Prepare each backup before allowing it.');
    const next = { ...saved, backupIds, returnToPreferred };
    await this.storage.writeConnectionEntries(profile, next);
    const { connectionEntryViews } = await import('@joko/connection-transport/entries');
    this.#set({ connectionEntries: { profileId, entries: connectionEntryViews(next, profile, this.connectionEntrySupported), returnToPreferred } });
  }
  async #maintainConnectionEntries(): Promise<boolean> {
    const profile = this.#profiles.find(p => p.profileId === this.#activeProfileId);
    if (this.#entriesBusy || this.#entryAttempt || !profile?.endpointPublicKey || !this.#foreground || this.#disposed || this.#state.busy || this.#mutationOwner || !this.storage.readConnectionEntries) return false;
    this.#entriesBusy = true;
    const epoch = this.#epoch;
    let probedEntry: import('@joko/connection-transport/entries').SavedConnectionEntry | undefined;
    try {
      const saved = await this.storage.readConnectionEntries(profile);
      if (!saved || !this.#current(epoch)) return false;
      if (this.#state.status === 'offline') { await this.connectSaved(profile.profileId, undefined, undefined, true); return true; }
      if (this.#state.status !== 'connected') return false;
      if (this.now() - this.#entryRefreshAt > 60_000) await this.refreshConnectionEntries(profile.profileId);
      const { verifyConnectionEntry, activeConnectionEntry, entryReadiness } = await import('@joko/connection-transport/entries');
      const preferred = saved.entries.find(e => e.id === saved.preferredId);
      if (!saved.returnToPreferred || !preferred || entryReadiness(preferred, this.connectionEntrySupported, this.now()) !== 'ready'
        || preferred.id === activeConnectionEntry(saved, profile)?.id || this.now() - this.#entryLastSwitch < 60_000) { this.#entryStableSince = 0; return false; }
      probedEntry = preferred;
      await verifyConnectionEntry({ profileId: profile.profileId, deviceId: profile.deviceId, serverId: profile.serverId, endpointPublicKey: profile.endpointPublicKey }, preferred, AbortSignal.timeout(6_000));
      if (!this.#current(epoch)) return false;
      this.#entryStableSince ||= this.now();
      if (this.now() - this.#entryStableSince >= 30_000) { await this.connectSaved(profile.profileId, undefined, preferred.id, true); return true; }
    } catch (error) {
      this.#entryStableSince = 0;
      if (this.#current(epoch) && isEndpointTrustError(error)) {
        try {
          await this.#changeEntries(async () => {
            if (!probedEntry || !this.#current(epoch) || this.#entryAttempt || !this.storage.writeConnectionEntries) return;
            const latest = await this.storage.readConnectionEntries!(profile);
            if (!latest || !this.#current(epoch) || this.#entryAttempt
              || !latest.entries.some(entry => JSON.stringify(entry) === JSON.stringify(probedEntry))) return;
            const next = { ...latest, entries: latest.entries.map(entry => entry.id === probedEntry!.id ? { ...entry, verification: 'identity-conflict' as const } : entry) };
            await this.storage.writeConnectionEntries(profile, next);
            if (!this.#current(epoch)) return;
            const { connectionEntryViews } = await import('@joko/connection-transport/entries');
            this.#set({ connectionAttemptError: message(error), connectionEntries: { profileId: profile.profileId,
              entries: connectionEntryViews(next, profile, this.connectionEntrySupported), returnToPreferred: next.returnToPreferred } });
          });
        } catch (failure) { if (this.#current(epoch)) this.#set({ connectionAttemptError: message(failure) }); }
      }
    } finally { this.#entriesBusy = false; }
    return false;
  }

  async connectSaved(profileId: string, automatic?: boolean, entryId?: string, entryRecovery = false): Promise<void> {
    this.#entryAttempt?.abort();
    const attempt = new AbortController(); this.#entryAttempt = attempt;
    const epoch = this.#epoch;
    try { return await this.#changeEntries(async () => {
      if (attempt.signal.aborted || !this.#current(epoch)) return;
      await this.#connectSaved(profileId, automatic, entryId, entryRecovery, attempt);
    }); } finally { if (this.#entryAttempt === attempt) this.#entryAttempt = undefined; }
  }
  async #connectSaved(profileId: string, automatic: boolean | undefined, entryId: string | undefined, entryRecovery: boolean, entryAttempt: AbortController): Promise<void> {
    if (entryAttempt.signal.aborted || !this.#foreground || this.#disposed) return;
    let profile = this.#profiles.find((candidate) => candidate.profileId === profileId);
    if (!profile) throw new Error("This saved Joko connection is no longer available on this device.");
    if (this.#activeProfileId === profileId && this.#credential && entryId === undefined && !entryRecovery) {
      await this.refresh();
      if (this.#state.status === "connected" && automatic !== undefined) {
        await this.setAutomaticEntryForActive(automatic);
      }
      return;
    }
    const originalProfile = profile, originalEpoch = this.#epoch;
    let preflight = true;
    try {
      const entryApi = await import('@joko/connection-transport/entries');
      let savedEntries = profile.endpointPublicKey ? await this.storage.readConnectionEntries?.(profile) : undefined;
      const entryOwner = profile.endpointPublicKey ? { profileId, serverId: profile.serverId, deviceId: profile.deviceId, endpointPublicKey: profile.endpointPublicKey } : undefined;
      let savedCredential: PairedCredential | undefined;
      const resolved = savedEntries && entryOwner ? await entryApi.resolvePreparedConnection(entryOwner, savedEntries, async () => {
        savedCredential = await this.storage.loadCredential(profileId);
        if (savedCredential && !credentialMatchesProfile(savedCredential, originalProfile)) throw new CredentialIdentityError();
        return savedCredential?.authKey;
      }, this.connectionEntrySupported, entryAttempt.signal, entryId, async next => {
        entryAttempt.signal.throwIfAborted(); if (!this.#current(originalEpoch)) throw new Error('The node connection changed.');
        await this.storage.writeConnectionEntries!(originalProfile, next); savedEntries = next;
      }) : undefined;
      if (entryAttempt.signal.aborted || this.#entryAttempt !== entryAttempt || this.#epoch !== originalEpoch || !this.#foreground || this.#disposed) return;
      if (resolved && entryOwner) {
        entryApi.activateConnectionEntry(entryOwner, resolved.entry);
        profile = { ...profile, entryId: resolved.entry.id, origin: resolved.entry.origin, transportKind: resolved.entry.kind };
      }
      await this.#releaseQueueEditBeforeTransition();
      if (entryAttempt.signal.aborted || this.#entryAttempt !== entryAttempt || this.#epoch !== originalEpoch || !this.#foreground || this.#disposed) return;
      preflight = false;
      const preserveActiveConnection = this.#hasActiveConnection();
      const { generation, controller } = this.#beginConnectionAttempt();
      this.#set({
        ...(!this.#hasActiveConnection() ? { status: "connecting" as const } : {}),
        candidate: undefined,
        challenge: undefined,
        saved: this.#savedViews(profileId, "checking")
      });
      const cancelEntryAttempt = () => controller.abort();
      entryAttempt.signal.addEventListener('abort', cancelEntryAttempt, { once: true });
      let selection: string | undefined;
      let cached: MobileOfflineCacheSnapshot | undefined;
      let cacheLoadWarning: string | undefined;
      let credential: PairedCredential | undefined;
      let offlineEligible = true;
      try {
        selection = await this.storage.loadSelection(profileId);
        if (!this.#connectionAttemptCurrent(generation, controller)) return;
        if (!preserveActiveConnection && this.offlineCache) {
          try {
            cached = await this.offlineCache.load(profile, selection);
            if (!this.#connectionAttemptCurrent(generation, controller)) return;
            if (cached) this.#showOfflineProjection(profile, cached, selection, "connecting");
          } catch (error) {
            cacheLoadWarning = message(error);
            if (!this.#connectionAttemptCurrent(generation, controller)) return;
          }
        }
        // Public identity proof must precede the protected credential read.
        if (!resolved) await this.storage.loadEndpointTransport?.(profile);
        rememberEndpointTrust(profile);
        const node = await this.network.inspect(profile.origin, controller.signal);
        if (!this.#connectionAttemptCurrent(generation, controller)) return;
        if (cached) cached = { ...cached, node };
        this.#set({ candidate: { origin: profile.origin, node } });
        if (node.serverId !== profile.serverId) {
          offlineEligible = false;
          this.#dropOfflineProjection(profileId);
          const cleanup = await this.#clearOfflineCache(profileId);
          if (!this.#connectionAttemptCurrent(generation, controller)) return;
          const detail = [
            "The saved Joko node identity changed. Its credential was not read; forget it or inspect and pair this node again.",
            cleanup
          ].filter(Boolean).join(" ");
          this.#failConnectionAttempt(generation, controller, detail, {
            saved: this.#savedViews(profileId, "identity-conflict", detail)
          });
          throw new Error(detail);
        }
        try { credential = savedCredential ?? await this.storage.loadCredential(profileId); }
        catch (error) {
          if (!this.#connectionAttemptCurrent(generation, controller)) return;
          const failure = credentialFailure(error);
          offlineEligible = failure === "unavailable";
          if (!offlineEligible || !cached) {
            if (!offlineEligible) this.#dropOfflineProjection(profileId);
            const cleanup = offlineEligible ? undefined : await this.#clearOfflineCache(profileId);
            if (!this.#connectionAttemptCurrent(generation, controller)) return;
            const detail = [message(error), cleanup].filter(Boolean).join(" ");
            this.#failConnectionAttempt(generation, controller, detail, {
              saved: this.#savedViews(profileId, failure, detail)
            });
          }
          throw error;
        }
        if (!credential || !credentialMatchesProfile(credential, originalProfile)) {
          offlineEligible = false;
          this.#dropOfflineProjection(profileId);
          const cleanup = await this.#clearOfflineCache(profileId);
          if (!this.#connectionAttemptCurrent(generation, controller)) return;
          const detail = [credential
            ? "The protected credential does not match this saved Joko connection. Forget it and pair again."
            : "The protected credential for this saved Joko connection is missing. Forget it and pair again.", cleanup]
            .filter(Boolean).join(" ");
          this.#failConnectionAttempt(generation, controller, detail, {
            saved: this.#savedViews(profileId, credential ? "unreadable" : "missing", detail)
          });
          throw new Error(detail);
        }
        if (resolved) credential = { ...credential, entryId: profile.entryId, origin: profile.origin, transportKind: profile.transportKind };
        const owner = await this.network.readOwner(credential, this.deviceNameSource(), controller.signal);
        if (!this.#connectionAttemptCurrent(generation, controller)) return;
        this.#assertOwner(credential, owner, node);
        const selected = selection !== undefined && owner.snapshot.sessions.some((session) => session.sessionId === selection)
          ? selection : undefined;
        const detail = selected ? await this.network.readSession(credential, selected, controller.signal) : undefined;
        if (!this.#connectionAttemptCurrent(generation, controller)) return;
        if (selected !== selection) await this.storage.saveSelection(profileId, selected);
        let preferenceError: string | undefined;
        if (automatic !== undefined) {
          try {
            await this.storage.saveAutomaticProfile(automatic ? profileId : undefined);
            this.#automaticProfileId = automatic ? profileId : undefined;
          } catch (error) {
            preferenceError = `Connected, but the automatic-entry preference could not be saved: ${message(error)}`;
          }
        }
        preferenceError = [preferenceError, cacheLoadWarning].filter(Boolean).join(" ") || undefined;
        if (savedEntries && entryOwner) {
          const next = entryId ? { ...savedEntries, preferredId: entryId, backupIds: savedEntries.backupIds.filter(id => id !== entryId) } : savedEntries;
          await this.storage.writeConnectionEntries?.(profile, next);
          if (!this.#connectionAttemptCurrent(generation, controller)) return;
          await this.storage.saveConnection(credential);
          this.#profiles = [...(await this.storage.loadConnectionIndex()).profiles];
          if (!this.#connectionAttemptCurrent(generation, controller)) return;
          this.#set({ connectionEntries: { profileId, entries: entryApi.connectionEntryViews(next, profile, this.connectionEntrySupported), returnToPreferred: next.returnToPreferred,
            ...(resolved?.entry.id !== next.preferredId ? { notice: 'Using a prepared backup. Your preferred entrance has not changed.' } : {}) } });
        }
        entryAttempt.signal.removeEventListener('abort', cancelEntryAttempt);
        await this.#adoptConnection(generation, controller, credential, node, owner, selected, detail, preferenceError);
      } catch (error) {
        if (!this.#connectionAttemptCurrent(generation, controller)) {
          if (controller.signal.aborted) return;
          throw error;
        }
        if (isRevoked(error)) {
          await this.#invalidateConnectionAttemptProfile(
            generation,
            controller,
            profileId,
            "This mobile connection was revoked. Forget it or pair this device again."
          );
        } else if (error instanceof CredentialIdentityError || isEndpointTrustError(error)) {
          this.#dropOfflineProjection(profileId);
          const cleanup = await this.#clearOfflineCache(profileId);
          if (!this.#connectionAttemptCurrent(generation, controller)) return;
          const detail = [message(error), cleanup].filter(Boolean).join(" ");
          this.#failConnectionAttempt(generation, controller, detail, {
            saved: this.#savedViews(profileId, "identity-conflict", detail)
          });
        } else if (cached && offlineEligible
          && this.#adoptOfflineFallback(generation, controller, profile, cached, selection, message(error), credential)) {
          return;
        } else if (this.#state.saved.find((item) => item.profileId === profileId)?.credentialState === "checking") {
          this.#dropOfflineProjection(profileId);
          const detail = [message(error), cacheLoadWarning].filter(Boolean).join(" ");
          this.#failConnectionAttempt(generation, controller, detail, {
            saved: this.#savedViews(profileId, "offline", detail)
          });
        }
        throw error;
      } finally { entryAttempt.signal.removeEventListener('abort', cancelEntryAttempt); }
    } catch (error) {
      if (!preflight) throw error;
      if (entryAttempt.signal.aborted || this.#entryAttempt !== entryAttempt || !this.#current(originalEpoch)) return;
      // Startup already shows connecting while the saved entrance is checked.
      // Reuse the existing failure/retirement path even before gateway creation.
      const detail = message(error);
      if (isRevoked(error) && this.#activeProfileId === profileId) {
        await this.#invalidateCredential(originalEpoch, profileId, detail);
      } else {
        const { generation, controller } = this.#beginConnectionAttempt();
        if (isRevoked(error)) await this.#invalidateConnectionAttemptProfile(generation, controller, profileId, detail);
        else if (error instanceof CredentialIdentityError || isEndpointTrustError(error)) {
          this.#dropOfflineProjection(profileId);
          const cleanup = await this.#clearOfflineCache(profileId);
          const failure = [detail, cleanup].filter(Boolean).join(' ');
          this.#failConnectionAttempt(generation, controller, failure, { saved: this.#savedViews(profileId, 'identity-conflict', failure) });
        } else this.#failConnectionAttempt(generation, controller, detail, { saved: this.#savedViews(profileId, 'offline', detail) });
      }
      throw error;
    }
  }

  async #adoptConnection(
    generation: number,
    controller: AbortController,
    credential: PairedCredential,
    node: NodeIdentity,
    owner: Awaited<ReturnType<MobileNetwork["readOwner"]>>,
    selectedId?: string,
    detail?: Snapshot,
    preferenceError?: string
  ): Promise<void> {
    if (!this.#connectionAttemptCurrent(generation, controller)) return;
    if (this.#queueEditLease) this.#releaseQueueEditLeaseDetached(this.#queueEditLease);
    if (this.#queueInteractionLease) this.#releaseQueueInteractionLeaseDetached(this.#queueInteractionLease);
    this.#connectionAttemptAbort = undefined;
    this.#joinedTask?.lifetime.abort(); this.#joinedTask = undefined; this.#set({ taskSource: { kind: "own" } });
    const epoch = this.#retire();
    if (!this.#current(epoch)) return;
    const priorProfileId = this.#activeProfileId;
    this.#credential = credential;
    this.#entryLastSwitch = this.now(); this.#entryStableSince = 0;
    this.#activeProfileId = credential.profileId;
    this.#lastAuthenticatedAt = this.now();
    if (priorProfileId !== credential.profileId) this.#durableSnapshotAt = undefined;
    const ownedPending = this.#allPending.filter((item) => item.connectionId === credential.connectionId && item.taskJoinId === undefined);
    this.#set({
      status: "connected",
      busy: false,
      node,
      origin: credential.origin,
      owner: owner.snapshot,
      detail,
      selectedId,
      activeProfileId: credential.profileId,
      automaticProfileId: this.#automaticProfileId,
      pending: ownedPending,
      saved: this.#savedViews(credential.profileId, "available"),
      candidate: undefined,
      challenge: undefined,
      connectionAttemptError: undefined,
      older: [],
      window: undefined,
      before: undefined,
      historyEnd: false,
      historyBusy: false,
      live: [],
      offlineSnapshotAt: undefined,
      ...(priorProfileId !== credential.profileId
        ? { automations: emptyMobileAutomationsState(this.#state.automations.open,
            this.#state.automations.open ? "loading" : "idle") }
        : {}),
      error: preferenceError
    });
    this.#beginStream(epoch, credential, owner.snapshot);
    if (this.#state.partnerPrivate.open) void this.#resumePartnerPrivate();
    await this.#persistOfflineProjection(epoch, credential, node, owner.snapshot, detail);
    await this.reconcile(epoch);
    if (this.#current(epoch) && this.#state.automations.open) await this.refreshAutomations();
    if (this.#current(epoch)) this.#schedule();
    if (this.#current(epoch) && credential.endpointPublicKey) void this.refreshConnectionEntries(credential.profileId).catch(() => undefined);
  }

  #failConnectionAttempt(
    generation: number,
    controller: AbortController,
    detail: string,
    patch: Partial<MobileState> = {}
  ): void {
    if (!this.#connectionAttemptCurrent(generation, controller)) return;
    this.#connectionAttemptAbort = undefined;
    this.#set({
      ...(!this.#hasActiveConnection() ? { status: "unpaired" as const } : {}),
      busy: false,
      connectionAttemptError: detail,
      ...patch
    });
  }

  async #invalidateConnectionAttemptProfile(
    generation: number,
    controller: AbortController,
    profileId: string,
    detail: string
  ): Promise<void> {
    if (!this.#connectionAttemptCurrent(generation, controller)) return;
    this.#dropOfflineProjection(profileId);
    const offlineCacheFailure = await this.#clearOfflineCache(profileId);
    if (!this.#connectionAttemptCurrent(generation, controller)) return;
    let automaticFailure: string | undefined;
    const wasAutomatic = this.#automaticProfileId === profileId;
    if (wasAutomatic) {
      try {
        await this.storage.saveAutomaticProfile();
        this.#automaticProfileId = undefined;
      } catch (error) { automaticFailure = message(error); }
    }
    if (!this.#connectionAttemptCurrent(generation, controller)) return;
    let credentialFailure: string | undefined;
    try {
      await this.storage.deleteCredential(profileId);
      if (wasAutomatic) this.#automaticProfileId = undefined;
    }
    catch (error) { credentialFailure = message(error); }
    if (!this.#connectionAttemptCurrent(generation, controller)) return;
    const cleanup = [credentialFailure, this.#automaticProfileId === profileId ? automaticFailure : undefined,
      offlineCacheFailure]
      .filter(Boolean).join(" ");
    const error = cleanup ? `${detail} ${cleanup}` : detail;
    this.#connectionAttemptAbort = undefined;
    this.#set({
      ...(!this.#hasActiveConnection() ? { status: "revoked" as const } : {}),
      busy: false,
      automaticProfileId: this.#automaticProfileId,
      saved: this.#savedViews(profileId, credentialFailure ? "unavailable" : "missing", error),
      connectionAttemptError: error
    });
  }

  async disableAutomaticEntry(): Promise<void> {
    if (this.#mutationOwner || this.#connectionAttemptAbort || this.#state.busy) {
      throw new Error("Finish the current operation before changing automatic entry.");
    }
    this.#cancelCatalogAttempt();
    this.#set({ busy: true });
    try {
      await this.storage.saveAutomaticProfile();
      this.#automaticProfileId = undefined;
      this.#set({ busy: false, automaticProfileId: undefined, saved: this.#savedViews() });
    } catch (error) {
      this.#set({ busy: false });
      throw error;
    }
  }

  setConnectionMode(mode: MobileState["connectionMode"]): void {
    this.cancel();
    this.#set({ connectionMode: mode });
  }

  async refreshSaved(): Promise<void> {
    const { generation, controller } = this.#beginCatalogAttempt();
    this.#set({ saved: this.#profiles.map((profile) => this.#savedConnection(
      profile,
      this.#automaticProfileId === profile.profileId,
      "checking"
    )) });
    const saved = await Promise.all(this.#profiles.map(async (profile): Promise<SavedMobileConnection> => {
      try {
        await this.storage.loadEndpointTransport?.(profile);
        rememberEndpointTrust(profile);
        const identity = await this.network.inspect(profile.origin, controller.signal);
        if (!this.#catalogCurrent(generation, controller)) {
          return this.#savedConnection(profile, this.#automaticProfileId === profile.profileId, "unknown");
        }
        if (identity.serverId !== profile.serverId) {
          return this.#savedConnection(profile, this.#automaticProfileId === profile.profileId, "identity-conflict",
            "The node at this address has a different identity. Its credential was not read.");
        }
        const credential = await this.storage.loadCredential(profile.profileId);
        if (credential === undefined) {
          return this.#savedConnection(profile, this.#automaticProfileId === profile.profileId, "missing",
            "The protected credential is missing. Forget this connection and pair again.");
        }
        if (!credentialMatchesProfile(credential, profile)) {
          return this.#savedConnection(profile, this.#automaticProfileId === profile.profileId, "unreadable",
            "The protected credential does not match this exact connection.");
        }
        return this.#savedConnection(profile, this.#automaticProfileId === profile.profileId, "available");
      } catch (error) {
        if (controller.signal.aborted) return this.#savedConnection(profile, this.#automaticProfileId === profile.profileId, "unknown");
        const failure = error instanceof MobileCredentialStorageError ? credentialFailure(error) : "offline";
        return this.#savedConnection(profile, this.#automaticProfileId === profile.profileId, failure, message(error));
      }
    }));
    if (!this.#catalogCurrent(generation, controller)) return;
    this.#catalogAbort = undefined;
    this.#set({ saved });
  }

  async refreshNearby(): Promise<void> {
    const { generation, controller } = this.#beginCatalogAttempt();
    const previous = this.#unexpiredNearby(this.#state.nearby);
    this.#set({ discoveryState: "refreshing", discoveryError: undefined });
    const failures: string[] = [];
    let direct: readonly DiscoveredNodeRecord[] = [];
    try { direct = await this.discovery.scan(controller.signal); }
    catch (error) { if (!controller.signal.aborted) failures.push(message(error)); }
    if (!this.#catalogCurrent(generation, controller)) return;
    const seedOrigins = [...new Set([...direct.map((node) => node.origin), ...this.#profiles.map((profile) => profile.origin)])];
    const expanded = await Promise.all(seedOrigins.slice(0, 64).map(async (origin) => {
      try { return await this.network.discover(origin, controller.signal); }
      catch (error) { if (!controller.signal.aborted) failures.push(message(error)); return [] as readonly DiscoveredNodeRecord[]; }
    }));
    if (!this.#catalogCurrent(generation, controller)) return;
    const candidates = mergeDiscoveryCandidates([...direct, ...expanded.flat()]);
    const verified = (await Promise.all(candidates.slice(0, 128).map(async (candidate): Promise<NearbyMobileNode | undefined> => {
      try {
        rememberEndpointTrust(candidate);
        const identity = await this.network.inspect(candidate.origin, controller.signal);
        if (identity.serverId !== candidate.serverId) return undefined;
        return {
          ...candidate,
          displayName: identity.displayName,
          version: identity.version,
          apiVersion: identity.apiVersion,
          pairingEnabled: identity.pairingEnabled,
          health: identity.health
        };
      } catch (error) {
        if (!controller.signal.aborted) failures.push(message(error));
        return undefined;
      }
    }))).filter((node): node is NearbyMobileNode => node !== undefined)
      .sort((left, right) => left.displayName.localeCompare(right.displayName) || left.serverId.localeCompare(right.serverId));
    if (!this.#catalogCurrent(generation, controller)) return;
    const detail = [...new Set(failures)].slice(0, 2).join(" ");
    const nearby = mergeRecentNearby(previous, verified);
    this.#catalogAbort = undefined;
    if (verified.length === 0 && failures.length > 0) {
      this.#set({ discoveryState: "error", nearby, discoveryError: detail || "Nearby Joko nodes could not be refreshed." });
    } else {
      this.#set({ discoveryState: "ready", nearby, discoveryError: detail || undefined });
    }
    this.#scheduleNearbyExpiry();
  }

  #unexpiredNearby(nodes: readonly NearbyMobileNode[]): NearbyMobileNode[] {
    const now = this.now();
    return nodes.filter((node) => node.lastSeen + LAN_DISCOVERY_PEER_TTL_MS > now);
  }

  #scheduleNearbyExpiry(): void {
    if (this.#discoveryExpiryTimer !== undefined) clearTimeout(this.#discoveryExpiryTimer);
    this.#discoveryExpiryTimer = undefined;
    const nextExpiry = this.#state.nearby.reduce<number | undefined>((earliest, node) => {
      const expiresAt = node.lastSeen + LAN_DISCOVERY_PEER_TTL_MS;
      return earliest === undefined || expiresAt < earliest ? expiresAt : earliest;
    }, undefined);
    if (nextExpiry === undefined || this.#disposed || !this.#foreground) return;
    this.#discoveryExpiryTimer = setTimeout(() => {
      this.#discoveryExpiryTimer = undefined;
      const nearby = this.#unexpiredNearby(this.#state.nearby);
      if (nearby.length !== this.#state.nearby.length) this.#set({ nearby });
      this.#scheduleNearbyExpiry();
    }, Math.max(1, nextExpiry - this.now() + 1));
  }

  async inspectNearby(node: NearbyMobileNode): Promise<NodeIdentity> {
    this.#set({ connectionMode: "add" });
    return this.inspect(node.origin);
  }

  async setAutomaticEntryForActive(enabled: boolean): Promise<void> {
    if (this.#mutationOwner || this.#connectionAttemptAbort || this.#state.busy) {
      throw new Error("Finish the current operation before changing automatic entry.");
    }
    this.#cancelCatalogAttempt();
    const profileId = this.#activeProfileId;
    if (enabled && (!profileId || this.#state.status !== "connected")) {
      throw new Error("Connect to a saved Joko node before enabling automatic entry.");
    }
    this.#set({ busy: true });
    try {
      await this.storage.saveAutomaticProfile(enabled ? profileId : undefined);
      this.#automaticProfileId = enabled ? profileId : undefined;
      this.#set({ busy: false, automaticProfileId: this.#automaticProfileId, saved: this.#savedViews() });
    } catch (error) {
      this.#set({ busy: false });
      throw error;
    }
  }

  async forgetConnection(profileId: string): Promise<void> {
    this.#entryAttempt?.abort();
    return this.#changeEntries(() => this.#forgetConnection(profileId));
  }
  async #forgetConnection(profileId: string): Promise<void> {
    if (this.#mutationOwner || this.#state.busy) {
      throw new Error("Finish the current operation before forgetting a saved connection.");
    }
    const profile = this.#profiles.find((candidate) => candidate.profileId === profileId);
    if (!profile) return;
    if (this.#activeProfileId === profileId) await this.#releaseQueueEditBeforeTransition();
    this.cancel();
    this.#set({ busy: true });
    const wasActive = this.#activeProfileId === profileId;
    try {
      await this.storage.deleteConnection(profileId);
    } catch (error) {
      const detail = message(error);
      if (wasActive) {
        this.#retire();
        this.#credential = undefined;
        this.#activeProfileId = undefined;
        this.#lastAuthenticatedAt = undefined;
        this.#durableSnapshotAt = undefined;
        this.#set({ status: "unpaired", busy: false, activeProfileId: undefined,
          automaticProfileId: this.#automaticProfileId, node: undefined, origin: undefined,
          saved: this.#savedViews(profileId, credentialFailure(error), detail), candidate: undefined,
          connectionAttemptError: undefined, challenge: undefined,
          owner: undefined, detail: undefined, selectedId: undefined, older: [], window: undefined,
          live: [], liveStatus: "paused", historyBusy: false, historyEnd: false, before: undefined,
          pending: [], offlineSnapshotAt: undefined, error: detail });
      } else {
        this.#set({ busy: false, automaticProfileId: this.#automaticProfileId,
          saved: this.#savedViews(profileId, credentialFailure(error), detail), error: detail });
      }
      throw error;
    }
    this.#profiles = this.#profiles.filter((candidate) => candidate.profileId !== profileId);
    if (this.#automaticProfileId === profileId) this.#automaticProfileId = undefined;
    const cleanupFailures: string[] = [];
    try { await this.#taskOutbox?.clearProfile(profileId); this.#publishTaskOutbox(); }
    catch (error) { cleanupFailures.push(`task outbox: ${message(error)}`); }
    try { await this.storage.saveSelection(profileId); }
    catch (error) { cleanupFailures.push(`task selection: ${message(error)}`); }
    try { await this.#dropPendingConnections([profile.connectionId]); }
    catch (error) { cleanupFailures.push(`operation receipts: ${message(error)}`); }
    const offlineCacheFailure = await this.#clearOfflineCache(profileId);
    if (offlineCacheFailure) cleanupFailures.push(`offline content: ${offlineCacheFailure}`);
    if (this.newTaskDrafts) {
      try { await this.newTaskDrafts.clear({ profileId }); }
      catch (error) { cleanupFailures.push(`new-task draft: ${message(error)}`); }
    }
    if (this.attachmentFiles) {
      try { await this.attachmentFiles.clearProfile(profileId); }
      catch (error) { cleanupFailures.push(`staged attachment bytes: ${message(error)}`); }
    }
    const cleanupError = cleanupFailures.length === 0
      ? undefined
      : `The connection was forgotten, but Joko could not clear ${cleanupFailures.join("; ")}.`;
    if (!wasActive) {
      this.#set({ busy: false, automaticProfileId: this.#automaticProfileId, saved: this.#savedViews(), error: cleanupError });
      return;
    }
    this.#retire();
    this.#credential = undefined;
    this.#activeProfileId = undefined;
    this.#lastAuthenticatedAt = undefined;
    this.#durableSnapshotAt = undefined;
    this.#set({ status: "unpaired", busy: false, node: undefined, origin: undefined,
      activeProfileId: undefined, automaticProfileId: this.#automaticProfileId, saved: this.#savedViews(),
      candidate: undefined, connectionAttemptError: undefined, challenge: undefined,
      owner: undefined, detail: undefined, selectedId: undefined,
      older: [], window: undefined, live: [], liveStatus: "paused", historyBusy: false,
      historyEnd: false, before: undefined, pending: [], offlineSnapshotAt: undefined, error: cleanupError });
  }

  #beginCatalogAttempt(): { readonly generation: number; readonly controller: AbortController } {
    if (this.#mutationOwner || this.#connectionAttemptAbort || this.#state.busy) {
      throw new Error("Finish the current operation before refreshing Joko connections.");
    }
    this.#catalogAbort?.abort();
    const controller = new AbortController();
    this.#catalogAbort = controller;
    return { generation: ++this.#catalogEpoch, controller };
  }

  #catalogCurrent(generation: number, controller: AbortController): boolean {
    return !this.#disposed && this.#foreground && this.#catalogEpoch === generation
      && this.#catalogAbort === controller && !controller.signal.aborted;
  }

  #cancelCatalogAttempt(): void {
    this.#catalogAbort?.abort();
    this.#catalogAbort = undefined;
    this.#catalogEpoch += 1;
    const discoveryRefreshing = this.#state.discoveryState === "refreshing";
    const savedChecking = this.#state.saved.some((profile) => profile.credentialState === "checking");
    if (!discoveryRefreshing && !savedChecking) return;
    this.#set({
      ...(discoveryRefreshing ? { discoveryState: "idle" as const } : {}),
      ...(savedChecking ? {
        saved: this.#state.saved.map((profile) => profile.credentialState === "checking"
          ? { ...profile, credentialState: "unknown" as const, error: undefined }
          : profile)
      } : {})
    });
  }

  setForeground(active: boolean): void {
    if (this.#foreground === active) return;
    if (!active && this.#queueEditLease) this.#releaseQueueEditLeaseDetached(this.#queueEditLease);
    if (!active && this.#queueInteractionLease) {
      this.#releaseQueueInteractionLeaseDetached(this.#queueInteractionLease);
    }
    this.#foreground = active;
    this.#partnerRosterEpoch++;
    this.#retire();
    if (!active) {
      this.#connectionAttemptAbort?.abort();
      this.#connectionAttemptAbort = undefined;
      this.#connectionAttemptEpoch += 1;
      if (this.#discoveryExpiryTimer !== undefined) clearTimeout(this.#discoveryExpiryTimer);
      this.#discoveryExpiryTimer = undefined;
      this.#cancelCatalogAttempt();
      this.#mutationOwner = undefined;
      let backgroundAutomations: MobileAutomationsState | undefined;
      if (this.#state.automations.open) {
        try {
          const schedules = projectMobileAutomationCatalog(this.#state.owner?.schedules ?? []);
          const selectedScheduleId = schedules.some((schedule) => schedule.scheduleId === this.#state.automations.selectedScheduleId)
            ? this.#state.automations.selectedScheduleId : schedules[0]?.scheduleId;
          backgroundAutomations = {
            ...this.#state.automations,
            status: "offline",
            schedules,
            ...(selectedScheduleId === undefined ? { selectedScheduleId: undefined } : { selectedScheduleId }),
            detail: undefined,
            history: [],
            historyStatus: "idle",
            historyNextPageToken: undefined,
            historyTotalSize: 0,
            runtime: undefined,
            error: "Return Joko to the foreground to inspect or control Automations."
          };
        } catch (error) {
          backgroundAutomations = {
            ...emptyMobileAutomationsState(true, "offline"),
            filter: this.#state.automations.filter,
            error: message(error)
          };
        }
      }
      this.#set({
        ...(!this.#hasActiveConnection() && this.#state.status === "connecting"
          ? { status: this.#hasOfflineProjection() ? "offline" as const : "unpaired" as const }
          : {}),
        busy: false,
        candidate: undefined,
        challenge: undefined,
        connectionAttemptError: undefined,
        liveStatus: "paused",
        live: [],
        historyBusy: false,
        older: [],
        window: undefined,
        before: undefined,
        historyEnd: false,
        ...(this.#state.files.open
          ? { files: { ...this.#state.files, status: "offline" as const } }
          : {}),
        ...(backgroundAutomations === undefined ? {} : { automations: backgroundAutomations })
      });
    }
    if (active) {
      const nearby = this.#unexpiredNearby(this.#state.nearby);
      if (nearby.length !== this.#state.nearby.length) this.#set({ nearby });
      this.#scheduleNearbyExpiry();
    }
    if (active) {
      if (this.#credential) void this.refresh();
      else if (this.#hasOfflineProjection()) void this.connectSaved(this.#activeProfileId!).catch(() => undefined);
      else void this.start();
    }
  }

  /** Retires a possibly half-open native fetch after a material active network
   * path change. Busy writes keep their receipt-owned recovery path and defer
   * the observation refresh instead of starting a competing request. */
  notifyNetworkChanged(): void {
    if (!this.#foreground || this.#disposed) return;
    if (this.#state.busy || this.#mutationOwner) {
      if (this.#timer !== undefined) clearTimeout(this.#timer);
      this.#timer = setTimeout(() => this.notifyNetworkChanged(), 1_000);
      return;
    }
    void this.refresh();
  }

  taskSharingApi(): TaskSharingApi | undefined {
    const credential = this.#credential;
    if (!credential || !this.#foreground || this.#state.owner?.server?.serverId !== credential.serverId) return undefined;
    return mobileTaskSharingApi(credential, () => !this.#disposed && this.#foreground && this.#credential === credential
      && this.#state.activeProfileId === credential.profileId && this.#state.owner?.server?.serverId === credential.serverId);
  }

  taskSharingOwnerKey(): string | undefined {
    const credential = this.#credential;
    return this.taskSharingApi() && credential ? JSON.stringify([credential.profileId, credential.serverId,
      credential.origin, credential.connectionId, credential.deviceId]) : undefined;
  }
  newTaskSharingActionId(): string { return this.newId(); }

  async setSharedTaskRuntime(change: { readonly backendId?: string; readonly effort?: string; readonly fastMode?: boolean | "ultrafast" }): Promise<boolean> {
    const joined = this.#joinedTask;
    if (!joined || !this.#taskAuthorityKey()) throw new Error("The shared task controls are unavailable.");
    const signal = this.#abort!.signal, source = this.#taskAuthorityKey();
    const response = await joined.api.invoke(joined.source.joined.joinId, TaskShareMethod.GET_RUNTIME_CONTROL,
      { sessionId: joined.source.joined.share!.sessionId }, signal);
    if (!response.control || this.#joinedTask !== joined || source !== this.#taskAuthorityKey()) throw new Error("The shared task runtime owner changed.");
    const action = this.#claimMutation();
    try {
      const result = await this.#submitTerminal(create(OperationMutationSchema, { payload: { case: "setSessionRuntime", value: create(SetSessionRuntimeMutationSchema, {
        sessionId: joined.source.joined.share!.sessionId, expectedRuntimeGeneration: response.control.generation,
        ...(change.backendId === undefined ? {} : { backendId: change.backendId }), ...(change.effort === undefined ? {} : { effort: change.effort }),
        ...(change.fastMode === undefined ? {} : encodeModelSpeed(change.fastMode))
      }) } }), { kind: "session-model", sessionId: joined.source.joined.share!.sessionId });
      return result.accepted && result.definitive;
    } finally { this.#releaseMutation(action); }
  }

  async controlSharedTask(command: "stop" | "resume"): Promise<boolean> {
    if (!this.#joinedTask || !this.#taskAuthorityKey()) throw new Error("The shared task is unavailable.");
    const sessionId = this.#joinedTask.source.joined.share!.sessionId;
    const run = this.#state.detail?.runs.find(item => item.sessionId === sessionId
      && [RunState.ACCEPTED, RunState.DISPATCHING, RunState.RUNNING, RunState.WAITING, RunState.RETRYING].includes(item.state));
    if (command === "stop" && !run) return true;
    const action = this.#claimMutation();
    try {
      const result = await this.#submitTerminal(create(OperationMutationSchema, { payload: command === "stop"
        ? { case: "abortRun", value: { runId: run!.runId } }
        : { case: "resumeSession", value: { sessionId } } }), { kind: "session-model", sessionId });
      return result.accepted && result.definitive;
    } finally { this.#releaseMutation(action); }
  }

  taskDraftProfileId(): string | undefined {
    const joined = this.#joinedTask;
    return joined ? mobileSharedTaskDraftProfileId(joined.source.homeProfileId, joined.source.homeServerId,
      joined.source.homeOrigin, joined.source.joined.joinId) : this.#state.activeProfileId;
  }

  /** Durable presentation identity, independent of a transport or runtime occurrence. */
  answerStateOwnerKey(): string | undefined {
    const credential = this.#credential, session = this.#selectedSession();
    return credential && session ? JSON.stringify([this.taskDraftProfileId(), credential.serverId, credential.origin, session.sessionId]) : undefined;
  }

  async openJoinedTask(joined: JoinedTaskShare): Promise<void> {
    const credential = this.#ready(), api = this.taskSharingApi();
    if (!api || !joined.share || !joined.member || !["active", "disconnected"].includes(joined.status)) throw new Error("Reconnect to the Home node before opening this shared task.");
    this.leaveTask();
    this.#joinedTask?.lifetime.abort();
    const lifetime = new AbortController();
    const source: MobileJoinedTaskSource = { kind: "joined", homeProfileId: credential.profileId,
      homeServerId: credential.serverId, homeOrigin: credential.origin, joined };
    this.#joinedTask = { source, credential, api, lifetime,
      network: mobileJoinedTaskNetwork(api, source, lifetime.signal, this.newId) };
    this.#retire();
    this.#set({ taskSource: source, selectedId: joined.share.sessionId, detail: undefined,
      older: [], live: [], window: undefined, before: undefined, historyEnd: false, historyBusy: false,
      pending: this.#allPending.filter(item => item.connectionId === credential.connectionId && item.taskJoinId === joined.joinId) });
    await this.refresh();
  }

  async #refreshJoinedTask(): Promise<void> {
    const joined = this.#joinedTask;
    if (!joined || !this.#foreground) return;
    const epoch = this.#retire(), signal = this.#abort!.signal;
    this.#set({ status: "connecting", liveStatus: "polling", error: undefined });
    const current = () => this.#current(epoch) && this.#joinedTask === joined && this.#credential === joined.credential;
    const read = async (initial: boolean) => {
      try {
        const cursor = this.#state.detail?.resumeCursor;
        const batch = !initial && cursor ? await joined.api.events({ joinId: joined.source.joined.joinId, after: cursor, limit: 128 }, signal) : undefined;
        if (!current()) return;
        const detail = await joined.network.readSession(joined.credential, joined.source.joined.share!.sessionId, signal);
        if (!current()) return;
        assertMobileSharedTaskSnapshot(joined.source, detail);
        const reset = batch?.resyncRequired || (this.#state.detail && this.#state.detail.generation !== detail.generation);
        this.#set({ detail, status: "connected", liveStatus: "polling", error: undefined,
          ...(reset ? { older: [], window: undefined, before: undefined, historyEnd: false } : {}),
          live: (batch?.events ?? []).filter(event => event.identity?.sessionId === detail.sessions[0]!.sessionId
            && event.cursor && event.cursor.sequence > (detail.resumeCursor?.sequence ?? 0n)) });
        if (initial) await this.reconcile(epoch);
      } catch (error) {
        if (!current() || signal.aborted) return;
        const revoked = isRevoked(error) || (error as { code?: number })?.code === Code.NotFound;
        this.#set({ status: "offline", liveStatus: "paused", error: revoked
          ? "Access to this shared task ended. Return to Shared tasks to reconnect or leave."
          : message(error), ...(revoked ? { detail: undefined, live: [], older: [], window: undefined } : {}) });
        if (revoked) { joined.lifetime.abort(); return; }
      }
      if (current() && !joined.lifetime.signal.aborted) this.#timer = setTimeout(() => { void read(false); }, 1_000);
    };
    await read(true);
  }

  async refresh(): Promise<void> {
    if (this.#joinedTask && this.#joinedTask.credential !== this.#credential) {
      this.#joinedTask?.lifetime.abort(); this.#joinedTask = undefined; this.#set({ taskSource: { kind: "own" } });
    }
    if (this.#joinedTask) { await this.#refreshJoinedTask(); return; }
    const credential = this.#credential;
    if (!this.#foreground) return;
    if (!credential) {
      if (this.#hasOfflineProjection()) await this.connectSaved(this.#activeProfileId!);
      return;
    }
    const epoch = this.#retire();
    this.#set({ status: "connecting", error: undefined });
    try {
      // This request MUST be anonymous and precede every credentialed reconnect.
      rememberEndpointTrust(credential);
      const node = await this.network.inspect(credential.origin, this.#abort?.signal);
      if (!this.#current(epoch)) return;
      if (node.serverId !== credential.serverId) {
        await this.#identityConflict(epoch, credential.profileId,
          "The saved Joko node identity changed. Its credential was not read again; forget it or pair this node explicitly.");
        return;
      }
      const owner = await this.network.readOwner(credential, this.deviceNameSource(), this.#abort?.signal);
      if (!this.#current(epoch)) return;
      this.#assertOwner(credential, owner, node);
      const selectedId = this.#state.selectedId;
      const selected = selectedId !== undefined && owner.snapshot.sessions.some((session) => session.sessionId === selectedId)
        ? selectedId : undefined;
      const detail = selected ? await this.network.readSession(credential, selected, this.#abort?.signal) : undefined;
      if (!this.#current(epoch)) return;
      if (selected !== selectedId) await this.storage.saveSelection(credential.profileId, selected);
      if (!this.#current(epoch)) return;
      const sameWindow = selected === selectedId && this.#taskGeneration() === owner.snapshot.generation;
      this.#lastAuthenticatedAt = this.now();
      this.#set({ node, origin: credential.origin, owner: owner.snapshot, detail, selectedId: selected,
        older: sameWindow ? this.#state.older : [], window: sameWindow ? this.#state.window : undefined,
        before: sameWindow ? this.#state.before : undefined, historyEnd: sameWindow ? this.#state.historyEnd : false,
        historyBusy: false, live: [], status: "connected", error: undefined,
        offlineSnapshotAt: undefined,
        saved: this.#savedViews(credential.profileId, "available") });
      this.#beginStream(epoch, credential, owner.snapshot);
      if (this.#state.partnerPrivate.open) void this.#resumePartnerPrivate();
      await this.#persistOfflineProjection(epoch, credential, node, owner.snapshot, detail);
      await this.reconcile(epoch);
      if (this.#current(epoch) && this.#state.automations.open) await this.refreshAutomations();
      if (this.#current(epoch)) this.#schedule();
    } catch (error) {
      if (!this.#current(epoch)) return;
      if (isRevoked(error)) await this.#invalidateCredential(
        epoch,
        credential.profileId,
        "This mobile connection was revoked. Forget it or pair this device again."
      );
      else if (error instanceof CredentialIdentityError || isEndpointTrustError(error)) {
        await this.#identityConflict(epoch, credential.profileId, message(error));
      }
      else {
        this.#set({ status: "offline", liveStatus: "paused", live: [],
          offlineSnapshotAt: this.#durableSnapshotAt, error: message(error) });
        this.#schedule();
      }
    }
  }

  #assertOwner(credential: PairedCredential, owner: Awaited<ReturnType<MobileNetwork["readOwner"]>>, node: NodeIdentity): void {
    if (owner.snapshot.server?.serverId !== node.serverId || owner.snapshot.server.apiVersion !== node.apiVersion) {
      throw new CredentialIdentityError("The authenticated snapshot did not match the inspected Joko node identity and API. The saved credential was kept but suspended.");
    }
    if (owner.connection.connectionId !== credential.connectionId
      || owner.connection.connectionProfileId !== credential.profileId
      || owner.connection.deviceId !== credential.deviceId
      || owner.device.deviceId !== credential.deviceId || owner.device.kind !== DeviceKind.MOBILE) {
      throw new CredentialIdentityError("The protected credential did not resolve to its exact saved Joko connection and device. It was kept but suspended.");
    }
    if (owner.connection.state !== ConnectionState.CONNECTED || owner.device.revoked) {
      throw new RevokedError();
    }
    const projectedConnections = owner.snapshot.connections.filter((item) => item.connectionId === credential.connectionId);
    const projectedDevices = owner.snapshot.devices.filter((item) => item.deviceId === credential.deviceId);
    const projectedConnection = projectedConnections.length === 1 ? projectedConnections[0] : undefined;
    const projectedDevice = projectedDevices.length === 1 ? projectedDevices[0] : undefined;
    if (projectedConnection?.connectionProfileId !== credential.profileId
      || projectedConnection.deviceId !== credential.deviceId || projectedDevice?.kind !== DeviceKind.MOBILE
      || !equals(DeviceSchema, projectedDevice, owner.device)) {
      throw new CredentialIdentityError("The authenticated Joko snapshot did not prove the exact saved connection and device. The credential was kept but suspended.");
    }
    if (projectedConnection.state !== ConnectionState.CONNECTED || projectedDevice.revoked) throw new RevokedError();
  }

  async #identityConflict(epoch: number, profileId: string, error: string): Promise<void> {
    if (!this.#current(epoch)) return;
    this.#connectionAttemptAbort?.abort();
    this.#connectionAttemptAbort = undefined;
    this.#connectionAttemptEpoch += 1;
    const retirementEpoch = this.#retire();
    this.#credential = undefined;
    this.#activeProfileId = undefined;
    this.#lastAuthenticatedAt = undefined;
    this.#durableSnapshotAt = undefined;
    this.#set({ status: "unpaired", busy: true, activeProfileId: undefined, node: undefined,
      saved: this.#savedViews(profileId, "identity-conflict", error), candidate: undefined,
      connectionAttemptError: undefined, challenge: undefined, owner: undefined, detail: undefined,
      selectedId: undefined, older: [], window: undefined, live: [], liveStatus: "paused",
      historyBusy: false, historyEnd: false, before: undefined, pending: [], offlineSnapshotAt: undefined,
      error });
    const cleanup = await this.#clearOfflineCache(profileId);
    if (!this.#current(retirementEpoch)) return;
    const detail = [error, cleanup].filter(Boolean).join(" ");
    this.#set({ busy: false, saved: this.#savedViews(profileId, "identity-conflict", detail), error: detail });
  }

  async #invalidateCredential(epoch: number, profileId: string, error: string): Promise<void> {
    if (!this.#current(epoch)) return;
    this.#connectionAttemptAbort?.abort();
    this.#connectionAttemptAbort = undefined;
    this.#connectionAttemptEpoch += 1;
    const retirementEpoch = this.#retire();
    this.#credential = undefined;
    this.#activeProfileId = undefined;
    this.#lastAuthenticatedAt = undefined;
    this.#durableSnapshotAt = undefined;
    this.#set({ status: "revoked", busy: true, activeProfileId: undefined,
      automaticProfileId: this.#automaticProfileId, node: undefined,
      saved: this.#savedViews(profileId, "unavailable", error), candidate: undefined,
      connectionAttemptError: undefined, challenge: undefined, owner: undefined, detail: undefined,
      selectedId: undefined, older: [], window: undefined, live: [], liveStatus: "paused",
      historyBusy: false, historyEnd: false, before: undefined, pending: [], offlineSnapshotAt: undefined,
      error });
    const offlineCacheFailure = await this.#clearOfflineCache(profileId);
    if (!this.#current(retirementEpoch)) return;
    let automaticFailure: string | undefined;
    const wasAutomatic = this.#automaticProfileId === profileId;
    if (wasAutomatic) {
      try {
        await this.storage.saveAutomaticProfile();
        this.#automaticProfileId = undefined;
      }
      catch (failure) { automaticFailure = message(failure); }
    }
    if (!this.#current(retirementEpoch)) return;
    let credentialFailureMessage: string | undefined;
    try {
      await this.storage.deleteCredential(profileId);
      if (wasAutomatic) this.#automaticProfileId = undefined;
    }
    catch (failure) { credentialFailureMessage = message(failure); }
    if (!this.#current(retirementEpoch)) return;
    const cleanupFailure = [credentialFailureMessage, automaticFailure, offlineCacheFailure].filter(Boolean).join(" ") || undefined;
    const cleanupError = cleanupFailure === undefined ? undefined : ` ${cleanupFailure}`;
    this.#set({ status: "revoked", busy: false, activeProfileId: undefined,
      automaticProfileId: this.#automaticProfileId, node: undefined,
      saved: this.#savedViews(profileId, cleanupError ? "unavailable" : "missing", `${error}${cleanupError ?? ""}`),
      candidate: undefined, connectionAttemptError: undefined, challenge: undefined, owner: undefined, detail: undefined,
      selectedId: undefined, older: [], window: undefined, live: [], liveStatus: "paused",
      historyBusy: false, historyEnd: false, before: undefined, pending: [], offlineSnapshotAt: undefined,
      error: `${error}${cleanupError ?? ""}` });
  }

  #schedule(): void {
    if (!this.#foreground || this.#disposed || !this.#credential) return;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => { void (async () => {
      if (await this.#maintainConnectionEntries()) { this.#schedule(); return; }
      if (this.#state.busy) this.#schedule();
      else if (this.#state.status === "connected" && this.#credential) {
        if (this.#projectionReading) this.#schedule();
        else void this.#syncProjection(this.#epoch, this.#credential, true);
      } else void this.refresh();
    })(); }, this.#state.liveStatus === "polling" || this.#state.status === "offline" ? 4_000 : 30_000);
  }

  #beginStream(epoch: number, credential: PairedCredential, snapshot: Snapshot): void {
    const cursor = snapshot.resumeCursor;
    if (!this.#current(epoch) || !cursor?.opaqueToken || cursor.generation !== snapshot.generation) {
      this.#set({ liveStatus: "polling" });
      return;
    }
    const controller = new AbortController();
    this.#streamAbort = controller;
    this.#streamGeneration = cursor.generation;
    this.#streamSequence = cursor.sequence;
    this.#set({ liveStatus: "verifying" });
    // An idle stream cannot demonstrate incremental delivery on every native fetch.
    // Until an event arrives, keep a bounded snapshot-polling fallback instead.
    this.#proofTimer = setTimeout(() => {
      if (!this.#current(epoch) || this.#streamAbort !== controller || this.#state.liveStatus !== "verifying") return;
      controller.abort();
      this.#streamAbort = undefined;
      this.#set({ liveStatus: "polling" });
      this.#schedule();
    }, 8_000);
    void this.#consumeStream(epoch, credential, cursor, controller);
  }

  async #consumeStream(epoch: number, credential: PairedCredential, after: EventCursor, controller: AbortController): Promise<void> {
    try {
      for await (const event of this.network.streamOwner(credential, after, controller.signal)) {
        if (!this.#current(epoch) || this.#streamAbort !== controller || controller.signal.aborted) return;
        const cursor = event.cursor;
        const saving = this.#partnerProfileSave;
        if (saving && saving.action === this.#mutationOwner && saving.epoch === epoch
          && saving.credential === credential && event.eventId && cursor?.opaqueToken
          && cursor.generation === this.#streamGeneration && cursor.sequence <= (this.#streamSequence ?? 0n) + 1n
          && event.payload?.kind.case === "projectionInvalidated") {
          // This write re-reads its original owner and canonical Session before committing UI state.
          // Retiring the observer here would cancel the very update that invalidated the projection.
          saving.refreshPending = true; controller.abort(); this.#streamAbort = undefined;
          if (this.#proofTimer !== undefined) clearTimeout(this.#proofTimer); this.#proofTimer = undefined;
          return;
        }
        if (!event.eventId || !cursor || !cursor.opaqueToken || cursor.generation !== this.#streamGeneration
          || cursor.sequence > (this.#streamSequence ?? 0n) + 1n
          || event.payload?.kind.case === "projectionInvalidated"
          || event.payload?.kind.case === "taskTagCatalogChanged") {
          this.#clearHistory();
          void this.refresh();
          return;
        }
        if (cursor.sequence <= (this.#streamSequence ?? 0n)) continue;
        this.#streamSequence = cursor.sequence;
        if (event.identity?.sessionId === this.#state.selectedId && historyInvalidated(event)) this.#clearHistory();
        if (this.#proofTimer !== undefined) clearTimeout(this.#proofTimer);
        this.#proofTimer = undefined;
        this.#set({ liveStatus: "streaming" });
        if (event.identity?.sessionId && event.identity.sessionId === this.#state.selectedId && !this.#state.window) {
          this.#set({ live: [...this.#state.live.filter((item) => item.eventId !== event.eventId), event].slice(-160) });
        }
        this.#scheduleProjection(epoch, credential);
      }
      if (this.#current(epoch) && this.#streamAbort === controller) this.#fallbackStream();
    } catch (error) {
      if (!this.#current(epoch) || this.#streamAbort !== controller || controller.signal.aborted) return;
      if (isRevoked(error)) await this.#invalidateCredential(
        epoch,
        credential.profileId,
        "This mobile connection was revoked. Forget it or pair this device again."
      );
      else if (isEndpointTrustError(error)) await this.#identityConflict(epoch, credential.profileId, message(error));
      else if ((error as { code?: number })?.code === Code.FailedPrecondition) void this.refresh();
      else this.#fallbackStream();
    }
  }

  #fallbackStream(): void {
    this.#streamAbort?.abort();
    this.#streamAbort = undefined;
    if (this.#proofTimer !== undefined) clearTimeout(this.#proofTimer);
    this.#proofTimer = undefined;
    this.#set({ liveStatus: "polling" });
    this.#schedule();
  }

  #scheduleProjection(epoch: number, credential: PairedCredential): void {
    if (this.#projectionTimer !== undefined) clearTimeout(this.#projectionTimer);
    this.#projectionTimer = setTimeout(() => {
      this.#projectionTimer = undefined;
      if (this.#current(epoch) && !this.#projectionReading) void this.#syncProjection(epoch, credential);
    }, 180);
  }

  async #syncProjection(epoch: number, credential: PairedCredential, snapshotPoll = false): Promise<void> {
    this.#projectionReading = true;
    const selectedId = this.#state.selectedId;
    const generation = snapshotPoll ? this.#taskGeneration() : this.#streamGeneration;
    const edge = snapshotPoll ? this.#state.owner?.resumeCursor?.sequence ?? 0n : this.#streamSequence ?? 0n;
    try {
      let node = this.#state.node!;
      if (snapshotPoll) {
        node = await this.network.inspect(credential.origin, this.#abort?.signal);
        if (!this.#current(epoch) || credential !== this.#credential || selectedId !== this.#state.selectedId) return;
        if (node.serverId !== credential.serverId || node.apiVersion !== this.#state.node?.apiVersion) {
          throw new CredentialIdentityError("The saved Joko node identity or API changed. Its credential was not read again; forget it or pair this node explicitly.");
        }
      }
      const [owner, detail] = await Promise.all([
        this.network.readOwner(credential, this.deviceNameSource(), this.#abort?.signal),
        selectedId ? this.network.readSession(credential, selectedId, this.#abort?.signal) : Promise.resolve(undefined)
      ]);
      if (!this.#current(epoch) || credential !== this.#credential || selectedId !== this.#state.selectedId) return;
      this.#assertOwner(credential, owner, node);
      if (owner.snapshot.generation !== generation || detail && detail.generation !== generation
        || selectedId && !owner.snapshot.sessions.some((item) => item.sessionId === selectedId)) {
        void this.refresh();
        return;
      }
      const ownerCursor = owner.snapshot.resumeCursor;
      const detailCursor = detail?.resumeCursor;
      const currentCursor = (cursor: EventCursor | undefined) => cursor === undefined ? snapshotPoll
        : cursor.generation === generation && cursor.sequence >= edge;
      if (!currentCursor(ownerCursor) || detail && !currentCursor(detailCursor)) {
        if (++this.#projectionMisses >= 2) void this.refresh();
        else this.#scheduleProjection(epoch, credential);
        return;
      }
      this.#projectionMisses = 0;
      const durable = detailCursor?.sequence ?? ownerCursor?.sequence;
      const automationChanged = automationCatalogAuthorityKey(this.#state.owner?.schedules ?? [])
        !== automationCatalogAuthorityKey(owner.snapshot.schedules);
      this.#lastAuthenticatedAt = this.now();
      this.#set({ node, owner: owner.snapshot, detail,
        offlineSnapshotAt: undefined,
        live: durable === undefined ? [] : this.#state.live.filter((item) => item.cursor && item.cursor.sequence > durable) });
      await this.#persistOfflineProjection(epoch, credential, node, owner.snapshot, detail);
      if (snapshotPoll) await this.reconcile(epoch);
      if (automationChanged && this.#state.automations.open) void this.refreshAutomations();
      if (durable !== undefined && (this.#streamSequence ?? 0n) > durable) this.#scheduleProjection(epoch, credential);
    } catch (error) {
      if (!this.#current(epoch)) return;
      if (isRevoked(error)) await this.#invalidateCredential(
        epoch,
        credential.profileId,
        "This mobile connection was revoked. Forget it or pair this device again."
      );
      else if (error instanceof CredentialIdentityError || isEndpointTrustError(error)) await this.#identityConflict(epoch, credential.profileId, message(error));
      else void this.refresh();
    } finally {
      if (this.#current(epoch)) {
        this.#projectionReading = false;
        if (snapshotPoll) {
          if (!this.#streamAbort && this.#state.status === "connected" && this.#state.owner) {
            this.#beginStream(epoch, credential, this.#state.owner);
          }
          this.#schedule();
        }
      }
    }
  }

  async #persistPending(items: readonly PendingOperation[], epoch: number): Promise<boolean> {
    const connectionId = this.#credential?.connectionId;
    if (connectionId === undefined) return false;
    const write = this.#pendingWrite.then(async () => {
      if (!this.#current(epoch) || this.#credential?.connectionId !== connectionId) return false;
      const merged = [
        ...this.#allPending.filter((item) => item.connectionId !== connectionId
          || item.taskJoinId !== this.#joinedTask?.source.joined.joinId),
        ...items
      ];
      await this.storage.savePending(merged);
      this.#allPending = merged;
      const current = this.#current(epoch) && this.#credential?.connectionId === connectionId;
      if (current) this.#set({ saved: this.#savedViews() });
      return current;
    });
    this.#pendingWrite = write.then(() => undefined, () => undefined);
    return write;
  }

  async #dropPendingConnections(connectionIds: readonly string[]): Promise<void> {
    const removed = new Set(connectionIds);
    const write = this.#pendingWrite.then(async () => {
      const next = this.#allPending.filter((item) => !removed.has(item.connectionId));
      if (next.length === this.#allPending.length) return;
      await this.storage.savePending(next);
      this.#allPending = next;
      this.#set({ saved: this.#savedViews() });
    });
    this.#pendingWrite = write.then(() => undefined, () => undefined);
    await write;
  }

  async select(sessionId?: string): Promise<void> {
    if (this.#partnerRosterNavigation?.sessionId !== sessionId) this.#partnerRosterNavigation = undefined;
    if (sessionId !== undefined && !this.#state.owner?.sessions.some((session) => session.sessionId === sessionId)) {
      throw new Error("Select a task from the current Joko node.");
    }
    if (this.#queueInteractionLease) this.#releaseQueueInteractionLeaseDetached(this.#queueInteractionLease);
    await this.#releaseQueueEditBeforeTransition();
    this.#joinedTask?.lifetime.abort(); this.#joinedTask = undefined;
    this.#set({ taskSource: { kind: "own" }, pending: this.#allPending.filter(item =>
      item.connectionId === this.#credential?.connectionId && item.taskJoinId === undefined) });
    const profileId = this.#activeProfileId;
    if (!profileId) throw new Error("Reconnect to a saved Joko node before selecting a task.");
    const offline = this.#state.status === "offline" && this.#hasOfflineProjection(profileId);
    const profile = offline ? this.#profiles.find((candidate) => candidate.profileId === profileId) : undefined;
    const epoch = this.#retire();
    await this.storage.saveSelection(profileId, sessionId);
    if (!this.#current(epoch)) return;
    this.#set({ selectedId: sessionId, detail: undefined, older: [], window: undefined, live: [],
      historyBusy: false, historyEnd: false, before: undefined, error: undefined });
    if (offline) {
      if (!profile || !this.offlineCache) {
        this.#set({ error: "This task is not available offline. Reconnect to load it." });
        return;
      }
      try {
        const cached = await this.offlineCache.load(profile, sessionId);
        if (!this.#current(epoch) || this.#activeProfileId !== profileId || this.#state.status !== "offline") return;
        if (!cached) {
          this.#set({ error: "The saved offline content is no longer available. Reconnect to load this task." });
          return;
        }
        this.#showOfflineProjection(
          profile,
          cached,
          sessionId,
          "offline",
          sessionId !== undefined && cached.detail === undefined
            ? "This task has no saved offline messages. Reconnect to load it."
            : undefined
        );
        if (this.#credential) this.#schedule();
      } catch (error) {
        if (this.#current(epoch) && this.#activeProfileId === profileId) {
          this.#set({ detail: undefined, error: message(error) });
        }
      }
      return;
    }
    await this.refresh();
  }

  async searchHome(query: string, statusFilter: MobileHomeStatusFilter): Promise<void> {
    const normalized = query.trim();
    this.#homeSearchAbort?.abort();
    this.#homeSearchAbort = undefined;
    const generation = ++this.#homeSearchEpoch;
    if (!normalized) {
      this.#set({ homeSearchQuery: "", homeSearchFilter: statusFilter, homeSearchStatus: "idle",
        homeSearchSessionIds: [], homeSearchError: undefined });
      return;
    }
    const credential = this.#credential;
    const owner = this.#state.owner;
    const profileId = this.#activeProfileId;
    if (!credential || !owner || !profileId || this.#state.status !== "connected" || !this.#foreground) {
      this.#set({ homeSearchQuery: normalized, homeSearchFilter: statusFilter, homeSearchStatus: "error",
        homeSearchSessionIds: [], homeSearchError: "Reconnect to search task messages." });
      return;
    }
    const controller = new AbortController();
    this.#homeSearchAbort = controller;
    this.#set({ homeSearchQuery: normalized, homeSearchFilter: statusFilter, homeSearchStatus: "searching",
      homeSearchSessionIds: [], homeSearchError: undefined });
    try {
      const matches = await this.network.searchSessionMessages(
        credential,
        normalized,
        statusFilter === "active" ? SessionMessageSearchSessionStatus.ACTIVE
          : statusFilter === "archived" ? SessionMessageSearchSessionStatus.ARCHIVED
            : SessionMessageSearchSessionStatus.UNSPECIFIED,
        controller.signal
      );
      if (controller.signal.aborted || generation !== this.#homeSearchEpoch || owner !== this.#state.owner
        || profileId !== this.#activeProfileId || this.#state.homeSearchQuery !== normalized
        || this.#state.homeSearchFilter !== statusFilter) return;
      const visible = new Set(this.#state.owner?.sessions.map((session) => session.sessionId) ?? []);
      const sessionIds = [...new Set(matches.map((match) => match.sessionId).filter((sessionId) => visible.has(sessionId)))];
      this.#set({ homeSearchStatus: "ready", homeSearchSessionIds: sessionIds, homeSearchError: undefined });
    } catch (error) {
      if (controller.signal.aborted || generation !== this.#homeSearchEpoch || owner !== this.#state.owner
        || profileId !== this.#activeProfileId) return;
      this.#set({ homeSearchStatus: "error", homeSearchSessionIds: [], homeSearchError: message(error) });
    } finally {
      if (this.#homeSearchAbort === controller) this.#homeSearchAbort = undefined;
    }
  }

  async openAutomations(): Promise<void> {
    this.#cancelAutomationRequests();
    if (this.#state.status !== "connected" || !this.#foreground) {
      let schedules: readonly MobileAutomationSchedule[] = [];
      let error = "Reconnect to inspect or control Automations.";
      try { schedules = projectMobileAutomationCatalog(this.#state.owner?.schedules ?? []); }
      catch (cause) { error = message(cause); }
      this.#set({
        automations: {
          ...emptyMobileAutomationsState(true, "offline"),
          schedules,
          ...(schedules[0] === undefined ? {} : { selectedScheduleId: schedules[0].scheduleId }),
          error
        }
      });
      return;
    }
    this.#set({ automations: { ...this.#state.automations, open: true, status: "loading", error: undefined } });
    await this.refreshAutomations();
  }

  closeAutomations(): void {
    this.#cancelAutomationRequests();
    this.#set({ automations: emptyMobileAutomationsState() });
  }

  setAutomationFilter(filter: MobileAutomationFilter): void {
    if (!this.#state.automations.open) return;
    this.#set({ automations: { ...this.#state.automations, filter } });
  }

  async selectAutomation(scheduleId: string): Promise<void> {
    if (!this.#state.automations.open
      || this.#state.automations.schedules.filter((schedule) => schedule.scheduleId === scheduleId).length !== 1) {
      throw new Error("Select an Automation from the current catalog.");
    }
    this.#automationHistoryPageTokens.clear();
    this.#set({
      automations: {
        ...this.#state.automations,
        selectedScheduleId: scheduleId,
        detail: undefined,
        history: [],
        historyStatus: this.#state.status === "connected" ? "loading" : "idle",
        historyNextPageToken: undefined,
        historyTotalSize: 0,
        error: this.#state.status === "connected" ? undefined : "Reconnect to inspect Automation history."
      }
    });
    if (this.#state.status === "connected") await this.refreshAutomations(scheduleId);
  }

  async refreshAutomations(preferredScheduleId = this.#state.automations.selectedScheduleId): Promise<void> {
    if (!this.#state.automations.open) return;
    const credential = this.#credential;
    const authorityKey = this.#automationOwnerKey();
    if (!credential || !authorityKey) {
      let schedules: readonly MobileAutomationSchedule[] = [];
      let error = "Reconnect to refresh Automations.";
      try { schedules = projectMobileAutomationCatalog(this.#state.owner?.schedules ?? []); }
      catch (cause) { error = message(cause); }
      const selectedScheduleId = schedules.some((schedule) => schedule.scheduleId === preferredScheduleId)
        ? preferredScheduleId : schedules[0]?.scheduleId;
      this.#set({ automations: {
        ...this.#state.automations,
        status: "offline",
        schedules,
        ...(selectedScheduleId === undefined ? { selectedScheduleId: undefined } : { selectedScheduleId }),
        detail: undefined,
        history: [],
        historyStatus: "idle",
        historyNextPageToken: undefined,
        historyTotalSize: 0,
        runtime: undefined,
        error
      } });
      return;
    }
    this.#cancelAutomationRequests();
    const generation = this.#automationEpoch;
    const controller = new AbortController();
    this.#automationAbort = controller;
    this.#set({ automations: {
      ...this.#state.automations,
      status: "loading",
      historyStatus: this.#state.automations.history.length === 0 ? "loading" : this.#state.automations.historyStatus,
      error: undefined
    } });
    try {
      const [rawCatalog, rawRuntime] = await Promise.all([
        this.network.listSchedules(credential, controller.signal),
        this.network.readSchedulerRuntime(credential, controller.signal)
      ]);
      const schedules = projectMobileAutomationCatalog(rawCatalog);
      const runtime = projectMobileSchedulerRuntime(rawRuntime, new Set(schedules.map((schedule) => schedule.scheduleId)));
      if (!this.#automationRequestCurrent(generation, controller, authorityKey)) return;
      const selectedScheduleId = schedules.some((schedule) => schedule.scheduleId === preferredScheduleId)
        ? preferredScheduleId : schedules[0]?.scheduleId;
      if (selectedScheduleId === undefined) {
        this.#automationHistoryPageTokens = new Set([""]);
        this.#set({ automations: {
          ...this.#state.automations,
          status: "ready",
          schedules,
          selectedScheduleId: undefined,
          detail: undefined,
          history: [],
          historyStatus: "ready",
          historyNextPageToken: undefined,
          historyTotalSize: 0,
          runtime,
          lastSyncedAt: this.now(),
          error: undefined
        } });
        return;
      }
      const [rawDetail, rawHistory] = await Promise.all([
        this.network.readSchedule(credential, selectedScheduleId, controller.signal),
        this.network.listScheduleHistory(credential, selectedScheduleId, "", controller.signal)
      ]);
      const detail = projectMobileAutomationSchedule(rawDetail, selectedScheduleId);
      const catalogSchedule = schedules.find((schedule) => schedule.scheduleId === selectedScheduleId)!;
      this.#assertSameAutomationRevision(catalogSchedule, detail);
      const history = projectMobileAutomationHistory(selectedScheduleId, rawHistory.history);
      if (history.length > rawHistory.totalSize
        || rawHistory.nextPageToken === "" && history.length !== rawHistory.totalSize) {
        throw new Error("The Joko node returned an incomplete Automation history.");
      }
      if (!this.#automationRequestCurrent(generation, controller, authorityKey)) return;
      this.#automationHistoryPageTokens = new Set([
        "",
        ...(rawHistory.nextPageToken === "" ? [] : [rawHistory.nextPageToken])
      ]);
      this.#set({ automations: {
        ...this.#state.automations,
        status: "ready",
        schedules,
        selectedScheduleId,
        detail,
        history,
        historyStatus: "ready",
        ...(rawHistory.nextPageToken === "" ? { historyNextPageToken: undefined } : { historyNextPageToken: rawHistory.nextPageToken }),
        historyTotalSize: rawHistory.totalSize,
        runtime,
        lastSyncedAt: this.now(),
        error: undefined
      } });
    } catch (error) {
      if (!this.#automationRequestCurrent(generation, controller, authorityKey)) return;
      this.#set({ automations: {
        ...this.#state.automations,
        status: "error",
        historyStatus: "error",
        error: message(error)
      } });
    } finally {
      if (this.#automationAbort === controller) this.#automationAbort = undefined;
    }
  }

  async loadMoreAutomationHistory(): Promise<void> {
    const state = this.#state.automations;
    const scheduleId = state.selectedScheduleId;
    const pageToken = state.historyNextPageToken;
    const credential = this.#credential;
    const authorityKey = this.#automationOwnerKey();
    if (!state.open || state.status !== "ready" || state.historyStatus !== "ready"
      || !scheduleId || !pageToken || !credential || !authorityKey) return;
    this.#automationHistoryAbort?.abort();
    const controller = new AbortController();
    this.#automationHistoryAbort = controller;
    const generation = this.#automationEpoch;
    const expectedTotal = state.historyTotalSize;
    const existing = state.history;
    if (!this.#automationHistoryPageTokens.has(pageToken)) {
      throw new Error("The Automation history cursor is no longer current.");
    }
    this.#set({ automations: { ...state, historyStatus: "loading-more", error: undefined } });
    try {
      const raw = await this.network.listScheduleHistory(credential, scheduleId, pageToken, controller.signal);
      const page = projectMobileAutomationHistory(scheduleId, raw.history);
      const identities = new Set(existing.map((run) => run.triggerId));
      if (raw.totalSize !== expectedTotal || page.some((run) => identities.has(run.triggerId))
        || existing.length + page.length > expectedTotal
        || raw.nextPageToken === "" && existing.length + page.length !== expectedTotal
        || raw.nextPageToken !== "" && this.#automationHistoryPageTokens.has(raw.nextPageToken)) {
        throw new Error("The Automation history changed while paging.");
      }
      if (!this.#automationHistoryRequestCurrent(generation, controller, authorityKey, scheduleId, pageToken)) return;
      if (raw.nextPageToken !== "") this.#automationHistoryPageTokens.add(raw.nextPageToken);
      this.#set({ automations: {
        ...this.#state.automations,
        history: [...existing, ...page],
        historyStatus: "ready",
        ...(raw.nextPageToken === "" ? { historyNextPageToken: undefined } : { historyNextPageToken: raw.nextPageToken }),
        error: undefined
      } });
    } catch (error) {
      if (!this.#automationHistoryRequestCurrent(generation, controller, authorityKey, scheduleId, pageToken)) return;
      this.#set({ automations: { ...this.#state.automations, historyStatus: "error", error: message(error) } });
    } finally {
      if (this.#automationHistoryAbort === controller) this.#automationHistoryAbort = undefined;
    }
  }

  async runAutomation(scheduleId: string): Promise<boolean> {
    return this.#submitAutomationMutation(scheduleId, undefined, "schedule-run", (schedule) => create(OperationMutationSchema, {
      preconditions: [this.#automationSchedulePrecondition(schedule)],
      payload: { case: "triggerSchedule", value: create(TriggerScheduleMutationSchema, { scheduleId }) }
    }));
  }

  async setAutomationEnabled(scheduleId: string, enabled: boolean): Promise<boolean> {
    return this.#submitAutomationMutation(scheduleId, undefined, "schedule-enable", (schedule) => create(OperationMutationSchema, {
      preconditions: [this.#automationSchedulePrecondition(schedule)],
      payload: { case: "setScheduleEnabled", value: create(SetScheduleEnabledMutationSchema, { scheduleId, enabled }) }
    }));
  }

  async restartAutomationRun(scheduleId: string, triggerId: string): Promise<boolean> {
    this.#automationRun(scheduleId, triggerId, canRestartMobileAutomationRun, "This Automation run cannot be restarted.");
    return this.#submitAutomationMutation(scheduleId, triggerId, "schedule-run-restart", (schedule) => create(OperationMutationSchema, {
      preconditions: [this.#automationSchedulePrecondition(schedule)],
      payload: { case: "restartScheduleRun", value: create(RestartScheduleRunMutationSchema, { scheduleId, triggerId }) }
    }));
  }

  async markAutomationRunRead(scheduleId: string, triggerId: string): Promise<boolean> {
    this.#automationRun(scheduleId, triggerId, isMobileAutomationRunUnread, "This Automation run is not unread.");
    return this.#submitAutomationMutation(scheduleId, triggerId, "schedule-run-read", (schedule) => create(OperationMutationSchema, {
      preconditions: [this.#automationSchedulePrecondition(schedule)],
      payload: { case: "markScheduleRunRead", value: create(MarkScheduleRunReadMutationSchema, { scheduleId, triggerId }) }
    }));
  }

  async markAutomationRunsRead(scheduleId: string): Promise<boolean> {
    return this.#submitAutomationMutation(scheduleId, undefined, "schedule-runs-read", (schedule) => create(OperationMutationSchema, {
      preconditions: [this.#automationSchedulePrecondition(schedule)],
      payload: { case: "markScheduleRunsRead", value: create(MarkScheduleRunsReadMutationSchema, { scheduleId }) }
    }));
  }

  async markAllAutomationRunsRead(): Promise<boolean> {
    const state = this.#state.automations;
    if (!state.open || state.status !== "ready" || state.schedules.length === 0) return false;
    this.#assertNoPendingAutomation("schedule-all-read");
    const action = this.#claimMutation();
    try {
      const schedules = await this.#revalidateAutomationCatalog();
      const result = await this.#submitTerminal(create(OperationMutationSchema, {
        preconditions: schedules.map((schedule) => this.#automationSchedulePrecondition(schedule)),
        payload: { case: "markAllScheduleRunsRead", value: create(MarkAllScheduleRunsReadMutationSchema) }
      }), { kind: "schedule-all-read" }, undefined, true, false);
      if (result.definitive) await this.refreshAutomations();
      return result.accepted && result.definitive;
    } finally { this.#releaseMutation(action); }
  }

  async deleteAutomationRun(scheduleId: string, triggerId: string): Promise<boolean> {
    this.#automationRun(scheduleId, triggerId, isMobileAutomationRunTerminal, "Only a terminal Automation run can be deleted.");
    return this.#submitAutomationMutation(scheduleId, triggerId, "schedule-run-delete", (schedule) => create(OperationMutationSchema, {
      preconditions: [this.#automationSchedulePrecondition(schedule)],
      payload: { case: "deleteScheduleRun", value: create(DeleteScheduleRunMutationSchema, { scheduleId, triggerId }) }
    }));
  }

  async loadAutomationWorktree(targetId: string): Promise<MobileAutomationWorktreeProof> {
    const credential = this.#ready();
    const authorityKey = this.#automationOwnerKey();
    const owner = this.#state.owner;
    if (!authorityKey || !owner || !this.#state.automations.open || this.#state.automations.status !== "ready") {
      throw new Error("Reopen Automations from the current Joko node before loading Worktree options.");
    }
    const options = mobileAutomationTargetOptions(owner).filter((candidate) => candidate.targetId === targetId);
    if (options.length !== 1 || options[0]!.workspaceKind !== "project"
      || !options[0]!.projectAutomationEligible) {
      throw new Error("Choose a current local project before loading Worktree options.");
    }
    let probe: Awaited<ReturnType<MobileNetwork["probeTargetWorktree"]>>;
    try {
      probe = await this.network.probeTargetWorktree(credential, targetId, this.#abort?.signal);
    } catch (error) {
      const code = (error as { readonly code?: number }).code;
      if (code !== Code.Unimplemented && code !== Code.Unavailable) throw error;
      probe = { targetId, eligibility: "unavailable", canRefreshRemote: false };
    }
    const sources = probe.eligibility === "eligible"
      ? await this.network.listTargetWorktreeSources(credential, targetId, this.#abort?.signal)
      : [];
    if (this.#state.owner !== owner || this.#automationOwnerKey() !== authorityKey
      || !this.#state.automations.open) {
      throw new Error("The Automation owner changed while Worktree options were loading.");
    }
    return {
      targetId,
      eligibility: probe.eligibility,
      canRefreshRemote: probe.canRefreshRemote,
      sources: sources.map((source) => ({ ...source }))
    };
  }

  async saveAutomation(
    draft: MobileAutomationDraft,
    scheduleId?: string
  ): Promise<MobileAutomationSchedule | undefined> {
    const kind = scheduleId === undefined ? "schedule-create" as const : "schedule-update" as const;
    this.#assertNoPendingAutomationAuthoring(scheduleId, draft.targetId);
    const action = this.#claimMutation();
    try {
      const owner = this.#state.owner;
      const authorityKey = this.#automationOwnerKey();
      if (!owner || !authorityKey || !this.#state.automations.open || this.#state.automations.status !== "ready") {
        throw new Error("Reopen Automations from the current Joko node before saving.");
      }
      const existing = scheduleId === undefined ? undefined : await this.#revalidateAutomationSchedule(scheduleId);
      if (this.#state.owner !== owner || this.#automationOwnerKey() !== authorityKey) {
        throw new Error("The Automation owner changed before the Schedule could be saved.");
      }
      const worktree = draft.useWorktree ? await this.loadAutomationWorktree(draft.targetId) : undefined;
      if (this.#state.owner !== owner || this.#automationOwnerKey() !== authorityKey) {
        throw new Error("The Automation owner changed before the Schedule could be saved.");
      }
      const built = buildMobileAutomationScheduleInput(owner, draft, existing, worktree, this.now());
      const preconditions = [
        this.#automationTargetPrecondition(built.target),
        ...(built.boundSession === undefined ? [] : [this.#automationSessionPrecondition(built.boundSession)]),
        ...(existing === undefined ? [] : [this.#automationSchedulePrecondition(existing)])
      ];
      const result = await this.#submitTerminal(create(OperationMutationSchema, {
        preconditions,
        payload: scheduleId === undefined
          ? { case: "createSchedule", value: create(CreateScheduleMutationSchema, { schedule: built.schedule }) }
          : { case: "updateSchedule", value: create(UpdateScheduleMutationSchema, { scheduleId, schedule: built.schedule }) }
      }), {
        kind,
        targetId: built.target.targetId,
        ...(scheduleId === undefined ? {} : { scheduleId })
      }, undefined, true, false);
      let projected: MobileAutomationSchedule | undefined;
      let validationError: unknown;
      if (result.accepted && result.definitive) {
        try {
          projected = this.#automationOperationSchedule(
            result.operation,
            scheduleId,
            built.target.targetId,
            existing?.source ?? "dialogue"
          );
        } catch (error) { validationError = error; }
      }
      if (result.definitive) await this.refreshAutomations(projected?.scheduleId ?? scheduleId);
      const rejection = automationMutationRejection(result, "save");
      if (rejection !== undefined) throw rejection;
      if (validationError !== undefined) throw validationError;
      return projected;
    } finally { this.#releaseMutation(action); }
  }

  async prepareAutomationDeletion(scheduleId: string): Promise<MobileAutomationDeletionPreview> {
    return this.#prepareAutomationDeletion(scheduleId);
  }

  async deleteAutomation(
    scheduleId: string,
    disposition: MobileAutomationDisposition,
    expectedPreview: MobileAutomationDeletionPreview
  ): Promise<MobileAutomationDeletionOutcome | undefined> {
    this.#assertNoPendingAutomationAuthoring(scheduleId);
    const action = this.#claimMutation();
    try {
      const currentPreview = await this.#prepareAutomationDeletion(scheduleId);
      if (!sameAutomationDeletionPreview(expectedPreview, currentPreview)) {
        throw new Error("The Automation deletion preview changed. Review the current generated tasks before deleting.");
      }
      const schedule = await this.#revalidateAutomationSchedule(scheduleId);
      if (schedule.source !== "dialogue") {
        throw new Error("Use the project Automation removal action for a project-owned Schedule.");
      }
      const result = await this.#submitTerminal(create(OperationMutationSchema, {
        preconditions: [this.#automationSchedulePrecondition(schedule)],
        payload: { case: "deleteSchedule", value: create(DeleteScheduleMutationSchema, {
          scheduleId,
          generatedSessionDisposition: mobileAutomationDispositionProto(disposition)
        }) }
      }), { kind: "schedule-delete", scheduleId }, undefined, true, false);
      let outcome: MobileAutomationDeletionOutcome | undefined;
      let validationError: unknown;
      if (result.accepted && result.definitive) {
        try {
          const payload = result.operation?.result?.payload;
          if (payload?.case !== "scheduleDeletion") {
            throw new Error("The Joko node completed Automation deletion without its typed result.");
          }
          outcome = projectMobileAutomationDeletionResult(payload.value, scheduleId, disposition);
        } catch (error) { validationError = error; }
      }
      if (result.definitive) await this.refreshAutomations();
      const rejection = automationMutationRejection(result, "deletion");
      if (rejection !== undefined) throw rejection;
      if (validationError !== undefined) throw validationError;
      return outcome;
    } finally { this.#releaseMutation(action); }
  }

  async promoteAutomation(scheduleId: string): Promise<MobileAutomationSchedule | undefined> {
    return this.#submitProjectAutomationScheduleMutation(scheduleId, "schedule-promote", "dialogue", (schedule) => ({
      mutation: create(OperationMutationSchema, {
        preconditions: [this.#automationSchedulePrecondition(schedule), this.#automationTargetForSchedulePrecondition(schedule)],
        payload: { case: "promoteScheduleToProject", value: create(PromoteScheduleToProjectMutationSchema, { scheduleId }) }
      }),
      resultSource: "project"
    }));
  }

  async cloneProjectAutomation(scheduleId: string, displayName: string): Promise<MobileAutomationSchedule | undefined> {
    const name = boundedMobileAutomationName(displayName);
    return this.#submitProjectAutomationScheduleMutation(scheduleId, "schedule-clone", "project", (schedule) => ({
      mutation: create(OperationMutationSchema, {
        preconditions: [this.#automationSchedulePrecondition(schedule), this.#automationTargetForSchedulePrecondition(schedule)],
        payload: { case: "cloneProjectScheduleToUser", value: create(CloneProjectScheduleToUserMutationSchema, {
          scheduleId, displayName: name
        }) }
      }),
      resultSource: "dialogue"
    }));
  }

  async removeProjectAutomation(
    scheduleId: string,
    keepPersonalCopy: boolean
  ): Promise<MobileAutomationSchedule | boolean | undefined> {
    this.#assertNoPendingAutomationAuthoring(scheduleId);
    const action = this.#claimMutation();
    try {
      const schedule = await this.#revalidateAutomationSchedule(scheduleId);
      if (schedule.source !== "project") throw new Error("Only a project-owned Automation can be removed from project configuration.");
      const result = await this.#submitTerminal(create(OperationMutationSchema, {
        preconditions: [this.#automationSchedulePrecondition(schedule), this.#automationTargetForSchedulePrecondition(schedule)],
        payload: { case: "removeProjectSchedule", value: create(RemoveProjectScheduleMutationSchema, {
          scheduleId, keepPersonalCopy
        }) }
      }), { kind: "schedule-project-remove", scheduleId }, undefined, true, false);
      let outcome: MobileAutomationSchedule | boolean | undefined;
      let validationError: unknown;
      if (result.accepted && result.definitive) {
        try {
          outcome = keepPersonalCopy
            ? this.#automationOperationSchedule(result.operation, undefined, schedule.targetId, "dialogue")
            : this.#automationOperationAcknowledgement(result.operation);
        } catch (error) { validationError = error; }
      }
      if (result.definitive) await this.refreshAutomations(outcome && typeof outcome !== "boolean" ? outcome.scheduleId : undefined);
      if (!result.definitive) {
        throw new Error("The durable project Automation removal result is unknown. It was not resent.");
      }
      const rejection = automationMutationRejection(result, "project removal");
      if (rejection !== undefined) throw rejection;
      if (validationError !== undefined) throw validationError;
      return outcome;
    } finally { this.#releaseMutation(action); }
  }

  async reconcileProjectAutomations(targetId: string): Promise<boolean> {
    this.#assertNoPendingAutomationAuthoring(undefined, targetId);
    const action = this.#claimMutation();
    try {
      const owner = this.#state.owner;
      const authorityKey = this.#automationOwnerKey();
      const options = mobileAutomationTargetOptions(owner).filter((candidate) => candidate.targetId === targetId);
      const target = owner?.targets.filter((candidate) => candidate.targetId === targetId);
      if (!owner || !authorityKey || !this.#state.automations.open || this.#state.automations.status !== "ready"
        || options.length !== 1 || options[0]!.workspaceKind !== "project"
        || !options[0]!.projectAutomationEligible || target?.length !== 1) {
        throw new Error("Choose a current local project before reconciling its Automations.");
      }
      const result = await this.#submitTerminal(create(OperationMutationSchema, {
        preconditions: [this.#automationTargetPrecondition(target[0]!)],
        payload: { case: "reconcileProjectAutomations", value: create(ReconcileProjectAutomationsMutationSchema, { targetId }) }
      }), { kind: "schedule-project-reconcile", targetId }, undefined, true, false);
      let accepted = false;
      let validationError: unknown;
      if (result.accepted && result.definitive) {
        try { accepted = this.#automationOperationAcknowledgement(result.operation); }
        catch (error) { validationError = error; }
      }
      if (result.definitive) await this.refreshAutomations();
      if (!result.definitive) {
        throw new Error("The durable project Automation reconciliation result is unknown. It was not resent.");
      }
      const rejection = automationMutationRejection(result, "project reconciliation");
      if (rejection !== undefined) throw rejection;
      if (validationError !== undefined) throw validationError;
      return accepted;
    } finally { this.#releaseMutation(action); }
  }

  async #prepareAutomationDeletion(scheduleId: string): Promise<MobileAutomationDeletionPreview> {
    const owner = this.#state.owner;
    const authorityKey = this.#automationOwnerKey();
    if (!owner || !authorityKey || !this.#state.automations.open || this.#state.automations.status !== "ready") {
      throw new Error("Reopen this Automation from the current Joko catalog before deleting it.");
    }
    const schedule = await this.#revalidateAutomationSchedule(scheduleId);
    if (schedule.source !== "dialogue") {
      throw new Error("Use the project Automation removal action for a project-owned Schedule.");
    }
    if (this.#state.owner !== owner || this.#automationOwnerKey() !== authorityKey) {
      throw new Error("The Automation owner changed while deletion was being prepared.");
    }
    const generatedSessionIds: string[] = [];
    const seen = new Set<string>();
    for (const session of owner.sessions) {
      if (session.automationOrigin?.scheduleId !== scheduleId) continue;
      if (!validMobileAutomationIdentity(session.sessionId) || seen.has(session.sessionId)) {
        throw new Error("The Joko node returned an invalid generated-task deletion manifest.");
      }
      seen.add(session.sessionId);
      generatedSessionIds.push(session.sessionId);
    }
    generatedSessionIds.sort(compareMobileAutomationIdentity);
    const runtime = projectMobileSchedulerRuntime(
      await this.network.readSchedulerRuntime(this.#ready(), this.#abort?.signal),
      new Set(this.#state.automations.schedules.map((candidate) => candidate.scheduleId))
    );
    if (this.#state.owner !== owner || this.#automationOwnerKey() !== authorityKey
      || !this.#state.automations.open) {
      throw new Error("The Automation owner changed while deletion was being prepared.");
    }
    return {
      scheduleId,
      scheduleRevision: mobileAutomationScheduleRevisionKey(schedule),
      generatedSessionIds,
      inflightCount: runtime.inFlightBySchedule[scheduleId] ?? 0
    };
  }

  async #submitProjectAutomationScheduleMutation(
    scheduleId: string,
    kind: Extract<PendingOperation["kind"], "schedule-promote" | "schedule-clone">,
    requiredSource: MobileAutomationSchedule["source"],
    build: (schedule: MobileAutomationSchedule) => {
      readonly mutation: OperationMutation;
      readonly resultSource: MobileAutomationSchedule["source"];
    }
  ): Promise<MobileAutomationSchedule | undefined> {
    this.#assertNoPendingAutomationAuthoring(scheduleId);
    const action = this.#claimMutation();
    try {
      const schedule = await this.#revalidateAutomationSchedule(scheduleId);
      if (schedule.source !== requiredSource) {
        throw new Error(requiredSource === "project"
          ? "Only a project-owned Automation can use this action."
          : "Only a personal Automation can be promoted to project configuration.");
      }
      if (kind === "schedule-promote" && schedule.sessionMode === "bound") {
        throw new Error("A task-bound Automation cannot be promoted to project configuration.");
      }
      const request = build(schedule);
      const result = await this.#submitTerminal(
        request.mutation,
        { kind, scheduleId },
        undefined,
        true,
        false
      );
      let projected: MobileAutomationSchedule | undefined;
      let validationError: unknown;
      if (result.accepted && result.definitive) {
        try {
          projected = this.#automationOperationSchedule(
            result.operation,
            undefined,
            schedule.targetId,
            request.resultSource
          );
        } catch (error) { validationError = error; }
      }
      if (result.definitive) await this.refreshAutomations(projected?.scheduleId);
      if (!result.definitive) {
        throw new Error("The durable project Automation result is unknown. It was not resent.");
      }
      const rejection = automationMutationRejection(result, "project change");
      if (rejection !== undefined) throw rejection;
      if (validationError !== undefined) throw validationError;
      return projected;
    } finally { this.#releaseMutation(action); }
  }

  #automationOperationSchedule(
    operation: Operation | undefined,
    expectedScheduleId: string | undefined,
    expectedTargetId: string,
    expectedSource: MobileAutomationSchedule["source"]
  ): MobileAutomationSchedule {
    const payload = operation?.result?.payload;
    if (payload?.case !== "schedule") {
      throw new Error("The Joko node completed the Automation operation without its typed Schedule result.");
    }
    const schedule = projectMobileAutomationSchedule(payload.value, expectedScheduleId);
    if (schedule.targetId !== expectedTargetId || schedule.source !== expectedSource) {
      throw new Error("The Joko node returned an Automation Schedule outside the requested owner and source.");
    }
    return schedule;
  }

  #automationOperationAcknowledgement(operation: Operation | undefined): true {
    const payload = operation?.result?.payload;
    if (payload?.case !== "acknowledgement" || payload.value.accepted !== true) {
      throw new Error("The Joko node completed the Automation operation without an accepted acknowledgement.");
    }
    return true;
  }

  #automationTargetForSchedulePrecondition(schedule: MobileAutomationSchedule) {
    const owner = this.#state.owner;
    const targets = owner?.targets.filter((candidate) => candidate.targetId === schedule.targetId) ?? [];
    const options = mobileAutomationTargetOptions(owner).filter((candidate) => candidate.targetId === schedule.targetId);
    if (targets.length !== 1 || options.length !== 1 || options[0]!.workspaceKind !== "project"
      || !options[0]!.projectAutomationEligible) {
      throw new Error("The Automation project is no longer eligible for project configuration.");
    }
    return this.#automationTargetPrecondition(targets[0]!);
  }

  #automationTargetPrecondition(target: Target) {
    const revision = target.version?.revision;
    if (!revision || revision.value < 1n) throw new Error("A current Automation Target revision is required.");
    return create(OperationPreconditionSchema, {
      entity: create(EntityRefSchema, { kind: EntityKind.TARGET, id: target.targetId }),
      expectedRevision: create(RevisionSchema, revision)
    });
  }

  #automationSessionPrecondition(session: Session) {
    const revision = session.version?.revision;
    if (!revision || revision.value < 1n) throw new Error("A current bound-task revision is required.");
    return create(OperationPreconditionSchema, {
      entity: create(EntityRefSchema, { kind: EntityKind.SESSION, id: session.sessionId }),
      expectedRevision: create(RevisionSchema, revision)
    });
  }

  #assertNoPendingAutomationAuthoring(scheduleId?: string, targetId?: string): void {
    const kinds: readonly PendingOperation["kind"][] = [
      "schedule-create", "schedule-update", "schedule-delete", "schedule-promote", "schedule-clone",
      "schedule-project-remove", "schedule-project-reconcile"
    ];
    if (this.#state.pending.some((pending) => kinds.includes(pending.kind)
      && (scheduleId !== undefined && pending.scheduleId === scheduleId
        || targetId !== undefined && pending.targetId === targetId))) {
      throw new Error("A related Automation change still has an unknown durable result. Check its receipt before retrying.");
    }
  }

  async openAutomationRunTask(scheduleId: string, triggerId: string): Promise<void> {
    const run = this.#automationRun(scheduleId, triggerId, (candidate) => candidate.sessionId !== undefined,
      "This Automation run has no task to open.");
    const sessionId = run.sessionId!;
    if (this.#state.owner?.sessions.filter((session) => session.sessionId === sessionId).length !== 1) {
      throw new Error("The Automation run task is no longer available on this Joko node.");
    }
    this.closeAutomations();
    await this.select(sessionId);
  }

  #automationOwnerKey(): string | undefined {
    const credential = this.#credential;
    const owner = this.#state.owner;
    if (!credential || !owner || !this.#foreground || this.#state.status !== "connected"
      || this.#state.activeProfileId !== credential.profileId || this.#state.node?.serverId !== credential.serverId
      || owner.server?.serverId !== credential.serverId || owner.generation < 1n) return undefined;
    const connections = owner.connections.filter((connection) => connection.connectionId === credential.connectionId);
    const devices = owner.devices.filter((device) => device.deviceId === credential.deviceId);
    const connection = connections.length === 1 ? connections[0] : undefined;
    const device = devices.length === 1 ? devices[0] : undefined;
    if (!connection || !device || connection.connectionProfileId !== credential.profileId
      || connection.deviceId !== credential.deviceId || connection.state !== ConnectionState.CONNECTED
      || device.kind !== DeviceKind.MOBILE || device.revoked || !device.connectionIds.includes(credential.connectionId)) return undefined;
    return [
      mobileCredentialKey(credential),
      entityVersionKey(connection.version),
      entityVersionKey(device.version),
      owner.generation.toString(10)
    ].join("\u001f");
  }

  #remoteDesktopOwnerKey(requireForeground: boolean): string | undefined {
    const credential = this.#credential;
    const owner = this.#state.owner;
    if (!credential || !owner || (requireForeground && !this.#foreground)
      || this.#state.activeProfileId !== credential.profileId || this.#state.node?.serverId !== credential.serverId
      || owner.server?.serverId !== credential.serverId || owner.generation < 1n) return undefined;
    const connections = owner.connections.filter((connection) => connection.connectionId === credential.connectionId);
    const devices = owner.devices.filter((device) => device.deviceId === credential.deviceId);
    const connection = connections.length === 1 ? connections[0] : undefined;
    const device = devices.length === 1 ? devices[0] : undefined;
    if (!connection || !device || connection.connectionProfileId !== credential.profileId
      || connection.deviceId !== credential.deviceId || connection.state !== ConnectionState.CONNECTED
      || device.kind !== DeviceKind.MOBILE || device.revoked
      || !device.connectionIds.includes(credential.connectionId)) return undefined;
    return [mobileCredentialKey(credential), entityVersionKey(connection.version), entityVersionKey(device.version),
      owner.generation.toString(10)].join("\u001f");
  }

  #automationRequestCurrent(generation: number, controller: AbortController, authorityKey: string): boolean {
    return !this.#disposed && this.#foreground && !controller.signal.aborted
      && this.#automationEpoch === generation && this.#automationAbort === controller
      && this.#state.automations.open && this.#automationOwnerKey() === authorityKey;
  }

  #automationHistoryRequestCurrent(
    generation: number,
    controller: AbortController,
    authorityKey: string,
    scheduleId: string,
    pageToken: string
  ): boolean {
    return !this.#disposed && this.#foreground && !controller.signal.aborted
      && this.#automationEpoch === generation && this.#automationHistoryAbort === controller
      && this.#state.automations.open && this.#state.automations.selectedScheduleId === scheduleId
      && this.#state.automations.historyNextPageToken === pageToken && this.#automationOwnerKey() === authorityKey;
  }

  #assertSameAutomationRevision(left: MobileAutomationSchedule, right: MobileAutomationSchedule): void {
    if (left.scheduleId !== right.scheduleId || left.revision.value !== right.revision.value
      || left.revision.etag !== right.revision.etag || left.generation !== right.generation) {
      throw new Error("The Automation Schedule changed while it was loading.");
    }
  }

  #automationRun(
    scheduleId: string,
    triggerId: string,
    predicate: (run: MobileAutomationRun) => boolean,
    failure: string
  ): MobileAutomationRun {
    const state = this.#state.automations;
    if (!state.open || state.status !== "ready" || state.selectedScheduleId !== scheduleId) throw new Error(failure);
    const matches = state.history.filter((run) => run.triggerId === triggerId);
    const run = matches.length === 1 ? matches[0] : undefined;
    if (!run || !predicate(run)) throw new Error(failure);
    return run;
  }

  #assertNoPendingAutomation(kind: PendingOperation["kind"], scheduleId?: string, triggerId?: string): void {
    if (this.#state.pending.some((pending) => pending.kind === kind
      && pending.scheduleId === scheduleId && pending.triggerId === triggerId)) {
      throw new Error("This exact Automation operation still has an unknown durable result. Check its receipt before retrying.");
    }
  }

  async #revalidateAutomationSchedule(scheduleId: string): Promise<MobileAutomationSchedule> {
    const credential = this.#ready();
    const authorityKey = this.#automationOwnerKey();
    const state = this.#state.automations;
    const matches = state.schedules.filter((schedule) => schedule.scheduleId === scheduleId);
    const observed = matches.length === 1 ? matches[0] : undefined;
    if (!authorityKey || !state.open || state.status !== "ready" || !observed) {
      throw new Error("Reopen this Automation from the current Joko catalog.");
    }
    const current = projectMobileAutomationSchedule(
      await this.network.readSchedule(credential, scheduleId, this.#abort?.signal),
      scheduleId
    );
    if (this.#automationOwnerKey() !== authorityKey || !this.#state.automations.open) {
      throw new Error("The Automation owner changed before the operation could be dispatched.");
    }
    this.#assertSameAutomationRevision(observed, current);
    return current;
  }

  async #revalidateAutomationCatalog(): Promise<readonly MobileAutomationSchedule[]> {
    const credential = this.#ready();
    const authorityKey = this.#automationOwnerKey();
    const observed = this.#state.automations.schedules;
    if (!authorityKey || !this.#state.automations.open || this.#state.automations.status !== "ready") {
      throw new Error("Reopen Automations from the current Joko catalog.");
    }
    const current = projectMobileAutomationCatalog(await this.network.listSchedules(credential, this.#abort?.signal));
    if (this.#automationOwnerKey() !== authorityKey || current.length !== observed.length) {
      throw new Error("The Automation catalog changed before the operation could be dispatched.");
    }
    for (let index = 0; index < current.length; index += 1) this.#assertSameAutomationRevision(observed[index]!, current[index]!);
    return current;
  }

  #automationSchedulePrecondition(schedule: MobileAutomationSchedule) {
    return create(OperationPreconditionSchema, {
      entity: create(EntityRefSchema, { kind: EntityKind.SCHEDULE, id: schedule.scheduleId }),
      expectedRevision: create(RevisionSchema, schedule.revision)
    });
  }

  async #submitAutomationMutation(
    scheduleId: string,
    triggerId: string | undefined,
    kind: Extract<PendingOperation["kind"], "schedule-run" | "schedule-enable" | "schedule-run-restart"
      | "schedule-run-read" | "schedule-runs-read" | "schedule-run-delete">,
    mutation: (schedule: MobileAutomationSchedule) => OperationMutation
  ): Promise<boolean> {
    this.#assertNoPendingAutomation(kind, scheduleId, triggerId);
    const action = this.#claimMutation();
    try {
      const schedule = await this.#revalidateAutomationSchedule(scheduleId);
      const result = await this.#submitTerminal(
        mutation(schedule),
        { kind, scheduleId, ...(triggerId === undefined ? {} : { triggerId }) },
        undefined,
        true,
        false
      );
      if (result.definitive) await this.refreshAutomations(scheduleId);
      return result.accepted && result.definitive;
    } finally { this.#releaseMutation(action); }
  }

  canOpenFiles(): boolean { return !this.#joinedTask && this.filesAuthorityKey() !== undefined; }

  filesAuthorityKey(): string | undefined { return this.#filesAuthorityKey(this.#state); }

  async prepareFilesThumbnail(ownerKey: string, source: MobileFilesComposerSource, signal: AbortSignal): Promise<MobileFilesThumbnailPreview> {
    signal.throwIfAborted(); const context = this.#filesContext(); const epoch = this.#filesEpoch;
    const windowKey = mobileFilesGalleryWindowKey(this.#state.files); const kind = mobileFilesThumbnailKind(source);
    if (!kind || source.kind === "search-result" || context.key !== ownerKey) throw new Error("The file miniature has no current source.");
    const assertCurrent = (currentSignal?: AbortSignal): void => {
      currentSignal?.throwIfAborted();
      if (!this.#currentFiles(epoch, ownerKey) || this.#credential !== context.credential || this.#state.files.status !== "ready"
        || mobileFilesGalleryWindowKey(this.#state.files) !== windowKey || this.#state.files.preview || this.#imageGallery
        || !filesComposerSourceIsCurrent(this.#state.files, source)) throw new Error("The file miniature source changed.");
    };
    assertCurrent(signal);
    const maximum = BigInt(kind === "image" ? MOBILE_FILES_IMAGE_MAXIMUM_BYTES : MOBILE_FILES_DOCUMENT_MAXIMUM_BYTES);
    const revision = source.kind === "workspace-entry" ? source.entry.revision : undefined;
    const blob = source.kind === "artifact" ? source.artifact.blob : undefined;
    const size = revision?.byteSize ?? blob?.byteSize;
    if (size === undefined || size < 0n) throw new Error("The file miniature source metadata is unavailable.");
    const directoryRevision = this.#state.files.directoryRevision; const artifactsRevision = this.#state.files.artifactsRevision;
    const thumbnailContext: MobileFilesThumbnailContext = { ownerKey, sourceKey: mobileFilesThumbnailSourceKey(source), assertCurrent,
      revalidate: async (currentSignal) => {
        assertCurrent(currentSignal);
        if (source.kind === "workspace-entry") {
          if (!revision || source.entry.workspaceId !== context.authority.workspace.workspaceId || !directoryRevision) throw new Error("The miniature Workspace source is unfenced.");
          const directory = await this.network.listWorkspaceDirectory(context.credential, source.entry.workspaceId, workspaceParentPath(source.entry.relativePath), currentSignal);
          assertCurrent(currentSignal);
          const matches = directory.entries.filter((entry) => entry.relativePath === source.entry.relativePath);
          if (directory.revision !== directoryRevision || matches.length !== 1 || !sameFilesWorkspaceEntry(matches[0]!, source.entry)) throw new Error("The authenticated miniature Workspace source changed.");
        } else {
          if (!artifactsRevision) throw new Error("The miniature Generated source is unfenced.");
          await this.#revalidateGeneratedShareArtifact(context, source.artifact, artifactsRevision, currentSignal); assertCurrent(currentSignal);
        }
      },
      read: async (currentSignal) => {
        assertCurrent(currentSignal); if (size > maximum) return undefined;
        let imageBlob = blob;
        if (source.kind === "workspace-entry") {
          const entry = source.entry;
          if (kind === "text") {
            const preview = await this.network.readWorkspaceFile(context.credential, entry.workspaceId, entry.relativePath, revision!, currentSignal);
            assertCurrent(currentSignal); assertWorkspaceFilePreview(entry.workspaceId, entry.relativePath, revision!, preview);
            if (preview.entry?.kind !== FileKind.REGULAR || normalizeMediaType(preview.entry.mediaType) !== normalizeMediaType(entry.mediaType)) throw new Error("The miniature document source changed.");
            return preview.content.case === "text" && preview.content.value.startByte === 0n && !preview.truncated
              && new TextEncoder().encode(preview.content.value.utf8Text).length <= MOBILE_FILES_DOCUMENT_MAXIMUM_BYTES
              ? { kind: "text", text: preview.content.value.utf8Text } : undefined;
          }
          const materialized = await this.network.materializeWorkspaceFileBlob(context.credential, entry.workspaceId, entry.relativePath, revision!, currentSignal);
          assertCurrent(currentSignal); const fresh = materialized.entry; imageBlob = materialized.blob;
          if (fresh.workspaceId !== entry.workspaceId || fresh.relativePath !== entry.relativePath || fresh.kind !== FileKind.REGULAR
            || normalizeMediaType(fresh.mediaType) !== normalizeMediaType(entry.mediaType) || !fresh.revision || !workspaceComposerRevisionMatches(revision!, fresh.revision)
            || fresh.revision.byteSize !== imageBlob.byteSize || fresh.revision.sha256Hex !== imageBlob.sha256Hex
            || imageBlob.fileName !== workspaceBasename(entry.relativePath) || normalizeMediaType(imageBlob.mediaType) !== normalizeMediaType(entry.mediaType)) throw new Error("The miniature Workspace Blob changed.");
        }
        if (!imageBlob) throw new Error("The miniature canonical Blob is unavailable.");
        if (kind === "text") {
          const download = await this.network.downloadBlob(context.credential, imageBlob, currentSignal); assertCurrent(currentSignal);
          const text = mobileFilesDocumentBytes(imageBlob, download); return text === undefined ? undefined : { kind: "text", text };
        }
        const thumbnail = await this.network.readImageThumbnail(context.credential, imageBlob, 256, currentSignal); assertCurrent(currentSignal);
        if (thumbnail) return { kind: "image", blob: imageBlob, bytes: thumbnail.data, mediaType: thumbnail.mediaType, thumbnail };
        const original = await this.network.downloadBlob(context.credential, imageBlob, currentSignal); assertCurrent(currentSignal);
        return { kind: "image", blob: imageBlob, ...original };
      } };
    return this.#filesThumbnails.prepare(thumbnailContext, signal);
  }

  confirmFilesThumbnail(leaseId: string, native: MobileImageGalleryNativeDecode): void { this.#filesThumbnails.confirm(leaseId, native); }
  releaseFilesThumbnail(leaseId: string, discard = false): void { this.#filesThumbnails.release(leaseId, discard); }

  prepareFilesPathCopy(expectedFiles: MobileFilesState, source?: MobileFilesComposerSource): MobileFilesClipboardLease {
    if (this.#state.files !== expectedFiles) throw new Error("The displayed Files copy surface has changed.");
    const context = this.#filesContext(); const epoch = this.#filesEpoch;
    const copyEpoch = this.#filesCopyEpoch;
    const windowKey = mobileFilesGalleryWindowKey(this.#state.files);
    const location = this.#state.files.location;
    const assertCurrent = (signal?: AbortSignal): void => {
      signal?.throwIfAborted();
      if (!this.#currentFiles(epoch, context.key) || this.#state.files.status !== "ready" || this.#filesCopyEpoch !== copyEpoch || mobileFilesGalleryWindowKey(this.#state.files) !== windowKey
        || this.#state.files.preview || this.#imageGallery
        || (source && !filesComposerSourceIsCurrent(this.#state.files, source))) throw new Error("The Files copy source is no longer current.");
    };
    assertCurrent();
    if (!source) {
      if (location.kind !== "workspace" || !this.#state.files.directoryRevision) throw new Error("Select a known Workspace directory before copying its path.");
      return { text: canonicalWorkspacePath(location.path, true) || ".", kind: "path", assertCurrent };
    }
    if (source.kind === "workspace-entry") return { ...mobileFilesWorkspaceClipboardValue(source.entry.relativePath), assertCurrent };
    if (source.kind !== "artifact") throw new Error("Select a current browse item before copying its path.");
    return { ...mobileFilesGeneratedClipboardValue(source.artifact.blob?.fileName), assertCurrent };
  }

  prepareFilesPreviewPathCopy(
    expectedFiles: MobileFilesState,
    pagerId: string,
    pageKey: string
  ): MobileFilesClipboardLease {
    if (this.#state.files !== expectedFiles) throw new Error("The displayed Files preview surface has changed.");
    const lease = this.#filesPreviewPager;
    const copyEpoch = this.#filesCopyEpoch;
    if (!lease || lease.descriptor.id !== pagerId || expectedFiles.previewPager !== lease.descriptor
      || !this.#filesPreviewPagerCurrent(lease)) throw new Error("The Files preview window is no longer current.");
    const descriptor = lease.descriptor;
    const page = descriptor.pages[descriptor.index];
    if (!page || page.key !== pageKey || expectedFiles.preview?.kind === "loading") {
      throw new Error("Select a resolved current file preview before copying its path.");
    }
    const value = page.kind === "workspace"
      ? mobileFilesWorkspaceClipboardValue(page.entry.relativePath)
      : mobileFilesGeneratedClipboardValue(page.artifact.blob?.fileName);
    const assertCurrent = (signal?: AbortSignal): void => {
      signal?.throwIfAborted();
      if (this.#filesCopyEpoch !== copyEpoch || this.#filesPreviewPager !== lease || lease.descriptor !== descriptor
        || !this.#filesPreviewPagerCurrent(lease) || this.#imageGallery
        || descriptor.pages[descriptor.index] !== page || this.#state.files.preview?.kind === "loading") {
        throw new Error("The visible Files preview page changed before its path was copied.");
      }
    };
    assertCurrent();
    return { ...value, assertCurrent };
  }

  prepareFilesImageGalleryPathCopy(
    galleryLeaseId: string,
    loadId: string,
    pageId: string
  ): MobileFilesClipboardLease {
    const lease = this.#imageGallery;
    const loaded = lease?.loaded;
    const copyEpoch = this.#filesCopyEpoch;
    if (!lease || lease.leaseId !== galleryLeaseId || lease.source.kind !== "files" || lease.operationInFlight
      || !loaded || loaded.loadId !== loadId || loaded.page.pageId !== pageId || !this.imageGalleryCurrent(galleryLeaseId)) {
      throw new Error("The Files image gallery page is no longer current.");
    }
    const source = loaded.page.source;
    const value = source.kind === "workspace"
      ? mobileFilesWorkspaceClipboardValue(source.relativePath)
      : source.kind === "artifact"
        ? mobileFilesGeneratedClipboardValue(loaded.page.blob.fileName)
        : undefined;
    if (!value) throw new Error("The current gallery page does not belong to Files.");
    const assertCurrent = (signal?: AbortSignal): void => {
      signal?.throwIfAborted();
      if (this.#filesCopyEpoch !== copyEpoch || this.#imageGallery !== lease || lease.source.kind !== "files"
        || lease.operationInFlight || lease.loaded !== loaded || loaded.loadId !== loadId
        || loaded.page.pageId !== pageId || !this.imageGalleryCurrent(galleryLeaseId)) {
        throw new Error("The visible Files image changed before its path was copied.");
      }
    };
    assertCurrent();
    return { ...value, assertCurrent };
  }

  async openFiles(): Promise<void> {
    await this.#openFilesAt("");
  }

  async #openFilesAt(relativePath: string): Promise<void> {
    const context = this.#filesContext();
    this.closeTimelinePreview();
    this.#cancelFilesRequests();
    const epoch = this.#filesEpoch;
    const location = { kind: "workspace" as const, path: canonicalWorkspacePath(relativePath, true) };
    this.#set({
      files: {
        ...emptyMobileFilesState(),
        open: true,
        status: "loading",
        authorityKey: context.key,
        sessionId: context.authority.sessionId,
        workspace: context.authority.workspace,
        location,
        watchStatus: context.authority.watchSupported ? "idle" : "unavailable"
      }
    });
    const loaded = await this.#loadFiles(context, location, epoch);
    if (loaded && context.authority.watchSupported && this.#currentFiles(epoch, context.key)) {
      void this.#watchFiles(context, epoch);
    }
  }

  closeFiles(): void {
    this.#cancelFilesRequests();
    this.#set({ files: emptyMobileFilesState() });
  }

  async refreshFiles(): Promise<void> {
    if (!this.#state.files.open) return;
    this.#filesCopyEpoch++;
    let context: MobileFilesContext;
    try { context = this.#filesContext(); }
    catch {
      this.#set({ files: { ...this.#state.files, status: "offline" } });
      return;
    }
    if (context.key !== this.#state.files.authorityKey) return;
    this.#filesListAbort?.abort();
    this.#filesSearchAbort?.abort();
    this.#filesPreviewAbort?.abort();
    await this.#releaseFilesBinaryPreviews().catch(() => undefined);
    if (!this.#currentFiles(this.#filesEpoch, context.key)) return;
    if (this.#filesRefreshTimer !== undefined) clearTimeout(this.#filesRefreshTimer);
    this.#filesRefreshTimer = undefined;
    const epoch = this.#filesEpoch;
    const location = this.#state.files.location;
    const search = {
      query: this.#state.files.searchQuery,
      mode: this.#state.files.searchMode,
      caseSensitive: this.#state.files.searchCaseSensitive
    };
    this.#set({ files: { ...this.#state.files, status: "loading", preview: undefined, error: undefined } });
    if (!await this.#loadFiles(context, location, epoch)) return;
    if (search.query && this.#currentFiles(epoch, context.key)) {
      await this.searchFiles(search.query, search.mode, search.caseSensitive);
    }
  }

  async openFilesDirectory(relativePath: string): Promise<void> {
    const path = canonicalWorkspacePath(relativePath, true);
    const context = this.#filesContext();
    if (!this.#state.files.open || context.key !== this.#state.files.authorityKey) {
      throw new Error("Open Files for the current task before browsing its Workspace.");
    }
    this.#filesListAbort?.abort();
    this.#filesSearchAbort?.abort();
    this.#filesPreviewAbort?.abort();
    void this.#releaseFilesBinaryPreviews().catch(() => undefined);
    const epoch = this.#filesEpoch;
    const location = { kind: "workspace" as const, path };
    this.#set({ files: {
      ...this.#state.files,
      status: "loading",
      location,
      entries: [],
      searchQuery: "",
      searchStatus: "idle",
      searchResults: [],
      searchTruncated: false,
      searchTotalFiles: 0,
      searchError: undefined,
      preview: undefined,
      error: undefined
    } });
    await this.#loadFiles(context, location, epoch);
  }

  openGeneratedFiles(): void {
    const context = this.#filesContext();
    if (!this.#state.files.open || context.key !== this.#state.files.authorityKey) {
      throw new Error("Open Files for the current task before browsing Generated files.");
    }
    this.#filesSearchAbort?.abort();
    this.#filesPreviewAbort?.abort();
    void this.#releaseFilesBinaryPreviews().catch(() => undefined);
    this.#set({ files: {
      ...this.#state.files,
      location: { kind: "generated" },
      searchQuery: "",
      searchStatus: "idle",
      searchResults: [],
      searchTruncated: false,
      searchTotalFiles: 0,
      searchError: undefined,
      preview: undefined
    } });
  }

  async searchFiles(query: string, mode: MobileFilesSearchMode, caseSensitive: boolean): Promise<void> {
    const normalized = query.trim();
    this.#filesSearchAbort?.abort();
    this.#filesSearchAbort = undefined;
    const epoch = this.#filesEpoch;
    let context: MobileFilesContext;
    try { context = this.#filesContext(); }
    catch {
      if (this.#state.files.open) {
        this.#set({ files: { ...this.#state.files, status: "offline", searchQuery: normalized,
          searchMode: mode, searchCaseSensitive: caseSensitive, searchStatus: "error",
          searchResults: [], searchError: "Reconnect to search the current Workspace." } });
      }
      return;
    }
    if (!this.#state.files.open || context.key !== this.#state.files.authorityKey) return;
    if (!normalized) {
      this.#set({ files: { ...this.#state.files, searchQuery: "", searchMode: mode,
        searchCaseSensitive: caseSensitive, searchStatus: "idle", searchResults: [],
        searchTruncated: false, searchTotalFiles: 0, searchError: undefined } });
      return;
    }
    if (mode === "name") {
      const results = filterWorkspaceFileNames(
        this.#state.files.fileIndex,
        this.#state.files.artifacts,
        normalized,
        caseSensitive
      );
      this.#set({ files: { ...this.#state.files, searchQuery: normalized, searchMode: mode,
        searchCaseSensitive: caseSensitive, searchStatus: "ready", searchResults: results,
        searchTruncated: this.#state.files.fileIndexTruncated,
        searchTotalFiles: results.length, searchError: undefined } });
      return;
    }
    const controller = new AbortController();
    this.#filesSearchAbort = controller;
    this.#set({ files: { ...this.#state.files, searchQuery: normalized, searchMode: mode,
      searchCaseSensitive: caseSensitive, searchStatus: "searching", searchResults: [],
      searchTruncated: false, searchTotalFiles: 0, searchError: undefined } });
    try {
      const result = await this.network.searchWorkspace(
        context.credential,
        context.authority.workspace.workspaceId,
        normalized,
        caseSensitive,
        controller.signal
      );
      if (controller.signal.aborted || this.#filesSearchAbort !== controller
        || !this.#currentFiles(epoch, context.key)
        || this.#state.files.searchQuery !== normalized
        || this.#state.files.searchMode !== mode
        || this.#state.files.searchCaseSensitive !== caseSensitive) return;
      this.#set({ files: { ...this.#state.files, searchStatus: "ready",
        searchResults: result.matches.map((match) => ({ kind: "workspace-content" as const, match })),
        searchTruncated: result.truncated, searchTotalFiles: result.totalFiles,
        searchError: undefined } });
    } catch (error) {
      if (controller.signal.aborted || !this.#currentFiles(epoch, context.key)) return;
      this.#set({ files: { ...this.#state.files, searchStatus: "error", searchResults: [],
        searchTruncated: false, searchTotalFiles: 0, searchError: message(error) } });
    } finally {
      if (this.#filesSearchAbort === controller) this.#filesSearchAbort = undefined;
    }
  }

  async openFilesPreviewPager(source: MobileFilesComposerSource, sort: MobileFilesSortMode = "name"): Promise<void> {
    const context = this.#filesContext(); const epoch = this.#filesEpoch;
    if (!this.#state.files.open || !filesComposerSourceIsCurrent(this.#state.files, source)) throw new Error("Select a current Files item before previewing it.");
    const prior = this.#state.files.preview;
    this.#retireFilesPreviewPager(); this.#filesPreviewAbort?.abort();
    const controller = new AbortController(); this.#filesPagerOpeningAbort = controller;
    const assertCurrent = () => {
      controller.signal.throwIfAborted();
      if (this.#filesPagerOpeningAbort !== controller || !this.#currentFiles(epoch, context.key)) throw new Error("The Files preview owner changed.");
    };
    const artifact = filesComposerArtifact(source);
    const path = artifact ? "" : canonicalWorkspacePath(source.kind === "workspace-entry" ? source.entry.relativePath
      : source.kind === "search-result" && source.result.kind !== "artifact" ? source.result.kind === "workspace-content" ? source.result.match.relativePath : source.result.relativePath : "");
    const title = artifact ? artifactTitle(artifact) : workspaceBasename(path);
    this.#set({ files: { ...this.#state.files, previewPager: undefined,
      preview: prior?.kind === "text" && prior.sourceLabel === path ? prior : { title, sourceLabel: artifact ? "Generated" : path,
        mediaType: artifact?.blob?.mediaType ?? "application/octet-stream", byteSize: artifact?.blob?.byteSize ?? 0n, revisionKey: "resolving:" + title, kind: "loading" } } });
    let timedOut = false;
    const deadline = setTimeout(() => { timedOut = true; controller.abort(); }, 15_000);
    try {
      let pages: readonly MobileFilesPreviewPage[]; let window: MobileFilesPreviewPagerLease["window"]; let selectedKey: string;
      let directory: Awaited<ReturnType<MobileNetwork["listWorkspaceDirectory"]>> | undefined;
      let catalog: Awaited<ReturnType<MobileNetwork["listSessionArtifacts"]>> | undefined;
      if (artifact) {
        catalog = await this.#readFilesPager(() => this.network.listSessionArtifacts(context.credential, context.authority.sessionId, controller.signal), controller.signal);
        assertCurrent();
        const matches = catalog.artifacts.filter((item) => item.artifactId === artifact.artifactId);
        if (!catalog.revision || matches.length !== 1 || !sameFilesComposerArtifact(matches[0]!, artifact)) throw new Error("The Generated file changed before its preview opened.");
        pages = mobileGeneratedPreviewPages(catalog.artifacts, sort, artifact.artifactId);
        window = { kind: "generated", revision: catalog.revision }; selectedKey = JSON.stringify(["artifact", artifact.artifactId]);
      } else {
        const parent = workspaceParentPath(path);
        directory = await this.#readFilesPager(() => this.network.listWorkspaceDirectory(context.credential, context.authority.workspace.workspaceId, parent, controller.signal), controller.signal);
        assertCurrent(); const seen = new Set<string>();
        for (const item of directory.entries) {
          const canonical = canonicalWorkspacePath(item.relativePath);
          if (item.workspaceId !== context.authority.workspace.workspaceId || workspaceParentPath(canonical) !== parent || seen.has(canonical)) throw new Error("The preview directory returned an ambiguous canonical file.");
          seen.add(canonical);
        }
        const entry = directory.entries.find((item) => item.relativePath === path);
        if (!directory.revision || !entry?.revision || entry.kind !== FileKind.REGULAR) throw new Error("The selected preview file is no longer available.");
        if (source.kind === "workspace-entry" && !sameFilesWorkspaceEntry(entry, source.entry)) throw new Error("The selected preview file changed.");
        if (source.kind === "search-result" && source.result.kind === "workspace-content"
          && (!source.result.match.revision || workspaceEntryRevisionKey(source.result.match.revision) !== workspaceEntryRevisionKey(entry.revision))) throw new Error("The file search result changed.");
        pages = mobileWorkspacePreviewPages(directory.entries, sort, entry, source.kind === "search-result" ? source : { kind: "workspace-entry", entry });
        window = { kind: "workspace", parent, revision: directory.revision }; selectedKey = JSON.stringify(["workspace", entry.workspaceId, path]);
      }
      assertCurrent();
      const index = pages.findIndex((page) => page.key === selectedKey);
      if (index < 0) throw new Error("The selected file left its preview window.");
      const descriptor: MobileFilesPreviewPager = { id: this.newId(), pages, index, sort };
      const lease: MobileFilesPreviewPagerLease = { context, epoch, controller, descriptor, window };
      this.#filesPreviewPager = lease;
      const files = this.#state.files;
      this.#set({ files: { ...files, previewPager: descriptor,
        ...(catalog ? { artifacts: catalog.artifacts, artifactsRevision: catalog.revision } : {}),
        ...(directory && window.kind === "workspace" && files.location.kind === "workspace" && files.location.path === window.parent
          ? { entries: directory.entries, directoryRevision: directory.revision } : {}) } });
      const selected = pages[index]!;
      if (prior?.kind === "text" && selected.kind === "workspace" && prior.workspaceEntry?.revision
        && prior.sourceLabel === path && workspaceComposerRevisionMatches(selected.entry.revision!, prior.workspaceEntry.revision)) { lease.original = prior.workspaceEntry; return; }
      await this.selectFilesPreviewPage(descriptor.id, selectedKey, false);
      if (timedOut) throw new Error("The file preview timed out. Open Files again.");
    } catch (error) {
      if (!this.#currentFiles(epoch, context.key) || this.#filesPagerOpeningAbort !== controller || controller.signal.aborted && !timedOut) return;
      this.#retireFilesPreviewPager();
      this.#set({ files: { ...this.#state.files, previewPager: undefined, preview: { title, sourceLabel: artifact ? "Generated" : path,
        mediaType: artifact?.blob?.mediaType ?? "application/octet-stream", byteSize: artifact?.blob?.byteSize ?? 0n,
        revisionKey: "unavailable:" + title, kind: "error", reason: timedOut ? "The file preview timed out. Open Files again." : message(error) } } });
    } finally { clearTimeout(deadline); if (this.#filesPagerOpeningAbort === controller) this.#filesPagerOpeningAbort = undefined; }
  }

  async selectFilesPreviewPage(pagerId: string, pageKey: string, revalidate = true): Promise<void> {
    const lease = this.#filesPreviewPager;
    if (!lease || lease.descriptor.id !== pagerId || !this.#filesPreviewPagerCurrent(lease)) throw new Error("The Files preview window was retired.");
    const index = lease.descriptor.pages.findIndex((page) => page.key === pageKey);
    if (index < 0) throw new Error("Select a file from the current preview window.");
    const page = lease.descriptor.pages[index]!;
    this.#filesPagerNavigationAbort?.abort(); this.#filesPreviewAbort?.abort();
    const retiredBinary = this.#releaseFilesBinaryPreviews().then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));
    lease.original = undefined;
    const controller = new AbortController(); this.#filesPagerNavigationAbort = controller;
    const abort = () => controller.abort(); lease.controller.signal.addEventListener("abort", abort, { once: true });
    lease.descriptor = { ...lease.descriptor, index };
    const base = { title: page.title, sourceLabel: page.kind === "workspace" ? page.entry.relativePath : "Generated",
      mediaType: page.mediaType, byteSize: page.byteSize, revisionKey: page.key };
    this.#set({ files: { ...this.#state.files, previewPager: lease.descriptor, preview: { ...base, kind: "loading" } } });
    let timedOut = false; let windowChanged: string | undefined; const deadline = setTimeout(() => { timedOut = true; controller.abort(); }, 15_000);
    const assertCurrent = () => {
      controller.signal.throwIfAborted();
      if (this.#filesPagerNavigationAbort !== controller || !this.#filesPreviewPagerCurrent(lease) || lease.descriptor.pages[lease.descriptor.index]?.key !== page.key) {
        throw new Error("The visible file preview changed.");
      }
    };
    try {
      await this.#readFilesPager(async () => {
        assertCurrent();
        const release = await retiredBinary; if (!release.ok) throw release.error;
        assertCurrent();
        if (revalidate) {
          if (lease.window.kind === "workspace") {
            const directory = await this.network.listWorkspaceDirectory(lease.context.credential, lease.context.authority.workspace.workspaceId, lease.window.parent, controller.signal);
            assertCurrent();
            if (directory.revision !== lease.window.revision) { windowChanged = "The Files directory changed. Open the file again."; this.closeFilesPreview(); throw new Error(windowChanged); }
          } else {
            const catalog = await this.network.listSessionArtifacts(lease.context.credential, lease.context.authority.sessionId, controller.signal);
            assertCurrent();
            if (catalog.revision !== lease.window.revision) { windowChanged = "The Generated catalog changed. Open the file again."; this.closeFilesPreview(); throw new Error(windowChanged); }
          }
        }
        assertCurrent(); await this.#releaseFilesBinaryPreviews(); assertCurrent();
        if (page.kind === "workspace") await this.#previewWorkspaceFile(page.entry.relativePath, page.entry.revision!, page.title, controller.signal);
        else await this.previewArtifact(page.artifact, controller.signal);
      }, controller.signal);
    } catch (error) {
      if (windowChanged) throw new Error(windowChanged);
      if (this.#filesPagerNavigationAbort !== controller || !this.#filesPreviewPagerCurrent(lease)) return;
      if (controller.signal.aborted && !timedOut) return;
      this.#set({ files: { ...this.#state.files, preview: { ...base, kind: "error", reason: timedOut ? "The file preview timed out. Try another page or open Files again." : message(error) } } });
    } finally {
      clearTimeout(deadline); lease.controller.signal.removeEventListener("abort", abort);
      if (this.#filesPagerNavigationAbort === controller) this.#filesPagerNavigationAbort = undefined;
    }
  }

  #filesPreviewPagerCurrent(lease: MobileFilesPreviewPagerLease): boolean {
    const files = this.#state.files;
    return this.#filesPreviewPager === lease && !lease.controller.signal.aborted && this.#credential === lease.context.credential
      && this.#currentFiles(lease.epoch, lease.context.key) && files.status === "ready" && !!files.preview && files.previewPager === lease.descriptor
      && (lease.window.kind !== "generated" || files.artifactsRevision === lease.window.revision)
      && (lease.window.kind !== "workspace" || files.location.kind !== "workspace" || files.location.path !== lease.window.parent || files.directoryRevision === lease.window.revision);
  }
  #retireFilesPreviewPager(): void {
    this.#filesPagerOpeningAbort?.abort(); this.#filesPagerOpeningAbort = undefined;
    this.#filesPagerNavigationAbort?.abort(); this.#filesPagerNavigationAbort = undefined;
    this.#filesPreviewPager?.controller.abort(); this.#filesPreviewPager = undefined;
    void this.#releaseFilesBinaryPreviews().catch(() => undefined);
  }
  async #readFilesPager<T>(read: () => Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted();
    if (this.#filesPagerReadActive) await new Promise<void>((resolve, reject) => {
      const waiting = { grant: () => { signal.removeEventListener("abort", waiting.cancel); resolve(); },
        cancel: () => { signal.removeEventListener("abort", waiting.cancel); if (this.#filesPagerReadWaiting === waiting) this.#filesPagerReadWaiting = undefined;
          reject(new Error("The file preview was cancelled.")); } };
      this.#filesPagerReadWaiting?.cancel(); this.#filesPagerReadWaiting = waiting; signal.addEventListener("abort", waiting.cancel, { once: true });
    });
    if (signal.aborted) {
      this.#filesPagerReadActive = false; const waiting = this.#filesPagerReadWaiting; this.#filesPagerReadWaiting = undefined;
      if (waiting) { this.#filesPagerReadActive = true; waiting.grant(); }
      signal.throwIfAborted();
    }
    this.#filesPagerReadActive = true;
    const release = () => {
      this.#filesPagerReadActive = false; const waiting = this.#filesPagerReadWaiting; this.#filesPagerReadWaiting = undefined;
      if (waiting) { this.#filesPagerReadActive = true; waiting.grant(); }
    };
    let raw: Promise<T>; try { raw = read(); } catch (error) { release(); throw error; }
    void raw.then(release, release);
    return awaitMobileMarkdownResourceRead(raw, signal);
  }
  async previewWorkspaceEntry(entry: WorkspaceEntry): Promise<void> {
    if (entry.kind === FileKind.DIRECTORY) {
      await this.openFilesDirectory(entry.relativePath);
      return;
    }
    const revision = entry.revision;
    const current = this.#state.files.entries.find((candidate) => candidate.relativePath === entry.relativePath);
    if (!revision || !current?.revision || current.workspaceId !== entry.workspaceId
      || workspaceEntryRevisionKey(current.revision) !== workspaceEntryRevisionKey(revision)) {
      throw new Error("Select a file from the current Workspace directory.");
    }
    await this.#previewWorkspaceFile(entry.relativePath, revision, entry.displayName || workspaceBasename(entry.relativePath));
  }

  async previewFileSearchResult(result: MobileFileSearchResult): Promise<void> {
    if (!this.#state.files.searchResults.includes(result)) {
      throw new Error("Select a result from the current file search.");
    }
    if (result.kind === "artifact") {
      await this.previewArtifact(result.artifact);
      return;
    }
    if (result.kind === "workspace-content") {
      if (!result.match.revision) throw new Error("The search result is missing its observed file revision.");
      await this.#previewWorkspaceFile(
        result.match.relativePath,
        result.match.revision,
        workspaceBasename(result.match.relativePath)
      );
      return;
    }
    await this.#previewIndexedWorkspaceFile(result.relativePath);
  }

  async previewArtifact(artifact: Artifact, signal?: AbortSignal): Promise<void> {
    const current = this.#state.files.artifacts.find((candidate) => candidate.artifactId === artifact.artifactId);
    if (!current || current !== artifact || current.sessionId !== this.#state.files.sessionId) {
      throw new Error("Select a Generated file from the current task.");
    }
    const context = this.#filesContext();
    if (!this.#state.files.open || context.key !== this.#state.files.authorityKey) return;
    this.#filesPreviewAbort?.abort();
    const controller = new AbortController();
    this.#filesPreviewAbort = controller;
    const abort = () => controller.abort(); signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
    const epoch = this.#filesEpoch;
    const blob = current.blob;
    const mediaType = normalizeMediaType(blob?.mediaType ?? "application/octet-stream") || "application/octet-stream";
    const byteSize = blob?.byteSize ?? 0n;
    const audioMetadata = mediaType.startsWith("audio/") ? mapMobileAudioMetadata(current.audioMetadata) : undefined;
    const base = {
      title: audioMetadata?.title.trim() || artifactTitle(current),
      fileName: blob?.fileName,
      sourceLabel: "Generated",
      mediaType,
      byteSize,
      revisionKey: [current.artifactId, blob?.blobId ?? "", blob?.sha256Hex ?? "", byteSize.toString(10)].join(":")
    };
    this.#set({ files: { ...this.#state.files, preview: { ...base, kind: "loading" } } });
    let stagedMedia: MobileMediaPreviewLease | undefined;
    let stagedPdf: MobilePdfPreviewLease | undefined;
    let stagedModel: MobileModelPreviewLease | undefined;
    try {
      await this.#releaseFilesBinaryPreviews();
      if (controller.signal.aborted || this.#filesPreviewAbort !== controller
        || !this.#currentFiles(epoch, context.key)) return;
      let preview: MobileFilePreview;
      if (!blob) {
        preview = { ...base, kind: "unsupported", reason: "This Generated file has no canonical Blob payload." };
      } else if (blob.byteSize > BigInt(MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES)) {
        preview = { ...base, kind: "unsupported",
          reason: `This ${mediaType} file is ${blob.byteSize.toString(10)} bytes and exceeds the mobile preview limit.` };
      } else if (mediaType.startsWith("image/")) {
        const download = await this.network.downloadBlob(context.credential, blob, controller.signal);
        const decoded = mobileImageGalleryMediaType(mediaType) ? inspectMobileImageGalleryBytes(download.bytes, mediaType) : undefined;
        preview = { ...base, kind: "image", dataUri: decoded ? mobileImageGalleryPreviewUri(download.bytes, decoded) : bytesToDataUri(download.bytes, download.mediaType),
          altText: current.description.trim() || artifactTitle(current), widthPixels: decoded?.width ?? 0, heightPixels: decoded?.height ?? 0 };
      } else if (mobileModelPreviewKind(mediaType, blob.fileName)) {
        if (!this.modelPreviewFiles) {
          preview = { ...base, kind: "unsupported", reason: "3D model preview is unavailable on this mobile runtime." };
        } else {
          const download = await this.network.downloadBlob(context.credential, blob, controller.signal);
          if (normalizeMediaType(download.mediaType) !== mediaType) {
            throw new Error("The downloaded media type did not match the canonical Generated model Blob.");
          }
          stagedModel = await this.modelPreviewFiles.stage({
            profileId: context.credential.profileId,
            leaseId: this.newId(),
            modelPath: blob.fileName,
            mediaType,
            expectedSha256Hex: blob.sha256Hex,
            bytes: download.bytes,
            signal: controller.signal
          });
          preview = { ...base, kind: "model", ...stagedModel };
        }
      } else if (isTextFilePreviewMetadata(mediaType, blob.fileName)) {
        if (blob.byteSize > 2_097_152n) {
          preview = { ...base, kind: "unsupported",
            reason: `This text file is ${blob.byteSize.toString(10)} bytes and exceeds the 2097152-byte text preview window.` };
        } else {
          const download = await this.network.downloadBlob(context.credential, blob, controller.signal);
          const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(download.bytes);
          if (text.includes("\0")) throw new Error("The Generated text file contains binary data.");
          preview = { ...base, kind: "text", text, languageId: "", startByte: 0n,
            endByte: blob.byteSize, totalLines: text === "" ? 0 : text.split(/\r?\n/gu).length, truncated: false };
        }
      } else if (mobileMediaPreviewKind(mediaType)) {
        if (!this.mediaPreviewFiles) {
          preview = { ...base, kind: "unsupported", reason: "Audio/video preview is unavailable on this mobile runtime." };
        } else {
          const download = await this.network.downloadBlob(context.credential, blob, controller.signal);
          if (normalizeMediaType(download.mediaType) !== mediaType) {
            throw new Error("The downloaded media type did not match the canonical Generated Blob.");
          }
          stagedMedia = await this.mediaPreviewFiles.stage(
            context.credential.profileId,
            this.newId(),
            blob.fileName || artifactTitle(current),
            mediaType,
            blob.sha256Hex,
            download.bytes,
            controller.signal
          );
          preview = { ...base, kind: "media", ...stagedMedia,
            ...(audioMetadata === undefined ? {} : { audioMetadata }) };
        }
      } else if (isMobilePdfPreviewMediaType(mediaType)) {
        if (!this.pdfPreviewFiles) {
          preview = { ...base, kind: "unsupported", reason: "PDF preview is unavailable on this mobile runtime." };
        } else {
          const download = await this.network.downloadBlob(context.credential, blob, controller.signal);
          if (normalizeMediaType(download.mediaType) !== mediaType) {
            throw new Error("The downloaded media type did not match the canonical Generated PDF Blob.");
          }
          stagedPdf = await this.pdfPreviewFiles.stage(
            context.credential.profileId,
            this.newId(),
            blob.fileName || artifactTitle(current),
            mediaType,
            blob.sha256Hex,
            download.bytes,
            controller.signal
          );
          preview = { ...base, kind: "pdf", ...stagedPdf };
        }
      } else {
        preview = { ...base, kind: "unsupported",
          reason: `No safe in-app preview is available for ${mediaType} (${blob.byteSize.toString(10)} bytes).` };
      }
      if (controller.signal.aborted || this.#filesPreviewAbort !== controller
        || !this.#currentFiles(epoch, context.key)) {
        if (stagedMedia) await this.mediaPreviewFiles?.remove(stagedMedia).catch(() => undefined);
        if (stagedPdf) await this.pdfPreviewFiles?.remove(stagedPdf).catch(() => undefined);
        if (stagedModel) await this.modelPreviewFiles?.remove(stagedModel).catch(() => undefined);
        return;
      }
      this.#filesMediaPreview = stagedMedia;
      this.#filesPdfPreview = stagedPdf;
      this.#filesModelPreview = stagedModel;
      stagedMedia = undefined;
      stagedPdf = undefined;
      stagedModel = undefined;
      this.#set({ files: { ...this.#state.files, preview } });
    } catch (error) {
      if (stagedMedia) await this.mediaPreviewFiles?.remove(stagedMedia).catch(() => undefined);
      if (stagedPdf) await this.pdfPreviewFiles?.remove(stagedPdf).catch(() => undefined);
      if (stagedModel) await this.modelPreviewFiles?.remove(stagedModel).catch(() => undefined);
      if (controller.signal.aborted || !this.#currentFiles(epoch, context.key)) return;
      this.#set({ files: { ...this.#state.files,
        preview: { ...base, kind: "error", reason: message(error) } } });
    } finally {
      if (this.#filesPreviewAbort === controller) this.#filesPreviewAbort = undefined;
      signal?.removeEventListener("abort", abort);
    }
  }

  closeFilesPreview(): void {
    this.#retireFilesPreviewPager();
    this.#filesPreviewAbort?.abort();
    this.#filesPreviewAbort = undefined;
    void this.#releaseFilesBinaryPreviews().catch(() => undefined);
    if (this.#state.files.open) this.#set({ files: { ...this.#state.files, preview: undefined, previewPager: undefined } });
  }

  async #previewExtensionCardMedia(sessionId: string, cardId: string, uri: string, current: () => void): Promise<void> {
    const credential = this.#ready(), taskAuthorityKey = this.#taskAuthorityKey(), source = this.network.extensionCardApi?.(credential);
    const card = this.#extensionCardSource(this.#state, cardId);
    if (!source || !taskAuthorityKey || !card || !/^joko-media:\/\/blobs\/[a-f0-9]{64}\.(png|jpg|jpeg|gif|webp|glb)$/u.test(uri)) throw new Error("Extension media unavailable.");
    this.#cancelTimelinePreviewLease(); const controller = new AbortController();
    const lease: MobileTimelinePreviewLease = { controller, profileId: credential.profileId, sessionId, taskAuthorityKey,
      windowKey: mobileTimelinePreviewWindowKey(this.#timelineEvents()), extensionCard: { id: cardId, html: card.html, uri } };
    this.#timelinePreview = lease;
    const base = { title: card.extensionName, sourceLabel: card.extensionName, revisionKey: `${cardId}:${uri}`, mediaType: "application/octet-stream", byteSize: 0n };
    this.#set({ timelinePreview: { ...base, kind: "loading" } });
    let model: MobileModelPreviewLease | undefined;
    try {
      const { blob } = await source.readMedia({ sessionId, cardId, uri, metadataOnly: true }, { signal: controller.signal }); current();
      if (!blob || blob.byteSize > BigInt(MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES)) throw new Error("Extension media exceeds the mobile preview limit.");
      const download = await this.network.downloadBlob(credential, blob, controller.signal); current(); controller.signal.throwIfAborted();
      if (normalizeMediaType(download.mediaType) !== blob.mediaType || BigInt(download.bytes.length) !== blob.byteSize || bytesToHex(sha256(download.bytes)) !== blob.sha256Hex) throw new Error("Extension media changed.");
      let preview: MobileFilePreview;
      const metadata = { ...base, fileName: blob.fileName, mediaType: blob.mediaType, byteSize: blob.byteSize };
      if (uri.endsWith(".glb")) {
        if (!this.modelPreviewFiles || blob.mediaType !== "model/gltf-binary") throw new Error("3D model preview unavailable.");
        model = await this.modelPreviewFiles.stage({ profileId: credential.profileId, leaseId: this.newId(), modelPath: blob.fileName,
          mediaType: blob.mediaType, expectedSha256Hex: blob.sha256Hex, bytes: download.bytes, signal: controller.signal });
        preview = { ...metadata, kind: "model", ...model };
      } else {
        const decoded = inspectMobileImageGalleryBytes(download.bytes, blob.mediaType);
        preview = { ...metadata, kind: "image", dataUri: mobileImageGalleryPreviewUri(download.bytes, decoded), altText: card.extensionName, widthPixels: decoded.width, heightPixels: decoded.height };
      }
      const checked = await source.readMedia({ sessionId, cardId, uri, metadataOnly: true }, { signal: controller.signal }); current();
      if (checked.blob?.blobId !== blob.blobId || checked.blob.sha256Hex !== blob.sha256Hex) throw new Error("Extension media changed.");
      if (!this.#timelinePreviewLeaseCurrent(lease)) { if (model) await this.modelPreviewFiles?.remove(model).catch(() => undefined); return; }
      lease.model = model; model = undefined; this.#set({ timelinePreview: preview });
    } catch (error) {
      if (model) await this.modelPreviewFiles?.remove(model).catch(() => undefined);
      if (this.#timelinePreviewLeaseCurrent(lease)) this.#set({ timelinePreview: { ...base, kind: "error", reason: message(error) } });
    }
  }
  async previewTimelineArtifact(selected: MobileTimelineArtifact): Promise<void> {
    const credential = this.#ready();
    const taskAuthorityKey = this.#taskAuthorityKey();
    const sessionId = this.#state.selectedId;
    const events = this.#timelineEvents();
    if (!isMobileTimelinePreviewArtifact(selected)) {
      throw new Error("This Timeline file does not have an in-app preview.");
    }
    const source = resolveMobileTimelinePreviewArtifact(events, selected);
    const generation = this.#taskGeneration();
    if (!taskAuthorityKey || !sessionId || !generation || !source
      || source.event.identity?.sessionId !== sessionId
      || source.event.cursor?.generation !== generation) {
      throw new Error("Select a verified file from the current task Timeline.");
    }
    this.#cancelTimelinePreviewLease();
    const controller = new AbortController();
    const lease: MobileTimelinePreviewLease = {
      controller,
      profileId: credential.profileId,
      sessionId,
      taskAuthorityKey,
      windowKey: mobileTimelinePreviewWindowKey(events),
      artifact: source.artifact
    };
    this.#timelinePreview = lease;
    const base = {
      title: source.artifact.title,
      fileName: source.blob.fileName,
      sourceLabel: "Timeline message file",
      mediaType: source.artifact.mediaType,
      byteSize: source.blob.byteSize,
      revisionKey: [source.artifact.artifactId, source.artifact.sourceKey].join(":")
    };
    this.#set({ timelinePreview: { ...base, kind: "loading" } });
    let stagedMedia: MobileMediaPreviewLease | undefined;
    let stagedPdf: MobilePdfPreviewLease | undefined;
    let stagedModel: MobileModelPreviewLease | undefined;
    try {
      const download = await this.network.downloadBlob(credential, source.blob, controller.signal);
      if (normalizeMediaType(download.mediaType) !== source.artifact.mediaType) {
        throw new Error("The downloaded media type did not match the canonical Timeline Blob.");
      }
      let preview: MobileFilePreview;
      if (source.artifact.previewKind === "text") {
        if (BigInt(download.bytes.byteLength) !== source.blob.byteSize || bytesToHex(sha256(download.bytes)) !== source.blob.sha256Hex) {
          throw new Error("The Timeline text bytes do not match their canonical Blob.");
        }
        const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(download.bytes);
        if (text.includes("\0")) throw new Error("The Timeline text file contains binary data.");
        preview = { ...base, kind: "text", text, languageId: "", startByte: 0n,
          endByte: source.blob.byteSize, totalLines: text === "" ? 0 : text.split(/\r?\n/gu).length, truncated: false };
      } else if (source.artifact.previewKind === "media") {
        if (!this.mediaPreviewFiles) throw new Error("Audio/video preview is unavailable on this mobile runtime.");
        stagedMedia = await this.mediaPreviewFiles.stage(
          credential.profileId,
          this.newId(),
          source.blob.fileName,
          source.artifact.mediaType,
          source.blob.sha256Hex,
          download.bytes,
          controller.signal
        );
        preview = { ...base, kind: "media", ...stagedMedia,
          ...(source.artifact.audioMetadata === undefined ? {} : { audioMetadata: source.artifact.audioMetadata }) };
      } else if (source.artifact.previewKind === "pdf") {
        if (!this.pdfPreviewFiles) throw new Error("PDF preview is unavailable on this mobile runtime.");
        stagedPdf = await this.pdfPreviewFiles.stage(
          credential.profileId,
          this.newId(),
          source.blob.fileName,
          source.artifact.mediaType,
          source.blob.sha256Hex,
          download.bytes,
          controller.signal
        );
        preview = { ...base, kind: "pdf", ...stagedPdf };
      } else {
        if (!this.modelPreviewFiles) throw new Error("3D model preview is unavailable on this mobile runtime.");
        stagedModel = await this.modelPreviewFiles.stage({
          profileId: credential.profileId,
          leaseId: this.newId(),
          modelPath: source.blob.fileName,
          mediaType: source.artifact.mediaType,
          expectedSha256Hex: source.blob.sha256Hex,
          bytes: download.bytes,
          signal: controller.signal
        });
        preview = { ...base, kind: "model", ...stagedModel };
      }
      if (!this.#timelinePreviewLeaseCurrent(lease)) {
        if (stagedMedia) await this.mediaPreviewFiles?.remove(stagedMedia).catch(() => undefined);
        if (stagedPdf) await this.pdfPreviewFiles?.remove(stagedPdf).catch(() => undefined);
        if (stagedModel) await this.modelPreviewFiles?.remove(stagedModel).catch(() => undefined);
        return;
      }
      lease.media = stagedMedia;
      lease.pdf = stagedPdf;
      lease.model = stagedModel;
      stagedMedia = undefined;
      stagedPdf = undefined;
      stagedModel = undefined;
      this.#set({ timelinePreview: preview });
    } catch (error) {
      if (stagedMedia) await this.mediaPreviewFiles?.remove(stagedMedia).catch(() => undefined);
      if (stagedPdf) await this.pdfPreviewFiles?.remove(stagedPdf).catch(() => undefined);
      if (stagedModel) await this.modelPreviewFiles?.remove(stagedModel).catch(() => undefined);
      if (!this.#timelinePreviewLeaseCurrent(lease)) return;
      this.#set({ timelinePreview: { ...base, kind: "error", reason: message(error) } });
    }
  }

  closeTimelinePreview(): void {
    this.#cancelTimelinePreviewLease();
    if (this.#state.timelinePreview) this.#set({ timelinePreview: undefined });
  }

  audioPreviewOwnerKey(preview: Extract<MobileFilePreview, { kind: "media" }>): string | undefined {
    if (preview.mediaKind !== "audio" || !preview.audioMetadata) return undefined;
    const timeline = this.#timelinePreview;
    if (this.#state.timelinePreview === preview && timeline && this.#timelinePreviewLeaseCurrent(timeline)) {
      return JSON.stringify(["timeline-audio", timeline.taskAuthorityKey, preview.leaseId,
        preview.revisionKey, mobileAudioMetadataSourceKey(preview.audioMetadata)]);
    }
    const owner = this.filesAuthorityKey();
    return owner && this.#state.files.open && this.#state.files.status === "ready" && this.#state.files.preview === preview
      && this.#filesMediaPreview?.leaseId === preview.leaseId && !this.#imageGallery
      ? JSON.stringify(["files-audio", owner, this.#filesEpoch, preview.leaseId,
        preview.revisionKey, mobileAudioMetadataSourceKey(preview.audioMetadata)]) : undefined;
  }

  prepareAudioDescriptionCopy(preview: Extract<MobileFilePreview, { kind: "media" }>): MobileFilesClipboardLease {
    const ownerKey = this.audioPreviewOwnerKey(preview);
    const text = preview.audioMetadata?.description;
    if (!ownerKey || !text?.trim() || preview.audioMetadata?.kind === "sound_effect") {
      throw new Error("The audio description has no current source.");
    }
    return { kind: "source", text, assertCurrent: (signal) => {
      signal?.throwIfAborted();
      if (this.audioPreviewOwnerKey(preview) !== ownerKey) throw new Error("The audio description source changed.");
    } };
  }

  async readAudioArtwork(preview: Extract<MobileFilePreview, { kind: "media" }>, signal: AbortSignal): Promise<{
    readonly uri: string; readonly width: number; readonly height: number;
  }> {
    const credential = this.#ready(); const ownerKey = this.audioPreviewOwnerKey(preview);
    const artwork = preview.audioMetadata?.artwork;
    if (!ownerKey || !artwork || preview.audioMetadata?.kind === "sound_effect") {
      throw new Error("The audio artwork has no current canonical source.");
    }
    const assertCurrent = (): void => {
      signal.throwIfAborted();
      if (this.#credential !== credential || this.audioPreviewOwnerKey(preview) !== ownerKey) {
        throw new Error("The audio artwork source changed.");
      }
    };
    assertCurrent();
    if (artwork.blob.byteSize > BigInt(MOBILE_FILES_IMAGE_MAXIMUM_BYTES)
      || !mobileImageGalleryMediaType(artwork.blob.mediaType)) throw new Error("The audio artwork cannot be previewed.");
    const download = await this.network.downloadBlob(credential, artwork.blob, signal);
    assertCurrent();
    if (normalizeMediaType(download.mediaType) !== normalizeMediaType(artwork.blob.mediaType)
      || BigInt(download.bytes.byteLength) !== artwork.blob.byteSize
      || bytesToHex(sha256(download.bytes)) !== artwork.blob.sha256Hex) throw new Error("The audio artwork bytes changed.");
    const decoded = inspectMobileImageGalleryBytes(download.bytes, artwork.blob.mediaType);
    if (decoded.width !== artwork.width || decoded.height !== artwork.height) throw new Error("The audio artwork canvas changed.");
    assertCurrent();
    return { uri: mobileImageGalleryPreviewUri(download.bytes, decoded), width: decoded.width, height: decoded.height };
  }

  async shareFilesItem(
    source: MobileFilesComposerSource,
    onProgress?: (progress: MobileFileShareProgress) => void,
    signal?: AbortSignal
  ): Promise<void> {
    signal?.throwIfAborted();
    if (!this.fileShare) throw new Error("System file sharing is unavailable on this mobile runtime.");
    if (this.#fileShareLease) throw new Error("Another file-sharing action is already in progress.");
    const context = this.#filesContext();
    const filesEpoch = this.#filesEpoch;
    const taskAuthorityKey = this.#taskAuthorityKey();
    if (!taskAuthorityKey || !this.#state.files.open
      || this.#state.files.authorityKey !== context.key
      || !filesComposerSourceIsCurrent(this.#state.files, source)) {
      throw new Error("Select a current file from Files before sharing it.");
    }
    const controller = new AbortController();
    const operationSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const lease: MobileFileShareLease = {
      kind: "files",
      controller,
      profileId: context.credential.profileId,
      sessionId: context.authority.sessionId,
      taskAuthorityKey,
      phase: "preparing",
      filesEpoch,
      filesAuthorityKey: context.key,
      source
    };
    this.#fileShareLease = lease;
    try {
      const artifact = filesComposerArtifact(source);
      let blob: BlobRef;
      let assertRemoteCurrent: () => Promise<void>;
      if (artifact) {
        const observedRevision = this.#state.files.artifactsRevision;
        if (!observedRevision) throw new Error("The current Generated catalog is not revision-fenced.");
        const current = await this.#revalidateGeneratedShareArtifact(
          context, artifact, observedRevision, operationSignal
        );
        blob = current.blob!;
        assertRemoteCurrent = async () => {
          const refreshed = await this.#revalidateGeneratedShareArtifact(
            context, current, observedRevision, operationSignal
          );
          if (!sameFilesComposerArtifact(refreshed, current)) {
            throw new Error("The selected Generated file changed before system sharing began.");
          }
        };
      } else {
        const current = await this.#revalidateWorkspaceShareEntry(context, source, operationSignal);
        const revision = current.revision!;
        const materialized = await this.network.materializeWorkspaceFileBlob(
          context.credential,
          context.authority.workspace.workspaceId,
          current.relativePath,
          revision,
          operationSignal
        );
        if (materialized.entry.workspaceId !== current.workspaceId
          || materialized.entry.relativePath !== current.relativePath
          || materialized.entry.kind !== FileKind.REGULAR
          || (normalizeMediaType(materialized.entry.mediaType) || "application/octet-stream")
            !== (normalizeMediaType(current.mediaType) || "application/octet-stream")
          || !materialized.entry.revision
          || !workspaceComposerRevisionMatches(revision, materialized.entry.revision)) {
          throw new Error("The Workspace file changed while its complete Blob was materialized.");
        }
        blob = materialized.blob;
        assertRemoteCurrent = async () => {
          const refreshed = await this.#revalidateWorkspaceShareEntry(context, source, operationSignal);
          if (!sameFilesWorkspaceEntry(refreshed, current)) {
            throw new Error("The selected Workspace file changed before system sharing began.");
          }
        };
      }
      this.#assertFileShareLeaseCurrent(lease, operationSignal);
      const authorized = await this.network.authorizeBlobDownload(context.credential, blob, operationSignal);
      this.#assertFileShareLeaseCurrent(lease, operationSignal);
      await this.fileShare.perform({
        source: authorized,
        signal: operationSignal,
        onProgress,
        assertCurrent: async () => {
          this.#assertFileShareLeaseCurrent(lease, operationSignal);
          await assertRemoteCurrent();
          this.#assertFileShareLeaseCurrent(lease, operationSignal);
        },
        onDispatch: () => { lease.phase = "dispatching"; }
      });
    } finally {
      if (this.#fileShareLease === lease) this.#fileShareLease = undefined;
    }
  }

  async shareTimelineArtifact(
    selected: MobileTimelineArtifact,
    onProgress?: (progress: MobileFileShareProgress) => void,
    signal?: AbortSignal
  ): Promise<void> {
    signal?.throwIfAborted();
    if (!this.fileShare) throw new Error("System file sharing is unavailable on this mobile runtime.");
    if (this.#fileShareLease) throw new Error("Another file-sharing action is already in progress.");
    const credential = this.#ready();
    const taskAuthorityKey = this.#taskAuthorityKey();
    const sessionId = this.#state.selectedId;
    const events = this.#timelineEvents();
    const source = resolveMobileTimelineArtifact(events, selected);
    const generation = this.#taskGeneration();
    if (!taskAuthorityKey || !sessionId || !generation || !source
      || source.event.identity?.sessionId !== sessionId
      || source.event.cursor?.generation !== generation) {
      throw new Error("Select a verified file from the current task Timeline.");
    }
    const controller = new AbortController();
    const operationSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const lease: MobileFileShareLease = {
      kind: "timeline",
      controller,
      profileId: credential.profileId,
      sessionId,
      taskAuthorityKey,
      phase: "preparing",
      windowKey: mobileTimelineArtifactWindowKey(events),
      artifact: source.artifact
    };
    this.#fileShareLease = lease;
    try {
      await this.#revalidateTimelineShareArtifact(credential, lease, source.blob, operationSignal);
      this.#assertFileShareLeaseCurrent(lease, operationSignal);
      const authorized = await this.network.authorizeBlobDownload(credential, source.blob, operationSignal);
      this.#assertFileShareLeaseCurrent(lease, operationSignal);
      await this.fileShare.perform({
        source: authorized,
        signal: operationSignal,
        onProgress,
        assertCurrent: async () => {
          this.#assertFileShareLeaseCurrent(lease, operationSignal);
          await this.#revalidateTimelineShareArtifact(credential, lease, source.blob, operationSignal);
          this.#assertFileShareLeaseCurrent(lease, operationSignal);
        },
        onDispatch: () => { lease.phase = "dispatching"; }
      });
    } finally {
      if (this.#fileShareLease === lease) this.#fileShareLease = undefined;
    }
  }

  async prepareFileTextSourceCopy(preview: Extract<MobileFilePreview, { kind: "text" }>, signal: AbortSignal): Promise<MobileFilesClipboardLease> {
    const source = this.#fileTextActionSource(preview);
    source.assertCurrent(signal);
    await this.#readFilesPager(() => source.revalidate(signal), signal);
    source.assertCurrent(signal);
    return { kind: "source", text: mobileFileTextSource(preview.text).text, assertCurrent: (effectSignal) => { signal.throwIfAborted(); source.assertCurrent(effectSignal); } };
  }

  async addFileTextQuoteToComposer(preview: Extract<MobileFilePreview, { kind: "text" }>, selectedText: string, signal: AbortSignal): Promise<void> {
    if (!this.composerDrafts) throw new Error("Retained task drafts are unavailable on this mobile client.");
    const source = this.#fileTextActionSource(preview);
    const identity = { profileId: this.#ready().profileId, sessionId: this.#state.selectedId! };
    const snapshot = await this.composerDrafts.readSnapshot(identity);
    source.assertCurrent(signal);
    const next = appendMobileFileSelectionQuote(snapshot.draft ?? emptyMobileComposerDraft(), {
      sourceSessionId: identity.sessionId, sourcePath: source.path, text: selectedText
    }, this.newId()).draft;
    await this.#readFilesPager(() => source.revalidate(signal), signal);
    source.assertCurrent(signal);
    if (!this.composerDrafts.saveIfRevision(identity, next, snapshot.revision)) throw new Error("The task composer changed. The original draft was retained.");
    try {
      await this.composerDrafts.flush(identity);
      source.assertCurrent(signal);
    } catch (error) { await this.#restoreFilesComposerDraft(identity, snapshot, next); throw error; }
  }

  #fileTextActionSource(preview: Extract<MobileFilePreview, { kind: "text" }>): {
    readonly path: string; assertCurrent(signal?: AbortSignal): void; revalidate(signal: AbortSignal): Promise<void>
  } {
    const credential = this.#ready(); const task = this.#taskAuthorityKey();
    const owner = this.filesHtmlResourceOwnerKey(preview);
    const timeline = this.#state.timelinePreview === preview ? this.#timelinePreview : undefined;
    const pager = timeline ? undefined : this.#filesPreviewPager;
    const page = pager?.descriptor.pages[pager.descriptor.index];
    const windowKey = timeline ? undefined : mobileFilesGalleryWindowKey(this.#state.files);
    const entry = preview.workspaceEntry;
    const path = canonicalWorkspacePath(entry?.relativePath ?? preview.fileName ?? "");
    if (!task || !owner || !path || entry && (!entry.revision || workspaceEntryRevisionKey(entry.revision) !== preview.revisionKey)) {
      throw new Error("The file text has no current canonical source.");
    }
    const assertCurrent = (signal?: AbortSignal): void => {
      signal?.throwIfAborted();
      if (this.#disposed || this.#credential !== credential || this.#taskAuthorityKey() !== task || this.filesHtmlResourceOwnerKey(preview) !== owner
        || pager && (this.#filesPreviewPager !== pager || !this.#filesPreviewPagerCurrent(pager) || pager.descriptor.pages[pager.descriptor.index] !== page)
        || !timeline && mobileFilesGalleryWindowKey(this.#state.files) !== windowKey) throw new Error("The file text source changed.");
    };
    assertCurrent();
    const revalidate = async (signal: AbortSignal): Promise<void> => {
      assertCurrent(signal);
      if (timeline?.artifact) {
        const around = await this.network.readAround(credential, timeline.sessionId, timeline.artifact.eventId, signal);
        assertCurrent(signal);
        const current = resolveMobileTimelinePreviewArtifact(around, timeline.artifact);
        if (!current || current.event.identity?.sessionId !== timeline.sessionId || current.event.cursor?.generation !== this.#taskGeneration()
          || !sameMobileTimelinePreviewArtifact(current.artifact, timeline.artifact)) throw new Error("The canonical Timeline text file changed.");
      } else if (entry) {
        const context = this.#filesContext();
        const directory = await this.network.listWorkspaceDirectory(credential, entry.workspaceId, workspaceParentPath(entry.relativePath), signal);
        assertCurrent(signal);
        const matches = directory.entries.filter((item) => item.relativePath === entry.relativePath); const current = matches.length === 1 ? matches[0] : undefined;
        if (!directory.revision || pager?.window.kind === "workspace" && directory.revision !== pager.window.revision
          || !current?.revision || current.kind !== FileKind.REGULAR || current.workspaceId !== context.authority.workspace.workspaceId
          || normalizeMediaType(current.mediaType) !== normalizeMediaType(preview.mediaType)
          || !workspaceComposerRevisionMatches(current.revision, entry.revision!)) throw new Error("The canonical Workspace text file changed.");
        const read = await this.network.readWorkspaceFile(credential, entry.workspaceId, entry.relativePath, entry.revision!, signal);
        assertCurrent(signal);
        assertWorkspaceFilePreview(entry.workspaceId, entry.relativePath, entry.revision!, read);
        if (!read.entry?.revision || workspaceEntryRevisionKey(read.entry.revision) !== preview.revisionKey || read.entry.relativePath !== path
          || read.entry.workspaceId !== entry.workspaceId || read.entry.kind !== FileKind.REGULAR || read.content.case !== "text"
          || read.content.value.utf8Text !== preview.text || read.content.value.startByte !== preview.startByte || read.content.value.endByte !== preview.endByte
          || read.truncated !== preview.truncated) throw new Error("The canonical Workspace text bytes changed.");
      } else {
        const catalog = await this.network.listSessionArtifacts(credential, this.#state.selectedId!, signal);
        assertCurrent(signal);
        const candidates = catalog.artifacts.filter((item) => item.blob && item.sessionId === this.#state.selectedId
          && [item.artifactId, item.blob.blobId, item.blob.sha256Hex, item.blob.byteSize.toString(10)].join(":") === preview.revisionKey);
        const artifact = candidates.length === 1 ? candidates[0] : undefined;
        if (!catalog.revision || pager?.window.kind === "generated" && catalog.revision !== pager.window.revision || !artifact?.blob
          || artifact.blob.fileName !== path || artifact.blob.byteSize !== preview.byteSize || normalizeMediaType(artifact.blob.mediaType) !== normalizeMediaType(preview.mediaType)
          || page?.kind === "artifact" && !sameFilesComposerArtifact(page.artifact, artifact)) throw new Error("The canonical Generated text file changed.");
      }
      assertCurrent(signal);
    };
    return { path, assertCurrent, revalidate };
  }

  async addFilesItemToComposer(
    source: MobileFilesComposerSource,
    signal?: AbortSignal
  ): Promise<MobileFilesComposerResult> {
    signal?.throwIfAborted();
    if (!this.composerDrafts) throw new Error("Retained task drafts are unavailable on this mobile client.");
    const context = this.#filesContext();
    const epoch = this.#filesEpoch;
    const taskAuthorityKey = this.#taskAuthorityKey();
    if (!taskAuthorityKey || !this.#state.files.open || this.#state.files.authorityKey !== context.key) {
      throw new Error("Open Files for the current task before adding an item to its composer.");
    }
    const identity: MobileComposerDraftIdentity = {
      profileId: context.credential.profileId,
      sessionId: context.authority.sessionId
    };
    const attachmentControls = this.taskAttachmentControls();
    const workspaceControls = this.taskWorkspaceMentionControls();
    const catalogControls = this.taskCatalogMentionControls();
    const attachmentOwnerKey = attachmentControls?.surfaceOwnerKey;
    const workspaceOwnerKey = workspaceControls?.surfaceOwnerKey;
    const catalogOwnerKey = catalogControls?.surfaceOwnerKey;
    this.#assertFilesComposerLease(
      context, epoch, taskAuthorityKey, identity, source,
      attachmentOwnerKey, workspaceOwnerKey, catalogOwnerKey, signal
    );
    const snapshot = await this.composerDrafts.readSnapshot(identity);
    const draft = normalizeMobileComposerDraft(snapshot.draft ?? {
      text: "", mentions: [], atoms: [], slashCommands: [], attachments: []
    });
    this.#assertFilesComposerLease(
      context, epoch, taskAuthorityKey, identity, source,
      attachmentOwnerKey, workspaceOwnerKey, catalogOwnerKey, signal
    );

    let staged: MobileLocalComposerAttachment | undefined;
    let nextDraft: MobileComposerDraft;
    let result: MobileFilesComposerResult;
    let committed = false;
    try {
      const artifact = filesComposerArtifact(source);
      if (artifact) {
        const planned = await this.#artifactFilesComposerDraft(
          context,
          epoch,
          taskAuthorityKey,
          identity,
          source,
          artifact,
          draft,
          attachmentControls,
          workspaceOwnerKey,
          catalogControls,
          signal
        );
        nextDraft = planned.draft;
        staged = planned.staged;
        result = planned.result;
      } else {
        const planned = await this.#workspaceFilesComposerDraft(
          context,
          epoch,
          taskAuthorityKey,
          identity,
          source,
          draft,
          attachmentControls,
          workspaceControls,
          catalogOwnerKey,
          signal
        );
        nextDraft = planned.draft;
        staged = planned.staged;
        result = planned.result;
      }
      this.#assertFilesComposerLease(
        context, epoch, taskAuthorityKey, identity, source,
        attachmentOwnerKey, workspaceOwnerKey, catalogOwnerKey, signal
      );
      if (!this.composerDrafts.saveIfRevision(identity, nextDraft, snapshot.revision)) {
        throw new Error("The task composer changed while the file was being added. The original draft was retained.");
      }
      committed = true;
      await this.composerDrafts.flush(identity);
      this.#assertFilesComposerLease(
        context, epoch, taskAuthorityKey, identity, source,
        attachmentOwnerKey, workspaceOwnerKey, catalogOwnerKey, signal
      );
      staged = undefined;
      return result;
    } catch (error) {
      if (committed) {
        const restored = await this.#restoreFilesComposerDraft(identity, snapshot, nextDraft!);
        if (restored) committed = false;
      }
      if (staged && !committed && this.attachmentFiles) {
        await this.attachmentFiles.remove(identity.profileId, staged).catch(() => undefined);
      }
      throw error;
    }
  }

  async openFilesImageGallery(
    source: MobileFilesComposerSource,
    signal?: AbortSignal,
    sort: MobileFilesSortMode = "name"
  ): Promise<MobileImageGalleryDescriptor> {
    signal?.throwIfAborted();
    if (!this.composerDrafts) throw new Error("Retained task drafts are unavailable on this mobile client.");
    this.#retireImageGallery();
    const credential = this.#ready();
    const context = this.#filesContext();
    const filesEpoch = this.#filesEpoch;
    const taskAuthorityKey = this.#taskAuthorityKey();
    const attachmentOwnerKey = this.taskAttachmentControls()?.surfaceOwnerKey;
    const filesWindowKey = mobileFilesGalleryWindowKey(this.#state.files);
    if (!taskAuthorityKey || !filesComposerSourceIsCurrent(this.#state.files, source)) {
      throw new Error("Select a current Files image before opening its gallery.");
    }
    const identity = { profileId: credential.profileId, sessionId: context.authority.sessionId };
    const assertCurrent = (): void => this.#assertFilesGalleryOpenCurrent(
      context,
      filesEpoch,
      taskAuthorityKey,
      identity,
      source,
      attachmentOwnerKey,
      filesWindowKey,
      signal
    );
    assertCurrent();

    const artifact = filesComposerArtifact(source);
    let pages: readonly MobileImageGalleryPage[];
    let sourceLabel: string;
    if (artifact) {
      const observedRevision = this.#state.files.artifactsRevision;
      if (!observedRevision) throw new Error("The current Generated image catalog is not revision-fenced.");
      const refreshed = await this.network.listSessionArtifacts(
        context.credential,
        context.authority.sessionId,
        signal
      );
      assertCurrent();
      if (refreshed.revision !== observedRevision) {
        throw new Error("The Generated image catalog changed while the gallery was opening.");
      }
      const currentArtifactCounts = countArtifactIds(refreshed.artifacts);
      const observedArtifactCounts = countArtifactIds(this.#state.files.artifacts);
      const currentById = new Map(refreshed.artifacts.map((candidate) => [candidate.artifactId, candidate]));
      const seen = new Set<string>();
      pages = sortMobileGeneratedArtifacts(this.#state.files.artifacts, sort).flatMap((observed) => {
        if (currentArtifactCounts.get(observed.artifactId) !== 1
          || observedArtifactCounts.get(observed.artifactId) !== 1) return [];
        const current = currentById.get(observed.artifactId);
        if (!current || !sameFilesComposerArtifact(current, observed) || current.sessionId !== context.authority.sessionId) return [];
        const page = mobileImageGalleryPage({
          pageId: `artifact:${current.sessionId}:${current.artifactId}:${current.blob?.blobId ?? ""}`,
          title: artifactTitle(current),
          blob: current.blob,
          source: { kind: "artifact", artifactId: current.artifactId, sessionId: current.sessionId }
        });
        if (!page) return [];
        const duplicateKey = `${page.blob.blobId}\u001f${page.sha256Hex}`;
        if (seen.has(duplicateKey)) return [];
        seen.add(duplicateKey);
        return [page];
      });
      sourceLabel = "Generated";
    } else {
      const selected = await this.#resolveFilesComposerWorkspaceEntry(context, source, signal);
      assertCurrent();
      if (selected.kind !== FileKind.REGULAR || !selected.revision) {
        throw new Error("Only a current Workspace image can open the image gallery.");
      }
      const observedEntries = source.kind === "workspace-entry"
        && this.#state.files.location.kind === "workspace"
        ? sortMobileWorkspaceEntries(this.#state.files.entries, sort)
        : [selected];
      const collected: MobileImageGalleryPage[] = [];
      const seen = new Set<string>();
      for (const entry of observedEntries) {
        signal?.throwIfAborted();
        if (entry.kind !== FileKind.REGULAR || !entry.revision || !mobileImageGalleryMediaType(entry.mediaType)) continue;
        let page: MobileImageGalleryPage | undefined;
        try {
          const rawPreview = await this.network.readWorkspaceFile(
            context.credential,
            context.authority.workspace.workspaceId,
            entry.relativePath,
            entry.revision,
            signal
          );
          assertCurrent();
          const preview = await this.#canonicalWorkspaceImagePreview(context.credential, entry.workspaceId, rawPreview, signal);
          assertCurrent();
          if (!preview.truncated && preview.content.case === "image") {
            const blob = workspaceComposerBlob(context.authority.workspace.workspaceId, entry, preview);
            page = mobileImageGalleryPage({
              pageId: `workspace:${entry.workspaceId}:${entry.relativePath}:${workspaceEntryRevisionKey(entry.revision)}:${blob?.blobId ?? ""}`,
              title: entry.displayName || workspaceBasename(entry.relativePath),
              blob,
              ...(preview.content.value.widthPixels === 0 && preview.content.value.heightPixels === 0 ? {} : {
                widthPixels: preview.content.value.widthPixels, heightPixels: preview.content.value.heightPixels, requireDimensions: true
              }),
              source: {
                kind: "workspace",
                relativePath: entry.relativePath,
                revisionKey: workspaceEntryRevisionKey(entry.revision)
              }
            });
          }
        } catch (error) {
          assertCurrent();
          if (signal?.aborted || sameFilesWorkspaceEntry(entry, selected)) throw error;
        }
        if (!page) {
          if (sameFilesWorkspaceEntry(entry, selected)) {
            throw new Error("The selected Workspace file is not a canonical gallery image.");
          }
          continue;
        }
        const duplicateKey = `${page.blob.blobId}\u001f${page.sha256Hex}`;
        if (seen.has(duplicateKey)) continue;
        seen.add(duplicateKey);
        collected.push(page);
      }
      pages = collected;
      sourceLabel = this.#state.files.location.kind === "workspace"
        ? this.#state.files.location.path || context.authority.workspace.displayName || "Workspace"
        : "Workspace";
    }
    assertCurrent();
    const initialIndex = pages.findIndex((page) => mobileGalleryPageMatchesFilesSource(page, source));
    if (initialIndex < 0 || pages.length === 0) {
      throw new Error("The selected file is not available in this canonical image gallery.");
    }
    const snapshot = await this.composerDrafts.readSnapshot(identity);
    const draft = normalizeMobileComposerDraft(snapshot.draft ?? {
      text: "", mentions: [], atoms: [], slashCommands: [], attachments: []
    });
    assertCurrent();
    const leaseId = distinctAttachmentStorageId(this.newId, ...mobileComposerAttachmentStorageIds(draft.attachments));
    const descriptor: MobileImageGalleryDescriptor = {
      leaseId,
      sourceKind: artifact ? "generated" : "workspace",
      sourceLabel,
      pages: pages.map(mobileImageGalleryPageSummary),
      initialIndex
    };
    const lease: MobileImageGalleryLease = {
      leaseId,
      profileId: credential.profileId,
      credentialKey: mobileCredentialKey(credential),
      taskAuthorityKey,
      ...(attachmentOwnerKey === undefined ? {} : { attachmentOwnerKey }),
      identity,
      snapshot,
      draft,
      descriptor,
      pages,
      source: { kind: "files", filesEpoch, filesAuthorityKey: context.key, filesWindowKey },
      operationInFlight: false
    };
    this.#imageGallery = lease;
    try {
      await this.#assertImageGalleryCurrent(lease, undefined, signal);
      return descriptor;
    } catch (error) {
      if (this.#imageGallery === lease) this.#retireImageGallery();
      throw error;
    }
  }

  conversationShareOwnerKey(): string | undefined {
    if (!this.#taskAuthorityKey()) return undefined;
    const credential = this.#credential!;
    const owner = this.#state.owner!;
    const session = this.#selectedSession()!;
    const target = owner.targets.find((item) => item.targetId === session.targetId)!;
    return [credential.profileId, credential.connectionId, credential.deviceId, credential.serverId,
      owner.generation.toString(10), session.sessionId, session.backendId, session.targetId,
      session.nativeBinding!.runtimeGeneration.toString(10), entityVersionKey(target.version),
      backendAuthorityKey(this.#selectedBackend(session)!)].join("\u001f");
  }

  markdownResourceOwnerKey(): string | undefined {
    const owner = this.conversationShareOwnerKey();
    const authority = resolveMobileWorkspaceAuthority(this.#state.owner, this.#state.detail, this.#state.selectedId);
    if (!owner || !authority || !this.taskWorkspacePathPasteControls()) return undefined;
    const workspace = authority.workspace;
    return [owner, workspace.workspaceId, workspace.serverPathDisplay, entityVersionKey(workspace.version)].join("\u001f");
  }

  async prepareMarkdownResources(messageId: string, text: string, signal: AbortSignal): Promise<MobileMarkdownResourceDescriptor> {
    return this.#markdownResources.prepare(this.newId(), text, this.#markdownResourceContext(messageId, text), signal);
  }

  async openQuestionReference(interactionId: string, href: string, signal: AbortSignal): Promise<
    { readonly kind: "external"; readonly url: string } | { readonly kind: "workspace"; readonly source?: MobileFilesComposerSource }
  > {
    signal.throwIfAborted();
    const question = clone(InteractionSchema, this.#interactionContext(interactionId));
    if (question.request.case !== "question") throw new Error("The question is no longer current.");
    const request = question.request.value;
    const texts = [request.prompt, ...request.fields.flatMap(field => [field.label, field.description,
      ...(field.input.case === "singleChoice" || field.input.case === "multipleChoice"
        ? field.input.value.choices.flatMap(choice => [choice.label, choice.description]) : [])])];
    if (!texts.some(text => splitQuestionReferences(text, (raw, prefix) => clipBareHttpAutolinkText(raw, { prefix })).some(part => part.href === href))) {
      throw new Error("The reference does not belong to the current question.");
    }
    if (/^https?:\/\//iu.test(href)) return { kind: "external", url: href };
    const files = this.#filesContext(), credential = this.#ready(), ownerKey = this.markdownResourceOwnerKey();
    if (!ownerKey) throw new Error("The question has no current Workspace authority.");
    const assertCurrent = (currentSignal?: AbortSignal): void => {
      currentSignal?.throwIfAborted();
      if (this.#disposed || this.#credential !== credential || this.markdownResourceOwnerKey() !== ownerKey
        || !equals(InteractionSchema, this.#interactionContext(interactionId), question)) throw new Error("The question or its Workspace changed.");
    };
    const revalidateSource = async (currentSignal: AbortSignal): Promise<void> => {
      assertCurrent(currentSignal);
      const snapshot = await this.network.readSession(credential, question.sessionId, currentSignal);
      assertCurrent(currentSignal);
      const fresh = pendingMobileInteractions(snapshot, question.sessionId).filter(item => item.interactionId === interactionId);
      const session = snapshot.sessions.find(item => item.sessionId === question.sessionId);
      if (snapshot.server?.serverId !== credential.serverId || snapshot.generation !== this.#taskGeneration()
        || session?.nativeBinding?.runtimeGeneration !== this.#selectedSession()?.nativeBinding?.runtimeGeneration
        || !session || session.backendId !== question.backendId || session.targetId !== question.targetId
        || fresh.length !== 1 || !equals(InteractionSchema, fresh[0]!, question)) throw new Error("The question changed before its reference opened.");
    };
    const context: MobileMarkdownResourceContext = {
      workspaceId: files.authority.workspace.workspaceId, workdir: files.authority.workspace.serverPathDisplay,
      assertCurrent, revalidateSource,
      listDirectory: (parent, currentSignal) => this.network.listWorkspaceDirectory(credential, files.authority.workspace.workspaceId, parent, currentSignal),
      readFile: async (entry, currentSignal) => this.#canonicalWorkspaceImagePreview(credential, files.authority.workspace.workspaceId,
        await this.network.readWorkspaceFile(credential, files.authority.workspace.workspaceId, entry.relativePath, entry.revision!, currentSignal), currentSignal),
      download: (blob, currentSignal) => this.network.downloadBlob(credential, blob, currentSignal)
    };
    assertCurrent(signal);
    const prepared = await this.#markdownResources.prepare(this.newId(), `[reference](<${href}>)`, context, signal);
    try { return { kind: "workspace", source: await this.openMarkdownPath(prepared.leaseId, JSON.stringify(["link", href]), signal) }; }
    finally { this.#markdownResources.release(prepared.leaseId); }
  }

  filesMarkdownResourceOwnerKey(preview: Extract<MobileFilePreview, { kind: "text" }>): string | undefined {
    const owner = this.filesAuthorityKey();
    return owner && this.#state.files.open && this.#state.files.status === "ready" && this.#state.files.preview === preview
      && preview.workspaceEntry && !this.#imageGallery ? JSON.stringify([owner, this.#filesEpoch, preview.sourceLabel, preview.revisionKey]) : undefined;
  }

  async prepareFilesMarkdownResources(preview: Extract<MobileFilePreview, { kind: "text" }>, signal: AbortSignal): Promise<MobileMarkdownResourceDescriptor> {
    const files = this.#filesContext(); const credential = this.#ready();
    const ownerKey = this.filesMarkdownResourceOwnerKey(preview); const entry = preview.workspaceEntry;
    if (!ownerKey || !entry?.revision || entry.kind !== FileKind.REGULAR || entry.workspaceId !== files.authority.workspace.workspaceId
      || entry.relativePath !== preview.sourceLabel || workspaceEntryRevisionKey(entry.revision) !== preview.revisionKey) {
      throw new Error("The file Markdown has no current Workspace source.");
    }
    const assertCurrent = (currentSignal?: AbortSignal): void => {
      currentSignal?.throwIfAborted();
      if (this.#disposed || this.#credential !== credential || this.filesMarkdownResourceOwnerKey(preview) !== ownerKey) {
        throw new Error("The file Markdown source changed.");
      }
    };
    const revalidateSource = async (currentSignal: AbortSignal): Promise<void> => {
      assertCurrent(currentSignal);
      const directory = await this.network.listWorkspaceDirectory(credential, entry.workspaceId, workspaceParentPath(entry.relativePath), currentSignal);
      assertCurrent(currentSignal);
      const matches = directory.entries.filter((current) => current.relativePath === entry.relativePath);
      const fresh = matches.length === 1 ? matches[0] : undefined;
      if (!directory.revision || !fresh?.revision || fresh.kind !== FileKind.REGULAR || fresh.workspaceId !== entry.workspaceId
        || normalizeMediaType(fresh.mediaType) !== normalizeMediaType(entry.mediaType) || fresh.revision.byteSize !== entry.revision!.byteSize
        || !workspaceComposerRevisionMatches(fresh.revision, entry.revision!)) throw new Error("The authenticated Markdown file changed.");
    };
    const context: MobileMarkdownResourceContext = { workspaceId: entry.workspaceId, workdir: files.authority.workspace.serverPathDisplay,
      baseDirectory: workspaceParentPath(entry.relativePath), maximumSourceCharacters: 2_097_152, assertCurrent, revalidateSource,
      listDirectory: (parent, currentSignal) => this.network.listWorkspaceDirectory(credential, entry.workspaceId, parent, currentSignal),
      readFile: async (resource, currentSignal) => this.#canonicalWorkspaceImagePreview(credential, entry.workspaceId,
        await this.network.readWorkspaceFile(credential, entry.workspaceId, resource.relativePath, resource.revision!, currentSignal), currentSignal),
      download: (blob, currentSignal) => this.network.downloadBlob(credential, blob, currentSignal) };
    await revalidateSource(signal);
    const descriptor = await this.#markdownResources.prepare(this.newId(), mobileFileTextSource(preview.text).lines.join("\n"), context, signal);
    try { await revalidateSource(signal); assertCurrent(signal); return descriptor; }
    catch (error) { this.#markdownResources.release(descriptor.leaseId); throw error; }
  }

  assertMarkdownResourcesCurrent(leaseId: string): void { this.#markdownResources.assertCurrent(leaseId); }
  releaseMarkdownResources(leaseId: string): void { this.#markdownResources.release(leaseId); }

  filesHtmlResourceOwnerKey(preview: Extract<MobileFilePreview, { kind: "text" }>): string | undefined {
    const timeline = this.#timelinePreview;
    if (this.#state.timelinePreview === preview && timeline && this.#timelinePreviewLeaseCurrent(timeline)) {
      return JSON.stringify(["timeline", timeline.taskAuthorityKey, timeline.windowKey, preview.sourceLabel, preview.revisionKey]);
    }
    const owner = this.filesAuthorityKey();
    return owner && this.#state.files.open && this.#state.files.status === "ready" && this.#state.files.preview === preview
      && !this.#imageGallery ? JSON.stringify([owner, this.#filesEpoch, preview.sourceLabel, preview.revisionKey]) : undefined;
  }

  async prepareFilesHtmlResources(preview: Extract<MobileFilePreview, { kind: "text" }>, signal: AbortSignal): Promise<MobileFileHtmlDescriptor> {
    const credential = this.#ready(); const ownerKey = this.filesHtmlResourceOwnerKey(preview);
    if (!ownerKey || !mobileFileHtmlComplete(preview)) throw new Error("The HTML page has no current complete file source.");
    const assertCurrent = (currentSignal?: AbortSignal): void => {
      currentSignal?.throwIfAborted();
      if (this.#disposed || this.#credential !== credential || this.filesHtmlResourceOwnerKey(preview) !== ownerKey) {
        throw new Error("The HTML file source changed.");
      }
    };
    const entry = preview.workspaceEntry; let context: MobileFileHtmlContext = { assertCurrent };
    if (entry) {
      const files = this.#filesContext();
      if (!entry.revision || entry.kind !== FileKind.REGULAR || entry.workspaceId !== files.authority.workspace.workspaceId
        || entry.relativePath !== preview.sourceLabel || workspaceEntryRevisionKey(entry.revision) !== preview.revisionKey) {
        throw new Error("The HTML page has no canonical Workspace source.");
      }
      const revalidateEntry = async (currentSignal: AbortSignal): Promise<void> => {
        assertCurrent(currentSignal);
        const directory = await this.network.listWorkspaceDirectory(credential, entry.workspaceId, workspaceParentPath(entry.relativePath), currentSignal);
        assertCurrent(currentSignal);
        const matches = directory.entries.filter((candidate) => candidate.relativePath === entry.relativePath);
        const fresh = matches.length === 1 ? matches[0] : undefined;
        if (!directory.revision || !fresh?.revision || fresh.kind !== FileKind.REGULAR || fresh.workspaceId !== entry.workspaceId
          || normalizeMediaType(fresh.mediaType) !== normalizeMediaType(entry.mediaType) || fresh.revision.byteSize !== entry.revision!.byteSize
          || !workspaceComposerRevisionMatches(fresh.revision, entry.revision!)) throw new Error("The authenticated HTML file changed.");
      };
      let snapshotRevision = "";
      const revalidateSource = async (currentSignal: AbortSignal): Promise<void> => {
        await revalidateEntry(currentSignal);
        const snapshot = await this.network.readWorkspaceHtmlSnapshot(credential, files.authority.sessionId,
          { workspaceId: entry.workspaceId, relativePath: entry.relativePath, expectedRevision: snapshotRevision }, currentSignal);
        assertCurrent(currentSignal);
        if (snapshot.file.workspaceId !== entry.workspaceId || snapshot.file.relativePath !== entry.relativePath
          || !/^workspace-html:[0-9a-f]{64}$/u.test(snapshot.file.expectedRevision)
          || snapshotRevision !== "" && snapshot.file.expectedRevision !== snapshotRevision || snapshot.html !== preview.text) {
          throw new Error("The authenticated HTML snapshot changed.");
        }
        snapshotRevision = snapshot.file.expectedRevision;
      };
      context = { baseDirectory: workspaceParentPath(entry.relativePath), assertCurrent, revalidateSource,
        readResource: async (target, maximumBytes, currentSignal) => {
          await revalidateEntry(currentSignal);
          const path = canonicalWorkspacePath(target.relativePath); const parent = workspaceParentPath(path);
          const base = workspaceParentPath(entry.relativePath);
          if (base && !path.startsWith(base + "/")) throw new Error("The HTML resource left its parent directory.");
          const directory = await this.network.listWorkspaceDirectory(credential, entry.workspaceId, parent, currentSignal);
          assertCurrent(currentSignal);
          const matches = directory.entries.filter((candidate) => candidate.relativePath === path);
          const resource = matches.length === 1 ? matches[0] : undefined;
          if (!directory.revision || !resource?.revision || resource.kind !== FileKind.REGULAR || resource.workspaceId !== entry.workspaceId) {
            throw new Error("The HTML resource has no current canonical file.");
          }
          if (resource.revision.byteSize < 0n || resource.revision.byteSize > BigInt(maximumBytes)) {
            throw new HtmlResourceBudgetError("The HTML resource exceeded its byte budget.");
          }
          const materialized = await this.network.materializeWorkspaceFileBlob(credential, entry.workspaceId, path, resource.revision, currentSignal);
          assertCurrent(currentSignal);
          const blob = workspaceComposerBlob(entry.workspaceId, resource, { $typeName: "joko.v1.FilePreview", entry: materialized.entry,
            content: { case: "blob", value: materialized.blob }, truncated: false });
          if (!blob || blob.byteSize !== resource.revision.byteSize || blob.byteSize > BigInt(maximumBytes)) throw new Error("The HTML resource Blob changed.");
          const downloaded = await this.network.downloadBlob(credential, blob, currentSignal); assertCurrent(currentSignal);
          await revalidateEntry(currentSignal);
          return { blob, ...downloaded };
        } };
    }
    return this.#fileHtmlResources.prepare(this.newId(), preview.text, context, signal);
  }

  assertFilesHtmlResourcesCurrent(leaseId: string): void { this.#fileHtmlResources.assertCurrent(leaseId); }
  releaseFilesHtmlResources(leaseId: string): void { this.#fileHtmlResources.release(leaseId); }

  timelineImagePreviewOwnerKey(): string | undefined { return this.#taskAuthorityKey(true); }

  async prepareTimelineImagePreview(eventId: string, pageId: string, signal: AbortSignal): Promise<MobileTimelineImagePreview> {
    signal.throwIfAborted();
    const credential = this.#credential; const ownerKey = this.#taskAuthorityKey(true); const sessionId = this.#state.selectedId;
    const offline = this.#state.status !== "connected";
    const profile = credential ?? (offline ? this.#profiles.find((item) => item.profileId === this.#activeProfileId) : undefined);
    if (!profile || !ownerKey || !sessionId || (!offline && !credential)) throw new Error("The inline image has no current task owner.");
    const currentPage = (events: readonly Event[]): MobileImageGalleryPage | undefined => {
      const sources = events.filter((event) => event.eventId === eventId && event.identity?.sessionId === sessionId
        && event.cursor?.generation === (offline ? this.#state.detail?.generation : this.#taskGeneration()));
      return sources.length === 1 ? timelineGalleryPagesForSelection(events, eventId, pageId).find((page) => page.pageId === pageId) : undefined;
    };
    const page = currentPage(this.#timelineEvents());
    if (!page) throw new Error("The inline image is not in the current canonical Timeline window.");
    const assertCurrent = (currentSignal?: AbortSignal) => {
      currentSignal?.throwIfAborted();
      const current = currentPage(this.#timelineEvents());
      if (this.#disposed || this.#credential !== credential || this.#taskAuthorityKey(true) !== ownerKey
        || !current || !sameMobileImageGalleryPage(current, page)) throw new Error("The inline image source changed.");
    };
    const context: MobileTimelineImageContext = { ownerKey, page, assertCurrent,
      // A cached bitmap is presentation only; remounts also reauthorize the exact source through authenticated history.
      revalidate: async (currentSignal) => {
        if (offline) { assertCurrent(currentSignal); return; }
        const around = await this.network.readAround(credential!, sessionId, eventId, currentSignal);
        assertCurrent(currentSignal);
        const fresh = currentPage(around);
        if (!fresh || !sameMobileImageGalleryPage(fresh, page)) throw new Error("The authenticated inline image source changed.");
      },
      download: async (blob, currentSignal) => {
        if (offline) {
          const thumbnail = await this.network.readCachedImageThumbnail?.(profile, blob, 1024, currentSignal);
          assertCurrent(currentSignal);
          if (thumbnail) return { bytes: thumbnail.data, mediaType: thumbnail.mediaType, thumbnail };
          const cached = await this.network.readCachedBlob?.(profile, blob, currentSignal);
          assertCurrent(currentSignal);
          if (!cached) throw new Error("This image is not saved on this phone. Reconnect to download it.");
          return cached;
        }
        const thumbnail = await this.network.readImageThumbnail(credential!, blob, 1024, currentSignal);
        assertCurrent(currentSignal);
        return thumbnail ? { bytes: thumbnail.data, mediaType: thumbnail.mediaType, thumbnail }
          : this.network.downloadBlob(credential!, blob, currentSignal);
      } };
    return this.#timelineImages.prepare(context, signal);
  }

  confirmTimelineImagePreview(leaseId: string, native: MobileImageGalleryNativeDecode): MobileTimelineImagePreview { return this.#timelineImages.confirm(leaseId, native); }
  releaseTimelineImagePreview(leaseId: string, discard = false): void { this.#timelineImages.release(leaseId, discard); }

  #markdownResourceContext(messageId: string, text: string): MobileMarkdownResourceContext {
    const files = this.#filesContext();
    const credential = this.#ready();
    const ownerKey = this.markdownResourceOwnerKey();
    const source = timelineRows(this.#timelineEvents()).filter((row) => row.id === messageId && row.text === text
      && row.kind === "assistant" && mobileMessageShareable(row));
    const events = source.length === 1 ? this.#timelineEvents().filter((event) => event.eventId === source[0]!.eventId) : [];
    const event = events.length === 1 ? events[0] : undefined;
    if (!ownerKey || !event || event.identity?.sessionId !== files.authority.sessionId
      || event.cursor?.generation !== this.#taskGeneration() || event.payload?.kind.case !== "messageCompleted"
      || event.payload.kind.value.role !== MessageRole.ASSISTANT) throw new Error("The completed message has no current Workspace authority.");
    const digest = mobileConversationShareEventDigest(event);
    const assertCurrent = (signal?: AbortSignal): void => {
      signal?.throwIfAborted();
      if (this.#disposed || this.#credential !== credential || this.markdownResourceOwnerKey() !== ownerKey) {
        throw new Error("The task Workspace changed while the message resource was open.");
      }
      const current = this.#timelineEvents().filter((item) => item.eventId === event.eventId);
      if (current.length !== 1 || mobileConversationShareEventDigest(current[0]!) !== digest
        || !timelineRows(this.#timelineEvents()).some((row) => row.id === messageId && row.eventId === event.eventId
          && row.text === text && row.kind === "assistant" && mobileMessageShareable(row))) {
        throw new Error("The completed message changed or left the current Timeline window.");
      }
    };
    assertCurrent();
    return {
      workspaceId: files.authority.workspace.workspaceId, workdir: files.authority.workspace.serverPathDisplay, assertCurrent,
      ...(this.mediaPreviewFiles ? { stageMedia: async (entry: WorkspaceEntry, blob: BlobRef, bytes: Uint8Array, signal: AbortSignal) => {
        assertCurrent(signal);
        const driver = this.mediaPreviewFiles!;
        const staged = await driver.stage(credential.profileId, this.newId(), entry.relativePath, blob.mediaType, blob.sha256Hex, bytes, signal);
        const release = () => { void driver.remove(staged).catch(() => undefined); };
        try { assertCurrent(signal); } catch (error) { release(); throw error; }
        return { uri: staged.uri, kind: staged.mediaKind, release };
      } } : {}),
      revalidateSource: async (signal) => {
        assertCurrent(signal);
        const around = await this.network.readAround(credential, files.authority.sessionId, event.eventId, signal);
        assertCurrent(signal);
        const matches = around.filter((item) => item.eventId === event.eventId && item.identity?.sessionId === files.authority.sessionId
          && item.cursor?.generation === this.#taskGeneration());
        if (matches.length !== 1 || mobileConversationShareEventDigest(matches[0]!) !== digest) {
          throw new Error("The message was changed or removed before its resource opened.");
        }
      },
      listDirectory: (parent, signal) => this.network.listWorkspaceDirectory(credential, files.authority.workspace.workspaceId, parent, signal),
      readFile: async (entry, signal) => this.#canonicalWorkspaceImagePreview(credential, files.authority.workspace.workspaceId,
        await this.network.readWorkspaceFile(credential, files.authority.workspace.workspaceId, entry.relativePath, entry.revision!, signal), signal),
      download: (blob, signal) => this.network.downloadBlob(credential, blob, signal)
    };
  }

  async openMarkdownPath(leaseId: string, key: string, signal: AbortSignal): Promise<MobileFilesComposerSource | undefined> {
    signal.throwIfAborted();
    let authorityKey = this.filesAuthorityKey();
    const controller = new AbortController();
    const current = controller.signal;
    let filesEpoch: number | undefined;
    const abort = () => controller.abort();
    const retireFiles = () => { if (this.#filesEpoch === filesEpoch && this.#state.files.authorityKey === authorityKey) this.closeFiles(); };
    signal.addEventListener("abort", abort, { once: true });
    current.addEventListener("abort", retireFiles, { once: true });
    const deadline = setTimeout(abort, 15_000);
    const unsubscribe = this.subscribe(() => {
      try { this.#markdownResources.assertCurrent(leaseId); } catch { abort(); }
    });
    try {
      const { candidate, entry } = await this.#markdownResources.revalidate(leaseId, key, current);
      const directory = entry.kind === FileKind.DIRECTORY ? entry.relativePath : workspaceParentPath(entry.relativePath);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        this.#markdownResources.assertCurrent(leaseId); current.throwIfAborted();
        authorityKey = this.filesAuthorityKey();
        const opening = this.#openFilesAt(directory); filesEpoch = this.#filesEpoch;
        await awaitMobileMarkdownResourceRead(opening, current);
        await this.#markdownResources.revalidate(leaseId, key, current);
        if (this.filesAuthorityKey() !== authorityKey) continue;
        if (this.#state.files.status !== "ready") throw new Error("The Workspace directory could not be opened.");
        if (entry.kind === FileKind.DIRECTORY) return undefined;
        await awaitMobileMarkdownResourceRead(this.previewWorkspaceEntry(entry), current);
        await this.#markdownResources.revalidate(leaseId, key, current);
        if (this.filesAuthorityKey() !== authorityKey) continue;
        const preview = this.#state.files.preview;
        if (preview?.kind === "text" && candidate.line) this.#set({ files: { ...this.#state.files,
          preview: { ...preview, focusLine: candidate.line, ...(candidate.column ? { focusColumn: candidate.column } : {}) } } });
        return { kind: "workspace-entry", entry };
      }
      throw new Error("The Workspace changed before file preview opened.");
    } catch (error) {
      retireFiles();
      throw error;
    } finally { clearTimeout(deadline); unsubscribe(); signal.removeEventListener("abort", abort); current.removeEventListener("abort", retireFiles); }
  }

  async openMarkdownImageGallery(leaseId: string, key: string, signal: AbortSignal): Promise<MobileImageGalleryDescriptor> {
    if (!this.composerDrafts) throw new Error("Retained task drafts are unavailable on this mobile client.");
    this.#retireImageGallery();
    await this.#markdownResources.revalidate(leaseId, key, signal);
    const page = this.#markdownResources.imagePage(leaseId, key);
    const pages = this.#markdownResources.imagePages(leaseId);
    if (!page || !pages.length) throw new Error("The message image is unavailable.");
    const credential = this.#ready();
    const taskAuthorityKey = this.#taskAuthorityKey();
    const sessionId = this.#state.selectedId;
    if (!taskAuthorityKey || !sessionId) throw new Error("The task changed while its image opened.");
    this.#markdownResources.retain(leaseId);
    let adopted = false;
    try {
      const identity = { profileId: this.taskDraftProfileId()!, sessionId };
      const snapshot = await this.composerDrafts.readSnapshot(identity);
      const draft = normalizeMobileComposerDraft(snapshot.draft ?? emptyMobileComposerDraft());
      signal.throwIfAborted(); this.#markdownResources.assertCurrent(leaseId);
      if (this.#taskAuthorityKey() !== taskAuthorityKey) throw new Error("The task changed while its image opened.");
      const attachmentOwnerKey = this.taskAttachmentControls()?.surfaceOwnerKey;
      const descriptor: MobileImageGalleryDescriptor = {
        leaseId: distinctAttachmentStorageId(this.newId, ...mobileComposerAttachmentStorageIds(draft.attachments)),
        sourceKind: "timeline", sourceLabel: "Task message", pages: pages.map(mobileImageGalleryPageSummary),
        initialIndex: pages.findIndex((item) => item.pageId === page.pageId)
      };
      const lease: MobileImageGalleryLease = { leaseId: descriptor.leaseId, profileId: credential.profileId,
        credentialKey: mobileCredentialKey(credential), taskAuthorityKey, identity, snapshot, draft, descriptor, pages,
        ...(attachmentOwnerKey === undefined ? {} : { attachmentOwnerKey }),
        source: { kind: "markdown", resourceLeaseId: leaseId }, operationInFlight: false };
      this.#imageGallery = lease; adopted = true;
      try { await this.#assertImageGalleryCurrent(lease, undefined, signal); return descriptor; }
      catch (error) { if (this.#imageGallery === lease) this.#retireImageGallery(); throw error; }
    } finally { if (!adopted) this.#markdownResources.release(leaseId); }
  }

  async prepareConversationShare(selectedIds: readonly string[], signal: AbortSignal): Promise<MobileConversationShareSnapshot> {
    signal.throwIfAborted();
    if (this.#conversationShare) throw new Error("Another message image is being prepared.");
    const credential = this.#ready();
    const ownerKey = this.conversationShareOwnerKey();
    const sessionId = this.#state.selectedId;
    if (!ownerKey || !sessionId) throw new Error("Open a current task before sharing its messages.");
    const events = this.#timelineEvents();
    const rows = timelineRows(events).filter(mobileMessageShareable);
    const selected = new Set(selectedIds);
    const chosen = rows.filter((row) => selected.has(row.id));
    if (chosen.length === 0 || chosen.length !== selectedIds.length || selected.size !== selectedIds.length) {
      throw new Error("The selected messages are no longer in the current Timeline window.");
    }
    if (chosen.length > 200 || chosen.reduce((size, row) => size + row.text.length, 0) > 200_000) {
      throw new Error("The selected messages are too large. Select fewer messages.");
    }
    const sources = new Map<string, string>();
    const eventFor = (eventId: string): Event => {
      const matches = events.filter((event) => event.eventId === eventId);
      const event = matches.length === 1 ? matches[0]! : undefined;
      if (!event || event.identity?.sessionId !== sessionId || event.cursor?.generation !== this.#taskGeneration()) {
        throw new Error("A selected message source is unavailable.");
      }
      sources.set(eventId, mobileConversationShareEventDigest(event));
      return event;
    };
    const projected = chosen.map((row) => {
      const event = eventFor(row.eventId);
      const accepted = row.kind === "user" ? events.filter((source) => source.payload?.kind.case === "messageStarted"
        && source.payload.kind.value.messageId === row.id && source.payload.kind.value.role === MessageRole.USER
        && source.payload.kind.value.userInputAccepted) : [];
      if (accepted.length > 1) throw new Error("The accepted message source is ambiguous.");
      const acceptedInput = accepted[0] ? eventFor(accepted[0].eventId) : undefined;
      const pages = (row.images ?? []).flatMap((summary) => summary.sourceEventId
        ? mobileTimelineGalleryPages(eventFor(summary.sourceEventId)).filter((page) => page.pageId === summary.pageId) : []);
      return { message: projectMobileConversationShareMessage(row, event, pages, acceptedInput), pages };
    });
    const lease: MobileConversationShareLease = {
      leaseId: this.newId(), ownerKey, credential, sessionId,
      rowEvents: new Map(chosen.map((row) => [row.id, row.eventId])), sources, markdownResources: []
    };
    this.#conversationShare = lease;
    const imageAbort = new AbortController();
    const abort = () => imageAbort.abort();
    signal.addEventListener("abort", abort, { once: true });
    const deadline = setTimeout(abort, 15_000);
    let remainingBytes = 12 * 1_024 * 1_024;
    let remainingPixels = 12_000_000;
    try {
      const messages: MobileConversationShareSnapshot["messages"][number][] = [];
      for (const { message, pages } of projected) {
        const images = new Map<string, MobileConversationShareImage>();
        for (const page of pages) {
          this.#assertConversationShareCurrent(lease, signal);
          if (imageAbort.signal.aborted || page.byteSize > remainingBytes) continue;
          try {
            let rejectDownload: (() => void) | undefined;
            const download = await Promise.race([
              this.network.downloadBlob(credential, page.blob, imageAbort.signal),
              new Promise<never>((_resolve, reject) => {
                rejectDownload = () => reject(new Error("The image preparation was cancelled."));
                imageAbort.signal.addEventListener("abort", rejectDownload, { once: true });
              })
            ]).finally(() => { if (rejectDownload) imageAbort.signal.removeEventListener("abort", rejectDownload); });
            this.#assertConversationShareCurrent(lease, signal);
            if (normalizeMediaType(download.mediaType) !== page.mediaType || download.bytes.byteLength !== page.byteSize
              || bytesToHex(sha256(download.bytes)) !== page.sha256Hex) throw new Error("The canonical message image changed.");
            const decoded = inspectMobileImageGalleryBytes(download.bytes, page.mediaType);
            if (decoded.width * decoded.height > remainingPixels || (page.widthPixels !== undefined
              && !mobileImageGalleryDimensionsMatch(decoded, page.widthPixels, page.heightPixels!))) continue;
            images.set(page.pageId, { uri: mobileImageGalleryPreviewUri(download.bytes, decoded),
              width: decoded.width, height: decoded.height,
              ...(decoded.nativeQuarterTurn ? { nativeQuarterTurn: true } : {}) });
            remainingBytes -= download.bytes.byteLength;
            remainingPixels -= decoded.width * decoded.height;
          } catch {
            // Unreadable images keep their own label; authority/source drift retires the entire export.
            this.#assertConversationShareCurrent(lease, signal);
          }
        }
        if (message.kind === "assistant" && this.markdownResourceOwnerKey() && !imageAbort.signal.aborted) {
          try {
            const source = chosen.find((row) => row.id === message.clientId)!;
            const resources = await this.prepareMarkdownResources(source.id, source.text, imageAbort.signal);
            if (![...resources.references.values()].some((reference) => reference.image !== undefined)) {
              this.releaseMarkdownResources(resources.leaseId);
              this.#assertConversationShareCurrent(lease, signal);
              messages.push({ ...message, images }); continue;
            }
            lease.markdownResources.push(resources.leaseId);
            this.#assertConversationShareCurrent(lease, signal);
            for (const [key, reference] of resources.references) {
              const page = this.#markdownResources.imagePage(resources.leaseId, key);
              const image = reference.image;
              if (!image || !page || page.byteSize > remainingBytes || image.width * image.height > remainingPixels) continue;
              const parsed: unknown = JSON.parse(key);
              if (!Array.isArray(parsed) || parsed[0] !== "image" || typeof parsed[1] !== "string") continue;
              images.set(parsed[1], image);
              remainingBytes -= page.byteSize; remainingPixels -= image.width * image.height;
            }
          } catch { this.#assertConversationShareCurrent(lease, signal); }
        }
        messages.push({ ...message, images });
      }
      this.#assertConversationShareCurrent(lease, signal);
      return { leaseId: lease.leaseId, allShareableIds: rows.map((row) => row.id), messages };
    } catch (error) {
      this.releaseConversationShare(lease.leaseId);
      throw error;
    } finally {
      clearTimeout(deadline);
      signal.removeEventListener("abort", abort);
      imageAbort.abort();
    }
  }

  assertConversationShareCurrent(leaseId: string, signal?: AbortSignal): void {
    const lease = this.#conversationShare;
    if (!lease || lease.leaseId !== leaseId) throw new Error("The message image no longer owns its source.");
    this.#assertConversationShareCurrent(lease, signal);
  }

  #assertConversationShareCurrent(lease: MobileConversationShareLease, signal?: AbortSignal): void {
    signal?.throwIfAborted();
    if (this.#conversationShare !== lease || this.#credential !== lease.credential
      || this.conversationShareOwnerKey() !== lease.ownerKey) throw new Error("The task changed before message sharing began.");
    const events = this.#timelineEvents();
    const rows = timelineRows(events).filter(mobileMessageShareable);
    for (const [id, eventId] of lease.rowEvents) {
      if (!rows.some((row) => row.id === id && row.eventId === eventId)) throw new Error("A selected message left the current Timeline window.");
    }
    for (const [id, digest] of lease.sources) {
      const matches = events.filter((event) => event.eventId === id);
      if (matches.length !== 1 || mobileConversationShareEventDigest(matches[0]!) !== digest) {
        throw new Error("A selected message source changed.");
      }
    }
    for (const id of lease.markdownResources) this.#markdownResources.assertCurrent(id);
  }

  async revalidateConversationShare(leaseId: string, signal: AbortSignal): Promise<void> {
    this.assertConversationShareCurrent(leaseId, signal);
    const lease = this.#conversationShare!;
    for (const [eventId, digest] of lease.sources) {
      const around = await this.network.readAround(lease.credential, lease.sessionId, eventId, signal);
      this.#assertConversationShareCurrent(lease, signal);
      const matches = around.filter((event) => event.eventId === eventId && event.identity?.sessionId === lease.sessionId
        && event.cursor?.generation === this.#taskGeneration());
      if (matches.length !== 1 || mobileConversationShareEventDigest(matches[0]!) !== digest) {
        throw new Error("A selected message was changed or removed before system sharing began.");
      }
    }
    for (const id of lease.markdownResources) await this.#markdownResources.revalidateImages(id, signal);
  }

  releaseConversationShare(leaseId: string): void {
    if (this.#conversationShare?.leaseId !== leaseId) return;
    for (const id of this.#conversationShare.markdownResources) this.#markdownResources.release(id);
    this.#conversationShare = undefined;
  }

  taskQueueImagePages(queueItemId: string): readonly ReturnType<typeof mobileImageGalleryPageSummary>[] {
    const item = this.taskQueueItems().find((candidate) => candidate.queueItemId === queueItemId);
    return item ? mobileQueueGalleryPages(item).map(mobileImageGalleryPageSummary) : [];
  }

  #queueGalleryPages(queueItemId: string): readonly MobileImageGalleryPage[] {
    const item = this.taskQueueItems().find((candidate) => candidate.queueItemId === queueItemId);
    return item ? mobileQueueGalleryPages(item) : [];
  }

  async prepareQueueImagePreview(queueItemId: string, pageId: string, signal: AbortSignal): Promise<MobileTimelineImagePreview> {
    const credential = this.#credential, ownerKey = this.#taskAuthorityKey(true), sessionId = this.#state.selectedId;
    const offline = this.#state.status !== "connected";
    const profile = credential ?? (offline ? this.#profiles.find((item) => item.profileId === this.#activeProfileId) : undefined);
    const page = this.#queueGalleryPages(queueItemId).find((candidate) => candidate.pageId === pageId);
    if (!profile || !ownerKey || !sessionId || !page || !offline && !credential) throw new Error("The pending image is no longer in this task queue.");
    const assertCurrent = (currentSignal?: AbortSignal): void => {
      currentSignal?.throwIfAborted();
      const current = this.#queueGalleryPages(queueItemId).find((candidate) => candidate.pageId === pageId);
      if (this.#credential !== credential || this.#taskAuthorityKey(true) !== ownerKey || !current || !sameMobileImageGalleryPage(current, page)) {
        throw new Error("The pending image changed or left the task queue.");
      }
    };
    return this.#timelineImages.prepare({ ownerKey, page, assertCurrent,
      revalidate: async (currentSignal) => {
        if (offline) { assertCurrent(currentSignal); return; }
        await this.#revalidateQueueImage(credential!, sessionId, page, assertCurrent, currentSignal);
      },
      download: async (blob, currentSignal) => {
        if (!offline) return this.network.downloadBlob(credential!, blob, currentSignal);
        const cached = await this.network.readCachedBlob?.(profile, blob, currentSignal); assertCurrent(currentSignal);
        if (!cached) throw new Error("This pending image is not saved on this phone. Reconnect to download it.");
        return cached;
      } }, signal);
  }

  async #revalidateQueueImage(credential: PairedCredential, sessionId: string, page: MobileImageGalleryPage,
    assertCurrent: (signal?: AbortSignal) => void, signal: AbortSignal): Promise<void> {
    assertCurrent(signal);
    if (page.source.kind !== "queue") throw new Error("The pending image source is invalid.");
    const detail = await this.network.readSession(credential, sessionId, signal);
    assertCurrent(signal);
    const session = detail.sessions.find((candidate) => candidate.sessionId === sessionId);
    const source = page.source;
    const items = detail.queueItems.filter((candidate) => candidate.queueItemId === source.queueItemId && candidate.sessionId === sessionId);
    const current = items.length === 1 ? mobileQueueGalleryPages(items[0]!).find((candidate) => candidate.pageId === page.pageId) : undefined;
    if (detail.scope?.kind.case !== "session" || detail.scope.kind.value.sessionId !== sessionId
      || detail.server?.serverId !== credential.serverId || detail.generation !== this.#taskGeneration()
      || session?.nativeBinding?.runtimeGeneration !== this.#selectedSession()?.nativeBinding?.runtimeGeneration
      || !current || !sameMobileImageGalleryPage(current, page)) throw new Error("The pending image changed or left the task queue.");
  }

  async openQueueImageGallery(queueItemId: string, pageId: string, signal?: AbortSignal): Promise<MobileImageGalleryDescriptor> {
    signal?.throwIfAborted();
    if (!this.composerDrafts) throw new Error("Retained task drafts are unavailable on this mobile client.");
    this.#retireImageGallery();
    const cachedOnly = this.#state.status !== "connected";
    const credential = this.#credential ?? (cachedOnly ? this.#profiles.find((item) => item.profileId === this.#activeProfileId) : undefined);
    const taskAuthorityKey = this.#taskAuthorityKey(cachedOnly), sessionId = this.#state.selectedId;
    const pages = this.#queueGalleryPages(queueItemId), initialIndex = pages.findIndex((page) => page.pageId === pageId);
    if (!credential || !taskAuthorityKey || !sessionId || initialIndex < 0) throw new Error("The pending image is no longer in this task queue.");
    const identity = { profileId: credential.profileId, sessionId };
    const snapshot = await this.composerDrafts.readSnapshot(identity);
    const draft = normalizeMobileComposerDraft(snapshot.draft ?? emptyMobileComposerDraft());
    const attachmentOwnerKey = this.taskAttachmentControls()?.surfaceOwnerKey;
    const descriptor: MobileImageGalleryDescriptor = { leaseId: distinctAttachmentStorageId(this.newId, ...mobileComposerAttachmentStorageIds(draft.attachments)),
      sourceKind: "timeline", sourceLabel: "Pending message", initialIndex, pages: pages.map(mobileImageGalleryPageSummary) };
    const lease: MobileImageGalleryLease = { ...(cachedOnly ? { cachedOnly: true } : {}), leaseId: descriptor.leaseId, profileId: credential.profileId,
      credentialKey: mobileCredentialKey(credential), taskAuthorityKey, identity, snapshot, draft, descriptor, pages,
      ...(attachmentOwnerKey === undefined ? {} : { attachmentOwnerKey }), source: { kind: "queue", queueItemId }, operationInFlight: false };
    this.#imageGallery = lease;
    try { await this.#assertImageGalleryCurrent(lease, undefined, signal); return descriptor; }
    catch (error) { if (this.#imageGallery === lease) this.#retireImageGallery(); throw error; }
  }

  async openTimelineImageGallery(
    eventId: string,
    pageId: string,
    signal?: AbortSignal
  ): Promise<MobileImageGalleryDescriptor> {
    signal?.throwIfAborted();
    if (!this.composerDrafts) throw new Error("Retained task drafts are unavailable on this mobile client.");
    this.#retireImageGallery();
    const cachedOnly = this.#state.status !== "connected";
    const credential = this.#credential ?? (cachedOnly ? this.#profiles.find((profile) => profile.profileId === this.#activeProfileId) : undefined);
    const taskAuthorityKey = this.#taskAuthorityKey(cachedOnly);
    const sessionId = this.#state.selectedId;
    if (!credential || !taskAuthorityKey || !sessionId) throw new Error("Open a current task before viewing its message images.");
    const events = this.#timelineEvents();
    const matches = events.filter((event) => event.eventId === eventId);
    const event = matches.length === 1 ? matches[0] : undefined;
    if (!event || event.identity?.sessionId !== sessionId || cachedOnly && event.cursor?.generation !== this.#state.detail?.generation) {
      throw new Error("The durable image is no longer in the current Timeline window.");
    }
    const pages = timelineGalleryPagesForSelection(events, eventId, pageId);
    const initialIndex = pages.findIndex((page) => page.pageId === pageId);
    if (initialIndex < 0 || pages.length === 0) {
      throw new Error("The selected image is not in its current durable Timeline source.");
    }
    const identity = { profileId: credential.profileId, sessionId };
    const snapshot = await this.composerDrafts.readSnapshot(identity);
    const draft = normalizeMobileComposerDraft(snapshot.draft ?? {
      text: "", mentions: [], atoms: [], slashCommands: [], attachments: []
    });
    signal?.throwIfAborted();
    if (this.#taskAuthorityKey(cachedOnly) !== taskAuthorityKey) throw new Error("The task changed while the image gallery was opening.");
    const attachmentOwnerKey = this.taskAttachmentControls()?.surfaceOwnerKey;
    const leaseId = distinctAttachmentStorageId(this.newId, ...mobileComposerAttachmentStorageIds(draft.attachments));
    const descriptor: MobileImageGalleryDescriptor = {
      leaseId,
      sourceKind: "timeline",
      sourceLabel: event.payload?.kind.case === "messageStarted" && event.payload.kind.value.role === MessageRole.USER
        || event.payload?.kind.case === "messageCompleted" && event.payload.kind.value.role === MessageRole.USER
        ? "Your message" : event.payload?.kind.case === "toolCallStarted" || event.payload?.kind.case === "toolCallUpdated"
          || event.payload?.kind.case === "toolCallCompleted" ? "Tool result"
          : event.payload?.kind.case === "artifactProduced" ? "Generated file" : "Task message",
      pages: pages.map(mobileImageGalleryPageSummary),
      initialIndex
    };
    const lease: MobileImageGalleryLease = {
      ...(cachedOnly ? { cachedOnly: true } : {}),
      leaseId,
      profileId: credential.profileId,
      credentialKey: mobileCredentialKey(credential),
      taskAuthorityKey,
      ...(attachmentOwnerKey === undefined ? {} : { attachmentOwnerKey }),
      identity,
      snapshot,
      draft,
      descriptor,
      pages,
      source: {
        kind: "timeline",
        eventId,
        pageId,
        windowKey: mobileTimelineGalleryWindowKey(events)
      },
      operationInFlight: false
    };
    this.#imageGallery = lease;
    try {
      await this.#assertImageGalleryCurrent(lease, undefined, signal);
      return descriptor;
    } catch (error) {
      if (this.#imageGallery === lease) this.#retireImageGallery();
      throw error;
    }
  }

  async loadImageGalleryPage(
    leaseId: string,
    pageIndex: number,
    signal?: AbortSignal
  ): Promise<MobileImageGalleryPageSession> {
    signal?.throwIfAborted();
    const lease = this.#imageGallery;
    if (!lease || lease.leaseId !== leaseId || lease.operationInFlight) {
      throw new Error("The image gallery no longer owns this source window.");
    }
    if (!Number.isSafeInteger(pageIndex) || pageIndex < 0 || pageIndex >= lease.pages.length) {
      throw new Error("The requested image gallery page is out of range.");
    }
    lease.loaded = undefined;
    await this.#assertImageGalleryCurrent(lease, undefined, signal);
    const page = lease.pages[pageIndex]!;
    const assertCurrent = () => {
      signal?.throwIfAborted();
      if (this.#imageGallery !== lease || !this.imageGalleryCurrent(leaseId) || lease.operationInFlight) throw new Error("The gallery image source changed before download.");
    };
    const profile = this.#credential ?? this.#profiles.find((item) => item.profileId === lease.profileId);
    if (!profile) throw new Error("The gallery connection profile changed.");
    const download = lease.cachedOnly ? await this.network.readCachedBlob?.(profile, page.blob, signal)
      : await this.#downloadGalleryBlob(this.#ready(), page.blob, assertCurrent, signal);
    assertCurrent();
    if (!download) throw new Error("The original image is not saved on this phone. Reconnect to download it.");
    signal?.throwIfAborted();
    if (normalizeMediaType(download.mediaType) !== page.mediaType || download.bytes.byteLength !== page.byteSize
      || lease.cachedOnly && bytesToHex(sha256(download.bytes)) !== page.sha256Hex) {
      throw new Error("The authenticated gallery image changed media type or size.");
    }
    const decoded = inspectMobileImageGalleryBytes(download.bytes, page.mediaType);
    if (page.widthPixels !== undefined && !mobileImageGalleryDimensionsMatch(decoded, page.widthPixels, page.heightPixels!)) {
      throw new Error("The gallery image dimensions do not match their canonical metadata.");
    }
    await this.#assertImageGalleryCurrent(lease, undefined, signal);
    const loadId = distinctAttachmentStorageId(this.newId, lease.leaseId, page.pageId);
    lease.loaded = {
      loadId,
      page,
      pageIndex,
      bytes: Uint8Array.from(download.bytes),
      decoded,
      confirmed: false
    };
    const controls = this.taskAttachmentControls();
    const metadata = controls && controls.surfaceOwnerKey === lease.attachmentOwnerKey
      ? filesAttachmentMetadata(page.blob.fileName || page.title, page.mediaType, BigInt(page.byteSize), lease.draft.attachments, controls)
      : undefined;
    let annotatable = false;
    if (controls && controls.surfaceOwnerKey === lease.attachmentOwnerKey
      && (metadata !== undefined || mobileImageRequiresNativeRaster(page.mediaType))
      && !decoded.animated && !decoded.originalOnly && canAnnotateMobileImage(page.mediaType)) {
      try {
        assertMobileAttachmentCandidate({
          fileName: mobileAnnotatedImageFileName(
            metadata?.fileName ?? mobileImageOutputFileName(page.blob.fileName || page.title, page.mediaType),
            mobileAnnotationOutputMediaType(page.mediaType)
          ),
          mediaType: mobileAnnotationOutputMediaType(page.mediaType),
          byteSize: 1
        }, controls.policy);
        annotatable = true;
      } catch { /* The original remains viewable and may still be directly addable. */ }
    }
    return {
      galleryLeaseId: lease.leaseId,
      ...(lease.cachedOnly ? { readOnly: true } : {}),
      leaseId: loadId,
      pageId: page.pageId,
      pageIndex,
      pageCount: lease.pages.length,
      sourceKind: lease.descriptor.sourceKind,
      sourceLabel: lease.descriptor.sourceLabel,
      previewUri: mobileImageGalleryPreviewUri(download.bytes, decoded),
      sourceBase64: encodeMobileBase64(download.bytes),
      sourceMediaType: page.mediaType,
      fileName: metadata?.fileName ?? (page.blob.fileName || page.title),
      initialStrokes: [],
      annotatable,
      addable: metadata !== undefined,
      maximumBytes: controls?.policy.maximumBytes ?? MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES,
      expectedWidthPixels: decoded.width,
      expectedHeightPixels: decoded.height,
      ...(decoded.nativeQuarterTurn ? { nativeQuarterTurn: true } : {}),
      expectedAnimated: decoded.animated === true,
      originalOnly: decoded.originalOnly === true,
      ...(decoded.previewMediaType ? { previewMediaType: decoded.previewMediaType } : {})
    };
  }

  async #downloadGalleryBlob(credential: PairedCredential, blob: BlobRef, assertCurrent: () => void, signal?: AbortSignal): ReturnType<MobileNetwork["downloadBlob"]> {
    while (this.#galleryBlobRead) {
      await awaitMobileMarkdownResourceRead(this.#galleryBlobRead.catch(() => undefined), signal ?? new AbortController().signal);
    }
    signal?.throwIfAborted();
    assertCurrent();
    const raw = this.network.downloadBlob(credential, blob, signal); this.#galleryBlobRead = raw;
    void raw.then(() => { if (this.#galleryBlobRead === raw) this.#galleryBlobRead = undefined; },
      () => { if (this.#galleryBlobRead === raw) this.#galleryBlobRead = undefined; });
    return raw;
  }

  async prepareImageGalleryAdjacentPreview(leaseId: string, pageIndex: number, signal: AbortSignal): Promise<MobileTimelineImagePreview> {
    signal.throwIfAborted();
    const lease = this.#imageGallery; const currentIndex = lease?.loaded?.pageIndex; const page = lease?.pages[pageIndex];
    if (!lease || lease.leaseId !== leaseId || currentIndex === undefined || !Number.isSafeInteger(pageIndex)
      || Math.abs(currentIndex - pageIndex) !== 1 || !page) throw new Error("The adjacent image has no current gallery owner.");
    if (lease.cachedOnly) {
      if (!("eventId" in page.source) && page.source.kind !== "queue") throw new Error("The saved image has no retained message source.");
      const preview = page.source.kind === "queue" ? await this.prepareQueueImagePreview(page.source.queueItemId, page.pageId, signal)
        : await this.prepareTimelineImagePreview(page.source.eventId, page.pageId, signal);
      if (!this.imageGalleryCurrent(leaseId) || lease.loaded?.pageIndex !== currentIndex) {
        this.#timelineImages.release(preview.leaseId); throw new Error("The saved gallery source changed.");
      }
      lease.previewLeaseIds ??= new Set(); lease.previewLeaseIds.add(preview.leaseId); return preview;
    }
    const credential = this.#ready();
    const assertCurrent = (currentSignal?: AbortSignal) => {
      currentSignal?.throwIfAborted();
      if (this.#imageGallery !== lease || this.#credential !== credential || !this.imageGalleryCurrent(leaseId)
        || lease.loaded?.pageIndex !== currentIndex || lease.pages[pageIndex] !== page) throw new Error("The adjacent image source changed.");
    };
    const revalidate = async (currentSignal: AbortSignal) => {
      await this.#assertImageGalleryCurrent(lease, undefined, currentSignal);
      await this.#revalidateGalleryImageSource(lease, { page }, currentSignal); assertCurrent(currentSignal);
    };
    let preview: MobileTimelineImagePreview | undefined;
    try {
      preview = await this.#timelineImages.prepare({ ownerKey: lease.taskAuthorityKey, page, assertCurrent, revalidate,
        download: (blob, currentSignal) => this.#downloadGalleryBlob(credential, blob, () => assertCurrent(currentSignal), currentSignal) }, signal);
      await revalidate(signal);
      lease.previewLeaseIds ??= new Set(); lease.previewLeaseIds.add(preview.leaseId);
      return preview;
    } catch (failure) { if (preview) this.#timelineImages.release(preview.leaseId, true); throw failure; }
  }

  async pinImageGalleryCachedPreview(leaseId: string, pageIndex: number, signal: AbortSignal): Promise<MobileTimelineImagePreview | undefined> {
    signal.throwIfAborted(); const lease = this.#imageGallery;
    if (!lease || lease.leaseId !== leaseId || !Number.isSafeInteger(pageIndex) || !lease.pages[pageIndex]) return undefined;
    await this.#assertImageGalleryCurrent(lease, undefined, signal);
    const page = lease.pages[pageIndex]!;
    const preview = this.#timelineImages.pinCached({ ownerKey: lease.taskAuthorityKey, page, assertCurrent: (currentSignal) => {
      currentSignal?.throwIfAborted();
      if (this.#imageGallery !== lease || this.#taskAuthorityKey(lease.cachedOnly) !== lease.taskAuthorityKey || lease.pages[pageIndex] !== page
        || !this.imageGalleryCurrent(leaseId)) {
        throw new Error("The cached gallery preview source changed.");
      }
      if (lease.source.kind === "timeline" && (mobileTimelineGalleryWindowKey(this.#timelineEvents()) !== lease.source.windowKey
        || !timelineGalleryPagesForSelection(this.#timelineEvents(), lease.source.eventId, lease.source.pageId).some((current) => sameMobileImageGalleryPage(current, page)))) {
        throw new Error("The cached Timeline gallery preview changed.");
      }
    } }, signal);
    if (preview) { lease.previewLeaseIds ??= new Set(); lease.previewLeaseIds.add(preview.leaseId); }
    return preview;
  }

  imageGalleryCurrent(leaseId: string): boolean {
    const lease = this.#imageGallery;
    const credential = this.#credential ?? (lease?.cachedOnly ? this.#profiles.find((item) => item.profileId === lease.profileId) : undefined);
    if (!lease || lease.leaseId !== leaseId || !credential || this.#taskAuthorityKey(lease.cachedOnly) !== lease.taskAuthorityKey
      || mobileCredentialKey(credential) !== lease.credentialKey || this.taskAttachmentControls()?.surfaceOwnerKey !== lease.attachmentOwnerKey) return false;
    const source = lease.source;
    if (source.kind === "files") return this.#currentFiles(source.filesEpoch, source.filesAuthorityKey)
      && mobileFilesGalleryWindowKey(this.#state.files) === source.filesWindowKey;
    if (source.kind === "markdown") {
      try { this.#markdownResources.assertCurrent(source.resourceLeaseId); return true; } catch { return false; }
    }
    if (source.kind === "queue") {
      const pages = this.#queueGalleryPages(source.queueItemId);
      return pages.length === lease.pages.length && pages.every((page, index) => sameMobileImageGalleryPage(page, lease.pages[index]!));
    }
    const events = this.#timelineEvents(); const pages = timelineGalleryPagesForSelection(events, source.eventId, source.pageId);
    return mobileTimelineGalleryWindowKey(events) === source.windowKey && pages.length === lease.pages.length
      && pages.every((page, index) => sameMobileImageGalleryPage(page, lease.pages[index]!));
  }

  releaseImageGalleryPreview(leaseId: string, previewLeaseId: string, discard = false): void {
    if (this.#imageGallery?.leaseId === leaseId) this.#imageGallery.previewLeaseIds?.delete(previewLeaseId);
    this.#timelineImages.release(previewLeaseId, discard);
  }

  discardImageGalleryPage(leaseId: string, loadId?: string): void {
    const lease = this.#imageGallery;
    if (lease?.leaseId === leaseId && !lease.operationInFlight && (loadId === undefined || lease.loaded?.loadId === loadId)) lease.loaded = undefined;
  }

  confirmImageGalleryPageDecoded(
    galleryLeaseId: string,
    loadId: string,
    pageId: string,
    decoded: { readonly width: number; readonly height: number; readonly mediaType?: string | null; readonly isAnimated?: boolean }
  ): void {
    const lease = this.#imageGallery;
    const loaded = lease?.loaded;
    if (!lease || lease.leaseId !== galleryLeaseId || !loaded || loaded.loadId !== loadId
      || loaded.page.pageId !== pageId || !mobileImageGalleryNativeAnimationMatches(loaded.page.mediaType, loaded.decoded.animated === true, decoded.isAnimated)
      || !mobileImageGalleryDimensionsMatch(loaded.decoded, decoded.width, decoded.height)
      || decoded.mediaType && normalizeMediaType(decoded.mediaType) !== (loaded.decoded.previewMediaType ?? loaded.decoded.mediaType)) {
      throw new Error("The decoded image no longer matches this gallery page.");
    }
    if (loaded.confirmed) return;
    loaded.decoded = confirmMobileImageGalleryCanvas(loaded.decoded, decoded);
    loaded.confirmed = true;
  }

  async prepareImageOutput(
    leaseId: string,
    decoded: MobileImageGalleryNativeDecode,
    signal?: AbortSignal
  ): Promise<MobileImageOutputSource> {
    signal?.throwIfAborted();
    if (!this.attachmentFiles) throw new Error("Verified image bytes are unavailable on this mobile client.");

    const editLease = this.#composerImageEdit;
    if (editLease?.leaseId === leaseId) {
      if (editLease.commitInFlight) throw new Error("The image attachment is already being changed.");
      const parsed = inspectMobileImageOutputBytes(editLease.sourceBytes, editLease.source.mediaType, decoded);
      const exactDecoded = assertMobileImageOutputDecode(
        decoded,
        parsed.mediaType,
        parsed.width,
        parsed.height
      );
      await this.#assertComposerImageEditCurrent(editLease, undefined, signal);
      if (editLease.sourceBytes.byteLength !== editLease.source.byteSize
        || await this.attachmentFiles.digestOwnedBytes(editLease.sourceBytes, signal) !== editLease.source.sha256Hex) {
        throw new Error("The verified image attachment bytes changed before output.");
      }
      await this.#assertComposerImageEditCurrent(editLease, undefined, signal);
      return {
        leaseId,
        fileName: editLease.source.fileName,
        mediaType: parsed.mediaType,
        byteSize: editLease.source.byteSize,
        sha256Hex: editLease.source.sha256Hex,
        bytes: Uint8Array.from(editLease.sourceBytes),
        width: exactDecoded.width,
        height: exactDecoded.height
      };
    }

    const galleryLease = this.#imageGallery;
    const loaded = galleryLease?.loaded;
    if (galleryLease?.cachedOnly) throw new Error("Reconnect to the Joko node before exporting this image.");
    if (!galleryLease || !loaded || loaded.loadId !== leaseId || !loaded.confirmed || galleryLease.operationInFlight) {
      throw new Error("The decoded image no longer owns this output action.");
    }
    if (!mobileImageGalleryDimensionsMatch(loaded.decoded, decoded.width, decoded.height)) {
      throw new Error("The native output canvas no longer matches the confirmed gallery image.");
    }
    const parsed = inspectMobileImageOutputBytes(loaded.bytes, loaded.page.mediaType, decoded);
    const exactDecoded = assertMobileImageOutputDecode(
      decoded,
      parsed.mediaType,
      parsed.width,
      parsed.height
    );
    await this.#assertImageGalleryCurrent(galleryLease, undefined, signal);
    if (loaded.bytes.byteLength !== loaded.page.byteSize
      || await this.attachmentFiles.digestOwnedBytes(loaded.bytes, signal) !== loaded.page.sha256Hex) {
      throw new Error("The verified gallery image bytes changed before output.");
    }
    await this.#assertImageGalleryCurrent(galleryLease, undefined, signal);
    if (galleryLease.loaded !== loaded || !loaded.confirmed) {
      throw new Error("The decoded gallery image changed before output.");
    }
    return {
      leaseId,
      fileName: mobileImageOutputFileName(loaded.page.blob.fileName || loaded.page.title, parsed.mediaType),
      mediaType: parsed.mediaType,
      byteSize: loaded.page.byteSize,
      sha256Hex: loaded.page.sha256Hex,
      bytes: Uint8Array.from(loaded.bytes),
      width: exactDecoded.width,
      height: exactDecoded.height
    };
  }

  cancelImageGallery(leaseId: string): void {
    if (this.#imageGallery?.leaseId === leaseId) this.#retireImageGallery();
  }

  async shareImageGalleryPageOriginal(galleryLeaseId: string, loadId: string, signal?: AbortSignal, onDispatch?: () => void): Promise<void> {
    signal?.throwIfAborted();
    const lease = this.#imageGallery; const loaded = lease?.loaded;
    if (lease?.cachedOnly) throw new Error("Reconnect to the Joko node before sharing the original image.");
    if (!this.fileShare) throw new Error("System file sharing is unavailable on this mobile runtime.");
    if (!lease || lease.leaseId !== galleryLeaseId || !loaded || loaded.loadId !== loadId
      || !loaded.confirmed || lease.operationInFlight || this.#fileShareLease) {
      throw new Error("The decoded image no longer owns this sharing action.");
    }
    const controller = new AbortController();
    const operationSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    lease.shareController = controller; lease.operationInFlight = true;
    const assertCurrent = async (): Promise<void> => {
      await this.#assertImageGalleryCurrent(lease, undefined, operationSignal);
      if (lease.loaded !== loaded || !loaded.confirmed) throw new Error("The gallery page changed before system sharing began.");
      await this.#revalidateGalleryImageSource(lease, loaded, operationSignal);
      await this.#assertImageGalleryCurrent(lease, undefined, operationSignal);
    };
    try {
      await assertCurrent();
      const authorized = await this.network.authorizeBlobDownload(this.#ready(), loaded.page.blob, operationSignal);
      if (authorized.blobId !== loaded.page.blob.blobId || authorized.byteSize !== loaded.page.byteSize
        || authorized.sha256Hex !== loaded.page.sha256Hex || normalizeMediaType(authorized.mediaType) !== loaded.page.mediaType) {
        throw new Error("The authorized sharing bytes changed from this gallery image.");
      }
      await this.#assertImageGalleryCurrent(lease, undefined, operationSignal);
      await this.fileShare.perform({ source: authorized, signal: operationSignal, assertCurrent, ...(onDispatch ? { onDispatch } : {}) });
    } finally {
      if (lease.shareController === controller) { lease.shareController = undefined; lease.operationInFlight = false; }
    }
  }

  #retireImageGallery(): void {
    this.#imageGallery?.shareController?.abort();
    for (const id of this.#imageGallery?.previewLeaseIds ?? []) this.#timelineImages.release(id);
    if (this.#imageGallery?.source.kind === "markdown") this.#markdownResources.release(this.#imageGallery.source.resourceLeaseId);
    this.#imageGallery = undefined;
  }

  async addImageGalleryPageToComposer(
    galleryLeaseId: string,
    loadId: string,
    signal?: AbortSignal
  ): Promise<MobileComposerDraft> {
    return this.#commitImageGalleryPage(galleryLeaseId, loadId, [], undefined, signal);
  }

  async commitImageGalleryPageToComposer(
    galleryLeaseId: string,
    loadId: string,
    strokes: readonly MobileImageAnnotationStroke[],
    burned: MobileBurnedImage | undefined,
    signal?: AbortSignal
  ): Promise<MobileComposerDraft> {
    return this.#commitImageGalleryPage(galleryLeaseId, loadId, strokes, burned, signal);
  }

  async older(): Promise<void> {
    const credential = this.#credential;
    const sessionId = this.#state.selectedId;
    if (!credential || !sessionId || this.#state.status !== "connected" || this.#state.historyEnd || this.#historyOwner) return;
    const epoch = this.#epoch;
    const owner = Symbol("history page");
    this.#historyOwner = owner;
    this.#set({ historyBusy: true });
    try {
      const before = this.#state.before;
      const page = await this.network.readHistory(credential, sessionId, before, this.#abort?.signal);
      if (!this.#current(epoch) || sessionId !== this.#state.selectedId || this.#historyOwner !== owner) return;
      validateHistory(page.events, sessionId, this.#taskGeneration(), before);
      if (page.before && (page.events.length === 0 || !page.before.opaqueToken || page.before.generation !== this.#taskGeneration()
        || (before && page.before.sequence >= before.sequence) || page.before.sequence > page.events[0]!.cursor!.sequence)) {
        throw new Error("The task history returned a cyclic or mismatched page cursor.");
      }
      const known = new Set(this.#state.older.map((item) => item.eventId));
      const older = [...page.events.filter((item) => !known.has(item.eventId)), ...this.#state.older];
      const window = this.#state.window ? [...older, ...this.#state.window] : undefined;
      this.#set({ older: window ? [] : older, window, before: page.before, historyEnd: !page.before });
      if (!this.#joinedTask && window === undefined && this.#state.node && this.#state.owner && this.#state.detail) {
        await this.#persistOfflineProjection(epoch, credential, this.#state.node, this.#state.owner, this.#state.detail);
      }
    } catch (error) {
      if (this.#current(epoch) && isStaleHistory(error)) void this.refresh();
      throw error;
    } finally {
      if (this.#historyOwner === owner) { this.#historyOwner = undefined; this.#set({ historyBusy: false }); }
    }
  }

  async around(eventId: string): Promise<void> {
    const credential = this.#ready();
    const sessionId = this.#state.selectedId;
    if (!sessionId || this.#historyOwner) return;
    const epoch = this.#epoch;
    const owner = Symbol("history anchor");
    this.#historyOwner = owner;
    this.#set({ historyBusy: true });
    try {
      const events = await this.network.readAround(credential, sessionId, eventId, this.#abort?.signal);
      if (!this.#current(epoch) || sessionId !== this.#state.selectedId || this.#historyOwner !== owner) return;
      validateHistory(events, sessionId, this.#taskGeneration());
      if (!events.some((event) => event.eventId === eventId)) throw new Error("The selected event is no longer in task history.");
      this.#set({ window: events, older: [], before: events[0]!.cursor, historyEnd: false });
    } catch (error) {
      if (this.#current(epoch) && isStaleHistory(error)) void this.refresh();
      throw error;
    } finally {
      if (this.#historyOwner === owner) { this.#historyOwner = undefined; this.#set({ historyBusy: false }); }
    }
  }

  async resolveComposerRouteReference(target: MobileComposerRouteResolutionTarget): Promise<string | undefined> {
    const credential = this.#credential;
    const owner = this.#state.owner;
    if (!credential || !owner || !this.#foreground || this.#state.status !== "connected"
      || owner.scope?.kind.case !== "owner" || owner.server?.serverId !== credential.serverId
      || owner.generation < 1n || !owner.snapshotId || !owner.revision || owner.revision.value < 1n) return undefined;
    const parsed = parseMobileComposerRouteHref(target.href);
    if (parsed === undefined || parsed.href !== target.href) return undefined;
    if (target.kind === "project") {
      if (parsed.routeKind !== "project" || parsed.projectId !== target.projectId) return undefined;
      const projects = owner.targets.filter((candidate) => candidate.targetId === target.projectId);
      if (projects.length !== 1 || projects[0]!.state === TargetState.UNSPECIFIED) return undefined;
      return projects[0]!.displayName.trim() || "Untitled project";
    }
    if (parsed.routeKind !== "session" || parsed.sessionId !== target.sessionId
      || (target.kind === "session" && (parsed.messageId !== undefined || parsed.eventId !== undefined))
      || target.kind === "message" && (parsed.messageId !== target.messageId || parsed.eventId !== target.eventId)) {
      return undefined;
    }
    const sessions = owner.sessions.filter((candidate) => candidate.sessionId === target.sessionId);
    if (sessions.length !== 1) return undefined;
    const session = sessions[0]!;
    const revision = session.version?.revision;
    if (!session.backendId || !session.targetId || !revision || revision.value < 1n
      || session.version?.generation === undefined || session.version.generation < 1n
      || session.state === SessionState.UNSPECIFIED) return undefined;
    const epoch = this.#epoch;
    const ownerKey = composerRouteOwnerKey(credential, owner, session);
    const current = (): boolean => this.#current(epoch)
      && this.#credential === credential
      && this.#state.status === "connected"
      && this.#state.owner !== undefined
      && composerRouteOwnerKey(credential, this.#state.owner, session) === ownerKey;
    if (target.kind === "session") return session.displayName.trim() || "Untitled task";

    if (this.#state.selectedId === target.sessionId) {
      const cached = referencedMobileTimelineText([
        ...this.#state.older,
        ...(this.#state.window ?? this.#state.detail?.timeline ?? []),
        ...this.#state.live
      ], target);
      if (cached !== undefined) return cached;
    }
    if (target.eventId !== undefined) {
      try {
        const events = await this.network.readAround(credential, target.sessionId, target.eventId, this.#abort?.signal);
        if (!current()) return undefined;
        validateHistory(events, target.sessionId, owner.generation);
        if (!events.some((event) => event.eventId === target.eventId)) return undefined;
        const text = referencedMobileTimelineText(events, target);
        if (text !== undefined) return text;
      } catch {
        if (!current()) return undefined;
      }
    }
    if (target.messageId === undefined) return undefined;
    const backends = owner.backends.filter((candidate) => candidate.backendId === session.backendId);
    if (backends.length !== 1 || backends[0]!.capabilities?.capabilities.filter(
      (candidate) => candidate.name === capabilityNames.sessionTree
        && candidate.support === CapabilitySupport.SUPPORTED
    ).length !== 1) return undefined;
    try {
      const tree = await this.network.readNativeSessionTree(credential, target.sessionId, this.#abort?.signal);
      if (!current()) return undefined;
      const projected = projectMobileNativeTree({
        authorityKey: ownerKey,
        surfaceOwnerKey: ownerKey,
        session,
        backend: backends[0]!,
        canNavigate: false,
        navigationUnavailableReason: "Link enrichment is read-only."
      }, tree);
      return referencedMobileNativeTreeText(projected, target.messageId);
    } catch {
      return undefined;
    }
  }

  latest(): void { this.#clearHistory(); }

  #clearHistory(): void {
    this.#historyOwner = undefined;
    this.#set({ window: undefined, older: [], before: undefined, historyEnd: false, historyBusy: false });
  }

  async logoutConnection(connectionId: string): Promise<boolean> {
    if (this.#queueEditLease?.connectionId === connectionId) await this.#releaseQueueEditBeforeTransition();
    const connection = this.#state.owner?.connections.find((candidate) => candidate.connectionId === connectionId);
    const revision = connection?.version?.revision;
    if (!connection || !revision || revision.value < 1n) throw new Error("A current connection revision is required for logout.");
    const action = this.#claimMutation();
    try {
      return await this.#submit(create(OperationMutationSchema, {
        preconditions: [create(OperationPreconditionSchema, {
          entity: create(EntityRefSchema, { kind: EntityKind.CONNECTION, id: connectionId }),
          expectedRevision: revision
        })],
        payload: { case: "logoutConnection", value: create(LogoutConnectionMutationSchema, { connectionId }) }
      }), { kind: "logout", targetConnectionId: connectionId });
    } finally { this.#releaseMutation(action); }
  }

  async revokeDevice(deviceId: string): Promise<boolean> {
    const credential = this.#ready();
    if (deviceId === credential.deviceId) {
      throw new Error("Log out this mobile connection instead of revoking its current device from itself.");
    }
    const device = this.#state.owner?.devices.find((candidate) => candidate.deviceId === deviceId);
    const revision = device?.version?.revision;
    if (!device || device.revoked || !revision || revision.value < 1n) {
      throw new Error("A current non-revoked device revision is required.");
    }
    const action = this.#claimMutation();
    try {
      return await this.#submit(create(OperationMutationSchema, {
        preconditions: [create(OperationPreconditionSchema, {
          entity: create(EntityRefSchema, { kind: EntityKind.DEVICE, id: deviceId }),
          expectedRevision: revision
        })],
        payload: { case: "revokeDevice", value: create(RevokeDeviceMutationSchema, {
          deviceId,
          reason: "Revoked from Joko mobile"
        }) }
      }), { kind: "revoke", targetDeviceId: deviceId });
    } finally { this.#releaseMutation(action); }
  }

  async renameCurrentDevice(deviceId: string, displayName: string): Promise<boolean> {
    return await this.#changeCurrentDeviceName(deviceId, displayName.trim()) !== undefined;
  }

  async resetCurrentDevice(deviceId: string): Promise<Device | undefined> {
    return this.#changeCurrentDeviceName(deviceId);
  }

  async #changeCurrentDeviceName(deviceId: string, value?: string): Promise<Device | undefined> {
    const credential = this.#ready();
    if (value !== undefined && !validMobileDeviceName(value)) {
      throw new Error("Use a device name between 1 and 128 characters.");
    }
    if (deviceId !== credential.deviceId) throw new Error("Only the device authorizing this mobile connection can be renamed here.");
    const profiles = this.#profiles.filter((candidate) => candidate.profileId === this.#activeProfileId);
    const profile = profiles.length === 1 ? profiles[0] : undefined;
    const owner = this.#state.owner;
    const connections = owner?.connections.filter((candidate) => candidate.connectionId === credential.connectionId) ?? [];
    const devices = owner?.devices.filter((candidate) => candidate.deviceId === deviceId) ?? [];
    const connection = connections.length === 1 ? connections[0] : undefined;
    const device = devices.length === 1 ? devices[0] : undefined;
    const revision = device?.version?.revision;
    if (!profile || !credentialMatchesProfile(credential, profile)
      || this.#activeProfileId !== credential.profileId || this.#state.activeProfileId !== credential.profileId
      || this.#state.origin !== credential.origin || this.#state.node?.serverId !== credential.serverId
      || owner?.server?.serverId !== credential.serverId || owner.server.apiVersion !== this.#state.node.apiVersion
      || !connection || connection.connectionProfileId !== credential.profileId
      || connection.deviceId !== credential.deviceId || connection.state !== ConnectionState.CONNECTED
      || !device || device.revoked || device.kind !== DeviceKind.MOBILE
      || !device.connectionIds.includes(credential.connectionId)
      || !revision || revision.value < 1n) {
      throw new Error("The exact current profile, connection, mobile device, server, and Device revision are required.");
    }
    if (this.#state.pending.some((item) => item.kind === "device-rename" && item.targetDeviceId === deviceId)) {
      throw new Error("A previous change to this device still has an unresolved result.");
    }
    if (value !== undefined && device.manualDisplayName === value) return device;
    const epoch = this.#epoch;
    const signal = this.#abort?.signal;
    if (!signal) throw new Error("The current device read authority is unavailable.");
    const confirmedDevice = (operation: Operation): Device => {
      const confirmed = confirmedMobileDeviceName(operation, deviceId, credential.connectionId);
      if (value === undefined ? confirmed.manualDisplayName !== undefined : confirmed.manualDisplayName !== value) {
        throw new Error("The Joko node completed the device name change without the expected Device result.");
      }
      return confirmed;
    };
    const action = this.#claimMutation();
    try {
      const result = await this.#submitTerminal(create(OperationMutationSchema, {
        preconditions: [create(OperationPreconditionSchema, {
          entity: create(EntityRefSchema, { kind: EntityKind.DEVICE, id: deviceId }),
          expectedRevision: revision
        })],
        payload: value === undefined
          ? { case: "resetDeviceName", value: create(ResetDeviceNameMutationSchema, { deviceId }) }
          : { case: "renameDevice", value: create(RenameDeviceMutationSchema, { deviceId, displayName: value }) }
      }), { kind: "device-rename", targetDeviceId: deviceId }, undefined, true, true, {
        signal,
        isCurrent: () => this.#current(epoch) && this.#credential === credential,
        beforeTerminalReceipt: async (operation) => {
          if (operation.state === OperationState.SUCCEEDED) confirmedDevice(operation);
        }
      });
      if (!result.definitive) return undefined;
      if (!result.accepted) {
        throw new Error(result.operation?.error?.message || "The device rename was rejected.");
      }
      if (!result.operation) throw new Error("The device name operation returned no receipt.");
      return confirmedDevice(result.operation);
    } finally { this.#releaseMutation(action); }
  }

  newTaskObjectiveOwnerKey(targetId: string): string | undefined {
    const key = this.#newTaskAuthorityKey(targetId);
    return key && this.network.objectiveRpc ? `${key}\u001fobjective-create\u001f${this.#epoch}` : undefined;
  }

  newTaskModels(targetId: string) {
    if (!this.#newTaskAuthorityKey(targetId)) return [];
    const owner = this.#state.owner;
    const target = owner?.targets.find(row => row.targetId === targetId), workspace = owner?.workspaces.find(row => row.workspaceId === target?.workspaceId);
    return owner?.backends.flatMap(backend => {
      if (workspace?.location?.kind.case === "sshHost" && backend.capabilities?.capabilities.some(row => row.name === "model.remote_execution" && row.support === CapabilitySupport.SUPPORTED)) return [];
      const execution = resolveMobileNewTaskExecutionAuthority(owner, backend.backendId);
      return execution?.canSelectModel ? execution.models.map(route => ({ ...route,
        key: JSON.stringify([route.backendId, route.providerId, route.modelId]), canSetEffort: execution.canSetEffort,
        canSetFastMode: execution.canSetFastMode })) : [];
    }) ?? [];
  }

  #modelMemory(targetId: string) {
    const credential = this.#credential, owner = this.#state.owner;
    const target = owner?.targets.find(row => row.targetId === targetId);
    const nativeAdapterKind = owner?.models.find(row => row.backendId === target?.backendId && row.source?.nativeAdapterKind)?.source?.nativeAdapterKind;
    if (!credential || !nativeAdapterKind || !this.newTaskDrafts) return undefined;
    return { memory: this.#newTaskModelMemory ??= new MobileNewTaskModelMemory(this.newTaskDrafts.driver),
      identity: { profileId: credential.profileId, serverId: credential.serverId, nativeAdapterKind } };
  }

  newTaskModelSelection(targetId: string): MobileNewTaskSourceSelection | undefined {
    const owner = this.#state.owner, target = owner?.targets.find(row => row.targetId === targetId), memory = this.#modelMemory(targetId);
    const remembered = memory?.memory.current(memory.identity);
    if (remembered?.backendId === target?.backendId && resolveMobileExplicitNewTaskModelAuthority(owner, target?.backendId, remembered)) return remembered;
    const selection = resolveMobileNewTaskDefaultModelAuthority(owner, target?.backendId)?.selection;
    return selection && target ? { ...selection, backendId: target.backendId } : undefined;
  }

  async restoreNewTaskModel(targetId: string): Promise<string> {
    const authority = this.#newTaskAuthorityKey(targetId), memory = this.#modelMemory(targetId);
    if (!authority || !memory) return targetId;
    const selection = await memory.memory.read(memory.identity);
    if (this.#newTaskAuthorityKey(targetId) !== authority || !selection) return targetId;
    const owner = this.#state.owner, target = owner?.targets.find(row => row.targetId === targetId);
    if (!resolveMobileExplicitNewTaskModelAuthority(owner, selection.backendId, selection)) return targetId;
    const workspace = owner?.workspaces.find(row => row.workspaceId === target?.workspaceId);
    return owner?.targets.find(row => row.backendId === selection.backendId && row.state === TargetState.ACTIVE
      && workspace !== undefined && owner.workspaces.some(candidate => candidate.workspaceId === row.workspaceId
        && sameMobileModelSourceProject(workspace, candidate)))?.targetId ?? targetId;
  }

  async selectNewTaskModel(targetId: string, selection: MobileNewTaskSourceSelection, isCurrent: () => boolean = () => true): Promise<string> {
    const owner = this.#state.owner, authority = this.#newTaskAuthorityKey(targetId), credential = this.#ready();
    const target = owner?.targets.find(row => row.targetId === targetId), workspace = owner?.workspaces.find(row => row.workspaceId === target?.workspaceId);
    const model = resolveMobileExplicitNewTaskModelAuthority(owner, selection.backendId, selection);
    const execution = resolveMobileNewTaskExecutionAuthority(owner, selection.backendId);
    if (!target || !workspace || !model || !execution?.canSelectModel || !authority) throw new Error("The model source is unavailable for this project.");
    if (workspace.location?.kind.case === "sshHost" && owner?.backends.find(row => row.backendId === selection.backendId)?.capabilities?.capabilities
      .some(row => row.name === "model.remote_execution" && row.support === CapabilitySupport.SUPPORTED)) {
      throw new Error("This Agent source requires a project on the task computer and cannot use an SSH project.");
    }
    if (selection.effortId && !execution.canSetEffort || selection.fastMode && !execution.canSetFastMode) throw new Error("The selected model controls are unavailable.");
    const memory = this.#modelMemory(targetId);
    if (!memory) throw new Error("Model source preferences are unavailable.");
    const assertOwner = (): void => {
      if (!isCurrent() || this.#credential !== credential || this.#newTaskAuthorityKey(targetId) !== authority) throw new Error("The model source owner changed.");
    };
    let selectedTarget = owner!.targets.find(row => row.state === TargetState.ACTIVE && row.backendId === selection.backendId
      && owner!.workspaces.some(candidate => candidate.workspaceId === row.workspaceId && sameMobileModelSourceProject(workspace, candidate)))?.targetId;
    if (!selectedTarget) {
      if (this.#state.pending.some(row => row.kind === "model-source-target")) throw new Error("The previous model source project is still pending. Recover its operation before retrying.");
      const mutation = create(OperationMutationSchema, {
        preconditions: [create(OperationPreconditionSchema, { entity: { kind: EntityKind.TARGET, id: targetId }, expectedRevision: target.version?.revision })]
      });
      const location = workspace.location?.kind;
      if (location?.case === "serviceNode") {
        mutation.payload = { case: "createTarget", value: create(CreateTargetMutationSchema, { backendId: selection.backendId,
          displayName: target.displayName, workspace: create(TargetWorkspaceInputSchema, { kind: workspace.kind,
            serverPath: workspace.serverPathDisplay, createIfMissing: false }) }) };
      } else if (location?.case === "sshHost") {
        if (!this.network.listModelSourceRemoteHosts) throw new Error("The SSH Host catalog is unavailable on this node.");
        const hosts = await this.network.listModelSourceRemoteHosts(credential, location.value.hostTargetId, this.#abort?.signal); assertOwner();
        const exact = hosts.filter(row => row.targetId === location.value.hostTargetId && row.hostId === location.value.hostId);
        const hostTarget = this.#state.owner?.targets.find(row => row.targetId === location.value.hostTargetId && row.state === TargetState.ACTIVE);
        if (exact.length !== 1 || !exact[0]!.revision?.value || !hostTarget?.version?.revision?.value) throw new Error("The original SSH Host authority is unavailable.");
        if (hostTarget.targetId !== targetId) mutation.preconditions.push(create(OperationPreconditionSchema, {
          entity: { kind: EntityKind.TARGET, id: hostTarget.targetId }, expectedRevision: hostTarget.version.revision }));
        mutation.payload = { case: "createRemoteTarget", value: create(CreateRemoteTargetMutationSchema, {
          backendId: selection.backendId, displayName: target.displayName, hostTargetId: location.value.hostTargetId,
          hostId: location.value.hostId, expectedHostRevision: exact[0]!.revision,
          workspacePath: location.value.workspaceRootDisplay, createIfMissing: false }) };
      } else if (location?.case === "devicePeer") {
        if (credential.deviceId !== location.value.controllerDeviceId || !this.network.listModelSourceDevicePeers) throw new Error("The original task computer controller is unavailable.");
        const peers = await this.network.listModelSourceDevicePeers(credential, this.#abort?.signal); assertOwner();
        const exact = peers.filter(row => row.route?.targetDeviceId === location.value.targetDeviceId);
        if (exact.length !== 1 || !exact[0]!.route?.relationId || !exact[0]!.route?.routeGeneration
          || !exact[0]!.route?.relationRevision?.value || !exact[0]!.route?.targetDeviceRevision?.value) throw new Error("The original task computer route is unavailable.");
        mutation.payload = { case: "createDevicePeerTarget", value: create(CreateDevicePeerTargetMutationSchema, {
          backendId: selection.backendId, displayName: target.displayName, peer: exact[0]!.route,
          workspacePath: location.value.workspaceRootDisplay, createIfMissing: false }) };
      } else throw new Error("The original project location is unavailable.");
      assertOwner();
      const result = await this.#submitTerminal(mutation, { kind: "model-source-target", targetId, backendId: selection.backendId });
      const payload = result.operation?.result?.payload;
      if (!result.accepted || !result.definitive || payload?.case !== "target") throw new Error("The model source project result is unconfirmed. It was not resent.");
      selectedTarget = payload.value.targetId;
    }
    assertOwner();
    const destinationMemory = this.#modelMemory(selectedTarget);
    if (!destinationMemory) throw new Error("The selected model source preferences are unavailable.");
    await destinationMemory.memory.save(destinationMemory.identity, selection);
    assertOwner();
    return selectedTarget;
  }

  async addNewTaskModelFavorite(targetId: string, selection: MobileNewTaskSourceSelection): Promise<void> {
    const owner = this.#state.owner;
    if (!this.#newTaskAuthorityKey(targetId) || !resolveMobileExplicitNewTaskModelAuthority(owner, selection.backendId, selection)) {
      throw new Error("The model source is no longer available.");
    }
    if (owner?.models.find(model => model.backendId === selection.backendId && model.key?.providerId === selection.providerId
      && model.key.modelId === selection.modelId)?.source?.kind === ModelSourceKind.SHARE) throw new Error("Shared model favorites are unavailable on mobile.");
    const settings = owner?.settings?.modelFavorites;
    if (!settings?.revision) throw new Error("Model favorites are unavailable.");
    if (settings.favorites.some(favorite => favorite.backendId === selection.backendId && favorite.selection?.model?.providerId === selection.providerId
      && favorite.selection.model.modelId === selection.modelId && (favorite.selection.effortId || "") === (selection.effortId ?? "")
        && decodeModelSpeed(favorite.selection) === selection.fastMode)) throw new Error("The same model favorite configuration is already saved.");
    if (this.#state.pending.some(row => row.kind === "model-favorite")) throw new Error("The previous favorite change is still pending.");
    const result = await this.#submitTerminal(create(OperationMutationSchema, { payload: { case: "updateModelFavorites", value: create(UpdateModelFavoritesMutationSchema, {
      expectedRevision: settings.revision, change: { case: "add", value: create(ModelFavoriteConfigurationSchema, {
        favoriteId: this.newModelFavoriteId(), backendId: selection.backendId, selection: create(ModelSelectionSchema, {
          model: create(ModelKeySchema, { providerId: selection.providerId, modelId: selection.modelId }),
          effortId: selection.effortId ?? "", ...encodeModelSpeed(selection.fastMode) }) }) } }) } }), { kind: "model-favorite" });
    if (!result.accepted || !result.definitive) throw new Error("The model favorite result is unconfirmed. It was not resent.");
  }

  async create(targetId: string, name: string, firstInput: MobileComposerDraft, objective?: MobileObjectiveInput, collaboration?: MobileWorkerForm,
    uploadObserver?: MobileNewTaskUploadObserver): Promise<MobileNewTaskResult> {
    const input = normalizeMobileComposerDraft(firstInput);
    const objectiveInput = objective === undefined ? undefined : normalizeMobileObjectiveInput(objective);
    const workerForm = collaboration === undefined ? undefined : normalizeMobileWorkerForm(collaboration);
    if (workerForm && (!this.newTaskCollaborationOwnerKey(targetId) || workerForm.sourceScope !== this.newTaskCollaborationScope(targetId, workerForm.targetId))) throw new Error("The collaboration projects or saved node changed. Confirm the retained configuration again.");
    if (!input.text.trim() && input.attachments.length === 0 && objectiveInput === undefined) {
      throw new Error("Enter a first message or attach a file for this task.");
    }
    if (objectiveInput === undefined && input.mentions.some((mention) => mention.kind === "resource" || mention.kind === "artifact")) {
      throw new Error("A new task cannot reference runtime Resources or Artifacts before its Session exists.");
    }
    if (name.length > 256) throw new Error("Use a task name no longer than 256 characters.");
    if (!this.newTaskDrafts || !this.composerDrafts) {
      throw new Error("Retained new-task drafts are unavailable on this mobile client.");
    }
    if (this.#state.pending.some((item) => item.kind === "create")) {
      throw new Error("A previous task creation is still pending. Check its operation before creating another task.");
    }
    const owner = this.#state.owner;
    const target = owner?.targets.find((candidate) => candidate.targetId === targetId);
    const backend = owner?.backends.find((candidate) => candidate.backendId === target?.backendId);
    const targetRevision = target?.version?.revision;
    if (!target || !backend || target.state !== TargetState.ACTIVE || !supportsText(backend)
      || !targetRevision || targetRevision.value < 1n) {
      throw new Error("Select an active target with text input support.");
    }
    const credential = this.#ready();
    const node = this.#state.node;
    if (!node || node.serverId !== credential.serverId || this.#activeProfileId !== credential.profileId) {
      throw new Error("Reconnect to the exact saved Joko node before creating a task.");
    }
    const authorityKey = this.#newTaskAuthorityKey(targetId);
    if (!authorityKey) throw new Error("The selected project authority is unavailable.");
    const receivingModel = resolveMobileExplicitNewTaskModelAuthority(owner, backend.backendId, this.newTaskModelSelection(targetId))
      ?? resolveMobileNewTaskDefaultModelAuthority(owner, backend.backendId);
    const attachmentControls = this.newTaskAttachmentControls(targetId);
    if (objectiveInput === undefined && input.attachments.length > 0) {
      if (!attachmentControls) throw new Error("This Backend does not accept attachments for a new task.");
      assertMobileAttachmentPolicy(input.attachments, attachmentControls.policy);
    }
    if (objectiveInput === undefined) {
      assertMobileSessionMentionDraft(this.newTaskSessionMentionControls(targetId), input);
      assertMobileWorkspaceMentionDraft(this.newTaskWorkspaceMentionControls(targetId), input);
      assertMobileWorkspacePathPasteDraft(this.newTaskWorkspacePathPasteControls(targetId), input);
    }
    const identity = { profileId: credential.profileId } satisfies MobileNewTaskDraftIdentity;
    const createOperationId = this.newId();
    const action = this.#claimMutation();
    this.#newTaskSubmissionActive = true;
    this.#newTaskUploadObserver = uploadObserver;
    try {
      const submission = await this.newTaskDrafts.beginSubmission(identity, { targetId, name, input, ...(workerForm ? { collaboration: workerForm } : {}) }, {
        connectionId: credential.connectionId,
        serverId: credential.serverId,
        backendId: target.backendId,
        targetRevision: targetRevision.value.toString(10),
        ...(targetRevision.etag === "" ? {} : { targetRevisionEtag: targetRevision.etag }),
        model: receivingModel?.selection ?? null,
        ...(objectiveInput === undefined ? {} : { objective: objectiveInput }),
        ...(workerForm === undefined ? {} : { collaboration: workerForm }),
        createOperationId
      });
      if (uploadObserver?.optimisticConversation && objectiveInput === undefined) {
        await this.newTaskDrafts.openConversation(identity, createOperationId);
      }
      try {
        await this.network.prepareTarget(credential, target, this.#abort?.signal);
        if (objectiveInput === undefined) await this.#validateNewTaskSubmissionInput(submission, authorityKey);
        else this.#assertNewTaskCreateAuthority(submission);
      } catch (error) {
        await this.newTaskDrafts.clearSubmission(identity, createOperationId).catch(() => undefined);
        throw error;
      }
      const result = await this.#submitTerminal(
        this.#newTaskCreateMutation(submission),
        { kind: "create" },
        createOperationId
      );
      if (this.#mutationOwner === action) this.#set({ busy: true });
      return await this.#continueNewTaskCreation(identity, submission, result);
    } finally {
      uploadObserver?.onUploadingChange(false);
      this.#newTaskUploadObserver = undefined;
      this.#newTaskSubmissionActive = false;
      this.#releaseMutation(action);
    }
  }

  #newTaskCreateMutation(submission: MobileNewTaskCreateSubmission): OperationMutation {
    return create(OperationMutationSchema, {
      preconditions: [create(OperationPreconditionSchema, {
        entity: create(EntityRefSchema, { kind: EntityKind.TARGET, id: submission.targetId }),
        expectedRevision: create(RevisionSchema, {
          value: BigInt(submission.targetRevision),
          ...(submission.targetRevisionEtag === undefined ? {} : { etag: submission.targetRevisionEtag })
        })
      })],
      payload: { case: "createSession", value: create(CreateSessionMutationSchema, {
        backendId: submission.backendId,
        targetId: submission.targetId,
        displayName: submission.displayName,
        nativeStart: create(NativeSessionStartSchema, {
          kind: { case: "newSession", value: create(NewNativeSessionSchema, { parentNativeReference: "" }) }
        }),
        ...(submission.model === null ? {} : {
          model: create(ModelSelectionSchema, {
            model: create(ModelKeySchema, {
              providerId: submission.model.providerId,
              modelId: submission.model.modelId
            }),
            effortId: submission.model.effortId ?? "",
            ...encodeModelSpeed(submission.model.fastMode)
          })
        }),
        permissionMode: PermissionMode.ASK,
        initialPlacement: NativeSessionPlacement.PROJECT
      }) }
    });
  }

  #assertNewTaskCreateAuthority(submission: MobileNewTaskSubmission, owner = this.#state.owner): void {
    const credential = this.#ready();
    const target = uniqueValue(owner?.targets ?? [], (candidate) => candidate.targetId === submission.targetId);
    const backend = uniqueValue(owner?.backends ?? [], (candidate) => candidate.backendId === submission.backendId);
    const model = submission.model === null
      ? undefined
      : resolveMobileExplicitNewTaskModelAuthority(owner, submission.backendId, submission.model);
    const revision = target?.version?.revision;
    if (credential.connectionId !== submission.connectionId || credential.serverId !== submission.serverId
      || this.#activeProfileId !== credential.profileId || this.#state.node?.serverId !== submission.serverId
      || !target || target.backendId !== submission.backendId || target.state !== TargetState.ACTIVE
      || !revision || revision.value.toString(10) !== submission.targetRevision
      || (revision.etag || undefined) !== submission.targetRevisionEtag
      || !backend || !supportsText(backend) || submission.model !== null && !model) {
      throw new Error("The project or Backend changed while this task was being prepared. Review the retained draft and try again.");
    }
  }

  async #continueNewTaskCreation(
    identity: MobileNewTaskDraftIdentity,
    submission: MobileNewTaskCreateSubmission,
    result: TrackedMutationResult
  ): Promise<MobileNewTaskResult> {
    if (!this.newTaskDrafts || !this.composerDrafts) throw new Error("Retained new-task drafts are unavailable.");
    if (!result.definitive) return { created: false, sent: false, definitive: false };
    const operation = result.operation;
    if (!result.accepted || operation?.state !== OperationState.SUCCEEDED) {
      await this.newTaskDrafts.clearSubmission(identity, submission.createOperationId);
      return { created: false, sent: false, definitive: true };
    }
    const session = this.#createdNewTaskSession(operation, submission);
    if (!session) {
      await this.newTaskDrafts.clearSubmission(identity, submission.createOperationId);
      this.#set({ error: "The task creation succeeded without an exact Joko Session result. The first message was not sent; the draft was retained." });
      return { created: false, sent: false, definitive: true };
    }
    const generation = session.nativeBinding!.runtimeGeneration;
    const sending = await this.newTaskDrafts.advanceToSending(
      identity,
      submission.createOperationId,
      session.sessionId,
      generation
    );
    await this.#selectCreatedNewTask(sending);
    return this.#finishNewTaskPreparation(identity, sending);
  }

  async #finishNewTaskPreparation(identity: MobileNewTaskDraftIdentity, initial: MobileNewTaskSendSubmission): Promise<MobileNewTaskResult> {
    let submission = initial;
    let collaborationError: string | undefined;
    if (submission.collaboration && !submission.collaborationHandled) {
      const epoch = this.#epoch, signal = this.#abort!.signal, credential = this.#ready();
      const recoveryIdentity: MobileWorkerFormIdentity = { profileId: identity.profileId, connectionId: submission.connectionId,
        serverId: submission.serverId, sessionId: submission.sessionId, generation: submission.runtimeGeneration };
      // Mark this one preparation attempt before any service side effect. Restart only observes receipts.
      submission = await this.newTaskDrafts!.markCollaborationHandled(identity, submission.createOperationId);
      try {
        if (credential.profileId !== identity.profileId || credential.connectionId !== submission.connectionId || credential.serverId !== submission.serverId) throw new Error("The retained collaboration belongs to another saved node.");
        const form = normalizeMobileWorkerForm({ ...submission.collaboration!, initialTask: mobileWorkerInitialTask(submission.collaboration!.initialTask, submission.input.text) });
        await this.workerStorage()?.save(recoveryIdentity, form);
        if (!this.#current(epoch) || signal.aborted) return { created: true, sent: false, definitive: false, sessionId: submission.sessionId };
        const api = this.#collaborationApi(true);
        if (form.sourceScope !== this.newTaskCollaborationScope(submission.targetId, form.targetId)) throw new Error("The configured collaboration projects changed before creation. Review the retained worker form.");
        if (!api || api.sessionId !== submission.sessionId || api.generation.toString() !== submission.runtimeGeneration) throw new Error("The original created task must reconnect before enabling its team.");
        await api.enable(form, signal);
      } catch (error) {
        if (!this.#current(epoch) || signal.aborted) return { created: true, sent: false, definitive: false, sessionId: submission.sessionId };
        collaborationError = `The task was created. Collaboration was not confirmed; its form is retained. ${message(error)}`;
      }
    }
    const result = submission.objective !== undefined ? await this.#finishNewTaskObjective(identity, submission) : await this.#sendNewTaskFirstInput(identity, submission);
    if (collaborationError && this.#state.selectedId === submission.sessionId && this.#credential?.connectionId === submission.connectionId) this.#set({ error: collaborationError });
    return result;
  }

  async #finishNewTaskObjective(identity: MobileNewTaskDraftIdentity, initial: MobileNewTaskSendSubmission): Promise<MobileNewTaskResult> {
    const input = initial.objective!;
    const credential = this.#ready(), epoch = this.#epoch, request = this.#abort!.signal;
    if (credential.profileId !== identity.profileId || credential.connectionId !== initial.connectionId || credential.serverId !== initial.serverId) {
      throw new Error("The retained objective belongs to another saved node.");
    }
    const current = (): boolean => !request.aborted && this.#current(epoch) && this.#credential === credential;
    const result = (definitive: boolean, sent = false): MobileNewTaskResult => ({ sessionId: initial.sessionId, created: true, sent, definitive });
    const recoveryIdentity: MobileObjectiveRecoveryIdentity = { profileId: identity.profileId, connectionId: initial.connectionId,
      serverId: initial.serverId, sessionId: initial.sessionId, generation: initial.runtimeGeneration };
    const recovery = new MobileObjectiveRecovery(this.newTaskDrafts!.driver);
    await recovery.save(recoveryIdentity, input);
    if (!current()) return result(false);
    const retainInput = async (): Promise<void> => {
      if (initial.input.text || initial.input.attachments.length) await this.#recoverNewTaskComposerDraft(identity, initial.sessionId, initial.input);
    };
    if (initial.objectiveRequestId !== undefined) {
      // Resume observes the original request only; it never sets the goal again.
      const operation = await this.network.getServiceOperation?.(credential, initial.objectiveRequestId, request);
      if (!current()) return result(false);
      if (operation?.operationId !== initial.objectiveRequestId || !isTerminal(operation.state)) return result(false);
      if (operation.state !== OperationState.SUCCEEDED) {
        await retainInput(); await this.newTaskDrafts!.clear(identity); return result(true);
      }
      await recovery.clear(recoveryIdentity); await this.newTaskDrafts!.clear(identity); return result(true, true);
    }
    const authority = this.#newTaskSendAuthority(initial);
    if (authority.status !== "ready") { await retainInput(); this.#set({ error: authority.message }); return result(false); }
    const api = this.taskObjectiveApi();
    if (!api || api.sessionId !== initial.sessionId || api.generation.toString() !== initial.runtimeGeneration) {
      await retainInput(); this.#set({ error: "The task was created. Its objective form is retained until the original task reconnects." }); return result(false);
    }
    const requestId = this.newId();
    await this.newTaskDrafts!.setObjectiveRequest(identity, initial.createOperationId, requestId);
    try {
      await this.#assertObjectiveWritable(api.ownerKey, this.#abort!.signal);
      const rpc = this.network.objectiveRpc!(this.#ready(), api.sessionId, api.generation, signal => this.#assertObjectiveOwner(api.ownerKey, signal));
      if (await rpc.get(this.#abort!.signal)) throw new Error("The created task already has an objective. Review its current state.");
      await this.#recordObjectiveEffect("objective-set", api.sessionId, requestId, api.ownerKey, this.#abort!.signal,
        signal => rpc.set(input, requestId, signal));
      await recovery.clear(recoveryIdentity); await this.newTaskDrafts!.clear(identity);
      for (const attachment of initial.input.attachments) await this.attachmentFiles?.remove(identity.profileId, attachment).catch(() => undefined);
      return result(true, true);
    } catch (error) {
      await retainInput(); if (current()) this.#set({ error: message(error) });
      // The form's limits survive app restart even when the creation sheet retires.
      await this.newTaskDrafts!.clear(identity);
      return result(!this.#state.pending.some(value => value.operationId === requestId));
    }
  }

  #createdNewTaskSession(operation: Operation, submission: MobileNewTaskCreateSubmission): Session | undefined {
    const session = operation.result?.payload.case === "session" ? operation.result.payload.value : undefined;
    const generation = session?.nativeBinding?.runtimeGeneration;
    if (operation.operationId !== submission.createOperationId || operation.connectionId !== submission.connectionId
      || !session || !session.sessionId || session.backendId !== submission.backendId || session.targetId !== submission.targetId
      || !generation || generation < 1n
      || submission.model !== null && !sameMobileModelSelection(submission.model, session.model)) return undefined;
    return session;
  }

  async #recoverNewTaskComposerDraft(
    identity: MobileNewTaskDraftIdentity,
    sessionId: string,
    input: MobileComposerDraft
  ): Promise<void> {
    if (!this.composerDrafts) throw new Error("The task composer draft store is unavailable.");
    const composerIdentity = { profileId: identity.profileId, sessionId };
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const snapshot = await this.composerDrafts.readSnapshot(composerIdentity);
      const recovered = recoverMobileComposerDraft(input, snapshot.draft);
      if (snapshot.draft !== undefined && mobileComposerDraftsEqual(recovered, snapshot.draft)) {
        await this.composerDrafts.flush(composerIdentity);
        return;
      }
      if (this.composerDrafts.saveIfRevision(composerIdentity, recovered, snapshot.revision)) {
        await this.composerDrafts.flush(composerIdentity);
        return;
      }
    }
    throw new Error("The created task draft kept changing while the first message was being restored.");
  }

  async #removeRecoveredNewTaskComposerDraft(
    identity: MobileNewTaskDraftIdentity,
    sessionId: string,
    input: MobileComposerDraft
  ): Promise<boolean> {
    if (!this.composerDrafts) throw new Error("The task composer draft store is unavailable.");
    const composerIdentity = { profileId: identity.profileId, sessionId };
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const snapshot = await this.composerDrafts.readSnapshot(composerIdentity);
      if (snapshot.draft === undefined) return true;
      const remainder = mobileComposerDraftWithoutPrefix(input, snapshot.draft);
      if (remainder === undefined) return false;
      const updated = remainder.text.length === 0 && remainder.mentions.length === 0
        && remainder.attachments.length === 0
        ? await this.composerDrafts.clearIfRevision(composerIdentity, snapshot.revision)
        : this.composerDrafts.saveIfRevision(composerIdentity, remainder, snapshot.revision);
      if (updated) {
        await this.composerDrafts.flush(composerIdentity);
        return true;
      }
    }
    throw new Error("The created task draft kept changing while the accepted first message was being removed.");
  }

  async #selectCreatedNewTask(submission: MobileNewTaskSendSubmission): Promise<void> {
    if (this.#state.selectedId !== submission.sessionId || this.#state.detail?.sessions.some(
      (candidate) => candidate.sessionId === submission.sessionId
    ) !== true) {
      await this.select(submission.sessionId);
    }
    if (this.#mutationOwner !== undefined) this.#set({ busy: true });
  }

  #newTaskSendAuthority(submission: MobileNewTaskSendSubmission):
    | { readonly status: "ready"; readonly session: Session }
    | { readonly status: "deferred" | "blocked"; readonly message: string } {
    const credential = this.#credential;
    if (!credential || this.#activeProfileId !== credential.profileId
      || credential.connectionId !== submission.connectionId || credential.serverId !== submission.serverId) {
      return { status: "blocked", message: "The saved Joko connection changed before the first message could be sent." };
    }
    if (!this.#foreground || this.#state.status !== "connected" || !this.#state.owner) {
      return { status: "deferred", message: "The task was created. Its first message is retained until this Joko node reconnects." };
    }
    if (this.#state.node?.serverId !== submission.serverId) {
      return { status: "blocked", message: "The Joko node identity changed before the first message could be sent." };
    }
    const session = this.#state.owner.sessions.find((candidate) => candidate.sessionId === submission.sessionId);
    if (!session) {
      return { status: "deferred", message: "The task was created. Its first message is retained until the new task appears in the authoritative snapshot." };
    }
    const detail = this.#state.detail;
    const detailSession = detail?.sessions.find((candidate) => candidate.sessionId === submission.sessionId);
    if (!detail || detail.generation !== this.#state.owner.generation || !detailSession) {
      return { status: "deferred", message: "The task was created. Its first message is retained until the authoritative task detail is synchronized." };
    }
    const target = this.#state.owner.targets.find((candidate) => candidate.targetId === submission.targetId);
    const backend = this.#state.owner.backends.find((candidate) => candidate.backendId === submission.backendId);
    const generation = session.nativeBinding?.runtimeGeneration;
    const detailGeneration = detailSession.nativeBinding?.runtimeGeneration;
    if (session.backendId !== submission.backendId || session.targetId !== submission.targetId
      || detailSession.backendId !== submission.backendId || detailSession.targetId !== submission.targetId
      || !target
      || target.backendId !== submission.backendId || !backend || !supportsText(backend)
      || !generation || !detailGeneration || generation !== detailGeneration
      || generation.toString(10) !== submission.runtimeGeneration
      || submission.model !== null && (
        !sameMobileModelSelection(submission.model, session.model)
        || !sameMobileModelSelection(submission.model, detailSession.model)
      )) {
      return { status: "blocked", message: "The created task runtime changed before its first message could be sent. The text remains in the task composer for review." };
    }
    if (submission.input.attachments.length > 0) {
      const controls = this.taskAttachmentControls();
      if (!controls) {
        return { status: "blocked", message: "The created task Backend no longer accepts the retained attachments. They remain in the task composer for review." };
      }
      try { assertMobileAttachmentPolicy(submission.input.attachments, controls.policy); }
      catch {
        return { status: "blocked", message: "The created task attachment capability changed. The retained input remains in the task composer for review." };
      }
    }
    return { status: "ready", session };
  }

  async #sendNewTaskFirstInput(
    identity: MobileNewTaskDraftIdentity,
    initial: MobileNewTaskSendSubmission
  ): Promise<MobileNewTaskResult> {
    if (!this.newTaskDrafts || !this.composerDrafts) throw new Error("Retained new-task drafts are unavailable.");
    if (initial.sendOperationId === undefined) await this.#selectCreatedNewTask(initial);
    const authority = this.#newTaskSendAuthority(initial);
    if (authority.status === "deferred") {
      this.#set({ error: authority.message });
      return { sessionId: initial.sessionId, created: true, sent: false, definitive: false };
    }
    if (authority.status === "blocked") {
      await this.#releaseNewTaskConversation(identity, initial, true);
      this.#set({ error: authority.message });
      return { sessionId: initial.sessionId, created: true, sent: false, definitive: true };
    }
    const dispatchCredential = this.#ready(), dispatchEpoch = this.#epoch, dispatchSignal = this.#abort!.signal;
    const dispatchCurrent = (): boolean => !dispatchSignal.aborted && this.#current(dispatchEpoch)
      && this.#credential === dispatchCredential && this.#newTaskSendAuthority(initial).status === "ready";
    let prepared = initial;
    const uploadObserver = initial.input.attachments.some(attachment => attachment.state === "local") ? this.#newTaskUploadObserver : undefined;
    try {
      await this.#validateNewTaskSubmissionInput(initial);
      if (initial.input.attachments.some(attachment => attachment.state === "local")) uploadObserver?.onUploadingChange(true);
      prepared = await this.#uploadNewTaskAttachments(identity, initial);
      if (uploadObserver && (await uploadObserver.waitForLeaveDecision() || uploadObserver.signal.aborted)) {
        throw new Error("Attachment upload was cancelled. The first message remains in its task draft.");
      }
      uploadObserver?.onUploadingChange(false);
    } catch (error) {
      const retained = this.newTaskDrafts.readSync(identity)?.submission;
      const recovery = retained?.phase === "sending" && retained.createOperationId === initial.createOperationId
        ? retained
        : prepared;
      await this.#releaseNewTaskConversation(identity, recovery, true);
      throw error;
    }
    const sendOperationId = prepared.sendOperationId ?? this.newId();
    const submission = prepared.sendOperationId === undefined
      ? await this.newTaskDrafts.setSendOperation(identity, prepared.createOperationId, sendOperationId)
      : prepared;
    const result = await this.#submitTerminal(create(OperationMutationSchema, {
      preconditions: [create(OperationPreconditionSchema, {
        entity: create(EntityRefSchema, { kind: EntityKind.SESSION, id: submission.sessionId }),
        expectedGeneration: BigInt(submission.runtimeGeneration)
      })],
      payload: { case: "sendInput", value: create(SendInputMutationSchema, {
        sessionId: submission.sessionId,
        input: mobileComposerInput(submission.input),
        deliveryMode: QueueDeliveryMode.PROMPT
      }) }
    }), { kind: "send", sessionId: submission.sessionId }, sendOperationId, true, true, {
      signal: dispatchSignal, isCurrent: dispatchCurrent
    });
    return this.#finishNewTaskFirstInput(identity, submission, result);
  }

  async #uploadNewTaskAttachments(
    identity: MobileNewTaskDraftIdentity,
    initial: MobileNewTaskSendSubmission,
    followUpOperationId?: string
  ): Promise<MobileNewTaskSendSubmission> {
    if (!this.newTaskDrafts) throw new Error("Retained new-task drafts are unavailable.");
    if (initial.input.attachments.every((attachment) => attachment.state === "uploaded")) return initial;
    if (!this.attachmentFiles) throw new Error("Staged mobile attachment bytes are unavailable.");
    const signal = this.#newTaskUploadObserver
      ? AbortSignal.any([this.#abort!.signal, this.#newTaskUploadObserver.signal]) : this.#abort?.signal;
    let submission = initial;
    const initialControls = this.taskAttachmentControls();
    if (!initialControls || initialControls.profileId !== identity.profileId) {
      throw new Error("The created task attachment authority is unavailable.");
    }
    assertMobileAttachmentPolicy(submission.input.attachments, initialControls.policy);
    for (const candidate of submission.input.attachments) {
      if (candidate.state === "uploaded") continue;
      const attachment = candidate as MobileLocalComposerAttachment;
      const authority = this.#newTaskSendAuthority(submission);
      const controls = this.taskAttachmentControls();
      if (authority.status !== "ready" || !controls
        || controls.surfaceOwnerKey !== initialControls.surfaceOwnerKey
        || controls.profileId !== identity.profileId) {
        throw new Error("The created task changed while an attachment was being prepared.");
      }
      assertMobileAttachmentPolicy(submission.input.attachments, controls.policy);
      signal?.throwIfAborted();
      const source = await this.attachmentFiles.verifyForUpload(identity.profileId, attachment, signal);
      signal?.throwIfAborted();
      const blob = await this.network.uploadBlob(this.#ready(), source, signal);
      signal?.throwIfAborted();
      const currentControls = this.taskAttachmentControls();
      if (this.#newTaskSendAuthority(submission).status !== "ready" || !currentControls
        || currentControls.surfaceOwnerKey !== initialControls.surfaceOwnerKey
        || currentControls.profileId !== identity.profileId) {
        throw new Error("The created task changed while an attachment was uploading.");
      }
      const uploaded = this.#uploadedAttachment(attachment, blob);
      const input = normalizeMobileComposerDraft({
        ...submission.input,
        attachments: replaceMobileComposerAttachment(
          submission.input.attachments,
          attachment.attachmentId,
          uploaded
        )
      });
      const next = followUpOperationId === undefined
        ? await this.newTaskDrafts.replaceSubmissionInput(identity, submission.createOperationId, submission.input, input)
        : await this.newTaskDrafts.updateFollowUp(identity, submission.createOperationId, followUpOperationId, { input })
          .then(() => ({ ...submission, input }));
      if (next.phase !== "sending") throw new Error("The retained new-task send phase changed.");
      submission = next;
      await this.#removeCommittedAttachmentFile(identity.profileId, attachment);
    }
    return submission;
  }

  async #finishNewTaskFirstInput(
    identity: MobileNewTaskDraftIdentity,
    submission: MobileNewTaskSendSubmission,
    result: TrackedMutationResult
  ): Promise<MobileNewTaskResult> {
    if (!this.newTaskDrafts || !this.composerDrafts) throw new Error("Retained new-task drafts are unavailable.");
    if (!result.definitive) {
      if (!this.newTaskDrafts.readSync(identity)?.conversation) {
        await this.#recoverNewTaskComposerDraft(identity, submission.sessionId, submission.input);
      }
      return { sessionId: submission.sessionId, created: true, sent: false, definitive: false };
    }
    if (!result.accepted || result.operation?.state !== OperationState.SUCCEEDED) {
      await this.#releaseNewTaskConversation(identity, submission, true);
      return { sessionId: submission.sessionId, created: true, sent: false, definitive: true };
    }
    const exactOperation = submission.sendOperationId !== undefined
      && result.operation.operationId === submission.sendOperationId
      && result.operation.connectionId === submission.connectionId;
    const queued = exactOperation && result.operation.result?.payload.case === "queueItem"
      ? result.operation.result.payload.value
      : undefined;
    if (!queued || queued.sessionId !== submission.sessionId || queued.backendId !== submission.backendId
      || queued.targetId !== submission.targetId) {
      await this.#releaseNewTaskConversation(identity, submission, true);
      this.#set({ error: "The first-message operation returned an invalid queue result. The text remains in the task composer; verify the task before sending again." });
      return { sessionId: submission.sessionId, created: true, sent: false, definitive: true };
    }
    const recoveredInputRemoved = await this.#removeRecoveredNewTaskComposerDraft(
      identity,
      submission.sessionId,
      submission.input
    );
    if (recoveredInputRemoved) {
      await this.#removeCommittedAnnotationSources(identity.profileId, submission.input.attachments);
    }
    const conversation = this.newTaskDrafts.readSync(identity)?.conversation;
    if (conversation) {
      const confirmed = await this.newTaskDrafts.markFirstInputAccepted(identity, submission.createOperationId);
      return this.#sendNewTaskFollowUps(identity, confirmed);
    }
    await this.newTaskDrafts.clear(identity);
    return { sessionId: submission.sessionId, created: true, sent: true, definitive: true };
  }

  async #releaseNewTaskConversation(identity: MobileNewTaskDraftIdentity, submission: MobileNewTaskSendSubmission,
    includeFirst: boolean): Promise<void> {
    if (!this.newTaskDrafts) throw new Error("The new-task draft store is unavailable.");
    const current = this.newTaskDrafts.readSync(identity);
    if (current?.submission?.createOperationId !== submission.createOperationId) throw new Error("The retained creation owner changed.");
    const sealed = current.conversation ? await this.newTaskDrafts.sealConversation(identity, submission.createOperationId) : current;
    const input = mergeMobileNewTaskUnsentInput(sealed, includeFirst);
    if (input.text.trim() || input.attachments.length) await this.#recoverNewTaskComposerDraft(identity, submission.sessionId, input);
    await this.newTaskDrafts.clear(identity);
  }

  async #sendNewTaskFollowUps(identity: MobileNewTaskDraftIdentity, submission: MobileNewTaskSendSubmission): Promise<MobileNewTaskResult> {
    const store = this.newTaskDrafts!;
    const result = (definitive: boolean, sent: boolean): MobileNewTaskResult => ({ sessionId: submission.sessionId, created: true, sent, definitive });
    for (;;) {
      const current = store.readSync(identity);
      if (current?.submission?.createOperationId !== submission.createOperationId) throw new Error("The retained conversation owner changed.");
      const followUp = current.conversation?.followUps.find(item => item.state !== "accepted");
      if (!followUp || current.conversation?.sealed) {
        await this.#releaseNewTaskConversation(identity, submission, false);
        return result(true, true);
      }
      let receipt: TrackedMutationResult;
      if (followUp.state === "dispatching") {
        const observed = await this.#observeRetainedNewTaskOperation({ ...submission, sendOperationId: followUp.operationId }, this.#epoch);
        if (!observed) return result(false, false);
        if (observed === "not-dispatched") {
          await this.#releaseNewTaskConversation(identity, submission, false);
          this.#set({ error: "The retained follow-up had no durable operation receipt. Its input remains in the created task composer for review." });
          return result(true, false);
        }
        receipt = trackedOperation(observed);
      } else {
        const authority = this.#newTaskSendAuthority({ ...submission, input: followUp.input });
        if (authority.status === "deferred") { this.#set({ error: authority.message }); return result(false, false); }
        if (authority.status === "blocked") {
          await this.#releaseNewTaskConversation(identity, submission, false);
          this.#set({ error: authority.message }); return result(true, false);
        }
        const dispatchCredential = this.#ready(), dispatchEpoch = this.#epoch, dispatchSignal = this.#abort!.signal;
        const dispatchCurrent = (): boolean => !dispatchSignal.aborted && this.#current(dispatchEpoch)
          && this.#credential === dispatchCredential && this.#newTaskSendAuthority({ ...submission, input: followUp.input }).status === "ready";
        let prepared: MobileNewTaskSendSubmission;
        try {
          await this.#validateNewTaskSubmissionInput({ ...submission, input: followUp.input });
          prepared = await this.#uploadNewTaskAttachments(identity, { ...submission, input: followUp.input }, followUp.operationId);
        } catch (error) {
          await this.#releaseNewTaskConversation(identity, submission, false);
          throw error;
        }
        await store.updateFollowUp(identity, submission.createOperationId, followUp.operationId, { state: "dispatching" });
        receipt = await this.#submitTerminal(create(OperationMutationSchema, {
          preconditions: [create(OperationPreconditionSchema, { entity: create(EntityRefSchema, { kind: EntityKind.SESSION, id: submission.sessionId }),
            expectedGeneration: BigInt(submission.runtimeGeneration) })],
          payload: { case: "sendInput", value: create(SendInputMutationSchema, { sessionId: submission.sessionId,
            input: mobileComposerInput(prepared.input), deliveryMode: QueueDeliveryMode.PROMPT }) }
        }), { kind: "send", sessionId: submission.sessionId }, followUp.operationId, true, true, {
          signal: dispatchSignal, isCurrent: dispatchCurrent
        });
      }
      if (!receipt.definitive) return result(false, false);
      const operation = receipt.operation, queued = operation?.result?.payload.case === "queueItem" ? operation.result.payload.value : undefined;
      if (!receipt.accepted || operation?.state !== OperationState.SUCCEEDED || operation.operationId !== followUp.operationId
        || operation.connectionId !== submission.connectionId || !queued || queued.sessionId !== submission.sessionId
        || queued.backendId !== submission.backendId || queued.targetId !== submission.targetId) {
        await this.#releaseNewTaskConversation(identity, submission, false);
        this.#set({ error: "The follow-up was not confirmed. Its structured input remains in the created task composer for review." });
        return result(true, false);
      }
      await store.updateFollowUp(identity, submission.createOperationId, followUp.operationId, { state: "accepted" });
      const accepted = store.readSync(identity)?.conversation?.followUps.find(item => item.operationId === followUp.operationId);
      if (accepted) await this.#removeCommittedAnnotationSources(identity.profileId, accepted.input.attachments);
    }
  }

  async send(draft: MobileComposerDraft, observer: MobileTaskSendObserver = {}): Promise<boolean> {
    if (!this.#joinedTask && this.#taskOutbox && (this.#state.status === "offline"
      || this.taskOutboxItems().length > 0)) return this.#enqueueTaskOutbox(draft, observer);
    const exactDraft = normalizeMobileComposerDraft(draft);
    const sentAt = this.now();
    const sessionId = this.#state.selectedId;
    const session = this.#state.detail?.sessions.find((item) => item.sessionId === sessionId);
    const backend = this.#selectedBackend(session);
    const generation = session?.nativeBinding?.runtimeGeneration;
    if (exactDraft.replyQuote && exactDraft.replyQuote.generation !== generation?.toString()) throw new Error('The reply belongs to the original task generation.');
    if ((!exactDraft.text.trim() && exactDraft.attachments.length === 0)
      || !sessionId || !session || !backend || !supportsText(backend) || !generation || generation < 1n) {
      throw new Error("A current task generation and a message or attachment are required.");
    }
    if (this.#state.pending.some((item) => item.kind === "send" && item.sessionId === sessionId && item.state === "unknown")) {
      throw new Error("The previous input has an unknown result. Check its operation before sending another message.");
    }
    const credential = this.#ready();
    const authorityKey = this.#taskAuthorityKey();
    if (!authorityKey) throw new Error("The current task authority is unavailable.");
    const epoch = this.#epoch, signal = this.#abort!.signal, sourceGeneration = this.#taskGeneration();
    const connectionCurrent = (): boolean => this.#current(epoch) && !signal.aborted && this.#foreground
      && this.#state.status === "connected" && this.#credential === credential;
    const isCurrent = (): boolean => {
      const current = this.#selectedSession();
      return connectionCurrent() && this.#taskGeneration() === sourceGeneration && this.#state.selectedId === sessionId
        && current?.sessionId === sessionId && current.backendId === session.backendId && current.targetId === session.targetId
        && current.nativeBinding?.runtimeGeneration === generation && !current.archived
        && ![SessionState.CLOSED, SessionState.ARCHIVED].includes(current.state);
    };
    const mentionControls = this.taskSessionMentionControls();
    const workspaceMentionControls = this.taskWorkspaceMentionControls();
    const workspaceMentionOwnerKey = workspaceMentionControls?.surfaceOwnerKey;
    const workspacePathPasteControls = this.taskWorkspacePathPasteControls();
    const workspacePathPasteOwnerKey = workspacePathPasteControls?.surfaceOwnerKey;
    const catalogMentionControls = this.taskCatalogMentionControls();
    const catalogMentionOwnerKey = catalogMentionControls?.surfaceOwnerKey;
    const attachmentControls = this.taskAttachmentControls();
    const attachmentOwnerKey = attachmentControls?.surfaceOwnerKey;
    let sendDraft = assertMobileWorkspacePathPasteDraft(
      workspacePathPasteControls,
      assertMobileCatalogMentionDraft(
        catalogMentionControls,
        assertMobileWorkspaceMentionDraft(
          workspaceMentionControls,
          assertMobileSessionMentionDraft(mentionControls, exactDraft)
        )
      )
    );
    if (sendDraft.attachments.length > 0) {
      if (!attachmentControls) throw new Error("This task Backend does not accept attachments.");
      assertMobileAttachmentPolicy(sendDraft.attachments, attachmentControls.policy);
    }
    if (!this.composerDrafts) throw new Error("Retained task drafts are unavailable on this mobile client.");
    observer.onProgress?.({ phase: "preparing", input: sendDraft, sentAt });
    const draftIdentity = { profileId: this.taskDraftProfileId()!, sessionId };
    this.composerDrafts.save(draftIdentity, sendDraft);
    await this.composerDrafts.flush(draftIdentity);
    if (!isCurrent()) return false;
    const providerGroupRebalance = await this.#confirmTaskProviderRebalance(session, observer, signal, isCurrent);
    if (!isCurrent()) return false;
    const cardEdits = pendingExtensionCardFormDelivery(extensionCardFormDeliveryScope(credential, sessionId));
    if (cardEdits && !await cardEdits) throw new Error("The card edits could not be saved. Retry the card edit before sending.");
    if (!isCurrent()) return false;
    const currentSession = this.#selectedSession();
    if (this.#taskAuthorityKey() !== authorityKey || currentSession?.sessionId !== sessionId
      || currentSession.nativeBinding?.runtimeGeneration !== generation
      || this.#credential?.profileId !== credential.profileId || this.#credential.connectionId !== credential.connectionId) {
      throw new Error("The task changed while its structured draft was being saved. Review the retained draft before sending.");
    }
    assertMobileSessionMentionDraft(this.taskSessionMentionControls(), sendDraft);
    const currentWorkspaceMentionControls = this.taskWorkspaceMentionControls();
    assertMobileWorkspaceMentionDraft(currentWorkspaceMentionControls, sendDraft);
    const currentWorkspacePathPasteControls = this.taskWorkspacePathPasteControls();
    assertMobileWorkspacePathPasteDraft(currentWorkspacePathPasteControls, sendDraft);
    const currentCatalogMentionControls = this.taskCatalogMentionControls();
    assertMobileCatalogMentionDraft(currentCatalogMentionControls, sendDraft);
    const currentAttachmentControls = this.taskAttachmentControls();
    if (sendDraft.attachments.length > 0) {
      if (!currentAttachmentControls || currentAttachmentControls.surfaceOwnerKey !== attachmentOwnerKey) {
        throw new Error("The attachment owner changed while the structured draft was being saved. Review the retained draft before sending.");
      }
      assertMobileAttachmentPolicy(sendDraft.attachments, currentAttachmentControls.policy);
    }
    if (sendDraft.mentions.some((mention) => mention.kind === "workspace")) {
      if (!currentWorkspaceMentionControls || currentWorkspaceMentionControls.surfaceOwnerKey !== workspaceMentionOwnerKey) {
        throw new Error("The Workspace reference owner changed while the structured draft was being saved. Review the retained draft before sending.");
      }
      await this.#revalidateWorkspaceMentionPaths(currentWorkspaceMentionControls, sendDraft);
      if (!isCurrent()) return false;
      if (this.#taskAuthorityKey() !== authorityKey
        || this.taskWorkspaceMentionControls()?.surfaceOwnerKey !== currentWorkspaceMentionControls.surfaceOwnerKey) {
        throw new Error("The Workspace reference owner changed while its paths were being checked. Review the retained draft before sending.");
      }
      assertMobileWorkspaceMentionDraft(this.taskWorkspaceMentionControls(), sendDraft);
    }
    const workspacePathAtoms = mobileComposerWorkspacePathAtoms(sendDraft);
    if (workspacePathAtoms.length > 0) {
      if (!currentWorkspacePathPasteControls
        || currentWorkspacePathPasteControls.surfaceOwnerKey !== workspacePathPasteOwnerKey) {
        throw new Error("The Workspace path owner changed while the structured draft was being saved. Review the retained draft before sending.");
      }
      const resolutions = await this.validateTaskWorkspacePathPasteCandidates(
        currentWorkspacePathPasteControls.surfaceOwnerKey,
        workspacePathAtoms.map((atom) => atom.relativePath)
      );
      if (!isCurrent()) return false;
      const latestPathControls = this.taskWorkspacePathPasteControls();
      if (!latestPathControls
        || latestPathControls.surfaceOwnerKey !== currentWorkspacePathPasteControls.surfaceOwnerKey
        || this.#taskAuthorityKey() !== authorityKey) {
        throw new Error("The Workspace path owner changed while its paths were being checked. Review the retained draft before sending.");
      }
      assertMobileWorkspacePathPasteResolutions(latestPathControls, sendDraft, resolutions);
    }
    if (sendDraft.mentions.some((mention) => mention.kind === "resource" || mention.kind === "artifact")) {
      if (!currentCatalogMentionControls || currentCatalogMentionControls.surfaceOwnerKey !== catalogMentionOwnerKey) {
        throw new Error("The catalog reference owner changed while the structured draft was being saved. Review the retained draft before sending.");
      }
      const catalog = await this.listTaskCatalogMentionCatalog(currentCatalogMentionControls.surfaceOwnerKey);
      if (!isCurrent()) return false;
      if (this.#taskAuthorityKey() !== authorityKey
        || this.taskCatalogMentionControls()?.surfaceOwnerKey !== currentCatalogMentionControls.surfaceOwnerKey) {
        throw new Error("The catalog reference owner changed while its candidates were being checked. Review the retained draft before sending.");
      }
      assertMobileCatalogMentionDraftCatalog(this.taskCatalogMentionControls(), catalog, sendDraft);
    }
    const action = this.#claimMutation();
    try {
      sendDraft = await this.#uploadTaskAttachments(
        draftIdentity,
        sendDraft,
        authorityKey,
        attachmentOwnerKey,
        credential,
        generation,
        (input, attachmentId, error) => observer.onProgress?.({ input, sentAt, phase: error ? "failed" : attachmentId ? "uploading" : "preparing",
          ...(attachmentId ? { attachmentId } : {}), ...(error ? { error } : {}) })
      );
      if (!isCurrent()) return false;
      observer.onDispatch?.(sendDraft);
      observer.onProgress?.({ phase: "sending", input: sendDraft, sentAt });
      if (!isCurrent()) return false;
      const receipt = await this.#submitTracked(create(OperationMutationSchema, {
        preconditions: [create(OperationPreconditionSchema, {
          entity: create(EntityRefSchema, { kind: EntityKind.SESSION, id: sessionId }), expectedGeneration: generation
        })],
        payload: { case: "sendInput", value: create(SendInputMutationSchema, {
          sessionId,
          input: mobileComposerInput(sendDraft),
          deliveryMode: observer.deliveryMode ?? QueueDeliveryMode.PROMPT,
          ...(providerGroupRebalance ? { providerGroupRebalance } : {})
        }) }
      }), { kind: "send", sessionId }, false, observer.operationId, true, true,
        { signal, isCurrent: connectionCurrent, beforeDispatch: isCurrent });
      const accepted = receipt.accepted;
      if (accepted) {
        try {
          if (await this.composerDrafts.clearIfEqual(draftIdentity, sendDraft)) {
            await this.#removeCommittedAnnotationSources(draftIdentity.profileId, sendDraft.attachments);
          }
        }
        catch (error) {
          this.#set({ error: `${message(error)} The accepted message will not be sent again automatically.` });
        }
      }
      return accepted;
    } catch (error) {
      if (!connectionCurrent()) return false;
      throw error;
    } finally { this.#releaseMutation(action); }
  }

  canQueueTaskInput(): boolean {
    return !this.#joinedTask && this.#taskOutbox !== undefined && this.#state.status === "offline"
      && this.#taskAuthorityKey(true) !== undefined;
  }

  async #confirmTaskProviderRebalance(session: Session, observer: MobileTaskSendObserver, signal: AbortSignal | undefined, current: () => boolean) {
    if (this.#joinedTask || this.#state.status !== "connected" || !this.network.getTaskProviderGroupRebalance || !this.#credential || !signal) return undefined;
    let suggestion: ProviderGroupRebalanceSuggestion | undefined;
    try { suggestion = await this.network.getTaskProviderGroupRebalance(this.#credential, session.sessionId, session.nativeBinding!.runtimeGeneration, signal); }
    catch { if (!current()) throw new Error("The account switch source changed."); return undefined; }
    if (!current()) throw new Error("The account switch source changed.");
    try { if (!projectProviderGroupRebalance(suggestion, session.nativeBinding!.runtimeGeneration)) return undefined; }
    catch { return undefined; }
    if (!suggestion) return undefined;
    if (suggestion.automatic) return { suggestionKey: suggestion.suggestionKey, remember: false };
    if (!observer.confirmRebalance) return undefined;
    const confirmation = { sourceKey: this.taskHeaderSourceKey()! };
    if (this.#providerRebalanceConfirmation?.sourceKey === confirmation.sourceKey) throw new Error("Finish the original account switch confirmation before sending another input.");
    this.#providerRebalanceConfirmation = confirmation;
    try {
      const answer = await observer.confirmRebalance(suggestion, signal);
      if (!current()) throw new Error("The account switch source changed.");
      if (answer === "cancel") throw new Error("The account switch confirmation was cancelled. The draft is retained.");
      return answer === "keep" ? undefined : { suggestionKey: suggestion.suggestionKey, remember: answer.remember };
    } finally { if (this.#providerRebalanceConfirmation === confirmation) this.#providerRebalanceConfirmation = undefined; }
  }

  taskOutboxItems(): readonly MobileTaskOutboxRecord[] {
    const profile = this.#profiles.find(profile => profile.profileId === this.#activeProfileId);
    return (this.#taskOutbox?.records ?? []).filter((record) => profile && mobileTaskOutboxOwnerMatches(record.owner, profile)
      && record.sessionId === this.#state.selectedId && record.state !== "settled");
  }

  async retryTaskOutbox(id: string): Promise<void> {
    const store = this.#taskOutbox;
    const record = this.taskOutboxItems().find((item) => item.id === id);
    if (!store || record?.state !== "failed") throw new Error("Only a failed task input can be retried.");
    if (this.#state.busy) throw new Error("Finish the current operation before retrying this input.");
    const operationId = record.failureKind === "rejected" ? this.newId() : record.operationId;
    if (record.failureKind === "rejected" && operationId === record.operationId) throw new Error("A new operation identity is required to retry a rejected input.");
    await store.update(record, { state: "queued", attempted: record.failureKind === "rejected" ? false : record.attempted,
      error: undefined, failureKind: undefined, uploadAttachmentId: undefined,
      operationId });
    this.#publishTaskOutbox();
    if (this.#state.status === "connected") await this.reconcile();
  }

  async checkTaskOutbox(id: string): Promise<void> {
    const store = this.#taskOutbox, record = this.taskOutboxItems().find((item) => item.id === id);
    if (!store || record?.state !== "failed" || !record.attempted || record.failureKind !== "not-admitted"
      || this.#state.status !== "connected" || this.#state.busy) throw new Error("The original task operation cannot be checked right now.");
    await store.update(record, { state: "confirming", failureKind: undefined, error: undefined });
    this.#publishTaskOutbox(); await this.reconcile();
  }

  async cancelTaskOutbox(id: string): Promise<void> {
    const store = this.#taskOutbox;
    const record = this.taskOutboxItems().find((item) => item.id === id);
    if (!store || !record || !["staging", "queued", "failed"].includes(record.state)) throw new Error("Check the original operation before removing an input with an unknown result.");
    if (record.attempted && record.failureKind !== "rejected") throw new Error("Retry or query the original operation before removing an input that may have been accepted.");
    if (this.#state.busy) throw new Error("Finish the current operation before removing this input.");
    const settled = await store.update(record, { state: "settled", sourceDraft: undefined, failureKind: undefined, uploadAttachmentId: undefined });
    await this.#cleanupTaskOutbox(settled);
    this.#publishTaskOutbox();
  }

  async editTaskOutbox(id: string): Promise<void> {
    const store = this.#taskOutbox, record = this.taskOutboxItems().find((item) => item.id === id);
    const profile = this.#profiles.find((item) => item.profileId === this.#activeProfileId);
    if (!store || !record || !profile || !mobileTaskOutboxOwnerMatches(record.owner, profile)
      || !["queued", "failed"].includes(record.state) || record.attempted && record.failureKind !== "rejected" || this.#state.busy) {
      throw new Error("Only an unsent or rejected input from this connection can return to its composer.");
    }
    const restoring = await store.update(record, { state: "restoring", sourceDraft: undefined, failureKind: undefined, uploadAttachmentId: undefined });
    await this.#restoreTaskOutboxDraft(restoring);
    this.#publishTaskOutbox();
  }

  async #restoreTaskOutboxDraft(record: MobileTaskOutboxRecord): Promise<void> {
    const input = normalizeMobileComposerDraft({ ...record.input, attachments: record.input.attachments.map((attachment) => {
      if (attachment.state !== "uploaded" || !record.storageIds.includes(attachment.attachmentId)) return attachment;
      const { blobId: _blobId, ...local } = attachment;
      return { ...local, state: "local" as const };
    }) });
    await this.#recoverNewTaskComposerDraft({ profileId: record.owner.profileId }, record.sessionId, input);
    await this.#taskOutbox!.remove(record);
    this.#set({ restoredComposerDraft: { profileId: record.owner.profileId, sessionId: record.sessionId,
      sequence: (this.#state.restoredComposerDraft?.sequence ?? 0) + 1 } });
  }

  async #finishTaskOutboxHandoff(record: MobileTaskOutboxRecord): Promise<MobileTaskOutboxRecord> {
    if (record.sourceDraft) {
      const identity = { profileId: record.owner.profileId, sessionId: record.sessionId };
      await this.composerDrafts!.read(identity);
      if (await this.composerDrafts!.clearIfEqual(identity, record.sourceDraft)) {
        await this.#removeConsumedAppCommandAttachments(record.owner.profileId, record.sourceDraft.attachments);
      }
    }
    return this.#taskOutbox!.update(record, { state: "queued", sourceDraft: undefined });
  }

  #publishTaskOutbox(): void { this.#set({ taskOutbox: this.#taskOutbox?.records }); }

  async #enqueueTaskOutbox(draft: MobileComposerDraft, observer: MobileTaskSendObserver): Promise<boolean> {
    const sentAt = this.now();
    const store = this.#taskOutbox!, drafts = this.composerDrafts!;
    const session = this.#selectedSession(), profile = this.#profiles.find((item) => item.profileId === this.#activeProfileId);
    const authority = this.#taskAuthorityKey(this.#state.status === "offline");
    const epoch = this.#epoch;
    const generation = session?.nativeBinding?.runtimeGeneration;
    const input = normalizeMobileComposerDraft(draft);
    const backend = this.#selectedBackend(session);
    if (!authority || !profile || !session || !generation || generation < 1n || !backend || !supportsText(backend)
      || session.archived || [SessionState.CLOSED, SessionState.ARCHIVED].includes(session.state)
      || !input.text.trim() && input.attachments.length === 0) throw new Error("A current task and a message or attachment are required for the outbox.");
    const action = this.#claimMutation();
    const storageIds: string[] = [];
    let committed = false;
    try {
      observer.onProgress?.({ phase: this.#state.status === "offline" ? "waiting" : "preparing", input, sentAt });
      const identity = { profileId: profile.profileId, sessionId: session.sessionId };
      drafts.save(identity, input); await drafts.flush(identity);
      const assert = () => {
        if (!this.#current(epoch) || this.#activeProfileId !== profile.profileId || this.#state.selectedId !== session.sessionId || this.#joinedTask
          || this.#selectedSession()?.nativeBinding?.runtimeGeneration !== generation
          || !this.#profiles.some((current) => mobileTaskOutboxOwnerMatches(current, profile))) {
          throw new Error("The task owner changed before its input could be retained.");
        }
      };
      assert();
      const providerGroupRebalance = await this.#confirmTaskProviderRebalance(session, observer, this.#abort?.signal,
        () => this.#current(epoch) && this.#state.selectedId === session.sessionId && this.#selectedSession()?.nativeBinding?.runtimeGeneration === generation);
      assert();
      const model = resolveMobileSessionModelAuthority(this.#state.owner, session);
      const policy = resolveMobileAttachmentPolicy(backend, model?.supportsImages === true);
      if (input.attachments.length) {
        if (!policy || !this.attachmentFiles) throw new Error("This task cannot retain these attachments.");
        assertMobileAttachmentPolicy(input.attachments, policy);
      }
      const attachments: MobileComposerAttachment[] = [];
      const copied = new Map<string, string>();
      const copy = async (storageId: string, byteSize: number, sha256Hex: string): Promise<string> => {
        const existing = copied.get(storageId); if (existing) return existing;
        const bytes = await this.attachmentFiles!.readOwnedBytes(profile.profileId, storageId, byteSize, sha256Hex);
        assert();
        const nextId = distinctAttachmentStorageId(() => copiedMobileIncomingShareStorageId(storageId, this.newId()),
          ...mobileComposerAttachmentStorageIds(input.attachments), ...storageIds);
        await this.attachmentFiles!.stageOwnedBytes(profile.profileId, nextId, bytes.bytes, sha256Hex);
        storageIds.push(nextId); copied.set(storageId, nextId); assert(); return nextId;
      };
      for (const attachment of input.attachments) {
        const attachmentId = attachment.state === "local" ? await copy(attachment.attachmentId, attachment.byteSize, attachment.sha256Hex) : attachment.attachmentId;
        const source = attachment.annotation?.source;
        const annotation = source ? { ...attachment.annotation!, source: { ...source,
          storageId: await copy(source.storageId, source.byteSize, source.sha256Hex) } } : undefined;
        attachments.push({ ...attachment, attachmentId, ...(annotation ? { annotation } : {}) });
      }
      assert();
      const operationId = observer.operationId ?? this.newId();
      const modelJson = mobileTaskOutboxModel(session);
      let record = await store.add({ id: operationId, operationId, owner: profile,
        sessionId: session.sessionId, backendId: session.backendId, targetId: session.targetId,
        runtimeGeneration: generation.toString(), createdAt: sentAt, deliveryMode: observer.deliveryMode ?? QueueDeliveryMode.PROMPT,
        permissionMode: session.permissionMode, planMode: session.planMode,
        ...(modelJson === undefined ? {} : { modelJson }), ...(providerGroupRebalance ? { providerGroupRebalance } : {}),
        input: normalizeMobileComposerDraft({ ...input, attachments }), storageIds, sourceDraft: input, state: "staging", attempted: false });
      committed = true;
      record = await this.#finishTaskOutboxHandoff(record);
      this.#publishTaskOutbox();
      return true;
    } catch (error) {
      if (!committed) await Promise.all(storageIds.map((id) => this.attachmentFiles!.removeOwnedBytes(profile.profileId, id).catch(() => undefined)));
      else { this.#publishTaskOutbox(); this.#set({ error: `${message(error)} The input remains in the task outbox.` }); return true; }
      throw error;
    } finally {
      this.#releaseMutation(action);
      if (committed && this.#state.status === "connected") void this.reconcile().catch((error) => this.#set({ error: message(error) }));
    }
  }

  async #cleanupTaskOutbox(record: MobileTaskOutboxRecord): Promise<void> {
    for (const id of record.storageIds) await this.attachmentFiles?.removeOwnedBytes(record.owner.profileId, id);
    await this.#taskOutbox!.remove(record);
  }

  #drainTaskOutbox(epoch: number): Promise<void> {
    if (this.#taskOutboxFlight) return this.#taskOutboxFlight;
    const flight = this.#runTaskOutbox(epoch).finally(() => {
      if (this.#taskOutboxFlight === flight) this.#taskOutboxFlight = undefined;
    });
    this.#taskOutboxFlight = flight;
    return flight;
  }

  async #runTaskOutbox(epoch: number): Promise<void> {
    const store = this.#taskOutbox, credential = this.#credential;
    if (!store || !credential || this.#joinedTask || this.#state.status !== "connected" || !this.#current(epoch)
      || this.#state.busy || this.#mutationOwner || store.records.length === 0) return;
    const action = this.#claimMutation(), signal = this.#abort!.signal;
    const assert = () => {
      if (!this.#current(epoch) || signal.aborted || this.#joinedTask || this.#credential !== credential
        || this.#state.status !== "connected" || this.#activeProfileId !== credential.profileId
        || this.#state.node?.serverId !== credential.serverId) throw new Error("The task outbox connection changed.");
    };
    const blocked = new Set<string>();
    try {
      for (const original of [...store.records]) {
        if (!mobileTaskOutboxOwnerMatches(original.owner, credential) || blocked.has(original.sessionId)) continue;
        assert();
        let record = original;
        const previouslyAttempted = original.attempted;
        let preparingDispatch = false, submitInvoked = false;
        try {
          if (record.state === "settled") { await this.#cleanupTaskOutbox(record); continue; }
          if (record.state === "failed") { blocked.add(record.sessionId); continue; }
          if (record.state === "restoring") { await this.#restoreTaskOutboxDraft(record); continue; }
          if (record.state === "staging") {
            record = await this.#finishTaskOutboxHandoff(record);
          }
          let operation: Operation | undefined;
          if (record.state === "confirming") {
            operation = await this.network.getOperation(credential, record.operationId, signal);
            assert();
            if (!operation) {
              await store.update(record, { state: "failed", failureKind: "not-admitted",
                error: "The original operation has no durable record on this Joko node. Retry with its original identity or check again explicitly." });
              blocked.add(record.sessionId); continue;
            }
          }
          else {
            if (this.#state.pending.some((pending) => pending.kind === "send" && pending.sessionId === record.sessionId)) {
              blocked.add(record.sessionId); continue;
            }
            // An uncertain earlier request can still arrive. A retry must keep
            // its exact mutation, including Blob identities and preconditions.
            const input = record.attempted ? record.input : await this.#prepareTaskOutbox(record, credential, signal, assert, async (input, uploadAttachmentId) => {
              assert(); record = await store.update(record, { input, uploadAttachmentId }); this.#publishTaskOutbox(); assert();
            });
            assert();
            const cardEdits = pendingExtensionCardFormDelivery(extensionCardFormDeliveryScope(credential, record.sessionId));
            if (cardEdits && !await cardEdits) throw new Error("The card edits could not be saved. Retry the card edit before sending.");
            assert();
            record = await store.update(record, { input });
            assert();
            preparingDispatch = true;
            record = await store.update(record, { state: "confirming", attempted: true, uploadAttachmentId: undefined });
            this.#publishTaskOutbox();
            assert();
            submitInvoked = true;
            operation = await this.network.submit(credential, record.operationId, create(OperationMutationSchema, {
              preconditions: [create(OperationPreconditionSchema, { entity: create(EntityRefSchema, { kind: EntityKind.SESSION, id: record.sessionId }),
                expectedGeneration: BigInt(record.runtimeGeneration) })],
              payload: { case: "sendInput", value: create(SendInputMutationSchema, { sessionId: record.sessionId,
                input: mobileComposerInput(record.input), deliveryMode: record.deliveryMode,
                ...(record.providerGroupRebalance ? { providerGroupRebalance: record.providerGroupRebalance } : {}),
                overrides: create(PerTurnOverridesSchema, { planMode: record.planMode,
                  ...([PermissionMode.ASK, PermissionMode.AUTO, PermissionMode.BYPASS_PERMISSIONS].includes(record.permissionMode)
                    ? { permissionMode: record.permissionMode } : {}),
                  ...(record.modelJson === undefined ? {} : { model: fromJsonString(ModelSelectionSchema, record.modelJson) }) }) }) }
            }), signal);
          }
          assert();
          if (!operation || operation.operationId !== record.operationId || operation.connectionId !== record.owner.connectionId) {
            blocked.add(record.sessionId); continue;
          }
          if (!isTerminal(operation.state)) { blocked.add(record.sessionId); continue; }
          if (operation.state !== OperationState.SUCCEEDED) {
            await store.update(record, { state: "failed", failureKind: "rejected",
              error: (operation.error?.message || "The task input was rejected. Retry or remove it explicitly.").slice(0, 4_096) });
            blocked.add(record.sessionId); continue;
          }
          const queued = operation.result?.payload.case === "queueItem" ? operation.result.payload.value : undefined;
          if (!queued || queued.sessionId !== record.sessionId || queued.backendId !== record.backendId || queued.targetId !== record.targetId) {
            blocked.add(record.sessionId); continue;
          }
          record = await store.update(record, { state: "settled" });
          await this.#cleanupTaskOutbox(record);
        } catch (error) {
          if (store.records.includes(record) && record.state === "queued" && this.#current(epoch)) {
            await store.update(record, { state: "failed", failureKind: record.attempted ? "not-admitted" : "preparation",
              error: message(error).slice(0, 4_096) });
          } else if (store.records.includes(record) && record.state === "confirming" && preparingDispatch && !submitInvoked) {
            await store.update(record, { state: "failed", attempted: previouslyAttempted, failureKind: previouslyAttempted ? "not-admitted" : "preparation",
              error: previouslyAttempted ? "The connection changed before retry. Retry or check its original operation explicitly."
                : "The connection changed before dispatch. Retry, edit, or remove this retained input explicitly." });
          }
          blocked.add(record.sessionId);
          if (!this.#current(epoch)) return;
        } finally { this.#publishTaskOutbox(); }
      }
    } finally { this.#releaseMutation(action); }
  }

  async #prepareTaskOutbox(
    record: MobileTaskOutboxRecord,
    credential: PairedCredential,
    signal: AbortSignal,
    assertCurrent: () => void,
    uploaded: (input: MobileComposerDraft, attachmentId: string | undefined) => Promise<void>
  ): Promise<MobileComposerDraft> {
    const read = async () => {
      assertCurrent();
      const observed = await this.network.readOwner(credential, this.deviceNameSource(), signal);
      assertCurrent();
      this.#assertOwner(credential, observed, this.#state.node!);
      const owner = observed.snapshot;
      const detail = await this.network.readSession(credential, record.sessionId, signal);
      assertCurrent();
      const session = uniqueValue(detail.sessions, (item) => item.sessionId === record.sessionId);
      const ownerSession = uniqueValue(owner.sessions, (item) => item.sessionId === record.sessionId);
      const target = uniqueValue(owner.targets, (item) => item.targetId === record.targetId);
      const detailTarget = uniqueValue(detail.targets, (item) => item.targetId === record.targetId);
      const backend = uniqueValue(owner.backends, (item) => item.backendId === record.backendId);
      const detailBackend = uniqueValue(detail.backends, (item) => item.backendId === record.backendId);
      if (!mobileTaskOutboxOwnerMatches(record.owner, credential) || !session || !ownerSession || !target || !detailTarget
        || !backend || !detailBackend || !supportsText(backend) || detail.server?.serverId !== credential.serverId
        || owner.generation < 1n || detail.generation !== owner.generation || !observed.device.connectionIds.includes(credential.connectionId)
        || session.backendId !== record.backendId || session.targetId !== record.targetId
        || ownerSession.backendId !== record.backendId || ownerSession.targetId !== record.targetId
        || session.nativeBinding?.runtimeGeneration?.toString() !== record.runtimeGeneration
        || ownerSession.nativeBinding?.runtimeGeneration?.toString() !== record.runtimeGeneration
        || session.archived || ownerSession.archived || [SessionState.CLOSED, SessionState.ARCHIVED].includes(session.state)
        || [SessionState.CLOSED, SessionState.ARCHIVED].includes(ownerSession.state)
        || target.state !== TargetState.ACTIVE || detailTarget.state !== TargetState.ACTIVE
        || target.backendId !== record.backendId || detailTarget.backendId !== record.backendId
        || entityVersionKey(target.version) !== entityVersionKey(detailTarget.version)
        || backendAuthorityKey(backend) !== backendAuthorityKey(detailBackend)
        || session.permissionMode !== record.permissionMode || ownerSession.permissionMode !== record.permissionMode
        || session.planMode !== record.planMode || ownerSession.planMode !== record.planMode
        || mobileTaskOutboxModel(session) !== record.modelJson || mobileTaskOutboxModel(ownerSession) !== record.modelJson) {
        throw new Error("The retained input's task, generation, or execution settings changed. Review the input before retrying.");
      }
      const key = JSON.stringify([record.owner, record.sessionId, record.runtimeGeneration, owner.generation.toString(),
        entityVersionKey(target.version), backendAuthorityKey(backend)]);
      return { owner, detail, session, backend, key };
    };
    const initial = await read();
    let input = record.input;
    const controls = (value: Awaited<ReturnType<typeof read>>) => {
      const session = createMobileSessionMentionControls(value.key, value.owner, value.session, value.backend);
      const workspace = createMobileWorkspaceMentionControls(value.key, value.owner, value.detail, record.sessionId);
      const paths = createMobileWorkspacePathPasteControls(value.key, value.owner, value.detail, record.sessionId);
      const catalog = createMobileCatalogMentionControls(value.key, value.owner, value.detail, record.sessionId);
      const model = resolveMobileSessionModelAuthority(value.owner, value.session);
      const attachment = resolveMobileAttachmentPolicy(value.backend, model?.supportsImages === true);
      assertMobileSessionMentionDraft(session, input);
      assertMobileWorkspaceMentionDraft(workspace, input);
      assertMobileWorkspacePathPasteDraft(paths, input);
      assertMobileCatalogMentionDraft(catalog, input);
      if (input.attachments.length > 0) {
        if (!attachment) throw new Error("This task no longer accepts its retained attachments.");
        assertMobileAttachmentPolicy(input.attachments, attachment);
      }
      return { session, workspace, paths, catalog, attachment };
    };
    const before = controls(initial);
    if (input.mentions.some((mention) => mention.kind === "workspace")) {
      await this.#revalidateNewTaskWorkspaceMentionPaths(credential, before.workspace!, input); assertCurrent();
    }
    const pathAtoms = mobileComposerWorkspacePathAtoms(input);
    let resolutions: MobileWorkspacePathPasteResolution[] = [];
    if (pathAtoms.length) {
      for (const [parent, candidates] of groupWorkspacePathPasteCandidates(pathAtoms.map((atom) => atom.relativePath))) {
        const directory = await this.network.listWorkspaceDirectory(credential, before.paths!.workspaceId, parent, signal);
        assertCurrent();
        resolutions.push(...projectMobileWorkspacePathPasteDirectory(before.paths!, parent, directory.entries, directory.revision, candidates));
      }
      assertMobileWorkspacePathPasteResolutions(before.paths!, input, resolutions);
    }
    let catalog: MobileCatalogMentionCatalog | undefined;
    if (input.mentions.some((mention) => mention.kind === "resource" || mention.kind === "artifact")) {
      const catalogControls = before.catalog!;
      const [resources, artifacts] = await Promise.all([
        catalogControls.policy.resources ? this.network.listSessionResources(credential, record.sessionId, signal) : undefined,
        catalogControls.policy.artifacts ? this.network.listArtifactReferenceCatalog(credential, record.sessionId, BigInt(record.runtimeGeneration), signal) : undefined
      ]);
      assertCurrent();
      catalog = { ...(resources === undefined ? {} : { resources: projectMobileResourceMentionCatalog(catalogControls, resources) }),
        ...(artifacts === undefined ? {} : { artifacts: projectMobileArtifactMentionCatalog(catalogControls, artifacts.artifacts, artifacts.revision) }) };
      assertMobileCatalogMentionDraftCatalog(catalogControls, catalog, input);
    }
    for (const candidate of [...input.attachments]) {
      if (candidate.state === "uploaded") continue;
      await uploaded(input, candidate.attachmentId);
      if (!this.attachmentFiles) throw new Error("The retained attachment bytes are unavailable.");
      const source = await this.attachmentFiles.verifyForUpload(record.owner.profileId, candidate, signal);
      assertCurrent();
      const blob = await this.network.uploadBlob(credential, source, signal);
      assertCurrent();
      input = normalizeMobileComposerDraft({ ...input,
        attachments: replaceMobileComposerAttachment(input.attachments, candidate.attachmentId, this.#uploadedAttachment(candidate, blob)) });
      await uploaded(input, undefined);
    }
    const final = await read(), after = controls(final);
    if (final.key !== initial.key
      || input.mentions.some((mention) => mention.kind === "workspace") && before.workspace?.surfaceOwnerKey !== after.workspace?.surfaceOwnerKey
      || pathAtoms.length > 0 && before.paths?.surfaceOwnerKey !== after.paths?.surfaceOwnerKey
      || catalog && before.catalog?.surfaceOwnerKey !== after.catalog?.surfaceOwnerKey) {
      throw new Error("The retained input's resource authority changed while it was being prepared.");
    }
    if (pathAtoms.length) assertMobileWorkspacePathPasteResolutions(after.paths!, input, resolutions);
    if (catalog) assertMobileCatalogMentionDraftCatalog(after.catalog, catalog, input);
    return input;
  }

  async #uploadTaskAttachments(
    identity: { readonly profileId: string; readonly sessionId: string },
    initial: MobileComposerDraft,
    authorityKey: string,
    attachmentOwnerKey: string | undefined,
    credential: PairedCredential,
    generation: bigint,
    progress?: (input: MobileComposerDraft, attachmentId?: string, error?: string) => void
  ): Promise<MobileComposerDraft> {
    const epoch = this.#epoch, signal = this.#abort?.signal;
    const check = (): void => {
      if (!this.#current(epoch) || signal?.aborted || this.#credential !== credential) {
        throw new Error("The task attachment connection changed. Review the retained draft before sending.");
      }
    };
    check();
    if (initial.attachments.every((attachment) => attachment.state === "uploaded")) return initial;
    if (!this.composerDrafts || !this.attachmentFiles) {
      throw new Error("Staged mobile attachment bytes are unavailable.");
    }
    if (!attachmentOwnerKey) throw new Error("The current task attachment authority is unavailable.");
    let current = initial;
    let snapshot = await this.composerDrafts.readSnapshot(identity);
    check();
    if (snapshot.draft === undefined || !mobileComposerDraftsEqual(snapshot.draft, current)) {
      throw new Error("The retained task draft changed before its attachments could upload.");
    }
    for (const candidate of current.attachments) {
      if (candidate.state === "uploaded") continue;
      const attachment = candidate as MobileLocalComposerAttachment;
      progress?.(current, attachment.attachmentId);
      try {
      this.#assertTaskAttachmentUploadOwner(
        identity.sessionId,
        authorityKey,
        attachmentOwnerKey,
        credential,
        generation,
        current.attachments
      );
      const source = await this.attachmentFiles.verifyForUpload(
        identity.profileId,
        attachment,
        signal
      );
      check();
      const blob = await this.network.uploadBlob(credential, source, signal);
      check();
      this.#assertTaskAttachmentUploadOwner(
        identity.sessionId,
        authorityKey,
        attachmentOwnerKey,
        credential,
        generation,
        current.attachments
      );
      const uploaded = this.#uploadedAttachment(attachment, blob);
      const next = normalizeMobileComposerDraft({
        ...current,
        attachments: replaceMobileComposerAttachment(
          current.attachments,
          attachment.attachmentId,
          uploaded
        )
      });
      if (!this.composerDrafts.saveIfRevision(identity, next, snapshot.revision)) {
        throw new Error("The retained task draft changed while an attachment was uploading.");
      }
      await this.composerDrafts.flush(identity);
      check();
      snapshot = await this.composerDrafts.readSnapshot(identity);
      check();
      if (snapshot.draft === undefined || !mobileComposerDraftsEqual(snapshot.draft, next)) {
        throw new Error("The committed attachment could not be confirmed in the retained task draft.");
      }
      current = next;
      progress?.(current);
      await this.#removeCommittedAttachmentFile(identity.profileId, attachment);
      check();
      } catch (error) { progress?.(current, attachment.attachmentId, message(error).slice(0, 4_096)); throw error; }
    }
    return current;
  }

  #assertTaskAttachmentUploadOwner(
    sessionId: string,
    authorityKey: string,
    attachmentOwnerKey: string,
    credential: PairedCredential,
    generation: bigint,
    attachments: readonly MobileComposerAttachment[]
  ): void {
    const session = this.#selectedSession();
    const controls = this.taskAttachmentControls();
    if (this.#taskAuthorityKey() !== authorityKey || session?.sessionId !== sessionId
      || session.nativeBinding?.runtimeGeneration !== generation || !controls
      || controls.surfaceOwnerKey !== attachmentOwnerKey
      || controls.profileId !== this.taskDraftProfileId()
      || this.#credential?.profileId !== credential.profileId
      || this.#credential.connectionId !== credential.connectionId) {
      throw new Error("The task changed while its attachments were uploading.");
    }
    assertMobileAttachmentPolicy(attachments, controls.policy);
  }

  #uploadedAttachment(
    attachment: MobileLocalComposerAttachment,
    blob: BlobRef
  ): MobileUploadedComposerAttachment {
    if (!blob.blobId || blob.fileName !== attachment.fileName
      || normalizeMediaType(blob.mediaType) !== attachment.mediaType
      || blob.byteSize !== BigInt(attachment.byteSize)
      || blob.sha256Hex !== attachment.sha256Hex
      || blob.disposition !== BlobDisposition.ATTACHMENT) {
      throw new Error("The committed Joko attachment does not match its staged bytes.");
    }
    return {
      ...attachment,
      state: "uploaded",
      blobId: blob.blobId
    };
  }

  async #removeCommittedAttachmentFile(
    profileId: string,
    attachment: MobileLocalComposerAttachment
  ): Promise<void> {
    if (!this.attachmentFiles) return;
    const epoch = this.#epoch, credential = this.#credential;
    try { await this.attachmentFiles.removeVisibleBytes(profileId, attachment); }
    catch (error) {
      if (this.#current(epoch) && this.#credential === credential) {
        this.#set({ error: `${message(error)} The committed attachment will not be uploaded again.` });
      }
    }
  }

  async #removeCommittedAnnotationSources(
    profileId: string,
    attachments: readonly MobileComposerAttachment[]
  ): Promise<void> {
    if (!this.attachmentFiles) return;
    const storageIds = new Set(attachments.flatMap((attachment) => {
      const exact = normalizeMobileComposerAttachment(attachment);
      return exact.annotation ? [exact.annotation.source.storageId] : [];
    }));
    try {
      await Promise.all([...storageIds].map((storageId) =>
        this.attachmentFiles!.removeOwnedBytes(profileId, storageId)));
    } catch (error) {
      this.#set({ error: `${message(error)} The accepted message will not be sent again automatically.` });
    }
  }

  async #removeConsumedAppCommandAttachments(
    profileId: string,
    attachments: readonly MobileComposerAttachment[]
  ): Promise<void> {
    for (const attachment of attachments) {
      if (attachment.state === "local") await this.#removeCommittedAttachmentFile(profileId, attachment);
    }
    await this.#removeCommittedAnnotationSources(profileId, attachments);
  }

  leaveTask(): void {
    this.closeTimelinePreview();
    if (this.#queueEditLease) this.#releaseQueueEditLeaseDetached(this.#queueEditLease);
    if (this.#queueInteractionLease) this.#releaseQueueInteractionLeaseDetached(this.#queueInteractionLease);
  }

  canDeleteMessage(eventId: string): boolean {
    if (this.#joinedTask) return false;
    const session = this.#selectedSession();
    const backend = this.#selectedBackend(session);
    return this.#state.status === "connected" && this.#foreground
      && session?.state === SessionState.IDLE
      && backendSupports(backend, capabilityNames.sessionMessageDelete)
      && this.#activeQueueItems(session.sessionId).length === 0
      && this.#completedMessageEvent(eventId) !== undefined;
  }

  async deleteMessage(eventId: string): Promise<boolean> {
    const session = this.#selectedSession();
    const generation = session?.nativeBinding?.runtimeGeneration;
    if (!session || !generation || generation < 1n || !this.canDeleteMessage(eventId)) {
      throw new Error("This message is no longer available for deletion in the current idle task.");
    }
    if (this.#state.pending.some((item) => item.kind === "message-delete"
      && item.sessionId === session.sessionId && item.eventId === eventId)) {
      throw new Error("This message deletion is already pending. Check its operation before trying again.");
    }
    const action = this.#claimMutation();
    try {
      const result = await this.#submitTerminal(create(OperationMutationSchema, {
        preconditions: [create(OperationPreconditionSchema, {
          entity: create(EntityRefSchema, { kind: EntityKind.SESSION, id: session.sessionId }),
          expectedGeneration: generation
        })],
        payload: { case: "deleteSessionMessage", value: create(DeleteSessionMessageMutationSchema, {
          sessionId: session.sessionId,
          eventId
        }) }
      }), { kind: "message-delete", sessionId: session.sessionId, eventId });
      if (result.accepted && result.definitive) this.#clearHistory();
      return result.accepted && result.definitive;
    } finally { this.#releaseMutation(action); }
  }

  taskQueueItems(): readonly QueueItem[] {
    return acceptedQueueItems(this.#state.detail?.queueItems ?? [], this.#state.selectedId);
  }

  /** Stable page-local owner occurrence; excludes normal entity revision advancement. */
  taskPresentationOwnerKey(allowOffline = false): string | undefined {
    if (this.#joinedTask) return this.#taskAuthorityKey();
    const saving = this.#partnerProfileSave;
    if (saving) {
      if (!saving || this.#mutationOwner !== saving.action || !this.#current(saving.epoch)
        || this.#credential !== saving.credential || this.#partnerPrivateAuthorityKey(this.#state) !== saving.directoryKey
        || this.#state.selectedId !== saving.sessionId) return undefined;
      for (const snapshot of [this.#state.owner, this.#state.detail]) {
        const sessions = snapshot?.sessions.filter(session => session.sessionId === saving.sessionId) ?? [];
        const targets = snapshot?.targets.filter(target => target.targetId === saving.targetId) ?? [];
        const backends = snapshot?.backends.filter(backend => backend.backendId === saving.backendId) ?? [];
        if (snapshot?.generation !== this.#taskGeneration() || sessions.length !== 1 || targets.length !== 1 || backends.length !== 1
          || sessions[0]!.targetId !== saving.targetId || sessions[0]!.backendId !== saving.backendId
          || !sessions[0]!.nativeBinding?.runtimeGeneration || sessions[0]!.nativeBinding!.runtimeGeneration! < 1n || sessions[0]!.archived
          || [SessionState.CLOSED, SessionState.ARCHIVED].includes(sessions[0]!.state)
          || targets[0]!.backendId !== saving.backendId || backendAuthorityKey(backends[0]!) !== saving.backendKey) return undefined;
      }
      // Presentation survives only this owned profile write's owner/detail revision gap.
      // Effect authority continues to require the ordinary exact Snapshot boundary.
      return saving.presentationKey;
    }
    if (!this.#taskAuthorityKey(allowOffline)) return undefined;
    const credential = this.#credential!;
    const owner = this.#state.owner!;
    const session = this.#selectedSession()!;
    const generation = session.nativeBinding!.runtimeGeneration!;
    return [
      credential.profileId,
      credential.connectionId,
      credential.deviceId,
      credential.serverId,
      owner.generation.toString(10),
      session.sessionId,
      session.backendId,
      session.targetId,
      generation.toString(10)
    ].join("\u001f");
  }

  taskQueueCapabilities() {
    const capabilities = mobileQueueCapabilities(this.#selectedBackend(this.#selectedSession()));
    return this.#joinedTask ? { ...capabilities, reorder: false } : capabilities;
  }

  taskQueueItemOwned(item: QueueItem): boolean {
    return !this.#joinedTask || mobileSharedTaskAuthorMatches(this.#joinedTask.source, item.sharedTaskAuthor);
  }

  taskRuntimeControls(): MobileRuntimeControls | undefined {
    if (this.#joinedTask) return resolveMobileSharedRuntimeControls(this.#state.detail, this.#taskAuthorityKey());
    const credential = this.#credential;
    if (!credential || !this.#taskAuthorityKey()) return undefined;
    const resolved = resolveMobileRuntimeControls({
      profileId: credential.profileId,
      connectionId: credential.connectionId,
      deviceId: credential.deviceId,
      serverId: credential.serverId
    }, this.#state.owner, this.#state.detail, this.#state.selectedId, this.network.getSessionRuntimeControl !== undefined);
    if (!resolved) return undefined;
    const controls = resolved.session.derivationOrigin?.sideChat === true && resolved.session.worktree === undefined
      ? { ...resolved, canSwitchModel: false, canSetEffort: false, canSetFastMode: false,
        canSetPermission: false, canSetPlanMode: false }
      : resolved;
    const runtimeSelection = this.#runtimeModelSelection;
    const pending = runtimeSelection && runtimeSelection.ownerKey === this.#taskAuthorityKey() ? runtimeSelection.control.pending : undefined;
    const route = pending ? controls.models.find(route => route.backendId === pending.backendId && route.providerId === pending.providerId && route.modelId === pending.modelId) : undefined;
    return route && pending ? { ...controls, pendingModel: { ...route, effortId: pending.effort, fastMode: decodeModelSpeed(pending) } } : controls;
  }

  async refreshTaskRuntimeSelection(): Promise<boolean> {
    const credential = this.#credential, session = this.#selectedSession(), ownerKey = this.#taskAuthorityKey();
    if (!credential || !session || !ownerKey || this.#joinedTask || !this.network.getSessionRuntimeControl) return false;
    const control = await this.network.getSessionRuntimeControl(credential, session.sessionId, this.#abort?.signal);
    if (credential !== this.#credential || ownerKey !== this.#taskAuthorityKey()) return false;
    this.#runtimeModelSelection = { ownerKey, control }; this.#set({});
    return control.pending !== undefined;
  }

  taskProviderUsageTransport(): MobileProviderUsageTransport | undefined {
    if (this.#joinedTask) return undefined;
    const credential = this.#credential;
    const ownerKey = this.#taskProviderUsageOwnerKey();
    const session = this.#selectedSession();
    if (!credential || !ownerKey || !session || !this.network.getProviderUsage) return undefined;
    const providers = this.#state.owner!.providers.filter(provider => provider.backendId === session.backendId
      && mobileProviderUsageSupported(provider));
    return { ownerKey, providers, read: async (backendId, providerId, signal) => {
      const current = (): void => {
        signal.throwIfAborted();
        if (this.#disposed || this.#credential !== credential || this.#taskProviderUsageOwnerKey() !== ownerKey) {
          throw new Error("The account usage task owner changed.");
        }
      };
      current();
      const matches = providers.filter(provider => provider.backendId === backendId && provider.providerId === providerId);
      if (matches.length !== 1 || backendId !== session.backendId) throw new Error("The account usage Provider is unavailable.");
      const result = await this.network.getProviderUsage!(credential, backendId, providerId, signal);
      current();
      if (result && result.providerId !== providerId) throw new Error("The account usage Provider changed.");
      return result;
    } };
  }

  newTaskProviderUsageTransport(targetId: string): MobileProviderUsageTransport | undefined {
    const credential = this.#credential;
    const key = () => {
      const authority = this.#newTaskAuthorityKey(targetId), owner = this.#state.owner;
      if (!authority || !owner || this.#credential !== credential) return undefined;
      const backends = new Set(this.newTaskModels(targetId).map(model => model.backendId));
      const providers = owner.providers.filter(provider => backends.has(provider.backendId) && mobileProviderUsageSupported(provider));
      if (!providers.length || providers.length > 256) return undefined;
      return { ownerKey: JSON.stringify([authority, providers.map(mobileProviderUsageIdentity).sort()]), providers };
    };
    const captured = key();
    if (!credential || !captured || !this.network.getProviderUsage) return undefined;
    return { ...captured, read: async (backendId, providerId, signal) => {
      const current = () => { signal.throwIfAborted(); if (this.#disposed || key()?.ownerKey !== captured.ownerKey) throw new Error("The account usage draft owner changed."); };
      current();
      if (captured.providers.filter(provider => provider.backendId === backendId && provider.providerId === providerId).length !== 1) throw new Error("The account usage Provider is unavailable.");
      const result = await this.network.getProviderUsage!(credential, backendId, providerId, signal); current();
      if (result && result.providerId !== providerId) throw new Error("The account usage Provider changed.");
      return result;
    } };
  }

  #taskProviderUsageOwnerKey(): string | undefined {
    const credential = this.#credential;
    const session = this.#selectedSession();
    const owner = this.#state.owner;
    if (!credential || !session || !owner || !this.#taskAuthorityKey()) return undefined;
    const providers = owner.providers.filter(provider => provider.backendId === session.backendId && mobileProviderUsageSupported(provider));
    if (providers.length === 0 || providers.length > 256) return undefined;
    const backend = this.#selectedBackend(session);
    if (!backend) return undefined;
    return JSON.stringify([credential.profileId, credential.connectionId, credential.deviceId, credential.serverId,
      owner.generation.toString(), session.sessionId, session.backendId, session.targetId, session.nativeBinding?.runtimeGeneration.toString(),
      session.model?.model?.providerId, session.model?.model?.modelId, backendAuthorityKey(backend),
      providers.map(mobileProviderUsageIdentity).sort(), owner.models.filter(model => model.backendId === session.backendId)
        .map(model => JSON.stringify([model.key?.providerId, model.key?.modelId, model.available])).sort()]);
  }

  newTaskVoiceTransport(targetId: string): MobileVoiceTransport | undefined {
    const authorityKey = this.#newTaskAuthorityKey(targetId);
    const credential = this.#credential;
    if (!authorityKey || !credential) return undefined;
    const surfaceOwnerKey = `${authorityKey}\u001fvoice-input`;
    return this.#voiceTransport(credential, surfaceOwnerKey, () => {
      const current = this.#newTaskAuthorityKey(targetId);
      return current === undefined ? undefined : `${current}\u001fvoice-input`;
    });
  }

  newTaskAttachmentControls(targetId: string): MobileAttachmentControls | undefined {
    const owner = this.#state.owner;
    const authorityKey = this.#newTaskAuthorityKey(targetId);
    const credential = this.#credential;
    const target = uniqueValue(owner?.targets ?? [], (candidate) => candidate.targetId === targetId);
    const backend = uniqueValue(owner?.backends ?? [], (candidate) => candidate.backendId === target?.backendId);
    const model = resolveMobileExplicitNewTaskModelAuthority(owner, backend?.backendId, this.newTaskModelSelection(targetId))
      ?? resolveMobileNewTaskDefaultModelAuthority(owner, backend?.backendId);
    const policy = resolveMobileAttachmentPolicy(backend, model?.supportsImages === true);
    if (!authorityKey || !credential || !policy) return undefined;
    return {
      profileId: credential.profileId,
      surfaceOwnerKey: `${authorityKey}\u001fattachments\u001f${model?.authorityKey ?? "native-default"}`,
      policy
    };
  }

  newTaskIncomingShareControls(targetId: string): MobileAttachmentControls | undefined {
    const attachments = this.newTaskAttachmentControls(targetId);
    if (attachments) return attachments;
    const authorityKey = this.#newTaskAuthorityKey(targetId);
    const credential = this.#credential;
    if (!authorityKey || !credential) return undefined;
    return {
      profileId: credential.profileId,
      surfaceOwnerKey: `${authorityKey}\u001fincoming-share-text`,
      policy: textOnlyIncomingSharePolicy
    };
  }

  newTaskSessionMentionControls(targetId: string): MobileSessionMentionControls | undefined {
    const owner = this.#state.owner;
    const authorityKey = this.#newTaskAuthorityKey(targetId);
    const target = uniqueValue(owner?.targets ?? [], (candidate) => candidate.targetId === targetId);
    const backend = uniqueValue(owner?.backends ?? [], (candidate) => candidate.backendId === target?.backendId);
    return createMobileNewTaskSessionMentionControls(authorityKey, owner, backend);
  }

  newTaskWorkspaceMentionControls(targetId: string): MobileWorkspaceMentionControls | undefined {
    return createMobileNewTaskWorkspaceMentionControls(
      this.#newTaskAuthorityKey(targetId),
      this.#state.owner,
      targetId
    );
  }

  newTaskWorkspacePathPasteControls(targetId: string): MobileWorkspacePathPasteControls | undefined {
    return createMobileNewTaskWorkspacePathPasteControls(
      this.#newTaskAuthorityKey(targetId),
      this.#state.owner,
      targetId
    );
  }

  async validateNewTaskWorkspacePathPasteCandidates(
    targetId: string,
    expectedSurfaceOwnerKey: string,
    candidateRelativePaths: readonly string[],
    signal?: AbortSignal
  ): Promise<readonly MobileWorkspacePathPasteResolution[]> {
    this.#newTaskWorkspacePathPasteContext(targetId, expectedSurfaceOwnerKey);
    const fresh = await this.#readNewTaskOwner(signal);
    const controls = createMobileNewTaskWorkspacePathPasteControls(
      this.#newTaskAuthorityKey(targetId, fresh.snapshot),
      fresh.snapshot,
      targetId
    );
    if (!controls || controls.surfaceOwnerKey !== expectedSurfaceOwnerKey) {
      throw new Error("Workspace path authority changed while clipboard paths were being checked.");
    }
    const resolutions: MobileWorkspacePathPasteResolution[] = [];
    for (const [parent, candidates] of groupWorkspacePathPasteCandidates(candidateRelativePaths)) {
      const result = await this.network.listWorkspaceDirectory(
        fresh.credential,
        controls.workspaceId,
        parent,
        signal ?? this.#abort?.signal
      );
      resolutions.push(...projectMobileWorkspacePathPasteDirectory(
        controls,
        parent,
        result.entries,
        result.revision,
        candidates
      ));
      this.#newTaskWorkspacePathPasteContext(targetId, expectedSurfaceOwnerKey);
    }
    const after = await this.#readNewTaskOwner(signal);
    const latest = createMobileNewTaskWorkspacePathPasteControls(
      this.#newTaskAuthorityKey(targetId, after.snapshot),
      after.snapshot,
      targetId
    );
    if (!latest || latest.surfaceOwnerKey !== expectedSurfaceOwnerKey) {
      throw new Error("Workspace path authority changed while clipboard paths were being checked.");
    }
    this.#newTaskWorkspacePathPasteContext(targetId, expectedSurfaceOwnerKey);
    return resolutions;
  }

  async validateNewTaskSessionMentionCandidate(
    targetId: string,
    expectedSurfaceOwnerKey: string,
    value: MobileSessionMentionCandidate,
    signal?: AbortSignal
  ): Promise<MobileSessionMentionCandidate> {
    this.#newTaskSessionMentionContext(targetId, expectedSurfaceOwnerKey);
    const fresh = await this.#readNewTaskOwner(signal);
    const controls = this.#newTaskSessionMentionControlsFromOwner(targetId, fresh.snapshot);
    if (!controls || controls.surfaceOwnerKey !== expectedSurfaceOwnerKey) {
      throw new Error("Task reference authority changed while its candidate was being checked.");
    }
    this.#newTaskSessionMentionContext(targetId, expectedSurfaceOwnerKey);
    return assertMobileSessionMentionCandidate(controls, value);
  }

  async listNewTaskWorkspaceMentionDirectory(
    targetId: string,
    expectedSurfaceOwnerKey: string,
    parentPath: string,
    signal?: AbortSignal
  ): Promise<MobileWorkspaceMentionDirectory> {
    const context = this.#newTaskWorkspaceMentionContext(targetId, expectedSurfaceOwnerKey);
    const parent = canonicalWorkspacePath(parentPath, true);
    const result = await this.network.listWorkspaceDirectory(
      context.credential,
      context.controls.workspaceId,
      parent,
      signal
    );
    const current = this.#newTaskWorkspaceMentionContext(targetId, expectedSurfaceOwnerKey);
    if (current.controls.surfaceOwnerKey !== context.controls.surfaceOwnerKey) {
      throw new Error("The new-task Workspace reference owner changed while its directory was loading.");
    }
    return projectMobileWorkspaceMentionDirectory(context.controls, parent, result.entries, result.revision);
  }

  async listNewTaskWorkspaceMentionFileIndex(
    targetId: string,
    expectedSurfaceOwnerKey: string,
    signal?: AbortSignal
  ): Promise<MobileWorkspaceMentionFileIndex> {
    const context = this.#newTaskWorkspaceMentionContext(targetId, expectedSurfaceOwnerKey);
    if (!context.controls.policy.files) throw new Error("This Backend does not support Workspace file references.");
    const result = await this.network.listWorkspaceFileIndex(
      context.credential,
      context.controls.workspaceId,
      signal
    );
    const current = this.#newTaskWorkspaceMentionContext(targetId, expectedSurfaceOwnerKey);
    if (current.controls.surfaceOwnerKey !== context.controls.surfaceOwnerKey) {
      throw new Error("The new-task Workspace reference owner changed while its file index was loading.");
    }
    return projectMobileWorkspaceMentionFileIndex(
      context.controls,
      result.paths,
      result.revision,
      result.truncated
    );
  }

  async validateNewTaskWorkspaceMentionCandidate(
    targetId: string,
    expectedSurfaceOwnerKey: string,
    value: MobileWorkspaceMentionCandidate,
    signal?: AbortSignal
  ): Promise<MobileWorkspaceMentionCandidate> {
    this.#newTaskWorkspaceMentionContext(targetId, expectedSurfaceOwnerKey);
    const fresh = await this.#readNewTaskOwner(signal);
    const controls = createMobileNewTaskWorkspaceMentionControls(
      this.#newTaskAuthorityKey(targetId, fresh.snapshot),
      fresh.snapshot,
      targetId
    );
    if (!controls || controls.surfaceOwnerKey !== expectedSurfaceOwnerKey) {
      throw new Error("Workspace reference authority changed while the selected path was being checked.");
    }
    const expected = assertMobileWorkspaceMentionCandidate(controls, value);
    const result = await this.network.listWorkspaceDirectory(
      fresh.credential,
      controls.workspaceId,
      workspaceParentPath(expected.relativePath),
      signal
    );
    const directory = projectMobileWorkspaceMentionDirectory(
      controls,
      workspaceParentPath(expected.relativePath),
      result.entries,
      result.revision
    );
    const after = await this.#readNewTaskOwner(signal);
    const latestControls = createMobileNewTaskWorkspaceMentionControls(
      this.#newTaskAuthorityKey(targetId, after.snapshot),
      after.snapshot,
      targetId
    );
    if (!latestControls || latestControls.surfaceOwnerKey !== expectedSurfaceOwnerKey) {
      throw new Error("Workspace reference authority changed while the selected path was being checked.");
    }
    this.#newTaskWorkspaceMentionContext(targetId, expectedSurfaceOwnerKey);
    const matches = directory.entries.filter((entry) => entry.relativePath === expected.relativePath);
    const current = matches.length === 1 ? matches[0] : undefined;
    if (!current || current.directory !== expected.directory) {
      throw new Error("The selected Workspace path is no longer available with the same file type.");
    }
    return assertMobileWorkspaceMentionCandidate(latestControls, current);
  }

  taskSessionMentionControls(): MobileSessionMentionControls | undefined {
    if (this.#joinedTask) return undefined;
    const authorityKey = this.#taskAuthorityKey();
    const session = this.#selectedSession();
    const backend = this.#selectedBackend(session);
    return createMobileSessionMentionControls(authorityKey, this.#state.owner, session, backend);
  }

  taskWorkspaceMentionControls(): MobileWorkspaceMentionControls | undefined {
    if (this.#joinedTask) return undefined;
    return createMobileWorkspaceMentionControls(
      this.#taskAuthorityKey(),
      this.#state.owner,
      this.#state.detail,
      this.#state.selectedId
    );
  }

  taskWorkspacePathPasteControls(): MobileWorkspacePathPasteControls | undefined {
    if (this.#joinedTask) return undefined;
    return createMobileWorkspacePathPasteControls(
      this.#taskAuthorityKey(),
      this.#state.owner,
      this.#state.detail,
      this.#state.selectedId
    );
  }

  async validateTaskWorkspacePathPasteCandidates(
    expectedSurfaceOwnerKey: string,
    candidateRelativePaths: readonly string[],
    signal?: AbortSignal
  ): Promise<readonly MobileWorkspacePathPasteResolution[]> {
    const context = this.#workspacePathPasteContext(expectedSurfaceOwnerKey);
    const resolutions: MobileWorkspacePathPasteResolution[] = [];
    for (const [parent, candidates] of groupWorkspacePathPasteCandidates(candidateRelativePaths)) {
      const result = await this.network.listWorkspaceDirectory(
        context.credential,
        context.controls.workspaceId,
        parent,
        signal ?? this.#abort?.signal
      );
      resolutions.push(...projectMobileWorkspacePathPasteDirectory(
        context.controls,
        parent,
        result.entries,
        result.revision,
        candidates
      ));
      this.#workspacePathPasteContext(expectedSurfaceOwnerKey);
    }
    return resolutions;
  }

  taskCatalogMentionControls(): MobileCatalogMentionControls | undefined {
    if (this.#joinedTask) return undefined;
    return createMobileCatalogMentionControls(
      this.#taskAuthorityKey(),
      this.#state.owner,
      this.#state.detail,
      this.#state.selectedId
    );
  }

  taskRuntimeCommandControls(): MobileRuntimeCommandControls | undefined {
    if (this.#joinedTask) return undefined;
    return createMobileRuntimeCommandControls(
      this.#taskAuthorityKey(),
      this.#state.owner,
      this.#state.detail,
      this.#state.selectedId
    );
  }

  taskAppCommandControls(): MobileAppCommandControls | undefined {
    if (this.#joinedTask) return undefined;
    return createMobileAppCommandControls(
      this.#taskAuthorityKey(),
      this.#state.owner,
      this.#state.detail,
      this.#state.selectedId
    );
  }

  taskAttachmentControls(allowOfflineLocalStaging = false): MobileAttachmentControls | undefined {
    const authorityKey = this.#taskAuthorityKey(allowOfflineLocalStaging);
    const credential = this.#credential ?? (allowOfflineLocalStaging
      ? this.#profiles.find((profile) => profile.profileId === this.#activeProfileId) : undefined);
    const session = this.#selectedSession();
    const model = resolveMobileSessionModelAuthority(this.#joinedTask ? this.#state.detail : this.#state.owner, session);
    const policy = resolveMobileAttachmentPolicy(this.#selectedBackend(session), model?.supportsImages === true);
    if (!authorityKey || !credential || !policy) return undefined;
    return {
      profileId: this.taskDraftProfileId()!,
      surfaceOwnerKey: `${authorityKey}\u001fattachments\u001f${model?.authorityKey ?? "native-default"}`,
      policy
    };
  }

  taskIncomingShareControls(): MobileAttachmentControls | undefined {
    const attachments = this.taskAttachmentControls();
    if (attachments) return attachments;
    const authorityKey = this.#taskAuthorityKey();
    const credential = this.#credential;
    if (!authorityKey || !credential) return undefined;
    return {
      profileId: this.taskDraftProfileId()!,
      surfaceOwnerKey: `${authorityKey}\u001fincoming-share-text`,
      policy: textOnlyIncomingSharePolicy
    };
  }

  async openComposerImageEditor(
    request: MobileComposerImageEditorRequest,
    signal?: AbortSignal
  ): Promise<MobileComposerImageEditorSession> {
    signal?.throwIfAborted();
    if (!this.attachmentFiles || !this.composerDrafts || !this.newTaskDrafts) {
      throw new Error("Retained image attachment bytes are unavailable on this mobile client.");
    }
    const credential = this.#ready();
    if (!this.#foreground) throw new Error("Return Joko to the foreground before opening an image attachment.");
    this.#composerImageEdit = undefined;

    let owner: MobileComposerImageEditLease["owner"];
    let controls: MobileAttachmentControls | undefined;
    if (request.surface === "task") {
      const sessionId = this.#state.selectedId;
      const authorityKey = this.#taskAuthorityKey();
      controls = this.taskAttachmentControls();
      if (!sessionId || !authorityKey || !controls || controls.profileId !== this.taskDraftProfileId()) {
        throw new Error("The current task image attachment authority is unavailable.");
      }
      const identity = { profileId: this.taskDraftProfileId()!, sessionId };
      const snapshot = await this.composerDrafts.readSnapshot(identity);
      const draft = normalizeMobileComposerDraft(snapshot.draft ?? {
        text: "", mentions: [], atoms: [], slashCommands: [], attachments: []
      });
      owner = { kind: "task", authorityKey, identity, snapshot, draft };
    } else {
      controls = this.newTaskAttachmentControls(request.targetId);
      if (!controls || controls.profileId !== this.taskDraftProfileId()) {
        throw new Error("The new-task image attachment authority is unavailable.");
      }
      const identity = { profileId: credential.profileId };
      const snapshot = await this.newTaskDrafts.readSnapshot(identity);
      const draft = snapshot.draft;
      if (!draft || draft.submission || draft.targetId !== request.targetId) {
        throw new Error("The editable new-task image draft is unavailable.");
      }
      owner = { kind: "new-task", identity, snapshot, draft };
    }
    const input = owner.kind === "task" ? owner.draft : owner.draft.input;
    assertMobileAttachmentPolicy(input.attachments, controls.policy);
    const attachment = exactComposerAttachment(input.attachments, request.attachmentId);
    if (attachment.kind !== "image") throw new Error("Only an image attachment can open the image editor.");

    const annotation = attachment.annotation;
    const occupiedStorageIds = mobileComposerAttachmentStorageIds(input.attachments);
    const source: MobileComposerImageAnnotationSource = annotation?.source ?? {
      storageId: distinctAttachmentStorageId(this.newId, ...occupiedStorageIds),
      fileName: attachment.fileName,
      mediaType: attachment.mediaType,
      byteSize: attachment.byteSize,
      sha256Hex: attachment.sha256Hex,
      capturedAtUnixMs: attachment.capturedAtUnixMs
    };
    let sourceBytes: Uint8Array;
    let sourceUri: string;
    if (annotation) {
      const verified = await this.attachmentFiles.readOwnedBytes(
        credential.profileId,
        source.storageId,
        source.byteSize,
        source.sha256Hex,
        signal
      );
      sourceBytes = verified.bytes;
      sourceUri = verified.uri;
    } else if (attachment.state === "local") {
      const verified = await this.attachmentFiles.readOwnedBytes(
        credential.profileId,
        attachment.attachmentId,
        attachment.byteSize,
        attachment.sha256Hex,
        signal
      );
      sourceBytes = verified.bytes;
      sourceUri = verified.uri;
    } else {
      const blob = create(BlobRefSchema, {
        blobId: attachment.blobId,
        fileName: attachment.fileName,
        mediaType: attachment.mediaType,
        byteSize: BigInt(attachment.byteSize),
        sha256Hex: attachment.sha256Hex,
        disposition: BlobDisposition.ATTACHMENT
      });
      const downloaded = await this.network.downloadBlob(credential, blob, signal);
      if (normalizeMediaType(downloaded.mediaType) !== attachment.mediaType
        || downloaded.bytes.byteLength !== attachment.byteSize
        || await this.attachmentFiles.digestOwnedBytes(downloaded.bytes, signal) !== attachment.sha256Hex) {
        throw new Error("The authenticated uploaded image changed before editing.");
      }
      sourceBytes = Uint8Array.from(downloaded.bytes);
      sourceUri = bytesToDataUri(sourceBytes, attachment.mediaType);
    }

    const galleryImage = mobileImageGalleryMediaType(source.mediaType) ? inspectMobileImageGalleryBytes(sourceBytes, source.mediaType) : undefined;
    if (galleryImage?.previewMarkup || galleryImage?.previewBytes || galleryImage?.previewMediaType) {
      sourceUri = mobileImageGalleryPreviewUri(sourceBytes, galleryImage);
    }
    const lease: MobileComposerImageEditLease = {
      leaseId: distinctAttachmentStorageId(this.newId, attachment.attachmentId, source.storageId),
      request,
      profileId: credential.profileId,
      credentialKey: mobileCredentialKey(credential),
      surfaceOwnerKey: controls.surfaceOwnerKey,
      attachment: normalizeMobileComposerAttachment(attachment),
      source,
      sourceBytes: Uint8Array.from(sourceBytes),
      sourceUri,
      sourceStored: annotation !== undefined,
      commitInFlight: false,
      owner
    };
    this.#composerImageEdit = lease;
    try {
      await this.#assertComposerImageEditCurrent(lease, undefined, signal);
      const outputMediaType = mobileAnnotationOutputMediaType(source.mediaType);
      let annotatable = !galleryImage?.animated && !galleryImage?.originalOnly && canAnnotateMobileImage(source.mediaType);
      if (annotatable) {
        try {
          assertMobileAttachmentCandidate({
            fileName: mobileAnnotatedImageFileName(source.fileName, outputMediaType),
            mediaType: outputMediaType,
            byteSize: 1
          }, controls.policy);
        } catch {
          annotatable = false;
        }
      }
      return {
        leaseId: lease.leaseId,
        previewUri: sourceUri,
        sourceBase64: encodeMobileBase64(sourceBytes),
        sourceMediaType: source.mediaType,
        fileName: source.fileName,
        initialStrokes: (annotation?.strokes ?? []).map((stroke) => ({
          points: stroke.points.map((point) => ({ ...point }))
        })),
        annotatable,
        ...(galleryImage ? {
          expectedWidthPixels: galleryImage.width,
          expectedHeightPixels: galleryImage.height
        } : {}),
        ...(galleryImage?.nativeQuarterTurn ? { nativeQuarterTurn: true } : {}),
        animated: galleryImage?.animated === true,
        originalOnly: galleryImage?.originalOnly === true,
        ...(galleryImage?.previewMediaType ? { previewMediaType: galleryImage.previewMediaType } : {}),
        maximumBytes: controls.policy.maximumBytes
      };
    } catch (error) {
      if (this.#composerImageEdit === lease) this.#composerImageEdit = undefined;
      throw error;
    }
  }

  cancelComposerImageEditor(leaseId: string): void {
    if (this.#composerImageEdit?.leaseId === leaseId) this.#composerImageEdit = undefined;
  }

  async commitComposerImageEditor(
    leaseId: string,
    strokes: readonly MobileImageAnnotationStroke[],
    burned?: MobileBurnedImage,
    signal?: AbortSignal
  ): Promise<MobileComposerImageCommitResult> {
    signal?.throwIfAborted();
    const lease = this.#composerImageEdit;
    if (!lease || lease.leaseId !== leaseId || !this.attachmentFiles || !this.composerDrafts || !this.newTaskDrafts) {
      throw new Error("The image editor no longer owns this attachment.");
    }
    if (lease.commitInFlight) throw new Error("This image annotation is already being saved.");
    const exactStrokes = normalizeMobileAnnotationStrokes(strokes);
    const controls = this.#composerImageEditControls(lease);
    await this.#assertComposerImageEditCurrent(lease, undefined, signal);
    if (this.#composerImageEdit !== lease || lease.commitInFlight) {
      throw new Error("This image annotation is already being saved or no longer owns the attachment.");
    }
    lease.commitInFlight = true;
    try {
    if (exactStrokes.length === 0 && lease.attachment.annotation === undefined) {
      this.#composerImageEdit = undefined;
      const draft = lease.owner.kind === "task" ? lease.owner.draft : lease.owner.draft.input;
      return { surface: lease.request.surface, draft };
    }

    let outputBytes: Uint8Array;
    let outputMediaType: string;
    let outputFileName: string;
    let outputSha256Hex: string;
    if (exactStrokes.length === 0 && !mobileImageRequiresNativeRaster(lease.source.mediaType)) {
      outputBytes = Uint8Array.from(lease.sourceBytes);
      outputMediaType = lease.source.mediaType;
      outputFileName = lease.source.fileName;
      outputSha256Hex = lease.source.sha256Hex;
    } else {
      const sourceImage = mobileImageGalleryMediaType(lease.source.mediaType) !== undefined
        ? inspectMobileImageGalleryBytes(lease.sourceBytes, lease.source.mediaType) : undefined;
      if (!canAnnotateMobileImage(lease.source.mediaType) || !burned || sourceImage?.animated || sourceImage?.originalOnly) {
        throw new Error("This image cannot be rendered with annotations.");
      }
      const expectedMediaType = mobileAnnotationOutputMediaType(lease.source.mediaType);
      if (!(burned.bytes instanceof Uint8Array) || burned.bytes.byteLength < 1
        || burned.mediaType !== expectedMediaType
        || sniffMobileImageMediaType(burned.bytes) !== expectedMediaType
        || !Number.isSafeInteger(burned.width) || burned.width < 1
        || burned.width > MOBILE_ANNOTATION_MAX_BURN_DIMENSION
        || !Number.isSafeInteger(burned.height) || burned.height < 1
        || burned.height > MOBILE_ANNOTATION_MAX_BURN_DIMENSION) {
        throw new Error("The rendered annotation output is invalid.");
      }
      outputBytes = Uint8Array.from(burned.bytes);
      outputMediaType = burned.mediaType;
      outputFileName = exactStrokes.length > 0
        ? mobileAnnotatedImageFileName(lease.source.fileName, burned.mediaType)
        : mobileRasterizedImageFileName(lease.source.fileName, burned.mediaType);
      outputSha256Hex = await this.attachmentFiles.digestOwnedBytes(outputBytes, signal);
    }
    assertMobileAttachmentCandidate({
      fileName: outputFileName,
      mediaType: outputMediaType,
      byteSize: outputBytes.byteLength
    }, controls.policy);

    const originalInput = lease.owner.kind === "task" ? lease.owner.draft : lease.owner.draft.input;
    let sourceStaged = false;
    let output: MobileLocalComposerAttachment | undefined;
    let nextInput: MobileComposerDraft | undefined;
    let committed = false;
    try {
      if (exactStrokes.length > 0 && !lease.sourceStored) {
        await this.attachmentFiles.stageOwnedBytes(
          lease.profileId,
          lease.source.storageId,
          lease.sourceBytes,
          lease.source.sha256Hex,
          signal
        );
        sourceStaged = true;
      }
      const otherAttachments = originalInput.attachments.filter(
        (candidate) => candidate.attachmentId !== lease.attachment.attachmentId
      );
      output = await this.attachmentFiles.stageVerifiedBytes(
        lease.profileId,
        otherAttachments,
        controls.policy,
        {
          bytes: outputBytes,
          fileName: outputFileName,
          mediaType: outputMediaType,
          byteSize: outputBytes.byteLength,
          sha256Hex: outputSha256Hex
        },
        () => distinctAttachmentStorageId(
          this.newId,
          ...mobileComposerAttachmentStorageIds(originalInput.attachments),
          lease.source.storageId
        ),
        signal
      );
      const replacement = normalizeMobileComposerAttachment(exactStrokes.length === 0 ? output : {
        ...output,
        annotation: { source: lease.source, strokes: exactStrokes }
      });
      nextInput = normalizeMobileComposerDraft({
        ...originalInput,
        attachments: replaceMobileComposerAttachmentSlot(
          originalInput.attachments,
          lease.attachment,
          replacement
        )
      });
      assertMobileAttachmentPolicy(nextInput.attachments, controls.policy);
      await this.#assertComposerImageEditCurrent(lease, undefined, signal);
      if (lease.owner.kind === "task") {
        if (!this.composerDrafts.saveIfRevision(
          lease.owner.identity,
          nextInput,
          lease.owner.snapshot.revision
        )) throw new Error("The task composer changed while the annotated image was being saved.");
        committed = true;
        await this.composerDrafts.flush(lease.owner.identity);
      } else {
        if (!this.newTaskDrafts.saveIfRevision(lease.owner.identity, {
          targetId: lease.owner.draft.targetId,
          name: lease.owner.draft.name,
          input: nextInput
        }, lease.owner.snapshot.revision)) {
          throw new Error("The new-task composer changed while the annotated image was being saved.");
        }
        committed = true;
        await this.newTaskDrafts.flush(lease.owner.identity);
      }
      await this.#assertComposerImageEditCurrent(lease, nextInput, signal);
      await this.attachmentFiles.removeVisibleBytes(lease.profileId, lease.attachment).catch(() => undefined);
      if (exactStrokes.length === 0) {
        await this.attachmentFiles.removeOwnedBytes(lease.profileId, lease.source.storageId).catch(() => undefined);
      }
      this.#composerImageEdit = undefined;
      return { surface: lease.request.surface, draft: nextInput };
    } catch (error) {
      if (committed && nextInput) {
        committed = !await this.#restoreComposerImageDraft(lease, nextInput);
      }
      if (!committed && output) {
        await this.attachmentFiles.removeVisibleBytes(lease.profileId, output).catch(() => undefined);
      }
      if (!committed && sourceStaged) {
        await this.attachmentFiles.removeOwnedBytes(lease.profileId, lease.source.storageId).catch(() => undefined);
      }
      if (committed) this.#composerImageEdit = undefined;
      throw error;
    }
    } finally {
      if (this.#composerImageEdit === lease) lease.commitInFlight = false;
    }
  }

  #composerImageEditControls(lease: MobileComposerImageEditLease): MobileAttachmentControls {
    const credential = this.#ready();
    const controls = lease.owner.kind === "task"
      ? this.taskAttachmentControls()
      : this.newTaskAttachmentControls(lease.request.surface === "new-task" ? lease.request.targetId : "");
    const authorityCurrent = lease.owner.kind === "task"
      ? this.#taskAuthorityKey() === lease.owner.authorityKey
        && this.#state.selectedId === lease.owner.identity.sessionId
      : lease.request.surface === "new-task"
        ? this.#newTaskAuthorityKey(lease.request.targetId) !== undefined
          && lease.owner.draft.targetId === lease.request.targetId
        : false;
    if (this.#composerImageEdit !== lease || mobileCredentialKey(credential) !== lease.credentialKey
      || !authorityCurrent || !controls || controls.profileId !== lease.profileId
      || controls.surfaceOwnerKey !== lease.surfaceOwnerKey) {
      throw new Error("The image attachment owner changed while the editor was open.");
    }
    return controls;
  }

  async #assertComposerImageEditCurrent(
    lease: MobileComposerImageEditLease,
    expectedCommitted: MobileComposerDraft | undefined,
    signal?: AbortSignal
  ): Promise<void> {
    signal?.throwIfAborted();
    let current: MobileComposerDraft;
    if (lease.owner.kind === "task") {
      const snapshot = await this.composerDrafts!.readSnapshot(lease.owner.identity);
      signal?.throwIfAborted();
      if (snapshot.draft === undefined
        || expectedCommitted === undefined && snapshot.revision !== lease.owner.snapshot.revision) {
        throw new Error("The task composer changed while the image editor was open.");
      }
      current = snapshot.draft;
    } else {
      const snapshot = await this.newTaskDrafts!.readSnapshot(lease.owner.identity);
      signal?.throwIfAborted();
      if (!snapshot.draft || snapshot.draft.submission
        || snapshot.draft.targetId !== lease.owner.draft.targetId
        || snapshot.draft.name !== lease.owner.draft.name
        || expectedCommitted === undefined && snapshot.revision !== lease.owner.snapshot.revision) {
        throw new Error("The new-task composer changed while the image editor was open.");
      }
      current = snapshot.draft.input;
    }
    const expected = expectedCommitted
      ?? (lease.owner.kind === "task" ? lease.owner.draft : lease.owner.draft.input);
    if (!mobileComposerDraftsEqual(current, expected)) {
      throw new Error("The composer changed while the image editor was open.");
    }
    const controls = this.#composerImageEditControls(lease);
    assertMobileAttachmentPolicy(current.attachments, controls.policy);
    if (expectedCommitted === undefined) {
      const attachment = exactComposerAttachment(current.attachments, lease.attachment.attachmentId);
      if (!mobileComposerAttachmentsEqual(attachment, lease.attachment)) {
        throw new Error("The selected image changed while the editor was open.");
      }
    }
  }

  async #restoreComposerImageDraft(
    lease: MobileComposerImageEditLease,
    committed: MobileComposerDraft
  ): Promise<boolean> {
    if (lease.owner.kind === "task") {
      return this.#restoreFilesComposerDraft(lease.owner.identity, lease.owner.snapshot, committed);
    }
    try {
      const current = await this.newTaskDrafts!.readSnapshot(lease.owner.identity);
      if (!current.draft || current.draft.submission
        || current.draft.targetId !== lease.owner.draft.targetId
        || current.draft.name !== lease.owner.draft.name
        || !mobileComposerDraftsEqual(current.draft.input, committed)) return false;
      if (!this.newTaskDrafts!.saveIfRevision(lease.owner.identity, {
        targetId: lease.owner.draft.targetId,
        name: lease.owner.draft.name,
        input: lease.owner.draft.input
      }, current.revision)) return false;
      await this.newTaskDrafts!.flush(lease.owner.identity);
      return true;
    } catch {
      return false;
    }
  }

  async voiceDictionaryReadOnlyTransport(profileId: string, signal: AbortSignal): Promise<MobileReadOnlyDictionaryTransport> {
    const profile = this.#profiles.find((candidate) => candidate.profileId === profileId);
    if (!profile) throw new Error("The saved dictionary source is no longer available.");
    const scope = mobileReadOnlyDictionaryScope(profile);
    const connectionEpoch = this.#connectionAttemptEpoch;
    let retired = false;
    const isCurrent = (): boolean => !retired && !signal.aborted && !this.#disposed && this.#foreground
      && this.#connectionAttemptEpoch === connectionEpoch
      && this.#profiles.some((candidate) => mobileReadOnlyDictionaryScope(candidate) === scope)
      && !this.#state.saved.some((candidate) => candidate.profileId === profileId
        && ["missing", "unreadable", "identity-conflict"].includes(candidate.credentialState));
    const assertCurrent = (): void => { if (!isCurrent()) throw new Error("The read-only dictionary source changed or was cancelled."); };
    const owned = async <T>(caller: AbortSignal | undefined, effect: (request: AbortSignal) => Promise<T>): Promise<T> => {
      const request = new AbortController();
      const cancel = (): void => request.abort();
      assertCurrent();
      if (caller?.aborted) cancel(); else caller?.addEventListener("abort", cancel, { once: true });
      signal.addEventListener("abort", cancel, { once: true });
      const unsubscribe = this.subscribe(() => { if (!isCurrent()) { retired = true; cancel(); } });
      try { request.signal.throwIfAborted(); const value = await effect(request.signal); request.signal.throwIfAborted(); assertCurrent(); return value; }
      finally { cancel(); unsubscribe(); signal.removeEventListener("abort", cancel); caller?.removeEventListener("abort", cancel); }
    };
    const invalidate = async (error: unknown): Promise<void> => {
      if (!isCurrent() || (!isRevoked(error) && !(error instanceof CredentialIdentityError) && !isEndpointTrustError(error))) return;
      if (this.#activeProfileId === profileId && this.#credential) {
        if (isRevoked(error)) await this.#invalidateCredential(this.#epoch, profileId, "The dictionary source connection was revoked.");
        else await this.#identityConflict(this.#epoch, profileId, "The saved dictionary source identity changed.");
        return;
      }
      const cleanup = await this.#clearOfflineCache(profileId);
      if (!isCurrent()) return;
      let credentialFailure: string | undefined;
      if (isRevoked(error)) {
        try { await this.storage.deleteCredential(profileId); }
        catch { credentialFailure = "The retired dictionary credential could not be cleared."; }
      }
      if (!isCurrent()) return;
      const detail = ["The saved dictionary source must be paired again.", cleanup, credentialFailure].filter(Boolean).join(" ");
      this.#set({ saved: this.#savedViews(profileId, isRevoked(error) ? credentialFailure ? "unavailable" : "missing" : "identity-conflict", detail) });
      retired = true;
    };
    let node: NodeIdentity;
    let credential: PairedCredential;
    let generation: bigint;
    try {
      const proven = await owned(signal, async (request) => {
        await this.storage.loadEndpointTransport?.(profile);
        rememberEndpointTrust(profile);
        const observed = await this.network.inspect(profile.origin, request);
        assertCurrent();
        if (observed.serverId !== profile.serverId) throw new CredentialIdentityError();
        const saved = await this.storage.loadCredential(profileId);
        request.throwIfAborted(); assertCurrent();
        if (!saved || !credentialMatchesProfile(saved, profile)) throw new CredentialIdentityError();
        const owner = await this.network.readOwner(saved, this.deviceNameSource(), request);
        assertCurrent(); this.#assertOwner(saved, owner, observed);
        if (owner.snapshot.connections.filter((item) => item.connectionId === saved.connectionId).length !== 1
          || owner.snapshot.devices.filter((item) => item.deviceId === saved.deviceId).length !== 1
          || !owner.device.connectionIds.includes(saved.connectionId)
          || !owner.snapshot.devices.find((item) => item.deviceId === saved.deviceId)!.connectionIds.includes(saved.connectionId)
          || owner.snapshot.generation < 1n) throw new CredentialIdentityError();
        return { node: observed, credential: Object.freeze({ ...saved }), generation: owner.snapshot.generation };
      });
      ({ node, credential, generation } = proven);
    } catch (error) { await invalidate(error); throw error; }
    const subscribe = this.subscribe.bind(this);
    const network = this.network;
    const recheck = async (request: AbortSignal): Promise<void> => {
      const owner = await network.readOwner(credential, this.deviceNameSource(), request);
      assertCurrent(); this.#assertOwner(credential, owner, node);
      if (owner.snapshot.generation !== generation) throw new Error("The dictionary source generation changed. Refresh to revalidate it.");
    };
    return {
      profile: { profileId: profile.profileId, origin: profile.origin, serverId: profile.serverId,
        connectionId: profile.connectionId, deviceId: profile.deviceId, displayName: node.displayName },
      ownerKey: `${scope}\u001f${generation}\u001f${connectionEpoch}\u001fread-only-dictionary`, isCurrent,
      getVoiceInputDictionaryReadOnly: async (caller) => {
        try { return await owned(caller, (request) => network.getVoiceInputDictionaryReadOnly(credential, request)); }
        catch (error) { await invalidate(error); throw error; }
      },
      watchVoiceInputDictionaryReadOnly: (caller) => (async function* () {
        const request = new AbortController();
        const cancel = (): void => request.abort();
        assertCurrent();
        if (caller.aborted) cancel(); else caller.addEventListener("abort", cancel, { once: true });
        signal.addEventListener("abort", cancel, { once: true });
        const unsubscribe = subscribe(() => { if (!isCurrent()) { retired = true; cancel(); } });
        let ownerRechecked = false;
        try {
          for await (const value of network.watchVoiceInputDictionaryReadOnly(credential, request.signal)) {
            request.signal.throwIfAborted(); assertCurrent(); yield value;
          }
          request.signal.throwIfAborted(); assertCurrent();
          // A revoked idle Watch may close normally. Prove its original owner before retaining a cache.
          ownerRechecked = true;
          await recheck(request.signal);
          throw new Error("The read-only dictionary stream ended.");
        } catch (error) {
          request.signal.throwIfAborted(); assertCurrent();
          let failure = error;
          // Linkspan may retire the carrier before a revoked Watch can send
          // its EOF. Transport failure alone cannot revoke a saved credential;
          // ask the same pinned owner while this request still owns its scope.
          if (!ownerRechecked && !isRevoked(error) && !(error instanceof CredentialIdentityError)) {
            try { await recheck(request.signal); }
            catch (recheckError) { failure = recheckError; }
          }
          request.signal.throwIfAborted(); assertCurrent();
          await invalidate(failure); throw failure;
        }
        finally { cancel(); unsubscribe(); caller.removeEventListener("abort", cancel); signal.removeEventListener("abort", cancel); }
      })()
    };
  }

  voiceInputSettingsTransport(): MobileVoiceSettingsTransport | undefined {
    const credential = this.#credential;
    const authorityKey = this.#automationOwnerKey();
    if (!credential || !authorityKey || this.#disposed) return undefined;
    const connectionEpoch = this.#connectionAttemptEpoch;
    let retired = false;
    const isCurrent = (): boolean => !retired && !this.#disposed && this.#credential === credential
      && this.#connectionAttemptEpoch === connectionEpoch && this.#automationOwnerKey() === authorityKey;
    const owned = async <T>(signal: AbortSignal | undefined, effect: (current: AbortSignal) => Promise<T>): Promise<T> => {
      const request = new AbortController();
      const cancel = (): void => request.abort();
      const assertCurrent = (): void => {
        if (request.signal.aborted || signal?.aborted || !isCurrent()) throw new Error("Voice service authority changed or the request was cancelled.");
      };
      signal?.addEventListener("abort", cancel, { once: true });
      const unsubscribe = this.subscribe(() => { if (!isCurrent()) { retired = true; request.abort(); } });
      try { assertCurrent(); const result = await effect(request.signal); assertCurrent(); return result; }
      finally { request.abort(); unsubscribe(); signal?.removeEventListener("abort", cancel); }
    };
    const hasPending = (): boolean => this.#state.pending.some((receipt) => receipt.kind === "voice-settings" && receipt.connectionId === credential.connectionId);
    return {
      ownerKey: `${authorityKey}\u001f${connectionEpoch}\u001fvoice-settings`, isCurrent, hasPending,
      get: (signal) => owned(signal, (current) => this.network.getVoiceInputServiceSettings(credential, current)),
      getCapabilities: (signal) => owned(signal, (current) => this.network.getVoiceInputCapabilities(credential, current)),
      test: (signal) => owned(signal, (current) => this.network.testVoiceInputConnection(credential, current)),
      reconcile: (signal) => owned(signal, async (current) => { current.throwIfAborted(); await this.reconcile(); }),
      save: (source, secrets, signal) => owned(signal, async (current) => {
        if (hasPending()) throw new Error("Check the existing voice settings operation receipt before saving again.");
        const action = this.#claimMutation();
        const patch = clone(VoiceInputServiceSettingsPatchSchema, source);
        try {
          const before = await this.network.getVoiceInputServiceSettings(credential, current);
          current.throwIfAborted();
          if (!isCurrent()) throw new Error("Voice service authority changed.");
          if (patch.expectedRevision?.value !== before.version?.revision?.value) throw new Error("Voice service configuration changed. Refresh and review your draft.");
          for (const fallback of [false, true]) {
            const secret = fallback ? secrets?.fallback : secrets?.primary;
            const clear = fallback ? patch.clearFallbackCredential : patch.clearCredential;
            const configured = fallback ? before.fallbackCredentialConfigured : before.credentialConfigured;
            if (configured && mobileVoiceCredentialBindingChanged(before, patch, fallback) && !secret && clear !== true) {
              throw new Error("Replace or clear the credential when its protocol, origin, authentication or APP ID changes.");
            }
            if (secret !== undefined && secret !== "") {
              const ticket = await this.network.uploadVoiceInputSecret(credential, secret, fallback, current);
              current.throwIfAborted();
              if (!isCurrent()) throw new Error("Voice service authority changed.");
              if (fallback) patch.fallbackCredentialUploadTicketId = ticket;
              else patch.credentialUploadTicketId = ticket;
            }
          }
          const result = await this.#submitTerminal(create(OperationMutationSchema, {
            payload: { case: "updateVoiceInputServiceSettings", value: create(UpdateVoiceInputServiceSettingsMutationSchema, { patch }) }
          }), { kind: "voice-settings" }, undefined, true, false, { signal: current, isCurrent });
          current.throwIfAborted();
          if (!result.definitive) throw new Error("The voice settings result is unknown. Check the existing operation receipt; it was not resent.");
          if (!result.accepted) throw new Error("The voice service rejected the configuration. Refresh and review your draft.");
          return this.network.getVoiceInputServiceSettings(credential, current);
        } finally { this.#releaseMutation(action); }
      })
    };
  }

  voiceDictionaryTransport(): MobileVoiceDictionaryTransport | undefined {
    const credential = this.#credential;
    const authorityKey = this.#automationOwnerKey();
    if (!credential || !authorityKey || this.#disposed) return undefined;
    const connectionEpoch = this.#connectionAttemptEpoch;
    const ownerKey = `${authorityKey}\u001f${connectionEpoch}\u001fvoice-dictionary`;
    let retired = false;
    const isCurrent = (): boolean => !retired && !this.#disposed && this.#credential === credential
      && this.#connectionAttemptEpoch === connectionEpoch && this.#automationOwnerKey() === authorityKey;
    const owned = async <T>(signal: AbortSignal | undefined, effect: () => Promise<T>): Promise<T> => {
      const assertCurrent = (): void => {
        if (signal?.aborted || !isCurrent()) throw new Error("Voice dictionary authority changed or the request was cancelled.");
      };
      assertCurrent();
      const unsubscribe = this.subscribe(() => { if (!isCurrent()) retired = true; });
      try {
        const result = await effect();
        assertCurrent();
        return result;
      } finally { unsubscribe(); }
    };
    const subscribe = this.subscribe.bind(this);
    const ownedStream = <T>(signal: AbortSignal, effect: (signal: AbortSignal) => AsyncIterable<T>): AsyncIterable<T> => (async function* () {
      const request = new AbortController();
      const cancel = (): void => request.abort();
      const assertCurrent = (): void => {
        if (signal.aborted || request.signal.aborted || !isCurrent()) throw new Error("Voice dictionary authority changed or the request was cancelled.");
      };
      assertCurrent();
      signal.addEventListener("abort", cancel, { once: true });
      const unsubscribe = subscribe(() => { if (!isCurrent()) { retired = true; request.abort(); } });
      try {
        for await (const value of effect(request.signal)) { assertCurrent(); yield value; }
        assertCurrent();
      } finally { request.abort(); unsubscribe(); signal.removeEventListener("abort", cancel); }
    })();
    return {
      ownerKey, isCurrent,
      getVoiceInputDictionary: (signal) => owned(signal, () => this.network.getVoiceInputDictionary(credential, signal)),
      watchVoiceInputDictionary: (signal) => ownedStream(signal, (current) => this.network.watchVoiceInputDictionary(credential, current)),
      getVoiceInputDictionaryPeerStatus: (signal) => owned(signal, () => this.network.getVoiceInputDictionaryPeerStatus(credential, signal)),
      watchVoiceInputDictionaryPeerStatus: (signal) => ownedStream(signal, (current) => this.network.watchVoiceInputDictionaryPeerStatus(credential, current)),
      grantVoiceInputDictionaryPeer: (revision, id, fingerprint, signal) => owned(signal, () => this.network.grantVoiceInputDictionaryPeer(credential, revision, id, fingerprint, signal)),
      revokeVoiceInputDictionaryPeer: (id, revision, signal) => owned(signal, () => this.network.revokeVoiceInputDictionaryPeer(credential, id, revision, signal)),
      syncVoiceInputDictionaryNow: (revision, id, signal) => owned(signal, () => this.network.syncVoiceInputDictionaryNow(credential, revision, id, signal)),
      configureVoiceInputDictionaryListener: (revision, listener, signal) => owned(signal, () => this.network.configureVoiceInputDictionaryListener(credential, revision, listener, signal)),
      getVoiceInputDictionaryPeerInvitation: (signal) => owned(signal, () => this.network.getVoiceInputDictionaryPeerInvitation(credential, signal)),
      grantVoiceInputDictionaryDirectPeer: (revision, invitation, fingerprint, signal) => owned(signal, () => this.network.grantVoiceInputDictionaryDirectPeer(credential, revision, invitation, fingerprint, signal)),
      clearVoiceInputDictionaryPeerRoute: (revision, id, signal) => owned(signal, () => this.network.clearVoiceInputDictionaryPeerRoute(credential, revision, id, signal)),
      setVoiceInputDictionarySyncEnabled: (revision, enabled, signal) => owned(signal, () => this.network.setVoiceInputDictionarySyncEnabled(credential, revision, enabled, signal)),
      addVoiceInputDictionaryTerms: (revision, terms, signal) => owned(signal, () => this.network.addVoiceInputDictionaryTerms(credential, revision, terms, signal)),
      editVoiceInputDictionaryEntry: (revision, id, text, aliases, signal) => owned(signal, () => this.network.editVoiceInputDictionaryEntry(credential, revision, id, text, aliases, signal)),
      deleteVoiceInputDictionaryEntry: (revision, id, signal) => owned(signal, () => this.network.deleteVoiceInputDictionaryEntry(credential, revision, id, signal)),
      applyVoiceInputDictionaryLearning: (revision, actions, signal) => owned(signal, () => this.network.applyVoiceInputDictionaryLearning(credential, revision, actions, signal))
    };
  }

  taskVoiceTransport(): MobileVoiceTransport | undefined {
    const authorityKey = this.#taskAuthorityKey();
    const credential = this.#credential;
    if (!authorityKey || !credential) return undefined;
    const surfaceOwnerKey = `${authorityKey}\u001fvoice-input`;
    return this.#voiceTransport(credential, surfaceOwnerKey, () => {
      const current = this.#taskAuthorityKey();
      return current === undefined ? undefined : `${current}\u001fvoice-input`;
    });
  }

  async listTaskCatalogMentionCatalog(
    expectedSurfaceOwnerKey: string,
    signal?: AbortSignal
  ): Promise<MobileCatalogMentionCatalog> {
    const context = this.#catalogMentionContext(expectedSurfaceOwnerKey);
    const [resources, artifacts] = await Promise.all([
      context.controls.policy.resources
        ? this.network.listSessionResources(context.credential, context.controls.sessionId, signal)
        : Promise.resolve(undefined),
      context.controls.policy.artifacts
        ? this.network.listArtifactReferenceCatalog(
            context.credential,
            context.controls.sessionId,
            BigInt(context.controls.runtimeGeneration),
            signal
          )
        : Promise.resolve(undefined)
    ]);
    const current = this.#catalogMentionContext(expectedSurfaceOwnerKey);
    if (current.controls.surfaceOwnerKey !== context.controls.surfaceOwnerKey) {
      throw new Error("The catalog reference owner changed while its candidates were loading.");
    }
    return {
      ...(resources === undefined ? {} : {
        resources: projectMobileResourceMentionCatalog(context.controls, resources)
      }),
      ...(artifacts === undefined ? {} : {
        artifacts: projectMobileArtifactMentionCatalog(
          context.controls,
          artifacts.artifacts,
          artifacts.revision
        )
      })
    };
  }

  async listTaskRuntimeCommands(
    expectedSurfaceOwnerKey: string,
    signal?: AbortSignal
  ): Promise<MobileRuntimeCommandCatalog> {
    const context = this.#runtimeCommandContext(expectedSurfaceOwnerKey);
    const commands = await this.network.listRuntimeCommands(
      context.credential,
      context.controls.sessionId,
      signal
    );
    const afterCommands = this.#runtimeCommandContext(expectedSurfaceOwnerKey);
    const detail = await this.network.readSession(afterCommands.credential, afterCommands.controls.sessionId, signal);
    signal?.throwIfAborted();
    const current = this.#runtimeCommandContext(expectedSurfaceOwnerKey);
    const refreshed = createMobileRuntimeCommandControls(
      current.controls.authorityKey,
      this.#state.owner,
      detail,
      this.#state.selectedId
    );
    if (!refreshed || refreshed.surfaceOwnerKey !== context.controls.surfaceOwnerKey) {
      throw new Error("The task runtime changed while its command catalog was loading.");
    }
    return projectMobileRuntimeCommandCatalog(refreshed, commands);
  }

  async resolveTaskRuntimeCommandResource(
    expectedSurfaceOwnerKey: string,
    catalog: MobileRuntimeCommandCatalog,
    candidate: MobileRuntimeCommandCandidate,
    signal?: AbortSignal
  ): Promise<MobileResourceMentionCandidate> {
    signal?.throwIfAborted();
    const context = this.#runtimeCommandContext(expectedSurfaceOwnerKey);
    const command = assertMobileRuntimeCommandCandidate(context.controls, catalog, candidate);
    const controls = this.taskCatalogMentionControls();
    if (command.inputMode !== RuntimeCommandInputMode.RESOURCE_MENTION || !command.resourceId
      || !context.controls.resourceMentions || !controls?.policy.resources
      || controls.authorityKey !== context.controls.authorityKey || controls.sessionId !== context.controls.sessionId
      || controls.backendId !== context.controls.backendId || controls.targetId !== context.controls.targetId
      || controls.runtimeGeneration !== context.controls.runtimeGeneration) {
      throw new Error("The selected command does not have a current Resource receiver.");
    }
    const resources = await this.network.listSessionResources(context.credential, controls.sessionId, signal);
    signal?.throwIfAborted();
    const current = this.#runtimeCommandContext(expectedSurfaceOwnerKey);
    assertMobileRuntimeCommandCandidate(current.controls, catalog, command);
    this.#catalogMentionContext(controls.surfaceOwnerKey);
    const projected = projectMobileResourceMentionCatalog(controls, resources);
    const matches = projected.items.filter((resource) => resource.resourceId === command.resourceId);
    if (matches.length !== 1 || matches[0]!.resourceKind !== ResourceKind.SKILL) {
      throw new Error("The selected Skill is no longer loaded in this task. Refresh its command list.");
    }
    return matches[0]!;
  }

  async executeTaskAppCommand(
    expectedSurfaceOwnerKey: string,
    invocation: MobileAppCommandInvocation,
    draft: MobileComposerDraft
  ): Promise<MobileAppCommandOutcome> {
    const initial = this.#appCommandContext(expectedSurfaceOwnerKey);
    let command = assertMobileAppCommandInvocation(initial.controls, draft, invocation);
    this.#assertNoPendingAppCommand(initial.controls.session.sessionId);
    if (!this.composerDrafts) throw new Error("Retained task drafts are unavailable on this mobile client.");
    const identity = {
      profileId: initial.credential.profileId,
      sessionId: initial.controls.session.sessionId
    };
    let operationDraft = normalizeMobileComposerDraft(draft);
    this.composerDrafts.save(identity, operationDraft);
    await this.composerDrafts.flush(identity);
    let snapshot = await this.composerDrafts.readSnapshot(identity);
    if (!snapshot.draft || !mobileComposerDraftsEqual(snapshot.draft, operationDraft)) {
      throw new Error("The retained task draft changed before its app command could run.");
    }
    const current = this.#appCommandContext(expectedSurfaceOwnerKey);
    command = assertMobileAppCommandInvocation(current.controls, operationDraft, command);

    if (command.kind === "help") {
      const retained = normalizeMobileComposerDraft({
        text: "",
        mentions: [],
        atoms: [],
        slashCommands: [],
        attachments: operationDraft.attachments
      });
      if (!this.composerDrafts.saveIfRevision(identity, retained, snapshot.revision)) {
        throw new Error("The task draft changed before command help could open.");
      }
      await this.composerDrafts.flush(identity);
      return { kind: "help", status: "succeeded" };
    }

    if (command.kind === "jumpSession") {
      if (!await this.composerDrafts.clearIfRevision(identity, snapshot.revision)) {
        throw new Error("The task draft changed before task navigation could begin.");
      }
      await this.composerDrafts.flush(identity);
      const cleared = await this.composerDrafts.readSnapshot(identity);
      if (cleared.draft) throw new Error("The task draft could not be cleared before task navigation.");
      try {
        const latest = this.#appCommandContext(expectedSurfaceOwnerKey);
        assertMobileAppCommandInvocation(latest.controls, operationDraft, command);
        await this.select(command.sessionId);
      } catch (error) {
        const retained = await this.composerDrafts.readSnapshot(identity);
        if (!retained.draft && retained.revision === cleared.revision
          && this.composerDrafts.saveIfRevision(identity, operationDraft, retained.revision)) {
          await this.composerDrafts.flush(identity);
        }
        throw error;
      }
      return { kind: "jumpSession", status: "succeeded", sessionId: command.sessionId };
    }

    if (!isMobileRemoteAppCommandInvocation(command)) {
      throw new Error("The app command cannot be dispatched to the Joko node.");
    }
    let remoteCommand: MobileRemoteAppCommandInvocation = command;

    const sessionId = current.controls.session.sessionId;
    const generation = current.controls.session.nativeBinding!.runtimeGeneration;
    const appKind = remoteCommand.kind;
    const shellOwner = appKind === "userShell" ? Symbol("mobile user shell") : undefined;
    if (shellOwner) {
      if (this.#userShellFlight || this.#mutationOwner || this.#connectionAttemptAbort || this.#state.busy) {
        throw new Error("Another task or connection operation is already in progress.");
      }
      this.#cancelCatalogAttempt();
      this.#userShellFlight = { owner: shellOwner, sessionId };
    }
    const action = shellOwner === undefined ? this.#claimMutation() : undefined;
    try {
      if (remoteCommand.kind === "review" && operationDraft.attachments.length > 0) {
        if (operationDraft.attachments.length > 20) throw new Error("Review accepts at most 20 attachments.");
        const attachmentControls = this.taskAttachmentControls();
        if (!attachmentControls) throw new Error("This task Backend does not accept Review attachments.");
        assertMobileAttachmentPolicy(operationDraft.attachments, attachmentControls.policy);
        operationDraft = await this.#uploadTaskAttachments(
          identity,
          operationDraft,
          current.controls.authorityKey,
          attachmentControls.surfaceOwnerKey,
          current.credential,
          generation
        );
        snapshot = await this.composerDrafts.readSnapshot(identity);
        if (!snapshot.draft || !mobileComposerDraftsEqual(snapshot.draft, operationDraft)) {
          throw new Error("The retained Review draft changed while its attachments were uploading.");
        }
      }
      const dispatch = this.#appCommandContext(expectedSurfaceOwnerKey);
      const currentCommand = assertMobileAppCommandInvocation(dispatch.controls, operationDraft, remoteCommand);
      if (!isMobileRemoteAppCommandInvocation(currentCommand)) {
        throw new Error("The app command changed before it could be dispatched.");
      }
      remoteCommand = currentCommand;
      this.#assertNoPendingAppCommand(sessionId);
      const preconditions = [this.#sessionRuntimePrecondition(dispatch.controls.session)];
      const mutation = remoteCommand.kind === "userShell"
        ? create(OperationMutationSchema, {
            preconditions,
            payload: { case: "executeUserShell", value: create(ExecuteUserShellMutationSchema, {
              sessionId,
              command: remoteCommand.command,
              excludeFromContext: false
            }) }
          })
          : remoteCommand.kind === "sessionReset"
          ? create(OperationMutationSchema, {
              preconditions,
              payload: { case: "resetSession", value: create(ResetSessionMutationSchema, { sessionId }) }
            })
          : create(OperationMutationSchema, {
              preconditions,
              payload: { case: "startReview", value: create(StartReviewMutationSchema, {
                sourceSessionId: sessionId,
                focus: remoteCommand.focus,
                attachments: operationDraft.attachments.map((attachment) => {
                  if (attachment.state !== "uploaded") throw new Error("Finish uploading every Review attachment before starting.");
                  return create(ReviewAttachmentInputSchema, {
                    kind: attachment.kind === "image" ? ReviewAttachmentKind.IMAGE : ReviewAttachmentKind.FILE,
                    displayName: attachment.fileName,
                    blob: create(BlobRefSchema, {
                      blobId: attachment.blobId,
                      fileName: attachment.fileName,
                      mediaType: attachment.mediaType,
                      byteSize: BigInt(attachment.byteSize),
                      sha256Hex: attachment.sha256Hex,
                      disposition: BlobDisposition.ATTACHMENT
                    })
                  });
                })
              }) }
            });
      const kind = remoteCommand.kind === "userShell" ? "session-shell"
        : remoteCommand.kind === "sessionReset" ? "session-reset" : "session-review";
      const result = await this.#submitTerminal(
        mutation,
        { kind, sessionId },
        undefined,
        remoteCommand.kind !== "userShell"
      );
      if (!result.definitive) return remoteCommand.kind === "review"
        ? { kind: "review", status: "unknown" }
        : { kind: remoteCommand.kind, status: "unknown" };
      if (!result.accepted) return remoteCommand.kind === "review"
        ? { kind: "review", status: "rejected" }
        : { kind: remoteCommand.kind, status: "rejected" };
      const payload = result.operation?.result?.payload;
      if (remoteCommand.kind === "userShell") {
        if (result.operation?.state !== OperationState.SUCCEEDED || payload?.case !== "acknowledgement"
          || payload.value.accepted !== true) {
          throw new Error("The Joko node completed the shell command without a typed acknowledgement.");
        }
      } else if (remoteCommand.kind === "sessionReset") {
        const resetGeneration = payload?.case === "session"
          ? payload.value.nativeBinding?.runtimeGeneration : undefined;
        if (result.operation?.state !== OperationState.SUCCEEDED || payload?.case !== "session"
          || payload.value.sessionId !== sessionId
          || payload.value.backendId !== dispatch.controls.backendId
          || payload.value.targetId !== dispatch.controls.targetId
          || !resetGeneration || resetGeneration <= generation
          || payload.value.version?.generation !== resetGeneration
          || !payload.value.version.revision || payload.value.version.revision.value < 1n) {
          throw new Error("The Joko node completed task clearing without the same product task.");
        }
      } else {
        if (result.operation?.state !== OperationState.SUCCEEDED || payload?.case !== "reviewRun"
          || !payload.value.reviewRunId || !payload.value.reviewerSessionId
          || payload.value.reviewerSessionId === sessionId
          || payload.value.sourceSessionId !== sessionId || payload.value.state === ReviewRunState.UNSPECIFIED) {
          throw new Error("The Joko node accepted Review without a valid isolated review task.");
        }
      }
      const consumed = await this.composerDrafts.clearIfEqual(identity, operationDraft);
      if (consumed) await this.#removeConsumedAppCommandAttachments(identity.profileId, operationDraft.attachments);
      if (remoteCommand.kind === "review") {
        return { kind: "review", status: "succeeded", reviewRunId: payload!.case === "reviewRun"
          ? payload.value.reviewRunId : undefined };
      }
      return { kind: remoteCommand.kind, status: "succeeded" };
    } finally {
      if (action) this.#releaseMutation(action);
      if (shellOwner && this.#userShellFlight?.owner === shellOwner) this.#userShellFlight = undefined;
    }
  }

  async validateTaskCatalogMentionCandidate(
    expectedSurfaceOwnerKey: string,
    value: MobileCatalogMentionCandidate,
    signal?: AbortSignal
  ): Promise<MobileCatalogMentionCandidate> {
    const context = this.#catalogMentionContext(expectedSurfaceOwnerKey);
    if (value.kind === "resource" && !context.controls.policy.resources
      || value.kind === "artifact" && !context.controls.policy.artifacts) {
      throw new Error(`This Backend no longer supports ${value.kind === "resource" ? "Resource" : "Artifact"} references.`);
    }
    const catalog = await this.listTaskCatalogMentionCatalog(expectedSurfaceOwnerKey, signal);
    return assertMobileCatalogMentionCandidate(
      this.#catalogMentionContext(expectedSurfaceOwnerKey).controls,
      catalog,
      value
    );
  }

  async listTaskWorkspaceMentionDirectory(
    expectedSurfaceOwnerKey: string,
    parentPath: string,
    signal?: AbortSignal
  ): Promise<MobileWorkspaceMentionDirectory> {
    const context = this.#workspaceMentionContext(expectedSurfaceOwnerKey);
    const parent = canonicalWorkspacePath(parentPath, true);
    const result = await this.network.listWorkspaceDirectory(
      context.credential,
      context.controls.workspaceId,
      parent,
      signal
    );
    const current = this.#workspaceMentionContext(expectedSurfaceOwnerKey);
    if (current.controls.surfaceOwnerKey !== context.controls.surfaceOwnerKey) {
      throw new Error("The Workspace reference owner changed while its directory was loading.");
    }
    return projectMobileWorkspaceMentionDirectory(context.controls, parent, result.entries, result.revision);
  }

  async listTaskWorkspaceMentionFileIndex(
    expectedSurfaceOwnerKey: string,
    signal?: AbortSignal
  ): Promise<MobileWorkspaceMentionFileIndex> {
    const context = this.#workspaceMentionContext(expectedSurfaceOwnerKey);
    if (!context.controls.policy.files) throw new Error("This Backend does not support Workspace file references.");
    const result = await this.network.listWorkspaceFileIndex(
      context.credential,
      context.controls.workspaceId,
      signal
    );
    const current = this.#workspaceMentionContext(expectedSurfaceOwnerKey);
    if (current.controls.surfaceOwnerKey !== context.controls.surfaceOwnerKey) {
      throw new Error("The Workspace reference owner changed while its file index was loading.");
    }
    return projectMobileWorkspaceMentionFileIndex(
      context.controls,
      result.paths,
      result.revision,
      result.truncated
    );
  }

  async validateTaskWorkspaceMentionCandidate(
    expectedSurfaceOwnerKey: string,
    value: MobileWorkspaceMentionCandidate,
    signal?: AbortSignal
  ): Promise<MobileWorkspaceMentionCandidate> {
    const context = this.#workspaceMentionContext(expectedSurfaceOwnerKey);
    const expected = assertMobileWorkspaceMentionCandidate(context.controls, value);
    const directory = await this.listTaskWorkspaceMentionDirectory(
      expectedSurfaceOwnerKey,
      workspaceParentPath(expected.relativePath),
      signal
    );
    const matches = directory.entries.filter((entry) => entry.relativePath === expected.relativePath);
    const current = matches.length === 1 ? matches[0] : undefined;
    if (!current || current.directory !== expected.directory) {
      throw new Error("The selected Workspace path is no longer available with the same file type.");
    }
    return assertMobileWorkspaceMentionCandidate(
      this.#workspaceMentionContext(expectedSurfaceOwnerKey).controls,
      current
    );
  }

  async setTaskModel(authorityKey: string, selection: MobileModelControlSelection): Promise<boolean> {
    const controls = this.#runtimeControlContext(authorityKey);
    const selected = assertMobileModelSelection(controls, selection);
    this.#assertNoPendingRuntimeControl(controls.session.sessionId);
    const action = this.#claimMutation();
    try {
      if (controls.unifiedSources && this.network.getSessionRuntimeControl) {
        const credential = this.#ready();
        const control = await this.network.getSessionRuntimeControl(credential, controls.session.sessionId, this.#abort?.signal);
        this.#runtimeControlContext(authorityKey);
        if (control.handoffState === "unknown") throw new Error("Recover the previous model source handoff before choosing another source.");
        const result = await this.#submitTerminal(create(OperationMutationSchema, {
          preconditions: [this.#sessionRuntimePrecondition(controls.session)],
          payload: { case: "setSessionRuntime", value: create(SetSessionRuntimeMutationSchema, {
            sessionId: controls.session.sessionId, expectedRuntimeGeneration: control.generation,
            backendId: selected.backendId ?? controls.backend.backendId, providerId: selected.providerId,
            modelId: selected.modelId, effort: selected.effortId ?? "", ...encodeModelSpeed(selected.fastMode)
          }) }
        }), { kind: "session-model", sessionId: controls.session.sessionId });
        if (result.accepted && result.definitive) await this.refreshTaskRuntimeSelection().catch(() => undefined);
        return result.accepted && result.definitive;
      }
      const result = await this.#submitTerminal(create(OperationMutationSchema, {
        preconditions: [this.#sessionRuntimePrecondition(controls.session)],
        payload: { case: "setSessionModel", value: create(SetSessionModelMutationSchema, {
          sessionId: controls.session.sessionId,
          model: create(ModelSelectionSchema, {
            model: create(ModelKeySchema, { providerId: selected.providerId, modelId: selected.modelId }),
            effortId: selected.effortId ?? "",
            ...encodeModelSpeed(selected.fastMode)
          })
        }) }
      }), { kind: "session-model", sessionId: controls.session.sessionId });
      return result.accepted && result.definitive;
    } finally { this.#releaseMutation(action); }
  }

  newModelFavoriteId(): string {
    return `favorite-${this.newId()}`;
  }

  async mutateTaskModelFavorite(
    surfaceOwnerKey: string,
    expectedRevision: bigint,
    change: MobileModelFavoriteMutation
  ): Promise<boolean> {
    this.#ready();
    const controls = this.taskRuntimeControls();
    if (!controls || controls.surfaceOwnerKey !== surfaceOwnerKey) {
      throw new Error("The task controls changed. Reopen them from the current task.");
    }
    if (controls.favoriteRevision !== expectedRevision) {
      throw new Error("Model favorites changed on another client. Refresh before saving again.");
    }
    if (this.#state.pending.some((item) => item.kind === "model-favorite")) {
      throw new Error("A previous model favorite change is still pending. Check its operation before saving again.");
    }
    const normalized = assertMobileModelFavoriteMutation(controls, change);
    const mapped = normalized.kind === "remove"
      ? { case: "removeFavoriteId" as const, value: normalized.favoriteId }
      : {
          case: normalized.kind,
          value: create(ModelFavoriteConfigurationSchema, {
            favoriteId: normalized.item.favoriteId,
            backendId: normalized.item.backendId,
            selection: create(ModelSelectionSchema, {
              model: create(ModelKeySchema, {
                providerId: normalized.item.providerId,
                modelId: normalized.item.modelId
              }),
              effortId: normalized.item.effortId ?? "",
              ...encodeModelSpeed(normalized.item.fastMode)
            })
          })
        };
    const action = this.#claimMutation();
    try {
      const result = await this.#submitTerminal(create(OperationMutationSchema, {
        payload: { case: "updateModelFavorites", value: create(UpdateModelFavoritesMutationSchema, {
          expectedRevision: create(RevisionSchema, { value: expectedRevision }),
          change: mapped
        }) }
      }), { kind: "model-favorite" });
      return result.accepted && result.definitive;
    } finally { this.#releaseMutation(action); }
  }

  async setTaskPermission(authorityKey: string, mode: PermissionMode): Promise<boolean> {
    const controls = this.#runtimeControlContext(authorityKey);
    const selected = assertMobilePermissionMode(controls, mode);
    this.#assertNoPendingRuntimeControl(controls.session.sessionId);
    const action = this.#claimMutation();
    try {
      const result = await this.#submitTerminal(create(OperationMutationSchema, {
        preconditions: [this.#sessionRuntimePrecondition(controls.session)],
        payload: { case: "setSessionPermission", value: create(SetSessionPermissionMutationSchema, {
          sessionId: controls.session.sessionId,
          permissionMode: selected
        }) }
      }), { kind: "session-permission", sessionId: controls.session.sessionId });
      return result.accepted && result.definitive;
    } finally { this.#releaseMutation(action); }
  }

  async setTaskPlanMode(authorityKey: string, enabled: boolean): Promise<boolean> {
    const controls = this.#runtimeControlContext(authorityKey);
    const selected = assertMobilePlanMode(controls, enabled);
    this.#assertNoPendingRuntimeControl(controls.session.sessionId);
    const action = this.#claimMutation();
    try {
      const result = await this.#submitTerminal(create(OperationMutationSchema, {
        preconditions: [this.#sessionRuntimePrecondition(controls.session)],
        payload: { case: "setSessionPlanMode", value: create(SetSessionPlanModeMutationSchema, {
          sessionId: controls.session.sessionId,
          enabled: selected
        }) }
      }), { kind: "session-plan", sessionId: controls.session.sessionId });
      return result.accepted && result.definitive;
    } finally { this.#releaseMutation(action); }
  }

  taskContextControls(): MobileContextControls | undefined {
    if (this.#joinedTask) return resolveMobileSharedContextControls(this.#state.detail, this.#taskAuthorityKey());
    const credential = this.#credential;
    if (!credential || !this.#taskAuthorityKey()) return undefined;
    return resolveMobileContextControls({
      profileId: credential.profileId,
      connectionId: credential.connectionId,
      deviceId: credential.deviceId,
      serverId: credential.serverId
    }, this.#state.owner, this.#state.detail, this.#state.selectedId);
  }

  newTaskCollaborationOwnerKey(targetId: string): string | undefined {
    const key = this.#newTaskAuthorityKey(targetId);
    return key && this.network.collaborationRpc ? `${key}\u001fcollaboration-create\u001f${this.#epoch}` : undefined;
  }
  newTaskCollaborationScope(targetId: string, workerTargetId: string): string | undefined {
    const lead = this.#newTaskAuthorityKey(targetId), worker = this.#newTaskAuthorityKey(workerTargetId);
    return lead && worker ? JSON.stringify([lead, worker]) : undefined;
  }
  workerTargets() { return mobileWorkerTargets(this.#state.owner); }
  workerStorage(): MobileWorkerStorage | undefined { return this.newTaskDrafts ? new MobileWorkerStorage(this.newTaskDrafts.driver) : undefined; }

  taskCollaborationApi(): MobileCollaborationApi | undefined { return this.#collaborationApi(false); }
  #collaborationApi(ownedClaim: boolean): MobileCollaborationApi | undefined {
    const key = this.#collaborationOwnerKey(), factory = this.network.collaborationRpc;
    const session = this.#selectedSession(), credential = this.#credential;
    if (!key || !factory || !session || !credential) return undefined;
    const generation = session.nativeBinding!.runtimeGeneration, ownerSignal = this.#abort!.signal;
    const identity: MobileWorkerFormIdentity = { profileId: credential.profileId, connectionId: credential.connectionId,
      serverId: credential.serverId, sessionId: session.sessionId, generation: generation.toString() };
    const storage = this.workerStorage(), targets = this.workerTargets();
    const assert = (signal: AbortSignal): void => this.#assertCollaborationOwner(key, signal);
    const rpc = factory.call(this.network, credential, session.sessionId, generation, assert);
    const requestSignal = (signal: AbortSignal) => AbortSignal.any([signal, ownerSignal]);
    const load = async (signal: AbortSignal): Promise<MobileCollaborationView> => {
      assert(signal); const access = await rpc.list(signal);
      const selected = access.find(value => value.role === CollaborationSessionRole.WORKER)
        ?? access.filter(value => value.goal!.status === CollaborationGoalStatus.ACTIVE).sort((a, b) =>
          Number(b.goal!.createdAt!.seconds - a.goal!.createdAt!.seconds))[0];
      const tree = selected ? await rpc.get(selected.goal!.goalId, signal) : undefined;
      const settings = await this.network.getCollaborationSettings?.(credential, signal); assert(signal);
      const self = selected?.role === CollaborationSessionRole.WORKER ? tree?.workers.find(value => value.workerId === selected.workerId && value.sessionId === session.sessionId) : undefined;
      if (selected?.role === CollaborationSessionRole.WORKER && !self) throw new Error("The worker membership could not be confirmed.");
      return { role: self ? "worker" : tree ? "lead" : "ordinary", ...(tree ? { tree } : {}), ...(self ? { self } : {}), ...(settings ? { settings } : {}) };
    };
    const validateForm = (input: MobileWorkerForm): MobileWorkerForm => {
      const form = normalizeMobileWorkerForm(input), target = this.workerTargets().find(value => value.id === form.targetId);
      if (!target || !target.permissionModes.includes(form.permissionMode)
        || form.model && !resolveMobileExplicitNewTaskModelAuthority(this.#state.owner, target.backendId, form.model)) {
        throw new Error("The worker project, model or permissions changed. Review the retained form.");
      }
      return form;
    };
    const write = async <T>(signal: AbortSignal, effect: (fresh: MobileCollaborationView, request: AbortSignal) => Promise<T>): Promise<T> => {
      const request = requestSignal(signal); assert(request);
      if (session.archived || session.state === SessionState.CLOSING || this.#state.pending.some(value => value.sessionId === session.sessionId && value.kind.startsWith("collaboration-"))) {
        throw new Error("Check the current collaboration operation before changing this task.");
      }
      if (await this.partnerConversationTransport()?.resolve(request)) throw new Error("Partner tasks have their own collaboration controls.");
      assert(request); const action = ownedClaim ? undefined : this.#claimMutation();
      try { const fresh = await load(request); assert(request); return await effect(fresh, request); }
      finally { if (action !== undefined) this.#releaseMutation(action); }
    };
    const sameGoal = (shown: MobileCollaborationView, fresh: MobileCollaborationView): void => {
      if (!shown.tree?.goal || !fresh.tree?.goal || shown.tree.goal.goalId !== fresh.tree.goal.goalId
        || shown.tree.goal.revision?.value !== fresh.tree.goal.revision?.value || shown.role !== fresh.role) throw new Error("The team changed. Refresh its current state.");
    };
    const lead = (view: MobileCollaborationView): void => {
      if (view.role !== "lead" || view.tree?.goal?.leadSessionId !== session.sessionId || view.tree.goal.status !== CollaborationGoalStatus.ACTIVE
        || [SessionState.CLOSED, SessionState.ARCHIVED].includes(session.state)) throw new Error("Only the active lead task can control this team.");
    };
    const saveForm = async (form: MobileWorkerForm, signal: AbortSignal): Promise<void> => {
      await storage?.save(identity, form); assert(signal);
      const target = targets.find(value => value.id === form.targetId)!;
      await storage?.remember(credential.profileId, target, form); assert(signal);
    };
    const createWorker = async (tree: CollaborationGoalTree, form: MobileWorkerForm, signal: AbortSignal, settings?: CollaborationSettings): Promise<MobileCollaborationView> => {
      const label = mobileWorkerLabel(form.role, tree.workers), backendId = targets.find(value => value.id === form.targetId)!.backendId;
      const result = await this.#recordCollaborationEffect("collaboration-create", key, signal,
        async (id, request) => {
          const value = await rpc.createWorker(tree.goal!, form, label, id, request), worker = value.workers.find(candidate => candidate.label === label);
          if (!worker || worker.route?.backendId !== backendId || worker.route.targetId !== form.targetId) throw new Error("The created worker belongs to another backend or project.");
          if (worker.status === CollaborationWorkerStatus.FAILED) throw new Error(worker.error?.message || "The worker could not start. Review its current state before retrying.");
          return value;
        });
      await storage?.clear(identity); assert(signal);
      return { role: "lead", tree: result, ...(settings ? { settings } : {}) };
    };
    return { ownerKey: key, sessionId: session.sessionId, generation, profileId: credential.profileId, targets,
      initialTargetId: session.targetId, writable: !session.archived && session.state !== SessionState.CLOSING,
      restore: async signal => { const request = requestSignal(signal); assert(request); const value = await storage?.read(identity); assert(request); return value; },
      load: signal => load(requestSignal(signal)),
      enable: (input, signal) => write(signal, async (fresh, request) => {
        if (fresh.role !== "ordinary") throw new Error("This task already belongs to a team. Refresh its current state.");
        if ([SessionState.CLOSED, SessionState.ARCHIVED].includes(session.state)) throw new Error("Reopen this task before enabling collaboration.");
        const form = validateForm(input); await saveForm(form, request);
        const tree = await this.#recordCollaborationEffect("collaboration-enable", key, request, (id, current) => rpc.createGoal(id,
          session.displayName || "Task collaboration", "Coordinate the lead task and its workers.", current));
        return createWorker(tree, form, request, fresh.settings);
      }),
      create: (shown, input, signal) => write(signal, async (fresh, request) => {
        sameGoal(shown, fresh); lead(fresh); const form = validateForm(input); await saveForm(form, request);
        return createWorker(fresh.tree!, form, request, fresh.settings);
      }),
      archive: (shown, worker, signal) => write(signal, async (fresh, request) => {
        sameGoal(shown, fresh); const exact = fresh.tree!.workers.find(value => value.workerId === worker.workerId);
        if (!exact || exact.revision?.value !== worker.revision?.value || exact.status === CollaborationWorkerStatus.ARCHIVED
          || fresh.role === "worker" && (fresh.self?.workerId !== exact.workerId || exact.sessionId !== session.sessionId)) throw new Error("Only the selected current worker can be archived.");
        if (fresh.role !== "worker") lead(fresh);
        const tree = await this.#recordCollaborationEffect("collaboration-archive", key, request, (id, current) => rpc.archive(fresh.tree!.goal!, exact, id, current));
        return { ...fresh, tree, ...(fresh.self ? { self: tree.workers.find(value => value.workerId === fresh.self!.workerId)! } : {}) };
      }),
      end: (shown, signal) => write(signal, async (fresh, request) => {
        sameGoal(shown, fresh); lead(fresh);
        const tree = await this.#recordCollaborationEffect("collaboration-end", key, request, (id, current) => rpc.end(fresh.tree!.goal!, id, current));
        return { role: "ordinary", tree };
      }),
      openWorker: (shown, worker, signal) => write(signal, async (fresh, request) => {
        sameGoal(shown, fresh); lead(fresh);
        let exact = fresh.tree!.workers.find(value => value.workerId === worker.workerId);
        if (!exact?.sessionId || exact.status === CollaborationWorkerStatus.ARCHIVED || exact.revision?.value !== worker.revision?.value) throw new Error("The selected worker changed. Refresh this team.");
        if (exact.status === CollaborationWorkerStatus.COMPLETED && !exact.runtimeReleased) {
          const tree = await this.#recordCollaborationEffect("collaboration-release", key, request, (id, current) => rpc.release(fresh.tree!.goal!, exact!, id, current));
          exact = tree.workers.find(value => value.workerId === worker.workerId)!;
        }
        assert(request); await this.select(exact.sessionId);
      }),
      openLead: async (shown, signal) => {
        const request = requestSignal(signal), fresh = await load(request); sameGoal(shown, fresh);
        if (fresh.role !== "worker" || !fresh.self || fresh.self.sessionId !== session.sessionId) throw new Error("The original lead could not be confirmed.");
        assert(request); await this.select(fresh.tree!.goal!.leadSessionId);
      },
      resolveReport: async (origin, signal) => {
        const request = requestSignal(signal); assert(request);
        if (origin.leadSessionId !== session.sessionId || origin.workerSessionId === session.sessionId) throw new Error("The report belongs to another lead task.");
        const tree = await rpc.get(origin.goalId, request); assert(request);
        const worker = tree.workers.find(value => value.workerId === origin.workerId);
        if (tree.goal?.leadSessionId !== session.sessionId || worker?.sessionId !== origin.workerSessionId) {
          throw new Error("The original reporting worker could not be confirmed.");
        }
        return worker.sessionId;
      } };
  }
  #collaborationOwnerKey(): string | undefined {
    const key = this.#objectiveOwnerKey(); return key ? `${key}\u001fcollaboration` : undefined;
  }
  #assertCollaborationOwner(key: string, signal: AbortSignal): void {
    signal.throwIfAborted();
    if (this.#collaborationOwnerKey() !== key) throw new Error("The collaboration task or connection changed.");
  }
  async #recordCollaborationEffect<T>(kind: Extract<PendingOperation["kind"], `collaboration-${string}`>, key: string,
    signal: AbortSignal, effect: (id: string, signal: AbortSignal) => Promise<T>): Promise<T> {
    this.#assertCollaborationOwner(key, signal);
    const epoch = this.#epoch, credential = this.#ready(), requestId = this.newId(), before = this.#state.pending;
    const pending: PendingOperation = { kind, sessionId: this.#state.selectedId!, sourceGeneration: this.#selectedSession()!.nativeBinding!.runtimeGeneration.toString(),
      operationId: requestId, connectionId: credential.connectionId, state: "unknown" };
    const next = [...before, pending]; this.#set({ pending: next });
    try { if (!await this.#persistPending(next, epoch)) throw new Error("The collaboration connection changed while its receipt was saved."); }
    catch (error) { if (this.#current(epoch)) this.#set({ pending: before }); throw error; }
    let dispatched = false;
    try {
      this.#assertCollaborationOwner(key, signal); dispatched = true;
      const result = await effect(requestId, signal); this.#assertCollaborationOwner(key, signal);
      const rest = this.#state.pending.filter(value => value.operationId !== requestId);
      if (await this.#persistPending(rest, epoch)) this.#set({ pending: rest }); return result;
    } catch (error) {
      if (!dispatched && this.#current(epoch)) {
        const rest = this.#state.pending.filter(value => value.operationId !== requestId);
        if (await this.#persistPending(rest, epoch)) this.#set({ pending: rest });
      }
      throw error;
    }
  }

  taskObjectiveApi(): MobileObjectiveApi | undefined {
    const key = this.#objectiveOwnerKey(), factory = this.network.objectiveRpc;
    const session = this.#selectedSession(), credential = this.#credential;
    if (!key || !factory || !session || !credential) return undefined;
    const generation = session.nativeBinding!.runtimeGeneration;
    const ownerSignal = this.#abort!.signal;
    const identity: MobileObjectiveRecoveryIdentity = { profileId: credential.profileId, serverId: credential.serverId,
      connectionId: credential.connectionId, sessionId: session.sessionId, generation: generation.toString() };
    const recovery = this.newTaskDrafts ? new MobileObjectiveRecovery(this.newTaskDrafts.driver) : undefined;
    const rpc = factory.call(this.network, credential, session.sessionId, generation, signal => this.#assertObjectiveOwner(key, signal));
    const write = async <T>(kind: Extract<PendingOperation["kind"], `objective-${string}`>, signal: AbortSignal,
      effect: (id: string, request: AbortSignal) => Promise<T>, prepare?: (request: AbortSignal) => Promise<void>): Promise<T> => {
      const request = AbortSignal.any([signal, ownerSignal]);
      await this.#assertObjectiveWritable(key, request);
      const action = this.#claimMutation(), requestId = this.newId();
      try {
        await prepare?.(request); this.#assertObjectiveOwner(key, request);
        return await this.#recordObjectiveEffect(kind, session.sessionId, requestId, key, request, current => effect(requestId, current));
      }
      finally { this.#releaseMutation(action); }
    };
    return { ownerKey: key, sessionId: session.sessionId, generation,
      writable: !session.archived && ![SessionState.CLOSED, SessionState.ARCHIVED, SessionState.CLOSING].includes(session.state),
      get: signal => rpc.get(AbortSignal.any([signal, ownerSignal])),
      watch: signal => rpc.watch(AbortSignal.any([signal, ownerSignal])),
      restore: async signal => {
        this.#assertObjectiveOwner(key, signal); const input = await recovery?.read(identity);
        this.#assertObjectiveOwner(key, signal); return input;
      },
      set: async (input, signal) => {
        const exact = normalizeMobileObjectiveInput(input);
        const value = await write("objective-set", signal, (id, request) => rpc.set(exact, id, request), async request => {
          if (await rpc.get(request)) throw new Error("This task already has an objective. Refresh its current state.");
          await recovery?.save(identity, exact); this.#assertObjectiveOwner(key, request);
        });
        await recovery?.clear(identity); return value;
      },
      pause: (value, signal) => write("objective-pause", signal, (id, request) => rpc.pause(value, id, request)),
      resume: (value, signal) => write("objective-resume", signal, (id, request) => rpc.resume(value, id, request)),
      clear: (value, signal) => write("objective-clear", signal, (id, request) => rpc.clear(value, id, request)) };
  }

  #objectiveOwnerKey(): string | undefined {
    const key = this.taskPresentationOwnerKey(), session = this.#selectedSession(), backend = this.#selectedBackend(session);
    if (!key || !session || !backend || !supportsText(backend)
      || this.#state.detail?.reviewRuns.some(value => value.reviewerSessionId === session.sessionId)) return undefined;
    return `${key}\u001fobjective\u001f${backendAuthorityKey(backend)}\u001f${this.#epoch}`;
  }
  #assertObjectiveOwner(key: string, signal: AbortSignal): void {
    signal.throwIfAborted();
    if (this.#objectiveOwnerKey() !== key) throw new Error("The objective task or connection changed.");
  }
  async #assertObjectiveWritable(key: string, signal: AbortSignal): Promise<void> {
    this.#assertObjectiveOwner(key, signal);
    const session = this.#selectedSession()!;
    if (session.archived || [SessionState.CLOSED, SessionState.ARCHIVED, SessionState.CLOSING].includes(session.state)
      || this.#state.pending.some(value => value.sessionId === session.sessionId && value.kind.startsWith("objective-"))) {
      throw new Error("Check the current objective operation before changing this task.");
    }
    if (await this.readTaskHeaderRole(this.taskHeaderSourceKey()!, signal) === "worker") throw new Error("Worker tasks cannot own an autonomous objective.");
    if (await this.partnerConversationTransport()?.resolve(signal)) throw new Error("Partner tasks use their own objective controls.");
    this.#assertObjectiveOwner(key, signal);
  }
  async #recordObjectiveEffect<T>(kind: Extract<PendingOperation["kind"], `objective-${string}`>, sessionId: string,
    requestId: string, ownerKey: string, signal: AbortSignal, effect: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.#assertObjectiveOwner(ownerKey, signal);
    const epoch = this.#epoch, credential = this.#ready(), before = this.#state.pending;
    const pending: PendingOperation = { kind, sessionId, sourceGeneration: this.#selectedSession()!.nativeBinding!.runtimeGeneration.toString(),
      operationId: requestId, connectionId: credential.connectionId, state: "unknown" };
    const next = [...before, pending]; this.#set({ pending: next });
    try { if (!await this.#persistPending(next, epoch)) throw new Error("The objective connection changed while its receipt was saved."); }
    catch (error) { if (this.#current(epoch)) this.#set({ pending: before }); throw error; }
    let dispatched = false;
    try {
      this.#assertObjectiveOwner(ownerKey, signal); dispatched = true;
      const result = await effect(signal); this.#assertObjectiveOwner(ownerKey, signal);
      const rest = this.#state.pending.filter(value => value.operationId !== requestId);
      if (await this.#persistPending(rest, epoch)) this.#set({ pending: rest });
      return result;
    } catch (error) {
      if (!dispatched && this.#current(epoch)) {
        const rest = this.#state.pending.filter(value => value.operationId !== requestId);
        if (await this.#persistPending(rest, epoch)) this.#set({ pending: rest });
      }
      throw error;
    }
  }

  async compactTaskContext(authorityKey: string): Promise<MobileCompactOutcome | undefined> {
    const controls = this.#contextControlContext(authorityKey);
    const session = assertMobileContextCompact(controls);
    this.#assertNoPendingRuntimeControl(session.sessionId);
    const action = this.#claimMutation();
    try {
      const result = await this.#submitTerminal(create(OperationMutationSchema, {
        preconditions: [this.#sessionRuntimePrecondition(session)],
        payload: { case: "compactSession", value: create(CompactSessionMutationSchema, {
          sessionId: session.sessionId,
          customInstructions: ""
        }) }
      }), { kind: "session-compact", sessionId: session.sessionId });
      if (!result.definitive) return undefined;
      if (!result.accepted) {
        throw new Error(result.operation?.error?.message || "Context compaction was rejected by the Joko node.");
      }
      const payload = result.operation?.result?.payload;
      if (result.operation?.state !== OperationState.SUCCEEDED || payload?.case !== "compactSession") {
        throw new Error("The Joko node completed context compaction without a typed outcome.");
      }
      if (payload.value.outcome === CompactSessionOutcome.COMPACTED) return "compacted";
      if (payload.value.outcome === CompactSessionOutcome.NOOP) return "noop";
      throw new Error("The Joko node returned an unknown context compaction outcome.");
    } finally { this.#releaseMutation(action); }
  }

  taskCloneControls(): MobileTaskCloneControls | undefined {
    const context = this.#taskDerivationContext(capabilityNames.sessionClone);
    return context ? { ...context.controls, canClone: context.canDerive } : undefined;
  }

  taskMessageRewindControls(eventId: string): MobileMessageRewindControls | undefined {
    const context = this.#taskDerivationContext(capabilityNames.sessionRewind);
    if (!context) return undefined;
    const { session, backend } = context.runtime;
    const detail = this.#state.detail!; const owner = this.#state.owner!;
    const target = owner.targets.find((value) => value.targetId === session.targetId)!;
    const events = this.#state.window ?? [...this.#state.older, ...detail.timeline, ...this.#state.live];
    const source = resolveMobileMessageRewindSource(events, session.sessionId, eventId, owner.generation,
      mobileRewindToStartSupported(backend, target));
    if (!source || !timelineRows(events).some((row) => row.id === source.messageId && row.eventId === eventId && row.completed && row.kind === "user")) return undefined;
    const workspaceId = session.localWorkspace?.workspaceId || session.worktree?.workspaceId || target.workspaceId;
    const workspaces = owner.workspaces.filter((value) => value.workspaceId === workspaceId && value.targetId === session.targetId);
    const detailWorkspaces = detail.workspaces.filter((value) => value.workspaceId === workspaceId && value.targetId === session.targetId);
    const workspace = workspaceId && workspaces.length === 1 && detailWorkspaces.length === 1
      && (workspaces[0]!.version?.revision?.value ?? 0n) > 0n && (workspaces[0]!.version?.generation ?? 0n) > 0n
      && entityVersionKey(workspaces[0]!.version) === entityVersionKey(detailWorkspaces[0]!.version) ? workspaces[0] : undefined;
    const idle = mobileMessageRewindIdle(session, detail)
      && !this.#state.pending.some((value) => value.sessionId === session.sessionId
        && (value.kind.startsWith("session-") || value.kind === "workspace-rewind"));
    const canDialogue = idle && source.target !== undefined && mobileRewindCapability(backend, capabilityNames.sessionRewind);
    const canFiles = idle && workspace !== undefined && source.runId !== undefined && mobileRewindCapability(backend, "workspace.rewind");
    return { authorityKey: JSON.stringify([context.controls.authorityKey, source.sourceKey, workspace?.workspaceId ?? "",
      entityVersionKey(workspace?.version), workspace?.serverPathDisplay ?? "", workspace?.location?.kind ?? null]),
      surfaceOwnerKey: context.controls.surfaceOwnerKey, sessionId: session.sessionId, source,
      ...(workspace ? { workspace } : {}), canDialogue, canFiles, canRewind: canDialogue || canFiles };
  }

  async loadTaskMessageRewindPreview(authorityKey: string, eventId: string, signal: AbortSignal): Promise<MobileMessageRewindPreview | undefined> {
    const controls = this.taskMessageRewindControls(eventId);
    if (!controls?.canRewind || controls.authorityKey !== authorityKey || signal.aborted) return undefined;
    const credential = this.#ready(); const epoch = this.#epoch;
    const current = (): boolean => !signal.aborted && this.#current(epoch)
      && this.taskMessageRewindControls(eventId)?.authorityKey === authorityKey;
    const operationSignal = this.#abort ? AbortSignal.any([signal, this.#abort.signal]) : signal;
    let preview: MobileMessageRewindPreview = { controls };
    if (controls.canFiles && controls.workspace && controls.source.runId) {
      try {
        const sets = await this.network.listWorkspaceChangeSets(credential, controls.workspace.workspaceId, controls.sessionId, operationSignal);
        if (!current()) return undefined;
        const changeSet = mobileMessageChangeSet(sets, controls.workspace.workspaceId, controls.sessionId, controls.source.runId);
        if (changeSet) {
          const files = await this.network.previewWorkspaceRewind(credential, controls.workspace.workspaceId, changeSet.changeSetId, operationSignal);
          if (!current()) return undefined;
          assertMobileWorkspaceRewindPreview(files, controls.workspace.workspaceId, changeSet.changeSetId);
          preview = { controls, files };
        }
      } catch {
        if (!current()) return undefined;
        preview = { controls, fileError: true };
      }
    }
    if (!current()) return undefined;
    this.#messageRewindPreviews.add(preview);
    return preview;
  }

  async commitTaskMessageRewind(preview: MobileMessageRewindPreview, mode: "dialogue" | "files", signal: AbortSignal): Promise<MobileMessageRewindResult> {
    const original = preview.controls; const eventId = original.source.eventId;
    const controls = this.taskMessageRewindControls(eventId);
    if (signal.aborted || !this.#messageRewindPreviews.has(preview) || controls?.authorityKey !== original.authorityKey
      || (mode === "dialogue" ? !controls.canDialogue : !controls.canFiles)) throw new Error("The message rewind preview changed. Open it again from the current message.");
    const files = preview.files;
    const fileCurrent = (): boolean => files !== undefined && files.safety !== RewindSafety.BLOCKED
      && mobileWorkspaceRewindExpiresAt(files) > this.now();
    if (mode === "files" && !fileCurrent()) throw new Error("The Workspace rewind preview is blocked or expired. Open a new preview.");
    const credential = this.#ready(); const epoch = this.#epoch; const profileId = this.#activeProfileId!;
    const session = this.#selectedSession()!; const operationId = this.newId(); const identity = { profileId, sessionId: session.sessionId };
    const current = (): boolean => !signal.aborted && this.#current(epoch) && this.#foreground && this.#credential === credential
      && this.#state.status === "connected" && this.#state.selectedId === session.sessionId
      && this.#selectedSession()?.backendId === session.backendId && this.#selectedSession()?.targetId === session.targetId;
    const dispatchCurrent = (): boolean => current() && this.taskMessageRewindControls(eventId)?.authorityKey === original.authorityKey
      && mobileMessageRewindIdle(this.#selectedSession()!, this.#state.detail!) && (mode !== "files" || fileCurrent());
    this.#assertNoPendingRuntimeControl(session.sessionId);
    const action = this.#claimMutation(); let retained = false;
    try {
      if (mode === "dialogue") {
        if (!this.composerDrafts) throw new Error("Retained task drafts are unavailable on this mobile client.");
        await this.composerDrafts.flush(identity);
        if (!dispatchCurrent()) return { kind: "retired" };
        await this.composerDrafts.retainOperationInput(identity, operationId, original.source.draft);
        retained = true;
        if (!dispatchCurrent()) { await this.composerDrafts.clearOperationInput(identity, operationId); return { kind: "retired" }; }
      }
      const mutation = create(OperationMutationSchema, {
        preconditions: [this.#sessionRuntimePrecondition(session)],
        payload: mode === "dialogue" ? { case: "navigateSessionBranch", value: create(NavigateSessionBranchMutationSchema, {
          sessionId: session.sessionId, target: original.source.target!, summarize: false, customInstructions: ""
        }) } : { case: "executeWorkspaceRewind", value: create(ExecuteWorkspaceRewindMutationSchema, {
          workspaceId: controls.workspace!.workspaceId, previewId: files!.previewId, changeSetId: files!.changeSetId,
          confirmFileRestore: true, allowDialogueOnly: false
        }) }
      });
      const receipt = { kind: mode === "dialogue" ? "session-rewind" as const : "workspace-rewind" as const,
        sessionId: session.sessionId, eventId, backendId: session.backendId, targetId: session.targetId,
        sourceGeneration: session.nativeBinding!.runtimeGeneration.toString(),
        ...(mode === "files" ? { workspaceId: controls.workspace!.workspaceId, changeSetId: files!.changeSetId } : {}) };
      const result = await this.#submitTerminal(mutation, receipt, operationId, true, false, {
        signal, isCurrent: current, beforeDispatch: dispatchCurrent,
        beforeTerminalReceipt: async (operation) => {
          if (operation.state !== OperationState.SUCCEEDED) return;
          await this.#recoverMessageRewindReceipt({ ...receipt, operationId, connectionId: credential.connectionId, state: "unknown" }, operation, epoch, current);
        }
      });
      if (!current()) return { kind: "retired" };
      if (!result.definitive) return { kind: "unknown" };
      let cleanupError: string | undefined;
      if (retained) {
        try { await this.composerDrafts!.clearOperationInput(identity, operationId); }
        catch (error) { cleanupError = message(error); }
      }
      if (!result.accepted) return { kind: "rejected" };
      this.#messageRewindPreviews.delete(preview);
      this.#clearHistory(); await this.refresh();
      if (cleanupError && this.#foreground && this.#activeProfileId === profileId) this.#set({ error: cleanupError });
      return this.#foreground && this.#activeProfileId === profileId && this.#state.selectedId === session.sessionId
        ? { kind: "rewound", mode } : { kind: "retired" };
    } catch (error) {
      if (current() && this.#state.pending.some((value) => value.operationId === operationId)) {
        this.#set({ busy: false, error: `Operation ${operationId}: ${message(error)}. Check its saved result; it was not resent.` });
        return { kind: "unknown" };
      }
      if (!current()) return { kind: "retired" };
      throw error;
    } finally { this.#releaseMutation(action); }
  }

  #assertMessageRewindResult(operation: Operation, pending: Pick<PendingOperation, "kind" | "workspaceId" | "changeSetId">): void {
    const payload = operation.result?.payload;
    if (pending.kind === "session-rewind") {
      if (payload?.case === "acknowledgement" && payload.value.accepted === true) return;
    } else if (pending.kind === "workspace-rewind" && payload?.case === "workspaceRewind"
      && payload.value.workspaceId === pending.workspaceId && payload.value.changeSetId === pending.changeSetId
      && payload.value.filesRewound && !payload.value.dialogueRewound) return;
    throw new Error("The Joko node completed rewind without the exact typed outcome. Its operation was not resent.");
  }

  async #recoverMessageRewindReceipt(pending: PendingOperation, operation: Operation, epoch: number, isCurrent?: () => boolean): Promise<void> {
    this.#assertMessageRewindResult(operation, pending);
    if (pending.kind !== "session-rewind") return;
    const credential = this.#ready(); const profileId = this.#activeProfileId!;
    const current = (): boolean => this.#current(epoch) && this.#foreground && this.#credential === credential && this.#activeProfileId === profileId
      && (isCurrent?.() ?? true);
    const owner = await this.network.readOwner(credential, this.deviceNameSource(), this.#abort?.signal);
    if (!current()) return;
    this.#assertOwner(credential, owner, this.#state.node!);
    const sessions = owner.snapshot.sessions.filter((value) => value.sessionId === pending.sessionId);
    const session = sessions[0];
    if (sessions.length !== 1 || !session || session.backendId !== pending.backendId || session.targetId !== pending.targetId
      || session.nativeBinding?.backendId !== pending.backendId || !session.nativeBinding.opaqueReference
      || !mobileSessionOriginSourceAvailable(session) || !pending.sourceGeneration
      || (session.nativeBinding?.runtimeGeneration ?? 0n) <= BigInt(pending.sourceGeneration) || !this.composerDrafts) {
      throw new Error("The saved conversation rewind no longer has its exact task authority. Its operation was not resent.");
    }
    const draft = await this.composerDrafts.readOperationInput({ profileId, sessionId: session.sessionId }, pending.operationId);
    if (!current()) return;
    if (!draft || !await this.#restoreForkDraft(draft, profileId, session.sessionId, current)) {
      throw new Error("The conversation was rewound, but its retained input could not be restored safely. The newer draft was kept.");
    }
    if (current()) this.#notifyRewindDraftRestored(profileId, session.sessionId);
  }

  #notifyRewindDraftRestored(profileId: string, sessionId: string): void {
    this.#set({ restoredComposerDraft: { profileId, sessionId, sequence: (this.#state.restoredComposerDraft?.sequence ?? 0) + 1 } });
  }

  taskDerivationOriginControls(): MobileSessionOriginControls | undefined {
    if (this.#joinedTask) return undefined;
    const session = this.#selectedSession();
    if (!session) return undefined;
    const projected = projectMobileSessionOrigin(session, this.#state.owner?.sessions ?? []);
    if (!projected) return undefined;
    const ownerKey = this.taskPresentationOwnerKey();
    const ownerSession = this.#state.owner?.sessions.find((candidate) => candidate.sessionId === session.sessionId);
    const source = this.#state.owner?.sessions.find((candidate) => candidate.sessionId === projected.source?.sessionId);
    const ownerOrigin = ownerSession ? projectMobileSessionOrigin(ownerSession, this.#state.owner!.sessions) : undefined;
    const owner = this.#state.owner; const detail = this.#state.detail;
    const canOpen = projected.canOpen && ownerOrigin?.canOpen === true && ownerOrigin.originKey === projected.originKey
      && owner?.scope?.kind.case === "owner" && owner.generation > 0n && (owner.revision?.value ?? 0n) > 0n
      && detail?.scope?.kind.case === "session" && detail.scope.kind.value.sessionId === session.sessionId
      && (detail.revision?.value ?? 0n) > 0n
      && ownerKey !== undefined && mobileSessionOriginSessionKey(ownerSession) === mobileSessionOriginSessionKey(session)
      && Boolean(source?.backendId && source.targetId && source.nativeBinding?.runtimeGeneration && source.nativeBinding.runtimeGeneration > 0n);
    return { ...projected, canOpen, ...(canOpen ? { authorityKey: JSON.stringify([
      ownerKey, mobileSessionOriginSessionKey(session), projected.originKey, mobileSessionOriginSessionKey(source)
    ]) } : {}) };
  }

  /** Revalidates lineage through authenticated APIs before offering the existing native navigation controller a URL. */
  async prepareTaskDerivationOrigin(authorityKey: string, signal?: AbortSignal): Promise<string | undefined> {
    const controls = this.taskDerivationOriginControls();
    if (signal?.aborted || !controls?.canOpen || controls.authorityKey !== authorityKey || !controls.source) return undefined;
    const credential = this.#ready(); const epoch = this.#epoch;
    const session = this.#selectedSession()!; const generation = this.#state.owner!.generation;
    const source = this.#state.owner!.sessions.find((candidate) => candidate.sessionId === controls.source!.sessionId)!;
    const current = (): boolean => !signal?.aborted && this.#current(epoch) && this.#foreground && this.#credential === credential
      && this.taskDerivationOriginControls()?.authorityKey === authorityKey;
    const operationSignal = signal === undefined ? this.#abort?.signal
      : this.#abort === undefined ? signal : AbortSignal.any([this.#abort.signal, signal]);
    const sourceMatches = (value: Session | undefined): value is Session => value !== undefined
      && mobileSessionOriginSourceAvailable(value) && mobileSessionOriginSessionKey(value) === mobileSessionOriginSessionKey(source);
    const validOwner = (owner: Awaited<ReturnType<MobileNetwork["readOwner"]>>): boolean => {
      this.#assertOwner(credential, owner, this.#state.node!);
      const snapshot = owner.snapshot;
      const children = snapshot.sessions.filter((candidate) => candidate.sessionId === session.sessionId);
      const sources = snapshot.sessions.filter((candidate) => candidate.sessionId === source.sessionId);
      if (snapshot.scope?.kind.case !== "owner" || snapshot.generation !== generation || !snapshot.snapshotId
        || !snapshot.revision || snapshot.revision.value < 1n || children.length !== 1 || sources.length !== 1
        || mobileSessionOriginSessionKey(children[0]) !== mobileSessionOriginSessionKey(session) || !sourceMatches(sources[0])) return false;
      const origin = projectMobileSessionOrigin(children[0]!, snapshot.sessions);
      return origin?.canOpen === true && origin.originKey === controls.originKey;
    };
    const detailSession = (detail: Snapshot, id: string): Session | undefined => {
      const matches = detail.sessions.filter((candidate) => candidate.sessionId === id);
      return detail.server?.serverId === credential.serverId && detail.server.apiVersion === this.#state.node?.apiVersion && detail.generation === generation
        && detail.scope?.kind.case === "session" && detail.scope.kind.value.sessionId === id
        && detail.snapshotId && detail.revision && detail.revision.value > 0n && matches.length === 1 ? matches[0] : undefined;
    };
    try {
      const [owner, detail] = await Promise.all([
        this.network.readOwner(credential, this.deviceNameSource(), operationSignal), this.network.readSession(credential, session.sessionId, operationSignal)
      ]);
      if (!current() || !validOwner(owner)) return undefined;
      const child = detailSession(detail, session.sessionId);
      if (!child || mobileSessionOriginSessionKey(child) !== mobileSessionOriginSessionKey(session)) return undefined;
      const origin = projectMobileSessionOrigin(child, owner.snapshot.sessions);
      if (!origin?.canOpen || origin.originKey !== controls.originKey) return undefined;
      const target = controls.source;
      const [sourceDetail, events] = await Promise.all([
        this.network.readSession(credential, source.sessionId, operationSignal),
        target.eventId ? this.network.readAround(credential, source.sessionId, target.eventId, operationSignal) : Promise.resolve(undefined)
      ]);
      if (!current() || !sourceMatches(detailSession(sourceDetail, source.sessionId))) return undefined;
      let focusEventId = target.eventId;
      if (events !== undefined) {
        validateHistory(events, source.sessionId, generation);
        const matches = events.filter((event) => event.eventId === target.eventId);
        if (matches.length !== 1) return undefined;
        const payload = matches[0]!.payload?.kind;
        if ((payload?.case !== "messageCompleted" && payload?.case !== "messageStarted")
          || payload.value.messageId !== target.messageId
          || (payload.value.role !== MessageRole.USER && payload.value.role !== MessageRole.ASSISTANT)
          || payload.case === "messageStarted" && (payload.value.role !== MessageRole.USER || !payload.value.userInputAccepted)) return undefined;
        const completed = events.filter((event) => event.payload?.kind.case === "messageCompleted"
          && event.payload.kind.value.messageId === target.messageId);
        if (completed.length > 1) return undefined;
        if (payload.case === "messageStarted" && completed.length === 1) {
          const completion = completed[0]!; const message = completion.payload!.kind;
          if (message.case !== "messageCompleted" || message.value.role !== payload.value.role
            || (completion.cursor?.sequence ?? 0n) <= (matches[0]!.cursor?.sequence ?? 0n)
            || ["entryId", "parentEntryId"].some((key) => {
              const field = key as "entryId" | "parentEntryId";
              const before = payload.value.nativeIdentity?.[field]; const after = message.value.nativeIdentity?.[field];
              return before && after && before !== after;
            })) return undefined;
          // The durable origin still names the accepted input. Native focus uses its verified completed row.
          focusEventId = completion.eventId;
        }
      }
      // Availability may have been revoked while the source history was being read.
      const finalOwner = await this.network.readOwner(credential, this.deviceNameSource(), operationSignal);
      if (!current() || !validOwner(finalOwner)) return undefined;
      const url = new URL(target.messageId ? buildMobileMessageDeepLink(source.sessionId, target.messageId, focusEventId)
        : buildMobileTaskDeepLink(source.sessionId));
      url.searchParams.set("profile", credential.profileId);
      const value = url.toString(); const parsed = parseMobileNativeIntent(value);
      return current() && parsed?.kind === "session" && parsed.profileId === credential.profileId
        && parsed.sessionId === source.sessionId && parsed.messageId === target.messageId && parsed.messageEventId === focusEventId
        ? value : undefined;
    } catch (error) {
      if (!current() || operationSignal?.aborted) return undefined;
      throw error;
    }
  }

  #taskDerivationContext(capability: string) {
    const runtime = this.taskRuntimeControls();
    const target = this.#state.owner?.targets.find((candidate) => candidate.targetId === runtime?.session.targetId);
    if (!runtime || !target) return undefined;
    const supported = (name: string): boolean => {
      const matches = runtime.backend.capabilities?.capabilities.filter((capability) => capability.name === name) ?? [];
      return matches.length === 1 && matches[0]!.support === CapabilitySupport.SUPPORTED;
    };
    const canDerive = supported(capability)
      && (capability === capabilityNames.sessionSideChat || !runtime.session.worktree || supported("workspace.derive"))
      && !this.#state.detail?.reviewRuns.some((review) => review.reviewerSessionId === runtime.session.sessionId)
      && !this.#state.pending.some((pending) => pending.sessionId === runtime.session.sessionId
        && (pending.kind.startsWith("session-") || pending.kind === "workspace-rewind"));
    const controls = {
      authorityKey: runtime.authorityKey,
      surfaceOwnerKey: JSON.stringify([runtime.surfaceOwnerKey, this.#state.owner!.generation.toString(10),
        entityVersionKey(target.version), backendAuthorityKey(runtime.backend), runtime.session.nativeBinding?.opaqueReference,
        runtime.session.worktree?.leaseId ?? "", runtime.session.worktree?.workspaceId ?? "", runtime.session.worktree?.state ?? 0,
        runtime.session.localWorkspace?.workspaceId ?? "", runtime.session.localWorkspace?.path ?? ""]),
      sourceSessionId: runtime.session.sessionId, sourceName: runtime.session.displayName
    };
    return { controls, canDerive, runtime };
  }

  taskSideChatControls() {
    if (this.#joinedTask) return undefined;
    const context = this.#taskDerivationContext(capabilityNames.sessionSideChat);
    if (!context || context.runtime.session.sideChatSourceAllowed !== true || context.runtime.session.derivationOrigin?.sideChat) return undefined;
    return { ...context.controls, canOpen: context.canDerive && !context.runtime.session.archived,
      children: (this.#state.owner?.sessions ?? []).filter((child) => child.derivationOrigin?.sideChat
        && child.derivationOrigin.sourceSessionId === context.runtime.session.sessionId) };
  }

  async openSideChat(authorityKey: string, draft?: MobileComposerDraft): Promise<
    { readonly kind: "opened"; readonly sessionId: string } | { readonly kind: "unknown" | "retired" | "rejected" }
  > {
    const controls = this.taskSideChatControls(), session = this.taskRuntimeControls()?.session;
    if (!controls?.canOpen || controls.authorityKey !== authorityKey || !session) throw new Error("The side chat source changed.");
    const credential = this.#ready(), epoch = this.#epoch, operationId = this.newId();
    const identity = { profileId: credential.profileId, sessionId: session.sessionId };
    const current = (): boolean => this.#current(epoch) && this.#foreground && this.#credential === credential
      && this.taskSideChatControls()?.surfaceOwnerKey === controls.surfaceOwnerKey;
    this.#assertNoPendingRuntimeControl(session.sessionId);
    const action = this.#claimMutation();
    try {
      if (!this.composerDrafts) throw new Error("Retained task drafts are unavailable.");
      await this.composerDrafts.retainOperationInput(identity, operationId, draft ?? emptyMobileComposerDraft());
      if (!current()) { await this.composerDrafts.clearOperationInput(identity, operationId); return { kind: "retired" }; }
      const receipt = { kind: "session-side-chat" as const, sessionId: session.sessionId,
        backendId: session.backendId, targetId: session.targetId, sourceGeneration: session.nativeBinding!.runtimeGeneration.toString() };
      const result = await this.#submitTerminal(create(OperationMutationSchema, {
        preconditions: [create(OperationPreconditionSchema, { entity: { kind: EntityKind.SESSION, id: session.sessionId },
          expectedGeneration: session.nativeBinding!.runtimeGeneration })],
        payload: { case: "openSideChat", value: create(OpenSideChatMutationSchema, { sourceSessionId: session.sessionId }) }
      }), receipt, operationId, true, false, { signal: this.#abort!.signal, isCurrent: current,
        beforeTerminalReceipt: async (operation) => {
          if (operation.state === OperationState.SUCCEEDED) await this.#recoverSideChatReceipt({ ...receipt, operationId,
            connectionId: credential.connectionId, state: "unknown" }, operation, epoch);
        } });
      if (!current()) return { kind: "retired" };
      if (!result.definitive) return { kind: "unknown" };
      await this.composerDrafts.clearOperationInput(identity, operationId);
      if (!result.accepted) return { kind: "rejected" };
      const child = this.#derivedTaskResult(result.operation, session, SessionDerivationKind.FORK);
      if (!child.derivationOrigin?.sideChat) throw new Error("The result is not the original side chat.");
      return await this.#refreshDerivedTaskList(child, current) ? { kind: "opened", sessionId: child.sessionId } : { kind: "retired" };
    } finally { this.#releaseMutation(action); }
  }

  async #recoverSideChatReceipt(pending: PendingOperation, operation: Operation, epoch: number): Promise<void> {
    const credential = this.#ready(), profileId = credential.profileId;
    const source = this.#state.owner?.sessions.find((candidate) => candidate.sessionId === pending.sessionId);
    const payload = operation.mutation?.payload;
    if (!source || source.backendId !== pending.backendId || source.targetId !== pending.targetId
      || source.nativeBinding?.runtimeGeneration.toString() !== pending.sourceGeneration
      || payload?.case !== "openSideChat" || payload.value.sourceSessionId !== source.sessionId || !this.composerDrafts) {
      throw new Error("The retained side chat source is unavailable. Its operation was not resent.");
    }
    const child = this.#derivedTaskResult(operation, source, SessionDerivationKind.FORK);
    if (!child.derivationOrigin?.sideChat) throw new Error("The original side chat receipt is invalid.");
    const current = () => this.#current(epoch) && this.#credential === credential;
    const draft = await this.composerDrafts.readOperationInput({ profileId, sessionId: source.sessionId }, pending.operationId);
    if (!current()) return;
    if (!draft || !await this.#restoreForkDraft(draft, profileId, child.sessionId, current)) {
      throw new Error("The side chat was created, but its retained draft could not be restored. The newer draft was kept.");
    }
  }

  async cloneTask(authorityKey: string, name: string, signal?: AbortSignal): Promise<MobileTaskCloneResult> {
    signal?.throwIfAborted();
    const controls = this.taskCloneControls();
    const session = this.taskRuntimeControls()?.session;
    if (!controls?.canClone || !session || controls.authorityKey !== authorityKey) {
      throw new Error("The task clone owner changed. Reopen the confirmation from the current task.");
    }
    const displayName = name.trim();
    if (!displayName || displayName.length > 120 || /[\u0000-\u001f\u007f]/u.test(displayName)) {
      throw new Error("Use a task name between 1 and 120 characters.");
    }
    this.#assertNoPendingRuntimeControl(session.sessionId);
    const action = this.#claimMutation();
    const epoch = this.#epoch;
    const surfaceOwnerKey = controls.surfaceOwnerKey;
    const current = (): boolean => this.#current(epoch) && this.#foreground
      && this.#state.selectedId === session.sessionId
      && this.taskCloneControls()?.surfaceOwnerKey === surfaceOwnerKey;
    try {
      const result = await this.#submitTerminal(create(OperationMutationSchema, {
        preconditions: [this.#sessionRuntimePrecondition(session)],
        payload: { case: "cloneSession", value: create(CloneSessionMutationSchema, {
          sourceSessionId: session.sessionId, newDisplayName: displayName
        }) }
      }), { kind: "session-clone", sessionId: session.sessionId }, undefined, true, false,
      { signal: signal ?? new AbortController().signal, isCurrent: current });
      if (!current() || signal?.aborted) return { kind: "retired" };
      if (!result.definitive) return { kind: "unknown" };
      if (!result.accepted) return { kind: "rejected" };
      const child = this.#derivedTaskResult(result.operation, session, SessionDerivationKind.CLONE);
      return await this.#refreshDerivedTaskList(child, current, signal)
        ? { kind: "cloned", sessionId: child.sessionId } : { kind: "retired" };
    } finally { this.#releaseMutation(action); }
  }

  taskMessageForkControls(eventId: string): MobileMessageForkControls | undefined {
    const context = this.#taskDerivationContext(capabilityNames.sessionFork);
    if (!context) return undefined;
    const events = this.#timelineEvents();
    const active = [SessionState.CREATING, SessionState.RUNNING, SessionState.WAITING, SessionState.RECOVERING]
      .includes(context.runtime.session.state) || this.#state.detail?.runs.some((run) => run.sessionId === context.runtime.session.sessionId
        && [RunState.ACCEPTED, RunState.QUEUED, RunState.DISPATCHING, RunState.DISPATCH_UNKNOWN, RunState.RUNNING, RunState.WAITING, RunState.RETRYING].includes(run.state)) === true;
    const source = resolveMobileMessageForkSource(events, context.controls.sourceSessionId, eventId,
      this.#state.owner!.generation, active);
    if (!source || !timelineRows(events).some((row) => row.id === source.messageId && row.eventId === source.eventId && row.completed)) return undefined;
    return { ...context.controls, source, canFork: context.canDerive,
      authorityKey: JSON.stringify([context.controls.authorityKey, source.sourceKey]),
      surfaceOwnerKey: JSON.stringify([context.controls.surfaceOwnerKey, source.sourceKey]) };
  }

  async forkTaskMessage(authorityKey: string, eventId: string, name: string, signal?: AbortSignal): Promise<MobileMessageForkResult> {
    signal?.throwIfAborted();
    const controls = this.taskMessageForkControls(eventId);
    const session = this.taskRuntimeControls()?.session;
    if (!controls?.canFork || !session || controls.authorityKey !== authorityKey) {
      throw new Error("The message fork owner or native boundary changed. Reopen the current message confirmation.");
    }
    const displayName = name.trim();
    if (!displayName || displayName.length > 120 || /[\u0000-\u001f\u007f]/u.test(displayName)) throw new Error("Use a task name between 1 and 120 characters.");
    this.#assertNoPendingRuntimeControl(session.sessionId);
    const action = this.#claimMutation(); const epoch = this.#epoch;
    const profileId = this.#activeProfileId!;
    const current = (): boolean => this.#current(epoch) && this.#foreground && !signal?.aborted
      && this.taskMessageForkControls(eventId)?.surfaceOwnerKey === controls.surfaceOwnerKey;
    let draftRestored = controls.source.draft === undefined;
    try {
      const result = await this.#submitTerminal(create(OperationMutationSchema, {
        preconditions: [this.#sessionRuntimePrecondition(session)],
        payload: { case: "forkSession", value: create(ForkSessionMutationSchema, {
          sourceSessionId: session.sessionId, nativeEntryId: controls.source.nativeEntryId,
          sourceMessageId: controls.source.messageId, sourceEventId: controls.source.eventId, newDisplayName: displayName
        }) }
      }), { kind: "session-fork", sessionId: session.sessionId, eventId }, undefined, true, false,
      { signal: signal ?? new AbortController().signal, isCurrent: current,
        beforeTerminalReceipt: async (operation) => {
          if (operation.state !== OperationState.SUCCEEDED) return;
          const child = this.#derivedTaskResult(operation, session, SessionDerivationKind.FORK, controls.source);
          draftRestored = await this.#restoreForkDraft(controls.source.draft, profileId, child.sessionId, current);
        } });
      if (!current()) return { kind: "retired" };
      if (!result.definitive) return { kind: "unknown" };
      if (!result.accepted) return { kind: "rejected" };
      const child = this.#derivedTaskResult(result.operation, session, SessionDerivationKind.FORK, controls.source);
      if (!current() || !await this.#refreshDerivedTaskList(child, current, signal)) return { kind: "retired" };
      return { kind: "forked", sessionId: child.sessionId, draftRestored };
    } finally { this.#releaseMutation(action); }
  }

  async #restoreForkDraft(draft: MobileComposerDraft | undefined, profileId: string, sessionId: string,
    current: () => boolean): Promise<boolean> {
    if (!draft) return true;
    if (!this.composerDrafts) return false;
    const identity = { profileId, sessionId };
    try {
      const snapshot = await this.composerDrafts.readSnapshot(identity);
      if (!current()) return false;
      const restored = recoverMobileComposerDraft(draft, snapshot.draft ?? emptyMobileComposerDraft());
      if (!this.composerDrafts.saveIfRevision(identity, restored, snapshot.revision)) return false;
      await this.composerDrafts.flush(identity);
      return true;
    } catch { return false; }
  }

  async #recoverForkReceipt(pending: PendingOperation, operation: Operation, epoch: number): Promise<void> {
    const credential = this.#ready(); const profileId = this.#activeProfileId!;
    const sources = this.#state.owner?.sessions.filter((candidate) => candidate.sessionId === pending.sessionId) ?? [];
    if (sources.length !== 1 || !pending.eventId) throw new Error("The saved fork source is unavailable. Its operation was not resent.");
    const current = (): boolean => this.#current(epoch) && this.#foreground && this.#activeProfileId === profileId
      && this.#credential?.connectionId === pending.connectionId;
    const around = await this.network.readAround(credential, sources[0]!.sessionId, pending.eventId, this.#abort?.signal);
    if (!current()) return;
    const source = resolveMobileMessageForkSource(around, sources[0]!.sessionId, pending.eventId, this.#state.owner!.generation, false);
    if (!source) throw new Error("The saved fork input or native source is unavailable. Its operation was not resent.");
    const child = this.#derivedTaskResult(operation, sources[0]!, SessionDerivationKind.FORK, source);
    const restored = await this.#restoreForkDraft(source.draft, profileId, child.sessionId, current);
    if (current() && !restored) this.#set({ error: "The branch was created, but its draft could not be restored. Open it to review before sending." });
  }

  #derivedTaskResult(operation: Operation | undefined, source: Session, kind: SessionDerivationKind,
    message?: MobileMessageForkSource): Session {
    const child = operation?.result?.payload.case === "session" ? operation.result.payload.value : undefined;
    if (operation?.state !== OperationState.SUCCEEDED || !child?.sessionId || child.sessionId === source.sessionId
      || child.sessionId.length > 512 || /[\u0000-\u001f\u007f]/u.test(child.sessionId)
      || child.backendId !== source.backendId || child.nativeBinding?.backendId !== source.backendId
      || !child.nativeBinding.opaqueReference || child.nativeBinding.opaqueReference === source.nativeBinding?.opaqueReference
      || child.nativeBinding.runtimeGeneration < 1n || child.derivationOrigin?.kind !== kind
      || child.derivationOrigin.sourceSessionId !== source.sessionId
      || (message && (child.derivationOrigin.sourceMessageId !== message.messageId || child.derivationOrigin.sourceEventId !== message.eventId))) {
      throw new Error("The Joko node completed task derivation without the exact derived Session identity.");
    }
    return child;
  }

  async #refreshDerivedTaskList(child: Session, current: () => boolean, signal?: AbortSignal): Promise<boolean> {
    const credential = this.#ready();
    const owner = await this.network.readOwner(credential, this.deviceNameSource(), signal === undefined ? this.#abort?.signal
      : this.#abort === undefined ? signal : AbortSignal.any([this.#abort.signal, signal]));
    if (!current() || signal?.aborted) return false;
    this.#assertOwner(credential, owner, this.#state.node!);
    const derived = owner.snapshot.sessions.filter((candidate) => candidate.sessionId === child.sessionId);
    if (derived.length !== 1 || derived[0]!.backendId !== child.backendId || derived[0]!.targetId !== child.targetId
      || derived[0]!.nativeBinding?.opaqueReference !== child.nativeBinding?.opaqueReference
      || derived[0]!.nativeBinding?.runtimeGeneration !== child.nativeBinding?.runtimeGeneration) {
      throw new Error("The derived task is not available in the current authenticated task list.");
    }
    this.#set({ owner: owner.snapshot });
    return current();
  }

  taskHeaderSourceKey(): string | undefined {
    if (this.#joinedTask) return this.#taskAuthorityKey();
    if (!this.#taskAuthorityKey()) return undefined;
    const credential = this.#credential!, owner = this.#state.owner!;
    const session = this.#state.detail!.sessions.find(candidate => candidate.sessionId === this.#state.selectedId)!;
    return [credential.profileId, credential.serverId, credential.connectionId, credential.deviceId, owner.generation.toString(),
      session.sessionId, session.backendId, session.targetId, session.nativeBinding!.runtimeGeneration.toString(), this.#epoch.toString()].join("\u001f");
  }

  async readTaskHeaderRole(sourceKey: string, signal: AbortSignal): Promise<import("./mobile-task-header-role").MobileTaskHeaderRole> {
    if (!sourceKey || this.taskHeaderSourceKey() !== sourceKey) throw new Error("The task header source is no longer current.");
    const credential = this.#ready(), epoch = this.#epoch, sessionId = this.#state.selectedId!;
    const combined = AbortSignal.any([this.#abort!.signal, signal]); combined.throwIfAborted();
    const role = await this.network.readTaskHeaderRole(credential, sessionId, combined);
    if (combined.aborted || !this.#current(epoch) || this.#credential !== credential || this.taskHeaderSourceKey() !== sourceKey) {
      throw new Error("The task header source changed while reading.");
    }
    return role;
  }

  async suggestTaskTitle(sourceKey: string, signal: AbortSignal): Promise<import("@joko/contracts").SuggestSessionTitleResponse> {
    if (this.#joinedTask || !sourceKey || this.taskHeaderSourceKey() !== sourceKey) {
      throw new Error("A current owned task is required to suggest its title.");
    }
    const credential = this.#ready(), epoch = this.#epoch, sessionId = this.#state.selectedId!;
    const combined = AbortSignal.any([this.#abort!.signal, signal]);
    const assertCurrent = (): void => {
      combined.throwIfAborted();
      if (!this.#current(epoch) || this.#credential !== credential || this.taskHeaderSourceKey() !== sourceKey) {
        throw new Error("The title suggestion belongs to a retired task owner.");
      }
    };
    const role = await this.readTaskHeaderRole(sourceKey, combined);
    assertCurrent();
    if (role === "worker") throw new Error("Worker titles are managed through their collaboration.");
    const response = await this.network.suggestSessionTitle(credential, sessionId, combined);
    assertCurrent();
    return response;
  }

  taskDelegatedControls(): import("./mobile-delegated-reader").MobileDelegatedControls | undefined {
    const authorityKey = this.#taskAuthorityKey();
    const sessionId = this.#state.selectedId;
    const detail = this.#state.detail;
    const owner = this.#joinedTask ? this.#state.detail : this.#state.owner;
    if (!authorityKey || !sessionId || (!this.#joinedTask && owner?.scope?.kind.case !== "owner") || !owner
      || detail?.scope?.kind.case !== "session" || detail.scope.kind.value.sessionId !== sessionId) return undefined;
    const session = detail.sessions.find((candidate) => candidate.sessionId === sessionId)!;
    const backend = detail.backends.find((candidate) => candidate.backendId === session.backendId)!;
    const supported = (name: string): boolean => backend.capabilities?.capabilities.some((capability) =>
      capability.name === name && capability.support === CapabilitySupport.SUPPORTED) === true;
    const canListBackground = supported(capabilityNames.backgroundTasks);
    const canListRuns = supported(capabilityNames.subagentsList);
    if (!canListBackground && !canListRuns) return undefined;
    return { authorityKey, surfaceOwnerKey: JSON.stringify([this.#credential!.profileId, this.#credential!.serverId,
      this.#credential!.connectionId, this.#credential!.deviceId, owner.generation.toString(), sessionId,
      session.backendId, session.targetId, session.nativeBinding!.runtimeGeneration.toString()]),
      sessionId, generation: owner.generation, canListBackground, canListRuns,
      canReadDetail: supported(capabilityNames.subagentsDetail), canReadTranscript: supported(capabilityNames.subagentsTranscript) };
  }

  async #readDelegated<T>(authorityKey: string, signal: AbortSignal | undefined,
    read: (credential: PairedCredential, sessionId: string, signal: AbortSignal) => Promise<T>): Promise<T> {
    const controls = this.taskDelegatedControls();
    if (!controls || controls.authorityKey !== authorityKey) throw new Error("The delegated task owner is no longer current.");
    const credential = this.#ready(); const epoch = this.#epoch;
    const combined = signal === undefined ? this.#abort!.signal : AbortSignal.any([this.#abort!.signal, signal]);
    if (combined.aborted) throw new Error("Delegated task reading was cancelled.");
    const result = await read(credential, controls.sessionId, combined);
    if (combined.aborted || !this.#current(epoch) || this.#credential !== credential
      || this.taskDelegatedControls()?.authorityKey !== authorityKey) throw new Error("The delegated task owner changed while reading.");
    return result;
  }

  async loadTaskBackgroundTasks(authorityKey: string, pageToken = "", signal?: AbortSignal) {
    if (!this.taskDelegatedControls()?.canListBackground) throw new Error("Background activity is unavailable for this task.");
    return this.#readDelegated(authorityKey, signal, (credential, sessionId, activeSignal) =>
      this.network.listBackgroundTasks(credential, sessionId, pageToken, activeSignal));
  }

  async loadTaskBackgroundOutput(authorityKey: string, taskId: string, signal?: AbortSignal) {
    if (!this.taskDelegatedControls()?.canListBackground || !this.network.readBackgroundTaskOutput) throw new Error("Background output is unavailable for this task.");
    return this.#readDelegated(authorityKey, signal, (credential, sessionId, owned) =>
      this.network.readBackgroundTaskOutput!(credential, sessionId, taskId, owned));
  }

  async loadTaskDelegatedRuns(authorityKey: string, pageToken = "", signal?: AbortSignal) {
    if (!this.taskDelegatedControls()?.canListRuns) throw new Error("Delegated activity is unavailable for this task.");
    return this.#readDelegated(authorityKey, signal, (credential, sessionId, activeSignal) =>
      this.network.listSubagentRuns(credential, sessionId, pageToken, activeSignal));
  }

  async loadTaskDelegatedDetail(authorityKey: string, runId: string, signal?: AbortSignal) {
    if (!this.taskDelegatedControls()?.canReadDetail) throw new Error("Delegated details are unavailable for this task.");
    return this.#readDelegated(authorityKey, signal, (credential, sessionId, activeSignal) =>
      this.network.getSubagentRun(credential, sessionId, runId, activeSignal));
  }

  async loadTaskDelegatedTranscript(authorityKey: string, runId: string, childId = "", pageToken = "", signal?: AbortSignal) {
    if (!this.taskDelegatedControls()?.canReadTranscript) throw new Error("Delegated content is unavailable for this task.");
    return this.#readDelegated(authorityKey, signal, (credential, sessionId, activeSignal) =>
      this.network.listSubagentTranscript(credential, sessionId, runId, childId, pageToken, activeSignal));
  }

  taskNativeTreeControls(): MobileNativeTreeControls | undefined {
    if (this.#joinedTask) return undefined;
    const credential = this.#credential;
    if (!credential || !this.#taskAuthorityKey()) return undefined;
    return resolveMobileNativeTreeControls({
      profileId: credential.profileId,
      connectionId: credential.connectionId,
      deviceId: credential.deviceId,
      serverId: credential.serverId
    }, this.#state.owner, this.#state.detail, this.#state.selectedId);
  }

  async loadTaskNativeTree(authorityKey: string): Promise<MobileNativeTreeSnapshot> {
    const controls = this.#nativeTreeContext(authorityKey);
    const credential = this.#ready();
    const epoch = this.#epoch;
    const tree = await this.network.readNativeSessionTree(
      credential,
      controls.session.sessionId,
      this.#abort?.signal
    );
    const current = this.taskNativeTreeControls();
    if (!this.#current(epoch) || !current || current.authorityKey !== authorityKey) {
      throw new Error("The task branch owner changed while its tree was loading.");
    }
    return projectMobileNativeTree(current, tree);
  }

  async navigateTaskNativeTree(
    authorityKey: string,
    tree: MobileNativeTreeSnapshot,
    entryId: string,
    summarize: boolean,
    customInstructions: string
  ): Promise<"navigated" | "rejected" | "unknown"> {
    const controls = this.#nativeTreeContext(authorityKey);
    const navigation = assertMobileNativeTreeNavigation(controls, tree, entryId, summarize, customInstructions);
    this.#assertNoPendingRuntimeControl(controls.session.sessionId);
    const action = this.#claimMutation();
    try {
      const result = await this.#submitTerminal(create(OperationMutationSchema, {
        preconditions: [this.#sessionRuntimePrecondition(controls.session)],
        payload: { case: "navigateSessionBranch", value: create(NavigateSessionBranchMutationSchema, {
          sessionId: controls.session.sessionId,
          target: { kind: { case: "nativeEntryId", value: navigation.entryId } },
          summarize: navigation.summarize,
          customInstructions: navigation.customInstructions
        }) }
      }), { kind: "session-branch", sessionId: controls.session.sessionId });
      if (!result.definitive) return "unknown";
      if (!result.accepted) return "rejected";
      if (result.operation?.state !== OperationState.SUCCEEDED
        || result.operation.result?.payload.case !== "acknowledgement") {
        throw new Error("The Joko node completed branch navigation without a typed acknowledgement.");
      }
      return "navigated";
    } finally { this.#releaseMutation(action); }
  }

  taskInteractions(): readonly Interaction[] {
    const all = pendingMobileInteractions(this.#state.detail, this.#state.selectedId);
    return this.#joinedTask ? all.filter(item => ["permission", "question", "planReview"].includes(item.request.case ?? "")) : all;
  }

  async resolveInteraction(interactionId: string, submission: MobileInteractionSubmission): Promise<boolean> {
    const interaction = this.#interactionContext(interactionId);
    this.#assertNoPendingInteractionMutation(interaction.sessionId, interaction.interactionId);
    const credential = this.#ready();
    const resolution = createMobileInteractionResolution(interaction, submission, credential.connectionId);
    const concurrentUserShell = this.#userShellFlight?.sessionId === interaction.sessionId;
    const action = this.#claimMutation(concurrentUserShell);
    try {
      const result = await this.#submitTerminal(create(OperationMutationSchema, {
        preconditions: [this.#interactionPrecondition(interaction)],
        payload: { case: "resolveInteraction", value: create(ResolveInteractionMutationSchema, {
          interactionId: interaction.interactionId,
          interactionGeneration: interaction.generation,
          resolution
        }) }
      }), { kind: "interaction-resolve", sessionId: interaction.sessionId, interactionId: interaction.interactionId,
        ...this.#interactionReceiptIdentity(interaction) }, undefined, true, !concurrentUserShell);
      return result.accepted && result.definitive;
    } finally { this.#releaseMutation(action); }
  }

  async dismissInteraction(interactionId: string): Promise<boolean> {
    const interaction = this.#interactionContext(interactionId);
    this.#assertNoPendingInteractionMutation(interaction.sessionId, interaction.interactionId);
    this.#ready();
    const concurrentUserShell = this.#userShellFlight?.sessionId === interaction.sessionId;
    const action = this.#claimMutation(concurrentUserShell);
    try {
      const result = await this.#submitTerminal(create(OperationMutationSchema, {
        preconditions: [this.#interactionPrecondition(interaction)],
        payload: { case: "dismissInteraction", value: create(DismissInteractionMutationSchema, {
          interactionId: interaction.interactionId,
          interactionGeneration: interaction.generation,
          reason: "Dismissed by user on mobile"
        }) }
      }), { kind: "interaction-dismiss", sessionId: interaction.sessionId, interactionId: interaction.interactionId,
        ...this.#interactionReceiptIdentity(interaction) }, undefined, true, !concurrentUserShell);
      return result.accepted && result.definitive;
    } finally { this.#releaseMutation(action); }
  }

  async cancelQueueItem(queueItemId: string): Promise<boolean> {
    const { session, item, capabilities } = this.#queueItemContext(queueItemId);
    if (!capabilities.cancel) throw new Error("This Backend does not support cancelling queued input.");
    this.#assertNoPendingQueueMutation(session.sessionId, queueItemId);
    const action = this.#claimMutation();
    try {
      return await this.#submit(create(OperationMutationSchema, {
        preconditions: [this.#queueItemPrecondition(item)],
        payload: { case: "cancelQueueItem", value: create(CancelQueueItemMutationSchema, { queueItemId }) }
      }), { kind: "queue-cancel", sessionId: session.sessionId, queueItemId });
    } finally { this.#releaseMutation(action); }
  }

  async beginQueueEdit(queueItemId: string): Promise<MobileQueueEditLease> {
    if (this.#queueEditLease) throw new Error("Finish or cancel the current queued-input edit first.");
    const { session, item, capabilities, authorityKey } = this.#queueItemContext(queueItemId);
    if (!capabilities.edit) throw new Error("This Backend does not support editing queued input.");
    if (item.editLocked) throw new Error("This queued input is being edited by another client.");
    const text = queueItemText(item.input);
    if (text === undefined) throw new Error("This queued input cannot be represented by the current text editor.");
    this.#assertNoPendingQueueMutation(session.sessionId, queueItemId);
    const connectionId = this.#ready().connectionId;
    const lockToken = this.newId();
    const action = this.#claimMutation();
    const lease = {
      connectionId,
      sessionId: session.sessionId,
      queueItemId,
      lockToken,
      authorityKey,
      text,
      replacesStructuredInput: queueItemHasStructuredInput(item.input)
    };
    this.#queueEditLease = lease;
    try {
      let result: TrackedMutationResult;
      try {
        result = await this.#submitTerminal(create(OperationMutationSchema, {
          preconditions: [this.#queueItemPrecondition(item)],
          payload: { case: "setQueueItemEditLock", value: create(SetQueueItemEditLockMutationSchema, {
            queueItemId,
            lockToken,
            locked: true
          }) }
        }), { kind: "queue-edit-lock", sessionId: session.sessionId, queueItemId });
      } catch (error) {
        if (this.#queueEditLease === lease) this.#queueEditLease = undefined;
        throw error;
      }
      if (!result.accepted || !result.definitive) {
        if (this.#queueEditLease === lease) {
          if (result.definitive) this.#queueEditLease = undefined;
          else await this.#releaseQueueEditLease(lease).catch(() => {
            if (this.#queueEditLease === lease) this.#releaseQueueEditLeaseDetached(lease);
          });
        } else if (!result.definitive) this.#submitDetachedQueueEditUnlock(lease);
        throw new Error(result.definitive
          ? "The queued-input edit lock was rejected."
          : "The queued-input edit lock has an unknown result. Check its operation before retrying.");
      }
      if (this.#queueEditLease !== lease || this.#taskAuthorityKey() !== authorityKey) {
        await this.#releaseQueueEditLease(lease).catch(() => {
          if (this.#queueEditLease === lease) this.#releaseQueueEditLeaseDetached(lease);
        });
        throw new Error("The task changed while the queued-input editor was opening.");
      }
      const current = this.#queueItem(queueItemId);
      if (!current || current.state !== QueueItemState.ACCEPTED) {
        await this.#releaseQueueEditLease(lease).catch(() => {
          if (this.#queueEditLease === lease) this.#releaseQueueEditLeaseDetached(lease);
        });
        throw new Error("The queued input was dispatched or removed while its editor was opening.");
      }
      return lease;
    } finally { this.#releaseMutation(action); }
  }

  async saveQueueEdit(lease: MobileQueueEditLease, text: string, deliveryMode?: QueueDeliveryMode): Promise<boolean> {
    this.#assertQueueEditLease(lease);
    const { item, capabilities } = this.#queueItemContext(lease.queueItemId);
    if (!capabilities.edit) throw new Error("This Backend no longer supports editing queued input.");
    if (queueItemText(item.input) === text && (deliveryMode === undefined || deliveryMode === item.deliveryMode)) {
      await this.cancelQueueEdit(lease);
      return true;
    }
    const edit = editQueueItemText(item.input, text);
    if (!edit) throw new Error("Use non-empty text that the current queued-input editor can represent.");
    const action = this.#claimMutation();
    let result: TrackedMutationResult | undefined;
    try {
      result = await this.#submitTerminal(create(OperationMutationSchema, {
        preconditions: [this.#queueItemPrecondition(item)],
        payload: { case: "editQueueItem", value: create(EditQueueItemMutationSchema, {
          queueItemId: item.queueItemId,
          input: edit.input,
          deliveryMode: deliveryMode ?? item.deliveryMode,
          lockToken: lease.lockToken,
          textSplices: [...edit.textSplices]
        }) }
      }), { kind: "queue-edit", sessionId: lease.sessionId, queueItemId: lease.queueItemId });
      if (result.definitive) await this.#releaseQueueEditLease(lease).catch(() => {
        if (this.#queueEditLease === lease) this.#releaseQueueEditLeaseDetached(lease);
      });
      if (!result.accepted || !result.definitive) {
        if (!result.definitive) {
          throw new Error("The queued-input edit has an unknown result. Check its operation before closing the editor.");
        }
        return false;
      }
      return true;
    } finally { this.#releaseMutation(action); }
  }

  async cancelQueueEdit(lease: MobileQueueEditLease): Promise<void> {
    if (this.#queueEditLease !== lease) return;
    const action = this.#claimMutation();
    try { await this.#releaseQueueEditLease(lease); }
    finally { this.#releaseMutation(action); }
  }

  async moveQueueItem(queueItemId: string, direction: "up" | "down"): Promise<boolean> {
    const initial = this.#queueItemContext(queueItemId);
    if (!initial.capabilities.reorder) throw new Error("This Backend does not support reordering queued input.");
    const control = this.#queueControl(initial.session.sessionId);
    if (!control) throw new Error("The current task has no queue-control authority.");
    if (control.interactionLocked) throw new Error("This queue is being reordered by another client.");
    if (!queueMove(this.taskQueueItems(), queueItemId, direction)) return false;
    this.#assertNoPendingQueueMutation(initial.session.sessionId, queueItemId);
    const credential = this.#ready();
    const lockToken = this.newId();
    const action = this.#claimMutation();
    const interactionLease: MobileQueueInteractionLease = {
      credential,
      sessionId: initial.session.sessionId,
      lockToken,
      authorityKey: initial.authorityKey
    };
    this.#queueInteractionLease = interactionLease;
    let lockResult: TrackedMutationResult | undefined;
    let reorderResult: TrackedMutationResult | undefined;
    try {
      lockResult = await this.#submitTerminal(create(OperationMutationSchema, {
        preconditions: [this.#queueControlPrecondition(control)],
        payload: { case: "setQueueInteractionLock", value: create(SetQueueInteractionLockMutationSchema, {
          sessionId: initial.session.sessionId,
          lockToken,
          locked: true
        }) }
      }), { kind: "queue-interaction-lock", sessionId: initial.session.sessionId });
      if (!lockResult.accepted || !lockResult.definitive) {
        throw new Error(lockResult.definitive
          ? "The queue reorder lock was rejected."
          : "The queue reorder lock has an unknown result. Check its operation before retrying.");
      }
      if (this.#queueInteractionLease !== interactionLease || this.#taskAuthorityKey() !== initial.authorityKey) {
        throw new Error("The task changed while the queue reorder lock was being acquired.");
      }
      const current = this.#queueItemContext(queueItemId);
      const move = queueMove(this.taskQueueItems(), queueItemId, direction);
      if (!move) {
        reorderResult = { accepted: false, definitive: true };
        return false;
      }
      reorderResult = await this.#submitTerminal(create(OperationMutationSchema, {
        preconditions: [this.#queueItemPrecondition(current.item)],
        payload: { case: "reorderQueueItem", value: create(ReorderQueueItemMutationSchema, {
          queueItemId,
          placement: { anchor: move.placement === "before"
            ? { case: "beforeQueueItemId", value: move.anchorQueueItemId }
            : { case: "afterQueueItemId", value: move.anchorQueueItemId } },
          interactionLockToken: lockToken
        }) }
      }), { kind: "queue-reorder", sessionId: initial.session.sessionId, queueItemId });
      return reorderResult.accepted && reorderResult.definitive;
    } finally {
      const lockMayBeHeld = lockResult?.accepted === true || lockResult?.definitive === false;
      if (lockMayBeHeld) {
        if (this.#queueInteractionLease === interactionLease) {
          await this.#releaseQueueInteractionLease(interactionLease).catch(() => {
            if (this.#queueInteractionLease === interactionLease) {
              this.#releaseQueueInteractionLeaseDetached(interactionLease);
            }
          });
        } else {
          this.#submitDetachedQueueInteractionUnlock(interactionLease);
        }
      } else if (this.#queueInteractionLease === interactionLease) {
        this.#queueInteractionLease = undefined;
      }
      this.#releaseMutation(action);
    }
  }

  async renameSession(sessionId: string, displayName: string): Promise<boolean> {
    const value = displayName.trim();
    if (!value || value.length > 256) throw new Error("Use a task name between 1 and 256 characters.");
    return this.#mutateSession(sessionId, "rename", {
      case: "renameSession",
      value: create(RenameSessionMutationSchema, { sessionId, displayName: value })
    });
  }

  async createTaskTag(sessionId: string, name: string, color: TaskTagColor, expectedCatalogRevision: bigint): Promise<boolean> {
    const value = name.trim();
    if (!value || value.length > 80) throw new Error("Use a task-tag name between 1 and 80 characters.");
    return this.#mutateTaskTags(sessionId, create(OperationMutationSchema, {
      payload: { case: "createTaskTag", value: create(CreateTaskTagMutationSchema, {
        originSessionId: sessionId,
        name: value,
        color,
        expectedCatalogRevision: create(RevisionSchema, { value: expectedCatalogRevision })
      }) }
    }));
  }

  async updateTaskTag(sessionId: string, taskTagId: string, expectedRevision: bigint,
    patch: { readonly name?: string; readonly color?: TaskTagColor }): Promise<boolean> {
    const name = patch.name?.trim();
    if (name !== undefined && (!name || name.length > 80)) throw new Error("Use a task-tag name between 1 and 80 characters.");
    if (name === undefined && patch.color === undefined) return true;
    return this.#mutateTaskTags(sessionId, create(OperationMutationSchema, {
      payload: { case: "updateTaskTag", value: create(UpdateTaskTagMutationSchema, {
        originSessionId: sessionId,
        taskTagId,
        expectedRevision: create(RevisionSchema, { value: expectedRevision }),
        ...(name === undefined ? {} : { name }),
        ...(patch.color === undefined ? {} : { color: patch.color })
      }) }
    }));
  }

  async reorderTaskTags(sessionId: string, taskTagIds: readonly string[], expectedCatalogRevision: bigint): Promise<boolean> {
    return this.#mutateTaskTags(sessionId, create(OperationMutationSchema, {
      payload: { case: "reorderTaskTags", value: create(ReorderTaskTagsMutationSchema, {
        originSessionId: sessionId,
        taskTagIds: [...taskTagIds],
        expectedCatalogRevision: create(RevisionSchema, { value: expectedCatalogRevision })
      }) }
    }));
  }

  async setSessionTaskTag(sessionId: string, taskTagId: string, attached: boolean): Promise<boolean> {
    return this.#mutateTaskTags(sessionId, create(OperationMutationSchema, {
      payload: { case: "setSessionTaskTags", value: create(SetSessionTaskTagsMutationSchema, {
        originSessionId: sessionId,
        sessionIds: [sessionId],
        taskTagIds: [taskTagId],
        attached
      }) }
    }));
  }

  async previewTaskTagDeletion(taskTagId: string, signal?: AbortSignal): Promise<TaskTagDeletePreview> {
    return this.network.previewTaskTagDeletion(this.#ready(), taskTagId, signal);
  }

  async deleteTaskTag(sessionId: string, preview: TaskTagDeletePreview): Promise<boolean> {
    if (!preview.tagRevision || !preview.associationRevision) {
      throw new Error("A current task-tag delete preview is required.");
    }
    return this.#mutateTaskTags(sessionId, create(OperationMutationSchema, {
      payload: { case: "deleteTaskTag", value: create(DeleteTaskTagMutationSchema, {
        originSessionId: sessionId,
        taskTagId: preview.taskTagId,
        affectedSessionCount: preview.affectedSessionCount,
        expectedTagRevision: create(RevisionSchema, preview.tagRevision),
        expectedAssociationRevision: create(RevisionSchema, preview.associationRevision)
      }) }
    }));
  }

  async #mutateTaskTags(sessionId: string, mutation: OperationMutation): Promise<boolean> {
    if (!this.#state.owner?.sessions.some((candidate) => candidate.sessionId === sessionId)) {
      throw new Error("A current task is required to change task tags.");
    }
    if (this.#state.pending.some((item) => item.kind === "task-tag")) {
      throw new Error("A previous task-tag change is still pending.");
    }
    this.#ready();
    const action = this.#claimMutation();
    try {
      const result = await this.#submitTerminal(mutation, { kind: "task-tag", sessionId });
      return result.accepted && result.definitive;
    } finally { this.#releaseMutation(action); }
  }

  async setSessionPinned(sessionId: string, pinned: boolean): Promise<boolean> {
    return this.#mutateSession(sessionId, "pin", {
      case: "pinSession",
      value: create(PinSessionMutationSchema, { sessionId, pinned })
    });
  }

  async prepareSessionArchive(sessionId: string): Promise<{
    readonly preview: SessionArchivePreview;
    readonly archive: () => Promise<boolean>;
  }> {
    const credential = this.#ready(), abort = this.#abort;
    const session = this.#state.owner?.sessions.find((candidate) => candidate.sessionId === sessionId);
    const revision = session?.version?.revision?.value;
    if (!session || session.archived || revision === undefined) throw new Error("A current active task is required.");
    const current = (): void => {
      if (this.#credential !== credential || this.#abort !== abort || this.#disposed
        || !this.#foreground
        || this.#state.owner?.sessions.find((candidate) => candidate.sessionId === sessionId)?.version?.revision?.value !== revision) {
        throw new Error("The archive source changed. Review this task again.");
      }
      abort?.signal.throwIfAborted();
    };
    const controller = new AbortController();
    const signal = abort === undefined ? controller.signal : AbortSignal.any([abort.signal, controller.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const preview = await Promise.race([
        this.network.readSessionArchivePreview(credential, sessionId, signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error("The archive preview timed out. Retry before archiving.")); }, 3_000);
        })
      ]);
      current();
      return { preview, archive: async () => { current(); return this.setSessionArchived(sessionId, true, preview.archiveConfirmation); } };
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }

  async setSessionArchived(sessionId: string, archived: boolean, archiveConfirmation = ""): Promise<boolean> {
    return this.#mutateSession(sessionId, "archive", {
      case: "archiveSession",
      value: create(ArchiveSessionMutationSchema, { sessionId, archived, archiveConfirmation })
    });
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    return this.#mutateSession(sessionId, "delete", {
      case: "deleteSession",
      value: create(DeleteSessionMutationSchema, { sessionId, deleteNativeSession: false, deleteArtifacts: false })
    });
  }

  async #mutateSession(
    sessionId: string,
    kind: Extract<PendingOperation["kind"], "rename" | "pin" | "archive" | "delete">,
    payload: OperationMutation["payload"]
  ): Promise<boolean> {
    const session = this.#state.owner?.sessions.find((candidate) => candidate.sessionId === sessionId);
    const revision = session?.version?.revision;
    if (!session || !revision || revision.value < 1n) throw new Error("A current task revision is required.");
    if (this.#state.pending.some((item) => item.sessionId === sessionId
      && ["rename", "pin", "archive", "delete"].includes(item.kind))) {
      throw new Error("A previous change to this task is still pending. Check its operation before changing it again.");
    }
    this.#ready();
    const action = this.#claimMutation();
    try {
      return await this.#submit(create(OperationMutationSchema, {
        preconditions: [create(OperationPreconditionSchema, {
          entity: create(EntityRefSchema, { kind: EntityKind.SESSION, id: sessionId }),
          expectedRevision: revision
        })],
        payload
      }), { kind, sessionId });
    } finally { this.#releaseMutation(action); }
  }

  #claimMutation(allowUserShellInteraction = false): symbol {
    if (this.#mutationOwner || this.#connectionAttemptAbort || this.#state.busy
      || this.#userShellFlight && !allowUserShellInteraction) {
      throw new Error("Another task or connection operation is already in progress.");
    }
    this.#cancelCatalogAttempt();
    const action = Symbol("mobile mutation");
    this.#mutationOwner = action;
    this.#set({ busy: true });
    return action;
  }

  #releaseMutation(action: symbol): void {
    if (this.#mutationOwner !== action) return;
    this.#mutationOwner = undefined;
    this.#set({ busy: false });
  }

  #selectedSession(): Session | undefined {
    const sessionId = this.#state.selectedId;
    if (!sessionId) return undefined;
    return this.#state.detail?.sessions.find((item) => item.sessionId === sessionId)
      ?? (this.#joinedTask ? undefined : this.#state.owner?.sessions.find((item) => item.sessionId === sessionId));
  }

  #selectedBackend(session: Session | undefined) {
    return (this.#joinedTask ? this.#state.detail : this.#state.owner)?.backends.find((item) => item.backendId === session?.backendId);
  }

  #taskGeneration(): bigint | undefined { return (this.#joinedTask ? this.#state.detail : this.#state.owner)?.generation; }

  #runtimeControlContext(expectedAuthorityKey: string): MobileRuntimeControls {
    this.#ready();
    const controls = this.taskRuntimeControls();
    if (!controls || !expectedAuthorityKey || controls.authorityKey !== expectedAuthorityKey) {
      throw new Error("The task controls changed. Reopen them from the current task.");
    }
    return controls;
  }

  #appCommandContext(expectedSurfaceOwnerKey: string): {
    readonly credential: PairedCredential;
    readonly controls: MobileAppCommandControls;
  } {
    const credential = this.#ready();
    const controls = this.taskAppCommandControls();
    if (!controls || !expectedSurfaceOwnerKey || controls.surfaceOwnerKey !== expectedSurfaceOwnerKey) {
      throw new Error("The task command owner changed. Type the slash command again.");
    }
    return { credential, controls };
  }

  #contextControlContext(expectedAuthorityKey: string): MobileContextControls {
    this.#ready();
    const controls = this.taskContextControls();
    if (!controls || !expectedAuthorityKey || controls.authorityKey !== expectedAuthorityKey) {
      throw new Error("The task context changed. Reopen it from the current task.");
    }
    return controls;
  }

  #nativeTreeContext(expectedAuthorityKey: string): MobileNativeTreeControls {
    this.#ready();
    const controls = this.taskNativeTreeControls();
    if (!controls || !expectedAuthorityKey || controls.authorityKey !== expectedAuthorityKey) {
      throw new Error("The task branch owner changed. Reopen branches from the current task.");
    }
    return controls;
  }

  #newTaskSessionMentionControlsFromOwner(
    targetId: string,
    owner: Snapshot
  ): MobileSessionMentionControls | undefined {
    const target = uniqueValue(owner.targets, (candidate) => candidate.targetId === targetId);
    const backend = uniqueValue(owner.backends, (candidate) => candidate.backendId === target?.backendId);
    return createMobileNewTaskSessionMentionControls(
      this.#newTaskAuthorityKey(targetId, owner),
      owner,
      backend
    );
  }

  #newTaskSessionMentionContext(
    targetId: string,
    expectedSurfaceOwnerKey: string
  ): { readonly credential: PairedCredential; readonly controls: MobileSessionMentionControls } {
    const credential = this.#ready();
    const controls = this.newTaskSessionMentionControls(targetId);
    if (!controls || !expectedSurfaceOwnerKey || controls.surfaceOwnerKey !== expectedSurfaceOwnerKey) {
      throw new Error("Task reference authority changed. Reopen the reference list from this new task.");
    }
    return { credential, controls };
  }

  #newTaskWorkspaceMentionContext(
    targetId: string,
    expectedSurfaceOwnerKey: string
  ): { readonly credential: PairedCredential; readonly controls: MobileWorkspaceMentionControls } {
    const credential = this.#ready();
    const controls = this.newTaskWorkspaceMentionControls(targetId);
    if (!controls || !expectedSurfaceOwnerKey || controls.surfaceOwnerKey !== expectedSurfaceOwnerKey) {
      throw new Error("Workspace reference authority changed. Reopen the reference list from this new task.");
    }
    return { credential, controls };
  }

  #newTaskWorkspacePathPasteContext(
    targetId: string,
    expectedSurfaceOwnerKey: string
  ): { readonly credential: PairedCredential; readonly controls: MobileWorkspacePathPasteControls } {
    const credential = this.#ready();
    const controls = this.newTaskWorkspacePathPasteControls(targetId);
    if (!controls || !expectedSurfaceOwnerKey || controls.surfaceOwnerKey !== expectedSurfaceOwnerKey) {
      throw new Error("Workspace path authority changed. Paste again from this new task.");
    }
    return { credential, controls };
  }

  async #readNewTaskOwner(signal?: AbortSignal): Promise<{
    readonly credential: PairedCredential;
    readonly snapshot: Snapshot;
  }> {
    const credential = this.#ready();
    const node = this.#state.node;
    const profileId = this.#activeProfileId;
    if (!node || profileId !== credential.profileId) {
      throw new Error("Reconnect to the exact saved Joko node before checking new-task references.");
    }
    const owner = await this.network.readOwner(credential, this.deviceNameSource(), signal ?? this.#abort?.signal);
    if (this.#credential !== credential || this.#activeProfileId !== profileId
      || this.#state.node?.serverId !== node.serverId || !this.#foreground) {
      throw new Error("The saved Joko connection changed while new-task references were being checked.");
    }
    this.#assertOwner(credential, owner, node);
    return { credential, snapshot: owner.snapshot };
  }

  async #validateNewTaskSubmissionInput(
    submission: MobileNewTaskSubmission,
    expectedAuthorityKey = this.#newTaskAuthorityKey(submission.targetId)
  ): Promise<void> {
    const input = normalizeMobileComposerDraft(submission.input);
    if (input.mentions.some((mention) => mention.kind === "resource" || mention.kind === "artifact")) {
      throw new Error("A new task cannot reference runtime Resources or Artifacts before its Session exists.");
    }
    const hasSessionMentions = input.mentions.some((mention) => mention.kind === "session");
    const hasWorkspaceMentions = input.mentions.some((mention) => mention.kind === "workspace");
    const workspacePathAtoms = mobileComposerWorkspacePathAtoms(input);
    const initialAttachmentPolicy = this.#newTaskSubmissionAttachmentPolicy(submission);
    if (input.attachments.length > 0) {
      if (!initialAttachmentPolicy) throw new Error("This Backend no longer accepts the retained attachments.");
      assertMobileAttachmentPolicy(input.attachments, initialAttachmentPolicy);
    }
    const initialSessionControls = this.newTaskSessionMentionControls(submission.targetId);
    const initialWorkspaceControls = this.newTaskWorkspaceMentionControls(submission.targetId);
    const initialWorkspacePathControls = this.newTaskWorkspacePathPasteControls(submission.targetId);
    assertMobileWorkspacePathPasteDraft(initialWorkspacePathControls, input);
    const fresh = await this.#readNewTaskOwner();
    this.#assertNewTaskCreateAuthority(submission, fresh.snapshot);
    const freshAuthorityKey = this.#newTaskAuthorityKey(submission.targetId, fresh.snapshot);
    if (!expectedAuthorityKey || freshAuthorityKey !== expectedAuthorityKey) {
      throw new Error("The project, Backend, or Workspace changed while the structured first message was being checked.");
    }
    const sessionControls = this.#newTaskSessionMentionControlsFromOwner(submission.targetId, fresh.snapshot);
    const workspaceControls = createMobileNewTaskWorkspaceMentionControls(
      freshAuthorityKey,
      fresh.snapshot,
      submission.targetId
    );
    const workspacePathControls = createMobileNewTaskWorkspacePathPasteControls(
      freshAuthorityKey,
      fresh.snapshot,
      submission.targetId
    );
    const freshAttachmentPolicy = this.#newTaskSubmissionAttachmentPolicy(submission, fresh.snapshot);
    if (input.attachments.length > 0) {
      if (!freshAttachmentPolicy) throw new Error("This Backend no longer accepts the retained attachments.");
      assertMobileAttachmentPolicy(input.attachments, freshAttachmentPolicy);
    }
    if (hasSessionMentions && sessionControls?.surfaceOwnerKey !== initialSessionControls?.surfaceOwnerKey) {
      throw new Error("Referenced-task authority changed while the structured first message was being checked.");
    }
    if (hasWorkspaceMentions && workspaceControls?.surfaceOwnerKey !== initialWorkspaceControls?.surfaceOwnerKey) {
      throw new Error("Workspace reference authority changed while the structured first message was being checked.");
    }
    if (workspacePathAtoms.length > 0
      && workspacePathControls?.surfaceOwnerKey !== initialWorkspacePathControls?.surfaceOwnerKey) {
      throw new Error("Workspace path authority changed while the structured first message was being checked.");
    }
    assertMobileSessionMentionDraft(sessionControls, input);
    assertMobileWorkspaceMentionDraft(workspaceControls, input);
    assertMobileWorkspacePathPasteDraft(workspacePathControls, input);
    let workspacePathResolutions: readonly MobileWorkspacePathPasteResolution[] = [];
    if (workspacePathAtoms.length > 0) {
      workspacePathResolutions = await this.validateNewTaskWorkspacePathPasteCandidates(
        submission.targetId,
        workspacePathControls!.surfaceOwnerKey,
        workspacePathAtoms.map((atom) => atom.relativePath)
      );
      assertMobileWorkspacePathPasteResolutions(workspacePathControls!, input, workspacePathResolutions);
    }
    if (hasWorkspaceMentions) {
      await this.#revalidateNewTaskWorkspaceMentionPaths(fresh.credential, workspaceControls!, input);
    }
    if (!hasWorkspaceMentions && workspacePathAtoms.length === 0) return;
    const finalOwner = await this.#readNewTaskOwner();
    this.#assertNewTaskCreateAuthority(submission, finalOwner.snapshot);
    const finalAuthorityKey = this.#newTaskAuthorityKey(submission.targetId, finalOwner.snapshot);
    const finalSessionControls = this.#newTaskSessionMentionControlsFromOwner(submission.targetId, finalOwner.snapshot);
    const finalWorkspaceControls = createMobileNewTaskWorkspaceMentionControls(
      finalAuthorityKey,
      finalOwner.snapshot,
      submission.targetId
    );
    const finalWorkspacePathControls = createMobileNewTaskWorkspacePathPasteControls(
      finalAuthorityKey,
      finalOwner.snapshot,
      submission.targetId
    );
    const finalAttachmentPolicy = this.#newTaskSubmissionAttachmentPolicy(submission, finalOwner.snapshot);
    if (finalAuthorityKey !== freshAuthorityKey
      || hasSessionMentions && finalSessionControls?.surfaceOwnerKey !== sessionControls?.surfaceOwnerKey
      || hasWorkspaceMentions && finalWorkspaceControls?.surfaceOwnerKey !== workspaceControls?.surfaceOwnerKey
      || workspacePathAtoms.length > 0
        && finalWorkspacePathControls?.surfaceOwnerKey !== workspacePathControls?.surfaceOwnerKey) {
      throw new Error("New-task reference authority changed while Workspace paths were being checked.");
    }
    assertMobileSessionMentionDraft(finalSessionControls, input);
    assertMobileWorkspaceMentionDraft(finalWorkspaceControls, input);
    assertMobileWorkspacePathPasteDraft(finalWorkspacePathControls, input);
    if (workspacePathAtoms.length > 0) {
      assertMobileWorkspacePathPasteResolutions(finalWorkspacePathControls!, input, workspacePathResolutions);
    }
    if (input.attachments.length > 0) {
      if (!finalAttachmentPolicy) throw new Error("This Backend no longer accepts the retained attachments.");
      assertMobileAttachmentPolicy(input.attachments, finalAttachmentPolicy);
    }
  }

  #newTaskSubmissionAttachmentPolicy(
    submission: MobileNewTaskSubmission,
    owner = this.#state.owner
  ) {
    const target = uniqueValue(owner?.targets ?? [], (candidate) => candidate.targetId === submission.targetId);
    const backend = uniqueValue(owner?.backends ?? [], (candidate) => candidate.backendId === submission.backendId);
    if (!target || target.backendId !== submission.backendId || !backend) return undefined;
    const model = submission.model === null
      ? undefined
      : resolveMobileExplicitNewTaskModelAuthority(owner, submission.backendId, submission.model);
    if (submission.model !== null && !model) return undefined;
    return resolveMobileAttachmentPolicy(backend, model?.supportsImages === true);
  }

  async #revalidateNewTaskWorkspaceMentionPaths(
    credential: PairedCredential,
    controls: MobileWorkspaceMentionControls,
    draft: MobileComposerDraft
  ): Promise<void> {
    const mentions = draft.mentions.filter((mention) => mention.kind === "workspace");
    const byParent = new Map<string, typeof mentions>();
    for (const mention of mentions) {
      const parent = workspaceParentPath(mention.relativePath);
      byParent.set(parent, [...(byParent.get(parent) ?? []), mention]);
    }
    for (const [parent, expected] of byParent) {
      const result = await this.network.listWorkspaceDirectory(
        credential,
        controls.workspaceId,
        parent,
        this.#abort?.signal
      );
      const directory = projectMobileWorkspaceMentionDirectory(controls, parent, result.entries, result.revision);
      for (const mention of expected) {
        const matches = directory.entries.filter((entry) => entry.relativePath === mention.relativePath);
        const current = matches.length === 1 ? matches[0] : undefined;
        if (!current || current.directory !== mention.directory) {
          throw new Error("A referenced Workspace path disappeared or changed file type. The new-task draft was retained.");
        }
      }
    }
  }

  #workspaceMentionContext(expectedSurfaceOwnerKey: string): {
    readonly credential: PairedCredential;
    readonly controls: MobileWorkspaceMentionControls;
  } {
    const credential = this.#ready();
    const controls = this.taskWorkspaceMentionControls();
    if (!controls || !expectedSurfaceOwnerKey || controls.surfaceOwnerKey !== expectedSurfaceOwnerKey) {
      throw new Error("The Workspace reference owner changed. Reopen the reference list from the current task.");
    }
    return { credential, controls };
  }

  #workspacePathPasteContext(expectedSurfaceOwnerKey: string): {
    readonly credential: PairedCredential;
    readonly controls: MobileWorkspacePathPasteControls;
  } {
    const credential = this.#ready();
    const controls = this.taskWorkspacePathPasteControls();
    if (!controls || !expectedSurfaceOwnerKey || controls.surfaceOwnerKey !== expectedSurfaceOwnerKey) {
      throw new Error("Workspace path authority changed. Paste again from the current task.");
    }
    return { credential, controls };
  }

  #catalogMentionContext(expectedSurfaceOwnerKey: string): {
    readonly credential: PairedCredential;
    readonly controls: MobileCatalogMentionControls;
  } {
    const credential = this.#ready();
    const controls = this.taskCatalogMentionControls();
    if (!controls || !expectedSurfaceOwnerKey || controls.surfaceOwnerKey !== expectedSurfaceOwnerKey) {
      throw new Error("The catalog reference owner changed. Reopen the reference list from the current task.");
    }
    return { credential, controls };
  }

  #runtimeCommandContext(expectedSurfaceOwnerKey: string): {
    readonly credential: PairedCredential;
    readonly controls: MobileRuntimeCommandControls;
  } {
    const credential = this.#ready();
    const controls = this.taskRuntimeCommandControls();
    if (!controls || !expectedSurfaceOwnerKey || controls.surfaceOwnerKey !== expectedSurfaceOwnerKey) {
      throw new Error("The runtime command catalog owner changed. Type the slash command again.");
    }
    return { credential, controls };
  }

  async #revalidateWorkspaceMentionPaths(
    controls: MobileWorkspaceMentionControls,
    draft: MobileComposerDraft
  ): Promise<void> {
    const mentions = draft.mentions.filter((mention) => mention.kind === "workspace");
    const byParent = new Map<string, typeof mentions>();
    for (const mention of mentions) {
      const parent = workspaceParentPath(mention.relativePath);
      byParent.set(parent, [...(byParent.get(parent) ?? []), mention]);
    }
    for (const [parent, expected] of byParent) {
      const directory = await this.listTaskWorkspaceMentionDirectory(controls.surfaceOwnerKey, parent);
      for (const mention of expected) {
        const matches = directory.entries.filter((entry) => entry.relativePath === mention.relativePath);
        const current = matches.length === 1 ? matches[0] : undefined;
        if (!current || current.directory !== mention.directory) {
          throw new Error("A referenced Workspace path disappeared or changed file type. The draft was retained.");
        }
      }
    }
  }

  #sessionRuntimePrecondition(session: Session) {
    const revision = session.version?.revision;
    const generation = session.nativeBinding?.runtimeGeneration;
    if (!revision || revision.value < 1n || !generation || generation < 1n
      || session.version?.generation !== generation) {
      throw new Error("A current task revision and runtime generation are required.");
    }
    return create(OperationPreconditionSchema, {
      entity: create(EntityRefSchema, { kind: EntityKind.SESSION, id: session.sessionId }),
      expectedRevision: revision,
      expectedGeneration: generation
    });
  }

  #assertNoPendingRuntimeControl(sessionId: string): void {
    if (this.#state.pending.some((item) => item.kind === "model-favorite" || item.sessionId === sessionId
      && ["session-model", "session-permission", "session-plan", "session-compact", "session-branch",
        "session-shell", "session-reset", "session-review", "session-clone", "session-fork", "session-side-chat", "session-rewind", "workspace-rewind"].includes(item.kind))) {
      throw new Error("A previous task control change is still pending. Check its operation before changing another setting.");
    }
  }

  #assertNoPendingAppCommand(sessionId: string): void {
    if (this.#state.pending.some((item) => item.sessionId === sessionId
      && ["session-shell", "session-reset", "session-review"].includes(item.kind))) {
      throw new Error("A previous app command is still pending. Check its operation before running another command.");
    }
  }

  #voiceTransport(
    credential: PairedCredential,
    surfaceOwnerKey: string,
    readCurrentOwnerKey: () => string | undefined
  ): MobileVoiceTransport {
    const voiceNetwork = this.ownerNetwork;
    const isCurrent = (): boolean => readCurrentOwnerKey() === surfaceOwnerKey
      && this.#credential?.profileId === credential.profileId
      && this.#credential.connectionId === credential.connectionId
      && this.#credential.deviceId === credential.deviceId
      && this.#credential.serverId === credential.serverId;
    const assertCurrent = (): void => {
      if (!isCurrent()) throw new Error("Voice input authority changed while the microphone was active.");
    };
    const owned = async <T>(effect: () => Promise<T>): Promise<T> => {
      assertCurrent();
      const result = await effect();
      assertCurrent();
      return result;
    };
    const waitUntilCurrent = (signal?: AbortSignal): Promise<boolean> => {
      if (isCurrent()) return Promise.resolve(true);
      if (signal?.aborted || this.#disposed) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        let settled = false;
        let unsubscribe = (): void => undefined;
        const finish = (current: boolean): void => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", aborted);
          unsubscribe();
          resolve(current);
        };
        const aborted = (): void => finish(false);
        signal?.addEventListener("abort", aborted, { once: true });
        const registered = this.subscribe((state) => {
          if (isCurrent()) {
            finish(true);
            return;
          }
          // A permission prompt may temporarily background Android. Only a
          // proven foreground reconnect can resume the microphone request.
          if (!this.#foreground || state.status === "connecting") return;
          finish(false);
        });
        unsubscribe = registered;
        if (settled) registered();
      });
    };
    return {
      profileId: credential.profileId,
      surfaceOwnerKey,
      isCurrent,
      waitUntilCurrent,
      getCapabilities: (signal) => owned(() => voiceNetwork.getVoiceInputCapabilities(credential, signal)),
      getVoiceInputDictionary: (signal) => owned(() => voiceNetwork.getVoiceInputDictionary(credential, signal)),
      applyVoiceInputDictionaryLearning: (revision, actions, signal) => owned(() =>
        voiceNetwork.applyVoiceInputDictionaryLearning(credential, revision, actions, signal)),
      adviseVoiceInputDictionaryEdit: (draft, signal) => owned(() =>
        voiceNetwork.adviseVoiceInputDictionaryEdit(credential, draft, signal)),
      start: async (requestId, mimeType, locale, refinement, signal, recognitionContext) => {
        assertCurrent();
        const session = await (recognitionContext === undefined
          ? voiceNetwork.startVoiceInput(credential, requestId, mimeType, locale, refinement, signal)
          : voiceNetwork.startVoiceInput(credential, requestId, mimeType, locale, refinement, signal, recognitionContext));
        if (!isCurrent() || signal?.aborted) {
          await voiceNetwork.cancelVoiceInput(credential, session.id).catch(() => undefined);
          throw new Error("The voice input owner changed while starting.");
        }
        return session;
      },
      append: (voiceInputId, chunkSequence, audio, durationMs, voiced, signal) => owned(() =>
        voiceNetwork.appendVoiceAudio(
          credential,
          voiceInputId,
          chunkSequence,
          audio,
          durationMs,
          voiced,
          signal
        )),
      stop: (voiceInputId, expectedNextChunkSequence, signal) => owned(() =>
        voiceNetwork.stopVoiceInput(credential, voiceInputId, expectedNextChunkSequence, signal)),
      // Cleanup must retain the initiating credential even after UI authority
      // retires; it can only address this exact connection-owned voice id.
      cancel: (voiceInputId, signal) => voiceNetwork.cancelVoiceInput(credential, voiceInputId, signal),
      get: (voiceInputId, signal) => owned(() => voiceNetwork.getVoiceInputSession(credential, voiceInputId, signal))
    };
  }

  #newTaskAuthorityKey(targetId: string, owner = this.#state.owner): string | undefined {
    const credential = this.#credential;
    if (!credential || !owner || !targetId || !this.#foreground || this.#state.status !== "connected"
      || this.#activeProfileId !== credential.profileId || this.#state.node?.serverId !== credential.serverId
      || owner.server?.serverId !== credential.serverId) return undefined;
    const connection = uniqueValue(owner.connections, (candidate) => candidate.connectionId === credential.connectionId);
    const device = uniqueValue(owner.devices, (candidate) => candidate.deviceId === credential.deviceId);
    const target = uniqueValue(owner.targets, (candidate) => candidate.targetId === targetId);
    const backend = uniqueValue(owner.backends, (candidate) => candidate.backendId === target?.backendId);
    const revision = target?.version?.revision;
    if (!connection || !device || connection.connectionProfileId !== credential.profileId
      || connection.deviceId !== credential.deviceId || connection.state !== ConnectionState.CONNECTED
      || device.kind !== DeviceKind.MOBILE || device.revoked || !device.connectionIds.includes(credential.connectionId)
      || !target || target.state !== TargetState.ACTIVE || !revision || revision.value < 1n
      || !backend || backend.backendId !== target.backendId || !supportsText(backend)) return undefined;
    const workspace = target.workspaceId
      ? uniqueValue(owner.workspaces, (candidate) => candidate.workspaceId === target.workspaceId)
      : undefined;
    if (target.workspaceId && (!workspace || workspace.targetId !== target.targetId)) return undefined;
    return [
      credential.profileId,
      credential.connectionId,
      credential.deviceId,
      credential.serverId,
      entityVersionKey(connection.version),
      entityVersionKey(device.version),
      target.targetId,
      target.backendId,
      entityVersionKey(target.version),
      backendAuthorityKey(backend),
      workspace?.workspaceId ?? "",
      entityVersionKey(workspace?.version)
    ].join("\u001f");
  }

  #taskAuthorityKey(offlinePresentation = false): string | undefined {
    if (this.#joinedTask) {
      const { source, credential, lifetime } = this.#joinedTask, detail = this.#state.detail;
      const session = detail?.sessions[0], share = source.joined.share!, member = source.joined.member!;
      if (lifetime.signal.aborted || credential !== this.#credential || this.#state.taskSource !== source
        || !this.#foreground || this.#state.status !== "connected" || !detail || !session?.nativeBinding?.runtimeGeneration
        || this.#state.owner?.server?.serverId !== credential.serverId || this.#state.activeProfileId !== credential.profileId) return undefined;
      assertMobileSharedTaskSnapshot(source, detail);
      return JSON.stringify(["joined", credential.profileId, credential.connectionId, credential.deviceId, credential.serverId,
        source.joined.joinId, share.hostServerId, share.shareId, share.shareGeneration.toString(), member.memberId,
        member.memberGeneration.toString(), detail.generation.toString(), session.sessionId, session.backendId,
        session.targetId, session.nativeBinding.runtimeGeneration.toString()]);
    }
    const offline = offlinePresentation && this.#hasOfflineProjection()
      && (this.#state.status === "offline" || this.#state.status === "connecting");
    const credential = this.#credential ?? (offline ? this.#profiles.find((item) => item.profileId === this.#activeProfileId) : undefined);
    const owner = this.#state.owner;
    const detail = this.#state.detail;
    const sessionId = this.#state.selectedId;
    if (!credential || !owner || !detail || !sessionId
      || !this.#foreground || (this.#state.status !== "connected" && !offline)
      || (!offline && detail.generation !== owner.generation) || this.#state.activeProfileId !== credential.profileId
      || this.#state.node?.serverId !== credential.serverId
      || owner.server?.serverId !== credential.serverId || detail.server?.serverId !== credential.serverId) return undefined;
    const ownerSessions = owner.sessions.filter((candidate) => candidate.sessionId === sessionId);
    const detailSessions = detail.sessions.filter((candidate) => candidate.sessionId === sessionId);
    const connections = owner.connections.filter((candidate) => candidate.connectionId === credential.connectionId);
    const devices = owner.devices.filter((candidate) => candidate.deviceId === credential.deviceId);
    if (ownerSessions.length !== 1 || detailSessions.length !== 1 || connections.length !== 1 || devices.length !== 1) {
      return undefined;
    }
    const session = detailSessions[0]!;
    const ownerSession = ownerSessions[0]!;
    const connection = connections[0]!;
    const device = devices[0]!;
    const generation = session.nativeBinding?.runtimeGeneration;
    if (!generation || generation < 1n || ownerSession.nativeBinding?.runtimeGeneration !== generation
      || ownerSession.backendId !== session.backendId || ownerSession.targetId !== session.targetId
      || entityVersionKey(ownerSession.version) !== entityVersionKey(session.version)
      || connection.connectionProfileId !== credential.profileId || connection.deviceId !== credential.deviceId
      || connection.state !== ConnectionState.CONNECTED || device.kind !== DeviceKind.MOBILE || device.revoked
      || !device.connectionIds.includes(credential.connectionId)) return undefined;
    const ownerBackends = owner.backends.filter((candidate) => candidate.backendId === session.backendId);
    const detailBackends = detail.backends.filter((candidate) => candidate.backendId === session.backendId);
    const ownerTargets = owner.targets.filter((candidate) => candidate.targetId === session.targetId);
    const detailTargets = detail.targets.filter((candidate) => candidate.targetId === session.targetId);
    if (ownerBackends.length !== 1 || detailBackends.length !== 1 || ownerTargets.length !== 1 || detailTargets.length !== 1) {
      return undefined;
    }
    const backend = ownerBackends[0]!;
    const detailBackend = detailBackends[0]!;
    const target = ownerTargets[0]!;
    const detailTarget = detailTargets[0]!;
    if (target.backendId !== session.backendId || detailTarget.backendId !== session.backendId
      || target.state !== TargetState.ACTIVE || detailTarget.state !== TargetState.ACTIVE
      || entityVersionKey(target.version) !== entityVersionKey(detailTarget.version)
      || backendAuthorityKey(backend) !== backendAuthorityKey(detailBackend)) return undefined;
    return (offline ? `readonly:${this.#state.offlineSnapshotAt}:` : "") + [
      credential.profileId,
      credential.connectionId,
      credential.deviceId,
      credential.serverId,
      owner.generation.toString(10),
      session.sessionId,
      session.backendId,
      session.targetId,
      generation.toString(10),
      entityVersionKey(session.version),
      entityVersionKey(target.version),
      backendAuthorityKey(backend)
    ].join("\u001f");
  }

  #completedMessageEvent(eventId: string): Event | undefined {
    const sessionId = this.#state.selectedId;
    const generation = this.#taskGeneration();
    if (!sessionId || !eventId || !generation) return undefined;
    const events = this.#state.window
      ?? [...this.#state.older, ...(this.#state.detail?.timeline ?? []), ...this.#state.live];
    return events.find((event) => {
      const payload = event.payload?.kind;
      return event.eventId === eventId && event.identity?.sessionId === sessionId
        && event.cursor?.generation === generation
        && ((payload?.case === "messageStarted" && payload.value.role === MessageRole.USER
          && payload.value.userInputAccepted)
          || (payload?.case === "messageCompleted"
            && (payload.value.role === MessageRole.USER || payload.value.role === MessageRole.ASSISTANT)));
    });
  }

  #activeQueueItems(sessionId: string): readonly QueueItem[] {
    return (this.#state.detail?.queueItems ?? []).filter((item) => item.sessionId === sessionId
      && [QueueItemState.ACCEPTED, QueueItemState.DISPATCHING, QueueItemState.BACKEND_ACCEPTED,
        QueueItemState.DISPATCH_UNKNOWN].includes(item.state));
  }

  #queueItem(queueItemId: string): QueueItem | undefined {
    return this.#state.detail?.queueItems.find((item) => item.queueItemId === queueItemId
      && item.sessionId === this.#state.selectedId);
  }

  #queueControl(sessionId: string): QueueControl | undefined {
    const session = this.#selectedSession();
    return this.#state.detail?.queueControls.find((control) => control.sessionId === sessionId
      && control.backendId === session?.backendId && control.targetId === session.targetId);
  }

  #queueItemContext(queueItemId: string) {
    this.#ready();
    const authorityKey = this.#taskAuthorityKey();
    const session = this.#selectedSession();
    const backend = this.#selectedBackend(session);
    const item = this.#queueItem(queueItemId);
    const revision = item?.version?.revision;
    if (item && !this.taskQueueItemOwned(item)) throw new Error("Only your own pending input can be changed.");
    if (!authorityKey || !session || !backend || !item || item.state !== QueueItemState.ACCEPTED
      || item.backendId !== session.backendId || item.targetId !== session.targetId
      || !revision || revision.value < 1n || item.version!.generation < 1n) {
      throw new Error("This queued input is no longer accepted by the current task.");
    }
    return { authorityKey, session, backend, item, capabilities: mobileQueueCapabilities(backend) };
  }

  #queueItemPrecondition(item: QueueItem) {
    const revision = item.version?.revision;
    if (!revision || revision.value < 1n || !item.version || item.version.generation < 1n) {
      throw new Error("A current queued-input version is required.");
    }
    return create(OperationPreconditionSchema, {
      entity: create(EntityRefSchema, { kind: EntityKind.QUEUE_ITEM, id: item.queueItemId }),
      expectedRevision: revision,
      expectedGeneration: item.version.generation
    });
  }

  #queueControlPrecondition(control: QueueControl) {
    const revision = control.version?.revision;
    if (!revision || revision.value < 1n || !control.version || control.version.generation < 1n) {
      throw new Error("A current queue-control version is required.");
    }
    return create(OperationPreconditionSchema, {
      entity: create(EntityRefSchema, { kind: EntityKind.QUEUE_CONTROL, id: control.sessionId }),
      expectedRevision: revision,
      expectedGeneration: control.version.generation
    });
  }

  #interactionContext(interactionId: string): Interaction {
    const interaction = this.taskInteractions().find((candidate) => candidate.interactionId === interactionId);
    if (!interaction) throw new Error("This request is no longer pending in the current task.");
    return interaction;
  }

  #interactionPrecondition(interaction: Interaction) {
    const revision = interaction.version?.revision;
    if (!revision || revision.value < 1n || !interaction.version || interaction.version.generation !== interaction.generation
      || interaction.generation < 1n) {
      throw new Error("A current request version is required.");
    }
    return create(OperationPreconditionSchema, {
      entity: create(EntityRefSchema, { kind: EntityKind.INTERACTION, id: interaction.interactionId }),
      expectedRevision: revision,
      expectedGeneration: interaction.generation
    });
  }

  #interactionReceiptIdentity(interaction: Interaction): Pick<PendingOperation,
    "interactionGeneration" | "interactionRevision" | "interactionDraftKind"> {
    const revision = interaction.version?.revision?.value;
    if (!revision || revision < 1n || interaction.generation < 1n) throw new Error("A current request receipt identity is required.");
    return {
      interactionGeneration: interaction.generation.toString(10),
      interactionRevision: revision.toString(10),
      ...(interaction.request.case === "question" ? { interactionDraftKind: "question" as const }
        : interaction.request.case === "planReview" ? { interactionDraftKind: "plan" as const } : {})
    };
  }

  #assertNoPendingInteractionMutation(sessionId: string, interactionId: string): void {
    if (this.#state.pending.some((item) => item.sessionId === sessionId && item.interactionId === interactionId
      && (item.kind === "interaction-resolve" || item.kind === "interaction-dismiss"))) {
      throw new Error("A previous response to this request is still pending. Check its operation before retrying.");
    }
  }

  #assertNoPendingQueueMutation(sessionId: string, queueItemId: string): void {
    if (this.#state.pending.some((item) => item.sessionId === sessionId
      && (item.queueItemId === queueItemId || item.kind === "queue-interaction-lock")
      && ["queue-cancel", "queue-edit-lock", "queue-edit", "queue-interaction-lock", "queue-reorder"].includes(item.kind))) {
      throw new Error("A previous change to this queued input is still pending. Check its operation before retrying.");
    }
  }

  #assertQueueEditLease(lease: MobileQueueEditLease): void {
    if (this.#queueEditLease !== lease || this.#taskAuthorityKey() !== lease.authorityKey
      || this.#state.selectedId !== lease.sessionId) {
      throw new Error("The queued-input edit lock no longer belongs to the current task.");
    }
  }

  async #releaseQueueEditLease(lease: MobileQueueEditLease): Promise<void> {
    if (this.#queueEditLease !== lease) return;
    if (this.#credential?.connectionId !== lease.connectionId) {
      this.#queueEditLease = undefined;
      return;
    }
    const result = await this.#submitTerminal(create(OperationMutationSchema, {
      payload: { case: "setQueueItemEditLock", value: create(SetQueueItemEditLockMutationSchema, {
        queueItemId: lease.queueItemId,
        lockToken: lease.lockToken,
        locked: false
      }) }
    }), { kind: "queue-edit-lock", sessionId: lease.sessionId, queueItemId: lease.queueItemId });
    if (this.#queueEditLease === lease) this.#queueEditLease = undefined;
    if (!result.accepted && result.definitive) throw new Error("The queued-input edit lock could not be released.");
  }

  async #releaseQueueEditBeforeTransition(): Promise<void> {
    const lease = this.#queueEditLease;
    if (!lease) return;
    try {
      await this.cancelQueueEdit(lease);
    } catch {
      if (this.#queueEditLease === lease) this.#releaseQueueEditLeaseDetached(lease);
    }
  }

  #releaseQueueEditLeaseDetached(lease: MobileQueueEditLease): void {
    if (this.#queueEditLease !== lease) return;
    this.#queueEditLease = undefined;
    this.#submitDetachedQueueEditUnlock(lease);
  }

  #submitDetachedQueueEditUnlock(lease: MobileQueueEditLease): void {
    const credential = this.#credential;
    if (!credential || credential.connectionId !== lease.connectionId) return;
    const pending: PendingOperation = {
      operationId: this.newId(),
      connectionId: lease.connectionId,
      ...(this.#joinedTask ? { taskJoinId: this.#joinedTask.source.joined.joinId } : {}),
      kind: "queue-edit-lock",
      sessionId: lease.sessionId,
      queueItemId: lease.queueItemId,
      state: "unknown"
    };
    const mutation = create(OperationMutationSchema, {
      payload: { case: "setQueueItemEditLock", value: create(SetQueueItemEditLockMutationSchema, {
        queueItemId: lease.queueItemId,
        lockToken: lease.lockToken,
        locked: false
      }) }
    });
    void this.#runDetachedMutation(credential, pending, mutation);
  }

  async #runDetachedMutation(
    credential: PairedCredential,
    pending: PendingOperation,
    mutation: OperationMutation,
    network = this.network
  ): Promise<void> {
    try {
      await this.#writeDetachedPending((items) => items.some((item) => item.operationId === pending.operationId)
        ? items
        : [...items, pending]);
    } catch {
      return;
    }
    let operation: Operation;
    try {
      operation = await network.submit(credential, pending.operationId, mutation);
    } catch {
      return;
    }
    if (!isTerminal(operation.state)) {
      try {
        await this.#writeDetachedPending((items) => items.map((item) => item.operationId === pending.operationId
          ? { ...item, state: "accepted" as const }
          : item));
        operation = await network.waitOperation(credential, pending.operationId);
      } catch {
        return;
      }
    }
    if (!isTerminal(operation.state)) return;
    try {
      await this.#writeDetachedPending((items) => items.filter((item) => item.operationId !== pending.operationId));
    } catch {
      return;
    }
    if (this.#foreground && this.#credential?.connectionId === credential.connectionId
      && this.#joinedTask?.source.joined.joinId === pending.taskJoinId) void this.refresh();
  }

  async #writeDetachedPending(
    update: (items: readonly PendingOperation[]) => readonly PendingOperation[]
  ): Promise<void> {
    const write = this.#pendingWrite.then(async () => {
      const next = [...update(this.#allPending)].slice(-64);
      await this.storage.savePending(next);
      this.#allPending = next;
      const connectionId = this.#credential?.connectionId;
      if (connectionId) {
        this.#set({
          pending: next.filter((item) => item.connectionId === connectionId && item.taskJoinId === this.#joinedTask?.source.joined.joinId),
          saved: this.#savedViews()
        });
      }
    });
    this.#pendingWrite = write.then(() => undefined, () => undefined);
    await write;
  }

  async #releaseQueueInteractionLease(lease: MobileQueueInteractionLease): Promise<void> {
    if (this.#queueInteractionLease !== lease) return;
    if (this.#credential?.connectionId !== lease.credential.connectionId
      || this.#state.selectedId !== lease.sessionId || this.#taskAuthorityKey() !== lease.authorityKey) {
      this.#releaseQueueInteractionLeaseDetached(lease);
      return;
    }
    const result = await this.#submitTerminal(create(OperationMutationSchema, {
      payload: { case: "setQueueInteractionLock", value: create(SetQueueInteractionLockMutationSchema, {
        sessionId: lease.sessionId,
        lockToken: lease.lockToken,
        locked: false
      }) }
    }), { kind: "queue-interaction-lock", sessionId: lease.sessionId });
    if (this.#queueInteractionLease === lease) this.#queueInteractionLease = undefined;
    if (!result.accepted && result.definitive) throw new Error("The queue reorder lock could not be released.");
  }

  #releaseQueueInteractionLeaseDetached(lease: MobileQueueInteractionLease): void {
    if (this.#queueInteractionLease !== lease) return;
    this.#queueInteractionLease = undefined;
    this.#submitDetachedQueueInteractionUnlock(lease);
  }

  #submitDetachedQueueInteractionUnlock(lease: MobileQueueInteractionLease): void {
    const pending: PendingOperation = {
      operationId: this.newId(),
      connectionId: lease.credential.connectionId,
      kind: "queue-interaction-lock",
      sessionId: lease.sessionId,
      state: "unknown"
    };
    const mutation = create(OperationMutationSchema, {
      payload: { case: "setQueueInteractionLock", value: create(SetQueueInteractionLockMutationSchema, {
        sessionId: lease.sessionId,
        lockToken: lease.lockToken,
        locked: false
      }) }
    });
    void this.#runDetachedMutation(lease.credential, pending, mutation);
  }

  #timelineEvents(): readonly Event[] {
    return mobileStateTimelineEvents(this.#state);
  }

  #assertFilesGalleryOpenCurrent(
    context: MobileFilesContext,
    filesEpoch: number,
    taskAuthorityKey: string,
    identity: MobileComposerDraftIdentity,
    source: MobileFilesComposerSource,
    attachmentOwnerKey: string | undefined,
    filesWindowKey: string,
    signal?: AbortSignal
  ): void {
    signal?.throwIfAborted();
    if (!this.#currentFiles(filesEpoch, context.key)
      || this.#taskAuthorityKey() !== taskAuthorityKey
      || this.#state.activeProfileId !== identity.profileId
      || this.#state.selectedId !== identity.sessionId
      || this.taskAttachmentControls()?.surfaceOwnerKey !== attachmentOwnerKey
      || !filesComposerSourceIsCurrent(this.#state.files, source)
      || mobileFilesGalleryWindowKey(this.#state.files) !== filesWindowKey) {
      throw new Error("The Files image source window changed while the gallery was opening.");
    }
  }

  async #assertImageGalleryCurrent(
    lease: MobileImageGalleryLease,
    expectedCommitted: MobileComposerDraft | undefined,
    signal?: AbortSignal
  ): Promise<MobileAttachmentControls | undefined> {
    signal?.throwIfAborted();
    if (lease.cachedOnly) {
      if (expectedCommitted !== undefined || !["timeline", "queue"].includes(lease.source.kind) || !this.imageGalleryCurrent(lease.leaseId)) {
        throw new Error("The saved image gallery no longer owns this history window.");
      }
      return undefined;
    }
    const credential = this.#ready();
    const controls = this.taskAttachmentControls();
    if (this.#imageGallery !== lease || mobileCredentialKey(credential) !== lease.credentialKey
      || credential.profileId !== lease.profileId || this.#taskAuthorityKey() !== lease.taskAuthorityKey
      || this.#state.activeProfileId !== lease.identity.profileId
      || this.#state.selectedId !== lease.identity.sessionId
      || controls?.surfaceOwnerKey !== lease.attachmentOwnerKey) {
      throw new Error("The task, model, or image capability changed while the gallery was open.");
    }
    const source = lease.source;
    if (source.kind === "files") {
      if (!this.#currentFiles(source.filesEpoch, source.filesAuthorityKey)
        || mobileFilesGalleryWindowKey(this.#state.files) !== source.filesWindowKey) {
        throw new Error("The Files image source window changed while the gallery was open.");
      }
    } else if (source.kind === "markdown") {
      await this.#markdownResources.revalidateImages(source.resourceLeaseId, signal ?? new AbortController().signal);
      const currentPages = this.#markdownResources.imagePages(source.resourceLeaseId);
      if (currentPages.length !== lease.pages.length
        || currentPages.some((page, index) => !sameMobileImageGalleryPage(page, lease.pages[index]!))) {
        throw new Error("The message Workspace images changed while the gallery was open.");
      }
    } else if (source.kind === "queue") {
      const pages = this.#queueGalleryPages(source.queueItemId);
      if (pages.length !== lease.pages.length || pages.some((page, index) => !sameMobileImageGalleryPage(page, lease.pages[index]!))) {
        throw new Error("The pending images changed or left the task queue.");
      }
    } else {
      const events = this.#timelineEvents();
      if (mobileTimelineGalleryWindowKey(events) !== source.windowKey) {
        throw new Error("The Timeline source window changed while the gallery was open.");
      }
      const currentPages = timelineGalleryPagesForSelection(events, source.eventId, source.pageId);
      if (currentPages.length !== lease.pages.length
        || currentPages.some((page, index) => !sameMobileImageGalleryPage(page, lease.pages[index]!))) {
        throw new Error("The durable Timeline images changed while the gallery was open.");
      }
    }
    const snapshot = await this.composerDrafts!.readSnapshot(lease.identity);
    signal?.throwIfAborted();
    if (this.#imageGallery !== lease) throw new Error("The image gallery was closed before the operation completed.");
    const current = normalizeMobileComposerDraft(snapshot.draft ?? {
      text: "", mentions: [], atoms: [], slashCommands: [], attachments: []
    });
    if (expectedCommitted === undefined) {
      if (snapshot.revision !== lease.snapshot.revision || !mobileComposerDraftsEqual(current, lease.draft)) {
        throw new Error("The task composer changed while the image gallery was open.");
      }
    } else if (!mobileComposerDraftsEqual(current, expectedCommitted)) {
      throw new Error("The task composer changed while the gallery image was being saved.");
    }
    if (controls) assertMobileAttachmentPolicy(current.attachments, controls.policy);
    return controls;
  }

  async #revalidateGalleryImageSource(lease: MobileImageGalleryLease, loaded: Pick<NonNullable<MobileImageGalleryLease["loaded"]>, "page">, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (lease.source.kind === "markdown") return; // The resource owner revalidates its exact message and Workspace revision above.
    const page = loaded.page; const source = page.source; const credential = this.#ready();
    if (lease.source.kind === "queue") {
      await this.#revalidateQueueImage(credential, lease.identity.sessionId, page, () => {
        if (!this.imageGalleryCurrent(lease.leaseId)) throw new Error("The pending image source changed.");
      }, signal);
      return;
    }
    if (lease.source.kind === "files") {
      const context = this.#filesContext();
      if (context.key !== lease.source.filesAuthorityKey) throw new Error("The Files image authority changed.");
      if (source.kind === "artifact") {
        const artifacts = await this.network.listSessionArtifacts(credential, source.sessionId, signal);
        const matches = artifacts.artifacts.filter((item) => item.artifactId === source.artifactId && item.sessionId === source.sessionId);
        if (artifacts.revision !== this.#state.files.artifactsRevision || matches.length !== 1
          || !matches[0]?.blob || !sameFilesComposerBlob(matches[0].blob, page.blob)) throw new Error("The Generated image changed before system sharing began.");
      } else if (source.kind === "workspace") {
        const path = source.relativePath;
        const directory = await this.network.listWorkspaceDirectory(credential, context.authority.workspace.workspaceId, workspaceParentPath(path), signal);
        const matches = directory.entries.filter((item) => item.workspaceId === context.authority.workspace.workspaceId && item.relativePath === path);
        const entry = matches.length === 1 ? matches[0] : undefined;
        if (!entry?.revision || entry.kind !== FileKind.REGULAR || workspaceEntryRevisionKey(entry.revision) !== source.revisionKey
          || normalizeMediaType(entry.mediaType) !== page.mediaType) throw new Error("The Workspace image changed before system sharing began.");
        const preview = await this.#canonicalWorkspaceImagePreview(credential, entry.workspaceId,
          await this.network.readWorkspaceFile(credential, entry.workspaceId, path, entry.revision, signal), signal);
        const blob = workspaceComposerBlob(entry.workspaceId, entry, preview);
        if (!blob || !sameFilesComposerBlob(blob, page.blob)) throw new Error("The Workspace image Blob changed before system sharing began.");
      } else throw new Error("The Files gallery returned an invalid source identity.");
    } else {
      if (!("eventId" in source)) throw new Error("The Timeline image returned an invalid source identity.");
      const around = await this.network.readAround(credential, lease.identity.sessionId, source.eventId, signal);
      const matches = around.filter((event) => event.eventId === source.eventId && event.identity?.sessionId === lease.identity.sessionId
        && event.cursor?.generation === this.#taskGeneration());
      const current = matches.length === 1 ? timelineGalleryPagesForSelection(around, source.eventId, page.pageId).find((item) => item.pageId === page.pageId) : undefined;
      if (!current || !sameMobileImageGalleryPage(current, page)) throw new Error("The Timeline image changed before system sharing began.");
    }
    signal.throwIfAborted();
  }

  async #commitImageGalleryPage(
    galleryLeaseId: string,
    loadId: string,
    strokes: readonly MobileImageAnnotationStroke[],
    burned: MobileBurnedImage | undefined,
    signal?: AbortSignal
  ): Promise<MobileComposerDraft> {
    signal?.throwIfAborted();
    const lease = this.#imageGallery;
    const loaded = lease?.loaded;
    if (!lease || lease.leaseId !== galleryLeaseId || !loaded || loaded.loadId !== loadId
      || !loaded.confirmed || !this.attachmentFiles || !this.composerDrafts) {
      throw new Error("The decoded gallery image no longer owns this composer action.");
    }
    if (lease.operationInFlight) throw new Error("This gallery image is already being added to the composer.");
    const exactStrokes = normalizeMobileAnnotationStrokes(strokes);
    const controls = await this.#assertImageGalleryCurrent(lease, undefined, signal);
    if (!controls || controls.surfaceOwnerKey !== lease.attachmentOwnerKey) {
      throw new Error("The current model no longer accepts image attachments.");
    }
    const originalMetadata = filesAttachmentMetadata(
      loaded.page.blob.fileName || loaded.page.title,
      loaded.page.mediaType,
      BigInt(loaded.page.byteSize),
      lease.draft.attachments,
      controls
    );
    if (!originalMetadata
      && (!mobileImageRequiresNativeRaster(loaded.page.mediaType) || exactStrokes.length === 0)) {
      throw new Error("This gallery image no longer fits the current attachment policy.");
    }
    const originalFileName = originalMetadata?.fileName
      ?? mobileImageOutputFileName(loaded.page.blob.fileName || loaded.page.title, loaded.page.mediaType);
    const originalMediaType = originalMetadata?.mediaType ?? loaded.page.mediaType;
    if (this.#imageGallery !== lease || lease.operationInFlight) {
      throw new Error("This gallery image is already being added or no longer owns the composer.");
    }
    lease.operationInFlight = true;
    try {
      let outputBytes = Uint8Array.from(loaded.bytes);
      let outputMediaType: string = originalMediaType;
      let outputFileName = originalFileName;
      let outputSha256Hex = loaded.page.sha256Hex;
      if (exactStrokes.length > 0) {
        if (loaded.decoded.animated || loaded.decoded.originalOnly || !canAnnotateMobileImage(loaded.page.mediaType) || !burned) {
          throw new Error("This gallery image cannot be rendered with annotations.");
        }
        const expectedMediaType = mobileAnnotationOutputMediaType(loaded.page.mediaType);
        if (!(burned.bytes instanceof Uint8Array) || burned.bytes.byteLength < 1
          || burned.mediaType !== expectedMediaType
          || sniffMobileImageMediaType(burned.bytes) !== expectedMediaType
          || !Number.isSafeInteger(burned.width) || burned.width < 1
          || burned.width > MOBILE_ANNOTATION_MAX_BURN_DIMENSION
          || !Number.isSafeInteger(burned.height) || burned.height < 1
          || burned.height > MOBILE_ANNOTATION_MAX_BURN_DIMENSION) {
          throw new Error("The rendered gallery annotation output is invalid.");
        }
        outputBytes = Uint8Array.from(burned.bytes);
        outputMediaType = burned.mediaType;
        outputFileName = mobileAnnotatedImageFileName(originalFileName, burned.mediaType);
        outputSha256Hex = await this.attachmentFiles.digestOwnedBytes(outputBytes, signal);
      }
      assertMobileAttachmentCandidate({
        fileName: outputFileName,
        mediaType: outputMediaType,
        byteSize: outputBytes.byteLength
      }, controls.policy);

      const source: MobileComposerImageAnnotationSource | undefined = exactStrokes.length === 0 ? undefined : {
        storageId: distinctAttachmentStorageId(
          this.newId,
          ...mobileComposerAttachmentStorageIds(lease.draft.attachments)
        ),
        fileName: originalFileName,
        mediaType: originalMediaType,
        byteSize: loaded.page.byteSize,
        sha256Hex: loaded.page.sha256Hex,
        capturedAtUnixMs: this.now()
      };
      let sourceStaged = false;
      let output: MobileLocalComposerAttachment | undefined;
      let nextDraft: MobileComposerDraft | undefined;
      let committed = false;
      try {
        if (source) {
          await this.attachmentFiles.stageOwnedBytes(
            lease.profileId,
            source.storageId,
            loaded.bytes,
            source.sha256Hex,
            signal
          );
          sourceStaged = true;
        }
        output = await this.attachmentFiles.stageVerifiedBytes(
          lease.profileId,
          lease.draft.attachments,
          controls.policy,
          {
            bytes: outputBytes,
            fileName: outputFileName,
            mediaType: outputMediaType,
            byteSize: outputBytes.byteLength,
            sha256Hex: outputSha256Hex
          },
          () => distinctAttachmentStorageId(
            this.newId,
            ...mobileComposerAttachmentStorageIds(lease.draft.attachments),
            ...(source ? [source.storageId] : [])
          ),
          signal
        );
        const attachment = normalizeMobileComposerAttachment(source ? {
          ...output,
          annotation: { source, strokes: exactStrokes }
        } : output);
        nextDraft = normalizeMobileComposerDraft({
          ...lease.draft,
          attachments: appendMobileComposerAttachments(lease.draft.attachments, [attachment], controls.policy)
        });
        await this.#assertImageGalleryCurrent(lease, undefined, signal);
        if (!this.composerDrafts.saveIfRevision(lease.identity, nextDraft, lease.snapshot.revision)) {
          throw new Error("The task composer changed while the gallery image was being added.");
        }
        committed = true;
        await this.composerDrafts.flush(lease.identity);
        await this.#assertImageGalleryCurrent(lease, nextDraft, signal);
        this.#retireImageGallery();
        return nextDraft;
      } catch (error) {
        if (committed && nextDraft) committed = !await this.#restoreFilesComposerDraft(lease.identity, lease.snapshot, nextDraft);
        if (!committed && output) {
          await this.attachmentFiles.removeVisibleBytes(lease.profileId, output).catch(() => undefined);
        }
        if (!committed && sourceStaged && source) {
          await this.attachmentFiles.removeOwnedBytes(lease.profileId, source.storageId).catch(() => undefined);
        }
        if (committed) this.#retireImageGallery();
        throw error;
      }
    } finally {
      if (this.#imageGallery === lease) lease.operationInFlight = false;
    }
  }

  #filesAuthorityKey(state: MobileState): string | undefined {
    const credential = this.#credential;
    if (!this.#foreground || !credential || state.activeProfileId !== credential.profileId
      || state.origin !== credential.origin || state.node?.serverId !== credential.serverId) return undefined;
    const authority = resolveMobileWorkspaceAuthority(state.owner, state.detail, state.selectedId);
    if (!authority) return undefined;
    return [credential.profileId, credential.connectionId, credential.deviceId, credential.serverId, authority.key].join("\u001f");
  }

  #filesContext(): MobileFilesContext {
    const credential = this.#credential;
    const authority = resolveMobileWorkspaceAuthority(this.#state.owner, this.#state.detail, this.#state.selectedId);
    const key = this.#filesAuthorityKey(this.#state);
    if (!credential || !authority || !key || this.#state.status !== "connected" || !this.#foreground) {
      throw new Error("Reconnect to the current task before reading its Files.");
    }
    return { credential, authority, key };
  }

  #currentFiles(epoch: number, key: string): boolean {
    return !this.#disposed && this.#foreground && this.#state.status === "connected"
      && this.#filesEpoch === epoch && this.#state.files.open
      && this.#state.files.authorityKey === key && this.#filesAuthorityKey(this.#state) === key;
  }

  #fileShareLeaseCurrent(lease: MobileFileShareLease): boolean {
    if (this.#fileShareLease !== lease || lease.controller.signal.aborted || this.#disposed
      || !this.#foreground || this.#credential?.profileId !== lease.profileId
      || this.#state.selectedId !== lease.sessionId
      || this.#taskAuthorityKey() !== lease.taskAuthorityKey) return false;
    if (lease.kind === "files") {
      return this.#currentFiles(lease.filesEpoch, lease.filesAuthorityKey)
        && filesComposerSourceIsCurrent(this.#state.files, lease.source);
    }
    const events = this.#timelineEvents();
    if (mobileTimelineArtifactWindowKey(events) !== lease.windowKey) return false;
    const source = resolveMobileTimelineArtifact(events, lease.artifact);
    return source !== undefined
      && source.event.identity?.sessionId === lease.sessionId
      && source.event.cursor?.generation === this.#taskGeneration()
      && sameMobileTimelineArtifact(source.artifact, lease.artifact);
  }

  #assertFileShareLeaseCurrent(lease: MobileFileShareLease, signal: AbortSignal): void {
    signal.throwIfAborted();
    if (!this.#fileShareLeaseCurrent(lease) || lease.phase !== "preparing") {
      throw new Error("The selected file changed before system sharing began.");
    }
  }

  #cancelPreparingFileShare(kind?: MobileFileShareLease["kind"]): void {
    const lease = this.#fileShareLease;
    if (lease?.phase === "preparing" && (kind === undefined || lease.kind === kind)) {
      lease.controller.abort();
    }
  }

  async #revalidateWorkspaceShareEntry(
    context: MobileFilesContext,
    source: MobileFilesComposerSource,
    signal: AbortSignal
  ): Promise<WorkspaceEntry> {
    this.#assertFilesShareSourceCurrent(context, source, signal);
    let selectedPath: string;
    if (source.kind === "workspace-entry") selectedPath = source.entry.relativePath;
    else {
      const result = source.kind === "search-result" ? source.result : undefined;
      if (!result || result.kind === "artifact") {
        throw new Error("Select a regular Workspace file before sharing it.");
      }
      selectedPath = result.kind === "workspace-content" ? result.match.relativePath : result.relativePath;
    }
    const path = canonicalWorkspacePath(selectedPath);
    const directory = await this.network.listWorkspaceDirectory(
      context.credential,
      context.authority.workspace.workspaceId,
      workspaceParentPath(path),
      signal
    );
    this.#assertFilesShareSourceCurrent(context, source, signal);
    if (!directory.revision) throw new Error("The Joko node returned an unfenced Workspace directory.");
    const matches = directory.entries.filter((candidate) => candidate.relativePath === path);
    const entry = matches.length === 1 ? matches[0] : undefined;
    if (!entry?.revision || entry.kind !== FileKind.REGULAR
      || entry.workspaceId !== context.authority.workspace.workspaceId
      || entry.revision.byteSize < 0n
      || entry.revision.byteSize > BigInt(MOBILE_FILE_SHARE_MAXIMUM_BYTES)) {
      throw new Error("The selected Workspace file is unavailable or exceeds the mobile sharing limit.");
    }
    workspaceEntryRevisionKey(entry.revision);
    if (source.kind === "workspace-entry" && !sameFilesWorkspaceEntry(entry, source.entry)) {
      throw new Error("The selected Workspace file changed before it could be shared.");
    }
    if (source.kind === "search-result" && source.result.kind === "workspace-name"
      && !this.#state.files.fileIndex.includes(path)) {
      throw new Error("The selected Workspace file is no longer in the current file index.");
    }
    if (source.kind === "search-result" && source.result.kind === "workspace-content") {
      const revision = source.result.match.revision;
      if (!revision || workspaceEntryRevisionKey(revision) !== workspaceEntryRevisionKey(entry.revision)) {
        throw new Error("The selected Workspace search result changed before it could be shared.");
      }
    }
    return this.#filesPreviewOriginalEntry(source, entry);
  }

  #assertFilesShareSourceCurrent(
    context: MobileFilesContext,
    source: MobileFilesComposerSource,
    signal: AbortSignal
  ): void {
    signal.throwIfAborted();
    const lease = this.#fileShareLease;
    if (!lease || lease.kind !== "files" || lease.source !== source
      || !this.#currentFiles(lease.filesEpoch, context.key)
      || this.#taskAuthorityKey() !== lease.taskAuthorityKey
      || !filesComposerSourceIsCurrent(this.#state.files, source)) {
      throw new Error("Files authority changed before system sharing began.");
    }
  }

  async #revalidateGeneratedShareArtifact(
    context: MobileFilesContext,
    expected: Artifact,
    observedRevision: string,
    signal: AbortSignal
  ): Promise<Artifact> {
    signal.throwIfAborted();
    if (expected.sessionId !== context.authority.sessionId || !expected.blob
      || expected.blob.byteSize < 0n
      || expected.blob.byteSize > BigInt(MOBILE_FILE_SHARE_MAXIMUM_BYTES)) {
      throw new Error("The selected Generated file is unavailable or exceeds the mobile sharing limit.");
    }
    const refreshed = await this.network.listSessionArtifacts(
      context.credential,
      context.authority.sessionId,
      signal
    );
    signal.throwIfAborted();
    if (refreshed.revision !== observedRevision) {
      throw new Error("The Generated catalog changed before system sharing began. Refresh Files and try again.");
    }
    const matches = refreshed.artifacts.filter((candidate) => candidate.artifactId === expected.artifactId
      && candidate.sessionId === expected.sessionId);
    const current = matches.length === 1 ? matches[0] : undefined;
    if (!current?.blob || !sameFilesComposerArtifact(current, expected)) {
      throw new Error("The selected Generated file changed before system sharing began.");
    }
    return current;
  }

  async #revalidateTimelineShareArtifact(
    credential: PairedCredential,
    lease: Extract<MobileFileShareLease, { readonly kind: "timeline" }>,
    expectedBlob: BlobRef,
    signal: AbortSignal
  ): Promise<void> {
    this.#assertFileShareLeaseCurrent(lease, signal);
    const around = await this.network.readAround(credential, lease.sessionId, lease.artifact.eventId, signal);
    this.#assertFileShareLeaseCurrent(lease, signal);
    const source = resolveMobileTimelineArtifact(around, lease.artifact);
    if (!source || source.event.identity?.sessionId !== lease.sessionId
      || source.event.cursor?.generation !== this.#taskGeneration()
      || !sameMobileTimelineArtifact(source.artifact, lease.artifact)
      || !sameFilesComposerBlob(source.blob, expectedBlob)) {
      throw new Error("The selected Timeline file changed before system sharing began.");
    }
  }

  #assertFilesComposerLease(
    context: MobileFilesContext,
    epoch: number,
    taskAuthorityKey: string,
    identity: MobileComposerDraftIdentity,
    source: MobileFilesComposerSource,
    attachmentOwnerKey: string | undefined,
    workspaceOwnerKey: string | undefined,
    catalogOwnerKey: string | undefined,
    signal?: AbortSignal
  ): void {
    signal?.throwIfAborted();
    if (!this.#currentFiles(epoch, context.key)
      || this.#taskAuthorityKey() !== taskAuthorityKey
      || this.#state.activeProfileId !== identity.profileId
      || this.#state.selectedId !== identity.sessionId
      || this.taskAttachmentControls()?.surfaceOwnerKey !== attachmentOwnerKey
      || this.taskWorkspaceMentionControls()?.surfaceOwnerKey !== workspaceOwnerKey
      || this.taskCatalogMentionControls()?.surfaceOwnerKey !== catalogOwnerKey
      || !filesComposerSourceIsCurrent(this.#state.files, source)) {
      throw new Error("Files-to-composer authority changed before the item could be added. The original draft was retained.");
    }
  }

  async #workspaceFilesComposerDraft(
    context: MobileFilesContext,
    epoch: number,
    taskAuthorityKey: string,
    identity: MobileComposerDraftIdentity,
    source: MobileFilesComposerSource,
    draft: MobileComposerDraft,
    attachmentControls: MobileAttachmentControls | undefined,
    workspaceControls: MobileWorkspaceMentionControls | undefined,
    catalogOwnerKey: string | undefined,
    signal?: AbortSignal
  ): Promise<{
    readonly draft: MobileComposerDraft;
    readonly result: MobileFilesComposerResult;
    readonly staged?: MobileLocalComposerAttachment;
  }> {
    const attachmentOwnerKey = attachmentControls?.surfaceOwnerKey;
    const workspaceOwnerKey = workspaceControls?.surfaceOwnerKey;
    const assertCurrent = (): void => this.#assertFilesComposerLease(
      context, epoch, taskAuthorityKey, identity, source,
      attachmentOwnerKey, workspaceOwnerKey, catalogOwnerKey, signal
    );
    const entry = await this.#resolveFilesComposerWorkspaceEntry(context, source, signal);
    assertCurrent();
    const path = canonicalWorkspacePath(entry.relativePath);
    if (entry.workspaceId !== context.authority.workspace.workspaceId
      || entry.kind !== FileKind.REGULAR && entry.kind !== FileKind.DIRECTORY) {
      throw new Error("The selected Workspace item is outside the current Files owner.");
    }

    if (entry.kind === FileKind.REGULAR && entry.revision && attachmentControls && this.attachmentFiles
      && filesAttachmentMetadata(
        entry.displayName || workspaceBasename(path),
        entry.mediaType,
        entry.revision.byteSize,
        draft.attachments,
        attachmentControls
      )) {
      const original = this.#filesPreviewOriginalEntry(source, entry);
      const preview = await this.network.readWorkspaceFile(
        context.credential,
        context.authority.workspace.workspaceId,
        path,
        original.revision!,
        signal
      );
      assertCurrent();
      const blob = workspaceComposerBlob(context.authority.workspace.workspaceId, original, preview);
      if (blob) {
        const metadata = filesAttachmentMetadata(
          blob.fileName || entry.displayName || workspaceBasename(path),
          blob.mediaType,
          blob.byteSize,
          draft.attachments,
          attachmentControls
        );
        if (metadata) {
          const download = await this.network.downloadBlob(context.credential, blob, signal);
          assertCurrent();
          if (normalizeMediaType(download.mediaType) !== metadata.mediaType) {
            throw new Error("The authenticated Workspace Blob download changed media type.");
          }
          const staged = await this.attachmentFiles.stageVerifiedBytes(
            identity.profileId,
            draft.attachments,
            attachmentControls.policy,
            {
              ...metadata,
              bytes: download.bytes,
              sha256Hex: blob.sha256Hex
            },
            this.newId,
            signal
          );
          return {
            draft: {
              ...draft,
              attachments: appendMobileComposerAttachments(draft.attachments, [staged], attachmentControls.policy)
            },
            result: "attachment",
            staged
          };
        }
      }
    }

    if (!workspaceControls) {
      throw new Error("This Backend cannot add the selected Workspace item as an attachment or typed reference.");
    }
    const candidate = await this.#validateFilesWorkspaceReference(
      context,
      workspaceControls,
      entry,
      signal
    );
    assertCurrent();
    const insertion = insertMobileWorkspaceMention(
      draft,
      { start: draft.text.length, end: draft.text.length },
      candidate,
      this.newId()
    );
    return { draft: insertion.draft, result: "reference" };
  }

  async #artifactFilesComposerDraft(
    context: MobileFilesContext,
    epoch: number,
    taskAuthorityKey: string,
    identity: MobileComposerDraftIdentity,
    source: MobileFilesComposerSource,
    artifact: Artifact,
    draft: MobileComposerDraft,
    attachmentControls: MobileAttachmentControls | undefined,
    workspaceOwnerKey: string | undefined,
    catalogControls: MobileCatalogMentionControls | undefined,
    signal?: AbortSignal
  ): Promise<{
    readonly draft: MobileComposerDraft;
    readonly result: MobileFilesComposerResult;
    readonly staged?: MobileLocalComposerAttachment;
  }> {
    const attachmentOwnerKey = attachmentControls?.surfaceOwnerKey;
    const catalogOwnerKey = catalogControls?.surfaceOwnerKey;
    const assertCurrent = (): void => this.#assertFilesComposerLease(
      context, epoch, taskAuthorityKey, identity, source,
      attachmentOwnerKey, workspaceOwnerKey, catalogOwnerKey, signal
    );
    if (artifact.sessionId !== context.authority.sessionId) {
      throw new Error("The selected Generated file is outside the current task.");
    }
    const blob = artifact.blob;
    if (blob && attachmentControls && this.attachmentFiles
      && filesAttachmentMetadata(
        blob.fileName || artifactTitle(artifact),
        blob.mediaType,
        blob.byteSize,
        draft.attachments,
        attachmentControls
      )) {
      const observedRevision = this.#state.files.artifactsRevision;
      if (!observedRevision) throw new Error("The current Generated catalog is not revision-fenced.");
      const refreshed = await this.network.listSessionArtifacts(
        context.credential,
        context.authority.sessionId,
        signal
      );
      assertCurrent();
      if (refreshed.revision !== observedRevision) {
        throw new Error("The Generated catalog changed while the file was being added. Refresh Files and try again.");
      }
      const matches = refreshed.artifacts.filter((candidate) => candidate.artifactId === artifact.artifactId
        && candidate.sessionId === artifact.sessionId);
      const current = matches.length === 1 ? matches[0] : undefined;
      if (!current || !sameFilesComposerArtifact(current, artifact) || !current.blob) {
        throw new Error("The selected Generated file changed while it was being added.");
      }
      const metadata = filesAttachmentMetadata(
        current.blob.fileName || artifactTitle(current),
        current.blob.mediaType,
        current.blob.byteSize,
        draft.attachments,
        attachmentControls
      );
      if (!metadata) {
        throw new Error("The selected Generated file no longer matches the current attachment capability.");
      }
      const download = await this.network.downloadBlob(context.credential, current.blob, signal);
      assertCurrent();
      if (normalizeMediaType(download.mediaType) !== metadata.mediaType) {
        throw new Error("The authenticated Generated Blob download changed media type.");
      }
      const staged = await this.attachmentFiles.stageVerifiedBytes(
        identity.profileId,
        draft.attachments,
        attachmentControls.policy,
        {
          ...metadata,
          bytes: download.bytes,
          sha256Hex: current.blob.sha256Hex
        },
        this.newId,
        signal
      );
      return {
        draft: {
          ...draft,
          attachments: appendMobileComposerAttachments(draft.attachments, [staged], attachmentControls.policy)
        },
        result: "attachment",
        staged
      };
    }

    if (!catalogControls?.policy.artifacts) {
      throw new Error("This Backend cannot add the selected Generated file as an attachment or typed reference.");
    }
    const catalog = await this.listTaskCatalogMentionCatalog(catalogControls.surfaceOwnerKey, signal);
    assertCurrent();
    const matches = (catalog.artifacts?.items ?? []).filter((candidate) => candidate.artifactId === artifact.artifactId
      && candidate.sourceSessionId === artifact.sessionId);
    if (matches.length !== 1) {
      throw new Error("The selected Generated file is no longer available in the current Artifact reference catalog.");
    }
    const expected = projectMobileArtifactMentionCatalog(
      catalogControls,
      [artifact],
      catalog.artifacts!.revision
    ).items[0];
    if (!expected || !sameFilesComposerArtifactCandidate(matches[0]!, expected)) {
      throw new Error("The selected Generated file changed before its typed reference could be added.");
    }
    const candidate = assertMobileCatalogMentionCandidate(catalogControls, catalog, matches[0]!);
    if (candidate.kind !== "artifact") {
      throw new Error("The selected Generated file resolved to a non-Artifact reference.");
    }
    const insertion = insertMobileArtifactMention(
      draft,
      { start: draft.text.length, end: draft.text.length },
      candidate,
      this.newId()
    );
    return { draft: insertion.draft, result: "reference" };
  }

  #filesPreviewOriginalEntry(source: MobileFilesComposerSource, observed: WorkspaceEntry): WorkspaceEntry {
    const lease = this.#filesPreviewPager;
    if (!lease || !this.#filesPreviewPagerCurrent(lease) || lease.descriptor.pages[lease.descriptor.index]?.source !== source || !lease.original) return observed;
    const original = lease.original;
    if (!original.revision || !observed.revision || original.relativePath !== observed.relativePath || original.workspaceId !== observed.workspaceId
      || normalizeMediaType(original.mediaType) !== normalizeMediaType(observed.mediaType) || !workspaceComposerRevisionMatches(observed.revision, original.revision)) {
      throw new Error("The visible original file changed before its action began.");
    }
    return { ...observed, revision: original.revision };
  }

  async #resolveFilesComposerWorkspaceEntry(
    context: MobileFilesContext,
    source: MobileFilesComposerSource,
    signal?: AbortSignal
  ): Promise<WorkspaceEntry> {
    if (source.kind === "workspace-entry") {
      const entry = source.entry;
      canonicalWorkspacePath(entry.relativePath);
      if (entry.kind === FileKind.REGULAR) workspaceEntryRevisionKey(entry.revision);
      return entry;
    }
    if (source.kind !== "search-result" || source.result.kind === "artifact") {
      throw new Error("Select a current Workspace item before adding it to the composer.");
    }
    const path = canonicalWorkspacePath(
      source.result.kind === "workspace-content" ? source.result.match.relativePath : source.result.relativePath
    );
    if (source.result.kind === "workspace-name" && !this.#state.files.fileIndex.includes(path)) {
      throw new Error("The selected file is no longer in the current Workspace index.");
    }
    const directory = await this.network.listWorkspaceDirectory(
      context.credential,
      context.authority.workspace.workspaceId,
      workspaceParentPath(path),
      signal
    );
    if (!directory.revision) throw new Error("The Joko node returned an unfenced Workspace directory.");
    const matches = directory.entries.filter((candidate) => candidate.relativePath === path);
    const entry = matches.length === 1 ? matches[0] : undefined;
    if (!entry?.revision || entry.kind !== FileKind.REGULAR
      || entry.workspaceId !== context.authority.workspace.workspaceId) {
      throw new Error("The selected Workspace file is no longer available at its observed path.");
    }
    workspaceEntryRevisionKey(entry.revision);
    if (source.result.kind === "workspace-content") {
      const observed = source.result.match.revision;
      if (!observed || workspaceEntryRevisionKey(observed) !== workspaceEntryRevisionKey(entry.revision)) {
        throw new Error("The Workspace search result changed before it could be added.");
      }
    }
    return entry;
  }

  async #validateFilesWorkspaceReference(
    context: MobileFilesContext,
    controls: MobileWorkspaceMentionControls,
    observed: WorkspaceEntry,
    signal?: AbortSignal
  ): Promise<MobileWorkspaceMentionCandidate> {
    const path = canonicalWorkspacePath(observed.relativePath);
    const directory = await this.network.listWorkspaceDirectory(
      context.credential,
      controls.workspaceId,
      workspaceParentPath(path),
      signal
    );
    const rawMatches = directory.entries.filter((entry) => entry.relativePath === path);
    const current = rawMatches.length === 1 ? rawMatches[0] : undefined;
    if (!current || current.workspaceId !== observed.workspaceId || current.kind !== observed.kind) {
      throw new Error("The selected Workspace item is no longer available with the same file type.");
    }
    if (observed.kind === FileKind.REGULAR) {
      if (!observed.revision || !current.revision
        || workspaceEntryRevisionKey(observed.revision) !== workspaceEntryRevisionKey(current.revision)) {
        throw new Error("The selected Workspace file changed before its typed reference could be added.");
      }
    }
    const projected = projectMobileWorkspaceMentionDirectory(
      controls,
      workspaceParentPath(path),
      directory.entries,
      directory.revision
    );
    const matches = projected.entries.filter((entry) => entry.relativePath === path);
    if (matches.length !== 1) {
      throw new Error("The selected Workspace item is no longer available as a typed reference.");
    }
    return assertMobileWorkspaceMentionCandidate(controls, matches[0]!);
  }

  async #restoreFilesComposerDraft(
    identity: MobileComposerDraftIdentity,
    snapshot: MobileComposerDraftSnapshot,
    committed: MobileComposerDraft
  ): Promise<boolean> {
    if (!this.composerDrafts) return false;
    try {
      const current = await this.composerDrafts.readSnapshot(identity);
      if (!current.draft || !mobileComposerDraftsEqual(current.draft, committed)) return false;
      const restored = snapshot.draft
        ? this.composerDrafts.saveIfRevision(identity, snapshot.draft, current.revision)
        : await this.composerDrafts.clearIfRevision(identity, current.revision);
      if (!restored) return false;
      await this.composerDrafts.flush(identity);
      return true;
    } catch {
      return false;
    }
  }

  #cancelFilesRequests(): void {
    this.#retireFilesPreviewPager();
    if (this.#imageGallery?.source.kind === "files") this.#retireImageGallery();
    this.#cancelPreparingFileShare("files");
    void this.#releaseFilesBinaryPreviews().catch(() => undefined);
    this.#filesEpoch += 1;
    this.#filesListAbort?.abort();
    this.#filesSearchAbort?.abort();
    this.#filesPreviewAbort?.abort();
    this.#filesWatchAbort?.abort();
    this.#filesListAbort = undefined;
    this.#filesSearchAbort = undefined;
    this.#filesPreviewAbort = undefined;
    this.#filesWatchAbort = undefined;
    if (this.#filesRefreshTimer !== undefined) clearTimeout(this.#filesRefreshTimer);
    this.#filesRefreshTimer = undefined;
  }

  #timelinePreviewSourceCurrent(lease: MobileTimelinePreviewLease, state: MobileState): boolean {
    if (state.status !== "connected" || state.activeProfileId !== lease.profileId
      || state.selectedId !== lease.sessionId) return false;
    const events = mobileStateTimelineEvents(state);
    if (mobileTimelinePreviewWindowKey(events) !== lease.windowKey) return false;
    if (lease.extensionCard) return this.#extensionCardSource(state, lease.extensionCard.id)?.html === lease.extensionCard.html;
    if (!lease.artifact) return false;
    const source = resolveMobileTimelinePreviewArtifact(events, lease.artifact);
    return source !== undefined
      && source.event.identity?.sessionId === lease.sessionId
      && source.event.cursor?.generation === state.owner?.generation
      && sameMobileTimelinePreviewArtifact(source.artifact, lease.artifact);
  }
  #extensionCardSource(state: MobileState, cardId: string) {
    for (const event of [...mobileStateTimelineEvents(state)].reverse()) {
      const kind = event.payload?.kind;
      if (kind?.case === "extensionCardChanged" && kind.value.card?.cardId === cardId
        && event.identity?.sessionId === state.selectedId && event.cursor?.generation === state.owner?.generation) return kind.value.card;
    }
    return undefined;
  }

  #timelinePreviewLeaseCurrent(lease: MobileTimelinePreviewLease): boolean {
    return this.#timelinePreview === lease && !lease.controller.signal.aborted
      && this.#foreground && this.#credential?.profileId === lease.profileId
      && this.#taskAuthorityKey() === lease.taskAuthorityKey
      && this.#timelinePreviewSourceCurrent(lease, this.#state);
  }

  #cancelTimelinePreviewLease(): void {
    const lease = this.#timelinePreview;
    if (!lease) return;
    this.#timelinePreview = undefined;
    lease.controller.abort();
    void this.#releaseTimelinePreviewLease(lease).catch(() => undefined);
  }

  async #releaseTimelinePreviewLease(lease: MobileTimelinePreviewLease): Promise<void> {
    const media = lease.media;
    const pdf = lease.pdf;
    const model = lease.model;
    lease.media = undefined;
    lease.pdf = undefined;
    lease.model = undefined;
    await Promise.all([
      media && this.mediaPreviewFiles ? this.mediaPreviewFiles.remove(media) : Promise.resolve(),
      pdf && this.pdfPreviewFiles ? this.pdfPreviewFiles.remove(pdf) : Promise.resolve(),
      model && this.modelPreviewFiles ? this.modelPreviewFiles.remove(model) : Promise.resolve()
    ]);
  }

  async #releaseFilesBinaryPreviews(): Promise<void> {
    const mediaLease = this.#filesMediaPreview;
    const pdfLease = this.#filesPdfPreview;
    const modelLease = this.#filesModelPreview;
    this.#filesMediaPreview = undefined;
    this.#filesPdfPreview = undefined;
    this.#filesModelPreview = undefined;
    await Promise.all([
      mediaLease && this.mediaPreviewFiles ? this.mediaPreviewFiles.remove(mediaLease) : Promise.resolve(),
      pdfLease && this.pdfPreviewFiles ? this.pdfPreviewFiles.remove(pdfLease) : Promise.resolve(),
      modelLease && this.modelPreviewFiles ? this.modelPreviewFiles.remove(modelLease) : Promise.resolve()
    ]);
  }

  async #loadFiles(
    context: MobileFilesContext,
    location: MobileFilesState["location"],
    epoch: number
  ): Promise<boolean> {
    this.#filesListAbort?.abort();
    const controller = new AbortController();
    this.#filesListAbort = controller;
    const parentPath = location.kind === "workspace" ? location.path : "";
    try {
      const [directory, index, artifacts] = await Promise.all([
        this.network.listWorkspaceDirectory(
          context.credential,
          context.authority.workspace.workspaceId,
          parentPath,
          controller.signal
        ),
        this.network.listWorkspaceFileIndex(
          context.credential,
          context.authority.workspace.workspaceId,
          controller.signal
        ),
        this.network.listSessionArtifacts(
          context.credential,
          context.authority.sessionId,
          controller.signal
        )
      ]);
      if (controller.signal.aborted || this.#filesListAbort !== controller
        || !this.#currentFiles(epoch, context.key)) return false;
      this.#set({ files: {
        ...this.#state.files,
        status: "ready",
        authorityKey: context.key,
        sessionId: context.authority.sessionId,
        workspace: context.authority.workspace,
        location: this.#state.files.location.kind === "generated" ? this.#state.files.location : location,
        entries: sortWorkspaceEntries(directory.entries),
        directoryRevision: directory.revision,
        fileIndex: [...index.paths].sort((left, right) => left.localeCompare(right, "en", { numeric: true })),
        fileIndexRevision: index.revision,
        fileIndexTruncated: index.truncated,
        artifacts: sortArtifacts(artifacts.artifacts),
        artifactsRevision: artifacts.revision,
        error: undefined
      } });
      return true;
    } catch (error) {
      if (controller.signal.aborted || !this.#currentFiles(epoch, context.key)) return false;
      this.#set({ files: { ...this.#state.files, status: "error", error: message(error) } });
      return false;
    } finally {
      if (this.#filesListAbort === controller) this.#filesListAbort = undefined;
    }
  }

  async #watchFiles(context: MobileFilesContext, epoch: number): Promise<void> {
    this.#filesWatchAbort?.abort();
    const controller = new AbortController();
    this.#filesWatchAbort = controller;
    if (!this.#currentFiles(epoch, context.key)) return;
    this.#set({ files: { ...this.#state.files, watchStatus: "watching", watchError: undefined } });
    try {
      for await (const _change of this.network.watchWorkspace(
        context.credential,
        context.authority.workspace.workspaceId,
        controller.signal
      )) {
        if (controller.signal.aborted || this.#filesWatchAbort !== controller
          || !this.#currentFiles(epoch, context.key)) return;
        this.#scheduleFilesRefresh(context, epoch);
      }
      if (!controller.signal.aborted && this.#currentFiles(epoch, context.key)) {
        this.#set({ files: { ...this.#state.files, watchStatus: "error",
          watchError: "Workspace change monitoring ended before Files was closed." } });
      }
    } catch (error) {
      if (controller.signal.aborted || !this.#currentFiles(epoch, context.key)) return;
      this.#set({ files: { ...this.#state.files, watchStatus: "error", watchError: message(error) } });
    } finally {
      if (this.#filesWatchAbort === controller) this.#filesWatchAbort = undefined;
    }
  }

  #scheduleFilesRefresh(context: MobileFilesContext, epoch: number): void {
    this.#filesPreviewAbort?.abort();
    this.#filesPreviewAbort = undefined;
    void this.#releaseFilesBinaryPreviews().catch(() => undefined);
    if (this.#state.files.preview) {
      this.#set({ files: { ...this.#state.files, preview: undefined } });
    }
    if (this.#filesRefreshTimer !== undefined) clearTimeout(this.#filesRefreshTimer);
    this.#filesRefreshTimer = setTimeout(() => {
      this.#filesRefreshTimer = undefined;
      if (this.#currentFiles(epoch, context.key)) void this.refreshFiles();
    }, 180);
  }

  async #previewIndexedWorkspaceFile(relativePath: string): Promise<void> {
    const path = canonicalWorkspacePath(relativePath);
    const context = this.#filesContext();
    if (!this.#state.files.open || context.key !== this.#state.files.authorityKey
      || !this.#state.files.fileIndex.includes(path)) {
      throw new Error("Select a file from the current Workspace index.");
    }
    this.#filesPreviewAbort?.abort();
    const controller = new AbortController();
    this.#filesPreviewAbort = controller;
    const epoch = this.#filesEpoch;
    const provisional = {
      title: workspaceBasename(path), sourceLabel: path, mediaType: "application/octet-stream",
      byteSize: 0n, revisionKey: `resolving:${path}`
    };
    this.#set({ files: { ...this.#state.files, preview: { ...provisional, kind: "loading" } } });
    try {
      await this.#releaseFilesBinaryPreviews();
      if (controller.signal.aborted || this.#filesPreviewAbort !== controller
        || !this.#currentFiles(epoch, context.key)) return;
      const directory = await this.network.listWorkspaceDirectory(
        context.credential,
        context.authority.workspace.workspaceId,
        workspaceParentPath(path),
        controller.signal
      );
      if (controller.signal.aborted || this.#filesPreviewAbort !== controller
        || !this.#currentFiles(epoch, context.key)) return;
      const entry = directory.entries.find((candidate) => candidate.relativePath === path);
      if (!entry?.revision || entry.kind === FileKind.DIRECTORY) {
        throw new Error("The indexed file is no longer available at its observed path.");
      }
      await this.#finishWorkspacePreview(context, path, entry.revision, workspaceBasename(path), controller, epoch);
    } catch (error) {
      if (controller.signal.aborted || !this.#currentFiles(epoch, context.key)) return;
      this.#set({ files: { ...this.#state.files,
        preview: { ...provisional, kind: "error", reason: message(error) } } });
    } finally {
      if (this.#filesPreviewAbort === controller) this.#filesPreviewAbort = undefined;
    }
  }

  async #previewWorkspaceFile(relativePath: string, revision: FileRevision, title: string, signal?: AbortSignal): Promise<void> {
    const path = canonicalWorkspacePath(relativePath);
    workspaceEntryRevisionKey(revision);
    const context = this.#filesContext();
    if (!this.#state.files.open || context.key !== this.#state.files.authorityKey) return;
    this.#filesPreviewAbort?.abort();
    const controller = new AbortController();
    this.#filesPreviewAbort = controller;
    const abort = () => controller.abort(); signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) abort();
    const epoch = this.#filesEpoch;
    const page = this.#filesPreviewPager?.descriptor.pages[this.#filesPreviewPager.descriptor.index];
    const provisional = {
      title, sourceLabel: path, mediaType: page?.kind === "workspace" && page.entry.relativePath === path ? page.mediaType : "application/octet-stream",
      byteSize: revision.byteSize, revisionKey: workspaceEntryRevisionKey(revision)
    };
    this.#set({ files: { ...this.#state.files, preview: { ...provisional, kind: "loading" } } });
    try {
      await this.#releaseFilesBinaryPreviews();
      if (controller.signal.aborted || this.#filesPreviewAbort !== controller
        || !this.#currentFiles(epoch, context.key)) return;
      await this.#finishWorkspacePreview(context, path, revision, title, controller, epoch);
    } catch (error) {
      if (controller.signal.aborted || !this.#currentFiles(epoch, context.key)) return;
      this.#set({ files: { ...this.#state.files,
        preview: { ...provisional, kind: "error", reason: message(error) } } });
    } finally {
      if (this.#filesPreviewAbort === controller) this.#filesPreviewAbort = undefined;
      signal?.removeEventListener("abort", abort);
    }
  }

  async #finishWorkspacePreview(
    context: MobileFilesContext,
    relativePath: string,
    revision: FileRevision,
    title: string,
    controller: AbortController,
    epoch: number
  ): Promise<void> {
    const result = await this.network.readWorkspaceFile(
      context.credential,
      context.authority.workspace.workspaceId,
      relativePath,
      revision,
      controller.signal
    );
    assertWorkspaceFilePreview(context.authority.workspace.workspaceId, relativePath, revision, result);
    if (controller.signal.aborted || this.#filesPreviewAbort !== controller
      || !this.#currentFiles(epoch, context.key)) return;
    const preview = await this.#workspacePreview(context, result, title, controller.signal);
    if (controller.signal.aborted || this.#filesPreviewAbort !== controller
      || !this.#currentFiles(epoch, context.key)) {
      if (preview.kind === "media") await this.mediaPreviewFiles?.remove(preview).catch(() => undefined);
      if (preview.kind === "pdf") await this.pdfPreviewFiles?.remove(preview).catch(() => undefined);
      if (preview.kind === "model") await this.modelPreviewFiles?.remove(preview).catch(() => undefined);
      return;
    }
    this.#filesMediaPreview = preview.kind === "media" ? preview : undefined;
    this.#filesPdfPreview = preview.kind === "pdf" ? preview : undefined;
    this.#filesModelPreview = preview.kind === "model" ? preview : undefined;
    if (this.#filesPreviewPager && this.#filesPreviewPagerCurrent(this.#filesPreviewPager)) {
      const page = this.#filesPreviewPager.descriptor.pages[this.#filesPreviewPager.descriptor.index];
      if (page?.kind === "workspace" && page.entry.relativePath === relativePath) this.#filesPreviewPager.original = result.entry;
    }
    this.#set({ files: { ...this.#state.files, preview } });
  }

  async #canonicalWorkspaceImagePreview(credential: PairedCredential, workspaceId: string, preview: FilePreview, signal?: AbortSignal): Promise<FilePreview> {
    const entry = preview.entry;
    if (normalizeMediaType(entry?.mediaType ?? "") !== "image/svg+xml" || preview.content.case !== "text" || preview.truncated) return preview;
    if (!entry?.revision || entry.workspaceId !== workspaceId || entry.kind !== FileKind.REGULAR) throw new Error("The SVG Workspace source is invalid.");
    const materialized = await this.network.materializeWorkspaceFileBlob(credential, workspaceId, entry.relativePath, entry.revision, signal);
    signal?.throwIfAborted();
    if (!sameFilesWorkspaceEntry(materialized.entry, entry) || normalizeMediaType(materialized.blob.mediaType) !== "image/svg+xml"
      || materialized.blob.byteSize !== entry.revision.byteSize || materialized.blob.sha256Hex !== entry.revision.sha256Hex) {
      throw new Error("The SVG Workspace revision changed before image preview.");
    }
    return { ...preview, entry: materialized.entry, content: { case: "image", value: create(ImageRefSchema, { blob: materialized.blob, altText: entry.displayName }) } };
  }

  async #workspacePreview(
    context: MobileFilesContext,
    preview: FilePreview,
    title: string,
    signal: AbortSignal
  ): Promise<MobileFilePreview> {
    preview = await this.#canonicalWorkspaceImagePreview(context.credential, context.authority.workspace.workspaceId, preview, signal);
    const entry = preview.entry;
    const revision = entry?.revision;
    if (!entry || !revision || entry.kind === FileKind.DIRECTORY
      || entry.workspaceId !== context.authority.workspace.workspaceId) {
      throw new Error("The Joko node returned an invalid Workspace preview identity.");
    }
    const mediaType = normalizeMediaType(entry.mediaType) || "application/octet-stream";
    const base = {
      title,
      sourceLabel: entry.relativePath,
      fileName: workspaceBasename(entry.relativePath),
      mediaType,
      byteSize: revision.byteSize,
      revisionKey: workspaceEntryRevisionKey(revision)
    };
    if (preview.content.case === "text") {
      const text = preview.content.value;
      const visibleBytes = BigInt(new TextEncoder().encode(text.utf8Text).byteLength);
      if (!isTextMediaType(mediaType) || text.startByte !== 0n || text.endByte < text.startByte
        || text.endByte > revision.byteSize || !Number.isSafeInteger(text.totalLines) || text.totalLines < 0) {
        throw new Error("The Joko node returned invalid text preview metadata.");
      }
      if (visibleBytes !== text.endByte - text.startByte) {
        throw new Error("The Joko node returned a text preview with a mismatched byte window.");
      }
      return { ...base, kind: "text", workspaceEntry: entry, text: text.utf8Text, languageId: text.languageId,
        startByte: text.startByte, endByte: text.endByte, totalLines: text.totalLines,
        truncated: preview.truncated };
    }
    if (preview.content.case === "image") {
      const image = preview.content.value;
      const blob = image.blob;
      if (!blob || !normalizeMediaType(blob.mediaType).startsWith("image/")
        || normalizeMediaType(blob.mediaType) !== mediaType
        || blob.byteSize !== revision.byteSize || blob.sha256Hex !== revision.sha256Hex) {
        throw new Error("The Joko node returned mismatched image preview metadata.");
      }
      const download = await this.network.downloadBlob(context.credential, blob, signal);
      const decoded = mobileImageGalleryMediaType(mediaType) ? inspectMobileImageGalleryBytes(download.bytes, mediaType) : undefined;
      if (decoded && image.widthPixels > 0 && !mobileImageGalleryDimensionsMatch(decoded, image.widthPixels, image.heightPixels)) {
        throw new Error("The Workspace image dimensions do not match the canonical image bytes.");
      }
      return { ...base, kind: "image", dataUri: decoded ? mobileImageGalleryPreviewUri(download.bytes, decoded) : bytesToDataUri(download.bytes, download.mediaType),
        altText: image.altText || title, widthPixels: decoded?.width ?? image.widthPixels, heightPixels: decoded?.height ?? image.heightPixels };
    }
    if (preview.content.case === "blob") {
      const blob = preview.content.value;
      const blobType = normalizeMediaType(blob.mediaType) || "application/octet-stream";
      if (blob.byteSize !== revision.byteSize || blob.sha256Hex !== revision.sha256Hex || blobType !== mediaType) {
        throw new Error("The Joko node returned mismatched binary Blob metadata.");
      }
      if (mobileMediaPreviewKind(blobType)) {
        if (blob.byteSize > BigInt(MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES)) {
          return { ...base, kind: "unsupported",
            reason: `This ${blobType} file is ${blob.byteSize.toString(10)} bytes and exceeds the mobile preview limit.` };
        }
        if (!this.mediaPreviewFiles) {
          return { ...base, kind: "unsupported", reason: "Audio/video preview is unavailable on this mobile runtime." };
        }
        const download = await this.network.downloadBlob(context.credential, blob, signal);
        if (normalizeMediaType(download.mediaType) !== blobType) {
          throw new Error("The downloaded media type did not match the canonical Workspace Blob.");
        }
        const lease = await this.mediaPreviewFiles.stage(
          context.credential.profileId,
          this.newId(),
          entry.relativePath,
          blobType,
          blob.sha256Hex,
          download.bytes,
          signal
        );
        return { ...base, kind: "media", ...lease };
      }
      if (isMobilePdfPreviewMediaType(blobType)) {
        if (blob.byteSize > BigInt(MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES)) {
          return { ...base, kind: "unsupported",
            reason: `This PDF is ${blob.byteSize.toString(10)} bytes and exceeds the mobile preview limit.` };
        }
        if (!this.pdfPreviewFiles) {
          return { ...base, kind: "unsupported", reason: "PDF preview is unavailable on this mobile runtime." };
        }
        const download = await this.network.downloadBlob(context.credential, blob, signal);
        if (normalizeMediaType(download.mediaType) !== blobType) {
          throw new Error("The downloaded media type did not match the canonical Workspace PDF Blob.");
        }
        const lease = await this.pdfPreviewFiles.stage(
          context.credential.profileId,
          this.newId(),
          entry.relativePath,
          blobType,
          blob.sha256Hex,
          download.bytes,
          signal
        );
        return { ...base, kind: "pdf", ...lease };
      }
      if (mobileModelPreviewKind(blobType, entry.relativePath)) {
        if (blob.byteSize > BigInt(MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES)) {
          return { ...base, kind: "unsupported",
            reason: `This 3D model is ${blob.byteSize.toString(10)} bytes and exceeds the mobile preview limit.` };
        }
        if (!this.modelPreviewFiles) {
          return { ...base, kind: "unsupported", reason: "3D model preview is unavailable on this mobile runtime." };
        }
        const download = await this.network.downloadBlob(context.credential, blob, signal);
        if (normalizeMediaType(download.mediaType) !== blobType) {
          throw new Error("The downloaded media type did not match the canonical Workspace model Blob.");
        }
        const observations = new Map<string, MobileWorkspaceModelObservation>([[entry.relativePath, {
          revisionKey: workspaceEntryRevisionKey(revision),
          mediaType
        }]]);
        let lease: MobileModelPreviewLease | undefined;
        try {
          lease = await this.modelPreviewFiles.stage({
            profileId: context.credential.profileId,
            leaseId: this.newId(),
            modelPath: entry.relativePath,
            mediaType: blobType,
            expectedSha256Hex: blob.sha256Hex,
            bytes: download.bytes,
            loadResource: (path, kind, dependencySignal) => this.#loadWorkspaceModelDependency(
              context, path, kind, observations, dependencySignal ?? signal
            ),
            signal
          });
          await this.#revalidateWorkspaceModelFiles(context, observations, signal);
          return { ...base, kind: "model", ...lease };
        } catch (error) {
          if (lease) await this.modelPreviewFiles.remove(lease).catch(() => undefined);
          throw error;
        }
      }
      return { ...base, kind: "unsupported",
        reason: `No safe in-app preview is available for ${blobType} (${blob.byteSize.toString(10)} bytes).` };
    }
    if (preview.content.case === "binary") {
      const binaryType = normalizeMediaType(preview.content.value.mediaType) || mediaType;
      if (binaryType !== mediaType) throw new Error("The Joko node returned a mismatched binary media type.");
      return { ...base, kind: "unsupported",
        reason: preview.content.value.summary.trim()
          || `No safe in-app preview is available for ${binaryType} (${revision.byteSize.toString(10)} bytes).` };
    }
    return { ...base, kind: "unsupported",
      reason: `No safe in-app preview is available for ${mediaType} (${revision.byteSize.toString(10)} bytes).` };
  }

  async #loadWorkspaceModelDependency(
    context: MobileFilesContext,
    relativePath: string,
    kind: MobileModelResourceKind,
    observations: Map<string, MobileWorkspaceModelObservation>,
    signal: AbortSignal
  ): Promise<MobileModelResourceSnapshot> {
    signal.throwIfAborted();
    const path = canonicalWorkspacePath(relativePath);
    const directory = await this.network.listWorkspaceDirectory(
      context.credential,
      context.authority.workspace.workspaceId,
      workspaceParentPath(path),
      signal
    );
    signal.throwIfAborted();
    const matches = directory.entries.filter((candidate) => candidate.relativePath === path);
    const entry = matches.length === 1 ? matches[0] : undefined;
    if (!entry?.revision || entry.kind !== FileKind.REGULAR
      || entry.workspaceId !== context.authority.workspace.workspaceId) {
      throw new Error(`The model dependency ${path} is not one exact regular Workspace file.`);
    }
    const mediaType = normalizeMediaType(entry.mediaType) || "application/octet-stream";
    const observation = { revisionKey: workspaceEntryRevisionKey(entry.revision), mediaType };
    const existing = observations.get(path);
    if (existing && (existing.revisionKey !== observation.revisionKey || existing.mediaType !== mediaType)) {
      throw new Error(`The model dependency ${path} changed while it was being resolved.`);
    }
    observations.set(path, observation);
    const preview = await this.network.readWorkspaceFile(
      context.credential,
      context.authority.workspace.workspaceId,
      path,
      entry.revision,
      signal
    );
    signal.throwIfAborted();
    const returned = preview.entry;
    if (!returned?.revision || returned.kind !== FileKind.REGULAR || returned.relativePath !== path
      || returned.workspaceId !== context.authority.workspace.workspaceId
      || workspaceEntryRevisionKey(returned.revision) !== observation.revisionKey
      || (normalizeMediaType(returned.mediaType) || "application/octet-stream") !== mediaType) {
      throw new Error(`The model dependency ${path} changed before its exact preview was returned.`);
    }
    const blob = preview.content.case === "blob" ? preview.content.value
      : kind === "image" && preview.content.case === "image" ? preview.content.value.blob : undefined;
    if (!blob || blob.byteSize !== returned.revision.byteSize
      || blob.sha256Hex !== returned.revision.sha256Hex
      || (normalizeMediaType(blob.mediaType) || "application/octet-stream") !== mediaType) {
      throw new Error(`The model dependency ${path} did not return an exact typed Blob.`);
    }
    const download = await this.network.downloadBlob(context.credential, blob, signal);
    signal.throwIfAborted();
    if ((normalizeMediaType(download.mediaType) || "application/octet-stream") !== mediaType) {
      throw new Error(`The downloaded model dependency ${path} changed media type.`);
    }
    return { path, mediaType, sha256Hex: blob.sha256Hex, bytes: download.bytes };
  }

  async #revalidateWorkspaceModelFiles(
    context: MobileFilesContext,
    observations: ReadonlyMap<string, MobileWorkspaceModelObservation>,
    signal: AbortSignal
  ): Promise<void> {
    const directories = new Map<string, Awaited<ReturnType<MobileNetwork["listWorkspaceDirectory"]>>>();
    for (const [path, observation] of observations) {
      signal.throwIfAborted();
      const parent = workspaceParentPath(path);
      let directory = directories.get(parent);
      if (!directory) {
        directory = await this.network.listWorkspaceDirectory(
          context.credential,
          context.authority.workspace.workspaceId,
          parent,
          signal
        );
        directories.set(parent, directory);
      }
      const matches = directory.entries.filter((candidate) => candidate.relativePath === path);
      const entry = matches.length === 1 ? matches[0] : undefined;
      if (!entry?.revision || entry.kind !== FileKind.REGULAR
        || entry.workspaceId !== context.authority.workspace.workspaceId
        || workspaceEntryRevisionKey(entry.revision) !== observation.revisionKey
        || (normalizeMediaType(entry.mediaType) || "application/octet-stream") !== observation.mediaType) {
        throw new Error(`The model file ${path} changed before the verified preview lease was adopted.`);
      }
    }
  }

  #ready(): PairedCredential {
    if (this.#state.status !== "connected" || !this.#credential || !this.#foreground) {
      throw new Error("Reconnect to the Joko node before making a change.");
    }
    return this.#credential;
  }

  async #completeServerRemoval(
    matches: (profile: MobileConnectionProfile) => boolean,
    confirmation: string
  ): Promise<void> {
    const targets = this.#profiles.filter(matches);
    const activeRemoved = this.#activeProfileId !== undefined
      && targets.some((profile) => profile.profileId === this.#activeProfileId);
    if (activeRemoved) {
      this.#retire();
      this.#credential = undefined;
      this.#activeProfileId = undefined;
      this.#lastAuthenticatedAt = undefined;
      this.#durableSnapshotAt = undefined;
      this.#set({ status: "unpaired", busy: true, activeProfileId: undefined,
        node: undefined, origin: undefined, candidate: undefined, connectionAttemptError: undefined,
        challenge: undefined, owner: undefined, detail: undefined, selectedId: undefined,
        older: [], window: undefined, live: [], liveStatus: "paused", historyBusy: false,
        historyEnd: false, before: undefined, pending: [], offlineSnapshotAt: undefined });
    }
    const failed = new Map<string, string>();
    const removed = new Set<string>();
    const localCleanupFailures: string[] = [];
    for (const profile of targets) {
      let automaticFailure: string | undefined;
      const wasAutomatic = this.#automaticProfileId === profile.profileId;
      if (wasAutomatic) {
        try {
          await this.storage.saveAutomaticProfile();
          this.#automaticProfileId = undefined;
        }
        catch (error) { automaticFailure = message(error); }
      }
      try {
        await this.storage.deleteConnection(profile.profileId);
        if (wasAutomatic) this.#automaticProfileId = undefined;
        await this.storage.saveSelection(profile.profileId).catch(() => undefined);
        await this.newTaskDrafts?.clear({ profileId: profile.profileId }).catch(() => undefined);
        await this.#taskOutbox?.clearProfile(profile.profileId).catch(() => undefined);
        await this.attachmentFiles?.clearProfile(profile.profileId).catch(() => undefined);
        const offlineCacheFailure = await this.#clearOfflineCache(profile.profileId);
        if (offlineCacheFailure) localCleanupFailures.push(`${profile.displayName}: ${offlineCacheFailure}`);
        removed.add(profile.profileId);
      } catch (error) {
        failed.set(profile.profileId, [message(error), automaticFailure].filter(Boolean).join(" "));
      }
    }
    let receiptCleanupError: string | undefined;
    try { await this.#dropPendingConnections(targets.map((profile) => profile.connectionId)); }
    catch (error) { receiptCleanupError = message(error); }
    this.#profiles = this.#profiles.filter((profile) => !removed.has(profile.profileId));
    const saved = this.#profiles.map((profile) => {
      const failure = failed.get(profile.profileId);
      return this.#savedConnection(
        profile,
        this.#automaticProfileId === profile.profileId,
        failure ? "unavailable" : this.#state.saved.find((item) => item.profileId === profile.profileId)?.credentialState ?? "unknown",
        failure
      );
    });
    const cleanupError = failed.size === 0 && receiptCleanupError === undefined && localCleanupFailures.length === 0
      ? undefined
      : `${confirmation}${failed.size === 0 ? "" : ` Joko could not finish removing ${failed.size === 1 ? "its local credential" : "some local credentials"}; retry Forget.`}`
        + `${receiptCleanupError === undefined ? "" : ` Local operation receipts could not be cleared: ${receiptCleanupError}`}`
        + `${localCleanupFailures.length === 0 ? "" : ` Saved offline content could not be cleared: ${localCleanupFailures.join("; ")}`}`;
    if (!activeRemoved) {
      this.#set({ automaticProfileId: this.#automaticProfileId, saved, error: cleanupError });
      return;
    }
    this.#set({ status: "unpaired", busy: false, activeProfileId: undefined,
      automaticProfileId: this.#automaticProfileId, node: undefined, origin: undefined, saved,
      candidate: undefined, connectionAttemptError: undefined, challenge: undefined,
      owner: undefined, detail: undefined, selectedId: undefined,
      older: [], window: undefined, live: [], liveStatus: "paused", historyBusy: false,
      historyEnd: false, before: undefined, pending: [], offlineSnapshotAt: undefined, error: cleanupError });
  }

  async #submit(
    mutation: OperationMutation,
    identity: Pick<PendingOperation, "kind" | "sessionId" | "eventId" | "queueItemId" | "interactionId" | "interactionGeneration" | "interactionRevision" | "interactionDraftKind" | "targetConnectionId" | "targetDeviceId" | "scheduleId" | "triggerId" | "targetId" | "backendId" | "sourceGeneration" | "workspaceId" | "changeSetId" | "extensionId" | "extensionRevision" | "extensionResourceId">,
    operationId?: string
  ): Promise<boolean> {
    return (await this.#submitTracked(mutation, identity, false, operationId)).accepted;
  }

  async #submitTerminal(
    mutation: OperationMutation,
    identity: Pick<PendingOperation, "kind" | "sessionId" | "eventId" | "queueItemId" | "interactionId" | "interactionGeneration" | "interactionRevision" | "interactionDraftKind" | "targetConnectionId" | "targetDeviceId" | "scheduleId" | "triggerId" | "targetId" | "backendId" | "sourceGeneration" | "workspaceId" | "changeSetId" | "extensionId" | "extensionRevision" | "extensionResourceId">,
    operationId?: string,
    markBusy = true,
    refreshAfter = true,
    authority?: { readonly signal: AbortSignal; readonly isCurrent: () => boolean;
      readonly beforeDispatch?: () => boolean;
      readonly beforeTerminalReceipt?: (operation: Operation) => Promise<void> }
  ): Promise<TrackedMutationResult> {
    return this.#submitTracked(mutation, identity, true, operationId, markBusy, refreshAfter, authority);
  }

  async #submitTracked(
    mutation: OperationMutation,
    identity: Pick<PendingOperation, "kind" | "sessionId" | "eventId" | "queueItemId" | "interactionId" | "interactionGeneration" | "interactionRevision" | "interactionDraftKind" | "targetConnectionId" | "targetDeviceId" | "scheduleId" | "triggerId" | "targetId" | "backendId" | "sourceGeneration" | "workspaceId" | "changeSetId" | "extensionId" | "extensionRevision" | "extensionResourceId">,
    waitForTerminal: boolean,
    operationId = this.newId(),
    markBusy = true,
    refreshAfter = true,
    authority?: { readonly signal: AbortSignal; readonly isCurrent: () => boolean;
      readonly beforeDispatch?: () => boolean;
      readonly beforeTerminalReceipt?: (operation: Operation) => Promise<void> }
  ): Promise<TrackedMutationResult> {
    const requestCurrent = (): boolean => authority === undefined || !authority.signal.aborted && authority.isCurrent();
    if (!requestCurrent()) return { accepted: false, definitive: false };
    const credential = this.#ready();
    const epoch = this.#epoch;
    const pending: PendingOperation = { ...identity, connectionId: credential.connectionId, operationId, state: "unknown",
      ...(this.#joinedTask ? { taskJoinId: this.#joinedTask.source.joined.joinId } : {}) };
    const before = this.#state.pending;
    const next = [...before, pending];
    this.#set({ pending: next, ...(markBusy ? { busy: true } : {}), error: undefined });
    try {
      if (!await this.#persistPending(next, epoch)) return { accepted: false, definitive: false };
    } catch (error) {
      if (this.#current(epoch)) this.#set({ pending: before, ...(markBusy ? { busy: false } : {}) });
      throw error;
    }
    let operation: Operation;
    if (!requestCurrent() || authority?.beforeDispatch?.() === false) return { accepted: false, definitive: false };
    const operationSignal = authority === undefined ? this.#abort?.signal
      : this.#abort === undefined ? authority.signal : AbortSignal.any([this.#abort.signal, authority.signal]);
    try {
      operation = await this.network.submit(credential, pending.operationId, mutation, operationSignal);
    } catch (error) {
      if (this.#current(epoch)) this.#set({ ...(markBusy ? { busy: false } : {}), error: `Operation ${pending.operationId}: ${message(error)}. Check status; it was not resent.` });
      return { accepted: false, definitive: false };
    }
    if (!this.#current(epoch) || !requestCurrent()) return { accepted: false, definitive: false };
    if (!this.#operationReceiptMatches(operation, pending)) {
      this.#set({ ...(markBusy ? { busy: false } : {}), error: `Operation ${pending.operationId} returned with the wrong durable identity. Its receipt was retained and no input was resent.` });
      return { accepted: false, definitive: false };
    }
    if (isTerminal(operation.state)) await authority?.beforeTerminalReceipt?.(operation);
    if (!this.#current(epoch) || !requestCurrent()) return { accepted: false, definitive: false };
    await this.#receipt(operation, pending, epoch);
    if (waitForTerminal && !isTerminal(operation.state)) {
      try {
        operation = await this.network.waitOperation(credential, pending.operationId, operationSignal);
      } catch (error) {
        if (this.#current(epoch)) this.#set({
          ...(markBusy ? { busy: false } : {}),
          error: `Operation ${pending.operationId}: ${message(error)}. Its durable result is unknown; it was not resent.`
        });
        return { accepted: false, definitive: false };
      }
      if (!this.#current(epoch) || !requestCurrent()) return { accepted: false, definitive: false };
      if (!this.#operationReceiptMatches(operation, pending)) {
        this.#set({ ...(markBusy ? { busy: false } : {}), error: `Operation ${pending.operationId} completed with the wrong durable identity. Its receipt was retained and no input was resent.` });
        return { accepted: false, definitive: false };
      }
      if (isTerminal(operation.state)) await authority?.beforeTerminalReceipt?.(operation);
      if (!this.#current(epoch) || !requestCurrent()) return { accepted: false, definitive: false };
      await this.#receipt(operation, pending, epoch);
    }
    const rejected = operation.state === OperationState.FAILED
      || operation.state === OperationState.CONFLICT
      || operation.state === OperationState.CANCELLED;
    const rejectionMessage = rejected ? operation.error?.message || "The operation was rejected." : undefined;
    if (this.#current(epoch)) {
      if (markBusy) this.#set({ busy: false });
      if (refreshAfter) await this.refresh();
      if (rejectionMessage && this.#credential?.connectionId === pending.connectionId && this.#state.status === "connected") {
        this.#set({ error: rejectionMessage });
      }
    }
    return { accepted: !rejected, definitive: isTerminal(operation.state), operation };
  }

  async #receipt(operation: Operation, pending: PendingOperation, epoch: number): Promise<void> {
    if (!this.#current(epoch) || this.#credential?.connectionId !== pending.connectionId) return;
    if (!this.#operationReceiptMatches(operation, pending)) {
      this.#set({
        error: `Operation ${pending.operationId} returned with the wrong durable identity and was ignored. Its local receipt was retained.`
      });
      return;
    }
    if (operation.state === OperationState.FAILED || operation.state === OperationState.CONFLICT || operation.state === OperationState.CANCELLED) {
      const next = this.#state.pending.filter((item) => item.operationId !== pending.operationId);
      if (await this.#persistPending(next, epoch)) this.#set({ pending: next, error: operation.error?.message || "The operation was rejected." });
      return;
    }
    if (operation.state === OperationState.SUCCEEDED && pending.kind === "device-rename") {
      confirmedMobileDeviceName(operation, pending.targetDeviceId!, pending.connectionId);
    }
    const next = isTerminal(operation.state)
      ? this.#state.pending.filter((item) => item.operationId !== pending.operationId)
      : this.#state.pending.map((item) => item.operationId === pending.operationId ? { ...item, state: "accepted" as const } : item);
    if (!await this.#persistPending(next, epoch)) return;
    this.#set({ pending: next });
    if (operation.state === OperationState.SUCCEEDED
      && (pending.kind === "interaction-resolve" || pending.kind === "interaction-dismiss")
      && pending.interactionDraftKind !== undefined && pending.sessionId !== undefined && pending.interactionId !== undefined
      && pending.interactionGeneration !== undefined && pending.interactionRevision !== undefined
      && this.#activeProfileId !== undefined && this.clearInteractionDraft !== undefined) {
      try {
        await this.clearInteractionDraft({
          profileId: this.taskDraftProfileId()!,
          sessionId: pending.sessionId,
          interactionId: pending.interactionId,
          kind: pending.interactionDraftKind,
          generation: BigInt(pending.interactionGeneration),
          revision: BigInt(pending.interactionRevision)
        });
      } catch (error) {
        if (this.#current(epoch)) this.#set({ error: message(error) });
      }
    }
    if (operation.state === OperationState.SUCCEEDED && pending.kind === "logout" && pending.targetConnectionId) {
      await this.#completeServerRemoval(
        (profile) => profile.connectionId === pending.targetConnectionId,
        "The connection was logged out on the Joko node."
      );
    } else if (operation.state === OperationState.SUCCEEDED && pending.kind === "revoke" && pending.targetDeviceId) {
      await this.#completeServerRemoval(
        (profile) => profile.deviceId === pending.targetDeviceId,
        "The device was revoked on the Joko node."
      );
    }
  }

  #operationReceiptMatches(operation: Operation, pending: PendingOperation): boolean {
    if (pending.taskJoinId !== undefined) {
      if (this.#joinedTask?.source.joined.joinId !== pending.taskJoinId) return false;
      try { assertMobileSharedTaskOperation(this.#joinedTask.source, pending.operationId, operation); return true; }
      catch { return false; }
    }
    return !this.#joinedTask && operation.operationId === pending.operationId && operation.connectionId === pending.connectionId;
  }

  async reconcile(epoch = this.#epoch): Promise<void> {
    const credential = this.#credential;
    if (!credential || !this.#current(epoch)) return;
    for (const pending of this.#state.pending) {
      if (pending.connectionId !== credential.connectionId) continue;
      try {
        const operation = pending.kind.startsWith("objective-") || pending.kind.startsWith("collaboration-")
          ? await this.network.getServiceOperation?.(credential, pending.operationId, this.#abort?.signal)
          : await this.network.getOperation(credential, pending.operationId, this.#abort?.signal);
        if (pending.kind.startsWith("objective-") || pending.kind.startsWith("collaboration-")) {
          // These service ledgers have no client connection field.
          // Observe its original ID through the exact authenticated saved node.
          if (operation?.operationId === pending.operationId && isTerminal(operation.state) && this.#current(epoch)) {
            if (operation.state === OperationState.SUCCEEDED && pending.kind === "objective-set" && this.newTaskDrafts) {
              await new MobileObjectiveRecovery(this.newTaskDrafts.driver).clear({ profileId: credential.profileId, connectionId: credential.connectionId,
                serverId: credential.serverId, sessionId: pending.sessionId!, generation: pending.sourceGeneration! });
              if (!this.#current(epoch)) return;
            }
            if (operation.state === OperationState.SUCCEEDED && pending.kind === "collaboration-create" && this.newTaskDrafts) {
              await this.workerStorage()!.clear({ profileId: credential.profileId, connectionId: credential.connectionId, serverId: credential.serverId,
                sessionId: pending.sessionId!, generation: pending.sourceGeneration! });
              if (!this.#current(epoch)) return;
            }
            const rest = this.#state.pending.filter(value => value.operationId !== pending.operationId);
            if (await this.#persistPending(rest, epoch)) this.#set({ pending: rest,
              ...(operation.state === OperationState.SUCCEEDED ? {} : { error: operation.error?.message || "The service operation was rejected." }) });
          }
          continue;
        }
        if (!this.#current(epoch)) return;
        if (operation) {
          if (pending.kind === "session-side-chat" && operation.state === OperationState.SUCCEEDED
            && operation.operationId === pending.operationId && operation.connectionId === pending.connectionId) {
            await this.#recoverSideChatReceipt(pending, operation, epoch);
            if (!this.#current(epoch)) return;
          }
          if (pending.kind === "session-fork" && operation.state === OperationState.SUCCEEDED
            && operation.operationId === pending.operationId && operation.connectionId === pending.connectionId) {
            await this.#recoverForkReceipt(pending, operation, epoch);
            if (!this.#current(epoch)) return;
          }
          const messageRewind = pending.kind === "session-rewind" || pending.kind === "workspace-rewind";
          const exactOperation = operation.operationId === pending.operationId && operation.connectionId === pending.connectionId;
          if (isMobileExtensionReceiptKind(pending.kind)
            && exactOperation && operation.state === OperationState.SUCCEEDED) {
            if (pending.kind === "extension-package-adopt" || pending.kind === "extension-package-remove") this.#assertExtensionPackageResult(operation, pending.extensionResourceId);
            else if (pending.kind === "extension-settings-directory") this.#assertExtensionDirectoryReceipt(operation);
            else this.#assertExtensionMutationAcknowledgement(operation);
          }
          if (messageRewind && exactOperation && operation.state === OperationState.SUCCEEDED) {
            await this.#recoverMessageRewindReceipt(pending, operation, epoch);
            if (!this.#current(epoch)) return;
          }
          await this.#receipt(operation, pending, epoch);
          if ((pending.kind === "session-rewind" || pending.kind === "session-side-chat") && exactOperation && isTerminal(operation.state) && this.#current(epoch)
            && !this.#state.pending.some((value) => value.operationId === pending.operationId)) {
            await this.composerDrafts?.clearOperationInput({ profileId: pending.taskJoinId
              ? mobileSharedTaskDraftProfileId(credential.profileId, credential.serverId, credential.origin, pending.taskJoinId)
              : credential.profileId, sessionId: pending.sessionId! }, pending.operationId);
            if (!this.#current(epoch)) return;
          }
          const scheduleMutation = ["schedule-run", "schedule-enable", "schedule-run-restart",
            "schedule-run-read", "schedule-runs-read", "schedule-all-read", "schedule-run-delete",
            "schedule-create", "schedule-update", "schedule-delete", "schedule-promote", "schedule-clone",
            "schedule-project-remove", "schedule-project-reconcile"]
            .includes(pending.kind);
          if (scheduleMutation && isTerminal(operation.state) && this.#current(epoch)) {
            const rejection = operation.state === OperationState.SUCCEEDED
              ? undefined
              : operation.error?.message || "The Automation operation was rejected.";
            await this.refresh();
            if (rejection && this.#state.status === "connected") this.#set({ error: rejection });
            return;
          }
          if (operation.state === OperationState.SUCCEEDED
            && ["device-rename", "rename", "pin", "archive", "delete", "message-delete", "queue-cancel", "queue-edit-lock",
              "queue-edit", "queue-interaction-lock", "queue-reorder", "interaction-resolve", "interaction-dismiss",
              "session-model", "session-permission", "session-plan", "session-compact", "session-branch",
              "session-shell", "session-reset", "session-review", "session-clone", "session-fork", "session-side-chat", "session-rewind", "workspace-rewind", "task-tag", "model-favorite"].includes(pending.kind)
            && this.#current(epoch)) {
            await this.refresh();
            if ((pending.kind === "message-delete" || messageRewind) && this.#foreground
              && this.#state.selectedId === pending.sessionId) this.#clearHistory();
            return;
          }
        } else this.#set({ error: `Operation ${pending.operationId} is not yet confirmed. No input will be resent automatically.` });
      } catch (error) {
        if (!this.#current(epoch)) return;
        if (isRevoked(error)) {
          await this.#invalidateCredential(
            epoch,
            credential.profileId,
            "This mobile connection was revoked. Forget it or pair this device again."
          );
          return;
        }
        this.#set({ error: `Could not confirm operation ${pending.operationId}: ${message(error)}` });
      }
    }
    await this.#resumeNewTaskSubmission(epoch);
    await this.#drainTaskOutbox(epoch);
  }

  async #resumeNewTaskSubmission(epoch: number): Promise<void> {
    if (!this.newTaskDrafts || !this.composerDrafts || this.#newTaskSubmissionActive
      || this.#mutationOwner || this.#state.busy || !this.#current(epoch)) return;
    const credential = this.#credential;
    const profileId = this.#activeProfileId;
    if (!credential || !profileId) return;
    const identity = { profileId } satisfies MobileNewTaskDraftIdentity;
    let submission: MobileNewTaskSubmission | undefined;
    try { submission = (await this.newTaskDrafts.read(identity))?.submission; }
    catch (error) {
      if (this.#current(epoch)) this.#set({ error: message(error) });
      return;
    }
    if (!submission || !this.#current(epoch)) return;
    if (submission.connectionId !== credential.connectionId || submission.serverId !== credential.serverId) {
      this.#set({ error: "A retained new-task submission belongs to a different saved Joko connection and was not replayed." });
      return;
    }
    const action = this.#claimMutation();
    this.#newTaskSubmissionActive = true;
    try {
      if (submission.phase === "creating") {
        const observed = await this.#observeRetainedNewTaskOperation(submission, epoch);
        if (observed === "not-dispatched") {
          await this.newTaskDrafts.clearSubmission(identity, submission.createOperationId);
          this.#set({ error: "The retained creation had no durable operation receipt and was not dispatched. Its draft is ready to review and retry." });
          return;
        }
        if (!observed) return;
        if (this.#mutationOwner === action) this.#set({ busy: true });
        await this.#continueNewTaskCreation(identity, submission, trackedOperation(observed));
        return;
      }
      if (submission.sendOperationId === undefined) {
        await this.#selectCreatedNewTask(submission);
        await this.#finishNewTaskPreparation(identity, submission);
        return;
      }
      if (submission.firstInputAccepted) {
        await this.#selectCreatedNewTask(submission);
        await this.#sendNewTaskFollowUps(identity, submission);
        return;
      }
      if (!this.newTaskDrafts.readSync(identity)?.conversation) {
        await this.#recoverNewTaskComposerDraft(identity, submission.sessionId, submission.input);
      }
      const observed = await this.#observeRetainedNewTaskOperation(submission, epoch);
      if (observed === "not-dispatched") {
        await this.#releaseNewTaskConversation(identity, submission, true);
        this.#set({ error: "The retained first message had no durable operation receipt and was not dispatched. Its structured input remains in the created task composer." });
        return;
      }
      if (!observed) return;
      if (this.#mutationOwner === action) this.#set({ busy: true });
      await this.#finishNewTaskFirstInput(identity, submission, trackedOperation(observed));
    } catch (error) {
      if (this.#foreground && this.#credential?.connectionId === credential.connectionId) {
        this.#set({ error: message(error) });
      }
    } finally {
      this.#newTaskSubmissionActive = false;
      this.#releaseMutation(action);
    }
  }

  async #observeRetainedNewTaskOperation(
    submission: MobileNewTaskSubmission,
    epoch: number
  ): Promise<Operation | "not-dispatched" | undefined> {
    const credential = this.#credential;
    const operationId = submission.phase === "sending" && submission.sendOperationId
      ? submission.sendOperationId
      : submission.createOperationId;
    if (!credential || credential.connectionId !== submission.connectionId || !this.#current(epoch)) return undefined;
    let operation: Operation | undefined;
    try {
      operation = await this.network.getOperation(credential, operationId, this.#abort?.signal);
    } catch (error) {
      if (this.#current(epoch)) this.#set({ error: `Could not confirm operation ${operationId}: ${message(error)}` });
      return undefined;
    }
    if (!this.#current(epoch)) return undefined;
    if (!operation) {
      if (!this.#state.pending.some((item) => item.operationId === operationId)) return "not-dispatched";
      this.#set({ error: `Operation ${operationId} is not yet confirmed. Its retained new-task input was not resent automatically.` });
      return undefined;
    }
    if (operation.operationId !== operationId || operation.connectionId !== submission.connectionId) {
      this.#set({ error: `Operation ${operationId} returned with the wrong Joko connection identity and was ignored.` });
      return undefined;
    }
    const pending = this.#state.pending.find((item) => item.operationId === operationId)
      ?? (submission.phase === "creating"
        ? { operationId, connectionId: submission.connectionId, kind: "create" as const, state: "accepted" as const }
        : { operationId, connectionId: submission.connectionId, kind: "send" as const,
            sessionId: submission.sessionId, state: "accepted" as const });
    if (!isTerminal(operation.state) && !this.#state.pending.some((item) => item.operationId === operationId)) {
      const next = [...this.#state.pending, pending];
      if (!await this.#persistPending(next, epoch)) return undefined;
      this.#set({ pending: next });
    }
    await this.#receipt(operation, pending, epoch);
    if (!this.#current(epoch) || isTerminal(operation.state)) return operation;
    try {
      operation = await this.network.waitOperation(credential, operationId, this.#abort?.signal);
    } catch (error) {
      if (this.#current(epoch)) this.#set({
        error: `Operation ${operationId}: ${message(error)}. Its durable result is unknown; the retained input was not resent.`
      });
      return undefined;
    }
    if (!this.#current(epoch)) return undefined;
    if (operation.operationId !== operationId || operation.connectionId !== submission.connectionId) {
      this.#set({ error: `Operation ${operationId} completed with the wrong Joko connection identity and was ignored.` });
      return undefined;
    }
    await this.#receipt(operation, pending, epoch);
    return operation;
  }

  async dismissUnconfirmed(operationId: string): Promise<void> {
    const credential = this.#ready();
    const pending = this.#state.pending.find((item) => item.operationId === operationId && item.connectionId === credential.connectionId);
    if (!pending || pending.state !== "unknown") throw new Error("Only an unconfirmed operation can be cleared.");
    if (pending.kind.startsWith("objective-") || pending.kind.startsWith("collaboration-")) {
      await this.reconcile();
      if (this.#state.pending.some(value => value.operationId === operationId)) throw new Error("The service operation is still unconfirmed. Refresh its original receipt before retrying.");
      return;
    }
    const epoch = this.#epoch;
    const operation = await this.network.getOperation(credential, operationId, this.#abort?.signal);
    if (!this.#current(epoch)) return;
    if (operation) {
      await this.#receipt(operation, pending, epoch);
      throw new Error("The Joko node has this operation; its durable result was refreshed instead of discarding it.");
    }
    const next = this.#state.pending.filter((item) => item.operationId !== operationId);
    if (await this.#persistPending(next, epoch)) {
      this.#set({ pending: next, error: undefined });
      if (this.newTaskDrafts && this.#activeProfileId) {
        const identity = { profileId: this.#activeProfileId };
        const draft = await this.newTaskDrafts.read(identity);
        const submission = draft?.submission;
        const retainedOperationId = submission?.phase === "sending" && submission.sendOperationId
          ? submission.sendOperationId
          : submission?.createOperationId;
        if (submission && retainedOperationId === operationId) {
          if (submission.phase === "creating") await this.newTaskDrafts.clearSubmission(identity, operationId);
          else {
            await this.#recoverNewTaskComposerDraft(identity, submission.sessionId, submission.input);
            await this.newTaskDrafts.clear(identity);
          }
        }
      }
    }
  }

  #savedViews(
    profileId?: string,
    credentialState?: SavedCredentialState,
    error?: string
  ): SavedMobileConnection[] {
    const previous = new Map(this.#state.saved.map((profile) => [profile.profileId, profile]));
    return this.#profiles.map((profile) => {
      const prior = previous.get(profile.profileId);
      return this.#savedConnection(
        profile,
        this.#automaticProfileId === profile.profileId,
        profile.profileId === profileId && credentialState !== undefined
          ? credentialState
          : prior?.credentialState ?? "unknown",
        profile.profileId === profileId && credentialState !== undefined ? error : prior?.error
      );
    });
  }

  #savedConnection(
    profile: MobileConnectionProfile,
    automatic: boolean,
    credentialState: SavedCredentialState,
    error?: string
  ): SavedMobileConnection {
    return savedConnection(
      profile,
      automatic,
      credentialState,
      this.#allPending.filter((item) => item.connectionId === profile.connectionId),
      error
    );
  }

  dispose(): void {
    this.#remoteDesktopPresentationTransition?.close();
    if (this.#queueEditLease) this.#releaseQueueEditLeaseDetached(this.#queueEditLease);
    if (this.#queueInteractionLease) this.#releaseQueueInteractionLeaseDetached(this.#queueInteractionLease);
    this.#disposed = true;
    this.#stopEndpointTrustWatch(); this.#stopEndpointTrustWatch = () => {};
    if (this.#discoveryExpiryTimer !== undefined) clearTimeout(this.#discoveryExpiryTimer);
    this.#discoveryExpiryTimer = undefined;
    this.#catalogAbort?.abort();
    this.#catalogAbort = undefined;
    this.#connectionAttemptAbort?.abort();
    this.#connectionAttemptAbort = undefined;
    this.#retire();
    this.#listeners.clear();
  }
}

function mobileConversationShareEventDigest(event: Event): string {
  const exact = clone(EventSchema, event);
  // Snapshot and history reads issue different cursor tickets for the same
  // durable Event. Preserve its sequence/generation and all message content.
  if (exact.cursor) { exact.cursor.opaqueToken = ""; exact.cursor.issuedAt = undefined; }
  return bytesToHex(sha256(toBinary(EventSchema, exact)));
}

function mobileStateTimelineEvents(state: MobileState): readonly Event[] {
  return state.window ?? [...state.older, ...(state.detail?.timeline ?? []), ...state.live];
}

function filesComposerArtifact(source: MobileFilesComposerSource): Artifact | undefined {
  if (source.kind === "artifact") return source.artifact;
  return source.kind === "search-result" && source.result.kind === "artifact"
    ? source.result.artifact
    : undefined;
}

function exactComposerAttachment(
  attachments: readonly MobileComposerAttachment[],
  attachmentId: string
): MobileComposerAttachment {
  const matches = attachments.map(normalizeMobileComposerAttachment)
    .filter((attachment) => attachment.attachmentId === attachmentId);
  if (matches.length !== 1) throw new Error("The selected image attachment is no longer in this draft.");
  return matches[0]!;
}

function distinctAttachmentStorageId(newId: () => string, ...excluded: readonly string[]): string {
  const reserved = new Set(excluded);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = newId();
    if (/^[a-zA-Z0-9_-]{1,128}$/u.test(candidate) && !reserved.has(candidate)) return candidate;
  }
  throw new Error("A distinct local image identity could not be created.");
}

function assertMobileImageOutputDecode(
  decoded: MobileImageGalleryNativeDecode,
  expectedMediaType: string,
  expectedWidth?: number,
  expectedHeight?: number
): { readonly width: number; readonly height: number } {
  const mediaType = normalizeMediaType(expectedMediaType);
  const decodedMediaType = normalizeMediaType(decoded?.mediaType ?? "");
  if (!mobileImageOutputMediaType(mediaType)
    || (decodedMediaType !== "" && decodedMediaType !== mediaType)
    || (decodedMediaType === "" && expectedWidth === undefined)
    || decoded.isAnimated !== false) {
    throw new Error("The native decoder did not confirm a matching static raster image.");
  }
  assertMobileImageGalleryDimensions(decoded.width, decoded.height);
  if (expectedWidth !== undefined && (decoded.width !== expectedWidth || decoded.height !== expectedHeight)) {
    throw new Error("The native decoder dimensions no longer match the verified image.");
  }
  return { width: decoded.width, height: decoded.height };
}

function mobileImageOutputFileName(value: string, mediaType: string): string {
  const leaf = value.split(/[\\/]/u).at(-1)?.trim() ?? "";
  if (leaf.length > 0 && leaf.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(leaf)) return leaf;
  const exact = mobileImageOutputMediaType(mediaType);
  if (!exact) throw new Error("This image format has no safe native output file name.");
  const extension = mobileImageOutputExtension(exact);
  return `Image.${extension}`;
}

function mobileCredentialKey(credential: Pick<PairedCredential, "profileId" | "connectionId" | "deviceId" | "serverId">): string {
  return [credential.profileId, credential.connectionId, credential.deviceId, credential.serverId].join("\u001f");
}

function filesComposerSourceIsCurrent(files: MobileFilesState, source: MobileFilesComposerSource): boolean {
  if (files.previewPager) return files.preview?.kind !== "loading" && files.previewPager.pages[files.previewPager.index]?.source === source;
  if (source.kind === "workspace-entry") return files.entries.includes(source.entry);
  if (source.kind === "artifact") return files.artifacts.includes(source.artifact);
  return files.searchResults.includes(source.result);
}

function mobileFilesWorkspaceClipboardValue(relativePath: string): Pick<MobileFilesClipboardLease, "text" | "kind"> {
  const path = canonicalWorkspacePath(relativePath);
  if (!path) throw new Error("The canonical Workspace file path is unavailable.");
  return { text: path, kind: "path" };
}

function mobileFilesGeneratedClipboardValue(fileName: string | undefined): Pick<MobileFilesClipboardLease, "text" | "kind"> {
  if (!fileName || fileName === "." || fileName === ".." || fileName.length > 4096
    || /[\\/\u0000-\u001f\u007f]/u.test(fileName)) throw new Error("The canonical Generated filename is unavailable.");
  return { text: fileName, kind: "file-name" };
}

function filesAttachmentMetadata(
  fileName: string,
  mediaType: string,
  byteSize: bigint,
  current: readonly MobileComposerAttachment[],
  controls: MobileAttachmentControls
): { readonly fileName: string; readonly mediaType: string; readonly byteSize: number } | undefined {
  if (byteSize > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  try {
    assertMobileAttachmentPolicy(current, controls.policy);
    if (current.length >= controls.policy.maximumItems) return undefined;
    const exact = assertMobileAttachmentCandidate({ fileName, mediaType, byteSize: Number(byteSize) }, controls.policy);
    return { fileName: exact.fileName, mediaType: exact.mediaType, byteSize: Number(byteSize) };
  } catch {
    return undefined;
  }
}

function workspaceComposerBlob(
  workspaceId: string,
  expected: WorkspaceEntry,
  preview: FilePreview
): BlobRef | undefined {
  const entry = preview.entry;
  const revision = entry?.revision;
  if (!entry || !revision || entry.workspaceId !== workspaceId
    || entry.relativePath !== expected.relativePath || entry.kind !== FileKind.REGULAR
    || expected.kind !== FileKind.REGULAR || !expected.revision
    || !workspaceComposerRevisionMatches(expected.revision, revision)) {
    throw new Error("The Joko node returned a mismatched Workspace file while preparing the composer item.");
  }
  const mediaType = normalizeMediaType(entry.mediaType) || "application/octet-stream";
  const expectedMediaType = normalizeMediaType(expected.mediaType) || "application/octet-stream";
  if (mediaType !== expectedMediaType) {
    throw new Error("The Workspace file media type changed while preparing the composer item.");
  }
  const blob = preview.content.case === "image"
    ? preview.content.value.blob
    : preview.content.case === "blob"
      ? preview.content.value
      : undefined;
  if (preview.content.case === "image" && !blob) {
    throw new Error("The Joko node returned an image preview without its canonical Blob.");
  }
  if (!blob) return undefined;
  if (!blob.blobId || !/^[0-9a-f]{64}$/u.test(blob.sha256Hex)
    || normalizeMediaType(blob.mediaType) !== mediaType
    || blob.byteSize !== revision.byteSize || blob.sha256Hex !== revision.sha256Hex) {
    throw new Error("The Joko node returned mismatched Workspace Blob metadata.");
  }
  return blob;
}

function workspaceComposerRevisionMatches(expected: FileRevision, actual: FileRevision): boolean {
  workspaceEntryRevisionKey(actual);
  if (workspaceEntryRevisionKey(expected) === workspaceEntryRevisionKey(actual)) return true;
  if (expected.opaqueRevision.startsWith("sha256:") || !actual.opaqueRevision.startsWith("sha256:")
    || !/^[0-9a-f]{64}$/u.test(actual.sha256Hex)
    || actual.opaqueRevision !== `sha256:${actual.sha256Hex}:${actual.byteSize.toString(10)}`) return false;
  if (expected.sha256Hex !== "" && expected.sha256Hex !== actual.sha256Hex) return false;
  if (expected.byteSize !== 0n && expected.byteSize !== actual.byteSize) return false;
  if (expected.modifiedAt !== undefined && (actual.modifiedAt === undefined
    || expected.modifiedAt.seconds !== actual.modifiedAt.seconds
    || expected.modifiedAt.nanos !== actual.modifiedAt.nanos)) return false;
  return true;
}

function sameFilesComposerArtifact(left: Artifact, right: Artifact): boolean {
  return left.artifactId === right.artifactId
    && left.sessionId === right.sessionId
    && left.runId === right.runId
    && left.kind === right.kind
    && sameFilesComposerBlob(left.blob, right.blob);
}

function countArtifactIds(artifacts: readonly Artifact[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const artifact of artifacts) counts.set(artifact.artifactId, (counts.get(artifact.artifactId) ?? 0) + 1);
  return counts;
}

function sameFilesComposerArtifactCandidate(
  left: MobileArtifactMentionCandidate,
  right: MobileArtifactMentionCandidate
): boolean {
  return left.artifactId === right.artifactId
    && left.sourceSessionId === right.sourceSessionId
    && left.displayText === right.displayText
    && left.sourceDisplayText === right.sourceDisplayText
    && left.artifactKind === right.artifactKind
    && left.fileName === right.fileName
    && normalizeMediaType(left.mediaType) === normalizeMediaType(right.mediaType)
    && left.byteSize === right.byteSize;
}

function sameFilesComposerBlob(left: BlobRef | undefined, right: BlobRef | undefined): boolean {
  if (!left || !right) return left === right;
  return left.blobId === right.blobId
    && left.fileName === right.fileName
    && normalizeMediaType(left.mediaType) === normalizeMediaType(right.mediaType)
    && left.byteSize === right.byteSize
    && left.sha256Hex === right.sha256Hex
    && left.disposition === right.disposition;
}

function sameFilesWorkspaceEntry(left: WorkspaceEntry, right: WorkspaceEntry): boolean {
  if (left.workspaceId !== right.workspaceId || left.relativePath !== right.relativePath
    || left.kind !== right.kind || normalizeMediaType(left.mediaType) !== normalizeMediaType(right.mediaType)) return false;
  if (left.kind !== FileKind.REGULAR || right.kind !== FileKind.REGULAR) return true;
  if (!left.revision || !right.revision) return false;
  return workspaceEntryRevisionKey(left.revision) === workspaceEntryRevisionKey(right.revision);
}

function mobileGalleryPageMatchesFilesSource(
  page: MobileImageGalleryPage,
  source: MobileFilesComposerSource
): boolean {
  const artifact = filesComposerArtifact(source);
  if (artifact) {
    return page.source.kind === "artifact" && page.source.artifactId === artifact.artifactId
      && page.source.sessionId === artifact.sessionId;
  }
  if (page.source.kind !== "workspace") return false;
  if (source.kind === "workspace-entry") {
    return page.source.relativePath === source.entry.relativePath
      && (!source.entry.revision || page.source.revisionKey === workspaceEntryRevisionKey(source.entry.revision));
  }
  if (source.kind !== "search-result" || source.result.kind === "artifact") return false;
  const path = source.result.kind === "workspace-content"
    ? source.result.match.relativePath
    : source.result.relativePath;
  if (page.source.relativePath !== path) return false;
  return source.result.kind !== "workspace-content" || !source.result.match.revision
    || page.source.revisionKey === workspaceEntryRevisionKey(source.result.match.revision);
}

function mobileFilesGalleryWindowKey(files: MobileFilesState): string {
  const location = files.location.kind === "workspace" ? `workspace:${files.location.path}` : "generated";
  const entries = files.entries.map((entry) => [
    entry.workspaceId,
    entry.relativePath,
    entry.kind.toString(10),
    normalizeMediaType(entry.mediaType),
    entry.revision ? workspaceEntryRevisionKey(entry.revision) : ""
  ].join("\u001e")).join("\u001d");
  const artifacts = files.artifacts.map((artifact) => [
    artifact.artifactId,
    artifact.sessionId,
    artifact.runId,
    artifact.kind.toString(10),
    artifact.blob?.blobId ?? "",
    normalizeMediaType(artifact.blob?.mediaType ?? ""),
    artifact.blob?.byteSize.toString(10) ?? "",
    artifact.blob?.sha256Hex ?? ""
  ].join("\u001e")).join("\u001d");
  const search = files.searchResults.map((result) => {
    if (result.kind === "artifact") return `artifact:${result.artifact.artifactId}`;
    if (result.kind === "workspace-name") return `name:${result.relativePath}`;
    return `content:${result.match.relativePath}:${result.match.revision ? workspaceEntryRevisionKey(result.match.revision) : ""}`;
  }).join("\u001d");
  return [
    files.authorityKey ?? "",
    location,
    files.directoryRevision ?? "",
    files.artifactsRevision ?? "",
    files.fileIndexRevision ?? "",
    files.searchQuery,
    files.searchMode,
    files.searchCaseSensitive ? "1" : "0",
    files.searchStatus,
    entries,
    artifacts,
    search
  ].join("\u001f");
}

function supportsText(backend: Snapshot["backends"][number]): boolean {
  return backend.capabilities?.capabilities.some((item) => item.name === capabilityNames.inputText && item.support === CapabilitySupport.SUPPORTED) === true;
}

function groupWorkspacePathPasteCandidates(
  values: readonly string[]
): ReadonlyMap<string, readonly string[]> {
  const grouped = new Map<string, string[]>();
  for (const value of values) {
    const path = canonicalWorkspacePath(value);
    const parent = workspaceParentPath(path);
    const current = grouped.get(parent) ?? [];
    if (!current.includes(path)) grouped.set(parent, [...current, path]);
  }
  return grouped;
}

function sameMobileModelSelection(
  expected: MobileModelControlSelection,
  actual: Session["model"]
): boolean {
  return actual?.model?.providerId === expected.providerId
    && actual.model.modelId === expected.modelId
    && actual.effortId === (expected.effortId ?? "")
      && decodeModelSpeed(actual) === expected.fastMode;
}

function uniqueValue<T>(values: readonly T[], predicate: (value: T) => boolean): T | undefined {
  const matches = values.filter(predicate);
  return matches.length === 1 ? matches[0] : undefined;
}

function savedConnection(
  profile: MobileConnectionProfile,
  automatic: boolean,
  credentialState: SavedCredentialState,
  pendingOperations: readonly PendingOperation[],
  error?: string
): SavedMobileConnection {
  return {
    ...profile,
    automatic,
    credentialState,
    pendingOperations,
    ...(error === undefined ? {} : { error })
  };
}

function upsertProfile(
  profiles: readonly MobileConnectionProfile[],
  profile: MobileConnectionProfile
): MobileConnectionProfile[] {
  return [
    ...profiles.filter((candidate) => candidate.profileId !== profile.profileId && candidate.connectionId !== profile.connectionId),
    profile
  ];
}

function credentialMatchesProfile(credential: PairedCredential, profile: MobileConnectionProfile): boolean {
  return credential.profileId === profile.profileId && credential.origin === profile.origin
    && credential.serverId === profile.serverId && credential.connectionId === profile.connectionId
    && credential.deviceId === profile.deviceId && credential.endpointPublicKey === profile.endpointPublicKey
    && (credential.transportKind ?? 'https') === (profile.transportKind ?? 'https');
}

function credentialFailure(error: unknown): Extract<SavedCredentialState, "unavailable" | "unreadable"> {
  return error instanceof MobileCredentialStorageError && error.failure === "unreadable" ? "unreadable" : "unavailable";
}

function mergeDiscoveryCandidates(nodes: readonly DiscoveredNodeRecord[]): DiscoveredNodeRecord[] {
  const candidates = new Map<string, DiscoveredNodeRecord>();
  const conflicts = new Set<string>();
  for (const node of nodes) {
    const previous = candidates.get(node.serverId);
    if (previous !== undefined && previous.origin !== node.origin) {
      candidates.delete(node.serverId);
      conflicts.add(node.serverId);
      continue;
    }
    if (!conflicts.has(node.serverId)) candidates.set(node.serverId, node);
  }
  return [...candidates.values()].sort((left, right) =>
    left.displayName.localeCompare(right.displayName) || left.serverId.localeCompare(right.serverId));
}

function mergeRecentNearby(
  previous: readonly NearbyMobileNode[],
  observed: readonly NearbyMobileNode[]
): NearbyMobileNode[] {
  const byServer = new Map<string, NearbyMobileNode>();
  const conflicts = new Set<string>();
  for (const node of [...previous, ...observed]) {
    const known = byServer.get(node.serverId);
    if (known !== undefined && known.origin !== node.origin) {
      byServer.delete(node.serverId);
      conflicts.add(node.serverId);
      continue;
    }
    if (!conflicts.has(node.serverId)) byServer.set(node.serverId, node);
  }
  return [...byServer.values()].sort((left, right) =>
    left.displayName.localeCompare(right.displayName) || left.serverId.localeCompare(right.serverId));
}

function sameAutomationDeletionPreview(
  left: MobileAutomationDeletionPreview,
  right: MobileAutomationDeletionPreview
): boolean {
  return left.scheduleId === right.scheduleId
    && left.scheduleRevision === right.scheduleRevision
    && left.inflightCount === right.inflightCount
    && left.generatedSessionIds.length === right.generatedSessionIds.length
    && left.generatedSessionIds.every((value, index) => value === right.generatedSessionIds[index]);
}

function validMobileAutomationIdentity(value: string): boolean {
  return value.length > 0 && value.length <= 512 && value === value.trim()
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function compareMobileAutomationIdentity(left: string, right: string): number {
  const a = left.toLocaleLowerCase("en-US");
  const b = right.toLocaleLowerCase("en-US");
  return a < b ? -1 : a > b ? 1 : left < right ? -1 : left > right ? 1 : 0;
}

function boundedMobileAutomationName(value: string): string {
  const result = value.trim();
  if (result.length === 0 || result.length > 512 || /[\u0000-\u001f\u007f]/u.test(result)) {
    throw new Error("Enter an Automation copy name of at most 512 characters.");
  }
  return result;
}

function automationMutationRejection(result: TrackedMutationResult, label: string): Error | undefined {
  if (!result.definitive || result.accepted) return undefined;
  return new Error(result.operation?.error?.message || `The Automation ${label} was rejected.`);
}

class CredentialIdentityError extends Error {}
class RevokedError extends Error {}
function isRevoked(error: unknown): boolean {
  if (error instanceof RevokedError) return true;
  const candidate = error as { code?: number };
  return candidate?.code === Code.Unauthenticated;
}
function message(error: unknown): string { return error instanceof Error ? error.message : "The Joko node is unavailable."; }

function isStaleHistory(error: unknown): boolean {
  return (error as { code?: number })?.code === Code.FailedPrecondition
    || error instanceof Error && /task history returned|task history changed/.test(error.message);
}

function validateHistory(events: readonly Event[], sessionId: string, generation?: bigint, before?: EventCursor): void {
  if (!generation) throw new Error("The task history changed while loading. Reconnect before browsing it.");
  let last = 0n;
  const ids = new Set<string>();
  for (const event of events) {
    const cursor = event.cursor;
    if (!event.eventId || ids.has(event.eventId) || event.identity?.sessionId !== sessionId
      || !cursor?.opaqueToken || cursor.generation !== generation || cursor.sequence <= last
      || before && cursor.sequence >= before.sequence) {
      throw new Error("The task history returned a mismatched or cyclic page. Reconnect before browsing it.");
    }
    ids.add(event.eventId);
    last = cursor.sequence;
  }
}

function composerRouteOwnerKey(
  credential: PairedCredential,
  owner: Snapshot,
  expected: Session
): string {
  const matches = owner.sessions.filter((candidate) => candidate.sessionId === expected.sessionId);
  if (matches.length !== 1) return "";
  const session = matches[0]!;
  return JSON.stringify([
    credential.profileId,
    credential.connectionId,
    credential.deviceId,
    credential.serverId,
    owner.scope?.kind.case,
    owner.server?.serverId,
    owner.generation.toString(10),
    owner.snapshotId,
    owner.revision?.value.toString(10) ?? "",
    owner.revision?.etag ?? "",
    session.sessionId,
    session.displayName,
    session.backendId,
    session.targetId,
    session.state,
    session.version?.generation.toString(10) ?? "",
    session.version?.revision?.value.toString(10) ?? "",
    session.version?.revision?.etag ?? "",
    session.nativeBinding?.backendId ?? "",
    session.nativeBinding?.opaqueReference ?? "",
    session.nativeBinding?.runtimeGeneration.toString(10) ?? ""
  ]);
}

function timelineGalleryPagesForSelection(
  events: readonly Event[],
  eventId: string,
  pageId: string
): readonly MobileImageGalleryPage[] {
  const rows = timelineRows(events).filter((row) => row.images?.some((image) =>
    image.sourceEventId === eventId && image.pageId === pageId));
  if (rows.length !== 1) return [];
  const images = rows[0]!.images ?? [];
  const pages = images.flatMap((image) => {
    const sources = events.filter((event) => event.eventId === image.sourceEventId);
    if (sources.length !== 1) return [];
    return mobileTimelineGalleryPages(sources[0]!).filter((page) => page.pageId === image.pageId);
  });
  return pages.length === images.length ? pages : [];
}

function historyInvalidated(event: Event): boolean {
  switch (event.payload?.kind.case) {
    case "messageDeleted":
    case "sessionReset":
    case "historyPruned": return true;
    case "nativeBranchChanged": return event.payload.kind.value.timelineRebuilt;
    default: return false;
  }
}
