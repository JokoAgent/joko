import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { randomUUID } from "node:crypto";
import type { CommandConcurrencyGate } from "@joko/runtime-governance";
import type { ExecutorWorkspace } from "./hosted-agent-workspace.js";
import { HostedAgentExecutorError } from "./hosted-agent-executor.js";
import { execServerActions, mapExecServerParams, mapExecServerResult, type HostedAgentCodexAction } from "./hosted-agent-codex-mapping.js";
export type { HostedAgentCodexAction } from "./hosted-agent-codex-mapping.js";

const MAXIMUM_LINE_BYTES = 48 * 1024 * 1024;
const MAXIMUM_PENDING_BYTES = 64 * 1024 * 1024;
const MAXIMUM_CONNECTIONS = 16;
export interface HostedAgentCodexAuthorization {
  readonly assertCurrent: () => void;
  readonly authorize: (actions: readonly HostedAgentCodexAction[], signal: AbortSignal) => Promise<() => void>;
}
export interface HostedAgentCodexRelayOptions extends HostedAgentCodexAuthorization {
  readonly codexExecutable: string;
  readonly cwd: string;
  readonly workspace: ExecutorWorkspace;
  /** Source-owned native tool environment. No Model Host credential is accepted. */
  readonly env?: NodeJS.ProcessEnv;
  readonly commandConcurrencyGate?: CommandConcurrencyGate;
  readonly sessionId: string;
}
interface Connection {
  readonly child: ChildProcessWithoutNullStreams;
  readonly lifetime: AbortController;
  readonly decoder: StringDecoder;
  readonly messages: string[];
  readonly observed: Set<string>;
  readonly commands: Map<string, string>;
  readonly starts: Map<string, string>;
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
    if (kind === "open") { await this.#open(connectionId, signal, authorization); return {}; }
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
    const child = spawn(this.#options.codexExecutable, ["exec-server", "--listen", "stdio://"], {
      cwd: this.#options.cwd, env: this.#options.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true
    });
    let resolveExit!: () => void;
    const exited = new Promise<void>(resolve => { resolveExit = resolve; });
    const connection: Connection = { child, lifetime: new AbortController(), decoder: new StringDecoder("utf8"), messages: [],
      observed: new Set(), commands: new Map(), starts: new Map(), exited, buffer: "", bytes: 0, closed: false, polling: false, tail: Promise.resolve() };
    this.#connections.set(id, connection);
    const finish = () => { connection.closed = true; connection.lifetime.abort(); this.#releaseCommands(connection); connection.wake?.(); resolveExit(); };
    child.once("exit", finish);
    child.once("error", () => { if (child.pid === undefined) finish(); else void this.#drop(connection).catch(() => undefined); });
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
          const native: unknown = JSON.parse(line); this.#observeProcess(connection, native);
          const data = JSON.stringify(mapExecServerResult(native, this.#options.workspace));
          const bytes = Buffer.byteLength(JSON.stringify(data));
          if (connection.bytes + bytes > MAXIMUM_PENDING_BYTES) throw new Error("Native output exceeds its limit.");
          connection.messages.push(data); connection.bytes += bytes; connection.wake?.();
        }
        if (Buffer.byteLength(connection.buffer) > MAXIMUM_LINE_BYTES) throw new Error("Native record exceeds its limit.");
      } catch { void this.#drop(connection).catch(() => undefined); }
    });
    await new Promise<void>((resolve, reject) => {
      const failed = () => { child.removeListener("spawn", ready); reject(new HostedAgentExecutorError("EXECUTOR_FAILED")); };
      const ready = () => { child.removeListener("error", failed); resolve(); };
      child.once("spawn", ready); child.once("error", failed);
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
    if (typeof message.method !== "string" || !message.method || message.method.length > 128
      || message.id !== undefined && typeof message.id !== "string" && typeof message.id !== "number") throw new HostedAgentExecutorError("INVALID_REQUEST");
    const method = message.method;
    if (message.id !== undefined) {
      const key = typeof message.id + ":" + String(message.id);
      if (connection.observed.has(key) || connection.observed.size >= 65_536) throw new HostedAgentExecutorError("REQUEST_REPLAYED");
      connection.observed.add(key);
    }
    message.params = mapExecServerParams(message.params, this.#options.workspace, method, false);
    const actions = execServerActions(method, message.params, this.#options.cwd);
    let assert: () => void;
    try { assert = await authorization.authorize(actions, active); }
    catch {
      this.#assert(authorization); active.throwIfAborted();
      if (message.id !== undefined) {
        const rejected = JSON.stringify({ id: message.id, error: { code: -32001, message: "Not allowed in this workspace." } });
        connection.messages.push(rejected); connection.bytes += Buffer.byteLength(JSON.stringify(rejected)); connection.wake?.();
      }
      return;
    }
    // File payload reversal may read the old content. It belongs after approval.
    message.params = mapExecServerParams(message.params, this.#options.workspace, method);
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
      if (processId && commandId) {
        connection.commands.set(processId, commandId);
        if (message.id !== undefined) connection.starts.set(typeof message.id + ":" + String(message.id), processId);
      }
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
      const messages = connection.messages.splice(0); connection.bytes = 0;
      return { messages, closed: connection.closed };
    } finally { connection.polling = false; }
  }
  #assert(authorization: HostedAgentCodexAuthorization): void {
    try { this.#lifetime.signal.throwIfAborted(); this.#options.assertCurrent(); authorization.assertCurrent(); }
    catch { throw new HostedAgentExecutorError("STALE_AUTHORITY"); }
  }
  async #drop(connection: Connection): Promise<void> {
    connection.closed = true; connection.lifetime.abort(); connection.wake?.();
    connection.child.stdin.end(); connection.child.kill();
    if (connection.child.exitCode !== null || connection.child.signalCode !== null) { this.#releaseCommands(connection); return; }
    let timeout: NodeJS.Timeout | undefined;
    try { await Promise.race([connection.exited, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Native executor cleanup is unconfirmed.")), 3_000); })]); }
    finally { if (timeout) clearTimeout(timeout); }
  }
  #observeProcess(connection: Connection, value: unknown): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const message = value as Record<string, unknown>;
    if (message.id !== undefined) {
      const key = typeof message.id + ":" + String(message.id), processId = connection.starts.get(key);
      if (processId) { connection.starts.delete(key); if (message.error !== undefined) this.#releaseCommand(connection, processId); }
    }
    if (message.method === "process/closed" && message.params && typeof message.params === "object" && !Array.isArray(message.params)) {
      const processId = (message.params as Record<string, unknown>).processId;
      if (typeof processId === "string") this.#releaseCommand(connection, processId);
    }
  }
  #releaseCommand(connection: Connection, processId: string): void {
    const commandId = connection.commands.get(processId); if (!commandId) return;
    connection.commands.delete(processId); this.#options.commandConcurrencyGate?.release(commandId, "native_process_closed");
  }
  #releaseCommands(connection: Connection): void {
    for (const processId of connection.commands.keys()) this.#releaseCommand(connection, processId);
    connection.starts.clear();
  }
  close(): Promise<void> {
    if (this.#close) return this.#close;
    const flight = (async () => {
      this.#lifetime.abort(); await Promise.all([...this.#connections.values()].map(connection => this.#drop(connection)));
      this.#connections.clear(); this.#seen.clear();
    })();
    this.#close = flight;
    void flight.catch(() => { if (this.#close === flight) this.#close = undefined; });
    return flight;
  }
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
