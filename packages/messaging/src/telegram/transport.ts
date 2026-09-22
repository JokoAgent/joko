import {
  MessagingTransportError,
  type MessagingAddress,
  type MessagingConnectionProbe,
  type MessagingDownloadedAttachment,
  type MessagingInboundAttachment,
  type MessagingSendReceipt
} from "../types.js";
import { TelegramApi, type TelegramApiOptions } from "./api.js";
import type { TelegramMessage, TelegramUpdate, TelegramUser } from "./model.js";
import {
  normalizeTelegramUpdates,
  type TelegramBotIdentity,
  type TelegramNormalizationOptions,
  type TelegramNormalizationResult
} from "./normalize.js";
import { TELEGRAM_TEXT_LIMIT } from "./text.js";

export interface TelegramTransportOptions extends TelegramApiOptions {
  readonly connectionId: string;
  readonly generation: number;
  readonly ownerUserId: string;
  readonly groupActivation?: TelegramNormalizationOptions["groupActivation"];
  readonly now?: () => number;
  readonly maximumMessageAgeMs?: number;
}

export interface TelegramPollResult {
  readonly updates: readonly TelegramUpdate[];
  /** The next Bot API offset. Persist only after the raw updates are durable. */
  readonly nextCursor: string;
}

export interface TelegramOutboundAttachment {
  readonly kind: "image" | "file";
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly mimeType: string;
}

const TELEGRAM_PHOTO_MAXIMUM_BYTES = 10 * 1024 * 1024;
const TELEGRAM_DOCUMENT_MAXIMUM_BYTES = 50 * 1024 * 1024;
const TELEGRAM_MEDIA_GROUP_MAXIMUM_BYTES = 50 * 1024 * 1024;

export class TelegramTransport {
  readonly channel = "telegram" as const;
  readonly connectionId: string;
  readonly generation: number;
  readonly #ownerUserId: string;
  readonly #groupActivation: TelegramNormalizationOptions["groupActivation"];
  readonly #now: () => number;
  readonly #maximumMessageAgeMs: number | undefined;
  readonly #api: TelegramApi;
  #bot: TelegramBotIdentity | null = null;

  constructor(options: TelegramTransportOptions) {
    this.connectionId = requiredIdentifier(options.connectionId, "connection");
    this.generation = requiredGeneration(options.generation);
    this.#ownerUserId = requiredNumericIdentifier(options.ownerUserId, "owner");
    this.#groupActivation = options.groupActivation;
    this.#now = options.now ?? Date.now;
    this.#maximumMessageAgeMs = options.maximumMessageAgeMs;
    this.#api = new TelegramApi(options);
  }

  async probe(signal?: AbortSignal): Promise<MessagingConnectionProbe> {
    const bot = await this.#api.call<TelegramUser>("getMe", {}, { signal });
    if (!Number.isSafeInteger(bot.id) || bot.id < 1 || bot.is_bot !== true) {
      throw new MessagingTransportError("malformed_response", "Telegram returned an invalid bot identity.", {
        retryable: false,
        effect: "none"
      });
    }
    const displayName = [bot.first_name, bot.last_name].filter((part): part is string => Boolean(part)).join(" ").trim();
    this.#bot = { id: bot.id, username: bot.username?.trim() ?? "", displayName: displayName || String(bot.id) };
    return {
      channel: "telegram",
      connectionId: this.connectionId,
      generation: this.generation,
      providerAccountId: String(bot.id),
      displayName: this.#bot.displayName,
      username: this.#bot.username || null
    };
  }

  async poll(input: {
    readonly cursor: string | null;
    readonly timeoutSeconds?: number;
    readonly signal?: AbortSignal;
  }): Promise<TelegramPollResult> {
    const timeout = input.timeoutSeconds ?? 50;
    if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 50) {
      throw invalidInput("Telegram poll timeout must be between 0 and 50 seconds.");
    }
    const offset = parseCursor(input.cursor);
    const updates = await this.#api.call<readonly TelegramUpdate[]>("getUpdates", {
      ...(offset === null ? {} : { offset }),
      timeout,
      limit: 100,
      allowed_updates: ["message", "callback_query"]
    }, { signal: input.signal });
    if (!Array.isArray(updates) || updates.some((update) => !validUpdate(update))) {
      throw new MessagingTransportError("malformed_response", "Telegram returned invalid updates.", {
        retryable: false,
        effect: "none"
      });
    }
    const maximum = updates.reduce((value, update) => Math.max(value, update.update_id), offset === null ? 0 : offset - 1);
    return { updates: [...updates].sort((left, right) => left.update_id - right.update_id), nextCursor: String(maximum + 1) };
  }

  normalize(updates: readonly TelegramUpdate[]): TelegramNormalizationResult {
    if (this.#bot === null) {
      throw new MessagingTransportError("invalid_input", "Probe the Telegram connection before normalizing updates.", {
        retryable: false,
        effect: "none"
      });
    }
    return normalizeTelegramUpdates(updates, {
      connectionId: this.connectionId,
      ownerUserId: this.#ownerUserId,
      bot: this.#bot,
      groupActivation: this.#groupActivation,
      now: this.#now,
      ...(this.#maximumMessageAgeMs === undefined ? {} : { maximumMessageAgeMs: this.#maximumMessageAgeMs })
    });
  }

  async downloadAttachment(
    attachment: MessagingInboundAttachment,
    signal?: AbortSignal
  ): Promise<MessagingDownloadedAttachment> {
    const maximumBytes = attachment.byteLength === null
      ? 20 * 1024 * 1024
      : Math.min(attachment.byteLength, 20 * 1024 * 1024);
    const downloaded = await this.#api.downloadFile(attachment.providerFileId, maximumBytes, signal);
    return {
      bytes: downloaded.bytes,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType ?? downloaded.mimeType
    };
  }

  /** One call is one external effect; the durable manager owns chunk sequencing and retries. */
  async sendTextPart(input: {
    readonly address: MessagingAddress;
    readonly text: string;
    readonly replyToMessageId?: string;
    readonly parseMode?: "HTML";
    readonly signal?: AbortSignal;
  }): Promise<MessagingSendReceipt> {
    this.#assertAddress(input.address);
    if (input.text.length === 0 || input.text.length > TELEGRAM_TEXT_LIMIT) {
      throw invalidInput(`Telegram text must contain 1-${TELEGRAM_TEXT_LIMIT} UTF-16 code units.`);
    }
    const replyId = input.replyToMessageId === undefined ? null : numericCoordinate(input.replyToMessageId, "message");
    const sent = await this.#api.call<TelegramMessage>("sendMessage", {
      chat_id: numericCoordinate(input.address.providerConversationId, "conversation"),
      text: input.text,
      ...(input.address.providerThreadId === null
        ? {}
        : { message_thread_id: numericCoordinate(input.address.providerThreadId, "thread") }),
      ...(input.parseMode === undefined ? {} : { parse_mode: input.parseMode }),
      ...(replyId === null ? {} : {
        reply_parameters: { message_id: replyId, allow_sending_without_reply: true }
      })
    }, { signal: input.signal, effect: "unknown" });
    if (!Number.isSafeInteger(sent.message_id)) {
      throw new MessagingTransportError("malformed_response", "Telegram returned an invalid sent message.", {
        retryable: false,
        effect: "unknown"
      });
    }
    return { providerMessageId: String(sent.message_id), address: input.address };
  }

  /** One multipart call is one external effect; unknown outcomes are never replayed blindly. */
  async sendAttachments(input: {
    readonly address: MessagingAddress;
    readonly attachments: readonly TelegramOutboundAttachment[];
    readonly replyToMessageId?: string;
    readonly signal?: AbortSignal;
  }): Promise<MessagingSendReceipt> {
    this.#assertAddress(input.address);
    if (input.attachments.length < 1 || input.attachments.length > 10) {
      throw invalidInput("Telegram attachment delivery must contain 1-10 files.");
    }
    const attachments = input.attachments.map(validateOutboundAttachment);
    if (attachments.length > 1 && attachments.some((attachment) => attachment.kind !== "image")) {
      throw invalidInput("Telegram media groups may contain only images.");
    }
    if (attachments.length > 1 && attachments.reduce((size, attachment) => size + attachment.bytes.byteLength, 0) > TELEGRAM_MEDIA_GROUP_MAXIMUM_BYTES) {
      throw new MessagingTransportError("payload_too_large", "Telegram media group exceeds the upload limit.", {
        retryable: false,
        effect: "none"
      });
    }
    const form = new FormData();
    form.set("chat_id", String(numericCoordinate(input.address.providerConversationId, "conversation")));
    if (input.address.providerThreadId !== null) {
      form.set("message_thread_id", String(numericCoordinate(input.address.providerThreadId, "thread")));
    }
    if (input.replyToMessageId !== undefined) {
      form.set("reply_parameters", JSON.stringify({
        message_id: numericCoordinate(input.replyToMessageId, "message"),
        allow_sending_without_reply: true
      }));
    }
    if (attachments.length === 1) {
      const attachment = attachments[0]!;
      const field = attachment.kind === "image" ? "photo" : "document";
      form.set(field, attachmentBlob(attachment), attachment.fileName);
      const sent = await this.#api.callForm<TelegramMessage>(
        attachment.kind === "image" ? "sendPhoto" : "sendDocument",
        form,
        { signal: input.signal, effect: "unknown" }
      );
      if (!Number.isSafeInteger(sent.message_id)) throw malformedSentAttachment();
      return { providerMessageId: String(sent.message_id), address: input.address };
    }
    form.set("media", JSON.stringify(attachments.map((_attachment, index) => ({
      type: "photo",
      media: `attach://photo${index}`
    }))));
    attachments.forEach((attachment, index) => {
      form.set(`photo${index}`, attachmentBlob(attachment), attachment.fileName);
    });
    const sent = await this.#api.callForm<readonly TelegramMessage[]>("sendMediaGroup", form, {
      signal: input.signal,
      effect: "unknown"
    });
    if (!Array.isArray(sent) || sent.length !== attachments.length || sent.some((message) => !Number.isSafeInteger(message.message_id))) {
      throw malformedSentAttachment();
    }
    return { providerMessageId: String(sent[0]!.message_id), address: input.address };
  }

  async sendInteractionCard(input: {
    readonly address: MessagingAddress;
    readonly text: string;
    readonly buttons: readonly { readonly label: string; readonly actionValue: string }[];
    readonly signal?: AbortSignal;
  }): Promise<MessagingSendReceipt> {
    this.#assertAddress(input.address);
    if (input.text.trim().length === 0 || input.text.length > TELEGRAM_TEXT_LIMIT) {
      throw invalidInput(`Telegram interaction text must contain 1-${TELEGRAM_TEXT_LIMIT} UTF-16 code units.`);
    }
    if (input.buttons.length > 100) {
      throw invalidInput("Telegram interaction must contain at most 100 buttons.");
    }
    const buttons = input.buttons.map((button) => {
      const label = button.label.trim();
      if (label.length === 0 || label.length > 64 || /[\u0000-\u001f\u007f]/u.test(label)) {
        throw invalidInput("Invalid Telegram interaction button label.");
      }
      if (button.actionValue.length === 0 || new TextEncoder().encode(button.actionValue).byteLength > 64
        || /[\u0000-\u001f\u007f]/u.test(button.actionValue)) {
        throw invalidInput("Invalid Telegram interaction callback value.");
      }
      return { text: label, callback_data: button.actionValue };
    });
    const rows: Array<Array<(typeof buttons)[number]>> = [];
    for (let index = 0; index < buttons.length; index += 2) rows.push(buttons.slice(index, index + 2));
    const sent = await this.#api.call<TelegramMessage>("sendMessage", {
      chat_id: numericCoordinate(input.address.providerConversationId, "conversation"),
      text: input.text,
      ...(input.address.providerThreadId === null
        ? {}
        : { message_thread_id: numericCoordinate(input.address.providerThreadId, "thread") }),
      ...(rows.length === 0 ? {} : { reply_markup: { inline_keyboard: rows } })
    }, { signal: input.signal, effect: "unknown" });
    if (!Number.isSafeInteger(sent.message_id)) {
      throw new MessagingTransportError("malformed_response", "Telegram returned an invalid interaction message.", {
        retryable: false,
        effect: "unknown"
      });
    }
    return { providerMessageId: String(sent.message_id), address: input.address };
  }

  async clearInteractionCard(input: {
    readonly address: MessagingAddress;
    readonly messageId: string;
    readonly signal?: AbortSignal;
  }): Promise<MessagingSendReceipt> {
    this.#assertAddress(input.address);
    const messageId = numericCoordinate(input.messageId, "message");
    const edited = await this.#api.call<TelegramMessage | true>("editMessageReplyMarkup", {
      chat_id: numericCoordinate(input.address.providerConversationId, "conversation"),
      message_id: messageId,
      reply_markup: { inline_keyboard: [] }
    }, { signal: input.signal, effect: "unknown" });
    if (edited !== true && (!isTelegramMessage(edited) || edited.message_id !== messageId)) {
      throw new MessagingTransportError("malformed_response", "Telegram returned an invalid interaction edit.", {
        retryable: false,
        effect: "unknown"
      });
    }
    return { providerMessageId: String(messageId), address: input.address };
  }

  async sendTyping(address: MessagingAddress, signal?: AbortSignal): Promise<void> {
    this.#assertAddress(address);
    await this.#api.call("sendChatAction", {
      chat_id: numericCoordinate(address.providerConversationId, "conversation"),
      action: "typing",
      ...(address.providerThreadId === null
        ? {}
        : { message_thread_id: numericCoordinate(address.providerThreadId, "thread") })
    }, { signal, effect: "unknown" });
  }

  async setReaction(input: {
    readonly address: MessagingAddress;
    readonly messageId: string;
    readonly emoji: string | null;
    readonly signal?: AbortSignal;
  }): Promise<void> {
    this.#assertAddress(input.address);
    if (input.emoji !== null && (input.emoji.length === 0 || input.emoji.length > 16)) {
      throw invalidInput("Invalid Telegram reaction.");
    }
    await this.#api.call("setMessageReaction", {
      chat_id: numericCoordinate(input.address.providerConversationId, "conversation"),
      message_id: numericCoordinate(input.messageId, "message"),
      reaction: input.emoji === null ? [] : [{ type: "emoji", emoji: input.emoji }]
    }, { signal: input.signal, effect: "unknown" });
  }

  async answerInteraction(input: {
    readonly interactionId: string;
    readonly text?: string;
    readonly showAlert?: boolean;
    readonly signal?: AbortSignal;
  }): Promise<void> {
    const interactionId = requiredIdentifier(input.interactionId, "interaction");
    if (input.text !== undefined && input.text.length > 200) throw invalidInput("Telegram interaction answer is too long.");
    await this.#api.call("answerCallbackQuery", {
      callback_query_id: interactionId,
      ...(input.text === undefined ? {} : { text: input.text }),
      ...(input.showAlert === undefined ? {} : { show_alert: input.showAlert })
    }, { signal: input.signal, effect: "unknown" });
  }

  #assertAddress(address: MessagingAddress): void {
    if (address.channel !== "telegram" || address.connectionId !== this.connectionId) {
      throw invalidInput("Telegram address does not belong to this connection.");
    }
  }
}

function parseCursor(value: string | null): number | null {
  if (value === null) return null;
  if (!/^(?:0|[1-9][0-9]{0,15})$/u.test(value)) throw invalidInput("Invalid Telegram cursor.");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw invalidInput("Invalid Telegram cursor.");
  return parsed;
}

function validUpdate(value: unknown): value is TelegramUpdate {
  if (typeof value !== "object" || value === null || !("update_id" in value)) return false;
  return Number.isSafeInteger((value as { readonly update_id?: unknown }).update_id) &&
    Number((value as { readonly update_id: number }).update_id) >= 0;
}

function isTelegramMessage(value: unknown): value is TelegramMessage {
  return typeof value === "object" && value !== null && "message_id" in value
    && Number.isSafeInteger((value as { readonly message_id?: unknown }).message_id);
}

function requiredIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 256 || /[\u0000-\u001f]/u.test(normalized)) {
    throw invalidInput(`Invalid Telegram ${label} identifier.`);
  }
  return normalized;
}

function requiredNumericIdentifier(value: string, label: string): string {
  numericCoordinate(value, label);
  return value;
}

function numericCoordinate(value: string, label: string): number {
  if (!/^-?[1-9][0-9]{0,15}$/u.test(value)) throw invalidInput(`Invalid Telegram ${label} identifier.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw invalidInput(`Invalid Telegram ${label} identifier.`);
  return parsed;
}

function requiredGeneration(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw invalidInput("Invalid Telegram connection generation.");
  return value;
}

function validateOutboundAttachment(attachment: TelegramOutboundAttachment): TelegramOutboundAttachment {
  const fileName = attachment.fileName.trim();
  if (fileName.length === 0 || fileName.length > 256 || /[\u0000-\u001f\u007f]/u.test(fileName)) {
    throw invalidInput("Invalid Telegram attachment file name.");
  }
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(attachment.mimeType)) {
    throw invalidInput("Invalid Telegram attachment media type.");
  }
  const maximum = attachment.kind === "image" ? TELEGRAM_PHOTO_MAXIMUM_BYTES : TELEGRAM_DOCUMENT_MAXIMUM_BYTES;
  if (attachment.bytes.byteLength < 1 || attachment.bytes.byteLength > maximum) {
    throw new MessagingTransportError("payload_too_large", "Telegram attachment exceeds the upload limit.", {
      retryable: false,
      effect: "none"
    });
  }
  return { ...attachment, fileName };
}

function attachmentBlob(attachment: TelegramOutboundAttachment): Blob {
  const copy = new Uint8Array(attachment.bytes.byteLength);
  copy.set(attachment.bytes);
  return new Blob([copy.buffer], { type: attachment.mimeType });
}

function malformedSentAttachment(): MessagingTransportError {
  return new MessagingTransportError("malformed_response", "Telegram returned an invalid attachment receipt.", {
    retryable: false,
    effect: "unknown"
  });
}

function invalidInput(message: string): MessagingTransportError {
  return new MessagingTransportError("invalid_input", message, { retryable: false, effect: "none" });
}
