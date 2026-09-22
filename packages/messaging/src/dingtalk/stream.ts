import { Buffer } from "node:buffer";

import WebSocket, { type RawData } from "ws";

import { MessagingTransportError } from "../types.js";
import type { DingTalkApi, DingTalkGatewayConnection } from "./api.js";
import type { DingTalkCallbackUpdate } from "./model.js";

const ROBOT_TOPIC = "/v1.0/im/bot/messages/get";
const MAXIMUM_STREAM_MESSAGE_BYTES = 1024 * 1024;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 8_000;

export interface DingTalkStreamCursor {
  readonly format: 1;
  readonly lastCallbackMessageId: string | null;
}

export interface DingTalkStreamPollResult {
  readonly updates: readonly DingTalkCallbackUpdate[];
  readonly nextCursor: string;
}

export interface DingTalkStreamClientOptions {
  readonly api: Pick<DingTalkApi, "openGateway">;
  readonly initialCursor?: string | null;
  readonly handshakeTimeoutMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly createSocket?: (url: string) => WebSocket;
}

export class DingTalkStreamClient {
  readonly #api: DingTalkStreamClientOptions["api"];
  readonly #handshakeTimeoutMs: number;
  readonly #heartbeatIntervalMs: number;
  readonly #createSocket: (url: string) => WebSocket;
  readonly #updates: DingTalkCallbackUpdate[] = [];
  readonly #waiters = new Set<() => void>();
  #cursor: DingTalkStreamCursor;
  #socket: WebSocket | null = null;
  #connectPromise: Promise<void> | null = null;
  #heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  #awaitingPong = false;
  #stopped = false;
  #terminalError: MessagingTransportError | null = null;

  constructor(options: DingTalkStreamClientOptions) {
    this.#api = options.api;
    this.#cursor = decodeDingTalkStreamCursor(options.initialCursor ?? null);
    this.#handshakeTimeoutMs = boundedInteger(
      options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
      100,
      60_000,
      "Stream handshake timeout"
    );
    this.#heartbeatIntervalMs = boundedInteger(
      options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
      100,
      60_000,
      "Stream heartbeat interval"
    );
    this.#createSocket = options.createSocket ?? ((url) => new WebSocket(url, { maxPayload: MAXIMUM_STREAM_MESSAGE_BYTES }));
  }

  async connect(signal?: AbortSignal): Promise<void> {
    if (this.#stopped) throw cancelled();
    if (this.#terminalError !== null) throw this.#terminalError;
    if (this.#socket?.readyState === WebSocket.OPEN) return;
    if (this.#connectPromise === null) {
      const promise = this.#openSocket(signal);
      this.#connectPromise = promise;
      void promise.finally(() => {
        if (this.#connectPromise === promise) this.#connectPromise = null;
      }).catch(() => undefined);
    }
    await withAbort(this.#connectPromise, signal);
  }

  async poll(input: {
    readonly timeoutSeconds?: number;
    readonly signal?: AbortSignal;
  }): Promise<DingTalkStreamPollResult> {
    const timeoutSeconds = input.timeoutSeconds ?? 50;
    if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 0 || timeoutSeconds > 50) {
      throw invalidInput("DingTalk poll timeout must be between 0 and 50 seconds.");
    }
    await this.connect(input.signal);
    const deadline = Date.now() + timeoutSeconds * 1_000;
    while (this.#updates.length === 0 && timeoutSeconds > 0) {
      if (this.#terminalError !== null) throw this.#terminalError;
      if (this.#socket?.readyState !== WebSocket.OPEN) throw network("DingTalk Stream disconnected.");
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await this.#waitForChange(remaining, input.signal);
    }
    if (this.#terminalError !== null && this.#updates.length === 0) throw this.#terminalError;
    const updates = this.#updates.splice(0, 100);
    if (updates.length > 0) {
      this.#cursor = { format: 1, lastCallbackMessageId: updates.at(-1)!.callbackMessageId };
    }
    return { updates, nextCursor: encodeDingTalkStreamCursor(this.#cursor) };
  }

  async close(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#clearHeartbeat();
    const socket = this.#socket;
    this.#socket = null;
    if (socket !== null && socket.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 250);
        timer.unref?.();
        socket.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
        socket.close(1000, "Joko transport closed");
      });
      if (Number(socket.readyState) !== WebSocket.CLOSED) socket.terminate();
    }
    this.#notify();
  }

  async #openSocket(signal?: AbortSignal): Promise<void> {
    const gateway = await this.#api.openGateway(signal);
    if (this.#stopped) throw cancelled();
    const socket = this.#createSocket(gatewaySocketUrl(gateway));
    this.#socket = socket;
    this.#terminalError = null;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.terminate();
        reject(network("DingTalk Stream handshake timed out."));
      }, this.#handshakeTimeoutMs);
      timeout.unref?.();
      const finish = (error?: MessagingTransportError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error === undefined) resolve();
        else reject(error);
      };
      socket.once("open", () => {
        this.#awaitingPong = false;
        this.#scheduleHeartbeat(socket);
        finish();
      });
      socket.on("pong", () => {
        if (this.#socket === socket) this.#awaitingPong = false;
      });
      socket.on("message", (data) => {
        try {
          this.#handleMessage(socket, data);
        } catch (error) {
          const failure = error instanceof MessagingTransportError
            ? error
            : malformed("DingTalk Stream sent an invalid message.");
          this.#terminalError = failure;
          socket.close(1002, "Invalid Stream message");
          finish(failure);
          this.#notify();
        }
      });
      socket.once("error", () => {
        const failure = network("DingTalk Stream connection failed.");
        if (this.#socket === socket && !this.#stopped) this.#terminalError = failure;
        finish(failure);
        this.#notify();
      });
      socket.once("close", () => {
        if (this.#socket === socket) {
          this.#socket = null;
          this.#clearHeartbeat();
          if (!this.#stopped && this.#terminalError === null) {
            this.#terminalError = network("DingTalk Stream disconnected.");
          }
        }
        finish(this.#stopped ? cancelled() : this.#terminalError ?? network("DingTalk Stream disconnected."));
        this.#notify();
      });
    });
  }

  #handleMessage(socket: WebSocket, raw: RawData): void {
    const text = rawText(raw);
    if (Buffer.byteLength(text, "utf8") > MAXIMUM_STREAM_MESSAGE_BYTES) {
      throw malformed("DingTalk Stream message is too large.");
    }
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      throw malformed("DingTalk Stream message is not JSON.");
    }
    if (!isRecord(value) || !isRecord(value["headers"]) || typeof value["type"] !== "string") {
      throw malformed("DingTalk Stream envelope is invalid.");
    }
    const headers = value["headers"];
    const messageId = providerIdentifier(headers["messageId"], "callback message");
    const topic = providerIdentifier(headers["topic"], "callback topic");
    if (value["type"] === "SYSTEM") {
      if (topic === "ping") {
        this.#send(socket, {
          code: 200,
          headers,
          message: "OK",
          data: typeof value["data"] === "string" ? value["data"] : ""
        });
      } else if (topic === "disconnect") {
        this.#terminalError = network("DingTalk Stream requested a reconnect.");
        socket.close(1012, "Provider requested reconnect");
      } else if (topic === "KEEPALIVE") {
        this.#awaitingPong = false;
      }
      return;
    }
    if (value["type"] !== "CALLBACK" || topic !== ROBOT_TOPIC || typeof value["data"] !== "string") return;

    // Provider callback acknowledgement is protocol-critical and intentionally
    // precedes slow attachment adoption / Session dispatch. The durable request
    // identity below still makes provider retries idempotent.
    this.#send(socket, {
      code: 200,
      headers: { contentType: "application/json", messageId },
      message: "OK",
      data: JSON.stringify({ response: { success: true } })
    });
    let payload: unknown;
    try {
      payload = JSON.parse(value["data"]) as unknown;
    } catch {
      payload = null;
    }
    this.#updates.push({ callbackMessageId: messageId, payload });
    this.#notify();
  }

  #send(socket: WebSocket, value: unknown): void {
    if (socket.readyState !== WebSocket.OPEN) throw network("DingTalk Stream is not writable.");
    socket.send(JSON.stringify(value));
  }

  #scheduleHeartbeat(socket: WebSocket): void {
    this.#clearHeartbeat();
    this.#heartbeatTimer = setTimeout(() => {
      if (this.#socket !== socket || this.#stopped || socket.readyState !== WebSocket.OPEN) return;
      if (this.#awaitingPong) {
        this.#terminalError = network("DingTalk Stream heartbeat acknowledgement timed out.");
        socket.terminate();
        this.#notify();
        return;
      }
      this.#awaitingPong = true;
      socket.ping();
      this.#scheduleHeartbeat(socket);
    }, this.#heartbeatIntervalMs);
    this.#heartbeatTimer.unref?.();
  }

  #clearHeartbeat(): void {
    if (this.#heartbeatTimer !== null) clearTimeout(this.#heartbeatTimer);
    this.#heartbeatTimer = null;
    this.#awaitingPong = false;
  }

  async #waitForChange(milliseconds: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const complete = () => {
        clearTimeout(timer);
        this.#waiters.delete(complete);
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        clearTimeout(timer);
        this.#waiters.delete(complete);
        reject(cancelled());
      };
      const timer = setTimeout(complete, milliseconds);
      timer.unref?.();
      this.#waiters.add(complete);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  #notify(): void {
    const waiters = [...this.#waiters];
    for (const waiter of waiters) waiter();
  }
}

export function encodeDingTalkStreamCursor(cursor: DingTalkStreamCursor): string {
  return JSON.stringify(cursor);
}

export function decodeDingTalkStreamCursor(value: string | null): DingTalkStreamCursor {
  if (value === null) return { format: 1, lastCallbackMessageId: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw invalidInput("DingTalk Stream cursor is invalid.");
  }
  if (!isRecord(parsed) || parsed["format"] !== 1
    || !Object.hasOwn(parsed, "lastCallbackMessageId")
    || (parsed["lastCallbackMessageId"] !== null
      && (typeof parsed["lastCallbackMessageId"] !== "string"
        || parsed["lastCallbackMessageId"].length < 1
        || parsed["lastCallbackMessageId"].length > 512))) {
    throw invalidInput("DingTalk Stream cursor is invalid.");
  }
  return {
    format: 1,
    lastCallbackMessageId: parsed["lastCallbackMessageId"] as string | null
  };
}

function gatewaySocketUrl(connection: DingTalkGatewayConnection): string {
  const url = new URL(connection.endpoint);
  url.searchParams.set("ticket", connection.ticket);
  return url.toString();
}

function rawText(value: RawData): string {
  if (typeof value === "string") return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString("utf8");
  if (Array.isArray(value)) return Buffer.concat(value).toString("utf8");
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("utf8");
}

function providerIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string") throw malformed(`DingTalk ${label} identity is invalid.`);
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 512 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw malformed(`DingTalk ${label} identity is invalid.`);
  }
  return normalized;
}

async function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise;
  signal.throwIfAborted();
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(cancelled()), { once: true });
    })
  ]);
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw invalidInput(`DingTalk ${label} is invalid.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidInput(message: string): MessagingTransportError {
  return new MessagingTransportError("invalid_input", message, { retryable: false, effect: "none" });
}

function malformed(message: string): MessagingTransportError {
  return new MessagingTransportError("malformed_response", message, { retryable: false, effect: "none" });
}

function network(message: string): MessagingTransportError {
  return new MessagingTransportError("network", message, { retryable: true, effect: "none" });
}

function cancelled(): MessagingTransportError {
  return new MessagingTransportError("cancelled", "DingTalk Stream operation was cancelled.", {
    retryable: false,
    effect: "none"
  });
}
