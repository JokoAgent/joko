import { create } from "@bufbuild/protobuf";
import { Code } from "@connectrpc/connect";
import {
  ArchiveSessionMutationSchema, CancelQueueItemMutationSchema, CapabilitySupport, CompactSessionMutationSchema, CompactSessionOutcome,
  ConnectionState, CreateSessionMutationSchema,
  DeleteSessionMessageMutationSchema, DeleteSessionMutationSchema, DeviceKind, DismissInteractionMutationSchema,
  EditQueueItemMutationSchema, EntityKind, EntityRefSchema,
  LAN_DISCOVERY_PEER_TTL_MS,
  InputContentSchema, InputPartSchema, ModelKeySchema, ModelSelectionSchema, NativeSessionPlacement, NativeSessionStartSchema, NewNativeSessionSchema,
  LogoutConnectionMutationSchema, NavigateSessionBranchMutationSchema, OperationPreconditionSchema, OperationState, OperationMutationSchema,
  MessageRole, PermissionMode, PinSessionMutationSchema, QueueDeliveryMode, QueueItemState, RenameSessionMutationSchema,
  ReorderQueueItemMutationSchema, ResolveInteractionMutationSchema, RevisionSchema, RevokeDeviceMutationSchema, SendInputMutationSchema, SessionMessageSearchSessionStatus,
  SessionState, SetQueueInteractionLockMutationSchema, SetQueueItemEditLockMutationSchema, SetSessionModelMutationSchema,
  SetSessionPermissionMutationSchema, SetSessionPlanModeMutationSchema, TargetState, capabilityNames,
  FileKind,
  type Artifact, type BackendDescriptor, type DiscoveredNodeRecord, type Event, type EventCursor, type FilePreview, type FileRevision, type Interaction,
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
import type { MobileComposerDraftStore } from "./composer-draft-store";
import {
  mobileComposerInput,
  normalizeMobileComposerDraft,
  plainTextMobileComposerDraft,
  type MobileComposerDraft
} from "./mobile-composer-document";
import {
  assertMobileCatalogMentionCandidate,
  assertMobileCatalogMentionDraft,
  assertMobileCatalogMentionDraftCatalog,
  createMobileCatalogMentionControls,
  projectMobileArtifactMentionCatalog,
  projectMobileResourceMentionCatalog,
  type MobileCatalogMentionCandidate,
  type MobileCatalogMentionCatalog,
  type MobileCatalogMentionControls
} from "./mobile-catalog-mentions";
import {
  assertMobileSessionMentionDraft,
  createMobileSessionMentionControls,
  type MobileSessionMentionControls
} from "./mobile-session-mentions";
import {
  assertMobileWorkspaceMentionCandidate,
  assertMobileWorkspaceMentionDraft,
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
  type MobileNewTaskDraftIdentity,
  type MobileNewTaskDraftStore,
  type MobileNewTaskSendSubmission,
  type MobileNewTaskSubmission
} from "./new-task-draft-store";
import {
  assertMobileModelSelection,
  assertMobilePermissionMode,
  assertMobilePlanMode,
  resolveMobileRuntimeControls,
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
  assertMobileNativeTreeNavigation,
  projectMobileNativeTree,
  resolveMobileNativeTreeControls,
  type MobileNativeTreeControls,
  type MobileNativeTreeSnapshot
} from "./mobile-native-tree";

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

  constructor(
    private readonly network: MobileNetwork,
    private readonly storage: MobileStorage,
    private readonly discovery: MobileDiscovery,
    private readonly newId: () => string,
    private readonly platform: string,
    private readonly now: () => number = Date.now,
    private readonly clearInteractionDraft?: (identity: MobileInteractionDraftIdentity) => Promise<void>,
    private readonly newTaskDrafts?: MobileNewTaskDraftStore,
    private readonly composerDrafts?: MobileComposerDraftStore
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

  async create(targetId: string, name: string, firstInput: string): Promise<MobileNewTaskResult> {
    const inputText = firstInput.trim();
    if (!inputText) throw new Error("Enter the first message for this task.");
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
    const identity = { profileId: credential.profileId } satisfies MobileNewTaskDraftIdentity;
    const createOperationId = this.newId();
    const action = this.#claimMutation();
    this.#newTaskSubmissionActive = true;
    try {
      const submission = await this.newTaskDrafts.beginSubmission(identity, { targetId, name, text: firstInput }, {
        connectionId: credential.connectionId,
        serverId: credential.serverId,
        backendId: target.backendId,
        targetRevision: targetRevision.value.toString(10),
        ...(targetRevision.etag === "" ? {} : { targetRevisionEtag: targetRevision.etag }),
        createOperationId
      });
      try {
        await this.network.prepareTarget(credential, target, this.#abort?.signal);
        this.#assertNewTaskCreateAuthority(submission);
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
      return await this.#continueNewTaskCreation(identity, submission, result, false);
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
        permissionMode: PermissionMode.ASK,
        initialPlacement: NativeSessionPlacement.PROJECT
      }) }
    });
  }

  #assertNewTaskCreateAuthority(submission: MobileNewTaskCreateSubmission): void {
    const credential = this.#ready();
    const target = this.#state.owner?.targets.find((candidate) => candidate.targetId === submission.targetId);
    const backend = this.#state.owner?.backends.find((candidate) => candidate.backendId === submission.backendId);
    const revision = target?.version?.revision;
    if (credential.connectionId !== submission.connectionId || credential.serverId !== submission.serverId
      || this.#activeProfileId !== credential.profileId || this.#state.node?.serverId !== submission.serverId
      || !target || target.backendId !== submission.backendId || target.state !== TargetState.ACTIVE
      || !revision || revision.value.toString(10) !== submission.targetRevision
      || (revision.etag || undefined) !== submission.targetRevisionEtag
      || !backend || !supportsText(backend)) {
      throw new Error("The project or Backend changed while this task was being prepared. Review the retained draft and try again.");
    }
  }

  async #continueNewTaskCreation(
    identity: MobileNewTaskDraftIdentity,
    submission: MobileNewTaskCreateSubmission,
    result: TrackedMutationResult,
    refreshBeforeSend: boolean
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
    await this.#stageNewTaskComposerDraft(identity, session.sessionId, submission.inputText);
    const sending = await this.newTaskDrafts.advanceToSending(
      identity,
      submission.createOperationId,
      session.sessionId,
      generation
    );
    if (refreshBeforeSend && this.#credential?.connectionId === submission.connectionId && this.#foreground) {
      await this.refresh();
      if (this.#mutationOwner !== undefined) this.#set({ busy: true });
    }
    return this.#sendNewTaskFirstInput(identity, sending);
  }

  #createdNewTaskSession(operation: Operation, submission: MobileNewTaskCreateSubmission): Session | undefined {
    const session = operation.result?.payload.case === "session" ? operation.result.payload.value : undefined;
    const generation = session?.nativeBinding?.runtimeGeneration;
    if (operation.operationId !== submission.createOperationId || operation.connectionId !== submission.connectionId
      || !session || !session.sessionId || session.backendId !== submission.backendId || session.targetId !== submission.targetId
      || !generation || generation < 1n) return undefined;
    return session;
  }

  async #stageNewTaskComposerDraft(
    identity: MobileNewTaskDraftIdentity,
    sessionId: string,
    text: string
  ): Promise<void> {
    if (!this.composerDrafts) throw new Error("The task composer draft store is unavailable.");
    const composerIdentity = { profileId: identity.profileId, sessionId };
    this.composerDrafts.save(composerIdentity, plainTextMobileComposerDraft(text));
    await this.composerDrafts.flush(composerIdentity);
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
      || generation.toString(10) !== submission.runtimeGeneration) {
      return { status: "blocked", message: "The created task runtime changed before its first message could be sent. The text remains in the task composer for review." };
    }
    return { status: "ready", session };
  }

  async #sendNewTaskFirstInput(
    identity: MobileNewTaskDraftIdentity,
    initial: MobileNewTaskSendSubmission
  ): Promise<MobileNewTaskResult> {
    if (!this.newTaskDrafts || !this.composerDrafts) throw new Error("Retained new-task drafts are unavailable.");
    const authority = this.#newTaskSendAuthority(initial);
    if (authority.status === "deferred") {
      this.#set({ error: authority.message });
      return { sessionId: initial.sessionId, created: true, sent: false, definitive: false };
    }
    if (authority.status === "blocked") {
      await this.newTaskDrafts.clear(identity);
      this.#set({ error: authority.message });
      return { sessionId: initial.sessionId, created: true, sent: false, definitive: true };
    }
    const sendOperationId = initial.sendOperationId ?? this.newId();
    const submission = initial.sendOperationId === undefined
      ? await this.newTaskDrafts.setSendOperation(identity, initial.createOperationId, sendOperationId)
      : initial;
    const result = await this.#submitTerminal(create(OperationMutationSchema, {
      preconditions: [create(OperationPreconditionSchema, {
        entity: create(EntityRefSchema, { kind: EntityKind.SESSION, id: submission.sessionId }),
        expectedGeneration: BigInt(submission.runtimeGeneration)
      })],
      payload: { case: "sendInput", value: create(SendInputMutationSchema, {
        sessionId: submission.sessionId,
        input: create(InputContentSchema, {
          parts: [create(InputPartSchema, { content: { case: "text", value: submission.inputText } })]
        }),
        deliveryMode: QueueDeliveryMode.PROMPT
      }) }
    }), { kind: "send", sessionId: submission.sessionId }, sendOperationId);
    return this.#finishNewTaskFirstInput(identity, submission, result);
  }

  async #finishNewTaskFirstInput(
    identity: MobileNewTaskDraftIdentity,
    submission: MobileNewTaskSendSubmission,
    result: TrackedMutationResult
  ): Promise<MobileNewTaskResult> {
    if (!this.newTaskDrafts || !this.composerDrafts) throw new Error("Retained new-task drafts are unavailable.");
    if (!result.definitive) {
      return { sessionId: submission.sessionId, created: true, sent: false, definitive: false };
    }
    if (!result.accepted || result.operation?.state !== OperationState.SUCCEEDED) {
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
      await this.newTaskDrafts.clear(identity);
      this.#set({ error: "The first-message operation returned an invalid queue result. The text remains in the task composer; verify the task before sending again." });
      return { sessionId: submission.sessionId, created: true, sent: false, definitive: true };
    }
    await this.composerDrafts.clear({ profileId: identity.profileId, sessionId: submission.sessionId });
    await this.newTaskDrafts.clear(identity);
    return { sessionId: submission.sessionId, created: true, sent: true, definitive: true };
  }

  async send(draft: MobileComposerDraft): Promise<boolean> {
    const exactDraft = normalizeMobileComposerDraft(draft);
    const sessionId = this.#state.selectedId;
    const session = this.#state.detail?.sessions.find((item) => item.sessionId === sessionId);
    const backend = this.#state.owner?.backends.find((item) => item.backendId === session?.backendId);
    const generation = session?.nativeBinding?.runtimeGeneration;
    if (!exactDraft.text.trim() || !sessionId || !session || !backend || !supportsText(backend) || !generation || generation < 1n) {
      throw new Error("A current task generation and non-empty text are required.");
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
    const sendDraft = assertMobileCatalogMentionDraft(
      catalogMentionControls,
      assertMobileWorkspaceMentionDraft(
        workspaceMentionControls,
        assertMobileSessionMentionDraft(mentionControls, exactDraft)
      )
    );
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
        try { await this.composerDrafts.clearIfEqual(draftIdentity, sendDraft); }
        catch (error) {
          this.#set({ error: `${message(error)} The accepted message will not be sent again automatically.` });
        }
      }
      return accepted;
    } finally { this.#releaseMutation(action); }
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
    const action = this.#claimMutation();
    try {
      const result = await this.#submitTerminal(create(OperationMutationSchema, {
        preconditions: [this.#interactionPrecondition(interaction)],
        payload: { case: "resolveInteraction", value: create(ResolveInteractionMutationSchema, {
          interactionId: interaction.interactionId,
          interactionGeneration: interaction.generation,
          resolution
        }) }
      }), { kind: "interaction-resolve", sessionId: interaction.sessionId, interactionId: interaction.interactionId,
        ...this.#interactionReceiptIdentity(interaction) });
      return result.accepted && result.definitive;
    } finally { this.#releaseMutation(action); }
  }

  async dismissInteraction(interactionId: string): Promise<boolean> {
    const interaction = this.#interactionContext(interactionId);
    this.#assertNoPendingInteractionMutation(interaction.sessionId, interaction.interactionId);
    this.#ready();
    const action = this.#claimMutation();
    try {
      const result = await this.#submitTerminal(create(OperationMutationSchema, {
        preconditions: [this.#interactionPrecondition(interaction)],
        payload: { case: "dismissInteraction", value: create(DismissInteractionMutationSchema, {
          interactionId: interaction.interactionId,
          interactionGeneration: interaction.generation,
          reason: "Dismissed by user on mobile"
        }) }
      }), { kind: "interaction-dismiss", sessionId: interaction.sessionId, interactionId: interaction.interactionId,
        ...this.#interactionReceiptIdentity(interaction) });
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

  #claimMutation(): symbol {
    if (this.#mutationOwner || this.#connectionAttemptAbort || this.#state.busy) {
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
      && ["session-model", "session-permission", "session-plan", "session-compact", "session-branch"].includes(item.kind))) {
      throw new Error("A previous task control change is still pending. Check its operation before changing another setting.");
    }
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

  #cancelFilesRequests(): void {
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
    operationId?: string
  ): Promise<TrackedMutationResult> {
    return this.#submitTracked(mutation, identity, true, operationId);
  }

  async #submitTracked(
    mutation: OperationMutation,
    identity: Pick<PendingOperation, "kind" | "sessionId" | "eventId" | "queueItemId" | "interactionId" | "interactionGeneration" | "interactionRevision" | "interactionDraftKind" | "targetConnectionId" | "targetDeviceId">,
    waitForTerminal: boolean,
    operationId = this.newId()
  ): Promise<TrackedMutationResult> {
    const credential = this.#ready();
    const epoch = this.#epoch;
    const pending: PendingOperation = { ...identity, connectionId: credential.connectionId, operationId, state: "unknown" };
    const before = this.#state.pending;
    const next = [...before, pending];
    this.#set({ pending: next, busy: true, error: undefined });
    try {
      if (!await this.#persistPending(next, epoch)) return { accepted: false, definitive: false };
    } catch (error) {
      if (this.#current(epoch)) this.#set({ pending: before, busy: false });
      throw error;
    }
    let operation: Operation;
    try {
      operation = await this.network.submit(credential, pending.operationId, mutation, this.#abort?.signal);
    } catch (error) {
      if (this.#current(epoch)) this.#set({ busy: false, error: `Operation ${pending.operationId}: ${message(error)}. Check status; it was not resent.` });
      return { accepted: false, definitive: false };
    }
    if (!this.#current(epoch)) return { accepted: false, definitive: false };
    if (operation.operationId !== pending.operationId || operation.connectionId !== pending.connectionId) {
      this.#set({ busy: false, error: `Operation ${pending.operationId} returned with the wrong durable identity. Its receipt was retained and no input was resent.` });
      return { accepted: false, definitive: false };
    }
    await this.#receipt(operation, pending, epoch);
    if (waitForTerminal && !isTerminal(operation.state)) {
      try {
        operation = await this.network.waitOperation(credential, pending.operationId, this.#abort?.signal);
      } catch (error) {
        if (this.#current(epoch)) this.#set({
          busy: false,
          error: `Operation ${pending.operationId}: ${message(error)}. Its durable result is unknown; it was not resent.`
        });
        return { accepted: false, definitive: false };
      }
      if (!this.#current(epoch)) return { accepted: false, definitive: false };
      if (operation.operationId !== pending.operationId || operation.connectionId !== pending.connectionId) {
        this.#set({ busy: false, error: `Operation ${pending.operationId} completed with the wrong durable identity. Its receipt was retained and no input was resent.` });
        return { accepted: false, definitive: false };
      }
      await this.#receipt(operation, pending, epoch);
    }
    const rejected = operation.state === OperationState.FAILED
      || operation.state === OperationState.CONFLICT
      || operation.state === OperationState.CANCELLED;
    const rejectionMessage = rejected ? operation.error?.message || "The operation was rejected." : undefined;
    if (this.#current(epoch)) {
      this.#set({ busy: false });
      await this.refresh();
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
    if (pending.kind === "create" && operation.result?.payload.case === "session") {
      const sessionId = operation.result.payload.value.sessionId;
      if (sessionId && this.#activeProfileId) {
        let maySelect = this.newTaskDrafts === undefined || this.composerDrafts === undefined;
        if (this.newTaskDrafts && this.composerDrafts) {
          try {
            const identity = { profileId: this.#activeProfileId };
            const draft = await this.newTaskDrafts.read(identity);
            if (draft?.submission?.phase === "creating"
              && draft.submission.createOperationId === pending.operationId
              && this.#createdNewTaskSession(operation, draft.submission)) {
              await this.#stageNewTaskComposerDraft(identity, sessionId, draft.submission.inputText);
              maySelect = true;
            }
          } catch (error) {
            if (this.#current(epoch)) this.#set({ error: message(error) });
          }
        }
        if (maySelect) {
          await this.storage.saveSelection(this.#activeProfileId, sessionId);
          if (!this.#current(epoch)) return;
          this.#set({ selectedId: sessionId });
        }
      }
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
              "session-model", "session-permission", "session-plan", "session-compact", "session-branch"].includes(pending.kind)
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
        await this.#continueNewTaskCreation(identity, submission, trackedOperation(observed), true);
        return;
      }
      await this.#stageNewTaskComposerDraft(identity, submission.sessionId, submission.inputText);
      if (submission.sendOperationId === undefined) {
        await this.#sendNewTaskFirstInput(identity, submission);
        return;
      }
      const observed = await this.#observeRetainedNewTaskOperation(submission, epoch);
      if (observed === "not-dispatched") {
        await this.newTaskDrafts.clear(identity);
        this.#set({ error: "The retained first message had no durable operation receipt and was not dispatched. Its text remains in the created task composer." });
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
          else await this.newTaskDrafts.clear(identity);
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

function supportsText(backend: Snapshot["backends"][number]): boolean {
  return backend.capabilities?.capabilities.some((item) => item.name === capabilityNames.inputText && item.support === CapabilitySupport.SUPPORTED) === true;
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

function historyInvalidated(event: Event): boolean {
  switch (event.payload?.kind.case) {
    case "messageDeleted":
    case "sessionReset":
    case "historyPruned": return true;
    case "nativeBranchChanged": return event.payload.kind.value.timelineRebuilt;
    default: return false;
  }
}
