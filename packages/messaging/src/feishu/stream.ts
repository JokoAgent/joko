import * as Lark from "@larksuiteoapi/node-sdk";

import { MessagingTransportError } from "../types.js";
import { requiredFeishuIdentifier } from "./codec.js";
import type {
  FeishuCallbackUpdate,
  FeishuCardActionEnvelope,
  FeishuMention,
  FeishuMessageEnvelope,
  FeishuService
} from "./model.js";

const MAXIMUM_BUFFERED_UPDATES = 1_000;

export interface FeishuSdkWsClient {
  start(input: { readonly eventDispatcher: unknown }): Promise<void>;
  close(input?: { readonly force?: boolean }): void;
}

export interface FeishuStreamClientOptions {
  readonly appId: string;
  readonly appSecret: string;
  readonly service: FeishuService;
  readonly connectionId: string;
  readonly initialCursor?: string | null;
  readonly handshakeTimeoutMs?: number;
  readonly pingTimeoutSeconds?: number;
  readonly now?: () => number;
  readonly createClient?: (input: {
    readonly onReady: () => void;
    readonly onError: (error: Error) => void;
    readonly onReconnecting: () => void;
    readonly onReconnected: () => void;
    readonly logger: Lark.Logger;
  }) => FeishuSdkWsClient;
  readonly createDispatcher?: (handlers: Readonly<Record<string, (value: unknown) => unknown>>) => unknown;
}

export interface FeishuPollResult {
  readonly updates: readonly FeishuCallbackUpdate[];
  readonly nextCursor: string;
}

export class FeishuStreamClient {
  readonly #service: FeishuService;
  readonly #connectionId: string;
  readonly #now: () => number;
  readonly #handshakeTimeoutMs: number;
  readonly #createClient: NonNullable<FeishuStreamClientOptions["createClient"]>;
  readonly #createDispatcher: NonNullable<FeishuStreamClientOptions["createDispatcher"]>;
  readonly #updates: FeishuCallbackUpdate[] = [];
  #cursor: string | null;
  #client: FeishuSdkWsClient | undefined;
  #terminalError: MessagingTransportError | undefined;
  #waiter: (() => void) | undefined;
  #closed = false;

  constructor(options: FeishuStreamClientOptions) {
    const appId = requiredFeishuIdentifier(options.appId, "app", 256);
    const appSecret = requiredSecret(options.appSecret);
    this.#service = options.service;
    this.#connectionId = requiredFeishuIdentifier(options.connectionId, "connection", 256);
    this.#cursor = options.initialCursor ?? null;
    this.#now = options.now ?? Date.now;
    this.#handshakeTimeoutMs = boundedInteger(options.handshakeTimeoutMs ?? 8_000, 500, 60_000, "handshake timeout");
    const pingTimeout = boundedInteger(options.pingTimeoutSeconds ?? 90, 10, 600, "ping timeout");
    this.#createClient = options.createClient ?? ((callbacks) => new Lark.WSClient({
      appId,
      appSecret,
      domain: options.service === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu,
      loggerLevel: Lark.LoggerLevel.info,
      autoReconnect: true,
      handshakeTimeoutMs: this.#handshakeTimeoutMs,
      wsConfig: { pingTimeout },
      ...callbacks
    }) as unknown as FeishuSdkWsClient);
    this.#createDispatcher = options.createDispatcher ?? ((handlers) => new Lark.EventDispatcher({}).register(
      handlers as Parameters<Lark.EventDispatcher["register"]>[0]
    ));
  }

  async connect(signal?: AbortSignal): Promise<void> {
    if (this.#closed) throw cancelled("Feishu WebSocket client is closed.");
    if (this.#client !== undefined) return;
    signal?.throwIfAborted();
    let ready!: () => void;
    let rejectReady!: (error: unknown) => void;
    let settled = false;
    const readiness = new Promise<void>((resolve, reject) => {
      ready = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      rejectReady = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
    });
    const logger = capturingLogger((error) => {
      this.#publishError(error);
      rejectReady(error);
    });
    const client = this.#createClient({
      onReady: ready,
      onError: (error) => {
        const mapped = websocketError(error);
        this.#publishError(mapped);
        rejectReady(mapped);
      },
      onReconnecting: () => undefined,
      onReconnected: () => undefined,
      logger
    });
    this.#client = client;
    const dispatcher = this.#createDispatcher({
      "im.message.receive_v1": (value) => {
        const message = parseMessage(value, this.#now());
        if (message !== null) this.#push({ callbackId: `message:${message.messageId}`, kind: "message", message });
        return {};
      },
      "card.action.trigger": (value) => this.#handleCardAction(value),
      "card.action.trigger_v1": (value) => this.#handleCardAction(value)
    });
    void client.start({ eventDispatcher: dispatcher }).catch((error: unknown) => {
      const mapped = websocketError(error);
      this.#publishError(mapped);
      rejectReady(mapped);
    });
    const timeout = setTimeout(() => rejectReady(new MessagingTransportError(
      "network",
      "Feishu WebSocket handshake timed out.",
      { retryable: true, effect: "none" }
    )), this.#handshakeTimeoutMs);
    const abort = () => rejectReady(cancelled("Feishu WebSocket handshake was cancelled."));
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await readiness;
    } catch (error) {
      client.close({ force: true });
      if (this.#client === client) this.#client = undefined;
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }

  async poll(input: { readonly cursor: string | null; readonly timeoutSeconds?: number; readonly signal?: AbortSignal }): Promise<FeishuPollResult> {
    if (this.#closed) throw cancelled("Feishu WebSocket client is closed.");
    if ((input.cursor ?? null) !== this.#cursor) throw invalidInput("Feishu poll cursor does not match the active connection.");
    input.signal?.throwIfAborted();
    if (this.#updates.length === 0 && this.#terminalError === undefined) {
      await this.#wait(Math.min(Math.max(input.timeoutSeconds ?? 50, 0), 50) * 1_000, input.signal);
    }
    if (this.#terminalError !== undefined) throw this.#terminalError;
    const updates = this.#updates.splice(0, 100);
    const nextCursor = updates.at(-1)?.callbackId ?? this.#cursor ?? "connected";
    this.#cursor = nextCursor;
    return { updates, nextCursor };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#client?.close({ force: true });
    this.#client = undefined;
    this.#updates.length = 0;
    this.#waiter?.();
    this.#waiter = undefined;
  }

  #handleCardAction(value: unknown): unknown {
    const action = parseCardAction(value, this.#service, this.#connectionId, this.#now());
    if (action !== null) this.#push({ callbackId: action.callbackId, kind: "card_action", action });
    return action === null ? {} : { toast: { type: "success", content: "Response received" } };
  }

  #push(update: FeishuCallbackUpdate): void {
    if (this.#closed || this.#terminalError !== undefined) return;
    if (this.#updates.length >= MAXIMUM_BUFFERED_UPDATES) {
      this.#publishError(new MessagingTransportError(
        "provider_unavailable",
        "Feishu inbound buffer is full.",
        { retryable: true, effect: "none" }
      ));
      return;
    }
    this.#updates.push(update);
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
        if (error === undefined) resolve();
        else reject(error);
      };
      const wake = () => finish();
      const abort = () => finish(cancelled("Feishu poll was cancelled."));
      const timer = setTimeout(wake, milliseconds);
      this.#waiter = wake;
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted === true) abort();
    });
  }
}

function parseMessage(value: unknown, now: number): FeishuMessageEnvelope | null {
  if (!isRecord(value)) return null;
  const sender = recordValue(value["sender"]);
  const senderId = recordValue(sender?.["sender_id"]);
  const message = recordValue(value["message"]);
  if (message === undefined) return null;
  const messageId = cleanId(message["message_id"]);
  const chatId = cleanId(message["chat_id"]);
  const senderOpenId = cleanId(senderId?.["open_id"]);
  const chatType = message["chat_type"] === "p2p" ? "p2p" : message["chat_type"] === "group" ? "group" : undefined;
  if (messageId === undefined || chatId === undefined || senderOpenId === undefined || chatType === undefined) return null;
  const mentions: FeishuMention[] = [];
  if (Array.isArray(message["mentions"])) {
    for (const raw of message["mentions"]) {
      if (!isRecord(raw)) continue;
      const id = recordValue(raw["id"]);
      const key = stringValue(raw["key"]);
      const openId = cleanId(id?.["open_id"]);
      if (key === "" || openId === undefined) continue;
      mentions.push({ key, openId, name: boundedText(stringValue(raw["name"]), 128) });
    }
  }
  return {
    messageId,
    chatId,
    chatType,
    messageType: stringValue(message["message_type"]),
    content: stringValue(message["content"]),
    senderOpenId,
    senderName: boundedText(stringValue(sender?.["sender_name"]), 128) || senderOpenId,
    senderIsBot: sender?.["sender_type"] === "app",
    threadId: cleanId(message["thread_id"]) ?? null,
    parentId: cleanId(message["parent_id"]) ?? null,
    rootId: cleanId(message["root_id"]) ?? null,
    mentions,
    occurredAt: providerTime(message["create_time"], now)
  };
}

function parseCardAction(
  value: unknown,
  service: FeishuService,
  connectionId: string,
  now: number
): FeishuCardActionEnvelope | null {
  if (!isRecord(value)) return null;
  const operator = recordValue(value["operator"]);
  const context = recordValue(value["context"]);
  const action = recordValue(value["action"]);
  const actionValue = recordValue(action?.["value"]);
  const coordinate = recordValue(actionValue?.["joko_address"]);
  const operatorOpenId = cleanId(operator?.["open_id"]);
  const messageId = cleanId(context?.["open_message_id"]);
  const chatId = cleanId(context?.["open_chat_id"]);
  const actionId = cleanId(actionValue?.["id"]);
  if (operatorOpenId === undefined || messageId === undefined || chatId === undefined || actionId === undefined
    || coordinate === undefined || coordinate["channel"] !== service || coordinate["connection_id"] !== connectionId) return null;
  const providerConversationId = cleanId(coordinate["conversation_id"]);
  const rawThread = coordinate["thread_id"];
  const parsedThreadId = rawThread === null ? null : cleanId(rawThread);
  const conversationKind = coordinate["conversation_kind"];
  if (providerConversationId === undefined || (rawThread !== null && parsedThreadId === undefined)
    || (conversationKind !== "direct" && conversationKind !== "group")) return null;
  const providerThreadId = parsedThreadId ?? null;
  return {
    callbackId: `card:${messageId}:${operatorOpenId}:${actionId}`,
    messageId,
    chatId,
    operatorOpenId,
    actionValue: actionId,
    address: {
      channel: service,
      connectionId,
      providerConversationId,
      providerThreadId,
      conversationKind
    },
    occurredAt: now
  };
}

function capturingLogger(onConflict: (error: MessagingTransportError) => void): Lark.Logger {
  const inspect = (...values: unknown[]) => {
    const text = values.map((value) => typeof value === "string" ? value : value instanceof Error ? value.message : "").join(" ");
    if (/exceed[_\s-]*conn[_\s-]*limit|connection.{0,16}(?:limit|conflict)/iu.test(text)) {
      onConflict(new MessagingTransportError(
        "conflict",
        "Another Feishu/Lark WebSocket client is using this application.",
        { retryable: false, effect: "none" }
      ));
    }
  };
  return { error: inspect, warn: inspect, info: inspect, debug: () => undefined, trace: () => undefined };
}

function websocketError(error: unknown): MessagingTransportError {
  if (error instanceof MessagingTransportError) return error;
  const message = error instanceof Error ? error.message : "";
  if (/exceed[_\s-]*conn[_\s-]*limit|connection.{0,16}(?:limit|conflict)/iu.test(message)) {
    return new MessagingTransportError("conflict", "Another Feishu/Lark WebSocket client is using this application.", {
      retryable: false,
      effect: "none"
    });
  }
  if (/(?:invalid|expired).{0,20}(?:app|credential|secret|token)|(?:app|secret|token).{0,20}(?:invalid|expired)/iu.test(message)) {
    return new MessagingTransportError("invalid_credential", "Feishu rejected the application credential.", {
      retryable: false,
      effect: "none"
    });
  }
  return new MessagingTransportError("network", "Feishu WebSocket connection failed.", { retryable: true, effect: "none" });
}

function cleanId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length >= 1 && normalized.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(normalized)
    ? normalized
    : undefined;
}

function providerTime(value: unknown, fallback: number): number {
  if (typeof value !== "string" || !/^[0-9]{1,16}$/u.test(value)) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return fallback;
  return parsed < 10_000_000_000 ? parsed * 1_000 : parsed;
}

function boundedText(value: string, maximum: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, maximum);
}

function requiredSecret(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw invalidInput("Feishu application secret is invalid.");
  }
  return normalized;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw invalidInput(`Feishu ${label} is invalid.`);
  return value;
}

function cancelled(message: string): MessagingTransportError {
  return new MessagingTransportError("cancelled", message, { retryable: false, effect: "none" });
}

function invalidInput(message: string): MessagingTransportError {
  return new MessagingTransportError("invalid_input", message, { retryable: false, effect: "none" });
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
