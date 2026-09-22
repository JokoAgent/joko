import { Buffer } from "node:buffer";
import type { Readable } from "node:stream";

import * as Lark from "@larksuiteoapi/node-sdk";

import {
  MessagingTransportError,
  type MessagingAddress,
  type MessagingDownloadedAttachment,
  type MessagingReplyContext
} from "../types.js";
import { parseFeishuContent } from "./content.js";
import { requiredFeishuIdentifier } from "./codec.js";
import type { FeishuHistoryMessage, FeishuService } from "./model.js";

export const FEISHU_MAXIMUM_FILE_BYTES = 30 * 1024 * 1024;
export const FEISHU_MAXIMUM_IMAGE_BYTES = 10 * 1024 * 1024;

export interface FeishuApiOptions {
  readonly appId: string;
  readonly appSecret: string;
  readonly service: FeishuService;
  readonly client?: Lark.Client;
}

export interface FeishuProbeResult {
  readonly appId: string;
  readonly botOpenId: string;
  readonly displayName: string;
}

export interface FeishuOutboundAttachment {
  readonly kind: "image" | "file";
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly mimeType: string;
}

export interface FeishuApiPort {
  probe(signal?: AbortSignal): Promise<FeishuProbeResult>;
  downloadAttachment(input: {
    readonly messageId: string;
    readonly providerKey: string;
    readonly kind: "image" | "file";
    readonly maximumBytes: number;
    readonly signal?: AbortSignal;
  }): Promise<MessagingDownloadedAttachment>;
  resolveReplyContext(messageId: string, expectedChatId: string, signal?: AbortSignal): Promise<MessagingReplyContext | null>;
  listHistory(address: MessagingAddress, limit: number, signal?: AbortSignal): Promise<readonly FeishuHistoryMessage[]>;
  sendText(address: MessagingAddress, text: string, replyToMessageId?: string, signal?: AbortSignal): Promise<string>;
  sendAttachment(address: MessagingAddress, attachment: FeishuOutboundAttachment, replyToMessageId?: string, signal?: AbortSignal): Promise<string>;
  sendCard(address: MessagingAddress, card: unknown, signal?: AbortSignal): Promise<string>;
  patchCard(messageId: string, card: unknown, signal?: AbortSignal): Promise<void>;
  addReaction(messageId: string, emojiType: string, signal?: AbortSignal): Promise<void>;
}

export class FeishuApi implements FeishuApiPort {
  readonly #appId: string;
  readonly #client: Lark.Client;

  constructor(options: FeishuApiOptions) {
    this.#appId = requiredFeishuIdentifier(options.appId, "app", 256);
    this.#client = options.client ?? new Lark.Client({
      appId: this.#appId,
      appSecret: requiredSecret(options.appSecret),
      domain: options.service === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu
    });
  }

  async probe(signal?: AbortSignal): Promise<FeishuProbeResult> {
    return this.#read(async () => {
      signal?.throwIfAborted();
      const response = await this.#client.request<unknown>({ method: "GET", url: "/open-apis/bot/v3/info" });
      signal?.throwIfAborted();
      const record = requiredRecord(response, "bot identity response");
      assertBusinessSuccess(record, "bot identity");
      const bot = requiredRecord(record["bot"], "bot identity");
      const botOpenId = requiredFeishuIdentifier(stringValue(bot["open_id"]), "bot open ID");
      const displayName = boundedDisplayName(stringValue(bot["app_name"]) || stringValue(bot["name"]) || "Bot");
      return { appId: this.#appId, botOpenId, displayName };
    });
  }

  async downloadAttachment(input: {
    readonly messageId: string;
    readonly providerKey: string;
    readonly kind: "image" | "file";
    readonly maximumBytes: number;
    readonly signal?: AbortSignal;
  }): Promise<MessagingDownloadedAttachment> {
    return this.#read(async () => {
      input.signal?.throwIfAborted();
      const response = await this.#client.im.v1.messageResource.get({
        path: {
          message_id: requiredFeishuIdentifier(input.messageId, "message"),
          file_key: requiredFeishuIdentifier(input.providerKey, "resource")
        },
        params: { type: input.kind }
      });
      const bytes = await readBounded(response.getReadableStream(), input.maximumBytes, input.signal);
      return {
        bytes,
        fileName: input.providerKey,
        mimeType: mimeFromHeaders(response.headers)
      };
    });
  }

  async resolveReplyContext(
    messageId: string,
    expectedChatId: string,
    signal?: AbortSignal
  ): Promise<MessagingReplyContext | null> {
    return this.#read(async () => {
      signal?.throwIfAborted();
      const response = await this.#client.im.v1.message.get({
        path: { message_id: requiredFeishuIdentifier(messageId, "message") },
        params: { user_id_type: "open_id", with_sender_name: true }
      });
      assertBusinessSuccess(response, "message lookup");
      const item = response.data?.items?.[0];
      if (item === undefined || item.deleted === true || item.chat_id !== expectedChatId || item.body === undefined) return null;
      const parsed = parseFeishuContent(item.msg_type ?? "", item.body.content);
      if (parsed.text === "" && parsed.attachments.length === 0) return null;
      return {
        providerMessageId: requiredFeishuIdentifier(item.message_id ?? messageId, "message"),
        author: boundedDisplayName(item.sender?.sender_name ?? item.sender?.id ?? "Unknown"),
        text: parsed.text,
        isBot: item.sender?.sender_type === "app",
        attachmentCount: parsed.attachments.length
      };
    });
  }

  async listHistory(
    address: MessagingAddress,
    limit: number,
    signal?: AbortSignal
  ): Promise<readonly FeishuHistoryMessage[]> {
    return this.#read(async () => {
      const maximum = Math.min(Math.max(limit, 1), 250);
      const items: FeishuHistoryMessage[] = [];
      let pageToken: string | undefined;
      while (items.length < maximum) {
        signal?.throwIfAborted();
        const response = await this.#client.im.v1.message.list({
          params: {
            container_id_type: address.providerThreadId === null ? "chat" : "thread",
            container_id: address.providerThreadId ?? address.providerConversationId,
            sort_type: "ByCreateTimeDesc",
            page_size: Math.min(50, maximum - items.length),
            with_sender_name: true,
            ...(pageToken === undefined ? {} : { page_token: pageToken })
          }
        });
        assertBusinessSuccess(response, "message history");
        for (const item of response.data?.items ?? []) {
          if (item.deleted === true || item.message_id === undefined || item.chat_id !== address.providerConversationId
            || item.body === undefined || item.sender?.id === undefined) continue;
          const threadId = item.thread_id?.trim() || null;
          if (address.providerThreadId === null ? threadId !== null : threadId !== address.providerThreadId) continue;
          items.push({
            messageId: requiredFeishuIdentifier(item.message_id, "message"),
            chatId: address.providerConversationId,
            threadId,
            senderOpenId: requiredFeishuIdentifier(item.sender.id, "sender"),
            senderName: boundedDisplayName(item.sender.sender_name ?? item.sender.id),
            senderIsBot: item.sender.sender_type === "app",
            messageType: item.msg_type ?? "",
            content: item.body.content,
            occurredAt: providerTime(item.create_time)
          });
          if (items.length >= maximum) break;
        }
        pageToken = response.data?.has_more === true && response.data.page_token ? response.data.page_token : undefined;
        if (pageToken === undefined) break;
      }
      return items;
    });
  }

  async sendText(
    address: MessagingAddress,
    text: string,
    replyToMessageId?: string,
    signal?: AbortSignal
  ): Promise<string> {
    return this.#effect(async () => this.#sendMessage(
      address,
      "text",
      JSON.stringify({ text }),
      replyToMessageId,
      signal
    ));
  }

  async sendAttachment(
    address: MessagingAddress,
    attachment: FeishuOutboundAttachment,
    replyToMessageId?: string,
    signal?: AbortSignal
  ): Promise<string> {
    return this.#effect(async () => {
      signal?.throwIfAborted();
      if (attachment.bytes.byteLength < 1) throw invalidInput("Feishu attachment is empty.");
      let messageType: "image" | "file";
      let content: string;
      if (attachment.kind === "image") {
        if (attachment.bytes.byteLength > FEISHU_MAXIMUM_IMAGE_BYTES) throw payloadTooLarge("Feishu image exceeds 10 MiB.");
        const uploaded = await this.#client.im.v1.image.create({
          data: { image_type: "message", image: Buffer.from(attachment.bytes) }
        });
        const key = uploaded?.image_key;
        if (key === undefined || key === "") throw providerRejected("Feishu image upload returned no resource identity.");
        messageType = "image";
        content = JSON.stringify({ image_key: key });
      } else {
        if (attachment.bytes.byteLength > FEISHU_MAXIMUM_FILE_BYTES) throw payloadTooLarge("Feishu file exceeds 30 MiB.");
        const uploaded = await this.#client.im.v1.file.create({
          data: {
            file_type: feishuFileType(attachment.fileName),
            file_name: requiredFileName(attachment.fileName),
            file: Buffer.from(attachment.bytes)
          }
        });
        const key = uploaded?.file_key;
        if (key === undefined || key === "") throw providerRejected("Feishu file upload returned no resource identity.");
        messageType = "file";
        content = JSON.stringify({ file_key: key });
      }
      return this.#sendMessage(address, messageType, content, replyToMessageId, signal);
    });
  }

  async sendCard(address: MessagingAddress, card: unknown, signal?: AbortSignal): Promise<string> {
    return this.#effect(async () => this.#sendMessage(address, "interactive", JSON.stringify(card), undefined, signal));
  }

  async patchCard(messageId: string, card: unknown, signal?: AbortSignal): Promise<void> {
    await this.#effect(async () => {
      signal?.throwIfAborted();
      const response = await this.#client.im.v1.message.patch({
        path: { message_id: requiredFeishuIdentifier(messageId, "message") },
        data: { content: JSON.stringify(card) }
      });
      assertBusinessSuccess(response, "card update");
      signal?.throwIfAborted();
    });
  }

  async addReaction(messageId: string, emojiType: string, signal?: AbortSignal): Promise<void> {
    await this.#effect(async () => {
      signal?.throwIfAborted();
      const response = await this.#client.im.v1.messageReaction.create({
        path: { message_id: requiredFeishuIdentifier(messageId, "message") },
        data: { reaction_type: { emoji_type: requiredFeishuIdentifier(emojiType, "reaction", 64) } }
      });
      assertBusinessSuccess(response, "reaction");
      signal?.throwIfAborted();
    });
  }

  async #sendMessage(
    address: MessagingAddress,
    messageType: string,
    content: string,
    replyToMessageId: string | undefined,
    signal: AbortSignal | undefined
  ): Promise<string> {
    signal?.throwIfAborted();
    let response: Awaited<ReturnType<Lark.Client["im"]["v1"]["message"]["create"]>>;
    const replyTarget = replyToMessageId ?? (address.providerThreadId === null
      ? undefined
      : await this.#resolveThreadAnchor(address, signal));
    if (replyTarget !== undefined) {
      response = await this.#client.im.v1.message.reply({
        path: { message_id: requiredFeishuIdentifier(replyTarget, "reply message") },
        data: {
          msg_type: messageType,
          content,
          reply_in_thread: address.providerThreadId !== null
        }
      });
    } else {
      response = await this.#client.im.v1.message.create({
        params: { receive_id_type: address.conversationKind === "direct" ? "open_id" : "chat_id" },
        data: {
          receive_id: requiredFeishuIdentifier(address.providerConversationId, "conversation"),
          msg_type: messageType,
          content
        }
      });
    }
    assertBusinessSuccess(response, "message delivery");
    signal?.throwIfAborted();
    const messageId = response.data?.message_id;
    if (messageId === undefined || messageId === "") throw providerRejected("Feishu delivery returned no message identity.");
    return requiredFeishuIdentifier(messageId, "message");
  }

  async #resolveThreadAnchor(address: MessagingAddress, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const response = await this.#client.im.v1.message.list({
      params: {
        container_id_type: "thread",
        container_id: requiredFeishuIdentifier(address.providerThreadId ?? "", "thread"),
        sort_type: "ByCreateTimeDesc",
        page_size: 1
      }
    });
    assertBusinessSuccess(response, "thread lookup");
    const messageId = response.data?.items?.find((item) => item.deleted !== true)?.message_id;
    if (messageId === undefined || messageId === "") throw providerRejected("Feishu topic has no reply anchor.");
    return requiredFeishuIdentifier(messageId, "thread message");
  }

  async #read<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      throw mapProviderError(error, false);
    }
  }

  async #effect<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      throw mapProviderError(error, true);
    }
  }
}

function assertBusinessSuccess(value: unknown, operation: string): void {
  if (!isRecord(value)) return;
  const code = value["code"];
  if (code === undefined || code === 0) return;
  const message = stringValue(value["msg"]);
  if (credentialFailure(code, message)) {
    throw new MessagingTransportError("invalid_credential", `Feishu ${operation} rejected the credential.`, {
      retryable: false,
      effect: "none"
    });
  }
  throw providerRejected(`Feishu ${operation} was rejected${message === "" ? "." : `: ${boundedProviderMessage(message)}`}`);
}

function mapProviderError(error: unknown, effectful: boolean): MessagingTransportError {
  if (error instanceof MessagingTransportError) return error;
  if (isAbortError(error)) {
    return new MessagingTransportError("cancelled", "Feishu operation was cancelled.", { retryable: false, effect: "none" });
  }
  const status = providerStatus(error);
  const message = providerMessage(error);
  if (status === 401 || status === 403 || credentialFailure(undefined, message)) {
    return new MessagingTransportError("invalid_credential", "Feishu rejected the application credential.", {
      retryable: false,
      effect: "none",
      ...(status === undefined ? {} : { providerStatus: status })
    });
  }
  if (conflictFailure(message)) {
    return new MessagingTransportError("conflict", "Another Feishu/Lark WebSocket client is using this application.", {
      retryable: false,
      effect: "none",
      ...(status === undefined ? {} : { providerStatus: status })
    });
  }
  if (status === 429) {
    return new MessagingTransportError("rate_limited", "Feishu rate limited the operation.", {
      retryable: true,
      effect: effectful ? "unknown" : "none",
      providerStatus: status
    });
  }
  const retryable = status === undefined || status >= 500;
  return new MessagingTransportError(
    retryable ? "provider_unavailable" : "provider_rejected",
    retryable ? "Feishu is temporarily unavailable." : "Feishu rejected the operation.",
    {
      retryable,
      effect: effectful ? "unknown" : "none",
      ...(status === undefined ? {} : { providerStatus: status })
    }
  );
}

function providerRejected(message: string): MessagingTransportError {
  return new MessagingTransportError("provider_rejected", message, { retryable: false, effect: "none" });
}

function invalidInput(message: string): MessagingTransportError {
  return new MessagingTransportError("invalid_input", message, { retryable: false, effect: "none" });
}

function payloadTooLarge(message: string): MessagingTransportError {
  return new MessagingTransportError("payload_too_large", message, { retryable: false, effect: "none" });
}

async function readBounded(stream: Readable, maximumBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
  const maximum = Math.min(Math.max(maximumBytes, 1), FEISHU_MAXIMUM_FILE_BYTES);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const value of stream) {
    signal?.throwIfAborted();
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    size += chunk.byteLength;
    if (size > maximum) {
      stream.destroy();
      throw payloadTooLarge("Feishu attachment exceeds the admitted size.");
    }
    chunks.push(chunk);
  }
  if (size === 0) throw providerRejected("Feishu attachment is empty.");
  return Buffer.concat(chunks);
}

function mimeFromHeaders(headers: unknown): string {
  if (!isRecord(headers)) return "application/octet-stream";
  const raw = headers["content-type"] ?? headers["Content-Type"];
  if (typeof raw !== "string") return "application/octet-stream";
  const mime = raw.split(";", 1)[0]!.trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(mime) ? mime : "application/octet-stream";
}

function feishuFileType(fileName: string): "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream" {
  const extension = /\.([^.]+)$/u.exec(fileName.trim())?.[1]?.toLowerCase();
  if (extension === "opus") return "opus";
  if (extension === "mp4") return "mp4";
  if (extension === "pdf") return "pdf";
  if (["doc", "docx"].includes(extension ?? "")) return "doc";
  if (["xls", "xlsx", "csv"].includes(extension ?? "")) return "xls";
  if (["ppt", "pptx"].includes(extension ?? "")) return "ppt";
  return "stream";
}

function requiredFileName(value: string): string {
  const normalized = value.replace(/[\\/\u0000-\u001f\u007f]/gu, "_").trim().slice(0, 250);
  if (normalized === "") throw invalidInput("Feishu file name is invalid.");
  return normalized;
}

function requiredSecret(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 4_096 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw invalidInput("Feishu application secret is invalid.");
  }
  return normalized;
}

function providerTime(value: string | undefined): number {
  if (value === undefined || !/^[0-9]{1,16}$/u.test(value)) return Date.now();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return Date.now();
  return parsed < 10_000_000_000 ? parsed * 1_000 : parsed;
}

function providerStatus(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  const response = recordValue(error["response"]);
  const status = response?.["status"] ?? error["status"];
  return typeof status === "number" && Number.isInteger(status) ? status : undefined;
}

function providerMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isRecord(error)) return stringValue(error["message"]);
  return "";
}

function credentialFailure(code: unknown, message: string): boolean {
  return [99991663, 99991664, 10012, 10013, 10014].includes(typeof code === "number" ? code : -1)
    || /(?:invalid|expired).{0,20}(?:app|credential|secret|token)|(?:app|secret|token).{0,20}(?:invalid|expired)/iu.test(message);
}

function conflictFailure(message: string): boolean {
  return /exceed[_\s-]*conn[_\s-]*limit|connection.{0,16}(?:limit|conflict)/iu.test(message);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /aborted|cancelled/iu.test(error.message));
}

function boundedProviderMessage(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, 200);
}

function boundedDisplayName(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, 128) || "Unknown";
}

function requiredRecord(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw providerRejected(`Feishu ${label} is malformed.`);
  return value;
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
