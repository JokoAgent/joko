import WebSocket, { type RawData } from "ws";

import { MessagingTransportError } from "../types.js";
import type { SlackPollResult, SlackSocketUpdate } from "./model.js";

const MAXIMUM_SOCKET_MESSAGE_BYTES = 1024 * 1024;
const MAXIMUM_PENDING_ENVELOPES = 64;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;

interface PendingEnvelope {
  readonly update: SlackSocketUpdate;
  readonly socket: WebSocket;
}

export interface SlackSocketClientOptions {
  readonly openUrl: (signal?: AbortSignal) => Promise<string>;
  readonly initialCursor?: string | null;
  readonly createSocket?: (url: string) => WebSocket;
  readonly handshakeTimeoutMs?: number;
}

export class SlackSocketClient {
  readonly #openUrl: SlackSocketClientOptions["openUrl"];
  readonly #createSocket: (url: string) => WebSocket;
  readonly #handshakeTimeoutMs: number;
  readonly #waiters = new Set<() => void>();
  readonly #pending: PendingEnvelope[] = [];
  #socket: WebSocket | null = null;
  #connecting: Promise<void> | null = null;
  #cursor: string;
  #lastAcknowledgedEnvelopeId: string | null = null;
  #terminalError: MessagingTransportError | null = null;
  #stopped = false;

  constructor(options: SlackSocketClientOptions) {
    this.#openUrl = options.openUrl;
    this.#createSocket = options.createSocket ?? ((url) => new WebSocket(url));
    this.#handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.#handshakeTimeoutMs) || this.#handshakeTimeoutMs < 100 || this.#handshakeTimeoutMs > 60_000) {
      throw invalid("Slack Socket handshake timeout is invalid.");
    }
    this.#cursor = options.initialCursor ?? "slack:0";
    if (this.#cursor.length > 512) throw invalid("Slack cursor is invalid.");
  }

  async connect(signal?: AbortSignal): Promise<void> {
    if (this.#stopped) throw cancelled();
    if (this.#terminalError !== null) throw this.#terminalError;
    if (this.#connecting !== null) return withAbort(this.#connecting, signal);
    if (this.#socket?.readyState === WebSocket.OPEN) return;
    if (this.#connecting === null) {
      const connecting = this.#open(signal);
      this.#connecting = connecting;
      void connecting.finally(() => { if (this.#connecting === connecting) this.#connecting = null; }).catch(() => undefined);
    }
    await withAbort(this.#connecting, signal);
  }

  async poll(input: { readonly cursor: string | null; readonly timeoutSeconds?: number; readonly signal?: AbortSignal }): Promise<SlackPollResult> {
    const timeout = input.timeoutSeconds ?? 50;
    if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 50) throw invalid("Slack poll timeout must be between 0 and 50 seconds.");
    if (this.#stopped) throw cancelled();
    const deadline = Date.now() + timeout * 1_000;
    while (this.#pending.length === 0) {
      if (this.#terminalError !== null) throw this.#terminalError;
      await this.connect(input.signal);
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await this.#waitForChange(remaining, input.signal);
    }
    const pending = this.#pending[0];
    if (pending === undefined) return { updates: [], nextCursor: input.cursor ?? this.#cursor, envelopeId: null };
    const nextCursor = `slack:${pending.update.envelopeId}`;
    return { updates: [pending.update], nextCursor, envelopeId: pending.update.envelopeId };
  }

  async acknowledge(envelopeId: string, signal?: AbortSignal): Promise<void> {
    const pending = this.#pending[0];
    if (pending === undefined && envelopeId === this.#lastAcknowledgedEnvelopeId) return;
    if (pending === undefined || pending.update.envelopeId !== envelopeId) throw invalid("Slack ACK does not match the pending envelope.");
    signal?.throwIfAborted();
    if (pending.socket.readyState !== WebSocket.OPEN) throw network("Slack Socket closed before ACK.");
    await new Promise<void>((resolve, reject) => {
      pending.socket.send(JSON.stringify({ envelope_id: envelopeId }), (error) => {
        if (error) reject(network("Slack Socket ACK failed."));
        else resolve();
      });
    });
    this.#pending.shift();
    this.#cursor = `slack:${envelopeId}`;
    this.#lastAcknowledgedEnvelopeId = envelopeId;
    this.#notify();
  }

  async close(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    const socket = this.#socket;
    this.#socket = null;
    this.#pending.length = 0;
    this.#notify();
    if (socket !== null && socket.readyState !== WebSocket.CLOSED) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 250);
        timer.unref?.();
        socket.once("close", () => { clearTimeout(timer); resolve(); });
        socket.close(1000, "Joko transport closed");
      });
      if (Number(socket.readyState) !== WebSocket.CLOSED) socket.terminate();
    }
  }

  async #open(signal?: AbortSignal): Promise<void> {
    const url = await this.#openUrl(signal);
    if (this.#stopped) throw cancelled();
    const socket = this.#createSocket(url);
    this.#socket = socket;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: MessagingTransportError): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error === undefined) resolve(); else reject(error);
      };
      const timer = setTimeout(() => {
        socket.terminate();
        finish(network("Slack Socket handshake timed out."));
      }, this.#handshakeTimeoutMs);
      timer.unref?.();
      socket.on("message", (raw) => {
        try {
          this.#handleMessage(socket, raw, () => finish());
        } catch {
          const error = malformed("Slack Socket sent an invalid frame.");
          this.#terminalError = error;
          socket.close(1002, "Invalid Socket frame");
          finish(error);
        }
      });
      socket.once("error", () => {
        if (this.#socket === socket) this.#socket = null;
        this.#notify();
        finish(network("Slack Socket connection failed."));
      });
      socket.once("close", () => {
        if (this.#socket === socket) this.#socket = null;
        // A closed Socket cannot receive an ACK. Let Slack redeliver these
        // envelopes on a fresh connection instead of trapping the head forever.
        for (let index = this.#pending.length - 1; index >= 0; index -= 1) {
          if (this.#pending[index]?.socket === socket) this.#pending.splice(index, 1);
        }
        this.#notify();
        finish(network("Slack Socket disconnected."));
      });
    });
  }

  #handleMessage(socket: WebSocket, raw: RawData, hello: () => void): void {
    if (this.#socket !== socket || this.#stopped) return;
    const bytes = rawBytes(raw);
    if (bytes.byteLength > MAXIMUM_SOCKET_MESSAGE_BYTES) throw malformed("Slack Socket frame exceeds the size limit.");
    let decoded: unknown;
    try { decoded = JSON.parse(bytes.toString("utf8")); } catch { throw malformed("Slack Socket frame is not JSON."); }
    const packet = object(decoded);
    if (packet.type === "hello") { hello(); return; }
    if (packet.type === "disconnect") {
      if (packet.reason === "link_disabled") this.#terminalError = new MessagingTransportError(
        "invalid_credential", "Slack Socket Mode was disabled.", { retryable: false, effect: "none" }
      );
      socket.close(1000, "Slack requested a new connection");
      this.#notify();
      return;
    }
    const envelopeId = packet.envelope_id;
    if (typeof envelopeId !== "string" || envelopeId.length < 1 || envelopeId.length > 256 || /[\u0000-\u001f\u007f]/u.test(envelopeId)) {
      throw malformed("Slack Socket envelope identity is invalid.");
    }
    if (this.#pending.length >= MAXIMUM_PENDING_ENVELOPES) {
      this.#terminalError = new MessagingTransportError("conflict", "Slack Socket inbound queue is full.", { retryable: true, effect: "none" });
      socket.close(1013, "Inbound queue full");
      this.#notify();
      return;
    }
    const type = packet.type === "events_api" || packet.type === "interactive" || packet.type === "slash_commands"
      ? packet.type : "unknown";
    this.#pending.push({
      socket,
      update: { envelopeId, type, payload: packet.payload, acceptsResponsePayload: packet.accepts_response_payload === true }
    });
    this.#notify();
  }

  async #waitForChange(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw cancelled();
    await new Promise<void>((resolve, reject) => {
      const done = (): void => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); this.#waiters.delete(onChange); resolve(); };
      const onChange = (): void => done();
      const onAbort = (): void => { clearTimeout(timer); this.#waiters.delete(onChange); reject(cancelled()); };
      const timer = setTimeout(done, timeoutMs);
      timer.unref?.();
      this.#waiters.add(onChange);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  #notify(): void { for (const waiter of [...this.#waiters]) waiter(); }
}

function rawBytes(value: RawData): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) return Buffer.concat(value);
  return Buffer.from(value);
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { signal.removeEventListener("abort", onAbort); reject(cancelled()); };
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then((value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error); });
  });
}
function invalid(message: string): MessagingTransportError {
  return new MessagingTransportError("invalid_input", message, { retryable: false, effect: "none" });
}
function cancelled(): MessagingTransportError {
  return new MessagingTransportError("cancelled", "Slack Socket operation was cancelled.", { retryable: false, effect: "none" });
}
function network(message: string): MessagingTransportError {
  return new MessagingTransportError("network", message, { retryable: true, effect: "none" });
}
function malformed(message: string): MessagingTransportError {
  return new MessagingTransportError("malformed_response", message, { retryable: false, effect: "none" });
}
