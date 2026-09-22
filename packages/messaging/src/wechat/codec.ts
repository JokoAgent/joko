import type {
  MessagingAddress,
  MessagingInboundAttachment,
  MessagingReplyContext
} from "../types.js";
import { weChatInvalid, weChatMalformed } from "./errors.js";
import {
  WECHAT_ITEM_TYPE,
  WECHAT_MESSAGE_TYPE,
  type WeChatDecodedMessage,
  type WeChatRawItem,
  type WeChatRawMedia,
  type WeChatRawMessage,
  type WeChatTransientMedia
} from "./model.js";

export function parseWeChatJson(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    if (isRecord(value)) return value;
  } catch {
    // Mapped to a stable, secret-free transport error below.
  }
  throw weChatMalformed("WeChat returned invalid JSON.");
}

export function weChatAddress(connectionId: string, providerConversationId: string): MessagingAddress {
  return {
    channel: "wechat",
    connectionId: requiredProviderId(connectionId, "connection"),
    providerConversationId: requiredProviderId(providerConversationId, "conversation"),
    providerThreadId: null,
    conversationKind: "direct"
  };
}

export function decodeWeChatMessage(message: WeChatRawMessage): WeChatDecodedMessage | null {
  if (message.message_type !== WECHAT_MESSAGE_TYPE.user) return null;
  const senderId = safeProviderId(message.from_user_id);
  const recipientId = safeProviderId(message.to_user_id);
  const contextToken = privateToken(message.context_token);
  const messageId = stableMessageId(message);
  if (senderId === null || contextToken === null || messageId === null) return null;
  const occurredAt = validEpoch(message.create_time_ms) ?? Date.now();
  const text: string[] = [];
  const media: WeChatTransientMedia[] = [];
  const unsupported: { code: string; label: string }[] = [];
  let replyContext: MessagingReplyContext | null = null;
  for (const item of Array.isArray(message.item_list) ? message.item_list : []) {
    if (!item || typeof item !== "object") continue;
    replyContext ??= quoteOf(item);
    switch (item.type) {
      case WECHAT_ITEM_TYPE.text: {
        const value = item.text_item?.text;
        if (typeof value === "string" && value.trim() !== "") text.push(value);
        break;
      }
      case WECHAT_ITEM_TYPE.image:
      case WECHAT_ITEM_TYPE.file:
      case WECHAT_ITEM_TYPE.video: {
        const decoded = mediaOf(item);
        if (decoded === null) unsupported.push(unsupportedPart(item.type, "Media download information is unavailable."));
        else media.push(decoded);
        break;
      }
      case WECHAT_ITEM_TYPE.voice: {
        const transcript = item.voice_item?.text?.trim();
        if (transcript) text.push(transcript);
        const decoded = mediaOf(item);
        if (decoded === null) unsupported.push(unsupportedPart(item.type, "Voice download information is unavailable."));
        else media.push(decoded);
        break;
      }
      default:
        unsupported.push(unsupportedPart(item.type, "Unsupported WeChat message item."));
    }
  }
  return {
    messageId,
    senderId,
    ...(recipientId === null ? {} : { recipientId }),
    ...(safeProviderId(message.client_id) === null ? {} : { clientId: message.client_id!.trim() }),
    occurredAt,
    contextToken,
    text: text.join("\n").trim(),
    media,
    unsupported,
    replyContext
  };
}

export function weChatAttachment(messageId: string, index: number, media: WeChatTransientMedia): MessagingInboundAttachment {
  const kind = media.kind === "image" ? "image" : "file";
  const isDecodedVoice = media.kind === "voice" && media.voiceEncoding === 6;
  return {
    providerFileId: `${requiredProviderId(messageId, "message")}:media:${index}`,
    providerUniqueFileId: null,
    kind,
    fileName: isDecodedVoice ? "wechat-voice.wav" : safeFileName(media.fileName ?? defaultFileName(media.kind)),
    mimeType: mediaMime(media),
    byteLength: media.byteLength ?? null
  };
}

export function requiredProviderId(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 512 || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw weChatInvalid(`WeChat ${label} identity is invalid.`);
  }
  return normalized;
}

function stableMessageId(message: WeChatRawMessage): string | null {
  const client = safeProviderId(message.client_id);
  if (client !== null) return `client:${client}`;
  if (typeof message.message_id === "number" && Number.isSafeInteger(message.message_id)) return `message:${message.message_id}`;
  const provider = typeof message.message_id === "string" ? safeProviderId(message.message_id) : null;
  if (provider !== null) return `message:${provider}`;
  if (typeof message.seq === "number" && Number.isSafeInteger(message.seq)) return `seq:${message.seq}`;
  return null;
}

function mediaOf(item: WeChatRawItem): WeChatTransientMedia | null {
  switch (item.type) {
    case WECHAT_ITEM_TYPE.image:
      return mediaCoordinate("image", item.image_item?.media, {
        aesKeyHex: validHex(item.image_item?.aeskey),
        encryptedByteLength: positiveInteger(item.image_item?.mid_size)
      });
    case WECHAT_ITEM_TYPE.voice:
      return mediaCoordinate("voice", item.voice_item?.media, {
        voiceEncoding: positiveInteger(item.voice_item?.encode_type),
        transcript: item.voice_item?.text
      });
    case WECHAT_ITEM_TYPE.file:
      return mediaCoordinate("file", item.file_item?.media, {
        fileName: safeFileName(item.file_item?.file_name ?? "wechat-file"),
        byteLength: positiveIntegerString(item.file_item?.len),
        md5Hex: validMd5(item.file_item?.md5)
      });
    case WECHAT_ITEM_TYPE.video:
      return mediaCoordinate("video", item.video_item?.media, {
        encryptedByteLength: positiveInteger(item.video_item?.video_size)
      });
    default:
      return null;
  }
}

function mediaCoordinate(
  kind: WeChatTransientMedia["kind"],
  raw: WeChatRawMedia | undefined,
  extra: Omit<WeChatTransientMedia, "kind" | "downloadUrl" | "encryptedQuery" | "aesKeyBase64">
): WeChatTransientMedia | null {
  const downloadUrl = boundedString(raw?.full_url, 8_192);
  const encryptedQuery = boundedString(raw?.encrypt_query_param, 8_192);
  const aesKeyBase64 = boundedString(raw?.aes_key, 512);
  if ((downloadUrl === undefined && encryptedQuery === undefined)
    || (aesKeyBase64 === undefined && extra.aesKeyHex === undefined)) return null;
  return { kind, ...(downloadUrl ? { downloadUrl } : {}), ...(encryptedQuery ? { encryptedQuery } : {}), ...(aesKeyBase64 ? { aesKeyBase64 } : {}), ...defined(extra) };
}

function quoteOf(item: WeChatRawItem): MessagingReplyContext | null {
  const ref = item.ref_msg;
  if (ref === undefined) return null;
  const quoted = ref.message_item;
  const quotedText = quoted?.type === WECHAT_ITEM_TYPE.text
    ? quoted.text_item?.text
    : quoted?.type === WECHAT_ITEM_TYPE.voice
      ? quoted.voice_item?.text
      : undefined;
  const attachmentCount = quoted === undefined || mediaOf(quoted) === null ? 0 : 1;
  const title = safeDisplayName(ref.title ?? "WeChat user");
  return {
    providerMessageId: safeProviderId(quoted?.msg_id) ?? `quote:${title}`,
    author: title,
    text: typeof quotedText === "string" ? quotedText.trim().slice(0, 4_096) : "",
    isBot: false,
    attachmentCount
  };
}

function unsupportedPart(type: unknown, label: string): { code: string; label: string } {
  return { code: `item_${typeof type === "number" ? type : "unknown"}`, label };
}

function mediaMime(media: WeChatTransientMedia): string | null {
  switch (media.kind) {
    case "image": return "image/*";
    case "video": return "video/mp4";
    case "voice":
      switch (media.voiceEncoding) {
        case 6: return "audio/wav";
        case 7: return "audio/mpeg";
        case 8: return "audio/ogg";
        default: return "application/octet-stream";
      }
    case "file": return null;
  }
}

function defaultFileName(kind: WeChatTransientMedia["kind"]): string {
  switch (kind) {
    case "image": return "wechat-image";
    case "voice": return "wechat-voice";
    case "video": return "wechat-video.mp4";
    case "file": return "wechat-file";
  }
}

function safeProviderId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length >= 1 && normalized.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(normalized) ? normalized : null;
}

function privateToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length >= 1 && normalized.length <= 4_096 && !/[\u0000-\u001f\u007f]/u.test(normalized) ? normalized : null;
}

function safeFileName(value: string): string {
  return value.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/gu, "_").trim().slice(0, 256) || "wechat-file";
}

function safeDisplayName(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f\u200b]/gu, " ").trim().slice(0, 128) || "WeChat user";
}

function validEpoch(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const normalized = Math.trunc(value < 1_000_000_000_000 ? value * 1_000 : value);
  return Number.isSafeInteger(normalized) && normalized >= 0 ? normalized : null;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function positiveIntegerString(value: unknown): number | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function validHex(value: unknown): string | undefined {
  return typeof value === "string" && /^[0-9a-fA-F]{32}$/u.test(value) ? value.toLowerCase() : undefined;
}

function validMd5(value: unknown): string | undefined {
  return typeof value === "string" && /^[0-9a-fA-F]{32}$/u.test(value) ? value.toLowerCase() : undefined;
}

function boundedString(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length >= 1 && normalized.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(normalized) ? normalized : undefined;
}

function defined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
