import type { BaseMessage } from "@wecom/aibot-node-sdk";

import type {
  MessagingGroupObservation,
  MessagingIgnoredInbound,
  MessagingInboundAttachment,
  MessagingInboundMessage,
  MessagingSpeaker,
  MessagingUnsupportedPart
} from "../types.js";
import { weComAddress, weComAttachmentCoordinate } from "./codec.js";
import { WECOM_MAXIMUM_IMAGE_BYTES, WECOM_MAXIMUM_MEDIA_BYTES } from "./media.js";
import type { WeComCallbackUpdate, WeComInboundContent, WeComInboundPart } from "./model.js";

export const WECOM_DEFAULT_MAXIMUM_MESSAGE_AGE_MS = 60 * 60 * 1_000;

export interface WeComNormalizationOptions {
  readonly connectionId: string;
  readonly botId: string;
  readonly ownerUserId: string | null;
  readonly now?: () => number;
  readonly maximumMessageAgeMs?: number;
}

export interface WeComNormalizationResult {
  readonly events: readonly MessagingInboundMessage[];
  readonly interactionReplyCandidates: readonly MessagingInboundMessage[];
  readonly groupObservations: readonly MessagingGroupObservation[];
  readonly ignored: readonly MessagingIgnoredInbound[];
  readonly ownerClaimProviderUserId: string | null;
}

export function normalizeWeComUpdates(
  source: readonly WeComCallbackUpdate[],
  options: WeComNormalizationOptions
): WeComNormalizationResult {
  const now = options.now?.() ?? Date.now();
  const maximumAge = options.maximumMessageAgeMs ?? WECOM_DEFAULT_MAXIMUM_MESSAGE_AGE_MS;
  const events: MessagingInboundMessage[] = [];
  const groupObservations: MessagingGroupObservation[] = [];
  const ignored: MessagingIgnoredInbound[] = [];
  const callbackIds = new Set<string>();
  const messageIds = new Set<string>();
  let ownerUserId = options.ownerUserId;
  let ownerClaimProviderUserId: string | null = null;

  for (const update of source) {
    const body = validBody(update.frame.body);
    if (callbackIds.has(update.callbackId)) {
      ignored.push(ignoredEntry(update.callbackId, "duplicate", null, null));
      continue;
    }
    callbackIds.add(update.callbackId);
    if (body === null || body.aibotid !== options.botId) {
      ignored.push(ignoredEntry(update.callbackId, "invalid", body?.chatid ?? null, body?.from.userid ?? null));
      continue;
    }
    if (messageIds.has(body.msgid)) {
      ignored.push(ignoredEntry(update.callbackId, "duplicate", body.chatid ?? body.from.userid, body.from.userid));
      continue;
    }
    messageIds.add(body.msgid);
    const occurredAt = providerTime(body.create_time, update.receivedAt);
    if (now - occurredAt > maximumAge || occurredAt - now > 5 * 60_000) {
      ignored.push(ignoredEntry(update.callbackId, "stale", body.chatid ?? body.from.userid, body.from.userid));
      continue;
    }
    const group = body.chattype === "group";
    if (!group && ownerUserId === null) {
      ownerUserId = body.from.userid;
      ownerClaimProviderUserId = body.from.userid;
    }
    if (ownerUserId === null || body.from.userid !== ownerUserId) {
      ignored.push(ignoredEntry(update.callbackId, "unauthorized", body.chatid ?? body.from.userid, body.from.userid));
      continue;
    }
    if (group && body.chatid === undefined) {
      ignored.push(ignoredEntry(update.callbackId, "invalid", null, body.from.userid));
      continue;
    }
    const content = parseWeComContent(body);
    const address = weComAddress({
      connectionId: options.connectionId,
      providerConversationId: group ? body.chatid! : body.from.userid,
      group
    });
    const speaker: MessagingSpeaker = {
      providerUserId: body.from.userid,
      displayName: body.from.userid,
      username: null,
      isBot: false,
      isOwner: true
    };
    const attachments = content.attachments.map((part, index) => attachmentOf(body.msgid, part, index));
    const message: MessagingInboundMessage = {
      kind: "message",
      providerRequestIds: [update.callbackId],
      messageId: body.msgid,
      address,
      speaker,
      occurredAt,
      text: content.text,
      ambient: false,
      protectedContent: false,
      attachments,
      unsupported: content.unsupported,
      replyContext: quoteContext(body)
    };
    if (group) {
      groupObservations.push({
        address,
        messageId: body.msgid,
        speaker,
        occurredAt,
        text: content.text,
        attachmentNames: attachments.map((attachment) => attachment.fileName)
      });
    }
    events.push(message);
  }
  return { events, interactionReplyCandidates: [], groupObservations, ignored, ownerClaimProviderUserId };
}

export function parseWeComContent(body: BaseMessage): WeComInboundContent {
  switch (body.msgtype) {
    case "text":
      return content(textAt(body, "text"));
    case "voice": {
      const recognition = textAt(body, "voice");
      return recognition === ""
        ? unsupported("voice_empty", "WeCom voice has no text recognition result.")
        : content(recognition);
    }
    case "image": {
      const part = mediaPart(body["image"], "image", "wecom-image.jpg", "image/jpeg", WECOM_MAXIMUM_IMAGE_BYTES);
      return part === null ? unsupported("image_unavailable", "WeCom image download information is unavailable.")
        : { text: "", attachments: [part], unsupported: [] };
    }
    case "file": {
      const part = mediaPart(body["file"], "file", "wecom-file", null, WECOM_MAXIMUM_MEDIA_BYTES);
      return part === null ? unsupported("file_unavailable", "WeCom file download information is unavailable.")
        : { text: "", attachments: [part], unsupported: [] };
    }
    case "video": {
      const part = mediaPart(body["video"], "file", "wecom-video.mp4", "video/mp4", WECOM_MAXIMUM_MEDIA_BYTES);
      return part === null ? unsupported("video_unavailable", "WeCom video download information is unavailable.")
        : { text: "", attachments: [part], unsupported: [] };
    }
    case "mixed":
      return mixedContent(body["mixed"]);
    default:
      return unsupported("unsupported_message", `Unsupported WeCom message type: ${body.msgtype}`);
  }
}

function mixedContent(value: unknown): WeComInboundContent {
  if (!isRecord(value) || !Array.isArray(value["msg_item"])) return unsupported("mixed_invalid", "WeCom mixed message is invalid.");
  const text: string[] = [];
  const attachments: WeComInboundPart[] = [];
  const unsupportedParts: MessagingUnsupportedPart[] = [];
  for (const item of value["msg_item"]) {
    if (!isRecord(item)) continue;
    if (item["msgtype"] === "text") {
      const candidate = isRecord(item["text"]) ? stringValue(item["text"]["content"]).trim() : "";
      if (candidate !== "") text.push(candidate);
    } else if (item["msgtype"] === "image") {
      const part = mediaPart(item["image"], "image", "wecom-image.jpg", "image/jpeg", WECOM_MAXIMUM_IMAGE_BYTES);
      if (part === null) unsupportedParts.push({ code: "image_unavailable", label: "WeCom image download information is unavailable." });
      else attachments.push(part);
    }
  }
  return { text: text.join("\n"), attachments, unsupported: unsupportedParts };
}

function mediaPart(
  value: unknown,
  kind: "image" | "file",
  fileName: string,
  mimeType: string | null,
  maximumBytes: number
): WeComInboundPart | null {
  if (!isRecord(value)) return null;
  const providerUrl = stringValue(value["url"]).trim();
  const aesKey = stringValue(value["aeskey"]).trim();
  if (!validTransientValue(providerUrl, 8_192) || (aesKey !== "" && !validTransientValue(aesKey, 4_096))) return null;
  return { kind, providerUrl, aesKey: aesKey || null, fileName, mimeType, maximumBytes };
}

function attachmentOf(messageId: string, part: WeComInboundPart, index: number): MessagingInboundAttachment {
  return {
    providerFileId: weComAttachmentCoordinate(messageId, index),
    providerUniqueFileId: null,
    kind: part.kind,
    fileName: part.fileName,
    mimeType: part.mimeType,
    byteLength: null
  };
}

function quoteContext(body: BaseMessage): MessagingInboundMessage["replyContext"] {
  const quote = body.quote;
  if (quote === undefined) return null;
  const mixedItems = quote.mixed?.msg_item ?? [];
  const mixedText = mixedItems
    .filter((item) => item.msgtype === "text")
    .map((item) => item.text?.content?.trim() ?? "")
    .filter((text) => text !== "")
    .join("\n");
  const text = quote.text?.content?.trim() || quote.voice?.content?.trim() || mixedText || "[Attachment]";
  const attachmentCount = Number(quote.image !== undefined)
    + Number(quote.file !== undefined)
    + mixedItems.filter((item) => item.msgtype === "image").length;
  // The WeCom quote shape does not expose the quoted message id. Keep the
  // containing provider message id as the stable coordinate; outbound reply
  // routing remains bound to the containing callback frame, never this value.
  return {
    providerMessageId: body.msgid,
    author: "Quoted message",
    text,
    isBot: false,
    attachmentCount
  };
}

function validBody(value: BaseMessage | undefined): BaseMessage | null {
  if (!isRecord(value) || !validIdentifier(value["msgid"], 512) || !validIdentifier(value["aibotid"], 512)
    || !isRecord(value["from"]) || !validIdentifier(value["from"]["userid"], 512)
    || (value["chattype"] !== "single" && value["chattype"] !== "group")
    || typeof value["msgtype"] !== "string" || value["msgtype"].length > 64
    || (value["chatid"] !== undefined && !validIdentifier(value["chatid"], 512))) return null;
  return value as BaseMessage;
}

function validIdentifier(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function validTransientValue(value: string, maximum: number): boolean {
  return value.length >= 1 && value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value);
}

function textAt(body: BaseMessage, key: string): string {
  return isRecord(body[key]) ? stringValue(body[key]["content"]).trim() : "";
}

function content(text: string): WeComInboundContent {
  return { text: text.trim(), attachments: [], unsupported: [] };
}

function unsupported(code: string, label: string): WeComInboundContent {
  return { text: "", attachments: [], unsupported: [{ code, label }] };
}

function providerTime(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return fallback;
  const parsed = Math.trunc(value);
  return parsed < 10_000_000_000 ? parsed * 1_000 : parsed;
}

function ignoredEntry(
  providerRequestId: string,
  reason: MessagingIgnoredInbound["reason"],
  providerConversationId: string | null,
  providerUserId: string | null
): MessagingIgnoredInbound {
  return { providerRequestId, reason, providerConversationId, providerUserId };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
