import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { TargetDescriptor } from "@joko/core";
import { SessionSdkOwner } from "./session-sdk-owner.js";
import {
  DurableProcessOwner,
  type DurableProcessLease,
  type DurableProcessOwnerOptions
} from "@joko/runtime-governance";
import { z } from "zod";

export const CLAUDE_AGENT_SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";
export const CLAUDE_AGENT_SDK_VERSION = "0.3.259";
/** The fixed SDK package metadata binds its bundled executable to this exact
 * CLI version. This is authoritative only while no executable override is
 * supplied; an override must still prove its own version through a live init. */
export const CLAUDE_AGENT_SDK_CLI_VERSION = "2.1.259";
export const CLAUDE_MANAGED_AGENT_SERVER = "joko_managed_subagent";
export const CLAUDE_MANAGED_AGENT_TOOL = "delegate";
export const CLAUDE_MANAGED_AGENT_TOOL_NAME = `mcp__${CLAUDE_MANAGED_AGENT_SERVER}__${CLAUDE_MANAGED_AGENT_TOOL}`;
const MAXIMUM_MANAGED_AGENT_RESULT_BYTES = 64 * 1024;

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

export type ClaudeSdkHookEvent = NativeHookEvent;
export type ClaudeSdkHookInput = NativeHookInput;
export type ClaudeSdkHookOutput = NativeHookJSONOutput;
export type ClaudeSdkHooks = Partial<Record<NativeHookEvent, NativeHookCallbackMatcher[]>>;

export interface ClaudeSdkAgentDefinition {
  readonly description: string;
  readonly prompt: string;
  readonly tools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly model?: string;
  readonly skills?: readonly string[];
  readonly effort?: "low" | "medium" | "high" | "xhigh" | "max" | number;
  readonly permissionMode?: ClaudeSdkPermissionMode;
}

export interface ClaudeSdkManagedAgentInput {
  readonly description: string;
  readonly prompt: string;
  readonly subagent_type?: string;
  readonly model?: string;
  readonly run_in_background?: boolean;
  readonly name?: string;
  readonly team_name?: string;
  readonly mode?: string;
  readonly isolation?: "worktree" | "remote";
  readonly cwd?: string;
}

export interface ClaudeSdkManagedAgentResult {
  readonly text: string;
  readonly isError?: boolean;
}

export type ClaudeSdkManagedAgentTool = (
  input: ClaudeSdkManagedAgentInput,
  options: { readonly toolUseId: string; readonly signal: AbortSignal }
) => Promise<ClaudeSdkManagedAgentResult>;

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
  readonly origin:
    | { readonly kind: "human" }
    | {
        readonly kind: "peer";
        readonly from: string;
        readonly fromMode?: "bypass" | "prompting";
        readonly senderTaskId?: string;
        readonly body?: string;
      }
    | { readonly kind: "task-notification" };
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
    readonly fastMode?: boolean | null;
    readonly autoCompactWindow?: number | null;
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
  readonly agent?: string;
  readonly agents?: Readonly<Record<string, ClaudeSdkAgentDefinition>>;
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
  readonly hooks?: ClaudeSdkHooks;
  /** Adapter-private Agent/Task replacement. SDK runtimes own the in-process
   * MCP transport so local and remote Queries preserve the same callback. */
  readonly managedAgentTool?: ClaudeSdkManagedAgentTool;
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
  readonly signal?: AbortSignal;
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
  readonly settings: Exclude<NativeOptions["settings"], string>;
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
  /** Exact CLI version declared by this runtime's bundled executable. Callers
   * may trust it only when they did not supply an executable override. */
  readonly bundledCliVersion?: string;
  /** True only when the injected runtime can create and subsequently resume a
   * public SDK fork in a different canonical workspace. The fixed filesystem
   * SDK runtime does not provide that migration primitive: ForkSessionOptions.dir
   * selects the source project store and does not rewrite the copied cwd. */
  readonly supportsWorkspaceDerivation?: boolean;
  probe(input: ClaudeSdkProbeInput): Promise<ClaudeSdkProbe>;
  query(params: ClaudeSdkQueryParams): Promise<ClaudeSdkQuery>;
  /** Confirm retirement of this exact Query before resuming its native Session. */
  retireQuery(query: ClaudeSdkQuery, timeoutMs: number): Promise<void>;
  getSessionInfo(sessionId: string, options: { readonly dir: string; readonly signal?: AbortSignal }): Promise<ClaudeSdkSessionInfo | undefined>;
  getSessionMessages(
    sessionId: string,
    options: ClaudeSdkGetSessionMessagesOptions
  ): Promise<readonly ClaudeSdkSessionMessage[]>;
  listSessions(options: ClaudeSdkListSessionsOptions): Promise<readonly ClaudeSdkSessionInfo[]>;
  deleteSession(sessionId: string, options: { readonly dir: string; readonly signal?: AbortSignal }): Promise<void>;
  forkSession(sessionId: string, options: ClaudeSdkForkOptions): Promise<{ readonly sessionId: string }>;
  ownsSessionFork(sessionId: string): boolean;
  closeSessionOperations(): Promise<void>;
  /** Confirm hard retirement of every exact local CLI process still owned by this runtime. */
  retireOwnedProcesses?(timeoutMs: number): Promise<void>;
}

/**
 * Exact runtime authority for one Target. Remote implementations bind every
 * SDK operation to one captured Host/SSH generation and expose the canonical
 * workspace proved by that same capture.
 */
export interface ClaudeTargetRuntime {
  readonly runtime: ClaudeSdkRuntime;
  readonly workspaceRoot: string;
  readonly remote: boolean;
  assertCurrent(): void;
}

/** Adapter-owned resolver for Target-scoped remote Claude runtimes. */
export interface ClaudeRemoteRuntimePort {
  resolve(target: TargetDescriptor, signal?: AbortSignal): Promise<ClaudeTargetRuntime>;
  close(): Promise<void>;
}

export interface ClaudeSdkForkOptions {
  readonly dir: string;
  /** Published SDK boundary, inclusive of this exact persisted message UUID. */
  readonly upToMessageId?: string;
  readonly signal: AbortSignal;
  /** Synchronous Host receipt, called before this bounded operation settles. */
  readonly recordSessionId: (sessionId: string) => void;
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
  readonly createSdkMcpServer: (options: {
    readonly name: string;
    readonly version?: string;
    readonly tools: readonly {
      readonly name: string;
      readonly description: string;
      readonly inputSchema: Readonly<Record<string, unknown>>;
      readonly handler: (args: ClaudeSdkManagedAgentInput, extra: unknown) => Promise<{
        readonly content: readonly { readonly type: "text"; readonly text: string }[];
        readonly isError?: boolean;
      }>;
    }[];
  }) => NativeMcpSdkServerConfig;
}

export class DefaultClaudeSdkRuntime implements ClaudeSdkRuntime {
  readonly packageVersion = CLAUDE_AGENT_SDK_VERSION;
  readonly bundledCliVersion = CLAUDE_AGENT_SDK_CLI_VERSION;
  readonly supportsWorkspaceDerivation = false;
  readonly #processOwner: DurableProcessOwner | undefined;
  readonly #retirementTimeoutMs: number;
  readonly #sessionOwner: SessionSdkOwner;
  readonly #queryProcesses = new WeakMap<ClaudeSdkQuery, DurableProcessLease[]>();
  #module: Promise<LoadedSdkModule> | undefined;

  constructor(options: {
    readonly processOwner?: DurableProcessOwnerOptions;
    readonly retirementTimeoutMs?: number;
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly sessionOperationTimeoutMs?: number;
  } = {}) {
    this.#processOwner = options.processOwner === undefined
      ? undefined
      : new DurableProcessOwner(options.processOwner);
    this.#retirementTimeoutMs = positiveTimeout(options.retirementTimeoutMs, 5_000);
    this.#sessionOwner = new SessionSdkOwner({
      environment: options.environment ?? process.env,
      timeoutMs: positiveTimeout(options.sessionOperationTimeoutMs, 30_000),
      cleanupTimeoutMs: this.#retirementTimeoutMs
    });
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
          settings: { ...input.settings },
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
      const cliVersion = observation.cliVersion
        ?? (input.pathToClaudeCodeExecutable === undefined ? CLAUDE_AGENT_SDK_CLI_VERSION : undefined);
      return {
        installed: true,
        packageVersion: this.packageVersion,
        initialization,
        ...(cliVersion === undefined ? {} : { cliVersion }),
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
    const leases: DurableProcessLease[] = [];
    const loaded = await this.#load();
    const managedAgentServer = params.options.managedAgentTool === undefined
      ? undefined
      : createManagedAgentServer(loaded, params.options.managedAgentTool);
    const options: NativeOptionsWithOAuth = {
      abortController: params.options.abortController,
      additionalDirectories: [...params.options.additionalDirectories],
      allowDangerouslySkipPermissions: params.options.allowDangerouslySkipPermissions,
      ...(params.options.agent === undefined ? {} : { agent: params.options.agent }),
      ...(params.options.agents === undefined ? {} : { agents: cloneAgentDefinitions(params.options.agents) }),
      canUseTool: params.options.canUseTool,
      cwd: params.options.cwd,
      env: { ...params.options.env },
      ...(params.options.extraArgs === undefined ? {} : { extraArgs: { ...params.options.extraArgs } }),
      ...(params.options.getOAuthToken === undefined ? {} : { getOAuthToken: params.options.getOAuthToken }),
      ...(params.options.effort === undefined ? {} : { effort: params.options.effort }),
      ...(params.options.forwardSubagentText === undefined
        ? {}
        : { forwardSubagentText: params.options.forwardSubagentText }),
      ...(params.options.hooks === undefined ? {} : { hooks: params.options.hooks }),
      includePartialMessages: params.options.includePartialMessages,
      ...(params.options.disallowedTools === undefined
        ? {}
        : { disallowedTools: [...params.options.disallowedTools] }),
      ...(managedAgentServer === undefined && params.options.mcpServers === undefined
        ? {}
        : {
            mcpServers: {
              ...(params.options.mcpServers ?? {}),
              ...(managedAgentServer === undefined
                ? {}
                : { [CLAUDE_MANAGED_AGENT_SERVER]: managedAgentServer })
            }
          }),
      ...(params.options.model === undefined ? {} : { model: params.options.model }),
      ...(params.options.pathToClaudeCodeExecutable === undefined
        ? {}
        : { pathToClaudeCodeExecutable: params.options.pathToClaudeCodeExecutable }),
      permissionMode: params.options.permissionMode,
      persistSession: params.options.persistSession,
      ...(this.#processOwner === undefined
        ? {}
        : { spawnClaudeCodeProcess: (spawnOptions) => this.#spawnOwnedProcess(spawnOptions, (lease) => leases.push(lease)) }),
      ...(params.options.resume === undefined ? {} : { resume: params.options.resume }),
      ...(params.options.sessionId === undefined ? {} : { sessionId: params.options.sessionId }),
      ...(params.options.settings === undefined ? {} : { settings: { ...params.options.settings } }),
      settingSources: [...params.options.settingSources],
      ...(params.options.skills === undefined ? {} : { skills: [...params.options.skills] }),
      ...(params.options.strictMcpConfig === undefined ? {} : { strictMcpConfig: params.options.strictMcpConfig }),
      systemPrompt: params.options.systemPrompt,
      ...(params.options.title === undefined ? {} : { title: params.options.title }),
      ...(managedAgentServer === undefined
        ? {}
        : {
            toolAliases: {
              Agent: CLAUDE_MANAGED_AGENT_TOOL_NAME,
              Task: CLAUDE_MANAGED_AGENT_TOOL_NAME
            }
          }),
      tools: Array.isArray(params.options.tools)
        ? [...params.options.tools]
        : { type: "preset", preset: "claude_code" }
    };
    const query = loaded.query({
      prompt: params.prompt as AsyncIterable<NativeSdkUserMessage>,
      options
    }) as unknown as ClaudeSdkQuery;
    this.#queryProcesses.set(query, leases);
    return query;
  }

  async retireQuery(query: ClaudeSdkQuery, timeoutMs: number): Promise<void> {
    const leases = this.#queryProcesses.get(query);
    if (this.#processOwner === undefined || leases === undefined || leases.length === 0) {
      throw new Error("The exact native Query process cannot be confirmed retired.");
    }
    const results = await Promise.allSettled(leases.map((lease) => this.#processOwner!.retireLease(lease, timeoutMs)));
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    this.#queryProcesses.delete(query);
  }

  async getSessionInfo(
    sessionId: string,
    options: { readonly dir: string; readonly signal?: AbortSignal }
  ): Promise<ClaudeSdkSessionInfo | undefined> {
    return await this.#sessionOwner.run({ kind: "getSessionInfo", sessionId, options: { dir: options.dir } }, { signal: options.signal }) as ClaudeSdkSessionInfo | undefined;
  }

  async getSessionMessages(
    sessionId: string,
    options: ClaudeSdkGetSessionMessagesOptions
  ): Promise<readonly ClaudeSdkSessionMessage[]> {
    const { signal, ...nativeOptions } = options;
    return await this.#sessionOwner.run({ kind: "getSessionMessages", sessionId, options: nativeOptions }, { signal }) as readonly ClaudeSdkSessionMessage[];
  }

  async listSessions(options: ClaudeSdkListSessionsOptions): Promise<readonly ClaudeSdkSessionInfo[]> {
    return await this.#sessionOwner.run({ kind: "listSessions", options }) as readonly ClaudeSdkSessionInfo[];
  }

  async deleteSession(sessionId: string, options: { readonly dir: string; readonly signal?: AbortSignal }): Promise<void> {
    if (this.#sessionOwner.ownsSession(sessionId)) throw new Error("Native Session copy is not confirmed retired.");
    await this.#sessionOwner.run({ kind: "deleteSession", sessionId, options: { dir: options.dir } }, { signal: options.signal });
  }

  async forkSession(sessionId: string, options: ClaudeSdkForkOptions): Promise<{ readonly sessionId: string }> {
    return await this.#sessionOwner.run({ kind: "forkSession", sessionId, options: {
      dir: options.dir,
      ...(options.upToMessageId === undefined ? {} : { upToMessageId: options.upToMessageId })
    } }, {
      signal: options.signal, recordSessionId: options.recordSessionId
    }) as { readonly sessionId: string };
  }

  ownsSessionFork(sessionId: string): boolean {
    return this.#sessionOwner.ownsSession(sessionId);
  }

  closeSessionOperations(): Promise<void> {
    return this.#sessionOwner.close();
  }

  async retireOwnedProcesses(timeoutMs: number): Promise<void> {
    const results = await Promise.allSettled([this.#sessionOwner.retire(), this.#processOwner?.retireAll(timeoutMs)]);
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }

  #load(): Promise<LoadedSdkModule> {
    this.#module ??= loadSdkModule();
    return this.#module;
  }

  #spawnOwnedProcess(options: NativeSpawnOptions, recordLease?: (lease: DurableProcessLease) => void): NativeSpawnedProcess {
    const owner = this.#processOwner;
    if (owner === undefined) throw new Error("Claude CLI process ownership is not configured.");
    return spawnOwnedClaudeCodeProcess(options, owner, this.#retirementTimeoutMs, recordLease);
  }
}

async function loadSdkModule(): Promise<LoadedSdkModule> {
  const moduleName: string = CLAUDE_AGENT_SDK_PACKAGE;
  const value: unknown = await import(moduleName);
  if (!isRecord(value)
    || typeof value["query"] !== "function"
    || typeof value["startup"] !== "function"
    || typeof value["createSdkMcpServer"] !== "function") {
    throw new Error("The installed Claude Agent SDK has an incompatible module surface.");
  }
  return value as unknown as LoadedSdkModule;
}

function createManagedAgentServer(
  loaded: LoadedSdkModule,
  callback: ClaudeSdkManagedAgentTool
): NativeMcpSdkServerConfig {
  return loaded.createSdkMcpServer({
    name: CLAUDE_MANAGED_AGENT_SERVER,
    version: "1.0.0",
    tools: [{
      name: CLAUDE_MANAGED_AGENT_TOOL,
      description: "Run an exactly configured Joko-managed Claude subagent.",
      inputSchema: {
        description: z.string().trim().min(1).max(512),
        prompt: z.string().min(1).max(1024 * 1024),
        subagent_type: z.string().trim().min(1).max(256).optional(),
        model: z.string().trim().min(1).max(512).optional(),
        run_in_background: z.boolean().optional(),
        name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u).optional(),
        team_name: z.string().max(256).optional(),
        mode: z.string().max(64).optional(),
        isolation: z.enum(["worktree", "remote"]).optional(),
        cwd: z.string().max(16_384).optional()
      },
      handler: async (input, extra) => {
        const details = isRecord(extra) ? extra : undefined;
        const metadata = isRecord(details?.["_meta"]) ? details["_meta"] : undefined;
        const toolUseId = metadata?.["claudecode/toolUseId"];
        const signal = details?.["signal"];
        if (typeof toolUseId !== "string" || toolUseId.length === 0 || toolUseId.length > 512
          || /[\x00-\x1f\x7f]/u.test(toolUseId) || !(signal instanceof AbortSignal)) {
          throw new Error("The managed Agent invocation lacks its SDK ownership metadata.");
        }
        const result = await callback(Object.freeze({ ...input }), { toolUseId, signal });
        if (!isRecord(result) || typeof result["text"] !== "string"
          || Buffer.byteLength(result["text"], "utf8") > MAXIMUM_MANAGED_AGENT_RESULT_BYTES
          || (result["isError"] !== undefined && typeof result["isError"] !== "boolean")) {
          throw new Error("The managed Agent callback returned an invalid result.");
        }
        return {
          content: [{ type: "text", text: result["text"] }],
          ...(result["isError"] === true ? { isError: true } : {})
        };
      }
    }]
  });
}

function cloneAgentDefinitions(
  definitions: Readonly<Record<string, ClaudeSdkAgentDefinition>>
): Record<string, NativeAgentDefinition> {
  return Object.fromEntries(Object.entries(definitions).map(([name, definition]) => [name, {
    ...definition,
    ...(definition.tools === undefined ? {} : { tools: [...definition.tools] }),
    ...(definition.disallowedTools === undefined ? {} : { disallowedTools: [...definition.disallowedTools] }),
    ...(definition.skills === undefined ? {} : { skills: [...definition.skills] })
  }])) as Record<string, NativeAgentDefinition>;
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
  retirementTimeoutMs: number,
  recordLease?: (lease: DurableProcessLease) => void
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
  recordLease?.(lease);
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
  AgentDefinition as NativeAgentDefinition,
  HookCallbackMatcher as NativeHookCallbackMatcher,
  HookEvent as NativeHookEvent,
  HookInput as NativeHookInput,
  HookJSONOutput as NativeHookJSONOutput,
  McpSdkServerConfigWithInstance as NativeMcpSdkServerConfig,
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
