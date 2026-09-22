import type {
  MessagingAddress,
  MessagingGroupObservation,
  MessagingIgnoredInbound,
  MessagingInboundAttachment,
  MessagingInboundEvent,
  MessagingInboundInteraction,
  MessagingInboundMessage,
  MessagingReplyContext,
  MessagingSpeaker,
  MessagingUnsupportedPart
} from "../types.js";
import { telegramAddress } from "./codec.js";
import type {
  TelegramCallbackQuery,
  TelegramMessage,
  TelegramMessageEntity,
  TelegramUpdate,
  TelegramUser
} from "./model.js";

export const TELEGRAM_MAXIMUM_INBOUND_FILE_BYTES = 20 * 1024 * 1024;
export const TELEGRAM_DEFAULT_MAXIMUM_MESSAGE_AGE_MS = 60 * 60 * 1_000;

export interface TelegramBotIdentity {
  readonly id: number;
  readonly username: string;
  readonly displayName: string;
}

export interface TelegramNormalizationOptions {
  readonly connectionId: string;
  readonly ownerUserId: string;
  readonly bot: TelegramBotIdentity;
  readonly groupActivation?: Readonly<Record<string, "mention" | "always" | "disabled">>;
  readonly now?: () => number;
  readonly maximumMessageAgeMs?: number;
}

export interface TelegramNormalizationResult {
  readonly events: readonly MessagingInboundEvent[];
  /** Protected group content is never included in this long-lived history lane. */
  readonly groupObservations: readonly MessagingGroupObservation[];
  readonly ignored: readonly MessagingIgnoredInbound[];
}

interface UpdateGroup {
  readonly updates: readonly TelegramUpdate[];
  readonly primary: TelegramUpdate;
}

export function normalizeTelegramUpdates(
  source: readonly TelegramUpdate[],
  options: TelegramNormalizationOptions
): TelegramNormalizationResult {
  const now = options.now?.() ?? Date.now();
  const maximumAge = options.maximumMessageAgeMs ?? TELEGRAM_DEFAULT_MAXIMUM_MESSAGE_AGE_MS;
  const ignored: MessagingIgnoredInbound[] = [];
  const unique: TelegramUpdate[] = [];
  const seen = new Set<number>();
  for (const update of [...source].sort((left, right) => left.update_id - right.update_id)) {
    const requestId = requestIdOf(update.update_id);
    if (!Number.isSafeInteger(update.update_id) || update.update_id < 0) {
      ignored.push(ignoredEntry(requestId, "invalid", null, null));
    } else if (seen.has(update.update_id)) {
      ignored.push(ignoredEntry(requestId, "duplicate", conversationIdOf(update), userIdOf(update)));
    } else {
      seen.add(update.update_id);
      unique.push(update);
    }
  }

  const groups = groupUpdates(unique);
  const events: MessagingInboundEvent[] = [];
  const observations: MessagingGroupObservation[] = [];
  for (const group of groups) {
    const primaryMessage = group.primary.message;
    if (primaryMessage !== undefined) {
      const messages = group.updates.flatMap((update) => update.message === undefined ? [] : [update.message]);
      for (const message of messages) {
        const observation = groupObservationOf(message, options);
        if (observation !== null) observations.push(observation);
      }
      const result = normalizeMessage(group, primaryMessage, options, now, maximumAge);
      if (result.event !== null) events.push(result.event);
      if (result.ignored !== null) ignored.push(result.ignored);
      continue;
    }
    const callback = group.primary.callback_query;
    if (callback !== undefined) {
      const result = normalizeInteraction(group.primary, callback, options, now, maximumAge);
      if (result.event !== null) events.push(result.event);
      if (result.ignored !== null) ignored.push(result.ignored);
      continue;
    }
    ignored.push(ignoredEntry(requestIdOf(group.primary.update_id), "unsupported_update", null, null));
  }
  return { events, groupObservations: observations, ignored };
}

function normalizeMessage(
  group: UpdateGroup,
  message: TelegramMessage,
  options: TelegramNormalizationOptions,
  now: number,
  maximumAge: number
): { readonly event: MessagingInboundMessage | null; readonly ignored: MessagingIgnoredInbound | null } {
  const requestIds = group.updates.map((update) => requestIdOf(update.update_id));
  const requestId = requestIds[0] ?? requestIdOf(group.primary.update_id);
  const chatId = String(message.chat.id);
  const userId = message.from === undefined ? null : String(message.from.id);
  if (message.from === undefined) {
    return { event: null, ignored: ignoredEntry(requestId, "service_message", chatId, null) };
  }
  if (isStale(message.date, now, maximumAge)) {
    return { event: null, ignored: ignoredEntry(requestId, "stale", chatId, userId) };
  }
  if (message.chat.type === "channel") {
    return { event: null, ignored: ignoredEntry(requestId, "unsupported_chat", chatId, userId) };
  }

  const messages = group.updates.flatMap((update) => update.message === undefined ? [] : [update.message]);
  const collected = collectParts(messages);
  const sourceText = message.text ?? message.caption ?? "";
  let text = sourceText;
  let ambient = false;
  if (message.chat.type === "private") {
    if (userId !== options.ownerUserId) {
      return { event: null, ignored: ignoredEntry(requestId, "unauthorized", chatId, userId) };
    }
  } else {
    const activation = options.groupActivation?.[chatId] ?? "mention";
    if (activation === "disabled") {
      return { event: null, ignored: ignoredEntry(requestId, "unaddressed", chatId, userId) };
    }
    const owner = userId === options.ownerUserId;
    let trigger = detectTelegramGroupTrigger(message, options.bot);
    if (trigger === null && owner && isBareCommand(sourceText)) trigger = sourceText.trim();
    if (trigger === null && activation === "always" && sourceText.trim() !== "") {
      trigger = sourceText.trim();
      ambient = true;
    }
    if (trigger === null) {
      return { event: null, ignored: ignoredEntry(requestId, "unaddressed", chatId, userId) };
    }
    const command = /^[!/]/u.test(trigger.trimStart());
    if (command && (!owner || ambient)) {
      return { event: null, ignored: ignoredEntry(requestId, "unauthorized", chatId, userId) };
    }
    text = trigger;
  }

  if (text.trim() === "" && collected.attachments.length === 0 && collected.unsupported.length === 0) {
    return { event: null, ignored: ignoredEntry(requestId, "service_message", chatId, userId) };
  }
  const address = addressOf(options.connectionId, message);
  const speaker = speakerOf(message.from, options.ownerUserId);
  return {
    event: {
      kind: "message",
      providerRequestIds: requestIds,
      messageId: String(message.message_id),
      address,
      speaker,
      occurredAt: message.date * 1_000,
      text,
      ambient,
      protectedContent: messages.some((entry) => entry.has_protected_content === true),
      attachments: collected.attachments,
      unsupported: collected.unsupported,
      replyContext: replyContextOf(message)
    },
    ignored: null
  };
}

function normalizeInteraction(
  update: TelegramUpdate,
  callback: TelegramCallbackQuery,
  options: TelegramNormalizationOptions,
  now: number,
  maximumAge: number
): { readonly event: MessagingInboundInteraction | null; readonly ignored: MessagingIgnoredInbound | null } {
  const requestId = requestIdOf(update.update_id);
  const message = callback.message;
  const userId = String(callback.from.id);
  if (message === undefined || typeof callback.data !== "string" || callback.data.length === 0 ||
      new TextEncoder().encode(callback.data).byteLength > 64) {
    return { event: null, ignored: ignoredEntry(requestId, "invalid", message ? String(message.chat.id) : null, userId) };
  }
  const chatId = String(message.chat.id);
  if (userId !== options.ownerUserId) {
    return { event: null, ignored: ignoredEntry(requestId, "unauthorized", chatId, userId) };
  }
  if (isStale(message.date, now, maximumAge)) {
    return { event: null, ignored: ignoredEntry(requestId, "stale", chatId, userId) };
  }
  if (message.chat.type === "channel") {
    return { event: null, ignored: ignoredEntry(requestId, "unsupported_chat", chatId, userId) };
  }
  return {
    event: {
      kind: "interaction",
      providerRequestIds: [requestId],
      interactionId: callback.id,
      messageId: String(message.message_id),
      address: addressOf(options.connectionId, message),
      speaker: speakerOf(callback.from, options.ownerUserId),
      actionValue: callback.data,
      occurredAt: now
    },
    ignored: null
  };
}

function groupUpdates(updates: readonly TelegramUpdate[]): readonly UpdateGroup[] {
  const albums = new Map<string, TelegramUpdate[]>();
  const singles: UpdateGroup[] = [];
  for (const update of updates) {
    const message = update.message;
    if (message?.media_group_id === undefined) {
      singles.push({ updates: [update], primary: update });
      continue;
    }
    const key = `${message.chat.id}:${message.media_group_id}`;
    const current = albums.get(key) ?? [];
    current.push(update);
    albums.set(key, current);
  }
  for (const album of albums.values()) {
    const primary = album.find((entry) => {
      const message = entry.message;
      return message !== undefined && ((message.text ?? message.caption ?? "") !== "" || message.reply_to_message !== undefined);
    }) ?? album[0];
    if (primary !== undefined) singles.push({ updates: album, primary });
  }
  return singles.sort((left, right) => left.primary.update_id - right.primary.update_id);
}

function collectParts(messages: readonly TelegramMessage[]): {
  readonly attachments: readonly MessagingInboundAttachment[];
  readonly unsupported: readonly MessagingUnsupportedPart[];
} {
  const attachments: MessagingInboundAttachment[] = [];
  const unsupported: MessagingUnsupportedPart[] = [];
  for (const message of messages) {
    const bestPhoto = [...(message.photo ?? [])]
      .sort((left, right) => (right.width * right.height) - (left.width * left.height))[0];
    if (bestPhoto !== undefined) {
      if ((bestPhoto.file_size ?? 0) > TELEGRAM_MAXIMUM_INBOUND_FILE_BYTES) {
        unsupported.push({ code: "oversize", label: "Image exceeds Telegram's download limit." });
      } else {
        attachments.push({
          providerFileId: bestPhoto.file_id,
          providerUniqueFileId: bestPhoto.file_unique_id,
          kind: "image",
          fileName: `photo-${safeFileToken(bestPhoto.file_unique_id)}.jpg`,
          mimeType: "image/jpeg",
          byteLength: bestPhoto.file_size ?? null
        });
      }
    }
    if (message.document !== undefined) {
      const document = message.document;
      if ((document.file_size ?? 0) > TELEGRAM_MAXIMUM_INBOUND_FILE_BYTES) {
        unsupported.push({ code: "oversize", label: "File exceeds Telegram's download limit." });
      } else {
        const mime = normalizeMime(document.mime_type);
        attachments.push({
          providerFileId: document.file_id,
          providerUniqueFileId: document.file_unique_id,
          kind: mime?.startsWith("image/") === true ? "image" : "file",
          fileName: sanitizeFileName(document.file_name ?? `document-${safeFileToken(document.file_unique_id)}`),
          mimeType: mime,
          byteLength: document.file_size ?? null
        });
      }
    }
    if (message.sticker !== undefined) unsupported.push({ code: "sticker", label: "Sticker" });
    if (message.voice !== undefined) unsupported.push({ code: "voice", label: "Voice message" });
    if (message.audio !== undefined) unsupported.push({ code: "audio", label: "Audio" });
    if (message.video !== undefined) unsupported.push({ code: "video", label: "Video" });
    if (message.video_note !== undefined) unsupported.push({ code: "video_note", label: "Video note" });
  }
  return { attachments, unsupported };
}

function groupObservationOf(
  message: TelegramMessage,
  options: TelegramNormalizationOptions
): MessagingGroupObservation | null {
  if (
    (message.chat.type !== "group" && message.chat.type !== "supergroup") ||
    message.from === undefined || message.has_protected_content === true
  ) return null;
  const parts = collectParts([message]);
  return {
    address: addressOf(options.connectionId, message),
    messageId: String(message.message_id),
    speaker: speakerOf(message.from, options.ownerUserId),
    occurredAt: message.date * 1_000,
    text: message.text ?? message.caption ?? "",
    attachmentNames: parts.attachments.map((attachment) => attachment.fileName)
  };
}

export function detectTelegramGroupTrigger(
  message: TelegramMessage,
  bot: TelegramBotIdentity
): string | null {
  const source = message.text ?? message.caption ?? "";
  const entities = message.text === undefined ? message.caption_entities : message.entities;
  const usernameMention = `@${bot.username}`.toLowerCase();
  const stripped: Array<{ readonly start: number; readonly end: number }> = [];
  let addressed = message.reply_to_message?.from?.id === bot.id;
  for (const entity of entities ?? []) {
    if (entity.type !== "mention" && entity.type !== "bot_command") continue;
    const value = source.slice(entity.offset, entity.offset + entity.length);
    if (entity.type === "mention" && value.toLowerCase() === usernameMention) {
      addressed = true;
      stripped.push({ start: entity.offset, end: entity.offset + entity.length });
    } else if (entity.type === "bot_command" && value.toLowerCase().endsWith(usernameMention)) {
      addressed = true;
    }
  }
  if (!addressed) {
    const summoned = displayNameSummon(source, bot.displayName);
    if (summoned === null) return null;
    return summoned;
  }
  let text = stripRanges(source, stripped);
  text = text.replace(new RegExp(`(/[A-Za-z0-9_]+)@${escapeRegExp(bot.username)}`, "giu"), "$1");
  return text.replace(/[ \t]{2,}/gu, " ").trim();
}

function replyContextOf(message: TelegramMessage): MessagingReplyContext | null {
  const replied = message.reply_to_message;
  if (replied === undefined || replied.has_protected_content === true || message.has_protected_content === true) {
    return null;
  }
  const attachmentCount = (replied.photo?.length ? 1 : 0) + (replied.document === undefined ? 0 : 1);
  let text = replied.text ?? replied.caption ?? "";
  if (text === "") {
    if (replied.photo?.length) text = "[Image]";
    else if (replied.document !== undefined) text = `[File: ${replied.document.file_name ?? "document"}]`;
    else if (replied.voice !== undefined) text = "[Voice message]";
    else if (replied.video !== undefined) text = "[Video]";
    else if (replied.sticker !== undefined) text = "[Sticker]";
    else return null;
  }
  return {
    providerMessageId: String(replied.message_id),
    author: displayNameOf(replied.from),
    text,
    isBot: replied.from?.is_bot === true,
    attachmentCount
  };
}

function addressOf(connectionId: string, message: TelegramMessage): MessagingAddress {
  return telegramAddress({
    connectionId,
    chatId: String(message.chat.id),
    chatType: message.chat.type,
    threadId: message.is_topic_message === true && message.message_thread_id !== undefined
      ? String(message.message_thread_id)
      : null
  });
}

function speakerOf(user: TelegramUser, ownerUserId: string): MessagingSpeaker {
  return {
    providerUserId: String(user.id),
    displayName: displayNameOf(user),
    username: user.username?.trim() || null,
    isBot: user.is_bot,
    isOwner: String(user.id) === ownerUserId
  };
}

function displayNameOf(user: TelegramUser | undefined): string {
  if (user === undefined) return "unknown";
  const joined = [user.first_name, user.last_name].filter((value): value is string => Boolean(value)).join(" ").trim();
  return joined || user.username || String(user.id);
}

function displayNameSummon(source: string, displayName: string): string | null {
  const name = displayName.trim();
  if (name.length < 2) return null;
  const escaped = escapeRegExp(name);
  const separator = "[\\s,，。:：、!！?？~〜]";
  const atPattern = new RegExp(`@${escaped}(?![\\p{L}\\p{N}_])`, "giu");
  const leadPattern = new RegExp(`^\\s*${escaped}(?=$|${separator})`, "iu");
  let stripped = source.replace(atPattern, " ");
  if (stripped === source) {
    if (!leadPattern.test(source)) return null;
    stripped = source.replace(leadPattern, "").replace(new RegExp(`^${separator}+`, "u"), "");
  }
  const cleaned = stripped.replace(/[ \t]{2,}/gu, " ").trim();
  return cleaned || source.trim();
}

function stripRanges(source: string, ranges: readonly { readonly start: number; readonly end: number }[]): string {
  let output = "";
  let cursor = 0;
  for (const range of [...ranges].sort((left, right) => left.start - right.start)) {
    output += source.slice(cursor, range.start);
    cursor = Math.max(cursor, range.end);
  }
  return output + source.slice(cursor);
}

function isBareCommand(source: string): boolean {
  const first = source.trim().split(/\s/u, 1)[0] ?? "";
  return /^\/[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(first);
}

function isStale(epochSeconds: number, now: number, maximumAge: number): boolean {
  return !Number.isFinite(epochSeconds) || !Number.isFinite(maximumAge) || maximumAge < 0 ||
    now - (epochSeconds * 1_000) > maximumAge;
}

function requestIdOf(updateId: number): string {
  return `telegram:update:${String(updateId)}`;
}

function ignoredEntry(
  providerRequestId: string,
  reason: MessagingIgnoredInbound["reason"],
  providerConversationId: string | null,
  providerUserId: string | null
): MessagingIgnoredInbound {
  return { providerRequestId, reason, providerConversationId, providerUserId };
}

function conversationIdOf(update: TelegramUpdate): string | null {
  const message = update.message ?? update.callback_query?.message;
  return message === undefined ? null : String(message.chat.id);
}

function userIdOf(update: TelegramUpdate): string | null {
  const user = update.message?.from ?? update.callback_query?.from;
  return user === undefined ? null : String(user.id);
}

function sanitizeFileName(value: string): string {
  const cleaned = value.replace(/[\\/:*?"<>|\u0000-\u001f]/gu, "_").trim().slice(0, 160);
  return cleaned || "attachment";
}

function safeFileToken(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 96) || "attachment";
}

function normalizeMime(value: string | undefined): string | null {
  const normalized = value?.split(";", 1)[0]?.trim().toLowerCase();
  return normalized && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(normalized)
    ? normalized
    : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
