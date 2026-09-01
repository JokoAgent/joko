import { createHash, randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, normalize, relative, resolve, sep } from "node:path";
import {
  createChildRuntimeEnvironment,
  type DurableProcessOwnerOptions
} from "@joko/runtime-governance";
import {
  CAPABILITIES,
  CapabilityDrivenBackendAdapter,
  HOST_COMPOSED_CAPABILITIES,
  JokoError,
  type AdapterContext,
  type AdapterEventMetadata,
  type ApprovedDirectory,
  type BackendAuthenticationState,
  type BackendDescriptor,
  type Capability,
  type CreateNativeSessionInput,
  type EventPayload,
  type HostComposedCapability,
  type InteractionDecision,
  type InteractionPayload,
  type MessageBlock,
  type NativeHistoryProjectedEvent,
  type NativeHistoryProjection,
  type NativeSessionBinding,
  type NativeSessionCatalogEntry,
  type NativeSessionCatalogResult,
  type NativeSessionCandidate,
  type NativeSessionState,
  type PermissionMode,
  type PromptInput,
  type ProviderModel,
  type PublicError,
  type SubagentControlInput,
  type TargetDescriptor,
  type UsageSnapshot
} from "@joko/core";
import { AsyncInputGate, deferred, type Deferred } from "./async-input-gate.js";
import { claudeCodeError } from "./errors.js";
import {
  PartialMessageBuffer,
  ProjectionLimitError,
  SafeProjection,
  finite,
  providerModel,
  record,
  stringValue
} from "./projection.js";
import {
  CLAUDE_AGENT_SDK_VERSION,
  DefaultClaudeSdkRuntime,
  type ClaudeCanUseToolOptions,
  type ClaudePermissionResult,
  type ClaudePermissionUpdate,
  type ClaudeSdkAccountInfo,
  type ClaudeSdkProbe,
  type ClaudeSdkInitializationResult,
  type ClaudeSdkModelInfo,
  type ClaudeSdkPermissionMode,
  type ClaudeSdkQuery,
  type ClaudeSdkRuntime,
  type ClaudeSdkSessionInfo,
  type ClaudeSdkSessionMessage,
  type ClaudeSdkUserMessage
} from "./sdk-runtime.js";
import {
  claudeCatalogSourceIsCurrent,
  scanClaudeSessionCatalog,
  type ClaudeCatalogSource
} from "./session-catalog.js";
import {
  ClaudeCodeOAuthAccount,
  type ClaudeCodeAccountSnapshot,
  type ClaudeCodeCredentialPort
} from "./oauth-account.js";
import {
  ClaudeNativeTaskProjection,
  isNativeTaskSystemSubtype,
  type NativeTaskEmission
} from "./native-task-projection.js";

const ADAPTER_ID = "claude-code";
const PROVIDER_ID = "claude-code";
const OPAQUE_REFERENCE_PREFIX = "claude-code:session:";
const DEFAULT_INITIALIZATION_TIMEOUT_MS = 20_000;
const DEFAULT_ADMISSION_TIMEOUT_MS = 20_000;
const DEFAULT_TEARDOWN_TIMEOUT_MS = 5_000;
const DEFAULT_INTERRUPT_TIMEOUT_MS = 5_000;
const DEFAULT_NATIVE_CONTINUATION_GRACE_MS = 60_000;
const DEFAULT_MAXIMUM_DISCOVERED_SESSIONS = 200;
const DEFAULT_MAXIMUM_CATALOG_SESSIONS = 1_000;
const MAX_NATIVE_HISTORY_MESSAGES = 10_000;
const MAX_PROMPT_BYTES = 1024 * 1024;
const MAX_INTERACTION_CACHE = 256;
const MAX_PENDING_INTERACTIONS = 256;
const MAX_TURN_FRAMES = 100_000;
const MAX_TURN_IDENTITIES = 8_192;
const MAX_TURN_BLOCKS = 2_048;
const MAX_TURN_PROJECTED_CHARACTERS = 4 * 1024 * 1024;
const MAX_SESSION_TOOL_NAMES = 4_096;
const MAX_DESCRIPTOR_ITEMS = 4_096;
const MAX_PERMISSION_RULES = 256;
const MAX_PERMISSION_RULE_CONTENT = 4_096;
const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
const DEFAULT_SETTING_SOURCES = ["user", "project", "local"] as const;
const ISOLATED_REVIEW_CLI_VERSION = [2, 1, 239] as const;
const NATIVE_TASK_CLI_VERSION = [2, 1, 239] as const;
const REVIEW_READ_TOOLS = ["Read", "Glob", "Grep"] as const;
const REVIEW_DISALLOWED_TOOLS = [
  "Bash",
  "Write",
  "Edit",
  "NotebookEdit",
  "Task",
  "Agent",
  "Skill",
  "AskUserQuestion",
  "ExitPlanMode",
  "CronCreate",
  "ScheduleWakeup",
  "WebFetch",
  "WebSearch",
  "mcp__*"
] as const;
const REVIEW_CREDENTIAL_GLOB_PATTERNS = [
  "**/.env",
  "**/.env.*",
  "**/.ssh/**",
  "**/.aws/**",
  "**/.gnupg/**",
  "**/.kube/**",
  "**/.docker/**",
  "**/.azure/**",
  "**/.claude/**",
  "**/.codex/**",
  "**/.netrc",
  "**/.npmrc",
  "**/.pgpass",
  "**/.pypirc",
  "**/.git-credentials",
  "**/.cargo/credentials*",
  "**/.m2/settings*.xml",
  "**/credentials.json",
  "**/auth.json",
  "**/environ",
  "**/*.pem",
  "**/*.p12",
  "**/*.pfx",
  "**/*.key",
  "**/id_rsa",
  "**/id_ed25519",
  "**/id_ecdsa",
  "**/id_dsa",
  "**/.git/**",
  "**/node_modules/**"
] as const;
const REVIEW_SENSITIVE_PATH_SEGMENTS = new Set([
  ".agents",
  ".aws",
  ".azure",
  ".claude",
  ".codex",
  ".config",
  ".docker",
  ".git",
  ".gnupg",
  ".kube",
  ".ssh",
  ".xdt-server",
  "node_modules"
]);
const CLAUDE_RUNTIME_ENVIRONMENT_KEYS = Object.freeze([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_BETAS",
  "ANTHROPIC_CONFIG_DIR",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_DEFAULT_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_LOG",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_PROFILE",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_API_BASE_URL",
  "CLAUDE_CODE_CLIENT_CERT",
  "CLAUDE_CODE_CLIENT_KEY",
  "CLAUDE_CODE_CLIENT_KEY_PASSPHRASE",
  "CLAUDE_CODE_GIT_BASH_PATH",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL",
  "CLAUDE_CODE_MANAGED_SETTINGS_PATH",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_OAUTH_SCOPES",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
  "CLAUDE_CODE_RATE_LIMIT_TIER",
  "CLAUDE_CODE_REMOTE_SETTINGS_PATH",
  "CLAUDE_CODE_SESSION_ACCESS_TOKEN",
  "CLAUDE_CODE_SHELL",
  "CLAUDE_CODE_SUBSCRIPTION_TYPE",
  "CLAUDE_CODE_TMPDIR",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_VERTEX",
  "ANTHROPIC_AWS_API_KEY",
  "ANTHROPIC_AWS_BASE_URL",
  "ANTHROPIC_AWS_WORKSPACE_ID",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
  "ANTHROPIC_BEDROCK_REGION_PREFIX",
  "ANTHROPIC_BEDROCK_SERVICE_TIER",
  "ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_CONFIG_FILE",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_DEFAULT_REGION",
  "AWS_EC2_METADATA_SERVICE_ENDPOINT",
  "AWS_EC2_METADATA_SERVICE_ENDPOINT_MODE",
  "AWS_ENDPOINT_URL",
  "AWS_ENDPOINT_URL_BEDROCK",
  "AWS_ENDPOINT_URL_BEDROCK_RUNTIME",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_ROLE_ARN",
  "AWS_ROLE_SESSION_NAME",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "ANTHROPIC_GOOGLE_CLOUD_BASE_URL",
  "ANTHROPIC_GOOGLE_CLOUD_LOCATION",
  "ANTHROPIC_GOOGLE_CLOUD_PROJECT",
  "ANTHROPIC_GOOGLE_CLOUD_WORKSPACE_ID",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "CLOUD_ML_REGION",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_QUOTA_PROJECT",
  "GOOGLE_EXTERNAL_ACCOUNT_ALLOW_EXECUTABLES",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "AZURE_AUTHORITY_HOST",
  "AZURE_CLIENT_CERTIFICATE_PASSWORD",
  "AZURE_CLIENT_CERTIFICATE_PATH",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_FEDERATED_TOKEN_FILE",
  "AZURE_TENANT_ID"
] as const);
const CLAUDE_SENSITIVE_ENVIRONMENT_KEYS = Object.freeze([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy"
] as const);

function managedAuthEnvironmentOverrides(): Readonly<Record<string, string | undefined>> {
  return {
    ...Object.fromEntries(CLAUDE_RUNTIME_ENVIRONMENT_KEYS.map((key) => [key, undefined])),
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1"
  };
}

export interface ClaudeCodeAdapterOptions {
  readonly instanceGeneration: number;
  readonly id?: string;
  readonly runtime?: ClaudeSdkRuntime;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** Opaque Orchestrator-owned persistence boundary for the native subscription account. */
  readonly credentialPort?: ClaudeCodeCredentialPort;
  readonly oauthFetch?: typeof fetch;
  readonly oauthLoginTimeoutMs?: number;
  readonly oauthRefreshTimeoutMs?: number;
  readonly pathToClaudeCodeExecutable?: string;
  /** Adapter-private exact local process authority for crash recovery. */
  readonly processOwner?: DurableProcessOwnerOptions;
  /** Workspace whose project/local native settings own Backend discovery. */
  readonly probeCwd?: string;
  readonly settingSources?: readonly ("user" | "project" | "local")[];
  readonly initializationTimeoutMs?: number;
  readonly admissionTimeoutMs?: number;
  readonly teardownTimeoutMs?: number;
  readonly interruptTimeoutMs?: number;
  readonly nativeContinuationGraceMs?: number;
  readonly maximumDiscoveredSessions?: number;
  readonly maximumCatalogSessions?: number;
  readonly redactValues?: readonly string[];
  /** Monotonic-enough wall clock used for task and streamed generation observations. */
  readonly now?: () => number;
  /** Product Host capabilities that do not require Adapter runtime integration. */
  readonly hostCapabilities?: readonly HostComposedCapability[];
}

interface ActiveTurn {
  readonly context: AdapterContext;
  readonly sessionGeneration: number;
  readonly backendInstanceGeneration: number;
  readonly queryGeneration: number;
  readonly operationId: string;
  readonly userMessageUuid: string;
  readonly admission: Deferred<void>;
  readonly eventsReady: Deferred<void>;
  readonly blocks: MessageBlock[];
  readonly seenFrameUuids: Set<string>;
  readonly seenParentMessageIds: Set<string>;
  readonly seenToolStarts: Set<string>;
  readonly seenToolResults: Set<string>;
  readonly stream: PartialMessageBuffer;
  inputConsumed: boolean;
  nativeIdentityConfirmed: boolean;
  terminalClaimed: boolean;
  awaitingNativeContinuation: boolean;
  nativeContinuationSegment: boolean;
  readonly continuationTaskIds: Set<string>;
  continuationTimer?: ReturnType<typeof setTimeout>;
  frameCount: number;
  projectedCharacters: number;
  childOutputObserved: boolean;
  parentAssistantMessages: number;
  parentStreamMessages: number;
  parentGenerationDurationMs: number;
  parentGenerationReliable: boolean;
  parentStreamUsage: UsageSnapshot;
  parentStreamSegment?: ParentStreamSegment;
  assistantError?: string;
}

interface ParentStreamSegment {
  readonly startedAt: number;
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  outputTokens?: number;
}

interface PermissionCacheEntry {
  readonly fingerprint: string;
  readonly result: ClaudePermissionResult;
}

interface PendingPermission {
  readonly fingerprint: string;
  readonly promise: Promise<ClaudePermissionResult>;
}

interface NativeRuntime {
  readonly productSessionId: string;
  readonly target: TargetDescriptor;
  readonly binding: NativeSessionBinding;
  readonly sessionGeneration: number;
  readonly backendInstanceGeneration: number;
  readonly queryGeneration: number;
  readonly nativeSessionId: string;
  readonly gate: AsyncInputGate<ClaudeSdkUserMessage>;
  readonly abortController: AbortController;
  readonly query: ClaudeSdkQuery;
  readonly baseContext: AdapterContext;
  readonly nativeTasks: ClaudeNativeTaskProjection;
  readonly runtimePolicy: "standard" | "review_read_only";
  readonly capabilities: Set<string>;
  readonly pendingPermissions: Map<string, PendingPermission>;
  readonly resolvedPermissions: Map<string, PermissionCacheEntry>;
  readonly toolNames: Map<string, string>;
  consumer: Promise<void>;
  closed: boolean;
  nativeTaskProjectionEnabled: boolean;
  activeTurn?: ActiveTurn;
  initialization?: ClaudeSdkInitializationResult;
  modelId?: string;
  effort?: string;
  permissionMode: PermissionMode;
  planMode: boolean;
  additionalDirectories: readonly ApprovedDirectory[];
  lastUsage?: UsageSnapshot;
  lastTotalCostUsd: number;
}

interface CatalogBindingSource {
  readonly source: ClaudeCatalogSource;
  readonly entry: NativeSessionCatalogEntry;
}

export class ClaudeCodeAdapter extends CapabilityDrivenBackendAdapter {
  override readonly id: string;
  readonly #runtime: ClaudeSdkRuntime;
  readonly #instanceGeneration: number;
  readonly #environment: Readonly<Record<string, string>>;
  readonly #pathToExecutable: string | undefined;
  readonly #probeCwd: string;
  readonly #settingSources: readonly ("user" | "project" | "local")[];
  readonly #initializationTimeoutMs: number;
  readonly #admissionTimeoutMs: number;
  readonly #teardownTimeoutMs: number;
  readonly #interruptTimeoutMs: number;
  readonly #nativeContinuationGraceMs: number;
  readonly #maximumDiscoveredSessions: number;
  readonly #maximumCatalogSessions: number;
  readonly #hostCapabilities: ReadonlySet<HostComposedCapability>;
  readonly #projection: SafeProjection;
  readonly #now: () => number;
  readonly #oauthAccount: ClaudeCodeOAuthAccount | undefined;
  readonly #sessions = new Map<string, NativeRuntime>();
  readonly #models = new Map<string, ClaudeSdkModelInfo>();
  readonly #toolNames = new Set<string>();
  readonly #catalogSources = new WeakMap<NativeSessionCatalogEntry, CatalogBindingSource>();
  #nextQueryGeneration = 1;
  #lastCliVersion: string | undefined;
  #authenticationState: BackendAuthenticationState = "pending";
  #externalAccountDetected = false;
  #ownsCredential = false;
  #disposed = false;

  constructor(options: ClaudeCodeAdapterOptions) {
    super();
    if (!Number.isSafeInteger(options.instanceGeneration) || options.instanceGeneration < 0) {
      throw new TypeError("instanceGeneration must be a non-negative safe integer.");
    }
    const id = options.id?.trim() ?? ADAPTER_ID;
    if (id.length === 0 || id.length > 256) throw new TypeError("id must be a non-empty bounded string.");
    this.id = id;
    this.#instanceGeneration = options.instanceGeneration;
    const childEnvironment = createChildRuntimeEnvironment({
      allowedKeys: CLAUDE_RUNTIME_ENVIRONMENT_KEYS,
      overrides: {
        ...options.environment,
        ...(options.credentialPort === undefined ? {} : managedAuthEnvironmentOverrides()),
        CLAUDE_AGENT_SDK_CLIENT_APP: "joko/0.1.0"
      },
      sensitiveKeys: [
        ...CLAUDE_SENSITIVE_ENVIRONMENT_KEYS,
        ...Object.keys(options.environment ?? {})
      ]
    });
    this.#environment = childEnvironment.environment;
    this.#pathToExecutable = options.pathToClaudeCodeExecutable;
    if (options.probeCwd !== undefined && !isAbsolute(options.probeCwd)) {
      throw new TypeError("probeCwd must be an absolute path.");
    }
    this.#probeCwd = resolve(options.probeCwd ?? process.cwd());
    this.#settingSources = [...(options.settingSources ?? DEFAULT_SETTING_SOURCES)];
    this.#initializationTimeoutMs = positiveTimeout(options.initializationTimeoutMs, DEFAULT_INITIALIZATION_TIMEOUT_MS);
    this.#admissionTimeoutMs = positiveTimeout(options.admissionTimeoutMs, DEFAULT_ADMISSION_TIMEOUT_MS);
    this.#teardownTimeoutMs = positiveTimeout(options.teardownTimeoutMs, DEFAULT_TEARDOWN_TIMEOUT_MS);
    this.#runtime = options.runtime ?? new DefaultClaudeSdkRuntime({
      ...(options.processOwner === undefined ? {} : { processOwner: options.processOwner }),
      retirementTimeoutMs: this.#teardownTimeoutMs
    });
    this.#interruptTimeoutMs = positiveTimeout(options.interruptTimeoutMs, DEFAULT_INTERRUPT_TIMEOUT_MS);
    this.#nativeContinuationGraceMs = positiveTimeout(
      options.nativeContinuationGraceMs,
      DEFAULT_NATIVE_CONTINUATION_GRACE_MS
    );
    this.#maximumDiscoveredSessions = positiveBound(
      options.maximumDiscoveredSessions,
      DEFAULT_MAXIMUM_DISCOVERED_SESSIONS,
      1_000
    );
    this.#maximumCatalogSessions = positiveBound(
      options.maximumCatalogSessions,
      DEFAULT_MAXIMUM_CATALOG_SESSIONS,
      1_000
    );
    this.#hostCapabilities = validatedHostCapabilities(options.hostCapabilities);
    this.#now = options.now ?? Date.now;
    this.#projection = new SafeProjection([
      ...(options.redactValues ?? []),
      ...childEnvironment.sensitiveValues
    ], () => this.#oauthAccount?.redactionValues() ?? []);
    this.#oauthAccount = options.credentialPort === undefined
      ? undefined
      : new ClaudeCodeOAuthAccount({
          credentials: options.credentialPort,
          ...(options.oauthFetch === undefined ? {} : { fetch: options.oauthFetch }),
          ...(options.oauthLoginTimeoutMs === undefined ? {} : { loginTimeoutMs: options.oauthLoginTimeoutMs }),
          ...(options.oauthRefreshTimeoutMs === undefined
            ? {}
            : { refreshTimeoutMs: options.oauthRefreshTimeoutMs })
        });
  }

  override async describe(): Promise<BackendDescriptor> {
    let runtimeAuthorization: Awaited<ReturnType<ClaudeCodeOAuthAccount["runtimeAuthorization"]>> = undefined;
    let managedAccount: ClaudeCodeAccountSnapshot | undefined;
    if (this.#oauthAccount !== undefined) {
      try {
        runtimeAuthorization = await this.#oauthAccount.runtimeAuthorization();
        managedAccount = await this.#oauthAccount.readAccount(false);
      } catch {
        managedAccount = {
          authenticated: false,
          authenticationState: "error",
          ownsCredential: this.#ownsCredential
        };
      }
    }
    let authorizationCurrent = true;
    let probe!: ClaudeSdkProbe;
    try {
      probe = await this.#runtime.probe({
        cwd: this.#probeCwd,
        env: {
          ...this.#environment,
          ...runtimeAuthorization?.environment
        },
        ...(runtimeAuthorization === undefined ? {} : { getOAuthToken: runtimeAuthorization.getOAuthToken }),
        ...(this.#pathToExecutable === undefined ? {} : { pathToClaudeCodeExecutable: this.#pathToExecutable }),
        settingSources: [...this.#settingSources],
        initializationTimeoutMs: this.#initializationTimeoutMs
      });
      authorizationCurrent = runtimeAuthorization?.isCurrent() ?? true;
    } finally {
      runtimeAuthorization?.release();
    }
    if (!authorizationCurrent) {
      this.#models.clear();
      managedAccount = await this.#oauthAccount?.readAccount(false).catch(() => ({
        authenticated: false,
        authenticationState: "error" as const,
        ownsCredential: this.#ownsCredential
      }));
    }
    const installed = probe.installed && probe.packageVersion === CLAUDE_AGENT_SDK_VERSION;
    const packageMismatch = probe.installed && probe.packageVersion !== CLAUDE_AGENT_SDK_VERSION;
    this.#observeProbe(probe, installed);
    const initialized = installed && probe.initialization !== undefined;
    if (managedAccount !== undefined) {
      const observedState = probe.initialization === undefined
        ? "error"
        : authenticationStateFor(probe.initialization.account, probe.apiKeySource);
      this.#externalAccountDetected = runtimeAuthorization === undefined
        && (observedState === "authenticated" || observedState === "not_required");
      this.#ownsCredential = managedAccount.ownsCredential;
      this.#authenticationState = managedAccount.authenticationState === "pending"
        ? "pending"
        : !managedAccount.ownsCredential && this.#externalAccountDetected
          ? "signed_out"
          : managedAccount.authenticationState;
      if (!authorizationCurrent || !managedAccount.authenticated || runtimeAuthorization === undefined) {
        this.#models.clear();
      }
    } else {
      this.#externalAccountDetected = false;
      this.#ownsCredential = false;
    }
    const expectedManagedAuthProbeBlock = managedAccount !== undefined
      && (managedAccount.authenticationState === "pending"
        || (!managedAccount.ownsCredential && managedAccount.authenticationState === "signed_out"));
    const descriptorError: PublicError | undefined = !installed ? {
      code: packageMismatch ? "CLAUDE_AGENT_SDK_VERSION_MISMATCH" : "CLAUDE_AGENT_SDK_UNAVAILABLE",
      message: packageMismatch
        ? `Claude Agent SDK ${CLAUDE_AGENT_SDK_VERSION} is required.`
        : "The Claude Agent SDK is unavailable.",
      phase: "backend_probe",
      retryable: false,
      stateMayHaveChanged: false,
      recovery: packageMismatch
        ? `Install exact package version ${CLAUDE_AGENT_SDK_VERSION}.`
        : "Install the declared Backend package dependency."
    } : !initialized && !expectedManagedAuthProbeBlock ? {
      code: "CLAUDE_CODE_STARTUP_PROBE_FAILED",
      message: "The native CLI could not complete startup discovery.",
      phase: "backend_probe",
      retryable: true,
      stateMayHaveChanged: false,
      recovery: "Repair native CLI settings or authentication, then retry discovery."
    } : undefined;
    const diagnostics = [
      `Claude Agent SDK ${CLAUDE_AGENT_SDK_VERSION}.`,
      this.#lastCliVersion === undefined
        ? "Native CLI version was not returned by the bounded startup probe."
        : `Native CLI ${this.#projection.text(this.#lastCliVersion, 128)}.`
    ];
    if (probe.diagnostic !== undefined) diagnostics.push(this.#projection.text(probe.diagnostic, 512));
    if (this.#externalAccountDetected && !this.#ownsCredential) {
      diagnostics.push("A native CLI account was detected outside Joko's credential boundary.");
    }
    const authenticationState = installed ? this.#authenticationState : "error";
    const catalogModels = [...this.#models.values()];
    const supportsLogin = installed && this.#oauthAccount !== undefined;
    const supportsLogout = installed && this.#oauthAccount !== undefined && this.#ownsCredential;
    const descriptor: BackendDescriptor = {
      id: this.id,
      adapterKind: "claude-agent-sdk-stdio",
      instanceGeneration: this.#instanceGeneration,
      displayName: "Claude Code",
      version: this.#lastCliVersion === undefined
        ? `sdk-${CLAUDE_AGENT_SDK_VERSION}`
        : `sdk-${CLAUDE_AGENT_SDK_VERSION}+cli-${this.#projection.text(this.#lastCliVersion, 128)}`,
      health: installed ? (initialized || expectedManagedAuthProbeBlock ? "healthy" : "degraded") : "unavailable",
      installationState: installed ? "installed" : packageMismatch ? "error" : "not_installed",
      authenticationState,
      error: descriptorError,
      capabilities: capabilityManifest(
        installed,
        supportsIsolatedReview(this.#lastCliVersion),
        supportsNativeTaskProjection(this.#lastCliVersion),
        catalogModels,
        this.#hostCapabilities,
        supportsLogin,
        supportsLogout
      ),
      providers: [{
        providerId: PROVIDER_ID,
        displayName: "Anthropic",
        api: "anthropic-messages",
        accessKind: "subscription",
        accessProduct: "Claude",
        providesModelPricing: false,
        authenticationState,
        loginMethods: supportsLogin ? ["oauth_browser"] : [],
        supportsLogin,
        supportsLogout,
        supportsRefresh: installed,
        supportsModelRefresh: installed
      }],
      models: catalogModels.map((model) => providerModel(model, this.#projection)),
      tools: [...this.#toolNames].sort().map((name) => ({
        toolId: name,
        name,
        displayName: name,
        description: "A tool reported by the initialized native runtime.",
        inputSchema: { fields: [], allowsAdditionalFields: true },
        requiresPermission: true,
        streamingUpdates: true,
        enabled: true
      })),
      diagnostics
    };
    return descriptor;
  }

  async readAccount(refreshToken = false): Promise<ClaudeCodeAccountSnapshot> {
    if (this.#oauthAccount === undefined) {
      const authenticated = this.#authenticationState === "authenticated"
        || this.#authenticationState === "not_required";
      return {
        authenticated,
        authenticationState: this.#authenticationState,
        ownsCredential: false
      };
    }
    const account = await this.#oauthAccount.readAccount(refreshToken);
    this.#ownsCredential = account.ownsCredential;
    this.#authenticationState = account.authenticationState === "pending"
      ? "pending"
      : !account.ownsCredential && this.#externalAccountDetected
        ? "signed_out"
        : account.authenticationState;
    if (!account.authenticated) this.#models.clear();
    return {
      ...account,
      authenticated: account.authenticated && this.#authenticationState === "authenticated",
      authenticationState: this.#authenticationState
    };
  }

  async beginLogin(input: { readonly method: string }): Promise<{
    readonly method: "oauth_browser";
    readonly loginId: string;
    readonly url: string;
  }> {
    if (input.method !== "oauth_browser" || this.#oauthAccount === undefined) {
      throw claudeCodeError(
        "CLAUDE_CODE_LOGIN_METHOD_UNSUPPORTED",
        "The selected login method is not supported by this Backend.",
        "authentication",
        { recovery: "Use the advertised browser sign-in method." }
      );
    }
    const result = await this.#oauthAccount.beginLogin(() => this.#retireAuthorizedRuntimes());
    this.#authenticationState = "pending";
    this.#models.clear();
    return result;
  }

  async cancelLogin(loginId: string): Promise<void> {
    if (this.#oauthAccount === undefined) {
      throw claudeCodeError(
        "CLAUDE_CODE_LOGIN_UNSUPPORTED",
        "This Backend has no managed subscription account channel.",
        "authentication"
      );
    }
    await this.#oauthAccount.cancelLogin(loginId);
    const account = await this.#oauthAccount.readAccount(false);
    this.#ownsCredential = account.ownsCredential;
    this.#authenticationState = account.authenticationState;
  }

  async readLoginOutcome(loginId: string): Promise<{
    readonly outcome: "pending" | "completed" | "cancelled" | "error";
    readonly failureReason?: "not_a_subscription";
  }> {
    if (this.#oauthAccount === undefined) return { outcome: "error" };
    return this.#oauthAccount.readLoginOutcome(loginId);
  }

  async logout(): Promise<void> {
    if (this.#oauthAccount === undefined) {
      throw claudeCodeError(
        "CLAUDE_CODE_LOGOUT_UNSUPPORTED",
        "This Backend has no Joko-owned subscription credential to remove.",
        "authentication"
      );
    }
    await this.#oauthAccount.logout({
      beforeDelete: () => this.#retireAuthorizedRuntimes(),
      onDeleted: () => {
        this.#ownsCredential = false;
        this.#authenticationState = "signed_out";
        this.#models.clear();
      }
    });
  }

  async listModels(): Promise<readonly ProviderModel[]> {
    return (await this.describe()).models;
  }

  override async validateTarget(target: TargetDescriptor): Promise<void> {
    if (target.backendId !== this.id) {
      throw claudeCodeError("TARGET_BACKEND_MISMATCH", "The Target belongs to a different Backend.", "target", {
        recovery: "Select a Target owned by the Claude Code Backend."
      });
    }
    if (target.remoteWorkspace !== undefined) {
      throw claudeCodeError("TARGET_LOCATION_UNSUPPORTED", "Claude Code currently requires a local workspace.", "target", {
        recovery: "Choose a local Target for this Backend."
      });
    }
    await validateCanonicalDirectory(target.workspaceRoot, "Target workspace");
  }

  async resolveNativeSessionReference(
    nativeReference: string,
    target: TargetDescriptor,
    generation: number
  ): Promise<NativeSessionBinding> {
    await this.validateTarget(target);
    const nativeSessionId = parseNativeSessionReference(nativeReference);
    const info = await this.#sessionInfo(nativeSessionId, target);
    if (info === undefined) throw continuityGap();
    assertSessionInfo(info, nativeSessionId, target.workspaceRoot);
    return bindingFor(nativeSessionId, generation);
  }

  async listNativeSessions(target: TargetDescriptor): Promise<readonly NativeSessionCandidate[]> {
    this.#assertUsable();
    await this.validateTarget(target);
    let sessions: readonly ClaudeSdkSessionInfo[];
    try {
      sessions = await this.#runtime.listSessions({
        dir: target.workspaceRoot,
        limit: this.#maximumDiscoveredSessions,
        offset: 0,
        includeWorktrees: false,
        includeProgrammatic: true
      });
    } catch {
      throw claudeCodeError(
        "NATIVE_SESSION_DISCOVERY_FAILED",
        "Native Sessions could not be discovered.",
        "session_discovery",
        {
          retryable: true,
          stateMayHaveChanged: false,
          recovery: "Verify native Session storage and retry discovery."
        }
      );
    }
    if (!Array.isArray(sessions) || sessions.length > this.#maximumDiscoveredSessions) {
      throw claudeCodeError(
        "NATIVE_SESSION_DISCOVERY_INVALID",
        "Native Session discovery returned an invalid or unbounded result.",
        "session_discovery",
        { recovery: "Keep native attachment disabled until discovery can be refreshed safely." }
      );
    }
    const candidates: NativeSessionCandidate[] = [];
    const seen = new Set<string>();
    for (const session of sessions) {
      const candidate = nativeSessionCandidate(session, target, this.#projection);
      if (candidate === undefined || seen.has(candidate.nativeReference)) continue;
      seen.add(candidate.nativeReference);
      candidates.push(candidate);
    }
    candidates.sort((left, right) => right.modifiedAt - left.modifiedAt
      || left.nativeReference.localeCompare(right.nativeReference));
    return candidates;
  }

  async scanNativeSessionCatalog(): Promise<NativeSessionCatalogResult> {
    this.#assertUsable();
    const scan = await scanClaudeSessionCatalog({
      configDirectory: this.#environment["CLAUDE_CONFIG_DIR"],
      maximumEntries: this.#maximumCatalogSessions
    });
    const entries = scan.summaries.map((summary): NativeSessionCatalogEntry => {
      const title = summary.title === undefined
        ? undefined
        : this.#projection.text(summary.title, 512).trim();
      const nativeReference = `${OPAQUE_REFERENCE_PREFIX}${summary.nativeSessionId}`;
      const entry: NativeSessionCatalogEntry = {
        nativeReference,
        nativeSessionId: summary.nativeSessionId,
        ...(title === undefined || title.length === 0 ? {} : { title }),
        ...(summary.workingDirectory === undefined ? {} : { workingDirectory: summary.workingDirectory }),
        ...(summary.projectDirectory === undefined ? {} : { projectDirectory: summary.projectDirectory }),
        createdAt: summary.createdAt,
        modifiedAt: summary.modifiedAt,
        archived: false,
        placement: "project",
        existingMatch: "binding"
      };
      this.#catalogSources.set(entry, { source: summary.source, entry: { ...entry } });
      return entry;
    });
    return {
      entries,
      rejectedCount: scan.rejectedCount
    };
  }

  async bindCatalogSession(
    entry: NativeSessionCatalogEntry,
    generation: number
  ): Promise<NativeSessionBinding> {
    this.#assertUsable();
    const bindingSource = this.#catalogSources.get(entry);
    if (bindingSource === undefined
      || !catalogEntryMatches(entry, bindingSource.entry)) {
      throw catalogSourceChanged();
    }
    const nativeSessionId = parseCatalogNativeReference(entry.nativeReference);
    if (nativeSessionId !== bindingSource.entry.nativeSessionId) throw catalogSourceChanged();
    if (!(await claudeCatalogSourceIsCurrent(bindingSource.source))) throw catalogSourceChanged();
    return bindingFor(nativeSessionId, generation);
  }

  override async createSession(
    input: CreateNativeSessionInput,
    context: AdapterContext
  ): Promise<NativeSessionBinding> {
    this.#assertUsable();
    this.#assertBackendInstance(context);
    const runtimePolicy = reviewRuntimePolicy(input, context);
    await this.validateTarget(input.target);
    await this.validateTarget(context.target);
    assertSameTarget(input.target, context.target);
    if (context.generation < 0 || !Number.isSafeInteger(context.generation)) {
      throw claudeCodeError("SESSION_GENERATION_INVALID", "The Session generation is invalid.", "session");
    }
    if (this.#sessions.has(context.sessionId)) {
      throw claudeCodeError("SESSION_ALREADY_ATTACHED", "This product Session already has a native runtime.", "session");
    }
    const extraDirectories = await this.#validateExtraDirectories(context.extraDirectories ?? []);
    if (input.nativeStart?.kind === "attach") {
      const binding = await this.resolveNativeSessionReference(
        input.nativeStart.nativeReference,
        input.target,
        context.generation
      );
      // An attached task already owns its model and reasoning history. New-task
      // defaults are not proof of a user-requested runtime mutation and must
      // not overwrite that native state. The SDK requires a permission mode,
      // so resume with the least-privileged interactive mode; axes that cannot
      // yet be observed remain absent from NativeSessionState.
      await this.#startRuntime(binding, context, {
        resume: true,
        permissionMode: "ask",
        additionalDirectories: extraDirectories,
        runtimePolicy
      });
      return binding;
    }
    assertFullAccessTarget(input.permissionMode, context.target, "session_start");
    if (input.fastMode) {
      throw claudeCodeError("BACKEND_CAPABILITY_UNAVAILABLE", "Fast mode is not controllable through this Adapter.", "capability", {
        recovery: "Create the Session without fast mode."
      });
    }
    if (input.providerId !== undefined && input.providerId !== PROVIDER_ID) {
      throw claudeCodeError("PROVIDER_UNAVAILABLE", "The requested provider is not owned by this Backend.", "model", {
        recovery: "Use the Claude Code provider catalog."
      });
    }
    const effort = normalizeEffort(input.effort);
    if (input.effort !== undefined && effort === undefined) {
      throw claudeCodeError("EFFORT_UNAVAILABLE", "The requested effort level is unsupported.", "model", {
        recovery: `Choose one of: ${EFFORT_LEVELS.join(", ")}.`
      });
    }
    if (input.nativeStart?.kind === "new" && input.nativeStart.parentNativeReference !== undefined) {
      throw claudeCodeError("BACKEND_CAPABILITY_UNAVAILABLE", "This Adapter does not provide native parent-session creation.", "capability", {
        recovery: "Create a fresh Session or attach an existing native Session."
      });
    }
    const binding = bindingFor(randomUUID(), context.generation);
    await this.#startRuntime(binding, context, {
      resume: false,
      modelId: input.modelId,
      effort,
      permissionMode: input.permissionMode,
      title: input.name,
      appendSystemPrompt: input.appendSystemPrompt ?? context.appendSystemPrompt,
      additionalDirectories: extraDirectories,
      runtimePolicy
    });
    return binding;
  }

  override async resumeSession(binding: NativeSessionBinding, context: AdapterContext): Promise<NativeSessionState> {
    this.#assertUsable();
    const runtimePolicy = reviewResumeRuntimePolicy(context);
    await this.validateTarget(context.target);
    const resumedBinding = this.#resumeBindingForContext(binding, context);
    const existing = this.#sessions.get(context.sessionId);
    if (existing !== undefined) {
      this.#assertCurrent(existing, context, resumedBinding);
      return nativeState(existing);
    }
    const runtime = await this.#startRuntime(resumedBinding, context, {
      resume: true,
      permissionMode: "ask",
      additionalDirectories: await this.#validateExtraDirectories(context.extraDirectories ?? []),
      appendSystemPrompt: context.appendSystemPrompt,
      runtimePolicy
    });
    return nativeState(runtime);
  }

  override async inspectSession(binding: NativeSessionBinding, context: AdapterContext): Promise<NativeSessionState> {
    await this.validateTarget(context.target);
    this.#assertBindingContext(binding, context);
    const existing = this.#sessions.get(context.sessionId);
    if (existing !== undefined) {
      this.#assertCurrent(existing, context, binding);
      return nativeState(existing);
    }
    assertStandardReviewContext(context, "inspect a detached native Session");
    const nativeSessionId = parseBinding(binding);
    const info = await this.#sessionInfo(nativeSessionId, context.target);
    if (info === undefined) throw continuityGap();
    assertSessionInfo(info, nativeSessionId, context.target.workspaceRoot);
    return {
      binding,
      ...(info.customTitle === undefined ? {} : { name: this.#projection.text(info.customTitle, 512) }),
      streaming: false,
      compacting: false,
      pendingMessages: 0,
      providerId: PROVIDER_ID,
      fastMode: false,
      permissionMode: "ask"
    };
  }

  async getNativeHistoryProjection(context: AdapterContext): Promise<NativeHistoryProjection> {
    this.#assertUsable();
    assertStandardReviewContext(context, "read persisted native history");
    const runtime = this.#requireRuntime(context);
    const binding = context.binding;
    if (binding === undefined) throw continuityGap();
    this.#assertBindingContext(binding, context);
    const nativeSessionId = parseBinding(binding);
    if (nativeSessionId !== runtime.nativeSessionId) throw continuityGap();

    const info = await this.#sessionInfo(nativeSessionId, context.target);
    this.#assertCurrent(runtime, context, binding);
    if (info === undefined) throw continuityGap();
    assertSessionInfo(info, nativeSessionId, context.target.workspaceRoot);

    let messages: readonly ClaudeSdkSessionMessage[];
    try {
      messages = await this.#runtime.getSessionMessages(nativeSessionId, {
        dir: context.target.workspaceRoot,
        limit: MAX_NATIVE_HISTORY_MESSAGES + 1,
        offset: 0,
        includeSystemMessages: true
      });
    } catch {
      throw claudeCodeError(
        "NATIVE_HISTORY_READ_FAILED",
        "The native Session history could not be read.",
        "session_history",
        {
          retryable: true,
          stateMayHaveChanged: false,
          recovery: "Verify native Session storage and retry history synchronization."
        }
      );
    }
    this.#assertCurrent(runtime, context, binding);
    const confirmedInfo = await this.#sessionInfo(nativeSessionId, context.target);
    this.#assertCurrent(runtime, context, binding);
    if (confirmedInfo === undefined) throw continuityGap();
    assertSessionInfo(confirmedInfo, nativeSessionId, context.target.workspaceRoot);
    if (!Array.isArray(messages)) throw invalidNativeHistory();
    if (messages.length > MAX_NATIVE_HISTORY_MESSAGES) {
      throw claudeCodeError(
        "NATIVE_HISTORY_LIMIT_EXCEEDED",
        "The native Session history exceeds the bounded projection limit.",
        "session_history",
        {
          stateMayHaveChanged: false,
          recovery: "Start a new native Session before importing additional history."
        }
      );
    }
    try {
      return projectNativeHistory(messages, nativeSessionId, this.#projection);
    } catch (error) {
      if (error instanceof JokoError) throw error;
      if (error instanceof ProjectionLimitError) {
        throw claudeCodeError(
          "NATIVE_HISTORY_LIMIT_EXCEEDED",
          "The native Session history contains an entry that exceeds projection limits.",
          "session_history",
          {
            stateMayHaveChanged: false,
            recovery: "Start a new native Session before importing additional history."
          }
        );
      }
      throw invalidNativeHistory();
    }
  }

  async detachSession(binding: NativeSessionBinding, context: AdapterContext): Promise<void> {
    await this.validateTarget(context.target);
    this.#assertBindingContext(binding, context);
    const runtime = this.#sessions.get(context.sessionId);
    if (runtime === undefined) return;
    this.#assertCurrent(runtime, context, binding);
    await this.#retireRuntime(runtime);
  }

  override async closeSession(binding: NativeSessionBinding, context: AdapterContext): Promise<void> {
    await this.detachSession(binding, context);
  }

  override async deleteSession(binding: NativeSessionBinding, context: AdapterContext): Promise<void> {
    assertStandardReviewContext(context, "delete native Session state");
    await this.validateTarget(context.target);
    this.#assertBindingContext(binding, context);
    const nativeSessionId = parseBinding(binding);
    const runtime = this.#sessions.get(context.sessionId);
    if (runtime !== undefined) {
      this.#assertCurrent(runtime, context, binding);
      await this.#retireRuntime(runtime);
    }
    try {
      await this.#runtime.deleteSession(nativeSessionId, { dir: context.target.workspaceRoot });
    } catch {
      throw claudeCodeError("NATIVE_SESSION_DELETE_UNKNOWN", "The native Session delete outcome is unknown.", "session_delete", {
        retryable: true,
        stateMayHaveChanged: true,
        recovery: "Inspect native Session availability before retrying the delete."
      });
    }
  }

  supportsDetachedSessionDeletion(context: AdapterContext): boolean {
    return context.runtimePolicy !== "review_read_only"
      && context.target.backendId === this.id
      && context.backendInstanceGeneration === this.#instanceGeneration;
  }

  override async send(input: PromptInput, context: AdapterContext): Promise<void> {
    const runtime = this.#requireRuntime(context);
    if (runtime.activeTurn !== undefined) {
      throw claudeCodeError("SESSION_BUSY", "The native Session already has an active turn.", "dispatch", {
        retryable: true,
        recovery: "Wait for the current Result before sending another prompt."
      });
    }
    validatePrompt(input);
    const operationId = context.operationId;
    if (operationId === undefined || operationId.length === 0) {
      throw claudeCodeError("OPERATION_ID_REQUIRED", "A durable operation identity is required before native dispatch.", "dispatch", {
        recovery: "Persist the queue item and retry with its operation identity."
      });
    }
    const turn: ActiveTurn = {
      context,
      sessionGeneration: context.generation,
      backendInstanceGeneration: this.#instanceGeneration,
      queryGeneration: runtime.queryGeneration,
      operationId,
      userMessageUuid: operationUuid(operationId),
      admission: deferred<void>(),
      eventsReady: deferred<void>(),
      blocks: [],
      seenFrameUuids: new Set(),
      seenParentMessageIds: new Set(),
      seenToolStarts: new Set(),
      seenToolResults: new Set(),
      stream: new PartialMessageBuffer(),
      inputConsumed: false,
      nativeIdentityConfirmed: false,
      terminalClaimed: false,
      awaitingNativeContinuation: false,
      nativeContinuationSegment: false,
      continuationTaskIds: new Set(),
      frameCount: 0,
      projectedCharacters: 0,
      childOutputObserved: false,
      parentAssistantMessages: 0,
      parentStreamMessages: 0,
      parentGenerationDurationMs: 0,
      parentGenerationReliable: true,
      parentStreamUsage: emptyUsage()
    };
    runtime.activeTurn = turn;
    const nativeInput: ClaudeSdkUserMessage = {
      type: "user",
      message: { role: "user", content: input.text },
      parent_tool_use_id: null,
      origin: { kind: "human" },
      uuid: turn.userMessageUuid
    };
    try {
      await waitFor(
        runtime.gate.offer(nativeInput, () => {
          turn.inputConsumed = true;
        }),
        this.#admissionTimeoutMs,
        context.signal,
        () => dispatchError("The native input stream did not consume the prompt in time.", false)
      );
      await waitFor(
        turn.admission.promise,
        this.#admissionTimeoutMs,
        context.signal,
        () => dispatchError("Native dispatch admission could not be confirmed.", true)
      );
      setImmediate(() => turn.eventsReady.resolve(undefined));
    } catch (error) {
      turn.eventsReady.resolve(undefined);
      await this.#retireRuntime(runtime);
      if (error instanceof JokoError) throw error;
      throw dispatchError(
        turn.inputConsumed
          ? "Native dispatch admission could not be confirmed."
          : "The native prompt was not dispatched.",
        turn.inputConsumed
      );
    }
  }

  override async abort(context: AdapterContext): Promise<void> {
    const runtime = this.#requireRuntime(context);
    const turn = runtime.activeTurn;
    if (turn === undefined) return;
    let wakeTaskIds: readonly string[] = [];
    let wakeStopResults = Promise.resolve<PromiseSettledResult<void>[]>([]);
    if (runtime.nativeTaskProjectionEnabled) {
      wakeTaskIds = runtime.nativeTasks.activeWakeTaskIds();
      wakeStopResults = Promise.allSettled(
        wakeTaskIds.map((taskId) => waitFor(
          runtime.query.stopTask(taskId),
          this.#interruptTimeoutMs,
          context.signal,
          turnAbortUnknown("A native wake-task stop did not complete within its bounded deadline.")
        ))
      );
    }
    let receipt: { readonly still_queued?: readonly string[] } | undefined;
    try {
      receipt = await waitFor(
        runtime.query.interrupt(),
        this.#interruptTimeoutMs,
        context.signal,
        turnAbortUnknown("The native interrupt did not complete within its bounded deadline.")
      );
    } catch (error) {
      await this.#retireRuntime(runtime);
      if (error instanceof JokoError && error.publicError.code === "TURN_ABORT_UNKNOWN") throw error;
      throw turnAbortUnknown("The native interrupt outcome is unknown.")();
    }
    if (!this.#matchesContext(runtime, context)) {
      await this.#retireRuntime(runtime);
      throw turnAbortUnknown("The native runtime changed before interrupt confirmation.")();
    }
    if (receipt === undefined || !Array.isArray(receipt.still_queued)
      || receipt.still_queued.length > 0) {
      await this.#retireRuntime(runtime);
      throw turnAbortUnknown(
        receipt === undefined
          ? "The native interrupt did not return an authoritative receipt."
          : "The native interrupt left queued work whose cancellation cannot be proven."
      )();
    }
    const stopResults = await wakeStopResults;
    if (stopResults.some((result) => result.status === "rejected")) {
      await this.#retireRuntime(runtime);
      throw turnAbortUnknown("One or more native wake tasks could not be stopped authoritatively.")();
    }
    for (const taskId of wakeTaskIds) {
      await this.#publishNativeTaskEmissions(runtime, runtime.nativeTasks.confirmStopped(taskId));
    }
    if (turn.awaitingNativeContinuation) {
      await this.#settleNativeContinuation(runtime, turn, "aborted");
    }
  }

  async cancelBackgroundTask(context: AdapterContext, taskId: string): Promise<void> {
    const normalizedTaskId = boundedNativeTaskControlId(taskId, "Background task ID");
    const runtime = this.#requireRuntime(context);
    this.#assertStandardRuntime(runtime, "stop a background task");
    if (!runtime.nativeTaskProjectionEnabled) throw nativeTaskControlUnavailable();
    let target: { readonly rawTaskId: string; readonly terminal: boolean };
    try {
      target = runtime.nativeTasks.stopTarget(normalizedTaskId, false);
    } catch {
      throw claudeCodeError(
        "CLAUDE_CODE_BACKGROUND_TASK_OWNERSHIP_UNCONFIRMED",
        "The background task does not belong to this native Session.",
        "background_task",
        { recovery: "Reload the current Session's background tasks before retrying." }
      );
    }
    if (target.terminal) return;
    await this.#runControl(runtime, context, "background_task", () => runtime.query.stopTask(target.rawTaskId));
    await this.#publishNativeTaskEmissions(runtime, runtime.nativeTasks.confirmStopped(target.rawTaskId));
    if (runtime.activeTurn !== undefined) {
      await this.#reconcileNativeContinuation(runtime, runtime.activeTurn);
    }
  }

  async controlSubagent(input: SubagentControlInput, context: AdapterContext): Promise<void> {
    if (input.action !== "stop") {
      throw claudeCodeError(
        "CLAUDE_CODE_SUBAGENT_CONTROL_UNSUPPORTED",
        "The native delegated task supports stop control only.",
        "subagent_control",
        { recovery: "Use the controls advertised for this delegated run." }
      );
    }
    const runId = boundedNativeTaskControlId(input.runId, "Subagent run ID");
    const runtime = this.#requireRuntime(context);
    this.#assertStandardRuntime(runtime, "stop a delegated task");
    if (!runtime.nativeTaskProjectionEnabled) throw nativeTaskControlUnavailable();
    let target: { readonly rawTaskId: string; readonly terminal: boolean };
    try {
      target = runtime.nativeTasks.stopTarget(runId, true);
    } catch {
      throw claudeCodeError(
        "CLAUDE_CODE_SUBAGENT_OWNERSHIP_UNCONFIRMED",
        "The delegated run does not belong to this native Session.",
        "subagent_control",
        { recovery: "Reload the current Session's delegated runs before retrying." }
      );
    }
    const expectedChildId = runtime.nativeTasks.childId(runId);
    if (input.childId !== undefined && input.childId !== expectedChildId) {
      throw claudeCodeError(
        "CLAUDE_CODE_SUBAGENT_CHILD_MISMATCH",
        "The delegated child identity does not match this native task.",
        "subagent_control",
        { recovery: "Reload the delegated run detail before retrying." }
      );
    }
    if (target.terminal) return;
    await this.#runControl(runtime, context, "subagent_control", () => runtime.query.stopTask(target.rawTaskId));
    await this.#publishNativeTaskEmissions(runtime, runtime.nativeTasks.confirmStopped(target.rawTaskId));
    if (runtime.activeTurn !== undefined) {
      await this.#reconcileNativeContinuation(runtime, runtime.activeTurn);
    }
  }

  override async setModel(
    providerId: string,
    modelId: string,
    context: AdapterContext
  ): Promise<ProviderModel> {
    if (providerId !== PROVIDER_ID) {
      throw claudeCodeError("PROVIDER_UNAVAILABLE", "The requested provider is not owned by this Backend.", "model", {
        recovery: "Choose a model from the Claude Code catalog."
      });
    }
    const runtime = this.#requireIdleRuntime(context);
    this.#assertStandardRuntime(runtime, "change the model");
    const model = findModel(runtime.initialization?.models ?? [], modelId);
    if (model === undefined) {
      throw claudeCodeError("MODEL_UNAVAILABLE", "The requested model is not in the native catalog.", "model", {
        recovery: "Refresh the Backend descriptor and select an available model."
      });
    }
    await this.#runControl(runtime, context, "model", () => runtime.query.setModel(model.value));
    runtime.modelId = model.value;
    return providerModel(model, this.#projection);
  }

  override async setEffort(level: string, context: AdapterContext): Promise<void> {
    const effort = normalizeEffort(level);
    if (effort === undefined) {
      throw claudeCodeError("EFFORT_UNAVAILABLE", "The requested effort level is unsupported.", "model", {
        recovery: `Choose one of: ${EFFORT_LEVELS.join(", ")}.`
      });
    }
    const runtime = this.#requireIdleRuntime(context);
    this.#assertStandardRuntime(runtime, "change reasoning effort");
    assertEffortSupported(runtime, effort);
    await this.#runControl(runtime, context, "effort", () => runtime.query.applyFlagSettings({ effortLevel: effort }));
    runtime.effort = effort;
  }

  override async setPermissionMode(mode: PermissionMode, context: AdapterContext): Promise<void> {
    assertFullAccessTarget(mode, context.target, "permission");
    const runtime = this.#requireIdleRuntime(context);
    this.#assertStandardRuntime(runtime, "change permission mode");
    if (!runtime.planMode) {
      await this.#runControl(runtime, context, "permission", () => runtime.query.setPermissionMode(toSdkPermissionMode(mode)));
    }
    runtime.permissionMode = mode;
  }

  override async setPlanMode(enabled: boolean, context: AdapterContext): Promise<void> {
    const runtime = this.#requireIdleRuntime(context);
    this.#assertStandardRuntime(runtime, "change Plan mode");
    const nativeMode: ClaudeSdkPermissionMode = enabled ? "plan" : toSdkPermissionMode(runtime.permissionMode);
    await this.#runControl(runtime, context, "plan_mode", () => runtime.query.setPermissionMode(nativeMode));
    runtime.planMode = enabled;
  }

  async setExtraDirectories(
    directories: readonly ApprovedDirectory[],
    context: AdapterContext
  ): Promise<void> {
    const runtime = this.#requireIdleRuntime(context);
    this.#assertStandardRuntime(runtime, "change additional directories");
    const validated = await this.#validateExtraDirectories(directories);
    const paths = validated.map((directory) => directory.path);
    await this.#runControl(runtime, context, "extra_directories", () => runtime.query.applyFlagSettings({
      permissions: { additionalDirectories: paths }
    }));
    runtime.additionalDirectories = validated;
  }

  override async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    let authorizationError: unknown;
    try {
      await this.#oauthAccount?.dispose();
    } catch (error) {
      authorizationError = error;
    }
    const runtimes = [...this.#sessions.values()];
    await Promise.all(runtimes.map(async (runtime) => this.#retireRuntime(runtime)));
    await this.#runtime.retireOwnedProcesses?.(this.#teardownTimeoutMs);
    if (authorizationError !== undefined) throw authorizationError;
  }

  async quiesceForReplacement(): Promise<void> {
    await this.#oauthAccount?.quiesceForReplacement();
  }

  async forceDispose(): Promise<void> {
    this.#disposed = true;
    let authorizationError: unknown;
    try {
      await this.#oauthAccount?.dispose();
    } catch (error) {
      authorizationError = error;
    }
    const runtimes = [...this.#sessions.values()];
    await Promise.all(runtimes.map(async (runtime) => this.#retireRuntime(runtime, false)));
    await this.#runtime.retireOwnedProcesses?.(this.#teardownTimeoutMs);
    if (authorizationError !== undefined) throw authorizationError;
  }

  async #startRuntime(
    binding: NativeSessionBinding,
    context: AdapterContext,
    launch: {
      readonly resume: boolean;
      readonly modelId?: string;
      readonly effort?: typeof EFFORT_LEVELS[number];
      readonly permissionMode: PermissionMode;
      readonly title?: string;
      readonly appendSystemPrompt?: string;
      readonly additionalDirectories: readonly ApprovedDirectory[];
      readonly runtimePolicy: "standard" | "review_read_only";
    }
  ): Promise<NativeRuntime> {
    if (launch.runtimePolicy !== (context.runtimePolicy === "review_read_only" ? "review_read_only" : "standard")) {
      throw invalidReviewProfile();
    }
    if (launch.runtimePolicy === "review_read_only" && (
      launch.resume
      || launch.permissionMode !== "ask"
      || launch.title !== undefined
      || launch.appendSystemPrompt !== undefined
      || launch.additionalDirectories.length !== 0
    )) throw invalidReviewProfile();
    this.#assertBindingContext(binding, context);
    const nativeSessionId = parseBinding(binding);
    if (launch.resume) {
      const info = await this.#sessionInfo(nativeSessionId, context.target);
      if (info === undefined) throw continuityGap();
      assertSessionInfo(info, nativeSessionId, context.target.workspaceRoot);
    }
    const gate = new AsyncInputGate<ClaudeSdkUserMessage>();
    const abortController = new AbortController();
    let runtime: NativeRuntime | undefined;
    const startedQuery = await this.#createQuery(gate, abortController, nativeSessionId, context, launch, (...args) => {
      if (runtime === undefined) {
        return Promise.resolve({ behavior: "deny", message: "The native Session is not ready." });
      }
      return this.#canUseTool(runtime, ...args);
    });
    const query = startedQuery.query;
    try {
      runtime = {
        productSessionId: context.sessionId,
        target: context.target,
        binding,
        sessionGeneration: context.generation,
        backendInstanceGeneration: this.#instanceGeneration,
        queryGeneration: this.#nextQueryGeneration++,
        nativeSessionId,
        gate,
        abortController,
        query,
        baseContext: context,
        nativeTasks: new ClaudeNativeTaskProjection({
          sessionId: context.sessionId,
          projection: this.#projection,
          now: this.#now
        }),
        runtimePolicy: launch.runtimePolicy,
        capabilities: new Set(),
        pendingPermissions: new Map(),
        resolvedPermissions: new Map(),
        toolNames: new Map(),
        consumer: Promise.resolve(),
        closed: false,
        nativeTaskProjectionEnabled: false,
        modelId: launch.modelId,
        effort: launch.effort,
        permissionMode: launch.permissionMode,
        planMode: false,
        additionalDirectories: launch.additionalDirectories,
        lastTotalCostUsd: 0
      };
      this.#sessions.set(context.sessionId, runtime);
    } finally {
      startedQuery.releaseAuthorization();
    }
    runtime.consumer = this.#consume(runtime);
    try {
      const initialization = await waitFor(
        query.initializationResult(),
        this.#initializationTimeoutMs,
        context.signal,
        () => claudeCodeError("NATIVE_INITIALIZATION_TIMEOUT", "Claude Code did not initialize in time.", "session_start", {
          retryable: true,
          stateMayHaveChanged: true,
          recovery: "Inspect native Session availability before retrying."
        })
      );
      this.#assertCurrent(runtime, context, binding);
      runtime.initialization = initialization;
      if (runtime.runtimePolicy === "review_read_only") assertReviewInitialization(initialization);
      this.#observeInitialization(initialization);
      if (launch.modelId !== undefined && findModel(initialization.models, launch.modelId) === undefined) {
        throw claudeCodeError("MODEL_UNAVAILABLE", "The requested model is not in the native catalog.", "model", {
          recovery: "Refresh the native model catalog and select an available model."
        });
      }
      if (launch.effort !== undefined) assertEffortSupported(runtime, launch.effort);
      return runtime;
    } catch (error) {
      await this.#retireRuntime(runtime);
      if (error instanceof JokoError) throw error;
      throw claudeCodeError(
        launch.resume ? "NATIVE_SESSION_CONTINUITY_GAP" : "NATIVE_INITIALIZATION_FAILED",
        launch.resume
          ? "The native Session could not be resumed without a continuity gap."
          : "Claude Code could not initialize the native Session.",
        "session_start",
        {
          retryable: !launch.resume,
          stateMayHaveChanged: true,
          recovery: launch.resume
            ? "Keep the product Session blocked and inspect the native Session before retrying."
            : "Inspect the Claude Code installation and retry."
        }
      );
    }
  }

  async #createQuery(
    gate: AsyncInputGate<ClaudeSdkUserMessage>,
    abortController: AbortController,
    nativeSessionId: string,
    context: AdapterContext,
    launch: {
      readonly resume: boolean;
      readonly modelId?: string;
      readonly effort?: typeof EFFORT_LEVELS[number];
      readonly permissionMode: PermissionMode;
      readonly title?: string;
      readonly appendSystemPrompt?: string;
      readonly additionalDirectories: readonly ApprovedDirectory[];
      readonly runtimePolicy: "standard" | "review_read_only";
    },
    canUseTool: (
      toolName: string,
      input: Readonly<Record<string, unknown>>,
      options: ClaudeCanUseToolOptions
    ) => Promise<ClaudePermissionResult>
  ): Promise<{ readonly query: ClaudeSdkQuery; releaseAuthorization(): void }> {
    let runtimeAuthorization: Awaited<ReturnType<ClaudeCodeOAuthAccount["runtimeAuthorization"]>> = undefined;
    try {
      runtimeAuthorization = await this.#oauthAccount?.runtimeAuthorization();
      if (this.#oauthAccount !== undefined && runtimeAuthorization === undefined) {
        throw new Error("A Joko-owned subscription authorization is required for native startup.");
      }
      if (runtimeAuthorization !== undefined && !runtimeAuthorization.isCurrent()) {
        throw new Error("The subscription authorization changed before native startup.");
      }
      const query = await this.#runtime.query({
        prompt: gate,
        options: {
          abortController,
          additionalDirectories: launch.additionalDirectories.map((directory) => directory.path),
          allowDangerouslySkipPermissions: launch.runtimePolicy === "standard",
          ...(launch.runtimePolicy === "review_read_only" ? { agents: {} } : {}),
          canUseTool,
          cwd: context.target.workspaceRoot,
          env: {
            ...this.#environment,
            ...runtimeAuthorization?.environment
          },
          ...(launch.runtimePolicy === "review_read_only"
            ? {
                extraArgs: {
                  "safe-mode": null,
                  "disable-slash-commands": null,
                  "no-chrome": null
                },
                settings: {
                  allowedMcpServers: [],
                  autoMemoryEnabled: false,
                  disableAgentView: true,
                  disableAllHooks: true,
                  disableArtifact: true,
                  disableBundledSkills: true,
                  disableClaudeAiConnectors: true,
                  disableRemoteControl: true,
                  disableWorkflows: true,
                  fastMode: false,
                  includeGitInstructions: false,
                  permissions: {
                    additionalDirectories: [],
                    defaultMode: "default",
                    deny: REVIEW_CREDENTIAL_GLOB_PATTERNS.map((pattern) => `Read(${pattern})`),
                    disableBypassPermissionsMode: "disable"
                  }
                }
              }
            : {}),
          ...(runtimeAuthorization === undefined ? {} : { getOAuthToken: runtimeAuthorization.getOAuthToken }),
          ...(launch.effort === undefined ? {} : { effort: launch.effort }),
          ...(launch.runtimePolicy === "standard" ? { forwardSubagentText: true } : {}),
          includePartialMessages: true,
          ...(launch.runtimePolicy === "review_read_only"
            ? {
                disallowedTools: [...REVIEW_DISALLOWED_TOOLS],
                mcpServers: {},
                skills: [],
                strictMcpConfig: true as const
              }
            : {}),
          ...(launch.modelId === undefined ? {} : { model: launch.modelId }),
          ...(this.#pathToExecutable === undefined ? {} : { pathToClaudeCodeExecutable: this.#pathToExecutable }),
          permissionMode: toSdkPermissionMode(launch.permissionMode),
          persistSession: launch.runtimePolicy !== "review_read_only",
          ...(launch.resume ? { resume: nativeSessionId } : { sessionId: nativeSessionId }),
          settingSources: launch.runtimePolicy === "review_read_only" ? [] : [...this.#settingSources],
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            ...(launch.appendSystemPrompt === undefined ? {} : { append: launch.appendSystemPrompt })
          },
          ...(launch.title === undefined || launch.resume ? {} : { title: launch.title }),
          tools: launch.runtimePolicy === "review_read_only"
            ? [...REVIEW_READ_TOOLS]
            : { type: "preset", preset: "claude_code" }
        }
      });
      if (runtimeAuthorization !== undefined && !runtimeAuthorization.isCurrent()) {
        abortController.abort();
        query.close();
        throw new Error("The subscription authorization changed during native startup.");
      }
      return {
        query,
        releaseAuthorization: () => runtimeAuthorization?.release()
      };
    } catch {
      runtimeAuthorization?.release();
      throw claudeCodeError("NATIVE_RUNTIME_START_FAILED", "The Claude Code runtime could not start.", "session_start", {
        retryable: true,
        stateMayHaveChanged: false,
        recovery: "Verify the installed SDK and native CLI, then retry."
      });
    }
  }

  async #consume(runtime: NativeRuntime): Promise<void> {
    try {
      for await (const message of runtime.query) {
        if (!this.#isRuntimeCurrent(runtime)) return;
        await this.#handleMessage(runtime, message);
      }
      if (!runtime.closed) await this.#handleStreamFailure(runtime);
    } catch (error) {
      if (!runtime.closed) await this.#handleStreamFailure(runtime, error);
    }
  }

  async #handleMessage(runtime: NativeRuntime, message: unknown): Promise<void> {
    if (!this.#isRuntimeCurrent(runtime)) return;
    const envelope = record(message);
    if (envelope === undefined) return;
    const rawNativeSessionId = stringValue(envelope["session_id"]);
    const nativeSessionId = rawNativeSessionId === undefined ? undefined : normalizeNativeSessionId(rawNativeSessionId);
    if (nativeSessionId !== undefined && nativeSessionId !== runtime.nativeSessionId) {
      throw continuityGap();
    }
    const type = stringValue(envelope["type"]);
    const subtype = stringValue(envelope["subtype"]);
    if (type === "system" && subtype === "init") {
      const observedId = nativeSessionId;
      const cliVersion = stringValue(envelope["claude_code_version"]);
      const observedCwd = stringValue(envelope["cwd"]);
      if (observedId === undefined || cliVersion === undefined || observedCwd === undefined) throw continuityGap();
      assertSessionTarget(observedCwd, runtime.target.workspaceRoot);
      this.#lastCliVersion = this.#projection.text(cliVersion, 128);
      runtime.nativeTaskProjectionEnabled = runtime.runtimePolicy === "standard"
        && supportsNativeTaskProjection(this.#lastCliVersion);
      runtime.modelId = stringValue(envelope["model"]) ?? runtime.modelId;
      runtime.effort = stringValue(envelope["effort"]) ?? runtime.effort;
      const observedPermissionMode = stringValue(envelope["permissionMode"]);
      if (runtime.runtimePolicy === "review_read_only" && observedPermissionMode !== "default") {
        throw invalidReviewProfile();
      }
      if (observedPermissionMode === "bypassPermissions") {
        assertFullAccessTarget("bypassPermissions", runtime.target, "permission");
      }
      observePermissionMode(runtime, observedPermissionMode);
      const capabilities = Array.isArray(envelope["capabilities"])
        ? envelope["capabilities"]
        : [];
      runtime.capabilities.clear();
      for (const capability of capabilities) {
        const name = this.#projection.identifier(capability, "");
        if (name.length === 0) continue;
        if (runtime.capabilities.size >= MAX_DESCRIPTOR_ITEMS) throw nativeEventLimit();
        runtime.capabilities.add(name);
      }
      const tools = Array.isArray(envelope["tools"]) ? envelope["tools"] : [];
      if (runtime.runtimePolicy === "review_read_only") assertReviewInitEnvelope(envelope, tools);
      for (const tool of tools) {
        const name = this.#projection.identifier(tool, "");
        if (name.length === 0) continue;
        if (runtime.runtimePolicy === "review_read_only"
          && !(REVIEW_READ_TOOLS as readonly string[]).includes(name)) {
          throw invalidReviewProfile();
        }
        if (this.#toolNames.size >= MAX_DESCRIPTOR_ITEMS && !this.#toolNames.has(name)) {
          throw nativeEventLimit();
        }
        this.#toolNames.add(name);
      }
      const apiKeySource = stringValue(envelope["apiKeySource"]);
      if (credentialSourceIsActive(apiKeySource)) this.#authenticationState = "authenticated";
    }

    const turn = runtime.activeTurn;
    const isTurnInitialization = type === "system" && subtype === "init";
    if (isTurnInitialization && turn !== undefined) {
      turn.nativeIdentityConfirmed = true;
      turn.admission.resolve(undefined);
      await turn.eventsReady.promise;
    }
    if (type === "system" && isNativeTaskSystemSubtype(subtype)) {
      if (runtime.nativeTaskProjectionEnabled) {
        await this.#publishNativeTaskEmissions(
          runtime,
          runtime.nativeTasks.observeSystem(envelope, turn?.context ?? runtime.baseContext)
        );
        if (turn !== undefined) await this.#reconcileNativeContinuation(runtime, turn);
      }
      return;
    }
    const parentToolUseId = stringValue(envelope["parent_tool_use_id"]);
    const isChildFrame = parentToolUseId !== undefined && parentToolUseId.length > 0;
    if (isChildFrame) {
      if (turn !== undefined && !turn.nativeIdentityConfirmed) throw continuityGap();
      if (turn !== undefined) turn.childOutputObserved = true;
      if (!runtime.nativeTaskProjectionEnabled) return;
      const emissions = type === "assistant"
        ? runtime.nativeTasks.observeChildAssistant(envelope)
        : type === "user"
          ? runtime.nativeTasks.observeChildUser(envelope)
          : type === "tool_progress"
            ? runtime.nativeTasks.observeChildToolProgress(envelope)
            : [];
      await this.#publishNativeTaskEmissions(runtime, emissions);
      return;
    }
    if (turn === undefined) return;
    const isTurnFrame = type === "stream_event" || type === "assistant" || type === "user"
      || type === "tool_progress" || type === "result";
    if (isTurnFrame && !turn.nativeIdentityConfirmed) throw continuityGap();
    if (!this.#isTurnCurrent(runtime, turn)) return;
    if (turn.awaitingNativeContinuation
      && (type === "stream_event" || type === "assistant" || type === "result")) {
      if (this.#isKnownNativeContinuationPrelude(turn, type, envelope)) return;
      this.#beginNativeContinuationSegment(turn);
    }
    if (isTurnFrame) {
      turn.frameCount += 1;
      if (turn.frameCount > MAX_TURN_FRAMES) throw nativeEventLimit();
    }
    if (type === "stream_event") {
      await this.#handlePartial(runtime, turn, message);
    } else if (type === "assistant") {
      await this.#handleAssistant(runtime, turn, message);
    } else if (type === "user") {
      await this.#handleUser(runtime, turn, message);
    } else if (type === "tool_progress") {
      await this.#handleToolProgress(runtime, turn, envelope);
    } else if (type === "result") {
      await this.#handleResult(runtime, turn, envelope);
    }
  }

  async #handlePartial(runtime: NativeRuntime, turn: ActiveTurn, message: unknown): Promise<void> {
    const envelope = record(message);
    if (stringValue(envelope?.["parent_tool_use_id"]) !== null && envelope?.["parent_tool_use_id"] !== null) return;
    this.#observeParentStream(turn, envelope);
    const delta = turn.stream.accept(message, this.#projection);
    if (delta === undefined) return;
    await this.#emit(runtime, turn, delta.kind === "text"
      ? { type: "text_delta", blockId: delta.blockId, delta: delta.delta, contentIndex: delta.contentIndex }
      : { type: "thinking_delta", blockId: delta.blockId, delta: delta.delta, contentIndex: delta.contentIndex });
  }

  async #handleAssistant(runtime: NativeRuntime, turn: ActiveTurn, message: unknown): Promise<void> {
    const envelope = record(message);
    if (envelope?.["parent_tool_use_id"] !== null) return;
    const uuid = stringValue(envelope["uuid"]);
    if (uuid !== undefined && turn.seenFrameUuids.has(uuid)) return;
    if (uuid !== undefined) addBoundedIdentity(turn.seenFrameUuids, uuid);
    const error = stringValue(envelope["error"]);
    if (error !== undefined) turn.assistantError = error;
    const nativeMessage = record(envelope["message"]);
    const nativeMessageId = stringValue(nativeMessage?.["id"]);
    if (nativeMessageId !== undefined && !turn.seenParentMessageIds.has(nativeMessageId)) {
      addBoundedIdentity(turn.seenParentMessageIds, nativeMessageId);
      turn.parentAssistantMessages += 1;
    }
    const projected = this.#projection.assistant(message);
    appendTurnBlocks(turn, projected.blocks);
    for (const tool of projected.toolCalls) {
      if (runtime.toolNames.size >= MAX_SESSION_TOOL_NAMES && !runtime.toolNames.has(tool.callId)) {
        throw nativeEventLimit();
      }
      runtime.toolNames.set(tool.callId, tool.name);
      if (runtime.nativeTaskProjectionEnabled) {
        await this.#publishNativeTaskEmissions(
          runtime,
          runtime.nativeTasks.bindToolScope(turn.context, tool.callId, tool.name)
        );
      }
      if (turn.seenToolStarts.has(tool.callId)) continue;
      addBoundedIdentity(turn.seenToolStarts, tool.callId);
      await this.#emit(runtime, turn, {
        type: "tool_start",
        callId: tool.callId,
        name: tool.name,
        input: tool.input
      });
    }
  }

  async #handleUser(runtime: NativeRuntime, turn: ActiveTurn, message: unknown): Promise<void> {
    const envelope = record(message);
    if (envelope?.["parent_tool_use_id"] !== null) return;
    const uuid = stringValue(envelope["uuid"]);
    if (uuid !== undefined && turn.seenFrameUuids.has(uuid)) return;
    if (uuid !== undefined) addBoundedIdentity(turn.seenFrameUuids, uuid);
    const projected = this.#projection.user(message);
    for (const result of projected.toolResults) {
      if (runtime.nativeTaskProjectionEnabled) runtime.nativeTasks.completeToolScope(result.callId);
      if (turn.seenToolResults.has(result.callId)) continue;
      addBoundedIdentity(turn.seenToolResults, result.callId);
      appendTurnBlocks(turn, [result.block]);
      await this.#emit(runtime, turn, {
        type: "tool_result",
        callId: result.callId,
        name: runtime.toolNames.get(result.callId) ?? "Tool",
        output: result.output,
        isError: result.isError
      });
    }
  }

  async #handleToolProgress(
    runtime: NativeRuntime,
    turn: ActiveTurn,
    envelope: Readonly<Record<string, unknown>>
  ): Promise<void> {
    const callId = this.#projection.identifier(envelope["tool_use_id"], "unknown-tool");
    const name = this.#projection.identifier(
      envelope["tool_name"],
      runtime.toolNames.get(callId) ?? "Tool"
    );
    const seconds = finite(envelope["elapsed_time_seconds"]);
    if (seconds === undefined) return;
    await this.#emit(runtime, turn, {
      type: "tool_update",
      callId,
      name,
      outputMode: "replace",
      output: `Running for ${Math.max(0, Math.floor(seconds))} seconds.`
    });
  }

  async #handleResult(
    runtime: NativeRuntime,
    turn: ActiveTurn,
    envelope: Readonly<Record<string, unknown>>
  ): Promise<void> {
    if (!this.#isTurnCurrent(runtime, turn)) return;
    assertResultOwnership(envelope, turn);
    if (turn.terminalClaimed) return;
    const uuid = stringValue(envelope["uuid"]);
    if (uuid !== undefined) {
      if (turn.seenFrameUuids.has(uuid)) return;
      addBoundedIdentity(turn.seenFrameUuids, uuid);
    }
    await this.#projectPermissionDenials(runtime, turn, envelope["permission_denials"]);
    const result = this.#projection.result(envelope, runtime.lastTotalCostUsd, turn.assistantError);
    runtime.lastTotalCostUsd = result.totalCostUsd;
    runtime.lastUsage = result.usage;
    const hasText = turn.blocks.some((block) => block.kind === "text");
    if (!hasText && result.fallbackText !== undefined && result.fallbackText.length > 0) {
      appendTurnBlocks(turn, [{ kind: "text", text: result.fallbackText }]);
    }
    const generation = this.#generationProjection(turn, result.messageUsage, result.durationMs);
    if (turn.blocks.length > 0) {
      await this.#emit(runtime, turn, {
        type: "message_complete",
        role: "assistant",
        blocks: [...turn.blocks],
        usage: generation.usage,
        ...(generation.durationMs === undefined ? {} : {
          generationDurationMs: generation.durationMs,
          generationReliable: generation.reliable
        })
      });
    }
    await this.#emit(runtime, turn, { type: "usage", usage: result.usage });
    if (result.error !== undefined) {
      if (result.error.code === "CLAUDE_CODE_AUTHENTICATION_FAILED") {
        this.#authenticationState = "signed_out";
      }
      await this.#emit(runtime, turn, { type: "error", error: result.error, terminal: true });
    } else if (result.outcome === "completed") {
      if (this.#authenticationState !== "not_required") this.#authenticationState = "authenticated";
    }
    const wakeTaskIds = result.error === undefined
      && result.outcome === "completed"
      && runtime.nativeTaskProjectionEnabled
      ? runtime.nativeTasks.activeWakeTaskIds()
      : [];
    if (wakeTaskIds.length > 0) {
      this.#awaitNativeContinuation(turn, wakeTaskIds);
      return;
    }
    turn.terminalClaimed = true;
    await this.#emit(runtime, turn, { type: "done", outcome: result.outcome });
    if (this.#isTurnCurrent(runtime, turn)) {
      this.#clearNativeContinuation(turn);
      runtime.activeTurn = undefined;
    }
  }

  #awaitNativeContinuation(turn: ActiveTurn, rawTaskIds: readonly string[]): void {
    this.#clearNativeContinuationTimer(turn);
    turn.awaitingNativeContinuation = true;
    turn.continuationTaskIds.clear();
    for (const rawTaskId of rawTaskIds) addBoundedIdentity(turn.continuationTaskIds, rawTaskId);
  }

  #beginNativeContinuationSegment(turn: ActiveTurn): void {
    this.#clearNativeContinuationTimer(turn);
    turn.awaitingNativeContinuation = false;
    turn.nativeContinuationSegment = true;
    turn.continuationTaskIds.clear();
    turn.blocks.splice(0);
    turn.stream.reset();
    turn.assistantError = undefined;
    turn.childOutputObserved = false;
    turn.parentAssistantMessages = 0;
    turn.parentStreamMessages = 0;
    turn.parentGenerationDurationMs = 0;
    turn.parentGenerationReliable = true;
    turn.parentStreamUsage = emptyUsage();
    turn.parentStreamSegment = undefined;
  }

  #isKnownNativeContinuationPrelude(
    turn: ActiveTurn,
    type: string | undefined,
    envelope: Readonly<Record<string, unknown>>
  ): boolean {
    const uuid = stringValue(envelope["uuid"]);
    if (uuid !== undefined && turn.seenFrameUuids.has(uuid)) return true;
    if (type !== "assistant") return false;
    const messageId = stringValue(record(envelope["message"])?.["id"]);
    return messageId !== undefined && turn.seenParentMessageIds.has(messageId);
  }

  async #reconcileNativeContinuation(runtime: NativeRuntime, turn: ActiveTurn): Promise<void> {
    if (!this.#isTurnCurrent(runtime, turn) || !turn.awaitingNativeContinuation
      || turn.continuationTaskIds.size === 0) return;
    for (const rawTaskId of runtime.nativeTasks.activeWakeTaskIds()) {
      addBoundedIdentity(turn.continuationTaskIds, rawTaskId);
    }
    const states = [...turn.continuationTaskIds].map((rawTaskId) => runtime.nativeTasks.taskState(rawTaskId));
    if (states.some((state) => state === undefined || state === "queued" || state === "running")) {
      this.#clearNativeContinuationTimer(turn);
      return;
    }
    if (states.every((state) => state === "stopped")) {
      await this.#settleNativeContinuation(runtime, turn, "completed");
      return;
    }
    this.#armNativeContinuationGrace(runtime, turn);
  }

  #armNativeContinuationGrace(runtime: NativeRuntime, turn: ActiveTurn): void {
    if (turn.continuationTimer !== undefined) return;
    turn.continuationTimer = setTimeout(() => {
      turn.continuationTimer = undefined;
      void this.#settleNativeContinuation(runtime, turn, "completed")
        .catch((error: unknown) => this.#handleStreamFailure(runtime, error));
    }, this.#nativeContinuationGraceMs);
    turn.continuationTimer.unref?.();
  }

  async #settleNativeContinuation(
    runtime: NativeRuntime,
    turn: ActiveTurn,
    outcome: "completed" | "aborted"
  ): Promise<void> {
    if (!this.#isTurnCurrent(runtime, turn) || !turn.awaitingNativeContinuation || turn.terminalClaimed) return;
    turn.terminalClaimed = true;
    this.#clearNativeContinuation(turn);
    await this.#emit(runtime, turn, { type: "done", outcome });
    if (this.#isTurnCurrent(runtime, turn)) runtime.activeTurn = undefined;
  }

  #clearNativeContinuationTimer(turn: ActiveTurn): void {
    if (turn.continuationTimer === undefined) return;
    clearTimeout(turn.continuationTimer);
    turn.continuationTimer = undefined;
  }

  #clearNativeContinuation(turn: ActiveTurn): void {
    this.#clearNativeContinuationTimer(turn);
    turn.awaitingNativeContinuation = false;
    turn.continuationTaskIds.clear();
    turn.stream.reset();
  }

  async #projectPermissionDenials(runtime: NativeRuntime, turn: ActiveTurn, rawDenials: unknown): Promise<void> {
    if (!Array.isArray(rawDenials)) return;
    if (rawDenials.length > MAX_TURN_BLOCKS) throw nativeEventLimit();
    for (const rawDenial of rawDenials) {
      const denial = record(rawDenial);
      if (denial === undefined) continue;
      const callId = this.#projection.identifier(denial["tool_use_id"], "denied-tool");
      const name = this.#projection.identifier(denial["tool_name"], "Tool");
      if (!turn.seenToolStarts.has(callId)) {
        addBoundedIdentity(turn.seenToolStarts, callId);
        if (runtime.toolNames.size >= MAX_SESSION_TOOL_NAMES && !runtime.toolNames.has(callId)) {
          throw nativeEventLimit();
        }
        runtime.toolNames.set(callId, name);
        const input = this.#projection.json(denial["tool_input"] ?? {});
        appendTurnBlocks(turn, [{ kind: "tool_call", callId, name, input }]);
        await this.#emit(runtime, turn, { type: "tool_start", callId, name, input });
      }
      if (turn.seenToolResults.has(callId)) continue;
      addBoundedIdentity(turn.seenToolResults, callId);
      const output = "Permission was denied.";
      appendTurnBlocks(turn, [{ kind: "tool_result", callId, output, isError: true }]);
      await this.#emit(runtime, turn, { type: "tool_result", callId, name, output, isError: true });
    }
  }

  async #handleStreamFailure(runtime: NativeRuntime, cause?: unknown): Promise<void> {
    const turn = runtime.activeTurn;
    const publicError: PublicError = cause instanceof JokoError
      ? cause.publicError
      : cause instanceof ProjectionLimitError
        ? nativeEventLimit().publicError
        : {
            code: "CLAUDE_CODE_STREAM_ENDED",
            message: "The native event stream ended before an authoritative Result.",
            phase: "turn",
            retryable: true,
            stateMayHaveChanged: true,
            recovery: "Inspect the native Session before retrying the turn."
          };
    try {
      if (turn !== undefined) {
        const admissionError = claudeCodeError(
          "NATIVE_DISPATCH_UNKNOWN",
          "Native dispatch admission could not be confirmed.",
          "dispatch",
          {
            retryable: true,
            stateMayHaveChanged: turn.inputConsumed,
            recovery: "Inspect the native Session before retrying."
          }
        );
        if (!turn.admission.settled()) {
          turn.admission.reject(cause instanceof JokoError ? cause : admissionError);
        } else if (this.#isTurnCurrent(runtime, turn) && !turn.terminalClaimed) {
          turn.terminalClaimed = true;
          await turn.eventsReady.promise;
          await this.#emit(runtime, turn, { type: "error", error: publicError, terminal: true });
          await this.#emit(runtime, turn, { type: "done", outcome: "failed" });
        }
      }
    } catch {
      // The runtime fence and teardown remain authoritative if Host emission fails.
    } finally {
      await this.#retireRuntime(runtime, false, publicError);
    }
  }

  async #canUseTool(
    runtime: NativeRuntime,
    toolName: string,
    input: Readonly<Record<string, unknown>>,
    options: ClaudeCanUseToolOptions
  ): Promise<ClaudePermissionResult> {
    const turn = runtime.activeTurn;
    if (turn === undefined || !this.#isTurnCurrent(runtime, turn) || options.signal.aborted) {
      return { behavior: "deny", message: "The originating turn is no longer active." };
    }
    if (!turn.nativeIdentityConfirmed) {
      return { behavior: "deny", message: "The native Session identity has not been confirmed for this turn." };
    }
    await raceAbort(turn.eventsReady.promise, options.signal);
    if (!this.#isTurnCurrent(runtime, turn) || options.signal.aborted) {
      return { behavior: "deny", message: "The originating turn is no longer active." };
    }
    if (runtime.runtimePolicy === "review_read_only") {
      return reviewToolDecision(runtime.target.workspaceRoot, toolName, input);
    }
    const requestId = this.#projection.identifier(options.requestId, "missing-request");
    let fingerprint: string;
    try {
      fingerprint = permissionFingerprint(toolName, input, options.toolUseID);
    } catch {
      return { behavior: "deny", message: "The permission request payload exceeded safe limits." };
    }
    const cached = runtime.resolvedPermissions.get(requestId);
    if (cached !== undefined) {
      return cached.fingerprint === fingerprint
        ? cached.result
        : { behavior: "deny", message: "The repeated permission request did not match its original payload." };
    }
    const pending = runtime.pendingPermissions.get(requestId);
    if (pending !== undefined) {
      return pending.fingerprint === fingerprint
        ? pending.promise
        : { behavior: "deny", message: "The repeated permission request did not match its original payload." };
    }
    if (runtime.pendingPermissions.size >= MAX_PENDING_INTERACTIONS) {
      return { behavior: "deny", message: "Too many permission requests are already pending." };
    }
    const decisionPromise = this.#resolveToolInteraction(runtime, turn, toolName, input, options)
      .catch((): ClaudePermissionResult => ({
        behavior: "deny",
        message: "The permission decision could not be completed safely."
      }))
      .then((result) => {
        if (this.#isTurnCurrent(runtime, turn)) {
          runtime.resolvedPermissions.set(requestId, { fingerprint, result });
          trimMap(runtime.resolvedPermissions, MAX_INTERACTION_CACHE);
        }
        return result;
      })
      .finally(() => runtime.pendingPermissions.delete(requestId));
    runtime.pendingPermissions.set(requestId, { fingerprint, promise: decisionPromise });
    return decisionPromise;
  }

  async #resolveToolInteraction(
    runtime: NativeRuntime,
    turn: ActiveTurn,
    toolName: string,
    input: Readonly<Record<string, unknown>>,
    options: ClaudeCanUseToolOptions
  ): Promise<ClaudePermissionResult> {
    if (toolName === "AskUserQuestion") return this.#askUserQuestion(runtime, turn, input, options);
    if (toolName === "ExitPlanMode") return this.#reviewPlan(runtime, turn, input, options);
    const interaction: InteractionPayload = {
      id: interactionId(runtime, options.requestId),
      kind: "permission",
      title: this.#projection.identifier(options.title, `${toolName} requests permission`),
      toolName: this.#projection.identifier(toolName, "Tool"),
      summary: permissionSummary(toolName, input, options, this.#projection),
      risk: permissionRisk(toolName),
      choices: ["allow_once", "allow_for_session", "deny"]
    };
    const decision = await this.#requestInteraction(runtime, turn, interaction, options.signal);
    if (!this.#isTurnCurrent(runtime, turn) || options.signal.aborted) {
      return { behavior: "deny", message: "The permission request expired." };
    }
    const selected = permissionSelection(decision);
    if (selected === "allow_once" || selected === "allow_for_session") {
      const updatedPermissions = selected === "allow_for_session"
        ? safePermissionUpdates(options.suggestions ?? [], runtime.target.trusted)
        : [];
      return {
        behavior: "allow",
        updatedInput: input,
        ...(updatedPermissions.length === 0 ? {} : { updatedPermissions })
      };
    }
    return { behavior: "deny", message: "The user denied this tool request." };
  }

  async #askUserQuestion(
    runtime: NativeRuntime,
    turn: ActiveTurn,
    input: Readonly<Record<string, unknown>>,
    options: ClaudeCanUseToolOptions
  ): Promise<ClaudePermissionResult> {
    const rawQuestions = Array.isArray(input["questions"]) ? input["questions"].slice(0, 20) : [];
    if (rawQuestions.length === 0) {
      return { behavior: "deny", message: "The native question payload was invalid." };
    }
    const fields: Extract<InteractionPayload, { kind: "question" }>["fields"][number][] = [];
    const originals: { readonly question: string; readonly choices: ReadonlyMap<string, string>; readonly multi: boolean }[] = [];
    for (let index = 0; index < rawQuestions.length; index += 1) {
      const question = record(rawQuestions[index]) ?? {};
      const label = this.#projection.identifier(question["question"], `Question ${index + 1}`);
      const header = this.#projection.text(question["header"], 128);
      const rawOptions = Array.isArray(question["options"]) ? question["options"].slice(0, 50) : [];
      const choices = rawOptions.flatMap((rawOption, optionIndex) => {
        const option = record(rawOption);
        if (option === undefined) return [];
        const optionLabel = this.#projection.identifier(option["label"], `Option ${optionIndex + 1}`);
        return [{
          id: `q${index}o${optionIndex}`,
          label: optionLabel,
          description: this.#projection.text(option["description"], 512)
        }];
      });
      const choiceMap = new Map(choices.map((choice) => [choice.id, choice.label]));
      const multi = question["multiSelect"] === true;
      originals.push({ question: stringValue(question["question"]) ?? label, choices: choiceMap, multi });
      if (choices.length === 0) {
        fields.push({
          id: `q${index}`,
          label,
          description: header,
          required: true,
          kind: "text",
          multiline: false,
          sensitive: false
        });
      } else if (multi) {
        fields.push({
          id: `q${index}`,
          label,
          description: header,
          required: true,
          kind: "multiple",
          choices,
          defaultChoiceIds: [],
          minimumSelections: 1
        });
      } else {
        fields.push({
          id: `q${index}`,
          label,
          description: header,
          required: true,
          kind: "single",
          choices
        });
      }
    }
    const interaction: InteractionPayload = {
      id: interactionId(runtime, options.requestId),
      kind: "question",
      title: this.#projection.identifier(options.title, "Claude Code needs input"),
      prompt: "Answer the questions required to continue the native turn.",
      fields
    };
    const decision = await this.#requestInteraction(runtime, turn, interaction, options.signal);
    if (decision.kind !== "question" || !this.#isTurnCurrent(runtime, turn) || options.signal.aborted) {
      return { behavior: "deny", message: "The user did not answer the question." };
    }
    const answers: Record<string, string> = {};
    for (let index = 0; index < originals.length; index += 1) {
      const original = originals[index];
      if (original === undefined) continue;
      const value = decision.answers[`q${index}`];
      const selectedValues = Array.isArray(value) ? value : value === undefined ? [] : [value];
      const labels = selectedValues.map((selected) => {
        const text = String(selected);
        return original.choices.get(text) ?? text;
      });
      answers[original.question] = original.multi ? labels.join(", ") : (labels[0] ?? "");
    }
    return { behavior: "allow", updatedInput: { ...input, answers } };
  }

  async #reviewPlan(
    runtime: NativeRuntime,
    turn: ActiveTurn,
    input: Readonly<Record<string, unknown>>,
    options: ClaudeCanUseToolOptions
  ): Promise<ClaudePermissionResult> {
    const markdown = this.#projection.text(input["plan"] ?? input["content"] ?? "Review the proposed plan.");
    const interaction: InteractionPayload = {
      id: interactionId(runtime, options.requestId),
      kind: "plan_review",
      title: this.#projection.identifier(options.title, "Review plan"),
      markdown,
      choices: ["execute", "stay", "refine"]
    };
    const decision = await this.#requestInteraction(runtime, turn, interaction, options.signal);
    if (decision.kind === "plan_review" && decision.decision === "execute"
      && this.#isTurnCurrent(runtime, turn) && !options.signal.aborted) {
      return { behavior: "allow", updatedInput: input };
    }
    const feedback = decision.kind === "plan_review"
      ? this.#projection.text(decision.feedback, 2048)
      : "";
    return {
      behavior: "deny",
      message: feedback.length === 0 ? "The user chose not to execute the plan." : feedback
    };
  }

  async #requestInteraction(
    runtime: NativeRuntime,
    turn: ActiveTurn,
    interaction: InteractionPayload,
    signal: AbortSignal
  ): Promise<InteractionDecision> {
    const decision = await raceAbort(turn.context.requestInteraction(interaction, { signal }), signal);
    if (decision === undefined) return { kind: "cancelled" };
    if (!this.#isTurnCurrent(runtime, turn)) return { kind: "cancelled" };
    return decision;
  }

  #observeParentStream(turn: ActiveTurn, envelope: Readonly<Record<string, unknown>> | undefined): void {
    const event = record(envelope?.["event"]);
    const type = stringValue(event?.["type"]);
    if (type === "message_start") {
      if (turn.parentStreamSegment !== undefined) turn.parentGenerationReliable = false;
      const message = record(event?.["message"]);
      const usage = record(message?.["usage"]);
      const initialOutputTokens = finite(usage?.["output_tokens"]);
      turn.parentStreamSegment = {
        startedAt: this.#now(),
        inputTokens: nonNegativeFinite(usage?.["input_tokens"]),
        cacheReadTokens: nonNegativeFinite(usage?.["cache_read_input_tokens"]),
        cacheWriteTokens: nonNegativeFinite(usage?.["cache_creation_input_tokens"]),
        ...(initialOutputTokens === undefined || initialOutputTokens < 0
          ? {}
          : { outputTokens: initialOutputTokens })
      };
      turn.parentStreamMessages += 1;
      return;
    }
    if (type === "message_delta") {
      const segment = turn.parentStreamSegment;
      const usage = record(event?.["usage"]);
      const outputTokens = finite(usage?.["output_tokens"]);
      if (segment === undefined || outputTokens === undefined || outputTokens < 0) {
        turn.parentGenerationReliable = false;
        return;
      }
      segment.outputTokens = outputTokens;
      return;
    }
    if (type !== "message_stop") return;
    const segment = turn.parentStreamSegment;
    turn.parentStreamSegment = undefined;
    if (segment === undefined) {
      turn.parentGenerationReliable = false;
      return;
    }
    const endedAt = this.#now();
    if (endedAt < segment.startedAt || segment.outputTokens === undefined) {
      turn.parentGenerationReliable = false;
      return;
    }
    turn.parentGenerationDurationMs += endedAt - segment.startedAt;
    const usage = turn.parentStreamUsage;
    const inputTokens = usage.inputTokens + segment.inputTokens;
    const outputTokens = usage.outputTokens + segment.outputTokens;
    const cacheReadTokens = usage.cacheReadTokens + segment.cacheReadTokens;
    const cacheWriteTokens = usage.cacheWriteTokens + segment.cacheWriteTokens;
    turn.parentStreamUsage = {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalTokens: inputTokens + outputTokens,
      cost: 0
    };
  }

  #generationProjection(
    turn: ActiveTurn,
    resultUsage: UsageSnapshot,
    resultDurationMs: number | undefined
  ): { readonly usage: UsageSnapshot; readonly durationMs?: number; readonly reliable: boolean } {
    if (!turn.childOutputObserved) {
      return {
        usage: resultUsage,
        ...(resultDurationMs === undefined ? {} : { durationMs: resultDurationMs }),
        reliable: resultDurationMs !== undefined
      };
    }
    if (turn.parentStreamSegment !== undefined) turn.parentGenerationReliable = false;
    if (turn.parentStreamMessages === 0 || turn.parentAssistantMessages > turn.parentStreamMessages) {
      turn.parentGenerationReliable = false;
    }
    const streamedUsageAvailable = turn.parentStreamMessages > 0
      && turn.parentStreamUsage.totalTokens > 0;
    const durationMs = turn.parentGenerationDurationMs > 0
      ? turn.parentGenerationDurationMs
      : undefined;
    return {
      usage: streamedUsageAvailable ? turn.parentStreamUsage : resultUsage,
      ...(durationMs === undefined ? {} : { durationMs }),
      reliable: turn.parentGenerationReliable && streamedUsageAvailable && durationMs !== undefined
    };
  }

  async #publishNativeTaskEmissions(
    runtime: NativeRuntime,
    emissions: readonly NativeTaskEmission[]
  ): Promise<void> {
    for (const emission of emissions) {
      if (!this.#matchesContext(runtime, emission.context)) return;
      const fields: Record<string, string | number | boolean> = {
        queryGeneration: runtime.queryGeneration,
        sessionGeneration: runtime.sessionGeneration,
        nativeTaskProjection: true
      };
      if (runtime.backendInstanceGeneration !== undefined) {
        fields["backendInstanceGeneration"] = runtime.backendInstanceGeneration;
      }
      await emission.context.emit(emission.payload, { namespace: "claude-code.native_tasks", fields });
    }
  }

  async #emit(runtime: NativeRuntime, turn: ActiveTurn, payload: EventPayload): Promise<boolean> {
    if (!this.#isTurnCurrent(runtime, turn)) return false;
    const fields: Record<string, string | number | boolean> = {
      queryGeneration: runtime.queryGeneration,
      sessionGeneration: runtime.sessionGeneration
    };
    if (runtime.backendInstanceGeneration !== undefined) {
      fields["backendInstanceGeneration"] = runtime.backendInstanceGeneration;
    }
    await turn.context.emit(payload, { namespace: "claude-code", fields });
    return this.#isTurnCurrent(runtime, turn);
  }

  async #runControl(
    runtime: NativeRuntime,
    context: AdapterContext,
    phase: string,
    operation: () => Promise<void>
  ): Promise<void> {
    try {
      await operation();
    } catch {
      throw claudeCodeError("NATIVE_CONTROL_UNKNOWN", "The native control outcome is unknown.", phase, {
        retryable: true,
        stateMayHaveChanged: true,
        recovery: "Inspect the native Session state before retrying."
      });
    }
    this.#assertCurrent(runtime, context);
  }

  async #retireRuntime(
    runtime: NativeRuntime,
    waitForConsumer = true,
    taskFailure?: PublicError
  ): Promise<void> {
    if (runtime.closed) return;
    if (runtime.activeTurn !== undefined) this.#clearNativeContinuation(runtime.activeTurn);
    if (runtime.nativeTaskProjectionEnabled) {
      try {
        await this.#publishNativeTaskEmissions(
          runtime,
          runtime.nativeTasks.terminateActive(taskFailure === undefined ? "stopped" : "failed", taskFailure)
        );
      } catch {
        // Runtime retirement remains authoritative when terminal task publication fails.
      }
    }
    runtime.closed = true;
    if (this.#sessions.get(runtime.productSessionId) === runtime) {
      this.#sessions.delete(runtime.productSessionId);
    }
    const reason = new Error("The native runtime was retired.");
    runtime.activeTurn?.admission.reject(reason);
    runtime.activeTurn?.eventsReady.resolve(undefined);
    runtime.gate.close(reason);
    runtime.abortController.abort();
    try {
      runtime.query.close();
    } catch {
      // The AbortController and closed generation fence remain authoritative.
    }
    if (waitForConsumer) await settleWithin(runtime.consumer, this.#teardownTimeoutMs);
  }

  async #retireAuthorizedRuntimes(): Promise<void> {
    const runtimes = [...this.#sessions.values()];
    await Promise.all(runtimes.map(async (runtime) => this.#retireRuntime(runtime)));
    await this.#runtime.retireOwnedProcesses?.(this.#teardownTimeoutMs);
  }

  async #sessionInfo(nativeSessionId: string, target: TargetDescriptor) {
    try {
      return await this.#runtime.getSessionInfo(nativeSessionId, { dir: target.workspaceRoot });
    } catch {
      throw claudeCodeError("NATIVE_SESSION_INSPECTION_FAILED", "The native Session could not be inspected.", "session_inspect", {
        retryable: true,
        stateMayHaveChanged: false,
        recovery: "Verify the SDK installation and native Session store, then retry."
      });
    }
  }

  #observeProbe(probe: ClaudeSdkProbe, installed: boolean): void {
    this.#models.clear();
    this.#lastCliVersion = undefined;
    this.#authenticationState = "error";
    if (!installed || probe.initialization === undefined) return;
    this.#observeInitialization(probe.initialization, probe.apiKeySource);
    const cliVersion = this.#projection.text(probe.cliVersion, 128).trim();
    this.#lastCliVersion = cliVersion.length === 0 ? undefined : cliVersion;
  }

  #observeInitialization(
    initialization: ClaudeSdkInitializationResult,
    apiKeySource?: string
  ): void {
    if (!Array.isArray(initialization.models) || initialization.models.length > MAX_DESCRIPTOR_ITEMS) {
      throw nativeEventLimit();
    }
    const models = new Map<string, ClaudeSdkModelInfo>();
    for (const model of initialization.models) {
      if (typeof model.value !== "string" || model.value.trim().length === 0 || model.value.length > 512) {
        throw nativeEventLimit();
      }
      models.set(model.value, model);
    }
    this.#models.clear();
    for (const [modelId, model] of models) this.#models.set(modelId, model);
    this.#authenticationState = authenticationStateFor(initialization.account, apiKeySource);
  }

  async #validateExtraDirectories(directories: readonly ApprovedDirectory[]): Promise<readonly ApprovedDirectory[]> {
    const seen = new Set<string>();
    const validated: ApprovedDirectory[] = [];
    for (const directory of directories) {
      if (directory.access !== "read_write") {
        throw claudeCodeError(
          "EXTRA_DIRECTORY_ACCESS_UNSUPPORTED",
          "Claude Code cannot enforce a read-only additional directory through this protocol.",
          "extra_directories",
          { recovery: "Approve only read-write additional directories for this Backend." }
        );
      }
      await validateCanonicalDirectory(directory.path, "Additional directory");
      const identity = canonicalPathKey(directory.path);
      if (seen.has(identity)) {
        throw claudeCodeError("EXTRA_DIRECTORY_DUPLICATE", "The additional directory list contains a duplicate path.", "extra_directories", {
          recovery: "Remove duplicate directory entries and retry."
        });
      }
      seen.add(identity);
      validated.push({ ...directory, path: normalize(directory.path) });
    }
    return validated;
  }

  #requireRuntime(context: AdapterContext): NativeRuntime {
    const runtime = this.#sessions.get(context.sessionId);
    if (runtime === undefined) {
      throw claudeCodeError("SESSION_NOT_ATTACHED", "The product Session has no attached native runtime.", "session", {
        recovery: "Resume the native Session before continuing."
      });
    }
    this.#assertCurrent(runtime, context, context.binding);
    return runtime;
  }

  #requireIdleRuntime(context: AdapterContext): NativeRuntime {
    const runtime = this.#requireRuntime(context);
    if (runtime.activeTurn !== undefined) {
      throw claudeCodeError("SESSION_BUSY", "The native control requires an idle Session.", "control", {
        retryable: true,
        recovery: "Wait for the authoritative Result before changing Session controls."
      });
    }
    return runtime;
  }

  #assertStandardRuntime(runtime: NativeRuntime, operation: string): void {
    if (runtime.runtimePolicy === "standard") return;
    throw claudeCodeError(
      "CLAUDE_CODE_REVIEW_OPERATION_DENIED",
      `The isolated reviewer cannot ${operation}.`,
      "dispatch",
      { recovery: "Perform this operation in a standard Session instead." }
    );
  }

  #assertCurrent(runtime: NativeRuntime, context: AdapterContext, binding?: NativeSessionBinding): void {
    if (!this.#matchesContext(runtime, context, binding)) {
      throw claudeCodeError("BACKEND_GENERATION_MISMATCH", "The native runtime fence no longer matches this request.", "generation", {
        recovery: "Refresh Session state before retrying."
      });
    }
  }

  #matchesContext(runtime: NativeRuntime, context: AdapterContext, binding?: NativeSessionBinding): boolean {
    return this.#isRuntimeCurrent(runtime)
      && runtime.productSessionId === context.sessionId
      && runtime.sessionGeneration === context.generation
      && runtime.backendInstanceGeneration === context.backendInstanceGeneration
      && runtime.runtimePolicy === (context.runtimePolicy === "review_read_only" ? "review_read_only" : "standard")
      && runtime.target.id === context.target.id
      && runtime.target.backendId === context.target.backendId
      && runtime.target.managed === context.target.managed
      && runtime.target.trusted === context.target.trusted
      && canonicalPathKey(runtime.target.workspaceRoot) === canonicalPathKey(context.target.workspaceRoot)
      && (binding === undefined || (
        binding.opaqueRef === runtime.binding.opaqueRef
        && binding.generation === runtime.binding.generation
      ));
  }

  #isRuntimeCurrent(runtime: NativeRuntime): boolean {
    return !runtime.closed && this.#sessions.get(runtime.productSessionId) === runtime;
  }

  #isTurnCurrent(runtime: NativeRuntime, turn: ActiveTurn): boolean {
    return this.#isRuntimeCurrent(runtime)
      && runtime.activeTurn === turn
      && runtime.queryGeneration === turn.queryGeneration
      && runtime.sessionGeneration === turn.sessionGeneration
      && runtime.backendInstanceGeneration === turn.backendInstanceGeneration
      && turn.context.generation === turn.sessionGeneration
      && turn.context.backendInstanceGeneration === turn.backendInstanceGeneration;
  }

  #assertBindingContext(binding: NativeSessionBinding, context: AdapterContext): void {
    this.#assertBackendInstance(context);
    if (binding.generation !== context.generation) {
      throw claudeCodeError("SESSION_GENERATION_MISMATCH", "The native Session binding generation is stale.", "generation", {
        recovery: "Refresh the Session binding before retrying."
      });
    }
    parseBinding(binding);
  }

  #resumeBindingForContext(binding: NativeSessionBinding, context: AdapterContext): NativeSessionBinding {
    this.#assertBackendInstance(context);
    if (!Number.isSafeInteger(context.generation) || context.generation < 0) {
      throw claudeCodeError("SESSION_GENERATION_INVALID", "The Session generation is invalid.", "generation", {
        recovery: "Refresh the Session binding before retrying."
      });
    }
    const nativeSessionId = parseBinding(binding);
    const sameGeneration = binding.generation === context.generation;
    const hostReactivation = binding.generation === context.generation - 1;
    if (!sameGeneration && !hostReactivation) {
      throw claudeCodeError("SESSION_GENERATION_MISMATCH", "The native Session binding generation is stale.", "generation", {
        recovery: "Refresh the Session binding before retrying."
      });
    }
    const currentBinding = context.binding;
    if (currentBinding === undefined) {
      if (!sameGeneration) {
        throw claudeCodeError("SESSION_GENERATION_MISMATCH", "The resumed Session generation has no current binding proof.", "generation", {
          recovery: "Refresh the Session binding before retrying."
        });
      }
      return binding;
    }
    const currentNativeSessionId = parseBinding(currentBinding);
    if (currentBinding.generation !== context.generation
      || currentBinding.opaqueRef !== binding.opaqueRef
      || currentNativeSessionId !== nativeSessionId) {
      throw continuityGap();
    }
    return currentBinding;
  }

  #assertUsable(): void {
    if (this.#disposed) {
      throw claudeCodeError("BACKEND_DISPOSED", "This Backend Adapter has been disposed.", "backend", {
        recovery: "Create a new Backend instance."
      });
    }
  }

  #assertBackendInstance(context: AdapterContext): void {
    if (context.backendInstanceGeneration !== this.#instanceGeneration) {
      throw claudeCodeError("BACKEND_GENERATION_MISMATCH", "The Backend instance generation is stale or missing.", "generation", {
        recovery: "Refresh the Backend descriptor before retrying."
      });
    }
  }
}

export function createClaudeCodeAdapter(options: ClaudeCodeAdapterOptions): ClaudeCodeAdapter {
  return new ClaudeCodeAdapter(options);
}

function reviewRuntimePolicy(
  input: CreateNativeSessionInput,
  context: AdapterContext
): "standard" | "review_read_only" {
  const inputPolicy = input.runtimePolicy ?? "standard";
  const contextPolicy = context.runtimePolicy ?? "standard";
  if (inputPolicy !== contextPolicy) throw invalidReviewProfile();
  if (inputPolicy === "standard") return "standard";
  const requestedStart = input.nativeStart ?? { kind: "new" as const };
  if (requestedStart.kind !== "new"
    || requestedStart.parentNativeReference !== undefined
    || input.permissionMode !== "ask"
    || input.fastMode
    || input.name !== undefined
    || input.appendSystemPrompt !== undefined
    || context.appendSystemPrompt !== undefined
    || (context.extraDirectories?.length ?? 0) !== 0) {
    throw invalidReviewProfile();
  }
  return "review_read_only";
}

function reviewResumeRuntimePolicy(context: AdapterContext): "standard" {
  if (context.runtimePolicy === "review_read_only") throw invalidReviewProfile();
  return "standard";
}

function assertStandardReviewContext(context: AdapterContext, operation: string): void {
  if (context.runtimePolicy !== "review_read_only") return;
  throw claudeCodeError(
    "CLAUDE_CODE_REVIEW_OPERATION_DENIED",
    `The isolated reviewer cannot ${operation}.`,
    "dispatch",
    { recovery: "Perform this operation in a standard Session instead." }
  );
}

function invalidReviewProfile(): JokoError {
  return claudeCodeError(
    "CLAUDE_CODE_REVIEW_PROFILE_INVALID",
    "Isolated review requires a fresh immutable read-only Session profile.",
    "session_start",
    { recovery: "Create a fresh reviewer with ask-mode policy and no mutable workspace grants." }
  );
}

function assertReviewInitialization(initialization: ClaudeSdkInitializationResult): void {
  if (initialization.commands !== undefined && initialization.commands.length !== 0) {
    throw invalidReviewProfile();
  }
  assertReviewFastModeDisabled(initialization.fast_mode_state);
}

function assertReviewInitEnvelope(
  envelope: Readonly<Record<string, unknown>>,
  tools: readonly unknown[]
): void {
  if (tools.length !== REVIEW_READ_TOOLS.length) throw invalidReviewProfile();
  const observedTools = new Set(tools.map((tool) => typeof tool === "string" ? tool : ""));
  if (observedTools.size !== REVIEW_READ_TOOLS.length
    || REVIEW_READ_TOOLS.some((tool) => !observedTools.has(tool))) {
    throw invalidReviewProfile();
  }
  for (const key of ["mcp_servers", "slash_commands", "skills", "plugins"] as const) {
    const value = envelope[key];
    if (!Array.isArray(value) || value.length !== 0) throw invalidReviewProfile();
  }
  const agents = envelope["agents"];
  if (agents !== undefined && (
    (Array.isArray(agents) && agents.length !== 0)
    || (!Array.isArray(agents) && (typeof agents !== "object" || agents === null || Object.keys(agents).length !== 0))
  )) throw invalidReviewProfile();
  assertReviewFastModeDisabled(envelope["fast_mode_state"]);
}

function assertReviewFastModeDisabled(value: unknown): void {
  if (value === undefined) return;
  if (typeof value !== "string" || !["off", "disabled", "unavailable"].includes(value.toLowerCase())) {
    throw invalidReviewProfile();
  }
}

function supportsIsolatedReview(cliVersion: string | undefined): boolean {
  return exactCliVersion(cliVersion, ISOLATED_REVIEW_CLI_VERSION);
}

function supportsNativeTaskProjection(cliVersion: string | undefined): boolean {
  return exactCliVersion(cliVersion, NATIVE_TASK_CLI_VERSION);
}

function exactCliVersion(cliVersion: string | undefined, expected: readonly number[]): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(cliVersion ?? "");
  if (match === null) return false;
  const observed = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  return expected.every((part, index) => observed[index] === part);
}

async function reviewToolDecision(
  workspaceRoot: string,
  toolName: string,
  input: Readonly<Record<string, unknown>>
): Promise<ClaudePermissionResult> {
  if (!(REVIEW_READ_TOOLS as readonly string[]).includes(toolName)) {
    return { behavior: "deny", message: "The isolated reviewer permits read-only workspace tools only." };
  }
  const pathKey = toolName === "Read" ? "file_path" : "path";
  const rawPath = input[pathKey];
  if (toolName === "Read" && typeof rawPath !== "string") {
    return { behavior: "deny", message: "The isolated reviewer requires an explicit workspace file." };
  }
  if (rawPath !== undefined) {
    if (typeof rawPath !== "string" || rawPath.length === 0 || rawPath.length > 4_096 || rawPath.includes("\0")) {
      return { behavior: "deny", message: "The requested read path is invalid." };
    }
    try {
      const canonicalRoot = await realpath(workspaceRoot);
      const candidate = await realpath(isAbsolute(rawPath) ? rawPath : resolve(workspaceRoot, rawPath));
      const rootKey = canonicalPathKey(canonicalRoot);
      const candidateKey = canonicalPathKey(candidate);
      const rootPrefix = rootKey.endsWith(sep) ? rootKey : `${rootKey}${sep}`;
      if (candidateKey !== rootKey && !candidateKey.startsWith(rootPrefix)) {
        return { behavior: "deny", message: "The isolated reviewer cannot read outside its workspace." };
      }
      const relativePath = relative(canonicalRoot, candidate);
      if (reviewPathSegmentsAreSensitive(relativePath.split(/[\\/]/gu))) {
        return { behavior: "deny", message: "The isolated reviewer cannot read credential-bearing workspace paths." };
      }
    } catch {
      return { behavior: "deny", message: "The requested workspace path could not be proven." };
    }
  }
  return { behavior: "allow", updatedInput: { ...input } };
}

function reviewPathSegmentsAreSensitive(segments: readonly string[]): boolean {
  return segments.some((segment) => {
    const lower = segment.toLocaleLowerCase("en-US");
    if (REVIEW_SENSITIVE_PATH_SEGMENTS.has(lower)) return true;
    if (lower === ".env" || lower.startsWith(".env.")) return true;
    if ([
      ".netrc",
      ".npmrc",
      ".pgpass",
      ".pypirc",
      ".git-credentials",
      "auth.json",
      "credentials.json",
      "id_rsa",
      "id_ed25519",
      "id_ecdsa",
      "id_dsa"
    ].includes(lower)) return true;
    return /\.(?:key|p12|pem|pfx)$/iu.test(lower);
  });
}

function validatedHostCapabilities(
  values: readonly HostComposedCapability[] | undefined
): ReadonlySet<HostComposedCapability> {
  const capabilities = new Set<HostComposedCapability>();
  for (const value of values ?? []) {
    if (!(HOST_COMPOSED_CAPABILITIES as readonly string[]).includes(value)) {
      throw new TypeError("Claude Code Host-composed capability is invalid.");
    }
    capabilities.add(value);
  }
  return capabilities;
}

interface ValidatedHistoryMessage {
  readonly type: "user" | "assistant" | "system";
  readonly uuid: string;
  readonly message: unknown;
  readonly child: boolean;
}

interface HistoryEntryProjection {
  readonly kind: string;
  readonly contentIndex: number;
  readonly payload: EventPayload;
}

function projectNativeHistory(
  messages: readonly ClaudeSdkSessionMessage[],
  nativeSessionId: string,
  projection: SafeProjection
): NativeHistoryProjection {
  const entries: ValidatedHistoryMessage[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    const validated = validatedHistoryMessage(message, nativeSessionId);
    if (seen.has(validated.uuid)) throw invalidNativeHistory();
    seen.add(validated.uuid);
    if (!validated.child) entries.push(validated);
  }

  const events: NativeHistoryProjectedEvent[] = [];
  const lineage: { entryId: string; parentEntryId?: string }[] = [];
  const toolNames = new Map<string, string>();
  let parentEntryId: string | undefined;
  for (const entry of entries) {
    lineage.push({
      entryId: entry.uuid,
      ...(parentEntryId === undefined ? {} : { parentEntryId })
    });
    const projected = projectHistoryEntry(entry, projection, toolNames);
    const metadata: AdapterEventMetadata = {
      namespace: "claude-code.native_history",
      fields: {
        nativeHydration: true,
        nativeMessageType: entry.type
      }
    };
    for (const item of projected) {
      events.push({
        nativeEntryId: entry.uuid,
        ...(parentEntryId === undefined ? {} : { nativeParentEntryId: parentEntryId }),
        projectionKind: item.kind,
        contentIndex: item.contentIndex,
        payload: item.payload,
        metadata
      });
    }
    parentEntryId = entry.uuid;
  }

  return {
    events,
    ...(parentEntryId === undefined ? {} : { activeEntryId: parentEntryId }),
    activeLineage: lineage,
    activeEntryMetadata: {
      namespace: "claude-code.native_history",
      fields: {
        nativeHydration: true,
        activeLeaf: true
      }
    }
  };
}

function validatedHistoryMessage(
  value: ClaudeSdkSessionMessage,
  nativeSessionId: string
): ValidatedHistoryMessage {
  const envelope = record(value);
  if (envelope === undefined) throw invalidNativeHistory();
  const type = stringValue(envelope["type"]);
  if (type !== "user" && type !== "assistant" && type !== "system") throw invalidNativeHistory();
  const uuid = stringValue(envelope["uuid"]);
  const sessionId = stringValue(envelope["session_id"]);
  if (uuid === undefined || sessionId === undefined || !uuidPattern().test(uuid)) throw invalidNativeHistory();
  if (!uuidPattern().test(sessionId) || sessionId.toLowerCase() !== nativeSessionId) throw continuityGap();
  const parentToolUseId = envelope["parent_tool_use_id"];
  const parentAgentId = envelope["parent_agent_id"];
  if (parentToolUseId !== null && typeof parentToolUseId !== "string") throw invalidNativeHistory();
  if (parentAgentId !== null && typeof parentAgentId !== "string") throw invalidNativeHistory();
  const child = typeof parentToolUseId === "string" || typeof parentAgentId === "string";
  const message = envelope["message"];
  if (type !== "system") {
    const nativeMessage = record(message);
    if (nativeMessage?.["role"] !== type) throw invalidNativeHistory();
    const content = nativeMessage["content"];
    if (type === "assistant" ? !Array.isArray(content) : typeof content !== "string" && !Array.isArray(content)) {
      throw invalidNativeHistory();
    }
  }
  return { type, uuid: uuid.toLowerCase(), message, child };
}

function projectHistoryEntry(
  entry: ValidatedHistoryMessage,
  projection: SafeProjection,
  toolNames: Map<string, string>
): readonly HistoryEntryProjection[] {
  if (entry.type === "system") {
    return [{
      kind: "system",
      contentIndex: 0,
      payload: {
        type: "status",
        key: "claude-code.history.system",
        text: "Native system event preserved."
      }
    }];
  }
  const envelope = { type: entry.type, uuid: entry.uuid, message: entry.message };
  if (entry.type === "assistant") {
    const assistant = projection.assistant(envelope);
    const projected: HistoryEntryProjection[] = [];
    for (let index = 0; index < assistant.blocks.length; index += 1) {
      const block = assistant.blocks[index];
      if (block?.kind === "text" && block.text.length > 0) {
        projected.push({
          kind: "message_assistant_text",
          contentIndex: index,
          payload: { type: "text_delta", blockId: entry.uuid, delta: block.text, contentIndex: index }
        });
      } else if (block?.kind === "thinking" && !block.redacted && block.text.length > 0) {
        projected.push({
          kind: "message_assistant_thinking",
          contentIndex: index,
          payload: { type: "thinking_delta", blockId: entry.uuid, delta: block.text, contentIndex: index }
        });
      } else if (block?.kind === "tool_call") {
        toolNames.set(block.callId, block.name);
        projected.push({
          kind: "message_assistant_tool_call",
          contentIndex: index,
          payload: { type: "tool_start", callId: block.callId, name: block.name, input: block.input }
        });
      }
    }
    projected.push({
      kind: "message_assistant",
      contentIndex: assistant.blocks.length,
      payload: { type: "message_complete", role: "assistant", blocks: assistant.blocks }
    });
    return projected;
  }

  const nativeMessage = record(entry.message)!;
  const user = projection.user(envelope);
  const blocks = projectedUserBlocks(nativeMessage["content"], projection);
  const projected: HistoryEntryProjection[] = user.toolResults.map((result, index) => ({
    kind: "tool_result",
    contentIndex: index,
    payload: {
      type: "tool_result",
      callId: result.callId,
      name: toolNames.get(result.callId) ?? "Tool",
      output: result.output,
      isError: result.isError
    }
  }));
  if (blocks.length > 0) {
    projected.push({
      kind: "message_user",
      contentIndex: projected.length,
      payload: { type: "message_complete", role: "user", blocks }
    });
  }
  return projected;
}

function projectedUserBlocks(content: unknown, projection: SafeProjection): readonly MessageBlock[] {
  if (typeof content === "string") {
    const text = projection.text(content);
    return text.length === 0 ? [] : [{ kind: "text", text }];
  }
  if (!Array.isArray(content)) throw invalidNativeHistory();
  const blocks: MessageBlock[] = [];
  for (const rawBlock of content) {
    const block = record(rawBlock);
    const type = stringValue(block?.["type"]);
    if (type === "text") {
      const text = projection.text(block?.["text"]);
      if (text.length > 0) blocks.push({ kind: "text", text });
    } else if (type === "image" || type === "document") {
      blocks.push({ kind: "text", text: `[Native ${type} content withheld.]` });
    }
  }
  return blocks;
}

function capabilityManifest(
  installed: boolean,
  isolatedReviewSupported: boolean,
  nativeTasksSupported: boolean,
  models: readonly ClaudeSdkModelInfo[],
  hostCapabilities: ReadonlySet<HostComposedCapability>,
  supportsLogin: boolean,
  supportsLogout: boolean
): ReadonlyMap<string, Capability> {
  const supported = new Set<string>([
    "session.resume",
    "session.detach",
    "session.discovery",
    "session.catalog",
    "turn.stream",
    "turn.abort",
    "input.text",
    "model.list",
    "model.switch",
    "provider.refresh",
    "provider.model_refresh",
    "permission.modes",
    "permission.change",
    "plan_mode",
    "context.usage",
    "workspace.extra_dirs",
    "interaction.permission",
    "interaction.question",
    "interaction.plan_review"
  ]);
  if (isolatedReviewSupported) supported.add("review.isolated");
  if (nativeTasksSupported) {
    for (const capability of [
      "background.tasks",
      "background.tasks.cancel",
      "subagents.list",
      "subagents.detail",
      "subagents.transcript",
      "subagents.stop"
    ]) supported.add(capability);
  }
  if (supportsLogin) supported.add("provider.login");
  if (supportsLogout) supported.add("provider.logout");
  if (models.some((model) => model.supportsEffort === true)) supported.add("model.effort");
  for (const capability of hostCapabilities) supported.add(capability);
  return new Map(CAPABILITIES.map((key): [string, Capability] => {
    const implemented = supported.has(key);
    const available = key === "session.catalog" || (installed && implemented);
    const options = key === "provider.login" && supportsLogin
      ? ["oauth_browser"]
      : key === "permission.modes"
      ? ["ask", "auto", "bypassPermissions"]
      : key === "workspace.extra_dirs"
        ? ["read_write"]
        : undefined;
    return [key, {
      key,
      supported: available,
      ...(!available && !installed ? { reason: "upstream_missing" as const }
        : key === "review.isolated" && !isolatedReviewSupported ? { reason: "upstream_missing" as const }
        : (key === "background.tasks"
          || key === "background.tasks.cancel"
          || key.startsWith("subagents.")) && !nativeTasksSupported
          ? { reason: "upstream_missing" as const }
        : !available && !implemented ? { reason: "not_implemented" as const }
          : {}),
      ...(options === undefined ? {} : { options })
    }];
  }));
}

function nativeState(runtime: NativeRuntime): NativeSessionState {
  return {
    binding: runtime.binding,
    streaming: runtime.activeTurn !== undefined,
    compacting: false,
    pendingMessages: 0,
    providerId: PROVIDER_ID,
    ...(runtime.modelId === undefined ? {} : { modelId: runtime.modelId }),
    ...(runtime.effort === undefined ? {} : { effort: runtime.effort }),
    fastMode: false,
    permissionMode: runtime.permissionMode,
    planMode: runtime.planMode,
    ...(runtime.lastUsage === undefined ? {} : { usage: runtime.lastUsage })
  };
}

function bindingFor(nativeSessionId: string, generation: number): NativeSessionBinding {
  return {
    opaqueRef: `${OPAQUE_REFERENCE_PREFIX}${nativeSessionId}`,
    nativeSessionId,
    generation
  };
}

function parseBinding(binding: NativeSessionBinding): string {
  const nativeSessionId = parseNativeSessionReference(binding.opaqueRef);
  if (binding.nativeSessionId !== undefined && binding.nativeSessionId !== nativeSessionId) throw continuityGap();
  return nativeSessionId;
}

function parseNativeSessionReference(reference: string): string {
  const value = reference.startsWith(OPAQUE_REFERENCE_PREFIX)
    ? reference.slice(OPAQUE_REFERENCE_PREFIX.length)
    : reference;
  if (!uuidPattern().test(value)) throw continuityGap();
  return value.toLowerCase();
}

function parseCatalogNativeReference(reference: string): string {
  if (!reference.startsWith(OPAQUE_REFERENCE_PREFIX)) throw catalogSourceChanged();
  const nativeSessionId = reference.slice(OPAQUE_REFERENCE_PREFIX.length);
  if (!uuidPattern().test(nativeSessionId)) throw catalogSourceChanged();
  return nativeSessionId.toLocaleLowerCase("en-US");
}

function catalogEntryMatches(entry: NativeSessionCatalogEntry, expected: NativeSessionCatalogEntry): boolean {
  return entry.nativeReference === expected.nativeReference
    && entry.nativeSessionId === expected.nativeSessionId
    && entry.title === expected.title
    && entry.workingDirectory === expected.workingDirectory
    && entry.projectDirectory === expected.projectDirectory
    && entry.createdAt === expected.createdAt
    && entry.modifiedAt === expected.modifiedAt
    && entry.archived === expected.archived
    && entry.placement === expected.placement
    && entry.existingMatch === expected.existingMatch;
}

function catalogSourceChanged(): JokoError {
  return claudeCodeError(
    "CATALOG_SOURCE_CHANGED",
    "The selected local task changed after it was scanned.",
    "session_resume",
    {
      retryable: true,
      stateMayHaveChanged: false,
      recovery: "Scan local tasks again and retry the import."
    }
  );
}

function normalizeNativeSessionId(value: string): string {
  if (!uuidPattern().test(value)) throw continuityGap();
  return value.toLowerCase();
}

function uuidPattern(): RegExp {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
}

function continuityGap(): JokoError {
  return claudeCodeError(
    "NATIVE_SESSION_CONTINUITY_GAP",
    "The native Session cannot be proven at the requested resume point.",
    "session_resume",
    {
      retryable: false,
      stateMayHaveChanged: false,
      recovery: "Keep the product Session blocked and choose an explicit recovery action."
    }
  );
}

function invalidNativeHistory(): JokoError {
  return claudeCodeError(
    "NATIVE_HISTORY_INVALID",
    "The native Session history failed identity or structure validation.",
    "session_history",
    {
      stateMayHaveChanged: false,
      recovery: "Keep native history synchronization blocked and inspect the native Session."
    }
  );
}

function turnOwnershipGap(): JokoError {
  return claudeCodeError(
    "NATIVE_TURN_OWNERSHIP_GAP",
    "The native Result cannot be attributed to the active human turn.",
    "turn",
    {
      stateMayHaveChanged: true,
      recovery: "Keep the Session blocked and inspect native history before retrying."
    }
  );
}

function nativeEventLimit(): JokoError {
  return claudeCodeError(
    "NATIVE_EVENT_LIMIT_EXCEEDED",
    "The native runtime exceeded an Adapter event or buffer limit.",
    "turn",
    {
      stateMayHaveChanged: true,
      recovery: "Inspect the native Session and retry with a smaller turn."
    }
  );
}

function turnAbortUnknown(message: string): () => JokoError {
  return () => claudeCodeError("TURN_ABORT_UNKNOWN", message, "abort", {
    retryable: true,
    stateMayHaveChanged: true,
    recovery: "The native runtime was retired; inspect the native Session before resuming."
  });
}

function dispatchError(message: string, stateMayHaveChanged: boolean): JokoError {
  return claudeCodeError("NATIVE_DISPATCH_UNKNOWN", message, "dispatch", {
    retryable: true,
    stateMayHaveChanged,
    recovery: stateMayHaveChanged
      ? "Inspect the native Session before retrying."
      : "Retry the durable queue item."
  });
}

function assertResultOwnership(
  envelope: Readonly<Record<string, unknown>>,
  turn: ActiveTurn
): void {
  const origin = record(envelope["origin"]);
  const originKind = stringValue(origin?.["kind"]);
  const userMessageUuid = stringValue(envelope["user_message_uuid"]);
  const subtype = stringValue(envelope["subtype"]);
  if (turn.nativeContinuationSegment) {
    if (originKind !== undefined && originKind !== "human") throw turnOwnershipGap();
    if (userMessageUuid !== undefined && (!uuidPattern().test(userMessageUuid)
      || userMessageUuid.toLowerCase() !== turn.userMessageUuid)) throw turnOwnershipGap();
    return;
  }
  if (originKind !== "human") throw turnOwnershipGap();
  if (subtype === "success") {
    if (userMessageUuid === undefined || !uuidPattern().test(userMessageUuid)
      || userMessageUuid.toLowerCase() !== turn.userMessageUuid) throw turnOwnershipGap();
    return;
  }
  if (userMessageUuid !== undefined && (!uuidPattern().test(userMessageUuid)
    || userMessageUuid.toLowerCase() !== turn.userMessageUuid)) throw turnOwnershipGap();
}

function addBoundedIdentity(set: Set<string>, value: string): void {
  if (set.has(value)) return;
  if (set.size >= MAX_TURN_IDENTITIES) throw nativeEventLimit();
  set.add(value);
}

function appendTurnBlocks(turn: ActiveTurn, blocks: readonly MessageBlock[]): void {
  if (turn.blocks.length + blocks.length > MAX_TURN_BLOCKS) throw nativeEventLimit();
  let additionalCharacters = 0;
  for (const block of blocks) additionalCharacters += messageBlockCharacters(block);
  if (turn.projectedCharacters + additionalCharacters > MAX_TURN_PROJECTED_CHARACTERS) {
    throw nativeEventLimit();
  }
  turn.projectedCharacters += additionalCharacters;
  turn.blocks.push(...blocks);
}

function messageBlockCharacters(block: MessageBlock): number {
  if (block.kind === "text" || block.kind === "thinking") return block.text.length;
  if (block.kind === "tool_call") return block.callId.length + block.name.length + block.input.length;
  if (block.kind === "tool_result") return block.callId.length + block.output.length;
  if (block.kind === "artifact") return block.label.length + block.blob.sha256.length;
  return (block.alt?.length ?? 0) + block.blob.sha256.length;
}

function nativeSessionCandidate(
  info: ClaudeSdkSessionInfo,
  target: TargetDescriptor,
  projection: SafeProjection
): NativeSessionCandidate | undefined {
  try {
    const nativeSessionId = normalizeNativeSessionId(info.sessionId);
    assertSessionTarget(info.cwd, target.workspaceRoot);
    if (!Number.isSafeInteger(info.lastModified) || info.lastModified < 0) return undefined;
    const name = projection.text(info.customTitle ?? info.summary, 512).trim();
    return {
      nativeReference: `${OPAQUE_REFERENCE_PREFIX}${nativeSessionId}`,
      nativeSessionId,
      ...(name.length === 0 ? {} : { name }),
      workspaceRoot: info.cwd,
      messageCount: 0,
      modifiedAt: info.lastModified,
      state: "ready"
    };
  } catch {
    return undefined;
  }
}

function validatePrompt(input: PromptInput): void {
  if (input.disposition !== "prompt") {
    throw claudeCodeError("BACKEND_CAPABILITY_UNAVAILABLE", "This Adapter does not support steering or follow-up queues.", "dispatch", {
      recovery: "Wait for the current Result, then send a normal prompt."
    });
  }
  if (input.images.length > 0 || input.files.length > 0 || input.mentions.length > 0) {
    throw claudeCodeError("INPUT_KIND_UNSUPPORTED", "This Adapter currently accepts text-only prompts.", "input", {
      recovery: "Remove binary, file, and mention inputs before retrying."
    });
  }
  if (input.text.length === 0) {
    throw claudeCodeError("PROMPT_EMPTY", "The prompt text is empty.", "input", {
      recovery: "Enter prompt text before sending."
    });
  }
  if (Buffer.byteLength(input.text, "utf8") > MAX_PROMPT_BYTES) {
    throw claudeCodeError("PROMPT_TOO_LARGE", "The prompt exceeds the native input limit.", "input", {
      recovery: "Reduce the prompt below 1 MiB before retrying."
    });
  }
}

async function validateCanonicalDirectory(path: string, label: string): Promise<void> {
  if (!isAbsolute(path)) {
    throw claudeCodeError("DIRECTORY_NOT_ABSOLUTE", `${label} must be an absolute path.`, "target", {
      recovery: "Use an absolute, canonical directory path."
    });
  }
  const normalized = normalize(path);
  const resolved = resolve(path);
  if (canonicalPathKey(normalized) !== canonicalPathKey(resolved)) {
    throw claudeCodeError("DIRECTORY_PATH_ALIAS", `${label} contains a non-canonical path alias.`, "target", {
      recovery: "Resolve dot segments before registering the directory."
    });
  }
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw claudeCodeError("DIRECTORY_TYPE_INVALID", `${label} must be a regular directory without symbolic links.`, "target", {
        recovery: "Choose a regular canonical directory."
      });
    }
    const canonical = await realpath(path);
    if (canonicalPathKey(canonical) !== canonicalPathKey(resolved)) {
      throw claudeCodeError("DIRECTORY_PATH_ALIAS", `${label} resolves through an alias or junction.`, "target", {
        recovery: "Register the final canonical directory instead."
      });
    }
  } catch (error) {
    if (error instanceof JokoError) throw error;
    throw claudeCodeError("DIRECTORY_UNAVAILABLE", `${label} is not an accessible directory.`, "target", {
      recovery: "Create or select an accessible regular directory."
    });
  }
}

function assertSameTarget(left: TargetDescriptor, right: TargetDescriptor): void {
  if (left.id !== right.id
    || left.backendId !== right.backendId
    || left.managed !== right.managed
    || left.trusted !== right.trusted
    || canonicalPathKey(left.workspaceRoot) !== canonicalPathKey(right.workspaceRoot)) {
    throw claudeCodeError("TARGET_CONTEXT_MISMATCH", "The creation input and Adapter context identify different Targets.", "target", {
      recovery: "Refresh the Target and retry Session creation."
    });
  }
}

function assertSessionInfo(
  info: ClaudeSdkSessionInfo,
  expectedSessionId: string,
  expectedCwd: string
): void {
  if (normalizeNativeSessionId(info.sessionId) !== expectedSessionId) throw continuityGap();
  assertSessionTarget(info.cwd, expectedCwd);
}

function assertSessionTarget(observedCwd: string | undefined, expectedCwd: string): void {
  if (observedCwd === undefined || !isAbsolute(observedCwd)
    || canonicalPathKey(observedCwd) !== canonicalPathKey(expectedCwd)) throw continuityGap();
}

function assertFullAccessTarget(mode: PermissionMode, target: TargetDescriptor, phase: string): void {
  if (mode !== "bypassPermissions" || target.trusted) return;
  throw claudeCodeError(
    "CLAUDE_CODE_FULL_ACCESS_REQUIRES_TRUST",
    "Full access requires a trusted Target.",
    phase,
    { recovery: "Use ask mode or explicitly trust the Target through the product policy flow." }
  );
}

function canonicalPathKey(path: string): string {
  const value = normalize(resolve(path));
  return process.platform === "win32" ? value.toLocaleLowerCase("en-US") : value;
}

function toSdkPermissionMode(mode: PermissionMode): ClaudeSdkPermissionMode {
  if (mode === "ask") return "default";
  if (mode === "auto") return "auto";
  return "bypassPermissions";
}

function observePermissionMode(runtime: NativeRuntime, mode: string | undefined): void {
  if (mode === "plan") {
    runtime.planMode = true;
    return;
  }
  if (mode === "default") runtime.permissionMode = "ask";
  else if (mode === "auto") runtime.permissionMode = "auto";
  else if (mode === "bypassPermissions") runtime.permissionMode = "bypassPermissions";
  else {
    throw claudeCodeError(
      "NATIVE_PERMISSION_MODE_UNSUPPORTED",
      "The native runtime reported a permission mode this Adapter cannot represent safely.",
      "permission",
      {
        stateMayHaveChanged: true,
        recovery: "Keep the Session blocked until this permission mode is explicitly supported."
      }
    );
  }
  runtime.planMode = false;
}

function normalizeEffort(value: string | undefined): typeof EFFORT_LEVELS[number] | undefined {
  if (value === undefined) return undefined;
  return EFFORT_LEVELS.includes(value as typeof EFFORT_LEVELS[number])
    ? value as typeof EFFORT_LEVELS[number]
    : undefined;
}

function findModel(models: readonly ClaudeSdkModelInfo[], modelId: string): ClaudeSdkModelInfo | undefined {
  return models.find((model) => model.value === modelId || model.resolvedModel === modelId);
}

function assertEffortSupported(runtime: NativeRuntime, effort: typeof EFFORT_LEVELS[number]): void {
  const model = runtime.modelId === undefined
    ? undefined
    : findModel(runtime.initialization?.models ?? [], runtime.modelId);
  if (model?.supportsEffort === false
    || (model?.supportedEffortLevels !== undefined && !model.supportedEffortLevels.includes(effort))) {
    throw claudeCodeError("EFFORT_UNAVAILABLE", "The active model does not support the requested effort level.", "model", {
      recovery: "Choose an effort level advertised for the active model."
    });
  }
}

function operationUuid(operationId: string): string {
  const digest = createHash("sha256").update("joko-claude-operation\0").update(operationId).digest("hex");
  const variant = ((Number.parseInt(digest[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function interactionId(runtime: NativeRuntime, requestId: string): string {
  return `claude-interaction-${createHash("sha256")
    .update(String(runtime.queryGeneration))
    .update("\0")
    .update(requestId)
    .digest("hex")
    .slice(0, 24)}`;
}

function permissionFingerprint(toolName: string, input: Readonly<Record<string, unknown>>, toolUseId: string): string {
  const hash = createHash("sha256").update(toolName).update("\0").update(toolUseId).update("\0");
  hashPermissionValue(hash, input, { nodes: 0, bytes: 0 }, new WeakSet(), 0);
  return hash.digest("hex");
}

function hashPermissionValue(
  hash: ReturnType<typeof createHash>,
  value: unknown,
  budget: { nodes: number; bytes: number },
  seen: WeakSet<object>,
  depth: number
): void {
  budget.nodes += 1;
  if (budget.nodes > 8_192 || depth > 64) throw new ProjectionLimitError("Permission input is too complex.");
  if (value === null) return fingerprintChunk(hash, "null", budget);
  if (typeof value === "string") return fingerprintChunk(hash, `s:${value}`, budget);
  if (typeof value === "number") {
    return fingerprintChunk(hash, Number.isFinite(value) ? `n:${String(value)}` : "n:null", budget);
  }
  if (typeof value === "boolean") return fingerprintChunk(hash, value ? "b:1" : "b:0", budget);
  if (typeof value !== "object") throw new ProjectionLimitError("Permission input is not JSON-compatible.");
  if (seen.has(value)) throw new ProjectionLimitError("Permission input is cyclic.");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > 4_096) throw new ProjectionLimitError("Permission input array is too large.");
      fingerprintChunk(hash, "[", budget);
      for (const item of value) hashPermissionValue(hash, item, budget, seen, depth + 1);
      fingerprintChunk(hash, "]", budget);
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ProjectionLimitError("Permission input contains a non-plain object.");
    }
    fingerprintChunk(hash, "{", budget);
    let properties = 0;
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      properties += 1;
      if (properties > 4_096) throw new ProjectionLimitError("Permission input object is too large.");
      fingerprintChunk(hash, `k:${key}`, budget);
      hashPermissionValue(hash, (value as Readonly<Record<string, unknown>>)[key], budget, seen, depth + 1);
    }
    fingerprintChunk(hash, "}", budget);
  } finally {
    seen.delete(value);
  }
}

function fingerprintChunk(
  hash: ReturnType<typeof createHash>,
  value: string,
  budget: { bytes: number }
): void {
  budget.bytes += Buffer.byteLength(value, "utf8");
  if (budget.bytes > 256 * 1024) throw new ProjectionLimitError("Permission input is too large.");
  hash.update(value).update("\0");
}

function permissionSummary(
  toolName: string,
  input: Readonly<Record<string, unknown>>,
  options: ClaudeCanUseToolOptions,
  projection: SafeProjection
): string {
  const described = projection.text(options.description, 2048);
  if (described.length > 0) return described;
  if (shellTool(toolName)) {
    const command = projection.text(input["command"], 2048);
    return command.length === 0 ? "Run a workspace command." : `Run command: ${command}`;
  }
  if (fileMutationTool(toolName)) {
    const path = projection.text(input["file_path"] ?? input["path"] ?? options.blockedPath, 2048);
    return path.length === 0 ? "Modify a workspace file." : `Modify file: ${path}`;
  }
  const titled = projection.text(options.displayName, 512);
  return titled.length === 0 ? `Use ${projection.identifier(toolName, "a tool")}.` : titled;
}

function permissionRisk(toolName: string): "low" | "medium" | "high" {
  if (shellTool(toolName)) return "high";
  if (fileMutationTool(toolName)) return "medium";
  return "low";
}

function shellTool(toolName: string): boolean {
  return /^(Bash|Shell|Terminal|Execute|RunCommand)$/i.test(toolName);
}

function fileMutationTool(toolName: string): boolean {
  return /^(Write|Edit|MultiEdit|NotebookEdit|CreateFile|DeleteFile|MoveFile)$/i.test(toolName);
}

function permissionSelection(decision: InteractionDecision): "allow_once" | "allow_for_session" | "deny" {
  if (decision.kind === "selected") {
    return decision.value === "allow_once" || decision.value === "allow_for_session"
      ? decision.value
      : "deny";
  }
  if (decision.kind === "confirmed") return decision.confirmed ? "allow_once" : "deny";
  return "deny";
}

function safePermissionUpdates(
  updates: readonly ClaudePermissionUpdate[],
  targetTrusted: boolean
): ClaudePermissionUpdate[] {
  const safe: ClaudePermissionUpdate[] = [];
  for (const update of updates) {
    if (update.destination !== "session" && update.destination !== "cliArg") continue;
    if (update.type === "setMode") {
      if (update.mode !== "default" && update.mode !== "auto" && update.mode !== "bypassPermissions") continue;
      if (update.mode === "bypassPermissions" && !targetTrusted) continue;
      safe.push({ type: "setMode", mode: update.mode, destination: update.destination });
      continue;
    }
    if (update.type !== "addRules" && update.type !== "replaceRules" && update.type !== "removeRules") continue;
    if (!Array.isArray(update.rules) || update.rules.length > MAX_PERMISSION_RULES
      || (update.behavior !== "allow" && update.behavior !== "deny" && update.behavior !== "ask")) continue;
    const rules = update.rules.flatMap((rule) => {
      if (typeof rule?.toolName !== "string" || rule.toolName.length === 0 || rule.toolName.length > 512
        || (rule.ruleContent !== undefined
          && (typeof rule.ruleContent !== "string" || rule.ruleContent.length > MAX_PERMISSION_RULE_CONTENT))) return [];
      return [{
        toolName: rule.toolName,
        ...(rule.ruleContent === undefined ? {} : { ruleContent: rule.ruleContent })
      }];
    });
    if (rules.length !== update.rules.length) continue;
    safe.push({
      type: update.type,
      rules,
      behavior: update.behavior,
      destination: update.destination
    });
  }
  return safe;
}

function authenticationStateFor(
  account: ClaudeSdkAccountInfo,
  observedApiKeySource?: string
): BackendAuthenticationState {
  if (account.apiProvider !== undefined && account.apiProvider !== "firstParty") return "not_required";
  if (typeof account.email === "string" && account.email.trim().length > 0) return "authenticated";
  if (typeof account.subscriptionType === "string" && account.subscriptionType.trim().length > 0) {
    return "authenticated";
  }
  return [observedApiKeySource, account.tokenSource, account.apiKeySource].some(credentialSourceIsActive)
    ? "authenticated"
    : "signed_out";
}

function credentialSourceIsActive(value: string | undefined): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && normalized !== "none" && normalized !== "unknown";
}

function emptyUsage(): UsageSnapshot {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    cost: 0
  };
}

function nonNegativeFinite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function boundedNativeTaskControlId(value: string, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!/^claude-task-[a-f0-9]{32}$/u.test(normalized)) {
    throw claudeCodeError(
      "CLAUDE_CODE_NATIVE_TASK_ID_INVALID",
      `${label} is invalid.`,
      "background_task",
      { recovery: "Reload the current Session's task list and retry." }
    );
  }
  return normalized;
}

function nativeTaskControlUnavailable(): JokoError {
  return claudeCodeError(
    "CLAUDE_CODE_NATIVE_TASK_CONTROL_UNAVAILABLE",
    "The exact native runtime does not provide delegated-task control.",
    "background_task",
    { recovery: "Refresh the Backend descriptor and use only advertised task controls." }
  );
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function positiveBound(value: number | undefined, fallback: number, maximum: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 && value <= maximum
    ? value
    : fallback;
}

async function waitFor<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
  timeoutError: () => unknown
): Promise<T> {
  if (signal.aborted) throw signal.reason ?? new Error("The operation was aborted.");
  return new Promise<T>((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => rejectPromise(signal.reason ?? new Error("The operation was aborted.")));
    const timer = setTimeout(() => finish(() => rejectPromise(timeoutError())), timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolvePromise(value)),
      (error) => finish(() => rejectPromise(error))
    );
  });
}

async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return undefined;
  return new Promise<T | undefined>((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => resolvePromise(undefined));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolvePromise(value)),
      (error) => finish(() => rejectPromise(error))
    );
  });
}

async function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  await Promise.race([
    promise.then(() => undefined, () => undefined),
    new Promise<void>((resolvePromise) => setTimeout(resolvePromise, timeoutMs))
  ]);
}

function trimMap<Key, Value>(map: Map<Key, Value>, maximum: number): void {
  while (map.size > maximum) {
    const first = map.keys().next();
    if (first.done) return;
    map.delete(first.value);
  }
}
