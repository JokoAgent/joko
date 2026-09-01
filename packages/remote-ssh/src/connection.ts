import { isRemoteSshError, RemoteSshError } from "./errors.js";
import type {
  AgentAuthConnection,
  AgentAuthConnectorRequest,
  AgentAuthConnectorPort,
  AgentAuthExecutionResult,
  RemoteSshHost,
  RemoteSshHostInput,
  RemoteSshLogger,
  RemoteSshOwnerScope,
  RemoteSshSnapshot,
  RemoteSshStatus,
  RemoteSshTransportLease,
  RemoteSshTestOptions,
  RemoteSshTestResult,
  RemoteSshExecutionOptions,
  RemoteSshExecutionResult,
  SshHostKeyVerifierPort
} from "./types.js";
import {
  AgentAuthConnectorFailure as ConnectorFailure,
  REMOTE_SSH_EXECUTION_TIMEOUT_MS,
  REMOTE_SSH_MAXIMUM_COMMAND_BYTES,
  REMOTE_SSH_MAXIMUM_EXECUTION_TIMEOUT_MS,
  REMOTE_SSH_MAXIMUM_INPUT_BYTES,
  REMOTE_SSH_MAXIMUM_OUTPUT_BYTES,
  REMOTE_SSH_TEST_TIMEOUT_MS
} from "./types.js";

export interface RemoteSshConnectionControllerOptions {
  readonly connector: AgentAuthConnectorPort;
  readonly hostKeyVerifier: SshHostKeyVerifierPort;
  readonly logger?: RemoteSshLogger;
  readonly now?: () => number;
}

export type RemoteSshStatusListener = (snapshot: RemoteSshSnapshot) => void;

export class RemoteSshConnectionController {
  readonly #host: RemoteSshHost;
  readonly #connector: AgentAuthConnectorPort;
  readonly #hostKeyVerifier: SshHostKeyVerifierPort;
  readonly #logger: RemoteSshLogger | undefined;
  readonly #now: () => number;
  readonly #listeners = new Set<RemoteSshStatusListener>();
  #status: RemoteSshStatus = "disconnected";
  #statusChangedAt: number;
  #error: RemoteSshError | undefined;
  #connection: AgentAuthConnection | undefined;
  #operation: Promise<RemoteSshTestResult> | undefined;
  #operationAbort: AbortController | undefined;
  #generation = 0;

  constructor(host: RemoteSshHostInput, options: RemoteSshConnectionControllerOptions) {
    this.#host = normalizeRemoteSshHost(host);
    if (options.connector === undefined || typeof options.connector.connect !== "function") {
      throw new RemoteSshError("CONNECTOR_UNAVAILABLE", "The SSH connector is unavailable.", true);
    }
    if (options.hostKeyVerifier === undefined || typeof options.hostKeyVerifier.verify !== "function") {
      throw new RemoteSshError("HOST_KEY_STORE_MISSING", "A trusted host key verifier is required.", false);
    }
    this.#connector = options.connector;
    this.#hostKeyVerifier = options.hostKeyVerifier;
    this.#logger = options.logger;
    this.#now = options.now ?? Date.now;
    this.#statusChangedAt = this.#now();
  }

  snapshot(scope: RemoteSshOwnerScope): RemoteSshSnapshot {
    this.assertScope(scope);
    return this.currentSnapshot();
  }

  onStatus(scope: RemoteSshOwnerScope, listener: RemoteSshStatusListener): () => void {
    this.assertScope(scope);
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async test(scope: RemoteSshOwnerScope, options: RemoteSshTestOptions = {}): Promise<RemoteSshTestResult> {
    this.assertScope(scope);
    if (this.#status === "ready" && this.#connection !== undefined) {
      return Object.freeze({ ok: true, snapshot: this.currentSnapshot() });
    }
    if (this.#operation !== undefined) return this.#operation;
    const timeoutMs = validateTestTimeout(options.timeoutMs);
    const generation = ++this.#generation;
    const controller = new AbortController();
    this.#operationAbort = controller;
    const detachExternalAbort = forwardAbort(options.signal, controller);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    timer.unref?.();
    const operation = this.runTest(generation, controller.signal, () => timedOut)
      .finally(() => {
        clearTimeout(timer);
        detachExternalAbort();
        if (this.#generation === generation) this.#operationAbort = undefined;
        if (this.#operation === operation) this.#operation = undefined;
      });
    this.#operation = operation;
    return operation;
  }

  /**
   * Execute one bounded command on the already-authenticated connection.
   * The command, stdin, and output are intentionally absent from status,
   * errors, and logger fields.
   */
  async execute(
    scope: RemoteSshOwnerScope,
    options: RemoteSshExecutionOptions
  ): Promise<RemoteSshExecutionResult> {
    this.assertScope(scope);
    const request = normalizeExecutionOptions(options);
    const connection = this.#connection;
    if (this.#status !== "ready" || connection === undefined) {
      throw new RemoteSshError("CONNECTION_FAILED", "The SSH connection is not ready.", true);
    }
    if (typeof connection.execute !== "function") {
      throw new RemoteSshError(
        "EXECUTION_UNAVAILABLE",
        "The SSH connector does not provide command execution.",
        false
      );
    }
    const generation = this.#generation;
    const controller = new AbortController();
    const detachExternalAbort = forwardAbort(request.signal, controller);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, request.timeoutMs);
    timer.unref?.();
    let execution: Promise<AgentAuthExecutionResult>;
    try {
      execution = Promise.resolve(connection.execute({
        command: request.command,
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        ...(request.input === undefined ? {} : { input: request.input }),
        timeoutMs: request.timeoutMs,
        maxOutputBytes: REMOTE_SSH_MAXIMUM_OUTPUT_BYTES,
        signal: controller.signal
      }));
    } catch (error) {
      execution = Promise.reject(error);
    }
    // A connector that settles after cancellation must not produce an
    // unhandled rejection or regain authority over the closed connection.
    void execution.catch(() => undefined);
    try {
      const result = await raceWithAbort(execution, controller.signal);
      if (this.#generation !== generation || this.#connection !== connection) {
        throw new RemoteSshError("ABORTED", "The SSH command was aborted.", true);
      }
      return normalizeExecutionResult(result);
    } catch (error) {
      if (timedOut || request.signal?.aborted === true || controller.signal.aborted) {
        if (this.#connection === connection) {
          ++this.#generation;
          this.#connection = undefined;
          await safeClose(connection);
          this.setStatus("disconnected");
        }
        if (timedOut) {
          throw new RemoteSshError("EXECUTION_TIMEOUT", "The SSH command timed out.", true);
        }
        throw new RemoteSshError("ABORTED", "The SSH command was aborted.", true);
      }
      if (isRemoteSshError(error) &&
        (error.code === "ABORTED" || error.code === "EXECUTION_PROTOCOL")) throw error;
      throw new RemoteSshError("EXECUTION_FAILED", "The SSH command failed safely.", true);
    } finally {
      clearTimeout(timer);
      detachExternalAbort();
    }
  }

  transports(scope: RemoteSshOwnerScope): RemoteSshTransportLease {
    this.assertScope(scope);
    const connection = this.#connection;
    if (this.#status !== "ready" || connection === undefined) {
      throw new RemoteSshError("CONNECTION_FAILED", "The SSH connection is not ready.", true);
    }
    const capabilities = Object.freeze({
      commandExecution: connection.capabilities?.commandExecution === true,
      processStreaming: connection.capabilities?.processStreaming === true,
      fileTransfer: connection.capabilities?.fileTransfer === true,
      tcpForwarding: connection.capabilities?.tcpForwarding === true
    });
    return Object.freeze({
      capabilities,
      ...(capabilities.processStreaming && connection.processes !== undefined
        ? { processes: connection.processes }
        : {}),
      ...(capabilities.fileTransfer && connection.files !== undefined
        ? { files: connection.files }
        : {}),
      ...(capabilities.tcpForwarding && connection.forwarding !== undefined
        ? { forwarding: connection.forwarding }
        : {})
    });
  }

  async disconnect(scope: RemoteSshOwnerScope): Promise<void> {
    this.assertScope(scope);
    ++this.#generation;
    this.#operationAbort?.abort();
    this.#operationAbort = undefined;
    const connection = this.#connection;
    this.#connection = undefined;
    if (connection !== undefined) await safeClose(connection);
    this.setStatus("disconnected");
  }

  private async runTest(
    generation: number,
    signal: AbortSignal,
    timedOut: () => boolean
  ): Promise<RemoteSshTestResult> {
    this.#error = undefined;
    this.setStatus("connecting");
    if (signal.aborted) {
      const failure = abortError(timedOut());
      this.#error = failure;
      this.setStatus("failed");
      return Object.freeze({ ok: false, snapshot: this.currentSnapshot(), error: failure.toJSON() });
    }
    let authenticating = false;
    let verificationAttempted = false;
    let verificationFailure: RemoteSshError | undefined;
    let protocolFailure: RemoteSshError | undefined;
    const verificationTasks: Promise<void>[] = [];
    let lateConnection: AgentAuthConnection | undefined;
    const connectorRequest: AgentAuthConnectorRequest = {
      hostname: this.#host.hostname,
      port: this.#host.port,
      user: this.#host.user,
      ...(this.#host.credentialRef === undefined ? {} : { credentialRef: this.#host.credentialRef }),
      signal,
      onAuthenticating: () => {
        authenticating = true;
        if (this.#generation === generation && !signal.aborted) this.setStatus("authenticating");
      },
      verifyHostKey: (presented) => {
        if (this.#generation !== generation || signal.aborted) {
          return Promise.reject(abortError(false));
        }
        verificationAttempted = true;
        const verification = Promise.resolve().then(() => this.#hostKeyVerifier.verify({
            hostname: this.#host.hostname,
            port: this.#host.port,
            algorithm: presented.algorithm,
            key: presented.key
          }))
          .then(() => undefined)
          .catch((error: unknown) => {
            verificationFailure = normalizeHostKeyFailure(error);
            throw verificationFailure;
          });
        verificationTasks.push(verification);
        void verification.catch(() => undefined);
        return verification;
      }
    };
    let connectPromise: Promise<AgentAuthConnection>;
    try {
      connectPromise = Promise.resolve(this.#connector.connect(connectorRequest));
    } catch (error) {
      connectPromise = Promise.reject(error);
    }
    void connectPromise.then(async (connection) => {
      lateConnection = connection;
      if (this.#generation !== generation || signal.aborted) await safeClose(connection);
    }, () => undefined);
    try {
      const connection = await raceWithAbort(connectPromise, signal);
      if (!isAgentAuthConnection(connection)) {
        protocolFailure = new RemoteSshError(
          "CONNECTOR_PROTOCOL",
          "The SSH connector returned an invalid connection handle.",
          false
        );
        throw protocolFailure;
      }
      await raceWithAbort(Promise.all(verificationTasks), signal);
      if (verificationFailure !== undefined) throw verificationFailure;
      if (!verificationAttempted) {
        protocolFailure = new RemoteSshError(
          "HOST_KEY_MISSING",
          "The SSH server identity was not verified.",
          false
        );
        throw protocolFailure;
      }
      if (!authenticating) {
        protocolFailure = new RemoteSshError(
          "CONNECTOR_PROTOCOL",
          "The SSH connector did not report authentication.",
          false
        );
        throw protocolFailure;
      }
      if (this.#generation !== generation || signal.aborted) {
        await safeClose(connection);
        throw abortError(timedOut());
      }
      this.#connection = connection;
      this.setStatus("ready");
      this.safeLog("info", "SSH connection test succeeded.", { hostId: this.#host.id });
      return Object.freeze({ ok: true, snapshot: this.currentSnapshot() });
    } catch (error) {
      if (lateConnection !== undefined) await safeClose(lateConnection);
      const failure = verificationFailure ?? protocolFailure ?? normalizeConnectionFailure(error, signal.aborted, timedOut());
      if (this.#generation !== generation) {
        return Object.freeze({ ok: false, snapshot: this.currentSnapshot(), error: failure.toJSON() });
      }
      this.#error = failure;
      this.#connection = undefined;
      this.setStatus("failed");
      this.safeLog("warn", "SSH connection test failed.", {
        hostId: this.#host.id,
        code: failure.code,
        retryable: failure.retryable
      });
      return Object.freeze({ ok: false, snapshot: this.currentSnapshot(), error: failure.toJSON() });
    }
  }

  private assertScope(scope: RemoteSshOwnerScope): void {
    if (scope.ownerId !== this.#host.ownerId || scope.targetId !== this.#host.targetId) {
      throw new RemoteSshError(
        "OWNER_SCOPE_MISMATCH",
        "The SSH host does not belong to the authenticated owner scope.",
        false
      );
    }
  }

  private currentSnapshot(): RemoteSshSnapshot {
    const { credentialRef: _credentialRef, ...safeHost } = this.#host;
    return Object.freeze({
      host: Object.freeze(safeHost),
      status: this.#status,
      statusChangedAt: this.#statusChangedAt,
      ...(this.#error === undefined ? {} : { error: this.#error.toJSON() })
    });
  }

  private setStatus(status: RemoteSshStatus): void {
    if (this.#status === status) return;
    this.#status = status;
    this.#statusChangedAt = this.#now();
    const snapshot = this.currentSnapshot();
    for (const listener of this.#listeners) {
      try {
        listener(snapshot);
      } catch {
        // A presentation subscriber cannot alter the connection lifecycle.
      }
    }
  }

  private safeLog(
    level: "info" | "warn",
    message: string,
    fields: Readonly<Record<string, boolean | number | string>>
  ): void {
    try {
      this.#logger?.[level]?.(message, fields);
    } catch {
      // Logging must not affect connection state.
    }
  }
}

export function normalizeRemoteSshHost(input: RemoteSshHostInput): RemoteSshHost {
  const ownerId = validateIdentifier(input.ownerId, "ownerId", 256);
  const targetId = validateIdentifier(input.targetId, "targetId", 256);
  const id = validateHostAlias(input.id);
  const hostname = validateHostname(input.hostname);
  const user = validateSshUser(input.user);
  const port = input.port ?? 22;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new RemoteSshError("INVALID_ARGUMENT", "port must be from 1 through 65535.", false);
  }
  const credentialRefId = input.credentialRef === undefined
    ? undefined
    : validateIdentifier(input.credentialRef.id, "credentialRef", 512);
  return Object.freeze({
    ownerId,
    targetId,
    id,
    hostname,
    port,
    user,
    ...(credentialRefId === undefined ? {} : { credentialRef: Object.freeze({ id: credentialRefId }) }),
    source: "manual"
  });
}

function validateTestTimeout(value: number | undefined): number {
  const timeoutMs = value ?? REMOTE_SSH_TEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > REMOTE_SSH_TEST_TIMEOUT_MS) {
    throw new RemoteSshError(
      "INVALID_ARGUMENT",
      `timeoutMs must be from 1 through ${REMOTE_SSH_TEST_TIMEOUT_MS}.`,
      false
    );
  }
  return timeoutMs;
}

interface NormalizedExecutionOptions {
  readonly command: string;
  readonly cwd?: string;
  readonly input?: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

function normalizeExecutionOptions(options: RemoteSshExecutionOptions): NormalizedExecutionOptions {
  if (options === null || typeof options !== "object") {
    throw new RemoteSshError("INVALID_ARGUMENT", "SSH command options are required.", false);
  }
  const command = boundedExecutionText(
    options.command,
    "command",
    REMOTE_SSH_MAXIMUM_COMMAND_BYTES,
    false
  );
  const timeoutMs = options.timeoutMs ?? REMOTE_SSH_EXECUTION_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 ||
    timeoutMs > REMOTE_SSH_MAXIMUM_EXECUTION_TIMEOUT_MS
  ) {
    throw new RemoteSshError(
      "INVALID_ARGUMENT",
      `timeoutMs must be from 1 through ${REMOTE_SSH_MAXIMUM_EXECUTION_TIMEOUT_MS}.`,
      false
    );
  }
  let cwd: string | undefined;
  if (options.cwd !== undefined) {
    cwd = boundedExecutionText(options.cwd, "cwd", 4_096, false);
    if (!cwd.startsWith("/")) {
      throw new RemoteSshError("INVALID_ARGUMENT", "cwd must be an absolute remote path.", false);
    }
  }
  const input = options.input === undefined
    ? undefined
    : boundedExecutionText(options.input, "input", REMOTE_SSH_MAXIMUM_INPUT_BYTES, true);
  return {
    command,
    ...(cwd === undefined ? {} : { cwd }),
    ...(input === undefined ? {} : { input }),
    timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal })
  };
}

function boundedExecutionText(
  value: string,
  field: string,
  maximumBytes: number,
  allowEmpty: boolean
): string {
  if (
    typeof value !== "string" || (!allowEmpty && value.length === 0) ||
    value.includes("\u0000") || Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    throw new RemoteSshError("INVALID_ARGUMENT", `${field} is invalid.`, false, { field });
  }
  return value;
}

function normalizeExecutionResult(value: AgentAuthExecutionResult): RemoteSshExecutionResult {
  if (
    value === null || typeof value !== "object" ||
    typeof value.stdout !== "string" || typeof value.stderr !== "string" ||
    !(value.exitCode === null || (Number.isSafeInteger(value.exitCode) && value.exitCode >= 0)) ||
    typeof value.outputCapped !== "boolean" ||
    (value.signal !== undefined && (
      typeof value.signal !== "string" || value.signal.length > 64 ||
      /[\u0000-\u001f\u007f]/u.test(value.signal)
    ))
  ) {
    throw new RemoteSshError("EXECUTION_PROTOCOL", "The SSH connector returned an invalid command result.", false);
  }
  const stdout = capUtf8(value.stdout, REMOTE_SSH_MAXIMUM_OUTPUT_BYTES);
  const stderr = capUtf8(value.stderr, REMOTE_SSH_MAXIMUM_OUTPUT_BYTES);
  return Object.freeze({
    stdout: stdout.text,
    stderr: stderr.text,
    exitCode: value.exitCode,
    ...(value.signal === undefined ? {} : { signal: value.signal }),
    outputCapped: value.outputCapped || stdout.capped || stderr.capped
  });
}

function capUtf8(value: string, maximumBytes: number): { readonly text: string; readonly capped: boolean } {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return { text: value, capped: false };
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), "utf8") <= maximumBytes) low = middle;
    else high = middle - 1;
  }
  return { text: value.slice(0, low), capped: true };
}

function validateIdentifier(value: string | undefined, field: string, maximum: number): string {
  if (
    typeof value !== "string" || value === "" || value !== value.trim() || value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new RemoteSshError("INVALID_ARGUMENT", `${field} is invalid.`, false, { field });
  }
  return value;
}

function validateHostAlias(value: string): string {
  const accepted = validateIdentifier(value, "id", 256);
  if (accepted.startsWith("!") || /[*?\s'"\\#]/u.test(accepted)) {
    throw new RemoteSshError("INVALID_ARGUMENT", "id must be a concrete SSH host alias.", false);
  }
  return accepted;
}

function validateHostname(value: string): string {
  const accepted = validateIdentifier(value, "hostname", 1_024);
  if (/[\s/@'"\\#]/u.test(accepted)) {
    throw new RemoteSshError("INVALID_ARGUMENT", "hostname is invalid.", false);
  }
  return accepted;
}

function validateSshUser(value: string): string {
  const accepted = validateIdentifier(value, "user", 256);
  if (/[\s@'"\\#]/u.test(accepted)) {
    throw new RemoteSshError("INVALID_ARGUMENT", "user is invalid.", false);
  }
  return accepted;
}

function forwardAbort(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (signal === undefined) return () => undefined;
  if (signal.aborted) {
    controller.abort();
    return () => undefined;
  }
  const abort = (): void => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}

function isAgentAuthConnection(value: unknown): value is AgentAuthConnection {
  return typeof value === "object" && value !== null &&
    "close" in value && typeof value.close === "function";
}

async function safeClose(connection: AgentAuthConnection): Promise<void> {
  try {
    await connection.close();
  } catch {
    // A failed close must not disclose connector details or replace the authoritative state.
  }
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new RemoteSshError("ABORTED", "The SSH connection test was aborted.", true));
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      signal.removeEventListener("abort", abort);
      reject(new RemoteSshError("ABORTED", "The SSH connection test was aborted.", true));
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      }
    );
  });
}

function normalizeHostKeyFailure(error: unknown): RemoteSshError {
  if (isRemoteSshError(error)) {
    switch (error.code) {
    case "HOST_KEY_CHANGED":
      return new RemoteSshError("HOST_KEY_CHANGED", "The remote host key changed. Connection was refused.", false);
    case "HOST_KEY_CONFLICT":
      return new RemoteSshError("HOST_KEY_CONFLICT", "Concurrent host key trust could not be established safely.", false);
    case "HOST_KEY_INVALID":
      return new RemoteSshError("HOST_KEY_INVALID", "The SSH host key is invalid.", false);
    case "HOST_KEY_MISSING":
      return new RemoteSshError("HOST_KEY_MISSING", "The SSH server did not present a host key.", false);
    case "HOST_KEY_STORE_CORRUPT":
      return new RemoteSshError("HOST_KEY_STORE_CORRUPT", "The trusted host key store is malformed.", false);
    case "HOST_KEY_STORE_MISSING":
      return new RemoteSshError("HOST_KEY_STORE_MISSING", "The trusted host key store is missing.", false);
    case "HOST_KEY_STORE_UNREADABLE":
      return new RemoteSshError("HOST_KEY_STORE_UNREADABLE", "The trusted host key store could not be read.", false);
    case "HOST_KEY_STORE_WRITE_FAILED":
      return new RemoteSshError("HOST_KEY_STORE_WRITE_FAILED", "The trusted host key store could not be written safely.", false);
    default:
      break;
    }
  }
  return new RemoteSshError(
    "HOST_KEY_STORE_UNREADABLE",
    "The remote host identity could not be verified safely.",
    false
  );
}

function normalizeConnectionFailure(
  error: unknown,
  aborted: boolean,
  timedOut: boolean
): RemoteSshError {
  if (timedOut) return abortError(true);
  if (aborted) return abortError(false);
  if (isRemoteSshError(error) && error.code === "ABORTED") return abortError(false);
  if (error instanceof ConnectorFailure) {
    if (error.code === "AUTHENTICATION_FAILED") {
      return new RemoteSshError(
        "AUTHENTICATION_FAILED",
        "SSH agent authentication failed.",
        false
      );
    }
    if (error.code === "CONNECTOR_UNAVAILABLE") {
      return new RemoteSshError(
        "CONNECTOR_UNAVAILABLE",
        "The SSH connector is unavailable.",
        true
      );
    }
    return new RemoteSshError("CONNECTION_FAILED", "The SSH connection failed.", error.retryable);
  }
  return new RemoteSshError("CONNECTION_FAILED", "The SSH connection failed safely.", true);
}

function abortError(timedOut: boolean): RemoteSshError {
  return timedOut
    ? new RemoteSshError("CONNECTION_TIMEOUT", "The SSH connection test exceeded its deadline.", true)
    : new RemoteSshError("ABORTED", "The SSH connection test was aborted.", true);
}
