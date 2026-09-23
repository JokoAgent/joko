import type { JSONContent } from "@tiptap/core";

export type Locale = "en" | "zh-CN" | "en-XA";
export type Theme = "system" | "light" | "dark";
export type PermissionMode = "ask" | "auto" | "bypassPermissions";
export type DeliveryMode = "prompt" | "steer" | "followUp";

export interface ConnectionProfile {
  readonly id: string;
  /** Desktop-owned local Orchestrator connection, provisioned through private host IPC. */
  readonly managedLocal?: boolean;
  /** Durable Orchestrator Device identity. */
  readonly deviceId: string;
  /** Durable Orchestrator node identity, verified without a bearer before reconnect. */
  readonly serverId: string;
  readonly name: string;
  readonly origin: string;
  readonly lastConnectedAt?: number;
}

export type MachinePresenceView = "current" | "checking" | "online" | "offline" | "identityMismatch" | "accessDenied";

export interface MachineSessionCacheView {
  readonly id: string;
  readonly name: string;
  readonly state: SessionView["state"];
  readonly targetName?: string;
  readonly pinned: boolean;
  readonly archived: boolean;
  readonly lastActivityAt: number;
  readonly attentionKind?: SessionAttentionView["kind"];
  readonly attentionUnread?: boolean;
  readonly interactionKind?: InteractionView["kind"];
}

/** Content-light owner cache used only to keep remote task navigation available while a node is offline. */
export interface MachineCacheView {
  readonly profileId: string;
  readonly serverId: string;
  readonly name: string;
  readonly origin: string;
  readonly updatedAt: number;
  readonly sessions: readonly MachineSessionCacheView[];
}

export interface DiscoveredOrchestratorView {
  readonly serverId: string;
  readonly name: string;
  readonly origin: string;
  readonly version: string;
  readonly apiVersion: string;
  readonly pairingEnabled: boolean;
  readonly lastSeenAt: number;
  readonly source: "current" | "orchestrator" | "desktop";
  readonly transport: "https" | "loopbackHttp" | "lanHttp";
}

export interface CapabilityView {
  readonly name: string;
  readonly supported: boolean;
  readonly reason?: string;
  readonly options: readonly string[];
  readonly maximumBytes?: number;
  readonly maximumItems?: number;
}

export interface BackendView {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly health: "healthy" | "degraded" | "unavailable";
  readonly instanceGeneration?: number;
  readonly installationState?: "notInstalled" | "installing" | "installed" | "updateAvailable" | "error" | "unknown";
  readonly authenticationState?: "notRequired" | "signedOut" | "pending" | "authenticated" | "expired" | "refreshing" | "error" | "unknown";
  readonly error?: string;
  readonly capabilities: ReadonlyMap<string, CapabilityView>;
  readonly providerRuntimeSupport?: {
    readonly protocols: readonly ProviderCompatibilityView[];
    readonly fields: readonly ProviderConfigurationFieldView[];
  };
}

export interface TargetView {
  readonly id: string;
  readonly revision: bigint;
  readonly backendId: string;
  readonly name: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly trusted: boolean;
  readonly pinned: boolean;
  readonly archived: boolean;
  readonly remoteWorkspace?: {
    readonly hostTargetId: string;
    readonly hostId: string;
    readonly workspaceRoot: string;
  };
  readonly error?: string;
}

export type ArtifactStorageMaintenanceSupportView =
  | "supported"
  | "upstreamMissing"
  | "notImplemented"
  | "platformLimited"
  | "disabledByPolicy"
  | "temporarilyUnavailable"
  | "unspecified";

export interface ArtifactStorageStatsView {
  readonly referenceCount: number;
  readonly uniqueBlobCount: number;
  readonly totalBytes: number;
  readonly cacheReferenceCount: number;
  readonly cacheBytes: number;
  readonly temporaryFileCount: number;
  readonly temporaryBytes: number;
}

export interface ArtifactStorageMaintenanceView {
  readonly support: ArtifactStorageMaintenanceSupportView;
  readonly reason?: string;
  readonly stats?: ArtifactStorageStatsView;
}

export interface ArtifactStorageScanView {
  readonly token: string;
  readonly expiresAt: number;
  readonly protectedReferenceCount: number;
  readonly expiredReferenceCount: number;
  readonly orphanBlobCount: number;
  readonly orphanBlobBytes: number;
  readonly temporaryFileCount: number;
  readonly temporaryBytes: number;
  readonly missingBlobCount: number;
  readonly unsafeEntryCount: number;
  readonly cleanableBytes: number;
}

export interface ArtifactStorageReconcileView {
  readonly healthy: boolean;
  readonly missingBlobCount: number;
  readonly orphanBlobCount: number;
  readonly unsafeEntryCount: number;
}

export type ArtifactStorageCleanupView =
  | { readonly outcome: "scanExpired" | "storageChanged" }
  | {
      readonly outcome: "completed";
      readonly expiredReferencesDeleted: number;
      readonly blobsRemoved: number;
      readonly temporaryFilesRemoved: number;
      readonly freedBytes: number;
      readonly skipped: number;
    };

export type TaskHistoryRetentionView = "7-days" | "1-month" | "3-months" | "6-months";

export interface TaskHistoryMaintenanceSupportView {
  readonly supported: boolean;
  readonly reason?: string;
}

export interface TaskHistoryScanView {
  readonly scanId: string;
  readonly retention: TaskHistoryRetentionView;
  readonly includeActiveTasks: boolean;
  readonly scannedAt: number;
  readonly olderThan: number;
  readonly expiresAt: number;
  readonly activeTaskCount: number;
  readonly deletedTaskCount: number;
  readonly archivedTaskCount: number;
  readonly messageCount: number;
  readonly estimatedHistoryBytes: number;
  readonly databaseBytes: number;
  readonly temporaryBytesRequired: number;
  readonly databaseVolumeFreeBytes?: number;
}

export type TaskHistoryCleanupView =
  | { readonly outcome: "scanExpired" | "storageChanged" | "cancelled" }
  | {
      readonly outcome: "completed";
      readonly activeTaskCount: number;
      readonly deletedTaskCount: number;
      readonly archivedTaskCount: number;
      readonly messageCount: number;
      readonly beforeBytes: number;
      readonly afterBytes: number;
      readonly reclaimedBytes: number;
      readonly backupCreated: boolean;
      readonly skippedTaskCount: number;
    };

export type TaskHistoryMaintenancePhaseView = "preparing" | "copying" | "cleaning" | "compacting" | "verifying" | "installing";

export type TaskHistoryCleanupProgressView =
  | {
      readonly maintenanceId: string;
      readonly status: "running";
      readonly phase: TaskHistoryMaintenancePhaseView;
      readonly percent: number;
      readonly cancellable: boolean;
      readonly updatedAt: number;
    }
  | {
      readonly maintenanceId: string;
      readonly status: "completed";
      readonly phase: TaskHistoryMaintenancePhaseView;
      readonly percent: number;
      readonly cancellable: false;
      readonly updatedAt: number;
      readonly result: Extract<TaskHistoryCleanupView, { readonly outcome: "completed" }>;
    }
  | {
      readonly maintenanceId: string;
      readonly status: "scanExpired" | "storageChanged" | "cancelled" | "failed";
      readonly phase: TaskHistoryMaintenancePhaseView;
      readonly percent: number;
      readonly cancellable: false;
      readonly updatedAt: number;
    };

export interface TargetDraft {
  readonly backendId: string;
  readonly name: string;
  readonly workspaceKind: "userProject" | "managedDialogue";
  readonly serverPath: string;
  readonly createIfMissing: boolean;
}

export interface RemoteTargetDraft {
  readonly backendId: string;
  readonly name: string;
  readonly hostTargetId: string;
  readonly hostId: string;
  readonly expectedHostTargetRevision: bigint;
  readonly expectedHostRevision: bigint;
  readonly workspacePath: string;
  readonly createIfMissing: boolean;
}

export interface ProjectDirectoryListingView {
  readonly path: string;
  readonly parentPath: string;
  readonly directories: readonly { readonly name: string; readonly path: string }[];
  readonly truncated: boolean;
}

export interface ModelView {
  readonly backendId: string;
  readonly providerId: string;
  readonly providerName: string;
  readonly providerAccessKind?: ProviderConfigurationView["kind"];
  readonly pricingKnown?: boolean;
  readonly pricingSource?: "providerReference" | "upstream";
  readonly pricingUpdatedAt?: number;
  readonly modelId: string;
  readonly logicalId?: string;
  readonly name: string;
  readonly available: boolean;
  readonly routingEnabled?: boolean;
  readonly defaultVisible?: boolean;
  readonly supportsImages: boolean;
  readonly inputModalities: readonly ModelInputModalityView[];
  readonly outputModalities: readonly ModelOutputModalityView[];
  readonly supportsFast: boolean;
  readonly efforts: readonly string[];
  readonly contextWindow: number;
  readonly maximumOutputTokens: number;
  readonly inputCostMicrosPerMillion: number;
  readonly outputCostMicrosPerMillion: number;
  readonly cacheReadCostMicrosPerMillion?: number;
  readonly cacheWriteCostMicrosPerMillion?: number;
  readonly currencyCode: string;
}

export type ModelInputModalityView = "text" | "image" | "file" | "audio";
export type ModelOutputModalityView = "text" | "image" | "audio";

export interface SessionAttentionView {
  readonly kind: "done" | "awaiting" | "error";
  readonly unread: boolean;
  readonly subjectCursor: TimelineHistoryCursorView;
  readonly attentionCursor: TimelineHistoryCursorView;
  readonly readThroughCursor: TimelineHistoryCursorView;
  readonly updatedAt: number;
}

export type RemoteHostAuthenticationView = "systemAgent" | "privateKey" | "nodeKey";
export type RemoteHostStatusView = "disconnected" | "connecting" | "authenticating" | "ready" | "failed";

export interface RemoteHostView {
  readonly targetId: string;
  readonly id: string;
  readonly hostname: string;
  readonly port: number;
  readonly user: string;
  readonly source: "manual" | "sshConfig";
  readonly authentication: RemoteHostAuthenticationView;
  readonly credentialReferenceId?: string;
  readonly nodeKey?: { readonly id: string; readonly expectedFingerprint: string };
  readonly trust?: {
    readonly algorithm: string;
    readonly sha256Fingerprint: string;
    readonly pinnedAt: number;
  };
  readonly status: {
    readonly state: RemoteHostStatusView;
    readonly changedAt: number;
    readonly failure?: { readonly code: string; readonly retryable: boolean };
  };
  readonly revision: bigint;
}

export interface RemoteHostDirectoryListingView {
  readonly targetId: string;
  readonly hostId: string;
  readonly targetRevision: bigint;
  readonly hostRevision: bigint;
  readonly path: string;
  readonly parentPath: string;
  readonly directories: readonly { readonly name: string; readonly path: string }[];
  readonly truncated: boolean;
}

export interface RemoteHostDirectoryInspectionView {
  readonly targetId: string;
  readonly hostId: string;
  readonly targetRevision: bigint;
  readonly hostRevision: bigint;
  readonly exists: boolean;
  readonly path: string;
}

export interface SshKeyView {
  readonly id: string;
  readonly name: string;
  readonly algorithm: string;
  readonly comment: string;
  readonly sha256Fingerprint: string;
  readonly modifiedAt: number;
  readonly inAgent: boolean;
}

export interface SshKeyCatalogView {
  readonly keys: readonly SshKeyView[];
  readonly agentState: "ready" | "unavailable" | "failed";
  readonly generationSupported: boolean;
}

export interface SshKeyGenerateDraft {
  readonly name: string;
  readonly comment: string;
  readonly passphrase?: string;
}

export interface SshKeyInstallCommandDraft {
  readonly keyId: string;
  readonly expectedFingerprint: string;
  readonly destination:
    | { readonly kind: "savedHost"; readonly targetId: string; readonly hostId: string; readonly expectedRevision: bigint }
    | { readonly kind: "draftHost"; readonly hostname: string; readonly user: string; readonly port: number };
  readonly shell: "posix" | "powershell";
}

export interface RemoteHostDraft {
  readonly id: string;
  readonly hostname: string;
  readonly port: number;
  readonly user: string;
  readonly authentication: RemoteHostAuthenticationView;
  readonly credentialReferenceId?: string;
  readonly nodeKey?: { readonly id: string; readonly expectedFingerprint: string };
}

export interface RemoteHostCapabilitiesView {
  readonly catalog: boolean;
  readonly management: boolean;
  readonly connectionControl: boolean;
  readonly connectionTest: boolean;
  readonly trustReset: boolean;
  readonly commandExecution: boolean;
  readonly processStreaming: boolean;
  readonly fileTransfer: boolean;
  readonly tcpForwarding: boolean;
  readonly backendRuntimeSetup: boolean;
}

export type PartnerLifecycleView = "active" | "archived" | "deleted";
export type PartnerInitializationStateView = "pending" | "ready" | "error";
export type PartnerInitializationErrorCodeView =
  | "homeUnavailable"
  | "avatarUnavailable"
  | "modelUnavailable"
  | "sessionUnavailable"
  | "stateChanged";
export type PartnerInvitationStageView = "home" | "avatar" | "session" | "ready" | "failed";
export type PartnerPermissionModeView = Extract<PermissionMode, "ask" | "auto">;
export type PartnerSessionRoleView = "canonical" | "history" | "delegation";
export type PartnerPrivateThreadStatusView = "active" | "closed";
export type PartnerPrivateThreadCloseReasonView = "messageLimit" | "idleTimeout";
export type PartnerPrivateMessageDeliveryStatusView = "pending" | "delivered" | "failed";
export type PartnerDelegationStatusView =
  | "preparing"
  | "queued"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

export interface PartnerModelRouteView {
  readonly backendId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly effort?: string;
  readonly fastMode: boolean;
}

export interface PartnerCapabilitiesView {
  readonly modelChain: readonly PartnerModelRouteView[];
  readonly permissionMode: PartnerPermissionModeView;
  readonly planMode: boolean;
}

export interface PartnerTemplateView {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly identitySource: string;
}

export interface PartnerDirectoryView {
  readonly revision: bigint;
  readonly activeCount: number;
  readonly archivedCount: number;
  readonly errorCount: number;
  readonly updatedAt: number;
  readonly templates: readonly PartnerTemplateView[];
  readonly avatarPresets: readonly string[];
  readonly defaultCapabilities?: PartnerCapabilitiesView;
}

export interface PartnerProfileView {
  readonly id: string;
  readonly revision: bigint;
  readonly profileVersion: bigint;
  readonly displayName: string;
  readonly avatar: string;
  readonly identitySource: string;
  readonly templateId: string;
  readonly lifecycle: PartnerLifecycleView;
  readonly initializationState: PartnerInitializationStateView;
  readonly invitationStage: PartnerInvitationStageView;
  readonly initializationErrorCode?: PartnerInitializationErrorCodeView;
  readonly homeTargetId: string;
  readonly canonicalSessionId?: string;
  readonly capabilities: PartnerCapabilitiesView;
  readonly usesDirectoryDefaults: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly activity: PartnerActivityView;
}

export interface PartnerActivityView {
  readonly partnerId: string;
  readonly unreadReplyCount: number;
  readonly latestReplyCursor?: bigint;
  readonly latestReplyAt?: number;
  readonly artifactCount: number;
  readonly activeDelegationCount: number;
  readonly readThroughCursor: bigint;
  readonly readUpdatedAt: number;
}

export interface PartnerSessionView {
  readonly sessionId: string;
  readonly partnerId: string;
  readonly role: PartnerSessionRoleView;
  readonly profileVersion: bigint;
  readonly parentSessionId?: string;
  readonly delegationId?: string;
  readonly displayName: string;
  readonly available: boolean;
  readonly readOnly: boolean;
  readonly archived: boolean;
  readonly deleted: boolean;
  readonly createdAt: number;
  readonly lastActivityAt?: number;
}

export interface PartnerPrivateThreadView {
  readonly id: string;
  readonly firstPartnerId: string;
  readonly secondPartnerId: string;
  readonly status: PartnerPrivateThreadStatusView;
  readonly closeReason?: PartnerPrivateThreadCloseReasonView;
  readonly messageCount: number;
  readonly maxMessages: number;
  readonly expiresAt: number;
  readonly blockedUntil?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly closedAt?: number;
}

export interface PartnerPrivateMessageView {
  readonly id: string;
  readonly threadId: string;
  readonly sequence: number;
  readonly senderPartnerId: string;
  readonly recipientPartnerId: string;
  readonly content: string;
  readonly deliveryStatus: PartnerPrivateMessageDeliveryStatusView;
  readonly createdAt: number;
  readonly deliveredAt?: number;
}

export interface PartnerPrivateThreadReadStateView {
  readonly threadId: string;
  readonly partnerId: string;
  readonly throughSequence: number;
  readonly updatedAt: number;
}

export interface PartnerPrivateThreadDetailView {
  readonly thread: PartnerPrivateThreadView;
  readonly messages: readonly PartnerPrivateMessageView[];
  readonly readState?: PartnerPrivateThreadReadStateView;
}

export interface PartnerDelegationView {
  readonly id: string;
  readonly revision: bigint;
  readonly requesterPartnerId: string;
  readonly targetPartnerId: string;
  readonly parentSessionId: string;
  readonly targetProfileVersion: bigint;
  readonly title: string;
  readonly objective: string;
  readonly status: PartnerDelegationStatusView;
  readonly childSessionId?: string;
  readonly runId?: string;
  readonly resultSummary?: string;
  readonly error?: string;
  readonly artifactCount: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly startedAt?: number;
  readonly completedAt?: number;
}

export interface PartnerDraftView {
  readonly displayName: string;
  readonly avatar: string;
  readonly identitySource: string;
  readonly templateId: string;
  readonly capabilities?: PartnerCapabilitiesView;
  readonly usesDirectoryDefaults: boolean;
}

export interface PartnerPatchView {
  readonly displayName?: string;
  readonly avatar?: string;
  readonly identitySource?: string;
  readonly modelChain?: readonly PartnerModelRouteView[];
  readonly permissionMode?: PartnerPermissionModeView;
  readonly planMode?: boolean;
  readonly usesDirectoryDefaults?: boolean;
}

export interface PartnerListView {
  readonly partners: readonly PartnerProfileView[];
  readonly directory: PartnerDirectoryView;
}

export interface PartnerMutationView {
  readonly partner: PartnerProfileView;
  readonly directory: PartnerDirectoryView;
}

export interface PartnerDefaultsMutationView {
  readonly directory: PartnerDirectoryView;
  readonly affectedPartners: readonly PartnerProfileView[];
}

export type CollaborationGoalStatusView = "active" | "completed" | "stopped" | "failed" | "archived";
export type CollaborationWorkerStatusView =
  | "provisioning"
  | "idle"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "stopping"
  | "stopped"
  | "dispatchUnknown"
  | "archived";
export type CollaborationDispatchStatusView = "preparing" | "queued" | "merged" | "cancelled" | "dispatchUnknown";
export type CollaborationInterruptStopOutcomeView = "stopped" | "notRunning" | "unconfirmed" | "alreadyQueued";

export interface CollaborationGoalView {
  readonly id: string;
  readonly revision: bigint;
  readonly leadId: string;
  readonly leadSessionId: string;
  readonly backendId: string;
  readonly targetId: string;
  readonly sessionGeneration: bigint;
  readonly backendInstanceGeneration: bigint;
  readonly title: string;
  readonly objective: string;
  readonly maximumWorkers?: number;
  readonly status: CollaborationGoalStatusView;
  readonly error?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt?: number;
}

export interface CollaborationWorkerRouteView {
  readonly backendId: string;
  readonly targetId: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly effort?: string;
  readonly fastMode: boolean;
  readonly permissionMode: PermissionMode;
  readonly planMode: boolean;
}

export interface CollaborationWorkerView {
  readonly id: string;
  readonly revision: bigint;
  readonly goalId: string;
  readonly parentWorkerId?: string;
  readonly sessionId?: string;
  readonly route: CollaborationWorkerRouteView;
  readonly sessionGeneration?: bigint;
  readonly backendInstanceGeneration?: bigint;
  readonly label: string;
  readonly role: string;
  readonly assignment: string;
  readonly status: CollaborationWorkerStatusView;
  readonly focused: boolean;
  readonly runtimeReleased: boolean;
  readonly softLimitWarning: boolean;
  readonly idleSince?: number;
  readonly error?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CollaborationDispatchView {
  readonly id: string;
  readonly revision: bigint;
  readonly goalId: string;
  readonly workerId: string;
  readonly callerLeadSessionId: string;
  readonly operationId: string;
  readonly queueItemId?: string;
  readonly message: string;
  readonly status: CollaborationDispatchStatusView;
  readonly mergedIntoDispatchId?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CollaborationQueueEntryView {
  readonly dispatch: CollaborationDispatchView;
  readonly queueItem?: QueueItemView;
}

export interface CollaborationGoalTreeView {
  readonly goal: CollaborationGoalView;
  readonly workers: readonly CollaborationWorkerView[];
  readonly queue: readonly CollaborationQueueEntryView[];
  readonly focusedWorkerId?: string;
}

export interface CollaborationWorkerDraftView {
  readonly parentWorkerId?: string;
  readonly label: string;
  readonly role: string;
  readonly assignment: string;
  readonly targetId: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly effort?: string;
  readonly fastMode: boolean;
  readonly permissionMode: PermissionMode;
  readonly planMode: boolean;
}

export type ContactKindView = "person" | "organization";
export type ContactStatusView = "confirmed" | "pending";
export type ContactSourceView = "manual" | "agent" | "import";

export interface ContactIdentityInputView {
  readonly platform: string;
  readonly value: string;
  readonly label: string;
  readonly note: string;
}

export interface ContactEventInputView {
  readonly date: string;
  readonly text: string;
  readonly source: string;
}

export interface ContactIdentityView extends ContactIdentityInputView {
  readonly id: string;
  readonly contactId: string;
  readonly revision: bigint;
  readonly normalizedValue: string;
  readonly createdAt: number;
}

export interface ContactEventView extends ContactEventInputView {
  readonly id: string;
  readonly contactId: string;
  readonly revision: bigint;
  readonly createdAt: number;
}

export interface ContactGroupView {
  readonly id: string;
  readonly revision: bigint;
  readonly name: string;
  readonly description: string;
  readonly memberCount: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ContactRelationView {
  readonly id: string;
  readonly revision: bigint;
  readonly fromContactId: string;
  readonly toContactId: string;
  readonly relation: string;
  readonly note: string;
  readonly createdAt: number;
  readonly direction: "outgoing" | "incoming";
  readonly relatedContactId: string;
  readonly relatedDisplayName: string;
  readonly relatedKind: ContactKindView;
}

export interface ContactSummaryView {
  readonly id: string;
  readonly revision: bigint;
  readonly kind: ContactKindView;
  readonly displayName: string;
  readonly aliases: readonly string[];
  readonly summary: string;
  readonly status: ContactStatusView;
  readonly source: ContactSourceView;
  readonly identityCount: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ContactProfileView extends ContactSummaryView {
  readonly narrative: string;
  readonly agentNotes: string;
  readonly identities: readonly ContactIdentityView[];
  readonly events: readonly ContactEventView[];
  readonly groups: readonly ContactGroupView[];
  readonly relations: readonly ContactRelationView[];
}

export interface ContactDirectoryView {
  readonly format: number;
  readonly revision: bigint;
  readonly enabled: boolean;
  readonly people: number;
  readonly organizations: number;
  readonly pending: number;
  readonly groups: number;
}

export type ContactSyncPhaseView = "off" | "waiting" | "syncing" | "upToDate" | "error";
export type ContactSyncErrorCodeView = "identityUnavailable" | "peerIdentityChanged" | "syncFailed";

export interface ContactSyncPeerView {
  readonly peerId: string;
  readonly revision: bigint;
  readonly displayName: string;
  readonly fingerprint: string;
  readonly online: boolean;
  readonly state: "pending" | "active";
  readonly grantedAt: number;
  readonly lastSyncAt?: number;
  readonly lastRoute?: "lan";
}

export interface ContactSyncCandidateView {
  readonly nodeId: string;
  readonly displayName: string;
  readonly fingerprint: string;
  readonly seenAt: number;
  readonly granted: boolean;
  readonly keyChanged: boolean;
}

export interface ContactSyncStatusView {
  readonly available: boolean;
  readonly configurationRevision: bigint;
  readonly nodeId: string;
  readonly fingerprint: string;
  readonly enabled: boolean;
  readonly phase: ContactSyncPhaseView;
  readonly onlinePeerCount: number;
  readonly errorCode?: ContactSyncErrorCodeView;
  readonly lastSyncAt?: number;
  readonly lastSyncPeerId?: string;
  readonly lastSyncPeerName?: string;
  readonly lastRoute?: "lan";
  readonly peers: readonly ContactSyncPeerView[];
  readonly candidates: readonly ContactSyncCandidateView[];
}

export interface ContactDraftView {
  readonly kind: ContactKindView;
  readonly displayName: string;
  readonly aliases: readonly string[];
  readonly summary: string;
  readonly narrative: string;
  readonly agentNotes: string;
  readonly status: ContactStatusView;
  readonly source: ContactSourceView;
  readonly identities: readonly ContactIdentityInputView[];
}

export interface ContactPatchView {
  readonly kind?: ContactKindView;
  readonly displayName?: string;
  readonly aliases?: readonly string[];
  readonly summary?: string;
  readonly narrative?: string;
  readonly agentNotes?: string;
  readonly status?: ContactStatusView;
}

export interface ContactDuplicateCandidateView {
  readonly matchType: "identity" | "name";
  readonly contactId: string;
  readonly displayName: string;
  readonly kind: ContactKindView;
  readonly status: ContactStatusView;
  readonly summary: string;
  readonly matchedPlatform?: string;
  readonly matchedValue?: string;
}

export interface ContactDuplicatePairView {
  readonly first: ContactSummaryView;
  readonly second: ContactSummaryView;
}

export interface ContactListOptionsView {
  readonly query?: string;
  readonly kind?: ContactKindView;
  readonly status?: ContactStatusView;
  readonly groupId?: string;
  readonly pageSize?: number;
  readonly pageOffset?: number;
}

export interface ContactListPageView {
  readonly contacts: readonly ContactSummaryView[];
  readonly total: number;
  readonly nextPageOffset?: number;
}

export interface ContactMutationView {
  readonly contact: ContactProfileView;
  readonly directory: ContactDirectoryView;
}

export interface ContactCreateResultView {
  readonly contact?: ContactProfileView;
  readonly candidates: readonly ContactDuplicateCandidateView[];
  readonly directory: ContactDirectoryView;
}

export interface ContactMergeResultView {
  readonly target: ContactProfileView;
  readonly mergedContactId: string;
  readonly movedIdentities: number;
  readonly movedEvents: number;
  readonly movedRelations: number;
  readonly directory: ContactDirectoryView;
}

export type ContactVCardImportDispositionView = "create" | "autoEnrich" | "needsReview";
export type ContactVCardImportDecisionKindView = "create" | "merge" | "skip";

export interface ContactVCardImportPreviewEntryView {
  readonly entryId: string;
  readonly contact: ContactDraftView;
  readonly disposition: ContactVCardImportDispositionView;
  readonly existingContactId?: string;
  readonly candidates: readonly ContactDuplicateCandidateView[];
  readonly existingEntryId?: string;
  readonly similarEntryIds: readonly string[];
  readonly organizationName?: string;
  readonly title?: string;
  readonly groups: readonly string[];
  readonly organizationContactId?: string;
  readonly organizationCandidates: readonly ContactDuplicateCandidateView[];
}

export interface ContactVCardImportPreviewView {
  readonly previewId: string;
  readonly directoryRevision: bigint;
  readonly entries: readonly ContactVCardImportPreviewEntryView[];
  readonly expiresAt: number;
}

export interface ContactVCardImportDecisionView {
  readonly entryId: string;
  readonly decision: ContactVCardImportDecisionKindView;
  readonly targetContactId?: string;
  readonly expectedTargetRevision?: bigint;
  readonly confirmedNameCandidateIds?: readonly string[];
  readonly targetEntryId?: string;
  readonly organizationDecision?: ContactVCardImportDecisionKindView;
  readonly organizationTargetContactId?: string;
  readonly expectedOrganizationTargetRevision?: bigint;
  readonly organizationTargetEntryId?: string;
  readonly confirmedOrganizationCandidateIds?: readonly string[];
}

export interface ContactVCardImportResultView {
  readonly created: number;
  readonly enriched: number;
  readonly skipped: number;
  readonly contactIds: readonly string[];
  readonly entries: readonly ContactVCardImportEntryResultView[];
  readonly directory: ContactDirectoryView;
}

export interface ContactVCardImportEntryResultView {
  readonly entryId: string;
  readonly displayName: string;
  readonly outcome: "created" | "enriched" | "skipped";
  readonly contactId?: string;
}

export interface ContactVCardExportView {
  readonly text: string;
  readonly contactCount: number;
  readonly suggestedFileName: string;
}

export type RemoteBackendRuntimeStateView = "probing" | "notInstalled" | "installing" | "ready" | "failed" | "outcomeUnknown";
export type RemoteBackendRuntimeInstallPhaseView = "probing" | "downloading" | "installing" | "validating" | "complete" | "failed" | "outcomeUnknown";
export type RemoteBackendRuntimeFailureCodeView = "aborted" | "authorityChanged" | "hostNotReady" | "notSupported" | "probeFailed" | "installFailed" | "uninstallFailed" | "busy";

export interface RemoteBackendRuntimeView {
  readonly targetId: string;
  readonly hostId: string;
  readonly displayName: string;
  readonly expectedVersion: string;
  readonly installedVersion?: string;
  readonly state: RemoteBackendRuntimeStateView;
  readonly canInstall: boolean;
  readonly canReinstall: boolean;
  readonly canUninstall: boolean;
  readonly failure?: { readonly code: RemoteBackendRuntimeFailureCodeView; readonly retryable: boolean };
  readonly observedAt: number;
  readonly targetRevision: bigint;
  readonly hostRevision: bigint;
}

export interface RemoteBackendRuntimeInstallEventView {
  readonly requestId: string;
  readonly sequence: bigint;
  readonly phase: RemoteBackendRuntimeInstallPhaseView;
  readonly runtime: RemoteBackendRuntimeView;
  readonly observedAt: number;
}

/** Content-free resource usage for one Adapter-owned service-node runtime. */
export interface RuntimeProcessUsageView {
  readonly backendId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly pid: number;
  readonly cpuPercent: number;
  readonly memoryKb: number;
  readonly processCount: number;
  readonly terminable: boolean;
  /** Opaque spawn-instance action fence; never an executable or command. */
  readonly processInstanceId?: string;
}

export interface RuntimeProcessUsageSnapshotView {
  readonly capturedAt: number;
  readonly processes: readonly RuntimeProcessUsageView[];
}

export interface UsageTokensView {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly totalTokens: number;
  readonly costMicros: number;
  readonly currencyCode: string;
}

export interface SessionStatisticsView {
  readonly sessionId: string;
  readonly messageCount: number;
  readonly turnCount: number;
  readonly branchCount: number;
  readonly compactionCount: number;
  readonly usage?: UsageTokensView;
  readonly context?: {
    readonly usedTokens: number;
    readonly contextWindow: number;
    readonly reservedTokens: number;
    readonly utilizationRatio: number;
    readonly measuredAt?: number;
  };
  readonly activeDurationMs: number;
}

export interface UsageCurrencyTotalView {
  readonly currencyCode: string;
  readonly usage: UsageTokensView;
  readonly costComplete: boolean;
  readonly estimated: boolean;
}

export interface UsageHistorySummaryView {
  readonly usage: UsageTokensView;
  readonly currencyTotals: readonly UsageCurrencyTotalView[];
  readonly costComplete: boolean;
  readonly estimated: boolean;
}

export interface UsageHistoryDayView extends UsageHistorySummaryView {
  readonly day: string;
  readonly measuredAt?: number;
}

export interface ModelUsageHistoryDayView extends UsageHistorySummaryView {
  readonly day: string;
  readonly backendId: string;
  readonly providerId: string;
  readonly modelId: string;
}

export interface ModelUsageHistorySummaryView extends UsageHistorySummaryView {
  readonly backendId: string;
  readonly providerId: string;
  readonly modelId: string;
}

export interface UsageHistoryView {
  readonly days: readonly UsageHistoryDayView[];
  readonly modelDaily: readonly ModelUsageHistoryDayView[];
  readonly models: readonly ModelUsageHistorySummaryView[];
  readonly today: UsageHistorySummaryView;
  readonly last30Days: UsageHistorySummaryView;
  readonly currentStreakDays: number;
  readonly longestStreakDays: number;
  readonly todayAnomalous: boolean;
  readonly generatedAt: number;
  readonly measuredAt?: number;
  readonly estimated: boolean;
}

export interface UsageReportQueryView {
  readonly group: "task" | "model" | "provider" | "backend";
  readonly fromDay?: string;
  readonly throughDay?: string;
  readonly backendId?: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly sessionId?: string;
  readonly pageToken?: string;
}

export interface UsageReportEntryView {
  readonly key: string;
  readonly sessionId: string;
  readonly backendId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly title: string;
  readonly referenceAvailable: boolean;
  readonly summary: UsageHistorySummaryView;
  readonly measuredAt: number;
}

export interface UsageReportView {
  readonly entries: readonly UsageReportEntryView[];
  readonly summary: UsageHistorySummaryView;
  readonly nextPageToken: string;
  readonly totalGroups: number;
}

export type ModelPriceCurrencyView = "USD" | "CNY";

export interface ModelPriceQuoteView {
  readonly currency: ModelPriceCurrencyView;
  /** Currency units per one million tokens. */
  readonly inputPerMillion: number;
  /** Currency units per one million tokens. */
  readonly outputPerMillion: number;
  /** Currency units per one million tokens. */
  readonly cacheReadPerMillion?: number;
  /** Currency units per one million tokens. */
  readonly cacheWritePerMillion?: number;
}

export interface ModelPriceOverrideView {
  readonly backendId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly reference: ModelPriceQuoteView;
  readonly effective: ModelPriceQuoteView;
  readonly override?: ModelPriceQuoteView;
  readonly allowedCurrencies: readonly ModelPriceCurrencyView[];
  readonly referenceAvailable: boolean;
  readonly registryUpdatedAt?: number;
  readonly updatedAt?: number;
  readonly revision?: bigint;
}

export interface SessionView {
  readonly id: string;
  readonly backendId: string;
  readonly targetId: string;
  /** Navigation-only project placement; absence places the task in Dialogue. */
  readonly projectId?: string;
  readonly remoteWorkspace?: boolean;
  readonly runtimeAttached?: boolean;
  readonly name: string;
  readonly summary?: string;
  readonly state: "idle" | "running" | "waiting" | "retrying" | "error" | "closed";
  readonly pinned: boolean;
  readonly archived: boolean;
  readonly generation: bigint;
  readonly model?: ModelView;
  readonly effort?: string;
  readonly fastMode: boolean;
  readonly permissionMode: PermissionMode;
  readonly planMode: boolean;
  readonly worktree?: SessionWorktreeView;
  readonly attention?: SessionAttentionView;
  readonly createdAt?: number;
  readonly updatedAt: number;
  /** Lifetime accounting reported for this task; never a context-capacity proxy. */
  readonly usage?: UsageTokensView;
  readonly context?: ContextView;
  /** Present when supplied by a fresh Pi observation or a typed lifecycle event. */
  readonly compacting?: boolean;
  readonly activeRunId?: string;
  /** Authoritative start time of the active Run; absent when no active Run exists. */
  readonly activeRunStartedAt?: number;
  readonly retryRunId?: string;
  readonly nativeLeafId?: string;
  /** Durable scheduler ownership used by navigation grouping. */
  readonly automationOrigin?: TimelineAutomationOriginView;
  /** Immutable task lineage projected by Orchestrator; availability is authoritative for this snapshot. */
  readonly derivationOrigin?: {
    readonly kind: "fork" | "clone";
    readonly sourceSessionId: string;
    readonly sourceMessageId?: string;
    readonly sourceEventId?: string;
    readonly sourceSessionAvailable: boolean;
    readonly sourceMessageAvailable: boolean;
  };
  /** Credential-free task context projected by a capability-owned code-host provider. */
  readonly codeHostPullRequests?: readonly CodeHostPullRequestView[];
}

export type NativeNavigationTargetView =
  | { readonly kind: "native_entry"; readonly entryId: string }
  | { readonly kind: "session_start" };

export interface CodeHostPullRequestView {
  readonly key: string;
  readonly host: string;
  readonly repositoryOwner: string;
  readonly repositoryName: string;
  readonly number: number;
  readonly webUrl: string;
  readonly projection?: {
    readonly state: "open" | "closed" | "merged";
    readonly draft: boolean;
    readonly title: string;
    readonly headBranch: string;
    readonly unresolvedReviewThreadCount?: number;
    readonly observedAt: number;
  };
}

export interface ContextView {
  readonly usedTokens: number;
  readonly contextWindow: number;
  readonly reservedTokens: number;
  readonly utilizationRatio: number;
  readonly measuredAt?: number;
  /** Present only when supplied by an authoritative Pi snapshot or setting. */
  readonly autoCompact?: boolean;
  /** Present only when supplied by an authoritative Pi snapshot or setting. */
  readonly autoRetry?: boolean;
}

export interface TimelineItemView {
  readonly id: string;
  /** Owning completed/streaming message when one message projects multiple blocks. */
  readonly messageId?: string;
  /** Ordered message-block position used to reconcile stream deltas with final content. */
  readonly contentIndex?: number;
  /** Transient indexed text fragments retained only until completion is authoritative. */
  readonly messageTextBlocks?: readonly { readonly contentIndex: number; readonly text: string }[];
  /** Durable event used to reload an around-message window for persistent deep links. */
  readonly sourceEventId?: string;
  /** Opaque native entry identity when the generated event contract supplied one. */
  readonly nativeEntryId?: string;
  /** Opaque native parent identity used to fork before a user prompt. */
  readonly nativeParentEntryId?: string;
  readonly nativeRewindBefore?: NativeNavigationTargetView;
  /** Durable run ownership used by turn-scoped UI projections such as plans. */
  readonly runId?: string;
  /** Terminal outcome carried only by durable run-terminal timeline events. */
  readonly runTerminal?: "completed" | "aborted" | "failed";
  readonly sequence: bigint;
  readonly kind:
    | "user"
    | "assistant"
    | "thinking"
    | "tool"
    | "toolResult"
    | "image"
    | "artifact"
    | "diff"
    | "error"
    | "compaction"
    | "contextRebuild"
    | "runtimeRecovery"
    | "interaction"
    | "background"
    | "review"
    | "status";
  readonly createdAt: number;
  readonly title?: string;
  readonly text?: string;
  readonly streaming?: boolean;
  readonly collapsed?: boolean;
  /**
   * Durable product truth that the user text contains Joko-owned quote
   * marker blocks. Renderers must never infer this from the text itself.
   */
  readonly quotesEncoded?: boolean;
  /** Ordered UTF-16 spans used to render compact sent-paste atoms. */
  readonly pastedTextRanges?: readonly TimelineInlineTextRangeView[];
  /** Service-authored receipt of the exact accepted user input. */
  readonly userInputAccepted?: true;
  readonly inputMentions?: readonly TimelineInputMentionView[];
  readonly mentionRanges?: readonly TimelineInputMentionRangeView[];
  /** Authoritative accounting for this completed assistant segment. */
  readonly usage?: TimelineMessageUsageView;
  /** Durable host-authored identity for a scheduler-injected user prompt. */
  readonly automationOrigin?: TimelineAutomationOriginView;
  /** Typed accepted-input semantics; absent only for untyped imported history. */
  readonly inputDelivery?: DeliveryMode | "scheduler";
  /** Service-owned continuation prompt; hidden in favor of its recovery activity row. */
  readonly automaticContinuation?: { readonly recoveryId: string };
  readonly tool?: ToolCallView;
  /** Inline projection replacing one or more raw plan tool rows. */
  readonly inlinePlan?: TimelinePlanView;
  readonly artifact?: ArtifactView;
  readonly error?: ErrorView;
  readonly background?: BackgroundTaskView;
  /** Durable isolated-review status card. */
  readonly review?: ReviewRunView;
  readonly interaction?: TimelineInteractionView;
  /** Transient Pi retry status retained in the durable projection but not rendered as history. */
  readonly retry?: TimelineRetryView;
  /** Pi compaction lifecycle; STARTED is projected into the transient status slot. */
  readonly compaction?: TimelineCompactionView;
  /** Hidden same-Backend native-context replacement, rendered only as a system boundary. */
  readonly contextRebuild?: TimelineContextRebuildView;
  /** Durable interrupted-turn recovery lifecycle. */
  readonly runtimeRecovery?: TimelineRuntimeRecoveryView;
  readonly attachments?: readonly ArtifactView[];
  readonly workspaceDiff?: TimelineWorkspaceDiffView;
}

export interface TimelineInlineTextRangeView {
  readonly start: number;
  readonly end: number;
  readonly display: string;
}

export type TimelineInputMentionView =
  | { readonly kind: "workspace"; readonly workspaceId: string; readonly relativePath: string; readonly displayText: string; readonly directory: boolean; readonly lineRange?: { readonly startLine: number; readonly endLine: number } }
  | { readonly kind: "resource"; readonly resourceId: string; readonly displayText: string; readonly discoveredRevision: string; readonly resourceVersion: string; readonly runtimeGeneration: number }
  | { readonly kind: "artifact"; readonly sourceSessionId: string; readonly artifactId: string; readonly displayText: string }
  | { readonly kind: "session"; readonly sessionId: string; readonly displayText: string };

export interface TimelineInputMentionRangeView {
  readonly start: number;
  readonly end: number;
  /** Index into inputMentions, independent of text and attachment parts. */
  readonly mentionIndex: number;
}

export interface TimelineMessageUsageView {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly totalTokens: number;
  readonly cost: number;
  readonly currency: string;
  /** Native generation-only duration for this completed assistant segment. */
  readonly generationDurationMs?: number;
  /** False means usage exists but no compatible native generation duration was proved. */
  readonly generationReliable?: boolean;
}

export interface SessionWorktreeView {
  readonly leaseId: string;
  readonly workspaceId: string;
  readonly workingPath: string;
  readonly repositoryRoot: string;
  readonly branch: string;
  readonly sourceRef: string;
  readonly sourceCommit: string;
  readonly sourceStrategy: "explicit" | "remoteDefaultRefreshed" | "remoteDefaultLocal" | "currentBranch" | "localDefault" | "head";
  readonly sourceRefreshed: boolean;
  readonly sourceRemote?: string;
  readonly state: "active" | "preserved";
  readonly acquiredAt: number;
  readonly updatedAt: number;
}

export interface TimelineAutomationOriginView {
  readonly kind: "scheduler";
  readonly scheduleId: string;
  readonly scheduleName?: string;
  readonly runId?: string;
}

export interface TimelineRetryView {
  readonly state: "waiting" | "started" | "aborted" | "succeeded" | "exhausted" | "unknown";
  readonly source: "auto" | "summarization" | "unknown";
  readonly attemptNumber: number;
  readonly maxAttempts?: number;
  readonly retryAt?: number;
  /** Present only when this retry lifecycle has an explicit user-facing notice. */
  readonly error?: ErrorView;
}

export interface TimelineCompactionView {
  readonly id: string;
  readonly state: "started" | "completed" | "noOp" | "aborted" | "failed" | "unknown";
  readonly reason: "manual" | "threshold" | "overflow" | "automatic" | "branch" | "unknown";
  readonly automatic: boolean;
  readonly boundaryId?: string;
  readonly tokensBefore?: number;
  readonly tokensAfter?: number;
  readonly willRetry?: boolean;
}

export interface TimelineContextRebuildView {
  readonly reason: "contextOverflow" | "promptTimeout";
  readonly handoff: string;
  readonly sourceRunId?: string;
  readonly replayScheduled: boolean;
}

export interface TimelinePlanView {
  readonly identity: string;
  readonly source: "todo" | "updatePlan" | "task";
  readonly sourceItemIds: readonly string[];
  readonly steps: readonly TimelinePlanStepView[];
}

export interface TimelinePlanStepView {
  readonly id: string;
  readonly content: string;
  readonly state: "pending" | "inProgress" | "completed";
}

export interface TimelineInteractionView {
  readonly id: string;
  readonly kind: "permission" | "question" | "plan" | "extension" | "unknown";
  readonly state: "pending" | "resolved" | "dismissed" | "expired" | "cancelled" | "unknown";
  readonly title: string;
  readonly prompt: string;
  readonly questions: readonly TimelineQuestionAnswerView[];
}

export interface TimelineQuestionAnswerView {
  readonly id: string;
  readonly question: string;
  readonly answer?:
    | { readonly kind: "text"; readonly values: readonly string[] }
    | { readonly kind: "boolean"; readonly value: boolean };
}

export interface SessionMessageSearchMatchView {
  readonly sessionId: string;
  readonly eventId: string;
  readonly timelineItemId: string;
  readonly role: "user" | "assistant";
  readonly kind: "textMessage";
  readonly snippet: string;
  readonly createdAt: number;
  readonly score: number;
  readonly ftsRank?: number;
  readonly vectorRank?: number;
}

/**
 * A live durable-message match returned by another authenticated service node.
 * Remote message text is intentionally never written into the offline machine
 * cache; the profile/session tuple is the durable UI identity.
 */
export interface FederatedSessionMessageSearchMatchView {
  readonly profileId: string;
  readonly serverId: string;
  readonly source: "live";
  readonly reachable: true;
  readonly match: SessionMessageSearchMatchView;
}

export interface SessionMessageSearchResultView {
  readonly matches: readonly SessionMessageSearchMatchView[];
  readonly totalSize: number;
  readonly revision: bigint;
  readonly vectorUsed: boolean;
  readonly vectorSkipReason?: string;
  readonly poolCapped: boolean;
}

export interface SessionMessageSearchPageView extends SessionMessageSearchResultView {
  readonly nextPageToken?: string;
}

/** Exact durable-message search scopes representable by SessionService. */
export type SessionMessageSearchScopeView =
  | { readonly kind: "owner" }
  | { readonly kind: "target"; readonly targetId: string }
  | { readonly kind: "session"; readonly sessionId: string };

export interface SessionMessageSearchFiltersView {
  readonly targetIds?: readonly string[];
  readonly sessionIds?: readonly string[];
  readonly backendIds?: readonly string[];
  readonly sessionStatus?: "active" | "archived";
  readonly sessionActivityFrom?: number;
  readonly messageCreatedFrom?: number;
  readonly messageCreatedBefore?: number;
}

export interface SessionMessageSearchCollectionOptions {
  readonly scope?: SessionMessageSearchScopeView;
  readonly filters?: SessionMessageSearchFiltersView;
  readonly pageSize?: number;
  readonly semanticMode?: "hybrid" | "keyword";
  /** Cancels the whole multi-page collection without disconnecting Orchestrator. */
  readonly signal?: AbortSignal;
}

export interface TimelineHistoryCursorView {
  readonly opaqueToken: string;
  readonly sequence: bigint;
  readonly generation: bigint;
}

export interface TimelineHistoryPageView {
  readonly items: readonly TimelineItemView[];
  readonly nextBeforeCursor?: TimelineHistoryCursorView;
}

export interface TimelineWorkspaceDiffView extends WorkspaceDiffView {
  readonly workspaceId: string;
  readonly changeSetId?: string;
  readonly completeBaseline: boolean;
  readonly gaps: readonly string[];
  readonly generatedFiles: readonly TimelineGeneratedFileView[];
}

export interface TimelineGeneratedFileView {
  readonly relativePath: string;
  readonly displayName: string;
}

export interface ToolCallView {
  readonly id: string;
  readonly name: string;
  readonly state: "requested" | "waiting" | "running" | "succeeded" | "failed" | "aborted";
  readonly input: string;
  readonly output?: string;
  readonly isError: boolean;
}

export interface ArtifactView {
  readonly id: string;
  readonly blobId: string;
  readonly sourceSessionId?: string;
  readonly sourceRevealAvailable: boolean;
  readonly title: string;
  readonly description?: string;
  readonly kind: "file" | "image" | "export" | "tool" | "diff" | "diagnostics";
  readonly fileName: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly downloadUrl?: string;
  readonly audioMetadata?: AudioArtifactMetadataView;
}

/** A canonical Artifact that may be explicitly referenced by another task. */
export interface ArtifactReferenceCatalogItemView extends ArtifactView {
  /** Original task authority; never inferred from the receiving task. */
  readonly sourceSessionId: string;
}

export interface AudioArtifactMetadataView {
  readonly kind: "generic" | "music" | "sound_effect";
  readonly title: string;
  readonly description: string;
  readonly durationSeconds?: number;
  readonly artwork?: { readonly blobId: string; readonly width: number; readonly height: number; readonly alt: string };
}

export interface ErrorView {
  readonly runId?: string;
  readonly code: string;
  readonly message: string;
  readonly phase: string;
  readonly severity: "waiting" | "retryable" | "blocked" | "fatal";
  readonly retryable: boolean;
  readonly recovery: readonly ErrorRecoveryActionView[];
}

export type ErrorRecoveryActionKindView =
  | "wait"
  | "retry"
  | "resnapshot"
  | "reauthenticate"
  | "resolveInteraction"
  | "openSession"
  | "openDiagnostics"
  | "contactOwner"
  | "abort"
  | "unknown";

export interface ErrorRecoveryActionView {
  readonly id: string;
  readonly kind: ErrorRecoveryActionKindView;
  readonly label: string;
  readonly retryAfterMs?: number;
}

export interface QueueItemView {
  readonly id: string;
  readonly sessionId: string;
  readonly revision: bigint;
  readonly generation: bigint;
  readonly source: "user" | "schedule" | "backend" | "retry";
  readonly mode: DeliveryMode;
  /** Canonical concatenation of the accepted InputContent text parts. */
  readonly text: string;
  /** Durable product truth for Joko-owned selected-text quote atoms. */
  readonly quotesEncoded?: boolean;
  /** Ordered UTF-16 spans for compact pasted-text atoms. */
  readonly pastedTextRanges?: readonly TimelineInlineTextRangeView[];
  /** Exact typed references carried by the queued input. */
  readonly inputMentions?: readonly TimelineInputMentionView[];
  /** Ordered UTF-16 occurrences into text, indexed against inputMentions. */
  readonly mentionRanges?: readonly TimelineInputMentionRangeView[];
  /** Non-text attachments retained by the queue item. */
  readonly attachments?: readonly QueueInputAttachmentView[];
  readonly state: "accepted" | "dispatching" | "acceptedByBackend" | "dispatchUnknown" | "completed" | "cancelled" | "failed";
  readonly editLocked: boolean;
  readonly ordinal: number;
  readonly createdAt: number;
}

export interface QueueInputAttachmentView {
  readonly kind: "image" | "file";
  readonly label: string;
}

/** Text-editor result whose ranges were mapped through the actual edit transaction. */
export interface QueueItemTextEditView {
  readonly text: string;
  readonly mentionRanges: readonly TimelineInputMentionRangeView[];
  readonly pastedTextRanges: readonly TimelineInlineTextRangeView[];
  /** Ordered UTF-16 edits from the durable Queue text to this projection. */
  readonly textSplices: readonly QueueTextEditSpliceView[];
}

export interface QueueTextEditSpliceView {
  readonly start: number;
  readonly end: number;
  readonly replacementText: string;
}

export interface QueueControlView {
  readonly sessionId: string;
  readonly revision: bigint;
  readonly generation: bigint;
  readonly state: "active" | "paused";
  readonly pauseReason?: string;
  readonly pausedAt?: number;
  readonly interactionLocked: boolean;
  readonly queuedItemCount: number;
}

export interface InteractionView {
  readonly id: string;
  readonly sessionId: string;
  readonly generation: bigint;
  readonly kind: "permission" | "question" | "plan" | "select" | "confirm" | "input" | "editor";
  readonly title: string;
  readonly message: string;
  readonly options: readonly { readonly id: string; readonly label: string; readonly description?: string }[];
  readonly fields: readonly QuestionFieldView[];
  readonly planSteps: readonly PlanStepView[];
  readonly planMarkdown?: string;
  readonly placeholder?: string;
  readonly prefill?: string;
  readonly risk?: "read" | "low" | "medium" | "high" | "critical";
  readonly permissionSubject?: PermissionSubjectView;
  readonly createdAt: number;
  readonly expiresAt?: number;
}

export interface PermissionArgumentView {
  readonly fieldPath: string;
  readonly value: string;
  readonly redacted: boolean;
}

export type PermissionSubjectView =
  | {
      readonly kind: "file";
      readonly workspaceId: string;
      readonly paths: readonly string[];
      readonly action: "read" | "create" | "update" | "delete" | "move" | "unknown";
      readonly outsidePrimaryWorkspace: boolean;
    }
  | {
      readonly kind: "command";
      readonly executable: string;
      readonly arguments: readonly string[];
      readonly workingDirectory: string;
      readonly networkAccess: boolean;
      readonly writesOutsideWorkspace: boolean;
      readonly usesShell: boolean;
    }
  | {
      readonly kind: "mcp";
      readonly serverId: string;
      readonly toolName: string;
      readonly arguments: readonly PermissionArgumentView[];
    }
  | {
      readonly kind: "browser";
      readonly providerId: string;
      readonly pageId: string;
      readonly action: "readPage" | "navigate" | "interact" | "upload" | "download" | "takeOver" | "unknown";
      readonly origin: string;
    }
  | {
      readonly kind: "customTool";
      readonly toolId: string;
      readonly displayName: string;
      readonly arguments: readonly PermissionArgumentView[];
    }
  | {
      readonly kind: "resource";
      readonly resourceId: string;
      readonly sourcePath: string;
      readonly action: "approve" | "install" | "update" | "enable" | "unknown";
    };

export interface QuestionFieldView {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly required: boolean;
  readonly kind: "text" | "single" | "multiple" | "boolean";
  readonly options: readonly { readonly id: string; readonly label: string; readonly description?: string }[];
  readonly placeholder?: string;
  readonly defaultValue?: string | boolean | readonly string[];
  readonly multiline: boolean;
  readonly minimumSelections: number;
  readonly maximumSelections?: number;
  readonly allowOther: boolean;
}

export interface PlanStepView {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly state: "pending" | "inProgress" | "completed" | "skipped";
}

export type QuestionAnswerDraft =
  | { readonly kind: "text"; readonly value: string }
  | {
      readonly kind: "single";
      readonly selection:
        | { readonly kind: "choice"; readonly choiceId: string }
        | { readonly kind: "other"; readonly text: string };
    }
  | { readonly kind: "multiple"; readonly choiceIds: readonly string[]; readonly otherText?: string }
  | { readonly kind: "boolean"; readonly value: boolean };

export type InteractionResolutionDraft =
  | { readonly kind: "permission"; readonly decisionId: string }
  | { readonly kind: "question"; readonly answers: Readonly<Record<string, QuestionAnswerDraft>> }
  | { readonly kind: "plan"; readonly decisionId: string; readonly feedback: string }
  | { readonly kind: "extension"; readonly value: string | boolean };

export interface BackgroundTaskView {
  readonly id: string;
  readonly title: string;
  readonly state: "queued" | "running" | "waiting" | "completed" | "failed" | "aborted" | "unknown";
  readonly detail?: string;
  readonly parentTaskId?: string;
  readonly runId?: string;
  readonly progressRatio?: number;
  readonly startedAt?: number;
  readonly endedAt?: number;
  /** Timestamp of the newest durable state observation, independent of Timeline placement. */
  readonly updatedAt?: number;
  readonly error?: ErrorView;
}

export interface BackgroundTaskActivityView {
  readonly id: string;
  readonly sessionId: string;
  readonly state: BackgroundTaskView["state"];
}

export interface BackgroundTaskHistoryView extends BackgroundTaskView {
  readonly backendId: string;
  readonly targetId: string;
  readonly sessionId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly revision: bigint;
}

export type SubagentRunStateView = "queued" | "running" | "completed" | "failed" | "stopped";
export type SubagentControlActionView = "stop" | "steer" | "followUp" | "resume";

export interface SubagentUsageView {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly totalTokens?: number;
  readonly toolUses?: number;
  readonly durationMs?: number;
  readonly costUsd?: number;
}

export interface SubagentRouteView {
  readonly providerId?: string;
  readonly modelId?: string;
  readonly thinkingLevel?: string;
}

export interface SubagentCapabilitiesView {
  readonly viewActivity: boolean;
  readonly viewReturnedResult: boolean;
  readonly viewFullTranscript: boolean;
  readonly stop: boolean;
  readonly steer: boolean;
  readonly followUp: boolean;
  readonly resume: boolean;
  readonly parentContext: "none" | "snapshot" | "live" | "unknown";
}

export interface SubagentRunView {
  readonly id: string;
  readonly sessionId: string;
  readonly parentRunId?: string;
  readonly parentSubagentRunId?: string;
  readonly parentTaskId?: string;
  readonly parentToolCallId?: string;
  readonly logicalAgentId?: string;
  readonly identityAliases: readonly string[];
  readonly providerRunIds: readonly string[];
  readonly state: SubagentRunStateView;
  readonly title: string;
  readonly description?: string;
  readonly assignment?: string;
  readonly summary?: string;
  readonly route?: SubagentRouteView;
  readonly usage?: SubagentUsageView;
  readonly readOnly?: boolean;
  readonly capabilities: SubagentCapabilitiesView;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly endedAt?: number;
  readonly error?: ErrorView;
  readonly revision: bigint;
}

export interface SubagentActivityView {
  readonly sequence: number;
  readonly kind: "started" | "progress" | "message" | "question" | "decision" | "resumed" | "steered" | "followedUp" | "completed" | "failed" | "stopped";
  readonly state: SubagentRunStateView;
  readonly summary?: string;
  readonly lastToolName?: string;
  readonly occurredAt: number;
}

export interface SubagentChildRunView {
  readonly id: string;
  readonly parentChildId?: string;
  readonly identityAliases: readonly string[];
  readonly role?: string;
  readonly title: string;
  readonly assignment?: string;
  readonly state: SubagentRunStateView;
  readonly route?: SubagentRouteView;
  readonly usage?: SubagentUsageView;
  readonly readOnly?: boolean;
  readonly awaitingApproval?: boolean;
  readonly result?: string;
  readonly resultTruncated?: boolean;
  readonly error?: ErrorView;
  readonly startedAt: number;
  readonly endedAt?: number;
}

export interface SubagentRunDetailView {
  readonly run: SubagentRunView;
  readonly activity: readonly SubagentActivityView[];
  readonly children: readonly SubagentChildRunView[];
  readonly returnedResult?: string;
  readonly returnedResultTruncated?: boolean;
  readonly childrenObserved?: boolean;
}

export interface SubagentTranscriptEntryView {
  readonly id: string;
  readonly sequence: number;
  readonly role: "parent" | "subagent" | "tool" | "system";
  readonly content: string;
  readonly occurredAt: number;
  readonly childId?: string;
  readonly childTitle?: string;
  readonly toolName?: string;
  readonly toolCallId?: string;
  readonly toolPhase?: "start" | "update" | "end";
  readonly toolInputJson?: string;
  readonly isError?: boolean;
  readonly controlAction?: SubagentControlActionView;
  readonly systemEvent?: { readonly kind: string; readonly params: readonly { readonly key: string; readonly value: string }[] };
}

export interface SubagentRunPageView {
  readonly runs: readonly SubagentRunView[];
  readonly nextPageToken?: string;
  readonly totalSize: number;
}

export interface SubagentTranscriptPageView {
  readonly entries: readonly SubagentTranscriptEntryView[];
  readonly nextPageToken?: string;
  readonly tailPageToken?: string;
  readonly totalSize: number;
}

export interface ExtensionWidgetView {
  readonly sessionId: string;
  readonly key: string;
  readonly lines: readonly string[];
  readonly placement: "aboveEditor" | "belowEditor";
  readonly updatedAt: number;
}

export interface ExtensionStatusView {
  readonly sessionId: string;
  readonly key: string;
  readonly text: string;
  readonly updatedAt: number;
}

export interface WorkspaceEntryView {
  readonly path: string;
  readonly name: string;
  readonly summary?: string;
  readonly kind: "file" | "directory";
  readonly size?: number;
  readonly modifiedAt?: number;
  readonly revision?: string;
  readonly mediaType?: string;
  readonly ignored?: boolean;
  readonly hidden?: boolean;
  readonly status?: "added" | "modified" | "deleted" | "renamed" | "untracked" | "conflicted";
  readonly generated: boolean;
  readonly children?: readonly WorkspaceEntryView[];
}

export interface WorkspaceView {
  readonly id: string;
  readonly targetId: string;
  readonly name: string;
  readonly kind: "userProject" | "managedDialogue";
  readonly serverPath: string;
  readonly trusted: boolean;
  readonly branch?: string;
  readonly head?: string;
  readonly detachedHead?: boolean;
  readonly operationInProgress?: boolean;
  readonly dirty: boolean;
  /** Projection revision; file panels use it to re-read an open file after watcher updates. */
  readonly revision?: string;
  readonly entries: readonly WorkspaceEntryView[];
}

export type WorkspaceFileChangeScopeView =
  | { readonly kind: "owner" }
  | { readonly kind: "workspace"; readonly workspaceId: string };

export interface WorkspaceFileChangeView {
  readonly workspaceId: string;
  readonly kind: "created" | "modified" | "deleted" | "renamed" | "overflow" | "resync";
  readonly path?: string;
  readonly previousPath?: string;
  readonly revision?: string;
  readonly byteSize?: number;
  readonly modifiedAt?: number;
  readonly sequence: bigint;
  readonly streamRevision: string;
  readonly observedAt: number;
}

export type ReviewFailureCodeView =
  | "no-visible-result"
  | "reviewer-closed"
  | "cancelled-before-start"
  | "interrupted"
  | "source-workspace-changed"
  | "source-conversation-changed"
  | "source-files-changed"
  | "artifact-changed"
  | "artifact-unavailable"
  | "provider-failed";

export interface ReviewRunView {
  readonly id: string;
  readonly sourceSessionId: string;
  readonly reviewerSessionId?: string;
  readonly state: "running" | "completed" | "failed";
  readonly freshness: "current" | "stale" | "unavailable";
  readonly freshnessCheckedAt: number;
  readonly targetKind: "changes" | "artifacts" | "task" | "mixed";
  readonly evidence: {
    readonly sealSha256: string;
    readonly capturedAt: number;
  };
  readonly failureCode?: ReviewFailureCodeView;
  readonly result?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly endedAt?: number;
  readonly revision: bigint;
}

export interface ExtraDirectoryView {
  readonly id: string;
  readonly workspaceId: string;
  readonly serverPath: string;
  readonly access: "readOnly" | "readWrite";
  readonly trusted: boolean;
}

export interface WorkspaceFilePreviewView {
  readonly path: string;
  readonly name: string;
  readonly kind: "text" | "image" | "blob" | "binary" | "unknown";
  readonly text?: string;
  readonly language?: string;
  /** Opaque server revision used as the compare-and-swap fence for text saves. */
  readonly revision?: string;
  readonly blobId?: string;
  readonly mediaType?: string;
  readonly summary?: string;
  /** Full file size from the authoritative workspace revision. */
  readonly byteSize?: number;
  /** Server-side filesystem modification time in Unix milliseconds. */
  readonly modifiedAt?: number;
  readonly truncated: boolean;
}

export interface WorkspaceTextFileWriteDraft {
  readonly path: string;
  readonly text: string;
  readonly expectedRevision: string;
}

export interface WorkspaceTextFileWriteResultView {
  readonly path: string;
  readonly name: string;
  readonly revision: string;
}

export interface WorkspaceSearchMatchView {
  readonly path: string;
  readonly line: number;
  readonly preview: string;
  /** Authoritative rg UTF-8 byte ranges relative to the untrimmed preview. */
  readonly submatches: readonly WorkspaceSearchSubmatchView[];
  readonly range: {
    readonly startByte: number;
    readonly endByte: number;
    readonly startLine: number;
    readonly startColumn: number;
    readonly endLine: number;
    readonly endColumn: number;
  };
  readonly revision: string;
  readonly pageToken?: string;
}

export interface WorkspaceSearchSubmatchView {
  readonly startByte: number;
  readonly endByte: number;
}

export type WorkspaceSearchErrorCode =
  | "WORKSPACE_SEARCH_INVALID"
  | "WORKSPACE_SEARCH_FAILED"
  | "WORKSPACE_SEARCH_RESULT_CHANGED"
  | "RG_UNAVAILABLE";

export interface WorkspaceEntryPageView {
  readonly entries: readonly WorkspaceEntryView[];
  readonly nextPageToken?: string;
  readonly totalSize: number;
  readonly revision: string;
}

export interface WorkspaceEntryListingOptionsView {
  readonly policy?: "default" | "documentTree";
  readonly includeHidden?: boolean;
}

export interface WorkspaceFileIndexView {
  readonly paths: readonly string[];
  readonly truncated: boolean;
  /** Content-derived fence for this exact ordered rg snapshot. */
  readonly revision: string;
}

export interface WorkspaceSearchPageView {
  readonly matches: readonly WorkspaceSearchMatchView[];
  readonly nextPageToken?: string;
  readonly truncated: boolean;
  readonly totalMatches: number;
  readonly totalFiles: number;
  readonly revision: string;
}

export interface WorkspaceSearchRequestView {
  readonly query: string;
  readonly caseSensitive: boolean;
  readonly regularExpression: boolean;
  readonly pageToken?: string;
  readonly pageSize?: number;
}

export type WorkspaceSearchStreamEventView =
  | { readonly kind: "match"; readonly match: WorkspaceSearchMatchView }
  | {
      readonly kind: "end";
      readonly truncated: boolean;
      readonly totalMatches: number;
      readonly totalFiles: number;
      readonly revision: string;
    }
  | {
      readonly kind: "error";
      readonly code: WorkspaceSearchErrorCode;
      readonly message: string;
    };

export interface WorkspaceEntryMutationDraft {
  readonly workspaceId: string;
  readonly path: string;
  readonly kind: "file" | "directory";
}

export interface WorkspaceEntryMoveDraft {
  readonly workspaceId: string;
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly expectedRevision: string;
}

export interface WorkspaceEntryDeleteDraft {
  readonly workspaceId: string;
  readonly path: string;
  readonly expectedRevision: string;
  readonly confirmRecursive: boolean;
}

export type WorkspaceReviewGitSourceView = "unstaged" | "staged" | "commit" | "branch";
export type WorkspaceReviewSourceView = WorkspaceReviewGitSourceView | "lastTurn" | "turnSet" | "unspecified";

export interface WorkspaceFileDiffView {
  readonly path: string;
  readonly oldPath?: string;
  readonly source: WorkspaceReviewGitSourceView | "turnSet" | "unspecified";
  readonly evidenceId?: string;
  readonly status: WorkspaceEntryView["status"];
  readonly binary: boolean;
  readonly text: string;
  readonly hunks: readonly WorkspaceDiffHunkView[];
  readonly fullDiffBlobId?: string;
}

export interface WorkspaceDiffHunkView {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  readonly heading: string;
  readonly lines: readonly {
    readonly kind: "context" | "added" | "removed" | "noNewline";
    readonly oldLine: number;
    readonly newLine: number;
    readonly text: string;
  }[];
}

export interface WorkspaceDiffView {
  readonly files: readonly WorkspaceFileDiffView[];
  readonly truncated: boolean;
  readonly completeDiffBlobId?: string;
  readonly repositoryRevision: string;
  readonly source: WorkspaceReviewSourceView;
  readonly sourceRevision?: string;
  readonly requestedBaseRef?: string;
  readonly resolvedBaseRef?: string;
  readonly branchBaseWarning?: {
    readonly code: "requestedBaseMissing";
    readonly requestedBaseRef: string;
    readonly resolvedBaseRef: string;
  };
  readonly baseRevision?: string;
  readonly headRevision?: string;
  readonly mergeBaseRevision?: string;
}

export interface WorkspaceDiffQuery {
  readonly source?: WorkspaceReviewGitSourceView;
  /** A commit/ref for COMMIT or the selected base ref for BRANCH. */
  readonly sourceRevision?: string;
  readonly paths?: readonly string[];
  readonly expectedRepositoryRevision?: string;
  readonly expectedMergeBaseRevision?: string;
  readonly ignoreWhitespace?: boolean;
}

export interface WorkspaceDiffHunkMutationDraft {
  readonly action: "stage" | "unstage" | "revert";
  readonly source: "staged" | "unstaged";
  readonly target: "file" | "hunk";
  readonly path: string;
  readonly oldPath?: string;
  readonly hunkIndex?: number;
  readonly expectedRepositoryRevision: string;
  readonly ignoreWhitespace: boolean;
  readonly confirmRevert: boolean;
}

export interface WorkspaceDiffImageSideView {
  readonly present: boolean;
  readonly tooLarge: boolean;
  readonly blobId?: string;
  readonly mediaType?: string;
  readonly width?: number;
  readonly height?: number;
  readonly alt?: string;
}

export interface WorkspaceDiffImageView {
  readonly oldImage: WorkspaceDiffImageSideView;
  readonly newImage: WorkspaceDiffImageSideView;
  readonly repositoryRevision: string;
  readonly mergeBaseRevision?: string;
  readonly maximumBytes: number;
}

export interface WorkspaceGitCommitDraft {
  readonly message: string;
  readonly includeUnstaged: boolean;
  readonly expectedRepositoryRevision: string;
}

export interface WorkspaceGitPushDraft {
  readonly remote: string;
  readonly remoteRef: string;
  readonly expectedRepositoryRevision: string;
  readonly expectedHeadRevision: string;
  readonly confirmForceWithLease: boolean;
  readonly expectedRemoteOid?: string;
}

export interface WorkspaceGitPushResultView {
  readonly outcome: "pushed" | "needsForce";
  readonly remote: string;
  readonly remoteRef: string;
  readonly remoteOid?: string;
  readonly ahead: number;
  readonly behind: number;
  readonly repositoryRevision: string;
  readonly headRevision: string;
}

export interface WorkspaceChangeSetChangeView {
  readonly path: string;
  readonly oldPath?: string;
  readonly kind: "created" | "updated" | "deleted" | "renamed" | "unspecified";
  readonly diff?: WorkspaceFileDiffView;
}

export interface WorkspaceChangeSetView {
  readonly id: string;
  readonly runId: string;
  readonly turnId: string;
  readonly changeCount: number;
  readonly changes?: readonly WorkspaceChangeSetChangeView[];
  readonly completeBaseline: boolean;
  readonly gaps: readonly string[];
  readonly capturedAt: number;
}

export interface WorkspaceRewindPreviewView {
  readonly id: string;
  readonly changeSetId: string;
  readonly safety: "safe" | "requiresConfirmation" | "blocked";
  readonly inversePaths: readonly string[];
  readonly gaps: readonly string[];
  readonly conflicts: readonly string[];
  readonly diff?: WorkspaceDiffView;
  readonly dialogueOnlyAvailable: boolean;
  readonly expiresAt?: number;
}

export interface ScheduleView {
  readonly id: string;
  readonly name: string;
  readonly source: "user" | "project";
  readonly projectConfigId?: string;
  readonly projectConfigPath?: string;
  readonly backendId: string;
  readonly targetId: string;
  readonly sessionMode: "fresh" | "persistent" | "bound";
  readonly sessionId?: string;
  readonly enabled: boolean;
  readonly kind: "once" | "cron" | "interval" | "manual";
  readonly expression: string;
  readonly timezone: string;
  readonly inputText: string;
  readonly executionMode: "agent" | "script";
  readonly script?: {
    readonly command: string;
    readonly timeoutMs?: number;
    readonly capabilities: readonly "sessions.dispatch"[];
  };
  readonly model?: { readonly providerId: string; readonly modelId: string; readonly effort?: string; readonly fastMode: boolean };
  readonly permissionMode: PermissionMode;
  readonly planMode: boolean;
  readonly useWorktree: boolean;
  readonly worktreeSourceRef?: string;
  readonly refreshWorktreeRemote: boolean;
  readonly extraDirectoryIds: readonly string[];
  readonly silentWhenIdle: boolean;
  readonly notifyDesktop: boolean;
  readonly expireAt?: number;
  readonly preRunHook?: {
    readonly command: string;
    readonly filePath: string;
    readonly timeoutMs?: number;
  };
  readonly overlapPolicy: "queue" | "skip";
  readonly misfirePolicy: "runOnce" | "skip";
  readonly nextRunAt?: number;
  readonly lastRun?: { readonly state: ScheduleRunHistoryView["state"]; readonly at: number };
  readonly unreadRunCount: number;
  readonly history: readonly ScheduleRunHistoryView[];
}

export interface TimelineRuntimeRecoveryView {
  readonly id: string;
  readonly sourceRunId: string;
  readonly continuationRunId?: string;
  readonly state: "waiting" | "running" | "succeeded" | "failed" | "exhausted" | "cancelled";
  readonly attempt: number;
  readonly maximumAttempts: number;
  readonly sessionTotal: number;
  readonly delayMs?: number;
  readonly routeChanged?: boolean;
  readonly error: ErrorView;
}

export interface ScheduleRunMoneyView {
  readonly amount: number;
  readonly currency: "CNY" | "USD";
  readonly approximate: boolean;
  readonly kind: "actual-cost" | "value-estimate";
  readonly estimateReasons: readonly string[];
}

export interface SchedulePreRunResultView {
  readonly status: "passed" | "skipped" | "failed" | "timed_out" | "aborted";
  readonly decision: "run" | "skip" | "block";
  readonly exitCode?: number;
  readonly durationMs: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly spawnError?: string;
  readonly error?: string;
}

export interface ScheduleRunHistoryView {
  readonly id: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly state: "completed" | "failed" | "skipped" | "aborted" | "interrupted" | "running";
  readonly scheduledAt: number;
  readonly triggeredAt: number;
  readonly finishedAt?: number;
  readonly durationMs?: number;
  readonly resultText?: string;
  readonly zeroCost: boolean;
  readonly costAttribution: "exact" | "direct" | "mixed" | "zero" | "unavailable";
  readonly cost?: ScheduleRunMoneyView;
  readonly estimatedValue?: ScheduleRunMoneyView;
  readonly preRun?: SchedulePreRunResultView;
  readonly readAt?: number;
  readonly error?: string;
}

export interface ScheduleHistoryPageView {
  readonly history: readonly ScheduleRunHistoryView[];
  readonly nextPageToken?: string;
  readonly totalSize: number;
}

export type ScheduleGeneratedSessionDispositionView = "keep" | "archive" | "delete";

export interface ScheduleDeletionFailureView {
  readonly sessionId: string;
  readonly message: string;
}

export interface ScheduleDeletionResultView {
  readonly scheduleId: string;
  readonly disposition: ScheduleGeneratedSessionDispositionView;
  readonly generatedSessionIds: readonly string[];
  readonly completedSessionIds: readonly string[];
  readonly failures: readonly ScheduleDeletionFailureView[];
  readonly inflightCount: number;
}

export type ScheduleRuntimePhaseView =
  | "loading"
  | "claiming"
  | "persisting"
  | "running"
  | "queued"
  | "cancelling"
  | "finalizing"
  | "stalled"
  | "recovering";

export interface ScheduleRuntimeRunView {
  readonly scheduleId: string;
  readonly scheduleName?: string;
  readonly runId?: string;
  readonly source: "automatic" | "runNow";
  readonly executionMode: ScheduleView["executionMode"];
  readonly startedAt: number;
  readonly slotWaitMs?: number;
  readonly phase: ScheduleRuntimePhaseView;
  readonly lastProgressAt: number;
}

export interface ScheduleRuntimeWaitingView {
  readonly scheduleId: string;
  readonly scheduleName?: string;
  readonly waitingSince: number;
}

export interface SchedulerRuntimeView {
  readonly instanceId: string;
  readonly processId?: number;
  readonly inFlight: number;
  readonly slotsInUse: number;
  readonly maxConcurrentRuns: number;
  readonly runs: readonly ScheduleRuntimeRunView[];
  readonly waiting: readonly ScheduleRuntimeWaitingView[];
}

export interface ScheduleDraft {
  readonly name: string;
  readonly backendId: string;
  readonly targetId: string;
  readonly sessionMode: ScheduleView["sessionMode"];
  readonly sessionId: string;
  readonly enabled: boolean;
  readonly kind: ScheduleView["kind"];
  readonly expression: string;
  readonly timezone: string;
  readonly inputText: string;
  readonly executionMode: ScheduleView["executionMode"];
  readonly scriptCommand: string;
  readonly scriptTimeoutMs?: number;
  readonly scriptDispatchSessions: boolean;
  readonly providerId: string;
  readonly modelId: string;
  readonly effort?: string;
  readonly fastMode: boolean;
  readonly permissionMode: PermissionMode;
  readonly planMode: boolean;
  readonly useWorktree: boolean;
  readonly worktreeSourceRef?: string;
  readonly refreshWorktreeRemote: boolean;
  readonly extraDirectoryIds: readonly string[];
  readonly silentWhenIdle: boolean;
  readonly notifyDesktop: boolean;
  readonly expireAtExpression: string;
  readonly preRunHook?: ScheduleView["preRunHook"];
  readonly overlapPolicy: ScheduleView["overlapPolicy"];
  readonly misfirePolicy: ScheduleView["misfirePolicy"];
}

export interface BrowserView {
  readonly id: string;
  readonly name: string;
  readonly state: "stopped" | "starting" | "ready" | "degraded" | "disconnected" | "recovering" | "error";
  readonly generation: bigint;
  readonly activePageId?: string;
  readonly takeover?: BrowserTakeoverView;
  readonly pages: readonly BrowserPageView[];
}

export interface BrowserTakeoverView {
  readonly id: string;
  readonly pageId: string;
  readonly connectionId: string;
  readonly state: "inactive" | "requested" | "active" | "releasing" | "fenced" | "unknown";
  readonly generation: bigint;
  readonly startedAt?: number;
  readonly expiresAt?: number;
}

export type BrowserTakeoverKeyView =
  | "enter" | "tab" | "escape" | "backspace" | "delete"
  | "arrowUp" | "arrowDown" | "arrowLeft" | "arrowRight"
  | "home" | "end" | "pageUp" | "pageDown" | "space"
  | "a" | "b" | "c" | "d" | "e" | "f" | "g" | "h" | "i" | "j" | "k" | "l" | "m"
  | "n" | "o" | "p" | "q" | "r" | "s" | "t" | "u" | "v" | "w" | "x" | "y" | "z"
  | "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";

export type BrowserTakeoverKeyModifierView = "alt" | "control" | "meta" | "shift";

export type BrowserTakeoverActionView =
  | { readonly kind: "mouseClick"; readonly normalizedX: number; readonly normalizedY: number; readonly button: "primary" | "middle" | "secondary"; readonly clickCount?: 1 | 2 }
  | { readonly kind: "mouseMove"; readonly normalizedX: number; readonly normalizedY: number }
  | { readonly kind: "mouseDrag"; readonly startNormalizedX: number; readonly startNormalizedY: number; readonly endNormalizedX: number; readonly endNormalizedY: number; readonly button: "primary" | "middle" | "secondary" }
  | { readonly kind: "scroll"; readonly deltaXCssPixels: number; readonly deltaYCssPixels: number }
  | { readonly kind: "keyPress"; readonly key: BrowserTakeoverKeyView; readonly modifiers?: readonly BrowserTakeoverKeyModifierView[] }
  | { readonly kind: "textInput"; readonly text: string }
  | { readonly kind: "navigate"; readonly url: string }
  | { readonly kind: "navigationCommand"; readonly command: "back" | "forward" | "reload" | "stop" };

export interface BrowserPageView {
  readonly id: string;
  /** Owning Session for human-opened pages; absent for global tool pages. */
  readonly sessionId?: string;
  readonly title: string;
  readonly url: string;
  readonly state: "loading" | "ready" | "crashed" | "closed";
  readonly screenshotBlobId?: string;
  readonly lastActivityAt?: number;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly recoverable: boolean;
  readonly lastKnownGeneration: bigint;
}

export interface BrowserActivityView {
  readonly id: string;
  readonly pageId: string;
  readonly toolCallId?: string;
  readonly kind: "navigation" | "interaction" | "screenshot" | "upload" | "download" | "login" | "takeover" | "recovery" | "unknown";
  readonly description: string;
  readonly occurredAt: number;
}

export interface BrowserTransferView {
  readonly id: string;
  readonly browserId: string;
  readonly pageId: string;
  readonly toolCallId?: string;
  readonly direction: "upload" | "download" | "unknown";
  readonly state: "pending" | "running" | "completed" | "failed" | "cancelled";
  readonly blobId?: string;
  readonly artifactId?: string;
  readonly fileName: string;
  readonly mediaType: string;
  readonly byteSize: number;
  readonly startedAt: number;
  readonly completedAt?: number;
  readonly error?: string;
}

export type ResourceKindView = "extension" | "skill" | "prompt" | "theme" | "package";
export type ResourceCompatibilityView = "supported" | "partial" | "unsupported" | "unknown";
export type ResourceCompatibilityIssueView =
  | "workingIndicator"
  | "widgetComponent"
  | "editorIntegration"
  | "terminalLayout"
  | "customUi"
  | "themeControl"
  | "terminalInput"
  | "terminalRendering"
  | "cliFlags"
  | "analysisIncomplete"
  | "unknown";
export type ResourceUiApiView =
  | "select"
  | "confirm"
  | "input"
  | "editor"
  | "notify"
  | "setStatus"
  | "setWorkingMessage"
  | "setWorkingVisible"
  | "setWorkingIndicator"
  | "setHiddenThinkingLabel"
  | "setWidget"
  | "setTitle"
  | "setEditorText"
  | "getEditorText"
  | "pasteToEditor"
  | "getEditorComponent"
  | "addAutocompleteProvider"
  | "setEditorComponent"
  | "setFooter"
  | "setHeader"
  | "setToolsExpanded"
  | "getToolsExpanded"
  | "custom"
  | "getAllThemes"
  | "getTheme"
  | "setTheme"
  | "theme"
  | "onTerminalInput"
  | "registerShortcut"
  | "registerFlag"
  | "registerMessageRenderer"
  | "registerMarkdownTransformer"
  | "registerEntryRenderer"
  | "unknown";
export interface ResourceCompatibilityDetailView {
  readonly kind: ResourceKindView;
  readonly name: string;
  readonly compatibility: ResourceCompatibilityView;
  readonly issues: readonly ResourceCompatibilityIssueView[];
  readonly detectedApis: readonly ResourceUiApiView[];
  readonly adaptedApis: readonly ResourceUiApiView[];
  readonly unsupportedApis: readonly ResourceUiApiView[];
}
export interface ResourceRuntimeRequirementView {
  readonly packageName: string;
  readonly range: string;
  readonly currentVersion?: string;
  readonly status: "compatible" | "incompatible" | "unknown";
}
export type ResourcePackageWarningView = "noResources" | "inspectionFailed" | "inspectionLimit" | "lifecycleScriptsDisabled" | "unknown";

export interface ResourceView {
  readonly id: string;
  readonly backendId: string;
  readonly targetId?: string;
  readonly name: string;
  readonly version?: string;
  readonly kind: ResourceKindView;
  readonly scope: "user" | "global" | "project" | "managed";
  readonly state: "discovered" | "awaitingApproval" | "approved" | "installing" | "installed" | "loaded" | "disabled" | "updateAvailable" | "error" | "removed";
  readonly enabled: boolean;
  readonly source: string;
  readonly discoveredRevision: string;
  readonly compatibilityDetails: readonly ResourceCompatibilityDetailView[];
  readonly runtimeRequirements: readonly ResourceRuntimeRequirementView[];
  readonly warnings: readonly ResourcePackageWarningView[];
  readonly disabledLifecycleScripts: readonly string[];
  readonly canToggle: boolean;
  readonly requiresExtensionApproval: boolean;
  readonly extensionContentFingerprint?: string;
  readonly postMutationNotice: boolean;
  readonly error?: string;
}

export type SkillScopeView = "global" | "project";

export interface SkillDescriptorView {
  readonly id: string;
  readonly backendId: string;
  readonly targetId?: string;
  readonly scope: SkillScopeView;
  readonly name: string;
  /** Path-free basename or package label supplied by the service. */
  readonly sourceLabel: string;
  readonly state: ResourceView["state"];
  readonly enabled: boolean;
  readonly canToggle: boolean;
  readonly contentAvailable: boolean;
  readonly canEdit: boolean;
  readonly canDelete: boolean;
  readonly revision: bigint;
  readonly approvedRevision: string;
  readonly updatedAt: number;
}

export interface SkillCatalogView {
  readonly revision: bigint;
  readonly skills: readonly SkillDescriptorView[];
}

export interface SkillMetadataView {
  readonly name?: string;
  readonly description?: string;
  readonly version?: string;
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly parseError?: string;
}

export interface SkillFileEntryView {
  readonly key: string;
  readonly name: string;
  readonly kind: "directory" | "file";
  readonly size: number;
  readonly editable: boolean;
}

export interface SkillFileContentView {
  readonly key: string;
  readonly content: string;
  readonly revision: string;
  readonly size: number;
  readonly editable: boolean;
}

export interface SkillDiffChangeView {
  readonly key: string;
  readonly kind: "added" | "modified" | "deleted";
  readonly binary: boolean;
  readonly unifiedDiff?: string;
}

export interface SkillDiffView {
  readonly available: boolean;
  readonly reason?: string;
  readonly changes: readonly SkillDiffChangeView[];
  readonly truncated: boolean;
}

export interface SkillSessionView {
  readonly id: string;
  readonly skill: SkillDescriptorView;
  readonly observedRevision: string;
  readonly dirty: boolean;
  readonly baselineAvailable: boolean;
  readonly metadata: SkillMetadataView;
  readonly files: readonly SkillFileEntryView[];
  readonly fileCount: number;
  readonly bytes: number;
  readonly diff: SkillDiffView;
  readonly expiresAt: number;
}

export type ResourceUsageSourceView =
  | "structuredResourceMention"
  | "nativeSkillCommand"
  | "runtimeConfirmedResourceLoad"
  | "exactFileRead"
  | "runtimeToolCall";

export interface ResourceUsageMetricsView {
  readonly samples: number;
  readonly strongActive: number;
  readonly semiActive: number;
  readonly passiveExposures: number;
  readonly reads: number;
  readonly rereads: number;
  readonly toolCalls: number;
  readonly toolErrors: number;
  readonly commands: number;
  readonly commandFailures: number;
  readonly latestUsedAt?: number;
}

export interface ResourceUsageVersionIdentityView {
  readonly resourceRevision: bigint;
  readonly contentRevision: string;
  readonly version?: string;
}

export interface ResourceUsageVersionBreakdownView {
  readonly identity: ResourceUsageVersionIdentityView;
  readonly metrics: ResourceUsageMetricsView;
  readonly firstUsedAt?: number;
}

export interface ResourceUsageReportView {
  readonly resourceId: string;
  readonly timeZone: string;
  readonly fromDay: string;
  readonly throughDay: string;
  readonly days: readonly {
    readonly localDay: string;
    readonly metrics: ResourceUsageMetricsView;
  }[];
  readonly totals: ResourceUsageMetricsView;
  readonly sources: readonly {
    readonly source: ResourceUsageSourceView;
    readonly metrics: ResourceUsageMetricsView;
  }[];
  readonly agents: readonly {
    readonly backendId: string;
    readonly metrics: ResourceUsageMetricsView;
  }[];
  readonly versions: readonly ResourceUsageVersionBreakdownView[];
  readonly comparison: {
    readonly available: boolean;
    readonly minimumSamples: number;
    readonly unavailableReason?: "noCurrentVersion" | "noPreviousVersion" | "currentSamples" | "previousSamples";
    readonly current?: ResourceUsageVersionBreakdownView;
    readonly previous?: ResourceUsageVersionBreakdownView;
  };
  readonly projection: {
    readonly complete: boolean;
    readonly streamCount: number;
    readonly pendingStreamCount: number;
    readonly lastProjectedAt?: number;
    readonly failures: readonly {
      readonly sessionId: string;
      readonly source: ResourceUsageSourceView;
      readonly attempts: number;
      readonly retryAt: number;
      readonly errorCode: string;
    }[];
  };
}

export interface SkillDraftView {
  readonly id: string;
  readonly sessionId: string;
  readonly skillId: string;
  readonly kind: "edit" | "rename";
  readonly name: string;
  readonly resourceRevision: bigint;
  readonly observedRevision: string;
  readonly changes: readonly SkillDiffChangeView[];
  readonly expiresAt: number;
}

export interface SkillRecoveryView {
  readonly id: string;
  readonly skillId: string;
  readonly backendId: string;
  readonly targetId?: string;
  readonly scope: SkillScopeView;
  readonly name: string;
  readonly revision: string;
  readonly files: number;
  readonly bytes: number;
  readonly createdAt: number;
  readonly status: "ready" | "missing";
}

export interface SkillMutationResultView {
  readonly skill?: SkillDescriptorView;
  readonly replacedSkillId?: string;
  readonly recoveryId?: string;
}

export type SkillMarketSourceDraft =
  | { readonly kind: "local"; readonly serverPath: string }
  | { readonly kind: "git"; readonly repositoryUrl: string; readonly ref?: string; readonly sparsePaths: readonly string[] };

export interface SkillMarketGitPreflightView {
  readonly available: boolean;
  readonly version?: string;
  readonly minimumVersion: string;
}

/** Path-free market source projection. Source locations are write-only. */
export interface SkillMarketSourceView {
  readonly id: string;
  readonly revision: bigint;
  readonly kind: "local" | "git";
  readonly display: string;
  readonly name: string;
  readonly displayName?: string;
  readonly state: "ready" | "error";
  readonly contentRevision: string;
  readonly entryCount: number;
  readonly addedAt: number;
  readonly refreshedAt?: number;
  readonly error?: string;
}

export interface SkillMarketSourceCatalogView {
  readonly revision: bigint;
  readonly sources: readonly SkillMarketSourceView[];
  readonly recoveredFromCorruption: boolean;
}

export interface SkillMarketEntryIdentityView {
  readonly sourceId: string;
  readonly sourceRevision: bigint;
  readonly entryId: string;
  readonly entryRevision: bigint;
  readonly contentRevision: string;
}

export type CollaborationScopeKindView = "team" | "department";
export type CollaborationRoleView = "viewer" | "publisher" | "administrator";

export interface CollaborationActorView {
  readonly id: string;
  readonly displayName: string;
}

export interface CollaborationMembershipView {
  readonly actorId: string;
  readonly role: CollaborationRoleView;
}

export interface CollaborationScopeView {
  readonly id: string;
  readonly revision: bigint;
  readonly kind: CollaborationScopeKindView;
  readonly name: string;
  readonly members: readonly CollaborationMembershipView[];
}

export interface CollaborationDirectoryView {
  readonly available: boolean;
  readonly revision: bigint;
  readonly actor?: CollaborationActorView;
  readonly scopes: readonly CollaborationScopeView[];
  readonly recoveredFromCorruption: boolean;
  readonly unavailableReason?: string;
}

export type SkillAccessPublisherView =
  | { readonly kind: "personal"; readonly actorId: string }
  | { readonly kind: "team"; readonly scopeId: string }
  | { readonly kind: "external"; readonly sourceId: string };

export interface SkillAccessPolicyView {
  readonly revision: bigint;
  readonly publisher: SkillAccessPublisherView;
  readonly visibility: "public" | "department" | "private";
  readonly audienceScopeIds: readonly string[];
}

export interface SkillPublicationAccessSelectionView {
  readonly publisher: "personal" | "team";
  readonly publisherScopeId?: string;
  readonly visibility: "public" | "department" | "private";
  readonly audienceScopeIds: readonly string[];
}

export interface SkillMarketEntryView {
  readonly identity: SkillMarketEntryIdentityView;
  readonly slug: string;
  readonly name: string;
  readonly author?: string;
  readonly description: string;
  readonly category?: string;
  readonly tags: readonly string[];
  readonly version: string;
  readonly changelog?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly downloads: number;
  readonly trendScore: number;
  readonly archiveBytes: number;
  readonly sourceName: string;
  readonly sourceDisplayName?: string;
  readonly sourceState: "ready" | "error";
  readonly sourceError?: string;
  readonly installStatuses: readonly SkillMarketInstallStatusView[];
  readonly access: SkillAccessPolicyView;
  readonly canManage: boolean;
}

export interface SkillMarketInstallStatusView {
  readonly resourceId: string;
  readonly resourceRevision: bigint;
  readonly backendId: string;
  readonly targetId?: string;
  readonly scope: SkillScopeView;
  readonly relativeParent?: string;
  readonly state: "installed" | "updateAvailable" | "conflict";
  readonly installedVersion?: string;
}

export type SkillMarketSortView = "trending" | "downloads" | "updated" | "created";

export interface SkillMarketCatalogPageView {
  readonly revision: bigint;
  readonly entries: readonly SkillMarketEntryView[];
  readonly categories: readonly string[];
  readonly sourceCount: number;
  readonly totalSize: number;
  readonly nextPageToken?: string;
}

export interface SkillMarketArchiveEntryView {
  readonly key: string;
  readonly kind: "directory" | "file";
  readonly size: number;
}

export interface SkillMarketArchivePageView {
  readonly snapshotRevision: string;
  readonly files: readonly SkillMarketArchiveEntryView[];
  readonly totalSize: number;
  readonly nextPageToken?: string;
}

export interface SkillMarketPreviewView {
  readonly id: string;
  readonly entry: SkillMarketEntryView;
  readonly snapshotRevision: string;
  readonly files: number;
  readonly bytes: number;
  readonly expiresAt: number;
}

export interface SkillMarketPreviewFileView {
  readonly previewId: string;
  readonly snapshotRevision: string;
  readonly key: string;
  readonly size: number;
  readonly previewable: boolean;
  readonly content?: string;
  readonly unavailableReason?: "binary" | "tooLarge";
}

export interface SkillMarketInstallTargetView {
  readonly backendId: string;
  readonly scope: SkillScopeView;
  readonly targetId?: string;
  readonly relativeParent?: string;
}

export interface SkillMarketCurrentResourceView {
  readonly resourceId: string;
  readonly resourceRevision: bigint;
  readonly name: string;
  readonly version?: string;
  readonly sourceKind: "local" | "npm" | "git" | "extensionSource" | "skillMarket";
  readonly sourceDisplay: string;
  readonly discoveredRevision: string;
  readonly observedRevision: string;
  readonly dirty: boolean;
}

export type SkillMarketInstallActionView = "install" | "update" | "replace";
export type SkillMarketInstallConfirmationReasonView =
  | "sourceReplacement"
  | "localOwnership"
  | "dirtyContent"
  | "unregisteredDestination"
  | "downgrade";

export interface SkillMarketInstallPreviewView {
  readonly action: SkillMarketInstallActionView;
  readonly resourceId: string;
  readonly target: SkillMarketInstallTargetView;
  readonly name: string;
  readonly availableVersion: string;
  readonly candidateRevision: string;
  readonly files: number;
  readonly bytes: number;
  readonly currentResource?: SkillMarketCurrentResourceView;
  readonly unregisteredDestination: boolean;
  readonly sourceReplacement: boolean;
  readonly preservesEnabled: boolean;
  readonly diffAvailable: boolean;
  readonly diffReason?: string;
  readonly changes: readonly SkillDiffChangeView[];
  readonly diffTruncated: boolean;
}

export interface SkillMarketInstallPlanView {
  readonly id: string;
  readonly entry: SkillMarketEntryView;
  readonly target: SkillMarketInstallTargetView;
  readonly preview: SkillMarketInstallPreviewView;
  readonly confirmationReasons: readonly SkillMarketInstallConfirmationReasonView[];
  readonly requiresConfirmation: boolean;
  readonly expiresAt: number;
}

export interface SkillMarketSyncTargetView extends SkillMarketInstallTargetView {
  readonly targetRevision?: bigint;
}

export interface SkillMarketSyncBaselineView {
  readonly resourceRevision: bigint;
  readonly resourceContentRevision: string;
  readonly installedContentRevision: string;
  readonly installedVersion: string;
  readonly sourceRevision: bigint;
  readonly entryRevision: bigint;
  readonly entryContentRevision: string;
}

export interface SkillMarketSyncPolicyView {
  readonly resourceId: string;
  readonly revision: bigint;
  readonly enabled: boolean;
  readonly sourceId: string;
  readonly entryId: string;
  readonly target: SkillMarketSyncTargetView;
  readonly baseline: SkillMarketSyncBaselineView;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly disabledReason?: string;
}

export type SkillMarketSyncJobStateView =
  | "pendingRevalidation"
  | "running"
  | "cancelling"
  | "succeeded"
  | "upToDate"
  | "blocked"
  | "failed"
  | "cancelled";

export type SkillMarketSyncOutcomeView =
  | "updated"
  | "alreadyCurrent"
  | "downgradeBlocked"
  | "dirtyContent"
  | "ownerChanged"
  | "targetChanged"
  | "resourceRemoved"
  | "cancelled";

export interface SkillMarketSyncJobAuthorityView {
  readonly sourceId: string;
  readonly entryId: string;
  readonly target: SkillMarketSyncTargetView;
  readonly baseline: SkillMarketSyncBaselineView;
}

export interface SkillMarketSyncJobView {
  readonly id: string;
  readonly revision: bigint;
  readonly state: SkillMarketSyncJobStateView;
  readonly policyResourceId: string;
  readonly policyRevision: bigint;
  readonly authority: SkillMarketSyncJobAuthorityView;
  readonly attempt: number;
  readonly retryOfJobId?: string;
  readonly availableVersion?: string;
  readonly outcome?: SkillMarketSyncOutcomeView;
  readonly error?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt?: number;
}

export interface SkillMarketSyncCatalogView<T> {
  readonly items: readonly T[];
  readonly recoveredFromCorruption: boolean;
}

export interface SkillPublicationMetadataView {
  readonly slug: string;
  readonly name: string;
  readonly author?: string;
  readonly description: string;
  readonly category?: string;
  readonly tags: readonly string[];
  readonly version: string;
  readonly changelog?: string;
}

export interface SkillPublicationAuthorityView {
  readonly resourceId: string;
  readonly resourceRevision: bigint;
  readonly observedRevision: string;
  readonly backendId: string;
  readonly targetId?: string;
  readonly scope: SkillScopeView;
  readonly sourceId: string;
  readonly sourceRevision: bigint;
  readonly sourceContentRevision: string;
  readonly sourceDisplay: string;
  readonly existingEntryId?: string;
}

export interface SkillPublicationGateIssueView {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export interface SkillPublicationGateView {
  readonly id: "metadata" | "package" | "sensitive_content" | "source_authority";
  readonly label: string;
  readonly status: "pending" | "passed" | "blocked";
  readonly issues: readonly SkillPublicationGateIssueView[];
}

export interface SkillPublicationResultView {
  readonly sourceId: string;
  readonly sourceRevision: bigint;
  readonly entryId: string;
  readonly entryRevision: bigint;
  readonly entryContentRevision: string;
  readonly version: string;
}

export type SkillPublicationStateView =
  | "pending"
  | "snapshotting"
  | "packaging"
  | "scanning"
  | "committing"
  | "reconciling"
  | "cancelling"
  | "published"
  | "blocked"
  | "failed"
  | "cancelled";

export interface SkillPublicationJobView {
  readonly id: string;
  readonly revision: bigint;
  readonly state: SkillPublicationStateView;
  readonly authority: SkillPublicationAuthorityView;
  readonly metadata: SkillPublicationMetadataView;
  readonly publisher: "personal" | "team";
  readonly publisherScopeId?: string;
  readonly visibility: "public" | "department" | "private";
  readonly audienceScopeIds: readonly string[];
  readonly accessRevision: bigint;
  readonly gates: readonly SkillPublicationGateView[];
  readonly verdict: "pending" | "passed" | "blocked";
  readonly files: number;
  readonly uncompressedBytes: number;
  readonly archiveBytes: number;
  readonly attempt: number;
  readonly retryOfJobId?: string;
  readonly result?: SkillPublicationResultView;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt?: number;
  readonly error?: string;
  readonly cancellable: boolean;
}

export interface SkillPublicationPreviewView {
  readonly authority: SkillPublicationAuthorityView;
  readonly source: SkillMarketSourceView;
  readonly mode: "first" | "version";
  readonly suggestedSlug: string;
  readonly suggestedVersion: string;
  readonly existingEntry?: SkillMarketEntryView;
  readonly dirty: boolean;
  readonly collaborationRevision: bigint;
  readonly personalPublisherAvailable: boolean;
  readonly teamPublisherAvailable: boolean;
  readonly publicVisibilityAvailable: boolean;
  readonly departmentVisibilityAvailable: boolean;
  readonly privateVisibilityAvailable: boolean;
  readonly collaborationUnavailableReason?: string;
}

/** Exact loaded resource identity owned by one live task runtime. */
export interface SessionResourceView {
  readonly sessionId: string;
  readonly id: string;
  readonly name: string;
  readonly version?: string;
  readonly kind: Exclude<ResourceKindView, "theme">;
  readonly discoveredRevision: string;
  readonly resourceVersion: string;
  readonly runtimeGeneration: number;
}

export type ResourceAcquisitionDraft =
  | {
      readonly kind: "local";
      readonly serverPath: string;
    }
  | {
      readonly kind: "npm";
      readonly packageName: string;
      readonly versionSpec: string;
    }
  | {
      readonly kind: "git";
      readonly repositoryUrl: string;
      readonly ref: string;
      readonly subdirectory: string;
    };

export interface ResourceDraft {
  readonly backendId: string;
  readonly targetId?: string;
  readonly kind: ResourceView["kind"];
  readonly scope: ResourceView["scope"];
  readonly source: ResourceAcquisitionDraft;
  readonly name: string;
  readonly version: string;
}

export interface RuntimeCommandView {
  readonly id: string;
  readonly sessionId?: string;
  readonly name: string;
  readonly description: string;
  readonly source: "extension" | "prompt" | "skill" | "backend" | "unknown";
  readonly resourceId?: string;
  readonly loaded: boolean;
}

export type RuntimeToolFieldTypeView = "string" | "number" | "integer" | "boolean" | "object" | "array" | "blob" | "unknown";

export interface RuntimeToolInputFieldView {
  readonly path: string;
  readonly title: string;
  readonly description: string;
  readonly type: RuntimeToolFieldTypeView;
  readonly required: boolean;
  readonly secret: boolean;
  readonly enumValues: readonly string[];
  readonly constraints?: {
    readonly minimumLength?: number;
    readonly maximumLength?: number;
    readonly minimumNumber?: number;
    readonly maximumNumber?: number;
    readonly pattern?: string;
    readonly itemPath?: string;
  };
}

export interface RuntimeToolView {
  readonly name: string;
  readonly description: string;
  readonly resourceId?: string;
  readonly fields: readonly RuntimeToolInputFieldView[];
  readonly allowsAdditionalFields: boolean;
  readonly promptGuidelines: readonly string[];
  readonly active: boolean;
  readonly source: {
    readonly path: string;
    readonly name: string;
    readonly scope: "user" | "project" | "temporary" | "unknown";
    readonly origin: "package" | "topLevel" | "unknown";
    readonly baseDirectory?: string;
  };
}

export interface RuntimeToolCatalogView {
  readonly runtimeGeneration: bigint;
  readonly observedAt: number;
  readonly tools: readonly RuntimeToolView[];
}

export interface RemoteConnectionView {
  readonly id: string;
  readonly deviceId: string;
  readonly name: string;
  readonly state: "pairing" | "connected" | "disconnected" | "revoked" | "loggedOut";
  readonly lastSeenAt?: number;
}

export interface DeviceView {
  readonly id: string;
  readonly name: string;
  readonly kind: "web" | "desktop" | "service" | "mobile" | "unknown";
  readonly platform: string;
  readonly appVersion: string;
  readonly revoked: boolean;
  readonly remoteControlEnabled: boolean;
  readonly presence: "online" | "offline";
  readonly lastSeenAt?: number;
}

export interface DeviceControlRelationView {
  readonly id: string;
  readonly controllerDeviceId: string;
  readonly targetDeviceId: string;
  readonly outboundEnabled: boolean;
  readonly inboundAllowed: boolean;
  readonly effective: boolean;
  readonly updatedAt?: number;
  readonly revision: bigint;
}

export interface ProviderConfigurationView {
  readonly id: string;
  readonly name: string;
  readonly kind: "managed" | "apiKey" | "oauth" | "subscription" | "localKeyless" | "customEndpoint";
  readonly enabled: boolean;
  readonly revision: bigint;
  readonly runtimes: readonly ProviderRuntimeConfigurationView[];
}

export type ProviderCompatibilityView = "anthropic" | "openaiResponses" | "openaiChat" | "openaiCompletions" | "native" | "google";
export type ProviderConfigurationFieldView = "requestPath" | "modelsEndpoint" | "headers" | "keyless" | "authHeader"
  | "modelLimits" | "modelCosts" | "modelInputModalities" | "modelThinkingLevels" | "modelSampling" | "modelCompatibility" | "modelFastMode";

export interface ProviderRuntimeConfigurationView {
  readonly backendId: string;
  readonly compatibility: ProviderCompatibilityView;
  readonly endpoint: string;
  readonly credentialId: string;
  readonly keyless: boolean;
  readonly authHeader: boolean;
  readonly environmentName: string;
  readonly headers: readonly ProviderHeaderConfigurationView[];
  readonly models: readonly ProviderModelConfigurationView[];
  readonly requestPath?: string;
  readonly modelsEndpoint?: string;
  readonly credentialOrigin: string;
}

export interface ProviderHeaderConfigurationView {
  readonly headerName: string;
  readonly environmentName: string;
  readonly credentialId: string;
}

export interface ProviderThinkingLevelView {
  readonly effortId: string;
  readonly nativeLevel?: string;
}

export interface ProviderModelConfigurationView {
  readonly modelId: string;
  readonly name: string;
  readonly compatibility?: ProviderCompatibilityView;
  readonly reasoning: boolean;
  readonly inputModalities: readonly ModelInputModalityView[];
  readonly contextWindowTokens: number;
  readonly maximumOutputTokens: number;
  readonly inputCostMicrosPerMillion: number;
  readonly outputCostMicrosPerMillion: number;
  readonly cacheReadCostMicrosPerMillion: number;
  readonly cacheWriteCostMicrosPerMillion: number;
  readonly thinkingLevels: readonly ProviderThinkingLevelView[];
  readonly sampling?: ProviderSamplingConfigurationView;
  readonly compatibilityOptions?: ProviderCompatibilityConfigurationView;
  readonly supportsFastMode: boolean;
  readonly defaultVisible?: boolean;
  readonly supportsTools?: boolean;
}

export interface ProviderSamplingConfigurationView {
  readonly temperature?: number;
  readonly topP?: number;
  readonly topK?: number;
  readonly minP?: number;
  readonly repetitionPenalty?: number;
  readonly frequencyPenalty?: number;
  readonly presencePenalty?: number;
  readonly seed?: number;
}

export interface ProviderCompatibilityConfigurationView {
  readonly supportsDeveloperRole?: boolean;
  readonly supportsReasoningEffort?: boolean;
  readonly supportsUsageInStreaming?: boolean;
  readonly supportsFinishReason?: boolean;
  readonly requiresReasoningContentOnAssistantMessages?: boolean;
  readonly supportsStore?: boolean;
  readonly supportsStrictMode?: boolean;
  readonly supportsOpenaiGrammarTools?: boolean;
  readonly supportsEagerToolInputStreaming?: boolean;
  readonly supportsLongCacheRetention?: boolean;
  readonly supportsCacheControlOnTools?: boolean;
  readonly supportsStrictTools?: boolean;
  readonly thinkingFormat?: string;
  readonly cacheControlFormat?: string;
}

export interface ProviderRuntimeView {
  readonly backendId: string;
  readonly id: string;
  readonly name: string;
  readonly kind: ProviderConfigurationView["kind"];
  readonly accessProduct?: string;
  readonly compatibility: ProviderCompatibilityView;
  readonly authenticationState: "notRequired" | "signedOut" | "pending" | "authenticated" | "expired" | "refreshing" | "error" | "unknown";
  readonly endpoint: string;
  readonly ownerManaged: boolean;
  readonly routingEnabled?: boolean;
  readonly supportsLogin: boolean;
  readonly loginMethods: readonly ProviderLoginMethodView[];
  readonly supportsLogout: boolean;
  readonly supportsRefresh: boolean;
  readonly supportsModelRefresh?: boolean;
  readonly credentialSurfaces: readonly ProviderCredentialSurfaceView[];
  readonly capabilities: ReadonlySet<string>;
  readonly credentialExpiresAt?: number;
  readonly rateLimit?: {
    readonly limited: boolean;
    readonly resetsAt?: number;
    readonly requestLimit: number;
    readonly requestsRemaining: number;
    readonly tokenLimit: number;
    readonly tokensRemaining: number;
  };
  readonly usage?: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
    readonly cost: number;
    readonly currency: string;
    readonly periodStartedAt?: number;
    readonly periodEndedAt?: number;
    readonly measuredAt?: number;
    readonly estimated: boolean;
  };
  readonly accountUsage?: {
    readonly primaryWindow?: ProviderAccountUsageWindowView;
    readonly secondaryWindow?: ProviderAccountUsageWindowView;
    readonly limitReached?: boolean;
    readonly planType?: string;
    readonly credits?: {
      readonly hasCredits?: boolean;
      readonly unlimited?: boolean;
      readonly balance?: string;
      readonly observedAt?: number;
    };
    readonly observedAt?: number;
  };
  readonly error?: string;
}

export interface ProviderCredentialSurfaceView {
  readonly id: string;
  readonly capability: "imageGeneration";
  readonly kind: "apiKey";
  readonly configured: boolean;
  readonly models: readonly {
    readonly modelId: string;
    readonly name: string;
  }[];
}

export interface ProviderAccountUsageWindowView {
  readonly usedPercent: number;
  readonly windowMinutes?: number;
  readonly resetAt?: number;
}

export type ManagedModelRuntimeStateView =
  | "absent"
  | "stopped"
  | "starting"
  | "ready"
  | "portConflict"
  | "installing"
  | "error"
  | "unknown";

export type ManagedModelRuntimeErrorCodeView =
  | "ownerChanged"
  | "runtimeUnreachable"
  | "portConflict"
  | "unsupportedPlatform"
  | "installBusy"
  | "pullBusy"
  | "modelInvalid"
  | "modelNotFound"
  | "modelUnauthorized"
  | "modelIncompatible"
  | "diskSpaceLow"
  | "downloadRejected"
  | "downloadTooLarge"
  | "downloadTimeout"
  | "checksumMismatch"
  | "archiveRejected"
  | "startFailed"
  | "operationCancelled"
  | "runtimeError";

export interface ManagedModelRuntimePreflightView {
  readonly allowed: boolean;
  readonly memory: "sufficient" | "constrained" | "unknown";
  readonly disk: "sufficient" | "insufficient" | "unknown";
  readonly requiredDiskBytes: number;
  readonly errorCode?: ManagedModelRuntimeErrorCodeView;
}

export interface ManagedModelRuntimeCapabilitiesView {
  readonly canInstall: boolean;
  readonly canCancelInstall: boolean;
  readonly canStart: boolean;
  readonly canListModels: boolean;
  readonly canPullModels: boolean;
  readonly canDeleteModels: boolean;
  readonly canPausePulls: boolean;
  readonly canResumePulls: boolean;
  readonly canCancelPulls: boolean;
  readonly supportsCustomModels: boolean;
  readonly supportsCuratedCatalog: boolean;
  readonly supportsModelPreflight: boolean;
}

export interface ManagedModelRuntimeModelView {
  readonly name: string;
  readonly displayName: string;
  readonly sizeBytes?: number;
  readonly contextWindowTokens?: number;
  readonly supportsTools: boolean;
  readonly supportsImages: boolean;
  readonly requiredRuntimeVersion?: string;
}

export interface ManagedModelRuntimeCatalogModelView {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly sizeBytes: number;
  readonly minimumMemoryGb: number;
  readonly platformLimited: boolean;
  readonly recommended: boolean;
  readonly preflight: ManagedModelRuntimePreflightView;
}

export interface ManagedModelRuntimeTransferView {
  readonly kind: "runtimeInstall" | "modelPull";
  readonly modelName?: string;
  readonly phase: "starting" | "resolving" | "manifest" | "downloading" | "verifying" | "extracting" | "writing" | "promoting" | "success" | "paused" | "cancelled" | "error" | "unknown";
  readonly completedBytes?: number;
  readonly totalBytes?: number;
  readonly percent?: number;
  readonly bytesPerSecond?: number;
  readonly done: boolean;
  readonly errorCode?: ManagedModelRuntimeErrorCodeView;
}

export interface ManagedModelRuntimeView {
  readonly id: string;
  readonly name: string;
  readonly state: ManagedModelRuntimeStateView;
  readonly source: "running" | "application" | "cli" | "managedSidecar" | "none" | "unknown";
  readonly version?: string;
  readonly capabilities: ManagedModelRuntimeCapabilitiesView;
  readonly installPreflight: ManagedModelRuntimePreflightView;
  readonly installedModels: readonly ManagedModelRuntimeModelView[];
  readonly catalog: readonly ManagedModelRuntimeCatalogModelView[];
  readonly transfers: readonly ManagedModelRuntimeTransferView[];
  readonly errorCode?: ManagedModelRuntimeErrorCodeView;
  readonly errorMessage?: string;
  readonly revision: bigint;
}

export interface CredentialView {
  readonly id: string;
  readonly name: string;
  readonly kind: "apiKey" | "oauth" | "subscription" | "localKeyless" | "headerSecret" | "sshPrivateKey";
  readonly providerId: string;
  readonly configured: boolean;
  readonly expiresAt?: number;
  readonly lastRefreshedAt?: number;
  readonly error?: string;
}

export interface McpServerView {
  readonly id: string;
  readonly name: string;
  readonly transport: "loopback" | "https" | "sse" | "stdio";
  readonly endpoint: string;
  readonly state: "disabled" | "starting" | "connected" | "degraded" | "disconnected" | "error";
  readonly generation: bigint;
  readonly toolCount: number;
  readonly credentialIds: readonly string[];
  readonly credentialBindings: readonly McpCredentialBindingView[];
  readonly enabled: boolean;
  readonly command: string;
  readonly arguments: readonly string[];
  readonly workingDirectory: string;
  readonly environment: readonly McpEnvironmentVariableView[];
  readonly revision: bigint;
  readonly error?: string;
}

export interface McpCredentialBindingView {
  readonly credentialId: string;
  readonly target: "header" | "environment";
  readonly name: string;
  readonly configured: boolean;
}

export interface McpEnvironmentVariableView {
  readonly name: string;
  readonly value: string;
}

export interface ExtensionCatalogEntryView {
  readonly id: string;
  readonly revision: bigint;
  readonly owner:
    | { readonly kind: "resource"; readonly resourceId: string; readonly discoveredRevision: string; readonly resourceRevision: bigint }
    | { readonly kind: "mcp"; readonly serverId: string; readonly serverRevision: bigint }
    | {
        readonly kind: "source";
        readonly sourceId: string;
        readonly sourceRevision: bigint;
        readonly entryId: string;
        readonly contentRevision: string;
      };
  readonly source: "local" | "market";
  readonly installed: boolean;
  readonly installState: "available" | "installing" | "installed" | "updateAvailable" | "error";
  readonly name: string;
  readonly version?: string;
  readonly author?: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly mainView?: {
    readonly title?: string;
    readonly icon?: ExtensionMainViewIconView;
  };
  readonly library?: { readonly schemaVersion: 1 };
  readonly sidebarSupported: boolean;
  readonly sidebarVisible: boolean;
  readonly tools: readonly { readonly name: string; readonly description: string; readonly requiresPermission: boolean }[];
  readonly permissions: readonly {
    readonly id: string;
    readonly label: string;
    readonly description: string;
    readonly required: boolean;
    readonly granted: boolean;
  }[];
  readonly commands: readonly { readonly name: string; readonly description: string; readonly sessionId: string }[];
  readonly setup: {
    readonly state: "notRequired" | "required" | "inProgress" | "ready" | "cancelled" | "failed";
    readonly attemptId?: string;
    readonly revision: bigint;
    readonly fields: readonly {
      readonly id: string;
      readonly label: string;
      readonly description: string;
      readonly kind: "text" | "secret" | "oauth" | "confirmation";
      readonly required: boolean;
      readonly configured: boolean;
      readonly options: readonly string[];
    }[];
    readonly error?: string;
  };
  readonly update?: {
    readonly source: Extract<ExtensionCatalogEntryView["owner"], { readonly kind: "source" }>;
    readonly availableVersion?: string;
    readonly sourceReplacement: boolean;
  };
  readonly useSupported: boolean;
  readonly error?: string;
}

export type ExtensionMainViewIconView =
  | "activity"
  | "box"
  | "code"
  | "fileText"
  | "globe"
  | "layout"
  | "search"
  | "sparkles"
  | "terminal"
  | "tool";

export interface ExtensionMainViewSurfaceView {
  readonly id: string;
  readonly extensionId: string;
  readonly owner: Extract<ExtensionCatalogEntryView["owner"], { readonly kind: "resource" }>;
  readonly backendId: string;
  readonly backendRevision: bigint;
  readonly backendGeneration: number;
  /** Same-origin, opaque surface URL; never persisted as Extension identity. */
  readonly endpoint: string;
  readonly title?: string;
  readonly icon?: ExtensionMainViewIconView;
  readonly expiresAt: number;
}

export type ExtensionLibraryStateView = "ready" | "readOnly" | "unavailable";
export type ExtensionLibraryUnavailableReasonView =
  | "metadataCorrupt"
  | "fileLimit"
  | "io"
  | "operationInProgress"
  | "diskMissing"
  | "bindingMoved"
  | "stateCorrupt";

export interface ExtensionLibraryLocationView {
  readonly kind: "default" | "custom";
  /** Trusted management display only; never forwarded to an Extension frame. */
  readonly path: string;
  readonly generation: bigint;
}

export interface ExtensionLibraryOverviewView {
  readonly extensionId: string;
  readonly name: string;
  readonly state: ExtensionLibraryStateView;
  readonly unavailableReason?: ExtensionLibraryUnavailableReasonView;
  readonly location?: ExtensionLibraryLocationView;
  readonly files: number;
  readonly bytes: bigint;
  readonly diskFreeBytes?: bigint;
  readonly softLimitBytes: bigint;
  readonly softLimitExceeded: boolean;
  readonly orphaned: boolean;
  readonly trashCount: number;
  readonly graceCount: number;
  readonly operation?: { readonly id: string; readonly phase: string };
}

export interface ExtensionLibraryLocationValidationView {
  readonly libraryRoot: string;
  readonly warnings: readonly string[];
  readonly diskFreeBytes?: bigint;
}

export interface ExtensionLibrarySessionView {
  readonly id: string;
  readonly extensionId: string;
  readonly expiresAt: number;
  readonly bindingGeneration: bigint;
  readonly limits: {
    readonly maximumReadBytes: bigint;
    readonly maximumWriteBytes: bigint;
    readonly maximumStreamBytes: bigint;
    readonly maximumPathCharacters: number;
    readonly maximumPathSegments: number;
    readonly maximumListPageSize: number;
    readonly maximumFiles: number;
    readonly softLimitBytes: bigint;
    readonly diskReserveBytes: bigint;
  };
}

export interface ExtensionLibraryEntryView {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly bytes: bigint;
  readonly modifiedAt: number;
}

export type ExtensionLibrarySqlValueView =
  | { readonly kind: "null" }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "integer"; readonly value: bigint }
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "blob"; readonly value: Uint8Array };

export interface ExtensionLibrarySqlStatementView {
  readonly sql: string;
  readonly parameters?: readonly ExtensionLibrarySqlValueView[];
}

export type ExtensionLibraryCallView =
  | { readonly kind: "read"; readonly path: string; readonly offset?: bigint; readonly length?: bigint }
  | { readonly kind: "write"; readonly path: string; readonly content: Uint8Array; readonly ifNotExists?: boolean }
  | { readonly kind: "stat"; readonly path: string }
  | { readonly kind: "list"; readonly path?: string; readonly recursive?: boolean; readonly limit?: number; readonly cursor?: string }
  | { readonly kind: "mkdir"; readonly path: string }
  | { readonly kind: "delete"; readonly path: string; readonly recursive?: boolean }
  | { readonly kind: "rename"; readonly from: string; readonly to: string; readonly overwrite?: boolean }
  | { readonly kind: "writeBegin"; readonly path: string; readonly totalBytes: bigint; readonly sha256?: string; readonly ifNotExists?: boolean }
  | { readonly kind: "writeChunk"; readonly streamId: string; readonly sequence: number; readonly content: Uint8Array }
  | { readonly kind: "writeCommit"; readonly streamId: string }
  | { readonly kind: "writeAbort"; readonly streamId: string }
  | { readonly kind: "sqlOpen"; readonly path: string; readonly create?: boolean; readonly readOnly?: boolean }
  | { readonly kind: "sqlExecute"; readonly handleId: string; readonly statement: ExtensionLibrarySqlStatementView }
  | { readonly kind: "sqlBatch"; readonly handleId: string; readonly statements: readonly ExtensionLibrarySqlStatementView[] }
  | { readonly kind: "sqlMigrate"; readonly handleId: string; readonly migrations: readonly { readonly version: number; readonly statements: readonly string[] }[] }
  | { readonly kind: "sqlBackup"; readonly handleId: string; readonly targetPath: string }
  | { readonly kind: "sqlCheck" | "sqlClose"; readonly handleId: string };

export interface ExtensionLibrarySqlResultView {
  readonly rows: readonly { readonly cells: readonly { readonly name: string; readonly value: ExtensionLibrarySqlValueView }[] }[];
  readonly changes: bigint;
  readonly lastInsertRowId?: bigint;
}

export type ExtensionLibraryCallResultView =
  | { readonly kind: "read"; readonly path: string; readonly content: Uint8Array; readonly sha256: string }
  | { readonly kind: "write"; readonly path: string; readonly bytes: bigint; readonly sha256: string }
  | { readonly kind: "stat"; readonly entry: ExtensionLibraryEntryView }
  | { readonly kind: "list"; readonly entries: readonly ExtensionLibraryEntryView[]; readonly nextCursor?: string }
  | { readonly kind: "path"; readonly path: string; readonly existed: boolean }
  | { readonly kind: "rename"; readonly from: string; readonly to: string }
  | { readonly kind: "stream"; readonly streamId: string; readonly receivedBytes: bigint; readonly nextSequence: number; readonly expiresAt?: number; readonly aborted: boolean }
  | { readonly kind: "sqlHandle"; readonly handleId: string; readonly path: string; readonly readOnly: boolean; readonly userVersion: number }
  | { readonly kind: "sqlResult"; readonly value: ExtensionLibrarySqlResultView }
  | { readonly kind: "sqlBatch"; readonly results: readonly ExtensionLibrarySqlResultView[] }
  | { readonly kind: "sqlVersion"; readonly userVersion: number; readonly path?: string }
  | { readonly kind: "boolean"; readonly value: boolean };

export interface ExtensionLibraryTrashEntryView {
  readonly id: string;
  readonly extensionId: string;
  readonly name: string;
  readonly deletedAt: number;
  readonly expiresAt: number;
  readonly files: number;
  readonly bytes: bigint;
}

export interface ExtensionLibraryGraceEntryView {
  readonly id: string;
  readonly extensionId: string;
  readonly name: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly files: number;
  readonly bytes: bigint;
}

export type ExtensionPackageActionView = "install" | "update" | "replace";

export interface ExtensionPackagePreviewView {
  readonly extensionId: string;
  readonly extensionRevision: bigint;
  readonly action: ExtensionPackageActionView;
  readonly resourceId: string;
  readonly backendId: string;
  readonly packageName: string;
  readonly installedVersion?: string;
  readonly availableVersion?: string;
  readonly currentResource?: {
    readonly resourceId: string;
    readonly resourceRevision: bigint;
    readonly name: string;
    readonly sourceDisplay: string;
  };
  readonly sourceReplacement: boolean;
  readonly preservesEnabled: boolean;
  readonly compatibilityDetails: readonly ResourceCompatibilityDetailView[];
  readonly runtimeRequirements: readonly ResourceRuntimeRequirementView[];
  readonly warnings: readonly ResourcePackageWarningView[];
  readonly disabledLifecycleScripts: readonly string[];
  readonly canToggle: boolean;
}

export type ExtensionPackageExportStateView =
  | "pending"
  | "snapshotting"
  | "packaging"
  | "verifying"
  | "ready"
  | "failed"
  | "cancelled";

export interface ExtensionPackageExportAuthorityView {
  readonly extensionId: string;
  readonly extensionRevision: bigint;
  readonly resourceId: string;
  readonly resourceRevision: bigint;
  readonly discoveredRevision: string;
  readonly backendId: string;
  readonly backendRevision: bigint;
  readonly backendGeneration: number;
  readonly packageName: string;
  readonly packageVersion?: string;
}

export interface ExtensionPackageExportArtifactView {
  readonly blobId: string;
  readonly sha256: string;
  readonly byteSize: number;
  readonly mediaType: string;
  readonly fileName: string;
}

export interface ExtensionPackageExportJobView {
  readonly id: string;
  readonly revision: bigint;
  readonly state: ExtensionPackageExportStateView;
  readonly authority: ExtensionPackageExportAuthorityView;
  readonly archiveFormat: "npm-tar-gzip";
  readonly fileName: string;
  readonly files: number;
  readonly uncompressedBytes: number;
  readonly artifact?: ExtensionPackageExportArtifactView;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt?: number;
  readonly error?: string;
}

export interface ExtensionPackageExportPreviewView extends ExtensionPackageExportAuthorityView {
  readonly archiveFormat: "npm-tar-gzip";
  readonly fileName: string;
  readonly maximumEntries: number;
  readonly maximumUncompressedBytes: number;
  readonly localOnly: true;
  readonly activeExport?: ExtensionPackageExportJobView;
  readonly recoveredFromCorruption: boolean;
}

export interface ExtensionPackageExportCatalogView {
  readonly exports: readonly ExtensionPackageExportJobView[];
  readonly recoveredFromCorruption: boolean;
}

export interface ExtensionCatalogView {
  readonly revision: bigint;
  readonly extensions: readonly ExtensionCatalogEntryView[];
  readonly recoveredFromCorruption: boolean;
}

export interface ExtensionSourceView {
  readonly id: string;
  readonly revision: bigint;
  readonly kind: "local" | "git";
  readonly location:
    | { readonly kind: "local"; readonly path: string }
    | { readonly kind: "git"; readonly repositoryUrl: string; readonly ref?: string; readonly sparsePaths: readonly string[] };
  readonly name: string;
  readonly displayName?: string;
  readonly state: "ready" | "error";
  readonly contentRevision: string;
  readonly discoveredExtensionCount: number;
  readonly declaredEntryCount: number;
  readonly skippedEntryCount: number;
  readonly unreadableEntryCount: number;
  readonly addedAt: number;
  readonly refreshedAt?: number;
  readonly error?: string;
}

export interface ExtensionSourceCatalogView {
  readonly revision: bigint;
  readonly sources: readonly ExtensionSourceView[];
  readonly recoveredFromCorruption: boolean;
}

export interface ExtensionSourceGitPreflightView {
  readonly available: boolean;
  readonly version?: string;
  readonly minimumVersion: string;
}

export type ExtensionSourceDraft =
  | { readonly kind: "local"; readonly path: string }
  | { readonly kind: "git"; readonly repositoryUrl: string; readonly ref?: string; readonly sparsePaths: readonly string[] };

/** Owner-scoped, one-shot handoff from Extension detail to the delayed-create
 * composer. The command remains fenced to the exact catalog projection that
 * advertised it; it is never inferred again from a display name. */
export interface PendingExtensionUseView {
  readonly extensionId: string;
  readonly extensionRevision: string;
  readonly commandName: string;
  readonly runtimeSessionId: string;
  readonly displayName: string;
  readonly owner:
    | { readonly kind: "resource"; readonly resourceId: string; readonly discoveredRevision: string; readonly resourceRevision: string }
    | { readonly kind: "mcp"; readonly serverId: string; readonly serverRevision: string };
}

export interface BrowserSettingsView {
  readonly browserProviderId: string;
  readonly targetSettings: readonly BrowserTargetSettingsView[];
  readonly backendHealth: BrowserBackendHealthView;
  readonly profileDisplayName: string;
  readonly takeoverTimeoutSeconds: number;
  readonly allowUploads: boolean;
  readonly allowDownloads: boolean;
  readonly automationTarget: "sidebar" | "external";
  readonly support: AutomationCapabilitySupportView;
  readonly supportReason: string;
  readonly detectedBrowser: string;
}

export interface BrowserTargetSettingsView {
  readonly targetId: string;
  readonly enabled: boolean;
}

export interface BrowserBackendHealthView {
  readonly active: boolean;
  readonly status: "ready" | "recovering" | "disconnected" | "unavailable" | "error";
  readonly canRecover: boolean;
  readonly reason?: "disposing" | "hostUnavailable" | "startFailed" | "statusFailed" | "recoveryFailed";
}

export interface BrowserSettingsPatchView {
  readonly targetId?: string;
  readonly enabled?: boolean;
  readonly profileDisplayName?: string;
  readonly takeoverTimeoutSeconds?: number;
  readonly allowUploads?: boolean;
  readonly allowDownloads?: boolean;
  readonly automationTarget?: "sidebar" | "external";
}

export type AutomationCapabilitySupportView =
  | "supported"
  | "upstreamMissing"
  | "notImplemented"
  | "platformLimited"
  | "disabledByPolicy"
  | "temporarilyUnavailable"
  | "unspecified";

export type AutomationPermissionStateView = "granted" | "missing" | "unknown" | "notRequired";

export interface ComputerAutomationSettingsView {
  readonly enabled: boolean;
  readonly support: AutomationCapabilitySupportView;
  readonly supportReason: string;
  readonly installed: boolean;
  readonly driverVersion: string;
  readonly daemonRunning: boolean;
  readonly accessibilityPermission: AutomationPermissionStateView;
  readonly screenRecordingPermission: AutomationPermissionStateView;
  readonly screenRecordingCapturable: boolean;
  readonly ready: boolean;
  readonly runtimeState: "disabled" | "checking" | "ready" | "unavailable" | "error";
  readonly failureReason: string;
  readonly platform: string;
  readonly updateCurrentVersion: string;
  readonly updateLatestVersion: string;
  readonly updateAvailable: boolean;
  readonly updateInProgress: boolean;
  readonly updatePhase: "idle" | "downloading" | "installing" | "done";
  readonly updateDownloadedBytes?: number;
  readonly updateTotalBytes?: number;
}

export type AndroidAdbPathSourceView =
  | "custom"
  | "environment"
  | "prepared"
  | "bundled"
  | "sdk"
  | "path"
  | "fallback"
  | "unspecified";

export type AndroidAutomationIssueView =
  | "adbNotFound"
  | "noDevice"
  | "multipleDevices"
  | "deviceUnauthorized"
  | "deviceOffline"
  | "uiDumpFailed"
  | "screenshotFailed"
  | "invalidNode"
  | "driverError"
  | "unspecified";

export interface AndroidDeviceView {
  readonly deviceSerial: string;
  readonly state: string;
  readonly product: string;
  readonly model: string;
  readonly device: string;
  readonly transportId: string;
  readonly usb: string;
}

export interface AndroidAutomationSettingsView {
  readonly enabled: boolean;
  readonly support: AutomationCapabilitySupportView;
  readonly supportReason: string;
  readonly adbAvailable: boolean;
  readonly adbPath: string;
  readonly adbPathSource: AndroidAdbPathSourceView;
  readonly preparationSupported: boolean;
  readonly preparationReady: boolean;
  readonly preparationError: string;
  readonly adbVersion: string;
  readonly devices: readonly AndroidDeviceView[];
  readonly defaultDeviceSerial: string;
  readonly configuredDefaultDeviceSerial: string;
  readonly adbPathOverride: string;
  readonly issue: AndroidAutomationIssueView;
  readonly failureReason: string;
  readonly platform: string;
  readonly runtimeState: "disabled" | "checking" | "preparing" | "ready" | "unavailable" | "error";
  readonly statusObserved: boolean;
}

export interface ModelRouteRefView {
  readonly backendId: string;
  readonly providerId: string;
  readonly modelId: string;
}

export interface AuxiliaryTextSettingsView {
  readonly models: readonly ModelRouteRefView[];
  readonly automaticModels: readonly ModelRouteRefView[];
  readonly options: readonly {
    readonly route: ModelRouteRefView;
    readonly available: boolean;
    readonly unavailableReason: string;
  }[];
  readonly available: boolean;
  readonly unavailableReason: string;
  readonly revision: bigint;
  readonly runtimeRevision: string;
}

export interface SubagentModelSettingsView {
  readonly backendId: string;
  readonly model?: { readonly providerId: string; readonly modelId: string };
  readonly defaultModelSupported: boolean;
  readonly available: boolean;
  readonly unavailableReason: string;
  readonly smartRoutingSupported: boolean;
  readonly smartRoutingEnabled: boolean;
  readonly smartRoutingAvailable: boolean;
  readonly smartRoutingUnavailableReason: string;
  readonly smartRoutingApplied: boolean;
  readonly smartRoutingRestartPending: boolean;
  readonly runtimeGeneration?: bigint;
  readonly runtimeRevision: string;
  readonly revision: bigint;
}

export interface AgentResourceSettingsView {
  readonly maxConcurrentCommands: number;
  readonly processPriority: "normal" | "low" | "lowest";
  readonly capToolchainThreads: boolean;
  readonly customized: boolean;
  readonly revision: bigint;
}

export interface CollaborationSettingsView {
  readonly workerSoftLimit: number;
  readonly workerHardLimit: number;
  readonly workerIdleReleaseMinutes: number;
  readonly customized: boolean;
  readonly revision: bigint;
}

export interface GitSafetySettingsView {
  readonly autoSnapshotEnabled: boolean;
  readonly pendingTurns: number;
  readonly trackedSessions: number;
  readonly trackedRepositories: number;
  readonly cleanupAvailable: boolean;
  readonly customized: boolean;
  readonly revision: bigint;
}

export type ToolPolicyEffectiveSourceView = "productDefault" | "userDefault" | "projectOverride";

export interface ToolPolicySettingsView {
  readonly toolProviderId: string;
  readonly displayName: string;
  readonly description: string;
  readonly productDefaultEnabled: boolean;
  readonly userEffectiveEnabled: boolean;
  readonly userEffectiveSource: ToolPolicyEffectiveSourceView;
  readonly userOverride?: { readonly enabled: boolean };
  readonly targetSettings: readonly {
    readonly targetId: string;
    readonly effectiveEnabled: boolean;
    readonly effectiveSource: ToolPolicyEffectiveSourceView;
    readonly projectOverride?: { readonly enabled: boolean };
  }[];
}

export interface VoiceInputServiceSettingsView {
  readonly enabled: boolean;
  readonly protocol: VoiceInputTranscriptionProtocolView;
  readonly endpoint: string;
  readonly model: string;
  readonly resourceId: string;
  readonly keyless: boolean;
  readonly credentialConfigured: boolean;
  readonly refinementEnabled: boolean;
  readonly refinerModel?: ModelRouteRefView;
  readonly refinerFallbackModel?: ModelRouteRefView;
  readonly fallbackEnabled: boolean;
  readonly fallbackProtocol: VoiceInputTranscriptionProtocolView;
  readonly fallbackEndpoint: string;
  readonly fallbackModel: string;
  readonly fallbackResourceId: string;
  readonly fallbackKeyless: boolean;
  readonly fallbackCredentialConfigured: boolean;
  readonly revision: bigint;
}

export type VoiceInputTranscriptionProtocolView =
  | "openAiCompatibleBatch"
  | "openAiCompatibleRealtime"
  | "qwenCompatibleRealtime"
  | "elevenLabsScribeRealtime"
  | "volcengineSauc";

export interface VoiceInputServiceSettingsDraft {
  readonly enabled: boolean;
  readonly protocol: VoiceInputTranscriptionProtocolView;
  readonly endpoint: string;
  readonly model: string;
  readonly resourceId: string;
  readonly keyless: boolean;
  readonly secret?: string;
  readonly clearCredential?: boolean;
  readonly refinementEnabled: boolean;
  readonly refinerModel?: ModelRouteRefView;
  readonly refinerFallbackModel?: ModelRouteRefView;
  readonly fallbackEnabled: boolean;
  readonly fallbackProtocol: VoiceInputTranscriptionProtocolView;
  readonly fallbackEndpoint: string;
  readonly fallbackModel: string;
  readonly fallbackResourceId: string;
  readonly fallbackKeyless: boolean;
  readonly fallbackSecret?: string;
  readonly clearFallbackCredential?: boolean;
  readonly expectedRevision: bigint;
}

export type MessagingChannelView =
  | "telegram"
  | "discord"
  | "dingtalk"
  | "feishu"
  | "lark"
  | "wecom"
  | "wechat"
  | "slack";

export type MessagingConnectionRuntimeStatusView =
  | "idle"
  | "connecting"
  | "connected"
  | "offline"
  | "conflict"
  | "authLoss"
  | "error";

export interface TelegramMessagingConfigurationView {
  readonly emojiReactions: "off" | "minimal" | "expressive";
  readonly replyQuoteDm: "off" | "first";
  readonly replyQuoteGroup: "off" | "first" | "all";
  readonly groupActivation: Readonly<Record<string, "mention" | "always" | "disabled">>;
}

export interface DiscordMessagingConfigurationView {
  readonly lifecycleAnnouncements: boolean;
  readonly emojiReactions: "off" | "minimal" | "expressive";
  readonly replyQuoteDm: "off" | "first";
  readonly replyQuoteGroup: "off" | "first" | "all";
  /** Keys are exact guild/root-channel pairs formatted as guild/channel. */
  readonly groupActivation: Readonly<Record<string, "mention" | "always" | "disabled">>;
}

export interface DingTalkMessagingConfigurationView {
  readonly appKey: string;
  /** Keys are exact DingTalk conversation IDs. */
  readonly groupActivation: Readonly<Record<string, "mention" | "always" | "disabled">>;
}

export interface FeishuMessagingConfigurationView {
  readonly appId: string;
  readonly lifecycleAnnouncements: boolean;
  readonly emojiReactions: "off" | "minimal" | "expressive";
  readonly replyQuoteDm: "off" | "first";
  readonly replyQuoteGroup: "off" | "first" | "all";
  /** Keys are exact Feishu/Lark chat IDs. */
  readonly groupActivation: Readonly<Record<string, "mention" | "always" | "disabled">>;
  readonly groupPermissionMode: "ask" | "bypassPermissions";
}

export interface WeComMessagingConfigurationView {
  readonly botId: string;
}

export interface WeChatMessagingConfigurationView {
  readonly format: 1;
}

export interface SlackMessagingConfigurationView {
  readonly lifecycleAnnouncements: boolean;
  readonly emojiReactions: "off" | "minimal" | "expressive";
  /** Keys are exact approved Slack channel IDs. */
  readonly groupActivation: Readonly<Record<string, "mention" | "always" | "disabled">>;
}

export type WeChatAuthorizationStatusView =
  | "waiting"
  | "scanned"
  | "verificationRequired"
  | "qrRefreshed"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";

export interface WeChatAuthorizationAttemptView {
  readonly attemptId: string;
  readonly connectionId: string;
  readonly generation: bigint;
  readonly revision: bigint;
  readonly status: WeChatAuthorizationStatusView;
  readonly qrCodeUrl?: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly verificationRetry: boolean;
  readonly errorCode?: string;
  readonly errorSummary?: string;
  readonly connection?: MessagingConnectionView;
}

export interface MessagingConnectionView {
  readonly id: string;
  readonly channel: MessagingChannelView;
  readonly generation: bigint;
  readonly revision: bigint;
  readonly enabled: boolean;
  readonly runtimeStatus: MessagingConnectionRuntimeStatusView;
  readonly credentialConfigured: boolean;
  readonly ownerProviderUserId?: string;
  readonly providerAccountId?: string;
  readonly providerUsername?: string;
  readonly telegramConfiguration?: TelegramMessagingConfigurationView;
  readonly discordConfiguration?: DiscordMessagingConfigurationView;
  readonly dingtalkConfiguration?: DingTalkMessagingConfigurationView;
  readonly feishuConfiguration?: FeishuMessagingConfigurationView;
  readonly wecomConfiguration?: WeComMessagingConfigurationView;
  readonly wechatConfiguration?: WeChatMessagingConfigurationView;
  readonly slackConfiguration?: SlackMessagingConfigurationView;
  readonly errorCode?: string;
  readonly errorSummary?: string;
  readonly lastConnectedAt?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface MessagingRouteView {
  readonly scopeKey: string;
  readonly connectionId?: string;
  readonly targetId: string;
  readonly backendId: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly effort?: string;
  readonly fastMode: boolean;
  readonly permissionMode: PermissionMode;
  readonly planMode: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly revision: bigint;
}

export interface MessagingRouteDraftView {
  readonly connectionId?: string;
  readonly expectedRevision?: bigint;
  readonly targetId: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly effort?: string;
  readonly fastMode: boolean;
  readonly permissionMode: PermissionMode;
  readonly planMode: boolean;
}

export interface MessagingSettingsView {
  readonly connections: readonly MessagingConnectionView[];
  readonly routes: readonly MessagingRouteView[];
  readonly channels: readonly {
    readonly channel: MessagingChannelView;
    readonly available: boolean;
    readonly reason?: string;
  }[];
}

export type MessagingConnectionTestResultView =
  | {
      readonly ok: true;
      readonly providerAccountId: string;
      readonly displayName: string;
      readonly username?: string;
    }
  | {
      readonly ok: false;
      readonly failure: "invalid" | "conflict" | "credentialUnavailable" | "channelUnavailable" | "connectionFailed";
    };

export interface VoiceInputRefinementContextView {
  readonly instructions?: string;
  readonly dictionaryTerms: readonly string[];
}

export interface SettingsView {
  readonly revision: bigint;
  readonly providers: readonly ProviderConfigurationView[];
  readonly credentials: readonly CredentialView[];
  readonly mcpServers: readonly McpServerView[];
  readonly browsers: readonly BrowserSettingsView[];
  readonly computerAutomation: ComputerAutomationSettingsView;
  readonly androidAutomation: AndroidAutomationSettingsView;
  readonly languageTools: { readonly enabled: boolean };
  readonly toolPolicies: readonly ToolPolicySettingsView[];
  readonly agentResource: AgentResourceSettingsView;
  readonly collaboration: CollaborationSettingsView;
  readonly gitSafety: GitSafetySettingsView;
  readonly voiceInput: VoiceInputServiceSettingsView;
  readonly backendSettings: readonly {
    readonly backendId: string;
    readonly enabled: boolean;
    readonly permissionMode: PermissionMode;
    readonly planMode: boolean;
    readonly model?: { readonly providerId: string; readonly modelId: string; readonly effort?: string; readonly fastMode: boolean };
    readonly modelAccess?: {
      readonly disabledProviderIds: readonly string[];
      readonly disabledModels: readonly { readonly providerId: string; readonly modelId: string }[];
    };
  }[];
  readonly pi: readonly { readonly backendId: string; readonly autoCompaction: boolean; readonly autoCompactionThresholdPercent: number; readonly autoCompactionThresholdCustomized: boolean; readonly autoRetry: boolean; readonly steeringMode: "all" | "oneAtATime"; readonly followUpMode: "all" | "oneAtATime" }[];
  readonly policy: { readonly defaultMode: PermissionMode; readonly projectTrustRequired: boolean; readonly redactCredentials: boolean; readonly stripChildProcessCredentials: boolean; readonly ruleCount: number };
  readonly diagnostics: { readonly level: "errors" | "standard" | "verbose"; readonly retentionSeconds: number; readonly includeSanitizedBackendPayloads: boolean; readonly includePerformanceMetrics: boolean };
  readonly messageSearch: {
    readonly semanticIndexEnabled: boolean;
    readonly vectorAvailable: boolean;
    readonly embeddingProviderAvailable: boolean;
    readonly modelId: string;
    readonly pendingCount: number;
    readonly runningCount: number;
    readonly doneCount: number;
    readonly failedCount: number;
    readonly customized: boolean;
  };
  readonly memory: {
    readonly makerEnabled: boolean;
    readonly makerSupported: boolean;
    readonly makerReason: string;
    readonly customized: boolean;
    readonly entryCount: number;
    readonly backends: readonly {
      readonly backendId: string;
      readonly enabled: boolean;
      readonly supported: boolean;
      readonly reason: string;
      readonly entryCount?: number;
      readonly kind: "compaction_digest" | "native_auto_memory";
      readonly resettable: boolean;
      readonly updatesActiveLocalSessions: boolean;
    }[];
  };
  readonly visionBridge: {
    readonly enabled: boolean;
    readonly targetModels: readonly ModelRouteRefView[];
    readonly primary?: ModelRouteRefView;
    readonly fallback?: ModelRouteRefView;
    readonly available: boolean;
    readonly unavailableReason: string;
    readonly customized: boolean;
    readonly customizedFields: readonly string[];
  };
  readonly auxiliaryText: AuxiliaryTextSettingsView;
  readonly subagentModels: readonly SubagentModelSettingsView[];
  readonly promptRecommendation: {
    readonly enabled: boolean;
    readonly available: boolean;
    readonly unavailableReason: string;
    readonly customized: boolean;
  };
  readonly personalization: {
    readonly silentEncryptedRetryEnabled: boolean;
    readonly silentEncryptedRetryCustomized: boolean;
    readonly sessionRuntimeFallbackEnabled: boolean;
    readonly sessionRuntimeFallbackCustomized: boolean;
  };
}

export interface ProviderDraft {
  readonly id: string;
  readonly name: string;
  readonly kind: ProviderConfigurationView["kind"];
  readonly enabled: boolean;
  readonly revision: bigint;
  readonly runtimes: readonly ProviderRuntimeConfigurationView[];
}

export type ProviderLoginMethodView = "apiKey" | "oauthBrowser" | "deviceCode" | "subscription";
export type ProviderLoginStateView = "starting" | "pending" | "completed" | "cancelled" | "timedOut" | "outcomeUnknown" | "failed";

export interface ProviderLoginPromptView {
  readonly id: string;
  readonly kind: "text" | "secret" | "manualCode" | "select";
  readonly message: string;
  readonly placeholder: string;
  readonly options: readonly {
    readonly id: string;
    readonly label: string;
    readonly description: string;
  }[];
}

export interface ProviderLoginFlowView {
  readonly id: string;
  readonly providerId: string;
  readonly method: ProviderLoginMethodView;
  readonly verificationUri?: string;
  readonly userCode?: string;
  readonly expiresAt?: number;
  readonly state: ProviderLoginStateView;
  readonly pendingPrompt?: ProviderLoginPromptView;
  readonly updatedAt: number;
  readonly error?: string;
}

export interface CredentialDraft {
  readonly id: string;
  readonly name: string;
  readonly kind: CredentialView["kind"];
  readonly providerId: string;
  readonly secret: string;
}

export interface McpServerDraft {
  readonly id: string;
  readonly revision: bigint;
  readonly name: string;
  readonly transport: "https" | "sse" | "stdio";
  readonly endpoint: string;
  readonly command: string;
  readonly arguments: readonly string[];
  readonly workingDirectory: string;
  readonly environment: readonly McpEnvironmentVariableView[];
  readonly credentialBindings: readonly Omit<McpCredentialBindingView, "configured">[];
  readonly enabled: boolean;
}

export interface AppSnapshot {
  readonly revision: bigint;
  readonly cursor: bigint;
  readonly generation: bigint;
  readonly server: { readonly name: string; readonly version: string; readonly health: "healthy" | "degraded" | "unavailable" };
  readonly backends: readonly BackendView[];
  readonly models: readonly ModelView[];
  readonly providers: readonly ProviderRuntimeView[];
  readonly managedModelRuntimes?: readonly ManagedModelRuntimeView[];
  readonly targets: readonly TargetView[];
  readonly sessions: readonly SessionView[];
  readonly backgroundTasks: readonly BackgroundTaskActivityView[];
  readonly timelineBySession: ReadonlyMap<string, readonly TimelineItemView[]>;
  /**
   * Client projection fence for paged transcript caches. Owner snapshots do
   * not carry session timelines, so durable deletion boundaries must
   * explicitly invalidate the affected session's separately loaded history.
   */
  readonly timelineHistoryRevisionBySession: ReadonlyMap<string, bigint>;
  readonly extensionWidgetsBySession: ReadonlyMap<string, readonly ExtensionWidgetView[]>;
  readonly extensionStatusesBySession: ReadonlyMap<string, readonly ExtensionStatusView[]>;
  readonly queue: readonly QueueItemView[];
  readonly queueControls: readonly QueueControlView[];
  readonly interactions: readonly InteractionView[];
  readonly reviewRuns: readonly ReviewRunView[];
  readonly workspaces: readonly WorkspaceView[];
  readonly schedules: readonly ScheduleView[];
  readonly browsers: readonly BrowserView[];
  readonly extraDirectories: readonly ExtraDirectoryView[];
  readonly resources: readonly ResourceView[];
  readonly extensions: readonly ExtensionCatalogEntryView[];
  readonly extensionCatalogRevision: bigint;
  readonly extensionCatalogRecovered: boolean;
  readonly commands: readonly RuntimeCommandView[];
  readonly remoteConnections: readonly RemoteConnectionView[];
  readonly devices: readonly DeviceView[];
  readonly deviceControlRelations: readonly DeviceControlRelationView[];
  readonly settings: SettingsView;
  readonly diagnostics: readonly ErrorView[];
}

export interface BackendSettingsUpdate {
  readonly enabled?: boolean;
  readonly permissionMode?: PermissionMode;
  readonly planMode?: boolean;
  readonly defaultModel?: {
    readonly providerId: string;
    readonly modelId: string;
    readonly effort?: string;
    readonly fastMode: boolean;
  };
  readonly clearDefaultModel?: boolean;
  readonly modelAccessUpdate?: {
    readonly providerId: string;
    readonly modelId?: string;
    readonly enabled: boolean;
  };
}

export interface AttachmentDraft {
  readonly id: string;
  readonly file: File;
  readonly kind: "image" | "file";
  readonly previewUrl?: string;
}

export const BROWSER_COMMENT_DESIGN_PROPERTIES = [
  "color",
  "background-color",
  "font-size",
  "font-weight",
  "padding",
  "border-radius"
] as const;

export type BrowserCommentDesignPropertyView = typeof BROWSER_COMMENT_DESIGN_PROPERTIES[number];

export interface BrowserCommentDesignBaselineView {
  readonly styles: Readonly<Partial<Record<BrowserCommentDesignPropertyView, string>>>;
  readonly editableText?: string;
  readonly provenance: Readonly<Partial<Record<BrowserCommentDesignPropertyView, string>>>;
}

export interface BrowserCommentStyleChangeView {
  readonly property: BrowserCommentDesignPropertyView | "text content";
  readonly previousValue: string;
  readonly value: string;
}

export type BrowserCommentInspectionInputView =
  | { readonly intent: "existingText"; readonly markerNumber: number }
  | { readonly intent: "element"; readonly markerNumber: number; readonly point: { readonly x: number; readonly y: number }; readonly viewport: { readonly width: number; readonly height: number } }
  | {
      readonly intent: "region";
      readonly markerNumber: number;
      readonly point: { readonly x: number; readonly y: number };
      readonly viewport: { readonly width: number; readonly height: number };
      readonly region: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
    };

export interface BrowserCommentInspectionResultView {
  readonly target?: BrowserCommentTargetView;
  readonly targetToken?: string;
}

export interface BrowserCommentPlacementView {
  readonly markerNumber: number;
  readonly point: { readonly x: number; readonly y: number };
  readonly viewport: { readonly width: number; readonly height: number };
  readonly pending: boolean;
  readonly region?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly textRegions?: readonly { readonly x: number; readonly y: number; readonly width: number; readonly height: number }[];
}

export type BrowserCommentDesignCommandView =
  | {
      readonly action: "apply";
      readonly targetToken: string;
      readonly styles: Readonly<Partial<Record<BrowserCommentDesignPropertyView, string>>>;
      readonly text?: string;
    }
  | { readonly action: "reset"; readonly targetToken: string }
  | { readonly action: "commit"; readonly targetToken: string; readonly markerNumber: number }
  | { readonly action: "reconcile"; readonly validMarkerNumbers: readonly number[] }
  | { readonly action: "resetAll" };

interface BrowserCommentTargetEvidenceView {
  readonly point: { readonly x: number; readonly y: number };
  readonly viewport: { readonly width: number; readonly height: number };
  readonly targetTag?: string;
  readonly targetLabel?: string;
  readonly targetRole?: string;
  readonly targetSelector?: string;
  readonly targetPath?: string;
  readonly nearbyText?: string;
  readonly themeVariant?: "light" | "dark";
  readonly designBaseline?: BrowserCommentDesignBaselineView;
}

export type BrowserCommentTargetView =
  | BrowserCommentTargetEvidenceView & {
      readonly kind: "element";
    }
  | BrowserCommentTargetEvidenceView & {
      readonly kind: "region";
      readonly region: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
    }
  | BrowserCommentTargetEvidenceView & {
      readonly kind: "text";
      readonly selectedText: string;
      readonly textRegions?: readonly { readonly x: number; readonly y: number; readonly width: number; readonly height: number }[];
    };

/** One local, structured page annotation. It is serialized only at send time. */
export interface BrowserCommentDraftItem {
  readonly id: string;
  readonly markerNumber: number;
  readonly pageUrl: string;
  readonly target: BrowserCommentTargetView;
  readonly comment: string;
  readonly screenshot: AttachmentDraft;
  readonly styleChanges?: readonly BrowserCommentStyleChangeView[];
}

export interface NativeSessionTreeNodeView {
  readonly id: string;
  readonly parentId?: string;
  readonly kind: "session" | "message" | "model" | "effort" | "compaction" | "summary" | "custom" | "label" | "unknown";
  readonly role?: "user" | "assistant" | "tool";
  readonly text: string;
  readonly summary?: string;
  readonly createdAt?: number;
  readonly active: boolean;
  readonly children: readonly NativeSessionTreeNodeView[];
}

export interface NativeSessionTreeView {
  readonly nativeSessionId: string;
  readonly activeLeafId?: string;
  readonly roots: readonly NativeSessionTreeNodeView[];
}

export interface NativeSessionCandidateView {
  readonly id: string;
  readonly reference: string;
  readonly name: string;
  readonly workspaceRoot: string;
  readonly messageCount: number;
  readonly modifiedAt: number;
  readonly state: "ready" | "error";
  readonly boundSessionId?: string;
}

export interface NativeSessionCatalogEntryView {
  readonly id: string;
  readonly reference: string;
  readonly title?: string;
  readonly workingDirectory?: string;
  readonly projectDirectory?: string;
  readonly createdAt: number;
  readonly modifiedAt: number;
  readonly archived: boolean;
  readonly placement: "project" | "dialogue";
  readonly targetId?: string;
  readonly projectTargetId?: string;
  readonly existingSessionId?: string;
}

export interface NativeSessionCatalogView {
  readonly entries: readonly NativeSessionCatalogEntryView[];
  readonly rejectedCount: number;
  readonly existingCount: number;
  readonly snapshotToken: string;
}

export interface NewSessionDraft {
  readonly targetId: string;
  /** Exact Target revision whose workspace was prepared for this creation. */
  readonly expectedTargetRevision?: bigint;
  readonly name: string;
  readonly summary?: string;
  readonly nativeStart: { readonly kind: "fresh" } | { readonly kind: "attach"; readonly reference: string };
  readonly initialPlacement?: "project" | "dialogue";
  readonly catalogImport?: {
    readonly projectId?: string;
    readonly archived: boolean;
    readonly createdAt: number;
    readonly modifiedAt: number;
    readonly snapshotToken: string;
  };
  /** Creation-time personalization snapshot; ignored when attaching native history. */
  readonly appendSystemPrompt?: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly effort?: string;
  readonly fastMode: boolean;
  readonly permissionMode: PermissionMode;
  readonly planMode: boolean;
  readonly worktree?: {
    readonly sourceRef?: string;
    readonly refreshRemote: boolean;
  };
}

export type WorktreeEligibilityView = "eligible" | "notGitRepository" | "alreadyLinked" | "gitNotFound" | "unsafe" | "unavailable";

export interface TargetWorktreeProbeView {
  readonly targetId: string;
  readonly eligibility: WorktreeEligibilityView;
  readonly repositoryRoot?: string;
  readonly currentBranch?: string;
  readonly headCommit?: string;
  readonly canRefreshRemote: boolean;
}

export interface SessionWorktreeRemovalPreviewView {
  readonly hasWorktree: boolean;
  readonly dirty: boolean;
}

export interface WorktreeSourceView {
  readonly ref: string;
  readonly commit: string;
  readonly name: string;
  readonly remote: boolean;
  readonly current: boolean;
}

export type NewSessionDraftSelection =
  | { readonly kind: "target"; readonly targetId: string }
  | { readonly kind: "dialogue"; readonly backendId: string };

/** Owner/connection-scoped delayed-create state. Attachment bytes stay in the
 * local browser draft store. Extra-directory authority is represented only by
 * opaque approved-record IDs and is revalidated against the current snapshot
 * before it is shown or sent; server paths are never copied into this record. */
export interface NewSessionLocalDraft {
  readonly selection: NewSessionDraftSelection;
  readonly nativeStart: { readonly kind: "fresh" } | { readonly kind: "attach"; readonly reference: string };
  readonly providerId: string;
  readonly modelId: string;
  readonly effort?: string;
  readonly fastMode: boolean;
  readonly permissionMode: PermissionMode;
  readonly planMode: boolean;
  readonly worktree?: {
    readonly enabled: boolean;
    readonly sourceRef?: string;
    readonly refreshRemote: boolean;
  };
  readonly text: string;
  /** Ordered rich-text source of truth for the delayed first message. */
  readonly editorDocument: JSONContent;
  readonly mentions: readonly ComposerMentionDraft[];
  readonly inlineMentionRanges?: readonly ComposerInlineMentionRange[];
  readonly attachments: readonly AttachmentDraft[];
  readonly browserComments?: readonly BrowserCommentDraftItem[];
  readonly extraDirectoryIds?: readonly string[];
}

interface ComposerTokenMentionBaseDraft {
  readonly id: string;
  readonly reference: string;
  readonly label: string;
  readonly token: string;
}

export type ComposerTokenMentionDraft = ComposerTokenMentionBaseDraft & (
  | {
      readonly kind: "workspace";
      readonly workspaceId?: string;
      readonly directory?: boolean;
      readonly lineRange?: { readonly startLine: number; readonly endLine: number };
    }
  | {
      readonly kind: "resource";
      readonly discoveredRevision: string;
      readonly resourceVersion: string;
      readonly runtimeGeneration: number;
      readonly workspaceId?: never;
      readonly directory?: never;
      readonly lineRange?: never;
    }
  | {
      readonly kind: "artifact";
      readonly sourceSessionId: string;
      readonly workspaceId?: never;
      readonly directory?: never;
      readonly lineRange?: never;
    }
  | {
      readonly kind: "session";
      readonly workspaceId?: never;
      readonly directory?: never;
      readonly lineRange?: never;
    }
);

/**
 * A message reference stays structured in the local draft. It deliberately
 * carries only bounded public identities; the canonical deep link is rebuilt
 * at send time for the currently connected Joko origin.
 */
export interface ComposerMessageMentionDraft {
  readonly id: string;
  readonly kind: "message";
  readonly reference: string;
  readonly label: string;
  readonly sessionId: string;
  readonly role: "user" | "assistant";
  readonly sourceEventId?: string;
}

export type ComposerMentionDraft = ComposerTokenMentionDraft | ComposerMessageMentionDraft;

/** Exact occurrences in the rich document's plain-text projection. */
export interface ComposerInlineMentionRange {
  readonly mentionId: string;
  readonly from: number;
  readonly to: number;
}

interface ComposerSelectionQuoteBaseDraft {
  readonly id: string;
  readonly text: string;
  readonly sessionId: string;
}

/** A quote captured from one durable chat message. */
export interface ComposerMessageSelectionQuoteDraft extends ComposerSelectionQuoteBaseDraft {
  readonly kind: "message";
  readonly messageId: string;
  readonly sourceEventId?: string;
  readonly role: "user" | "assistant";
}

/** A quote captured from a canonical workspace-relative file path. */
export interface ComposerFileSelectionQuoteDraft extends ComposerSelectionQuoteBaseDraft {
  readonly kind: "file";
  readonly sourcePath: string;
  readonly startLine?: number;
  readonly endLine?: number;
}

/** A selected-text quote kept structured until send time. */
export type ComposerSelectionQuoteDraft =
  | ComposerMessageSelectionQuoteDraft
  | ComposerFileSelectionQuoteDraft;

export interface ComposerDraft {
  readonly text: string;
  /** Ordered rich-text source of truth for inline selected-text quote atoms. */
  readonly editorDocument?: JSONContent;
  readonly attachments: readonly AttachmentDraft[];
  readonly browserComments?: readonly BrowserCommentDraftItem[];
  readonly mentions: readonly ComposerMentionDraft[];
  readonly inlineMentionRanges?: readonly ComposerInlineMentionRange[];
  readonly deliveryMode: DeliveryMode;
  /** Explicit per-turn directory selection. Undefined follows Session defaults; [] grants none. */
  readonly extraDirectoryIds?: readonly string[];
}

export type VoiceInputCapabilitySupportView =
  | "supported"
  | "upstreamMissing"
  | "notImplemented"
  | "platformLimited"
  | "disabledByPolicy"
  | "temporarilyUnavailable"
  | "unspecified";

export interface VoiceInputLimitsView {
  readonly supportedMimeTypes: readonly string[];
  readonly maximumAudioChunkBytes: number;
  readonly maximumAudioBytes: number;
  readonly maximumAudioChunkDurationMs: number;
  readonly maximumAudioDurationMs: number;
  readonly maximumLocaleCharacters: number;
  readonly stableWaitMs: number;
  readonly maximumConcurrentSessions: number;
}

export interface VoiceInputCapabilityView {
  readonly support: VoiceInputCapabilitySupportView;
  readonly reason?: string;
  readonly limits: VoiceInputLimitsView;
  readonly supportsLocale: boolean;
  readonly supportsLiveDrafts: boolean;
  readonly supportsRefinement: boolean;
}

export type VoiceInputConnectionTestFailureView =
  | "authenticationFailed"
  | "credentialsMissing"
  | "network"
  | "routeUnavailable"
  | "serviceError"
  | "timeout";

export type VoiceInputConnectionTestResultView =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: VoiceInputConnectionTestFailureView };

export interface VoiceInputDictionaryAliasStateView {
  readonly text: string;
  readonly count: number;
}

export interface VoiceInputDictionaryEntryStateView {
  readonly term: string;
  readonly source: "manual" | "automatic";
  readonly frequency: number;
  readonly aliases: readonly VoiceInputDictionaryAliasStateView[];
}

export interface VoiceInputDictionaryCandidateStateView {
  readonly term: string;
  readonly evidenceCount: number;
  readonly aliases: readonly VoiceInputDictionaryAliasStateView[];
}

export interface VoiceInputDictionaryAdviceDraft {
  readonly beforeText: string;
  readonly afterText: string;
  readonly rawTranscriptText?: string;
  readonly locale?: string;
  readonly existingEntries: readonly VoiceInputDictionaryEntryStateView[];
  readonly existingCandidates: readonly VoiceInputDictionaryCandidateStateView[];
}

export interface VoiceInputDictionaryLearningActionView {
  readonly action: "addCandidate" | "addEntry" | "updateEntry";
  readonly term: string;
  readonly aliases: readonly string[];
  readonly type: "productName" | "projectName" | "technicalTerm" | "personName" | "teamName" | "codeName" | "phrase" | "other";
  readonly confidence: "medium" | "high";
}

export interface VoiceInputDictionaryAdviceView {
  readonly actions: readonly VoiceInputDictionaryLearningActionView[];
}

export type VoiceInputStateView = "idle" | "listening" | "submitting" | "refining" | "done" | "error";
export type VoiceInputOutcomeView = "success" | "noSpeech" | "failed" | "cancelled";
export type VoiceInputTextSourceView = "partial" | "stable";
export type VoiceInputFailureCodeView =
  | "connectionInterrupted"
  | "emptyTranscript"
  | "hostSubmissionFailed"
  | "providerAuthentication"
  | "providerCloseFailed"
  | "providerError"
  | "providerFlushFailed"
  | "providerProtocol"
  | "providerQuota"
  | "providerStartFailed";

export interface VoiceInputSessionView {
  readonly id: string;
  readonly state: VoiceInputStateView;
  readonly outcome?: VoiceInputOutcomeView;
  readonly draft?: { readonly text: string; readonly source: VoiceInputTextSourceView };
  readonly result?: { readonly text: string; readonly source: VoiceInputTextSourceView; readonly salvaged: boolean; readonly rawTranscriptText?: string };
  readonly failure?: { readonly code: VoiceInputFailureCodeView; readonly transcriptKept: boolean };
  readonly nextChunkSequence: bigint;
  readonly acceptedAudioBytes: number;
  readonly acceptedAudioDurationMs: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly recoveryAttempts: number;
  readonly stallWarning: boolean;
}

export type CompactSessionOutcomeView = "compacted" | "noop";

export interface SessionTitleSuggestionView {
  readonly title: string;
  readonly status: "ok" | "no_material" | "provider_unavailable" | "generation_failed";
}

export type PortableSessionFidelityView = "full" | "partial" | "product_only";

export interface PortableSessionImportPreviewView {
  readonly title: string;
  readonly workspaceKind: "dialogue" | "project";
  readonly exportedAt: number;
  readonly applicationVersion: string;
  readonly backendCapability: string;
  readonly fidelity: PortableSessionFidelityView;
  readonly messageCount: number;
  readonly mediaCount: number;
  readonly workerCount: number;
  readonly nativeHistory: boolean;
}

export interface PortableSessionImportDraftView {
  readonly draftId: string;
  readonly expiresAt: number;
  readonly encrypted: boolean;
  readonly passwordRequired: boolean;
  readonly preview?: PortableSessionImportPreviewView;
}

export interface PortableSessionTargetOption {
  readonly id: string;
  readonly label: string;
  readonly worktreeSupported: boolean;
}

export interface PortableSessionExecutionSelection {
  readonly providerId?: string;
  readonly modelId?: string;
  readonly effort?: string;
  readonly fastMode: boolean;
  readonly permissionMode: PermissionMode;
  readonly planMode: boolean;
}

export interface PortableSessionImportResultView {
  readonly sessionId: string;
  readonly fidelity: PortableSessionFidelityView;
  readonly messageCount: number;
  readonly mediaCount: number;
  readonly workerCount: number;
  readonly replacedSessionIds: readonly string[];
  readonly status: "ready" | "imported_activation_failed";
  readonly activationError?: ErrorView;
}

export interface PortableSessionActivationResultView {
  readonly sessionId: string;
  readonly status: "ready" | "imported_activation_failed";
  readonly activationError?: ErrorView;
}

export type PortableSessionExportOutcomeView =
  | { readonly status: "exported"; readonly fidelity: PortableSessionFidelityView }
  | { readonly status: "oversize"; readonly mediaBytes: number; readonly limitBytes: number }
  | { readonly status: "cancelled" };

export interface TerminalShellView {
  readonly id: string;
  readonly label: string;
}

export interface TerminalCapabilitiesView {
  readonly support: VoiceInputCapabilitySupportView;
  readonly reason?: string;
  readonly shells: readonly TerminalShellView[];
  readonly defaultShellId: string;
  readonly maximumTerminals: number;
  readonly maximumInputBytes: number;
  readonly maximumColumns: number;
  readonly maximumRows: number;
}

export interface TerminalView {
  readonly id: string;
  readonly sessionId: string;
  readonly targetId: string;
  readonly generation: bigint;
  readonly status: "running" | "exited" | "failed" | "closed";
  readonly exitConfirmed: boolean;
  readonly failureCode?: string;
  readonly shellId: string;
  readonly shellLabel: string;
  readonly cwd: string;
  readonly columns: number;
  readonly rows: number;
  readonly exitCode?: number;
  readonly exitSignal?: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface TerminalPaletteView {
  readonly ansiRgb: readonly number[];
  readonly foregroundRgb: number;
  readonly backgroundRgb: number;
  readonly cursorRgb: number;
}
export interface TerminalAppearanceView {
  readonly viewId: string;
  readonly viewRevision: bigint;
  readonly palette: TerminalPaletteView;
}
export interface TerminalAppearanceResultView {
  readonly accepted: boolean;
  readonly acceptedViewRevision: bigint;
  readonly appearanceRevision: bigint;
  readonly ownsDefaults: boolean;
}
export type TerminalUpdateView = {
  readonly appearanceRevision: bigint;
  readonly activeColorOverrides?: string;
} & ({
  readonly kind: "output";
  readonly terminal?: TerminalView;
  readonly sequence: bigint;
  readonly data: string;
} | {
  readonly kind: "state" | "reset";
  readonly terminal: TerminalView;
  readonly sequence: bigint;
  readonly data: string;
});

export interface ArtifactDownloadContext {
  readonly ownerDocument: Document;
  readonly signal: AbortSignal;
}

/** Browser dispatch does not acknowledge that a file reached the user's disk. */
export type ArtifactDownloadOutcome = "saved" | "dispatched" | "cancelled";

export interface OperationApi {
  getTerminalCapabilities(sessionId?: string, signal?: AbortSignal): Promise<TerminalCapabilitiesView>;
  listTerminals(sessionId: string, signal?: AbortSignal): Promise<readonly TerminalView[]>;
  createTerminal(sessionId: string, requestId: string, shellId: string, columns: number, rows: number, initialPalette: TerminalPaletteView, signal?: AbortSignal): Promise<TerminalView>;
  getTerminal(sessionId: string, terminalId: string, generation?: bigint, signal?: AbortSignal): Promise<TerminalView>;
  watchTerminal(sessionId: string, terminalId: string, generation: bigint, appearance: TerminalAppearanceView, onUpdate: (update: TerminalUpdateView) => void | Promise<void>, afterSequence?: bigint, signal?: AbortSignal): Promise<void>;
  updateTerminalAppearance(sessionId: string, terminalId: string, generation: bigint, appearance: TerminalAppearanceView, claimFocus: boolean, expectedAppearanceRevision: bigint, signal?: AbortSignal): Promise<TerminalAppearanceResultView>;
  writeTerminal(sessionId: string, terminalId: string, generation: bigint, writerId: string, inputSequence: bigint, data: string, signal?: AbortSignal): Promise<void>;
  resizeTerminal(sessionId: string, terminalId: string, generation: bigint, viewId: string, columns: number, rows: number, signal?: AbortSignal): Promise<void>;
  restartTerminal(sessionId: string, terminalId: string, generation: bigint, requestId: string, signal?: AbortSignal): Promise<TerminalView>;
  closeTerminal(sessionId: string, terminalId: string, generation: bigint, signal?: AbortSignal): Promise<void>;
  refresh(): Promise<void>;
  refreshProviderAccountUsage(backendId: string, providerId: string): Promise<void>;
  getArtifactStorageStats(protectedSha256?: readonly string[]): Promise<ArtifactStorageMaintenanceView>;
  listSessionArtifacts(sessionId: string, signal?: AbortSignal): Promise<readonly ArtifactView[]>;
  listArtifactReferenceCatalog(targetSessionId: string, targetGeneration: bigint, signal?: AbortSignal): Promise<readonly ArtifactReferenceCatalogItemView[]>;
  readSessionArtifact(sessionId: string, artifactId: string, signal: AbortSignal): Promise<ArtifactView>;
  scanArtifactStorage(protectedSha256?: readonly string[]): Promise<ArtifactStorageScanView>;
  reconcileArtifactStorage(protectedSha256?: readonly string[]): Promise<ArtifactStorageReconcileView>;
  cleanupArtifactStorage(scanToken: string, protectedSha256?: readonly string[]): Promise<ArtifactStorageCleanupView>;
  getTaskHistoryMaintenanceSupport(): Promise<TaskHistoryMaintenanceSupportView>;
  scanTaskHistory(retention: TaskHistoryRetentionView, includeActiveTasks: boolean): Promise<TaskHistoryScanView>;
  beginTaskHistoryCleanup(scanId: string, backupEnabled: boolean): Promise<TaskHistoryCleanupProgressView>;
  getTaskHistoryCleanup(maintenanceId: string): Promise<TaskHistoryCleanupProgressView>;
  cancelTaskHistoryCleanup(maintenanceId: string): Promise<TaskHistoryCleanupProgressView>;
  getVoiceInputCapabilities(signal?: AbortSignal): Promise<VoiceInputCapabilityView>;
  testVoiceInputConnection(signal?: AbortSignal): Promise<VoiceInputConnectionTestResultView>;
  adviseVoiceInputDictionaryEdit(draft: VoiceInputDictionaryAdviceDraft, signal?: AbortSignal): Promise<VoiceInputDictionaryAdviceView>;
  startVoiceInput(
    requestId: string,
    mimeType: string,
    locale?: string,
    refinement?: VoiceInputRefinementContextView,
    signal?: AbortSignal
  ): Promise<VoiceInputSessionView>;
  appendVoiceAudio(voiceInputId: string, chunkSequence: bigint, audio: Uint8Array, durationMs: number, voiced: boolean, signal?: AbortSignal): Promise<VoiceInputSessionView>;
  stopVoiceInput(voiceInputId: string, expectedNextChunkSequence: bigint, signal?: AbortSignal): Promise<VoiceInputSessionView>;
  cancelVoiceInput(voiceInputId: string, signal?: AbortSignal): Promise<VoiceInputSessionView>;
  getVoiceInputSession(voiceInputId: string, signal?: AbortSignal): Promise<VoiceInputSessionView>;
  send(sessionId: string, draft: ComposerDraft, admission: { readonly expectedGeneration: bigint }): Promise<void>;
  startReview(sourceSessionId: string, focus: string, attachments: readonly AttachmentDraft[]): Promise<string>;
  reobserveReview(reviewRunId: string): Promise<void>;
  abort(runId: string): Promise<void>;
  abortRetry(runId: string): Promise<void>;
  retry(runId: string): Promise<void>;
  resetSession(sessionId: string): Promise<void>;
  deleteSessionMessage(sessionId: string, eventId: string): Promise<void>;
  renameSession(sessionId: string, name: string): Promise<void>;
  suggestSessionTitle(sessionId: string, signal?: AbortSignal): Promise<SessionTitleSuggestionView>;
  pinSession(sessionId: string, pinned: boolean): Promise<void>;
  archiveSession(sessionId: string, archived: boolean): Promise<void>;
  getSessionWorktreeRemovalPreview(sessionId: string, signal?: AbortSignal): Promise<SessionWorktreeRemovalPreviewView>;
  moveSessionProject(
    sessionId: string,
    projectId?: string,
    catalogImport?: { readonly archived: boolean; readonly modifiedAt: number; readonly snapshotToken: string }
  ): Promise<void>;
  acknowledgeSessionAttention(sessionId: string, throughCursor: TimelineHistoryCursorView): Promise<void>;
  acknowledgeSessionError(sessionId: string, throughCursor: TimelineHistoryCursorView): Promise<void>;
  deleteSession(sessionId: string, deleteNative: boolean): Promise<void>;
  createSession(draft: NewSessionDraft): Promise<{ readonly sessionId: string; readonly generation: bigint }>;
  probeTargetWorktree(targetId: string, signal?: AbortSignal): Promise<TargetWorktreeProbeView>;
  listTargetWorktreeSources(targetId: string, signal?: AbortSignal): Promise<readonly WorktreeSourceView[]>;
  discoverNativeSessions(targetId: string, signal?: AbortSignal): Promise<readonly NativeSessionCandidateView[]>;
  scanNativeSessionCatalog(
    backendId: string,
    options?: { readonly signal?: AbortSignal; readonly force?: boolean }
  ): Promise<NativeSessionCatalogView>;
  createTarget(draft: TargetDraft): Promise<string>;
  createRemoteTarget(draft: RemoteTargetDraft): Promise<string>;
  listProjectDirectories(path: string, signal?: AbortSignal): Promise<ProjectDirectoryListingView>;
  prepareTargetWorkspace(targetId: string, expectedRevision: bigint, signal?: AbortSignal): Promise<void>;
  updateTarget(targetId: string, patch: {
    readonly name?: string;
    readonly pinned?: boolean;
    readonly workspaceLocation?:
      | { readonly kind: "remote"; readonly hostId: string; readonly workspaceRoot: string }
      | { readonly kind: "serviceNode" };
  }, expectedRevision: bigint): Promise<void>;
  /** Returns the same Target from the authoritative post-operation snapshot, or undefined if it no longer exists. */
  archiveTarget(targetId: string, archived: boolean): Promise<TargetView | undefined>;
  deleteTarget(targetId: string, deleteManagedWorkspace: boolean): Promise<void>;
  setWorkspaceTrust(workspaceId: string, trusted: boolean): Promise<void>;
  addExtraDirectory(workspaceId: string, serverPath: string, access: ExtraDirectoryView["access"]): Promise<void>;
  removeExtraDirectory(extraDirectoryId: string): Promise<void>;
  setModel(sessionId: string, providerId: string, modelId: string, effort: string | undefined, fastMode: boolean): Promise<void>;
  setPermission(sessionId: string, mode: PermissionMode): Promise<void>;
  setPlanMode(sessionId: string, enabled: boolean): Promise<void>;
  compact(sessionId: string, customInstructions?: string): Promise<CompactSessionOutcomeView>;
  exportSession(sessionId: string, context: ArtifactDownloadContext): Promise<ArtifactDownloadOutcome>;
  exportPortableSession(
    sessionId: string,
    options: { readonly password?: string; readonly excludeMedia: boolean },
    context: ArtifactDownloadContext
  ): Promise<PortableSessionExportOutcomeView>;
  inspectPortableSessionImport(file: File): Promise<PortableSessionImportDraftView>;
  unlockPortableSessionImport(draftId: string, password: string): Promise<PortableSessionImportDraftView>;
  cancelPortableSessionImport(draftId: string): Promise<void>;
  commitPortableSessionImport(input: {
    readonly draftId: string;
    readonly targetId: string;
    readonly execution: PortableSessionExecutionSelection;
    readonly overwrite: boolean;
    readonly useWorktree: boolean;
    readonly worktreeSourceRef?: string;
    readonly refreshWorktreeRemote?: boolean;
  }): Promise<PortableSessionImportResultView>;
  retryPortableSessionActivation(sessionId: string): Promise<PortableSessionActivationResultView>;
  executeUserShell(sessionId: string, command: string, excludeFromContext: boolean): Promise<void>;
  abortUserShell(sessionId: string): Promise<void>;
  getSessionStatistics(sessionId: string, signal?: AbortSignal): Promise<SessionStatisticsView>;
  getSessionTree(sessionId: string): Promise<NativeSessionTreeView>;
  navigateSessionBranch(
    sessionId: string,
    target: NativeNavigationTargetView,
    options: { readonly expectedGeneration: bigint; readonly summarize?: boolean; readonly customInstructions?: string }
  ): Promise<void>;
  forkSession(
    sessionId: string,
    entryId: string,
    name: string,
    sourceMessage?: { readonly messageId: string; readonly eventId: string }
  ): Promise<string>;
  cloneSession(
    sessionId: string,
    name: string,
    sourceMessage?: { readonly messageId: string; readonly eventId: string }
  ): Promise<string>;
  resolveInteraction(interaction: InteractionView, resolution: InteractionResolutionDraft): Promise<void>;
  dismissInteraction(interaction: InteractionView): Promise<void>;
  runSchedule(scheduleId: string): Promise<void>;
  setScheduleEnabled(scheduleId: string, enabled: boolean): Promise<void>;
  deleteSchedule(scheduleId: string, disposition: ScheduleGeneratedSessionDispositionView): Promise<ScheduleDeletionResultView>;
  markScheduleRunRead(scheduleId: string, triggerId: string): Promise<void>;
  markScheduleRunsRead(scheduleId: string): Promise<number>;
  markAllScheduleRunsRead(): Promise<number>;
  deleteScheduleRun(scheduleId: string, triggerId: string): Promise<void>;
  restartScheduleRun(scheduleId: string, triggerId: string): Promise<void>;
  reconcileProjectAutomations(targetId: string): Promise<void>;
  promoteScheduleToProject(scheduleId: string): Promise<void>;
  cloneProjectScheduleToUser(scheduleId: string, displayName: string): Promise<void>;
  removeProjectSchedule(scheduleId: string, keepPersonalCopy: boolean): Promise<void>;
  saveSchedule(scheduleId: string | undefined, draft: ScheduleDraft): Promise<void>;
  listScheduleRunHistory(scheduleId: string, pageToken?: string, pageSize?: number): Promise<ScheduleHistoryPageView>;
  getSchedulerRuntime(signal?: AbortSignal): Promise<SchedulerRuntimeView>;
  cancelQueueItem(queueItemId: string): Promise<void>;
  setQueueItemEditLock(queueItemId: string, lockToken: string, locked: boolean): Promise<void>;
  setQueueInteractionLock(sessionId: string, lockToken: string, locked: boolean): Promise<void>;
  editQueueItem(queueItemId: string, edit: QueueItemTextEditView, mode: DeliveryMode, lockToken: string): Promise<void>;
  reorderQueueItem(queueItemId: string, placement: "first" | "last" | "before" | "after", anchorQueueItemId?: string, interactionLockToken?: string): Promise<void>;
  steerQueueItemNow(queueItemId: string, lockToken: string): Promise<void>;
  pauseQueue(sessionId: string, reason?: string): Promise<void>;
  resumeQueue(sessionId: string): Promise<void>;
  restartBrowser(browserId: string): Promise<void>;
  openBrowserPage(browserId: string, sessionId: string, url: string, recoveryPageId?: string, workspaceHtml?: { readonly workspaceId: string; readonly relativePath: string; readonly expectedRevision: string }): Promise<string>;
  recoverBrowserPage(browserId: string, sessionId: string, pageId: string, url: string): Promise<string>;
  focusBrowserPage(browserId: string, pageId: string): Promise<string>;
  closeBrowserPage(browserId: string, pageId: string): Promise<string | undefined>;
  beginBrowserTakeover(browserId: string, pageId: string): Promise<void>;
  endBrowserTakeover(browserId: string): Promise<void>;
  performBrowserTakeoverAction(browserId: string, pageId: string, action: BrowserTakeoverActionView): Promise<string>;
  inspectBrowserCommentTarget(browserId: string, pageId: string, input: BrowserCommentInspectionInputView): Promise<BrowserCommentInspectionResultView>;
  updateBrowserCommentDesign(browserId: string, pageId: string, command: BrowserCommentDesignCommandView): Promise<readonly BrowserCommentPlacementView[]>;
  listBrowserActivity(browserId: string, pageId: string): Promise<readonly BrowserActivityView[]>;
  listBrowserTransfers(browserId: string, pageId: string): Promise<readonly BrowserTransferView[]>;
  uploadBrowserFile(browserId: string, pageId: string, file: File, inputHint?: string): Promise<void>;
  approveResource(resourceId: string, discoveredRevision: string): Promise<void>;
  discoverProjectResources(targetId: string): Promise<void>;
  addResource(draft: ResourceDraft): Promise<void>;
  setResourceEnabled(resourceId: string, enabled: boolean): Promise<void>;
  removeResource(resourceId: string): Promise<void>;
  listSkills(options?: {
    readonly query?: string;
    readonly backendId?: string;
    readonly targetId?: string;
    readonly scope?: SkillScopeView;
    readonly signal?: AbortSignal;
  }): Promise<SkillCatalogView>;
  getSkillResourceUsageReport(resourceId: string, timeZone: string, signal?: AbortSignal): Promise<ResourceUsageReportView>;
  openSkill(skillId: string, expectedRevision: bigint, signal?: AbortSignal): Promise<SkillSessionView>;
  listSkillFiles(sessionId: string, parentKey?: string, signal?: AbortSignal): Promise<readonly SkillFileEntryView[]>;
  readSkillFile(sessionId: string, key: string, signal?: AbortSignal): Promise<SkillFileContentView>;
  getSkillDiff(sessionId: string, signal?: AbortSignal): Promise<SkillDiffView>;
  prepareSkillFileEdit(sessionId: string, key: string, expectedFileRevision: string, content: string, signal?: AbortSignal): Promise<SkillDraftView>;
  prepareSkillRename(sessionId: string, name: string, signal?: AbortSignal): Promise<SkillDraftView>;
  applySkillDraft(draft: SkillDraftView, signal?: AbortSignal): Promise<SkillMutationResultView>;
  setSkillEnabled(skill: SkillDescriptorView, enabled: boolean, signal?: AbortSignal): Promise<SkillMutationResultView>;
  deleteSkill(session: SkillSessionView, confirmation: string, signal?: AbortSignal): Promise<SkillMutationResultView>;
  listSkillRecoveries(signal?: AbortSignal): Promise<readonly SkillRecoveryView[]>;
  closeSkill(sessionId: string, signal?: AbortSignal): Promise<boolean>;
  getSkillMarketGitPreflight(signal?: AbortSignal): Promise<SkillMarketGitPreflightView>;
  listSkillMarketSources(signal?: AbortSignal): Promise<SkillMarketSourceCatalogView>;
  addSkillMarketSource(source: SkillMarketSourceDraft, expectedCatalogRevision: bigint, signal?: AbortSignal): Promise<void>;
  refreshSkillMarketSource(sourceId: string, expectedRevision: bigint, signal?: AbortSignal): Promise<void>;
  removeSkillMarketSource(sourceId: string, expectedRevision: bigint, signal?: AbortSignal): Promise<void>;
  listSkillMarketCatalog(options?: {
    readonly expectedRevision?: bigint;
    readonly query?: string;
    readonly category?: string;
    readonly sort?: SkillMarketSortView;
    readonly pageToken?: string;
    readonly pageSize?: number;
    readonly signal?: AbortSignal;
  }): Promise<SkillMarketCatalogPageView>;
  getSkillMarketEntry(identity: SkillMarketEntryIdentityView, signal?: AbortSignal): Promise<SkillMarketEntryView>;
  openSkillMarketPreview(identity: SkillMarketEntryIdentityView, signal?: AbortSignal): Promise<SkillMarketPreviewView>;
  listSkillMarketPreviewFiles(preview: SkillMarketPreviewView, pageToken?: string, pageSize?: number, signal?: AbortSignal): Promise<SkillMarketArchivePageView>;
  readSkillMarketPreviewFile(preview: SkillMarketPreviewView, key: string, signal?: AbortSignal): Promise<SkillMarketPreviewFileView>;
  closeSkillMarketPreview(previewId: string, signal?: AbortSignal): Promise<boolean>;
  createSkillMarketInstallPlan(identity: SkillMarketEntryIdentityView, target: SkillMarketInstallTargetView, signal?: AbortSignal): Promise<SkillMarketInstallPlanView>;
  getSkillMarketInstallPlan(planId: string, signal?: AbortSignal): Promise<SkillMarketInstallPlanView>;
  closeSkillMarketInstallPlan(planId: string, signal?: AbortSignal): Promise<boolean>;
  installSkillMarketPlan(plan: SkillMarketInstallPlanView, confirmReplacement: boolean, signal?: AbortSignal): Promise<SkillMutationResultView>;
  listSkillMarketSyncPolicies(signal?: AbortSignal): Promise<SkillMarketSyncCatalogView<SkillMarketSyncPolicyView>>;
  listSkillMarketSyncJobs(resourceId?: string, signal?: AbortSignal): Promise<SkillMarketSyncCatalogView<SkillMarketSyncJobView>>;
  getSkillMarketSyncJob(jobId: string, signal?: AbortSignal): Promise<SkillMarketSyncJobView>;
  enableSkillMarketSync(resourceId: string, expectedResourceRevision: bigint, target: SkillMarketInstallTargetView, signal?: AbortSignal): Promise<void>;
  disableSkillMarketSync(policy: SkillMarketSyncPolicyView, signal?: AbortSignal): Promise<void>;
  enqueueSkillMarketSync(policy: SkillMarketSyncPolicyView, signal?: AbortSignal): Promise<void>;
  cancelSkillMarketSync(job: SkillMarketSyncJobView, signal?: AbortSignal): Promise<void>;
  retrySkillMarketSync(job: SkillMarketSyncJobView, signal?: AbortSignal): Promise<void>;
  getSkillPublicationPreview(resourceId: string, expectedResourceRevision: bigint, sourceId: string, expectedSourceRevision: bigint, slug?: string, signal?: AbortSignal): Promise<SkillPublicationPreviewView>;
  listSkillPublicationJobs(resourceId?: string, signal?: AbortSignal): Promise<SkillMarketSyncCatalogView<SkillPublicationJobView>>;
  getSkillPublicationJob(jobId: string, signal?: AbortSignal): Promise<SkillPublicationJobView>;
  getCollaborationDirectory(signal?: AbortSignal): Promise<CollaborationDirectoryView>;
  createCollaborationScope(kind: CollaborationScopeKindView, name: string, expectedCatalogRevision: bigint, signal?: AbortSignal): Promise<void>;
  updateCollaborationScope(scope: CollaborationScopeView, name: string, signal?: AbortSignal): Promise<void>;
  deleteCollaborationScope(scope: CollaborationScopeView, signal?: AbortSignal): Promise<void>;
  updateSkillMarketAccess(entry: SkillMarketEntryView, collaborationRevision: bigint, selection: SkillPublicationAccessSelectionView, signal?: AbortSignal): Promise<void>;
  startSkillPublication(preview: SkillPublicationPreviewView, metadata: SkillPublicationMetadataView, access: SkillPublicationAccessSelectionView, signal?: AbortSignal): Promise<void>;
  cancelSkillPublication(job: SkillPublicationJobView, signal?: AbortSignal): Promise<void>;
  retrySkillPublication(job: SkillPublicationJobView, signal?: AbortSignal): Promise<void>;
  listCommands(sessionId: string): Promise<readonly RuntimeCommandView[]>;
  listSessionResources(sessionId: string, signal?: AbortSignal): Promise<readonly SessionResourceView[]>;
  listRuntimeProcesses(backendId: string, signal?: AbortSignal): Promise<RuntimeProcessUsageSnapshotView>;
  getUsageHistory(days?: number, backendId?: string, providerId?: string, signal?: AbortSignal): Promise<UsageHistoryView>;
  getUsageReport(query: UsageReportQueryView, signal: AbortSignal): Promise<UsageReportView>;
  listSshKeys(signal: AbortSignal): Promise<SshKeyCatalogView>;
  generateSshKey(draft: SshKeyGenerateDraft, signal: AbortSignal): Promise<SshKeyView>;
  addSshKeyToAgent(keyId: string, expectedFingerprint: string, passphrase: string | undefined, signal: AbortSignal): Promise<void>;
  readSshPublicKey(keyId: string, expectedFingerprint: string, signal: AbortSignal): Promise<string>;
  getSshKeyInstallCommand(draft: SshKeyInstallCommandDraft, signal: AbortSignal): Promise<string>;
  getModelPriceOverride(backendId: string, providerId: string, modelId: string, signal?: AbortSignal): Promise<ModelPriceOverrideView>;
  setModelPriceOverride(backendId: string, providerId: string, modelId: string, desired: ModelPriceQuoteView, signal?: AbortSignal): Promise<ModelPriceOverrideView>;
  resetModelPriceOverride(backendId: string, providerId: string, modelId: string, signal?: AbortSignal): Promise<ModelPriceOverrideView>;
  terminateRuntimeProcess(process: RuntimeProcessUsageView): Promise<void>;
  listRuntimeTools(sessionId: string): Promise<RuntimeToolCatalogView>;
  listExtensions(options?: {
    readonly source?: ExtensionCatalogEntryView["source"];
    readonly installed?: boolean;
    readonly query?: string;
    readonly sessionId?: string;
    readonly signal?: AbortSignal;
  }): Promise<ExtensionCatalogView>;
  getExtension(extensionId: string, sessionId?: string, signal?: AbortSignal): Promise<ExtensionCatalogView>;
  openExtensionMainView(extensionId: string, expectedRevision: bigint, signal?: AbortSignal): Promise<ExtensionMainViewSurfaceView>;
  getExtensionMainViewSurface(surfaceId: string, signal?: AbortSignal): Promise<ExtensionMainViewSurfaceView>;
  closeExtensionMainView(surfaceId: string, signal?: AbortSignal): Promise<boolean>;
  getExtensionLibraryOverview(extensionId: string, expectedRevision: bigint, signal?: AbortSignal): Promise<ExtensionLibraryOverviewView>;
  validateExtensionLibraryLocation(extensionId: string, expectedRevision: bigint, candidate: string, signal?: AbortSignal): Promise<ExtensionLibraryLocationValidationView>;
  relocateExtensionLibrary(extensionId: string, expectedRevision: bigint, destination: { readonly kind: "default" } | { readonly kind: "custom"; readonly candidate: string }, signal?: AbortSignal): Promise<{ readonly changed: boolean; readonly migrationId?: string; readonly location: ExtensionLibraryLocationView; readonly files: number; readonly bytes: bigint; readonly warnings: readonly string[]; readonly graceId?: string }>;
  rebindExtensionLibrary(extensionId: string, expectedRevision: bigint, candidate: string, signal?: AbortSignal): Promise<{ readonly location: ExtensionLibraryLocationView; readonly warnings: readonly string[] }>;
  unbindExtensionLibrary(extensionId: string, expectedRevision: bigint, signal?: AbortSignal): Promise<{ readonly detachedPath?: string }>;
  repairExtensionLibraryState(signal?: AbortSignal): Promise<{ readonly recoveredFromPrevious: boolean; readonly bindings: number; readonly trash: number }>;
  repairExtensionLibraryMetadata(extensionId: string, expectedRevision: bigint, signal?: AbortSignal): Promise<ExtensionLibraryOverviewView>;
  trashExtensionLibrary(extensionId: string, expectedRevision: bigint, confirmation: string, signal?: AbortSignal): Promise<ExtensionLibraryTrashEntryView>;
  listExtensionLibraryTrash(extensionId?: string, signal?: AbortSignal): Promise<readonly ExtensionLibraryTrashEntryView[]>;
  restoreExtensionLibraryTrash(trashId: string, confirmation: string, destination?: { readonly kind: "default" } | { readonly kind: "custom"; readonly candidate: string }, signal?: AbortSignal): Promise<{ readonly extensionId: string; readonly location: ExtensionLibraryLocationView }>;
  purgeExtensionLibraryTrash(trashId: string, confirmation: string, signal?: AbortSignal): Promise<boolean>;
  listExtensionLibraryGrace(extensionId?: string, signal?: AbortSignal): Promise<readonly ExtensionLibraryGraceEntryView[]>;
  rollbackExtensionLibrary(extensionId: string, expectedRevision: bigint, graceId: string, signal?: AbortSignal): Promise<{ readonly location: ExtensionLibraryLocationView; readonly graceId: string }>;
  purgeExpiredExtensionLibraries(signal?: AbortSignal): Promise<{ readonly trash: number; readonly grace: number }>;
  openExtensionLibrary(extensionId: string, expectedRevision: bigint, signal?: AbortSignal): Promise<ExtensionLibrarySessionView>;
  callExtensionLibrary(sessionId: string, call: ExtensionLibraryCallView, signal?: AbortSignal): Promise<ExtensionLibraryCallResultView>;
  closeExtensionLibrary(sessionId: string, signal?: AbortSignal): Promise<boolean>;
  getExtensionPackagePreview(extensionId: string, expectedRevision: bigint, backendId: string, signal?: AbortSignal): Promise<ExtensionPackagePreviewView>;
  adoptExtensionPackage(preview: ExtensionPackagePreviewView, allowSourceReplacement?: boolean, signal?: AbortSignal): Promise<void>;
  removeExtensionPackage(extensionId: string, expectedRevision: bigint, signal?: AbortSignal): Promise<void>;
  getExtensionPackageExportPreview(extensionId: string, expectedRevision: bigint, signal?: AbortSignal): Promise<ExtensionPackageExportPreviewView>;
  listExtensionPackageExports(extensionId?: string, signal?: AbortSignal): Promise<ExtensionPackageExportCatalogView>;
  getExtensionPackageExport(exportId: string, signal?: AbortSignal): Promise<ExtensionPackageExportJobView>;
  startExtensionPackageExport(preview: ExtensionPackageExportPreviewView, signal?: AbortSignal): Promise<ExtensionPackageExportJobView>;
  cancelExtensionPackageExport(exportId: string, expectedRevision: bigint, signal?: AbortSignal): Promise<ExtensionPackageExportJobView>;
  getExtensionSourceGitPreflight(signal?: AbortSignal): Promise<ExtensionSourceGitPreflightView>;
  listExtensionSources(signal?: AbortSignal): Promise<ExtensionSourceCatalogView>;
  addExtensionSource(source: ExtensionSourceDraft, expectedCatalogRevision: bigint): Promise<void>;
  refreshExtensionSource(sourceId: string, expectedRevision: bigint): Promise<void>;
  removeExtensionSource(sourceId: string, expectedRevision: bigint): Promise<void>;
  setExtensionEnabled(extensionId: string, enabled: boolean, expectedRevision: bigint): Promise<void>;
  setExtensionSidebarVisible(extensionId: string, visible: boolean, expectedRevision: bigint): Promise<void>;
  beginExtensionSetup(extensionId: string, expectedRevision: bigint): Promise<void>;
  submitExtensionSetupInteraction(
    extensionId: string,
    attemptId: string,
    fieldId: string,
    value: string | boolean,
    expectedRevision: bigint
  ): Promise<void>;
  saveExtensionSetupCredential(
    extensionId: string,
    attemptId: string,
    fieldId: string,
    kind: "apiKey" | "oauth" | "headerSecret",
    secret: string,
    expectedRevision: bigint,
    signal?: AbortSignal
  ): Promise<void>;
  completeExtensionSetup(extensionId: string, attemptId: string, expectedRevision: bigint): Promise<void>;
  cancelExtensionSetup(extensionId: string, attemptId: string, expectedRevision: bigint): Promise<void>;
  revokeExtensionSetup(extensionId: string, expectedRevision: bigint): Promise<void>;
  listBackgroundTasks(sessionId: string): Promise<readonly BackgroundTaskHistoryView[]>;
  cancelBackgroundTask(sessionId: string, backgroundTaskId: string): Promise<void>;
  listSubagentRuns(sessionId: string, state?: SubagentRunStateView, pageToken?: string, pageSize?: number): Promise<SubagentRunPageView>;
  getSubagentRun(sessionId: string, subagentRunId: string): Promise<SubagentRunDetailView>;
  listSubagentTranscript(sessionId: string, subagentRunId: string, childId?: string, pageToken?: string, pageSize?: number): Promise<SubagentTranscriptPageView>;
  controlSubagent(sessionId: string, subagentRunId: string, action: SubagentControlActionView, message?: string, childId?: string): Promise<void>;
  searchSessionMessages(query: string, pageToken?: string, pageSize?: number, scope?: SessionMessageSearchScopeView, filters?: SessionMessageSearchFiltersView): Promise<SessionMessageSearchPageView>;
  searchAllSessionMessages(query: string, options?: SessionMessageSearchCollectionOptions): Promise<SessionMessageSearchResultView>;
  loadSessionTimelinePage(sessionId: string, beforeCursor?: TimelineHistoryCursorView, limit?: number): Promise<TimelineHistoryPageView>;
  loadSessionTimelineAround(sessionId: string, eventId: string, limit?: number): Promise<readonly TimelineItemView[]>;
  listWorkspaceEntries(workspaceId: string, parentPath: string, options?: WorkspaceEntryListingOptionsView): Promise<readonly WorkspaceEntryView[]>;
  listWorkspaceEntryPage(workspaceId: string, parentPath: string, pageToken?: string, pageSize?: number, options?: WorkspaceEntryListingOptionsView): Promise<WorkspaceEntryPageView>;
  listWorkspaceFiles(workspaceId: string, signal?: AbortSignal): Promise<WorkspaceFileIndexView>;
  watchWorkspaceFileChanges(scope: WorkspaceFileChangeScopeView, signal?: AbortSignal): AsyncIterable<WorkspaceFileChangeView>;
  readWorkspaceHtmlSnapshot(sessionId: string, workspaceId: string, path: string, signal: AbortSignal): Promise<{ readonly file: { readonly workspaceId: string; readonly relativePath: string; readonly expectedRevision: string }; readonly html: string }>;
  readWorkspaceFile(workspaceId: string, path: string): Promise<WorkspaceFilePreviewView>;
  writeWorkspaceTextFile(workspaceId: string, draft: WorkspaceTextFileWriteDraft): Promise<WorkspaceTextFileWriteResultView>;
  searchWorkspace(workspaceId: string, query: string): Promise<readonly WorkspaceSearchMatchView[]>;
  searchWorkspacePage(workspaceId: string, request: WorkspaceSearchRequestView, signal?: AbortSignal): Promise<WorkspaceSearchPageView>;
  streamWorkspaceSearch(workspaceId: string, query: string, caseSensitive: boolean, signal?: AbortSignal): AsyncIterable<WorkspaceSearchStreamEventView>;
  createWorkspaceEntry(draft: WorkspaceEntryMutationDraft): Promise<void>;
  moveWorkspaceEntry(draft: WorkspaceEntryMoveDraft): Promise<void>;
  deleteWorkspaceEntry(draft: WorkspaceEntryDeleteDraft): Promise<void>;
  copyWorkspaceEntry(draft: WorkspaceEntryMoveDraft): Promise<void>;
  getWorkspaceDiff(workspaceId: string, query?: WorkspaceDiffQuery): Promise<WorkspaceDiffView>;
  readWorkspaceDiffFile(workspaceId: string, file: WorkspaceFileDiffView, diff: WorkspaceDiffView): Promise<WorkspaceFilePreviewView>;
  readWorkspaceDiffImage(workspaceId: string, file: WorkspaceFileDiffView, diff: WorkspaceDiffView): Promise<WorkspaceDiffImageView>;
  applyWorkspaceDiffHunk(workspaceId: string, draft: WorkspaceDiffHunkMutationDraft): Promise<void>;
  commitWorkspaceDiff(workspaceId: string, draft: WorkspaceGitCommitDraft): Promise<void>;
  pushWorkspaceBranch(workspaceId: string, draft: WorkspaceGitPushDraft): Promise<WorkspaceGitPushResultView>;
  listWorkspaceChangeSets(workspaceId: string, sessionId: string): Promise<readonly WorkspaceChangeSetView[]>;
  previewWorkspaceRewind(workspaceId: string, changeSetId: string): Promise<WorkspaceRewindPreviewView>;
  executeWorkspaceRewind(workspaceId: string, previewId: string, changeSetId: string, dialogueOnly: boolean): Promise<void>;
  restartBackend(backendId: string): Promise<void>;
  updateBackendSettings(backendId: string, patch: BackendSettingsUpdate): Promise<void>;
  renameDevice(deviceId: string, name: string): Promise<void>;
  setDeviceRemoteControlEnabled(enabled: boolean): Promise<void>;
  setDeviceControlTargetEnabled(targetDeviceId: string, enabled: boolean): Promise<void>;
  setDeviceControllerAllowed(controllerDeviceId: string, allowed: boolean): Promise<void>;
  revokeDevice(deviceId: string): Promise<void>;
  logoutConnection(connectionId: string): Promise<void>;
  saveProvider(draft: ProviderDraft, signal?: AbortSignal): Promise<void>;
  deleteProvider(providerId: string): Promise<void>;
  refreshProviderModels(backendId: string, providerId?: string, automatic?: boolean): Promise<void>;
  refreshManagedModelRuntimes(signal?: AbortSignal): Promise<readonly ManagedModelRuntimeView[]>;
  startManagedModelRuntime(runtimeId: string): Promise<ManagedModelRuntimeView>;
  installManagedModelRuntime(runtimeId: string): Promise<ManagedModelRuntimeView>;
  cancelManagedModelRuntimeInstall(runtimeId: string): Promise<ManagedModelRuntimeView>;
  pullManagedModel(runtimeId: string, modelName: string): Promise<ManagedModelRuntimeView>;
  pauseManagedModelPull(runtimeId: string, modelName: string): Promise<ManagedModelRuntimeView>;
  resumeManagedModelPull(runtimeId: string, modelName: string): Promise<ManagedModelRuntimeView>;
  cancelManagedModelPull(runtimeId: string, modelName: string): Promise<ManagedModelRuntimeView>;
  deleteManagedModel(runtimeId: string, modelName: string): Promise<ManagedModelRuntimeView>;
  beginProviderLogin(backendId: string, providerId: string, method: ProviderLoginMethodView): Promise<ProviderLoginFlowView>;
  getProviderLoginFlow(loginFlowId: string): Promise<ProviderLoginFlowView>;
  submitProviderLoginInput(flow: ProviderLoginFlowView, value: string): Promise<ProviderLoginFlowView>;
  cancelProviderLogin(loginFlowId: string): Promise<ProviderLoginFlowView>;
  refreshProviderCredential(backendId: string, providerId: string): Promise<void>;
  logoutProvider(backendId: string, providerId: string): Promise<void>;
  saveProviderCredentialSurface(backendId: string, providerId: string, surfaceId: string, secret: string): Promise<void>;
  clearProviderCredentialSurface(backendId: string, providerId: string, surfaceId: string): Promise<void>;
  saveCredential(draft: CredentialDraft, signal?: AbortSignal): Promise<void>;
  deleteCredential(credentialId: string): Promise<void>;
  getMessagingSettings(signal?: AbortSignal): Promise<MessagingSettingsView>;
  createTelegramMessagingConnection(
    ownerProviderUserId: string,
    configuration?: TelegramMessagingConfigurationView,
    signal?: AbortSignal
  ): Promise<MessagingConnectionView>;
  createDiscordMessagingConnection(
    ownerProviderUserId: string,
    configuration?: DiscordMessagingConfigurationView,
    signal?: AbortSignal
  ): Promise<MessagingConnectionView>;
  createDingTalkMessagingConnection(
    configuration: DingTalkMessagingConfigurationView,
    signal?: AbortSignal
  ): Promise<MessagingConnectionView>;
  createFeishuMessagingConnection(
    channel: "feishu" | "lark",
    configuration: FeishuMessagingConfigurationView,
    signal?: AbortSignal
  ): Promise<MessagingConnectionView>;
  createWeComMessagingConnection(
    configuration: WeComMessagingConfigurationView,
    signal?: AbortSignal
  ): Promise<MessagingConnectionView>;
  createWeChatMessagingConnection(signal?: AbortSignal): Promise<MessagingConnectionView>;
  createSlackMessagingConnection(
    ownerProviderUserId: string,
    configuration?: SlackMessagingConfigurationView,
    signal?: AbortSignal
  ): Promise<MessagingConnectionView>;
  beginWeChatAuthorization(
    connectionId: string,
    expectedRevision: bigint,
    expectedGeneration: bigint,
    signal?: AbortSignal
  ): Promise<WeChatAuthorizationAttemptView>;
  getWeChatAuthorization(
    attempt: WeChatAuthorizationAttemptView,
    signal?: AbortSignal
  ): Promise<WeChatAuthorizationAttemptView>;
  submitWeChatVerificationCode(
    attempt: WeChatAuthorizationAttemptView,
    code: string,
    signal?: AbortSignal
  ): Promise<WeChatAuthorizationAttemptView>;
  cancelWeChatAuthorization(
    attempt: WeChatAuthorizationAttemptView,
    signal?: AbortSignal
  ): Promise<WeChatAuthorizationAttemptView>;
  saveMessagingCredential(
    connectionId: string,
    expectedRevision: bigint,
    expectedGeneration: bigint,
    secret: string,
    enable: boolean,
    signal?: AbortSignal
  ): Promise<MessagingConnectionView>;
  clearMessagingCredential(
    connectionId: string,
    expectedRevision: bigint,
    expectedGeneration: bigint,
    signal?: AbortSignal
  ): Promise<MessagingConnectionView>;
  setMessagingConnectionEnabled(
    connectionId: string,
    expectedRevision: bigint,
    expectedGeneration: bigint,
    enabled: boolean,
    signal?: AbortSignal
  ): Promise<MessagingConnectionView>;
  updateTelegramMessagingConfiguration(
    connectionId: string,
    expectedRevision: bigint,
    expectedGeneration: bigint,
    ownerProviderUserId: string,
    configuration: TelegramMessagingConfigurationView,
    signal?: AbortSignal
  ): Promise<MessagingConnectionView>;
  updateDiscordMessagingConfiguration(
    connectionId: string,
    expectedRevision: bigint,
    expectedGeneration: bigint,
    ownerProviderUserId: string,
    configuration: DiscordMessagingConfigurationView,
    signal?: AbortSignal
  ): Promise<MessagingConnectionView>;
  updateDingTalkMessagingConfiguration(
    connectionId: string,
    expectedRevision: bigint,
    expectedGeneration: bigint,
    configuration: DingTalkMessagingConfigurationView,
    signal?: AbortSignal
  ): Promise<MessagingConnectionView>;
  updateFeishuMessagingConfiguration(
    connectionId: string,
    expectedRevision: bigint,
    expectedGeneration: bigint,
    configuration: FeishuMessagingConfigurationView,
    signal?: AbortSignal
  ): Promise<MessagingConnectionView>;
  updateWeComMessagingConfiguration(
    connectionId: string,
    expectedRevision: bigint,
    expectedGeneration: bigint,
    configuration: WeComMessagingConfigurationView,
    signal?: AbortSignal
  ): Promise<MessagingConnectionView>;
  updateSlackMessagingConfiguration(
    connectionId: string,
    expectedRevision: bigint,
    expectedGeneration: bigint,
    ownerProviderUserId: string,
    configuration: SlackMessagingConfigurationView,
    signal?: AbortSignal
  ): Promise<MessagingConnectionView>;
  testMessagingConnection(connectionId: string, signal?: AbortSignal): Promise<MessagingConnectionTestResultView>;
  putMessagingRoute(draft: MessagingRouteDraftView, signal?: AbortSignal): Promise<MessagingRouteView>;
  getPartnerDirectory(signal?: AbortSignal): Promise<PartnerDirectoryView>;
  listPartners(lifecycle?: PartnerLifecycleView, signal?: AbortSignal): Promise<PartnerListView>;
  getPartner(partnerId: string, signal?: AbortSignal): Promise<PartnerProfileView>;
  createPartner(expectedDirectoryRevision: bigint, draft: PartnerDraftView, signal?: AbortSignal): Promise<PartnerMutationView>;
  updatePartner(partnerId: string, expectedRevision: bigint, patch: PartnerPatchView, signal?: AbortSignal): Promise<PartnerMutationView>;
  setPartnerLifecycle(partnerId: string, expectedRevision: bigint, lifecycle: PartnerLifecycleView, signal?: AbortSignal): Promise<PartnerMutationView>;
  retryPartnerInitialization(partnerId: string, expectedRevision: bigint, signal?: AbortSignal): Promise<PartnerMutationView>;
  updatePartnerDefaults(expectedDirectoryRevision: bigint, capabilities: PartnerCapabilitiesView, signal?: AbortSignal): Promise<PartnerDefaultsMutationView>;
  listPartnerSessions(partnerId: string, signal?: AbortSignal): Promise<readonly PartnerSessionView[]>;
  markPartnerRead(partnerId: string, throughCursor: bigint, signal?: AbortSignal): Promise<PartnerActivityView>;
  listPartnerPrivateThreads(partnerId: string, signal?: AbortSignal): Promise<readonly PartnerPrivateThreadView[]>;
  getPartnerPrivateThread(partnerId: string, threadId: string, signal?: AbortSignal): Promise<PartnerPrivateThreadDetailView>;
  markPartnerPrivateThreadRead(partnerId: string, threadId: string, throughSequence: number, signal?: AbortSignal): Promise<PartnerPrivateThreadReadStateView>;
  listPartnerDelegations(partnerId: string, signal?: AbortSignal): Promise<readonly PartnerDelegationView[]>;
  getPartnerDelegation(partnerId: string, delegationId: string, signal?: AbortSignal): Promise<PartnerDelegationView>;
  cancelPartnerDelegation(partnerId: string, delegationId: string, expectedRevision: bigint, signal?: AbortSignal): Promise<PartnerDelegationView>;
  listCollaborationGoals(sessionId: string, includeArchived?: boolean, signal?: AbortSignal): Promise<readonly CollaborationGoalView[]>;
  getCollaborationGoal(goalId: string, viewerSessionId: string, signal?: AbortSignal): Promise<CollaborationGoalTreeView>;
  createCollaborationGoal(leadSessionId: string, expectedSessionGeneration: bigint, title: string, objective: string, maximumWorkers?: number, signal?: AbortSignal): Promise<CollaborationGoalTreeView>;
  setCollaborationGoalStatus(goal: CollaborationGoalView, status: Exclude<CollaborationGoalStatusView, "active">, signal?: AbortSignal): Promise<CollaborationGoalTreeView>;
  createCollaborationWorker(goal: CollaborationGoalView, draft: CollaborationWorkerDraftView, signal?: AbortSignal): Promise<CollaborationGoalTreeView>;
  updateCollaborationWorker(goal: CollaborationGoalView, worker: CollaborationWorkerView, patch: { readonly label?: string; readonly role?: string; readonly assignment?: string }, signal?: AbortSignal): Promise<CollaborationGoalTreeView>;
  focusCollaborationWorker(goal: CollaborationGoalView, worker?: CollaborationWorkerView, signal?: AbortSignal): Promise<CollaborationGoalTreeView>;
  wakeCollaborationWorker(goal: CollaborationGoalView, worker: CollaborationWorkerView, signal?: AbortSignal): Promise<CollaborationGoalTreeView>;
  stopCollaborationWorker(goal: CollaborationGoalView, worker: CollaborationWorkerView, signal?: AbortSignal): Promise<CollaborationGoalTreeView>;
  releaseCollaborationWorker(goal: CollaborationGoalView, worker: CollaborationWorkerView, signal?: AbortSignal): Promise<CollaborationGoalTreeView>;
  archiveCollaborationWorker(goal: CollaborationGoalView, worker: CollaborationWorkerView, signal?: AbortSignal): Promise<CollaborationGoalTreeView>;
  sendCollaborationWorkerMessage(goal: CollaborationGoalView, worker: CollaborationWorkerView, message: string, signal?: AbortSignal): Promise<CollaborationGoalTreeView>;
  interruptCollaborationWorker(goal: CollaborationGoalView, worker: CollaborationWorkerView, message: string, signal?: AbortSignal): Promise<{ readonly tree: CollaborationGoalTreeView; readonly stopOutcome: CollaborationInterruptStopOutcomeView }>;
  editCollaborationDispatch(dispatch: CollaborationDispatchView, queueItem: QueueItemView, message: string, signal?: AbortSignal): Promise<CollaborationGoalTreeView>;
  cancelCollaborationDispatch(dispatch: CollaborationDispatchView, queueItem: QueueItemView, signal?: AbortSignal): Promise<CollaborationGoalTreeView>;
  mergeCollaborationDispatches(goal: CollaborationGoalView, worker: CollaborationWorkerView, entries: readonly CollaborationQueueEntryView[], signal?: AbortSignal): Promise<CollaborationGoalTreeView>;
  getContactDirectory(signal?: AbortSignal): Promise<ContactDirectoryView>;
  setContactDirectoryEnabled(expectedRevision: bigint, enabled: boolean, signal?: AbortSignal): Promise<ContactDirectoryView>;
  listContacts(options?: ContactListOptionsView, signal?: AbortSignal): Promise<ContactListPageView>;
  getContact(contactId: string, signal?: AbortSignal): Promise<ContactProfileView>;
  findSimilarContacts(contact: ContactDraftView, signal?: AbortSignal): Promise<readonly ContactDuplicateCandidateView[]>;
  createContact(expectedDirectoryRevision: bigint, contact: ContactDraftView, confirmedNameCandidateIds?: readonly string[], signal?: AbortSignal): Promise<ContactCreateResultView>;
  updateContact(contactId: string, expectedRevision: bigint, patch: ContactPatchView, signal?: AbortSignal): Promise<ContactMutationView>;
  confirmContact(contactId: string, expectedRevision: bigint, signal?: AbortSignal): Promise<ContactMutationView>;
  deleteContact(contactId: string, expectedRevision: bigint, signal?: AbortSignal): Promise<ContactDirectoryView>;
  addContactIdentity(contactId: string, expectedContactRevision: bigint, identity: ContactIdentityInputView, signal?: AbortSignal): Promise<ContactMutationView>;
  removeContactIdentity(contactId: string, expectedContactRevision: bigint, contactIdentityId: string, signal?: AbortSignal): Promise<ContactMutationView>;
  appendContactEvent(contactId: string, expectedContactRevision: bigint, event: ContactEventInputView, signal?: AbortSignal): Promise<ContactMutationView>;
  removeContactEvent(contactId: string, expectedContactRevision: bigint, contactEventId: string, signal?: AbortSignal): Promise<ContactMutationView>;
  listContactGroups(signal?: AbortSignal): Promise<readonly ContactGroupView[]>;
  createContactGroup(expectedDirectoryRevision: bigint, name: string, description: string, signal?: AbortSignal): Promise<{ readonly group: ContactGroupView; readonly directory: ContactDirectoryView }>;
  updateContactGroup(contactGroupId: string, expectedRevision: bigint, name: string, description: string, signal?: AbortSignal): Promise<{ readonly group: ContactGroupView; readonly directory: ContactDirectoryView }>;
  deleteContactGroup(contactGroupId: string, expectedRevision: bigint, signal?: AbortSignal): Promise<ContactDirectoryView>;
  setContactGroupMembership(contactId: string, expectedContactRevision: bigint, contactGroupId: string, member: boolean, signal?: AbortSignal): Promise<ContactMutationView>;
  addContactRelation(fromContactId: string, expectedFromRevision: bigint, toContactId: string, relation: string, note: string, signal?: AbortSignal): Promise<ContactMutationView>;
  updateContactRelation(ownerContactId: string, expectedOwnerRevision: bigint, contactRelationId: string, expectedRelationRevision: bigint, relation: string, note: string, signal?: AbortSignal): Promise<ContactMutationView>;
  removeContactRelation(ownerContactId: string, expectedOwnerRevision: bigint, contactRelationId: string, signal?: AbortSignal): Promise<ContactMutationView>;
  scanContactDuplicates(limit?: number, signal?: AbortSignal): Promise<{ readonly pairs: readonly ContactDuplicatePairView[]; readonly directory: ContactDirectoryView }>;
  mergeContacts(targetContactId: string, expectedTargetRevision: bigint, mergedContactId: string, expectedMergedRevision: bigint, signal?: AbortSignal): Promise<ContactMergeResultView>;
  previewContactVCardImport(vcardText: string, signal?: AbortSignal): Promise<ContactVCardImportPreviewView>;
  commitContactVCardImport(previewId: string, expectedDirectoryRevision: bigint, decisions: readonly ContactVCardImportDecisionView[], signal?: AbortSignal): Promise<ContactVCardImportResultView>;
  exportContactsVCard(contactIds?: readonly string[], signal?: AbortSignal): Promise<ContactVCardExportView>;
  getContactSyncStatus(signal?: AbortSignal): Promise<ContactSyncStatusView>;
  setContactSyncEnabled(expectedConfigurationRevision: bigint, enabled: boolean, signal?: AbortSignal): Promise<ContactSyncStatusView>;
  grantContactSyncPeer(nodeId: string, expectedFingerprint: string, signal?: AbortSignal): Promise<ContactSyncStatusView>;
  revokeContactSyncPeer(peerId: string, expectedRevision: bigint, signal?: AbortSignal): Promise<ContactSyncStatusView>;
  syncContactsNow(peerId?: string, signal?: AbortSignal): Promise<ContactSyncStatusView>;
  getRemoteHostCapabilities(targetId: string, signal?: AbortSignal): Promise<RemoteHostCapabilitiesView>;
  listRemoteHosts(targetId: string, signal?: AbortSignal): Promise<readonly RemoteHostView[]>;
  listRemoteHostDirectories(targetId: string, hostId: string, expectedTargetRevision: bigint, expectedHostRevision: bigint, path: string, signal?: AbortSignal): Promise<RemoteHostDirectoryListingView>;
  inspectRemoteHostDirectory(targetId: string, hostId: string, expectedTargetRevision: bigint, expectedHostRevision: bigint, path: string, signal?: AbortSignal): Promise<RemoteHostDirectoryInspectionView>;
  watchRemoteHosts(targetId: string, signal?: AbortSignal): AsyncIterable<readonly RemoteHostView[]>;
  refreshRemoteHostCatalog(targetId: string): Promise<readonly RemoteHostView[]>;
  createRemoteHost(targetId: string, draft: RemoteHostDraft): Promise<RemoteHostView>;
  updateRemoteHost(targetId: string, hostId: string, expectedRevision: bigint, draft: RemoteHostDraft): Promise<RemoteHostView>;
  deleteRemoteHost(targetId: string, hostId: string, expectedRevision: bigint): Promise<void>;
  connectRemoteHost(targetId: string, hostId: string, expectedRevision: bigint): Promise<RemoteHostView>;
  disconnectRemoteHost(targetId: string, hostId: string, expectedRevision: bigint): Promise<RemoteHostView>;
  testRemoteHostConnection(targetId: string, hostId: string, expectedRevision: bigint): Promise<RemoteHostView>;
  clearRemoteHostTrust(targetId: string, hostId: string, expectedRevision: bigint): Promise<RemoteHostView>;
  probeRemoteBackendRuntime(targetId: string, hostId: string, expectedTargetRevision: bigint, expectedHostRevision: bigint, signal?: AbortSignal): Promise<RemoteBackendRuntimeView>;
  installRemoteBackendRuntime(targetId: string, hostId: string, expectedTargetRevision: bigint, expectedHostRevision: bigint, reinstall: boolean, signal?: AbortSignal): AsyncIterable<RemoteBackendRuntimeInstallEventView>;
  uninstallRemoteBackendRuntime(targetId: string, hostId: string, expectedTargetRevision: bigint, expectedHostRevision: bigint): Promise<RemoteBackendRuntimeView>;
  saveMcpServer(draft: McpServerDraft): Promise<void>;
  deleteMcpServer(serverId: string): Promise<void>;
  restartMcpServer(serverId: string): Promise<void>;
  updatePiSettings(backendId: string, patch: { readonly autoCompaction?: boolean; readonly autoCompactionThresholdPercent?: number; readonly resetAutoCompactionThresholdPercent?: boolean; readonly autoRetry?: boolean; readonly steeringMode?: "all" | "oneAtATime"; readonly followUpMode?: "all" | "oneAtATime" }): Promise<void>;
  updateBrowserSettings(browserProviderId: string, patch: BrowserSettingsPatchView): Promise<void>;
  updateVoiceInputServiceSettings(draft: VoiceInputServiceSettingsDraft): Promise<void>;
  showBrowserAutomation(browserProviderId: string, targetId: string): Promise<void>;
  updateComputerAutomationSettings(enabled: boolean): Promise<void>;
  installComputerAutomation(): Promise<void>;
  probeComputerAutomation(fresh?: boolean): Promise<void>;
  requestComputerAutomationPermission(permission: "accessibility" | "screenRecording" | "all"): Promise<void>;
  cancelComputerAutomationPermission(): Promise<void>;
  openComputerAutomationPermissionSettings(permission: "accessibility" | "screenRecording"): Promise<void>;
  checkComputerAutomationUpdate(fresh?: boolean): Promise<void>;
  updateComputerAutomationDriver(joinOnly?: boolean): Promise<void>;
  updateAndroidAutomationSettings(enabled: boolean): Promise<void>;
  prepareAndroidAdb(): Promise<void>;
  probeAndroidAutomation(fresh?: boolean): Promise<void>;
  selectAndroidAutomationDevice(deviceSerial?: string): Promise<void>;
  setAndroidAdbPath(serverPath?: string): Promise<void>;
  updatePolicy(patch: Partial<SettingsView["policy"]>): Promise<void>;
  updateDiagnostics(patch: Partial<SettingsView["diagnostics"]>): Promise<void>;
  updateMessageSearchSettings(enabled: boolean): Promise<void>;
  resetMessageSearchSettings(): Promise<void>;
  updateMemorySettings(patch: {
    readonly makerEnabled?: boolean;
    readonly backendId?: string;
    readonly backendEnabled?: boolean;
  }): Promise<void>;
  restoreMemoryDefaults(): Promise<void>;
  resetMemory(scope: "curated" | "backend", backendId?: string): Promise<{
    readonly removedEntries?: number;
    readonly removedTargets?: number;
  }>;
  updateVisionBridgeSettings(patch: {
    readonly enabled?: boolean;
    readonly targetModels?: readonly ModelRouteRefView[];
    readonly primary?: ModelRouteRefView | null;
    readonly fallback?: ModelRouteRefView | null;
    readonly resetAll?: boolean;
    readonly resetTargetModels?: boolean;
  }): Promise<void>;
  updatePromptRecommendationSettings(enabled: boolean): Promise<void>;
  updateAuxiliaryTextSettings(models: readonly ModelRouteRefView[], expectedRevision: bigint): Promise<void>;
  updateSubagentModelSettings(backendId: string, model: SubagentModelSettingsView["model"], expectedRevision: bigint): Promise<void>;
  updateSubagentSmartRouting(backendId: string, enabled: boolean, expectedRevision: bigint): Promise<void>;
  resetPromptRecommendationSettings(): Promise<void>;
  updateLanguageToolSettings(enabled: boolean): Promise<void>;
  updateToolPolicySettings(
    toolProviderId: string,
    targetId: string | undefined,
    patch: { readonly enabled: boolean } | { readonly reset: true }
  ): Promise<void>;
  updateAgentResourceSettings(patch: Partial<Pick<AgentResourceSettingsView,
    "maxConcurrentCommands" | "processPriority" | "capToolchainThreads">> | { readonly resetAll: true }): Promise<void>;
  updateCollaborationSettings(patch: Partial<Pick<CollaborationSettingsView,
    "workerSoftLimit" | "workerHardLimit" | "workerIdleReleaseMinutes">> | { readonly resetAll: true }): Promise<void>;
  updateGitSafetySettings(patch: { readonly autoSnapshotEnabled: boolean } | { readonly resetAll: true }): Promise<void>;
  cleanupGitSafetySavepoints(): Promise<void>;
  predictNextPrompt(sessionId: string, expectedLastActivityAt: number, expectedGeneration: bigint, signal: AbortSignal): Promise<string>;
  setSilentEncryptedRetryEnabled(enabled: boolean): Promise<void>;
  resetSilentEncryptedRetry(): Promise<void>;
  setSessionRuntimeFallbackEnabled(enabled: boolean): Promise<void>;
  resetSessionRuntimeFallback(): Promise<void>;
  createDiagnosticsBundle(): Promise<ArtifactView>;
  installResource(resourceId: string): Promise<ResourceView>;
  updateResource(resourceId: string): Promise<ResourceView>;
  captureBrowserScreenshot(browserId: string, pageId: string, fullPage: boolean): Promise<string>;
  getArtifactUrl(blobId: string): Promise<string>;
  releaseArtifactUrl(blobId: string): void;
  downloadArtifact(blobId: string, fileName: string, context: ArtifactDownloadContext): Promise<ArtifactDownloadOutcome>;
  copyArtifactFile(blobId: string, fileName: string, byteSize: number, context: ArtifactDownloadContext): Promise<import("./native-file-actions.js").NativeFileCopyOutcome>;
  openArtifactFile(blobId: string, fileName: string, byteSize: number, context: ArtifactDownloadContext): Promise<import("./native-file-actions.js").NativeFileOpenOutcome>;
  revealArtifactSource(sessionId: string, artifactId: string, context: ArtifactDownloadContext): Promise<import("./native-file-actions.js").NativeArtifactSourceRevealOutcome>;
}

export function emptySnapshot(): AppSnapshot {
  return {
    revision: 0n,
    cursor: 0n,
    generation: 0n,
    server: { name: "Joko", version: "", health: "unavailable" },
    backends: [],
    models: [],
    providers: [],
    targets: [],
    sessions: [],
    backgroundTasks: [],
    timelineBySession: new Map(),
    timelineHistoryRevisionBySession: new Map(),
    extensionWidgetsBySession: new Map(),
    extensionStatusesBySession: new Map(),
    queue: [],
    queueControls: [],
    interactions: [],
    reviewRuns: [],
    workspaces: [],
    schedules: [],
    browsers: [],
    extraDirectories: [],
    resources: [],
    extensions: [],
    extensionCatalogRevision: 0n,
    extensionCatalogRecovered: false,
    commands: [],
    remoteConnections: [],
    devices: [],
    deviceControlRelations: [],
    settings: {
      revision: 0n,
      providers: [],
      credentials: [],
      mcpServers: [],
      browsers: [],
      computerAutomation: {
        enabled: false,
        support: "unspecified",
        supportReason: "",
        installed: false,
        driverVersion: "",
        daemonRunning: false,
        accessibilityPermission: "unknown",
        screenRecordingPermission: "unknown",
        screenRecordingCapturable: false,
        ready: false,
        runtimeState: "disabled",
        failureReason: "",
        platform: "unknown",
        updateCurrentVersion: "",
        updateLatestVersion: "",
        updateAvailable: false,
        updateInProgress: false,
        updatePhase: "idle"
      },
      androidAutomation: {
        enabled: false,
        support: "unspecified",
        supportReason: "",
        adbAvailable: false,
        adbPath: "",
        adbPathSource: "unspecified",
        preparationSupported: false,
        preparationReady: false,
        preparationError: "",
        adbVersion: "",
        devices: [],
        defaultDeviceSerial: "",
        configuredDefaultDeviceSerial: "",
        adbPathOverride: "",
        issue: "unspecified",
        failureReason: "",
        platform: "unknown",
        runtimeState: "disabled",
        statusObserved: false
      },
      languageTools: { enabled: false },
      toolPolicies: [],
      agentResource: {
        maxConcurrentCommands: 0,
        processPriority: "normal",
        capToolchainThreads: false,
        customized: false,
        revision: 0n
      },
      collaboration: {
        workerSoftLimit: 5,
        workerHardLimit: 8,
        workerIdleReleaseMinutes: 0,
        customized: false,
        revision: 0n
      },
      gitSafety: {
        autoSnapshotEnabled: false,
        pendingTurns: 0,
        trackedSessions: 0,
        trackedRepositories: 0,
        cleanupAvailable: false,
        customized: false,
        revision: 0n
      },
      voiceInput: {
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
      },
      backendSettings: [],
      pi: [],
      policy: { defaultMode: "ask", projectTrustRequired: true, redactCredentials: true, stripChildProcessCredentials: true, ruleCount: 0 },
      diagnostics: { level: "standard", retentionSeconds: 0, includeSanitizedBackendPayloads: false, includePerformanceMetrics: false },
      messageSearch: {
        semanticIndexEnabled: true,
        vectorAvailable: false,
        embeddingProviderAvailable: false,
        modelId: "voyage/voyage-4",
        pendingCount: 0,
        runningCount: 0,
        doneCount: 0,
        failedCount: 0,
        customized: false
      },
      memory: {
        makerEnabled: true,
        makerSupported: false,
        makerReason: "Maker Memory is unavailable.",
        customized: false,
        entryCount: 0,
        backends: []
      },
      visionBridge: {
        enabled: false,
        targetModels: [],
        available: false,
        unavailableReason: "Vision Bridge is unavailable.",
        customized: false,
        customizedFields: []
      },
      subagentModels: [],
      auxiliaryText: {
        models: [], automaticModels: [], options: [], available: false,
        unavailableReason: "Auxiliary text routing is unavailable.", revision: 0n, runtimeRevision: ""
      },
      promptRecommendation: {
        enabled: true,
        available: false,
        unavailableReason: "Prompt recommendation is unavailable.",
        customized: false
      },
      personalization: {
        silentEncryptedRetryEnabled: true,
        silentEncryptedRetryCustomized: false,
        sessionRuntimeFallbackEnabled: false,
        sessionRuntimeFallbackCustomized: false
      }
    },
    diagnostics: []
  };
}
