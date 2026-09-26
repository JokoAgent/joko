import { createHash, randomUUID } from "node:crypto";
import { ManagedProviderProxy } from "./managed-provider-proxy.js";
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
  createDefaultPiManagedProcessSupervisor,
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
import { ContactStore, OperationalStore, PartnerStore } from "@joko/store";
import { GitSafetyCoordinator, NodeGitCommandRunner } from "@joko/git-safety";
import { AndroidAutomationRuntimeFactory } from "@joko/tool-android";
import { BrowserProvider, type BrowserActivity } from "@joko/tool-browser";
import { TerminalProvider } from "@joko/tool-terminal";
import { RemoteTerminalRuntimeResolver } from "./remote-terminal-runtime.js";
import { RemoteCodexRuntimeResolver } from "./remote-codex-read-runtime.js";
import { CodexMcpBridgeManager } from "./remote-codex-mcp-bridge.js";
import { createClaudeMcpBridge } from "./claude-mcp-bridge.js";
import { RemoteClaudeRuntimeResolver } from "./remote-claude-runtime.js";
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
import { ApnsMobilePushProvider } from "./apns-mobile-push-provider.js";
import {
  MobilePushCoordinator,
  type MobilePushProviderPort
} from "./mobile-push.js";
import { DiagnosticsBundleService } from "./diagnostics-bundle.js";
import { DocumentToolBridgeProvider } from "./document-tool-provider.js";
import { IosSimulatorToolBridgeProvider } from "./ios-simulator-tool-bridge.js";
import { SimulatorOwnershipRegistry } from "./ios-simulator-ownership.js";
import { SimulatorPendingCreateRegistry } from "./ios-simulator-pending-create.js";
import { SimulatorCreateCoordinator } from "./ios-simulator-create-coordinator.js";
import { SimulatorLifecycleCoordinator } from "./ios-simulator-lifecycle-coordinator.js";
import { SimulatorDriverCoordinator, type SimulatorDriverCoordinatorOptions } from "./ios-simulator-driver-coordinator.js";
import { SimulatorInstanceControlCoordinator } from "./ios-simulator-instance-control.js";
import { SimulatorScreenObservationCoordinator } from "./ios-simulator-screen-observation.js";
import { SimulatorInputCoordinator } from "./ios-simulator-input-coordinator.js";
import { SimulatorViewerLiveTouchCoordinator } from "./ios-simulator-viewer-live-touch.js";
import { createSimulatorEnvironmentRuntime, createSimulatorLifecycleRuntime,
  inspectSimulatorAppArtifact, type SimulatorCreateRuntime,
  type SimulatorEnvironmentRuntime, type SimulatorLifecycleRuntime } from "@joko/tool-ios-simulator";
import { SimulatorStateControlCoordinator } from "./ios-simulator-state-control.js";
import { SimulatorProjectBuildCoordinator } from "./ios-simulator-project-build.js";
import { SimulatorAppInstallCoordinator } from "./ios-simulator-app-install.js";
import { SimulatorAppControlCoordinator } from "./ios-simulator-app-control.js";
import { SimulatorUrlControlCoordinator } from "./ios-simulator-url-control.js";
import { SimulatorScreenshotCoordinator } from "./ios-simulator-screenshot.js";
import { SimulatorRecordingCoordinator } from "./ios-simulator-recording.js";
import { SimulatorVisualComparisonCoordinator } from "./ios-simulator-visual-comparison.js";
import { SimulatorStateDiagnosticsCoordinator } from "./ios-simulator-state-diagnostics.js";
import { SimulatorViewerFrameCoordinator } from "./ios-simulator-viewer-frames.js";
import { SimulatorMutationArbiter } from "./ios-simulator-mutation-arbiter.js";
import type { SimulatorViewerServiceOwner } from "./simulator-viewer-connect-service.js";
import type { SimulatorProjectBuilder, SimulatorRecordingRuntime,
  SimulatorOwnedDeleteRuntime } from "@joko/tool-ios-simulator";
import { ChromiumDocumentPdfRenderer } from "./document-pdf-renderer.js";
import { ElectronDocumentPdfRenderer } from "./document-electron-pdf-renderer.js";
import { ExtensionCatalogManager } from "./extension-catalog.js";
import { ExtensionLibraryManager } from "./extension-library-manager.js";
import { ExtensionMainViewManager } from "./extension-main-view-manager.js";
import { ExtensionPackagePublisher } from "./extension-package-publisher.js";
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
import { MessagingManager, type MessagingManagerOptions } from "./messaging-manager.js";
import type { WeChatAuthorizationPort } from "./wechat-authorization-manager.js";
import type { ManagedModelRuntimeController } from "./managed-model-runtime-controller.js";
import { createManagedModelRuntimeSystem } from "./managed-model-runtime-system.js";
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
import { SubagentModelSettings } from "./subagent-model-settings.js";
import { DeferredBackendRestartCoordinator } from "./deferred-backend-restart.js";
import { VisionBridgeToolProvider } from "./vision-bridge-tool-provider.js";
import { OperationalBrowserState } from "./operational-browser-state.js";
import { OperationalWorkspaceSnapshotRepository } from "./operational-workspace-snapshots.js";
import { PiProviderAuthSupervisor } from "./pi-provider-auth-supervisor.js";
import { ProviderAccountUsageProvider } from "./provider-account-usage.js";
import { PiResourceManager } from "./resource-manager.js";
import { SkillManager } from "./skill-manager.js";
import { SkillLearningManager } from "./skill-learning-manager.js";
import { SkillMarketManager } from "./skill-market-manager.js";
import { SkillMarketSyncManager } from "./skill-market-sync-manager.js";
import { SkillMutationCoordinator } from "./skill-mutation-coordinator.js";
import { SkillPublicationManager } from "./skill-publication-manager.js";
import { CollaborationManager } from "./collaboration-manager.js";
import { CollaborationGoalManager } from "./collaboration-goal-manager.js";
import { CollaborationToolBridgeProvider } from "./collaboration-tool-provider.js";
import { ContactManager } from "./contact-manager.js";
import { ContactSyncManager } from "./contact-sync-manager.js";
import { ContactToolBridgeProvider } from "./contact-tool-provider.js";
import { PartnerManager, partnerSessionRuntimeFallback } from "./partner-manager.js";
import { PartnerToolBridgeProvider } from "./partner-tool-provider.js";
import { RemoteHostRegistry } from "./remote-host-registry.js";
import {
  RemoteBackendRuntimeSetupManager,
  createRemoteClaudeRuntimeSetupProvider,
  createRemoteCodexRuntimeSetupProvider
} from "./remote-backend-runtime-setup.js";
import { RemotePiProcessFactory } from "./remote-pi-process.js";
import { RemoteWorkspaceService } from "./remote-workspace-service.js";
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
import { VoiceInputSettingsController } from "./voice-input-settings.js";
import { WorkspaceChangeSetService } from "./workspace-change-set.js";
import { OperationalWorkspaceChangeJournal } from "./workspace-change-stream.js";
import { DurableWorkspaceRunCapture } from "./workspace-run-capture.js";
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
  readonly config: OrchestratorConfig;
  readonly store: OperationalStore;
  readonly connections: ConnectionManager;
  /** Stable, public node identity used by ServerInfo and LAN discovery deduplication. */
  readonly serverId: string;
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
  readonly reviewCoordinator?: ReviewCoordinator;
  readonly remoteHosts?: RemoteHostRegistry;
  readonly remoteBackendRuntimeSetup?: RemoteBackendRuntimeSetupManager;
  readonly sshKeys?: SshKeyManager;
  readonly terminals?: TerminalProvider;
  readonly simulatorViewer?: SimulatorViewerServiceOwner;
  readonly voiceInput?: VoiceInputCoordinator;
  readonly voiceInputSettings?: VoiceInputSettingsController;
  readonly mobilePush?: MobilePushCoordinator;
  /** Point-in-time projection of current Backend process instances. */
  readonly adapters: readonly BackendAdapter[];
  /** Idle-only, durable-generation Backend process replacement. */
  readonly restartBackend: (backendId: string) => Promise<void>;
  /** Refresh volatile native account/model state for the current generation. */
  readonly refreshBackendDescriptor: (backendId: string) => Promise<void>;
  /** Install a process-local queue hold synchronously after the desired revision commits. */
  readonly holdSubagentSmartRoutingDispatch: (backendId: string) => void;
  /** Apply the durable smart-routing preference through an idle process-generation replacement. */
  readonly refreshSubagentSmartRouting: (backendId: string) => Promise<void>;
  /** Optional only so isolated test hosts can deliberately advertise no provisioning channel. */
  readonly credentials?: CredentialManager;
  readonly providers?: ProviderCatalogManager;
  /** Node-owned local inference runtime; renderer and Desktop IPC never own its processes. */
  readonly managedModelRuntime?: ManagedModelRuntimeController;
  readonly mcpRouter?: McpRouter;
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
  /** Node-local structured authority for people and organizations. */
  readonly contacts?: ContactManager;
  /** Explicitly granted, encrypted node-to-node Contacts convergence owner. */
  readonly contactSync?: ContactSyncManager;
  /** Node-local authority for long-lived partner profiles and their canonical Sessions. */
  readonly partners?: PartnerManager;
  readonly extensionCatalog?: ExtensionCatalogManager;
  readonly extensionLibraries?: ExtensionLibraryManager;
  readonly extensionMainViews?: ExtensionMainViewManager;
  readonly extensionPackagePublisher?: ExtensionPackagePublisher;
  readonly extensionSources?: ExtensionSourceManager;
  readonly diagnosticsBundles?: DiagnosticsBundleService;
  readonly providerAuth?: PiProviderAuthSupervisor;
  /** Capability-owned, in-memory Provider account quota reader. */
  readonly providerAccountUsage?: ProviderAccountUsageProvider;
  readonly messageSearch?: MessageSearchEmbeddingCoordinator;
  readonly makerMemory?: MakerMemoryController;
  readonly visionBridge?: VisionBridgeCoordinator;
  readonly promptPrediction?: PromptPredictionService;
  readonly auxiliaryText?: AuxiliaryTextRouting;
  readonly subagentModels?: SubagentModelSettings;
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
  readonly simulatorRuntime?: {
    readonly environment?: SimulatorEnvironmentRuntime;
    readonly lifecycle?: SimulatorLifecycleRuntime;
    readonly create?: SimulatorCreateRuntime;
    readonly driver?: Pick<SimulatorDriverCoordinatorOptions,
      "manager" | "cleanupOrphans" | "architecture" | "nativeHidRuntime" |
      "nativeH264Runtime" | "mjpegStream">;
    readonly projectBuilder?: Pick<SimulatorProjectBuilder, "inspect" | "build" | "readXcresult">;
    readonly inspectAppArtifact?: typeof inspectSimulatorAppArtifact;
    readonly recording?: SimulatorRecordingRuntime;
    readonly delete?: SimulatorOwnedDeleteRuntime;
  };
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

  const store = new OperationalStore(config.databasePath);
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
  let sessionWorktrees!: SessionWorktreeCoordinator;
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
  const codeHostProviders = composeCodeHostProviders(
    dependencies.codeHostProviders,
    new OperationalCodeHostSessionAuthorization(store)
  );
  const runtimeActivity = createRuntimeActivityTracker(store);
  const runtimeGovernance = new RuntimeGovernanceSettingsRepository({ store });
  const gitSafety = new GitSafetyCoordinator({
    runner: new NodeGitCommandRunner(),
    readAutoSnapshotEnabled: () => runtimeGovernance.gitSafety().autoSnapshotEnabled,
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
  const connections = new ConnectionManager(store);
  let lastLanDiscoveryDiagnosticAt = 0;
  const lanDiscovery = new LanDiscoveryService({
    self: () => ({
      serverId,
      displayName: "Joko",
      origin: config.publicOrigin,
      version: "0.1.0",
      apiVersion: JOKO_API_VERSION,
      pairingEnabled: connections.pairingEnabled,
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
  const remotePiProcesses = new RemotePiProcessFactory({
    registry: remoteHosts,
    authorityRoot: join(config.dataDirectory, "remote-pi-authority")
  });
  const remoteWorkspaceFiles = new RemoteWorkspaceService(remoteHosts);
  const remoteTerminals = new RemoteTerminalRuntimeResolver(remoteHosts);
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
  const voiceInputSettings = new VoiceInputSettingsController({ store, credentials, providers });
  const voiceInput = new VoiceInputCoordinator({
    provider: dependencies.voiceInputProvider ?? voiceInputSettings
  });
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
    managedRoot: join(config.piAgentHome, "managed-resources")
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
  const mcpRouter = new McpRouter({
    store,
    credentials,
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
    rootDirectory: join(config.dataDirectory, "extension-main-views")
  });
  await extensionMainViews.initialize();
  const imageGenerationBridge = new ImageGenerationBridgeToolProvider({
    credentialSurfaces: providerCredentialSurfaces,
    artifacts,
    fetch: createOutboundFetch(
      dependencies.resolveOutboundProxy,
      IMAGE_GENERATION_RESPONSE_MAXIMUM_BYTES
    )
  });
  const unregisterImageGenerationBridge = mcpRouter.registerBridgeToolProvider(imageGenerationBridge);
  let sessionHostForHelperTools: SessionHost | undefined;
  let messageSearchForHelperTools: MessageSearchEmbeddingCoordinator | undefined;
  const unregisterSessionHelperTools = mcpRouter.registerBridgeToolProvider(
    new SessionHelperToolBridgeProvider({
      store,
      host: () => sessionHostForHelperTools,
      messageSearch: () => messageSearchForHelperTools
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
  const simulatorOwnership = new SimulatorOwnershipRegistry(store);
  const simulatorEnvironment = dependencies.simulatorRuntime?.environment ?? createSimulatorEnvironmentRuntime();
  const simulatorPendingCreate = config.iosSimulatorDriver === undefined
    ? undefined : new SimulatorPendingCreateRegistry(store);
  const simulatorCreate = simulatorPendingCreate === undefined ? undefined
    : new SimulatorCreateCoordinator(store, simulatorOwnership, simulatorPendingCreate,
      { create: dependencies.simulatorRuntime?.create, lifecycle: dependencies.simulatorRuntime?.lifecycle });
  const simulatorDriver = config.iosSimulatorDriver === undefined ? undefined
    : new SimulatorDriverCoordinator(store, simulatorOwnership, {
        ...config.iosSimulatorDriver,
        environment: dependencies.simulatorRuntime?.environment,
        lifecycle: dependencies.simulatorRuntime?.lifecycle,
        ...dependencies.simulatorRuntime?.driver
      });
  const simulatorRecording = simulatorDriver === undefined || config.iosSimulatorDriver === undefined
    ? undefined : new SimulatorRecordingCoordinator(store, simulatorOwnership, simulatorDriver, artifacts,
        join(config.dataDirectory, "simulator-recordings"), {
          runtime: dependencies.simulatorRuntime?.recording,
          device: dependencies.simulatorRuntime?.lifecycle
        });
  const simulatorControl = simulatorDriver === undefined || simulatorCreate === undefined
    ? undefined : new SimulatorInstanceControlCoordinator(store, simulatorOwnership, {
      create: simulatorCreate,
      lifecycle: new SimulatorLifecycleCoordinator(store, simulatorOwnership, dependencies.simulatorRuntime?.lifecycle),
      driver: simulatorDriver,
      devices: dependencies.simulatorRuntime?.lifecycle,
      recording: simulatorRecording,
      deleteRuntime: dependencies.simulatorRuntime?.delete
    });
  const simulatorScreen = simulatorDriver === undefined ? undefined
    : new SimulatorScreenObservationCoordinator(simulatorOwnership, simulatorDriver);
  const simulatorInput = simulatorDriver === undefined || simulatorScreen === undefined ? undefined
    : new SimulatorInputCoordinator(store, simulatorOwnership, simulatorDriver, simulatorScreen);
  const simulatorLiveTouch = simulatorDriver === undefined || simulatorScreen === undefined ? undefined
    : new SimulatorViewerLiveTouchCoordinator(store, simulatorOwnership, simulatorDriver, simulatorScreen);
  const simulatorMutations = new SimulatorMutationArbiter(simulatorOwnership, {
    onAgentMutationStart: instanceId => simulatorLiveTouch?.clearInstance(instanceId),
    onTakeover: instanceId => {
      simulatorLiveTouch?.clearInstance(instanceId);
      simulatorScreen?.clear(instanceId);
    }
  });
  const simulatorStateControl = simulatorDriver === undefined || simulatorScreen === undefined ? undefined
    : new SimulatorStateControlCoordinator(store, simulatorOwnership, simulatorDriver, simulatorScreen,
      dependencies.simulatorRuntime?.lifecycle ?? createSimulatorLifecycleRuntime());
  const simulatorProjectBuild = config.iosSimulatorDriver === undefined ? undefined
    : new SimulatorProjectBuildCoordinator(store, simulatorOwnership, {
      artifactRoot: join(dirname(config.iosSimulatorDriver.cacheRoot), "project-build"),
      builder: dependencies.simulatorRuntime?.projectBuilder,
      inspectArtifact: dependencies.simulatorRuntime?.inspectAppArtifact
    });
  await simulatorProjectBuild?.reconcileBuildStorage();
  const simulatorAppInstall = simulatorProjectBuild === undefined ? undefined
    : new SimulatorAppInstallCoordinator(store, simulatorOwnership, simulatorProjectBuild,
      dependencies.simulatorRuntime?.lifecycle ?? createSimulatorLifecycleRuntime());
  const simulatorAppControl = simulatorProjectBuild === undefined || simulatorScreen === undefined
    ? undefined : new SimulatorAppControlCoordinator(store, simulatorOwnership,
      simulatorProjectBuild, simulatorScreen,
      dependencies.simulatorRuntime?.lifecycle ?? createSimulatorLifecycleRuntime());
  const simulatorUrlControl = simulatorScreen === undefined ? undefined
    : new SimulatorUrlControlCoordinator(store, simulatorOwnership, simulatorScreen,
      dependencies.simulatorRuntime?.lifecycle ?? createSimulatorLifecycleRuntime());
  const simulatorScreenshot = simulatorScreen === undefined ? undefined
    : new SimulatorScreenshotCoordinator(store, simulatorOwnership, artifacts,
      dependencies.simulatorRuntime?.lifecycle ?? createSimulatorLifecycleRuntime());
  const simulatorVisual = simulatorScreen === undefined ? undefined
    : new SimulatorVisualComparisonCoordinator(store, simulatorOwnership,
      dependencies.simulatorRuntime?.lifecycle ?? createSimulatorLifecycleRuntime());
  const simulatorViewerFrames = simulatorDriver === undefined ? undefined
    : new SimulatorViewerFrameCoordinator(simulatorOwnership, simulatorDriver);
  const simulatorStateDiagnostics = simulatorDriver === undefined || simulatorScreen === undefined ? undefined
    : new SimulatorStateDiagnosticsCoordinator(simulatorOwnership, simulatorDriver, simulatorScreen,
      Date.now, simulatorViewerFrames);
  const simulatorViewer: SimulatorViewerServiceOwner | undefined = simulatorControl === undefined ? undefined : {
    ownership: simulatorOwnership, control: simulatorControl, environment: simulatorEnvironment,
    mutations: simulatorMutations,
    frames: simulatorViewerFrames, input: simulatorInput, liveTouch: simulatorLiveTouch,
    screen: simulatorScreen, driver: simulatorDriver,
    stateControl: simulatorStateControl, screenshot: simulatorScreenshot,
    clearInstance: async instanceId => {
      simulatorLiveTouch?.clearInstance(instanceId);
      simulatorViewerFrames?.clear(instanceId);
      simulatorScreen?.clear(instanceId);
      simulatorVisual?.clear(instanceId);
      simulatorStateDiagnostics?.clear(instanceId);
      await simulatorRecording?.discardInstance(instanceId);
    }
  };
  const unregisterIosSimulatorTools = mcpRouter.registerBridgeToolProvider(
    new IosSimulatorToolBridgeProvider({ store, ownership: simulatorOwnership, control: simulatorControl,
      screen: simulatorScreen, input: simulatorInput, stateControl: simulatorStateControl,
      projectBuild: simulatorProjectBuild, appInstall: simulatorAppInstall,
      appControl: simulatorAppControl, urlControl: simulatorUrlControl,
      screenshot: simulatorScreenshot, recording: simulatorRecording, visual: simulatorVisual,
      stateDiagnostics: simulatorStateDiagnostics,
      mutations: simulatorMutations,
      runtime: simulatorEnvironment })
  );
  const toolPolicies = new ToolPolicySettingsRepository({
    store,
    catalog: () => mcpRouter.toolPolicyDeclarations()
  });
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
  const makerMemory = new MakerMemoryController({
    store,
    onSettingsChanged: () => refreshPiGenerationImpl()
  });
  const unregisterMakerMemoryBridge = mcpRouter.registerBridgeToolProvider(
    new MakerMemoryBridgeProvider(makerMemory)
  );
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
    generate: createScheduleHookScriptGenerator(providers)
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
    agentHome: providerSnapshot.agentHome,
    sessionRoot: config.piAgentHome,
    managedGenerationsRoot: generationsRoot,
    recoverManagedGenerationsOnInitialize: backendInstances.adapter(piBackendId) === undefined,
    ...(config.piExecutable === undefined ? {} : { command: config.piExecutable }),
    processFactory: remotePiProcesses.create,
    managedDurableStoreRegistry: remotePiProcesses,
    onManagedSubagentLineageRemoved: (input) => mcpRouter.revokeNativeAuthSession(input),
    processSupervisor: createDefaultPiManagedProcessSupervisor(),
    validateRemoteWorkspace: async (target, signal) => {
      const binding = target.remoteWorkspace;
      if (binding === undefined) throw new Error("Remote workspace binding is missing.");
      await remotePiProcesses.validate(binding.hostTargetId, binding.hostId, binding.workspaceRoot, signal);
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
    resolveTargetResources: (context) => piResources.targetRuntimeSnapshot("pi", context.target.id),
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
          return createCodexAdapter({
            id: instanceId,
            instanceGeneration: generation,
            localMcpBridge: (input) => mcpBridge!.openLocal(input),
            remoteRuntimes: new RemoteCodexRuntimeResolver({
              store,
              registry: remoteHosts,
              mcpBridge
            }),
            resolveNativeMemoryEnabled: () => makerMemory.nativeEnabledForBackend(instanceId, false),
            managedProviders,
            smartRouting,
            profileDirectory: codexHome,
            appServer: {
              transport: {
                ...(config.codexExecutable === undefined ? {} : { command: config.codexExecutable }),
                processOwner: {
                  rootDirectory: join(config.dataDirectory, "backend-runtime", instanceId),
                  instanceId,
                  generation,
                  recoverStale: backendInstances.adapter(instanceId) === undefined,
                  supervisor: createDefaultPiManagedProcessSupervisor()
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
          registry: remoteHosts
        }),
        managedProviders: managedRuntime(instanceId, generation, CLAUDE_MANAGED_PROVIDER_SUPPORT),
        credentialPort: claudeCodeCredentialPort,
        resolveSubagentModel: (providerId) => subagentModels.resolve(instanceId, providerId),
        resolveNativeMemoryEnabled: () => makerMemory.nativeEnabledForBackend(instanceId),
        oauthFetch: claudeCodeOAuthFetch,
        readBlob: (blob) => artifacts.readBlob(blob),
        resolveFile: (blob) => artifacts.resolveBlobPath(blob),
        resolveTextResources: (context, signal) => piResources.runtimeTextSnapshot(
          instanceId,
          context.target.id,
          signal
        ),
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
          supervisor: createDefaultPiManagedProcessSupervisor()
        },
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
  const piCandidate = backendInstances.adapter(piBackendId);
  if (piCandidate === undefined) {
    const unavailable = new Error("The required Pi Backend instance is unavailable.");
    const cleanupErrors: unknown[] = [];
    try { await backendInstances.dispose(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    try { await managedProviderProxy.close(); } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [unavailable, ...cleanupErrors],
        "The required Pi Backend is unavailable and cleanup remained incomplete."
      );
    }
    throw unavailable;
  }
  let startupSessionHost: SessionHost | undefined;
  let startupSessionWorktrees: SessionWorktreeCoordinator | undefined;
  let startupCleanupHandled = false;
  let startupBackendCleanup: Promise<readonly unknown[]> | undefined;
  const cleanupStartupBackendOwners = (): Promise<readonly unknown[]> => {
    if (startupBackendCleanup !== undefined) return startupBackendCleanup;
    startupBackendCleanup = (async () => {
      const failures: unknown[] = [];
      const attempt = async (cleanup: () => unknown): Promise<void> => {
        try { await cleanup(); } catch (error) { failures.push(error); }
      };
      await attempt(() => terminals.dispose());
      if (startupSessionHost === undefined) {
        await attempt(() => backendInstances.dispose());
      } else {
        await attempt(() => startupSessionHost!.dispose());
        await attempt(() => backendInstances.disposeRetainedCandidateCleanups());
      }
      await attempt(() => managedProviderProxy.close());
      return failures;
    })();
    return startupBackendCleanup;
  };
  let closed = false;
  try {
  const currentPi = (): ReturnType<typeof createPiAdapter> => {
    const current = backendInstances.adapter(piBackendId);
    if (current === undefined) throw new Error("The required Pi Backend instance is unavailable.");
    return current as ReturnType<typeof createPiAdapter>;
  };
  const initialAdapters: readonly BackendAdapter[] = backendInstances.availableAdapters();
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
    storageRoot: join(config.dataDirectory, "worktrees")
  });
  const workspaceCapture = new DurableWorkspaceRunCapture(store, workspaceChanges, workspaces, gitSafety);
  let androidRuntimeForSessionCleanup: AndroidRuntimeSupervisor | undefined;
  let computerBridgeForSessionCleanup: ComputerToolBridgeProvider | undefined;
  let messaging: MessagingManager | undefined;
  const configuredProviderRouteEnabled = (backendId: string, providerId: string): boolean => {
    const backend = store.getBackend(backendId).descriptor;
    if (backend.capabilities.get(MANAGED_PROVIDER_CATALOG_CAPABILITY)?.supported !== true) return true;
    return providers.list(backendId).find((provider) => provider.provider.id === providerId)?.enabled !== false;
  };
  const sessionHost = startupSessionHost = new SessionHost(store, artifacts, initialAdapters, {
    backendDescriptors: backendInstances.descriptors(),
    backendDescriptorsAlreadyPublished: true,
    workspaceCapture,
    freezeToolPolicies: (sessionId, targetId) => { toolPolicies.freezeSession(sessionId, targetId); },
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
      && configuredProviderRouteEnabled(backendId, providerId),
    modelAccessRestricted: (backendId) => backendModelAccessRestricted(store, backendId)
      || (
        store.getBackend(backendId).descriptor.capabilities.get("provider.managed_catalog")?.supported === true
        && providers.list(backendId).some((provider) => !provider.enabled)
      ),
    sessionRuntimeFallbackEnabled: () => configuredSessionRuntimeFallback(store),
    serviceSessionRuntimeFallback: (input) => partnerSessionRuntimeFallback(partnerStore, input),
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
      androidRuntimeForSessionCleanup?.closeSession(sessionId);
      void computerBridgeForSessionCleanup?.closeSession(sessionId).catch(() => undefined);
    },
    onServiceRunSettled: (input) => messaging?.onRunSettled(input),
    onServiceInteractionOpened: (input) => messaging?.onInteractionOpened(input),
    onServiceInteractionSettled: (input) => messaging?.onInteractionSettled(input),
    closeSessionTerminals: (sessionId) => terminals.closeSession(sessionId)
  });
  await simulatorCreate?.recoverPending();
  await simulatorControl?.reconcileDetachedGrace();
  await simulatorControl?.reconcileAbandoned();
  simulatorControl?.startRecoverySweep();
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
  const partners = new PartnerManager({
    store: partnerStore,
    operationalStore: store,
    sessionHost,
    workspaceService: workspaces,
    homesRoot: join(config.dataDirectory, "partner-homes")
  });
  const collaborationGoals = new CollaborationGoalManager({
    store,
    sessionHost,
    readSettings: () => runtimeGovernance.collaboration()
  });
  const unregisterCollaborationGoalTools = mcpRouter.registerBridgeToolProvider(
    new CollaborationToolBridgeProvider({ store, manager: collaborationGoals })
  );
  const unregisterPartnerTools = mcpRouter.registerBridgeToolProvider(
    new PartnerToolBridgeProvider({ store, partners })
  );
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
  const restartBackend = async (backendId: string): Promise<void> => {
    await runBackendLifecycle(async () => {
      const previous = backendInstances.get(backendId);
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
  const historyMaintenance = new HistoryMaintenance({
    store,
    activeSessions: {
      prepare: (sessionIds) => sessionHost.prepareHistoryMaintenanceBindings(sessionIds),
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
  const diagnosticsBundles = new DiagnosticsBundleService({
    store,
    artifacts,
    credentials,
    serviceVersion: "0.1.0"
  });
  const messageSearch = new MessageSearchEmbeddingCoordinator({ store, providers });
  messageSearchForHelperTools = messageSearch;
  const auxiliaryText = new AuxiliaryTextRouting({ store, routes: modelRoutes, providers });
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
      await refreshPiAdapterGeneration(currentPi(), true);
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
    onModelsChanged: refreshPiGeneration
  });

  const runMaintenance = (): Promise<void> => {
    const maintenance = maintenanceTail.catch(() => undefined).then(async () => {
      if (closed) return;
      const now = Date.now();
      store.expireToolLeases(now);
      store.prunePairings({
        expiredBefore: now,
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
        remote: { targetId: configuredTarget.descriptor.id, hostTargetId: configuredBinding.hostTargetId, hostId: configuredBinding.hostId, workspaceRoot: configuredBinding.workspaceRoot }
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
            remote: {
              targetId: storedTarget.descriptor.id,
              hostTargetId: binding.hostTargetId,
              hostId: binding.hostId,
              workspaceRoot: binding.workspaceRoot
            }
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
    await sessionHost.initialize();
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
          refresh: async ({ previous, next }) => {
            if (previous.automationTarget === next.automationTarget) return;
            browserSettings?.setBackendHealth({ active: false, status: "recovering", canRecover: false });
            const wasRunning = configuredBrowser.running;
            configuredTransfers.fenceBeforeGeneration(configuredBrowser.generation + 1);
            await configuredBrowser.stop();
            await configuredBrowser.setTargetMode(next.automationTarget);
            if (!wasRunning) return;
            try {
              await configuredBrowser.start();
              await refreshPiGeneration();
              browserSettings?.setBackendHealth({ active: true, status: "ready", canRecover: true });
            } catch (error) {
              await configuredBrowser.stop().catch(() => undefined);
              await configuredBrowser.setTargetMode(previous.automationTarget).catch(() => undefined);
              await configuredBrowser.start().catch(() => undefined);
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
        userKnowledge
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
    mobilePush.start();
    scheduler.start();
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
    await attempt(() => deferredBackendRestarts?.dispose());
    await attempt(() => commandConcurrencyGate.close());
    await attempt(() => stopExtensionLibraryAuthorityNotifications());
    await attempt(() => skillMarketSync.close());
    await attempt(() => skillPublication.close());
    await attempt(() => skills.close());
    await attempt(() => skillMarket.close());
    await attempt(() => extensionLibraries.close());
    await attempt(() => extensionMainViews.close());
    await attempt(() => extensionPackagePublisher.close());
    await attempt(() => scheduler.stop());
    await attempt(() => mobilePush.close());
    await attempt(() => providerAuth.beginShutdown());
    await attempt(() => providerAccountUsage.invalidate());
    await attempt(() => managedModelRuntimeSystem.close());
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
    await attempt(() => unregisterLspBridge());
    await attempt(() => unregisterRemoteHostTools());
    await attempt(() => unregisterDocumentTools());
    await attempt(() => unregisterIosSimulatorTools());
    await attempt(() => simulatorRecording?.close());
    await attempt(() => lspBridge.dispose());
    await attempt(() => unregisterSchedulerBridgeTools());
    await attempt(() => unregisterVisionBridgeTools());
    await attempt(() => unregisterMakerMemoryBridge());
    await attempt(() => { if (maintenanceTimer !== undefined) clearInterval(maintenanceTimer); });
    await attempt(() => maintenanceTail);
    await attempt(() => messageSearch.stop());
    await attempt(() => sessionNavigation.dispose());
    await attempt(() => auxiliaryText.dispose());
    await attempt(() => mcpRouter.dispose());
    await attempt(() => voiceInput.close());
    await attempt(() => sshKeys.close());
    await attempt(() => remoteBackendRuntimeSetup.close());
    await attempt(() => remoteHosts.close());
    await attempt(() => runtimeActivity.close());
    await attempt(() => contactSync.close());
    await attempt(() => contacts.close());
    await attempt(() => contactStore.close());
    await attempt(() => partnerStore.close());
    await attempt(() => store.close());
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "Orchestrator startup failed and cleanup remained incomplete."
      );
    }
    throw error;
  }

  return {
    config,
    store,
    connections,
    serverId,
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
    reviewCoordinator,
    remoteHosts,
    remoteBackendRuntimeSetup,
    sshKeys,
    terminals,
    simulatorViewer,
    voiceInput,
    voiceInputSettings,
    mobilePush,
    get adapters() {
      return backendInstances.availableAdapters();
    },
    restartBackend,
    refreshBackendDescriptor,
    holdSubagentSmartRoutingDispatch: (backendId) => deferredBackendRestarts!.request(backendId),
    refreshSubagentSmartRouting,
    credentials,
    providers,
    managedModelRuntime: managedModelRuntimeSystem.controller,
    mcpRouter,
    piResources,
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
    contacts,
    contactSync,
    partners,
    extensionCatalog,
    extensionLibraries,
    extensionMainViews,
    extensionPackagePublisher,
    extensionSources,
    diagnosticsBundles,
    providerAuth,
    providerAccountUsage,
    messageSearch,
    makerMemory,
    visionBridge,
    promptPrediction,
    auxiliaryText,
    subagentModels,
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
        await attempt(() => commandConcurrencyGate.close());
        await attempt(() => stopExtensionLibraryAuthorityNotifications());
        await attempt(() => skillMarketSync.close());
        await attempt(() => skillPublication.close());
        await attempt(() => skills.close());
        await attempt(() => skillMarket.close());
        await attempt(() => extensionLibraries.close());
        await attempt(() => extensionMainViews.close());
        await attempt(() => extensionPackagePublisher.close());
        if (maintenanceTimer !== undefined) clearInterval(maintenanceTimer);
        await attempt(() => scheduler.stop());
        await attempt(() => mobilePush.close());
        await attempt(() => sessionNavigation.dispose());
        await attempt(() => auxiliaryText.dispose());
        await attempt(() => providerAuth.beginShutdown());
        await attempt(() => providerAccountUsage.invalidate());
        await attempt(() => managedModelRuntimeSystem.close());
        await attempt(() => collaborationGoals.close());
        await attempt(() => messaging.close());
        await refreshTail.catch(() => undefined);
        await backendLifecycleTail.catch(() => undefined);
        // Keep the remote transports alive while terminals attempt confirmed process cleanup.
        await attempt(() => terminals.dispose());
        await attempt(() => sessionHost.dispose());
        await attempt(() => backendInstances.disposeRetainedCandidateCleanups());
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
        await attempt(() => unregisterLspBridge());
        await attempt(() => unregisterRemoteHostTools());
        await attempt(() => unregisterDocumentTools());
        await attempt(() => unregisterIosSimulatorTools());
        await attempt(() => simulatorMutations.close());
        await attempt(() => simulatorRecording?.close());
        simulatorControl?.dispose();
        await attempt(() => lspBridge.dispose());
        await attempt(() => unregisterSchedulerBridgeTools());
        await attempt(() => unregisterVisionBridgeTools());
        await attempt(() => unregisterMakerMemoryBridge());
        await maintenanceTail.catch(() => undefined);
        await attempt(() => messageSearch.stop());
        await attempt(() => mcpRouter.dispose());
        await attempt(() => voiceInput.close());
        sshKeys.close();
        await attempt(() => remoteBackendRuntimeSetup.close());
        await attempt(() => remoteHosts.close());
        await attempt(() => workspaces.close());
        await attempt(() => runtimeActivity.close());
        await attempt(() => contactSync.close());
        await attempt(() => contacts.close());
        await attempt(() => contactStore.close());
        await attempt(() => partnerStore.close());
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
    await attempt(() => deferredBackendRestarts?.dispose());
    await attempt(() => commandConcurrencyGate.close());
    await attempt(() => stopExtensionLibraryAuthorityNotifications());
    await attempt(() => simulatorControl?.dispose());
    await attempt(() => providerAuth.beginShutdown());
    await attempt(() => providerAccountUsage.invalidate());
    cleanupErrors.push(...await cleanupStartupBackendOwners());
    await attempt(() => startupSessionWorktrees?.dispose());
    await attempt(() => generationGcTail.catch(() => undefined));
    await attempt(() => providerAuth.close());
    await attempt(() => mcpRouter.dispose());
    await attempt(() => voiceInput.close());
    await attempt(() => remoteBackendRuntimeSetup.close());
    await attempt(() => remoteHosts.close());
    await attempt(() => mobilePush.close());
    await attempt(() => skillMarketSync.close());
    await attempt(() => skillPublication.close());
    await attempt(() => skills.close());
    await attempt(() => skillMarket.close());
    await attempt(() => extensionLibraries.close());
    await attempt(() => extensionMainViews.close());
    await attempt(() => extensionPackagePublisher.close());
    await attempt(() => sshKeys.close());
    await attempt(() => runtimeActivity.close());
    await attempt(() => contactSync.close());
    await attempt(() => contacts.close());
    await attempt(() => contactStore.close());
    await attempt(() => partnerStore.close());
    await attempt(() => store.close());
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "Orchestrator initialization failed and cleanup remained incomplete."
      );
    }
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
