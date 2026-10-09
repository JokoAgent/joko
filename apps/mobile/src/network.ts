import { Code, ConnectError, createClient, type Interceptor, type Transport } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import {
  ArtifactKind, ArtifactService, BlobDisposition, ConnectionService, DeviceKind, EventService, FileKind, ImageThumbnailUnavailableReason,
  MobilePushEnvironment as WireMobilePushEnvironment, MobilePushLocale as WireMobilePushLocale,
  MobilePushProvider, OperationService, OperationState, PartnerService, PermissionMode, RemoteDesktopService, ExtensionService,
  ExtensionLibraryLocationKind,
  ResourceKind, SchedulerService, SessionService, TargetService, VoiceInputService, SettingsService, CredentialService, CredentialKind,
  type VoiceInputServiceSettings, type TestVoiceInputConnectionResponse,
  VoiceInputDictionaryEntrySource, VoiceInputDictionaryLearningActionType,
  VoiceInputDictionaryLearningConfidence, VoiceInputDictionaryTermType,
  nextVoiceDictionaryWatchSequence, projectVoiceDictionaryPeerStatus, readVoiceDictionaryPeerInvitation, type VoiceDictionaryPeerListener, type VoiceDictionaryPeerStatusView,
  projectVoiceDictionaryReadOnly, type VoiceDictionaryReadOnlyView,
  WorktreeEligibility, WorktreeService,
  TransferDirection, WorkspaceEntryListingPolicy, WorkspaceFileChangeKind, WorkspaceService,
  SubagentService, type BackgroundTask, type SubagentRun, type SubagentRunDetail, type SubagentTranscriptEntry,
  JOKO_API_VERSION, SessionMessageSearchSemanticMode, SessionMessageSearchSessionStatus,
  isPrivateLanDiscoveryHost, validateDiscoveredNode,
  type Artifact, type BlobRef, type BlobTransferTicket, type Connection, type Device, type DeviceNameSource, type DevicePeerDescriptor,
  type DevicePeerRouteIdentity, type DiscoveredNodeRecord, type ImageThumbnail,
  type Event, type EventCursor, type FilePreview, type FileRevision, type Operation, type OperationMutation,
  type NativeSessionTree, type PendingBlobUpload, type RuntimeCommand, type Schedule, type ScheduleRunHistory,
  type SchedulerRuntimeSnapshot, type SessionMessageSearchMatch, type SessionResource, type Snapshot, type Target, type TaskTagDeletePreview,
  type WorkspaceEntry, type WorkspaceFileChange, type WorkspaceHtmlReference, type ListPartnerSessionsResponse,
  type RemoteDesktopCapabilities, type RemoteDesktopControlState, type RemoteDesktopCursor,
  type RemoteDesktopDisplayMode, type RemoteDesktopFrameResult,
  type RemoteDesktopClipboardContentRequest, type RemoteDesktopClipboardContentResult,
  type RemoteDesktopClipboardTextRequest, type RemoteDesktopClipboardTextResult,
  type RemoteDesktopIceCandidate, type RemoteDesktopIceExchangeResult, type RemoteDesktopIceServer,
  type RemoteDesktopInputEvent, type RemoteDesktopLease, type RemoteDesktopOfferResult,
  type RemoteDesktopPermissions, type RemoteDesktopStartMode, type RemoteDesktopVideoSettings,
  type WorkspaceSearchMatch, type WorkspaceChangeSet, type WorkspaceRewindPreview
} from "@joko/contracts";
import {
  canonicalWorkspacePath,
  normalizeMediaType,
  workspaceEntryRevisionKey,
  workspaceParentPath
} from "./workspace-files";
import {
  projectMobileVoiceCapability,
  projectMobileVoiceSession,
  type MobileVoiceCapability,
  type MobileVoiceSession
} from "./mobile-voice-input";
import {
  MAXIMUM_MOBILE_VOICE_ADVICE_TEXT_CHARACTERS,
  type MobileVoiceDictionaryAdviceDraft,
  type MobileVoiceDictionaryLearningAction
} from "./mobile-voice-dictionary";
import type { MobileVoiceRefinementContext } from "./mobile-voice-input";
import { assertMobileVoiceServiceSettings } from "./mobile-voice-service-settings";
import { normalizeMobileVoiceRecognitionContext, type MobileVoiceRecognitionContext } from "./mobile-voice-recognition-context";
import {
  mobileVoiceDictionaryLearningRequest,
  projectMobileVoiceDictionarySnapshot,
  type MobileVoiceDictionarySnapshot
} from "./mobile-voice-dictionary-service";
import {
  projectMobilePartners, projectMobilePrivateDetail, projectMobilePrivateReadResponse,
  projectMobilePrivateThreads, validMobilePartnerId,
  type MobilePartner, type MobilePrivateDetail, type MobilePrivateReadState,
  type MobilePrivateThread
} from "./mobile-partner-private";
import {
  projectMobilePartnerCatalog,
  projectMobilePartnerReadResponse,
  type MobilePartnerActivity,
  type MobilePartnerCatalog
} from "./mobile-partner-directory";
import { projectMobilePartnerProfileOptions, projectMobilePartnerProfileUpdate,
  type MobilePartnerProfileDraft, type MobilePartnerProfileOptions } from "./mobile-partner-profile";
import { projectMobilePartnerInitializationRetry } from "./mobile-partner-initialization";
import type { MobilePartnerDirectoryProfile } from "./mobile-partner-directory";
import {
  collectMobileExtensionCatalog,
  projectMobileExtension,
  projectMobileExtensionMainViewSurface,
  type MobileExtension,
  type MobileExtensionCatalog,
  type MobileExtensionCredentialKind,
  type MobileExtensionMainViewSurface
} from "./mobile-extensions";
import {
  normalizeMobileExtensionLibraryCandidate,
  projectMobileExtensionLibraryGraceList,
  projectMobileExtensionLibraryLocation,
  projectMobileExtensionLibraryLocationValidation,
  projectMobileExtensionLibraryOverview,
  projectMobileExtensionLibraryTrash,
  projectMobileExtensionLibraryTrashList,
  projectMobileExtensionLibraryWarnings,
  type MobileExtensionLibraryGraceEntry,
  type MobileExtensionLibraryLocationValidation,
  type MobileExtensionLibraryOverview,
  type MobileExtensionLibraryTrashEntry
} from "./mobile-extension-library";
import {
  assertMobileExtensionLibraryCallResult,
  mapMobileExtensionLibraryCall,
  projectMobileExtensionLibraryCallResult,
  projectMobileExtensionLibrarySession,
  type MobileExtensionLibraryCall,
  type MobileExtensionLibraryCallResult,
  type MobileExtensionLibrarySession
} from "./mobile-extension-library-runtime";

export interface PairedCredential {
  readonly profileId: string;
  readonly origin: string;
  readonly serverId: string;
  readonly connectionId: string;
  readonly deviceId: string;
  readonly displayName: string;
  readonly authKey: string;
}

export interface NodeIdentity {
  readonly serverId: string;
  readonly displayName: string;
  readonly version: string;
  readonly apiVersion: string;
  readonly health: number;
  readonly pairingEnabled: boolean;
}

export type MobilePushEnvironment = "sandbox" | "production";
export type MobilePushLocale = "en" | "zh-CN" | "zh-TW" | "ja" | "ko";

export interface MobilePushRevocationTicket {
  readonly serverId: string;
  readonly registrationId: string;
  readonly secret: string;
}

export interface MobilePushRegistrationInput {
  readonly expectedDeviceRevision: bigint;
  readonly environment: MobilePushEnvironment;
  readonly locale: MobilePushLocale;
  readonly deviceToken: string;
  readonly ticket: MobilePushRevocationTicket;
}

export interface MobilePushRegistrationResult {
  readonly registrationId: string;
  readonly connectionId: string;
  readonly deviceId: string;
  readonly environment: MobilePushEnvironment;
  readonly locale: MobilePushLocale;
  readonly expiresAt: number;
  readonly revision: bigint;
  readonly ticket: MobilePushRevocationTicket;
}

export interface MobilePushCapabilityResult {
  readonly supported: boolean;
  readonly unavailableReasonCode?: string;
}

export interface MobileNetwork {
  inspect(origin: string, signal?: AbortSignal): Promise<NodeIdentity>;
  discover(origin: string, signal?: AbortSignal): Promise<readonly DiscoveredNodeRecord[]>;
  requestPairing(origin: string, deviceName: string, platform: string, deviceNameSource: DeviceNameSource, signal?: AbortSignal): Promise<{ identity: NodeIdentity; challengeId: string }>;
  completePairing(origin: string, challengeId: string, code: string, deviceName: string, platform: string, deviceNameSource: DeviceNameSource, signal?: AbortSignal): Promise<{ credential: PairedCredential; identity: NodeIdentity }>;
  readOwner(credential: PairedCredential, deviceNameSource: DeviceNameSource, signal?: AbortSignal): Promise<{ connection: Connection; device: Device; snapshot: Snapshot }>;
  listRemoteDesktopHosts?(credential: PairedCredential, signal?: AbortSignal): Promise<readonly DevicePeerDescriptor[]>;
  getRemoteDesktopCapabilities?(credential: PairedCredential, peer: DevicePeerRouteIdentity,
    signal?: AbortSignal): Promise<RemoteDesktopCapabilities>;
  getRemoteDesktopPermissions?(credential: PairedCredential, peer: DevicePeerRouteIdentity,
    signal?: AbortSignal): Promise<RemoteDesktopPermissions>;
  showRemoteDesktopPermissionGuide?(credential: PairedCredential, peer: DevicePeerRouteIdentity,
    signal?: AbortSignal): Promise<RemoteDesktopPermissions>;
  startRemoteDesktop?(credential: PairedCredential, peer: DevicePeerRouteIdentity, displayId: string,
    mode: RemoteDesktopStartMode, signal?: AbortSignal): Promise<RemoteDesktopLease>;
  heartbeatRemoteDesktop?(credential: PairedCredential, peer: DevicePeerRouteIdentity, leaseId: string,
    signal?: AbortSignal): Promise<RemoteDesktopControlState>;
  stopRemoteDesktop?(credential: PairedCredential, peer: DevicePeerRouteIdentity, leaseId: string,
    signal?: AbortSignal): Promise<void>;
  setRemoteDesktopControl?(credential: PairedCredential, peer: DevicePeerRouteIdentity, leaseId: string,
    enabled: boolean, signal?: AbortSignal): Promise<RemoteDesktopControlState>;
  setRemoteDesktopPresentation?(credential: PairedCredential, peer: DevicePeerRouteIdentity, leaseId: string,
    enabled: boolean, signal?: AbortSignal): Promise<RemoteDesktopControlState>;
  sendRemoteDesktopInput?(credential: PairedCredential, peer: DevicePeerRouteIdentity, leaseId: string,
    sequence: bigint, events: readonly RemoteDesktopInputEvent[], signal?: AbortSignal): Promise<void>;
  getRemoteDesktopIceConfiguration?(credential: PairedCredential, peer: DevicePeerRouteIdentity, leaseId: string,
    signal?: AbortSignal): Promise<readonly RemoteDesktopIceServer[]>;
  createRemoteDesktopOffer?(credential: PairedCredential, peer: DevicePeerRouteIdentity, leaseId: string,
    attemptId: string, offerSdp: string, settings: RemoteDesktopVideoSettings | undefined,
    cursorOverlay: boolean, signal?: AbortSignal): Promise<RemoteDesktopOfferResult>;
  exchangeRemoteDesktopIce?(credential: PairedCredential, peer: DevicePeerRouteIdentity, leaseId: string,
    attemptId: string, candidates: readonly RemoteDesktopIceCandidate[], after: number,
    signal?: AbortSignal): Promise<RemoteDesktopIceExchangeResult>;
  getRemoteDesktopFrame?(credential: PairedCredential, peer: DevicePeerRouteIdentity, leaseId: string,
    cursorOverlay: boolean, signal?: AbortSignal): Promise<RemoteDesktopFrameResult>;
  listRemoteDesktopDisplayModes?(credential: PairedCredential, peer: DevicePeerRouteIdentity, leaseId: string,
    signal?: AbortSignal): Promise<readonly RemoteDesktopDisplayMode[]>;
  setRemoteDesktopDisplayMode?(credential: PairedCredential, peer: DevicePeerRouteIdentity, leaseId: string,
    controlGeneration: bigint, modeId: string, signal?: AbortSignal): Promise<void>;
  transferRemoteDesktopClipboardText?(credential: PairedCredential, peer: DevicePeerRouteIdentity,
    transfer: RemoteDesktopClipboardTextRequest, signal?: AbortSignal): Promise<RemoteDesktopClipboardTextResult>;
  transferRemoteDesktopClipboardContent?(credential: PairedCredential, peer: DevicePeerRouteIdentity,
    transfer: RemoteDesktopClipboardContentRequest, signal?: AbortSignal): Promise<RemoteDesktopClipboardContentResult>;
  listPartners(credential: PairedCredential, signal?: AbortSignal): Promise<readonly MobilePartner[]>;
  listPartnerCatalog?(credential: PairedCredential, signal?: AbortSignal): Promise<MobilePartnerCatalog>;
  getPartnerProfileOptions?(credential: PairedCredential, signal?: AbortSignal): Promise<MobilePartnerProfileOptions>;
  updatePartnerProfile?(credential: PairedCredential, partnerId: string, expectedRevision: bigint,
    draft: MobilePartnerProfileDraft, signal?: AbortSignal): Promise<MobilePartnerDirectoryProfile>;
  retryPartnerInitialization?(credential: PairedCredential, partnerId: string, expectedRevision: bigint,
    signal?: AbortSignal): Promise<MobilePartnerDirectoryProfile>;
  markPartnerRead?(credential: PairedCredential, partnerId: string, throughCursor: bigint,
    signal?: AbortSignal): Promise<MobilePartnerActivity>;
  listPartnerSessions(credential: PairedCredential, partnerId: string, signal?: AbortSignal): Promise<ListPartnerSessionsResponse>;
  listExtensions(credential: PairedCredential, signal?: AbortSignal): Promise<MobileExtensionCatalog>;
  getExtension(credential: PairedCredential, extensionId: string, signal?: AbortSignal): Promise<MobileExtension>;
  getExtensionForRuntime(
    credential: PairedCredential,
    extensionId: string,
    sessionId: string,
    signal?: AbortSignal
  ): Promise<MobileExtension>;
  openExtensionMainView(
    credential: PairedCredential,
    extensionId: string,
    expectedRevision: bigint,
    signal?: AbortSignal
  ): Promise<MobileExtensionMainViewSurface>;
  getExtensionMainViewSurface(
    credential: PairedCredential,
    surfaceId: string,
    signal?: AbortSignal
  ): Promise<MobileExtensionMainViewSurface>;
  closeExtensionMainView(
    credential: PairedCredential,
    surfaceId: string,
    signal?: AbortSignal
  ): Promise<boolean>;
  openExtensionLibrary(
    credential: PairedCredential, extensionId: string, expectedRevision: bigint, surfaceId: string, signal?: AbortSignal
  ): Promise<MobileExtensionLibrarySession>;
  callExtensionLibrary(
    credential: PairedCredential, sessionId: string, call: MobileExtensionLibraryCall, signal?: AbortSignal
  ): Promise<MobileExtensionLibraryCallResult>;
  closeExtensionLibrary(credential: PairedCredential, sessionId: string, signal?: AbortSignal): Promise<boolean>;
  getExtensionLibraryOverview(
    credential: PairedCredential,
    extensionId: string,
    expectedRevision: bigint,
    signal?: AbortSignal
  ): Promise<MobileExtensionLibraryOverview>;
  validateExtensionLibraryLocation(
    credential: PairedCredential,
    extensionId: string,
    expectedRevision: bigint,
    candidate: string,
    signal?: AbortSignal
  ): Promise<MobileExtensionLibraryLocationValidation>;
  relocateExtensionLibrary(
    credential: PairedCredential,
    extensionId: string,
    expectedRevision: bigint,
    destination: { readonly kind: "default" } | { readonly kind: "custom"; readonly candidate: string },
    signal?: AbortSignal
  ): Promise<void>;
  rebindExtensionLibrary(
    credential: PairedCredential,
    extensionId: string,
    expectedRevision: bigint,
    candidate: string,
    signal?: AbortSignal
  ): Promise<void>;
  unbindExtensionLibrary(
    credential: PairedCredential,
    extensionId: string,
    expectedRevision: bigint,
    signal?: AbortSignal
  ): Promise<void>;
  repairExtensionLibraryState(credential: PairedCredential, signal?: AbortSignal): Promise<void>;
  repairExtensionLibraryMetadata(
    credential: PairedCredential,
    extensionId: string,
    expectedRevision: bigint,
    signal?: AbortSignal
  ): Promise<void>;
  trashExtensionLibrary(
    credential: PairedCredential,
    extensionId: string,
    expectedRevision: bigint,
    confirmation: string,
    signal?: AbortSignal
  ): Promise<void>;
  listExtensionLibraryTrash(
    credential: PairedCredential,
    extensionId: string,
    signal?: AbortSignal
  ): Promise<readonly MobileExtensionLibraryTrashEntry[]>;
  restoreExtensionLibraryTrash(
    credential: PairedCredential,
    extensionId: string,
    trashId: string,
    confirmation: string,
    destination: "original" | "default",
    signal?: AbortSignal
  ): Promise<void>;
  purgeExtensionLibraryTrash(
    credential: PairedCredential,
    extensionId: string,
    trashId: string,
    confirmation: string,
    signal?: AbortSignal
  ): Promise<void>;
  listExtensionLibraryGrace(
    credential: PairedCredential,
    extensionId: string,
    signal?: AbortSignal
  ): Promise<readonly MobileExtensionLibraryGraceEntry[]>;
  rollbackExtensionLibrary(
    credential: PairedCredential,
    extensionId: string,
    expectedRevision: bigint,
    graceId: string,
    signal?: AbortSignal
  ): Promise<void>;
  uploadExtensionSetupCredential(
    credential: PairedCredential,
    extensionId: string,
    attemptId: string,
    fieldId: string,
    kind: MobileExtensionCredentialKind,
    secret: string,
    signal?: AbortSignal
  ): Promise<string>;
  listPartnerPrivateThreads(credential: PairedCredential, partnerId: string, signal?: AbortSignal): Promise<readonly MobilePrivateThread[]>;
  getPartnerPrivateThread(credential: PairedCredential, partnerId: string, threadId: string, signal?: AbortSignal): Promise<MobilePrivateDetail>;
  markPartnerPrivateThreadRead(credential: PairedCredential, partnerId: string, threadId: string,
    throughSequence: number, maximumSequence: number, signal?: AbortSignal): Promise<MobilePrivateReadState>;
  getMobilePushCapability(origin: string, signal?: AbortSignal): Promise<MobilePushCapabilityResult>;
  registerMobilePush(credential: PairedCredential, input: MobilePushRegistrationInput,
    signal?: AbortSignal): Promise<MobilePushRegistrationResult>;
  unregisterMobilePush(origin: string, ticket: MobilePushRevocationTicket, signal?: AbortSignal): Promise<void>;
  readSession(credential: PairedCredential, sessionId: string, signal?: AbortSignal): Promise<Snapshot>;
  readNativeSessionTree(credential: PairedCredential, sessionId: string, signal?: AbortSignal): Promise<NativeSessionTree>;
  previewTaskTagDeletion(credential: PairedCredential, taskTagId: string, signal?: AbortSignal): Promise<TaskTagDeletePreview>;
  listBackgroundTasks(credential: PairedCredential, sessionId: string, pageToken?: string, signal?: AbortSignal): Promise<{ tasks: readonly BackgroundTask[]; nextPageToken: string }>;
  listSubagentRuns(credential: PairedCredential, sessionId: string, pageToken?: string, signal?: AbortSignal): Promise<{ runs: readonly SubagentRun[]; nextPageToken: string }>;
  getSubagentRun(credential: PairedCredential, sessionId: string, runId: string, signal?: AbortSignal): Promise<SubagentRunDetail>;
  listSubagentTranscript(credential: PairedCredential, sessionId: string, runId: string, childId?: string, pageToken?: string, signal?: AbortSignal): Promise<{ entries: readonly SubagentTranscriptEntry[]; nextPageToken: string; tailPageToken: string }>;
  readHistory(credential: PairedCredential, sessionId: string, before?: EventCursor, signal?: AbortSignal): Promise<{ events: Event[]; before?: EventCursor }>;
  readAround(credential: PairedCredential, sessionId: string, eventId: string, signal?: AbortSignal): Promise<Event[]>;
  searchSessionMessages(credential: PairedCredential, query: string, status: SessionMessageSearchSessionStatus, signal?: AbortSignal): Promise<readonly SessionMessageSearchMatch[]>;
  streamOwner(credential: PairedCredential, after: EventCursor, signal: AbortSignal): AsyncIterable<Event>;
  listWorkspaceDirectory(credential: PairedCredential, workspaceId: string, parentPath: string, signal?: AbortSignal): Promise<WorkspaceDirectorySnapshot>;
  listWorkspaceChangeSets(credential: PairedCredential, workspaceId: string, sessionId: string, signal?: AbortSignal): Promise<readonly WorkspaceChangeSet[]>;
  previewWorkspaceRewind(credential: PairedCredential, workspaceId: string, changeSetId: string, signal?: AbortSignal): Promise<WorkspaceRewindPreview>;
  listWorkspaceFileIndex(credential: PairedCredential, workspaceId: string, signal?: AbortSignal): Promise<WorkspaceFileIndexSnapshot>;
  searchWorkspace(credential: PairedCredential, workspaceId: string, query: string, caseSensitive: boolean, signal?: AbortSignal): Promise<WorkspaceSearchSnapshot>;
  watchWorkspace(credential: PairedCredential, workspaceId: string, signal: AbortSignal): AsyncIterable<WorkspaceFileChange>;
  readWorkspaceFile(credential: PairedCredential, workspaceId: string, relativePath: string, revision: FileRevision, signal?: AbortSignal): Promise<FilePreview>;
  readWorkspaceHtmlSnapshot(credential: PairedCredential, sessionId: string, file: Pick<WorkspaceHtmlReference, "workspaceId" | "relativePath" | "expectedRevision">,
    signal?: AbortSignal): Promise<{ readonly file: WorkspaceHtmlReference; readonly html: string }>;
  materializeWorkspaceFileBlob(credential: PairedCredential, workspaceId: string, relativePath: string, revision: FileRevision, signal?: AbortSignal): Promise<MaterializedWorkspaceBlob>;
  listSessionArtifacts(credential: PairedCredential, sessionId: string, signal?: AbortSignal): Promise<ArtifactCatalogSnapshot>;
  listRuntimeCommands(credential: PairedCredential, sessionId: string, signal?: AbortSignal): Promise<readonly RuntimeCommand[]>;
  listSessionResources(credential: PairedCredential, sessionId: string, signal?: AbortSignal): Promise<readonly SessionResource[]>;
  listArtifactReferenceCatalog(credential: PairedCredential, sessionId: string, generation: bigint, signal?: AbortSignal): Promise<ArtifactCatalogSnapshot>;
  listSchedules(credential: PairedCredential, signal?: AbortSignal): Promise<readonly Schedule[]>;
  readSchedule(credential: PairedCredential, scheduleId: string, signal?: AbortSignal): Promise<Schedule>;
  listScheduleHistory(credential: PairedCredential, scheduleId: string, pageToken?: string, signal?: AbortSignal): Promise<ScheduleHistoryPage>;
  readSchedulerRuntime(credential: PairedCredential, signal?: AbortSignal): Promise<SchedulerRuntimeSnapshot>;
  probeTargetWorktree(credential: PairedCredential, targetId: string, signal?: AbortSignal): Promise<MobileTargetWorktreeProbe>;
  listTargetWorktreeSources(credential: PairedCredential, targetId: string, signal?: AbortSignal): Promise<readonly MobileTargetWorktreeSource[]>;
  downloadBlob(credential: PairedCredential, blob: BlobRef, signal?: AbortSignal): Promise<VerifiedBlobDownload>;
  readImageThumbnail(credential: PairedCredential, blob: BlobRef, edge: 256 | 1024, signal?: AbortSignal): Promise<ImageThumbnail | undefined>;
  authorizeBlobDownload(credential: PairedCredential, blob: BlobRef, signal?: AbortSignal): Promise<AuthorizedBlobDownload>;
  uploadBlob(credential: PairedCredential, source: MobileBlobUploadSource, signal?: AbortSignal): Promise<BlobRef>;
  getVoiceInputCapabilities(credential: PairedCredential, signal?: AbortSignal): Promise<MobileVoiceCapability>;
  getVoiceInputServiceSettings(credential: PairedCredential, signal?: AbortSignal): Promise<VoiceInputServiceSettings>;
  uploadVoiceInputSecret(credential: PairedCredential, secret: string, fallback: boolean, signal?: AbortSignal): Promise<string>;
  testVoiceInputConnection(credential: PairedCredential, signal?: AbortSignal): Promise<TestVoiceInputConnectionResponse>;
  getVoiceInputDictionary(credential: PairedCredential, signal?: AbortSignal): Promise<MobileVoiceDictionarySnapshot>;
  getVoiceInputDictionaryReadOnly(credential: PairedCredential, signal?: AbortSignal): Promise<VoiceDictionaryReadOnlyView>;
  watchVoiceInputDictionaryReadOnly(credential: PairedCredential, signal: AbortSignal): AsyncIterable<VoiceDictionaryReadOnlyView>;
  getVoiceInputDictionaryPeerStatus(credential: PairedCredential, signal?: AbortSignal): Promise<VoiceDictionaryPeerStatusView>;
  watchVoiceInputDictionary(credential: PairedCredential, signal: AbortSignal): AsyncIterable<MobileVoiceDictionarySnapshot>;
  watchVoiceInputDictionaryPeerStatus(credential: PairedCredential, signal: AbortSignal): AsyncIterable<VoiceDictionaryPeerStatusView>;
  grantVoiceInputDictionaryPeer(credential: PairedCredential, expectedConfigurationRevision: bigint, peerId: string, expectedFingerprint: string, signal?: AbortSignal): Promise<VoiceDictionaryPeerStatusView>;
  revokeVoiceInputDictionaryPeer(credential: PairedCredential, peerId: string, expectedGrantRevision: bigint, signal?: AbortSignal): Promise<VoiceDictionaryPeerStatusView>;
  syncVoiceInputDictionaryNow(credential: PairedCredential, expectedConfigurationRevision: bigint, peerId: string | undefined, signal?: AbortSignal): Promise<VoiceDictionaryPeerStatusView>;
  configureVoiceInputDictionaryListener(credential: PairedCredential, expectedConfigurationRevision: bigint, listener: VoiceDictionaryPeerListener | undefined, signal?: AbortSignal): Promise<VoiceDictionaryPeerStatusView>;
  getVoiceInputDictionaryPeerInvitation(credential: PairedCredential, signal?: AbortSignal): Promise<string>;
  grantVoiceInputDictionaryDirectPeer(credential: PairedCredential, expectedConfigurationRevision: bigint, invitation: string, expectedFingerprint: string, signal?: AbortSignal): Promise<VoiceDictionaryPeerStatusView>;
  clearVoiceInputDictionaryPeerRoute(credential: PairedCredential, expectedConfigurationRevision: bigint, peerId: string, signal?: AbortSignal): Promise<VoiceDictionaryPeerStatusView>;
  setVoiceInputDictionarySyncEnabled(credential: PairedCredential, expectedRevision: bigint, enabled: boolean, signal?: AbortSignal): Promise<MobileVoiceDictionarySnapshot>;
  addVoiceInputDictionaryTerms(credential: PairedCredential, expectedRevision: bigint, terms: readonly string[], signal?: AbortSignal): Promise<MobileVoiceDictionarySnapshot>;
  editVoiceInputDictionaryEntry(credential: PairedCredential, expectedRevision: bigint, entryId: string, text: string, aliases: readonly string[], signal?: AbortSignal): Promise<MobileVoiceDictionarySnapshot>;
  deleteVoiceInputDictionaryEntry(credential: PairedCredential, expectedRevision: bigint, entryId: string, signal?: AbortSignal): Promise<MobileVoiceDictionarySnapshot>;
  applyVoiceInputDictionaryLearning(credential: PairedCredential, expectedRevision: bigint, actions: readonly MobileVoiceDictionaryLearningAction[], signal?: AbortSignal): Promise<MobileVoiceDictionarySnapshot>;
  adviseVoiceInputDictionaryEdit(credential: PairedCredential, draft: MobileVoiceDictionaryAdviceDraft,
    signal?: AbortSignal): Promise<{ readonly actions: readonly MobileVoiceDictionaryLearningAction[] }>;
  startVoiceInput(credential: PairedCredential, requestId: string, mimeType: string, locale?: string,
    refinement?: MobileVoiceRefinementContext, signal?: AbortSignal, recognitionContext?: MobileVoiceRecognitionContext): Promise<MobileVoiceSession>;
  appendVoiceAudio(credential: PairedCredential, voiceInputId: string, chunkSequence: bigint, audio: Uint8Array, durationMs: number, voiced: boolean, signal?: AbortSignal): Promise<MobileVoiceSession>;
  stopVoiceInput(credential: PairedCredential, voiceInputId: string, expectedNextChunkSequence: bigint, signal?: AbortSignal): Promise<MobileVoiceSession>;
  cancelVoiceInput(credential: PairedCredential, voiceInputId: string, signal?: AbortSignal): Promise<MobileVoiceSession>;
  getVoiceInputSession(credential: PairedCredential, voiceInputId: string, signal?: AbortSignal): Promise<MobileVoiceSession>;
  prepareTarget(credential: PairedCredential, target: Target, signal?: AbortSignal): Promise<void>;
  submit(credential: PairedCredential, operationId: string, mutation: OperationMutation, signal?: AbortSignal): Promise<Operation>;
  waitOperation(credential: PairedCredential, operationId: string, signal?: AbortSignal): Promise<Operation>;
  getOperation(credential: PairedCredential, operationId: string, signal?: AbortSignal): Promise<Operation | undefined>;
}

export interface WorkspaceDirectorySnapshot {
  readonly entries: readonly WorkspaceEntry[];
  readonly revision: string;
}

export interface WorkspaceFileIndexSnapshot {
  readonly paths: readonly string[];
  readonly revision: string;
  readonly truncated: boolean;
}

export interface WorkspaceSearchSnapshot {
  readonly matches: readonly WorkspaceSearchMatch[];
  readonly revision: string;
  readonly truncated: boolean;
  readonly totalFiles: number;
}

export interface ArtifactCatalogSnapshot {
  readonly artifacts: readonly Artifact[];
  readonly revision: string;
}

export interface ScheduleHistoryPage {
  readonly history: readonly ScheduleRunHistory[];
  readonly nextPageToken: string;
  readonly totalSize: number;
}

export interface MobileTargetWorktreeProbe {
  readonly targetId: string;
  readonly eligibility: "eligible" | "notGitRepository" | "alreadyLinked" | "gitNotFound" | "unsafe" | "unavailable";
  readonly canRefreshRemote: boolean;
}

export interface MobileTargetWorktreeSource {
  readonly ref: string;
  readonly commit: string;
  readonly displayName: string;
  readonly remote: boolean;
  readonly current: boolean;
}

export interface VerifiedBlobDownload {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
}

export interface MaterializedWorkspaceBlob {
  readonly entry: WorkspaceEntry;
  readonly blob: BlobRef;
}

export interface AuthorizedBlobDownload {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly blobId: string;
  readonly fileName: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly sha256Hex: string;
}

export interface MobileBlobUploadSource {
  readonly uri: string;
  readonly fileName: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly sha256Hex: string;
}

export type MobileNativeBlobUploader = (
  endpoint: string,
  sourceUri: string,
  headers: Readonly<Record<string, string>>,
  signal?: AbortSignal
) => Promise<{ readonly status: number; readonly body?: string }>;

interface SessionMessageSearchPage {
  readonly matches: readonly SessionMessageSearchMatch[];
  readonly nextPageToken: string;
  readonly totalSize: bigint;
}

const MESSAGE_SEARCH_PAGE_SIZE = 100;
const WORKSPACE_PAGE_SIZE = 500;
const SCHEDULE_PAGE_SIZE = 100;
const SCHEDULE_HISTORY_PAGE_SIZE = 50;
export const MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES = 32 * 1024 * 1024;
export const MOBILE_FILE_SHARE_MAXIMUM_BYTES = 256 * 1024 * 1024;

interface WorkspaceDirectoryPage {
  readonly entries: readonly WorkspaceEntry[];
  readonly nextPageToken: string;
  readonly totalSize: bigint;
  readonly revision: string;
}

interface WorkspaceSearchPage {
  readonly matches: readonly WorkspaceSearchMatch[];
  readonly nextPageToken: string;
  readonly totalSize: bigint;
  readonly revision: string;
  readonly truncated: boolean;
  readonly totalFiles: bigint;
}

interface ArtifactPage {
  readonly artifacts: readonly Artifact[];
  readonly nextPageToken: string;
  readonly totalSize: bigint;
  readonly revision: string;
}

interface ScheduleCatalogPage {
  readonly schedules: readonly Schedule[];
  readonly nextPageToken: string;
  readonly totalSize: bigint;
}

interface TargetWorktreeSourcePage {
  readonly sources: readonly MobileTargetWorktreeSource[];
  readonly nextPageToken: string;
  readonly totalSize: bigint;
}

function validSchedulePageToken(value: string): boolean {
  return value.length <= 4_096 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function mobileWorktreeEligibility(value: WorktreeEligibility): MobileTargetWorktreeProbe["eligibility"] {
  if (value === WorktreeEligibility.ELIGIBLE) return "eligible";
  if (value === WorktreeEligibility.NOT_GIT_REPOSITORY) return "notGitRepository";
  if (value === WorktreeEligibility.ALREADY_LINKED) return "alreadyLinked";
  if (value === WorktreeEligibility.GIT_NOT_FOUND) return "gitNotFound";
  if (value === WorktreeEligibility.UNSAFE) return "unsafe";
  if (value === WorktreeEligibility.UNAVAILABLE) return "unavailable";
  throw new Error("The Joko node returned an unspecified Worktree eligibility.");
}

export async function collectSchedulePages(
  readPage: (pageToken: string) => Promise<ScheduleCatalogPage>
): Promise<readonly Schedule[]> {
  const schedules: Schedule[] = [];
  const identities = new Set<string>();
  const pageTokens = new Set<string>();
  let pageToken = "";
  let totalSize: bigint | undefined;
  while (true) {
    const page = await readPage(pageToken);
    if (page.totalSize < 0n || page.totalSize > 10_000n || page.schedules.length > SCHEDULE_PAGE_SIZE
      || !validSchedulePageToken(page.nextPageToken)) {
      throw new Error("The Joko node returned invalid Automation catalog metadata.");
    }
    if (totalSize === undefined) totalSize = page.totalSize;
    else if (page.totalSize !== totalSize) throw new Error("The Automation catalog changed while paging.");
    for (const schedule of page.schedules) {
      if (!schedule.scheduleId || identities.has(schedule.scheduleId)) {
        throw new Error("The Joko node returned a duplicate or missing Automation Schedule identity.");
      }
      identities.add(schedule.scheduleId);
      schedules.push(schedule);
    }
    if (!page.nextPageToken) {
      if (BigInt(schedules.length) !== totalSize) throw new Error("The Joko node returned an incomplete Automation catalog.");
      return schedules;
    }
    if (page.schedules.length === 0 || page.nextPageToken === pageToken || pageTokens.has(page.nextPageToken)
      || pageTokens.size >= 10_000) {
      throw new Error("The Joko node returned a cyclic Automation catalog page token.");
    }
    pageTokens.add(page.nextPageToken);
    pageToken = page.nextPageToken;
  }
}

export async function collectTargetWorktreeSourcePages(
  readPage: (pageToken: string) => Promise<TargetWorktreeSourcePage>
): Promise<readonly MobileTargetWorktreeSource[]> {
  const sources: MobileTargetWorktreeSource[] = [];
  const refs = new Set<string>();
  const pageTokens = new Set<string>();
  let pageToken = "";
  let totalSize: bigint | undefined;
  while (true) {
    const page = await readPage(pageToken);
    if (page.totalSize < 0n || page.totalSize > 10_000n || page.sources.length > WORKSPACE_PAGE_SIZE
      || !validSchedulePageToken(page.nextPageToken)) {
      throw new Error("The Joko node returned invalid Worktree source metadata.");
    }
    if (totalSize === undefined) totalSize = page.totalSize;
    else if (totalSize !== page.totalSize) throw new Error("The Worktree source catalog changed while paging.");
    for (const source of page.sources) {
      if (!validCatalogIdentity(source.ref, 4_096) || !validCatalogIdentity(source.commit, 512)
        || !validCatalogLabel(source.displayName) || refs.has(source.ref)) {
        throw new Error("The Joko node returned a duplicate or invalid Worktree source.");
      }
      refs.add(source.ref);
      sources.push(source);
    }
    if (page.nextPageToken === "") {
      if (BigInt(sources.length) !== totalSize) throw new Error("The Joko node returned an incomplete Worktree source catalog.");
      return sources;
    }
    if (page.sources.length === 0 || page.nextPageToken === pageToken || pageTokens.has(page.nextPageToken)
      || pageTokens.size >= 10_000) {
      throw new Error("The Joko node returned a cyclic Worktree source page token.");
    }
    pageTokens.add(page.nextPageToken);
    pageToken = page.nextPageToken;
  }
}

export async function collectWorkspaceChangeSetPages(workspaceId: string, sessionId: string,
  readPage: (pageToken: string) => Promise<{ readonly changeSets: readonly WorkspaceChangeSet[]; readonly nextPageToken: string; readonly totalSize: bigint }>
): Promise<readonly WorkspaceChangeSet[]> {
  const values: WorkspaceChangeSet[] = []; const identities = new Set<string>(); const tokens = new Set<string>();
  let token = ""; let total: bigint | undefined;
  for (let index = 0; index < 256; index++) {
    const page = await readPage(token);
    if (page.totalSize < 0n || page.totalSize > 30_000n || page.changeSets.length > WORKSPACE_PAGE_SIZE
      || !validSchedulePageToken(page.nextPageToken) || total !== undefined && page.totalSize !== total) {
      throw new Error("The Joko node returned invalid or changing Workspace checkpoint metadata.");
    }
    total = page.totalSize;
    for (const value of page.changeSets) {
      if (!validCatalogIdentity(value.changeSetId) || identities.has(value.changeSetId)
        || value.workspaceId !== workspaceId || value.sessionId !== sessionId || !value.capturedAt
        || value.capturedAt.seconds < 0n || value.capturedAt.nanos < 0 || value.capturedAt.nanos >= 1_000_000_000) {
        throw new Error("The Joko node returned a duplicate or foreign Workspace checkpoint.");
      }
      identities.add(value.changeSetId); values.push(value);
    }
    if (!page.nextPageToken) {
      if (BigInt(values.length) !== total) throw new Error("The Workspace checkpoint catalog is incomplete.");
      return values;
    }
    if (!page.changeSets.length || page.nextPageToken === token || tokens.has(page.nextPageToken)) {
      throw new Error("The Workspace checkpoint catalog has a cyclic page token.");
    }
    tokens.add(page.nextPageToken); token = page.nextPageToken;
  }
  throw new Error("The Workspace checkpoint catalog exceeds the safe paging limit.");
}

export function validateScheduleHistoryPage(
  scheduleId: string,
  requestedPageToken: string,
  page: { readonly history: readonly ScheduleRunHistory[]; readonly nextPageToken: string; readonly totalSize: bigint }
): ScheduleHistoryPage {
  if (!scheduleId || !validSchedulePageToken(requestedPageToken) || !validSchedulePageToken(page.nextPageToken)
    || page.totalSize < 0n || page.totalSize > 100_000n
    || page.history.length > SCHEDULE_HISTORY_PAGE_SIZE
    || page.nextPageToken !== "" && (page.nextPageToken === requestedPageToken || page.history.length === 0)) {
    throw new Error("The Joko node returned invalid Automation history page metadata.");
  }
  const triggers = new Set<string>();
  for (const run of page.history) {
    if (!run.triggerId || triggers.has(run.triggerId)) {
      throw new Error("The Joko node returned a duplicate or missing Automation run identity.");
    }
    triggers.add(run.triggerId);
  }
  if (requestedPageToken === "" && page.nextPageToken === "" && BigInt(page.history.length) !== page.totalSize) {
    throw new Error("The Joko node returned an incomplete Automation history.");
  }
  return { history: page.history, nextPageToken: page.nextPageToken, totalSize: safeResultCount(page.totalSize, "Automation history") };
}

export async function collectSessionMessageSearchPages(
  readPage: (pageToken: string) => Promise<SessionMessageSearchPage>
): Promise<readonly SessionMessageSearchMatch[]> {
  const matches: SessionMessageSearchMatch[] = [];
  const pageTokens = new Set<string>();
  let pageToken = "";
  let totalSize: bigint | undefined;
  let pageCount = 0n;
  while (true) {
    const page = await readPage(pageToken);
    pageCount += 1n;
    if (page.totalSize < 0n) throw new Error("The Joko node returned an invalid message-search result count.");
    if (totalSize === undefined) totalSize = page.totalSize;
    else if (page.totalSize !== totalSize) throw new Error("The Joko message-search result count changed while paging.");
    matches.push(...page.matches);
    if (!page.nextPageToken) {
      if (BigInt(matches.length) !== totalSize) {
        throw new Error("The Joko node returned an incomplete message-search result set.");
      }
      return matches;
    }
    const expectedPages = (totalSize + BigInt(MESSAGE_SEARCH_PAGE_SIZE) - 1n) / BigInt(MESSAGE_SEARCH_PAGE_SIZE);
    if (pageCount >= expectedPages || pageTokens.has(page.nextPageToken)) {
      throw new Error("The Joko node returned an invalid message-search page sequence.");
    }
    pageTokens.add(page.nextPageToken);
    pageToken = page.nextPageToken;
  }
}

export async function collectWorkspaceDirectoryPages(
  workspaceId: string,
  parentPath: string,
  readPage: (pageToken: string) => Promise<WorkspaceDirectoryPage>
): Promise<WorkspaceDirectorySnapshot> {
  const canonicalParent = canonicalWorkspacePath(parentPath, true);
  const pages = await collectStablePages(readPage, "workspace directory", (page) => page.entries);
  const seen = new Set<string>();
  for (const entry of pages.values) {
    const path = canonicalWorkspacePath(entry.relativePath);
    if (entry.workspaceId !== workspaceId || workspaceParentPath(path) !== canonicalParent || seen.has(path)) {
      throw new Error("The Joko node returned an invalid workspace directory.");
    }
    seen.add(path);
    if (entry.kind !== FileKind.DIRECTORY && !entry.revision?.opaqueRevision) {
      throw new Error("The Joko node returned an unfenced workspace file.");
    }
  }
  return { entries: pages.values, revision: pages.revision };
}

export async function collectWorkspaceSearchPages(
  workspaceId: string,
  readPage: (pageToken: string) => Promise<WorkspaceSearchPage>
): Promise<WorkspaceSearchSnapshot> {
  if (!workspaceId) throw new Error("A current Workspace is required.");
  const matches: WorkspaceSearchMatch[] = [];
  const tokens = new Set<string>();
  let pageToken = "";
  let revision: string | undefined;
  let totalSize: bigint | undefined;
  let totalFiles: bigint | undefined;
  let truncated: boolean | undefined;
  while (true) {
    const page = await readPage(pageToken);
    if (!page.revision || page.totalSize < 0n || page.totalFiles < 0n) {
      throw new Error("The Joko node returned invalid workspace-search metadata.");
    }
    if (revision === undefined) {
      revision = page.revision;
      totalSize = page.totalSize;
      totalFiles = page.totalFiles;
      truncated = page.truncated;
    } else if (revision !== page.revision || totalSize !== page.totalSize || totalFiles !== page.totalFiles || truncated !== page.truncated) {
      throw new Error("Workspace search results changed while paging.");
    }
    for (const match of page.matches) {
      canonicalWorkspacePath(match.relativePath);
      if (!match.revision?.opaqueRevision) throw new Error("The Joko node returned an unfenced workspace-search match.");
      matches.push(match);
    }
    if (!page.nextPageToken) break;
    if (page.nextPageToken === pageToken || tokens.has(page.nextPageToken)) {
      throw new Error("The Joko node returned a cyclic workspace-search page token.");
    }
    tokens.add(page.nextPageToken);
    pageToken = page.nextPageToken;
    if (tokens.size > 10_000) throw new Error("Workspace search exceeded the supported page count.");
  }
  if (BigInt(matches.length) !== totalSize) throw new Error("The Joko node returned an incomplete workspace-search result set.");
  return {
    matches,
    revision: revision!,
    truncated: truncated!,
    totalFiles: safeResultCount(totalFiles!, "workspace-search file")
  };
}

export async function collectArtifactPages(
  sessionId: string,
  readPage: (pageToken: string) => Promise<ArtifactPage>
): Promise<ArtifactCatalogSnapshot> {
  const pages = await collectStablePages(readPage, "Artifact catalog", (page) => page.artifacts);
  const ids = new Set<string>();
  for (const artifact of pages.values) {
    if (!artifact.artifactId || artifact.sessionId !== sessionId || ids.has(artifact.artifactId)) {
      throw new Error("The Joko node returned an invalid Artifact catalog.");
    }
    ids.add(artifact.artifactId);
  }
  return { artifacts: pages.values, revision: pages.revision };
}

export function assertSessionResourceCatalog(
  sessionId: string,
  resources: readonly SessionResource[]
): readonly SessionResource[] {
  if (!validCatalogIdentity(sessionId, 1_024)) throw new Error("A current task is required for its Resource catalog.");
  const ids = new Set<string>();
  for (const resource of resources) {
    if (resource.sessionId !== sessionId
      || !validCatalogIdentity(resource.resourceId)
      || ids.has(resource.resourceId)
      || !validCatalogLabel(resource.name)
      || !validCatalogIdentity(resource.discoveredRevision)
      || resource.resourceVersion < 1n
      || resource.runtimeGeneration < 1n
      || ![ResourceKind.EXTENSION, ResourceKind.SKILL, ResourceKind.PROMPT_TEMPLATE, ResourceKind.PACKAGE].includes(resource.kind)) {
      throw new Error("The Joko node returned an invalid task Resource catalog.");
    }
    ids.add(resource.resourceId);
  }
  return resources;
}

export async function collectArtifactReferencePages(
  readPage: (pageToken: string) => Promise<ArtifactPage>,
  now = Date.now()
): Promise<ArtifactCatalogSnapshot> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const pages = await collectStablePages(readPage, "Artifact reference catalog", (page) => page.artifacts);
      const identities = new Set<string>();
      const artifacts: Artifact[] = [];
      for (const artifact of pages.values) {
        const identity = `${artifact.sessionId}\u0000${artifact.artifactId}`;
        const blob = artifact.blob;
        const createdAt = safeCatalogTimestamp(artifact.createdAt);
        const expiresAt = artifact.expiresAt === undefined ? undefined : safeCatalogTimestamp(artifact.expiresAt);
        if (!validCatalogIdentity(artifact.sessionId, 1_024)
          || !validCatalogIdentity(artifact.artifactId)
          || identities.has(identity)
          || !artifactReferenceKind(artifact.kind)
          || !blob
          || !validCatalogIdentity(blob.blobId)
          || !/^[a-f0-9]{64}$/u.test(blob.sha256Hex)
          || blob.byteSize < 0n || blob.byteSize > BigInt(Number.MAX_SAFE_INTEGER)
          || !validCatalogLabel(blob.mediaType)
          || !validCatalogLabel(artifact.title || blob.fileName)
          || createdAt === undefined
          || artifact.expiresAt !== undefined && expiresAt === undefined) {
          throw new Error("The Joko node returned an invalid Artifact reference catalog identity.");
        }
        identities.add(identity);
        if (expiresAt === undefined || expiresAt > now) artifacts.push(artifact);
      }
      return { artifacts, revision: pages.revision };
    } catch (error) {
      const drift = error instanceof Error && error.message === "Artifact reference catalog changed while paging.";
      if (attempt === 0 && drift) continue;
      throw error;
    }
  }
  throw new Error("The Artifact reference catalog changed repeatedly while it was loading.");
}

export function assertWorkspaceFilePreview(
  workspaceId: string,
  relativePath: string,
  revision: FileRevision,
  preview: FilePreview | undefined
): FilePreview {
  const path = canonicalWorkspacePath(relativePath);
  if (!workspaceId || !revision.opaqueRevision || !preview?.entry
    || preview.entry.workspaceId !== workspaceId || preview.entry.relativePath !== path
    || !preview.entry.revision?.opaqueRevision
    || !acceptedWorkspacePreviewRevision(revision, preview.entry.revision)) {
    throw new Error("The Joko node returned a mismatched workspace file preview.");
  }
  return preview;
}

export function assertMaterializedWorkspaceBlob(
  workspaceId: string,
  relativePath: string,
  revision: FileRevision,
  preview: FilePreview | undefined
): MaterializedWorkspaceBlob {
  const exact = assertWorkspaceFilePreview(workspaceId, relativePath, revision, preview);
  const entry = exact.entry;
  const blob = exact.content.case === "image"
    ? exact.content.value.blob
    : exact.content.case === "blob"
      ? exact.content.value
      : undefined;
  const mediaType = normalizeMediaType(entry?.mediaType ?? "") || "application/octet-stream";
  const filePath = canonicalWorkspacePath(relativePath);
  const fileName = filePath.slice(filePath.lastIndexOf("/") + 1);
  if (!entry || entry.kind !== FileKind.REGULAR || exact.truncated || !entry.revision
    || !blob?.blobId || !/^[0-9a-f]{64}$/u.test(blob.sha256Hex)
    || blob.fileName !== fileName
    || blob.byteSize < 0n || blob.byteSize > BigInt(MOBILE_FILE_SHARE_MAXIMUM_BYTES)
    || entry.revision.byteSize !== blob.byteSize || entry.revision.sha256Hex !== blob.sha256Hex
    || entry.revision.opaqueRevision !== `sha256:${blob.sha256Hex}:${blob.byteSize.toString(10)}`
    || normalizeMediaType(blob.mediaType) !== mediaType) {
    throw new Error("The Joko node returned a mismatched complete Workspace Blob.");
  }
  return { entry, blob };
}

function acceptedWorkspacePreviewRevision(expected: FileRevision, actual: FileRevision): boolean {
  if (workspaceEntryRevisionKey(actual) === workspaceEntryRevisionKey(expected)) return true;
  if (expected.opaqueRevision.startsWith("sha256:") || !actual.opaqueRevision.startsWith("sha256:")
    || !/^[0-9a-f]{64}$/u.test(actual.sha256Hex)) return false;
  if (actual.opaqueRevision !== `sha256:${actual.sha256Hex}:${actual.byteSize.toString(10)}`) return false;
  if (expected.sha256Hex !== "" && expected.sha256Hex !== actual.sha256Hex) return false;
  if (expected.byteSize !== 0n && expected.byteSize !== actual.byteSize) return false;
  if (expected.modifiedAt !== undefined) {
    if (actual.modifiedAt === undefined || expected.modifiedAt.seconds !== actual.modifiedAt.seconds
      || expected.modifiedAt.nanos !== actual.modifiedAt.nanos) return false;
  }
  return true;
}

export async function downloadVerifiedBlob(
  credential: Pick<PairedCredential, "origin" | "authKey">,
  blob: BlobRef,
  ticket: BlobTransferTicket | undefined,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
  digestBytes: (bytes: Uint8Array) => Promise<string> = sha256Hex
): Promise<VerifiedBlobDownload> {
  signal?.throwIfAborted();
  assertDownloadBlob(blob);
  if (!ticket?.ticketId || ticket.direction !== TransferDirection.DOWNLOAD || ticket.blobId !== blob.blobId) {
    throw new Error("The Joko node returned a mismatched Blob download ticket.");
  }
  if (ticket.maximumBytes !== blob.byteSize || normalizeMediaType(ticket.requiredMediaType) !== normalizeMediaType(blob.mediaType)) {
    throw new Error("The Joko node returned a Blob ticket with mismatched limits or media type.");
  }
  if (ticket.expiresAt && Number(ticket.expiresAt.seconds) * 1_000 <= Date.now()) {
    throw new Error("The Joko node returned an expired Blob download ticket.");
  }
  const endpoint = authorizedBlobEndpoint(credential.origin, ticket.relativeEndpoint);
  const response = await fetcher(endpoint, {
    headers: { authorization: `Bearer ${credential.authKey}` },
    cache: "no-store",
    signal
  });
  signal?.throwIfAborted();
  if (!response.ok) throw new Error(`Blob download failed (${response.status}).`);
  const declaredLength = response.headers.get("content-length")?.trim();
  if (!declaredLength || !/^(0|[1-9][0-9]*)$/u.test(declaredLength) || BigInt(declaredLength) !== blob.byteSize) {
    throw new Error("The Blob response length did not match its authenticated metadata.");
  }
  if (normalizeMediaType(response.headers.get("content-type") ?? "") !== normalizeMediaType(blob.mediaType)) {
    throw new Error("The Blob response media type did not match its authenticated metadata.");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  signal?.throwIfAborted();
  if (BigInt(bytes.byteLength) !== blob.byteSize || BigInt(bytes.byteLength) > ticket.maximumBytes) {
    throw new Error("The Blob response size did not match its authenticated metadata.");
  }
  if (await digestBytes(bytes) !== blob.sha256Hex) {
    throw new Error("The Blob response failed SHA-256 verification.");
  }
  signal?.throwIfAborted();
  return { bytes, mediaType: normalizeMediaType(blob.mediaType) };
}

export function authorizeVerifiedBlobDownload(
  credential: Pick<PairedCredential, "origin" | "authKey">,
  blob: BlobRef,
  ticket: BlobTransferTicket | undefined
): AuthorizedBlobDownload {
  assertShareBlob(blob);
  if (!ticket?.ticketId || ticket.direction !== TransferDirection.DOWNLOAD || ticket.blobId !== blob.blobId) {
    throw new Error("The Joko node returned a mismatched Blob download ticket.");
  }
  const mediaType = normalizeMediaType(blob.mediaType);
  if (ticket.maximumBytes !== blob.byteSize || normalizeMediaType(ticket.requiredMediaType) !== mediaType) {
    throw new Error("The Joko node returned a Blob ticket with mismatched limits or media type.");
  }
  if (ticket.expiresAt && Number(ticket.expiresAt.seconds) * 1_000 <= Date.now()) {
    throw new Error("The Joko node returned an expired Blob download ticket.");
  }
  return {
    url: authorizedBlobEndpoint(credential.origin, ticket.relativeEndpoint),
    headers: { authorization: `Bearer ${credential.authKey}` },
    blobId: blob.blobId,
    fileName: blob.fileName,
    mediaType,
    byteSize: Number(blob.byteSize),
    sha256Hex: blob.sha256Hex
  };
}

export async function uploadVerifiedBlob(
  credential: Pick<PairedCredential, "origin" | "authKey">,
  source: MobileBlobUploadSource,
  pending: PendingBlobUpload | undefined,
  complete: (uploadId: string, signal?: AbortSignal) => Promise<BlobRef | undefined>,
  signal?: AbortSignal,
  uploader: MobileNativeBlobUploader = uploadNativeBlobFile
): Promise<BlobRef> {
  signal?.throwIfAborted();
  const exact = assertBlobUploadSource(source);
  const ticket = pending?.ticket;
  if (!validBlobTransferIdentity(pending?.uploadId) || !validBlobTransferIdentity(ticket?.ticketId)
    || ticket.blobId !== ""
    || ticket.direction !== TransferDirection.UPLOAD
    || pending.expectedSha256Hex !== exact.sha256Hex
    || pending.expectedByteSize !== BigInt(exact.byteSize)
    || ticket.maximumBytes !== BigInt(exact.byteSize)
    || normalizeMediaType(ticket.requiredMediaType) !== exact.mediaType) {
    throw new Error("The Joko node returned a mismatched Blob upload ticket.");
  }
  if (ticket.expiresAt && Number(ticket.expiresAt.seconds) * 1_000 <= Date.now()) {
    throw new Error("The Joko node returned an expired Blob upload ticket.");
  }
  const endpoint = authorizedBlobEndpoint(credential.origin, ticket.relativeEndpoint);
  const response = await uploader(endpoint, exact.uri, {
    authorization: `Bearer ${credential.authKey}`,
    "content-type": "application/octet-stream"
  }, signal);
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(response.status) || response.status < 200 || response.status >= 300) {
    throw new Error(`Attachment upload failed (${response.status || "unknown"}).`);
  }
  const blob = await complete(pending.uploadId, signal);
  signal?.throwIfAborted();
  if (!blob?.blobId || blob.fileName !== exact.fileName
    || normalizeMediaType(blob.mediaType) !== exact.mediaType
    || blob.byteSize !== BigInt(exact.byteSize) || blob.sha256Hex !== exact.sha256Hex
    || blob.disposition !== BlobDisposition.ATTACHMENT) {
    throw new Error("The Joko node committed a mismatched attachment Blob.");
  }
  return blob;
}

function authorizedBlobEndpoint(origin: string, relativeEndpoint: string): string {
  if (!relativeEndpoint.startsWith("/") || relativeEndpoint.startsWith("//") || relativeEndpoint.includes("\\")
    || relativeEndpoint.includes("?") || relativeEndpoint.includes("#")) {
    throw new Error("The Joko node returned a non-root-relative Blob endpoint.");
  }
  const base = new URL(normalizeNodeOrigin(origin));
  const endpoint = new URL(relativeEndpoint, base);
  if (endpoint.origin !== base.origin || endpoint.pathname !== relativeEndpoint) {
    throw new Error("The Joko node returned a cross-origin Blob endpoint.");
  }
  return endpoint.toString();
}

function authorizedExtensionCredentialEndpoint(origin: string, relativeEndpoint: string): string {
  if (!relativeEndpoint.startsWith("/") || relativeEndpoint.startsWith("//") || relativeEndpoint.includes("\\")
    || relativeEndpoint.includes("?") || relativeEndpoint.includes("#")) {
    throw new Error("The Joko node returned a non-root-relative Extension credential endpoint.");
  }
  const base = new URL(normalizeNodeOrigin(origin));
  const endpoint = new URL(relativeEndpoint, base);
  if (endpoint.origin !== base.origin || endpoint.pathname !== relativeEndpoint
    || endpoint.username !== "" || endpoint.password !== "") {
    throw new Error("The Joko node returned a cross-origin Extension credential endpoint.");
  }
  return endpoint.toString();
}

function validExtensionSetupIdentity(value: string): boolean {
  return value.length > 0 && value.length <= 512 && value === value.trim()
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function assertExtensionLibraryAuthority(extensionId: string, expectedRevision: bigint): void {
  if (!/^extension_[a-f0-9]{32}$/u.test(extensionId) || expectedRevision < 1n) {
    throw new Error("A current Extension Library is required.");
  }
}

function assertExtensionLibraryConfirmation(value: string): void {
  if (value.length === 0 || value.length > 256 || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("Enter the exact current Extension Library name.");
  }
}

function assertDownloadBlob(blob: BlobRef): void {
  if (!blob.blobId || !normalizeMediaType(blob.mediaType) || !/^[0-9a-f]{64}$/u.test(blob.sha256Hex)
    || blob.byteSize < 0n || blob.byteSize > BigInt(MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES)) {
    throw new Error("The Blob is missing valid bounded download metadata.");
  }
}

function assertShareBlob(blob: BlobRef): void {
  const mediaType = normalizeMediaType(blob.mediaType);
  if (!blob.blobId || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(mediaType)
    || !/^[0-9a-f]{64}$/u.test(blob.sha256Hex)
    || blob.byteSize < 0n || blob.byteSize > BigInt(MOBILE_FILE_SHARE_MAXIMUM_BYTES)
    || blob.byteSize > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("The Blob is missing valid bounded file-sharing metadata.");
  }
}

function assertBlobUploadSource(source: MobileBlobUploadSource): MobileBlobUploadSource & { readonly mediaType: string } {
  const mediaType = normalizeMediaType(source.mediaType);
  if (!source || typeof source !== "object" || typeof source.uri !== "string" || !source.uri
    || typeof source.fileName !== "string" || !source.fileName.trim() || source.fileName.length > 512
    || /[\u0000-\u001f\u007f]/u.test(source.fileName) || !mediaType
    || !Number.isSafeInteger(source.byteSize) || source.byteSize <= 0
    || !/^[0-9a-f]{64}$/u.test(source.sha256Hex)) {
    throw new Error("The staged attachment upload metadata is invalid.");
  }
  return { ...source, mediaType };
}

function validBlobTransferIdentity(value: string | undefined): value is string {
  return value !== undefined && value.length > 0 && value.length <= 512 && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

async function uploadNativeBlobFile(
  endpoint: string,
  sourceUri: string,
  headers: Readonly<Record<string, string>>,
  signal?: AbortSignal
): Promise<{ readonly status: number; readonly body?: string }> {
  const { File, UploadType } = await import("expo-file-system");
  signal?.throwIfAborted();
  const result = await new File(sourceUri).upload(endpoint, {
    httpMethod: "PUT",
    uploadType: UploadType.BINARY_CONTENT,
    headers: { ...headers },
    sessionType: "foreground",
    signal
  });
  return { status: result.status, body: result.body };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const { CryptoDigestAlgorithm, digest } = await import("expo-crypto");
  const value = new Uint8Array(await digest(CryptoDigestAlgorithm.SHA256, Uint8Array.from(bytes)));
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function collectStablePages<T, Page extends {
  readonly nextPageToken: string;
  readonly totalSize: bigint;
  readonly revision: string;
}>(
  readPage: (pageToken: string) => Promise<Page>,
  label: string,
  valuesOf: (page: Page) => readonly T[]
): Promise<{ readonly values: T[]; readonly revision: string }> {
  const values: T[] = [];
  const tokens = new Set<string>();
  let pageToken = "";
  let totalSize: bigint | undefined;
  let revision: string | undefined;
  while (true) {
    const page = await readPage(pageToken);
    const pageValues = valuesOf(page);
    if (page.totalSize < 0n || !page.revision) throw new Error(`The Joko node returned invalid ${label} metadata.`);
    if (totalSize === undefined) { totalSize = page.totalSize; revision = page.revision; }
    else if (totalSize !== page.totalSize || revision !== page.revision) throw new Error(`${label} changed while paging.`);
    values.push(...pageValues);
    if (!page.nextPageToken) break;
    if (page.nextPageToken === pageToken || tokens.has(page.nextPageToken)) {
      throw new Error(`The Joko node returned a cyclic ${label} page token.`);
    }
    tokens.add(page.nextPageToken);
    pageToken = page.nextPageToken;
    if (tokens.size > 10_000) throw new Error(`${label} exceeded the supported page count.`);
  }
  if (BigInt(values.length) !== totalSize) throw new Error(`The Joko node returned an incomplete ${label}.`);
  return { values, revision: revision! };
}

function safeResultCount(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`The Joko node returned an oversized ${label} count.`);
  return Number(value);
}

function responseRevision(revision: { readonly etag: string; readonly value: bigint } | undefined): string {
  const value = revision?.etag || revision?.value.toString(10) || "";
  if (!value) throw new Error("The Joko node returned an unfenced result.");
  return value;
}

function validCatalogIdentity(value: unknown, maximum = 4_096): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && value === value.trim()
    && !/[\u0000-\u001f\u007f\u2028\u2029]/u.test(value);
}

function validCatalogLabel(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 4_096
    && !/[\u0000-\u001f\u007f\u2028\u2029]/u.test(value);
}

function artifactReferenceKind(value: ArtifactKind): boolean {
  return value === ArtifactKind.FILE || value === ArtifactKind.IMAGE || value === ArtifactKind.EXPORT
    || value === ArtifactKind.TOOL_RESULT || value === ArtifactKind.DIAGNOSTICS || value === ArtifactKind.DIFF;
}

function safeCatalogTimestamp(value: {
  readonly seconds: bigint;
  readonly nanos: number;
} | undefined): number | undefined {
  if (value === undefined || value.seconds < 0n || value.seconds > BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 1_000))
    || !Number.isSafeInteger(value.nanos) || value.nanos < 0 || value.nanos > 999_999_999) return undefined;
  const milliseconds = Number(value.seconds) * 1_000 + Math.floor(value.nanos / 1_000_000);
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}

export function normalizeNodeOrigin(value: string): string {
  const parsed = new URL(value.trim());
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Use an HTTP(S) Joko node address.");
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== "/" && parsed.pathname !== "")) {
    throw new Error("Use only the Joko node origin, without credentials, path, query or fragment.");
  }
  if (parsed.protocol === "http:" && !isPrivateLanDiscoveryHost(parsed.hostname)) {
    throw new Error("Unencrypted HTTP is allowed only for a local/private-network Joko node. Use HTTPS elsewhere.");
  }
  return parsed.origin;
}

function boundedMobilePushIdentity(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || value !== value.trim()
    || /[\u0000-\u001f\u007f\u2028\u2029]/u.test(value)) {
    throw new Error(`The Joko node returned an invalid ${label}.`);
  }
  return value;
}

function normalizedMobilePushTicket(ticket: MobilePushRevocationTicket): MobilePushRevocationTicket {
  const serverId = boundedMobilePushIdentity(ticket.serverId, "mobile push Server ID");
  const registrationId = boundedMobilePushIdentity(ticket.registrationId, "mobile push registration ID");
  const secret = ticket.secret.trim();
  if (!/^[A-Za-z0-9_-]{43}$/u.test(secret)) throw new Error("The mobile push revocation ticket is invalid.");
  return { serverId, registrationId, secret };
}

function wireMobilePushEnvironment(value: MobilePushEnvironment): WireMobilePushEnvironment {
  return value === "sandbox" ? WireMobilePushEnvironment.APNS_SANDBOX : WireMobilePushEnvironment.APNS_PRODUCTION;
}

function wireMobilePushLocale(value: MobilePushLocale): WireMobilePushLocale {
  if (value === "en") return WireMobilePushLocale.EN;
  if (value === "zh-CN") return WireMobilePushLocale.ZH_CN;
  if (value === "zh-TW") return WireMobilePushLocale.ZH_TW;
  if (value === "ja") return WireMobilePushLocale.JA;
  return WireMobilePushLocale.KO;
}

function normalizedMobilePushToken(value: string): string {
  const token = value.trim();
  if (!token || token.length > 512 || /[\u0000-\u001f\u007f\u2028\u2029]/u.test(token)) {
    throw new Error("The native notification token is invalid.");
  }
  return token;
}

function transport(origin: string, authKey?: string): Transport {
  const interceptors: Interceptor[] = authKey === undefined ? [] : [
    (next) => async (request) => {
      request.header.set("authorization", `Bearer ${authKey}`);
      request.header.set("x-joko-client-version", "0.1.0");
      return next(request);
    }
  ];
  return createConnectTransport({ baseUrl: origin, useBinaryFormat: true, interceptors });
}

export function parseNodeIdentity(server: {
  serverId: string;
  displayName: string;
  version: string;
  apiVersion: string;
  health: number;
  pairingEnabled: boolean;
} | undefined): NodeIdentity {
  if (!server?.serverId.trim() || !server.apiVersion.trim()) throw new Error("This address did not return a valid Joko node identity.");
  if (server.apiVersion !== JOKO_API_VERSION) {
    throw new Error(`This Joko app supports API ${JOKO_API_VERSION}, but the node reports ${server.apiVersion}.`);
  }
  return {
    serverId: server.serverId,
    displayName: server.displayName || "Joko node",
    version: server.version,
    apiVersion: server.apiVersion,
    health: server.health,
    pairingEnabled: server.pairingEnabled
  };
}

function options(signal?: AbortSignal): { signal: AbortSignal } | undefined { return signal === undefined ? undefined : { signal }; }

function remoteDesktopPeerKey(peer: DevicePeerRouteIdentity | undefined): string | undefined {
  const targetRevision = peer?.targetDeviceRevision;
  const relationRevision = peer?.relationRevision;
  if (!peer?.targetDeviceId || !peer.relationId || !targetRevision || !relationRevision
    || targetRevision.value < 1n || relationRevision.value < 0n || peer.routeGeneration < 1n) return undefined;
  return JSON.stringify([
    peer.targetDeviceId, peer.relationId,
    targetRevision.value.toString(10), targetRevision.etag,
    relationRevision.value.toString(10), relationRevision.etag,
    peer.routeGeneration.toString(10)
  ]);
}

function assertRemoteDesktopPeer(expected: DevicePeerRouteIdentity, actual: DevicePeerRouteIdentity | undefined): void {
  const expectedKey = remoteDesktopPeerKey(expected);
  if (expectedKey === undefined || remoteDesktopPeerKey(actual) !== expectedKey) {
    throw new Error("The Joko node returned Remote Desktop data for another device route.");
  }
}

const REMOTE_DESKTOP_MODE_ID = /^[0-9]{1,10}$/u;
const REMOTE_DESKTOP_CURSOR_PNG_LIMIT = 49_152;

function validRemoteDesktopCursor(cursor: RemoteDesktopCursor): boolean {
  const png = cursor.png;
  return typeof cursor.visible === "boolean"
    && [cursor.x, cursor.y, cursor.width, cursor.height, cursor.hotX, cursor.hotY].every(Number.isFinite)
    && cursor.x >= 0 && cursor.x <= 1 && cursor.y >= 0 && cursor.y <= 1
    && cursor.width > 0 && cursor.width <= 256 && cursor.height > 0 && cursor.height <= 256
    && cursor.hotX >= 0 && cursor.hotX <= cursor.width && cursor.hotY >= 0 && cursor.hotY <= cursor.height
    && png instanceof Uint8Array && png.length >= 33 && png.length <= REMOTE_DESKTOP_CURSOR_PNG_LIMIT
    && png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47
    && png[4] === 0x0d && png[5] === 0x0a && png[6] === 0x1a && png[7] === 0x0a
    && png[8] === 0 && png[9] === 0 && png[10] === 0 && png[11] === 13
    && png[12] === 0x49 && png[13] === 0x48 && png[14] === 0x44 && png[15] === 0x52
    && pngDimension(png, 16) >= 1 && pngDimension(png, 16) <= 512
    && pngDimension(png, 20) >= 1 && pngDimension(png, 20) <= 512;
}

function pngDimension(png: Uint8Array, offset: number): number {
  return png[offset]! * 0x1000000 + png[offset + 1]! * 0x10000 + png[offset + 2]! * 0x100 + png[offset + 3]!;
}

function validRemoteDesktopDisplayModes(modes: readonly RemoteDesktopDisplayMode[]): boolean {
  return modes.length >= 1 && modes.length <= 256
    && modes.filter((mode) => mode.current).length === 1
    && new Set(modes.map((mode) => mode.modeId)).size === modes.length
    && modes.every((mode) => REMOTE_DESKTOP_MODE_ID.test(mode.modeId)
      && Number.isInteger(mode.width) && mode.width >= 1 && mode.width <= 32_768
      && Number.isInteger(mode.height) && mode.height >= 1 && mode.height <= 32_768
      && typeof mode.current === "boolean" && typeof mode.native === "boolean");
}

export const mobileNetwork: MobileNetwork = {
  async inspect(origin, signal) {
    const response = await createClient(ConnectionService, transport(normalizeNodeOrigin(origin))).getServerInfo({}, options(signal));
    return parseNodeIdentity(response.server);
  },
  async discover(rawOrigin, signal) {
    const origin = normalizeNodeOrigin(rawOrigin);
    const response = await createClient(ConnectionService, transport(origin)).listDiscoveredNodes({}, options(signal));
    const receivedAt = Date.now();
    return response.nodes.map((node) => {
      const value: DiscoveredNodeRecord = {
        serverId: node.serverId,
        displayName: node.displayName,
        origin: node.origin,
        version: node.version,
        apiVersion: node.apiVersion,
        pairingEnabled: node.pairingEnabled,
        lastSeen: receivedAt
      };
      validateDiscoveredNode(value);
      return value;
    });
  },
  async requestPairing(rawOrigin, deviceName, platform, deviceNameSource, signal) {
    const origin = normalizeNodeOrigin(rawOrigin);
    const client = createClient(ConnectionService, transport(origin));
    const node = parseNodeIdentity((await client.getServerInfo({}, options(signal))).server);
    if (!node.pairingEnabled) throw new Error("Pairing is closed on this Joko node. Ask the node owner to open pairing.");
    const args = { deviceDisplayName: deviceName.trim(), deviceKind: DeviceKind.MOBILE, platform, appVersion: "0.1.0", deviceNameSource };
    const challenge = (await client.beginPairing(args, options(signal))).challenge;
    if (!challenge?.challengeId) throw new Error("The Joko node did not return a pairing challenge.");
    return { identity: node, challengeId: challenge.challengeId };
  },
  async completePairing(rawOrigin, challengeId, code, deviceName, platform, deviceNameSource, signal) {
    const origin = normalizeNodeOrigin(rawOrigin);
    const client = createClient(ConnectionService, transport(origin));
    const node = parseNodeIdentity((await client.getServerInfo({}, options(signal))).server);
    const args = { deviceDisplayName: deviceName.trim(), deviceKind: DeviceKind.MOBILE, platform, appVersion: "0.1.0", deviceNameSource };
    const result = (await client.completePairing({ ...args, challengeId, humanCode: code.trim() }, options(signal))).result;
    if (!result?.connection?.connectionId || !result.connection.connectionProfileId || !result.device?.deviceId
      || result.connection.deviceId !== result.device.deviceId || !result.authKey) {
      throw new Error("Pairing completed without a matching device and connection credential.");
    }
    return {
      identity: node,
      credential: {
        profileId: result.connection.connectionProfileId,
        origin, serverId: node.serverId, connectionId: result.connection.connectionId,
        deviceId: result.device.deviceId, displayName: result.connection.displayName || deviceName.trim(), authKey: result.authKey
      }
    };
  },
  async readOwner(credential, currentDeviceNameSource, signal) {
    const response = await createClient(EventService, transport(credential.origin, credential.authKey)).getSnapshot({
      scope: { kind: { case: "owner", value: {} } }, currentDeviceNameSource
    }, options(signal));
    const snapshot = response.snapshot;
    const connections = snapshot?.connections.filter((item) => item.connectionId === credential.connectionId) ?? [];
    const devices = snapshot?.devices.filter((item) => item.deviceId === credential.deviceId) ?? [];
    if (!snapshot || connections.length !== 1 || devices.length !== 1) {
      throw new Error("The Joko node returned an incomplete or ambiguous owner snapshot.");
    }
    return { connection: connections[0]!, device: devices[0]!, snapshot };
  },
  async listRemoteDesktopHosts(credential, signal) {
    const client = createClient(RemoteDesktopService, transport(credential.origin, credential.authKey));
    const hosts: DevicePeerDescriptor[] = [];
    const seen = new Set<string>();
    let pageToken = "";
    for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
      const response = await client.listRemoteDesktopHosts({ page: { pageSize: 100, pageToken } }, options(signal));
      if (!response.page) throw new Error("The Joko node did not return Remote Desktop host page metadata.");
      for (const host of response.hosts) {
        const key = remoteDesktopPeerKey(host.route);
        if (key === undefined || seen.has(key) || !host.displayName.trim()) {
          throw new Error("The Joko node returned an invalid or duplicate Remote Desktop host.");
        }
        seen.add(key);
        hosts.push(host);
      }
      const next = response.page.nextPageToken;
      if (!next) return Object.freeze(hosts);
      if (next === pageToken || next.length > 2_048) throw new Error("The Remote Desktop host cursor is invalid.");
      pageToken = next;
    }
    throw new Error("The Remote Desktop host catalog exceeded its bounded page count.");
  },
  async getRemoteDesktopCapabilities(credential, peer, signal) {
    const response = await createClient(RemoteDesktopService, transport(credential.origin, credential.authKey))
      .getRemoteDesktopCapabilities({ peer }, options(signal));
    assertRemoteDesktopPeer(peer, response.peer);
    if (!response.capabilities) throw new Error("The Joko node returned no Remote Desktop capabilities.");
    return response.capabilities;
  },
  async getRemoteDesktopPermissions(credential, peer, signal) {
    const response = await createClient(RemoteDesktopService, transport(credential.origin, credential.authKey))
      .getRemoteDesktopPermissions({ peer }, options(signal));
    assertRemoteDesktopPeer(peer, response.peer);
    if (!response.permissions) throw new Error("The Joko node returned no Remote Desktop permissions.");
    return response.permissions;
  },
  async showRemoteDesktopPermissionGuide(credential, peer, signal) {
    const response = await createClient(RemoteDesktopService, transport(credential.origin, credential.authKey))
      .showRemoteDesktopPermissionGuide({ peer }, options(signal));
    assertRemoteDesktopPeer(peer, response.peer);
    if (!response.permissions) throw new Error("The Joko node returned no Remote Desktop permissions.");
    return response.permissions;
  },
  async startRemoteDesktop(credential, peer, displayId, mode, signal) {
    const response = await createClient(RemoteDesktopService, transport(credential.origin, credential.authKey))
      .startRemoteDesktop({ peer, displayId, mode }, options(signal));
    assertRemoteDesktopPeer(peer, response.peer);
    if (!response.lease?.leaseId || response.lease.display?.displayId !== displayId) {
      throw new Error("The Joko node returned an invalid Remote Desktop lease.");
    }
    return response.lease;
  },
  async heartbeatRemoteDesktop(credential, peer, leaseId, signal) {
    const response = await createClient(RemoteDesktopService, transport(credential.origin, credential.authKey))
      .heartbeatRemoteDesktop({ peer, leaseId }, options(signal));
    assertRemoteDesktopPeer(peer, response.peer);
    if (!response.state) throw new Error("The Joko node returned no Remote Desktop control state.");
    return response.state;
  },
  async stopRemoteDesktop(credential, peer, leaseId, signal) {
    const response = await createClient(RemoteDesktopService, transport(credential.origin, credential.authKey))
      .stopRemoteDesktop({ peer, leaseId }, options(signal));
    assertRemoteDesktopPeer(peer, response.peer);
  },
  async setRemoteDesktopControl(credential, peer, leaseId, enabled, signal) {
    const response = await createClient(RemoteDesktopService, transport(credential.origin, credential.authKey))
      .setRemoteDesktopControl({ peer, leaseId, enabled }, options(signal));
    assertRemoteDesktopPeer(peer, response.peer);
    if (!response.state) throw new Error("The Joko node returned no Remote Desktop control state.");
    return response.state;
  },
  async setRemoteDesktopPresentation(credential, peer, leaseId, enabled, signal) {
    const response = await createClient(RemoteDesktopService, transport(credential.origin, credential.authKey))
      .setRemoteDesktopPresentation({ peer, leaseId, enabled }, options(signal));
    assertRemoteDesktopPeer(peer, response.peer);
    if (!response.state) throw new Error("The Joko node returned no Remote Desktop presentation state.");
    return response.state;
  },
  async sendRemoteDesktopInput(credential, peer, leaseId, sequence, events, signal) {
    const response = await createClient(RemoteDesktopService, transport(credential.origin, credential.authKey))
      .sendRemoteDesktopInput({ peer, leaseId, sequence, events: [...events] }, options(signal));
    assertRemoteDesktopPeer(peer, response.peer);
  },
  async getRemoteDesktopIceConfiguration(credential, peer, leaseId, signal) {
    const response = await createClient(RemoteDesktopService, transport(credential.origin, credential.authKey))
      .getRemoteDesktopIceConfiguration({ peer, leaseId }, options(signal));
    assertRemoteDesktopPeer(peer, response.peer);
    return Object.freeze([...response.iceServers]);
  },
  async createRemoteDesktopOffer(credential, peer, leaseId, attemptId, offerSdp, settings, cursorOverlay, signal) {
    const response = await createClient(RemoteDesktopService, transport(credential.origin, credential.authKey))
      .createRemoteDesktopOffer({ peer, leaseId, attemptId, offerSdp, settings, cursorOverlay }, options(signal));
    assertRemoteDesktopPeer(peer, response.peer);
    if (!response.offer || response.offer.attemptId !== attemptId || !response.offer.answerSdp) {
      throw new Error("The Joko node returned an invalid Remote Desktop answer.");
    }
    return response.offer;
  },
  async exchangeRemoteDesktopIce(credential, peer, leaseId, attemptId, candidates, after, signal) {
    const response = await createClient(RemoteDesktopService, transport(credential.origin, credential.authKey))
      .exchangeRemoteDesktopIce({ peer, leaseId, attemptId, candidates: [...candidates], after }, options(signal));
    assertRemoteDesktopPeer(peer, response.peer);
    if (!response.exchange || response.exchange.attemptId !== attemptId) {
      throw new Error("The Joko node returned an invalid Remote Desktop ICE exchange.");
    }
    return response.exchange;
  },
  async getRemoteDesktopFrame(credential, peer, leaseId, cursorOverlay, signal) {
    const response = await createClient(RemoteDesktopService, transport(credential.origin, credential.authKey))
      .getRemoteDesktopFrame({ peer, leaseId, cursorOverlay }, options(signal));
    assertRemoteDesktopPeer(peer, response.peer);
    if (!response.result) throw new Error("The Joko node returned no Remote Desktop frame result.");
    const jpeg = response.result.frame?.jpeg;
    if (jpeg && (jpeg.length > 180_000 || jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8
      || jpeg[jpeg.length - 2] !== 0xff || jpeg[jpeg.length - 1] !== 0xd9)) {
      throw new Error("The Remote Desktop frame exceeds its portable JPEG bounds.");
    }
    const cursor = response.result.frame?.cursor;
    if (cursor !== undefined && !validRemoteDesktopCursor(cursor)) {
      throw new Error("The Remote Desktop cursor exceeds its portable bounds.");
    }
    return response.result;
  },
  async listRemoteDesktopDisplayModes(credential, peer, leaseId, signal) {
    const response = await createClient(RemoteDesktopService, transport(credential.origin, credential.authKey))
      .listRemoteDesktopDisplayModes({ peer, leaseId }, options(signal));
    assertRemoteDesktopPeer(peer, response.peer);
    if (!validRemoteDesktopDisplayModes(response.modes)) {
      throw new Error("The Joko node returned invalid Remote Desktop display modes.");
    }
    return Object.freeze([...response.modes]);
  },
  async setRemoteDesktopDisplayMode(credential, peer, leaseId, controlGeneration, modeId, signal) {
    if (!REMOTE_DESKTOP_MODE_ID.test(modeId) || controlGeneration < 1n) {
      throw new Error("A current Remote Desktop display mode authority is required.");
    }
    const response = await createClient(RemoteDesktopService, transport(credential.origin, credential.authKey))
      .setRemoteDesktopDisplayMode({ peer, leaseId, controlGeneration, modeId }, options(signal));
    assertRemoteDesktopPeer(peer, response.peer);
  },
  async transferRemoteDesktopClipboardText(credential, peer, transferValue, signal) {
    const response = await createClient(RemoteDesktopService, transport(credential.origin, credential.authKey))
      .transferRemoteDesktopClipboardText({ peer, transfer: transferValue }, options(signal));
    assertRemoteDesktopPeer(peer, response.peer);
    if (!response.result) throw new Error("The Joko node returned no Remote Desktop clipboard text result.");
    return response.result;
  },
  async transferRemoteDesktopClipboardContent(credential, peer, transferValue, signal) {
    const response = await createClient(RemoteDesktopService, transport(credential.origin, credential.authKey))
      .transferRemoteDesktopClipboardContent({ peer, transfer: transferValue }, options(signal));
    assertRemoteDesktopPeer(peer, response.peer);
    if (!response.result) throw new Error("The Joko node returned no Remote Desktop clipboard content result.");
    return response.result;
  },
  async listPartners(credential, signal) {
    const response = await createClient(PartnerService, transport(credential.origin, credential.authKey))
      .listPartners({}, options(signal));
    return projectMobilePartners(response);
  },
  async listPartnerCatalog(credential, signal) {
    const response = await createClient(PartnerService, transport(credential.origin, credential.authKey))
      .listPartners({}, options(signal));
    return projectMobilePartnerCatalog(response);
  },
  async markPartnerRead(credential, partnerId, throughCursor, signal) {
    if (!validMobilePartnerId(partnerId) || throughCursor < 0n) {
      throw new Error("A valid Partner and read cursor are required.");
    }
    const response = await createClient(PartnerService, transport(credential.origin, credential.authKey))
      .markPartnerRead({ partnerId, throughCursor: { value: throughCursor } }, options(signal));
    return projectMobilePartnerReadResponse(partnerId, throughCursor, response);
  },
  async getPartnerProfileOptions(credential, signal) {
    const response = await createClient(PartnerService, transport(credential.origin, credential.authKey))
      .getPartnerDirectory({}, options(signal));
    return projectMobilePartnerProfileOptions(response.directory);
  },
  async updatePartnerProfile(credential, partnerId, expectedRevision, draft, signal) {
    if (!validMobilePartnerId(partnerId) || expectedRevision < 1n) throw new Error("Select a current Partner profile.");
    const response = await createClient(PartnerService, transport(credential.origin, credential.authKey))
      .updatePartner({ partnerId, expectedRevision: { value: expectedRevision }, patch: {
        displayName: draft.displayName, avatar: draft.avatar, identitySource: draft.identitySource,
        usesDirectoryDefaults: draft.usesDirectoryDefaults,
        ...(draft.usesDirectoryDefaults ? {} : { modelChain: { routes: [...draft.capabilities.modelChain] },
          permissionMode: draft.capabilities.permissionMode === "ask" ? PermissionMode.ASK : PermissionMode.AUTO,
          planMode: draft.capabilities.planMode })
      } }, options(signal));
    return projectMobilePartnerProfileUpdate(partnerId, expectedRevision, response);
  },
  async listPartnerSessions(credential, partnerId, signal) {
    if (!validMobilePartnerId(partnerId)) throw new Error("A valid Partner is required.");
    return createClient(PartnerService, transport(credential.origin, credential.authKey))
      .listPartnerSessions({ partnerId }, options(signal));
  },
  async retryPartnerInitialization(credential, partnerId, expectedRevision, signal) {
    if (!validMobilePartnerId(partnerId) || expectedRevision < 1n) throw new Error("Select a current Partner initialization.");
    const response = await createClient(PartnerService, transport(credential.origin, credential.authKey))
      .retryPartnerInitialization({ partnerId, expectedRevision: { value: expectedRevision } }, options(signal));
    return projectMobilePartnerInitializationRetry(partnerId, expectedRevision, response);
  },
  async listExtensions(credential, signal) {
    const client = createClient(ExtensionService, transport(credential.origin, credential.authKey));
    const requestSignal = signal ?? new AbortController().signal;
    return collectMobileExtensionCatalog(async (pageToken, catalogSignal) => {
      const response = await client.listExtensions({
        installed: true,
        query: "",
        page: { pageSize: 500, pageToken }
      }, options(catalogSignal));
      catalogSignal.throwIfAborted();
      const totalSize = response.page?.totalSize;
      if (response.catalogRevision === undefined || response.page === undefined
        || totalSize === undefined || totalSize > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error("The Joko node did not return valid Extension catalog page metadata.");
      }
      return {
        revision: response.catalogRevision.value,
        recoveredFromCorruption: response.recoveredFromCorruption,
        extensions: response.extensions,
        nextPageToken: response.page.nextPageToken,
        totalSize: Number(totalSize)
      };
    }, requestSignal);
  },
  async getExtension(credential, extensionId, signal) {
    if (!/^extension_[a-f0-9]{32}$/u.test(extensionId)) throw new Error("A current Extension is required.");
    const response = await createClient(ExtensionService, transport(credential.origin, credential.authKey))
      .getExtension({ extensionId }, options(signal));
    signal?.throwIfAborted();
    if (response.catalogRevision?.value === undefined || response.catalogRevision.value < 0n
      || response.extension === undefined || response.extension.extensionId !== extensionId) {
      throw new Error("The Joko node returned a mismatched Extension detail.");
    }
    const extension = projectMobileExtension(response.extension);
    if (!extension.installed) throw new Error("The selected Extension is no longer installed on this Joko node.");
    return extension;
  },
  async getExtensionForRuntime(credential, extensionId, sessionId, signal) {
    if (!/^extension_[a-f0-9]{32}$/u.test(extensionId)) throw new Error("A current Extension is required.");
    if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(sessionId)) throw new Error("A current task runtime is required.");
    const response = await createClient(ExtensionService, transport(credential.origin, credential.authKey))
      .getExtension({ extensionId, sessionId }, options(signal));
    signal?.throwIfAborted();
    if (response.catalogRevision?.value === undefined || response.catalogRevision.value < 0n
      || response.extension === undefined || response.extension.extensionId !== extensionId) {
      throw new Error("The Joko node returned a mismatched Extension detail.");
    }
    const extension = projectMobileExtension(response.extension);
    if (!extension.installed) throw new Error("The selected Extension is no longer installed on this Joko node.");
    return extension;
  },
  async openExtensionMainView(credential, extensionId, expectedRevision, signal) {
    if (!/^extension_[a-f0-9]{32}$/u.test(extensionId) || expectedRevision < 1n) {
      throw new Error("A current Extension main view is required.");
    }
    const response = await createClient(ExtensionService, transport(credential.origin, credential.authKey))
      .openExtensionMainView({ extensionId, expectedRevision: { value: expectedRevision } }, options(signal));
    signal?.throwIfAborted();
    if (response.surface === undefined) throw new Error("The Joko node returned an empty Extension main-view surface.");
    const surface = projectMobileExtensionMainViewSurface(response.surface, credential.origin);
    if (surface.extensionId !== extensionId) throw new Error("The Joko node returned a mismatched Extension main-view surface.");
    return surface;
  },
  async getExtensionMainViewSurface(credential, surfaceId, signal) {
    if (!/^extension_surface_[a-f0-9]{32}$/u.test(surfaceId)) {
      throw new Error("A current Extension main-view surface is required.");
    }
    const response = await createClient(ExtensionService, transport(credential.origin, credential.authKey))
      .getExtensionMainViewSurface({ surfaceId }, options(signal));
    signal?.throwIfAborted();
    if (response.surface === undefined) throw new Error("The Joko node returned an empty Extension main-view probe.");
    const surface = projectMobileExtensionMainViewSurface(response.surface, credential.origin);
    if (surface.surfaceId !== surfaceId) throw new Error("The Joko node returned a mismatched Extension main-view probe.");
    return surface;
  },
  async closeExtensionMainView(credential, surfaceId, signal) {
    if (!/^extension_surface_[a-f0-9]{32}$/u.test(surfaceId)) {
      throw new Error("A current Extension main-view surface is required.");
    }
    const response = await createClient(ExtensionService, transport(credential.origin, credential.authKey))
      .closeExtensionMainView({ surfaceId }, options(signal));
    signal?.throwIfAborted();
    return response.closed;
  },
  async getExtensionLibraryOverview(credential, extensionId, expectedRevision, signal) {
    assertExtensionLibraryAuthority(extensionId, expectedRevision);
    const response = await createClient(ExtensionService, transport(credential.origin, credential.authKey))
      .getExtensionLibraryOverview({ extensionId, expectedRevision: { value: expectedRevision } }, options(signal));
    signal?.throwIfAborted();
    if (response.library === undefined) throw new Error("The Joko node returned an empty Extension Library overview.");
    return projectMobileExtensionLibraryOverview(response.library, extensionId);
  },
  async openExtensionLibrary(credential, extensionId, expectedRevision, surfaceId, signal) {
    assertExtensionLibraryAuthority(extensionId, expectedRevision);
    if (!/^extension_surface_[a-f0-9]{32}$/u.test(surfaceId)) throw new Error("A current Extension Library surface is required.");
    const client = createClient(ExtensionService, transport(credential.origin, credential.authKey));
    const response = await client.openExtensionLibrary({ extensionId, expectedRevision: { value: expectedRevision }, surfaceId }, options(signal));
    try {
      signal?.throwIfAborted();
      if (response.library === undefined) throw new Error("The Joko node returned an empty Extension Library session.");
      return projectMobileExtensionLibrarySession(response.library, extensionId);
    } catch (error) {
      if (/^library_session_[a-f0-9]{32}$/u.test(response.library?.sessionId ?? "")) {
        void client.closeExtensionLibrary({ sessionId: response.library!.sessionId }, { timeoutMs: 5_000 }).catch(() => undefined);
      }
      throw error;
    }
  },
  async callExtensionLibrary(credential, sessionId, call, signal) {
    if (!/^library_session_[a-f0-9]{32}$/u.test(sessionId)) throw new Error("A current Extension Library session is required.");
    const response = await createClient(ExtensionService, transport(credential.origin, credential.authKey))
      .callExtensionLibrary({ sessionId, call: mapMobileExtensionLibraryCall(call) }, options(signal));
    signal?.throwIfAborted();
    if (response.result === undefined) throw new Error("The Joko node returned an empty Extension Library call result.");
    const result = projectMobileExtensionLibraryCallResult(response.result);
    assertMobileExtensionLibraryCallResult(result, call);
    return result;
  },
  async closeExtensionLibrary(credential, sessionId, signal) {
    if (!/^library_session_[a-f0-9]{32}$/u.test(sessionId)) throw new Error("A current Extension Library session is required.");
    const response = await createClient(ExtensionService, transport(credential.origin, credential.authKey))
      .closeExtensionLibrary({ sessionId }, { ...options(signal), timeoutMs: 5_000 });
    signal?.throwIfAborted();
    return response.closed;
  },
  async validateExtensionLibraryLocation(credential, extensionId, expectedRevision, candidate, signal) {
    assertExtensionLibraryAuthority(extensionId, expectedRevision);
    const exactCandidate = normalizeMobileExtensionLibraryCandidate(candidate);
    const response = await createClient(ExtensionService, transport(credential.origin, credential.authKey))
      .validateExtensionLibraryLocation({
        extensionId,
        expectedRevision: { value: expectedRevision },
        candidate: exactCandidate
      }, options(signal));
    signal?.throwIfAborted();
    if (response.validation === undefined) {
      throw new Error("The Joko node returned an empty Extension Library location validation.");
    }
    return projectMobileExtensionLibraryLocationValidation(response.validation);
  },
  async relocateExtensionLibrary(credential, extensionId, expectedRevision, destination, signal) {
    assertExtensionLibraryAuthority(extensionId, expectedRevision);
    const candidate = destination.kind === "custom"
      ? normalizeMobileExtensionLibraryCandidate(destination.candidate)
      : undefined;
    const response = await createClient(ExtensionService, transport(credential.origin, credential.authKey))
      .relocateExtensionLibrary({
        extensionId,
        expectedRevision: { value: expectedRevision },
        destinationKind: destination.kind === "default"
          ? ExtensionLibraryLocationKind.DEFAULT
          : ExtensionLibraryLocationKind.CUSTOM,
        ...(candidate === undefined ? {} : { candidate })
      }, options(signal));
    signal?.throwIfAborted();
    if (response.location === undefined || !Number.isSafeInteger(response.files) || response.files < 0
      || response.bytes < 0n
      || response.migrationId !== undefined && !/^library_migration_[a-f0-9]{32}$/u.test(response.migrationId)
      || response.graceId !== undefined && !/^library_grace_[a-f0-9]{32}$/u.test(response.graceId)) {
      throw new Error("The Joko node returned an invalid Extension Library relocation result.");
    }
    projectMobileExtensionLibraryLocation(response.location);
    projectMobileExtensionLibraryWarnings(response.warnings);
  },
  async rebindExtensionLibrary(credential, extensionId, expectedRevision, candidate, signal) {
    assertExtensionLibraryAuthority(extensionId, expectedRevision);
    const exactCandidate = normalizeMobileExtensionLibraryCandidate(candidate);
    const response = await createClient(ExtensionService, transport(credential.origin, credential.authKey))
      .rebindExtensionLibrary({
        extensionId,
        expectedRevision: { value: expectedRevision },
        candidate: exactCandidate
      }, options(signal));
    signal?.throwIfAborted();
    if (response.location === undefined) throw new Error("The Joko node returned an empty Extension Library rebind result.");
    projectMobileExtensionLibraryLocation(response.location);
    projectMobileExtensionLibraryWarnings(response.warnings);
  },
  async unbindExtensionLibrary(credential, extensionId, expectedRevision, signal) {
    assertExtensionLibraryAuthority(extensionId, expectedRevision);
    const response = await createClient(ExtensionService, transport(credential.origin, credential.authKey))
      .unbindExtensionLibrary({ extensionId, expectedRevision: { value: expectedRevision } }, options(signal));
    signal?.throwIfAborted();
    if (response.detachedPath !== undefined && (response.detachedPath.trim().length === 0
      || response.detachedPath.length > 32_768 || response.detachedPath.includes("\0")
      || response.detachedPath.includes("\r") || response.detachedPath.includes("\n"))) {
      throw new Error("The Joko node returned an invalid detached Extension Library path.");
    }
  },
  async repairExtensionLibraryState(credential, signal) {
    const response = await createClient(ExtensionService, transport(credential.origin, credential.authKey))
      .repairExtensionLibraryState({}, options(signal));
    signal?.throwIfAborted();
    if (!Number.isSafeInteger(response.bindings) || response.bindings < 0
      || !Number.isSafeInteger(response.trash) || response.trash < 0) {
      throw new Error("The Joko node returned an invalid Extension Library repair result.");
    }
  },
  async repairExtensionLibraryMetadata(credential, extensionId, expectedRevision, signal) {
    assertExtensionLibraryAuthority(extensionId, expectedRevision);
    const response = await createClient(ExtensionService, transport(credential.origin, credential.authKey))
      .repairExtensionLibraryMetadata({ extensionId, expectedRevision: { value: expectedRevision } }, options(signal));
    signal?.throwIfAborted();
    if (response.library === undefined) throw new Error("The Joko node returned an empty repaired Extension Library.");
    projectMobileExtensionLibraryOverview(response.library, extensionId);
  },
  async trashExtensionLibrary(credential, extensionId, expectedRevision, confirmation, signal) {
    assertExtensionLibraryAuthority(extensionId, expectedRevision);
    assertExtensionLibraryConfirmation(confirmation);
    const response = await createClient(ExtensionService, transport(credential.origin, credential.authKey))
      .trashExtensionLibrary({
        extensionId,
        expectedRevision: { value: expectedRevision },
        confirmation
      }, options(signal));
    signal?.throwIfAborted();
    if (response.trash === undefined) throw new Error("The Joko node returned an empty Extension Library trash record.");
    projectMobileExtensionLibraryTrash(response.trash, extensionId);
  },
  async listExtensionLibraryTrash(credential, extensionId, signal) {
    if (!/^extension_[a-f0-9]{32}$/u.test(extensionId)) throw new Error("A current Extension Library is required.");
    const response = await createClient(ExtensionService, transport(credential.origin, credential.authKey))
      .listExtensionLibraryTrash({ extensionId }, options(signal));
    signal?.throwIfAborted();
    return projectMobileExtensionLibraryTrashList(response.trash, extensionId);
  },
  async restoreExtensionLibraryTrash(credential, extensionId, trashId, confirmation, destination, signal) {
    if (!/^extension_[a-f0-9]{32}$/u.test(extensionId) || !/^library_trash_[a-f0-9]{32}$/u.test(trashId)) {
      throw new Error("A current Extension Library trash record is required.");
    }
    assertExtensionLibraryConfirmation(confirmation);
    const response = await createClient(ExtensionService, transport(credential.origin, credential.authKey))
      .restoreExtensionLibraryTrash({
        trashId,
        confirmation,
        destinationKind: destination === "default"
          ? ExtensionLibraryLocationKind.DEFAULT
          : ExtensionLibraryLocationKind.UNSPECIFIED
      }, options(signal));
    signal?.throwIfAborted();
    if (response.extensionId !== extensionId || response.location === undefined) {
      throw new Error("The Joko node returned a mismatched Extension Library restore result.");
    }
    projectMobileExtensionLibraryLocation(response.location);
  },
  async purgeExtensionLibraryTrash(credential, extensionId, trashId, confirmation, signal) {
    if (!/^extension_[a-f0-9]{32}$/u.test(extensionId) || !/^library_trash_[a-f0-9]{32}$/u.test(trashId)) {
      throw new Error("A current Extension Library trash record is required.");
    }
    assertExtensionLibraryConfirmation(confirmation);
    const response = await createClient(ExtensionService, transport(credential.origin, credential.authKey))
      .purgeExtensionLibraryTrash({ trashId, confirmation }, options(signal));
    signal?.throwIfAborted();
    if (!response.purged) throw new Error("The Extension Library trash record was not purged.");
  },
  async listExtensionLibraryGrace(credential, extensionId, signal) {
    if (!/^extension_[a-f0-9]{32}$/u.test(extensionId)) throw new Error("A current Extension Library is required.");
    const response = await createClient(ExtensionService, transport(credential.origin, credential.authKey))
      .listExtensionLibraryGrace({ extensionId }, options(signal));
    signal?.throwIfAborted();
    return projectMobileExtensionLibraryGraceList(response.grace, extensionId);
  },
  async rollbackExtensionLibrary(credential, extensionId, expectedRevision, graceId, signal) {
    assertExtensionLibraryAuthority(extensionId, expectedRevision);
    if (!/^library_grace_[a-f0-9]{32}$/u.test(graceId)) {
      throw new Error("A current Extension Library grace record is required.");
    }
    const response = await createClient(ExtensionService, transport(credential.origin, credential.authKey))
      .rollbackExtensionLibrary({
        extensionId,
        expectedRevision: { value: expectedRevision },
        graceId
      }, options(signal));
    signal?.throwIfAborted();
    if (response.graceId !== graceId || response.location === undefined) {
      throw new Error("The Joko node returned a mismatched Extension Library rollback result.");
    }
    projectMobileExtensionLibraryLocation(response.location);
  },
  async uploadExtensionSetupCredential(credential, extensionId, attemptId, fieldId, kind, secret, signal) {
    signal?.throwIfAborted();
    if (!/^extension_[a-f0-9]{32}$/u.test(extensionId)
      || !validExtensionSetupIdentity(attemptId) || !validExtensionSetupIdentity(fieldId)) {
      throw new Error("A current Extension setup field is required.");
    }
    const credentialKind = kind === "oauth" ? CredentialKind.OAUTH
      : kind === "headerSecret" ? CredentialKind.HEADER_SECRET
        : kind === "apiKey" ? CredentialKind.API_KEY
          : undefined;
    if (credentialKind === undefined) throw new Error("A supported Extension credential kind is required.");
    const bytes = new TextEncoder().encode(secret);
    try {
      if (bytes.byteLength === 0 || bytes.byteLength > 64 * 1024 || secret.includes("\0")) {
        throw new Error("The Extension credential input is invalid.");
      }
      const response = await createClient(ExtensionService, transport(credential.origin, credential.authKey))
        .beginExtensionSetupCredentialUpload({ extensionId, attemptId, fieldId, kind: credentialKind }, options(signal));
      signal?.throwIfAborted();
      const ticket = response.ticket;
      if (!ticket || !validExtensionSetupIdentity(ticket.ticketId)
        || ticket.maximumBytes <= 0n
        || BigInt(bytes.byteLength) > ticket.maximumBytes || ticket.expiresAt === undefined) {
        throw new Error("The Extension credential channel is unavailable.");
      }
      const expirySeconds = Number(ticket.expiresAt.seconds);
      if (!Number.isSafeInteger(expirySeconds) || expirySeconds < 0
        || !Number.isInteger(ticket.expiresAt.nanos) || ticket.expiresAt.nanos < 0
        || ticket.expiresAt.nanos >= 1_000_000_000) {
        throw new Error("The Extension credential channel returned an invalid expiry.");
      }
      if ((expirySeconds * 1_000 + Math.floor(ticket.expiresAt.nanos / 1_000_000)) <= Date.now()) {
        throw new Error("The Extension credential channel has expired.");
      }
      const endpoint = authorizedExtensionCredentialEndpoint(credential.origin, ticket.relativeEndpoint);
      const upload = await fetch(endpoint, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${credential.authKey}`,
          "content-type": "application/octet-stream"
        },
        body: bytes,
        cache: "no-store",
        signal
      });
      signal?.throwIfAborted();
      if (!upload.ok) throw new Error(`Extension credential upload failed (${upload.status}).`);
      return ticket.ticketId;
    } finally {
      bytes.fill(0);
    }
  },
  async listPartnerPrivateThreads(credential, partnerId, signal) {
    if (!validMobilePartnerId(partnerId)) throw new Error("A valid Partner is required.");
    const response = await createClient(PartnerService, transport(credential.origin, credential.authKey))
      .listPartnerPrivateThreads({ partnerId }, options(signal));
    return projectMobilePrivateThreads(partnerId, response);
  },
  async getPartnerPrivateThread(credential, partnerId, threadId, signal) {
    if (!validMobilePartnerId(partnerId) || !validMobilePartnerId(threadId)) {
      throw new Error("A valid Partner and private thread are required.");
    }
    const response = await createClient(PartnerService, transport(credential.origin, credential.authKey))
      .getPartnerPrivateThread({ partnerId, threadId }, options(signal));
    return projectMobilePrivateDetail(partnerId, threadId, response);
  },
  async markPartnerPrivateThreadRead(credential, partnerId, threadId, throughSequence, maximumSequence, signal) {
    if (!validMobilePartnerId(partnerId) || !validMobilePartnerId(threadId)
      || !Number.isSafeInteger(throughSequence) || throughSequence < 1
      || !Number.isSafeInteger(maximumSequence) || throughSequence > maximumSequence) {
      throw new Error("A visible private message is required before marking it read.");
    }
    const response = await createClient(PartnerService, transport(credential.origin, credential.authKey))
      .markPartnerPrivateThreadRead({ partnerId, threadId, throughSequence: BigInt(throughSequence) }, options(signal));
    return projectMobilePrivateReadResponse(partnerId, threadId, response, throughSequence, maximumSequence);
  },
  async getMobilePushCapability(rawOrigin, signal) {
    const origin = normalizeNodeOrigin(rawOrigin);
    const capability = (await createClient(ConnectionService, transport(origin))
      .getMobilePushCapability({}, options(signal))).capability;
    if (!capability || capability.provider !== MobilePushProvider.APNS) {
      throw new Error("The Joko node returned an invalid mobile push capability.");
    }
    const reason = capability.unavailableReasonCode;
    if (reason && !/^[A-Z0-9_]{1,64}$/u.test(reason)) {
      throw new Error("The Joko node returned an invalid mobile push capability reason.");
    }
    if (capability.supported && reason) {
      throw new Error("The Joko node returned an incoherent mobile push capability.");
    }
    return { supported: capability.supported, ...(reason ? { unavailableReasonCode: reason } : {}) };
  },
  async registerMobilePush(credential, input, signal) {
    if (input.expectedDeviceRevision < 1n) throw new Error("A current Device revision is required for mobile push.");
    const ticket = normalizedMobilePushTicket(input.ticket);
    if (ticket.serverId !== credential.serverId) throw new Error("The mobile push ticket belongs to another Joko node.");
    const environment = wireMobilePushEnvironment(input.environment);
    const locale = wireMobilePushLocale(input.locale);
    const response = await createClient(ConnectionService, transport(credential.origin, credential.authKey)).registerMobilePush({
      connectionId: credential.connectionId,
      deviceId: credential.deviceId,
      expectedDeviceRevision: input.expectedDeviceRevision,
      provider: MobilePushProvider.APNS,
      environment,
      locale,
      deviceToken: normalizedMobilePushToken(input.deviceToken),
      registrationId: ticket.registrationId,
      revocationSecret: ticket.secret
    }, options(signal));
    const registration = response.registration;
    const returnedTicket = response.revocationTicket;
    const expiresAt = safeCatalogTimestamp(registration?.expiresAt);
    const revision = registration?.version?.revision?.value ?? 0n;
    if (!registration || !returnedTicket || expiresAt === undefined || expiresAt < 1 || revision < 1n
      || registration.registrationId !== ticket.registrationId
      || registration.connectionId !== credential.connectionId || registration.deviceId !== credential.deviceId
      || registration.provider !== MobilePushProvider.APNS || registration.environment !== environment
      || registration.locale !== locale || returnedTicket.serverId !== ticket.serverId
      || returnedTicket.registrationId !== ticket.registrationId || returnedTicket.secret !== ticket.secret) {
      throw new Error("The Joko node returned an invalid mobile push registration.");
    }
    return {
      registrationId: registration.registrationId,
      connectionId: registration.connectionId,
      deviceId: registration.deviceId,
      environment: input.environment,
      locale: input.locale,
      expiresAt,
      revision,
      ticket
    };
  },
  async unregisterMobilePush(rawOrigin, rawTicket, signal) {
    const origin = normalizeNodeOrigin(rawOrigin);
    const ticket = normalizedMobilePushTicket(rawTicket);
    await createClient(ConnectionService, transport(origin)).unregisterMobilePush({
      serverId: ticket.serverId,
      registrationId: ticket.registrationId,
      revocationSecret: ticket.secret
    }, options(signal));
  },
  async readSession(credential, sessionId, signal) {
    const response = await createClient(EventService, transport(credential.origin, credential.authKey)).getSnapshot({
      scope: { kind: { case: "session", value: { sessionId, recentTimelineItems: 120 } } }
    }, options(signal));
    if (!response.snapshot || !response.snapshot.sessions.some((session) => session.sessionId === sessionId)) {
      throw new Error("The selected task is no longer available on this Joko node.");
    }
    return response.snapshot;
  },
  async readNativeSessionTree(credential, sessionId, signal) {
    if (!sessionId) throw new Error("A current task is required for native branches.");
    const response = await createClient(SessionService, transport(credential.origin, credential.authKey))
      .getNativeSessionTree({ sessionId }, options(signal));
    if (!response.tree) throw new Error("The Joko node returned no native branch tree.");
    return response.tree;
  },
  async previewTaskTagDeletion(credential, taskTagId, signal) {
    if (!taskTagId) throw new Error("An exact task tag is required.");
    const response = await createClient(SessionService, transport(credential.origin, credential.authKey))
      .previewTaskTagDeletion({ taskTagId }, options(signal));
    if (!response.preview || response.preview.taskTagId !== taskTagId) {
      throw new Error("The Joko node returned a mismatched task-tag delete preview.");
    }
    return response.preview;
  },
  async listBackgroundTasks(credential, sessionId, pageToken = "", signal) {
    signal?.throwIfAborted();
    if (!sessionId) throw new Error("A current task is required for background activity.");
    const response = await createClient(SessionService, transport(credential.origin, credential.authKey))
      .listBackgroundTasks({ sessionId, page: { pageToken, pageSize: 100 } }, options(signal));
    if (response.backgroundTasks.some((task) => !task.backgroundTaskId || task.sessionId !== sessionId)) {
      throw new Error("The background activity response belongs to another task.");
    }
    return { tasks: response.backgroundTasks, nextPageToken: response.page?.nextPageToken ?? "" };
  },
  async listSubagentRuns(credential, sessionId, pageToken = "", signal) {
    signal?.throwIfAborted();
    if (!sessionId) throw new Error("A current task is required for delegated activity.");
    const response = await createClient(SubagentService, transport(credential.origin, credential.authKey))
      .listSubagentRuns({ sessionId, page: { pageToken, pageSize: 100 } }, options(signal));
    if (response.runs.some((run) => !run.subagentRunId || run.sessionId !== sessionId)) {
      throw new Error("The delegated activity response belongs to another task.");
    }
    return { runs: response.runs, nextPageToken: response.page?.nextPageToken ?? "" };
  },
  async getSubagentRun(credential, sessionId, runId, signal) {
    signal?.throwIfAborted();
    if (!sessionId || !runId) throw new Error("An exact delegated run is required.");
    const response = await createClient(SubagentService, transport(credential.origin, credential.authKey))
      .getSubagentRun({ sessionId, subagentRunId: runId }, options(signal));
    if (!response.run?.run || response.run.run.sessionId !== sessionId || response.run.run.subagentRunId !== runId) {
      throw new Error("The delegated detail response belongs to another run.");
    }
    return response.run;
  },
  async listSubagentTranscript(credential, sessionId, runId, childId = "", pageToken = "", signal) {
    signal?.throwIfAborted();
    if (!sessionId || !runId) throw new Error("An exact delegated run is required.");
    const response = await createClient(SubagentService, transport(credential.origin, credential.authKey))
      .listSubagentTranscript({ sessionId, subagentRunId: runId, childId, page: { pageToken, pageSize: 200 } }, options(signal));
    if (response.entries.some((entry) => !entry.entryId || entry.sequence < 0n)) throw new Error("The delegated transcript contains an invalid entry.");
    return { entries: response.entries, nextPageToken: response.page?.nextPageToken ?? "", tailPageToken: response.tailPageToken };
  },
  async readHistory(credential, sessionId, before, signal) {
    const response = await createClient(SessionService, transport(credential.origin, credential.authKey)).listSessionTimeline({
      sessionId, limit: 120, ...(before === undefined ? {} : { beforeCursor: before })
    }, options(signal));
    return { events: response.events, ...(response.nextBeforeCursor === undefined ? {} : { before: response.nextBeforeCursor }) };
  },
  async readAround(credential, sessionId, eventId, signal) {
    const response = await createClient(SessionService, transport(credential.origin, credential.authKey)).listSessionTimeline({
      sessionId, aroundEventId: eventId, limit: 120
    }, options(signal));
    return response.events;
  },
  async searchSessionMessages(credential, query, status, signal) {
    const client = createClient(SessionService, transport(credential.origin, credential.authKey));
    return collectSessionMessageSearchPages(async (pageToken) => {
      const response = await client.searchSessionMessages({
        scope: { case: "owner", value: {} },
        query,
        page: { pageSize: MESSAGE_SEARCH_PAGE_SIZE, pageToken },
        semanticMode: SessionMessageSearchSemanticMode.UNSPECIFIED,
        filters: { sessionStatus: status }
      }, options(signal));
      if (!response.page) throw new Error("The Joko node did not return message-search page metadata.");
      return {
        matches: response.matches,
        nextPageToken: response.page.nextPageToken,
        totalSize: response.page.totalSize
      };
    });
  },
  async listWorkspaceDirectory(credential, workspaceId, parentPath, signal) {
    if (!workspaceId) throw new Error("A current Workspace is required.");
    const parent = canonicalWorkspacePath(parentPath, true);
    const client = createClient(WorkspaceService, transport(credential.origin, credential.authKey));
    return collectWorkspaceDirectoryPages(workspaceId, parent, async (pageToken) => {
      const response = await client.listWorkspaceEntries({
        workspaceId,
        parentRelativePath: parent,
        includeHidden: true,
        listingPolicy: WorkspaceEntryListingPolicy.DOCUMENT_TREE,
        page: { pageSize: WORKSPACE_PAGE_SIZE, pageToken }
      }, options(signal));
      if (!response.page) throw new Error("The Joko node did not return workspace-directory page metadata.");
      return {
        entries: response.entries,
        nextPageToken: response.page.nextPageToken,
        totalSize: response.page.totalSize,
        revision: responseRevision(response.revision)
      };
    });
  },
  async listWorkspaceChangeSets(credential, workspaceId, sessionId, signal) {
    signal?.throwIfAborted();
    if (!workspaceId || !sessionId) throw new Error("A current Workspace and task are required.");
    const client = createClient(WorkspaceService, transport(credential.origin, credential.authKey));
    return collectWorkspaceChangeSetPages(workspaceId, sessionId, async (pageToken) => {
      signal?.throwIfAborted();
      const response = await client.listWorkspaceChangeSets({ workspaceId, sessionId,
        page: { pageSize: WORKSPACE_PAGE_SIZE, pageToken } }, options(signal));
      if (!response.page) throw new Error("The Joko node did not return Workspace checkpoint page metadata.");
      return { changeSets: response.changeSets, nextPageToken: response.page.nextPageToken, totalSize: response.page.totalSize };
    });
  },
  async previewWorkspaceRewind(credential, workspaceId, changeSetId, signal) {
    signal?.throwIfAborted();
    if (!workspaceId || !changeSetId) throw new Error("A current Workspace checkpoint is required.");
    const response = await createClient(WorkspaceService, transport(credential.origin, credential.authKey))
      .previewWorkspaceRewind({ workspaceId, changeSetId }, options(signal));
    if (!response.preview) throw new Error("The Joko node did not return a Workspace rewind preview.");
    return response.preview;
  },
  async listWorkspaceFileIndex(credential, workspaceId, signal) {
    if (!workspaceId) throw new Error("A current Workspace is required.");
    const response = await createClient(WorkspaceService, transport(credential.origin, credential.authKey))
      .listWorkspaceFiles({ workspaceId }, options(signal));
    if (response.relativePaths.length > 30_000) throw new Error("The Joko node returned an oversized workspace file index.");
    const paths = response.relativePaths.map((path) => canonicalWorkspacePath(path));
    if (new Set(paths).size !== paths.length) throw new Error("The Joko node returned duplicate workspace file-index paths.");
    return { paths, truncated: response.truncated, revision: responseRevision(response.revision) };
  },
  async searchWorkspace(credential, workspaceId, query, caseSensitive, signal) {
    if (!workspaceId || !query) throw new Error("A current Workspace and literal search query are required.");
    const client = createClient(WorkspaceService, transport(credential.origin, credential.authKey));
    return collectWorkspaceSearchPages(workspaceId, async (pageToken) => {
      const response = await client.searchWorkspace({
        workspaceId,
        query,
        relativePathPrefix: "",
        caseSensitive,
        regularExpression: false,
        page: { pageSize: WORKSPACE_PAGE_SIZE, pageToken }
      }, options(signal));
      if (!response.page) throw new Error("The Joko node did not return workspace-search page metadata.");
      return {
        matches: response.matches,
        nextPageToken: response.page.nextPageToken,
        totalSize: response.page.totalSize,
        revision: responseRevision(response.revision),
        truncated: response.truncated,
        totalFiles: response.totalFiles
      };
    });
  },
  async *watchWorkspace(credential, workspaceId, signal) {
    if (!workspaceId) throw new Error("A current Workspace is required.");
    const client = createClient(WorkspaceService, transport(credential.origin, credential.authKey));
    let previousSequence = 0n;
    for await (const response of client.watchWorkspaceFileChanges({
      scope: { kind: { case: "workspace", value: { workspaceId } } }
    }, { signal })) {
      const change = response.change;
      if (!change || change.workspaceId !== workspaceId || change.sequence <= previousSequence || !change.streamRevision) {
        throw new Error("The Joko node returned an invalid workspace change stream.");
      }
      if (change.kind !== WorkspaceFileChangeKind.OVERFLOW && change.kind !== WorkspaceFileChangeKind.RESYNC) {
        canonicalWorkspacePath(change.relativePath);
      }
      if (change.kind === WorkspaceFileChangeKind.RENAMED) canonicalWorkspacePath(change.previousRelativePath);
      previousSequence = change.sequence;
      yield change;
    }
  },
  async readWorkspaceFile(credential, workspaceId, relativePath, revision, signal) {
    const path = canonicalWorkspacePath(relativePath);
    if (!workspaceId || !revision.opaqueRevision) throw new Error("A current Workspace file revision is required.");
    const response = await createClient(WorkspaceService, transport(credential.origin, credential.authKey)).readWorkspaceFile({
      workspaceId,
      relativePath: path,
      startByte: 0n,
      maximumBytes: 2_097_152n,
      expectedRevision: revision
    }, options(signal));
    return assertWorkspaceFilePreview(workspaceId, path, revision, response.preview);
  },
  async materializeWorkspaceFileBlob(credential, workspaceId, relativePath, revision, signal) {
    const path = canonicalWorkspacePath(relativePath);
    if (!workspaceId || !revision.opaqueRevision) throw new Error("A current Workspace file revision is required.");
    if (revision.byteSize < 0n || revision.byteSize > BigInt(MOBILE_FILE_SHARE_MAXIMUM_BYTES)) {
      throw new Error("The Workspace file exceeds the mobile sharing limit.");
    }
    const response = await createClient(WorkspaceService, transport(credential.origin, credential.authKey)).readWorkspaceFile({
      workspaceId,
      relativePath: path,
      startByte: 0n,
      maximumBytes: BigInt(MOBILE_FILE_SHARE_MAXIMUM_BYTES),
      expectedRevision: revision,
      requireBlob: true
    }, options(signal));
    return assertMaterializedWorkspaceBlob(workspaceId, path, revision, response.preview);
  },
  async readWorkspaceHtmlSnapshot(credential, sessionId, file, signal) {
    const relativePath = canonicalWorkspacePath(file.relativePath);
    if (!sessionId || !file.workspaceId || file.expectedRevision !== "" && !/^workspace-html:[0-9a-f]{64}$/u.test(file.expectedRevision)) {
      throw new Error("A current task and canonical HTML snapshot reference are required.");
    }
    const response = await createClient(WorkspaceService, transport(credential.origin, credential.authKey))
      .readWorkspaceHtmlSnapshot({ sessionId, file: { ...file, relativePath } }, options(signal));
    signal?.throwIfAborted();
    if (!response.file || response.file.workspaceId !== file.workspaceId || response.file.relativePath !== relativePath
      || !/^workspace-html:[0-9a-f]{64}$/u.test(response.file.expectedRevision)
      || file.expectedRevision !== "" && response.file.expectedRevision !== file.expectedRevision
      || new TextEncoder().encode(response.utf8Html).byteLength > 2_097_152) {
      throw new Error("The Joko node returned a mismatched complete HTML snapshot.");
    }
    return { file: response.file, html: response.utf8Html };
  },
  async listSessionArtifacts(credential, sessionId, signal) {
    if (!sessionId) throw new Error("A current task is required for Generated files.");
    const client = createClient(ArtifactService, transport(credential.origin, credential.authKey));
    return collectArtifactPages(sessionId, async (pageToken) => {
      const response = await client.listArtifacts({
        sessionId,
        page: { pageSize: WORKSPACE_PAGE_SIZE, pageToken }
      }, options(signal));
      if (!response.page) throw new Error("The Joko node did not return Artifact page metadata.");
      return {
        artifacts: response.artifacts,
        nextPageToken: response.page.nextPageToken,
        totalSize: response.page.totalSize,
        revision: responseRevision(response.revision)
      };
    });
  },
  async listRuntimeCommands(credential, sessionId, signal) {
    if (!validCatalogIdentity(sessionId, 1_024)) throw new Error("A current task is required for its runtime command catalog.");
    const response = await createClient(SessionService, transport(credential.origin, credential.authKey))
      .listRuntimeCommands({ sessionId }, options(signal));
    return response.commands;
  },
  async listSessionResources(credential, sessionId, signal) {
    if (!validCatalogIdentity(sessionId, 1_024)) throw new Error("A current task is required for its Resource catalog.");
    const response = await createClient(SessionService, transport(credential.origin, credential.authKey))
      .listSessionResources({ sessionId }, options(signal));
    return assertSessionResourceCatalog(sessionId, response.resources);
  },
  async listArtifactReferenceCatalog(credential, sessionId, generation, signal) {
    if (!validCatalogIdentity(sessionId, 1_024) || generation < 1n || generation > 0xffff_ffff_ffff_ffffn) {
      throw new Error("A current task generation is required for its Artifact reference catalog.");
    }
    const client = createClient(ArtifactService, transport(credential.origin, credential.authKey));
    return collectArtifactReferencePages(async (pageToken) => {
      const response = await client.listArtifacts({
        referenceTargetSessionId: sessionId,
        referenceTargetGeneration: generation,
        page: { pageSize: WORKSPACE_PAGE_SIZE, pageToken }
      }, options(signal));
      if (!response.page) throw new Error("The Joko node did not return Artifact reference page metadata.");
      return {
        artifacts: response.artifacts,
        nextPageToken: response.page.nextPageToken,
        totalSize: response.page.totalSize,
        revision: responseRevision(response.revision)
      };
    });
  },
  async listSchedules(credential, signal) {
    const client = createClient(SchedulerService, transport(credential.origin, credential.authKey));
    return collectSchedulePages(async (pageToken) => {
      const response = await client.listSchedules({
        page: { pageSize: SCHEDULE_PAGE_SIZE, pageToken }
      }, options(signal));
      if (!response.page) throw new Error("The Joko node did not return Automation catalog page metadata.");
      return {
        schedules: response.schedules,
        nextPageToken: response.page.nextPageToken,
        totalSize: response.page.totalSize
      };
    });
  },
  async readSchedule(credential, scheduleId, signal) {
    if (!validCatalogIdentity(scheduleId, 512)) throw new Error("A current Automation Schedule is required.");
    const response = await createClient(SchedulerService, transport(credential.origin, credential.authKey))
      .getSchedule({ scheduleId }, options(signal));
    if (!response.schedule || response.schedule.scheduleId !== scheduleId) {
      throw new Error("The Joko node returned a different Automation Schedule.");
    }
    return response.schedule;
  },
  async listScheduleHistory(credential, scheduleId, pageToken = "", signal) {
    if (!validCatalogIdentity(scheduleId, 512) || !validSchedulePageToken(pageToken)) {
      throw new Error("A current Automation Schedule and valid history cursor are required.");
    }
    const response = await createClient(SchedulerService, transport(credential.origin, credential.authKey))
      .listScheduleRunHistory({
        scheduleId,
        page: { pageSize: SCHEDULE_HISTORY_PAGE_SIZE, pageToken }
      }, options(signal));
    if (!response.page) throw new Error("The Joko node did not return Automation history page metadata.");
    return validateScheduleHistoryPage(scheduleId, pageToken, {
      history: response.history,
      nextPageToken: response.page.nextPageToken,
      totalSize: response.page.totalSize
    });
  },
  async readSchedulerRuntime(credential, signal) {
    const response = await createClient(SchedulerService, transport(credential.origin, credential.authKey))
      .getSchedulerRuntime({}, options(signal));
    if (!response.runtime) throw new Error("The Joko node returned no Scheduler runtime.");
    return response.runtime;
  },
  async probeTargetWorktree(credential, targetId, signal) {
    if (!validCatalogIdentity(targetId, 512)) throw new Error("A current Target is required for Worktree discovery.");
    const response = await createClient(WorktreeService, transport(credential.origin, credential.authKey))
      .probeTargetWorktree({ targetId }, options(signal));
    if (response.targetId !== targetId) throw new Error("The Joko node returned a Worktree probe for another Target.");
    return {
      targetId,
      eligibility: mobileWorktreeEligibility(response.eligibility),
      canRefreshRemote: response.canRefreshRemote
    };
  },
  async listTargetWorktreeSources(credential, targetId, signal) {
    if (!validCatalogIdentity(targetId, 512)) throw new Error("A current Target is required for Worktree discovery.");
    const client = createClient(WorktreeService, transport(credential.origin, credential.authKey));
    return collectTargetWorktreeSourcePages(async (pageToken) => {
      const response = await client.listTargetWorktreeSources({
        targetId,
        page: { pageSize: WORKSPACE_PAGE_SIZE, pageToken }
      }, options(signal));
      if (!response.page) throw new Error("The Joko node did not return Worktree source page metadata.");
      return {
        sources: response.sources.map((source) => ({
          ref: source.ref,
          commit: source.commit,
          displayName: source.displayName,
          remote: source.remote,
          current: source.current
        })),
        nextPageToken: response.page.nextPageToken,
        totalSize: response.page.totalSize
      };
    });
  },
  async downloadBlob(credential, blob, signal) {
    assertDownloadBlob(blob);
    const response = await createClient(ArtifactService, transport(credential.origin, credential.authKey))
      .getBlobDownloadTicket({ blobId: blob.blobId }, options(signal));
    return downloadVerifiedBlob(credential, blob, response.ticket, signal);
  },
  async readImageThumbnail(credential, blob, edge, signal) {
    assertDownloadBlob(blob);
    const response = await createClient(ArtifactService, transport(credential.origin, credential.authKey))
      .getImageThumbnail({ expectedSourceBlob: blob, maximumEdgePixels: edge }, options(signal));
    signal?.throwIfAborted(); const source = response.sourceBlob;
    if (!source || source.blobId !== blob.blobId || source.sha256Hex !== blob.sha256Hex || source.byteSize !== blob.byteSize
      || source.mediaType !== blob.mediaType || source.fileName !== blob.fileName) throw new Error("The thumbnail belongs to another canonical Blob.");
    if (response.result.case === "unavailable") {
      if (![ImageThumbnailUnavailableReason.UNSUPPORTED, ImageThumbnailUnavailableReason.INPUT_TOO_LARGE,
        ImageThumbnailUnavailableReason.RENDER_FAILED, ImageThumbnailUnavailableReason.BUSY].includes(response.result.value)) throw new Error("The image thumbnail outcome is unknown.");
      return undefined;
    }
    if (response.result.case !== "thumbnail") throw new Error("The image thumbnail result is missing.");
    const value = response.result.value;
    if (value.mediaType !== "image/webp" || !/^[0-9a-f]{64}$/u.test(value.sha256Hex) || !value.data.length || value.data.length > 700 * 1024
      || !Number.isSafeInteger(value.widthPixels) || !Number.isSafeInteger(value.heightPixels) || value.widthPixels < 1 || value.heightPixels < 1
      || value.widthPixels > edge || value.heightPixels > edge || value.sourceWidthPixels < 1 || value.sourceHeightPixels < 1
      || value.sourceWidthPixels > 16_384 || value.sourceHeightPixels > 16_384 || value.sourceWidthPixels * value.sourceHeightPixels > 64 * 1024 * 1024
      || Math.max(value.widthPixels, value.heightPixels) > Math.max(value.sourceWidthPixels, value.sourceHeightPixels)) throw new Error("The image thumbnail exceeds its presentation bounds.");
    return value;
  },
  async authorizeBlobDownload(credential, blob, signal) {
    assertShareBlob(blob);
    const response = await createClient(ArtifactService, transport(credential.origin, credential.authKey))
      .getBlobDownloadTicket({ blobId: blob.blobId }, options(signal));
    signal?.throwIfAborted();
    return authorizeVerifiedBlobDownload(credential, blob, response.ticket);
  },
  async uploadBlob(credential, source, signal) {
    const exact = assertBlobUploadSource(source);
    const client = createClient(ArtifactService, transport(credential.origin, credential.authKey));
    const response = await client.beginBlobUpload({
      fileName: exact.fileName,
      mediaType: exact.mediaType,
      byteSize: BigInt(exact.byteSize),
      sha256Hex: exact.sha256Hex,
      disposition: BlobDisposition.ATTACHMENT
    }, options(signal));
    return uploadVerifiedBlob(
      credential,
      exact,
      response.upload,
      async (uploadId, completeSignal) => (await client.completeBlobUpload(
        { uploadId },
        options(completeSignal)
      )).blob,
      signal
    );
  },
  async getVoiceInputCapabilities(credential, signal) {
    const response = await createClient(VoiceInputService, transport(credential.origin, credential.authKey))
      .getVoiceInputCapabilities({}, options(signal));
    return projectMobileVoiceCapability(response.profile);
  },
  async getVoiceInputServiceSettings(credential, signal) {
    const response = await createClient(SettingsService, transport(credential.origin, credential.authKey)).getSettings({}, options(signal));
    signal?.throwIfAborted();
    return assertMobileVoiceServiceSettings(response.settings?.voiceInput);
  },
  async uploadVoiceInputSecret(credential, secret, fallback, signal) {
    signal?.throwIfAborted();
    const bytes = new TextEncoder().encode(secret);
    try {
      if (bytes.length === 0 || bytes.length > 64 * 1024) throw new Error("The voice credential input is invalid.");
      const response = await createClient(CredentialService, transport(credential.origin, credential.authKey))
        .beginCredentialUpload({ kind: CredentialKind.API_KEY, providerId: "" }, options(signal));
      signal?.throwIfAborted();
      const ticket = response.ticket;
      if (!ticket?.ticketId || ticket.maximumBytes < BigInt(bytes.length) || !ticket.relativeEndpoint.startsWith("/")) throw new Error("The voice credential channel is unavailable.");
      const endpoint = new URL(ticket.relativeEndpoint, credential.origin);
      if (endpoint.origin !== new URL(credential.origin).origin || endpoint.username || endpoint.password || endpoint.hash) throw new Error("The voice credential channel is invalid.");
      const upload = await fetch(endpoint.toString(), { method: "PUT", headers: {
        authorization: `Bearer ${credential.authKey}`, "content-type": "application/octet-stream"
      }, body: bytes, signal });
      signal?.throwIfAborted();
      if (!upload.ok) throw new Error("The voice credential could not be uploaded.");
      return ticket.ticketId;
    } finally { bytes.fill(0); }
  },
  async testVoiceInputConnection(credential, signal) {
    const result = await createClient(VoiceInputService, transport(credential.origin, credential.authKey)).testVoiceInputConnection({}, options(signal));
    signal?.throwIfAborted();
    return result;
  },
  async getVoiceInputDictionary(credential, signal) {
    const response = await createClient(VoiceInputService, transport(credential.origin, credential.authKey))
      .getVoiceInputDictionary({}, options(signal));
    return projectMobileVoiceDictionarySnapshot(response.dictionary);
  },
  async getVoiceInputDictionaryPeerStatus(credential, signal) {
    const response = await createClient(VoiceInputService, transport(credential.origin, credential.authKey)).getVoiceInputDictionaryPeerStatus({}, options(signal));
    return projectVoiceDictionaryPeerStatus(response.status);
  },
  async getVoiceInputDictionaryReadOnly(credential, signal) {
    const response = await createClient(VoiceInputService, transport(credential.origin, credential.authKey))
      .getVoiceInputDictionaryReadOnly({}, options(signal));
    return projectVoiceDictionaryReadOnly(response.dictionary);
  },
  async *watchVoiceInputDictionaryReadOnly(credential, signal) {
    let sequence = 0n;
    const request = new AbortController();
    const cancel = (): void => request.abort();
    if (signal.aborted) cancel(); else signal.addEventListener("abort", cancel, { once: true });
    try {
      const stream = createClient(VoiceInputService, transport(credential.origin, credential.authKey)).watchVoiceInputDictionaryReadOnly({}, options(request.signal));
      for await (const response of stream) {
        request.signal.throwIfAborted();
        sequence = nextVoiceDictionaryWatchSequence(response.sequence, sequence);
        yield projectVoiceDictionaryReadOnly(response.dictionary);
      }
    } finally { cancel(); signal.removeEventListener("abort", cancel); }
  },
  async grantVoiceInputDictionaryPeer(credential, expectedConfigurationRevision, peerId, expectedFingerprint, signal) {
    const response = await createClient(VoiceInputService, transport(credential.origin, credential.authKey)).grantVoiceInputDictionaryPeer({ expectedConfigurationRevision, peerId, expectedFingerprint }, options(signal));
    return projectVoiceDictionaryPeerStatus(response.status);
  },
  async *watchVoiceInputDictionary(credential, signal) {
    let sequence = 0n;
    const request = new AbortController();
    const cancel = (): void => request.abort();
    if (signal.aborted) cancel(); else signal.addEventListener("abort", cancel, { once: true });
    try {
      const stream = createClient(VoiceInputService, transport(credential.origin, credential.authKey)).watchVoiceInputDictionary({}, options(request.signal));
      for await (const response of stream) {
        request.signal.throwIfAborted();
        sequence = nextVoiceDictionaryWatchSequence(response.sequence, sequence);
        yield projectMobileVoiceDictionarySnapshot(response.dictionary);
      }
    } finally { cancel(); signal.removeEventListener("abort", cancel); }
  },
  async *watchVoiceInputDictionaryPeerStatus(credential, signal) {
    let sequence = 0n;
    const request = new AbortController();
    const cancel = (): void => request.abort();
    if (signal.aborted) cancel(); else signal.addEventListener("abort", cancel, { once: true });
    try {
      const stream = createClient(VoiceInputService, transport(credential.origin, credential.authKey)).watchVoiceInputDictionaryPeerStatus({}, options(request.signal));
      for await (const response of stream) {
        request.signal.throwIfAborted();
        sequence = nextVoiceDictionaryWatchSequence(response.sequence, sequence);
        yield projectVoiceDictionaryPeerStatus(response.status);
      }
    } finally { cancel(); signal.removeEventListener("abort", cancel); }
  },
  async revokeVoiceInputDictionaryPeer(credential, peerId, expectedGrantRevision, signal) {
    const response = await createClient(VoiceInputService, transport(credential.origin, credential.authKey)).revokeVoiceInputDictionaryPeer({ peerId, expectedGrantRevision }, options(signal));
    return projectVoiceDictionaryPeerStatus(response.status);
  },
  async syncVoiceInputDictionaryNow(credential, expectedConfigurationRevision, peerId, signal) {
    const response = await createClient(VoiceInputService, transport(credential.origin, credential.authKey)).syncVoiceInputDictionaryNow({ expectedConfigurationRevision, ...(peerId === undefined ? {} : { peerId }) }, options(signal));
    return projectVoiceDictionaryPeerStatus(response.status);
  },
  async configureVoiceInputDictionaryListener(credential, expectedConfigurationRevision, listener, signal) {
    const response = await createClient(VoiceInputService, transport(credential.origin, credential.authKey)).configureVoiceInputDictionaryListener({ expectedConfigurationRevision, listener }, options(signal));
    return projectVoiceDictionaryPeerStatus(response.status);
  },
  async getVoiceInputDictionaryPeerInvitation(credential, signal) {
    const response = await createClient(VoiceInputService, transport(credential.origin, credential.authKey)).getVoiceInputDictionaryPeerInvitation({}, options(signal));
    readVoiceDictionaryPeerInvitation(response.invitation);
    return response.invitation;
  },
  async grantVoiceInputDictionaryDirectPeer(credential, expectedConfigurationRevision, invitation, expectedFingerprint, signal) {
    const response = await createClient(VoiceInputService, transport(credential.origin, credential.authKey)).grantVoiceInputDictionaryDirectPeer({ expectedConfigurationRevision, invitation, expectedFingerprint }, options(signal));
    return projectVoiceDictionaryPeerStatus(response.status);
  },
  async clearVoiceInputDictionaryPeerRoute(credential, expectedConfigurationRevision, peerId, signal) {
    const response = await createClient(VoiceInputService, transport(credential.origin, credential.authKey)).clearVoiceInputDictionaryPeerRoute({ expectedConfigurationRevision, peerId }, options(signal));
    return projectVoiceDictionaryPeerStatus(response.status);
  },
  async setVoiceInputDictionarySyncEnabled(credential, expectedRevision, enabled, signal) {
    const response = await createClient(VoiceInputService, transport(credential.origin, credential.authKey))
      .setVoiceInputDictionarySyncEnabled({ expectedRevision, enabled }, options(signal));
    return projectMobileVoiceDictionarySnapshot(response.dictionary);
  },
  async addVoiceInputDictionaryTerms(credential, expectedRevision, terms, signal) {
    const response = await createClient(VoiceInputService, transport(credential.origin, credential.authKey))
      .addVoiceInputDictionaryTerms({ expectedRevision, terms: [...terms] }, options(signal));
    return projectMobileVoiceDictionarySnapshot(response.dictionary);
  },
  async editVoiceInputDictionaryEntry(credential, expectedRevision, entryId, text, aliases, signal) {
    const response = await createClient(VoiceInputService, transport(credential.origin, credential.authKey))
      .editVoiceInputDictionaryEntry({ expectedRevision, entryId, text, aliases: [...aliases] }, options(signal));
    return projectMobileVoiceDictionarySnapshot(response.dictionary);
  },
  async deleteVoiceInputDictionaryEntry(credential, expectedRevision, entryId, signal) {
    const response = await createClient(VoiceInputService, transport(credential.origin, credential.authKey))
      .deleteVoiceInputDictionaryEntry({ expectedRevision, entryId }, options(signal));
    return projectMobileVoiceDictionarySnapshot(response.dictionary);
  },
  async applyVoiceInputDictionaryLearning(credential, expectedRevision, actions, signal) {
    const response = await createClient(VoiceInputService, transport(credential.origin, credential.authKey))
      .applyVoiceInputDictionaryLearning({ expectedRevision, actions: mobileVoiceDictionaryLearningRequest(actions) }, options(signal));
    return projectMobileVoiceDictionarySnapshot(response.dictionary);
  },
  async adviseVoiceInputDictionaryEdit(credential, draft, signal) {
    const response = await createClient(VoiceInputService, transport(credential.origin, credential.authKey))
      .adviseVoiceInputDictionaryEdit(mobileVoiceDictionaryAdviceRequest(draft), options(signal));
    return Object.freeze({ actions: projectMobileVoiceDictionaryAdvice(response.actions, draft) });
  },
  async startVoiceInput(credential, requestId, mimeType, locale, refinement, signal, recognitionContext) {
    const response = await createClient(VoiceInputService, transport(credential.origin, credential.authKey))
      .startVoiceInput(mobileVoiceStartRequest(requestId, mimeType, locale, refinement, recognitionContext), options(signal));
    return projectMobileVoiceSession(response.session);
  },
  async appendVoiceAudio(credential, voiceInputId, chunkSequence, audio, durationMs, voiced, signal) {
    const response = await createClient(VoiceInputService, transport(credential.origin, credential.authKey))
      .appendVoiceAudio({ voiceInputId, chunkSequence, audio: Uint8Array.from(audio), durationMs, voiced }, options(signal));
    return projectMobileVoiceSession(response.session);
  },
  async stopVoiceInput(credential, voiceInputId, expectedNextChunkSequence, signal) {
    const response = await createClient(VoiceInputService, transport(credential.origin, credential.authKey))
      .stopVoiceInput({ voiceInputId, expectedNextChunkSequence }, options(signal));
    return projectMobileVoiceSession(response.session);
  },
  async cancelVoiceInput(credential, voiceInputId, signal) {
    const response = await createClient(VoiceInputService, transport(credential.origin, credential.authKey))
      .cancelVoiceInput({ voiceInputId }, options(signal));
    return projectMobileVoiceSession(response.session);
  },
  async getVoiceInputSession(credential, voiceInputId, signal) {
    const response = await createClient(VoiceInputService, transport(credential.origin, credential.authKey))
      .getVoiceInputSession({ voiceInputId }, options(signal));
    return projectMobileVoiceSession(response.session);
  },
  async *streamOwner(credential, after, signal) {
    const client = createClient(EventService, transport(credential.origin, credential.authKey));
    for await (const response of client.streamEvents({
      scope: { kind: { case: "owner", value: {} } }, afterCursor: after
    }, { signal })) {
      if (response.event) yield response.event;
    }
  },
  async prepareTarget(credential, target, signal) {
    const revision = target.version?.revision;
    if (!target.targetId || !revision || revision.value < 1n) throw new Error("A current target revision is required.");
    const response = await createClient(TargetService, transport(credential.origin, credential.authKey)).prepareTargetWorkspace({
      targetId: target.targetId, expectedTargetRevision: revision
    }, options(signal));
    if (!response.workspace || response.workspace.targetId !== target.targetId
      || response.workspace.version?.revision?.value !== revision.value || !response.workspace.workspaceId) {
      throw new Error("The prepared workspace did not match the selected target revision.");
    }
  },
  async submit(credential, operationId, mutation, signal) {
    const response = await createClient(OperationService, transport(credential.origin, credential.authKey)).submitOperation({
      operationId, connectionId: credential.connectionId, mutation
    }, options(signal));
    if (!response.operation || response.operation.operationId !== operationId || response.operation.connectionId !== credential.connectionId) {
      throw new Error("The Joko node returned a mismatched operation receipt.");
    }
    return response.operation;
  },
  async waitOperation(credential, operationId, signal) {
    const client = createClient(OperationService, transport(credential.origin, credential.authKey));
    let revision = 0n;
    for await (const response of client.watchOperation({ operationId }, options(signal))) {
      const operation = response.operation;
      if (!operation || operation.operationId !== operationId || operation.connectionId !== credential.connectionId) {
        throw new Error("The Joko node returned a mismatched operation update.");
      }
      const nextRevision = operation.version?.revision?.value ?? 0n;
      if (nextRevision > 0n && nextRevision < revision) {
        throw new Error("The Joko node returned a regressed operation update.");
      }
      revision = nextRevision > revision ? nextRevision : revision;
      if ([OperationState.SUCCEEDED, OperationState.FAILED, OperationState.CANCELLED, OperationState.CONFLICT].includes(operation.state)) {
        return operation;
      }
    }
    throw new Error("The Joko operation stream closed before a durable result.");
  },
  async getOperation(credential, operationId, signal) {
    let response;
    try {
      response = await createClient(OperationService, transport(credential.origin, credential.authKey)).getOperation({ operationId }, options(signal));
    } catch (error) {
      if (error instanceof ConnectError && error.code === Code.NotFound) return undefined;
      throw error;
    }
    if (response.operation && (response.operation.operationId !== operationId || response.operation.connectionId !== credential.connectionId)) {
      throw new Error("The Joko node returned a mismatched operation identity.");
    }
    return response.operation;
  }
};

function mobileVoiceDictionaryAdviceRequest(draft: MobileVoiceDictionaryAdviceDraft) {
  if (draft.beforeText.length > MAXIMUM_MOBILE_VOICE_ADVICE_TEXT_CHARACTERS
    || draft.afterText.length > MAXIMUM_MOBILE_VOICE_ADVICE_TEXT_CHARACTERS
    || (draft.rawTranscriptText?.length ?? 0) > MAXIMUM_MOBILE_VOICE_ADVICE_TEXT_CHARACTERS) {
    throw new Error("The voice dictionary correction evidence exceeds the ephemeral request limit.");
  }
  return {
    beforeText: draft.beforeText,
    afterText: draft.afterText,
    ...(draft.rawTranscriptText === undefined ? {} : { rawTranscriptText: draft.rawTranscriptText }),
    ...(draft.locale === undefined ? {} : { locale: draft.locale }),
    existingEntries: draft.existingEntries.map((entry) => ({
      term: entry.term,
      source: entry.source === "automatic"
        ? VoiceInputDictionaryEntrySource.AUTOMATIC : VoiceInputDictionaryEntrySource.MANUAL,
      frequency: entry.frequency,
      aliases: entry.aliases.map((alias) => ({ text: alias.text, count: alias.count }))
    })),
    existingCandidates: draft.existingCandidates.map((candidate) => ({
      term: candidate.term,
      evidenceCount: candidate.evidenceCount,
      aliases: candidate.aliases.map((alias) => ({ text: alias.text, count: alias.count }))
    }))
  };
}

interface MobileVoiceDictionaryWireAction {
  readonly action: VoiceInputDictionaryLearningActionType;
  readonly term: string;
  readonly aliases: readonly string[];
  readonly termType: VoiceInputDictionaryTermType;
  readonly confidence: VoiceInputDictionaryLearningConfidence;
}

function projectMobileVoiceDictionaryAdvice(
  values: readonly MobileVoiceDictionaryWireAction[],
  draft: MobileVoiceDictionaryAdviceDraft
): readonly MobileVoiceDictionaryLearningAction[] {
  if (values.length > 3) throw new Error("The Joko node returned too many voice dictionary actions.");
  const actions = values.map(projectMobileVoiceDictionaryAction);
  const beforeEvidence = learningEvidenceKey(`${draft.beforeText}\n${draft.rawTranscriptText ?? ""}`);
  const afterEvidence = learningEvidenceKey(draft.afterText);
  if (actions.some((action) => !afterEvidence.includes(learningEvidenceKey(action.term))
    || action.aliases.some((alias) => !beforeEvidence.includes(learningEvidenceKey(alias))))) {
    throw new Error("The Joko node returned ungrounded voice dictionary evidence.");
  }
  return Object.freeze(actions);
}

function mobileVoiceStartRequest(
  requestId: string,
  mimeType: string,
  locale: string | undefined,
  refinement: MobileVoiceRefinementContext | undefined,
  recognitionContext?: MobileVoiceRecognitionContext
) {
  return {
    requestId,
    mimeType,
    ...(locale === undefined ? {} : { locale }),
    ...(refinement?.instructions === undefined ? {} : { refinementInstructions: refinement.instructions }),
    ...(recognitionContext === undefined ? {} : { recognitionContext: {
      contextData: normalizeMobileVoiceRecognitionContext(recognitionContext).contextData.map((item) => ({ text: item.text }))
    } })
  };
}

function projectMobileVoiceDictionaryAction(value: MobileVoiceDictionaryWireAction): MobileVoiceDictionaryLearningAction {
  const term = value.term.replace(/\s+/gu, " ").trim();
  if (!term || term.length > 120 || /[\u0000-\u001f\u007f]/u.test(term)) {
    throw new Error("The Joko node returned an invalid voice dictionary term.");
  }
  const aliases = value.aliases.map((alias) => alias.replace(/\s+/gu, " ").trim());
  const aliasKeys = aliases.map((alias) => alias.toLocaleLowerCase());
  if (aliases.length === 0 || aliases.length > 5
    || aliases.some((alias) => !alias || alias.length > 120 || /[\u0000-\u001f\u007f]/u.test(alias))
    || aliasKeys.some((key) => key === term.toLocaleLowerCase())
    || new Set(aliasKeys).size !== aliasKeys.length) {
    throw new Error("The Joko node returned invalid voice dictionary aliases.");
  }
  return Object.freeze({
    action: mobileVoiceDictionaryAction(value.action),
    term,
    aliases: Object.freeze(aliases),
    type: mobileVoiceDictionaryTermType(value.termType),
    confidence: value.confidence === VoiceInputDictionaryLearningConfidence.HIGH ? "high"
      : value.confidence === VoiceInputDictionaryLearningConfidence.MEDIUM ? "medium"
        : (() => { throw new Error("The Joko node returned unspecified voice dictionary confidence."); })()
  });
}

function mobileVoiceDictionaryAction(
  value: VoiceInputDictionaryLearningActionType
): MobileVoiceDictionaryLearningAction["action"] {
  switch (value) {
    case VoiceInputDictionaryLearningActionType.ADD_CANDIDATE: return "addCandidate";
    case VoiceInputDictionaryLearningActionType.ADD_ENTRY: return "addEntry";
    case VoiceInputDictionaryLearningActionType.UPDATE_ENTRY: return "updateEntry";
    case VoiceInputDictionaryLearningActionType.UNSPECIFIED:
      throw new Error("The Joko node returned an unspecified voice dictionary action.");
    default:
      throw new Error("The Joko node returned an invalid voice dictionary action.");
  }
}

function mobileVoiceDictionaryTermType(
  value: VoiceInputDictionaryTermType
): MobileVoiceDictionaryLearningAction["type"] {
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
      throw new Error("The Joko node returned an unspecified voice dictionary term type.");
    default:
      throw new Error("The Joko node returned an invalid voice dictionary term type.");
  }
}

function learningEvidenceKey(value: string): string {
  return value.replace(/\s+/gu, " ").trim().toLocaleLowerCase();
}

export const mobileVoiceNetworkTesting = {
  adviceRequest: mobileVoiceDictionaryAdviceRequest,
  startRequest: mobileVoiceStartRequest,
  projectAction: projectMobileVoiceDictionaryAction,
  projectAdvice: projectMobileVoiceDictionaryAdvice
};

export const mobileRemoteDesktopNetworkTesting = Object.freeze({
  remoteDesktopPeerKey,
  validRemoteDesktopCursor,
  validRemoteDesktopDisplayModes
});
