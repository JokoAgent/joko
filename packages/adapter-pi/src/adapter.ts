import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  CAPABILITIES,
  evaluateOrderedPolicyRules,
  NATIVE_HISTORY_REPLACES_TRANSIENT_FIELD,
  redactSecrets,
  type ApprovedDirectory,
  type AdapterContext,
  type AdapterEventMetadata,
  type BackendAdapter,
  type BackendDescriptor,
  type BackendToolDescriptor,
  type BlobRef,
  type Capability,
  type ContextRebuildInput,
  type CreateNativeSessionInput,
  type DurableNativeDispatchPreparation,
  type NativeSessionBinding,
  type NativeSessionCandidate,
  type NativeSessionForkResult,
  type NativeHistoryProjection,
  type ImportPortableNativeSessionInput,
  type NativeSessionState,
  type KnownCapability,
  type PermissionMode,
  type PiEventMetadata,
  type PortableNativeSession,
  type PromptInput,
  type ProviderModel,
  type RuntimeCommand,
  type RuntimeProcessUsageSnapshot,
  type RuntimeResource,
  type SessionTree,
  type SessionTreeNode,
  type SubagentControlInput,
  type TargetDescriptor,
  type TerminateRuntimeProcessInput,
  type UserShellInput,
  type UserShellResult,
  type UsageSnapshot
} from "@joko/core";
import {
  DEFAULT_AGENT_RESOURCE_SETTINGS,
  DEFAULT_COLLABORATION_SETTINGS,
  applyNewProcessPriority,
  toolchainThreadEnvironment,
  validateAgentResourceSettings,
  validateCollaborationSettings,
  type AgentResourceSettings,
  type CollaborationSettings,
  type CommandConcurrencyGate,
  type ManagedProcessPriority,
  type ProcessPriorityResult
} from "@joko/runtime-governance";
import { provisionManagedBridge } from "./bridge.js";
import { handleCommandGateExtensionRequest } from "./command-gate-bridge.js";
import {
  handlePolicyDecisionExtensionRequest,
  type PolicyDecisionRequest,
  type PolicyDecisionResult
} from "./policy-decision-bridge.js";
import { isPiCompactionNoopRejection } from "./compaction.js";
import {
  assertCompatibleState,
  assertManagedBridgeHandshake,
  canonicalPiExecutableIdentity,
  probePiExecutable,
  type PiCompatibilityReport,
  type PiOptionalProbeCommand
} from "./compatibility-probe.js";
import {
  atomicWriteFile,
  atomicWriteJson,
  canonicalPiThinkingLevels,
  PI_AUTO_COMPACTION_THRESHOLD_PERCENT_DEFAULT,
  PI_AUTO_COMPACTION_THRESHOLD_PERCENT_MAXIMUM,
  PI_AUTO_COMPACTION_THRESHOLD_PERCENT_MINIMUM,
  provisionManagedCatalog,
  piModelOutputTokenLimit,
  supportedPiThinkingLevels,
  writeMcpDescriptor,
  writeRuntimeControl,
  type ManagedCatalogResult,
  type PiManagedProvider,
  type PiManagedSettings,
  type PiMcpToolDescriptor,
  type PiRuntimeControl
} from "./config.js";
import { asPiError, PiAdapterError, piError, redactManagedSecrets, redactedDiagnostic } from "./errors.js";
import {
  managedSubagentRunRoot,
  managedSubagentSessionKey,
  MANAGED_SUBAGENT_NODE_ENV,
  MANAGED_SUBAGENT_RUN_ROOT_ENV,
  reconcileManagedSubagentAuthHomes,
  stopAndRemoveManagedSubagentRuns
} from "./durable-subagent-runs.js";
import { handleExtensionUiRequest } from "./interactions.js";
import {
  assertManagedSubagentControlTarget,
  ManagedSubagentObserver,
  removeManagedSubagentObservationJournal,
  writeManagedSubagentDurableControl
} from "./managed-subagent-observer.js";
import type { PiManagedDurableStore, PiManagedDurableStoreRegistry } from "./managed-durable-store.js";
import { MANAGED_SUBAGENT_TOOL_DESCRIPTORS, provisionManagedSubagent } from "./managed-subagent.js";
import {
  MANAGED_SUBAGENT_CONTROL_COMMAND_NAME,
  MANAGED_SUBAGENT_PRODUCT_SESSION_ENV
} from "./managed-subagent-source.js";
import { isExtensionUiRequest, isRecord, type PiRpcCommand, type PiRpcCommandDescriptor, type PiRpcEntry, type PiRpcEvent, type PiRpcModel, type PiRpcState, type PiRpcTreeNode } from "./protocol.js";
import {
  nativeDispatchFingerprintForUserMessage,
  projectPiNativeHistory,
  type PiNativeHistoryEntry
} from "./native-history.js";
import {
  snapshotApprovedProjectResources,
  snapshotManagedRuntimeResources,
  type PiManagedRuntimeResourceSnapshot,
  type ProjectSkillCandidate
} from "./resources.js";
import { PiSessionStore, type PiExternalSessionSource } from "./session-store.js";
import { projectPiNativeState } from "./state-projection.js";
import {
  provisionManagedSilentEncryptedRetry,
  SILENT_ENCRYPTED_RETRY_CONTROL_ENV,
  SILENT_ENCRYPTED_RETRY_DEFAULT_ENABLED,
  writeSilentEncryptedRetryControl
} from "./silent-encrypted-retry.js";
import { loadPiBuiltInToolCatalog } from "./tool-catalog.js";
import {
  PiRuntimeToolCatalogAssembler,
  type PiRuntimeToolCatalog,
  type PiRuntimeToolDescriptor
} from "./runtime-tool-catalog.js";
import { PiRpcTransport, spawnPiProcess, type PiProcessFactory, type PiProcessSpec } from "./transport.js";
import { PiEventTranslator } from "./translator.js";
import {
  createDefaultPiManagedProcessSupervisor,
  type PiManagedProcessSupervisor
} from "./runtime-process.js";

const execFileAsync = promisify(execFile);
type PiCompatibilityOutcome =
  | { readonly status: "compatible"; readonly report: PiCompatibilityReport }
  | { readonly status: "incompatible"; readonly diagnostic: string; readonly cause: unknown };
const DEFAULT_EXECUTABLE_COMPATIBILITY_CACHE = new Map<string, Promise<PiCompatibilityOutcome>>();
const INLINE_USER_SHELL_OUTPUT_LIMIT = 256 * 1024;
const MAXIMUM_PI_TREE_PREVIEW_CHARACTERS = 200;
const PI_STANDARD_RPC_TIMEOUT_MS = 30_000;
/** Prompt preflight, compaction, and branch changes may each include one full
 * provider summarization pass, so those operations receive a ten-minute
 * silent-response window. */
const PI_LONG_RUNNING_RPC_TIMEOUT_MS = 10 * 60_000;
/** Pi's native Bash timeout is capped at thirty minutes. Keep RPC ownership
 * for the same bounded interval and refresh it only on native Bash progress. */
const PI_USER_SHELL_RPC_TIMEOUT_MS = 30 * 60_000;
const BUNDLED_PI_CLI = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");
const EXTERNAL_SESSION_REFERENCE_PREFIX = "pi-external-session:";
const DEFAULT_APPEND_SYSTEM_PROMPT =
  "You are running inside Joko. Preserve Pi's native coding behavior. Treat Orchestrator interactions, workspace boundaries, and explicit permission decisions as authoritative host controls. " +
  "Use the dedicated grep tool for content search, the find tool for file discovery, the ls tool for directory listings, and the read tool for examining files. " +
  "Use Bash for Git, builds, tests, package managers, and shell operations not covered by a dedicated tool. After locating a target, read only the relevant range when practical.";
const ASK_USER_QUESTION_TOOL: BackendToolDescriptor = {
  toolId: "ask_user_question",
  name: "ask_user_question",
  displayName: "Ask user question",
  description: "Ask the user one or more typed questions and wait for answers or explicit skips.",
  inputSchema: {
    allowsAdditionalFields: false,
    fields: [
      {
        fieldPath: "questions",
        title: "Questions",
        description: "One to eight questions for the user.",
        type: "array",
        required: true,
        secret: false,
        enumValues: [],
        constraints: { minimumLength: 1, maximumLength: 8, itemFieldPath: "questions[]" }
      },
      { fieldPath: "questions[]", title: "Question", description: "A typed question.", type: "object", required: true, secret: false, enumValues: [] },
      { fieldPath: "questions[].question", title: "Question", description: "The question text.", type: "string", required: true, secret: false, enumValues: [] },
      { fieldPath: "questions[].header", title: "Header", description: "A short field label.", type: "string", required: false, secret: false, enumValues: [] },
      { fieldPath: "questions[].options", title: "Options", description: "Optional single- or multi-select choices.", type: "array", required: false, secret: false, enumValues: [], constraints: { itemFieldPath: "questions[].options[]" } },
      { fieldPath: "questions[].multiSelect", title: "Multiple selections", description: "Allow more than one option.", type: "boolean", required: false, secret: false, enumValues: [] }
    ]
  },
  requiresPermission: false,
  streamingUpdates: false,
  enabled: true
};

export interface PiResolvedImage {
  readonly data: Uint8Array;
  readonly mimeType?: string;
}

/** Host-owned Vision Bridge. The Adapter supplies only public model identity
 * and BlobRefs; Provider credentials remain in Orchestrator. */
export interface PiVisionBridgeTransform {
  (input: {
    readonly backendId: string;
    readonly providerId: string;
    readonly modelId: string;
    readonly text: string;
    readonly images: PromptInput["images"];
    readonly signal?: AbortSignal;
    readonly onStart?: (imageCount: number) => void | Promise<void>;
  }): Promise<{
    readonly descriptions: readonly string[];
    readonly usedFallback: boolean;
    readonly unavailableCount: number;
  } | undefined>;
}

export interface PiMcpBridgeOptions {
  readonly endpoint: string;
  readonly token: string;
  readonly tools: readonly PiMcpToolDescriptor[];
  /** One-shot, model-invisible authority for registering an exact managed runner key. */
  readonly nativeAuthReservationToken?: string;
  /** Host-owned, generation-fenced lease channel for Pi-native credentials. */
  readonly nativeAuthLease?: {
    readonly endpoint: string;
    readonly catalogGeneration: number;
    readonly providerIds: readonly string[];
    readonly authenticatedProviderIds: readonly string[];
  };
}

export interface PiNativeOAuthCredential {
  readonly type: "oauth";
  readonly access: string;
  readonly refresh: string;
  readonly expires: number;
  readonly [key: string]: unknown;
}

export interface PiNativeApiKeyCredential {
  readonly type: "api_key";
  readonly key?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export type PiNativeCredential = PiNativeOAuthCredential | PiNativeApiKeyCredential;

export interface PiNativeAuthSnapshot {
  readonly catalogGeneration: number;
  readonly credentials: Readonly<Record<string, PiNativeCredential>>;
}

export type PiLoadNativeAuth = (input: {
  readonly providerIds: readonly string[];
  readonly expectedCatalogGeneration: number;
}) => PiNativeAuthSnapshot;

export type PiPersistNativeAuth = (input: {
  readonly providerId: string;
  readonly credential: unknown;
  readonly expectedCatalogGeneration: number;
}) => Promise<{
  readonly catalogGeneration: number;
  readonly credentialReferenceId: string;
  readonly expiresAt?: number;
}>;

export interface PiAdapterOptions {
  readonly agentHome: string;
  /** Service-owned parent containing every immutable Agent Home generation. */
  readonly managedGenerationsRoot?: string;
  /**
   * Cold-start owner recovery for sibling managed generations. A hot
   * replacement candidate sets this false because the current Adapter still
   * owns those live processes until the Orchestrator replacement fence closes
   * them.
   */
  readonly recoverManagedGenerationsOnInitialize?: boolean;
  /** Stable service-owned root containing `sessions/` and `trash/sessions/`. */
  readonly sessionRoot: string;
  /**
   * Read-only upstream Pi history roots offered for explicit import. Omission
   * discovers the standard user-level `~/.pi/agent/sessions`; an empty list
   * disables external discovery without changing managed persistence.
   */
  readonly externalSessionRoots?: readonly string[];
  readonly command?: string;
  readonly commandArgs?: readonly string[];
  readonly providers?: readonly PiManagedProvider[];
  readonly settings?: PiManagedSettings;
  /** Host-owned recovery for invalid Responses reasoning ciphertext. */
  readonly silentEncryptedRetryEnabled?: boolean;
  readonly environment?: Readonly<Record<string, string>>;
  readonly secretEnvironmentNames?: readonly string[];
  readonly appendSystemPrompt?: string;
  /** Service-owned private Maker Memory prompt snapshot resolved for this Target at runtime start. */
  readonly resolveMakerMemoryPrompt?: (context: AdapterContext) => string | undefined;
  /** Captured once per runtime; active runtimes do not hot-change this setting. */
  readonly isCompactionMemoryEnabled?: (context: AdapterContext) => boolean;
  /** Best-effort private sink; implementations must not log or event the summary. */
  readonly onCompactionDigest?: (input: {
    readonly backendId: string;
    readonly targetId: string;
    readonly sessionId: string;
    readonly summary: string;
    readonly reason: string;
  }) => void | Promise<void>;
  readonly requestTimeoutMs?: number;
  readonly startupTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  /**
   * Optional hard JSONL parser ceiling. When omitted, the transport keeps the
   * normal bounded budget, expands for user-message wire data this runtime
   * dispatches, and uses the platform ceiling for Pi's non-paginated native
   * history collections.
   */
  readonly maxRecordBytes?: number;
  readonly processFactory?: PiProcessFactory;
  /** Host-owned validation for capability-neutral Remote workspaces. */
  readonly validateRemoteWorkspace?: (target: TargetDescriptor, signal?: AbortSignal) => Promise<void>;
  /** OS process birth-identity supervisor. Custom process factories opt in explicitly. */
  readonly processSupervisor?: PiManagedProcessSupervisor;
  /** Service-node global command gate shared by every local Session runtime. */
  readonly commandConcurrencyGate?: CommandConcurrencyGate;
  /** Hot read for local spawn and command admission policy. */
  readonly readAgentResourceSettings?: () => AgentResourceSettings;
  /** Hot read sampled when a local Session runtime is started. */
  readonly readCollaborationSettings?: () => CollaborationSettings;
  /** Session-frozen availability for the service-owned collaboration tools. */
  readonly includeManagedSubagentTools?: (context: AdapterContext) => boolean;
  /** Host-owned remote durable-run control plane. Local Targets never use it. */
  readonly managedDurableStoreRegistry?: PiManagedDurableStoreRegistry;
  /** Revokes only detached native-auth recovery after every owned runner is terminal. */
  readonly onManagedSubagentLineageRemoved?: (input: {
    readonly sessionId: string;
    readonly targetId: string;
  }) => Promise<void>;
  /** Testable spawn-boundary priority application. */
  readonly applyProcessPriority?: (pid: number, priority: ManagedProcessPriority) => Promise<ProcessPriorityResult>;
  /** Credential-free result sink; it must not include a command line or path. */
  readonly onProcessPriorityResult?: (input: {
    readonly sessionId: string;
    readonly generation: number;
    readonly result: ProcessPriorityResult;
  }) => void;
  /** Notifies the owning SessionHost only when a runtime exits unexpectedly. */
  readonly onUnexpectedRuntimeExit?: (sessionId: string, generation: number) => void;
  readonly versionProbe?: () => Promise<string>;
  readonly readBlob?: (blob: BlobRef) => Promise<PiResolvedImage>;
  readonly visionBridge?: PiVisionBridgeTransform;
  readonly resolveFile?: (blob: BlobRef, context: AdapterContext) => Promise<string>;
  readonly approveProjectSkill?: (candidate: ProjectSkillCandidate) => boolean | Promise<boolean>;
  readonly projectResourceMaxFiles?: number;
  readonly projectResourceMaxBytes?: number;
  readonly managedResourceMaxFiles?: number;
  readonly managedResourceMaxBytes?: number;
  readonly managedResources?: PiManagedRuntimeResourceSnapshot;
  /**
   * Resolves the host-approved resources owned by the current Target. The
   * callback is invoked only while spawning a trusted Target runtime; ambient
   * filesystem discovery is never used as a substitute.
   */
  readonly resolveTargetResources?: (context: AdapterContext) => PiManagedRuntimeResourceSnapshot | Promise<PiManagedRuntimeResourceSnapshot>;
  readonly mcpBridge?: PiMcpBridgeOptions;
  /** Target-scoped immutable bridge snapshot sampled exactly once at runtime spawn. */
  readonly resolveMcpBridge?: (context: AdapterContext) => PiMcpBridgeOptions | undefined | Promise<PiMcpBridgeOptions | undefined>;
  /** Orchestrator-owned capabilities composed around Pi (workspace, tools, and similar host services). */
  readonly hostCapabilities?: readonly KnownCapability[];
  /** Host-owned tool providers bridged into this generation. */
  readonly hostToolCapabilities?: readonly Extract<KnownCapability, `tool.${string}`>[];
  /** Provider catalog generation fenced to the immutable managed snapshot. */
  readonly catalogGeneration?: number;
  /** Built-in Pi auth Provider IDs that intentionally do not enter models.json. */
  readonly nativeAuthProviderIds?: readonly string[];
  /** Non-secret subset of nativeAuthProviderIds with a currently usable credential. */
  readonly nativeAuthenticatedProviderIds?: readonly string[];
  /** Built-in Pi models projected by the owning ModelRuntime; never written to managed models.json. */
  readonly nativeModels?: readonly ProviderModel[];
  /** Loads complete native credential objects from the in-memory sealed-vault join. */
  readonly loadNativeAuth?: PiLoadNativeAuth;
  /** Optional CAS write-back for native credential objects changed by Pi. */
  readonly persistNativeAuth?: PiPersistNativeAuth;
  /** Called once this immutable configuration has retired and has no runtimes. */
  readonly releaseManagedGeneration?: () => void;
}

/** Complete replacement of all generation-scoped managed Pi configuration. */
export interface PiManagedGenerationOptions {
  readonly agentHome: string;
  readonly providers?: readonly PiManagedProvider[];
  readonly settings?: PiManagedSettings;
  readonly silentEncryptedRetryEnabled?: boolean;
  readonly environment?: Readonly<Record<string, string>>;
  readonly secretEnvironmentNames?: readonly string[];
  readonly appendSystemPrompt?: string;
  readonly managedResources?: PiManagedRuntimeResourceSnapshot;
  readonly mcpBridge?: PiMcpBridgeOptions;
  readonly resolveMcpBridge?: (context: AdapterContext) => PiMcpBridgeOptions | undefined | Promise<PiMcpBridgeOptions | undefined>;
  readonly catalogGeneration?: number;
  readonly nativeAuthProviderIds?: readonly string[];
  readonly nativeAuthenticatedProviderIds?: readonly string[];
  readonly nativeModels?: readonly ProviderModel[];
  readonly loadNativeAuth?: PiLoadNativeAuth;
  readonly persistNativeAuth?: PiPersistNativeAuth;
  /** Called once this immutable configuration has retired and has no runtimes. */
  readonly releaseManagedGeneration?: () => void;
}

interface SessionSpawnProfile {
  readonly providerId?: string;
  readonly modelId?: string;
  readonly effort?: string;
  readonly appendSystemPrompt?: string;
  readonly initialPermissionMode: PermissionMode;
  readonly initialPlanMode: boolean;
  readonly initialFastMode: boolean;
  readonly runtimePolicy: "standard" | "review_read_only";
}

function restoredSpawnProfile(context: AdapterContext): SessionSpawnProfile {
  return {
    ...(context.appendSystemPrompt === undefined ? {} : { appendSystemPrompt: context.appendSystemPrompt }),
    initialPermissionMode: "ask",
    initialPlanMode: false,
    initialFastMode: false,
    runtimePolicy: context.runtimePolicy ?? "standard"
  };
}

interface PiRuntime {
  readonly key: string;
  readonly transport: PiRpcTransport;
  /** OS identity never crosses the Adapter boundary. */
  readonly processIdentity?: string;
  /** Random display/action fence safe to expose through the public contract. */
  readonly processInstanceId?: string;
  /** Immutable CLI extension identity used to authenticate product-control commands. */
  readonly bridgePath: string;
  /** Immutable managed background-task extension identity. */
  readonly subagentPath: string;
  readonly managedSubagentToolsEnabled: boolean;
  readonly managedDurableStore?: PiManagedDurableStore;
  readonly runtimeDirectory: string;
  readonly runtimeRoot: string;
  readonly nativeAuth?: PiRuntimeNativeAuth;
  readonly controlPath: string;
  readonly silentEncryptedRetryControlPath: string;
  readonly artifactDirectory: string;
  readonly redactValues: readonly string[];
  readonly resources: readonly RuntimeResource[];
  readonly generationLease: PiManagedGenerationLease;
  translator: PiEventTranslator;
  context: AdapterContext;
  binding: NativeSessionBinding;
  control: PiRuntimeControl;
  /** Pi RPC does not expose this toggle in get_state, so the Adapter owns it. */
  autoRetry: boolean;
  /** Relative product setting enforced against the active model's context window. */
  autoCompaction: boolean;
  readonly compactionMemoryEnabled: boolean;
  autoCompactionThresholdPercent: number;
  thresholdCheck?: Promise<void>;
  thresholdCompaction?: { readonly id: string };
  ready: boolean;
  abortRequested: boolean;
  lifecycle?: PiNativeLifecycle;
  runningExtensionCommand?: PiRunningExtensionCommand;
  userShell?: PiUserShellLifecycle;
  readonly toolCatalogAssembler: PiRuntimeToolCatalogAssembler;
  toolCatalog?: PiRuntimeToolCatalog;
  toolCatalogUnavailableReason?: "capture_failed" | "catalog_too_large";
  /**
   * Pi mutates one native Session behind every prompt/control RPC. Keep the
   * acceptance boundaries ordered even when two clients act concurrently;
   * a rejected operation must never poison later work.
   */
  sessionMutationTail: Promise<void>;
  eventChain: Promise<void>;
  cleanup?: Promise<void>;
}

interface PiNativeLifecycleParticipant {
  readonly context: AdapterContext;
  readonly disposition: "prompt" | "steer" | "follow_up";
  readonly message: string;
}

interface PiNativeLifecycle {
  readonly owner: PiNativeLifecycleParticipant;
  readonly participants: PiNativeLifecycleParticipant[];
  readonly pendingSteering: PiNativeLifecycleParticipant[];
  readonly pendingFollowUps: PiNativeLifecycleParticipant[];
  currentContext: AdapterContext;
  initialUserMessageSeen: boolean;
  agentStarted: boolean;
  settlementReceived: boolean;
}

interface PiRuntimeNativeAuth {
  readonly agentHome: string;
  readonly providerIds: readonly string[];
  readonly expectedCatalogGeneration: number;
  readonly initialDigests: ReadonlyMap<string, string>;
  readonly persist?: PiPersistNativeAuth;
}

interface PreparedRuntimeAgentHome {
  readonly path: string;
  readonly redactValues: readonly string[];
  readonly nativeAuth?: PiRuntimeNativeAuth;
}

interface PiInitializedGeneration {
  readonly catalog: ManagedCatalogResult;
  readonly bridgePath: string;
  readonly subagentPath: string;
  readonly silentEncryptedRetryPath: string;
  readonly managedResources: PiManagedRuntimeResourceSnapshot;
}

interface PiManagedGeneration {
  readonly agentHome: string;
  readonly options: PiAdapterOptions;
  initialization?: Promise<PiInitializedGeneration>;
  references: number;
  retired: boolean;
  released: boolean;
}

interface PiManagedGenerationLease {
  readonly generation: PiManagedGeneration;
  released: boolean;
}

interface PiRuntimeOwnerManifest {
  readonly format: 1;
  readonly spawnIdentity: string;
  readonly sessionKey: string;
  readonly productGeneration: number;
  readonly state: "reserved" | "running";
  readonly pid?: number;
  readonly processIdentity?: string;
}

const RUNTIME_OWNER_FILE = "runtime-owner.json";

export interface PiDirectBashResult {
  readonly output: string;
  readonly exitCode?: number;
  readonly cancelled: boolean;
  readonly truncated: boolean;
  readonly fullOutputPath?: string;
  readonly artifact?: BlobRef;
  readonly [key: string]: unknown;
}

interface PiRunningExtensionCommand {
  readonly context: AdapterContext;
  readonly command: string;
}

export type PiProjectedMessageRole = "user" | "assistant" | "toolResult" | "custom";

export type PiProjectedMessagePart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "thinking"; readonly thinking: string; readonly redacted: boolean }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string }
  | {
      readonly type: "toolCall";
      readonly id: string;
      readonly name: string;
      readonly arguments: Readonly<Record<string, string>>;
    };

export interface PiProjectedMessage {
  /** Adapter-owned identity. This is intentionally outside Pi's native entry/message namespace. */
  readonly id: string;
  readonly role: PiProjectedMessageRole;
  readonly content: readonly PiProjectedMessagePart[];
  readonly timestamp?: number;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly isError?: boolean;
  readonly usage?: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly totalTokens: number;
    readonly costMicros: number;
  };
}

export class PiBackendAdapter implements BackendAdapter {
  readonly id = "pi";
  #options: PiAdapterOptions;
  #agentHome: string;
  #managedGeneration: PiManagedGeneration;
  readonly #command: string;
  readonly #commandArgs: readonly string[];
  readonly #processFactory: PiProcessFactory;
  readonly #usesDefaultProcessFactory: boolean;
  readonly #usesBundledCommand: boolean;
  readonly #processSupervisor: PiManagedProcessSupervisor | undefined;
  readonly #sessionStore: PiSessionStore;
  readonly #externalSessionRoots: readonly string[];
  readonly #externalSessionReferences = new Map<string, PiExternalSessionSource>();
  readonly #runtimes = new Map<string, PiRuntime>();
  readonly #runtimeStarts = new Map<string, Promise<PiRuntime>>();
  readonly #spawnProfiles = new Map<string, SessionSpawnProfile>();
  readonly #artifactRefsBySession = new Map<string, Map<string, BlobRef>>();
  readonly #subagentObservers = new Map<string, ManagedSubagentObserver>();
  #silentEncryptedRetryEnabled: boolean;
  #silentEncryptedRetryPreferenceRevision = 0;
  #sessionInitialization: Promise<void> | undefined;
  #versionProbe: Promise<{ version?: string; error?: string }> | undefined;
  #compatibilityProbe: Promise<PiCompatibilityOutcome> | undefined;
  #reconfiguration: Promise<void> | undefined;
  #disposed = false;

  constructor(options: PiAdapterOptions) {
    this.#agentHome = resolve(options.agentHome);
    if (!isAbsolute(options.agentHome) || this.#agentHome !== options.agentHome) {
      throw piError("PI_INVALID_AGENT_HOME", "Pi Agent Home must be a normalized absolute path", "provision");
    }
    const sessionRoot = normalizedAbsolutePath(options.sessionRoot, "PI_INVALID_SESSION_ROOT", "Pi Session Root");
    const externalSessionRoots = uniqueNormalizedPaths((options.externalSessionRoots ?? [
      resolve(homedir(), ".pi", "agent", "sessions")
    ]).map((path) => normalizedAbsolutePath(path, "PI_INVALID_EXTERNAL_SESSION_ROOT", "External Pi Session Root")));
    if (options.managedGenerationsRoot !== undefined) {
      const generationsRoot = normalizedAbsolutePath(options.managedGenerationsRoot, "PI_INVALID_GENERATIONS_ROOT", "Pi generations root");
      assertContained(sessionRoot, generationsRoot, "Pi generations root");
    }
    this.#externalSessionRoots = externalSessionRoots;
    this.#options = copyAdapterOptions({ ...options, externalSessionRoots }, this.#agentHome, sessionRoot);
    this.#silentEncryptedRetryEnabled = this.#options.silentEncryptedRetryEnabled
      ?? SILENT_ENCRYPTED_RETRY_DEFAULT_ENABLED;
    this.#managedGeneration = {
      agentHome: this.#agentHome,
      options: this.#options,
      references: 0,
      retired: false,
      released: false
    };
    this.#command = options.command ?? process.execPath;
    this.#commandArgs = options.command === undefined
      ? [BUNDLED_PI_CLI, ...(options.commandArgs ?? [])]
      : options.commandArgs ?? [];
    this.#processFactory = options.processFactory ?? spawnPiProcess;
    this.#usesDefaultProcessFactory = options.processFactory === undefined;
    this.#usesBundledCommand = options.command === undefined;
    this.#processSupervisor = options.processSupervisor ?? (options.processFactory === undefined
      ? createDefaultPiManagedProcessSupervisor()
      : undefined);
    this.#sessionStore = new PiSessionStore(sessionRoot);
    if (options.mcpBridge && !options.mcpBridge.token) {
      throw piError("PI_MCP_CREDENTIAL_MISSING", "MCP bridge token must be supplied through the managed credential channel", "provision");
    }
    validateNativeAuthOptions(this.#options);
  }

  async describe(): Promise<BackendDescriptor> {
    const { catalog } = await this.#initialize();
    const [probe, compatibility, tools] = await Promise.all([
      this.#probeVersion(),
      this.#probeCompatibility(),
      loadPiBuiltInToolCatalog({
        cwd: this.#agentHome,
        ...(this.#options.settings?.defaultTools === undefined
          ? {}
          : { enabledToolNames: this.#options.settings.defaultTools })
      })
    ]);
    const installed = probe.version !== undefined || compatibility.status === "compatible";
    const credentials = { ...this.#options.environment, ...catalog.keylessEnvironment };
    const authenticated = (this.#options.providers ?? []).some(
      (provider) => provider.keyless === true || (provider.apiKeyEnv ? Boolean(credentials[provider.apiKeyEnv]) : false)
    ) || (this.#options.nativeAuthenticatedProviderIds?.length ?? 0) > 0;
    const diagnostics: string[] = [];
    if (probe.error) diagnostics.push(probe.error);
    if (compatibility.status === "incompatible") diagnostics.push(compatibility.diagnostic);
    else diagnostics.push(...compatibility.report.diagnostics);
    if ((this.#options.providers ?? []).length === 0) diagnostics.push("No managed provider catalog is configured.");
    if (!this.#options.readBlob) diagnostics.push("Image BlobRef resolution is unavailable until readBlob is configured.");
    return {
      id: this.id,
      adapterKind: "pi",
      instanceGeneration: 0,
      displayName: "Pi",
      version: probe.version ?? "unknown",
      health: compatibility.status === "incompatible"
        ? "unavailable"
        : probe.error !== undefined || compatibility.report.unsupportedCommands.length > 0
          ? "degraded"
          : "healthy",
      installationState: installed ? "installed" : "not_installed",
      authenticationState: authenticated ? "authenticated" : "signed_out",
      capabilities: this.#capabilities(compatibility),
      models: mergeProviderModels(catalog.models, this.#options.nativeModels ?? []),
      tools: [...tools, ASK_USER_QUESTION_TOOL, ...MANAGED_SUBAGENT_TOOL_DESCRIPTORS],
      diagnostics
    };
  }

  async validateTarget(target: TargetDescriptor): Promise<void> {
    this.#assertNotDisposed();
    if (target.backendId !== this.id) throw piError("PI_TARGET_BACKEND_MISMATCH", "Target is not assigned to the Pi adapter", "provision");
    if (target.remoteWorkspace !== undefined) {
      if (!normalizedPosixAbsolutePath(target.remoteWorkspace.workspaceRoot)) {
        throw piError("PI_REMOTE_WORKSPACE_INVALID", "Remote workspace root must be a normalized absolute POSIX path", "provision");
      }
      if (this.#options.validateRemoteWorkspace === undefined) {
        throw piError("PI_REMOTE_WORKSPACE_UNAVAILABLE", "Remote workspace validation is unavailable", "provision");
      }
      await this.#options.validateRemoteWorkspace(target);
      return;
    }
    if (!isAbsolute(target.workspaceRoot)) throw piError("PI_WORKSPACE_NOT_ABSOLUTE", "Pi workspace root must be absolute", "provision");
    const resolved = resolve(target.workspaceRoot);
    const info = await lstat(resolved).catch((error) => {
      throw piError("PI_WORKSPACE_UNAVAILABLE", `Pi workspace '${resolved}' is unavailable`, "provision", { cause: error });
    });
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw piError("PI_WORKSPACE_UNSAFE", "Pi workspace must be a regular directory and not a symlink or junction", "provision");
    }
    const canonical = await realpath(resolved).catch((error) => {
      throw asPiError(error, {
        code: "PI_WORKSPACE_RESOLUTION_FAILED",
        phase: "provision",
        retryable: true,
        recovery: "Resolve workspace path aliases and retry with its canonical directory."
      });
    });
    if (!samePath(canonical, resolved)) {
      throw piError("PI_WORKSPACE_ALIAS_DENIED", "Pi workspace contains an unresolved path alias or parent junction", "provision", {
        recovery: "Use the canonical workspace path to keep permission and resource boundaries stable."
      });
    }
  }

  async resolveNativeSessionReference(
    nativeReference: string,
    target: TargetDescriptor,
    generation: number
  ): Promise<NativeSessionBinding> {
    await this.validateTarget(target);
    await this.#initialize();
    const external = this.#externalSessionReferences.get(nativeReference);
    if (external !== undefined) {
      const binding = await this.#sessionStore.importExternalSession(external, {
        workspaceRoot: runtimeWorkspaceRoot(target),
        generation
      });
      // A discovery reference is a one-shot snapshot fence. The copied managed
      // binding is durable; importing the same stale snapshot again requires a
      // deliberate rescan.
      this.#externalSessionReferences.delete(nativeReference);
      return binding;
    }
    if (nativeReference.startsWith(EXTERNAL_SESSION_REFERENCE_PREFIX)) {
      throw piError(
        "PI_EXTERNAL_SESSION_REFERENCE_STALE",
        "The upstream Pi history reference is stale or was not issued by this Adapter",
        "session",
        { retryable: true, recovery: "Rescan upstream Pi histories and select the current result." }
      );
    }
    const binding = await this.#sessionStore.binding(nativeReference, generation);
    const sessions = await this.#sessionStore.list(runtimeWorkspaceRoot(target));
    if (!sessions.some((session) => samePath(session.path, binding.opaqueRef) && session.state === "ready")) {
      throw piError("PI_SESSION_WORKSPACE_MISMATCH", "Native Pi session does not belong to the selected workspace", "session", {
        recovery: "Select a managed native session created for the same canonical workspace."
      });
    }
    return binding;
  }

  async createSession(input: CreateNativeSessionInput, context: AdapterContext): Promise<NativeSessionBinding> {
    await this.validateTarget(input.target);
    const runtimePolicy = input.runtimePolicy ?? "standard";
    if (runtimePolicy !== (context.runtimePolicy ?? "standard")) {
      throw piError("PI_RUNTIME_POLICY_MISMATCH", "Create input and host context runtime policies differ", "provision");
    }
    const requestedStart = input.nativeStart ?? { kind: "new" as const };
    if (runtimePolicy === "review_read_only" && (
      requestedStart.kind !== "new"
      || requestedStart.parentNativeReference !== undefined
      || input.permissionMode !== "ask"
      || input.fastMode
      || input.name !== undefined
      || input.appendSystemPrompt !== undefined
      || (context.extraDirectories?.length ?? 0) !== 0
    )) {
      throw piError("PI_REVIEW_PROFILE_INVALID", "Reviewer creation requires a fresh immutable read-only profile", "provision");
    }
    if (
      input.target.id !== context.target.id ||
      input.target.backendId !== context.target.backendId ||
      !samePath(input.target.workspaceRoot, context.target.workspaceRoot) ||
      !sameRemoteWorkspace(input.target.remoteWorkspace, context.target.remoteWorkspace) ||
      input.target.managed !== context.target.managed ||
      input.target.trusted !== context.target.trusted
    ) {
      throw piError("PI_CREATE_TARGET_MISMATCH", "Create input target does not match the adapter context target", "provision", {
        recovery: "Retry with the same authorized target descriptor in both the create input and adapter context."
      });
    }
    if (this.#runtimes.has(context.sessionId) || this.#runtimeStarts.has(context.sessionId)) {
      throw piError("PI_SESSION_ALREADY_ACTIVE", "A Pi runtime already exists for this product session", "session");
    }
    const profile: SessionSpawnProfile = {
      providerId: input.providerId,
      modelId: input.modelId,
      effort: input.effort,
      appendSystemPrompt: input.appendSystemPrompt,
      initialPermissionMode: input.permissionMode,
      initialPlanMode: false,
      initialFastMode: input.fastMode,
      runtimePolicy
    };
    this.#spawnProfiles.set(context.sessionId, profile);
    const start = requestedStart;
    const attachedBinding = start.kind === "attach"
      ? await this.resolveNativeSessionReference(start.nativeReference, input.target, context.generation)
      : undefined;
    const parentBinding = start.kind === "new" && start.parentNativeReference
      ? await this.resolveNativeSessionReference(start.parentNativeReference, input.target, context.generation)
      : undefined;
    // A parented new_session starts by resuming the parent JSONL, avoiding the
    // otherwise unavoidable throwaway fresh JSONL before the RPC transition.
    let runtime = await this.#startRuntime(attachedBinding ?? parentBinding, profile, context);
    if (start.kind === "attach" && attachedBinding !== undefined) {
      try {
        runtime = await this.#confirmNativeSessionSwitch(runtime, attachedBinding, context);
      } catch (error) {
        await this.#stopRuntime(context.sessionId, runtime.transport.generation).catch(() => undefined);
        throw error;
      }
    } else if (start.kind === "new" && start.parentNativeReference) {
      const binding = await this.newNativeSession(start.parentNativeReference, context);
      runtime = this.#runtime({ ...context, binding });
    }
    if (input.name && start.kind !== "attach") await this.setName(input.name, { ...context, binding: runtime.binding });
    return runtime.binding;
  }

  async resumeSession(binding: NativeSessionBinding, context: AdapterContext): Promise<NativeSessionState> {
    if (binding.generation > context.generation) {
      throw piError("PI_STALE_GENERATION", "Native binding belongs to a newer runtime generation", "session");
    }
    await this.validateTarget(context.target);
    const profile = this.#spawnProfiles.get(context.sessionId) ?? restoredSpawnProfile(context);
    this.#spawnProfiles.set(context.sessionId, profile);
    const active = this.#runtimes.get(context.sessionId);
    let runtime = await this.#ensureRuntime(binding, profile, context);
    if (active === undefined && profile.runtimePolicy === "standard") {
      try {
        runtime = await this.#confirmNativeSessionSwitch(runtime, binding, context);
      } catch (error) {
        await this.#stopRuntime(context.sessionId, runtime.transport.generation).catch(() => undefined);
        throw error;
      }
    }
    await this.#compactAtConfiguredThreshold(runtime, { ...context, binding: runtime.binding });
    return this.inspectSession(runtime.binding, { ...context, binding: runtime.binding });
  }

  async inspectSession(binding: NativeSessionBinding, context: AdapterContext): Promise<NativeSessionState> {
    const profile = this.#spawnProfiles.get(context.sessionId) ?? restoredSpawnProfile(context);
    const runtime = await this.#ensureRuntime(binding, profile, context);
    const compatibility = await this.#requireCompatibility();
    const treeSupported = !compatibility.unsupportedCommands.includes("get_tree");
    const [state, stats, tree] = await Promise.all([
      this.getState(context),
      compatibility.unsupportedCommands.includes("get_session_stats")
        ? Promise.resolve({})
        : this.getSessionStats(context),
      profile.runtimePolicy === "review_read_only" || !treeSupported
        ? Promise.resolve({ roots: [] } as SessionTree)
        : this.getTree(context)
    ]);
    runtime.control = await readControl(runtime.controlPath, runtime.control.generation);
    this.#syncManagedSubagentObserver(runtime);
    this.#spawnProfiles.set(context.sessionId, {
      ...profile,
      providerId: state.model?.provider ?? profile.providerId,
      modelId: state.model?.id ?? profile.modelId,
      effort: state.thinkingLevel,
      initialPermissionMode: runtime.control.permissionMode,
      initialPlanMode: runtime.control.planMode,
      initialFastMode: runtime.control.fastMode
    });
    return nativeState(
      runtime.binding,
      state,
      runtime.control.permissionMode,
      runtime.control.fastMode,
      runtime.control.planMode,
      runtime.autoRetry,
      tree.leafId,
      usageFromStats(stats)
    );
  }

  async detachSession(_binding: NativeSessionBinding, context: AdapterContext): Promise<void> {
    const runtime = this.#runtimes.get(context.sessionId);
    if (runtime === undefined || !samePath(runtime.binding.opaqueRef, _binding.opaqueRef)) return;
    await this.#stopRuntime(context.sessionId, context.generation);
  }

  async closeSession(_binding: NativeSessionBinding, context: AdapterContext): Promise<void> {
    const runtime = this.#runtimes.get(context.sessionId);
    if (runtime === undefined || !samePath(runtime.binding.opaqueRef, _binding.opaqueRef)) return;
    await this.#stopRuntime(context.sessionId, context.generation);
  }

  async deleteSession(binding: NativeSessionBinding, context: AdapterContext): Promise<void> {
    if (context.target.remoteWorkspace !== undefined && context.runtimePolicy === "review_read_only") {
      throw piError(
        "PI_REVIEW_REMOTE_LINEAGE_MUTATION_DENIED",
        "Reviewer runtimes cannot delete remote delegated-run storage",
        "session",
        { stateMayHaveChanged: false }
      );
    }
    const runtime = this.#runtimes.get(context.sessionId);
    const initialObserver = this.#subagentObservers.get(context.sessionId);
    const remote = context.target.remoteWorkspace !== undefined;
    const durableStore = initialObserver?.durableStore ?? runtime?.managedDurableStore
      ?? (remote ? await this.#remoteManagedDurableStore(binding, context) : undefined);
    if (runtime && runtime.binding.opaqueRef === binding.opaqueRef) await this.#stopRuntime(context.sessionId, runtime.transport.generation);
    for (const other of this.#runtimes.values()) {
      if (samePath(other.binding.opaqueRef, binding.opaqueRef)) {
        throw piError("PI_SESSION_ACTIVE", "Another product session is still using this native Pi session", "session", {
          recovery: "Detach every runtime bound to the native session before deleting it."
        });
      }
    }
    const observer = this.#subagentObservers.get(context.sessionId);
    await observer?.stopAndDrain();
    if (observer !== undefined) this.#subagentObservers.delete(context.sessionId);
    let remoteLineageRemoved = false;
    try {
      if (durableStore === undefined) {
        if (remote) throw new Error("Remote managed Subagent storage lacks a binding authority.");
        await stopAndRemoveManagedSubagentRuns(
          managedSubagentRunRoot(this.#sessionStore.root),
          context.sessionId,
          this.#options.shutdownTimeoutMs ?? 5_000
        );
        await this.#options.onManagedSubagentLineageRemoved?.({
          sessionId: context.sessionId,
          targetId: context.target.id
        });
        await this.#sessionStore.moveToTrash(
          binding.opaqueRef,
          localSessionTrashRecoveryKey(binding, context)
        );
      } else {
        const bindingOpaqueRef = binding?.opaqueRef;
        if (bindingOpaqueRef === undefined) {
          throw new Error("Remote managed Subagent lineage lacks its native Session binding.");
        }
        const result = await durableStore.stopAndRemoveSession({
          sessionId: context.sessionId,
          sessionKey: managedSubagentSessionKey(context.sessionId),
          timeoutMs: Math.min(10_000, Math.max(1, this.#options.shutdownTimeoutMs ?? 5_000))
        });
        if (!result.removed) throw new Error("Remote managed Subagent deletion did not confirm durable removal.");
        remoteLineageRemoved = true;
        const deletion = await persistRemoteSubagentDeletionReceipt(this.#sessionStore.root, {
          scope: "session",
          sessionId: context.sessionId,
          targetId: context.target.id,
          bindingOpaqueRef,
          deletionReceipt: result.deletionReceipt
        });
        await this.#options.onManagedSubagentLineageRemoved?.({
          sessionId: context.sessionId,
          targetId: context.target.id
        });
        await removeManagedSubagentObservationJournal(
          managedSubagentObservationRoot(this.#sessionStore.root),
          context.sessionId
        );
        await this.#sessionStore.moveToTrash(binding.opaqueRef, deletion.trashRecoveryKey);
        await durableStore.finalizeDeletion({
          sessionId: context.sessionId,
          sessionKey: managedSubagentSessionKey(context.sessionId),
          deletionReceipt: result.deletionReceipt
        });
        await durableStore.dispose();
        await removeRemoteSubagentDeletionReceipt(this.#sessionStore.root, deletion);
      }
    } catch (error) {
      const active = this.#runtimes.get(context.sessionId);
      if (active !== undefined) {
        await this.#observeManagedSubagents(active);
      } else if (!remoteLineageRemoved) {
        this.#retainDetachedManagedSubagentObserver(durableStore, context);
      } else {
        await durableStore?.dispose().catch(() => undefined);
      }
      throw asPiError(error, {
        code: "PI_SESSION_DELETE_INCOMPLETE",
        phase: "session",
        retryable: true,
        stateMayHaveChanged: true,
        recovery: "Retry deletion with the same Session binding; its remote receipt and native trash move are idempotent."
      });
    }
    this.#spawnProfiles.delete(context.sessionId);
    this.#artifactRefsBySession.delete(context.sessionId);
  }

  supportsDetachedSessionDeletion(context: AdapterContext): boolean {
    return context.target.remoteWorkspace !== undefined
      && context.runtimePolicy !== "review_read_only";
  }

  async dispatchDuringCompaction(
    input: PromptInput,
    context: AdapterContext
  ): Promise<PromptInput["disposition"] | undefined> {
    if (context.runtimePolicy === "review_read_only") return undefined;
    if (!input.text.trimStart().startsWith("/")) return undefined;
    const runtime = this.#runtime(context);
    const options = runtime.generationLease.generation.options;
    const composedMessage = await this.#composePrompt(input, context, options);
    if (!composedMessage.trimStart().startsWith("/")) return undefined;
    const commandCatalog = await this.#readCommandCatalog(runtime, context)
      .catch(() => EMPTY_PI_COMMAND_CATALOG);
    const resolved = resolvePiComposerSlashCommand(
      composedMessage,
      "prompt",
      commandCatalog.commands,
      commandCatalog.managedInternalNames
    );
    // Pi's AgentSession.prompt() executes catalogued extension commands before
    // its compaction/streaming guards. Product control commands, skills,
    // templates, and unknown slash text deliberately remain queued.
    return resolved.extensionCommand === undefined ? undefined : "prompt";
  }

  async send(input: PromptInput, context: AdapterContext): Promise<void> {
    let visionStarted = false;
    try {
      await this.#sendInput(input, context, () => { visionStarted = true; });
    } catch (error) {
      // Vision feedback is advisory. A failed UI-status write must not
      // mask the dispatch error, and any pre-lifecycle failure clears only the
      // renderer-local recognizing toast when the status write succeeds.
      if (visionStarted) {
        await context.emit({ type: "status", key: "vision-bridge-clear" }).catch(() => undefined);
      }
      throw error;
    }
  }

  async sendWithDurableNativeDispatchFence(
    input: PromptInput,
    context: AdapterContext,
    persistFence: (preparation: DurableNativeDispatchPreparation) => Promise<void>
  ): Promise<void> {
    if (context.target.remoteWorkspace === undefined) {
      await this.send(input, context);
      return;
    }
    let visionStarted = false;
    try {
      await this.#sendInput(input, context, () => { visionStarted = true; }, persistFence);
    } catch (error) {
      if (visionStarted) {
        await context.emit({ type: "status", key: "vision-bridge-clear" }).catch(() => undefined);
      }
      throw error;
    }
  }

  async #sendInput(
    input: PromptInput,
    context: AdapterContext,
    onVisionStart: () => void,
    persistFence?: (preparation: DurableNativeDispatchPreparation) => Promise<void>
  ): Promise<void> {
    const runtime = this.#runtime(context);
    const options = runtime.generationLease.generation.options;
    const imageState = input.images.length > 0 ? await this.#requestState(runtime, context) : undefined;
    const bridged: Awaited<ReturnType<PiVisionBridgeTransform>> =
      input.images.length === 0 || imageState?.model?.id === undefined || options.visionBridge === undefined
        ? undefined
        : await options.visionBridge({
            backendId: context.target.backendId,
            providerId: imageState.model.provider,
            modelId: imageState.model.id,
            text: input.text,
            images: input.images,
            ...(context.signal === undefined ? {} : { signal: context.signal }),
            onStart: async (imageCount) => {
              onVisionStart();
              await context.emit({
                type: "status",
                key: "vision-bridge-recognizing",
                text: String(imageCount)
              }).catch(() => undefined);
            }
          });
    if (bridged !== undefined) {
      if (bridged.unavailableCount === input.images.length) {
        await context.emit({ type: "status", key: "vision-bridge-unavailable" }).catch(() => undefined);
      } else if (bridged.usedFallback) {
        await context.emit({ type: "status", key: "vision-bridge-fallback" }).catch(() => undefined);
      }
    }
    if (input.images.length > 0 && bridged === undefined) {
      await this.#requireImageInputState(runtime, context, imageState);
    }
    const unbridgedMessage = await this.#composePrompt(input, context, options);
    const composedMessage = bridged === undefined
      ? unbridgedMessage
      : appendVisionBridgeDescriptions(unbridgedMessage, bridged.descriptions);
    const commandCatalog = composedMessage.trimStart().startsWith("/")
      ? await this.#readCommandCatalog(runtime, context).catch(() => EMPTY_PI_COMMAND_CATALOG)
      : EMPTY_PI_COMMAND_CATALOG;
    const composerCommand = composedMessage.trimStart().startsWith("/")
      ? resolvePiComposerSlashCommand(
          composedMessage,
          input.disposition,
          commandCatalog.commands,
          commandCatalog.managedInternalNames
        )
      : { message: composedMessage };
    const message = composerCommand.message;
    const images = bridged === undefined ? await this.#resolveImages(input, options) : [];
    const dispatchState = input.images.length > 0
      ? bridged === undefined
        ? await this.#requireImageInputState(runtime, context, imageState)
        : imageState
      : undefined;
    const extensionCommand = composerCommand.extensionCommand;
    const extensionState = extensionCommand === undefined
      ? undefined
      : dispatchState ?? await this.#requestState(runtime, context);
    if (
      extensionCommand !== undefined &&
      (
        extensionState?.isCompacting === true ||
        extensionState?.isStreaming === true ||
        runtime.lifecycle !== undefined
      )
    ) {
      if (runtime.runningExtensionCommand !== undefined) {
        throw piError(
          "PI_EXTENSION_COMMAND_ALREADY_RUNNING",
          "Another Pi extension command is already running",
          "dispatch",
          { recovery: "Wait for the current extension command to finish before retrying." }
        );
      }
      const runningExtensionCommand: PiRunningExtensionCommand = { context, command: extensionCommand };
      runtime.runningExtensionCommand = runningExtensionCommand;
      try {
        await requestPiPromptAcceptance(
          runtime,
          { type: "prompt", message, images },
          context.signal
        );
      } finally {
        if (runtime.runningExtensionCommand === runningExtensionCommand) runtime.runningExtensionCommand = undefined;
      }
      this.#publishExtensionCommandTerminal(runtime, context, extensionCommand);
      return;
    }
    if (extensionCommand !== undefined && input.disposition !== "prompt") {
      const activeLifecycle = runtime.lifecycle;
      if (activeLifecycle === undefined || activeLifecycle.settlementReceived) {
        throw inactiveContinuationError(input.disposition);
      }
      const state = extensionState ?? await this.#requestState(runtime, context);
      if (
        runtime.lifecycle !== activeLifecycle ||
        activeLifecycle.settlementReceived ||
        !state.isStreaming
      ) {
        throw inactiveContinuationError(input.disposition);
      }
      if (runtime.runningExtensionCommand !== undefined) {
        throw piError(
          "PI_EXTENSION_COMMAND_ALREADY_RUNNING",
          "Another Pi extension command is already running",
          "dispatch",
          { recovery: "Wait for the current extension command to finish before retrying." }
        );
      }
      const runningExtensionCommand: PiRunningExtensionCommand = { context, command: extensionCommand };
      runtime.runningExtensionCommand = runningExtensionCommand;
      try {
        // Pi's prompt() dispatches catalogued extension commands before its
        // streaming guard. steer/follow_up explicitly reject those commands.
        await requestPiPromptAcceptance(
          runtime,
          { type: "prompt", message, images },
          context.signal
        );
      } finally {
        if (runtime.runningExtensionCommand === runningExtensionCommand) runtime.runningExtensionCommand = undefined;
      }
      this.#publishExtensionCommandTerminal(runtime, context, extensionCommand);
      return;
    }
    let durableNativeDispatchFingerprint: string | undefined;
    if (persistFence !== undefined && input.disposition === "prompt") {
      const redactedMessage = redactPiNativeValue({
        role: "user",
        content: [
          ...(message === "" ? [] : [{ type: "text", text: message }]),
          ...images
        ]
      }, runtime.redactValues);
      if (!isRecord(redactedMessage)) {
        throw piError("PI_NATIVE_DISPATCH_FINGERPRINT_INVALID", "Pi native input fingerprint could not be established", "dispatch");
      }
      durableNativeDispatchFingerprint = nativeDispatchFingerprintForUserMessage(redactedMessage);
    }
    const participant: PiNativeLifecycleParticipant = { context, disposition: input.disposition, message };
    let lifecycle: PiNativeLifecycle;
    if (input.disposition === "prompt") {
      if (runtime.lifecycle !== undefined) {
        throw piError(
          "PI_PROMPT_REQUIRES_IDLE_RUNTIME",
          "A new prompt cannot start while the current Pi agent lifecycle is still active",
          "dispatch",
          { recovery: "Wait for the current run to settle, or submit the input as steer/follow-up." }
        );
      }
      const state = dispatchState ?? await this.#requestState(runtime, context);
      if (state.isStreaming) {
        throw piError(
          "PI_PROMPT_REQUIRES_IDLE_RUNTIME",
          "Pi reports an active agent lifecycle without a matching product run",
          "dispatch",
          {
            retryable: true,
            stateMayHaveChanged: true,
            recovery: "Reload the session projection and wait for the native lifecycle to settle before retrying."
          }
        );
      }
      await this.#compactAtConfiguredThreshold(runtime, context);
      runtime.abortRequested = false;
      lifecycle = {
        owner: participant,
        participants: [participant],
        pendingSteering: [],
        pendingFollowUps: [],
        currentContext: context,
        initialUserMessageSeen: false,
        agentStarted: false,
        settlementReceived: false
      };
      runtime.lifecycle = lifecycle;
      runtime.translator.setContext(context);
    } else {
      const activeLifecycle = runtime.lifecycle;
      if (runtime.abortRequested || activeLifecycle === undefined || activeLifecycle.settlementReceived) {
        throw inactiveContinuationError(input.disposition);
      }
      const state = dispatchState ?? await this.#requestState(runtime, context);
      if (
        runtime.abortRequested ||
        runtime.lifecycle !== activeLifecycle ||
        activeLifecycle.settlementReceived ||
        !state.isStreaming
      ) {
        throw inactiveContinuationError(input.disposition);
      }
      lifecycle = activeLifecycle;
      lifecycle.participants.push(participant);
      if (input.disposition === "steer") lifecycle.pendingSteering.push(participant);
      else lifecycle.pendingFollowUps.push(participant);
    }
    const command: PiRpcCommand =
      input.disposition === "steer"
        ? { type: "steer", message, images }
        : input.disposition === "follow_up"
          ? { type: "follow_up", message, images }
          : { type: "prompt", message, images };
    try {
      await this.#runExclusiveSessionMutation(runtime, context, async () => {
        if (
          command.type === "prompt" &&
          persistFence !== undefined &&
          durableNativeDispatchFingerprint !== undefined
        ) {
          await persistFence({
            inputFingerprint: durableNativeDispatchFingerprint,
            nativeHistory: await this.getNativeHistoryProjection(context)
          });
        }
        return command.type === "prompt"
          ? requestPiPromptAcceptance(runtime, command, context.signal)
          : runtime.transport.request(command, {
              signal: context.signal,
              stateMayHaveChanged: true,
              timeoutMs: runtimeRpcTimeout(runtime, PI_STANDARD_RPC_TIMEOUT_MS)
            });
      });
    } catch (error) {
      if (input.disposition === "prompt" && runtime.lifecycle === lifecycle && !lifecycle.agentStarted) {
        runtime.lifecycle = undefined;
        runtime.translator.setContext(runtime.context);
      }
      throw error;
    }
    if (extensionCommand !== undefined) {
      const state = await this.#requestState(runtime, context);
      if (!state.isStreaming && state.pendingMessageCount === 0) {
        if (runtime.lifecycle === lifecycle) runtime.lifecycle = undefined;
        this.#publishExtensionCommandTerminal(runtime, context, extensionCommand, () => runtime.lifecycle === undefined);
      }
    }
  }

  #publishExtensionCommandTerminal(
    runtime: PiRuntime,
    context: AdapterContext,
    command: string,
    additionalFence: () => boolean = () => true
  ): void {
    const runtimeGeneration = runtime.transport.generation;
    // A successful prompt response is Pi's acceptance boundary. Publish a
    // synthetic terminal only after send() resolves so SessionHost can
    // durably commit backend_accepted/running before consuming `done`.
    setImmediate(() => {
      if (
        this.#runtimes.get(context.sessionId) !== runtime ||
        runtime.transport.generation !== runtimeGeneration ||
        !additionalFence()
      ) return;
      void context.emit(
        { type: "done", outcome: "completed" },
        {
          namespace: "pi.extension_command",
          fields: { command }
        }
      ).catch(() => undefined);
    });
  }

  async #requestState(runtime: PiRuntime, context: AdapterContext): Promise<PiRpcState> {
    const response = await runtime.transport.request({ type: "get_state" }, { signal: context.signal });
    return responseData(response) as PiRpcState;
  }

  #runExclusiveSessionMutation<T>(
    runtime: PiRuntime,
    context: AdapterContext,
    operation: () => Promise<T>
  ): Promise<T> {
    const run = runtime.sessionMutationTail.then(async () => {
      if (this.#runtimes.get(runtime.key) !== runtime || runtime.transport.closed) {
        throw piError(
          "PI_RUNTIME_NOT_ACTIVE",
          "Pi runtime changed while a native Session operation was queued",
          "dispatch",
          {
            retryable: true,
            stateMayHaveChanged: false,
            recovery: "Refresh the task and retry against its current runtime generation."
          }
        );
      }
      // A preceding fork/switch can replace the native binding while this
      // operation is queued. Re-apply the caller's complete generation and
      // binding fence at the actual dispatch boundary.
      this.#touchRuntime(runtime, context);
      return operation();
    });
    runtime.sessionMutationTail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async #failClosedUnconfirmedSessionMutation(
    runtime: PiRuntime,
    code: string,
    message: string,
    cause: unknown
  ): Promise<never> {
    let shutdownError: unknown;
    if (this.#runtimes.get(runtime.key) === runtime) {
      try {
        await this.#stopRuntime(runtime.key, runtime.transport.generation);
      } catch (error) {
        shutdownError = error;
      }
    }
    const combinedCause = shutdownError === undefined
      ? cause
      : new AggregateError([cause, shutdownError], `${message}; runtime shutdown was not confirmed`);
    throw piError(code, message, "dispatch", {
      retryable: true,
      stateMayHaveChanged: true,
      recovery: shutdownError === undefined
        ? "Resume the native Session in a new runtime generation and verify its live model controls before dispatching again."
        : "Keep this generation fenced, terminate its process manually, then resume the native Session in a new runtime generation.",
      cause: combinedCause
    });
  }

  async #requireImageInputState(runtime: PiRuntime, context: AdapterContext, observed?: PiRpcState): Promise<PiRpcState> {
    const state = observed ?? await this.#requestState(runtime, context);
    if (state.model?.input?.includes("image") === true) return state;
    throw piError(
      "PI_IMAGE_INPUT_UNSUPPORTED",
      "The current Pi model does not explicitly support image input",
      "dispatch",
      {
        retryable: false,
        stateMayHaveChanged: false,
        recovery: "Select a model whose current Pi runtime state advertises image input, then resend the message."
      }
    );
  }

  async abort(context: AdapterContext): Promise<void> {
    const runtime = this.#runtime(context);
    runtime.abortRequested = true;
    await this.#runExclusiveSessionMutation(runtime, context, async () => {
      const clearResponse = await runtime.transport.request(
        { type: "clear_queue" },
        {
          signal: context.signal,
          stateMayHaveChanged: true,
          timeoutMs: runtimeRpcTimeout(runtime, PI_STANDARD_RPC_TIMEOUT_MS)
        }
      );
      validateClearedPiQueue(clearResponse);
      await runtime.transport.request(
        { type: "abort" },
        {
          signal: context.signal,
          stateMayHaveChanged: true,
          timeoutMs: runtimeRpcTimeout(runtime, PI_STANDARD_RPC_TIMEOUT_MS)
        }
      );
    });
  }

  async cancelBackgroundTask(context: AdapterContext, taskId: string): Promise<void> {
    const normalizedTaskId = typeof taskId === "string" ? taskId.trim() : "";
    if (!normalizedTaskId) {
      throw piError("PI_BACKGROUND_TASK_ID_REQUIRED", "Background task id is required", "dispatch");
    }
    if (normalizedTaskId.length > 256 || /[\u0000-\u001f\u007f]/u.test(normalizedTaskId)) {
      throw piError("PI_BACKGROUND_TASK_ID_INVALID", "Background task id is invalid", "dispatch");
    }
    const runtime = this.#runtime(context);
    if (runtime.control.runtimePolicy === "review_read_only") {
      throw piError("PI_BACKGROUND_TASK_UNAVAILABLE", "Background task control is unavailable in the reviewer runtime", "dispatch");
    }
    const payload = Buffer.from(JSON.stringify({
      sessionId: context.sessionId,
      taskId: normalizedTaskId
    }), "utf8").toString("base64url");
    try {
      await requestPiPromptAcceptance(
        runtime,
        { type: "prompt", message: `/${MANAGED_SUBAGENT_CONTROL_COMMAND_NAME} ${payload}` },
        context.signal
      );
    } catch (error) {
      const detail = redactedDiagnostic(error);
      const code = detail.includes("[MANAGED_TASK_OWNERSHIP]")
        ? "PI_BACKGROUND_TASK_OWNERSHIP_MISMATCH"
        : detail.includes("[MANAGED_TASK_UNKNOWN]")
          ? "PI_BACKGROUND_TASK_NOT_FOUND"
          : detail.includes("[MANAGED_TASK_TERMINAL]")
            ? "PI_BACKGROUND_TASK_NOT_ACTIVE"
            : detail.includes("[MANAGED_TASK_UNCONFIRMED]")
              ? "PI_BACKGROUND_TASK_CANCEL_UNCONFIRMED"
              : detail.includes("[MANAGED_TASK_INVALID]")
                ? "PI_BACKGROUND_TASK_ID_INVALID"
                : "PI_BACKGROUND_TASK_CANCEL_FAILED";
      throw piError(code, "Managed background task cancellation was rejected", "dispatch", {
        retryable: code === "PI_BACKGROUND_TASK_CANCEL_FAILED" || code === "PI_BACKGROUND_TASK_CANCEL_UNCONFIRMED",
        stateMayHaveChanged: true,
        recovery: "Reload the task state for this session before retrying cancellation.",
        cause: error
      });
    }
  }

  async controlSubagent(input: SubagentControlInput, context: AdapterContext): Promise<void> {
    if (!(["stop", "steer", "follow_up", "resume"] as const).includes(input.action)) {
      throw piError("PI_SUBAGENT_CONTROL_ACTION_INVALID", "Subagent control action is invalid", "dispatch");
    }
    const runId = boundedManagedControlText(input.runId, 256, "Subagent run id");
    const childId = input.childId === undefined
      ? undefined
      : boundedManagedControlText(input.childId, 512, "Subagent child id");
    const message = input.action === "stop"
      ? undefined
      : boundedManagedControlText(input.message, 32_000, `Subagent ${input.action} message`);
    if (context.runtimePolicy === "review_read_only") {
      throw piError("PI_SUBAGENT_CONTROL_UNAVAILABLE", "Subagent control is unavailable in the reviewer runtime", "dispatch");
    }
    if (context.target.remoteWorkspace !== undefined && input.action !== "resume") {
      const runtime = this.#runtimes.get(context.sessionId);
      if (runtime !== undefined) this.#touchRuntime(runtime, context);
      const existingObserver = this.#subagentObservers.get(context.sessionId);
      const binding = runtime?.binding ?? context.binding;
      if (binding === undefined) {
        throw piError("PI_SESSION_BINDING_REQUIRED", "Remote delegated-run control requires a native Session binding", "dispatch", {
          retryable: true,
          stateMayHaveChanged: false
        });
      }
      const durableStore = existingObserver?.durableStore ?? runtime?.managedDurableStore
        ?? await this.#remoteManagedDurableStore(binding, context);
      if (durableStore === undefined) {
        throw piError("PI_REMOTE_SUBAGENT_STORE_UNAVAILABLE", "Remote managed Subagent storage is unavailable", "dispatch", {
          retryable: true,
          stateMayHaveChanged: false
        });
      }
      try {
        await assertManagedSubagentControlTarget({
          root: managedSubagentRunRoot(this.#sessionStore.root),
          durableStore,
          productSessionId: context.sessionId,
          productGeneration: context.generation,
          runId,
          ...(childId === undefined ? {} : { childId }),
          action: input.action
        });
      } catch (error) {
        if (existingObserver === undefined) this.#retainDetachedManagedSubagentObserver(durableStore, context);
        throw piError("PI_SUBAGENT_CONTROL_OWNERSHIP_UNCONFIRMED", "Subagent control target failed durable ownership or state validation", "dispatch", {
          retryable: false,
          stateMayHaveChanged: false,
          recovery: "Reload the current Session's delegated runs before retrying control.",
          cause: error
        });
      }
      try {
        await writeManagedSubagentDurableControl({
          root: managedSubagentRunRoot(this.#sessionStore.root),
          durableStore,
          productSessionId: context.sessionId,
          productGeneration: context.generation,
          runId,
          ...(childId === undefined ? {} : { childId }),
          action: input.action,
          ...(message === undefined ? {} : { message }),
          ...(context.operationId === undefined ? {} : { operationId: context.operationId }),
          signal: context.signal
        });
        if (existingObserver === undefined) this.#retainDetachedManagedSubagentObserver(durableStore, context);
        return;
      } catch (error) {
        if (existingObserver === undefined) this.#retainDetachedManagedSubagentObserver(durableStore, context);
        throw piError("PI_SUBAGENT_CONTROL_REJECTED", "The owned Pi Subagent runner rejected the control request", "dispatch", {
          retryable: true,
          stateMayHaveChanged: true,
          recovery: "Reload the delegated run and retry only if its advertised action remains available.",
          cause: error
        });
      }
    }
    const runtime = this.#runtime(context);
    if (runtime.control.runtimePolicy === "review_read_only") {
      throw piError("PI_SUBAGENT_CONTROL_UNAVAILABLE", "Subagent control is unavailable in the reviewer runtime", "dispatch");
    }
    try {
      await assertManagedSubagentControlTarget({
        root: managedSubagentRunRoot(this.#sessionStore.root),
        ...(runtime.managedDurableStore === undefined ? {} : { durableStore: runtime.managedDurableStore }),
        productSessionId: context.sessionId,
        productGeneration: context.generation,
        runId,
        ...(childId === undefined ? {} : { childId }),
        action: input.action
      });
    } catch (error) {
      throw piError("PI_SUBAGENT_CONTROL_OWNERSHIP_UNCONFIRMED", "Subagent control target failed durable ownership or state validation", "dispatch", {
        retryable: false,
        stateMayHaveChanged: false,
        recovery: "Reload the current Session's delegated runs before retrying control.",
        cause: error
      });
    }
    const payload = Buffer.from(JSON.stringify({
      sessionId: context.sessionId,
      generation: context.generation,
      taskId: runId,
      ...(childId === undefined ? {} : { childId }),
      action: input.action,
      ...(message === undefined ? {} : { message })
    }), "utf8").toString("base64url");
    try {
      await requestPiPromptAcceptance(
        runtime,
        { type: "prompt", message: `/${MANAGED_SUBAGENT_CONTROL_COMMAND_NAME} ${payload}` },
        context.signal
      );
    } catch (error) {
      throw piError("PI_SUBAGENT_CONTROL_REJECTED", "The owned Pi Subagent runner rejected the control request", "dispatch", {
        retryable: true,
        stateMayHaveChanged: true,
        recovery: "Reload the delegated run and retry only if its advertised action remains available.",
        cause: error
      });
    }
  }

  supportsDetachedSubagentControl(
    action: SubagentControlInput["action"],
    context: AdapterContext
  ): boolean {
    return context.target.remoteWorkspace !== undefined
      && context.runtimePolicy !== "review_read_only"
      && action !== "resume";
  }

  async observeDetachedSubagents(context: AdapterContext): Promise<void> {
    if (context.target.remoteWorkspace === undefined || context.runtimePolicy === "review_read_only") return;
    const binding = context.binding;
    if (binding === undefined) return;
    const pendingDeletion = await findRemoteSubagentDeletionReceipt(this.#sessionStore.root, {
      sessionId: context.sessionId,
      targetId: context.target.id,
      bindingOpaqueRef: binding.opaqueRef
    });
    const existing = this.#subagentObservers.get(context.sessionId);
    if (existing !== undefined) {
      if (existing.generation !== context.generation) {
        throw piError("PI_SUBAGENT_OBSERVER_OWNERSHIP_MISMATCH", "Remote delegated-run observation crossed its Session generation", "session", {
          retryable: true,
          stateMayHaveChanged: false
        });
      }
      if (pendingDeletion !== undefined) {
        await existing.stopAndDrain();
        this.#subagentObservers.delete(context.sessionId);
      } else {
        existing.update(context, [], 0);
        existing.start();
        return;
      }
    }
    const durableStore = existing?.durableStore ?? await this.#options.managedDurableStoreRegistry?.storeFor({
      sessionId: context.sessionId,
      targetId: context.target.id,
      bindingOpaqueRef: binding.opaqueRef,
      generation: context.generation
    });
    if (durableStore === undefined) {
      if (pendingDeletion === undefined) return;
      throw piError(
        "PI_REMOTE_SUBAGENT_STORE_UNAVAILABLE",
        "Remote managed Subagent deletion recovery lacks a binding authority",
        "session",
        { retryable: true, stateMayHaveChanged: true }
      );
    }
    if (pendingDeletion !== undefined) {
      let disposed = false;
      try {
        await this.#options.onManagedSubagentLineageRemoved?.({
          sessionId: context.sessionId,
          targetId: context.target.id
        });
        await removeManagedSubagentObservationJournal(
          managedSubagentObservationRoot(this.#sessionStore.root),
          context.sessionId
        );
        if (pendingDeletion.scope === "session") {
          await this.#sessionStore.moveToTrash(binding.opaqueRef, pendingDeletion.trashRecoveryKey);
        }
        await durableStore.finalizeDeletion({
          sessionId: context.sessionId,
          sessionKey: pendingDeletion.sessionKey,
          deletionReceipt: pendingDeletion.deletionReceipt
        });
        await durableStore.dispose();
        disposed = true;
        await removeRemoteSubagentDeletionReceipt(this.#sessionStore.root, pendingDeletion);
      } catch (error) {
        if (!disposed) await durableStore.dispose().catch(() => undefined);
        throw asPiError(error, {
          code: "PI_SUBAGENT_DELETION_RECOVERY_INCOMPLETE",
          phase: "session",
          retryable: true,
          stateMayHaveChanged: true,
          recovery: "Retry service startup with the same Session binding so the retained deletion receipt can finish cleanup."
        });
      }
      return;
    }
    const observer = new ManagedSubagentObserver({
      root: managedSubagentRunRoot(this.#sessionStore.root),
      durableStore,
      journalRoot: managedSubagentObservationRoot(this.#sessionStore.root),
      context,
      redactValues: [],
      policyGeneration: 0,
      commandConcurrencyGate: this.#managedGeneration.options.commandConcurrencyGate
    });
    try {
      const activeRuns = await observer.refresh();
      if (activeRuns === 0) {
        observer.stop();
        await durableStore.dispose();
        return;
      }
      this.#subagentObservers.set(context.sessionId, observer);
      observer.start();
    } catch (error) {
      observer.stop();
      await durableStore.dispose().catch(() => undefined);
      throw error;
    }
  }

  async setModel(providerId: string, modelId: string, context: AdapterContext): Promise<ProviderModel> {
    this.#assertReviewOperationAllowed(context, "change model");
    const runtime = this.#runtime(context);
    const model = await this.#runExclusiveSessionMutation(runtime, context, async () => {
      runtime.control = await readControl(runtime.controlPath, runtime.transport.generation);
      const supportsFastMode = await this.#runtimeModelSupportsFastMode(runtime, providerId, modelId);
      if (runtime.control.fastMode && !supportsFastMode) {
        throw piError(
          "PI_FAST_MODE_MODEL_SWITCH_UNSUPPORTED",
          "Cannot switch an active Fast Mode session to a model that does not advertise Fast Mode support",
          "dispatch",
          { recovery: "Disable Fast Mode first or choose an eligible model." }
        );
      }

      let response: Awaited<ReturnType<PiRpcTransport["request"]>>;
      let accepted = false;
      try {
        response = await runtime.transport.request(
          { type: "set_model", provider: providerId, modelId },
          { signal: context.signal, stateMayHaveChanged: true }
        );
        accepted = true;
        const identity = piRpcModelIdentity(responseData(response));
        if (identity === undefined || identity.provider !== providerId || identity.id !== modelId) {
          throw piError(
            "PI_MODEL_SWITCH_INVALID_RESPONSE",
            "Pi acknowledged a model switch without confirming the requested Provider and Model",
            "dispatch",
            { stateMayHaveChanged: true }
          );
        }
        await advanceRuntimePolicy(runtime);
        this.#syncManagedSubagentObserver(runtime);
        const levels = await this.getAvailableThinkingLevels(context);
        const projected = modelFromRpc(responseData(response) as PiRpcModel, levels, supportsFastMode);
        const profile = this.#spawnProfiles.get(context.sessionId);
        if (profile) this.#spawnProfiles.set(context.sessionId, { ...profile, providerId, modelId });
        return projected;
      } catch (error) {
        if (accepted || isUnconfirmedSessionMutationError(error)) {
          return this.#failClosedUnconfirmedSessionMutation(
            runtime,
            "PI_MODEL_SWITCH_UNCONFIRMED",
            "Pi model switching did not reach one confirmed runtime and host state",
            error
          );
        }
        throw error;
      }
    });
    await this.#compactAtConfiguredThreshold(runtime, context);
    return model;
  }

  async setEffort(level: string, context: AdapterContext): Promise<void> {
    this.#assertReviewOperationAllowed(context, "change reasoning effort");
    const runtime = this.#runtime(context);
    await this.#runExclusiveSessionMutation(runtime, context, async () => {
      const available = await this.getAvailableThinkingLevels(context);
      if (!available.includes(level)) throw piError("PI_THINKING_LEVEL_UNAVAILABLE", `Pi thinking level '${level}' is unavailable`, "dispatch");
      let accepted = false;
      try {
        await runtime.transport.request(
          { type: "set_thinking_level", level: level as "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" },
          { signal: context.signal, stateMayHaveChanged: true }
        );
        accepted = true;
        await advanceRuntimePolicy(runtime);
        this.#syncManagedSubagentObserver(runtime);
        const profile = this.#spawnProfiles.get(context.sessionId);
        if (profile) this.#spawnProfiles.set(context.sessionId, { ...profile, effort: level });
      } catch (error) {
        if (accepted || isUnconfirmedSessionMutationError(error)) {
          return this.#failClosedUnconfirmedSessionMutation(
            runtime,
            "PI_THINKING_LEVEL_UNCONFIRMED",
            "Pi thinking-level switching did not reach one confirmed runtime and host state",
            error
          );
        }
        throw error;
      }
    });
  }

  async setFastMode(enabled: boolean, context: AdapterContext): Promise<void> {
    this.#assertReviewOperationAllowed(context, "change Fast Mode");
    const runtime = this.#runtime(context);
    await this.#runExclusiveSessionMutation(runtime, context, () => this.#setFastModeWithinMutation(enabled, context, runtime));
  }

  async #setFastModeWithinMutation(enabled: boolean, context: AdapterContext, runtime: PiRuntime): Promise<void> {
    if (enabled) {
      const state = await this.getState(context);
      const model = state.model as unknown as PiRpcModel | undefined;
      if (model === undefined || !(await this.#runtimeModelSupportsFastMode(runtime, model.provider, model.id))) {
        throw piError(
          "PI_FAST_MODE_UNSUPPORTED",
          "Fast Mode is unavailable for the active Pi model",
          "dispatch",
          { recovery: "Select a model that explicitly advertises Fast Mode support." }
        );
      }
    }
    const currentControl = await readControl(runtime.controlPath, runtime.transport.generation);
    if (currentControl.fastMode === enabled) return;
    const nextControl: PiRuntimeControl = {
      ...currentControl,
      policyGeneration: currentControl.policyGeneration + 1,
      fastMode: enabled,
      writtenAt: new Date().toISOString()
    };
    await writeRuntimeControl(runtime.controlPath, runtimeControlForWrite(nextControl));
    runtime.control = nextControl;
    this.#syncManagedSubagentObserver(runtime);
    const profile = this.#spawnProfiles.get(context.sessionId);
    if (profile) this.#spawnProfiles.set(context.sessionId, { ...profile, initialFastMode: enabled });
  }

  async setPermissionMode(mode: PermissionMode, context: AdapterContext): Promise<void> {
    const runtime = this.#runtime(context);
    await this.#runExclusiveSessionMutation(runtime, context, async () => {
      const currentControl = await readControl(runtime.controlPath, runtime.transport.generation);
      if (currentControl.runtimePolicy === "review_read_only") {
        if (mode !== "ask") throw piError("PI_REVIEW_POLICY_IMMUTABLE", "Reviewer runtime cannot change permission mode", "dispatch");
        return;
      }
      const nextControl = {
        ...currentControl,
        policyGeneration: currentControl.policyGeneration + 1,
        permissionMode: mode,
        writtenAt: new Date().toISOString()
      };
      await writeRuntimeControl(runtime.controlPath, {
        generation: runtime.transport.generation,
        policyGeneration: nextControl.policyGeneration,
        permissionMode: mode,
        planMode: nextControl.planMode,
        fastMode: nextControl.fastMode,
        approvedRoots: nextControl.approvedRoots,
        runtimePolicy: nextControl.runtimePolicy
      });
      runtime.control = nextControl;
      this.#syncManagedSubagentObserver(runtime);
      const profile = this.#spawnProfiles.get(context.sessionId);
      if (profile) this.#spawnProfiles.set(context.sessionId, { ...profile, initialPermissionMode: mode });
    });
  }

  async setPlanMode(enabled: boolean, context: AdapterContext): Promise<void> {
    const runtime = this.#runtime(context);
    const shouldEmit = await this.#runExclusiveSessionMutation(runtime, context, async () => {
      const currentControl = await readControl(runtime.controlPath, runtime.transport.generation);
      if (currentControl.runtimePolicy === "review_read_only") {
        if (enabled) throw piError("PI_REVIEW_POLICY_IMMUTABLE", "Reviewer runtime cannot enter plan mode", "dispatch");
        return false;
      }
      const nextControl = {
        ...currentControl,
        policyGeneration: currentControl.policyGeneration + 1,
        planMode: enabled,
        writtenAt: new Date().toISOString()
      };
      await writeRuntimeControl(runtime.controlPath, {
        generation: runtime.transport.generation,
        policyGeneration: nextControl.policyGeneration,
        permissionMode: nextControl.permissionMode,
        planMode: enabled,
        fastMode: nextControl.fastMode,
        approvedRoots: nextControl.approvedRoots,
        runtimePolicy: nextControl.runtimePolicy
      });
      runtime.control = nextControl;
      this.#syncManagedSubagentObserver(runtime);
      const profile = this.#spawnProfiles.get(context.sessionId);
      if (profile) this.#spawnProfiles.set(context.sessionId, { ...profile, initialPlanMode: enabled });
      return true;
    });
    if (shouldEmit) {
      await context.emit({ type: "status", key: "plan_mode", text: enabled ? "enabled" : undefined }, piMetadata("host_plan_mode"));
    }
  }

  async setPolicySnapshot(context: AdapterContext): Promise<void> {
    const runtime = this.#runtimes.get(context.sessionId);
    if (runtime === undefined || runtime.transport.closed || runtime.transport.generation !== context.generation) {
      throw piError("PI_RUNTIME_NOT_ACTIVE", "Pi runtime is not active for an ordered policy update", "dispatch", { retryable: true });
    }
    const run = runtime.sessionMutationTail.then(async () => {
      if (this.#runtimes.get(runtime.key) !== runtime || runtime.transport.closed) {
        throw piError("PI_RUNTIME_NOT_ACTIVE", "Pi runtime changed while an ordered policy update was queued", "dispatch", { retryable: true });
      }
      if (context.binding !== undefined && !samePath(context.binding.opaqueRef, runtime.binding.opaqueRef)) {
        throw piError("PI_SESSION_BINDING_MISMATCH", "Caller binding does not match the active Pi runtime", "dispatch");
      }
      const currentControl = await readControl(runtime.controlPath, runtime.transport.generation);
      const nextControl: PiRuntimeControl = {
        ...currentControl,
        policyGeneration: currentControl.policyGeneration + 1,
        writtenAt: new Date().toISOString()
      };
      try {
        await writeRuntimeControl(runtime.controlPath, runtimeControlForWrite(nextControl));
      } catch (error) {
        return this.#failClosedUnconfirmedSessionMutation(
          runtime,
          "PI_POLICY_SNAPSHOT_UNCONFIRMED",
          "Ordered policy settings did not reach one confirmed Pi runtime fence",
          error
        );
      }
      runtime.control = nextControl;
      runtime.context = context;
      if (runtime.lifecycle === undefined) runtime.translator.setContext(context);
      this.#syncManagedSubagentObserver(runtime);
    });
    runtime.sessionMutationTail = run.then(() => undefined, () => undefined);
    await run;
  }

  async setExtraDirectories(directories: readonly ApprovedDirectory[], context: AdapterContext): Promise<void> {
    const runtime = this.#runtime(context);
    await this.#runExclusiveSessionMutation(runtime, context, async () => {
      const currentControl = await readControl(runtime.controlPath, runtime.transport.generation);
      if (currentControl.runtimePolicy === "review_read_only") {
        if (directories.length > 0) throw piError("PI_REVIEW_POLICY_IMMUTABLE", "Reviewer runtime cannot add filesystem roots", "dispatch");
        return;
      }
      const approvedRoots = await validateApprovedDirectories(directories, context.target.workspaceRoot);
      const nextControl = {
        ...currentControl,
        policyGeneration: currentControl.policyGeneration + 1,
        approvedRoots,
        writtenAt: new Date().toISOString()
      };
      await writeRuntimeControl(runtime.controlPath, {
        generation: runtime.transport.generation,
        policyGeneration: nextControl.policyGeneration,
        permissionMode: nextControl.permissionMode,
        planMode: nextControl.planMode,
        fastMode: nextControl.fastMode,
        approvedRoots,
        runtimePolicy: nextControl.runtimePolicy
      });
      runtime.control = nextControl;
      this.#syncManagedSubagentObserver(runtime);
    });
  }

  async compact(customInstructions: string | undefined, context: AdapterContext): Promise<"compacted" | "noop"> {
    this.#assertReviewOperationAllowed(context, "compact");
    const runtime = this.#runtime(context);
    try {
      await this.#runExclusiveSessionMutation(runtime, context, () =>
        runtime.transport.request(
          { type: "compact", customInstructions },
          {
            signal: context.signal,
            stateMayHaveChanged: true,
            timeoutMs: runtimeRpcTimeout(runtime, PI_LONG_RUNNING_RPC_TIMEOUT_MS),
            refreshTimeoutOnEvent: isPiRpcProgressEvent
          }
        )
      );
      // Pi writes compaction events and the command response on the same RPC
      // stream. Own the already-received event chain through its durable emit
      // boundary before SessionHost hydrates the newly persisted native entry;
      // otherwise the native marker can race ahead of the live terminal event
      // and leave both projections visible after reconnect.
      await runtime.eventChain;
      return "compacted";
    } catch (error) {
      // A no-op terminal event may precede Pi's rejected command response.
      // Preserve that event ordering without replacing the authoritative RPC
      // failure if an advisory translation emit also fails.
      await runtime.eventChain.catch(() => undefined);
      if (isPiCompactionNoopRejection(error)) return "noop";
      throw error;
    }
  }

  async setAutoCompaction(enabled: boolean, context: AdapterContext): Promise<void> {
    this.#assertReviewOperationAllowed(context, "set auto compaction");
    const runtime = this.#runtime(context);
    await this.#runExclusiveSessionMutation(runtime, context, async () => {
      await runtime.transport.request(
        { type: "set_auto_compaction", enabled },
        { signal: context.signal, stateMayHaveChanged: true }
      );
      runtime.autoCompaction = enabled;
    });
    if (enabled) await this.#compactAtConfiguredThresholdIfIdle(runtime, context);
  }

  async setAutoCompactionThreshold(percent: number, context: AdapterContext): Promise<void> {
    this.#assertReviewOperationAllowed(context, "set auto compaction threshold");
    assertAutoCompactionThresholdPercent(percent);
    const runtime = this.#runtime(context);
    await this.#runExclusiveSessionMutation(runtime, context, async () => {
      runtime.autoCompactionThresholdPercent = percent;
    });
    await this.#compactAtConfiguredThresholdIfIdle(runtime, context);
  }

  async setAutoRetry(enabled: boolean, context: AdapterContext): Promise<void> {
    this.#assertReviewOperationAllowed(context, "set auto retry");
    const runtime = this.#runtime(context);
    await this.#runExclusiveSessionMutation(runtime, context, async () => {
      await runtime.transport.request(
        { type: "set_auto_retry", enabled },
        { signal: context.signal, stateMayHaveChanged: true }
      );
      runtime.autoRetry = enabled;
    });
  }

  /** Set the owner default used by runtimes created after this call. */
  async configureSilentEncryptedRetry(enabled: boolean): Promise<void> {
    this.#assertNotDisposed();
    this.#silentEncryptedRetryEnabled = enabled;
    this.#silentEncryptedRetryPreferenceRevision += 1;
  }

  /** Hot-apply the owner preference without restarting or creating a Run/Attempt. */
  async setSilentEncryptedRetry(enabled: boolean, context: AdapterContext): Promise<void> {
    const runtime = this.#runtime(context);
    await writeSilentEncryptedRetryControl(
      runtime.silentEncryptedRetryControlPath,
      runtime.transport.generation,
      enabled
    );
  }

  async #compactAtConfiguredThreshold(runtime: PiRuntime, context: AdapterContext): Promise<void> {
    if (
      runtime.control.runtimePolicy !== "standard"
      || !runtime.autoCompaction
    ) return;
    if (runtime.thresholdCheck !== undefined) {
      await runtime.thresholdCheck;
      return;
    }
    const check = this.#compactAtConfiguredThresholdExclusive(runtime, context);
    runtime.thresholdCheck = check;
    try {
      await check;
    } finally {
      if (runtime.thresholdCheck === check) runtime.thresholdCheck = undefined;
    }
  }

  async #compactAtConfiguredThresholdIfIdle(runtime: PiRuntime, context: AdapterContext): Promise<void> {
    if (runtime.lifecycle !== undefined || runtime.runningExtensionCommand !== undefined) return;
    const state = await this.#requestState(runtime, context).catch(() => undefined);
    if (state === undefined || state.isStreaming || state.isCompacting) return;
    await this.#compactAtConfiguredThreshold(runtime, context);
  }

  async #compactAtConfiguredThresholdExclusive(runtime: PiRuntime, context: AdapterContext): Promise<void> {

    // get_session_stats is the only stock Pi RPC projection that combines the
    // current branch usage with the current model's context window. Comparing
    // here keeps a percentage exact across model switches; settings.json only
    // supports one absolute reserveTokens value for every model.
    const statsResponse = await runtime.transport.request(
      { type: "get_session_stats" },
      { signal: context.signal }
    ).catch(() => undefined);
    if (statsResponse === undefined) return;
    const stats = responseData(statsResponse);
    if (!isRecord(stats)) return;
    const usage = usageFromStats(stats);
    const contextTokens = usage?.contextTokens;
    const contextWindow = usage?.contextWindow;
    if (
      contextTokens === undefined
      || contextWindow === undefined
      || contextTokens < 0
      || contextWindow <= 0
      || contextTokens / contextWindow < runtime.autoCompactionThresholdPercent / 100
    ) return;

    const operation = { id: randomUUID() };
    runtime.thresholdCompaction = operation;
    let started = false;
    try {
      await context.emit({
        type: "compaction",
        reason: "threshold",
        compactionId: operation.id,
        state: "started",
        automatic: true,
        willRetry: false
      }, piMetadata("adapter_threshold_compaction_start"));
      started = true;
      const response = await this.#runExclusiveSessionMutation(
        runtime,
        context,
        () => runtime.transport.request(
          { type: "compact", customInstructions: undefined },
          {
            signal: context.signal,
            stateMayHaveChanged: true,
            timeoutMs: runtimeRpcTimeout(runtime, PI_LONG_RUNNING_RPC_TIMEOUT_MS),
            refreshTimeoutOnEvent: isPiRpcProgressEvent
          }
        )
      );
      const result = responseData(response);
      const record = isRecord(result) ? result : {};
      const tokensBefore = optionalUnsignedNumber(record.tokensBefore) ?? contextTokens;
      const tokensAfter = optionalUnsignedNumber(record.estimatedTokensAfter);
      await context.emit({
        type: "compaction",
        reason: "threshold",
        compactionId: operation.id,
        state: "completed",
        automatic: true,
        willRetry: false,
        ...(tokensBefore === undefined ? {} : { tokensBefore }),
        ...(tokensAfter === undefined ? {} : { tokensAfter })
      }, piMetadata("adapter_threshold_compaction_end"));
    } catch (error) {
      if (!started) throw error;
      if (isPiCompactionNoopRejection(error)) {
        await context.emit({
          type: "compaction",
          reason: "threshold",
          compactionId: operation.id,
          state: "no_op",
          automatic: true,
          willRetry: false,
          tokensBefore: contextTokens
        }, piMetadata("adapter_threshold_compaction_noop"));
        return;
      }
      const failure = asPiError(error, {
        code: "PI_AUTO_COMPACTION_FAILED",
        phase: "dispatch",
        retryable: true,
        stateMayHaveChanged: true,
        recovery: "Retry after the active Pi session reports a stable context state."
      });
      await context.emit({
        type: "compaction",
        reason: "threshold",
        compactionId: operation.id,
        state: "failed",
        automatic: true,
        willRetry: false,
        tokensBefore: contextTokens,
        error: failure.publicError
      }, piMetadata("adapter_threshold_compaction_failed"));
    } finally {
      if (runtime.thresholdCompaction === operation) runtime.thresholdCompaction = undefined;
    }
  }

  async abortRetry(context: AdapterContext): Promise<void> {
    this.#assertReviewOperationAllowed(context, "change retry state");
    await this.#runtime(context).transport.request({ type: "abort_retry" }, { signal: context.signal });
  }

  async exportSession(context: AdapterContext): Promise<BlobRef> {
    this.#assertReviewOperationAllowed(context, "export native history");
    const response = await this.#runtime(context).transport.request({ type: "export_html" }, { signal: context.signal });
    const data = responseData(response);
    if (!isRecord(data) || typeof data.path !== "string") throw piError("PI_EXPORT_INVALID_RESPONSE", "Pi export_html returned no path", "dispatch");
    const exportPath = isAbsolute(data.path) ? resolve(data.path) : resolve(context.target.workspaceRoot, data.path);
    const exportInfo = await lstat(exportPath).catch((error) => {
      throw piError("PI_EXPORT_FILE_UNAVAILABLE", "Pi export_html response did not reference an available file", "dispatch", {
        retryable: true,
        cause: error
      });
    });
    if (!exportInfo.isFile() || exportInfo.isSymbolicLink()) {
      throw piError("PI_EXPORT_FILE_UNSAFE", "Pi export_html response must reference a regular non-symlink file", "dispatch");
    }
    try {
      return await context.storeArtifact(exportPath, { fileName: `pi-${context.sessionId}.html`, mimeType: "text/html" });
    } catch (error) {
      throw asPiError(error, {
        code: "PI_EXPORT_STORE_FAILED",
        phase: "dispatch",
        retryable: true,
        recovery: "Retry artifact ingestion while the Pi export path is still available."
      });
    }
  }

  async getTree(context: AdapterContext): Promise<SessionTree> {
    this.#assertReviewOperationAllowed(context, "read native history tree");
    const runtime = this.#runtime(context);
    const response = await runtime.transport.request(
      { type: "get_tree" },
      { signal: context.signal, timeoutMs: runtimeRpcTimeout(runtime, PI_STANDARD_RPC_TIMEOUT_MS) }
    );
    const data = responseData(response);
    if (!isRecord(data) || !Array.isArray(data.tree)) throw piError("PI_TREE_INVALID_RESPONSE", "Pi get_tree returned an invalid tree", "dispatch");
    const roots = projectPiTreeNodes(data.tree, runtime.redactValues);
    return {
      roots,
      leafId: typeof data.leafId === "string" ? data.leafId : undefined
    };
  }

  async exportPortableNativeSession(context: AdapterContext): Promise<PortableNativeSession> {
    this.#assertReviewOperationAllowed(context, "export portable native history");
    if (!context.binding) {
      throw piError("PI_SESSION_PORTABLE_BINDING_MISSING", "Portable Session export requires a native binding", "session");
    }
    return this.#sessionStore.exportPortableSession(context.binding.opaqueRef);
  }

  async importPortableNativeSession(
    input: ImportPortableNativeSessionInput,
    signal: AbortSignal
  ): Promise<NativeSessionBinding> {
    signal.throwIfAborted();
    await this.validateTarget(input.target);
    if (input.target.remoteWorkspace !== undefined) {
      throw piError("PI_SESSION_PORTABLE_REMOTE_UNAVAILABLE", "Portable native Session import is unavailable for this remote Target", "session", {
        recovery: "Import into a service-node workspace or configure a remote transfer capability."
      });
    }
    const binding = await this.#sessionStore.importPortableSession(input.bytes, {
      workspaceRoot: input.target.workspaceRoot,
      generation: input.generation,
      ...(input.nativeSessionId === undefined ? {} : { nativeSessionId: input.nativeSessionId })
    });
    signal.throwIfAborted();
    return binding;
  }

  async navigateTree(
    entryId: string,
    summarize: boolean,
    context: AdapterContext,
    customInstructions?: string
  ): Promise<void> {
    this.#assertReviewOperationAllowed(context, "navigate native history");
    if (!entryId) throw piError("PI_TREE_ENTRY_REQUIRED", "Native entry id is required", "dispatch");
    const summaryFocus = customInstructions?.trim();
    if (summaryFocus !== undefined && summaryFocus.length > 4_000) {
      throw piError("PI_TREE_SUMMARY_INSTRUCTIONS_TOO_LONG", "Branch summary instructions must not exceed 4000 characters", "dispatch");
    }
    const runtime = this.#runtime(context);
    await this.#runExclusiveSessionMutation(runtime, context, async () => {
      const [before, entries] = await Promise.all([this.getTree(context), this.getEntries(undefined, context)]);
      if (!containsEntry(before.roots, entryId)) throw piError("PI_TREE_ENTRY_NOT_FOUND", `Pi tree entry '${entryId}' does not exist`, "dispatch");
      const targetEntry = entries.entries.find((entry) => entry.id === entryId);
      if (targetEntry === undefined) throw piError("PI_TREE_ENTRY_NOT_FOUND", `Pi tree entry '${entryId}' does not exist`, "dispatch");
      const expectedLeafId = expectedLeafAfterTreeNavigation(targetEntry);
      const state = await this.getState(context);
      if (state.isStreaming) throw piError("PI_TREE_RUNTIME_BUSY", "Pi tree navigation requires an idle runtime", "dispatch", { retryable: true });
      const payload = Buffer.from(JSON.stringify({
        entryId,
        summarize,
        ...(summarize && summaryFocus ? { customInstructions: summaryFocus } : {})
      }), "utf8").toString("base64url");
      await requestPiPromptAcceptance(
        runtime,
        { type: "prompt", message: `/joko-navigate-tree ${payload}` },
        context.signal
      );
      const tree = await this.getTree(context);
      if (tree.leafId !== expectedLeafId) {
        throw piError("PI_TREE_NAVIGATION_UNCONFIRMED", `Pi did not confirm navigation to '${entryId}'`, "dispatch", {
          stateMayHaveChanged: true,
          recovery: "Reload the native tree and reconcile its active leaf before another navigation."
        });
      }
    });
    // SessionHost performs a persistence-confirmed get_entries sync and emits
    // the leaf marker only after every newly visible native entry is durable.
  }

  async fork(entryId: string, context: AdapterContext): Promise<NativeSessionForkResult> {
    this.#assertReviewOperationAllowed(context, "fork native history");
    if (!entryId) throw piError("PI_FORK_ENTRY_REQUIRED", "Native fork entry id is required", "dispatch");
    const runtime = this.#runtime(context);
    return this.#runExclusiveSessionMutation(runtime, context, async () => {
      const sourceBinding = runtime.binding;
      const sourceHistory = await this.getEntries(undefined, context);
      const sourceEntry = sourceHistory.entries.find((entry) => entry.id === entryId);
      if (sourceEntry === undefined) {
        throw piError("PI_FORK_ENTRY_NOT_DURABLE", `Pi fork entry '${entryId}' is not in durable native history`, "dispatch", {
          retryable: true,
          recovery: "Wait for the selected native history entry to become durable, then retry the fork."
        });
      }
      if (sourceEntry.type !== "message" || !isRecord(sourceEntry.message) || sourceEntry.message.role !== "user") {
        throw piError("PI_FORK_ENTRY_INELIGIBLE", "Pi native fork requires a durable user-message entry", "dispatch");
      }
      await this.#sessionStore.assertManagedSession(sourceBinding.opaqueRef).catch((error) => {
        throw piError("PI_FORK_SOURCE_NOT_DURABLE", "Pi native fork requires a materialized source Session", "session", {
          retryable: true,
          recovery: "Wait for the source Session to persist its first assistant response, then retry the fork.",
          cause: error
        });
      });

      const shadowKey = `fork-shadow-${randomUUID()}`;
      const sourceProfile = this.#spawnProfiles.get(runtime.key) ?? restoredSpawnProfile(context);
      const shadowProfile: SessionSpawnProfile = {
        ...sourceProfile,
        initialPermissionMode: runtime.control.permissionMode,
        initialPlanMode: runtime.control.planMode,
        initialFastMode: runtime.control.fastMode
      };
      const shadowContext: AdapterContext = {
        ...context,
        sessionId: shadowKey,
        binding: sourceBinding,
        emit: async () => undefined
      };
      this.#spawnProfiles.set(shadowKey, shadowProfile);
      let shadow: PiRuntime | undefined;
      let accepted = false;
      try {
        shadow = await this.#startRuntime(sourceBinding, shadowProfile, shadowContext);
        const response = await shadow.transport.request(
          { type: "fork", entryId },
          {
            signal: context.signal,
            stateMayHaveChanged: true,
            timeoutMs: runtimeRpcTimeout(shadow, PI_LONG_RUNNING_RPC_TIMEOUT_MS)
          }
        );
        assertSessionChangeAccepted(response, "fork");
        accepted = true;
        const data = responseData(response);
        const editorText = isRecord(data) && typeof data.text === "string"
          ? redactManagedSecrets(data.text, runtime.redactValues)
          : undefined;
        const refreshedBinding = await this.#refreshBinding(shadow, false);
        const derivedHistory = await this.getEntries(undefined, { ...shadowContext, binding: refreshedBinding });
        const binding = await this.#sessionStore.materializeDetachedFork({
          binding: refreshedBinding,
          parentSession: sourceBinding.opaqueRef,
          entries: derivedHistory.entries
        });
        if (samePath(binding.opaqueRef, sourceBinding.opaqueRef)) {
          throw piError("PI_SESSION_FORK_IDENTITY_UNCHANGED", "Pi native fork did not create a distinct Session", "session", {
            stateMayHaveChanged: true,
            recovery: "Inspect the detached fork runtime and retry from the unchanged source Session."
          });
        }
        if (
          this.#runtimes.get(runtime.key) !== runtime
          || runtime.transport.closed
          || runtime.transport.generation !== sourceBinding.generation
          || !samePath(runtime.binding.opaqueRef, sourceBinding.opaqueRef)
        ) {
          throw piError("PI_SESSION_FORK_SOURCE_FENCE_CHANGED", "The source Pi Session changed while its detached fork was being created", "session", {
            retryable: true,
            stateMayHaveChanged: false,
            recovery: "Reload the source Session binding before retrying the fork."
          });
        }
        const sourceState = await this.#requestState(runtime, context);
        if (
          typeof sourceState.sessionFile !== "string"
          || !samePath(sourceState.sessionFile, sourceBinding.opaqueRef)
          || (sourceBinding.nativeSessionId !== undefined && sourceState.sessionId !== sourceBinding.nativeSessionId)
        ) {
          throw piError("PI_SESSION_FORK_SOURCE_IDENTITY_CHANGED", "Pi did not preserve the source native Session during detached fork", "session", {
            retryable: true,
            stateMayHaveChanged: false,
            recovery: "Reload the source Session identity before retrying the fork."
          });
        }
        return {
          binding,
          ...(editorText === undefined ? {} : { editorText })
        };
      } catch (error) {
        if (accepted && !(error instanceof PiAdapterError && error.publicError.code.startsWith("PI_SESSION_FORK_"))) {
          throw piError(
            "PI_SESSION_FORK_UNCONFIRMED",
            "Detached Pi native-session fork did not reach one confirmed host binding",
            "session",
            {
              retryable: true,
              stateMayHaveChanged: true,
              recovery: "Keep the source Session attached and reconcile detached native Sessions before retrying.",
              cause: error
            }
          );
        }
        throw error;
      } finally {
        await this.#disposeDerivationShadow("fork", shadowKey, shadow, shadowContext);
      }
    });
  }

  async #disposeDerivationShadow(
    operation: "fork" | "clone",
    shadowKey: string,
    shadow: PiRuntime | undefined,
    shadowContext: AdapterContext
  ): Promise<void> {
    const failures: unknown[] = [];
    if (shadow !== undefined) {
      try {
        await this.#removeManagedSubagentLineage(shadow, shadowContext);
      } catch (error) {
        failures.push(error);
      }
      try {
        await this.#stopRuntime(shadowKey, shadow.transport.generation);
      } catch (error) {
        failures.push(error);
      }
    }
    if (!this.#runtimes.has(shadowKey) && !this.#runtimeStarts.has(shadowKey)) {
      this.#spawnProfiles.delete(shadowKey);
      this.#artifactRefsBySession.delete(shadowKey);
      const observer = this.#subagentObservers.get(shadowKey);
      if (observer !== undefined) {
        await observer.stopAndDrain().catch((error) => failures.push(error));
        await observer.durableStore?.dispose().catch((error) => failures.push(error));
        this.#subagentObservers.delete(shadowKey);
      }
    }
    if (failures.length > 0) {
      const code = operation === "fork"
        ? "PI_SESSION_FORK_SHADOW_CLEANUP_FAILED"
        : "PI_SESSION_CLONE_SHADOW_CLEANUP_FAILED";
      throw piError(code, `Detached Pi ${operation} runtime could not be fully retired`, "shutdown", {
        retryable: true,
        stateMayHaveChanged: true,
        recovery: "Keep the derived binding fenced until the detached runtime is confirmed stopped.",
        cause: new AggregateError(failures, `Detached Pi ${operation} runtime cleanup failures`)
      });
    }
  }

  async clone(context: AdapterContext): Promise<NativeSessionBinding> {
    this.#assertReviewOperationAllowed(context, "clone native history");
    const runtime = this.#runtime(context);
    return this.#runExclusiveSessionMutation(runtime, context, async () => {
      const sourceBinding = runtime.binding;
      await this.#sessionStore.assertManagedSession(sourceBinding.opaqueRef).catch((error) => {
        throw piError("PI_CLONE_SOURCE_NOT_DURABLE", "Pi native clone requires a materialized source Session", "session", {
          retryable: true,
          recovery: "Wait for the source Session to persist its first assistant response, then retry the clone.",
          cause: error
        });
      });
      const sourceHistory = await this.getEntries(undefined, context);
      const sourceLeafId = sourceHistory.leafId;
      if (
        sourceLeafId === undefined
        || !sourceHistory.entries.some((entry) => entry.id === sourceLeafId)
      ) {
        throw piError("PI_CLONE_ENTRY_NOT_DURABLE", "Pi native clone requires one stable durable history entry", "dispatch", {
          retryable: true,
          recovery: "Wait for the current native history leaf to become durable, then retry the clone."
        });
      }

      const shadowKey = `clone-shadow-${randomUUID()}`;
      const sourceProfile = this.#spawnProfiles.get(runtime.key) ?? restoredSpawnProfile(context);
      const shadowProfile: SessionSpawnProfile = {
        ...sourceProfile,
        initialPermissionMode: runtime.control.permissionMode,
        initialPlanMode: runtime.control.planMode,
        initialFastMode: runtime.control.fastMode
      };
      const shadowContext: AdapterContext = {
        ...context,
        sessionId: shadowKey,
        binding: sourceBinding,
        emit: async () => undefined
      };
      this.#spawnProfiles.set(shadowKey, shadowProfile);
      let shadow: PiRuntime | undefined;
      let accepted = false;
      try {
        shadow = await this.#startRuntime(sourceBinding, shadowProfile, shadowContext);
        const shadowHistory = await this.getEntries(undefined, shadowContext);
        if (
          shadowHistory.leafId !== sourceLeafId
          || !shadowHistory.entries.some((entry) => entry.id === sourceLeafId)
        ) {
          throw piError(
            "PI_SESSION_CLONE_ENTRY_FENCE_CHANGED",
            "The source Pi history changed before its detached clone reached a stable entry fence",
            "session",
            {
              retryable: true,
              stateMayHaveChanged: false,
              recovery: "Retry from the latest durable native history leaf."
            }
          );
        }
        const response = await shadow.transport.request(
          { type: "clone" },
          {
            signal: context.signal,
            stateMayHaveChanged: true,
            timeoutMs: runtimeRpcTimeout(shadow, PI_LONG_RUNNING_RPC_TIMEOUT_MS)
          }
        );
        assertSessionChangeAccepted(response, "clone");
        accepted = true;
        const refreshedBinding = await this.#refreshBinding(shadow, false);
        const derivedHistory = await this.getEntries(undefined, { ...shadowContext, binding: refreshedBinding });
        if (
          derivedHistory.leafId !== sourceLeafId
          || !derivedHistory.entries.some((entry) => entry.id === sourceLeafId)
        ) {
          throw piError(
            "PI_SESSION_CLONE_DERIVED_FENCE_CHANGED",
            "Pi native clone did not preserve the fenced history leaf",
            "session",
            {
              stateMayHaveChanged: true,
              recovery: "Reconcile detached native Sessions and retry from the unchanged source Session."
            }
          );
        }
        const binding = await this.#sessionStore.materializeDetachedFork({
          binding: refreshedBinding,
          parentSession: sourceBinding.opaqueRef,
          entries: derivedHistory.entries
        });
        if (samePath(binding.opaqueRef, sourceBinding.opaqueRef)) {
          throw piError("PI_SESSION_CLONE_IDENTITY_UNCHANGED", "Pi native clone did not create a distinct Session", "session", {
            stateMayHaveChanged: true,
            recovery: "Inspect the detached clone runtime and retry from the unchanged source Session."
          });
        }
        if (
          this.#runtimes.get(runtime.key) !== runtime
          || runtime.transport.closed
          || runtime.transport.generation !== sourceBinding.generation
          || !samePath(runtime.binding.opaqueRef, sourceBinding.opaqueRef)
        ) {
          throw piError("PI_SESSION_CLONE_SOURCE_FENCE_CHANGED", "The source Pi Session changed while its detached clone was being created", "session", {
            retryable: true,
            stateMayHaveChanged: false,
            recovery: "Reload the source Session binding before retrying the clone."
          });
        }
        const sourceState = await this.#requestState(runtime, context);
        if (
          typeof sourceState.sessionFile !== "string"
          || !samePath(sourceState.sessionFile, sourceBinding.opaqueRef)
          || (sourceBinding.nativeSessionId !== undefined && sourceState.sessionId !== sourceBinding.nativeSessionId)
        ) {
          throw piError("PI_SESSION_CLONE_SOURCE_IDENTITY_CHANGED", "Pi did not preserve the source native Session during detached clone", "session", {
            retryable: true,
            stateMayHaveChanged: false,
            recovery: "Reload the source Session identity before retrying the clone."
          });
        }
        return binding;
      } catch (error) {
        if (
          (accepted || isUnconfirmedSessionMutationError(error))
          && !(error instanceof PiAdapterError && error.publicError.code.startsWith("PI_SESSION_CLONE_"))
        ) {
          throw piError(
            "PI_SESSION_CLONE_UNCONFIRMED",
            "Detached Pi native-session clone did not reach one confirmed host binding",
            "session",
            {
              retryable: true,
              stateMayHaveChanged: true,
              recovery: "Keep the source Session attached and reconcile detached native Sessions before retrying.",
              cause: error
            }
          );
        }
        throw error;
      } finally {
        await this.#disposeDerivationShadow("clone", shadowKey, shadow, shadowContext);
      }
    });
  }

  async rebuildContext(input: ContextRebuildInput, context: AdapterContext): Promise<NativeSessionBinding> {
    const previousOpaqueRef = context.binding?.opaqueRef;
    if (previousOpaqueRef === undefined) {
      throw piError("PI_SESSION_BINDING_REQUIRED", "Native context rebuild requires the fenced source binding", "session");
    }
    const previousRuntime = this.#runtimes.get(context.sessionId);
    // Message deletion admission already proves idle. Repeat the Adapter-owned
    // fence if a caller kept a runtime alive; unhealthy recovery deliberately
    // skips all RPC inspection because resume/state can be the broken path.
    if (previousRuntime !== undefined && input.reason === "message_deletion") {
      const state = await this.#requestState(previousRuntime, context);
      if (
        state.isStreaming ||
        state.isCompacting ||
        state.pendingMessageCount > 0 ||
        previousRuntime.lifecycle !== undefined ||
        previousRuntime.runningExtensionCommand !== undefined ||
        previousRuntime.userShell !== undefined
      ) {
        throw piError(
          "PI_CONTEXT_REBUILD_REQUIRES_IDLE_RUNTIME",
          "Pi must be idle before native context can be rebuilt",
          "session",
          { retryable: true, recovery: "Wait for every Pi lifecycle and background command to settle, then retry." }
        );
      }
    }
    const handoff = buildContextRebuildHandoff(input, previousRuntime?.redactValues ?? []);
    const handoffByteLength = Buffer.byteLength(handoff, "utf8");
    const artifactCapacityBytes = requireArtifactCapacity(context);
    if (handoffByteLength > artifactCapacityBytes) {
      throw piError(
        "PI_CONTEXT_REBUILD_HANDOFF_CAPACITY_EXCEEDED",
        "Native context rebuild handoff exceeds the host Artifact capacity",
        "resource",
        {
          recovery: "Increase Artifact storage capacity or rebuild from a smaller surviving context."
        }
      );
    }
    await this.#removeManagedSubagentLineage(previousRuntime, context);
    if (previousRuntime !== undefined) {
      await this.#stopRuntime(context.sessionId, previousRuntime.transport.generation);
    }
    const profile = this.#spawnProfiles.get(context.sessionId) ?? restoredSpawnProfile(context);
    this.#spawnProfiles.set(context.sessionId, profile);
    const replacementContext: AdapterContext = {
      sessionId: context.sessionId,
      generation: context.generation + 1,
      target: context.target,
      ...(context.appendSystemPrompt === undefined ? {} : { appendSystemPrompt: context.appendSystemPrompt }),
      ...(context.runtimePolicy === undefined ? {} : { runtimePolicy: context.runtimePolicy }),
      ...(context.extraDirectories === undefined ? {} : { extraDirectories: context.extraDirectories }),
      ...(context.policySnapshot === undefined ? {} : { policySnapshot: context.policySnapshot }),
      signal: context.signal,
      // The replacement binding is not durable yet. Native bridge chatter
      // cannot cross the product generation fence before Store completion.
      emit: async () => undefined,
      requestInteraction: context.requestInteraction,
      artifactCapacityBytes: context.artifactCapacityBytes,
      storeArtifact: context.storeArtifact
    };
    let runtime: PiRuntime | undefined;
    let handoffPath: string | undefined;
    try {
      // Start without the old binding. The generation-specific fresh ID avoids
      // resuming a large or poisoned JSONL before the managed bridge can inject
      // the hidden handoff into its final replacement Session.
      runtime = await this.#startRuntime(undefined, profile, replacementContext);
      const handoffFileName = `joko-context-rebuild-${randomUUID()}.txt`;
      handoffPath = join(runtime.artifactDirectory, handoffFileName);
      await writeFile(handoffPath, handoff, { encoding: "utf8", flag: "wx", mode: 0o600 });
      const payload = Buffer.from(JSON.stringify({
        format: 1,
        fileName: handoffFileName,
        byteLength: handoffByteLength,
        sha256: createHash("sha256").update(handoff, "utf8").digest("hex"),
        reason: input.reason
      }), "utf8").toString("base64url");
      await requestPiPromptAcceptance(
        runtime,
        { type: "prompt", message: `/joko-rebuild-context ${payload}` },
        replacementContext.signal
      );
      const refreshed = await this.#refreshBinding(runtime, false);
      if (samePath(previousOpaqueRef, refreshed.opaqueRef)) {
        throw piError(
          "PI_CONTEXT_REBUILD_IDENTITY_UNCHANGED",
          "Pi did not replace the native session during context rebuild",
          "session",
          { stateMayHaveChanged: true, recovery: "Retry only after reconciling the native session identity." }
        );
      }
      return { ...refreshed, generation: Math.max(context.generation + 1, refreshed.generation) };
    } finally {
      if (handoffPath !== undefined) await rm(handoffPath, { force: true }).catch(() => undefined);
      // The new JSONL remains append-only and resumable, but no runtime may
      // continue under the old product binding before Store completion.
      if (runtime !== undefined) await this.#stopRuntime(context.sessionId, runtime.transport.generation);
    }
  }

  async resetContext(context: AdapterContext): Promise<NativeSessionBinding> {
    const runtime = this.#runtime(context);
    const state = await this.#requestState(runtime, context);
    if (
      state.isStreaming ||
      state.isCompacting ||
      state.pendingMessageCount > 0 ||
      runtime.lifecycle !== undefined ||
      runtime.runningExtensionCommand !== undefined ||
      runtime.userShell !== undefined
    ) {
      throw piError(
        "PI_CONTEXT_RESET_REQUIRES_IDLE_RUNTIME",
        "Pi must be idle before native context can be reset",
        "session",
        { retryable: true, recovery: "Wait for every Pi lifecycle and background command to settle, then retry." }
      );
    }
    await this.#removeManagedSubagentLineage(runtime, context);
    const previousOpaqueRef = runtime.binding.opaqueRef;
    try {
      await requestPiPromptAcceptance(
        runtime,
        { type: "prompt", message: "/joko-reset-context" },
        context.signal
      );
      const refreshed = await this.#refreshBinding(runtime, false);
      if (samePath(previousOpaqueRef, refreshed.opaqueRef)) {
        throw piError(
          "PI_CONTEXT_RESET_IDENTITY_UNCHANGED",
          "Pi did not replace the native session during context reset",
          "session",
          { stateMayHaveChanged: true, recovery: "Retry only after reconciling the native session identity." }
        );
      }
      return { ...refreshed, generation: Math.max(context.generation + 1, refreshed.generation + 1) };
    } finally {
      // Store is the only authority allowed to publish the new identity. Stop
      // the runtime even after uncertain transport failure so no native work
      // can continue under an uncommitted binding.
      await this.#stopRuntime(context.sessionId, runtime.transport.generation);
    }
  }

  async setName(name: string, context: AdapterContext): Promise<void> {
    this.#assertReviewOperationAllowed(context, "rename native session");
    const trimmed = name.trim();
    if (!trimmed) throw piError("PI_SESSION_NAME_EMPTY", "Pi session name cannot be empty", "dispatch");
    const runtime = this.#runtime(context);
    await this.#runExclusiveSessionMutation(runtime, context, () =>
      runtime.transport.request(
        { type: "set_session_name", name: trimmed },
        { signal: context.signal, stateMayHaveChanged: true }
      ).then(() => undefined)
    );
  }

  async getCommands(context: AdapterContext): Promise<readonly RuntimeCommand[]> {
    const runtime = this.#runtime(context);
    if (runtime.control.runtimePolicy === "review_read_only") return [];
    const catalog = await this.#readCommandCatalog(runtime, context);
    return catalog.commands;
  }

  /**
   * Returns the exact session-scoped registry observed inside the live Pi
   * process. Pi's RPC union has no get_tools command, so the managed bridge
   * obtains this from the upstream ExtensionAPI.getAllTools() boundary.
   */
  async getRuntimeTools(context: AdapterContext): Promise<PiRuntimeToolCatalog> {
    const runtime = this.#runtime(context);
    await runtime.eventChain;
    const catalog = runtime.toolCatalog;
    if (catalog === undefined) {
      throw piError(
        "PI_RUNTIME_TOOL_CATALOG_UNAVAILABLE",
        runtime.toolCatalogUnavailableReason === "catalog_too_large"
          ? "Pi's runtime tool catalog exceeded the runtime platform capacity"
          : runtime.toolCatalogUnavailableReason === "capture_failed"
            ? "Pi failed to capture its runtime tool catalog"
          : "Pi did not provide a complete runtime tool catalog",
        "stream",
        {
          retryable: true,
          stateMayHaveChanged: false,
          recovery: "Restart the same runtime generation; do not infer custom tools from configured extension paths."
        }
      );
    }
    return cloneRuntimeToolCatalog(catalog);
  }

  async getResources(context: AdapterContext): Promise<readonly RuntimeResource[]> {
    const runtime = this.#runtime(context);
    if (runtime.control.runtimePolicy === "review_read_only") return [];
    // Pi startup is intentionally tolerant of invalid resources. Only the
    // current process' typed get_commands catalog proves that a command,
    // skill, or prompt from the exact immutable snapshot actually loaded.
    const [commands, toolCatalog] = await Promise.all([
      this.getCommands(context).catch(() => []),
      this.getRuntimeTools(context).catch(() => undefined)
    ]);
    return runtime.resources.map((resource) => ({
      ...resource,
      state: isRuntimeResourceProvenLoaded(resource, commands, toolCatalog?.tools ?? [])
        ? "loaded" as const
        : resource.state === "loaded" ? "approved" as const : resource.state,
      runtimeGeneration: runtime.transport.generation
    }));
  }

  /**
   * Atomically publish a complete immutable Agent Home generation. Existing
   * runtimes keep their original files, credentials, resources, and MCP grant;
   * only runtimes started after publication observe this snapshot. A retired
   * generation is released after its last runtime has confirmed exit.
   */
  async updateManagedGeneration(options: PiManagedGenerationOptions): Promise<void> {
    this.#assertNotDisposed();
    if (this.#reconfiguration) {
      throw piError("PI_RECONFIGURE_IN_PROGRESS", "A managed Pi generation update is already in progress", "provision", {
        retryable: true,
        recovery: "Wait for the current generation update to settle before submitting another snapshot."
      });
    }
    const nextAgentHome = normalizedAbsolutePath(options.agentHome, "PI_INVALID_AGENT_HOME", "Pi Agent Home");
    if (options.mcpBridge && !options.mcpBridge.token) {
      throw piError("PI_MCP_CREDENTIAL_MISSING", "MCP bridge token must be supplied through the managed credential channel", "provision");
    }
    const preferenceRevision = this.#silentEncryptedRetryPreferenceRevision;
    const nextOptions = copyAdapterOptions(
      {
        ...this.#options,
        agentHome: nextAgentHome,
        providers: options.providers ?? [],
        settings: options.settings,
        silentEncryptedRetryEnabled: options.silentEncryptedRetryEnabled ?? this.#silentEncryptedRetryEnabled,
        environment: options.environment,
        secretEnvironmentNames: options.secretEnvironmentNames,
        appendSystemPrompt: options.appendSystemPrompt,
        managedResources: options.managedResources,
        mcpBridge: options.mcpBridge,
        resolveMcpBridge: options.resolveMcpBridge,
        catalogGeneration: options.catalogGeneration,
        nativeAuthProviderIds: options.nativeAuthProviderIds ?? this.#options.nativeAuthProviderIds,
        nativeAuthenticatedProviderIds: options.nativeAuthenticatedProviderIds ?? this.#options.nativeAuthenticatedProviderIds,
        nativeModels: options.nativeModels ?? this.#options.nativeModels,
        loadNativeAuth: options.loadNativeAuth ?? this.#options.loadNativeAuth,
        persistNativeAuth: options.persistNativeAuth ?? this.#options.persistNativeAuth,
        ...(options.releaseManagedGeneration === undefined
          ? { releaseManagedGeneration: () => undefined }
          : { releaseManagedGeneration: options.releaseManagedGeneration })
      },
      nextAgentHome,
      this.#options.sessionRoot
    );
    validateNativeAuthOptions(nextOptions);

    const nextGeneration: PiManagedGeneration = {
      agentHome: nextAgentHome,
      options: nextOptions,
      references: 0,
      retired: false,
      released: false
    };
    const update = (async () => {
      const inUseSamePath = (
        samePath(this.#managedGeneration.agentHome, nextAgentHome) && this.#managedGeneration.references > 0
      ) || [...this.#runtimes.values()].some((runtime) => samePath(runtime.generationLease.generation.agentHome, nextAgentHome));
      if (inUseSamePath) {
        throw piError("PI_GENERATION_PATH_IN_USE", "A new immutable Pi generation cannot replace files used by an active runtime", "provision", {
          retryable: true,
          recovery: "Provision the new configuration under a distinct generation directory."
        });
      }
      try {
        nextGeneration.initialization = Promise.resolve(await this.#provisionGeneration(nextAgentHome, nextOptions));
        await this.#initializeSessionStore();
      } catch (error) {
        throw asPiError(error, {
          code: "PI_RECONFIGURE_PROVISION_FAILED",
          phase: "provision",
          retryable: true,
          recovery: "Repair the proposed immutable generation and retry; the active generation and native sessions were preserved."
        });
      }
      const previous = this.#managedGeneration;
      this.#managedGeneration = nextGeneration;
      this.#agentHome = nextAgentHome;
      this.#options = nextOptions;
      if (
        options.silentEncryptedRetryEnabled !== undefined
        && preferenceRevision === this.#silentEncryptedRetryPreferenceRevision
      ) {
        this.#silentEncryptedRetryEnabled = options.silentEncryptedRetryEnabled;
      }
      previous.retired = true;
      this.#releaseManagedGenerationIfUnused(previous);
    })();
    this.#reconfiguration = update;
    try {
      await update;
    } finally {
      if (this.#reconfiguration === update) this.#reconfiguration = undefined;
    }
  }

  async reconfigure(options: PiManagedGenerationOptions): Promise<void> {
    return this.updateManagedGeneration(options);
  }

  async dispose(): Promise<void> {
    if (this.#disposed && this.#runtimes.size === 0 && this.#runtimeStarts.size === 0 && this.#subagentObservers.size === 0) return;
    this.#disposed = true;
    const observerResults = await Promise.allSettled([...this.#subagentObservers.values()].map(async (observer) => {
      try {
        await observer.stopAndDrain();
      } finally {
        await observer.durableStore?.dispose();
      }
    }));
    this.#subagentObservers.clear();
    await Promise.allSettled([...this.#runtimeStarts.values()]);
    const runtimes = [...this.#runtimes.values()];
    const results = await Promise.allSettled(
      runtimes.map(async (runtime) => {
        await runtime.transport.terminate(runtime.generationLease.generation.options.shutdownTimeoutMs ?? 5_000);
        if (this.#runtimes.get(runtime.key) === runtime) this.#runtimes.delete(runtime.key);
        await runtime.eventChain.catch(() => undefined);
        await this.#finalizeRuntime(runtime);
      })
    );
    this.#runtimeStarts.clear();
    this.#artifactRefsBySession.clear();
    this.#managedGeneration.retired = true;
    this.#releaseManagedGenerationIfUnused(this.#managedGeneration);
    const failures = [...observerResults, ...results]
      .filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length > 0) {
      throw piError("PI_DISPOSE_INCOMPLETE", `Failed to confirm ${failures.length} Pi shutdown or attachment cleanup operation(s)`, "shutdown", {
        retryable: true,
        stateMayHaveChanged: true,
        recovery: "Keep their generations fenced, inspect the service-node processes, and call dispose again after cleanup.",
        cause: new AggregateError(failures.map((failure) => failure.reason), "Pi runtime shutdown failures")
      });
    }
  }

  // ---- Complete Pi RPC surface beyond the backend-neutral core contract ----

  async getState(context: AdapterContext): Promise<PiRpcState> {
    const response = await this.#runtime(context).transport.request({ type: "get_state" }, { signal: context.signal });
    return responseData(response) as PiRpcState;
  }

  async getMessages(context: AdapterContext): Promise<readonly PiProjectedMessage[]> {
    const runtime = this.#runtime(context);
    const response = await runtime.transport.request({ type: "get_messages" }, { signal: context.signal });
    const data = responseData(response);
    return isRecord(data) && Array.isArray(data.messages)
      ? projectPiMessages(data.messages, runtime.redactValues)
      : [];
  }

  async getRuntimeProcessUsage(): Promise<RuntimeProcessUsageSnapshot> {
    const inspect = this.#processSupervisor?.inspect;
    if (inspect === undefined) {
      throw piError(
        "PI_RUNTIME_PROCESS_USAGE_UNAVAILABLE",
        "This service node cannot inspect managed runtime processes",
        "resource",
        { retryable: true, recovery: "Use a service node with OS process inspection support." }
      );
    }
    const owned = [...this.#runtimes.values()].filter((runtime): runtime is PiRuntime & {
      readonly processIdentity: string;
      readonly processInstanceId: string;
    } => runtime.transport.pid !== undefined
      && runtime.processIdentity !== undefined
      && runtime.processInstanceId !== undefined
      && !runtime.transport.closed);
    const usage = await inspect.call(
      this.#processSupervisor,
      owned.map((runtime) => ({
        pid: runtime.transport.pid!,
        expectedIdentity: runtime.processIdentity
      }))
    ).catch((error) => {
      throw piError(
        "PI_RUNTIME_PROCESS_USAGE_FAILED",
        "Managed runtime process usage could not be inspected",
        "resource",
        {
          retryable: true,
          stateMayHaveChanged: false,
          recovery: "Retry after checking service-node process inspection support.",
          cause: error
        }
      );
    });
    const usageByPid = new Map(usage.map((item) => [item.pid, item] as const));
    return {
      capturedAt: Date.now(),
      processes: owned.flatMap((runtime) => {
        const pid = runtime.transport.pid!;
        const item = usageByPid.get(pid);
        if (
          item === undefined
          || this.#runtimes.get(runtime.key) !== runtime
          || runtime.transport.closed
        ) return [];
        return [{
          sessionId: runtime.key,
          generation: runtime.transport.generation,
          pid,
          cpuPercent: item.cpuPercent,
          memoryKb: item.memoryKb,
          processCount: item.processCount,
          terminable: true,
          processInstanceId: runtime.processInstanceId
        }];
      })
    };
  }

  /** Best-effort downward priority reconciliation for already-running local
   * runtimes. Normal priority is intentionally never restored in place. */
  async applyProcessPriorityToActive(
    priority: ManagedProcessPriority
  ): Promise<readonly ProcessPriorityResult[]> {
    if (priority === "normal") return [];
    const results: ProcessPriorityResult[] = [];
    for (const runtime of [...this.#runtimes.values()]) {
      const pid = runtime.transport.pid;
      if (
        runtime.context.target.remoteWorkspace !== undefined
        || runtime.transport.closed
        || pid === undefined
        || runtime.processIdentity === undefined
        || this.#processSupervisor === undefined
      ) continue;
      const currentIdentity = await this.#processSupervisor.capture(pid).catch(() => undefined);
      if (currentIdentity !== runtime.processIdentity) continue;
      const options = runtime.generationLease.generation.options;
      const result = await (options.applyProcessPriority ?? applyNewProcessPriority)(pid, priority);
      results.push(result);
      await options.onProcessPriorityResult?.({
        sessionId: runtime.key,
        generation: runtime.transport.generation,
        result
      });
    }
    return results;
  }

  async terminateRuntimeProcess(input: TerminateRuntimeProcessInput): Promise<void> {
    const runtime = this.#runtimes.get(input.sessionId);
    const pid = runtime?.transport.pid;
    if (
      runtime === undefined
      || runtime.transport.closed
      || pid === undefined
      || runtime.processIdentity === undefined
      || runtime.processInstanceId === undefined
      || runtime.transport.generation !== input.generation
      || pid !== input.pid
      || runtime.processInstanceId !== input.processInstanceId
    ) {
      throw piError(
        "PI_RUNTIME_PROCESS_FENCE_MISMATCH",
        "The selected runtime process is no longer the owned spawn instance",
        "shutdown",
        {
          retryable: true,
          stateMayHaveChanged: false,
          recovery: "Refresh runtime process usage before attempting termination again."
        }
      );
    }
    if (this.#processSupervisor === undefined) {
      throw piError(
        "PI_PROCESS_SUPERVISOR_REQUIRED",
        "Managed runtime termination requires an OS process identity supervisor",
        "shutdown",
        { retryable: true, recovery: "Use a service node with managed process supervision support." }
      );
    }

    // No later dispatch may enter this generation once termination begins,
    // even when the OS cannot confirm the final kill.
    runtime.transport.beginExternalTermination();
    const outcome = await this.#processSupervisor.terminate(
      pid,
      runtime.processIdentity,
      runtime.generationLease.generation.options.shutdownTimeoutMs ?? 5_000
    );
    if (outcome === "terminated") return;
    if (outcome === "unconfirmed") {
      throw piError(
        "PI_RUNTIME_PROCESS_EXIT_UNCONFIRMED",
        "The managed runtime process did not confirm exit",
        "shutdown",
        {
          retryable: true,
          stateMayHaveChanged: true,
          recovery: "Keep this generation fenced and inspect the service-node process before retrying."
        }
      );
    }
    throw piError(
      "PI_RUNTIME_PROCESS_FENCE_MISMATCH",
      "The selected runtime process exited or changed birth identity before termination",
      "shutdown",
      {
        retryable: true,
        stateMayHaveChanged: false,
        recovery: "Refresh runtime process usage; never retry against the old numeric PID."
      }
    );
  }

  async getAvailableModels(context: AdapterContext): Promise<readonly ProviderModel[]> {
    const runtime = this.#runtime(context);
    const response = await runtime.transport.request({ type: "get_available_models" }, { signal: context.signal });
    const data = responseData(response);
    if (!isRecord(data) || !Array.isArray(data.models)) return [];
    const stateBefore = await this.#requestState(runtime, context);
    const levels = await this.getAvailableThinkingLevels(context);
    const stateAfter = await this.#requestState(runtime, context);
    const currentModelBefore = piRpcModelIdentity(stateBefore.model);
    const currentModelAfter = piRpcModelIdentity(stateAfter.model);
    const stableCurrentModel = currentModelBefore !== undefined && samePiRpcModelIdentity(currentModelBefore, currentModelAfter)
      ? currentModelBefore
      : undefined;
    return Promise.all((data.models as PiRpcModel[]).map(async (model) =>
      modelFromRpc(
        model,
        samePiRpcModelIdentity(piRpcModelIdentity(model), stableCurrentModel) ? levels : undefined,
        await this.#runtimeModelSupportsFastMode(runtime, model.provider, model.id)
      )));
  }

  async cycleModel(context: AdapterContext): Promise<ProviderModel | undefined> {
    this.#assertReviewOperationAllowed(context, "cycle model");
    const runtime = this.#runtime(context);
    const model = await this.#runExclusiveSessionMutation(runtime, context, async () => {
      let accepted = false;
      try {
        const response = await runtime.transport.request(
          { type: "cycle_model" },
          { signal: context.signal, stateMayHaveChanged: true }
        );
        accepted = true;
        const data = responseData(response);
        if (data === null) return undefined;
        if (!isRecord(data) || !isRecord(data.model)) {
          throw piError(
            "PI_MODEL_CYCLE_INVALID_RESPONSE",
            "Pi acknowledged a model cycle without confirming the selected Provider and Model",
            "dispatch",
            { stateMayHaveChanged: true }
          );
        }
        const identity = piRpcModelIdentity(data.model);
        if (identity === undefined) {
          throw piError(
            "PI_MODEL_CYCLE_INVALID_RESPONSE",
            "Pi acknowledged a model cycle without confirming the selected Provider and Model",
            "dispatch",
            { stateMayHaveChanged: true }
          );
        }
        const rpcModel = data.model as PiRpcModel;
        const supportsFastMode = await this.#runtimeModelSupportsFastMode(runtime, identity.provider, identity.id);
        let policyAdvanced = false;
        if (runtime.control.fastMode && !supportsFastMode) {
          await this.#setFastModeWithinMutation(false, context, runtime);
          policyAdvanced = true;
        }
        if (!policyAdvanced) await advanceRuntimePolicy(runtime);
        this.#syncManagedSubagentObserver(runtime);
        const levels = await this.getAvailableThinkingLevels(context);
        const projected = modelFromRpc(rpcModel, levels, supportsFastMode);
        const responseEffort = typeof data.thinkingLevel === "string"
          && canonicalPiThinkingLevels([data.thinkingLevel]).length === 1
          ? data.thinkingLevel
          : undefined;
        const profile = this.#spawnProfiles.get(context.sessionId);
        if (profile) {
          this.#spawnProfiles.set(context.sessionId, {
            ...profile,
            providerId: projected.providerId,
            modelId: projected.modelId,
            ...(responseEffort === undefined ? {} : { effort: responseEffort })
          });
        }
        return projected;
      } catch (error) {
        if (accepted || isUnconfirmedSessionMutationError(error)) {
          return this.#failClosedUnconfirmedSessionMutation(
            runtime,
            "PI_MODEL_CYCLE_UNCONFIRMED",
            "Pi model cycling did not reach one confirmed runtime and host state",
            error
          );
        }
        throw error;
      }
    });
    await this.#compactAtConfiguredThreshold(runtime, context);
    return model;
  }

  async getAvailableThinkingLevels(context: AdapterContext): Promise<readonly string[]> {
    const response = await this.#runtime(context).transport.request({ type: "get_available_thinking_levels" }, { signal: context.signal });
    const data = responseData(response);
    return isRecord(data) && Array.isArray(data.levels) ? canonicalPiThinkingLevels(data.levels) : [];
  }

  async cycleEffort(context: AdapterContext): Promise<string | undefined> {
    this.#assertReviewOperationAllowed(context, "cycle reasoning effort");
    const runtime = this.#runtime(context);
    return this.#runExclusiveSessionMutation(runtime, context, async () => {
      let accepted = false;
      try {
        const response = await runtime.transport.request(
          { type: "cycle_thinking_level" },
          { signal: context.signal, stateMayHaveChanged: true }
        );
        accepted = true;
        const data = responseData(response);
        if (data === null) return undefined;
        const level = isRecord(data) && typeof data.level === "string"
          && canonicalPiThinkingLevels([data.level]).length === 1
          ? data.level
          : undefined;
        if (level === undefined) {
          throw piError(
            "PI_THINKING_LEVEL_CYCLE_INVALID_RESPONSE",
            "Pi acknowledged a thinking-level cycle without confirming the selected level",
            "dispatch",
            { stateMayHaveChanged: true }
          );
        }
        await advanceRuntimePolicy(runtime);
        this.#syncManagedSubagentObserver(runtime);
        const profile = this.#spawnProfiles.get(context.sessionId);
        if (profile) this.#spawnProfiles.set(context.sessionId, { ...profile, effort: level });
        return level;
      } catch (error) {
        if (accepted || isUnconfirmedSessionMutationError(error)) {
          return this.#failClosedUnconfirmedSessionMutation(
            runtime,
            "PI_THINKING_LEVEL_CYCLE_UNCONFIRMED",
            "Pi thinking-level cycling did not reach one confirmed runtime and host state",
            error
          );
        }
        throw error;
      }
    });
  }

  async setSteeringMode(mode: "all" | "one-at-a-time", context: AdapterContext): Promise<void> {
    const runtime = this.#runtime(context);
    await this.#runExclusiveSessionMutation(runtime, context, () =>
      runtime.transport.request(
        { type: "set_steering_mode", mode },
        { signal: context.signal, stateMayHaveChanged: true }
      ).then(() => undefined)
    );
  }

  async setFollowUpMode(mode: "all" | "one-at-a-time", context: AdapterContext): Promise<void> {
    const runtime = this.#runtime(context);
    await this.#runExclusiveSessionMutation(runtime, context, () =>
      runtime.transport.request(
        { type: "set_follow_up_mode", mode },
        { signal: context.signal, stateMayHaveChanged: true }
      ).then(() => undefined)
    );
  }

  async runBash(command: string, excludeFromContext: boolean, context: AdapterContext): Promise<PiDirectBashResult> {
    const runtime = this.#runtime(context);
    if (runtime.userShell !== undefined) {
      throw piError(
        "PI_BASH_ALREADY_RUNNING",
        "A Pi user shell command is already running for this native session",
        "dispatch",
        { recovery: "Abort or wait for the active user shell command before starting another." }
      );
    }
    if (context.signal.aborted) {
      throw piError("PI_REQUEST_ABORTED", "Pi user shell was aborted before dispatch", "dispatch", { retryable: true });
    }
    const callId = `user-shell-${randomUUID()}`;
    const commandGate = runtime.generationLease.generation.options.commandConcurrencyGate;
    const commandGateId = `${context.sessionId}:${context.generation}:${callId}`;
    const admission = await commandGate?.acquire({
      commandId: commandGateId,
      sessionId: context.sessionId,
      signal: context.signal
    });
    if (admission === "aborted") {
      throw piError("PI_REQUEST_ABORTED", "Pi user shell was aborted while waiting for command capacity", "dispatch", {
        retryable: true
      });
    }
    if (this.#runtimes.get(context.sessionId) !== runtime || runtime.transport.closed) {
      commandGate?.release(commandGateId, "runtime_changed");
      throw piError("PI_RUNTIME_NOT_ACTIVE", "Pi runtime closed while the user shell waited for command capacity", "dispatch", {
        retryable: true
      });
    }
    const commandDisplay = redactManagedSecrets(command, runtime.redactValues);
    const lifecycle: PiUserShellLifecycle = { context, callId, commandDisplay, excludeFromContext };
    runtime.userShell = lifecycle;
    let started = false;
    let removeContextAbort: (() => void) | undefined;
    try {
      await context.emit(
        {
          type: "tool_start",
          callId,
          name: "Shell",
          input: commandDisplay
        },
        userShellMetadata("bash_execution_start", lifecycle)
      );
      started = true;
      if (context.signal.aborted) {
        throw piError("PI_REQUEST_ABORTED", "Pi user shell was aborted before dispatch", "dispatch", { retryable: true });
      }
      const responsePending = runtime.transport.request(
        { type: "bash", command, excludeFromContext },
        {
          stateMayHaveChanged: true,
          timeoutMs: runtimeRpcTimeout(runtime, PI_USER_SHELL_RPC_TIMEOUT_MS),
          refreshTimeoutOnEvent: isPiBashProgressEvent
        }
      );
      const abortForContext = () => {
        // Do not reject responsePending on context cancellation: a late Bash
        // response would otherwise become an unknown protocol record. Convert
        // cancellation into Pi's native abort and retain ownership to terminal.
        void this.#requestBashAbort(runtime).catch(() => undefined);
      };
      context.signal.addEventListener("abort", abortForContext, { once: true });
      removeContextAbort = () => context.signal.removeEventListener("abort", abortForContext);
      if (context.signal.aborted) abortForContext();
      const response = await responsePending;
      removeContextAbort();
      removeContextAbort = undefined;
      await runtime.eventChain;
      const raw = normalizePiDirectBashResult(responseData(response), runtime.redactValues);
      let artifact: BlobRef | undefined;
      try {
        artifact = await materializeUserShellArtifact(runtime, raw, context, callId);
      } catch (error) {
        const publicError = error instanceof PiAdapterError
          ? error.publicError
          : {
              code: "PI_ARTIFACT_STORE_FAILED",
              message: "Pi user shell complete output could not be stored",
              phase: "stream" as const,
              retryable: true,
              stateMayHaveChanged: false,
              recovery: "The inline shell output remains available; retry after inspecting artifact storage."
            };
        await context.emit(
          {
            type: "error",
            error: publicError,
            terminal: false
          },
          userShellMetadata("bash_artifact_error", lifecycle)
        );
      }
      const result: PiDirectBashResult = {
        output: boundedUserShellOutput(raw.output),
        ...(raw.exitCode === undefined ? {} : { exitCode: raw.exitCode }),
        cancelled: raw.cancelled,
        truncated: raw.truncated || Buffer.byteLength(raw.output, "utf8") > INLINE_USER_SHELL_OUTPUT_LIMIT,
        ...(artifact === undefined ? {} : { artifact })
      };
      await context.emit(
        {
          type: "tool_result",
          callId,
          name: "Shell",
          output: userShellCompletionText(result),
          isError: result.cancelled || (result.exitCode !== undefined && result.exitCode !== 0),
          ...(artifact === undefined ? {} : { artifact })
        },
        userShellMetadata("bash_execution_end", lifecycle, {
          completed: true,
          exitCode: result.exitCode,
          cancelled: result.cancelled
        })
      );
      return result;
    } catch (error) {
      await runtime.eventChain.catch(() => undefined);
      if (started) {
        await context.emit(
          {
            type: "tool_result",
            callId,
            name: "Shell",
            output: redactManagedSecrets(redactedDiagnostic(error), runtime.redactValues),
            isError: true
          },
          userShellMetadata("bash_execution_failed", lifecycle, { completed: true })
        ).catch(() => undefined);
      }
      throw error;
    } finally {
      removeContextAbort?.();
      if (runtime.userShell === lifecycle) runtime.userShell = undefined;
      commandGate?.release(commandGateId, "user_shell_terminal");
    }
  }

  async abortBash(context: AdapterContext): Promise<void> {
    await this.#requestBashAbort(this.#runtime(context));
  }

  async #requestBashAbort(runtime: PiRuntime): Promise<void> {
    const lifecycle = runtime.userShell;
    if (lifecycle?.abortTask !== undefined) return lifecycle.abortTask;
    // Cancellation must not inherit the possibly-aborted caller signal. Once a
    // Bash command was dispatched, abort_bash is the only safe native cancel.
    const task = runtime.transport.request(
      { type: "abort_bash" },
      {
        stateMayHaveChanged: true,
        timeoutMs: runtimeRpcTimeout(runtime, PI_STANDARD_RPC_TIMEOUT_MS)
      }
    ).then(() => undefined);
    if (lifecycle !== undefined && runtime.userShell === lifecycle) lifecycle.abortTask = task;
    return task;
  }

  async executeUserShell(input: UserShellInput, context: AdapterContext): Promise<UserShellResult> {
    this.#assertReviewOperationAllowed(context, "execute shell");
    return this.runBash(input.command, input.excludeFromContext, context);
  }

  async abortUserShell(context: AdapterContext): Promise<void> {
    await this.abortBash(context);
  }

  async getSessionStats(context: AdapterContext): Promise<Record<string, unknown>> {
    const response = await this.#runtime(context).transport.request({ type: "get_session_stats" }, { signal: context.signal });
    const data = responseData(response);
    return isRecord(data) ? data : {};
  }

  async getEntries(since: string | undefined, context: AdapterContext): Promise<{ readonly entries: readonly PiRpcEntry[]; readonly leafId?: string }> {
    const runtime = this.#runtime(context);
    const raw = await this.#getEntriesRaw(since, runtime, context.signal);
    return {
      entries: raw.entries.map((entry) => redactPiRpcEntry(entry, runtime.redactValues)),
      ...(raw.leafId === undefined ? {} : { leafId: redactManagedSecrets(raw.leafId, runtime.redactValues) })
    };
  }

  async #getEntriesRaw(
    since: string | undefined,
    runtime: PiRuntime,
    signal: AbortSignal
  ): Promise<{ readonly entries: readonly PiRpcEntry[]; readonly leafId?: string }> {
    const response = await runtime.transport.request({ type: "get_entries", since }, { signal });
    return validatedPiEntriesResponse(responseData(response));
  }

  async getNativeHistoryProjection(context: AdapterContext): Promise<NativeHistoryProjection> {
    this.#assertReviewOperationAllowed(context, "read native history");
    const runtime = this.#runtime(context);
    const binding = context.binding;
    if (binding === undefined) {
      throw piError("PI_SESSION_BINDING_REQUIRED", "Pi native history projection requires an attached native session binding", "session");
    }
    const history = await this.#getEntriesRaw(undefined, runtime, context.signal);
    return projectPiNativeHistory(binding.nativeSessionId, {
      entries: await Promise.all(history.entries.map(async (entry) =>
        runtime.translator.materializeNativeHistoryEntry(toNativeHistoryEntry(entry)))),
      ...(history.leafId === undefined ? {} : { leafId: boundedNativeIdentifier(history.leafId, "leaf") })
    });
  }

  async getForkMessages(context: AdapterContext): Promise<readonly { readonly entryId: string; readonly text: string }[]> {
    this.#assertReviewOperationAllowed(context, "read fork history");
    const runtime = this.#runtime(context);
    const response = await runtime.transport.request({ type: "get_fork_messages" }, { signal: context.signal });
    const data = responseData(response);
    if (!isRecord(data) || !Array.isArray(data.messages)) return [];
    return data.messages.filter(
      (message): message is { entryId: string; text: string } => isRecord(message) && typeof message.entryId === "string" && typeof message.text === "string"
    ).map((message) => ({
      entryId: redactManagedSecrets(message.entryId, runtime.redactValues),
      text: redactManagedSecrets(message.text, runtime.redactValues)
    }));
  }

  async getLastAssistantText(context: AdapterContext): Promise<string | undefined> {
    const response = await this.#runtime(context).transport.request({ type: "get_last_assistant_text" }, { signal: context.signal });
    const data = responseData(response);
    return isRecord(data) && typeof data.text === "string" ? data.text : undefined;
  }

  async newNativeSession(parentSession: string | undefined, context: AdapterContext): Promise<NativeSessionBinding> {
    const runtime = this.#runtime(context);
    return this.#runExclusiveSessionMutation(runtime, context, async () => {
      let accepted = false;
      try {
        const safeParent = parentSession ? await this.#sessionStore.assertManagedSession(parentSession) : undefined;
        const response = await runtime.transport.request(
          { type: "new_session", parentSession: safeParent },
          {
            signal: context.signal,
            stateMayHaveChanged: true,
            timeoutMs: runtimeRpcTimeout(runtime, PI_LONG_RUNNING_RPC_TIMEOUT_MS)
          }
        );
        assertSessionChangeAccepted(response, "new_session");
        accepted = true;
        return await this.#refreshBinding(runtime);
      } catch (error) {
        if (accepted || isUnconfirmedSessionMutationError(error)) {
          return this.#failClosedUnconfirmedSessionMutation(
            runtime,
            "PI_NEW_SESSION_UNCONFIRMED",
            "Pi native-session creation did not reach one confirmed runtime and host binding",
            error
          );
        }
        throw error;
      }
    });
  }

  async switchNativeSession(path: string, context: AdapterContext): Promise<NativeSessionBinding> {
    const runtime = this.#runtime(context);
    return this.#runExclusiveSessionMutation(runtime, context, async () => {
      let accepted = false;
      try {
        const safePath = await this.#sessionStore.assertManagedSession(path);
        const response = await runtime.transport.request(
          { type: "switch_session", sessionPath: safePath },
          {
            signal: context.signal,
            stateMayHaveChanged: true,
            timeoutMs: runtimeRpcTimeout(runtime, PI_LONG_RUNNING_RPC_TIMEOUT_MS)
          }
        );
        assertSessionChangeAccepted(response, "switch_session");
        accepted = true;
        return await this.#refreshBinding(runtime);
      } catch (error) {
        if (accepted || isUnconfirmedSessionMutationError(error)) {
          return this.#failClosedUnconfirmedSessionMutation(
            runtime,
            "PI_SESSION_SWITCH_UNCONFIRMED",
            "Pi native-session switching did not reach one confirmed runtime and host binding",
            error
          );
        }
        throw error;
      }
    });
  }

  async listNativeSessions(targetOrWorkspace?: TargetDescriptor | string): Promise<readonly NativeSessionCandidate[]> {
    await this.#initialize();
    const workspaceRoot = typeof targetOrWorkspace === "string"
      ? targetOrWorkspace
      : targetOrWorkspace === undefined ? undefined : runtimeWorkspaceRoot(targetOrWorkspace);
    if (typeof targetOrWorkspace === "object") await this.validateTarget(targetOrWorkspace);
    const [managed, external] = await Promise.all([
      this.#sessionStore.list(workspaceRoot),
      typeof targetOrWorkspace === "object" && targetOrWorkspace.remoteWorkspace === undefined
        ? this.#sessionStore.listExternal(this.#externalSessionRoots, runtimeWorkspaceRoot(targetOrWorkspace))
        : Promise.resolve([])
    ]);
    const candidates: NativeSessionCandidate[] = managed.map((session) => ({
      nativeReference: session.path,
      ...(session.id === undefined ? {} : { nativeSessionId: session.id }),
      ...(session.name === undefined ? {} : { name: session.name }),
      ...(session.cwd === undefined ? {} : { workspaceRoot: session.cwd }),
      messageCount: session.messageCount,
      modifiedAt: session.modifiedAt,
      state: session.state
    }));
    if (typeof targetOrWorkspace === "object" && targetOrWorkspace.remoteWorkspace === undefined) {
      const scannedWorkspace = runtimeWorkspaceRoot(targetOrWorkspace);
      for (const [reference, source] of this.#externalSessionReferences) {
        if (samePath(source.workspaceRoot, scannedWorkspace)) this.#externalSessionReferences.delete(reference);
      }
    }
    for (const session of external) {
      this.#externalSessionReferences.set(session.source.reference, session.source);
      candidates.push({
        nativeReference: session.source.reference,
        ...(session.id === undefined ? {} : { nativeSessionId: session.id }),
        ...(session.name === undefined ? {} : { name: session.name }),
        ...(session.cwd === undefined ? {} : { workspaceRoot: session.cwd }),
        messageCount: session.messageCount,
        modifiedAt: session.modifiedAt,
        state: session.state
      });
    }
    candidates.sort((left, right) => right.modifiedAt - left.modifiedAt || left.nativeReference.localeCompare(right.nativeReference));
    return candidates;
  }

  async deleteNativeSession(path: string): Promise<string> {
    for (const runtime of this.#runtimes.values()) {
      if (samePath(runtime.binding.opaqueRef, resolve(path))) {
        throw piError("PI_SESSION_ACTIVE", "Cannot delete a native session while its runtime is active", "session", {
          recovery: "Detach or close the product session before deletion."
        });
      }
    }
    return this.#sessionStore.moveToTrash(path);
  }

  buildProcessSpecForTesting(args: readonly string[], cwd: string, env: Readonly<NodeJS.ProcessEnv>): PiProcessSpec {
    return { command: this.#command, args: [...this.#commandArgs, ...args], cwd, env };
  }

  async #initialize(generation?: PiManagedGeneration): Promise<PiInitializedGeneration> {
    this.#assertNotDisposed();
    if (generation === undefined) {
      const reconfiguration = this.#reconfiguration;
      if (reconfiguration) await reconfiguration;
      generation = this.#managedGeneration;
    }
    this.#assertNotDisposed();
    const selected = generation;
    selected.initialization ??= (async () => {
      await this.#initializeSessionStore();
      return this.#provisionGeneration(selected.agentHome, selected.options);
    })()
      .catch((error) => {
        selected.initialization = undefined;
        throw asPiError(error, {
          code: "PI_AGENT_HOME_PROVISION_FAILED",
          phase: "provision",
          retryable: true,
          recovery: "Repair ownership or managed Pi configuration and retry provisioning."
        });
      });
    return selected.initialization;
  }

  async #runtimeModelSupportsFastMode(runtime: PiRuntime, providerId: string, modelId: string): Promise<boolean> {
    const initialized = await this.#initialize(runtime.generationLease.generation);
    return mergeProviderModels(
      initialized.catalog.models,
      runtime.generationLease.generation.options.nativeModels ?? []
    ).some((model) =>
      model.providerId === providerId && model.modelId === modelId && model.supportsFastMode === true);
  }

  async #initializeSessionStore(): Promise<void> {
    this.#sessionInitialization ??= (async () => {
      await this.#sessionStore.initialize();
      await reconcileManagedSubagentAuthHomes(managedSubagentRunRoot(this.#sessionStore.root));
      const generationsRoot = this.#options.managedGenerationsRoot;
      if (generationsRoot !== undefined && this.#options.recoverManagedGenerationsOnInitialize !== false) {
        await this.#recoverManagedGenerationTree(generationsRoot, this.#options.shutdownTimeoutMs ?? 5_000);
      }
    })().catch((error) => {
      this.#sessionInitialization = undefined;
      throw error;
    });
    return this.#sessionInitialization;
  }

  async #provisionGeneration(agentHome: string, options: PiAdapterOptions): Promise<PiInitializedGeneration> {
    const catalog = await provisionManagedCatalog(agentHome, options.providers ?? [], options.settings);
    await this.#prepareGenerationRuntimeRoot(agentHome, options);
    const approvedResourceRoot = join(agentHome, "managed", "approved-resources");
    assertContained(join(agentHome, "managed"), approvedResourceRoot, "approved resource generation");
    await rm(approvedResourceRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    const [bridgePath, subagentPath, silentEncryptedRetryPath, snapshot] = await Promise.all([
      provisionManagedBridge(agentHome),
      provisionManagedSubagent(agentHome),
      provisionManagedSilentEncryptedRetry(agentHome),
      snapshotManagedRuntimeResources({
        snapshot: options.managedResources,
        destinationRoot: approvedResourceRoot,
        maxFiles: options.managedResourceMaxFiles,
        maxBytes: options.managedResourceMaxBytes
      })
    ]);
    return {
      catalog,
      bridgePath,
      subagentPath,
      silentEncryptedRetryPath,
      managedResources: {
        extensions: snapshot.directExtensionPaths,
        skills: snapshot.directSkillPaths,
        prompts: snapshot.directPromptTemplatePaths,
        packages: snapshot.packagePaths,
        resources: snapshot.resources
      }
    };
  }

  async #probeVersion(): Promise<{ version?: string; error?: string }> {
    this.#versionProbe ??= (async () => {
      const environment = this.#baseEnvironment();
      const proxySecrets = credentialedProxySecrets(environment);
      try {
        const output = this.#options.versionProbe
          ? await this.#options.versionProbe()
          : (
              await execFileAsync(this.#command, [...this.#commandArgs, "--version"], {
                windowsHide: true,
                timeout: 10_000,
                env: environment
              })
            ).stdout;
        const match = String(output).match(/\b(\d+\.\d+\.\d+)\b/);
        if (!match?.[1]) throw new Error("Pi --version did not return a semantic version");
        return { version: match[1] };
      } catch (error) {
        return { error: redactManagedSecrets(redactedDiagnostic(error), proxySecrets.values) };
      }
    })();
    return this.#versionProbe;
  }

  async #probeCompatibility(): Promise<PiCompatibilityOutcome> {
    this.#compatibilityProbe ??= (async () => {
      const environment = this.#baseEnvironment();
      const proxySecrets = credentialedProxySecrets(environment);
      try {
        const identity = await canonicalPiExecutableIdentity(this.#command, this.#commandArgs, environment);
        const cache = this.#usesDefaultProcessFactory || this.#usesBundledCommand
          ? DEFAULT_EXECUTABLE_COMPATIBILITY_CACHE
          : new Map<string, Promise<PiCompatibilityOutcome>>();
        const cached = cache.get(identity);
        if (cached !== undefined) return cached;
        const pending = probePiExecutable({
          command: this.#command,
          commandArgs: this.#commandArgs,
          // An injected factory is an in-memory runtime seam, not executable
          // compatibility evidence for the bundled command it replaces.
          processFactory: this.#usesBundledCommand ? spawnPiProcess : this.#processFactory,
          environment,
          startupTimeoutMs: this.#options.startupTimeoutMs,
          shutdownTimeoutMs: this.#options.shutdownTimeoutMs,
          maxRecordBytes: this.#options.maxRecordBytes,
          redactValues: proxySecrets.values
        }).then((report): PiCompatibilityOutcome => ({ status: "compatible", report }))
          .catch((error): PiCompatibilityOutcome => {
            const failure = asPiError(error, {
              code: "PI_EXECUTABLE_INCOMPATIBLE",
              phase: "probe",
              recovery: "Install a compatible executable before probing again."
            }, proxySecrets.values);
            return {
              status: "incompatible",
              diagnostic: `PI_EXECUTABLE_INCOMPATIBLE: ${failure.publicError.message}`,
              cause: failure
            };
          });
        cache.set(identity, pending);
        return pending;
      } catch (error) {
        const failure = asPiError(error, {
          code: "PI_EXECUTABLE_INCOMPATIBLE",
          phase: "probe",
          recovery: "Install a compatible executable before probing again."
        }, proxySecrets.values);
        return {
          status: "incompatible",
          diagnostic: `PI_EXECUTABLE_INCOMPATIBLE: ${failure.publicError.message}`,
          cause: failure
        };
      }
    })();
    return this.#compatibilityProbe;
  }

  async #requireCompatibility(): Promise<PiCompatibilityReport> {
    const outcome = await this.#probeCompatibility();
    if (outcome.status === "compatible") return outcome.report;
    throw piError("PI_EXECUTABLE_INCOMPATIBLE", "The configured Pi executable failed its typed RPC compatibility probe", "probe", {
      retryable: false,
      stateMayHaveChanged: false,
      recovery: "Install a compatible executable and retry; no replacement product Session was created.",
      cause: outcome.cause
    });
  }

  async #ensureRuntime(binding: NativeSessionBinding, profile: SessionSpawnProfile, context: AdapterContext): Promise<PiRuntime> {
    const active = this.#runtimes.get(context.sessionId);
    if (active) {
      this.#touchRuntime(active, context);
      if (!samePath(active.binding.opaqueRef, binding.opaqueRef)) {
        throw piError("PI_SESSION_BINDING_MISMATCH", "Active Pi runtime is bound to a different native session", "session");
      }
      return active;
    }
    return this.#startRuntime(binding, profile, context);
  }

  async #startRuntime(binding: NativeSessionBinding | undefined, profile: SessionSpawnProfile, context: AdapterContext): Promise<PiRuntime> {
    const pending = this.#runtimeStarts.get(context.sessionId);
    if (pending) {
      const runtime = await pending;
      this.#touchRuntime(runtime, context);
      if (binding && !samePath(runtime.binding.opaqueRef, binding.opaqueRef)) {
        throw piError("PI_SESSION_BINDING_MISMATCH", "Concurrent Pi runtime start used a different native session", "session");
      }
      return runtime;
    }
    const reconfiguration = this.#reconfiguration;
    if (reconfiguration) await reconfiguration;
    this.#assertNotDisposed();
    await this.#requireCompatibility();
    const managedGeneration = this.#managedGeneration;
    const start = this.#spawnRuntime(binding, profile, context, managedGeneration)
      .finally(() => this.#runtimeStarts.delete(context.sessionId));
    this.#runtimeStarts.set(context.sessionId, start);
    return start;
  }

  async #spawnRuntime(
    binding: NativeSessionBinding | undefined,
    profile: SessionSpawnProfile,
    context: AdapterContext,
    managedGeneration: PiManagedGeneration
  ): Promise<PiRuntime> {
    this.#retainManagedGeneration(managedGeneration);
    const options = managedGeneration.options;
    const agentHome = managedGeneration.agentHome;
    const generationLease: PiManagedGenerationLease = { generation: managedGeneration, released: false };
    const releaseUnpublished = (): void => {
      this.#releaseManagedGenerationLease(generationLease);
    };
    const { catalog, bridgePath, subagentPath, silentEncryptedRetryPath, managedResources } = await this.#initialize(managedGeneration).catch((error) => {
      releaseUnpublished();
      throw error;
    });
    try {
      await this.validateTarget(context.target);
      if (binding) await this.#sessionStore.assertManagedSession(binding.opaqueRef);
      const agentResourceSettings = readAgentResourceSettings(options.readAgentResourceSettings);
      const managedSubagentToolsEnabled = profile.runtimePolicy === "standard"
        && (options.includeManagedSubagentTools?.(context) ?? true);
      const collaborationSettings = managedSubagentToolsEnabled
        ? readCollaborationSettings(options.readCollaborationSettings)
        : { ...DEFAULT_COLLABORATION_SETTINGS };
      if (profile.initialFastMode) {
        const selected = profile.providerId !== undefined && profile.modelId !== undefined
          ? mergeProviderModels(catalog.models, options.nativeModels ?? []).find((model) =>
              model.providerId === profile.providerId && model.modelId === profile.modelId)
          : undefined;
        if (selected?.supportsFastMode !== true) {
          throw piError(
            "PI_FAST_MODE_MODEL_REQUIRED",
            "Creating a Fast Mode session requires an explicitly eligible model",
            "provision",
            { recovery: "Select a model whose catalog descriptor advertises Fast Mode." }
          );
        }
      }

    const runtimeDirectory = join(agentHome, "runtime", `${stableSessionKey(context.sessionId)}-g${context.generation}`);
    const runtimeRoot = join(agentHome, "runtime");
    const runtimeAgentHomePath = join(runtimeDirectory, "agent-home");
    await this.#prepareRuntimeDirectory(agentHome, runtimeDirectory);
    const sessionKey = stableSessionKey(context.sessionId);
    const spawnIdentity = stableSpawnIdentity(agentHome, this.#sessionStore.sessionsRoot, sessionKey, context.generation);
    const ownerPath = join(runtimeDirectory, RUNTIME_OWNER_FILE);
    await atomicWriteJson(ownerPath, {
      format: 1,
      spawnIdentity,
      sessionKey,
      productGeneration: context.generation,
      state: "reserved"
    } satisfies PiRuntimeOwnerManifest);
    await chmod(ownerPath, 0o600);
    const controlPath = join(runtimeDirectory, "control.json");
    const silentEncryptedRetryControlPath = join(runtimeDirectory, "silent-encrypted-retry.json");
    const artifactDirectory = join(runtimeDirectory, "artifacts");
    const control: PiRuntimeControl = {
      generation: context.generation,
      policyGeneration: 0,
      permissionMode: profile.initialPermissionMode,
      planMode: profile.initialPlanMode,
      fastMode: profile.initialFastMode,
      approvedRoots: context.target.remoteWorkspace === undefined
        ? await validateApprovedDirectories(context.extraDirectories ?? [], context.target.workspaceRoot)
        : [],
      runtimePolicy: profile.runtimePolicy,
      writtenAt: new Date().toISOString()
    };
    await writeRuntimeControl(controlPath, {
      generation: context.generation,
      policyGeneration: control.policyGeneration,
      permissionMode: control.permissionMode,
      planMode: control.planMode,
      fastMode: control.fastMode,
      approvedRoots: control.approvedRoots,
      runtimePolicy: control.runtimePolicy
    });
    await writeSilentEncryptedRetryControl(
      silentEncryptedRetryControlPath,
      context.generation,
      this.#silentEncryptedRetryEnabled
    );
    const targetResources = profile.runtimePolicy === "review_read_only" ? undefined : context.target.trusted
      ? await options.resolveTargetResources?.(context)
      : undefined;
    const [managedResourceSnapshot, projectResourceSnapshot] = profile.runtimePolicy === "review_read_only" ? [
      { extensionPaths: [], skillPaths: [], promptTemplatePaths: [], resources: [] },
      { skillPaths: [], resources: [] }
    ] : await Promise.all([
      snapshotManagedRuntimeResources({
        snapshot: mergeManagedResourceSnapshots(managedResources, targetResources),
        destinationRoot: join(runtimeDirectory, "resources", "managed"),
        maxFiles: options.managedResourceMaxFiles,
        maxBytes: options.managedResourceMaxBytes
      }),
      context.target.remoteWorkspace === undefined
        ? snapshotApprovedProjectResources({
            workspaceRoot: context.target.workspaceRoot,
            destinationRoot: join(runtimeDirectory, "resources", "project"),
            trusted: context.target.trusted,
            approve: options.approveProjectSkill,
            maxFiles: options.projectResourceMaxFiles,
            maxBytes: options.projectResourceMaxBytes
          })
        : Promise.resolve({ skillPaths: [], resources: [] })
    ]).catch((error) => {
      throw asPiError(error, {
        code: "PI_RESOURCE_SNAPSHOT_FAILED",
        phase: "resource",
        retryable: true,
        recovery: "Retry after the trusted project resources stop changing or reject the unsafe resource."
      });
    });

    const mcpBridge = profile.runtimePolicy === "review_read_only"
      ? undefined
      : await options.resolveMcpBridge?.(context) ?? options.mcpBridge;
    if (mcpBridge !== undefined && !mcpBridge.token) {
      throw piError("PI_MCP_CREDENTIAL_MISSING", "MCP bridge token must be supplied through the managed credential channel", "spawn");
    }
    if (managedSubagentToolsEnabled && mcpBridge?.nativeAuthLease !== undefined
        && !/^[A-Za-z0-9_-]{43}$/u.test(mcpBridge.nativeAuthReservationToken ?? "")) {
      throw piError(
        "PI_NATIVE_AUTH_RESERVATION_CREDENTIAL_MISSING",
        "Managed runner registration requires a dedicated launch credential",
        "spawn"
      );
    }
    let mcpDescriptorPath: string | undefined;
    if (mcpBridge !== undefined) {
      mcpDescriptorPath = join(runtimeDirectory, "mcp.json");
      await writeMcpDescriptor(mcpDescriptorPath, {
        endpoint: mcpBridge.endpoint,
        generation: context.generation,
        sessionId: context.sessionId,
        targetId: context.target.id,
        tools: mcpBridge.tools,
        ...(mcpBridge.nativeAuthLease === undefined ? {} : { nativeAuthLease: mcpBridge.nativeAuthLease })
      });
    }

    const args = [
      ...this.#commandArgs,
      "--mode",
      "rpc",
      "--session-dir",
      this.#sessionStore.sessionsRoot,
      "--no-approve",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--offline"
    ];
    for (const extensionPath of managedResourceSnapshot.extensionPaths) args.push("--extension", extensionPath);
    args.push("--extension", silentEncryptedRetryPath);
    // The policy bridge must be the final tool_call handler. Approved managed
    // extensions and the service-owned subagent tools load first, so no later
    // handler can mutate arguments after the final permission decision.
    if (managedSubagentToolsEnabled) args.push("--extension", subagentPath);
    args.push("--extension", bridgePath);
    for (const skillPath of [...managedResourceSnapshot.skillPaths, ...projectResourceSnapshot.skillPaths]) args.push("--skill", skillPath);
    for (const promptPath of managedResourceSnapshot.promptTemplatePaths) args.push("--prompt-template", promptPath);
    if (binding) args.push("--session", binding.opaqueRef);
    else args.push("--session-id", stableNativeSessionId(context.sessionId, context.generation));
    if (profile.providerId) args.push("--provider", profile.providerId);
    if (profile.modelId) args.push("--model", profile.modelId);
    if (profile.effort) args.push("--thinking", profile.effort);
    const makerMemoryPrompt = profile.runtimePolicy === "review_read_only"
      ? undefined
      : options.resolveMakerMemoryPrompt?.(context);
    const appendPrompt = [DEFAULT_APPEND_SYSTEM_PROMPT, options.appendSystemPrompt, makerMemoryPrompt, profile.appendSystemPrompt].filter(Boolean).join("\n\n");
    if (appendPrompt) args.push("--append-system-prompt", appendPrompt);

    const baseEnvironment = this.#baseEnvironment();
    const configuredEnvironment: NodeJS.ProcessEnv = {
      ...baseEnvironment,
      ...options.environment,
      ...catalog.keylessEnvironment
    };
    const proxySecrets = credentialedProxySecrets(configuredEnvironment);
    const secretNames = new Set<string>([
      ...catalog.secretEnvironmentNames,
      ...(options.secretEnvironmentNames ?? []),
      ...Object.keys(options.environment ?? {}).filter((name) => /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/i.test(name)),
      ...proxySecrets.names,
      "JOKO_PI_MCP_TOKEN",
      "JOKO_PI_NATIVE_AUTH_RESERVATION_TOKEN"
    ]);
    const subagentCredentialNames = new Set<string>([
      ...[...secretNames].filter((name) => name !== "JOKO_PI_NATIVE_AUTH_RESERVATION_TOKEN"),
      ...Object.keys(catalog.keylessEnvironment)
    ]);
    const env: NodeJS.ProcessEnv = {
      ...baseEnvironment,
      ...options.environment,
      ...catalog.keylessEnvironment,
      PI_CODING_AGENT_DIR: runtimeAgentHomePath,
      PI_CODING_AGENT_SESSION_DIR: this.#sessionStore.sessionsRoot,
      PI_SKIP_VERSION_CHECK: "1",
      JOKO_PI_CONTROL_FILE: controlPath,
      [SILENT_ENCRYPTED_RETRY_CONTROL_ENV]: silentEncryptedRetryControlPath,
      JOKO_PI_WORKSPACE_ROOT: runtimeWorkspaceRoot(context.target),
      JOKO_PI_TARGET_ID: context.target.id,
      JOKO_PI_GENERATION: String(context.generation),
      JOKO_PI_SPAWN_IDENTITY: spawnIdentity,
      ...(context.target.remoteWorkspace === undefined ? {} : {
        JOKO_PI_REMOTE_RECOVERY_IDENTITY: stableRemoteRecoveryIdentity(
          context.sessionId,
          context.target.id,
          context.target.remoteWorkspace.hostId
        )
      }),
      JOKO_PI_RUNTIME_POLICY: profile.runtimePolicy,
      JOKO_PI_ARTIFACT_CAPACITY_BYTES: String(requireArtifactCapacity(context)),
      JOKO_PI_SECRET_ENV_NAMES: JSON.stringify([...secretNames].sort()),
      ...(managedSubagentToolsEnabled ? {
        [MANAGED_SUBAGENT_PRODUCT_SESSION_ENV]: context.sessionId,
        [MANAGED_SUBAGENT_RUN_ROOT_ENV]: managedSubagentRunRoot(this.#sessionStore.root),
        [MANAGED_SUBAGENT_NODE_ENV]: process.execPath,
        JOKO_PI_NATIVE_AUTH_PROVIDER_IDS: JSON.stringify(options.nativeAuthProviderIds ?? []),
        JOKO_PI_NATIVE_AUTHENTICATED_PROVIDER_IDS: JSON.stringify(options.nativeAuthenticatedProviderIds ?? []),
        JOKO_PI_SUBAGENT_CREDENTIAL_ENV_NAMES: JSON.stringify([...subagentCredentialNames].sort())
      } : {})
    };
    if (context.target.remoteWorkspace === undefined) {
      Object.assign(env, toolchainThreadEnvironment(agentResourceSettings, env));
      if (managedSubagentToolsEnabled) {
        env.JOKO_PI_WORKER_SOFT_LIMIT = String(collaborationSettings.workerSoftLimit);
        env.JOKO_PI_WORKER_HARD_LIMIT = String(collaborationSettings.workerHardLimit);
        env.JOKO_PI_WORKER_IDLE_RELEASE_MINUTES = String(collaborationSettings.workerIdleReleaseMinutes);
      }
    }
    // Pi writes truncated full bash output through os.tmpdir(). Keep it inside
    // the generation-scoped runtime root so the host can validate and redact it
    // before materializing an Artifact.
    env.TEMP = artifactDirectory;
    env.TMP = artifactDirectory;
    env.TMPDIR = artifactDirectory;
    await mkdir(artifactDirectory, { recursive: true });
    if (mcpDescriptorPath && mcpBridge) {
      env.JOKO_PI_MCP_DESCRIPTOR_FILE = mcpDescriptorPath;
      env.JOKO_PI_MCP_TOKEN = mcpBridge.token;
      if (mcpBridge.nativeAuthReservationToken !== undefined) {
        env.JOKO_PI_NATIVE_AUTH_RESERVATION_TOKEN = mcpBridge.nativeAuthReservationToken;
      }
      env.NO_PROXY = mergeNoProxy(env.NO_PROXY);
    }
    validateEnvironment(env);
    let preparedAgentHome: PreparedRuntimeAgentHome | undefined;
    let transport: PiRpcTransport | undefined;
    let acquiredManagedDurableStore: PiManagedDurableStore | undefined;
    let redactValues: string[] = [...proxySecrets.values];
    try {
      preparedAgentHome = await this.#prepareRuntimeAgentHome(runtimeDirectory, context.generation, managedGeneration);
      redactValues = [
        ...[...secretNames]
          .map((name) => env[name])
          .filter((value): value is string => typeof value === "string" && value.length > 0),
        ...proxySecrets.values,
        ...preparedAgentHome.redactValues
      ];
      if (mcpBridge?.token) redactValues.push(mcpBridge.token);
      const process = await this.#processFactory({
        command: this.#command,
        args,
        cwd: runtimeWorkspaceRoot(context.target),
        env,
        ...(context.target.remoteWorkspace === undefined
          ? {}
          : { remoteWorkspace: context.target.remoteWorkspace })
      });
      if (context.target.remoteWorkspace === undefined && process.pid !== undefined) {
        const result = await (options.applyProcessPriority ?? applyNewProcessPriority)(
          process.pid,
          agentResourceSettings.processPriority
        ).catch((): ProcessPriorityResult => ({
          requested: agentResourceSettings.processPriority,
          application: "failed",
          appliesToNewProcessesOnly: true,
          backgroundPolicyApplied: false
        }));
        try { options.onProcessPriorityResult?.({ sessionId: context.sessionId, generation: context.generation, result }); }
        catch { /* The observer cannot change process ownership or startup. */ }
      }
      transport = new PiRpcTransport({
        process,
        generation: context.generation,
        requestTimeoutMs: options.requestTimeoutMs,
        maxRecordBytes: options.maxRecordBytes,
        redactValues
      });
      await transport.recoverService();
      let processIdentity: string | undefined;
      let processInstanceId: string | undefined;
      if (
        context.target.remoteWorkspace === undefined
        && this.#processSupervisor !== undefined
        && process.pid !== undefined
      ) {
        processIdentity = await this.#processSupervisor.capture(process.pid);
        if (processIdentity === undefined) {
          const stderr = transport.stderrTail.trim();
          const detail = stderr.length === 0 ? "" : `: ${stderr.slice(-2_048)}`;
          throw piError("PI_PROCESS_IDENTITY_UNAVAILABLE", `Pi exited before its managed spawn identity could be recorded${detail}`, "spawn", {
            retryable: true,
            recovery: "Retry the same native session after inspecting the Pi startup diagnostics."
          });
        }
        await atomicWriteJson(ownerPath, {
          format: 1,
          spawnIdentity,
          sessionKey,
          productGeneration: context.generation,
          state: "running",
          pid: process.pid,
          processIdentity
        } satisfies PiRuntimeOwnerManifest);
        await chmod(ownerPath, 0o600);
        processInstanceId = randomUUID();
      } else {
        await atomicWriteJson(ownerPath, {
          format: 1,
          spawnIdentity,
          sessionKey,
          productGeneration: context.generation,
          state: "running"
        } satisfies PiRuntimeOwnerManifest);
        await chmod(ownerPath, 0o600);
      }
      const temporaryBinding: NativeSessionBinding = {
        opaqueRef: binding?.opaqueRef ?? join(
          this.#sessionStore.sessionsRoot,
          `${stableNativeSessionId(context.sessionId, context.generation)}.jsonl`
        ),
        nativeSessionId: binding?.nativeSessionId,
        generation: context.generation
      };
      let managedDurableStore: PiManagedDurableStore | undefined;
      if (managedSubagentToolsEnabled && context.target.remoteWorkspace !== undefined) {
        const registry = options.managedDurableStoreRegistry;
        if (registry === undefined) {
          throw piError("PI_REMOTE_SUBAGENT_STORE_UNAVAILABLE", "Remote managed Subagent storage is unavailable", "spawn", {
            retryable: true,
            recovery: "Restore the authenticated remote durable-run control plane before attaching this Session."
          });
        }
        managedDurableStore = await registry.storeFor({
          sessionId: context.sessionId,
          targetId: context.target.id,
          bindingOpaqueRef: temporaryBinding.opaqueRef,
          generation: context.generation
        });
        if (managedDurableStore === undefined) {
          throw piError("PI_REMOTE_SUBAGENT_STORE_UNAVAILABLE", "Remote managed Subagent storage could not recover its launch authority", "spawn", {
            retryable: true,
            stateMayHaveChanged: true,
            recovery: "Revalidate the remote launch authority before attaching or controlling delegated runs."
          });
        }
        acquiredManagedDurableStore = managedDurableStore;
      }
      const runtime: PiRuntime = {
        key: context.sessionId,
        transport,
        ...(processIdentity === undefined ? {} : { processIdentity }),
        ...(processInstanceId === undefined ? {} : { processInstanceId }),
        bridgePath,
        subagentPath,
        managedSubagentToolsEnabled,
        ...(managedDurableStore === undefined ? {} : { managedDurableStore }),
        runtimeDirectory,
        runtimeRoot,
        ...(preparedAgentHome.nativeAuth === undefined ? {} : { nativeAuth: preparedAgentHome.nativeAuth }),
        controlPath,
        silentEncryptedRetryControlPath,
        artifactDirectory,
        redactValues,
        resources: [...managedResourceSnapshot.resources, ...projectResourceSnapshot.resources],
        generationLease,
        translator: undefined as unknown as PiEventTranslator,
        context,
        binding: temporaryBinding,
        control,
        autoRetry: options.settings?.retry?.enabled ?? true,
        autoCompaction: options.settings?.compaction?.enabled ?? true,
        compactionMemoryEnabled: options.isCompactionMemoryEnabled?.(context) === true,
        autoCompactionThresholdPercent: configuredAutoCompactionThresholdPercent(options.settings),
        ready: false,
        abortRequested: false,
        toolCatalogAssembler: new PiRuntimeToolCatalogAssembler(),
        sessionMutationTail: Promise.resolve(),
        eventChain: Promise.resolve()
      };
      runtime.translator = new PiEventTranslator({
        context,
        artifactDirectory,
        wasAbortRequested: () => runtime.abortRequested,
        redactValues,
        artifactCache: this.#artifactRefsBySession.get(context.sessionId) ?? this.#createArtifactRefCache(context.sessionId)
      });
      this.#runtimes.set(context.sessionId, runtime);
      this.#wireRuntime(runtime);

      const response = await transport.request(
        { type: "get_state" },
        { timeoutMs: options.startupTimeoutMs ?? 30_000, signal: context.signal }
      );
      const state = responseData(response) as PiRpcState;
      assertCompatibleState(state);
      const commandCatalog = responseData(await transport.request(
        { type: "get_commands" },
        { timeoutMs: options.startupTimeoutMs ?? 30_000, signal: context.signal }
      ));
      assertManagedBridgeHandshake(commandCatalog, bridgePath);
      if (managedSubagentToolsEnabled) assertManagedSubagentControlHandshake(commandCatalog, subagentPath);
      const safePath = await this.#sessionStore.assertManagedSessionReference(state.sessionFile!, { requireExists: binding !== undefined });
      runtime.binding = { opaqueRef: safePath, nativeSessionId: state.sessionId, generation: context.generation };
      await runtime.eventChain;
      runtime.ready = true;
      if (managedSubagentToolsEnabled) await this.#observeManagedSubagents(runtime);
      return runtime;
    } catch (error) {
      let shutdownError: unknown;
      let storeDisposeError: unknown;
      if (transport) {
        try {
          await transport.terminate(options.shutdownTimeoutMs ?? 5_000);
        } catch (caught) {
          shutdownError = caught;
        }
      }
      if (acquiredManagedDurableStore !== undefined) {
        try {
          await acquiredManagedDurableStore.dispose();
        } catch (caught) {
          storeDisposeError = caught;
        }
      }
      const current = this.#runtimes.get(context.sessionId);
      if (shutdownError !== undefined || storeDisposeError !== undefined) {
        const cleanupFailure = piError("PI_RUNTIME_START_CLEANUP_FAILED", "Pi startup failed and its process or remote attachment cleanup could not be confirmed", "shutdown", {
          retryable: true,
          stateMayHaveChanged: true,
          recovery: "Keep this generation fenced, inspect the service-node process, and dispose it before retrying startup.",
          cause: new AggregateError(
            [error, shutdownError, storeDisposeError].filter((value) => value !== undefined),
            "Pi startup and cleanup failures"
          )
        });
        throw asPiError(cleanupFailure, {
          code: "PI_RUNTIME_START_CLEANUP_FAILED",
          phase: "shutdown",
          retryable: true,
          stateMayHaveChanged: true,
          recovery: "Keep this generation fenced, inspect the service-node process, and dispose it before retrying startup."
        }, redactValues);
      }
      if (current !== undefined && current.transport === transport) {
        this.#runtimes.delete(context.sessionId);
        await this.#finalizeRuntime(current);
      } else {
        await this.#removeRuntimeDirectory(runtimeRoot, runtimeDirectory);
      }
      throw asPiError(error, {
        code: "PI_RUNTIME_START_FAILED",
        phase: "handshake",
        retryable: true,
        stateMayHaveChanged: false,
        recovery: "Correct Pi configuration or credentials and resume the same native session; no fresh fallback was performed."
      }, redactValues);
    }
    } catch (error) {
      if (![...this.#runtimes.values()].some((runtime) => runtime.generationLease === generationLease)) {
        releaseUnpublished();
      }
      throw error;
    }
  }

  #wireRuntime(runtime: PiRuntime): void {
    const isCurrent = () => this.#runtimes.get(runtime.key) === runtime && runtime.transport.generation === runtime.context.generation;
    runtime.transport.onEvent((event) => {
      const rawEvent = event as unknown as Record<string, unknown>;
      if (event.type === "compaction_end" && runtime.compactionMemoryEnabled) {
        const result = isRecord(rawEvent.result) ? rawEvent.result : undefined;
        const summary = typeof result?.summary === "string" ? result.summary.trim() : "";
        if (summary !== "") {
          const reason = typeof rawEvent.reason === "string" ? rawEvent.reason : "auto";
          runtime.eventChain = runtime.eventChain.then(async () => {
            if (!isCurrent()) return;
            await runtime.generationLease.generation.options.onCompactionDigest?.({
              backendId: this.id,
              targetId: runtime.context.target.id,
              sessionId: runtime.context.sessionId,
              summary,
              reason
            });
          }).catch(() => undefined);
        }
      }
      if (
        runtime.thresholdCompaction !== undefined
        && (event.type === "compaction_start" || event.type === "compaction_end")
        && rawEvent.reason === "manual"
      ) {
        // The Adapter publishes this operation with the truthful `threshold`
        // reason. Suppress the stock manual wrapper events emitted by the only
        // available RPC command so the timeline has one lifecycle, not two.
        return;
      }
      const lifecycle = runtime.lifecycle;
      const runningExtensionCommand = runtime.runningExtensionCommand;
      const userShell = event.type === "bash_execution_update" ? runtime.userShell : undefined;
      let failureContext = userShell?.context ?? runningExtensionCommand?.context ?? lifecycle?.currentContext ?? runtime.context;
      if (event.type === "agent_start" && lifecycle !== undefined) lifecycle.agentStarted = true;
      if (event.type === "agent_settled" && lifecycle !== undefined) {
        lifecycle.settlementReceived = true;
        if (runtime.lifecycle === lifecycle) runtime.lifecycle = undefined;
      }
      runtime.eventChain = runtime.eventChain
        .then(async () => {
          if (!isCurrent()) return;
          if (event.type === "agent_settled" && lifecycle === undefined) return;
          const eventContext = userShell?.context ?? (
            runningExtensionCommand !== undefined && isExtensionUiRequest(event)
              ? runningExtensionCommand.context
              : lifecycle === undefined
                ? runtime.context
                : routeLifecycleEvent(lifecycle, event)
          );
          failureContext = eventContext;
          if (userShell !== undefined) {
            const record = event as unknown as Record<string, unknown>;
            const delta = redactManagedSecrets(typeof record.delta === "string" ? record.delta : "", runtime.redactValues);
            await eventContext.emit(
              {
                type: "tool_update",
                callId: userShell.callId,
                name: "Shell",
                output: delta,
                outputMode: "append"
              },
              userShellMetadata("bash_execution_update", userShell, {
                delta,
                stderr: false
              })
            );
          } else if (isExtensionUiRequest(event)) {
            if (await handleCommandGateExtensionRequest(
              event as unknown as Record<string, unknown>,
              {
                gate: runtime.generationLease.generation.options.commandConcurrencyGate,
                sessionId: runtime.key,
                generation: runtime.transport.generation,
                signal: eventContext.signal,
                transport: runtime.transport,
                isCurrent
              }
            )) return;
            if (await handlePolicyDecisionExtensionRequest(
              event as unknown as Record<string, unknown>,
              {
                decide: (request) => this.#decideOrderedPolicy(runtime, request),
                transport: runtime.transport,
                isCurrent
              }
            )) return;
            const toolCatalogStatus = runtime.toolCatalogAssembler.consume(
              event as unknown as Record<string, unknown>,
              runtime.redactValues
            );
            if (toolCatalogStatus.kind === "catalog") {
              runtime.toolCatalog = {
                runtimeGeneration: runtime.transport.generation,
                observedAt: Date.now(),
                tools: toolCatalogStatus.tools
              };
              runtime.toolCatalogUnavailableReason = undefined;
              return;
            }
            if (toolCatalogStatus.kind === "unavailable") {
              runtime.toolCatalog = undefined;
              runtime.toolCatalogUnavailableReason = toolCatalogStatus.reason;
              return;
            }
            if (toolCatalogStatus.kind === "pending") return;
            runtime.translator.setContext(eventContext);
            await handleExtensionUiRequest(
              event as unknown as Record<string, unknown>,
              eventContext,
              runtime.transport,
              isCurrent,
              runtime.redactValues
            );
            runtime.control = await readControl(runtime.controlPath, runtime.transport.generation);
            this.#syncManagedSubagentObserver(runtime);
            const profile = this.#spawnProfiles.get(runtime.key);
            if (profile) {
              this.#spawnProfiles.set(runtime.key, {
                ...profile,
                initialPermissionMode: runtime.control.permissionMode,
                initialPlanMode: runtime.control.planMode,
                initialFastMode: runtime.control.fastMode
              });
            }
          } else {
            if (event.type === "agent_settled" && lifecycle !== undefined) {
              // Complete relative-threshold compaction before publishing the
              // turn's terminal `done`; this keeps SessionHost's durable queue
              // fence closed for the whole automatic compaction lifecycle.
              await this.#compactAtConfiguredThreshold(runtime, eventContext);
            }
            runtime.translator.setContext(eventContext);
            await runtime.translator.translate(
              event,
              event.type === "agent_settled" && lifecycle !== undefined
                ? lifecycle.participants.map((participant) => participant.context)
                : undefined
            );
          }
        })
        .catch(async (error) => {
          if (!isCurrent()) return;
          await failureContext.emit(
            {
              type: "error",
              error: {
                code: "PI_EVENT_TRANSLATION_FAILED",
                message: redactedDiagnostic(error),
                phase: "stream",
                retryable: true,
                stateMayHaveChanged: false,
                recovery: "Reload the session projection from its last durable event cursor."
              },
              terminal: false
            },
            piMetadata("adapter_translation_error")
          );
        });
    });
    runtime.transport.onExit((exit) => {
      const lifecycle = runtime.lifecycle;
      if (runtime.lifecycle === lifecycle) runtime.lifecycle = undefined;
      runtime.eventChain = runtime.eventChain.then(async () => {
        if (this.#runtimes.get(runtime.key) !== runtime) return;
        if (exit.error) {
          const contexts = lifecycle === undefined
            ? [runtime.context]
            : uniqueLifecycleContexts(lifecycle);
          for (const context of contexts) {
            await context.emit(
              { type: "error", error: exit.error.publicError, terminal: true },
              piMetadata("process_exit")
            ).catch(() => undefined);
            await context.emit(
              { type: "done", outcome: "failed" },
              piMetadata("process_exit")
            ).catch(() => undefined);
          }
        }
        if (this.#runtimes.get(runtime.key) === runtime) this.#runtimes.delete(runtime.key);
        if (!exit.expected) {
          try {
            runtime.generationLease.generation.options.onUnexpectedRuntimeExit?.(runtime.key, runtime.transport.generation);
          } catch {
            // Lifecycle notification is advisory; process fencing and cleanup
            // must continue even if the owner is already shutting down.
          }
        }
        await this.#finalizeRuntime(runtime).catch(async (error) => {
          await runtime.context.emit(
            {
              type: "error",
              error: {
                code: "PI_RUNTIME_CLEANUP_FAILED",
                message: redactedDiagnostic(error),
                phase: "shutdown",
                retryable: true,
                stateMayHaveChanged: false,
                recovery: "Remove the inactive generation-scoped runtime directory before reusing its storage."
              },
              terminal: false
            },
            piMetadata("runtime_cleanup")
          );
        });
      });
    });
  }

  async #refreshBinding(runtime: PiRuntime, emitEvent = true): Promise<NativeSessionBinding> {
    const response = await runtime.transport.request({ type: "get_state" }, { signal: runtime.context.signal });
    const state = responseData(response) as PiRpcState;
    if (!state.sessionFile || !state.sessionId) throw piError("PI_SESSION_IDENTITY_MISSING", "Pi did not expose its new native session identity", "session");
    const safePath = await this.#sessionStore.assertManagedSessionReference(state.sessionFile, { requireExists: false });
    runtime.binding = { opaqueRef: safePath, nativeSessionId: state.sessionId, generation: runtime.transport.generation };
    const refreshedContext: AdapterContext = { ...runtime.context, binding: runtime.binding };
    const tree = await this.getTree(refreshedContext);
    if (emitEvent) {
      await runtime.context.emit(
        {
          type: "native_session_changed",
          opaqueRef: safePath,
          nativeSessionId: state.sessionId,
          ...(tree.leafId === undefined ? {} : { leafId: tree.leafId })
        },
        piMetadata("native_session_changed")
      );
    }
    return runtime.binding;
  }

  async #decideOrderedPolicy(
    runtime: PiRuntime,
    request: PolicyDecisionRequest
  ): Promise<PolicyDecisionResult> {
    return this.#runExclusiveSessionMutation(runtime, runtime.context, async () => {
      const control = await readControl(runtime.controlPath, runtime.transport.generation);
      runtime.control = control;
      if (control.policyGeneration !== request.policyGeneration) return "stale";
      const snapshot = runtime.context.policySnapshot;
      if (snapshot === undefined) return "default";
      return evaluateOrderedPolicyRules(snapshot, request.observation)?.action ?? "default";
    });
  }

  async #confirmNativeSessionSwitch(
    runtime: PiRuntime,
    binding: NativeSessionBinding,
    context: AdapterContext
  ): Promise<PiRuntime> {
    const confirmed = await this.switchNativeSession(binding.opaqueRef, {
      ...context,
      binding: runtime.binding
    });
    if (!samePath(confirmed.opaqueRef, binding.opaqueRef)) {
      throw piError("PI_SESSION_SWITCH_MISMATCH", "Pi switched to a different native session than requested", "session", {
        stateMayHaveChanged: true,
        recovery: "Reload the native session list and reconcile the active Pi runtime before retrying."
      });
    }
    return this.#runtime({ ...context, binding: confirmed });
  }

  #runtime(context: AdapterContext): PiRuntime {
    const runtime = this.#runtimes.get(context.sessionId);
    if (!runtime || runtime.transport.closed) throw piError("PI_RUNTIME_NOT_ACTIVE", "Pi runtime is not active for this session", "dispatch", { retryable: true });
    if (!runtime.ready) {
      throw piError("PI_RUNTIME_NOT_READY", "Pi runtime did not complete its fenced startup handshake", "dispatch", {
        retryable: true,
        recovery: "Dispose the unready process generation before attempting to resume the native session."
      });
    }
    this.#touchRuntime(runtime, context);
    return runtime;
  }

  #touchRuntime(runtime: PiRuntime, context: AdapterContext): void {
    if (runtime.transport.generation !== context.generation) {
      throw piError("PI_STALE_GENERATION", "Pi runtime generation fence rejected a stale caller", "dispatch", {
        stateMayHaveChanged: false,
        recovery: "Refresh the product session binding before issuing more operations."
      });
    }
    if (context.binding && !samePath(context.binding.opaqueRef, runtime.binding.opaqueRef)) {
      throw piError("PI_SESSION_BINDING_MISMATCH", "Caller binding does not match the active Pi runtime", "dispatch");
    }
    runtime.context = context;
    if (runtime.lifecycle === undefined) runtime.translator.setContext(context);
    this.#syncManagedSubagentObserver(runtime);
  }

  #syncManagedSubagentObserver(runtime: PiRuntime): void {
    this.#subagentObservers.get(runtime.key)?.update(
      runtime.context,
      runtime.redactValues,
      runtime.control.policyGeneration
    );
  }

  async #remoteManagedDurableStore(
    binding: NativeSessionBinding,
    context: AdapterContext
  ): Promise<PiManagedDurableStore | undefined> {
    if (context.target.remoteWorkspace === undefined) return undefined;
    if (context.runtimePolicy === "review_read_only") {
      throw piError(
        "PI_REVIEW_REMOTE_LINEAGE_MUTATION_DENIED",
        "Reviewer runtimes cannot mutate remote delegated-run storage",
        "session",
        { stateMayHaveChanged: false }
      );
    }
    const registry = this.#options.managedDurableStoreRegistry;
    if (registry === undefined) {
      throw piError("PI_REMOTE_SUBAGENT_STORE_UNAVAILABLE", "Remote managed Subagent storage is unavailable", "session", {
        retryable: true,
        recovery: "Restore the authenticated remote durable-run control plane before changing this Session."
      });
    }
    const store = await registry.storeFor({
      sessionId: context.sessionId,
      targetId: context.target.id,
      bindingOpaqueRef: binding.opaqueRef,
      generation: context.generation
    });
    if (store === undefined) {
      throw piError("PI_REMOTE_SUBAGENT_STORE_UNAVAILABLE", "Remote managed Subagent storage could not recover its launch authority", "session", {
        retryable: true,
        stateMayHaveChanged: true,
        recovery: "Revalidate the remote launch authority before changing this Session."
      });
    }
    return store;
  }

  async #observeManagedSubagents(runtime: PiRuntime): Promise<void> {
    if (!runtime.managedSubagentToolsEnabled) return;
    const existing = this.#subagentObservers.get(runtime.key);
    if (existing !== undefined && existing.generation === runtime.transport.generation) {
      existing.update(runtime.context, runtime.redactValues, runtime.control.policyGeneration);
      existing.start();
      return;
    }
    await existing?.stopAndDrain();
    if (existing?.durableStore !== runtime.managedDurableStore) await existing?.durableStore?.dispose();
    const observer = new ManagedSubagentObserver({
      root: managedSubagentRunRoot(this.#sessionStore.root),
      ...(runtime.managedDurableStore === undefined ? {} : {
        durableStore: runtime.managedDurableStore,
        journalRoot: managedSubagentObservationRoot(this.#sessionStore.root)
      }),
      context: runtime.context,
      policyGeneration: runtime.control.policyGeneration,
      redactValues: runtime.redactValues,
      commandConcurrencyGate: runtime.generationLease.generation.options.commandConcurrencyGate
    });
    this.#subagentObservers.set(runtime.key, observer);
    observer.start();
  }

  #retainDetachedManagedSubagentObserver(
    durableStore: PiManagedDurableStore | undefined,
    context: AdapterContext
  ): void {
    const existing = this.#subagentObservers.get(context.sessionId);
    if (existing !== undefined) {
      if (existing.durableStore !== durableStore || existing.generation !== context.generation) {
        throw piError("PI_SUBAGENT_OBSERVER_OWNERSHIP_MISMATCH", "Remote delegated-run observation crossed its Session fence", "session", {
          retryable: true,
          stateMayHaveChanged: true
        });
      }
      existing.update(context, [], 0);
      existing.start();
      return;
    }
    const observer = new ManagedSubagentObserver({
      root: managedSubagentRunRoot(this.#sessionStore.root),
      ...(durableStore === undefined ? {} : {
        durableStore,
        journalRoot: managedSubagentObservationRoot(this.#sessionStore.root)
      }),
      context,
      redactValues: [],
      policyGeneration: 0,
      commandConcurrencyGate: this.#managedGeneration.options.commandConcurrencyGate
    });
    this.#subagentObservers.set(context.sessionId, observer);
    observer.start();
  }

  async #removeManagedSubagentLineage(runtime: PiRuntime | undefined, context: AdapterContext): Promise<void> {
    if (context.target.remoteWorkspace !== undefined && context.runtimePolicy === "review_read_only") {
      throw piError(
        "PI_REVIEW_REMOTE_LINEAGE_MUTATION_DENIED",
        "Reviewer runtimes cannot replace remote delegated-run storage",
        "session",
        { stateMayHaveChanged: false }
      );
    }
    const observer = this.#subagentObservers.get(context.sessionId);
    await observer?.stopAndDrain();
    if (observer !== undefined) this.#subagentObservers.delete(context.sessionId);
    let remoteLineageRemoved = false;
    try {
      const binding = runtime?.binding ?? context.binding;
      const durableStore = observer?.durableStore ?? runtime?.managedDurableStore
        ?? (binding === undefined ? undefined : await this.#remoteManagedDurableStore(binding, context));
      if (durableStore !== undefined && binding === undefined) {
        throw new Error("Remote managed Subagent lineage lacks its native Session binding.");
      }
      if (context.target.remoteWorkspace !== undefined && context.runtimePolicy !== "review_read_only"
          && durableStore === undefined) {
        throw piError("PI_REMOTE_SUBAGENT_STORE_UNAVAILABLE", "Remote managed Subagent storage lacks a binding authority", "session", {
          retryable: true,
          stateMayHaveChanged: true
        });
      }
      if (durableStore === undefined) {
        await stopAndRemoveManagedSubagentRuns(
          managedSubagentRunRoot(this.#sessionStore.root),
          context.sessionId,
          this.#options.shutdownTimeoutMs ?? 5_000
        );
        await this.#options.onManagedSubagentLineageRemoved?.({
          sessionId: context.sessionId,
          targetId: context.target.id
        });
      } else {
        const result = await durableStore.stopAndRemoveSession({
          sessionId: context.sessionId,
          sessionKey: managedSubagentSessionKey(context.sessionId),
          timeoutMs: Math.min(10_000, Math.max(1, this.#options.shutdownTimeoutMs ?? 5_000))
        });
        if (!result.removed) throw new Error("Remote managed Subagent lineage removal was not confirmed.");
        const bindingOpaqueRef = binding?.opaqueRef;
        if (bindingOpaqueRef === undefined) {
          throw new Error("Remote managed Subagent lineage lacks its native Session binding.");
        }
        remoteLineageRemoved = true;
        const deletion = await persistRemoteSubagentDeletionReceipt(this.#sessionStore.root, {
          scope: "lineage",
          sessionId: context.sessionId,
          targetId: context.target.id,
          bindingOpaqueRef,
          deletionReceipt: result.deletionReceipt
        });
        await this.#options.onManagedSubagentLineageRemoved?.({
          sessionId: context.sessionId,
          targetId: context.target.id
        });
        await removeManagedSubagentObservationJournal(
          managedSubagentObservationRoot(this.#sessionStore.root),
          context.sessionId
        );
        await durableStore.finalizeDeletion({
          sessionId: context.sessionId,
          sessionKey: managedSubagentSessionKey(context.sessionId),
          deletionReceipt: result.deletionReceipt
        });
        await durableStore.dispose();
        await removeRemoteSubagentDeletionReceipt(this.#sessionStore.root, deletion);
      }
    } catch (error) {
      if (!remoteLineageRemoved && runtime !== undefined
          && this.#runtimes.get(context.sessionId) === runtime && !runtime.transport.closed) {
        await this.#observeManagedSubagents(runtime);
      } else if (!remoteLineageRemoved) {
        const binding = runtime?.binding ?? context.binding;
        const durableStore = observer?.durableStore ?? runtime?.managedDurableStore
          ?? (binding === undefined ? undefined : await this.#remoteManagedDurableStore(binding, context).catch(() => undefined));
        this.#retainDetachedManagedSubagentObserver(durableStore, context);
      }
      throw piError("PI_SUBAGENT_CONTEXT_CLEAR_FAILED", "Context replacement could not safely stop every owned delegated run", "session", {
        retryable: true,
        stateMayHaveChanged: context.target.remoteWorkspace !== undefined,
        recovery: "Keep the current context attached, inspect delegated runner health, and retry the context replacement.",
        cause: error
      });
    }
  }

  async #stopRuntime(sessionId: string, generation: number): Promise<void> {
    const runtime = this.#runtimes.get(sessionId);
    if (!runtime) return;
    if (runtime.transport.generation !== generation) throw piError("PI_STALE_GENERATION", "Refusing to stop a newer Pi runtime generation", "shutdown");
    await runtime.transport.terminate(runtime.generationLease.generation.options.shutdownTimeoutMs ?? 5_000);
    if (this.#runtimes.get(sessionId) === runtime) this.#runtimes.delete(sessionId);
    await runtime.eventChain.catch(() => undefined);
    await this.#finalizeRuntime(runtime);
  }

  async #prepareRuntimeAgentHome(
    runtimeDirectory: string,
    runtimeGeneration: number,
    managedGeneration: PiManagedGeneration
  ): Promise<PreparedRuntimeAgentHome> {
    const options = managedGeneration.options;
    const agentHome = managedGeneration.agentHome;
    const path = join(runtimeDirectory, "agent-home");
    assertContained(runtimeDirectory, path, "runtime Agent Home");
    try {
      await mkdir(path, { recursive: true, mode: 0o700 });
      await chmod(path, 0o700);
      for (const name of ["models.json", "settings.json"] as const) {
        const source = join(agentHome, name);
        const info = await lstat(source);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) {
          throw piError("PI_RUNTIME_CONFIG_UNSAFE", `Managed ${name} is not a bounded regular file`, "provision");
        }
        const canonical = await realpath(source);
        assertContained(agentHome, canonical, `managed ${name}`);
        if (!samePath(canonical, source)) {
          throw piError("PI_RUNTIME_CONFIG_ALIAS_DENIED", `Managed ${name} contains a path alias`, "provision");
        }
        await atomicWriteFile(join(path, name), await readFile(canonical));
      }

      if (options.loadNativeAuth === undefined) return { path, redactValues: [] };
      const expectedCatalogGeneration = options.catalogGeneration!;
      // This allowlist is sourced from ModelRuntime's native OAuth registry.
      // BYOM/keyless providers in models.json use environment bindings and must
      // never be sent through the native credential callback.
      const providerIds = [...new Set(options.nativeAuthProviderIds ?? [])].sort();
      let loaded: PiNativeAuthSnapshot;
      try {
        loaded = options.loadNativeAuth({ providerIds, expectedCatalogGeneration });
      } catch (error) {
        throw piError("PI_NATIVE_AUTH_LOAD_FAILED", "Could not load the generation-fenced native Provider credential snapshot", "provision", {
          retryable: true,
          recovery: "Refresh the Provider catalog generation and retry without creating a replacement native session.",
          cause: error
        });
      }
      if (loaded.catalogGeneration !== expectedCatalogGeneration) {
        throw piError("PI_NATIVE_AUTH_GENERATION_MISMATCH", "Native Provider credentials do not match the managed Pi catalog generation", "provision", {
          retryable: true,
          recovery: "Refresh the managed Provider generation before starting Pi."
        });
      }
      const credentials = normalizeNativeAuthMap(loaded.credentials, providerIds);
      const authPath = join(path, "auth.json");
      await atomicWriteJson(authPath, credentials);
      await chmod(authPath, 0o600);
      const initialDigests = new Map(Object.entries(credentials).map(([providerId, credential]) => [
        providerId,
        digestNativeCredential(credential)
      ]));
      return {
        path,
        redactValues: collectNativeCredentialSecrets(credentials),
        nativeAuth: {
          agentHome: path,
          providerIds,
          expectedCatalogGeneration,
          initialDigests,
          ...(options.persistNativeAuth === undefined ? {} : { persist: options.persistNativeAuth })
        }
      };
    } catch (error) {
      // No process has been spawned yet, so credential-bearing material can be
      // removed immediately even when provisioning fails part-way through.
      await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => undefined);
      throw error;
    }
  }

  async #finalizeRuntime(runtime: PiRuntime): Promise<void> {
    runtime.cleanup ??= this.#finalizeRuntimeMaterial(runtime);
    return runtime.cleanup;
  }

  async #finalizeRuntimeMaterial(runtime: PiRuntime): Promise<void> {
    try {
    runtime.generationLease.generation.options.commandConcurrencyGate?.releaseSession(runtime.key, "runtime_closed");
    let updates: readonly { readonly providerId: string; readonly credential: PiNativeCredential }[] = [];
    let readError: unknown;
    if (runtime.nativeAuth?.persist !== undefined) {
      try {
        updates = await readNativeAuthUpdates(runtime.nativeAuth);
      } catch (error) {
        readError = error;
      }
    }

    // The process is confirmed stopped before this method is called. Remove
    // auth.json before invoking host callbacks that may rotate this Adapter.
    await this.#removeRuntimeDirectory(runtime.runtimeRoot, runtime.runtimeDirectory);
    if (readError !== undefined) {
      throw piError("PI_NATIVE_AUTH_REFRESH_INVALID", "Pi produced an invalid runtime-scoped native credential snapshot", "shutdown", {
        stateMayHaveChanged: true,
        recovery: "Reload credentials from the sealed Provider vault; the invalid runtime snapshot was removed.",
        cause: readError
      });
    }
    if (updates.length === 0 || runtime.nativeAuth?.persist === undefined) return;

    let expectedCatalogGeneration = runtime.nativeAuth.expectedCatalogGeneration;
    for (const update of updates) {
      let persisted: Awaited<ReturnType<PiPersistNativeAuth>>;
      try {
        persisted = await runtime.nativeAuth.persist({
          providerId: update.providerId,
          credential: update.credential,
          expectedCatalogGeneration
        });
      } catch (error) {
        throw piError("PI_NATIVE_AUTH_REFRESH_OUTCOME_UNKNOWN", "Refreshed native Provider credentials were not committed by the generation-fenced vault", "shutdown", {
          retryable: true,
          stateMayHaveChanged: true,
          recovery: "Reload the latest Provider generation before signing in or refreshing again.",
          cause: error
        });
      }
      if (
        !Number.isSafeInteger(persisted.catalogGeneration) ||
        persisted.catalogGeneration <= expectedCatalogGeneration ||
        typeof persisted.credentialReferenceId !== "string" ||
        persisted.credentialReferenceId.trim() === "" ||
        (update.credential.type === "oauth"
          ? !Number.isSafeInteger(persisted.expiresAt)
          : persisted.expiresAt !== undefined)
      ) {
        throw piError("PI_NATIVE_AUTH_PERSIST_RESULT_INVALID", "Provider vault returned an invalid native credential commit acknowledgement", "shutdown", {
          stateMayHaveChanged: true,
          recovery: "Reload the Provider catalog and reconcile the credential generation before retrying."
        });
      }
      expectedCatalogGeneration = persisted.catalogGeneration;
    }
    } finally {
      this.#releaseManagedGenerationLease(runtime.generationLease);
    }
  }

  async #prepareRuntimeDirectory(agentHome: string, path: string): Promise<void> {
    assertContained(join(agentHome, "runtime"), path, "runtime directory");
    try {
      await rm(path, { recursive: true, force: true });
      await Promise.all([
        mkdir(path, { recursive: true, mode: 0o700 }),
        mkdir(join(path, "artifacts"), { recursive: true, mode: 0o700 })
      ]);
      await Promise.all([chmod(path, 0o700), chmod(join(path, "artifacts"), 0o700)]);
    } catch (error) {
      throw asPiError(error, {
        code: "PI_RUNTIME_DIRECTORY_FAILED",
        phase: "provision",
        retryable: true,
        recovery: "Ensure the service account owns the managed Pi runtime directory and retry."
      });
    }
  }

  async #prepareGenerationRuntimeRoot(agentHome: string, options: PiAdapterOptions): Promise<void> {
    const durableAuthPath = join(agentHome, "auth.json");
    const durableAuth = await lstat(durableAuthPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (durableAuth !== undefined) {
      throw piError(
        "PI_DURABLE_AUTH_FILE_DENIED",
        "Managed Pi generation contains a durable auth.json; OAuth credentials are allowed only in a runtime-scoped Agent Home",
        "provision",
        { recovery: "Move the credential into Orchestrator's sealed Provider vault and securely remove the durable auth.json before retrying." }
      );
    }
    const runtimeRoot = join(agentHome, "runtime");
    assertContained(agentHome, runtimeRoot, "runtime root");
    try {
      // Initialization owns this generation before any runtime is published.
      // A recorded process must be identity-checked and confirmed gone before
      // credential-bearing runtime material can be removed or reused.
      await this.#recoverManagedRuntimeRoot(runtimeRoot, options.shutdownTimeoutMs ?? 5_000);
      await rm(runtimeRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
      await chmod(runtimeRoot, 0o700);
    } catch (error) {
      throw asPiError(error, {
        code: "PI_STALE_RUNTIME_CLEANUP_FAILED",
        phase: "provision",
        retryable: true,
        recovery: "Stop orphaned Pi processes and retry runtime generation initialization.",
      });
    }
  }

  async #recoverManagedRuntimeRoot(runtimeRoot: string, shutdownTimeoutMs: number): Promise<void> {
    const entries = await readdir(runtimeRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      const runtimeDirectory = join(runtimeRoot, entry.name);
      if (!entry.isDirectory() || entry.isSymbolicLink()) {
        throw piError("PI_STALE_RUNTIME_UNSAFE", "Managed Pi runtime storage contains a non-directory entry", "provision", {
          recovery: "Inspect the service-owned runtime root before retrying startup."
        });
      }
      const ownerPath = join(runtimeDirectory, RUNTIME_OWNER_FILE);
      const raw = await readFile(ownerPath, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (raw === undefined) {
        throw piError(
          "PI_STALE_RUNTIME_IDENTITY_MISSING",
          "Managed Pi runtime storage contains a directory without an owner identity",
          "shutdown",
          {
            retryable: true,
            stateMayHaveChanged: true,
            recovery: "Inspect the service-owned runtime directory and confirm that no process owns it before removing it."
          }
        );
      }
      const owner = parseRuntimeOwnerManifest(raw);
      if (owner.state !== "running" || owner.pid === undefined || owner.processIdentity === undefined) {
        throw piError("PI_STALE_RUNTIME_IDENTITY_INCOMPLETE", "A previous Pi spawn did not publish a complete process identity", "shutdown", {
          retryable: true,
          stateMayHaveChanged: true,
          recovery: "Inspect and terminate the fenced service-node process before removing its runtime directory."
        });
      }
      if (this.#processSupervisor === undefined) {
        throw piError("PI_PROCESS_SUPERVISOR_REQUIRED", "A recorded Pi process cannot be recovered without an identity supervisor", "shutdown", {
          retryable: true,
          stateMayHaveChanged: true,
          recovery: "Configure the managed process supervisor or terminate the fenced process manually."
        });
      }
      const outcome = await this.#processSupervisor.terminate(
        owner.pid,
        owner.processIdentity,
        shutdownTimeoutMs
      );
      if (outcome === "unconfirmed") {
        throw piError("PI_STALE_PROCESS_EXIT_UNCONFIRMED", "A previous Pi process did not confirm exit during startup recovery", "shutdown", {
          retryable: true,
          stateMayHaveChanged: true,
          recovery: "Keep this spawn identity fenced and inspect the service-node process before retrying startup."
        });
      }
    }
  }

  async #recoverManagedGenerationTree(root: string, shutdownTimeoutMs: number): Promise<void> {
    const visit = async (directory: string, depth: number): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const path = join(directory, entry.name);
        if (entry.name === "runtime" && depth >= 1) {
          await this.#recoverManagedRuntimeRoot(path, shutdownTimeoutMs);
          await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
          continue;
        }
        if (depth < 2) await visit(path, depth + 1);
      }
    };
    await visit(root, 0);
  }

  async #removeRuntimeDirectory(runtimeRoot: string, path: string): Promise<void> {
    assertContained(runtimeRoot, path, "runtime directory");
    await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }

  #retainManagedGeneration(generation: PiManagedGeneration): void {
    generation.references += 1;
  }

  #releaseManagedGenerationLease(lease: PiManagedGenerationLease): void {
    if (lease.released) return;
    lease.released = true;
    lease.generation.references = Math.max(0, lease.generation.references - 1);
    this.#releaseManagedGenerationIfUnused(lease.generation);
  }

  #releaseManagedGenerationIfUnused(generation: PiManagedGeneration): void {
    if (!generation.retired || generation.references !== 0 || generation.released) return;
    generation.released = true;
    try {
      generation.options.releaseManagedGeneration?.();
    } catch {
      // Release callbacks may close host-side grants but cannot make an
      // already-confirmed process exit uncertain or resurrect a generation.
    }
  }

  async #resolveImages(input: PromptInput, options: PiAdapterOptions): Promise<{ type: "image"; data: string; mimeType: string }[]> {
    if (input.images.length === 0) return [];
    if (!options.readBlob) throw piError("PI_IMAGE_RESOLVER_MISSING", "Image input requires a configured BlobRef reader", "dispatch");
    const images: { type: "image"; data: string; mimeType: string }[] = [];
    for (const image of input.images) {
      const resolvedImage = await options.readBlob(image.blob).catch((error) => {
        throw asPiError(error, {
          code: "PI_IMAGE_READ_FAILED",
          phase: "dispatch",
          retryable: true,
          recovery: "Restore the referenced image blob and retry the prompt."
        });
      });
      if (!(resolvedImage.data instanceof Uint8Array)) throw piError("PI_IMAGE_INVALID_BYTES", "Image resolver returned invalid bytes", "dispatch");
      const digest = createHash("sha256").update(resolvedImage.data).digest("hex");
      if (resolvedImage.data.byteLength !== image.blob.byteLength || digest.toLowerCase() !== image.blob.sha256.toLowerCase()) {
        throw piError("PI_IMAGE_INTEGRITY_FAILED", "Resolved image bytes do not match the immutable BlobRef", "dispatch", {
          recovery: "Reload the original blob from durable artifact storage before retrying."
        });
      }
      const mimeType = resolvedImage.mimeType ?? image.blob.mimeType;
      if (!/^image\/(?:png|jpeg|webp|gif)$/i.test(mimeType)) throw piError("PI_IMAGE_TYPE_UNSUPPORTED", `Pi image type '${mimeType}' is unsupported`, "dispatch");
      images.push({ type: "image", data: Buffer.from(resolvedImage.data).toString("base64"), mimeType });
    }
    return images;
  }

  async #composePrompt(input: PromptInput, context: AdapterContext, options: PiAdapterOptions): Promise<string> {
    const sections: string[] = [];
    if (input.text.trim()) sections.push(input.text);
    const attachments: string[] = [];
    for (const file of input.files) {
      let path: string;
      if (file.workspacePath) {
        if (isAbsolute(file.workspacePath)) throw piError("PI_FILE_PATH_DENIED", "Workspace attachment path must be relative", "dispatch");
        path = resolve(context.target.workspaceRoot, file.workspacePath);
        assertContained(context.target.workspaceRoot, path, "workspace attachment");
      } else if (options.resolveFile) {
        path = resolve(
          await options.resolveFile(file.blob, context).catch((error) => {
            throw asPiError(error, {
              code: "PI_FILE_RESOLUTION_FAILED",
              phase: "dispatch",
              retryable: true,
              recovery: "Restore the attached blob and retry its managed path resolution."
            });
          })
        );
      } else {
        throw piError("PI_FILE_RESOLVER_MISSING", "File BlobRef has no workspacePath and no resolver is configured", "dispatch");
      }
      const info = await lstat(path).catch((error) => {
        throw piError("PI_FILE_UNAVAILABLE", `Attached file '${path}' is unavailable`, "dispatch", { cause: error });
      });
      if (!info.isFile() || info.isSymbolicLink()) throw piError("PI_FILE_UNSAFE", "Attached file must be a regular non-symlink file", "dispatch");
      attachments.push(`- file: ${path}`);
    }
    for (const mention of input.mentions) {
      attachments.push(`- ${mention.kind}: ${mention.label} -> ${mention.reference}`);
    }
    if (attachments.length > 0) sections.push(`[Joko resolved resources]\n${attachments.join("\n")}`);
    if (sections.length === 0 && input.images.length === 0) throw piError("PI_PROMPT_EMPTY", "Pi prompt has no text, image, file, or mention content", "dispatch");
    return sections.join("\n\n");
  }

  #baseEnvironment(): NodeJS.ProcessEnv {
    const allow = [
      "PATH",
      "Path",
      "PATHEXT",
      "SystemRoot",
      "WINDIR",
      "COMSPEC",
      "ProgramFiles",
      "ProgramFiles(x86)",
      "TEMP",
      "TMP",
      "TMPDIR",
      "HOME",
      "USERPROFILE",
      "APPDATA",
      "LOCALAPPDATA",
      // Desktop-hosted Orchestrator runs under Electron's Node mode. Its default
      // Pi command is process.execPath (electron.exe), so the managed child
      // must retain this non-secret runtime flag or Electron exits before the
      // Pi RPC process can publish its spawn identity.
      "ELECTRON_RUN_AS_NODE",
      "LANG",
      "LC_ALL",
      "TERM",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY"
    ] as const;
    const result: NodeJS.ProcessEnv = {};
    for (const key of allow) if (process.env[key] !== undefined) result[key] = process.env[key];
    return result;
  }

  #capabilities(compatibility: PiCompatibilityOutcome): ReadonlyMap<string, Capability> {
    const supported = new Set<string>(compatibility.status === "compatible" ? [
      "session.discovery",
      "session.resume",
      "session.detach",
      "session.fork",
      "session.rewind",
      "session.message_delete",
      "session.reset",
      "session.tree",
      "session.clone",
      "session.export",
      "session.portable_transfer",
      "turn.stream",
      "turn.abort",
      "turn.steer",
      "turn.follow_up",
      "input.text",
      "input.file",
      "input.mention",
      "model.list",
      "model.switch",
      "model.effort",
      "provider.managed_catalog",
      "permission.modes",
      "permission.change",
      "plan_mode",
      "context.usage",
      "context.compact",
      "context.auto_compact",
      "context.auto_retry",
      "context.silent_encrypted_retry",
      "workspace.files",
      "interaction.permission",
      "interaction.question",
      "interaction.plan_review",
      "background.tasks",
      "background.tasks.cancel",
      "subagents.list",
      "subagents.detail",
      "subagents.transcript",
      "subagents.stop",
      "subagents.steer",
      "subagents.follow_up",
      "subagents.resume",
      "runtime.commands",
      "runtime.tools",
      "runtime.resources",
      "runtime.user_shell"
    ] : []);
    if (compatibility.status === "compatible") {
      for (const command of compatibility.report.unsupportedCommands) {
        for (const capability of capabilitiesForMissingCommand(command)) supported.delete(capability);
      }
    }
    if (compatibility.status === "compatible" && this.#options.readBlob) supported.add("input.image");
    if (
      compatibility.status === "compatible" &&
      (this.#options.providers ?? []).some((provider) => provider.models.some((model) => model.supportsFastMode === true)) ||
      compatibility.status === "compatible" && (this.#options.nativeModels ?? []).some((model) => model.supportsFastMode === true)
    ) supported.add("model.fast_mode");
    if (compatibility.status === "compatible" && (this.#options.mcpBridge || this.#options.resolveMcpBridge)) supported.add("tool.mcp");
    if (compatibility.status === "compatible" && this.#options.resolveMakerMemoryPrompt && (this.#options.mcpBridge || this.#options.resolveMcpBridge)) supported.add("memory.curated");
    if (compatibility.status === "compatible" && this.#options.isCompactionMemoryEnabled && this.#options.onCompactionDigest) supported.add("memory.compaction_digest");
    if (compatibility.status === "compatible" && this.#processSupervisor?.inspect !== undefined) supported.add("runtime.process_usage");
    if (compatibility.status === "compatible" && this.#processSupervisor !== undefined) supported.add("runtime.process_terminate");
    for (const capability of this.#options.hostCapabilities ?? []) supported.add(capability);
    for (const capability of this.#options.hostToolCapabilities ?? []) supported.add(capability);
    const entries: Array<readonly [string, Capability]> = CAPABILITIES.map((key): readonly [string, Capability] => {
        if (supported.has(key)) {
          return [key, {
            key,
            supported: true,
            ...(key === "permission.modes" ? { options: ["ask", "auto", "bypassPermissions"] } : {})
          }];
        }
        const upstreamMissing = key === "model.fast_mode" || key === "turn.graceful_stop";
        const optionalCommand = compatibility.status === "compatible"
          ? compatibility.report.unsupportedCommands.find((command) => capabilitiesForMissingCommand(command).includes(key))
          : undefined;
        const processSupervisorMissing =
          (key === "runtime.process_usage" && this.#processSupervisor?.inspect === undefined) ||
          (key === "runtime.process_terminate" && this.#processSupervisor === undefined);
        return [
          key,
          {
            key,
            supported: false,
            reason: processSupervisorMissing
              ? "platform_limited"
              : compatibility.status === "incompatible" || optionalCommand !== undefined || upstreamMissing
                ? "upstream_missing"
                : "not_implemented",
            detail: compatibility.status === "incompatible"
              ? "The configured Pi executable failed its typed RPC compatibility probe"
              : processSupervisorMissing
                ? "OS process identity supervision is unavailable for this process factory"
              : optionalCommand !== undefined
                ? `The installed Pi RPC does not expose compatible ${optionalCommand} responses`
                : key === "model.fast_mode"
              ? "No model in the current installed Pi catalog explicitly supports Fast Mode"
              : upstreamMissing
                ? "The installed Pi RPC does not advertise this capability"
                : "Owned by another Orchestrator provider or not configured"
          }
        ];
      });
    return new Map<string, Capability>(entries);
  }

  #createArtifactRefCache(sessionId: string): Map<string, BlobRef> {
    const cache = new Map<string, BlobRef>();
    this.#artifactRefsBySession.set(sessionId, cache);
    return cache;
  }

  async #readCommandCatalog(runtime: PiRuntime, context: AdapterContext): Promise<PiCommandCatalog> {
    const response = await runtime.transport.request({ type: "get_commands" }, { signal: context.signal });
    const data = responseData(response);
    if (!isRecord(data) || !Array.isArray(data.commands)) return EMPTY_PI_COMMAND_CATALOG;
    const descriptors = data.commands as PiRpcCommandDescriptor[];
    const managedInternalNames = new Set(
      descriptors
        .filter((command) => isManagedInternalCommand(command, runtime.bridgePath, runtime.subagentPath))
        .map((command) => command.name.replace(/:\d+$/u, ""))
    );
    return {
      commands: descriptors
        .filter((command) => !isManagedInternalCommand(command, runtime.bridgePath, runtime.subagentPath))
        .map((command) => ({
          name: command.name,
          description: command.description ?? "",
          source: command.source,
          path: command.sourceInfo?.path,
          loaded: true
        })),
      managedInternalNames
    };
  }

  #assertNotDisposed(): void {
    if (this.#disposed) throw piError("PI_ADAPTER_DISPOSED", "Pi adapter has been disposed", "shutdown");
  }

  #assertReviewOperationAllowed(context: AdapterContext, operation: string): void {
    const runtime = this.#runtime(context);
    if (runtime.control.runtimePolicy === "review_read_only") {
      throw piError("PI_REVIEW_OPERATION_DENIED", `Reviewer runtime cannot ${operation}`, "dispatch", {
        recovery: "Use only bounded read, grep, find, or ls tools inside the dedicated Reviewer Session."
      });
    }
  }
}

export function createPiAdapter(options: PiAdapterOptions): PiBackendAdapter {
  return new PiBackendAdapter(options);
}

function boundedManagedControlText(value: unknown, maximum: number, label: string): string {
  if (typeof value !== "string") throw piError("PI_SUBAGENT_CONTROL_INPUT_INVALID", `${label} is required`, "dispatch");
  const text = value.trim();
  if (text.length < 1 || text.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
    throw piError("PI_SUBAGENT_CONTROL_INPUT_INVALID", `${label} is invalid or exceeds its bounded size`, "dispatch");
  }
  if (label.includes("message") && text.startsWith("/")) {
    throw piError("PI_SUBAGENT_CONTROL_INPUT_INVALID", `${label} cannot invoke an extension command`, "dispatch");
  }
  return text;
}

function buildContextRebuildHandoff(input: ContextRebuildInput, secrets: readonly string[]): string {
  const handoff = redactManagedSecrets(redactSecrets(input.handoff), secrets);
  if (!handoff.trim()) {
    throw piError("PI_CONTEXT_REBUILD_HANDOFF_REQUIRED", "Native context rebuild requires a redacted handoff", "session");
  }
  return handoff;
}

// These are registered by joko-managed-bridge.ts as product control channels:
// `/plan` applies the typed setPlanMode contract and `/joko-navigate-tree`
// carries an opaque Host navigation payload. They are escaped on input and
// intentionally excluded from the user-authored RuntimeCommand catalog.
const MANAGED_INTERNAL_PI_COMMANDS = new Set([
  "plan",
  "joko-navigate-tree",
  "joko-rebuild-context",
  "joko-reset-context",
  MANAGED_SUBAGENT_CONTROL_COMMAND_NAME
]);

interface PiCommandCatalog {
  readonly commands: readonly RuntimeCommand[];
  readonly managedInternalNames: ReadonlySet<string>;
}

interface PiUserShellLifecycle {
  readonly context: AdapterContext;
  readonly callId: string;
  readonly commandDisplay: string;
  readonly excludeFromContext: boolean;
  abortTask?: Promise<void>;
}

const EMPTY_PI_COMMAND_CATALOG: PiCommandCatalog = {
  commands: [],
  managedInternalNames: new Set<string>()
};

function isManagedInternalCommand(command: PiRpcCommandDescriptor, bridgePath: string, subagentPath: string): boolean {
  const invocationBase = command.name.replace(/:\d+$/u, "");
  const sourcePath = command.sourceInfo?.path;
  return command.source === "extension" &&
    command.sourceInfo?.scope === "temporary" &&
    MANAGED_INTERNAL_PI_COMMANDS.has(invocationBase) &&
    typeof sourcePath === "string" &&
    isAbsolute(sourcePath) &&
    (samePath(sourcePath, bridgePath) || samePath(sourcePath, subagentPath));
}

function assertManagedSubagentControlHandshake(value: unknown, subagentPath: string): void {
  const commands = isRecord(value) && Array.isArray(value.commands)
    ? value.commands as PiRpcCommandDescriptor[]
    : [];
  const control = commands.find((command) => {
    const sourcePath = command.sourceInfo?.path;
    return command.name.replace(/:\d+$/u, "") === MANAGED_SUBAGENT_CONTROL_COMMAND_NAME &&
      command.source === "extension" &&
      command.sourceInfo?.scope === "temporary" &&
      typeof sourcePath === "string" &&
      isAbsolute(sourcePath) &&
      samePath(sourcePath, subagentPath);
  });
  if (control === undefined) {
    throw piError(
      "PI_BACKGROUND_TASK_CONTROL_HANDSHAKE_FAILED",
      "Managed background task control command was not registered by the owned extension",
      "handshake",
      { recovery: "Reprovision the managed Pi runtime before advertising background task cancellation." }
    );
  }
}

/**
 * Pi executes extension slash commands before an LLM request. Composer input
 * therefore stays literal unless the live typed catalog identifies an exact
 * skill or prompt-template command. Product-owned control commands are never
 * executable through this path; their dedicated Adapter methods bypass it.
 */
export function escapePiComposerSlashCommand(
  text: string,
  commands: readonly RuntimeCommand[],
  managedInternalNames: ReadonlySet<string> = EMPTY_PI_COMMAND_CATALOG.managedInternalNames
): string {
  return resolvePiComposerSlashCommand(text, "prompt", commands, managedInternalNames).message;
}

interface ResolvedPiComposerSlashCommand {
  readonly message: string;
  readonly extensionCommand?: string;
}

export function resolvePiComposerSlashCommand(
  text: string,
  _disposition: PromptInput["disposition"],
  commands: readonly RuntimeCommand[],
  managedInternalNames: ReadonlySet<string> = EMPTY_PI_COMMAND_CATALOG.managedInternalNames
): ResolvedPiComposerSlashCommand {
  const match = text.trimStart().match(/^\/([^\s]+)(?:\s|$)/u);
  if (!match?.[1]) return { message: text };
  const requested = match[1].replace(/^\//u, "");
  if (managedInternalNames.has(requested)) return { message: ` ${text}` };
  const command = commands.find((candidate) =>
    candidate.loaded &&
    candidate.name.replace(/^\//u, "") === requested
  );
  if (command?.source === "extension") {
    return { message: text, extensionCommand: requested };
  }
  const executable = commands.some((candidate) =>
    candidate.loaded &&
    candidate.source !== "extension" &&
    candidate.name.replace(/^\//u, "") === requested
  );
  return { message: executable ? text : ` ${text}` };
}

function responseData(response: unknown): unknown {
  return isRecord(response) ? response.data : undefined;
}

function validateClearedPiQueue(response: unknown): void {
  const data = responseData(response);
  if (
    !isRecord(data)
    || !Array.isArray(data.steering)
    || !data.steering.every((value) => typeof value === "string")
    || !Array.isArray(data.followUp)
    || !data.followUp.every((value) => typeof value === "string")
  ) {
    throw piError(
      "PI_CLEAR_QUEUE_RESPONSE_INVALID",
      "Pi returned an invalid cleared-queue acknowledgement",
      "dispatch",
      {
        stateMayHaveChanged: true,
        recovery: "Inspect the native Session queue before dispatching or aborting another turn."
      }
    );
  }
}

function validatedPiEntriesResponse(
  data: unknown
): { readonly entries: readonly PiRpcEntry[]; readonly leafId?: string } {
  if (!isRecord(data) || !Array.isArray(data.entries) ||
      (data.leafId !== null && typeof data.leafId !== "string")) {
    throw piError(
      "PI_ENTRIES_INVALID_RESPONSE",
      "Pi get_entries returned an invalid history response",
      "session"
    );
  }
  const entryIds = new Set<string>();
  const entries = data.entries.map((entry, index) => {
    const normalizedEntry = isRecord(entry) ? entry : undefined;
    if (normalizedEntry === undefined ||
        typeof normalizedEntry.id !== "string" || normalizedEntry.id.trim() === "" ||
        normalizedEntry.id.length > 4_096 || normalizedEntry.id.includes("\0") ||
        typeof normalizedEntry.type !== "string" || normalizedEntry.type.trim() === "" ||
        normalizedEntry.type.length > 256 || normalizedEntry.type.includes("\0") ||
        (normalizedEntry.parentId !== null && (
          typeof normalizedEntry.parentId !== "string" || normalizedEntry.parentId.trim() === "" ||
          normalizedEntry.parentId.length > 4_096 || normalizedEntry.parentId.includes("\0")
        )) ||
        typeof normalizedEntry.timestamp !== "string" || normalizedEntry.timestamp.trim() === "" ||
        normalizedEntry.timestamp.length > 128 || normalizedEntry.timestamp.includes("\0") ||
        !Number.isFinite(Date.parse(normalizedEntry.timestamp)) ||
        !validKnownPiHistoryEntryPayload(normalizedEntry)) {
      throw piError(
        "PI_ENTRIES_INVALID_RESPONSE",
        `Pi get_entries returned an invalid history entry at index ${index}`,
        "session"
      );
    }
    if (entryIds.has(normalizedEntry.id)) {
      throw piError(
        "PI_ENTRIES_INVALID_RESPONSE",
        `Pi get_entries returned a duplicate history entry at index ${index}`,
        "session"
      );
    }
    entryIds.add(normalizedEntry.id);
    return normalizedEntry as unknown as PiRpcEntry;
  });
  if (typeof data.leafId === "string" && (
    data.leafId.trim() === "" || data.leafId.length > 4_096 || data.leafId.includes("\0")
  )) {
    throw piError(
      "PI_ENTRIES_INVALID_RESPONSE",
      "Pi get_entries returned an invalid history leaf",
      "session"
    );
  }
  return {
    entries,
    ...(typeof data.leafId === "string" ? { leafId: data.leafId } : {})
  };
}

function validKnownPiHistoryEntryPayload(entry: Readonly<Record<string, unknown>>): boolean {
  switch (entry.type) {
    case "message":
      return validPiAgentMessage(entry.message);
    case "thinking_level_change":
      return typeof entry.thinkingLevel === "string";
    case "model_change":
      return nonEmptyPiHistoryText(entry.provider) && nonEmptyPiHistoryText(entry.modelId);
    case "compaction":
      return typeof entry.summary === "string"
        && nonEmptyPiHistoryText(entry.firstKeptEntryId)
        && finiteNonNegativePiNumber(entry.tokensBefore)
        && validOptionalPiUsage(entry.usage)
        && (entry.fromHook === undefined || typeof entry.fromHook === "boolean");
    case "branch_summary":
      return nonEmptyPiHistoryText(entry.fromId)
        && typeof entry.summary === "string"
        && validOptionalPiUsage(entry.usage)
        && (entry.fromHook === undefined || typeof entry.fromHook === "boolean");
    case "custom":
      return nonEmptyPiHistoryText(entry.customType);
    case "custom_message":
      return nonEmptyPiHistoryText(entry.customType)
        && validPiUserContent(entry.content)
        && typeof entry.display === "boolean";
    case "label":
      return nonEmptyPiHistoryText(entry.targetId)
        && (entry.label === undefined || typeof entry.label === "string");
    case "session_info":
      return entry.name === undefined || typeof entry.name === "string";
    default:
      // Extension-defined entries are opaque by contract. Their common tree
      // identity is still validated above and their payload remains preserved.
      return true;
  }
}

function validPiAgentMessage(value: unknown): boolean {
  if (!isRecord(value) || !nonEmptyPiHistoryText(value.role) || !finiteNonNegativePiNumber(value.timestamp)) {
    return false;
  }
  switch (value.role) {
    case "user":
      return validPiUserContent(value.content);
    case "assistant":
      return Array.isArray(value.content)
        && value.content.every(validPiAssistantContentPart)
        && nonEmptyPiHistoryText(value.api)
        && nonEmptyPiHistoryText(value.provider)
        && nonEmptyPiHistoryText(value.model)
        && validPiUsage(value.usage)
        && ["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"].includes(String(value.stopReason));
    case "toolResult":
      return nonEmptyPiHistoryText(value.toolCallId)
        && nonEmptyPiHistoryText(value.toolName)
        && Array.isArray(value.content)
        && value.content.every(validPiInputContentPart)
        && typeof value.isError === "boolean"
        && validOptionalPiUsage(value.usage);
    case "bashExecution":
      return typeof value.command === "string"
        && typeof value.output === "string"
        && (value.exitCode === undefined || finitePiNumber(value.exitCode))
        && typeof value.cancelled === "boolean"
        && typeof value.truncated === "boolean";
    case "custom":
      return nonEmptyPiHistoryText(value.customType)
        && validPiUserContent(value.content)
        && typeof value.display === "boolean";
    case "branchSummary":
      return typeof value.summary === "string" && nonEmptyPiHistoryText(value.fromId);
    case "compactionSummary":
      return typeof value.summary === "string" && finiteNonNegativePiNumber(value.tokensBefore);
    default:
      // AgentMessage is open to extension-owned roles. Preserve a structurally
      // identified extension message instead of pretending to understand it.
      return true;
  }
}

function validPiUserContent(value: unknown): boolean {
  return typeof value === "string"
    || (Array.isArray(value) && value.every(validPiInputContentPart));
}

function validPiInputContentPart(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type === "text") return typeof value.text === "string";
  return value.type === "image" && typeof value.data === "string" && nonEmptyPiHistoryText(value.mimeType);
}

function validPiAssistantContentPart(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type === "text") return typeof value.text === "string";
  if (value.type === "thinking") return typeof value.thinking === "string";
  return value.type === "toolCall"
    && nonEmptyPiHistoryText(value.id)
    && nonEmptyPiHistoryText(value.name)
    && isRecord(value.arguments);
}

function validOptionalPiUsage(value: unknown): boolean {
  return value === undefined || validPiUsage(value);
}

function validPiUsage(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.cost)) return false;
  return [value.input, value.output, value.cacheRead, value.cacheWrite, value.totalTokens]
    .every(finiteNonNegativePiNumber)
    && [value.cost.input, value.cost.output, value.cost.cacheRead, value.cost.cacheWrite, value.cost.total]
      .every(finiteNonNegativePiNumber);
}

function nonEmptyPiHistoryText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && !value.includes("\0");
}

function finiteNonNegativePiNumber(value: unknown): value is number {
  return finitePiNumber(value) && value >= 0;
}

function finitePiNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function runtimeRpcTimeout(runtime: PiRuntime, fallbackMs: number): number {
  return runtime.generationLease.generation.options.requestTimeoutMs ?? fallbackMs;
}

const PI_LONG_RPC_PROGRESS_EVENTS = new Set([
  "compaction_start",
  "compaction_end",
  "summarization_retry_scheduled",
  "summarization_retry_attempt_start",
  "summarization_retry_finished"
]);

function isPiRpcProgressEvent(event: PiRpcEvent): boolean {
  // These are the authoritative preflight/summary progress events emitted by
  // Pi before the stateful response. Unrelated runtime chatter must not keep
  // an unacknowledged mutation alive forever.
  return PI_LONG_RPC_PROGRESS_EVENTS.has(event.type);
}

function isPiBashProgressEvent(event: PiRpcEvent): boolean {
  return event.type === "bash_execution_update";
}

async function requestPiPromptAcceptance(
  runtime: PiRuntime,
  command: Extract<PiRpcCommand, { readonly type: "prompt" }>,
  signal?: AbortSignal
) {
  try {
    return await runtime.transport.request(command, {
      ...(signal === undefined ? {} : { signal }),
      stateMayHaveChanged: true,
      timeoutMs: runtimeRpcTimeout(runtime, PI_LONG_RUNNING_RPC_TIMEOUT_MS),
      refreshTimeoutOnEvent: isPiRpcProgressEvent
    });
  } catch (error) {
    if (!(error instanceof PiAdapterError) || error.publicError.code !== "PI_RPC_TIMEOUT") throw error;
    throw piError(
      "PI_PROMPT_ACCEPTANCE_TIMEOUT",
      "Pi did not acknowledge prompt acceptance within the bounded silent-response window",
      "dispatch",
      {
        retryable: true,
        stateMayHaveChanged: true,
        recovery: "Replace the unconfirmed native context before another explicit prompt dispatch.",
        cause: error
      }
    );
  }
}

function isUnconfirmedSessionMutationError(error: unknown): boolean {
  return error instanceof PiAdapterError
    && error.publicError.stateMayHaveChanged
    && error.publicError.code !== "PI_RPC_REJECTED";
}

function capabilitiesForMissingCommand(command: PiOptionalProbeCommand): readonly KnownCapability[] {
  switch (command) {
    case "get_tree":
      return ["session.tree", "session.rewind", "session.message_delete", "session.reset"];
    case "get_entries":
      return ["session.rewind"];
    case "get_available_models":
      return ["model.list"];
    case "get_available_thinking_levels":
      return ["model.effort"];
    case "get_session_stats":
      return ["context.usage"];
    case "get_fork_messages":
      return ["session.fork"];
    case "get_messages":
    case "get_last_assistant_text":
      return [];
  }
}

function assertSessionChangeAccepted(response: unknown, command: "new_session" | "switch_session" | "fork" | "clone"): void {
  const data = responseData(response);
  if (!isRecord(data) || typeof data.cancelled !== "boolean") {
    throw piError("PI_SESSION_CHANGE_INVALID_RESPONSE", `Pi ${command} returned no cancellation status`, "session", {
      stateMayHaveChanged: true,
      recovery: "Reload Pi state and reconcile the active native session before retrying."
    });
  }
  if (data.cancelled) {
    throw piError("PI_SESSION_CHANGE_CANCELLED", `Pi ${command} was cancelled by a session lifecycle hook`, "session", {
      retryable: true,
      recovery: "Resolve the extension lifecycle veto or keep using the current native session."
    });
  }
}

function nativeState(
  binding: NativeSessionBinding,
  state: PiRpcState,
  permissionMode: PermissionMode,
  fastMode: boolean,
  planMode: boolean,
  autoRetry: boolean,
  activeLeafId: string | undefined,
  usage?: UsageSnapshot
): NativeSessionState {
  const model = state.model as unknown as PiRpcModel | undefined;
  const pi = projectPiNativeState(state, { autoRetry, activeLeafId });
  return {
    binding,
    name: state.sessionName,
    streaming: state.isStreaming,
    compacting: state.isCompacting,
    pendingMessages: state.pendingMessageCount,
    providerId: model?.provider,
    modelId: model?.id,
    effort: state.thinkingLevel,
    fastMode,
    permissionMode,
    planMode,
    usage,
    autoCompaction: pi.autoCompaction,
    autoRetry: pi.autoRetry,
    pi
  };
}

function usageFromStats(stats: Record<string, unknown>): UsageSnapshot | undefined {
  if (!isRecord(stats.tokens)) return undefined;
  const inputTokens = numeric(stats.tokens.input);
  const outputTokens = numeric(stats.tokens.output);
  const cacheReadTokens = numeric(stats.tokens.cacheRead);
  const cacheWriteTokens = numeric(stats.tokens.cacheWrite);
  const totalTokens = numeric(stats.tokens.total, inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens);
  const context = isRecord(stats.contextUsage) ? stats.contextUsage : undefined;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    contextTokens: context ? optionalNumeric(context.tokens) : undefined,
    contextWindow: context ? optionalNumeric(context.contextWindow) : undefined,
    cost: numeric(stats.cost)
  };
}

function modelFromRpc(model: PiRpcModel, authoritativeLevels?: readonly string[], supportsFastMode = false): ProviderModel {
  const thinkingLevelMap = isRecord(model.thinkingLevelMap)
    ? model.thinkingLevelMap as Readonly<Record<string, string | null>>
    : undefined;
  const thinkingLevels = model.reasoning === true && authoritativeLevels !== undefined
    ? canonicalPiThinkingLevels(authoritativeLevels)
    : supportedPiThinkingLevels(model.reasoning, thinkingLevelMap);
  const contextWindow = numeric(model.contextWindow, 128_000);
  return {
    providerId: model.provider,
    modelId: model.id,
    displayName: model.name ?? model.id,
    api: model.api ?? "unknown",
    contextWindow,
    maxOutputTokens: piModelOutputTokenLimit(optionalNumeric(model.maxTokens), contextWindow),
    supportsImages: Array.isArray(model.input) && model.input.includes("image"),
    supportsFastMode,
    thinkingLevels,
    cost: {
      input: numeric(model.cost?.input),
      output: numeric(model.cost?.output),
      cacheRead: numeric(model.cost?.cacheRead),
      cacheWrite: numeric(model.cost?.cacheWrite)
    },
    ...(model.cost === undefined ? {} : {
      pricing: {
        source: "upstream" as const,
        currencyCode: "USD",
        cacheReadAvailable: model.cost.cacheRead !== undefined,
        cacheWriteAvailable: model.cost.cacheWrite !== undefined
      }
    })
  };
}

export function projectPiTreeNodes(values: readonly unknown[], secrets: readonly string[]): SessionTreeNode[] {
  const roots: SessionTreeNode[] = [];
  const stack: Array<{
    readonly values: readonly unknown[];
    readonly output: SessionTreeNode[];
    index: number;
  }> = [{ values, output: roots, index: 0 }];
  while (stack.length > 0) {
    const frame = stack.at(-1)!;
    if (frame.index >= frame.values.length) {
      stack.pop();
      continue;
    }
    const value = frame.values[frame.index++];
    const node = treeNode(value, secrets);
    if (node === undefined) continue;
    frame.output.push(node);
    if (isRecord(value) && Array.isArray(value.children) && value.children.length > 0) {
      stack.push({ values: value.children, output: node.children as SessionTreeNode[], index: 0 });
    }
  }
  return roots;
}

function treeNode(value: unknown, secrets: readonly string[]): SessionTreeNode | undefined {
  if (!isRecord(value) || !isRecord(value.entry) || typeof value.entry.id !== "string" || value.entry.id.length === 0) {
    return undefined;
  }
  const entry = value.entry as unknown as PiRpcTreeNode["entry"];
  const role = piTreeEntryRole(entry);
  return {
    entryId: entry.id,
    parentId: typeof entry.parentId === "string" ? entry.parentId : undefined,
    kind: typeof entry.type === "string" ? entry.type : "other",
    ...(role === undefined ? {} : { role }),
    label: piTreeEntryPreview(entry, typeof value.label === "string" ? value.label : undefined, secrets),
    timestamp: timestamp(entry.timestamp),
    children: []
  };
}

interface PiRpcModelIdentity {
  readonly provider: string;
  readonly id: string;
}

function piRpcModelIdentity(value: unknown): PiRpcModelIdentity | undefined {
  if (!isRecord(value) || typeof value.provider !== "string" || typeof value.id !== "string") return undefined;
  return { provider: value.provider, id: value.id };
}

function samePiRpcModelIdentity(
  left: PiRpcModelIdentity | undefined,
  right: PiRpcModelIdentity | undefined
): boolean {
  return left !== undefined && right !== undefined && left.provider === right.provider && left.id === right.id;
}

function piTreeEntryRole(entry: PiRpcTreeNode["entry"]): SessionTreeNode["role"] {
  if (entry.type === "custom_message") return "custom";
  if (entry.type !== "message") return undefined;
  const message = isRecord(entry.message) ? entry.message : undefined;
  switch (message?.role) {
    case "user": return "user";
    case "assistant": return "assistant";
    case "toolResult": return "toolResult";
    default: return "custom";
  }
}

function piTreeEntryPreview(
  entry: PiRpcTreeNode["entry"],
  resolvedLabel: string | undefined,
  secrets: readonly string[]
): string | undefined {
  let preview = "";
  if (entry.type === "message") {
    const message = isRecord(entry.message) ? entry.message : undefined;
    const role = typeof message?.role === "string" ? message.role : "custom";
    const content = piTreeContentText(message?.content);
    if (role === "user" || role === "assistant") {
      preview = content;
      if (preview === "" && role === "assistant") {
        preview = message?.stopReason === "aborted"
          ? "(aborted)"
          : typeof message?.errorMessage === "string" ? message.errorMessage : "(no content)";
      }
    } else if (role === "toolResult") {
      const name = typeof message?.toolName === "string" && message.toolName.trim() !== ""
        ? message.toolName
        : "tool";
      preview = content === "" ? `[${name}]` : `[${name}] ${content}`;
    } else if (role === "bashExecution") {
      preview = `[bash]: ${typeof message?.command === "string" ? message.command : ""}`;
    } else {
      preview = `[${role}]${content === "" ? "" : ` ${content}`}`;
    }
  } else if (entry.type === "custom_message") {
    const customType = typeof entry.customType === "string" && entry.customType.trim() !== ""
      ? entry.customType
      : "custom";
    preview = `[${customType}]: ${piTreeContentText(entry.content)}`;
  } else if (entry.type === "compaction") {
    preview = typeof entry.summary === "string" ? entry.summary : "[compaction]";
  } else if (entry.type === "branch_summary") {
    preview = typeof entry.summary === "string" ? entry.summary : "[branch summary]";
  } else if (entry.type === "model_change") {
    preview = `[model: ${typeof entry.modelId === "string" ? entry.modelId : "unknown"}]`;
  } else if (entry.type === "thinking_level_change") {
    preview = `[thinking: ${typeof entry.thinkingLevel === "string" ? entry.thinkingLevel : "unknown"}]`;
  } else if (entry.type === "custom") {
    preview = `[custom: ${typeof entry.customType === "string" ? entry.customType : "unknown"}]`;
  } else if (entry.type === "label") {
    preview = `[label: ${typeof entry.label === "string" && entry.label !== "" ? entry.label : "(cleared)"}]`;
  } else if (entry.type === "session_info") {
    preview = `[title: ${typeof entry.name === "string" && entry.name !== "" ? entry.name : "empty"}]`;
  }
  const normalizedLabel = typeof resolvedLabel === "string"
    ? redactManagedSecrets(resolvedLabel, secrets).replace(/[\n\t]/gu, " ").trim()
    : "";
  const normalizedPreview = redactManagedSecrets(preview, secrets).replace(/[\n\t]/gu, " ").trim();
  // Pi resolves labels onto their target tree node rather than replacing the
  // entry preview. Joko's generic tree contract has one display field, so keep
  // both pieces in the same order as Pi's selector: [label] preview.
  const normalized = normalizedLabel === ""
    ? normalizedPreview
    : `[${normalizedLabel}]${normalizedPreview === "" ? "" : ` ${normalizedPreview}`}`;
  return normalized === "" ? undefined : normalized.slice(0, MAXIMUM_PI_TREE_PREVIEW_CHARACTERS);
}

function piTreeContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { readonly type: "text"; readonly text: string } =>
      isRecord(part) && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function containsEntry(nodes: readonly SessionTreeNode[], entryId: string): boolean {
  const pending = [...nodes];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node.entryId === entryId) return true;
    pending.push(...node.children);
  }
  return false;
}

function expectedLeafAfterTreeNavigation(entry: PiRpcEntry): string | undefined {
  const message = isRecord(entry.message) ? entry.message : undefined;
  const returnsToParent = (entry.type === "message" && message?.role === "user") || entry.type === "custom_message";
  return returnsToParent ? entry.parentId ?? undefined : entry.id;
}

async function readControl(path: string, expectedGeneration: number): Promise<PiRuntimeControl> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (
      isRecord(value) &&
      value.generation === expectedGeneration &&
      Number.isSafeInteger(value.policyGeneration) &&
      (value.policyGeneration as number) >= 0 &&
      (value.permissionMode === "ask" || value.permissionMode === "auto" || value.permissionMode === "bypassPermissions") &&
      typeof value.planMode === "boolean" &&
      typeof value.fastMode === "boolean" &&
      (value.runtimePolicy === "standard" || value.runtimePolicy === "review_read_only") &&
      Array.isArray(value.approvedRoots) &&
      value.approvedRoots.every((root) => isRecord(root) && typeof root.path === "string" &&
        (root.access === "read_only" || root.access === "read_write")) &&
      typeof value.writtenAt === "string"
    ) {
      return value as unknown as PiRuntimeControl;
    }
    throw piError("PI_CONTROL_INVALID", "Managed Pi control file failed its generation or schema fence", "session", {
      recovery: "Stop the runtime and recreate its generation-scoped control file before resuming."
    });
  } catch (error) {
    throw asPiError(error, {
      code: "PI_CONTROL_READ_FAILED",
      phase: "session",
      retryable: true,
      recovery: "Restore the generation-scoped managed control file before using this runtime."
    });
  }
}

async function advanceRuntimePolicy(runtime: PiRuntime): Promise<void> {
  const current = await readControl(runtime.controlPath, runtime.transport.generation);
  const next: PiRuntimeControl = {
    ...current,
    policyGeneration: current.policyGeneration + 1,
    writtenAt: new Date().toISOString()
  };
  await writeRuntimeControl(runtime.controlPath, {
    generation: next.generation,
    policyGeneration: next.policyGeneration,
    permissionMode: next.permissionMode,
    planMode: next.planMode,
    fastMode: next.fastMode,
    approvedRoots: next.approvedRoots,
    runtimePolicy: next.runtimePolicy
  });
  runtime.control = next;
}

function runtimeControlForWrite(control: PiRuntimeControl): Omit<PiRuntimeControl, "writtenAt"> {
  return {
    generation: control.generation,
    policyGeneration: control.policyGeneration,
    permissionMode: control.permissionMode,
    planMode: control.planMode,
    fastMode: control.fastMode,
    approvedRoots: control.approvedRoots,
    runtimePolicy: control.runtimePolicy
  };
}

async function validateApprovedDirectories(
  directories: readonly ApprovedDirectory[],
  workspaceRoot: string
): Promise<readonly { readonly path: string; readonly access: "read_only" | "read_write" }[]> {
  const canonicalWorkspace = await realpath(resolve(workspaceRoot));
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();
  const roots: Array<{ path: string; access: "read_only" | "read_write" }> = [];
  for (const directory of directories) {
    if (!directory.id.trim() || seenIds.has(directory.id)) {
      throw piError("PI_EXTRA_DIRECTORY_ID_INVALID", "Approved extra-directory IDs must be non-empty and unique", "provision");
    }
    seenIds.add(directory.id);
    if (!isAbsolute(directory.path) || resolve(directory.path) !== directory.path) {
      throw piError("PI_EXTRA_DIRECTORY_PATH_INVALID", "Approved extra-directory paths must be normalized absolute paths", "provision");
    }
    if (directory.access !== "read_only" && directory.access !== "read_write") {
      throw piError("PI_EXTRA_DIRECTORY_ACCESS_INVALID", "Approved extra-directory access is invalid", "provision");
    }
    const info = await lstat(directory.path).catch((error) => {
      throw piError("PI_EXTRA_DIRECTORY_UNAVAILABLE", "An approved extra directory is unavailable", "provision", {
        recovery: "Restore or remove the directory approval before resuming Pi.",
        cause: error
      });
    });
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw piError("PI_EXTRA_DIRECTORY_UNSAFE", "An approved extra directory is a symlink, junction, file, or special node", "provision", {
        recovery: "Approve only canonical regular directories."
      });
    }
    const canonical = await realpath(directory.path);
    if (!samePath(canonical, directory.path)) {
      throw piError("PI_EXTRA_DIRECTORY_ALIAS_DENIED", "An approved extra-directory path is not canonical", "provision", {
        recovery: "Remove the aliased approval and add its canonical path."
      });
    }
    if (samePath(canonical, canonicalWorkspace)) continue;
    const key = process.platform === "win32" ? canonical.toLowerCase() : canonical;
    if (seenPaths.has(key)) throw piError("PI_EXTRA_DIRECTORY_DUPLICATE", "An approved extra directory is duplicated", "provision");
    seenPaths.add(key);
    roots.push({ path: canonical, access: directory.access });
  }
  roots.sort((left, right) => left.path.localeCompare(right.path));
  return roots;
}

function stableSessionKey(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
}

function stableSpawnIdentity(agentHome: string, sessionsRoot: string, sessionKey: string, generation: number): string {
  return createHash("sha256")
    .update([resolve(agentHome), resolve(sessionsRoot), sessionKey, String(generation)].join("\0"))
    .digest("hex");
}

function stableRemoteRecoveryIdentity(sessionId: string, targetId: string, hostId: string): string {
  return createHash("sha256")
    .update([sessionId, targetId, hostId].join("\0"))
    .digest("hex");
}

function managedSubagentObservationRoot(sessionRoot: string): string {
  return join(sessionRoot, "subagent-observations");
}

interface RemoteSubagentDeletionReceipt {
  readonly format: 1;
  readonly scope: "session" | "lineage";
  readonly sessionId: string;
  readonly targetId: string;
  readonly sessionKey: string;
  readonly bindingDigest: string;
  readonly deletionReceipt: string;
  readonly trashRecoveryKey: string;
  readonly recordedAt: number;
}

function remoteSubagentDeletionRoot(sessionRoot: string): string {
  return join(sessionRoot, "subagent-deletions");
}

function remoteSubagentDeletionPath(
  sessionRoot: string,
  input: Pick<RemoteSubagentDeletionReceipt, "scope" | "sessionId" | "targetId" | "bindingDigest">
): string {
  const key = createHash("sha256").update([
    input.scope,
    input.sessionId,
    input.targetId,
    input.bindingDigest
  ].join("\u0000")).digest("hex");
  return join(remoteSubagentDeletionRoot(sessionRoot), `${key}.json`);
}

function remoteSubagentTrashRecoveryKey(input: {
  readonly sessionId: string;
  readonly targetId: string;
  readonly bindingDigest: string;
  readonly deletionReceipt: string;
}): string {
  return createHash("sha256").update([
    "native-trash",
    input.sessionId,
    input.targetId,
    input.bindingDigest,
    input.deletionReceipt
  ].join("\u0000")).digest("hex");
}

function localSessionTrashRecoveryKey(
  binding: NativeSessionBinding,
  context: AdapterContext
): string | undefined {
  if (context.operationId === undefined) return undefined;
  return createHash("sha256").update([
    "local-native-trash",
    context.operationId,
    context.sessionId,
    context.target.id,
    binding.opaqueRef
  ].join("\u0000")).digest("hex");
}

async function findRemoteSubagentDeletionReceipt(
  sessionRoot: string,
  input: {
    readonly sessionId: string;
    readonly targetId: string;
    readonly bindingOpaqueRef: string;
  }
): Promise<RemoteSubagentDeletionReceipt | undefined> {
  if (input.sessionId.trim() === "" || input.sessionId.length > 512
      || input.targetId.trim() === "" || input.targetId.length > 512
      || input.bindingOpaqueRef.trim() === "") {
    throw new Error("remote managed Subagent deletion recovery scope is invalid");
  }
  const bindingDigest = createHash("sha256").update(input.bindingOpaqueRef).digest("hex");
  const retained: RemoteSubagentDeletionReceipt[] = [];
  for (const scope of ["session", "lineage"] as const) {
    const record = await readRemoteSubagentDeletionReceipt(remoteSubagentDeletionPath(sessionRoot, {
      scope,
      sessionId: input.sessionId,
      targetId: input.targetId,
      bindingDigest
    }));
    if (record === undefined) continue;
    if (record.scope !== scope
        || record.sessionId !== input.sessionId
        || record.targetId !== input.targetId
        || record.sessionKey !== managedSubagentSessionKey(input.sessionId)
        || record.bindingDigest !== bindingDigest
        || record.trashRecoveryKey !== remoteSubagentTrashRecoveryKey({
          sessionId: input.sessionId,
          targetId: input.targetId,
          bindingDigest,
          deletionReceipt: record.deletionReceipt
        })) {
      throw new Error("remote managed Subagent deletion retry journal does not match its Session binding");
    }
    retained.push(record);
  }
  if (retained.length > 1) {
    throw new Error("remote managed Subagent deletion retry journals conflict for the same Session binding");
  }
  return retained[0];
}

async function persistRemoteSubagentDeletionReceipt(
  sessionRoot: string,
  input: {
    readonly scope: "session" | "lineage";
    readonly sessionId: string;
    readonly targetId: string;
    readonly bindingOpaqueRef: string;
    readonly deletionReceipt: string;
  }
): Promise<RemoteSubagentDeletionReceipt> {
  if (input.sessionId.trim() === "" || input.sessionId.length > 512
      || input.targetId.trim() === "" || input.targetId.length > 512
      || !/^[0-9a-f]{64}$/u.test(input.deletionReceipt)) {
    throw new Error("remote managed Subagent deletion receipt scope is invalid");
  }
  const bindingDigest = createHash("sha256").update(input.bindingOpaqueRef).digest("hex");
  const record: RemoteSubagentDeletionReceipt = {
    format: 1,
    scope: input.scope,
    sessionId: input.sessionId,
    targetId: input.targetId,
    sessionKey: managedSubagentSessionKey(input.sessionId),
    bindingDigest,
    deletionReceipt: input.deletionReceipt,
    trashRecoveryKey: remoteSubagentTrashRecoveryKey({
      sessionId: input.sessionId,
      targetId: input.targetId,
      bindingDigest,
      deletionReceipt: input.deletionReceipt
    }),
    recordedAt: Date.now()
  };
  const root = remoteSubagentDeletionRoot(sessionRoot);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || !samePath(await realpath(root), root)) {
    throw new Error("remote managed Subagent deletion journal root is unsafe");
  }
  await chmod(root, 0o700);
  const path = remoteSubagentDeletionPath(sessionRoot, record);
  const existing = await readRemoteSubagentDeletionReceipt(path);
  if (existing !== undefined) {
    if (!sameRemoteSubagentDeletionReceipt(existing, record)) {
      throw new Error("remote managed Subagent deletion receipt conflicts with its retained retry journal");
    }
    return existing;
  }
  await atomicWriteJson(path, record);
  const retained = await readRemoteSubagentDeletionReceipt(path);
  if (retained === undefined || !sameRemoteSubagentDeletionReceipt(retained, record)) {
    throw new Error("remote managed Subagent deletion receipt was not durably retained");
  }
  return retained;
}

async function removeRemoteSubagentDeletionReceipt(
  sessionRoot: string,
  expected: RemoteSubagentDeletionReceipt
): Promise<void> {
  const path = remoteSubagentDeletionPath(sessionRoot, expected);
  const retained = await readRemoteSubagentDeletionReceipt(path);
  if (retained === undefined) return;
  if (!sameRemoteSubagentDeletionReceipt(retained, expected)) {
    throw new Error("remote managed Subagent deletion retry journal changed before final cleanup");
  }
  await rm(path, { force: false });
}

async function readRemoteSubagentDeletionReceipt(path: string): Promise<RemoteSubagentDeletionReceipt | undefined> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (info === undefined) return undefined;
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024
      || !samePath(await realpath(path), path)) {
    throw new Error("remote managed Subagent deletion retry journal is unsafe");
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error("remote managed Subagent deletion retry journal is malformed", { cause: error });
  }
  if (!isRecord(value) || value["format"] !== 1
      || (value["scope"] !== "session" && value["scope"] !== "lineage")
      || typeof value["sessionId"] !== "string" || value["sessionId"].trim() === "" || value["sessionId"].length > 512
      || typeof value["targetId"] !== "string" || value["targetId"].trim() === "" || value["targetId"].length > 512
      || typeof value["sessionKey"] !== "string" || !/^[0-9a-f]{40}$/u.test(value["sessionKey"])
      || typeof value["bindingDigest"] !== "string" || !/^[0-9a-f]{64}$/u.test(value["bindingDigest"])
      || typeof value["deletionReceipt"] !== "string" || !/^[0-9a-f]{64}$/u.test(value["deletionReceipt"])
      || typeof value["trashRecoveryKey"] !== "string" || !/^[0-9a-f]{64}$/u.test(value["trashRecoveryKey"])
      || !Number.isSafeInteger(value["recordedAt"]) || Number(value["recordedAt"]) < 0
      || Object.keys(value).some((key) => ![
        "format", "scope", "sessionId", "targetId", "sessionKey", "bindingDigest",
        "deletionReceipt", "trashRecoveryKey", "recordedAt"
      ].includes(key))) {
    throw new Error("remote managed Subagent deletion retry journal failed validation");
  }
  return value as unknown as RemoteSubagentDeletionReceipt;
}

function sameRemoteSubagentDeletionReceipt(
  left: RemoteSubagentDeletionReceipt,
  right: RemoteSubagentDeletionReceipt
): boolean {
  return left.format === right.format && left.scope === right.scope
    && left.sessionId === right.sessionId && left.targetId === right.targetId
    && left.sessionKey === right.sessionKey && left.bindingDigest === right.bindingDigest
    && left.deletionReceipt === right.deletionReceipt && left.trashRecoveryKey === right.trashRecoveryKey;
}

function parseRuntimeOwnerManifest(raw: string): PiRuntimeOwnerManifest {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw piError("PI_RUNTIME_OWNER_INVALID", "Managed Pi runtime owner manifest is malformed", "shutdown", {
      retryable: true,
      stateMayHaveChanged: true,
      recovery: "Inspect the fenced runtime directory before retrying service startup.",
      cause: error
    });
  }
  if (
    !isRecord(value) || value.format !== 1 ||
    typeof value.spawnIdentity !== "string" || !/^[a-f0-9]{64}$/u.test(value.spawnIdentity) ||
    typeof value.sessionKey !== "string" || !/^[a-f0-9]{24}$/u.test(value.sessionKey) ||
    !Number.isSafeInteger(value.productGeneration) || (value.productGeneration as number) < 0 ||
    (value.state !== "reserved" && value.state !== "running") ||
    (value.pid !== undefined && (!Number.isSafeInteger(value.pid) || (value.pid as number) < 1)) ||
    (value.processIdentity !== undefined && (typeof value.processIdentity !== "string" || !/^[a-f0-9]{64}$/u.test(value.processIdentity)))
  ) {
    throw piError("PI_RUNTIME_OWNER_INVALID", "Managed Pi runtime owner manifest failed its schema fence", "shutdown", {
      retryable: true,
      stateMayHaveChanged: true,
      recovery: "Inspect the fenced runtime directory before retrying service startup."
    });
  }
  return value as unknown as PiRuntimeOwnerManifest;
}

function stableNativeSessionId(sessionId: string, generation: number): string {
  return `joko-${stableSessionKey(sessionId)}-g${generation}`;
}

function normalizedAbsolutePath(path: string, code: string, label: string): string {
  const normalized = resolve(path);
  if (!isAbsolute(path) || normalized !== path) {
    throw piError(code, `${label} must be a normalized absolute path`, "provision");
  }
  return normalized;
}

function readAgentResourceSettings(read: (() => AgentResourceSettings) | undefined): AgentResourceSettings {
  return validateAgentResourceSettings(read === undefined ? DEFAULT_AGENT_RESOURCE_SETTINGS : read());
}

function uniqueNormalizedPaths(paths: readonly string[]): string[] {
  const values: string[] = [];
  for (const path of paths) if (!values.some((candidate) => samePath(candidate, path))) values.push(path);
  return values;
}

function readCollaborationSettings(read: (() => CollaborationSettings) | undefined): CollaborationSettings {
  return validateCollaborationSettings(read === undefined ? DEFAULT_COLLABORATION_SETTINGS : read());
}

function copyAdapterOptions(options: PiAdapterOptions, agentHome: string, sessionRoot: string): PiAdapterOptions {
  const managedResources = options.managedResources;
  return {
    ...options,
    agentHome,
    sessionRoot,
    ...(options.externalSessionRoots === undefined ? {} : { externalSessionRoots: [...options.externalSessionRoots] }),
    ...(options.providers === undefined ? {} : { providers: [...options.providers] }),
    ...(options.environment === undefined ? {} : { environment: { ...options.environment } }),
    ...(options.secretEnvironmentNames === undefined ? {} : { secretEnvironmentNames: [...options.secretEnvironmentNames] }),
    ...(options.hostCapabilities === undefined ? {} : { hostCapabilities: [...options.hostCapabilities] }),
    ...(options.hostToolCapabilities === undefined ? {} : { hostToolCapabilities: [...options.hostToolCapabilities] }),
    ...(options.nativeAuthProviderIds === undefined ? {} : { nativeAuthProviderIds: [...options.nativeAuthProviderIds] }),
    ...(options.nativeAuthenticatedProviderIds === undefined ? {} : { nativeAuthenticatedProviderIds: [...options.nativeAuthenticatedProviderIds] }),
    ...(options.nativeModels === undefined ? {} : { nativeModels: options.nativeModels.map(cloneProviderModel) }),
    ...(managedResources === undefined
      ? {}
      : {
          managedResources: {
            extensions: [...managedResources.extensions],
            skills: [...managedResources.skills],
            prompts: [...managedResources.prompts],
            packages: [...managedResources.packages],
            resources: managedResources.resources.map((resource) => ({ ...resource }))
          }
        })
  };
}

export function mergeManagedResourceSnapshots(
  global: PiManagedRuntimeResourceSnapshot,
  target: PiManagedRuntimeResourceSnapshot | undefined
): PiManagedRuntimeResourceSnapshot {
  const identityFor = (resource: RuntimeResource): string => {
    const source = resource.source.trim();
    const isStableIdentity = source.startsWith("npm:") || source.startsWith("git:") || source.startsWith("local:") || source.startsWith(`${resource.kind}:`);
    // Only a namespaced source identity is authoritative across scopes;
    // display-oriented source values remain distinct by resource ID.
    return isStableIdentity ? `source:${source}` : `id:${resource.id}`;
  };
  const pathIdentity = (path: string): string => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
  const resources = new Map<string, RuntimeResource>();
  const excludedPaths = new Set<string>();
  for (const resource of [...(target?.resources ?? []), ...global.resources]) {
    const identity = identityFor(resource);
    if (!resources.has(identity)) resources.set(identity, { ...resource });
    else if (resource.runtimePath !== undefined) {
      const selectedPath = resources.get(identity)?.runtimePath;
      if (selectedPath === undefined || pathIdentity(selectedPath) !== pathIdentity(resource.runtimePath)) {
        excludedPaths.add(pathIdentity(resource.runtimePath));
      }
    }
  }
  const uniquePaths = (project: readonly string[], inherited: readonly string[]): string[] => {
    const values = new Map<string, string>();
    for (const path of [...project, ...inherited]) {
      const key = pathIdentity(path);
      if (excludedPaths.has(key)) continue;
      if (!values.has(key)) values.set(key, path);
    }
    return [...values.values()];
  };
  return {
    extensions: uniquePaths(target?.extensions ?? [], global.extensions),
    skills: uniquePaths(target?.skills ?? [], global.skills),
    prompts: uniquePaths(target?.prompts ?? [], global.prompts),
    packages: uniquePaths(target?.packages ?? [], global.packages),
    resources: [...resources.values()]
  };
}

function runtimeWorkspaceRoot(target: TargetDescriptor): string {
  return target.remoteWorkspace?.workspaceRoot ?? target.workspaceRoot;
}

function sameRemoteWorkspace(
  left: TargetDescriptor["remoteWorkspace"],
  right: TargetDescriptor["remoteWorkspace"]
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.hostId === right.hostId && left.workspaceRoot === right.workspaceRoot;
}

function normalizedPosixAbsolutePath(value: string): boolean {
  if (
    value.length === 0 || value.length > 16_384 || value !== value.trim() ||
    !value.startsWith("/") || value.includes("\0") || /[\r\n]/u.test(value)
  ) return false;
  if (value === "/") return true;
  return !value.split("/").some((segment, index) =>
    index > 0 && (segment === "" || segment === "." || segment === "..")
  );
}

export function appendVisionBridgeDescriptions(message: string, descriptions: readonly string[]): string {
  const blocks = descriptions.map((description, index) => [
    `[Vision Bridge image ${index + 1}]`,
    description.trim(),
    "[End Vision Bridge image description]"
  ].join("\n"));
  return blocks.length === 0 ? message : `${message}\n\n${blocks.join("\n\n")}`;
}

export function isRuntimeResourceProvenLoaded(
  resource: RuntimeResource,
  commands: readonly RuntimeCommand[],
  tools: readonly PiRuntimeToolDescriptor[] = []
): boolean {
  // Pi exposes no package-level RPC observation. One loaded leaf cannot prove
  // that every declared member of the package loaded successfully.
  if (resource.kind === "package") return false;
  if (resource.runtimePath === undefined || !isAbsolute(resource.runtimePath)) return false;
  const commandLoaded = commands.some((command) => {
    if (!command.loaded || command.path === undefined || !isAbsolute(command.path)) return false;
    if (command.source !== resource.kind) return false;
    return samePathOrContained(resource.runtimePath!, command.path);
  });
  if (commandLoaded) return true;
  // get_commands cannot see an extension that only registers LLM-callable
  // tools. A matching sourceInfo path from the live getAllTools registry is
  // exact leaf evidence for that extension, but not for a skill, prompt, or
  // multi-resource package.
  if (resource.kind !== "extension") return false;
  return tools.some((tool) =>
    isAbsolute(tool.sourceInfo.path) && samePathOrContained(resource.runtimePath!, tool.sourceInfo.path)
  );
}

function cloneRuntimeToolCatalog(catalog: PiRuntimeToolCatalog): PiRuntimeToolCatalog {
  return {
    runtimeGeneration: catalog.runtimeGeneration,
    observedAt: catalog.observedAt,
    tools: catalog.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      active: tool.active,
      promptGuidelines: [...tool.promptGuidelines],
      sourceInfo: { ...tool.sourceInfo },
      inputSchema: {
        allowsAdditionalFields: tool.inputSchema.allowsAdditionalFields,
        fields: tool.inputSchema.fields.map((field) => ({
          ...field,
          enumValues: [...field.enumValues],
          ...(field.constraints === undefined ? {} : { constraints: { ...field.constraints } })
        }))
      }
    }))
  };
}

function samePathOrContained(root: string, candidate: string): boolean {
  const suffix = relative(resolve(root), resolve(candidate));
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}

function mergeProviderModels(managed: readonly ProviderModel[], native: readonly ProviderModel[]): readonly ProviderModel[] {
  const models = new Map<string, ProviderModel>();
  for (const model of [...managed, ...native]) {
    const key = `${model.providerId}\0${model.modelId}`;
    if (!models.has(key)) models.set(key, cloneProviderModel(model));
  }
  return [...models.values()].sort((left, right) =>
    left.providerId.localeCompare(right.providerId) || left.modelId.localeCompare(right.modelId)
  );
}

function cloneProviderModel(model: ProviderModel): ProviderModel {
  return {
    providerId: model.providerId,
    modelId: model.modelId,
    ...(model.logicalId === undefined ? {} : { logicalId: model.logicalId }),
    displayName: model.displayName,
    api: model.api,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    supportsImages: model.supportsImages,
    supportsFastMode: model.supportsFastMode ?? false,
    ...(model.defaultVisible === undefined ? {} : { defaultVisible: model.defaultVisible }),
    thinkingLevels: [...model.thinkingLevels],
    cost: { ...model.cost },
    ...(model.pricing === undefined ? {} : { pricing: { ...model.pricing } })
  };
}

function validateNativeAuthOptions(options: PiAdapterOptions): void {
  if (options.persistNativeAuth !== undefined && options.loadNativeAuth === undefined) {
    throw piError("PI_NATIVE_AUTH_LOAD_REQUIRED", "Native credential persistence requires a matching generation-fenced loader", "provision");
  }
  if (options.loadNativeAuth !== undefined) {
    if (!Number.isSafeInteger(options.catalogGeneration) || (options.catalogGeneration ?? -1) < 0) {
      throw piError("PI_NATIVE_AUTH_GENERATION_REQUIRED", "Native Provider credentials require a non-negative catalog generation", "provision");
    }
    for (const providerId of options.nativeAuthProviderIds ?? []) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(providerId)) {
        throw piError("PI_NATIVE_AUTH_PROVIDER_INVALID", "Native Provider allowlist contains an invalid ID", "provision");
      }
    }
  }
  const allowed = new Set(options.nativeAuthProviderIds ?? []);
  for (const providerId of options.nativeAuthenticatedProviderIds ?? []) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(providerId) || !allowed.has(providerId)) {
      throw piError(
        "PI_NATIVE_AUTH_STATE_INVALID",
        "Authenticated native Provider IDs must be a subset of the generation allowlist",
        "provision"
      );
    }
  }
}

function normalizeNativeAuthMap(
  value: unknown,
  allowedProviderIds: readonly string[]
): Readonly<Record<string, PiNativeCredential>> {
  if (!isRecord(value)) throw new Error("Native credential snapshot must be an object.");
  const allowed = new Set(allowedProviderIds);
  for (const providerId of Object.keys(value)) {
    if (!allowed.has(providerId)) throw new Error("Native credential snapshot contains a Provider outside the generation allowlist.");
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new Error("Native credential snapshot is not JSON serializable.", { cause: error });
  }
  if (Buffer.byteLength(serialized, "utf8") > 4 * 1024 * 1024) {
    throw new Error("Native credential snapshot exceeds 4 MiB.");
  }
  const cloned = JSON.parse(serialized) as unknown;
  if (!isRecord(cloned)) throw new Error("Native credential snapshot must decode to an object.");
  const normalized: Record<string, PiNativeCredential> = Object.create(null) as Record<string, PiNativeCredential>;
  for (const [providerId, candidate] of Object.entries(cloned)) {
    if (!isRecord(candidate)) throw new Error("Native Provider credential has an invalid type.");
    if (candidate.type === "oauth") {
      if (typeof candidate.access !== "string" || candidate.access.length === 0) throw new Error("Native Provider credential has no access token.");
      if (typeof candidate.refresh !== "string" || candidate.refresh.length === 0) throw new Error("Native Provider credential has no refresh token.");
      if (typeof candidate.expires !== "number" || !Number.isFinite(candidate.expires) || candidate.expires <= 0) {
        throw new Error("Native Provider credential has an invalid expiry.");
      }
    } else if (candidate.type === "api_key") {
      if (candidate.key !== undefined && (typeof candidate.key !== "string" || candidate.key.length === 0)) {
        throw new Error("Native Provider credential has an invalid API key.");
      }
      if (candidate.env !== undefined) {
        if (!isRecord(candidate.env) || Object.keys(candidate.env).length > 64) {
          throw new Error("Native Provider credential has an invalid environment.");
        }
        for (const [name, environmentValue] of Object.entries(candidate.env)) {
          if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(name)
            || typeof environmentValue !== "string"
            || environmentValue.length === 0
            || Buffer.byteLength(environmentValue, "utf8") > 8 * 1024) {
            throw new Error("Native Provider credential has an invalid environment.");
          }
        }
      }
    } else {
      throw new Error("Native Provider credential has an invalid type.");
    }
    assertNoPrototypeKeys(candidate);
    normalized[providerId] = candidate as PiNativeCredential;
  }
  return normalized;
}

function assertNoPrototypeKeys(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertNoPrototypeKeys(item);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new Error("Native credential snapshot contains a forbidden object key.");
    }
    assertNoPrototypeKeys(item);
  }
}

function digestNativeCredential(value: PiNativeCredential): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function collectNativeCredentialSecrets(credentials: Readonly<Record<string, PiNativeCredential>>): readonly string[] {
  const secrets = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      if (value !== "oauth" && value !== "api_key" && value.length >= 4) secrets.add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (isRecord(value)) for (const item of Object.values(value)) visit(item);
  };
  visit(credentials);
  return [...secrets].sort((left, right) => right.length - left.length);
}

async function readNativeAuthUpdates(
  state: PiRuntimeNativeAuth
): Promise<readonly { readonly providerId: string; readonly credential: PiNativeCredential }[]> {
  const authPath = join(state.agentHome, "auth.json");
  const info = await lstat(authPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (info === undefined) return [];
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) {
    throw new Error("Runtime auth.json is not a bounded regular file.");
  }
  const canonical = await realpath(authPath);
  assertContained(state.agentHome, canonical, "runtime auth.json");
  if (!samePath(canonical, authPath)) throw new Error("Runtime auth.json contains a path alias.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(canonical, "utf8"));
  } catch (error) {
    throw new Error("Runtime auth.json is invalid JSON.", { cause: error });
  }
  const credentials = normalizeNativeAuthMap(parsed, state.providerIds);
  return Object.entries(credentials)
    .filter(([providerId, credential]) => state.initialDigests.get(providerId) !== digestNativeCredential(credential))
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([providerId, credential]) => ({ providerId, credential }));
}

function validateEnvironment(env: NodeJS.ProcessEnv): void {
  for (const [key, value] of Object.entries(env)) {
    const validName = /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || key === "ProgramFiles(x86)";
    if (!validName || key.includes("=")) throw piError("PI_INVALID_ENVIRONMENT", "Pi process environment contains an invalid key", "spawn");
    if (value?.includes("\0")) throw piError("PI_INVALID_ENVIRONMENT", `Pi process environment '${key}' contains NUL`, "spawn");
  }
}

function credentialedProxySecrets(env: NodeJS.ProcessEnv): {
  readonly names: readonly string[];
  readonly values: readonly string[];
} {
  const names = new Set<string>();
  const values = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (!/^(?:HTTP|HTTPS)_PROXY$/iu.test(name) || typeof value !== "string" || value.length === 0) continue;
    let username = "";
    let password = "";
    try {
      const parsed = new URL(value);
      username = parsed.username;
      password = parsed.password;
      if (username === "" && password === "") continue;
    } catch {
      if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/@\s]+@/u.test(value)) continue;
    }
    names.add(name);
    values.add(value);
    const rawUserInfo = password === "" ? username : `${username}:${password}`;
    if (rawUserInfo !== "") values.add(rawUserInfo);
    const decodedUsername = safeDecodeUriComponent(username);
    const decodedPassword = safeDecodeUriComponent(password);
    const decodedUserInfo = decodedPassword === "" ? decodedUsername : `${decodedUsername}:${decodedPassword}`;
    if (decodedUserInfo !== "") values.add(decodedUserInfo);
    // Individual values are useful when a proxy client reports only one side
    // of userinfo. Avoid one-character redaction needles that would destroy
    // otherwise harmless diagnostics while the complete URL/userinfo remains
    // covered above.
    for (const credential of [username, password, decodedUsername, decodedPassword]) {
      if (credential.length >= 4) values.add(credential);
    }
  }
  return { names: [...names].sort(), values: [...values].sort((left, right) => right.length - left.length) };
}

function safeDecodeUriComponent(value: string): string {
  if (value === "") return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function mergeNoProxy(existing: string | undefined): string {
  const values = new Set((existing ?? "").split(",").map((value) => value.trim()).filter(Boolean));
  values.add("127.0.0.1");
  values.add("localhost");
  values.add("::1");
  return [...values].join(",");
}

function assertContained(root: string, candidate: string, label: string): void {
  const suffix = relative(resolve(root), resolve(candidate));
  if (suffix === "" || (!suffix.startsWith(`..${sep}`) && suffix !== ".." && !isAbsolute(suffix))) return;
  throw piError("PI_PATH_ESCAPE", `${label} escapes its managed root`, "provision");
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32" ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase() : normalizedLeft === normalizedRight;
}

function inactiveContinuationError(disposition: "steer" | "follow_up") {
  const label = disposition === "steer" ? "Steering" : "Follow-up";
  return piError(
    disposition === "steer" ? "PI_STEER_REQUIRES_ACTIVE_RUN" : "PI_FOLLOW_UP_REQUIRES_ACTIVE_RUN",
    `${label} input requires an active Pi agent lifecycle`,
    "dispatch",
    {
      recovery: "Submit the input as a new prompt after the previous run has settled."
    }
  );
}

function routeLifecycleEvent(lifecycle: PiNativeLifecycle, event: PiRpcEvent): AdapterContext {
  if (event.type !== "message_start") return lifecycle.currentContext;
  const record = event as unknown as Record<string, unknown>;
  if (!isRecord(record.message) || record.message.role !== "user") return lifecycle.currentContext;
  if (!lifecycle.initialUserMessageSeen) {
    lifecycle.initialUserMessageSeen = true;
    lifecycle.currentContext = lifecycle.owner.context;
    return lifecycle.currentContext;
  }
  const steering = takeLifecycleParticipant(lifecycle.pendingSteering);
  if (steering !== undefined) {
    // Steering mutates the currently executing native Run; it is not a new
    // output lifecycle. Its own durable product Run receives only terminal
    // acknowledgement when the shared native lifecycle settles.
    return lifecycle.currentContext;
  }
  const followUp = takeLifecycleParticipant(lifecycle.pendingFollowUps);
  if (followUp !== undefined) lifecycle.currentContext = followUp.context;
  return lifecycle.currentContext;
}

function takeLifecycleParticipant(
  participants: PiNativeLifecycleParticipant[]
): PiNativeLifecycleParticipant | undefined {
  return participants.shift();
}

function redactPiRpcEntry(entry: PiRpcEntry, secrets: readonly string[]): PiRpcEntry {
  const redacted = redactPiNativeValue(entry, secrets);
  if (!isRecord(redacted)) {
    throw piError("PI_ENTRY_RESPONSE_INVALID", "Pi returned an invalid native history entry", "stream");
  }
  return redacted as PiRpcEntry;
}

function redactPiNativeValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redactManagedSecrets(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactPiNativeValue(item, secrets));
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [rawKey, item] of Object.entries(value)) {
    const baseKey = redactManagedSecrets(rawKey, secrets);
    let key = baseKey;
    if (Object.hasOwn(result, key)) {
      const suffix = createHash("sha256").update(rawKey).digest("hex").slice(0, 12);
      key = `${baseKey}#${suffix}`;
    }
    result[key] = redactPiNativeValue(item, secrets);
  }
  return result;
}

function projectPiMessages(values: readonly unknown[], secrets: readonly string[]): readonly PiProjectedMessage[] {
  const occurrences = new Map<string, number>();
  const messages: PiProjectedMessage[] = [];
  for (const value of values) {
    const projected = projectPiMessage(value, secrets);
    if (projected === undefined) continue;
    // Pi's AgentMessage schema intentionally has no message ID. Hash only the
    // already-redacted projection, then disambiguate exact duplicates.
    // This remains stable across repeated reads without impersonating a native
    // Pi entry/message identity.
    const fingerprint = createHash("sha256").update(JSON.stringify(projected)).digest("hex").slice(0, 24);
    const occurrence = occurrences.get(fingerprint) ?? 0;
    occurrences.set(fingerprint, occurrence + 1);
    messages.push({
      id: `joko:pi-message:${fingerprint}:${occurrence}`,
      ...projected
    });
  }
  return messages;
}

function projectPiMessage(
  value: unknown,
  secrets: readonly string[]
): Omit<PiProjectedMessage, "id"> | undefined {
  if (!isRecord(value)) return undefined;
  const nativeRole = typeof value.role === "string" ? value.role : "custom";
  const role: PiProjectedMessageRole = nativeRole === "user" || nativeRole === "assistant" || nativeRole === "toolResult"
    ? nativeRole
    : "custom";
  let content = projectPiMessageParts(value.content, secrets);
  if (content.length === 0) {
    const fallback = projectPiCustomMessageText(nativeRole, value, secrets);
    if (fallback !== undefined) content = [{ type: "text", text: fallback }];
  }
  const timestamp = typeof value.timestamp === "number" && Number.isSafeInteger(value.timestamp) && value.timestamp >= 0
    ? value.timestamp
    : undefined;
  const usage = projectPiMessageUsage(value.usage);
  const toolCallId = role === "toolResult" && typeof value.toolCallId === "string"
    ? boundedPiMessageText(value.toolCallId, secrets, 512)
    : undefined;
  const toolName = role === "toolResult" && typeof value.toolName === "string"
    ? boundedPiMessageText(value.toolName, secrets, 256)
    : undefined;
  return {
    role,
    content,
    ...(timestamp === undefined ? {} : { timestamp }),
    ...(toolCallId === undefined ? {} : { toolCallId }),
    ...(toolName === undefined ? {} : { toolName }),
    ...(role !== "toolResult" ? {} : { isError: value.isError === true }),
    ...(usage === undefined ? {} : { usage })
  };
}

function projectPiMessageParts(value: unknown, secrets: readonly string[]): PiProjectedMessagePart[] {
  if (typeof value === "string") {
    return [{ type: "text", text: boundedPiMessageText(value, secrets) }];
  }
  if (!Array.isArray(value)) return [];
  const parts: PiProjectedMessagePart[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) continue;
    if (candidate.type === "text" && typeof candidate.text === "string") {
      parts.push({ type: "text", text: boundedPiMessageText(candidate.text, secrets) });
      continue;
    }
    if (candidate.type === "thinking" && typeof candidate.thinking === "string") {
      const redacted = candidate.redacted === true;
      parts.push({
        type: "thinking",
        thinking: redacted ? "" : boundedPiMessageText(candidate.thinking, secrets),
        redacted
      });
      continue;
    }
    if (candidate.type === "image") {
      const image = projectPiMessageImage(candidate, secrets);
      if (image !== undefined) parts.push(image);
      continue;
    }
    if (candidate.type === "toolCall") {
      parts.push({
        type: "toolCall",
        id: boundedPiMessageText(typeof candidate.id === "string" ? candidate.id : "", secrets, 512),
        name: boundedPiMessageText(
          typeof candidate.name === "string" ? candidate.name : "",
          secrets,
          256
        ),
        arguments: projectPiToolArguments(candidate.arguments, secrets)
      });
    }
  }
  return parts;
}

function projectPiMessageImage(
  value: Record<string, unknown>,
  secrets: readonly string[]
): Extract<PiProjectedMessagePart, { readonly type: "image" }> | undefined {
  if (typeof value.data !== "string" || typeof value.mimeType !== "string") return undefined;
  const mimeType = boundedPiMessageText(value.mimeType, secrets, 128).toLowerCase();
  if (!/^image\/[a-z0-9][a-z0-9.+-]*$/u.test(mimeType)) return undefined;
  const data = value.data.replace(/\s+/gu, "");
  if (canonicalBase64ByteLength(data) === undefined) return undefined;
  return { type: "image", data, mimeType };
}

/** Validate canonical padded base64 and compute its bytes without decoding a
 * potentially large Pi history image into a second in-memory copy. */
function canonicalBase64ByteLength(value: string): number | undefined {
  if (value.length === 0 || value.length % 4 !== 0) return undefined;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const contentLength = value.length - padding;
  for (let index = 0; index < contentLength; index += 1) {
    if (base64AlphabetValue(value.charCodeAt(index)) < 0) return undefined;
  }
  for (let index = contentLength; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 0x3d) return undefined;
  }
  if (padding === 2 && (base64AlphabetValue(value.charCodeAt(contentLength - 1)) & 0x0f) !== 0) return undefined;
  if (padding === 1 && (base64AlphabetValue(value.charCodeAt(contentLength - 1)) & 0x03) !== 0) return undefined;
  const byteLength = value.length / 4 * 3 - padding;
  return byteLength > 0 ? byteLength : undefined;
}

function base64AlphabetValue(value: number): number {
  if (value >= 0x41 && value <= 0x5a) return value - 0x41;
  if (value >= 0x61 && value <= 0x7a) return value - 0x61 + 26;
  if (value >= 0x30 && value <= 0x39) return value - 0x30 + 52;
  if (value === 0x2b) return 62;
  if (value === 0x2f) return 63;
  return -1;
}

function projectPiCustomMessageText(
  nativeRole: string,
  value: Record<string, unknown>,
  secrets: readonly string[]
): string | undefined {
  if (nativeRole === "bashExecution") {
    const command = typeof value.command === "string" ? boundedPiMessageText(value.command, secrets) : "";
    const output = typeof value.output === "string" ? boundedPiMessageText(value.output, secrets) : "";
    const status = value.cancelled === true
      ? "\n[command cancelled]"
      : typeof value.exitCode === "number" && Number.isSafeInteger(value.exitCode) && value.exitCode !== 0
        ? `\n[command exited with code ${value.exitCode}]`
        : "";
    return boundedPiMessageText(`$ ${command}${output === "" ? "" : `\n${output}`}${status}`, secrets);
  }
  if (nativeRole === "branchSummary" || nativeRole === "compactionSummary") {
    return typeof value.summary === "string" ? boundedPiMessageText(value.summary, secrets) : undefined;
  }
  return undefined;
}

function projectPiToolArguments(value: unknown, secrets: readonly string[]): Readonly<Record<string, string>> {
  if (value === undefined) return {};
  const entries = isRecord(value) ? Object.entries(value) : [["$", value] as const];
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [rawKey, item] of entries) {
    const baseKey = boundedPiMessageText(rawKey, secrets);
    const key = Object.hasOwn(result, baseKey)
      ? `${baseKey}#${createHash("sha256").update(rawKey).digest("hex").slice(0, 12)}`
      : baseKey;
    result[key] = /token|secret|password|api[_-]?key/iu.test(rawKey)
      ? "[REDACTED]"
      : boundedPiMessageText(safePiMessageJson(item), secrets);
  }
  return result;
}

function projectPiMessageUsage(value: unknown): NonNullable<PiProjectedMessage["usage"]> | undefined {
  if (!isRecord(value)) return undefined;
  const input = boundedPiMessageCount(value.input);
  const output = boundedPiMessageCount(value.output);
  const cacheRead = boundedPiMessageCount(value.cacheRead);
  const cacheWrite = boundedPiMessageCount(value.cacheWrite);
  const totalTokens = boundedPiMessageCount(value.totalTokens);
  const cost = isRecord(value.cost) ? value.cost.total : undefined;
  const costMicros = typeof cost === "number" && Number.isFinite(cost) && cost > 0
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.round(cost * 1_000_000))
    : 0;
  return { input, output, cacheRead, cacheWrite, totalTokens, costMicros };
}

function boundedPiMessageCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value))
    : 0;
}

function boundedPiMessageText(
  value: string,
  secrets: readonly string[],
  maximumCharacters?: number
): string {
  const redacted = redactManagedSecrets(value, secrets);
  return maximumCharacters === undefined ? redacted : redacted.slice(0, maximumCharacters);
}

function safePiMessageJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "[unserializable]";
  }
}

function uniqueLifecycleContexts(lifecycle: PiNativeLifecycle): readonly AdapterContext[] {
  return [...new Set(lifecycle.participants.map((participant) => participant.context))];
}

function normalizePiDirectBashResult(value: unknown, secrets: readonly string[]): {
  readonly output: string;
  readonly exitCode?: number;
  readonly cancelled: boolean;
  readonly truncated: boolean;
  readonly fullOutputPath?: string;
} {
  if (!isRecord(value)) {
    throw piError("PI_BASH_RESPONSE_INVALID", "Pi returned an invalid user shell response", "stream", {
      stateMayHaveChanged: true,
      recovery: "Inspect the native session before deciding whether to run the command again."
    });
  }
  const exitCode = typeof value.exitCode === "number" && Number.isSafeInteger(value.exitCode)
    ? value.exitCode
    : undefined;
  return {
    output: redactManagedSecrets(typeof value.output === "string" ? value.output : "", secrets),
    ...(exitCode === undefined ? {} : { exitCode }),
    cancelled: value.cancelled === true,
    truncated: value.truncated === true,
    ...(typeof value.fullOutputPath === "string" ? { fullOutputPath: value.fullOutputPath } : {})
  };
}

async function materializeUserShellArtifact(
  runtime: PiRuntime,
  result: ReturnType<typeof normalizePiDirectBashResult>,
  context: AdapterContext,
  callId: string
): Promise<BlobRef | undefined> {
  let redacted: string | undefined;
  const artifactCapacityBytes = requireArtifactCapacity(context);
  if (result.fullOutputPath !== undefined) {
    const [root, canonical, linkInfo, info] = await Promise.all([
      realpath(runtime.artifactDirectory),
      realpath(result.fullOutputPath),
      lstat(result.fullOutputPath),
      stat(result.fullOutputPath)
    ]);
    const suffix = relative(root, canonical);
    const contained = suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
    if (!contained || linkInfo.isSymbolicLink() || !info.isFile()) {
      throw piError("PI_ARTIFACT_SOURCE_INVALID", "Pi user shell output is not a regular runtime file", "stream");
    }
    if (info.size > artifactCapacityBytes) {
      throw piError(
        "PI_ARTIFACT_CAPACITY_EXCEEDED",
        "Pi user shell output exceeds the host Artifact capacity",
        "stream",
        { recovery: "Increase Artifact storage capacity or rerun the command with narrower output." }
      );
    }
    redacted = redactManagedSecrets(await readFile(canonical, "utf8"), runtime.redactValues);
  } else if (Buffer.byteLength(result.output, "utf8") > INLINE_USER_SHELL_OUTPUT_LIMIT) {
    if (Buffer.byteLength(result.output, "utf8") > artifactCapacityBytes) {
      throw piError(
        "PI_ARTIFACT_CAPACITY_EXCEEDED",
        "Pi user shell output exceeds the host Artifact capacity",
        "stream",
        { recovery: "Increase Artifact storage capacity or rerun the command with narrower output." }
      );
    }
    redacted = result.output;
  }
  if (redacted === undefined) return undefined;
  if (Buffer.byteLength(redacted, "utf8") > artifactCapacityBytes) {
    throw piError(
      "PI_ARTIFACT_CAPACITY_EXCEEDED",
      "Redacted Pi user shell output exceeds the host Artifact capacity",
      "stream",
      { recovery: "Increase Artifact storage capacity or rerun the command with narrower output." }
    );
  }

  const temporaryPath = join(runtime.artifactDirectory, `joko-user-shell-${randomUUID()}.log`);
  await writeFile(temporaryPath, redacted, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    return await context.storeArtifact(temporaryPath, {
      fileName: `${callId}.log`,
      mimeType: "text/plain"
    });
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function requireArtifactCapacity(context: AdapterContext): number {
  if (!Number.isSafeInteger(context.artifactCapacityBytes) || context.artifactCapacityBytes < 1) {
    throw piError("PI_ARTIFACT_CAPABILITY_INVALID", "Host Artifact capacity is invalid", "resource");
  }
  return context.artifactCapacityBytes;
}

function boundedUserShellOutput(output: string): string {
  if (Buffer.byteLength(output, "utf8") <= INLINE_USER_SHELL_OUTPUT_LIMIT) return output;
  return Buffer.from(output, "utf8").subarray(0, INLINE_USER_SHELL_OUTPUT_LIMIT).toString("utf8");
}

function userShellCompletionText(result: PiDirectBashResult): string {
  const parts = [result.output];
  if (result.cancelled) parts.push("[command cancelled]");
  else if (result.exitCode !== undefined && result.exitCode !== 0) parts.push(`[command exited with code ${result.exitCode}]`);
  if (result.artifact !== undefined) parts.push("[full output stored as artifact]");
  else if (result.truncated) parts.push("[full output artifact unavailable]");
  return parts.filter((part) => part !== "").join("\n");
}

function userShellMetadata(
  rpcEventType: string,
  lifecycle: PiUserShellLifecycle,
  detail: {
    readonly delta?: string;
    readonly stderr?: boolean;
    readonly completed?: boolean;
    readonly exitCode?: number;
    readonly cancelled?: boolean;
  } = {}
): AdapterEventMetadata {
  const delta = detail.delta ?? "";
  const pi: PiEventMetadata = {
    rpcEventType,
    nativeToolName: "user_shell",
    payload: {
      case: "bashUpdate",
      value: {
        nativeBashId: lifecycle.callId,
        commandDisplay: lifecycle.commandDisplay,
        stdoutDelta: detail.stderr === true ? "" : delta,
        stderrDelta: detail.stderr === true ? delta : "",
        completed: detail.completed === true,
        exitCode: detail.exitCode ?? 0,
        excludedFromContext: lifecycle.excludeFromContext
      }
    }
  };
  return {
    namespace: "pi",
    fields: {
      rpcEventType,
      callId: lifecycle.callId,
      completed: detail.completed === true,
      [NATIVE_HISTORY_REPLACES_TRANSIENT_FIELD]: true,
      ...(detail.cancelled === undefined ? {} : { cancelled: detail.cancelled }),
      ...(detail.exitCode === undefined ? {} : { exitCode: detail.exitCode })
    },
    pi
  };
}

function piMetadata(type: string) {
  return { namespace: "pi", fields: { rpcEventType: type } } as const;
}

function toNativeHistoryEntry(value: unknown): PiNativeHistoryEntry {
  if (!isRecord(value)) {
    throw piError("PI_HISTORY_ENTRY_INVALID", "Pi returned a non-object native history entry", "session");
  }
  const id = boundedNativeIdentifier(value.id, "entry");
  const type = boundedNativeIdentifier(value.type, "entry type", 256);
  const parentId = value.parentId === null || value.parentId === undefined
    ? undefined
    : boundedNativeIdentifier(value.parentId, "parent entry");
  let parsedTimestamp: number | undefined;
  if (typeof value.timestamp === "number" && Number.isSafeInteger(value.timestamp) && value.timestamp >= 0) {
    parsedTimestamp = value.timestamp;
  } else if (typeof value.timestamp === "string") {
    const parsed = Date.parse(value.timestamp);
    if (Number.isSafeInteger(parsed) && parsed >= 0) parsedTimestamp = parsed;
  }
  return {
    id,
    ...(parentId === undefined ? {} : { parentId }),
    type,
    ...(parsedTimestamp === undefined ? {} : { timestamp: parsedTimestamp }),
    data: { ...value }
  };
}

function boundedNativeIdentifier(value: unknown, label: string, maximumLength = 4_096): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > maximumLength || value.includes("\0")) {
    throw piError("PI_HISTORY_ENTRY_INVALID", `Pi returned an invalid native ${label} identifier`, "session");
  }
  return value;
}

function numeric(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function optionalNumeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalUnsignedNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function configuredAutoCompactionThresholdPercent(settings: PiManagedSettings | undefined): number {
  const percent = settings?.compaction?.thresholdPercent ?? PI_AUTO_COMPACTION_THRESHOLD_PERCENT_DEFAULT;
  assertAutoCompactionThresholdPercent(percent);
  return percent;
}

function assertAutoCompactionThresholdPercent(percent: number): void {
  if (
    !Number.isSafeInteger(percent)
    || percent < PI_AUTO_COMPACTION_THRESHOLD_PERCENT_MINIMUM
    || percent > PI_AUTO_COMPACTION_THRESHOLD_PERCENT_MAXIMUM
  ) {
    throw piError(
      "PI_AUTO_COMPACTION_THRESHOLD_INVALID",
      `Automatic compaction threshold must be an integer from ${PI_AUTO_COMPACTION_THRESHOLD_PERCENT_MINIMUM} through ${PI_AUTO_COMPACTION_THRESHOLD_PERCENT_MAXIMUM}`,
      "provision"
    );
  }
}

function timestamp(value: unknown): number {
  if (typeof value !== "string") return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
