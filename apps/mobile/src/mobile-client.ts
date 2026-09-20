import { create } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import {
  ArchiveSessionMutationSchema, BlobDisposition, BlobRefSchema, CancelQueueItemMutationSchema, CapabilitySupport, CompactSessionMutationSchema, CompactSessionOutcome,
  ConnectionState, CreateSessionMutationSchema,
  DeleteSessionMessageMutationSchema, DeleteSessionMutationSchema, DeviceKind, DismissInteractionMutationSchema,
  EditQueueItemMutationSchema, EntityKind, EntityRefSchema, ExecuteUserShellMutationSchema,
  LAN_DISCOVERY_PEER_TTL_MS,
  ModelKeySchema, ModelSelectionSchema, NativeSessionPlacement, NativeSessionStartSchema, NewNativeSessionSchema,
  LogoutConnectionMutationSchema, NavigateSessionBranchMutationSchema, OperationPreconditionSchema, OperationState, OperationMutationSchema,
  MessageRole, PermissionMode, PinSessionMutationSchema, QueueDeliveryMode, QueueItemState, RenameSessionMutationSchema,
  ReorderQueueItemMutationSchema, ResetSessionMutationSchema, ResolveInteractionMutationSchema, RevisionSchema, RevokeDeviceMutationSchema,
  ReviewAttachmentInputSchema, ReviewAttachmentKind, ReviewRunState, SendInputMutationSchema, SessionMessageSearchSessionStatus,
  SessionState, SetQueueInteractionLockMutationSchema, SetQueueItemEditLockMutationSchema, SetSessionModelMutationSchema,
  SetSessionPermissionMutationSchema, SetSessionPlanModeMutationSchema, TargetState, capabilityNames,
  StartReviewMutationSchema,
  FileKind,
  type Artifact, type BackendDescriptor, type BlobRef, type DiscoveredNodeRecord, type Event, type EventCursor, type FilePreview, type FileRevision, type Interaction,
  type Operation, type OperationMutation, type QueueControl, type QueueItem, type Session, type Snapshot,
  type WorkspaceEntry, type WorkspaceSearchMatch
} from "@joko/contracts";
import {
  MobileCredentialStorageError, profileFromCredential,
  type MobileConnectionProfile, type MobileStorage, type PendingOperation
} from "./connection-storage";
import type { MobileDiscovery } from "./connection-discovery";
import type { MobileHomeStatusFilter } from "./home-navigation";
import {
  MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES,
  normalizeNodeOrigin,
  type MobileNetwork, type NodeIdentity, type PairedCredential
} from "./network";
import {
  artifactTitle,
  bytesToDataUri,
  canonicalWorkspacePath,
  emptyMobileFilesState,
  filterWorkspaceFileNames,
  isTextMediaType,
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
import type {
  MobileComposerDraftIdentity,
  MobileComposerDraftSnapshot,
  MobileComposerDraftStore
} from "./composer-draft-store";
import {
  emptyMobileComposerDraft,
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
  type MobileCatalogMentionControls
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
  assertMobilePermissionMode,
  assertMobilePlanMode,
  resolveMobileExplicitNewTaskModelAuthority,
  resolveMobileNewTaskDefaultModelAuthority,
  resolveMobileRuntimeControls,
  resolveMobileSessionModelAuthority,
  type MobileModelControlSelection,
  type MobileRuntimeControls
} from "./mobile-runtime-controls";
import {
  assertMobileContextCompact,
  resolveMobileContextControls,
  type MobileCompactOutcome,
  type MobileContextControls
} from "./mobile-context-controls";
import {
  createMobileRuntimeCommandControls,
  projectMobileRuntimeCommandCatalog,
  type MobileRuntimeCommandCatalog,
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
  mobileAnnotationOutputMediaType,
  normalizeMobileAnnotationStrokes,
  sniffMobileImageMediaType,
  type MobileImageAnnotationStroke
} from "./mobile-image-annotation";
import {
  mobileAnnotatedImageFileName,
  type MobileBurnedImage,
  type MobileComposerImageCommitResult,
  type MobileComposerImageEditorRequest,
  type MobileComposerImageEditorSession
} from "./mobile-composer-image-editor";
import {
  assertMobileImageGalleryDimensions,
  inspectMobileImageGalleryBytes,
  mobileImageGalleryMediaType,
  mobileImageGalleryPage,
  mobileImageGalleryPageSummary,
  mobileTimelineGalleryMessage,
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
import {
  inspectMobileImageOutputBytes,
  mobileImageOutputExtension,
  mobileImageOutputMediaType
} from "./mobile-image-output-format";

export type { MobileStorage, PendingOperation } from "./connection-storage";

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
  readonly challenge?: { readonly id: string; readonly origin: string; readonly deviceName: string };
  readonly owner?: Snapshot;
  readonly selectedId?: string;
  readonly detail?: Snapshot;
  readonly older: readonly Event[];
  readonly window?: readonly Event[];
  readonly live: readonly Event[];
  readonly liveStatus: "paused" | "verifying" | "streaming" | "polling";
  readonly historyBusy: boolean;
  readonly historyEnd: boolean;
  readonly before?: EventCursor;
  readonly pending: readonly PendingOperation[];
  readonly homeSearchQuery: string;
  readonly homeSearchFilter: MobileHomeStatusFilter;
  readonly homeSearchStatus: "idle" | "searching" | "ready" | "error";
  readonly homeSearchSessionIds: readonly string[];
  readonly homeSearchError?: string;
  readonly files: MobileFilesState;
  readonly error?: string;
}

interface MobileFilesContext {
  readonly credential: PairedCredential;
  readonly authority: MobileWorkspaceAuthority;
  readonly key: string;
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
        readonly messageId: string;
        readonly windowKey: string;
      };
  loaded?: {
    readonly loadId: string;
    readonly page: MobileImageGalleryPage;
    readonly pageIndex: number;
    readonly bytes: Uint8Array;
    readonly decoded: MobileImageGalleryDecodedImage;
    confirmed: boolean;
  };
  operationInFlight: boolean;
}

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

export class MobileClient {
  #state: MobileState = { status: "starting", busy: false, saved: [], connectionMode: "nearby",
    discoveryState: "idle", nearby: [], older: [], live: [], liveStatus: "paused",
    historyBusy: false, historyEnd: false, pending: [], homeSearchQuery: "", homeSearchFilter: "active",
    homeSearchStatus: "idle", homeSearchSessionIds: [], files: emptyMobileFilesState() };
  #credential?: PairedCredential;
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
  #disposed = false;
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
  #filesListAbort?: AbortController;
  #filesSearchAbort?: AbortController;
  #filesPreviewAbort?: AbortController;
  #filesWatchAbort?: AbortController;
  #filesRefreshTimer?: ReturnType<typeof setTimeout>;
  #queueEditLease?: MobileQueueEditLease;
  #queueInteractionLease?: MobileQueueInteractionLease;
  #newTaskSubmissionActive = false;
  #composerImageEdit?: MobileComposerImageEditLease;
  #imageGallery?: MobileImageGalleryLease;

  constructor(
    private readonly network: MobileNetwork,
    private readonly storage: MobileStorage,
    private readonly discovery: MobileDiscovery,
    private readonly newId: () => string,
    private readonly platform: string,
    private readonly now: () => number = Date.now,
    private readonly clearInteractionDraft?: (identity: MobileInteractionDraftIdentity) => Promise<void>,
    private readonly newTaskDrafts?: MobileNewTaskDraftStore,
    private readonly composerDrafts?: MobileComposerDraftStore,
    private readonly attachmentFiles?: MobileAttachmentFiles
  ) {}

  get state(): MobileState { return this.#state; }

  subscribe(listener: (state: MobileState) => void): () => void {
    this.#listeners.add(listener);
    listener(this.#state);
    return () => this.#listeners.delete(listener);
  }

  #set(patch: Partial<MobileState>): void {
    if (this.#disposed) return;
    const previousAuthority = this.filesAuthorityKey();
    let next = { ...this.#state, ...patch };
    const nextAuthority = this.#filesAuthorityKey(next);
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
    this.#state = next;
    for (const listener of this.#listeners) listener(this.#state);
  }

  #retire(): number {
    this.#abort?.abort();
    this.#streamAbort?.abort();
    this.#streamAbort = undefined;
    this.#homeSearchAbort?.abort();
    this.#homeSearchAbort = undefined;
    this.#homeSearchEpoch += 1;
    this.#cancelFilesRequests();
    this.#composerImageEdit = undefined;
    this.#imageGallery = undefined;
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
    this.#state = { ...this.#state, homeSearchStatus: "idle", homeSearchSessionIds: [], homeSearchError: undefined };
    this.#abort = new AbortController();
    return ++this.#epoch;
  }

  #current(epoch: number): boolean { return !this.#disposed && this.#foreground && this.#epoch === epoch; }

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

  async start(): Promise<void> {
    const epoch = this.#retire();
    try {
      const [index, pending] = await Promise.all([
        this.storage.loadConnectionIndex(), this.storage.loadPending()
      ]);
      if (!this.#current(epoch)) return;
      this.#profiles = [...index.profiles];
      this.#automaticProfileId = index.automaticProfileId;
      this.#allPending = pending;
      this.#set({
        pending: [],
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

  async requestPairing(rawOrigin: string, deviceName: string): Promise<string> {
    if (!deviceName.trim()) throw new Error("Enter a device name.");
    const origin = normalizeNodeOrigin(rawOrigin);
    const { generation, controller } = this.#beginConnectionAttempt();
    this.#set({ challenge: undefined });
    try {
      const request = await this.network.requestPairing(origin, deviceName, this.platform, controller.signal);
      if (!this.#connectionAttemptCurrent(generation, controller)) return "";
      const candidate = this.#state.candidate;
      if (candidate && (candidate.origin !== origin || candidate.node.serverId !== request.identity.serverId)) {
        throw new Error("The Joko node identity changed. Inspect it again.");
      }
      this.#connectionAttemptAbort = undefined;
      this.#set({ candidate: { origin, node: request.identity }, challenge: { id: request.challengeId, origin, deviceName },
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
    const { generation, controller } = this.#beginConnectionAttempt();
    try {
      const result = await this.network.completePairing(origin, challenge.id, code, deviceName, this.platform, controller.signal);
      if (!this.#connectionAttemptCurrent(generation, controller)) return;
      const candidate = this.#state.candidate;
      if (candidate && (candidate.origin !== origin || candidate.node.serverId !== result.identity.serverId)) {
        throw new Error("The Joko node identity changed during pairing. Inspect it again.");
      }
      // Prove the credential's identity and device before making it durable.
      const observed = await this.network.inspect(origin, controller.signal);
      if (!this.#connectionAttemptCurrent(generation, controller)) return;
      if (observed.serverId !== result.credential.serverId) throw new Error("The Joko node identity changed during pairing.");
      const owner = await this.network.readOwner(result.credential, controller.signal);
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

  cancel(): void {
    this.#cancelCatalogAttempt();
    this.#connectionAttemptAbort?.abort();
    this.#connectionAttemptAbort = undefined;
    this.#connectionAttemptEpoch += 1;
    this.#set({
      busy: this.#mutationOwner !== undefined,
      challenge: undefined,
      candidate: undefined,
      connectionAttemptError: undefined,
      ...(!this.#hasActiveConnection() && this.#state.status === "connecting" ? { status: "unpaired" as const } : {})
    });
  }

  async connectSaved(profileId: string, automatic?: boolean): Promise<void> {
    const profile = this.#profiles.find((candidate) => candidate.profileId === profileId);
    if (!profile) throw new Error("This saved Joko connection is no longer available on this device.");
    if (this.#activeProfileId === profileId && this.#credential) {
      await this.refresh();
      if (this.#state.status === "connected" && automatic !== undefined) {
        await this.setAutomaticEntryForActive(automatic);
      }
      return;
    }
    await this.#releaseQueueEditBeforeTransition();
    const { generation, controller } = this.#beginConnectionAttempt();
    this.#set({
      ...(!this.#hasActiveConnection() ? { status: "connecting" as const } : {}),
      candidate: undefined,
      challenge: undefined,
      saved: this.#savedViews(profileId, "checking")
    });
    try {
      // Public identity proof must precede the protected credential read.
      const node = await this.network.inspect(profile.origin, controller.signal);
      if (!this.#connectionAttemptCurrent(generation, controller)) return;
      this.#set({ candidate: { origin: profile.origin, node } });
      if (node.serverId !== profile.serverId) {
        const detail = "The saved Joko node identity changed. Its credential was not read; forget it or inspect and pair this node again.";
        this.#failConnectionAttempt(generation, controller, detail, {
          saved: this.#savedViews(profileId, "identity-conflict", detail)
        });
        throw new Error(detail);
      }
      let credential: PairedCredential | undefined;
      try { credential = await this.storage.loadCredential(profileId); }
      catch (error) {
        if (!this.#connectionAttemptCurrent(generation, controller)) return;
        const failure = credentialFailure(error);
        this.#failConnectionAttempt(generation, controller, message(error), {
          saved: this.#savedViews(profileId, failure, message(error))
        });
        throw error;
      }
      if (!credential || !credentialMatchesProfile(credential, profile)) {
        const detail = credential
          ? "The protected credential does not match this saved Joko connection. Forget it and pair again."
          : "The protected credential for this saved Joko connection is missing. Forget it and pair again.";
        this.#failConnectionAttempt(generation, controller, detail, {
          saved: this.#savedViews(profileId, credential ? "unreadable" : "missing", detail)
        });
        throw new Error(detail);
      }
      const selection = await this.storage.loadSelection(profileId);
      if (!this.#connectionAttemptCurrent(generation, controller)) return;
      const owner = await this.network.readOwner(credential, controller.signal);
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
      } else if (error instanceof CredentialIdentityError) {
        this.#failConnectionAttempt(generation, controller, error.message, {
          saved: this.#savedViews(profileId, "identity-conflict", error.message)
        });
      } else if (this.#state.saved.find((item) => item.profileId === profileId)?.credentialState === "checking") {
        const detail = message(error);
        this.#failConnectionAttempt(generation, controller, detail, {
          saved: this.#savedViews(profileId, "offline", detail)
        });
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
    const epoch = this.#retire();
    if (!this.#current(epoch)) return;
    this.#credential = credential;
    this.#activeProfileId = credential.profileId;
    const ownedPending = this.#allPending.filter((item) => item.connectionId === credential.connectionId);
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
      error: preferenceError
    });
    this.#beginStream(epoch, credential, owner.snapshot);
    await this.reconcile(epoch);
    if (this.#current(epoch)) this.#schedule();
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
    const cleanup = [credentialFailure, this.#automaticProfileId === profileId ? automaticFailure : undefined]
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
        this.#set({ status: "unpaired", busy: false, activeProfileId: undefined,
          automaticProfileId: this.#automaticProfileId, node: undefined, origin: undefined,
          saved: this.#savedViews(profileId, credentialFailure(error), detail), candidate: undefined,
          connectionAttemptError: undefined, challenge: undefined,
          owner: undefined, detail: undefined, selectedId: undefined, older: [], window: undefined,
          live: [], liveStatus: "paused", historyBusy: false, historyEnd: false, before: undefined,
          pending: [], error: detail });
      } else {
        this.#set({ busy: false, automaticProfileId: this.#automaticProfileId,
          saved: this.#savedViews(profileId, credentialFailure(error), detail), error: detail });
      }
      throw error;
    }
    this.#profiles = this.#profiles.filter((candidate) => candidate.profileId !== profileId);
    if (this.#automaticProfileId === profileId) this.#automaticProfileId = undefined;
    const cleanupFailures: string[] = [];
    try { await this.storage.saveSelection(profileId); }
    catch (error) { cleanupFailures.push(`task selection: ${message(error)}`); }
    try { await this.#dropPendingConnections([profile.connectionId]); }
    catch (error) { cleanupFailures.push(`operation receipts: ${message(error)}`); }
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
    this.#set({ status: "unpaired", busy: false, node: undefined, origin: undefined,
      activeProfileId: undefined, automaticProfileId: this.#automaticProfileId, saved: this.#savedViews(),
      candidate: undefined, connectionAttemptError: undefined, challenge: undefined,
      owner: undefined, detail: undefined, selectedId: undefined,
      older: [], window: undefined, live: [], liveStatus: "paused", historyBusy: false,
      historyEnd: false, before: undefined, pending: [], error: cleanupError });
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
    this.#retire();
    if (!active) {
      this.#connectionAttemptAbort?.abort();
      this.#connectionAttemptAbort = undefined;
      this.#connectionAttemptEpoch += 1;
      if (this.#discoveryExpiryTimer !== undefined) clearTimeout(this.#discoveryExpiryTimer);
      this.#discoveryExpiryTimer = undefined;
      this.#cancelCatalogAttempt();
      this.#mutationOwner = undefined;
      this.#set({
        ...(!this.#hasActiveConnection() && this.#state.status === "connecting" ? { status: "unpaired" as const } : {}),
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
          : {})
      });
    }
    if (active) {
      const nearby = this.#unexpiredNearby(this.#state.nearby);
      if (nearby.length !== this.#state.nearby.length) this.#set({ nearby });
      this.#scheduleNearbyExpiry();
    }
    if (active) {
      if (this.#credential) void this.refresh();
      else void this.start();
    }
  }

  async refresh(): Promise<void> {
    const credential = this.#credential;
    if (!credential || !this.#foreground) return;
    const epoch = this.#retire();
    this.#set({ status: "connecting", error: undefined });
    try {
      // This request MUST be anonymous and precede every credentialed reconnect.
      const node = await this.network.inspect(credential.origin, this.#abort?.signal);
      if (!this.#current(epoch)) return;
      if (node.serverId !== credential.serverId) {
        this.#identityConflict(epoch, credential.profileId,
          "The saved Joko node identity changed. Its credential was not read again; forget it or pair this node explicitly.");
        return;
      }
      const owner = await this.network.readOwner(credential, this.#abort?.signal);
      if (!this.#current(epoch)) return;
      this.#assertOwner(credential, owner, node);
      const selectedId = this.#state.selectedId;
      const selected = selectedId !== undefined && owner.snapshot.sessions.some((session) => session.sessionId === selectedId)
        ? selectedId : undefined;
      const detail = selected ? await this.network.readSession(credential, selected, this.#abort?.signal) : undefined;
      if (!this.#current(epoch)) return;
      if (selected !== selectedId) await this.storage.saveSelection(credential.profileId, selected);
      if (!this.#current(epoch)) return;
      const sameWindow = selected === selectedId && this.#state.owner?.generation === owner.snapshot.generation;
      this.#set({ node, origin: credential.origin, owner: owner.snapshot, detail, selectedId: selected,
        older: sameWindow ? this.#state.older : [], window: sameWindow ? this.#state.window : undefined,
        before: sameWindow ? this.#state.before : undefined, historyEnd: sameWindow ? this.#state.historyEnd : false,
        historyBusy: false, live: [], status: "connected", error: undefined,
        saved: this.#savedViews(credential.profileId, "available") });
      this.#beginStream(epoch, credential, owner.snapshot);
      await this.reconcile(epoch);
      if (this.#current(epoch)) this.#schedule();
    } catch (error) {
      if (!this.#current(epoch)) return;
      if (isRevoked(error)) await this.#invalidateCredential(
        epoch,
        credential.profileId,
        "This mobile connection was revoked. Forget it or pair this device again."
      );
      else if (error instanceof CredentialIdentityError) {
        this.#identityConflict(epoch, credential.profileId, error.message);
      }
      else {
        this.#set({ status: "offline", liveStatus: "paused", live: [], error: message(error) });
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
    const projectedConnection = owner.snapshot.connections.find((item) => item.connectionId === credential.connectionId);
    const projectedDevice = owner.snapshot.devices.find((item) => item.deviceId === credential.deviceId);
    if (projectedConnection?.connectionProfileId !== credential.profileId
      || projectedConnection.deviceId !== credential.deviceId || projectedDevice?.kind !== DeviceKind.MOBILE) {
      throw new CredentialIdentityError("The authenticated Joko snapshot did not prove the exact saved connection and device. The credential was kept but suspended.");
    }
    if (projectedConnection.state !== ConnectionState.CONNECTED || projectedDevice.revoked) throw new RevokedError();
  }

  #identityConflict(epoch: number, profileId: string, error: string): void {
    if (!this.#current(epoch)) return;
    this.#connectionAttemptAbort?.abort();
    this.#connectionAttemptAbort = undefined;
    this.#connectionAttemptEpoch += 1;
    this.#retire();
    this.#credential = undefined;
    this.#activeProfileId = undefined;
    this.#set({ status: "unpaired", busy: false, activeProfileId: undefined, node: undefined,
      saved: this.#savedViews(profileId, "identity-conflict", error), candidate: undefined,
      connectionAttemptError: undefined, challenge: undefined, owner: undefined, detail: undefined,
      selectedId: undefined, older: [], window: undefined, live: [], liveStatus: "paused",
      historyBusy: false, historyEnd: false, before: undefined, pending: [], error });
  }

  async #invalidateCredential(epoch: number, profileId: string, error: string): Promise<void> {
    if (!this.#current(epoch)) return;
    this.#connectionAttemptAbort?.abort();
    this.#connectionAttemptAbort = undefined;
    this.#connectionAttemptEpoch += 1;
    this.#retire();
    this.#credential = undefined;
    this.#activeProfileId = undefined;
    let automaticFailure: string | undefined;
    const wasAutomatic = this.#automaticProfileId === profileId;
    if (wasAutomatic) {
      try {
        await this.storage.saveAutomaticProfile();
        this.#automaticProfileId = undefined;
      }
      catch (failure) { automaticFailure = message(failure); }
    }
    let credentialFailureMessage: string | undefined;
    try {
      await this.storage.deleteCredential(profileId);
      if (wasAutomatic) this.#automaticProfileId = undefined;
    }
    catch (failure) { credentialFailureMessage = message(failure); }
    const cleanupFailure = credentialFailureMessage === undefined
      ? undefined
      : [credentialFailureMessage, automaticFailure].filter(Boolean).join(" ");
    const cleanupError = cleanupFailure === undefined ? undefined : ` ${cleanupFailure}`;
    this.#set({ status: "revoked", busy: false, activeProfileId: undefined,
      automaticProfileId: this.#automaticProfileId, node: undefined,
      saved: this.#savedViews(profileId, cleanupError ? "unavailable" : "missing", `${error}${cleanupError ?? ""}`),
      candidate: undefined, connectionAttemptError: undefined, challenge: undefined, owner: undefined, detail: undefined,
      selectedId: undefined, older: [], window: undefined, live: [], liveStatus: "paused",
      historyBusy: false, historyEnd: false, before: undefined, pending: [], error: `${error}${cleanupError ?? ""}` });
  }

  #schedule(): void {
    if (!this.#foreground || this.#disposed || !this.#credential) return;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      if (this.#state.busy) this.#schedule();
      else void this.refresh();
    }, this.#state.liveStatus === "polling" || this.#state.status === "offline" ? 4_000 : 30_000);
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
        if (!event.eventId || !cursor || !cursor.opaqueToken || cursor.generation !== this.#streamGeneration
          || cursor.sequence > (this.#streamSequence ?? 0n) + 1n
          || event.payload?.kind.case === "projectionInvalidated") {
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

  async #syncProjection(epoch: number, credential: PairedCredential): Promise<void> {
    this.#projectionReading = true;
    const selectedId = this.#state.selectedId;
    const edge = this.#streamSequence ?? 0n;
    try {
      const [owner, detail] = await Promise.all([
        this.network.readOwner(credential, this.#abort?.signal),
        selectedId ? this.network.readSession(credential, selectedId, this.#abort?.signal) : Promise.resolve(undefined)
      ]);
      if (!this.#current(epoch) || credential !== this.#credential || selectedId !== this.#state.selectedId) return;
      this.#assertOwner(credential, owner, this.#state.node!);
      if (owner.snapshot.generation !== this.#streamGeneration || detail && detail.generation !== this.#streamGeneration
        || selectedId && !owner.snapshot.sessions.some((item) => item.sessionId === selectedId)) {
        void this.refresh();
        return;
      }
      if (!owner.snapshot.resumeCursor || owner.snapshot.resumeCursor.generation !== this.#streamGeneration
        || owner.snapshot.resumeCursor.sequence < edge
        || detail && (!detail.resumeCursor || detail.resumeCursor.generation !== this.#streamGeneration
          || detail.resumeCursor.sequence < edge)) {
        if (++this.#projectionMisses >= 2) void this.refresh();
        else this.#scheduleProjection(epoch, credential);
        return;
      }
      this.#projectionMisses = 0;
      const durable = detail?.resumeCursor?.sequence ?? owner.snapshot.resumeCursor.sequence;
      this.#set({ owner: owner.snapshot, detail,
        live: this.#state.live.filter((item) => item.cursor && item.cursor.sequence > durable) });
      if ((this.#streamSequence ?? 0n) > durable) this.#scheduleProjection(epoch, credential);
    } catch (error) {
      if (!this.#current(epoch)) return;
      if (isRevoked(error)) await this.#invalidateCredential(
        epoch,
        credential.profileId,
        "This mobile connection was revoked. Forget it or pair this device again."
      );
      else void this.refresh();
    } finally {
      if (this.#current(epoch)) this.#projectionReading = false;
    }
  }

  async #persistPending(items: readonly PendingOperation[], epoch: number): Promise<boolean> {
    const connectionId = this.#credential?.connectionId;
    if (connectionId === undefined) return false;
    const write = this.#pendingWrite.then(async () => {
      if (!this.#current(epoch) || this.#credential?.connectionId !== connectionId) return false;
      const merged = [
        ...this.#allPending.filter((item) => item.connectionId !== connectionId),
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
    if (sessionId !== undefined && !this.#state.owner?.sessions.some((session) => session.sessionId === sessionId)) {
      throw new Error("Select a task from the current Joko node.");
    }
    if (this.#queueInteractionLease) this.#releaseQueueInteractionLeaseDetached(this.#queueInteractionLease);
    await this.#releaseQueueEditBeforeTransition();
    const profileId = this.#activeProfileId;
    if (!profileId) throw new Error("Reconnect to a saved Joko node before selecting a task.");
    const epoch = this.#retire();
    await this.storage.saveSelection(profileId, sessionId);
    if (!this.#current(epoch)) return;
    this.#set({ selectedId: sessionId, detail: undefined, older: [], window: undefined, live: [],
      historyBusy: false, historyEnd: false, before: undefined, error: undefined });
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

  canOpenFiles(): boolean { return this.filesAuthorityKey() !== undefined; }

  filesAuthorityKey(): string | undefined { return this.#filesAuthorityKey(this.#state); }

  async openFiles(): Promise<void> {
    const context = this.#filesContext();
    this.#cancelFilesRequests();
    const epoch = this.#filesEpoch;
    const location = { kind: "workspace" as const, path: "" };
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

  async previewArtifact(artifact: Artifact): Promise<void> {
    const current = this.#state.files.artifacts.find((candidate) => candidate.artifactId === artifact.artifactId);
    if (!current || current !== artifact || current.sessionId !== this.#state.files.sessionId) {
      throw new Error("Select a Generated file from the current task.");
    }
    const context = this.#filesContext();
    if (!this.#state.files.open || context.key !== this.#state.files.authorityKey) return;
    this.#filesPreviewAbort?.abort();
    const controller = new AbortController();
    this.#filesPreviewAbort = controller;
    const epoch = this.#filesEpoch;
    const blob = current.blob;
    const mediaType = normalizeMediaType(blob?.mediaType ?? "application/octet-stream") || "application/octet-stream";
    const byteSize = blob?.byteSize ?? 0n;
    const base = {
      title: artifactTitle(current),
      sourceLabel: "Generated",
      mediaType,
      byteSize,
      revisionKey: [current.artifactId, blob?.blobId ?? "", blob?.sha256Hex ?? "", byteSize.toString(10)].join(":")
    };
    this.#set({ files: { ...this.#state.files, preview: { ...base, kind: "loading" } } });
    try {
      let preview: MobileFilePreview;
      if (!blob) {
        preview = { ...base, kind: "unsupported", reason: "This Generated file has no canonical Blob payload." };
      } else if (blob.byteSize > BigInt(MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES)) {
        preview = { ...base, kind: "unsupported",
          reason: `This ${mediaType} file is ${blob.byteSize.toString(10)} bytes and exceeds the mobile preview limit.` };
      } else if (mediaType.startsWith("image/")) {
        const download = await this.network.downloadBlob(context.credential, blob, controller.signal);
        preview = { ...base, kind: "image", dataUri: bytesToDataUri(download.bytes, download.mediaType),
          altText: current.description.trim() || artifactTitle(current), widthPixels: 0, heightPixels: 0 };
      } else if (isTextMediaType(mediaType)) {
        if (blob.byteSize > 2_097_152n) {
          preview = { ...base, kind: "unsupported",
            reason: `This text file is ${blob.byteSize.toString(10)} bytes and exceeds the 2097152-byte text preview window.` };
        } else {
          const download = await this.network.downloadBlob(context.credential, blob, controller.signal);
          const text = new TextDecoder("utf-8", { fatal: true }).decode(download.bytes);
          preview = { ...base, kind: "text", text, languageId: "", startByte: 0n,
            endByte: blob.byteSize, totalLines: text === "" ? 0 : text.split(/\r?\n/gu).length, truncated: false };
        }
      } else {
        preview = { ...base, kind: "unsupported",
          reason: `No safe in-app preview is available for ${mediaType} (${blob.byteSize.toString(10)} bytes).` };
      }
      if (controller.signal.aborted || this.#filesPreviewAbort !== controller
        || !this.#currentFiles(epoch, context.key)) return;
      this.#set({ files: { ...this.#state.files, preview } });
    } catch (error) {
      if (controller.signal.aborted || !this.#currentFiles(epoch, context.key)) return;
      this.#set({ files: { ...this.#state.files,
        preview: { ...base, kind: "error", reason: message(error) } } });
    } finally {
      if (this.#filesPreviewAbort === controller) this.#filesPreviewAbort = undefined;
    }
  }

  closeFilesPreview(): void {
    this.#filesPreviewAbort?.abort();
    this.#filesPreviewAbort = undefined;
    if (this.#state.files.open) this.#set({ files: { ...this.#state.files, preview: undefined } });
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
    const draft = normalizeMobileComposerDraft(snapshot.draft ?? { text: "", mentions: [], atoms: [], attachments: [] });
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
    signal?: AbortSignal
  ): Promise<MobileImageGalleryDescriptor> {
    signal?.throwIfAborted();
    if (!this.composerDrafts) throw new Error("Retained task drafts are unavailable on this mobile client.");
    this.#imageGallery = undefined;
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
      pages = this.#state.files.artifacts.flatMap((observed) => {
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
        ? this.#state.files.entries
        : [selected];
      const collected: MobileImageGalleryPage[] = [];
      const seen = new Set<string>();
      for (const entry of observedEntries) {
        signal?.throwIfAborted();
        if (entry.kind !== FileKind.REGULAR || !entry.revision || !mobileImageGalleryMediaType(entry.mediaType)) continue;
        let page: MobileImageGalleryPage | undefined;
        try {
          const preview = await this.network.readWorkspaceFile(
            context.credential,
            context.authority.workspace.workspaceId,
            entry.relativePath,
            entry.revision,
            signal
          );
          assertCurrent();
          if (!preview.truncated && preview.content.case === "image") {
            const blob = workspaceComposerBlob(context.authority.workspace.workspaceId, entry, preview);
            page = mobileImageGalleryPage({
              pageId: `workspace:${entry.workspaceId}:${entry.relativePath}:${workspaceEntryRevisionKey(entry.revision)}:${blob?.blobId ?? ""}`,
              title: entry.displayName || workspaceBasename(entry.relativePath),
              blob,
              widthPixels: preview.content.value.widthPixels,
              heightPixels: preview.content.value.heightPixels,
              requireDimensions: true,
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
            throw new Error("The selected Workspace file is not a canonical static gallery image.");
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
    const draft = normalizeMobileComposerDraft(snapshot.draft ?? { text: "", mentions: [], atoms: [], attachments: [] });
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
      if (this.#imageGallery === lease) this.#imageGallery = undefined;
      throw error;
    }
  }

  async openTimelineImageGallery(
    eventId: string,
    pageId: string,
    signal?: AbortSignal
  ): Promise<MobileImageGalleryDescriptor> {
    signal?.throwIfAborted();
    if (!this.composerDrafts) throw new Error("Retained task drafts are unavailable on this mobile client.");
    this.#imageGallery = undefined;
    const credential = this.#ready();
    const taskAuthorityKey = this.#taskAuthorityKey();
    const sessionId = this.#state.selectedId;
    if (!taskAuthorityKey || !sessionId) throw new Error("Open a current task before viewing its message images.");
    const events = this.#timelineEvents();
    const matches = events.filter((event) => event.eventId === eventId);
    const event = matches.length === 1 ? matches[0] : undefined;
    const message = event ? mobileTimelineGalleryMessage(event) : undefined;
    if (!event || event.identity?.sessionId !== sessionId || !message) {
      throw new Error("The durable message image is no longer in the current Timeline window.");
    }
    const pages = mobileTimelineGalleryPages(event);
    const initialIndex = pages.findIndex((page) => page.pageId === pageId);
    if (initialIndex < 0 || pages.length === 0) {
      throw new Error("The selected message image is not in its durable completed message.");
    }
    const identity = { profileId: credential.profileId, sessionId };
    const snapshot = await this.composerDrafts.readSnapshot(identity);
    const draft = normalizeMobileComposerDraft(snapshot.draft ?? { text: "", mentions: [], atoms: [], attachments: [] });
    signal?.throwIfAborted();
    if (this.#taskAuthorityKey() !== taskAuthorityKey) throw new Error("The task changed while the image gallery was opening.");
    const attachmentOwnerKey = this.taskAttachmentControls()?.surfaceOwnerKey;
    const leaseId = distinctAttachmentStorageId(this.newId, ...mobileComposerAttachmentStorageIds(draft.attachments));
    const descriptor: MobileImageGalleryDescriptor = {
      leaseId,
      sourceKind: "timeline",
      sourceLabel: message.role === MessageRole.USER ? "Your message" : "Task message",
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
      source: {
        kind: "timeline",
        eventId,
        messageId: message.messageId,
        windowKey: mobileTimelineGalleryWindowKey(events)
      },
      operationInFlight: false
    };
    this.#imageGallery = lease;
    try {
      await this.#assertImageGalleryCurrent(lease, undefined, signal);
      return descriptor;
    } catch (error) {
      if (this.#imageGallery === lease) this.#imageGallery = undefined;
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
    await this.#assertImageGalleryCurrent(lease, undefined, signal);
    const page = lease.pages[pageIndex]!;
    const credential = this.#ready();
    const download = await this.network.downloadBlob(credential, page.blob, signal);
    signal?.throwIfAborted();
    if (normalizeMediaType(download.mediaType) !== page.mediaType || download.bytes.byteLength !== page.byteSize) {
      throw new Error("The authenticated gallery image changed media type or size.");
    }
    const decoded = inspectMobileImageGalleryBytes(download.bytes, page.mediaType);
    if (page.widthPixels !== undefined && (decoded.width !== page.widthPixels || decoded.height !== page.heightPixels)) {
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
    if (metadata && controls && canAnnotateMobileImage(page.mediaType)) {
      try {
        assertMobileAttachmentCandidate({
          fileName: mobileAnnotatedImageFileName(metadata.fileName, mobileAnnotationOutputMediaType(page.mediaType)),
          mediaType: mobileAnnotationOutputMediaType(page.mediaType),
          byteSize: 1
        }, controls.policy);
        annotatable = true;
      } catch { /* The original remains viewable and may still be directly addable. */ }
    }
    return {
      galleryLeaseId: lease.leaseId,
      leaseId: loadId,
      pageId: page.pageId,
      pageIndex,
      pageCount: lease.pages.length,
      sourceKind: lease.descriptor.sourceKind,
      sourceLabel: lease.descriptor.sourceLabel,
      previewUri: bytesToDataUri(download.bytes, page.mediaType),
      sourceBase64: encodeMobileBase64(download.bytes),
      sourceMediaType: page.mediaType,
      fileName: metadata?.fileName ?? (page.blob.fileName || page.title),
      initialStrokes: [],
      annotatable,
      addable: metadata !== undefined,
      maximumBytes: controls?.policy.maximumBytes ?? MOBILE_BLOB_PREVIEW_MAXIMUM_BYTES,
      expectedWidthPixels: decoded.width,
      expectedHeightPixels: decoded.height
    };
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
      || loaded.page.pageId !== pageId || decoded.isAnimated === true
      || decoded.width !== loaded.decoded.width || decoded.height !== loaded.decoded.height
      || decoded.mediaType && normalizeMediaType(decoded.mediaType) !== loaded.decoded.mediaType) {
      throw new Error("The decoded image no longer matches this gallery page.");
    }
    if (loaded.confirmed) return;
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
    if (!galleryLease || !loaded || loaded.loadId !== leaseId || !loaded.confirmed || galleryLease.operationInFlight) {
      throw new Error("The decoded image no longer owns this output action.");
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
      fileName: mobileImageOutputFileName(loaded.page.blob.fileName || loaded.page.title, loaded.page.mediaType),
      mediaType: loaded.page.mediaType,
      byteSize: loaded.page.byteSize,
      sha256Hex: loaded.page.sha256Hex,
      bytes: Uint8Array.from(loaded.bytes),
      width: exactDecoded.width,
      height: exactDecoded.height
    };
  }

  cancelImageGallery(leaseId: string): void {
    if (this.#imageGallery?.leaseId === leaseId) this.#imageGallery = undefined;
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
      validateHistory(page.events, sessionId, this.#state.owner?.generation, before);
      if (page.before && (page.events.length === 0 || !page.before.opaqueToken || page.before.generation !== this.#state.owner?.generation
        || (before && page.before.sequence >= before.sequence) || page.before.sequence > page.events[0]!.cursor!.sequence)) {
        throw new Error("The task history returned a cyclic or mismatched page cursor.");
      }
      const known = new Set(this.#state.older.map((item) => item.eventId));
      const older = [...page.events.filter((item) => !known.has(item.eventId)), ...this.#state.older];
      const window = this.#state.window ? [...older, ...this.#state.window] : undefined;
      this.#set({ older: window ? [] : older, window, before: page.before, historyEnd: !page.before });
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
      validateHistory(events, sessionId, this.#state.owner?.generation);
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

  async create(targetId: string, name: string, firstInput: MobileComposerDraft): Promise<MobileNewTaskResult> {
    const input = normalizeMobileComposerDraft(firstInput);
    if (!input.text.trim() && input.attachments.length === 0) {
      throw new Error("Enter a first message or attach a file for this task.");
    }
    if (input.mentions.some((mention) => mention.kind === "resource" || mention.kind === "artifact")) {
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
    const receivingModel = resolveMobileNewTaskDefaultModelAuthority(owner, backend.backendId);
    const attachmentControls = this.newTaskAttachmentControls(targetId);
    if (input.attachments.length > 0) {
      if (!attachmentControls) throw new Error("This Backend does not accept attachments for a new task.");
      assertMobileAttachmentPolicy(input.attachments, attachmentControls.policy);
    }
    assertMobileSessionMentionDraft(this.newTaskSessionMentionControls(targetId), input);
    assertMobileWorkspaceMentionDraft(this.newTaskWorkspaceMentionControls(targetId), input);
    const identity = { profileId: credential.profileId } satisfies MobileNewTaskDraftIdentity;
    const createOperationId = this.newId();
    const action = this.#claimMutation();
    this.#newTaskSubmissionActive = true;
    try {
      const submission = await this.newTaskDrafts.beginSubmission(identity, { targetId, name, input }, {
        connectionId: credential.connectionId,
        serverId: credential.serverId,
        backendId: target.backendId,
        targetRevision: targetRevision.value.toString(10),
        ...(targetRevision.etag === "" ? {} : { targetRevisionEtag: targetRevision.etag }),
        model: receivingModel?.selection ?? null,
        createOperationId
      });
      try {
        await this.network.prepareTarget(credential, target, this.#abort?.signal);
        await this.#validateNewTaskSubmissionInput(submission, authorityKey);
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
            fastMode: submission.model.fastMode
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
    return this.#sendNewTaskFirstInput(identity, sending);
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
      await this.#recoverNewTaskComposerDraft(identity, initial.sessionId, initial.input);
      await this.newTaskDrafts.clear(identity);
      this.#set({ error: authority.message });
      return { sessionId: initial.sessionId, created: true, sent: false, definitive: true };
    }
    let prepared = initial;
    try {
      await this.#validateNewTaskSubmissionInput(initial);
      prepared = await this.#uploadNewTaskAttachments(identity, initial);
    } catch (error) {
      const retained = this.newTaskDrafts.readSync(identity)?.submission;
      const recovery = retained?.phase === "sending" && retained.createOperationId === initial.createOperationId
        ? retained
        : prepared;
      await this.#recoverNewTaskComposerDraft(identity, initial.sessionId, recovery.input);
      await this.newTaskDrafts.clear(identity);
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
    }), { kind: "send", sessionId: submission.sessionId }, sendOperationId);
    return this.#finishNewTaskFirstInput(identity, submission, result);
  }

  async #uploadNewTaskAttachments(
    identity: MobileNewTaskDraftIdentity,
    initial: MobileNewTaskSendSubmission
  ): Promise<MobileNewTaskSendSubmission> {
    if (!this.newTaskDrafts) throw new Error("Retained new-task drafts are unavailable.");
    if (initial.input.attachments.every((attachment) => attachment.state === "uploaded")) return initial;
    if (!this.attachmentFiles) throw new Error("Staged mobile attachment bytes are unavailable.");
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
      const source = await this.attachmentFiles.verifyForUpload(identity.profileId, attachment, this.#abort?.signal);
      const blob = await this.network.uploadBlob(this.#ready(), source, this.#abort?.signal);
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
      const next = await this.newTaskDrafts.replaceSubmissionInput(
        identity,
        submission.createOperationId,
        submission.input,
        input
      );
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
      await this.#recoverNewTaskComposerDraft(identity, submission.sessionId, submission.input);
      return { sessionId: submission.sessionId, created: true, sent: false, definitive: false };
    }
    if (!result.accepted || result.operation?.state !== OperationState.SUCCEEDED) {
      await this.#recoverNewTaskComposerDraft(identity, submission.sessionId, submission.input);
      await this.newTaskDrafts.clear(identity);
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
      await this.#recoverNewTaskComposerDraft(identity, submission.sessionId, submission.input);
      await this.newTaskDrafts.clear(identity);
      this.#set({ error: "The first-message operation returned an invalid queue result. The text remains in the task composer; verify the task before sending again." });
      return { sessionId: submission.sessionId, created: true, sent: false, definitive: true };
    }
    const recoveredInputRemoved = await this.#removeRecoveredNewTaskComposerDraft(
      identity,
      submission.sessionId,
      submission.input
    );
    await this.newTaskDrafts.clear(identity);
    if (recoveredInputRemoved) {
      await this.#removeCommittedAnnotationSources(identity.profileId, submission.input.attachments);
    }
    return { sessionId: submission.sessionId, created: true, sent: true, definitive: true };
  }

  async send(draft: MobileComposerDraft): Promise<boolean> {
    const exactDraft = normalizeMobileComposerDraft(draft);
    const sessionId = this.#state.selectedId;
    const session = this.#state.detail?.sessions.find((item) => item.sessionId === sessionId);
    const backend = this.#state.owner?.backends.find((item) => item.backendId === session?.backendId);
    const generation = session?.nativeBinding?.runtimeGeneration;
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
    const mentionControls = this.taskSessionMentionControls();
    const workspaceMentionControls = this.taskWorkspaceMentionControls();
    const workspaceMentionOwnerKey = workspaceMentionControls?.surfaceOwnerKey;
    const catalogMentionControls = this.taskCatalogMentionControls();
    const catalogMentionOwnerKey = catalogMentionControls?.surfaceOwnerKey;
    const attachmentControls = this.taskAttachmentControls();
    const attachmentOwnerKey = attachmentControls?.surfaceOwnerKey;
    let sendDraft = assertMobileCatalogMentionDraft(
      catalogMentionControls,
      assertMobileWorkspaceMentionDraft(
        workspaceMentionControls,
        assertMobileSessionMentionDraft(mentionControls, exactDraft)
      )
    );
    if (sendDraft.attachments.length > 0) {
      if (!attachmentControls) throw new Error("This task Backend does not accept attachments.");
      assertMobileAttachmentPolicy(sendDraft.attachments, attachmentControls.policy);
    }
    if (!this.composerDrafts) throw new Error("Retained task drafts are unavailable on this mobile client.");
    const draftIdentity = { profileId: credential.profileId, sessionId };
    this.composerDrafts.save(draftIdentity, sendDraft);
    await this.composerDrafts.flush(draftIdentity);
    const currentSession = this.#selectedSession();
    if (this.#taskAuthorityKey() !== authorityKey || currentSession?.sessionId !== sessionId
      || currentSession.nativeBinding?.runtimeGeneration !== generation
      || this.#credential?.profileId !== credential.profileId || this.#credential.connectionId !== credential.connectionId) {
      throw new Error("The task changed while its structured draft was being saved. Review the retained draft before sending.");
    }
    assertMobileSessionMentionDraft(this.taskSessionMentionControls(), sendDraft);
    const currentWorkspaceMentionControls = this.taskWorkspaceMentionControls();
    assertMobileWorkspaceMentionDraft(currentWorkspaceMentionControls, sendDraft);
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
      if (this.#taskAuthorityKey() !== authorityKey
        || this.taskWorkspaceMentionControls()?.surfaceOwnerKey !== currentWorkspaceMentionControls.surfaceOwnerKey) {
        throw new Error("The Workspace reference owner changed while its paths were being checked. Review the retained draft before sending.");
      }
      assertMobileWorkspaceMentionDraft(this.taskWorkspaceMentionControls(), sendDraft);
    }
    if (sendDraft.mentions.some((mention) => mention.kind === "resource" || mention.kind === "artifact")) {
      if (!currentCatalogMentionControls || currentCatalogMentionControls.surfaceOwnerKey !== catalogMentionOwnerKey) {
        throw new Error("The catalog reference owner changed while the structured draft was being saved. Review the retained draft before sending.");
      }
      const catalog = await this.listTaskCatalogMentionCatalog(currentCatalogMentionControls.surfaceOwnerKey);
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
        generation
      );
      const accepted = await this.#submit(create(OperationMutationSchema, {
        preconditions: [create(OperationPreconditionSchema, {
          entity: create(EntityRefSchema, { kind: EntityKind.SESSION, id: sessionId }), expectedGeneration: generation
        })],
        payload: { case: "sendInput", value: create(SendInputMutationSchema, {
          sessionId,
          input: mobileComposerInput(sendDraft),
          deliveryMode: QueueDeliveryMode.PROMPT
        }) }
      }), { kind: "send", sessionId });
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
    } finally { this.#releaseMutation(action); }
  }

  async #uploadTaskAttachments(
    identity: { readonly profileId: string; readonly sessionId: string },
    initial: MobileComposerDraft,
    authorityKey: string,
    attachmentOwnerKey: string | undefined,
    credential: PairedCredential,
    generation: bigint
  ): Promise<MobileComposerDraft> {
    if (initial.attachments.every((attachment) => attachment.state === "uploaded")) return initial;
    if (!this.composerDrafts || !this.attachmentFiles) {
      throw new Error("Staged mobile attachment bytes are unavailable.");
    }
    if (!attachmentOwnerKey) throw new Error("The current task attachment authority is unavailable.");
    let current = initial;
    let snapshot = await this.composerDrafts.readSnapshot(identity);
    if (snapshot.draft === undefined || !mobileComposerDraftsEqual(snapshot.draft, current)) {
      throw new Error("The retained task draft changed before its attachments could upload.");
    }
    for (const candidate of current.attachments) {
      if (candidate.state === "uploaded") continue;
      const attachment = candidate as MobileLocalComposerAttachment;
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
        this.#abort?.signal
      );
      const blob = await this.network.uploadBlob(credential, source, this.#abort?.signal);
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
      snapshot = await this.composerDrafts.readSnapshot(identity);
      if (snapshot.draft === undefined || !mobileComposerDraftsEqual(snapshot.draft, next)) {
        throw new Error("The committed attachment could not be confirmed in the retained task draft.");
      }
      current = next;
      await this.#removeCommittedAttachmentFile(identity.profileId, attachment);
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
      || controls.profileId !== credential.profileId
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
    try { await this.attachmentFiles.removeVisibleBytes(profileId, attachment); }
    catch (error) {
      this.#set({ error: `${message(error)} The committed attachment will not be uploaded again.` });
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
    if (this.#queueEditLease) this.#releaseQueueEditLeaseDetached(this.#queueEditLease);
    if (this.#queueInteractionLease) this.#releaseQueueInteractionLeaseDetached(this.#queueInteractionLease);
  }

  canDeleteMessage(eventId: string): boolean {
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

  taskQueueCapabilities() {
    return mobileQueueCapabilities(this.#selectedBackend(this.#selectedSession()));
  }

  taskRuntimeControls(): MobileRuntimeControls | undefined {
    const credential = this.#credential;
    if (!credential || !this.#taskAuthorityKey()) return undefined;
    return resolveMobileRuntimeControls({
      profileId: credential.profileId,
      connectionId: credential.connectionId,
      deviceId: credential.deviceId,
      serverId: credential.serverId
    }, this.#state.owner, this.#state.detail, this.#state.selectedId);
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
    const model = resolveMobileNewTaskDefaultModelAuthority(owner, backend?.backendId);
    const policy = resolveMobileAttachmentPolicy(backend, model?.supportsImages === true);
    if (!authorityKey || !credential || !policy) return undefined;
    return {
      profileId: credential.profileId,
      surfaceOwnerKey: `${authorityKey}\u001fattachments\u001f${model?.authorityKey ?? "native-default"}`,
      policy
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
    const authorityKey = this.#taskAuthorityKey();
    const session = this.#selectedSession();
    const backend = this.#selectedBackend(session);
    return createMobileSessionMentionControls(authorityKey, this.#state.owner, session, backend);
  }

  taskWorkspaceMentionControls(): MobileWorkspaceMentionControls | undefined {
    return createMobileWorkspaceMentionControls(
      this.#taskAuthorityKey(),
      this.#state.owner,
      this.#state.detail,
      this.#state.selectedId
    );
  }

  taskCatalogMentionControls(): MobileCatalogMentionControls | undefined {
    return createMobileCatalogMentionControls(
      this.#taskAuthorityKey(),
      this.#state.owner,
      this.#state.detail,
      this.#state.selectedId
    );
  }

  taskRuntimeCommandControls(): MobileRuntimeCommandControls | undefined {
    return createMobileRuntimeCommandControls(
      this.#taskAuthorityKey(),
      this.#state.owner,
      this.#state.detail,
      this.#state.selectedId
    );
  }

  taskAppCommandControls(): MobileAppCommandControls | undefined {
    return createMobileAppCommandControls(
      this.#taskAuthorityKey(),
      this.#state.owner,
      this.#state.detail,
      this.#state.selectedId
    );
  }

  taskAttachmentControls(): MobileAttachmentControls | undefined {
    const authorityKey = this.#taskAuthorityKey();
    const credential = this.#credential;
    const session = this.#selectedSession();
    const model = resolveMobileSessionModelAuthority(this.#state.owner, session);
    const policy = resolveMobileAttachmentPolicy(this.#selectedBackend(session), model?.supportsImages === true);
    if (!authorityKey || !credential || !policy) return undefined;
    return {
      profileId: credential.profileId,
      surfaceOwnerKey: `${authorityKey}\u001fattachments\u001f${model?.authorityKey ?? "native-default"}`,
      policy
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
      if (!sessionId || !authorityKey || !controls || controls.profileId !== credential.profileId) {
        throw new Error("The current task image attachment authority is unavailable.");
      }
      const identity = { profileId: credential.profileId, sessionId };
      const snapshot = await this.composerDrafts.readSnapshot(identity);
      const draft = normalizeMobileComposerDraft(snapshot.draft ?? { text: "", mentions: [], atoms: [], attachments: [] });
      owner = { kind: "task", authorityKey, identity, snapshot, draft };
    } else {
      controls = this.newTaskAttachmentControls(request.targetId);
      if (!controls || controls.profileId !== credential.profileId) {
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
      let annotatable = canAnnotateMobileImage(source.mediaType);
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
    if (exactStrokes.length === 0) {
      outputBytes = Uint8Array.from(lease.sourceBytes);
      outputMediaType = lease.source.mediaType;
      outputFileName = lease.source.fileName;
      outputSha256Hex = lease.source.sha256Hex;
    } else {
      if (!canAnnotateMobileImage(lease.source.mediaType) || !burned) {
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
      outputFileName = mobileAnnotatedImageFileName(lease.source.fileName, burned.mediaType);
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
      const result = await this.#submitTerminal(create(OperationMutationSchema, {
        preconditions: [this.#sessionRuntimePrecondition(controls.session)],
        payload: { case: "setSessionModel", value: create(SetSessionModelMutationSchema, {
          sessionId: controls.session.sessionId,
          model: create(ModelSelectionSchema, {
            model: create(ModelKeySchema, { providerId: selected.providerId, modelId: selected.modelId }),
            effortId: selected.effortId ?? "",
            fastMode: selected.fastMode
          })
        }) }
      }), { kind: "session-model", sessionId: controls.session.sessionId });
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
    const credential = this.#credential;
    if (!credential || !this.#taskAuthorityKey()) return undefined;
    return resolveMobileContextControls({
      profileId: credential.profileId,
      connectionId: credential.connectionId,
      deviceId: credential.deviceId,
      serverId: credential.serverId
    }, this.#state.owner, this.#state.detail, this.#state.selectedId);
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

  taskNativeTreeControls(): MobileNativeTreeControls | undefined {
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
    return pendingMobileInteractions(this.#state.detail, this.#state.selectedId);
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

  async saveQueueEdit(lease: MobileQueueEditLease, text: string): Promise<boolean> {
    this.#assertQueueEditLease(lease);
    const { item, capabilities } = this.#queueItemContext(lease.queueItemId);
    if (!capabilities.edit) throw new Error("This Backend no longer supports editing queued input.");
    if (queueItemText(item.input) === text) {
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
          deliveryMode: item.deliveryMode,
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

  async setSessionPinned(sessionId: string, pinned: boolean): Promise<boolean> {
    return this.#mutateSession(sessionId, "pin", {
      case: "pinSession",
      value: create(PinSessionMutationSchema, { sessionId, pinned })
    });
  }

  async setSessionArchived(sessionId: string, archived: boolean): Promise<boolean> {
    return this.#mutateSession(sessionId, "archive", {
      case: "archiveSession",
      value: create(ArchiveSessionMutationSchema, { sessionId, archived })
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
      ?? this.#state.owner?.sessions.find((item) => item.sessionId === sessionId);
  }

  #selectedBackend(session: Session | undefined) {
    return this.#state.owner?.backends.find((item) => item.backendId === session?.backendId);
  }

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
    const owner = await this.network.readOwner(credential, signal ?? this.#abort?.signal);
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
    const initialAttachmentPolicy = this.#newTaskSubmissionAttachmentPolicy(submission);
    if (input.attachments.length > 0) {
      if (!initialAttachmentPolicy) throw new Error("This Backend no longer accepts the retained attachments.");
      assertMobileAttachmentPolicy(input.attachments, initialAttachmentPolicy);
    }
    const initialSessionControls = this.newTaskSessionMentionControls(submission.targetId);
    const initialWorkspaceControls = this.newTaskWorkspaceMentionControls(submission.targetId);
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
    assertMobileSessionMentionDraft(sessionControls, input);
    assertMobileWorkspaceMentionDraft(workspaceControls, input);
    if (!hasWorkspaceMentions) return;
    await this.#revalidateNewTaskWorkspaceMentionPaths(fresh.credential, workspaceControls!, input);
    const finalOwner = await this.#readNewTaskOwner();
    this.#assertNewTaskCreateAuthority(submission, finalOwner.snapshot);
    const finalAuthorityKey = this.#newTaskAuthorityKey(submission.targetId, finalOwner.snapshot);
    const finalSessionControls = this.#newTaskSessionMentionControlsFromOwner(submission.targetId, finalOwner.snapshot);
    const finalWorkspaceControls = createMobileNewTaskWorkspaceMentionControls(
      finalAuthorityKey,
      finalOwner.snapshot,
      submission.targetId
    );
    const finalAttachmentPolicy = this.#newTaskSubmissionAttachmentPolicy(submission, finalOwner.snapshot);
    if (finalAuthorityKey !== freshAuthorityKey
      || hasSessionMentions && finalSessionControls?.surfaceOwnerKey !== sessionControls?.surfaceOwnerKey
      || finalWorkspaceControls?.surfaceOwnerKey !== workspaceControls?.surfaceOwnerKey) {
      throw new Error("New-task reference authority changed while Workspace paths were being checked.");
    }
    assertMobileSessionMentionDraft(finalSessionControls, input);
    assertMobileWorkspaceMentionDraft(finalWorkspaceControls, input);
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
    if (this.#state.pending.some((item) => item.sessionId === sessionId
      && ["session-model", "session-permission", "session-plan", "session-compact", "session-branch",
        "session-shell", "session-reset", "session-review"].includes(item.kind))) {
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
    return {
      profileId: credential.profileId,
      surfaceOwnerKey,
      isCurrent,
      getCapabilities: (signal) => owned(() => this.network.getVoiceInputCapabilities(credential, signal)),
      start: (requestId, mimeType, locale, signal) => owned(() =>
        this.network.startVoiceInput(credential, requestId, mimeType, locale, signal)),
      append: (voiceInputId, chunkSequence, audio, durationMs, voiced, signal) => owned(() =>
        this.network.appendVoiceAudio(
          credential,
          voiceInputId,
          chunkSequence,
          audio,
          durationMs,
          voiced,
          signal
        )),
      stop: (voiceInputId, expectedNextChunkSequence, signal) => owned(() =>
        this.network.stopVoiceInput(credential, voiceInputId, expectedNextChunkSequence, signal)),
      // Cleanup must retain the initiating credential even after UI authority
      // retires; it can only address this exact connection-owned voice id.
      cancel: (voiceInputId, signal) => this.network.cancelVoiceInput(credential, voiceInputId, signal),
      get: (voiceInputId, signal) => owned(() => this.network.getVoiceInputSession(credential, voiceInputId, signal))
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

  #taskAuthorityKey(): string | undefined {
    const credential = this.#credential;
    const owner = this.#state.owner;
    const detail = this.#state.detail;
    const sessionId = this.#state.selectedId;
    if (!credential || !owner || !detail || !sessionId
      || !this.#foreground || this.#state.status !== "connected"
      || detail.generation !== owner.generation || this.#state.activeProfileId !== credential.profileId
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
    return [
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
    const generation = this.#state.owner?.generation;
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
    mutation: OperationMutation
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
      operation = await this.network.submit(credential, pending.operationId, mutation);
    } catch {
      return;
    }
    if (!isTerminal(operation.state)) {
      try {
        await this.#writeDetachedPending((items) => items.map((item) => item.operationId === pending.operationId
          ? { ...item, state: "accepted" as const }
          : item));
        operation = await this.network.waitOperation(credential, pending.operationId);
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
    if (this.#foreground && this.#credential?.connectionId === credential.connectionId) void this.refresh();
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
          pending: next.filter((item) => item.connectionId === connectionId),
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
    return this.#state.window
      ?? [...this.#state.older, ...(this.#state.detail?.timeline ?? []), ...this.#state.live];
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
    } else {
      const events = this.#timelineEvents();
      if (mobileTimelineGalleryWindowKey(events) !== source.windowKey) {
        throw new Error("The Timeline source window changed while the gallery was open.");
      }
      const matches = events.filter((event) => event.eventId === source.eventId);
      const currentPages = matches.length === 1 ? mobileTimelineGalleryPages(matches[0]!) : [];
      if (currentPages.length !== lease.pages.length
        || currentPages.some((page, index) => !sameMobileImageGalleryPage(page, lease.pages[index]!))) {
        throw new Error("The completed message images changed while the gallery was open.");
      }
    }
    const snapshot = await this.composerDrafts!.readSnapshot(lease.identity);
    signal?.throwIfAborted();
    if (this.#imageGallery !== lease) throw new Error("The image gallery was closed before the operation completed.");
    const current = normalizeMobileComposerDraft(snapshot.draft ?? { text: "", mentions: [], atoms: [], attachments: [] });
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
    if (!originalMetadata) throw new Error("This gallery image no longer fits the current attachment policy.");
    if (this.#imageGallery !== lease || lease.operationInFlight) {
      throw new Error("This gallery image is already being added or no longer owns the composer.");
    }
    lease.operationInFlight = true;
    try {
      let outputBytes = Uint8Array.from(loaded.bytes);
      let outputMediaType: string = originalMetadata.mediaType;
      let outputFileName = originalMetadata.fileName;
      let outputSha256Hex = loaded.page.sha256Hex;
      if (exactStrokes.length > 0) {
        if (!canAnnotateMobileImage(loaded.page.mediaType) || !burned) {
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
        outputFileName = mobileAnnotatedImageFileName(originalMetadata.fileName, burned.mediaType);
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
        fileName: originalMetadata.fileName,
        mediaType: originalMetadata.mediaType,
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
        this.#imageGallery = undefined;
        return nextDraft;
      } catch (error) {
        if (committed && nextDraft) committed = !await this.#restoreFilesComposerDraft(lease.identity, lease.snapshot, nextDraft);
        if (!committed && output) {
          await this.attachmentFiles.removeVisibleBytes(lease.profileId, output).catch(() => undefined);
        }
        if (!committed && sourceStaged && source) {
          await this.attachmentFiles.removeOwnedBytes(lease.profileId, source.storageId).catch(() => undefined);
        }
        if (committed) this.#imageGallery = undefined;
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
      const preview = await this.network.readWorkspaceFile(
        context.credential,
        context.authority.workspace.workspaceId,
        path,
        entry.revision,
        signal
      );
      assertCurrent();
      const blob = workspaceComposerBlob(context.authority.workspace.workspaceId, entry, preview);
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
    if (this.#imageGallery?.source.kind === "files") this.#imageGallery = undefined;
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

  async #previewWorkspaceFile(relativePath: string, revision: FileRevision, title: string): Promise<void> {
    const path = canonicalWorkspacePath(relativePath);
    workspaceEntryRevisionKey(revision);
    const context = this.#filesContext();
    if (!this.#state.files.open || context.key !== this.#state.files.authorityKey) return;
    this.#filesPreviewAbort?.abort();
    const controller = new AbortController();
    this.#filesPreviewAbort = controller;
    const epoch = this.#filesEpoch;
    const provisional = {
      title, sourceLabel: path, mediaType: "application/octet-stream",
      byteSize: revision.byteSize, revisionKey: workspaceEntryRevisionKey(revision)
    };
    this.#set({ files: { ...this.#state.files, preview: { ...provisional, kind: "loading" } } });
    try {
      await this.#finishWorkspacePreview(context, path, revision, title, controller, epoch);
    } catch (error) {
      if (controller.signal.aborted || !this.#currentFiles(epoch, context.key)) return;
      this.#set({ files: { ...this.#state.files,
        preview: { ...provisional, kind: "error", reason: message(error) } } });
    } finally {
      if (this.#filesPreviewAbort === controller) this.#filesPreviewAbort = undefined;
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
    if (controller.signal.aborted || this.#filesPreviewAbort !== controller
      || !this.#currentFiles(epoch, context.key)) return;
    const preview = await this.#workspacePreview(context, result, title, controller.signal);
    if (controller.signal.aborted || this.#filesPreviewAbort !== controller
      || !this.#currentFiles(epoch, context.key)) return;
    this.#set({ files: { ...this.#state.files, preview } });
  }

  async #workspacePreview(
    context: MobileFilesContext,
    preview: FilePreview,
    title: string,
    signal: AbortSignal
  ): Promise<MobileFilePreview> {
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
      return { ...base, kind: "text", text: text.utf8Text, languageId: text.languageId,
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
      return { ...base, kind: "image", dataUri: bytesToDataUri(download.bytes, download.mediaType),
        altText: image.altText || title, widthPixels: image.widthPixels, heightPixels: image.heightPixels };
    }
    if (preview.content.case === "blob") {
      const blob = preview.content.value;
      const blobType = normalizeMediaType(blob.mediaType) || "application/octet-stream";
      if (blob.byteSize !== revision.byteSize || blob.sha256Hex !== revision.sha256Hex || blobType !== mediaType) {
        throw new Error("The Joko node returned mismatched binary Blob metadata.");
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
    const failed = new Map<string, string>();
    const removed = new Set<string>();
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
        await this.attachmentFiles?.clearProfile(profile.profileId).catch(() => undefined);
        removed.add(profile.profileId);
      } catch (error) {
        failed.set(profile.profileId, [message(error), automaticFailure].filter(Boolean).join(" "));
      }
    }
    let receiptCleanupError: string | undefined;
    try { await this.#dropPendingConnections(targets.map((profile) => profile.connectionId)); }
    catch (error) { receiptCleanupError = message(error); }
    this.#profiles = this.#profiles.filter((profile) => !removed.has(profile.profileId));
    const activeRemoved = this.#activeProfileId !== undefined && targets.some((profile) => profile.profileId === this.#activeProfileId);
    const saved = this.#profiles.map((profile) => {
      const failure = failed.get(profile.profileId);
      return this.#savedConnection(
        profile,
        this.#automaticProfileId === profile.profileId,
        failure ? "unavailable" : this.#state.saved.find((item) => item.profileId === profile.profileId)?.credentialState ?? "unknown",
        failure
      );
    });
    const cleanupError = failed.size === 0 && receiptCleanupError === undefined
      ? undefined
      : `${confirmation}${failed.size === 0 ? "" : ` Joko could not finish removing ${failed.size === 1 ? "its local credential" : "some local credentials"}; retry Forget.`}`
        + `${receiptCleanupError === undefined ? "" : ` Local operation receipts could not be cleared: ${receiptCleanupError}`}`;
    if (!activeRemoved) {
      this.#set({ automaticProfileId: this.#automaticProfileId, saved, error: cleanupError });
      return;
    }
    this.#retire();
    this.#credential = undefined;
    this.#activeProfileId = undefined;
    this.#set({ status: "unpaired", busy: false, activeProfileId: undefined,
      automaticProfileId: this.#automaticProfileId, node: undefined, origin: undefined, saved,
      candidate: undefined, connectionAttemptError: undefined, challenge: undefined,
      owner: undefined, detail: undefined, selectedId: undefined,
      older: [], window: undefined, live: [], liveStatus: "paused", historyBusy: false,
      historyEnd: false, before: undefined, pending: [], error: cleanupError });
  }

  async #submit(
    mutation: OperationMutation,
    identity: Pick<PendingOperation, "kind" | "sessionId" | "eventId" | "queueItemId" | "interactionId" | "interactionGeneration" | "interactionRevision" | "interactionDraftKind" | "targetConnectionId" | "targetDeviceId">
  ): Promise<boolean> {
    return (await this.#submitTracked(mutation, identity, false)).accepted;
  }

  async #submitTerminal(
    mutation: OperationMutation,
    identity: Pick<PendingOperation, "kind" | "sessionId" | "eventId" | "queueItemId" | "interactionId" | "interactionGeneration" | "interactionRevision" | "interactionDraftKind" | "targetConnectionId" | "targetDeviceId">,
    operationId?: string,
    markBusy = true,
    refreshAfter = true
  ): Promise<TrackedMutationResult> {
    return this.#submitTracked(mutation, identity, true, operationId, markBusy, refreshAfter);
  }

  async #submitTracked(
    mutation: OperationMutation,
    identity: Pick<PendingOperation, "kind" | "sessionId" | "eventId" | "queueItemId" | "interactionId" | "interactionGeneration" | "interactionRevision" | "interactionDraftKind" | "targetConnectionId" | "targetDeviceId">,
    waitForTerminal: boolean,
    operationId = this.newId(),
    markBusy = true,
    refreshAfter = true
  ): Promise<TrackedMutationResult> {
    const credential = this.#ready();
    const epoch = this.#epoch;
    const pending: PendingOperation = { ...identity, connectionId: credential.connectionId, operationId, state: "unknown" };
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
    try {
      operation = await this.network.submit(credential, pending.operationId, mutation, this.#abort?.signal);
    } catch (error) {
      if (this.#current(epoch)) this.#set({ ...(markBusy ? { busy: false } : {}), error: `Operation ${pending.operationId}: ${message(error)}. Check status; it was not resent.` });
      return { accepted: false, definitive: false };
    }
    if (!this.#current(epoch)) return { accepted: false, definitive: false };
    if (operation.operationId !== pending.operationId || operation.connectionId !== pending.connectionId) {
      this.#set({ ...(markBusy ? { busy: false } : {}), error: `Operation ${pending.operationId} returned with the wrong durable identity. Its receipt was retained and no input was resent.` });
      return { accepted: false, definitive: false };
    }
    await this.#receipt(operation, pending, epoch);
    if (waitForTerminal && !isTerminal(operation.state)) {
      try {
        operation = await this.network.waitOperation(credential, pending.operationId, this.#abort?.signal);
      } catch (error) {
        if (this.#current(epoch)) this.#set({
          ...(markBusy ? { busy: false } : {}),
          error: `Operation ${pending.operationId}: ${message(error)}. Its durable result is unknown; it was not resent.`
        });
        return { accepted: false, definitive: false };
      }
      if (!this.#current(epoch)) return { accepted: false, definitive: false };
      if (operation.operationId !== pending.operationId || operation.connectionId !== pending.connectionId) {
        this.#set({ ...(markBusy ? { busy: false } : {}), error: `Operation ${pending.operationId} completed with the wrong durable identity. Its receipt was retained and no input was resent.` });
        return { accepted: false, definitive: false };
      }
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
    if (operation.operationId !== pending.operationId || operation.connectionId !== pending.connectionId) {
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
          profileId: this.#activeProfileId,
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

  async reconcile(epoch = this.#epoch): Promise<void> {
    const credential = this.#credential;
    if (!credential || !this.#current(epoch)) return;
    for (const pending of this.#state.pending) {
      if (pending.connectionId !== credential.connectionId) continue;
      try {
        const operation = await this.network.getOperation(credential, pending.operationId, this.#abort?.signal);
        if (!this.#current(epoch)) return;
        if (operation) {
          await this.#receipt(operation, pending, epoch);
          if (operation.state === OperationState.SUCCEEDED
            && ["rename", "pin", "archive", "delete", "message-delete", "queue-cancel", "queue-edit-lock",
              "queue-edit", "queue-interaction-lock", "queue-reorder", "interaction-resolve", "interaction-dismiss",
              "session-model", "session-permission", "session-plan", "session-compact", "session-branch",
              "session-shell", "session-reset", "session-review"].includes(pending.kind)
            && this.#current(epoch)) {
            await this.refresh();
            if (pending.kind === "message-delete" && this.#foreground
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
        await this.#sendNewTaskFirstInput(identity, submission);
        return;
      }
      await this.#recoverNewTaskComposerDraft(identity, submission.sessionId, submission.input);
      const observed = await this.#observeRetainedNewTaskOperation(submission, epoch);
      if (observed === "not-dispatched") {
        await this.#recoverNewTaskComposerDraft(identity, submission.sessionId, submission.input);
        await this.newTaskDrafts.clear(identity);
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
    if (this.#queueEditLease) this.#releaseQueueEditLeaseDetached(this.#queueEditLease);
    if (this.#queueInteractionLease) this.#releaseQueueInteractionLeaseDetached(this.#queueInteractionLease);
    this.#disposed = true;
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

function mobileCredentialKey(credential: PairedCredential): string {
  return [credential.profileId, credential.connectionId, credential.deviceId, credential.serverId].join("\u001f");
}

function filesComposerSourceIsCurrent(files: MobileFilesState, source: MobileFilesComposerSource): boolean {
  if (source.kind === "workspace-entry") return files.entries.includes(source.entry);
  if (source.kind === "artifact") return files.artifacts.includes(source.artifact);
  return files.searchResults.includes(source.result);
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

function sameMobileModelSelection(
  expected: MobileModelControlSelection,
  actual: Session["model"]
): boolean {
  return actual?.model?.providerId === expected.providerId
    && actual.model.modelId === expected.modelId
    && actual.effortId === (expected.effortId ?? "")
    && actual.fastMode === expected.fastMode;
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
    && credential.deviceId === profile.deviceId;
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

function historyInvalidated(event: Event): boolean {
  switch (event.payload?.kind.case) {
    case "messageDeleted":
    case "sessionReset":
    case "historyPruned": return true;
    case "nativeBranchChanged": return event.payload.kind.value.timelineRebuilt;
    default: return false;
  }
}
