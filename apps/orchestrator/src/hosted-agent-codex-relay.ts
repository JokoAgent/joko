import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { randomUUID } from "node:crypto";
import type { CommandConcurrencyGate } from "@joko/runtime-governance";
import type { RemoteProcessHandle } from "@joko/remote-ssh";
import type { ExecutorWorkspace } from "./hosted-agent-workspace.js";
import { HostedAgentExecutorError } from "./hosted-agent-executor.js";
import { execServerActions, mapExecServerParams, mapExecServerFileData, mapExecServerResult, type HostedAgentCodexAction } from "./hosted-agent-codex-mapping.js";
export type { HostedAgentCodexAction } from "./hosted-agent-codex-mapping.js";

const MAXIMUM_LINE_BYTES = 48 * 1024 * 1024;
const MAXIMUM_PENDING_BYTES = 64 * 1024 * 1024;
const MAXIMUM_CONNECTIONS = 16;
export interface HostedAgentCodexAuthorization {
  readonly assertCurrent: () => void;
  readonly authorize: (actions: readonly HostedAgentCodexAction[], signal: AbortSignal) => Promise<() => void>;
  readonly prepareParams?: (method: string, params: unknown, actions: readonly HostedAgentCodexAction[], signal: AbortSignal) => Promise<unknown>;
}
export interface HostedAgentCodexRelayOptions extends HostedAgentCodexAuthorization {
  readonly openProcess?: (signal: AbortSignal) => Promise<RemoteProcessHandle>;
  readonly codexExecutable: string;
  readonly cwd: string;
  readonly workspace: ExecutorWorkspace;
  /** Ordinary task environments already use their execution machine's paths. */
  readonly identityPaths?: boolean;
  readonly pathStyle?: "posix" | "win32";
  /** Source-owned native tool environment. No Model Host credential is accepted. */
  readonly env?: NodeJS.ProcessEnv;
  readonly commandConcurrencyGate?: CommandConcurrencyGate;
  readonly sessionId: string;
}
interface Connection {
  readonly child: ChildProcessWithoutNullStreams | RemoteProcessHandle;
  readonly lifetime: AbortController;
  readonly decoder: StringDecoder;
  readonly messages: { readonly data: string; readonly assertCurrent: () => void }[];
  readonly observed: Set<string>;
  readonly commands: Map<string, string>;
  readonly starts: Map<string, string>;
  readonly responses: Map<string, () => void>;
  readonly processOwners: Map<string, () => void>;
  readonly files: Map<string, { readonly path: string; readonly assertCurrent: () => void }>;
  readonly openingFiles: Map<string, string>;
  readonly networkOwners: Map<string, () => void>;
  readonly serverRequests: Map<string, { readonly assertCurrent: () => void; readonly action: HostedAgentCodexAction }>;
  readonly exited: Promise<void>;
  buffer: string;
  bytes: number;
  closed: boolean;
  polling: boolean;
  wake?: () => void;
  tail: Promise<void>;
}

/** Source-side native exec-server. Each primitive is approved before stdin write. */
export class HostedAgentCodexExecServerRelay {
  readonly #options: HostedAgentCodexRelayOptions;
  readonly #connections = new Map<string, Connection>();
  readonly #opening = new Set<string>();
  readonly #openFlights = new Set<Promise<void>>();
  readonly #seen = new Set<string>();
  readonly #lifetime = new AbortController();
  #close?: Promise<void>;
  constructor(options: HostedAgentCodexRelayOptions) { options.assertCurrent(); this.#options = options; }
  async execute(value: unknown, signal: AbortSignal, authorization: HostedAgentCodexAuthorization = this.#options): Promise<Record<string, unknown>> {
    const request = parseRequest(value); this.#assert(authorization); signal.throwIfAborted();
    if (this.#seen.has(request.requestId)) throw new HostedAgentExecutorError("REQUEST_REPLAYED");
    if (this.#seen.size >= 65_536) throw new HostedAgentExecutorError("RESOURCE_EXHAUSTED");
    this.#seen.add(request.requestId);
    const { kind, connectionId } = request.payload;
    if (kind === "open") {
      const opening = this.#open(connectionId, AbortSignal.any([signal, this.#lifetime.signal]), authorization);
      this.#openFlights.add(opening);
      try { await opening; return {}; } finally { this.#openFlights.delete(opening); }
    }
    const connection = this.#connections.get(connectionId);
    if (!connection) {
      if (kind === "close") return {};
      throw new HostedAgentExecutorError("NOT_FOUND");
    }
    if (kind === "close") { await this.#drop(connection); this.#connections.delete(connectionId); return {}; }
    if (kind === "poll") return this.#poll(connection, signal, authorization);
    if (connection.closed) throw new HostedAgentExecutorError("STALE_AUTHORITY");
    const data = request.payload.data!;
    const delivery = connection.tail.then(() => this.#deliver(connection, data, signal, authorization));
    connection.tail = delivery.catch(() => undefined); await delivery; return {};
  }
  async #open(id: string, signal: AbortSignal, authorization: HostedAgentCodexAuthorization): Promise<void> {
    if (this.#connections.has(id) || this.#opening.has(id)) throw new HostedAgentExecutorError("REQUEST_REPLAYED");
    if (this.#connections.size + this.#opening.size >= MAXIMUM_CONNECTIONS) throw new HostedAgentExecutorError("RESOURCE_EXHAUSTED");
    this.#opening.add(id);
    try { await this.#start(id, signal, authorization); } finally { this.#opening.delete(id); }
  }
  async #start(id: string, signal: AbortSignal, authorization: HostedAgentCodexAuthorization): Promise<void> {
    const assert = await authorization.authorize([], signal); assert(); this.#assert(authorization);
    const child = this.#options.openProcess ? await this.#options.openProcess(signal) : spawn(this.#options.codexExecutable, ["exec-server", "--listen", "stdio://"], {
      cwd: this.#options.cwd, env: this.#options.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true
    });
    let resolveExit!: () => void;
    const exited = new Promise<void>(resolve => { resolveExit = resolve; });
    const connection: Connection = { child, lifetime: new AbortController(), decoder: new StringDecoder("utf8"), messages: [],
      observed: new Set(), commands: new Map(), starts: new Map(), responses: new Map(), processOwners: new Map(), files: new Map(), openingFiles: new Map(), networkOwners: new Map(), serverRequests: new Map(),
      exited, buffer: "", bytes: 0, closed: false, polling: false, tail: Promise.resolve() };
    this.#connections.set(id, connection);
    const finish = () => { connection.closed = true; connection.lifetime.abort(); this.#releaseCommands(connection); connection.wake?.(); resolveExit(); };
    child.once("exit", finish);
    child.once("error", () => {
      // Remote process ports need not expose a PID. Their channel errors are
      // not exit receipts; only the exact process exit may confirm retirement.
      if (!this.#options.openProcess && child.pid === undefined) finish();
      else void this.#drop(connection).catch(() => undefined);
    });
    child.stdin.on("error", () => { void this.#drop(connection).catch(() => undefined); }); child.stderr.resume();
    child.stdout.on("data", (chunk: Buffer) => {
      if (connection.closed) return;
      try {
        this.#options.assertCurrent(); this.#lifetime.signal.throwIfAborted();
        connection.buffer += connection.decoder.write(chunk);
        for (;;) {
          const index = connection.buffer.indexOf("\n"); if (index < 0) break;
          const line = connection.buffer.slice(0, index); connection.buffer = connection.buffer.slice(index + 1);
          if (!line.trim()) continue;
          if (Buffer.byteLength(line) > MAXIMUM_LINE_BYTES) throw new Error("Native record exceeds its limit.");
          const native: unknown = isolateExecutorCapabilities(JSON.parse(line));
          const assertResponse = this.#responseOwner(connection, native); assertResponse();
          this.#observeProcess(connection, native);
          const data = JSON.stringify(this.#options.identityPaths ? native : mapExecServerResult(native, this.#options.workspace));
          const bytes = Buffer.byteLength(JSON.stringify(data));
          if (connection.bytes + bytes > MAXIMUM_PENDING_BYTES) throw new Error("Native output exceeds its limit.");
          connection.messages.push({ data, assertCurrent: assertResponse }); connection.bytes += bytes; connection.wake?.();
        }
        if (Buffer.byteLength(connection.buffer) > MAXIMUM_LINE_BYTES) throw new Error("Native record exceeds its limit.");
      } catch { void this.#drop(connection).catch(() => undefined); }
    });
    if (!this.#options.openProcess) await new Promise<void>((resolve, reject) => {
      const local = child as ChildProcessWithoutNullStreams;
      const failed = () => { local.removeListener("spawn", ready); reject(new HostedAgentExecutorError("EXECUTOR_FAILED")); };
      const ready = () => { local.removeListener("error", failed); resolve(); };
      local.once("spawn", ready); local.once("error", failed);
    });
    try { assert(); this.#assert(authorization); signal.throwIfAborted(); }
    catch (error) { await this.#drop(connection); throw error; }
  }
  async #deliver(connection: Connection, data: string, signal: AbortSignal, authorization: HostedAgentCodexAuthorization): Promise<void> {
    const active = AbortSignal.any([signal, this.#lifetime.signal, connection.lifetime.signal]);
    this.#assert(authorization); active.throwIfAborted();
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(data);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      message = parsed as Record<string, unknown>;
    } catch { throw new HostedAgentExecutorError("INVALID_REQUEST"); }
    if (message.id !== undefined && typeof message.id !== "string" && typeof message.id !== "number") throw new HostedAgentExecutorError("INVALID_REQUEST");
    if (message.method === undefined) { await this.#deliverServerResponse(connection, message, active, authorization); return; }
    if (typeof message.method !== "string" || !message.method || message.method.length > 128) throw new HostedAgentExecutorError("INVALID_REQUEST");
    const method = message.method;
    if (message.id !== undefined) {
      const key = typeof message.id + ":" + String(message.id);
      if (connection.observed.has(key) || connection.observed.size >= 65_536) throw new HostedAgentExecutorError("REQUEST_REPLAYED");
      connection.observed.add(key);
    }
    if (!this.#options.identityPaths) message.params = mapExecServerParams(message.params, this.#options.workspace, method, false);
    const params = message.params && typeof message.params === "object" && !Array.isArray(message.params) ? message.params as Record<string, unknown> : {};
    const handleId = typeof params.handleId === "string" && params.handleId.length > 0 && params.handleId.length <= 512 ? params.handleId : undefined;
    if (["fs/open", "fs/readBlock", "fs/close"].includes(method) && !handleId) throw new HostedAgentExecutorError("INVALID_REQUEST");
    if (method === "fs/open" && (connection.files.has(handleId!) || connection.files.size >= 1024)) throw new HostedAgentExecutorError("RESOURCE_EXHAUSTED");
    const file = handleId ? connection.files.get(handleId) : undefined;
    if (["fs/readBlock", "fs/close"].includes(method) && !file) throw new HostedAgentExecutorError("INVALID_REQUEST");
    if (method === "fs/readBlock") file!.assertCurrent();
    if (["process/read", "process/write", "process/signal", "process/terminate"].includes(method)) {
      const processId = typeof params.processId === "string" ? params.processId : "";
      const owner = connection.processOwners.get(processId);
      if (!owner) throw new HostedAgentExecutorError("INVALID_REQUEST");
      // A running shell is not a connection-wide grant to feed a later turn.
      // Exact termination remains available for cleanup after owner retirement.
      if (method === "process/read" || method === "process/write") owner();
    }
    const actions = method === "fs/readBlock" ? [{ kind: "read" as const, path: file!.path }]
      : execServerActions(method, message.params, this.#options.cwd, this.#options.pathStyle);
    let assert: () => void;
    try {
      // MCP declarations and secrets come from the explicit product catalog,
      // never another machine's ambient Codex configuration or environment.
      if (method === "environmentConfig/read" || method === "http/request" && Array.isArray(params.headers)
        && params.headers.some(header => header !== null && typeof header === "object" && "valueEnvVar" in header && header.valueEnvVar != null)) {
        throw new HostedAgentExecutorError("ACCESS_DENIED");
      }
      if (method === "http/request") {
        const url = new URL(String(params.url));
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new HostedAgentExecutorError("ACCESS_DENIED");
        params.redirectPolicy = "stop";
      }
      assert = await authorization.authorize(actions, active);
    }
    catch {
      this.#assert(authorization); active.throwIfAborted();
      if (message.id !== undefined) {
        const rejected = JSON.stringify({ id: message.id, error: { code: -32001, message: "Not allowed in this workspace." } });
        connection.messages.push({ data: rejected, assertCurrent: authorization.assertCurrent }); connection.bytes += Buffer.byteLength(JSON.stringify(rejected)); connection.wake?.();
      }
      return;
    }
    if (authorization.prepareParams) {
      try { message.params = await authorization.prepareParams(method, message.params, actions, active); assert(); this.#assert(authorization); active.throwIfAborted(); }
      catch {
        this.#assert(authorization); active.throwIfAborted();
        if (message.id !== undefined) {
          const data = JSON.stringify({ id: message.id, error: { code: -32001, message: "This file operation cannot enforce the current policy in this environment." } });
          connection.messages.push({ data, assertCurrent: authorization.assertCurrent }); connection.bytes += Buffer.byteLength(JSON.stringify(data)); connection.wake?.();
        }
        return;
      }
    }
    // File payload reversal may read the old content. It belongs after approval.
    if (!this.#options.identityPaths) message.params = mapExecServerFileData(message.params, this.#options.workspace, method);
    const line = Buffer.from(JSON.stringify(message) + "\n");
    if (line.byteLength > MAXIMUM_LINE_BYTES) throw new HostedAgentExecutorError("RESOURCE_EXHAUSTED");
    let commandId: string | undefined, processId: string | undefined;
    if (method === "process/start") {
      const params = message.params as Record<string, unknown> | undefined;
      if (!params || typeof params.processId !== "string" || !params.processId || params.processId.length > 512
        || connection.commands.has(params.processId)) throw new HostedAgentExecutorError("INVALID_REQUEST");
      processId = params.processId; commandId = "hosted-native:" + this.#options.sessionId + ":" + randomUUID();
      const gate = this.#options.commandConcurrencyGate;
      if (gate && await gate.acquire({ commandId, sessionId: this.#options.sessionId, signal: active }) === "aborted") {
        throw new HostedAgentExecutorError("STALE_AUTHORITY");
      }
    }
    try {
      assert(); this.#assert(authorization); active.throwIfAborted();
      if (method === "fs/open") {
        const read = actions.find(action => action.kind === "read");
        if (!read || read.kind !== "read" || message.id === undefined) throw new HostedAgentExecutorError("INVALID_REQUEST");
        connection.files.set(handleId!, { path: read.path, assertCurrent: () => { assert(); this.#assert(authorization); } });
        connection.openingFiles.set(typeof message.id + ":" + String(message.id), handleId!);
      }
      if (method === "fs/close") connection.files.delete(handleId!);
      if (method === "http/request" && typeof params.requestId === "string" && params.streamResponse === true) {
        if (connection.networkOwners.has(params.requestId) || connection.networkOwners.size >= 1024) throw new HostedAgentExecutorError("RESOURCE_EXHAUSTED");
        connection.networkOwners.set(params.requestId, () => { assert(); this.#assert(authorization); });
      }
      if (processId && commandId) {
        connection.commands.set(processId, commandId);
        connection.processOwners.set(processId, () => { assert(); this.#assert(authorization); });
        if (message.id !== undefined) connection.starts.set(typeof message.id + ":" + String(message.id), processId);
      }
      if (message.id !== undefined) connection.responses.set(typeof message.id + ":" + String(message.id), () => { assert(); this.#assert(authorization); });
      await new Promise<void>((resolve, reject) => connection.child.stdin.write(line, error => error ? reject(error) : resolve()));
    } catch (error) {
      if (commandId && processId && !connection.commands.has(processId)) this.#options.commandConcurrencyGate?.release(commandId, "native_not_dispatched");
      else if (commandId) await this.#drop(connection);
      throw error;
    }
  }
  async #poll(connection: Connection, signal: AbortSignal, authorization: HostedAgentCodexAuthorization): Promise<Record<string, unknown>> {
    if (connection.polling) throw new HostedAgentExecutorError("INVALID_REQUEST");
    connection.polling = true;
    try {
      if (!connection.messages.length && !connection.closed) await new Promise<void>((resolve, reject) => {
        const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", aborted); if (connection.wake === finish) connection.wake = undefined; resolve(); };
        const aborted = () => { finish(); reject(new HostedAgentExecutorError("STALE_AUTHORITY")); };
        const timer = setTimeout(finish, 25_000); connection.wake = finish;
        signal.addEventListener("abort", aborted, { once: true }); if (signal.aborted) aborted();
      });
      this.#assert(authorization); signal.throwIfAborted();
      for (const message of connection.messages) message.assertCurrent();
      const messages = connection.messages.splice(0).map(message => message.data); connection.bytes = 0;
      return { messages, closed: connection.closed };
    } finally { connection.polling = false; }
  }
  async #deliverServerResponse(connection: Connection, message: Record<string, unknown>, signal: AbortSignal, authorization: HostedAgentCodexAuthorization): Promise<void> {
    const key = typeof message.id + ":" + String(message.id), request = connection.serverRequests.get(key);
    if (!request || message.id === undefined || (message.result === undefined) === (message.error === undefined)
      || Object.keys(message).some(key => !["jsonrpc", "id", "result", "error"].includes(key))) throw new HostedAgentExecutorError("INVALID_REQUEST");
    connection.serverRequests.delete(key); request.assertCurrent();
    let assert = request.assertCurrent;
    const decision = message.result && typeof message.result === "object" && !Array.isArray(message.result)
      ? (message.result as Record<string, unknown>).decision : undefined;
    if (decision && typeof decision === "object" && !Array.isArray(decision) && (decision as Record<string, unknown>).type === "allow") {
      try { assert = await authorization.authorize([request.action], signal); }
      catch {
        request.assertCurrent(); this.#assert(authorization); signal.throwIfAborted();
        message = { id: message.id, result: { decision: { type: "deny", reason: "Not allowed in this workspace." } } };
      }
    }
    assert(); request.assertCurrent(); this.#assert(authorization); signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => connection.child.stdin.write(JSON.stringify(message) + "\n", error => error ? reject(error) : resolve()));
  }
  #assert(authorization: HostedAgentCodexAuthorization): void {
    try { this.#lifetime.signal.throwIfAborted(); this.#options.assertCurrent(); authorization.assertCurrent(); }
    catch { throw new HostedAgentExecutorError("STALE_AUTHORITY"); }
  }
  async #drop(connection: Connection): Promise<void> {
    connection.closed = true; connection.lifetime.abort(); connection.wake?.();
    if (connection.child.exitCode !== null || connection.child.signalCode !== null) { this.#releaseCommands(connection); return; }
    connection.child.stdin.end(); connection.child.kill();
    if (connection.child.exitCode !== null || connection.child.signalCode !== null) { this.#releaseCommands(connection); return; }
    let timeout: NodeJS.Timeout | undefined;
    try { await Promise.race([connection.exited, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Native executor cleanup is unconfirmed.")), 3_000); })]); }
    finally { if (timeout) clearTimeout(timeout); }
  }
  #observeProcess(connection: Connection, value: unknown): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const message = value as Record<string, unknown>;
    if (message.method === undefined && message.id !== undefined) {
      const key = typeof message.id + ":" + String(message.id), processId = connection.starts.get(key);
      if (processId) { connection.starts.delete(key); if (message.error !== undefined) this.#releaseCommand(connection, processId); }
      const handleId = connection.openingFiles.get(key);
      if (handleId) { connection.openingFiles.delete(key); if (message.error !== undefined) connection.files.delete(handleId); }
    }
    if (message.method === "process/closed" && message.params && typeof message.params === "object" && !Array.isArray(message.params)) {
      const processId = (message.params as Record<string, unknown>).processId;
      if (typeof processId === "string") this.#releaseCommand(connection, processId);
    }
  }
  #responseOwner(connection: Connection, value: unknown): () => void {
    if (!value || typeof value !== "object" || Array.isArray(value)) return this.#options.assertCurrent;
    const message = value as Record<string, unknown>;
    if (message.method === "network/policyRequest") {
      const params = message.params && typeof message.params === "object" ? message.params as Record<string, unknown> : {};
      const owner = typeof params.processId === "string" ? connection.processOwners.get(params.processId) : undefined;
      const network = params.request && typeof params.request === "object" ? params.request as Record<string, unknown> : {};
      if (!owner || message.id === undefined || typeof network.host !== "string" || !network.host || /[\s/@?#\\]/u.test(network.host)
        || !Number.isInteger(network.port) || Number(network.port) < 1 || Number(network.port) > 65535) throw new HostedAgentExecutorError("INVALID_REQUEST");
      const key = typeof message.id + ":" + String(message.id);
      if (connection.serverRequests.has(key) || connection.serverRequests.size >= 1024) throw new HostedAgentExecutorError("RESOURCE_EXHAUSTED");
      const host = network.host.includes(":") && !network.host.startsWith("[") ? `[${network.host}]` : network.host;
      connection.serverRequests.set(key, { assertCurrent: owner, action: { kind: "network", method: "CONNECT",
        url: `${network.protocol === "http" ? "http" : "https"}://${host}:${String(network.port)}` } });
      return owner;
    }
    if (message.method === undefined && message.id !== undefined) {
      const key = typeof message.id + ":" + String(message.id), assert = connection.responses.get(key);
      connection.responses.delete(key);
      if (assert) return assert;
    }
    const params = message.params;
    if (params && typeof params === "object" && !Array.isArray(params)) {
      const requestId = (params as Record<string, unknown>).requestId;
      if (message.method === "http/request/bodyDelta" && typeof requestId === "string") {
        const assert = connection.networkOwners.get(requestId);
        if ((params as Record<string, unknown>).done === true) connection.networkOwners.delete(requestId);
        if (assert) return assert;
        throw new HostedAgentExecutorError("INVALID_REQUEST");
      }
      const processId = (params as Record<string, unknown>).processId;
      if (typeof processId === "string") return connection.processOwners.get(processId) ?? this.#options.assertCurrent;
    }
    return this.#options.assertCurrent;
  }
  #releaseCommand(connection: Connection, processId: string): void {
    const commandId = connection.commands.get(processId); if (!commandId) return;
    connection.commands.delete(processId); connection.processOwners.delete(processId); this.#options.commandConcurrencyGate?.release(commandId, "native_process_closed");
  }
  #releaseCommands(connection: Connection): void {
    for (const processId of connection.commands.keys()) this.#releaseCommand(connection, processId);
    connection.starts.clear(); connection.responses.clear(); connection.processOwners.clear(); connection.files.clear(); connection.openingFiles.clear(); connection.networkOwners.clear(); connection.serverRequests.clear();
  }
  close(): Promise<void> {
    if (this.#close) return this.#close;
    const flight = (async () => {
      this.#lifetime.abort(); await Promise.allSettled([...this.#openFlights]);
      await Promise.all([...this.#connections.values()].map(connection => this.#drop(connection)));
      this.#connections.clear(); this.#seen.clear();
    })();
    this.#close = flight;
    void flight.catch(() => { if (this.#close === flight) this.#close = undefined; });
    return flight;
  }
}

function isolateExecutorCapabilities(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const message = value as Record<string, unknown>, result = message.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) return value;
  const record = result as Record<string, unknown>;
  const info = record.environmentInfo ?? record;
  if (!info || typeof info !== "object" || Array.isArray(info) || !("capabilities" in info)) return value;
  const environment = info as Record<string, unknown>, capabilities = environment.capabilities;
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) return value;
  const safe = { ...environment, capabilities: { ...capabilities as Record<string, unknown>, environmentConfigRead: false, httpHeaderEnvVars: false } };
  return { ...message, result: record.environmentInfo === undefined ? safe : { ...record, environmentInfo: safe } };
}

function parseRequest(value: unknown): { requestId: string; payload: { kind: "open" | "message" | "poll" | "close"; connectionId: string; data?: string } } {
  const invalid = () => new HostedAgentExecutorError("INVALID_REQUEST");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const request = value as Record<string, unknown>;
  if (request.format !== 1 || request.operation !== "codex.exec_server" || typeof request.callId !== "string"
    || typeof request.requestId !== "string" || !/^[A-Za-z0-9_-]{1,160}$/u.test(request.requestId)
    || Object.keys(request).some(key => !["format", "callId", "requestId", "operation", "payload"].includes(key))
    || !request.payload || typeof request.payload !== "object" || Array.isArray(request.payload)) throw invalid();
  const payload = request.payload as Record<string, unknown>;
  if (!["open", "message", "poll", "close"].includes(String(payload.kind)) || typeof payload.connectionId !== "string"
    || !/^[A-Za-z0-9_-]{1,160}$/u.test(payload.connectionId) || payload.connectionId !== request.callId
    || Object.keys(payload).some(key => !["kind", "connectionId", "data"].includes(key))
    || (payload.kind === "message" ? typeof payload.data !== "string" || Buffer.byteLength(payload.data) > MAXIMUM_LINE_BYTES : payload.data !== undefined)) throw invalid();
  return { requestId: request.requestId, payload: payload as { kind: "open" | "message" | "poll" | "close"; connectionId: string; data?: string } };
}
