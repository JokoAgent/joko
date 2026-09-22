import type {
  MessagingGroupObservation,
  MessagingIgnoredInbound,
  MessagingInboundAttachment,
  MessagingInboundEvent,
  MessagingInboundMessage,
  MessagingSpeaker,
  MessagingUnsupportedPart
} from "../types.js";
import {
  dingTalkAddress,
  dingTalkAttachmentCoordinate,
  requiredDingTalkProviderId
} from "./codec.js";
import type {
  DingTalkCallbackUpdate,
  DingTalkInboundContent,
  DingTalkInboundEnvelope,
  DingTalkInboundPart
} from "./model.js";

export const DINGTALK_DEFAULT_MAXIMUM_MESSAGE_AGE_MS = 60 * 60 * 1_000;

export interface DingTalkNormalizationOptions {
  readonly connectionId: string;
  readonly appKey: string;
  readonly ownerUserId: string | null;
  /** Only explicit conversation entries authorize group traffic. */
  readonly groupActivation: Readonly<Record<string, "mention" | "always" | "disabled">>;
  readonly now?: () => number;
  readonly maximumMessageAgeMs?: number;
}

export interface DingTalkNormalizationResult {
  readonly events: readonly MessagingInboundEvent[];
  readonly interactionReplyCandidates: readonly MessagingInboundMessage[];
  readonly groupObservations: readonly MessagingGroupObservation[];
  readonly ignored: readonly MessagingIgnoredInbound[];
  readonly ownerClaimProviderUserId: string | null;
}

export function normalizeDingTalkUpdates(
  source: readonly DingTalkCallbackUpdate[],
  options: DingTalkNormalizationOptions
): DingTalkNormalizationResult {
  const now = options.now?.() ?? Date.now();
  const maximumAge = options.maximumMessageAgeMs ?? DINGTALK_DEFAULT_MAXIMUM_MESSAGE_AGE_MS;
  const events: MessagingInboundEvent[] = [];
  const interactionReplyCandidates: MessagingInboundMessage[] = [];
  const groupObservations: MessagingGroupObservation[] = [];
  const ignored: MessagingIgnoredInbound[] = [];
  const callbackIds = new Set<string>();
  const messageIds = new Set<string>();
  let ownerUserId = options.ownerUserId;
  let ownerClaimProviderUserId: string | null = null;

  for (const update of source) {
    const requestId = requestIdOf(update.callbackMessageId);
    if (callbackIds.has(update.callbackMessageId)) {
      ignored.push(ignoredEntry(requestId, "duplicate", null, null));
      continue;
    }
    callbackIds.add(update.callbackMessageId);
    const envelope = parseDingTalkEnvelope(update.payload, now);
    if (envelope === null || envelope.robotCode !== options.appKey) {
      ignored.push(ignoredEntry(requestId, "invalid", envelope?.conversationId ?? null, envelope?.senderId ?? null));
      continue;
    }
    if (messageIds.has(envelope.messageId)) {
      ignored.push(ignoredEntry(requestId, "duplicate", envelope.conversationId, envelope.senderId));
      continue;
    }
    messageIds.add(envelope.messageId);
    if (now - envelope.occurredAt > maximumAge || envelope.occurredAt - now > 5 * 60_000) {
      ignored.push(ignoredEntry(requestId, "stale", envelope.conversationId, envelope.senderId));
      continue;
    }
    const botUserId = readString(envelope.raw, "chatbotUserId");
    if (botUserId !== "" && botUserId === envelope.senderId) {
      ignored.push(ignoredEntry(requestId, "service_message", envelope.conversationId, envelope.senderId));
      continue;
    }

    const group = envelope.conversationType === "2";
    if (!group && ownerUserId === null) {
      ownerUserId = envelope.senderId;
      ownerClaimProviderUserId = envelope.senderId;
    }
    if (!group && envelope.senderId !== ownerUserId) {
      ignored.push(ignoredEntry(requestId, "unauthorized", envelope.senderId, envelope.senderId));
      continue;
    }
    if (group && ownerUserId === null) {
      ignored.push(ignoredEntry(requestId, "unauthorized", envelope.conversationId, envelope.senderId));
      continue;
    }

    const activation = group ? options.groupActivation[envelope.conversationId] ?? "disabled" : "always";
    if (group && activation === "disabled") {
      ignored.push(ignoredEntry(requestId, "unsupported_chat", envelope.conversationId, envelope.senderId));
      continue;
    }
    const content = parseDingTalkContent(envelope);
    const address = dingTalkAddress({
      connectionId: options.connectionId,
      providerConversationId: group ? envelope.conversationId : envelope.senderId,
      group
    });
    const speaker = speakerOf(envelope, ownerUserId!);
    const attachments = content.attachments.map((part, index) => attachmentOf(envelope.messageId, part, index));
    if (group) {
      groupObservations.push({
        address,
        messageId: envelope.messageId,
        speaker,
        occurredAt: envelope.occurredAt,
        text: content.text,
        attachmentNames: attachments.map((attachment) => attachment.fileName)
      });
    }
    if (content.text === "" && attachments.length === 0 && content.unsupported.length === 0) {
      ignored.push(ignoredEntry(requestId, "service_message", address.providerConversationId, envelope.senderId));
      continue;
    }
    const message: MessagingInboundMessage = {
      kind: "message",
      providerRequestIds: [requestId],
      messageId: envelope.messageId,
      address,
      speaker,
      occurredAt: envelope.occurredAt,
      text: content.text,
      ambient: group && activation === "always" && !envelope.mentioned,
      protectedContent: false,
      attachments,
      unsupported: content.unsupported,
      replyContext: null
    };
    if (!group || envelope.mentioned || activation === "always") {
      events.push(message);
    } else if (speaker.isOwner && content.text !== "") {
      interactionReplyCandidates.push(message);
    } else {
      ignored.push(ignoredEntry(requestId, "unaddressed", envelope.conversationId, envelope.senderId));
    }
  }

  return {
    events,
    interactionReplyCandidates,
    groupObservations,
    ignored,
    ownerClaimProviderUserId
  };
}

export function parseDingTalkEnvelope(raw: unknown, fallbackNow = Date.now()): DingTalkInboundEnvelope | null {
  if (!isRecord(raw)) return null;
  const conversationId = readString(raw, "conversationId");
  const conversationType = readString(raw, "conversationType");
  const messageId = readString(raw, "msgId");
  const messageType = readString(raw, "msgtype");
  const robotCode = readString(raw, "robotCode");
  const senderId = readString(raw, "senderStaffId") || readString(raw, "senderId");
  if (
    !safeProviderIdentifier(conversationId)
    || (conversationType !== "1" && conversationType !== "2")
    || !safeProviderIdentifier(messageId)
    || messageType.length < 1 || messageType.length > 64
    || !safeProviderIdentifier(robotCode)
    || !safeProviderIdentifier(senderId)
  ) return null;
  const rawCreatedAt = finiteNumber(raw["createAt"])
    ?? finiteNumber(raw["createTime"])
    ?? finiteNumber(raw["timestamp"]);
  const occurredAt = rawCreatedAt === null ? fallbackNow : normalizeEpochMilliseconds(rawCreatedAt);
  if (!Number.isSafeInteger(occurredAt) || occurredAt < 0) return null;
  return {
    conversationId,
    conversationType,
    messageId,
    messageType,
    robotCode,
    senderId,
    senderName: safeDisplayName(readString(raw, "senderNick") || "DingTalk user"),
    sessionWebhook: boundedUrlString(readString(raw, "sessionWebhook")),
    sessionWebhookExpiresAt: normalizeOptionalEpochMilliseconds(finiteNumber(raw["sessionWebhookExpiredTime"])),
    occurredAt,
    mentioned: botMentioned(raw, robotCode),
    raw
  };
}

export function parseDingTalkContent(envelope: DingTalkInboundEnvelope): DingTalkInboundContent {
  switch (envelope.messageType) {
    case "text":
      return contentResult(readNestedString(envelope.raw, "text", "content"));
    case "richText":
      return richTextContent(envelope.raw);
    case "picture": {
      const code = readNestedString(envelope.raw, "content", "downloadCode")
        || readString(envelope.raw, "downloadCode");
      const downloadCode = validDownloadCode(code);
      return downloadCode === null
        ? unsupportedContent("picture", "DingTalk image download information is unavailable.")
        : {
            text: "",
            attachments: [{
              kind: "image",
              downloadCode,
              fileName: "dingtalk-image",
              mimeType: null,
              byteLength: null
            }],
            unsupported: []
          };
    }
    case "file": {
      const record = isRecord(envelope.raw["content"]) ? envelope.raw["content"] : envelope.raw;
      const code = readString(record, "downloadCode") || readString(envelope.raw, "downloadCode");
      const downloadCode = validDownloadCode(code);
      if (downloadCode === null) return unsupportedContent("file", "DingTalk file download information is unavailable.");
      const fileName = safeFileName(readString(record, "fileName") || readString(envelope.raw, "fileName") || "dingtalk-file");
      const mime = readString(record, "fileType") || readString(record, "mimeType");
      return {
        text: "",
        attachments: [{
          kind: "file",
          downloadCode,
          fileName,
          mimeType: inferredMime(fileName, mime),
          byteLength: positiveInteger(record["fileSize"] ?? envelope.raw["fileSize"])
        }],
        unsupported: []
      };
    }
    case "audio": {
      const recognition = readString(envelope.raw, "recognition")
        || readNestedString(envelope.raw, "content", "recognition");
      return recognition === ""
        ? unsupportedContent("audio", "DingTalk audio has no text recognition result.")
        : contentResult(recognition);
    }
    case "video":
      return unsupportedContent("video", "DingTalk video is not supported by this channel.");
    default:
      return unsupportedContent(envelope.messageType, `Unsupported DingTalk message type: ${envelope.messageType}`);
  }
}

function richTextContent(raw: Readonly<Record<string, unknown>>): DingTalkInboundContent {
  const content = isRecord(raw["content"]) ? raw["content"] : {};
  const text: string[] = [];
  const parts: DingTalkInboundPart[] = [];
  visitRichText(content["richText"], text, parts);
  return {
    text: text.join("").replace(/\n{3,}/gu, "\n\n").trim(),
    attachments: uniqueParts(parts),
    unsupported: []
  };
}

function visitRichText(value: unknown, text: string[], parts: DingTalkInboundPart[]): void {
  if (typeof value === "string") {
    text.push(value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      visitRichText(entry, text, parts);
      if (index < value.length - 1 && isRecord(entry)) text.push("\n");
    });
    return;
  }
  if (!isRecord(value)) return;
  const type = readString(value, "type");
  const downloadCode = readString(value, "downloadCode")
    || (type === "picture" ? readString(value, "pictureUrl") : "");
  const boundedCode = validDownloadCode(downloadCode);
  if (boundedCode !== null) {
    const kind = type === "file" ? "file" : "image";
    const fileName = safeFileName(readString(value, "fileName") || (kind === "image" ? "dingtalk-image" : "dingtalk-file"));
    parts.push({
      kind,
      downloadCode: boundedCode,
      fileName,
      mimeType: inferredMime(fileName, readString(value, "fileType") || readString(value, "mimeType")),
      byteLength: positiveInteger(value["fileSize"])
    });
  }
  for (const key of ["text", "content", "title"]) {
    if (typeof value[key] === "string") text.push(value[key] as string);
  }
  for (const key of ["richText", "children", "items"]) {
    if (value[key] !== undefined) visitRichText(value[key], text, parts);
  }
}

function uniqueParts(parts: readonly DingTalkInboundPart[]): readonly DingTalkInboundPart[] {
  const seen = new Set<string>();
  return parts.filter((part) => {
    if (seen.has(part.downloadCode)) return false;
    seen.add(part.downloadCode);
    return true;
  });
}

function attachmentOf(messageId: string, part: DingTalkInboundPart, index: number): MessagingInboundAttachment {
  return {
    providerFileId: dingTalkAttachmentCoordinate(messageId, index),
    providerUniqueFileId: null,
    kind: part.kind,
    fileName: safeFileName(part.fileName),
    mimeType: part.mimeType,
    byteLength: part.byteLength
  };
}

function speakerOf(envelope: DingTalkInboundEnvelope, ownerUserId: string): MessagingSpeaker {
  return {
    providerUserId: envelope.senderId,
    displayName: envelope.senderName,
    username: null,
    isBot: false,
    isOwner: envelope.senderId === ownerUserId
  };
}

function contentResult(text: string): DingTalkInboundContent {
  return { text: text.trim(), attachments: [], unsupported: [] };
}

function unsupportedContent(code: string, label: string): DingTalkInboundContent {
  const part: MessagingUnsupportedPart = { code: code.slice(0, 64) || "unknown", label: label.slice(0, 256) };
  return { text: "", attachments: [], unsupported: [part] };
}

function botMentioned(raw: Readonly<Record<string, unknown>>, robotCode: string): boolean {
  if (raw["isInAtList"] === true) return true;
  const users = raw["atUsers"];
  return Array.isArray(users) && users.some((entry) =>
    isRecord(entry) && Object.values(entry).some((value) => value === robotCode));
}

function requestIdOf(callbackMessageId: string): string {
  try {
    return `dingtalk:callback:${requiredDingTalkProviderId(callbackMessageId, "callback")}`;
  } catch {
    return "dingtalk:callback:invalid";
  }
}

function ignoredEntry(
  providerRequestId: string,
  reason: MessagingIgnoredInbound["reason"],
  providerConversationId: string | null,
  providerUserId: string | null
): MessagingIgnoredInbound {
  return { providerRequestId, reason, providerConversationId, providerUserId };
}

function readString(value: Readonly<Record<string, unknown>>, key: string): string {
  return typeof value[key] === "string" ? (value[key] as string).trim() : "";
}

function readNestedString(value: Readonly<Record<string, unknown>>, parent: string, key: string): string {
  return isRecord(value[parent]) ? readString(value[parent], key) : "";
}

function safeProviderIdentifier(value: string): boolean {
  return value.length >= 1 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function safeDisplayName(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f\u200b]/gu, " ").trim().slice(0, 128) || "DingTalk user";
}

function safeFileName(value: string): string {
  return value.replace(/[\\/\u0000-\u001f\u007f]/gu, "_").trim().slice(0, 256) || "dingtalk-file";
}

function validDownloadCode(value: string): string | null {
  const normalized = value.trim();
  return normalized.length >= 1 && normalized.length <= 4_096
    && !/[\u0000-\u001f\u007f]/u.test(normalized)
    ? normalized
    : null;
}

function boundedUrlString(value: string): string | null {
  return value !== "" && value.length <= 8_192 ? value : null;
}

function positiveInteger(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeEpochMilliseconds(value: number): number {
  return Math.trunc(value < 1_000_000_000_000 ? value * 1_000 : value);
}

function normalizeOptionalEpochMilliseconds(value: number | null): number | null {
  return value === null ? null : normalizeEpochMilliseconds(value);
}

function inferredMime(fileName: string, declared: string): string | null {
  const normalized = declared.trim().toLowerCase();
  if (/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(normalized)) return normalized;
  const extension = /\.([A-Za-z0-9]{1,16})$/u.exec(fileName)?.[1]?.toLowerCase();
  switch (extension) {
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    case "pdf": return "application/pdf";
    case "txt": return "text/plain";
    case "zip": return "application/zip";
    default: return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
