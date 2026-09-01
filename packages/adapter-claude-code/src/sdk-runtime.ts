import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  DurableProcessOwner,
  type DurableProcessLease,
  type DurableProcessOwnerOptions
} from "@joko/runtime-governance";

export const CLAUDE_AGENT_SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";
export const CLAUDE_AGENT_SDK_VERSION = "0.3.239";

export type ClaudeSdkPermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "dontAsk"
  | "auto";

export type ClaudePermissionUpdate =
  | {
      readonly type: "addRules" | "replaceRules" | "removeRules";
      readonly rules: {
        readonly toolName: string;
        readonly ruleContent?: string;
      }[];
      readonly behavior: "allow" | "deny" | "ask";
      readonly destination: "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg";
    }
  | {
      readonly type: "setMode";
      readonly mode: ClaudeSdkPermissionMode;
      readonly destination: "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg";
    }
  | {
      readonly type: "addDirectories" | "removeDirectories";
      readonly directories: string[];
      readonly destination: "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg";
    };

export type ClaudePermissionResult =
  | {
      readonly behavior: "allow";
      readonly updatedInput: Record<string, unknown>;
      readonly updatedPermissions?: ClaudePermissionUpdate[];
    }
  | {
      readonly behavior: "deny";
      readonly message: string;
      readonly interrupt?: boolean;
    };

export interface ClaudeCanUseToolOptions {
  readonly signal: AbortSignal;
  readonly suggestions?: readonly ClaudePermissionUpdate[];
  readonly blockedPath?: string;
  readonly decisionReason?: string;
  readonly title?: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly toolUseID: string;
  readonly agentID?: string;
  readonly requestId: string;
}

export interface ClaudeSdkOAuthTokenOptions {
  readonly signal: AbortSignal;
  readonly onDecline?: () => void;
}

export type ClaudeSdkOAuthTokenProvider = (
  options: ClaudeSdkOAuthTokenOptions
) => Promise<string | null>;

export interface ClaudeSdkUserMessage {
  readonly type: "user";
  readonly message: {
    readonly role: "user";
    readonly content: string | readonly Readonly<Record<string, unknown>>[];
  };
  readonly parent_tool_use_id: null;
  readonly origin: { readonly kind: "human" };
  readonly uuid: string;
}

export interface ClaudeSdkModelInfo {
  readonly value: string;
  readonly resolvedModel?: string;
  readonly displayName: string;
  readonly description: string;
  readonly supportsEffort?: boolean;
  readonly supportedEffortLevels?: readonly ("low" | "medium" | "high" | "xhigh" | "max")[];
  readonly supportsAdaptiveThinking?: boolean;
  readonly supportsFastMode?: boolean;
}

export interface ClaudeSdkAccountInfo {
  readonly email?: string;
  readonly organization?: string;
  readonly subscriptionType?: string;
  readonly tokenSource?: string;
  readonly apiKeySource?: string;
  readonly apiProvider?: string;
}

export interface ClaudeSdkInitializationResult {
  readonly models: readonly ClaudeSdkModelInfo[];
  readonly account: ClaudeSdkAccountInfo;
  readonly commands?: readonly Readonly<Record<string, unknown>>[];
  readonly fast_mode_state?: string;
  readonly fast_mode_disabled_reason?: string;
}

export interface ClaudeSdkQuery extends AsyncIterable<unknown> {
  interrupt(): Promise<{ readonly still_queued?: readonly string[] } | undefined>;
  stopTask(taskId: string): Promise<void>;
  setPermissionMode(mode: ClaudeSdkPermissionMode): Promise<void>;
  setModel(model?: string): Promise<void>;
  applyFlagSettings(settings: {
    readonly effortLevel?: "low" | "medium" | "high" | "xhigh" | "max" | null;
    readonly permissions?: {
      readonly additionalDirectories?: readonly string[];
    } | null;
  }): Promise<void>;
  initializationResult(): Promise<ClaudeSdkInitializationResult>;
  supportedModels(): Promise<readonly ClaudeSdkModelInfo[]>;
  accountInfo(): Promise<ClaudeSdkAccountInfo>;
  close(): void;
}

export interface ClaudeSdkQueryOptions {
  readonly abortController: AbortController;
  readonly additionalDirectories: readonly string[];
  readonly allowDangerouslySkipPermissions: boolean;
  readonly agents?: Readonly<Record<string, never>>;
  readonly canUseTool: (
    toolName: string,
    input: Readonly<Record<string, unknown>>,
    options: ClaudeCanUseToolOptions
  ) => Promise<ClaudePermissionResult>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly extraArgs?: Readonly<Record<string, string | null>>;
  readonly getOAuthToken?: ClaudeSdkOAuthTokenProvider;
  readonly effort?: "low" | "medium" | "high" | "xhigh" | "max";
  readonly forwardSubagentText?: boolean;
  readonly includePartialMessages: true;
  readonly disallowedTools?: readonly string[];
  readonly mcpServers?: Readonly<Record<string, never>>;
  readonly model?: string;
  readonly pathToClaudeCodeExecutable?: string;
  readonly permissionMode: ClaudeSdkPermissionMode;
  readonly persistSession: boolean;
  readonly resume?: string;
  readonly sessionId?: string;
  readonly settings?: Exclude<NativeOptions["settings"], string>;
  readonly settingSources: readonly ("user" | "project" | "local")[];
  readonly skills?: readonly string[];
  readonly strictMcpConfig?: true;
  readonly systemPrompt: {
    readonly type: "preset";
    readonly preset: "claude_code";
    readonly append?: string;
  };
  readonly title?: string;
  readonly tools: readonly string[] | { readonly type: "preset"; readonly preset: "claude_code" };
}

export interface ClaudeSdkQueryParams {
  readonly prompt: AsyncIterable<ClaudeSdkUserMessage>;
  readonly options: ClaudeSdkQueryOptions;
}

export interface ClaudeSdkSessionInfo {
  readonly sessionId: string;
  readonly summary: string;
  readonly lastModified: number;
  readonly customTitle?: string;
  readonly cwd?: string;
}

export interface ClaudeSdkListSessionsOptions {
  readonly dir: string;
  readonly limit: number;
  readonly offset: number;
  readonly includeWorktrees: false;
  readonly includeProgrammatic: true;
}

export interface ClaudeSdkGetSessionMessagesOptions {
  readonly dir: string;
  readonly limit: number;
  readonly offset: number;
  readonly includeSystemMessages: true;
}

export interface ClaudeSdkSessionMessage {
  readonly type: "user" | "assistant" | "system";
  readonly uuid: string;
  readonly session_id: string;
  readonly message: unknown;
  readonly parent_tool_use_id: string | null;
  readonly parent_agent_id: string | null;
}

export interface ClaudeSdkProbeInput {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly getOAuthToken?: ClaudeSdkOAuthTokenProvider;
  readonly pathToClaudeCodeExecutable?: string;
  readonly settingSources: readonly ("user" | "project" | "local")[];
  readonly initializationTimeoutMs: number;
}

export interface ClaudeSdkProbe {
  readonly installed: boolean;
  readonly packageVersion: string;
  readonly initialization?: ClaudeSdkInitializationResult;
  readonly cliVersion?: string;
  readonly apiKeySource?: string;
  readonly diagnostic?: string;
}

export interface ClaudeSdkRuntime {
  readonly packageVersion: string;
  probe(input: ClaudeSdkProbeInput): Promise<ClaudeSdkProbe>;
  query(params: ClaudeSdkQueryParams): Promise<ClaudeSdkQuery>;
  getSessionInfo(sessionId: string, options: { readonly dir: string }): Promise<ClaudeSdkSessionInfo | undefined>;
  getSessionMessages(
    sessionId: string,
    options: ClaudeSdkGetSessionMessagesOptions
  ): Promise<readonly ClaudeSdkSessionMessage[]>;
  listSessions(options: ClaudeSdkListSessionsOptions): Promise<readonly ClaudeSdkSessionInfo[]>;
  deleteSession(sessionId: string, options: { readonly dir: string }): Promise<void>;
  /** Confirm hard retirement of every exact local CLI process still owned by this runtime. */
  retireOwnedProcesses?(timeoutMs: number): Promise<void>;
}

interface LoadedSdkModule {
  readonly query: (params: {
    readonly prompt: string | AsyncIterable<NativeSdkUserMessage>;
    readonly options?: NativeOptionsWithOAuth;
  }) => NativeQuery;
  readonly startup: (params?: {
    readonly options?: NativeOptionsWithOAuth;
    readonly initializeTimeoutMs?: number;
  }) => Promise<NativeWarmQuery>;
  readonly getSessionInfo: (
    sessionId: string,
    options: { readonly dir: string }
  ) => Promise<ClaudeSdkSessionInfo | undefined>;
  readonly getSessionMessages: (
    sessionId: string,
    options: ClaudeSdkGetSessionMessagesOptions
  ) => Promise<ClaudeSdkSessionMessage[]>;
  readonly listSessions: (options: ClaudeSdkListSessionsOptions) => Promise<readonly ClaudeSdkSessionInfo[]>;
  readonly deleteSession: (sessionId: string, options: { readonly dir: string }) => Promise<void>;
}

export class DefaultClaudeSdkRuntime implements ClaudeSdkRuntime {
  readonly packageVersion = CLAUDE_AGENT_SDK_VERSION;
  readonly #processOwner: DurableProcessOwner | undefined;
  readonly #retirementTimeoutMs: number;
  #module: Promise<LoadedSdkModule> | undefined;

  constructor(options: {
    readonly processOwner?: DurableProcessOwnerOptions;
    readonly retirementTimeoutMs?: number;
  } = {}) {
    this.#processOwner = options.processOwner === undefined
      ? undefined
      : new DurableProcessOwner(options.processOwner);
    this.#retirementTimeoutMs = positiveTimeout(options.retirementTimeoutMs, 5_000);
  }

  async probe(input: ClaudeSdkProbeInput): Promise<ClaudeSdkProbe> {
    let loaded: LoadedSdkModule;
    try {
      loaded = await this.#load();
    } catch (error) {
      return {
        installed: false,
        packageVersion: this.packageVersion,
        diagnostic: moduleMissing(error)
          ? `Claude Agent SDK ${this.packageVersion} is not installed.`
          : `Claude Agent SDK ${this.packageVersion} could not be loaded.`
      };
    }

    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), input.initializationTimeoutMs);
    let warmQuery: NativeWarmQuery | undefined;
    let query: NativeQuery | undefined;
    try {
      await this.#processOwner?.prepare(this.#retirementTimeoutMs);
      warmQuery = await loaded.startup({
        initializeTimeoutMs: input.initializationTimeoutMs,
        options: {
          abortController,
          allowDangerouslySkipPermissions: false,
          cwd: input.cwd,
          env: { ...input.env },
          ...(input.getOAuthToken === undefined ? {} : { getOAuthToken: input.getOAuthToken }),
          ...(input.pathToClaudeCodeExecutable === undefined
            ? {}
            : { pathToClaudeCodeExecutable: input.pathToClaudeCodeExecutable }),
          permissionMode: "dontAsk",
          persistSession: false,
          ...(this.#processOwner === undefined
            ? {}
            : { spawnClaudeCodeProcess: (options) => this.#spawnOwnedProcess(options) }),
          settingSources: [...input.settingSources],
          tools: []
        }
      });
      query = warmQuery.query(emptySdkInput());
      const initialization = await query.initializationResult() as unknown as ClaudeSdkInitializationResult;
      const observation = await observeStartupInitialization(query, input.initializationTimeoutMs);
      return {
        installed: true,
        packageVersion: this.packageVersion,
        initialization,
        ...(observation.cliVersion === undefined ? {} : { cliVersion: observation.cliVersion }),
        ...(observation.apiKeySource === undefined ? {} : { apiKeySource: observation.apiKeySource })
      };
    } catch {
      return {
        installed: true,
        packageVersion: this.packageVersion,
        diagnostic: "The native CLI could not complete the bounded startup probe."
      };
    } finally {
      clearTimeout(timer);
      try {
        query?.close();
      } catch {
        // The probe AbortController and process handle remain the cleanup boundary.
      }
      if (query === undefined) {
        try {
          warmQuery?.close();
        } catch {
          // The probe AbortController remains the cleanup boundary.
        }
      }
      abortController.abort();
    }
  }

  async query(params: ClaudeSdkQueryParams): Promise<ClaudeSdkQuery> {
    await this.#processOwner?.prepare(this.#retirementTimeoutMs);
    const options: NativeOptionsWithOAuth = {
      abortController: params.options.abortController,
      additionalDirectories: [...params.options.additionalDirectories],
      allowDangerouslySkipPermissions: params.options.allowDangerouslySkipPermissions,
      ...(params.options.agents === undefined ? {} : { agents: { ...params.options.agents } }),
      canUseTool: params.options.canUseTool,
      cwd: params.options.cwd,
      env: { ...params.options.env },
      ...(params.options.extraArgs === undefined ? {} : { extraArgs: { ...params.options.extraArgs } }),
      ...(params.options.getOAuthToken === undefined ? {} : { getOAuthToken: params.options.getOAuthToken }),
      ...(params.options.effort === undefined ? {} : { effort: params.options.effort }),
      ...(params.options.forwardSubagentText === undefined
        ? {}
        : { forwardSubagentText: params.options.forwardSubagentText }),
      includePartialMessages: params.options.includePartialMessages,
      ...(params.options.disallowedTools === undefined
        ? {}
        : { disallowedTools: [...params.options.disallowedTools] }),
      ...(params.options.mcpServers === undefined ? {} : { mcpServers: { ...params.options.mcpServers } }),
      ...(params.options.model === undefined ? {} : { model: params.options.model }),
      ...(params.options.pathToClaudeCodeExecutable === undefined
        ? {}
        : { pathToClaudeCodeExecutable: params.options.pathToClaudeCodeExecutable }),
      permissionMode: params.options.permissionMode,
      persistSession: params.options.persistSession,
      ...(this.#processOwner === undefined
        ? {}
        : { spawnClaudeCodeProcess: (spawnOptions) => this.#spawnOwnedProcess(spawnOptions) }),
      ...(params.options.resume === undefined ? {} : { resume: params.options.resume }),
      ...(params.options.sessionId === undefined ? {} : { sessionId: params.options.sessionId }),
      ...(params.options.settings === undefined ? {} : { settings: { ...params.options.settings } }),
      settingSources: [...params.options.settingSources],
      ...(params.options.skills === undefined ? {} : { skills: [...params.options.skills] }),
      ...(params.options.strictMcpConfig === undefined ? {} : { strictMcpConfig: params.options.strictMcpConfig }),
      systemPrompt: params.options.systemPrompt,
      ...(params.options.title === undefined ? {} : { title: params.options.title }),
      tools: Array.isArray(params.options.tools)
        ? [...params.options.tools]
        : { type: "preset", preset: "claude_code" }
    };
    return (await this.#load()).query({
      prompt: params.prompt as AsyncIterable<NativeSdkUserMessage>,
      options
    }) as unknown as ClaudeSdkQuery;
  }

  async getSessionInfo(
    sessionId: string,
    options: { readonly dir: string }
  ): Promise<ClaudeSdkSessionInfo | undefined> {
    return (await this.#load()).getSessionInfo(sessionId, options);
  }

  async getSessionMessages(
    sessionId: string,
    options: ClaudeSdkGetSessionMessagesOptions
  ): Promise<readonly ClaudeSdkSessionMessage[]> {
    return (await this.#load()).getSessionMessages(sessionId, options);
  }

  async listSessions(options: ClaudeSdkListSessionsOptions): Promise<readonly ClaudeSdkSessionInfo[]> {
    return (await this.#load()).listSessions(options);
  }

  async deleteSession(sessionId: string, options: { readonly dir: string }): Promise<void> {
    await (await this.#load()).deleteSession(sessionId, options);
  }

  async retireOwnedProcesses(timeoutMs: number): Promise<void> {
    await this.#processOwner?.retireAll(timeoutMs);
  }

  #load(): Promise<LoadedSdkModule> {
    this.#module ??= loadSdkModule();
    return this.#module;
  }

  #spawnOwnedProcess(options: NativeSpawnOptions): NativeSpawnedProcess {
    const owner = this.#processOwner;
    if (owner === undefined) throw new Error("Claude CLI process ownership is not configured.");
    return spawnOwnedClaudeCodeProcess(options, owner, this.#retirementTimeoutMs);
  }
}

async function loadSdkModule(): Promise<LoadedSdkModule> {
  const moduleName: string = CLAUDE_AGENT_SDK_PACKAGE;
  const value: unknown = await import(moduleName);
  if (!isRecord(value)
    || typeof value["query"] !== "function"
    || typeof value["startup"] !== "function"
    || typeof value["getSessionInfo"] !== "function"
    || typeof value["getSessionMessages"] !== "function"
    || typeof value["listSessions"] !== "function"
    || typeof value["deleteSession"] !== "function") {
    throw new Error("The installed Claude Agent SDK has an incompatible module surface.");
  }
  return value as unknown as LoadedSdkModule;
}

async function* emptySdkInput(): AsyncGenerator<NativeSdkUserMessage> {
  // Intentionally empty: startup discovery must never dispatch a user prompt.
}

async function observeStartupInitialization(
  query: NativeQuery,
  initializationTimeoutMs: number
): Promise<{ readonly cliVersion?: string; readonly apiKeySource?: string }> {
  const maximumWaitMs = Math.min(initializationTimeoutMs, 1_000);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const observation = (async () => {
    let frames = 0;
    for await (const message of query) {
      frames += 1;
      if (frames > 16) return {};
      const envelope = isRecord(message) ? message : undefined;
      if (envelope?.["type"] !== "system" || envelope["subtype"] !== "init") continue;
      const cliVersion = typeof envelope["claude_code_version"] === "string"
        ? envelope["claude_code_version"]
        : undefined;
      const apiKeySource = typeof envelope["apiKeySource"] === "string"
        ? envelope["apiKeySource"]
        : undefined;
      return {
        ...(cliVersion === undefined ? {} : { cliVersion }),
        ...(apiKeySource === undefined ? {} : { apiKeySource })
      };
    }
    return {};
  })().catch(() => ({}));
  const bounded = new Promise<{}>((resolvePromise) => {
    timeout = setTimeout(() => resolvePromise({}), maximumWaitMs);
  });
  try {
    return await Promise.race([observation, bounded]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function moduleMissing(error: unknown): boolean {
  return isRecord(error)
    && (error["code"] === "ERR_MODULE_NOT_FOUND" || error["code"] === "MODULE_NOT_FOUND");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Internal seam for fault-injection tests of the SDK custom-spawn contract. */
export function spawnOwnedClaudeCodeProcess(
  options: NativeSpawnOptions,
  owner: DurableProcessOwner,
  retirementTimeoutMs: number
): NativeSpawnedProcess {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: { ...options.env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  if (child.pid === undefined) {
    child.once("error", () => undefined);
    try { child.kill("SIGKILL"); } catch { /* Spawn already failed. */ }
    throw new Error("Claude CLI process has no PID.");
  }
  let lease: DurableProcessLease;
  try {
    lease = owner.claimSync(child.pid);
  } catch (error) {
    child.once("error", () => undefined);
    try { child.kill("SIGKILL"); } catch { /* The child may already have exited. */ }
    throw new Error("Claude CLI process owner could not be established.", { cause: error });
  }
  // The public custom-spawn contract has no stderr stream. Drain it without
  // logging so a verbose child cannot block and native diagnostics cannot
  // leak environment or credential fragments.
  child.stderr.resume();
  return ownedSpawnedProcess(child, lease, owner, options.signal, retirementTimeoutMs);
}

function ownedSpawnedProcess(
  child: ChildProcessWithoutNullStreams,
  lease: DurableProcessLease,
  owner: DurableProcessOwner,
  forwardedSignal: AbortSignal,
  retirementTimeoutMs: number
): NativeSpawnedProcess {
  let retirementRequested = false;
  let retirementFlight: Promise<void> | undefined;
  const retire = (): Promise<void> => {
    retirementRequested = true;
    retirementFlight ??= owner.retireLease(lease, retirementTimeoutMs);
    return retirementFlight;
  };
  const onAbort = (): void => { void retire().catch(() => undefined); };
  const onExit = (): void => {
    forwardedSignal.removeEventListener("abort", onAbort);
    void owner.releaseAfterExit(lease).catch(() => undefined);
  };
  forwardedSignal.addEventListener("abort", onAbort, { once: true });
  child.once("exit", onExit);
  if (forwardedSignal.aborted) onAbort();

  return {
    stdin: child.stdin,
    stdout: child.stdout,
    get killed() { return retirementRequested || child.killed; },
    get exitCode() { return child.exitCode; },
    get signalCode() { return child.signalCode; },
    kill: (_signal) => {
      void retire().catch(() => undefined);
      return true;
    },
    on: (event, listener) => { child.on(event, listener); },
    once: (event, listener) => { child.once(event, listener); },
    off: (event, listener) => { child.off(event, listener); }
  };
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new TypeError("Process timeout must be positive.");
  return resolved;
}
import type {
  Options as NativeOptions,
  Query as NativeQuery,
  SDKUserMessage as NativeSdkUserMessage,
  SpawnedProcess as NativeSpawnedProcess,
  SpawnOptions as NativeSpawnOptions,
  WarmQuery as NativeWarmQuery
} from "@anthropic-ai/claude-agent-sdk";

type NativeOptionsWithOAuth = NativeOptions & {
  readonly getOAuthToken?: ClaudeSdkOAuthTokenProvider;
};
