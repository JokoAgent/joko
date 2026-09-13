import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import type { Readable, Writable } from "node:stream";
import type { RemoteWorkspaceBinding } from "@joko/core";
import { asPiError, piError, redactManagedSecrets, type PiAdapterError } from "./errors.js";
import {
  DEFAULT_PI_JSONL_RECORD_BYTES,
  encodeJsonLine,
  MAX_SAFE_PI_JSONL_RECORD_BYTES,
  StrictJsonLineDecoder
} from "./jsonl.js";
import { isRpcResponse, type PiRpcCommand, type PiRpcEvent, type PiRpcResponse } from "./protocol.js";

export interface PiProcessSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly remoteWorkspace?: RemoteWorkspaceBinding;
}

export interface PiProcessHandle {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly pid?: number;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly serviceRecovery?: {
    readonly required: true;
  };
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
}

export type PiProcessFactory = (spec: PiProcessSpec) => PiProcessHandle | Promise<PiProcessHandle>;

export const spawnPiProcess: PiProcessFactory = (spec) =>
  spawn(spec.command, [...spec.args], {
    cwd: spec.cwd,
    env: { ...spec.env },
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"]
  }) as ChildProcessWithoutNullStreams;

interface PendingRequest {
  readonly command: string;
  readonly stateMayHaveChanged: boolean;
  readonly resolve: (response: PiRpcResponse) => void;
  readonly reject: (error: PiAdapterError) => void;
  timer: NodeJS.Timeout;
  readonly timeoutMs: number;
  readonly refreshTimeoutOnEvent?: (event: PiRpcEvent) => boolean;
  readonly removeAbort?: () => void;
}

const MAX_RETIRED_REQUESTS = 4_096;
const MAX_SERVICE_RECOVERY_RECORDS = 4_096;
const MAX_SERVICE_RECOVERY_BYTES = 8 * 1024 * 1024;
const SERVICE_RECOVERY_TIMEOUT_MS = 15_000;
const USER_MESSAGE_COMMAND_TYPES = new Set(["prompt", "steer", "follow_up"]);
const NATIVE_COLLECTION_COMMAND_TYPES = new Set(["get_messages", "get_entries", "get_tree"]);
const USER_MESSAGE_ECHO_OVERHEAD_BYTES = (() => {
  const image = { type: "image", data: "", mimeType: "" };
  const shortestCommand = { type: "steer", message: "", images: [image] };
  const largestEchoEnvelope = {
    type: "message_start",
    message: {
      role: "user",
      content: [{ type: "text", text: "" }, image],
      timestamp: Number.MAX_SAFE_INTEGER
    }
  };
  return Buffer.byteLength(JSON.stringify(largestEchoEnvelope), "utf8")
    - Buffer.byteLength(JSON.stringify(shortestCommand), "utf8");
})();

export interface PiRpcTransportOptions {
  readonly process: PiProcessHandle;
  readonly generation: number;
  readonly requestTimeoutMs?: number;
  readonly maxRecordBytes?: number;
  readonly stderrLimitBytes?: number;
  readonly idFactory?: () => string;
  readonly redactValues?: readonly string[];
  readonly protocolTerminationGraceMs?: number;
}

export interface PiProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly expected: boolean;
  readonly stderr: string;
  readonly error?: PiAdapterError;
}

export type PiRpcEventListener = (event: PiRpcEvent) => void;
export type PiProcessExitListener = (exit: PiProcessExit) => void;

export class PiRpcTransport {
  readonly generation: number;
  readonly #process: PiProcessHandle;
  readonly #decoder: StrictJsonLineDecoder;
  readonly #requestTimeoutMs: number;
  readonly #adaptiveRecordBudget: boolean;
  readonly #userMessageRecordAllowanceBytes: number;
  readonly #stderrLimitBytes: number;
  readonly #idFactory: () => string;
  readonly #redactValues: readonly string[];
  readonly #protocolTerminationGraceMs: number;
  readonly #pending = new Map<string, PendingRequest>();
  /**
   * Requests rejected locally can still be accepted by Pi and acknowledged
   * later. Keep their correlation ids until that acknowledgement arrives so a
   * valid late response cannot be mistaken for an injected protocol record.
   */
  readonly #retired = new Map<string, string>();
  readonly #eventListeners = new Set<PiRpcEventListener>();
  readonly #earlyEvents: PiRpcEvent[] = [];
  readonly #exitListeners = new Set<PiProcessExitListener>();
  readonly #exitPromise: Promise<PiProcessExit>;
  #resolveExit!: (exit: PiProcessExit) => void;
  #stderrChunks: Buffer[] = [];
  #stderrBytes = 0;
  #sequence = 0;
  #expectedExit = false;
  #terminating = false;
  #closed = false;
  #fatalError: PiAdapterError | undefined;
  #protocolKillTimer: NodeJS.Timeout | undefined;
  #serviceRecoveryActive: boolean;
  #serviceRecoveryDispatch = false;
  #serviceRecoveryRecords = 0;
  #serviceRecoveryBytes = 0;
  #serviceRecoveryPromise: Promise<void> | undefined;

  constructor(options: PiRpcTransportOptions) {
    this.#process = options.process;
    this.generation = options.generation;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.#adaptiveRecordBudget = options.maxRecordBytes === undefined;
    this.#userMessageRecordAllowanceBytes = options.maxRecordBytes === undefined
      ? DEFAULT_PI_JSONL_RECORD_BYTES
      : USER_MESSAGE_ECHO_OVERHEAD_BYTES;
    this.#stderrLimitBytes = options.stderrLimitBytes ?? 64 * 1024;
    this.#idFactory = options.idFactory ?? (() => `${this.generation}-${Date.now().toString(36)}-${(++this.#sequence).toString(36)}`);
    this.#redactValues = options.redactValues ?? [];
    this.#protocolTerminationGraceMs = options.protocolTerminationGraceMs ?? 1_000;
    this.#serviceRecoveryActive = options.process.serviceRecovery?.required === true;
    this.#exitPromise = new Promise<PiProcessExit>((resolve) => {
      this.#resolveExit = resolve;
    });

    this.#decoder = new StrictJsonLineDecoder({
      maxRecordBytes: options.maxRecordBytes,
      maxRecordBytesCeiling: options.maxRecordBytes ?? MAX_SAFE_PI_JSONL_RECORD_BYTES,
      onValue: (value) => this.#handleValue(value)
    });

    this.#process.stdout.on("data", (chunk: Buffer | string) => {
      try {
        this.#decoder.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      } catch (error) {
        this.#failProtocol(error);
      }
    });
    this.#process.stdout.on("end", () => {
      try {
        this.#decoder.end();
      } catch (error) {
        this.#failProtocol(error);
      }
    });
    this.#process.stdout.on("error", (error) => this.#failProtocol(error));
    this.#process.stderr.on("data", (chunk: Buffer | string) => this.#captureStderr(chunk));
    this.#process.stderr.on("error", () => undefined);
    this.#process.stdin.on("error", () => undefined);
    this.#process.once("error", (error) => {
      this.#fatalError ??= asPiError(error, {
          code: "PI_PROCESS_SPAWN_FAILED",
          phase: "spawn",
          retryable: true,
          recovery: "Verify the installed Pi executable, RPC compatibility, and service account PATH."
        }, this.#redactValues);
      this.#rejectAll(this.#fatalError);
      queueMicrotask(() => this.#finishExit(this.#process.exitCode, this.#process.signalCode));
    });
    this.#process.once("exit", (code, signal) => this.#finishExit(code, signal));
  }

  get pid(): number | undefined {
    return this.#process.pid;
  }

  get closed(): boolean {
    return this.#closed || this.#terminating;
  }

  /** Fence protocol traffic before an identity-checked external tree kill. */
  beginExternalTermination(): void {
    if (this.#closed || this.#terminating) return;
    this.#expectedExit = true;
    this.#terminating = true;
    this.#process.stdin.end();
  }

  get stderrTail(): string {
    return redactManagedSecrets(Buffer.concat(this.#stderrChunks, this.#stderrBytes).toString("utf8"), this.#redactValues);
  }

  onEvent(listener: PiRpcEventListener): () => void {
    const firstListener = this.#eventListeners.size === 0;
    this.#eventListeners.add(listener);
    if (firstListener && this.#earlyEvents.length > 0) {
      for (const event of this.#earlyEvents.splice(0)) listener(event);
    }
    return () => this.#eventListeners.delete(listener);
  }

  onExit(listener: PiProcessExitListener): () => void {
    this.#exitListeners.add(listener);
    return () => this.#exitListeners.delete(listener);
  }

  /** Fences old service-generation records before the Adapter can publish them. */
  recoverService(): Promise<void> {
    if (!this.#serviceRecoveryActive) return Promise.resolve();
    this.#serviceRecoveryPromise ??= this.#runServiceRecovery();
    return this.#serviceRecoveryPromise;
  }

  async request(
    command: PiRpcCommand,
    options: {
      readonly timeoutMs?: number;
      readonly signal?: AbortSignal;
      readonly stateMayHaveChanged?: boolean;
      /**
       * Refreshes the bounded silent-response window only for authoritative
       * progress emitted while this request is still awaiting acknowledgement.
       */
      readonly refreshTimeoutOnEvent?: (event: PiRpcEvent) => boolean;
    } = {}
  ): Promise<PiRpcResponse> {
    if (command.type === "extension_ui_response") {
      throw piError("PI_PROTOCOL_INVALID_REQUEST", "extension_ui_response is a notification, not an RPC request", "dispatch");
    }
    if (this.#closed || this.#terminating || this.#fatalError) throw this.#closedError("Cannot dispatch to a failed or closed Pi runtime");
    if (this.#serviceRecoveryActive && !this.#serviceRecoveryDispatch) {
      throw piError(
        "PI_SERVICE_RECOVERY_PENDING",
        "Pi runtime recovery has not crossed its state reconciliation barrier",
        "dispatch",
        { retryable: true, stateMayHaveChanged: true }
      );
    }
    if (options.signal?.aborted) throw piError("PI_REQUEST_ABORTED", "Pi request was aborted before dispatch", "dispatch", { retryable: true });

    const id = this.#idFactory();
    const commandType = command.type;
    const timeoutMs = options.timeoutMs ?? this.#requestTimeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
      throw piError(
        "PI_RPC_TIMEOUT_INVALID",
        "Pi RPC timeout must be a positive safe integer within the platform timer range",
        "dispatch"
      );
    }
    const wire = { ...command, id } as PiRpcCommand;

    return new Promise<PiRpcResponse>((resolve, reject) => {
      const timer = this.#requestTimer(id, commandType, timeoutMs, reject);

      let removeAbort: (() => void) | undefined;
      if (options.signal) {
        const onAbort = () => {
           const pending = this.#pending.get(id);
           if (!pending) return;
           this.#pending.delete(id);
           clearTimeout(pending.timer);
           pending.removeAbort?.();
           this.#retire(id, pending.command);
           reject(
            piError("PI_REQUEST_ABORTED", `Pi RPC '${commandType}' was aborted while awaiting acknowledgement`, "dispatch", {
              retryable: !pending.stateMayHaveChanged,
              stateMayHaveChanged: pending.stateMayHaveChanged,
              recovery: pending.stateMayHaveChanged
                ? "Reconcile native session state; the command may already have been accepted."
                : "Retry when the caller is ready."
            })
          );
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
        removeAbort = () => options.signal?.removeEventListener("abort", onAbort);
      }

      this.#pending.set(id, {
        command: commandType,
        stateMayHaveChanged: options.stateMayHaveChanged ?? false,
        resolve,
        reject,
        timer,
        timeoutMs,
        refreshTimeoutOnEvent: options.refreshTimeoutOnEvent,
        removeAbort
      });

      void this.#write(wire).catch((error) => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        this.#pending.delete(id);
        clearTimeout(pending.timer);
        pending.removeAbort?.();
        reject(
          asPiError(error, {
            code: "PI_RPC_WRITE_FAILED",
            phase: "dispatch",
            retryable: true,
            stateMayHaveChanged: pending.stateMayHaveChanged,
            recovery: pending.stateMayHaveChanged
              ? "Treat the operation as dispatch_unknown and reconcile before replay."
              : "Restart the runtime and retry."
          }, this.#redactValues)
        );
      });
    });
  }

  async notify(command: PiRpcCommand): Promise<void> {
    if (this.#closed || this.#terminating || this.#fatalError) throw this.#closedError("Cannot send a notification to a failed or closed Pi runtime");
    await this.#write(command);
  }

  async terminate(graceMs = 5_000): Promise<PiProcessExit> {
    if (this.#closed) return this.#exitPromise;
    if (!Number.isFinite(graceMs) || graceMs < 0) {
      throw piError("PI_INVALID_SHUTDOWN_TIMEOUT", "Pi shutdown timeout must be a finite non-negative number", "shutdown");
    }
    this.#expectedExit = true;
    this.#terminating = true;
    this.#process.stdin.end();
    try {
      this.#process.kill("SIGTERM");
    } catch (error) {
      throw asPiError(error, {
        code: "PI_PROCESS_TERMINATE_FAILED",
        phase: "shutdown",
        retryable: true,
        stateMayHaveChanged: true,
        recovery: "Inspect the service-node process and terminate the fenced Pi runtime before retrying."
      }, this.#redactValues);
    }

    if (await settlesWithin(this.#exitPromise, graceMs)) return this.#exitPromise;

    try {
      this.#process.kill("SIGKILL");
    } catch (error) {
      throw asPiError(error, {
        code: "PI_PROCESS_KILL_FAILED",
        phase: "shutdown",
        retryable: true,
        stateMayHaveChanged: true,
        recovery: "Inspect and terminate the fenced Pi process manually; do not start another generation yet."
      }, this.#redactValues);
    }
    const confirmationMs = Math.max(25, Math.min(graceMs, 5_000));
    if (await settlesWithin(this.#exitPromise, confirmationMs)) return this.#exitPromise;

    const error = piError("PI_PROCESS_KILL_UNCONFIRMED", "Pi did not confirm exit after SIGKILL", "shutdown", {
      retryable: true,
      stateMayHaveChanged: true,
      recovery: "Keep the generation fenced and inspect the service-node process before starting a replacement runtime."
    });
    this.#fatalError = error;
    this.#rejectAll(error);
    throw error;
  }

  waitForExit(): Promise<PiProcessExit> {
    return this.#exitPromise;
  }

  async #write(value: PiRpcCommand): Promise<void> {
    if (this.#closed || this.#terminating || this.#fatalError) throw this.#closedError("Pi stdin is failed or closed");
    const encoded = encodeJsonLine(value);
    this.#reserveRuntimeRecord(value, encoded.byteLength - 1);
    const accepted = this.#process.stdin.write(encoded);
    if (!accepted) await once(this.#process.stdin, "drain");
  }

  #reserveRuntimeRecord(value: PiRpcCommand, outboundRecordBytes: number): void {
    if (this.#adaptiveRecordBudget && NATIVE_COLLECTION_COMMAND_TYPES.has(value.type)) {
      // Pi returns each collection as one non-paginated JSONL response. Its
      // entries/messages may legitimately contain inline image bytes from an
      // earlier or resumed run, so only the parser's platform ceiling is an
      // honest record bound. Reserving it does not allocate memory.
      this.#decoder.reserveRecordBytes(MAX_SAFE_PI_JSONL_RECORD_BYTES);
      return;
    }
    if (!USER_MESSAGE_COMMAND_TYPES.has(value.type)) return;
    if (outboundRecordBytes > MAX_SAFE_PI_JSONL_RECORD_BYTES - this.#userMessageRecordAllowanceBytes) {
      throw piError(
        "PI_PROTOCOL_RECORD_BUDGET_EXCEEDED",
        "Pi user-message wire representation exceeds the platform-safe JSONL parser ceiling",
        "dispatch",
        {
          recovery: "Use a Blob/runtime capability whose encoded user-message event fits the platform JSON string ceiling."
        }
      );
    }
    this.#decoder.reserveRecordBytes(outboundRecordBytes + this.#userMessageRecordAllowanceBytes);
  }

  #handleValue(value: unknown): void {
    if (this.#serviceRecoveryActive && !this.#accountServiceRecoveryValue(value)) return;
    if (isRpcResponse(value)) {
      const id = value.id;
      if (typeof id !== "string") {
        this.#failProtocol(piError("PI_PROTOCOL_UNCORRELATED_RESPONSE", "Pi returned a response without the request id", "stream", { stateMayHaveChanged: true }));
        return;
      }
      const pending = this.#pending.get(id);
      if (!pending) {
        if (this.#serviceRecoveryActive) return;
        const retiredCommand = this.#retired.get(id);
        if (retiredCommand !== undefined) {
          this.#retired.delete(id);
          if (value.command !== retiredCommand) {
            this.#failProtocol(piError(
              "PI_PROTOCOL_COMMAND_MISMATCH",
              `Pi late response command '${value.command}' did not match '${retiredCommand}'`,
              "stream",
              {
                stateMayHaveChanged: true,
                recovery: "Restart the runtime and reconcile against Pi's durable native session before dispatching again."
              }
            ));
          }
          return;
        }
        this.#failProtocol(piError("PI_PROTOCOL_UNKNOWN_RESPONSE", `Pi returned an unknown response id '${id}'`, "stream", { stateMayHaveChanged: true }));
        return;
      }
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      pending.removeAbort?.();
      if (value.command !== pending.command) {
        const error = piError(
          "PI_PROTOCOL_COMMAND_MISMATCH",
          `Pi response command '${value.command}' did not match '${pending.command}'`,
          "stream",
          {
            stateMayHaveChanged: pending.stateMayHaveChanged,
            recovery: "Restart the runtime and reconcile against Pi's durable native session before dispatching again."
          }
        );
        pending.reject(error);
        this.#failProtocol(error);
        return;
      }
      if (!value.success) {
        pending.reject(
          piError("PI_RPC_REJECTED", redactManagedSecrets(value.error, this.#redactValues), "dispatch", {
            stateMayHaveChanged: pending.stateMayHaveChanged,
            recovery: pending.stateMayHaveChanged
              ? "Reconcile the native session before deciding whether the rejected side-effecting operation is safe to retry."
              : "Correct the rejected command or native session state before retrying."
          })
        );
        return;
      }
      pending.resolve(value);
      return;
    }

    if (typeof value !== "object" || value === null || typeof (value as { type?: unknown }).type !== "string") {
      this.#failProtocol(piError("PI_PROTOCOL_UNKNOWN_RECORD", "Pi emitted a record without a string type", "stream", { stateMayHaveChanged: true }));
      return;
    }
    const event = value as PiRpcEvent;
    if (this.#serviceRecoveryActive) return;
    for (const [id, pending] of this.#pending) {
      let refresh = false;
      try {
        refresh = pending.refreshTimeoutOnEvent?.(event) === true;
      } catch {
        refresh = false;
      }
      if (!refresh) continue;
      clearTimeout(pending.timer);
      pending.timer = this.#requestTimer(id, pending.command, pending.timeoutMs, pending.reject);
    }
    if (this.#eventListeners.size === 0) {
      // Pi may finish extension session_start before the Adapter has built and
      // wired its runtime object. Preserve that bounded startup evidence for
      // the first owner rather than silently dropping it.
      if (this.#earlyEvents.length >= 256) {
        this.#failProtocol(piError("PI_PROTOCOL_EARLY_EVENT_OVERFLOW", "Pi emitted too many events before runtime wiring completed", "stream", {
          stateMayHaveChanged: true,
          recovery: "Restart the runtime and inspect extensions that emit excessive startup events."
        }));
        return;
      }
      this.#earlyEvents.push(event);
      return;
    }
    for (const listener of this.#eventListeners) listener(event);
  }

  async #runServiceRecovery(): Promise<void> {
    const deadline = Date.now() + SERVICE_RECOVERY_TIMEOUT_MS;
    this.#serviceRecoveryDispatch = true;
    try {
      const cleared = await this.request(
        { type: "clear_queue" },
        { timeoutMs: remainingRecoveryTime(deadline), stateMayHaveChanged: true }
      );
      assertServiceRecoveryQueueCleared(cleared);
      await this.request(
        { type: "abort" },
        { timeoutMs: remainingRecoveryTime(deadline), stateMayHaveChanged: true }
      );
      while (true) {
        const response = await this.request(
          { type: "get_state" },
          { timeoutMs: remainingRecoveryTime(deadline), stateMayHaveChanged: true }
        );
        const state = (response as unknown as { readonly data?: unknown }).data;
        if (
          typeof state !== "object" || state === null || Array.isArray(state) ||
          typeof (state as { isStreaming?: unknown }).isStreaming !== "boolean" ||
          typeof (state as { isCompacting?: unknown }).isCompacting !== "boolean" ||
          !Number.isSafeInteger((state as { pendingMessageCount?: unknown }).pendingMessageCount) ||
          ((state as { pendingMessageCount: number }).pendingMessageCount < 0)
        ) {
          throw piError(
            "PI_SERVICE_RECOVERY_STATE_INVALID",
            "Recovered Pi runtime returned an invalid reconciliation state",
            "stream",
            { stateMayHaveChanged: true }
          );
        }
        if ((state as { pendingMessageCount: number }).pendingMessageCount !== 0) {
          throw piError(
            "PI_SERVICE_RECOVERY_QUEUE_UNSAFE",
            "Recovered Pi runtime retained an old-generation pending input queue",
            "stream",
            {
              stateMayHaveChanged: true,
              recovery: "Restart the runtime and reconcile the durable product queue before dispatching again."
            }
          );
        }
        if (
          (state as { isStreaming: boolean }).isStreaming === false &&
          (state as { isCompacting: boolean }).isCompacting === false
        ) break;
        await boundedRecoveryDelay(deadline);
      }
      this.#serviceRecoveryActive = false;
    } catch (error) {
      const failure = asPiError(error, {
        code: "PI_SERVICE_RECOVERY_FAILED",
        phase: "stream",
        retryable: true,
        stateMayHaveChanged: true,
        recovery: "Restart the runtime and reconcile from the durable native session before dispatching again."
      }, this.#redactValues);
      this.#failProtocol(failure);
      throw failure;
    } finally {
      this.#serviceRecoveryDispatch = false;
    }
  }

  #accountServiceRecoveryValue(value: unknown): boolean {
    this.#serviceRecoveryRecords += 1;
    let bytes: number;
    try {
      bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    } catch {
      this.#failProtocol(piError("PI_SERVICE_RECOVERY_OVERFLOW", "Pi service recovery emitted an unbounded record", "stream", {
        stateMayHaveChanged: true
      }));
      return false;
    }
    this.#serviceRecoveryBytes += bytes;
    if (
      this.#serviceRecoveryRecords > MAX_SERVICE_RECOVERY_RECORDS ||
      this.#serviceRecoveryBytes > MAX_SERVICE_RECOVERY_BYTES
    ) {
      this.#failProtocol(piError("PI_SERVICE_RECOVERY_OVERFLOW", "Pi service recovery exceeded its bounded drain window", "stream", {
        stateMayHaveChanged: true,
        recovery: "Restart the runtime and reconcile from the durable native session before dispatching again."
      }));
      return false;
    }
    return true;
  }

  #captureStderr(chunk: Buffer | string): void {
    let value = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
    if (value.length >= this.#stderrLimitBytes) {
      value = value.subarray(value.length - this.#stderrLimitBytes);
      this.#stderrChunks = [value];
      this.#stderrBytes = value.length;
      return;
    }
    this.#stderrChunks.push(value);
    this.#stderrBytes += value.length;
    while (this.#stderrBytes > this.#stderrLimitBytes && this.#stderrChunks.length > 0) {
      const first = this.#stderrChunks[0];
      if (!first) break;
      const overflow = this.#stderrBytes - this.#stderrLimitBytes;
      if (first.length <= overflow) {
        this.#stderrChunks.shift();
        this.#stderrBytes -= first.length;
      } else {
        this.#stderrChunks[0] = first.subarray(overflow);
        this.#stderrBytes -= overflow;
      }
    }
  }

  #failProtocol(error: unknown): void {
    if (this.#closed || this.#fatalError) return;
    this.#fatalError = asPiError(error, {
      code: "PI_PROTOCOL_FAILURE",
      phase: "stream",
      stateMayHaveChanged: true,
      recovery: "Restart the runtime and reconcile from Pi's durable JSONL session."
    }, this.#redactValues);
    this.#rejectAll(this.#fatalError);
    this.#expectedExit = false;
    try {
      this.#process.kill("SIGTERM");
    } catch {}
    this.#protocolKillTimer = setTimeout(() => {
      if (!this.#closed) {
        try {
          this.#process.kill("SIGKILL");
        } catch {}
      }
    }, this.#protocolTerminationGraceMs);
    this.#protocolKillTimer.unref?.();
  }

  #finishExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#protocolKillTimer) clearTimeout(this.#protocolKillTimer);
    const error =
      this.#fatalError ??
      (this.#expectedExit
        ? undefined
        : piError("PI_PROCESS_EXITED", `Pi process exited unexpectedly (code=${String(code)}, signal=${String(signal)})`, "stream", {
            retryable: true,
            stateMayHaveChanged: true,
            recovery: "Resume the native JSONL session and reconcile the last durable entry cursor."
          }));
    if (error) this.#rejectAll(error);
    else this.#rejectAll(this.#closedError("Pi runtime closed"));
    const exit: PiProcessExit = { code, signal, expected: this.#expectedExit, stderr: this.stderrTail, error };
    this.#resolveExit(exit);
    for (const listener of this.#exitListeners) listener(exit);
    this.#eventListeners.clear();
    this.#earlyEvents.length = 0;
    this.#exitListeners.clear();
    this.#retired.clear();
  }

  #requestTimer(
    id: string,
    command: string,
    timeoutMs: number,
    reject: (error: PiAdapterError) => void
  ): NodeJS.Timeout {
    const timer = setTimeout(() => {
      const pending = this.#pending.get(id);
      if (!pending) return;
      this.#pending.delete(id);
      pending.removeAbort?.();
      this.#retire(id, pending.command);
      reject(
        piError("PI_RPC_TIMEOUT", `Pi RPC '${command}' did not respond within ${timeoutMs} ms`, "dispatch", {
          retryable: true,
          stateMayHaveChanged: pending.stateMayHaveChanged,
          recovery: pending.stateMayHaveChanged
            ? "Do not replay blindly; reconcile the native session before deciding whether to retry."
            : "Retry the idempotent inspection operation or restart the runtime."
        })
      );
    }, timeoutMs);
    timer.unref?.();
    return timer;
  }

  #retire(id: string, command: string): void {
    if (this.#retired.size >= MAX_RETIRED_REQUESTS) {
      this.#failProtocol(piError(
        "PI_PROTOCOL_RETIRED_REQUEST_OVERFLOW",
        "Pi left too many locally retired requests without acknowledgement",
        "stream",
        {
          stateMayHaveChanged: true,
          recovery: "Restart the runtime and reconcile from Pi's durable native session before dispatching again."
        }
      ));
      return;
    }
    this.#retired.set(id, command);
  }

  #rejectAll(error: PiAdapterError): void {
    for (const pending of this.#pending.values()) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.removeAbort?.();
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #closedError(message: string): PiAdapterError {
    return this.#fatalError ?? piError("PI_PROCESS_CLOSED", message, "dispatch", { retryable: true, stateMayHaveChanged: true });
  }
}

function remainingRecoveryTime(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw piError("PI_SERVICE_RECOVERY_TIMEOUT", "Pi service recovery did not settle within its bounded window", "stream", {
      stateMayHaveChanged: true
    });
  }
  return remaining;
}

function assertServiceRecoveryQueueCleared(response: unknown): void {
  const data = typeof response === "object" && response !== null && !Array.isArray(response)
    ? (response as { readonly data?: unknown }).data
    : undefined;
  if (
    typeof data !== "object"
    || data === null
    || Array.isArray(data)
    || !Array.isArray((data as { readonly steering?: unknown }).steering)
    || !(data as { readonly steering: readonly unknown[] }).steering.every((value) => typeof value === "string")
    || !Array.isArray((data as { readonly followUp?: unknown }).followUp)
    || !(data as { readonly followUp: readonly unknown[] }).followUp.every((value) => typeof value === "string")
  ) {
    throw piError(
      "PI_SERVICE_RECOVERY_QUEUE_RESPONSE_INVALID",
      "Recovered Pi runtime returned an invalid cleared-queue acknowledgement",
      "stream",
      { stateMayHaveChanged: true }
    );
  }
}

function boundedRecoveryDelay(deadline: number): Promise<void> {
  const delayMs = Math.min(25, remainingRecoveryTime(deadline));
  return new Promise((resolveDelay) => {
    const timer = setTimeout(resolveDelay, delayMs);
    timer.unref?.();
  });
}

async function settlesWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
  });
  const settled = await Promise.race([promise.then(() => true), timeout]);
  if (timer) clearTimeout(timer);
  return settled;
}
