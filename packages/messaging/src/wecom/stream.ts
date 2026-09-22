import { WSClient, type BaseMessage, type WSClientOptions, type WsFrame } from "@wecom/aibot-node-sdk";

import { MessagingTransportError } from "../types.js";
import { requiredWeComIdentifier } from "./codec.js";
import type { WeComCallbackUpdate } from "./model.js";

const MAXIMUM_BUFFERED_UPDATES = 1_000;

type WeComSdkEventMap = {
  readonly authenticated: () => void;
  readonly reconnecting: (attempt: number) => void;
  readonly disconnected: (reason: string) => void;
  readonly error: (error: Error) => void;
  readonly "event.disconnected_event": (frame: unknown) => void;
  readonly message: (frame: WsFrame<BaseMessage>) => void;
};

export interface WeComSdkClient {
  on<K extends keyof WeComSdkEventMap>(event: K, listener: WeComSdkEventMap[K]): unknown;
  connect(): unknown;
  disconnect(): void;
  readonly isConnected: boolean;
  replyStream(frame: WsFrame<BaseMessage>, streamId: string, content: string, finish?: boolean): Promise<unknown>;
  sendMessage(chatId: string, body: { readonly msgtype: "markdown"; readonly markdown: { readonly content: string } }): Promise<unknown>;
  uploadMedia(buffer: Buffer, options: { readonly type: "image" | "file" | "voice" | "video"; readonly filename: string }): Promise<{ readonly media_id: string }>;
  replyMedia(frame: WsFrame<BaseMessage>, type: "image" | "file" | "voice" | "video", mediaId: string): Promise<unknown>;
  sendMediaMessage(chatId: string, type: "image" | "file" | "voice" | "video", mediaId: string): Promise<unknown>;
  downloadFile(url: string, aesKey?: string): Promise<{ readonly buffer: Buffer; readonly filename?: string }>;
}

export interface WeComStreamOptions {
  readonly botId: string;
  readonly secret: string;
  readonly initialCursor?: string | null;
  readonly handshakeTimeoutMs?: number;
  readonly now?: () => number;
  readonly createClient?: (options: WSClientOptions) => WeComSdkClient;
}

export interface WeComPollResult {
  readonly updates: readonly WeComCallbackUpdate[];
  readonly nextCursor: string;
}

export class WeComStreamClient {
  readonly #botId: string;
  readonly #secret: string;
  readonly #now: () => number;
  readonly #handshakeTimeoutMs: number;
  readonly #createClient: NonNullable<WeComStreamOptions["createClient"]>;
  readonly #updates: WeComCallbackUpdate[] = [];
  #cursor: string | null;
  #client: WeComSdkClient | undefined;
  #terminalError: MessagingTransportError | undefined;
  #waiter: (() => void) | undefined;
  #closed = false;

  constructor(options: WeComStreamOptions) {
    this.#botId = requiredWeComIdentifier(options.botId, "bot", 512);
    this.#secret = requiredSecret(options.secret);
    this.#cursor = options.initialCursor ?? null;
    this.#now = options.now ?? Date.now;
    this.#handshakeTimeoutMs = boundedInteger(options.handshakeTimeoutMs ?? 10_000, 500, 60_000, "handshake timeout");
    this.#createClient = options.createClient ?? ((clientOptions) => new WSClient(clientOptions) as unknown as WeComSdkClient);
  }

  get client(): WeComSdkClient {
    if (this.#client === undefined || this.#closed) throw cancelled("WeCom WebSocket client is unavailable.");
    return this.#client;
  }

  async connect(signal?: AbortSignal): Promise<void> {
    if (this.#closed) throw cancelled("WeCom WebSocket client is closed.");
    if (this.#client !== undefined) return;
    signal?.throwIfAborted();
    let resolveReady!: () => void;
    let rejectReady!: (error: unknown) => void;
    let settled = false;
    const readiness = new Promise<void>((resolve, reject) => {
      resolveReady = () => { if (!settled) { settled = true; resolve(); } };
      rejectReady = (error) => { if (!settled) { settled = true; reject(error); } };
    });
    const client = this.#createClient({
      botId: this.#botId,
      secret: this.#secret,
      maxReconnectAttempts: -1,
      maxAuthFailureAttempts: 3,
      logger: redactingLogger(this.#botId, this.#secret)
    });
    this.#client = client;
    client.on("authenticated", resolveReady);
    client.on("message", (frame) => this.#push(frame));
    client.on("event.disconnected_event", () => {
      const error = new MessagingTransportError("conflict", "Another WeCom client is using this bot.", {
        retryable: false,
        effect: "none"
      });
      this.#publishError(error);
      rejectReady(error);
    });
    client.on("error", (error) => {
      const mapped = mapWeComConnectionError(error);
      this.#publishError(mapped);
      rejectReady(mapped);
    });
    client.on("reconnecting", () => {
      const error = recoverableDisconnect();
      this.#publishError(error);
      rejectReady(error);
    });
    client.on("disconnected", () => {
      const error = recoverableDisconnect();
      this.#publishError(error);
      rejectReady(error);
    });
    try {
      client.connect();
    } catch (error) {
      rejectReady(mapWeComConnectionError(error));
    }
    const timeout = setTimeout(() => rejectReady(new MessagingTransportError(
      "network",
      "WeCom WebSocket authentication timed out.",
      { retryable: true, effect: "none" }
    )), this.#handshakeTimeoutMs);
    const abort = () => rejectReady(cancelled("WeCom WebSocket authentication was cancelled."));
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await readiness;
    } catch (error) {
      client.disconnect();
      if (this.#client === client) this.#client = undefined;
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }

  async poll(input: { readonly cursor: string | null; readonly timeoutSeconds?: number; readonly signal?: AbortSignal }): Promise<WeComPollResult> {
    if (this.#closed) throw cancelled("WeCom WebSocket client is closed.");
    if ((input.cursor ?? null) !== this.#cursor) throw invalidInput("WeCom poll cursor does not match the active connection.");
    input.signal?.throwIfAborted();
    if (this.#updates.length === 0 && this.#terminalError === undefined) {
      await this.#wait(Math.min(Math.max(input.timeoutSeconds ?? 50, 0), 50) * 1_000, input.signal);
    }
    // Admit callbacks that arrived before the terminal connection signal.
    // Their cursor is still the last durable position; dropping them here
    // would make a WebSocket-only delivery unrecoverable after reconnect.
    if (this.#terminalError !== undefined && this.#updates.length === 0) throw this.#terminalError;
    const updates = this.#updates.splice(0, 100);
    const nextCursor = updates.at(-1)?.callbackId ?? this.#cursor ?? "connected";
    this.#cursor = nextCursor;
    return { updates, nextCursor };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#client?.disconnect();
    this.#client = undefined;
    this.#updates.length = 0;
    this.#waiter?.();
    this.#waiter = undefined;
  }

  #push(frame: WsFrame<BaseMessage>): void {
    if (this.#closed || this.#terminalError !== undefined) return;
    const messageId = frame.body?.msgid?.trim();
    const requestId = frame.headers?.req_id?.trim();
    if (!messageId || !requestId) return;
    if (this.#updates.length >= MAXIMUM_BUFFERED_UPDATES) {
      this.#publishError(new MessagingTransportError("provider_unavailable", "WeCom inbound buffer is full.", {
        retryable: true,
        effect: "none"
      }));
      return;
    }
    this.#updates.push({ callbackId: `wecom:callback:${messageId}:${requestId}`, receivedAt: this.#now(), frame });
    this.#waiter?.();
    this.#waiter = undefined;
  }

  #publishError(error: MessagingTransportError): void {
    if (this.#closed || this.#terminalError !== undefined) return;
    this.#terminalError = error;
    this.#waiter?.();
    this.#waiter = undefined;
  }

  #wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (milliseconds === 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (this.#waiter === wake) this.#waiter = undefined;
        if (error === undefined) resolve(); else reject(error);
      };
      const wake = () => finish();
      const abort = () => finish(cancelled("WeCom poll was cancelled."));
      const timer = setTimeout(wake, milliseconds);
      this.#waiter = wake;
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted === true) abort();
    });
  }
}

export function mapWeComConnectionError(error: unknown): MessagingTransportError {
  if (error instanceof MessagingTransportError) return error;
  const code = isRecord(error) && typeof error["code"] === "string" ? error["code"] : "";
  const message = error instanceof Error ? error.message : "";
  if (code === "WS_AUTH_FAILURE_EXHAUSTED" || /authentication failed|invalid.{0,20}(?:secret|credential)/iu.test(message)) {
    return new MessagingTransportError("invalid_credential", "WeCom rejected the bot credential.", {
      retryable: false,
      effect: "none"
    });
  }
  if (code === "WS_RECONNECT_EXHAUSTED") {
    return new MessagingTransportError("network", "WeCom WebSocket reconnection was exhausted.", {
      retryable: true,
      effect: "none"
    });
  }
  return new MessagingTransportError("network", "WeCom WebSocket connection failed.", {
    retryable: true,
    effect: "none"
  });
}

function redactingLogger(botId: string, secret: string): NonNullable<WSClientOptions["logger"]> {
  const clean = (message: string) => {
    let output = String(message).replace(/https?:\/\/\S+/giu, "[url]");
    for (const sensitive of [botId, secret]) output = output.split(sensitive).join("[redacted]");
    return output.replace(/[A-Za-z0-9_-]{32,}/gu, "[redacted]").slice(0, 500);
  };
  return { debug: (message) => void clean(message), info: (message) => void clean(message), warn: (message) => void clean(message), error: (message) => void clean(message) };
}

function requiredSecret(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw invalidInput("WeCom bot secret is invalid.");
  }
  return normalized;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw invalidInput(`WeCom ${label} is invalid.`);
  return value;
}

function cancelled(message: string): MessagingTransportError {
  return new MessagingTransportError("cancelled", message, { retryable: false, effect: "none" });
}

function recoverableDisconnect(): MessagingTransportError {
  return new MessagingTransportError("network", "WeCom WebSocket disconnected and will be reconnected.", {
    retryable: true,
    effect: "none"
  });
}

function invalidInput(message: string): MessagingTransportError {
  return new MessagingTransportError("invalid_input", message, { retryable: false, effect: "none" });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
