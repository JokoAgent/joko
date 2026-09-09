import type { Dirent, Stats } from "node:fs";
import { mkdtemp, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import {
  CAPABILITIES,
  CapabilityDrivenBackendAdapter,
  HOST_COMPOSED_CAPABILITIES,
  JokoError,
  type AdapterContext,
  type BackendDescriptor,
  type Capability,
  type CreateNativeSessionInput,
  type HostComposedCapability,
  type KnownCapability,
  type ManagedProviderRuntimePort,
  type ManagedProviderRouteBinding,
  type ManagedProviderOperationLease,
  type ProviderRuntimeSupport,
  type NativeSessionBinding,
  type NativeSessionDerivation,
  type NativeSessionCandidate,
  type NativeSessionCatalogEntry,
  type NativeSessionCatalogResult,
  type NativeSessionForkResult,
  type NativeSessionNavigation,
  type NativeSessionNavigationResult,
  type NativeHistoryProjection,
  type NativeNavigationTarget,
  type NativeSessionState,
  type PermissionMode,
  type PromptInput,
  type ProviderModel,
  type TargetDescriptor
} from "@joko/core";
import { AppServerHost, type AppServerHostOptions, type HostSubscription } from "./host.js";
import { adapterError, isAmbiguousDispatchFailure, RpcRemoteFault, TransportFault } from "./errors.js";
import {
  isJsonObject,
  objectValue,
  optionalString,
  parseAccountRateLimits,
  parseFullTurnPage,
  parseModels,
  parseThreadList,
  parseThreadResult,
  parseTurnList,
  parseTurnStart,
  parseTurnSteer,
  ProtocolShapeError,
  stringValue,
  type JsonObject,
  type JsonValue,
  type NativeAccountUsageSnapshot,
  type NativeModel,
  type NativeThread,
  type NativeTurn
} from "./protocol.js";
import { projectCodexNativeHistory } from "./native-history.js";
import {
  materializeCodexCatalogSession,
  validateCodexCatalogSource
} from "./session-materialization.js";
import {
  codexProfileKey,
  scanCodexSessionCatalog,
  type CodexCatalogSource
} from "./session-catalog.js";
import { CODEX_MODEL_ESTIMATES_UPDATED_AT, codexModelEstimate } from "./model-estimates.js";
import {
  CodexNativeTaskProjection,
  type CodexNativeTaskEffects
} from "./native-task-projection.js";
import {
  CodexEventTranslator,
  createTranslatorState,
  interactionFromServerRequest,
  translatePromptInput,
  type CodexInputResolvers,
  type TranslatorState
} from "./translator.js";

export interface CodexAdapterOptions extends CodexInputResolvers {
  readonly managedProviders?: ManagedProviderRuntimePort;
  readonly id?: string;
  readonly instanceGeneration: number;
  readonly providerId?: string;
  readonly host?: AppServerHost;
  readonly appServer?: AppServerHostOptions;
  readonly maximumModels?: number;
  readonly maximumDiscoveredThreads?: number;
  readonly maximumCatalogEntries?: number;
  readonly maximumPaginationPages?: number;
  readonly maximumHistoryTurns?: number;
  readonly maximumHistoryItems?: number;
  readonly maximumHistoryBytes?: number;
  readonly maximumHistoryEvents?: number;
  readonly maximumHistoryPages?: number;
  readonly historyReadTimeoutMs?: number;
  readonly now?: () => number;
  /** Product Host capabilities that do not require Adapter runtime integration. */
  readonly hostCapabilities?: readonly HostComposedCapability[];
  readonly compactionTimeoutMs?: number;
  /** Profile directory that owns native task placement metadata. */
  readonly profileDirectory?: string;
  /** Exact profile roots used by the read-only local task catalog. */
  readonly catalogProfileDirectories?: readonly string[];
}

export const CODEX_MANAGED_PROVIDER_SUPPORT: ProviderRuntimeSupport = Object.freeze<ProviderRuntimeSupport>({
  protocols: ["openai-responses"],
  fields: ["request_path", "models_endpoint", "headers", "keyless", "model_costs", "model_input_modalities", "model_fast_mode"]
});

export interface CodexAccountSnapshot {
  readonly authenticated: boolean;
  readonly requiresAuthentication: boolean;
  readonly authenticationState: BackendDescriptor["authenticationState"];
  readonly supportsLogin: boolean;
  readonly supportsLogout: boolean;
  readonly loginMethods: readonly ["api_key", "oauth_browser", "device_code"];
  readonly authMode?: string;
}

export interface CodexAccountUsageSnapshot extends NativeAccountUsageSnapshot {
  readonly providerId: string;
}

export type CodexLoginInput =
  | { readonly method: "api_key"; readonly apiKey: string }
  | { readonly method: "oauth_browser" }
  | { readonly method: "device_code" };

export type CodexLoginResult =
  | { readonly method: "api_key" }
  | { readonly method: "oauth_browser"; readonly loginId: string; readonly url: string }
  | { readonly method: "device_code"; readonly loginId: string; readonly url: string; readonly userCode: string };

/** Adapter-local port that callers can capability-detect without branching on a Backend ID. */
export interface CodexNativeAccountOperations {
  readAccount(refreshToken?: boolean): Promise<CodexAccountSnapshot>;
  readAccountUsage(providerId: string, signal?: AbortSignal): Promise<CodexAccountUsageSnapshot>;
  listModels(): Promise<readonly ProviderModel[]>;
  beginLogin(input: CodexLoginInput): Promise<CodexLoginResult>;
  cancelLogin(loginId: string): Promise<void>;
  logout(): Promise<void>;
}

interface SessionRuntime {
  managedRoute: ManagedProviderRouteBinding | undefined;
  managedOperation: { readonly id: string; lease?: ManagedProviderOperationLease } | undefined;
  routeUnknown: boolean;
  readonly sessionId: string;
  readonly threadId: string;
  readonly targetId: string;
  readonly targetWorkspaceRoot: string;
  readonly binding: NativeSessionBinding;
  readonly sessionGeneration: number;
  readonly backendInstanceGeneration: number;
  readonly dispatchLifetime: AbortController;
  context: AdapterContext;
  hostGeneration: number;
  subscription?: HostSubscription;
  subscriptionFlight?: Promise<HostSubscription>;
  state: TranslatorState;
  readonly pendingServerRequests: Map<string, PendingServerRequest>;
  readonly nativeTasks: CodexNativeTaskProjection;
  providerId?: string;
  modelId?: string;
  effort?: string;
  fastMode: boolean;
  name?: string;
  permissionMode: PermissionMode;
  planMode: boolean;
  collaborationTouched: boolean;
  defaultCollaborationMarkerPending: boolean;
  readonly runtimePolicy: "standard" | "review_read_only";
  readonly reviewWorkingDirectory?: string;
  closed: boolean;
  disconnectTerminalEmitted: boolean;
  compaction?: CompactionWaiter;
  rewindUnknown: boolean;
}

interface PendingServerRequest {
  readonly threadId: string;
  readonly turnId: string;
  readonly cancel: () => void;
  cancelled: boolean;
}

interface CompactionWaiter {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  readonly timer: NodeJS.Timeout;
}

const NATIVE_REFERENCE_PREFIX = "codex-thread:";
const NATIVE_REFERENCE_VERSION = 1;
const AUDITED_APP_SERVER_VERSION = "0.153.4";
const REVIEW_PERMISSION_PROFILE = "joko-review-readonly";
const REVIEW_MAXIMUM_INVENTORY_ITEMS = 4_096;
const REVIEW_MAXIMUM_INVENTORY_PAGES = 100;
const REVIEW_MAXIMUM_READ_BYTES = 512 * 1024;
const REVIEW_MAXIMUM_OUTPUT_BYTES = 64 * 1024;
const REVIEW_MAXIMUM_WALK_ENTRIES = 5_000;
const REVIEW_MAXIMUM_GREP_FILES = 2_000;
const REVIEW_MAXIMUM_GREP_BYTES = 16 * 1024 * 1024;
const REVIEW_MAXIMUM_RESULTS = 500;
const REVIEW_DYNAMIC_TOOL_NAMES = new Set(["joko_read", "joko_grep", "joko_find", "joko_ls"]);
const REVIEW_DISABLED_FEATURES = [
  "apps",
  "artifact",
  "auth_elicitation",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "chronicle",
  "code_mode",
  "code_mode_host",
  "code_mode_only",
  "computer_use",
  "default_mode_request_user_input",
  "deferred_executor",
  "enable_mcp_apps",
  "executor_capability_discovery",
  "external_agent_memory_import",
  "fast_mode",
  "goals",
  "hooks",
  "image_generation",
  "in_app_browser",
  "in_app_chat",
  "in_app_dictation",
  "in_app_local_automation",
  "in_app_updates",
  "memories",
  "multi_agent",
  "multi_agent_v2",
  "network_proxy",
  "plugin_sharing",
  "plugins",
  "prevent_idle_sleep",
  "realtime_conversation",
  "recommended_plugins",
  "remote_plugin",
  "request_permissions_tool",
  "shell_snapshot",
  "shell_tool",
  "skill_mcp_dependency_install",
  "skill_search",
  "sleep_tool",
  "standalone_web_search",
  "tool_call_mcp_elicitation",
  "tool_suggest",
  "unified_exec",
  "view_image",
  "web_search_cached",
  "web_search_request",
  "workspace_dependencies"
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

export class CodexBackendAdapter extends CapabilityDrivenBackendAdapter implements CodexNativeAccountOperations {
  readonly id: string;
  readonly #instanceGeneration: number;
  readonly #providerId: string;
  readonly #host: AppServerHost;
  readonly #ownsHost: boolean;
  readonly #resolvers: CodexInputResolvers;
  readonly #translator = new CodexEventTranslator();
  readonly #maximumModels: number;
  readonly #maximumDiscoveredThreads: number;
  readonly #maximumCatalogEntries: number;
  readonly #maximumPaginationPages: number;
  readonly #maximumHistoryTurns: number;
  readonly #maximumHistoryItems: number;
  readonly #maximumHistoryBytes: number;
  readonly #maximumHistoryEvents: number;
  readonly #maximumHistoryPages: number;
  readonly #historyReadTimeoutMs: number;
  readonly #now: () => number;
  readonly #hostCapabilities: ReadonlySet<HostComposedCapability>;
  readonly #compactionTimeoutMs: number;
  readonly #profileDirectory: string;
  readonly #activeProfileKey: Promise<string>;
  readonly #catalogProfileDirectories: readonly string[] | undefined;
  readonly #catalogSources = new Map<string, CodexCatalogSource>();
  readonly #catalogEntrySources = new WeakMap<NativeSessionCatalogEntry, CodexCatalogSource>();
  #catalogMaterializationTail: Promise<void> = Promise.resolve();
  readonly #sessions = new Map<string, SessionRuntime>();
  readonly #sessionMutations = new Map<string, { count: number; rewinding: boolean }>();
  #models: readonly ProviderModel[] = [];
  readonly #managedProviders: ManagedProviderRuntimePort | undefined;
  #account: CodexAccountSnapshot | undefined;
  #disposed = false;
  #disposeFlight: Promise<void> | undefined;
  #forceDisposeFlight: Promise<void> | undefined;

  constructor(options: CodexAdapterOptions) {
    super();
    this.id = options.id ?? "codex";
    this.#instanceGeneration = options.instanceGeneration;
    this.#providerId = options.providerId ?? "openai";
    this.#managedProviders = options.managedProviders;
    this.#host = options.host ?? new AppServerHost({
      ...options.appServer,
      transport: {
        ...options.appServer?.transport,
        ...(options.managedProviders === undefined ? {} : { managedEnvironment: options.managedProviders.environment })
      }
    });
    this.#ownsHost = options.host === undefined;
    this.#resolvers = {
      ...(options.readBlob === undefined ? {} : { readBlob: options.readBlob }),
      ...(options.resolveFile === undefined ? {} : { resolveFile: options.resolveFile }),
      ...(options.maximumBlobBytes === undefined ? {} : { maximumBlobBytes: options.maximumBlobBytes }),
      ...(options.maximumAggregateBlobBytes === undefined ? {} : { maximumAggregateBlobBytes: options.maximumAggregateBlobBytes }),
      ...(options.maximumPromptTextBytes === undefined ? {} : { maximumPromptTextBytes: options.maximumPromptTextBytes }),
      ...(options.maximumInputItems === undefined ? {} : { maximumInputItems: options.maximumInputItems })
    };
    this.#maximumModels = options.maximumModels ?? 1_000;
    this.#maximumDiscoveredThreads = options.maximumDiscoveredThreads ?? 1_000;
    this.#maximumCatalogEntries = options.maximumCatalogEntries ?? 10_000;
    this.#maximumPaginationPages = options.maximumPaginationPages ?? 100;
    this.#maximumHistoryTurns = options.maximumHistoryTurns ?? 10_000;
    this.#maximumHistoryItems = options.maximumHistoryItems ?? 100_000;
    this.#maximumHistoryBytes = options.maximumHistoryBytes ?? 32 * 1024 * 1024;
    this.#maximumHistoryEvents = options.maximumHistoryEvents ?? 250_000;
    this.#maximumHistoryPages = options.maximumHistoryPages ?? 100;
    this.#historyReadTimeoutMs = options.historyReadTimeoutMs ?? 30_000;
    this.#now = options.now ?? Date.now;
    this.#hostCapabilities = validatedHostCapabilities(options.hostCapabilities);
    this.#compactionTimeoutMs = options.compactionTimeoutMs ?? 120_000;
    this.#profileDirectory = resolve(options.profileDirectory
      ?? options.appServer?.transport?.env?.["CODEX_HOME"]
      ?? process.env["CODEX_HOME"]
      ?? join(homedir(), ".codex"));
    this.#activeProfileKey = realpath(this.#profileDirectory)
      .catch(() => this.#profileDirectory)
      .then((directory) => codexProfileKey(directory));
    this.#catalogProfileDirectories = options.catalogProfileDirectories === undefined
      ? undefined
      : [...options.catalogProfileDirectories];
    if (!Number.isSafeInteger(this.#instanceGeneration) || this.#instanceGeneration < 1) {
      throw new TypeError("Codex Backend instance generation must be a positive integer.");
    }
    if (!Number.isSafeInteger(this.#maximumModels) || this.#maximumModels < 1
      || !Number.isSafeInteger(this.#maximumDiscoveredThreads) || this.#maximumDiscoveredThreads < 1
      || !Number.isSafeInteger(this.#maximumCatalogEntries) || this.#maximumCatalogEntries < 1
      || !Number.isSafeInteger(this.#maximumPaginationPages) || this.#maximumPaginationPages < 1
      || !Number.isSafeInteger(this.#maximumHistoryTurns) || this.#maximumHistoryTurns < 1
      || !Number.isSafeInteger(this.#maximumHistoryItems) || this.#maximumHistoryItems < 1
      || !Number.isSafeInteger(this.#maximumHistoryBytes) || this.#maximumHistoryBytes < 1
      || !Number.isSafeInteger(this.#maximumHistoryEvents) || this.#maximumHistoryEvents < 1
      || !Number.isSafeInteger(this.#maximumHistoryPages) || this.#maximumHistoryPages < 1
      || !Number.isSafeInteger(this.#historyReadTimeoutMs) || this.#historyReadTimeoutMs < 1
      || !Number.isSafeInteger(this.#compactionTimeoutMs) || this.#compactionTimeoutMs < 1) {
      throw new TypeError("Codex bounds and timeouts must be positive integers.");
    }
    for (const bound of [
      options.maximumBlobBytes,
      options.maximumAggregateBlobBytes,
      options.maximumPromptTextBytes,
      options.maximumInputItems
    ]) {
      if (bound !== undefined && (!Number.isSafeInteger(bound) || bound < 1)) {
        throw new TypeError("Codex input bounds must be positive integers.");
      }
    }
  }

  async describe(): Promise<BackendDescriptor> {
    this.#assertOpen();
    try {
      await this.#host.ensureStarted();
    } catch (error) {
      const notInstalled = error instanceof TransportFault && error.code === "spawn_failed";
      return this.#descriptor({
        version: "unavailable",
        health: "unavailable",
        installationState: notInstalled ? "not_installed" : "error",
        authenticationState: "error",
        diagnostics: ["The Codex stable app-server handshake is unavailable."],
        error: {
          code: notInstalled ? "CODEX_NOT_INSTALLED" : "CODEX_APP_SERVER_UNAVAILABLE",
          message: notInstalled ? "The Codex executable is not installed." : "The Codex app-server is unavailable.",
          phase: "probe",
          retryable: true,
          stateMayHaveChanged: false,
          recovery: notInstalled ? "Install a compatible Codex CLI and retry." : "Restart the Codex app-server and retry the stable handshake."
        }
      });
    }
    const diagnostics: string[] = [];
    let account: CodexAccountSnapshot | undefined;
    try {
      account = await this.readAccount();
    } catch {
      this.#account = undefined;
      this.#models = [];
      diagnostics.push("Codex account state could not be refreshed.");
    }
    if (account !== undefined && codexAccountModelsAvailable(account.authenticationState)) {
      try {
        this.#models = await this.listModels();
      } catch {
        this.#models = [];
        diagnostics.push("Codex model catalog could not be refreshed.");
      }
    } else {
      this.#models = [];
    }
    this.#models = this.#withManagedModels(this.#models);
    const authenticationState = this.#account?.authenticationState ?? "error";
    return this.#descriptor({
      version: versionFromUserAgent(this.#host.initializeResult?.userAgent),
      health: diagnostics.length === 0 ? "healthy" : "degraded",
      installationState: "installed",
      authenticationState,
      diagnostics
    });
  }

  async validateTarget(target: TargetDescriptor): Promise<void> {
    this.#assertOpen();
    if (target.backendId !== this.id) {
      throw adapterError({
        code: "CODEX_TARGET_BACKEND_MISMATCH",
        message: "The selected Target belongs to another Backend instance.",
        phase: "provision",
        recovery: "Choose a Target owned by this Codex Backend instance."
      });
    }
    if (target.remoteWorkspace !== undefined) {
      throw adapterError({
        code: "CODEX_REMOTE_TARGET_UNSUPPORTED",
        message: "This Codex Backend instance does not provide a remote app-server transport.",
        phase: "provision",
        recovery: "Use a local Target or a Backend instance configured for the remote host."
      });
    }
    if (!isAbsolute(target.workspaceRoot)) {
      throw adapterError({
        code: "CODEX_TARGET_PATH_INVALID",
        message: "The Target workspace root must be absolute.",
        phase: "provision",
        recovery: "Repair the Target workspace binding."
      });
    }
    const info = await stat(target.workspaceRoot).catch(() => undefined);
    if (info?.isDirectory() !== true) {
      throw adapterError({
        code: "CODEX_TARGET_UNAVAILABLE",
        message: "The Target workspace is unavailable.",
        phase: "provision",
        retryable: true,
        recovery: "Restore the Target workspace and retry."
      });
    }
  }

  async createSession(input: CreateNativeSessionInput, context: AdapterContext): Promise<NativeSessionBinding> {
    return this.#withNativeMutation(context, () => this.#createSession(input, context));
  }

  async #createSession(input: CreateNativeSessionInput, context: AdapterContext): Promise<NativeSessionBinding> {
    this.#assertOpen();
    const runtimePolicy = reviewRuntimePolicy(input, context);
    await this.validateTarget(input.target);
    this.#assertContextTarget(context, input.target);
    if (input.nativeStart?.kind === "attach") {
      const binding = bindingFromReference(input.nativeStart.nativeReference, context.generation);
      const resumed = await this.resumeSession(binding, context);
      return resumed.binding;
    }
    await this.#validateModelSelection(
      input.providerId,
      input.modelId,
      input.effort,
      input.fastMode
    );
    if (input.permissionMode === "bypassPermissions" && !input.target.trusted) {
      throw adapterError({
        code: "CODEX_FULL_ACCESS_REQUIRES_TRUST",
        message: "Full access requires a trusted Target.",
        phase: "provision",
        recovery: "Use ask mode or explicitly trust the Target through the product policy flow."
      });
    }
    const cwd = await realpath(input.target.workspaceRoot);
    const reviewWorkingDirectory = runtimePolicy === "review_read_only"
      ? await createReviewWorkingDirectory()
      : undefined;
    let reviewThreadProfile: JsonObject | undefined;
    try {
      reviewThreadProfile = reviewWorkingDirectory === undefined
        ? undefined
        : await this.#buildReviewThreadProfile(cwd, reviewWorkingDirectory);
    } catch (error) {
      if (reviewWorkingDirectory !== undefined) await removeReviewWorkingDirectory(reviewWorkingDirectory);
      throw error;
    }
    const request = input.nativeStart?.kind === "new" && input.nativeStart.parentNativeReference !== undefined
      ? {
          method: "thread/fork",
          params: {
            threadId: nativeThreadId(input.nativeStart.parentNativeReference),
            cwd,
            excludeTurns: true,
            ...(input.modelId === undefined ? {} : { model: input.modelId }),
            ...(input.providerId === undefined ? {} : { modelProvider: input.providerId }),
            ...(input.fastMode ? { serviceTier: "fast" } : {}),
            ...permissionParams(input.permissionMode)
          }
        }
      : {
          method: "thread/start",
          params: {
            cwd,
            historyMode: "paginated",
            ...(input.modelId === undefined ? {} : { model: input.modelId }),
            ...(input.providerId === undefined ? {} : { modelProvider: input.providerId }),
            ...(reviewThreadProfile === undefined
              ? input.fastMode ? { serviceTier: "fast" } : {}
              : reviewThreadProfile),
            ...(runtimePolicy === "review_read_only"
              || (input.appendSystemPrompt === undefined && context.appendSystemPrompt === undefined)
              ? {}
              : { developerInstructions: input.appendSystemPrompt ?? context.appendSystemPrompt }),
            ...(runtimePolicy === "review_read_only" ? {} : permissionParams(input.permissionMode))
          }
        };
    const managedRoute = await this.#prepareManagedRoute(input.providerId, input.modelId, context).catch(async (error) => {
      if (reviewWorkingDirectory !== undefined) await removeReviewWorkingDirectory(reviewWorkingDirectory);
      throw error;
    });
    const nativeConfiguration = this.#nativeRouteConfiguration(managedRoute);
    if (nativeConfiguration !== undefined) {
      const previousConfig = (request.params as JsonObject)["config"];
      Object.assign(request.params, { config: { ...(isJsonObject(previousConfig) ? previousConfig : {}), ...nativeConfiguration } });
    }
    let response;
    try {
      response = await this.#host.request(request.method, request.params, { mutation: true });
    } catch (error) {
      if (reviewWorkingDirectory !== undefined) await removeReviewWorkingDirectory(reviewWorkingDirectory);
      managedRoute?.dispose();
      throw this.#requestFailure(error, "provision", "CODEX_SESSION_CREATE_FAILED", true);
    }
    let thread: NativeThread;
    let record: JsonObject;
    let binding: NativeSessionBinding;
    let runtime: SessionRuntime;
    try {
      thread = parseThreadResult(response.value);
      if (request.method === "thread/start" && thread.historyMode !== "paginated") {
        throw adapterError({
          code: "CODEX_HISTORY_MODE_UNCONFIRMED",
          message: "Codex did not confirm the requested paginated history mode.",
          phase: "provision",
          stateMayHaveChanged: true,
          recovery: "Inspect native Session discovery before explicitly creating another Session."
        });
      }
      record = objectValue(response.value, "session response");
      this.#assertManagedRouteResponse(record, managedRoute);
      if (runtimePolicy === "review_read_only") {
        if (reviewWorkingDirectory === undefined) throw invalidReviewProfile();
        assertReviewThreadStarted(record, thread, cwd, reviewWorkingDirectory);
      }
      binding = bindingForThread(thread.id, context.generation, await this.#activeProfileKey);
      runtime = await this.#installRuntime({
        thread,
        binding,
        context,
        hostGeneration: response.hostGeneration,
        permissionMode: input.permissionMode,
        managedRoute,
        providerId: optionalString(record["modelProvider"]) ?? input.providerId,
        modelId: optionalString(record["model"]) ?? input.modelId,
        effort: input.effort ?? optionalString(record["reasoningEffort"]) ?? optionalString(record["effort"]),
        fastMode: Object.hasOwn(record, "serviceTier")
          ? isFastServiceTier(record["serviceTier"])
          : input.fastMode,
        observedFastMode: observedFastServiceTier(record),
        name: input.name ?? thread.name ?? undefined,
        ...(reviewWorkingDirectory === undefined ? {} : { reviewWorkingDirectory })
      });
    } catch (error) {
      managedRoute?.dispose();
      if (reviewWorkingDirectory !== undefined) await removeReviewWorkingDirectory(reviewWorkingDirectory);
      throw error;
    }
    if (input.name !== undefined) {
      await this.#host.request("thread/name/set", { threadId: thread.id, name: input.name }, { mutation: true }).catch(() => undefined);
      if (this.#isRuntimeCurrent(runtime, response.hostGeneration)) runtime.name = input.name;
    }
    return binding;
  }

  async resumeSession(binding: NativeSessionBinding, context: AdapterContext): Promise<NativeSessionState> {
    return this.#withNativeMutation(context, () => this.#resumeSession(binding, context));
  }

  async #resumeSession(binding: NativeSessionBinding, context: AdapterContext): Promise<NativeSessionState> {
    this.#assertOpen();
    assertStandardReviewContext(context, "resume native Session history");
    this.#assertContextTarget(context, context.target);
    await this.validateTarget(context.target);
    const resumedBinding = this.#resumeBindingForContext(binding, context);
    const threadId = threadIdFromBinding(resumedBinding);
    const inspection = await this.#readValidatedNativeThread(threadId, context.target, "provision").catch((error) => {
      throw this.#nativeThreadReadFailure(error, "provision");
    });
    const current = this.#sessions.get(context.sessionId);
    if (current !== undefined
      && current.threadId === threadId
      && current.hostGeneration === inspection.hostGeneration
      && this.#matchesCoreFence(current, context)
      && this.#host.isActiveGeneration(current.hostGeneration)) {
      current.context = context;
      return stateFromRuntime(current);
    }
    const managedRoute = await this.#prepareManagedRoute(context.modelSelection?.providerId, context.modelSelection?.modelId, context);
    if (managedRoute !== undefined) {
      if (inspection.thread.status?.["type"] === "active") { managedRoute.dispose(); throw managedRouteUnavailable(true); }
      try { await this.#host.releaseUnboundThread(threadId, inspection.hostGeneration); }
      catch { managedRoute.dispose(); throw managedRouteUnavailable(true); }
    }
    const response = await this.#resumeNativeThread(
      threadId,
      inspection.workspaceRoot,
      inspection.hostGeneration,
      context.modelSelection,
      managedRoute
    ).catch((error) => {
      managedRoute?.dispose();
      throw this.#nativeThreadResumeFailure(error);
    });
    let thread = parseThreadResult(response.value);
    if (thread.status?.["type"] === "active" && thread.turns.length === 0) {
      const latest = await this.#host.request("thread/turns/list", {
        threadId,
        limit: 1,
        sortDirection: "desc",
        itemsView: "notLoaded"
      });
      if (latest.hostGeneration !== response.hostGeneration) {
        throw adapterError({
          code: "CODEX_RUNTIME_GENERATION_STALE",
          message: "The Codex app-server generation changed while recovering the active turn.",
          phase: "provision",
          stateMayHaveChanged: true,
          recovery: "Resume the native thread through the current Backend instance."
        });
      }
      thread = { ...thread, turns: parseTurnList(latest.value) };
    }
    const normalized = bindingForThread(thread.id, context.generation, await this.#activeProfileKey);
    const record = objectValue(response.value, "resume response");
    const runtime = await this.#installRuntime({
      thread,
      binding: normalized,
      context,
      hostGeneration: response.hostGeneration,
      permissionMode: permissionModeFromResponse(record),
      managedRoute,
      providerId: optionalString(record["modelProvider"]),
      modelId: optionalString(record["model"]),
      effort: optionalString(record["reasoningEffort"]) ?? optionalString(record["effort"]),
      fastMode: isFastServiceTier(record["serviceTier"]),
      observedFastMode: observedFastServiceTier(record),
      name: thread.name ?? undefined
    });
    return stateFromRuntime(runtime);
  }

  async inspectSession(binding: NativeSessionBinding, context: AdapterContext): Promise<NativeSessionState> {
    this.#assertOpen();
    this.#assertContextTarget(context, context.target);
    await this.validateTarget(context.target);
    const threadId = threadIdFromBinding(binding);
    if (binding.generation !== context.generation) {
      throw adapterError({
        code: "CODEX_SESSION_BINDING_MISMATCH",
        message: "The Codex native Session binding belongs to another Session generation.",
        phase: "probe",
        recovery: "Refresh the durable Session binding before inspecting the native thread."
      });
    }
    if (context.runtimePolicy === "review_read_only") {
      const runtime = this.#sessions.get(context.sessionId);
      if (runtime === undefined) throw invalidReviewProfile();
      this.#assertRuntimeFence(runtime, context, runtime.hostGeneration, false);
      if (threadId !== runtime.threadId) throw invalidReviewProfile();
      return stateFromRuntime(runtime);
    }
    const inspected = await this.#readValidatedNativeThread(threadId, context.target, "probe").catch((error) => {
      throw this.#requestFailure(error, "probe", "CODEX_NATIVE_SESSION_UNAVAILABLE", false);
    });
    const thread = inspected.thread;
    const runtime = this.#sessions.get(context.sessionId);
    if (runtime !== undefined && this.#matchesCoreFence(runtime, context)) {
      runtime.context = context;
      runtime.name = thread.name ?? runtime.name;
      return stateFromRuntime(runtime, thread);
    }
    return stateFromThread(bindingFromReference(binding.opaqueRef, context.generation), thread);
  }

  async resolveNativeSessionReference(
    nativeReference: string,
    target: TargetDescriptor,
    generation: number
  ): Promise<NativeSessionBinding> {
    await this.validateTarget(target);
    const threadId = nativeThreadId(nativeReference);
    try {
      const { thread } = await this.#readValidatedNativeThread(threadId, target, "probe");
      return bindingFromReference(nativeReference, generation);
    } catch (error) {
      throw this.#nativeThreadReadFailure(error, "probe");
    }
  }

  async listNativeSessions(target: TargetDescriptor): Promise<readonly NativeSessionCandidate[]> {
    await this.validateTarget(target);
    const cwd = await realpath(target.workspaceRoot);
    const activeProfileKey = await this.#activeProfileKey;
    const candidates: NativeSessionCandidate[] = [];
    const nativeIds = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    try {
      do {
        if (pages >= this.#maximumPaginationPages) {
          throw paginationError("CODEX_THREAD_PAGINATION_LIMIT", "native Session discovery");
        }
        const pageLimit = Math.min(100, this.#maximumDiscoveredThreads - candidates.length);
        const response = await this.#host.request("thread/list", {
          limit: pageLimit,
          cwd,
          useStateDbOnly: true,
          ...(cursor === undefined ? {} : { cursor })
        });
        pages += 1;
        const page = parseThreadList(response.value, pageLimit);
        for (const thread of page.threads) {
          if (nativeIds.has(thread.id)
            || !isValidNativeThreadId(thread.id)
            || !(await nativeThreadMatchesWorkspace(thread, cwd))) continue;
          nativeIds.add(thread.id);
          candidates.push({
            nativeReference: referenceForThread(thread.id, activeProfileKey),
            nativeSessionId: thread.id,
            ...(thread.name === null || thread.name === undefined ? {} : { name: thread.name }),
            ...(thread.cwd === undefined ? {} : { workspaceRoot: thread.cwd }),
            messageCount: thread.turns.length,
            modifiedAt: Math.max(0, Math.trunc((thread.updatedAt ?? thread.createdAt ?? 0) * 1_000)),
            state: thread.status?.["type"] === "systemError" ? "error" : "ready"
          });
          if (candidates.length >= this.#maximumDiscoveredThreads) return candidates;
        }
        cursor = nextPaginationCursor(page.nextCursor, seenCursors, "CODEX_THREAD_PAGINATION_INVALID", "native Session discovery");
      } while (cursor !== undefined);
      return candidates;
    } catch (error) {
      throw this.#requestFailure(error, "probe", "CODEX_THREAD_DISCOVERY_FAILED", false);
    }
  }

  async scanNativeSessionCatalog(): Promise<NativeSessionCatalogResult> {
    this.#assertOpen();
    const [scan, activeProfileKey] = await Promise.all([
      scanCodexSessionCatalog({
        ...(this.#catalogProfileDirectories === undefined
          ? {}
          : { profileDirectories: this.#catalogProfileDirectories }),
        activeProfileDirectory: this.#profileDirectory,
        maximumEntries: Math.min(this.#maximumCatalogEntries, 1_000),
        maximumTotalEntries: this.#maximumCatalogEntries
      }),
      this.#activeProfileKey
    ]);
    const sources = new Map<string, CodexCatalogSource>();
    const entries = scan.summaries.map((summary) => {
        const materialized = summary.observedProfileKeys.includes(activeProfileKey);
        const nativeReference = referenceForThread(
          summary.nativeSessionId,
          materialized ? activeProfileKey : summary.source.profileKey,
          materialized ? undefined : summary.source.fingerprint
        );
        if (!materialized) sources.set(nativeReference, summary.source);
        const entry: NativeSessionCatalogEntry = {
          nativeReference,
          nativeSessionId: summary.nativeSessionId,
          ...(summary.title === undefined ? {} : { title: summary.title }),
          ...(summary.workingDirectory === undefined ? {} : { workingDirectory: summary.workingDirectory }),
          ...(summary.projectDirectory === undefined ? {} : { projectDirectory: summary.projectDirectory }),
          createdAt: summary.createdAt,
          modifiedAt: summary.modifiedAt,
          archived: summary.archived,
          placement: summary.placement,
          existingMatch: "binding_and_placement" as const
        };
        this.#catalogEntrySources.set(entry, summary.source);
        return entry;
      });
    for (const [reference, source] of sources) this.#catalogSources.set(reference, source);
    if (this.#catalogSources.size > 32_000) {
      const retained = new Set(sources.keys());
      for (const reference of this.#catalogSources.keys()) {
        if (!retained.has(reference)) this.#catalogSources.delete(reference);
      }
    }
    return {
      entries,
      rejectedCount: scan.rejectedCount
    };
  }

  async bindCatalogSession(
    entry: NativeSessionCatalogEntry,
    generation: number
  ): Promise<NativeSessionBinding> {
    this.#assertOpen();
    const activeProfileKey = await this.#activeProfileKey;
    const parsed = parseNativeReference(entry.nativeReference);
    if (entry.nativeSessionId !== undefined && entry.nativeSessionId !== parsed.threadId) {
      throw invalidNativeReference();
    }
    const entrySource = this.#catalogEntrySources.get(entry);
    if (parsed.profileKey === activeProfileKey && parsed.sourceFingerprint === undefined) {
      if (entrySource === undefined || entrySource.profileKey !== activeProfileKey) {
        throw expiredCatalogReference();
      }
      await validateCodexCatalogSource(entrySource, parsed.threadId);
      return bindingForThread(parsed.threadId, generation, activeProfileKey);
    }
    const source = entrySource ?? this.#catalogSources.get(entry.nativeReference);
    if (source === undefined
      || parsed.profileKey !== source.profileKey
      || parsed.sourceFingerprint !== source.fingerprint) {
      throw expiredCatalogReference();
    }
    await this.#withCatalogMaterializationLock(() => materializeCodexCatalogSession({
      activeProfileDirectory: this.#profileDirectory,
      source,
      entry
    }));
    return bindingForThread(parsed.threadId, generation, activeProfileKey);
  }

  async getNativeHistoryProjection(context: AdapterContext): Promise<NativeHistoryProjection> {
    this.#assertOpen();
    if (context.signal.aborted) throw nativeHistoryReadFailure("CANCELLED");
    assertStandardReviewContext(context, "read persisted native history");
    this.#assertContextTarget(context, context.target);
    await this.validateTarget(context.target);
    if (context.signal.aborted) throw nativeHistoryReadFailure("CANCELLED");
    const binding = context.binding;
    if (binding === undefined) {
      throw adapterError({
        code: "CODEX_SESSION_BINDING_REQUIRED",
        message: "Codex native history requires an attached native thread.",
        phase: "probe",
        recovery: "Resume or attach the Session before reading native history."
      });
    }
    const currentBinding = this.#resumeBindingForContext(binding, context);
    const runtime = await this.#requireRuntime(context);
    this.#assertStandardRuntime(runtime, "read native history");
    this.#assertHistoryRuntimeFence(runtime, context, currentBinding, runtime.hostGeneration);
    try {
      const history = await this.#readCompleteHistory(runtime, context);
      history.assertCurrent();
      const projection = projectCodexNativeHistory(history.thread, { maximumEvents: this.#maximumHistoryEvents });
      history.assertCurrent();
      return projection;
    } catch (error) {
      throw this.#requestFailure(error, "probe", "CODEX_NATIVE_HISTORY_UNAVAILABLE", false);
    }
  }

  async send(input: PromptInput, context: AdapterContext): Promise<void> {
    return this.#withNativeMutation(context, () => this.#send(input, context));
  }

  async #send(input: PromptInput, context: AdapterContext): Promise<void> {
    this.#assertOpen();
    assertDispatchNotCancelled(context.signal);
    this.#assertBackendContext(context);
    // Steering owns the currently attached turn before any asynchronous preparation.
    let runtime = input.disposition === "steer"
      ? this.#sessions.get(context.sessionId)
      : await this.#requireRuntime(context);
    if (runtime === undefined) {
      throw adapterError({
        code: "CODEX_ACTIVE_TURN_REQUIRED",
        message: "The Codex turn selected for steering is no longer attached.",
        phase: "dispatch",
        recovery: "Keep the input and explicitly send it as a new prompt after refreshing the task."
      });
    }
    if (input.disposition !== "steer" && runtime.managedRoute !== undefined) {
      try { runtime.managedRoute.assertCurrent(); }
      catch {
        runtime = await this.#switchNativeRoute(runtime, runtime.managedRoute.providerId, runtime.managedRoute.model.modelId, context);
      }
    }
    if (runtime.routeUnknown) throw managedRouteUnavailable(true);
    const hostGeneration = runtime.hostGeneration;
    const dispatchSignal = AbortSignal.any([context.signal, runtime.dispatchLifetime.signal]);
    const expectedTurnId = input.disposition === "steer" ? runtime.state.activeTurnId : undefined;
    const assertDispatchReady = () => {
      assertDispatchNotCancelled(dispatchSignal);
      if (!this.#matchesCoreFence(runtime, context)
        || runtime.hostGeneration !== hostGeneration
        || !this.#host.isActiveGeneration(hostGeneration)) {
        throw adapterError({
          code: "CODEX_RUNTIME_GENERATION_STALE",
          message: "The Codex runtime changed before input dispatch.",
          phase: "dispatch",
          recovery: "Refresh the Session and Backend instance before sending the input."
        });
      }
      if (input.disposition === "steer" && (expectedTurnId === undefined
        || runtime.state.activeTurnId !== expectedTurnId
        || runtime.state.terminalTurnIds.has(expectedTurnId))) {
        throw adapterError({
          code: "CODEX_ACTIVE_TURN_REQUIRED",
          message: "The Codex turn selected for steering is no longer active.",
          phase: "dispatch",
          recovery: "Keep the input and explicitly send it as a new prompt after refreshing the task."
        });
      }
    };
    assertDispatchReady();
    runtime.context = context;
    if (runtime.runtimePolicy === "review_read_only" && (
      input.disposition !== "prompt"
      || input.files.length !== 0
      || input.mentions.length !== 0
    )) throw invalidReviewProfile();
    if (context.operationId === undefined || context.operationId.length === 0) {
      throw adapterError({
        code: "CODEX_OPERATION_ID_REQUIRED",
        message: "Codex dispatch requires the durable host operation identity.",
        phase: "dispatch",
        recovery: "Retry through the durable Joko Queue so the native client message can be reconciled."
      });
    }
    const nativeInput = await waitForDispatchPreparation(translatePromptInput(input, context, this.#resolvers), dispatchSignal);
    assertDispatchReady();
    const clientUserMessageId = context.operationId;
    const collaborationMode = runtime.runtimePolicy === "standard"
      && supportsNativeCollaboration(this.#host.initializeResult?.userAgent)
      ? collaborationModeForTurn(runtime)
      : undefined;
    let acceptedResponseShapePending = false;
    try {
      if (input.disposition === "steer") {
        const response = await this.#host.request("turn/steer", {
          threadId: runtime.threadId,
          clientUserMessageId,
          input: [...nativeInput],
          expectedTurnId: expectedTurnId!
        }, { mutation: true, signal: dispatchSignal, beforeDispatch: assertDispatchReady });
        this.#assertRuntimeFence(runtime, context, response.hostGeneration);
        acceptedResponseShapePending = true;
        if (parseTurnSteer(response.value) !== expectedTurnId) {
          throw new ProtocolShapeError("turn steer result does not match the active turn");
        }
        acceptedResponseShapePending = false;
        return;
      }
      await this.#activateManagedOperation(runtime, context);
      assertDispatchReady();
      const response = await this.#host.request("turn/start", {
        threadId: runtime.threadId,
        clientUserMessageId,
        input: [...nativeInput],
        cwd: runtime.reviewWorkingDirectory ?? context.target.workspaceRoot,
        ...(runtime.modelId === undefined ? {} : { model: runtime.modelId }),
        ...(runtime.effort === undefined ? {} : { effort: runtime.effort }),
        ...(collaborationMode === undefined ? {} : { collaborationMode }),
        ...(runtime.runtimePolicy === "review_read_only"
          ? {
              approvalPolicy: "never",
              environments: [],
              runtimeWorkspaceRoots: [runtime.targetWorkspaceRoot],
              serviceTierForTurn: "default"
            }
          : runtime.fastMode ? { serviceTier: "fast" } : {})
      }, { mutation: true, signal: dispatchSignal, beforeDispatch: assertDispatchReady });
      this.#assertRuntimeFence(runtime, context, response.hostGeneration);
      acceptedResponseShapePending = true;
      const startedTurn = parseTurnStart(response.value);
      if (startedTurn.status !== "inProgress" && !runtime.state.terminalTurnIds.has(startedTurn.id)) {
        throw new ProtocolShapeError("turn start result is not in progress");
      }
      if (!runtime.state.terminalTurnIds.has(startedTurn.id)
        && (runtime.state.activeTurnId === undefined || runtime.state.activeTurnId === startedTurn.id)) {
        runtime.state.activeTurnId = startedTurn.id;
      } else if (!runtime.state.terminalTurnIds.has(startedTurn.id)) {
        throw new ProtocolShapeError("turn start result conflicts with the active turn");
      }
      if (collaborationMode?.mode === "default") runtime.defaultCollaborationMarkerPending = false;
      acceptedResponseShapePending = false;
    } catch (error) {
      if (isAmbiguousDispatchFailure(error)
        || (acceptedResponseShapePending && error instanceof ProtocolShapeError)) {
        const reconciled = await this.#reconcileClientMessage(runtime, context, clientUserMessageId, expectedTurnId);
        if (reconciled) {
          if (collaborationMode?.mode === "default") runtime.defaultCollaborationMarkerPending = false;
          return;
        }
        if (input.disposition !== "steer") this.#releaseManagedOperation(runtime);
        throw adapterError({
          code: "CODEX_DISPATCH_UNKNOWN",
          message: "Codex may have accepted the input, but the durable outcome could not be proven.",
          phase: "dispatch",
          retryable: false,
          stateMayHaveChanged: true,
          recovery: "Refresh the native thread and resolve the unknown dispatch before explicitly retrying."
        });
      }
      if (input.disposition !== "steer") this.#releaseManagedOperation(runtime);
      if (error instanceof Error && "publicError" in error) throw error;
      throw this.#requestFailure(error, "dispatch", "CODEX_TURN_START_FAILED", false);
    }
  }

  async abort(context: AdapterContext): Promise<void> {
    const runtime = await this.#requireRuntime(context);
    this.#releaseManagedOperation(runtime);
    const turnId = runtime.state.activeTurnId;
    if (turnId === undefined) return;
    try {
      const response = await this.#host.request("turn/interrupt", {
        threadId: runtime.threadId,
        turnId
      }, { mutation: true });
      this.#assertRuntimeFence(runtime, context, response.hostGeneration);
      this.#cancelPendingServerRequests(runtime, (pending) => pending.turnId === turnId);
    } catch (error) {
      throw this.#requestFailure(error, "dispatch", "CODEX_TURN_INTERRUPT_FAILED", true);
    }
  }

  override async closeSession(binding: NativeSessionBinding, context: AdapterContext): Promise<void> {
    this.#assertBackendContext(context);
    const runtime = this.#sessions.get(context.sessionId);
    if (runtime === undefined) return;
    this.#assertRuntimeFence(runtime, context, runtime.hostGeneration, false);
    if (threadIdFromBinding(binding) !== runtime.threadId) {
      throw adapterError({
        code: "CODEX_SESSION_BINDING_MISMATCH",
        message: "The Codex close request does not match the active native thread.",
        phase: "shutdown",
        recovery: "Refresh the Session binding before closing it."
      });
    }
    runtime.dispatchLifetime.abort();
    await this.#emitNativeTaskPayloads(
      runtime,
      runtime.nativeTasks.terminateActive("stopped"),
      runtime.hostGeneration,
      "runtime/closed",
      false,
      false
    ).catch(() => undefined);
    runtime.closed = true;
    this.#settleCompaction(runtime, adapterError({
      code: "CODEX_COMPACTION_INTERRUPTED",
      message: "The Codex Session closed during native compaction.",
      phase: "shutdown",
      stateMayHaveChanged: true,
      recovery: "Resume the native thread and inspect its compaction state."
    }));
    this.#sessions.delete(context.sessionId);
    this.#cancelPendingServerRequests(runtime);
    await this.#releaseRuntimeSubscription(runtime, true);
  }

  async detachSession(binding: NativeSessionBinding, context: AdapterContext): Promise<void> {
    this.#assertBackendContext(context);
    const runtime = this.#sessions.get(context.sessionId);
    if (runtime === undefined || threadIdFromBinding(binding) !== runtime.threadId) return;
    this.#assertRuntimeFence(runtime, context, runtime.hostGeneration, false);
    runtime.dispatchLifetime.abort();
    await this.#emitNativeTaskPayloads(
      runtime,
      runtime.nativeTasks.terminateActive("stopped"),
      runtime.hostGeneration,
      "runtime/detached",
      false,
      false
    ).catch(() => undefined);
    runtime.closed = true;
    this.#settleCompaction(runtime, adapterError({
      code: "CODEX_COMPACTION_INTERRUPTED",
      message: "The Codex Session detached during native compaction.",
      phase: "shutdown",
      stateMayHaveChanged: true,
      recovery: "Resume the native thread and inspect its compaction state."
    }));
    this.#sessions.delete(context.sessionId);
    this.#cancelPendingServerRequests(runtime);
    await this.#releaseRuntimeSubscription(runtime, true);
  }

  override async deleteSession(binding: NativeSessionBinding, context: AdapterContext): Promise<void> {
    assertStandardReviewContext(context, "delete native Session state");
    this.#assertOpen();
    this.#assertBackendContext(context);
    const threadId = threadIdFromBinding(binding);
    const profileKey = await this.#activeProfileKey;
    this.#assertOpen();
    this.#assertBackendContext(context);
    if (parseNativeReference(binding.opaqueRef).profileKey !== profileKey) throw invalidNativeReference();
    if (context.target.backendId !== this.id
      || binding.generation !== context.generation
      || context.binding?.opaqueRef !== binding.opaqueRef
      || context.binding.generation !== binding.generation) {
      throw adapterError({
        code: "CODEX_SESSION_BINDING_MISMATCH",
        message: "The Codex delete request does not match its owning Session binding.",
        phase: "shutdown",
        recovery: "Refresh the durable Session binding before deleting native state."
      });
    }
    if ([...this.#sessions.values()].some((runtime) => runtime.threadId === threadId && runtime.sessionId !== context.sessionId)) {
      throw adapterError({
        code: "CODEX_SESSION_ACTIVE",
        message: "Another product Session is still using the native Codex thread.",
        phase: "shutdown",
        recovery: "Detach the owning Session before deleting native state."
      });
    }
    await this.closeSession(binding, context);
    try {
      await this.#host.request("thread/delete", { threadId }, { mutation: true, signal: context.signal });
    } catch (error) {
      throw this.#requestFailure(error, "shutdown", "CODEX_SESSION_DELETE_FAILED", true);
    }
  }

  override async setName(name: string, context: AdapterContext): Promise<void> {
    return this.#withNativeMutation(context, () => this.#setName(name, context));
  }

  async #setName(name: string, context: AdapterContext): Promise<void> {
    if (name.trim().length === 0) {
      throw adapterError({
        code: "CODEX_SESSION_NAME_INVALID",
        message: "The Codex session name cannot be empty.",
        phase: "dispatch",
        recovery: "Choose a non-empty session name."
      });
    }
    const runtime = await this.#requireRuntime(context);
    this.#assertStandardRuntime(runtime, "rename the native thread");
    const response = await this.#host.request("thread/name/set", { threadId: runtime.threadId, name }, { mutation: true })
      .catch((error) => { throw this.#requestFailure(error, "dispatch", "CODEX_SESSION_RENAME_FAILED", true); });
    this.#assertRuntimeFence(runtime, context, response.hostGeneration);
    runtime.name = name;
  }

  override async compact(customInstructions: string | undefined, context: AdapterContext): Promise<"compacted" | "noop"> {
    return this.#withNativeMutation(context, () => this.#compact(customInstructions, context));
  }

  async #compact(customInstructions: string | undefined, context: AdapterContext): Promise<"compacted" | "noop"> {
    if (customInstructions !== undefined && customInstructions.trim().length > 0) {
      return this.unsupported("context.compact.custom_instructions");
    }
    const runtime = await this.#requireRuntime(context);
    this.#assertStandardRuntime(runtime, "compact native history");
    if (runtime.compaction !== undefined) {
      throw adapterError({
        code: "CODEX_COMPACTION_IN_PROGRESS",
        message: "Codex is already compacting this native thread.",
        phase: "dispatch",
        retryable: true,
        recovery: "Wait for the active native compaction to finish."
      });
    }
    const completion = this.#beginCompactionWait(runtime);
    void completion.catch(() => undefined);
    let response;
    try {
      await this.#activateManagedOperation(runtime, context);
      response = await this.#host.request("thread/compact/start", { threadId: runtime.threadId }, { mutation: true, signal: context.signal });
      this.#assertRuntimeFence(runtime, context, response.hostGeneration);
      await completion;
      this.#assertRuntimeFence(runtime, context, response.hostGeneration);
    } catch (error) {
      this.#settleCompaction(runtime, error);
      if (error instanceof Error && "publicError" in error) throw error;
      throw this.#requestFailure(error, "dispatch", "CODEX_COMPACTION_FAILED", true);
    }
    return "compacted";
  }

  override async fork(entryId: string, context: AdapterContext, derivation: NativeSessionDerivation): Promise<NativeSessionForkResult> {
    return this.#withNativeMutation(context, () => this.#fork(entryId, context, derivation));
  }

  async #fork(entryId: string, context: AdapterContext, derivation: NativeSessionDerivation): Promise<NativeSessionForkResult> {
    const runtime = await this.#requireRuntime(context);
    this.#assertStandardRuntime(runtime, "fork the native thread");
    return {
      binding: await this.#forkThread(runtime, context, derivation, entryId)
    };
  }

  override async clone(context: AdapterContext, derivation: NativeSessionDerivation): Promise<NativeSessionBinding> {
    return this.#withNativeMutation(context, () => this.#clone(context, derivation));
  }

  async #clone(context: AdapterContext, derivation: NativeSessionDerivation): Promise<NativeSessionBinding> {
    const runtime = await this.#requireRuntime(context);
    this.#assertStandardRuntime(runtime, "clone the native thread");
    return this.#forkThread(runtime, context, derivation);
  }

  override async navigateTree(target: NativeNavigationTarget, summarize: boolean, context: AdapterContext, customInstructions: string | undefined, _navigation: NativeSessionNavigation): Promise<NativeSessionNavigationResult> {
    this.#assertOpen();
    this.#assertBackendContext(context);
    assertDispatchNotCancelled(context.signal);
    if (summarize || customInstructions !== undefined) return this.unsupported("session.tree.summary");
    const runtime = this.#sessions.get(context.sessionId);
    if (runtime === undefined || !this.#matchesCoreFence(runtime, context)) throw nativeHistoryReadFailure("STALE");
    this.#assertStandardRuntime(runtime, "rewind native history");
    if (runtime.rewindUnknown) throw rewindUnknown();
    const existing = this.#sessionMutations.get(context.sessionId);
    if (existing !== undefined) throw rewindBusy();
    const admission = { count: 0, rewinding: true };
    this.#sessionMutations.set(context.sessionId, admission);
    const hostGeneration = runtime.hostGeneration;
    const signal = AbortSignal.any([context.signal, runtime.dispatchLifetime.signal]);
    const assertIdle = () => {
      assertDispatchNotCancelled(signal);
      if (!this.#matchesCoreFence(runtime, context) || runtime.hostGeneration !== hostGeneration
        || !this.#host.isActiveGeneration(hostGeneration)) throw nativeHistoryReadFailure("STALE");
      if (runtime.state.activeTurnId !== undefined || runtime.compaction !== undefined
        || runtime.pendingServerRequests.size !== 0 || runtime.nativeTasks.hasActiveTasks()
        || this.#host.hasPendingThreadNotifications(runtime.threadId, hostGeneration)) throw rewindBusy();
    };
    try {
      assertIdle();
      const history = await this.#readCompleteHistory(runtime, context);
      assertIdle();
      assertRewindableHistory(history.thread);
      for (const lineage of runtime.nativeTasks.mergeHistory(history.thread)) {
        await this.#host.registerDescendantThread(lineage.childThreadId, lineage.parentThreadId, hostGeneration);
        history.assertCurrent();
      }
      assertIdle();
      const index = target.kind === "session_start" ? -1
        : history.thread.turns.findIndex((turn) => turn.id === target.entryId || turn.items.some((item) => item.id === target.entryId));
      if (target.kind === "native_entry") {
        if (index < 0) throw rewindBoundaryUnavailable();
        const selected = history.thread.turns[index]!;
        if (selected.id !== target.entryId && selected.items.at(-1)?.id !== target.entryId) throw rewindBoundaryUnavailable();
      }
      const excluded = history.thread.turns[index + 1];
      const beforeDispatch = () => { assertIdle(); history.assertCurrent(); };
      beforeDispatch();
      if (excluded === undefined) return { kind: "in_place" };
      const expectedPrefix = history.thread.turns.slice(0, index + 1).map(fullTurnSignature);
      let response;
      try {
        response = await this.#host.request("thread/revert", { threadId: runtime.threadId, beforeTurnId: excluded.id }, {
          mutation: true, signal, beforeDispatch
        });
      } catch (error) {
        if (!isAmbiguousDispatchFailure(error)) {
          throw this.#requestFailure(error, "dispatch", "CODEX_REWIND_REJECTED", false);
        }
      }
      try {
        const confirmationSignal = AbortSignal.any([signal, AbortSignal.timeout(this.#historyReadTimeoutMs)]);
        const confirmationContext = { ...context, signal: confirmationSignal };
        if (response !== undefined) {
          const rawThread = objectValue(objectValue(response.value, "revert result")["thread"], "revert metadata");
          if (!Array.isArray(rawThread["turns"]) || rawThread["turns"].length !== 0) throw new ProtocolShapeError("revert result must contain metadata only");
          const thread = parseThreadResult(response.value);
          if (thread.id !== runtime.threadId || thread.historyMode !== "paginated") throw new ProtocolShapeError("revert thread identity changed");
          this.#assertRuntimeFence(runtime, context, response.hostGeneration);
          await waitForHistoryRead(assertNativeThreadTarget(thread, runtime.threadId, runtime.targetWorkspaceRoot, "probe"),
            confirmationSignal, rewindUnknown);
        }
        // A lost acknowledgement is never resent. Only the exact retained
        // prefix, read from the same live owner, can confirm the desired state.
        const confirm = async () => {
          await this.#host.waitForThreadNotifications(runtime.threadId, hostGeneration, confirmationSignal);
          assertIdle();
          return this.#readCompleteHistory(runtime, confirmationContext);
        };
        let retained;
        try { retained = await confirm(); }
        catch (error) {
          if (!(error instanceof JokoError) || error.publicError.code !== "CODEX_NATIVE_HISTORY_STALE") throw error;
          // The native acknowledgement can precede its own reverted/status
          // notification. Retry only the read, within the same total deadline.
          retained = await confirm();
        }
        assertIdle();
        assertRewindableHistory(retained.thread);
        if (JSON.stringify(retained.thread.turns.map(fullTurnSignature)) !== JSON.stringify(expectedPrefix)) throw new ProtocolShapeError("revert retained prefix differs");
        retained.assertCurrent();
        const retainedDescendants = runtime.nativeTasks.replaceHistory(retained.thread);
        this.#host.retainDescendantThreads(runtime.threadId, hostGeneration, new Set(retainedDescendants.map((lineage) => lineage.childThreadId)));
        runtime.state.activeTurnId = undefined;
        runtime.state.usage = undefined;
        runtime.state.itemNames.clear();
        runtime.state.terminalTurnIds.clear();
        for (const turn of retained.thread.turns) runtime.state.terminalTurnIds.add(turn.id);
      } catch {
        runtime.rewindUnknown = true;
        throw rewindUnknown();
      }
    } finally {
      if (this.#sessionMutations.get(context.sessionId) === admission) this.#sessionMutations.delete(context.sessionId);
    }
    return { kind: "in_place" };
  }

  override async setModel(providerId: string, modelId: string, context: AdapterContext): Promise<ProviderModel> {
    return this.#withNativeMutation(context, () => this.#setModel(providerId, modelId, context));
  }

  async #setModel(providerId: string, modelId: string, context: AdapterContext): Promise<ProviderModel> {
    let runtime = await this.#requireRuntime(context);
    this.#assertStandardRuntime(runtime, "change the model");
    const models = this.#withManagedModels(this.#models.length === 0 ? await this.listModels() : this.#models);
    const model = models.find((candidate) => candidate.providerId === providerId && candidate.modelId === modelId);
    if (model === undefined) {
      throw adapterError({
        code: "CODEX_MODEL_UNAVAILABLE",
        message: "The selected model is not present in the current Codex catalog.",
        phase: "dispatch",
        recovery: "Refresh the model catalog and choose an available model."
      });
    }
    if (runtime.providerId !== providerId || runtime.managedRoute !== undefined || this.#managedProviders?.hasProvider(providerId)) {
      runtime = await this.#switchNativeRoute(runtime, providerId, modelId, context);
    }
    const nextEffort = runtime.effort !== undefined && model.thinkingLevels.includes(runtime.effort)
      ? runtime.effort
      : undefined;
    const collaborationMode = runtime.collaborationTouched
      ? collaborationModeValue(runtime.planMode, modelId, nextEffort, runtime.planMode ? null : "")
      : undefined;
    const response = await this.#host.request("thread/settings/update", {
      threadId: runtime.threadId,
      model: modelId,
      ...(collaborationMode === undefined ? {} : { collaborationMode })
    }, { mutation: true }).catch((error) => { throw this.#requestFailure(error, "dispatch", "CODEX_MODEL_SWITCH_FAILED", true); });
    this.#assertRuntimeFence(runtime, context, response.hostGeneration);
    runtime.providerId = providerId;
    runtime.modelId = modelId;
    runtime.effort = nextEffort;
    if (!model.supportsFastMode) runtime.fastMode = false;
    runtime.nativeTasks.updateRoute(runtime.providerId, runtime.modelId, runtime.effort);
    return model;
  }

  override async setEffort(level: string, context: AdapterContext): Promise<void> {
    return this.#withNativeMutation(context, () => this.#setEffort(level, context));
  }

  async #setEffort(level: string, context: AdapterContext): Promise<void> {
    const runtime = await this.#requireRuntime(context);
    this.#assertStandardRuntime(runtime, "change reasoning effort");
    const model = await this.#requireRuntimeModel(runtime);
    if (!model.thinkingLevels.includes(level)) {
      throw adapterError({
        code: "CODEX_EFFORT_UNAVAILABLE",
        message: "The selected reasoning effort is not supported by the active Codex model.",
        phase: "dispatch",
        recovery: "Choose one of the reasoning levels advertised for the active model."
      });
    }
    const collaborationMode = runtime.collaborationTouched
      ? collaborationModeValue(runtime.planMode, runtime.modelId!, level, runtime.planMode ? null : "")
      : undefined;
    const response = await this.#host.request("thread/settings/update", {
      threadId: runtime.threadId,
      effort: level,
      ...(collaborationMode === undefined ? {} : { collaborationMode })
    }, { mutation: true }).catch((error) => {
      throw this.#requestFailure(error, "dispatch", "CODEX_EFFORT_SWITCH_FAILED", true);
    });
    this.#assertRuntimeFence(runtime, context, response.hostGeneration);
    runtime.effort = level;
    runtime.nativeTasks.updateRoute(runtime.providerId, runtime.modelId, runtime.effort);
  }

  override async setFastMode(enabled: boolean, context: AdapterContext): Promise<void> {
    return this.#withNativeMutation(context, () => this.#setFastMode(enabled, context));
  }

  async #setFastMode(enabled: boolean, context: AdapterContext): Promise<void> {
    const runtime = await this.#requireRuntime(context);
    this.#assertStandardRuntime(runtime, "change Fast Mode");
    if (enabled) {
      const model = await this.#requireRuntimeModel(runtime);
      if (!model.supportsFastMode) {
        throw adapterError({
          code: "CODEX_FAST_MODE_UNAVAILABLE",
          message: "Fast Mode is not supported by the active Codex model.",
          phase: "dispatch",
          recovery: "Choose a model that advertises Fast Mode or leave it disabled."
        });
      }
    }
    const response = await this.#host.request("thread/settings/update", {
      threadId: runtime.threadId,
      serviceTier: enabled ? "fast" : null
    }, { mutation: true }).catch((error) => {
      throw this.#requestFailure(error, "dispatch", "CODEX_FAST_MODE_SWITCH_FAILED", true);
    });
    this.#assertRuntimeFence(runtime, context, response.hostGeneration);
    runtime.fastMode = enabled;
  }

  override async setPermissionMode(mode: PermissionMode, context: AdapterContext): Promise<void> {
    return this.#withNativeMutation(context, () => this.#setPermissionMode(mode, context));
  }

  async #setPermissionMode(mode: PermissionMode, context: AdapterContext): Promise<void> {
    if (mode === "bypassPermissions" && !context.target.trusted) {
      throw adapterError({
        code: "CODEX_FULL_ACCESS_REQUIRES_TRUST",
        message: "Full access requires a trusted Target.",
        phase: "dispatch",
        recovery: "Use ask mode or explicitly trust the Target through the product policy flow."
      });
    }
    const runtime = await this.#requireRuntime(context);
    this.#assertStandardRuntime(runtime, "change permission mode");
    const response = await this.#host.request("thread/resume", {
      threadId: runtime.threadId,
      excludeTurns: true,
      ...permissionParams(mode)
    }, { mutation: true }).catch((error) => { throw this.#requestFailure(error, "dispatch", "CODEX_PERMISSION_MODE_FAILED", true); });
    this.#assertRuntimeFence(runtime, context, response.hostGeneration);
    runtime.permissionMode = mode;
  }

  supportsDetachedSessionDeletion(context: AdapterContext): boolean {
    return context.runtimePolicy !== "review_read_only"
      && context.target.backendId === this.id
      && context.backendInstanceGeneration === this.#instanceGeneration;
  }

  override async setPlanMode(enabled: boolean, context: AdapterContext): Promise<void> {
    return this.#withNativeMutation(context, () => this.#setPlanMode(enabled, context));
  }

  async #setPlanMode(enabled: boolean, context: AdapterContext): Promise<void> {
    if (!supportsNativeCollaboration(this.#host.initializeResult?.userAgent)) {
      return this.unsupported("plan_mode");
    }
    const runtime = await this.#requireRuntime(context);
    this.#assertStandardRuntime(runtime, "change Plan mode");
    const model = await this.#requireRuntimeModel(runtime);
    const effort = runtime.effort !== undefined && model.thinkingLevels.includes(runtime.effort)
      ? runtime.effort
      : undefined;
    runtime.state.observedFastMode = undefined;
    const response = await this.#host.request("thread/settings/update", {
      threadId: runtime.threadId,
      collaborationMode: collaborationModeValue(enabled, model.modelId, effort, null)
    }, { mutation: true }).catch((error) => {
      throw this.#requestFailure(error, "dispatch", "CODEX_PLAN_MODE_FAILED", true);
    });
    this.#assertRuntimeFence(runtime, context, response.hostGeneration);
    runtime.planMode = enabled;
    runtime.collaborationTouched = true;
    runtime.defaultCollaborationMarkerPending = !enabled;
  }

  async readAccount(refreshToken = false): Promise<CodexAccountSnapshot> {
    try {
      const response = await this.#host.request("account/read", { refreshToken });
      const record = objectValue(response.value, "account read result");
      const account = record["account"];
      const requiresAuthentication = record["requiresOpenaiAuth"] === true;
      const snapshot = accountSnapshot(account, requiresAuthentication);
      this.#account = snapshot;
      if (!codexAccountModelsAvailable(snapshot.authenticationState)) this.#models = [];
      return snapshot;
    } catch (error) {
      this.#account = undefined;
      this.#models = [];
      throw error;
    }
  }

  async readAccountUsage(providerId: string, signal?: AbortSignal): Promise<CodexAccountUsageSnapshot> {
    this.#assertOpen();
    if (providerId !== this.#providerId) {
      throw adapterError({
        code: "CODEX_PROVIDER_ID_MISMATCH",
        message: "The selected Provider does not belong to this Codex Backend instance.",
        phase: "probe",
        recovery: "Refresh the Backend Provider catalog before reading account usage."
      });
    }
    const response = await this.#host.request("account/rateLimits/read", undefined, { signal });
    return {
      providerId: this.#providerId,
      ...parseAccountRateLimits(response.value, this.#now())
    };
  }

  async beginLogin(input: CodexLoginInput): Promise<CodexLoginResult> {
    const params: JsonObject = input.method === "api_key"
      ? { type: "apiKey", apiKey: input.apiKey }
      : input.method === "oauth_browser"
        ? { type: "chatgpt" }
        : { type: "chatgptDeviceCode" };
    const response = await this.#host.request("account/login/start", params, { mutation: true });
    const record = objectValue(response.value, "account login result");
    const type = stringValue(record["type"], "account login type");
    let result: CodexLoginResult;
    if (type === "apiKey" && input.method === "api_key") result = { method: "api_key" };
    else if (type === "chatgpt" && input.method === "oauth_browser") {
      result = {
        method: "oauth_browser",
        loginId: stringValue(record["loginId"], "login id"),
        url: loginUrl(record["authUrl"])
      };
    } else if (type === "chatgptDeviceCode" && input.method === "device_code") {
      result = {
        method: "device_code",
        loginId: stringValue(record["loginId"], "login id"),
        url: loginUrl(record["verificationUrl"]),
        userCode: stringValue(record["userCode"], "device code")
      };
    } else {
      throw adapterError({
        code: "CODEX_AUTH_PROTOCOL_INCOMPATIBLE",
        message: "The Codex app-server returned an unsupported stable login result.",
        phase: "probe",
        recovery: "Upgrade the adapter after reviewing the stable auth schema."
      });
    }
    this.#account = pendingAccountSnapshot(this.#account);
    this.#models = [];
    return result;
  }

  async cancelLogin(loginId: string): Promise<void> {
    if (loginId.length === 0 || loginId.length > 512 || /[\u0000-\u001f]/.test(loginId)) {
      throw adapterError({
        code: "CODEX_LOGIN_ID_INVALID",
        message: "The Codex login identity is invalid.",
        phase: "probe",
        recovery: "Start a new native login flow."
      });
    }
    await this.#host.request("account/login/cancel", { loginId }, { mutation: true });
    await this.readAccount(true).catch(() => { this.#account = undefined; });
  }

  async logout(): Promise<void> {
    await this.#host.request("account/logout", undefined, { mutation: true });
    this.#account = accountSnapshot(null, true);
    this.#models = [];
  }

  async listModels(): Promise<readonly ProviderModel[]> {
    this.#assertOpen();
    const account = this.#account ?? await this.readAccount();
    if (!codexAccountModelsAvailable(account.authenticationState)) {
      this.#models = this.#withManagedModels([]);
      return this.#models;
    }
    const models: ProviderModel[] = [];
    const nativeIds = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    try {
      do {
        if (pages >= this.#maximumPaginationPages) {
          throw paginationError("CODEX_MODEL_PAGINATION_LIMIT", "model discovery");
        }
        const pageLimit = Math.min(100, this.#maximumModels - models.length);
        const response = await this.#host.request("model/list", {
          limit: pageLimit,
          includeHidden: true,
          ...(cursor === undefined ? {} : { cursor })
        });
        pages += 1;
        const page = parseModels(response.value, pageLimit);
        for (const native of page.models) {
          const identity = `${native.id}\0${native.model}`;
          if (nativeIds.has(identity)) continue;
          nativeIds.add(identity);
          models.push(modelFromNative(native, this.#providerId));
          if (models.length >= this.#maximumModels) {
            this.#models = this.#withManagedModels(models);
            return this.#models;
          }
        }
        cursor = nextPaginationCursor(page.nextCursor, seenCursors, "CODEX_MODEL_PAGINATION_INVALID", "model discovery");
      } while (cursor !== undefined);
      this.#models = this.#withManagedModels(models);
      return this.#models;
    } catch (error) {
      this.#models = [];
      throw this.#requestFailure(error, "probe", "CODEX_MODEL_DISCOVERY_FAILED", false);
    }
  }

  dispose(): Promise<void> {
    if (this.#disposeFlight !== undefined) return this.#disposeFlight;
    if (this.#disposed) return Promise.resolve();
    this.#disposed = true;
    this.#managedProviders?.dispose();
    const flight = this.#disposeRuntimes();
    this.#disposeFlight = flight;
    return flight;
  }

  forceDispose(): Promise<void> {
    if (this.#forceDisposeFlight !== undefined) return this.#forceDisposeFlight;
    this.#disposed = true;
    this.#managedProviders?.dispose();
    const flight = this.#forceDisposeRuntimes();
    this.#forceDisposeFlight = flight;
    return flight;
  }

  async #disposeRuntimes(): Promise<void> {
    const runtimes = [...this.#sessions.values()];
    for (const runtime of runtimes) runtime.dispatchLifetime.abort();
    await Promise.allSettled(runtimes.map((runtime) => this.#emitNativeTaskPayloads(
      runtime,
      runtime.nativeTasks.terminateActive("stopped"),
      runtime.hostGeneration,
      "runtime/disposed",
      false,
      false
    )));
    this.#sessions.clear();
    for (const runtime of runtimes) {
      runtime.closed = true;
      this.#settleCompaction(runtime, adapterError({
        code: "CODEX_COMPACTION_INTERRUPTED",
        message: "The Codex Backend instance closed during native compaction.",
        phase: "shutdown",
        stateMayHaveChanged: true,
        recovery: "Resume the native thread and inspect its compaction state."
      }));
      this.#cancelPendingServerRequests(runtime);
    }
    await Promise.allSettled(runtimes.map((runtime) => this.#releaseRuntimeSubscription(runtime, false)));
    if (this.#ownsHost) await this.#host.shutdown();
  }

  async #forceDisposeRuntimes(): Promise<void> {
    const runtimes = [...this.#sessions.values()];
    for (const runtime of runtimes) runtime.dispatchLifetime.abort();
    await Promise.allSettled(runtimes.map((runtime) => this.#emitNativeTaskPayloads(
      runtime,
      runtime.nativeTasks.terminateActive("stopped"),
      runtime.hostGeneration,
      "runtime/force_disposed",
      false,
      false
    )));
    this.#sessions.clear();
    for (const runtime of runtimes) {
      runtime.closed = true;
      this.#settleCompaction(runtime, adapterError({
        code: "CODEX_COMPACTION_INTERRUPTED",
        message: "The Codex Backend instance was hard-retired during native compaction.",
        phase: "shutdown",
        stateMayHaveChanged: true,
        recovery: "Resume the native thread and inspect its compaction state."
      }));
      this.#cancelPendingServerRequests(runtime);
    }
    await Promise.allSettled(runtimes.map((runtime) => this.#releaseRuntimeSubscription(runtime, false)));
    if (this.#ownsHost) await this.#host.forceShutdown();
  }

  async #resumeNativeThread(
    threadId: string,
    workspaceRoot: string,
    expectedHostGeneration: number,
    selection?: { readonly providerId: string; readonly modelId: string },
    managedRoute?: ManagedProviderRouteBinding
  ) {
    const response = await this.#host.request("thread/resume", {
      threadId,
      cwd: workspaceRoot,
      excludeTurns: true,
      ...(selection === undefined ? {} : { modelProvider: selection.providerId, model: selection.modelId }),
      ...(this.#nativeRouteConfiguration(managedRoute) === undefined ? {} : { config: this.#nativeRouteConfiguration(managedRoute)! })
    }, { mutation: false });
    if (response.hostGeneration !== expectedHostGeneration) {
      throw adapterError({
        code: "CODEX_RUNTIME_GENERATION_STALE",
        message: "The Codex app-server generation changed while proving native Session continuity.",
        phase: "provision",
        stateMayHaveChanged: false,
        recovery: "Retry native Session resume through the current Backend instance."
      });
    }
    const thread = parseThreadResult(response.value);
    await assertNativeThreadTarget(thread, threadId, workspaceRoot, "provision");
    this.#assertManagedRouteResponse(objectValue(response.value, "resume response"), managedRoute);
    return response;
  }

  async #readValidatedNativeThread(
    threadId: string,
    target: TargetDescriptor,
    phase: "probe" | "provision"
  ): Promise<{
    readonly thread: NativeThread;
    readonly hostGeneration: number;
    readonly workspaceRoot: string;
  }> {
    const workspaceRoot = await realpath(target.workspaceRoot);
    const response = await this.#host.request("thread/read", { threadId, includeTurns: false });
    const thread = parseThreadResult(response.value);
    await assertNativeThreadTarget(thread, threadId, workspaceRoot, phase);
    return { thread, hostGeneration: response.hostGeneration, workspaceRoot };
  }

  async #requireRuntime(context: AdapterContext): Promise<SessionRuntime> {
    this.#assertBackendContext(context);
    const runtime = this.#sessions.get(context.sessionId);
    if (runtime !== undefined && this.#matchesCoreFence(runtime, context) && this.#host.isActiveGeneration(runtime.hostGeneration)) {
      runtime.context = context;
      return runtime;
    }
    if (context.runtimePolicy === "review_read_only") throw invalidReviewProfile();
    const binding = context.binding;
    if (binding === undefined) {
      throw adapterError({
        code: "CODEX_SESSION_BINDING_REQUIRED",
        message: "The Codex operation requires an attached native thread.",
        phase: "provision",
        recovery: "Resume or create the Session before dispatching work."
      });
    }
    await this.resumeSession(binding, context);
    const resumed = this.#sessions.get(context.sessionId);
    if (resumed === undefined) {
      throw adapterError({
        code: "CODEX_SESSION_RESUME_FAILED",
        message: "The Codex native thread did not become active.",
        phase: "provision",
        recovery: "Refresh the native Session binding and retry."
      });
    }
    return resumed;
  }

  #withManagedModels(models: readonly ProviderModel[]): readonly ProviderModel[] {
    const managed = this.#managedProviders?.listModels() ?? [];
    if (managed.some((model) => model.providerId === this.#providerId)) throw managedRouteUnavailable();
    return [...models.filter((model) => model.providerId === this.#providerId), ...managed];
  }

  async #prepareManagedRoute(providerId: string | undefined, modelId: string | undefined, context: AdapterContext): Promise<ManagedProviderRouteBinding | undefined> {
    if (providerId === undefined) return undefined;
    if (!this.#managedProviders?.hasProvider(providerId)) {
      if (providerId !== this.#providerId) throw managedRouteUnavailable();
      return undefined;
    }
    if (providerId === this.#providerId || modelId === undefined) throw managedRouteUnavailable();
    const route = await this.#managedProviders.prepare({
      backendId: this.id,
      backendInstanceGeneration: this.#instanceGeneration,
      targetId: context.target.id,
      sessionId: context.sessionId,
      sessionGeneration: context.generation,
      providerId,
      modelId
    });
    try {
      this.#assertBackendContext(context);
      assertDispatchNotCancelled(context.signal);
      if (route.providerId !== providerId || route.model.providerId !== providerId || route.model.modelId !== modelId || route.protocol !== "openai-responses") throw managedRouteUnavailable();
      route.assertCurrent();
      return route;
    } catch (error) {
      route.dispose();
      throw error;
    }
  }

  #nativeRouteConfiguration(route?: ManagedProviderRouteBinding): JsonObject | undefined {
    if (this.#managedProviders === undefined) return undefined;
    return {
      "shell_environment_policy.exclude": [...this.#managedProviders.secretEnvironmentNames],
      ...(route === undefined ? {} : {
        model_providers: { [route.providerId]: {
          name: route.providerId,
          base_url: route.baseUrl,
          wire_api: "responses",
          env_key: route.apiKeyEnvironment,
          requires_openai_auth: false,
          supports_websockets: false,
          request_max_retries: 0,
          stream_max_retries: 0
        } }
      })
    };
  }

  #assertManagedRouteResponse(record: JsonObject, route?: ManagedProviderRouteBinding): void {
    if (route !== undefined && (record["modelProvider"] !== route.providerId || record["model"] !== route.model.modelId)) {
      throw managedRouteUnavailable(true);
    }
  }

  async #activateManagedOperation(runtime: SessionRuntime, context: AdapterContext): Promise<void> {
    if (runtime.routeUnknown) throw managedRouteUnavailable(true);
    const route = runtime.managedRoute;
    if (route === undefined) {
      if (runtime.providerId !== undefined && this.#managedProviders?.hasProvider(runtime.providerId)) throw managedRouteUnavailable();
      return;
    }
    if (runtime.managedOperation !== undefined || context.operationId === undefined) throw managedRouteUnavailable();
    route.assertCurrent();
    const operation: NonNullable<SessionRuntime["managedOperation"]> = { id: context.operationId };
    runtime.managedOperation = operation;
    const signal = AbortSignal.any([context.signal, runtime.dispatchLifetime.signal]);
    const assertCurrent = () => {
      assertDispatchNotCancelled(signal);
      if (runtime.managedOperation !== operation || !this.#isRuntimeCurrent(runtime, runtime.hostGeneration)) throw managedRouteUnavailable();
    };
    try {
      const lease = await route.activate({ operationId: operation.id, signal, assertCurrent });
      try { assertCurrent(); } catch (error) { lease.release(); throw error; }
      operation.lease = lease;
    } catch (error) {
      if (runtime.managedOperation === operation) runtime.managedOperation = undefined;
      throw error;
    }
  }

  #releaseManagedOperation(runtime: SessionRuntime): void {
    const operation = runtime.managedOperation;
    runtime.managedOperation = undefined;
    operation?.lease?.release();
  }

  async #switchNativeRoute(runtime: SessionRuntime, providerId: string, modelId: string, context: AdapterContext): Promise<SessionRuntime> {
    if (runtime.state.activeTurnId !== undefined || runtime.compaction !== undefined || runtime.nativeTasks.hasActiveTasks()) throw managedRouteUnavailable();
    const route = await this.#prepareManagedRoute(providerId, modelId, context);
    const generation = runtime.hostGeneration;
    const assertCurrent = () => {
      assertDispatchNotCancelled(context.signal);
      this.#assertRuntimeFence(runtime, context, generation);
    };
    try {
      assertCurrent();
      // Native resume on an already loaded thread ignores changed Provider config.
      await this.#releaseRuntimeSubscription(runtime, false);
      assertCurrent();
      await this.#host.releaseUnboundThread(runtime.threadId, generation);
      assertCurrent();
      const response = await this.#resumeNativeThread(runtime.threadId, runtime.targetWorkspaceRoot, generation, { providerId, modelId }, route);
      assertCurrent();
      const record = objectValue(response.value, "route resume response");
      if (record["modelProvider"] !== providerId || record["model"] !== modelId) throw managedRouteUnavailable(true);
      const next = await this.#installRuntime({
        thread: parseThreadResult(response.value), binding: runtime.binding, context, hostGeneration: generation,
        permissionMode: runtime.permissionMode, providerId, modelId, managedRoute: route,
        effort: runtime.effort, fastMode: runtime.fastMode, name: runtime.name
      });
      next.planMode = runtime.planMode;
      next.collaborationTouched = runtime.collaborationTouched;
      next.defaultCollaborationMarkerPending = runtime.defaultCollaborationMarkerPending;
      return next;
    } catch (error) {
      route?.dispose();
      runtime.routeUnknown = true;
      throw managedRouteUnavailable(true);
    }
  }

  async #validateModelSelection(
    providerId: string | undefined,
    modelId: string | undefined,
    effort: string | undefined,
    fastMode: boolean
  ): Promise<ProviderModel | undefined> {
    if ((providerId === undefined) !== (modelId === undefined)) {
      throw adapterError({
        code: "CODEX_MODEL_SELECTION_INCOMPLETE",
        message: "Codex model selection requires both Provider and model identity.",
        phase: "provision",
        recovery: "Choose a complete model entry from the current Codex catalog."
      });
    }
    if (providerId === undefined || modelId === undefined) {
      if (effort === undefined && !fastMode) return undefined;
      throw adapterError({
        code: "CODEX_MODEL_SELECTION_REQUIRED",
        message: "Reasoning effort and Fast Mode require an explicit Codex model.",
        phase: "provision",
        recovery: "Choose a model before configuring its reasoning controls."
      });
    }
    const models = this.#models.length === 0 ? await this.listModels() : this.#models;
    const model = models.find((candidate) => candidate.providerId === providerId && candidate.modelId === modelId);
    if (model === undefined) {
      throw adapterError({
        code: "CODEX_MODEL_UNAVAILABLE",
        message: "The selected model is not present in the current Codex catalog.",
        phase: "provision",
        recovery: "Refresh the model catalog and choose an available model."
      });
    }
    if (effort !== undefined && !model.thinkingLevels.includes(effort)) {
      throw adapterError({
        code: "CODEX_EFFORT_UNAVAILABLE",
        message: "The selected reasoning effort is not supported by this Codex model.",
        phase: "provision",
        recovery: "Choose one of the reasoning levels advertised for the selected model."
      });
    }
    if (fastMode && !model.supportsFastMode) {
      throw adapterError({
        code: "CODEX_FAST_MODE_UNAVAILABLE",
        message: "Fast Mode is not supported by the selected Codex model.",
        phase: "provision",
        recovery: "Disable Fast Mode or choose a model that advertises it."
      });
    }
    return model;
  }

  async #requireRuntimeModel(runtime: SessionRuntime): Promise<ProviderModel> {
    const providerId = runtime.providerId;
    const modelId = runtime.modelId;
    if (providerId === undefined || modelId === undefined) {
      throw adapterError({
        code: "CODEX_MODEL_SELECTION_REQUIRED",
        message: "The active Codex runtime has no explicit model selection.",
        phase: "dispatch",
        recovery: "Select a model before changing its reasoning controls."
      });
    }
    const models = this.#models.length === 0 ? await this.listModels() : this.#models;
    const model = models.find((candidate) => candidate.providerId === providerId && candidate.modelId === modelId);
    if (model === undefined) {
      throw adapterError({
        code: "CODEX_MODEL_UNAVAILABLE",
        message: "The active model is no longer present in the Codex catalog.",
        phase: "dispatch",
        recovery: "Refresh the catalog and select an available model."
      });
    }
    return model;
  }

  async #buildReviewThreadProfile(cwd: string, reviewWorkingDirectory: string): Promise<JsonObject> {
    await this.#host.ensureStarted();
    if (!supportsIsolatedReview(this.#host.initializeResult?.userAgent)) {
      throw reviewRuntimeUnsupported(this.#host.initializeResult?.userAgent);
    }

    let skillInventory: ReviewSkillInventory;
    let config: JsonObject;
    try {
      const skills = await this.#host.request("skills/list", { cwds: [cwd], forceReload: false });
      skillInventory = reviewSkillInventory(skills.value, cwd);
      const configResponse = await this.#host.request("config/read", { cwd, includeLayers: false });
      config = reviewEffectiveConfig(configResponse.value);
    } catch (error) {
      throw this.#requestFailure(error, "provision", "CODEX_REVIEW_INVENTORY_UNAVAILABLE", false);
    }

    const configuredMcp = optionalReviewObject(config["mcp_servers"]);
    const configuredPlugins = optionalReviewObject(config["plugins"]);
    const configuredMcpNames = new Set<string>();
    const transportMcpNames = new Set<string>();
    for (const [name, rawConfig] of Object.entries(configuredMcp)) {
      if (!hasReviewMcpTransport(rawConfig)) continue;
      configuredMcpNames.add(name);
      transportMcpNames.add(name);
    }
    const pluginIds = new Set([...Object.keys(configuredPlugins), ...skillInventory.pluginIds]);
    const pluginMcp = new Map<string, Set<string>>();
    for (const [pluginId, rawPlugin] of Object.entries(configuredPlugins)) {
      const servers = optionalReviewObject(optionalReviewObject(rawPlugin)["mcp_servers"]);
      const names = new Set<string>();
      for (const [name, rawConfig] of Object.entries(servers)) {
        if (!hasReviewMcpTransport(rawConfig)) continue;
        names.add(name);
        transportMcpNames.add(name);
      }
      if (names.size > 0) pluginMcp.set(pluginId, names);
    }

    const observedMcpNames = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < REVIEW_MAXIMUM_INVENTORY_PAGES; page += 1) {
      let response;
      try {
        response = await this.#host.request("mcpServerStatus/list", {
          cursor,
          limit: 100,
          detail: "toolsAndAuthOnly",
          threadId: null
        });
      } catch (error) {
        throw this.#requestFailure(error, "provision", "CODEX_REVIEW_INVENTORY_UNAVAILABLE", false);
      }
      const pageResult = reviewMcpStatusPage(response.value);
      for (const name of pageResult.names) {
        observedMcpNames.add(name);
        if (observedMcpNames.size > REVIEW_MAXIMUM_INVENTORY_ITEMS) throw reviewInventoryInvalid();
      }
      if (pageResult.nextCursor === null) break;
      if (cursors.has(pageResult.nextCursor)) throw reviewInventoryInvalid();
      cursors.add(pageResult.nextCursor);
      cursor = pageResult.nextCursor;
      if (page + 1 === REVIEW_MAXIMUM_INVENTORY_PAGES) throw reviewInventoryInvalid();
    }
    const unknownMcpNames = [...observedMcpNames]
      .filter((name) => name !== "codex_apps" && !transportMcpNames.has(name));
    if (unknownMcpNames.length > 0) throw reviewInventoryInvalid();

    const reviewConfig: JsonObject = { web_search: "disabled" };
    for (const feature of REVIEW_DISABLED_FEATURES) reviewConfig[`features.${feature}`] = false;
    if (skillInventory.paths.size > 0) {
      reviewConfig["skills.config"] = [...skillInventory.paths]
        .sort()
        .map((path): JsonObject => ({ path, enabled: false }));
    }
    for (const name of configuredMcpNames) {
      reviewConfig[`mcp_servers.${renderReviewConfigSegment(name)}.enabled`] = false;
    }
    for (const pluginId of pluginIds) {
      reviewConfig[`plugins.${quoteReviewConfigSegment(pluginId)}.enabled`] = false;
      for (const name of pluginMcp.get(pluginId) ?? []) {
        reviewConfig[
          `plugins.${quoteReviewConfigSegment(pluginId)}.mcp_servers.${renderReviewConfigSegment(name)}.enabled`
        ] = false;
      }
    }
    const workspacePermissions: JsonObject = { ".": "read" };
    for (const pattern of REVIEW_CREDENTIAL_GLOB_PATTERNS) workspacePermissions[pattern] = "deny";
    reviewConfig[`permissions.${REVIEW_PERMISSION_PROFILE}`] = {
      filesystem: {
        ":root": "deny",
        ":minimal": "read",
        ":tmpdir": "deny",
        ":slash_tmp": "deny",
        [reviewWorkingDirectory]: { ".": "read" },
        ":workspace_roots": workspacePermissions
      },
      network: { enabled: false }
    };

    return {
      approvalPolicy: "never",
      config: reviewConfig,
      cwd: reviewWorkingDirectory,
      dynamicTools: reviewDynamicToolSpecs(),
      environments: [],
      ephemeral: true,
      permissions: REVIEW_PERMISSION_PROFILE,
      runtimeWorkspaceRoots: [cwd],
      selectedCapabilityRoots: [],
      serviceTier: null
    };
  }

  async #installRuntime(input: {
    readonly managedRoute?: ManagedProviderRouteBinding | undefined;
    readonly thread: NativeThread;
    readonly binding: NativeSessionBinding;
    readonly context: AdapterContext;
    readonly hostGeneration: number;
    readonly permissionMode: PermissionMode;
    readonly providerId?: string;
    readonly modelId?: string;
    readonly effort?: string;
    readonly fastMode?: boolean;
    readonly observedFastMode?: boolean;
    readonly name?: string;
    readonly reviewWorkingDirectory?: string;
  }): Promise<SessionRuntime> {
    const targetWorkspaceRoot = await realpath(input.context.target.workspaceRoot);
    await assertNativeThreadTarget(
      input.thread,
      threadIdFromBinding(input.binding),
      input.reviewWorkingDirectory ?? targetWorkspaceRoot,
      "provision"
    );
    const previous = this.#sessions.get(input.context.sessionId);
    if (previous !== undefined) {
      previous.dispatchLifetime.abort();
      await this.#emitNativeTaskPayloads(
        previous,
        previous.nativeTasks.terminateActive("stopped"),
        previous.hostGeneration,
        "runtime/replaced",
        false,
        false
      ).catch(() => undefined);
      previous.closed = true;
      this.#settleCompaction(previous, adapterError({
        code: "CODEX_COMPACTION_INTERRUPTED",
        message: "The Codex native runtime changed during compaction.",
        phase: "stream",
        stateMayHaveChanged: true,
        recovery: "Inspect the resumed native thread before sending more work."
      }));
      this.#sessions.delete(input.context.sessionId);
      this.#cancelPendingServerRequests(previous);
      await this.#releaseRuntimeSubscription(previous, false);
    }
    const state = createTranslatorState();
    if (input.thread.status?.["type"] === "active") {
      const lastTurn = input.thread.turns.at(-1);
      if (lastTurn?.status === "inProgress") state.activeTurnId = lastTurn.id;
    }
    const nativeTasks = new CodexNativeTaskProjection({
      sessionId: input.context.sessionId,
      rootThreadId: input.thread.id,
      providerId: input.providerId,
      modelId: input.modelId,
      thinkingLevel: input.effort,
      now: this.#now
    });
    const seededDescendants = input.context.runtimePolicy === "review_read_only"
      ? []
      : nativeTasks.seed(input.thread);
    const runtime: SessionRuntime = {
      managedRoute: input.managedRoute,
      managedOperation: undefined,
      routeUnknown: false,
      sessionId: input.context.sessionId,
      threadId: input.thread.id,
      targetId: input.context.target.id,
      targetWorkspaceRoot,
      binding: input.binding,
      sessionGeneration: input.context.generation,
      backendInstanceGeneration: backendGeneration(input.context),
      dispatchLifetime: new AbortController(),
      context: input.context,
      hostGeneration: input.hostGeneration,
      state,
      pendingServerRequests: new Map(),
      nativeTasks,
      ...(input.providerId === undefined ? {} : { providerId: input.providerId }),
      ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
      ...(input.effort === undefined ? {} : { effort: input.effort }),
      fastMode: input.fastMode ?? false,
      ...(input.name === undefined ? {} : { name: input.name }),
      permissionMode: input.permissionMode,
      planMode: false,
      collaborationTouched: false,
      defaultCollaborationMarkerPending: false,
      runtimePolicy: input.context.runtimePolicy === "review_read_only" ? "review_read_only" : "standard",
      ...(input.reviewWorkingDirectory === undefined ? {} : { reviewWorkingDirectory: input.reviewWorkingDirectory }),
      closed: false,
      rewindUnknown: false,
      disconnectTerminalEmitted: false
    };
    this.#sessions.set(input.context.sessionId, runtime);
    runtime.state.observedFastMode = input.observedFastMode;
    try {
      const subscriptionFlight = this.#host.subscribe(input.thread.id, input.hostGeneration, {
        onNotification: async (method, params) => {
          if (!this.#isRuntimeCurrent(runtime, input.hostGeneration)) return;
          if (method === "serverRequest/resolved") {
            this.#resolvePendingServerRequest(runtime, params);
            return;
          }
          if (!this.#acceptTurnNotification(runtime, method, params)) return;
          if (method === "turn/completed") this.#releaseManagedOperation(runtime);
          const events = this.#translator.translate(method, params, runtime.state);
          for (const event of events) {
            if (!this.#isRuntimeCurrent(runtime, input.hostGeneration)) return;
            await runtime.context.emit(event, {
              namespace: "codex.app_server",
              fields: { method }
            });
          }
          reconcileRuntimeSettings(runtime, method, params);
          if (runtime.runtimePolicy === "standard") {
            await this.#applyNativeTaskEffects(
              runtime,
              runtime.nativeTasks.observeRootNotification(method, params),
              input.hostGeneration,
              method,
              false
            );
          }
          const compaction = compactionTerminal(method, params);
          if (compaction === "completed") this.#settleCompaction(runtime);
          if (compaction === "failed") {
            this.#settleCompaction(runtime, adapterError({
              code: "CODEX_COMPACTION_FAILED",
              message: "The Codex native compaction did not complete.",
              phase: "stream",
              stateMayHaveChanged: true,
              recovery: "Inspect the native thread before retrying compaction."
            }));
          }
        },
        onDescendantThreadStarted: async (params) => {
          if (!this.#isRuntimeCurrent(runtime, input.hostGeneration) || runtime.runtimePolicy !== "standard") return;
          await this.#applyNativeTaskEffects(
            runtime,
            runtime.nativeTasks.observeDescendantThreadStarted(params),
            input.hostGeneration,
            "thread/started",
            true
          );
        },
        onDescendantNotification: async (threadId, method, params) => {
          if (!this.#isRuntimeCurrent(runtime, input.hostGeneration) || runtime.runtimePolicy !== "standard") return;
          if (method === "serverRequest/resolved") {
            this.#resolvePendingServerRequest(runtime, params);
            return;
          }
          const turnId = turnIdFromParams(params);
          if (method === "turn/completed" && turnId !== undefined) {
            this.#cancelPendingServerRequests(
              runtime,
              (pending) => pending.threadId === threadId && pending.turnId === turnId
            );
          }
          await this.#applyNativeTaskEffects(
            runtime,
            runtime.nativeTasks.observeDescendantNotification(threadId, method, params),
            input.hostGeneration,
            method,
            true
          );
        },
        onRequest: async (requestId, method, params) => {
          if (!this.#isRuntimeCurrent(runtime, input.hostGeneration)) return undefined;
          const turnId = turnIdFromParams(params);
          const requestThreadId = threadIdFromParams(params);
          const rootRequest = requestThreadId === runtime.threadId
            && turnId !== undefined
            && runtime.state.activeTurnId === turnId
            && !runtime.state.terminalTurnIds.has(turnId);
          const descendantRequest = requestThreadId !== undefined
            && turnId !== undefined
            && runtime.nativeTasks.ownsActiveTurn(requestThreadId, turnId);
          if (!rootRequest && !descendantRequest) return undefined;
          if (runtime.runtimePolicy === "review_read_only") {
            const response = method === "item/tool/call"
              ? await executeReviewDynamicTool(runtime.targetWorkspaceRoot, params)
              : reviewDeniedServerRequest(method, params);
            if (!this.#isRuntimeCurrent(runtime, input.hostGeneration)
              || runtime.state.activeTurnId !== turnId
              || runtime.state.terminalTurnIds.has(turnId)) return undefined;
            return response;
          }
          if (descendantRequest && method === "item/tool/requestUserInput") return { answers: {} };
          const interaction = interactionFromServerRequest(requestId, method, params, runtime.context.target.workspaceRoot);
          if (interaction === undefined) return undefined;
          const key = rpcRequestKey(requestId);
          if (runtime.pendingServerRequests.has(key)) return undefined;
          const abort = new AbortController();
          let cancel!: () => void;
          const cancelled = new Promise<void>((resolve) => { cancel = resolve; });
          const pending: PendingServerRequest = {
            threadId: requestThreadId!,
            turnId,
            cancelled: false,
            cancel: () => {
              if (pending.cancelled) return;
              pending.cancelled = true;
              abort.abort();
              cancel();
            }
          };
          runtime.pendingServerRequests.set(key, pending);
          const requestContext = runtime.context;
          try {
            const outcome = await Promise.race([
              Promise.resolve().then(() => requestContext.requestInteraction(
                interaction.payload,
                { signal: abort.signal }
              )).then(
                (decision) => ({ kind: "decision" as const, decision }),
                () => ({ kind: "cancelled" as const })
              ),
              cancelled.then(() => ({ kind: "cancelled" as const }))
            ]);
            if (outcome.kind !== "decision"
              || pending.cancelled
              || runtime.pendingServerRequests.get(key) !== pending
              || !this.#isRuntimeCurrent(runtime, input.hostGeneration)
              || !(requestThreadId === runtime.threadId
                ? runtime.state.activeTurnId === turnId && !runtime.state.terminalTurnIds.has(turnId)
                : runtime.nativeTasks.ownsActiveTurn(requestThreadId!, turnId!))) return undefined;
            return interaction.toResponse(outcome.decision);
          } finally {
            if (runtime.pendingServerRequests.get(key) === pending) {
              runtime.pendingServerRequests.delete(key);
            }
          }
        },
        onDisconnect: async (fault) => {
          if (!this.#matchesCallbackFence(runtime, input.hostGeneration) || runtime.disconnectTerminalEmitted) return;
          runtime.dispatchLifetime.abort();
          runtime.managedRoute?.dispose();
          runtime.disconnectTerminalEmitted = true;
          this.#cancelPendingServerRequests(runtime);
          runtime.state.activeTurnId = undefined;
          const context = runtime.context;
          await this.#emitNativeTaskPayloads(
            runtime,
            runtime.nativeTasks.terminateActive("failed", {
              code: "CODEX_SUBAGENT_RUNTIME_LOST",
              message: "The native delegated run lost its owning app-server connection.",
              phase: "stream",
              retryable: true,
              stateMayHaveChanged: true,
              recovery: "Reconnect and inspect the parent native thread before starting new delegated work."
            }),
            input.hostGeneration,
            "runtime/disconnected",
            true,
            false
          );
          if (!this.#matchesCallbackFence(runtime, input.hostGeneration)) return;
          await context.emit({
            type: "error",
            error: {
              code: "CODEX_APP_SERVER_DISCONNECTED",
              message: "The Codex app-server disconnected during the native Session.",
              phase: "stream",
              retryable: true,
              stateMayHaveChanged: fault.stateMayHaveChanged,
              recovery: "Reconnect and resume the native thread before sending additional work."
            },
            terminal: true
          }, { namespace: "codex.app_server", fields: { state: "disconnected" } });
          if (!this.#matchesCallbackFence(runtime, input.hostGeneration)) return;
          await context.emit({ type: "done", outcome: "failed" }, {
            namespace: "codex.app_server",
            fields: { state: "disconnected" }
          });
          this.#settleCompaction(runtime, adapterError({
            code: "CODEX_COMPACTION_INTERRUPTED",
            message: "The Codex app-server disconnected during native compaction.",
            phase: "stream",
            retryable: true,
            stateMayHaveChanged: true,
            recovery: "Reconnect and inspect the native thread before sending more work."
          }));
        }
      });
      runtime.subscriptionFlight = subscriptionFlight;
      const subscription = await subscriptionFlight;
      runtime.subscriptionFlight = undefined;
      runtime.subscription = subscription;
      if (!this.#isRuntimeCurrent(runtime, input.hostGeneration)) {
        await subscription.release({ unsubscribe: false });
        this.#assertOpen();
        throw adapterError({
          code: "CODEX_RUNTIME_GENERATION_STALE",
          message: "The Codex runtime changed while its native subscription was being installed.",
          phase: "provision",
          stateMayHaveChanged: false,
          recovery: "Resume the native Session through the current Backend instance."
        });
      }
      for (const lineage of seededDescendants) {
        await this.#host.registerDescendantThread(
          lineage.childThreadId,
          lineage.parentThreadId,
          input.hostGeneration
        );
      }
      return runtime;
    } catch (error) {
      runtime.dispatchLifetime.abort();
      runtime.closed = true;
      if (this.#sessions.get(input.context.sessionId) === runtime) this.#sessions.delete(input.context.sessionId);
      this.#cancelPendingServerRequests(runtime);
      await this.#releaseRuntimeSubscription(runtime, false).catch(() => undefined);
      if (this.#disposed) this.#assertOpen();
      throw error;
    }
  }

  async #applyNativeTaskEffects(
    runtime: SessionRuntime,
    effects: CodexNativeTaskEffects,
    hostGeneration: number,
    method: string,
    descendant: boolean
  ): Promise<void> {
    await this.#emitNativeTaskPayloads(
      runtime,
      effects.emissions,
      hostGeneration,
      method,
      descendant,
      true
    );
    for (const lineage of effects.lineages) {
      if (!this.#isRuntimeCurrent(runtime, hostGeneration)) return;
      await this.#host.registerDescendantThread(
        lineage.childThreadId,
        lineage.parentThreadId,
        hostGeneration
      );
    }
  }

  async #emitNativeTaskPayloads(
    runtime: SessionRuntime,
    payloads: readonly Extract<import("@joko/core").EventPayload, {
      readonly type: "background_task" | "subagent_run" | "subagent_transcript";
    }>[],
    hostGeneration: number,
    method: string,
    descendant: boolean,
    requireHostActive: boolean
  ): Promise<void> {
    for (const payload of payloads) {
      if (!this.#matchesCallbackFence(runtime, hostGeneration)
        || (requireHostActive && !this.#host.isActiveGeneration(hostGeneration))) return;
      await runtime.context.emit(payload, {
        namespace: "codex.native_tasks",
        fields: { method, descendant }
      });
    }
  }

  #acceptTurnNotification(runtime: SessionRuntime, method: string, params: JsonValue): boolean {
    const turnId = turnIdFromParams(params);
    if (method === "turn/started") {
      if (turnId === undefined || runtime.state.terminalTurnIds.has(turnId)) return false;
      if (runtime.state.activeTurnId !== undefined && runtime.state.activeTurnId !== turnId) return false;
      this.#cancelPendingServerRequests(
        runtime,
        (pending) => pending.threadId === runtime.threadId && pending.turnId !== turnId
      );
      return true;
    }
    if (method === "turn/completed") {
      if (turnId === undefined) return false;
      this.#cancelPendingServerRequests(
        runtime,
        (pending) => pending.threadId === runtime.threadId && pending.turnId === turnId
      );
      return true;
    }
    if (method.startsWith("item/")) {
      return turnId !== undefined
        && runtime.state.activeTurnId === turnId
        && !runtime.state.terminalTurnIds.has(turnId);
    }
    return true;
  }

  #resolvePendingServerRequest(runtime: SessionRuntime, params: JsonValue): void {
    if (!isJsonObject(params)) return;
    const requestId = params["requestId"];
    if (typeof requestId !== "string" && typeof requestId !== "number") return;
    const pending = runtime.pendingServerRequests.get(rpcRequestKey(requestId));
    if (pending === undefined) return;
    runtime.pendingServerRequests.delete(rpcRequestKey(requestId));
    pending.cancel();
  }

  #cancelPendingServerRequests(
    runtime: SessionRuntime,
    predicate: (pending: PendingServerRequest) => boolean = () => true
  ): void {
    for (const [key, pending] of runtime.pendingServerRequests) {
      if (!predicate(pending)) continue;
      runtime.pendingServerRequests.delete(key);
      pending.cancel();
    }
  }

  async #releaseRuntimeSubscription(runtime: SessionRuntime, unsubscribe: boolean): Promise<void> {
    this.#releaseManagedOperation(runtime);
    runtime.managedRoute?.dispose();
    try {
      const flight = runtime.subscriptionFlight;
      const subscription = runtime.subscription ?? (flight === undefined ? undefined : await flight.catch(() => undefined));
      runtime.subscriptionFlight = undefined;
      if (subscription === undefined) return;
      runtime.subscription = subscription;
      await subscription.release({ unsubscribe });
    } finally {
      if (runtime.reviewWorkingDirectory !== undefined) {
        await removeReviewWorkingDirectory(runtime.reviewWorkingDirectory);
      }
    }
  }

  async #reconcileClientMessage(runtime: SessionRuntime, context: AdapterContext, clientId: string, expectedTurnId?: string): Promise<boolean> {
    try {
      const history = await this.#readCompleteHistory(runtime, context);
      history.assertCurrent();
      for (const turn of history.thread.turns) {
        if (expectedTurnId !== undefined && turn.id !== expectedTurnId) continue;
        for (const item of turn.items) {
          if (item.type === "userMessage" && item["clientId"] === clientId) {
            history.assertCurrent();
            if (expectedTurnId === undefined
              && (runtime.state.activeTurnId === undefined || runtime.state.activeTurnId === turn.id)) {
              const tail = history.thread.turns.at(-1);
              runtime.state.activeTurnId = tail?.status === "inProgress" && !runtime.state.terminalTurnIds.has(tail.id)
                ? tail.id
                : undefined;
            }
            return true;
          }
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  #beginCompactionWait(runtime: SessionRuntime): Promise<void> {
    let resolveWait!: () => void;
    let rejectWait!: (error: unknown) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolveWait = resolve;
      rejectWait = reject;
    });
    const timer = setTimeout(() => {
      this.#settleCompaction(runtime, adapterError({
        code: "CODEX_COMPACTION_TIMEOUT",
        message: "Codex did not confirm the native compaction boundary in time.",
        phase: "stream",
        retryable: false,
        stateMayHaveChanged: true,
        recovery: "Inspect the native thread before explicitly retrying compaction."
      }));
    }, this.#compactionTimeoutMs);
    timer.unref?.();
    runtime.compaction = { promise, resolve: resolveWait, reject: rejectWait, timer };
    return promise;
  }

  #settleCompaction(runtime: SessionRuntime, error?: unknown): void {
    const waiter = runtime.compaction;
    if (waiter === undefined) return;
    this.#releaseManagedOperation(runtime);
    runtime.compaction = undefined;
    clearTimeout(waiter.timer);
    if (error === undefined) waiter.resolve();
    else waiter.reject(error);
  }

  async #forkThread(runtime: SessionRuntime, context: AdapterContext, derivation: NativeSessionDerivation, nativeBoundaryId?: string): Promise<NativeSessionBinding> {
    const hostGeneration = runtime.hostGeneration;
    const dispatchSignal = AbortSignal.any([context.signal, runtime.dispatchLifetime.signal]);
    const boundary = nativeBoundaryId === undefined
      ? undefined
      : await this.#resolveForkTurnId(runtime, context, nativeBoundaryId);
    const profileKey = await this.#activeProfileKey;
    const assertForkDispatch = () => {
      assertDispatchNotCancelled(dispatchSignal);
      if (!this.#matchesCoreFence(runtime, context)
        || runtime.hostGeneration !== hostGeneration
        || !this.#host.isActiveGeneration(hostGeneration)) {
        throw adapterError({
          code: "CODEX_RUNTIME_GENERATION_STALE",
          message: "The Codex runtime changed before the derived Session could be dispatched.",
          phase: "dispatch",
          recovery: "Refresh the source Session before explicitly deriving a new Session."
        });
      }
      boundary?.assertCurrent();
    };
    assertForkDispatch();
    let response;
    try {
      response = await this.#host.request("thread/fork", {
        threadId: runtime.threadId,
        ...(boundary === undefined ? {} : { lastTurnId: boundary.turnId }),
        cwd: context.target.workspaceRoot,
        excludeTurns: true
      }, { mutation: true, signal: dispatchSignal, beforeDispatch: assertForkDispatch });
    } catch (error) {
      throw this.#requestFailure(error, "dispatch", "CODEX_SESSION_FORK_FAILED",
        error instanceof TransportFault ? error.stateMayHaveChanged : true);
    }
    let threadId: string;
    try {
      threadId = stringValue(objectValue(objectValue(response.value, "fork result")["thread"], "fork thread")["id"], "fork thread id");
      if (!isValidNativeThreadId(threadId)) throw new ProtocolShapeError("Invalid fork thread identity");
    } catch (error) {
      throw this.#requestFailure(error, "dispatch", "CODEX_SESSION_FORK_INVALID_RESPONSE", true);
    }
    if (threadId === runtime.threadId || [...this.#sessions.values()].some((session) => session.threadId === threadId)) {
      throw adapterError({
        code: "CODEX_SESSION_FORK_IDENTITY_MISMATCH",
        message: "Codex did not return a distinct native thread for the fork.",
        phase: "dispatch",
        stateMayHaveChanged: true,
        recovery: "Refresh native Session discovery before explicitly retrying the fork."
      });
    }
    const binding = bindingForThread(threadId, context.generation, profileKey);
    try {
      derivation.recordBinding(binding);
      this.#assertRuntimeFence(runtime, context, response.hostGeneration);
      let thread: NativeThread;
      try {
        thread = parseThreadResult(response.value);
      } catch (error) {
        throw this.#requestFailure(error, "dispatch", "CODEX_SESSION_FORK_INVALID_RESPONSE", true);
      }
      if (!(await nativeThreadMatchesWorkspace(thread, runtime.targetWorkspaceRoot))) {
        throw adapterError({
          code: "CODEX_SESSION_FORK_TARGET_MISMATCH",
          message: "The derived Codex native thread does not match the source Target workspace.",
          phase: "dispatch",
          stateMayHaveChanged: true,
          recovery: "Inspect native Session discovery for the selected Target before explicitly retrying the fork."
        });
      }
      this.#assertRuntimeFence(runtime, context, response.hostGeneration);
      return binding;
    } finally {
      await this.#host.releaseUnboundThread(threadId, response.hostGeneration).catch((error) => {
        throw this.#requestFailure(error, "shutdown", "CODEX_SESSION_FORK_DETACH_FAILED", true);
      });
    }
  }

  async #resolveForkTurnId(runtime: SessionRuntime, context: AdapterContext, nativeBoundaryId: string): Promise<{ readonly turnId: string; readonly assertCurrent: () => void }> {
    if (nativeBoundaryId.length === 0 || nativeBoundaryId.length > 512 || /[\u0000-\u001f]/.test(nativeBoundaryId)) {
      throw adapterError({
        code: "CODEX_FORK_BOUNDARY_INVALID",
        message: "The selected Codex fork boundary is invalid.",
        phase: "dispatch",
        recovery: "Choose a durable message from the current native thread."
      });
    }
    let history;
    try {
      history = await this.#readCompleteHistory(runtime, context);
    } catch (error) {
      throw this.#requestFailure(error, "probe", "CODEX_FORK_BOUNDARY_UNAVAILABLE", false);
    }
    history.assertCurrent();
    const turn = history.thread.turns.find((candidate) => candidate.id === nativeBoundaryId || candidate.items.some((item) =>
      item.id === nativeBoundaryId || (item.type === "userMessage" && item["clientId"] === nativeBoundaryId)
    ));
    if (turn === undefined) {
      throw adapterError({
        code: "CODEX_FORK_BOUNDARY_NOT_FOUND",
        message: "The selected message is not present in the durable Codex thread.",
        phase: "dispatch",
        retryable: true,
        recovery: "Refresh the native thread and choose a visible durable message."
      });
    }
    if (turn.status === "inProgress") {
      throw adapterError({
        code: "CODEX_FORK_BOUNDARY_BUSY",
        message: "Codex cannot fork through an in-progress turn.",
        phase: "dispatch",
        retryable: true,
        recovery: "Wait for the turn to finish or interrupt it before forking."
      });
    }
    return { turnId: turn.id, assertCurrent: history.assertCurrent };
  }

  async #readCompleteHistory(runtime: SessionRuntime, context: AdapterContext): Promise<{
    readonly thread: NativeThread;
    readonly assertCurrent: () => void;
  }> {
    const binding = runtime.binding;
    const hostGeneration = runtime.hostGeneration;
    const threadId = runtime.threadId;
    const historyRevision = this.#host.historyRevision(threadId, hostGeneration);
    const deadline = performance.now() + this.#historyReadTimeoutMs;
    const timedOut = new AbortController();
    const signal = AbortSignal.any([context.signal, runtime.dispatchLifetime.signal, timedOut.signal]);
    const timer = setTimeout(() => timedOut.abort(), this.#historyReadTimeoutMs);
    timer.unref?.();
    const assertCurrent = (): void => {
      if (timedOut.signal.aborted || performance.now() >= deadline) throw nativeHistoryReadFailure("TIMEOUT");
      if (signal.aborted) throw nativeHistoryReadFailure("CANCELLED");
      this.#assertHistoryRuntimeFence(runtime, context, binding, hostGeneration);
      if (historyRevision === undefined || this.#host.historyRevision(threadId, hostGeneration) !== historyRevision) {
        throw nativeHistoryReadFailure("STALE");
      }
    };
    let bytes = 0;
    const request = async (method: string, params: JsonObject): Promise<JsonValue> => {
      assertCurrent();
      const result = await waitForHistoryRead(this.#host.request(method, params, {
        signal, timeoutMs: Math.max(1, Math.ceil(deadline - performance.now())), beforeDispatch: assertCurrent
      }), signal, () => nativeHistoryReadFailure(timedOut.signal.aborted ? "TIMEOUT" : "CANCELLED"));
      assertCurrent();
      if (result.hostGeneration !== hostGeneration) throw nativeHistoryReadFailure("STALE");
      bytes += serializedByteLength(result.value);
      if (bytes > this.#maximumHistoryBytes) throw nativeHistoryReadFailure("SIZE_LIMIT");
      return result.value;
    };
    const readMetadata = async (): Promise<NativeThread> => {
      const value = await request("thread/read", { threadId, includeTurns: false });
      const raw = objectValue(objectValue(value, "thread metadata result")["thread"], "thread metadata");
      if (!Array.isArray(raw["turns"]) || raw["turns"].length !== 0) {
        throw new ProtocolShapeError("thread metadata must not contain history turns");
      }
      const thread = parseThreadResult(value);
      await waitForHistoryRead(assertNativeThreadTarget(
        thread, threadId, runtime.reviewWorkingDirectory ?? runtime.targetWorkspaceRoot, "probe"
      ), signal, () => nativeHistoryReadFailure(timedOut.signal.aborted ? "TIMEOUT" : "CANCELLED"));
      assertCurrent();
      return thread;
    };
    try {
      assertCurrent();
      const metadata = await readMetadata();
      const turns: NativeTurn[] = [];
      const turnIds = new Set<string>();
      const itemIds = new Set<string>();
      const cursors = new Set<string>();
      let cursor: string | undefined;
      let pages = 0;
      let items = 0;
      do {
        if (++pages > this.#maximumHistoryPages) throw nativeHistoryReadFailure("SIZE_LIMIT");
        const page = parseFullTurnPage(await request("thread/turns/list", {
          threadId, sortDirection: "asc", itemsView: "full", limit: 100,
          ...(cursor === undefined ? {} : { cursor })
        }), { maximumTurns: 100, maximumItems: this.#maximumHistoryItems });
        assertCurrent();
        if (turns.length + page.turns.length > this.#maximumHistoryTurns) throw nativeHistoryReadFailure("SIZE_LIMIT");
        for (const turn of page.turns) {
          if (turnIds.has(turn.id) || itemIds.has(turn.id)) throw new ProtocolShapeError("native history contains duplicate identities");
          turnIds.add(turn.id);
          items += turn.items.length;
          if (items > this.#maximumHistoryItems) throw nativeHistoryReadFailure("SIZE_LIMIT");
          for (const item of turn.items) {
            if (itemIds.has(item.id) || turnIds.has(item.id)) throw new ProtocolShapeError("native history contains duplicate identities");
            itemIds.add(item.id);
          }
          turns.push(turn);
        }
        cursor = page.nextCursor;
        if (cursor !== undefined) {
          if (page.turns.length === 0 || cursors.has(cursor)) throw new ProtocolShapeError("native history pagination did not advance");
          cursors.add(cursor);
        }
      } while (cursor !== undefined);

      // Public pages have no atomic snapshot token. Re-read the newest full turn
      // and metadata as optimistic evidence, in addition to the wire-arrival fence.
      const tail = parseFullTurnPage(await request("thread/turns/list", {
        threadId, sortDirection: "desc", itemsView: "full", limit: 1
      }), { maximumTurns: 1, maximumItems: this.#maximumHistoryItems });
      const latestMetadata = await readMetadata();
      assertCurrent();
      if (JSON.stringify(metadata) !== JSON.stringify(latestMetadata)
        || (turns.length > 1) !== (tail.nextCursor !== undefined)
        || fullTurnSignature(turns.at(-1)) !== fullTurnSignature(tail.turns[0])) {
        throw nativeHistoryReadFailure("STALE");
      }
      return { thread: { ...latestMetadata, turns }, assertCurrent };
    } finally {
      clearTimeout(timer);
    }
  }

  #descriptor(input: {
    readonly version: string;
    readonly health: BackendDescriptor["health"];
    readonly installationState: NonNullable<BackendDescriptor["installationState"]>;
    readonly authenticationState: NonNullable<BackendDescriptor["authenticationState"]>;
    readonly diagnostics: readonly string[];
    readonly error?: NonNullable<BackendDescriptor["error"]>;
  }): BackendDescriptor {
    return {
      id: this.id,
      adapterKind: "codex",
      instanceGeneration: this.#instanceGeneration,
      displayName: "Codex",
      version: input.version,
      health: input.health,
      installationState: input.installationState,
      authenticationState: input.authenticationState,
      ...(input.error === undefined ? {} : { error: input.error }),
      capabilities: this.#capabilities(input.installationState === "installed"),
      providers: [{
        providerId: this.#providerId,
        displayName: "OpenAI",
        accessKind: codexProviderAccessKind(this.#account),
        ...(codexProviderAccessKind(this.#account) === "subscription" ? { accessProduct: "ChatGPT" } : {}),
        providesModelPricing: true,
        api: "openai-responses",
        authenticationState: input.authenticationState,
        loginMethods: this.#account?.loginMethods ?? [],
        supportsLogin: this.#account?.supportsLogin === true,
        supportsLogout: this.#account?.supportsLogout === true,
        supportsRefresh: input.installationState === "installed",
        supportsModelRefresh: input.installationState === "installed",
        credentialSurfaces: [{
          surfaceId: "image-generation",
          capability: "image_generation",
          kind: "api_key",
          executionApi: "openai-images",
          models: [{ modelId: "gpt-image-2", displayName: "GPT Image 2" }]
        }]
      }, ...(this.#managedProviders?.listProviders().filter((provider) => provider.providerId !== this.#providerId) ?? [])],
      models: this.#withManagedModels(this.#models),
      ...(this.#managedProviders === undefined ? {} : { providerRuntimeSupport: CODEX_MANAGED_PROVIDER_SUPPORT }),
      tools: [],
      diagnostics: input.diagnostics
    };
  }

  #capabilities(installed: boolean): ReadonlyMap<string, Capability> {
    const supported = new Set<KnownCapability>([
      "session.discovery",
      "session.catalog",
      "session.ai_rename",
      "session.resume",
      "session.detach",
      "session.fork",
      "session.clone",
      "session.rewind",
      "session.rewind_to_start",
      "turn.stream",
      "turn.abort",
      "turn.steer",
      "input.text",
      "input.file",
      "input.mention",
      "model.list",
      "model.switch",
      "provider.refresh",
      "provider.model_refresh",
      "provider.account_usage",
      "permission.modes",
      "permission.change",
      "context.usage",
      "context.compact",
      "interaction.permission",
      "interaction.question"
    ]);
    if (this.#managedProviders !== undefined) supported.add("provider.managed_catalog");
    if (this.#models.some((model) => model.thinkingLevels.length > 0)) supported.add("model.effort");
    if (this.#models.some((model) => model.supportsFastMode)) supported.add("model.fast_mode");
    if (this.#account?.supportsLogin === true) supported.add("provider.login");
    if (this.#account?.supportsLogout === true) supported.add("provider.logout");
    if (this.#resolvers.readBlob !== undefined) supported.add("input.image");
    const isolatedReviewSupported = supportsIsolatedReview(this.#host.initializeResult?.userAgent);
    if (isolatedReviewSupported) supported.add("review.isolated");
    const nativeCollaborationSupported = supportsNativeCollaboration(this.#host.initializeResult?.userAgent);
    if (nativeCollaborationSupported) {
      supported.add("plan_mode");
      supported.add("background.tasks");
      supported.add("subagents.list");
      supported.add("subagents.detail");
      supported.add("subagents.transcript");
    }
    for (const capability of this.#hostCapabilities) supported.add(capability);
    return new Map(CAPABILITIES.map((key): [string, Capability] => {
      const implemented = supported.has(key);
      const available = key === "session.catalog" || (installed && implemented);
      return [key, {
        key,
        supported: available,
        ...(!available && !installed
          ? { reason: "upstream_missing" as const }
          : key === "review.isolated" && !isolatedReviewSupported
            ? { reason: "upstream_missing" as const }
          : (key === "plan_mode"
              || key === "background.tasks"
              || key === "subagents.list"
              || key === "subagents.detail"
              || key === "subagents.transcript")
              && !nativeCollaborationSupported
            ? { reason: "upstream_missing" as const }
          : !available && !implemented
            ? { reason: "not_implemented" as const }
            : {}),
        ...(key === "permission.modes" ? { options: ["ask", "auto", "bypassPermissions"] } : {}),
        ...(key === "provider.login" && this.#account?.supportsLogin === true
          ? { options: [...this.#account.loginMethods] }
          : {})
      }];
    }));
  }

  #matchesCoreFence(runtime: SessionRuntime, context: AdapterContext): boolean {
    return !runtime.closed
      && runtime.sessionId === context.sessionId
      && runtime.targetId === context.target.id
      && context.target.backendId === this.id
      && equalNativePaths(runtime.targetWorkspaceRoot, context.target.workspaceRoot)
      && runtime.sessionGeneration === context.generation
      && runtime.runtimePolicy === (context.runtimePolicy === "review_read_only" ? "review_read_only" : "standard")
      && runtime.backendInstanceGeneration === this.#instanceGeneration
      && runtime.backendInstanceGeneration === backendGeneration(context)
      && this.#sessions.get(context.sessionId) === runtime;
  }

  #isRuntimeCurrent(runtime: SessionRuntime, hostGeneration: number): boolean {
    return this.#matchesCallbackFence(runtime, hostGeneration) && this.#host.isActiveGeneration(hostGeneration);
  }

  #matchesCallbackFence(runtime: SessionRuntime, hostGeneration: number): boolean {
    return !runtime.closed
      && runtime.hostGeneration === hostGeneration
      && runtime.targetId === runtime.context.target.id
      && runtime.context.target.backendId === this.id
      && equalNativePaths(runtime.targetWorkspaceRoot, runtime.context.target.workspaceRoot)
      && runtime.sessionGeneration === runtime.context.generation
      && runtime.runtimePolicy === (runtime.context.runtimePolicy === "review_read_only" ? "review_read_only" : "standard")
      && runtime.backendInstanceGeneration === this.#instanceGeneration
      && runtime.backendInstanceGeneration === backendGeneration(runtime.context)
      && this.#sessions.get(runtime.sessionId) === runtime;
  }

  #assertRuntimeFence(
    runtime: SessionRuntime,
    context: AdapterContext,
    hostGeneration: number,
    requireHostActive = true
  ): void {
    if (!this.#matchesCoreFence(runtime, context)
      || runtime.hostGeneration !== hostGeneration
      || (requireHostActive && !this.#host.isActiveGeneration(hostGeneration))) {
      throw adapterError({
        code: "CODEX_RUNTIME_GENERATION_STALE",
        message: "The Codex runtime generation changed before the result could be committed.",
        phase: "stream",
        stateMayHaveChanged: true,
        recovery: "Refresh the Session and Backend instance before retrying."
      });
    }
  }

  #assertHistoryRuntimeFence(
    runtime: SessionRuntime,
    context: AdapterContext,
    binding: NativeSessionBinding,
    hostGeneration: number
  ): void {
    this.#assertRuntimeFence(runtime, context, hostGeneration);
    const contextBinding = context.binding;
    if (contextBinding === undefined
      || contextBinding.generation !== context.generation
      || contextBinding.generation !== binding.generation
      || contextBinding.opaqueRef !== binding.opaqueRef
      || runtime.binding.generation !== binding.generation
      || runtime.binding.opaqueRef !== binding.opaqueRef
      || threadIdFromBinding(contextBinding) !== runtime.threadId
      || threadIdFromBinding(binding) !== runtime.threadId
      || threadIdFromBinding(runtime.binding) !== runtime.threadId) {
      throw adapterError({
        code: "CODEX_SESSION_BINDING_MISMATCH",
        message: "The Codex native history binding changed before the read could be committed.",
        phase: "probe",
        recovery: "Refresh the durable Session binding before reading native history."
      });
    }
  }

  #assertStandardRuntime(runtime: SessionRuntime, operation: string): void {
    if (runtime.runtimePolicy === "standard") return;
    throw adapterError({
      code: "CODEX_REVIEW_OPERATION_DENIED",
      message: `The isolated Codex reviewer cannot ${operation}.`,
      phase: "dispatch",
      recovery: "Perform this operation in a standard Session instead."
    });
  }

  #resumeBindingForContext(binding: NativeSessionBinding, context: AdapterContext): NativeSessionBinding {
    this.#assertBackendContext(context);
    if (!Number.isSafeInteger(context.generation) || context.generation < 1) {
      throw adapterError({
        code: "CODEX_SESSION_BINDING_MISMATCH",
        message: "The Codex Session generation is invalid.",
        phase: "provision",
        recovery: "Refresh the durable Session binding before resuming the native thread."
      });
    }
    const threadId = threadIdFromBinding(binding);
    const sameGeneration = binding.generation === context.generation;
    const nextGeneration = binding.generation === context.generation - 1;
    if (!sameGeneration && !nextGeneration) {
      throw adapterError({
        code: "CODEX_SESSION_BINDING_MISMATCH",
        message: "The Codex native Session binding belongs to another Session generation.",
        phase: "provision",
        recovery: "Refresh the durable Session binding before resuming the native thread."
      });
    }
    const currentBinding = context.binding;
    if (currentBinding === undefined) {
      if (!sameGeneration) {
        throw adapterError({
          code: "CODEX_SESSION_BINDING_MISMATCH",
          message: "The next Codex Session generation has no current binding proof.",
          phase: "provision",
          recovery: "Refresh the durable Session binding before resuming the native thread."
        });
      }
      return binding;
    }
    const currentThreadId = threadIdFromBinding(currentBinding);
    if (currentBinding.generation !== context.generation
      || currentBinding.opaqueRef !== binding.opaqueRef
      || currentThreadId !== threadId) {
      throw adapterError({
        code: "CODEX_SESSION_BINDING_MISMATCH",
        message: "The Codex native Session binding does not prove same-thread generation continuity.",
        phase: "provision",
        recovery: "Refresh the durable Session binding before resuming the native thread."
      });
    }
    return currentBinding;
  }

  #assertContextTarget(context: AdapterContext, target: TargetDescriptor): void {
    this.#assertBackendContext(context);
    if (context.target.id !== target.id
      || context.target.backendId !== this.id
      || target.backendId !== this.id
      || !equalNativePaths(context.target.workspaceRoot, target.workspaceRoot)) {
      throw adapterError({
        code: "CODEX_CONTEXT_TARGET_MISMATCH",
        message: "The Codex operation context does not match the requested Target.",
        phase: "provision",
        recovery: "Retry through the owning Session and Target."
      });
    }
  }

  #assertBackendContext(context: AdapterContext): void {
    if (backendGeneration(context) !== this.#instanceGeneration) {
      throw adapterError({
        code: "CODEX_BACKEND_GENERATION_STALE",
        message: "The operation belongs to a different Codex Backend instance generation.",
        phase: "provision",
        stateMayHaveChanged: false,
        recovery: "Acquire the current Backend instance before retrying the operation."
      });
    }
  }

  #requestFailure(
    error: unknown,
    phase: "probe" | "provision" | "dispatch" | "shutdown",
    code: string,
    stateMayHaveChanged: boolean
  ) {
    if (error instanceof Error && "publicError" in error) return error;
    const retryable = error instanceof TransportFault
      || (error instanceof RpcRemoteFault && error.rpcCode === -32001);
    return adapterError({
      code,
      message: phase === "probe"
        ? "The Codex app-server could not provide the requested stable state."
        : phase === "shutdown"
          ? "The Codex native Session cleanup did not complete."
          : phase === "provision"
            ? "The Codex native Session could not be prepared."
            : "The Codex app-server rejected the native operation.",
      phase,
      retryable,
      stateMayHaveChanged: stateMayHaveChanged || (error instanceof TransportFault && error.stateMayHaveChanged),
      recovery: stateMayHaveChanged
        ? "Refresh the native thread before explicitly retrying the operation."
        : "Verify Codex health and stable protocol availability before retrying."
    });
  }

  #nativeThreadReadFailure(error: unknown, phase: "probe" | "provision") {
    if (error instanceof RpcRemoteFault && error.rpcCode === -32602) {
      return adapterError({
        code: "NATIVE_SESSION_CONTINUITY_GAP",
        message: "The validated Codex native thread is not materialized in the current app-server state.",
        phase,
        retryable: false,
        stateMayHaveChanged: false,
        recovery: "Recreate only when the product task is durably proven to have accepted no input."
      });
    }
    return this.#requestFailure(error, phase, "CODEX_NATIVE_SESSION_UNAVAILABLE", false);
  }

  #nativeThreadResumeFailure(error: unknown) {
    if (error instanceof RpcRemoteFault && error.rpcCode === -32600) {
      return adapterError({
        code: "NATIVE_SESSION_CONTINUITY_GAP",
        message: "The validated Codex native thread cannot be resumed by the current app-server state.",
        phase: "provision",
        retryable: false,
        stateMayHaveChanged: false,
        recovery: "Recreate only when the product task is durably proven to have accepted no input."
      });
    }
    return this.#requestFailure(error, "provision", "CODEX_NATIVE_SESSION_UNAVAILABLE", false);
  }

  async #withCatalogMaterializationLock<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.#catalogMaterializationTail;
    let release!: () => void;
    this.#catalogMaterializationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  async #withNativeMutation<T>(context: AdapterContext, action: () => Promise<T>): Promise<T> {
    this.#assertOpen();
    this.#assertBackendContext(context);
    assertDispatchNotCancelled(context.signal);
    if (this.#sessions.get(context.sessionId)?.rewindUnknown) throw rewindUnknown();
    const admission = this.#sessionMutations.get(context.sessionId) ?? { count: 0, rewinding: false };
    if (admission.rewinding) throw rewindBusy();
    admission.count++;
    this.#sessionMutations.set(context.sessionId, admission);
    try {
      return await action();
    } finally {
      admission.count--;
      if (admission.count === 0 && this.#sessionMutations.get(context.sessionId) === admission) this.#sessionMutations.delete(context.sessionId);
    }
  }

  #assertOpen(): void {
    if (this.#disposed) {
      throw adapterError({
        code: "CODEX_ADAPTER_CLOSED",
        message: "The Codex Backend instance is closed.",
        phase: "shutdown",
        recovery: "Acquire the current Backend instance generation."
      });
    }
  }
}

function managedRouteUnavailable(stateMayHaveChanged = false): JokoError {
  return adapterError({
    code: stateMayHaveChanged ? "CODEX_PROVIDER_ROUTE_UNKNOWN" : "CODEX_PROVIDER_ROUTE_UNAVAILABLE",
    message: stateMayHaveChanged ? "The native Provider route could not be confirmed." : "The selected Provider route is not available for this operation.",
    phase: "dispatch", retryable: false, stateMayHaveChanged,
    recovery: "Keep the input, refresh the task, and explicitly select an available model before sending again."
  });
}

export function createCodexAdapter(options: CodexAdapterOptions): CodexBackendAdapter {
  return new CodexBackendAdapter(options);
}

function permissionParams(mode: PermissionMode): JsonObject {
  if (mode === "bypassPermissions") return { approvalPolicy: "never", sandbox: "danger-full-access" };
  if (mode === "auto") return { approvalPolicy: "never", sandbox: "workspace-write" };
  return { approvalPolicy: "on-request", sandbox: "workspace-write" };
}

function reviewRuntimePolicy(
  input: CreateNativeSessionInput,
  context: AdapterContext
): "standard" | "review_read_only" {
  const inputPolicy = input.runtimePolicy ?? "standard";
  const contextPolicy = context.runtimePolicy ?? "standard";
  if (inputPolicy !== contextPolicy) throw invalidReviewProfile();
  if (inputPolicy === "standard") return "standard";
  const start = input.nativeStart ?? { kind: "new" as const };
  if (start.kind !== "new"
    || start.parentNativeReference !== undefined
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

function assertStandardReviewContext(context: AdapterContext, operation: string): void {
  if (context.runtimePolicy !== "review_read_only") return;
  throw adapterError({
    code: "CODEX_REVIEW_OPERATION_DENIED",
    message: `The isolated reviewer cannot ${operation}.`,
    phase: "dispatch",
    recovery: "Perform this operation in a standard Session instead."
  });
}

function invalidReviewProfile() {
  return adapterError({
    code: "CODEX_REVIEW_PROFILE_INVALID",
    message: "Isolated review requires a fresh immutable read-only Session profile.",
    phase: "provision",
    recovery: "Create a fresh reviewer in ask mode with no inherited history or additional directories."
  });
}

function reviewRuntimeUnsupported(userAgent: string | undefined) {
  return adapterError({
    code: "CODEX_REVIEW_RUNTIME_UNSUPPORTED",
    message: `The installed Codex app-server cannot enforce the isolated reviewer profile (${versionFromUserAgent(userAgent)}).`,
    phase: "provision",
    recovery: "Install the Joko-supported Codex app-server before starting Review."
  });
}

function reviewInventoryInvalid() {
  return adapterError({
    code: "CODEX_REVIEW_INVENTORY_INVALID",
    message: "Codex exposed an unbounded or unclassified customization surface during Review isolation.",
    phase: "provision",
    recovery: "Remove the unclassified native customization and retry Review."
  });
}

function supportsIsolatedReview(userAgent: string | undefined): boolean {
  return matchesExactAppServerVersion(userAgent);
}

function supportsNativeCollaboration(userAgent: string | undefined): boolean {
  return matchesExactAppServerVersion(userAgent);
}

function matchesExactAppServerVersion(userAgent: string | undefined): boolean {
  const version = /^[^/\s]+\/([^\s]+)(?:\s|$)/u.exec(userAgent ?? "")?.[1];
  return version === AUDITED_APP_SERVER_VERSION;
}

interface ReviewSkillInventory {
  readonly paths: ReadonlySet<string>;
  readonly pluginIds: ReadonlySet<string>;
}

function reviewSkillInventory(value: JsonValue, cwd: string): ReviewSkillInventory {
  const response = isJsonObject(value) ? value : undefined;
  const data = response?.["data"];
  if (!Array.isArray(data) || data.length !== 1 || !isJsonObject(data[0])) throw reviewInventoryInvalid();
  const entry = data[0];
  if (typeof entry["cwd"] !== "string" || !equalNativePaths(entry["cwd"], cwd)) throw reviewInventoryInvalid();
  const skills = entry["skills"];
  const errors = entry["errors"];
  if (!Array.isArray(skills) || !Array.isArray(errors)
    || skills.length + errors.length > REVIEW_MAXIMUM_INVENTORY_ITEMS) throw reviewInventoryInvalid();
  const paths = new Set<string>();
  const pluginIds = new Set<string>();
  for (const skill of skills) {
    if (!isJsonObject(skill)
      || typeof skill["path"] !== "string"
      || !isAbsolute(skill["path"])
      || skill["path"].length > 4_096) throw reviewInventoryInvalid();
    paths.add(skill["path"]);
    const pluginId = skill["pluginId"];
    if (pluginId !== null && pluginId !== undefined) {
      if (typeof pluginId !== "string" || pluginId.length === 0 || pluginId.length > 512) throw reviewInventoryInvalid();
      pluginIds.add(pluginId);
    }
  }
  for (const error of errors) {
    if (!isJsonObject(error)
      || typeof error["path"] !== "string"
      || !isAbsolute(error["path"])
      || error["path"].length > 4_096) throw reviewInventoryInvalid();
    paths.add(error["path"]);
  }
  return { paths, pluginIds };
}

function reviewEffectiveConfig(value: JsonValue): JsonObject {
  if (!isJsonObject(value) || !isJsonObject(value["config"])) throw reviewInventoryInvalid();
  return value["config"];
}

function optionalReviewObject(value: JsonValue | undefined): JsonObject {
  if (value === undefined || value === null) return {};
  if (!isJsonObject(value)) throw reviewInventoryInvalid();
  return value;
}

function hasReviewMcpTransport(value: JsonValue): boolean {
  if (!isJsonObject(value)) return false;
  return typeof value["command"] === "string"
    || typeof value["url"] === "string"
    || typeof value["transport"] === "string"
    || isJsonObject(value["transport"]);
}

function reviewMcpStatusPage(value: JsonValue): {
  readonly names: readonly string[];
  readonly nextCursor: string | null;
} {
  if (!isJsonObject(value) || !Array.isArray(value["data"])
    || value["data"].length > REVIEW_MAXIMUM_INVENTORY_ITEMS) throw reviewInventoryInvalid();
  const names = value["data"].map((entry) => {
    if (!isJsonObject(entry)
      || typeof entry["name"] !== "string"
      || entry["name"].length === 0
      || entry["name"].length > 512) throw reviewInventoryInvalid();
    return entry["name"];
  });
  const nextCursor = value["nextCursor"];
  if (nextCursor !== undefined && nextCursor !== null
    && (typeof nextCursor !== "string" || nextCursor.length === 0 || nextCursor.length > 4_096)) {
    throw reviewInventoryInvalid();
  }
  return { names, nextCursor: typeof nextCursor === "string" ? nextCursor : null };
}

function quoteReviewConfigSegment(value: string): string {
  return `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, "\\\"")}"`;
}

function renderReviewConfigSegment(value: string): string {
  return /^[A-Za-z0-9_-]+$/u.test(value) ? value : quoteReviewConfigSegment(value);
}

function assertReviewThreadStarted(
  response: JsonObject,
  thread: NativeThread,
  workspaceRoot: string,
  reviewWorkingDirectory: string
): void {
  const profile = response["activePermissionProfile"];
  const runtimeRoots = response["runtimeWorkspaceRoots"];
  const instructionSources = response["instructionSources"];
  const rawThread = response["thread"];
  if (!isJsonObject(profile)
    || profile["id"] !== REVIEW_PERMISSION_PROFILE
    || !Array.isArray(runtimeRoots)
    || runtimeRoots.length !== 1
    || typeof runtimeRoots[0] !== "string"
    || !equalNativePaths(runtimeRoots[0], workspaceRoot)
    || !Array.isArray(instructionSources)
    || instructionSources.length !== 0
    || response["approvalPolicy"] !== "never"
    || response["serviceTier"] !== null
    || typeof response["cwd"] !== "string"
    || !equalNativePaths(response["cwd"], reviewWorkingDirectory)
    || thread.cwd === undefined
    || !equalNativePaths(thread.cwd, reviewWorkingDirectory)
    || thread.ephemeral !== true
    || thread.turns.length !== 0
    || (thread.parentThreadId !== undefined && thread.parentThreadId !== null)
    || (thread.agentRole !== undefined && thread.agentRole !== null)
    || !isJsonObject(rawThread)
    || (rawThread["forkedFromId"] !== undefined && rawThread["forkedFromId"] !== null)) {
    throw invalidReviewProfile();
  }

}

function rewindBusy() {
  return adapterError({ code: "CODEX_REWIND_BUSY", message: "Native history cannot be rewound while this Session has pending work.", phase: "dispatch", recovery: "Wait for input, controls, compaction and background tasks to settle before rewinding." });
}

function rewindBoundaryUnavailable() {
  return adapterError({ code: "CODEX_REWIND_BOUNDARY_UNAVAILABLE", message: "The selected entry is not the end of a retained native turn.", phase: "dispatch", recovery: "Choose the final entry of a completed turn. An interior entry cannot be rewound precisely." });
}

function rewindUnknown() {
  return adapterError({ code: "CODEX_REWIND_UNKNOWN", message: "The native dialogue may have changed, but its retained history could not be confirmed.", phase: "dispatch", stateMayHaveChanged: true, retryable: false, recovery: "Inspect native history and explicitly close and reattach this Session before further changes. Do not repeat the rewind automatically." });
}

function assertRewindableHistory(thread: NativeThread): void {
  if (thread.historyMode !== "paginated") {
    throw adapterError({ code: "CODEX_REWIND_MODE_UNAVAILABLE", message: "This native Session does not use the paginated history contract required for rewind.", phase: "dispatch", recovery: "Use a newly created paginated Session. Existing native history is not converted." });
  }
  if (thread.status?.["type"] !== "idle" || thread.turns.some((turn) => turn.status === "inProgress")) throw rewindBusy();
}

function reviewDynamicToolSpecs(): JsonValue[] {
  const boundedPath = {
    type: "string",
    minLength: 1,
    maxLength: 4_096,
    description: "Workspace-relative path. Absolute paths and sensitive paths are rejected."
  } satisfies JsonObject;
  return [
    {
      type: "function",
      name: "joko_read",
      description: "Read bounded text lines from one non-sensitive workspace file.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: boundedPath,
          startLine: { type: "integer", minimum: 1, maximum: 1_000_000 },
          lineCount: { type: "integer", minimum: 1, maximum: 1_000 }
        },
        required: ["path"]
      }
    },
    {
      type: "function",
      name: "joko_grep",
      description: "Search for a literal text fragment in bounded non-sensitive workspace files.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string", minLength: 1, maxLength: 512 },
          path: boundedPath,
          caseSensitive: { type: "boolean" }
        },
        required: ["query"]
      }
    },
    {
      type: "function",
      name: "joko_find",
      description: "Find bounded workspace paths by a simple * and ? wildcard pattern.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          pattern: { type: "string", minLength: 1, maxLength: 256 },
          path: boundedPath
        },
        required: ["pattern"]
      }
    },
    {
      type: "function",
      name: "joko_ls",
      description: "List one non-sensitive workspace directory without following symbolic links.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { path: boundedPath }
      }
    }
  ] as JsonValue[];
}

async function createReviewWorkingDirectory(): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), "joko-review-")));
}

async function removeReviewWorkingDirectory(directory: string): Promise<void> {
  const base = await realpath(tmpdir());
  const candidate = resolve(directory);
  const relativePath = relative(base, candidate);
  if (relativePath.length === 0
    || relativePath.startsWith(`..${sep}`)
    || relativePath === ".."
    || isAbsolute(relativePath)
    || !basename(candidate).startsWith("joko-review-")) {
    throw new Error("Review working-directory cleanup target is invalid.");
  }
  await rm(candidate, { recursive: true, force: true });
}

class ReviewToolInputError extends Error {}

interface ReviewResolvedPath {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly info: Stats;
}

function reviewDeniedServerRequest(method: string, _params: JsonValue): JsonValue | undefined {
  switch (method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
      return { decision: "decline" };
    case "item/permissions/requestApproval":
      return { permissions: {}, scope: "turn" };
    case "item/tool/requestUserInput":
      return { answers: {} };
    case "mcpServer/elicitation/request":
      return { action: "decline", content: null };
    default:
      return undefined;
  }
}

async function executeReviewDynamicTool(workspaceRoot: string, params: JsonValue): Promise<JsonValue> {
  try {
    if (!isJsonObject(params)
      || typeof params["tool"] !== "string"
      || !REVIEW_DYNAMIC_TOOL_NAMES.has(params["tool"])
      || (params["namespace"] !== undefined && params["namespace"] !== null)
      || !isJsonObject(params["arguments"])) {
      throw new ReviewToolInputError("The read-only tool request is invalid.");
    }
    const args = params["arguments"];
    const output = params["tool"] === "joko_read"
      ? await executeReviewRead(workspaceRoot, args)
      : params["tool"] === "joko_grep"
        ? await executeReviewGrep(workspaceRoot, args)
        : params["tool"] === "joko_find"
          ? await executeReviewFind(workspaceRoot, args)
          : await executeReviewList(workspaceRoot, args);
    return reviewToolResponse(true, output);
  } catch (error) {
    return reviewToolResponse(
      false,
      error instanceof ReviewToolInputError
        ? error.message
        : "The bounded read-only workspace operation failed."
    );
  }
}

function reviewToolResponse(success: boolean, text: string): JsonObject {
  return {
    success,
    contentItems: [{ type: "inputText", text: boundedReviewOutput(text) }]
  };
}

function boundedReviewOutput(value: string): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= REVIEW_MAXIMUM_OUTPUT_BYTES) return value;
  return `${bytes.subarray(0, REVIEW_MAXIMUM_OUTPUT_BYTES - 64).toString("utf8")}\n[output truncated by reviewer boundary]`;
}

async function resolveReviewToolPath(
  workspaceRoot: string,
  rawPath: JsonValue | undefined,
  fallback = "."
): Promise<ReviewResolvedPath> {
  const value = rawPath ?? fallback;
  if (typeof value !== "string"
    || value.length === 0
    || value.length > 4_096
    || value.includes("\0")
    || isAbsolute(value)) {
    throw new ReviewToolInputError("The workspace-relative path is invalid.");
  }
  const lexicalSegments = value.replace(/\\/gu, "/").split("/").filter((segment) => segment.length > 0 && segment !== ".");
  if (lexicalSegments.includes("..") || reviewPathSegmentsAreSensitive(lexicalSegments)) {
    throw new ReviewToolInputError("The requested path is outside the reviewer evidence boundary.");
  }
  const canonicalRoot = await realpath(workspaceRoot);
  const absolutePath = await realpath(resolve(canonicalRoot, value)).catch(() => {
    throw new ReviewToolInputError("The requested workspace path does not exist.");
  });
  const relativePath = relative(canonicalRoot, absolutePath);
  if (relativePath === ".."
    || relativePath.startsWith(`..${sep}`)
    || isAbsolute(relativePath)
    || reviewPathSegmentsAreSensitive(relativePath.split(/[\\/]/gu))) {
    throw new ReviewToolInputError("The requested path is outside the reviewer evidence boundary.");
  }
  const info = await stat(absolutePath).catch(() => {
    throw new ReviewToolInputError("The requested workspace path is unavailable.");
  }) as Stats;
  return {
    absolutePath,
    relativePath: relativePath.length === 0 ? "." : relativePath.replace(/\\/gu, "/"),
    info
  };
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

function optionalReviewInteger(
  value: JsonValue | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < minimum || value > maximum) {
    throw new ReviewToolInputError("A numeric read-only tool bound is invalid.");
  }
  return value;
}

async function executeReviewRead(workspaceRoot: string, args: JsonObject): Promise<string> {
  const target = await resolveReviewToolPath(workspaceRoot, args["path"]);
  if (!target.info.isFile() || target.info.size > REVIEW_MAXIMUM_READ_BYTES) {
    throw new ReviewToolInputError("The requested file is not a bounded text file.");
  }
  const bytes = await readFile(target.absolutePath);
  if (bytes.includes(0)) throw new ReviewToolInputError("Binary files are not readable through this reviewer tool.");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ReviewToolInputError("The requested file is not valid UTF-8 text.");
  }
  const startLine = optionalReviewInteger(args["startLine"], 1, 1, 1_000_000);
  const lineCount = optionalReviewInteger(args["lineCount"], 400, 1, 1_000);
  const lines = text.split(/\r?\n/gu);
  const selected = lines.slice(startLine - 1, startLine - 1 + lineCount);
  if (selected.length === 0) return `${target.relativePath}: no lines in the requested range.`;
  return selected.map((line, index) => `${startLine + index}: ${line}`).join("\n");
}

async function executeReviewList(workspaceRoot: string, args: JsonObject): Promise<string> {
  const target = await resolveReviewToolPath(workspaceRoot, args["path"]);
  if (!target.info.isDirectory()) throw new ReviewToolInputError("The requested path is not a directory.");
  const entries = await readdir(target.absolutePath, { withFileTypes: true });
  if (entries.length > REVIEW_MAXIMUM_RESULTS) throw new ReviewToolInputError("The directory exceeds the bounded listing limit.");
  const visible = entries
    .filter((entry) => !reviewPathSegmentsAreSensitive([entry.name]))
    .sort((left, right) => left.name.localeCompare(right.name, "en-US"))
    .map((entry) => `${reviewDirentKind(entry)}\t${entry.name}`);
  return visible.length === 0 ? `${target.relativePath}: empty` : visible.join("\n");
}

function reviewDirentKind(entry: Dirent): "dir" | "file" | "link" | "other" {
  if (entry.isDirectory()) return "dir";
  if (entry.isFile()) return "file";
  if (entry.isSymbolicLink()) return "link";
  return "other";
}

interface ReviewWalkFile {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly size: number;
}

async function walkReviewFiles(
  workspaceRoot: string,
  start: ReviewResolvedPath,
  visit: (file: ReviewWalkFile) => Promise<boolean> | boolean
): Promise<boolean> {
  const canonicalRoot = await realpath(workspaceRoot);
  const canonicalStart = await resolveReviewWalkEntry(canonicalRoot, start.absolutePath);
  if (canonicalStart === undefined) {
    throw new ReviewToolInputError("The requested path is outside the reviewer evidence boundary.");
  }
  if (canonicalStart.info.isFile()) {
    return !(await visit({
      absolutePath: canonicalStart.absolutePath,
      relativePath: canonicalStart.relativePath,
      size: canonicalStart.info.size
    }));
  }
  if (!canonicalStart.info.isDirectory()) throw new ReviewToolInputError("The requested path cannot be scanned.");
  const queue: { readonly absolutePath: string; readonly relativePath: string }[] = [{
    absolutePath: canonicalStart.absolutePath,
    relativePath: canonicalStart.relativePath === "." ? "" : canonicalStart.relativePath
  }];
  const visitedDirectories = new Set<string>();
  let entriesObserved = 0;
  while (queue.length > 0) {
    const queuedDirectory = queue.shift()!;
    const directory = await resolveReviewWalkEntry(canonicalRoot, queuedDirectory.absolutePath);
    if (directory === undefined || !directory.info.isDirectory()) continue;
    const directoryKey = process.platform === "win32"
      ? normalize(directory.absolutePath).toLocaleLowerCase("en-US")
      : normalize(directory.absolutePath);
    if (visitedDirectories.has(directoryKey)) continue;
    visitedDirectories.add(directoryKey);
    const entries = await readdir(directory.absolutePath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en-US"));
    for (const entry of entries) {
      entriesObserved += 1;
      if (entriesObserved > REVIEW_MAXIMUM_WALK_ENTRIES) return true;
      if (entry.isSymbolicLink() || reviewPathSegmentsAreSensitive([entry.name])) continue;
      const resolvedEntry = await resolveReviewWalkEntry(canonicalRoot, resolve(directory.absolutePath, entry.name));
      if (resolvedEntry === undefined) continue;
      if (resolvedEntry.info.isDirectory()) {
        queue.push({ absolutePath: resolvedEntry.absolutePath, relativePath: resolvedEntry.relativePath });
        continue;
      }
      if (!resolvedEntry.info.isFile()) continue;
      if (!(await visit({
        absolutePath: resolvedEntry.absolutePath,
        relativePath: resolvedEntry.relativePath,
        size: resolvedEntry.info.size
      }))) return true;
    }
  }
  return false;
}

async function resolveReviewWalkEntry(
  canonicalRoot: string,
  candidatePath: string
): Promise<ReviewResolvedPath | undefined> {
  const absolutePath = await realpath(candidatePath).catch(() => undefined);
  if (absolutePath === undefined) return undefined;
  const relativePath = relative(canonicalRoot, absolutePath);
  if (relativePath === ".."
    || relativePath.startsWith(`..${sep}`)
    || isAbsolute(relativePath)
    || reviewPathSegmentsAreSensitive(relativePath.split(/[\\/]/gu))) return undefined;
  const info = await stat(absolutePath).catch(() => undefined);
  if (info === undefined) return undefined;
  return {
    absolutePath,
    relativePath: relativePath.length === 0 ? "." : relativePath.replace(/\\/gu, "/"),
    info
  };
}

async function executeReviewGrep(workspaceRoot: string, args: JsonObject): Promise<string> {
  const query = args["query"];
  if (typeof query !== "string" || query.length === 0 || query.length > 512 || query.includes("\0")) {
    throw new ReviewToolInputError("The literal search query is invalid.");
  }
  if (args["caseSensitive"] !== undefined && typeof args["caseSensitive"] !== "boolean") {
    throw new ReviewToolInputError("The case-sensitivity option is invalid.");
  }
  const caseSensitive = args["caseSensitive"] === true;
  const needle = caseSensitive ? query : query.toLocaleLowerCase("en-US");
  const target = await resolveReviewToolPath(workspaceRoot, args["path"]);
  const results: string[] = [];
  let filesObserved = 0;
  let bytesObserved = 0;
  const truncated = await walkReviewFiles(workspaceRoot, target, async (file) => {
    filesObserved += 1;
    if (filesObserved > REVIEW_MAXIMUM_GREP_FILES) return false;
    if (file.size > REVIEW_MAXIMUM_READ_BYTES) return true;
    bytesObserved += file.size;
    if (bytesObserved > REVIEW_MAXIMUM_GREP_BYTES) return false;
    const bytes = await readFile(file.absolutePath);
    if (bytes.includes(0)) return true;
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return true;
    }
    const lines = text.split(/\r?\n/gu);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      const haystack = caseSensitive ? line : line.toLocaleLowerCase("en-US");
      if (!haystack.includes(needle)) continue;
      results.push(`${file.relativePath}:${index + 1}: ${line}`);
      if (results.length >= REVIEW_MAXIMUM_RESULTS) return false;
    }
    return true;
  });
  if (results.length === 0) return truncated ? "No match before the bounded scan limit." : "No match.";
  return `${results.join("\n")}${truncated ? "\n[scan truncated by reviewer boundary]" : ""}`;
}

async function executeReviewFind(workspaceRoot: string, args: JsonObject): Promise<string> {
  const pattern = args["pattern"];
  if (typeof pattern !== "string" || pattern.length === 0 || pattern.length > 256 || pattern.includes("\0")) {
    throw new ReviewToolInputError("The path wildcard is invalid.");
  }
  const matcher = reviewWildcardMatcher(pattern);
  const target = await resolveReviewToolPath(workspaceRoot, args["path"]);
  const results: string[] = [];
  const truncated = await walkReviewFiles(workspaceRoot, target, (file) => {
    if (matcher.test(file.relativePath.replace(/\\/gu, "/")) || matcher.test(basename(file.relativePath))) {
      results.push(file.relativePath);
    }
    return results.length < REVIEW_MAXIMUM_RESULTS;
  });
  if (results.length === 0) return truncated ? "No path matched before the bounded scan limit." : "No path matched.";
  return `${results.join("\n")}${truncated ? "\n[scan truncated by reviewer boundary]" : ""}`;
}

function reviewWildcardMatcher(pattern: string): RegExp {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }
    } else if (character === "?") {
      source += "[^/]";
    } else {
      source += character.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
    }
  }
  return new RegExp(`${source}$`, process.platform === "win32" ? "iu" : "u");
}

function validatedHostCapabilities(
  values: readonly HostComposedCapability[] | undefined
): ReadonlySet<HostComposedCapability> {
  const capabilities = new Set<HostComposedCapability>();
  for (const value of values ?? []) {
    if (!(HOST_COMPOSED_CAPABILITIES as readonly string[]).includes(value)) {
      throw new TypeError("Codex Host-composed capability is invalid.");
    }
    capabilities.add(value);
  }
  return capabilities;
}

function permissionModeFromResponse(value: JsonObject): PermissionMode {
  if (value["approvalPolicy"] !== "never") return "ask";
  const sandbox = value["sandbox"];
  if (isJsonObject(sandbox) && sandbox["type"] === "dangerFullAccess") return "bypassPermissions";
  if (sandbox === "danger-full-access") return "bypassPermissions";
  return "auto";
}

const CODEX_LOGIN_METHODS = Object.freeze([
  "api_key",
  "oauth_browser",
  "device_code"
] as const);

function accountSnapshot(account: JsonValue | undefined, requiresAuthentication: boolean): CodexAccountSnapshot {
  const authenticated = isJsonObject(account) || !requiresAuthentication;
  return {
    authenticated,
    requiresAuthentication,
    authenticationState: authenticated ? "authenticated" : requiresAuthentication ? "signed_out" : "not_required",
    supportsLogin: requiresAuthentication,
    supportsLogout: authenticated && requiresAuthentication,
    loginMethods: CODEX_LOGIN_METHODS,
    ...(isJsonObject(account) && typeof account["type"] === "string" ? { authMode: account["type"] } : {})
  };
}

function codexAccountModelsAvailable(state: BackendDescriptor["authenticationState"]): boolean {
  return state === "authenticated" || state === "not_required";
}

function codexProviderAccessKind(account: CodexAccountSnapshot | undefined): "managed" | "apiKey" | "subscription" {
  if (account?.authMode === "apiKey") return "apiKey";
  return "subscription";
}

function pendingAccountSnapshot(current: CodexAccountSnapshot | undefined): CodexAccountSnapshot {
  return {
    ...(current ?? accountSnapshot(null, true)),
    authenticationState: "pending",
    supportsLogin: true
  };
}

function nextPaginationCursor(
  nextCursor: string | undefined,
  seen: Set<string>,
  code: string,
  operation: string
): string | undefined {
  if (nextCursor === undefined) return undefined;
  if (nextCursor.length > 4_096
    || /[\u0000-\u001f\u007f]/.test(nextCursor)
    || seen.has(nextCursor)) {
    throw paginationError(code, operation);
  }
  seen.add(nextCursor);
  return nextCursor;
}

function paginationError(code: string, operation: string) {
  return adapterError({
    code,
    message: `The Codex app-server returned an invalid cursor sequence during ${operation}.`,
    phase: "probe",
    stateMayHaveChanged: false,
    recovery: "Verify the stable app-server protocol before retrying discovery."
  });
}

function bindingForThread(
  threadId: string,
  generation: number,
  profileKey: string
): NativeSessionBinding {
  return {
    opaqueRef: referenceForThread(threadId, profileKey),
    nativeSessionId: threadId,
    generation
  };
}

function bindingFromReference(reference: string, generation: number): NativeSessionBinding {
  const parsed = parseNativeReference(reference);
  return {
    opaqueRef: reference,
    nativeSessionId: parsed.threadId,
    generation
  };
}

function referenceForThread(
  threadId: string,
  profileKey: string,
  sourceFingerprint?: string
): string {
  if (!isValidNativeThreadId(threadId) || !validReferenceDigest(profileKey)
    || (sourceFingerprint !== undefined && !validReferenceDigest(sourceFingerprint))) {
    throw invalidNativeReference();
  }
  const payload = {
    v: NATIVE_REFERENCE_VERSION,
    p: profileKey,
    t: threadId,
    ...(sourceFingerprint === undefined ? {} : { s: sourceFingerprint })
  };
  return `${NATIVE_REFERENCE_PREFIX}${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
}

function nativeThreadId(reference: string): string {
  return parseNativeReference(reference).threadId;
}

function parseNativeReference(reference: string): {
  readonly threadId: string;
  readonly profileKey: string;
  readonly sourceFingerprint?: string;
} {
  if (!reference.startsWith(NATIVE_REFERENCE_PREFIX)) throw invalidNativeReference();
  try {
    const encoded = reference.slice(NATIVE_REFERENCE_PREFIX.length);
    if (encoded.length === 0 || encoded.length > 2_048 || !/^[A-Za-z0-9_-]+$/u.test(encoded)) {
      throw new Error("invalid encoded reference");
    }
    const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid reference");
    const record = value as Readonly<Record<string, unknown>>;
    const keys = Object.keys(record).sort().join(",");
    const hasSource = record["s"] !== undefined;
    if (record["v"] !== NATIVE_REFERENCE_VERSION
      || keys !== (hasSource ? "p,s,t,v" : "p,t,v")
      || typeof record["p"] !== "string"
      || typeof record["t"] !== "string"
      || !validReferenceDigest(record["p"])
      || !isValidNativeThreadId(record["t"])
      || (hasSource && (typeof record["s"] !== "string" || !validReferenceDigest(record["s"])))) {
      throw new Error("invalid reference fields");
    }
    return {
      threadId: record["t"],
      profileKey: record["p"],
      ...(hasSource ? { sourceFingerprint: record["s"] as string } : {})
    };
  } catch (error) {
    if (error !== null && typeof error === "object" && "publicError" in error) throw error;
    throw invalidNativeReference();
  }
}

function validReferenceDigest(value: string): boolean {
  return /^[0-9a-f]{64}$/u.test(value);
}

function invalidNativeReference() {
  return adapterError({
    code: "CODEX_NATIVE_REFERENCE_INVALID",
    message: "The Codex native Session reference is invalid or belongs to another profile.",
    phase: "probe",
    recovery: "Refresh native Session discovery."
  });
}

function expiredCatalogReference() {
  return adapterError({
    code: "CODEX_CATALOG_REFERENCE_EXPIRED",
    message: "The selected Codex catalog reference is no longer available.",
    phase: "provision",
    retryable: true,
    recovery: "Scan local tasks again and retry the import."
  });
}

function threadIdFromBinding(binding: NativeSessionBinding): string {
  const referenceThreadId = nativeThreadId(binding.opaqueRef);
  if (binding.nativeSessionId === undefined) return referenceThreadId;
  if (!isValidNativeThreadId(binding.nativeSessionId) || binding.nativeSessionId !== referenceThreadId) {
    throw adapterError({
      code: "CODEX_SESSION_BINDING_MISMATCH",
      message: "The Codex native Session binding contains conflicting thread identities.",
      phase: "probe",
      recovery: "Refresh the durable Session binding from native Session discovery."
    });
  }
  return binding.nativeSessionId;
}

function isValidNativeThreadId(value: string): boolean {
  return value.length > 0 && value.length <= 512 && !/[\u0000-\u001f]/.test(value);
}

async function assertNativeThreadTarget(
  thread: NativeThread,
  expectedThreadId: string,
  workspaceRoot: string,
  phase: "probe" | "provision"
): Promise<void> {
  if (thread.id !== expectedThreadId || !(await nativeThreadMatchesWorkspace(thread, workspaceRoot))) {
    throw adapterError({
      code: "CODEX_NATIVE_SESSION_TARGET_MISMATCH",
      message: "The Codex native Session identity or workspace does not match the selected Target.",
      phase,
      recovery: "Choose a native thread discovered for this exact Target workspace."
    });
  }
}

async function nativeThreadMatchesWorkspace(thread: NativeThread, workspaceRoot: string): Promise<boolean> {
  if (thread.cwd === undefined || !isAbsolute(thread.cwd)) return false;
  let nativeWorkspace: string;
  try {
    nativeWorkspace = await realpath(thread.cwd);
  } catch {
    return false;
  }
  return equalNativePaths(nativeWorkspace, workspaceRoot);
}

function equalNativePaths(left: string, right: string): boolean {
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLocaleLowerCase("en-US") === normalizedRight.toLocaleLowerCase("en-US")
    : normalizedLeft === normalizedRight;
}

function backendGeneration(context: AdapterContext): number {
  return context.backendInstanceGeneration ?? -1;
}

function serializedByteLength(value: JsonValue): number {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new ProtocolShapeError("native history is not serializable");
    return Buffer.byteLength(serialized, "utf8");
  } catch (error) {
    if (error instanceof ProtocolShapeError) throw error;
    throw new ProtocolShapeError("native history is not serializable");
  }
}

function turnIdFromParams(params: JsonValue): string | undefined {
  if (!isJsonObject(params)) return undefined;
  const direct = params["turnId"];
  if (typeof direct === "string" && isValidNativeThreadId(direct)) return direct;
  const turn = params["turn"];
  if (!isJsonObject(turn)) return undefined;
  const nested = turn["id"];
  return typeof nested === "string" && isValidNativeThreadId(nested) ? nested : undefined;
}

function threadIdFromParams(params: JsonValue): string | undefined {
  if (!isJsonObject(params)) return undefined;
  const direct = params["threadId"];
  if (typeof direct === "string" && isValidNativeThreadId(direct)) return direct;
  const thread = params["thread"];
  if (!isJsonObject(thread)) return undefined;
  const nested = thread["id"];
  return typeof nested === "string" && isValidNativeThreadId(nested) ? nested : undefined;
}

function collaborationModeForTurn(runtime: SessionRuntime): JsonObject | undefined {
  if (!runtime.planMode && !runtime.collaborationTouched) return undefined;
  if (runtime.modelId === undefined) {
    throw adapterError({
      code: "CODEX_MODEL_SELECTION_REQUIRED",
      message: "Codex Plan mode requires an explicit active model.",
      phase: "dispatch",
      recovery: "Select a model before sending a Plan-mode turn."
    });
  }
  return collaborationModeValue(
    runtime.planMode,
    runtime.modelId,
    runtime.effort,
    runtime.planMode || runtime.defaultCollaborationMarkerPending ? null : ""
  );
}

function collaborationModeValue(
  enabled: boolean,
  modelId: string,
  effort: string | undefined,
  developerInstructions: string | null
): JsonObject {
  return {
    mode: enabled ? "plan" : "default",
    settings: {
      model: modelId,
      reasoning_effort: effort ?? null,
      developer_instructions: developerInstructions
    }
  };
}

function reconcileRuntimeSettings(runtime: SessionRuntime, method: string, params: JsonValue): void {
  if (method !== "thread/settings/updated" || !isJsonObject(params) || !isJsonObject(params["threadSettings"])) return;
  const settings = params["threadSettings"];
  if (typeof settings["model"] === "string" && settings["model"].length > 0) runtime.modelId = settings["model"];
  if (Object.hasOwn(settings, "effort")) {
    runtime.effort = typeof settings["effort"] === "string" ? settings["effort"] : undefined;
  }
  if (Object.hasOwn(settings, "serviceTier")) {
    runtime.fastMode = isFastServiceTier(settings["serviceTier"]);
    runtime.state.observedFastMode = observedFastServiceTier(settings);
  }
  const collaboration = isJsonObject(settings["collaborationMode"])
    ? settings["collaborationMode"]
    : undefined;
  if (collaboration?.["mode"] === "plan" || collaboration?.["mode"] === "default") {
    runtime.planMode = collaboration["mode"] === "plan";
    runtime.collaborationTouched = true;
    if (runtime.planMode) runtime.defaultCollaborationMarkerPending = false;
  }
  runtime.nativeTasks.updateRoute(runtime.providerId, runtime.modelId, runtime.effort);
}

function rpcRequestKey(requestId: string | number): string {
  return `${typeof requestId}:${String(requestId)}`;
}

function compactionTerminal(method: string, params: JsonValue): "completed" | "failed" | undefined {
  if (method === "item/completed") {
    const record = isJsonObject(params) ? params : undefined;
    const item = isJsonObject(record?.["item"]) ? record["item"] : undefined;
    return item?.["type"] === "contextCompaction" ? "completed" : undefined;
  }
  if (method !== "turn/completed") return undefined;
  const record = isJsonObject(params) ? params : undefined;
  const turn = isJsonObject(record?.["turn"]) ? record["turn"] : undefined;
  const items = Array.isArray(turn?.["items"]) ? turn["items"] : [];
  if (!items.some((item) => isJsonObject(item) && item["type"] === "contextCompaction")) return undefined;
  return turn?.["status"] === "completed" ? "completed" : "failed";
}

function stateFromRuntime(runtime: SessionRuntime, thread?: NativeThread): NativeSessionState {
  return {
    binding: runtime.binding,
    ...(thread?.name === null || (thread?.name === undefined && runtime.name === undefined)
      ? {}
      : { name: thread?.name ?? runtime.name }),
    streaming: runtime.state.activeTurnId !== undefined || thread?.status?.["type"] === "active",
    compacting: false,
    pendingMessages: 0,
    ...(runtime.providerId === undefined ? {} : { providerId: runtime.providerId }),
    ...(runtime.modelId === undefined ? {} : { modelId: runtime.modelId }),
    ...(runtime.effort === undefined ? {} : { effort: runtime.effort }),
    fastMode: runtime.fastMode,
    permissionMode: runtime.permissionMode,
    planMode: runtime.planMode,
    ...(runtime.state.usage === undefined ? {} : { usage: runtime.state.usage })
  };
}

function stateFromThread(binding: NativeSessionBinding, thread: NativeThread): NativeSessionState {
  return {
    binding,
    ...(thread.name === null || thread.name === undefined ? {} : { name: thread.name }),
    streaming: thread.status?.["type"] === "active",
    compacting: false,
    pendingMessages: 0,
    fastMode: false,
    permissionMode: "ask"
  };
}

function modelFromNative(model: NativeModel, providerId: string): ProviderModel {
  const estimate = codexModelEstimate(model.model);
  return {
    providerId,
    modelId: model.model,
    displayName: model.displayName,
    api: "openai-responses",
    contextWindow: estimate?.contextWindow ?? 0,
    maxOutputTokens: estimate?.maximumOutputTokens ?? 0,
    supportsImages: model.inputModalities.includes("image"),
    defaultVisible: !model.hidden,
    supportsFastMode: model.serviceTiers.some((tier) => tier.id === "fast" || tier.id === "priority"),
    thinkingLevels: model.supportedReasoningEfforts.map((effort) => effort.reasoningEffort),
    cost: estimate?.price === undefined ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } : {
      input: estimate.price.input,
      output: estimate.price.output,
      cacheRead: estimate.price.cacheRead ?? 0,
      cacheWrite: estimate.price.cacheWrite ?? 0
    },
    ...(estimate?.price === undefined ? {} : {
      pricing: {
        source: "providerReference" as const,
        currencyCode: "USD",
        updatedAt: estimate.updatedAt ?? CODEX_MODEL_ESTIMATES_UPDATED_AT,
        cacheReadAvailable: estimate.price.cacheRead !== undefined,
        cacheWriteAvailable: estimate.price.cacheWrite !== undefined,
        ...(estimate.fastModeMultiplier === undefined ? {} : { fastModeMultiplier: estimate.fastModeMultiplier }),
        ...(estimate.longContext === undefined ? {} : { longContext: estimate.longContext })
      }
    })
  };
}

function isFastServiceTier(value: JsonValue | undefined): boolean {
  return value === "fast" || value === "priority";
}

function cancelledDispatch() {
  return adapterError({
    code: "CODEX_DISPATCH_CANCELLED",
    message: "The Codex input was cancelled before dispatch.",
    phase: "dispatch",
    recovery: "Keep the input and explicitly send it when ready."
  });
}

function assertDispatchNotCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw cancelledDispatch();
}

function waitForDispatchPreparation<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(cancelledDispatch());
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      signal.removeEventListener("abort", onAbort);
      onAbort();
    }
    pending.then(
      (result) => { signal.removeEventListener("abort", onAbort); resolve(result); },
      (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error); }
    );
  });
}

function nativeHistoryReadFailure(reason: "TIMEOUT" | "CANCELLED" | "STALE" | "SIZE_LIMIT") {
  return adapterError({
    code: `CODEX_NATIVE_HISTORY_${reason}`,
    message: reason === "STALE"
      ? "The Codex native history changed while its complete history was being read."
      : reason === "SIZE_LIMIT"
        ? "The Codex native history exceeds the configured safe read limit."
        : reason === "TIMEOUT"
          ? "The complete Codex native history read exceeded its deadline."
          : "The Codex native history read was cancelled.",
    phase: "probe",
    recovery: "Refresh the current native Session before explicitly reading its history again."
  });
}

function fullTurnSignature(turn: NativeTurn | undefined): string | undefined {
  return turn === undefined ? undefined : JSON.stringify({ ...turn, itemsView: "full" });
}

function waitForHistoryRead<T>(pending: Promise<T>, signal: AbortSignal, cancelled: () => Error): Promise<T> {
  return new Promise<T>((resolveWait, reject) => {
    const onAbort = (): void => reject(cancelled());
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      signal.removeEventListener("abort", onAbort);
      onAbort();
    }
    pending.then(
      (result) => { signal.removeEventListener("abort", onAbort); resolveWait(result); },
      (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error); }
    );
  });
}

function observedFastServiceTier(record: JsonObject): boolean | undefined {
  const tier = record["serviceTier"];
  return isFastServiceTier(tier) ? true : tier === null || tier === "default" ? false : undefined;
}

function versionFromUserAgent(userAgent: string | undefined): string {
  if (userAgent === undefined) return "unknown";
  return userAgent.match(/\b\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?\b/)?.[0] ?? "unknown";
}

function loginUrl(value: JsonValue | undefined): string {
  const raw = stringValue(value, "login URL");
  if (raw.length > 4_096) {
    throw adapterError({
      code: "CODEX_AUTH_PROTOCOL_INCOMPATIBLE",
      message: "The Codex app-server returned an invalid login URL.",
      phase: "probe",
      recovery: "Restart the native login flow with a compatible Codex version."
    });
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw adapterError({
      code: "CODEX_AUTH_PROTOCOL_INCOMPATIBLE",
      message: "The Codex app-server returned an invalid login URL.",
      phase: "probe",
      recovery: "Restart the native login flow with a compatible Codex version."
    });
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw adapterError({
      code: "CODEX_AUTH_PROTOCOL_INCOMPATIBLE",
      message: "The Codex login URL uses an unsafe scheme.",
      phase: "probe",
      recovery: "Use a compatible native login flow."
    });
  }
  return raw;
}
