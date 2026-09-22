import { randomUUID } from "node:crypto";
import type { BaseMessage, WSClientOptions, WsFrame } from "@wecom/aibot-node-sdk";

import {
  MessagingTransportError,
  type MessagingAddress,
  type MessagingConnectionProbe,
  type MessagingDownloadedAttachment,
  type MessagingInboundAttachment,
  type MessagingSendReceipt
} from "../types.js";
import { requiredWeComIdentifier, weComAddress, weComAttachmentCoordinate } from "./codec.js";
import { classifyWeComOutbound, validateWeComDownload } from "./media.js";
import type { WeComCallbackUpdate, WeComTransientMediaCoordinate } from "./model.js";
import { normalizeWeComUpdates, parseWeComContent, type WeComNormalizationResult } from "./normalize.js";
import { WeComStreamClient, type WeComPollResult, type WeComSdkClient } from "./stream.js";
import { splitWeComText } from "./text.js";

const CALLBACK_TTL_MS = 4 * 60_000;
const CALLBACK_QUEUE_CAPACITY = 64;
const STREAM_SAFE_TIMEOUT_MS = 2 * 60_000 + 45_000;
const MAXIMUM_TRANSIENT_COORDINATES = 2_048;
const MAXIMUM_INTERACTION_CHOICES = 9;

interface PendingFrame { readonly frame: WsFrame<BaseMessage>; readonly receivedAt: number }
interface PendingResponse {
  readonly frame: WsFrame<BaseMessage>;
  readonly streamId: string;
  readonly startedAt: number;
  passiveStarted: boolean;
  uncertain: boolean;
}

export interface WeComTransportOptions {
  readonly connectionId: string;
  readonly generation: number;
  readonly botId: string;
  readonly botSecret: string;
  readonly ownerUserId: string | null;
  readonly initialCursor?: string | null;
  readonly maximumMessageAgeMs?: number;
  readonly handshakeTimeoutMs?: number;
  readonly now?: () => number;
  readonly createClient?: (options: WSClientOptions) => WeComSdkClient;
}

export interface WeComConnectionProbe extends MessagingConnectionProbe { readonly channel: "wecom" }

export class WeComTransport {
  readonly channel = "wecom" as const;
  readonly connectionId: string;
  readonly generation: number;
  readonly #botId: string;
  readonly #now: () => number;
  readonly #maximumMessageAgeMs: number | undefined;
  readonly #stream: WeComStreamClient;
  readonly #frames = new Map<string, PendingFrame[]>();
  readonly #responses = new Map<string, PendingResponse>();
  readonly #consumedCallbacks = new Set<string>();
  readonly #media = new Map<string, WeComTransientMediaCoordinate>();
  #ownerUserId: string | null;
  #probed = false;
  #closed = false;

  constructor(options: WeComTransportOptions) {
    this.connectionId = requiredWeComIdentifier(options.connectionId, "connection", 256);
    this.generation = requiredGeneration(options.generation);
    this.#botId = requiredWeComIdentifier(options.botId, "bot", 512);
    this.#ownerUserId = options.ownerUserId === null ? null : requiredWeComIdentifier(options.ownerUserId, "owner", 512);
    this.#now = options.now ?? Date.now;
    this.#maximumMessageAgeMs = options.maximumMessageAgeMs;
    this.#stream = new WeComStreamClient({
      botId: this.#botId,
      secret: options.botSecret,
      initialCursor: options.initialCursor,
      handshakeTimeoutMs: options.handshakeTimeoutMs,
      now: this.#now,
      createClient: options.createClient
    });
  }

  async probe(signal?: AbortSignal): Promise<WeComConnectionProbe> {
    this.#assertOpen();
    await this.#stream.connect(signal);
    this.#probed = true;
    return { channel: "wecom", connectionId: this.connectionId, generation: this.generation, providerAccountId: this.#botId, displayName: "WeCom bot", username: null };
  }

  async poll(input: { readonly cursor: string | null; readonly timeoutSeconds?: number; readonly signal?: AbortSignal }): Promise<WeComPollResult> {
    this.#requireProbe();
    return this.#stream.poll(input);
  }

  normalize(updates: readonly WeComCallbackUpdate[]): WeComNormalizationResult {
    this.#requireProbe();
    const result = normalizeWeComUpdates(updates, {
      connectionId: this.connectionId,
      botId: this.#botId,
      ownerUserId: this.#ownerUserId,
      now: this.#now,
      ...(this.#maximumMessageAgeMs === undefined ? {} : { maximumMessageAgeMs: this.#maximumMessageAgeMs })
    });
    if (result.ownerClaimProviderUserId !== null) this.#ownerUserId = result.ownerClaimProviderUserId;
    this.#rememberTransient(updates, result);
    return result;
  }

  async downloadAttachment(attachment: MessagingInboundAttachment, signal?: AbortSignal): Promise<MessagingDownloadedAttachment> {
    this.#requireProbe();
    signal?.throwIfAborted();
    const coordinate = this.#media.get(attachment.providerFileId);
    if (coordinate === undefined) throw providerRejected("WeCom attachment download information is no longer available.");
    let downloaded: Awaited<ReturnType<WeComSdkClient["downloadFile"]>>;
    try {
      downloaded = await this.#stream.client.downloadFile(coordinate.providerUrl, coordinate.aesKey ?? undefined);
    } catch (error) {
      throw downloadFailure(error);
    }
    this.#assertOpen();
    signal?.throwIfAborted();
    return validateWeComDownload({ bytes: downloaded.buffer, fileName: downloaded.filename, fallbackName: coordinate.fileName, maximumBytes: coordinate.maximumBytes });
  }

  async beginReply(input: { readonly address: MessagingAddress; readonly messageId: string; readonly signal?: AbortSignal }): Promise<void> {
    this.#assertAddress(input.address);
    input.signal?.throwIfAborted();
    const messageId = requiredWeComIdentifier(input.messageId, "callback message", 512);
    const key = responseKey(input.address, messageId);
    if (this.#responses.has(key)) return;
    if (this.#consumedCallbacks.has(key)) {
      throw providerRejected("WeCom callback was already consumed.");
    }
    const frame = this.#claimFrame(input.address, messageId);
    if (frame === null) {
      throw providerRejected("WeCom callback is missing, expired, or belongs to an inactive generation.");
    }
    const response: PendingResponse = {
      frame,
      streamId: randomUUID(),
      startedAt: this.#now(),
      passiveStarted: false,
      uncertain: false
    };
    this.#rememberResponse(key, response);
    try {
      await this.#stream.client.replyStream(response.frame, response.streamId, " ", false);
      response.passiveStarted = true;
    } catch (error) {
      response.uncertain = true;
      throw sendFailure(error, "WeCom passive stream start failed.");
    }
  }

  async sendTextPart(input: { readonly address: MessagingAddress; readonly text: string; readonly replyToMessageId?: string; readonly callbackMessageId?: string; readonly signal?: AbortSignal }): Promise<MessagingSendReceipt> {
    this.#assertAddress(input.address);
    input.signal?.throwIfAborted();
    const chunks = splitWeComText(input.text);
    if (chunks.length !== 1) throw invalidInput("WeCom text delivery must contain one non-empty 18 KiB part.");
    const callbackMessageId = input.callbackMessageId === undefined
      ? undefined
      : requiredWeComIdentifier(input.callbackMessageId, "callback message", 512);
    if (callbackMessageId !== undefined
      && this.#consumedCallbacks.has(responseKey(input.address, callbackMessageId))) {
      throw providerRejected("WeCom callback was already consumed; refusing a duplicate delivery.");
    }
    const response = callbackMessageId === undefined
      ? undefined
      : this.#claimResponse(responseKey(input.address, callbackMessageId));
    if (callbackMessageId !== undefined) {
      this.#rememberConsumed(responseKey(input.address, callbackMessageId));
    }
    const target = input.address.providerConversationId;
    if (response?.uncertain === true) throw unknownPassiveEffect();
    if (response?.frame && response.passiveStarted && this.#now() - response.startedAt < STREAM_SAFE_TIMEOUT_MS) {
      try {
        await this.#stream.client.replyStream(response.frame, response.streamId, chunks[0]!, true);
        return { providerMessageId: response.streamId, address: input.address };
      } catch (error) {
        throw sendFailure(error, "WeCom passive stream finalization failed.");
      }
    }
    const messageId = response?.streamId ?? randomUUID();
    try {
      await this.#stream.client.sendMessage(target, { msgtype: "markdown", markdown: { content: chunks[0]! } });
      return { providerMessageId: messageId, address: input.address };
    } catch (error) {
      throw sendFailure(error, "WeCom active message send failed.");
    }
  }

  async sendAttachments(input: {
    readonly address: MessagingAddress;
    readonly attachments: readonly { readonly kind: "image" | "file"; readonly bytes: Uint8Array; readonly fileName: string; readonly mimeType: string }[];
    readonly replyToMessageId?: string;
    readonly signal?: AbortSignal;
  }): Promise<MessagingSendReceipt> {
    this.#assertAddress(input.address);
    input.signal?.throwIfAborted();
    if (input.attachments.length !== 1) throw invalidInput("WeCom attachment delivery must contain exactly one file.");
    const local = classifyWeComOutbound(input.attachments[0]!);
    let mediaId: string;
    try {
      mediaId = (await this.#stream.client.uploadMedia(local.buffer, { type: local.mediaType, filename: local.fileName })).media_id;
    } catch (error) {
      throw uploadFailure(error);
    }
    input.signal?.throwIfAborted();
    const messageId = randomUUID();
    try {
      await this.#stream.client.sendMediaMessage(input.address.providerConversationId, local.mediaType, mediaId);
      return { providerMessageId: messageId, address: input.address };
    } catch (error) {
      throw sendFailure(error, "WeCom media send failed.");
    }
  }

  async sendInteractionCard(input: { readonly address: MessagingAddress; readonly text: string; readonly buttons: readonly { readonly label: string; readonly actionValue: string }[]; readonly signal?: AbortSignal }): Promise<MessagingSendReceipt> {
    if (input.buttons.length > MAXIMUM_INTERACTION_CHOICES) throw invalidInput(`WeCom interaction must contain at most ${MAXIMUM_INTERACTION_CHOICES} choices.`);
    return this.sendTextPart({ address: input.address, text: formatInteractionPrompt(input.text, input.buttons), signal: input.signal });
  }

  async clearInteractionCard(input: { readonly address: MessagingAddress; readonly messageId: string; readonly signal?: AbortSignal }): Promise<MessagingSendReceipt> {
    this.#assertAddress(input.address);
    input.signal?.throwIfAborted();
    return { providerMessageId: requiredWeComIdentifier(input.messageId, "message", 512), address: input.address };
  }

  async sendTyping(address: MessagingAddress, signal?: AbortSignal): Promise<void> { this.#assertAddress(address); signal?.throwIfAborted(); }
  async setReaction(input: { readonly address: MessagingAddress; readonly messageId: string; readonly emoji: string | null; readonly signal?: AbortSignal }): Promise<void> { this.#assertAddress(input.address); requiredWeComIdentifier(input.messageId, "message", 512); input.signal?.throwIfAborted(); }
  async answerInteraction(input: { readonly interactionId: string; readonly text?: string; readonly showAlert?: boolean; readonly signal?: AbortSignal }): Promise<void> { requiredWeComIdentifier(input.interactionId, "interaction", 512); input.signal?.throwIfAborted(); }

  ownerAddress(): MessagingAddress {
    if (this.#ownerUserId === null) throw invalidInput("The WeCom owner has not claimed this connection yet.");
    return weComAddress({ connectionId: this.connectionId, providerConversationId: this.#ownerUserId, group: false });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#frames.clear(); this.#responses.clear(); this.#consumedCallbacks.clear(); this.#media.clear();
    await this.#stream.close();
  }

  #rememberTransient(updates: readonly WeComCallbackUpdate[], result: WeComNormalizationResult): void {
    const admittedIds = new Set(result.events.map((event) => event.messageId));
    for (const update of updates) {
      const body = update.frame.body;
      if (body === undefined || !admittedIds.has(body.msgid)) continue;
      const address = weComAddress({ connectionId: this.connectionId, providerConversationId: body.chattype === "group" ? body.chatid! : body.from.userid, group: body.chattype === "group" });
      this.#enqueueFrame(addressKey(address), { frame: update.frame, receivedAt: update.receivedAt });
      parseWeComContent(body).attachments.forEach((part, index) => this.#rememberMedia(weComAttachmentCoordinate(body.msgid, index), {
        providerUrl: part.providerUrl,
        aesKey: part.aesKey,
        fileName: part.fileName,
        mimeType: part.mimeType,
        maximumBytes: part.maximumBytes
      }));
    }
  }

  #enqueueFrame(key: string, frame: PendingFrame): void { const queue = this.#frames.get(key) ?? []; queue.push(frame); while (queue.length > CALLBACK_QUEUE_CAPACITY) queue.shift(); this.#frames.set(key, queue); }
  #rememberResponse(key: string, response: PendingResponse): void {
    this.#responses.delete(key);
    this.#responses.set(key, response);
    while (this.#responses.size > CALLBACK_QUEUE_CAPACITY) {
      const oldest = this.#responses.keys().next().value;
      if (oldest === undefined) break;
      this.#responses.delete(oldest);
    }
  }
  #claimResponse(key: string): PendingResponse | undefined { const found = this.#responses.get(key); this.#responses.delete(key); return found; }
  #rememberConsumed(key: string): void {
    this.#consumedCallbacks.delete(key);
    this.#consumedCallbacks.add(key);
    while (this.#consumedCallbacks.size > MAXIMUM_TRANSIENT_COORDINATES) {
      const oldest = this.#consumedCallbacks.values().next().value;
      if (oldest === undefined) break;
      this.#consumedCallbacks.delete(oldest);
    }
  }
  #claimFrame(address: MessagingAddress, messageId: string): WsFrame<BaseMessage> | null {
    const key = addressKey(address);
    const queue = this.#liveFrames(key);
    const index = queue.findIndex((entry) => entry.frame.body?.msgid === messageId);
    const found = index < 0 ? undefined : queue.splice(index, 1)[0];
    this.#updateFrames(key, queue);
    return found?.frame ?? null;
  }
  #liveFrames(key: string): PendingFrame[] { const minimum = this.#now() - CALLBACK_TTL_MS; return (this.#frames.get(key) ?? []).filter((item) => item.receivedAt >= minimum); }
  #updateFrames(key: string, queue: PendingFrame[]): void { if (queue.length === 0) this.#frames.delete(key); else this.#frames.set(key, queue); }
  #rememberMedia(key: string, value: WeComTransientMediaCoordinate): void { this.#media.delete(key); this.#media.set(key, value); while (this.#media.size > MAXIMUM_TRANSIENT_COORDINATES) { const oldest = this.#media.keys().next().value; if (oldest === undefined) break; this.#media.delete(oldest); } }
  #assertAddress(address: MessagingAddress): void { this.#assertOpen(); if (address.channel !== "wecom" || address.connectionId !== this.connectionId) throw invalidInput("WeCom address does not belong to this connection."); if (address.providerThreadId !== null || address.conversationKind === "channel") throw invalidInput("WeCom address has an unsupported conversation shape."); requiredWeComIdentifier(address.providerConversationId, "conversation", 512); }
  #assertOpen(): void { if (this.#closed) throw new MessagingTransportError("cancelled", "WeCom transport is closed.", { retryable: false, effect: "none" }); }
  #requireProbe(): void { this.#assertOpen(); if (!this.#probed) throw invalidInput("Probe the WeCom connection before using its WebSocket."); }
}

function formatInteractionPrompt(text: string, buttons: readonly { readonly label: string; readonly actionValue: string }[]): string {
  const body = text.trim();
  if (body === "") throw invalidInput("WeCom interaction text is empty.");
  const choices = buttons.map((button, index) => {
    const label = button.label.replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
    if (label.length < 1 || label.length > 80 || button.actionValue.length < 1 || button.actionValue.length > 256 || /[\u0000-\u001f\u007f]/u.test(button.actionValue)) throw invalidInput("WeCom interaction choice is invalid.");
    return `${index + 1}. ${label}`;
  });
  const suffix = choices.length === 0 ? "" : `\n\nReply with a number or label:\n${choices.join("\n")}`;
  const maximumBodyBytes = Math.max(1, 18 * 1_024 - Buffer.byteLength(suffix, "utf8"));
  const visible = truncateUtf8(body, maximumBodyBytes);
  return `${visible}${suffix}`;
}

function truncateUtf8(source: string, maximumBytes: number): string {
  let output = "";
  let byteLength = 0;
  for (const point of source) {
    const pointBytes = Buffer.byteLength(point, "utf8");
    if (byteLength + pointBytes > maximumBytes) break;
    output += point;
    byteLength += pointBytes;
  }
  return output;
}

function addressKey(address: MessagingAddress): string { return `${address.conversationKind}:${address.providerConversationId}`; }
function responseKey(address: MessagingAddress, messageId: string): string { return `${addressKey(address)}:${messageId}`; }
function requiredGeneration(value: number): number { if (!Number.isSafeInteger(value) || value < 1) throw invalidInput("WeCom connection generation is invalid."); return value; }
function invalidInput(message: string): MessagingTransportError { return new MessagingTransportError("invalid_input", message, { retryable: false, effect: "none" }); }
function providerRejected(message: string): MessagingTransportError { return new MessagingTransportError("provider_rejected", message, { retryable: false, effect: "none" }); }
function unknownPassiveEffect(): MessagingTransportError { return new MessagingTransportError("provider_unavailable", "WeCom passive reply outcome is unknown; active fallback is unsafe.", { retryable: false, effect: "unknown" }); }
function sendFailure(error: unknown, message: string): MessagingTransportError { if (error instanceof MessagingTransportError) return error; return new MessagingTransportError("provider_unavailable", message, { retryable: false, effect: "unknown" }); }
function uploadFailure(error: unknown): MessagingTransportError { if (error instanceof MessagingTransportError) return error; return new MessagingTransportError("provider_unavailable", "WeCom media upload failed.", { retryable: true, effect: "none" }); }
function downloadFailure(error: unknown): MessagingTransportError { if (error instanceof MessagingTransportError) return error; return new MessagingTransportError("network", "WeCom attachment download failed.", { retryable: true, effect: "none" }); }
