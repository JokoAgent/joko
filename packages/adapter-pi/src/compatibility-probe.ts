import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, delimiter, isAbsolute, join, resolve } from "node:path";
import { asPiError, piError, redactManagedSecrets, redactedDiagnostic } from "./errors.js";
import { isRecord, type PiRpcCommand, type PiRpcEvent, type PiRpcState } from "./protocol.js";
import { PiRpcTransport, type PiProcessFactory, type PiProcessHandle, type PiProcessSpec } from "./transport.js";

const PROBE_PROVIDER_ID = "joko-compatibility";
const PROBE_MODEL_ID = "rpc-probe";
const PROBE_STATUS_KEY = "joko-compatibility/v1";
const PROBE_COMMAND_NAME = "joko-compatibility";
const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

const OPTIONAL_COMMANDS = [
  "get_tree",
  "get_entries",
  "get_messages",
  "get_available_models",
  "get_available_thinking_levels",
  "get_session_stats",
  "get_fork_messages",
  "get_last_assistant_text"
] as const;

export type PiOptionalProbeCommand = (typeof OPTIONAL_COMMANDS)[number];

export interface PiCompatibilityReport {
  readonly executableIdentity: string;
  readonly unsupportedCommands: readonly PiOptionalProbeCommand[];
  readonly diagnostics: readonly string[];
  readonly observedEvents: readonly string[];
}

export interface PiCompatibilityProbeOptions {
  readonly command: string;
  readonly commandArgs: readonly string[];
  readonly processFactory: PiProcessFactory;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly startupTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly maxRecordBytes?: number;
  readonly redactValues?: readonly string[];
}

export interface PiCompatibilityTransport {
  request(
    command: PiRpcCommand,
    options?: { readonly timeoutMs?: number; readonly signal?: AbortSignal; readonly stateMayHaveChanged?: boolean }
  ): Promise<unknown>;
  onEvent(listener: (event: PiRpcEvent) => void): () => void;
}

interface ProbeObservation {
  readonly events: Set<string>;
  readonly bridge: Promise<void>;
  readonly resolveBridge: () => void;
  readonly settled: Promise<void>;
  readonly resolveSettled: () => void;
}

/**
 * Stable identity for one executable protocol surface. The direct executable
 * and a path-like launcher argument are both fingerprinted so a Node-hosted
 * CLI upgrade invalidates the cache even when node.exe itself is unchanged.
 */
export async function canonicalPiExecutableIdentity(
  command: string,
  commandArgs: readonly string[],
  environment: Readonly<NodeJS.ProcessEnv> = process.env
): Promise<string> {
  const executable = await resolveExecutable(command, environment);
  const candidates = [executable];
  const launcher = commandArgs[0];
  if (launcher !== undefined && looksLikePath(launcher)) {
    candidates.push(await canonicalFileIdentity(launcher));
  }
  return createHash("sha256").update(JSON.stringify(candidates)).digest("hex");
}

/**
 * Run the compatibility handshake in a disposable native session. It never
 * attaches to, repairs, or replaces a product Session.
 */
export async function probePiExecutable(options: PiCompatibilityProbeOptions): Promise<PiCompatibilityReport> {
  const timeoutMs = boundedTimeout(options.startupTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
  const executableIdentity = await canonicalPiExecutableIdentity(options.command, options.commandArgs, options.environment);
  const root = await mkdtemp(join(tmpdir(), "joko-pi-compatibility-"));
  const agentHome = join(root, "agent-home");
  const sessions = join(root, "sessions");
  const workspace = join(root, "workspace");
  const extensionPath = join(root, "compatibility-extension.mjs");
  let server: Server | undefined;
  let transport: PiRpcTransport | undefined;
  try {
    await Promise.all([
      writeProbeAgentHome(agentHome),
      writeFile(extensionPath, PROBE_EXTENSION_SOURCE, { encoding: "utf8", mode: 0o600 }),
      writeFile(join(root, "workspace.marker"), "compatibility probe\n", { encoding: "utf8", mode: 0o600 })
    ]);
    await Promise.all([
      mkdir(sessions, { recursive: true, mode: 0o700 }),
      mkdir(workspace, { recursive: true, mode: 0o700 })
    ]);
    server = await startProbeServer();
    const address = server.address() as AddressInfo;
    await writeProbeModels(agentHome, address.port);

    const spec: PiProcessSpec = {
      command: options.command,
      args: [
        ...options.commandArgs,
        "--mode", "rpc",
        "--session-dir", sessions,
        "--no-approve",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--offline",
        "--extension", extensionPath,
        "--session-id", `compatibility-${randomUUID()}`,
        "--provider", PROBE_PROVIDER_ID,
        "--model", PROBE_MODEL_ID,
        "--thinking", "off"
      ],
      cwd: workspace,
      env: {
        ...options.environment,
        PI_CODING_AGENT_DIR: agentHome,
        PI_CODING_AGENT_SESSION_DIR: sessions,
        PI_SKIP_VERSION_CHECK: "1",
        JOKO_PI_COMPATIBILITY_KEY: "loopback-only",
        NO_PROXY: mergeNoProxy(options.environment.NO_PROXY)
      }
    };
    let process: PiProcessHandle;
    try {
      process = await options.processFactory(spec);
    } catch (error) {
      throw asPiError(error, {
        code: "PI_COMPATIBILITY_PROCESS_SPAWN_FAILED",
        phase: "probe",
        retryable: true,
        recovery: "Verify the installed Pi executable and service account environment before probing again."
      }, options.redactValues);
    }
    transport = new PiRpcTransport({
      process,
      generation: 0,
      requestTimeoutMs: timeoutMs,
      maxRecordBytes: options.maxRecordBytes,
      redactValues: options.redactValues
    });
    return await runTypedPiCompatibilityProbe(transport, {
      executableIdentity,
      extensionPath,
      timeoutMs,
      redactValues: options.redactValues
    });
  } finally {
    if (transport !== undefined) {
      await transport.terminate(options.shutdownTimeoutMs ?? 2_000).catch(() => undefined);
    }
    if (server !== undefined) await closeServer(server).catch(() => undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => undefined);
  }
}

/** Typed protocol checks kept separate so malformed/rejected wire fixtures can be tested directly. */
export async function runTypedPiCompatibilityProbe(
  transport: PiCompatibilityTransport,
  options: {
    readonly executableIdentity: string;
    readonly extensionPath: string;
    readonly timeoutMs?: number;
    readonly redactValues?: readonly string[];
  }
): Promise<PiCompatibilityReport> {
  const timeoutMs = boundedTimeout(options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
  const deadline = Date.now() + timeoutMs;
  const remaining = (): number => Math.max(1, deadline - Date.now());
  const observation = observeProbeEvents(transport);
  try {
    const state = responseData(await transport.request({ type: "get_state" }, { timeoutMs: remaining() }));
    assertCompatibleState(state);

    const commands = responseData(await transport.request({ type: "get_commands" }, { timeoutMs: remaining() }));
    assertProbeBridge(commands, options.extensionPath);
    await withDeadline(observation.bridge, remaining(), "PI_COMPATIBILITY_BRIDGE_TIMEOUT", "Pi did not publish the managed compatibility bridge handshake");

    const optionalBudgetMs = Math.max(25, Math.min(1_000, Math.trunc(remaining() / 3)));
    const optionalResults = await Promise.all(OPTIONAL_COMMANDS.map(async (command) => {
      try {
        const data = responseData(await transport.request({ type: command }, { timeoutMs: optionalBudgetMs }));
        return validOptionalResponse(command, data)
          ? undefined
          : { command, diagnostic: `${command}: invalid response shape` };
      } catch (error) {
        return {
          command,
          diagnostic: `${command}: ${redactManagedSecrets(redactedDiagnostic(error), options.redactValues)}`
        };
      }
    }));
    const unsupported = optionalResults.filter((result): result is NonNullable<typeof result> => result !== undefined);
    const unsupportedCommands = unsupported.map((result) => result.command);
    const diagnostics = unsupported.map((result) => result.diagnostic);

    await transport.request(
      { type: "prompt", message: "Reply with OK.", images: [] },
      { timeoutMs: remaining(), stateMayHaveChanged: true }
    );
    await withDeadline(
      observation.settled,
      remaining(),
      "PI_COMPATIBILITY_LIFECYCLE_TIMEOUT",
      "Pi did not publish agent_settled for the bounded compatibility turn"
    );
    if (!observation.events.has("agent_start")) {
      throw piError("PI_COMPATIBILITY_LIFECYCLE_INVALID", "Pi published agent_settled without agent_start", "probe", {
        recovery: "Install a Pi executable with the required RPC agent lifecycle; no product Session was created."
      });
    }
    const finalState = responseData(await transport.request({ type: "get_state" }, { timeoutMs: remaining() }));
    assertCompatibleState(finalState);
    if ((finalState as PiRpcState).isStreaming) {
      throw piError("PI_COMPATIBILITY_LIFECYCLE_INVALID", "Pi remained streaming after agent_settled", "probe", {
        recovery: "Install a Pi executable with a coherent terminal RPC lifecycle; no product Session was created."
      });
    }
    return {
      executableIdentity: options.executableIdentity,
      unsupportedCommands,
      diagnostics,
      observedEvents: [...observation.events].sort()
    };
  } finally {
    observation.resolveBridge();
    observation.resolveSettled();
  }
}

export function assertCompatibleState(value: unknown): asserts value is PiRpcState {
  if (
    !isRecord(value)
    || typeof value.sessionId !== "string"
    || value.sessionId.trim() === ""
    || typeof value.sessionFile !== "string"
    || value.sessionFile.trim() === ""
    || typeof value.thinkingLevel !== "string"
    || typeof value.isStreaming !== "boolean"
    || typeof value.isCompacting !== "boolean"
    || !["all", "one-at-a-time"].includes(String(value.steeringMode))
    || !["all", "one-at-a-time"].includes(String(value.followUpMode))
    || typeof value.autoCompactionEnabled !== "boolean"
    || !nonNegativeInteger(value.messageCount)
    || !nonNegativeInteger(value.pendingMessageCount)
    || (value.model !== undefined && !validModel(value.model))
  ) {
    throw piError("PI_COMPATIBILITY_STATE_INVALID", "Pi get_state returned an incompatible response shape", "probe", {
      recovery: "Install a Pi executable exposing the required typed RPC state; no product Session was created."
    });
  }
}

export function assertManagedBridgeHandshake(value: unknown, bridgePath: string): void {
  if (!isRecord(value) || !Array.isArray(value.commands)) {
    throw piError("PI_BRIDGE_HANDSHAKE_INVALID", "Pi get_commands returned an incompatible bridge catalog", "handshake", {
      recovery: "Repair the managed Pi extension load before retrying the same native Session."
    });
  }
  const required = new Set(["joko-navigate-tree", "joko-rebuild-context", "joko-reset-context"]);
  for (const command of value.commands) {
    if (!isRecord(command) || command.source !== "extension" || !isRecord(command.sourceInfo)) continue;
    if (typeof command.sourceInfo.path !== "string" || !samePath(command.sourceInfo.path, bridgePath)) continue;
    if (typeof command.name === "string") required.delete(command.name.replace(/:\d+$/u, ""));
  }
  if (required.size !== 0) {
    throw piError("PI_BRIDGE_HANDSHAKE_INCOMPLETE", "Pi did not load the complete managed policy bridge", "handshake", {
      recovery: "Repair the managed extension generation before retrying the same native Session."
    });
  }
}

function assertProbeBridge(value: unknown, extensionPath: string): void {
  if (!isRecord(value) || !Array.isArray(value.commands)) {
    throw piError("PI_COMPATIBILITY_COMMANDS_INVALID", "Pi get_commands returned an incompatible response shape", "probe", {
      recovery: "Install a Pi executable exposing the required typed RPC command catalog."
    });
  }
  const loaded = value.commands.some((command) =>
    isRecord(command)
    && command.source === "extension"
    && command.name === PROBE_COMMAND_NAME
    && isRecord(command.sourceInfo)
    && typeof command.sourceInfo.path === "string"
    && samePath(command.sourceInfo.path, extensionPath)
  );
  if (!loaded) {
    throw piError("PI_COMPATIBILITY_BRIDGE_INCOMPLETE", "Pi did not load the compatibility extension through RPC mode", "probe", {
      recovery: "Install a Pi executable with compatible managed-extension and RPC command support."
    });
  }
}

function observeProbeEvents(transport: PiCompatibilityTransport): ProbeObservation {
  let resolveBridge!: () => void;
  let resolveSettled!: () => void;
  const bridge = new Promise<void>((resolvePromise) => { resolveBridge = resolvePromise; });
  const settled = new Promise<void>((resolvePromise) => { resolveSettled = resolvePromise; });
  const observation: ProbeObservation = { events: new Set(), bridge, resolveBridge, settled, resolveSettled };
  transport.onEvent((event) => {
    observation.events.add(event.type);
    const record = event as unknown as Record<string, unknown>;
    if (
      event.type === "extension_ui_request"
      && record.method === "setStatus"
      && record.statusKey === PROBE_STATUS_KEY
      && validProbeStatus(record.statusText)
    ) resolveBridge();
    if (event.type === "agent_settled") resolveSettled();
  });
  return observation;
}

function validProbeStatus(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) && parsed.format === 1 && parsed.terminalEvent === "agent_settled";
  } catch {
    return false;
  }
}

function validOptionalResponse(command: PiOptionalProbeCommand, value: unknown): boolean {
  if (!isRecord(value)) return false;
  switch (command) {
    case "get_tree":
      return Array.isArray(value.tree) && nullableString(value.leafId);
    case "get_entries":
      return Array.isArray(value.entries) && nullableString(value.leafId);
    case "get_messages":
      return Array.isArray(value.messages);
    case "get_available_models":
      return Array.isArray(value.models);
    case "get_available_thinking_levels":
      return Array.isArray(value.levels) && value.levels.every((level) => typeof level === "string");
    case "get_session_stats":
      return isRecord(value.tokens) && typeof value.cost === "number" && Number.isFinite(value.cost);
    case "get_fork_messages":
      return Array.isArray(value.messages);
    case "get_last_assistant_text":
      // The current native runtime serializes "no assistant message yet" as
      // an omitted property even though its public RPC documentation says null.
      return value.text === undefined || nullableString(value.text);
  }
}

function responseData(response: unknown): unknown {
  return isRecord(response) ? response.data : undefined;
}

function validModel(value: unknown): boolean {
  return isRecord(value)
    && typeof value.provider === "string"
    && value.provider.trim() !== ""
    && typeof value.id === "string"
    && value.id.trim() !== "";
}

function nullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function nonNegativeInteger(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

async function writeProbeAgentHome(agentHome: string): Promise<void> {
  await mkdir(agentHome, { recursive: true, mode: 0o700 });
  await writeFile(join(agentHome, "settings.json"), `${JSON.stringify({
    defaultProjectTrust: "never",
    enableInstallTelemetry: false,
    enableAnalytics: false,
    compaction: { enabled: false },
    retry: { enabled: false }
  })}\n`, { encoding: "utf8", mode: 0o600 });
}

async function writeProbeModels(agentHome: string, port: number): Promise<void> {
  const models = {
    providers: {
      [PROBE_PROVIDER_ID]: {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        api: "openai-completions",
        apiKey: "$JOKO_PI_COMPATIBILITY_KEY",
        models: [{
          id: PROBE_MODEL_ID,
          name: "RPC compatibility probe",
          reasoning: false,
          input: ["text"],
          contextWindow: 4_096,
          maxTokens: 64,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        }]
      }
    }
  };
  await writeFile(join(agentHome, "models.json"), `${JSON.stringify(models)}\n`, { encoding: "utf8", mode: 0o600 });
}

async function startProbeServer(): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    request.resume();
    request.once("end", () => {
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "close"
      });
      response.write(`data: ${JSON.stringify({
        id: "joko-compatibility",
        object: "chat.completion.chunk",
        created: 1,
        model: PROBE_MODEL_ID,
        choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }]
      })}\n\n`);
      response.write(`data: ${JSON.stringify({
        id: "joko-compatibility",
        object: "chat.completion.chunk",
        created: 1,
        model: PROBE_MODEL_ID,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
  return server;
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise()));
}

async function resolveExecutable(command: string, environment: Readonly<NodeJS.ProcessEnv>): Promise<string> {
  if (isAbsolute(command) || looksLikePath(command)) return canonicalFileIdentity(resolve(command));
  const pathValue = environment.PATH ?? environment.Path ?? "";
  const extensions = process.platform === "win32"
    ? (environment.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, process.platform === "win32" && !command.toLowerCase().endsWith(extension.toLowerCase())
        ? `${command}${extension}`
        : command);
      if (await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK).then(() => true, () => false)) {
        return canonicalFileIdentity(candidate);
      }
    }
  }
  throw piError("PI_EXECUTABLE_IDENTITY_UNAVAILABLE", `Could not resolve Pi executable '${basename(command)}'`, "probe", {
    recovery: "Configure a canonical executable path and retry the compatibility probe."
  });
}

async function canonicalFileIdentity(path: string): Promise<string> {
  const canonical = await realpath(path);
  const info = await stat(canonical);
  if (!info.isFile()) {
    throw piError("PI_EXECUTABLE_IDENTITY_INVALID", "Pi executable identity is not a regular file", "probe");
  }
  return `${canonical}\0${info.size}\0${Math.trunc(info.mtimeMs)}\0${String(info.dev)}\0${String(info.ino)}`;
}

function looksLikePath(value: string): boolean {
  return isAbsolute(value) || value.includes("/") || value.includes("\\") || /\.(?:[cm]?js|exe|cmd|bat)$/iu.test(value);
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function boundedTimeout(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_PROBE_TIMEOUT_MS;
  return Math.max(250, Math.min(Math.trunc(value), 30_000));
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, code: string, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(piError(code, message, "probe", {
          recovery: "Install a compatible Pi executable; no product Session was created."
        })), timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function mergeNoProxy(value: string | undefined): string {
  const entries = new Set((value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean));
  entries.add("127.0.0.1");
  entries.add("localhost");
  return [...entries].join(",");
}

const PROBE_EXTENSION_SOURCE = `
export default function compatibilityProbe(pi) {
  pi.registerCommand(${JSON.stringify(PROBE_COMMAND_NAME)}, {
    description: "Validate the managed RPC extension bridge",
    handler: async () => undefined,
  });
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "rpc") return;
    ctx.ui.setStatus(${JSON.stringify(PROBE_STATUS_KEY)}, JSON.stringify({ format: 1, terminalEvent: "agent_settled" }));
  });
}
`;
