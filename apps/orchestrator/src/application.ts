import { createHash, randomUUID } from "node:crypto";
import { publicConnectionCapabilities } from './connection-entries.js';
import { ManagedProviderProxy } from "./managed-provider-proxy.js";
import { answerDeliveryPrompt } from "./answer-delivery-prompt.js";
import { createHostedAgentAutoReviewer } from "./hosted-agent-auto-review.js";
import { richAnswerText } from "@joko/contracts";
import { lstat, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import {
  createClaudeCodeAdapter,
  CLAUDE_MANAGED_PROVIDER_SUPPORT,
  type ClaudeCodeCredentialPort
} from "@joko/adapter-claude-code";
import {
  CodexBackendAdapter,
  createCodexAdapter,
  CODEX_MANAGED_PROVIDER_SUPPORT,
  prepareCodexSmartRouting
} from "@joko/adapter-codex";
import {
  createPiAdapter,
  createDefaultManagedProcessSupervisor,
  createManagedSubagentRunnerProcessInspector,
  MANAGED_SUBAGENT_RUNNER_SOURCE,
  managedSubagentRunRoot,
  PiBackendAdapter,
  PI_AUTO_COMPACTION_THRESHOLD_PERCENT_DEFAULT,
  PI_AUTO_COMPACTION_THRESHOLD_PERCENT_MAXIMUM,
  PI_AUTO_COMPACTION_THRESHOLD_PERCENT_MINIMUM,
  type PiMcpBridgeOptions,
  type PiManagedSettings
} from "@joko/adapter-pi";
import {
  createAuthenticatedCodeHostProvider,
  createPublicCodeHostProvider,
  type CodeHostProvider,
  type CodeHostSessionAuthorizationPort
} from "@joko/code-host";
import {
  HOST_COMPOSED_CAPABILITIES,
  type AdapterContext,
  type BackendAdapter,
  type BackendAuthenticationState,
  type BackendDescriptor,
  type KnownCapability,
  type ProviderAccountUsageSnapshot,
  type TargetDescriptor
} from "@joko/core";
import { JOKO_API_VERSION } from "@joko/contracts";
import {
  FileSshConfigPort,
  Ssh2ResolvedAgentAuthConnector,
  SshKeyManager,
  type ResolvedAgentAuthConnectorPort,
  type SshConfigFilePort
} from "@joko/remote-ssh";
import { createCommandConcurrencyGate } from "@joko/runtime-governance";
import { createSocks5Dispatcher } from "@joko/outbound-network";
import { ContactStore, NotFoundError, OperationalStore, PartnerStore, PartnerWorkbenchStore, VoiceDictionaryPeerStore } from "@joko/store";
import { GitSafetyCoordinator, NodeGitCommandRunner, ProjectGitBootstrap } from "@joko/git-safety";
import { AndroidAutomationRuntimeFactory } from "@joko/tool-android";
import { BrowserProvider, type BrowserActivity } from "@joko/tool-browser";
import { TerminalProvider } from "@joko/tool-terminal";
import { RemoteTerminalRuntimeResolver } from "./remote-terminal-runtime.js";
import { RemoteCodexRuntimeResolver } from "./remote-codex-read-runtime.js";
import { CodexMcpBridgeManager } from "./remote-codex-mcp-bridge.js";
import { createClaudeMcpBridge } from "./claude-mcp-bridge.js";
import { RemoteClaudeRuntimeResolver } from "./remote-claude-runtime.js";
import { createRemoteClaudeDerivedWorkspaceAuthorizer } from "./remote-claude-derived-workspace-authority.js";
import { RemoteClaudeWorktreeOwner } from "./remote-claude-worktree-owner.js";
import {
  ComputerRuntime,
  ComputerToolProvider,
  type ComputerPermissionGrant,
  type ComputerRuntimeStatus
} from "@joko/tool-computer";
import { ProxyAgent, fetch as proxyFetch, type Dispatcher } from "undici";

import { OperationalArtifactRepository } from "./artifact-repository.js";
import { createArtifactMentionResolver } from "./artifact-mention-resolver.js";
import { ArtifactMaintenance } from "./artifact-maintenance.js";
import { AndroidAutomationSettingsController } from "./android-automation-settings.js";
import {
  ManagedAndroidAdbPreparer,
  androidPlatformToolsTarget,
  managedAndroidAdbPreparationSupported
} from "./android-platform-tools.js";
import { AndroidRuntimeSupervisor } from "./android-runtime-supervisor.js";
import { AndroidToolBridgeProvider } from "./android-tool-bridge.js";
import { ArtifactStore } from "./artifact-store.js";
import { BlobTransferCoordinator } from "./blob-transfers.js";
import { BackendInstanceRegistry } from "./backend-instance-registry.js";
import { HostedAgentRuntime } from "./hosted-agent-runtime.js";
import { HostedAgentSources } from "./hosted-agent-sources.js";
import { HostedAgentSourceResourceCatalog } from "./hosted-agent-source-resource-catalog.js";
import { InputHandoffCoordinator } from "./input-handoff/coordinator.js";
import { NativeInputHandoffHost } from "./input-handoff/native-host.js";
import { InputHandoffNotifications } from "./input-handoff/notifications.js";
import { InputHandoffTools, INPUT_HANDOFF_TOOL_PROVIDER_ID } from "./input-handoff-tools.js";
import { createProviderSharingRuntime, type ProviderSharingRuntime } from "./provider-sharing-runtime.js";
import { ExtensionDeviceSync } from "./extension-device-sync.js";
import { ProviderGroupRuntime } from "./provider-group-runtime.js";
import { createProviderGroupHostedEndpoint } from "./provider-group-hosted.js";
import { createHostedNativeTextInference } from "./hosted-native-text-inference.js";
import { DesktopVoiceConversationManager } from "./voice-conversation/manager.js";
import { SpeechModelCatalog } from "./voice-conversation/models.js";
import { createSpeechFetch } from "./voice-conversation/fetch.js";
import { createHostedAgentCodexAdapter } from "./hosted-agent-codex-factory.js";
import { createHostedAgentClaudeAdapter } from "./hosted-agent-claude-factory.js";
import { policySnapshotFor } from "./policy-settings.js";
import {
  backendModelAccessRestricted,
  modelRoutingEnabled,
  providerRoutingEnabled
} from "./backend-model-access.js";
import {
  AuthenticatedBrowserRemoteNodeRouter,
  BrowserAutomationNodeExecutor
} from "./browser-automation-node.js";
import { BrowserSettingsController } from "./browser-settings.js";
import {
  ComputerAutomationSettingsController,
  type ComputerAutomationProbe,
  type ComputerAutomationRuntime
} from "./computer-automation-settings.js";
import { ComputerToolBridgeProvider } from "./computer-tool-bridge.js";
import { BrowserToolBridgeProvider } from "./browser-tool-bridge.js";
import { BrowserTransferCoordinator } from "./browser-transfers.js";
import { BrowserUserKnowledgeStore } from "./browser-user-knowledge-store.js";
import { ConnectionManager } from "./connection-manager.js";
import { isLoopbackHost, type OrchestratorConfig } from "./config.js";
import {
  CredentialManager,
  ProviderCatalogManager
} from "./credential-manager.js";
import { CredentialVault } from "./credential-vault.js";
import { openLinkspanIdentity } from "./linkspan-identity.js";
import { advertisedLinkspanOrigin } from "./linkspan-connector.js";
import type { Identity as LinkspanIdentity } from "@jokoagent/linkspan-noise";
import { McpAppsManager } from "./mcp-apps/manager.js";
import { McpAppSurfaces } from "./mcp-apps/surface.js";
import { TaskSharingHome } from "./task-sharing-home.js";
import { ApnsMobilePushProvider } from "./apns-mobile-push-provider.js";
import {
  MobilePushCoordinator,
  type MobilePushProviderPort
} from "./mobile-push.js";
import { DiagnosticsBundleService } from "./diagnostics-bundle.js";
import { DocumentToolBridgeProvider } from "./document-tool-provider.js";
import { ChromiumDocumentPdfRenderer } from "./document-pdf-renderer.js";
import { ElectronDocumentPdfRenderer } from "./document-electron-pdf-renderer.js";
import { ExtensionCatalogManager } from "./extension-catalog.js";
import { ExtensionProjectPolicies } from "./extension-project-policy.js";
import { ExtensionLibraryManager } from "./extension-library-manager.js";
import { ExtensionMainViewManager } from "./extension-main-view-manager.js";
import { ExtensionSettingsManager } from "./extension-settings.js";
import { ExtensionDirectoryPicker } from "./extension-directory-picker.js";
import { ExtensionPackagePublisher } from "./extension-package-publisher.js";
import { ExtensionTasks } from "./extension-tasks.js";
import { createExtensionTaskNativeReviewer } from "./extension-task-native-reviewer.js";
import { ExtensionText } from "./extension-text.js";
import { ExtensionSourceManager } from "./extension-source-manager.js";
import { HistoryMaintenance } from "./history-maintenance.js";
import {
  ImageGenerationBridgeToolProvider,
  IMAGE_GENERATION_RESPONSE_MAXIMUM_BYTES
} from "./image-generation-bridge-tool-provider.js";
import { LanDiscoveryService } from "./lan-discovery.js";
import {
  LANGUAGE_TOOL_SETTING_KEY,
  LspToolBridgeProvider,
  languageToolsEnabled,
  resolveAuthenticatedLspTarget
} from "./lsp-tool-bridge.js";
import { MakerMemoryBridgeProvider, MakerMemoryController } from "./maker-memory.js";
import { PartnerMemoryPreferences } from "./partner-memory-preferences.js";
import { PartnerConnectionPreferences, PartnerConnectionsManager } from "./partner-connections.js";
import { PartnerRuntimePromptResolver } from "./partner-runtime-prompt.js";
import { partnerReplyQuoteContext } from './partner-topic-context.js';
import { PartnerGroupStore, PartnerNetworkStore } from "@joko/store";
import { PartnerGroupSessionRuntime } from "./partner-group-runtime.js";
import { PartnerNetworkHost } from "./partner-network-host.js";
import { PartnerNetworkHome } from "./partner-network-home.js";
import { PartnerNetworkRuntime } from "./partner-network-runtime.js";
import { PartnerIdentityDirectory } from "./partner-identity-directory.js";
import { PartnerGroupManager } from "./partner-group-manager.js";
import { PartnerGroupWorkspaces } from "./partner-group-workspaces.js";
import { PartnerNetworkPlanWorkspaces } from "./partner-network-plan-workspaces.js";
import { PartnerGroupAttachments } from "./partner-group-attachments.js";
import { PLAN_DECISION_SYSTEM_PROMPT, buildPlanDecisionPrompt, parsePlanDecision } from "./partner-group-division.js";
import { MessagingManager, type MessagingManagerOptions } from "./messaging-manager.js";
import type { WeChatAuthorizationPort } from "./wechat-authorization-manager.js";
import type { ManagedModelRuntimeRegistry } from "./managed-model-runtime-registry.js";
import { createManagedModelRuntimeSystem, type ManagedModelRuntimeSystem } from "./managed-model-runtime-system.js";
import type { ModelWorkingContextCoordinator } from "./model-working-context.js";
import { composeModelWorkingContext } from "./model-working-context-system.js";
import { createOutboundStreamingFetch } from "./outbound-streaming-fetch.js";
import { LocalCodexRuntime } from "./local-codex-runtime.js";
import { createNativeCodexExecution } from "./native-codex-execution.js";
import { ManagedChildWorktreeOwner } from "./managed-child-worktree-owner.js";
import { McpRouter, type PiMcpBridgeSnapshot } from "./mcp-router.js";
import { NativeAuthRecoveryStore } from "./native-auth-recovery.js";
import { ProviderCredentialSurfaceResolver } from "./provider-credential-surface.js";
import { MessageSearchEmbeddingCoordinator } from "./message-search-embedding.js";
import {
  createModelRouteCatalog,
  PromptPredictionService,
  VisionBridgeCoordinator
} from "./personalization-inference.js";
import { SessionNavigationCoordinator } from "./session-navigation-coordinator.js";
import { AuxiliaryTextRouting } from "./auxiliary-text-routing.js";
import { createWorktreeRecycleSafetyCheck } from "./worktree-recycle-safety.js";
import { PersonalDevelopmentError, PersonalDevelopmentOwner, createSupervisedDevelopmentProcessAuthority } from "@joko/personal-development";
import { PersonalDevelopmentCoordinator, personalDevelopmentOwnerIdentity } from "./personal-development-coordinator.js";
import { PersonalDevelopmentNativeBroker } from "./personal-development-native-broker.js";
import { PersonalDevelopmentReportTools } from "./personal-development-report-tools.js";
import { createPersonalDevelopmentWorktreeAuthority } from "./personal-development-worktree.js";
import { PersonalDevelopmentDoctor } from "./personal-development-doctor.js";
import { createPersonalDevelopmentDoctorPrerequisites } from "./personal-development-doctor-environment.js";
import { HelpAssistant } from "./help-assistant.js";
import { HelpFeedbackStore } from "./help-feedback-store.js";
import { SubagentModelSettings } from "./subagent-model-settings.js";
import { ModelFavoriteSettings } from "./model-favorite-settings.js";
import { modelSourceCatalogModels, modelSourceFavoriteUnavailableReason } from "./model-source-catalog.js";
import { DeferredBackendRestartCoordinator } from "./deferred-backend-restart.js";
import { VisionBridgeToolProvider } from "./vision-bridge-tool-provider.js";
import { OperationalBrowserState } from "./operational-browser-state.js";
import { OperationalWorkspaceSnapshotRepository } from "./operational-workspace-snapshots.js";
import { PiProviderAuthSupervisor } from "./pi-provider-auth-supervisor.js";
import { ProviderAccountUsageProvider } from "./provider-account-usage.js";
import { PiResourceManager, inspectPiSkillPackage } from "./resource-manager.js";
import { BuiltinSkillCatalog } from "./builtin-skills.js";
import { PluginAuthoringTools } from "./plugin-authoring-tools.js";
import { RemoteSkillSourceOwner } from "./remote-skill-source.js";
import { SkillManager } from "./skill-manager.js";
import { SkillLearningManager } from "./skill-learning-manager.js";
import { SkillMarketManager } from "./skill-market-manager.js";
import { SkillMarketSyncManager } from "./skill-market-sync-manager.js";
import { SkillMutationCoordinator } from "./skill-mutation-coordinator.js";
import { PartnerSkillsManager, PartnerSkillsToolProvider } from "./partner-skills.js";
import { PartnerLearningManager } from "./partner-learning.js";
import { PartnerCapabilityTools } from "./partner-capability-tools.js";
import { PartnerProfileTools } from "./partner-profile-tools.js";
import { AppDefaultModelCoordinator } from "./app-default-model.js";
import { AppDefaultModelTools } from "./app-default-model-tools.js";
import { SkillPublicationManager } from "./skill-publication-manager.js";
import { CollaborationManager } from "./collaboration-manager.js";
import { CollaborationGoalManager } from "./collaboration-goal-manager.js";
import { ExtensionTargets } from "./extension-targets.js";
import { ObjectiveManager } from "./objective-manager.js";
import { CollaborationToolBridgeProvider } from "./collaboration-tool-provider.js";
import { ContactManager } from "./contact-manager.js";
import { ContactSyncManager } from "./contact-sync-manager.js";
import { ContactToolBridgeProvider } from "./contact-tool-provider.js";
import { PartnerManager, partnerSessionRuntimeFallback } from "./partner-manager.js";
import { PartnerHomeOwner, PartnerHomeStorage } from "./partner-home-owner.js";
import { PartnerHomeFiles } from "./partner-home-files.js";
import { PartnerHomeRuntimeAdapter } from "./partner-home-runtime.js";
import { PartnerHomeSnapshots } from "./partner-home-snapshot.js";
import { PartnerHomeInference } from "./partner-home-inference.js";
import { PartnerHomeProjects } from "./partner-home-projects.js";
import { PartnerHomeWorkbench } from "./partner-home-workbench.js";
import { PartnerSessionTaskManager } from "./partner-session-tasks.js";
import { PartnerSessionTaskGroupPublisher } from "./partner-session-task-group-publisher.js";
import { PartnerSessionTaskTools } from "./partner-session-task-tools.js";
import { PartnerRoutineStore } from "@joko/store";
import { PartnerRoutineManager } from "./partner-routine-manager.js";
import { PartnerAutonomyManager } from "./partner-autonomy.js";
import { PartnerTodoManager, PartnerTodoTools } from "./partner-todos.js";
import { PartnerMessagingRuntime, PartnerMessagingTools } from './partner-messaging.js';
import { PartnerRoutineTools } from "./partner-routine-tools.js";
import { PartnerImportManager } from "./partner-import-manager.js";
import { partnerPackageOpening } from "./partner-package-opening.js";
import { PartnerImportStorage } from "./partner-import-storage.js";
import { PartnerImportRuntime } from "./partner-import-runtime.js";
import { adoptPartnerImportSettings, createPartnerImportEffects, preparePartnerImportCreation } from "./partner-import-effects.js";
import { ExtensionRoutineRuntime } from "./extension-routine-runtime.js";
import { ExtensionCardRuntime } from "./extension-cards/runtime.js";
import { ExtensionNetworkConnections } from "./extension-cards/network-connections.js";
import { ExtensionNetworkSettings } from "./extension-cards/network-settings.js";
import { ExtensionOAuthAccounts } from "./extension-cards/oauth-accounts.js";
import { ExtensionOAuthSettings } from "./extension-cards/oauth-settings.js";
import { ExtensionOAuthCards } from "./extension-cards/oauth-cards.js";
import { ExtensionCardMedia } from "./extension-cards/media.js";
import { ExtensionCardsManager } from "./extension-cards/manager.js";
import { PartnerWorkingStatusManager } from "./partner-working-status.js";
import { PartnerWorkbenchManager } from "./partner-workbench-manager.js";
import { PartnerWorkbenchBriefReader } from "./partner-workbench-brief.js";
import { PartnerWorkbenchToolProvider } from "./partner-workbench-tool-provider.js";
import { CodeHostProjectProvider } from "@joko/code-host";
import { PartnerToolBridgeProvider } from "./partner-tool-provider.js";
import { DevicePeerOwner } from "./device-peer-owner.js";
import {
  RemoteDesktopCoordinator,
  type RemoteDesktopIceConfigurationProvider
} from "./remote-desktop-coordinator.js";
import { ConfiguredRemoteDesktopIceConfiguration, REMOTE_DESKTOP_ICE_RESPONSE_BYTES } from "./remote-desktop-ice-configuration.js";
import { ServerAccessManager } from './server-access-manager.js';
import { ServerAccessMedia } from './server-access-runtime.js';
import { reserveLinkspanTurnCredentials } from './linkspan-turn-configuration.js';
import { reserveManagedLinkspanResourceCredentials } from "./linkspan-resource-manager.js";
import { reserveIrohRelayLeaseCredentials } from "./linkspan-iroh-lease.js";
import { RemoteHostRegistry } from "./remote-host-registry.js";
import { RemoteExecutionRouter } from "./remote-execution-router.js";
import {
  RemoteBackendRuntimeSetupManager,
  createRemoteClaudeRuntimeSetupProvider,
  createRemoteCodexRuntimeSetupProvider
} from "./remote-backend-runtime-setup.js";
import { RemotePiProcessFactory } from "./remote-pi-process.js";
import { RemoteWorkspaceService } from "./remote-workspace-service.js";
import { RemoteFileVersionCache } from "./remote-file-version-cache.js";
import { RemoteHostToolBridgeProvider } from "./remote-host-tool-provider.js";
import { ReviewCoordinator } from "./review-coordinator.js";
import { DurableReviewEvidenceProvider } from "./review-evidence-provider.js";
import { RuntimeGovernanceSettingsRepository } from "./runtime-governance-settings.js";
import { createRuntimeActivityTracker, type RuntimeActivityTracker } from "./runtime-activity-tracker.js";
import { ScheduleCoordinator } from "./schedule-coordinator.js";
import {
  ScheduleHookScriptInstaller,
  createScheduleHookScriptGenerator
} from "./schedule-hook-script-installer.js";
import { ScheduleRunNotificationController } from "./schedule-run-notifications.js";
import { SessionWorktreeCoordinator } from "./session-worktree-coordinator.js";
import { SchedulerToolBridgeProvider } from "./scheduler-tool-provider.js";
import {
  COLLABORATION_TOOL_POLICY_ID,
  SessionHelperToolBridgeProvider
} from "./session-helper-tool-provider.js";
import { SessionHost, withSessionReferenceCapability } from "./session-host.js";
import { configuredSessionRuntimeFallback } from "./session-runtime-fallback.js";
import { ToolPolicySettingsRepository } from "./tool-policy-settings.js";
import {
  VoiceInputCoordinator,
  type VoiceInputProviderFactory
} from "./voice-input-coordinator.js";
import { VoiceDictionarySyncRepository } from "./voice-dictionary-sync-repository.js";
import { VoiceDictionaryPeerManager } from "./voice-dictionary-peer-manager.js";
import { VoiceInputSettingsController } from "./voice-input-settings.js";
import { WorkspaceChangeSetService } from "./workspace-change-set.js";
import { OperationalWorkspaceChangeJournal } from "./workspace-change-stream.js";
import { DurableWorkspaceRunCapture, prepareRunProjectGit } from "./workspace-run-capture.js";
import { PartnerTaskOutputProjection } from "./partner-task-outputs.js";
import { WorkspaceService } from "./workspace-service.js";
import { OperationalCodeHostSessionAuthorization } from "./session-code-host-context.js";

const MANAGED_PROVIDER_CATALOG_CAPABILITY = "provider.managed_catalog";

export interface SessionContextDefaultsInput {
  readonly sessionId: string;
  readonly backendId: string;
  readonly targetId: string;
}

export interface SessionContextDefaults {
  readonly autoCompaction?: boolean;
  readonly autoRetry?: boolean;
}

export type SessionContextDefaultsResolver = (
  session: SessionContextDefaultsInput
) => SessionContextDefaults | undefined;

export interface SessionContextDefaultsRegistration {
  readonly adapter: Pick<BackendAdapter, "id">;
  readonly resolve: SessionContextDefaultsResolver;
}

/** Compose Adapter-owned projection policy without teaching shared projection code Backend IDs. */
export function composeSessionContextDefaultsResolver(
  registrations: readonly SessionContextDefaultsRegistration[]
): SessionContextDefaultsResolver {
  const resolvers = new Map<string, SessionContextDefaultsResolver>();
  for (const registration of registrations) {
    if (resolvers.has(registration.adapter.id)) {
      throw new Error(`Duplicate Session context-default registration: ${registration.adapter.id}`);
    }
    resolvers.set(registration.adapter.id, registration.resolve);
  }
  return (session) => resolvers.get(session.backendId)?.(session);
}

export function availableBackendProviderIds(
  descriptor: Pick<BackendDescriptor, "id" | "capabilities" | "providers">,
  managedCatalog: readonly {
    readonly backendId: string;
    readonly provider: { readonly id: string };
    readonly enabled: boolean;
    readonly authenticationState: BackendAuthenticationState;
  }[],
  enabled: (providerId: string) => boolean = () => true
): ReadonlySet<string> {
  const owned = descriptor.capabilities.get(MANAGED_PROVIDER_CATALOG_CAPABILITY)?.supported === true
    ? managedCatalog.filter((provider) => provider.backendId === descriptor.id) : [];
  const configuredIds = new Set(owned.map((provider) => provider.provider.id));
  return new Set([...availableManagedProviderIds(owned, enabled), ...(descriptor.providers ?? [])
    .filter((provider) => !configuredIds.has(provider.providerId) && enabled(provider.providerId) && (
      provider.authenticationState === "authenticated"
      || provider.authenticationState === "not_required"))
    .map((provider) => provider.providerId)]);
}

function availableManagedProviderIds(
  managedCatalog: readonly {
    readonly provider: { readonly id: string };
    readonly enabled: boolean;
    readonly authenticationState: BackendAuthenticationState;
  }[],
  enabled: (providerId: string) => boolean
): ReadonlySet<string> {
  return new Set(managedCatalog
    .filter((provider) => provider.enabled && enabled(provider.provider.id) && (
      provider.authenticationState === "authenticated"
      || provider.authenticationState === "not_required"
    ))
    .map((provider) => provider.provider.id));
}

/** Compose production code-host capabilities without exposing host IDs to shared runtime code. */
export function composeCodeHostProviders(
  providers: readonly CodeHostProvider[] | undefined,
  authorization?: CodeHostSessionAuthorizationPort
): readonly CodeHostProvider[] {
  if (providers !== undefined) return providers;
  const publicProvider = createPublicCodeHostProvider();
  return authorization === undefined
    ? Object.freeze([publicProvider])
    : Object.freeze([
      createAuthenticatedCodeHostProvider({ authorization }),
      publicProvider
    ]);
}

export interface OrchestratorApplication {
  readonly taskSharingHome?: TaskSharingHome;
  readonly partnerIdentity?: PartnerIdentityDirectory;
  readonly config: OrchestratorConfig;
  readonly store: OperationalStore;
  readonly connections: ConnectionManager;
  /** Stable, public node identity used by ServerInfo and LAN discovery deduplication. */
  readonly serverId: string;
  readonly linkspanIdentity?: LinkspanIdentity;
  readonly serverAccess?: ServerAccessManager;
  readonly serverAccessMedia?: ServerAccessMedia;
  /** Current published locator; deployment TLS and private bridge configuration stay separate. */
  readonly advertisedOrigin?: () => string;
  readonly lanDiscovery: LanDiscoveryService;
  readonly artifacts: ArtifactStore;
  readonly artifactMaintenance: ArtifactMaintenance;
  readonly historyMaintenance: HistoryMaintenance;
  readonly blobTransfers: BlobTransferCoordinator;
  readonly artifactRepository: OperationalArtifactRepository;
  readonly workspaces: WorkspaceService;
  readonly workspaceChanges: WorkspaceChangeSetService;
  readonly sessionHost: SessionHost;
  /** Session-scoped isolated workspace owner; never exposes a repository path as target identity. */
  readonly sessionWorktrees: SessionWorktreeCoordinator;
  /** Content-free authority used to preserve the unattended-update quiet period. */
  readonly runtimeActivity?: RuntimeActivityTracker;
  /** Service-owned resource policy, hot-read by every local Pi runtime generation. */
  readonly runtimeGovernance?: RuntimeGovernanceSettingsRepository;
  /** Ordinary Tool defaults and immutable per-Session availability snapshots. */
  readonly toolPolicies?: ToolPolicySettingsRepository;
  /** Opt-in shadow savepoints for local Git workspaces. */
  readonly gitSafety?: GitSafetyCoordinator;
  readonly scheduler: ScheduleCoordinator;
  readonly scheduleHookScripts: ScheduleHookScriptInstaller;
  readonly reviewCoordinator?: ReviewCoordinator;
  /** Authenticated reverse routes for exact controller-to-Device execution. */
  readonly devicePeers?: DevicePeerOwner;
  readonly hostedAgentSources?: HostedAgentSources;
  /** Ephemeral, peer-fenced Remote Desktop lease and signaling authority. */
  readonly remoteDesktop?: RemoteDesktopCoordinator;
  /** Capability-neutral location switch shared by every remote runtime owner. */
  readonly remoteExecution?: RemoteExecutionRouter;
  readonly remoteHosts?: RemoteHostRegistry;
  readonly remoteBackendRuntimeSetup?: RemoteBackendRuntimeSetupManager;
  readonly localBackendRuntimeSetup?: LocalCodexRuntime;
  readonly sshKeys?: SshKeyManager;
  readonly terminals?: TerminalProvider;
  readonly voiceInput?: VoiceInputCoordinator;
  readonly desktopVoiceConversation?: DesktopVoiceConversationManager;
  readonly voiceInputSettings?: VoiceInputSettingsController;
  /** Durable current-v1 convergence authority for the node's Voice dictionary replica. */
  readonly voiceDictionary?: VoiceDictionarySyncRepository;
  readonly voiceDictionaryPeers?: VoiceDictionaryPeerManager;
  readonly mobilePush?: MobilePushCoordinator;
  /** Point-in-time projection of current Backend process instances. */
  readonly adapters: readonly BackendAdapter[];
  /** Idle-only, durable-generation Backend process replacement. */
  readonly restartBackend: (backendId: string) => Promise<void>;
  /** Refresh volatile native account/model state for the current generation. */
  readonly refreshBackendDescriptor: (backendId: string) => Promise<void>;
  /** Publish a fail-closed Provider auth projection for the exact current generation. */
  readonly projectBackendProviderAuthentication: (
    backendId: string,
    providerId: string,
    authenticationState: BackendAuthenticationState
  ) => void;
  /** Install a process-local queue hold synchronously after the desired revision commits. */
  readonly holdSubagentSmartRoutingDispatch: (backendId: string) => void;
  /** Apply the durable smart-routing preference through an idle process-generation replacement. */
  readonly refreshSubagentSmartRouting: (backendId: string) => Promise<void>;
  /** Optional only so isolated test hosts can deliberately advertise no provisioning channel. */
  readonly credentials?: CredentialManager;
  readonly providers?: ProviderCatalogManager;
  /** Node-owned local inference runtime; renderer and Desktop IPC never own its processes. */
  readonly managedModelRuntime?: ManagedModelRuntimeRegistry;
  readonly modelWorkingContext?: ModelWorkingContextCoordinator;
  readonly removeManagedModelProvider?: (providerId: string) => Promise<boolean | undefined>;
  readonly mcpRouter?: McpRouter;
  readonly mcpApps?: McpAppsManager;
  readonly mcpAppSurfaces?: McpAppSurfaces;
  readonly piResources?: PiResourceManager;
  readonly skills?: SkillManager;
  readonly skillLearning?: SkillLearningManager;
  readonly skillMarket?: SkillMarketManager;
  readonly skillMarketSync?: SkillMarketSyncManager;
  readonly skillPublication?: SkillPublicationManager;
  /** Direct third-party Messaging transport, durable admission and delivery owner. */
  readonly messaging?: MessagingManager;
  /** Test-only, process-local third-party authorization fixture seam. */
  readonly messagingCreateWeChatAuthorization?: () => WeChatAuthorizationPort;
  readonly collaboration?: CollaborationManager;
  /** Durable Goal/lead/worker scheduling authority. */
  readonly collaborationGoals?: CollaborationGoalManager;
  /** Durable autonomous continuation authority for one existing Session. */
  readonly objectives?: ObjectiveManager;
  /** Node-local structured authority for people and organizations. */
  readonly contacts?: ContactManager;
  /** Explicitly granted, encrypted node-to-node Contacts convergence owner. */
  readonly contactSync?: ContactSyncManager;
  /** Node-local authority for long-lived partner profiles and their canonical Sessions. */
  readonly partners?: PartnerManager;
  readonly partnerGroupRuntime?: PartnerGroupSessionRuntime;
  readonly partnerGroups?: PartnerGroupManager;
  readonly partnerNetwork?: PartnerNetworkRuntime;
  readonly appDefaultModels?: AppDefaultModelCoordinator;
  readonly partnerRoutines?: PartnerRoutineManager;
  readonly partnerAutonomy?: PartnerAutonomyManager;
  readonly partnerMessaging?: PartnerMessagingRuntime;
  readonly partnerTodos?: PartnerTodoManager;
  readonly partnerImports?: PartnerImportManager;
  readonly partnerHomes?: PartnerHomeOwner;
  readonly partnerHomeRuntime?: PartnerHomeRuntimeAdapter;
  readonly partnerHomeInference?: PartnerHomeInference;
  readonly hostedAgents?: HostedAgentRuntime;
  readonly providerSharing?: ProviderSharingRuntime;
  readonly providerGroups?: ProviderGroupRuntime;
  readonly inputHandoff?: InputHandoffCoordinator;
  readonly nativeInputHandoff?: NativeInputHandoffHost;
  readonly partnerWorkingStatus?: PartnerWorkingStatusManager;
  readonly partnerWorkbenches?: PartnerWorkbenchManager;
  readonly partnerSessionTasks?: PartnerSessionTaskManager;
  readonly partnerTaskOutputs?: PartnerTaskOutputProjection;
  readonly extensionCatalog?: ExtensionCatalogManager;
  readonly extensionProjects?: ExtensionProjectPolicies;
  readonly extensionLibraries?: ExtensionLibraryManager;
  readonly extensionMainViews?: ExtensionMainViewManager;
  readonly extensionSettings?: ExtensionSettingsManager;
  readonly extensionDirectoryPicker?: ExtensionDirectoryPicker;
  readonly extensionCards?: ExtensionCardsManager;
  readonly extensionNetwork?: ExtensionNetworkSettings;
  readonly extensionOAuth?: ExtensionOAuthSettings;
  readonly extensionTasks?: ExtensionTasks;
  readonly extensionPackagePublisher?: ExtensionPackagePublisher;
  readonly extensionSources?: ExtensionSourceManager;
  readonly diagnosticsBundles?: DiagnosticsBundleService;
  readonly providerAuth?: PiProviderAuthSupervisor;
  /** Capability-owned, in-memory Provider account quota reader. */
  readonly providerAccountUsage?: ProviderAccountUsageProvider;
  readonly messageSearch?: MessageSearchEmbeddingCoordinator;
  readonly makerMemory?: MakerMemoryController;
  readonly partnerMemoryPreferences?: PartnerMemoryPreferences;
  readonly partnerConnections?: PartnerConnectionsManager;
  readonly partnerSkills?: PartnerSkillsManager;
  readonly visionBridge?: VisionBridgeCoordinator;
  readonly promptPrediction?: PromptPredictionService;
  readonly auxiliaryText?: AuxiliaryTextRouting;
  readonly helpAssistant?: HelpAssistant;
  readonly helpFeedback?: HelpFeedbackStore;
  readonly personalDevelopment?: PersonalDevelopmentOwner;
  readonly personalDevelopmentCoordinator?: PersonalDevelopmentCoordinator;
  readonly personalDevelopmentNativeBroker?: PersonalDevelopmentNativeBroker;
  readonly personalDevelopmentDoctor?: PersonalDevelopmentDoctor;
  readonly subagentModels?: SubagentModelSettings;
  readonly modelFavorites: ModelFavoriteSettings;
  readonly sessionNavigation?: SessionNavigationCoordinator;
  /** Capability-owned code-host adapters; each resolves its own credential reference. */
  readonly codeHostProviders?: readonly CodeHostProvider[];
  /** Publishes a fresh immutable generation for new runtimes without interrupting active ones. */
  readonly refreshPiGeneration?: () => Promise<void>;
  /** Adapter-composition policy used only as a fallback when live native state omits context defaults. */
  readonly resolveSessionContextDefaults?: SessionContextDefaultsResolver;
  /** Effective Pi defaults resolved from the managed settings and Pi's native defaults. */
  readonly piSettingsDefaults?: Readonly<Record<string, PiSettingsProjectionDefaults>>;
  readonly browser?: BrowserProvider;
  readonly browserTransfers?: BrowserTransferCoordinator;
  readonly browserSettings?: BrowserSettingsController;
  readonly browserAutomationNode?: BrowserAutomationNodeExecutor;
  readonly computerAutomation?: ComputerAutomationSettingsController;
  readonly computerBridge?: ComputerToolBridgeProvider;
  readonly androidAutomation?: AndroidAutomationSettingsController;
  readonly androidBridge?: AndroidToolBridgeProvider;
  readonly browserState?: OperationalBrowserState;
  readonly browserActivity: readonly BrowserActivity[];
  /** Registers process-local service work that must be cancelled before the
   * durable store and runtime owners begin shutdown. */
  registerServiceCleanup?(cleanup: () => void): () => void;
  close(): Promise<void>;
}

export interface PiSettingsProjectionDefaults {
  readonly autoCompaction: boolean;
  readonly autoCompactionThresholdPercent: number;
  readonly autoRetry: boolean;
  readonly steeringMode: "all" | "one-at-a-time";
  readonly followUpMode: "all" | "one-at-a-time";
}

export interface OrchestratorApplicationDependencies {
  readonly agentImportSources?: { readonly home: string; readonly environment: NodeJS.ProcessEnv };
  /** Private host capability; proxy credentials remain outside durable Orchestrator state. */
  readonly resolveOutboundProxy?: OutboundProxyResolver;
  /** Optional speech transport owner; its credentials remain behind the factory port. */
  readonly voiceInputProvider?: VoiceInputProviderFactory;
  /** Optional SSH transport; credential values are resolved only inside each connection attempt. */
  readonly remoteSshConnector?: ResolvedAgentAuthConnectorPort;
  readonly sshKeys?: SshKeyManager;
  /** Optional service-owned SSH catalog port. Requests can never select its path. */
  readonly remoteSshConfig?: SshConfigFilePort;
  readonly defaultSshUser?: string;
  /** Optional short-lived ICE credential source; production otherwise uses public STUN only. */
  readonly remoteDesktopIceConfiguration?: RemoteDesktopIceConfigurationProvider;
  /** Optional secure provider composition. Raw credentials never cross this port. */
  readonly codeHostProviders?: readonly CodeHostProvider[];
  /** Test-only transport seam; production uses the host fetch implementation. */
  readonly providerAccountUsageFetch?: typeof fetch;
  /** Test-only transport seam; production uses the configured generic APNs provider. */
  readonly mobilePushProvider?: MobilePushProviderPort;
  /** Test-only direct-Messaging loopback seams; not sourced from product configuration. */
  readonly messagingTelegramApiBaseUrl?: string;
  readonly messagingDiscordApiBaseUrl?: string;
  readonly messagingDingTalkApiBaseUrl?: string;
  readonly messagingDingTalkOapiBaseUrl?: string;
  readonly messagingCreateFeishuTransport?: MessagingManagerOptions["createFeishuTransport"];
  readonly messagingCreateWeComTransport?: MessagingManagerOptions["createWeComTransport"];
  readonly messagingCreateWeChatTransport?: MessagingManagerOptions["createWeChatTransport"];
  readonly messagingCreateSlackTransport?: MessagingManagerOptions["createSlackTransport"];
  readonly messagingCreateWeChatAuthorization?: () => WeChatAuthorizationPort;
  readonly messagingPollTimeoutSeconds?: number;
  readonly messagingRetryDelayMs?: number;
  /** Test-only host seams; production uses the macOS environment, simctl and pinned driver. */
}

export type OutboundProxyResolver = (
  upstreamUrl: string,
  options?: { readonly signal?: AbortSignal }
) => Promise<string | null | undefined> | string | null | undefined;

/** Pi's documented native defaults, used only when no managed override exists. */
export const NATIVE_PI_SETTINGS_DEFAULTS: PiSettingsProjectionDefaults = Object.freeze({
  autoCompaction: true,
  autoCompactionThresholdPercent: PI_AUTO_COMPACTION_THRESHOLD_PERCENT_DEFAULT,
  autoRetry: true,
  steeringMode: "one-at-a-time",
  followUpMode: "one-at-a-time"
});

export async function createOrchestratorApplication(
  config: OrchestratorConfig,
  dependencies: OrchestratorApplicationDependencies = {}
): Promise<OrchestratorApplication> {
  await Promise.all([
    mkdir(config.dataDirectory, { recursive: true }),
    mkdir(dirname(config.databasePath), { recursive: true }),
    mkdir(config.piAgentHome, { recursive: true }),
    mkdir(config.artifactDirectory, { recursive: true })
  ]);

  let suppressPrivateSessionNotifications: (sessionId: string) => boolean = () => false;
  const store = new OperationalStore(config.databasePath, { suppressSessionNotifications: sessionId => suppressPrivateSessionNotifications(sessionId), assistantTextForSearch: richAnswerText });
  let contactStore: ContactStore;
  try {
    contactStore = new ContactStore(join(config.dataDirectory, "contacts.db"));
  } catch (error) {
    store.close();
    throw error;
  }
  const contacts = new ContactManager(contactStore);
  let partnerStore: PartnerStore;
  try {
    partnerStore = new PartnerStore(join(config.dataDirectory, "partners.db"));
  } catch (error) {
    contacts.close();
    contactStore.close();
    store.close();
    throw error;
  }
  let backendInstances!: BackendInstanceRegistry;
  const partnerHomeStorage = new PartnerHomeStorage(store);
  let partnerHomeInference: PartnerHomeInference | undefined;
  let partnerHomeRuntime: PartnerHomeRuntimeAdapter | undefined;
  suppressPrivateSessionNotifications = sessionId => ['group', 'channel'].includes(partnerStore.getSessionLink(sessionId)?.role ?? '');
  let partnerGroupStore: PartnerGroupStore;
  try { partnerGroupStore = new PartnerGroupStore(join(config.dataDirectory, "partner-groups.db")); }
  catch (error) { contacts.close(); contactStore.close(); partnerStore.close(); store.close(); throw error; }
  let partnerGroupRuntime: PartnerGroupSessionRuntime | undefined;
  let partnerNetwork: PartnerNetworkRuntime | undefined;
  let partnerNetworkLanes: PartnerGroupSessionRuntime | undefined;
  let partnerGroups: PartnerGroupManager | undefined;
  let partnerGroupWorkspaces: PartnerGroupWorkspaces | undefined;
  const privateHomeTarget = (sessionId: string, targetId: string) => {
    const home = partnerHomeRuntime?.executionHome(targetId);
    if (home && home.id !== targetId) {
      try { if (store.getSession(sessionId).descriptor.targetId !== targetId) return undefined; } catch { /* Native creation precedes its product Session row. */ }
      return home.id;
    }
    return partnerGroupRuntime?.homeTarget(sessionId, targetId) ?? partnerNetworkLanes?.homeTarget(sessionId, targetId);
  };
  const privateResourceTarget = (context: AdapterContext) => privateHomeTarget(context.sessionId, context.target.id);
  let voiceDictionaryPeerStore: VoiceDictionaryPeerStore;
  try {
    voiceDictionaryPeerStore = new VoiceDictionaryPeerStore(join(config.dataDirectory, "voice-dictionary-peers.db"));
  } catch (error) {
    contacts.close();
    contactStore.close();
    partnerStore.close();
    partnerGroupStore.close();
    store.close();
    throw error;
  }
  let voiceDictionaryPeers!: VoiceDictionaryPeerManager;
  let voiceDictionaryOwner: VoiceDictionarySyncRepository | undefined;
  const closeVoiceDictionary = (): void => voiceDictionaryOwner?.close();
  try {
  let sessionWorktrees!: SessionWorktreeCoordinator;
  let personalDevelopment: PersonalDevelopmentOwner | undefined;
  let personalDevelopmentCoordinator: PersonalDevelopmentCoordinator | undefined;
  let personalDevelopmentNativeBroker: PersonalDevelopmentNativeBroker | undefined;
  let inputHandoff: InputHandoffCoordinator | undefined;
  let nativeInputHandoff: NativeInputHandoffHost | undefined;
  let inputHandoffNotifications: InputHandoffNotifications | undefined;
  let providerSharing: ProviderSharingRuntime | undefined;
  let providerGroups: ProviderGroupRuntime | undefined;
  let hostedAgentSources: HostedAgentSources | undefined;
  let personalDevelopmentDoctor: PersonalDevelopmentDoctor | undefined;
  let stopPersonalDevelopmentNotifications = (): void => undefined;
  let personalDevelopmentClose: Promise<void> | undefined;
  const closePersonalDevelopment = (): Promise<void> => personalDevelopmentClose ??= (async () => {
    stopPersonalDevelopmentNotifications();
    const failures: unknown[] = [];
    for (const close of [() => personalDevelopmentDoctor?.dispose(), () => personalDevelopmentCoordinator?.dispose(),
      () => personalDevelopment?.dispose(), () => personalDevelopmentNativeBroker?.close()]) {
      try { await close(); } catch (error) { failures.push(error); }
    }
    if (failures.length > 0) throw new AggregateError(failures, "Personal development owners could not finish shutdown.");
  })();
  let deferredBackendRestarts: DeferredBackendRestartCoordinator | undefined;
  const subagentModels = new SubagentModelSettings({
    store,
    smartRoutingState: (backendId) => {
      const adapter = backendInstances?.adapter(backendId);
      if (!(adapter instanceof CodexBackendAdapter)) return undefined;
      const runtime = adapter.subagentSmartRoutingState();
      const deferred = deferredBackendRestarts?.state(backendId);
      return {
        applied: runtime.applied,
        restartPending: deferred?.pending === true,
        unavailableReason: deferred?.lastError || runtime.unavailableReason,
        runtimeRevision: runtime.runtimeRevision,
        instanceGeneration: runtime.instanceGeneration
      };
    }
  });
  const modelFavorites = new ModelFavoriteSettings(store, {
    models: backend => modelSourceCatalogModels({ store, hostedAgentSources, providerGroups }, backend),
    unavailableReason: (backendId, providerId, modelId) => modelSourceFavoriteUnavailableReason(
      { store, hostedAgentSources, providerGroups }, backendId, providerId, modelId)
  });
  const codeHostProviders = composeCodeHostProviders(
    dependencies.codeHostProviders,
    new OperationalCodeHostSessionAuthorization(store)
  );
  const runtimeActivity = createRuntimeActivityTracker(store);
  const runtimeGovernance = new RuntimeGovernanceSettingsRepository({ store });
  const gitCommandRunner = new NodeGitCommandRunner();
  const projectGitBootstrap = new ProjectGitBootstrap(gitCommandRunner);
  const gitSafety = new GitSafetyCoordinator({
    runner: gitCommandRunner,
    readMode: () => runtimeGovernance.gitSafety().mode,
    initializeProjectGit: input => prepareRunProjectGit(store, projectGitBootstrap, input),
    onGap: (gap) => {
      store.appendDiagnostic({
        severity: "warning",
        component: "git-safety",
        code: "WORKSPACE_SAVEPOINT_GAP",
        message: "An automatic workspace savepoint could not provide a complete rewind boundary.",
        details: { kind: gap.kind, reason: gap.reason, phase: gap.phase }
      });
    }
  });
  const commandConcurrencyGate = createCommandConcurrencyGate({
    readMaximum: () => runtimeGovernance.agentResource().maxConcurrentCommands
  });
  const serverId = durableServerId(store);
  const advertisedOrigin = () => advertisedLinkspanOrigin(store, config.publicOrigin);
  const connections = new ConnectionManager(store);
  nativeInputHandoff = new NativeInputHandoffHost(connections);
  let lastLanDiscoveryDiagnosticAt = 0;
  const lanDiscovery = new LanDiscoveryService({
    self: () => ({
      serverId,
      displayName: "Joko",
      origin: config.publicOrigin,
      version: "0.1.0",
      apiVersion: JOKO_API_VERSION,
      pairingEnabled: connections.pairingEnabled,
      endpointPublicKey: linkspanIdentity.publicKey,
      ...publicConnectionCapabilities(store, config.publicOrigin),
      lastSeen: Date.now()
    }),
    onError: (message) => {
      const now = Date.now();
      if (now - lastLanDiscoveryDiagnosticAt < 60_000) return;
      lastLanDiscoveryDiagnosticAt = now;
      store.appendDiagnostic({
        severity: "warning",
        component: "lan-discovery",
        code: "LAN_DISCOVERY_IO_FAILED",
        message,
        details: {}
      });
    }
  });
  const browserState = new OperationalBrowserState(store);
  const artifactRepository = new OperationalArtifactRepository(store);
  const artifacts = new ArtifactStore({
    rootDirectory: config.artifactDirectory,
    repository: artifactRepository,
    ingestRoots: [config.workspace.root, config.dataDirectory, config.piAgentHome]
  });
  await artifacts.initialize();
  const artifactMaintenance = new ArtifactMaintenance({
    store,
    rootDirectory: config.artifactDirectory
  });
  await artifactMaintenance.initialize();

  const baseSettings = await loadJsonFile<PiManagedSettings>(config.piSettingsFile, {});
  const settings = effectivePiSettings(baseSettings, store.findSetting<unknown>("service", "orchestrator", "settings.pi.pi")?.value);
  const credentialVault = await CredentialVault.open(join(config.dataDirectory, "credentials", "master.key"));
  const linkspanIdentity = await openLinkspanIdentity({ dataDirectory: config.dataDirectory, serverId, store, vault: credentialVault });
  const taskSharingHome = new TaskSharingHome({ directory: join(config.dataDirectory, "task-sharing-home"),
    vault: credentialVault, serverId });
  let lastContactSyncDiagnosticAt = 0;
  const contactSync = new ContactSyncManager({
    store: contactStore,
    vault: credentialVault,
    nodeId: serverId,
    displayName: contactSyncDisplayName(),
    logger: {
      debug: () => undefined,
      warn: () => {
        const at = Date.now();
        if (at - lastContactSyncDiagnosticAt < 5 * 60_000) return;
        lastContactSyncDiagnosticAt = at;
        store.appendDiagnostic({
          severity: "warning",
          component: "contacts-sync",
          code: "CONTACTS_SYNC_UNAVAILABLE",
          message: "Contacts device sync encountered a secure transport failure.",
          details: {}
        });
      }
    }
  });
  await contactSync.initialize().catch(() => undefined);
  const mobilePushProvider = dependencies.mobilePushProvider ?? (config.mobilePush === undefined
    ? undefined
    : new ApnsMobilePushProvider({
        teamId: config.mobilePush.apns.teamId,
        keyId: config.mobilePush.apns.keyId,
        privateKeyPem: await readFile(config.mobilePush.apns.privateKeyPath, "utf8"),
        topic: config.mobilePush.apns.topic
      }));
  const mobilePush = new MobilePushCoordinator({
    store,
    vault: credentialVault,
    serverId,
    ...(mobilePushProvider === undefined ? {} : { provider: mobilePushProvider })
  });
  const credentials = new CredentialManager({
    vault: credentialVault,
    storagePath: join(config.dataDirectory, "credentials", "records.json")
  });
  await credentials.initialize();
  const serverAccess = new ServerAccessManager({ config, serverId, store, credentials, connections });
  reserveLinkspanTurnCredentials(store, credentials);
  reserveManagedLinkspanResourceCredentials({ config, store, credentials });
  reserveIrohRelayLeaseCredentials({ store, credentials });
  const providerCredentialSurfaces = new ProviderCredentialSurfaceResolver({
    store,
    credentials,
    providerEnabled: (backendId, providerId) => providerRoutingEnabled(store, backendId, providerId),
    modelEnabled: (backendId, providerId, modelId) =>
      modelRoutingEnabled(store, backendId, providerId, modelId)
  });
  const sshKeys = dependencies.sshKeys ?? new SshKeyManager();
  const remoteHosts = new RemoteHostRegistry({
    nodeKeys: sshKeys,
    store,
    ownerId: serverId,
    credentials,
    sshConfig: dependencies.remoteSshConfig ?? new FileSshConfigPort(),
    defaultSshUser: dependencies.defaultSshUser ?? userInfo().username,
    connector: dependencies.remoteSshConnector ?? new Ssh2ResolvedAgentAuthConnector()
  });
  const devicePeers = new DevicePeerOwner({ store, localDesktopHostConnection: connection => connections.isLocalDesktopHostConnection(connection) });
  const serverAccessMedia = new ServerAccessMedia({ config, store, serverId, credentials,
    isLocalDesktopRoute: identity => devicePeers.isLocalDesktopRoute(identity),
    fetch: createOutboundFetch(dependencies.resolveOutboundProxy, REMOTE_DESKTOP_ICE_RESPONSE_BYTES),
    fallbackIce: dependencies.remoteDesktopIceConfiguration ?? new ConfiguredRemoteDesktopIceConfiguration({
      configuration: config.remoteDesktopIce, fetch: createOutboundFetch(dependencies.resolveOutboundProxy, REMOTE_DESKTOP_ICE_RESPONSE_BYTES) }) });
  const remoteDesktop = new RemoteDesktopCoordinator({
    owner: devicePeers,
    udpMapping: serverAccessMedia.udp,
    onRevoked: (connectionId, listener) => connections.onRevoked(connectionId, listener),
    iceConfiguration: serverAccessMedia.ice
  });
  const remoteExecution = new RemoteExecutionRouter({ hosts: remoteHosts, peers: devicePeers });
  const partnerHomeProjects = new PartnerHomeProjects({ execution: remoteExecution, home: targetId => partnerHomeRuntime?.executionHome(targetId), codeHost: new CodeHostProjectProvider() });
  const partnerWorkbenchStore = new PartnerWorkbenchStore(join(config.dataDirectory, "partner-homes"));
  const partnerHomeWorkbench = new PartnerHomeWorkbench(store, partnerWorkbenchStore);
  const remotePiProcesses = new RemotePiProcessFactory({
    remoteExecution,
    store,
    authorityRoot: join(config.dataDirectory, "remote-pi-authority")
  });
  const remoteWorkspaceFiles = new RemoteWorkspaceService(remoteExecution, {
    cache: new RemoteFileVersionCache(join(config.dataDirectory, "remote-file-cache"))
  });
  const remoteTerminals = new RemoteTerminalRuntimeResolver(remoteExecution);
  const terminals = new TerminalProvider({
    onActivity: () => runtimeActivity.markBlockingActivity(),
    resolveRemoteRuntime: (scope, signal) => remoteTerminals.resolve(scope, signal)
  });
  const piBackendId = "pi";
  const providers = new ProviderCatalogManager({
    store,
    credentials,
    nativeBackendId: piBackendId,
    providerEnabled: (backendId, providerId) => providerRoutingEnabled(store, backendId, providerId),
    modelEnabled: (backendId, providerId, modelId) => modelRoutingEnabled(store, backendId, providerId, modelId)
  });
  providers.initialize();
  const modelRoutes = createModelRouteCatalog(store, providers);
  const voiceDictionary = voiceDictionaryOwner = new VoiceDictionarySyncRepository({ store });
  let retireVoiceInputConfiguration = (): void => undefined;
  const voiceInputSettings = new VoiceInputSettingsController({ store, credentials, providers,
    dictionaryTerms: () => voiceDictionary.snapshot().dictionary.entries.map((entry) => entry.text),
    onConfigurationChanged: () => retireVoiceInputConfiguration() });
  let lastVoiceDictionaryPeerDiagnosticAt = 0;
  voiceDictionaryPeers = new VoiceDictionaryPeerManager({
    store: voiceDictionaryPeerStore,
    dictionary: voiceDictionary,
    vault: credentialVault,
    nodeId: serverId,
    displayName: contactSyncDisplayName(),
    enableLan: config.voiceDictionaryLanDiscoveryEnabled ?? true,
    logger: {
      debug: () => undefined,
      warn: () => {
        const at = Date.now();
        if (at - lastVoiceDictionaryPeerDiagnosticAt < 5 * 60_000) return;
        lastVoiceDictionaryPeerDiagnosticAt = at;
        store.appendDiagnostic({
          severity: "warning",
          component: "voice-dictionary-sync",
          code: "VOICE_DICTIONARY_PEER_UNAVAILABLE",
          message: "Voice dictionary device sync encountered a secure transport failure.",
          details: {}
        });
      }
    }
  });
  await voiceDictionaryPeers.initialize().catch(() => undefined);
  const voiceInput = new VoiceInputCoordinator({
    provider: dependencies.voiceInputProvider ?? voiceInputSettings,
    onOwnerRetired: (connectionId, listener) => connections.onRevoked(connectionId, listener)
  });
  retireVoiceInputConfiguration = () => { void voiceInput.retireProviderConfiguration().catch(() => undefined); };
  const visionBridge = new VisionBridgeCoordinator({
    store,
    routes: modelRoutes,
    readBlob: (blob) => artifacts.readBlob(blob)
  });
  let refreshPiGenerationImpl: () => Promise<void> = async () => {
    throw new Error("Pi generation refresh is not ready.");
  };
  const providerAuth = await PiProviderAuthSupervisor.create({
    store,
    backendId: piBackendId,
    providers,
    refreshPiGeneration: () => refreshPiGenerationImpl()
  });
  const piResources = new PiResourceManager({
    store,
    builtinSkills: await BuiltinSkillCatalog.load(inspectPiSkillPackage),
    managedRoot: join(config.piAgentHome, "managed-resources"),
    remoteProjectSkills: new RemoteSkillSourceOwner({ store,
      managedRoot: join(config.piAgentHome, "remote-project-skills"),
      captureSkillSourceAuthority: (workspaceId, signal) => remoteWorkspaceFiles.captureSkillSourceAuthority(workspaceId, signal) }),
    privateResourceTarget
  });
  await piResources.initialize();
  const skillMutations = new SkillMutationCoordinator();
  const collaboration = new CollaborationManager({ store });
  collaboration.initialize();
  const skillMarket = new SkillMarketManager({
    store,
    cacheRoot: join(config.dataDirectory, "skill-market"),
    resources: piResources,
    mutationCoordinator: skillMutations,
    collaboration
  });
  await skillMarket.initialize();
  const skillPublication = new SkillPublicationManager({
    store,
    resources: piResources,
    market: skillMarket,
    collaboration,
    rootDirectory: join(config.dataDirectory, "skill-publications")
  });
  await skillPublication.initialize();
  let reconcileSkillMarketResourceRuntime: (resource: {
    readonly resourceId: string;
    readonly backendId: string;
  }) => Promise<void> = async () => undefined;
  const skillMarketSync = new SkillMarketSyncManager({
    store,
    resources: piResources,
    market: skillMarket,
    onResourceCommitted: (resource) => reconcileSkillMarketResourceRuntime(resource)
  });
  await skillMarketSync.initialize();
  const skills = new SkillManager({
    resources: piResources,
    store,
    rootDirectory: join(config.dataDirectory, "skills"),
    mutations: skillMutations,
    removalParticipant: {
      prepare: (resource) => skillMarketSync.prepareResourceRemoval(resource)
    }
  });
  await skills.initialize();
  const trustedManagedRunnerScriptSha256 = createHash("sha256")
    .update(MANAGED_SUBAGENT_RUNNER_SOURCE, "utf8").digest("hex");
  const trustedManagedRunnerNodeExecutable = await realpath(process.execPath);
  const nativeAuthRecovery = new NativeAuthRecoveryStore({
    runRoot: managedSubagentRunRoot(config.piAgentHome),
    stateRoot: join(config.piAgentHome, "subagent-auth-recovery"),
    trustedRunnerScriptSha256: trustedManagedRunnerScriptSha256,
    trustedNodeExecutable: trustedManagedRunnerNodeExecutable,
    inspectRunnerProcess: createManagedSubagentRunnerProcessInspector()
  });
  const partnerConnectionPreferences = new PartnerConnectionPreferences(store);
  let partnerConnections: PartnerConnectionsManager | undefined;
  let partnerSkills: PartnerSkillsManager | undefined;
  let partnerLearning: PartnerLearningManager | undefined;
  let mcpApps: McpAppsManager | undefined;
  let mcpAppSurfaces: McpAppSurfaces | undefined;
  const mcpRouter = new McpRouter({
    store,
    credentials,
    onAppToolCall: async input => mcpApps?.capture(input),
    onAppConnectionOpen: connection => { mcpApps?.host.registerConnection(connection); },
    onAppConnectionRelease: async connection => { if (mcpApps) await mcpApps.host.releaseConnection(connection); else await connection.close(); },
    targetReferences: (targetId, sessionId) => partnerConnections?.targetReferences(sessionId === undefined ? targetId : privateHomeTarget(sessionId, targetId) ?? targetId),
    isGroupSession: sessionId => partnerStore.getSessionLink(sessionId)?.role === "group",
    capturePartnerLearningSave: source => partnerLearning?.captureSave(source),
    resultArtifacts: artifacts,
    nativeAuth: {
      describe: (providerId) => providers.describeNativeAuthLease(providerId),
      load: (input) => providerAuth.loadNativeAuth(input),
      persist: (input) => providerAuth.persistNativeAuth(input)
    },
    nativeAuthRecovery,
    trustedManagedRunnerScriptSha256,
    bridgeGrantTtlMs: 7 * 24 * 60 * 60_000
  });
  const providerAccountUsage = new ProviderAccountUsageProvider({
    credentials: providers,
    ...(dependencies.providerAccountUsageFetch === undefined
      ? {}
      : { fetch: dependencies.providerAccountUsageFetch })
  });
  await mcpRouter.initialize();
  const extensionSources = new ExtensionSourceManager({
    store,
    cacheRoot: join(config.dataDirectory, "extension-sources")
  });
  await extensionSources.initialize();
  const extensionCatalog = new ExtensionCatalogManager({ store, credentials });
  extensionCatalog.initialize();
  extensionCatalog.reconcile(piResources.list(), mcpRouter.list(), extensionSources.snapshot().sources);
  const extensionProjects = new ExtensionProjectPolicies(store);
  const extensionConnections = new ExtensionNetworkConnections({ store, credentials });
  const extensionNetwork = new ExtensionNetworkSettings({ catalog: extensionCatalog, connections: extensionConnections, credentials });
  await extensionNetwork.initialize();
  const extensionOAuthAccounts = new ExtensionOAuthAccounts({ catalog: extensionCatalog, store, vault: credentialVault, credentials,
    fetch: createOutboundStreamingFetch({ resolveProxy: dependencies.resolveOutboundProxy,
      environmentProxyForTarget: target => environmentProxyForTarget(target, process.env) }) });
  await extensionOAuthAccounts.initialize();
  const extensionOAuth = new ExtensionOAuthSettings({ accounts: extensionOAuthAccounts, credentials, catalog: extensionCatalog });
  const extensionPackagePublisher = new ExtensionPackagePublisher({
    store,
    resources: piResources,
    artifacts,
    rootDirectory: join(config.dataDirectory, "extension-package-exports")
  });
  await extensionPackagePublisher.initialize();
  const extensionLibraries = new ExtensionLibraryManager({
    rootDirectory: join(config.dataDirectory, "extension-libraries"),
    managedRoots: [config.dataDirectory]
  });
  await extensionLibraries.initialize();
  const stopExtensionLibraryAuthorityNotifications = extensionCatalog.onAuthorityChanged((extensionIds) => {
    extensionLibraries.signalAuthorityChanges(extensionIds);
  });
  const extensionMainViews = new ExtensionMainViewManager({
    resources: piResources,
    rootDirectory: join(config.dataDirectory, "extension-main-views"),
    onSurfaceRevoked: (surfaceId, connectionId) => {
      void extensionLibraries.closeSurface(surfaceId, connectionId).catch(() => undefined);
    }
  });
  await extensionMainViews.initialize();
  const extensionSettings = new ExtensionSettingsManager({ store, vault: credentialVault, credentials, catalog: extensionCatalog,
    fetch: createOutboundStreamingFetch({ resolveProxy: dependencies.resolveOutboundProxy,
      environmentProxyForTarget: target => environmentProxyForTarget(target, process.env) }) });
  const imageGenerationBridge = new ImageGenerationBridgeToolProvider({
    credentialSurfaces: providerCredentialSurfaces,
    artifacts,
    fetch: createOutboundFetch(
      dependencies.resolveOutboundProxy,
      IMAGE_GENERATION_RESPONSE_MAXIMUM_BYTES
    )
  });
  const unregisterImageGenerationBridge = mcpRouter.registerBridgeToolProvider(imageGenerationBridge);
  const unregisterPersonalDevelopmentTools = mcpRouter.registerBridgeToolProvider(
    new PersonalDevelopmentReportTools(() => personalDevelopmentCoordinator)
  );
  let sessionHostForHelperTools: SessionHost | undefined;
  let messageSearchForHelperTools: MessageSearchEmbeddingCoordinator | undefined;
  const unregisterSessionHelperTools = mcpRouter.registerBridgeToolProvider(
    new SessionHelperToolBridgeProvider({
      store,
      host: () => sessionHostForHelperTools,
      messageSearch: () => messageSearchForHelperTools,
      taskSenderPartner: sessionId => {
        const link = partnerStore.getSessionLink(sessionId);
        if (link?.role !== "canonical") return undefined;
        const partner = partnerStore.getPartner(link.partnerId);
        return { senderPartnerId: partner.id, senderPartnerName: partner.displayName };
      }
    })
  );
  const unregisterContactTools = mcpRouter.registerBridgeToolProvider(
    new ContactToolBridgeProvider({ store, contacts })
  );
  const unregisterRemoteHostTools = mcpRouter.registerBridgeToolProvider(
    new RemoteHostToolBridgeProvider({ store, registry: remoteHosts, outputRedactor: credentials })
  );
  const unregisterDocumentTools = mcpRouter.registerBridgeToolProvider(
    new DocumentToolBridgeProvider({ store,
      ...(config.pdfRendererHost
        ? { pdfRenderer: new ElectronDocumentPdfRenderer(config.pdfRendererHost.executablePath, config.pdfRendererHost.appPath) }
        : config.browser ? { pdfRenderer: new ChromiumDocumentPdfRenderer(config.browser.executablePath) } : {}) })
  );
  const toolPolicies = new ToolPolicySettingsRepository({
    store,
    catalog: () => mcpRouter.toolPolicyDeclarations()
  });
  const unregisterInputHandoffTools = mcpRouter.registerBridgeToolProvider(new InputHandoffTools({ store, coordinator: () => inputHandoff }));
  const lspBridge = new LspToolBridgeProvider({
    isUserEnabled: () => languageToolsEnabled(
      store.findSetting<unknown>("service", "orchestrator", LANGUAGE_TOOL_SETTING_KEY)?.value
    ),
    targetResolver: {
      resolveSnapshot: (targetId) => {
        const target = store.getTarget(targetId).descriptor;
        return {
          workspaceRoot: target.workspaceRoot,
          trusted: target.trusted,
          remote: target.remoteWorkspace !== undefined
        };
      },
      resolveAuthenticated: (context) => resolveAuthenticatedLspTarget(store, context)
    }
  });
  const unregisterLspBridge = mcpRouter.registerBridgeToolProvider(lspBridge);
  const partnerImportStorage = new PartnerImportStorage(store, credentialVault);
  const partnerMemoryPreferences = new PartnerMemoryPreferences(store, credentialVault, async (partnerId, assertCurrent) => {
    const environment = await partnerImportStorage.environment.read(partnerId, assertCurrent); assertCurrent();
    return environment?.profileProjection.user ?? "";
  });
  const makerMemory = new MakerMemoryController({
    store,
    targetPreferences: partnerMemoryPreferences,
    onSettingsChanged: () => refreshPiGenerationImpl()
  });
  const unregisterMakerMemoryBridge = mcpRouter.registerBridgeToolProvider(
    new MakerMemoryBridgeProvider(makerMemory)
  );
  const unregisterPluginAuthoringTools = mcpRouter.registerBridgeToolProvider(new PluginAuthoringTools({ store, resources: piResources, artifacts,
    workingRoot: join(config.dataDirectory, "plugin-authoring"), captureWorkspace: context => {
      if (!sessionHostForHelperTools) throw new Error("The task Workspace authority is not ready.");
      return sessionHostForHelperTools.captureToolWorkspace(context);
    } }));
  const unregisterVisionBridgeTools = mcpRouter.registerBridgeToolProvider(
    new VisionBridgeToolProvider({
      vision: visionBridge,
      allowedRoots: (context) => {
        const target = store.getTarget(context.targetId).descriptor;
        return [
          ...(target.remoteWorkspace === undefined ? [target.workspaceRoot] : []),
          config.artifactDirectory
        ];
      }
    })
  );
  const scheduleHookScripts = new ScheduleHookScriptInstaller({
    generate: createScheduleHookScriptGenerator(providers, { store,
      adapters: () => backendInstances.snapshots().flatMap(instance => {
        const adapter = backendInstances.adapter(instance.instanceId);
        return adapter === undefined ? [] : [adapter];
      }) })
  });
  const scheduleRunNotifications = new ScheduleRunNotificationController(store);
  let schedulerForBridgeTools: ScheduleCoordinator | undefined;
  const unregisterSchedulerBridgeTools = mcpRouter.registerBridgeToolProvider(
    new SchedulerToolBridgeProvider({
      store,
      coordinator: () => schedulerForBridgeTools,
      hookScripts: scheduleHookScripts,
      runNotifications: scheduleRunNotifications
    })
  );
  let piGenerationSequence = 0;
  const generationsRoot = join(config.piAgentHome, "generations");
  let generationGcTail: Promise<void> = Promise.resolve();
  const scheduleGenerationGc = (agentHome: string): void => {
    generationGcTail = generationGcTail.catch(() => undefined).then(async () => {
      try {
        await removeReleasedPiGeneration(generationsRoot, agentHome);
      } catch (error) {
        store.appendDiagnostic({
          severity: "warning",
          component: "pi",
          code: "PI_GENERATION_GC_FAILED",
          message: "A released managed Pi generation could not be removed safely.",
          details: { error: error instanceof Error ? error.message : "unknown" }
        });
      }
    });
  };
  // Internal bridge grants must never transit the user-advertised LAN/public
  // origin. This endpoint follows the actual bind and is not discoverable.
  const bridgeEndpoint = internalBridgeEndpoint(config);
  let sessionHostForPi: SessionHost | undefined;
  const piHostCapabilities = [
    "review.isolated",
    ...HOST_COMPOSED_CAPABILITIES,
    "workspace.extra_dirs"
  ] as const satisfies readonly KnownCapability[];
  const hostToolCapabilities = [
    ...(config.browser === undefined ? [] : ["tool.browser" as const]),
    ...(["win32", "darwin", "linux"].includes(process.platform)
      ? ["tool.computer" as const, "tool.android" as const]
      : [])
  ] satisfies readonly Extract<KnownCapability, `tool.${string}`>[];
  const createPiCandidate = async (
    { generation: backendInstanceGeneration }: { readonly instanceId: string; readonly generation: number }
  ): Promise<ReturnType<typeof createPiAdapter>> => {
    const candidateSettings = effectivePiSettings(
      baseSettings,
      store.findSetting<unknown>("service", "orchestrator", `settings.pi.${piBackendId}`)?.value
    );
    const [providerSnapshot, resourceSnapshot] = await Promise.all([
      providers.createPiGenerationSnapshot({
        snapshotsRoot: generationSnapshotRoot(
          config,
          store.health().revision,
          candidateSettings,
          piGenerationSequence++
        ),
        settings: candidateSettings,
        providerEnabled: (providerId) => providerRoutingEnabled(store, piBackendId, providerId),
        modelEnabled: (providerId, modelId) => modelRoutingEnabled(store, piBackendId, providerId, modelId)
      }),
      piResources.runtimeSnapshot(piBackendId)
    ]);
    const availableNativeProviderIds = availableManagedProviderIds(
      providers.list(piBackendId),
      (providerId) => providerRoutingEnabled(store, piBackendId, providerId)
    );
    const globalExtensionEntries = extensionCatalog.snapshot().entries;
    const bridgeGeneration = createTargetAwarePiBridgeGeneration(
      mcpRouter,
      bridgeEndpoint,
      {
        endpoint: new URL("/internal/pi-native-auth", bridgeEndpoint).toString(),
        catalogGeneration: providerSnapshot.catalogGeneration,
        providerIds: providerSnapshot.nativeAuthProviderIds,
        authenticatedProviderIds: providerSnapshot.nativeAuthenticatedProviderIds
      },
      (context, policyId) => toolPolicies.enabledForSession(context.sessionId, context.target.id, policyId),
      (retryInMs) => store.appendDiagnostic({
        severity: "warning",
        component: "mcp",
        code: "MCP_BRIDGE_RENEWAL_FAILED",
        message: "A live managed MCP bridge grant could not be renewed.",
        details: { retryInMs }
      })
    );
    try {
      return createPiAdapter({
    taskShellEnv: context => inputHandoff?.envFor(context) ?? {},
    agentHome: providerSnapshot.agentHome,
    sessionRoot: config.piAgentHome,
    managedGenerationsRoot: generationsRoot,
    recoverManagedGenerationsOnInitialize: backendInstances.adapter(piBackendId) === undefined,
    ...(config.piExecutable === undefined ? {} : { command: config.piExecutable }),
    processFactory: remotePiProcesses.create,
    prepareRemoteHomeRuntime: input => partnerHomeInference?.prepare(input) ?? Promise.resolve(undefined),
    validateRemoteHomeDirectories: (context, directories) => partnerHomeProjects.remote(context.target)
      ? partnerHomeProjects.validateDirectories(context.target, directories, () => {
        let current: import("@joko/core").SessionDescriptor | undefined;
        try { current = store.getSession(context.sessionId).descriptor; } catch { /* A new native Session is admitted before its product row. */ }
          if (!partnerHomeProjects.remote(context.target) || current && partnerHomeRuntime?.blocksExecution(context.sessionId)
          || current && (current.targetId !== context.target.id || current.binding.generation > context.generation)) throw new Error("The Partner execution home changed.");
      }) : Promise.resolve(undefined),
    remoteNavigationOwner: remotePiProcesses.navigationOwner,
    managedDurableStoreRegistry: remotePiProcesses,
    onManagedSubagentLineageRemoved: (input) => mcpRouter.revokeNativeAuthSession(input),
    fenceManagedSubagentProviderAuthentication: (providerId) =>
      mcpRouter.fenceNativeAuthProvider(providerId),
    reconcileManagedSubagentProviderAuthentication: (providerId, routeToken) =>
      mcpRouter.reconcileNativeAuthProvider(providerId, routeToken),
    processSupervisor: createDefaultManagedProcessSupervisor(),
    validateRemoteWorkspace: async (target, signal) => {
      const binding = target.remoteWorkspace;
      if (binding === undefined) throw new Error("Remote workspace binding is missing.");
      await remotePiProcesses.validate(binding, signal);
    },
    providers: providerSnapshot.providers,
    nativeModels: providerAuth.listNativeModels().filter((model) =>
      availableNativeProviderIds.has(model.providerId)
      && modelRoutingEnabled(store, piBackendId, model.providerId, model.modelId)),
    settings: candidateSettings,
    silentEncryptedRetryEnabled: configuredSilentEncryptedRetry(store),
    environment: providerSnapshot.environment,
    secretEnvironmentNames: providerSnapshot.secretEnvironmentNames,
    catalogGeneration: providerSnapshot.catalogGeneration,
    nativeAuthProviderIds: providerSnapshot.nativeAuthProviderIds,
    nativeAuthenticatedProviderIds: providerSnapshot.nativeAuthenticatedProviderIds,
    loadNativeAuth: (input) => providerAuth.loadNativeAuth(input),
    persistNativeAuth: (input) => providerAuth.persistNativeAuth(input),
    hostCapabilities: piHostCapabilities,
    hostToolCapabilities,
    managedResources: resourceSnapshot,
    resolveTargetResources: (context) => piResources.targetRuntimeSnapshot("pi", privateResourceTarget(context) ?? context.target.id),
    resolveProjectExtensionExclusions: (context) => extensionProjects.excludedNativeEntries(globalExtensionEntries, resourceSnapshot.resources, context.target.id),
    resolveNativeSkills: (context, signal) => piResources.runtimeSkillSnapshot(piBackendId, context.target.id, signal, partnerConnections?.targetSkillReferences(privateResourceTarget(context) ?? context.target.id), context),
    resolveNativeSkillPolicy: context => partnerConnections?.nativeSkillPolicy(context),
    resolveMakerMemoryPrompt: (context) => makerMemory.runtimePrompt(context.target.id),
    isCompactionMemoryEnabled: (context) => makerMemory.enabledForBackend(context.target.backendId),
    onCompactionDigest: (input) => { makerMemory.writeCompactionDigest(input); },
    mcpBridge: bridgeGeneration.baseSnapshot,
    resolveMcpBridge: bridgeGeneration.resolve,
    releaseManagedGeneration: () => {
      bridgeGeneration.release();
      scheduleGenerationGc(providerSnapshot.agentHome);
    },
    onUnexpectedRuntimeExit: (sessionId, generation) => {
      sessionHostForPi?.invalidateRuntime({
        backendId: piBackendId,
        backendInstanceGeneration,
        sessionId,
        generation
      });
    },
    readBlob: (blob) => artifacts.readBlob(blob),
    visionBridge: (input) => visionBridge.transform(input),
    resolveFile: (blob) => artifacts.resolveBlobPath(blob),
    commandConcurrencyGate,
    readAgentResourceSettings: () => runtimeGovernance.agentResource(),
    readCollaborationSettings: () => runtimeGovernance.collaboration(),
    includeManagedSubagentTools: (context) => toolPolicies.enabledForSession(
      context.sessionId,
      context.target.id,
      COLLABORATION_TOOL_POLICY_ID
    ),
    onProcessPriorityResult: ({ result }) => {
      if (result.application === "not_requested" || result.application === "applied") return;
      store.appendDiagnostic({
        severity: result.application === "process_gone" ? "info" : "warning",
        component: "runtime-governance",
        code: "PI_PROCESS_PRIORITY_NOT_APPLIED",
        message: "A requested priority policy could not be applied to a new local Pi process.",
        details: {
          requested: result.requested,
          application: result.application,
          appliesToNewProcessesOnly: result.appliesToNewProcessesOnly
        }
      });
    }
      });
    } catch (error) {
      bridgeGeneration.release();
      scheduleGenerationGc(providerSnapshot.agentHome);
      throw error;
    }
  };
  const codexBackendId = "codex";
  const claudeCodeBackendId = "claude-code";
  const managedChildWorkspaces = new ManagedChildWorktreeOwner({
    store,
    worktrees: () => sessionWorktrees,
    storageRoot: join(config.dataDirectory, "native-managed-child-worktrees"),
    currentBackend: backendId => {
      const current = backendInstances.get(backendId);
      return { generation: current.generation, available: current.state === "available" };
    }
  });
  let restartBackend!: (backendId: string, expectedGeneration?: number) => Promise<void>;
  const localBackendRuntimeSetup = new LocalCodexRuntime({
    rootDirectory: join(config.dataDirectory, "backend-runtime", codexBackendId, "installed-packages"),
    backendId: codexBackendId,
    ...(process.env["JOKO_CODEX_EXECUTABLE"] === undefined || config.codexExecutable === undefined ? {} : { manualExecutable: config.codexExecutable }),
    ...(config.codexExecutable === undefined ? {} : { fallbackExecutable: config.codexExecutable }),
    fetch: createOutboundStreamingFetch({ resolveProxy: dependencies.resolveOutboundProxy,
      environmentProxyForTarget: target => environmentProxyForTarget(target, process.env) }),
    currentGeneration: () => store.getBackend(codexBackendId).descriptor.instanceGeneration!,
    adopt: async expectedGeneration => {
      try { await restartBackend(codexBackendId, expectedGeneration); }
      catch (error) {
        // Post-publication recovery can fail after the new instance is already
        // authoritative. Its exact current publication must not be rolled back.
        const current = backendInstances.get(codexBackendId);
        if (current.generation === expectedGeneration || current.state !== "available"
          || current.descriptor.version !== "0.159.2") throw error;
      }
    }
  });
  const remoteBackendRuntimeSetup = new RemoteBackendRuntimeSetupManager({
    store,
    registry: remoteHosts,
    providers: [
      createRemoteCodexRuntimeSetupProvider(codexBackendId),
      createRemoteClaudeRuntimeSetupProvider(claudeCodeBackendId)
    ]
  });
  const claudeCodeCredentialPort = createClaudeCodeCredentialPort(
    credentials,
    "cred_backend_claude_code_subscription",
    claudeCodeBackendId
  );
  const claudeCodeOAuthFetch = createOutboundFetch(dependencies.resolveOutboundProxy);
  backendInstances = new BackendInstanceRegistry(store, {
    projectDescriptor: withSessionReferenceCapability,
    onCandidateCleanupUnknown: ({ instanceId, generation }) => {
      store.appendDiagnostic({
        severity: "warning",
        component: "backend-instance",
        code: "BACKEND_CANDIDATE_CLEANUP_UNCONFIRMED",
        message: "An unpublished Backend instance candidate could not be fully cleaned up.",
        details: { backendId: instanceId, instanceGeneration: generation }
      });
    }
  });
  const managedProviderProxy = new ManagedProviderProxy({
    providers,
    fetch: createOutboundFetch(dependencies.resolveOutboundProxy),
    assertOwner: (owner) => {
      const session = store.getSession(owner.sessionId).descriptor;
      const target = store.getTarget(owner.targetId).descriptor;
      const instance = backendInstances.get(owner.backendId);
      if (session.deletedAt !== undefined || session.targetId !== owner.targetId || session.backendId !== owner.backendId
        || session.binding.generation !== owner.sessionGeneration || target.backendId !== owner.backendId
        || instance.state !== "available" || instance.generation !== owner.backendInstanceGeneration) {
        throw new Error("Managed Provider operation owner is no longer current.");
      }
    }
  });
  await managedProviderProxy.start();
  const managedRuntime = (backendId: string, generation: number, support: import("@joko/core").ProviderRuntimeSupport) => managedProviderProxy.createRuntime({
    backendId, generation, support,
    assertCurrent: () => {
      const instance = backendInstances.get(backendId);
      if (instance.state !== "available" || instance.generation !== generation) throw new Error("Managed Provider Backend instance is no longer current.");
    }
  });
  await backendInstances.provision([
    {
      instanceId: piBackendId,
      adapterKind: "pi",
      displayName: "Pi",
      create: createPiCandidate
    },
    {
      instanceId: codexBackendId,
      adapterKind: "codex",
      displayName: "Codex",
      create: async ({ instanceId, generation }) => {
        const managedProviders = managedRuntime(instanceId, generation, CODEX_MANAGED_PROVIDER_SUPPORT);
        const codexHome = resolve(process.env["CODEX_HOME"] ?? join(userInfo().homedir, ".codex"));
        let smartRouting: Awaited<ReturnType<typeof prepareCodexSmartRouting>> | undefined;
        let mcpBridge: CodexMcpBridgeManager | undefined;
        try {
          smartRouting = await prepareCodexSmartRouting({
            desired: subagentModels.smartRoutingEnabled(instanceId),
            codexHome,
            outputDirectory: join(config.dataDirectory, "backend-runtime", instanceId, "smart-subagents"),
            instanceGeneration: generation,
            nativeProviderId: "openai",
            managedCandidates: managedProviders.listSmartRoutingCandidates?.() ?? []
          });
          mcpBridge = new CodexMcpBridgeManager({
            router: mcpRouter,
            includeToolPolicy: (sessionId, targetId, policyId) =>
              toolPolicies.enabledForSession(sessionId, targetId, policyId)
          });
          const codexExecutable = await localBackendRuntimeSetup.resolveExecutable() ?? "codex";
          return createCodexAdapter({
            nativeExecution: createNativeCodexExecution({ store, remoteExecution, executable: codexExecutable, commandConcurrencyGate }),
            taskShellEnv: context => inputHandoff?.envFor(context) ?? {},
            id: instanceId,
            instanceGeneration: generation,
            localMcpBridge: (input) => mcpBridge!.openLocal(input),
            remoteRuntimes: new RemoteCodexRuntimeResolver({
              store,
              remoteExecution,
              mcpBridge,
              captureSkillSourceAuthority: (workspaceId, signal) => remoteWorkspaceFiles.captureSkillSourceAuthority(workspaceId, signal),
              nativeSkillJournalRoot: join(config.dataDirectory, "remote-codex-skill-mounts", instanceId, String(generation))
            }),
            resolveNativeMemoryEnabled: () => makerMemory.nativeEnabledForBackend(instanceId, false),
            resolveNativeSkills: (context, signal) => piResources.runtimeSkillSnapshot(instanceId, context.target.id, signal, partnerConnections?.targetSkillReferences(privateResourceTarget(context) ?? context.target.id), context),
            resolveNativeSkillPolicy: context => partnerConnections?.nativeSkillPolicy(context),
            managedProviders,
            smartRouting,
            profileDirectory: codexHome,
            appServer: {
              transport: {
                command: codexExecutable,
                processOwner: {
                  rootDirectory: join(config.dataDirectory, "backend-runtime", instanceId, "processes"),
                  instanceId,
                  generation,
                  recoverStale: backendInstances.adapter(instanceId) === undefined,
                  supervisor: createDefaultManagedProcessSupervisor()
                }
              }
            },
            readBlob: (blob) => artifacts.readBlob(blob),
            resolveFile: (blob) => artifacts.resolveBlobPath(blob),
            maximumBlobBytes: artifacts.maximumBlobBytes,
            resolveArtifactMention: createArtifactMentionResolver({
              store, artifacts,
              resolveTarget: (session) => sessionWorktrees.effectiveTarget(session),
              assertBackendCurrent: (context) => {
                const current = backendInstances.get(instanceId);
                if (context.target.backendId !== instanceId || context.backendInstanceGeneration !== generation
                  || current.state !== "available" || current.generation !== generation) {
                  throw new Error("The Artifact input Backend instance is no longer current.");
                }
              }
            }),
            hostCapabilities: HOST_COMPOSED_CAPABILITIES
          });
        } catch (error) {
          const cleanup = await Promise.allSettled([
            mcpBridge?.shutdown() ?? Promise.resolve(),
            smartRouting?.cleanup() ?? Promise.resolve(),
            Promise.resolve().then(() => managedProviders.dispose())
          ]);
          const failures = cleanup.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
          if (failures.length > 0) {
            throw new AggregateError([error, ...failures], "Codex Backend construction and candidate cleanup failed.");
          }
          throw error;
        }
      }
    },
    {
      instanceId: claudeCodeBackendId,
      adapterKind: "claude-agent-sdk-stdio",
      displayName: "Claude Code",
      create: ({ instanceId, generation }) => createClaudeCodeAdapter({
        taskShellEnv: context => inputHandoff?.envFor(context) ?? {},
        id: instanceId,
        instanceGeneration: generation,
        mcpBridge: createClaudeMcpBridge({
          router: mcpRouter,
          assertSessionCurrent: (sessionId, targetId, sessionGeneration) => {
            const session = store.getSession(sessionId).descriptor;
            const target = store.getTarget(targetId).descriptor;
            const backend = backendInstances.get(instanceId);
            if (session.deletedAt !== undefined || session.archived || session.targetId !== targetId
              || session.backendId !== instanceId || session.binding.generation !== sessionGeneration
              || target.backendId !== instanceId || backend.state !== "available" || backend.generation !== generation) {
              throw new Error("The Claude MCP product Session authority is stale.");
            }
          },
          includeToolPolicy: (sessionId, targetId, policyId) =>
            toolPolicies.enabledForSession(sessionId, targetId, policyId)
        }),
        remoteRuntimes: new RemoteClaudeRuntimeResolver({
          store,
          remoteExecution,
          storeGeneration: generation,
          authorizeDerivedWorkspace: createRemoteClaudeDerivedWorkspaceAuthorizer({
            store,
            worktrees: () => sessionWorktrees
          })
        }),
        managedProviders: managedRuntime(instanceId, generation, CLAUDE_MANAGED_PROVIDER_SUPPORT),
        credentialPort: claudeCodeCredentialPort,
        resolveSubagentModel: (providerId) => subagentModels.resolve(instanceId, providerId),
        prepareManagedChildWorkspace: input => managedChildWorkspaces.prepare(input),
        resolveNativeMemoryEnabled: () => makerMemory.nativeEnabledForBackend(instanceId),
        oauthFetch: claudeCodeOAuthFetch,
        readBlob: (blob) => artifacts.readBlob(blob),
        resolveFile: (blob) => artifacts.resolveBlobPath(blob),
        resolveTextResources: (context, signal) => piResources.runtimeTextSnapshot(
          instanceId,
          context.target.id,
          signal,
          partnerConnections?.targetSkillReferences(privateResourceTarget(context) ?? context.target.id), context
        ),
        resolveNativeSkills: (context, signal) => piResources.runtimeSkillSnapshot(instanceId, context.target.id, signal, partnerConnections?.targetSkillReferences(privateResourceTarget(context) ?? context.target.id), context),
        resolveNativeSkillPolicy: context => partnerConnections?.nativeSkillPolicy(context),
        resolveArtifactMention: createArtifactMentionResolver({
          store, artifacts,
          resolveTarget: (session) => sessionWorktrees.effectiveTarget(session),
          assertBackendCurrent: (context) => {
            const current = backendInstances.get(instanceId);
            if (context.target.backendId !== instanceId || context.backendInstanceGeneration !== generation
              || current.state !== "available" || current.generation !== generation) {
              throw new Error("The Artifact input Backend instance is no longer current.");
            }
          }
        }),
        probeCwd: config.workspace.root,
        processOwner: {
          rootDirectory: join(config.dataDirectory, "backend-runtime", instanceId),
          instanceId,
          generation,
          recoverStale: backendInstances.adapter(instanceId) === undefined,
          supervisor: createDefaultManagedProcessSupervisor()
        },
        sessionStoreRootDirectory: join(config.dataDirectory, "backend-session-store", instanceId),
        ...(config.claudeCodeExecutable === undefined
          ? {}
          : { pathToClaudeCodeExecutable: config.claudeCodeExecutable }),
        hostCapabilities: HOST_COMPOSED_CAPABILITIES
      })
    }
  ]).catch(async (error) => {
    const cleanupErrors: unknown[] = [];
    try { await backendInstances.dispose(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    try { await managedProviderProxy.close(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "Backend instance provisioning failed and cleanup remained incomplete."
      );
    }
    throw error;
  });
  let startupSessionHost: SessionHost | undefined;
  let desktopVoiceConversation: DesktopVoiceConversationManager | undefined;
  let startupSessionWorktrees: SessionWorktreeCoordinator | undefined;
  let startupHistoryMaintenance: HistoryMaintenance | undefined;
  let startupCleanupHandled = false;
  let startupRoutineRuntime: ExtensionRoutineRuntime | undefined;
  let startupPartnerAutonomy: PartnerAutonomyManager | undefined;
  let startupCardRuntime: ExtensionCardRuntime | undefined;
  let startupHostedAgents: HostedAgentRuntime | undefined;
  let startupExtensionCards: ExtensionCardsManager | undefined;
  let startupBackendCleanup: Promise<readonly unknown[]> | undefined;
  const cleanupStartupBackendOwners = (): Promise<readonly unknown[]> => {
    if (startupBackendCleanup !== undefined) return startupBackendCleanup;
    startupBackendCleanup = (async () => {
      const failures: unknown[] = [];
      const attempt = async (cleanup: () => unknown): Promise<void> => {
        try { await cleanup(); } catch (error) { failures.push(error); }
      };
      await attempt(() => terminals.dispose());
      await attempt(() => hostedAgentSources?.stopDiscovery());
      await attempt(() => inputHandoff?.close());
      await attempt(() => inputHandoffNotifications?.close());
      await attempt(() => nativeInputHandoff?.close());
      await attempt(() => desktopVoiceConversation?.close());
      if (startupSessionHost === undefined) {
        await attempt(() => backendInstances.dispose());
      } else {
        await attempt(() => startupSessionHost!.dispose());
        await attempt(() => backendInstances.disposeRetainedCleanups());
      }
      await attempt(() => hostedAgentSources?.close());
      await attempt(() => startupHostedAgents?.close());
      await attempt(() => providerGroups?.close());
      await attempt(() => providerSharing?.close());
      await attempt(() => managedProviderProxy.close());
      return failures;
    })();
    return startupBackendCleanup;
  };
  let closed = false;
  let startupPartnerImports: PartnerImportManager | undefined;
  let startupPartnerHomes: PartnerHomeOwner | undefined;
  let startupPartnerImportRuntime: PartnerImportRuntime | undefined;
  try {
  const initialAdapters: readonly BackendAdapter[] = backendInstances.availableAdapters();
  const nativeProviderIds = (id: string) => (store.getBackend(id).descriptor.providers ?? []).map(provider => provider.providerId);
  const nativeRemoteModels = (id: string) => {
    if (backendInstances.adapter(id)?.hostedExecutionCapabilities?.toolsOnSource !== true) return [];
    const descriptor = store.getBackend(id).descriptor;
    return descriptor.models.filter(model => {
      const authentication = descriptor.providers?.find(provider => provider.providerId === model.providerId)?.authenticationState ?? descriptor.authenticationState;
      return (authentication === "authenticated" || authentication === "not_required") && providerRoutingEnabled(store, id, model.providerId)
        && modelRoutingEnabled(store, id, model.providerId, model.modelId);
    });
  };
  const hostedAgents = startupHostedAgents = new HostedAgentRuntime({ store, connections, nodeId: serverId, root: join(config.dataDirectory, "hosted-agents"),
    authenticateGuest: context => { if (!providerSharing) throw new Error("Provider sharing is unavailable."); return providerSharing.authenticateGuest(context); },
    decorateCatalog: catalog => providerGroups?.decorateCatalog(catalog) ?? catalog,
    resolveSharedProvider: (backendId, providerId) => providerGroups?.sharedProvider(backendId, providerId),
    inferNativeText: createHostedNativeTextInference({ store, registry: backendInstances, routes: modelRoutes }),
    artifactCapacityBytes: artifacts.maximumBlobBytes, factories: [{ backendId: piBackendId, displayName: store.getBackend(piBackendId).descriptor.displayName,
      isolatedGuests: () => backendInstances.adapter(piBackendId)?.hostedExecutionCapabilities?.isolatedGuests === true,
      describe: () => store.getBackend(piBackendId).descriptor,
      providerIds: () => providers.list(piBackendId).map(provider => provider.provider.id),
      providerDisplayName: providerId => providers.list(piBackendId).find(provider => provider.provider.id === providerId)?.displayName ?? providerId,
      capabilities: () => store.getBackend(piBackendId).descriptor.capabilities,
      version: () => store.getBackend(piBackendId).descriptor.version,
      models: () => {
        if (backendInstances.adapter(piBackendId)?.hostedExecutionCapabilities?.toolsOnSource !== true) return [];
        const available = availableManagedProviderIds(providers.list(piBackendId), providerId => providerRoutingEnabled(store, piBackendId, providerId));
        return store.getBackend(piBackendId).descriptor.models.filter(model => available.has(model.providerId)
          && modelRoutingEnabled(store, piBackendId, model.providerId, model.modelId));
      },
      create: async creation => {
        creation.signal.throwIfAborted();
        const hostedSettings = effectivePiSettings(baseSettings, store.findSetting<unknown>("service", "orchestrator", `settings.pi.${piBackendId}`)?.value);
        const allowed = new Set(creation.providerIds);
        const snapshot = await providers.createPiGenerationSnapshot({ snapshotsRoot: join(creation.home, "provider-snapshots", randomUUID()), settings: hostedSettings,
          providerEnabled: providerId => allowed.has(providerId) && providerRoutingEnabled(store, piBackendId, providerId),
          modelEnabled: (providerId, modelId) => modelRoutingEnabled(store, piBackendId, providerId, modelId)
            && (creation.trust === "owner" || creation.modelIds.includes(modelId)) });
        creation.signal.throwIfAborted();
        return createPiAdapter({ agentHome: snapshot.agentHome, sessionRoot: creation.home,
          readBlob: async blob => ({ data: await creation.readBlob(blob), mimeType: blob.mimeType }),
          ...(config.piExecutable === undefined ? {} : { command: config.piExecutable }),
          providers: snapshot.providers, settings: hostedSettings, environment: snapshot.environment, secretEnvironmentNames: snapshot.secretEnvironmentNames,
          catalogGeneration: snapshot.catalogGeneration, nativeAuthProviderIds: snapshot.nativeAuthProviderIds,
          nativeAuthenticatedProviderIds: snapshot.nativeAuthenticatedProviderIds,
          nativeModels: providerAuth.listNativeModels().filter(model => allowed.has(model.providerId)
            && modelRoutingEnabled(store, piBackendId, model.providerId, model.modelId) && (creation.trust === "owner" || creation.modelIds.includes(model.modelId))),
          loadNativeAuth: input => {
            creation.signal.throwIfAborted(); if (input.providerIds.some(providerId => !allowed.has(providerId))) throw new Error("Hosted native Provider authentication is outside its scope.");
            return providerAuth.loadNativeAuth(input);
          },
          persistNativeAuth: input => {
            creation.signal.throwIfAborted(); if (!allowed.has(input.providerId)) throw new Error("Hosted native Provider authentication is outside its scope.");
            return providerAuth.persistNativeAuth(input);
          },
          processSupervisor: createDefaultManagedProcessSupervisor(),
          ...(creation.sourceMcp ? { mcpBridge: creation.sourceMcp.pi() } : {}),
          includeManagedSubagentTools: context => context.hostedExecution?.workspace.subagentsEnabled === true,
          readAgentResourceSettings: () => runtimeGovernance.agentResource(),
          readCollaborationSettings: () => runtimeGovernance.collaboration()
        });
      }
    }, {
      backendId: codexBackendId, displayName: store.getBackend(codexBackendId).descriptor.displayName,
      isolatedGuests: () => backendInstances.adapter(codexBackendId)?.hostedExecutionCapabilities?.isolatedGuests === true,
      describe: () => store.getBackend(codexBackendId).descriptor,
      providerIds: () => nativeProviderIds(codexBackendId),
      providerDisplayName: providerId => store.getBackend(codexBackendId).descriptor.providers?.find(provider => provider.providerId === providerId)?.displayName ?? providerId,
      capabilities: () => store.getBackend(codexBackendId).descriptor.capabilities, version: () => store.getBackend(codexBackendId).descriptor.version,
      models: () => nativeRemoteModels(codexBackendId),
      create: async creation => createHostedAgentCodexAdapter({ creation, backendId: codexBackendId, providers,
        captureNativeAuthentication: async () => {
          const original = backendInstances.adapter(codexBackendId);
          if (!(original instanceof CodexBackendAdapter)) throw new Error("The original native account is unavailable.");
          const assertOriginal = () => {
            creation.signal.throwIfAborted(); creation.execution.assertCurrent();
            if (backendInstances.adapter(codexBackendId) !== original) throw new Error("The original native account was replaced.");
          };
          assertOriginal(); const account = await original.captureHostedAuthentication(); assertOriginal();
          if (account.kind === "chatgpt") return { kind: "chatgpt", readTokens: async (refresh, staleAccessToken) => {
            assertOriginal(); const tokens = await account.readTokens(refresh, staleAccessToken); assertOriginal(); return tokens;
          } };
          return { kind: "api_key", readApiKey: async () => {
            assertOriginal(); const apiKey = await account.readApiKey(); assertOriginal(); return apiKey;
          } };
        },
        nativeEnvironment: Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]])),
        executable: await localBackendRuntimeSetup.resolveExecutable() ?? config.codexExecutable ?? "codex", fetch: createOutboundFetch(dependencies.resolveOutboundProxy) })
    }, {
      backendId: claudeCodeBackendId, displayName: store.getBackend(claudeCodeBackendId).descriptor.displayName,
      isolatedGuests: () => backendInstances.adapter(claudeCodeBackendId)?.hostedExecutionCapabilities?.isolatedGuests === true,
      describe: () => store.getBackend(claudeCodeBackendId).descriptor,
      providerIds: () => nativeProviderIds(claudeCodeBackendId),
      providerDisplayName: providerId => store.getBackend(claudeCodeBackendId).descriptor.providers?.find(provider => provider.providerId === providerId)?.displayName ?? providerId,
      capabilities: () => store.getBackend(claudeCodeBackendId).descriptor.capabilities, version: () => store.getBackend(claudeCodeBackendId).descriptor.version,
      models: () => nativeRemoteModels(claudeCodeBackendId),
      create: creation => createHostedAgentClaudeAdapter({ creation, backendId: claudeCodeBackendId, providers, credentialPort: claudeCodeCredentialPort,
        fetch: claudeCodeOAuthFetch, ...(config.claudeCodeExecutable === undefined ? {} : { pathToExecutable: config.claudeCodeExecutable }) })
    }] });
  providerSharing = await createProviderSharingRuntime({ store, directory: join(config.dataDirectory, "provider-sharing"), serverId,
    origin: advertisedOrigin, endpointPublicKey: linkspanIdentity.publicKey, vault: credentialVault, native: hostedAgents, connections,
    closeNative: (digest, runId) => hostedAgents.endpoint.closeProviderGrant(digest, runId),
    readQuota: (backendId, providerId, signal) => {
      if (!providerGroups) throw new Error("Provider groups are unavailable.");
      return providerGroups.sharedQuota({ backendId, providerId }, signal);
    },
    readGroupUsage: (backendId, providerId, memberId, fromDay) => providerGroups?.usage.usage.rows({
      group: { backendId, providerId }, partyId: memberId, fromDay }) ?? [] });
  const resolveSessionContextDefaults = composeSessionContextDefaultsResolver([{
    adapter: { id: piBackendId },
    resolve: () => {
      const configured = store.findSetting<{
        readonly autoCompaction?: boolean;
        readonly autoRetry?: boolean;
      }>("service", "orchestrator", `settings.pi.${piBackendId}`)?.value;
      const defaults = projectPiSettingsDefaults(settings);
      return {
        autoCompaction: configured?.autoCompaction ?? defaults.autoCompaction,
        autoRetry: configured?.autoRetry ?? defaults.autoRetry
      };
    }
  }]);
  const blobTransfers = new BlobTransferCoordinator(artifacts);
  const workspaceSnapshotRepository = new OperationalWorkspaceSnapshotRepository(store);
  const workspaceChanges = new WorkspaceChangeSetService({
    snapshotDirectory: join(config.dataDirectory, "workspace-snapshots"),
    repository: workspaceSnapshotRepository,
    excludedRoots: [config.dataDirectory, config.piAgentHome, config.artifactDirectory]
  });
  await workspaceChanges.initialize();
  const workspaces = new WorkspaceService({
    changeJournal: new OperationalWorkspaceChangeJournal(store),
    remoteDelegate: remoteWorkspaceFiles
  });
  sessionWorktrees = startupSessionWorktrees = new SessionWorktreeCoordinator({
    store,
    workspaces,
    storageRoot: join(config.dataDirectory, "worktrees"),
    remoteOwner: new RemoteClaudeWorktreeOwner({ store, remoteExecution })
  });
  const workspaceCapture = new DurableWorkspaceRunCapture(store, workspaceChanges, workspaces, gitSafety);
  let androidRuntimeForSessionCleanup: AndroidRuntimeSupervisor | undefined;
  let computerBridgeForSessionCleanup: ComputerToolBridgeProvider | undefined;
  let messaging: MessagingManager | undefined;
  let partnerMessaging: PartnerMessagingRuntime | undefined;
  let objectives: ObjectiveManager | undefined;
  const configuredProviderRouteEnabled = (backendId: string, providerId: string): boolean => {
    const backend = store.getBackend(backendId).descriptor;
    if (backend.capabilities.get(MANAGED_PROVIDER_CATALOG_CAPABILITY)?.supported !== true) return true;
    return providers.list(backendId).find((provider) => provider.provider.id === providerId)?.enabled !== false;
  };
  const partnerRuntimePrompt = new PartnerRuntimePromptResolver(partnerStore, store, partnerMemoryPreferences,
    (partnerId, assertCurrent) => partnerImportStorage.environment.read(partnerId, assertCurrent), makerMemory,
    (session, partnerId) => partnerGroupRuntime?.validTarget(session, partnerId) === true || partnerNetworkLanes?.validTarget(session, partnerId) === true);
  let partnerSessionTasks: PartnerSessionTaskManager | undefined;
  let partnerTodos: PartnerTodoManager | undefined;
  let managedModelRuntimeForSession: ManagedModelRuntimeSystem | undefined;
  let modelWorkingContext: ModelWorkingContextCoordinator | undefined;
  const sessionHost = startupSessionHost = new SessionHost(store, artifacts, initialAdapters, {
    partnerLearning: {
      captureSource: source => partnerLearning?.captureSource(source) ?? false,
      accepted: occurrenceId => partnerLearning?.accepted(occurrenceId),
      sealed: (occurrenceId, completionEventId) => partnerLearning?.sealed(occurrenceId, completionEventId),
      settled: (occurrenceId, completionEventId, outcome) => partnerLearning?.settled(occurrenceId, completionEventId, outcome)
    },
    registerPartnerLearningToolAuthority: authority => mcpRouter.registerPartnerLearningToolAuthority(authority),
    resolveModelWorkingContext: target => modelWorkingContext?.resolve(target),
    resolveMcpAppModelContext: async sessionId => await mcpApps?.host.modelContext(sessionId)
      ?? { text: "", async assertCurrent() {}, consume() {} },
    prepareManagedProviderRuntime: async context => { await managedModelRuntimeForSession?.prepareProviderRuntime(context); },
    backendDescriptors: backendInstances.descriptors(),
    backendDescriptorsAlreadyPublished: true,
    workspaceCapture,
    prepareProjectGit: async (input) => {
      if (runtimeGovernance.gitSafety().mode !== "all-projects") return;
      await projectGitBootstrap.ensure(input);
    },
    freezeToolPolicies: (sessionId, targetId) => { toolPolicies.freezeSession(sessionId, targetId); },
    assertPrewarmResources: target => {
      if (!target.trusted || target.remoteWorkspace !== undefined) throw new Error("Agent prewarm requires an approved local project.");
      const resources = piResources.list({ backendId: target.backendId, targetId: target.id });
      if (resources.some(resource => !["approved", "installed", "loaded", "disabled", "removed"].includes(resource.state))) {
        throw new Error("Approve or disable this project's pending resources before starting an Agent early.");
      }
      return JSON.stringify(resources.map(resource => [resource.id, resource.versionNumber.toString(), resource.discoveredRevision,
        resource.state, resource.enabled, resource.approvedAt ?? null]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
    },
    scheduleRunNotifications,
    worktrees: sessionWorktrees,
    usageOwnerId: serverId,
    usageMoneyKind: (backendId, providerId) => providerUsageMoneyKind(
      providers,
      store.getBackend(backendId).descriptor,
      providerId
    ),
    backendEnabled: (backendId) => store.findSetting<{ readonly enabled?: boolean }>(
      "service",
      "orchestrator",
      `settings.backend.${backendId}`
    )?.value.enabled ?? true,
    providerRoutingEnabled: (backendId, providerId) => providerRoutingEnabled(store, backendId, providerId)
      && configuredProviderRouteEnabled(backendId, providerId),
    modelRoutingEnabled: (backendId, providerId, modelId) => modelRoutingEnabled(store, backendId, providerId, modelId)
      && configuredProviderRouteEnabled(backendId, providerId)
      && hostedAgentSources?.modelAvailable(backendId, providerId, modelId) !== false,
    modelAccessRestricted: (backendId) => backendModelAccessRestricted(store, backendId)
      || (
        store.getBackend(backendId).descriptor.capabilities.get("provider.managed_catalog")?.supported === true
        && providers.list(backendId).some((provider) => !provider.enabled)
      ),
    sessionRuntimeFallbackEnabled: () => configuredSessionRuntimeFallback(store),
    serviceSessionRuntimeFallback: (input) => {
      const task = partnerSessionTasks?.fallback(input);
      const group = partnerGroupRuntime?.fallback(input);
      return task?.owned ? task : group?.owned ? group : partnerSessionRuntimeFallback(partnerStore, input);
    },
    partnerSessionRetiring: (sessionId) => partnerStore.isPartnerSessionRetiring(sessionId)
      || (partnerHomeRuntime?.blocksExecution(sessionId) ?? partnerHomeStorage.blocksSession(sessionId))
      || partnerStore.isPartnerTargetRetiring(store.getSession(sessionId).descriptor.targetId) || partnerSessionTasks?.isRetiring(sessionId) === true
      || partnerGroupRuntime?.isRetiring(sessionId) === true || partnerNetworkLanes?.isRetiring(sessionId) === true,
    partnerTargetRetired: (targetId) => partnerStore.isPartnerTargetRetired(targetId) || partnerHomeRuntime?.blocksTarget(targetId) === true,
    partnerSessionRestarting: (sessionId) => partnerStore.isPartnerSessionRestarting(sessionId) || partnerMessaging?.isRestarting(sessionId) === true,
    partnerSessionPaused: (sessionId) => partnerStore.isPartnerSessionPaused(sessionId) || partnerSessionTasks?.isHeld(sessionId) === true || partnerGroupRuntime?.isHeld(sessionId) === true || partnerNetworkLanes?.isHeld(sessionId) === true,
    partnerSessionPolicy: (sessionId) => {
      const profile = partnerStore.findPartnerByCanonicalSession(sessionId);
      return profile === undefined ? undefined : {
        identity: JSON.stringify([profile.id, profile.homeTargetId, profile.canonicalSessionId, profile.profileVersion, profile.capabilities.permissionMode]),
        status: profile.initializationState
      };
    },
    sideChatSourceAllowed: sessionId => partnerStore.getSessionLink(sessionId) === undefined,
    decorateRuntimePrompt: answerDeliveryPrompt,
    resolveServiceRuntimePrompt: async (session, assertCurrent) => {
      const resolved = await partnerRuntimePrompt.resolve(session, assertCurrent);
      assertCurrent();
      return resolved ?? session.appendSystemPrompt;
    },
    resolvePartnerReplyQuote: (sessionId, quote) => {
      const session = store.getSession(sessionId).descriptor, link = partnerStore.getSessionLink(sessionId);
      if (!link || !['canonical', 'topic'].includes(link.role)) throw new Error('This task has no private Partner reply authority.');
      const profile = partnerStore.getPartner(link.partnerId);
      if (profile.lifecycle !== 'active' || profile.initializationState !== 'ready' || profile.homeTargetId !== session.targetId
        || session.archived || session.deletedAt !== undefined || quote.generation !== session.binding.generation) throw new Error('The original private conversation changed.');
      return partnerReplyQuoteContext(store, sessionId, quote);
    },
    resolvePartnerTodoQuote: (sessionId, quote) => {
      if (!partnerTodos) throw new Error("Partner affairs are unavailable."); return partnerTodos.quoteContext(sessionId, quote);
    },
    resolveServiceRuntimeConfiguration: session => {
      const connections = partnerConnections?.runtimeIdentity(session), skills = partnerSkills?.runtimeIdentity(session);
      return connections === undefined && skills === undefined ? undefined : JSON.stringify([connections ?? null, skills ?? null]);
    },
    backendDispatchBlocked: (backendId) => deferredBackendRestarts?.blocksDispatch(backendId) === true,
    onBackendMayBeIdle: (backendId) => deferredBackendRestarts?.onBackendMayBeIdle(backendId),
    sessionRuntimeFallbackContext: (backendId) => {
      const availableProviderIds = availableBackendProviderIds(
        store.getBackend(backendId).descriptor,
        providers.list(backendId),
        (providerId) => providerRoutingEnabled(store, backendId, providerId)
      );
      const configured = store.findSetting<{
        readonly defaultModel?: {
          readonly model?: { readonly providerId?: string; readonly modelId?: string };
        };
      }>("service", "orchestrator", `settings.backend.${backendId}`)?.value.defaultModel?.model;
      const explicitDefault = configured?.providerId?.trim() && configured.modelId?.trim()
        ? { providerId: configured.providerId.trim(), modelId: configured.modelId.trim() }
        : undefined;
      return {
        availableProviderIds,
        ...(explicitDefault === undefined ? {} : { explicitDefault })
      };
    },
    onSessionRuntimeClosed: (sessionId) => {
      inputHandoff?.cleanupSession(sessionId);
      sessionWorktrees.notifyRecycleOpportunity(sessionId);
      androidRuntimeForSessionCleanup?.closeSession(sessionId);
      void computerBridgeForSessionCleanup?.closeSession(sessionId).catch(() => undefined);
    },
    onUserInputAdmitted: (transactionStore, result) => objectives?.onUserInputAdmitted(transactionStore, result),
    onServiceRunSettled: async (input) => {
      personalDevelopmentCoordinator?.onRunSettled(input);
      const settlements: Promise<void>[] = [];
      if (objectives !== undefined) settlements.push(objectives.onRunSettled(input));
      if (messaging !== undefined) settlements.push(Promise.resolve(messaging.onRunSettled(input)));
      const results = await Promise.allSettled(settlements);
      const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
      if (failures.length > 0) throw new AggregateError(failures, "Service Run settlement projection failed.");
    },
    onServiceInteractionOpened: (input) => { partnerGroupRuntime?.interactionChanged(input.sessionId); return messaging?.onInteractionOpened(input); },
    onServiceInteractionSettled: (input) => { partnerGroupRuntime?.interactionChanged(input.sessionId); return messaging?.onInteractionSettled(input); },
    closeSessionTerminals: (sessionId) => terminals.closeSession(sessionId)
  });
  let hostedAgentAutoReview: ReturnType<typeof createHostedAgentAutoReviewer> | undefined;
  desktopVoiceConversation = new DesktopVoiceConversationManager({ store, host: sessionHost, models: new SpeechModelCatalog(store, modelRoutes),
    dictationActive: connectionId => voiceInput.hasActiveSession(connectionId),
    companion: sessionId => {
      const link = partnerStore.getSessionLink(sessionId);
      if (!link || link.role !== "canonical") throw new Error("Voice companion is unavailable.");
      const profile = partnerStore.getPartner(link.partnerId);
      if (profile.lifecycle !== "active" || profile.canonicalSessionId !== sessionId || profile.initializationState !== "ready") throw new Error("Voice companion is unavailable.");
      return { identity: `${profile.displayName}\n${profile.identitySource}`, token: JSON.stringify([profile.id, profile.revision.toString(), profile.homeTargetId, sessionId]) };
    },
    infer: createHostedNativeTextInference({ store, registry: backendInstances, routes: modelRoutes }),
    fetch: createSpeechFetch(async (url, signal) => {
      const environment = environmentProxyForTarget(new URL(url), process.env);
      return environment === undefined ? await dependencies.resolveOutboundProxy?.(url, { signal }) : environment;
    }) });
  const readHostedAgentPolicy = (context: AdapterContext): import("./hosted-agent-executor.js").HostedAgentExecutorPolicy => {
    let session: ReturnType<OperationalStore["getSession"]>["descriptor"] | undefined;
    try { session = store.getSession(context.sessionId).descriptor; }
    catch (error) { if (!(error instanceof NotFoundError && error.resource === "Session" && error.id === context.sessionId)) throw error; }
    const snapshot = policySnapshotFor(store, context.target), permissionMode = session?.permissionMode ?? "ask", planMode = session?.planMode ?? false;
    const current = sessionHost.extraDirectories.listForTarget(context.target.id);
    const approvedRoots = (context.extraDirectories ?? []).filter(directory => current.some(candidate => candidate.id === directory.id
      && candidate.path === directory.path && candidate.access === directory.access));
    return { revision: JSON.stringify([snapshot.generation, permissionMode, planMode, approvedRoots]), permissionMode, planMode, approvedRoots, snapshot, confirmCredentials: true };
  };
  const hostedResourceCatalog = new HostedAgentSourceResourceCatalog({ store, resources: piResources,
    nativeBackends: new Map([["pi", piBackendId], ["codex", codexBackendId], ["claude-agent-sdk-stdio", claudeCodeBackendId]]),
    allowedSkillIds: context => partnerConnections?.targetSkillReferences(privateResourceTarget(context) ?? context.target.id) });
  hostedAgentSources = new HostedAgentSources({ store, peers: devicePeers, registry: backendInstances, host: sessionHost,
    remoteExecution,
    sharing: providerSharing.directory, sourceDeviceId: serverId,
    temporaryRoot: join(config.dataDirectory, "hosted-source-transfers"), commandConcurrencyGate,
    mcpRouter, includeToolPolicy: (context, policyId) => toolPolicies.enabledForSession(context.sessionId, context.target.id, policyId),
    resolveMemoryPrompt: context => makerMemory.runtimePrompt(context.target.id),
    readBlob: async blob => (await artifacts.readBlob(blob)).data,
    resolveFile: blob => artifacts.resolveBlobPath(blob),
    resolveArtifactMention: createArtifactMentionResolver({ store, artifacts, resolveTarget: session => ({ ...sessionWorktrees.effectiveTarget(session), backendId: session.descriptor.backendId }),
      assertBackendCurrent: context => { const current = backendInstances.get(context.target.backendId);
        if (current.generation !== context.backendInstanceGeneration) throw new Error("The original Source Backend instance changed."); } }),
    ...(dependencies.resolveOutboundProxy === undefined ? {} : { resolveProxy: dependencies.resolveOutboundProxy }),
    environmentProxyForTarget: target => environmentProxyForTarget(target, process.env),
    resolveCodexExecutable: () => localBackendRuntimeSetup.resolveExecutable(),
    readPolicy: readHostedAgentPolicy,
    resolveTextResources: (context, nativeKind) => hostedResourceCatalog.text(context, nativeKind),
    resolveNativeSkills: (context, signal, nativeKind) => hostedResourceCatalog.skills(context, signal, nativeKind),
    resolveNativeSkillPolicy: context => partnerConnections?.nativeSkillPolicy(context),
    reviewTool: (context, call, signal, assertCurrent, policy) => hostedAgentAutoReview?.(context, call, signal, assertCurrent, policy)
      ?? Promise.resolve({ verdict: "ask", unavailable: true, reason: "Automatic review is unavailable; confirm this action explicitly." }) });
  await hostedAgentSources.initialize();
  const providerGroupOwnerGeneration = randomUUID();
  providerGroups = new ProviderGroupRuntime({ store, registry: backendInstances, sources: hostedAgentSources, nodeId: serverId,
    nodeName: () => hostname().trim() || "This computer", sessions: sessionHost.providerGroupSessionPort(),
    ownerGeneration: () => { if (closed) throw new Error("Provider groups have closed."); return providerGroupOwnerGeneration; },
    activeTurns: (backendId, providerId) => sessionHost.activeProviderTurns(backendId, providerId) + hostedAgents.endpoint.activeProviderTurns(backendId, providerId),
    assertRemoteAllowed: key => { if (!hostedAgents.settings.providerEnabled(key.backendId, key.providerId)) throw new Error("Remote Provider use is disabled."); },
    sharing: providerSharing.directory, ownedRecipients: key => providerSharing!.host.ownedRecipients(key.backendId, key.providerId),
    readAccountUsage: async (backendId, providerId, signal) => {
      signal.throwIfAborted(); const backend = backendInstances.get(backendId).descriptor;
      const managed = providers.list(backendId).find(entry => entry.provider.id === providerId);
      if (managed?.capabilities?.has("provider.account_usage")) return providerAccountUsage.get(providerId, signal);
      if (!backend.capabilities.get("provider.account_usage")?.supported) return undefined;
      return sessionHost.invokeBackendAdapter(backendId, async adapter => {
        const operations = adapter as BackendAdapter & { readAccountUsage?: (providerId: string, signal?: AbortSignal) => Promise<ProviderAccountUsageSnapshot> };
        if (!operations.readAccountUsage) return undefined;
        const snapshot = await operations.readAccountUsage(providerId, signal); signal.throwIfAborted();
        return snapshot.providerId === providerId ? snapshot : undefined;
      });
    } });
  sessionHost.installProviderGroupRuntime(providerGroups);
  hostedAgents.installEndpoint(createProviderGroupHostedEndpoint({ base: hostedAgents.host, runtime: providerGroups,
    root: join(config.dataDirectory, "hosted-agents"), assertSelection: (principal, input) => {
      const computer = hostedAgents.settings.captureComputer(), provider = hostedAgents.settings.captureProvider(input.backendId, input.providerId);
      const assertCurrent = () => { computer(); provider(); hostedAgents.assertGuestSelection(principal, input); }; assertCurrent(); return assertCurrent;
    },
    capture: (member, principal, modelIds, assertCurrent) => providerGroups!.captureHosted(member, principal, modelIds, assertCurrent) }));
  const personalDevelopmentRoot = join(config.dataDirectory, "personal-development");
  personalDevelopmentNativeBroker = new PersonalDevelopmentNativeBroker({
    directory: join(config.dataDirectory, "personal-development-native"), connections
  });
  await personalDevelopmentNativeBroker.initialize();
  const nativeDevelopmentVersions = personalDevelopmentNativeBroker.nativeVersions;
  const personalDevelopmentProcess = createSupervisedDevelopmentProcessAuthority({
    journalDirectory: join(personalDevelopmentRoot, "command-journal"),
    ...(config.personalDevelopmentCommandHostPath === undefined ? {} : { windowsHelperPath: config.personalDevelopmentCommandHostPath }),
    nodeExecutable: process.execPath
  });
  const personalDevelopmentFetch = createOutboundStreamingFetch({ resolveProxy: dependencies.resolveOutboundProxy,
    environmentProxyForTarget: target => environmentProxyForTarget(target, process.env) });
  personalDevelopment = new PersonalDevelopmentOwner({
    rootDirectory: personalDevelopmentRoot,
    process: personalDevelopmentProcess,
    worktrees: createPersonalDevelopmentWorktreeAuthority({ store, worktrees: sessionWorktrees,
      ownerId: personalDevelopmentOwnerIdentity(personalDevelopmentRoot), sourceRoot: join(personalDevelopmentRoot, "source") }),
    nativeVersions: { ...nativeDevelopmentVersions,
      busy: async () => personalDevelopmentCoordinator?.busy() === true || await nativeDevelopmentVersions.busy() },
    fetch: personalDevelopmentFetch
  });
  personalDevelopmentCoordinator = new PersonalDevelopmentCoordinator({ store, owner: personalDevelopment,
    host: sessionHost, worktrees: sessionWorktrees, closeTerminals: sessionId => terminals.closeSession(sessionId),
    availability: () => personalDevelopmentNativeBroker!.availability(),
    sourceTarget: async () => {
      const original = personalDevelopmentNativeBroker!.metadata()?.original;
      if (original === undefined) throw new PersonalDevelopmentError("ENVIRONMENT_NOT_READY");
      return { channel: original.development ? "dev" : /-beta(?:[.+-]|$)/iu.test(original.version) ? "beta" : "release", version: original.version };
    }
  });
  personalDevelopmentNativeBroker.setVersionReconciler(input => personalDevelopment!.reconcileVersionHandoff(input));
  personalDevelopmentDoctor = new PersonalDevelopmentDoctor({ store, owner: personalDevelopment,
    host: sessionHost, coordinator: personalDevelopmentCoordinator,
    prerequisites: createPersonalDevelopmentDoctorPrerequisites({ directory: personalDevelopmentRoot, process: personalDevelopmentProcess }),
    runtime: async () => {
      const sourceTarget = await personalDevelopmentCoordinator!.sourceTarget();
      const current = personalDevelopmentNativeBroker!.metadata()?.current, artifact = personalDevelopment!.versions().personal;
      return current?.id === "personal" && artifact !== undefined && current.generation === artifact.id
        ? { ...sourceTarget, commit: artifact.commit, confidence: "exact" } : { ...sourceTarget, confidence: "unknown" };
    }, fetch: personalDevelopmentFetch
  });
  const workingContextOwner = { ownerId: serverId, generation: durableRuntimeGeneration() };
  modelWorkingContext = composeModelWorkingContext({
    store,
    providers,
    sessionHost,
    currentOwner: () => closed ? undefined : workingContextOwner
  });
  objectives = new ObjectiveManager({ store, sessionHost });
  let reconcileLearnedResourceRuntime: (backendId: string, resourceId: string, fence: symbol) => Promise<void> = async () => undefined;
  const skillLearning = new SkillLearningManager({
    store,
    sessions: sessionHost,
    resources: piResources,
    mutations: skillMutations,
    market: skillMarket,
    rootDirectory: join(config.dataDirectory, "skill-learning"),
    onResourceCommitted: (backendId, resourceId, fence) => reconcileLearnedResourceRuntime(backendId, resourceId, fence)
  });
  messaging = new MessagingManager({
    store,
    credentials,
    contextVault: credentialVault,
    sessionHost,
    artifacts,
    ...(dependencies.messagingTelegramApiBaseUrl === undefined
      ? {}
      : { telegramApiBaseUrl: dependencies.messagingTelegramApiBaseUrl }),
    ...(dependencies.messagingDiscordApiBaseUrl === undefined
      ? {}
      : { discordApiBaseUrl: dependencies.messagingDiscordApiBaseUrl }),
    ...(dependencies.messagingDingTalkApiBaseUrl === undefined
      ? {}
      : { dingTalkApiBaseUrl: dependencies.messagingDingTalkApiBaseUrl }),
    ...(dependencies.messagingDingTalkOapiBaseUrl === undefined
      ? {}
      : { dingTalkOapiBaseUrl: dependencies.messagingDingTalkOapiBaseUrl }),
    ...(dependencies.messagingCreateFeishuTransport === undefined
      ? {}
      : { createFeishuTransport: dependencies.messagingCreateFeishuTransport }),
    ...(dependencies.messagingCreateWeComTransport === undefined
      ? {}
      : { createWeComTransport: dependencies.messagingCreateWeComTransport }),
    ...(dependencies.messagingCreateWeChatTransport === undefined
      ? {}
      : { createWeChatTransport: dependencies.messagingCreateWeChatTransport }),
    ...(dependencies.messagingCreateSlackTransport === undefined
      ? {}
      : { createSlackTransport: dependencies.messagingCreateSlackTransport }),
    ...(dependencies.messagingPollTimeoutSeconds === undefined
      ? {}
      : { pollTimeoutSeconds: dependencies.messagingPollTimeoutSeconds }),
    ...(dependencies.messagingRetryDelayMs === undefined
      ? {}
      : { retryDelayMs: dependencies.messagingRetryDelayMs })
  });
  let partnerRoutines: PartnerRoutineManager | undefined;
  mcpApps = new McpAppsManager({ store, vault: credentialVault, config: id => mcpRouter.appServerConfig(id),
    redact: value => credentials.redactText(value),
    authorizeTool: (sessionId, serverId, toolName, args, signal) => sessionHost.authorizeMcpAppTool(sessionId, serverId, toolName, args, signal),
    sendMessage: (sessionId, serverId, content, guard) => sessionHost.enqueueMcpAppMessage(sessionId, serverId, content, guard),
    disposeDocument: viewId => mcpAppSurfaces?.remove(viewId) });
  mcpAppSurfaces = new McpAppSurfaces(mcpApps.host, config.publicOrigin);
  partnerGroupRuntime = new PartnerGroupSessionRuntime(partnerGroupStore, partnerStore, store, sessionHost, workspaces);
  let partnerImports: PartnerImportManager | undefined;
  const assertImportService = () => { if (closed) throw new Error("Import service is closed."); };
  let appDefaultModels: AppDefaultModelCoordinator | undefined;
  const partners = new PartnerManager({
    store: partnerStore,
    operationalStore: store,
    homeChanging: partnerId => partnerHomeStorage.changing(partnerId),
    remoteHomeModelAvailable: (targetId, route) => partnerHomeRuntime?.executionHome(targetId) !== undefined
      && route.backendId === piBackendId && partnerHomeInference?.available(route.backendId, route.providerId, route.modelId) === true,
    appDefaultModel: () => {
      const current = appDefaultModels?.current();
      if (!current || !sessionHost.appDefaultModelChoices().some(choice => choice.id === JSON.stringify([current.backendId, current.providerId, current.modelId]))) return undefined;
      return { backendId: current.backendId, providerId: current.providerId, modelId: current.modelId,
        ...(current.effort ? { effort: current.effort } : {}), fastMode: current.fastMode };
    },
    sessionHost,
    workspaceService: workspaces,
    homesRoot: join(config.dataDirectory, "partner-homes"),
    onReady: async partnerId => { await partnerImports?.activatePackage(partnerId); },
    onRoutineLifecycle: async (partnerId, state) => { await partnerRoutines?.lifecycle(partnerId, state); await partnerGroups?.partnerLifecycle(partnerId, state); await partnerMessaging?.lifecycle(partnerId, state); },
    prepareImportDeletion: async partnerId => { await partnerImports?.prepareDeletion(partnerId); await startupPartnerImportRuntime?.close();
      partnerMemoryPreferences.remove(partnerStore.getPartner(partnerId).homeTargetId);
      partnerConnectionPreferences.remove(partnerStore.getPartner(partnerId).homeTargetId); },
    pauseGoal: async (sessionId, operationId) => {
      const goal = store.findObjective(sessionId);
      if (goal !== undefined && (goal.status === "active" || goal.status === "dispatch_unknown")) {
        await objectives!.pause({ sessionId, operationId, expectedRevision: goal.revision,
          expectedOwnerGeneration: goal.ownerGeneration, reason: "Partner runtime restarted by user." });
      }
    },
    retireWorkbench: (partnerId, targetId) => partnerWorkbenches.retirePartner(partnerId, targetId),
    ownedIndependentSessions: (partnerId) => [...partnerSessionTasks?.ownedSessions(partnerId) ?? [], ...partnerGroupRuntime?.ownedSessions(partnerId) ?? [], ...partnerNetworkLanes?.ownedSessions(partnerId) ?? []],
    forgetIndependentTasks: (partnerId) => partnerSessionTasks?.forgetPartner(partnerId),
    resumeIndependentReturns: async (partnerId) => partnerSessionTasks?.refreshPartner(partnerId)
  });
  partnerMessaging = new PartnerMessagingRuntime({ store, profiles: partnerStore, partners, host: sessionHost, messaging,
    pauseGoal: async (sessionId, operationId) => {
      const goal = store.findObjective(sessionId);
      if (goal && (goal.status === 'active' || goal.status === 'dispatch_unknown')) await objectives!.pause({ sessionId, operationId,
        expectedRevision: goal.revision, expectedOwnerGeneration: goal.ownerGeneration, reason: 'Message lane restarted by user.' });
    } });
  messaging.setPartnerRuntime(partnerMessaging);
  sessionHost.setMessagingQueueGuard(item => partnerMessaging!.assertQueueCurrent(item), (item, request) => partnerMessaging!.reviewTool(item, request));
  const inputHandoffDisabled = (sessionId: string): boolean => {
    const session = store.getSession(sessionId).descriptor, link = partnerStore.getSessionLink(sessionId);
    const policy = toolPolicies.snapshot().find(value => value.toolProviderId === INPUT_HANDOFF_TOOL_PROVIDER_ID);
    if (policy && !(policy.targetSettings.find(value => value.targetId === session.targetId)?.effectiveEnabled ?? policy.userEffectiveEnabled)) return true;
    if (!link) return false;
    const partner = partnerStore.getPartner(link.partnerId), selection = partnerConnectionPreferences.read(partner.homeTargetId).toolsets;
    return partner.capabilities.inputHandoff === false || partner.lifecycle !== "active" || partner.pauseCleanupPending || partnerStore.isPartnerSessionPaused(sessionId)
      || selection.mode === "allowlist" && !selection.ids.includes(INPUT_HANDOFF_TOOL_PROVIDER_ID);
  };
  inputHandoffNotifications = new InputHandoffNotifications({ store, push: mobilePush,
    isCurrent: requestId => inputHandoff?.isCurrent(requestId) === true });
  inputHandoff = new InputHandoffCoordinator({ credentials, native: nativeInputHandoff!,
    publish: (sessionId, snapshot) => inputHandoffNotifications!.publish(sessionId, snapshot),
    notifyOwner: (sessionId, snapshot) => inputHandoffNotifications!.notify(sessionId, snapshot),
    isDisabledForSession: async sessionId => inputHandoffDisabled(sessionId),
    captureScope: identity => {
      const workspace = sessionHost.captureToolWorkspace(identity);
      const assertCurrent = () => {
        workspace.assertCurrent();
        if (workspace.remote || closed || store.findSessionRuntimePolicy(identity.sessionId)?.policy === "review_read_only"
          || store.findCollaborationWorkerBySession(identity.sessionId) || inputHandoffDisabled(identity.sessionId)) throw new Error("The original task cannot use input handoff.");
      };
      assertCurrent(); return { ...identity, assertCurrent };
    },
    continueAgent: async (scope, requestId, metadata) => { sessionHost.enqueueInputHandoffCompletion(scope, requestId, metadata); },
    liveViewAvailable: () => !!nativeInputHandoff?.currentDeviceId(),
    describeDevice: deviceId => {
      const device = store.getDevice(deviceId);
      return { name: device.name, platform: device.kind === "mobile" ? "mobile" : "desktop" };
    } });
  nativeInputHandoff!.setLiveHandoffPort(inputHandoff);
  await inputHandoff.initialize();
  const partnerWorkbenches = new PartnerWorkbenchManager({ partners, partnerStore, store, host: sessionHost, workspaces,
    workbenches: partnerWorkbenchStore, managedDataDirectory: config.dataDirectory,
    remoteProjects: partnerHomeProjects, homeTransit: partnerHomeWorkbench, homeChanging: partnerId => partnerHomeStorage.changing(partnerId),
    homeLocation: partnerId => partnerHomeRuntime ? partnerHomeStorage.current(partnerId, partnerHomeRuntime.local).location : undefined,
    briefs: new PartnerWorkbenchBriefReader(new CodeHostProjectProvider()), sessionTasks: () => partnerSessionTasks, routines: () => partnerRoutines,
    pullRequestProviders: (authorization) => composeCodeHostProviders(dependencies.codeHostProviders, authorization) });
  const partnerTaskGroupPublisher = new PartnerSessionTaskGroupPublisher(store, {
    capture: sessionId => partnerNetwork?.ownerTaskScope(sessionId), homeServerId: () => serverId, locale: () => persistedLocale(store),
    publish: async (origin, request, signal) => {
      signal.throwIfAborted();
      if (origin.joinId) return networkHome.publish(origin.joinId, request);
      if (origin.hostServerId !== serverId) throw new Error("The task result room authority changed.");
      return networkHost.publish(request, origin.ownerId);
    },
    media: async (origin, request, signal) => {
      const assertCurrent = () => { signal.throwIfAborted(); };
      if (origin.joinId) return networkHome.media(request, { deviceId: serverId, signal, assertCurrent });
      if (origin.hostServerId !== serverId) throw new Error("The task result room authority changed.");
      return networkHost.media(request, origin.ownerId, { signal, assertCurrent });
    },
    readArtifact: async blob => (await artifacts.readBlob(blob)).data
  });
  partnerSessionTasks = new PartnerSessionTaskManager(store, partners, sessionHost, workspaces, config.dataDirectory, Date.now, partnerHomeProjects, partnerTaskGroupPublisher);
  const partnerTaskOutputs = new PartnerTaskOutputProjection(store, partnerSessionTasks, partnerStore, workspaceCapture);
  const unregisterPartnerSessionTaskTools = mcpRouter.registerBridgeToolProvider(new PartnerSessionTaskTools(partnerSessionTasks));
  const collaborationGoals = new CollaborationGoalManager({
    store,
    sessionHost,
    assertWorkerAdmission: leadSessionId => extensionTasks.assertTeamWorkerCurrent(leadSessionId),
    readSettings: () => runtimeGovernance.collaboration()
  });
  const unregisterCollaborationGoalTools = mcpRouter.registerBridgeToolProvider(
    new CollaborationToolBridgeProvider({ store, manager: collaborationGoals })
  );
  const unregisterPartnerTools = mcpRouter.registerBridgeToolProvider(
    new PartnerToolBridgeProvider({ store, partners })
  );
  const unregisterPartnerWorkbenchTools = mcpRouter.registerBridgeToolProvider(new PartnerWorkbenchToolProvider({ store, partners, workbench: partnerWorkbenches }));
  partnerTodos = new PartnerTodoManager(store, partnerStore, partners);
  const unregisterPartnerTodoTools = mcpRouter.registerBridgeToolProvider(new PartnerTodoTools(partnerTodos));
  const unregisterPartnerMessagingTools = ['telegram', 'discord', 'dingtalk', 'feishu', 'lark', 'wecom', 'wechat', 'slack']
    .map(channel => mcpRouter.registerBridgeToolProvider(new PartnerMessagingTools(partnerMessaging!, channel)));
  let backendLifecycleTail: Promise<void> = Promise.resolve();
  const runBackendLifecycle = <T>(action: () => Promise<T>): Promise<T> => {
    const result = backendLifecycleTail.catch(() => undefined).then(action);
    backendLifecycleTail = result.then(() => undefined, () => undefined);
    return result;
  };
  let piReplacementRefreshRoute: {
    readonly target: Promise<PiBackendAdapter>;
    publishDescriptor: boolean;
  } | undefined;
  restartBackend = async (backendId: string, expectedGeneration?: number): Promise<void> => {
    await runBackendLifecycle(async () => {
      const previous = backendInstances.get(backendId);
      if (expectedGeneration !== undefined && previous.generation !== expectedGeneration) throw new Error("The Backend instance changed before runtime adoption.");
      const previousAdapter = backendInstances.adapter(backendId);
      let resolveReplacementTarget: ((target: PiBackendAdapter) => void) | undefined;
      let replacementTargetResolved = false;
      const replacementRoute = previousAdapter instanceof PiBackendAdapter
        ? {
            target: new Promise<PiBackendAdapter>((resolve) => { resolveReplacementTarget = resolve; }),
            publishDescriptor: false
          }
        : undefined;
      const resolveTarget = (target: PiBackendAdapter): void => {
        if (replacementTargetResolved) return;
        replacementTargetResolved = true;
        resolveReplacementTarget?.(target);
      };
      const refreshRetainedPi = async (replacementError: unknown): Promise<never> => {
        const retained = backendInstances.adapter(backendId);
        if (!(retained instanceof PiBackendAdapter)) throw replacementError;
        resolveTarget(retained);
        piReplacementRefreshRoute = {
          target: Promise.resolve(retained),
          publishDescriptor: true
        };
        const refresh = refreshPiGenerationImpl();
        // Refresh calls that arrive after this point must queue behind this
        // lifecycle action instead of joining the replacement scope.
        piReplacementRefreshRoute = undefined;
        try {
          await refresh;
        } catch (refreshError) {
          throw new AggregateError(
            [replacementError, refreshError],
            "Backend replacement failed and the retained Pi generation could not be refreshed."
          );
        }
        throw replacementError;
      };

      try {
        await sessionHost.replaceBackendInstance({
          backendId,
          expectedCurrentGeneration: previous.generation,
          perform: async (hooks) => {
            // Expose the replacement refresh route only after SessionHost has
            // admitted replacement. A pre-admission busy rejection must not
            // refresh or republish the retained Pi instance as a side effect.
            if (replacementRoute !== undefined) piReplacementRefreshRoute = replacementRoute;
            try {
              return await backendInstances.replace(backendId, {
                preparePrevious: async ({ candidateAdapter, candidateGeneration }) => {
                  if (replacementRoute !== undefined) {
                    if (!(candidateAdapter instanceof PiBackendAdapter)) {
                      throw new Error("Pi Backend replacement produced an invalid Adapter candidate.");
                    }
                    resolveTarget(candidateAdapter);
                  }
                  await hooks.preparePrevious(candidateAdapter, candidateGeneration);
                  // Closing an idle Pi runtime can persist a native credential
                  // refresh. Install the resulting catalog generation on the
                  // unpublished candidate before Registry publication.
                  if (replacementRoute !== undefined) await refreshPiGenerationImpl();
                },
                activateCurrent: () => {
                  // Registry durable publication has committed and no await
                  // separates this flag from the Host pointer switch. Any
                  // auth refresh triggered while active tasks are restored can
                  // now refresh the current durable descriptor as well.
                  if (replacementRoute !== undefined) replacementRoute.publishDescriptor = true;
                  hooks.activateCurrent();
                },
                onPreviousCleanupFailure: ({ instanceId, generation }) => {
                  store.appendDiagnostic({
                    severity: "warning",
                    component: "backend-instance",
                    code: "BACKEND_PREVIOUS_INSTANCE_CLEANUP_FAILED",
                    message: "A retired Backend instance could not be fully cleaned up after replacement.",
                    details: { backendId: instanceId, instanceGeneration: generation }
                  });
                }
              });
            } catch (error) {
              if (replacementRoute !== undefined) return await refreshRetainedPi(error);
              throw error;
            }
          }
        });
        if (replacementRoute !== undefined) {
          const current = backendInstances.adapter(backendId);
          if (!(current instanceof PiBackendAdapter)) {
            throw new Error("The replaced Pi Backend has no current Adapter.");
          }
          resolveTarget(current);
          // Publication and active-task restoration are complete. A later
          // refresh enters the normal lifecycle queue and therefore cannot
          // race the next replacement.
          piReplacementRefreshRoute = undefined;
        }
        // A persisted Partner delivery may have been waiting for this Backend.
        // Reconcile only after the replacement is published and admissions are
        // open again; stable operations make this replay idempotent.
        await partners.recoverPending();
      } catch (error) {
        if (replacementRoute !== undefined && piReplacementRefreshRoute !== undefined) {
          return await refreshRetainedPi(error);
        }
        throw error;
      } finally {
        if (replacementRoute !== undefined) {
          const retained = backendInstances.adapter(backendId);
          if (!replacementTargetResolved && retained instanceof PiBackendAdapter) resolveTarget(retained);
          piReplacementRefreshRoute = undefined;
        }
      }
    });
  };
  deferredBackendRestarts = new DeferredBackendRestartCoordinator({
    restart: restartBackend,
    canRestart: (backendId) => sessionHost.canReplaceBackendInstance(backendId),
    wakeQueues: (backendId) => sessionHost.wakeBackendQueues(backendId)
  });
  const ensureSubagentSmartRoutingReplacement = async (backendId: string): Promise<void> => {
    if (deferredBackendRestarts!.state(backendId).pending) {
      await deferredBackendRestarts!.apply(backendId);
    } else {
      await deferredBackendRestarts!.schedule(backendId);
    }
  };
  const applyDesiredSubagentSmartRouting = async (backendId: string): Promise<boolean> => {
    const adapter = backendInstances.adapter(backendId);
    if (!(adapter instanceof CodexBackendAdapter)) return false;
    const desired = subagentModels.smartRoutingEnabled(backendId);
    const current = adapter.subagentSmartRoutingState();
    let inspected;
    try {
      inspected = await adapter.inspectDesiredSubagentSmartRouting(desired);
    } catch {
      // A bounded catalog read can race profile or managed-catalog replacement.
      // Retain the durable desired revision behind the normal generation fence;
      // the coordinator retries instead of making the committed mutation look
      // unsuccessful to a client whose replay would skip this post-commit step.
      await ensureSubagentSmartRoutingReplacement(backendId);
      return true;
    }
    const expectedApplied = desired && inspected.unavailableReason === "" && inspected.candidateCount > 0;
    if (current.desired === desired
      && current.applied === expectedApplied
      && current.runtimeRevision === inspected.revision) {
      const deferred = deferredBackendRestarts!.state(backendId);
      if (!deferred.pending) return false;
      if (!deferred.applying) deferredBackendRestarts!.cancelIfWaiting(backendId);
      return true;
    }
    await ensureSubagentSmartRoutingReplacement(backendId);
    return true;
  };
  const refreshBackendDescriptor = async (backendId: string): Promise<void> => {
    if (await applyDesiredSubagentSmartRouting(backendId)) return;
    await runBackendLifecycle(async () => {
      await backendInstances.refresh(backendId);
    });
    // External account changes are first observed by Adapter.describe() during
    // the refresh above. Reinspect afterwards so a login/logout that changes
    // the native Sol/Terra catalog cannot leave the current smart generation
    // running with the catalog prepared for the previous account state.
    await applyDesiredSubagentSmartRouting(backendId);
  };
  const projectBackendProviderAuthentication = (
    backendId: string,
    providerId: string,
    authenticationState: BackendAuthenticationState
  ): void => {
    backendInstances.projectProviderAuthentication(backendId, providerId, authenticationState);
  };
  const refreshSubagentSmartRouting = async (backendId: string): Promise<void> => {
    try {
      const descriptor = store.getBackend(backendId).descriptor;
      if (descriptor.adapterKind !== "codex"
        || descriptor.capabilities.get("subagents.smart_routing")?.supported !== true) return;
      if (await applyDesiredSubagentSmartRouting(backendId)) return;
      if (backendInstances.adapter(backendId) instanceof CodexBackendAdapter) return;
      // The durable descriptor and process-local pointer should change as one
      // publication. If they do not, a fenced replacement is the recovery.
      await ensureSubagentSmartRoutingReplacement(backendId);
    } catch {
      // The setting mutation is already durable. Replacement failures are
      // normally retained by the coordinator; shutdown is the only expected
      // path that can reject scheduling itself.
      try {
        store.appendDiagnostic({
          severity: "warning",
          component: "backend-instance",
          code: "SUBAGENT_SMART_ROUTING_APPLICATION_DEFERRED",
          message: "The saved smart subagent routing change could not be scheduled before shutdown.",
          details: { backendId }
        });
      } catch { /* The Store may already be closed. */ }
    }
  };
  const historyMaintenance = startupHistoryMaintenance = new HistoryMaintenance({
    store,
    activeSessions: {
      prepare: (requests) => sessionHost.prepareHistoryMaintenanceBindings(requests),
      recover: (request) => sessionHost.recoverHistoryMaintenanceBinding(request),
      discard: (replacements) => sessionHost.discardHistoryMaintenanceBindings(replacements),
      finalize: (replacements) => sessionHost.finalizeHistoryMaintenanceBindings(replacements),
      release: (sessionIds) => sessionHost.releaseHistoryMaintenanceSessions(sessionIds)
    },
    externalRecords: workspaceChanges
  });
  sessionHostForPi = sessionHost;
  sessionHostForHelperTools = sessionHost;
  const reviewCoordinator = new ReviewCoordinator({
    store,
    runtime: sessionHost,
    evidence: new DurableReviewEvidenceProvider({ store, workspaces, workspaceChanges, artifacts }),
    locale: () => persistedLocale(store),
    onActivityTransition: runtimeActivity.markBlockingActivity
  });
  const scheduler = new ScheduleCoordinator(store, sessionHost, {
    onActivityTransition: runtimeActivity.markBlockingActivity
  });
  schedulerForBridgeTools = scheduler;
  partnerRoutines = new PartnerRoutineManager({ partners, store, scheduler,
    storage: new PartnerRoutineStore(join(config.dataDirectory, "partner-routines")) });
  const partnerAutonomy = new PartnerAutonomyManager({ store, profiles: partnerStore, partners, routines: partnerRoutines, tasks: partnerSessionTasks });
  startupPartnerAutonomy = partnerAutonomy;
  partnerRoutines.setFollowUpRuntime(partnerAutonomy);
  const extensionRoutineRuntime = new ExtensionRoutineRuntime({ catalog: extensionCatalog, resources: piResources, store,
    surfaces: extensionMainViews, engine: partnerRoutines.engine, ...(config.browser ? { executablePath: config.browser.executablePath } : {}) });
  startupRoutineRuntime = extensionRoutineRuntime;
  let extensionCardRuntime: ExtensionCardRuntime | undefined;
  const extensionDeviceSync = new ExtensionDeviceSync({ store, vault: credentialVault, peers: devicePeers, catalog: extensionCatalog, resources: piResources,
    deliver: async (...args) => extensionCardRuntime?.deliverDeviceSync(...args) ?? false });
  hostedAgents.installExtensionSync(extensionDeviceSync);
  let extensionOAuthCards: ExtensionOAuthCards | undefined;
  let extensionText: ExtensionText | undefined;
  const extensionTasks = new ExtensionTasks({ store, host: sessionHost, artifacts, catalog: extensionCatalog, projects: extensionProjects,
    defaults: { current: () => appDefaultModels?.current() }, rootDirectory: join(config.dataDirectory, "extension-tasks"), redact: value => credentials.redactText(value), teams: collaborationGoals,
    reviewNativeTool: createExtensionTaskNativeReviewer({ store, routes: modelRoutes, redact: value => credentials.redactText(value),
      adapters: () => backendInstances.snapshots().flatMap(instance => { const adapter = backendInstances.adapter(instance.instanceId); return adapter ? [adapter] : []; }) }) });
  const extensionTargets = new ExtensionTargets({ store, host: sessionHost, tasks: extensionTasks, catalog: extensionCatalog, projects: extensionProjects,
    partners, artifacts, redact: value => credentials.redactText(value) });
  sessionHost.setExtensionTaskQueueGuard(item => { if (!extensionTargets.assertQueueCurrent(item)) extensionTasks.assertQueueCurrent(item); });
  sessionHost.setExtensionNativeToolAuthorization(sessionId => partnerNetwork?.nativeToolAuthorization(sessionId) ?? extensionTasks.nativeToolAuthorization(sessionId));
  mcpRouter.setNativeToolAdmission((...args) => sessionHost.authorizeNativeBridgeTool(...args));
  piResources.setExtensionTaskRemoval((transaction, resourceId) => extensionTasks.uninstall(transaction, resourceId));
  const extensionCardMedia = new ExtensionCardMedia({ store, vault: credentialVault, artifacts, transfers: blobTransfers });
  const extensionCards = new ExtensionCardsManager({ store, vault: credentialVault,
    assertProject: (extensionId, sessionId) => extensionProjects.assertEnabledForSession(extensionId, sessionId),
    media: extensionCardMedia,
    oauthCards: () => extensionOAuthCards,
    authority: id => extensionCardRuntime?.authority(id), redact: value => credentials.redactText(value),
    previewMail: async (...args) => { if (!extensionCardRuntime) throw new Error("Mail runtime unavailable."); return extensionCardRuntime.previewMail(...args); },
    dispatch: async (scope, event, assertCurrent) => {
      if (!extensionCardRuntime) throw new Error("Extension card runtime unavailable.");
      await extensionCardRuntime.dispatch(scope, event, assertCurrent);
    } });
  startupExtensionCards = extensionCards;
  extensionOAuthCards = new ExtensionOAuthCards({ cards: extensionCards, settings: extensionOAuth, accounts: extensionOAuthAccounts, store, catalog: extensionCatalog,
    authority: id => extensionCardRuntime?.authority(id), locale: () => persistedLocale(store),
    continueTask: (scope, text, guard) => sessionHost.enqueueExtensionCardMessage(scope.sessionId, scope.extensionId, text, guard) });
  extensionCardRuntime = new ExtensionCardRuntime({ catalog: extensionCatalog, resources: piResources, store, projects: extensionProjects,
    deviceSync: extensionDeviceSync,
    vault: credentialVault, surfaces: extensionMainViews, cards: extensionCards, tasks: extensionTasks, targets: extensionTargets, text: { oneshot: (...args) => extensionText!.oneshot(...args) }, media: extensionCardMedia, oauthCards: extensionOAuthCards, workspaces, extraDirectories: sessionHost.extraDirectories, remoteFiles: (binding, signal) => remoteExecution.files(binding, signal), connections: extensionConnections, oauth: extensionOAuthAccounts,
    registerProvider: provider => mcpRouter.registerBridgeToolProvider(provider), redact: value => credentials.redactText(value),
    locale: () => persistedLocale(store),
    fetch: createOutboundStreamingFetch({ resolveProxy: dependencies.resolveOutboundProxy,
      environmentProxyForTarget: target => environmentProxyForTarget(target, process.env) }),
    resolveCredential: reference => credentials.resolve(reference),
    continueTask: (scope, text, guard) => sessionHost.enqueueExtensionCardMessage(scope.sessionId, scope.extensionId, text, guard),
    ...(config.browser ? { executablePath: config.browser.executablePath } : {}) });
  startupCardRuntime = extensionCardRuntime;
  const extensionDirectoryPicker = new ExtensionDirectoryPicker({ runtime: extensionCardRuntime,
    roots: () => workspaces.listRegistrations().filter(value => !value.remote).map(value => value.root) });
  const diagnosticsBundles = new DiagnosticsBundleService({
    store,
    artifacts,
    credentials,
    serviceVersion: "0.1.0"
  });
  const messageSearch = new MessageSearchEmbeddingCoordinator({ store, providers });
  messageSearchForHelperTools = messageSearch;
  const auxiliaryText = new AuxiliaryTextRouting({ store, routes: modelRoutes, providers });
  hostedAgentAutoReview = createHostedAgentAutoReviewer({ store, auxiliary: auxiliaryText, readPolicy: readHostedAgentPolicy,
    redact: value => credentials.redactText(value) });
  extensionText = new ExtensionText({ store, tasks: extensionTasks, catalog: extensionCatalog, routes: modelRoutes, auxiliary: auxiliaryText,
    adapters: () => backendInstances.snapshots().flatMap(instance => { const adapter = backendInstances.adapter(instance.instanceId); return adapter === undefined ? [] : [adapter]; }) });
  const helpAssistant = new HelpAssistant({ store, auxiliary: auxiliaryText,
    adapters: () => backendInstances.snapshots().flatMap(instance => { const adapter = backendInstances.adapter(instance.instanceId); return adapter === undefined ? [] : [adapter]; }) });
  const helpFeedback = new HelpFeedbackStore(join(config.dataDirectory, "help-feedback"));
  const agentImportSources = dependencies.agentImportSources ?? { home: userInfo().homedir, environment: { ...process.env } };
  partnerImports = new PartnerImportManager({ storage: partnerImportStorage, ...agentImportSources,
    currentCanonicalSession: partnerId => { try { const profile = partners.getPartner(partnerId); return profile.lifecycle === "deleted" ? undefined : profile.canonicalSessionId; } catch { return undefined; } },
    prepareCreation: (selection, native) => preparePartnerImportCreation(partners, selection, native),
    nativeRuntimeReady: id => { const profile = partners.getPartner(id); return profile.lifecycle === "active" && profile.initializationState === "ready" && !!profile.canonicalSessionId; },
    adoptSettings: (id, assertOwner) => adoptPartnerImportSettings(partners, store, partnerImportStorage, id, assertOwner),
    runPass: (id, action) => partners.runImportManagement(id, action),
    assertServiceOwner: assertImportService, effects: context => createPartnerImportEffects({ partners, routines: partnerRoutines!,
      storage: partnerImportStorage, store, memory: makerMemory, resources: piResources, artifacts,
      verification: partnerImportRuntime.verification, ...agentImportSources }, context),
    onSaved: async (result, nativePackage) => {
      if (!result.saved || !result.canonicalSessionId) return;
      if (nativePackage) {
        const welcomeEventId = `import-message-${createHash("sha256").update(JSON.stringify([result.canonicalSessionId, `package-welcome-${result.requestId}`])).digest("hex")}`;
        if (store.findEvent(welcomeEventId, { includeTombstoned: true })) return;
        if (result.checks.some(check => check.status === "needs-attention" && !check.entryId.startsWith("routine-") && check.message !== "MEMORY_DISABLED")) return;
        if (store.listEvents({ sessionId: result.canonicalSessionId, limit: 1_000 }).some(event => event.payload.type === "message_complete" && event.payload.role === "user")) return;
        const current = () => {
          try {
            assertImportService();
            const profile = partners.getPartner(result.partnerId);
            return profile.lifecycle === "active" && profile.canonicalSessionId === result.canonicalSessionId
              && !store.listEvents({ sessionId: result.canonicalSessionId!, limit: 1_000 }).some(event => event.payload.type === "message_complete" && event.payload.role === "user");
          } catch { return false; }
        };
        if (!current()) return;
        const opening = await partnerPackageOpening(nativePackage, auxiliaryText, current);
        if (!current()) return;
        sessionHost.appendImportMessage(result.canonicalSessionId, `package-welcome-${result.requestId}`,
          opening, () => { if (!current()) throw new Error("Partner opening owner changed."); });
        return;
      }
      sessionHost.appendImportMessage(result.canonicalSessionId, `import-saved-${result.requestId}`,
        "Imported content has been saved. You can review its saved, verified and active status here, retry missing items, and explicitly continue verification and schedule takeover.", assertImportService);
    } });
  const partnerImportRuntime = new PartnerImportRuntime({ partners, storage: partnerImportStorage, store, host: sessionHost,
    imports: partnerImports, auxiliary: auxiliaryText, routines: partnerRoutines, assertServiceOwner: assertImportService,
    groupHomeTarget: privateHomeTarget, isGroupSession: sessionId => partnerStore.getSessionLink(sessionId)?.role === "group" });
  startupPartnerImports = partnerImports; startupPartnerImportRuntime = partnerImportRuntime;
  const unregisterPartnerImportTools = mcpRouter.registerBridgeToolProvider(partnerImportRuntime);
  partnerRoutines.setImportedRuntime(partnerImportRuntime);
  partnerConnections = new PartnerConnectionsManager(partners, partnerStore, store, partnerConnectionPreferences, mcpRouter,
    (sessionId, targetId, id) => toolPolicies.enabledForSession(sessionId, targetId, id), piResources,
    (partnerId, signal, backendId) => partnerSkills!.referenceMetadata(partnerId, signal, backendId),
    privateHomeTarget);
  partnerSkills = new PartnerSkillsManager(partners, partnerStore, store, piResources, skillMutations,
    sessionId => sessionHost.requestServiceRuntimeRefresh(sessionId), privateHomeTarget);
  partnerHomeRuntime = new PartnerHomeRuntimeAdapter({ serverId, store, profiles: partnerStore, partners, host: sessionHost,
    workspaces, resources: piResources, homesRoot: join(config.dataDirectory, "partner-homes"), peers: devicePeers,
    files: new PartnerHomeFiles({ serverId, peers: devicePeers, remoteExecution }), storage: partnerHomeStorage,
    snapshots: new PartnerHomeSnapshots(join(config.dataDirectory, "partner-home-moves")), memoryPreferences: partnerMemoryPreferences,
    workbench: partnerHomeWorkbench,
    routines: partnerRoutines, artifacts, assertOwner: assertImportService,
    supportsRemoteCreation: backendId => backendId === piBackendId,
    hasRemoteModelRoute: (backendId, providerId, modelId) => partnerHomeInference?.available(backendId, providerId, modelId) === true,
    ownedSessions: partnerId => [...partnerSessionTasks?.ownedSessions(partnerId) ?? [], ...partnerGroupRuntime?.ownedSessions(partnerId) ?? [], ...partnerNetworkLanes?.ownedSessions(partnerId) ?? []],
    readProfileProjection: async (partnerId, assertCurrent) => {
      const profile = partnerStore.getPartner(partnerId), carried = store.findSetting<{ identity: string; user: string; instructions: string }>("target", profile.homeTargetId, "partner-home.profile")?.value;
      if (carried) return carried;
      const environment = await partnerImportStorage.environment.read(partnerId, assertCurrent); assertCurrent(); return environment?.profileProjection;
    },
    pauseGoal: async (sessionId, operationId) => {
      const goal = store.findObjective(sessionId);
      if (goal && (goal.status === "active" || goal.status === "dispatch_unknown")) await objectives!.pause({ sessionId, operationId,
        expectedRevision: goal.revision, expectedOwnerGeneration: goal.ownerGeneration, reason: "Partner is changing execution computer by user request." });
    }, retireWorkbench: (partnerId, targetId) => partnerWorkbenches.retirePartner(partnerId, targetId) });
  const partnerHomes = startupPartnerHomes = new PartnerHomeOwner(partnerHomeStorage, partnerHomeRuntime);
  partnerHomeInference = new PartnerHomeInference({ store, providers, router: mcpRouter,
    fetch: createOutboundFetch(dependencies.resolveOutboundProxy), isHome: targetId => partnerHomeRuntime!.executionHome(targetId) !== undefined });
  piResources.setPartnerHomeDataRoot(targetId => partnerHomeRuntime!.dataRoot(targetId));
  sessionHost.setPartnerHomeInputGuard(sessionId => { if (partnerHomeRuntime!.blocksInput(sessionId)) throw new Error("The Partner is changing its execution computer. Refresh its current home."); });
  partnerLearning = new PartnerLearningManager({ store, profiles: partnerStore, partners, memory: makerMemory,
    assertMessagingSource: item => partnerMessaging!.assertQueueCurrent(item),
    skills: partnerSkills, auxiliary: auxiliaryText });
  const unregisterPartnerSkillTools = mcpRouter.registerBridgeToolProvider(new PartnerSkillsToolProvider(partnerSkills));
  const unregisterPartnerCapabilityTools = mcpRouter.registerBridgeToolProvider(new PartnerCapabilityTools(partnerConnections,
    sessionId => sessionHost.requestServiceRuntimeRefresh(sessionId)));
  const partnerProfileTools = new PartnerProfileTools(partners, partnerSessionTasks, partnerConnections, partnerMemoryPreferences);
  const unregisterPartnerProfileTools = mcpRouter.registerBridgeToolProvider(partnerProfileTools);
  const unregisterPartnerRoutineTools = mcpRouter.registerBridgeToolProvider(new PartnerRoutineTools(
    partnerRoutines, partnerProfileTools, scheduleHookScripts, scheduleRunNotifications));
  appDefaultModels = new AppDefaultModelCoordinator(store, () => sessionHost.appDefaultModelChoices(), () => partners.followAppDefaultModel());
  const unregisterAppDefaultModelTools = mcpRouter.registerBridgeToolProvider(new AppDefaultModelTools(appDefaultModels, partnerProfileTools));
  const partnerWorkingStatus = new PartnerWorkingStatusManager({ store, partners, auxiliary: auxiliaryText });
  partnerGroupWorkspaces = new PartnerGroupWorkspaces(store, config.dataDirectory);
  await partnerGroupWorkspaces.initialize();
  partnerGroups = new PartnerGroupManager({ storage: partnerGroupStore, partners, runtime: partnerGroupRuntime,
    work: partnerGroupWorkspaces, attachments: new PartnerGroupAttachments(artifacts), changed: (groupId, change) => { partnerGroupStore.appendChange(groupId, change); },
    decidePlan: async (input, signal, stillCurrent) => {
      const plan = auxiliaryText.capture(), members = new Set(input.members.map(member => member.partnerId));
      const result = await auxiliaryText.run(plan, { system: PLAN_DECISION_SYSTEM_PROMPT, user: buildPlanDecisionPrompt(input), maxTokens: 800,
        timeoutMs: 20_000, ...(input.mode === "auto" ? { totalTimeoutMs: 8_000, firstAttemptTimeoutMs: 5_000 } : {}), signal, stillCurrent,
        validate: raw => parsePlanDecision(raw, input.mode, members) === null ? undefined : raw });
      return result.status === "ok" ? parsePlanDecision(result.text, input.mode, members) : null;
    },
    notifyStep: async (group, plan) => {
      if (partnerGroupStore.find(group.id)?.lifecycle !== "active" || !group.memberIds.length || group.memberIds.some(id => {
        try { const member = partners.getPartner(id); return member.lifecycle === "deleted" || member.lifecycle === "archived"; } catch { return true; }
      })) return;
      const step = plan.currentStep === null ? undefined : plan.steps[plan.currentStep];
      const lane = partnerGroupStore.lanes(group.id).find(item => item.planId === plan.id && item.partnerId === step?.partnerId);
      const sourceSessionId = lane?.sessionId ?? partners.getPartner(plan.organizerPartnerId).canonicalSessionId;
      if (!sourceSessionId) return;
      mobilePush.notifyGroupStep({ groupId: group.id, groupTitle: group.name, sourceSessionId,
        subjectSequence: BigInt(partnerGroupStore.latestChangeSequence()), kind: step?.status === "failed" ? "error" : plan.status === "done" ? "done" : "awaiting" });
    } });
  const networkLaneStore = new PartnerGroupStore(join(config.dataDirectory, "partner-network-lanes.db"));
  partnerNetworkLanes = new PartnerGroupSessionRuntime(networkLaneStore, partnerStore, store, sessionHost, workspaces);
  const networkPartner = (id: string) => {
    const profile = partners.getPartner(id);
    if (profile.lifecycle !== "active" || profile.initializationState !== "ready" || !profile.canonicalSessionId || partnerHomeStorage.changing(id)) throw new Error("This Partner is unavailable.");
    return { id: profile.id, name: profile.displayName, description: profile.description };
  };
  const networkHost = new PartnerNetworkHost({ storage: new PartnerNetworkStore(store), serverId, origin: advertisedOrigin,
    endpointPublicKey: linkspanIdentity.publicKey, mediaDirectory: join(config.dataDirectory, "partner-network-media"), partner: networkPartner, artifacts });
  const networkHome = new PartnerNetworkHome({ directory: join(config.dataDirectory, "credentials", "partner-network"), serverId,
    vault: credentialVault, partner: networkPartner, allowInsecureLan: config.allowInsecureLan });
  partnerNetwork = new PartnerNetworkRuntime({ host: networkHost, home: networkHome, profiles: partnerStore, store,
    laneStore: networkLaneStore, lanes: partnerNetworkLanes, routes: modelRoutes, adapters: () => backendInstances.availableAdapters(), artifacts,
    planWorkspaces: new PartnerNetworkPlanWorkspaces(store, networkLaneStore, partnerGroupWorkspaces),
    decidePlan: async (input, signal, stillCurrent) => {
      const plan = auxiliaryText.capture(), members = new Set(input.members.map(member => member.partnerId));
      const result = await auxiliaryText.run(plan, { system: PLAN_DECISION_SYSTEM_PROMPT, user: buildPlanDecisionPrompt(input), maxTokens: 800,
        timeoutMs: 20_000, ...(input.mode === "auto" ? { totalTimeoutMs: 8_000, firstAttemptTimeoutMs: 5_000 } : {}), signal, stillCurrent,
        validate: raw => parsePlanDecision(raw, input.mode, members) === null ? undefined : raw });
      return result.status === "ok" ? parsePlanDecision(result.text, input.mode, members) : null;
    } });
  const partnerIdentity = new PartnerIdentityDirectory({ store, serverId, origin: advertisedOrigin, endpointPublicKey: linkspanIdentity.publicKey, vault: credentialVault, home: taskSharingHome,
    partner: id => {
      const profile = partners.getPartner(id);
      if (profile.lifecycle !== "active" || profile.initializationState !== "ready" || !profile.canonicalSessionId || partnerHomeStorage.changing(id)) throw new Error("This Partner is unavailable.");
      partners.canonicalCaller(profile.canonicalSessionId);
      return { id: profile.id, name: profile.displayName, description: profile.description, canonicalSessionId: profile.canonicalSessionId, revision: profile.revision };
    } });
  const promptPrediction = new PromptPredictionService({ store, auxiliary: auxiliaryText });
  const sessionNavigation = new SessionNavigationCoordinator({ store, auxiliary: auxiliaryText, credentials });
  let browser: BrowserProvider | undefined;
  let browserTransfers: BrowserTransferCoordinator | undefined;
  let browserSettings: BrowserSettingsController | undefined;
  let browserAutomationNode: BrowserAutomationNodeExecutor | undefined;
  let unregisterBrowserBridge: (() => void) | undefined;
  let computerAutomation: ComputerAutomationSettingsController | undefined;
  let computerBridge: ComputerToolBridgeProvider | undefined;
  let unregisterComputerBridge: (() => void) | undefined;
  const computerRuntime = new ComputerRuntime({
    executablePath: process.env["JOKO_COMPUTER_DRIVER_EXECUTABLE"],
    resolveOutboundProxy: dependencies.resolveOutboundProxy
  });
  const computerTools = new ComputerToolProvider({ runtime: computerRuntime });
  let androidAutomation: AndroidAutomationSettingsController | undefined;
  let androidBridge: AndroidToolBridgeProvider | undefined;
  let unregisterAndroidBridge: (() => void) | undefined;
  const androidPreparer = managedAndroidAdbPreparationSupported(process.platform, process.arch)
    ? new ManagedAndroidAdbPreparer({
        dataDirectory: config.dataDirectory,
        platform: process.platform,
        architecture: process.arch
      })
    : undefined;
  const androidRuntime = new AndroidRuntimeSupervisor({
    factory: new AndroidAutomationRuntimeFactory({
      artifactRoots: [config.workspace.root, config.artifactDirectory],
      bundledExecutablePaths: androidBundledExecutablePaths(),
      ...(androidPreparer === undefined ? {} : {
        preparedExecutablePath: androidPreparer.preparedExecutablePath(),
        preparer: androidPreparer
      })
    })
  });
  androidRuntimeForSessionCleanup = androidRuntime;
  const browserActivity = browserState.activities;
  let maintenanceTimer: NodeJS.Timeout | undefined;
  let maintenanceTail: Promise<void> = Promise.resolve();
  let closePromise: Promise<void> | undefined;
  const serviceCleanups = new Set<() => void>();
  let refreshTail: Promise<void> = Promise.resolve();
  const refreshPiAdapterGeneration = async (
    pi: PiBackendAdapter,
    publishDescriptor: boolean
  ): Promise<void> => {
    if (closed) return;
    const nextSettings = effectivePiSettings(
      baseSettings,
      store.findSetting<unknown>("service", "orchestrator", `settings.pi.${pi.id}`)?.value
    );
    const nextSilentEncryptedRetryEnabled = configuredSilentEncryptedRetry(store);
    const [nextProviderSnapshot, nextResourceSnapshot] = await Promise.all([
      providers.createPiGenerationSnapshot({
        snapshotsRoot: generationSnapshotRoot(config, store.health().revision, nextSettings, piGenerationSequence++),
        settings: nextSettings,
        providerEnabled: (providerId) => providerRoutingEnabled(store, pi.id, providerId),
        modelEnabled: (providerId, modelId) => modelRoutingEnabled(store, pi.id, providerId, modelId)
      }),
      piResources.runtimeSnapshot(pi.id)
    ]);
    const availableNativeProviderIds = availableManagedProviderIds(
      providers.list(pi.id),
      (providerId) => providerRoutingEnabled(store, pi.id, providerId)
    );
    const nextBridgeGeneration = createTargetAwarePiBridgeGeneration(
      mcpRouter,
      bridgeEndpoint,
      {
        endpoint: new URL("/internal/pi-native-auth", bridgeEndpoint).toString(),
        catalogGeneration: nextProviderSnapshot.catalogGeneration,
        providerIds: nextProviderSnapshot.nativeAuthProviderIds,
        authenticatedProviderIds: nextProviderSnapshot.nativeAuthenticatedProviderIds
      },
      (context, policyId) => toolPolicies.enabledForSession(context.sessionId, context.target.id, policyId),
      (retryInMs) => store.appendDiagnostic({
        severity: "warning",
        component: "mcp",
        code: "MCP_BRIDGE_RENEWAL_FAILED",
        message: "A live managed MCP bridge grant could not be renewed.",
        details: { retryInMs }
      })
    );
    let installed = false;
    try {
      await pi.updateManagedGeneration({
        agentHome: nextProviderSnapshot.agentHome,
        providers: nextProviderSnapshot.providers,
        nativeModels: providerAuth.listNativeModels().filter((model) =>
          availableNativeProviderIds.has(model.providerId)
          && modelRoutingEnabled(store, pi.id, model.providerId, model.modelId)),
        settings: nextSettings,
        silentEncryptedRetryEnabled: nextSilentEncryptedRetryEnabled,
        environment: nextProviderSnapshot.environment,
        secretEnvironmentNames: nextProviderSnapshot.secretEnvironmentNames,
        catalogGeneration: nextProviderSnapshot.catalogGeneration,
        nativeAuthProviderIds: nextProviderSnapshot.nativeAuthProviderIds,
        nativeAuthenticatedProviderIds: nextProviderSnapshot.nativeAuthenticatedProviderIds,
        loadNativeAuth: (input) => providerAuth.loadNativeAuth(input),
        persistNativeAuth: (input) => providerAuth.persistNativeAuth(input),
        managedResources: nextResourceSnapshot,
        mcpBridge: nextBridgeGeneration.baseSnapshot,
        resolveMcpBridge: nextBridgeGeneration.resolve,
        releaseManagedGeneration: () => {
          nextBridgeGeneration.release();
          scheduleGenerationGc(nextProviderSnapshot.agentHome);
        }
      });
      installed = true;
      if (publishDescriptor) {
        if (backendInstances.adapter(pi.id) !== pi) {
          throw new Error("Pi Backend descriptor refresh lost its current-instance fence.");
        }
        await backendInstances.refresh(pi.id);
      }
      await generationGcTail;
    } catch (error) {
      if (!installed) {
        nextBridgeGeneration.release();
        scheduleGenerationGc(nextProviderSnapshot.agentHome);
        await generationGcTail;
      }
      throw error;
    }
  };
  const enqueuePiGenerationRefresh = (action: () => Promise<void>): Promise<void> => {
    const refresh = refreshTail.catch(() => undefined).then(action);
    refreshTail = refresh;
    return refresh;
  };
  const refreshPiGeneration = (): Promise<void> => {
    if (closed) return Promise.resolve();
    const replacementRoute = piReplacementRefreshRoute;
    if (replacementRoute !== undefined) {
      return enqueuePiGenerationRefresh(async () => {
        if (closed) return;
        await refreshPiAdapterGeneration(
          await replacementRoute.target,
          replacementRoute.publishDescriptor
        );
      });
    }
    // Enter the Backend lifecycle queue at invocation time. This preserves
    // call order with a replacement that begins in the same event-loop turn.
    return runBackendLifecycle(() => enqueuePiGenerationRefresh(async () => {
      if (closed) return;
      const current = backendInstances.adapter(piBackendId);
      // Saved settings also apply to the next repair/replacement. There is no
      // active Pi generation to refresh while this instance is unavailable.
      if (current === undefined) return;
      await refreshPiAdapterGeneration(current as ReturnType<typeof createPiAdapter>, true);
    }));
  };
  refreshPiGenerationImpl = refreshPiGeneration;
  reconcileLearnedResourceRuntime = async (backendId, resourceId, fence) => {
    try {
      const backend = store.getBackend(backendId).descriptor;
      const retainsPreviousSnapshot = backendId === piBackendId || backend.adapterKind === "pi";
      if (retainsPreviousSnapshot) await refreshPiGeneration();
      else await restartBackend(backendId);
      sessionHost.completeBackendResourceCatalogRefresh(backendId, fence, retainsPreviousSnapshot);
    } catch {
      store.appendDiagnostic({
        severity: "warning",
        component: "resource-runtime",
        code: "LEARNED_SKILL_RUNTIME_REFRESH_FAILED",
        message: "A learned Skill was saved, but its Backend runtime has not refreshed yet.",
        details: { backendId, resourceId }
      });
    }
  };
  reconcileSkillMarketResourceRuntime = async ({ resourceId, backendId }) => {
    const resourceCatalogFence = sessionHost.fenceBackendResourceCatalogs(backendId);
    try {
      const backend = store.getBackend(backendId).descriptor;
      const activeRuntimesRetainPreviousSnapshot = backendId === piBackendId || backend.adapterKind === "pi";
      if (activeRuntimesRetainPreviousSnapshot) await refreshPiGeneration();
      else await restartBackend(backendId);
      sessionHost.completeBackendResourceCatalogRefresh(
        backendId,
        resourceCatalogFence,
        activeRuntimesRetainPreviousSnapshot
      );
    } catch {
      try {
        store.appendDiagnostic({
          severity: "warning",
          component: "resource-runtime",
          code: "SKILL_MARKET_SYNC_RUNTIME_REFRESH_FAILED",
          message: "A synchronized Skill Resource was saved, but its Backend runtime has not refreshed yet.",
          details: { backendId, resourceId }
        });
      } catch {
        // Store shutdown cannot invalidate an already committed synchronization result.
      }
    }
  };
  if (imageGenerationBridge.available) {
    try {
      await refreshPiGeneration();
    } catch {
      store.appendDiagnostic({
        severity: "warning",
        component: "image-generation",
        code: "IMAGE_GENERATION_TOOL_REFRESH_FAILED",
        message: "The configured image generation tool could not be added to the current Pi generation.",
        details: {}
      });
    }
  }

  const managedModelRuntimeSystem = await createManagedModelRuntimeSystem({
    store,
    providers,
    dataDirectory: config.dataDirectory,
    ownerId: serverId,
    ownerGeneration: durableRuntimeGeneration(),
    onModelsChanged: refreshPiGeneration,
    onProviderChanged: async backendIds => {
      for (const backendId of backendIds) {
        if (backendId === providers.nativeAuthenticationBackendId) await refreshPiGeneration();
        else await refreshBackendDescriptor(backendId);
      }
    },
    fetchStreaming: createOutboundStreamingFetch({ resolveProxy: dependencies.resolveOutboundProxy,
      environmentProxyForTarget: target => environmentProxyForTarget(target, process.env) })
  });
  managedModelRuntimeForSession = managedModelRuntimeSystem;

  const runMaintenance = (): Promise<void> => {
    const maintenance = maintenanceTail.catch(() => undefined).then(async () => {
      if (closed) return;
      const now = Date.now();
      store.expireToolLeases(now);
      store.prunePairings({
        expiredBefore: now,
        expiredCreatedBefore: now - 60_000,
        consumedBefore: now - 24 * 60 * 60_000
      });
      await sessionHost.reapIdleRuntimes();
      await artifacts.garbageCollect();
    });
    maintenanceTail = maintenance;
    return maintenance;
  };
  const armMaintenance = (): void => {
    maintenanceTimer = setInterval(() => {
      void runMaintenance().catch(() => {
        if (closed) return;
        store.appendDiagnostic({
          severity: "warning",
          component: "maintenance",
          code: "MAINTENANCE_PASS_FAILED",
          message: "A bounded Orchestrator maintenance pass could not be completed.",
          details: {}
        });
      });
    }, 15 * 60_000);
    maintenanceTimer.unref();
  };

  try {
    const backendTargets: readonly {
      readonly backendId: string;
      readonly targetId: string;
      readonly displayName: string;
    }[] = [
      { backendId: piBackendId, targetId: config.workspace.id, displayName: config.workspace.displayName },
      { backendId: codexBackendId, targetId: `${config.workspace.id}:codex`, displayName: `${config.workspace.displayName} · Codex` },
      { backendId: claudeCodeBackendId, targetId: `${config.workspace.id}:claude-code`, displayName: `${config.workspace.displayName} · Claude Code` }
    ];
    const storedTargets = new Map(store.listTargets().map((target) => [target.descriptor.id, target]));
    // Validate configured identities before restoring workspaces or activating stored Sessions.
    for (const registration of backendTargets) {
      const storedTarget = storedTargets.get(registration.targetId);
      if (storedTarget === undefined) continue;
      const metadata = isRecord(storedTarget.metadata) ? storedTarget.metadata : {};
      if (storedTarget.descriptor.backendId !== registration.backendId
        || resolve(storedTarget.descriptor.workspaceRoot) !== resolve(config.workspace.root)
        || metadata["workspaceId"] !== config.workspace.id) {
        throw new Error("The configured workspace does not match its persisted Target. Choose a distinct workspace identity for a different root or Backend.");
      }
    }
    const configuredTarget = storedTargets.get(config.workspace.id);
    const configuredBinding = configuredTarget?.descriptor.remoteWorkspace;
    await workspaces.register(configuredTarget === undefined ? config.workspace : {
      id: config.workspace.id,
      root: configuredBinding?.workspaceRoot ?? configuredTarget.descriptor.workspaceRoot,
      displayName: configuredTarget.descriptor.displayName,
      trusted: configuredTarget.descriptor.trusted,
      ...(configuredBinding === undefined ? {} : {
        remote: { targetId: configuredTarget.descriptor.id, binding: configuredBinding }
      })
    });
    for (const storedTarget of store.listTargets()) {
      const metadata = isRecord(storedTarget.metadata) ? storedTarget.metadata : {};
      const workspaceId = typeof metadata["workspaceId"] === "string" ? metadata["workspaceId"] : undefined;
      if (workspaceId === undefined || workspaceId === config.workspace.id || metadata["deletedAt"] !== undefined) continue;
      try {
        const binding = storedTarget.descriptor.remoteWorkspace;
        await workspaces.register({
          id: workspaceId,
          root: binding?.workspaceRoot ?? storedTarget.descriptor.workspaceRoot,
          displayName: storedTarget.descriptor.displayName,
          trusted: storedTarget.descriptor.trusted,
          ...(binding === undefined ? {} : {
            remote: { targetId: storedTarget.descriptor.id, binding }
          })
        });
      } catch {
        store.appendDiagnostic({
          id: `workspace-restore-${storedTarget.descriptor.id}-${Date.now()}`,
          severity: "warning",
          component: "workspace",
          code: "WORKSPACE_RESTORE_UNAVAILABLE",
          message: "A persisted workspace could not be safely registered during startup.",
          details: { targetId: storedTarget.descriptor.id, workspaceId }
        });
      }
    }
    await reviewCoordinator.reconcileStartup();
    await sessionWorktrees.initialize();
    await managedChildWorkspaces.initialize().catch(() => {
      store.appendDiagnostic({ severity: "warning", component: "child-workspace", code: "MANAGED_CHILD_WORKSPACE_UNAVAILABLE",
        message: "Native child workspace isolation is unavailable; its existing leases remain retained.", details: {} });
    });
    await partnerWorkbenches.initialize();
    await sessionHost.initialize();
    await taskSharingHome.initialize();
    await personalDevelopmentCoordinator.initialize();
    personalDevelopmentDoctor.initialize();
    personalDevelopmentCoordinator.setDoctorReports(personalDevelopmentDoctor);
    stopPersonalDevelopmentNotifications = personalDevelopmentNativeBroker.subscribe(() => {
      personalDevelopmentCoordinator!.notifyAvailability();
      if (personalDevelopmentNativeBroker!.metadata() !== undefined) void personalDevelopment!.refreshVersions().catch(() => undefined);
    });
    await sessionWorktrees.startRecycleMaintenance(createWorktreeRecycleSafetyCheck({ store, sessionHost, terminals }));
    await partnerGroups.start();
    await networkHome.initialize();
    await partnerNetwork.start();
    await partnerSessionTasks.initialize();
    await historyMaintenance.initialize();
    await skillLearning.initialize();
    for (const registration of backendTargets) {
      if (backendInstances.adapter(registration.backendId) === undefined) continue;
      const target: TargetDescriptor = {
        id: registration.targetId,
        backendId: registration.backendId,
        displayName: registration.displayName,
        workspaceRoot: config.workspace.root,
        // JOKO_WORKSPACE_ROOT is an owner-selected project. Only workspaces
        // created under the dedicated managed-workspaces root may ever be
        // advertised as managed (and therefore eligible for recoverable trash).
        managed: false,
        trusted: config.workspace.trusted
      };
      const storedTarget = storedTargets.get(registration.targetId);
      if (storedTarget !== undefined) {
        const metadata = isRecord(storedTarget.metadata) ? storedTarget.metadata : {};
        if (metadata["deletedAt"] !== undefined) continue;
        await sessionHost.registerTarget(storedTarget.descriptor, storedTarget.metadata);
      } else {
        await sessionHost.registerTarget(target, { workspaceId: config.workspace.id });
      }
    }
    await objectives.initialize();
    await messaging.initialize();
    await collaborationGoals.initialize();
    await partners.recoverPending();

    const computerRuntimeAdapter = computerAutomationRuntime(computerRuntime);
    computerAutomation = new ComputerAutomationSettingsController({
      store,
      runtime: computerRuntimeAdapter,
      refreshGeneration: async () => {
        if (computerAutomation?.availableForNewSessions() === true) await computerBridge?.prepare();
        await refreshPiGeneration();
      }
    });
    computerBridge = new ComputerToolBridgeProvider({
      provider: computerTools,
      store,
      enabledForNewSessions: () => computerAutomation?.availableForNewSessions() ?? false
    });
    computerBridgeForSessionCleanup = computerBridge;
    unregisterComputerBridge = mcpRouter.registerBridgeToolProvider(computerBridge);
    await computerAutomation.probe(false);
    if (computerAutomation.enabled()) {
      if (computerAutomation.availableForNewSessions()) {
        await computerBridge.prepare();
        await refreshPiGeneration();
      }
    }

    androidAutomation = new AndroidAutomationSettingsController({
      store,
      runtime: androidRuntime,
      refreshGeneration: refreshPiGeneration
    });
    androidBridge = new AndroidToolBridgeProvider({
      provider: () => androidRuntime.provider(),
      store,
      artifacts,
      redactXml: (value) => credentials.redactText(value),
      enabledForNewSessions: () => androidAutomation?.availableForNewSessions() ?? false
    });
    unregisterAndroidBridge = mcpRouter.registerBridgeToolProvider(androidBridge);
    if (androidAutomation.enabled()) {
      await androidAutomation.prepare();
      await refreshPiGeneration();
    }

    if (config.browser !== undefined) {
      const configuredBrowser = new BrowserProvider({
        initialGeneration: browserState.lastBrowserGeneration("browser"),
        executablePath: config.browser.executablePath,
        profileDirectories: {
          sidebar: join(config.dataDirectory, "browser", "profiles", "sidebar"),
          external: join(config.dataDirectory, "browser", "profiles", "external")
        },
        profileDisplayName: () => browserSettings?.profileDisplayName() ?? "Joko",
        targetMode: config.browser.headless ? "sidebar" : "external",
        downloadDirectory: join(config.dataDirectory, "browser", "downloads"),
        uploadRoots: [config.workspace.root, config.artifactDirectory],
        canUpload: () => browserSettings?.uploadAllowed() ?? false,
        canDownload: () => browserSettings?.downloadAllowed() ?? false,
        onActivity: (activity: BrowserActivity) => {
          browserState.recordActivity(activity);
        }
      });
      browser = configuredBrowser;
      const configuredTransfers = new BrowserTransferCoordinator({
        artifacts,
        provider: configuredBrowser,
        browserProviderId: "browser",
        repository: browserState,
        onActivityTransition: runtimeActivity.markBlockingActivity
      });
      browserTransfers = configuredTransfers;
      const configuredSettings = new BrowserSettingsController({
        store,
        defaults: {
          browserProviderId: "browser",
          enabled: true,
          profileDisplayName: "Joko",
          takeoverTimeoutMs: 15 * 60_000,
          allowUploads: true,
          allowDownloads: true,
          automationTarget: config.browser.headless ? "sidebar" : "external"
        },
        detectedBrowser: browserDisplayName(config.browser.executablePath),
        hooks: {
          start: async () => {
            // Enabling Browser access publishes the Tool for new Sessions but
            // keeps the dedicated browser lazy. It opens only for an explicit
            // user action or Browser Tool start request.
            await refreshPiGeneration();
            browserSettings?.setBackendHealth(configuredBrowser.running
              ? { active: true, status: "ready", canRecover: true }
              : { active: false, status: "disconnected", canRecover: true });
          },
          stop: async () => {
            // Disabling only omits Browser tools from new Pi generations.
            // Existing Sessions retain their frozen bridge grant and Provider.
            await refreshPiGeneration();
          },
          // Profile labels and transfer policy are read live. Placement owns a
          // separate persistent profile and therefore requires a fenced
          // Browser generation transition.
          refresh: async ({ previous, next, assertCurrent }) => {
            if (previous.automationTarget === next.automationTarget) return;
            assertCurrent?.();
            browserSettings?.setBackendHealth({ active: false, status: "recovering", canRecover: false });
            const wasRunning = configuredBrowser.running;
            const previousLaunch = configuredBrowser.captureStartOptions();
            const rollback = async () => {
              configuredTransfers.fenceBeforeGeneration(configuredBrowser.generation + 1);
              await configuredBrowser.stop();
              await configuredBrowser.setTargetMode(previous.automationTarget);
              if (wasRunning) await configuredBrowser.start(previousLaunch);
              browserSettings?.setBackendHealth({ active: configuredBrowser.running,
                status: configuredBrowser.running ? "ready" : "disconnected", canRecover: true });
            };
            try {
              configuredTransfers.fenceBeforeGeneration(configuredBrowser.generation + 1);
              await configuredBrowser.stop();
              assertCurrent?.();
              await configuredBrowser.setTargetMode(next.automationTarget);
              assertCurrent?.();
              if (wasRunning) {
                await configuredBrowser.start({ ...(assertCurrent === undefined ? {} : { assertCurrent }) });
                await refreshPiGeneration();
              }
              assertCurrent?.();
              browserSettings?.setBackendHealth({ active: configuredBrowser.running,
                status: configuredBrowser.running ? "ready" : "disconnected", canRecover: true });
              return rollback;
            } catch (error) {
              await rollback().catch(() => undefined);
              browserSettings?.setBackendHealth({
                active: configuredBrowser.running,
                status: "error",
                canRecover: true,
                reason: "recoveryFailed"
              });
              throw error;
            }
          }
        }
      });
      browserSettings = configuredSettings;
      if (configuredBrowser.targetMode !== configuredSettings.automationTarget()) {
        await configuredBrowser.setTargetMode(configuredSettings.automationTarget());
      }
      configuredBrowser.setDownloadHandler(async (pageId, verifiedLocalPath, sanitizedFileName) => {
        if (!configuredSettings.downloadAllowed()) {
          throw new Error("Browser downloads are disabled by the active host policy.");
        }
        await configuredTransfers.onDownload(pageId, verifiedLocalPath, sanitizedFileName);
      });
      const browserNodeGeneration = durableRuntimeGeneration();
      const browserNodeRouter = new AuthenticatedBrowserRemoteNodeRouter({
        localNodeId: serverId,
        localGeneration: browserNodeGeneration,
        discovery: lanDiscovery,
        credentials,
        artifacts
      });
      const userKnowledge = new BrowserUserKnowledgeStore(store);
      const browserBridge = new BrowserToolBridgeProvider({
        browser: configuredBrowser,
        transfers: configuredTransfers,
        artifacts,
        state: browserState,
        enabledForNewSessions: (targetId) => configuredSettings.enabled(targetId),
        remoteNodes: browserNodeRouter,
        userKnowledge,
        setBackend: async (mode, assertCurrent) => {
          const selected = await configuredSettings.setAutomationTarget(mode, assertCurrent);
          assertCurrent();
          if (configuredBrowser.targetMode !== selected) throw new Error("The persisted Browser mode could not be confirmed by its runtime owner.");
          return selected;
        }
      });
      browserAutomationNode = new BrowserAutomationNodeExecutor({
        nodeId: serverId,
        displayName: "Orchestrator browser",
        generation: browserNodeGeneration,
        bridge: browserBridge,
        artifacts
      });
      browserNodeRouter.attachLocal(browserAutomationNode);
      unregisterBrowserBridge = mcpRouter.registerBridgeToolProvider(browserBridge);
      configuredSettings.setBackendHealth({ active: false, status: "disconnected", canRecover: true });
      if (configuredSettings.anyTargetEnabled()) {
        await refreshPiGeneration().catch(() => {
          store.appendDiagnostic({
            severity: "warning",
            component: "browser",
            code: "BROWSER_TOOL_BRIDGE_REFRESH_FAILED",
            message: "The Browser Provider was registered, but its Pi Tool bridge could not be installed.",
            details: {}
          });
        });
      }
    }
    skillMarketSync.beginPending();
    messageSearch.start();
    sessionNavigation.start();
    partnerWorkingStatus.start();
    mobilePush.start();
    scheduler.start();
    await partnerRoutines.start();
    await partnerAutonomy.start();
    await partnerHomes.recover();
    await partnerImports.recover();
    await extensionRoutineRuntime.start();
    await extensionCardRuntime.start();
    armMaintenance();
    void runMaintenance().catch(() => {
      store.appendDiagnostic({
        severity: "warning",
        component: "maintenance",
        code: "STARTUP_MAINTENANCE_FAILED",
        message: "Orchestrator startup maintenance could not be completed.",
        details: {}
      });
    });
  } catch (error) {
    startupCleanupHandled = true;
    const cleanupErrors: unknown[] = [];
    const attempt = async (cleanup: () => unknown): Promise<void> => {
      try { await cleanup(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    };
    closed = true;
    await attempt(closePersonalDevelopment);
    await attempt(() => taskSharingHome.dispose());
    await attempt(() => partnerImports?.close());
    await attempt(() => partnerHomes.close());
    await attempt(() => partnerImportRuntime.close());
    await attempt(() => deferredBackendRestarts?.dispose());
    await attempt(() => commandConcurrencyGate.close());
    await attempt(() => stopExtensionLibraryAuthorityNotifications());
    await attempt(() => skillMarketSync.close());
    await attempt(() => skillPublication.close());
    await attempt(() => skills.close());
    await attempt(() => skillMarket.close());
    await attempt(() => extensionCardRuntime?.stop());
    await attempt(() => extensionCards.dispose());
    await attempt(() => extensionOAuth.dispose());
    await attempt(() => extensionOAuthAccounts.dispose());
    await attempt(() => extensionNetwork.dispose());
    await attempt(() => extensionRoutineRuntime.stop());
    await attempt(() => extensionLibraries.close());
    await attempt(() => extensionMainViews.close());
    await attempt(() => extensionPackagePublisher.close());
    await attempt(() => partnerAutonomy.stop());
    await attempt(() => partnerRoutines?.stop());
    await attempt(() => scheduler.stop());
    await attempt(() => mobilePush.close());
    await attempt(() => providerAuth.beginShutdown());
    await attempt(() => providerAccountUsage.invalidate());
    await attempt(() => managedModelRuntimeSystem.close());
    await attempt(() => objectives?.close());
    await attempt(() => collaborationGoals.close());
    await attempt(() => messaging.close());
    await attempt(() => refreshTail);
    await attempt(() => backendLifecycleTail);
    await attempt(async () => { cleanupErrors.push(...await cleanupStartupBackendOwners()); });
    await attempt(() => sessionWorktrees.dispose());
    await attempt(() => generationGcTail);
    await attempt(() => providerAuth.close());
    await attempt(() => browserSettings?.setBackendHealth({
      active: false,
      status: "unavailable",
      canRecover: false,
      reason: "disposing"
    }));
    await attempt(() => browser?.stop());
    await attempt(() => computerBridge?.close());
    await attempt(() => computerRuntime.dispose());
    await attempt(() => androidRuntime.dispose());
    await attempt(() => lanDiscovery.stop());
    await attempt(() => unregisterBrowserBridge?.());
    await attempt(() => unregisterComputerBridge?.());
    await attempt(() => unregisterAndroidBridge?.());
    await attempt(() => unregisterImageGenerationBridge());
    await attempt(() => unregisterSessionHelperTools());
    await attempt(() => unregisterContactTools());
    await attempt(() => unregisterCollaborationGoalTools());
    await attempt(() => unregisterPartnerTools());
    await attempt(() => unregisterPartnerWorkbenchTools());
    await attempt(() => unregisterPartnerTodoTools());
    for (const unregister of unregisterPartnerMessagingTools) await attempt(() => unregister());
    await attempt(() => unregisterPartnerSessionTaskTools());
    await attempt(() => unregisterPartnerProfileTools());
    await attempt(() => unregisterPartnerRoutineTools());
    await attempt(() => unregisterAppDefaultModelTools());
    await attempt(() => partnerSessionTasks?.close());
    await attempt(() => unregisterLspBridge());
    await attempt(() => unregisterRemoteHostTools());
    await attempt(() => unregisterDocumentTools());
    await attempt(() => lspBridge.dispose());
    await attempt(() => unregisterSchedulerBridgeTools());
    await attempt(() => unregisterVisionBridgeTools());
    await attempt(() => unregisterMakerMemoryBridge());
    await attempt(() => unregisterPluginAuthoringTools());
    partnerLearning.dispose();
    await attempt(() => partnerLearning?.drain());
    makerMemory.dispose();
    await attempt(() => { if (maintenanceTimer !== undefined) clearInterval(maintenanceTimer); });
    await attempt(() => maintenanceTail);
    await attempt(() => messageSearch.stop());
    await attempt(() => sessionNavigation.dispose());
    await attempt(() => partnerWorkingStatus.dispose());
    await attempt(() => partnerGroups?.close());
    await attempt(() => partnerNetwork?.close());
    await attempt(() => partnerGroupWorkspaces?.dispose());
    await attempt(() => auxiliaryText.dispose());
    helpAssistant.close();
    await attempt(async () => { await mcpApps?.dispose(); });
    await attempt(() => mcpRouter.dispose());
    await attempt(() => voiceInput.close());
    await attempt(() => sshKeys.close());
    await attempt(() => workspaces.close());
    await attempt(() => remoteDesktop.close());
    await attempt(() => devicePeers.shutdown());
    await attempt(() => remoteBackendRuntimeSetup.close());
    await attempt(() => localBackendRuntimeSetup.close());
    managedChildWorkspaces.close();
    await attempt(() => remoteHosts.close());
    await attempt(() => runtimeActivity.close());
    await attempt(() => voiceDictionaryPeers.close());
    await attempt(closeVoiceDictionary);
    await attempt(() => voiceDictionaryPeerStore.close());
    await attempt(() => contactSync.close());
    await attempt(() => contacts.close());
    await attempt(() => contactStore.close());
    await attempt(() => partnerStore.close());
    await attempt(() => partnerGroupStore.close());
    await attempt(() => store.close());
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "Orchestrator startup failed and cleanup remained incomplete."
      );
    }
    throw error;
  }

  // Host preferences authorize one startup attempt; SSH failures remain in
  // their own durable projection and must not delay the service becoming usable.
  void remoteHosts.startAutoConnect().catch(() => undefined);

  return {
    config,
    taskSharingHome,
    store,
    connections,
    serverId,
    linkspanIdentity,
    serverAccess,
    serverAccessMedia,
    advertisedOrigin,
    lanDiscovery,
    artifacts,
    artifactMaintenance,
    historyMaintenance,
    blobTransfers,
    artifactRepository,
    workspaces,
    workspaceChanges,
    sessionHost,
    sessionWorktrees,
    runtimeActivity,
    runtimeGovernance,
    toolPolicies,
    gitSafety,
    scheduler,
    scheduleHookScripts,
    reviewCoordinator,
    devicePeers,
    remoteDesktop,
    remoteExecution,
    remoteHosts,
    remoteBackendRuntimeSetup,
    localBackendRuntimeSetup,
    sshKeys,
    terminals,
    voiceInput,
    desktopVoiceConversation,
    voiceInputSettings,
    voiceDictionary,
    voiceDictionaryPeers,
    mobilePush,
    get adapters() {
      return backendInstances.availableAdapters();
    },
    restartBackend,
    refreshBackendDescriptor,
    projectBackendProviderAuthentication,
    holdSubagentSmartRoutingDispatch: (backendId) => deferredBackendRestarts!.request(backendId),
    refreshSubagentSmartRouting,
    credentials,
    providers,
    managedModelRuntime: managedModelRuntimeSystem.registry,
    modelWorkingContext,
    removeManagedModelProvider: providerId => managedModelRuntimeSystem.removeProvider(providerId),
    mcpRouter,
    piResources,
    mcpApps,
    mcpAppSurfaces,
    skills,
    skillLearning,
    skillMarket,
    skillMarketSync,
    skillPublication,
    messaging,
    ...(dependencies.messagingCreateWeChatAuthorization === undefined
      ? {}
      : { messagingCreateWeChatAuthorization: dependencies.messagingCreateWeChatAuthorization }),
    collaboration,
    collaborationGoals,
    objectives,
    contacts,
    contactSync,
    partners,
    partnerGroupRuntime,
    partnerGroups,
    partnerNetwork,
    partnerIdentity,
    appDefaultModels,
    partnerRoutines,
    partnerAutonomy,
    partnerMessaging,
    partnerTodos,
    partnerImports,
    partnerHomes,
    partnerHomeRuntime,
    partnerHomeInference,
    hostedAgents,
    hostedAgentSources,
    providerSharing,
    providerGroups,
    inputHandoff,
    nativeInputHandoff,
    partnerWorkbenches,
    partnerSessionTasks,
    partnerTaskOutputs,
    extensionCatalog,
    extensionProjects,
    extensionLibraries,
    extensionMainViews,
    extensionSettings,
    extensionDirectoryPicker,
    extensionCards,
    extensionNetwork,
    extensionOAuth,
    extensionTasks,
    extensionPackagePublisher,
    extensionSources,
    diagnosticsBundles,
    providerAuth,
    providerAccountUsage,
    messageSearch,
    makerMemory,
    partnerMemoryPreferences,
    partnerConnections,
    partnerSkills,
    visionBridge,
    promptPrediction,
    auxiliaryText,
    helpAssistant,
    helpFeedback,
    personalDevelopment,
    personalDevelopmentCoordinator,
    personalDevelopmentNativeBroker,
    personalDevelopmentDoctor,
    partnerWorkingStatus,
    subagentModels,
    modelFavorites,
    sessionNavigation,
    codeHostProviders,
    refreshPiGeneration,
    resolveSessionContextDefaults,
    piSettingsDefaults: {
      [piBackendId]: projectPiSettingsDefaults(settings)
    },
    ...(browser === undefined ? {} : { browser }),
    ...(browserTransfers === undefined ? {} : { browserTransfers }),
    ...(browserSettings === undefined ? {} : { browserSettings }),
    ...(browserAutomationNode === undefined ? {} : { browserAutomationNode }),
    ...(computerAutomation === undefined ? {} : { computerAutomation }),
    ...(computerBridge === undefined ? {} : { computerBridge }),
    ...(androidAutomation === undefined ? {} : { androidAutomation }),
    ...(androidBridge === undefined ? {} : { androidBridge }),
    browserState,
    browserActivity,
    registerServiceCleanup(cleanup) {
      if (closed) {
        cleanup();
        return () => undefined;
      }
      serviceCleanups.add(cleanup);
      return () => serviceCleanups.delete(cleanup);
    },
    close() {
      if (closePromise !== undefined) return closePromise;
      closed = true;
      // Install the shared result before invoking callbacks, including reentrant cleanup.
      closePromise = Promise.resolve().then(async () => {
        const failures: unknown[] = [];
        const attempt = async (cleanup: () => unknown): Promise<void> => {
          try { await cleanup(); } catch (error) { failures.push(error); }
        };
        const cleanups = [...serviceCleanups];
        serviceCleanups.clear();
        deferredBackendRestarts?.dispose();
        for (const cleanup of cleanups) await attempt(cleanup);
        await attempt(() => serverAccess.close());
        await attempt(() => hostedAgentSources?.stopDiscovery());
        await attempt(() => inputHandoff?.close());
        await attempt(() => inputHandoffNotifications?.close());
        await attempt(() => nativeInputHandoff?.close());
        await attempt(closePersonalDevelopment);
        await attempt(() => taskSharingHome.dispose());
        await attempt(() => unregisterPersonalDevelopmentTools());
        await attempt(() => unregisterInputHandoffTools());
        await attempt(() => partnerImports?.close());
        await attempt(() => partnerHomes.close());
        await attempt(() => partnerSessionTasks?.close());
        await attempt(() => unregisterPartnerSessionTaskTools());
        await attempt(() => partnerImportRuntime.close());
        await attempt(() => unregisterPartnerImportTools());
        await attempt(() => unregisterPartnerSkillTools());
        await attempt(() => unregisterPartnerCapabilityTools());
        await attempt(() => unregisterPartnerProfileTools());
        await attempt(() => unregisterPartnerRoutineTools());
        await attempt(() => unregisterAppDefaultModelTools());
        await attempt(() => commandConcurrencyGate.close());
        await attempt(() => stopExtensionLibraryAuthorityNotifications());
        await attempt(() => skillMarketSync.close());
        await attempt(() => skillPublication.close());
        await attempt(() => skills.close());
        await attempt(() => skillMarket.close());
        await attempt(() => extensionCardRuntime?.stop());
        await attempt(() => extensionCards.dispose());
        await attempt(() => extensionNetwork.dispose());
        await attempt(() => extensionOAuth.dispose());
        await attempt(() => extensionOAuthAccounts.dispose());
        await attempt(() => extensionRoutineRuntime.stop());
        await attempt(() => extensionLibraries.close());
        await attempt(() => extensionMainViews.close());
        await attempt(() => extensionPackagePublisher.close());
        if (maintenanceTimer !== undefined) clearInterval(maintenanceTimer);
        await attempt(() => partnerAutonomy.stop());
        await attempt(() => partnerRoutines?.stop());
        await attempt(() => scheduler.stop());
        await attempt(() => mobilePush.close());
        await attempt(() => sessionNavigation.dispose());
        await attempt(() => partnerWorkingStatus.dispose());
        await attempt(() => partnerGroups?.close());
        await attempt(() => partnerNetwork?.close());
        await attempt(() => partnerGroupWorkspaces?.dispose());
        partnerLearning?.dispose();
        await attempt(() => partnerLearning?.drain());
        await attempt(() => auxiliaryText.dispose());
        helpAssistant.close();
        await attempt(() => providerAuth.beginShutdown());
        await attempt(() => providerAccountUsage.invalidate());
        await attempt(() => localBackendRuntimeSetup.close());
        await attempt(() => managedModelRuntimeSystem.close());
        await attempt(() => objectives?.close());
        await attempt(() => collaborationGoals.close());
        await attempt(() => messaging.close());
        await refreshTail.catch(() => undefined);
        await backendLifecycleTail.catch(() => undefined);
        // Keep the remote transports alive while terminals attempt confirmed process cleanup.
        await attempt(() => terminals.dispose());
        await attempt(() => artifactMaintenance.close());
        await attempt(() => historyMaintenance.close());
        await attempt(() => sessionHost.dispose());
        await attempt(() => hostedAgentSources?.close());
        await attempt(() => hostedAgents.close());
        await attempt(() => providerGroups?.close());
        await attempt(() => providerSharing?.close());
        managedChildWorkspaces.close();
        await attempt(() => backendInstances.disposeRetainedCleanups());
        await attempt(() => managedProviderProxy.close());
        await attempt(() => sessionWorktrees.dispose());
        await generationGcTail.catch(() => undefined);
        await attempt(() => providerAuth.close());
        await attempt(() => browserSettings?.setBackendHealth({ active: false, status: "unavailable", canRecover: false, reason: "disposing" }));
        await attempt(() => browser?.stop());
        await attempt(() => computerBridge?.close());
        await attempt(() => computerRuntime.dispose());
        await attempt(() => androidRuntime.dispose());
        await attempt(() => lanDiscovery.stop());
        await attempt(() => unregisterBrowserBridge?.());
        await attempt(() => unregisterComputerBridge?.());
        await attempt(() => unregisterAndroidBridge?.());
        await attempt(() => unregisterImageGenerationBridge());
        await attempt(() => unregisterSessionHelperTools());
        await attempt(() => unregisterContactTools());
        await attempt(() => unregisterCollaborationGoalTools());
        await attempt(() => unregisterPartnerTools());
        await attempt(() => unregisterPartnerWorkbenchTools());
        await attempt(() => unregisterPartnerTodoTools());
        for (const unregister of unregisterPartnerMessagingTools) await attempt(() => unregister());
        await attempt(() => unregisterLspBridge());
        await attempt(() => unregisterRemoteHostTools());
        await attempt(() => unregisterDocumentTools());
        await attempt(() => lspBridge.dispose());
        await attempt(() => unregisterSchedulerBridgeTools());
        await attempt(() => unregisterVisionBridgeTools());
        await attempt(() => unregisterMakerMemoryBridge());
        await attempt(() => unregisterPluginAuthoringTools());
        makerMemory.dispose();
        await maintenanceTail.catch(() => undefined);
        await attempt(() => messageSearch.stop());
        await attempt(async () => { await mcpApps?.dispose(); });
        await attempt(() => mcpRouter.dispose());
        await attempt(() => voiceInput.close());
        sshKeys.close();
        await attempt(() => workspaces.close());
        await attempt(() => remoteDesktop.close());
        await attempt(() => devicePeers.shutdown());
        await attempt(() => remoteBackendRuntimeSetup.close());
        await attempt(() => remoteHosts.close());
        await attempt(() => runtimeActivity.close());
        await attempt(() => voiceDictionaryPeers.close());
        await attempt(closeVoiceDictionary);
        await attempt(() => voiceDictionaryPeerStore.close());
        await attempt(() => contactSync.close());
        await attempt(() => contacts.close());
        await attempt(() => contactStore.close());
        await attempt(() => partnerStore.close());
        await attempt(() => partnerGroupStore.close());
        await attempt(() => store.close());
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, "Some Orchestrator owners could not finish shutdown.");
      });
      return closePromise;
    }
  };
  } catch (error) {
    if (startupCleanupHandled) throw error;
    closed = true;
    const cleanupErrors: unknown[] = [];
    const attempt = async (cleanup: () => unknown): Promise<void> => {
      try { await cleanup(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    };
    await attempt(() => startupPartnerImports?.close());
    await attempt(() => startupPartnerHomes?.close());
    await attempt(closePersonalDevelopment);
    await attempt(() => partnerGroups?.close());
    await attempt(() => partnerGroupWorkspaces?.dispose());
    await attempt(() => startupPartnerImportRuntime?.close());
    partnerLearning?.dispose();
    await attempt(() => partnerLearning?.drain());
    await attempt(() => deferredBackendRestarts?.dispose());
    await attempt(() => commandConcurrencyGate.close());
    await attempt(() => stopExtensionLibraryAuthorityNotifications());
    await attempt(() => providerAuth.beginShutdown());
    await attempt(() => providerAccountUsage.invalidate());
    await attempt(() => startupHistoryMaintenance?.close());
    cleanupErrors.push(...await cleanupStartupBackendOwners());
    await attempt(() => startupSessionWorktrees?.dispose());
    await attempt(() => generationGcTail.catch(() => undefined));
    await attempt(() => providerAuth.close());
    await attempt(async () => { await mcpApps?.dispose(); });
    await attempt(() => mcpRouter.dispose());
    await attempt(() => voiceInput.close());
    await attempt(() => remoteDesktop.close());
    await attempt(() => devicePeers.shutdown());
    await attempt(() => remoteBackendRuntimeSetup.close());
    await attempt(() => remoteHosts.close());
    await attempt(() => mobilePush.close());
    await attempt(() => skillMarketSync.close());
    await attempt(() => skillPublication.close());
    await attempt(() => skills.close());
    await attempt(() => skillMarket.close());
    await attempt(() => startupCardRuntime?.stop());
    await attempt(() => startupExtensionCards?.dispose());
    await attempt(() => extensionNetwork.dispose());
    await attempt(() => extensionOAuth.dispose());
    await attempt(() => extensionOAuthAccounts.dispose());
    await attempt(() => startupRoutineRuntime?.stop());
    await attempt(() => startupPartnerAutonomy?.stop());
    await attempt(() => extensionLibraries.close());
    await attempt(() => extensionMainViews.close());
    await attempt(() => extensionPackagePublisher.close());
    await attempt(() => sshKeys.close());
    await attempt(() => runtimeActivity.close());
    await attempt(() => voiceDictionaryPeers.close());
    await attempt(closeVoiceDictionary);
    await attempt(() => voiceDictionaryPeerStore.close());
    await attempt(() => contactSync.close());
    await attempt(() => contacts.close());
    await attempt(() => contactStore.close());
    await attempt(() => partnerStore.close());
    await attempt(() => partnerGroupStore.close());
    await attempt(() => store.close());
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "Orchestrator initialization failed and cleanup remained incomplete."
      );
    }
    throw error;
  }
  } catch (error) {
    const failures: unknown[] = [];
    try { voiceDictionaryPeers?.close(); } catch (failure) { failures.push(failure); }
    try { closeVoiceDictionary(); } catch (failure) { failures.push(failure); }
    try { voiceDictionaryPeerStore.close(); } catch (failure) { failures.push(failure); }
    if (failures.length > 0) throw new AggregateError([error, ...failures], "Dictionary peer startup cleanup remained incomplete.");
    throw error;
  }
}

function contactSyncDisplayName(): string {
  const value = hostname().trim();
  return value.length >= 1 && value.length <= 90 && !/[\u0000-\u001f\u007f]/u.test(value)
    ? `${value} · Joko`
    : "Joko";
}

function createClaudeCodeCredentialPort(
  credentials: CredentialManager,
  credentialReferenceId: string,
  providerId: string
): ClaudeCodeCredentialPort {
  credentials.reserveManagedSecret({
    credentialReferenceId,
    kind: "subscription",
    providerId
  });
  const readSerialized = (): string | undefined => {
    const descriptor = credentials.find(credentialReferenceId);
    if (descriptor === undefined) return undefined;
    if (descriptor.kind !== "subscription" || descriptor.providerId !== providerId) {
      throw new Error("The native subscription credential reference has an unexpected owner.");
    }
    return credentials.resolveForRefresh(credentialReferenceId);
  };
  return {
    readSerialized: async () => readSerialized(),
    compareAndSet: async (input) => {
      readSerialized();
      return credentials.compareAndSetManagedSecret({
        credentialReferenceId,
        expectedSecret: input.expected,
        secret: input.value,
        displayName: "Claude Code subscription",
        kind: "subscription",
        providerId,
        expiresAt: input.expiresAt
      });
    },
    restoreExact: async (input) => {
      readSerialized();
      return credentials.restoreManagedSecretExact({
        credentialReferenceId,
        expectedSecret: input.expected,
        secret: input.value,
        displayName: "Claude Code subscription",
        kind: "subscription",
        providerId,
        expiresAt: input.expiresAt
      });
    },
    deleteExact: async (expected) => {
      const current = readSerialized();
      if (current !== expected) return false;
      return credentials.deleteManagedSecretIfCurrent(credentialReferenceId, expected);
    }
  };
}

function createOutboundFetch(
  resolveProxy: OutboundProxyResolver | undefined,
  maximumResponseBytes = 1024 * 1024
): typeof fetch {
  if (!Number.isSafeInteger(maximumResponseBytes)
    || maximumResponseBytes < 1
    || maximumResponseBytes > 256 * 1024 * 1024) {
    throw new Error("The outbound response size limit is invalid.");
  }
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const target = input instanceof Request ? input.url : input.toString();
    const requestSignal = init?.signal instanceof AbortSignal ? init.signal : undefined;
    const environmentProxy = environmentProxyForTarget(new URL(target), process.env);
    const proxyValue = environmentProxy === undefined
      ? await awaitWithAbort(resolveProxy?.(target, { signal: requestSignal }), requestSignal)
      : environmentProxy;
    requestSignal?.throwIfAborted();
    if (proxyValue === undefined || proxyValue === null || proxyValue === "") {
      return boundedOutboundResponse(await fetch(input, init), maximumResponseBytes);
    }
    const protocol = new URL(proxyValue).protocol;
    const dispatcher: Dispatcher = protocol === "socks5:" || protocol === "socks5h:"
      ? createSocks5Dispatcher(proxyValue)
      : new ProxyAgent(proxyValue);
    try {
      const upstream = await proxyFetch(input as Parameters<typeof proxyFetch>[0], {
        ...(init as Parameters<typeof proxyFetch>[1]),
        dispatcher
      });
      return await boundedOutboundResponse(upstream, maximumResponseBytes);
    } finally {
      await awaitWithAbort(dispatcher.close().catch(() => undefined), requestSignal);
    }
  }) as typeof fetch;
}

async function awaitWithAbort<T>(
  value: T | PromiseLike<T>,
  signal: AbortSignal | undefined
): Promise<T> {
  if (signal === undefined) return await value;
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason instanceof Error
      ? signal.reason
      : new Error("Outbound proxy resolution was aborted."));
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve(value), aborted]);
  } finally {
    if (abort !== undefined) signal.removeEventListener("abort", abort);
  }
}

async function boundedOutboundResponse(
  upstream: Response | Awaited<ReturnType<typeof proxyFetch>>,
  maximumBytes: number
): Promise<Response> {
  const declaredLength = Number(upstream.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await upstream.body?.cancel();
    throw new Error("The outbound response exceeded its size limit.");
  }
  const body = await readBoundedResponseBody(
    upstream.body as unknown as ReadableStream<Uint8Array> | null,
    maximumBytes
  );
  return new Response(body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers as unknown as HeadersInit
  });
}

async function readBoundedResponseBody(
  body: ReadableStream<Uint8Array> | null,
  maximumBytes: number
): Promise<ArrayBuffer> {
  if (body === null) return new ArrayBuffer(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new Error("The outbound response exceeded its size limit.");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result.buffer;
}

function environmentProxyForTarget(target: URL, environment: NodeJS.ProcessEnv): string | null | undefined {
  if (proxyBypassed(target, environment["NO_PROXY"] ?? environment["no_proxy"])) return null;
  const candidates = target.protocol === "https:"
    ? [
        environment["HTTPS_PROXY"],
        environment["https_proxy"],
        environment["HTTP_PROXY"],
        environment["http_proxy"],
        environment["ALL_PROXY"],
        environment["all_proxy"]
      ]
    : [environment["HTTP_PROXY"], environment["http_proxy"], environment["ALL_PROXY"], environment["all_proxy"]];
  const value = candidates.find((candidate): candidate is string => typeof candidate === "string" && candidate !== "");
  if (value === undefined) return undefined;
  const proxy = new URL(value);
  if (proxy.protocol !== "http:" && proxy.protocol !== "https:"
    && proxy.protocol !== "socks5:" && proxy.protocol !== "socks5h:") {
    throw new Error("The outbound proxy protocol is unsupported.");
  }
  return proxy.toString();
}

function proxyBypassed(target: URL, configured: string | undefined): boolean {
  if (configured === undefined || configured.trim() === "") return false;
  const host = target.hostname.toLowerCase();
  const port = target.port === "" ? (target.protocol === "https:" ? "443" : "80") : target.port;
  return configured.split(",").some((entry) => {
    const value = entry.trim().toLowerCase();
    if (value === "*") return true;
    if (value === "") return false;
    const [candidateHost, candidatePort] = value.split(":", 2);
    if (candidatePort !== undefined && candidatePort !== port) return false;
    const suffix = (candidateHost ?? "").replace(/^\./u, "");
    return suffix !== "" && (host === suffix || host.endsWith(`.${suffix}`));
  });
}

export function providerUsageMoneyKind(
  providers: Pick<ProviderCatalogManager, "list">,
  backend: Pick<BackendDescriptor, "id" | "capabilities">,
  providerId: string
): "actual-cost" | "subscription-value" | "reference-value" {
  if (backend.capabilities.get(MANAGED_PROVIDER_CATALOG_CAPABILITY)?.supported !== true) {
    return "reference-value";
  }
  const kind = providers.list(backend.id).find((entry) => entry.provider.id === providerId)?.kind;
  if (kind === "managed" || kind === "api_key" || kind === "oauth" || kind === "custom_endpoint") {
    return "actual-cost";
  }
  // Subscription catalog values are not billed spend. Missing, removed, and
  // local-keyless Providers also lack evidence of metered billing and must
  // never be promoted to actual cost merely because a runtime reports a price.
  return kind === "subscription" ? "subscription-value" : "reference-value";
}

function persistedLocale(store: OperationalStore): string {
  const value = store.findSetting<unknown>("service", "orchestrator", "settings.appearance")?.value;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const locale = (value as Record<string, unknown>)["locale"];
    if (typeof locale === "string" && locale.trim() !== "") return locale;
  }
  return "en";
}

function configuredSilentEncryptedRetry(store: OperationalStore): boolean {
  const value = store.findSetting<unknown>(
    "service",
    "orchestrator",
    "settings.personalization.silent_encrypted_retry"
  )?.value;
  return isRecord(value) && typeof value["enabled"] === "boolean" ? value["enabled"] : true;
}

function browserDisplayName(executablePath: string): string {
  const file = basename(executablePath).toLowerCase();
  if (file.includes("msedge") || file.includes("microsoft edge")) return "Microsoft Edge";
  if (file.includes("brave")) return "Brave";
  if (file.includes("chromium")) return "Chromium";
  return "Google Chrome";
}

function androidBundledExecutablePaths(): readonly string[] {
  const configuredRoot = process.env["JOKO_DESKTOP_RESOURCES_PATH"];
  if (configuredRoot === undefined || !isAbsolute(configuredRoot) || resolve(configuredRoot) !== configuredRoot) {
    return [];
  }
  const executable = process.platform === "win32" ? "adb.exe" : "adb";
  return [
    join(configuredRoot, "platform-tools", androidPlatformToolsTarget(process.platform, process.arch), executable),
    join(configuredRoot, "platform-tools", executable)
  ];
}

function computerAutomationRuntime(runtime: ComputerRuntime): ComputerAutomationRuntime {
  return {
    async probe(options) {
      return computerAutomationProbe(await runtime.status({ signal: options?.signal, fresh: options?.fresh }));
    },
    async install(options) {
      await runtime.install({ signal: options?.signal });
    },
    async requestPermission(_permission, options) {
      await runtime.grantPermissions({ signal: options?.signal });
    },
    async openPermissionSettings(permission, options) {
      await runtime.openPermissionSettings(permission, { signal: options?.signal });
    },
    cancelPermissionRequest() {
      runtime.cancelPermissionGrant();
    },
    async checkForUpdate(options) {
      return runtime.checkForUpdate({ signal: options?.signal, fresh: options?.fresh });
    },
    async updateDriver(options) {
      await runtime.update({
        signal: options?.signal,
        joinOnly: options?.joinOnly,
        onProgress: options?.onProgress
      });
    }
  };
}

function computerAutomationProbe(status: ComputerRuntimeStatus): ComputerAutomationProbe {
  const platformSupported = status.platform.supported;
  const permissionsReady = !status.permissions.required
    || status.permissions.status === "granted";
  const daemonRunning = status.daemon.state === "running";
  const ready = platformSupported && status.installed && daemonRunning && permissionsReady;
  return {
    support: platformSupported ? "supported" : "platformLimited",
    supportReason: platformSupported ? "" : "Computer automation is unavailable on this platform.",
    installed: status.installed,
    driverVersion: status.version ?? "",
    daemonRunning,
    accessibilityPermission: computerPermission(status.permissions.accessibility),
    screenRecordingPermission: computerPermission(status.permissions.screenRecording),
    screenRecordingCapturable: status.permissions.liveScreenCapture === "granted",
    ready,
    failureReason: ready
      ? ""
      : !status.installed
        ? "The local computer driver is not installed."
        : status.permissions.status === "unknown"
          ? "System permission status could not be verified."
          : status.permissions.status === "missing"
            ? "Required system permission is missing."
            : !daemonRunning
              ? "The local computer driver daemon is not running."
              : "Computer automation is not ready.",
    platform: status.platform.platform
  };
}

function computerPermission(value: ComputerPermissionGrant): ComputerAutomationProbe["accessibilityPermission"] {
  switch (value) {
    case "granted": return "granted";
    case "missing": return "missing";
    case "not_required": return "notRequired";
    case "unknown": return "unknown";
  }
}

function durableServerId(store: OperationalStore): string {
  const existing = store.findSetting<unknown>("service", "orchestrator", "public.node_identity")?.value;
  if (isRecord(existing)) {
    const serverId = existing["serverId"];
    if (typeof serverId === "string" && /^[a-z0-9][a-z0-9._:-]{0,127}$/iu.test(serverId)) return serverId;
  }
  const serverId = `orchestrator-${randomUUID()}`;
  store.setSetting("service", "orchestrator", "public.node_identity", { serverId });
  return serverId;
}

function internalBridgeEndpoint(config: OrchestratorConfig): string {
  const origin = new URL(config.internalOrigin);
  const expectedPort = config.internalPort === 80 ? "" : String(config.internalPort);
  if (
    origin.protocol !== "http:" || !isLoopbackHost(origin.hostname) ||
    origin.username !== "" || origin.password !== "" || origin.pathname !== "/" ||
    origin.search !== "" || origin.hash !== "" || origin.port !== expectedPort
  ) throw new Error("Orchestrator internal origin must be the configured loopback-only HTTP listener.");
  return new URL("/internal/mcp", origin).toString();
}

function generationSnapshotRoot(
  config: OrchestratorConfig,
  revision: bigint,
  settings: PiManagedSettings,
  sequence: number
): string {
  const settingsRevision = createHash("sha256").update(JSON.stringify(settings)).digest("hex").slice(0, 12);
  return join(config.piAgentHome, "generations", `runtime-${revision.toString(10)}-${settingsRevision}-${sequence.toString(36)}`);
}

function projectPiSettingsDefaults(settings: PiManagedSettings): PiSettingsProjectionDefaults {
  return {
    // These are Pi's native settings defaults when the owner did not provide
    // an override. Keeping resolution here avoids inventing values in API/UI
    // projections that do not own Pi configuration semantics.
    autoCompaction: settings.compaction?.enabled ?? NATIVE_PI_SETTINGS_DEFAULTS.autoCompaction,
    autoCompactionThresholdPercent: settings.compaction?.thresholdPercent
      ?? NATIVE_PI_SETTINGS_DEFAULTS.autoCompactionThresholdPercent,
    autoRetry: settings.retry?.enabled ?? NATIVE_PI_SETTINGS_DEFAULTS.autoRetry,
    steeringMode: settings.steeringMode ?? NATIVE_PI_SETTINGS_DEFAULTS.steeringMode,
    followUpMode: settings.followUpMode ?? NATIVE_PI_SETTINGS_DEFAULTS.followUpMode
  };
}

/**
 * Remove only the immutable snapshot root whose Adapter reference count has
 * reached zero. The direct-child and canonical-path checks make a replaced
 * symlink/junction fail closed instead of broadening the recursive target.
 */
async function removeReleasedPiGeneration(generationsRoot: string, agentHome: string): Promise<void> {
  const expectedRoot = resolve(generationsRoot);
  const expectedAgentHome = resolve(agentHome);
  const snapshotRoot = dirname(expectedAgentHome);
  if (dirname(snapshotRoot) !== expectedRoot || dirname(expectedAgentHome) !== snapshotRoot) {
    throw new Error("Released Pi generation is outside the managed generations root.");
  }
  let snapshotInfo;
  try {
    snapshotInfo = await lstat(snapshotRoot);
  } catch (error) {
    if (isMissingPathError(error)) return;
    throw error;
  }
  if (!snapshotInfo.isDirectory() || snapshotInfo.isSymbolicLink()) {
    throw new Error("Released Pi generation snapshot root is not a direct regular directory.");
  }
  const [canonicalRoot, canonicalSnapshot] = await Promise.all([
    realpath(expectedRoot),
    realpath(snapshotRoot)
  ]);
  if (dirname(canonicalSnapshot) !== canonicalRoot) {
    throw new Error("Released Pi generation canonical path escaped its managed root.");
  }
  await rm(snapshotRoot, { recursive: true, force: true, maxRetries: 3 });
}

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function createTargetAwarePiBridgeGeneration(
  router: McpRouter,
  endpoint: string,
  nativeAuthLease: {
    readonly endpoint: string;
    readonly catalogGeneration: number;
    readonly providerIds: readonly string[];
    readonly authenticatedProviderIds: readonly string[];
  },
  toolPolicyEnabled: (context: AdapterContext, policyId: string) => boolean,
  onRenewalFailure: (retryInMs: number) => void
): {
  readonly baseSnapshot: PiMcpBridgeOptions;
  readonly resolve: (context: AdapterContext) => PiMcpBridgeOptions;
  readonly release: () => void;
} {
  const base = retainPiMcpBridge(router.createPiBridgeSnapshot({ endpoint, nativeAuthLease }), onRenewalFailure);
  const scoped = new Map<string, ReturnType<typeof retainPiMcpBridge>>();
  let released = false;
  return {
    baseSnapshot: base.snapshot.mcpBridge,
    resolve: (context) => {
      if (released) throw new Error("Pi MCP bridge generation is released.");
      const key = `${context.sessionId}\u0000${context.target.id}\u0000${context.generation}`;
      const existing = scoped.get(key);
      if (existing !== undefined) return existing.snapshot.mcpBridge;
      const lease = retainPiMcpBridge(router.createPiBridgeSnapshot({
        endpoint,
        sessionId: context.sessionId,
        targetId: context.target.id,
        expectedPiGeneration: context.generation,
        nativeAuthLease,
        includeToolPolicy: (policyId) => toolPolicyEnabled(context, policyId)
      }), onRenewalFailure);
      scoped.set(key, lease);
      return lease.snapshot.mcpBridge;
    },
    release: () => {
      if (released) return;
      released = true;
      base.release();
      for (const lease of scoped.values()) lease.release();
      scoped.clear();
    }
  };
}

function retainPiMcpBridge(
  snapshot: PiMcpBridgeSnapshot,
  onRenewalFailure: (retryInMs: number) => void
): { readonly snapshot: PiMcpBridgeSnapshot; readonly release: () => void } {
  const renewalMarginMs = 5 * 60_000;
  const retryInMs = 60_000;
  let timer: NodeJS.Timeout | undefined;
  let released = false;
  const arm = (delayMs = snapshot.expiresAt - Date.now() - renewalMarginMs): void => {
    if (released) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (released) return;
      try {
        snapshot.renew();
        arm();
      } catch {
        onRenewalFailure(retryInMs);
        arm(retryInMs);
      }
    }, Math.max(1_000, delayMs));
    timer.unref();
  };
  arm();
  return {
    snapshot,
    release: () => {
      if (released) return;
      released = true;
      if (timer !== undefined) clearTimeout(timer);
      snapshot.revoke();
    }
  };
}


function effectivePiSettings(base: PiManagedSettings, stored: unknown): PiManagedSettings {
  const configured = isRecord(stored) ? stored : {};
  const autoCompaction = configured["autoCompaction"];
  const thresholdPercent = validAutoCompactionThresholdPercent(configured["autoCompactionThresholdPercent"])
    ?? base.compaction?.thresholdPercent
    ?? NATIVE_PI_SETTINGS_DEFAULTS.autoCompactionThresholdPercent;
  const autoRetry = configured["autoRetry"];
  const steeringMode = piQueueMode(configured["steeringMode"]);
  const followUpMode = piQueueMode(configured["followUpMode"]);
  return {
    ...base,
    compaction: {
      ...base.compaction,
      ...(typeof autoCompaction === "boolean" ? { enabled: autoCompaction } : {}),
      thresholdPercent
    },
    ...(typeof autoRetry === "boolean"
      ? { retry: { ...base.retry, enabled: autoRetry } }
      : {}),
    ...(steeringMode === undefined ? {} : { steeringMode }),
    ...(followUpMode === undefined ? {} : { followUpMode })
  };
}

function durableRuntimeGeneration(): number {
  const suffix = Number.parseInt(randomUUID().slice(0, 3), 16);
  const generation = Date.now() * 4_096 + suffix;
  if (!Number.isSafeInteger(generation) || generation < 1) throw new Error("Runtime generation is invalid.");
  return generation;
}

function validAutoCompactionThresholdPercent(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value)
    && value >= PI_AUTO_COMPACTION_THRESHOLD_PERCENT_MINIMUM
    && value <= PI_AUTO_COMPACTION_THRESHOLD_PERCENT_MAXIMUM
    ? value
    : undefined;
}

function piQueueMode(value: unknown): "all" | "one-at-a-time" | undefined {
  if (value === 1) return "all";
  if (value === 2) return "one-at-a-time";
  return undefined;
}

async function loadJsonFile<T extends object>(path: string | undefined, fallback: T): Promise<T> {
  if (path === undefined) return fallback;
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(parsed)) throw new Error(`Expected an object in ${path}.`);
  return parsed as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
