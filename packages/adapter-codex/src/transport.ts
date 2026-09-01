import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { Buffer } from "node:buffer";
import {
  createChildRuntimeEnvironment,
  DurableProcessOwner,
  type DurableProcessLease,
  type DurableProcessOwnerOptions
} from "@joko/runtime-governance";
import {
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type RpcId,
  type RpcNotification,
  type RpcServerRequest
} from "./protocol.js";
import { RpcRemoteFault, TransportFault } from "./errors.js";

export interface RpcTransportHandlers {
  readonly onNotification: (notification: RpcNotification) => void | Promise<void>;
  readonly onRequest: (request: RpcServerRequest) => void | Promise<void>;
  readonly onExit: (fault: TransportFault) => void | Promise<void>;
}

export interface RpcRequestOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** A write may have reached the app-server before a timeout or disconnect. */
  readonly mutation?: boolean;
}

export interface RpcTransport {
  readonly running: boolean;
  start(handlers: RpcTransportHandlers): Promise<void>;
  request(method: string, params: JsonValue | undefined, options?: RpcRequestOptions): Promise<JsonValue>;
  notify(method: string, params?: JsonValue): Promise<void>;
  respond(id: RpcId, result: JsonValue): Promise<void>;
  respondError(id: RpcId, code: number, message: string): Promise<void>;
  /** Hard stop for an already-fenced transport generation. */
  forceClose?(): Promise<void>;
  close(): Promise<void>;
}

export interface StdioJsonRpcTransportOptions {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly requestTimeoutMs?: number;
  readonly maxLineBytes?: number;
  readonly maxBufferedBytes?: number;
  readonly maxOutboundBytes?: number;
  readonly maxInboundHandlerEntries?: number;
  readonly maxInboundHandlerBytes?: number;
  readonly tombstoneTtlMs?: number;
  readonly maxTombstones?: number;
  readonly shutdownTimeoutMs?: number;
  /** Adapter-private crash recovery authority for the exact local child. */
  readonly processOwner?: DurableProcessOwnerOptions;
}

interface PendingRequest {
  readonly method: string;
  readonly mutation: boolean;
  readonly resolve: (value: JsonValue) => void;
  readonly reject: (error: unknown) => void;
  readonly timer: NodeJS.Timeout;
  readonly abortCleanup?: () => void;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_BUFFERED_BYTES = 20 * 1024 * 1024;
const DEFAULT_TOMBSTONE_TTL_MS = 120_000;
const DEFAULT_MAX_TOMBSTONES = 2_048;
const CODEX_RUNTIME_ENVIRONMENT_KEYS = Object.freeze([
  "CODEX_HOME",
  "CODEX_API_KEY",
  "CODEX_PROFILE",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORGANIZATION",
  "OPENAI_ORG_ID",
  "OPENAI_PROJECT",
  "OPENAI_PROJECT_ID"
] as const);

export class StdioJsonRpcTransport implements RpcTransport {
  readonly #options: Required<Pick<
    StdioJsonRpcTransportOptions,
    "requestTimeoutMs" | "maxLineBytes" | "maxBufferedBytes" | "maxOutboundBytes" | "maxInboundHandlerEntries" | "maxInboundHandlerBytes" | "tombstoneTtlMs" | "maxTombstones" | "shutdownTimeoutMs"
  >> & StdioJsonRpcTransportOptions;
  readonly #processOwner: DurableProcessOwner | undefined;
  #child: ChildProcessWithoutNullStreams | undefined;
  #handlers: RpcTransportHandlers | undefined;
  #buffer = Buffer.alloc(0);
  #nextRequestId = 1;
  #pending = new Map<string, PendingRequest>();
  #tombstones = new Map<string, number>();
  #writeTail: Promise<void> = Promise.resolve();
  #inboundTail: Promise<void> = Promise.resolve();
  #inboundHandlerEntries = 0;
  #inboundHandlerBytes = 0;
  #fatal = false;
  #closing = false;
  #closingChild: ChildProcessWithoutNullStreams | undefined;
  #processLease: DurableProcessLease | undefined;
  #exitDelivered = false;

  constructor(options: StdioJsonRpcTransportOptions = {}) {
    this.#options = {
      ...options,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      maxLineBytes: options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES,
      maxBufferedBytes: options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES,
      maxOutboundBytes: options.maxOutboundBytes ?? DEFAULT_MAX_LINE_BYTES,
      maxInboundHandlerEntries: options.maxInboundHandlerEntries ?? 2_048,
      maxInboundHandlerBytes: options.maxInboundHandlerBytes ?? DEFAULT_MAX_BUFFERED_BYTES,
      tombstoneTtlMs: options.tombstoneTtlMs ?? DEFAULT_TOMBSTONE_TTL_MS,
      maxTombstones: options.maxTombstones ?? DEFAULT_MAX_TOMBSTONES,
      shutdownTimeoutMs: options.shutdownTimeoutMs ?? 2_000
    };
    this.#processOwner = options.processOwner === undefined
      ? undefined
      : new DurableProcessOwner(options.processOwner);
    if (!positiveInteger(this.#options.requestTimeoutMs)
      || !positiveInteger(this.#options.maxLineBytes)
      || !positiveInteger(this.#options.maxBufferedBytes)
      || this.#options.maxBufferedBytes < this.#options.maxLineBytes) {
      throw new TypeError("Invalid Codex JSONL input bounds.");
    }
    if (!positiveInteger(this.#options.maxOutboundBytes)
      || !positiveInteger(this.#options.maxTombstones)
      || !positiveInteger(this.#options.maxInboundHandlerEntries)
      || !positiveInteger(this.#options.maxInboundHandlerBytes)
      || this.#options.maxInboundHandlerBytes < this.#options.maxLineBytes
      || !positiveInteger(this.#options.tombstoneTtlMs)
      || !positiveInteger(this.#options.shutdownTimeoutMs)) {
      throw new TypeError("Invalid Codex JSON-RPC transport bounds.");
    }
  }

  get running(): boolean {
    return this.#child !== undefined && !this.#fatal && !this.#closing;
  }

  async start(handlers: RpcTransportHandlers): Promise<void> {
    if (this.#child !== undefined || this.#handlers !== undefined) {
      throw new TransportFault("closed", "The Codex transport cannot be started twice.");
    }
    this.#handlers = handlers;
    await this.#processOwner?.prepare(this.#options.shutdownTimeoutMs);
    const command = this.#options.command ?? "codex";
    const args = [...(this.#options.args ?? ["app-server", "--stdio"])];
    const environment = this.#options.env ?? createChildRuntimeEnvironment({
      allowedKeys: CODEX_RUNTIME_ENVIRONMENT_KEYS
    }).environment;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, args, {
        cwd: this.#options.cwd,
        env: environment,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch {
      throw new TransportFault("spawn_failed", "The Codex app-server process could not be started.");
    }
    this.#child = child;
    child.stdout.on("data", (chunk: Buffer | string) => this.#acceptChunk(chunk));
    // stderr may contain environment-specific paths, prompts, or credentials.
    // Drain it to avoid child backpressure but never retain or surface it.
    child.stderr.on("data", () => undefined);
    child.on("error", () => {
      this.#fail(new TransportFault("spawn_failed", "The Codex app-server process could not be started."));
    });
    child.on("exit", () => {
      const lease = this.#processLease;
      if (lease !== undefined) void this.#processOwner?.releaseAfterExit(lease).catch(() => undefined);
      if (this.#closing) return;
      this.#fail(new TransportFault(
        "process_exited",
        "The Codex app-server process exited before shutdown completed.",
        { stateMayHaveChanged: true }
      ));
    });
    if (child.pid === undefined) throw new TransportFault("spawn_failed", "The Codex app-server process has no PID.");
    try {
      this.#processLease = this.#processOwner?.claimSync(child.pid);
    } catch {
      try { child.kill("SIGKILL"); } catch { /* The child may already have exited. */ }
      throw new TransportFault("spawn_failed", "The Codex app-server process owner could not be established.");
    }
  }

  request(method: string, params: JsonValue | undefined, options: RpcRequestOptions = {}): Promise<JsonValue> {
    const child = this.#requireChild();
    if (options.signal?.aborted === true) {
      return Promise.reject(new TransportFault("closed", "The Codex request was cancelled before dispatch."));
    }
    const id = this.#nextRequestId++;
    const key = String(id);
    const timeoutMs = options.timeoutMs ?? this.#options.requestTimeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      return Promise.reject(new TypeError("Codex request timeout must be a positive integer."));
    }
    const envelope: JsonObject = {
      method,
      id,
      ...(params === undefined ? {} : { params })
    };
    return new Promise<JsonValue>((resolve, reject) => {
      const finishCancelled = (): void => {
        const pending = this.#pending.get(key);
        if (pending === undefined) return;
        clearTimeout(pending.timer);
        pending.abortCleanup?.();
        this.#pending.delete(key);
        this.#addTombstone(key);
        reject(new TransportFault(
          "closed",
          "The Codex request wait was cancelled.",
          { stateMayHaveChanged: pending.mutation }
        ));
      };
      const timer = setTimeout(() => {
        const pending = this.#pending.get(key);
        if (pending === undefined) return;
        pending.abortCleanup?.();
        this.#pending.delete(key);
        this.#addTombstone(key);
        reject(new TransportFault(
          "request_timeout",
          "The Codex app-server request timed out.",
          { stateMayHaveChanged: pending.mutation }
        ));
      }, timeoutMs);
      timer.unref?.();
      const abortCleanup = options.signal === undefined
        ? undefined
        : () => options.signal?.removeEventListener("abort", finishCancelled);
      options.signal?.addEventListener("abort", finishCancelled, { once: true });
      this.#pending.set(key, {
        method,
        mutation: options.mutation ?? false,
        resolve,
        reject,
        timer,
        ...(abortCleanup === undefined ? {} : { abortCleanup })
      });
      this.#enqueueWrite(child, envelope).catch((error: unknown) => {
        const pending = this.#pending.get(key);
        if (pending === undefined) return;
        clearTimeout(pending.timer);
        pending.abortCleanup?.();
        this.#pending.delete(key);
        const fault = error instanceof TransportFault
          ? error
          : new TransportFault(
              "write_failed",
              "The Codex app-server request could not be written.",
              { stateMayHaveChanged: pending.mutation }
            );
        if (fault.stateMayHaveChanged) this.#addTombstone(key);
        reject(fault);
      });
    });
  }

  notify(method: string, params?: JsonValue): Promise<void> {
    return this.#enqueueWrite(this.#requireChild(), {
      method,
      ...(params === undefined ? {} : { params })
    });
  }

  respond(id: RpcId, result: JsonValue): Promise<void> {
    return this.#enqueueWrite(this.#requireChild(), { id, result });
  }

  respondError(id: RpcId, code: number, message: string): Promise<void> {
    return this.#enqueueWrite(this.#requireChild(), {
      id,
      error: { code, message }
    });
  }

  async close(): Promise<void> {
    const child = this.#beginClose(false);
    if (child === undefined) return;
    child.stdin.end();
    if (child.exitCode !== null || child.signalCode !== null) {
      if (this.#closingChild === child) this.#closingChild = undefined;
      await this.#releaseProcessOwner(child);
      return;
    }
    if (await childExitBefore(child, this.#options.shutdownTimeoutMs)) {
      if (this.#closingChild === child) this.#closingChild = undefined;
      await this.#releaseProcessOwner(child);
      return;
    }
    try {
      child.kill("SIGTERM");
    } catch {
      // The exit observation below remains authoritative.
    }
    if (await childExitBefore(child, this.#options.shutdownTimeoutMs)) {
      if (this.#closingChild === child) this.#closingChild = undefined;
      await this.#releaseProcessOwner(child);
      return;
    }
    await this.#hardStopChild(child);
  }

  async forceClose(): Promise<void> {
    const child = this.#beginClose(true);
    if (child === undefined) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      if (this.#closingChild === child) this.#closingChild = undefined;
      await this.#releaseProcessOwner(child);
      return;
    }
    await this.#hardStopChild(child);
  }

  #beginClose(force: boolean): ChildProcessWithoutNullStreams | undefined {
    if (this.#closing) return force ? this.#closingChild : undefined;
    this.#closing = true;
    const child = this.#child;
    this.#child = undefined;
    this.#closingChild = child;
    this.#rejectPending(new TransportFault("closed", "The Codex transport was closed."));
    this.#buffer = Buffer.alloc(0);
    return child;
  }

  async #hardStopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
    const lease = this.#processLease;
    if (this.#processOwner !== undefined && lease !== undefined && lease.pid === child.pid) {
      await this.#processOwner.retireLease(lease, this.#options.shutdownTimeoutMs);
      await childExitBefore(child, this.#options.shutdownTimeoutMs);
      if (this.#closingChild === child) this.#closingChild = undefined;
      if (this.#processLease === lease) this.#processLease = undefined;
      return;
    }
    try {
      child.kill("SIGKILL");
    } catch {
      // A concurrent exit is accepted only after the handle confirms it.
    }
    if (await childExitBefore(child, this.#options.shutdownTimeoutMs)) {
      if (this.#closingChild === child) this.#closingChild = undefined;
      await this.#releaseProcessOwner(child);
      return;
    }
    throw new TransportFault(
      "shutdown_unconfirmed",
      "The Codex app-server process did not confirm exit after hard retirement.",
      { stateMayHaveChanged: true }
    );
  }

  async #releaseProcessOwner(child: ChildProcessWithoutNullStreams): Promise<void> {
    const lease = this.#processLease;
    if (lease === undefined || child.pid !== lease.pid) return;
    await this.#processOwner?.releaseAfterExit(lease);
    if (this.#processLease === lease) this.#processLease = undefined;
  }

  #requireChild(): ChildProcessWithoutNullStreams {
    if (!this.running || this.#child === undefined) {
      throw new TransportFault("not_started", "The Codex app-server transport is not running.");
    }
    return this.#child;
  }

  #enqueueWrite(child: ChildProcessWithoutNullStreams, envelope: JsonObject): Promise<void> {
    let bytes: Buffer;
    try {
      bytes = Buffer.from(`${JSON.stringify(envelope)}\n`, "utf8");
    } catch {
      return Promise.reject(new TransportFault("protocol_violation", "A Codex JSON-RPC request could not be encoded."));
    }
    if (bytes.byteLength > this.#options.maxOutboundBytes) {
      return Promise.reject(new TransportFault("buffer_overflow", "A Codex JSON-RPC request exceeded the configured byte limit."));
    }
    const write = this.#writeTail.then(async () => {
      if (child !== this.#child || !this.running) throw new TransportFault("closed", "The Codex transport was closed before write.");
      if (child.stdin.write(bytes)) return;
      await once(child.stdin, "drain");
    });
    this.#writeTail = write.catch(() => undefined);
    return write;
  }

  #acceptChunk(chunk: Buffer | string): void {
    if (this.#fatal || this.#closing) return;
    const next = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    if (this.#buffer.byteLength + next.byteLength > this.#options.maxBufferedBytes) {
      this.#fail(new TransportFault("buffer_overflow", "Codex JSONL input exceeded the configured buffer limit."));
      return;
    }
    this.#buffer = Buffer.concat([this.#buffer, next]);
    while (true) {
      const newline = this.#buffer.indexOf(0x0a);
      if (newline < 0) {
        if (this.#buffer.byteLength > this.#options.maxLineBytes) {
          this.#fail(new TransportFault("buffer_overflow", "A Codex JSONL record exceeded the configured line limit."));
        }
        return;
      }
      const line = this.#buffer.subarray(0, newline);
      this.#buffer = this.#buffer.subarray(newline + 1);
      if (line.byteLength === 0) continue;
      if (line.byteLength > this.#options.maxLineBytes) {
        this.#fail(new TransportFault("buffer_overflow", "A Codex JSONL record exceeded the configured line limit."));
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(line.toString("utf8"));
      } catch {
        this.#fail(new TransportFault("protocol_violation", "The Codex app-server emitted invalid JSONL."));
        return;
      }
      if (!this.#acceptMessage(value, line.byteLength)) return;
    }
  }

  #acceptMessage(value: unknown, byteLength: number): boolean {
    if (!isJsonObject(value)) {
      this.#fail(new TransportFault("protocol_violation", "The Codex app-server emitted an invalid JSON-RPC envelope."));
      return false;
    }
    const method = value["method"];
    const id = value["id"];
    if (typeof method === "string") {
      const params = value["params"] ?? null;
      if (typeof id === "string" || typeof id === "number") {
        const request: RpcServerRequest = { method, id, params };
        // Server requests may remain open for human input. Keep them independent
        // so one approval cannot stall notifications for other shared threads.
        if (!this.#dispatchServerRequest(request, byteLength)) return false;
      } else if (id === undefined) {
        const notification: RpcNotification = { method, params };
        if (!this.#dispatchInbound(
          () => this.#handlers?.onNotification(notification),
          "A Codex notification could not be routed safely.",
          byteLength
        )) return false;
      } else {
        this.#fail(new TransportFault("protocol_violation", "A Codex JSON-RPC request contained an invalid id."));
        return false;
      }
      return true;
    }
    if (typeof id !== "string" && typeof id !== "number") {
      this.#fail(new TransportFault("protocol_violation", "A Codex JSON-RPC response contained an invalid id."));
      return false;
    }
    const key = String(id);
    const pending = this.#pending.get(key);
    if (pending === undefined) {
      this.#pruneTombstones();
      if (this.#tombstones.has(key)) return true;
      this.#fail(new TransportFault("protocol_violation", "The Codex app-server emitted a response for an unknown request."));
      return false;
    }
    clearTimeout(pending.timer);
    pending.abortCleanup?.();
    this.#pending.delete(key);
    const hasResult = Object.prototype.hasOwnProperty.call(value, "result");
    const hasError = Object.prototype.hasOwnProperty.call(value, "error");
    if (hasResult === hasError) {
      pending.reject(new TransportFault(
        "protocol_violation",
        "The Codex response did not contain exactly one result or error.",
        { stateMayHaveChanged: pending.mutation }
      ));
      return true;
    }
    if (hasError) {
      const error = value["error"];
      if (!isJsonObject(error) || typeof error["code"] !== "number" || !Number.isFinite(error["code"])) {
        pending.reject(new TransportFault(
          "protocol_violation",
          "The Codex response contained an invalid error envelope.",
          { stateMayHaveChanged: pending.mutation }
        ));
        return true;
      }
      pending.reject(new RpcRemoteFault(error["code"]));
      return true;
    }
    pending.resolve(value["result"] as JsonValue);
    return true;
  }

  #dispatchInbound(
    task: () => void | Promise<void> | undefined,
    failureMessage: string,
    byteLength: number
  ): boolean {
    if (!this.#reserveInboundHandler(byteLength)) return false;
    const dispatched = this.#inboundTail.then(async () => {
      if (this.#fatal || this.#closing) return;
      await task();
    }).finally(() => this.#releaseInboundHandler(byteLength));
    this.#inboundTail = dispatched.catch((error: unknown) => {
      this.#fail(error instanceof TransportFault
        ? error
        : new TransportFault("protocol_violation", failureMessage));
    });
    return true;
  }

  #dispatchServerRequest(request: RpcServerRequest, byteLength: number): boolean {
    if (!this.#reserveInboundHandler(byteLength)) return false;
    void Promise.resolve().then(() => this.#handlers?.onRequest(request))
      .catch((error: unknown) => {
        this.#fail(error instanceof TransportFault
          ? error
          : new TransportFault("protocol_violation", "A Codex server request could not be routed safely."));
      })
      .finally(() => this.#releaseInboundHandler(byteLength));
    return true;
  }

  #reserveInboundHandler(byteLength: number): boolean {
    if (this.#inboundHandlerEntries + 1 > this.#options.maxInboundHandlerEntries
      || this.#inboundHandlerBytes + byteLength > this.#options.maxInboundHandlerBytes) {
      this.#fail(new TransportFault("buffer_overflow", "Codex inbound handler work exceeded the configured safe limit."));
      return false;
    }
    this.#inboundHandlerEntries += 1;
    this.#inboundHandlerBytes += byteLength;
    return true;
  }

  #releaseInboundHandler(byteLength: number): void {
    this.#inboundHandlerEntries = Math.max(0, this.#inboundHandlerEntries - 1);
    this.#inboundHandlerBytes = Math.max(0, this.#inboundHandlerBytes - byteLength);
  }

  #addTombstone(key: string): void {
    this.#pruneTombstones();
    while (this.#tombstones.size >= this.#options.maxTombstones) {
      const oldest = this.#tombstones.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#tombstones.delete(oldest);
    }
    this.#tombstones.set(key, Date.now() + this.#options.tombstoneTtlMs);
  }

  #pruneTombstones(): void {
    const now = Date.now();
    for (const [key, expiresAt] of this.#tombstones) {
      if (expiresAt > now) break;
      this.#tombstones.delete(key);
    }
  }

  #rejectPending(fault: TransportFault): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.abortCleanup?.();
      pending.reject(new TransportFault(fault.code, fault.message, {
        stateMayHaveChanged: fault.stateMayHaveChanged || pending.mutation
      }));
    }
    this.#pending.clear();
  }

  #fail(fault: TransportFault): void {
    if (this.#fatal || this.#closing) return;
    this.#fatal = true;
    const child = this.#child;
    this.#child = undefined;
    this.#rejectPending(fault);
    if (child !== undefined && child.exitCode === null && child.signalCode === null) child.kill();
    if (this.#exitDelivered) return;
    this.#exitDelivered = true;
    void Promise.resolve(this.#handlers?.onExit(fault)).catch(() => undefined);
  }
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

async function childExitBefore(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      once(child, "exit").then(() => true, () => true),
      timeout
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
