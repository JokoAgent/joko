import type {
  MessagingAddress,
  MessagingConnectionProbe,
  MessagingDownloadedAttachment,
  MessagingInboundAttachment,
  MessagingSendReceipt
} from "../types.js";
import { WeChatApiClient, type WeChatFetch } from "./api.js";
import { decodeWeChatMessage, requiredProviderId, weChatAttachment } from "./codec.js";
import { weChatAuthLoss, weChatCancelled, weChatInvalid, weChatMalformed, weChatProviderRejected } from "./errors.js";
import { prepareWeChatUpload, WECHAT_MEDIA_MAXIMUM_BYTES } from "./media-crypto.js";
import { downloadWeChatMedia, uploadWeChatCiphertext, type WeChatMediaTransferOptions } from "./media-transfer.js";
import { classifyWeChatOutbound, detectWeChatDownloadedMedia } from "./media-type.js";
import type {
  WeChatCredentials,
  WeChatNormalizationResult,
  WeChatPollResult,
  WeChatRawMessage,
  WeChatSendContext,
  WeChatTransientMedia
} from "./model.js";
import { normalizeWeChatUpdates } from "./normalize.js";
import { decodeWeChatSilk, type WeChatVoiceDecoderOptions } from "./silk.js";
import { filterWeChatMarkdown, splitWeChatText, WECHAT_MAXIMUM_TEXT_POINTS } from "./text.js";

const TRANSIENT_MEDIA_TTL_MS = 5 * 60_000;
const TRANSIENT_MEDIA_LIMIT = 2_048;
const MAXIMUM_CHOICES = 9;
const EMPTY_TEXT = "✅ (本轮无文本输出)";

interface MediaSlot {
  readonly coordinate: WeChatTransientMedia;
  readonly rememberedAt: number;
}

export interface WeChatTransportOptions {
  readonly connectionId: string;
  readonly generation: number;
  readonly credentials: WeChatCredentials;
  readonly initialCursor?: string | null;
  readonly now?: () => number;
  readonly maximumMessageAgeMs?: number;
  readonly fetch?: WeChatFetch;
  readonly mediaFetch?: WeChatFetch;
  readonly resolveMediaAddresses?: WeChatMediaTransferOptions["resolveAddresses"];
  readonly voiceDecoder?: WeChatVoiceDecoderOptions;
  readonly apiTimeoutMs?: number;
  readonly longPollTimeoutMs?: number;
}

export interface WeChatConnectionProbe extends MessagingConnectionProbe { readonly channel: "wechat" }

/** One credential generation. The host owns cursor, context sealing, and effect claims. */
export class WeChatTransport {
  readonly channel = "wechat" as const;
  readonly connectionId: string;
  readonly generation: number;
  readonly #credentials: WeChatCredentials;
  readonly #api: WeChatApiClient;
  readonly #now: () => number;
  readonly #maximumMessageAgeMs: number | undefined;
  readonly #mediaOptions: WeChatMediaTransferOptions;
  readonly #voiceDecoder: WeChatVoiceDecoderOptions | undefined;
  readonly #initialCursor: string;
  readonly #media = new Map<string, MediaSlot>();
  #firstPoll: { readonly cursor: string; readonly result: WeChatPollResult } | null = null;
  #probed = false;
  #closed = false;

  constructor(options: WeChatTransportOptions) {
    this.connectionId = requiredProviderId(options.connectionId, "connection");
    if (!Number.isSafeInteger(options.generation) || options.generation < 1) throw weChatInvalid("WeChat generation is invalid.");
    this.generation = options.generation;
    this.#api = new WeChatApiClient({
      credentials: options.credentials,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.apiTimeoutMs === undefined ? {} : { apiTimeoutMs: options.apiTimeoutMs }),
      ...(options.longPollTimeoutMs === undefined ? {} : { longPollTimeoutMs: options.longPollTimeoutMs })
    });
    this.#credentials = options.credentials;
    this.#now = options.now ?? Date.now;
    this.#maximumMessageAgeMs = options.maximumMessageAgeMs;
    this.#initialCursor = options.initialCursor ?? "";
    const mediaFetch = options.mediaFetch ?? options.fetch;
    this.#mediaOptions = {
      ...(mediaFetch === undefined ? {} : { fetch: mediaFetch }),
      ...(options.resolveMediaAddresses === undefined ? {} : { resolveAddresses: options.resolveMediaAddresses })
    };
    this.#voiceDecoder = options.voiceDecoder;
  }

  async probe(signal?: AbortSignal): Promise<WeChatConnectionProbe> {
    this.#assertOpen();
    const operationSignal = signal ?? new AbortController().signal;
    operationSignal.throwIfAborted();
    await this.#api.notifyLifecycle(true, operationSignal).catch(() => undefined);
    const first = await this.#readPoll(this.#initialCursor, operationSignal);
    this.#assertOpen();
    operationSignal.throwIfAborted();
    this.#firstPoll = { cursor: this.#initialCursor, result: first };
    this.#probed = true;
    return {
      channel: "wechat",
      connectionId: this.connectionId,
      generation: this.generation,
      providerAccountId: this.#credentials.botId,
      displayName: "WeChat bot",
      username: null
    };
  }

  async poll(input: { readonly cursor: string | null; readonly timeoutSeconds?: number; readonly signal?: AbortSignal }): Promise<WeChatPollResult> {
    this.#requireProbe();
    const cursor = input.cursor ?? "";
    const signal = input.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    if (this.#firstPoll?.cursor === cursor) {
      const first = this.#firstPoll.result;
      this.#firstPoll = null;
      return first;
    }
    this.#firstPoll = null;
    return this.#readPoll(cursor, signal);
  }

  normalize(updates: readonly WeChatRawMessage[]): WeChatNormalizationResult {
    this.#requireProbe();
    const result = normalizeWeChatUpdates(updates, {
      connectionId: this.connectionId,
      botId: this.#credentials.botId,
      ownerUserId: this.#credentials.userId,
      now: this.#now,
      ...(this.#maximumMessageAgeMs === undefined ? {} : { maximumMessageAgeMs: this.#maximumMessageAgeMs })
    });
    const admitted = new Set(result.events.map((event) => event.messageId));
    this.#evictMedia();
    for (const raw of updates) {
      const decoded = decodeWeChatMessage(raw);
      if (decoded === null || !admitted.has(decoded.messageId)) continue;
      decoded.media.slice(0, 4).forEach((coordinate, index) => {
        const key = weChatAttachment(decoded.messageId, index, coordinate).providerFileId;
        this.#media.delete(key);
        this.#media.set(key, { coordinate, rememberedAt: this.#now() });
      });
    }
    this.#evictMedia();
    return result;
  }

  async downloadAttachment(attachment: MessagingInboundAttachment, signal?: AbortSignal): Promise<MessagingDownloadedAttachment> {
    this.#requireProbe();
    const operationSignal = signal ?? new AbortController().signal;
    operationSignal.throwIfAborted();
    this.#evictMedia();
    const slot = this.#media.get(attachment.providerFileId);
    if (slot === undefined) throw weChatProviderRejected("WeChat attachment download reference expired.");
    let bytes = await downloadWeChatMedia(slot.coordinate, operationSignal, this.#mediaOptions);
    this.#assertOpen();
    operationSignal.throwIfAborted();
    if (slot.coordinate.kind === "voice" && slot.coordinate.voiceEncoding === 6) {
      bytes = await decodeWeChatSilk(bytes, operationSignal, this.#voiceDecoder);
    }
    const detected = detectWeChatDownloadedMedia(slot.coordinate, bytes);
    this.#assertOpen();
    operationSignal.throwIfAborted();
    return detected;
  }

  async sendTextPart(input: {
    readonly address: MessagingAddress;
    readonly text: string;
    readonly context?: WeChatSendContext;
    readonly replyToMessageId?: string;
    readonly callbackMessageId?: string;
    readonly signal?: AbortSignal;
  }): Promise<MessagingSendReceipt> {
    this.#assertAddress(input.address);
    const context = requiredContext(input.context);
    const visible = filterWeChatMarkdown(input.text).trim() || EMPTY_TEXT;
    if (splitWeChatText(visible).length !== 1) throw weChatInvalid("WeChat text delivery must contain one 3500-character part.");
    await this.#api.sendText({ peerId: input.address.providerConversationId, text: visible, context, signal: input.signal ?? new AbortController().signal });
    this.#assertOpen();
    return { providerMessageId: context.clientId, address: input.address };
  }

  async sendAttachments(input: {
    readonly address: MessagingAddress;
    readonly context?: WeChatSendContext;
    readonly attachments: readonly { readonly kind: "image" | "file"; readonly bytes: Uint8Array; readonly fileName: string; readonly mimeType: string }[];
    readonly replyToMessageId?: string;
    readonly signal?: AbortSignal;
  }): Promise<MessagingSendReceipt> {
    this.#assertAddress(input.address);
    const context = requiredContext(input.context);
    if (input.attachments.length !== 1) throw weChatInvalid("WeChat media delivery requires exactly one attachment.");
    const attachment = input.attachments[0]!;
    if (attachment.bytes.byteLength < 1 || attachment.bytes.byteLength > WECHAT_MEDIA_MAXIMUM_BYTES) {
      throw weChatInvalid("WeChat outbound media must be between 1 byte and 5 MiB.");
    }
    const classified = classifyWeChatOutbound(attachment);
    const signal = input.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    const prepared = prepareWeChatUpload(attachment.bytes);
    const admitted = await this.#api.getUploadUrl({
      peerId: input.address.providerConversationId,
      fileKey: prepared.fileKey,
      mediaType: classified.kind === "image" ? 1 : classified.kind === "video" ? 2 : 3,
      rawSize: attachment.bytes.byteLength,
      rawMd5: prepared.md5Hex,
      encryptedSize: prepared.ciphertext.byteLength,
      aesKeyHex: prepared.aesKeyHex,
      signal
    });
    this.#assertOpen();
    signal.throwIfAborted();
    const encryptedQuery = await uploadWeChatCiphertext({
      ...(admitted.uploadFullUrl === undefined ? {} : { fullUrl: admitted.uploadFullUrl }),
      ...(admitted.uploadParam === undefined ? {} : { uploadParam: admitted.uploadParam }),
      fileKey: prepared.fileKey,
      ciphertext: prepared.ciphertext
    }, signal, this.#mediaOptions);
    this.#assertOpen();
    signal.throwIfAborted();
    await this.#api.sendMedia({
      peerId: input.address.providerConversationId,
      context,
      media: {
        kind: classified.kind,
        encryptedQuery,
        aesKeyBase64: Buffer.from(prepared.aesKeyHex, "ascii").toString("base64"),
        byteLength: attachment.bytes.byteLength,
        encryptedByteLength: prepared.ciphertext.byteLength
      },
      fileName: classified.fileName,
      signal
    });
    this.#assertOpen();
    return { providerMessageId: context.clientId, address: input.address };
  }

  sendInteractionCard(input: {
    readonly address: MessagingAddress;
    readonly text: string;
    readonly buttons: readonly { readonly label: string; readonly actionValue: string }[];
    readonly context?: WeChatSendContext;
    readonly signal?: AbortSignal;
  }): Promise<MessagingSendReceipt> {
    this.#assertAddress(input.address);
    requiredContext(input.context);
    const visible = formatInteraction(input.text, input.buttons);
    return this.sendTextPart({ address: input.address, text: visible, context: input.context, signal: input.signal });
  }

  async clearInteractionCard(input: { readonly address: MessagingAddress; readonly messageId: string; readonly signal?: AbortSignal }): Promise<MessagingSendReceipt> {
    this.#assertAddress(input.address);
    input.signal?.throwIfAborted();
    return { providerMessageId: requiredProviderId(input.messageId, "message"), address: input.address };
  }

  async sendTyping(address: MessagingAddress, signal?: AbortSignal, contextToken?: string): Promise<void> {
    this.#assertAddress(address);
    if (contextToken === undefined) throw weChatInvalid("WeChat typing context is unavailable.");
    const operationSignal = signal ?? new AbortController().signal;
    const configuration = await this.#api.getConfig(address.providerConversationId, contextToken, operationSignal);
    if (configuration["ret"] !== undefined && configuration["ret"] !== 0) throw weChatProviderRejected("WeChat rejected typing configuration.");
    const ticket = configuration["typing_ticket"];
    if (typeof ticket !== "string" || ticket.trim() === "" || ticket.length > 8_192) {
      throw weChatMalformed("WeChat typing configuration omitted a ticket.");
    }
    await this.#api.setTyping(address.providerConversationId, ticket, true, operationSignal);
    this.#assertOpen();
  }

  async stopTyping(address: MessagingAddress, signal?: AbortSignal, contextToken?: string): Promise<void> {
    this.#assertAddress(address);
    if (contextToken === undefined) throw weChatInvalid("WeChat typing context is unavailable.");
    const operationSignal = signal ?? new AbortController().signal;
    const configuration = await this.#api.getConfig(address.providerConversationId, contextToken, operationSignal);
    if (configuration["ret"] !== undefined && configuration["ret"] !== 0) throw weChatProviderRejected("WeChat rejected typing configuration.");
    const ticket = configuration["typing_ticket"];
    if (typeof ticket !== "string" || ticket.trim() === "" || ticket.length > 8_192) {
      throw weChatMalformed("WeChat typing configuration omitted a ticket.");
    }
    await this.#api.setTyping(address.providerConversationId, ticket, false, operationSignal);
    this.#assertOpen();
  }

  async setReaction(input: { readonly address: MessagingAddress; readonly messageId: string; readonly emoji: string | null; readonly signal?: AbortSignal }): Promise<void> {
    this.#assertAddress(input.address);
    requiredProviderId(input.messageId, "message");
    input.signal?.throwIfAborted();
  }

  async answerInteraction(input: { readonly interactionId: string; readonly text?: string; readonly showAlert?: boolean; readonly signal?: AbortSignal }): Promise<void> {
    this.#assertOpen();
    requiredProviderId(input.interactionId, "interaction");
    input.signal?.throwIfAborted();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#firstPoll = null;
    this.#media.clear();
    if (this.#probed) await this.#api.notifyLifecycle(false, new AbortController().signal).catch(() => undefined);
  }

  async #readPoll(cursor: string, signal: AbortSignal): Promise<WeChatPollResult> {
    if (cursor.length > 8_192 || /[\u0000-\u001f\u007f]/u.test(cursor)) throw weChatInvalid("WeChat update cursor is invalid.");
    const response = await this.#api.getUpdates(cursor, signal);
    this.#assertOpen();
    signal.throwIfAborted();
    if (response["errcode"] !== undefined && (!Number.isSafeInteger(response["errcode"]))) {
      throw weChatMalformed("WeChat returned an invalid poll error code.");
    }
    if (response["errcode"] === -14) throw weChatAuthLoss("WeChat credential was replaced.");
    if (response["errcode"] !== undefined && response["errcode"] !== 0) throw weChatProviderRejected("WeChat rejected the update poll.");
    if (response["ret"] !== undefined && (!Number.isSafeInteger(response["ret"]))) throw weChatMalformed("WeChat returned an invalid poll status.");
    if (response["ret"] !== undefined && response["ret"] !== 0) throw weChatProviderRejected("WeChat rejected the update poll.");
    const updates = this.#api.messagesFrom(response);
    const rawCursor = response["get_updates_buf"];
    if (rawCursor !== undefined && (typeof rawCursor !== "string" || rawCursor.length > 8_192 || /[\u0000-\u001f\u007f]/u.test(rawCursor))) {
      throw weChatMalformed("WeChat returned an invalid update cursor.");
    }
    const rawTimeout = response["longpolling_timeout_ms"];
    if (rawTimeout !== undefined && (!Number.isSafeInteger(rawTimeout) || typeof rawTimeout !== "number" || rawTimeout < 0 || rawTimeout > 120_000)) {
      throw weChatMalformed("WeChat returned an invalid poll timeout.");
    }
    return {
      updates,
      nextCursor: typeof rawCursor === "string" ? rawCursor : cursor,
      ...(typeof rawTimeout === "number" ? { suggestedTimeoutMs: rawTimeout } : {})
    };
  }

  #evictMedia(): void {
    const minimum = this.#now() - TRANSIENT_MEDIA_TTL_MS;
    for (const [key, slot] of this.#media) if (slot.rememberedAt < minimum) this.#media.delete(key);
    while (this.#media.size > TRANSIENT_MEDIA_LIMIT) {
      const oldest = this.#media.keys().next().value;
      if (oldest === undefined) break;
      this.#media.delete(oldest);
    }
  }

  #assertAddress(address: MessagingAddress): void {
    this.#requireProbe();
    if (address.channel !== "wechat" || address.connectionId !== this.connectionId
      || address.conversationKind !== "direct" || address.providerThreadId !== null) {
      throw weChatInvalid("WeChat address does not belong to this direct connection.");
    }
    requiredProviderId(address.providerConversationId, "peer");
  }

  #assertOpen(): void { if (this.#closed) throw weChatCancelled("WeChat transport is closed."); }
  #requireProbe(): void { this.#assertOpen(); if (!this.#probed) throw weChatInvalid("Probe the WeChat connection before use."); }
}

function requiredContext(value: WeChatSendContext | undefined): WeChatSendContext {
  if (value === undefined || typeof value.contextToken !== "string" || value.contextToken.trim() === ""
    || value.contextToken.length > 8_192 || /[\u0000-\u001f\u007f]/u.test(value.contextToken)) {
    throw weChatInvalid("WeChat reply context is unavailable.");
  }
  requiredProviderId(value.clientId, "delivery");
  return value;
}

function formatInteraction(text: string, buttons: readonly { readonly label: string; readonly actionValue: string }[]): string {
  if (buttons.length > MAXIMUM_CHOICES) throw weChatInvalid("WeChat interaction has too many choices.");
  const choices = buttons.map((button, index) => {
    const label = button.label.replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
    if (label.length < 1 || label.length > 80 || button.actionValue.length < 1 || button.actionValue.length > 256
      || /[\u0000-\u001f\u007f]/u.test(button.actionValue)) throw weChatInvalid("WeChat interaction choice is invalid.");
    return `${index + 1}. ${label}`;
  });
  const suffix = choices.length === 0 ? "" : `\n\nReply with a number or label:\n${choices.join("\n")}`;
  const suffixPoints = Array.from(suffix).length;
  if (suffixPoints >= WECHAT_MAXIMUM_TEXT_POINTS) throw weChatInvalid("WeChat interaction choices are too long.");
  const body = Array.from(filterWeChatMarkdown(text).trim());
  if (body.length === 0) throw weChatInvalid("WeChat interaction text is empty.");
  return `${body.slice(0, WECHAT_MAXIMUM_TEXT_POINTS - suffixPoints).join("")}${suffix}`;
}
