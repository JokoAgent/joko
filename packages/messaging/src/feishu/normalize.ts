import type {
  MessagingGroupObservation,
  MessagingIgnoredInbound,
  MessagingInboundEvent,
  MessagingInboundMessage,
  MessagingSpeaker
} from "../types.js";
import { feishuAddress, feishuAttachmentCoordinate } from "./codec.js";
import { parseFeishuContent } from "./content.js";
import type { FeishuCallbackUpdate, FeishuHistoryMessage, FeishuService } from "./model.js";

export interface FeishuNormalizationOptions {
  readonly service: FeishuService;
  readonly connectionId: string;
  readonly appId: string;
  readonly botOpenId: string;
  readonly ownerUserId: string | null;
  /** Only explicit chat IDs authorize group traffic. */
  readonly groupActivation: Readonly<Record<string, "mention" | "always" | "disabled">>;
  readonly now?: () => number;
  readonly maximumMessageAgeMs?: number;
}

export interface FeishuNormalizationResult {
  readonly events: readonly MessagingInboundEvent[];
  readonly ignored: readonly MessagingIgnoredInbound[];
  readonly groupObservations: readonly MessagingGroupObservation[];
  readonly interactionReplyCandidates: readonly MessagingInboundMessage[];
  readonly ownerClaimProviderUserId: string | null;
}

export function normalizeFeishuUpdates(
  updates: readonly FeishuCallbackUpdate[],
  options: FeishuNormalizationOptions
): FeishuNormalizationResult {
  const now = options.now ?? Date.now;
  const maximumAge = options.maximumMessageAgeMs ?? 7 * 24 * 60 * 60_000;
  const events: MessagingInboundEvent[] = [];
  const ignored: MessagingIgnoredInbound[] = [];
  const observations: MessagingGroupObservation[] = [];
  const seen = new Set<string>();
  let effectiveOwner = options.ownerUserId;
  let ownerClaim: string | null = null;

  for (const update of updates) {
    if (seen.has(update.callbackId)) {
      ignored.push(ignoredUpdate(update.callbackId, "duplicate"));
      continue;
    }
    seen.add(update.callbackId);
    if (update.kind === "card_action") {
      const action = update.action;
      if (effectiveOwner === null || action.operatorOpenId !== effectiveOwner) {
        ignored.push({
          providerRequestId: update.callbackId,
          reason: "unauthorized",
          providerConversationId: action.address.providerConversationId,
          providerUserId: action.operatorOpenId
        });
        continue;
      }
      events.push({
        kind: "interaction",
        providerRequestIds: [update.callbackId],
        interactionId: action.callbackId,
        messageId: action.messageId,
        address: action.address,
        speaker: speaker(action.operatorOpenId, action.operatorOpenId, true, false),
        actionValue: action.actionValue,
        occurredAt: action.occurredAt
      });
      continue;
    }

    const message = update.message;
    if (message.occurredAt > now() + 5 * 60_000 || now() - message.occurredAt > maximumAge) {
      ignored.push({
        providerRequestId: update.callbackId,
        reason: "stale",
        providerConversationId: message.chatId,
        providerUserId: message.senderOpenId
      });
      continue;
    }
    const parsed = parseFeishuContent(message.messageType, message.content);
    const group = message.chatType === "group";
    const address = feishuAddress({
      service: options.service,
      connectionId: options.connectionId,
      providerConversationId: group ? message.chatId : message.senderOpenId,
      providerThreadId: group ? message.threadId : null,
      group
    });
    const displayName = message.senderName || message.senderOpenId;
    const isOwner = effectiveOwner !== null && message.senderOpenId === effectiveOwner;
    const messageSpeaker = speaker(message.senderOpenId, displayName, isOwner, message.senderIsBot);
    const text = replaceMentions(parsed.text, message.mentions, options.botOpenId);
    const attachments = parsed.attachments.map((part, index) => ({
      providerFileId: feishuAttachmentCoordinate(message.messageId, index),
      providerUniqueFileId: part.providerKey,
      kind: part.kind,
      fileName: part.fileName,
      mimeType: part.mimeType,
      byteLength: part.byteLength
    }));

    if (group) {
      observations.push({
        address,
        messageId: message.messageId,
        speaker: messageSpeaker,
        occurredAt: message.occurredAt,
        text,
        attachmentNames: attachments.map((attachment) => attachment.fileName)
      });
      const activation = options.groupActivation[message.chatId] ?? "disabled";
      const mentioned = message.mentions.some((mention) => mention.openId === options.botOpenId);
      if (activation === "disabled") {
        ignored.push({
          providerRequestId: update.callbackId,
          reason: "unauthorized",
          providerConversationId: message.chatId,
          providerUserId: message.senderOpenId
        });
        continue;
      }
      if (effectiveOwner === null || !isOwner) {
        ignored.push({
          providerRequestId: update.callbackId,
          reason: "unauthorized",
          providerConversationId: message.chatId,
          providerUserId: message.senderOpenId
        });
        continue;
      }
      if (activation === "mention" && !mentioned) {
        ignored.push({
          providerRequestId: update.callbackId,
          reason: "unaddressed",
          providerConversationId: message.chatId,
          providerUserId: message.senderOpenId
        });
        continue;
      }
      if (!hasContent(text, attachments.length, parsed.unsupported.length)) {
        ignored.push({
          providerRequestId: update.callbackId,
          reason: "unsupported_update",
          providerConversationId: message.chatId,
          providerUserId: message.senderOpenId
        });
        continue;
      }
      events.push({
        kind: "message",
        providerRequestIds: [update.callbackId],
        messageId: message.messageId,
        address,
        speaker: messageSpeaker,
        occurredAt: message.occurredAt,
        text,
        ambient: activation === "always" && !mentioned,
        protectedContent: false,
        attachments,
        unsupported: parsed.unsupported,
        replyContext: message.replyContext ?? null
      });
      continue;
    }

    if (effectiveOwner === null) {
      effectiveOwner = message.senderOpenId;
      ownerClaim = message.senderOpenId;
    }
    if (message.senderOpenId !== effectiveOwner) {
      ignored.push({
        providerRequestId: update.callbackId,
        reason: "unauthorized",
        providerConversationId: message.senderOpenId,
        providerUserId: message.senderOpenId
      });
      continue;
    }
    if (!hasContent(text, attachments.length, parsed.unsupported.length)) {
      ignored.push({
        providerRequestId: update.callbackId,
        reason: "unsupported_update",
        providerConversationId: message.senderOpenId,
        providerUserId: message.senderOpenId
      });
      continue;
    }
    events.push({
      kind: "message",
      providerRequestIds: [update.callbackId],
      messageId: message.messageId,
      address,
      speaker: speaker(message.senderOpenId, displayName, true, message.senderIsBot),
      occurredAt: message.occurredAt,
      text,
      ambient: false,
      protectedContent: false,
      attachments,
      unsupported: parsed.unsupported,
      replyContext: message.replyContext ?? null
    });
  }

  return {
    events,
    ignored,
    groupObservations: observations,
    interactionReplyCandidates: [],
    ownerClaimProviderUserId: ownerClaim
  };
}

export function feishuHistoryObservation(input: {
  readonly service: FeishuService;
  readonly connectionId: string;
  readonly ownerUserId: string | null;
  readonly message: FeishuHistoryMessage;
}): MessagingGroupObservation | null {
  const parsed = parseFeishuContent(input.message.messageType, input.message.content);
  if (!hasContent(parsed.text, parsed.attachments.length, parsed.unsupported.length)) return null;
  return {
    address: feishuAddress({
      service: input.service,
      connectionId: input.connectionId,
      providerConversationId: input.message.chatId,
      providerThreadId: input.message.threadId,
      group: true
    }),
    messageId: input.message.messageId,
    speaker: speaker(
      input.message.senderOpenId,
      input.message.senderName,
      input.ownerUserId !== null && input.message.senderOpenId === input.ownerUserId,
      input.message.senderIsBot
    ),
    occurredAt: input.message.occurredAt,
    text: parsed.text,
    attachmentNames: parsed.attachments.map((attachment) => attachment.fileName)
  };
}

function replaceMentions(
  text: string,
  mentions: readonly { readonly key: string; readonly openId: string; readonly name: string }[],
  botOpenId: string
): string {
  let output = text;
  for (const mention of mentions) {
    output = output.split(mention.key).join(mention.openId === botOpenId ? "" : `@${safeName(mention.name || mention.openId)}`);
  }
  return output.replace(/[ \t]+\n/gu, "\n").replace(/[ \t]{2,}/gu, " ").trim();
}

function speaker(
  providerUserId: string,
  displayName: string,
  isOwner: boolean,
  isBot: boolean
): MessagingSpeaker {
  return {
    providerUserId,
    displayName: safeName(displayName || providerUserId),
    username: null,
    isBot,
    isOwner
  };
}

function safeName(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/[\r\n]+/gu, " ").trim().slice(0, 128) || "Unknown";
}

function hasContent(text: string, attachmentCount: number, unsupportedCount: number): boolean {
  return text.trim() !== "" || attachmentCount > 0 || unsupportedCount > 0;
}

function ignoredUpdate(providerRequestId: string, reason: MessagingIgnoredInbound["reason"]): MessagingIgnoredInbound {
  return { providerRequestId, reason, providerConversationId: null, providerUserId: null };
}
