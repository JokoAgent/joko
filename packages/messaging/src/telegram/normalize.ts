import { extname } from "node:path";

import { inboundAudioVideoMime } from "../inbound-audio-video.js";
import { isMessagingStopCommand } from "../task-commands.js";
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
const TELEGRAM_MAXIMUM_QUOTED_ATTACHMENTS = 3;
const CONTEXT_IMAGE_MIME: Readonly<Record<string, string>> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".bmp": "image/bmp", ".svg": "image/svg+xml", ".heic": "image/heic",
  ".tif": "image/tiff", ".tiff": "image/tiff"
};

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
  /** Short-lived provider file descriptors for messages observed in a group. */
  readonly groupMedia?: readonly TelegramGroupMedia[];
}

export interface TelegramGroupMedia {
  readonly address: MessagingAddress;
  readonly messageId: string;
  readonly occurredAt: number;
  readonly mediaGroupId: string | null;
  readonly kind: MessagingInboundAttachment["kind"];
  readonly attachments: readonly MessagingInboundAttachment[];
  readonly unsupported: readonly MessagingUnsupportedPart[];
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
  const groupMedia: TelegramGroupMedia[] = [];
  for (const group of groups) {
    const primaryMessage = group.primary.message;
    if (primaryMessage !== undefined) {
      const messages = group.updates.flatMap((update) => update.message === undefined ? [] : [update.message]);
      const protectedGroup = messages.some(message => message.has_protected_content === true);
      for (const message of messages) {
        const observation = groupObservationOf(message, options);
        if (observation === null) continue;
        observations.push(observation);
        if (!protectedGroup && options.groupActivation?.[observation.address.providerConversationId] !== "disabled") {
          const media = groupMediaOf(message, observation);
          if (media !== undefined) groupMedia.push(media);
        }
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
  return { events, groupObservations: observations, ignored, ...(groupMedia.length === 0 ? {} : { groupMedia }) };
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
  let explicitlyAddressed = false;
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
    explicitlyAddressed = trigger !== null;
    if (trigger === null && owner && (isBareCommand(sourceText) || isMessagingStopCommand(sourceText)
      && collected.attachments.length === 0 && collected.unsupported.length === 0)) trigger = sourceText.trim();
    if (trigger === null && activation === "always" && sourceText.trim() !== "") {
      trigger = sourceText.trim();
      ambient = true;
    }
    if (trigger === null) {
      return { event: null, ignored: ignoredEntry(requestId, "unaddressed", chatId, userId) };
    }
    const command = /^[!/]/u.test(trigger.trimStart()) || isMessagingStopCommand(trigger);
    if (command && (!owner || ambient)) {
      return { event: null, ignored: ignoredEntry(requestId, "unauthorized", chatId, userId) };
    }
    text = trigger;
  }

  if (!explicitlyAddressed && text.trim() === "" && collected.attachments.length === 0 && collected.unsupported.length === 0) {
    return { event: null, ignored: ignoredEntry(requestId, "service_message", chatId, userId) };
  }
  const address = addressOf(options.connectionId, message);
  const speaker = speakerOf(message.from, options.ownerUserId);
  const protectedContent = messages.some((entry) => entry.has_protected_content === true);
  const replied = message.reply_to_message;
  const replyContext = protectedContent ? null : replyContextOf(message);
  const replyParts = replied === undefined || replyContext === null ? undefined
    : collectReplyParts(replied, address, messages, collected.attachments);
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
      protectedContent,
      attachments: collected.attachments,
      unsupported: collected.unsupported,
      replyContext,
      ...(replyParts === undefined ? {} : { telegramReplyParts: replyParts }),
      ...(address.conversationKind !== "group" || message.media_group_id === undefined ? {} : { telegramMediaGroupId: message.media_group_id })
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

function collectParts(messages: readonly TelegramMessage[], contextual = false): {
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
        const fileName = sanitizeFileName(document.file_name ?? `document-${safeFileToken(document.file_unique_id)}`);
        const declared = normalizeMime(document.mime_type);
        const mime = contextual ? contextualDocumentMime(declared, fileName) : declared;
        const audioVideo = !contextual ? undefined : mime?.startsWith("audio/") ? "audio" : mime?.startsWith("video/") ? "video" : undefined;
        attachments.push({
          providerFileId: document.file_id,
          providerUniqueFileId: document.file_unique_id,
          kind: mime?.startsWith("image/") === true ? "image" : "file",
          fileName,
          mimeType: mime,
          byteLength: document.file_size ?? null,
          ...(audioVideo === undefined ? {} : { audioVideo })
        });
      }
    }
    if (message.sticker !== undefined) unsupported.push({ code: "sticker", label: "Sticker" });
    const nativeMedia = [
      [message.voice, `voice-${message.message_id}.ogg`, "audio/ogg"],
      [message.audio, `audio-${message.message_id}.mp3`, "audio/mpeg"],
      [message.video, `video-${message.message_id}.mp4`, "video/mp4"],
      [message.video_note, `video-note-${message.message_id}.mp4`, "video/mp4"]
    ] as const;
    for (const [file, fallbackName, fallbackMime] of nativeMedia) {
      if (!file) continue;
      const fileName = sanitizeFileName(typeof file.file_name === "string" ? file.file_name : fallbackName);
      const size = file.file_size;
      if (typeof file.file_id !== "string" || file.file_id.length === 0 || file.file_id.length > 512
        || (size !== undefined && (!Number.isSafeInteger(size) || size <= 0))) {
        unsupported.push({ code: "invalid_attachment", label: fileName });
        continue;
      }
      if ((size ?? 0) > TELEGRAM_MAXIMUM_INBOUND_FILE_BYTES) {
        unsupported.push({ code: "oversize", label: `${fileName} exceeds Telegram's download limit.` });
        continue;
      }
      const declared = typeof file.mime_type === "string" ? normalizeMime(file.mime_type) : null;
      const mimeType = inboundAudioVideoMime(declared, fileName) ?? fallbackMime;
      attachments.push({
        providerFileId: file.file_id,
        providerUniqueFileId: typeof file.file_unique_id === "string" ? file.file_unique_id : null,
        kind: "file",
        fileName,
        mimeType,
        byteLength: size ?? null,
        audioVideo: mimeType.startsWith("audio/") ? "audio" : "video"
      });
    }
  }
  return { attachments, unsupported };
}

function contextualDocumentMime(declared: string | null, fileName: string): string | null {
  if (declared?.startsWith("image/")) return declared;
  return inboundAudioVideoMime(declared, fileName) ?? CONTEXT_IMAGE_MIME[extname(fileName).toLowerCase()] ?? declared;
}

function groupMediaOf(message: TelegramMessage, observation: MessagingGroupObservation): TelegramGroupMedia | undefined {
  if (!Number.isSafeInteger(observation.occurredAt) || !Number.isSafeInteger(message.message_id) || message.message_id <= 0
    || !(message.photo?.length || message.document || message.voice || message.audio || message.video || message.video_note)) {
    return undefined;
  }
  const documentMime = message.document === undefined ? null
    : contextualDocumentMime(normalizeMime(message.document.mime_type), message.document.file_name ?? "");
  return {
    address: observation.address,
    messageId: observation.messageId,
    occurredAt: observation.occurredAt,
    mediaGroupId: message.media_group_id ?? null,
    kind: message.photo?.length || documentMime?.startsWith("image/") ? "image" : "file",
    ...collectParts([message], true)
  };
}

function collectReplyParts(
  replied: TelegramMessage,
  address: MessagingAddress,
  current: readonly TelegramMessage[],
  currentAttachments: readonly MessagingInboundAttachment[]
): MessagingInboundMessage["telegramReplyParts"] {
  const replyAddress = addressOf(address.connectionId, replied);
  if (replyAddress.providerConversationId !== address.providerConversationId
    || replyAddress.conversationKind !== address.conversationKind
    || replyAddress.providerThreadId !== address.providerThreadId
    || current.some((message) => message.message_id === replied.message_id
      || (message.media_group_id !== undefined && message.media_group_id === replied.media_group_id))) return undefined;
  const parts = collectParts([replied], true);
  const seen = new Set(currentAttachments.map(attachment => attachment.providerUniqueFileId ?? attachment.providerFileId));
  const attachments: MessagingInboundAttachment[] = [];
  const unsupported = [...parts.unsupported];
  for (const attachment of parts.attachments) {
    const identity = attachment.providerUniqueFileId ?? attachment.providerFileId;
    if (seen.has(identity)) continue;
    seen.add(identity);
    if (attachments.length === TELEGRAM_MAXIMUM_QUOTED_ATTACHMENTS) {
      unsupported.push({ code: "attachment_limit", label: attachment.fileName });
      continue;
    }
    attachments.push(attachment);
  }
  if (attachments.length === 0 && unsupported.length === 0) return undefined;
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
    attachmentNames: parts.attachments.filter((attachment) => attachment.audioVideo === undefined)
      .map((attachment) => attachment.fileName)
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
    if (!Number.isSafeInteger(entity.offset) || !Number.isSafeInteger(entity.length) || entity.offset < 0
      || entity.length < 1 || entity.offset + entity.length > source.length) continue;
    if (entity.type === "text_mention") {
      if (entity.user?.id === bot.id) {
        addressed = true;
        stripped.push({ start: entity.offset, end: entity.offset + entity.length });
      }
      continue;
    }
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
  const attachmentCount = [replied.photo?.[0], replied.document, replied.voice, replied.audio, replied.video, replied.video_note]
    .filter(part => part !== undefined).length;
  let text = replied.text ?? replied.caption ?? "";
  if (text === "") {
    if (replied.photo?.length) text = "[Image]";
    else if (replied.document !== undefined) text = `[File: ${replied.document.file_name ?? "document"}]`;
    else if (replied.voice !== undefined) text = "[Voice message]";
    else if (replied.audio !== undefined) text = "[Audio]";
    else if (replied.video !== undefined) text = "[Video]";
    else if (replied.video_note !== undefined) text = "[Video note]";
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
  const atPattern = new RegExp(`@${escaped}(?![\\p{L}\\p{N}_])`, "giu");
  const stripped = source.replace(atPattern, " ");
  return stripped === source ? null : stripped.replace(/[ \t]{2,}/gu, " ").trim();
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
