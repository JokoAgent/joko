import { randomUUID } from "node:crypto";
import { constants as fileConstants, mkdirSync, promises as fileSystem } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  COMPUTER_PUBLIC_TOOLS,
  ComputerToolArgumentError,
  isComputerPublicToolName,
  normalizeComputerToolArguments,
  type ComputerPublicToolName
} from "./catalog.js";
import { safeComputerEnvironment } from "./process-runner.js";
import { ComputerRuntime } from "./runtime.js";
import { ComputerWindowSnapshotTracker } from "./snapshot-tracker.js";

export interface ComputerSessionFence {
  readonly sessionId: string;
  readonly generation: number;
  readonly token: string;
}

export interface ComputerToolDescriptor {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  readonly annotations?: Readonly<Record<string, unknown>>;
}

export interface ComputerToolCallResult {
  readonly content?: readonly unknown[];
  readonly structuredContent?: Readonly<Record<string, unknown>>;
  readonly isError?: boolean;
  readonly toolResult?: unknown;
  readonly [key: string]: unknown;
}

export interface ComputerToolCallContext {
  readonly workspaceRoot?: string;
}

export interface ComputerMcpToolPage {
  readonly tools: readonly ComputerToolDescriptor[];
  readonly nextCursor?: string;
}

export interface ComputerMcpConnection {
  connect(signal?: AbortSignal): Promise<void>;
  listTools(cursor: string | undefined, signal?: AbortSignal): Promise<ComputerMcpToolPage>;
  callTool(
    name: string,
    arguments_: Readonly<Record<string, unknown>>,
    signal?: AbortSignal
  ): Promise<ComputerToolCallResult>;
  close(): Promise<void>;
}

export interface ComputerMcpConnectionFactoryInput {
  readonly sessionId: string;
  readonly command: string;
  readonly arguments: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly startupTimeoutMs: number;
  readonly requestTimeoutMs: number;
}

export type ComputerMcpConnectionFactory = (
  input: ComputerMcpConnectionFactoryInput
) => ComputerMcpConnection;

export interface ComputerToolProviderOptions {
  readonly runtime?: ComputerRuntime;
  readonly executablePath?: string;
  readonly platform?: NodeJS.Platform;
  readonly environment?: NodeJS.ProcessEnv;
  readonly connectionFactory?: ComputerMcpConnectionFactory;
  readonly startupTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly maximumArgumentBytes?: number;
  readonly idFactory?: () => string;
  readonly catalogMode?: "public" | "dynamic";
  readonly decorateCursor?: boolean;
}

export class ComputerToolProviderError extends Error {
  constructor(
    readonly code:
      | "invalid_session"
      | "stale_session"
      | "connect_failed"
      | "transport_failed"
      | "unknown_tool"
      | "invalid_arguments"
      | "catalog_too_large"
      | "stale_snapshot",
    readonly toolName?: string,
    readonly underlying?: unknown
  ) {
    super(providerErrorMessage(code, toolName));
    this.name = "ComputerToolProviderError";
  }
}

interface SessionEntry {
  readonly fence: ComputerSessionFence;
  connection: ComputerMcpConnection;
  readonly abort: AbortController;
  tail: Promise<void>;
  closed: boolean;
  transportEpoch: number;
  snapshots: ComputerWindowSnapshotTracker;
  cursorMotion: "pending" | "applied" | "unavailable";
  cursorStyle: "pending" | "applied" | "unavailable";
  runtimeHeld: boolean;
}

type ComputerRecoveryDecision<T> =
  | { readonly handled: true; readonly value: T }
  | { readonly handled: false };

interface ComputerReconnectOptions<T> {
  readonly retryTimeout?: boolean;
  readonly beforeReconnect?: (error: unknown) => Promise<ComputerRecoveryDecision<T>>;
}

const MAXIMUM_TOOL_PAGES = 16;
const MAXIMUM_TOOLS = 2_048;
const PUBLIC_POSIX_INSTALL_URL = "https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.sh";
const PUBLIC_WINDOWS_INSTALL_URL = "https://raw.githubusercontent.com/trycua/cua/main/libs/cua-driver/scripts/install.ps1";
const LIGHTWEIGHT_REQUEST_TIMEOUT_MS = 10_000;
const LIGHTWEIGHT_TIMEOUT_RETRY_TOOLS = new Set<ComputerPublicToolName>([
  "get_screen_size",
  "get_cursor_position",
  "get_agent_cursor_state",
  "move_cursor"
]);

export class ComputerToolProvider {
  readonly #runtime: ComputerRuntime;
  readonly #executablePath: string | undefined;
  readonly #environment: Record<string, string>;
  readonly #connectionFactory: ComputerMcpConnectionFactory;
  readonly #startupTimeoutMs: number;
  readonly #requestTimeoutMs: number;
  readonly #maximumArgumentBytes: number;
  readonly #idFactory: () => string;
  readonly #catalogMode: "public" | "dynamic";
  readonly #decorateCursor: boolean;
  readonly #sessions = new Map<string, SessionEntry>();
  readonly #openings = new Map<string, Promise<SessionEntry>>();
  readonly #closings = new Map<string, Promise<void>>();
  readonly #generations = new Map<string, number>();
  #closingAll: Promise<void> | undefined;

  constructor(options: ComputerToolProviderOptions = {}) {
    this.#runtime = options.runtime ?? new ComputerRuntime({
      platform: options.platform,
      executablePath: options.executablePath,
      environment: options.environment
    });
    this.#executablePath = options.executablePath;
    this.#environment = safeComputerEnvironment(options.environment ?? process.env, options.platform ?? process.platform);
    this.#startupTimeoutMs = providerTimeout(options.startupTimeoutMs ?? 10_000, "MCP startup timeout");
    this.#requestTimeoutMs = providerTimeout(options.requestTimeoutMs ?? 45_000, "MCP request timeout");
    this.#maximumArgumentBytes = argumentLimit(options.maximumArgumentBytes ?? 1024 * 1024);
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#catalogMode = options.catalogMode ?? "public";
    this.#decorateCursor = options.decorateCursor ?? true;
    this.#connectionFactory = options.connectionFactory ?? ((input) => new SdkComputerMcpConnection(input));
  }

  get activeSessionCount(): number {
    return this.#sessions.size;
  }

  async openSession(sessionId: string, signal?: AbortSignal): Promise<ComputerSessionFence> {
    validateSessionId(sessionId);
    if (signal?.aborted === true) throw abortError();
    const closingAll = this.#closingAll;
    if (closingAll !== undefined) {
      await withSignal(closingAll, signal);
      return this.openSession(sessionId, signal);
    }
    const existing = this.#sessions.get(sessionId);
    if (existing !== undefined && !existing.closed) return existing.fence;
    const opening = this.#openings.get(sessionId);
    if (opening !== undefined) return (await withSignal(opening, signal)).fence;
    const closing = this.#closings.get(sessionId);
    if (closing !== undefined) {
      await withSignal(closing, signal);
      return this.openSession(sessionId, signal);
    }

    const generation = (this.#generations.get(sessionId) ?? 0) + 1;
    const fence: ComputerSessionFence = Object.freeze({
      sessionId,
      generation,
      token: boundedToken(this.#idFactory())
    });
    const create = this.#createSession(fence, signal);
    this.#openings.set(sessionId, create);
    try {
      const entry = await create;
      this.#generations.set(sessionId, generation);
      this.#sessions.set(sessionId, entry);
      return entry.fence;
    } finally {
      if (this.#openings.get(sessionId) === create) this.#openings.delete(sessionId);
    }
  }

  listTools(fence: ComputerSessionFence, signal?: AbortSignal): Promise<readonly ComputerToolDescriptor[]> {
    const entry = this.#requireSession(fence);
    if (this.#catalogMode === "public") {
      if (signal?.aborted === true) return Promise.reject(abortError());
      return Promise.resolve(COMPUTER_PUBLIC_TOOLS.map(copyToolDescriptor));
    }
    return enqueue(entry, async () => this.#withReconnect(entry, signal, async (connection, operationSignal) =>
      this.#readToolCatalog(connection, operationSignal)));
  }

  callTool(
    fence: ComputerSessionFence,
    name: string,
    arguments_: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
    context: ComputerToolCallContext = {}
  ): Promise<ComputerToolCallResult> {
    validateToolName(name);
    const safeArguments = cloneToolArguments(arguments_, this.#maximumArgumentBytes);
    const entry = this.#requireSession(fence);
    if (this.#catalogMode === "public") {
      if (!isComputerPublicToolName(name)) throw new ComputerToolProviderError("unknown_tool", name);
      let normalized: Record<string, unknown>;
      try {
        normalized = normalizeComputerToolArguments(name, safeArguments);
      } catch (error) {
        if (error instanceof ComputerToolArgumentError) {
          throw new ComputerToolProviderError("invalid_arguments", name);
        }
        throw error;
      }
      return enqueue(entry, async () => this.#callPublicTool(
        entry,
        name,
        normalized,
        signal,
        context.workspaceRoot
      ));
    }
    return enqueue(entry, async () => this.#withReconnect(entry, signal, async (connection, operationSignal) => {
      const catalog = await this.#readToolCatalog(connection, operationSignal);
      if (!catalog.some((tool) => tool.name === name)) {
        throw new ComputerToolProviderError("unknown_tool", name);
      }
      const result = await connection.callTool(name, safeArguments, operationSignal);
      const stale = staleToolResult(result);
      if (stale !== undefined) throw new StaleTransportError(stale);
      return result;
    }));
  }

  async closeSession(fence: ComputerSessionFence): Promise<void> {
    const entry = this.#requireSession(fence);
    this.#sessions.delete(fence.sessionId);
    entry.closed = true;
    entry.abort.abort();
    const closing = entry.tail.catch(() => undefined).then(async () => {
      await endDriverSessionQuietly(entry);
      await closeQuietly(entry.connection);
      releaseRuntimeSession(entry, this.#runtime);
    });
    this.#closings.set(fence.sessionId, closing);
    try {
      await closing;
    } finally {
      if (this.#closings.get(fence.sessionId) === closing) this.#closings.delete(fence.sessionId);
    }
  }

  async closeAll(): Promise<void> {
    const existing = this.#closingAll;
    if (existing !== undefined) return existing;
    const closing = this.#closeAllNow();
    this.#closingAll = closing;
    try {
      await closing;
    } finally {
      if (this.#closingAll === closing) this.#closingAll = undefined;
    }
  }

  async #closeAllNow(): Promise<void> {
    await Promise.all([...this.#openings.values()].map((opening) => opening.catch(() => undefined)));
    const entries = [...this.#sessions.values()];
    this.#sessions.clear();
    for (const entry of entries) {
      entry.closed = true;
      entry.abort.abort();
    }
    await Promise.all(entries.map(async (entry) => {
      await entry.tail.catch(() => undefined);
      await endDriverSessionQuietly(entry);
      await closeQuietly(entry.connection);
      releaseRuntimeSession(entry, this.#runtime);
    }));
    await Promise.all([...this.#closings.values()].map((closing) => closing.catch(() => undefined)));
  }

  async #createSession(fence: ComputerSessionFence, signal: AbortSignal | undefined): Promise<SessionEntry> {
    const connection = this.#newConnection(fence.sessionId);
    try {
      await connection.connect(signal);
    } catch (error) {
      await closeQuietly(connection);
      if (isAbortError(error)) throw error;
      throw new ComputerToolProviderError("connect_failed");
    }
    this.#runtime.retainDriverSession();
    return {
      fence,
      connection,
      abort: new AbortController(),
      tail: Promise.resolve(),
      closed: false,
      transportEpoch: 1,
      snapshots: new ComputerWindowSnapshotTracker(this.#idFactory),
      cursorMotion: "pending",
      cursorStyle: "pending",
      runtimeHeld: true
    };
  }

  #newConnection(sessionId: string): ComputerMcpConnection {
    return this.#connectionFactory({
      sessionId,
      command: this.#executablePath ?? this.#runtime.executablePath(),
      arguments: ["mcp"],
      environment: this.#environment,
      startupTimeoutMs: this.#startupTimeoutMs,
      requestTimeoutMs: this.#requestTimeoutMs
    });
  }

  #requireSession(fence: ComputerSessionFence): SessionEntry {
    validateFence(fence);
    const entry = this.#sessions.get(fence.sessionId);
    if (
      entry === undefined
      || entry.closed
      || entry.fence.generation !== fence.generation
      || entry.fence.token !== fence.token
    ) throw new ComputerToolProviderError("stale_session");
    return entry;
  }

  #assertCurrent(entry: SessionEntry): void {
    if (entry.closed || this.#sessions.get(entry.fence.sessionId) !== entry) {
      throw new ComputerToolProviderError("stale_session");
    }
  }

  async #withReconnect<T>(
    entry: SessionEntry,
    signal: AbortSignal | undefined,
    operation: (connection: ComputerMcpConnection, signal: AbortSignal) => Promise<T>,
    options: ComputerReconnectOptions<T> = {}
  ): Promise<T> {
    this.#assertCurrent(entry);
    const operationSignal = anySignal(entry.abort.signal, signal);
    try {
      return await operation(entry.connection, operationSignal);
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (error instanceof ComputerToolProviderError) throw error;
      const stale = isStaleComputerTransportError(error);
      const timedOut = isComputerTimeoutError(error);
      if (stale || timedOut) {
        const decision = await options.beforeReconnect?.(error);
        if (decision?.handled === true) {
          this.#retireSessionEntry(entry);
          return decision.value;
        }
      }
      if (!stale && !timedOut) {
        throw new ComputerToolProviderError("transport_failed", undefined, error);
      }
      if (timedOut && options.retryTimeout !== true) {
        this.#retireSessionEntry(entry);
        throw new ComputerToolProviderError("transport_failed", undefined, error);
      }
    }

    this.#assertCurrent(entry);
    await endDriverSessionQuietly(entry);
    await closeQuietly(entry.connection);
    let replacement: ComputerMcpConnection | undefined;
    try {
      replacement = this.#newConnection(entry.fence.sessionId);
      await replacement.connect(operationSignal);
    } catch (error) {
      if (replacement !== undefined) await closeQuietly(replacement);
      if (isAbortError(error)) throw error;
      throw new ComputerToolProviderError("connect_failed", undefined, error);
    }
    this.#assertCurrent(entry);
    entry.connection = replacement;
    entry.transportEpoch += 1;
    entry.snapshots = new ComputerWindowSnapshotTracker(this.#idFactory);
    entry.cursorMotion = "pending";
    entry.cursorStyle = "pending";
    try {
      return await operation(replacement, operationSignal);
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (error instanceof ComputerToolProviderError) throw error;
      throw new ComputerToolProviderError("transport_failed", undefined, error);
    }
  }

  #retireSessionEntry(entry: SessionEntry): void {
    if (this.#sessions.get(entry.fence.sessionId) === entry) {
      this.#sessions.delete(entry.fence.sessionId);
    }
    entry.closed = true;
    entry.abort.abort();
    releaseRuntimeSession(entry, this.#runtime);
    void endDriverSessionQuietly(entry).finally(() => closeQuietly(entry.connection));
  }

  async #callPublicTool(
    entry: SessionEntry,
    name: ComputerPublicToolName,
    arguments_: Record<string, unknown>,
    signal: AbortSignal | undefined,
    workspaceRoot?: string
  ): Promise<ComputerToolCallResult> {
    if (name === "status" || name === "check_permissions") {
      const status = await this.#runtime.status({ signal });
      const payload = name === "status"
        ? publicRuntimeStatus(status)
        : {
            ok: true,
            permissionState: publicPermissionState(status),
            permissions: status.permissions,
            daemonRunning: status.daemon.state === "running"
          };
      return jsonToolResult(payload);
    }
    if (name === "replay_trajectory") {
      return this.#replayTrajectory(entry, arguments_, signal, workspaceRoot);
    }

    const stale = staleSnapshotResult(entry, name, arguments_);
    if (stale !== undefined) return stale;

    const chunks = name === "type_text" && typeof arguments_["text"] === "string"
      ? splitTextChunks(arguments_["text"])
      : undefined;
    let nextChunk = 0;
    let inserted = 0;

    let result: ComputerToolCallResult;
    try {
      result = await this.#withReconnect<ComputerToolCallResult>(entry, signal, async (connection, operationSignal) => {
        if (this.#decorateCursor) await initializeCursorDecoration(entry, connection, name, operationSignal);
        if (chunks === undefined || chunks.length === 1) {
          const prepared = withDriverSession(entry, name, driverDispatchArguments(name, arguments_));
          const response = await callDriverTool(connection, name, prepared, operationSignal);
          const stale = staleToolResult(response);
          if (stale !== undefined) throw new StaleTransportError(stale);
          if (chunks !== undefined && response.isError !== true) {
            const characterCount = readInsertedCharacters(response) ?? Array.from(chunks[0] ?? "").length;
            return aggregateTypeTextResult(characterCount, 1);
          }
          return response;
        }
        while (nextChunk < chunks.length) {
          const chunk = chunks[nextChunk]!;
          const prepared = withDriverSession(entry, name, {
            ...driverDispatchArguments(name, arguments_),
            text: chunk
          });
          const response = await callDriverTool(connection, name, prepared, operationSignal);
          const stale = staleToolResult(response);
          if (stale !== undefined) throw new StaleTransportError(stale);
          if (response.isError === true) return response;
          inserted += readInsertedCharacters(response) ?? Array.from(chunk).length;
          nextChunk += 1;
        }
        return aggregateTypeTextResult(inserted, chunks.length);
      }, {
        retryTimeout: LIGHTWEIGHT_TIMEOUT_RETRY_TOOLS.has(name),
        beforeReconnect: async (error) => {
          const fallback = await this.#fallbackAfterFailure(name, arguments_, error, signal);
          return fallback === undefined
            ? { handled: false }
            : { handled: true, value: fallback };
        }
      });
    } catch (error) {
      const fallback = await this.#fallbackAfterFailure(name, arguments_, error, signal);
      if (fallback !== undefined) return fallback;
      throw error;
    }

    if (name === "list_windows") {
      const payload = driverResultPayload(result);
      if (payload === undefined) return result;
      if (payload["source"] === "win32_fallback") return result;
      const enriched = await this.#runtime.enrichWindows(payload, arguments_, { signal });
      return filterListWindowsResult(replaceJsonResultPayload(result, enriched), arguments_);
    }
    if (name !== "get_window_state") return result;
    const processId = arguments_["pid"];
    const windowId = arguments_["window_id"];
    if (typeof processId !== "number" || typeof windowId !== "number" || driverResultFailed(result)) return result;
    const snapshotId = entry.snapshots.record(processId, windowId);
    const driverSnapshotId = readDriverSnapshotId(result);
    if (driverSnapshotId !== undefined) entry.snapshots.registerAlias(snapshotId, driverSnapshotId);
    return stampSnapshotId(result, snapshotId);
  }

  async #fallbackAfterFailure(
    name: ComputerPublicToolName,
    arguments_: Readonly<Record<string, unknown>>,
    error: unknown,
    signal: AbortSignal | undefined
  ): Promise<ComputerToolCallResult | undefined> {
    try {
      if (
        (name === "get_screen_size" || name === "get_cursor_position")
        && shouldUseCliFallbackAfterError(error)
      ) {
        const fallback = await this.#runtime.callCliFallback(name, { signal });
        return fallback === undefined ? undefined : jsonToolResult(fallback);
      }
      if (
        (name === "list_windows" || name === "list_apps")
        && this.#runtime.platformSummary().platform === "win32"
        && shouldUseWindowsFallbackAfterError(error)
      ) {
        const fallback = await this.#runtime.callWindowsFallback(
          name,
          name === "list_windows" ? windowsFallbackEnumerationArguments(arguments_) : arguments_,
          { signal }
        );
        if (fallback === undefined) return undefined;
        const payload = name === "list_windows"
          ? await this.#runtime.enrichWindows(fallback, arguments_, { signal })
          : fallback;
        return jsonToolResult(payload);
      }
    } catch (fallbackError) {
      if (isAbortError(fallbackError)) throw fallbackError;
    }
    return undefined;
  }

  async #replayTrajectory(
    entry: SessionEntry,
    arguments_: Readonly<Record<string, unknown>>,
    signal: AbortSignal | undefined,
    workspaceRoot: string | undefined
  ): Promise<ComputerToolCallResult> {
    const prepared = await prepareTrajectory(arguments_, signal, workspaceRoot);
    if ("error" in prepared) return prepared.error;
    const startedAt = Date.now();
    const turns: Array<Readonly<Record<string, unknown>>> = [];
    let succeeded = 0;
    let failed = 0;
    let summaryCharacters = 0;
    let firstFailure: Readonly<Record<string, unknown>> | undefined;

    for (let index = 0; index < prepared.actions.length; index += 1) {
      signal?.throwIfAborted();
      if (Date.now() - startedAt >= 10 * 60_000) {
        return errorToolResult("REPLAY_BUDGET_EXCEEDED", {
          message: "Trajectory replay exceeded its bounded wall-clock budget."
        });
      }
      const action = prepared.actions[index]!;
      let result: ComputerToolCallResult;
      try {
        result = await this.#callPublicTool(entry, action.tool, action.arguments, signal);
      } catch (error) {
        if (isAbortError(error)) throw error;
        result = errorToolResult("COMPUTER_DRIVER_ERROR", { message: "Recorded action failed." });
      }
      const summaryBudget = Math.max(0, Math.min(2_048, 64 * 1024 - summaryCharacters));
      const summary = summarizeToolResult(result, summaryBudget);
      summaryCharacters += summary.length;
      const ok = result.isError !== true;
      turns.push({ turn: action.turn, tool: action.tool, ok, result_summary: summary });
      if (ok) {
        succeeded += 1;
      } else {
        failed += 1;
        firstFailure ??= { turn: action.turn, tool: action.tool, error: summary };
        if (prepared.stopOnError) break;
      }
      if (index < prepared.actions.length - 1 && prepared.delayMs > 0) {
        await replayDelay(prepared.delayMs, signal);
      }
    }

    return jsonToolResult({
      ok: true,
      tool: "replay_trajectory",
      data: {
        directory: prepared.directory,
        attempted: turns.length,
        succeeded,
        failed,
        stop_on_error: prepared.stopOnError,
        turns,
        ...(firstFailure === undefined ? {} : { first_failure: firstFailure })
      }
    });
  }

  async #readToolCatalog(
    connection: ComputerMcpConnection,
    signal: AbortSignal
  ): Promise<readonly ComputerToolDescriptor[]> {
    const tools: ComputerToolDescriptor[] = [];
    let cursor: string | undefined;
    for (let pageIndex = 0; pageIndex < MAXIMUM_TOOL_PAGES; pageIndex += 1) {
      const page = await connection.listTools(cursor, signal);
      for (const tool of page.tools) {
        validateToolName(tool.name);
        tools.push(copyToolDescriptor(tool));
        if (tools.length > MAXIMUM_TOOLS) throw new ComputerToolProviderError("catalog_too_large");
      }
      cursor = boundedCursor(page.nextCursor);
      if (cursor === undefined) return tools;
    }
    throw new ComputerToolProviderError("catalog_too_large");
  }
}

function windowsFallbackEnumerationArguments(
  arguments_: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
  return {
    ...(arguments_["on_screen_only"] === true ? { on_screen_only: true } : {}),
    ...(typeof arguments_["pid"] === "number" ? { pid: arguments_["pid"] } : {})
  };
}

function publicRuntimeStatus(status: Awaited<ReturnType<ComputerRuntime["status"]>>): Readonly<Record<string, unknown>> {
  return {
    installed: status.installed,
    executablePath: status.executablePath ?? null,
    version: status.version ?? null,
    daemonRunning: status.daemon.state === "running",
    daemonStatus: status.daemon.state,
    permissions: status.permissions,
    permissionState: publicPermissionState(status),
    installCommand: status.platform.installation === "powershell"
      ? `irm ${PUBLIC_WINDOWS_INSTALL_URL} | iex`
      : `/bin/bash -c "$(curl -fsSL ${PUBLIC_POSIX_INSTALL_URL})"`,
    docsUrl: "https://cua.ai/docs/cua-driver",
    ...(status.issue === undefined ? {} : { error: status.issue })
  };
}

function publicPermissionState(
  status: Awaited<ReturnType<ComputerRuntime["status"]>>
): Readonly<Record<string, unknown>> {
  const platform = status.platform.platform === "darwin"
    ? "macos"
    : status.platform.platform;
  return {
    platform,
    required: status.permissions.required,
    status: status.permissions.status,
    accessibility: status.permissions.accessibility,
    screenRecording: status.permissions.screenRecording,
    screenRecordingCapturable: status.permissions.liveScreenCapture,
    source: status.permissions.passiveProbe,
    canGrant: status.permissions.canGrant
  };
}

const CURSOR_DECORATED_TOOLS = new Set<ComputerPublicToolName>([
  "get_window_state",
  "click",
  "double_click",
  "right_click",
  "drag",
  "type_text",
  "set_value",
  "press_key",
  "hotkey",
  "scroll",
  "move_cursor",
  "start_recording"
]);

async function initializeCursorDecoration(
  entry: SessionEntry,
  connection: ComputerMcpConnection,
  name: ComputerPublicToolName,
  signal: AbortSignal
): Promise<void> {
  if (!CURSOR_DECORATED_TOOLS.has(name)) return;
  const cursorId = driverSessionId(entry);
  const calls: readonly {
    readonly state: "cursorMotion" | "cursorStyle";
    readonly tool: string;
    readonly arguments: Readonly<Record<string, unknown>>;
  }[] = [
    {
      state: "cursorMotion",
      tool: "set_agent_cursor_motion",
      arguments: {
        cursor_id: cursorId,
        cursor_icon: "arrow",
        cursor_color: "#ff9800",
        cursor_label: "Joko",
        cursor_size: 30,
        cursor_opacity: 0.96
      }
    },
    {
      state: "cursorStyle",
      tool: "set_agent_cursor_style",
      arguments: {
        cursor_id: cursorId,
        gradient_colors: ["#ff9800", "#d97706"],
        bloom_color: "#ff9800"
      }
    }
  ];
  for (const call of calls) {
    if (entry[call.state] !== "pending") continue;
    try {
      const result = await connection.callTool(call.tool, call.arguments, signal);
      const stale = staleToolResult(result);
      if (stale !== undefined) throw new StaleTransportError(stale);
      entry[call.state] = result.isError === true ? "unavailable" : "applied";
    } catch (error) {
      if (isAbortError(error) || isStaleComputerTransportError(error)) throw error;
      entry[call.state] = "unavailable";
    }
  }
}

export function isStaleComputerTransportError(value: unknown): boolean {
  if (value instanceof StaleTransportError) return true;
  if (!(value instanceof Error)) return false;
  return /(?:not connected|connection (?:is )?closed|transport (?:is )?closed|session (?:has )?ended|broken pipe|econnreset|write after end)/iu.test(value.message);
}

function isComputerTimeoutError(value: unknown): boolean {
  return /(?:timed out|timeout)/iu.test(computerFailureText(value));
}

function shouldUseCliFallbackAfterError(value: unknown): boolean {
  return /(?:timed out|not connected)/iu.test(computerFailureText(value));
}

function shouldUseWindowsFallbackAfterError(value: unknown): boolean {
  const message = computerFailureText(value);
  if (!/(?:timed out|timeout)/iu.test(message)) return false;
  return !/(?:not connected|session(?:\s+[^\r\n]+)?\s+(?:has\s+)?ended|transport (?:closed|error)|econnreset|epipe|connection closed|stream closed|permission denied|access denied|unauthorized|forbidden)/iu.test(message);
}

function computerFailureText(value: unknown, seen = new Set<unknown>()): string {
  if (seen.has(value)) return "";
  seen.add(value);
  if (value instanceof ComputerToolProviderError) {
    return `${value.message}\n${computerFailureText(value.underlying, seen)}`;
  }
  return value instanceof Error ? value.message : typeof value === "string" ? value : "";
}

function callDriverTool(
  connection: ComputerMcpConnection,
  name: ComputerPublicToolName,
  arguments_: Readonly<Record<string, unknown>>,
  signal: AbortSignal
): Promise<ComputerToolCallResult> {
  const call = connection.callTool(name, arguments_, signal);
  return LIGHTWEIGHT_TIMEOUT_RETRY_TOOLS.has(name)
    ? controlledPromise(call, LIGHTWEIGHT_REQUEST_TIMEOUT_MS, signal)
    : call;
}

class SdkComputerMcpConnection implements ComputerMcpConnection {
  readonly #input: ComputerMcpConnectionFactoryInput;
  readonly #transport: StdioClientTransport;
  readonly #client: Client;
  #closed = false;

  constructor(input: ComputerMcpConnectionFactoryInput) {
    this.#input = input;
    this.#transport = new StdioClientTransport({
      command: input.command,
      args: [...input.arguments],
      env: { ...input.environment },
      stderr: "pipe"
    });
    this.#transport.stderr?.on("data", () => undefined);
    this.#client = new Client({ name: "joko-computer-tools", version: "0.1.0" });
  }

  async connect(signal?: AbortSignal): Promise<void> {
    await controlledPromise(
      this.#client.connect(this.#transport),
      this.#input.startupTimeoutMs,
      signal
    );
  }

  async listTools(cursor: string | undefined, signal?: AbortSignal): Promise<ComputerMcpToolPage> {
    const response = await this.#client.listTools(
      cursor === undefined ? {} : { cursor },
      { signal, timeout: this.#input.requestTimeoutMs, maxTotalTimeout: this.#input.requestTimeoutMs }
    );
    return {
      tools: response.tools.map((tool) => ({
        name: tool.name,
        ...(tool.title === undefined ? {} : { title: tool.title }),
        ...(tool.description === undefined ? {} : { description: tool.description }),
        inputSchema: tool.inputSchema,
        ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
        ...(tool.annotations === undefined ? {} : { annotations: tool.annotations })
      })),
      ...(response.nextCursor === undefined ? {} : { nextCursor: response.nextCursor })
    };
  }

  async callTool(
    name: string,
    arguments_: Readonly<Record<string, unknown>>,
    signal?: AbortSignal
  ): Promise<ComputerToolCallResult> {
    return await this.#client.callTool(
      { name, arguments: arguments_ },
      undefined,
      { signal, timeout: this.#input.requestTimeoutMs, maxTotalTimeout: this.#input.requestTimeoutMs }
    ) as ComputerToolCallResult;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.#client.close();
    } catch {
      await this.#transport.close().catch(() => undefined);
    }
  }
}

class StaleTransportError extends Error {
  constructor(message = "Computer automation transport is stale.") {
    super(message);
    this.name = "StaleTransportError";
  }
}

function enqueue<T>(entry: SessionEntry, task: () => Promise<T>): Promise<T> {
  const run = entry.tail.then(task, task);
  entry.tail = run.then(() => undefined, () => undefined);
  return run;
}

function copyToolDescriptor(tool: ComputerToolDescriptor): ComputerToolDescriptor {
  return {
    name: tool.name,
    ...(tool.title === undefined ? {} : { title: boundedText(tool.title, 512) }),
    ...(tool.description === undefined ? {} : { description: boundedText(tool.description, 16 * 1024) }),
    inputSchema: cloneJsonRecord(tool.inputSchema, 512 * 1024),
    ...(tool.outputSchema === undefined ? {} : { outputSchema: cloneJsonRecord(tool.outputSchema, 512 * 1024) }),
    ...(tool.annotations === undefined ? {} : { annotations: cloneJsonRecord(tool.annotations, 64 * 1024) })
  };
}

function cloneToolArguments(
  value: Readonly<Record<string, unknown>>,
  maximumBytes: number
): Readonly<Record<string, unknown>> {
  try {
    return cloneJsonRecord(value, maximumBytes);
  } catch (error) {
    if (error instanceof ComputerToolProviderError) throw error;
    throw new ComputerToolProviderError("invalid_arguments");
  }
}

function cloneJsonRecord(
  value: Readonly<Record<string, unknown>>,
  maximumBytes: number
): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new ComputerToolProviderError("invalid_arguments");
  const budget = { remaining: maximumBytes, entries: 0 };
  return cloneJsonValue(value, budget, 0, new WeakSet()) as Readonly<Record<string, unknown>>;
}

function cloneJsonValue(
  value: unknown,
  budget: { remaining: number; entries: number },
  depth: number,
  ancestors: WeakSet<object>
): unknown {
  if (depth > 32 || budget.entries > 10_000) throw new ComputerToolProviderError("invalid_arguments");
  budget.entries += 1;
  if (value === null || typeof value === "boolean") {
    spendBudget(budget, 5);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ComputerToolProviderError("invalid_arguments");
    spendBudget(budget, 24);
    return value;
  }
  if (typeof value === "string") {
    spendBudget(budget, Buffer.byteLength(value, "utf8") + 2);
    return value;
  }
  if (typeof value !== "object" || value === undefined) throw new ComputerToolProviderError("invalid_arguments");
  if (ancestors.has(value)) throw new ComputerToolProviderError("invalid_arguments");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      spendBudget(budget, 2);
      return value.map((item) => cloneJsonValue(item, budget, depth + 1, ancestors));
    }
    if (!isRecord(value)) throw new ComputerToolProviderError("invalid_arguments");
    const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    spendBudget(budget, 2);
    for (const [key, item] of Object.entries(value)) {
      if (key.length > 512 || key.includes("\0")) throw new ComputerToolProviderError("invalid_arguments");
      spendBudget(budget, Buffer.byteLength(key, "utf8") + 3);
      copy[key] = cloneJsonValue(item, budget, depth + 1, ancestors);
    }
    return copy;
  } finally {
    ancestors.delete(value);
  }
}

function spendBudget(budget: { remaining: number }, amount: number): void {
  budget.remaining -= amount;
  if (budget.remaining < 0) throw new ComputerToolProviderError("invalid_arguments");
}

function staleToolResult(result: ComputerToolCallResult): string | undefined {
  if (!Array.isArray(result.content)) return undefined;
  for (const item of result.content) {
    if (
      isRecord(item)
      && item["type"] === "text"
      && typeof item["text"] === "string"
      && isStaleComputerTransportError(new Error(item["text"]))
    ) return item["text"];
  }
  return undefined;
}

interface PreparedTrajectoryAction {
  readonly turn: string;
  readonly tool: ComputerPublicToolName;
  readonly arguments: Record<string, unknown>;
}

type PreparedTrajectory =
  | { readonly error: ComputerToolCallResult }
  | {
      readonly directory: string;
      readonly actions: readonly PreparedTrajectoryAction[];
      readonly delayMs: number;
      readonly stopOnError: boolean;
    };

const TRAJECTORY_PATH_ARGUMENTS: Partial<Record<ComputerPublicToolName, readonly string[]>> = {
  get_window_state: ["screenshot_out_file"],
  click: ["debug_image_out"],
  start_recording: ["output_dir"]
};

async function prepareTrajectory(
  arguments_: Readonly<Record<string, unknown>>,
  signal: AbortSignal | undefined,
  workspaceRoot: string | undefined
): Promise<PreparedTrajectory> {
  const directory = arguments_["dir"];
  if (typeof directory !== "string") return trajectoryValidationError("Trajectory directory is missing.");
  try {
    const trajectoryRoot = await fileSystem.realpath(directory);
    const actionPathRoot = workspaceRoot === undefined
      ? trajectoryRoot
      : await fileSystem.realpath(workspaceRoot);
    if (!pathWithin(trajectoryRoot, actionPathRoot)) {
      return trajectoryValidationError("Trajectory directory leaves the active workspace.");
    }
    const directoryStat = await fileSystem.lstat(trajectoryRoot);
    if (!directoryStat.isDirectory()) return trajectoryValidationError("Trajectory path is not a directory.");
    const turns: string[] = [];
    let entries = 0;
    const openedDirectory = await fileSystem.opendir(trajectoryRoot);
    for await (const entry of openedDirectory) {
      signal?.throwIfAborted();
      entries += 1;
      if (entries > 10_000) return trajectoryValidationError("Trajectory directory exceeds its entry limit.");
      if (!entry.name.startsWith("turn-")) continue;
      turns.push(entry.name);
      if (turns.length > 1_000) return trajectoryValidationError("Trajectory exceeds its turn limit.");
    }
    turns.sort();

    const actions: PreparedTrajectoryAction[] = [];
    let totalBytes = 0;
    for (const turn of turns) {
      signal?.throwIfAborted();
      const turnPath = join(trajectoryRoot, turn);
      const turnStat = await fileSystem.lstat(turnPath);
      if (!turnStat.isDirectory() || turnStat.isSymbolicLink()) {
        return trajectoryValidationError("Recorded turn must be a real directory.", turn);
      }
      const actionPath = join(turnPath, "action.json");
      const actionStat = await fileSystem.lstat(actionPath);
      if (!actionStat.isFile() || actionStat.isSymbolicLink() || actionStat.size > 256 * 1024) {
        return trajectoryValidationError("Recorded action is not a bounded regular file.", turn);
      }
      await assertCanonicalWithin(trajectoryRoot, actionPath, false);
      const handle = await fileSystem.open(
        actionPath,
        fileConstants.O_RDONLY | (process.platform === "win32" ? 0 : (fileConstants.O_NOFOLLOW ?? 0))
      );
      let text: string;
      try {
        const openedStat = await handle.stat();
        if (!openedStat.isFile() || openedStat.size > 256 * 1024) {
          return trajectoryValidationError("Recorded action changed while it was being opened.", turn);
        }
        const currentPath = await fileSystem.realpath(actionPath);
        const currentStat = await fileSystem.stat(currentPath);
        if (openedStat.dev !== currentStat.dev || openedStat.ino !== currentStat.ino) {
          return trajectoryValidationError("Recorded action changed while it was being opened.", turn);
        }
        const buffer = Buffer.alloc(openedStat.size + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > 256 * 1024 || bytesRead !== openedStat.size) {
          return trajectoryValidationError("Recorded action changed while it was being read.", turn);
        }
        totalBytes += bytesRead;
        if (totalBytes > 2 * 1024 * 1024) {
          return trajectoryValidationError("Trajectory exceeds its aggregate byte limit.", turn);
        }
        text = buffer.subarray(0, bytesRead).toString("utf8");
      } finally {
        await handle.close();
      }

      const decoded: unknown = JSON.parse(text);
      if (!isRecord(decoded) || typeof decoded["tool"] !== "string" || decoded["tool"] === "replay_trajectory") {
        return trajectoryValidationError("Nested or unnamed replay actions are not allowed.", turn);
      }
      if (!isComputerPublicToolName(decoded["tool"])) {
        return trajectoryValidationError("Recorded tool is not part of the public catalog.", turn);
      }
      const rawArguments = decoded["arguments"] ?? {};
      if (!isRecord(rawArguments)) return trajectoryValidationError("Recorded arguments must be an object.", turn);
      let normalized: Record<string, unknown>;
      try {
        normalized = normalizeComputerToolArguments(decoded["tool"], rawArguments);
      } catch {
        return trajectoryValidationError("Recorded arguments do not match the current schema.", turn);
      }
      const safeArguments = await constrainTrajectoryActionPaths(
        actionPathRoot,
        decoded["tool"],
        normalized
      );
      if (safeArguments === undefined) {
        return trajectoryValidationError("Recorded action path leaves the trajectory directory.", turn);
      }
      actions.push({ turn, tool: decoded["tool"], arguments: safeArguments });
    }
    if (actions.length === 0) return trajectoryValidationError("No replayable turns were found.");
    const delayMs = typeof arguments_["delay_ms"] === "number" ? arguments_["delay_ms"] : 500;
    if (delayMs * Math.max(actions.length - 1, 0) > 5 * 60_000) {
      return trajectoryValidationError("Trajectory exceeds its aggregate delay limit.");
    }
    return {
      directory: trajectoryRoot,
      actions,
      delayMs,
      stopOnError: arguments_["stop_on_error"] !== false
    };
  } catch (error) {
    if (isAbortError(error)) throw error;
    return trajectoryValidationError("Trajectory could not be validated safely.");
  }
}

function trajectoryValidationError(message: string, turn?: string): PreparedTrajectory {
  return {
    error: errorToolResult("TRAJECTORY_VALIDATION_FAILED", {
      message,
      ...(turn === undefined ? {} : { turn })
    })
  };
}

async function constrainTrajectoryActionPaths(
  trajectoryRoot: string,
  toolName: ComputerPublicToolName,
  arguments_: Record<string, unknown>
): Promise<Record<string, unknown> | undefined> {
  const pathArguments = TRAJECTORY_PATH_ARGUMENTS[toolName];
  if (pathArguments === undefined) return arguments_;
  const safe = { ...arguments_ };
  for (const key of pathArguments) {
    const value = safe[key];
    if (typeof value !== "string" || value === "") continue;
    const candidate = isAbsolute(value) ? resolve(value) : resolve(trajectoryRoot, value);
    try {
      // The workspace root is canonical, while a recorded absolute path can
      // retain an equivalent symlink spelling (for example, a CI temp path).
      // The nearest-existing-ancestor check below is the authoritative
      // boundary: it accepts that alias but still rejects traversal and
      // existing or missing descendants reached through an escaping symlink.
      await assertCanonicalWithin(trajectoryRoot, candidate, true);
    } catch {
      return undefined;
    }
    safe[key] = candidate;
  }
  return safe;
}

async function assertCanonicalWithin(root: string, candidate: string, allowMissing: boolean): Promise<void> {
  const canonicalRoot = await fileSystem.realpath(root);
  let current = candidate;
  for (;;) {
    try {
      const canonical = await fileSystem.realpath(current);
      if (!pathWithin(canonical, canonicalRoot)) throw new Error("Path escapes root.");
      return;
    } catch (error) {
      if (!allowMissing || (error instanceof Error && error.message === "Path escapes root.")) throw error;
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

function pathWithin(candidate: string, root: string): boolean {
  const relation = relative(root, candidate);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function summarizeToolResult(result: ComputerToolCallResult, maximumCharacters: number): string {
  if (maximumCharacters <= 0) return "";
  const payload = driverResultPayload(result);
  let text = payload === undefined ? "" : JSON.stringify(payload);
  if (text === "" && Array.isArray(result.content)) {
    const item = result.content.find((candidate) => isRecord(candidate) && candidate["type"] === "text");
    if (isRecord(item) && typeof item["text"] === "string") text = item["text"];
  }
  return text.length <= maximumCharacters
    ? text
    : maximumCharacters === 1 ? text.slice(0, 1) : `${text.slice(0, maximumCharacters - 1)}…`;
}

function replayDelay(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(abortError());
  return new Promise<void>((resolveDelay, rejectDelay) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveDelay();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      rejectDelay(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const DRIVER_SESSION_TOOLS = new Set<ComputerPublicToolName>([
  "list_windows",
  "get_window_state",
  "click",
  "double_click",
  "right_click",
  "drag",
  "type_text",
  "set_value",
  "press_key",
  "hotkey",
  "scroll",
  "move_cursor",
  "get_agent_cursor_state",
  "start_recording"
]);

const ELEMENT_ACTION_TOOLS = new Set<ComputerPublicToolName>([
  "click",
  "double_click",
  "right_click",
  "type_text",
  "set_value",
  "press_key",
  "scroll"
]);

function driverSessionId(entry: SessionEntry): string {
  const session = entry.fence.sessionId.replace(/[^A-Za-z0-9_.:-]/gu, "-").slice(0, 200);
  const nonce = entry.fence.token.replace(/[^A-Za-z0-9_.:-]/gu, "-").slice(0, 80);
  return `${session}-computer-${nonce}-${entry.fence.generation}-${entry.transportEpoch}`;
}

function withDriverSession(
  entry: SessionEntry,
  name: ComputerPublicToolName,
  arguments_: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  const prepared = { ...arguments_ };
  if (!DRIVER_SESSION_TOOLS.has(name)) {
    delete prepared["session"];
    delete prepared["cursor_id"];
    return prepared;
  }
  const session = driverSessionId(entry);
  if (name === "get_agent_cursor_state") {
    prepared["cursor_id"] = session;
    delete prepared["session"];
  } else if (name === "move_cursor") {
    prepared["cursor_id"] = session;
    prepared["session"] = session;
  } else {
    prepared["session"] = session;
  }
  return prepared;
}

function driverDispatchArguments(
  name: ComputerPublicToolName,
  arguments_: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  const prepared = { ...arguments_ };
  delete prepared["snapshot_id"];
  if (
    name === "get_window_state"
    && prepared["capture_mode"] !== "ax"
    && typeof prepared["screenshot_out_file"] !== "string"
  ) {
    prepared["screenshot_out_file"] = defaultScreenshotOutputPath(prepared["window_id"]);
  }
  if (name === "list_windows") {
    delete prepared["query"];
    delete prepared["workspace_root"];
    delete prepared["process_name"];
  }
  return prepared;
}

function defaultScreenshotOutputPath(windowId: unknown): string {
  const directory = join(tmpdir(), "joko-computer-automation");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = typeof windowId === "number" ? String(windowId) : "window";
  return join(directory, `get_window_state-${target}-${Date.now()}-${randomUUID().slice(0, 8)}.png`);
}

function staleSnapshotResult(
  entry: SessionEntry,
  name: ComputerPublicToolName,
  arguments_: Readonly<Record<string, unknown>>
): ComputerToolCallResult | undefined {
  if (!ELEMENT_ACTION_TOOLS.has(name) || typeof arguments_["element_index"] !== "number") return undefined;
  const snapshotId = arguments_["snapshot_id"];
  if (typeof snapshotId !== "string") return undefined;
  const processId = arguments_["pid"];
  const windowId = arguments_["window_id"];
  if (typeof processId !== "number") return undefined;
  const verdict = entry.snapshots.validate(
    snapshotId,
    processId,
    typeof windowId === "number" ? windowId : undefined
  );
  if (verdict.ok) return undefined;
  return errorToolResult("STALE_SNAPSHOT", {
    tool: name,
    snapshot_id: snapshotId,
    reason: verdict.reason,
    ...(verdict.latestSnapshotId === undefined ? {} : { latest_snapshot_id: verdict.latestSnapshotId }),
    hint: "The element_index comes from a window snapshot that is no longer the latest observation of this window, so the target element may have moved or changed. Call get_window_state again for this pid/window_id, then retry with the fresh snapshot_id and element_index."
  });
}

function jsonToolResult<T extends object>(value: T): ComputerToolCallResult {
  const record = { ...value } as Readonly<Record<string, unknown>>;
  return {
    content: [{ type: "text", text: JSON.stringify(record) }],
    structuredContent: record,
    isError: false
  };
}

function errorToolResult(code: string, data: Readonly<Record<string, unknown>>): ComputerToolCallResult {
  const value = { ok: false, errorCode: code, data };
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    isError: true
  };
}

function splitTextChunks(value: string): readonly string[] {
  const characters = Array.from(value);
  if (characters.length <= 400) return [value];
  const chunks: string[] = [];
  for (let offset = 0; offset < characters.length; offset += 400) {
    chunks.push(characters.slice(offset, offset + 400).join(""));
  }
  return chunks;
}

function driverResultPayload(result: ComputerToolCallResult): Record<string, unknown> | undefined {
  if (isRecord(result.structuredContent)) return result.structuredContent;
  if (!Array.isArray(result.content)) return undefined;
  for (const item of result.content) {
    if (!isRecord(item) || item["type"] !== "text" || typeof item["text"] !== "string") continue;
    try {
      const parsed: unknown = JSON.parse(item["text"]);
      if (isRecord(parsed)) return parsed;
    } catch {
      // A non-JSON text block is still a valid driver result.
    }
  }
  return undefined;
}

function readInsertedCharacters(result: ComputerToolCallResult): number | undefined {
  const payload = driverResultPayload(result);
  const value = payload?.["inserted"];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function aggregateTypeTextResult(
  inserted: number,
  chunks: number
): ComputerToolCallResult {
  return jsonToolResult({
    ok: true,
    inserted,
    chars: inserted,
    chunks
  });
}

function driverResultFailed(result: ComputerToolCallResult): boolean {
  if (result.isError === true) return true;
  return driverResultPayload(result)?.["ok"] === false;
}

function readDriverSnapshotId(result: ComputerToolCallResult): string | undefined {
  const payload = driverResultPayload(result);
  const direct = payload?.["snapshot_id"];
  if (typeof direct === "string" && direct.trim() !== "") return direct;
  const elements = payload?.["elements"];
  if (!Array.isArray(elements)) return undefined;
  for (const element of elements) {
    if (!isRecord(element) || typeof element["element_token"] !== "string") continue;
    const separator = element["element_token"].indexOf(":");
    if (separator > 0) return element["element_token"].slice(0, separator);
  }
  return undefined;
}

function stampSnapshotId(result: ComputerToolCallResult, snapshotId: string): ComputerToolCallResult {
  const payload = driverResultPayload(result);
  const stamped = { ...(payload ?? {}), snapshot_id: snapshotId };
  let replaced = false;
  const content = Array.isArray(result.content)
    ? result.content.map((item) => {
        if (replaced || !isRecord(item) || item["type"] !== "text" || typeof item["text"] !== "string") return item;
        try {
          const parsed: unknown = JSON.parse(item["text"]);
          if (!isRecord(parsed)) return item;
          replaced = true;
          return { ...item, text: JSON.stringify({ ...parsed, snapshot_id: snapshotId }) };
        } catch {
          return item;
        }
      })
    : [];
  if (!replaced) content.push({ type: "text", text: JSON.stringify({ snapshot_id: snapshotId }) });
  return { ...result, content, structuredContent: stamped };
}

function filterListWindowsResult(
  result: ComputerToolCallResult,
  arguments_: Readonly<Record<string, unknown>>
): ComputerToolCallResult {
  const processName = normalizedWindowFilter(arguments_["process_name"]);
  const query = normalizedWindowFilter(arguments_["query"]);
  const workspaceRoot = typeof arguments_["workspace_root"] === "string"
    ? arguments_["workspace_root"].replaceAll("\\", "/").replace(/\/$/u, "").toLowerCase()
    : undefined;
  if (processName === undefined && query === undefined && workspaceRoot === undefined) return result;
  const payload = driverResultPayload(result);
  if (payload === undefined) return result;
  const directWindows = Array.isArray(payload["windows"]) ? payload["windows"] : undefined;
  const data = isRecord(payload["data"]) ? payload["data"] : undefined;
  const nestedWindows = Array.isArray(data?.["windows"]) ? data["windows"] : undefined;
  const windows = directWindows ?? nestedWindows;
  if (windows === undefined) return result;
  const filtered = windows.filter((window) => {
    if (!isRecord(window)) return false;
    const processText = [
      window["process_name"],
      window["processName"],
      window["app_name"],
      window["application_name"]
    ].filter((value): value is string => typeof value === "string").join(" ").toLowerCase();
    if (processName !== undefined && !processText.includes(processName)) return false;
    const searchable = JSON.stringify(window).toLowerCase();
    if (query !== undefined && !searchable.includes(query)) return false;
    if (workspaceRoot !== undefined) {
      const workspaceValues = [
        window["workspace_root"],
        window["workspaceRoot"],
        window["cwd"],
        window["executable_path"],
        window["executablePath"]
      ].filter((value): value is string => typeof value === "string")
        .map((value) => value.replaceAll("\\", "/").toLowerCase());
      if (!workspaceValues.some((value) => value === workspaceRoot || value.startsWith(`${workspaceRoot}/`))) return false;
    }
    return true;
  });
  const filteredPayload = directWindows === undefined
    ? { ...payload, data: { ...data, windows: filtered } }
    : { ...payload, windows: filtered };
  return replaceJsonResultPayload(result, filteredPayload);
}

function replaceJsonResultPayload(
  result: ComputerToolCallResult,
  payload: Readonly<Record<string, unknown>>
): ComputerToolCallResult {
  let replaced = false;
  const content = Array.isArray(result.content)
    ? result.content.map((item) => {
        if (replaced || !isRecord(item) || item["type"] !== "text" || typeof item["text"] !== "string") return item;
        try {
          const parsed: unknown = JSON.parse(item["text"]);
          if (!isRecord(parsed)) return item;
          replaced = true;
          return { ...item, text: JSON.stringify(payload) };
        } catch {
          return item;
        }
      })
    : [];
  return { ...result, content, structuredContent: payload };
}

function normalizedWindowFilter(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim().toLowerCase() : undefined;
}

async function endDriverSessionQuietly(entry: SessionEntry): Promise<void> {
  if (entry.transportEpoch < 1) return;
  await entry.connection.callTool("end_session", { session: driverSessionId(entry) }).catch(() => undefined);
}

function releaseRuntimeSession(entry: SessionEntry, runtime: ComputerRuntime): void {
  if (!entry.runtimeHeld) return;
  entry.runtimeHeld = false;
  runtime.releaseDriverSession();
}

function validateSessionId(value: string): void {
  if (value.trim() === "" || value.length > 1_024 || value.includes("\0")) {
    throw new ComputerToolProviderError("invalid_session");
  }
}

function validateFence(fence: ComputerSessionFence): void {
  validateSessionId(fence.sessionId);
  if (!Number.isSafeInteger(fence.generation) || fence.generation < 1) {
    throw new ComputerToolProviderError("stale_session");
  }
  boundedToken(fence.token);
}

function boundedToken(value: string): string {
  if (value.trim() === "" || value.length > 1_024 || value.includes("\0")) {
    throw new ComputerToolProviderError("invalid_session");
  }
  return value;
}

function validateToolName(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u.test(value)) {
    throw new ComputerToolProviderError("unknown_tool");
  }
}

function boundedCursor(value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (value.length > 8_192 || value.includes("\0")) throw new ComputerToolProviderError("catalog_too_large");
  return value;
}

function boundedText(value: string, maximumLength: number): string {
  return value.replace(/\0/gu, "").slice(0, maximumLength);
}

function argumentLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 4 * 1024 * 1024) {
    throw new RangeError("Computer tool argument limit must be between one byte and four MiB.");
  }
  return value;
}

function providerTimeout(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 60 * 60 * 1_000) {
    throw new RangeError(`${label} must be between one millisecond and one hour.`);
  }
  return value;
}

function anySignal(sessionSignal: AbortSignal, requestSignal: AbortSignal | undefined): AbortSignal {
  return requestSignal === undefined
    ? sessionSignal
    : AbortSignal.any([sessionSignal, requestSignal]);
}

async function controlledPromise<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted === true) throw abortError();
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Computer automation connection timed out.")), timeoutMs);
  });
  const aborted = signal === undefined ? undefined : new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race(aborted === undefined ? [promise, timeout] : [promise, timeout, aborted]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
  }
}

function withSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort)).catch(() => undefined);
  });
}

async function closeQuietly(connection: ComputerMcpConnection): Promise<void> {
  await connection.close().catch(() => undefined);
}

function abortError(): Error {
  return new DOMException("The computer automation request was cancelled.", "AbortError");
}

function isAbortError(value: unknown): boolean {
  return value instanceof Error && value.name === "AbortError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function providerErrorMessage(code: ComputerToolProviderError["code"], toolName?: string): string {
  if (code === "invalid_session") return "Computer automation Session ID is invalid.";
  if (code === "stale_session") return "Computer automation Session is closed or fenced.";
  if (code === "connect_failed") return "Computer automation transport could not connect.";
  if (code === "transport_failed") return "Computer automation transport failed.";
  if (code === "unknown_tool") return toolName === undefined
    ? "Computer automation tool name is invalid."
    : `Computer automation tool '${toolName}' is unavailable.`;
  if (code === "catalog_too_large") return "Computer automation tool catalog exceeded its bound.";
  if (code === "stale_snapshot") return "Computer automation window snapshot is stale.";
  return "Computer automation tool arguments are invalid.";
}
